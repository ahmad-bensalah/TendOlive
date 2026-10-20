/**
 * checks.js - Validation checks for agent outputs
 * 
 * Enforces: numbers from input only, names from input only,
 * no unsupported claims, correct placeholder format, language consistency.
 */

const { extractNumbers, extractNames } = require('./llm.js');

/**
 * Superlatives that require evidence from match.why_us
 * These are COMPLETE WORDS only (not substrings)
 */
const SUPERLATIVES = {
  // "unique" and "premier" alone are ordinary words ("authentification unique", "premier livrable");
  // only the claim phrases are listed for them.
  en: ['best', 'leader', 'number one', '#1', 'top', 'one of a kind', 'only provider', 'guaranteed', 'award-winning',
       'premier', 'leading', 'unmatched', 'unrivalled'],
  fr: ['meilleur', 'leader', 'numéro un', 'n°1', 'premier acteur', 'premier fournisseur', 'seul acteur',
       'unique en son genre', 'inégalé', 'sans égal', 'garanti', 'primé', 'excellence']
  // Note: "référence" removed - too broad (matches "Références" title)
};

/**
 * Checks if all numbers in text appear in allowed numbers
 */
function checkNumbers(text, allowedNumbers, path = '') {
  const violations = [];
  
  if (typeof text !== 'string') return violations;
  
  const foundNumbers = extractNumbers(text);
  
  for (const num of foundNumbers) {
    // Check if this number is in allowed list (with tolerance for rounding)
    const isAllowed = allowedNumbers.some(allowed => {
      if (typeof allowed === 'number') {
        // Allow small rounding differences
        return Math.abs(num - allowed) < 0.01;
      }
      return false;
    });
    
    if (!isAllowed) {
      violations.push(`${path}: number ${num} not found in input data`);
    }
  }
  
  return violations;
}

/**
 * Common words/phrases that should not be flagged as names (even if capitalized)
 */
const COMMON_WORDS = new Set([
  // French phrases
  'synthèse', 'compréhension', 'solution', 'conformité', 'prochaines', 'étapes',
  'notre', 'équipe', 'avantage', 'atelier', 'plan', 'démarrage', 'projet',
  'service', 'entreprise', 'client', 'besoin', 'réponse', 'preuve',
  'prochaines étapes', 'notre équipe', 'notre réponse',
  // English phrases
  'summary', 'understanding', 'solution', 'compliance', 'next', 'steps',
  'our', 'team', 'advantage', 'workshop', 'plan', 'start', 'project',
  'service', 'company', 'client', 'need', 'response', 'evidence',
  'next steps', 'our team', 'our response',
  // Placeholder markers
  'fill', 'to', 'todo', 'tbd'
]);

/**
 * Checks if all names in text appear in allowed names
 */
function checkNames(text, allowedNames, path = '') {
  const violations = [];
  
  if (typeof text !== 'string') return violations;
  
  // Remove placeholders before extraction
  const textWithoutPlaceholders = text.replace(/\[TO FILL:[^\]]*\]/gi, '');
  
  const foundNames = extractNames(textWithoutPlaceholders);
  
  for (const name of foundNames) {
    const nameLower = name.toLowerCase();
    
    // Skip common words/phrases that aren't proper names
    if (COMMON_WORDS.has(nameLower)) {
      continue;
    }
    
    // Skip single short words (likely not names)
    if (name.length < 4 && !name.includes(' ')) {
      continue;
    }
    
    // Check if this name is in allowed list (case-insensitive, partial match)
    const isAllowed = allowedNames.some(allowed => {
      const allowedLower = String(allowed).toLowerCase();
      return nameLower.includes(allowedLower) || allowedLower.includes(nameLower);
    });
    
    if (!isAllowed) {
      violations.push(`${path}: name "${name}" not found in input data`);
    }
  }
  
  return violations;
}

/**
 * Checks for unsupported superlative claims
 */
