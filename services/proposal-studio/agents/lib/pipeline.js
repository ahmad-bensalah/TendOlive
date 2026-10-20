/**
 * pipeline.js - The generate and regenerate chains, as stages that n8n Code nodes call.
 *
 * Stages (00_main.json runs them in this order, one sub-workflow per agent):
 *   prepare(rawInput, cfg)            normalize input, runId, fixture name, timings
 *   runStage(state, stage, cfg)       stage = agent1 | agent5 | diagrams | agent4
 *   finalize(state, cfg)              review + correction loop, merge, validate,
 *                                     POST /api/decks (400 handling), GET, registry, response
 * regenerate({ deckId, slideIndex }, cfg)  one slide spec for the platform's Regenerate button
 *
 * cfg = {
 *   mode: 'mock' | 'real',
 *   projectDir,                       rfp-studio folder (fixtures, catalog, test inputs)
 *   llm: { apiKey, model, baseUrl?, transport?, models: { agent1, agent4, agent6 } },
 *   studio: { baseUrl, apiKey },      platform; apiKey sent as X-API-Key
 *   http,                             transport (url, { method, headers, body, timeoutMs }) -> { status, headers, body }
 *   qrUrlTemplate, publicEditorUrl, maxCorrectionRounds, regenerateBudgetMs,
 *   registryDir                       where deck registry entries are kept (needed for regenerate)
 * }
 * Never throws: every failure becomes placeholders and warnings in the response.
 */

const fs = require('fs');
const path = require('path');
const { normalizeInput } = require('./input.js');
const { mergeDeck, createPlaceholderSlide } = require('./merge.js');
const { validateDeckSpec, validateSlideSpec } = require('./contracts.js');
const { createFetchTransport, callLLM } = require('./llm.js');
const agent1 = require('./agent1.js');
const agent5 = require('./agent5.js');
const diagrams = require('./diagrams.js');
const agent4 = require('./agent4.js');
const reviewer = require('./reviewer.js');
const registry = require('./registry.js');
const coverage = require('./coverage.js');
const profileLib = require('./profile.js');
const tokenBudget = require('./token_budget.js');

const STAGES = ['agent1', 'agent5', 'diagrams', 'agent4'];
const STAGE_OF_SLIDE = {
  s1: 'agent1', s2: 'agent1', s3: 'agent1', s11: 'agent1',
  s4: 'agent5', s6: 'agent5', s7: 'agent5', s8: 'agent5',
  s3b: 'diagrams', s3c: 'diagrams', s5: 'diagrams', s10: 'diagrams',
  s9: 'agent4'
};
const STAGE_OF_AGENT = {
  requirements: 'agent1', agent1: 'agent1', credibility: 'agent5', agent5: 'agent5',
  diagrams: 'diagrams', budget: 'agent4', agent4: 'agent4'
};

function nowMs() { return Date.now(); }

// ── helpers ────────────────────────────────────────────────────────────────

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (err) { return null; }
}

/** Name of the test input with the same tender.id (fixtures are named after test inputs). */
function fixtureName(projectDir, tenderId) {
  if (!projectDir || !tenderId) return null;
  const dirs = [path.join(projectDir, 'tests', 'inputs'), path.join(projectDir, 'agents', 'fixtures', 'inputs')];
  for (const dir of dirs) {
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch (err) { continue; }
    for (const f of files) {
      const data = readJson(path.join(dir, f));
      if (data && data.tender && data.tender.id === tenderId) return f.replace(/\.json$/, '');
    }
  }
  return null;
}

/** agents/config/company_profile.json (cfg.profile overrides, for tests). */
function loadProfile(cfg) {
  if (cfg.profile) return cfg.profile;
  return readJson(path.join(cfg.projectDir || '', 'agents', 'config', 'company_profile.json'));
}

function loadCatalog(cfg) {
  return readJson(path.join(cfg.projectDir || '', 'agents', 'catalog', 'pricing_catalog.json')) || {
    last_updated: '[TO FILL: date]', currency: 'EUR',
    daily_rates: { backend: 0, frontend: 0, devops: 0, pm: 0, designer: 0, qa: 0 },
    cloud: {}, api: {}, licenses: {}, support_percent_of_build: 0, contingency_percent: 0, margin_percent: 0,
    workdays_per_week: 5
  };
}

