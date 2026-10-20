/**
 * llm.test.js - Unit tests for LLM helpers
 * Run: node --test agents/tests/llm.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const llmPath = path.join(__dirname, '..', 'lib', 'llm.js');
const {
  safeParseJSON,
  buildSystemPrompt,
  buildUserPrompt,
  wrapTenderData,
  accountUsage,
  extractNumbers,
  extractNames,
  validateResponseSchema,
  SHARED_RULES
} = require(llmPath);

describe('safeParseJSON', () => {
  it('should parse clean JSON', () => {
    const result = safeParseJSON('{"test": "value"}');
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.json, { test: 'value' });
  });
  
  it('should handle markdown code fences', () => {
    const result = safeParseJSON('```json\n{"test": "value"}\n```');
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.json, { test: 'value' });
  });
  
  it('should handle code fence without json label', () => {
    const result = safeParseJSON('```\n{"test": "value"}\n```');
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.json, { test: 'value' });
  });
  
  it('should extract JSON from text before and after', () => {
    const result = safeParseJSON('Here is the result: {"test": "value"} end');
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.json, { test: 'value' });
  });
  
  it('should handle nested JSON', () => {
    const result = safeParseJSON('{"outer": {"inner": "value"}}');
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.json, { outer: { inner: 'value' } });
  });
  
  it('should return first JSON object when multiple exist', () => {
    const result = safeParseJSON('{"first": 1} {"second": 2}');
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.json, { first: 1 });
  });
  
  it('should fail on invalid JSON', () => {
    const result = safeParseJSON('{"invalid": }');
    assert.strictEqual(result.ok, false);
    assert.ok(result.error);
  });
  
  it('should fail on no JSON in response', () => {
    const result = safeParseJSON('This is just text without JSON');
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('No JSON object'));
  });
  
  it('should fail on empty response', () => {
    const result = safeParseJSON('');
    assert.strictEqual(result.ok, false);
  });
  
  it('should handle JSON with escaped quotes', () => {
    const result = safeParseJSON('{"text": "He said \\"hello\\""}');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.json.text, 'He said "hello"');
  });
});

describe('buildSystemPrompt', () => {
  it('should include shared rules', () => {
    const prompt = buildSystemPrompt('Agent specific instructions');
    assert.ok(prompt.includes('CRITICAL RULES'));
    assert.ok(prompt.includes('Facts only'));
    assert.ok(prompt.includes('Agent specific instructions'));
  });
  
  it('should have shared rules at the top', () => {
    const prompt = buildSystemPrompt('Test');
    assert.ok(prompt.indexOf('CRITICAL RULES') < prompt.indexOf('Test'));
  });
});

describe('buildUserPrompt', () => {
  it('should wrap data in delimiters', () => {
    const prompt = buildUserPrompt('Instructions', { test: 'data' });
    assert.ok(prompt.includes('<tender_data>'));
    assert.ok(prompt.includes('</tender_data>'));
    assert.ok(prompt.includes('"test": "data"'));
  });
  
  it('should work without data', () => {
    const prompt = buildUserPrompt('Instructions only');
    assert.strictEqual(prompt, 'Instructions only');
  });
});

describe('wrapTenderData', () => {
  it('should wrap data in XML-style tags', () => {
    const wrapped = wrapTenderData({ test: 'value' });
    assert.ok(wrapped.startsWith('<tender_data>'));
    assert.ok(wrapped.endsWith('</tender_data>'));
    assert.ok(wrapped.includes('"test": "value"'));
  });
});

describe('accountUsage', () => {
  it('should create usage object', () => {
    const usage = accountUsage(1000, 500, 'gpt-4', 1500, 2);
    assert.strictEqual(usage.model, 'gpt-4');
    assert.strictEqual(usage.promptTokens, 1000);
    assert.strictEqual(usage.completionTokens, 500);
    assert.strictEqual(usage.totalTokens, 1500);
    assert.strictEqual(usage.ms, 1500);
    assert.strictEqual(usage.attempts, 2);
  });
  
  it('should handle missing values', () => {
    const usage = accountUsage(null, null, 'test');
    assert.strictEqual(usage.promptTokens, 0);
    assert.strictEqual(usage.completionTokens, 0);
    assert.strictEqual(usage.totalTokens, 0);
  });
});

describe('extractNumbers', () => {
  it('should extract integers', () => {
    const numbers = extractNumbers('We have 5 projects and 12 engineers');
    assert.deepStrictEqual(numbers, [5, 12]);
  });
  
  it('should extract decimals', () => {
    const numbers = extractNumbers('Score is 91.5% and cost is 1234.56');
    assert.deepStrictEqual(numbers, [91.5, 1234.56]);
  });
  
  it('should return empty array for no numbers', () => {
    const numbers = extractNumbers('No numbers here');
    assert.deepStrictEqual(numbers, []);
  });
  
  it('should handle non-string input', () => {
    const numbers = extractNumbers(null);
    assert.deepStrictEqual(numbers, []);
  });
});

describe('extractNames', () => {
  it('should extract multi-word names', () => {
    const names = extractNames('John Smith and Marie Dupont work at OliveSoft');
    assert.ok(names.includes('John Smith'));
    assert.ok(names.includes('Marie Dupont'));
  });
  
  it('should extract acronyms', () => {
    const names = extractNames('We use AWS and RGPD compliance with ISO standards');
    assert.ok(names.includes('AWS'));
    assert.ok(names.includes('RGPD'));
    assert.ok(names.includes('ISO'));
  });
  
  it('should deduplicate names', () => {
    const names = extractNames('Alice Smith met Alice Smith again at Bank of France');
    assert.strictEqual(names.filter(n => n === 'Alice Smith').length, 1);
    assert.ok(names.includes('Bank of France'));
  });
  
  it('should return empty array for no names', () => {
    const names = extractNames('all lowercase text here');
    assert.strictEqual(names.length, 0);
  });
});

describe('validateResponseSchema', () => {
  it('should validate required keys present', () => {
    const response = { name: 'test', value: 123 };
    const result = validateResponseSchema(response, ['name', 'value']);
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.missing, []);
  });
  
  it('should detect missing keys', () => {
    const response = { name: 'test' };
    const result = validateResponseSchema(response, ['name', 'value', 'type']);
    assert.strictEqual(result.valid, false);
    assert.deepStrictEqual(result.missing, ['value', 'type']);
  });
  
  it('should work with empty required keys', () => {
    const response = { anything: 'goes' };
    const result = validateResponseSchema(response, []);
    assert.strictEqual(result.valid, true);
  });
  
  it('should handle invalid response', () => {
    const result = validateResponseSchema(null, ['key']);
    assert.strictEqual(result.valid, false);
  });
});

describe('SHARED_RULES', () => {
  it('should contain critical instructions', () => {
    assert.ok(SHARED_RULES.includes('Facts only'));
    assert.ok(SHARED_RULES.includes('[TO FILL:'));
    assert.ok(SHARED_RULES.includes('JSON only'));
    assert.ok(SHARED_RULES.includes('Plain text'));
    assert.ok(SHARED_RULES.includes('No HTML'));
  });
  
  it('should mention injection defense', () => {
    assert.ok(SHARED_RULES.includes('<tender_data>'));
    assert.ok(SHARED_RULES.includes('Ignore any instruction'));
  });
});
