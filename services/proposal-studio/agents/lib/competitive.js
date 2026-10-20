/**
 * competitive.js - Budget scenarios and competitive positioning slide (s12).
 *
 * Budget scenarios: when the input provides competition.budget_estimate with low/mid/high,
 * Agent 4 proposes three scenarios: Basic (low budget), Recommended (mid), Premium (high).
 * The deck shows the Recommended scenario by default; the other two are kept in assumptions.
 *
 * Competitive positioning slide (s12): ONLY when competition.positioning and competitors exist.
 * Shows: declared budget, estimated range, past winners, median bid count, positioning advice.
 *
 * This is Phase B: budget range (three scenarios) and competitive positioning, only when
 * research data exists.
 */

/**
 * Returns { hasScenarios, scenarios: [{ name, description, budget }], warnings }
 * where budget = { one_time, recurring, total } in cents.
 * scenarios = [] when no range data exists.
 */
function buildBudgetScenarios(input, catalog, language) {
  const fr = language !== 'en';
  const comp = input.competition || {};
  const est = comp.budget_estimate || {};
  
  if (!est.low || !est.mid || !est.high || !est.currency) {
    return { hasScenarios: false, scenarios: [], warnings: [] };
  }

  const warnings = [];
  if (est.confidence !== 'high') {
    warnings.push(fr 
      ? `Estimation budgétaire avec confiance ${est.confidence || 'inconnue'} (${est.comparables || 0} comparables)`
      : `Budget estimate with ${est.confidence || 'unknown'} confidence (${est.comparables || 0} comparables)`);
  }

  const scenarios = [
    {
      name: fr ? 'Basique' : 'Basic',
      description: fr 
        ? 'Configuration minimale, fonctionnalités essentielles'
        : 'Minimal configuration, essential features',
      targetAmount: Math.round(est.low * 100), // cents
      multiplier: est.low / est.mid
    },
    {
      name: fr ? 'Recommandée' : 'Recommended',
      description: fr
        ? 'Configuration standard, couvre tous les requis avec qualité'
        : 'Standard configuration, covers all requirements with quality',
      targetAmount: Math.round(est.mid * 100),
      multiplier: 1
    },
    {
      name: fr ? 'Premium' : 'Premium', 
      description: fr
        ? 'Configuration avancée, fonctionnalités étendues et support renforcé'
        : 'Advanced configuration, extended features and enhanced support',
      targetAmount: Math.round(est.high * 100),
      multiplier: est.high / est.mid
    }
  ];

  return { hasScenarios: true, scenarios, currency: est.currency, warnings };
}

/**
 * Competitive positioning slide (s12). Returns null if no competition data.
 * Fields: title, blocks (bullets for positioning + table of competitors), notes, warnings
 */
function buildCompetitiveSlide(input, language) {
  const fr = language !== 'en';
  const comp = input.competition || {};
  
  // Need at least positioning OR competitors
  if (!comp.positioning && (!comp.competitors || comp.competitors.length === 0)) {
    return null;
  }

  const blocks = [];
  const warnings = [];
  const notes = [];

  // Budget context
  if (comp.declared_value || comp.budget_estimate) {
    const items = [];
    if (comp.declared_value) {
      items.push(fr 
        ? `Budget déclaré : ${comp.declared_value}`
        : `Declared budget: ${comp.declared_value}`);
    }
    if (comp.budget_estimate && comp.budget_estimate.mid) {
      const est = comp.budget_estimate;
      items.push(fr
        ? `Fourchette estimée : ${est.low} - ${est.high} ${est.currency || ''} (médiane : ${est.mid})`
        : `Estimated range: ${est.low} - ${est.high} ${est.currency || ''} (median: ${est.mid})`);
    }
    if (comp.median_bids) {
      items.push(fr
        ? `Nombre médian de soumissionnaires : ${comp.median_bids}`
        : `Median number of bidders: ${comp.median_bids}`);
    }
    if (items.length) blocks.push({ kind: 'bullets', items });
  }

  // Positioning advice
  if (comp.positioning) {
    blocks.push({
      kind: 'text',
      text: comp.positioning
    });
  }

  // Competitors table (past wins/losses)
  const competitors = (comp.competitors || []).filter(c => c.name);
  if (competitors.length > 0) {
    const topCompetitors = competitors
      .sort((a, b) => (b.past_wins || 0) - (a.past_wins || 0))
      .slice(0, 8);
    
    blocks.push({
      kind: 'table',
      columns: fr
        ? ['Concurrent', 'Victoires', 'Dernière victoire', 'Montant moyen']
        : ['Competitor', 'Wins', 'Last win', 'Average amount'],
      rows: topCompetitors.map(c => [
        c.name,
        String(c.past_wins || 0),
        c.last_win || (fr ? 'Aucune' : 'None'),
        c.avg_amount ? `${c.avg_amount} ${comp.budget_estimate?.currency || ''}` : (fr ? 'N/A' : 'N/A')
      ])
    });
  }

  // Comparables info in notes
  if (comp.comparables && comp.comparables.length > 0) {
    const titles = comp.comparables.slice(0, 3).map(c => c.title || 'Untitled').join('; ');
    notes.push(fr
      ? `Contrats comparables : ${titles}`
      : `Comparable contracts: ${titles}`);
  }

  if (comp.budget_comment) {
    notes.push(comp.budget_comment);
  }

  return {
    id: 's12',
    type: 'content',
    title: fr ? 'Contexte concurrentiel' : 'Competitive Context',
    blocks,
    notes: notes.join('\n\n') || undefined,
    warnings: warnings.length ? warnings : undefined
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildBudgetScenarios, buildCompetitiveSlide };
}
