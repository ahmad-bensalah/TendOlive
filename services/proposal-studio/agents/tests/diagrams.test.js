/**
 * diagrams.test.js - Tests for diagram generation
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  generateArchitectureMermaid,
  generateRoadmapMermaid,
  generateClassMermaid,
  validateDiagramStructure,
  buildDiagramFacts,
  executeDiagramAgents
} = require('../lib/diagrams.js');

describe('generateArchitectureMermaid', () => {
  test('should generate valid Mermaid syntax', () => {
    const structure = {
      nodes: [
        { id: 'api', label: 'API Gateway' },
        { id: 'db', label: 'Database' }
      ],
      edges: [
        { from: 'api', to: 'db', label: 'queries' }
      ]
    };
    
    const mermaid = generateArchitectureMermaid(structure);
    
    assert.ok(mermaid.includes('graph LR'));
    assert.ok(mermaid.includes('api["API Gateway"]'));
    assert.ok(mermaid.includes('db["Database"]'));
    assert.ok(mermaid.includes('api -->|"queries"| db'));
  });
  
  test('should handle empty structure', () => {
    const mermaid = generateArchitectureMermaid({});
    assert.strictEqual(mermaid, null);
  });
  
  test('should sanitize IDs', () => {
    const structure = {
      nodes: [{ id: 'api-gateway', label: 'API' }],
      edges: []
    };
    
    const mermaid = generateArchitectureMermaid(structure);
    assert.ok(mermaid.includes('api_gateway'));
    assert.ok(!mermaid.includes('api-gateway'));
  });
});

describe('generateRoadmapMermaid', () => {
  test('should generate valid Gantt chart', () => {
    const structure = {
      phases: [
        { phase: 'Design', weeks: 2, roles: [] },
        { phase: 'Development', weeks: 8, roles: [] }
      ]
    };
    
    const mermaid = generateRoadmapMermaid(structure);
    
    assert.ok(mermaid.includes('gantt'));
    assert.ok(mermaid.includes('title Plan de mise en œuvre'));
    assert.ok(mermaid.includes('Design'));
    assert.ok(mermaid.includes('Development'));
  });
  
  test('should calculate dates', () => {
    const structure = {
      phases: [{ phase: 'P1', weeks: 1, roles: [] }]
    };
    
    const mermaid = generateRoadmapMermaid(structure);
    // Should contain ISO dates
    assert.ok(/\d{4}-\d{2}-\d{2}/.test(mermaid));
  });
  
  test('should handle empty phases', () => {
    const mermaid = generateRoadmapMermaid({});
    assert.strictEqual(mermaid, null);
  });
});

describe('generateClassMermaid', () => {
  test('should generate valid class diagram', () => {
    const structure = {
      classes: [
        {
          name: 'User',
          attributes: ['id', 'name'],
          methods: ['login()', 'logout()']
        }
      ]
    };
    
    const mermaid = generateClassMermaid(structure);
    
    assert.ok(mermaid.includes('classDiagram'));
    assert.ok(mermaid.includes('class User'));
    assert.ok(mermaid.includes('id'));
    assert.ok(mermaid.includes('login()'));
  });
  
  test('should handle relations', () => {
    const structure = {
      classes: [
        {
          name: 'User',
          attributes: [],
          methods: [],
          relations: [{ target: 'Order', type: '-->' }]
        },
        {
          name: 'Order',
          attributes: [],
          methods: []
        }
      ]
    };
    
    const mermaid = generateClassMermaid(structure);
    assert.ok(mermaid.includes('User --> Order'));
  });
  
  test('should handle empty classes', () => {
    const mermaid = generateClassMermaid({});
    assert.strictEqual(mermaid, null);
  });
});

describe('validateDiagramStructure', () => {
  test('should validate architecture structure', () => {
    const valid = {
      nodes: [{ id: 'n1', label: 'Node' }],
      edges: []
    };
    
    const errors = validateDiagramStructure(valid, 'architecture');
    assert.strictEqual(errors.length, 0);
  });
  
  test('should detect missing node id', () => {
    const invalid = {
      nodes: [{ label: 'Node' }],
      edges: []
    };
    
    const errors = validateDiagramStructure(invalid, 'architecture');
    assert.ok(errors.some(e => e.includes('missing id')));
  });
  
  test('should enforce max nodes limit', () => {
    const tooMany = {
      nodes: Array(13).fill(null).map((_, i) => ({ id: `n${i}`, label: `Node ${i}` })),
      edges: []
    };
    
    const errors = validateDiagramStructure(tooMany, 'architecture');
    assert.ok(errors.some(e => e.includes('max 12 nodes')));
  });
  
  test('should validate roadmap structure', () => {
    const valid = {
      phases: [{ phase: 'P1', weeks: 2, roles: [] }]
    };
    
    const errors = validateDiagramStructure(valid, 'roadmap');
    assert.strictEqual(errors.length, 0);
  });
  
  test('should detect invalid weeks', () => {
    const invalid = {
      phases: [{ phase: 'P1', weeks: 'not a number', roles: [] }]
    };
    
    const errors = validateDiagramStructure(invalid, 'roadmap');
    assert.ok(errors.some(e => e.includes('positive integer')));
  });
  
  test('should validate class structure', () => {
    const valid = {
      classes: [{ name: 'User', attributes: [], methods: [] }]
    };
    
    const errors = validateDiagramStructure(valid, 'class');
    assert.strictEqual(errors.length, 0);
  });
  
  test('should detect missing class name', () => {
    const invalid = {
      classes: [{ attributes: [], methods: [] }]
    };
    
    const errors = validateDiagramStructure(invalid, 'class');
    assert.ok(errors.some(e => e.includes('missing name')));
  });
});

describe('buildDiagramFacts', () => {
  test('should extract facts from input', () => {
    const input = {
      tender: {
        requirements: ['Req 1', 'Req 2'],
        project_type: 'software'
      },
      match: {
        similar_projects: [
          { stack: ['React', 'Node'], duration_months: 6 },
          { stack: ['Vue', 'Python'], duration_months: 8 }
        ],
        engineers: {
          profiles: [
            { role: 'Backend', count: 5 }
          ]
        }
      }
    };
    
    const facts = buildDiagramFacts(input);
    
    assert.strictEqual(facts.projectType, 'software');
    assert.strictEqual(facts.requirements.length, 2);
    assert.ok(facts.technologies.includes('React'));
    assert.ok(facts.technologies.includes('Node'));
    assert.strictEqual(facts.avgDurationMonths, 7); // (6+8)/2
    assert.strictEqual(facts.teamProfiles.length, 1);
  });
  
  test('should handle missing data', () => {
    const input = {};
    const facts = buildDiagramFacts(input);
    
    assert.strictEqual(facts.projectType, 'other');
    assert.strictEqual(facts.requirements.length, 0);
    assert.strictEqual(facts.technologies.length, 0);
    assert.strictEqual(facts.avgDurationMonths, 6); // Default
  });
  
  test('should deduplicate technologies', () => {
    const input = {
      match: {
        similar_projects: [
          { stack: ['React', 'Node'] },
          { stack: ['React', 'Python'] }
        ]
      }
    };
    
    const facts = buildDiagramFacts(input);
    const reactCount = facts.technologies.filter(t => t === 'React').length;
    assert.strictEqual(reactCount, 1);
  });
});

describe('executeDiagramAgents', () => {
  test('should run in mock mode with fixture', () => {
    const input = {
      tender: { id: 'T-001', project_type: 'software' },
      match: {}
    };
    
    const fixture = {
      agent: 'diagrams',
      diagrams: [],
      data: { components: [], plan: [], risks: [] },
      warnings: [],
      usage: {}
    };
    
    const result = executeDiagramAgents(input, {
      mode: 'mock',
      fixtures: { 'T-001': fixture }
    });
    
    assert.strictEqual(result.agent, 'diagrams');
    assert.ok(result.data.readyFacts);
  });
  
  test('should return placeholder when no fixture', () => {
    const input = {
      tender: { id: 'unknown' },
      match: {}
    };
    
    const result = executeDiagramAgents(input, { mode: 'mock', fixtures: {} });
    
    assert.strictEqual(result.ok, true);
    assert.ok(result.diagrams.length > 0);
    assert.ok(result.warnings.some(w => w.includes('no fixture')));
  });
});
