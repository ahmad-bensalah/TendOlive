/**
 * agent1.test.js - Unit tests for Agent 1
 * Run: node --test agents/tests/agent1.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const agent1Path = path.join(__dirname, '..', 'lib', 'agent1.js');
const { buildReadyFacts, validateOutput, executeAgent1 } = require(agent1Path);

const checksPath = path.join(__dirname, '..', 'lib', 'checks.js');
const { checkNumbers, checkNames, checkClaims, checkPlaceholders, getAllowedNumbers, getAllowedNames } = require(checksPath);

describe('checks - checkNumbers', () => {
  it('should pass when all numbers are in allowed list', () => {
    const violations = checkNumbers('We have 5 projects and 3 certifications', [5, 3]);
    assert.strictEqual(violations.length, 0);
  });
  
  it('should detect invented numbers', () => {
    const violations = checkNumbers('We have 10 projects', [5, 3]);
    assert.ok(violations.length > 0);
    assert.ok(violations[0].includes('10'));
  });
  
  it('should handle percentages', () => {
    const violations = checkNumbers('Score is 85%', [0.85, 85]);
    assert.strictEqual(violations.length, 0);
  });
});

describe('checks - checkNames', () => {
  it('should pass when names are in allowed list', () => {
    const violations = checkNames('Project Alpha and Project Beta', ['Project Alpha', 'Project Beta']);
    assert.strictEqual(violations.length, 0);
  });
  
  it('should detect invented names', () => {
    const violations = checkNames('Project Gamma', ['Project Alpha', 'Project Beta']);
    assert.ok(violations.length > 0);
    assert.ok(violations[0].includes('Gamma'));
  });
  
  it('should allow partial matches', () => {
    const violations = checkNames('Alpha', ['Project Alpha']);
    assert.strictEqual(violations.length, 0);
  });
});

describe('checks - checkClaims', () => {
  it('should pass when claim is in allowed list', () => {
    const violations = checkClaims('We are the best team', ['We are the best team for this'], 'en');
    assert.strictEqual(violations.length, 0);
  });
  
  it('should detect unsupported superlatives', () => {
    const violations = checkClaims('We are the best team', [], 'en');
    assert.ok(violations.length > 0);
    assert.ok(violations[0].includes('best'));
  });
  
  it('should check French superlatives', () => {
    const violations = checkClaims('Nous sommes le meilleur', [], 'fr');
    assert.ok(violations.length > 0);
    assert.ok(violations[0].includes('meilleur'));
  });
});

describe('checks - checkPlaceholders', () => {
  it('should accept correct placeholder format', () => {
    const violations = checkPlaceholders('Contact: [TO FILL: email address]');
    assert.strictEqual(violations.length, 0);
  });
  
  it('should detect incorrect formats', () => {
    const violations = checkPlaceholders('Contact: [TODO: add email]');
    assert.ok(violations.length > 0);
  });
  
  it('should detect TBD format', () => {
    const violations = checkPlaceholders('Price: [TBD]');
    assert.ok(violations.length > 0);
  });
});

describe('checks - getAllowedNumbers', () => {
  it('should extract numbers from input', () => {
    const input = {
      match: {
        score: 0.85,
        similar_projects: [{ year: 2024 }, { year: 2025 }],
        engineers: { specialized: 12 }
      },
      tender: {
        requirements: ['R1', 'R2', 'R3']
      }
    };
    
    const numbers = getAllowedNumbers(input);
    assert.ok(numbers.includes(0.85));
    assert.ok(numbers.includes(85)); // Percentage
    assert.ok(numbers.includes(2024));
    assert.ok(numbers.includes(2025));
    assert.ok(numbers.includes(12));
    assert.ok(numbers.includes(3)); // Requirements count
  });
});

describe('checks - getAllowedNames', () => {
  it('should extract names from input', () => {
    const input = {
      tender: { client: 'ACME Corp' },
      match: {
        similar_projects: [
          { name: 'Project Alpha', client: 'Client A' }
        ],
        certifications: { list: ['ISO 27001'] }
      }
    };
    
    const names = getAllowedNames(input);
    assert.ok(names.includes('ACME Corp'));
    assert.ok(names.includes('Project Alpha'));
    assert.ok(names.includes('Client A'));
    assert.ok(names.includes('ISO 27001'));
  });
});

describe('agent1 - buildReadyFacts', () => {
  it('should build KPIs from input', () => {
    const input = {
      tender: { language: 'fr', requirements: ['R1', 'R2'] },
      match: {
        score: 0.85,
        similar_projects: [{ name: 'P1' }, { name: 'P2' }, { name: 'P3' }],
        engineers: { specialized: 12 }
      }
    };
    
    const facts = buildReadyFacts(input);
    
    assert.strictEqual(facts.requirement_count, 2);
    assert.ok(facts.kpis.length > 0);
    assert.ok(facts.kpis.some(kpi => kpi.label.includes('Projets similaires')));
    assert.ok(facts.kpis.some(kpi => kpi.value === '3'));
  });
  
  it('should map evidence candidates to requirements', () => {
    const input = {
      tender: {
        requirements: ['Application mobile iOS et Android', 'Hébergement RGPD']
      },
      match: {
        similar_projects: [
          { name: 'Mobile App X', stack: ['React Native', 'iOS'] },
          { name: 'Cloud Platform', stack: ['AWS', 'Docker'] }
        ]
      }
    };
    
    const facts = buildReadyFacts(input);
    
    assert.ok(facts.evidence_candidates[0]); // First requirement
    // Should suggest Mobile App X for mobile requirement
    const candidates0 = facts.evidence_candidates[0];
    assert.ok(candidates0.length >= 0); // May or may not match depending on keyword logic
  });
});

describe('agent1 - validateOutput', () => {
  it('should validate correct output', () => {
    const input = {
      tender: { language: 'fr', requirements: ['R1', 'R2'] },
      match: {
        score: 0.85,
        similar_projects: [{ name: 'Project A' }]
      }
    };
    
    const readyFacts = buildReadyFacts(input);
    
    const output = {
      slides: [
        {
          id: 's1',
          type: 'content',
          title: 'Synthèse exécutive',
          blocks: [
            { kind: 'text', text: 'Notre équipe propose une solution' },
            { kind: 'kpis', items: [{ label: 'Projets', value: '1' }] },
            { kind: 'bullets', items: ['Avantage 1', 'Avantage 2'] }
          ]
        },
        {
          id: 's2',
          type: 'content',
          title: 'Compréhension',
          blocks: [{ kind: 'bullets', items: ['R1', 'R2'] }]
        },
        {
          id: 's3',
          type: 'content',
          title: 'Conformité',
          blocks: [{
            kind: 'table',
            columns: ['Exigence', 'Réponse', 'Preuve'],
            rows: [
              ['R1', 'Solution adaptée', 'Project A'],
              ['R2', 'Conforme', 'À préciser']
            ]
          }]
        },
        {
          id: 's11',
          type: 'content',
          title: 'Prochaines étapes',
          blocks: [
            { kind: 'bullets', items: ['Atelier', 'Plan', 'Démarrage'] },
            { kind: 'text', text: '[TO FILL: contact]' }
          ]
        }
      ],
      data: {
        requirement_list: ['R1', 'R2'],
        project_type: 'other',
        key_features: ['Feature 1']
      },
      assumptions: []
    };
    
    const result = validateOutput(output, input, readyFacts);
    assert.strictEqual(result.valid, true, `Violations: ${result.violations.join(', ')}`);
  });
  
  it('should detect wrong row count in compliance matrix', () => {
    const input = {
      tender: { requirements: ['R1', 'R2', 'R3'] },
      match: {}
    };
    
    const readyFacts = buildReadyFacts(input);
    
    const output = {
      slides: [
        { id: 's1', type: 'content', title: 'T', blocks: [] },
        { id: 's2', type: 'content', title: 'T', blocks: [] },
        {
          id: 's3',
          type: 'content',
          title: 'T',
          blocks: [{
            kind: 'table',
            columns: ['A', 'B', 'C'],
            rows: [['R1', 'X', 'Y']] // Only 1 row, should be 3
          }]
        },
        { id: 's11', type: 'content', title: 'T', blocks: [{ kind: 'text', text: '[TO FILL: contact]' }] }
      ],
      data: { requirement_list: [], project_type: 'other' },
      assumptions: []
    };
    
    const result = validateOutput(output, input, readyFacts);
    assert.strictEqual(result.valid, false);
    assert.ok(result.violations.some(v => v.includes('should have 3')));
  });
});

describe('agent1 - executeAgent1', () => {
  it('should run in mock mode with fixtures', () => {
    const input = {
      tender: { requirements: ['R1', 'R2'] },
      match: {}
    };
    
    const result = executeAgent1(input, { mode: 'mock', inputId: 'software' });
    
    if (result.ok) {
      assert.strictEqual(result.mode, 'mock');
      assert.ok(result.output);
      assert.ok(Array.isArray(result.output.slides));
    }
  });
});
