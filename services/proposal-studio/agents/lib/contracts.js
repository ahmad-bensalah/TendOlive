/**
 * contracts.js - Schema validation mirroring layout_engine.py exactly
 * 
 * Validates deck specs and slide specs with the same rules as the platform:
 * - Allowed fields only (unknown fields rejected)
 * - Required fields and types
 * - Block kind validation
 * - Platform limits as warnings
 */

const ALLOWED_DECK_FIELDS = new Set(['name', 'client', 'date', 'language', 'qr_url', 'theme', 'slides', 'template', 'agenda']);
const ALLOWED_SLIDE_FIELDS = new Set(['type', 'title', 'blocks', 'notes', 'warnings', 'requiresApproval', 'sources', 'assumptions', 'catalogDate']);
const ALLOWED_BLOCK_KINDS = new Set(['text', 'bullets', 'table', 'image', 'cards', 'note', 'kpis']);
const ALLOWED_BULLET_STYLES = new Set(['disc', 'number', 'check']);

// Platform limits (produce warnings, not errors)
const LIMITS = {
  maxCards: 4,
  maxKpis: 4,
  maxBullets: 6,
  maxTableRows: 10,
  maxBulletWords: 12,
  bulletSplitAt: 12,
  tableSplitAt: 10
};

/**
 * Validates a single block
 * @param {any} block - The block object
 * @param {string} path - Path for error messages
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validateBlock(block, path) {
  const errors = [];
  const warnings = [];
  
  if (typeof block !== 'object' || block === null || Array.isArray(block)) {
    return { errors: [`${path}: must be an object`], warnings };
  }
  
  const kind = block.kind;
  if (!kind) {
    errors.push(`${path}.kind: missing block kind`);
    return { errors, warnings };
  }
  
  if (!ALLOWED_BLOCK_KINDS.has(kind)) {
    const allowed = Array.from(ALLOWED_BLOCK_KINDS).sort();
    errors.push(`${path}.kind: unknown block kind '${kind}'. Allowed: ${JSON.stringify(allowed)}`);
    return { errors, warnings };
  }
  
  // Validate by kind
  switch (kind) {
    case 'text':
      if (typeof block.text !== 'string') {
        errors.push(`${path}.text: required string`);
      }
      break;
      
    case 'note':
      if (typeof block.text !== 'string') {
        errors.push(`${path}.text: required string`);
      }
      break;
      
    case 'bullets':
      if (!Array.isArray(block.items)) {
        errors.push(`${path}.items: required array of strings`);
      } else {
        if (!block.items.every(x => typeof x === 'string')) {
          errors.push(`${path}.items: required array of strings`);
        }
        
        // Warnings for limits
        if (block.items.length > LIMITS.maxBullets) {
          warnings.push(`${path}: ${block.items.length} bullets (recommended max ${LIMITS.maxBullets})`);
        }
        
        // Check word count per bullet
        block.items.forEach((item, idx) => {
          const words = item.split(/\s+/).length;
          if (words > LIMITS.maxBulletWords) {
            warnings.push(`${path}.items[${idx}]: ${words} words (recommended max ${LIMITS.maxBulletWords})`);
          }
        });
      }
      
      if ('bulletStyle' in block && !ALLOWED_BULLET_STYLES.has(block.bulletStyle)) {
        errors.push(`${path}.bulletStyle: must be one of disc, number, check`);
      }
      break;
      
    case 'table':
      if (!Array.isArray(block.columns)) {
        errors.push(`${path}.columns: required array of strings`);
      } else if (!block.columns.every(x => typeof x === 'string')) {
        errors.push(`${path}.columns: required array of strings`);
      }
      
      if (!Array.isArray(block.rows)) {
        errors.push(`${path}.rows: required 2D array of strings`);
      } else {
        // Check each row is array of strings
        for (let i = 0; i < block.rows.length; i++) {
          const row = block.rows[i];
          if (!Array.isArray(row)) {
            errors.push(`${path}.rows[${i}]: must be an array`);
          } else if (!row.every(cell => typeof cell === 'string')) {
            errors.push(`${path}.rows[${i}]: all cells must be strings`);
          }
        }
        
        // Warning for long tables
        if (block.rows.length > LIMITS.maxTableRows) {
          warnings.push(`${path}: ${block.rows.length} rows (will split at ${LIMITS.tableSplitAt} rows)`);
        }
      }
      break;
      
    case 'image':
      if (typeof block.src !== 'string' || !block.src) {
        errors.push(`${path}.src: required string`);
      }
      break;
      
    case 'cards':
      if (!Array.isArray(block.cards)) {
        errors.push(`${path}.cards: required array`);
      } else {
        block.cards.forEach((card, idx) => {
          if (typeof card !== 'object' || card === null) {
            errors.push(`${path}.cards[${idx}]: must be an object`);
          } else {
            if (typeof card.title !== 'string') {
              errors.push(`${path}.cards[${idx}]: requires title string`);
            }
            if (typeof card.text !== 'string') {
              errors.push(`${path}.cards[${idx}]: requires text string`);
            }
          }
        });
        
        // Warning for more than 4 cards
        if (block.cards.length > LIMITS.maxCards) {
          warnings.push(`${path}: ${block.cards.length} cards (max ${LIMITS.maxCards} rendered, extras dropped)`);
        }
      }
      break;
      
    case 'kpis':
      if (!Array.isArray(block.items)) {
        errors.push(`${path}.items: required array of KPI objects`);
      } else {
        block.items.forEach((kpi, idx) => {
          if (typeof kpi !== 'object' || kpi === null) {
            errors.push(`${path}.items[${idx}]: must be an object`);
          } else {
            if (!('label' in kpi)) {
              errors.push(`${path}.items[${idx}]: requires label`);
            }
            if (!('value' in kpi)) {
              errors.push(`${path}.items[${idx}]: requires value`);
            }
          }
        });
        
        // Warning for more than 4 KPIs
        if (block.items.length > LIMITS.maxKpis) {
          warnings.push(`${path}: ${block.items.length} KPIs (max ${LIMITS.maxKpis} rendered, extras dropped)`);
        }
      }
      break;
  }
  
  return { errors, warnings };
}

/**
 * Validates a single slide spec
 * @param {any} slide - The slide object
 * @param {string} path - Path for error messages (e.g., "slides[2]")
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validateSlideSpec(slide, path = 'slide') {
  const errors = [];
  const warnings = [];
  
  if (typeof slide !== 'object' || slide === null || Array.isArray(slide)) {
    return { errors: [`${path}: must be an object`], warnings };
  }
  
  // Check for unknown fields
  const unknownFields = Object.keys(slide).filter(k => !ALLOWED_SLIDE_FIELDS.has(k));
  if (unknownFields.length > 0) {
    const allowed = Array.from(ALLOWED_SLIDE_FIELDS).sort().join(', ');
    const unknown = unknownFields.sort().join(', ');
    errors.push(`${path}: unknown field(s) '${unknown}'. Allowed slide fields are: ${allowed}`);
  }
  
  // Type must be 'content'
  if (slide.type !== 'content') {
    errors.push(`${path}.type: must be 'content'`);
  }
  
  // Title is required string
  if (typeof slide.title !== 'string') {
    errors.push(`${path}.title: required string`);
  }
  
  // Optional fields type checks
  if ('requiresApproval' in slide && typeof slide.requiresApproval !== 'boolean') {
    errors.push(`${path}.requiresApproval: must be a boolean`);
  }
  
  if ('assumptions' in slide) {
    if (!Array.isArray(slide.assumptions) || !slide.assumptions.every(x => typeof x === 'string')) {
      errors.push(`${path}.assumptions: must be an array of strings`);
    }
  }
  
  if ('catalogDate' in slide && typeof slide.catalogDate !== 'string') {
    errors.push(`${path}.catalogDate: must be a string`);
  }
  
  if ('warnings' in slide) {
    if (!Array.isArray(slide.warnings) || !slide.warnings.every(x => typeof x === 'string')) {
      errors.push(`${path}.warnings: must be an array of strings`);
    }
  }
  
  if ('notes' in slide && typeof slide.notes !== 'string') {
    errors.push(`${path}.notes: must be a string`);
  }
  
  if ('sources' in slide) {
    if (typeof slide.sources !== 'object' || slide.sources === null || Array.isArray(slide.sources)) {
      errors.push(`${path}.sources: must be an object`);
    }
  }
  
  // Blocks is required array
  if (!Array.isArray(slide.blocks)) {
    errors.push(`${path}.blocks: required array`);
    return { errors, warnings };
  }
  
  // Validate each block
  slide.blocks.forEach((block, idx) => {
    const blockPath = `${path}.blocks[${idx}]`;
    const blockResult = validateBlock(block, blockPath);
    errors.push(...blockResult.errors);
    warnings.push(...blockResult.warnings);
  });
  
  return { errors, warnings };
}

/**
 * Validates a complete deck spec
 * @param {any} data - The deck object
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validateDeckSpec(data) {
  const errors = [];
  const warnings = [];
  
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { errors: ['Root payload must be an object'], warnings };
  }
  
  // Check for unknown fields at deck level
  const unknownFields = Object.keys(data).filter(k => !ALLOWED_DECK_FIELDS.has(k));
  if (unknownFields.length > 0) {
    const allowed = Array.from(ALLOWED_DECK_FIELDS).sort().join(', ');
    const unknown = unknownFields.sort().join(', ');
    errors.push(`Root: unknown field(s) '${unknown}'. Allowed deck fields are: ${allowed}`);
  }
  
  // Name is required non-empty string
  if (typeof data.name !== 'string' || !data.name.trim()) {
    errors.push("Root property 'name' is required and must be a non-empty string");
  }
  
  // Slides is required array
  if (!Array.isArray(data.slides)) {
    errors.push("Root property 'slides' is required and must be an array");
    return { errors, warnings };
  }
  
  if (data.slides.length === 0) {
    errors.push("Deck must contain at least one slide in 'slides'");
  }
  
  // Validate each slide
  data.slides.forEach((slide, idx) => {
    const slideResult = validateSlideSpec(slide, `slides[${idx}]`);
    errors.push(...slideResult.errors);
    warnings.push(...slideResult.warnings);
  });
  
  return { errors, warnings };
}

/**
 * Additional checks for content quality (not schema, but recommended)
 */
