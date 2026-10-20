// Replay test without n8n and without a model: node test/replay.js [recorded execution.json]
// Runs the CURRENT Code nodes of dist/RFP - Main.json in workflow order, emulating IF / Merge and item pairing, and feeds
// them the HTTP / LLM / agent answers RECORDED in a previous real n8n run (test/out/execution_run5.json by default).
// RAG calls go to the running mock (node test/mock_server.js). Use it after a code change when no model is available.
// Sources, preset limits and "today" come from the recording, so a run is replayed with the Config it ran with.
// A page or answer the recording does not have (e.g. a new hop of the URL loop) comes back as an error item.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const REC = process.argv[2] || path.join(__dirname, 'out', 'execution_run5.json');
const MOCK = process.env.MOCK_LOCAL || 'http://localhost:18080';
const RAG = process.env.RAG_LOCAL || MOCK + '/retrieve/tender';   // RAG_LOCAL=http://localhost:8001/retrieve/tender = your real RAG
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const wf = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist/RFP - Main.json'), 'utf8'));
const codeOf = name => wf.nodes.find(n => n.name === name).parameters.jsCode;
const raw = fs.readFileSync(REC, 'utf8');
const rec = JSON.parse(raw.slice(raw.indexOf('{'))).data.resultData.runData;
// all runs of a node, concatenated per output (the URL lane loops)
const recOut = name => { const outs = []; for (const run of rec[name] || []) ((run.data || {}).main || []).forEach((o, k) => (outs[k] ||= []).push(...(o || []).map(i => i.json))); return outs.length ? outs : [[]]; };

// ---- recorded answers, keyed by what identifies the request
const pairKeyed = (inName, outName, key, filter = () => true) => {
  const ins = recOut(inName)[0].filter(filter), outs = recOut(outName)[0], m = new Map();
  ins.forEach((x, i) => m.set(key(x), outs[i]));
  return m;
};
const R = {
  api: pairKeyed('API1 - Build Requests', 'API Fetch', x => `${x.source}|${x.page}`),
  // the scout agent's whole answer (final JSON + every open_page call and result), per source and start URL.
  // Recordings made before the agent (the numbered-links scout) have none: their URL lane replays empty.
  scout: pairKeyed('URL1 - Scout Tasks', 'Tender Scout Agent', x => `${x.source}|${x.url}`),
  detail: pairKeyed('URL3 - Links to URLs', 'Firecrawl Detail', x => x.url),
  extract: pairKeyed('URL4 - Build Extract Prompt', 'LLM - Extract', x => x.url),
  analysis: pairKeyed('Build Analysis Prompt', 'LLM - Analyze Tender', x => x.canonical_id, x => x._run),
  agent: pairKeyed('Select Buyers', 'Buyer Research Agent', x => x.buyer_key, x => x._run),
  market: pairKeyed('Select Market Studies', 'Competitor & Budget Agent', x => x.tender_id, x => x._market),
};
const missing = { error: 'no recorded answer' };

// ---- mini engine: runs[name] = [run0 items, run1 items, ...], item = {json, base:{node, run, index}}; outputs[name] = last run
const runs = {}, outputs = {};
let currentInput = [];
const runOf = (name, r) => { const rr = runs[name] || []; const k = r === undefined || r === -1 ? rr.length - 1 : r; if (!rr[k]) throw new Error(`Run ${k} of node "${name}" not found`); return rr[k]; };
const store = (name, items) => { (runs[name] ||= []).push(items); return (outputs[name] = items); };
const $ = name => ({
  all: (branch, r) => runOf(name, r).map(i => ({ json: i.json, binary: i.binary })),
  first: () => ({ json: runOf(name)[0].json }),
  itemMatching: i => { const b = currentInput[i] && currentInput[i].base; if (!b || b.node !== name) throw new Error(`itemMatching(${i}) to ${name}: no pairing (${b && b.node})`); return { json: runs[name][b.run][b.index].json }; },
});
const helpers = { prepareBinaryData: async (buf, fileName, mimeType) => ({ fileName, mimeType, bytes: buf.length }) };
async function code(name, input, patch = s => s) {
  currentInput = input;
  const fn = new AsyncFunction('$', '$input', '$execution', patch(codeOf(name)));
  const res = await fn.call({ helpers }, $, { all: () => input.map(i => ({ json: i.json })), first: () => ({ json: (input[0] || {}).json }) }, { mode: 'cli' });
  const run = (runs[name] || []).length;
  return store(name, res.map((r, index) => ({ json: r.json, binary: r.binary, base: { node: name, run, index } })));
}
const passthrough = (name, input, answer) => store(name, input.map(it => ({ json: answer(it.json), base: it.base })));
const split = (name, input, field = '_run') => { store(name, input); return [input.filter(i => i.json[field]), input.filter(i => !i.json[field])]; };
const merge = (name, ...inputs) => store(name, inputs.flat());
const post = async (url, body) => { try { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return await r.json(); } catch (e) { return { error: { message: e.message } }; } };

