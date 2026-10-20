// End-to-end run in a THROWAWAY n8n container (never your real instance): node test/e2e.js
// Needs: docker, the n8n image, Ollama on the host (qwen3:4b-instruct), and `node test/mock_server.js` running (Firecrawl + RAG stand-ins).
// Real: n8n engine, all Code nodes, the LLM, BOAMP + TED + French registry / DECP / Wikidata APIs, and the proposal studio when it runs
// on the host (tools/start_studio.ps1: the proposal inputs go to its inbox, the rank-1 tender's deck is started). Mocked: Firecrawl pages,
// web search, RAG.
// Output: test/out/execution.json (raw) and test/out/report.txt (per-node item counts, errors, run summary).
//
// STUDIO_AGENTS=n8n = webhook mode: the studio's deck agents (the teammate's 9 n8n workflows, read-only from STUDIO_DIR) and our
// "RFP - Refine Slide" run in THIS container too, as they would in production. First start the studio with
// `tools\start_studio.ps1 -Llm gemini -Generate webhook` (it creates test/.agents_webhook_key and sends Generate / Regenerate
// to http://127.0.0.1:5679). The container then listens on 127.0.0.1:N8N_TEST_PORT (5679; 5678 is your real n8n), reads the
// studio folder read-only, keeps the agents' registry in %USERPROFILE%\rfp-studio-data\registry (REGISTRY_DIR, shared with
// cli mode, so decks made there can be refined too) and stays up after the run (the studio needs it; CLEANUP=1 removes it).
//   AGENTS_LLM=mock|gemini|groq   the agents' LLM (mock: placeholder slides, no calls; gemini: test/.gemini_key and Main's
//                                 "Model - Gemini" model; groq: test/.groq_key and "Model - Groq"); AGENTS_MODEL=... overrides
//   SKIP_MAIN=1 DECK_TENDER=<id>  no Main run: start the deck of that studio tender directly (a quick plumbing test)
//   REGEN=1                       then the studio's own Regenerate on one content slide (the teammate's RFP 60)
//   REFINE=1                      then our Refine Slide webhook with an instruction (REFINE_INSTRUCTION=...)
//   DECK_TIMEOUT=1500 (s), STUDIO_HOST_URL=http://127.0.0.1:8091, STUDIO_DIR=..., N8N_TEST_PORT=5679, CLEANUP=1
//   DRY=1 (or --dry-run)          print the checks and the planned docker / import / publish steps, start nothing
// Extra output: test/out/deck_generation.json and a "Deck (n8n agents)" report section; the exit code is 1 when the deck
// (or a requested regenerate / refine) failed.
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), { execSync, spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..'), OUT = path.join(__dirname, 'out');
const C = process.env.N8N_TEST_CONTAINER || 'rfp-n8n-test', IMAGE = process.env.N8N_IMAGE || 'docker.n8n.io/n8nio/n8n:latest';
const MOCK = process.env.MOCK_BASE || 'http://host.docker.internal:18080';
// DEMO_ADD=1: the demo tenders WITH the other sources (BOAMP, TED, URL agent). DEMO=1: the synthetic demo tenders only (start `node demo/server.js` first, port 8004), e.g. DEMO=1 RAG_URL=... MAX_BUYERS=0
// Optional real services:  RAG_URL=http://host.docker.internal:8001/retrieve/tender  (your RAG instead of the mock)
// Real Firecrawl + your real URL sources: put your Firecrawl key (fc-...) alone in test/.firecrawl_key (or env FIRECRAWL_KEY).
// The key is only written into the throwaway container's credential, never printed. A test run costs about 20 credits.
const RAG = process.env.RAG_URL || `${MOCK}/retrieve/tender`;
const KEY_FILE = path.join(__dirname, '.firecrawl_key');
// here or in the folder above (like the Gemini key); Notepad may add ".txt"
const keyFile = [KEY_FILE, path.join(ROOT, '..', 'test', '.firecrawl_key')].flatMap(f => [f, f + '.txt']).find(f => fs.existsSync(f));
const KEY = String(process.env.FIRECRAWL_KEY || (keyFile ? fs.readFileSync(keyFile, 'utf8') : ''))
  .replace(/^﻿/, '').replace(/^Bearer\s+/i, '').trim();                    // a BOM or a pasted "Bearer " prefix is fine
const REAL_WEB = /^fc-\S+$/.test(KEY);
// Gemini instead of the local Ollama model: put your Gemini API key (AIza...) alone in test/.gemini_key (here or in the
// folder above), or env GEMINI_KEY. Only written into the throwaway container's credential, never printed.
// GEMINI_MODEL=models/... picks another model than the one in the workflow.
const gemFile = [path.join(__dirname, '.gemini_key'), path.join(ROOT, '..', 'test', '.gemini_key')].flatMap(f => [f, f + '.txt']).find(f => fs.existsSync(f));
// LLM=ollama ignores the Gemini key (a free tier allows ~20 calls a day per model: too few for a full run)
const GEMINI = process.env.LLM === 'ollama' ? '' : String(process.env.GEMINI_KEY || (gemFile ? fs.readFileSync(gemFile, 'utf8') : '')).replace(/^﻿/, '').trim();
// Google keys exist in two formats ("AIza..." and the newer "AQ...."); a Firecrawl key ("fc-...") pasted by mistake is refused
if (GEMINI && (/^fc-/.test(GEMINI) || /\s/.test(GEMINI) || GEMINI.length < 30)) throw new Error(`${gemFile || 'GEMINI_KEY'} does not hold a Gemini API key (it holds a Firecrawl key or junk); nothing was run`);
// the proposal studio on the host (tools/start_studio.ps1 creates its key in test/.studio_key, here or in the folder above): the key
// is only written into the throwaway container's "Proposal Studio key" credential, never printed. STUDIO_URL = another studio;
// AUTO_DECK=none = no deck started by the run
const STUDIO = process.env.STUDIO_URL || 'http://host.docker.internal:8091';
const studioFile = [path.join(__dirname, '.studio_key'), path.join(ROOT, '..', 'test', '.studio_key')].flatMap(f => [f, f + '.txt']).find(f => fs.existsSync(f));
const STUDIO_KEY = String(studioFile ? fs.readFileSync(studioFile, 'utf8') : '').replace(/^﻿/, '').trim();
console.log(`mode: Firecrawl ${REAL_WEB ? 'REAL (your URL sources)' : 'mock (saved pages)'} | RAG ${RAG} | LLM ${GEMINI ? 'Gemini' : 'Ollama (local)'}`
  + ` | studio ${STUDIO} (key ${STUDIO_KEY ? 'found' : 'MISSING: its inbox will answer HTTP 401'})`);
const sh = (cmd, opts = {}) => execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 30, ...opts });
const put = (file, content) => sh(`docker exec -i ${C} sh -c "cat > ${file}"`, { input: content });
if (C === 'n8n') throw new Error('N8N_TEST_CONTAINER=n8n is your real n8n: this harness removes and restarts its container; pick another name');

