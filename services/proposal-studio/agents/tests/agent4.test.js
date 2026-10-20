/**
 * agent4.test.js - Tests for Agent 4 (Budget) logic
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  buildBudgetFacts,
  getCatalogKeys,
  validateBudgetOutput,
  buildBudgetSlide,
  hasZeroPrices,
  executeAgent4
} = require('../lib/agent4.js');

describe('buildBudgetFacts', () => {
  test('should extract budget facts', () => {
    const input = {
      tender: { project_type: 'software' },
      match: {
        similar_projects: [
          { duration_months: 6, team_size: 5 }
        ]
      }
    };
    
    const diagramsData = {
      plan: [{ phase: 'P1', weeks: 4, roles: [] }],
      components: ['API', 'DB']
    };
    
    const facts = buildBudgetFacts(input, diagramsData);
    
    assert.strictEqual(facts.projectType, 'software');
    assert.strictEqual(facts.plan.length, 1);
    assert.strictEqual(facts.components.length, 2);
    assert.strictEqual(facts.similarProjects.length, 1);
  });
});

describe('getCatalogKeys', () => {
  test('should extract catalog keys only', () => {
    const catalog = {
      daily_rates: { backend: 600, frontend: 550 },
      cloud: { app_server_month: 100 },
      api: { sms_each: 0.10 },
      licenses: { saas_user_month: 10 }
    };
    
    const keys = getCatalogKeys(catalog);
    
    assert.deepStrictEqual(keys.daily_rates, ['backend', 'frontend']);
    assert.deepStrictEqual(keys.cloud, ['app_server_month']);
    assert.deepStrictEqual(keys.api, ['sms_each']);
    assert.deepStrictEqual(keys.licenses, ['saas_user_month']);
  });
});

describe('validateBudgetOutput', () => {
  const catalog = {
    daily_rates: { backend: 600, frontend: 550 },
    cloud: { app_server_month: 100 },
    api: { sms_each: 0.10 },
    licenses: { saas_user_month: 10 },
    workdays_per_week: 5
  };
  
  test('should pass valid output', () => {
    const llmOutput = {
      people: [
        { role: 'backend', days: 40 }
      ],
      infrastructure: [
        { item: 'app_server_month', units: 1, months: 12 }
      ],
      api_usage: [],
      licenses: []
    };
    
    const plan = [
      { phase: 'P1', weeks: 4, roles: [{ role: 'backend', people: 2 }] }
    ];
    
    const errors = validateBudgetOutput(llmOutput, catalog, plan);
    assert.strictEqual(errors.length, 0);
  });
  
  test('should reject invalid role', () => {
    const llmOutput = {
      people: [{ role: 'invalid_role', days: 40 }],
      infrastructure: [],
      api_usage: [],
      licenses: []
    };
    
    const errors = validateBudgetOutput(llmOutput, catalog, []);
    assert.ok(errors.some(e => e.includes('invalid_role')));
  });
  
  test('should reject non-integer days', () => {
    const llmOutput = {
      people: [{ role: 'backend', days: 'not a number' }],
      infrastructure: [],
      api_usage: [],
      licenses: []
    };
    
    const errors = validateBudgetOutput(llmOutput, catalog, []);
    assert.ok(errors.some(e => e.includes('positive integer')));
  });
  
  test('should reject unknown infrastructure item', () => {
    const llmOutput = {
      people: [],
      infrastructure: [{ item: 'unknown_item', units: 1, months: 12 }],
      api_usage: [],
      licenses: []
    };
    
    const errors = validateBudgetOutput(llmOutput, catalog, []);
    assert.ok(errors.some(e => e.includes('unknown_item')));
  });
  
  test('should detect plan mismatch', () => {
    const llmOutput = {
      people: [{ role: 'backend', days: 100 }], // Expected 40
      infrastructure: [],
      api_usage: [],
      licenses: []
    };
    
    const plan = [
      { phase: 'P1', weeks: 4, roles: [{ role: 'backend', people: 2 }] }
    ];
    
    const errors = validateBudgetOutput(llmOutput, catalog, plan);
    assert.ok(errors.some(e => e.includes('Plan mismatch')));
  });
});

describe('buildBudgetSlide', () => {
  test('should build s9 with table and note', () => {
    const budget = {
      people: {
        totalCents: 2400000,
        items: [{ role: 'backend', days: 40, rateCents: 60000, totalCents: 2400000 }]
      },
      infrastructure: { totalCents: 0, items: [] },
      apiUsage: { totalCents: 0, items: [] },
      licenses: { totalCents: 0, items: [] },
      support: { percent: 0.15, totalCents: 360000 },
      contingency: { percent: 0.10, totalCents: 240000 },
      margin: { percent: 0.15, totalCents: 360000 },
      oneTimeTotalCents: 3360000,
      recurringTotalCents: 0,
      catalogDate: '2024-10-18',
      currency: 'EUR'
    };
    
    const slide = buildBudgetSlide(budget, 'fr', true);
    
    assert.strictEqual(slide.id, 's9');
    assert.strictEqual(slide.type, 'content');
    assert.ok(slide.title.includes('financière'));
    assert.strictEqual(slide.requiresApproval, true);
    assert.ok(slide.catalogDate);
    assert.ok(slide.assumptions);
    assert.strictEqual(slide.blocks.length, 2); // Table + note
    assert.strictEqual(slide.blocks[0].kind, 'table');
    assert.strictEqual(slide.blocks[1].kind, 'note');
  });
  
  test('should show placeholders for zero prices', () => {
    const budget = {
      people: {
        totalCents: 0,
        items: [{ role: 'backend', days: 40, rateCents: 0, totalCents: 0 }]
      },
      infrastructure: { totalCents: 0, items: [] },
      apiUsage: { totalCents: 0, items: [] },
      licenses: { totalCents: 0, items: [] },
      support: { percent: 0.15, totalCents: 0 },
      oneTimeTotalCents: 0,
      recurringTotalCents: 0,
      catalogDate: '2024-10-18',
      currency: 'EUR'
    };
    
    const slide = buildBudgetSlide(budget, 'fr', false);
    
    const note = slide.blocks.find(b => b.kind === 'note');
    assert.ok(note.text.includes('[TO FILL'));
  });
});

describe('hasZeroPrices', () => {
  test('should detect all zero prices', () => {
    const catalog = {
      daily_rates: { backend: 0, frontend: 0 },
      cloud: { app_server_month: 0 },
      api: {},
      licenses: {}
    };
    
    assert.strictEqual(hasZeroPrices(catalog), true);
  });
  
  test('should detect non-zero prices', () => {
    const catalog = {
      daily_rates: { backend: 600, frontend: 0 },
      cloud: {},
      api: {},
      licenses: {}
    };
    
    assert.strictEqual(hasZeroPrices(catalog), false);
  });
});

describe('executeAgent4', () => {
  const catalog = {
    last_updated: '2024-10-18',
    currency: 'EUR',
    daily_rates: { backend: 0, frontend: 0 },
    cloud: {},
    api: {},
    licenses: {},
    support_percent_of_build: 0.15,
    contingency_percent: 0.10,
    margin_percent: 0.15,
    workdays_per_week: 5
  };
  
  test('should run in mock mode with fixture', () => {
    const input = {
      tender: { id: 'T-001', language: 'fr' }
    };
    
    const fixture = {
      agent: 'budget',
      slides: [],
      data: {},
      warnings: [],
      usage: {}
    };
    
    const result = executeAgent4(input, {}, catalog, {
      mode: 'mock',
      fixtures: { 'T-001': fixture }
    });
    
    assert.strictEqual(result.agent, 'budget');
  });
  
  test('should generate placeholder when no fixture', () => {
    const input = {
      tender: { id: 'unknown', language: 'en' }
    };
    
    const result = executeAgent4(input, {}, catalog, { mode: 'mock', fixtures: {} });
    
    assert.strictEqual(result.ok, true);
    assert.ok(result.slides.length > 0);
    assert.strictEqual(result.slides[0].id, 's9');
    assert.strictEqual(result.slides[0].requiresApproval, true);
    assert.ok(result.warnings.some(w => w.includes('Catalog')));
  });
});
