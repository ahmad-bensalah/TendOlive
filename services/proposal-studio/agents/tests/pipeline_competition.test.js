/**
 * pipeline_competition.test.js - A tender with competition data must publish (regression:
 * the competitor slide was pushed before slidesWithIds existed, so the review step crashed).
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const pipeline = require('../lib/pipeline.js');
const { validateDeckSpec } = require('../lib/contracts.js');

test('v2 tender with competition: review and publish finish, no id sent, no competitor slide', async () => {
  const posted = [];
  const http = async (url, { method, body }) => {
    if (method === 'POST' && url.endsWith('/api/decks')) {
      posted.push(JSON.parse(body));
      return { status: 200, headers: {}, body: JSON.stringify({ id: 'deck0001', url: '/editor.html?id=deck0001', warnings: [] }) };
    }
    if (method === 'GET' && url.includes('/api/decks/')) return { status: 200, headers: {}, body: JSON.stringify({ slides: [] }) };
    return { status: 200, headers: {}, body: '{}' };
  };
  const cfg = { mode: 'mock', projectDir: path.resolve(__dirname, '..', '..'), http,
                studio: { baseUrl: 'http://fake', apiKey: 'k' }, maxCorrectionRounds: 0,
                registryDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rfp_reg_')) };
  const raw = { ...require('../fixtures/inputs/proposal_v2_example.json'), params: { includeCompetitorSlide: true } };
  const state = pipeline.prepare(raw, cfg);
  for (const stage of pipeline.STAGES) await pipeline.runStage(state, stage, cfg);
  const res = await pipeline.finalize(state, cfg);
  assert.strictEqual(res.ok, true, res.error);
  const spec = posted[0];
  assert.deepStrictEqual(validateDeckSpec(spec).errors, []);
  assert.ok(spec.slides.every(s => !('id' in s)), 'an internal slide id reached the platform');
  assert.ok(!spec.slides.some(s => /concurren|competit/i.test(s.title)), 'competitor slide must not be present');
});

test('daily provider quota: the run stops at once with a clear error, no deck is published', async () => {
  let llmCalls = 0;
  let posted = 0;
  const groq429 = JSON.stringify({ error: { message: 'Rate limit reached for model on tokens per day (TPD): Limit 200000, Used 199000. Please try again in 11m35.9s.' } });
  const http = async (url, { method }) => {
    if (url.includes('/chat/completions')) { llmCalls++; return { status: 429, headers: { 'retry-after': '695' }, body: groq429 }; }
    if (method === 'POST' && url.endsWith('/api/decks')) posted++;
    return { status: 200, headers: {}, body: '{}' };
  };
  const cfg = { mode: 'real', projectDir: path.resolve(__dirname, '..', '..'), http,
                llm: { apiKey: 'k', model: 'm', baseUrl: 'http://fake', transport: http, sleep: async () => {} },
                studio: { baseUrl: 'http://fake', apiKey: 'k' }, maxCorrectionRounds: 0 };
  const t0 = Date.now();
  const state = pipeline.prepare(require('../fixtures/inputs/proposal_v2_example.json'), cfg);
  for (const stage of pipeline.STAGES) await pipeline.runStage(state, stage, cfg);
  const res = await pipeline.finalize(state, cfg);
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /limite quotidienne.*réessayez dans 11m35/);
  assert.strictEqual(llmCalls, 1, 'one call, then no retries and no other agent calls');
  assert.strictEqual(posted, 0);
  assert.ok(Date.now() - t0 < 5000);
});
