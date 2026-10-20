/**
 * merge.js - Slide ordering, ID stripping, deck building, and registry mapping
 * 
 * Merges agent outputs in standard order, ensures unique titles,
 * enforces limits, builds the final deck spec, and creates registry data.
 */

// Slide order, grouped by agenda section (the "Sommaire" page of structured templates lists
// the sections; each section is a contiguous block). No class diagram (removed for all decks).
const SECTIONS = [
  { ids: ['s1', 's2'],        fr: 'Synthèse et besoins',              en: 'Summary and needs' },
  { ids: ['s3', 's3b'],       fr: 'Solution et architecture',          en: 'Solution and architecture' },
  { ids: ['s4', 's6', 's7'],  fr: 'Atouts, équipe et références',      en: 'Why us, team, references' },
  { ids: ['s5', 's10'],       fr: 'Planning et risques',               en: 'Planning and risks' },
  { ids: ['s9', 's8', 's11'], fr: 'Offre financière et support',       en: 'Pricing and support' }
];
const SLIDE_ORDER = SECTIONS.flatMap(sec => sec.ids);

/**
 * Strips the 'id' field from a slide (platform doesn't accept it)
 */
function stripId(slide) {
  const { id, ...rest } = slide;
  return rest;
}

/**
 * Ensures all titles in the deck are unique by appending numbers
 */
function ensureUniqueTitles(slides) {
  const titleCounts = new Map();
  const warnings = [];
  
  return slides.map((slide, idx) => {
    let title = slide.title;
    
    // Count occurrences
    const baseTitle = title;
    const count = titleCounts.get(baseTitle) || 0;
    titleCounts.set(baseTitle, count + 1);
    
    if (count > 0) {
      // Duplicate found - append number
      title = `${baseTitle} (${count + 1})`;
      warnings.push(`Duplicate title "${baseTitle}" at slide ${idx}, renamed to "${title}"`);
    }
    
    return { ...slide, title };
  });
}

/**
 * Enforces platform limits on blocks
 */
function enforceLimits(slide) {
  const warnings = [];
  
  if (!Array.isArray(slide.blocks)) {
    return { slide, warnings };
  }
  
  const limitedBlocks = slide.blocks.map((block, idx) => {
    const limited = { ...block };
    
    // Cards: max 4
    if (block.kind === 'cards' && Array.isArray(block.cards) && block.cards.length > 4) {
      warnings.push(`${slide.title}: truncated ${block.cards.length} cards to 4 (platform limit)`);
      limited.cards = block.cards.slice(0, 4);
    }
    
    // KPIs: max 4
    if (block.kind === 'kpis' && Array.isArray(block.items) && block.items.length > 4) {
      warnings.push(`${slide.title}: truncated ${block.items.length} KPIs to 4 (platform limit)`);
      limited.items = block.items.slice(0, 4);
    }
    
    // Bullets: warn if > 6 (platform splits at 12)
    if (block.kind === 'bullets' && Array.isArray(block.items) && block.items.length > 12) {
      warnings.push(`${slide.title}: ${block.items.length} bullets will split into multiple slides`);
    }
    
    // Table: warn if > 10 rows (platform splits)
    if (block.kind === 'table' && Array.isArray(block.rows) && block.rows.length > 10) {
      warnings.push(`${slide.title}: ${block.rows.length} table rows will split into multiple slides`);
    }
    
    return limited;
  });
  
  return {
    slide: { ...slide, blocks: limitedBlocks },
    warnings
  };
}

/**
 * Merges agent outputs into final deck spec
 * @param {object} params - { agentOutputs, input, runId, qr_url }
 * @returns {{ deckSpec: object, warnings: string[], metadata: object }}
 */
