/**
 * log.js - Run logging and cost estimation
 * 
 * Creates structured log entries for each agent run and estimates costs.
 */

const fs = require('fs');
const path = require('path');

/**
 * Creates a log entry for an agent run
 * 
 * @param {object} params - { runId, tenderId, agent, usage, violations, status }
 * @returns {object} - Log entry
 */
function createLogEntry(params) {
  const {
    runId,
    tenderId,
    agent,
    usage = {},
    violations = [],
    status = 'success',
    rateLimitWaits = 0
  } = params;
  
  return {
    timestamp: new Date().toISOString(),
    runId,
    tenderId: tenderId || '',
    agent,
    model: usage.model || 'unknown',
    promptTokens: usage.promptTokens || 0,
    completionTokens: usage.completionTokens || 0,
    totalTokens: usage.totalTokens || 0,
    ms: usage.ms || 0,
    attempts: usage.attempts || 1,
    rateLimitWaits,
    violations: violations.length,
    violationDetails: violations,
    status
  };
}

/**
 * Estimates cost for token usage
 * 
 * @param {object} usage - { model, promptTokens, completionTokens }
 * @param {object} prices - Price catalog from llm_prices.json
 * @returns {{ estimatedCost: number|null, currency: string, priceSource: string }}
 */
function estimateCost(usage, prices) {
  if (!usage || !prices) {
    return { estimatedCost: null, currency: 'USD', priceSource: 'unknown' };
  }
  
  const modelPrices = prices[usage.model];
  if (!modelPrices) {
    return { 
      estimatedCost: null, 
      currency: 'USD', 
      priceSource: `model ${usage.model} not in catalog` 
    };
  }
  
  const inputPrice = modelPrices.input_per_1m;
  const outputPrice = modelPrices.output_per_1m;
  
  // Check for [TO FILL] placeholder
  if (inputPrice === '[TO FILL]' || outputPrice === '[TO FILL]' || 
      typeof inputPrice !== 'number' || typeof outputPrice !== 'number') {
    return { 
      estimatedCost: null, 
      currency: 'USD', 
      priceSource: 'prices not yet available' 
    };
  }
  
  // Calculate cost: (tokens / 1M) * price_per_1M
  const inputCost = (usage.promptTokens / 1000000) * inputPrice;
  const outputCost = (usage.completionTokens / 1000000) * outputPrice;
  const totalCost = inputCost + outputCost;
  
  return {
    estimatedCost: totalCost,
    currency: 'USD',
    priceSource: 'catalog',
    breakdown: {
      input: inputCost,
      output: outputCost
    }
  };
}

/**
 * Aggregates usage from multiple agents
 */
function aggregateUsage(agentUsages) {
  const total = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    ms: 0,
    attempts: 0,
    rateLimitWaits: 0,
    byAgent: {}
  };
  
  for (const [agent, usage] of Object.entries(agentUsages)) {
    const promptTokens = usage.promptTokens || 0;
    const completionTokens = usage.completionTokens || 0;
    
    total.promptTokens += promptTokens;
    total.completionTokens += completionTokens;
    total.ms += usage.ms || 0;
    total.attempts += usage.attempts || 0;
    total.rateLimitWaits += usage.rateLimitWaits || 0;
    
    total.byAgent[agent] = {
      promptTokens,
      completionTokens,
      ms: usage.ms || 0,
      model: usage.model || 'unknown'
    };
  }
  
  // Calculate total tokens
  total.totalTokens = total.promptTokens + total.completionTokens;
  
  return total;
}

/**
 * Formats log entry as JSONL (one JSON object per line)
 */
function formatJSONL(logEntry) {
  return JSON.stringify(logEntry) + '\n';
}

/**
 * Writes log entry to JSONL file
 * 
 * @param {object} logEntry - Log entry to write
 * @param {string} logFilePath - Path to JSONL log file
 */
function appendToLog(logEntry, logFilePath) {
  try {
    const jsonl = formatJSONL(logEntry);
    fs.appendFileSync(logFilePath, jsonl, 'utf-8');
  } catch (err) {
    console.error(`Failed to write log: ${err.message}`);
  }
}

/**
 * Reads log entries from JSONL file
 * 
 * @param {string} logFilePath - Path to JSONL log file
 * @returns {Array<object>} - Array of log entries
 */
function readLog(logFilePath) {
  try {
    if (!fs.existsSync(logFilePath)) {
      return [];
    }
    
    const content = fs.readFileSync(logFilePath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    
    return lines.map(line => {
      try {
        return JSON.parse(line);
      } catch (err) {
        console.error(`Failed to parse log line: ${err.message}`);
        return null;
      }
    }).filter(Boolean);
  } catch (err) {
    console.error(`Failed to read log: ${err.message}`);
    return [];
  }
}

/**
 * Creates a run summary with costs and timings
 */
function createRunSummary(params) {
  const {
    runId,
    deckId,
    tenderId,
    agentUsages,
    prices,
    startTime,
    endTime,
    warnings = [],
    placeholders = 0
  } = params;
  
  const aggregated = aggregateUsage(agentUsages);
  const costEstimate = estimateCost(
    { 
      model: 'aggregate',
      promptTokens: aggregated.promptTokens,
      completionTokens: aggregated.completionTokens
    },
    prices
  );
  
  const durationMs = endTime - startTime;
  
  return {
    runId,
    deckId: deckId || null,
    tenderId: tenderId || '',
    timestamp: new Date(startTime).toISOString(),
    duration: {
      ms: durationMs,
      seconds: Math.round(durationMs / 1000)
    },
    usage: aggregated,
    cost: costEstimate,
    quality: {
      warnings: warnings.length,
      placeholders,
      warningsList: warnings.slice(0, 10) // First 10 warnings
    }
  };
}

// Export for CommonJS (n8n Code nodes) and ES modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    createLogEntry,
    estimateCost,
    aggregateUsage,
    formatJSONL,
    appendToLog,
    readLog,
    createRunSummary
  };
}
