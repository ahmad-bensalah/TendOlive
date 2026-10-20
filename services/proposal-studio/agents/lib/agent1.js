/**
 * agent1.js - Requirements analysis and solution proposal
 * 
 * Generates slides s1, s2, s3, s11
 * Code builds skeleton, LLM writes sentences
 */

const fs = require('fs');
const path = require('path');
const { checkSlide, getAllowedNumbers, getAllowedNames, scrubText } = require('./checks.js');
const { buildSystemPrompt, wrapTenderData, withFeedback, makeCaller, runAgentLoop } = require('./llm.js');
const { scanForInjection } = require('./input.js');

/**
 * Builds ready facts for Agent 1
 * These are pre-computed values the LLM can use directly
 */
function buildReadyFacts(input) {
  const facts = {
    requirement_count: 0,
    kpis: [],
    evidence_candidates: {},
    project_type: input.tender?.project_type || 'other',
    language: input.tender?.language || 'fr'
  };
  
  // Count requirements
  const requirements = input.tender?.requirements || [];
  facts.requirement_count = requirements.length;
  
  // Build KPIs from input facts only
  const similarProjectsCount = input.match?.similar_projects?.length || 0;
  if (similarProjectsCount > 0) {
    facts.kpis.push({
      label: facts.language === 'fr' ? 'Projets similaires' : 'Similar projects',
      value: String(similarProjectsCount)
    });
  }
  
  const matchScore = input.match?.score || 0;
  if (matchScore > 0) {
    facts.kpis.push({
      label: facts.language === 'fr' ? 'Score de correspondance' : 'Match score',
      value: `${Math.round(matchScore * 100)}%`
    });
  }
  
  const engineersCount = input.match?.engineers?.specialized || 0;
  if (engineersCount > 0) {
    facts.kpis.push({
      label: facts.language === 'fr' ? 'Ingénieurs spécialisés' : 'Specialized engineers',
      value: String(engineersCount)
    });
  }
  
  const certsCount = input.match?.certifications?.matching || 0;
  if (certsCount > 0) {
    facts.kpis.push({
      label: facts.language === 'fr' ? 'Certifications' : 'Certifications',
      value: String(certsCount)
    });
  }
  
  // Limit to 4 KPIs
  facts.kpis = facts.kpis.slice(0, 4);
  
  // Build evidence candidates per requirement
  const projects = input.match?.similar_projects || [];
  
  requirements.forEach((req, idx) => {
    const reqLower = req.toLowerCase();
    const candidates = [];
    
    // Match projects by stack or name overlap
    projects.forEach(proj => {
      const projName = proj.name || '';
      const projStack = (proj.stack || []).join(' ').toLowerCase();
      const projResult = (proj.result || '').toLowerCase();
      
      // Simple keyword matching
      const hasOverlap = 
        projStack.split(' ').some(tech => reqLower.includes(tech)) ||
        reqLower.split(' ').some(word => word.length > 4 && projResult.includes(word)) ||
        reqLower.includes('application') && projName.toLowerCase().includes('app');
      
      if (hasOverlap && projName) {
        candidates.push(projName);
      }
    });
    
    facts.evidence_candidates[idx] = candidates;
  });
  
  return facts;
}

/**
 * Prepares the prompt for Agent 1
 */
function preparePrompt(input, readyFacts) {
  const promptPath = path.join(__dirname, '..', 'prompts', 'agent1.md');
  const systemPrompt = fs.readFileSync(promptPath, 'utf-8');
  
  const userData = {
    tender: input.tender,
    match: input.match,
    matrix: input.matrix || null,
    buyer_profile: input.buyer_profile || null,
    ready_facts: readyFacts
  };
  
  return {
    system: systemPrompt,
    user: JSON.stringify(userData, null, 2)
  };
}

/**
 * Validates Agent 1 output
 */
