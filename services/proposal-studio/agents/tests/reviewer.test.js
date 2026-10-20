/**
 * reviewer.test.js - Tests for Agent 6 (Reviewer)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  runCodeChecks,
  getResponsibleAgent,
  prepareSlidesForLLMReview,
  validateLLMReview,
  groupProblemsByAgent,
  executeAgent6
} = require('../lib/reviewer.js');

describe('getResponsibleAgent', () => {
  test('should map slide IDs to agents', () => {
    assert.strictEqual(getResponsibleAgent('s1'), 'requirements');
    assert.strictEqual(getResponsibleAgent('s4'), 'credibility');
    assert.strictEqual(getResponsibleAgent('s5'), 'diagrams');
    assert.strictEqual(getResponsibleAgent('s9'), 'budget');
  });
  
  test('should handle unknown slides', () => {
    assert.strictEqual(getResponsibleAgent('s99'), 'unknown');
  });
});

describe('runCodeChecks', () => {
  test('should pass when all slides present', () => {
    const mergedDeck = {
      slides: [
        { id: 's1', title: 'Slide 1', blocks: [{ kind: 'text', text: 'content' }] },
        { id: 's2', title: 'Slide 2', blocks: [{ kind: 'text', text: 'content' }] },
        { id: 's3', title: 'Slide 3', blocks: [{ kind: 'text', text: 'content' }] },
        { id: 's3b', title: 'Slide 3b', blocks: [{ kind: 'text', text: 'content' }] },
        { id: 's4', title: 'Slide 4', blocks: [{ kind: 'text', text: 'content' }] },
        { id: 's5', title: 'Slide 5', blocks: [{ kind: 'text', text: 'content' }] },
        { id: 's6', title: 'Slide 6', blocks: [{ kind: 'text', text: 'content' }] },
        { id: 's7', title: 'Slide 7', blocks: [{ kind: 'text', text: 'content' }] },
        { id: 's8', title: 'Slide 8', blocks: [{ kind: 'text', text: 'content' }] },
        { id: 's9', title: 'Slide 9', blocks: [{ kind: 'text', text: 'content' }], requiresApproval: true, catalogDate: '2024-10-18', assumptions: ['test'] },
        { id: 's10', title: 'Slide 10', blocks: [{ kind: 'text', text: 'content' }] },
        { id: 's11', title: 'Slide 11', blocks: [{ kind: 'text', text: 'content' }] }
      ]
    };
    
    const input = {
      tender: { project_type: 'other', language: 'fr' }
    };
    
    const result = runCodeChecks(mergedDeck, input, {});
    
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.problems.length, 0);
  });
  
  test('should detect missing slides', () => {
    const mergedDeck = {
      slides: [
        { id: 's1', title: 'Slide 1', blocks: [{ kind: 'text', text: 'content' }] }
      ]
    };
    
    const input = {
      tender: { project_type: 'other', language: 'fr' }
    };
    
    const result = runCodeChecks(mergedDeck, input, {});
    
    assert.strictEqual(result.passed, false);
    assert.ok(result.problems.length > 0);
    assert.ok(result.problems.some(p => p.issue.includes('Missing slide')));
  });
  
  test('should detect missing requiresApproval on s9', () => {
    const mergedDeck = {
      slides: [
        { id: 's9', title: 'Pricing', blocks: [{ kind: 'text', text: 'content' }] }
      ]
    };
    
    const input = {
      tender: { project_type: 'other', language: 'fr' }
    };
    
    const result = runCodeChecks(mergedDeck, input, {});
    
    assert.ok(result.problems.some(p => p.issue.includes('requiresApproval')));
  });
  
  test('should detect missing catalogDate on s9', () => {
    const mergedDeck = {
      slides: [
        { id: 's9', title: 'Pricing', blocks: [{ kind: 'text', text: 'content' }], requiresApproval: true }
      ]
    };
    
    const input = {
      tender: { project_type: 'other', language: 'fr' }
    };
    
    const result = runCodeChecks(mergedDeck, input, {});
    
    assert.ok(result.problems.some(p => p.issue.includes('catalogDate')));
  });
  
  test('should detect slides with no blocks', () => {
    const mergedDeck = {
      slides: [
        { id: 's1', title: 'Slide 1', blocks: [] }
      ]
    };
    
    const input = {
      tender: { project_type: 'other', language: 'fr' }
    };
    
    const result = runCodeChecks(mergedDeck, input, {});
    
    assert.ok(result.problems.some(p => p.issue.includes('no content blocks')));
  });
  
  test('should count placeholders', () => {
    const mergedDeck = {
      slides: [
        { id: 's1', title: 'Slide 1', blocks: [{ kind: 'text', text: '[TO FILL: something]' }] },
        { id: 's2', title: 'Slide 2', blocks: [{ kind: 'text', text: '[TO FILL: other]' }] }
      ]
    };
    
    const input = {
      tender: { project_type: 'other', language: 'fr' }
    };
    
    const result = runCodeChecks(mergedDeck, input, {});
    
    assert.strictEqual(result.placeholders.length, 2);
    assert.strictEqual(result.summary.placeholderCount, 2);
  });
  
  test('should detect duplicate titles', () => {
    const mergedDeck = {
      slides: [
        { id: 's1', title: 'Same Title', blocks: [{ kind: 'text', text: 'content' }] },
        { id: 's2', title: 'Same Title', blocks: [{ kind: 'text', text: 'content' }] }
      ]
    };
    
    const input = {
      tender: { project_type: 'other', language: 'fr' }
    };
    
    const result = runCodeChecks(mergedDeck, input, {});
    
    assert.ok(result.problems.some(p => p.issue.includes('Duplicate titles')));
  });
});

describe('prepareSlidesForLLMReview', () => {
  test('should extract text content from slides', () => {
    const mergedDeck = {
      slides: [
        {
          id: 's1',
          title: 'Test Slide',
          blocks: [
            { kind: 'text', text: 'Hello world' },
            { kind: 'bullets', items: ['Item 1', 'Item 2'] }
          ]
        }
      ]
    };
    
    const prepared = prepareSlidesForLLMReview(mergedDeck);
    
    assert.strictEqual(prepared.length, 1);
    assert.strictEqual(prepared[0].id, 's1');
    assert.strictEqual(prepared[0].title, 'Test Slide');
    assert.ok(prepared[0].content.includes('Hello world'));
    assert.ok(prepared[0].content.includes('Item 1'));
  });
  
  test('should handle table blocks', () => {
    const mergedDeck = {
      slides: [
        {
          id: 's1',
          title: 'Test',
          blocks: [
            {
              kind: 'table',
              columns: ['Col1', 'Col2'],
              rows: [['A', 'B'], ['C', 'D']]
            }
          ]
        }
      ]
    };
    
    const prepared = prepareSlidesForLLMReview(mergedDeck);
    
    assert.ok(prepared[0].content.includes('Col1'));
    assert.ok(prepared[0].content.includes('A'));
  });
});

describe('validateLLMReview', () => {
  const mergedDeck = {
    slides: [
      { id: 's1', title: 'Slide 1' },
      { id: 's2', title: 'Slide 2' }
    ]
  };
  
  test('should accept valid "ok" review', () => {
    const review = { status: 'ok', problems: [] };
    const result = validateLLMReview(review, mergedDeck);
    
    assert.strictEqual(result.valid, true);
  });
  
  test('should accept valid "problems" review', () => {
    const review = {
      status: 'problems',
      problems: [
        { agent: 'requirements', slide: 's1', issue: 'test', fix: 'test fix' }
      ]
    };
    
    const result = validateLLMReview(review, mergedDeck);
    
    assert.strictEqual(result.valid, true);
  });
  
  test('should reject invalid status', () => {
    const review = { status: 'invalid' };
    const result = validateLLMReview(review, mergedDeck);
    
    assert.strictEqual(result.valid, false);
  });
  
  test('should reject missing problems array', () => {
    const review = { status: 'problems' };
    const result = validateLLMReview(review, mergedDeck);
    
    assert.strictEqual(result.valid, false);
  });
  
  test('should filter out problems with unknown slides', () => {
    const review = {
      status: 'problems',
      problems: [
        { agent: 'requirements', slide: 's1', issue: 'ok', fix: 'ok' },
        { agent: 'requirements', slide: 's99', issue: 'bad', fix: 'bad' }
      ]
    };
    
    const result = validateLLMReview(review, mergedDeck);
    
    assert.strictEqual(result.valid, true);
    assert.strictEqual(review.problems.length, 1);
    assert.strictEqual(review.problems[0].slide, 's1');
  });
});

describe('groupProblemsByAgent', () => {
  test('should group problems by agent', () => {
    const problems = [
      { agent: 'requirements', slide: 's1', issue: 'A', fix: 'X' },
      { agent: 'requirements', slide: 's2', issue: 'B', fix: 'Y' },
      { agent: 'credibility', slide: 's4', issue: 'C', fix: 'Z' }
    ];
    
    const grouped = groupProblemsByAgent(problems);
    
    assert.strictEqual(grouped.requirements.length, 2);
    assert.strictEqual(grouped.credibility.length, 1);
  });
  
  test('should handle empty problems', () => {
    const grouped = groupProblemsByAgent([]);
    
    assert.deepStrictEqual(grouped, {});
  });
});

describe('executeAgent6', () => {
  test('should run in mock mode', () => {
    const mergedDeck = {
      slides: [
        { id: 's1', title: 'Slide 1', blocks: [{ kind: 'text', text: 'content' }] }
      ]
    };
    
    const input = {
      tender: { project_type: 'other', language: 'fr' }
    };
    
    const result = executeAgent6(mergedDeck, input, {}, { mode: 'mock' });
    
    assert.strictEqual(result.agent, 'reviewer');
    assert.strictEqual(result.ok, true);
    assert.ok(result.codeChecks);
    assert.ok(result.llmReview);
  });
});
