/**
 * agent4.js - Agent 4 (Budget) logic
 * 
 * Produces slide s9 with requiresApproval, catalogDate, assumptions
 */

const { buildBudget, checkPlanConsistency, buildBudgetTableRows } = require('./budget.js');
const i18n = require('./i18n.js');
const { buildSystemPrompt, wrapTenderData, withFeedback, makeCaller, runAgentLoop } = require('./llm.js');

/**
 * Builds ready facts for Agent 4
 */
function buildBudgetFacts(input, diagramsData) {
  const plan = diagramsData?.plan || [];
  const components = diagramsData?.components || [];
  const similarProjects = input.match?.similar_projects || [];
  
  return {
    components,
    plan,
    similarProjects,
    projectType: input.tender?.project_type || 'other'
  };
}

/**
 * Builds catalog keys list (not prices) for LLM
 */
function getCatalogKeys(catalog) {
  return {
    daily_rates: Object.keys(catalog.daily_rates),
    cloud: Object.keys(catalog.cloud),
    api: Object.keys(catalog.api),
    licenses: Object.keys(catalog.licenses)
  };
}

/**
 * Validates LLM output against catalog and rules
 */
function validateBudgetOutput(llmOutput, catalog, plan) {
  const errors = [];
  
  // Check people roles
  const validRoles = ['backend', 'frontend', 'devops', 'pm', 'designer', 'qa'];
  (llmOutput.people || []).forEach((p, i) => {
    const role = p.role?.toLowerCase();
    if (!validRoles.includes(role)) {
      errors.push(`people[${i}].role "${p.role}" invalid. Must be one of: ${validRoles.join(', ')}`);
    }
    if (!Number.isInteger(p.days) || p.days < 1) {
      errors.push(`people[${i}].days must be positive integer, got ${p.days}`);
    }
  });
  
  // Check infrastructure items exist in catalog
  (llmOutput.infrastructure || []).forEach((infra, i) => {
    if (!Object.prototype.hasOwnProperty.call(catalog.cloud, infra.item)) {
      errors.push(`infrastructure[${i}].item "${infra.item}" not in catalog. Available: ${Object.keys(catalog.cloud).join(', ')}`);
    }
    if (!Number.isInteger(infra.units) || infra.units < 1) {
      errors.push(`infrastructure[${i}].units must be positive integer`);
    }
    if (!Number.isInteger(infra.months) || infra.months < 1) {
      errors.push(`infrastructure[${i}].months must be positive integer`);
    }
  });
  
  // Check license items exist in catalog
  (llmOutput.licenses || []).forEach((lic, i) => {
    if (!Object.prototype.hasOwnProperty.call(catalog.licenses, lic.item)) {
      errors.push(`licenses[${i}].item "${lic.item}" not in catalog. Available: ${Object.keys(catalog.licenses).join(', ')}`);
    }
    if (!Number.isInteger(lic.units) || lic.units < 1) {
      errors.push(`licenses[${i}].units must be positive integer`);
    }
    if (!Number.isInteger(lic.months) || lic.months < 1) {
      errors.push(`licenses[${i}].months must be positive integer`);
    }
  });
  
  // Check API usage
  (llmOutput.api_usage || []).forEach((api, i) => {
    if (!Number.isInteger(api.requests_per_month) || api.requests_per_month < 0) {
      errors.push(`api_usage[${i}].requests_per_month must be non-negative integer`);
    }
    if (!Number.isInteger(api.months) || api.months < 1) {
      errors.push(`api_usage[${i}].months must be positive integer`);
    }
  });
  
  // Plan consistency check
  if (plan && plan.length > 0) {
    const consistency = checkPlanConsistency(plan, llmOutput.people || [], catalog.workdays_per_week);
    if (!consistency.consistent) {
      consistency.errors.forEach(err => {
        errors.push(`Plan mismatch for ${err.role}: expected ${err.expected} days, got ${err.actual} days (${err.percentDiff}% diff, tolerance 15%)`);
      });
    }
  }
  
  return errors;
}

/**
 * Builds slide s9 from budget
 */
