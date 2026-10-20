/**
 * budget.js - Budget calculator (works in integer cents, no floats)
 * 
 * Principle: LLM chooses what and how much, code calculates the money.
 * The LLM never sees or outputs prices.
 */

/**
 * Converts euros to cents (integer)
 */
function eurosToCents(euros) {
  if (typeof euros !== 'number' || !isFinite(euros)) {
    return 0;
  }
  return Math.round(euros * 100);
}

/**
 * Converts cents to euros (for display only, returns number)
 */
function centsToEuros(cents) {
  if (typeof cents !== 'number' || !isFinite(cents)) {
    return 0;
  }
  return cents / 100;
}

/**
 * Formats cents as currency string for a language
 */
function formatCurrency(cents, language = 'fr', currency = 'EUR') {
  const euros = centsToEuros(cents);
  
  if (language === 'fr') {
    // French: 12 345,50 €
    const formatted = euros.toFixed(2)
      .replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
      .replace('.', ',');
    return `${formatted} ${currency}`;
  } else {
    // English: €12,345.50
    const formatted = euros.toFixed(2)
      .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${currency}${formatted}`;
  }
}

/**
 * Calculates people cost (one-time)
 * 
 * @param {Array} people - [{ role, days }]
 * @param {Object} rates - { backend: cents, frontend: cents, ... }
 * @returns {Object} - { totalCents, items: [{ role, days, rateCents, totalCents }] }
 */
function calculatePeopleCost(people, rates) {
  const items = [];
  let totalCents = 0;
  
  people.forEach(p => {
    const role = p.role?.toLowerCase();
    const days = p.days || 0;
    const rateCents = rates[role] || 0;
    const itemTotalCents = rateCents * days;
    
    items.push({
      role,
      days,
      rateCents,
      totalCents: itemTotalCents
    });
    
    totalCents += itemTotalCents;
  });
  
  return { totalCents, items };
}

/**
 * Calculates infrastructure cost (recurring)
 * 
 * @param {Array} infrastructure - [{ item, units, months }]
 * @param {Object} cloudPrices - { app_server_month: cents, ... }
 * @returns {Object} - { totalCents, items: [{ item, units, months, unitCents, totalCents }] }
 */
function calculateInfrastructureCost(infrastructure, cloudPrices) {
  const items = [];
  let totalCents = 0;
  
  infrastructure.forEach(infra => {
    const item = infra.item;
    const units = infra.units || 1;
    const months = infra.months || 12;
    const unitCents = cloudPrices[item] || 0;
    const itemTotalCents = unitCents * units * months;
    
    items.push({
      item,
      units,
      months,
      unitCents,
      totalCents: itemTotalCents
    });
    
    totalCents += itemTotalCents;
  });
  
  return { totalCents, items };
}

/**
 * Calculates API usage cost (recurring)
 * 
 * @param {Array} apiUsage - [{ item, requests_per_month, input_tokens, output_tokens, months }]
 * @param {Object} apiPrices - { llm_input_per_1m_tokens: cents, ... }
 * @returns {Object} - { totalCents, items }
 */
function calculateApiCost(apiUsage, apiPrices) {
  const items = [];
  let totalCents = 0;
  
  apiUsage.forEach(usage => {
    const item = usage.item;
    const requestsPerMonth = usage.requests_per_month || 0;
    const months = usage.months || 12;
    
    let itemTotalCents = 0;
    
    // LLM tokens
    if (usage.input_tokens && usage.output_tokens) {
      const inputCost = Math.round((usage.input_tokens / 1000000) * apiPrices.llm_input_per_1m_tokens);
      const outputCost = Math.round((usage.output_tokens / 1000000) * apiPrices.llm_output_per_1m_tokens);
      itemTotalCents = (inputCost + outputCost) * requestsPerMonth * months;
    }
    // SMS
    else if (item.includes('sms')) {
      itemTotalCents = apiPrices.sms_each * requestsPerMonth * months;
    }
    // Email
    else if (item.includes('email')) {
      itemTotalCents = apiPrices.email_each * requestsPerMonth * months;
    }
    
    items.push({
      item,
      requestsPerMonth,
      months,
      totalCents: itemTotalCents
    });
    
    totalCents += itemTotalCents;
  });
  
  return { totalCents, items };
}

/**
 * Calculates license cost (recurring)
 * 
 * @param {Array} licenses - [{ item, units, months }]
 * @param {Object} licensePrices - { example_saas_user_month: cents, ... }
 * @returns {Object} - { totalCents, items }
 */
function calculateLicenseCost(licenses, licensePrices) {
  const items = [];
  let totalCents = 0;
  
  licenses.forEach(lic => {
    const item = lic.item;
    const units = lic.units || 1;
    const months = lic.months || 12;
    const unitCents = licensePrices[item] || 0;
    const itemTotalCents = unitCents * units * months;
    
    items.push({
      item,
      units,
      months,
      unitCents,
      totalCents: itemTotalCents
    });
    
    totalCents += itemTotalCents;
  });
  
  return { totalCents, items };
}

/**
 * Builds full budget from LLM output and catalog
 * 
 * @param {Object} llmOutput - { people, infrastructure, api_usage, licenses, assumptions }
 * @param {Object} catalog - pricing catalog
 * @returns {Object} - Full budget breakdown
 */
function buildBudget(llmOutput, catalog) {
  // Convert catalog prices to cents
  const rates = {};
  Object.entries(catalog.daily_rates).forEach(([role, euros]) => {
    rates[role] = eurosToCents(euros);
  });
  
  const cloudPrices = {};
  Object.entries(catalog.cloud).forEach(([item, euros]) => {
    cloudPrices[item] = eurosToCents(euros);
  });
  
  const apiPrices = {};
  Object.entries(catalog.api).forEach(([item, euros]) => {
    apiPrices[item] = eurosToCents(euros);
  });
  
  const licensePrices = {};
  Object.entries(catalog.licenses).forEach(([item, euros]) => {
    licensePrices[item] = eurosToCents(euros);
  });
  
  // Calculate each block
  const people = calculatePeopleCost(llmOutput.people || [], rates);
  const infrastructure = calculateInfrastructureCost(llmOutput.infrastructure || [], cloudPrices);
  const apiUsage = calculateApiCost(llmOutput.api_usage || [], apiPrices);
  const licenses = calculateLicenseCost(llmOutput.licenses || [], licensePrices);
  
  // Calculate derived costs
  const buildCents = people.totalCents; // One-time build cost
  const recurringCents = infrastructure.totalCents + apiUsage.totalCents + licenses.totalCents;
  
  const supportCents = Math.round(buildCents * catalog.support_percent_of_build);
  const contingencyCents = Math.round(buildCents * catalog.contingency_percent);
  const marginCents = Math.round(buildCents * catalog.margin_percent);
  
  const oneTimeTotalCents = buildCents + supportCents + contingencyCents + marginCents;
  const grandTotalCents = oneTimeTotalCents + recurringCents;
  
  return {
    people,
    infrastructure,
    apiUsage,
    licenses,
    support: { percent: catalog.support_percent_of_build, totalCents: supportCents },
    contingency: { percent: catalog.contingency_percent, totalCents: contingencyCents },
    margin: { percent: catalog.margin_percent, totalCents: marginCents },
    oneTimeTotalCents,
    recurringTotalCents: recurringCents,
    grandTotalCents,
    catalogDate: catalog.last_updated,
    currency: catalog.currency
  };
}

/**
 * Checks if plan is consistent with people-days (within 15% tolerance)
 * 
 * @param {Array} plan - [{ phase, weeks, roles: [{ role, people }] }]
 * @param {Array} llmPeople - [{ role, days }]
 * @param {number} workdaysPerWeek - Default 5
 * @returns {Object} - { consistent, errors, expectedByRole, actualByRole }
 */
function checkPlanConsistency(plan, llmPeople, workdaysPerWeek = 5) {
  const errors = [];
  
  // Calculate expected days from plan
  const expectedByRole = {};
  plan.forEach(phase => {
    const weeks = phase.weeks || 0;
    (phase.roles || []).forEach(r => {
      const role = r.role?.toLowerCase();
      const people = r.people || 0;
      const days = weeks * people * workdaysPerWeek;
      
      expectedByRole[role] = (expectedByRole[role] || 0) + days;
    });
  });
  
  // Get actual days from LLM
  const actualByRole = {};
  llmPeople.forEach(p => {
    const role = p.role?.toLowerCase();
    actualByRole[role] = p.days || 0;
  });
  
  // Check each role (15% tolerance)
  const allRoles = new Set([...Object.keys(expectedByRole), ...Object.keys(actualByRole)]);
  
  allRoles.forEach(role => {
    const expected = expectedByRole[role] || 0;
    const actual = actualByRole[role] || 0;
    
    if (expected === 0 && actual === 0) return;
    
    const diff = Math.abs(expected - actual);
    const maxDiff = expected * 0.15; // 15% tolerance
    
    if (diff > maxDiff) {
      errors.push({
        role,
        expected,
        actual,
        diff,
        percentDiff: expected > 0 ? Math.round((diff / expected) * 100) : 999
      });
    }
  });
  
  return {
    consistent: errors.length === 0,
    errors,
    expectedByRole,
    actualByRole
  };
}

/**
 * Builds budget table rows for slide
 * 
 * @param {Object} budget - Result from buildBudget()
 * @param {string} language - 'fr' or 'en'
 * @param {number} maxRows - Max rows (default 8)
 * @returns {Array} - Table rows [[label, quantity, unitPrice, total]]
 */
function buildBudgetTableRows(budget, language = 'fr', maxRows = 8) {
  const i18n = require('./i18n.js');
  const rows = [];
  
  // People (group by role if many)
  if (budget.people.items.length > 0) {
    budget.people.items.forEach(item => {
      const roleLabel = i18n.translate(`role_${item.role}`, language);
      const quantity = `${item.days} ${language === 'fr' ? 'jours' : 'days'}`;
      const unitPrice = item.rateCents > 0 
        ? formatCurrency(item.rateCents, language, budget.currency)
        : '[TO FILL: tarif ' + item.role + ']';
      const total = item.totalCents > 0
        ? formatCurrency(item.totalCents, language, budget.currency)
        : '[TO FILL: total]';
      
      rows.push([roleLabel, quantity, unitPrice, total]);
    });
  }
  
  // Infrastructure
  if (budget.infrastructure.items.length > 0) {
    budget.infrastructure.items.forEach(item => {
      const label = item.item.replace(/_/g, ' ');
      const quantity = `${item.units} × ${item.months} ${language === 'fr' ? 'mois' : 'months'}`;
      const unitPrice = item.unitCents > 0
        ? formatCurrency(item.unitCents, language, budget.currency)
        : '[TO FILL: tarif ' + item.item + ']';
      const total = item.totalCents > 0
        ? formatCurrency(item.totalCents, language, budget.currency)
        : '[TO FILL: total]';
      
      rows.push([label, quantity, unitPrice, total]);
    });
  }
  
  // Support, Contingency, Margin
  if (budget.support.totalCents > 0 || rows.some(r => r[3] !== '[TO FILL: total]')) {
    const supportLabel = language === 'fr' ? 'Support et maintenance' : 'Support and maintenance';
    const supportPercent = `${Math.round(budget.support.percent * 100)}%`;
    const supportTotal = budget.support.totalCents > 0
      ? formatCurrency(budget.support.totalCents, language, budget.currency)
      : '[TO FILL: total]';
    rows.push([supportLabel, supportPercent, '-', supportTotal]);
  }
  
  // Limit rows
  if (rows.length > maxRows) {
    // Group small items
    rows.splice(maxRows - 1);
    const otherLabel = language === 'fr' ? 'Autres postes' : 'Other items';
    rows.push([otherLabel, '-', '-', '[TO FILL: total]']);
  }
  
  return rows;
}

// Export for CommonJS (n8n Code nodes) and ES modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
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
  };
}