// ---- webhook mode (STUDIO_AGENTS=n8n, see the top of this file)
const on = name => /^(1|true|yes)$/i.test(process.env[name] || '');
const AGENTS = process.env.STUDIO_AGENTS === 'n8n', DRY = on('DRY') || process.argv.includes('--dry-run');
const N8N_PORT = Number(process.env.N8N_TEST_PORT || 5679), N8N = `http://127.0.0.1:${N8N_PORT}`;   // the test n8n, seen from here
const STUDIO_DIR = path.resolve(process.env.STUDIO_DIR || 'C:/Users/yassin/Downloads/rfp-studio/rfp-studio');
const REGISTRY = path.resolve(process.env.REGISTRY_DIR || path.join(os.homedir(), 'rfp-studio-data', 'registry'));
const STUDIO_HOST = (process.env.STUDIO_HOST_URL || 'http://127.0.0.1:8091').replace(/\/+$/, '');   // the studio, seen from here
const DECK_TIMEOUT = Number(process.env.DECK_TIMEOUT || 1500), SKIP_MAIN = AGENTS && on('SKIP_MAIN'), DECK_TENDER = process.env.DECK_TENDER || '';
const REFINE_INSTRUCTION = process.env.REFINE_INSTRUCTION || "Rends cette diapositive plus concise et mets en avant l'expérience dans le secteur public";
// keys: same folders as above (+ .txt), never printed; they reach docker through its environment, never a command line
const keyIn = name => [path.join(__dirname, name), path.join(ROOT, '..', 'test', name)].flatMap(f => [f, f + '.txt']).find(f => fs.existsSync(f));
const readKey = file => String(file ? fs.readFileSync(file, 'utf8') : '').replace(/^\uFEFF/, '').trim();
const hookFile = keyIn('.agents_webhook_key'), HOOK_KEY = readKey(hookFile);   // MainWebhook / RegenWebhook = the studio's *_WEBHOOK_KEY
// the agents' OpenAI-compatible LLM (their settings are named GROQ_*): base URL, key file, Main's model node (its model by default)
const AGENT_LLMS = { gemini: ['https://generativelanguage.googleapis.com/v1beta/openai', '.gemini_key', 'Gemini'],
  groq: ['https://api.groq.com/openai/v1', '.groq_key', 'Groq'], mock: [] };
const AGENTS_LLM = (process.env.AGENTS_LLM || 'mock').toLowerCase();
const [LLM_BASE, LLM_KEY_NAME, LLM_NODE] = AGENT_LLMS[AGENTS_LLM] || [];
const llmKeyFile = LLM_KEY_NAME && keyIn(LLM_KEY_NAME), AGENTS_KEY = readKey(llmKeyFile);   // read even with LLM=ollama (Main only)
const modelOf = nodeName => (fs.readFileSync(path.join(ROOT, 'build.js'), 'utf8')
  .match(new RegExp(`node\\('Model - ${nodeName}'[^\\n]*?(?:modelName|model|value): '([^']+)'`)) || [])[1] || '';
const AGENTS_MODEL = process.env.AGENTS_MODEL || (LLM_NODE ? modelOf(LLM_NODE) : '');
if (AGENTS) console.log(`webhook mode: deck agents + Refine Slide in ${C} on ${N8N} | agents' LLM ${AGENTS_LLM}${AGENTS_MODEL ? ` (${AGENTS_MODEL})` : ''}`
  + ` | studio ${STUDIO_HOST} | ${SKIP_MAIN ? `no Main run, deck of tender ${DECK_TENDER || '?'}` : 'Main run, then its deck'}${on('REGEN') ? ' | REGEN' : ''}${on('REFINE') ? ' | REFINE' : ''}${DRY ? ' | DRY RUN' : ''}`);
// one synchronous HTTP call (this harness is a plain synchronous script): a child node runs fetch, the request (key headers
// included) goes through its stdin. Answer {status (0 = no answer), headers, text, json}
const FETCH_CHILD = "let s='';process.stdin.on('data',d=>s+=d).on('end',async()=>{const q=JSON.parse(s);try{const r=await fetch(q.url,{method:q.method,headers:q.headers,body:q.body,signal:AbortSignal.timeout(q.timeout)});const text=await r.text();process.stdout.write(JSON.stringify({status:r.status,headers:Object.fromEntries(r.headers),text}))}catch(e){process.stdout.write(JSON.stringify({status:0,headers:{},text:String((e&&e.message)||e)}))}})";
const http = (method, url, { body, headers = {}, timeout = 15000 } = {}) => {
  const req = { method, url, timeout, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers } };
  const res = spawnSync(process.execPath, ['-e', FETCH_CHILD], { input: JSON.stringify(req), encoding: 'utf8', timeout: timeout + 15000, maxBuffer: 1 << 28 });
  let r;
  try { r = JSON.parse(res.stdout); } catch { r = { status: 0, headers: {}, text: String((res.error && res.error.message) || res.stderr || 'no answer').slice(0, 300) }; }
  try { r.json = JSON.parse(r.text); } catch { r.json = null; }
  return r;
};
const pause = seconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
// ready = its database is migrated (/healthz/readiness; a version without it: /healthz)
const waitN8n = after => {
  const end = Date.now() + 90000;
  while (Date.now() < end) {
    const r = http('GET', `${N8N}/healthz/readiness`, { timeout: 5000 });
    if (r.status === 200 || (r.status === 404 && http('GET', `${N8N}/healthz`, { timeout: 5000 }).status === 200)) return;
    pause(2);
  }
  throw new Error(`the test n8n did not answer on ${N8N}/healthz within 90 s after its ${after} (docker logs ${C})`);
};
const STARTED = new Date().toISOString();
fs.mkdirSync(OUT, { recursive: true });
execSync('node build.js', { cwd: ROOT, stdio: 'inherit' });

