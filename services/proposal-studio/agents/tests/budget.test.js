/**
 * budget.test.js - Tests for budget calculator (integer cents, no floats)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  eurosToCents,
  centsToEuros,
  formatCurrency,
  calculatePeopleCost,
  calculateInfrastructureCost,
  calculateApiCost,
  calculateLicenseCost,
  buildBudget,
  checkPlanConsistency,
  buildBudgetTableRows
} = require('../lib/budget.js');

describe('eurosToCents', () => {
  test('should convert euros to cents', () => {
    assert.strictEqual(eurosToCents(100), 10000);
    assert.strictEqual(eurosToCents(1.50), 150);
    assert.strictEqual(eurosToCents(0.01), 1);
  });
  
  test('should round to nearest cent', () => {
    assert.strictEqual(eurosToCents(1.234), 123);
    assert.strictEqual(eurosToCents(1.235), 124);
  });
  
  test('should handle invalid input', () => {
    assert.strictEqual(eurosToCents(NaN), 0);
    assert.strictEqual(eurosToCents(Infinity), 0);
    assert.strictEqual(eurosToCents('not a number'), 0);
  });
});

describe('centsToEuros', () => {
  test('should convert cents to euros', () => {
    assert.strictEqual(centsToEuros(10000), 100);
    assert.strictEqual(centsToEuros(150), 1.5);
    assert.strictEqual(centsToEuros(1), 0.01);
  });
  
  test('should handle invalid input', () => {
    assert.strictEqual(centsToEuros(NaN), 0);
    assert.strictEqual(centsToEuros(Infinity), 0);
  });
});

describe('formatCurrency', () => {
  test('should format French currency', () => {
    assert.strictEqual(formatCurrency(123456, 'fr', 'EUR'), '1 234,56 EUR');
    assert.strictEqual(formatCurrency(100, 'fr', 'EUR'), '1,00 EUR');
    assert.strictEqual(formatCurrency(1234567890, 'fr', 'EUR'), '12 345 678,90 EUR');
  });
  
  test('should format English currency', () => {
    assert.strictEqual(formatCurrency(123456, 'en', 'EUR'), 'EUR1,234.56');
    assert.strictEqual(formatCurrency(100, 'en', 'EUR'), 'EUR1.00');
  });
  
  test('should handle zero', () => {
    assert.strictEqual(formatCurrency(0, 'fr', 'EUR'), '0,00 EUR');
    assert.strictEqual(formatCurrency(0, 'en', 'EUR'), 'EUR0.00');
  });
});

describe('calculatePeopleCost', () => {
  test('should calculate people cost', () => {
    const people = [
      { role: 'backend', days: 40 },
      { role: 'frontend', days: 30 }
    ];
    
    const rates = {
      backend: 60000, // 600 EUR
      frontend: 55000  // 550 EUR
    };
    
    const result = calculatePeopleCost(people, rates);
    
    assert.strictEqual(result.totalCents, 60000 * 40 + 55000 * 30);
    assert.strictEqual(result.items.length, 2);
    assert.strictEqual(result.items[0].totalCents, 2400000); // 24,000 EUR
  });
  
  test('should handle missing roles', () => {
    const people = [{ role: 'unknown', days: 10 }];
    const rates = { backend: 60000 };
    
    const result = calculatePeopleCost(people, rates);
    assert.strictEqual(result.totalCents, 0);
  });
  
  test('should handle zero days', () => {
    const people = [{ role: 'backend', days: 0 }];
    const rates = { backend: 60000 };
    
    const result = calculatePeopleCost(people, rates);
    assert.strictEqual(result.totalCents, 0);
  });
});

describe('calculateInfrastructureCost', () => {
  test('should calculate infrastructure cost', () => {
    const infrastructure = [
      { item: 'app_server_month', units: 2, months: 12 },
      { item: 'database_month', units: 1, months: 12 }
    ];
    
    const prices = {
      app_server_month: 10000, // 100 EUR
      database_month: 20000     // 200 EUR
    };
    
    const result = calculateInfrastructureCost(infrastructure, prices);
    
    assert.strictEqual(result.totalCents, 10000 * 2 * 12 + 20000 * 1 * 12);
    assert.strictEqual(result.items.length, 2);
  });
  
  test('should handle missing prices', () => {
    const infrastructure = [{ item: 'unknown', units: 1, months: 12 }];
    const prices = {};
    
    const result = calculateInfrastructureCost(infrastructure, prices);
    assert.strictEqual(result.totalCents, 0);
  });
});

describe('calculateApiCost', () => {
  test('should calculate LLM token cost', () => {
    const apiUsage = [
      {
        item: 'llm_api',
        requests_per_month: 1000,
        input_tokens: 500000,   // 0.5M
        output_tokens: 200000,  // 0.2M
        months: 12
      }
    ];
    
    const prices = {
      llm_input_per_1m_tokens: 100,   // 1 EUR per 1M
      llm_output_per_1m_tokens: 300   // 3 EUR per 1M
    };
    
    const result = calculateApiCost(apiUsage, prices);
    
    // (0.5 * 100 + 0.2 * 300) * 1000 * 12 = (50 + 60) * 12000 = 1,320,000 cents
    assert.strictEqual(result.totalCents, 1320000);
  });
  
  test('should calculate SMS cost', () => {
    const apiUsage = [
      { item: 'sms_notifications', requests_per_month: 500, months: 12 }
    ];
    
    const prices = { sms_each: 10 }; // 0.10 EUR
    
    const result = calculateApiCost(apiUsage, prices);
    assert.strictEqual(result.totalCents, 10 * 500 * 12);
  });
  
  test('should calculate email cost', () => {
    const apiUsage = [
      { item: 'email_service', requests_per_month: 2000, months: 12 }
    ];
    
    const prices = { email_each: 2 }; // 0.02 EUR
    
    const result = calculateApiCost(apiUsage, prices);
    assert.strictEqual(result.totalCents, 2 * 2000 * 12);
  });
});

describe('calculateLicenseCost', () => {
  test('should calculate license cost', () => {
    const licenses = [
      { item: 'saas_user_month', units: 50, months: 12 }
    ];
    
    const prices = {
      saas_user_month: 1000 // 10 EUR per user per month
    };
    
    const result = calculateLicenseCost(licenses, prices);
    assert.strictEqual(result.totalCents, 1000 * 50 * 12);
  });
});

describe('buildBudget', () => {
  test('should build complete budget', () => {
    const llmOutput = {
      people: [
        { role: 'backend', days: 40 }
      ],
      infrastructure: [
        { item: 'app_server_month', units: 1, months: 12 }
      ],
      api_usage: [],
      licenses: [],
      assumptions: []
    };
    
    const catalog = {
      last_updated: '2024-10-18',
      currency: 'EUR',
      daily_rates: { backend: 600 },
      cloud: { app_server_month: 100 },
      api: {},
      licenses: {},
      support_percent_of_build: 0.15,
      contingency_percent: 0.10,
      margin_percent: 0.15,
      workdays_per_week: 5
    };
    
    const budget = buildBudget(llmOutput, catalog);
    
    assert.strictEqual(budget.people.totalCents, 600 * 100 * 40); // 24,000 EUR
    assert.strictEqual(budget.infrastructure.totalCents, 100 * 100 * 12); // 1,200 EUR
    assert.ok(budget.support.totalCents > 0);
    assert.ok(budget.contingency.totalCents > 0);
    assert.ok(budget.margin.totalCents > 0);
    assert.strictEqual(budget.catalogDate, '2024-10-18');
  });
  
  test('should handle zero prices', () => {
    const llmOutput = {
      people: [{ role: 'backend', days: 40 }],
      infrastructure: [],
      api_usage: [],
      licenses: []
    };
    
    const catalog = {
      last_updated: '2024-10-18',
      currency: 'EUR',
      daily_rates: { backend: 0 },
      cloud: {},
      api: {},
      licenses: {},
      support_percent_of_build: 0.15,
      contingency_percent: 0.10,
      margin_percent: 0.15,
      workdays_per_week: 5
    };
    
    const budget = buildBudget(llmOutput, catalog);
    assert.strictEqual(budget.people.totalCents, 0);
    assert.strictEqual(budget.oneTimeTotalCents, 0);
  });
});

describe('checkPlanConsistency', () => {
  test('should pass when consistent', () => {
    const plan = [
      {
        phase: 'Phase 1',
        weeks: 4,
        roles: [
          { role: 'backend', people: 2 }
        ]
      }
    ];
    
    const llmPeople = [
      { role: 'backend', days: 40 } // 4 weeks * 2 people * 5 days
    ];
    
    const result = checkPlanConsistency(plan, llmPeople, 5);
    assert.strictEqual(result.consistent, true);
    assert.strictEqual(result.errors.length, 0);
  });
  
  test('should fail when inconsistent (>15% diff)', () => {
    const plan = [
      {
        phase: 'Phase 1',
        weeks: 4,
        roles: [
          { role: 'backend', people: 2 }
        ]
      }
    ];
    
    const llmPeople = [
      { role: 'backend', days: 60 } // Expected 40, got 60 (50% diff)
    ];
    
    const result = checkPlanConsistency(plan, llmPeople, 5);
    assert.strictEqual(result.consistent, false);
    assert.strictEqual(result.errors.length, 1);
    assert.strictEqual(result.errors[0].role, 'backend');
    assert.strictEqual(result.errors[0].expected, 40);
    assert.strictEqual(result.errors[0].actual, 60);
  });
  
  test('should pass within 15% tolerance', () => {
    const plan = [
      {
        phase: 'Phase 1',
        weeks: 4,
        roles: [
          { role: 'backend', people: 2 }
        ]
      }
    ];
    
    const llmPeople = [
      { role: 'backend', days: 44 } // Expected 40, got 44 (10% diff, OK)
    ];
    
    const result = checkPlanConsistency(plan, llmPeople, 5);
    assert.strictEqual(result.consistent, true);
  });
});

describe('buildBudgetTableRows', () => {
  test('should build table rows', () => {
    const budget = {
      people: {
        totalCents: 2400000,
        items: [
          { role: 'backend', days: 40, rateCents: 60000, totalCents: 2400000 }
        ]
      },
      infrastructure: { totalCents: 0, items: [] },
      apiUsage: { totalCents: 0, items: [] },
      licenses: { totalCents: 0, items: [] },
      support: { percent: 0.15, totalCents: 360000 },
      contingency: { percent: 0.10, totalCents: 240000 },
      margin: { percent: 0.15, totalCents: 360000 },
      currency: 'EUR'
    };
    
    const rows = buildBudgetTableRows(budget, 'fr', 8);
    
    assert.ok(rows.length > 0);
    assert.ok(rows[0][0].includes('Backend'));
    assert.ok(rows[0][1].includes('40'));
    assert.ok(rows[0][2].includes('600'));
  });
  
  test('should show placeholders for zero prices', () => {
    const budget = {
      people: {
        totalCents: 0,
        items: [
          { role: 'backend', days: 40, rateCents: 0, totalCents: 0 }
        ]
      },
      infrastructure: { totalCents: 0, items: [] },
      apiUsage: { totalCents: 0, items: [] },
      licenses: { totalCents: 0, items: [] },
      support: { percent: 0.15, totalCents: 0 },
      currency: 'EUR'
    };
    
    const rows = buildBudgetTableRows(budget, 'fr', 8);
    
    assert.ok(rows[0][2].includes('[TO FILL'));
    assert.ok(rows[0][3].includes('[TO FILL'));
  });
  
  test('should limit rows to maxRows', () => {
    const budget = {
      people: {
        totalCents: 0,
        items: Array(10).fill(null).map((_, i) => ({
          role: `role${i}`,
          days: 10,
          rateCents: 0,
          totalCents: 0
        }))
      },
      infrastructure: { totalCents: 0, items: [] },
      apiUsage: { totalCents: 0, items: [] },
      licenses: { totalCents: 0, items: [] },
      support: { percent: 0.15, totalCents: 0 },
      currency: 'EUR'
    };
    
    const rows = buildBudgetTableRows(budget, 'fr', 5);
    assert.ok(rows.length <= 5);
  });
});