function checkClaims(text, allowedClaims = [], language = 'fr', path = '', allowedNames = []) {
  const violations = [];
  
  if (typeof text !== 'string') return violations;
  
  // Names from the input (project names, clients, certificates) are not claims
  let textLower = text.toLowerCase();
  allowedNames.forEach(name => {
    const n = String(name).toLowerCase();
    if (n.length > 3) textLower = textLower.split(n).join(' ');
  });
  const superlatives = SUPERLATIVES[language] || SUPERLATIVES.fr;
  
  // Whole words only, with feminine/plural endings: "garanti(e)(s)" is a claim, "garantir" is not
  const wordRe = (claim) => new RegExp(
    `(?<![\\p{L}\\p{N}])${claim.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:e|s|es)?(?![\\p{L}\\p{N}])`, 'u');
  for (const claim of superlatives) {
    const re = wordRe(claim);
    if (re.test(textLower)) {
      // Check if this claim is explicitly allowed
      const isAllowed = allowedClaims.some(allowed => re.test(String(allowed).toLowerCase()));
      
      if (!isAllowed) {
        violations.push(`${path}: superlative claim "${claim}" not supported by match.why_us`);
      }
    }
  }
  
  return violations;
}

/**
 * Checks placeholder format is exactly [TO FILL: ...]
 */
function checkPlaceholders(text, path = '') {
  const violations = [];
  
  if (typeof text !== 'string') return violations;
  
  // Find all potential placeholders
  const placeholderPattern = /\[TO FILL[^\]]*\]/gi;
  const matches = text.match(placeholderPattern) || [];
  
  for (const match of matches) {
    // Check format is exactly [TO FILL: something]
    if (!/^\[TO FILL:\s*.+\]$/i.test(match)) {
      violations.push(`${path}: incorrect placeholder format "${match}" (should be [TO FILL: description])`);
    }
  }
  
  // Also check for common mistakes
  const badPatterns = [
    /\[TODO[^\]]*\]/gi,
    /\[TBD[^\]]*\]/gi,
    /\[FILL[^\]]*\]/gi,
    /\[À REMPLIR[^\]]*\]/gi
  ];
  
  for (const pattern of badPatterns) {
    const badMatches = text.match(pattern) || [];
    for (const match of badMatches) {
      violations.push(`${path}: use [TO FILL: ...] not "${match}"`);
    }
  }
  
  return violations;
}

/**
 * Checks language consistency (French accents, English spelling)
 */
function checkLanguage(text, expectedLanguage = 'fr', path = '') {
  const violations = [];
  
  if (typeof text !== 'string') return violations;
  
  if (expectedLanguage === 'fr') {
    // Check for common missing French accents
    const frenchWords = {
      'reponse': 'réponse',
      'equipe': 'équipe',
      'expertise': 'expertise', // correct
      'deploiement': 'déploiement',
      'qualite': 'qualité',
      'securite': 'sécurité'
    };
    
    for (const [wrong, correct] of Object.entries(frenchWords)) {
      const regex = new RegExp(`\\b${wrong}\\b`, 'gi');
      if (regex.test(text) && wrong !== correct) {
        violations.push(`${path}: missing accent - use "${correct}" not "${wrong}"`);
      }
    }
  }
  
  return violations;
}

/**
 * Extracts allowed numbers from input
 */
/**
 * Free-text input fields whose facts may be restated on slides: requirements, project
 * results and stacks, why_us. raw_text_excerpt is excluded on purpose: it is the field an
 * attacker controls (see tests/inputs/injection.json), so nothing in it is "allowed".
 */
function factTexts(input) {
  const texts = [];
  (input.tender?.requirements || []).forEach(r => texts.push(String(r)));
  (input.match?.similar_projects || []).forEach(p => {
    if (p.result) texts.push(String(p.result));
    (p.stack || []).forEach(t => texts.push(String(t)));
  });
  (input.match?.why_us || []).forEach(w => texts.push(String(w)));
  return texts;
}