function buildBudgetSlide(budget, language = 'fr', hasRealPrices = false) {
  const blocks = [];
  
  // Build table
  const columns = [
    i18n.translate('budget_item', language),
    i18n.translate('quantity', language),
    i18n.translate('unit_price', language),
    i18n.translate('total', language)
  ];
  
  const rows = buildBudgetTableRows(budget, language, 8);
  
  blocks.push({
    kind: 'table',
    columns,
    rows
  });
  
  // Note with one-time vs recurring
  let noteText;
  if (hasRealPrices && budget.oneTimeTotalCents > 0) {
    const oneTime = require('./budget.js').formatCurrency(budget.oneTimeTotalCents, language, budget.currency);
    const recurring = require('./budget.js').formatCurrency(budget.recurringTotalCents, language, budget.currency);
    
    if (language === 'fr') {
      noteText = `Montant one-time : ${oneTime}. Coûts récurrents : ${recurring}/an.`;
    } else {
      noteText = `One-time amount: ${oneTime}. Recurring costs: ${recurring}/year.`;
    }
  } else {
    if (language === 'fr') {
      noteText = 'Montant one-time : [TO FILL: total]. Coûts récurrents : [TO FILL: total]/an.';
    } else {
      noteText = 'One-time amount: [TO FILL: total]. Recurring costs: [TO FILL: total]/year.';
    }
  }
  
  blocks.push({
    kind: 'note',
    text: noteText
  });
  
  // Build assumptions
  const assumptions = [];
  assumptions.push(
    language === 'fr'
      ? `Catalogue de prix du ${budget.catalogDate}`
      : `Price catalog dated ${budget.catalogDate}`
  );
  assumptions.push(
    language === 'fr'
      ? 'Jours ouvrés par semaine : 5'
      : 'Working days per week: 5'
  );
  
  const slide = {
    id: 's9',
    type: 'content',
    title: i18n.translate('pricing', language),
    blocks,
    requiresApproval: true,
    assumptions,
    catalogDate: budget.catalogDate
  };
  
  return slide;
}

/**
 * Checks if catalog has all zero prices
 */
function hasZeroPrices(catalog) {
  const allRates = Object.values(catalog.daily_rates).concat(
    Object.values(catalog.cloud),
    Object.values(catalog.api),
    Object.values(catalog.licenses)
  );
  
  return allRates.every(price => price === 0);
}

/**
 * Executes Agent 4 (mock mode for now)
 */
function executeAgent4(input, diagramsData, catalog, options = {}) {
  const { mode = 'mock', fixtures = {} } = options;
  const language = input.tender?.language || 'fr';
  
  if (mode === 'mock') {
    // Return fixture or placeholder
    const inputId = input.tender?.id || 'unknown';
    const fixture = fixtures[inputId];
    
    if (fixture) {
      return fixture;
    }
    
    // Generate placeholder
    const warnings = [];
    if (hasZeroPrices(catalog)) {
      warnings.push('Catalog prices not yet loaded - all prices shown as [TO FILL]');
    }
    
    const llmOutput = {
      people: [
        { role: 'backend', days: 40 },
        { role: 'frontend', days: 30 }
      ],
      infrastructure: [],
      api_usage: [],
      licenses: [],
      assumptions: [
        language === 'fr'
          ? `Catalogue de prix du ${catalog.last_updated}`
          : `Price catalog dated ${catalog.last_updated}`,
        language === 'fr'
          ? 'Jours ouvrés par semaine : 5'
          : 'Working days per week: 5'
      ]
    };
    
    const budget = buildBudget(llmOutput, catalog);
    const slide = buildBudgetSlide(budget, language, !hasZeroPrices(catalog));
    
    return {
      agent: 'budget',
      ok: true,
      slides: [slide],
      data: llmOutput,
      assumptions: llmOutput.assumptions,
      warnings,
      usage: { model: 'mock', promptTokens: 0, completionTokens: 0, ms: 0, attempts: 1 }
    };
  }
  
  return executeAgent4Real(input, diagramsData, catalog, options);
}

const AGENT4_PROMPT = `You are Agent 4 (budget). Choose WHAT is needed and HOW MUCH, never prices.
People-days are computed by code from the plan; you do not output them.

Return exactly this JSON:
{
  "infrastructure": [ { "item": "a key from catalog_keys.cloud", "units": 1, "months": 12 } ],
  "api_usage": [ { "item": "a key from catalog_keys.api", "requests_per_month": 1000, "input_tokens": 0, "output_tokens": 0, "months": 12 } ],
  "licenses": [ { "item": "a key from catalog_keys.licenses", "units": 1, "months": 12 } ],
  "assumptions": ["one line per volume you chose, explaining why"]
}
Use only catalog keys. All quantities are whole numbers. Empty arrays are fine when nothing is needed.`;

/** People-days per role derived from the plan: sum(weeks x people) x workdays per week. */
function derivePeopleDays(plan, workdaysPerWeek = 5) {
  const days = {};
  (plan || []).forEach(ph => (ph.roles || []).forEach(r => {
    const role = String(r.role || '').toLowerCase();
    days[role] = (days[role] || 0) + (ph.weeks || 0) * (r.people || 0) * workdaysPerWeek;
  }));
  return Object.entries(days).filter(([, d]) => d > 0).map(([role, d]) => ({ role, days: d }));
}

