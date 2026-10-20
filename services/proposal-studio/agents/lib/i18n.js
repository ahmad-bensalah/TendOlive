/**
 * i18n.js - Internationalization for agent output
 * 
 * Translations for French and English slide titles and labels
 */

const translations = {
  fr: {
    // Slide titles (from master prompt section 6.2)
    executive_summary: 'Synthèse exécutive',
    understanding: 'Compréhension de vos besoins',
    solution_compliance: 'Solution proposée et conformité',
    architecture_title: 'Architecture technique',
    class_diagram_title: 'Modèle de classes',
    strengths: 'Nos atouts',
    roadmap_title: 'Plan de mise en œuvre',
    team_governance: 'Équipe et gouvernance',
    references: 'Références pertinentes',
    support_sla: 'Support et SLA',
    pricing: 'Offre financière',
    risks_title: 'Risques et mitigation',
    next_steps: 'Prochaines étapes',
    
    // Table headers
    requirement: 'Exigence',
    our_response: 'Notre réponse',
    evidence: 'Preuve',
    phase: 'Phase',
    duration_weeks: 'Durée (semaines)',
    team: 'Équipe',
    risk: 'Risque',
    impact: 'Impact',
    mitigation: 'Mitigation',
    
    // Impact levels
    impact_high: 'Élevé',
    impact_medium: 'Moyen',
    impact_low: 'Faible',
    
    // Roles
    role_backend: 'Backend',
    role_frontend: 'Frontend',
    role_devops: 'DevOps',
    role_pm: 'Chef de projet',
    role_designer: 'Designer',
    role_qa: 'QA',
    
    // Labels
    total_duration: 'Durée totale',
    to_clarify: 'À préciser',
    
    // Budget
    budget_item: 'Poste',
    quantity: 'Quantité',
    unit_price: 'Prix unitaire',
    total: 'Total'
  },
  
  en: {
    // Slide titles
    executive_summary: 'Executive Summary',
    understanding: 'Understanding Your Needs',
    solution_compliance: 'Proposed Solution and Compliance',
    architecture_title: 'Technical Architecture',
    class_diagram_title: 'Class Model',
    strengths: 'Our Strengths',
    roadmap_title: 'Implementation Plan',
    team_governance: 'Team and Governance',
    references: 'Relevant References',
    support_sla: 'Support and SLA',
    pricing: 'Financial Offer',
    risks_title: 'Risks and Mitigation',
    next_steps: 'Next Steps',
    
    // Table headers
    requirement: 'Requirement',
    our_response: 'Our Response',
    evidence: 'Evidence',
    phase: 'Phase',
    duration_weeks: 'Duration (weeks)',
    team: 'Team',
    risk: 'Risk',
    impact: 'Impact',
    mitigation: 'Mitigation',
    
    // Impact levels
    impact_high: 'High',
    impact_medium: 'Medium',
    impact_low: 'Low',
    
    // Roles
    role_backend: 'Backend',
    role_frontend: 'Frontend',
    role_devops: 'DevOps',
    role_pm: 'Project Manager',
    role_designer: 'Designer',
    role_qa: 'QA',
    
    // Labels
    total_duration: 'Total duration',
    to_clarify: 'To clarify',
    
    // Budget
    budget_item: 'Item',
    quantity: 'Quantity',
    unit_price: 'Unit Price',
    total: 'Total'
  }
};

/**
 * Translates a key to the target language
 * Falls back to English if language not found
 */
function translate(key, language = 'fr') {
  const lang = translations[language] || translations.en;
  return lang[key] || translations.en[key] || key;
}

/**
 * Gets all slide titles for a language
 */
function getSlideTitles(language = 'fr') {
  const lang = translations[language] || translations.en;
  return {
    s1: lang.executive_summary,
    s2: lang.understanding,
    s3: lang.solution_compliance,
    s3b: lang.architecture_title,
    s3c: lang.class_diagram_title,
    s4: lang.strengths,
    s5: lang.roadmap_title,
    s6: lang.team_governance,
    s7: lang.references,
    s8: lang.support_sla,
    s9: lang.pricing,
    s10: lang.risks_title,
    s11: lang.next_steps
  };
}

// Export for CommonJS (n8n Code nodes) and ES modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    translate,
    getSlideTitles,
    translations
  };
}
