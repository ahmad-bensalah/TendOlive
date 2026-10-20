/**
 * workflows.test.js - The generated n8n workflows: structure, embedded libs, and the
 * Code nodes executed the way n8n runs them (async function with $input, $env, this.helpers).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const WF = path.join(ROOT, 'workflows');
const EXPECTED = ['00_main.json', '10_agent1_requirements.json', '20_diagrams.json', '30_agent4_budget.json',
  '40_agent5_credibility.json', '50_agent6_reviewer.json', '60_regenerate.json', '70_llm_json.json', '90_error_handler.json'];

const load = (f) => JSON.parse(fs.readFileSync(path.join(WF, f), 'utf-8'));
const node = (wf, name) => wf.nodes.find(n => n.name === name);

/** Runs one Code node like n8n: `return` from an async body, $input.first(), $env, this.helpers. */
async function runCode(codeNode, inputJson, env, helpers) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction('$input', '$env', 'require', codeNode.parameters.jsCode);
  const $input = { first: () => ({ json: inputJson }), all: () => [{ json: inputJson }] };
  const out = await fn.call({ helpers }, $input, env, require);
  return out[0].json;
}

/** this.helpers.httpRequest stand-in backed by fetch (same options n8n receives). */
const helpers = {
  async httpRequest(o) {
    const res = await fetch(o.url, { method: o.method, headers: o.headers, body: o.body });
    const headers = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    return { statusCode: res.status, headers, body: await res.text() };
  }
};

test('all nine workflows exist and are valid n8n JSON', () => {
  for (const f of EXPECTED) {
    const wf = load(f);
    assert.ok(wf.name && Array.isArray(wf.nodes) && wf.connections, f);
    for (const [from, c] of Object.entries(wf.connections)) {
      assert.ok(node(wf, from), `${f}: connection from unknown node ${from}`);
      c.main[0].forEach(t => assert.ok(node(wf, t.node), `${f}: connection to unknown node ${t.node}`));
    }
  }
});

test('main calls every agent sub-workflow by its fixed id, in order', () => {
  const main = load('00_main.json');
  const calls = main.nodes.filter(n => n.type === 'n8n-nodes-base.executeWorkflow').map(n => n.parameters.workflowId.value);
  const ids = ['10_agent1_requirements.json', '40_agent5_credibility.json', '20_diagrams.json', '30_agent4_budget.json',
               '50_agent6_reviewer.json'].map(f => load(f).id);
  assert.deepStrictEqual(calls, ids);
});

test('embedded libs equal agents/lib (embed check)', () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'agents', 'tools', 'embed_check.js')], { encoding: 'utf-8' });
  assert.match(out, /EMBED CHECK PASSED/);
});

