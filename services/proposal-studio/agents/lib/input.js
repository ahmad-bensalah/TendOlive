/**
 * input.js - Input normalization and injection scanning
 * 
 * Normalizes the tender/match input with defaults, truncates long text,
 * strips control characters, and scans for prompt injection attempts.
 */

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|above)/i,
  /system\s+prompt/i,
  /reveal/i,
  /you\s+are\s+now/i,
  /disregard/i,
  /jailbreak/i,
  /base64/i,
  /<script/i,
  /javascript:/i,
  /onclick=/i,
  /onerror=/i,
  /onload=/i
];

// Adversarial injection claims from tests/inputs/injection.json
const INJECTION_CLAIMS = [
  '50 awards',
  'number one',
  'best in the world',
  'guaranteed success',
  'award-winning'
];

/**
 * Strips control characters and excessive whitespace
 */
function cleanText(text) {
  if (typeof text !== 'string') return text;
  
  // Remove control characters except newlines and tabs
  let cleaned = text.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');
  
  // Normalize whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  
  return cleaned;
}

/**
 * Scans text for injection patterns
 */
function scanForInjection(text, fieldPath = '') {
  const warnings = [];
  
  if (typeof text !== 'string' || !text) return warnings;
  
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      warnings.push(`${fieldPath}: suspicious pattern detected (${pattern.source})`);
    }
  }
  
  // Check for adversarial claims
  const lowerText = text.toLowerCase();
  for (const claim of INJECTION_CLAIMS) {
    if (lowerText.includes(claim.toLowerCase())) {
      warnings.push(`${fieldPath}: contains injection test claim "${claim}"`);
    }
  }
  
  return warnings;
}

/**
 * Recursively scans all text fields in an object
 */
function scanObject(obj, path = 'input') {
  const warnings = [];
  
  if (typeof obj !== 'object' || obj === null) {
    return warnings;
  }
  
  if (Array.isArray(obj)) {
    obj.forEach((item, idx) => {
      warnings.push(...scanObject(item, `${path}[${idx}]`));
    });
    return warnings;
  }
  
  for (const [key, value] of Object.entries(obj)) {
    const fieldPath = `${path}.${key}`;
    
    if (typeof value === 'string') {
      warnings.push(...scanForInjection(value, fieldPath));
    } else if (typeof value === 'object' && value !== null) {
      warnings.push(...scanObject(value, fieldPath));
    }
  }
  
  return warnings;
}

/**
 * Normalizes input with defaults and validation
 * Handles both old format (tender/match) and new format (matrix/rag/competition)
 * @param {object} rawInput - The raw input (matrix-based or legacy)
 * @returns {{ input: object, input_warnings: string[], suspicious_fields: string[] }}
 */
function normalizeInput(rawInput) {
  const input_warnings = [];
  const suspicious_fields = [];
  
  if (!rawInput || typeof rawInput !== 'object') {
    return {
      input: { tender: {}, match: {}, theme: {}, matrix: null, rag: null, competition: null },
      input_warnings: ['No input provided'],
      suspicious_fields: []
    };
  }
  
  // Scan for injection attempts first
  const injectionWarnings = scanObject(rawInput);
  if (injectionWarnings.length > 0) {
    input_warnings.push(`Injection scan: ${injectionWarnings.length} suspicious patterns found`);
    suspicious_fields.push(...injectionWarnings);
  }
  
  // Detect format: new format has 'matrix' and 'analysis', old has 'tender.requirements'
  const isNewFormat = rawInput.matrix || rawInput.analysis;
  
  if (isNewFormat) {
    return normalizeNewFormat(rawInput, input_warnings, suspicious_fields);
  } else {
    return normalizeLegacyFormat(rawInput, input_warnings, suspicious_fields);
  }
}

/**
 * Normalizes the NEW matrix-based format (your production format)
 */