async function executeAgent4Real(input, diagramsData, catalog, options = {}) {
  const call = makeCaller(options);
  const language = input.tender?.language || 'fr';
  const fr = language === 'fr';
  const facts = buildBudgetFacts(input, diagramsData);
  const people = derivePeopleDays(facts.plan, catalog.workdays_per_week || 5);
  
  // Check for budget scenarios
  const competitive = require('./competitive.js');
  const scenariosData = competitive.buildBudgetScenarios(input, catalog, language);
  
  const system = buildSystemPrompt(AGENT4_PROMPT);
  const user = `Choose the budget quantities for this tender.\n${wrapTenderData({
    tender: { title: input.tender?.title, requirements: input.tender?.requirements, project_type: facts.projectType },
    components: facts.components, plan: facts.plan, people_days_computed_by_code: people,
    similar_projects: facts.similarProjects.map(p => ({ duration_months: p.duration_months, team_size: p.team_size })),
    catalog_keys: getCatalogKeys(catalog) })}`;

  const loop = await runAgentLoop({
    call, maxAttempts: options.maxAttempts || 3, initialViolations: options.feedback,
    build: (v) => ({ system, user: withFeedback(user, v), temperature: 0.2, maxTokens: 1500 }),
    validate: (json) => {
      const v = validateBudgetOutput({ ...json, people }, catalog, facts.plan);
      (json.api_usage || []).forEach((a, i) => {
        if (!Object.prototype.hasOwnProperty.call(catalog.api, a.item)) v.push(`api_usage[${i}].item "${a.item}" not in catalog`);
      });
      return v;
    }
  });

  const chosen = loop.ok ? loop.json : { infrastructure: [], api_usage: [], licenses: [], assumptions: [] };
  const llmOutput = {
    people,
    infrastructure: chosen.infrastructure || [],
    api_usage: chosen.api_usage || [],
    licenses: chosen.licenses || [],
    assumptions: [
      ...(chosen.assumptions || []).filter(a => typeof a === 'string'),
      fr ? `Catalogue de prix du ${catalog.last_updated}` : `Price catalog dated ${catalog.last_updated}`,
      fr ? `Jours ouvrés par semaine : ${catalog.workdays_per_week || 5}` : `Working days per week: ${catalog.workdays_per_week || 5}`,
      fr ? 'Jours-homme calculés par le code à partir du plan' : 'People-days computed by code from the plan'
    ]
  };
  
  // Add budget scenarios to assumptions if they exist
  if (scenariosData.hasScenarios) {
    llmOutput.warnings = [...(llmOutput.warnings || []), ...scenariosData.warnings];
    scenariosData.scenarios.forEach(s => {
      const formatted = require('./budget.js').formatCurrency(s.targetAmount, language, scenariosData.currency);
      llmOutput.assumptions.push(fr
        ? `Scénario ${s.name} : ${formatted} (${s.description})`
        : `${s.name} scenario: ${formatted} (${s.description})`);
    });
  }
  
  const warnings = llmOutput.warnings || [];
  if (hasZeroPrices(catalog)) warnings.push('Catalog prices not yet loaded - all prices shown as [TO FILL]');
  if (catalog.status === 'estimate') {
    // Rates not confirmed by OliveSoft: visible on the slide (Review panel) and in the assumptions
    const note = fr ? 'Tarifs estimés, à confirmer par OliveSoft avant envoi au client'
                    : 'Estimated rates, to be confirmed by OliveSoft before sending to the client';
    warnings.push(note);
    llmOutput.assumptions.push(note);
  }
  if (!people.length) warnings.push(fr ? 'Plan sans rôles : jours-homme à compléter' : 'Plan has no roles: people-days to fill');
  if (!loop.ok) warnings.push(`Agent 4 : ${loop.error || loop.violations.slice(0, 3).join('; ')} (seuls les jours-homme sont chiffrés)`);

  const budget = buildBudget(llmOutput, catalog);
  const slide = buildBudgetSlide(budget, language, !hasZeroPrices(catalog));
  slide.assumptions = [...new Set([...(slide.assumptions || []), ...llmOutput.assumptions])];
  if (catalog.status === 'estimate') slide.warnings = [...(slide.warnings || []), warnings[warnings.length - 1]];
  return {
    agent: 'budget',
    ok: loop.ok,
    slides: [slide],
    data: llmOutput,
    assumptions: llmOutput.assumptions,
    warnings,
    usage: { model: loop.model, promptTokens: loop.usage.promptTokens, completionTokens: loop.usage.completionTokens,
             ms: loop.ms, attempts: loop.attempts, rateLimitWaits: loop.rateLimitWaits }
  };
}

// Export for CommonJS (n8n Code nodes) and ES modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildBudgetFacts,
    getCatalogKeys,
    validateBudgetOutput,
    buildBudgetSlide,
    hasZeroPrices,
    executeAgent4,
    executeAgent4Real,
    derivePeopleDays
  };
}