function getAllowedNumbers(input) {
  const numbers = [];
  
  // From match
  if (input.match) {
    if (typeof input.match.score === 'number') {
      numbers.push(input.match.score);
      numbers.push(Math.round(input.match.score * 100)); // Percentage
    }
    
    if (input.match.engineers?.specialized) {
      numbers.push(input.match.engineers.specialized);
    }
    
    if (input.match.certifications?.matching) {
      numbers.push(input.match.certifications.matching);
    }
    
    // From similar projects
    if (Array.isArray(input.match.similar_projects)) {
      numbers.push(input.match.similar_projects.length);
      
      input.match.similar_projects.forEach(p => {
        if (p.year) numbers.push(p.year);
        if (p.duration_months) numbers.push(p.duration_months);
        if (p.team_size) numbers.push(p.team_size);
      });
    }
    
    // From certifications (include numbers from cert names like "ISO 27001")
    if (Array.isArray(input.match.certifications?.list)) {
      input.match.certifications.list.forEach(cert => {
        const certNumbers = extractNumbers(cert);
        numbers.push(...certNumbers);
      });
    }
    
    // From profiles
    if (Array.isArray(input.match.engineers?.profiles)) {
      input.match.engineers.profiles.forEach(p => {
        if (p.count) numbers.push(p.count);
      });
    }
  }
  
  // From tender
  if (input.tender) {
    if (input.tender.days_to_deadline) {
      numbers.push(input.tender.days_to_deadline);
    }
    
    if (Array.isArray(input.tender.requirements)) {
      numbers.push(input.tender.requirements.length);
    }
  }

  factTexts(input).forEach(t => numbers.push(...extractNumbers(t)));
  
  // From matrix
  if (input.matrix) {
    if (input.matrix.summary?.fit_score) {
      numbers.push(input.matrix.summary.fit_score);
    }
    
    if (Array.isArray(input.matrix.rows)) {
      numbers.push(input.matrix.rows.length);
      
      input.matrix.rows.forEach(row => {
        if (row.coverage_score) numbers.push(row.coverage_score);
      });
    }
  }
  
  return numbers;
}

/**
 * Extracts allowed names from input
 */
function getAllowedNames(input) {
  const names = [];
  
  // From tender
  if (input.tender) {
    if (input.tender.client) names.push(input.tender.client);
    if (input.tender.title) names.push(input.tender.title);
  }
  
  // From buyer profile
  if (input.buyer_profile) {
    if (input.buyer_profile.legal_name) names.push(input.buyer_profile.legal_name);
  }
  
  // From match
  if (input.match) {
    // Similar projects
    if (Array.isArray(input.match.similar_projects)) {
      input.match.similar_projects.forEach(p => {
        if (p.name) names.push(p.name);
        if (p.client) names.push(p.client);
      });
    }
    
    // Certifications
    if (Array.isArray(input.match.certifications?.list)) {
      names.push(...input.match.certifications.list);
    }
  }

  names.push(...factTexts(input));
  
  // From matrix evidence
  if (input.matrix?.rows) {
    input.matrix.rows.forEach(row => {
      if (Array.isArray(row.evidence)) {
        row.evidence.forEach(ev => {
          if (ev.title) names.push(ev.title);
          if (ev.metadata?.client) names.push(ev.metadata.client);
        });
      }
    });
  }
  
  return names;
}

/**
 * Runs all checks on a slide
 */