function normalizeNewFormat(rawInput, input_warnings, suspicious_fields) {
  const rawTender = rawInput.tender || {};
  const rawAnalysis = rawInput.analysis || {};
  const rawBuyer = rawInput.buyer_profile || {};
  const rawMatrix = rawInput.matrix || {};
  const rawRag = rawInput.rag || {};
  const rawCompetition = rawInput.competition || {};
  const rawOptions = rawInput.options || {};
  const rawCompany = rawInput.company || {};

  const tender = {
    id: safeId(rawInput.tender_id || rawTender.reference || ''),
    title: cleanText(rawTender.title) || '',
    client: cleanText(rawBuyer.legal_name || rawBuyer.name || rawTender.issuer) || '',
    language: rawInput.language || rawTender.language || 'fr',
    deadline: rawTender.deadline || '',
    days_to_deadline: rawTender.days_to_deadline || 0,
    project_type: projectTypeFromAnalysis(rawAnalysis) || inferProjectType(rawTender, rawAnalysis, rawMatrix),
    requirements: extractRequirements(rawAnalysis, rawMatrix),
    raw_text_excerpt: buildExcerpt(rawTender, rawAnalysis, rawBuyer),
    reference: cleanText(rawTender.reference) || '',
    estimated_value: cleanText(rawTender.estimated_value) || '',
    duration: cleanText(rawTender.duration || rawAnalysis.requirements?.timeline) || '',
    award_criteria: (rawTender.award_criteria || []).map(cleanText).filter(Boolean)
  };

  const score = typeof rawAnalysis.relevance_score === 'number' ? rawAnalysis.relevance_score
    : (typeof rawMatrix.summary?.fit_score === 'number' ? rawMatrix.summary.fit_score : 0);
  const engineers = extractEngineers(rawMatrix, rawRag);
  const match = {
    score: score > 1 ? score / 100 : score,
    similar_projects: extractProjectsFromMatrix(rawMatrix, rawRag),
    why_us: extractWhyUs(rawAnalysis, rawMatrix),
    certifications: extractCertifications(rawMatrix, rawRag),
    engineers,
    requirement_coverage: extractCoverage(rawMatrix)
  };

  // Nothing is invented: missing facts stay empty and the agents write [TO FILL: ...]
  if (match.similar_projects.length === 0) input_warnings.push('No similar projects found in matrix evidence or RAG assets');
  if (tender.requirements.length === 0) input_warnings.push('No requirements extracted from analysis/matrix');
  if (match.certifications.list.length === 0) input_warnings.push('No certifications found in the evidence');
  if (engineers.profiles.length === 0) input_warnings.push('No team profiles found in the evidence');
  if (!tender.id) input_warnings.push('No tender id (tender_id or tender.reference)');

  const normalized = {
    tender,
    match,
    theme: { primary: '#1F4E79', secondary: '#3b82f6' },
    template: typeof rawOptions.template_id === 'string' ? rawOptions.template_id : (rawInput.template || null),
    research: researchFromCompetition(rawCompetition, rawAnalysis),
    company: {
      name: cleanText(rawCompany.name) || '',
      services: (rawCompany.services || []).map(cleanText).filter(Boolean),
      technologies: (rawCompany.technologies || []).map(cleanText).filter(Boolean)
    },
    matrix: rawMatrix,
    rag: rawRag,
    competition: rawCompetition,
    buyer_profile: rawBuyer,
    analysis: rawAnalysis,
    options: rawOptions
  };
  ['runId', 'params'].forEach(k => { if (rawInput[k] !== undefined) normalized[k] = rawInput[k]; });

  return { input: normalized, input_warnings, suspicious_fields };
}

function safeId(id) {
  return String(id || '').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
}

/** analysis.tender_type of the v2 contract ("software_build", "saas", ...) */
function projectTypeFromAnalysis(analysis) {
  const t = String(analysis.tender_type || '').toLowerCase();
  if (!t) return null;
  if (t.includes('saas')) return 'saas';
  if (t.includes('software') || t.includes('platform') || t.includes('app')) return 'software';
  return 'other';
}

