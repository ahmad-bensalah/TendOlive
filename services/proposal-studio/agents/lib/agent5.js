/**
 * agent5.js - Agent 5 (Credibility) logic
 * 
 * Produces slides s4, s6, s7, s8:
 * - s4: Differentiators (why us)
 * - s6: Team and governance
 * - s7: Relevant references (project cards)
 * - s8: Support and SLA
 */

const { selectReferences } = require('./rank.js');
const { getAllowedNumbers, getAllowedNames, checkNumbers, checkNames, checkClaims, checkPlaceholders, scrubText } = require('./checks.js');
const { buildSystemPrompt, wrapTenderData, withFeedback, makeCaller, runAgentLoop } = require('./llm.js');

/**
 * Builds ready facts for Agent 5 from input
 * @param {object} input - Normalized input
 * @returns {object} - Ready facts for the LLM
 */
function buildReadyFacts(input) {
  const match = input.match || {};
  const tender = input.tender || {};
  
  // Select top references using ranking algorithm
  const topReferences = selectReferences(input);
  
  // Extract numbers and names that will be allowed
  const certCount = match.certifications?.matching || 0;
  const engineerCount = match.engineers?.specialized || 0;
  const projectCount = (match.similar_projects || []).length;
  const certificates = match.certifications?.list || [];
  
  // Build team table rows (code does this, not LLM)
  const teamProfiles = match.engineers?.profiles || [];
  const teamRows = teamProfiles.map(profile => [
    profile.role || '[TO FILL: role]',
    String(profile.count || 0)
  ]);
  
  return {
    language: tender.language || 'fr',
    projectType: tender.project_type,
    
    // Numbers the LLM can use
    certifications: {
      count: certCount,
      list: certificates
    },
    engineers: {
      specialized: engineerCount,
      profiles: teamProfiles
    },
    projects: {
      count: projectCount,
      top: topReferences.map(p => ({
        name: p.name,
        client: p.client,
        year: p.year,
        result: p.result,
        stack: p.stack || []
      }))
    },
    
    // Evidence from input
    whyUs: match.why_us || [],
    
    // Team table (pre-built)
    teamTable: {
      columns: ['Rôle', 'Effectif'],
      rows: teamRows
    }
  };
}

/**
 * Validates Agent 5 output against all checks
 * @param {object} output - Agent 5 output envelope
 * @param {object} input - Original input
 * @returns {object} - { valid: boolean, violations: string[] }
 */
function validateOutput(output, input) {
  const violations = [];
  
  // 1. Schema check - must have exactly slides s4, s6, s7, s8
  if (!output.slides || !Array.isArray(output.slides)) {
    violations.push('output.slides must be an array');
    return { valid: false, violations };
  }
  
  const slideIds = output.slides.map(s => s.id);
  const expectedIds = ['s4', 's6', 's7', 's8'];
  
  if (slideIds.length !== 4 || !expectedIds.every(id => slideIds.includes(id))) {
    violations.push(`slides must be exactly [s4, s6, s7, s8], got [${slideIds.join(', ')}]`);
  }
  
  // 2. Get allowed numbers and names
  const allowedNumbers = getAllowedNumbers(input);
  const allowedNames = getAllowedNames(input);
  const allowedClaims = input.match?.why_us || [];
  const language = input.tender?.language || 'fr';
  
  // 3. Check each slide
  for (const slide of output.slides) {
    const slideId = slide.id;
    
    // Check all text in blocks
    if (slide.blocks) {
      for (let i = 0; i < slide.blocks.length; i++) {
        const block = slide.blocks[i];
        const blockPath = `slide ${slideId}.blocks[${i}]`;
        
        // Extract text from different block kinds
        let texts = [];
        if (block.text) texts.push(block.text);
        if (block.items) texts = texts.concat(block.items);
        if (block.rows) {
          block.rows.forEach(row => texts = texts.concat(row));
        }
        if (block.cards) {
          block.cards.forEach(card => {
            if (card.title) texts.push(card.title);
            if (card.text) texts.push(card.text);
          });
        }
        if (block.items && block.kind === 'kpis') {
          block.items.forEach(kpi => {
            if (kpi.label) texts.push(kpi.label);
            if (kpi.value) texts.push(kpi.value);
          });
        }
        
        // Check each text
        texts.forEach((text, j) => {
          const textPath = `${blockPath}[${j}]`;
          violations.push(...checkNumbers(text, allowedNumbers, textPath));
          violations.push(...checkNames(text, allowedNames, textPath));
          violations.push(...checkClaims(text, allowedClaims, language, textPath, allowedNames));
          violations.push(...checkPlaceholders(text, textPath));
        });
      }
    }
    
    // Check title
    if (slide.title) {
      violations.push(...checkNumbers(slide.title, allowedNumbers, `slide ${slideId}.title`));
      violations.push(...checkNames(slide.title, allowedNames, `slide ${slideId}.title`));
      violations.push(...checkClaims(slide.title, allowedClaims, language, `slide ${slideId}.title`));
    }
    
    // Special check for s7: project names must be exact
    if (slideId === 's7' && slide.blocks) {
      const projectNames = (input.match?.similar_projects || []).map(p => p.name);
      
      for (const block of slide.blocks) {
        if (block.kind === 'cards' && block.cards) {
          block.cards.forEach((card, i) => {
            if (card.title) {
              const isValidProject = projectNames.some(name => 
                card.title.toLowerCase().includes(name.toLowerCase()) ||
                name.toLowerCase().includes(card.title.toLowerCase())
              );
              if (!isValidProject && !card.title.includes('[TO FILL')) {
                violations.push(`slide s7.blocks.cards[${i}].title: "${card.title}" not found in similar_projects`);
              }
            }
          });
        }
      }
    }
  }
  
  return {
    valid: violations.length === 0,
    violations
  };
}