function llmOptions(cfg, stage, state) {
  const llm = cfg.llm || {};
  // Model chosen in the "Générer le deck" dialog overrides the configured one for every stage
  const chosen = state && state.params && typeof state.params.model === 'string' && state.params.model;
  const model = chosen || (llm.models && llm.models[stage]) || llm.model;
  return { ...llm, model };
}

/** LLM caller for a stage that records a provider quota error on the run (then the run stops). */
function quotaAwareCaller(state, cfg, stage) {
  const llm = llmOptions(cfg, stage, state);
  return async (req) => {
    const res = await callLLM({ ...req, model: req.model || llm.model }, llm);
    if (res && res.quotaExceeded) state.quotaError = res.error;
    return res;
  };
}

/** Envelope with placeholder slides for a stage that failed. */
function failedEnvelope(stage, language, reason) {
  const ids = Object.keys(STAGE_OF_SLIDE).filter(id => STAGE_OF_SLIDE[id] === stage);
  return {
    agent: stage, ok: false,
    slides: ids.map(id => ({ ...createPlaceholderSlide(id, language), warnings: [`Diapositive non générée : ${reason}`] })),
    data: {}, assumptions: [], warnings: [reason],
    usage: { model: null, promptTokens: 0, completionTokens: 0, ms: 0, attempts: 0 }
  };
}

/** mergeDeck skips envelopes with ok:false; keep their slides (placeholders or scrubbed text) anyway. */
function forMerge(env) {
  return env && Array.isArray(env.slides) && env.slides.length ? { ...env, ok: true } : (env || { ok: false });
}