function checkSlide(slide, input, path = 'slide') {
  const violations = [];
  const allowedNumbers = getAllowedNumbers(input);
  const allowedNames = getAllowedNames(input);
  const allowedClaims = input.match?.why_us || [];
  const language = input.tender?.language || 'fr';
  
  // Check title
  if (slide.title) {
    violations.push(...checkNumbers(slide.title, allowedNumbers, `${path}.title`));
    violations.push(...checkNames(slide.title, allowedNames, `${path}.title`));
    violations.push(...checkClaims(slide.title, allowedClaims, language, `${path}.title`, allowedNames));
    violations.push(...checkPlaceholders(slide.title, `${path}.title`));
    violations.push(...checkLanguage(slide.title, language, `${path}.title`));
  }
  
  // Check blocks
  if (Array.isArray(slide.blocks)) {
    slide.blocks.forEach((block, idx) => {
      const blockPath = `${path}.blocks[${idx}]`;
      
      if (block.kind === 'text' && block.text) {
        violations.push(...checkNumbers(block.text, allowedNumbers, blockPath));
        violations.push(...checkNames(block.text, allowedNames, blockPath));
        violations.push(...checkClaims(block.text, allowedClaims, language, blockPath, allowedNames));
        violations.push(...checkPlaceholders(block.text, blockPath));
        violations.push(...checkLanguage(block.text, language, blockPath));
      }
      
      if (block.kind === 'bullets' && Array.isArray(block.items)) {
        block.items.forEach((item, itemIdx) => {
          const itemPath = `${blockPath}.items[${itemIdx}]`;
          violations.push(...checkNumbers(item, allowedNumbers, itemPath));
          violations.push(...checkNames(item, allowedNames, itemPath));
          violations.push(...checkClaims(item, allowedClaims, language, itemPath, allowedNames));
          violations.push(...checkPlaceholders(item, itemPath));
          violations.push(...checkLanguage(item, language, itemPath));
        });
      }
      
      if (block.kind === 'table' && Array.isArray(block.rows)) {
        block.rows.forEach((row, rowIdx) => {
          if (Array.isArray(row)) {
            row.forEach((cell, cellIdx) => {
              const cellPath = `${blockPath}.rows[${rowIdx}][${cellIdx}]`;
              violations.push(...checkNumbers(cell, allowedNumbers, cellPath));
              violations.push(...checkNames(cell, allowedNames, cellPath));
              violations.push(...checkClaims(cell, allowedClaims, language, cellPath, allowedNames));
              violations.push(...checkPlaceholders(cell, cellPath));
              violations.push(...checkLanguage(cell, language, cellPath));
            });
          }
        });
      }
    });
  }
  
  // Check notes
  if (slide.notes) {
    violations.push(...checkNumbers(slide.notes, allowedNumbers, `${path}.notes`));
    violations.push(...checkNames(slide.notes, allowedNames, `${path}.notes`));
    violations.push(...checkClaims(slide.notes, allowedClaims, language, `${path}.notes`, allowedNames));
  }
  
  return violations;
}

/**
 * Checks one string written by the LLM (numbers, names, claims, placeholders).
 * Returns the text unchanged when it passes, or the placeholder when it does not.
 * Used after the last retry so that a bad sentence never reaches the deck.
 */
function scrubText(text, input, placeholderLabel, path = '') {
  if (typeof text !== 'string' || !text.trim()) {
    return { text: `[TO FILL: ${placeholderLabel}]`, violations: [`${path}: empty text`] };
  }
  const language = input.tender?.language || 'fr';
  const violations = [
    ...checkNumbers(text, getAllowedNumbers(input), path),
    ...checkNames(text, getAllowedNames(input), path),
    ...checkClaims(text, input.match?.why_us || [], language, path, getAllowedNames(input)),
    ...checkPlaceholders(text, path)
  ];
  return violations.length ? { text: `[TO FILL: ${placeholderLabel}]`, violations } : { text, violations };
}

// Export for CommonJS (n8n Code nodes) and ES modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    checkNumbers,
    checkNames,
    checkClaims,
    checkPlaceholders,
    checkLanguage,
    checkSlide,
    getAllowedNumbers,
    getAllowedNames,
    scrubText,
    SUPERLATIVES
  };
}