function validateOutput(output, input, readyFacts) {
  const violations = [];
  
  if (!output || typeof output !== 'object') {
    return { valid: false, violations: ['Output is not an object'] };
  }
  
  if (!Array.isArray(output.slides)) {
    return { valid: false, violations: ['Output.slides is not an array'] };
  }
  
  // Check we have the expected slides
  const expectedIds = ['s1', 's2', 's3', 's11'];
  const foundIds = output.slides.map(s => s.id);
  
  for (const expectedId of expectedIds) {
    if (!foundIds.includes(expectedId)) {
      violations.push(`Missing slide ${expectedId}`);
    }
  }
  
  // Validate each slide
  output.slides.forEach(slide => {
    const slideViolations = checkSlide(slide, input, `slide ${slide.id}`);
    violations.push(...slideViolations);
    
    // Special check for s3: compliance matrix row count
    if (slide.id === 's3') {
      const tableBlock = slide.blocks?.find(b => b.kind === 'table');
      if (tableBlock) {
        const rowCount = tableBlock.rows?.length || 0;
        if (rowCount !== readyFacts.requirement_count) {
          violations.push(
            `s3 compliance matrix has ${rowCount} rows but should have ${readyFacts.requirement_count} (one per requirement)`
          );
        }
        
        // Check evidence is from candidates or placeholder
        const placeholders = input.tender?.language === 'fr' ? 
          ['à préciser', 'a préciser'] : 
          ['to clarify', 'to be clarified'];
        
        tableBlock.rows?.forEach((row, idx) => {
          const evidence = row[2]; // Third column
          if (!evidence) return;
          
          const evidenceLower = evidence.toLowerCase();
          const isPlaceholder = placeholders.some(p => evidenceLower.includes(p));
          
          if (!isPlaceholder) {
            const candidates = readyFacts.evidence_candidates[idx] || [];
            const projectNames = (input.match?.similar_projects || []).map(p => p.name);
            const allAllowed = [...candidates, ...projectNames];
            
            const isAllowed = allAllowed.some(name => 
              name && evidence.toLowerCase().includes(name.toLowerCase())
            );
            
            if (!isAllowed && evidence !== '[TO FILL: evidence]') {
              violations.push(
                `s3 row ${idx}: evidence "${evidence}" not in candidates or similar projects`
              );
            }
          }
        });
      } else {
        violations.push('s3 must have a table block for the compliance matrix');
      }
    }
    
  });
  
  // Check data object
  if (!output.data || typeof output.data !== 'object') {
    violations.push('Output must include data object');
  } else {
    if (!Array.isArray(output.data.requirement_list)) {
      violations.push('data.requirement_list must be an array');
    }
    if (!output.data.project_type) {
      violations.push('data.project_type is required');
    }
  }
  
  return {
    valid: violations.length === 0,
    violations
  };
}

/**
 * Runs Agent 1 (mock mode - returns fixture)
 */
function runAgent1Mock(input, inputId) {
  const fixturePath = path.join(__dirname, '..', 'fixtures', 'agent1', `${inputId}.json`);
  
  if (fs.existsSync(fixturePath)) {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
    return {
      ok: true,
      output: fixture,
      attempts: 1,
      mode: 'mock'
    };
  }
  
  return {
    ok: false,
    output: null,
    error: `Fixture not found: ${fixturePath}`,
    mode: 'mock'
  };
}

/**
 * Main Agent 1 execution function
 */
function executeAgent1(input, options = {}) {
  const { mode = 'mock', inputId = 'unknown', maxAttempts = 3 } = options;
  
  // Build ready facts
  const readyFacts = buildReadyFacts(input);
  
  // In mock mode, return fixture
  if (mode === 'mock') {
    return runAgent1Mock(input, inputId);
  }
  
  return executeAgent1Real(input, readyFacts, options);
}

const AGENT1_PROMPT = `You are Agent 1 (requirements and solution). Write the sentences for four slides.
Code builds the slides, tables and KPIs; you only write text.

Return exactly this JSON:
{
  "understanding": "2 to 3 sentences restating what the client wants",
  "benefits": ["3 key benefits for the client"],
  "needs": ["3 to 6 goals, pain points or constraints in the client's words"],
  "responses": [ { "response": "our answer to requirement i, max 20 words", "evidence": "a name from ready_facts.evidence_candidates[i] or empty" } ],
  "next_steps": ["3 generic next steps, no dates"],
  "assumptions": ["assumptions you made"]
}
"responses" has exactly one entry per requirement, in the same order.
Evidence must be copied exactly from the candidate list of that requirement, or be "".
Every bullet is 8 to 15 words. Never invent numbers, names, dates or certificates.`;