// ---- test variants: same workflows, Config pointed at the mocks + fixture URL sources, TED enabled
const main = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist/RFP - Main.json'), 'utf8'));
const tools = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist/RFP - Research Tools.json'), 'utf8'));
const scoutTools = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist/RFP - Scout Tools.json'), 'utf8'));
const cfgNode = main.nodes.find(n => n.name === '00 - Config');
const swap = (s, a, b) => { if (!s.includes(a)) throw new Error('test patch not found: ' + a); return s.split(a).join(b); };
let js = cfgNode.parameters.jsCode;
js = swap(js, 'const FORCE_PRESET = null;', "const FORCE_PRESET = 'test';");
js = swap(js, "test:       { maxRecordsPerApi: 20,  maxPagesPerUrl: 1,", "test:       { maxRecordsPerApi: 20,  maxPagesPerUrl: 2,");
if (!REAL_WEB) js = swap(js, "firecrawl: { baseUrl: 'https://api.firecrawl.dev', intervalMs: 6500 }", `firecrawl: { baseUrl: '${MOCK}', intervalMs: 200 }`);
js = swap(js, "rag: { url: 'http://host.docker.internal:8001/retrieve/tender'", `rag: { url: '${RAG}'`);
// the studio stays the one on the host (host.docker.internal:8091) unless STUDIO_URL says otherwise; the swap fails if Config moved it
js = swap(js, "const STUDIO_URL = 'http://host.docker.internal:8091';", `const STUDIO_URL = '${STUDIO}';`);
if (process.env.AUTO_DECK) js = swap(js, "const AUTO_DECK = 'top1';", `const AUTO_DECK = '${process.env.AUTO_DECK}';`);
if (GEMINI) js = swap(js, "const LLM_PROVIDER = 'ollama';", "const LLM_PROVIDER = 'gemini';");
if (GEMINI && process.env.GEMINI_MODEL) main.nodes.find(n => n.name === 'Model - Gemini').parameters.modelName = process.env.GEMINI_MODEL;
// URL_SOURCES='[{"name":"x","country":"TN","language":"fr","url":"https://...","maxPages":2}]' = test these sites instead of
// the URL sources of Config (real Firecrawl only); ONLY_URL=1 = skip the API sources (a quicker run)
const URL_SOURCES = process.env.URL_SOURCES ? JSON.parse(process.env.URL_SOURCES).map(s => ({ type: 'url', enabled: true, ...s })) : null;
if (URL_SOURCES && !REAL_WEB) throw new Error('URL_SOURCES needs real Firecrawl (test/.firecrawl_key)');
if (process.env.DEMO) js = swap(js, 'const DEMO_MODE = false;', 'const DEMO_MODE = true;');
else js = swap(js, 'sources: sources.filter(s => (DEMO_MODE ? s.demo : s.enabled !== false)),', `sources: [
    ${process.env.ONLY_URL ? '' : `{ ...sources.find(s => s.name === 'boamp'), enabled: true },
    { ...sources.find(s => s.name === 'ted'), enabled: true },`}
    ${process.env.DEMO_ADD ? "{ ...sources.find(s => s.name === 'demo'), enabled: true }," : ''}
    ${URL_SOURCES ? JSON.stringify(URL_SOURCES).slice(1, -1) + ',' : REAL_WEB ? "...sources.filter(s => s.type === 'url' && s.enabled !== false)," :
    // fixture-fr starts at the HOME page: home -> "Marchés publics" menu -> tender list, then follows "Suivant" to page 2
    `{ type: 'url', name: 'fixture-fr', country: 'FR', language: 'fr', url: 'https://fixture.test/', maxPages: 2 },
    { type: 'url', name: 'fixture-ar', country: 'TN', language: 'ar', url: 'https://fixture.test/ar/tenders', maxPages: 1 },
    { type: 'url', name: 'fixture-en', country: 'TN', language: 'en', url: 'https://fixture.test/en/notice/ai-chatbot' },`}
  ]${process.env.KEEP_SOURCES ? `.filter(s => ${JSON.stringify(process.env.KEEP_SOURCES.split(','))}.includes(s.name))` : ''},`);
// a SMALL run (e.g. a free LLM tier with ~20 calls a day): KEEP_SOURCES=boamp,fixture-en MAX_RECORDS=3 MAX_BUYERS=1 MAX_MARKET=1
const lim = { maxRecordsPerApi: process.env.MAX_RECORDS, maxBuyersToResearch: process.env.MAX_BUYERS, maxMarketStudies: process.env.MAX_MARKET };
for (const [k, v] of Object.entries(lim)) if (v) js = js.replace(new RegExp(`(test: +\\{[^}]*${k}: )\\d+`), `$1${Number(v)}`);
cfgNode.parameters.jsCode = js;
if (!REAL_WEB) for (const n of [...tools.nodes, ...scoutTools.nodes]) if (n.parameters.url) n.parameters.url = n.parameters.url.replace('https://api.firecrawl.dev', MOCK);
Object.assign(main, { id: 'RfpMainTest00001', active: false });
Object.assign(tools, { id: 'QHV4m1jKm8fKBXNA', active: false });
Object.assign(scoutTools, { id: 'kJh2xit7vcFVsP7i', active: false });   // the id of your existing Scout Tools workflow
const creds = [
  { id: 'CfeiKFMFWXxIkMe6', name: 'Header Auth account', type: 'httpHeaderAuth', data: { name: 'Authorization', value: `Bearer ${REAL_WEB ? KEY : 'test-key'}` } },
  { id: 'WJErbMQ0BDKh8uZB', name: 'Ollama account', type: 'ollamaApi', data: { baseUrl: 'http://host.docker.internal:11434' } },
  { id: 'aMTyXr6dYELQA8DQ', name: 'Google Gemini(PaLM) Api account', type: 'googlePalmApi', data: { host: 'https://generativelanguage.googleapis.com', apiKey: GEMINI || 'unused' } },
  { id: 'FPcfbtrrjsRjQcB5', name: 'Groq account', type: 'groqApi', data: { apiKey: 'unused' } },
  { id: '3oFuvY33PPiWwnf1', name: 'OpenAI account', type: 'openAiApi', data: { apiKey: 'unused' } },
  { id: 'XzG8ORjaa0RmjUCR', name: 'Anthropic account', type: 'anthropicApi', data: { apiKey: 'unused' } },
  { id: 'StudioKey0000001', name: 'Proposal Studio key', type: 'httpHeaderAuth', data: { name: 'X-API-Key', value: STUDIO_KEY || 'missing' } },
];