async function httpJson(cfg, method, urlPath, body) {
  const transport = cfg.http || createFetchTransport();
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.studio && cfg.studio.apiKey) headers['X-API-Key'] = cfg.studio.apiKey;
  try {
    const res = await transport(`${(cfg.studio && cfg.studio.baseUrl) || 'http://localhost:8091'}${urlPath}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), timeoutMs: 30000
    });
    let json = null;
    try { json = JSON.parse(res.body); } catch (err) { /* keep null */ }
    return { status: res.status, json, text: res.body };
  } catch (err) {
    return { status: 0, json: null, text: `network error: ${err && err.message}` };
  }
}

// ── progress (pushed to the platform's generation record) ────────────────────

const STEP_ORDER = ['agent1', 'agent5', 'diagrams', 'agent4', 'agent6', 'publish'];

/** POST the run's progress to the platform when it started the run (state.genId). Never throws. */
async function report(state, cfg, patch) {
  if (!state.genId) return;
  try {
    await httpJson(cfg, 'POST', `/api/generations/${state.genId}/progress`, { steps: state.steps, ...patch });
  } catch (err) { /* progress is best effort */ }
}

function setStep(state, agent, status, extra = {}) {
  const st = state.steps.find(x => x.agent === agent);
  if (st) Object.assign(st, { status }, extra);
}

/** Run parameters from the platform: language, project type, deck name, QR link. */
function applyParams(input, params, warnings) {
  if (!params || typeof params !== 'object') return;
  const known = ['language', 'project_type', 'deckName', 'includeCompetitorSlide', 'qr_url', 'model'];
  Object.keys(params).filter(k => !known.includes(k)).forEach(k => warnings.push(`Unknown parameter ignored: ${k}`));
  if (params.language && params.language !== 'auto') input.tender.language = params.language;
  if (params.project_type && params.project_type !== 'auto') input.tender.project_type = params.project_type;
}

// ── stages ─────────────────────────────────────────────────────────────────

function prepare(rawInput, cfg = {}) {
  const started = nowMs();
  let normalized;
  try {
    normalized = normalizeInput(rawInput || {});
  } catch (err) {
    normalized = { input: { tender: {}, match: {}, theme: {} }, input_warnings: [`Input could not be read: ${err.message}`], suspicious_fields: [] };
  }
  
  // Token optimization (Phase S)
  const truncated = tokenBudget.truncateInput(normalized.input);
  const input = truncated.input;
  const warnings = [...(normalized.input_warnings || []), ...truncated.warnings];
  
  // Check token budget
  const budgetCheck = tokenBudget.checkTokenBudget(input, cfg.maxTokens || 15000);
  if (!budgetCheck.ok) {
    warnings.push(`⚠️ ${budgetCheck.reason} - some context may be lost`);
  }
  
  const raw = rawInput || {};
  input.tender = input.tender || {};
  applyParams(input, raw.params, warnings);
  // Template: from the platform (top-level "template"), the input options, or DEFAULT_TEMPLATE
  const template = typeof raw.template === 'string' ? raw.template
    : (raw.template === null ? null : (input.template || cfg.defaultTemplate || null));
  const genId = typeof raw.runId === 'string' && /^[a-f0-9]{12}$/.test(raw.runId) ? raw.runId : null;
  return {
    genId,
    template,
    params: raw.params && typeof raw.params === 'object' ? raw.params : {},
    steps: STEP_ORDER.map(agent => ({ agent, status: 'pending' })),
    runId: genId || `run_${started.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    mode: cfg.mode === 'real' ? 'real' : 'mock',
    input,
    inputWarnings: warnings,
    suspiciousFields: normalized.suspicious_fields || [],
    fixture: fixtureName(cfg.projectDir, input.tender && input.tender.id),
    outputs: {},
    log: [],
    timings: { startedAt: started },
    tokenEstimate: budgetCheck.estimatedTokens
  };
}

async function runAgent(stage, state, cfg, feedback) {
  const input = state.input;
  const language = (input.tender && input.tender.language) || 'fr';
  if (state.mode === 'mock') {
    const dir = { agent1: 'agent1', agent5: 'agent5', diagrams: 'diagrams', agent4: 'agent4' }[stage];
    const fixture = state.fixture && readJson(path.join(cfg.projectDir || '', 'agents', 'fixtures', dir, `${state.fixture}.json`));
    if (fixture) return fixture;
    return failedEnvelope(stage, language, 'mock mode: no fixture for this input');
  }
  if (state.quotaError) return failedEnvelope(stage, language, state.quotaError);
  const options = { mode: 'real', llm: llmOptions(cfg, stage, state), feedback, call: quotaAwareCaller(state, cfg, stage) };
  if (stage === 'agent1') return agent1.executeAgent1(input, options);
  if (stage === 'agent5') return agent5.executeAgent5(input, options);
  if (stage === 'diagrams') return diagrams.executeDiagramAgents(input, options);
  if (stage === 'agent4') {
    return agent4.executeAgent4(input, (state.outputs.diagrams && state.outputs.diagrams.data) || {}, loadCatalog(cfg), options);
  }
  throw new Error(`unknown stage ${stage}`);
}

async function runStage(state, stage, cfg = {}, feedback) {
  const started = nowMs();
  if (state.steps) {
    setStep(state, stage, 'running');
    await report(state, cfg, { status: 'running', step: stage });
  }
  if (stage === 'diagrams' && state.template && !state.templateTheme) {
    // Diagram colors follow the template's brand colors
    const t = await httpJson(cfg, 'GET', `/api/templates/${state.template}`);
    if (t.status === 200 && t.json && t.json.theme) {
      state.templateTheme = t.json.theme;
      state.input.theme = { ...(state.input.theme || {}), primary: t.json.theme.primary, secondary: t.json.theme.secondary };
    } else {
      state.inputWarnings.push(`Template ${state.template}: colors not available (HTTP ${t.status}), input theme used`);
    }
  }
  let env;
  try {
    env = await runAgent(stage, state, cfg, feedback);
  } catch (err) {
    env = failedEnvelope(stage, (state.input.tender && state.input.tender.language) || 'fr', `${stage} failed: ${err && err.message}`);
  }
  if (stage === 'agent1') {
    try { coverage.applyCoverage(env, state.input); } catch (err) { /* the coverage is optional */ }
  }
  try { profileLib.applyProfile(stage, env, loadProfile(cfg), state.input); } catch (err) { /* profile is optional */ }
  state.outputs[stage] = env;
  const usage = env.usage || {};
  state.log.push({
    runId: state.runId, tenderId: state.input.tender && state.input.tender.id, agent: stage,
    model: usage.model || null, promptTokens: usage.promptTokens || 0, completionTokens: usage.completionTokens || 0,
    ms: nowMs() - started, attempts: usage.attempts || 0, rateLimitWaits: usage.rateLimitWaits || 0,
    violations: env.ok ? 0 : (env.warnings || []).length, status: env.ok ? 'ok' : 'degraded', round: feedback ? 'correction' : 'first'
  });
  state.timings[stage] = nowMs() - started;
  if (state.steps) {
    setStep(state, stage, env.ok ? 'done' : 'degraded', { ms: nowMs() - started });
    await report(state, cfg, { status: 'running', step: stage });
  }
  return state;
}

function mergeState(state, cfg) {
  const o = state.outputs;
  const template = cfg.qrUrlTemplate || '';
  const merged = mergeDeck({
    agentOutputs: { agent1: forMerge(o.agent1), agent5: forMerge(o.agent5), diagrams: forMerge(o.diagrams), agent4: forMerge(o.agent4) },
    input: state.input, runId: state.runId, qr_url: template.includes('{deckId}') ? '' : template
  });
  
  // No competitive positioning slide (removed for all decks)

  const idByIndex = {};
  Object.entries(merged.metadata.slideIdMap).forEach(([id, i]) => { idByIndex[i] = id; });
  merged.slidesWithIds = merged.deckSpec.slides.map((s, i) => ({ ...s, id: idByIndex[i] || s.id }));
  if (template.includes('{deckId}')) {
    merged.warnings.push('QR_URL_TEMPLATE uses {deckId}, which is only known after creation: QR link left empty');
  }
  const profileQr = profileLib.qrUrl(loadProfile(cfg), state.input);
  if (profileQr && !merged.deckSpec.qr_url) merged.deckSpec.qr_url = profileQr;
  const params = state.params || {};
  if (typeof params.deckName === 'string' && params.deckName.trim()) merged.deckSpec.name = params.deckName.trim().slice(0, 80);
  if (typeof params.qr_url === 'string' && /^https?:\/\//.test(params.qr_url)) merged.deckSpec.qr_url = params.qr_url;
  if (state.template) {
    merged.deckSpec.template = state.template;
    delete merged.deckSpec.theme;   // the template provides the theme
  }
  return merged;
}

/** Replaces the slides named in `slides[i]...` messages by placeholders. Returns the replaced indexes. */
function replaceRejectedSlides(spec, slidesWithIds, messages, language, reasonPrefix) {
  const replaced = new Set();
  messages.forEach(msg => {
    const m = /^slides\[(\d+)\]/.exec(String(msg));
    if (!m) return;
    const i = Number(m[1]);
    if (replaced.has(i) || !spec.slides[i]) return;
    replaced.add(i);
    const id = slidesWithIds[i] && slidesWithIds[i].id;
    const { id: _drop, ...placeholder } = createPlaceholderSlide(id || 's1', language);
    placeholder.title = spec.slides[i].title;
    placeholder.blocks = [{ kind: 'note', text: '[TO FILL: slide could not be generated]' }];
    placeholder.warnings = [`${reasonPrefix} : ${msg}`.slice(0, 300)];
    spec.slides[i] = placeholder;
    if (slidesWithIds[i]) slidesWithIds[i] = { ...placeholder, id };
  });
  return [...replaced];
}

function countPlaceholders(spec) {
  const text = JSON.stringify(spec.slides);
  return (text.match(/\[TO FILL:/g) || []).length;
}

async function finalize(state, cfg = {}) {
  if (cfg.registryDir) registry.setRegistryDir(cfg.registryDir);
  const started = nowMs();
  if (state.quotaError) {
    // A deck written without the AI would be only placeholders: stop with a clear reason instead
    const result = { ok: false, runId: state.runId, deckId: null, url: null, editorUrl: null,
                     error: `Génération arrêtée : ${state.quotaError}. Changez de modèle (GROQ_MODEL) ou réessayez plus tard.`,
                     warnings: state.inputWarnings, placeholders: 0, problemsRemaining: 0,
                     usage: summarizeUsage(state.log), timings: {}, log: state.log };
    if (state.steps) {
      state.steps.forEach(st => { if (st.status === 'pending' || st.status === 'running') st.status = 'failed'; });
      await report(state, cfg, { status: 'failed', step: 'publish', error: result.error });
    }
    return result;
  }
  const input = state.input;
  const language = (input.tender && input.tender.language) || 'fr';
  const maxRounds = Number.isInteger(cfg.maxCorrectionRounds) ? cfg.maxCorrectionRounds : 2;

  if (state.steps) {
    setStep(state, 'agent6', 'running');
    await report(state, cfg, { status: 'running', step: 'agent6' });
  }
  const result = await finalizeInner(state, cfg, started, input, language, maxRounds);
  if (state.steps) {
    setStep(state, 'agent6', 'done');
    setStep(state, 'publish', result.ok ? 'done' : 'failed');
    await report(state, cfg, result.ok
      ? { status: 'done', step: 'publish', deckId: result.deckId, url: result.url, warnings: result.warnings.slice(0, 50),
          placeholders: result.placeholders, problemsRemaining: result.problemsRemaining, usage: result.usage, timings: result.timings }
      : { status: 'failed', step: 'publish', error: String(result.error || 'unknown error').slice(0, 300),
          warnings: result.warnings.slice(0, 50) });
  }
  return result;
}

async function finalizeInner(state, cfg, started, input, language, maxRounds) {
  // 1. Review and correction loop (only real mode re-runs agents)
  let merged = mergeState(state, cfg);
  let review = null;
  let rounds = 0;
  for (;;) {
    try {
      const rOptions = { mode: state.mode, llm: llmOptions(cfg, 'agent6', state), reviewModel: llmOptions(cfg, 'agent6', state).model,
                         call: quotaAwareCaller(state, cfg, 'agent6') };
      review = await reviewer.executeAgent6({ slides: merged.slidesWithIds }, input, state.outputs, rOptions);
    } catch (err) {
      review = { ok: false, allProblems: [], warnings: [`reviewer failed: ${err && err.message}`], usage: {} };
    }
    if (review.usage) {
      state.log.push({ runId: state.runId, tenderId: input.tender && input.tender.id, agent: 'agent6',
        model: review.usage.model || null, promptTokens: review.usage.promptTokens || 0,
        completionTokens: review.usage.completionTokens || 0, ms: review.usage.ms || 0,
        attempts: review.usage.attempts || 0, rateLimitWaits: review.usage.rateLimitWaits || 0,
        violations: (review.allProblems || []).length, status: 'ok', round: `review ${rounds + 1}` });
    }
    const problems = review.allProblems || [];
    if (state.mode !== 'real' || problems.length === 0 || rounds >= maxRounds) break;
    const byStage = {};
    problems.forEach(p => {
      const stage = STAGE_OF_AGENT[p.agent] || STAGE_OF_SLIDE[p.slide];
      if (!stage) return;
      (byStage[stage] = byStage[stage] || []).push(`Reviewer, slide ${p.slide}: ${p.issue}${p.fix ? ` (fix: ${p.fix})` : ''}`);
    });
    const stages = STAGES.filter(s => byStage[s]);
    if (!stages.length) break;
    rounds++;
    for (const stage of stages) await runStage(state, stage, cfg, byStage[stage]);
    merged = mergeState(state, cfg);
  }

  // 2. Remaining problems become slide warnings, never blocking
  const remaining = (review && review.allProblems) || [];
  const spec = merged.deckSpec;
  remaining.forEach(p => {
    const i = merged.slidesWithIds.findIndex(s => s.id === p.slide);
    if (i >= 0) {
      spec.slides[i].warnings = [...(spec.slides[i].warnings || []), `Revue : ${p.issue}`.slice(0, 200)];
    }
  });

  // 3. Local validation (mirror of the platform), then POST with one repair round
  const warnings = [...state.inputWarnings, ...merged.warnings, ...((review && review.warnings) || [])];
  const local = validateDeckSpec(spec);
  if (local.errors.length) {
    replaceRejectedSlides(spec, merged.slidesWithIds, local.errors, language, 'Contrôle local');
    warnings.push(...local.errors.map(e => `Local validation: ${e}`));
  }
  let post = await httpJson(cfg, 'POST', '/api/decks', spec);
  let attemptsPost = 1;
  if (post.status === 400 && post.json && Array.isArray(post.json.errors)) {
    const replaced = replaceRejectedSlides(spec, merged.slidesWithIds, post.json.errors, language, 'Refus plateforme');
    warnings.push(...post.json.errors.map(e => `Platform rejected: ${e}`));
    if (replaced.length) {
      post = await httpJson(cfg, 'POST', '/api/decks', spec);
      attemptsPost = 2;
    }
  }
  const timings = { ...state.timings, finalize: nowMs() - started, total: nowMs() - state.timings.startedAt };
  delete timings.startedAt;
  const usage = summarizeUsage(state.log);

  if (post.status !== 200 || !post.json || !post.json.id) {
    return {
      ok: false, runId: state.runId, deckId: null, url: null, editorUrl: null,
      error: post.status === 0 ? `Platform unreachable: ${post.text}`
        : `Platform answered HTTP ${post.status} after ${attemptsPost} attempt(s): ${String(post.text || '').slice(0, 500)}`,
      warnings, placeholders: countPlaceholders(spec), problemsRemaining: remaining.length,
      usage, timings, log: state.log
    };
  }

  // 4. Registry: map project slide indexes (with continuation slides) to spec slide ids
  const deckId = post.json.id;
  const project = await httpJson(cfg, 'GET', `/api/decks/${deckId}`);
  const platformSlides = (project.json && project.json.slides) || [];
  try {
    registry.storeDeck({
      deckId, runId: state.runId, tenderId: input.tender && input.tender.id, language,
      projectType: input.tender && input.tender.project_type, createdAt: new Date().toISOString(),
      input, specSlides: merged.slidesWithIds,
      projectSlideMap: registry.buildProjectSlideMap(platformSlides, merged.slidesWithIds),
      diagramsData: state.outputs.diagrams && state.outputs.diagrams.data
    });
    registry.purgeOldDecks(200);
  } catch (err) {
    warnings.push(`Registry not written (regeneration will not work for this deck): ${err && err.message}`);
  }

  return {
    ok: true, runId: state.runId, deckId, url: post.json.url,
    editorUrl: `${cfg.publicEditorUrl || (cfg.studio && cfg.studio.baseUrl) || ''}${post.json.url}`,
    contentSlides: spec.slides.length, projectSlides: platformSlides.length, correctionRounds: rounds,
    warnings, placeholders: countPlaceholders(spec), problemsRemaining: remaining.length,
    usage, timings, log: state.log
  };
}

function summarizeUsage(log) {
  const perAgent = {};
  let promptTokens = 0;
  let completionTokens = 0;
  log.forEach(e => {
    const a = perAgent[e.agent] || (perAgent[e.agent] = { promptTokens: 0, completionTokens: 0, calls: 0 });
    a.promptTokens += e.promptTokens;
    a.completionTokens += e.completionTokens;
    a.calls += 1;
    promptTokens += e.promptTokens;
    completionTokens += e.completionTokens;
  });
  // Cost needs real prices in agents/catalog/llm_prices.json: reported as null until then, never guessed
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, perAgent, estimatedCost: null };
}

/** Full chain in one call (used by tests and by tools; n8n splits it into sub-workflows). */
async function runAll(rawInput, cfg = {}) {
  const state = prepare(rawInput, cfg);
  for (const stage of STAGES) await runStage(state, stage, cfg);
  return finalize(state, cfg);
}

// ── regenerate ─────────────────────────────────────────────────────────────

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), ms); })
  ]);
}