/** "Project_MinistryInterior_LicensingPortal.md" -> "Ministry Interior Licensing Portal" */
function assetName(assetId) {
  return String(assetId || '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/^(project|proj|cv|techstack|stack)[_-]/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** All evidence items and RAG assets, keyed by asset id (first title / metadata wins). */
function collectAssets(matrix, rag) {
  const assets = new Map();
  const add = (a) => {
    if (!a || !a.asset_id) return;
    const prev = assets.get(a.asset_id) || {};
    assets.set(a.asset_id, {
      asset_id: a.asset_id,
      asset_type: a.asset_type || prev.asset_type || '',
      title: prev.title || cleanText(a.title) || '',
      snippets: [...(prev.snippets || []), ...(a.snippet ? [cleanText(a.snippet)] : [])],
      metadata: prev.metadata || a.metadata || null
    });
  };
  (matrix.rows || []).forEach(row => (row.evidence || []).forEach(add));
  (rag.assets || []).forEach(add);
  return assets;
}

/**
 * Normalizes the LEGACY simplified format (from test inputs)
 */
function normalizeLegacyFormat(rawInput, input_warnings, suspicious_fields) {
  const rawTender = rawInput.tender || {};
  const tender = {
    id: rawTender.id || '',
    title: cleanText(rawTender.title) || '',
    client: cleanText(rawTender.client) || '',
    language: rawTender.language || 'fr',
    deadline: rawTender.deadline || '',
    days_to_deadline: 0,
    project_type: rawTender.project_type || 'other',
    requirements: Array.isArray(rawTender.requirements) 
      ? rawTender.requirements.map(r => cleanText(r)).filter(Boolean)
      : [],
    raw_text_excerpt: ''
  };
  
  // Truncate raw_text_excerpt to 4000 chars
  if (rawTender.raw_text_excerpt) {
    const cleaned = cleanText(rawTender.raw_text_excerpt);
    tender.raw_text_excerpt = cleaned.substring(0, 4000);
    if (cleaned.length > 4000) {
      input_warnings.push('raw_text_excerpt truncated to 4000 characters');
    }
  }
  
  // Validate and normalize language
  if (!['fr', 'en', 'es', 'de', 'it', 'pt', 'nl'].includes(tender.language)) {
    input_warnings.push(`Unusual language "${tender.language}", falling back to English if translation unavailable`);
  }
  
  // Validate project_type
  if (!['software', 'saas', 'other'].includes(tender.project_type)) {
    tender.project_type = 'other';
    input_warnings.push(`Invalid project_type, defaulted to "other"`);
  }
  
  if (tender.requirements.length === 0) {
    input_warnings.push('No requirements provided');
  }
  
  // Normalize match
  const rawMatch = rawInput.match || {};
  const match = {
    score: typeof rawMatch.score === 'number' ? rawMatch.score : 0,
    similar_projects: [],
    why_us: [],
    certifications: {
      matching: 0,
      list: []
    },
    engineers: {
      specialized: 0,
      profiles: []
    }
  };
  
  // Similar projects
  if (Array.isArray(rawMatch.similar_projects)) {
    match.similar_projects = rawMatch.similar_projects.map(p => ({
      name: cleanText(p.name) || '',
      client: cleanText(p.client) || '',
      year: typeof p.year === 'number' ? p.year : 0,
      result: cleanText(p.result) || '',
      stack: Array.isArray(p.stack) ? p.stack.map(s => cleanText(s)).filter(Boolean) : [],
      duration_months: typeof p.duration_months === 'number' ? p.duration_months : 0,
      team_size: typeof p.team_size === 'number' ? p.team_size : 0
    })).filter(p => p.name); // Keep only projects with names
  }
  
  if (match.similar_projects.length === 0) {
    input_warnings.push('No similar projects provided');
  }
  
  // Why us
  if (Array.isArray(rawMatch.why_us)) {
    match.why_us = rawMatch.why_us.map(w => cleanText(w)).filter(Boolean);
  }
  
  // Certifications
  if (rawMatch.certifications) {
    match.certifications.matching = typeof rawMatch.certifications.matching === 'number' 
      ? rawMatch.certifications.matching 
      : 0;
    
    if (Array.isArray(rawMatch.certifications.list)) {
      match.certifications.list = rawMatch.certifications.list.map(c => cleanText(c)).filter(Boolean);
    }
  }
  
  // Engineers
  if (rawMatch.engineers) {
    match.engineers.specialized = typeof rawMatch.engineers.specialized === 'number'
      ? rawMatch.engineers.specialized
      : 0;
    
    if (Array.isArray(rawMatch.engineers.profiles)) {
      const validRoles = new Set(['Backend', 'Frontend', 'DevOps', 'PM', 'Designer', 'QA']);
      match.engineers.profiles = rawMatch.engineers.profiles
        .filter(p => validRoles.has(p.role))
        .map(p => ({
          role: p.role,
          count: typeof p.count === 'number' ? p.count : 0
        }))
        .filter(p => p.count > 0);
    }
  }
  
  // Normalize theme
  const rawTheme = rawInput.theme || {};
  const theme = {};
  
  const allowedThemeKeys = ['primary', 'secondary', 'background', 'fontHeading', 'fontBody'];
  for (const key of allowedThemeKeys) {
    if (rawTheme[key]) {
      theme[key] = String(rawTheme[key]);
    }
  }
  
  // Default primary color if missing
  if (!theme.primary) {
    theme.primary = '#1F4E79';
  }
  
  const normalized = { tender, match, theme };
  
  return {
    input: normalized,
    input_warnings,
    suspicious_fields
  };
}

/**
 * Infers project type from tender and analysis data
 */
function inferProjectType(tender, analysis, matrix) {
  const title = String(tender.title || '').toLowerCase();
  // cpv is a string in older inputs and a list of codes in the v2 contract
  const cpvList = Array.isArray(tender.cpv) ? tender.cpv.map(String) : [String(tender.cpv || '')];
  const cpv = cpvList.join(' ').toLowerCase();
  const softwareCpv = cpvList.some(c => /^72[0-9]/.test(c) || /^48[0-9]/.test(c));

  if (title.includes('application') || title.includes('plateforme') ||
      title.includes('portail') || title.includes('logiciel') || title.includes('platform') ||
      cpv.includes('logiciel') || cpv.includes('application') || softwareCpv) {
    if (title.includes('saas')) return 'saas';
    return 'software';
  }
  if (matrix && Array.isArray(matrix.rows)) {
    const hasSoftware = matrix.rows.filter(r => r.category === 'technical').some(r => {
      const req = String(r.requirement || '').toLowerCase();
      return req.includes('api') || req.includes('application') || req.includes('développement');
    });
    if (hasSoftware) return 'software';
  }
  return 'other';
}

/**
 * Extracts requirements from analysis and matrix
 */
function extractRequirements(analysis, matrix) {
  // The matrix rows are the reference list (one row per requirement, with ids and coverage);
  // analysis.requirements is used only when there is no matrix
  // (v2 repeats the same requirements in both, so a complete matrix is used alone; a shorter
  // matrix is completed with the analysis list)
  const fromMatrix = matrix && Array.isArray(matrix.rows) ? matrix.rows.map(r => r.requirement || r.skill).filter(Boolean) : [];
  const fromAnalysis = [];
  if (analysis && analysis.requirements) {
    for (const category in analysis.requirements) {
      const reqs = analysis.requirements[category];
      if (Array.isArray(reqs)) fromAnalysis.push(...reqs);
    }
  }
  const requirements = fromMatrix.length >= fromAnalysis.length ? fromMatrix : [...fromMatrix, ...fromAnalysis];
  const seen = new Set();
  return requirements.map(r => cleanText(String(r))).filter(r => r && !seen.has(r) && seen.add(r));
}

/**
 * Builds excerpt from various sources
 */
function buildExcerpt(tender, analysis, buyer) {
  const parts = [];
  
  if (buyer.organization_description) {
    parts.push(cleanText(buyer.organization_description));
  }
  
  if (analysis.suggested_angle) {
    parts.push(cleanText(analysis.suggested_angle));
  }
  
  if (tender.description) {
    parts.push(cleanText(tender.description));
  }
  
  const excerpt = parts.join(' ');
  return excerpt.substring(0, 4000);
}

/**
 * Extracts similar projects from matrix evidence and RAG
 */
function extractProjectsFromMatrix(matrix, rag) {
  const projects = [];
  for (const a of collectAssets(matrix || {}, rag || {}).values()) {
    if (a.asset_type !== 'project') continue;
    const m = a.metadata || {};
    const hasRichTitle = a.title && a.title.length <= 60;
    projects.push({
      // Short titles (older inputs) are names; v2 titles are descriptions, so the name comes from the asset id
      name: hasRichTitle ? a.title : (assetName(a.asset_id) || a.title),
      client: cleanText(m.client || m.client_sector) || '',
      year: m.year || 0,
      result: hasRichTitle ? (a.snippets[0] || '') : a.title,
      stack: Array.isArray(m.stack) ? m.stack.map(cleanText).filter(Boolean) : [],
      duration_months: m.duration_months || 0,
      team_size: m.team_size || 0
    });
  }
  return projects;
}

/**
 * Extracts "why us" differentiators from analysis and matrix
 */
function extractWhyUs(analysis, matrix) {
  // Only facts from the evidence; no generic sentence when there is none
  const whyUs = [];
  if (analysis && analysis.suggested_angle) whyUs.push(cleanText(analysis.suggested_angle));
  if (matrix && Array.isArray(matrix.rows)) {
    matrix.rows
      .filter(r => r.coverage === 'covered' && (r.coverage_score || 0) >= 80 && r.justification)
      .slice(0, 4)
      .forEach(r => whyUs.push(cleanText(r.justification)));
  }
  return [...new Set(whyUs.filter(Boolean))];
}

/**
 * Extracts certifications from matrix evidence
 */
function extractCertifications(matrix, rag) {
  const certs = new Set();
  for (const a of collectAssets(matrix || {}, rag || {}).values()) {
    if (a.asset_type === 'certification' || String(a.asset_id).startsWith('cert_')) {
      certs.add(cleanText(a.title || a.asset_id));
    }
    // Team certifications stated in CV evidence: "Certifications: PMP (...), PRINCE2 Foundation"
    a.snippets.forEach(snip => {
      const m = /^certifications?\s*:\s*(.+)$/i.exec(snip);
      if (m) {
        m[1].split(/,(?![^()]*\))/).map(c => cleanText(c.replace(/\(.*?\)/g, '')).trim())
          .filter(c => c.length >= 2).forEach(c => certs.add(c));
      }
    });
  }
  const list = Array.from(certs);
  return { matching: list.length, list };
}

/**
 * Extracts engineer profiles from matrix evidence and RAG
 */
function extractEngineers(matrix, rag) {
  // One person per CV asset; the role comes from metadata.role or from the CV title
  const counts = new Map();
  let total = 0;
  for (const a of collectAssets(matrix || {}, rag || {}).values()) {
    if (a.asset_type !== 'cv') continue;
    total++;
    const role = roleFromCv(a);
    if (role) counts.set(role, (counts.get(role) || 0) + 1);
  }
  const order = ['Backend', 'Frontend', 'DevOps', 'PM', 'Designer', 'QA'];
  const profiles = order.filter(r => counts.has(r)).map(role => ({ role, count: counts.get(role) }));
  return { specialized: total, profiles };
}

function roleFromCv(asset) {
  const meta = asset.metadata && asset.metadata.role;
  const text = `${meta || ''} ${asset.title} ${asset.snippets.join(' ')}`.toLowerCase();
  if (meta && ['backend', 'frontend', 'devops', 'pm', 'designer', 'qa'].includes(String(meta).toLowerCase())) {
    return { backend: 'Backend', frontend: 'Frontend', devops: 'DevOps', pm: 'PM', designer: 'Designer', qa: 'QA' }[String(meta).toLowerCase()];
  }
  if (/project manager|chef de projet|\bpmp\b|scrum master/.test(text)) return 'PM';
  if (/\bux\b|\bdesigner\b/.test(text)) return 'Designer';  // word boundaries: "Redux" is not UX
  if (/devops|sre|cloud engineer|kubernetes/.test(text)) return 'DevOps';
  if (/\bqa\b|test engineer|testeur|quality/.test(text)) return 'QA';
  if (/backend|back-end|java|spring/.test(text)) return 'Backend';
  if (/front|react|angular|vue|mobile|full-stack|fullstack/.test(text)) return 'Frontend';
  return null;
}

/** Per-requirement coverage from the RAG matrix (score 0..1), used by the coverage score. */
function extractCoverage(matrix) {
  return (matrix && Array.isArray(matrix.rows) ? matrix.rows : []).map(r => ({
    requirement: cleanText(r.requirement || r.skill || ''),
    score: typeof r.coverage_score === 'number' ? (r.coverage_score > 1 ? r.coverage_score / 100 : r.coverage_score) : null,
    status: r.coverage || null,
    evidence: (r.evidence || []).map(e => e.asset_id).filter(Boolean)
  })).filter(r => r.requirement);
}

/** competition (v2) -> research block (estimated budget, competitors with their facts only). */
function researchFromCompetition(comp, analysis) {
  const research = {};
  if (analysis && analysis.sector) research.sector = cleanText(analysis.sector);
  if (!comp || comp.status !== 'OK') return Object.keys(research).length ? research : null;
  const b = comp.budget_estimate || {};
  if (typeof b.min === 'number' && typeof b.max === 'number' && b.min <= b.max) {
    research.estimated_budget = { min: b.min, max: b.max, currency: b.currency || '', source: cleanText(b.basis) || '' };
  }
  if (comp.positioning) research.summary = cleanText(comp.positioning);
  research.competitors = (comp.competitors || []).filter(c => c && c.name).slice(0, 8).map(c => {
    const strengths = [];
    if (c.past_wins > 0) strengths.push(`${c.past_wins} marché(s) comparable(s) remporté(s)${c.last_win ? `, dernier le ${c.last_win}` : ''}`);
    return { name: cleanText(c.name), strengths, weaknesses: [], source: 'competition (marchés attribués comparables)' };
  });
  return research;
}

// Export for CommonJS (n8n Code nodes) and ES modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    assetName,
    roleFromCv,
    researchFromCompetition,
    normalizeInput,
    normalizeNewFormat,
    normalizeLegacyFormat,
    scanForInjection,
    cleanText,
    inferProjectType,
    extractRequirements,
    extractProjectsFromMatrix,
    extractWhyUs,
    extractCertifications,
    extractEngineers,
    INJECTION_PATTERNS,
    INJECTION_CLAIMS
  };
}