/**
 * Executes Agent 5 (mock mode for now)
 * @param {object} input - Normalized input
 * @param {object} options - { mode: 'mock'|'real', fixtures: {...} }
 * @returns {object} - Agent 5 envelope
 */
function executeAgent5(input, options = {}) {
  const { mode = 'mock', fixtures = {} } = options;
  
  // Build ready facts
  const readyFacts = buildReadyFacts(input);
  
  if (mode === 'mock') {
    // Return fixture for this input
    const inputId = input.tender?.id || 'unknown';
    const fixture = fixtures[inputId];
    
    if (!fixture) {
      // No fixture: return placeholder slides
      return {
        agent: 'credibility',
        ok: true,
        slides: [
          {
            id: 's4',
            type: 'content',
            title: 'Nos atouts',
            blocks: [{ kind: 'note', text: '[TO FILL: differentiators]' }],
            warnings: ['Mock mode: no fixture available']
          },
          {
            id: 's6',
            type: 'content',
            title: 'Équipe et gouvernance',
            blocks: [{ kind: 'note', text: '[TO FILL: team and governance]' }],
            warnings: ['Mock mode: no fixture available']
          },
          {
            id: 's7',
            type: 'content',
            title: 'Références pertinentes',
            blocks: [{ kind: 'note', text: '[TO FILL: relevant references]' }],
            warnings: ['Mock mode: no fixture available']
          },
          {
            id: 's8',
            type: 'content',
            title: 'Support et SLA',
            blocks: [{ kind: 'note', text: '[TO FILL: support and SLA]' }],
            warnings: ['Mock mode: no fixture available']
          }
        ],
        data: { evidence: [], readyFacts },
        assumptions: [],
        warnings: ['Mock mode: no fixture for input ' + inputId],
        usage: { model: 'mock', promptTokens: 0, completionTokens: 0, ms: 0, attempts: 1 }
      };
    }
    
    // Return fixture
    return {
      ...fixture,
      data: {
        ...(fixture.data || {}),
        readyFacts
      }
    };
  }
  
  return executeAgent5Real(input, readyFacts, options);
}

const AGENT5_PROMPT = `You are Agent 5 (credibility, "why us"). Write the sentences for four slides.
Code selects the reference projects and builds the team table; you only write text.

Return exactly this JSON:
{
  "differentiators": ["3 to 5 bullets, each tied to one fact from ready_facts or why_us"],
  "governance": ["3 generic governance bullets: no numbers, no names"],
  "references": [ { "name": "exact name from ready_facts.projects.top", "text": "max 35 words, only facts of that project" } ],
  "support": ["2 to 3 bullets on support and quality, no SLA numbers"],
  "assumptions": ["each governance proposal is an assumption, list them"],
  "evidence": [ { "claim": "a key claim you wrote", "source": "the input field it comes from" } ]
}
Never write SLA values, response times, percentages or counts that are not in the data.`;