function checkContentQuality(slide, path = 'slide') {
  const warnings = [];
  
  // Check for HTML-like text
  const htmlPattern = /<[^>]+>/;
  const emojiPattern = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
  
  if (slide.title && htmlPattern.test(slide.title)) {
    warnings.push(`${path}.title: contains HTML-like markup (will be escaped)`);
  }
  
  if (slide.title && emojiPattern.test(slide.title)) {
    warnings.push(`${path}.title: contains emojis (not recommended)`);
  }
  
  if (Array.isArray(slide.blocks)) {
    slide.blocks.forEach((block, idx) => {
      const blockPath = `${path}.blocks[${idx}]`;
      
      if (block.kind === 'text' && block.text) {
        if (htmlPattern.test(block.text)) {
          warnings.push(`${blockPath}.text: contains HTML-like markup (will be escaped)`);
        }
        if (emojiPattern.test(block.text)) {
          warnings.push(`${blockPath}.text: contains emojis (not recommended)`);
        }
      }
      
      if (block.kind === 'bullets' && Array.isArray(block.items)) {
        block.items.forEach((item, itemIdx) => {
          if (htmlPattern.test(item)) {
            warnings.push(`${blockPath}.items[${itemIdx}]: contains HTML-like markup (will be escaped)`);
          }
          if (emojiPattern.test(item)) {
            warnings.push(`${blockPath}.items[${itemIdx}]: contains emojis (not recommended)`);
          }
        });
      }
    });
  }
  
  return warnings;
}

// Export for CommonJS (n8n Code nodes) and ES modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    validateBlock,
    validateSlideSpec,
    validateDeckSpec,
    checkContentQuality,
    ALLOWED_DECK_FIELDS,
    ALLOWED_SLIDE_FIELDS,
    ALLOWED_BLOCK_KINDS,
    ALLOWED_BULLET_STYLES,
    LIMITS
  };
}
