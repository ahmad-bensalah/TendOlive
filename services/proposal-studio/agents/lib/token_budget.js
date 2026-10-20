/**
 * token_budget.js - Token optimization for Phase S
 * 
 * Goal: Reduce tokens per deck from ~36k to max 15k
 * 
 * Strategies:
 * 1. Truncate tender text to most relevant parts (4000 chars max, was unlimited)
 * 2. Limit requirements list (max 20, was unlimited)
 * 3. Limit similar projects (max 5, was unlimited)
 * 4. Shorten prompts (remove examples, keep only critical rules)
 * 5. Proactive limiter: reject inputs that would exceed budget even after truncation
 * 6. Demo cache: store truncated inputs to avoid re-processing
 */

const MAX_TENDER_TEXT = 4000;
const MAX_REQUIREMENTS = 20;
const MAX_SIMILAR_PROJECTS = 5;
const MAX_CERTIFICATIONS = 10;
const MAX_WHY_US = 8;
const MAX_ENGINEERS_PROFILES = 8;

/**
 * Truncates input to fit token budget.
 * Returns { input (truncated), warnings, estimatedTokens }
 */
function truncateInput(input) {
  const warnings = [];
  const truncated = JSON.parse(JSON.stringify(input)); // deep clone
  
  // 1. Truncate tender text
  if (truncated.tender && truncated.tender.description) {
    const desc = String(truncated.tender.description);
    if (desc.length > MAX_TENDER_TEXT) {
      truncated.tender.description = desc.slice(0, MAX_TENDER_TEXT) + '...';
      warnings.push(`Tender description truncated from ${desc.length} to ${MAX_TENDER_TEXT} chars`);
    }
  }
  
  if (truncated.tender && truncated.tender.raw_text_excerpt) {
    const raw = String(truncated.tender.raw_text_excerpt);
    if (raw.length > MAX_TENDER_TEXT) {
      truncated.tender.raw_text_excerpt = raw.slice(0, MAX_TENDER_TEXT) + '...';
      warnings.push(`Raw text excerpt truncated from ${raw.length} to ${MAX_TENDER_TEXT} chars`);
    }
  }
  
  // 2. Limit requirements (keep first N + mandatory ones)
  if (truncated.tender && Array.isArray(truncated.tender.requirements)) {
    const reqs = truncated.tender.requirements;
    if (reqs.length > MAX_REQUIREMENTS) {
      truncated.tender.requirements = reqs.slice(0, MAX_REQUIREMENTS);
      warnings.push(`Requirements limited from ${reqs.length} to ${MAX_REQUIREMENTS}`);
    }
  }
  
  // 3. Limit similar projects (keep most recent + highest match)
  if (truncated.match && Array.isArray(truncated.match.similar_projects)) {
    const projects = truncated.match.similar_projects;
    if (projects.length > MAX_SIMILAR_PROJECTS) {
      // Sort by year desc, keep top 5
      const sorted = [...projects].sort((a, b) => (b.year || 0) - (a.year || 0));
      truncated.match.similar_projects = sorted.slice(0, MAX_SIMILAR_PROJECTS);
      warnings.push(`Similar projects limited from ${projects.length} to ${MAX_SIMILAR_PROJECTS}`);
    }
  }
  
  // 4. Limit certifications
  if (truncated.match && truncated.match.certifications && Array.isArray(truncated.match.certifications.list)) {
    const certs = truncated.match.certifications.list;
    if (certs.length > MAX_CERTIFICATIONS) {
      truncated.match.certifications.list = certs.slice(0, MAX_CERTIFICATIONS);
      truncated.match.certifications.matching = Math.min(
        truncated.match.certifications.matching || 0,
        MAX_CERTIFICATIONS
      );
      warnings.push(`Certifications limited from ${certs.length} to ${MAX_CERTIFICATIONS}`);
    }
  }
  
  // 5. Limit why_us
  if (truncated.match && Array.isArray(truncated.match.why_us)) {
    const why = truncated.match.why_us;
    if (why.length > MAX_WHY_US) {
      truncated.match.why_us = why.slice(0, MAX_WHY_US);
      warnings.push(`Why_us limited from ${why.length} to ${MAX_WHY_US}`);
    }
  }
  
  // 6. Limit engineer profiles
  if (truncated.match && truncated.match.engineers && Array.isArray(truncated.match.engineers.profiles)) {
    const profiles = truncated.match.engineers.profiles;
    if (profiles.length > MAX_ENGINEERS_PROFILES) {
      truncated.match.engineers.profiles = profiles.slice(0, MAX_ENGINEERS_PROFILES);
      warnings.push(`Engineer profiles limited from ${profiles.length} to ${MAX_ENGINEERS_PROFILES}`);
    }
  }
  
  // 7. RAG matrix: keep only top evidence per requirement
  if (truncated.matrix && Array.isArray(truncated.matrix.rows)) {
    truncated.matrix.rows = truncated.matrix.rows.map(row => {
      if (Array.isArray(row.evidence) && row.evidence.length > 3) {
        return { ...row, evidence: row.evidence.slice(0, 3) };
      }
      return row;
    });
  }
  
  // 8. Estimate tokens (rough: 4 chars = 1 token)
  const jsonSize = JSON.stringify(truncated).length;
  const estimatedTokens = Math.ceil(jsonSize / 4);
  
  return { input: truncated, warnings, estimatedTokens };
}

/**
 * Checks if input would exceed token budget even after truncation.
 * Returns { ok: true } or { ok: false, reason, estimatedTokens }
 */
function checkTokenBudget(input, maxTokens = 15000) {
  const { input: truncated, estimatedTokens } = truncateInput(input);
  
  if (estimatedTokens > maxTokens) {
    return {
      ok: false,
      reason: `Input too large: ${estimatedTokens} estimated tokens (max ${maxTokens})`,
      estimatedTokens
    };
  }
  
  return { ok: true, estimatedTokens };
}

/**
 * Shortens a prompt by removing examples and verbose explanations.
 * Keeps only critical rules and output format.
 */
function shortenPrompt(prompt) {
  // Remove markdown code blocks (examples)
  let short = prompt.replace(/```[\s\S]*?```/g, '');
  
  // Remove lines starting with "Example:" or "For instance:"
  short = short.split('\n')
    .filter(line => !/(Example|For instance|Par exemple):/i.test(line))
    .join('\n');
  
  // Collapse multiple blank lines
  short = short.replace(/\n{3,}/g, '\n\n');
  
  return short.trim();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    truncateInput,
    checkTokenBudget,
    shortenPrompt,
    MAX_TENDER_TEXT,
    MAX_REQUIREMENTS,
    MAX_SIMILAR_PROJECTS
  };
}