(async () => {
  const recCfg = recOut('00 - Config')[0][0];
  const cfgPatch = s => s.replace('const FORCE_PRESET = null;', "const FORCE_PRESET = 'test';")
    .replace("rag: { url: 'http://host.docker.internal:8001/retrieve/tender'", `rag: { url: '${RAG}'`);
  const cfg = await code('00 - Config', [{ json: {} }], cfgPatch);
  const c = cfg[0].json;   // the recorded run's sources, preset limits and date; everything else from the current code
  c.sources = recCfg.sources; c.today = recCfg.today; c.runId = recCfg.runId;
  for (const k of ['maxRecordsPerApi', 'maxPagesPerUrl', 'maxTendersPerUrlSource', 'maxBuyersToResearch', 'skipKnown']) if (k in recCfg.limits) c.limits[k] = recCfg.limits[k];
  const known = await code('02 - Collect Known IDs', cfg);
  // API lane
  const api1 = await code('API1 - Build Requests', known);
  const fetched = passthrough('API Fetch', api1, j => R.api.get(`${j.source}|${j.page}`) || missing);
  const api2 = await code('API2 - Map Records', fetched);
  // URL lane: URL1 Scout Tasks -> Tender Scout Agent (recorded) -> URL3 Links to URLs -> Firecrawl Detail
  const url1 = await code('URL1 - Scout Tasks', known);
  const agentOut = passthrough('Tender Scout Agent', url1, j => R.scout.get(`${j.source}|${j.url}`) || missing);
  const url3 = agentOut.length ? await code('URL3 - Links to URLs', agentOut) : [];
  const detail = passthrough('Firecrawl Detail', url3, j => R.detail.get(j.url) || missing);
  const url4 = await code('URL4 - Build Extract Prompt', detail);
  const extract = passthrough('LLM - Extract', url4, j => R.extract.get(j.url) || missing);
  const url5 = await code('URL5 - Verify Extraction', extract);
  // common
  const sources = merge('Merge Sources', api2, url5, known);
  const clean = await code('Clean & Dedupe', sources);
  const an1 = await code('Build Analysis Prompt', clean);
  const [toLlm, around] = split('Kept?', an1);
  const llm = passthrough('LLM - Analyze Tender', toLlm, j => R.analysis.get(j.canonical_id) || missing);
  const an2 = await code('Verify Analysis', merge('Merge Analysis', llm, around));
  const bu1 = await code('Select Buyers', an2);
  const [toAgent, skip] = split('Research?', bu1);
  const agent = passthrough('Buyer Research Agent', toAgent, j => R.agent.get(j.buyer_key) || missing);
  const bu2 = await code('Parse Research', agent);
  const rg1 = await code('Join Buyers & Build RAG', merge('Merge Buyers', bu2, skip));
  const [toRag, noRag] = split('Has requirements?', rg1);
  const ragAnswers = [];
  for (const it of toRag) ragAnswers.push({ json: await post(RAG, it.json.rag_body), base: it.base });
  store('Call RAG', ragAnswers);
  const rg2 = await code('Join RAG', merge('Merge RAG', ragAnswers, noRag));
  // market study: Select Market Studies -> Study market? -> Competitor & Budget Agent (recorded) -> Parse Market -> Merge Market
  const mk1 = await code('Select Market Studies', rg2);
  const [toMarket, noMarket] = split('Study market?', mk1, '_market');
  const mAgent = passthrough('Competitor & Budget Agent', toMarket, j => R.market.get(j.tender_id) || missing);
  const mk2 = mAgent.length ? await code('Parse Market', mAgent) : [];
  const mm = merge('Merge Market', mk2, noMarket);
  const ex1 = await code('Rank & Export', mm);
  const pr1 = await code('Build Proposal Input', ex1);   // runs before Run Summary (topmost branch in n8n v1 order)
  // the copy for the proposal studio; Send to Proposal Service and Start Deck are not replayed (Run Summary: "not sent")
  const pr2 = pr1.length ? await code('Adapt for Studio', pr1) : [];
  const ex2 = await code('Run Summary', ex1);

  // ---- report
  const J = a => a.map(i => i.json);
  const lines = [`replayed ${REC}`, ''];
  lines.push(`Scout agent: ${J(agentOut).map((r, i) => `${url1[i].json.source}: ${(r.intermediateSteps || []).length} page(s) opened${r.error ? ' (' + String(r.error.message || r.error).slice(0, 40) + ')' : ''}`).join(' | ')}`);
  lines.push(`API2 ${api2.length} items, URL3 ${url3.length} links, URL5 ${J(url5).filter(t => !t._type).length} tenders / ${J(url5).filter(t => t._type).length} rejected`);
  lines.push(`Clean kept ${J(clean).filter(t => t.status === 'kept').length}, dropped ${J(clean).filter(t => t.status === 'dropped').length}`);
  const a = J(an2).filter(t => t.analysis);
  lines.push(`Analysis: ${a.length} (${a.filter(t => t.analysis.status === 'failed').length} without recorded answer) | fit ${JSON.stringify(a.reduce((o, t) => (o[t.analysis.fit] = (o[t.analysis.fit] || 0) + 1, o), {}))} | survivors ${a.filter(t => t.survivor).length}`);
  lines.push(`Requirements kept ${a.reduce((s, t) => s + t.requirements.items.length, 0)}, dropped ${a.reduce((s, t) => s + t.requirements.dropped.length, 0)}: ${JSON.stringify(a.flatMap(t => t.requirements.dropped.map(d => d.why.slice(0, 40))))}`);
  lines.push(`Checks: ${JSON.stringify(a.flatMap(t => t.analysis.checks).reduce((o, c) => (o[c] = (o[c] || 0) + 1, o), {}))}`);
  lines.push('', 'Buyers researched (recorded agent answers):');
  for (const b of J(bu2)) lines.push(`  ${b.research_status.padEnd(16)} ${b.enrichment_status.padEnd(9)} ${b.name} | registry ${b.profile.legal_name || '-'} (${b.profile.registry.score}) | site ${b.profile.official_website || '-'} | projects ${b.profile.past_projects.length} | competitors ${b.profile.competitors.map(c => c.name).join(', ') || '-'} | budget ${b.profile.budget_signals ? b.profile.budget_signals.median : '-'} | ${b.profile.checks.slice(0, 2).join(' ; ')}`);
  lines.push('', `RAG calls ${toRag.length}; market studies ${toMarket.length} (${J(mk2).map(t => t.market.status).join(', ') || '-'}); export rows ${ex1.length}; files ${JSON.stringify(Object.keys(ex1[0].binary || {}))}; proposal inputs ${pr1.length}${pr1[0] && pr1[0].binary ? ' + file' : ''}`
    + `; studio copies ${pr2.length} (left out: ${JSON.stringify(J(pr2).reduce((o, x) => { for (const [k, n] of Object.entries(x.studio_adapter.dropped)) if (n) o[k] = (o[k] || 0) + n; return o; }, {}))})`);
  lines.push('', ex2[0].json.message);
  fs.writeFileSync(path.join(__dirname, 'out', 'replay_report.txt'), lines.join('\n'));
  fs.writeFileSync(path.join(__dirname, 'out', 'replay_tenders.json'), JSON.stringify({ to_detail: J(url3), tenders: J(mm), proposal_inputs: J(pr1) }, null, 1));
  fs.writeFileSync(path.join(__dirname, 'out', 'replay_rag.json'),JSON.stringify(J(rg2).filter(t => t.rag && t.rag.status === 'ok').map(t => ({ title: t.title, requirements: t.requirements.items, rag: t.rag })), null, 1));
  console.log(lines.join('\n'));
})().catch(e => { console.error('REPLAY FAILED:', e.stack); process.exit(1); });
