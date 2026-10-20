// What the proposal studio makes of our proposal inputs, after "Adapt for Studio": node test/studio_adapter.test.js
// Runs the CURRENT Code node "Adapt for Studio" of dist/RFP - Main.json (stubbed $, like test/edge_cases.js), then the studio's OWN
// normaliser (rfp-studio agents/lib/input.js, loaded read-only: STUDIO_DIR, default C:/Users/yassin/Downloads/rfp-studio/rfp-studio)
// on the 10 real proposal inputs of run 3 (test/out/execution_ragv2_run3_nodes/Build_Proposal_Input.json) and on
// examples/proposal_input_example.json, and checks what the deck would show: no reference from a demo record or a weak proof,
// no more engineers than the proposed team, the team's certifications, no "why us" bullet from a demo / weak / header row
// (OliveSoft's declarations stay), no template id, no budget scenarios from an estimate the market study does not support.
// No n8n, no network, no server. Skipped (exit 0) when the studio folder is absent. After editing src/, run node build.js first.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const STUDIO = process.env.STUDIO_DIR || 'C:/Users/yassin/Downloads/rfp-studio/rfp-studio';
const INPUT_JS = path.join(STUDIO, 'agents', 'lib', 'input.js');
if (!fs.existsSync(INPUT_JS)) { console.log(`SKIPPED: no studio at ${STUDIO} (set STUDIO_DIR)`); process.exit(0); }
const { normalizeInput, assetName, cleanText } = require(INPUT_JS);
const RUN3 = path.join(__dirname, 'out', 'execution_ragv2_run3_nodes', 'Build_Proposal_Input.json');
if (!fs.existsSync(RUN3)) { console.error(`MISSING ${RUN3} (the recorded run 3: node test/split_execution.js test/out/execution_ragv2_run3.json)`); process.exit(1); }

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const wf = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist/RFP - Main.json'), 'utf8'));
const codeOf = name => { const n = wf.nodes.find(x => x.name === name); if (!n) throw new Error(`no node "${name}" in dist (run node build.js)`); return n.parameters.jsCode; };
const clone = x => JSON.parse(JSON.stringify(x));
async function run(name, input, refs = {}, patch = s => s) {
  const items = clone(input).map(json => ({ json }));
  const $ = n => { if (!refs[n]) throw new Error(`Node "${n}" did not run`); const a = clone(refs[n]).map(json => ({ json })); return { all: () => a, first: () => a[0] }; };
  const res = await new AsyncFunction('$', '$input', '$execution', patch(codeOf(name)))($, { all: () => items, first: () => items[0] }, { mode: 'test' });
  run.changedInput = JSON.stringify(items.map(i => i.json)) !== JSON.stringify(input);   // n8n hands the node the items themselves
  return res.map(r => r.json);
}

// ---- what the ORIGINAL input holds that is no proof (the adapter must keep it from the deck)
const isDemo = a => !!a && (a.demo === true || a.origin === 'demo');
const SKILLS = /^[^\p{L}]*\p{L}[^:]{0,40}:\s*[^.!?…]+$/u;     // "Databases: MySQL, phpMyAdmin, PostgreSQL" (same rule as the adapter, checked loosely)
const badWhy = x => new Set(((x.matrix || {}).rows || []).filter(r => r.justification && (r.justification_kind === 'demo' || r.origin === 'demo' || r.justification_weak
  || r.justification_is_header || (r.justification_kind === 'document_quote' && SKILLS.test(r.justification) && r.justification.includes(',')))).map(r => cleanText(r.justification)));
// the studio names a project by its title (60 characters or less) or by its asset id
const nameOf = a => (a.title && cleanText(a.title).length <= 60 ? cleanText(a.title) : assetName(a.asset_id) || cleanText(a.title));
const provingProjects = x => ((x.rag || {}).assets || []).filter(a => a.asset_type === 'project' && !isDemo(a) && (a.for || []).length);
const demoProjects = x => ((x.rag || {}).assets || []).filter(a => a.asset_type === 'project' && (isDemo(a) || !(a.for || []).length));
const teamCerts = x => [...new Set((((x.rag || {}).team_proposal || {}).members || []).flatMap(p => p.certifications || []))];