function buildAgent1Slides(json, input, readyFacts) {
  const lang = readyFacts.language;
  const fr = lang === 'fr';
  const requirements = input.tender?.requirements || [];
  const clarify = fr ? 'À préciser' : 'To clarify';
  const list = (v, n) => (Array.isArray(v) ? v : []).filter(x => typeof x === 'string' && x.trim()).slice(0, n);

  const s1Blocks = [{ kind: 'text', text: json.understanding || '' }];
  if (readyFacts.kpis.length) s1Blocks.push({ kind: 'kpis', items: readyFacts.kpis });
  s1Blocks.push({ kind: 'bullets', items: list(json.benefits, 3) });

  const responses = Array.isArray(json.responses) ? json.responses : [];
  const rows = requirements.map((req, i) => {
    // A requirement that looks like an instruction to the AI is shown as written but never answered
    if (scanForInjection(String(req)).length) {
      return [String(req), fr ? '[TO FILL: exigence suspecte, à vérifier]' : '[TO FILL: suspicious requirement, check it]', clarify];
    }
    const r = responses[i] || {};
    const candidates = readyFacts.evidence_candidates[i] || [];
    const evidence = candidates.find(c => c === (r.evidence || '').trim()) || clarify;
    return [String(req), String(r.response || ''), evidence];
  });

  return [
    { id: 's1', type: 'content', title: fr ? 'Synthèse exécutive' : 'Executive summary', blocks: s1Blocks },
    { id: 's2', type: 'content', title: fr ? 'Compréhension de vos besoins' : 'Understanding your needs',
      blocks: [{ kind: 'bullets', items: list(json.needs, 6) }] },
    { id: 's3', type: 'content', title: fr ? 'Solution proposée et conformité' : 'Proposed solution and compliance',
      blocks: rows.length
        ? [{ kind: 'table', columns: fr ? ['Exigence', 'Notre réponse', 'Preuve'] : ['Requirement', 'Our response', 'Evidence'], rows }]
        : [{ kind: 'note', text: '[TO FILL: requirements]' }] },
    { id: 's11', type: 'content', title: fr ? 'Prochaines étapes' : 'Next steps',
      blocks: [{ kind: 'bullets', items: list(json.next_steps, 3) }] }
  ];
}

function agent1Envelope(json, input, readyFacts) {
  const suspicious = (input.tender?.requirements || []).filter(r => scanForInjection(String(r)).length);
  return {
    agent: 'requirements',
    ok: true,
    slides: buildAgent1Slides(json, input, readyFacts),
    data: {
      requirement_list: input.tender?.requirements || [],
      project_type: readyFacts.project_type,
      key_features: (json.benefits || []).filter(b => typeof b === 'string')
    },
    assumptions: (json.assumptions || []).filter(a => typeof a === 'string'),
    warnings: suspicious.map(r => `Exigence suspecte (instruction pour l'IA ?), non traitée : "${String(r).slice(0, 80)}"`)
  };
}

/** Replaces every LLM sentence that still fails the checks by a placeholder. */
function scrubAgent1(env, input) {
  const warnings = [];
  const fix = (text, label, path) => {
    const r = scrubText(text, input, label, path);
    if (r.violations.length) warnings.push(...r.violations);
    return r.text;
  };
  env.slides.forEach(slide => {
    slide.blocks.forEach((b, bi) => {
      const path = `${slide.id}.blocks[${bi}]`;
      if (b.kind === 'text' && !b.text.startsWith('[TO FILL')) b.text = fix(b.text, 'texte', path);
      if (b.kind === 'bullets') b.items = b.items.map((t, i) => fix(t, 'point clé', `${path}.items[${i}]`));
      if (b.kind === 'table') b.rows = b.rows.map((row, ri) => [row[0], fix(row[1], 'réponse', `${path}.rows[${ri}]`), row[2]]);
    });
  });
  return warnings;
}

async function executeAgent1Real(input, readyFacts, options = {}) {
  const call = makeCaller(options);
  const system = buildSystemPrompt(AGENT1_PROMPT);
  const data = { tender: input.tender, match: input.match, ready_facts: readyFacts };
  const user = `Write the text for this tender.\n${wrapTenderData(data)}`;

  const loop = await runAgentLoop({
    call,
    maxAttempts: options.maxAttempts || 3, initialViolations: options.feedback,
    build: (violations) => ({ system, user: withFeedback(user, violations), temperature: 0.3, maxTokens: 2500 }),
    validate: (json) => {
      const env = agent1Envelope(json, input, readyFacts);
      const v = validateOutput(env, input, readyFacts).violations;
      const n = (input.tender?.requirements || []).length;
      if (!Array.isArray(json.responses) || json.responses.length !== n) {
        v.push(`responses must have exactly ${n} entries (one per requirement), got ${Array.isArray(json.responses) ? json.responses.length : 0}`);
      }
      return v;
    }
  });

  const env = agent1Envelope(loop.json || {}, input, readyFacts);
  if (!loop.ok) {
    env.warnings.push(...scrubAgent1(env, input).slice(0, 10));
    env.warnings.push(loop.json
      ? `Agent 1 : ${loop.violations.length} problème(s) après ${loop.attempts} essais, textes concernés remplacés par [TO FILL]`
      : `Agent 1 : LLM indisponible (${loop.error}), diapositives à compléter`);
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
    preparePrompt,
    validateOutput,
    executeAgent1,
    executeAgent1Real,
    buildAgent1Slides
  };
}
