/**
 * agent5.test.js - Tests for Agent 5 (Credibility)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { buildReadyFacts, validateOutput, executeAgent5 } = require('../lib/agent5.js');

describe('agent5 - buildReadyFacts', () => {
  test('should extract ready facts from input', () => {
    const input = {
      tender: {
        language: 'fr',
        project_type: 'software'
      },
      match: {
        certifications: {
          matching: 4,
          list: ['ISO 27001', 'RGAA']
        },
        engineers: {
          specialized: 12,
          profiles: [
            { role: 'Backend', count: 5 },
            { role: 'Frontend', count: 4 }
          ]
        },
        similar_projects: [
          { name: 'Project A', year: 2025, stack: ['React'] },
          { name: 'Project B', year: 2024, stack: ['Vue'] }
        ],
        why_us: ['Certified team', 'Fast delivery']
      }
    };
    
    const facts = buildReadyFacts(input);
    
    assert.strictEqual(facts.language, 'fr');
    assert.strictEqual(facts.projectType, 'software');
    assert.strictEqual(facts.certifications.count, 4);
    assert.strictEqual(facts.certifications.list.length, 2);
    assert.strictEqual(facts.engineers.specialized, 12);
    assert.strictEqual(facts.projects.count, 2);
    assert.strictEqual(facts.projects.top.length, 2);
    assert.strictEqual(facts.whyUs.length, 2);
    assert.strictEqual(facts.teamTable.rows.length, 2);
  });
  
  test('should handle missing data gracefully', () => {
    const input = {};
    const facts = buildReadyFacts(input);
    
    assert.strictEqual(facts.certifications.count, 0);
    assert.strictEqual(facts.engineers.specialized, 0);
    assert.strictEqual(facts.projects.count, 0);
    assert.strictEqual(facts.projects.top.length, 0);
  });
  
  test('should build team table rows', () => {
    const input = {
      match: {
        engineers: {
          profiles: [
            { role: 'Backend', count: 5 },
            { role: 'DevOps', count: 2 }
          ]
        }
      }
    };
    
    const facts = buildReadyFacts(input);
    
    assert.strictEqual(facts.teamTable.columns.length, 2);
    assert.strictEqual(facts.teamTable.rows.length, 2);
    assert.deepStrictEqual(facts.teamTable.rows[0], ['Backend', '5']);
    assert.deepStrictEqual(facts.teamTable.rows[1], ['DevOps', '2']);
  });
});

describe('agent5 - validateOutput', () => {
  test('should validate correct output', () => {
    const input = {
      tender: { language: 'fr' },
      match: {
        certifications: { matching: 4, list: ['ISO 27001'] },
        engineers: { specialized: 12 },
        similar_projects: [
          { name: 'Project A', client: 'Client X', year: 2025 }
        ]
      }
    };
    
    const output = {
      agent: 'credibility',
      slides: [
        {
          id: 's4',
          type: 'content',
          title: 'Nos atouts',
          blocks: [
            {
              kind: 'bullets',
              items: ['ISO 27001 certified', '12 specialized engineers'],
              bulletStyle: 'disc'
            }
          ],
          warnings: []
        },
        {
          id: 's6',
          type: 'content',
          title: 'Équipe',
          blocks: [],
          warnings: []
        },
        {
          id: 's7',
          type: 'content',
          title: 'Références',
          blocks: [
            {
              kind: 'cards',
              cards: [
                { title: 'Project A', text: 'Client X, 2025' }
              ]
            }
          ],
          warnings: []
        },
        {
          id: 's8',
          type: 'content',
          title: 'Support',
          blocks: [],
          warnings: []
        }
      ],
      data: { evidence: [] }
    };
    
    const result = validateOutput(output, input);
    
    assert.strictEqual(result.valid, true, `Violations: ${result.violations.join(', ')}`);
    assert.strictEqual(result.violations.length, 0);
  });
  
  test('should detect wrong slide IDs', () => {
    const output = {
      slides: [
        { id: 's1', type: 'content', title: 'Wrong', blocks: [] }
      ]
    };
    
    const result = validateOutput(output, {});
    
    assert.strictEqual(result.valid, false);
    assert.ok(result.violations.some(v => v.includes('[s4, s6, s7, s8]')));
  });
  
  test('should detect invented numbers', () => {
    const input = {
      tender: { language: 'fr' },
      match: { certifications: { matching: 4, list: [] }, engineers: { specialized: 12 } }
    };
    
    const output = {
      slides: [
        {
          id: 's4',
          type: 'content',
          title: 'Nos atouts',
          blocks: [
            {
              kind: 'bullets',
              items: ['99 awards won'],  // invented number
              bulletStyle: 'disc'
            }
          ]
        },
        { id: 's6', type: 'content', title: 'Team', blocks: [] },
        { id: 's7', type: 'content', title: 'Refs', blocks: [] },
        { id: 's8', type: 'content', title: 'SLA', blocks: [] }
      ]
    };
    
    const result = validateOutput(output, input);
    
    assert.strictEqual(result.valid, false);
    assert.ok(result.violations.some(v => v.includes('99')));
  });
  
  test('should detect invented project name in s7', () => {
    const input = {
      tender: { language: 'fr' },
      match: {
        certifications: { matching: 0, list: [] },
        engineers: { specialized: 0 },
        similar_projects: [
          { name: 'Real Project A', client: 'Client X' }
        ]
      }
    };
    
    const output = {
      slides: [
        { id: 's4', type: 'content', title: 'Atouts', blocks: [] },
        { id: 's6', type: 'content', title: 'Team', blocks: [] },
        {
          id: 's7',
          type: 'content',
          title: 'Références',
          blocks: [
            {
              kind: 'cards',
              cards: [
                { title: 'Fake Project', text: 'Made up' }
              ]
            }
          ]
        },
        { id: 's8', type: 'content', title: 'SLA', blocks: [] }
      ]
    };
    
    const result = validateOutput(output, input);
    
    assert.strictEqual(result.valid, false);
    assert.ok(result.violations.some(v => v.includes('Fake Project')));
  });
});

describe('agent5 - executeAgent5', () => {
  test('should run in mock mode with fixture', () => {
    const input = {
      tender: {
        id: 'T-2026-041',
        language: 'fr'
      },
      match: {}
    };
    
    const fixture = {
      agent: 'credibility',
      ok: true,
      slides: [
        { id: 's4', type: 'content', title: 'Test', blocks: [], warnings: [] },
        { id: 's6', type: 'content', title: 'Test', blocks: [], warnings: [] },
        { id: 's7', type: 'content', title: 'Test', blocks: [], warnings: [] },
        { id: 's8', type: 'content', title: 'Test', blocks: [], warnings: [] }
      ],
      data: { evidence: [] },
      assumptions: [],
      warnings: [],
      usage: { model: 'mock', promptTokens: 100, completionTokens: 50, ms: 10, attempts: 1 }
    };
    
    const result = executeAgent5(input, {
      mode: 'mock',
      fixtures: { 'T-2026-041': fixture }
    });
    
    assert.strictEqual(result.agent, 'credibility');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.slides.length, 4);
    assert.ok(result.data.readyFacts, 'Should include readyFacts');
  });
  
  test('should return placeholders when no fixture available', () => {
    const input = {
      tender: { id: 'unknown-id' },
      match: {}
    };
    
    const result = executeAgent5(input, { mode: 'mock', fixtures: {} });
    
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.slides.length, 4);
    assert.ok(result.warnings.some(w => w.includes('no fixture')));
    // Placeholders should be present
    assert.ok(result.slides[0].blocks[0].text.includes('[TO FILL'));
  });
});