/**
 * Returns { statusCode, body } where body is ONE slide spec (no id) on success.
 * Budget 45 s by default (the platform gives up after 60 s): diagrams re-runs get 40 s.
 * 
 * Request: { deckId, slideIndex, instruction? }
 * instruction (optional): "plus concis", "développer", "reformuler", etc. Modifies the prompt but facts stay locked.
 */
async function regenerate(request, cfg = {}) {
  if (cfg.registryDir) registry.setRegistryDir(cfg.registryDir);
  const deckId = request && request.deckId;
  const slideIndex = Number(request && request.slideIndex);
  const instruction = typeof request.instruction === 'string' && request.instruction.trim() ? request.instruction.trim().slice(0, 200) : null;
  if (!deckId || !/^[A-Za-z0-9_-]{1,64}$/.test(String(deckId)) || !Number.isInteger(slideIndex)) {
    return { statusCode: 400, body: { status: 'error', message: 'deckId and integer slideIndex are required' } };
  }
  const entry = registry.getDeck(deckId);
  if (!entry) return { statusCode: 404, body: { status: 'error', message: `Unknown deck ${deckId} (not created by this n8n)` } };
  const mapping = registry.mapSlideIndexToSpec(deckId, slideIndex);
  if (!mapping || !mapping.slide || !STAGE_OF_SLIDE[mapping.specSlideId]) {
    return { statusCode: 400, body: { status: 'error', message: `Slide ${slideIndex} cannot be regenerated (fixed or unknown slide)` } };
  }
  const id = mapping.specSlideId;
  const stage = STAGE_OF_SLIDE[id];
  const current = mapping.slide;
  const keepCurrent = (reason) => {
    const { id: _drop, ...spec } = current;
    return { statusCode: 200, body: { ...spec, warnings: [...(spec.warnings || []), reason] } };
  };

  const state = {
    runId: `regen_${Date.now().toString(36)}`, mode: cfg.mode === 'real' ? 'real' : 'mock', input: entry.input,
    inputWarnings: [], suspiciousFields: [], fixture: fixtureName(cfg.projectDir, entry.input && entry.input.tender && entry.input.tender.id),
    outputs: { diagrams: { data: entry.diagramsData || {} } }, log: [], timings: { startedAt: Date.now() }
  };
  const budget = stage === 'diagrams' ? 40000 : (cfg.regenerateBudgetMs || 45000);
  // Pass instruction as feedback (the checks will still enforce facts)
  const feedback = instruction ? [`User instruction: ${instruction}`] : undefined;
  const result = await withTimeout(runStage(state, stage, cfg, feedback), budget);
  if (result && result.timedOut) return keepCurrent('Régénération trop longue : slide inchangée');

  const env = state.outputs[stage];
  const fresh = env && (env.slides || []).find(s => s.id === id);
  if (!fresh) return keepCurrent('Régénération impossible : slide inchangée');
  const { id: _drop, ...spec } = fresh;
  if (mapping.of > 1) {
    spec.warnings = [...(spec.warnings || []), 'Cette diapositive était découpée en plusieurs parties : contenu complet replacé sur une seule diapositive'];
  }
  if (instruction) {
    spec.notes = (spec.notes || '') + `\n\nRégénération avec instruction : ${instruction}`;
  }
  const { errors } = validateSlideSpec(spec, 'slide');
  if (errors.length) return keepCurrent(`Régénération invalide (${errors[0]}) : slide inchangée`);
  if (!env.ok) spec.warnings = [...(spec.warnings || []), ...(env.warnings || []).slice(0, 3)];

  try {
    entry.specSlides = entry.specSlides.map(s => (s.id === id ? { ...spec, id } : s));
    registry.storeDeck(entry);
  } catch (err) { /* the slide is still returned */ }
  return { statusCode: 200, body: spec };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { STAGES, STAGE_OF_SLIDE, prepare, runStage, finalize, runAll, regenerate, fixtureName, summarizeUsage };
}
