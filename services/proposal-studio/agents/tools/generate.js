#!/usr/bin/env node
/**
 * generate.js - Run the whole agent chain without n8n and print the editor link.
 *
 *   node agents/tools/generate.js <input.json> [--template <id>] [--mock|--real]
 *
 * Same code as the n8n workflows (agents/lib/pipeline.js). The platform uses it when
 * GENERATE_MODE=cli; the input then carries runId/template/params and the progress is pushed
 * to the platform. Settings come from the environment, like in n8n: STUDIO_BASE_URL,
 * STUDIO_API_KEY, LLM_MODE, GROQ_API_KEY, GROQ_MODEL, GROQ_BASE_URL, PUBLIC_EDITOR_URL,
 * QR_URL_TEMPLATE, MAX_CORRECTION_ROUNDS, AGENTS_REGISTRY_DIR, DEFAULT_TEMPLATE.
 */
const fs = require('fs');
const path = require('path');
const pipeline = require('../lib/pipeline.js');
const registry = require('../lib/registry.js');

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
if (!file) {
  console.error('usage: node agents/tools/generate.js <input.json> [--template <id>] [--mock|--real]');
  process.exit(2);
}
const env = process.env;
const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
const ti = args.indexOf('--template');
if (ti >= 0 && args[ti + 1]) raw.template = args[ti + 1];
const mode = args.includes('--real') ? 'real' : (args.includes('--mock') ? 'mock' : (env.LLM_MODE === 'real' ? 'real' : 'mock'));

const cfg = {
  mode,
  projectDir: path.resolve(__dirname, '..', '..'),
  llm: {
    apiKey: env.GROQ_API_KEY, model: env.GROQ_MODEL, baseUrl: env.GROQ_BASE_URL || undefined,
    maxRateLimitWaits: parseInt(env.LLM_MAX_RATE_LIMIT_WAITS || '12', 10),
    models: { agent1: env.MODEL_AGENT1 || undefined, agent4: env.MODEL_AGENT4 || undefined, agent6: env.MODEL_AGENT6 || undefined }
  },
  studio: { baseUrl: (env.STUDIO_BASE_URL || 'http://localhost:8091').replace(/\/$/, ''), apiKey: env.STUDIO_API_KEY },
  publicEditorUrl: (env.PUBLIC_EDITOR_URL || env.STUDIO_BASE_URL || 'http://localhost:8091').replace(/\/$/, ''),
  qrUrlTemplate: env.QR_URL_TEMPLATE || '',
  maxCorrectionRounds: env.MAX_CORRECTION_ROUNDS ? parseInt(env.MAX_CORRECTION_ROUNDS, 10) : 2,
  registryDir: env.AGENTS_REGISTRY_DIR || registry.REGISTRY_DIR,
  defaultTemplate: env.DEFAULT_TEMPLATE || null
};

(async () => {
  const t0 = Date.now();
  const state = pipeline.prepare(raw, cfg);
  for (const stage of pipeline.STAGES) {
    process.stdout.write(`${stage}... `);
    await pipeline.runStage(state, stage, cfg);
    const e = state.log[state.log.length - 1];
    console.log(`${e.status} (${Math.round(e.ms / 1000)} s)`);
  }
  process.stdout.write('review and publish... ');
  const res = await pipeline.finalize(state, cfg);
  console.log(res.ok ? 'done' : 'failed');
  if (res.ok) {
    console.log(`deck ${res.deckId}: ${res.editorUrl}`);
    console.log(`${res.contentSlides} content slides, ${res.placeholders} placeholders, ${res.warnings.length} warnings, `
      + `${res.usage.totalTokens} tokens, ${Math.round((Date.now() - t0) / 1000)} s`);
  } else {
    console.log(`error: ${res.error}`);
  }
  process.exit(res.ok ? 0 : 1);
})();
