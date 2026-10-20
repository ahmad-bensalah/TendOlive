/**
 * contracts.test.js - Unit tests for contracts.js validation
 * Run: node --test agents/tests/contracts.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Load the module
const contractsPath = path.join(__dirname, '..', 'lib', 'contracts.js');
const {
  validateBlock,
  validateSlideSpec,
  validateDeckSpec,
  checkContentQuality,
  LIMITS
} = require(contractsPath);

describe('validateBlock', () => {
  it('should accept valid text block', () => {
    const block = { kind: 'text', text: 'Hello world' };
    const result = validateBlock(block, 'test');
    assert.strictEqual(result.errors.length, 0);
  });
  
  it('should reject text block without text field', () => {
    const block = { kind: 'text' };
    const result = validateBlock(block, 'test');
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors[0].includes('required string'));
  });
  
  it('should reject unknown block kind', () => {
    const block = { kind: 'chart', data: [] };
    const result = validateBlock(block, 'test');
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors[0].includes('unknown block kind'));
  });
  
  it('should accept valid bullets block', () => {
    const block = { kind: 'bullets', items: ['A', 'B', 'C'] };
    const result = validateBlock(block, 'test');
    assert.strictEqual(result.errors.length, 0);
  });
  
  it('should warn on more than 6 bullets', () => {
    const block = { kind: 'bullets', items: Array(10).fill('Item') };
    const result = validateBlock(block, 'test');
    assert.strictEqual(result.errors.length, 0);
    assert.ok(result.warnings.length > 0);
    assert.ok(result.warnings[0].includes('10 bullets'));
  });
  
  it('should reject invalid bulletStyle', () => {
    const block = { kind: 'bullets', items: ['A'], bulletStyle: 'square' };
    const result = validateBlock(block, 'test');
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors[0].includes('disc, number, check'));
  });
  
  it('should accept valid table block', () => {
    const block = {
      kind: 'table',
      columns: ['Col1', 'Col2'],
      rows: [['A', 'B'], ['C', 'D']]
    };
    const result = validateBlock(block, 'test');
    assert.strictEqual(result.errors.length, 0);
  });
  
  it('should reject table with number cell', () => {
    const block = {
      kind: 'table',
      columns: ['Col1', 'Col2'],
      rows: [['Text', 123]]
    };
    const result = validateBlock(block, 'test');
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors[0].includes('all cells must be strings'));
  });
  
  it('should warn on table with more than 10 rows', () => {
    const rows = Array(15).fill(['A', 'B']);
    const block = {
      kind: 'table',
      columns: ['Col1', 'Col2'],
      rows
    };
    const result = validateBlock(block, 'test');
    assert.strictEqual(result.errors.length, 0);
    assert.ok(result.warnings.length > 0);
    assert.ok(result.warnings[0].includes('15 rows'));
  });
  
  it('should accept valid image block', () => {
    const block = { kind: 'image', src: '/uploads/test.png' };
    const result = validateBlock(block, 'test');
    assert.strictEqual(result.errors.length, 0);
  });
  
  it('should reject image without src', () => {
    const block = { kind: 'image' };
    const result = validateBlock(block, 'test');
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors[0].includes('required string'));
  });
  
  it('should accept valid cards block', () => {
    const block = {
      kind: 'cards',
      cards: [
        { title: 'A', text: 'Description A' },
        { title: 'B', text: 'Description B' }
      ]
    };
    const result = validateBlock(block, 'test');
    assert.strictEqual(result.errors.length, 0);
  });
  
  it('should reject card without title', () => {
    const block = {
      kind: 'cards',
      cards: [{ text: 'Only text' }]
    };
    const result = validateBlock(block, 'test');
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors[0].includes('requires title'));
  });
  
  it('should warn on more than 4 cards', () => {
    const block = {
      kind: 'cards',
      cards: Array(5).fill({ title: 'T', text: 'Text' })
    };
    const result = validateBlock(block, 'test');
    assert.strictEqual(result.errors.length, 0);
    assert.ok(result.warnings.length > 0);
    assert.ok(result.warnings[0].includes('5 cards'));
  });
  
  it('should accept valid kpis block', () => {
    const block = {
      kind: 'kpis',
      items: [
        { label: 'Success', value: '95%' },
        { label: 'Projects', value: '12' }
      ]
    };
    const result = validateBlock(block, 'test');
    assert.strictEqual(result.errors.length, 0);
  });
  
  it('should reject kpi without label', () => {
    const block = {
      kind: 'kpis',
      items: [{ value: '100' }]
    };
    const result = validateBlock(block, 'test');
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors[0].includes('requires label'));
  });
  
  it('should warn on more than 4 KPIs', () => {
    const block = {
      kind: 'kpis',
      items: Array(6).fill({ label: 'L', value: 'V' })
    };
    const result = validateBlock(block, 'test');
    assert.strictEqual(result.errors.length, 0);
    assert.ok(result.warnings.length > 0);
    assert.ok(result.warnings[0].includes('6 KPIs'));
  });
  
  it('should accept note block', () => {
    const block = { kind: 'note', text: 'Important note' };
    const result = validateBlock(block, 'test');
    assert.strictEqual(result.errors.length, 0);
  });
});

describe('validateSlideSpec', () => {
  it('should accept valid slide', () => {
    const slide = {
      type: 'content',
      title: 'Test Slide',
      blocks: [{ kind: 'text', text: 'Content' }]
    };
    const result = validateSlideSpec(slide);
    assert.strictEqual(result.errors.length, 0);
  });
  
  it('should reject slide without title', () => {
    const slide = {
      type: 'content',
      blocks: []
    };
    const result = validateSlideSpec(slide);
    assert.ok(result.errors.some(e => e.includes('title')));
  });
  
  it('should reject slide with unknown field', () => {
    const slide = {
      type: 'content',
      title: 'Test',
      blocks: [],
      author: 'John Doe'
    };
    const result = validateSlideSpec(slide);
    assert.ok(result.errors.some(e => e.includes('unknown field')));
    assert.ok(result.errors.some(e => e.includes('author')));
  });
  
  it('should accept slide with all optional fields', () => {
    const slide = {
      type: 'content',
      title: 'Complete Slide',
      blocks: [],
      notes: 'Speaker notes',
      warnings: ['Warning 1'],
      requiresApproval: true,
      assumptions: ['Assumption 1'],
      catalogDate: '2026-10-18',
      sources: { mermaid: 'graph TD;' }
    };
    const result = validateSlideSpec(slide);
    assert.strictEqual(result.errors.length, 0);
  });
  
  it('should reject requiresApproval as non-boolean', () => {
    const slide = {
      type: 'content',
      title: 'Test',
      blocks: [],
      requiresApproval: 'yes'
    };
    const result = validateSlideSpec(slide);
    assert.ok(result.errors.some(e => e.includes('requiresApproval') && e.includes('boolean')));
  });
  
  it('should reject assumptions as non-array', () => {
    const slide = {
      type: 'content',
      title: 'Test',
      blocks: [],
      assumptions: 'Single assumption'
    };
    const result = validateSlideSpec(slide);
    assert.ok(result.errors.some(e => e.includes('assumptions') && e.includes('array')));
  });
});

describe('validateDeckSpec', () => {
  it('should accept valid deck', () => {
    const deck = {
      name: 'Test Deck',
      slides: [
        {
          type: 'content',
          title: 'Slide 1',
          blocks: [{ kind: 'text', text: 'Content' }]
        }
      ]
    };
    const result = validateDeckSpec(deck);
    assert.strictEqual(result.errors.length, 0);
  });
  
  it('should reject deck without name', () => {
    const deck = {
      slides: []
    };
    const result = validateDeckSpec(deck);
    assert.ok(result.errors.some(e => e.includes('name')));
  });
  
  it('should reject deck with empty name', () => {
    const deck = {
      name: '   ',
      slides: []
    };
    const result = validateDeckSpec(deck);
    assert.ok(result.errors.some(e => e.includes('name')));
  });
  
  it('should reject deck without slides', () => {
    const deck = {
      name: 'Test'
    };
    const result = validateDeckSpec(deck);
    assert.ok(result.errors.some(e => e.includes('slides')));
  });
  
  it('should reject deck with empty slides array', () => {
    const deck = {
      name: 'Test',
      slides: []
    };
    const result = validateDeckSpec(deck);
    assert.ok(result.errors.some(e => e.includes('at least one slide')));
  });
  
  it('should reject deck with unknown field', () => {
    const deck = {
      name: 'Test',
      version: '1.0',
      slides: [{ type: 'content', title: 'T', blocks: [] }]
    };
    const result = validateDeckSpec(deck);
    assert.ok(result.errors.some(e => e.includes('unknown field')));
    assert.ok(result.errors.some(e => e.includes('version')));
  });
  
  it('should collect errors from multiple slides', () => {
    const deck = {
      name: 'Test',
      slides: [
        { type: 'content', blocks: [] }, // missing title
        { type: 'content', title: 'T', blocks: [{ kind: 'chart' }] } // unknown block kind
      ]
    };
    const result = validateDeckSpec(deck);
    assert.ok(result.errors.length >= 2);
  });
});

describe('checkContentQuality', () => {
  it('should warn on HTML in title', () => {
    const slide = {
      type: 'content',
      title: 'Test <b>Bold</b>',
      blocks: []
    };
    const warnings = checkContentQuality(slide);
    assert.ok(warnings.some(w => w.includes('HTML-like markup')));
  });
  
  it('should warn on emoji in title', () => {
    const slide = {
      type: 'content',
      title: 'Test 😀',
      blocks: []
    };
    const warnings = checkContentQuality(slide);
    assert.ok(warnings.some(w => w.includes('emojis')));
  });
  
  it('should warn on HTML in text block', () => {
    const slide = {
      type: 'content',
      title: 'Test',
      blocks: [{ kind: 'text', text: 'Content with <script>' }]
    };
    const warnings = checkContentQuality(slide);
    assert.ok(warnings.some(w => w.includes('HTML-like markup')));
  });
  
  it('should warn on emoji in bullets', () => {
    const slide = {
      type: 'content',
      title: 'Test',
      blocks: [{ kind: 'bullets', items: ['Item 1 👍', 'Item 2'] }]
    };
    const warnings = checkContentQuality(slide);
    assert.ok(warnings.some(w => w.includes('emojis')));
  });
});