function mergeDeck(params) {
  const { agentOutputs, input, runId, qr_url } = params;
  const warnings = [];
  const metadata = {
    runId,
    projectType: input.tender.project_type || 'other',
    language: input.tender.language || 'fr',
    placeholderCount: 0,
    slideIdMap: {}
  };
  
  // Collect all slides by ID from agent outputs
  const slideById = new Map();
  
  for (const [agentName, output] of Object.entries(agentOutputs)) {
    if (!output.ok) {
      warnings.push(`Agent ${agentName} failed: using placeholder slides`);
      continue;
    }
    
    if (Array.isArray(output.slides)) {
      output.slides.forEach(slide => {
        if (slide.id) {
          slideById.set(slide.id, slide);
        }
      });
    }
    
    // Collect agent-level warnings
    if (Array.isArray(output.warnings)) {
      warnings.push(...output.warnings.map(w => `${agentName}: ${w}`));
    }
  }
  
  // Order slides according to SLIDE_ORDER
  const orderedSlides = [];
  
  for (const slideId of SLIDE_ORDER) {
    // s3c removed entirely - no class diagram for any project type
    
    const slide = slideById.get(slideId);
    
    if (slide && Array.isArray(slide.blocks)) {
      // The contact is on the template's closing page: no contact line on "Prochaines étapes"
      if (slideId === 's11') {
        slide.blocks = slide.blocks.filter(b => !(typeof b.text === 'string' && /\[TO FILL: contact\]/i.test(b.text)));
      }
      // No SLA placeholder on "Support et SLA"
      if (slideId === 's8') {
        slide.blocks = slide.blocks.filter(b => !(typeof b.text === 'string' && /\[TO FILL: SLA/i.test(b.text)));
      }
      // Compliance matrix: 4 rows per slide, the platform splits it into continuation slides
      if (slideId === 's3') {
        slide.blocks = slide.blocks.map(b => (b.kind === 'table' ? { ...b, rowsPerSlide: 4 } : b));
      }
    }
    if (slide) {
      metadata.slideIdMap[slideId] = orderedSlides.length;
      orderedSlides.push(slide);
    } else {
      // Missing slide - create placeholder
      warnings.push(`Missing slide ${slideId}, using placeholder`);
      const placeholderSlide = createPlaceholderSlide(slideId, metadata.language);
      metadata.slideIdMap[slideId] = orderedSlides.length;
      orderedSlides.push(placeholderSlide);
      metadata.placeholderCount++;
    }
  }
  
  // Ensure unique titles
  const uniqueTitledSlides = ensureUniqueTitles(orderedSlides);
  
  // Enforce limits and collect warnings
  const finalSlides = [];
  uniqueTitledSlides.forEach(slide => {
    const { slide: limited, warnings: limitWarnings } = enforceLimits(slide);
    finalSlides.push(limited);
    warnings.push(...limitWarnings);
    
    // Count placeholders
    if (Array.isArray(limited.blocks)) {
      limited.blocks.forEach(block => {
        if (block.kind === 'note' && block.text && block.text.includes('[TO FILL:')) {
          metadata.placeholderCount++;
        }
      });
    }
  });
  
  // Strip IDs before sending to platform
  const strippedSlides = finalSlides.map(stripId);
  
  // Build deck name
  const tenderTitle = input.tender.title || 'Proposition';
  const deckName = `RFP : ${tenderTitle}`.substring(0, 80);
  
  // Format date for language
  const today = new Date();
  const dateStr = formatDate(today, metadata.language);
  
  // Build QR URL from template
  let finalQrUrl = qr_url || '';
  if (finalQrUrl && finalQrUrl.includes('{deckId}')) {
    // Will be replaced after we get the deckId from POST
    finalQrUrl = finalQrUrl; // Keep template for now
  }
  
  // Template id chosen by the platform (Générer dialog / default template) or DEFAULT_TEMPLATE in n8n.
  // Never hard-coded: "Sans modèle" must stay possible, and an id missing from the library gives HTTP 400.
  const template = typeof input.template === 'string' && input.template ? input.template : null;
  
  // Build theme (only allowed keys)
  // If using a template, prefer template theme unless explicitly overridden
  const theme = {};
  const allowedThemeKeys = ['primary', 'secondary', 'background', 'fontHeading', 'fontBody'];
  
  // Only include theme overrides if explicitly provided in input
  // Otherwise, let the template's theme be used
  if (input.theme && Object.keys(input.theme).length > 0) {
    for (const key of allowedThemeKeys) {
      if (input.theme[key]) {
        theme[key] = input.theme[key];
      }
    }
  }
  // Note: if theme is empty object {}, platform will use template's theme
  
  const deckSpec = {
    name: deckName,
    client: input.tender.client || '',
    date: dateStr,
    language: metadata.language,
    qr_url: finalQrUrl,
    agenda: SECTIONS.map(sec => (metadata.language === 'en' ? sec.en : sec.fr)),
    slides: strippedSlides
  };
  if (template) deckSpec.template = template;
  // Only add theme if we have overrides, otherwise let template control it
  if (Object.keys(theme).length > 0) {
    deckSpec.theme = theme;
  }
  
  return {
    deckSpec,
    warnings,
    metadata
  };
}

/**
 * Creates a placeholder slide for a missing slide ID
 */
function createPlaceholderSlide(slideId, language = 'fr') {
  const titles = {
    fr: {
      s1: 'Synthèse exécutive',
      s2: 'Compréhension de vos besoins',
      s3: 'Solution proposée et conformité',
      s3b: 'Architecture technique',
      s3c: 'Modèle de classes',
      s4: 'Nos atouts',
      s5: 'Plan de mise en oeuvre',
      s6: 'Équipe et gouvernance',
      s7: 'Références pertinentes',
      s8: 'Support et SLA',
      s9: 'Offre financière',
      s10: 'Risques et mitigation',
      s11: 'Prochaines étapes'
    },
    en: {
      s1: 'Executive Summary',
      s2: 'Understanding Your Needs',
      s3: 'Proposed Solution and Compliance',
      s3b: 'Technical Architecture',
      s3c: 'Class Model',
      s4: 'Our Strengths',
      s5: 'Implementation Plan',
      s6: 'Team and Governance',
      s7: 'Relevant References',
      s8: 'Support and SLA',
      s9: 'Financial Proposal',
      s10: 'Risks and Mitigation',
      s11: 'Next Steps'
    }
  };
  
  const langTitles = titles[language] || titles.en;
  const title = langTitles[slideId] || 'Slide';
  
  const fillText = language === 'fr' 
    ? `[TO FILL: ${title} à compléter]`
    : `[TO FILL: ${title} to be completed]`;
  
  return {
    id: slideId,
    type: 'content',
    title,
    blocks: [{ kind: 'note', text: fillText }],
    warnings: [`Placeholder slide: agent failed or missing data`]
  };
}

/**
 * Formats a date according to language
 */
function formatDate(date, language = 'fr') {
  const months = {
    fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 
         'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
    en: ['January', 'February', 'March', 'April', 'May', 'June',
         'July', 'August', 'September', 'October', 'November', 'December']
  };
  
  const langMonths = months[language] || months.en;
  const day = date.getDate();
  const month = langMonths[date.getMonth()];
  const year = date.getFullYear();
  
  if (language === 'fr') {
    return `${day} ${month} ${year}`;
  } else {
    return `${month} ${day}, ${year}`;
  }
}

// Export for CommonJS (n8n Code nodes) and ES modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    mergeDeck,
    ensureUniqueTitles,
    enforceLimits,
    stripId,
    createPlaceholderSlide,
    formatDate,
    SLIDE_ORDER,
    SECTIONS
  };
}