// ---- webhook mode: our Refine Slide workflow, the deck agents' two webhook credentials, the container and its checks
const refine = AGENTS ? JSON.parse(fs.readFileSync(path.join(ROOT, 'dist/RFP - Refine Slide.json'), 'utf8')) : null;
const REFINE_ID = refine ? refine.id : '';
if (refine && STUDIO !== 'http://host.docker.internal:8091') {
  const n = refine.nodes.find(x => x.name === 'Check request');
  n.parameters.jsCode = swap(n.parameters.jsCode, "const STUDIO_URL = 'http://host.docker.internal:8091';", `const STUDIO_URL = '${STUDIO}';`);
}
// the ids of the teammate's agents/n8n/credentials.example.json, the value of test/.agents_webhook_key (the studio's *_WEBHOOK_KEY)
if (AGENTS) creds.push(
  { id: 'rfpMainWebhook01', name: 'MainWebhook', type: 'httpHeaderAuth', data: { name: 'X-API-Key', value: HOOK_KEY || 'missing' } },
  { id: 'rfpRegenWebhook1', name: 'RegenWebhook', type: 'httpHeaderAuth', data: { name: 'X-API-Key', value: HOOK_KEY || 'missing' } });
// the deck agents' 9 workflows (fixed ids): sub-workflows and the error handler first, the two webhook workflows last
const STUDIO_WF = ['rfpErrors0000001', 'rfpAgent10000001', 'rfpDiagrams00001', 'rfpAgent40000001', 'rfpAgent50000001', 'rfpAgent60000001',
  'rfpLlmJson000001', 'rfpRegenerate001', 'rfpMain000000001'];
const REG_IN = '/home/node/.n8n/rfp-registry';   // the agents' registry inside the container (decks they can regenerate, errors.jsonl)
const agentsEnv = {
  N8N_DIAGNOSTICS_ENABLED: 'false', GENERIC_TIMEZONE: 'Europe/Paris',
  // the agents' Code nodes read their settings with $env and require fs / path; one stage may wait out rate limits (1200 s)
  N8N_BLOCK_ENV_ACCESS_IN_NODE: 'false', NODE_FUNCTION_ALLOW_BUILTIN: 'fs,path,crypto', N8N_RUNNERS_TASK_TIMEOUT: '1200',
  RFP_STUDIO_DIR: '/data/rfp-studio', AGENTS_REGISTRY_DIR: REG_IN, STUDIO_BASE_URL: STUDIO,
  PUBLIC_EDITOR_URL: process.env.PUBLIC_EDITOR_URL || 'http://localhost:8091',
  LLM_MODE: LLM_BASE ? 'real' : 'mock', ...(LLM_BASE ? { GROQ_BASE_URL: LLM_BASE, GROQ_MODEL: AGENTS_MODEL } : {}),
  MAX_CORRECTION_ROUNDS: '0', LLM_MAX_RATE_LIMIT_WAITS: '6',   // one pass per agent; at most about 63 s of 429 waits per call
  // the agents' webhooks output the request headers and n8n hides only authorization and cookie: a kept execution would
  // hold the webhook key (X-API-Key). Successful runs are not kept (n8n execute still prints its result); failed ones are
  EXECUTIONS_DATA_SAVE_ON_SUCCESS: 'none',
};
const secrets = { STUDIO_API_KEY: STUDIO_KEY, ...(LLM_BASE ? { GROQ_API_KEY: AGENTS_KEY } : {}) };   // bare -e NAME on the command line
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
// a running container made with other settings or keys (or by the old mode) is recreated
const FINGERPRINT = sha(JSON.stringify({ IMAGE, N8N_PORT, STUDIO_DIR, REGISTRY, agentsEnv, keys: Object.entries(secrets).map(([k, v]) => [k, sha(v)]) })).slice(0, 32);
const mount = (source, target, readonly) => `--mount "type=bind,source=${source},target=${target}${readonly ? ',readonly' : ''}"`;
const RUN_AGENTS = ['docker run -d', `--name ${C}`, '--add-host host.docker.internal:host-gateway', `-p 127.0.0.1:${N8N_PORT}:5678`,
  mount(STUDIO_DIR, '/data/rfp-studio', true), mount(REGISTRY, REG_IN, false), ...Object.entries(agentsEnv).map(([k, v]) => `-e ${k}=${v}`),
  ...Object.keys(secrets).map(k => `-e ${k}`), `--label rfp.e2e.fingerprint=${FINGERPRINT}`, IMAGE].join(' ');
// a folder of its own: /tmp/wf holds main.json and out.json, which --separate would import too
const IMPORT_AGENTS = 'n8n import:workflow --input=/tmp/wf/refine.json 2>&1 | tail -1; rm -rf /tmp/studio-wf && mkdir -p /tmp/studio-wf'
  + ' && cp /data/rfp-studio/workflows/[0-9]*.json /tmp/studio-wf/ && n8n import:workflow --separate --input=/tmp/studio-wf/ 2>&1 | tail -2';
// n8n 2 only runs published workflows, and an import unpublishes them: publish on every run (then restart for the webhooks)
const PUBLISH_AGENTS = `for id in ${[...STUDIO_WF, REFINE_ID].join(' ')}; do n8n publish:workflow --id=$id > /tmp/wf/publish.txt 2>&1`
  + ' || { echo publish failed: $id; tail -3 /tmp/wf/publish.txt; exit 1; }; done; echo published';

