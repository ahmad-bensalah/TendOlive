/**
 * log.test.js - Unit tests for logging and cost estimation
 * Run: node --test agents/tests/log.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const logPath = path.join(__dirname, '..', 'lib', 'log.js');
const {
  createLogEntry,
  estimateCost,
  aggregateUsage,
  formatJSONL,
  appendToLog,
  readLog,
  createRunSummary
} = require(logPath);

describe('createLogEntry', () => {
  it('should create a log entry with all fields', () => {
    const entry = createLogEntry({
      runId: 'run_123',
      tenderId: 'T-456',
      agent: 'requirements',
      usage: { model: 'gpt-4', promptTokens: 1000, completionTokens: 500, ms: 1500 },
      violations: ['violation1', 'violation2'],
      status: 'success'
    });
    
    assert.strictEqual(entry.runId, 'run_123');
    assert.strictEqual(entry.tenderId, 'T-456');
    assert.strictEqual(entry.agent, 'requirements');
    assert.strictEqual(entry.model, 'gpt-4');
    assert.strictEqual(entry.promptTokens, 1000);
    assert.strictEqual(entry.completionTokens, 500);
    assert.strictEqual(entry.violations, 2);
    assert.strictEqual(entry.status, 'success');
    assert.ok(entry.timestamp);
  });
  
  it('should handle missing optional fields', () => {
    const entry = createLogEntry({
      runId: 'run_123',
      agent: 'test'
    });
    
    assert.strictEqual(entry.promptTokens, 0);
    assert.strictEqual(entry.violations, 0);
    assert.strictEqual(entry.status, 'success');
  });
});

describe('estimateCost', () => {
  const mockPrices = {
    'gpt-4': {
      input_per_1m: 30.00,
      output_per_1m: 60.00
    },
    'mock-model': {
      input_per_1m: 0.00,
      output_per_1m: 0.00
    },
    'unknown-price': {
      input_per_1m: '[TO FILL]',
      output_per_1m: '[TO FILL]'
    }
  };
  
  it('should calculate cost correctly', () => {
    const usage = {
      model: 'gpt-4',
      promptTokens: 1000000, // 1M tokens
      completionTokens: 500000 // 0.5M tokens
    };
    
    const result = estimateCost(usage, mockPrices);
    
    assert.strictEqual(result.estimatedCost, 60.00); // 30 + 30
    assert.strictEqual(result.currency, 'USD');
    assert.strictEqual(result.priceSource, 'catalog');
  });
  
  it('should handle small token counts', () => {
    const usage = {
      model: 'gpt-4',
      promptTokens: 1000, // 0.001M tokens
      completionTokens: 500
    };
    
    const result = estimateCost(usage, mockPrices);
    
    // 1000/1M * 30 + 500/1M * 60 = 0.03 + 0.03 = 0.06
    assert.ok(Math.abs(result.estimatedCost - 0.06) < 0.001);
  });
  
  it('should return null for [TO FILL] prices', () => {
    const usage = {
      model: 'unknown-price',
      promptTokens: 1000,
      completionTokens: 500
    };
    
    const result = estimateCost(usage, mockPrices);
    
    assert.strictEqual(result.estimatedCost, null);
    assert.ok(result.priceSource.includes('not yet available'));
  });
  
  it('should return null for unknown model', () => {
    const usage = {
      model: 'nonexistent-model',
      promptTokens: 1000,
      completionTokens: 500
    };
    
    const result = estimateCost(usage, mockPrices);
    
    assert.strictEqual(result.estimatedCost, null);
    assert.ok(result.priceSource.includes('not in catalog'));
  });
  
  it('should handle free models', () => {
    const usage = {
      model: 'mock-model',
      promptTokens: 1000000,
      completionTokens: 500000
    };
    
    const result = estimateCost(usage, mockPrices);
    
    assert.strictEqual(result.estimatedCost, 0.00);
  });
});

describe('aggregateUsage', () => {
  it('should sum usage across agents', () => {
    const agentUsages = {
      agent1: { promptTokens: 1000, completionTokens: 500, ms: 100, model: 'gpt-4' },
      agent2: { promptTokens: 2000, completionTokens: 1000, ms: 200, model: 'gpt-4' },
      agent3: { promptTokens: 500, completionTokens: 250, ms: 50, model: 'gpt-3.5' }
    };
    
    const result = aggregateUsage(agentUsages);
    
    assert.strictEqual(result.promptTokens, 3500);
    assert.strictEqual(result.completionTokens, 1750);
    assert.strictEqual(result.totalTokens, 5250);
    assert.strictEqual(result.ms, 350);
  });
  
  it('should track usage by agent', () => {
    const agentUsages = {
      agent1: { promptTokens: 1000, completionTokens: 500, model: 'gpt-4' }
    };
    
    const result = aggregateUsage(agentUsages);
    
    assert.ok(result.byAgent.agent1);
    assert.strictEqual(result.byAgent.agent1.promptTokens, 1000);
    assert.strictEqual(result.byAgent.agent1.model, 'gpt-4');
  });
  
  it('should handle empty input', () => {
    const result = aggregateUsage({});
    
    assert.strictEqual(result.promptTokens, 0);
    assert.strictEqual(result.completionTokens, 0);
  });
});

describe('formatJSONL', () => {
  it('should format as single line JSON', () => {
    const entry = { test: 'value', number: 123 };
    const jsonl = formatJSONL(entry);
    
    assert.ok(jsonl.endsWith('\n'));
    assert.strictEqual(jsonl.split('\n').length, 2); // One line + newline
    
    const parsed = JSON.parse(jsonl.trim());
    assert.deepStrictEqual(parsed, entry);
  });
});

describe('appendToLog and readLog', () => {
  it('should write and read log entries', () => {
    const tmpFile = path.join(os.tmpdir(), `test-log-${Date.now()}.jsonl`);
    
    try {
      const entry1 = { id: 1, message: 'First' };
      const entry2 = { id: 2, message: 'Second' };
      
      appendToLog(entry1, tmpFile);
      appendToLog(entry2, tmpFile);
      
      const entries = readLog(tmpFile);
      
      assert.strictEqual(entries.length, 2);
      assert.strictEqual(entries[0].id, 1);
      assert.strictEqual(entries[1].id, 2);
      
    } finally {
      if (fs.existsSync(tmpFile)) {
        fs.unlinkSync(tmpFile);
      }
    }
  });
  
  it('should handle non-existent file', () => {
    const entries = readLog('/nonexistent/path/file.jsonl');
    assert.deepStrictEqual(entries, []);
  });
});

describe('createRunSummary', () => {
  it('should create complete summary', () => {
    const agentUsages = {
      agent1: { promptTokens: 1000, completionTokens: 500, ms: 100, model: 'gpt-4' },
      agent2: { promptTokens: 2000, completionTokens: 1000, ms: 200, model: 'gpt-4' }
    };
    
    const summary = createRunSummary({
      runId: 'run_123',
      deckId: 'deck_456',
      tenderId: 'T-789',
      agentUsages,
      prices: {},
      startTime: 1000,
      endTime: 5000,
      warnings: ['warning1', 'warning2'],
      placeholders: 3
    });
    
    assert.strictEqual(summary.runId, 'run_123');
    assert.strictEqual(summary.deckId, 'deck_456');
    assert.strictEqual(summary.duration.ms, 4000);
    assert.strictEqual(summary.usage.promptTokens, 3000);
    assert.strictEqual(summary.quality.warnings, 2);
    assert.strictEqual(summary.quality.placeholders, 3);
  });
});