let failed = 0;
const check = (cond, label) => { if (!cond) { failed++; console.log(`  FAIL ${label}`); } };

(async () => {
  const [cfg] = await run('00 - Config', [{}], {}, s => s.replace('const FORCE_PRESET = null;', "const FORCE_PRESET = 'test';"));
  const run3 = Object.values(JSON.parse(fs.readFileSync(RUN3, 'utf8'))[0].items[0]).map(i => i.json || i);
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'proposal_input_example.json'), 'utf8'));
  const adapted = await run('Adapt for Studio', run3, { '00 - Config': [cfg] });
  check(!run.changedInput, 'Build Proposal Input\'s items untouched (the adapter works on a deep copy)');
  const [exAdapted] = await run('Adapt for Studio', [example], { '00 - Config': [cfg] });
  const cases = [...run3.map((x, k) => [x, adapted[k]]), [example, exAdapted]];
  check(adapted.length === 10 && run3.length === 10, `10 real inputs adapted (got ${adapted.length} of ${run3.length})`);
  console.log('tender      projects  engineers  certs  why_us  budget  (before -> after the adapter, as the studio normalises them)');
  for (const [orig, x] of cases) {
    const id = orig.tender_id, before = normalizeInput(clone(orig)), after = normalizeInput(clone(x)), m0 = before.input.match, m = after.input.match;
    const tp = (orig.rag || {}).team_proposal, scen = c => { const b = c && c.budget_estimate; return !!(b && b.low && b.mid && b.high && b.currency); };
    console.log(`${id.padEnd(10)}  ${String(m0.similar_projects.length).padStart(2)} -> ${String(m.similar_projects.length).padEnd(3)}  ${String(m0.engineers.specialized).padStart(2)} -> ${String(m.engineers.specialized).padEnd(4)}`
      + ` ${String(m0.certifications.matching).padStart(1)} -> ${String(m.certifications.matching).padEnd(2)} ${String(m0.why_us.length).padStart(1)} -> ${String(m.why_us.length).padEnd(2)}  ${scen(before.input.competition) ? 'yes' : 'no '} -> ${scen(after.input.competition) ? 'yes' : 'no'}`
      + `   dropped ${JSON.stringify(Object.fromEntries(Object.entries(x.studio_adapter.dropped).filter(([, v]) => v)))}`);
    // similar projects: exactly the proving, non-demo project assets; never a demo record or a weak neighbour
    const want = provingProjects(orig).map(nameOf).sort(), got = m.similar_projects.map(p => p.name).sort();
    check(JSON.stringify(got) === JSON.stringify(want), `${id}: similar projects ${JSON.stringify(got)} = the proving ones ${JSON.stringify(want)}`);
    check(!m.similar_projects.some(p => /\bdemo\b/i.test(p.name)) && !demoProjects(orig).map(nameOf).some(n => got.includes(n)), `${id}: no similar project from a demo / weak asset`);
    // engineers: the proposed team (or, without one, the CVs that prove a row)
    const cap = tp ? tp.size : ((orig.rag || {}).assets || []).filter(a => a.asset_type === 'cv' && !isDemo(a) && (a.for || []).length).length;
    check(m.engineers.specialized <= cap, `${id}: engineers ${m.engineers.specialized} <= ${tp ? 'team_proposal.size' : 'proving CVs'} ${cap}`);
    // certifications: the team's, when the team_proposal lists some
    const certs = teamCerts(orig);
    if (certs.length) check(m.certifications.matching > 0 && certs.every(c => m.certifications.list.includes(cleanText(c))), `${id}: certifications ${JSON.stringify(m.certifications.list)} hold ${JSON.stringify(certs)}`);
    // why us: nothing from a demo / weak / header row; a declaration of OliveSoft stays
    const bad = badWhy(orig);
    check(!m.why_us.some(w => bad.has(w)), `${id}: no why_us from a demo / weak / header row (${m.why_us.filter(w => bad.has(w)).join(' | ')})`);
    const decl = ((orig.matrix || {}).rows || []).filter(r => r.justification_kind === 'declaration' && r.coverage === 'covered' && r.coverage_score >= 80 && r.justification && !r.justification_weak && !r.justification_is_header);
    check(decl.every(r => m.why_us.includes(cleanText(r.justification))), `${id}: declarations kept in why_us`);
    // template, budget, language, the studio's own checks
    check(after.input.template === null && x.options.template_id === null, `${id}: template null (got ${after.input.template})`);
    const b = (x.competition || {}).budget_estimate;
    check(!b || (x.competition.status === 'OK' && b.confidence !== 'very low' && b.comparables >= 3), `${id}: budget only from an OK study with 3+ comparables`);
    check(['fr', 'en'].includes(after.input.tender.language), `${id}: language ${after.input.tender.language}`);
    check(after.suspicious_fields.length <= before.suspicious_fields.length, `${id}: the adapter adds no injection hit`);
    check(!!x.tender_id && !!(x.tender && String(x.tender.title || '').trim()) && JSON.stringify(x).length < 1024 * 1024, `${id}: the studio's validate_tender passes (id, tender.title, < 1 MB)`);
  }
  // the cases the study found on run 3
  const byId = id => cases.find(([o]) => o.tender_id === id);
  for (const id of ['T1w50xyr', 'T1xiyyfm', 'T1vv1c9s', 'T1wp05cp']) {
    const [o, x] = byId(id);
    check(normalizeInput(clone(o)).input.match.similar_projects.some(p => /\bdemo\b/i.test(p.name)) && !normalizeInput(clone(x)).input.match.similar_projects.some(p => /\bdemo\b/i.test(p.name)), `${id}: demo references before, none after`);
  }
  const [y0, y] = byId('T1ytbl1u');
  check(normalizeInput(clone(y0)).input.match.engineers.specialized === 6 && normalizeInput(clone(y)).input.match.engineers.specialized === 1, 'T1ytbl1u: 6 engineers before (5 weak neighbours), 1 after');
  const [d0, d] = byId('Tdoatt8');
  check(!!d0.competition.budget_estimate && d.competition.budget_estimate === null && !(normalizeInput(clone(d)).input.research || {}).estimated_budget, 'Tdoatt8: no budget (very low confidence, 1 comparable)');
  const decks = adapted.filter(x => x.studio_adapter.auto_deck).map(x => x.tender_id);
  check(JSON.stringify(decks) === '["T1vll2ea"]', `auto deck for the rank-1 tender only (got ${JSON.stringify(decks)})`);
  check(normalizeInput(clone(exAdapted)).input.match.why_us.length === 1, 'example: its declaration stays the one why_us bullet');
  // key partners as Build Proposal Input writes them (names as strings, their proof apart): the studio keeps buyer_profile as it is
  const partner = { name: 'SOPRA STERIA', relation: 'past IT / digital supplier', awards: 2, last_award: '2026-05-04', evidence: [
    { source: 'BOAMP', id: '26-22222', date: '2026-05-04', title: 'Maintenance et évolutions du portail citoyen', amount: null, currency: null, url: 'https://www.boamp.fr/pages/avis/?q=idweb:26-22222' },
    { source: 'DECP', id: 'DT1', date: '2026-02-10', title: 'Tierce maintenance applicative du portail citoyen', amount: 120000, currency: 'EUR', url: null }] };
  const [kpAdapted] = await run('Adapt for Studio', [{ ...example, buyer_profile: { ...example.buyer_profile, key_partners: [partner.name], key_partners_detail: [partner] } }], { '00 - Config': [cfg] });
  const kp = normalizeInput(clone(kpAdapted)), kp0 = normalizeInput(clone(exAdapted));
  check(JSON.stringify(kp.input.buyer_profile.key_partners) === '["SOPRA STERIA"]' && JSON.stringify(kp.input.buyer_profile.key_partners_detail) === JSON.stringify([partner])
    && kp.suspicious_fields.length === kp0.suspicious_fields.length && JSON.stringify(kp.input.match) === JSON.stringify(kp0.input.match), 'example + key partners: kept as they are by the adapter and the studio (no injection hit, the deck facts unchanged)');
  console.log(`\n${cases.length} inputs: ${failed ? `${failed} check(s) FAILED` : 'every check passed'}`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('STUDIO ADAPTER TEST FAILED TO RUN:', e.stack); process.exit(2); });