// checks on this machine before docker is touched: problems stop the run, notes are only printed
const preflight = () => {
  const problems = [], notes = [];
  if (!AGENT_LLMS[AGENTS_LLM]) problems.push(`AGENTS_LLM=${AGENTS_LLM}: use mock, gemini or groq`);
  if (!STUDIO_KEY) problems.push('no studio key: tools\\start_studio.ps1 creates Desktop\\claude\\test\\.studio_key');
  if (!HOOK_KEY) problems.push('no deck agents webhook key: tools\\start_studio.ps1 creates Desktop\\claude\\test\\.agents_webhook_key');
  if (!fs.existsSync(path.join(STUDIO_DIR, 'workflows', '00_main.json'))) problems.push(`no deck agent workflows in ${path.join(STUDIO_DIR, 'workflows')} (STUDIO_DIR=...)`);
  if (LLM_BASE && !AGENTS_KEY) problems.push(`AGENTS_LLM=${AGENTS_LLM}: put its API key alone in Desktop\\claude\\test\\${LLM_KEY_NAME}`);
  if (AGENTS_LLM === 'gemini' && AGENTS_KEY && (/^fc-/.test(AGENTS_KEY) || /\s/.test(AGENTS_KEY) || AGENTS_KEY.length < 30)) problems.push(`${llmKeyFile} does not hold a Gemini API key`);
  if (LLM_BASE && !AGENTS_MODEL) problems.push(`no model for the agents: "Model - ${LLM_NODE}" not found in build.js (set AGENTS_MODEL)`);
  if (SKIP_MAIN && !DECK_TENDER) problems.push('SKIP_MAIN=1 needs DECK_TENDER=<a tender id of the studio> (GET /api/tenders lists them)');
  if (!fs.existsSync(REGISTRY)) notes.push(`the registry folder ${REGISTRY} does not exist yet: it will be created`);
  const t = http('GET', `${STUDIO_HOST}/api/tenders`);
  if (t.status !== 200 || !t.json) {
    problems.push(`the studio does not answer at ${STUDIO_HOST} (start it: tools\\start_studio.ps1 -Generate webhook)`);
  } else {
    notes.push(`studio: ${(t.json.tenders || []).length} tender(s), its model list ${JSON.stringify(t.json.llmModels || [])}`);
    if (!t.json.generationEnabled) problems.push('the studio cannot generate decks (no GENERATE_WEBHOOK_URL): restart it with -Generate webhook');
    if (DECK_TENDER && !(t.json.tenders || []).some(x => x.id === DECK_TENDER)) problems.push(`the studio has no tender ${DECK_TENDER}`);
    const cfg = http('GET', `${STUDIO_HOST}/api/config`);
    if (!(cfg.json && cfg.json.hasRegenerate)) problems.push('the studio is not in webhook mode (no regenerate webhook): restart it with tools\\start_studio.ps1 -Generate webhook');
    const g = http('GET', `${STUDIO_HOST}/api/generations`);
    const busy = ((g.json && g.json.generations) || []).filter(x => x.status === 'queued' || x.status === 'running');
    if (busy.length) problems.push(`deck run ${busy[0].runId} is ${busy[0].status}: wait for it (a container restart would kill it; one deck at a time)`);
  }
  if (!SKIP_MAIN && MOCK === 'http://host.docker.internal:18080' && (!REAL_WEB || RAG === `${MOCK}/retrieve/tender`)
    && http('GET', 'http://127.0.0.1:18080/stats', { timeout: 3000 }).status !== 200) {
    notes.push('the Firecrawl / RAG mock is not running: start `node test/mock_server.js 18080` (Main uses it without a Firecrawl key or RAG_URL)');
  }
  return { problems, notes };
};

if (DRY && !AGENTS) {
  console.log(`DRY RUN (old mode, nothing started): container ${C} (reused when running, else docker run without port or mount), import`
    + ` ${creds.length} credentials and our 3 workflows, publish the two tool workflows, docker restart, n8n execute --id=RfpMainTest00001,`
    + ' report in test/out/report.txt. STUDIO_AGENTS=n8n DRY=1 shows the webhook mode.');
  process.exit(0);
}
if (AGENTS) {
  const { problems, notes } = preflight();
  for (const n of notes) console.log(`note: ${n}`);
  for (const p of problems) console.log(`PROBLEM: ${p}`);
  if (DRY) {
    const keyNote = (file, value) => `${file ? path.basename(file) : 'no key file'}, ${value ? 'found' : 'MISSING'}, never shown`;
    const wfDir = path.join(STUDIO_DIR, 'workflows');
    const plan = [
      [`container ${C}: reused when running with the label rfp.e2e.fingerprint=${FINGERPRINT}, else`, `docker rm -f ${C}`, RUN_AGENTS,
        `secret env, given to docker through its environment: STUDIO_API_KEY (${keyNote(studioFile, STUDIO_KEY)})`
        + (LLM_BASE ? `, GROQ_API_KEY (${keyNote(llmKeyFile, AGENTS_KEY)})` : '')],
      [`wait for ${N8N}/healthz/readiness (90 s); registry write test in ${REG_IN} (= ${REGISTRY})`],
      [`import ${creds.length} credentials (${creds.map(c => c.name).join(', ')}; MainWebhook and RegenWebhook = ${keyNote(hookFile, HOOK_KEY)})`
        + ' through stdin, deleted after; our 3 workflows; publish Research Tools and Scout Tools (as the old mode)',
        `docker exec ${C} sh -c "${IMPORT_AGENTS}"`,
        `deck agent workflows: ${fs.existsSync(wfDir) ? fs.readdirSync(wfDir).filter(f => /^\d.*\.json$/.test(f)).join(', ') : 'NOT FOUND'} + RFP - Refine Slide (${REFINE_ID})`],
      ['publish them', `docker exec ${C} sh -c "${PUBLISH_AGENTS}"`],
      [`docker restart ${C}; wait for ${N8N}/healthz/readiness; probes without a key: POST ${N8N}/webhook/rfp/generate and /webhook/rfp/regenerate`
        + ' (401 / 403 = registered, 404 = not published), POST /webhook/cstam/refine-slide {} (400 from Check request), its CORS preflight'],
      [`container -> studio: POST ${STUDIO}/api/generations/000000000000/progress with the container's key (404 = key accepted, 401 = wrong key);`
        + ' ls of the read-only studio mount'],
      [SKIP_MAIN ? `start the deck: POST ${STUDIO_HOST}/api/generations {"tenderId":"${DECK_TENDER}"}`
        : `run Main (unchanged): docker exec ${C} sh -c "N8N_RUNNERS_BROKER_PORT=5690 timeout 3000 n8n execute --id=RfpMainTest00001 ..."; its Start Deck starts the deck`],
      [`poll GET ${STUDIO_HOST}/api/generations/<runId> every 10 s (DECK_TIMEOUT ${DECK_TIMEOUT} s); GET ${STUDIO_HOST}/api/decks/<deckId> with the studio key`],
      ...(on('REGEN') ? [[`REGEN: POST ${STUDIO_HOST}/api/decks/<deckId>/slides/<k>/regenerate (k = an agent content slide of the registry)`]] : []),
      ...(on('REFINE') ? [[`REFINE: POST ${N8N}/webhook/cstam/refine-slide {deckId, slideIndex: k, instruction: "${REFINE_INSTRUCTION}"}, then GET ${STUDIO_HOST}/api/save/<deckId>: slide k changed?`]] : []),
      [`read ${path.join(REGISTRY, 'errors.jsonl')} and docker logs --tail 40 ${C}; write test/out/deck_generation.json and the "Deck (n8n agents)" report section`],
      [on('CLEANUP') ? `docker rm -f ${C} once the deck is done or failed (then restart the studio with -Generate cli)` : `keep ${C} running: the studio sends Generate and Regenerate to it`],
    ];
    console.log(['', 'DRY RUN: nothing started, no key shown. Plan:', ...plan.flatMap(([head, ...more], i) => [`${i + 1}. ${head}`, ...more.map(l => `     ${l}`)])].join('\n'));
    process.exit(problems.length ? 1 : 0);
  }
  if (problems.length) throw new Error(`webhook mode is not ready:\n- ${problems.join('\n- ')}`);
}