test('workflows contain no secrets, only credential names', () => {
  const text = EXPECTED.map(f => fs.readFileSync(path.join(WF, f), 'utf-8')).join('\n');
  assert.ok(!/gsk_[A-Za-z0-9]{10,}/.test(text));
  assert.ok(!/sk-[A-Za-z0-9]{20,}/.test(text));
  const startSh = fs.readFileSync(path.join(ROOT, 'start.sh'), 'utf-8');
  const devKey = (/STUDIO_API_KEY=([^\s"]+)/.exec(startSh) || [])[1];
  if (devKey) assert.ok(!text.includes(devKey), 'shared dev key found in a workflow');
  // Credentials are referenced by id and name only; no value is ever stored in a workflow
  ['00_main.json', '60_regenerate.json'].forEach(f => load(f).nodes.filter(n => n.credentials)
    .forEach(n => assert.deepStrictEqual(Object.keys(n.credentials.httpHeaderAuth).sort(), ['id', 'name'])));
});

// ── Code nodes against a fake platform ─────────────────────────────────────

function fakePlatform() {
  const decks = {};
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.headers['x-api-key'] !== 'wf-key') { res.statusCode = 401; return res.end('{"status":"error"}'); }
        if (req.method === 'POST' && req.url === '/api/decks') {
          const spec = JSON.parse(body);
          const id = `d${Object.keys(decks).length + 1}`;
          decks[id] = spec;
          return res.end(JSON.stringify({ id, url: `/editor.html?id=${id}`, warnings: [] }));
        }
        const m = /^\/api\/decks\/(\w+)$/.exec(req.url);
        if (req.method === 'GET' && m && decks[m[1]]) {
          const slides = [{ label: 'Titre' }, ...decks[m[1]].slides.map(s => ({ label: s.title.slice(0, 35) })), { label: 'Merci' }];
          return res.end(JSON.stringify({ slides }));
        }
        res.statusCode = 404;
        res.end('{}');
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

test('main chain (mock mode): Code nodes produce a deck and a working regenerate', async () => {
  const { srv, url } = await fakePlatform();
  const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfp-wf-registry-'));
  const savedEnv = process.env.AGENTS_REGISTRY_DIR;
  process.env.AGENTS_REGISTRY_DIR = registryDir;
  const env = { LLM_MODE: 'mock', RFP_STUDIO_DIR: ROOT, STUDIO_BASE_URL: url, STUDIO_API_KEY: 'wf-key',
                PUBLIC_EDITOR_URL: 'http://editor.test', AGENTS_REGISTRY_DIR: registryDir };
  try {
    const main = load('00_main.json');
    const input = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'inputs', 'software.json'), 'utf-8'));
    let state = await runCode(node(main, 'Prepare run'), { body: input }, env, helpers);
    for (const [file, name] of [['10_agent1_requirements.json', 'Run agent1'], ['40_agent5_credibility.json', 'Run agent5'],
                                ['20_diagrams.json', 'Run diagrams'], ['30_agent4_budget.json', 'Run agent4']]) {
      state = await runCode(node(load(file), name), JSON.parse(JSON.stringify(state)), env, helpers);
    }
    const out = await runCode(node(load('50_agent6_reviewer.json'), 'Review, correct and publish'), state, env, helpers);
    assert.strictEqual(out.statusCode, 200, JSON.stringify(out.body).slice(0, 400));
    assert.strictEqual(out.body.contentSlides, 12);   // class diagram slide (s3c) removed on request
    assert.strictEqual(out.body.editorUrl, `http://editor.test/editor.html?id=${out.body.deckId}`);

    const regen = await runCode(node(load('60_regenerate.json'), 'Regenerate slide'),
                                { body: { deckId: out.body.deckId, slideIndex: 4 } }, env, helpers);
    assert.strictEqual(regen.statusCode, 200, JSON.stringify(regen.body));
    assert.ok(regen.body.title && Array.isArray(regen.body.blocks));
    assert.strictEqual(regen.body.id, undefined);

    const fixed = await runCode(node(load('60_regenerate.json'), 'Regenerate slide'),
                                { body: { deckId: out.body.deckId, slideIndex: 0 } }, env, helpers);
    assert.strictEqual(fixed.statusCode, 400);
    const unknown = await runCode(node(load('60_regenerate.json'), 'Regenerate slide'),
                                  { body: { deckId: 'nope', slideIndex: 3 } }, env, helpers);
    assert.strictEqual(unknown.statusCode, 404);
  } finally {
    srv.close();
    if (savedEnv === undefined) delete process.env.AGENTS_REGISTRY_DIR; else process.env.AGENTS_REGISTRY_DIR = savedEnv;
    fs.rmSync(registryDir, { recursive: true, force: true });
  }
});

test('platform down: publish returns 502 with a clear error, never throws', async () => {
  const main = load('00_main.json');
  const env = { LLM_MODE: 'mock', RFP_STUDIO_DIR: ROOT, STUDIO_BASE_URL: 'http://127.0.0.1:9', STUDIO_API_KEY: 'x',
                AGENTS_REGISTRY_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'rfp-wf-')) };
  const input = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'inputs', 'thin.json'), 'utf-8'));
  const state = await runCode(node(main, 'Prepare run'), { body: input }, env, helpers);
  const out = await runCode(node(load('50_agent6_reviewer.json'), 'Review, correct and publish'), state, env, helpers);
  assert.strictEqual(out.statusCode, 502);
  assert.match(out.body.error, /unreachable/);
});