function buildAgent5Slides(json, input, readyFacts) {
  const fr = readyFacts.language === 'fr';
  const list = (v, n) => (Array.isArray(v) ? v : []).filter(x => typeof x === 'string' && x.trim()).slice(0, n);
  const refs = Array.isArray(json.references) ? json.references : [];

  const cards = readyFacts.projects.top.slice(0, 3).map(p => {
    const written = refs.find(r => r && r.name === p.name);
    // The card title is the exact project name (code); the text falls back to the input result.
    return { title: p.name, text: (written && written.text) || p.result || '[TO FILL: description du projet]' };
  });

  const certs = readyFacts.certifications.list;
  const support = list(json.support, 3);
  if (certs.length) support.push(`${fr ? 'Certifications' : 'Certifications'} : ${certs.join(', ')}`);

  return [
    { id: 's4', type: 'content', title: fr ? 'Nos atouts' : 'Why us',
      blocks: [{ kind: 'bullets', items: list(json.differentiators, 5) }] },
    { id: 's6', type: 'content', title: fr ? 'Équipe et gouvernance' : 'Team and governance',
      blocks: [
        readyFacts.teamTable.rows.length
          ? { kind: 'table', columns: fr ? ['Rôle', 'Effectif'] : ['Role', 'People'], rows: readyFacts.teamTable.rows }
          : { kind: 'note', text: '[TO FILL: équipe projet]' },
        { kind: 'bullets', items: list(json.governance, 3) }
      ] },
    { id: 's7', type: 'content', title: fr ? 'Références pertinentes' : 'Relevant references',
      blocks: [{ kind: 'cards', cards: cards.length ? cards : [{ title: '[TO FILL: relevant reference projects]', text: '[TO FILL: description]' }] }] },
    { id: 's8', type: 'content', title: fr ? 'Support et SLA' : 'Support and SLA',
      blocks: [{ kind: 'bullets', items: support }] }
  ];
}

function agent5Envelope(json, input, readyFacts) {
  return {
    agent: 'credibility',
    ok: true,
    slides: buildAgent5Slides(json, input, readyFacts),
    data: { evidence: (json.evidence || []).filter(e => e && e.claim), readyFacts },
    assumptions: (json.assumptions || []).filter(a => typeof a === 'string'),
    warnings: []
  };
}

async function executeAgent5Real(input, readyFacts, options = {}) {
  const call = makeCaller(options);
  const system = buildSystemPrompt(AGENT5_PROMPT);
  const facts = { ...readyFacts, teamTable: undefined };
  const user = `Write the credibility text for this tender.\n${wrapTenderData({ tender: input.tender, why_us: readyFacts.whyUs, ready_facts: facts })}`;

  const loop = await runAgentLoop({
    call,
    maxAttempts: options.maxAttempts || 3, initialViolations: options.feedback,
    build: (violations) => ({ system, user: withFeedback(user, violations), temperature: 0.3, maxTokens: 2000 }),
    validate: (json) => {
      const v = validateOutput(agent5Envelope(json, input, readyFacts), input).violations;
      const names = readyFacts.projects.top.map(p => p.name);
      (json.references || []).forEach((r, i) => {
        if (r && !names.includes(r.name)) v.push(`references[${i}].name "${r && r.name}" must be one of: ${names.join(' | ')}`);
      });
      return v;
    }
  });

  const env = agent5Envelope(loop.json || {}, input, readyFacts);
  if (!loop.ok) {
    env.slides.forEach(slide => slide.blocks.forEach((b, bi) => {
      const path = `${slide.id}.blocks[${bi}]`;
      const fix = (t, label, sub) => {
        if (typeof t === 'string' && t.startsWith('[TO FILL')) return t;
        const r = scrubText(t, input, label, `${path}${sub}`);
        env.warnings.push(...r.violations.slice(0, 3));
        return r.text;
      };
      if (b.kind === 'bullets') b.items = b.items.map((t, i) => fix(t, 'point clé', `.items[${i}]`));
      if (b.kind === 'cards') b.cards.forEach((c, i) => { c.text = fix(c.text, 'description du projet', `.cards[${i}]`); });
    }));
    env.warnings.push(loop.json
      ? `Agent 5 : ${loop.violations.length} problème(s) après ${loop.attempts} essais, textes concernés remplacés par [TO FILL]`
      : `Agent 5 : LLM indisponible (${loop.error}), diapositives à compléter`);
  }
  env.ok = loop.ok;
  env.usage = { model: loop.model, promptTokens: loop.usage.promptTokens, completionTokens: loop.usage.completionTokens,
                ms: loop.ms, attempts: loop.attempts, rateLimitWaits: loop.rateLimitWaits };
  return env;
}

// Export for CommonJS (n8n Code nodes) and ES modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildReadyFacts,
    validateOutput,
    executeAgent5,
    executeAgent5Real,
    buildAgent5Slides
  };
}