// ---- container
if (!AGENTS) {
  if (!sh(`docker ps --format "{{.Names}}"`).split(/\r?\n/).includes(C)) {
    try { sh(`docker rm -f ${C}`); } catch {}
    sh(`docker run -d --name ${C} --add-host host.docker.internal:host-gateway -e N8N_DIAGNOSTICS_ENABLED=false -e GENERIC_TIMEZONE=Europe/Paris ${IMAGE}`);
    sh(process.platform === 'win32' ? 'powershell -c "Start-Sleep 25"' : 'sleep 25');
  }
} else {
  const running = sh(`docker ps --format "{{.Names}}"`).split(/\r?\n/).includes(C);
  let labels = {};
  if (running) try { labels = JSON.parse(sh(`docker inspect -f "{{json .Config.Labels}}" ${C}`)) || {}; } catch {}   // labels only: the rest holds the env
  if (running && labels['rfp.e2e.fingerprint'] === FINGERPRINT) {
    console.log(`container ${C}: running with the same settings, reused`);
  } else {
    try { sh(`docker rm -f ${C}`); } catch {}
    fs.mkdirSync(REGISTRY, { recursive: true });
    sh(RUN_AGENTS, { env: { ...process.env, ...secrets } });
    console.log(`container ${C}: ${running ? 'recreated (other settings or keys)' : 'started'}, n8n on ${N8N}`);
  }
  waitN8n('start');
  const w = sh(`docker exec ${C} sh -c "touch ${REG_IN}/.e2e_write_test && rm -f ${REG_IN}/.e2e_write_test && echo writable || echo read-only"`).trim();
  console.log(`agents' registry ${REGISTRY} -> ${REG_IN}: ${w}`);
  if (w !== 'writable') throw new Error('the agents\' registry is not writable from the container: their decks could not be regenerated or refined');
}
sh(`docker exec ${C} mkdir -p /tmp/wf`);
put('/tmp/wf/creds.json', JSON.stringify(creds));
put('/tmp/wf/tools.json', JSON.stringify(tools));
put('/tmp/wf/scout.json', JSON.stringify(scoutTools));
put('/tmp/wf/main.json', JSON.stringify(main));
console.log(sh(`docker exec ${C} sh -c "n8n import:credentials --input=/tmp/wf/creds.json 2>&1 | tail -1; rm -f /tmp/wf/creds.json; n8n import:workflow --input=/tmp/wf/tools.json 2>&1 | tail -1; n8n import:workflow --input=/tmp/wf/scout.json 2>&1 | tail -1; n8n import:workflow --input=/tmp/wf/main.json 2>&1 | tail -1; n8n publish:workflow --id=QHV4m1jKm8fKBXNA 2>&1 | tail -1; n8n publish:workflow --id=kJh2xit7vcFVsP7i 2>&1 | tail -1"`));
if (AGENTS) {
  put('/tmp/wf/refine.json', JSON.stringify(refine));
  const imported = sh(`docker exec ${C} sh -c "${IMPORT_AGENTS}"`);
  console.log(imported.trim());
  if (!/imported 9 workflows/i.test(imported) || !/imported 1 workflow/i.test(imported)) throw new Error('Refine Slide and the deck agents\' 9 workflows were not all imported (see above)');
  try { console.log(sh(`docker exec ${C} sh -c "${PUBLISH_AGENTS}"`).trim()); }
  catch (e) { throw new Error(`publishing failed: ${String(e.stdout || e.message).trim().slice(-600)}`); }
}
if (!AGENTS) {
  sh(`docker restart ${C}`); sh(process.platform === 'win32' ? 'powershell -c "Start-Sleep 25"' : 'sleep 25');
} else {
  sh(`docker restart ${C}`);   // a webhook is registered only when n8n starts with its workflow published
  waitN8n('restart');
  // without a key: 401 / 403 = registered (the workflow does not start), 404 = not registered yet (retried for 30 s)
  const probe = (p, want) => {
    const end = Date.now() + 30000;
    for (;;) {
      const r = http('POST', `${N8N}/webhook/${p}`, { body: {} });
      if (want.includes(r.status)) return r;
      if ((r.status !== 404 && r.status !== 0) || Date.now() > end) throw new Error(`POST ${N8N}/webhook/${p} {} answered ${r.status}, not ${want.join(' or ')}: ${r.text.slice(0, 200)}`);
      pause(3);
    }
  };
  probe('rfp/generate', [401, 403]);
  probe('rfp/regenerate', [401, 403]);
  const bad = probe('cstam/refine-slide', [400]);
  console.log(`webhooks: rfp/generate and rfp/regenerate registered (key required); cstam/refine-slide {} -> 400 "${(bad.json && bad.json.message) || bad.text.slice(0, 80)}"`);
  const pre = http('OPTIONS', `${N8N}/webhook/cstam/refine-slide`, { headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  const allow = pre.headers['access-control-allow-origin'];
  console.log(`refine CORS preflight from http://localhost:5173: HTTP ${pre.status}, allow-origin ${allow || 'none'}${allow === 'http://localhost:5173' ? ' (ok)' : ' (CHECK)'}`);
  // container -> studio with the container's own key: 404 (unknown run, nothing written) = key accepted, 401 = another key
  const auth = sh(`docker exec ${C} node -e "fetch('${STUDIO}/api/generations/000000000000/progress',{method:'POST',headers:{'Content-Type':'application/json','X-API-Key':process.env.STUDIO_API_KEY||''},body:'{}'}).then(r=>console.log(r.status),e=>console.log('ERR '+e.message))"`).trim();
  if (auth === '401') throw new Error('the studio refused the container\'s STUDIO_API_KEY (the studio key changed? run again: the container is recreated)');
  if (auth !== '404') throw new Error(`the container cannot reach the studio at ${STUDIO}: ${auth}`);
  sh(`docker exec ${C} ls /data/rfp-studio/agents/prompts/agent1.md /data/rfp-studio/agents/catalog/pricing_catalog.json`);
  console.log(`container -> studio ${STUDIO}: key accepted; studio folder mounted read-only at /data/rfp-studio`);
}

// ---- Main (SKIP_MAIN=1: not run, the deck is started directly)
let mainLines = [], startDeck = [];
if (!SKIP_MAIN) {
  const t0 = Date.now();
  sh(`docker exec ${C} sh -c "N8N_RUNNERS_BROKER_PORT=5690 timeout 3000 n8n execute --id=RfpMainTest00001 --rawOutput > /tmp/wf/out.json 2>/tmp/wf/err.txt; echo done"`, { timeout: 3100 * 1000 });
  const raw = sh(`docker exec ${C} cat /tmp/wf/out.json`);
  fs.writeFileSync(path.join(OUT, 'execution.json'), raw);
  const errTxt = sh(`docker exec ${C} sh -c "tail -20 /tmp/wf/err.txt"`);

  // ---- report
  const lines = [`run took ${Math.round((Date.now() - t0) / 1000)} s`];
  const start = raw.indexOf('{');
  if (start < 0) { lines.push('NO JSON OUTPUT', raw.slice(0, 2000), errTxt); fs.writeFileSync(path.join(OUT, 'report.txt'), lines.join('\n')); console.log(lines.join('\n')); process.exit(1); }
  const d = JSON.parse(raw.slice(start));
  const rd = d.data.resultData;
  lines.push(`workflow error: ${rd.error ? rd.error.message + ' ' + (rd.error.description || '') : 'none'}`);
  for (const n of main.nodes.filter(x => !x.type.endsWith('stickyNote'))) {
    const runs = rd.runData[n.name];
    if (!runs) { lines.push(`${n.name.padEnd(36)} (not executed)`); continue; }
    const r = runs[runs.length - 1];
    const outs = ((r.data || {}).main || []).map(x => (x || []).length);
    const errs = ((r.data || {}).main || []).flat().filter(i => i && i.json && i.json.error).length;
    lines.push(`${n.name.padEnd(36)} runs=${runs.length} items=${JSON.stringify(outs)}${errs ? ` itemErrors=${errs}` : ''}${r.error ? ` NODE ERROR: ${r.error.message} ${r.error.description || ''}` : ''}`);
  }
  const last = name => { const runs = rd.runData[name]; return runs ? ((runs[runs.length - 1].data || {}).main || [[]])[0] || [] : []; };
  const summary = last('Run Summary')[0];
  if (summary) lines.push('', '==== Run Summary message', summary.json.message, '', JSON.stringify(summary.json.per_source, null, 1).slice(0, 6000));
  // the studio's answers: {status, id} per stored proposal input, {status, runId} for the deck (no key in them)
  const brief = j => (j.error ? `ERROR ${String(j.error.message || j.error).slice(0, 160)}` : JSON.stringify(j).slice(0, 160));
  lines.push('', '==== Proposal studio', ...last('Send to Proposal Service').map(i => `send  ${brief(i.json)}`), ...last('Start Deck').map(i => `deck  ${brief(i.json)}`));
  lines.push('', '==== stderr tail', errTxt);
  fs.writeFileSync(path.join(OUT, 'report.txt'), lines.join('\n'));
  console.log(lines.join('\n'));
  mainLines = lines;
  startDeck = last('Start Deck').map(i => i.json);
}

// ---- webhook mode: the deck the agents make in n8n, then the studio's Regenerate and our Refine Slide on it
if (AGENTS) {
  const out = { at: STARTED, agentsLlm: AGENTS_LLM, model: AGENTS_MODEL || null, n8n: N8N, studio: STUDIO_HOST, skipMain: SKIP_MAIN, tenderId: DECK_TENDER || null };
  const sec = ['', '==== Deck (n8n agents)'];
  let runId = '';
  if (SKIP_MAIN) {
    const r = http('POST', `${STUDIO_HOST}/api/generations`, { body: { tenderId: DECK_TENDER } });
    runId = (r.status === 202 && r.json && r.json.runId) || '';
    sec.push(`start: POST /api/generations {"tenderId":"${DECK_TENDER}"} -> HTTP ${r.status}${runId ? `, run ${runId}` : `: ${(r.json && r.json.message) || r.text.slice(0, 160)}`}`);
  } else {
    runId = (startDeck.find(j => j && j.runId) || {}).runId || '';
    if (!runId) sec.push(`no deck started by Main's Start Deck: ${startDeck.length ? JSON.stringify(startDeck[0]).slice(0, 200) : 'it did not run (no rank-1 tender stored, or AUTO_DECK=none)'}`);
  }
  out.runId = runId || null;
  let rec = null;
  if (runId) {
    const t1 = Date.now();
    let seen = '';
    for (;;) {
      const r = http('GET', `${STUDIO_HOST}/api/generations/${runId}`);
      if (r.status === 200 && r.json) {
        rec = r.json;
        const now = `${rec.status}${rec.step ? ` (${rec.step})` : ''}`;
        if (now !== seen) { console.log(`deck run ${runId}: ${now} after ${Math.round((Date.now() - t1) / 1000)} s`); seen = now; }
        if (rec.status === 'done' || rec.status === 'failed') break;
      }
      if (Date.now() - t1 > DECK_TIMEOUT * 1000) { sec.push(`TIMEOUT: the run is still ${rec ? rec.status : 'unknown'} after ${DECK_TIMEOUT} s`); break; }
      pause(10);
    }
    out.seconds = Math.round((Date.now() - t1) / 1000);
    out.generation = rec;
  }
  const deckId = rec && rec.status === 'done' && rec.deckId ? rec.deckId : '';
  if (rec) {
    sec.push(`run ${runId}: ${rec.status} after ${out.seconds} s${rec.error ? ` | error: ${rec.error}` : ''}${deckId ? ` | deck ${deckId}, editor ${STUDIO_HOST}${rec.url}` : ''}`,
      `steps: ${(rec.steps || []).map(s => `${s.agent} ${s.status}${s.ms != null ? ` ${s.ms} ms` : ''}`).join(' | ')}`);
    if (deckId) sec.push(`placeholders ${rec.placeholders} | problems remaining ${rec.problemsRemaining} | tokens ${rec.usage ? rec.usage.totalTokens : '?'}`);
    if ((rec.warnings || []).length) sec.push(`warnings (${rec.warnings.length}, first 10):`, ...rec.warnings.slice(0, 10).map(w => `  - ${String(w).slice(0, 200)}`));
  }
  // the deck as the studio stores it, and the agents' content slides of its registry entry (what Regenerate / Refine can change)
  let agentSlides = [];
  if (deckId) {
    const r = http('GET', `${STUDIO_HOST}/api/decks/${deckId}`, { headers: { 'X-API-Key': STUDIO_KEY } });
    out.deck = { deckId, httpStatus: r.status, slides: ((r.json && r.json.slides) || []).length, toFill: (r.text.match(/\[TO FILL/g) || []).length, editor: `${STUDIO_HOST}${rec.url}` };
    sec.push(`deck read: HTTP ${r.status}, ${out.deck.slides} slides, ${out.deck.toFill} [TO FILL] marker(s)`);
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(REGISTRY, `${deckId}.json`), 'utf8'));
      agentSlides = (entry.projectSlideMap || []).filter(m => /^s\d+[a-z]?$/.test(m.id) && m.of === 1).map(m => m.index);
    } catch (e) { sec.push(`registry entry ${path.join(REGISTRY, `${deckId}.json`)} not readable (${e.code || e.message}): Regenerate / Refine will answer 404`); }
    out.deck.agentSlides = agentSlides;
  }
  const pick = n => (agentSlides.length ? agentSlides[Math.min(n, agentSlides.length - 1)] : 1);
  if (deckId && on('REGEN')) {
    const k = pick(0);
    const r = http('POST', `${STUDIO_HOST}/api/decks/${deckId}/slides/${k}/regenerate`, { timeout: 75000 });
    const ok = r.status === 200 && !!r.json && r.json.status === 'ok';
    out.regen = { slideIndex: k, httpStatus: r.status, ok, message: (r.json && r.json.message) || null, warnings: (ok && r.json.slide && r.json.slide.warnings) || [] };
    sec.push(`regenerate (the studio's route, RFP 60) slide ${k}: HTTP ${r.status} ${ok ? 'ok' : `FAILED ${out.regen.message || r.text.slice(0, 160)}`}`
      + (out.regen.warnings.length ? ` | warnings: ${out.regen.warnings.slice(0, 3).join(' / ')}` : ''));
  }
  if (deckId && on('REFINE')) {
    const k = pick(1);
    const slideAt = () => { const r = http('GET', `${STUDIO_HOST}/api/save/${deckId}`); return ((r.json && r.json.slides) || [])[k]; };
    const sig = s => JSON.stringify(s || null, (key, v) => (key === 'id' ? undefined : v));   // element ids change on every layout
    const before = slideAt();
    const r = http('POST', `${N8N}/webhook/cstam/refine-slide`, { body: { deckId, slideIndex: k, instruction: REFINE_INSTRUCTION },
      headers: { Origin: 'http://localhost:5173' }, timeout: 120000 });
    const after = slideAt();
    const allow = r.headers['access-control-allow-origin'];
    out.refine = { slideIndex: k, instruction: REFINE_INSTRUCTION, httpStatus: r.status, answer: r.json || r.text.slice(0, 300),
      changed: !!after && sig(before) !== sig(after), notesHaveInstruction: !!after && String(after.notes || '').includes(REFINE_INSTRUCTION), corsAllowOrigin: allow || null };
    out.refine.ok = r.status === 200 && !!r.json && r.json.status === 'ok' && out.refine.changed && (!allow || allow === 'http://localhost:5173');
    sec.push(`refine (RFP - Refine Slide) slide ${k}: HTTP ${r.status} ${r.json && r.json.status === 'ok' ? 'ok' : `FAILED ${(r.json && r.json.message) || r.text.slice(0, 160)}`}`
      + ` | slide ${out.refine.changed ? 'changed' : 'NOT changed'} in the studio | notes ${out.refine.notesHaveInstruction ? 'carry' : 'lack'} the instruction`
      + ` | CORS allow-origin ${allow || 'not sent'}`);
    if (r.json && (r.json.warnings || []).length) sec.push(`  refine warnings: ${r.json.warnings.slice(0, 3).join(' / ')}`);
  }
  // failures the agents' error workflow (RFP 90) logged during this run, and the end of n8n's own log
  const errFile = path.join(REGISTRY, 'errors.jsonl');
  const fresh = (fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8').split(/\r?\n/) : [])
    .filter(l => { try { return JSON.parse(l).at >= STARTED; } catch { return false; } });
  out.errors = fresh.slice(-20);
  sec.push(`errors.jsonl: ${fresh.length} new line(s)`, ...fresh.slice(-10).map(l => `  ${l.slice(0, 300)}`));
  let logs = '';
  try { logs = sh(`docker logs --tail 40 ${C} 2>&1`); } catch (e) { logs = String(e.message).slice(0, 200); }
  out.ok = !!deckId && (!on('REGEN') || !!(out.regen && out.regen.ok)) && (!on('REFINE') || !!(out.refine && out.refine.ok));
  fs.writeFileSync(path.join(OUT, 'deck_generation.json'), JSON.stringify(out, null, 2));
  sec.push('', `deck test: ${out.ok ? 'PASSED' : 'FAILED'} (details in test/out/deck_generation.json)`);
  if (on('CLEANUP') && rec && rec.status !== 'done' && rec.status !== 'failed') {
    sec.push(`CLEANUP: ${C} kept, the deck is still running in it`);
  } else if (on('CLEANUP')) {
    sh(`docker rm -f ${C}`);
    sec.push(`CLEANUP: ${C} removed. The studio still sends Generate / Regenerate to it: restart it with tools\\start_studio.ps1 -Generate cli`);
  }
  sec.push('', '==== n8n container log (last 40 lines)', logs.trim());
  fs.writeFileSync(path.join(OUT, 'report.txt'), [...mainLines, ...sec].join('\n'));
  console.log(sec.join('\n'));
  if (!out.ok) process.exitCode = 1;
}
