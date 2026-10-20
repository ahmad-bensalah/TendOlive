// Edge-case suite: node test/edge_cases.js            (plain Node, no dependency, no n8n, no model, no network)
//                  node test/edge_cases.js --md       (also prints the results as the markdown table of EDGE_CASES.md)
// Each case runs the CURRENT Code nodes of dist/RFP - Main.json (their jsCode, with a stubbed $ / $input, like replay.js)
// on a small hand-made input, or on a real input recorded in the n8n run of 2026-10-19 (test/edge_cases_fixtures.json),
// and checks the expected handling. A case that states the right handling but fails today carries `gap` (code location +
// why): it is reported as KNOWN GAP and does not fail the run; any other failure exits with code 1.
// "today" is fixed to 2026-10-19 (the day of the recorded run) so expiry and days_left are stable.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const wf = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist/RFP - Main.json'), 'utf8'));
const codeOf = name => { const n = wf.nodes.find(x => x.name === name); if (!n) throw new Error(`no node "${name}" in dist`); return n.parameters.jsCode; };
const REAL = JSON.parse(fs.readFileSync(path.join(__dirname, 'edge_cases_fixtures.json'), 'utf8'));
const TODAY = '2026-10-19';
const clone = x => JSON.parse(JSON.stringify(x));
const helpers = { prepareBinaryData: async (buf, fileName, mimeType) => ({ fileName, mimeType, bytes: buf.length }) };

// ---- mini runner: one Code node, $input = the given items, $('Node') = the given reference items (item i pairs with input i)
let CFG = null;
async function run(name, input, refs = {}, patch = s => s) {
  const R = { '00 - Config': [CFG], '02 - Collect Known IDs': [{ _type: 'run_marker', keys: [] }], ...refs };
  const items = clone(input).map(json => ({ json }));
  const ref = n => { if (!R[n]) throw new Error(`Node "${n}" did not run in this case`); return clone(R[n]).map(json => ({ json })); };
  const $ = n => ({
    all: (branch, r) => { if (r > 0) throw new Error(`Run ${r} of "${n}" not found`); return ref(n); },
    first: () => ref(n)[0],
    itemMatching: i => { const a = ref(n); if (!a[i]) throw new Error(`itemMatching(${i}) of "${n}"`); return a[i]; },
  });
  const fn = new AsyncFunction('$', '$input', '$execution', patch(codeOf(name)));
  const res = await fn.call({ helpers }, $, { all: () => items, first: () => items[0] }, { mode: 'test' });
  return res.map(r => r.json);
}

// ---- builders (shapes = what the upstream node really produces)
const extractAnswer = o => ({ text: JSON.stringify({ title: null, buyer: null, description: null, publication_date: null, deadline: null, rectified_deadline: null,
  place: null, cpv: [], estimated_value: null, contacts: { email: null, phone: null, website: null, address: null }, notice_type: 'open', language: 'fr', country: null, ...o }) });
const page = o => ({ source: 'fixture-fr', url: 'https://fixture.test/fr/avis/9001', anchor_text: '', listing_snippet: '', page: 1, onlyMainContent: true,
  repeated_labels: [], page_title: '', text: '', ...o });
const url5 = (base, answer) => run('URL5 - Verify Extraction', [answer], { 'URL4 - Build Extract Prompt': [base] });
const PAGE_NO_DEADLINE = `# Refonte du site internet de la commune de Testville

**Acheteur :** Commune de Testville
**Publié le :** 10/10/2026

La commune de Testville souhaite refondre son site internet et y ajouter des démarches en ligne pour les habitants. Le marché comprend la conception, le développement et l'hébergement du nouveau site.
Contact : marches@testville.fr`;
const EXTRACT_NO_DEADLINE = { title: 'Refonte du site internet de la commune de Testville', buyer: 'Commune de Testville', publication_date: '10/10/2026',
  description: 'La commune de Testville souhaite refondre son site internet et y ajouter des démarches en ligne pour les habitants.' };

let seq = 0;
const tender = ({ id, ...o } = {}) => { id = id || `c${++seq}`; return { tender_id: `T${id}`, canonical_id: `url:https://fixture.test/fr/avis/${id}`, source: 'fixture-fr', source_type: 'url',
  source_url: `https://fixture.test/fr/avis/${id}`, external_id: null, title: 'Développement d’une application de gestion des demandes citoyennes', description: '', body_text: '',
  buyer: { name: 'Ville de Testville', country: 'FR', contacts: {} }, publication_date: '2026-10-10', deadline: '2026-11-20', rectified_deadline: null, cpv: [], supersedes: [],
  notice_type: 'open', language: 'fr', date_order: 'dmy', flags: [], ...o }; };
const clean = ts => run('Clean & Dedupe', ts);
const byId = (out, id) => out.find(t => t.tender_id === id);

// analysis: Build Analysis Prompt on a KEPT tender, then Verify Analysis on the LLM's answer
const SAMPLE = REAL.pages.sampleville_fr.base.text;     // real saved page (Ville de Sampleville, mobile app)
const Q = { scope: 'Le marché comprend la conception, le développement, l’hébergement et la maintenance de l’application et de son back-office.',
  ios: 'L’application devra être disponible sur iOS et Android.', host: 'Les données devront être hébergées en France.',
  refs: 'Le candidat devra présenter au moins deux références de projets similaires réalisés pour des collectivités.',
  duration: 'La durée du marché est de 24 mois à compter de la notification.' };
const keptSample = o => tender({ id: 'sample', title: 'Développement d\'une application mobile de signalement citoyen', body_text: SAMPLE,
  buyer: { name: 'Ville de Sampleville', country: 'FR', contacts: {} }, deadline: '2026-11-13', ...o });
const analysisAnswer = o => ({ text: JSON.stringify({ tender_type: 'software_build', fit: 'high', reason: 'A mobile application to build.', services: [1], quote: Q.scope,
  sector: 'public sector', requirements: [], timeline: '24 mois', ...o }) });
async function analyse(t, answer) {
  const [kept] = await clean([t]);
  if (kept.status !== 'kept') throw new Error('fixture tender not kept by Clean: ' + kept.drop_reason);
  const an1 = await run('Build Analysis Prompt', [kept]);
  return (await run('Verify Analysis', [answer], { 'Build Analysis Prompt': an1 }))[0];
}

// buyer research: Parse Research on one Select Buyers item + the agent's answer (final JSON + tool calls)
const buyer = o => ({ _type: 'buyer', _run: true, research_status: 'researched', buyer_key: 'ville de testville', buyer_id: 'Btest', name: 'Ville de Testville', country: 'FR',
  country_name: 'France', language: 'fr', known_website: '', search_name: 'Ville de Testville', tender_titles: ['Refonte du site internet de la commune de Testville'],
  tenders: [{ tender_id: 'T1', external_id: null, title: 'Refonte du site internet de la commune de Testville' }],
  notice_contacts: { emails: [], phones: [], websites: [], addresses: [] }, exclude_hosts: ['fixture.test'], ...o });
const step = (tool, input, result) => ({ action: { tool, toolInput: input }, observation: JSON.stringify([{ result }]) });
// summary is required by Parse Research's schema: an empty one makes the whole final answer invalid
const researchAgent = (o, steps) => ({ output: JSON.stringify({ buyer_type: 'local_authority', size_hint: 'medium', summary: 'The buyer publishes public tenders.', official_website: null, ...o }), intermediateSteps: steps });
const research = async (b, agent) => (await run('Parse Research', [agent], { 'Select Buyers': [b] }))[0];
const REG_TESTVILLE = 'REG | COMMUNE DE TESTVILLE | siren=211234567 | siret=21123456700012 | addr=1 PLACE DE LA MAIRIE 12345 TESTVILLE | city=TESTVILLE | nature=7210 | public=yes | staff=22 | staff_year=2024';
const BOAMP_TESTVILLE = 'TOTAL 1\nBOAMP | 26-11111 | 2026-03-02 | APPEL_OFFRE | Maintenance du parc informatique | buyer=Ville de Testville | winners=';

// RAG: Join RAG on one tender with verified requirements + the RAG service's answer; then Build Proposal Input on the result
const REQS = [
  { id: 'R1', category: 'technical', text: 'The mobile application must be available on iOS and Android', quote: Q.ios, mandatory: true },
  { id: 'R2', category: 'technical', text: 'Hosting and maintenance of the application and its back-office', quote: Q.scope, mandatory: false },
  { id: 'R3', category: 'experience', text: 'At least 2 references of similar projects for local authorities', quote: Q.refs, mandatory: true },
  { id: 'R4', category: 'team', text: 'A project manager for the whole contract', quote: 'Le titulaire désignera un chef de projet.', mandatory: false },
];
const ragTender = o => ({ tender_id: 'Trag', title: 'Développement d\'une application mobile de signalement citoyen', status: 'kept', survivor: true, too_late: false,
  days_left: 25, effective_deadline: '2026-11-13', source: 'fixture-fr', source_url: 'https://fixture.test/fr/avis/1001', language: 'fr', cpv: ['72212000'],
  buyer: { name: 'Ville de Sampleville', country: 'FR', contacts: {} }, description: 'Application mobile de signalement citoyen.',
  analysis: { status: 'ok', fit: 'high', tender_type: 'software_build', quote: Q.scope, quote_verified: true, checks: [], matched_services: [] },
  requirements: { items: REQS, dropped: [], low_input: false }, buyer_profile: { research_status: 'researched', enrichment_status: 'partial' }, ...o });
const ragRow = (r, status, o = {}) => ({ requirement: r.text, category: r.category, mandatory: true, status, found: null, needed: null,
  best_doc: status === 'missing' ? null : `${r.category === 'team' ? 'cv' : 'project'}_${r.id.toLowerCase()}.md`,
  evidence: status === 'missing' ? null : 'Delivered the citizen-report app of a city of 40,000 people (iOS and Android, 2024).', closest_doc: status === 'missing' ? 'project_old_portal.md' : null, ...o });
const ragAnswer = (rows, o = {}) => ({ requirements_matrix: rows, requirement_matches: [], fit_score: { technical_fit: 80, team_fit: 50, experience_fit: 40, domain_fit: 70, overall: 62 }, warnings: [], ...o });
const joinRag = async (t, answer, called = true) => (await run('Join RAG', [called ? answer : t], { 'Join Buyers & Build RAG': [{ ...t, _run: called, rag_body: {} }] }))[0];
const proposal = async t => (await run('Build Proposal Input', [{ tender_id: t.tender_id, rank: 1 }], { 'Merge Market': [t] }))[0];
const statuses = (...s) => REQS.map((r, k) => ragRow(r, s[k])).filter((x, k) => s[k]);

// market: Parse Market on one Select Market Studies item + the Competitor & Budget Agent's answer
const marketTask = o => ({ title: 'Développement d’une plateforme de téléservices', buyer: 'Ville de Testville', buyer_official_name: '', buyer_siren: '', country: 'FR',
  country_name: 'France', language: 'fr', cpv: ['72000000'], declared_value: null, tender_type: 'software_build',
  summary: 'Développement et hébergement d’une plateforme de téléservices pour les habitants.', requirements: [], ...o });
const award = (id, o = {}) => ['AWARD', id, o.date || '2026-03-01', `amount=${o.amount ?? ''}`, `cur=${o.cur || 'EUR'}`, `buyer=${o.buyer || 'COMMUNE DE AUTREVILLE'}`,
  `winners=${o.winners || ''}`, `bids=${o.bids ?? ''}`, `cpv=${o.cpv || '72000000'}`, `fw=${o.fw || 'no'}`, `src=${o.src || 'DECP'}`,
  `title=${o.title || 'Développement d’une plateforme de téléservices citoyens'}`].join(' | ');
const awardsObs = (rows, head) => `${head || `TOTAL DECP ${rows.length} found`} (showing ${rows.length})\n${rows.join('\n') || 'NO RESULTS'}`;
const marketAgent = (answer, steps) => ({ output: JSON.stringify({ positioning: '', budget_comment: '', ...answer }), intermediateSteps: steps });
async function market(agent, task = marketTask()) {
  const item = { tender_id: 'Tmk', title: task.title, estimated_value: null, buyer: { name: task.buyer, country: task.country }, survivor: true, _market: true, market_task: task };
  return (await run('Parse Market', [agent], { 'Select Market Studies': [item] }))[0];
}
const similar = (rows, head) => step('similar_awards', { cpv: '72', query: 'plateforme, téléservices', country: 'FR' }, awardsObs(rows, head));
const ROWS3 = [award('D1', { amount: 45000, winners: 'SOPRA STERIA', bids: 3 }), award('D2', { amount: 52000, winners: 'SOPRA STERIA', bids: 3, date: '2026-05-10' }),
  award('D3', { amount: 61000, winners: 'ATOS', bids: 5, date: '2025-11-02' })];

// ---- cases: area, case, input, expected handling, node(s); fn(ok) returns a short "got" and calls ok(condition, label)
const cases = [];
const C = (area, name, input, expected, node, fn, gap) => cases.push({ area, name, input, expected, node, fn, gap });
const A1 = 'Incomplete tender specifications', A2 = 'LLM failures', A3 = 'Noisy web research', A4 = 'Missing internal references', A5 = 'Market edge cases';

// ======================= 1. incomplete tender specifications (URL5 Verify Extraction, Clean & Dedupe) =======================
C(A1, 'Cut date "November 9," (real)', 'real saved page + real qwen3 answer: deadline "November 9, " (year cut off)',
  'completed from the page to "November 9, 2026" (warning deadline_completed_from_page); Clean: 2026-11-09', 'URL5, Clean', async ok => {
    const [t] = await url5(REAL.pages.chatbot_en.base, REAL.pages.chatbot_en.answer);
    ok(t && !t._type, 'tender kept'); ok(t.deadline === 'November 9, 2026', 'deadline completed');
    ok(t.extraction.warnings.includes('deadline_completed_from_page'), 'warning');
    const [c] = await clean([t]); ok(c.deadline === '2026-11-09' && c.status === 'kept', 'ISO date, kept');
    return `deadline "${t.deadline}" -> ${c.deadline}, days_left ${c.days_left}`;
  });
C(A1, 'Cut Arabic date "٢٦ أكتوبر ٢" (real)', 'real Arabic page + real answer: deadline "٢٦ أكتوبر ٢" (year cut to one digit)',
  'the cut year is removed and the date completed from the page; Clean: 2026-10-26', 'URL5, Clean', async ok => {
    const [t] = await url5(REAL.pages.olive_ar.base, REAL.pages.olive_ar.answer);
    ok(t && !t._type && /^26 أكتوبر 2026$/.test(t.deadline), 'completed'); ok(t.extraction.warnings.includes('deadline_completed_from_page'), 'warning');
    const [c] = await clean([t]); ok(c.deadline === '2026-10-26', 'ISO date');
    return `deadline "${t.deadline}" -> ${c.deadline}`;
  });
C(A1, 'Date with the wrong month', 'real page says "13 novembre 2026"; LLM answers deadline "13 octobre 2026"',
  'date refused (its month is not in the page): deadline null + warning; Clean keeps it flagged no_deadline, never a wrong date', 'URL5, Clean', async ok => {
    const [t] = await url5(page({ url: 'https://fixture.test/fr/avis/1001', text: SAMPLE }),
      extractAnswer({ title: 'Développement d\'une application mobile de signalement citoyen', buyer: 'Ville de Sampleville', publication_date: '17/10/2026', deadline: '13 octobre 2026' }));
    ok(t.deadline === null, 'deadline dropped'); ok(t.extraction.warnings.includes('deadline_not_in_text_or_incomplete'), 'warning');
    const [c] = await clean([t]); ok(c.status === 'kept' && c.flags.includes('no_deadline'), 'kept, flagged no_deadline');
    return `deadline ${t.deadline}, warnings ${t.extraction.warnings.join(' ')}, Clean ${c.status} [${c.flags.join(' ')}]`;
  });
C(A1, 'No deadline anywhere', 'page without any deadline; LLM deadline null', 'kept with flag no_deadline (published recently); the proposal input lists the risk',
  'URL5, Clean, PR1', async ok => {
    const [t] = await url5(page({ text: PAGE_NO_DEADLINE }), extractAnswer(EXTRACT_NO_DEADLINE));
    const [c] = await clean([t]);
    ok(c.status === 'kept' && c.flags.includes('no_deadline') && c.days_left === undefined, 'kept, no_deadline');
    const p = await proposal(ragTender({ days_left: null, effective_deadline: null }));
    ok(p.analysis.risks.some(r => /No deadline found/.test(r)), 'risk in proposal input');
    return `Clean ${c.status} [${c.flags.join(' ')}]; risk "${p.analysis.risks[0]}"`;
  });
C(A1, 'No deadline, old notice', 'no deadline, published 2026-06-01 (> staleNoDeadlineDays = 90)', 'dropped as expired (no deadline, published 2026-06-01)', 'Clean', async ok => {
  const [c] = await clean([tender({ deadline: null, publication_date: '2026-06-01' })]);
  ok(c.status === 'dropped' && c.drop_reason === 'expired (no deadline, published 2026-06-01)', 'dropped');
  return c.drop_reason;
});
C(A1, 'Deadline only on the listing card', 'detail page without deadline; listing card "Date limite : 15 novembre 2026"',
  'deadline taken from the listing (flag deadline_from_listing); Clean: 2026-11-15', 'URL5, Clean', async ok => {
    const [t] = await url5(page({ text: PAGE_NO_DEADLINE, listing_snippet: 'Commune de Testville — Date limite : 15 novembre 2026' }), extractAnswer(EXTRACT_NO_DEADLINE));
    ok(t.deadline === '15 novembre 2026' && t.flags.includes('deadline_from_listing'), 'from listing');
    const [c] = await clean([t]); ok(c.deadline === '2026-11-15', 'ISO');
    return `deadline "${t.deadline}" [${t.flags.join(' ')}] -> ${c.deadline}`;
  });
C(A1, 'Unreadable deadline text', 'API record with deadline "à définir"', 'kept, flags deadline_unreadable + deadline_unknown_kept (not dropped, not invented)', 'Clean', async ok => {
  const [c] = await clean([tender({ source: 'boamp', source_type: 'api', deadline: 'à définir' })]);
  ok(c.status === 'kept' && c.deadline === null && c.flags.includes('deadline_unknown_kept') && c.flags.some(f => f.startsWith('deadline_unreadable')), 'flags');
  return `${c.status} [${c.flags.join(' ')}]`;
});
C(A1, 'Date formats', '"١٥/١١/٢٠٢٦" (Arabic-Indic), "\\u200F28 أكتوبر 2026" (invisible mark), "11/03/2026" with dateOrder mdy, "15. November 2026" (de)',
  'all read: 2026-11-15, 2026-10-28, 2026-11-03, 2026-11-15', 'Clean', async ok => {
    const out = await clean([tender({ id: 'd1', deadline: '١٥/١١/٢٠٢٦' }), tender({ id: 'd2', deadline: '‏28 أكتوبر 2026', language: 'ar' }),
      tender({ id: 'd3', deadline: '11/03/2026', date_order: 'mdy', language: 'en' }), tender({ id: 'd4', deadline: '15. November 2026', language: 'de' })]);
    const got = ['Td1', 'Td2', 'Td3', 'Td4'].map(id => byId(out, id).deadline);
    ok(JSON.stringify(got) === JSON.stringify(['2026-11-15', '2026-10-28', '2026-11-03', '2026-11-15']), 'dates');
    return got.join(', ');
  });
C(A1, 'Expired deadline', 'deadline 2026-10-01 (before today 2026-10-19)', 'dropped "expired (deadline 2026-10-01)"', 'Clean', async ok => {
  const [c] = await clean([tender({ deadline: '2026-10-01' })]);
  ok(c.drop_reason === 'expired (deadline 2026-10-01)', 'dropped'); return c.drop_reason;
});
C(A1, 'Title-only notice', 'page = one title line; the analysis LLM still answers fit high with a requirement',
  'kept (low_input); requirement dropped "title-only text"; RAG skipped; proposal input = review + risk "little detail"', 'URL5, AN1, AN2, RG2, PR1', async ok => {
    const text = '# Mise en place d\'un logiciel de gestion des ressources humaines';
    const [t] = await url5(page({ text }), extractAnswer({ title: 'Mise en place d\'un logiciel de gestion des ressources humaines' }));
    ok(t && !t._type && t.extraction.low_input, 'kept, low_input');
    const quote = 'Mise en place d\'un logiciel de gestion des ressources humaines';
    const a = await analyse({ ...t, deadline: '2026-11-30' }, analysisAnswer({ quote, requirements: [{ category: 'technical', text: 'An HR management software', quote }] }));
    ok(a.survivor && a.requirements.items.length === 0 && a.requirements.dropped[0].why === 'title-only text' && a.requirements.low_input, 'requirement dropped');
    const r = await joinRag({ ...a, buyer_profile: {} }, null, false);
    ok(r.rag.status === 'skipped_no_requirements', 'RAG skipped');
    const p = await proposal(r);
    ok(p.matrix.summary.recommendation === 'review' && p.analysis.risks.some(x => /little detail/.test(x)), 'review + risk');
    return `low_input, req dropped "${a.requirements.dropped[0].why}", RAG ${r.rag.status}, recommendation ${p.matrix.summary.recommendation}`;
  });
C(A1, 'No title', 'LLM title null, no link text, no page title', 'rejected as source_error "no title" (never a nameless tender)', 'URL5', async ok => {
  const [t] = await url5(page({ text: SAMPLE }), extractAnswer({ buyer: 'Ville de Sampleville', deadline: '13 novembre 2026' }));
  ok(t._type === 'source_error' && /no title$/.test(t.error), 'rejected'); return t.error;
});
C(A1, 'Category page taken for a notice', 'a list page (6 titles, each with "Lire la suite"), LLM title "Informatique", no date, no description',
  'rejected "not a notice (no date, no description)"', 'URL5', async ok => {
    const text = '# Informatique\n\nAccueil > Catégories > Informatique\n\n' + ['Acquisition de licences bureautiques', 'Maintenance du réseau des écoles', 'Fourniture de tablettes pour les élèves',
      'Hébergement du site de la mairie', 'Assistance informatique des services', 'Téléphonie fixe et mobile'].map(x => `${x} — Lire la suite`).join('\n');
    const [t] = await url5(page({ text, url: 'https://fixture.test/fr/categorie/informatique' }), extractAnswer({ title: 'Informatique' }));
    ok(t._type === 'source_error' && /not a notice/.test(t.error), 'rejected'); return t.error;
  });
C(A1, 'Values the page does not contain', 'real page; LLM invents buyer "Région Test", email, phone, CPV 72000000, value "500 000 EUR"',
  'every unprovable value dropped, each with a warning (buyer, email, phone, the CPV: cpv_not_in_text, the value: estimated_value_not_in_text); the tender stays; control: a "N/A" value and the page\'s own CPV give no warning', 'URL5', async ok => {
    const answer = o => extractAnswer({ title: 'Développement d\'une application mobile de signalement citoyen', buyer: 'Région Test', deadline: '13 novembre 2026', ...o,
      contacts: { email: 'contact@region-test.fr', phone: '04 99 99 99 99', website: null, address: null } });
    const base = page({ url: 'https://fixture.test/fr/avis/1001', text: SAMPLE });
    const [t] = await url5(base, answer({ cpv: ['72000000', '72212000'], estimated_value: '500 000 EUR' }));
    ok(t.buyer.name === '' && !t.buyer.contacts.email && !t.buyer.contacts.phone && t.estimated_value === null, 'invented values dropped');
    ok(JSON.stringify(t.cpv) === '["72212000"]', 'only the CPV of the page');
    ok(['buyer_not_in_text', 'contact_email_dropped', 'contact_phone_dropped', 'cpv_not_in_text', 'estimated_value_not_in_text'].every(w => t.extraction.warnings.includes(w)), 'warnings');
    const [c] = await url5(base, answer({ cpv: ['72212000'], estimated_value: 'N/A' }));
    ok(JSON.stringify(c.cpv) === '["72212000"]' && c.estimated_value === null && !c.extraction.warnings.some(w => /^(cpv|estimated_value)_/.test(w)), 'control: no warning');
    return `buyer "${t.buyer.name}", cpv ${t.cpv}, value ${t.estimated_value}, warnings ${t.extraction.warnings.join(' ')}; control warnings ${c.extraction.warnings.join(' ')}`;
  });
C(A1, 'Rectification without its original (real)', 'real "AVIS RECTIFICATIF" page + real answer: old deadline 18/10/2026, new 29/10/2026; original not in the run',
  'label stripped from the title (kept in title_raw); Clean makes it the tender (flag rectification_without_original), deadline 2026-10-29, not expired', 'URL5, Clean', async ok => {
    const [t] = await url5(REAL.pages.rectif_fr.base, REAL.pages.rectif_fr.answer);
    ok(t.title === 'Plateforme de gestion des données patients' && /RECTIFICATIF/.test(t.title_raw), 'title cleaned');
    const [c] = await clean([t]);
    ok(c.status === 'kept' && c.notice_type === 'open' && c.flags.includes('rectification_without_original') && c.effective_deadline === '2026-10-29', 'kept with new deadline');
    return `"${t.title}", Clean ${c.status} [${c.flags.join(' ')}], deadline ${c.effective_deadline}`;
  });
C(A1, 'Rectification with its original', 'original (deadline 2026-10-18, now past) + rectification (same title and buyer, new deadline 2026-10-29)',
  'merged: the original takes the new deadline (flag deadline_rectified_by), the rectification is dropped', 'Clean', async ok => {
    const title = 'Plateforme de gestion des données patients', b = { name: 'Centre Hospitalier Test', country: 'FR', contacts: {} };
    const out = await clean([tender({ id: 'orig', title, buyer: b, deadline: '2026-10-18', publication_date: '2026-09-19' }),
      tender({ id: 'rect', title, buyer: b, deadline: '2026-10-18', rectified_deadline: '2026-10-29', publication_date: '2026-10-18', notice_type: 'rectification' })]);
    const o = byId(out, 'Torig'), r = byId(out, 'Trect');
    ok(o.status === 'kept' && o.effective_deadline === '2026-10-29' && o.flags.some(f => f.startsWith('deadline_rectified_by:')), 'original updated');
    ok(r.status === 'dropped' && /^rectification merged into/.test(r.drop_reason), 'rectification dropped');
    return `original ${o.status} ${o.effective_deadline}; rectification: ${r.drop_reason}`;
  });
C(A1, 'Rectification alone, no new deadline', 'rectification notice, no original in the run, no deadline', 'dropped "rectification without its original nor a new deadline"', 'Clean', async ok => {
  const [c] = await clean([tender({ notice_type: 'rectification', deadline: null })]);
  ok(c.drop_reason === 'rectification without its original nor a new deadline', 'dropped'); return c.drop_reason;
});
C(A1, 'Award and cancelled notices', 'notice_type award (attribution) and cancelled (annulation), deadlines in the future', 'both dropped: "award notice", "cancelled notice"', 'Clean', async ok => {
  const out = await clean([tender({ id: 'aw', notice_type: 'award' }), tender({ id: 'ca', notice_type: 'cancelled', title: 'Refonte du portail famille de la ville' })]);
  ok(byId(out, 'Taw').drop_reason === 'award notice' && byId(out, 'Tca').drop_reason === 'cancelled notice', 'dropped');
  return `${byId(out, 'Taw').drop_reason}; ${byId(out, 'Tca').drop_reason}`;
});
C(A1, 'Duplicate across sources (API + portal)', 'BOAMP record 26-99266 + the same notice on francemarches.com (URL "…/3boamp2699266-…", read by URL5)',
  'same canonical id boamp:26-99266: one tender (the API record, richer), the portal copy dropped as duplicate and listed in also_seen_in', 'URL5, Clean', async ok => {
    const text = '# Plateforme de téléservices pour les habitants\n\nAcheteur : Ville de Testville\nRéférence BOAMP : 26-99266\nDate limite : 20/11/2026\n\nDéveloppement d’une plateforme de téléservices pour les habitants de la ville.';
    const [u] = await url5(page({ source: 'francemarches', url: 'https://www.francemarches.com/appel-offre/3boamp2699266-plateforme-teleservices', text }),
      extractAnswer({ title: 'Plateforme de téléservices pour les habitants', buyer: 'Ville de Testville', deadline: '20/11/2026', description: 'Développement d’une plateforme de téléservices pour les habitants de la ville.' }));
    ok(u.canonical_id === 'boamp:26-99266', 'portal URL mapped to the BOAMP id');
    const api = tender({ id: 'boamp1', canonical_id: 'boamp:26-99266', source: 'boamp', source_type: 'api', external_id: '26-99266', title: 'Plateforme de téléservices pour les habitants',
      source_url: 'https://www.boamp.fr/pages/avis/?q=idweb:26-99266', body_text: 'Plateforme de téléservices pour les habitants. Développement d’une plateforme de logiciel.', cpv: ['72000000'] });
    const out = await clean([u, api]);
    const k = out.filter(t => t.status === 'kept'), d = out.find(t => t.source === 'francemarches');
    ok(k.length === 1 && k[0].source === 'boamp' && d.drop_reason === 'duplicate of Tboamp1' && k[0].also_seen_in[0].source === 'francemarches', 'one tender');
    return `portal id ${u.canonical_id}; kept ${k.map(t => t.source)}; portal copy: ${d.drop_reason}`;
  });
C(A1, 'Duplicate across sources (no shared id)', 'same title + buyer + deadline on two portals, different URLs', 'one kept, the other "duplicate of …"', 'Clean', async ok => {
  const out = await clean([tender({ id: 'p1', source: 'fixture-fr' }), tender({ id: 'p2', source: 'francemarches', source_url: 'https://www.francemarches.com/appel-offre/x-42' })]);
  ok(out.filter(t => t.status === 'kept').length === 1 && out.some(t => /^duplicate of T/.test(t.drop_reason || '')), 'deduped');
  return out.map(t => `${t.source}: ${t.status}${t.drop_reason ? ' (' + t.drop_reason + ')' : ''}`).join('; ');
});
C(A1, 'Relaunch (same title + buyer, new deadline)', 'published 2026-09-01 (deadline 2026-11-05) and 2026-10-15 (deadline 2026-12-01)', 'both kept; the newer one has relaunch_of = the older', 'Clean', async ok => {
  const out = await clean([tender({ id: 'old', publication_date: '2026-09-01', deadline: '2026-11-05' }), tender({ id: 'new', publication_date: '2026-10-15', deadline: '2026-12-01' })]);
  ok(out.every(t => t.status === 'kept') && byId(out, 'Tnew').relaunch_of === 'Told', 'relaunch'); return `both kept, relaunch_of ${byId(out, 'Tnew').relaunch_of}`;
});
C(A1, 'Same reference number reached twice', '"Consultation N° 28/2026 …" (deadline) + a copy "Avis de consultation N°28/2026" without deadline, same buyer',
  'the copy without deadline is dropped "duplicate of … (same reference 28/2026)"', 'Clean', async ok => {
    const out = await clean([tender({ id: 'r1', title: 'Consultation N° 28/2026 relative à l\'acquisition d\'un logiciel de gestion' }),
      tender({ id: 'r2', title: 'Avis de consultation N°28/2026', deadline: null })]);
    ok(/same reference 28\/2026/.test(byId(out, 'Tr2').drop_reason || '') && byId(out, 'Tr1').status === 'kept', 'copy dropped');
    return byId(out, 'Tr2').drop_reason;
  });
C(A1, 'Obvious non-fit API record', 'API records: "Travaux de voirie" (exclusion word, no company keyword) and "Travaux … logiciel de suivi"',
  'first dropped by the pre-filter, second kept (a company keyword wins)', 'Clean', async ok => {
    const out = await clean([tender({ id: 'w1', source: 'boamp', source_type: 'api', title: 'Travaux de voirie rue des Lilas et place du marché' }),
      tender({ id: 'w2', source: 'boamp', source_type: 'api', title: 'Travaux de voirie avec un logiciel de suivi des chantiers' })]);
    ok(/^prefilter: "travaux"/.test(byId(out, 'Tw1').drop_reason || '') && byId(out, 'Tw2').status === 'kept', 'prefilter');
    return `${byId(out, 'Tw1').drop_reason}; second ${byId(out, 'Tw2').status}`;
  });

// ---- BOAMP legacy notices (FNSimple / MAPA, schema 3.2.5): API2 on real records of the run of 2026-10-19, as the API answers them
// (donnees is a JSON string; long legal texts a case does not use are left out)
const boampRec = (idweb, objet, nomacheteur, donnees, o = {}) => ({ idweb, id: idweb.replace('-', '_'), objet, nomacheteur, dateparution: '2026-10-19',
  datelimitereponse: '2026-11-20T12:00:00+00:00', nature: 'APPEL_OFFRE', etat: 'INITIAL', type_marche: ['SERVICES'], descripteur_libelle: ['Informatique (prestations de services)'],
  code_departement: ['81'], annonce_lie: null, url_avis: `https://www.boamp.fr/pages/avis/?q=idweb:${idweb}`, donnees: JSON.stringify(donnees), ...o });
const api2 = recs => run('API2 - Map Records', [{ total_count: recs.length, results: recs }],
  { 'API1 - Build Requests': [{ source: 'boamp', page: 1, method: 'GET', url: 'https://boamp-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/boamp/records' }] });
const NON = { non: '' };
const B101637 = boampRec('26-101637', 'Prestation informatique', "Syndicat Départemental d'Energie du Tarn (SDET)", { FNSimple: {
  organisme: { nomOfficiel: "Syndicat Départemental d'Energie du Tarn (SDET)", typeIdentificationNational: { siret: '' }, codeIdentificationNational: '25810007200044', ville: 'Albi', cp: '81000', grpCommandes: NON },
  initial: {
    communication: { urlDocConsul: 'https://achatpublic.com', identifiantInterne: 'mainfo2026', docSecurite: { oui: '' }, urlSecurite: NON, nomContact: 'MONCET', adresseMailContact: 'c.moncet@te81.fr', telContact: '0563432140' },
    procedure: { procedureAdapteeO: '', capaciteEcoFin: "Le candidat pourra prouver sa capacité financière par tout autre document considéré comme équivalent par le pouvoir adjudicateur s'il est objectivement dans l'impossibilité de produire l'un des renseignements demandés relatifs à sa capacité financière.",
      capaciteTech: "Description de l'outillage, du matériel et de l'équipement technique ; déclaration indiquant les effectifs moyens annuels et l'importance du personnel d'encadrement pendant les trois dernières années ; composition de l'équipe dédiée avec CV des intervenants et moyens techniques mis en œuvre.",
      techAchat: { autres: '' }, dateReceptionOffres: '2026-11-16T12:00:00', presOffres: { exigee: '' }, nbCandidatReduit: NON, attributionSansNegociation: { oui: '' }, variantes: NON },
    natureMarche: { intitule: 'Prestation informatique', codeCPV: { objetPrincipal: { classPrincipale: '72000000' } }, natureMarche: { services: '' },
      description: "Assistance, conseil concernant le système d'information, la maintenance et l'évolution du parc informatique et l'accompagnement des utilisateurs. Services de technologies de l'information, conseil, développement de logiciels, internet et appui.",
      lieuExecution: 'Albi, Castres ponctuellement et pour la gestion des assemblées une commune tarnaise.', dureeMois: '36',
      valeurEstimee: { '@devise': 'EUR', fourchette: { valeurBasse: '80000', valeurHaute: '215000' } }, tranches: NON, reservationMarche: NON, lotsMarche: NON },
    informComplementaire: NON } } }, { datelimitereponse: '2026-11-16T12:00:00+00:00' });
const B101357 = boampRec('26-101357', 'RENOUVELLEMENT DE LA SOLUTION DE BILLETTERIE ET DE GESTION DE LA RELATION CLIENT (GRC)', 'EPCC Metz en scènes', { FNSimple: {
  organisme: { nomOfficiel: 'EPCC Metz en scènes', typeIdentificationNational: { siret: '' }, codeIdentificationNational: '50962999400013', ville: 'Metz', cp: '57000', grpCommandes: NON },
  initial: {
    communication: { urlProfilAch: 'https://metzenscenes.e-marchespublics.com/pack/annonce_marche_public_2776_1188177.html', identifiantInterne: 'M-PA/LOG BIL GRC EPCC*2026', docSecurite: { oui: '' },
      urlSecurite: NON, nomContact: 'JARI Hamid', adresseMailContact: 'hjari@metzenscenes.fr', telContact: '+33 387399210' },
    procedure: { procedureAdapteeO: '', capaciteExercice: 'CF RC CCAP', capaciteEcoFin: 'CF RC CCAP', capaciteTech: 'CF RC CCAP', techAchat: { accordCadre: '' }, dateReceptionOffres: '2026-11-20T12:00:00Z',
      presOffres: { interdite: '' }, nbCandidatReduit: NON, attributionSansNegociation: { oui: '' }, variantes: NON, categorieAcheteur: 'Les services du pouvoir adjudicateur' },
    natureMarche: { intitule: 'RENOUVELLEMENT DE LA SOLUTION DE BILLETTERIE ET DE GESTION DE LA RELATION CLIENT (GRC)', codeCPV: { objetPrincipal: { classPrincipale: '48900000' } }, natureMarche: { services: '' },
      description: "La consultation porte sur la fourniture, la mise en oeuvre, l'hébergement et la maintenance d'une solution de billetterie et de gestion de la relation client, ainsi que du matériel associé, pour les trois sites de l'EPCC Metz en Scènes.",
      lieuExecution: 'MOSELLE', dureeMois: '48', tranches: NON, reservationMarche: NON, lotsMarche: NON },
    informComplementaire: NON } } }, { code_departement: ['57'] });
C(A1, 'BOAMP FNSimple notices (real 26-101637, 26-101357)', 'FNSimple bodies: codeCPV/objetPrincipal/classPrincipale, dureeMois, valeurEstimee fourchette 80000-215000, adresseMailContact / telContact, organisme/codeIdentificationNational',
  'all read: cpv 72000000 / 48900000 (not [] and a guessed CPV 72 downstream), duration "36 month", value "80000-215000 EUR", the buyer\'s e-mail and phone, national_id = the SIRET', 'API2', async ok => {
    const [a, b] = await api2([B101637, B101357]);
    ok(JSON.stringify(a.cpv) === '["72000000"]' && a.duration === '36 month' && a.estimated_value === '80000-215000 EUR', 'cpv, duration, value');
    ok(a.buyer.contacts.email === 'c.moncet@te81.fr' && a.buyer.contacts.phone === '0563432140' && a.buyer.national_id === '25810007200044', 'contacts + SIRET');
    ok(JSON.stringify(b.cpv) === '["48900000"]' && b.duration === '48 month' && b.buyer.contacts.email === 'hjari@metzenscenes.fr' && b.buyer.national_id === '50962999400013', 'GRC notice');
    return `cpv ${a.cpv} / ${b.cpv}, duration ${a.duration}, value ${a.estimated_value}, ${a.buyer.contacts.email} ${a.buyer.contacts.phone}, national_id ${a.buyer.national_id} / ${b.buyer.national_id}`;
  });
C(A1, 'BOAMP MAPA notice (real 26-101178)', 'MAPA body: description = {objet, ...} (an object), caracteristiques/principales, duree/nbMois 60, organisme {correspondantPRM/nom (a person), acheteurPublic, coord {tel, mel, url}}',
  'description read (not low_input), duration "60 month", contacts = the coord block of the buyer (acheteurPublic matches), no "none matches the buyer name" warning', 'API2', async ok => {
    const [t] = await api2([boampRec('26-101178', 'Mise en place d’un logiciel ressources humaines de gestion du temps de travail des agents de la CCV', 'Communauté de communes du Vimeu', { MAPA: {
      organisme: { correspondantPRM: { nom: 'Jean Pierre BOUDINELLE' }, acheteurPublic: 'Communauté de communes du Vimeu', adr: { voie: { nomvoie: '18 avenue Albert Thomas' }, cp: '80130', ville: 'Friville-escarbotin' },
        coord: { tel: '+33 322304042', mel: 'echange.demat@cc-vimeu.fr', url: 'https://ccvimeu.fr/' },
        urlProfilAcheteur: 'https://marchespublics596280.fr/index.php?page=Entreprise.EntrepriseDetailsConsultation&id=588332&orgAcronyme=VINDU' },
      initial: { natureMarche: { fournitures: '' },
        description: { objet: 'Mise en place d’un logiciel ressources humaines de gestion du temps de travail des agents de la CCV', lieuExecutionLivraison: { voie: { nomvoie: '18 avenue Albert Thomas' }, cp: '80130', ville: 'Friville-escarbotin' } },
        caracteristiques: { variantes: { non: { '@xsi:type': 'xs:string' } }, principales: 'Le présent marché porte sur la mise en place d’un logiciel ressources humaines de gestion du temps de travail des agents de la CCV.' },
        duree: { nbMois: '60' }, procedure: { procedureAdaptee: '' }, delais: { receptionOffres: '2026-11-13T12:00:00.000+01:00', validite: { nbJours: '120' } },
        renseignements: { idMarche: '2026-024', rensgComplt: "L'ensemble des documents est disponible sur https://marchespublics596280.fr/entreprise/consultation/588332?orgAcronyme=VINDU" }, marcheUnique: '' } } },
      { datelimitereponse: '2026-11-13T12:00:00+00:00', type_marche: ['FOURNITURES'], descripteur_libelle: ['Logiciel'], code_departement: ['80'] })]);
    const c = t.buyer.contacts;
    ok(/Le présent marché porte sur la mise en place/.test(t.description) && !t.extraction.low_input && t.duration === '60 month', 'description, duration');
    ok(c.email === 'echange.demat@cc-vimeu.fr' && c.phone === '+33 322304042' && c.website === 'https://ccvimeu.fr/' && t.extraction.warnings.length === 0, 'contacts, no warning');
    return `duration ${t.duration}, ${c.email} ${c.phone} ${c.website} | ${c.address}; warnings [${t.extraction.warnings}]`;
  });
C(A1, 'Award criteria written as text (real 26-101317)', 'FNSimple procedure/criteresAttrib = "Prix - 30\\nValeur technique - 65\\nDéveloppement durable - 5\\n" (a string), valeurEstimee fourchette valeurHaute 230000.00',
  'award_criteria Prix (30), Valeur technique (65), Développement durable (5) (in body_text too); value "230000.00 EUR"; duration "48 month"', 'API2', async ok => {
    const [t] = await api2([boampRec('26-101317', 'Accompagnement au Développement du Potentiel Managérial - Promotions 66-67-68', 'ECOLE NATIONALE SUPERIEURE DE SECURITE SOCIALE', { FNSimple: {
      organisme: { nomOfficiel: 'ECOLE NATIONALE SUPERIEURE DE SECURITE SOCIALE', typeIdentificationNational: { siret: '' }, codeIdentificationNational: '19421879800016', ville: 'SAINT ETIENNE Cedex 2', cp: '42031', grpCommandes: NON },
      initial: { communication: { urlProfilAch: 'https://en3s.e-marchespublics.com/', identifiantInterne: '26FORM030', docSecurite: { oui: '' }, urlSecurite: NON, nomContact: 'Angélique JOSSERAND' },
        procedure: { procedureAdapteeO: '', techAchat: { accordCadre: '' }, dateReceptionOffres: '2026-11-18T16:00:00', categorieAcheteur: 'ECOLE NATIONALE SUPERIEURE DE SECURITE SOCIALE',
          criteresAttrib: 'Prix - 30\nValeur technique - 65\nDéveloppement durable - 5\n' },
        natureMarche: { intitule: 'Accompagnement au Développement du Potentiel Managérial - Promotions 66-67-68', codeCPV: { objetPrincipal: { classPrincipale: '80500000' } }, natureMarche: { services: '' },
          description: "La présente consultation concerne des prestations de formation sur le thème : Accompagnement au Développement du Potentiel Managérial des élèves en Formation Initiale à l'EN3S (Promotion 66 à 68)",
          lieuExecution: 'Plusieurs lieux', dureeMois: '48', valeurEstimee: { '@devise': 'EUR', fourchette: { valeurHaute: '230000.00' } }, tranches: NON, reservationMarche: NON, lotsMarche: NON },
        informComplementaire: { non: '', autresInformComplementaire: 'Durée: voir documents du marché.\nLes offres peuvent uniquement être remises électroniquement.\n' } } } },
      { datelimitereponse: '2026-11-18T16:00:00+00:00', descripteur_libelle: ['Formation'], code_departement: ['42'] })]);
    ok(JSON.stringify(t.award_criteria) === '["Prix (30)","Valeur technique (65)","Développement durable (5)"]', 'criteria');
    ok(t.body_text.includes('Award criteria: Prix (30); Valeur technique (65); Développement durable (5)') && !t.body_text.includes('Award criteria as written'), 'body_text');
    ok(t.estimated_value === '230000.00 EUR' && t.duration === '48 month', 'value, duration');
    return `criteria ${t.award_criteria.join('; ')}; value ${t.estimated_value}; duration ${t.duration}`;
  });
C(A1, 'Lotted notice: the total, not lot 1 (real 26-101212)', 'valeurEstimee fourchette valeurHaute 80000 (both lots); lot 1 estimationValeur 38000, lot 2 42000; the e-mail written in nomContact',
  'estimated_value "80000 EUR" (not 38000); each lot keeps its own value; the buyer\'s e-mail read from nomContact', 'API2', async ok => {
    const lot = (n, v) => ({ description: `0${n} : Accès Internet central Isp${n}. Accès Internet central Isp${n}`, codeCPV: { objetPrincipal: { classPrincipale: '72411000' } },
      estimationValeur: { '@devise': 'EUR', valeur: v }, lieuExecutionLivraison: 'Département de la Haute-Saône' });
    const [t] = await api2([boampRec('26-101212', 'Fourniture des accès et services à Internet professionnel', 'Département de la Haute-Saône', { FNSimple: {
      organisme: { nomOfficiel: 'Département de la Haute-Saône', typeIdentificationNational: { siret: '' }, codeIdentificationNational: '22700001500015', ville: 'Vesoul', cp: '70006', grpCommandes: NON },
      initial: { communication: { urlDocConsul: 'https://www.marches-publics.info/mpiaws/index.cfm?fuseaction=dematent.login&type=Dce&Idm=1890653', identifiantInterne: '2026-049-SSIR', docSecurite: { oui: '' },
          urlSecurite: NON, nomContact: 'commandepublique@haute-saone.fr' },
        procedure: { procedureAdapteeO: '', capaciteExercice: 'Renvoi au règlement de la consultation', capaciteEcoFin: 'Renvoi au règlement de la consultation', capaciteTech: 'Renvoi au règlement de la consultation',
          techAchat: { accordCadre: '' }, dateReceptionOffres: '2026-11-16T12:00:00', categorieAcheteur: 'Collectivité territoriale - Département', criteresAttrib: 'énoncé dans le Rc' },
        natureMarche: { intitule: 'Fourniture des accès et services à Internet professionnel', codeCPV: { objetPrincipal: { classPrincipale: '72411000' } }, natureMarche: { services: '' },
          description: "L'accord-cadre sera exécuté par l'émission de bons de commande.\nChaque lot fera l'objet d'une attribution séparée", lieuExecution: 'FRC23 - Haute-Saône', dureeMois: '48',
          valeurEstimee: { '@devise': 'EUR', fourchette: { valeurHaute: '80000' } }, tranches: NON, reservationMarche: NON, lotsMarche: { oui: '' } },
        lots: { lot: [lot(1, '38000'), lot(2, '42000')] }, informComplementaire: NON } } }, { datelimitereponse: '2026-11-16T12:00:00+00:00', code_departement: ['70'] })]);
    ok(t.estimated_value === '80000 EUR' && JSON.stringify(t.lots.map(l => l.estimated_value)) === '["38000 EUR","42000 EUR"]', 'total + lot values');
    ok(t.buyer.contacts.email === 'commandepublique@haute-saone.fr', 'e-mail from nomContact');
    return `estimated_value ${t.estimated_value}; lots ${t.lots.map(l => l.estimated_value).join(', ')}; e-mail ${t.buyer.contacts.email}`;
  });
C(A1, 'Requirements in the selection text (real 26-101570)', 'FNSimple procedure/capaciteTech "3 principales références … prestation externalisée DSI au cours des cinq dernières années"; the LLM quotes it for an experience requirement',
  'the selection text is in body_text (labelled), so the requirement is kept (not "title-only text" as in the run) and the tender is not low_input', 'API2, AN1, AN2', async ok => {
    const ref = '3 principales références portant sur la réalisation d’une prestation externalisée DSI au cours des cinq dernières années, indiquant le montant, la date d’exécution et le client.';
    const [t] = await api2([boampRec('26-101570', "Prestation d'externalisation de la fonction de Direction des Systèmes d'Information.", 'Communauté de Communes Ceur et Coteaux Comminges', { FNSimple: {
      organisme: { nomOfficiel: 'Communauté de Communes Ceur et Coteaux Comminges', typeIdentificationNational: { siret: '' }, codeIdentificationNational: '20007264300014', ville: 'Saint-gaudens', cp: '31800', grpCommandes: NON },
      initial: { communication: { urlProfilAch: 'https://www.achatpublic.com/sdm/ent2/gen/ficheCsl.action?PCSLID=CSL_2026_pSS0JVMOVo', identifiantInterne: '2026-14', docSecurite: { oui: '' }, urlSecurite: NON, nomContact: 'Nathalie CLERMONT GARET' },
        procedure: { procedureAdapteeO: '', capaciteExercice: ref, capaciteEcoFin: "Chiffres d'affaires hors taxes des trois derniers exercices disponibles", capaciteTech: ref, techAchat: { accordCadre: '' },
          dateReceptionOffres: '2026-11-20T12:00:00', categorieAcheteur: 'Direction des systèmes informatiques.' },
        natureMarche: { intitule: "Prestation d'externalisation de la fonction de Direction des Systèmes d'Information.", codeCPV: { objetPrincipal: { classPrincipale: '72600000' } }, natureMarche: { services: '' },
          description: "Prestation d'externalisation de la Direction des Systèmes d'Information hors gestion du personnel", lieuExecution: 'Haute-Garonne', dureeMois: '24', tranches: NON, reservationMarche: NON, lotsMarche: NON },
        informComplementaire: { non: '', autresInformComplementaire: 'Démarrage de la prestation : 01 janvier 2027' } } } }, { code_departement: ['31'] })]);
    ok(t.body_text.includes(`Technical and professional capacity: ${ref}`), 'selection text in body_text');
    const a = await analyse(t, analysisAnswer({ tender_type: 'consulting', quote: "Prestation d'externalisation de la Direction des Systèmes d'Information hors gestion du personnel",
      requirements: [{ category: 'experience', text: '3 references of outsourced DSI services', skill: '3 outsourced DSI references', quote: '3 principales références portant sur la réalisation d’une prestation externalisée DSI' }] }));
    ok(a.requirements.items.length === 1 && a.requirements.items[0].category === 'experience' && !a.requirements.low_input, 'requirement kept');
    return `requirements ${a.requirements.items.map(r => `${r.category}: ${r.text}`).join('; ') || '-'}; dropped ${JSON.stringify(a.requirements.dropped)}; low_input ${a.requirements.low_input}`;
  });
C(A1, 'Rectification whose new deadline is only in its text (real 26-101489)', 'BOAMP RECTIFICATIF, datelimitereponse null, original 26-91336 not in the run; rectificatif/infosRectif "Remise des offres reportées au 27 octobre 2026 à 12h00"',
  'the sentence becomes the rectified deadline; Clean makes it the tender (rectification_without_original), deadline 2026-10-27, days_left 8 (not dropped "without its original nor a new deadline")', 'API2, Clean', async ok => {
    const [r] = await api2([boampRec('26-101489', 'Prestations d’infogérance de l’ensemble des équipements informatiques de l’OPPIC', 'OPPIC', { FNSimple: {
      organisme: { nomOfficiel: 'OPPIC', typeIdentificationNational: { siret: '' }, codeIdentificationNational: '18009208200023', ville: 'PARIS', cp: '75013', grpCommandes: NON },
      rectificatif: { avisInitial: { idWeb: '26-91336' },
        natureMarche: { intitule: 'SG-DRHMG - MARCHE INFOGERANCE - MAPA', codeCPV: { objetPrincipal: { classPrincipale: '50312310' } }, natureMarche: { services: '' },
          description: 'Le présent marché est un marché d’infogérance informatique ayant pour objet la réalisation des prestations de maintenance préventive et corrective de l’ensemble des équipements informatiques de l’OPPIC et des prestations annexes d’assistance.\nLe marché comprend :\n- une partie traitée à prix forfaitaire ;\n- une partie traitée à prix unitaires sous la forme d’un accord-cadre à bons de commande et comprenant un montant maximum annuel de 10 000,00 euros HT.',
          criteresAttrib: 'Voir article 4 du Règlement de Consultation.' },
        infosRectif: 'Remise des offres reportées au 27 octobre 2026 à 12h00' } } },
      { datelimitereponse: null, datefindiffusion: '2026-10-27', nature: 'RECTIFICATIF', etat: 'RECTIFICATIF', annonce_lie: ['26-91336'], descripteur_libelle: ['Informatique (maintenance serveurs et réseaux)'], code_departement: ['75'] })]);
    ok(r.notice_type === 'rectification' && r.rectified_deadline === 'Remise des offres reportées au 27 octobre 2026 à 12h00', 'rectified deadline from the text');
    const [c] = await clean([r]);
    ok(c.status === 'kept' && c.flags.includes('rectification_without_original') && c.effective_deadline === '2026-10-27' && c.days_left === 8, 'kept with the new deadline');
    return `rectified_deadline "${r.rectified_deadline}" -> Clean ${c.status} ${c.effective_deadline} (days_left ${c.days_left}) [${c.flags.join(' ')}]`;
  });
C(A1, 'Rectification text with the old and the new date', 'no original in the run; new deadline "… initialement fixée au 20 octobre 2026 est reportée au 27 octobre 2026 à 12h00"; another "reportée au 27 octobre" (no year)',
  'the latest date is the new deadline: 2026-10-27 (not the old 20 October); the year-less one is kept with deadline_unknown_kept (not dropped, not invented)', 'Clean', async ok => {
    const out = await clean([tender({ id: 'rx1', notice_type: 'rectification', deadline: null, rectified_deadline: 'La date limite de remise des offres initialement fixée au 20 octobre 2026 est reportée au 27 octobre 2026 à 12h00' }),
      tender({ id: 'rx2', title: 'Maintenance du progiciel de gestion financière de la commune', notice_type: 'rectification', deadline: null, rectified_deadline: 'Date limite de remise des offres reportée au 27 octobre' })]);
    const a = byId(out, 'Trx1'), b = byId(out, 'Trx2');
    ok(a.status === 'kept' && a.effective_deadline === '2026-10-27', 'latest date');
    ok(b.status === 'kept' && b.flags.includes('rectification_without_original') && b.flags.includes('deadline_unknown_kept'), 'unreadable: kept');
    return `${a.effective_deadline}; year-less: ${b.status} [${b.flags.join(' ')}]`;
  });
C(A1, 'Run at 01:58 in Paris (real runId 2026-10-19T23-58-26-397Z)', 'clock 2026-10-19T23:58:26Z, workflow timezone Europe/Paris ($now); Ville de Lyon deadline 2026-10-21; a deadline of 2026-10-19',
  'today = 2026-10-20 (the Paris date, not the UTC one); Lyon days_left 1 (not 2); the 19 October deadline expired; API lookback counted from that day', '00 Config, API1, Clean', async ok => {
    const [c] = await run('00 - Config', [{}], {}, s => "const Date = class extends globalThis.Date { constructor(...a) { super(...(a.length ? a : ['2026-10-19T23:58:26.397Z'])); } }, $now = { zoneName: 'Europe/Paris' };\n"
      + s.replace('const FORCE_PRESET = null;', "const FORCE_PRESET = 'test';"));
    ok(c.today === '2026-10-20' && c.runId === '2026-10-19T23-58-26-397Z' && c.timezone === 'Europe/Paris', 'today in Paris');
    const cfg = { ...CFG, today: c.today };
    const [req] = await run('API1 - Build Requests', [{}], { '00 - Config': [cfg] });
    ok(/date'2026-09-20'/.test(req.qs.where), 'lookback from the local day');
    const out = await run('Clean & Dedupe', [tender({ id: 'lyon', source: 'francemarches', title: "Evaluation de conformité de la protection des données personnelles (RGPD) et du règlement sur l'intelligenceartificielle (RIA) à la Ville de Lyon et au CCAS",
      buyer: { name: 'Ville de Lyon', country: 'FR', contacts: {} }, publication_date: '2026-09-16', deadline: '2026-10-21' }), tender({ id: 'eve', deadline: '2026-10-19' })], { '00 - Config': [cfg] });
    ok(byId(out, 'Tlyon').days_left === 1 && byId(out, 'Teve').drop_reason === 'expired (deadline 2026-10-19)', 'days_left from the local day');
    return `today ${c.today} (${c.timezone}); since ${req.qs.where.match(/date'([^']+)'/)[1]}; Lyon days_left ${byId(out, 'Tlyon').days_left}; 19 Oct: ${byId(out, 'Teve').drop_reason}`;
  });
C(A1, 'Award notice read as an open tender (real francemarches page)', 'page "Avis d\'attribution", "Type de formulaire: Résultats", "Date de conclusion du marché/concession: 02/09/2026"; anchor "… Européen Avis d\'attribution Services"; LLM: notice_type open, deadline 02/09/2026',
  'notice_type award (the page labels itself a contract award notice): dropped "award notice", never a deadline taken from the conclusion date', 'URL5, Clean', async ok => {
    const text = ["Intitulé de l'appel d'offre public\nProjet INNOP'IA - Phase2 - Missions d'assistance", 'Localisation :\n\nSeine-Maritime (76)', 'Date de parution :\n\n08/09/2026', 'Européen\n\nAvis d\'attribution\n\nServices',
      '## Nom et adresse officiels de l’organisme acheteur public\n\n**CCI ROUEN METROPOLE**', "Titre: Projet INNOP'IA - Phase2 - Missions d'assistance\n\nDescription: Projet INNOP'IA - Phase2 - Missions d'assistance",
      "Titre: Mission d'assistance au suivi de l'évaluation et du pilotage du projet INNOP'IA 2", 'Date de conclusion du marché/concession: 02/09/2026',
      'Type de formulaire: Résultats\n\nType d’avis: Avis d’attribution de marché ou de concession – régime ordinaire', 'Date de publication: 08/09/2026'].join('\n\n');
    const [t] = await url5(page({ source: 'francemarches', url: 'https://www.francemarches.com/appel-offre/13joue006176972026-2026-projet-innop-phase2?q=Intelligence%20Artificielle', text,
      anchor_text: "021 CCI ROUEN METROPOLE Projet INNOP'IA - Phase2 - Missions d'assistance Européen Avis d'attribution Services Procédure" }),
      extractAnswer({ title: "Projet INNOP'IA - Phase2 - Missions d'assistance", buyer: 'CCI ROUEN METROPOLE', description: "Projet INNOP'IA - Phase2 - Missions d'assistance", publication_date: '08/09/2026', deadline: '02/09/2026' }));
    const [c] = await clean([t]);
    ok(c.drop_reason === 'award notice', 'award notice');
    return `notice_type ${t.notice_type}, deadline "${t.deadline}" -> ${c.drop_reason}`;
  });
C(A1, 'Rectification text: the new date is not the latest one', 'no original in the run; 26-101489 infosRectif "Remise des offres reportées au 27 octobre 2026 à 12h00. Ouverture des plis le 28 octobre 2026 à 14h00."; texts "… avancée au 25 octobre 2026 au lieu du 30 octobre 2026", "… : 27 octobre 2026 ; date de démarrage : 1er janvier 2027", "… reportée du 20/10/2026 au 27/10/2026", "Visite du site du 21/10/2026 au 23/10/2026 ; … : 28/10/2026", "… initialement fixée au 20 octobre 2026 est reportée à une date ultérieure"',
  'the new deadline, never the old date nor the opening / start / visit date: 27, 25, 27, 27, 28 October; API2 passes on the deadline sentence only; a text with only the old date has no readable new deadline (kept, deadline_unknown_kept, not the old 20 October)', 'API2, Clean', async ok => {
    const [r] = await api2([boampRec('26-101489', 'Prestations d’infogérance de l’ensemble des équipements informatiques de l’OPPIC', 'OPPIC', { FNSimple: {
      organisme: { nomOfficiel: 'OPPIC', typeIdentificationNational: { siret: '' }, codeIdentificationNational: '18009208200023', ville: 'PARIS', cp: '75013', grpCommandes: NON },
      rectificatif: { avisInitial: { idWeb: '26-91336' }, natureMarche: { intitule: 'SG-DRHMG - MARCHE INFOGERANCE - MAPA', codeCPV: { objetPrincipal: { classPrincipale: '50312310' } }, natureMarche: { services: '' } },
        infosRectif: 'Remise des offres reportées au 27 octobre 2026 à 12h00. Ouverture des plis le 28 octobre 2026 à 14h00.' } } },
      { datelimitereponse: null, datefindiffusion: '2026-10-27', nature: 'RECTIFICATIF', etat: 'RECTIFICATIF', annonce_lie: ['26-91336'], descripteur_libelle: ['Informatique (maintenance serveurs et réseaux)'], code_departement: ['75'] })]);
    ok(r.rectified_deadline === 'Remise des offres reportées au 27 octobre 2026 à 12h00.', 'API2: the deadline sentence only');
    const texts = [['ra', 'Maintenance du progiciel de gestion des ressources humaines', 'Remise des offres reportées au 27 octobre 2026 à 12h00. Ouverture des plis le 28 octobre 2026 à 14h00'],
      ['rb', 'Fourniture de postes de travail informatiques et accessoires', 'La date limite est avancée au 25 octobre 2026 au lieu du 30 octobre 2026'],
      ['rc', 'Hébergement et infogérance du système d’information communal', 'Date limite de réception des offres : 27 octobre 2026 ; date de démarrage : 1er janvier 2027'],
      ['rd', 'Prestations de cybersécurité et tests d’intrusion annuels', 'Date limite de remise des offres reportée du 20/10/2026 au 27/10/2026'],
      ['re', 'Refonte du site internet institutionnel de la collectivité', 'Visite du site du 21/10/2026 au 23/10/2026 ; date limite de remise des offres : 28/10/2026'],
      ['rf', 'Acquisition d’une solution de gestion électronique des courriers', 'La date limite initialement fixée au 20 octobre 2026 est reportée à une date ultérieure']];
    const out = await clean([r, ...texts.map(([id, title, rd]) => tender({ id, title, notice_type: 'rectification', deadline: null, rectified_deadline: rd }))]);
    const got = [out.find(t => t.source === 'boamp'), ...texts.map(([id]) => byId(out, `T${id}`))];
    ok(JSON.stringify(got.slice(0, 6).map(t => t.status === 'kept' && t.effective_deadline)) === '["2026-10-27","2026-10-27","2026-10-25","2026-10-27","2026-10-27","2026-10-28"]', 'new deadlines');
    const f = got[6];
    ok(f.status === 'kept' && f.effective_deadline == null && f.flags.includes('deadline_unknown_kept') && f.flags.some(x => x.startsWith('rectified_deadline_unreadable')), 'only the old date: unreadable, kept');
    return `API2 "${r.rectified_deadline}"; Clean ${got.map(t => `${t.tender_id} ${t.status} ${t.effective_deadline}`).join(', ')}`;
  });
C(A1, 'Award criteria text: numbers that are not weights', 'criteresAttrib real 26-101275 ("Valeur technique - sur 55 points. Le jugement … / Empreinte environnementale - sur 5 points. … / Prix - sur 40 points. …"); another notice "Prix : 40 %\\nValeur technique : 60\\nDélai de livraison : 15 jours\\nValeur technique : 3 sous-critères\\nArticle 4 - 2"',
  'weights only where one is written: Valeur technique (55), Empreinte environnementale (5), Prix (40) / Prix (40), Valeur technique (60); no "Délai de livraison (15)", "Valeur technique (3)", "Article 4 (2)" (that text goes to body_text as written)', 'API2', async ok => {
    const crit101275 = "Valeur technique - sur 55 points. Le jugement sera réalisé à partir du Dto et des éléments joints à l'appui de l'offre, selon le principe de notation suivant :   -\tAgréments des constructeurs et références sur les matériels listés à l'accord-cadre, noté sur 15 points -\tProfils des intervenants affectés à l'exécution de l'accord-cadre, noté sur 10 points -\tMoyens humains et techniques, noté sur 10 points -\tServices hotline, noté sur 10 points -\tMaintien en condition opérationnelle, noté sur 10 points\nEmpreinte environnementale - sur 5 points. Le jugement sera réalisé à partir du mémoire environnemental fourni par le candidat\nPrix - sur 40 points. Analysés à partir du Devis Quantitatif Estimatif (Dqe) non contractuel, en cohérence avec les tarifs du Bordereau des Prix. La note attribuée sera calculée selon le mode suivant :  Tarif proposé par le moins-disant / Tarif proposé par le candidat = un coefficient multiplié par 40";
    const org = { nomOfficiel: "Conseil départemental d'Indre et Loire", typeIdentificationNational: { siret: '' }, codeIdentificationNational: '22370001400010', ville: 'Tours', cp: '37927', grpCommandes: NON };
    const nm = criteresAttrib => ({ intitule: 'MAINTIEN EN CONDITION OPERATIONNELLE DES EQUIPEMENTS RESEAU, FIREWALL ET TELECOMS, PRESTATIONS COMPLEMENTAIRES', codeCPV: { objetPrincipal: { classPrincipale: '50312300' } },
      natureMarche: { services: '' }, description: "MINIMUM ANNUEL : 25 000  euro(s)  HT - MAXIMUM ANNUEL : 40 000  euro(s)  HT\nMarché passé pour une durée d'un an à compter du 01/01/27. Reconductible 3 fois 1 an", criteresAttrib });
    const [a, b] = await api2([boampRec('26-101275', 'Maintien En Condition Operationnelle Des Equipements Reseau, Firewall Et Telecoms, Prestations Complementaires', "Conseil départemental d'Indre et Loire",
      { FNSimple: { organisme: org, attribution: { avisInitial: { idWeb: '26-88644' }, natureMarche: nm(crit101275) } } }, { datelimitereponse: null, nature: 'ATTRIBUTION', annonce_lie: ['26-88644'], code_departement: ['37'] }),
    boampRec('26-900001', 'Maintien en condition opérationnelle des équipements réseau', "Conseil départemental d'Indre et Loire",
      { FNSimple: { organisme: org, initial: { procedure: { criteresAttrib: 'Prix : 40 %\nValeur technique : 60\nDélai de livraison : 15 jours\nValeur technique : 3 sous-critères\nArticle 4 - 2' }, natureMarche: nm(undefined) } } }, { code_departement: ['37'] })]);
    ok(JSON.stringify(a.award_criteria) === '["Valeur technique (55)","Empreinte environnementale (5)","Prix (40)"]', 'real 26-101275');
    ok(JSON.stringify(b.award_criteria) === '["Prix (40)","Valeur technique (60)"]' && b.body_text.includes('Award criteria as written: Prix : 40 % Valeur technique : 60 Délai de livraison : 15 jours'), 'no false weight');
    return `${a.award_criteria.join('; ')} / ${b.award_criteria.join('; ')}`;
  });
C(A1, 'Selection text that only points to the documents (real 26-101212, 26-101489, 26-101542)', 'capaciteTech "Renvoi au règlement de la consultation", criteresAttrib "Voir article 4 du Règlement de Consultation." / "énoncé dans le Rc"; autresInformComplementaire (real 26-101317) "Durée: voir documents du marché.\\nLes offres peuvent uniquement être remises électroniquement.", capaciteEcoFin (real 26-101570) "Chiffres d\'affaires hors taxes des trois derniers exercices disponibles"',
  'no body_text section for a pointer ("Award criteria as written: Voir article 4 …", "Technical and professional capacity: Renvoi au règlement …"); a text with content of its own is kept', 'API2', async ok => {
    const org = { nomOfficiel: 'Département de la Haute-Saône', typeIdentificationNational: { siret: '' }, codeIdentificationNational: '22700001500015', ville: 'Vesoul', cp: '70006', grpCommandes: NON };
    const rec = (idweb, criteresAttrib, informComplementaire) => boampRec(idweb, 'Fourniture des accès et services à Internet professionnel', 'Département de la Haute-Saône', { FNSimple: { organisme: org, initial: {
      procedure: { procedureAdapteeO: '', capaciteExercice: 'Renvoi au règlement de la consultation', capaciteEcoFin: "Chiffres d'affaires hors taxes des trois derniers exercices disponibles", capaciteTech: 'Renvoi au règlement de la consultation', criteresAttrib },
      natureMarche: { intitule: 'Fourniture des accès et services à Internet professionnel', codeCPV: { objetPrincipal: { classPrincipale: '72411000' } }, natureMarche: { services: '' },
        description: "L'accord-cadre sera exécuté par l'émission de bons de commande.\nChaque lot fera l'objet d'une attribution séparée", dureeMois: '48' }, informComplementaire } } }, { code_departement: ['70'] });
    const [a, b] = await api2([rec('26-101212', 'Voir article 4 du Règlement de Consultation.', { non: '', autresInformComplementaire: 'Durée: voir documents du marché.\nLes offres peuvent uniquement être remises électroniquement.\n' }), rec('26-101542', 'énoncé dans le Rc', NON)]);
    ok(!/Award criteria as written|Renvoi au règlement/.test(a.body_text + b.body_text), 'no pointer section');
    ok(a.body_text.includes("Economic and financial capacity: Chiffres d'affaires hors taxes des trois derniers exercices disponibles") && a.body_text.includes('Additional information: Durée: voir documents du marché. Les offres peuvent uniquement être remises électroniquement.'), 'content kept');
    return `sections: ${[a, b].map(t => t.body_text.split('\n\n').filter(s => /^(Award criteria as written|Technical and professional capacity|Economic and financial capacity|Professional suitability|Additional information):/.test(s)).map(s => s.slice(0, 45)).join(' | ')).join(' / ')}`;
  });

C(A1, 'A period in two titles is no shared reference', 'domainetat-tn buyer: "Maintenance du réseau informatique pour la période 01/2026 à 12/2026" (deadline) and "Acquisition de consommables informatiques pour la période 01/2026 à 12/2026" (no deadline); control: "Consultation N° 30/2026 pour acquisition des logiciels de sécurité informatique (période 01/2026 à 12/2026)" + a copy "Avis de consultation N°30/2026" without deadline',
  'the two notices sharing only a period are both kept (no reference); the control copy is dropped "same reference 30/2026" (the number after N°, not the period)', 'Clean', async ok => {
    const buyer = { name: 'Ministère des Domaines de l’Etat et des Affaires Foncières', country: 'TN', contacts: {} };
    const out = await clean([tender({ id: 'pe1', buyer, title: 'Maintenance du réseau informatique pour la période 01/2026 à 12/2026' }),
      tender({ id: 'pe2', buyer, title: 'Acquisition de consommables informatiques pour la période 01/2026 à 12/2026', deadline: null }),
      tender({ id: 'pe3', buyer, title: 'Consultation N° 30/2026 pour acquisition des logiciels de sécurité informatique (période 01/2026 à 12/2026)' }),
      tender({ id: 'pe4', buyer, title: 'Avis de consultation N°30/2026', deadline: null })]);
    ok(byId(out, 'Tpe1').status === 'kept' && byId(out, 'Tpe2').status === 'kept' && !byId(out, 'Tpe1').reference && !byId(out, 'Tpe2').reference, 'period is no reference');
    ok(byId(out, 'Tpe3').reference === '30/2026' && /same reference 30\/2026/.test(byId(out, 'Tpe4').drop_reason || ''), 'control merged');
    return `Tpe2 ${byId(out, 'Tpe2').status} (reference ${byId(out, 'Tpe2').reference}); control Tpe4 ${byId(out, 'Tpe4').drop_reason}`;
  });
C(A1, 'Notice links that echo the Config search (real francemarches)', 'run 1 Config searches q=Intelligence+Artificielle, its notice link "…/appel-offre/37ec0710260911202667-2026-systeme-videoprotection-cameras?q=Intelligence%20Artificielle"; run 2 (production) searches q=logiciel and gets "…?q=logiciel"; controls: domainetat "?p=16872&lang=fr" under its Config "?cat=19&lang=fr" (same path), "?q=logiciel" under the run 1 Config, the boamp slug "3boamp2687830-…"',
  'one canonical_id for both runs (the echoed q dropped), so URL3 skips the exported notice in run 2; the controls keep their ids (a parameter on the list\'s own path, a parameter the Config does not have, crossSourceIdRules first)', 'canonicalId (URL3, URL5, Run Summary)', async ok => {
    const ids = async (cfg, urls) => (await run('URL3 - Links to URLs', urls.map(url => ({ url })), { '00 - Config': [cfg] },
      s => s.replace(/const cfg = \$\('00 - Config'\)[\s\S]*$/, "const cfg = $('00 - Config').first().json; return $input.all().map(i => ({ json: { id: canonicalId(cfg, i.json.url) } }));"))).map(x => x.id);
    const Q2 = 'https://www.francemarches.com/recherche?q=logiciel&etat=en-cours', slug = FM_LINKS[2][2];
    const run2 = { ...PROD(), sources: CFG.sources.map(s => (s.name === 'francemarches' ? { ...s, url: Q2 } : s)) };
    const [a, dom, other, bo] = await ids(CFG, [fmUrl(slug), dtUrl(16872), fmUrl(slug, 'logiciel'), fmUrl(FM_LINKS[1][2])]), [b] = await ids(run2, [fmUrl(slug, 'logiciel')]);
    ok(a === `url:https://www.francemarches.com/appel-offre/${slug}` && b === a, 'same id in both runs');
    ok(dom === `url:${dtUrl(16872)}` && other === `url:${fmUrl(slug, 'logiciel')}` && bo === 'boamp:26-87830', 'controls keep their ids');
    const out = await run('URL3 - Links to URLs', [fmScout([FM_LINKS[2]], 'logiciel', false)], { '00 - Config': [run2], '02 - Collect Known IDs': [{ _type: 'run_marker', keys: [a], pair_deadlines: {} }],
      'URL1 - Scout Tasks': [{ ...fmTask, url: Q2, other_pages: [] }] });
    ok(!out.length, 'URL3 skips it in run 2');
    return `run 1 and run 2: ${a.replace('https://www.francemarches.com', '…')}; URL3 run 2 opens ${out.length}; control ${dom}`;
  });
C(A3, 'hostOfUrl of no value', 'hostOfUrl(undefined), (null), (""), ("  ") as a missing website gives it (EX1, PR1, BU1, BU2); controls "www.Testville.fr", "https://www.testville.fr/contact"',
  '"" for no value (not "undefined" / "null"); the controls give "testville.fr"', 'lib hostOfUrl (EX1)', async ok => {
    const hs = (await run('Rank & Export', [{}], {}, s => s.replace(/\/\/ ---- end helpers ----[\s\S]*$/,
      'return [undefined, null, "", "  ", "www.Testville.fr", "https://www.testville.fr/contact"].map(u => ({ json: { h: hostOfUrl(u) } }));'))).map(x => x.h);
    ok(JSON.stringify(hs) === '["","","","","testville.fr","testville.fr"]', 'no host'); return JSON.stringify(hs);
  });
C(A3, 'Firecrawl answers HTTP 429 to open_page (real error item)', 'the real Firecrawl 429 item (error.message n8n\'s batching hint, status 429, details.body.error "Rate limit exceeded. Consumed (req/min): 11 …") as Firecrawl Scrape answers open_page; control: an error item without status {error: {message: "socket hang up", code: "ECONNRESET"}}',
  'the agent and Run Summary read "PAGE ERROR | url | firecrawl HTTP 429: Rate limit exceeded …", never n8n\'s hint; the control stays "firecrawl: socket hang up"', 'Page Links (pageError)', async ok => {
    const e429 = { error: { message: 'Try spacing your requests out using the batching settings under \'Options\'', name: 'AxiosError', code: 'ERR_BAD_REQUEST', status: 429 },
      details: { message: 'The service is receiving too many requests from you', description: 'Rate limit exceeded. Consumed (req/min): 11, Remaining (req/min): 0. Upgrade your plan at https://firecrawl.dev/pricing for increased rate limits or please retry after 5s, resets at Mon Oct 19 2026 23:59:37 GMT+0000 (Coordinated Universal Time)',
        httpCode: '429', body: { success: false, error: 'Rate limit exceeded. Consumed (req/min): 11, Remaining (req/min): 0.', retry_after_seconds: 5 } } };
    const a = await openPage(DPAGED(3), e429), b = await openPage(DPAGED(3), { error: { message: 'socket hang up', name: 'AxiosError', code: 'ECONNRESET' } });
    ok(a.result === `PAGE ERROR | ${DPAGED(3)} | firecrawl HTTP 429: Rate limit exceeded. Consumed (req/min): 11, Remaining (req/min): 0.` && !/batching/.test(a.result), 'status and cause');
    ok(b.result === `PAGE ERROR | ${DPAGED(3)} | firecrawl: socket hang up`, 'control');
    return a.result;
  });
C(A3, 'Firecrawl Detail after a scout that used the whole minute', 'production run, 2 URL sources: the scouts made 9 open_page scrapes (francemarches 5, domainetat 4: Config intervalMs 6500 = 9 a minute), then 10 detail scrapes; control: the real run\'s 4 scout scrapes',
  '"Firecrawl Pace" (Wait, before URL3) waits 61 s, then the detail calls start a fresh minute: never more than 10 calls (scout + detail) in any 60 s, 6.5 s apart at least; no wait after the real 4', 'Firecrawl Pace, Firecrawl Detail (options)', async ok => {
    const expr = p => p.replace(/^=\{\{\s*|\s*\}\}$/g, ''), pace = wf.nodes.find(n => n.name === 'Firecrawl Pace');
    const interval = expr(wf.nodes.find(n => n.name === 'Firecrawl Detail').parameters.options.batching.batch.batchInterval);
    const scouts = (agents) => n => ({ first: () => ({ json: CFG }), all: () => (n === 'Tender Scout Agent' ? agents : []).map(json => ({ json })) });
    const pages = (n, url) => scoutAnswer([], Array.from({ length: n }, (_, k) => step('open_page', { url: url(k + 1) }, listPage(`p${k}`, url(k + 1), 'Appels d\'offres', []))));
    const busy = scouts([pages(5, k => `${FM_LIST}&page=${k}`), pages(4, DPAGED)]), real = scouts([fmAgent(FM_DNS), DOM_AGENT]);
    const wait = $ => new Function('$', `return (${expr(pace.parameters.amount)});`)($);
    const at = [wait(busy) * 1000]; for (let i = 1; i < 10; i++) at.push(at[i - 1] + new Function('$', '$itemIndex', `return (${interval});`)(busy, i));
    const calls = [...Array(9).fill(0), ...at], worst = Math.max(...at.map(t => calls.filter(x => x > t - 60000 && x <= t).length));
    ok(pace.type === 'n8n-nodes-base.wait' && pace.parameters.unit === 'seconds' && wait(busy) === 61 && wait(real) === 0, 'waits only after a full minute');
    ok(wf.connections['Tender Scout Agent'].main[0][0].node === 'Firecrawl Pace' && wf.connections['Firecrawl Pace'].main[0][0].node === 'URL3 - Links to URLs', 'wired before URL3');
    ok(worst <= 10 && at.every((x, i) => !i || x - at[i - 1] >= CFG.firecrawl.intervalMs), 'within the budget');
    return `wait ${wait(busy)} s (control ${wait(real)} s); detail calls at ${at.map(x => (x / 1000).toFixed(1)).join(' ')} s; at most ${worst} calls in any 60 s`;
  });
C(A3, 'open_page on a host of no source never reaches Firecrawl (Known source? IF)', 'Scout Tools: the real typo "https://www.franc-than.com/recherche?q=Intelligence+Artificielle&etat=en-cours"; control: page 2 of the real host',
  '"Known source?" sends the refused item straight to Page Links (no Firecrawl Scrape run), which answers "PAGE ERROR … refused, no page read"; the real host goes to Firecrawl Scrape', 'Scout Tools (Known source?, Page Links)', async ok => {
    const ifNode = SCOUT_TOOLS.nodes.find(n => n.name === 'Known source?'), c = SCOUT_TOOLS.connections;
    const known = T => new Function('$json', `return (${ifNode.parameters.conditions.conditions[0].leftValue.replace(/^=\{\{\s*|\s*\}\}$/g, '')});`)(T);
    const resolve = url => scoutTool('Resolve Source', { tool: 'open_page', firecrawl_base: 'https://api.firecrawl.dev', url_sources: URL_SOURCES, max_links: '100', url });
    const bad = await resolve(FM_TYPO), good = await resolve(TASK_FM.other_pages[0]);
    ok(c['Resolve Source'].main[0][0].node === 'Known source?' && c['Known source?'].main[0][0].node === 'Firecrawl Scrape' && c['Known source?'].main[1][0].node === 'Page Links', 'wired');
    ok(known(bad) === false && known(good) === true, 'refused item on the false branch');
    const res = (await scoutTool('Page Links', bad, { 'Resolve Source': [bad] })).result;   // the false branch: Page Links gets Resolve Source's item
    ok(res.startsWith(`PAGE ERROR | ${FM_TYPO} | refused, no page read: franc-than.com is not a site of the configured sources`), 'agent told');
    return `${res.slice(0, 120)}…`;
  });

// ---- BOAMP eForms notices (UBL as JSON in donnees) of the run of 2026-10-20: their organisations, ContractingParty, project and lots
// as the API answers them (the other blocks left out)
const efText = t => ({ '@languageID': 'FRA', '#text': t });
const efOrg = (ref, name, companyId, contact) => ({ 'efac:Company': { 'cac:PartyIdentification': { 'cbc:ID': { '@schemeName': 'organization', '#text': ref } },
  'cac:PartyName': { 'cbc:Name': efText(name) }, 'cac:PartyLegalEntity': { 'cbc:CompanyID': companyId }, ...(contact ? { 'cac:Contact': contact } : {}) } });
const efSender = ref => ({ 'cac:ServiceProviderParty': { 'cbc:ServiceTypeCode': { '@listName': 'organisation-role', '#text': 'ted-esen' }, 'cac:Party': { 'cac:PartyIdentification': { 'cbc:ID': ref } } } });
const eforms = (kind, orgs, party, name, desc, lots) => ({ EFORMS: { [kind]: {
  'ext:UBLExtensions': { 'ext:UBLExtension': { 'ext:ExtensionContent': { 'efext:EformsExtension': { 'efac:Organizations': { 'efac:Organization': orgs } } } } },
  ...(party ? { 'cac:ContractingParty': { 'cac:Party': party } } : {}), 'cac:ProcurementProject': { 'cbc:Name': efText(name), 'cbc:Description': efText(desc) },
  'cac:ProcurementProjectLot': lots.map(([id, n, d]) => ({ 'cbc:ID': { '@schemeName': 'Lot', '#text': id }, 'cac:ProcurementProject': { 'cbc:Name': efText(n), 'cbc:Description': efText(d) } })) } } });
const MEL = "Prestations de développement numérique, d'information et d'accompagnement aux usages sur dataMEL - plateforme métropolitaine de données open source de la Métropole Européenne de Lille";
const MEL_LOTS = [['LOT-0001', 'Prestations de développement informatique et numé-rique sur les briques fonctionnelles « socle /cœur » de dataMEL - Plateforme métropolitaine de données open source de la Métropole Européenne de Lille',
  "Le marché est un accord-cadre à bons de commande et à marchés subséquents multi-attributaire sans montant minimum et d'un montant maximum de 600 000 € HT sur la durée totale du marché (4 ans)"],
  ['LOT-0002', 'Prestations de développement numérique et informatique, accompagnement aux usages sur les modules de valorisation et d’éditorialisation des données de da-taMEL',
    "Le marché est un accord-cadre à bons de commande et à marchés subséquents multi-attributaire sans montant minimum et d'un montant maximum de 350 000 € HT sur la durée totale du marché (4 ans)"]];
const melRec = party => boampRec('26-100890', MEL, 'Métropole européenne de Lille', eforms('ContractNotice', [
  efOrg('ORG-0001', 'Métropole européenne de Lille', '20009320100081', { 'cbc:Name': 'Direction de la Commande publique', 'cbc:Telephone': '+33 320212223', 'cbc:ElectronicMail': 'marches.support@lillemetropole.fr' }),
  efOrg('ORG-0002', 'Tribunal administratif de Lille', '17590003400026')], party, MEL, `La marché porte sur des prestations de développement numérique, d'information et d'accompagnement aux usages sur dataMEL - plateforme métropolitaine de données open source de la Métropole Européenne de Lille`, MEL_LOTS),
  { datelimitereponse: '2026-11-23T10:00:00+00:00', descripteur_libelle: ['Logiciel'], code_departement: ['59'] });
C(A1, 'eForms buyer SIRET from its own organisation (real 26-100890, 26-100887, 26-100631)', 'BOAMP eForms bodies: Lille (ContractingParty ORG-0001, its Company PartyLegalEntity/CompanyID "20009320100081"; the review body has its own); the Nantes award (buyer "381 053 768 00028", the winners CANON / LIXXBAIL and the eSender DEMATIS with their SIRETs); Avenue-Web\'s Région Hauts-de-France (CompanyIDs "67188" and GUIDs, scheme "eu"); Lille without its ContractingParty block; Lille as Select Market Studies gets it (research skipped, not_researched_budget)',
  'national_id 20009320100081 / 38105376800028 (the buyer\'s, never a winner\'s, the eSender\'s or the review body\'s) / null (a platform id is no SIRET); without the link, the Company named like the buyer; Lille\'s market task gets buyer_siren 200093201 (not "", so buyer_awards reads its own DECP contracts, not 186 found by the word "EUROPEENNE")', 'API2, MK1', async ok => {
    const COP = 'LOCATION DE COPIEURS, ACHAT D\'IMPRIMANTES, MAINTENANCE ET LOGICIEL DE GESTION CENTRALISEE ASSOCIE POUR LES SITES DU PARC DES EXPOSITIONS ET LA CITE DES CONGRES';
    const nantes = boampRec('26-100887', COP, 'La Cité des Congrès de Nantes', eforms('ContractAwardNotice', [
      efOrg('ORG-0001', 'La Cité des Congrès de Nantes', '381 053 768 00028', { 'cbc:Telephone': '+33 615881920', 'cbc:ElectronicMail': 'mathilde.dasse@lacite-nantes.fr' }),
      efOrg('ORG-0002', 'Tribunal judiciaire de Rennes', '173 501 115 00161'), efOrg('ORG-0003', 'CANON FAC SIMILE', '33007580500060'), efOrg('ORG-0004', 'LIXXBAIL', '68203907800832'),
      efOrg('ORG-0000', 'DEMATIS', '45072478600030', { 'cbc:Telephone': '+33 172365548', 'cbc:ElectronicMail': 'contact@dematis.com' })],
      { 'cac:PartyIdentification': { 'cbc:ID': 'ORG-0001' }, ...efSender('ORG-0000') }, COP, "Location de copieurs, achat d'imprimantes, maintenance et logiciel de gestion centralisée pour les sites du parc des expositions et la cité des congrès. Des tranches optionnelles sont prévues ainsi que l'achat sur catalogue dans la limite de 10 000euros HT sur toute la durée du marché. Les modalités sont décrites dans le CCAP et le CCTP.",
      [['LOT-0001', COP, COP]]), { nature: 'ATTRIBUTION', datelimitereponse: null, type_marche: ['FOURNITURES'], descripteur_libelle: ['Matériel d\'imprimerie', 'Reprographie'], code_departement: ['44'] });
    const SAP = 'Maintenance et acquisition de licences BO SAP et prestations de montée de version', eu = id => ({ '@schemeName': 'eu', '#text': id }), org = id => ({ '@schemeName': 'organization', '#text': id });
    const hdf = boampRec('26-100631', SAP, 'Région Hauts-de-France', eforms('ContractNotice', [efOrg('ORG-0001', 'Avenue-Web Systèmes', eu('A7CDD735-9789-FB11-758B788773C168AC')),
      efOrg('ORG-0002', 'Région Hauts-de-France', eu('67188')), efOrg('ORG-0003', 'Tribunal administratif de Lille', eu('A7CDD759-F949-112D-9AF6766CBAC94F4D'))],
      { 'cac:PartyIdentification': { 'cbc:ID': org('ORG-0002') }, ...efSender(org('ORG-0001')) }, SAP, 'La Région Hauts de France a développé son système décisionnel autour des outils SAP BusinessObjects.',
      [['LOT-0000', SAP, 'La Région Hauts de France a développé son système décisionnel autour des outils SAP BusinessObjects.']]), { code_departement: ['59'] });
    const [mel, nan, reg, unlinked] = await api2([melRec({ 'cac:PartyIdentification': { 'cbc:ID': 'ORG-0001' } }), nantes, hdf, melRec(null)]);
    ok(mel.buyer.national_id === '20009320100081' && mel.buyer.contacts.email === 'marches.support@lillemetropole.fr', 'Lille: its own CompanyID');
    ok(nan.buyer.national_id === '38105376800028', 'Nantes award: the buyer\'s, no winner\'s');
    ok(reg.buyer.national_id === null && unlinked.buyer.national_id === '20009320100081', 'platform id refused; no link: by name');
    const [m] = await run('Select Market Studies', [{ ...mel, survivor: true, too_late: false, analysis: { fit: 'high', tender_type: 'software_build' }, rag: { coverage: 0.5 }, effective_deadline: '2026-11-23',
      buyer_profile: { research_status: 'not_researched_budget', enrichment_status: 'not_researched' } }]);
    ok(m._market && m.market_task.buyer_siren === '200093201', 'market task SIREN');
    return `national_id Lille ${mel.buyer.national_id}, Nantes ${nan.buyer.national_id}, Région HdF ${reg.buyer.national_id}, Lille unlinked ${unlinked.buyer.national_id}; market buyer_siren "${m.market_task.buyer_siren}"`;
  });
C(A1, 'Lot texts once in body_text (real 26-101203, 26-101212, 26-100890)', 'FNSimple 26-101203: its description lists its 3 lots ("-lot 1 : Suivi des données … grande distribution.") and lots/lot[] holds the same 3 texts; 26-101212: lot texts not in the description ("01 : Accès Internet central Isp1 …"); eForms 26-100890 (Lille): the 2 lots\' texts in the description and in the lots',
  'each lot text once in body_text (not 3 / 2 / 2 times as in the run) and nothing lost: 101203\'s description = its own text (lot texts not listed again), 101212\'s = its text then the 2 lot texts; Lille\'s lot titles stay in body_text', 'API2', async ok => {
    const SPF = ['Suivi des données de vente des produits de prévention en santé sexuelle disponibles en France et diffusés dans le secteur de la grande distribution.',
      'Suivi des données de vente des produits de prévention en santé sexuelle disponibles en France et diffusés dans le secteur des officines et parapharmacies.',
      'Suivi des données de vente en ligne de produits de prévention en santé sexuelle disponibles en France.'];
    const spf = boampRec('26-101203', 'Suivi des données de vente des produits de prévention en santé sexuelle disponibles en France', 'Santé publique France', { FNSimple: {
      organisme: { nomOfficiel: 'Agence nationale de santé publique', typeIdentificationNational: { siren: '' }, codeIdentificationNational: '130022338', cp: '94410', grpCommandes: NON },
      initial: { communication: { urlProfilAch: 'https://www.marches-publics.gouv.fr/?page=Entreprise.EntrepriseAdvancedSearch&AllCons&id=3085374&orgAcronyme=h8', identifiantInterne: '0000000', docSecurite: { oui: '' }, urlSecurite: NON, nomContact: 'Unité achats marchés' },
        natureMarche: { intitule: 'Suivi des données de vente des produits de prévention  en santé sexuelle disponibles en France', codeCPV: { objetPrincipal: '' }, natureMarche: { services: '' },
          description: `Le  marché a pour objet le suivi des données de vente des produits de prévention en santé sexuelle disponibles en France. Il est décomposé en trois lots de la manière suivante :\n-lot 1 : ${SPF[0]} \n-lot 2 : ${SPF[1]}\n-lot 3 : ${SPF[2]}`,
          lieuExecution: '94410', tranches: NON, reservationMarche: NON, lotsMarche: { oui: '' } },
        lots: { lot: SPF.map(description => ({ description, codeCPV: { objetPrincipal: '' }, lieuExecutionLivraison: '94410' })) }, informComplementaire: NON } } },
      { datelimitereponse: '2026-11-23T12:00:00+00:00', descripteur_libelle: ['Etude'], code_departement: ['75'] });
    const ISP = [1, 2].map(n => `0${n} : Accès Internet central Isp${n}. Accès Internet central Isp${n}`), HS = "L'accord-cadre sera exécuté par l'émission de bons de commande. Chaque lot fera l'objet d'une attribution séparée";
    const hs = boampRec('26-101212', 'Fourniture des accès et services à Internet professionnel', 'Département de la Haute-Saône', { FNSimple: {
      organisme: { nomOfficiel: 'Département de la Haute-Saône', typeIdentificationNational: { siret: '' }, codeIdentificationNational: '22700001500015', ville: 'Vesoul', cp: '70006', grpCommandes: NON },
      initial: { natureMarche: { intitule: 'Fourniture des accès et services à Internet professionnel', codeCPV: { objetPrincipal: { classPrincipale: '72411000' } }, natureMarche: { services: '' },
        description: "L'accord-cadre sera exécuté par l'émission de bons de commande.\nChaque lot fera l'objet d'une attribution séparée", dureeMois: '48', lotsMarche: { oui: '' } },
      lots: { lot: ISP.map((description, k) => ({ description, codeCPV: { objetPrincipal: { classPrincipale: '72411000' } }, estimationValeur: { '@devise': 'EUR', valeur: ['38000', '42000'][k] } })) } } } },
      { datelimitereponse: '2026-11-16T12:00:00+00:00', code_departement: ['70'] });
    const [a, b, c] = await api2([spf, hs, melRec({ 'cac:PartyIdentification': { 'cbc:ID': 'ORG-0001' } })]);
    const times = (s, x) => s.split(x).length - 1, once = (t, xs) => xs.every(x => times(t.body_text, x) === 1);
    ok(once(a, SPF) && SPF.every(x => times(a.description, x) === 1) && a.description.startsWith('Le marché a pour objet') && a.lots.length === 3, '101203: once, its own description');
    ok(once(b, ISP) && b.description === [HS, ...ISP].join('\n\n') && b.lots.length === 2, '101212: lot texts kept once');
    ok(once(c, MEL_LOTS.map(l => l[2])) && once(c, MEL_LOTS.map(l => l[1])), 'eForms: once, titles kept');
    return `times in body_text: 101203 ${SPF.map(x => times(a.body_text, x))}, 101212 ${ISP.map(x => times(b.body_text, x))}, Lille ${MEL_LOTS.map(l => times(c.body_text, l[2]))}; body_text ${a.body_text.length} / ${b.body_text.length} / ${c.body_text.length} chars`;
  });

// ======================= 2. LLM failures (URL5, Verify Analysis, Rank & Export) =======================
C(A2, 'Extract LLM answers prose', 'answer "Sorry, I could not find the notice details."', 'source_error "extraction invalid (no JSON object in answer)"', 'URL5', async ok => {
  const [t] = await url5(page({ text: SAMPLE }), { text: 'Sorry, I could not find the notice details.' });
  ok(t._type === 'source_error' && /extraction invalid \(no JSON object in answer\)/.test(t.error), 'source_error'); return t.error;
});
C(A2, 'Extract LLM call error', 'error item {error: {message: "Request timed out"}}', 'source_error "extraction invalid (llm call failed: Request timed out)"', 'URL5', async ok => {
  const [t] = await url5(page({ text: SAMPLE }), { error: { message: 'Request timed out' } });
  ok(t._type === 'source_error' && /llm call failed: Request timed out/.test(t.error), 'source_error'); return t.error;
});
C(A2, 'Analysis answer is not JSON', 'answer "The tender looks relevant for us, fit high."',
  'analysis failed (check llm_invalid), fit "unknown" (not a fake "low"), not researched; export leaves its keys empty so the next run retries it', 'AN2, EX1', async ok => {
    const a = await analyse(keptSample(), { text: 'The tender looks relevant for us, fit high.' });
    ok(a.analysis.status === 'failed' && a.analysis.fit === 'unknown' && a.analysis.checks.includes('llm_invalid') && !a.survivor, 'failed, unknown');
    const [row] = await run('Rank & Export', [a]);
    ok(row.canonical_id === '' && row.pair_key === '' && row.analysis_status === 'failed', 'keys empty in the export');
    return `status ${a.analysis.status}, fit ${a.analysis.fit}, checks ${a.analysis.checks}, export canonical_id "${row.canonical_id}"`;
  });
C(A2, 'Analysis call error', 'error item {error: {message: "ECONNREFUSED 127.0.0.1:11434"}} (model down)', 'check llm_call_failed (told apart from junk), fit unknown', 'AN2', async ok => {
  const a = await analyse(keptSample(), { error: { message: 'ECONNREFUSED 127.0.0.1:11434' } });
  ok(a.analysis.status === 'failed' && a.analysis.checks.includes('llm_call_failed') && a.analysis.fit === 'unknown', 'llm_call_failed');
  return `${a.analysis.checks} ${a.analysis.errors[0]}`;
});
C(A2, 'Unknown tender_type (real)', 'real qwen3 answer for the olive-harvest sale: tender_type "none" (not a type), fit none',
  'not a failed answer: tender_type "other" + check tender_type_invalid, fit none, not a survivor', 'AN2', async ok => {
    const [t] = await url5(REAL.pages.olive_ar.base, REAL.pages.olive_ar.answer);
    const a = await analyse(t, REAL.analysis_olive.answer);
    ok(a.analysis.status === 'ok' && a.analysis.tender_type === 'other' && a.analysis.checks.includes('tender_type_invalid') && a.analysis.fit === 'none' && !a.survivor, 'handled');
    return `status ${a.analysis.status}, type ${a.analysis.tender_type}, fit ${a.analysis.fit}, checks ${a.analysis.checks}`;
  });
C(A2, 'Unknown tender_type + invented quote', 'tender_type "cloud_migration", fit high, quote not in the tender text; controls: the same type with the tender\'s real quote, and with no quote',
  'type "other" (tender_type_invalid) AND the quote still checked: quote_not_in_text, fit lowered to medium; with the real quote fit stays high (quote_verified); with no quote: quote_missing, medium', 'AN2', async ok => {
    const a = await analyse(keptSample(), analysisAnswer({ tender_type: 'cloud_migration', quote: 'Le titulaire assurera la migration complète vers le cloud souverain de la ville.' }));
    ok(a.analysis.tender_type === 'other' && a.analysis.checks.includes('tender_type_invalid'), 'type other');
    ok(a.analysis.checks.includes('quote_not_in_text') && a.analysis.fit === 'medium', 'quote checked, fit lowered');
    const real = await analyse(keptSample(), analysisAnswer({ tender_type: 'cloud_migration' })), none = await analyse(keptSample(), analysisAnswer({ tender_type: 'cloud_migration', quote: '' }));
    ok(real.analysis.fit === 'high' && real.analysis.quote_verified && real.analysis.checks.includes('tender_type_invalid') && !real.analysis.checks.includes('quote_not_in_text'), 'control: real quote');
    ok(none.analysis.fit === 'medium' && none.analysis.checks.includes('quote_missing'), 'control: no quote');
    return `type ${a.analysis.tender_type}, fit ${a.analysis.fit}, quote_verified ${a.analysis.quote_verified}, checks ${a.analysis.checks}; real quote: fit ${real.analysis.fit}; no quote: fit ${none.analysis.fit} (${none.analysis.checks})`;
  });
C(A2, 'Noisy but usable JSON', '<think> block + ```json fence + trailing comma, "Software Build", "High", "Public Sector", services "1, 2"',
  'repaired and coerced: type software_build, fit high, sector "public sector", 2 matched services', 'AN2 (parseAnswer)', async ok => {
    const json = JSON.stringify({ tender_type: 'Software Build', fit: 'High', reason: 'Mobile app.', services: '1, 2', quote: Q.scope, sector: 'Public Sector', requirements: [], timeline: null });
    const a = await analyse(keptSample(), { text: `<think>The tender is an app.</think>\n\`\`\`json\n${json.slice(0, -1)},}\n\`\`\`` });
    ok(a.analysis.status === 'ok' && a.analysis.tender_type === 'software_build' && a.analysis.fit === 'high' && a.analysis.sector === 'public sector' && a.analysis.matched_services.length === 2, 'parsed');
    return `status ${a.analysis.status}, ${a.analysis.tender_type}, ${a.analysis.fit}, ${a.analysis.sector}, services ${a.analysis.matched_services.length}`;
  });
C(A2, 'One malformed requirement', '3 requirements: one valid, one without category, one with category "magic"', 'only the bad ones dropped (why "schema: …"); the valid one kept', 'AN2', async ok => {
  const a = await analyse(keptSample(), analysisAnswer({ requirements: [{ category: 'technical', text: 'The app must run on iOS and Android', quote: Q.ios },
    { text: 'Data hosted in France', quote: Q.host }, { category: 'magic', text: 'Data hosted in France', quote: Q.host }] }));
  ok(a.requirements.items.length === 1 && a.requirements.dropped.length === 2 && a.requirements.dropped.every(d => d.why.startsWith('schema:')), 'isolated');
  return `kept ${a.requirements.items.length}, dropped ${a.requirements.dropped.map(d => d.why).join(' | ')}`;
});
C(A2, 'Type the company does not bid on', 'tender_type training (bid: false in Config), fit high', 'fit forced to none (check type_not_offered), not researched', 'AN2', async ok => {
  const a = await analyse(keptSample(), analysisAnswer({ tender_type: 'training' }));
  ok(a.analysis.fit === 'none' && a.analysis.checks.includes('type_not_offered') && !a.survivor, 'none'); return `fit ${a.analysis.fit}, checks ${a.analysis.checks}`;
});
C(A2, 'Proof quote not in the text', 'fit high, quote "La ville souhaite une intelligence artificielle générative pour ses services." (not in the page)', 'fit lowered one level (medium), check quote_not_in_text', 'AN2', async ok => {
  const a = await analyse(keptSample(), analysisAnswer({ quote: 'La ville souhaite une intelligence artificielle générative pour ses services.' }));
  ok(a.analysis.fit === 'medium' && a.analysis.checks.includes('quote_not_in_text') && !a.analysis.quote_verified, 'lowered');
  return `fit ${a.analysis.fit_llm} -> ${a.analysis.fit}`;
});
C(A2, 'Requirement numbers changed', '"At least 5 references" and "36 months" quoting "au moins deux références" / "24 mois"; control "At least 2 references"',
  'the two with a number not in their quote dropped ("numbers not in quote"); "2" matches "deux" and is kept', 'AN2', async ok => {
    const a = await analyse(keptSample(), analysisAnswer({ requirements: [{ category: 'experience', text: 'At least 5 references of similar projects', quote: Q.refs },
      { category: 'experience', text: 'At least 2 references of similar projects for local authorities', quote: Q.refs },
      { category: 'technical', text: 'Contract duration of 36 months', quote: Q.duration }] }));
    ok(a.requirements.items.length === 1 && /2 references/.test(a.requirements.items[0].text), 'control kept');
    ok(a.requirements.dropped.map(d => d.why).join('|') === 'numbers not in quote: 5|numbers not in quote: 36', 'changed numbers dropped');
    return `kept "${a.requirements.items.map(r => r.text)}"; dropped ${a.requirements.dropped.map(d => d.why).join(' | ')}`;
  });
C(A2, 'Requirement quote invented', 'requirement "ISO 27001 certified hosting" quoting "L’hébergement devra être certifié ISO 27001." (not in the page)', 'dropped quote_not_in_text', 'AN2', async ok => {
  const a = await analyse(keptSample(), analysisAnswer({ requirements: [{ category: 'technical', text: 'ISO 27001 certified hosting', quote: 'L’hébergement devra être certifié ISO 27001.' }] }));
  ok(a.requirements.items.length === 0 && a.requirements.dropped[0].why === 'quote_not_in_text', 'dropped'); return a.requirements.dropped[0].why;
});
// ======================= run report, export and incremental runs (Run Summary, Rank & Export, 02 Collect Known IDs) =======================
// real values of the run of 2026-10-19 (execution_ragv2): sources, scout pages, tenders as Merge Market / Clean gave them
const A6 = 'Run report and incremental runs';
const SRC = { demo: { type: 'api', name: 'demo', language: 'fr', currency: 'EUR', records: 'results' }, boamp: { type: 'api', name: 'boamp', country: 'FR', language: 'fr', currency: 'EUR', records: 'results' },
  fm: { type: 'url', name: 'francemarches', country: 'FR', language: 'fr', url: 'https://www.francemarches.com/recherche?q=Intelligence+Artificielle&etat=en-cours', pageParam: 'page', maxPages: 3 } };
const runSummary = async (sources, refs) => (await run('Run Summary', [{}], { '00 - Config': [{ ...CFG, sources }], ...refs }))[0];
const lineOf = (s, name) => s.message.split('\n').find(l => l.startsWith(`- ${name}:`)) || '';
const apiLane = (source, ts, answer = { total: ts.length, results: ts.map(() => ({})) }) => ({ 'API1 - Build Requests': [{ source, page: 1 }], 'API Fetch': [answer], 'API2 - Map Records': ts });
// a kept tender as Merge Market gives it (analysis verified, requirements checked); `dropped`: as Clean drops it
const merged = (id, o = {}) => ({ ...tender({ id, ...o }), status: 'kept', survivor: true, too_late: false, effective_deadline: o.deadline || '2026-11-20', days_left: 30,
  analysis: { status: 'ok', fit: 'high', tender_type: 'software_build', checks: [] }, requirements: { items: [], dropped: [], low_input: false }, ...o });
const dropped = (id, o = {}) => ({ ...tender({ id, ...o }), status: 'dropped', effective_deadline: o.deadline === undefined ? '2026-11-20' : o.deadline, ...o });
const FM_LIST = SRC.fm.url;
const fmUrl = (slug, q = 'Intelligence%20Artificielle') => `https://www.francemarches.com/appel-offre/${slug}?q=${q}`;
const FM_LINKS = [['we362f', '021 CCI ROUEN METROPOLE Projet INNOP\'IA - Phase2 - Missions d\'assistance Européen Avis d\'attribution Services Procédure', '13joue006176972026-2026-projet-innop-phase2'],
  ['1rt4du7', '022 GIP RESAH Acquisition d\'une plateforme innovante de services d\'intelligence artificielle générative multi-modèles Eu', '3boamp2687830-2026-acquisition-plateforme-innovante'],
  ['odmndd', '023 Ministère de l\'Intérieur RFI - SYSTEME DE VIDEOPROTECTION ET DE CAMERAS AEROPORTEES National AAPC Fournitures Procéd', '37ec0710260911202667-2026-systeme-videoprotection-cameras'],
  ['wgzpri', '025 City\'up (972) Prestations de développement d\'agents LLM et services associés National AAPC Services Procédure formal', '3boamp2696703-2026-prestations-developpement-agents'],
  ['p3wrxf', '026 Ville de Lyon Evaluation de conformité de la protection des données personnelles (RGPD) et du règlement sur l\'intell', '13joue006378442026-2026-evaluation-conformite-protection'],
  ['9ow8eg', '027 Grand Besançon Métropole Fourniture, installation et maintenance de système d\'identification, de système de pesée et', '3boamp2698930-2026-fourniture-installation-maintenance'],
  ['1dmmmxu', '031 ALTEMED Définition, mise en oeuvre et déploiement opérationnel de la stratégie d\'intelligence artificielle du groupe', '3boamp26100942-2026-definition-mise-oeuvre']];
const listPage = (id, url, title, links) => `PAGE [${id}] | ${url} | ${title}\nTEXT: Accueil/Appels d’offres\n${links.map(([lid, text, u]) => `[${lid}] ${text} | ${u}`).join('\n')}\nREPEATED LABELS: none\nNEXT PAGE: none`;
const scoutAnswer = (ids, steps) => ({ output: JSON.stringify({ tender_links: ids, list_url: null }), intermediateSteps: steps });
const fmTask = { source: 'francemarches', url: FM_LIST, other_pages: [`${FM_LIST}&page=2`], country: 'FR', language: 'fr', max_pages: 2, max_calls: 4, allowed_hosts: ['francemarches.com'], onlyMainContent: true };
// the real francemarches run: page 1 on a mistyped host (DNS failure), page 2 read; `q` = the search the site echoes in its links
const fmScout = (links, q, dns = true) => scoutAnswer(links.map(l => l[0]), [
  ...(dns ? [step('open_page', { url: 'https://www.franc-than.com/recherche?q=Intelligence+Artificielle&etat=en-cours' }, 'PAGE ERROR | https://www.franc-than.com/recherche?q=Intelligence+Artificielle&etat=en-cours | firecrawl: DNS resolution failed for hostname "www.franc-than.com". This means the domain name could not be translated to an IP address.')] : []),
  step('open_page', { url: `${FM_LIST}&page=2` }, listPage('bld29b', `${FM_LIST}&page=2`, 'Appel d\'offre / Avis publics sur France Marchés', links.map(([id, t, slug]) => [id, t, fmUrl(slug, q)])))]);
const fmLane = async (links, q) => { const agent = fmScout(links, q); return { 'URL1 - Scout Tasks': [fmTask], 'Tender Scout Agent': [agent], 'URL3 - Links to URLs': await run('URL3 - Links to URLs', [agent], { 'URL1 - Scout Tasks': [fmTask] }) }; };
const T1CS6W0U = { source: 'francemarches', canonical_id: `url:${fmUrl(FM_LINKS[2][2])}`, source_url: fmUrl(FM_LINKS[2][2]), title: 'RFI - SYSTEME DE VIDEOPROTECTION ET DE CAMERAS AEROPORTEES',
  buyer: { name: 'Ministère de l\'Intérieur', country: 'FR', contacts: {} }, publication_date: '2026-10-07', deadline: '2026-11-09', pair_key: 'rfi systeme de videoprotection et de cameras aeroportees|ministere de l interieur' };
const PROD = () => ({ ...CFG, limits: { ...CFG.limits, skipKnown: true } });
// domainetat-tn: its real list page (?cat=19), three of its notices, and a notice as Clean drops it
const DT_LIST = 'https://www.domainetat.tn/?cat=19&lang=fr', dtUrl = p => `https://www.domainetat.tn/?p=${p}&lang=fr`;
SRC.dt = { type: 'url', name: 'domainetat-tn', country: 'TN', language: 'fr', url: DT_LIST, maxPages: 2 };
const DT = [['6nirv3', 'Consultation N°28/2026 auprès des centres de formation spécialisés dans le domaine Informatique pour réaliser des sessio', dtUrl(16872)],
  ['80wmse', 'Consultation N° 30/2026 pour acquisition des logiciels de sécurité informatique', dtUrl(16804)], ['1qvfhuy', 'Appel d’offres N°:20/2026 Matériels Réseaux', dtUrl(16800)]];
const dtTask = { source: 'domainetat-tn', url: DT_LIST, other_pages: [], country: 'TN', language: 'fr', max_pages: 2, max_calls: 4, allowed_hosts: ['domainetat.tn'], onlyMainContent: true };
const dtScout = (links, picks = links.map(l => l[0])) => scoutAnswer(picks, [step('open_page', { url: DT_LIST }, listPage('mxb1hp', DT_LIST, 'Appel d’offre – Ministère des Domaines de l\'Etat et des Affaires foncières', links))]);
const dt = (id, p, o) => dropped(id, { source: 'domainetat-tn', canonical_id: `url:${dtUrl(p)}`, source_url: dtUrl(p),
  buyer: { name: 'Ministère des Domaines de l’Etat et des Affaires Foncières', country: 'TN', contacts: {} }, ...o });
const DT_28 = { title: 'Consultation N°28/2026', publication_date: '2026-08-20', deadline: '2026-09-11', drop_reason: 'expired (deadline 2026-09-11)', pair_key: 'consultation n 28 2026|ministere des domaines de l etat et des affaires foncieres' };
const FM_AWARD = { source: 'francemarches', canonical_id: 'boamp:26-87830', source_url: fmUrl(FM_LINKS[1][2]), notice_type: 'award', deadline: '2026-08-19', drop_reason: 'award notice',
  title: 'Acquisition d\'une plateforme innovante de services d\'intelligenceartificielle générative multi-modèles', buyer: { name: 'GIP RESAH', country: 'FR', contacts: {} } };

C(A6, 'Run Summary: a cap cut the list (real counts)', 'boamp answers total_count 698 with 20 results (maxRecordsPerApi 20); the francemarches scout picks 7 tender links, URL3 opens 5 (maxTendersPerUrlSource 5); controls: 12 of 12 records, 3 links',
  'the funnel says "of 698 matching: cut by limits.maxRecordsPerApi = 20" and "of 7 tender links picked: cut by limits.maxTendersPerUrlSource = 5"; nothing when the whole list was read', 'EX2', async ok => {
    const boamp = (n, total) => apiLane('boamp', Array.from({ length: n }, (_, k) => tender({ id: `bo${k}`, source: 'boamp', source_type: 'api' })), { total_count: total, results: Array.from({ length: n }, (_, k) => ({ idweb: `26-1012${k}` })) });
    const s = await runSummary([SRC.boamp, SRC.fm], { ...boamp(20, 698), ...(await fmLane(FM_LINKS)) });
    const c = await runSummary([SRC.boamp, SRC.fm], { ...boamp(12, 12), ...(await fmLane(FM_LINKS.slice(0, 3))) });
    ok(lineOf(s, 'boamp').startsWith('- boamp: 20 found (of 698 matching: cut by limits.maxRecordsPerApi = 20) ->') && s.per_source.boamp.matched === 698, 'API cap');
    ok(lineOf(s, 'francemarches').startsWith('- francemarches: 5 found (of 7 tender links picked: cut by limits.maxTendersPerUrlSource = 5) ->'), 'URL cap');
    ok(!/cut by/.test(lineOf(c, 'boamp') + lineOf(c, 'francemarches')), 'no note when the whole list was read');
    return `${lineOf(s, 'boamp').slice(0, 92)} | ${lineOf(s, 'francemarches').slice(0, 106)}`;
  });
C(A6, 'Reason replaced by service numbers: fallback, risk and counts (real run 2)', 'run 2 shape: City\'up LLM tender analysed with reason "" and checks reason_was_service_list + services_from_reason; an API award notice with deadline 2026-08-19',
  'proposal reason = the verified quote ("Tender text: …"), a risk names the unclear service lines, export fit_reason = the quote, Run Summary counts both checks; the award notice is dropped with no effective deadline', 'PR1, EX1, EX2, Clean', async ok => {
    const q = 'Le présent marché a pour objet des prestations de développement d\'agents LLM et de chaînes RAG.';
    const t = merged('vll2ea', { source: 'boamp', source_type: 'api', title: 'Prestations de développement d\'agents LLM et services associés',
      analysis: { status: 'ok', fit: 'high', tender_type: 'ai_data', reason: '', quote: q, quote_verified: true, matched_services: [CFG.company.services[1]], checks: ['reason_was_service_list', 'services_from_reason'] } });
    const p = await proposal(t), [row] = await run('Rank & Export', [t]);
    ok(p.analysis.reason === `Tender text: "${q}"` && row.fit_reason === `Tender text: "${q}"`, 'reason falls back to the quote');
    ok(p.analysis.risks.some(r => /^Service lines not stated clearly by the analysis \(services_from_reason\)/.test(r)), 'risk');
    const s = await runSummary([SRC.boamp], { ...apiLane('boamp', [t]), 'Merge Market': [t] });
    ok(s.quality.reason_was_service_list === 1 && s.quality.services_from_reason === 1 && s.quality.timeline_not_in_text === 0, 'counted');
    const [aw] = await clean([tender({ id: 'aw1', source: 'boamp', source_type: 'api', notice_type: 'award', deadline: '2026-08-19' })]);
    ok(aw.drop_reason === 'award notice' && aw.effective_deadline === null, 'award date is no deadline');
    return `reason ${p.analysis.reason.slice(0, 40)}…; quality ${s.quality.reason_was_service_list}/${s.quality.services_from_reason}; award ${aw.drop_reason}, deadline ${aw.effective_deadline}`;
  });
C(A6, 'Export: market budget currency (real)', 'T1wp05cp budget 150103 / 165735 / 181368 TND (Tunisia) and T136zpko 17028 / 25712 / 34395 EUR (France) in one export; a buyer contract median in EUR',
  'market_budget_currency TND / EUR right after the figures, buyer_contracts_currency EUR: the two medians are never read as one unit', 'EX1', async ok => {
    const tn = merged('1wp05cp', { source: 'demo', source_type: 'api', title: 'Développement d\'une plateforme numérique de gestion des licences touristiques', buyer: { name: 'Office du Tourisme de Sampleville (démo)', country: 'TN', contacts: {} },
      market: { status: 'studied', budget: { low: 150103, median: 165735, high: 181368, min: 134470, max: 197000, currency: 'TND', comparables: 2, confidence: 'low' }, competitors: [], checks: [] } });
    const fr = merged('136zpko', { source: 'boamp', source_type: 'api', title: 'RENOUVELLEMENT DE LA SOLUTION DE BILLETTERIE ET DE GESTION DE LA RELATION CLIENT (GRC)', buyer: { name: 'EPCC Metz en scènes', country: 'FR', contacts: {} },
      market: { status: 'studied', budget: { low: 17028, median: 25712, high: 34395, min: 8345, max: 43078, currency: 'EUR', comparables: 2, confidence: 'low' }, competitors: [], checks: [] },
      buyer_profile: { research_status: 'researched', budget_signals: { contracts: 4, min: 12000, median: 38000, max: 90000, currency: 'EUR' } } });
    const rows = await run('Rank & Export', [tn, fr]), r = id => rows.find(x => x.tender_id === id), keys = Object.keys(r('T1wp05cp'));
    ok(r('T1wp05cp').market_budget_currency === 'TND' && r('T136zpko').market_budget_currency === 'EUR' && r('T136zpko').buyer_contracts_currency === 'EUR', 'currency columns');
    ok(keys.indexOf('market_budget_currency') === keys.indexOf('market_budget_high') + 1 && keys.indexOf('buyer_contracts_currency') === keys.indexOf('buyer_contracts_median') + 1, 'next to the figures');
    return rows.map(x => `${x.tender_id} median ${x.market_budget_median} ${x.market_budget_currency}`).join(', ') + `; buyer contracts ${r('T136zpko').buyer_contracts_median} ${r('T136zpko').buyer_contracts_currency}`;
  });
C(A6, 'Export: URL notices dropped for good are remembered (real)', 'real drops: domainetat-tn "Consultation N°28/2026" expired 2026-09-11 (?p=16872), "Appel d’offres N°:20/2026" dropped by the no-deadline guess (published 2026-07-13, staleNoDeadlineDays; ?p=16800), francemarches award notice boamp:26-87830; an API award notice; a URL rectification without its original. Next run (production): the scout picks ?p=16872, ?p=16804 (its scrape failed: never a row) and ?p=16800',
  'the 2 URL notices dropped for a fact (deadline passed, award) become unranked status "dropped" rows after the ranked one (no pair_key; not the no-deadline guess, not the API one, not the rectification); 02 loads their canonical_id; URL3 opens ?p=16804 and ?p=16800 again', 'EX1, 02, URL3', async ok => {
    const ts = [merged('1cs6w0u', T1CS6W0U), dt('1aq05sa', 16872, DT_28),
      dt('1fqo7j7', 16800, { title: 'Appel d’offres N°:20/2026 Matériels Réseaux', publication_date: '2026-07-13', deadline: null, drop_reason: 'expired (no deadline, published 2026-07-13)' }),
      dropped('1tdsy3z', FM_AWARD),
      dropped('xl4zgr', { source: 'boamp', source_type: 'api', canonical_id: 'boamp:26-101275', notice_type: 'award', deadline: null, drop_reason: 'award notice' }),
      dropped('rect1', { source: 'francemarches', notice_type: 'rectification', deadline: null, drop_reason: 'rectification without its original nor a new deadline' })];
    const rows = await run('Rank & Export', ts), memo = rows.filter(r => r.status === 'dropped');
    ok(rows[0].tender_id === 'T1cs6w0u' && rows[0].rank === 1 && rows[0].status === 'kept', 'ranked row first');
    ok(memo.map(r => r.tender_id).join() === 'T1aq05sa,T1tdsy3z' && memo.every(r => r.rank === '' && r.pair_key === '' && r.canonical_id && r.drop_reason), 'final URL drops remembered, not the no-deadline guess');
    const [known] = await run('02 - Collect Known IDs', rows);
    const out = await run('URL3 - Links to URLs', [dtScout(DT)], { '00 - Config': [PROD()], '02 - Collect Known IDs': [known], 'URL1 - Scout Tasks': [dtTask] });
    ok(out.map(l => l.url).join() === [dtUrl(16804), dtUrl(16800)].join(), 'only the links not settled are opened');
    return `rows ${rows.map(r => `${r.tender_id} ${r.status}${r.rank ? ` #${r.rank}` : ''}`).join(', ')}; next run URL3 opens ${out.map(l => l.url.replace('https://www.domainetat.tn/', '')).join(', ')}`;
  });
C(A6, 'Export: a tender already in the sheet keeps its row (real)', 'run 1 exported domainetat-tn "Consultation N°28/2026" (?p=16872) and boamp:26-87830 (BOAMP API, tender_id T1tdsy3z); run 2 has skipKnown off (test preset, sheet on): ?p=16872 is read again, now expired 2026-09-11, and francemarches gives the award notice of boamp:26-87830 (same tender_id); control: ?p=16390 expired 2026-05-28, never exported',
  'no "dropped" row for the two exported tenders (Save to Google Sheet updates on tender_id: it would overwrite their row, rank and pair_key); the control gets its row', 'EX1', async ok => {
    const run1 = await run('Rank & Export', [merged('1aq05sa', { ...DT_28, source: 'domainetat-tn', canonical_id: `url:${dtUrl(16872)}`, source_url: dtUrl(16872), drop_reason: undefined }),
      merged('1tdsy3z', { ...FM_AWARD, source: 'boamp', source_type: 'api', source_url: 'https://www.boamp.fr/pages/avis/?q=idweb:%2226-87830%22', notice_type: 'open', deadline: '2026-11-20', drop_reason: undefined })]);
    const [known] = await run('02 - Collect Known IDs', run1);
    const ts = [merged('1cs6w0u', T1CS6W0U), dt('1aq05sa', 16872, DT_28), dropped('1tdsy3z', FM_AWARD),
      dt('11nmzdr', 16390, { title: 'Consultation N° 16/2026 pour la réalisation de sessions de formation sur le logiciel « DevOps Foundation »', publication_date: '2026-05-06', deadline: '2026-05-28', drop_reason: 'expired (deadline 2026-05-28)' })];
    const rows = await run('Rank & Export', ts, { '02 - Collect Known IDs': [known] }), memo = rows.filter(r => r.status === 'dropped');
    ok(run1.every(r => r.status === 'kept' && r.canonical_id) && known.keys.includes('boamp:26-87830'), 'run 1 exported both');
    ok(memo.map(r => r.tender_id).join() === 'T11nmzdr', 'no dropped row over an exported one');
    return `run 1 sheet rows ${run1.map(r => r.tender_id).join(', ')}; run 2 rows ${rows.map(r => `${r.tender_id} ${r.status}`).join(', ')}`;
  });
C(A6, 'Known IDs: failed sheet read', '"01 - Load Known IDs" fails (On Error: continue gives [{error: "Request failed with status code 403"}]); control: the sheet rows exported for T1cs6w0u',
  'note "sheet read FAILED (…)" + sheet_error, not "first run"; Run Summary counts it (Known IDs sheet 1), says it in the message and sets has_warnings; real rows give their keys and the exported deadline per pair_key', '02, EX2', async ok => {
    const [bad] = await run('02 - Collect Known IDs', [{ error: 'Request failed with status code 403' }]);
    ok(!bad.keys.length && /^sheet read FAILED \(Request failed with status code 403\)/.test(bad.note) && !!bad.sheet_error, 'reported, not a first run');
    const fit = merged('1wp05cp', { source: 'demo', source_type: 'api' });
    const s = await runSummary([SRC.demo], { ...apiLane('demo', [fit]), 'Merge Market': [fit], '02 - Collect Known IDs': [bad] });
    ok(s.failed_calls['Known IDs sheet'] === 1 && s.has_warnings && s.message.includes('Known IDs: sheet read FAILED'), 'Run Summary warns');
    const [good] = await run('02 - Collect Known IDs', await run('Rank & Export', [merged('1cs6w0u', T1CS6W0U)]));
    ok(!good.sheet_error && good.keys.includes(T1CS6W0U.canonical_id) && (good.pair_deadlines[T1CS6W0U.pair_key] || [])[0] === '2026-11-09', 'rows read');
    return `${bad.note.slice(0, 60)}…; summary failed_calls "Known IDs sheet" ${s.failed_calls['Known IDs sheet']}, has_warnings ${s.has_warnings}; control: ${good.note}`;
  });
C(A6, 'Same notice after a change of the search query (real)', 'run 1 exported T1cs6w0u "RFI - SYSTEME DE VIDEOPROTECTION ET DE CAMERAS AEROPORTEES" (link echoing ?q=Intelligence%20Artificielle); run 2 (production) searches q=logiciel: the same notice comes back as …?q=logiciel, same title, buyer and deadline 2026-11-09',
  'skipped as already exported (URL3 skips the link, or Clean drops the copy whose title + buyer + deadline were exported); never re-sent as a "relaunch"', 'URL3, Clean, 02', async ok => {
    const [known] = await run('02 - Collect Known IDs', await run('Rank & Export', [merged('1cs6w0u', T1CS6W0U)]));
    const task = { ...fmTask, url: 'https://www.francemarches.com/recherche?q=logiciel&etat=en-cours', other_pages: [] };
    const out = await run('URL3 - Links to URLs', [fmScout([FM_LINKS[2]], 'logiciel', false)], { '00 - Config': [PROD()], '02 - Collect Known IDs': [known], 'URL1 - Scout Tasks': [task] });
    const again = tender({ ...T1CS6W0U, id: '1wdc4av', canonical_id: `url:${fmUrl(FM_LINKS[2][2], 'logiciel')}`, source_url: fmUrl(FM_LINKS[2][2], 'logiciel'), pair_key: undefined });
    const [c] = await run('Clean & Dedupe', [again], { '00 - Config': [PROD()], '02 - Collect Known IDs': [known] });
    ok(!out.length || c.status === 'dropped', 'not processed again');
    return `URL3 ${out.length ? `opens ${out[0].url.slice(-45)}` : 'skips it'}; Clean: ${c.tender_id} ${c.status}${c.drop_reason ? ` (${c.drop_reason})` : ''}, flags ${c.flags.join(' ') || '-'}, relaunch_of ${c.relaunch_of || '-'}`;
  });
C(A6, 'Run Summary: errors that come back on every run raise no WARNINGS (real)', 'production run, no failed call: the domainetat-tn scout also picks its pagination links (?cat=19&lang=fr&paged=2, &paged=26) and URL5 rejects them "not a notice (no date, no description)"; one boamp record without id or title. Control: the extract LLM answers junk for ?p=16800 ("extraction invalid (Bad control character …)")',
  'has_warnings false: the rejects stay in per_source errors and on the source line, coverage_errors 0 (else every production run mails WARNINGS); the invalid extraction raises it', 'EX2', async ok => {
    const pages = [['1sxb2n', '2', `${DT_LIST}&paged=2`], ['q0t7aw', '26', `${DT_LIST}&paged=26`]];
    const agent = dtScout([...DT, ...pages]), urls = await run('URL3 - Links to URLs', [agent], { '00 - Config': [PROD()], 'URL1 - Scout Tasks': [dtTask] });
    const reject = (u, why) => ({ _type: 'source_error', source: 'domainetat-tn', stage: 'extract', url: u, error: `${u}: ${why}` });
    const fitDt = merged('ia9jb', { source: 'domainetat-tn', canonical_id: `url:${dtUrl(16804)}`, source_url: dtUrl(16804), title: 'Consultation N° 30/2026 pour acquisition des logiciels de sécurité informatique',
      buyer: { name: 'Ministère des Domaines de l’Etat et des Affaires Foncières', country: 'TN', contacts: {} } });
    const fitBo = merged('136zpko', { source: 'boamp', source_type: 'api', title: 'RENOUVELLEMENT DE LA SOLUTION DE BILLETTERIE ET DE GESTION DE LA RELATION CLIENT (GRC)' });
    const lanes = url5 => ({ ...apiLane('boamp', [fitBo, { _type: 'source_error', source: 'boamp', stage: 'adapter', error: 'record without id or title (?)' }]),
      'URL1 - Scout Tasks': [dtTask], 'Tender Scout Agent': [agent], 'URL3 - Links to URLs': urls, 'URL5 - Verify Extraction': [fitDt, ...url5], 'Merge Market': [fitBo, fitDt] });
    const NAN = 'not a notice (no date, no description)';
    const s = await runSummary([SRC.boamp, SRC.dt], lanes(pages.map(p => reject(p[2], NAN))));
    const c = await runSummary([SRC.boamp, SRC.dt], lanes([...pages.map(p => reject(p[2], NAN)), reject(dtUrl(16800), 'extraction invalid (Bad control character in string literal in JSON at position 913 (line 15 column 83))')]));
    // URL3 now drops the pagination picks (?paged=2, 26) before Firecrawl; other non-notice pages can still reach URL5 and be rejected
    ok(urls.length === 3 && !urls.some(u => /paged=/.test(u.url)), 'pagination picks dropped by URL3');
    ok(s.failed_total === 0 && !s.has_warnings, 'no WARNINGS for the rejects');
    ok(s.per_source['domainetat-tn'].errors.length === 2 && !s.per_source['domainetat-tn'].coverage_errors && s.per_source.boamp.errors[0] === 'adapter: record without id or title (?)' && !s.per_source.boamp.coverage_errors, 'still listed');
    ok(lineOf(s, 'domainetat-tn').includes(`| error: extract: ${DT_LIST}&paged=2: ${NAN} (+1 more)`), 'on the source line');
    ok(c.has_warnings && c.per_source['domainetat-tn'].coverage_errors === 1, 'an invalid extraction raises it');
    return `has_warnings ${s.has_warnings} (control ${c.has_warnings}); ${lineOf(s, 'domainetat-tn').replace(/^.*\| error: /, 'domainetat-tn error: ').slice(0, 120)}`;
  });
C(A6, 'Run Summary: error text with line breaks (real shape)', 'boamp page 2 fails with the HTML body of a 503 (n8n error message "503 - \\"<html>\\r\\n<head>…"); a boamp tender whose title holds a line break has its analysis call failed',
  'one line per source in the message: whitespace collapsed in the error, the analysis line and the titles; the fetch error is the boamp error (the analysis failure has its own line, not "(+1 more)")', 'EX2', async ok => {
    const fit = merged('136zpko', { source: 'boamp', source_type: 'api', title: 'RENOUVELLEMENT DE LA SOLUTION DE BILLETTERIE ET DE GESTION DE LA RELATION CLIENT (GRC)' });
    const bad = merged('1ga2b6i', { source: 'boamp', source_type: 'api', title: 'Accompagnement au Développement du Potentiel Managérial -\nPromotions 66-67-68', survivor: false,
      analysis: { status: 'failed', tender_type: 'other', fit_llm: null, fit: 'unknown', reason: '', quote: '', quote_verified: false, checks: ['llm_call_failed'], matched_services: [], errors: ['llm call failed: fetch failed\n    at node:internal/deps/undici'] } });
    const html = '503 - "<html>\r\n<head><title>503 Service Temporarily Unavailable</title></head>\r\n<body>\r\n<center><h1>503 Service Temporarily Unavailable</h1></center>\r\n</body>\r\n</html>\r\n"';
    const s = await runSummary([SRC.boamp], { 'API1 - Build Requests': [{ source: 'boamp', page: 1 }, { source: 'boamp', page: 2 }], 'API Fetch': [{ results: [{}, {}] }, { error: { message: html } }],
      'API2 - Map Records': [fit, bad, { _type: 'source_error', source: 'boamp', stage: 'fetch', error: `page 2: ${html}` }], 'Merge Market': [fit, bad] });
    const lines = s.message.split('\n');
    ok(lines.every(l => /^(RFP pipeline|Extracted|- boamp:|Analysis failed|\d+ fit tender|Failed calls)/.test(l)), 'no stray line');
    ok(lineOf(s, 'boamp').includes('| error: fetch page 2: 503 - "<html> <head><title>503 Service Temporarily Unavailable</title></head>') && !/more\)/.test(lineOf(s, 'boamp')), 'fetch error on the boamp line');
    ok(lines.some(l => l.startsWith('Analysis failed') && l.includes('Potentiel Managérial - Promotions') && l.includes('(boamp, llm_call_failed: llm call failed: fetch failed at node:internal/deps/undici)')), 'analysis line flat');
    return lineOf(s, 'boamp').replace(/^.*\| error: /, 'boamp error: ').slice(0, 110);
  });
C(A2, 'Run Summary: failed analysis and source errors in the message (real)', 'real run: demo tender "بوابة الخدمات الإلكترونية للمواطنين", analysis failed (llm_invalid "Bad control character …"), no failed call; francemarches list page 1 failed (DNS www.franc-than.com)',
  'the message names the tender whose analysis failed (with the error) on its own line, not again as the demo source\'s error, and each source\'s first error; has_warnings true for the invalid answer alone (false without it)', 'EX2', async ok => {
    const fit = merged('1wp05cp', { source: 'demo', source_type: 'api', title: 'Développement d\'une plateforme numérique de gestion des licences touristiques' });
    const bad = merged('1xsyk4l', { source: 'demo', source_type: 'api', title: 'بوابة الخدمات الإلكترونية للمواطنين', language: 'ar', survivor: false,
      analysis: { status: 'failed', tender_type: 'other', fit_llm: null, fit: 'unknown', reason: '', quote: '', quote_verified: false, checks: ['llm_invalid'], matched_services: [], errors: ['Bad control character in string literal in JSON at position 913 (line 15 column 83)'] } });
    const s = await runSummary([SRC.demo], { ...apiLane('demo', [fit, bad]), 'Merge Market': [fit, bad] }), c = await runSummary([SRC.demo], { ...apiLane('demo', [fit]), 'Merge Market': [fit] });
    ok(s.failed_total === 0 && s.has_warnings && !c.has_warnings, 'has_warnings from the invalid answer alone');
    const an = s.message.split('\n').find(l => l.startsWith('Analysis failed')) || '';
    ok(an.includes('"بوابة الخدمات الإلكترونية للمواطنين" (demo, llm_invalid: Bad control character in string literal in JSON at position 913'), 'failed analysis named');
    ok(!lineOf(s, 'demo').includes('| error:') && s.per_source.demo.errors[0].startsWith('1 analysis call(s) failed'), 'not repeated as the demo error (still in the JSON)');
    const u = await runSummary([SRC.fm], await fmLane(FM_LINKS.slice(0, 3)));
    ok(/\| error: list page 1 never read, its tenders are missing: the scout asked franc-than\.com instead of francemarches\.com \(firecrawl: DNS resolution failed/.test(lineOf(u, 'francemarches')) && u.has_warnings, 'failed list page on its source line');
    return `${an.slice(0, 110)} | ${lineOf(u, 'francemarches').replace(/^.*\| error: /, 'francemarches error: ').slice(0, 110)}`;
  });
// run 2 (2026-10-20, ragv2): the francemarches scout asked list page 1 on a mistyped host, refused by Resolve Source (no Firecrawl
// call; the recorded text, written for the agent), then read page 2 twice ("+" and "%20"); that run's NEXT PAGE detector gives page 3
const FM_REFUSED = 'PAGE ERROR | https://www.franc-than.com/recherche?q=Intelligence+Artificielle&etat=en-cours | refused, no page read: franc-than.com is not a site of the configured sources (open the START URL exactly as written, or a URL from an earlier open_page result; other hosts go in Config allowedHosts)';
const FM_P3 = 'https://www.francemarches.com/recherche?q=Intelligence%20Artificielle&etat=en-cours&page=3';
const fmRun2 = picks => { const p2 = FM_SEEN2.replace('NEXT PAGE: none', `NEXT PAGE: [nxh32w] | ${FM_P3}`), p2b = TASK_FM.other_pages[0].replace('+', '%20');
  return scoutAnswer(picks, [step('open_page', { url: FM_TYPO }, FM_REFUSED), step('open_page', { url: TASK_FM.other_pages[0] }, p2),
    step('open_page', { url: p2b }, p2.replace(`PAGE [bld29b] | ${TASK_FM.other_pages[0]}`, `PAGE [o7gorv] | ${p2b}`))]); };
C(A6, 'Run Summary: list page 1 asked on a mistyped host (real run 2)', 'run 2 francemarches scout: open_page "https://www.franc-than.com/recherche?q=Intelligence+Artificielle&etat=en-cours" refused by Resolve Source before Firecrawl (its text, for the agent, ends "other hosts go in Config allowedHosts"), then page 2 read as "+" and as "%20"; every pick from page 2',
  'ONE coverage error, first on the e-mail line (not "(+2 more)" behind the refusal): "list page 1 never read, its tenders are missing: the scout asked franc-than.com instead of francemarches.com (refused: not a host of any configured source) - <page 1>" (the line leaves out " - <page 1>" rather than cut it); the agent\'s allowedHosts advice not repeated; no failed call (Scout pages 0, scout.refused 1); WARNINGS still', 'EX2', async ok => {
    const agent = fmRun2(FM_LINKS.slice(0, 3).map(l => l[0])), urls = await run('URL3 - Links to URLs', [agent], { 'URL1 - Scout Tasks': [TASK_FM] });
    const s = await runSummary([SRC.fm], { 'URL1 - Scout Tasks': [TASK_FM], 'Tender Scout Agent': [agent], 'URL3 - Links to URLs': urls });
    const fm = s.per_source.francemarches, line = lineOf(s, 'francemarches');
    ok(fm.errors[0] === `list page 1 never read, its tenders are missing: the scout asked franc-than.com instead of francemarches.com (refused: not a host of any configured source) - ${TASK_FM.url}`, 'what is missing and why');
    ok(line.includes('| error: list page 1 never read, its tenders are missing: the scout asked franc-than.com instead of francemarches.com (refused: not a host of any configured source) (+1 more)')
      && !/allowedHosts|never opened/.test(fm.errors.join(' ')), 'first on the line, whole (its url, too long for the line, only in the JSON), once, in operator words');
    ok(s.failed_calls['Scout pages'] === 0 && fm.scout.refused === 1 && s.has_warnings, 'no failed call, still WARNINGS');
    return line.replace(/^.*\| error: /, 'francemarches error: ');
  });
C(A6, 'Run Summary: a refused page that loses nothing (real refusal)', 'a francemarches scout first asks "https://www.franc-than.com/" (mistyped host: Resolve Source + Page Links answer "PAGE ERROR … refused, no page read: … other hosts go in Config allowedHosts"), then reads list pages 1 and 2 and picks 3 notices',
  'listed for the operator ("refused before Firecrawl (no page read, no credit spent), franc-than.com is not a host of any configured source (add it … only if the site moved there)"), not as the agent\'s text; no coverage error, no failed call, no WARNINGS', 'Resolve Source, Page Links, EX2', async ok => {
    const bad = await openPage('https://www.franc-than.com/', {});
    const p1 = listPage('k3v9d1', TASK_FM.url, 'Appel d\'offre / Avis publics sur France Marchés', FM_LINKS.slice(0, 3).map(([id, t, slug]) => [id, t, fmUrl(slug)]));
    const agent = scoutAnswer(FM_LINKS.slice(0, 3).map(l => l[0]), [step('open_page', { url: 'https://www.franc-than.com/' }, bad.result), step('open_page', { url: TASK_FM.url }, p1), step('open_page', { url: TASK_FM.other_pages[0] }, FM_SEEN2)]);
    const urls = await run('URL3 - Links to URLs', [agent], { 'URL1 - Scout Tasks': [TASK_FM] });
    const s = await runSummary([SRC.fm], { 'URL1 - Scout Tasks': [TASK_FM], 'Tender Scout Agent': [agent], 'URL3 - Links to URLs': urls }), fm = s.per_source.francemarches;
    ok(/allowedHosts\)$/.test(bad.result) && urls.length === 3, 'real refusal, notices opened');
    ok(JSON.stringify(fm.errors) === JSON.stringify(['page https://www.franc-than.com/: refused before Firecrawl (no page read, no credit spent), franc-than.com is not a host of any configured source (add it to the source\'s allowedHosts in Config only if the site moved there)']), 'operator words');
    ok(!fm.coverage_errors && s.failed_total === 0 && fm.scout.refused === 1 && !s.has_warnings, 'nothing lost, no WARNINGS');
    return fm.errors[0];
  });
C(A6, 'Run Summary: next page left unread after the cap cut the list (real run 2)', 'run 2 domainetat-tn scout: START URL (asked "?cat=19&lang=-fr") and paged=2 read, NEXT PAGE paged=3 (run 2\'s detector), 8 picks, maxTendersPerUrlSource 5; control: the run-2 francemarches scout (page 1 refused, page 2 read twice: 3 of its 4 calls) with 3 picks',
  'domainetat-tn: no coverage error, hint "more pages exist (…paged=3), not read: the list was already cut by limits.maxTendersPerUrlSource = 5" (page 3\'s tenders, picked after the 8, would be cut too); control: "the scout stopped before the next page of the list (…page=3) with 1 page(s) left" (every open_page call counts, refused and repeated ones too)', 'EX2', async ok => {
    const next = (p, n) => p.replace('NEXT PAGE: none', `NEXT PAGE: ${n}`), cap = CFG.limits.maxTendersPerUrlSource;
    const agent = { output: JSON.stringify({ tender_links: ['6nirv3', '80wmse', '1qvfhuy', 'btoh2m', 'xyg2k3', 'mllwwi', 'e80573', '7bgzri'], list_url: TASK_DOM.url }),
      intermediateSteps: [step('open_page', { url: 'https://www.domainetat.tn/?cat=19&lang=-fr' }, next(DOM_SEEN1, `[v6azbh] | ${DPAGED(2)}`)), step('open_page', { url: TASK_DOM.other_pages[0] }, next(DOM_SEEN2, `[uwbdmi] | ${DPAGED(3)}`))] };
    const urls = await run('URL3 - Links to URLs', [agent], { 'URL1 - Scout Tasks': [TASK_DOM] });
    const s = await runSummary([SRC.dt], { 'URL1 - Scout Tasks': [TASK_DOM], 'Tender Scout Agent': [agent], 'URL3 - Links to URLs': urls }), d = s.per_source['domainetat-tn'];
    const c = (await runSummary([SRC.fm], { 'URL1 - Scout Tasks': [TASK_FM], 'Tender Scout Agent': [fmRun2(FM_LINKS.slice(0, 3).map(l => l[0]))] })).per_source.francemarches;
    ok(cap === 5 && urls.length === cap && d.links_picked === 8 && !d.coverage_errors && !d.errors.length
      && d.hints[0] === `more pages exist (${DPAGED(3)}), not read: the list was already cut by limits.maxTendersPerUrlSource = ${cap}`, 'hint, nothing lost');
    ok(c.errors.includes(`the scout stopped before the next page of the list (${FM_P3}) with 1 page(s) left`) && c.coverage_errors === 2, 'control: calls left');
    return `domainetat-tn hint: ${d.hints[0]} | control: ${c.errors[1]}`;
  });
C(A6, 'Run Summary: a failed market study is reported (real run 2)', 'run 2 T3j2315 "Prestations de développement numérique, d\'information et d\'accompagnement aux usages sur dataMEL …" (Métropole européenne de Lille, fit high): the Competitor & Budget Agent answer cut at 141 characters ("{\\"comparable_ids\\":[\\"D1iawp2m\\", …, \\"T643461-2026\\","), no error item; control: a tender studied from 3 priced awards',
  'headline "market studies 1 (1 failed)", a line naming the tender (answer_invalid and its check), has_warnings true for it alone (no failed call); control: no such line, no WARNINGS', 'MK2, EX2', async ok => {
    const cut = '{"comparable_ids":["D1iawp2m","D2wb6ch","Dgdas68","D1q95xr9","D11p9vme","D6wv0mx","Ddgf9u3","D1oybnqv","D1n73gbh","D14sq6bi","T643461-2026",';
    const mel = merged('3j2315', { source: 'boamp', source_type: 'api', title: 'Prestations de développement numérique, d\'information et d\'accompagnement aux usages sur dataMEL - plateforme métropolitaine de données open source de la Métropole Européenne de Lille',
      buyer: { name: 'Métropole européenne de Lille', country: 'FR', contacts: {} }, deadline: '2026-11-23', market: (await market({ output: cut, intermediateSteps: [similar(ROWS3)] })).market });
    const ok1 = merged('136zpko', { source: 'boamp', source_type: 'api', title: 'RENOUVELLEMENT DE LA SOLUTION DE BILLETTERIE ET DE GESTION DE LA RELATION CLIENT (GRC)',
      market: (await market(marketAgent({ comparable_ids: ['D1', 'D2', 'D3'] }, [similar(ROWS3)]))).market });
    const [s, c] = [await runSummary([SRC.boamp], { ...apiLane('boamp', [mel, ok1]), 'Merge Market': [mel, ok1] }), await runSummary([SRC.boamp], { ...apiLane('boamp', [ok1]), 'Merge Market': [ok1] })];
    const lines = s.message.split('\n'), mk = lines.find(l => l.startsWith('Market study failed')) || '';
    ok(mel.market.status === 'answer_invalid' && s.totals.market_failed === 1 && lines[1].includes('| market studies 1 (1 failed) |'), 'headline');
    ok(mk === 'Market study failed for 1 fit tender(s), no budget nor competitors in the export and the proposal input: "Prestations de développement numérique, d\'information et d\'accompagne…" (boamp, answer_invalid: agent final answer invalid: no JSON object in answer)', 'tender named');
    ok(s.failed_total === 0 && s.has_warnings && !c.has_warnings && !c.message.includes('Market study failed') && c.totals.market_studied === 1, 'WARNINGS for it alone');
    return mk;
  });
// the skip side of incremental runs, off in run 2 (test preset: skipKnown false): run 2's own export read back by a production run
C(A6, 'Next run reads run 2\'s export as its known ids (real rows)', 'run 2 sheet rows: Tdoatt8 (rank 9, canonical_id without the echoed ?q=, pair_key, deadline 2026-11-09), T1y9cdnw (analysis failed: blank keys), dropped T1709g1y and T1tdsy3z (award notices), the 5 expired domainetat-tn notices; next run (skipKnown on): run 2\'s scout answers (domainetat-tn 8 picks from pages 1-2, francemarches 3 picks from page 2), Tdoatt8 under another link (?q=logiciel), T1y9cdnw from BOAMP again',
  'URL3 opens only the 3 domainetat-tn links run 2 cut (?p=15845, ?p=15419, ?p=15409) and no francemarches link; Clean drops the Tdoatt8 copy as already exported (same title + buyer + deadline) and keeps T1y9cdnw (its analysis is retried)', '02, URL3, Clean', async ok => {
    const row = (tender_id, canonical_id, deadline, o = {}) => ({ tender_id, status: 'dropped', rank: '', canonical_id, pair_key: '', analysis_status: '', deadline, ...o });
    const fmId = slug => `url:https://www.francemarches.com/appel-offre/${slug}`;
    const sheet = [row('Tdoatt8', fmId(FM_LINKS[2][2]), '2026-11-09', { status: 'kept', rank: 9, pair_key: T1CS6W0U.pair_key, analysis_status: 'ok' }),
      row('T1y9cdnw', '', '2026-11-18', { status: 'kept', analysis_status: 'failed' }), row('T1709g1y', fmId(FM_LINKS[0][2]), ''), row('T1tdsy3z', 'boamp:26-87830', '2026-08-19'),
      ...[['T1aq05sa', 16872, '2026-09-11'], ['T1mcc5p3', 16804, '2026-08-12'], ['T1fqo7j7', 16800, '2026-08-04'], ['T11nmzdr', 16390, '2026-05-28'], ['T1rth1m', 16380, '2026-06-02']].map(([id, p, d]) => row(id, `url:${dtUrl(p)}`, d))];
    const [known] = await run('02 - Collect Known IDs', sheet), refs = task => ({ '00 - Config': [PROD()], '02 - Collect Known IDs': [known], 'URL1 - Scout Tasks': [task] });
    const dom = { ...DOM_AGENT, output: JSON.stringify({ tender_links: ['6nirv3', '80wmse', '1qvfhuy', 'btoh2m', 'xyg2k3', 'mllwwi', 'e80573', '7bgzri'], list_url: TASK_DOM.url }) };
    const d = (await run('URL3 - Links to URLs', [dom], refs(TASK_DOM))).map(l => l.url), f = await run('URL3 - Links to URLs', [fmRun2(FM_LINKS.slice(0, 3).map(l => l[0]))], refs(TASK_FM));
    const copy = tender({ ...T1CS6W0U, id: '1wdc4av', canonical_id: `url:${fmUrl(FM_LINKS[2][2], 'logiciel')}`, source_url: fmUrl(FM_LINKS[2][2], 'logiciel'), pair_key: undefined });
    const retry = tender({ id: '1y9cdnw', source: 'boamp', source_type: 'api', canonical_id: 'boamp:26-101317', source_url: 'https://www.boamp.fr/pages/avis/?q=idweb:26-101317', deadline: '2026-11-18',
      title: 'Accompagnement au Développement du Potentiel Managérial - Promotions 66-67-68', buyer: { name: 'ECOLE NATIONALE SUPERIEURE DE SECURITE SOCIALE', country: 'FR', contacts: {} } });
    const c = (await run('Clean & Dedupe', [copy, retry], { '00 - Config': [PROD()], '02 - Collect Known IDs': [known] })).filter(t => !t._type), st = id => c.find(t => t.tender_id === id) || {};
    ok(known.keys.length === 9 && JSON.stringify(known.pair_deadlines) === JSON.stringify({ [T1CS6W0U.pair_key]: ['2026-11-09'] }), 'keys and pair deadlines read back');
    ok(d.join() === [15845, 15419, 15409].map(dtUrl).join() && !f.length, 'URL3 opens only what run 2 never opened');
    ok(st('T1wdc4av').status === 'dropped' && /already exported/.test(st('T1wdc4av').drop_reason) && st('T1y9cdnw').status === 'kept', 'Clean: copy dropped, failed analysis retried');
    return `${known.note}; URL3 opens ${d.map(u => u.replace('https://www.domainetat.tn/', '')).join(', ')} + ${f.length} francemarches; Clean: T1wdc4av ${st('T1wdc4av').drop_reason}, T1y9cdnw ${st('T1y9cdnw').status}`;
  });
C(A2, 'Mandatory flag from the tender\'s words', '"doit disposer … au moins 5 ans", "doivent présenter …, valant pour 40% de la note", "serait appréciée"',
  'mandatory = true / false (a scored criterion is not blocking) / false', 'AN2', async ok => {
    const body = '# Assistance à maîtrise d\'ouvrage pour le schéma directeur numérique\nAcheteur : Département de Testshire\nDate limite : 20/11/2026\n'
      + 'Le prestataire accompagnera le département dans l\'élaboration de son schéma directeur numérique.\nLe prestataire doit disposer d\'un chef de projet ayant au moins 5 ans d\'expérience.\n'
      + 'Les candidats doivent présenter une méthodologie détaillée, valant pour 40% de la note.\nUne connaissance des collectivités territoriales serait appréciée.';
    const qs = ['Le prestataire doit disposer d\'un chef de projet ayant au moins 5 ans d\'expérience.', 'Les candidats doivent présenter une méthodologie détaillée, valant pour 40% de la note.',
      'Une connaissance des collectivités territoriales serait appréciée.'];
    const a = await analyse(tender({ title: 'Assistance à maîtrise d\'ouvrage pour le schéma directeur numérique', body_text: body }), analysisAnswer({ tender_type: 'consulting',
      quote: 'Le prestataire accompagnera le département dans l\'élaboration de son schéma directeur numérique.', requirements: [
        { category: 'team', text: 'A project manager with at least 5 years of experience', quote: qs[0] }, { category: 'experience', text: 'A detailed methodology', quote: qs[1] },
        { category: 'experience', text: 'Knowledge of local authorities', quote: qs[2] }] }));
    const m = a.requirements.items.map(r => r.mandatory);
    ok(JSON.stringify(m) === '[true,false,false]', 'flags'); return `mandatory ${m.join(', ')}`;
  });

C(A2, 'Skill lines sent to the RAG: split, checked, invented names refused', 'skill "React or Node.js frontend, CRM integration" for a ticketing notice naming no technology; "Minimum 3 senior developers, 1 PMP certified project manager"; "LLM chatbot with RAG" (a prompt example) for a video-analysis requirement',
  'React part refused (not in the quote), CRM kept (relation client = CRM); team line split in 2; the copied example refused and its requirement sent as written', 'AN2', async ok => {
    const qT = "fourniture et maintenance d'une solution de billetterie et de gestion de la relation client.";
    const qE = 'Le titulaire doit proposer au minimum 3 développeurs seniors et 1 chef de projet certifié PMP.';
    const qV = "un système d'intelligence artificielle permettant l'analyse d'images issues de la vidéoprotection.";
    const body = `# Billetterie et analyse d'images\nAcheteur : Ville de Testville\nDate limite : 20/11/2026\nObjet : ${qT}\n${qE}\nLe lot 2 porte sur ${qV}`;
    const a = await analyse(tender({ title: "Billetterie et analyse d'images", body_text: body }), analysisAnswer({ tender_type: 'software_build', quote: qE, requirements: [
      { category: 'technical', text: 'Ticketing and CRM solution', skill: 'React or Node.js frontend, CRM integration', quote: qT },
      { category: 'team', text: 'Minimum 3 senior developers and 1 PMP project manager', skill: 'Minimum 3 senior developers, 1 PMP certified project manager', quote: qE },
      { category: 'technical', text: "Système d'intelligence artificielle d'analyse d'images", skill: 'LLM chatbot with RAG', quote: qV }] }));
    const lines = a.requirements.items.map(r => r.rag_text);
    ok(!lines.some(l => /React|LLM/.test(l)), 'no invented name sent');
    ok(lines.includes('CRM integration'), 'CRM kept');
    ok(lines.includes('Minimum 3 senior developers') && lines.includes('1 PMP certified project manager'), 'team split');
    ok(lines.includes("Système d'intelligence artificielle d'analyse d'images"), 'copied example replaced by the requirement');
    return lines.join(' | ');
  });

C(A1, 'Short notice: link to the tender documents kept', 'BOAMP notices whose text is one sentence (requirements are in the DCE): legacy layout with urlDocConsul = platform home + urlProfilAcheteur = consultation page; eForms with a CallForTendersDocumentReference URI',
  'documents_url = the deep consultation link (not the platform home page), for both layouts; no requirement invented', 'API2', async ok => {
    const legacy = { MAPA: { organisme: { urlProfilAcheteur: 'https://marchespublics596280.fr/index.php?page=Entreprise.EntrepriseDetailsConsultation&id=588332' },
      initial: { communication: { urlDocConsul: 'https://achatpublic.com' }, description: { objet: 'Logiciel de gestion du temps' } } } };
    const eforms = { EFORMS: { ContractNotice: { ProcurementProject: { Name: 'Plateforme', Description: 'Plateforme numérique.' },
      ProcurementProjectLot: { TenderingTerms: { CallForTendersDocumentReference: { Attachment: { ExternalReference: { URI: 'https://www.marches-publics.info/mpiaws/index.cfm?fuseaction=dematEnt.login&amp;type=DCE&amp;IDM=1' } } } } } } } };
    const recs = [{ idweb: '26-1', objet: 'Logiciel de gestion du temps', nomacheteur: 'CC Test', dateparution: '2026-10-19', datelimitereponse: '2026-11-13', url_avis: 'https://www.boamp.fr/pages/avis/?q=idweb:26-1', donnees: JSON.stringify(legacy) },
      { idweb: '26-2', objet: 'Plateforme', nomacheteur: 'Ville Test', dateparution: '2026-10-19', datelimitereponse: '2026-11-20', url_avis: 'https://www.boamp.fr/pages/avis/?q=idweb:26-2', donnees: JSON.stringify(eforms) }];
    const out = await run('API2 - Map Records', [{ results: recs }], { 'API1 - Build Requests': [{ source: 'boamp', page: 1 }] });
    const urls = out.map(t => t.documents_url);
    ok(urls[0] === legacy.MAPA.organisme.urlProfilAcheteur, 'legacy: consultation page, not the platform home');
    ok(/marches-publics\.info.*IDM=1/.test(urls[1] || '') && !/&amp;/.test(urls[1]), 'eForms: documents URI, entities decoded');
    return urls.join(' | ');
  });

// analysis of the run of 2026-10-20 (execution_ragv2): real texts and real qwen3 answers
const analyseFull = async (t, answer) => { const an1 = await run('Build Analysis Prompt', await clean([t])); return { an1: an1[0], a: (await run('Verify Analysis', [answer], { 'Build Analysis Prompt': an1 }))[0] }; };
const LLM_AGENTS_PAGE = "Intitulé de l'appel d'offre public\nPrestations de développement d'agents LLM et services associés\n\n## Texte légal de l’appel d’offre (marché public)\n\nAvis de marché\n\nSection 4 - Identification du marché\n\nIntitulé du marché : Prestations de développement d'agents LLM et services associés\n\nCode CPV principal - Descripteur principal : 72000000\n\nDescription succincte du marché : Le présent marché a pour objet prestations de conseil, conception, développement, intégration, évolution, optimisation, sécurisation et industrialisation de solutions reposant sur l’intelligenceartificielle générative, notamment des agents LLM et des chaînes de génération augmentée par recherche documentaire (RAG).\n\nLieu principal d'exécution du marché : Martinique\n\nDurée du marché (en mois) : 12\n\nValeur estimée (H.T.) : 180000 euros\n\n## Appels d'offres de la même source\n\n- Construction d'un gymnase bioclimatique sur le campus du Tampon - Lot 6 : SERRURERIE / METALLERIE\n- Travaux de réhabilitation d'une maison à l'état d'abandon en gîte communal et touristique\n- Location et entretien de vêtements de travail\n\n## Livre blanc\n\nPME - TPE : Guide pratique pour remporter des marchés publics";
const LLM_AGENTS_ANSWER = { text: JSON.stringify({ tender_type: 'ai_data', fit: 'high', reason: ['agents LLM', 'chaînes de génération augmentée par recherche documentaire (RAG)'], services: ['AI / LLM solutions (chatbots, RAG, document intelligence)'],
  quote: 'Le présent marché a pour objet prestations de conseil, conception, développement, intégration, évolution, optimisation, sécurisation et industrialisation de solutions reposant sur l’intelligence artificielle générative, notamment des agents LLM et des chaînes de génération augmentée par recherche documentaire (RAG).',
  sector: 'tourism', requirements: [{ category: 'technical', text: 'Conception, développement, intégration, évolution, optimisation, sécurisation et industrialisation de solutions reposant sur l’intelligence artificielle générative', skill: 'LLM chatbot with RAG',
    quote: 'conception, développement, intégration, évolution, optimisation, sécurisation et industrialisation de solutions reposant sur l’intelligence artificielle générative, notamment des agents LLM et des chaînes de génération augmentée par recherche documentaire (RAG)' }], timeline: '12' }) };
C(A2, 'Copied prompt example on the LLM-agents notice (real)', 'francemarches page "agents LLM et ... (RAG)" + real answer: skill "LLM chatbot with RAG" (the old prompt example, no chatbot in the quote), text = the French quote, sector "tourism" (only in another notice listed on the page), timeline "12", services given by name',
  'the added "chatbot" is cut: "LLM with RAG" sent and shown (not the French quote); the "other notices" section is not analysed, so sector "public sector" (sector_not_in_text); timeline "12 mois"; service 2 matched; the prompt has no example line to copy', 'AN1, AN2', async ok => {
    const { an1, a } = await analyseFull(tender({ id: 'llmagents', title: "Prestations de développement d'agents LLM et services associés", body_text: LLM_AGENTS_PAGE, buyer: { name: "City'up (972)", country: 'FR', contacts: {} }, cpv: ['72000000'], deadline: '2026-10-26' }), LLM_AGENTS_ANSWER);
    ok(!/touristique/.test(an1._text) && /Durée du marché \(en mois\) : 12/.test(an1._text), 'listing of other notices cut, the notice kept');
    ok(!/LLM chatbot with RAG|Online booking platform|React or Angular frontend/.test(an1._usr), 'no example skill line in the prompt');
    const r = a.requirements.items;
    ok(r.length === 1 && r[0].rag_text === 'LLM with RAG' && r[0].skill_cut === 'chatbot' && r[0].text === 'LLM with RAG', 'chatbot cut, English text');
    ok(a.analysis.sector === 'public sector' && a.analysis.checks.includes('sector_not_in_text'), 'sector from page noise replaced');
    ok(a.analysis.timeline === '12 mois', 'unit from the text');
    ok(JSON.stringify(a.analysis.matched_services) === JSON.stringify([CFG.company.services[1]]), 'service given by name');
    return `rag_text "${r.map(x => x.rag_text)}" (cut ${r.map(x => x.skill_cut)}), sector ${a.analysis.sector}, timeline "${a.analysis.timeline}", services ${a.analysis.matched_services.length}, checks ${a.analysis.checks}`;
  });
C(A2, 'Company service line sent as a requirement (real)', 'BOAMP ticketing + CRM notice (EPCC Metz en scènes) + real answer: skill "web and mobile applications, CRM integration", no services (their names in the reason), sector "tourism"',
  '"web and mobile applications" refused (no web / mobile in the quote), "CRM integration" kept (relation client); services from the reason: only CRM, the one the text states; sector "public sector" (sector_not_in_text)', 'AN2', async ok => {
    const title = 'RENOUVELLEMENT DE LA SOLUTION DE BILLETTERIE ET DE GESTION DE LA RELATION CLIENT (GRC)';
    const quote = "fourniture, la mise en oeuvre, l'hébergement et la maintenance d'une solution de billetterie et de gestion de la relation client";
    const body = `${title}\n\nLa consultation porte sur la fourniture, la mise en oeuvre, l'hébergement et la maintenance d'une solution de billetterie et de gestion de la relation client, ainsi que du matériel associé, pour les trois sites de l'EPCC Metz en Scènes.\n\nLogiciel`;
    const a = await analyse(tender({ title, body_text: body, buyer: { name: 'EPCC Metz en scènes', country: 'FR', contacts: {} } }), { text: JSON.stringify({ tender_type: 'software_build', fit: 'high',
      reason: ['web and mobile applications', 'CRM and enterprise software integration'], quote, sector: 'tourism', requirements: [{ category: 'technical', text: quote, skill: 'web and mobile applications, CRM integration', quote }], timeline: null }) });
    const lines = a.requirements.items.map(r => r.rag_text);
    ok(JSON.stringify(lines) === '["CRM integration"]', 'only CRM sent');
    ok(a.requirements.dropped.some(d => d.text === 'web and mobile applications' && /skill part not in quote/.test(d.why)), 'service line refused');
    ok(JSON.stringify(a.analysis.matched_services) === JSON.stringify([CFG.company.services[4]]), 'CRM service only');
    ok(a.analysis.sector === 'public sector' && a.analysis.checks.includes('sector_not_in_text'), 'sector');
    return `sent ${lines.join(' | ')}; dropped ${a.requirements.dropped.map(d => `"${d.text}" (${d.why})`).join(' | ')}; services ${a.analysis.matched_services}; sector ${a.analysis.sector}`;
  });
C(A2, 'Invented integration requirements for a sales-data study (real)', 'BOAMP "Suivi des données de vente ..." (category Etude) + real answer: "Data integration from pharmacy and online sales systems" and "The solution must connect to existing software platforms used by retailers and pharmacies." quoting the lot 2 sentence (officines et parapharmacies); services given by name',
  'both refused (online = lot 3, retail and software not in the quote; the refused skill line no longer falls back to an invented sentence); services 4 and 5 mapped from their names; the prompt rates a study / data supply low', 'AN1, AN2', async ok => {
    const title = 'Suivi des données de vente des produits de prévention en santé sexuelle disponibles en France';
    const lot = (n, x) => `-lot ${n} : Suivi des données de vente ${x}`;
    const q2 = 'Suivi des données de vente des produits de prévention en santé sexuelle disponibles en France et diffusés dans le secteur des officines et parapharmacies.';
    const body = `${title}\n\nLe marché a pour objet le suivi des données de vente des produits de prévention en santé sexuelle disponibles en France. Il est décomposé en trois lots de la manière suivante : ${lot(1, 'des produits de prévention en santé sexuelle disponibles en France et diffusés dans le secteur de la grande distribution.')} ${lot(2, 'des produits de prévention en santé sexuelle disponibles en France et diffusés dans le secteur des officines et parapharmacies.')} ${lot(3, 'en ligne de produits de prévention en santé sexuelle disponibles en France.')}\n\n${q2}\n\nEtude`;
    const { an1, a } = await analyseFull(tender({ title, body_text: body, buyer: { name: 'Santé publique France', country: 'FR', contacts: {} } }), { text: JSON.stringify({ tender_type: 'integration_saas', fit: 'high',
      reason: 'The tender requires collecting and processing sales data from different distribution channels, which involves integrating existing software systems (offices, pharmacies, online stores) to extract and manage data.',
      services: ['data platforms, integration and BI / analytics', 'CRM and enterprise software integration'], quote: q2, sector: 'health', requirements: [
        { category: 'technical', text: 'The system must collect and process sales data from various distribution channels including pharmacies and online stores.', skill: 'Data integration from pharmacy and online sales systems', quote: q2 },
        { category: 'technical', text: 'The solution must connect to existing software platforms used by retailers and pharmacies.', skill: 'SaaS integration with retail and pharmacy software', quote: q2 }], timeline: null }) });
    ok(a.requirements.items.length === 0 && a.requirements.dropped.length === 2, 'nothing invented sent');
    ok(/not in quote: web/.test(a.requirements.dropped[0].why) && /not in quote: retail/.test(a.requirements.dropped[1].why), 'reasons');
    ok(JSON.stringify(a.analysis.matched_services) === JSON.stringify([CFG.company.services[3], CFG.company.services[4]]), 'services by name');
    ok(/a study, a survey or a supply of data/.test(an1._usr), 'prompt rule for studies');
    return `kept ${a.requirements.items.length}; dropped ${a.requirements.dropped.map(d => d.why).join(' | ')}; services ${a.analysis.matched_services.length}; sector ${a.analysis.sector}`;
  });
C(A2, 'Skill line narrowing or extending its quote (real)', 'dataMEL notice (MEL): "Experience in open source data management in public sector" for "... auprès d’acteurs publics ou privés"; "Methodology for development of open-source data platforms" for "Pertinence de la méthodologie d’intervention ..."; both texts = the French quote',
  'the narrowing "in public sector" is cut ("Experience in open source data management", shown in English); the methodology line names what its quote does not, and its text is the untranslated quote: dropped', 'AN2', async ok => {
    const title = "Prestations de développement numérique, d'information et d'accompagnement aux usages sur dataMEL - plateforme métropolitaine de données open source de la Métropole Européenne de Lille";
    const q1 = 'Pertinence de la méthodologie d’intervention mise en œuvre pour l’exécution du marché au regard du cadre de mémoire technique';
    const q2 = 'Pertinence de l’expérience des équipes affectées au marché dans l’environnement open source, dans le cadre de la gestion et l’exploitation données, auprès d’acteurs publics ou privés';
    const qP = 'Prestations de développement informatique et numérique sur les briques fonctionnelles « socle /cœur » de dataMEL';
    const body = `${title}\n\n${qP} - Plateforme métropolitaine de données open source de la Métropole Européenne de Lille: Le marché est un accord-cadre à bons de commande et à marchés subséquents multi-attributaire sans montant minimum et d'un montant maximum de 600 000 € HT sur la durée totale du marché (4 ans)\n\nAward criteria: Valeur technique - Sous-critères: "${q1}" valant pour 10% de la note finale - "${q2} analysé au regard du cadre de mémoire technique " valant pour 30% de la note finale (50); Prix des prestations (40)\n\nLogiciel`;
    const a = await analyse(tender({ title, body_text: body, buyer: { name: 'Métropole européenne de Lille', country: 'FR', contacts: {} } }), { text: JSON.stringify({ tender_type: 'software_build', fit: 'high', reason: 'The tender requires development of core functional bricks for dataMEL.',
      services: ['1. web and mobile applications, custom software and digital platforms', '4. data platforms, integration and BI / analytics'], quote: qP, sector: 'public sector', requirements: [
        { category: 'technical', text: q1, skill: 'Methodology for development of open-source data platforms', quote: q1 }, { category: 'experience', text: q2, skill: 'Experience in open source data management in public sector', quote: q2 }], timeline: '4 ans' }) });
    const r = a.requirements.items;
    ok(r.length === 1 && r[0].rag_text === 'Experience in open source data management' && r[0].text === r[0].rag_text && r[0].skill_cut === 'public', 'narrowing cut, English text');
    ok(a.requirements.dropped.length === 1 && /untranslated quote/.test(a.requirements.dropped[0].why), 'extension + French copy dropped');
    ok(a.analysis.matched_services.length === 2, 'numbered service names');
    return `sent "${r.map(x => x.rag_text)}"; dropped ${a.requirements.dropped.map(d => d.why).join(' | ')}`;
  });
C(A2, 'Requirement written in the text but not extracted (real demo)', 'Power BI demo: the answer has no row for "L’accès doit être géré par rôles." (mandatory); tourism-licence demo: none for "Une certification ISO 27001 est souhaitée."; their other rows copy the French quote as text',
  'each such sentence is listed in requirements.uncovered (the buyer\'s own "souhaite disposer" and the extracted sentences are not); the French quote copies are replaced by the checked English skill line', 'AN2', async ok => {
    const t1 = 'Tableau de bord décisionnel des indicateurs de santé publique';
    const b1 = `${t1}\n\nLa Direction Régionale de la Santé souhaite disposer d'un tableau de bord décisionnel consolidant les indicateurs des établissements de santé. Exigences techniques : les tableaux de bord doivent être réalisés sous Power BI. Les flux de données doivent être automatisés avec des pipelines Python. La solution doit être hébergée sur Azure. L'accès doit être géré par rôles. Équipe : le titulaire doit proposer 1 chef de projet et 2 ingénieurs data. Expérience : le titulaire doit justifier d'au moins 1 projet de tableau de bord dans le secteur de la santé. Durée : 6 mois. Critères d'attribution : valeur technique (60), prix (40).`;
    const qa = 'Les tableaux de bord doivent être réalisés sous Power BI. Les flux de données doivent être automatisés avec des pipelines Python. La solution doit être hébergée sur Azure.';
    const qb = 'le titulaire doit proposer 1 chef de projet et 2 ingénieurs data.', qc = "le titulaire doit justifier d'au moins 1 projet de tableau de bord dans le secteur de la santé.";
    const a = await analyse(tender({ title: t1, body_text: b1 }), { text: JSON.stringify({ tender_type: 'ai_data', fit: 'high', reason: 'Power BI dashboards.', services: ['4. data platforms, integration and BI / analytics'], quote: qa, sector: 'health', requirements: [
      { category: 'technical', text: qa, skill: 'Power BI, Python pipelines, Azure hosting', quote: qa }, { category: 'team', text: qb, skill: '1 project manager, 2 data engineers', quote: qb },
      { category: 'experience', text: qc, skill: '1 health sector dashboard project', quote: qc }], timeline: '6 mois' }) });
    ok(JSON.stringify(a.requirements.uncovered) === JSON.stringify(["L'accès doit être géré par rôles."]), 'role-based access listed');
    ok(a.requirements.items.length === 6 && a.requirements.items[5].text === '1 health sector dashboard project', 'French copy replaced by the skill line');
    const t2 = "Développement d'une plateforme numérique de gestion des licences touristiques";
    const q9 = "le soumissionnaire doit justifier d'au moins 2 projets numériques similaires dans le secteur public.";
    const b2 = `${t2}\n\nL'Office du Tourisme de Sampleville lance un appel d'offres pour le développement d'une plateforme web de gestion des licences des établissements touristiques. Expérience : ${q9} Une certification ISO 27001 est souhaitée. Durée d'exécution : 6 mois.`;
    const b = await analyse(tender({ title: t2, body_text: b2 }), { text: JSON.stringify({ tender_type: 'software_build', fit: 'high', reason: 'A web platform.', services: ['1. web and mobile applications, custom software and digital platforms'], quote: t2, sector: 'tourism',
      requirements: [{ category: 'experience', text: q9, skill: '2+ public sector digital projects', quote: q9 }], timeline: '6 mois' }) });
    ok(JSON.stringify(b.requirements.uncovered) === JSON.stringify(['Une certification ISO 27001 est souhaitée.']), 'wished certification listed');
    ok(b.requirements.items[0].rag_text === '2+ public sector digital projects' && b.requirements.items[0].text === b.requirements.items[0].rag_text && b.analysis.sector === 'tourism', 'public sector stated, tourism stated');
    return `uncovered: ${a.requirements.uncovered.join(' | ')} / ${b.requirements.uncovered.join(' | ')}`;
  });
C(A2, 'Timeline without its unit', 'timeline "12" for "Durée du marché (en mois) : 12" (above), "24" for "La durée du marché est de 24 mois", "36" (not in the text), "24 mois"',
  '"24 mois" (unit taken next to the number in the text); "36" -> null (a bare number says nothing); "24 mois" unchanged', 'AN2', async ok => {
    const got = [];
    for (const timeline of ['24', '36', '24 mois']) got.push((await analyse(keptSample(), analysisAnswer({ timeline }))).analysis.timeline);
    ok(JSON.stringify(got) === JSON.stringify(['24 mois', null, '24 mois']), 'units');
    return got.map(String).join(', ');
  });
C(A2, 'Services given by name or not at all (real)', 'services ["web and mobile applications"] (HR software notice), ["consulting"] (outsourced IT department), none + reason keywords (IT support notice)',
  'service 1 mapped from its name; "consulting" is no SERVICES line: [] and check no_service_matched (fit kept); none: [] + no_service_matched', 'AN2', async ok => {
    const s1 = await analyse(keptSample(), analysisAnswer({ services: ['web and mobile applications'] }));
    const s2 = await analyse(keptSample(), analysisAnswer({ services: ['consulting'] }));
    const s3 = await analyse(keptSample(), analysisAnswer({ services: undefined, reason: ['assistance', 'maintenance', 'evolution', 'accompagnement des utilisateurs', 'internet', 'appui'] }));
    ok(JSON.stringify(s1.analysis.matched_services) === JSON.stringify([CFG.company.services[0]]) && !s1.analysis.checks.includes('no_service_matched'), 'name mapped');
    ok(!s2.analysis.matched_services.length && s2.analysis.checks.includes('no_service_matched') && s2.analysis.fit === 'high', 'unknown service flagged');
    ok(!s3.analysis.matched_services.length && s3.analysis.checks.includes('no_service_matched'), 'none flagged');
    return `${s1.analysis.matched_services.length} | ${s2.analysis.checks} | ${s3.analysis.checks}`;
  });
const reqAnswer = (quote, requirements, o = {}) => ({ text: JSON.stringify({ tender_type: 'software_build', fit: 'high', reason: 'A software solution to build.', services: ['1'], quote, sector: 'public sector', requirements, timeline: null, ...o }) });
const rowsOf = a => a.requirements.items.map(r => r.rag_text + (r.skill_cut ? ` (cut ${r.skill_cut})` : ''));
C(A2, 'Kind of system named by the title only (real)', 'demo notice "... assistant conversationnel IA (chatbot RAG)" + real answer "LLM chatbot with RAG", "multilingual chatbot (French and Arabic)" (quotes say "la solution", "L\'assistant"); BOAMP notice "... gestion des sites internet ..." + real answer (no skill line, quote without "sites internet"); title "Application mobile de signalement" + quote "L\'application doit ..."; a health-dashboard line for a health-institutions title',
  'a kind of system (chatbot, website, mobile app) the title names is stated: lines kept as written; a SECTOR the title names is not (the quote does not ask for health-sector experience): "health" still cut', 'AN2', async ok => {
    const t1 = "Mise en place d'un assistant conversationnel IA (chatbot RAG) pour le service aux usagers";
    const q1 = 'la solution doit utiliser un grand modèle de langage (LLM) avec une architecture RAG (génération augmentée par la recherche)', q2 = "L'assistant doit répondre en français et en arabe";
    const b1 = `${t1}\n\nObjet : conception et déploiement d'un assistant conversationnel basé sur l'intelligence artificielle générative pour répondre aux questions des usagers à partir de la documentation interne de l'agence. Exigences techniques : ${q1}. ${q2}. La solution doit s'appuyer sur une base de données vectorielle. Le développement doit être réalisé en Python. Équipe : le soumissionnaire doit mobiliser au moins 1 ingénieur IA et 1 chef de projet. Expérience : le soumissionnaire doit présenter au moins 1 référence de chatbot ou d'assistant IA déjà déployé. Durée : 5 mois. Critères d'attribution : valeur technique (70), prix (30).\n\nAward criteria: Valeur technique (70); Prix (30)`;
    const a = await analyse(tender({ title: t1, body_text: b1, buyer: { name: 'Agence Nationale des Services Numériques de Sampleville (démo)', country: 'FR', contacts: {} } }), reqAnswer(q1, [
      { category: 'technical', text: q1, skill: 'LLM chatbot with RAG', quote: q1 }, { category: 'technical', text: q2, skill: 'multilingual chatbot (French and Arabic)', quote: q2 }]));
    ok(JSON.stringify(rowsOf(a)) === '["LLM chatbot with RAG","multilingual chatbot (French and Arabic)"]', 'chatbot of the title kept');
    const t2 = "Hébergement, maintenance et gestion des sites internet de l'agglomération, accessibilité numérique, et prestations de marketing digital et de visibilité";
    const p2 = "Prestations techniques et applicatives relatives aux six (6) sites internet de la Communauté d'agglomération de Saint-Quentin-en-Yvelines : hébergement et infogérance, maintenance technique et applicative, gestion et support éditorial, et accessibilité numérique (RGAA)";
    const m2 = "Prestations de marketing digital et de visibilité numérique de l'acheteur : référencement naturel (SEO) sur missions spécifiques, et campagnes sur les réseaux sociaux (social ads) incluant le pilotage des campagnes et l'achat d'espace publicitaire. Ces prestations concernent la visibilité globale du territoire et dépassent le seul périmètre des sites internet";
    const b2 = `${t2}\n\nLes prestations portent sur l'ensemble des sites internet de la Communauté d'agglomération de Saint-Quentin-en-Yvelines ainsi que sur les actions de marketing digital et de visibilité numérique du territoire\n\n${p2}\n\n${m2}\n\nAward criteria: Valeur technique (65); Critère environnementale (5); Prix (30)\n\nSite internet, Prestations de services`;
    const q3 = 'maintenance technique et applicative, gestion et support éditorial, et accessibilité numérique (RGAA)';
    const b = await analyse(tender({ title: t2, body_text: b2, buyer: { name: "Saint-Quentin-en-Yvelines - Communauté d'agglomération", country: 'FR', contacts: {} } }), reqAnswer('hébergement et infogérance, maintenance technique et applicative, gestion et support éditorial, et accessibilité numérique (RGAA)', [
      { category: 'technical', text: 'Maintenance technique et applicative des sites internet et accessibilité numérique (RGAA)', quote: q3, mandatory: true }], { tender_type: 'maintenance_support', services: [1] }));
    ok(rowsOf(b)[0] === 'Maintenance technique et applicative des sites internet et accessibilité numérique (RGAA)' && !b.requirements.dropped.length, 'websites of the title kept');
    const t3 = 'Application mobile de signalement', q4 = "L'application doit permettre l'envoi de photos géolocalisées.";
    const b3 = `${t3}\n\nLa commune souhaite mettre à disposition des habitants une application de signalement des anomalies sur l'espace public (voirie, propreté, éclairage). ${q4} Les signalements sont transmis aux services techniques par un back-office. Le marché comprend la conception, le développement, l'hébergement et la maintenance de la solution.`;
    const mob = async (skill, text) => analyse(tender({ title: t3, body_text: b3 }), reqAnswer(q4, [{ category: 'technical', text, skill, quote: q4 }]));
    const c1 = await mob('Mobile app with geolocated photo upload', 'The mobile app must allow geolocated photo upload'), c2 = await mob(null, 'The mobile app must allow geolocated photo upload');
    ok(rowsOf(c1)[0] === 'Mobile app with geolocated photo upload' && rowsOf(c2)[0] === 'The mobile app must allow geolocated photo upload', 'mobile of the title kept (skill line and sentence)');
    const t4 = 'Tableau de bord des indicateurs des établissements de santé', q5 = 'Les tableaux de bord doivent être réalisés sous Power BI.';
    const d = await analyse(tender({ title: t4, body_text: `${t4}\n\nLa Direction souhaite disposer d'un tableau de bord consolidant les indicateurs d'activité de ses établissements. ${q5} Les données sont mises à jour chaque semaine à partir des fichiers transmis par les établissements, et les indicateurs sont partagés avec les directions métiers.` }),
      reqAnswer(q5, [{ category: 'technical', text: 'Dashboards built with Power BI', skill: 'Power BI health dashboards', quote: q5 }]));
    ok(JSON.stringify(rowsOf(d)) === '["Power BI dashboards (cut health)"]', 'sector of the title still cut');
    return `${rowsOf(a).join(' | ')} / ${rowsOf(b)} / ${rowsOf(c1)} | ${rowsOf(c2)} / ${rowsOf(d)}`;
  });
C(A2, 'Private cloud is no public / private narrowing', '"Private cloud hosting" for "L\'hébergement sera réalisé sur un cloud privé, l\'administration étant assurée par le titulaire." (privé + administration, not a pair); "Data management references for private clients" for "... dans les secteurs public et privé ..."',
  'the first line kept as written ("private" is stated and is no sector here); the second narrows a public-and-private pair to private clients: cut to "Data management references"', 'AN2', async ok => {
    const t = "Infogérance du système d'information", q1 = "L'hébergement sera réalisé sur un cloud privé, l'administration étant assurée par le titulaire.";
    const q2 = 'Le titulaire justifiera de références dans les secteurs public et privé pour la gestion des données.';
    const a = await analyse(tender({ title: t, body_text: `${t}\n\nLe marché porte sur l'infogérance du système d'information de la collectivité : exploitation, supervision et maintien en condition opérationnelle des serveurs et des applications métiers. ${q1} ${q2} Le titulaire assurera aussi le support aux utilisateurs.` }),
      reqAnswer(q1, [{ category: 'technical', text: 'Private cloud hosting administered by the contractor', skill: 'Private cloud hosting', quote: q1 }, { category: 'experience', text: 'Data management references with private clients', skill: 'Data management references for private clients', quote: q2 }]));
    ok(JSON.stringify(rowsOf(a)) === '["Private cloud hosting","Data management references (cut private)"]', 'pair only');
    return rowsOf(a).join(' | ');
  });
C(A2, 'Sector word inside another word', '"Retail platform for secondary schools" for "... établissements d\'enseignement secondaire" (enseignement is no retail sign: "enseigne" is); the Arabic e-services notice (real text) + "Health app in Arabic and French" for "يجب أن يكون التطبيق متاحا ..." (طبي is inside تطبيق) and its real "1 public sector digital project reference"; sector "finance" for an EU-cofunded notice (financement FEDER)',
  'retail and health are not stated: both cut; the public-sector reference stays (بلدية, عمومي start a word); sector "finance" not in the text: "public sector" + sector_not_in_text', 'AN2', async ok => {
    const t1 = 'Plateforme numérique de ressources pédagogiques', q1 = "La plateforme doit être accessible aux établissements d'enseignement secondaire.";
    const a = await analyse(tender({ title: t1, body_text: `${t1}\n\nLe rectorat souhaite mettre en place une plateforme numérique de ressources et de suivi pédagogique pour les enseignants et les élèves de son académie. ${q1} Le marché comprend la conception, le développement, l'hébergement et la maintenance de la plateforme pendant trois ans.` }),
      reqAnswer(q1, [{ category: 'technical', text: 'Platform for secondary schools', skill: 'Retail platform for secondary schools', quote: q1 }], { sector: 'education' }));
    ok(JSON.stringify(rowsOf(a)) === '["platform for secondary schools (cut retail)"]', 'retail not stated');
    const t2 = 'بوابة الخدمات الإلكترونية للمواطنين', q2 = 'يجب أن يكون التطبيق متاحا باللغتين العربية والفرنسية', q3 = 'يجب على العارض تقديم مرجع واحد على الأقل لبوابة خدمات إلكترونية لفائدة بلدية أو هيكل عمومي';
    const b2 = `${t2}\n\nموضوع طلب العروض: تطوير بوابة إلكترونية تمكن المواطنين من تقديم مطالبهم الإدارية عبر الإنترنت ومتابعتها والدفع الإلكتروني. المتطلبات التقنية: يجب تطوير الواجهة باستعمال Angular. يجب تطوير الخادم باستعمال Node.js. يجب استعمال قاعدة بيانات PostgreSQL. يجب استضافة البوابة على AWS. ${q2}. الفريق: يجب على العارض توفير مدير مشروع و3 مطورين على الأقل. الخبرة: ${q3}. مدة الإنجاز: 7 أشهر.`;
    const b = await analyse(tender({ title: t2, body_text: b2, language: 'ar', buyer: { name: 'بلدية سامبلفيل', country: 'TN', contacts: {} } }), reqAnswer(q3, [
      { category: 'technical', text: 'Health app in Arabic and French', skill: 'Health app in Arabic and French', quote: q2 }, { category: 'experience', text: q3, skill: '1 public sector digital project reference', quote: q3 }]));
    ok(JSON.stringify(rowsOf(b)) === '["app in Arabic and French (cut health)","1 public sector digital project reference"]', 'Arabic forms start a word');
    const t3 = 'Développement du portail des aides économiques de la Région';
    const c = await analyse(tender({ title: t3, body_text: `${t3}\n\nLe marché porte sur la conception, le développement et la maintenance du portail en ligne de dépôt et de suivi des demandes d'aides économiques des entreprises du territoire. Ce projet est cofinancé par l'Union européenne dans le cadre du financement FEDER. Le portail doit être accessible et conforme au RGAA.` }),
      reqAnswer('Le marché porte sur la conception, le développement et la maintenance du portail en ligne de dépôt et de suivi des demandes', [], { sector: 'finance' }));
    ok(c.analysis.sector === 'public sector' && c.analysis.checks.includes('sector_not_in_text'), 'financement is no finance sector');
    return `${rowsOf(a)} / ${rowsOf(b).join(' | ')} / sector ${c.analysis.sector} (${c.analysis.checks})`;
  });
C(A2, 'Obligation sentences that are procedure or not (real)', 'TED téléalarme notice (real text and answer): "... la plateforme devra être pleinement opérationnelle au 25/01/2027." with no row; a notice with "consignes de sécurité", "un chef de projet désigné devra ...", "plan d\'assurance qualité", "attestation d\'assurance", "acte d\'engagement ... signé"',
  'the date sentence is a deadline, not listed; consignes / désigné / assurance qualité are real obligations and listed in requirements.uncovered; the insurance certificate and the signature are procedure', 'AN2', async ok => {
    const t1 = "Mise à disposition d'une plateforme d'écoute pour la téléalarme (réception et traitement des appels téléalarme), d'un logiciel de gestion administrative et SAV";
    const b1 = `${t1}\n\nL'accord-cadre sera exécuté par l'émission de bons de commande. Les prestations sont réglées par des prix unitaires. La présente consultation concerne les exigences fonctionnelles, techniques et organisationnelles relatives à la mise à disposition d'une plateforme d'écoute de téléassistance (réception et traitement des appels téléalarme), assortie d'un accès complet à un logiciel de gestion administrative et technique (SAV). Pour assurer la continuité du service, la plateforme devra être pleinement opérationnelle au 25/01/2027. La description des prestations et leurs spécifications techniques sont indiquées dans le cahier des clauses techniques particulières (CCTP). Montant HT maximum (sur la durée totale) : 840 000 euro(s)`;
    const a = await analyse(tender({ title: t1, body_text: b1, buyer: { name: 'CCAS de Bourgoin-Jallieu', country: 'FR', contacts: {} } }), reqAnswer(t1, [
      { category: 'technical', text: 'La plateforme devra être pleinement opérationnelle au 25/01/2027', quote: 'La plateforme devra être pleinement opérationnelle au 25/01/20-27', mandatory: true }], { timeline: '25/01/2027' }));
    ok(Array.isArray(a.requirements.uncovered) && !a.requirements.uncovered.length, 'date sentence not listed');
    const t2 = "Maintenance applicative du système d'information des services techniques";
    const real = ['Le titulaire devra respecter les consignes de sécurité du site.', 'Un chef de projet désigné devra coordonner les équipes techniques.', "Le titulaire devra fournir un plan d'assurance qualité détaillé."];
    const b = await analyse(tender({ title: t2, body_text: `${t2}\n\nLe marché porte sur la maintenance corrective et évolutive des applications métiers des services techniques. ${real[0]} ${real[1]} ${real[2]} Le titulaire devra fournir une attestation d'assurance responsabilité civile. L'acte d'engagement doit être signé par le mandataire.` }),
      reqAnswer('Le marché porte sur la maintenance corrective et évolutive des applications métiers des services techniques.', [], { tender_type: 'maintenance_support' }));
    ok(JSON.stringify(b.requirements.uncovered) === JSON.stringify(real), 'real obligations listed, procedure not');
    return `${a.requirements.uncovered.length} / ${b.requirements.uncovered.join(' | ')}`;
  });
C(A2, 'Bare-number timeline next to another count', 'timeline "3" for a text with "3 ans d\'expérience" and "Durée (en mois) : 3"; "3" for a text with "3 ans d\'expérience" only',
  '"3 mois" (the duration label wins over the first "3 <unit>"); null (a count of years of experience is no duration)', 'AN2', async ok => {
    const t = "Développement d'une application de gestion des demandes citoyennes";
    const body = x => `${t}\n\nLe marché porte sur la conception, le développement et l'hébergement d'une application de gestion des demandes des habitants, avec un back-office pour les agents. Le chef de projet doit justifier de 3 ans d'expérience sur des projets similaires. ${x}`;
    const got = [];
    for (const x of ['Durée (en mois) : 3', 'Critères : valeur technique (60), prix (40).']) got.push((await analyse(tender({ title: t, body_text: body(x) }), reqAnswer('Le marché porte sur la conception, le développement et l\'hébergement d\'une application de gestion des demandes des habitants', [], { timeline: '3' }))).analysis.timeline);
    ok(JSON.stringify(got) === JSON.stringify(['3 mois', null]), 'units');
    return got.map(String).join(', ');
  });
C(A2, 'Other notices listed as sub-headings', 'the LLM-agents page (real) with its "## Appels d\'offres de la même source" listing the other notices as "### ..." sub-headings, then "## Livre blanc"',
  'the sub-headings are cut with their section (no "gîte communal et touristique" reaches the model), the next "##" section is kept; sector "tourism" -> "public sector"', 'AN1, AN2', async ok => {
    const page = LLM_AGENTS_PAGE.replace(/- Construction[^\n]*\n- Travaux[^\n]*\n- Location[^\n]*/, "### Travaux de réhabilitation d'une maison à l'état d'abandon en gîte communal et touristique\n\nLot unique : gros œuvre et menuiseries.\n\n### Location et entretien de vêtements de travail\n\nAccord-cadre de 4 ans.");
    const { an1, a } = await analyseFull(tender({ id: 'llmsub', title: "Prestations de développement d'agents LLM et services associés", body_text: page, buyer: { name: "City'up (972)", country: 'FR', contacts: {} }, cpv: ['72000000'], deadline: '2026-10-26' }), LLM_AGENTS_ANSWER);
    ok(/### Travaux/.test(page) && !/touristique|vêtements/.test(an1._text) && /Livre blanc/.test(an1._text) && /Durée du marché \(en mois\) : 12/.test(an1._text), 'sub-headings cut, next section kept');
    ok(a.analysis.sector === 'public sector' && a.analysis.checks.includes('sector_not_in_text'), 'sector');
    return `text ${an1._text.length} chars, sector ${a.analysis.sector}`;
  });

C(A2, 'Empty list as the reason (real)', 'second RAG v2 run: qwen3 answers "reason": [] for a training notice (fit none) and for a Microsoft O365 licence supply, 7 of 24 analyses',
  'the answer is used (fit none / hardware_supply kept, reason empty), not "llm_invalid: $.reason: not a string" with fit unknown and a retry every run', 'AN2', async ok => {
    const q = 'Le prestataire accompagnera le département dans l\'élaboration de son schéma directeur numérique.';
    const a = await analyse(tender({ title: 'Formation au management', body_text: `# Formation au management\nAcheteur : EN3S\nDate limite : 20/11/2026\n${q}` }),
      analysisAnswer({ tender_type: 'training', fit: 'none', reason: [], services: [], quote: q, sector: 'education', requirements: [] }));
    ok(a.analysis.status === 'ok' && a.analysis.fit === 'none' && !a.analysis.checks.includes('llm_invalid') && !a.analysis.reason, 'answer kept');
    return `status ${a.analysis.status}, fit ${a.analysis.fit}, checks [${a.analysis.checks}]`;
  });

C(A2, 'Proof quote left out (real run 3)', 'third RAG v2 run: qwen3 leaves out "quote" for 3 notices (office furniture, a publication layout job): "$.quote: missing", fit unknown, retried every run; control: fit high with no quote',
  'answer kept: fit none stays none (flag quote_missing); a fit high without its proof quote goes one level down to medium, like a quote not in the text', 'AN2', async ok => {
    const body = '# Fourniture de mobilier de bureau\nAcheteur : Mairie de Testville\nDate limite : 20/11/2026\nLe présent marché a pour objet la fourniture et la livraison de bureaux et de chaises.';
    const none = await analyse(tender({ title: 'Fourniture de mobilier de bureau', body_text: body }), analysisAnswer({ tender_type: 'non_it', fit: 'none', quote: undefined, reason: 'Office furniture.' }));
    const high = await analyse(tender({ title: 'Fourniture de mobilier de bureau', body_text: body }), analysisAnswer({ fit: 'high', quote: undefined }));
    ok(none.analysis.status === 'ok' && none.analysis.fit === 'none' && none.analysis.checks.includes('quote_missing'), 'non-fit kept');
    ok(high.analysis.status === 'ok' && high.analysis.fit === 'medium' && !high.analysis.quote_verified && high.analysis.checks.includes('quote_missing'), 'unproven fit lowered');
    return `none: ${none.analysis.status}/${none.analysis.fit} [${none.analysis.checks}]; high: ${high.analysis.status}/${high.analysis.fit}`;
  });
C(A2, 'Service numbers written as the reason (real)', 'second RAG v2 run, City\'up LLM-agents tender: qwen3 answers "reason": "[1, 2]" and "services": []',
  'the numbers become the services when the text states them (service 2: LLM, RAG; not service 1: no web, mobile or digital), flagged services_from_reason and reason_was_service_list; the reason is empty (not "[1, 2]")', 'AN2', async ok => {
    const q = 'Le présent marché a pour objet des prestations de développement d\'agents LLM et de chaînes RAG pour la collectivité.';
    const a = await analyse(tender({ title: 'Prestations de développement d\'agents LLM', body_text: `# Prestations de développement d'agents LLM\nAcheteur : City'up\nDate limite : 26/10/2026\n${q}` }),
      analysisAnswer({ tender_type: 'ai_data', fit: 'high', reason: '[1, 2]', services: [], quote: q, sector: 'public sector', requirements: [] }));
    const svc = a.analysis.matched_services, c = a.analysis.checks;
    ok(JSON.stringify(svc) === JSON.stringify([CFG.company.services[1]]) && !a.analysis.reason, 'stated service recovered');
    ok(c.includes('services_from_reason') && c.includes('reason_was_service_list') && !c.includes('no_service_matched'), 'flags');
    return `services ${svc.length}, reason "${a.analysis.reason}", checks [${c}]`;
  });

// second RAG v2 run with every earlier fix (execution_ragv2_fixed): real texts and real qwen3 answers
const TOURISM_TITLE = "Développement d'une plateforme numérique de gestion des licences touristiques";
const TOURISM_PAGE = "L'Office du Tourisme de Sampleville lance un appel d'offres pour le développement d'une plateforme web de gestion des licences des établissements touristiques (demandes en ligne, suivi, renouvellement, tableau de bord). Exigences techniques : le frontend doit être développé en React ou Angular. Le backend doit être réalisé en Node.js ou Java/Spring. La base de données doit être PostgreSQL. La plateforme doit exposer une API REST. L'hébergement doit être assuré sur un cloud AWS ou Azure. Équipe : le soumissionnaire doit proposer au minimum 3 développeurs seniors, 1 chef de projet certifié PMP et 1 designer UX/UI. Expérience : le soumissionnaire doit justifier d'au moins 2 projets numériques similaires dans le secteur public. Une certification ISO 27001 est souhaitée. Durée d'exécution : 6 mois. Critères d'attribution : valeur technique (60), prix (40).\n\nAward criteria: Valeur technique (60); Prix (40)";
const DASHBOARD_TITLE = 'Tableau de bord décisionnel des indicateurs de santé publique';
const DASHBOARD_PAGE = "La Direction Régionale de la Santé souhaite disposer d'un tableau de bord décisionnel consolidant les indicateurs des établissements de santé. Exigences techniques : les tableaux de bord doivent être réalisés sous Power BI. Les flux de données doivent être automatisés avec des pipelines Python. La solution doit être hébergée sur Azure. L'accès doit être géré par rôles. Équipe : le titulaire doit proposer 1 chef de projet et 2 ingénieurs data. Expérience : le titulaire doit justifier d'au moins 1 projet de tableau de bord dans le secteur de la santé. Durée : 6 mois. Critères d'attribution : valeur technique (60), prix (40).\n\nAward criteria: Valeur technique (60); Prix (40)";
const CHATBOT_TITLE = "Mise en place d'un assistant conversationnel IA (chatbot RAG) pour le service aux usagers";
const CHATBOT_PAGE = "Objet : conception et déploiement d'un assistant conversationnel basé sur l'intelligence artificielle générative pour répondre aux questions des usagers à partir de la documentation interne de l'agence. Exigences techniques : la solution doit utiliser un grand modèle de langage (LLM) avec une architecture RAG (génération augmentée par la recherche). L'assistant doit répondre en français et en arabe. La solution doit s'appuyer sur une base de données vectorielle. Le développement doit être réalisé en Python. Équipe : le soumissionnaire doit mobiliser au moins 1 ingénieur IA et 1 chef de projet. Expérience : le soumissionnaire doit présenter au moins 1 référence de chatbot ou d'assistant IA déjà déployé. Durée : 5 mois. Critères d'attribution : valeur technique (70), prix (30).\n\nAward criteria: Valeur technique (70); Prix (30)";
const CHATBOT_LLM = 'la solution doit utiliser un grand modèle de langage (LLM) avec une architecture RAG (génération augmentée par la recherche)';
const OPPIC_TITLE = 'Prestations d’infogérance de l’ensemble des équipements informatiques de l’OPPIC';
const OPPIC_PAGE = 'Le présent marché est un marché d’infogérance informatique ayant pour objet la réalisation des prestations de maintenance préventive et corrective de l’ensemble des équipements informatiques de l’OPPIC et des prestations annexes d’assistance. Le marché comprend : - une partie traitée à prix forfaitaire ; - une partie traitée à prix unitaires sous la forme d’un accord-cadre à bons de commande et comprenant un montant maximum annuel de 10 000,00 euros HT.\n\nInformatique (maintenance serveurs et réseaux)';
const OPPIC_ANSWER = o => ({ text: JSON.stringify({ tender_type: 'maintenance_support', fit: 'high', reason: ['1', '2'], quote: 'Prestations de maintenance préventive et corrective de l’ensemble des équipements informatiques de l’OPPIC', sector: 'public sector',
  requirements: [{ category: 'technical', text: 'Maintenance préventive et corrective des équipements informatiques', skill: 'Maintenance of servers and networks', quote: 'maintenance préventive et corrective de l’ensemble des équipements informatiques' }], timeline: '12 mois', ...o }) });
const LYON_TITLE = "Evaluation de conformité de la protection des données personnelles (RGPD) et du règlement sur l'intelligenceartificielle (RIA) à la Ville de Lyon et au CCAS";
const LYON_DESC = "Il s'agit d'accords-cadres mixtes exécutés par l'émission de bons de commande et par la conclusion de marchés subséquents pour des prestations dont l'objectif est de garantir : - une conformité à tout moment des traitements de données à caractère personnel mis en oeuvre au sein des directions de la Ville de Lyon et du CCAS - que les solutions d'IA mises en oeuvre sont conformes aux exigences de sécurité, de traçabilité, de supervision humaine et de maîtrise des risques prévues par les textes en vigueur";
const LYON_LOT = n => `5.1.\n\nLot: LOT-000${n}\n\nTitre: ${n === 1 ? 'Audits de conformité' : 'Accompagnement juridique'}\n\n5.1.3.\n\nDurée estimée\n\nDate de début: 03/02/2027\n\nDate de fin de durée: 01/02/2031\n\n5.1.4.\n\nReconduction\n\nAutres informations sur le renouvellement: Période initiale allant de sa date de notification au 01/02/2029 puis reconductible 2 fois 1 an\n\nLes noms et les qualifications professionnelles du personnel chargé de l’exécution du marché doivent être mentionnés: Non requises\n\n5.1.12.\n\nSoumission par voie électronique: Requise\n\nDurée de validité des offres: 5Mois\n\nLe contrat doit être exécuté dans le cadre de programmes d’emplois protégés: Non\n\nFacturation électronique: Requise`;
const LYON_PAGE = `Date de clotûre :\n\n21/10/2026\n\nDate de parution :\n\n16/09/2026\n\n2.1.\n\nProcédure\n\nTitre: ${LYON_TITLE}\n\nDescription: ${LYON_DESC}\n\n${LYON_LOT(1)}\n\n${LYON_LOT(2)}`;
const LYON_QUOTE = "que les solutions d'IA mises en oeuvre sont conformes aux exigences de sécurité, de traçabilité, de supervision humaine et de maîtrise des risques prévues par les textes en vigueur";
const lyon = () => tender({ title: LYON_TITLE, body_text: LYON_PAGE, buyer: { name: 'Ville de Lyon', country: 'FR', contacts: {} }, cpv: ['71621000'] });
const oppic = () => tender({ title: OPPIC_TITLE, body_text: OPPIC_PAGE, buyer: { name: 'OPPIC', country: 'FR', contacts: {} } });
C(A2, 'Generic word after a technology in a skill line (real)', 'second RAG v2 run, tourism-licence demo (real text and answer): "React or Angular frontend", "Node.js or Java/Spring backend", "PostgreSQL database", "REST API exposure", "AWS or Azure cloud hosting"; Arabic e-services demo: "Angular interface", "Node.js server" (the RAG parsed "rest api" + leftover "exposure", "angular" + "interface", and its reranker turned the rule hits into missing)',
  'the generic word is dropped and the technologies the quote names are sent: "React or Angular", "Node.js or Java/Spring", "PostgreSQL", "REST API", "AWS or Azure", "Angular", "Node.js"; the English sentence stays the requirement text; the team line (no generic word next to a name) is unchanged', 'AN2', async ok => {
    const q = ['le frontend doit être développé en React ou Angular', 'le backend doit être réalisé en Node.js ou Java/Spring', 'la base de données doit être PostgreSQL', 'la plateforme doit exposer une API REST', "l'hébergement doit être assuré sur un cloud AWS ou Azure"];
    const tx = ['The frontend must be developed in React or Angular.', 'The backend must be implemented in Node.js or Java/Spring.', 'The database must be PostgreSQL.', 'The platform must expose a REST API.', 'Hosting must be provided on AWS or Azure cloud.'];
    const sk = ['React or Angular frontend', 'Node.js or Java/Spring backend', 'PostgreSQL database', 'REST API exposure', 'AWS or Azure cloud hosting'];
    const qTeam = 'le soumissionnaire doit proposer au minimum 3 développeurs seniors, 1 chef de projet certifié PMP et 1 designer UX/UI';
    const a = await analyse(tender({ title: TOURISM_TITLE, body_text: TOURISM_PAGE }), reqAnswer(q[0], [...q.map((x, k) => ({ category: 'technical', text: tx[k], skill: sk[k], quote: x })),
      { category: 'team', text: 'The bidder must propose at least 3 senior developers, 1 PMP-certified project manager, and 1 UX/UI designer.', skill: 'Minimum 3 senior developers, 1 PMP certified, 1 UX/UI designer', quote: qTeam }]));
    const r = a.requirements.items;
    ok(JSON.stringify(r.map(x => x.rag_text)) === JSON.stringify(['React or Angular', 'Node.js or Java/Spring', 'PostgreSQL', 'REST API', 'AWS or Azure', 'Minimum 3 senior developers', '1 PMP certified', '1 UX/UI designer']), 'generic words dropped');
    ok(r.slice(0, 5).every((x, k) => x.text === tx[k]), 'English sentence kept as the text');
    const ar = 'بوابة الخدمات الإلكترونية للمواطنين', qa = 'يجب تطوير الواجهة باستعمال Angular', qn = 'يجب تطوير الخادم باستعمال Node.js';
    const b = await analyse(tender({ title: ar, language: 'ar', buyer: { name: 'بلدية سامبلفيل', country: 'TN', contacts: {} },
      body_text: `موضوع طلب العروض: تطوير بوابة إلكترونية تمكن المواطنين من تقديم مطالبهم الإدارية عبر الإنترنت ومتابعتها والدفع الإلكتروني. المتطلبات التقنية: ${qa}. ${qn}. يجب استعمال قاعدة بيانات PostgreSQL. يجب استضافة البوابة على AWS. مدة الإنجاز: 7 أشهر.` }),
      reqAnswer(qa, [{ category: 'technical', text: 'The interface must be developed using Angular', skill: 'Angular interface', quote: qa }, { category: 'technical', text: 'The server must be developed using Node.js', skill: 'Node.js server', quote: qn }]));
    ok(JSON.stringify(b.requirements.items.map(x => x.rag_text)) === '["Angular","Node.js"]', 'Arabic quote: names kept, generic words dropped');
    return `${r.map(x => x.rag_text).join(' | ')} / ${b.requirements.items.map(x => x.rag_text).join(' | ')}`;
  });
C(A2, 'Skill line with one clause too many: cut, not replaced by the long sentence (real)', 'second RAG v2 run: chatbot demo "LLM with RAG architecture in Python" (Python is asked in another sentence); dataMEL "experience in open source data management with public or private actors" for "... auprès d’acteurs publics ou privés" (11 words: over the limit, the 12-word sentence was sent and came back partial); Lyon GDPR / AI-act notice "AI solutions with security, traceability, human supervision" for "... de sécurité, de traçabilité, de supervision humaine ..."',
  '"LLM with RAG architecture" sent (skill_cut Python); "experience in open source data management" sent (the pair of both sectors is no constraint); the 3 Lyon parts sent ("traceability" = traçabilité; "human supervision" kept although "human" is no cognate of "humaine": the model\'s own text uses it)', 'AN2', async ok => {
    const a = await analyse(tender({ title: CHATBOT_TITLE, body_text: CHATBOT_PAGE }), reqAnswer(CHATBOT_LLM, [{ category: 'technical', text: 'The solution must use a large language model (LLM) with a RAG architecture', skill: 'LLM with RAG architecture in Python', quote: CHATBOT_LLM }]));
    ok(a.requirements.items.length === 1 && a.requirements.items[0].rag_text === 'LLM with RAG architecture' && a.requirements.items[0].skill_cut === 'Python', 'trailing name cut');
    const title = "Prestations de développement numérique, d'information et d'accompagnement aux usages sur dataMEL - plateforme métropolitaine de données open source de la Métropole Européenne de Lille";
    const q2 = 'Pertinence de l’expérience des équipes affectées au marché dans l’environnement open source, dans le cadre de la gestion et l’exploitation données, auprès d’acteurs publics ou privés';
    const b = await analyse(tender({ title, body_text: `Award criteria: Valeur technique - Sous-critères: "${q2} analysé au regard du cadre de mémoire technique " valant pour 30% de la note finale (50); Prix des prestations (40)\n\nLogiciel`, buyer: { name: 'Métropole européenne de Lille', country: 'FR', contacts: {} } }),
      reqAnswer(q2, [{ category: 'experience', text: 'Experience in open source data management with public or private actors required', skill: 'experience in open source data management with public or private actors', quote: q2 }]));
    ok(b.requirements.items.length === 1 && b.requirements.items[0].rag_text === 'experience in open source data management', 'pair of sectors dropped');
    const c = await analyse(lyon(), reqAnswer(LYON_QUOTE, [{ category: 'technical', text: 'The AI solutions must meet security, traceability, human supervision and risk management requirements', skill: 'AI solutions with security, traceability, human supervision', quote: LYON_QUOTE }]));
    ok(JSON.stringify(c.requirements.items.map(x => x.rag_text)) === '["AI solutions with security","traceability","human supervision"]', 'traçabilité stated, human kept');
    return `${a.requirements.items.map(x => x.rag_text)} / ${b.requirements.items.map(x => x.rag_text)} / ${c.requirements.items.map(x => x.rag_text).join(' | ')}`;
  });
C(A2, 'Company SERVICES wording as a skill part (real)', 'second RAG v2 run, City\'up LLM-agents notice (real page and answer): skill "LLM agents, RAG chains, document intelligence"; "document intelligence" is the wording of Config company.services[1], the quote only has "recherche documentaire" and "intelligence artificielle" far apart; a dataMEL control: "data platforms" for "plateforme métropolitaine de données open source"',
  '"document intelligence" refused (services phrase not in quote: the RAG made it the rank-1 tender\'s only gap), "LLM agents" and "RAG chains" sent; "data platforms" kept (its words stand together in the quote)', 'AN2', async ok => {
    const quote = 'prestations de conseil, conception, développement, intégration, évolution, optimisation, sécurisation et industrialisation de solutions reposant sur l’intelligence artificielle générative, notamment des agents LLM et des chaînes de génération augmentée par recherche documentaire (RAG)';
    const { a } = await analyseFull(tender({ id: 'llmagents2', title: "Prestations de développement d'agents LLM et services associés", body_text: LLM_AGENTS_PAGE, buyer: { name: "City'up (972)", country: 'FR', contacts: {} }, cpv: ['72000000'], deadline: '2026-10-26' }),
      { text: JSON.stringify({ tender_type: 'ai_data', fit: 'high', reason: '[1, 2]', quote: `Le présent marché a pour objet ${quote}.`, sector: 'tourism', requirements: [{ category: 'technical', text: 'Development of AI solutions based on LLM and RAG chains', skill: 'LLM agents, RAG chains, document intelligence', quote }], timeline: '12 mois' }) });
    ok(JSON.stringify(a.requirements.items.map(x => x.rag_text)) === '["LLM agents","RAG chains"]', 'service wording not sent');
    ok(a.requirements.dropped.some(d => d.text === 'document intelligence' && /services phrase not in quote/.test(d.why)), 'reason given');
    const qd = 'Plateforme métropolitaine de données open source de la Métropole Européenne de Lille';
    const b = await analyse(tender({ title: 'Prestations sur dataMEL', body_text: `Prestations de développement informatique et numérique sur les briques fonctionnelles « socle /cœur » de dataMEL - ${qd}: Le marché est un accord-cadre à bons de commande et à marchés subséquents multi-attributaire sans montant minimum et d'un montant maximum de 600 000 € HT sur la durée totale du marché (4 ans)\n\nAward criteria: Valeur technique (50); Prix des prestations (40)\n\nLogiciel` }),
      reqAnswer(qd, [{ category: 'technical', text: 'Open source data platform of the metropolis', skill: 'data platforms', quote: qd }]));
    ok(JSON.stringify(b.requirements.items.map(x => x.rag_text)) === '["data platforms"]', 'phrase written in the quote kept');
    return `${a.requirements.items.map(x => x.rag_text).join(' | ')}; dropped ${a.requirements.dropped.map(d => d.why).join(' | ')} / ${b.requirements.items.map(x => x.rag_text)}`;
  });
C(A2, 'Mistranslated role in a team skill line (real)', 'second RAG v2 run, Power BI demo: text "The bidder must propose 1 project manager and 2 data engineers", skill "1 chief project, 2 data engineers" for "le titulaire doit proposer 1 chef de projet et 2 ingénieurs data" ("project" stated, "chief" not: half was enough, the RAG found no "chief project" and the rank-2 tender got a blocking team gap); the same skill alone',
  'the part "1 chief project" is refused (neither the quote nor the model\'s own text says "chief") and replaced by the text\'s words for that count: "1 project manager" (skill_dropped) and "2 data engineers"; alone, the sentence is sent', 'AN2', async ok => {
    const q = 'le titulaire doit proposer 1 chef de projet et 2 ingénieurs data';
    const a = await analyse(tender({ title: DASHBOARD_TITLE, body_text: DASHBOARD_PAGE }), reqAnswer(q, [{ category: 'team', text: 'The bidder must propose 1 project manager and 2 data engineers', skill: '1 chief project, 2 data engineers', quote: q }]));
    const r = a.requirements.items;
    ok(JSON.stringify(r.map(x => x.rag_text)) === '["1 project manager","2 data engineers"]' && r[0].skill_dropped === '1 chief project' && !a.requirements.dropped.length, 'role from the text');
    const b = await analyse(tender({ title: DASHBOARD_TITLE, body_text: DASHBOARD_PAGE }), reqAnswer(q, [{ category: 'team', text: 'The bidder must propose 1 project manager', skill: '1 chief project', quote: q }]));
    ok(b.requirements.items.length === 1 && b.requirements.items[0].rag_text === 'The bidder must propose 1 project manager' && b.requirements.items[0].skill_dropped === '1 chief project', 'sentence sent');
    return `${r.map(x => x.rag_text + (x.skill_dropped ? ` (for "${x.skill_dropped}")` : '')).join(' | ')} / ${b.requirements.items.map(x => x.rag_text)}`;
  });
C(A2, 'Shortened French copy as the requirement text (real)', 'second RAG v2 run, OPPIC IT outsourcing notice (real text and answer): text "Maintenance préventive et corrective des équipements informatiques" for the quote "maintenance préventive et corrective de l’ensemble des équipements informatiques" (7 of its 9 words, "de l\'ensemble" left out), skill "Maintenance of servers and networks" (not in the quote)',
  'the text is the untranslated quote: dropped, never sent in French (it came back missing)', 'AN2', async ok => {
    const a = await analyse(oppic(), OPPIC_ANSWER());
    ok(!a.requirements.items.length && a.requirements.dropped.length === 1 && /untranslated quote/.test(a.requirements.dropped[0].why), 'French copy dropped');
    return `kept ${a.requirements.items.length}; dropped ${a.requirements.dropped.map(d => d.why).join(' | ')}`;
  });
C(A2, 'Timeline the text does not state (real)', 'second RAG v2 run: OPPIC notice (no duration) answered "12 mois" (the prompt\'s own example); LLM-agents page "12 mois" ("Durée du marché (en mois) : 12"); Lyon notice "4 years" (only "Date de début: 03/02/2027 ... Date de fin de durée: 01/02/2031"); a start date "janvier 2027"; the string "null"; "12 months" for "une durée de douze mois"',
  'OPPIC: null + timeline_not_in_text; "12 mois" and "4 years" kept (label, date span); "janvier 2027": null + flag; "null": null, no flag; "12 months" kept (number in words)', 'AN1, AN2', async ok => {
    const o = await analyseFull(oppic(), OPPIC_ANSWER());
    ok(o.a.analysis.timeline === null && o.a.analysis.checks.includes('timeline_not_in_text'), 'invented duration dropped');
    ok(!/"12 mois"/.test(o.an1._usr) && /<n> mois/.test(o.an1._usr), 'no example value in the prompt');
    const m = await analyse(tender({ id: 'llmagents3', title: "Prestations de développement d'agents LLM et services associés", body_text: LLM_AGENTS_PAGE, cpv: ['72000000'], deadline: '2026-10-26' }),
      reqAnswer('Le présent marché a pour objet prestations de conseil, conception, développement, intégration', [], { timeline: '12 mois' }));
    const got = [];
    for (const timeline of ['4 years', 'janvier 2027', 'null']) { const x = (await analyse(lyon(), reqAnswer(LYON_QUOTE, [], { timeline }))).analysis; got.push(`${x.timeline}${x.checks.includes('timeline_not_in_text') ? ' (flag)' : ''}`); }
    const d = await analyse(tender({ title: 'Maintenance applicative du portail citoyen', body_text: 'Le marché porte sur la maintenance corrective et évolutive du portail citoyen de la commune et de ses téléservices. Le marché est conclu pour une durée de douze mois à compter de sa notification, reconductible une fois.' }),
      reqAnswer('Le marché porte sur la maintenance corrective et évolutive du portail citoyen de la commune et de ses téléservices.', [], { timeline: '12 months' }));
    ok(m.analysis.timeline === '12 mois' && JSON.stringify(got) === '["4 years","null (flag)","null"]' && d.analysis.timeline === '12 months', 'stated durations kept');
    return `OPPIC ${o.a.analysis.timeline} [${o.a.analysis.checks}] / LLM agents ${m.analysis.timeline} / Lyon ${got.join(', ')} / ${d.analysis.timeline}`;
  });
C(A2, 'Form fields and repeated sections as obligations (real)', 'second RAG v2 run, Lyon GDPR / AI-act notice (eForms, two lots with the same fields): "... doivent être mentionnés: Non requises", "Soumission par voie électronique: Requise", "... programmes d’emplois protégés: Non", each twice; the chatbot demo page given twice',
  'form fields are no obligation: requirements.uncovered empty; a repeated sentence is listed once (the 3 real chatbot obligations no row quotes)', 'AN2', async ok => {
    const a = await analyse(lyon(), reqAnswer(LYON_QUOTE, [], { fit: 'medium', tender_type: 'consulting' }));
    ok(Array.isArray(a.requirements.uncovered) && !a.requirements.uncovered.length, 'form fields not listed');
    const b = await analyse(tender({ title: CHATBOT_TITLE, body_text: `${CHATBOT_PAGE}\n\n${CHATBOT_PAGE}` }), reqAnswer(CHATBOT_LLM, [
      { category: 'technical', text: 'The solution must use a large language model (LLM) with a RAG architecture', skill: 'LLM with RAG architecture in Python', quote: CHATBOT_LLM },
      { category: 'team', text: 'The bidder must mobilize at least 1 AI engineer and 1 project manager', skill: 'Minimum 1 AI engineer and 1 project manager', quote: 'le soumissionnaire doit mobiliser au moins 1 ingénieur IA et 1 chef de projet' },
      { category: 'experience', text: 'The bidder must present at least 1 reference of a chatbot or AI assistant already deployed', skill: '1+ chatbot or AI assistant deployment project', quote: "le soumissionnaire doit présenter au moins 1 référence de chatbot ou d'assistant IA déjà déployé" }]));
    ok(JSON.stringify(b.requirements.uncovered) === JSON.stringify(["L'assistant doit répondre en français et en arabe.", "La solution doit s'appuyer sur une base de données vectorielle.", 'Le développement doit être réalisé en Python.']), 'once each');
    return `${a.requirements.uncovered.length} / ${b.requirements.uncovered.join(' | ')}`;
  });
C(A2, 'Service numbers of the reason checked against the text (real)', 'second RAG v2 run, all 17 valid answers put the services list in "reason": OPPIC IT equipment maintenance ["1", "2"]; tourism-licence demo all 5 (in the reason, then in "services"); Power BI demo ["1", "4", "5"]',
  'OPPIC: no service stated (no web / mobile / digital, no AI): [] + services_from_reason, reason_was_service_list, no_service_matched (the fit doubt is seen); every service at once is checked the same way: the tourism page keeps 1 (plateforme web) and 4 (données) + services_all_listed; Power BI: only service 4 (data); the prompt rates IT operations / equipment maintenance low and asks for the services the text asks for, not the whole list', 'AN1, AN2', async ok => {
    const o = await analyseFull(oppic(), OPPIC_ANSWER());
    const oc = o.a.analysis.checks;
    ok(!o.a.analysis.matched_services.length && ['services_from_reason', 'reason_was_service_list', 'no_service_matched'].every(c => oc.includes(c)) && o.a.analysis.reason === '', 'OPPIC flagged');
    ok(/Being about IT is not enough/.test(o.an1._usr) && /maintenance of IT equipment/.test(o.an1._usr) && /not the whole list/.test(o.an1._usr), 'prompt rules');
    const all = ['1', '2', '3', '4', '5'], qT = "L'Office du Tourisme de Sampleville lance un appel d'offres pour le développement d'une plateforme web de gestion des licences des établissements touristiques (demandes en ligne, suivi, renouvellement, tableau de bord).";
    const t1 = await analyse(tender({ title: TOURISM_TITLE, body_text: TOURISM_PAGE }), reqAnswer(qT, [], { reason: all, services: undefined }));
    const t2 = await analyse(tender({ title: TOURISM_TITLE, body_text: TOURISM_PAGE }), reqAnswer(qT, [], { services: all }));
    ok([t1, t2].every(x => JSON.stringify(x.analysis.matched_services) === JSON.stringify([CFG.company.services[0], CFG.company.services[3]]) && x.analysis.checks.includes('services_all_listed') && !x.analysis.checks.includes('no_service_matched')), 'every service = the stated ones');
    const qD = 'Les tableaux de bord doivent être réalisés sous Power BI. Les flux de données doivent être automatisés avec des pipelines Python.';
    const d = await analyse(tender({ title: DASHBOARD_TITLE, body_text: DASHBOARD_PAGE }), reqAnswer(qD, [], { reason: ['1', '4', '5'], services: undefined, tender_type: 'ai_data' }));
    ok(JSON.stringify(d.analysis.matched_services) === JSON.stringify([CFG.company.services[3]]), 'stated service only');
    return `OPPIC [${oc}] / tourism ${t1.analysis.matched_services.length}, ${t2.analysis.matched_services.length} / Power BI ${d.analysis.matched_services.length} (${d.analysis.checks})`;
  });
C(A2, 'Timeline written in other words than a duration label (review)', 'review of the second RAG v2 run fixes: the tourism-licence demo page (real) with its "Durée d\'exécution : 6 mois." written "La phase de développement durera 6 mois." (answers "6 mois" and "6"), "Le marché est passé pour 48 mois.", "Les prestations sont exécutées du 1er janvier 2027 au 31 décembre 2027." (answered word for word), "The contract will run for three years from signature." ("3 years"); controls "3 ans" for "Le chef de projet doit justifier de 3 ans d\'expérience." and "1er janvier 2027" for "Les prestations débutent le 1er janvier 2027."',
  'every duration the text writes is kept, in any wording and in words, and a period copied word for word; an experience count and a single start date are no duration: null + timeline_not_in_text', 'AN2', async ok => {
    const qT = "L'Office du Tourisme de Sampleville lance un appel d'offres pour le développement d'une plateforme web de gestion des licences des établissements touristiques (demandes en ligne, suivi, renouvellement, tableau de bord).";
    const got = [];
    for (const [s, timeline] of [['La phase de développement durera 6 mois.', '6 mois'], ['La phase de développement durera 6 mois.', '6'], ['Le marché est passé pour 48 mois.', '48 mois'],
      ['Les prestations sont exécutées du 1er janvier 2027 au 31 décembre 2027.', 'du 1er janvier 2027 au 31 décembre 2027'], ['The contract will run for three years from signature.', '3 years'],
      ["Le chef de projet doit justifier de 3 ans d'expérience.", '3 ans'], ['Les prestations débutent le 1er janvier 2027.', '1er janvier 2027']]) {
      const x = (await analyse(tender({ title: TOURISM_TITLE, body_text: TOURISM_PAGE.replace("Durée d'exécution : 6 mois.", s) }), reqAnswer(qT, [], { timeline }))).analysis;
      got.push(`${x.timeline}${x.checks.includes('timeline_not_in_text') ? ' (flag)' : ''}`);
    }
    ok(JSON.stringify(got) === JSON.stringify(['6 mois', '6 mois', '48 mois', 'du 1er janvier 2027 au 31 décembre 2027', '3 years', 'null (flag)', 'null (flag)']), 'stated durations kept, the others null');
    return got.join(' | ');
  });
C(A2, 'Product name that contains a generic word (review)', 'review of the second RAG v2 run fixes: the tourism-licence demo page (real) with "La base de données doit être hébergée sous SQL Server.", "L\'hébergement doit être assuré sur Google Cloud." and "La solution ne doit pas être soumise au Cloud Act."; skills "SQL Server database", "Google Cloud", "Cloud Act" and the real "Angular interface"',
  '"SQL Server" (only "database" cut), "Google Cloud" and "Cloud Act" sent whole (a generic word written with a capital, or next to the name in the quote, is part of the name); "Angular interface" still becomes "Angular"', 'AN2', async ok => {
    const q = ['la base de données doit être hébergée sous SQL Server', "l'hébergement doit être assuré sur Google Cloud", 'la solution ne doit pas être soumise au Cloud Act', 'le frontend doit être développé en React ou Angular'];
    const page = TOURISM_PAGE.replace('La base de données doit être PostgreSQL.', 'La base de données doit être hébergée sous SQL Server.').replace("L'hébergement doit être assuré sur un cloud AWS ou Azure.", "L'hébergement doit être assuré sur Google Cloud. La solution ne doit pas être soumise au Cloud Act.");
    const a = await analyse(tender({ title: TOURISM_TITLE, body_text: page }), reqAnswer(q[0], [['The database must be hosted on SQL Server.', 'SQL Server database'], ['Hosting must be provided on Google Cloud.', 'Google Cloud'],
      ['The solution must not be subject to the Cloud Act.', 'Cloud Act'], ['The interface must be developed in Angular.', 'Angular interface']].map(([text, skill], k) => ({ category: 'technical', text, skill, quote: q[k] }))));
    const r = a.requirements.items.map(x => x.rag_text);
    ok(JSON.stringify(r) === JSON.stringify(['SQL Server', 'Google Cloud', 'Cloud Act', 'Angular']), 'names kept whole');
    return r.join(' | ');
  });
C(A2, 'Every service listed for a notice that states some (real)', 'second RAG v2 run, dataMEL notice (real text and answer): reason ["1", "2", "3", "4", "5"] for "Prestations de développement numérique ... dataMEL - plateforme métropolitaine de données open source"; the same list given as "services"',
  'the listed services the text states are kept: 1 (numérique) and 4 (données) + services_all_listed, no no_service_matched (the proposal gets its service lines; before, the whole list was thrown away)', 'AN2', async ok => {
    const title = "Prestations de développement numérique, d'information et d'accompagnement aux usages sur dataMEL - plateforme métropolitaine de données open source de la Métropole Européenne de Lille";
    const body = `${title}\n\nLa marché porte sur des prestations de développement numérique, d'information et d'accompagnement aux usages sur dataMEL - plateforme métropolitaine de données open source de la Métropole Européenne de Lille\n\nLe marché est un accord-cadre à bons de commande et à marchés subséquents multi-attributaire sans montant minimum et d'un montant maximum de 600 000 € HT sur la durée totale du marché (4 ans)\n\nAward criteria: Valeur technique (50); Prix des prestations (40); Pertinence des propositions sur la prise en compte de la démarche environnementale (10)\n\nLogiciel`;
    const quote = "La marché porte sur des prestations de développement numérique, d'information et d'accompagnement aux usages sur dataMEL";
    const all = ['1', '2', '3', '4', '5'], got = [];
    for (const o of [{ reason: all, services: undefined }, { services: all }]) got.push((await analyse(tender({ title, body_text: body, buyer: { name: 'Métropole européenne de Lille', country: 'FR', contacts: {} } }), reqAnswer(quote, [], o))).analysis);
    ok(got.every(x => JSON.stringify(x.matched_services) === JSON.stringify([CFG.company.services[0], CFG.company.services[3]]) && x.checks.includes('services_all_listed') && !x.checks.includes('no_service_matched')), 'stated services kept');
    return got.map(x => `${x.matched_services.length} [${x.checks}]`).join(' / ');
  });
C(A2, 'Service of the reason stated only by a look-alike word (real)', 'second RAG v2 run, chatbot demo (real text and answer): reason ["1"] (web and mobile applications) for the AI assistant; the page only has "mobiliser au moins 1 ingénieur IA" (5 letters in common with "mobile"); control: the same page with "L\'assistant doit aussi être disponible dans les applications mobiles de l\'agence."',
  'chatbot: no service stated: [] + services_from_reason, no_service_matched (service 1 was kept on "mobiliser"); control: service 1 kept ("mobiles")', 'AN2', async ok => {
    const q = 'la solution doit utiliser un grand modèle de langage (LLM) avec une architecture RAG (génération augmentée par la recherche)';
    const a = (await analyse(tender({ title: CHATBOT_TITLE, body_text: CHATBOT_PAGE }), reqAnswer(q, [], { reason: ['1'], services: undefined, tender_type: 'ai_data' }))).analysis;
    const b = (await analyse(tender({ title: CHATBOT_TITLE, body_text: CHATBOT_PAGE.replace('Durée : 5 mois.', "L'assistant doit aussi être disponible dans les applications mobiles de l'agence. Durée : 5 mois.") }), reqAnswer(q, [], { reason: ['1'], services: undefined, tender_type: 'ai_data' }))).analysis;
    ok(!a.matched_services.length && a.checks.includes('services_from_reason') && a.checks.includes('no_service_matched'), 'look-alike word is no statement');
    ok(JSON.stringify(b.matched_services) === JSON.stringify([CFG.company.services[0]]), 'plural form stated');
    return `${a.matched_services.length} [${a.checks}] / ${b.matched_services.length}`;
  });
C(A2, 'Company SERVICES wording spread over a French noun phrase (review)', 'review of the second RAG v2 run fixes: the Power BI demo page (real) with "Mise en place d\'une plateforme de gestion et de partage des données." and "Les workflows de validation devront être automatisés."; skills "data platforms" and "workflow automation" (Config company.services wording)',
  'both sent (their words stand in one phrase, 7 and 5 words apart); "document intelligence" 15 words apart in the City\'up quote stays refused (case "Company SERVICES wording as a skill part")', 'AN2', async ok => {
    const q1 = "Mise en place d'une plateforme de gestion et de partage des données", q2 = 'Les workflows de validation devront être automatisés';
    const a = await analyse(tender({ title: DASHBOARD_TITLE, body_text: DASHBOARD_PAGE.replace('Durée : 6 mois.', `${q1}. ${q2}. Durée : 6 mois.`) }), reqAnswer(q1, [
      { category: 'technical', text: 'A platform to manage and share data must be set up', skill: 'data platforms', quote: q1 }, { category: 'technical', text: 'The validation workflows must be automated', skill: 'workflow automation', quote: q2 }], { tender_type: 'ai_data' }));
    ok(JSON.stringify(a.requirements.items.map(x => x.rag_text)) === '["data platforms","workflow automation"]', 'phrases kept');
    return `${a.requirements.items.map(x => x.rag_text).join(' | ')}; dropped ${a.requirements.dropped.length}`;
  });

// ======================= 3. noisy web research (URL3 scout ids, Select Buyers, Parse Research) =======================
C(A3, 'Scout: unknown ids, navigation pages, invented URL (real run)', 'real scout run (home → menu → list) + answer ids: the 3 real ones, "zz9999x" (unknown), the menu and list pages, a URL it never saw',
  'only the 3 tender URLs the tool returned; unknown id and invented URL dropped; the pages it navigated from are never tenders', 'URL3 (scoutRun)', async ok => {
    const agent = clone(REAL.scout_fr.agent);
    agent.output = JSON.stringify({ tender_links: ['16zzmh1', '1660te4', '16g0f33', 'zz9999x', '5zeexs', '11a4708', 'https://fixture.test/fr/avis/4242'], list_url: 'https://fixture.test/fr/appels-offres' });
    const out = await run('URL3 - Links to URLs', [agent], { 'URL1 - Scout Tasks': [REAL.scout_fr.task] });
    const urls = out.map(x => x.url).sort();
    ok(JSON.stringify(urls) === JSON.stringify(['https://fixture.test/fr/avis/1001', 'https://fixture.test/fr/avis/1002', 'https://fixture.test/fr/avis/1003']), 'exactly the 3 tenders');
    return urls.map(u => u.replace('https://fixture.test', '')).join(' ');
  });
C(A3, 'Scout: agent error or prose answer', 'agent error item; then a final answer in prose ("I found three tenders.")', 'no tender URL (nothing invented), no crash', 'URL3', async ok => {
  const e = await run('URL3 - Links to URLs', [{ error: { message: 'Agent stopped due to max iterations.' } }], { 'URL1 - Scout Tasks': [REAL.scout_fr.task] });
  const agent = clone(REAL.scout_fr.agent); agent.output = 'I found three tenders on this site.';
  const p = await run('URL3 - Links to URLs', [agent], { 'URL1 - Scout Tasks': [REAL.scout_fr.task] });
  ok(e.length === 0 && p.length === 0, 'none'); return `error -> ${e.length} URL, prose -> ${p.length} URL`;
});
C(A3, 'Wrong registry homonym + invented place (real)', 'real research of "EPA-SHOM": registry returns "PAYE SANS ORDONNANCEMENT ESI RENNES"; agent summary says "in Rennes", website www.epa-shom.fr',
  'registry rejected (no legal name, siren); unverified website ignored; the sentence naming Rennes removed', 'BU2', async ok => {
    const x = REAL.research.find(r => r.buyer.name === 'EPA-SHOM');
    const b = await research(x.buyer, x.agent);
    ok(!b.profile.registry.match_ok && b.profile.legal_name === '' && b.profile.siren === '', 'registry rejected');
    ok(b.profile.checks.some(c => /agent website ignored/.test(c)) && b.profile.official_website === '', 'website ignored');
    ok(!/Rennes/.test(b.profile.summary), 'Rennes removed');
    return `registry ${b.profile.registry.reason}; website "${b.profile.official_website}"; summary "${b.profile.summary.slice(0, 90)}"`;
  });
C(A3, 'Acronym buyer via Wikidata alias (real, control)', 'real research of "RESAH": Wikidata gives the alias "Réseau des Acheteurs Hospitaliers", registry searched under it',
  'accepted: registry matched under the Wikidata name, enrichment "enriched" (the gates do not reject real matches)', 'BU2', async ok => {
    const x = REAL.research.find(r => r.buyer.name === 'RESAH');
    const b = await research(x.buyer, x.agent);
    ok(b.profile.registry.match_ok && /Wikidata name/.test(b.profile.registry.reason) && b.enrichment_status === 'enriched', 'matched');
    return `${b.profile.legal_name} (${b.profile.registry.reason}), ${b.enrichment_status}`;
  });
C(A3, 'Wikidata entity that is not an organisation', 'buyer "RESAH"; Wikidata rows "Resah - genre de plantes" and (2nd run) also "Réseau des Acheteurs Hospitaliers" (alias RESAH)',
  'the plant genus is never taken (no wikidata_id, no website); the real organisation is', 'BU2', async ok => {
    const plant = 'WD | Resah | genre de plantes de la famille des Fabaceae | id=Q111 | match=label:Resah';
    const org = 'WD | Réseau des Acheteurs Hospitaliers | groupement d\'intérêt public français | id=Q222 | match=alias:RESAH | website=https://www.resah.fr';
    const bb = buyer({ name: 'RESAH', search_name: 'RESAH', buyer_key: 'resah' });
    const a = await research(bb, researchAgent({}, [step('wikidata_lookup', { q: 'RESAH' }, plant)]));
    const c = await research(bb, researchAgent({}, [step('wikidata_lookup', { q: 'RESAH' }, `${plant}\n${org}`)]));
    ok(a.profile.wikidata_id === null && !a.facts.wikidata, 'plant rejected'); ok(c.profile.wikidata_id === 'Q222' && c.profile.official_website === 'https://resah.fr', 'organisation kept');
    return `plant only -> wikidata ${a.profile.wikidata_id}; with the organisation -> ${c.profile.wikidata_id}, ${c.profile.official_website}`;
  });
C(A3, 'Registry: side body and another town', 'buyer "Ville de Testville"; registry rows "COMITE DES OEUVRES SOCIALES DE LA VILLE DE TESTVILLE", "COMMUNE DE TESTVILLE-SUR-MER"; 2nd run adds "COMMUNE DE TESTVILLE"',
  'no match from the side body nor the other town; the real commune is matched when present', 'BU2', async ok => {
    const noise = 'REG | COMITE DES OEUVRES SOCIALES DE LA VILLE DE TESTVILLE | siren=411111111 | siret=41111111100011 | addr=2 RUE HAUTE 12345 TESTVILLE | city=TESTVILLE | nature=9220 | public=no | staff=NN | staff_year=\n'
      + 'REG | COMMUNE DE TESTVILLE-SUR-MER | siren=219999999 | siret=21999999900010 | addr=PLACE DU PORT 98765 TESTVILLE-SUR-MER | city=TESTVILLE-SUR-MER | nature=7210 | public=yes | staff=12 | staff_year=2024';
    const a = await research(buyer(), researchAgent({}, [step('registry_search', { q: 'Ville de Testville' }, noise)]));
    const c = await research(buyer(), researchAgent({}, [step('registry_search', { q: 'Ville de Testville' }, `${noise}\n${REG_TESTVILLE}`)]));
    ok(!a.profile.registry.match_ok, 'noise rejected'); ok(c.profile.legal_name === 'COMMUNE DE TESTVILLE' && c.profile.siren === '211234567', 'real one matched');
    return `noise only -> ${a.profile.registry.reason}; with the commune -> ${c.profile.legal_name}`;
  });
C(A3, 'Invented numbers and place in the agent summary', 'evidence: registry (100-199 employees, 2024) + 1 BOAMP notice; summary adds "employs 450 agents" and "located in Lyon"',
  'those two sentences removed (checks "number not in evidence", "name not in evidence"); supported sentences kept', 'BU2', async ok => {
    const s = ['Ville de Testville is a commune with 100-199 employees.', 'The commune employs 450 agents.', 'It is located in Lyon.', 'It recently published a tender for IT maintenance.'];
    const b = await research(buyer(), researchAgent({ summary: s.join(' ') }, [step('registry_search', { q: 'Ville de Testville' }, REG_TESTVILLE), step('boamp_history', { buyer_name: 'Ville de Testville' }, BOAMP_TESTVILLE)]));
    ok(b.profile.summary === `${s[0]} ${s[3]}`, 'summary'); ok(b.profile.checks.some(c => /number not in evidence/.test(c)) && b.profile.checks.some(c => /name not in evidence/.test(c)), 'checks');
    return `"${b.profile.summary}"`;
  });
C(A3, 'Invented organisation as the subject of a summary sentence', 'no evidence names Capgemini, Lyon nor Atos; summary "Capgemini runs the city IT systems.", "Lyon hosts its data centre.", "Atos is the incumbent."; controls: sentences starting with the buyer\'s own name, "The", "Its", "Recently", "Located in TESTVILLE" (the registry\'s town), "Several", and first words that are no names (review of 2026-10-20): "Medium-sized local authority ...", "Municipal body that ...", "Responsible for ...", "Située à TESTVILLE ...", "L\'acheteur ..."',
  'the three sentences removed (name not in evidence: a first word is checked when it reads as a name, here the subject of a supplier\'s claim: runs, hosts, is the incumbent); the controls stay (the buyer\'s name is in the evidence, the others are usual openers or no names)', 'BU2', async ok => {
  const keep = ['Ville de Testville is a commune with 100-199 employees.', 'The commune publishes its tenders on BOAMP.', 'Its registry staff band is 100-199.',
    'Recently it published a tender for IT maintenance.', 'Located in TESTVILLE, it is a local authority.', 'Several notices concern IT maintenance.',
    'Medium-sized local authority in TESTVILLE.', 'Municipal body that publishes its tenders on BOAMP.', 'Responsible for local public services.',
    'Située à TESTVILLE, la commune publie ses marchés.', 'L\'acheteur publie ses marchés.'];
  const b = await research(buyer(), researchAgent({ summary: [keep[0], 'Capgemini runs the city IT systems.', ...keep.slice(1, 3), 'Lyon hosts its data centre.', ...keep.slice(3, 8), 'Atos is the incumbent.', ...keep.slice(8)].join(' ') },
    [step('registry_search', { q: 'Ville de Testville' }, REG_TESTVILLE), step('boamp_history', { buyer_name: 'Ville de Testville' }, BOAMP_TESTVILLE)]));
  ok(!/Capgemini|Lyon|Atos/.test(b.profile.summary), 'removed'); ok(b.profile.summary === keep.join(' '), 'controls kept');
  ok(b.profile.checks.filter(c => /name not in evidence/.test(c)).length === 3, 'checks');
  return `"${b.profile.summary}"`;
});
// key partners: the suppliers of the buyer's OWN awards (its BOAMP award notices in the research, its DECP / TED rows in the market study)
const BOAMP_AWARDS_TESTVILLE = ['TOTAL 4',
  'BOAMP | 26-22222 | 2026-05-04 | ATTRIBUTION | Maintenance et évolutions du portail citoyen | buyer=Ville de Testville | winners=SOPRA STERIA; ATOS',
  'BOAMP | 26-33333 | 2026-04-02 | ATTRIBUTION | Nettoyage des locaux municipaux | buyer=Ville de Testville | winners=ONET PROPRETE',
  'BOAMP | 26-44444 | 2026-03-10 | ATTRIBUTION | Refonte du site internet | buyer=Ville de Autreville | winners=CAPGEMINI',
  'BOAMP | 26-11111 | 2026-03-02 | APPEL_OFFRE | Maintenance du parc informatique | buyer=Ville de Testville | winners='].join('\n');
const TESTVILLE_OWN = [award('DT1', { buyer: 'COMMUNE DE TESTVILLE', amount: 120000, winners: 'SOPRA STERIA S.A.', date: '2026-02-10', title: 'Tierce maintenance applicative du portail citoyen' }),
  award('DT2', { buyer: 'COMMUNE DE TESTVILLE', amount: 45000, winners: 'BERGER-LEVRAULT', cpv: '48000000', date: '2026-01-15', title: 'Progiciel de gestion financière' }),
  award('DT3', { buyer: 'COMMUNE DE TESTVILLE', amount: 30000, winners: '', date: '2026-01-05', title: 'Assistance informatique' }),
  award('T5555-2026', { src: 'TED', buyer: 'Ville de Testville', amount: 120500, winners: 'SOPRA STERIA', date: '2026-02-20', title: 'Tierce maintenance applicative du portail citoyen' }),
  award('T6666-2026', { src: 'TED', buyer: 'Testville Habitat', amount: 900000, winners: 'EIFFAGE CONSTRUCTION', cpv: '45000000', date: '2026-03-01', title: 'Construction de 40 logements' })];
const profileOf = b => ({ research_status: b.research_status, enrichment_status: b.enrichment_status, ...b.profile });
C(A3, 'Key partners: the suppliers of the buyer\'s own awards', 'research: BOAMP award notices of Ville de Testville (portal maintenance won by SOPRA STERIA + ATOS, cleaning won by ONET PROPRETE) and one of Ville de Autreville (CAPGEMINI); market study (SIREN 211234567): similar_awards of other buyers (CAPGEMINI, ATOS...), buyer_awards by SIREN: DECP "SOPRA STERIA S.A." (CPV 72), BERGER-LEVRAULT (CPV 48), a row without winner, the TED copy of the SOPRA STERIA award, a TED row of "Testville Habitat" (EIFFAGE); control: the same tender with no research and no market study',
  'key_partners = the names (strings, as the studio and the UI read them) SOPRA STERIA, ATOS, BERGER-LEVRAULT, ONET PROPRETE: IT suppliers first, one per company (S.A. is the same), the TED copy counted once; key_partners_detail = each with its relation, award count and proof (BOAMP id + URL, DECP id + amount); never another buyer\'s winner (CAPGEMINI, EIFFAGE); control: [] (nothing proves a partner); the studio copy keeps both as they are', 'BU2, MK2, PR1, Adapt for Studio', async ok => {
    const b = await research(buyer(), researchAgent({}, [step('registry_search', { q: 'Ville de Testville' }, REG_TESTVILLE), step('boamp_history', { buyer_name: 'Ville de Testville' }, BOAMP_AWARDS_TESTVILLE)]));
    const sopra = b.profile.competitors.find(c => c.name === 'SOPRA STERIA');
    ok(sopra && sopra.wins === 1 && JSON.stringify(sopra.awards) === '[{"id":"26-22222","date":"2026-05-04","title":"Maintenance et évolutions du portail citoyen","winners":["SOPRA STERIA","ATOS"]}]' && !b.profile.competitors.some(c => c.name === 'CAPGEMINI'), 'research: award ids kept');
    const task = marketTask({ buyer_official_name: 'COMMUNE DE TESTVILLE', buyer_siren: '211234567' });
    const t = await market(marketAgent({ comparable_ids: ['D1', 'D2', 'D3', 'D9'] }, [similar([...ROWS3, award('D9', { amount: 70000, winners: 'CAPGEMINI' })]),
      step('buyer_awards', { buyer_name: 'Ville de Testville', siren: '211234567', country: 'FR' }, awardsObs(TESTVILLE_OWN))]), task);
    ok(t.market.buyer_awards.map(x => x.id).join() === 'DT1,DT2' && t.market.status === 'studied', 'market: own awards only');
    const p = await proposal(ragTender({ buyer_profile: profileOf(b), market: t.market })), bp = p.buyer_profile, d = n => bp.key_partners_detail.find(x => x.name === n);
    ok(JSON.stringify(bp.key_partners) === '["SOPRA STERIA","ATOS","BERGER-LEVRAULT","ONET PROPRETE"]', 'names');
    ok(d('SOPRA STERIA').relation === 'past IT / digital supplier' && d('SOPRA STERIA').awards === 2 && d('SOPRA STERIA').last_award === '2026-05-04'
      && d('SOPRA STERIA').evidence.map(e => `${e.source} ${e.id}`).join() === 'BOAMP 26-22222,DECP DT1' && d('SOPRA STERIA').evidence[0].url === 'https://www.boamp.fr/pages/avis/?q=idweb:26-22222'
      && d('SOPRA STERIA').evidence[1].amount === 120000 && d('ONET PROPRETE').relation === 'past supplier' && d('BERGER-LEVRAULT').evidence[0].currency === 'EUR', 'detail');
    const none = await proposal(ragTender());
    ok(JSON.stringify(none.buyer_profile.key_partners) === '[]' && JSON.stringify(none.buyer_profile.key_partners_detail) === '[]', 'control: none');
    const [s] = await adapt([p]);
    ok(JSON.stringify(s.buyer_profile.key_partners) === JSON.stringify(bp.key_partners) && JSON.stringify(s.buyer_profile.key_partners_detail) === JSON.stringify(bp.key_partners_detail), 'studio copy');
    return `${bp.key_partners_detail.map(x => `${x.name} (${x.relation}, ${x.awards}: ${x.evidence.map(e => `${e.source} ${e.id}`).join(' + ')})`).join('; ')}; control ${JSON.stringify(none.buyer_profile.key_partners)}`;
  });
C(A3, 'Key partners from the real EPA-SHOM and RESAH studies', 'the recorded research and market study of EPA-SHOM (buyer_awards by name: TED rows "EPA-SHOM", "Epa Shom", "EPA SHOM"; similar_awards of other buyers such as ENAC / KELEO SOLUTIONS) and of RESAH (SIREN 130005010: DECP rows by SIREN, TED rows "GIP RESAH", "RESAH", "GIP_RESEAU DES ACHETEURS HOSPITALIERS (RESAH)")',
  'only the buyer\'s own awards make partners: EPA-SHOM\'s 5 TED awards (BLUEDROP.FR, NORGAY, WORLDLINE, OPEN, COEXYA, all IT, each with its TED URL), never a winner of another buyer\'s contract; RESAH\'s partners all come from RESAH\'s rows, at most 8', 'BU2, MK2, PR1', async ok => {
    const both = async name => { const x = REAL.market.find(q => q.item.market_task.buyer === name), r = REAL.research.find(q => q.buyer.name === name);
      const t = (await run('Parse Market', [x.agent], { 'Select Market Studies': [x.item] }))[0], b = await research(r.buyer, r.agent);
      return { t, p: await proposal(ragTender({ buyer_profile: profileOf(b), market: t.market })) }; };
    const shom = await both('EPA-SHOM'), resah = await both('RESAH');
    const own = (t, re) => t.market.buyer_awards.every(x => re.test(x.buyer)), names = p => p.buyer_profile.key_partners;
    ok(shom.t.market.buyer_awards.map(x => x.id).join() === 'T253087-2026,T796710-2025,T792543-2025,T478871-2025,T7021-2025' && own(shom.t, /^epa[ -]shom$/i), 'EPA-SHOM own awards');
    ok(['BLUEDROP.FR', 'NORGAY', 'OPEN', 'COEXYA'].every(n => names(shom.p).includes(n)) && names(shom.p).some(n => /^WORLDLINE/i.test(n)) && !names(shom.p).includes('KELEO SOLUTIONS'), 'EPA-SHOM partners');
    ok(shom.p.buyer_profile.key_partners_detail.filter(x => x.evidence.some(e => e.source === 'TED')).every(x => x.relation === 'past IT / digital supplier' && x.evidence.some(e => /^https:\/\/ted\.europa\.eu\/en\/notice\/-\/detail\/\d+-\d{4}$/.test(e.url || ''))), 'EPA-SHOM proof');
    const resahIds = new Set(resah.t.market.buyer_awards.map(x => x.id));
    ok(resah.t.market.buyer_awards.length && own(resah.t, /resah|reseau des acheteurs hospitaliers/i) && names(resah.p).length === 8
      && resah.p.buyer_profile.key_partners_detail.every(x => x.evidence.every(e => e.source === 'BOAMP' || resahIds.has(e.id))), 'RESAH');
    return `EPA-SHOM: ${names(shom.p).join(', ')}; RESAH (${resah.t.market.buyer_awards.length} own awards): ${names(resah.p).join(', ')}`;
  });
C(A3, 'Key partners: another kind of body in the same place is another buyer', 'market study of "Ville de Lyon" (no SIREN): similar_awards rows of METROPOLE DE LYON (ACME INFORMATIQUE), CENTRE HOSPITALIER DE LYON (MEDICA), SYNDICAT MIXTE DE LYON (EAUX ET CO); buyer_awards rows of TED "Ville de Lyon" (SOPRA STERIA) and DECP "COMMUNE DE LYON (MAIRIE)" (BERGER-LEVRAULT); 2nd: "Département du Rhône", TED rows of "Conseil départemental du Rhône" (ATOS) and "Région Auvergne-Rhône-Alpes" (CGI); 3rd: Ville de Testville with its SIREN 211234567: a similar_awards DECP row "COMMUNE DE TESTVILLE" not read by the SIREN (a namesake), its buyer_awards DECP row read by the SIREN, a TED row "Ville de Testville"',
  'own awards = the Ville\'s (VILLE = COMMUNE): partners SOPRA STERIA, BERGER-LEVRAULT, never the Métropole\'s, the hospital\'s nor the syndicat\'s winners (the kind of body is part of the name); the Conseil départemental is the Département, the Région is not; with the SIREN, a DECP row counts only when read by it (the namesake left out), the TED row by its name', 'MK2, PR1', async ok => {
    const lyon = await market(marketAgent({ comparable_ids: ['D1', 'D2', 'D3'] }, [similar([...ROWS3, award('DM1', { buyer: 'METROPOLE DE LYON', amount: 70000, winners: 'ACME INFORMATIQUE' }),
      award('DM2', { buyer: 'CENTRE HOSPITALIER DE LYON', amount: 71000, winners: 'MEDICA', date: '2026-04-01' }), award('DM3', { buyer: 'SYNDICAT MIXTE DE LYON', amount: 72000, winners: 'EAUX ET CO', date: '2026-04-02' })]),
      step('buyer_awards', { buyer_name: 'Ville de Lyon', country: 'FR' }, awardsObs([award('TL1', { src: 'TED', buyer: 'Ville de Lyon', amount: 300000, winners: 'SOPRA STERIA', date: '2026-02-01' }),
        award('DL1', { buyer: 'COMMUNE DE LYON (MAIRIE)', amount: 40000, winners: 'BERGER-LEVRAULT', cpv: '48000000', date: '2026-01-10' })]))]), marketTask({ buyer: 'Ville de Lyon' }));
    ok(lyon.market.buyer_awards.map(x => x.id).join() === 'TL1,DL1', 'Ville de Lyon: own awards only');
    const p = await proposal(ragTender({ market: lyon.market }));
    ok(JSON.stringify(p.buyer_profile.key_partners) === '["SOPRA STERIA","BERGER-LEVRAULT"]', 'Ville de Lyon: partners');
    const rhone = await market(marketAgent({ comparable_ids: ['D1', 'D2', 'D3'] }, [similar(ROWS3), step('buyer_awards', { buyer_name: 'Département du Rhône', country: 'FR' },
      awardsObs([award('TR1', { src: 'TED', buyer: 'Conseil départemental du Rhône', amount: 200000, winners: 'ATOS' }), award('TR2', { src: 'TED', buyer: 'Région Auvergne-Rhône-Alpes', amount: 210000, winners: 'CGI', date: '2026-04-01' })]))]),
      marketTask({ buyer: 'Département du Rhône' }));
    ok(rhone.market.buyer_awards.map(x => x.id).join() === 'TR1', 'Département du Rhône');
    const task = marketTask({ buyer_official_name: 'COMMUNE DE TESTVILLE', buyer_siren: '211234567' });
    const tv = await market(marketAgent({ comparable_ids: ['D1', 'D2', 'D3'] }, [similar([...ROWS3, award('DN1', { buyer: 'COMMUNE DE TESTVILLE', amount: 66000, winners: 'NAMESAKE SARL', date: '2026-04-03' })]),
      step('buyer_awards', { buyer_name: 'Ville de Testville', siren: '211234567', country: 'FR' }, awardsObs([award('DT1', { buyer: 'COMMUNE DE TESTVILLE', amount: 120000, winners: 'SOPRA STERIA', date: '2026-02-10' }),
        award('TT1', { src: 'TED', buyer: 'Ville de Testville', amount: 500000, winners: 'CAPGEMINI', date: '2025-12-01' })]))]), task);
    ok(tv.market.buyer_awards.map(x => x.id).join() === 'DT1,TT1', 'SIREN: the namesake DECP row left out');
    return `Ville de Lyon: ${lyon.market.buyer_awards.map(x => `${x.id} ${x.buyer}`).join(', ')} -> ${p.buyer_profile.key_partners.join(', ')}; Département du Rhône: ${rhone.market.buyer_awards.map(x => `${x.id} ${x.buyer}`).join(', ')}; with the SIREN: ${tv.market.buyer_awards.map(x => x.id).join(', ')}`;
  });
// an award naming several winners (lots, co-contractors): RESAH's real 26-97793 (6 winners) / T703576-2026 (CPV 38900000 + 48180000)
const BOAMP_SHARED_TESTVILLE = ['TOTAL 2',
  'BOAMP | 26-55555 | 2026-05-04 | ATTRIBUTION | Equipements de mesure et gestion de maintenance assistée par ordinateur | buyer=Ville de Testville | winners=MORGATE BIOMEDICAL; GAMIDA; ISILOG',
  'BOAMP | 26-66666 | 2026-06-01 | ATTRIBUTION | AOO AMOA SI | buyer=Ville de Testville | winners=BEARING POINT; MC2I'].join('\n');
const SHARED_OWN = [award('T7777-2026', { src: 'TED', buyer: 'Ville de Testville', amount: 900000, winners: 'MORGATE BIOMEDICAL; GAMIDA', cpv: '38900000,48180000', date: '2026-05-06', title: 'Equipements de mesure et gestion de maintenance assistée par ordinateur' }),
  award('T8888-2026', { src: 'TED', buyer: 'Ville de Testville', amount: 150000, winners: 'ISILOG', cpv: '48180000', date: '2026-05-06', title: 'Equipements de mesure et gestion de maintenance assistée par ordinateur - Lot 2' }),
  award('DT9', { buyer: 'COMMUNE DE TESTVILLE', amount: 30000, winners: 'DIMOMAINT', cpv: '38900000,48180000', date: '2026-02-01', title: 'Bancs de test' })];
C(A3, 'Key partners: an award with several winners', 'BOAMP award notices of Ville de Testville: 26-55555 (test equipment and maintenance management, winners MORGATE BIOMEDICAL; GAMIDA; ISILOG, no digital word) and 26-66666 "AOO AMOA SI" (BEARING POINT; MC2I); its TED copies: T7777-2026 (MORGATE BIOMEDICAL; GAMIDA, CPV 38900000 + 48180000) and T8888-2026 (lot 2, ISILOG alone, CPV 48180000); a DECP award to DIMOMAINT alone (CPV 38900000 + 48180000)',
  'IT supplier only where an award proves it for that company: ISILOG (its lot, CPV 48), BEARING POINT and MC2I (an IT-only award: "SI"), DIMOMAINT (alone on an award with a software CPV); MORGATE BIOMEDICAL and GAMIDA are past suppliers (a multi-winner award mixing equipment and software CPVs does not say who won the software); each award once', 'BU2, MK2, PR1', async ok => {
    const b = await research(buyer(), researchAgent({}, [step('registry_search', { q: 'Ville de Testville' }, REG_TESTVILLE), step('boamp_history', { buyer_name: 'Ville de Testville' }, BOAMP_SHARED_TESTVILLE)]));
    const t = await market(marketAgent({ comparable_ids: ['D1', 'D2', 'D3'] }, [similar(ROWS3), step('buyer_awards', { buyer_name: 'Ville de Testville', country: 'FR' }, awardsObs(SHARED_OWN, 'TOTAL TED 2 found, DECP 1 found'))]));
    const p = await proposal(ragTender({ buyer_profile: profileOf(b), market: t.market })), d = n => p.buyer_profile.key_partners_detail.find(x => x.name === n) || {};
    ok(JSON.stringify(p.buyer_profile.key_partners) === '["BEARING POINT","MC2I","ISILOG","DIMOMAINT","MORGATE BIOMEDICAL","GAMIDA"]', 'names, IT first');
    ok(['BEARING POINT', 'MC2I', 'ISILOG', 'DIMOMAINT'].every(n => d(n).relation === 'past IT / digital supplier') && ['MORGATE BIOMEDICAL', 'GAMIDA'].every(n => d(n).relation === 'past supplier'), 'relations');
    ok(d('MORGATE BIOMEDICAL').awards === 1 && d('ISILOG').awards === 1 && d('ISILOG').evidence.map(e => e.id).join() === 'T8888-2026,26-55555', 'each award once');
    return p.buyer_profile.key_partners_detail.map(x => `${x.name} (${x.relation}: ${x.evidence.map(e => e.id).join(' + ')})`).join('; ');
  });
C(A3, 'Tender platform given as the buyer website (notice)', 'two buyers; notice websites "https://www.marches-securises.fr/entreprise/?module=consultation" and "https://www.testville.fr"',
  'the platform is never passed as the known website; the real site is', 'BU1', async ok => {
    const t = (key, name, website) => ({ tender_id: `T${key}`, buyer_key: key, buyer_id: `B${key}`, survivor: true, too_late: false, days_left: 20, title: 'Refonte du site internet',
      source_url: `https://fixture.test/fr/avis/${key}`, language: 'fr', analysis: { fit: 'high' }, buyer: { name, country: 'FR', contacts: { website } } });
    const out = await run('Select Buyers', [t('a', 'Ville de Autreville', 'https://www.marches-securises.fr/entreprise/?module=consultation'), t('b', 'Ville de Testville', 'https://www.testville.fr')]);
    const a = out.find(b => b.buyer_key === 'a'), b = out.find(x => x.buyer_key === 'b');
    ok(a.known_website === '' && b.known_website === 'https://www.testville.fr', 'platform not used'); return `platform -> "${a.known_website}", own site -> "${b.known_website}"`;
  });
C(A3, 'Tender platform given as the buyer website (research)', 'web_search: "achatpublic.com/…  Ville de Testville - Consultations" and "www.testville.fr  Ville de Testville - Site officiel"; agent says achatpublic',
  'official website = testville.fr (search title match), never the platform; the agent\'s website ignored', 'BU2', async ok => {
    const web = 'WEB | https://www.achatpublic.com/consultation/2026-123 | Ville de Testville - Consultations en cours | Marchés publics de la Ville de Testville\n'
      + 'WEB | https://www.testville.fr/ | Ville de Testville - Site officiel | Mairie de Testville, démarches et actualités';
    const b = await research(buyer(), researchAgent({ official_website: 'https://www.achatpublic.com/consultation/2026-123' }, [step('web_search', { query: 'Ville de Testville France' }, web)]));
    ok(b.profile.official_website === 'https://testville.fr' && b.profile.checks.some(c => /agent website ignored/.test(c)), 'own site');
    return `website ${b.profile.official_website} (${b.profile.contacts.sources.website})`;
  });
C(A3, 'Contacts from another site', 'declared site testville.fr; scraped an annuaire page (contact@annuaire-mairie.fr) and testville.fr/contact (accueil@testville.fr, a gmail address)',
  'only accueil@testville.fr kept; the off-domain page ignored (check)', 'BU2', async ok => {
    const s1 = 'PAGE | https://www.annuaire-mairie.fr/mairie-testville.html\nEMAILS: contact@annuaire-mairie.fr\nPHONES: 01 99 99 99 99\nTEXT: Mairie de Testville, horaires et contact.';
    const s2 = 'PAGE | https://www.testville.fr/contact\nEMAILS: accueil@testville.fr, testville.mairie@gmail.com\nPHONES: 01 23 45 67 89\nTEXT: Contactez la mairie de Testville.';
    const b = await research(buyer({ known_website: 'https://www.testville.fr' }), researchAgent({}, [step('web_scrape', { url: 'https://www.annuaire-mairie.fr/mairie-testville.html' }, s1),
      step('web_scrape', { url: 'https://www.testville.fr/contact' }, s2)]));
    ok(JSON.stringify(b.profile.contacts.emails) === '["accueil@testville.fr"]' && JSON.stringify(b.profile.contacts.phones) === '["01 23 45 67 89"]', 'contacts');
    ok(b.profile.checks.some(c => /1 scraped page\(s\) ignored/.test(c)), 'check');
    return `emails ${b.profile.contacts.emails}, phones ${b.profile.contacts.phones}`;
  });
C(A3, 'French registry hit for a foreign buyer', 'Tunisian buyer "Ministère de l\'Exemple"; registry returns "MINISTERE DE L EXEMPLE" (public body)', 'ignored (check "registry ignored: French registry for a non-French buyer")', 'BU2', async ok => {
  const b = await research(buyer({ name: 'Ministère de l\'Exemple', search_name: 'Ministère de l\'Exemple', country: 'TN', country_name: 'Tunisia', buyer_key: 'ministere de l exemple' }),
    researchAgent({ buyer_type: 'state_administration' }, [step('registry_search', { q: 'Ministère de l\'Exemple' }, 'REG | MINISTERE DE L EXEMPLE | siren=110000001 | siret=11000000100019 | addr=PARIS | city=PARIS | nature=7110 | public=yes | staff=NN | staff_year=')]));
  ok(!b.profile.registry.match_ok && b.profile.checks.some(c => /French registry for a non-French buyer/.test(c)), 'ignored');
  return b.profile.registry.reason;
});
C(A3, 'Research agent error', 'agent error item "Agent stopped due to max iterations."', 'research_failed, enrichment none, empty summary, check with the error', 'BU2', async ok => {
  const b = await research(buyer(), { error: { message: 'Agent stopped due to max iterations.' } });
  ok(b.research_status === 'research_failed' && b.enrichment_status === 'none' && b.profile.summary === '' && b.profile.checks[0].startsWith('agent error'), 'failed');
  return `${b.research_status}, ${b.enrichment_status}`;
});
C(A3, 'Unnamed buyer and research budget', '5 fit buyers, maxBuyersToResearch 3: one without a name, one with a too-late tender',
  'unnamed: skipped_no_buyer_name (uses no slot); 3 researched; the too-late one: not_researched_budget', 'BU1', async ok => {
    const t = (key, name, fit, days, late) => ({ tender_id: `T${key}`, buyer_key: name ? key : `unknown:T${key}`, buyer_id: `B${key}`, survivor: true, too_late: !!late, days_left: days,
      title: `Tender ${key}`, source_url: `https://fixture.test/${key}`, analysis: { fit }, buyer: { name, country: 'FR', contacts: {} } });
    const out = await run('Select Buyers', [t('a', 'Ville de Testville', 'high', 20), t('b', '', 'high', 15), t('c', 'Département de Testshire', 'medium', 10),
      t('d', 'Région Test', 'high', 1, true), t('e', 'Hôpital de Test', 'high', 30)]);
    const st = Object.fromEntries(out.map(b => [b.name || 'unnamed', b.research_status]));
    ok(st.unnamed === 'skipped_no_buyer_name' && st['Région Test'] === 'not_researched_budget' && out.filter(b => b._run).length === 3, 'budget');
    return Object.entries(st).map(([k, v]) => `${k}: ${v}`).join('; ');
  });

// ---- URL lane, real run of 2026-10-20 (francemarches, domainetat-tn): open_page (Scout Tools sub-workflow), scout picks, Firecrawl pace,
// split dates, titles. A Scout Tools node runs with the same runner (its code in place of a Main node's)
const SCOUT_TOOLS = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist/RFP - Scout Tools.json'), 'utf8'));
const scoutTool = async (node, input, refs) => (await run('URL3 - Links to URLs', [input], refs, () => SCOUT_TOOLS.nodes.find(n => n.name === node).parameters.jsCode))[0];
const URL_SOURCES = JSON.stringify([{ name: 'francemarches', url: 'https://www.francemarches.com/recherche?q=Intelligence+Artificielle&etat=en-cours', allowedHosts: [], only_main: true },
  { name: 'domainetat-tn', url: 'https://www.domainetat.tn/?cat=19&lang=fr', allowedHosts: [], only_main: true }]);
// open_page as Scout Tools runs it: Resolve Source -> Firecrawl Scrape (its answer given here) -> Page Links
async function openPage(url, firecrawl) {
  const T = await scoutTool('Resolve Source', { tool: 'open_page', firecrawl_base: 'https://api.firecrawl.dev', url_sources: URL_SOURCES, max_links: '100', url });
  return { T, result: (await scoutTool('Page Links', firecrawl, { 'Resolve Source': [T] })).result };
}
const scraped = (url, title, lines) => ({ success: true, data: { markdown: lines.join('\n'), metadata: { url, sourceURL: url, title, statusCode: 200 } } });
// scoutRun's whole result (URL3 itself maps only the picks): URL3's code cut after its helpers
const scoutRunOf = async (agent, task) => (await run('URL3 - Links to URLs', [agent], { 'URL1 - Scout Tasks': [task] },
  s => s.replace(/const cfg = \$\('00 - Config'\)[\s\S]*$/, "return [{ json: scoutRun($input.first().json, $('URL1 - Scout Tasks').itemMatching(0).json) }];")))[0];
const TASK_FM = { source: 'francemarches', url: 'https://www.francemarches.com/recherche?q=Intelligence+Artificielle&etat=en-cours', other_pages: ['https://www.francemarches.com/recherche?q=Intelligence+Artificielle&etat=en-cours&page=2'],
  country: 'FR', language: 'fr', max_pages: 2, max_calls: 4, allowed_hosts: ['francemarches.com'], onlyMainContent: true };
const TASK_DOM = { source: 'domainetat-tn', url: 'https://www.domainetat.tn/?cat=19&lang=fr', other_pages: ['https://www.domainetat.tn/?cat=19&lang=fr&paged=2'],
  country: 'TN', language: 'fr', max_pages: 2, max_calls: 4, allowed_hosts: ['domainetat.tn'], onlyMainContent: true };
const DPAGED = n => `https://www.domainetat.tn/?cat=19&lang=fr&paged=${n}`;
// the list pages as Firecrawl wrote them (WordPress pager; link ids and contexts are those of the recorded open_page results)
const DOM_LIST1 = scraped(TASK_DOM.url, 'Appel d’offre – Ministère des Domaines de l\'Etat et des Affaires foncières', ['- Publication publiée :20 août 2026',
  '- Catégorie de la publication : [Annonces](https://www.domainetat.tn/?cat=9&lang=fr)/ [Appel d\'offre](https://www.domainetat.tn/?cat=19&lang=fr)', '',
  '## [Consultation N°28/2026 auprès des centres de formation spécialisés dans le domaine Informatique pour réaliser des sessions de formation sur le logiciel : « Les fondamentaux de l’Intelligence Artificielle »](https://www.domainetat.tn/?p=16872&lang=fr)', '',
  '## [Appel d’offres N°:20/2026 Matériels Réseaux](https://www.domainetat.tn/?p=16800&lang=fr)', '',
  '- 1', `- [2](${DPAGED(2)})`, `- [3](${DPAGED(3)})`, `- [4](${DPAGED(4)})`, '- …', `- [26](${DPAGED(26)})`, `- [Aller à la page suivante](${DPAGED(2)})`]);
const DOM_LIST2 = scraped('https://www.domainetat.tn/?cat=19&paged=2&lang=fr', 'Appel d’offre – Page 2 – Ministère des Domaines de l\'Etat et des Affaires foncières', ['- Publication publiée :2 mars 2026', '',
  '## [Consultation N° 02/2026 pour réaliser des sessions de formation sur le logiciel : « Intelligence Artificielle, Machine Learning et Deep Learning ».](https://www.domainetat.tn/?p=16062&lang=fr)', '',
  '## [Acquisition des équipements suivants](https://www.domainetat.tn/?p=16000&lang=fr)', '',
  `- [Aller à la page précédente](${DPAGED(1)})`, `- [1](${DPAGED(1)})`, '- 2', `- [3](${DPAGED(3)})`, `- [4](${DPAGED(4)})`, `- [5](${DPAGED(5)})`, '- …', `- [26](${DPAGED(26)})`, `- [Aller à la page suivante](${DPAGED(3)})`]);
const FM_LIST2 = scraped(TASK_FM.other_pages[0], '            Appel d\'offre / Avis publics sur France Marchés', ['Accueil/Appels d’offres', '',
  '[Date de parution](https://www.francemarches.com/recherche?q=Intelligence%20Artificielle&etat=en-cours&page=2&ordre=date-publication-asc)', '',
  '[021 CCI ROUEN METROPOLE Projet INNOP\'IA - Phase2 - Missions d\'assistance Européen Avis d\'attribution Services Procédure](https://www.francemarches.com/appel-offre/13joue006176972026-2026-projet-innop-phase2?q=Intelligence%20Artificielle)', '',
  '[20 avis de marchés publics suivants](https://www.francemarches.com/recherche?q=Intelligence%20Artificielle&etat=en-cours&page=3)', '', '[Créer un compte (gratuit)](https://www.francemarches.com/offre)']);
// the recorded open_page results (detector of that run: "NEXT PAGE: none") and the agents' real answers
const DOM_SEEN1 = ['PAGE [mxb1hp] | https://www.domainetat.tn/?cat=19&lang=fr | Appel d’offre – Ministère des Domaines de l\'Etat et des Affaires foncières',
  'TEXT: Aller au contenu - Publication publiée :20 août 2026 - Catégorie de la publication : Annonces/ Appel d\'offre Le Ministère des Domaines de l’Etat et des Affaires Foncières se propose de lancer une consultation N°28/2026',
  'REPEATED LABELS: none', 'NEXT PAGE: none', 'LINKS (same site, 10 of 10):',
  '[pslgag] Annonces — - Publication publiée :20 août 2026 - Catégorie de la publication : An | https://www.domainetat.tn/?cat=9&lang=fr',
  '[6nirv3] Consultation N°28/2026 auprès des centres de formation spécialisés dans le domaine Informatique pour réaliser des sessio | https://www.domainetat.tn/?p=16872&lang=fr',
  '[80wmse] Consultation N° 30/2026 pour acquisition des logiciels de sécurité informatique | https://www.domainetat.tn/?p=16804&lang=fr',
  '[1qvfhuy] Appel d’offres N°:20/2026 Matériels Réseaux | https://www.domainetat.tn/?p=16800&lang=fr',
  '[btoh2m] AVIS DE CONSULTATION N° 16/2026Pour la Réalisation des Sessions de Formation sur le Logiciel « DevOps Foundation » | https://www.domainetat.tn/?p=16390&lang=fr',
  '[xyg2k3] Appel d’offre N°08/2026 Acquisition matériels informatiques | https://www.domainetat.tn/?p=16380&lang=fr',
  `[v6azbh] Aller à la page suivante — - 1 - 2 - 3 | ${DPAGED(2)}`, `[uwbdmi] 3 — - 2 - 3 - 4 | ${DPAGED(3)}`, `[tidd5n] 4 — - 3 - 4 - … | ${DPAGED(4)}`,
  `[p8m469] 26 — - … - 26 - Aller à la page suivante | ${DPAGED(26)}`].join('\n');
const DOM_SEEN2 = ['PAGE [vw5xw1] | https://www.domainetat.tn/?cat=19&paged=2&lang=fr | Appel d’offre – Page 2 – Ministère des Domaines de l\'Etat et des Affaires foncières',
  'TEXT: Aller au contenu - Publication publiée :2 mars 2026 - Catégorie de la publication : Annonces/ Appel d\'offre', 'REPEATED LABELS: none', 'NEXT PAGE: none', 'LINKS (same site, 12 of 12):',
  '[pslgag] Annonces — - Publication publiée :2 mars 2026 - Catégorie de la publication : Ann | https://www.domainetat.tn/?cat=9&lang=fr',
  '[mxb1hp] Appel d\'offre — - Publication publiée :2 mars 2026 - Catégorie de la publication : Ann | https://www.domainetat.tn/?cat=19&lang=fr',
  '[1aheg7q] Consultation N° 02/2026 pour réaliser des sessions de formation sur le logiciel : « Intelligence Artificielle, Machine L | https://www.domainetat.tn/?p=16062&lang=fr',
  '[mllwwi] Consultation N° 1/2026 relative au câblage du nouveau local de la direction Générale des contentieux de l’Etat | https://www.domainetat.tn/?p=15845&lang=fr',
  '[mmc2m9] AVIS DE CONSULTATION N° 24/2025 Acquisition de consommables Informatiques | https://www.domainetat.tn/?p=15453&lang=fr',
  '[e80573] AVIS DE CONSULTATION N° 23/2025 Pour la Réalisation d’une Session de Formation sur le Logiciel « Intelligence Artificiel | https://www.domainetat.tn/?p=15419&lang=fr',
  '[7bgzri] Appel d’Offres N° 20/2025 Achat de matériels Informatiques | https://www.domainetat.tn/?p=15409&lang=fr',
  `[ucc68k] Aller à la page précédente — - Aller à la page précédente - 1 | ${DPAGED(1)}`, `[uwbdmi] Aller à la page suivante — - 2 - 3 - 4 | ${DPAGED(3)}`,
  `[tidd5n] 4 — - 3 - 4 - 5 | ${DPAGED(4)}`, `[t8drgo] 5 — - 4 - 5 - … | ${DPAGED(5)}`, `[p8m469] 26 — - … - 26 - Aller à la page suivante | ${DPAGED(26)}`].join('\n');
const DOM_AGENT = { output: JSON.stringify({ tender_links: ['6nirv3', '80wmse', '1qvfhuy', 'btoh2m', 'xyg2k3', 'v6azbh', '1aheg7q', 'mllwwi', 'mmc2m9', 'e80573', '7bgzri', 'uwbdmi', 'tidd5n', 'p8m469'], list_url: TASK_DOM.url }),
  intermediateSteps: [step('open_page', { url: 'https://www.domainetat.tn/?cat=19&lang=-fr' }, DOM_SEEN1), step('open_page', { url: TASK_DOM.other_pages[0] }, DOM_SEEN2)] };
const FM_TYPO = 'https://www.franc-than.com/recherche?q=Intelligence+Artificielle&etat=en-cours';
const FM_SEEN2 = [`PAGE [bld29b] | ${TASK_FM.other_pages[0]} |             Appel d'offre / Avis publics sur France Marchés`, 'TEXT: OK Opérateur OU : au moins un des mots ou groupe de mots dans l’avis', 'REPEATED LABELS: none', 'NEXT PAGE: none', 'LINKS (same site, 28 of 28):',
  '[xqyfma] Accueil — /Appels d’offres | https://www.francemarches.com/',
  '[168zl2d] Date de parution — Date de clôture | https://www.francemarches.com/recherche?q=Intelligence%20Artificielle&etat=en-cours&page=2&ordre=date-publication-asc',
  '[we362f] 021 CCI ROUEN METROPOLE Projet INNOP\'IA - Phase2 - Missions d\'assistance Européen Avis d\'attribution Services Procédure  | https://www.francemarches.com/appel-offre/13joue006176972026-2026-projet-innop-phase2?q=Intelligence%20Artificielle',
  '[1rt4du7] 022 GIP RESAH Acquisition d\'une plateforme innovante de services d\'intelligence artificielle générative multi-modèles Eu | https://www.francemarches.com/appel-offre/3boamp2687830-2026-acquisition-plateforme-innovante?q=Intelligence%20Artificielle',
  '[odmndd] 023 Ministère de l\'Intérieur RFI - SYSTEME DE VIDEOPROTECTION ET DE CAMERAS AEROPORTEES National AAPC Fournitures Procéd | https://www.francemarches.com/appel-offre/37ec0710260911202667-2026-systeme-videoprotection-cameras?q=Intelligence%20Artificielle',
  '[nxh32w] 20 avis de marchés publics suivants | https://www.francemarches.com/recherche?q=Intelligence%20Artificielle&etat=en-cours&page=3'].join('\n');
const fmAgent = first => ({ output: JSON.stringify({ tender_links: ['we362f', '1rt4du7', 'odmndd', 'nxh32w'], list_url: 'https://www.francemarches.com/recherche?q=Intelligence%20Artificielle&etat=en-cours&page=2' }),
  intermediateSteps: [step('open_page', { url: FM_TYPO }, first), step('open_page', { url: TASK_FM.other_pages[0] }, FM_SEEN2)] });
const FM_DNS = `PAGE ERROR | ${FM_TYPO} | firecrawl: DNS resolution failed for hostname "www.franc-than.com". This means the domain name could not be translated to an IP address. Possible causes: (1) The domain na`;

C(A3, 'open_page on a host of no source (real typo)', 'the agent asked "https://www.franc-than.com/recherche?q=Intelligence+Artificielle&etat=en-cours" (START URL on www.francemarches.com); control: page 2 of the real host',
  'refused before Firecrawl (the "Known source?" IF sends it straight to Page Links: no request, no credit); the agent reads "PAGE ERROR … refused"; the real host resolves as before; scoutRun lists the START URL as never opened', 'Resolve Source, Known source?, Page Links, scoutRun', async ok => {
    const bad = await openPage(FM_TYPO, {});
    const good = await openPage(TASK_FM.other_pages[0], FM_LIST2);
    // the IF of Scout Tools: true (known source) -> Firecrawl Scrape, false (refused) -> Page Links
    const ifc = SCOUT_TOOLS.connections['Known source?'], cond = JSON.stringify(SCOUT_TOOLS.nodes.find(n => n.name === 'Known source?').parameters);
    ok(bad.T.source === null && /^refused, no page read/.test(bad.T.refused) && /!\$json\.refused/.test(cond)
      && ifc.main[0][0].node === 'Firecrawl Scrape' && ifc.main[1][0].node === 'Page Links', 'refused, routed around Firecrawl');
    ok(bad.result.startsWith(`PAGE ERROR | ${FM_TYPO} | refused, no page read: franc-than.com is not a site of the configured sources`), 'agent told');
    ok(good.T.source === 'francemarches' && !good.T.refused && good.T.firecrawl_base === 'https://api.firecrawl.dev' && good.result.startsWith('PAGE [bld29b]'), 'real host');
    const r = await scoutRunOf(fmAgent(bad.result), TASK_FM);
    ok(JSON.stringify(r.not_opened) === JSON.stringify([TASK_FM.url]) && /refused/.test(r.pages[0].error), 'START URL not opened');
    return `${bad.result.slice(0, 110)}…; not_opened ${r.not_opened}`;
  });
C(A3, 'NEXT PAGE of both portals (real pagination)', 'domainetat pager "- 1 - [2] - [3] - [4] - … - [26] - [Aller à la page suivante]" (page 2 also "Aller à la page précédente"); francemarches page 2 "[20 avis de marchés publics suivants](…&page=3)"; a short notice "Acquisition des équipements suivants"',
  'NEXT PAGE = paged=2, paged=3, page=3 (never the previous page nor the notice); a scout that stops after page 2 leaves next_unopened for Run Summary', 'Page Links, scoutRun', async ok => {
    const d1 = await openPage(TASK_DOM.url, DOM_LIST1), d2 = await openPage(TASK_DOM.other_pages[0], DOM_LIST2), f2 = await openPage(TASK_FM.other_pages[0], FM_LIST2);
    const nxt = p => (p.result.match(/^NEXT PAGE: (.*)$/m) || [])[1];
    ok(nxt(d1) === `[v6azbh] | ${DPAGED(2)}` && nxt(d2) === `[uwbdmi] | ${DPAGED(3)}`, 'domainetat');
    ok(nxt(f2) === '[nxh32w] | https://www.francemarches.com/recherche?q=Intelligence%20Artificielle&etat=en-cours&page=3', 'francemarches');
    const r = await scoutRunOf({ output: JSON.stringify({ tender_links: ['6nirv3', '1aheg7q'], list_url: TASK_DOM.url }),
      intermediateSteps: [step('open_page', { url: TASK_DOM.url }, d1.result), step('open_page', { url: TASK_DOM.other_pages[0] }, d2.result)] }, TASK_DOM);
    ok(r.next_unopened === DPAGED(3) && r.picks.length === 2, 'next_unopened');
    return `${nxt(d1)}; ${nxt(d2)}; ${nxt(f2)}; next_unopened ${r.next_unopened}`;
  });
C(A3, 'List and pagination pages picked as tenders (real)', 'real scout answers: domainetat 14 ids incl. "Aller à la page suivante" (paged=2, opened as "?cat=19&paged=2&lang=fr"), "3", "4", "26"; francemarches "20 avis de marchés publics suivants" (page=3), list_url written with %20 for an opened "+" URL',
  'only notices go to Firecrawl Detail (production cap 40): domainetat 10, francemarches 3; navigation_dropped 4 and 1; francemarches list_url found', 'URL3 (scoutRun)', async ok => {
    const cfg40 = { '00 - Config': [{ ...CFG, limits: { ...CFG.limits, maxTendersPerUrlSource: 40 } }] };
    const dom = await run('URL3 - Links to URLs', [DOM_AGENT], { ...cfg40, 'URL1 - Scout Tasks': [TASK_DOM] });
    const fm = await run('URL3 - Links to URLs', [fmAgent(FM_DNS)], { ...cfg40, 'URL1 - Scout Tasks': [TASK_FM] });
    const [rd, rf] = [await scoutRunOf(DOM_AGENT, TASK_DOM), await scoutRunOf(fmAgent(FM_DNS), TASK_FM)];
    ok(dom.length === 10 && dom.every(l => /\?p=\d+&lang=fr$/.test(l.url)) && rd.navigation_dropped === 4, 'domainetat');
    ok(fm.length === 3 && fm.every(l => /\/appel-offre\//.test(l.url)) && rf.navigation_dropped === 1 && rf.list_url === TASK_FM.other_pages[0], 'francemarches');
    // control: a site whose notices are "?page=<slug>" too: only a page parameter with a NUMBER makes another page of the list
    const slug = ['PAGE [s0] | https://fixture.test/index.php?page=appels-offres | Appels d’offres', 'TEXT: Appels d’offres en cours', 'REPEATED LABELS: none', 'NEXT PAGE: none', 'LINKS (same site, 2 of 2):',
      '[s1] Fourniture de 200 ordinateurs portables | https://fixture.test/index.php?page=avis-2026-12', '[s2] Suivant » | https://fixture.test/index.php?page=appels-offres&start=20'].join('\n');
    const rs = await scoutRunOf({ output: JSON.stringify({ tender_links: ['s1', 's2'], list_url: null }), intermediateSteps: [step('open_page', { url: 'https://fixture.test/index.php?page=appels-offres' }, slug)] }, REAL.scout_fr.task);
    ok(rs.picks.length === 1 && rs.picks[0].url === 'https://fixture.test/index.php?page=avis-2026-12' && rs.navigation_dropped === 1, 'slug notice kept');
    return `domainetat ${dom.length} notices (dropped ${rd.navigation_dropped}), francemarches ${fm.length} (dropped ${rf.navigation_dropped}, list_url ${rf.list_url}); "?page=<slug>" notice kept`;
  });
C(A3, 'Firecrawl Detail pace after the scout (real HTTP 429)', 'real run: 4 open_page scrapes, then detail scrapes 6.5 s apart; the 7th got HTTP 429 "Consumed (req/min): 11" (free plan 10/min)',
  'per-item batch interval: with the 4 scout calls the first minute holds at most 9 calls (5 detail calls, then a wait to +61 s), then 6.5 s apart', 'Firecrawl Detail (options)', async ok => {
    const expr = wf.nodes.find(n => n.name === 'Firecrawl Detail').parameters.options.batching.batch.batchInterval.replace(/^=\{\{\s*|\s*\}\}$/g, '');
    const $ = n => ({ first: () => ({ json: CFG }), all: () => (n === 'Tender Scout Agent' ? [fmAgent(FM_DNS), DOM_AGENT] : []).map(json => ({ json })) });
    const at = []; let t = 0;
    for (let i = 0; i < 10; i++) { if (i) t += new Function('$', '$itemIndex', `return (${expr});`)($, i); at.push(t); }
    const firstMinute = 4 + at.filter(x => x < 60000).length;
    ok(firstMinute <= 9 && at.every((x, i) => !i || x - at[i - 1] >= CFG.firecrawl.intervalMs), 'within the budget');
    return `detail calls at ${at.map(x => (x / 1000).toFixed(1)).join(' ')} s: ${firstMinute} calls in the first minute with the scout's`;
  });
C(A3, 'Firecrawl HTTP 429 reported with its cause (real)', 'real Firecrawl Detail item: error {message "Try spacing your requests out using the batching settings under \'Options\'", status 429}, details {description "Rate limit exceeded. Consumed (req/min): 11 …"}',
  'Run Summary names HTTP 429 and Firecrawl\'s reason, not n8n\'s generic batching hint', 'Run Summary (pageError)', async ok => {
    const err = { error: { message: 'Try spacing your requests out using the batching settings under \'Options\'', name: 'AxiosError', code: 'ERR_BAD_REQUEST', status: 429 },
      details: { message: 'The service is receiving too many requests from you', description: 'Rate limit exceeded. Consumed (req/min): 11, Remaining (req/min): 0. Upgrade your plan at https://firecrawl.dev/pricing for increased rate limits or please retry after 5s, resets at Mon Oct 19 2026 23:59:37 GMT+0000 (Coordinated Universal Time)',
        httpCode: '429', body: { success: false, error: 'Rate limit exceeded. Consumed (req/min): 11, Remaining (req/min): 0.', retry_after_seconds: 5 } } };
    const [s] = await run('Run Summary', [{}], { 'URL3 - Links to URLs': [{ source: 'domainetat-tn', url: 'https://www.domainetat.tn/?p=16804&lang=fr' }], 'Firecrawl Detail': [err] });
    const e = (s.per_source['domainetat-tn'].errors || []).find(x => x.startsWith('detail')) || '';
    ok(/429/.test(e) && /Rate limit exceeded/.test(e), 'cause kept'); return e;
  });
const P16800 = page({ source: 'domainetat-tn', url: 'https://www.domainetat.tn/?p=16800&lang=fr', anchor_text: 'Appel d’offres N°:20/2026 Matériels Réseaux',
  page_title: 'Appel d’offres N°:20/2026 Matériels Réseaux – Ministère des Domaines de l\'Etat et des Affaires foncières',
  text: "Aller au contenu\n\n- Publication publiée :13 juillet 2026\n- Catégorie de la publication : Annonces/ Appel d'offre\n\nFacebook Twitter Email Partager\n\nLe ministère des Domaines de l’Etat et des Affaires Foncières se propose de lancer un appel d’offres en vue de l’acquisition Matériels informatiques, réparti en 9 lots comme suit :\n\n| | | | | | |\n| --- | --- | --- | --- | --- | --- |\n| **Nature** **Des Soumissionnaires** | **Lots** | **LIBELLE** | **TYPES** | **Quantités** | **Montant Caution Provisoire** **En DT** |\n| Toute les Entreprises | Lot Unique | Switch N3 | Type Switch | 2 | 300 |\n\nLes soumissionnaires souhaitant participer à cet appel d’offres, sont invités à télécharger gratuitement le dossier d’appel d’offres en ligne sur le système national des achats publics TUNEPS : **www.tuneps.tn**.\n\nLes offres devront être présentées conformément à l’article 04 des conditions de dépôt des offres, l’envoi des documents administratifs, ainsi que les offres techniques et financières se fait **obligatoirement** à travers le système des achats publics en ligne **TUNEPS**, quant à la caution provisoire et l’extrait du registre du commerce leur envoi se fera à travers la procédure matérielle, ils seront placés dans une enveloppe fermée sur laquelle est indiqué : « **Appel d’offres N°:20/** **2026** **Matériels Réseaux** avec la mention « **A NE PAS OUVRIR** ».\n\nLe pli doit être envoyé par la poste et recommandé ou par rapide poste ou directement au bureau d’ordre central du ministère des Domaines de l’Etat et des Affaires Foncières contre un accusé de réception à l’adresse suivante : **Avenue Mohamed V -1080- Tunis.**\n\nLe dernier délai de remise des offres est fixé **au** **mardi 04 Aout 202** **6** **à** **10h00** ** ** le cachet du bureau d’ordre central faisant foi, la participation à travers la procédure en ligne TUNEPS **s’arrête automatiquement le même jour et à la même heure**. Toute offre parvenue après la date et l’heure limite sera rejetée.\n\n**NB :** les entreprises soumissionnaires doivent maintenir leurs offres valables pendant **120 jours** à partir du lendemain de la date limite de remise des offres.\n\n– Toute offre non parvenue via le système national des achats publics (TUNEPS) sera rejetée." });
const ANS16800 = { title: 'Appel d’offre pour l’acquisition de Matériels informatiques', buyer: 'ministère des Domaines de l’Etat et des Affaires Foncières',
  description: 'Le ministère des Domaines de l’Etat et des Affaires Foncières se propose de lancer un appel d’offre en vue de l’acquisition de Matériels informatiques, réparti en 9 lots comme suit : Lot Unique - Switch N3 - Type Switch - Quantités : 2.',
  publication_date: '13 juillet 2026', deadline: 'mardi 04 Aout 2026 à 10h00', place: 'Avenue Mohamed V -1080- Tunis', country: 'TN' };
C(A3, 'Year split by markdown bold "202** **6" (real)', 'real domainetat page p=16800: "fixé **au** **mardi 04 Aout 202** **6** **à** **10h00**"; real answer deadline "mardi 04 Aout 2026 à 10h00"; 2nd run: the answer copies the cut "mardi 04 Aout 202 6 à 10h00"',
  'deadline proven both times (bold markers out, split year joined for the check); Clean: 2026-08-04, dropped "expired (deadline 2026-08-04)" (was "no deadline")', 'URL5, Clean', async ok => {
    const [t] = await url5(P16800, extractAnswer(ANS16800)), [cut] = await url5(P16800, extractAnswer({ ...ANS16800, deadline: 'mardi 04 Aout 202 6 à 10h00' }));
    ok(t.deadline === 'mardi 04 Aout 2026 à 10h00' && !t.extraction.warnings.includes('deadline_not_in_text_or_incomplete'), 'real answer');
    ok(cut.deadline === 'mardi 04 Aout 2026 à 10h00', 'cut copy');
    const [c] = await clean([t]); ok(c.deadline === '2026-08-04' && c.drop_reason === 'expired (deadline 2026-08-04)', 'Clean');
    return `deadline "${t.deadline}" -> ${c.deadline}, ${c.drop_reason}`;
  });
C(A3, 'Title cut to its reference or replaced by a body sentence (real)', 'real domainetat answers: p=16872 title "Consultation N°28/2026"; p=16800 "Appel d’offre pour l’acquisition de Matériels informatiques" (page title "Appel d’offres N°:20/2026 Matériels Réseaux – Ministère …"); control: francemarches "Projet INNOP\'IA - Phase2 - Missions d\'assistance"',
  'the site\'s own title (page title without " – site name"), with the object and the reference: Clean reference 28/2026 and 20/2026; the francemarches title (its page title has no reference) is kept', 'URL5, Clean', async ok => {
    const p16872 = page({ source: 'domainetat-tn', url: 'https://www.domainetat.tn/?p=16872&lang=fr', anchor_text: 'Consultation N°28/2026 auprès des centres de formation spécialisés dans le domaine Informatique pour réaliser des sessio',
      page_title: 'Consultation N°28/2026 auprès des centres de formation spécialisés dans le domaine Informatique pour réaliser des sessions de formation sur le logiciel : « Les fondamentaux de l’Intelligence Artificielle » – Ministère des Domaines de l\'Etat et des Affaires foncières',
      text: "Aller au contenu\n\n- Publication publiée :20 août 2026\n- Catégorie de la publication : Annonces/ Appel d'offre\n\nFacebook Twitter Email Partager\n\nLe Ministère des Domaines de l’Etat et des Affaires Foncières se propose de lancer une consultation N°28/2026 auprès des centres de formation spécialisés dans le domaine Informatique pour réaliser des sessions de formation sur le logiciel : **« Les fondamentaux de l’Intelligence Artificielle ».**\n\nLes soumissionnaires intéressés à participer à cette consultation sont invité à télécharger gratuitement le dossier de la consultation en ligne sur le système national des achats publics **TUNEPS** : **www.tuneps.tn**\n\n**Le dernier délai** de la remise des offres est fixé au **Vendredi 11 Septembre 2026 à 16h00**, la participation à travers la procédure en ligne TUNEPS s’arrête automatiquement le même jour et à la même heure, toute offre parvenue après la date et l’heure limite sera rejetée." });
    const fm = page({ source: 'francemarches', url: 'https://www.francemarches.com/appel-offre/13joue006176972026-2026-projet-innop-phase2?q=Intelligence%20Artificielle',
      anchor_text: '021 CCI ROUEN METROPOLE Projet INNOP\'IA - Phase2 - Missions d\'assistance Européen Avis d\'attribution Services Procédure',
      page_title: '    Appel d\'offre : Projet INNOP\'IA - Phase2 - Missions d\'assistance - 13/joue/006176972026 - 2026\n',
      text: "Accueil/ Appels d’offres/13joue006176972026\n\nImprimer cet appel d'offres Copier le lien de l’appel d’offre\n\nIntitulé de l'appel d'offre public\nProjet INNOP'IA - Phase2 - Missions d'assistance\n\nLocalisation :\n\nSeine-Maritime (76)\n\nDate de parution :\n\n08/09/2026\n\nEuropéen\n\nAvis d'attribution\n\nServices\n\nProcédure formalisée\n\n# Intitulé de l'appel d'offre public Projet INNOP'IA - Phase2 - Missions d'assistance\n\n## Nom et adresse officiels de l’organisme acheteur public\n\n**CCI ROUEN METROPOLE**\n\n4-20 passage de la Luciline- Bâtiment l'Opensen - CS - 76007 Rouen Cedex 1" });
    const [a] = await url5(p16872, extractAnswer({ title: 'Consultation N°28/2026', buyer: 'Ministère des Domaines de l’Etat et des Affaires Foncières', publication_date: '20 août 2026', deadline: 'Vendredi 11 Septembre 2026 à 16h00', country: 'TN' }));
    const [b] = await url5(P16800, extractAnswer(ANS16800));
    const [f] = await url5(fm, extractAnswer({ title: 'Projet INNOP\'IA - Phase2 - Missions d\'assistance', buyer: 'CCI ROUEN METROPOLE', publication_date: '08/09/2026', notice_type: 'award', country: 'FR' }));
    ok(a.title === p16872.page_title.split(' – ')[0] && b.title === 'Appel d’offres N°:20/2026 Matériels Réseaux', 'site titles');
    ok(f.title === 'Projet INNOP\'IA - Phase2 - Missions d\'assistance' && !f.extraction.warnings.includes('title_from_site_title'), 'control kept');
    const refs = (await clean([a, b])).map(t => t.reference);
    ok(JSON.stringify(refs) === '["28/2026","20/2026"]', 'references'); return `"${a.title.slice(0, 60)}…" / "${b.title}" (references ${refs}); control "${f.title}"`;
  });
// the real notice p=16800 as Firecrawl read it (its "Vous devriez également aimer" block links older notices, not on the list)
const N16800 = 'https://www.domainetat.tn/?p=16800&lang=fr';
const DOM_N16800 = more => scraped(N16800, 'Appel d’offres N°:20/2026 Matériels Réseaux – Ministère des Domaines de l\'Etat et des Affaires foncières', [`[Aller au contenu](${N16800}#main)`, '',
  '- Publication publiée :13 juillet 2026', '- Catégorie de la publication : [Annonces](https://www.domainetat.tn/?cat=9&lang=fr)/ [Appel d\'offre](https://www.domainetat.tn/?cat=19&lang=fr)', '',
  'Le ministère des Domaines de l’Etat et des Affaires Foncières se propose de lancer un appel d’offres en vue de l’acquisition Matériels informatiques, réparti en 9 lots comme suit :', '',
  '### Vous devriez également aimer', '',
  '### [AVIS DE CONSULTATION N° 16/2024 Pour la Réalisation des Sessions de Formation dans le domaine de l’Architecture d’Entreprise : « TOGAF Enterprise Architecture Foundation & Practitioner »](https://www.domainetat.tn/?p=12871&lang=fr)', '', '5 juillet 2024', '',
  '### [Avis de publication appel d’offre N° 06/2022](https://www.domainetat.tn/?p=9158&lang=fr)', '', '3 juin 2022', '', ...more, `[Faire défiler jusqu’en haut de la page](${N16800}#)`]);
const idIn = (result, url) => (result.match(new RegExp(`^\\[([a-z0-9]+)\\] .* \\| ${url.replace(/[.?]/g, '\\$&')}$`, 'm')) || [])[1];

C(A3, 'Notice opened to check it, a notice linked there picked (scoutRun)', 'domainetat list page 1 (recorded open_page result), then the real notice p=16800 opened to check it, whose "Vous devriez également aimer" shows p=12871 (not on the list); picks 6nirv3 (p=16872), 1qvfhuy (p=16800), the p=12871 id, v6azbh (paged=2); list_url written without "www."',
  'p=16872, p=16800 and p=12871 kept (the checked notice is no list page although a pick was first shown on it); only paged=2 dropped; list_url found', 'URL3 (scoutRun)', async ok => {
    const n = await openPage(N16800, DOM_N16800([])), id = idIn(n.result, 'https://www.domainetat.tn/?p=12871&lang=fr');
    const r = await scoutRunOf({ output: JSON.stringify({ tender_links: ['6nirv3', '1qvfhuy', id, 'v6azbh'], list_url: 'https://domainetat.tn/?cat=19&lang=fr' }),
      intermediateSteps: [step('open_page', { url: TASK_DOM.url }, DOM_SEEN1), step('open_page', { url: N16800 }, n.result)] }, TASK_DOM);
    const got = r.picks.map(p => p.url.match(/p=(\d+)/)[1]);
    ok(id && JSON.stringify(got) === '["16872","16800","12871"]' && r.navigation_dropped === 1, 'picks');
    ok(r.list_url === TASK_DOM.url, 'list_url without www');
    return `picks p=${got.join(', p=')} (navigation_dropped ${r.navigation_dropped}); list_url ${r.list_url}`;
  });
C(A3, 'Notice opened to check it has a "Suivant »" post link (scoutRun)', 'domainetat list page 1 (recorded), then the notice p=16800 opened to check it, with a post navigation "[Suivant »](…?p=16380…)" (its NEXT PAGE); picks 1qvfhuy (p=16800) and xyg2k3 (p=16380), both listed on page 1',
  'both kept: the NEXT PAGE of a list page is navigation, the one of a checked notice is the next notice', 'Page Links, URL3 (scoutRun)', async ok => {
    const n = await openPage(N16800, DOM_N16800(['[Suivant »](https://www.domainetat.tn/?p=16380&lang=fr)', '']));
    const r = await scoutRunOf({ output: JSON.stringify({ tender_links: ['1qvfhuy', 'xyg2k3'], list_url: TASK_DOM.url }),
      intermediateSteps: [step('open_page', { url: TASK_DOM.url }, DOM_SEEN1), step('open_page', { url: N16800 }, n.result)] }, TASK_DOM);
    const nxt = (n.result.match(/^NEXT PAGE: (.*)$/m) || [])[1];
    ok(/\| https:\/\/www\.domainetat\.tn\/\?p=16380&lang=fr$/.test(nxt), 'notice NEXT PAGE');
    ok(r.picks.length === 2 && r.navigation_dropped === 0, 'both kept');
    return `notice NEXT PAGE ${nxt}; picks ${r.picks.map(p => p.url.match(/p=\d+/)[0]).join(', ')}`;
  });
C(A3, 'Sort link "Les plus anciens" beside the pager (NEXT PAGE)', 'francemarches page 2 (real shape) with "[Les plus anciens](…&ordre=date-publication-asc)" before "[20 avis de marchés publics suivants](…&page=3)"; the same page as the LAST page (no "suivants" link)',
  'NEXT PAGE = page=3, and "none" on the last page: a sort link has no higher page number', 'Page Links', async ok => {
    const sort = '[Les plus anciens](https://www.francemarches.com/recherche?q=Intelligence%20Artificielle&etat=en-cours&ordre=date-publication-asc)', md = FM_LIST2.data.markdown.split('\n');
    const at = lines => openPage(TASK_FM.other_pages[0], scraped(TASK_FM.other_pages[0], FM_LIST2.data.metadata.title, [md[0], '', sort, ...lines]));
    const nxt = p => (p.result.match(/^NEXT PAGE: (.*)$/m) || [])[1];
    const [mid, last] = [await at(md.slice(1)), await at(md.slice(1).filter(l => !/suivants/.test(l)))];
    ok(/\| https:\/\/www\.francemarches\.com\/recherche\?q=Intelligence%20Artificielle&etat=en-cours&page=3$/.test(nxt(mid)), 'page=3');
    ok(nxt(last) === 'none', 'last page');
    return `${nxt(mid)}; last page: ${nxt(last)}`;
  });
C(A3, 'Source site redirected to another domain (open_page NOTE)', 'START URL www.francemarches.com, Firecrawl lands on www.francemarches.fr (metadata.url) whose links are .fr, the agent picks a .fr notice then opens the .fr page 3; control: "https://domainetat.tn/?cat=19&lang=fr" landing on www.domainetat.tn',
  'page read, .fr links listed with "NOTE: redirected to francemarches.fr …"; the .fr page 3 refused; the picked .fr notice kept; scoutRun.notes holds the NOTE (for Run Summary); no NOTE on a www landing', 'Page Links, Resolve Source, scoutRun', async ok => {
    const fr = u => u.replace(/francemarches\.com/g, 'francemarches.fr'), P3 = fr(TASK_FM.other_pages[0]).replace(/page=2$/, 'page=3');
    const a = await openPage(TASK_FM.url, scraped(fr(TASK_FM.other_pages[0]), FM_LIST2.data.metadata.title, fr(FM_LIST2.data.markdown).split('\n')));
    const b = await openPage(P3, { error: { message: 'Invalid URL: refused:/v2/scrape. URL must start with "http" or "https".' } }), d = await openPage('https://domainetat.tn/?cat=19&lang=fr', DOM_LIST1);
    const note = (a.result.match(/^NOTE: (.*)$/m) || [])[1] || '', id = idIn(a.result, 'https://www.francemarches.fr/appel-offre/13joue006176972026-2026-projet-innop-phase2?q=Intelligence%20Artificielle');
    ok(/^redirected to francemarches\.fr, which is not in the allowedHosts of source "francemarches"/.test(note) && id, 'NOTE, .fr links');
    ok(b.result.startsWith(`PAGE ERROR | ${P3} | refused, no page read: francemarches.fr`) && !/^NOTE:/m.test(d.result) && d.T.source === 'domainetat-tn', 'refusal, control');
    const r = await scoutRunOf({ output: JSON.stringify({ tender_links: [id], list_url: null }), intermediateSteps: [step('open_page', { url: TASK_FM.url }, a.result), step('open_page', { url: P3 }, b.result)] }, TASK_FM);
    ok(JSON.stringify(r.notes) === JSON.stringify([note]) && r.picks.length === 1, 'scoutRun');
    return `NOTE: ${note}; then ${b.result.slice(0, 100)}…`;
  });
C(A3, 'Site title of the notice type only, or with a period (URL5)', 'page title "Avis d’appel d’offres N°12/2026 – Ministère de l’Education", model title "Acquisition de 200 ordinateurs portables pour les écoles primaires" (in the text); page title "Marché de maintenance informatique 01/2026 à 12/2026 – Commune de Testville", model title "Maintenance du parc informatique de la commune"; Arabic page title "طلب عروض عدد 05/2026 لاقتناء معدات إعلامية – …", model title "اقتناء معدات إعلامية"',
  'the first two model titles kept (a site title of notice type + reference + buyer says no object; "01/2026 à 12/2026" is a period, no reference); the Arabic one replaced by the site title (reference after "عدد", Clean reference 5/2026)', 'URL5, Clean', async ok => {
    const t1 = 'Acquisition de 200 ordinateurs portables pour les écoles primaires', t2 = 'Maintenance du parc informatique de la commune', ar = 'طلب عروض عدد 05/2026 لاقتناء معدات إعلامية';
    const [a] = await url5(page({ page_title: 'Avis d’appel d’offres N°12/2026 – Ministère de l’Education', anchor_text: 'Avis d’appel d’offres N°12/2026',
      text: '# Avis d’appel d’offres N°12/2026\n\nLe Ministère de l’Education lance un appel d’offres national pour l’acquisition de 200 ordinateurs portables pour les écoles primaires.\n\nDate limite de remise des offres : 15 novembre 2026 à 10h00.' }),
      extractAnswer({ title: t1, buyer: 'Ministère de l’Education', deadline: '15 novembre 2026 à 10h00' }));
    const [b] = await url5(page({ page_title: 'Marché de maintenance informatique 01/2026 à 12/2026 – Commune de Testville', anchor_text: 'Marché de maintenance informatique 01/2026 à 12/2026',
      text: '# Marché de maintenance informatique 01/2026 à 12/2026\n\nLa Commune de Testville lance une consultation pour la maintenance du parc informatique de la commune, de 01/2026 à 12/2026.\n\nDate limite de remise des offres : 15 novembre 2026 à 12h00.' }),
      extractAnswer({ title: t2, buyer: 'Commune de Testville', deadline: '15 novembre 2026 à 12h00' }));
    const [c] = await url5(page({ source: 'domainetat-tn', page_title: `${ar} – وزارة أملاك الدولة والشؤون العقارية`, anchor_text: ar, language: 'ar',
      text: `# ${ar}\n\nتعتزم وزارة أملاك الدولة والشؤون العقارية اقتناء معدات إعلامية عبر منظومة الشراءات العمومية على الخط تونبس.\n\nآخر أجل لقبول العروض: 15 نوفمبر 2026.` }),
      extractAnswer({ title: 'اقتناء معدات إعلامية', buyer: 'وزارة أملاك الدولة والشؤون العقارية', deadline: '15 نوفمبر 2026', language: 'ar' }));
    const site = w => w.extraction.warnings.includes('title_from_site_title');
    ok(a.title === t1 && !site(a), 'notice type only');
    ok(b.title === t2 && !site(b), 'period');
    const [cc] = await clean([c]);
    ok(c.title === ar && site(c) && cc.reference === '5/2026', 'Arabic reference');
    return `"${a.title}" / "${b.title}" kept; "${c.title}" (reference ${cc.reference})`;
  });

// ---- URL lane, run 2 of 2026-10-20 (round-2 fixes in): the francemarches agent sent its mistyped START URL and page 2 at once, got
// "refused", then read page 2 again written with %20 (PAGE [o7gorv]) and never page 1; the extract LLM typed the RESAH result "award"
const FM_P2_20 = TASK_FM.other_pages[0].replace('Intelligence+Artificielle', 'Intelligence%20Artificielle');
const FM_SEEN2_20 = FM_SEEN2.replace(`PAGE [bld29b] | ${TASK_FM.other_pages[0]} |`, `PAGE [o7gorv] | ${FM_P2_20} |`);
const fmRefusalRun = refusal => ({ output: JSON.stringify({ tender_links: ['we362f', '1rt4du7', 'odmndd'], list_url: FM_P2_20 }),
  intermediateSteps: [step('open_page', { url: FM_TYPO }, refusal), step('open_page', { url: TASK_FM.other_pages[0] }, FM_SEEN2), step('open_page', { url: FM_P2_20 }, FM_SEEN2_20)] });
C(A1, 'Award notice the extract LLM typed "award" itself (real RESAH page, run 2)', 'GIP RESAH 26-87830 result notice ("Type de formulaire:Résultats", "Date à laquelle le lauréat a été choisi:19/08/2026"); the run-2 answer: notice_type award, deadline 19/08/2026, publication 11/09/2026; control: the same answer without publication date nor description',
  'notice_type award, deadline and rectified_deadline null, warning deadline_dropped_award_notice (no notice_type_from_page_label: the LLM said award); Clean: no effective deadline, dropped "award notice" (the export row has no award date as deadline); the control stays an award notice (its award date still proves a notice), never "not a notice"', 'URL5, Clean', async ok => {
    const base = page({ source: 'francemarches', url: 'https://www.francemarches.com/appel-offre/3boamp2687830-2026-acquisition-plateforme-innovante?q=Intelligence%20Artificielle', text: RESAH_AWARD,
      anchor_text: '022 GIP RESAH Acquisition d\'une plateforme innovante de services d\'intelligence artificielle générative multi-modèles Eu' });
    const [t] = await url5(base, extractAnswer({ ...RESAH_EXTRACT, notice_type: 'award', place: 'France', country: 'FR' }));
    const [bare] = await url5(base, extractAnswer({ title: RESAH_EXTRACT.title, buyer: 'GIP RESAH', deadline: '19/08/2026', notice_type: 'award' }));
    const w = t.extraction.warnings;
    ok(t.notice_type === 'award' && t.deadline === null && t.rectified_deadline === null && t.publication_date === '11/09/2026' && w.includes('deadline_dropped_award_notice') && !w.includes('notice_type_from_page_label'), 'award, no deadline');
    const [c, cb] = await clean([t, { ...bare, tender_id: 'Tbare', canonical_id: 'url:bare' }]);
    ok(c.drop_reason === 'award notice' && !c.effective_deadline && !c.deadline, 'Clean: award notice, no date');
    ok(!bare._type && bare.notice_type === 'award' && bare.deadline === null && cb.drop_reason === 'award notice', 'control: still a notice');
    return `notice_type ${t.notice_type}, deadline ${t.deadline}, warnings ${w.join(', ')} -> ${c.drop_reason} (effective_deadline ${c.effective_deadline}); control ${bare._type || bare.notice_type} -> ${cb.drop_reason}`;
  });
C(A3, 'Refused host: the refusal names the URL to open (real typo, run 2)', 'the run-2 call "https://www.franc-than.com/recherche?q=Intelligence+Artificielle&etat=en-cours" (the START URL on a mistyped host); that typo on page 2; with the 2 run-2 sources: "https://www.francemarche.fr/", "https://www.domaine-etat.tn/?p=16872&lang=fr" (close hosts, other paths), "https://www.marchespublics.gov.tn/fr/avis/123" (the real Tunisian portal, closer to "francemarches" by name than the typo), "https://www.marches-publics.gouv.fr/?page=Entreprise.EntrepriseAdvancedSearch&AllCons", "https://www.example.org/appels-offres"; the close hosts with their source alone; "https://www.francemarche.fr/" next to a source whose url is a home page',
  'still refused before Firecrawl, now "open <the exact START URL> instead: the START URL of francemarches, copied exactly"; page 2: that page on www.francemarches.com; several sources and only the host name to go on: no source named (Resolve Source cannot know which source the agent works on: a domainetat-tn scout must never be sent to francemarches), the old advice; one source: its START URL; a bare "/" never names the home-page source', 'Resolve Source, Known source?, Page Links', async ok => {
    const ifNode = SCOUT_TOOLS.nodes.find(n => n.name === 'Known source?');
    const known = T => new Function('$json', `return (${ifNode.parameters.conditions.conditions[0].leftValue.replace(/^=\{\{\s*|\s*\}\}$/g, '')});`)(T);
    const hostOnly = ['https://www.francemarche.fr/', 'https://www.domaine-etat.tn/?p=16872&lang=fr', 'https://www.marchespublics.gov.tn/fr/avis/123',
      'https://www.marches-publics.gouv.fr/?page=Entreprise.EntrepriseAdvancedSearch&AllCons', 'https://www.example.org/appels-offres'];
    const [a, p2, ...others] = await Promise.all([FM_TYPO, `${FM_TYPO}&page=2`, ...hostOnly].map(u => openPage(u, {})));
    const why = x => x.result.split(' | ').slice(2).join(' | ');
    ok([a, p2, ...others].every(x => x.T.source === null && known(x.T) === false && /^refused, no page read: /.test(why(x))), 'all refused, no Firecrawl call');
    ok(why(a) === `refused, no page read: franc-than.com is not a site of the configured sources (open ${TASK_FM.url} instead: the START URL of francemarches, copied exactly; other hosts go in Config allowedHosts)`, 'START URL named');
    ok(why(p2).includes(`(open ${TASK_FM.other_pages[0]} instead: that page on the site of francemarches;`), 'page 2 on the right host');
    ok(others.every(x => why(x).includes('(open the START URL exactly as written, or a URL from an earlier open_page result;') && !/francemarches|domainetat/.test(why(x))), 'several sources, host name only: no source named');
    // one source: the agent can only be working on it, so its START URL is named whatever the host
    const alone = async (i, url) => (await scoutTool('Resolve Source', { tool: 'open_page', firecrawl_base: 'https://api.firecrawl.dev', url_sources: JSON.stringify([JSON.parse(URL_SOURCES)[i]]), max_links: '100', url })).refused;
    const [fr1, dom1] = [await alone(0, hostOnly[0]), await alone(1, hostOnly[1])];
    ok(fr1.includes(`the START URL of francemarches is ${TASK_FM.url}:`) && dom1.includes(`the START URL of domainetat-tn is ${TASK_DOM.url}:`), 'one source: its START URL');
    // a source whose url is a home page: a mistyped home page of ANOTHER source is not "its START URL on another host"
    const homeSources = JSON.stringify([JSON.parse(URL_SOURCES)[0], { name: 'portail', url: 'https://www.portail-achats.org/', allowedHosts: [], only_main: true }]);
    const home = (await scoutTool('Resolve Source', { tool: 'open_page', firecrawl_base: 'https://api.firecrawl.dev', url_sources: homeSources, max_links: '100', url: 'https://www.francemarche.fr/' })).refused;
    ok(home.includes('(open the START URL exactly as written,') && !/portail|francemarches/.test(home), 'home page: no source named');
    const named = s => (s.match(/\((open \S+ instead: [^;]+|the START URL of \S+ is \S+)/) || [])[1] || 'no source named';
    return `franc-than.com: ${named(why(a))}; page 2: ${named(why(p2)).replace(/^open (\S+) .*$/, '$1')}; ${others.map(x => `${x.T.url.split('/')[2]}: ${named(why(x))}`).join('; ')}; alone: ${named(fr1)}, ${named(dom1)}; francemarche.fr with a home-page source: ${named(home)}`;
  });
C(A3, 'The same list page read twice, "+" then "%20" (scoutRun, run 2)', 'the run-2 francemarches agent: the refused typo, page 2 as "q=Intelligence+Artificielle" (PAGE [bld29b]), page 2 again as "q=Intelligence%20Artificielle" (PAGE [o7gorv]); control: the run-2 domainetat agent ("?cat=19&lang=-fr" landing on page 1, then page 2 landing on "?cat=19&paged=2&lang=fr")',
  'scoutRun.reread names the %20 page 2 (one Firecrawl credit wasted: open_page keeps no memory of its calls), for a Run Summary hint; none for domainetat; picks and not_opened as before (the START URL never opened)', 'URL3 (scoutRun)', async ok => {
    const refusal = (await openPage(FM_TYPO, {})).result;
    const [f, d] = [await scoutRunOf(fmRefusalRun(refusal), TASK_FM), await scoutRunOf(DOM_AGENT, TASK_DOM)];
    ok(JSON.stringify(f.reread) === JSON.stringify([FM_P2_20]) && JSON.stringify(d.reread) === '[]', 'reread');
    ok(f.picks.length === 3 && JSON.stringify(f.not_opened) === JSON.stringify([TASK_FM.url]) && d.not_opened.length === 0, 'picks, not_opened');
    return `francemarches reread ${f.reread.join(', ')} (picks ${f.picks.length}, not_opened ${f.not_opened.length}); domainetat reread ${d.reread.length}`;
  });
C(A3, 'Firecrawl pace after refused open_page calls (run 2)', 'the run-2 scouts: francemarches 3 open_page calls (the refused "www.franc-than.com" one took 155 ms, no Firecrawl call; page 2 twice) + domainetat 2 = 4 scrapes, then 10 detail scrapes; 9 open_page calls of which 1 refused; control: 9 real scrapes',
  'only calls that reached Firecrawl count: run 2: detail item 5 waits 35 s (item 4 no longer 41.5 s); 8 scrapes + 1 refused: no 61 s Firecrawl Pace, detail item 1 waits 61 s; 9 real scrapes: Pace 61 s as before; never more than 10 calls in any 60 s', 'Firecrawl Pace, Firecrawl Detail (options)', async ok => {
    const expr = p => p.replace(/^=\{\{\s*|\s*\}\}$/g, ''), pace = expr(wf.nodes.find(n => n.name === 'Firecrawl Pace').parameters.amount);
    const interval = expr(wf.nodes.find(n => n.name === 'Firecrawl Detail').parameters.options.batching.batch.batchInterval);
    const scouts = agents => n => ({ first: () => ({ json: CFG }), all: () => (n === 'Tender Scout Agent' ? agents : []).map(json => ({ json })) });
    const refusal = (await openPage(FM_TYPO, {})).result, typo = step('open_page', { url: FM_TYPO }, refusal);
    const lists = n => Array.from({ length: n }, (_, k) => step('open_page', { url: `${FM_LIST}&page=${k + 1}` }, listPage(`p${k}`, `${FM_LIST}&page=${k + 1}`, 'Appels d\'offres', [])));
    // the detail calls' start times (Firecrawl Pace first), and the most Firecrawl calls in any 60 s with the scrapes all at 0 (worst case)
    const plan = (agents, scrapes) => { const $ = scouts(agents), at = [new Function('$', `return (${pace});`)($) * 1000];
      for (let i = 1; i < 10; i++) at.push(at[i - 1] + new Function('$', '$itemIndex', `return (${interval});`)($, i));
      const calls = [...Array(scrapes).fill(0), ...at]; return { at, worst: Math.max(...at.map(t => calls.filter(x => x > t - 60000 && x <= t).length)) }; };
    const run2 = plan([fmRefusalRun(refusal), DOM_AGENT], 4), mixed = plan([scoutAnswer([], [typo, ...lists(8)])], 8), full = plan([scoutAnswer([], lists(9))], 9);
    const gaps = p => p.at.map((x, i) => (i ? x - p.at[i - 1] : x));
    ok(JSON.stringify(gaps(run2)) === JSON.stringify([0, 6500, 6500, 6500, 6500, 35000, 6500, 6500, 6500, 6500]), 'run 2: item 5 waits 35 s');
    ok(mixed.at[0] === 0 && gaps(mixed)[1] === 61000 && full.at[0] === 61000, 'refused call: no 61 s Pace; control 61 s');
    ok([run2, mixed, full].every(p => p.worst <= 10), 'within the budget');
    return `run 2 detail gaps ${gaps(run2).map(x => x / 1000).join(' ')} s; 8 + 1 refused: Pace ${mixed.at[0] / 1000} s, item 1 +${gaps(mixed)[1] / 1000} s; 9 real: Pace ${full.at[0] / 1000} s; at most ${Math.max(run2.worst, mixed.worst, full.worst)} calls in any 60 s`;
  });

// ======================= 4. missing internal references (Join RAG, Build Proposal Input) =======================
C(A4, 'RAG returns nothing', 'RAG answers {} (HTTP 200, no matrix) for 4 verified requirements; also {requirements_matrix: [], warnings: ["index not ready"]}',
  'a RAG fault, not "nothing covered": rag.status error, warning "RAG returned an empty matrix" (the RAG\'s own warning kept); proposal input: review (never no_bid), every row coverage unknown, the reason names the fault; Run Summary counts a failed RAG call', 'RG2, PR1, EX2', async ok => {
    const r = await joinRag(ragTender(), {});
    ok(r.rag.status === 'error' && r.rag.matrix.length === 0 && r.rag.warnings[0] === 'RAG returned an empty matrix', 'error');
    const p = await proposal(r);
    ok(p.matrix.summary.recommendation === 'review' && p.matrix.status === 'ERROR' && p.matrix.rows.length === 4 && p.matrix.rows.every(x => x.coverage === 'unknown')
      && /no requirements matrix \(error: RAG returned an empty matrix\)/.test(p.matrix.summary.recommendation_reason), 'review');
    const e = await joinRag(ragTender(), { requirements_matrix: [], warnings: ['index not ready'] });
    ok(e.rag.status === 'error' && JSON.stringify(e.rag.warnings) === '["RAG returned an empty matrix","index not ready"]', 'empty matrix + warning');
    const [s] = await run('Run Summary', [{}], { '00 - Config': [{ ...CFG, sources: [] }], 'Call RAG': [{}, ragAnswer(statuses('covered', 'covered', 'covered', 'covered'))] });
    ok(s.failed_calls['RAG calls'] === 1 && s.has_warnings, 'failed call counted');
    return `rag ${r.rag.status}, warnings [${r.rag.warnings.join(' | ')}], recommendation ${p.matrix.summary.recommendation} (${p.matrix.summary.recommendation_reason}); Run Summary RAG calls failed ${s.failed_calls['RAG calls']}`;
  });
C(A4, 'RAG returns fewer rows', 'RAG answers 2 of 4 requirements (R1, R2 covered)', 'R3, R4 missing (not_returned) + warning "RAG answered 2 of 4"; coverage 0.5; blocking = R3 (mandatory)', 'RG2, PR1', async ok => {
  const r = await joinRag(ragTender(), ragAnswer(statuses('covered', 'covered')));
  const lost = r.rag.matrix.filter(m => m.status_source === 'not_returned').map(m => m.requirement_id);
  ok(JSON.stringify(lost) === '["R3","R4"]' && r.rag.warnings.includes('RAG answered 2 of 4 requirements') && r.rag.coverage === 0.5, 'not returned = missing');
  ok(r.rag.blocking.length === 1 && r.rag.blocking[0].startsWith('R3'), 'blocking R3');
  const p = await proposal(r); ok(p.matrix.summary.recommendation === 'bid_with_partner', 'bid_with_partner');
  return `not returned ${lost}, coverage ${r.rag.coverage}, blocking ${r.rag.blocking.map(b => b.slice(0, 2))}, recommendation ${p.matrix.summary.recommendation}`;
});
C(A4, 'RAG call error', 'HTTP error item {error: {message: "connect ECONNREFUSED 127.0.0.1:8001"}}',
  'rag.status error + warning; proposal input: recommendation review, rag ERROR, every row coverage unknown, risk "No requirements matrix"', 'RG2, PR1', async ok => {
    const r = await joinRag(ragTender(), { error: { message: 'connect ECONNREFUSED 127.0.0.1:8001' } });
    ok(r.rag.status === 'error' && /RAG call failed: connect ECONNREFUSED/.test(r.rag.warnings[0]), 'error');
    const p = await proposal(r);
    ok(p.matrix.summary.recommendation === 'review' && p.rag.status === 'ERROR' && p.matrix.status === 'ERROR' && p.matrix.rows.every(x => x.coverage === 'unknown')
      && p.analysis.risks.some(x => /No requirements matrix \(error\)/.test(x)), 'review');
    return `rag ${r.rag.status}, recommendation ${p.matrix.summary.recommendation} (${p.matrix.summary.recommendation_reason})`;
  });
C(A4, 'All requirements missing', 'RAG answers the 4 rows with status missing and a closest document', 'coverage 0, blocking R1 + R3, closest docs kept as leads; proposal: no_bid, rag NONE', 'RG2, PR1', async ok => {
  const r = await joinRag(ragTender(), ragAnswer(statuses('missing', 'missing', 'missing', 'missing')));
  ok(r.rag.coverage === 0 && r.rag.mandatory_missing === 2 && r.rag.blocking.map(b => b.slice(0, 2)).join() === 'R1,R3' && r.rag.matrix.every(m => m.closest && m.closest.doc_id), 'all missing');
  const p = await proposal(r); ok(p.matrix.summary.recommendation === 'no_bid' && p.rag.status === 'NONE' && p.matrix.rows[0].closest_asset.asset_id === 'project_old_portal.md', 'no_bid');
  return `coverage ${r.rag.coverage}, blocking ${r.rag.blocking.map(b => b.slice(0, 2))}, recommendation ${p.matrix.summary.recommendation}`;
});
C(A4, 'Mandatory non-technical gap', 'R1, R2 covered; R3 (mandatory experience) missing; R4 (team, optional) partial; RAG warning "BLOCKING - …"',
  'blocking = R3 only (our mandatory flags, not the RAG\'s "every row mandatory"); RAG warning kept; recommendation bid_with_partner', 'RG2, PR1', async ok => {
    const r = await joinRag(ragTender(), ragAnswer(statuses('covered', 'covered', 'missing', 'partial'), { warnings: ['BLOCKING - mandatory requirement without evidence: At least 2 references'] }));
    ok(r.rag.blocking.length === 1 && r.rag.blocking[0].startsWith('R3') && r.rag.warnings.some(w => /^BLOCKING/.test(w)), 'blocking R3');
    const p = await proposal(r); ok(p.matrix.summary.recommendation === 'bid_with_partner', 'bid_with_partner');
    return `blocking ${r.rag.blocking.map(b => b.slice(0, 2))}, recommendation ${p.matrix.summary.recommendation} (${p.matrix.summary.recommendation_reason})`;
  });
C(A4, 'Non-mandatory technical gap', 'R2 (technical, not mandatory) missing, the others covered', 'blocking empty; recommendation review (a technical gap is checked by a person)', 'RG2, PR1', async ok => {
  const r = await joinRag(ragTender(), ragAnswer(statuses('covered', 'missing', 'covered', 'covered')));
  ok(r.rag.blocking.length === 0 && r.rag.mandatory_missing === 0, 'not blocking');
  const p = await proposal(r); ok(p.matrix.summary.recommendation === 'review', 'review');
  return `blocking [${r.rag.blocking}], recommendation ${p.matrix.summary.recommendation}`;
});
C(A4, 'Mandatory technical gap', 'R1 (mandatory technical) missing, R2 partial (technical coverage 0.25), R3 R4 covered', 'blocking R1; recommendation no_bid', 'RG2, PR1', async ok => {
  const r = await joinRag(ragTender(), ragAnswer(statuses('missing', 'partial', 'covered', 'covered')));
  const p = await proposal(r);
  ok(r.rag.blocking.length === 1 && r.rag.blocking[0].startsWith('R1') && p.matrix.summary.recommendation === 'no_bid', 'no_bid');
  return `blocking ${r.rag.blocking.map(b => b.slice(0, 2))}, recommendation ${p.matrix.summary.recommendation} (${p.matrix.summary.recommendation_reason})`;
});
C(A4, 'Everything covered (control)', 'RAG answers the 4 rows covered', 'recommendation bid, rag FULL, relevance 100, proof documents listed', 'RG2, PR1', async ok => {
  const r = await joinRag(ragTender(), ragAnswer(statuses('covered', 'covered', 'covered', 'covered')));
  const p = await proposal(r);
  ok(p.matrix.summary.recommendation === 'bid' && p.rag.status === 'FULL' && p.analysis.relevance_score === 100 && r.rag.best_docs.length === 4, 'bid');
  return `recommendation ${p.matrix.summary.recommendation}, rag ${p.rag.status}, relevance ${p.analysis.relevance_score}`;
});
C(A4, 'RAG v2: CV quote, company declaration, demo record, team and gaps', 'RAG answer (format of 2026-10-20): R1 proved by a CV quote, R2 by a company record (statement, no quote), R3 by a FICTIONAL demo record, R4 missing; team_proposal with 1 unfilled place; knowledge_gaps for R4',
  'each row keeps its origin; the declaration is shown as a declaration (never as a quote); the demo row is listed in demo_evidence and raises a risk; team proposal and gaps reach the proposal input with our requirement ids', 'RG2, PR1', async ok => {
    const st = 'Name: Citizen app platform\nDescription: Built and hosts the citizen app of three municipalities.\nSector: public';
    const rows = [ragRow(REQS[0], 'covered', { origin: 'cv_document' }), ragRow(REQS[1], 'covered', { origin: 'user_entered', evidence: null, statement: st }),
      ragRow(REQS[2], 'covered', { origin: 'demo', evidence: null, statement: 'Name: Ministry portal\nDescription: Fictional licensing portal for a ministry.' }), ragRow(REQS[3], 'missing')];
    const r = await joinRag(ragTender(), ragAnswer(rows, { data_mode: 'demo', coverage_basis: 'Recorded capabilities; declarations are not verified document evidence.',
      team_proposal: { size: 0, members: [], unfilled: [{ requirement: REQS[3].text, needed: 1, available: 0, mandatory: false }], places_filled: 0, places_needed: 1, notes: [] },
      knowledge_gaps: [{ requirement: REQS[3].text, category: 'team', status: 'missing', mandatory: false, kind: 'people', gap: 'No CV with the role project manager.', suggestion: 'Add a CV.' }] }));
    const p = await proposal(r);
    const row = id => p.matrix.rows.find(x => x.requirement_id === id);
    ok(row('R1').origin === 'cv_document' && row('R1').justification_kind === 'document_quote', 'CV quote');
    ok(row('R2').origin === 'user_entered' && row('R2').justification_kind === 'declaration' && /three municipalities/.test(row('R2').justification) && !/^Name:/.test(row('R2').justification), 'declaration');
    ok(row('R3').origin === 'demo' && p.matrix.summary.demo_evidence.join() === 'R3' && p.analysis.risks.some(x => /FICTIONAL/.test(x)), 'demo flagged');
    ok(p.rag.data_mode === 'demo' && p.rag.team_proposal.unfilled[0].requirement_id === 'R4' && p.matrix.summary.knowledge_gaps[0].requirement_id === 'R4', 'team + gaps mapped');
    return `R1 ${row('R1').justification_kind}, R2 ${row('R2').justification_kind}, R3 ${row('R3').origin}; demo_evidence ${p.matrix.summary.demo_evidence}; unfilled ${p.rag.team_proposal.unfilled.map(u => u.requirement_id)}; gaps ${p.matrix.summary.knowledge_gaps.map(g => g.requirement_id)}`;
  });
C(A4, 'Rows without a status', 'RAG rows with no status; reranker scores 2.5 / 0.4 / -3 / no match', 'status from Config thresholds: covered / partial / missing / missing (status_source reranker_threshold)', 'RG2', async ok => {
  const match = (r, s) => ({ requirement: r.text, matches: s == null ? [] : [{ doc_id: `doc_${r.id}`, type: 'project', summary: 'A past project', rerank_score: s, evidence: { quote: 'Built a mobile app for a city of 40,000 people.' } }] });
  const rows = REQS.map(r => ({ requirement: r.text, category: r.category }));
  const r = await joinRag(ragTender(), ragAnswer(rows, { requirement_matches: [match(REQS[0], 2.5), match(REQS[1], 0.4), match(REQS[2], -3), match(REQS[3], null)] }));
  const got = r.rag.matrix.map(m => m.status);
  ok(got.join() === 'covered,partial,missing,missing' && r.rag.matrix.every(m => m.status_source === 'reranker_threshold'), 'thresholds');
  return got.join(', ');
});
C(A4, 'Evidence is only a header line', 'R1 covered with evidence "## Projects:"', 'kept, with warning "evidence … is only a header line"', 'RG2', async ok => {
  const rows = statuses('covered', 'covered', 'covered', 'covered'); rows[0].evidence = '## Projects:';
  const r = await joinRag(ragTender(), ragAnswer(rows));
  ok(r.rag.warnings.some(w => /is only a header line/.test(w)), 'warning'); return r.rag.warnings.join(' | ');
});
// RAG v2 answers recorded on 2026-10-20 (data_mode demo): real requirement lines, documents, quotes, scores and rule hits (matched_on)
const v2Tender = reqs => ragTender({ requirements: { items: reqs.map(([id, category, text, quote, mandatory = true]) => ({ id, category, text, rag_text: text, quote, mandatory })), dropped: [], low_input: false } });
const v2Row = (requirement, category, status, o = {}) => ({ requirement, category, mandatory: true, status, found: null, needed: 1, method: 'rules', best_doc: null, evidence: null, closest_doc: null, origin: null, statement: null, ...o });
const v2Match = (doc_id, origin, rerank_score, matched_on, text) => ({ doc_id, type: origin === 'cv_document' ? 'cv' : 'past_project', title: doc_id, origin, rerank_score, matched_on, summary: '',
  evidence: origin === 'cv_document' ? { kind: 'document_quote', quote: text, line: 1 } : { kind: origin === 'demo' ? 'demo_statement' : 'declaration', quote: null, statement: text } });
const DEMO_ST = { web: 'Name: OliveSoft Public-Sector Web Stack\nDescription: OliveSoft\'s standard public-sector stack: React, Spring Boot, PostgreSQL, AWS, ISO 27001-aligned delivery process.\nTechnologies: angular, aws, azure, ci/cd, docker, java, javascript, kubernetes, node.js, postgresql, react, rest api, spring',
  licensing: 'Name: Ministry of Interior - Digital Licensing Portal (2023)\nDescription: Digital licensing and compliance tracking platform delivered for a government ministry, React + Spring Boot + PostgreSQL, 5 month delivery.\nSector: public',
  dataAi: 'Name: OliveSoft Data and AI Stack\nDescription: Data and AI offering: Python, Airflow, Power BI dashboards, LLMs, RAG and vector databases.',
  security: 'Name: Public Agency - Security Software Procurement (2022)\nDescription: Supply and deployment of IT security software (antivirus, EDR, firewall management) for a public agency.',
  health: 'Name: National Health Analytics Dashboard (2024)\nDescription: Public health KPI dashboard for a national agency, Power BI and Airflow pipelines on Azure.',
  chatbot: 'Name: Telecom Operator - RAG Customer Service Chatbot (2024)\nDescription: Generative AI chatbot using RAG over product documents for a telecom operator, French and Arabic.' };
C(A4, 'RAG v2 demo mode: real CV proof behind demo records (real)', 'T1wp05cp / T1vv1c9s answers: "React or Angular frontend" and "PostgreSQL" with 2 demo records listed first + a CV matched on the skill (CV_11 / CV_02, 3rd, no reranker score); "2+ public sector digital projects" only demo records; "1 deployed AI chatbot reference": a demo record (rerank -0.463) + 2 CVs matched on nothing (-3.888 / -4.078); variants: 1 real project for "2+", 1 CV quote (CV_11, matched on "public sector") for "2+"',
  'every proof document kept (3 per row, real proof first), the weak CVs flagged proves:false (asset weak_for, not suggested), the partial chatbot row\'s own demo record too (matched on nothing, below rerankPartial: proof_weak, justification_weak); the CV rows take the CV quote / origin / best_doc and leave demo_evidence (= the 2 demo-only rows); weak CVs do not clear a demo row, nor 1 real proof when 2 are needed, and then quote / origin / best_doc stay the demo record\'s (never a CV line under a demo origin); proposal: CV quote as justification, FICTIONAL risk and reason name only the demo-only rows', 'RG2, PR1', async ok => {
    const qT = 'le frontend doit être développé en React ou Angular. Le backend doit être réalisé en Node.js ou Java/Spring. La base de données doit être PostgreSQL. La plateforme doit exposer une API REST. L\'hébergement doit être assuré sur un cloud AWS ou Azure.';
    const t = v2Tender([['R1', 'technical', 'React or Angular frontend', qT], ['R2', 'technical', 'PostgreSQL', qT],
      ['R3', 'experience', '2+ public sector digital projects', 'le soumissionnaire doit justifier d\'au moins 2 projets numériques similaires dans le secteur public.'],
      ['R4', 'experience', '1 deployed AI chatbot reference', 'le soumissionnaire doit présenter au moins 1 référence de chatbot ou d\'assistant IA déjà déployé']]);
    const rows = [v2Row('React or Angular frontend', 'technical', 'covered', { found: 7, best_doc: 'demo_TechStack_PublicSector_Cloud', origin: 'demo', statement: DEMO_ST.web }),
      v2Row('PostgreSQL', 'technical', 'covered', { found: 10, best_doc: 'demo_TechStack_PublicSector_Cloud', origin: 'demo', statement: DEMO_ST.web }),
      v2Row('2+ public sector digital projects', 'experience', 'covered', { found: 6, needed: 2, best_doc: 'demo_Project_MinistryInterior_LicensingPortal', origin: 'demo', statement: DEMO_ST.licensing }),
      v2Row('1 deployed AI chatbot reference', 'experience', 'partial', { found: 3, method: 'reranker', best_doc: 'demo_Project_Telecom_RAGChatbot', origin: 'demo', statement: DEMO_ST.chatbot })];
    const matches = [{ requirement: 'React or Angular frontend', matches: [v2Match('demo_TechStack_PublicSector_Cloud', 'demo', null, ['react', 'angular'], DEMO_ST.web),
      v2Match('demo_Project_MinistryInterior_LicensingPortal', 'demo', null, ['react'], DEMO_ST.licensing),
      v2Match('CV_11_Chloe_Martin.pdf', 'cv_document', null, ['react'], 'Developed a responsive web portal using React, Node.js and PostgreSQL that served 1 200+ internal users.')] },
    { requirement: 'PostgreSQL', matches: [v2Match('demo_TechStack_PublicSector_Cloud', 'demo', null, ['postgresql'], DEMO_ST.web), v2Match('demo_TechStack_Data_AI', 'demo', null, ['postgresql'], DEMO_ST.dataAi),
      v2Match('CV_02_Liam_Carter.pdf', 'cv_document', null, ['postgresql'], 'Databases: MySQL, phpMyAdmin, PostgreSQL')] },
    { requirement: '2+ public sector digital projects', matches: [v2Match('demo_Project_MinistryInterior_LicensingPortal', 'demo', null, ['public sector'], DEMO_ST.licensing),
      v2Match('demo_Project_PublicAgency_SecuritySoftware', 'demo', null, ['public sector'], DEMO_ST.security), v2Match('demo_Project_HealthAnalytics_Dashboard', 'demo', null, ['public sector'], DEMO_ST.health)] },
    { requirement: '1 deployed AI chatbot reference', matches: [v2Match('demo_Project_Telecom_RAGChatbot', 'demo', -0.463, [], DEMO_ST.chatbot),
      v2Match('CV_03_Maya_Patel.pdf', 'cv_document', -3.888, [], 'Deployed a Triton Inference Server on Knative, enabling autoscaling up to 10 replicas and zero-downtime releases.'),
      v2Match('CV_12_Mateo_Silva.pdf', 'cv_document', -4.078, [], 'Designed and deployed an AI agent that generated social-media content, reducing copy-writing effort by 40 % for 30+')] }];
    const r = await joinRag(t, ragAnswer(rows, { requirement_matches: matches, data_mode: 'demo', warnings: ['DEMO - Fictional records are included. These are not company references.'] }));
    const m = id => r.rag.matrix.find(x => x.requirement_id === id);
    ok(r.rag.matrix.every(x => x.evidence.length === 3), 'every proof kept');
    ok(m('R1').origin === 'cv_document' && m('R1').best_doc === 'CV_11_Chloe_Martin.pdf' && /React, Node\.js and PostgreSQL/.test(m('R1').best_quote) && !m('R1').statement
      && m('R1').evidence[0].doc_id === 'CV_11_Chloe_Martin.pdf' && m('R2').origin === 'cv_document' && m('R2').best_doc === 'CV_02_Liam_Carter.pdf', 'real proof first');
    ok(r.rag.demo_evidence.join() === 'R3,R4' && m('R4').origin === 'demo' && m('R4').evidence[0].origin === 'demo', 'demo only = no real proof');
    const p = await proposal(r), row = id => p.matrix.rows.find(x => x.requirement_id === id);
    ok(row('R1').justification_kind === 'document_quote' && /React, Node\.js/.test(row('R1').justification) && row('R1').evidence.length === 3 && row('R1').evidence[0].origin === 'cv_document', 'proposal: CV quote');
    ok(p.analysis.risks.includes('Proof from FICTIONAL demo records (not company references): R3, R4') && /proof from fictional demo records only: R3, R4$/.test(p.matrix.summary.recommendation_reason), 'risk + reason');
    const m2 = clone(matches); m2[2].matches[1] = v2Match('olivesoft_Project_PIPL_CRM', 'user_entered', null, ['public sector'], 'Name: PIPL CRM\nDescription: CRM project for a public body.');
    const r2 = await joinRag(t, ragAnswer(rows, { requirement_matches: m2, data_mode: 'demo' }));
    ok(r2.rag.demo_evidence.join() === 'R3,R4', '1 real of 2 needed: still demo');
    // weak neighbours: kept, flagged, never a suggested asset (CV_03 is listed for R4 only, at -3.888, matched on nothing); the
    // partial R4's own demo record (matched on nothing, -0.463, below rerankPartial) proves nothing either: kept as its proof, weak
    ok(m('R4').evidence.map(e => e.proves).join() === 'false,false,false' && m('R4').proof_weak && m('R4').best_doc === 'demo_Project_Telecom_RAGChatbot'
      && m('R1').evidence.every(e => e.proves) && !m('R1').proof_weak, 'proves flags');
    const cv3 = p.rag.assets.find(x => x.asset_id === 'CV_03_Maya_Patel.pdf');
    ok(row('R4').evidence.map(e => e.proves).join() === 'false,false,false' && row('R4').justification_weak && cv3.for.length === 0 && cv3.weak_for.join() === 'R4'
      && !p.rag.suggested_assets.team.includes('CV_03_Maya_Patel.pdf') && p.rag.suggested_assets.team.includes('CV_11_Chloe_Martin.pdf'), 'proposal: weak assets apart');
    // a CV with a quote for "2+" next to 2 demo records: not enough real proofs, the row keeps the demo record as ITS proof (quote too)
    const m3 = clone(matches); m3[2].matches[2] = v2Match('CV_11_Chloe_Martin.pdf', 'cv_document', null, ['public sector'], matches[0].matches[2].evidence.quote);
    const r3 = await joinRag(t, ragAnswer(rows, { requirement_matches: m3, data_mode: 'demo' })), x3 = r3.rag.matrix.find(x => x.requirement_id === 'R3');
    ok(r3.rag.demo_evidence.join() === 'R3,R4' && x3.origin === 'demo' && x3.best_quote === null && x3.best_doc === 'demo_Project_MinistryInterior_LicensingPortal' && x3.evidence[0].doc_id === 'CV_11_Chloe_Martin.pdf', '1 CV of 2 needed: demo proof kept');
    const p3 = (await proposal(r3)).matrix.rows.find(x => x.requirement_id === 'R3');
    ok(p3.justification_kind === 'demo' && p3.justification === 'Digital licensing and compliance tracking platform delivered for a government ministry, React + Spring Boot + PostgreSQL, 5 month delivery.', 'proposal: demo justification');
    return `demo_evidence ${r.rag.demo_evidence} (variants ${r2.rag.demo_evidence} / ${r3.rag.demo_evidence}); R1 ${m('R1').origin} ${m('R1').best_doc}, evidence ${m('R1').evidence.map(e => e.origin).join('/')}; R4 ${m('R4').evidence.map(e => `${e.origin} ${e.rerank} proves ${e.proves}`).join(' / ')}; 1 CV for "2+": ${x3.origin} ${x3.best_doc} quote ${x3.best_quote}, ${p3.justification_kind}; reason "${p.matrix.summary.recommendation_reason}"`;
  });
C(A4, 'Partial technical row + non-technical gap (real)', 'T3j2315 (dataMEL): R1 technical, not mandatory, partial (CV_18, rerank -5.257, "Weak evidence only"); R2 experience missing',
  'recommendation bid_with_partner (the documented rule) and its reason names R1 as partial, never "technical requirements covered" alone', 'PR1', async ok => {
    const t = v2Tender([['R1', 'technical', 'Methodology for development of open-source data platforms', 'Pertinence de la méthodologie d’intervention mise en œuvre pour l’exécution du marché au regard du cadre de mémoire technique', false],
      ['R2', 'experience', 'Experience in open source data management in public sector', 'Pertinence de l’expérience des équipes affectées au marché dans l’environnement open source, dans le cadre de la gestion et l’exploitation données, auprès d’acteurs publics ou privés', false]]);
    const rows = [v2Row('Methodology for development of open-source data platforms', 'technical', 'partial', { found: 2, method: 'reranker', best_doc: 'CV_18_Leila_Morgan.pdf', origin: 'cv_document',
      evidence: 'Containerized the platform with Docker on Azure VMs and introduced Datadog monitoring, achieving 99.8% uptime.' }),
    v2Row('Experience in open source data management in public sector', 'experience', 'missing', { method: 'reranker', closest_doc: 'olivesoft_Project_Story_Retail_Customer_Intelligence' })];
    const matches = [{ requirement: rows[0].requirement, matches: [v2Match('CV_18_Leila_Morgan.pdf', 'cv_document', -5.257, [], rows[0].evidence),
      v2Match('olivesoft_Tool_Architecture_Framework', 'user_entered', -5.668, [], 'Name: Architecture Framework')] }];
    const p = await proposal(await joinRag(t, ragAnswer(rows, { requirement_matches: matches })));
    const s = p.matrix.summary;
    ok(s.recommendation === 'bid_with_partner' && s.recommendation_reason === 'technical requirements covered or partial (R1 partial); gaps in experience: R2', 'reason names the partial row');
    return `${s.recommendation}: ${s.recommendation_reason}`;
  });
C(A4, 'Certification aliased by the RAG (real)', 'T1xiyyfm: "1 PSM certified Scrum Master" covered (rules, certs "Scrum Master (PSM/CSM)") by CV_14 "Certified Scrum Master (CSM) – Scrum Alliance, 2022"; control: "1 PMP certified project manager" covered by CV_17 "Project Management Professional (PMP), PMI – 2022"',
  'the RAG\'s status kept (its alias rule) but said: warning "… no proof names PSM …" and proposal risk "Certification asked but not named in the proof …: R1 PSM"; nothing for the PMP row', 'RG2, PR1', async ok => {
    const qTeam = 'le titulaire doit mobiliser au minimum 5 développeurs seniors et 1 Scrum Master certifié PSM';
    const t = v2Tender([['R1', 'team', '1 PSM certified Scrum Master', qTeam], ['R2', 'team', '1 PMP certified project manager', 'le soumissionnaire doit proposer au minimum 3 développeurs seniors, 1 chef de projet certifié PMP et 1 designer UX/UI.']]);
    const rows = [v2Row('1 PSM certified Scrum Master', 'team', 'covered', { found: 1, best_doc: 'CV_14_Henry_Price.pdf', origin: 'cv_document', evidence: 'Certified Scrum Master (CSM) – Scrum Alliance, 2022',
      parsed: { category: 'team', skills: ['agile'], certs: ['Scrum Master (PSM/CSM)'], min_count: 1, mandatory: true } }),
    v2Row('1 PMP certified project manager', 'team', 'covered', { found: 1, best_doc: 'CV_17_Julian_Hayes.pdf', origin: 'cv_document', evidence: 'Project Management Professional (PMP), PMI – 2022' })];
    const matches = [{ requirement: rows[0].requirement, matches: [v2Match('CV_14_Henry_Price.pdf', 'cv_document', null, ['agile', 'Scrum Master (PSM/CSM)'], rows[0].evidence)] },
      { requirement: rows[1].requirement, matches: [v2Match('CV_17_Julian_Hayes.pdf', 'cv_document', null, ['PMP', 'project manager (via PMP certification)'], rows[1].evidence)] }];
    const r = await joinRag(t, ragAnswer(rows, { requirement_matches: matches, data_mode: 'demo' }));
    const w = r.rag.warnings.filter(x => /no proof names/.test(x));
    ok(r.rag.matrix.every(x => x.status === 'covered') && w.length === 1 && /^R1 .*no proof names PSM .*CV_14_Henry_Price\.pdf/.test(w[0]), 'warning for PSM only');
    const p = await proposal(r);
    ok(p.analysis.risks.includes('Certification asked but not named in the proof (an equivalent one?): R1 PSM') && p.matrix.rows[0].coverage === 'covered', 'risk, status kept');
    return w.join(' | ');
  });
C(A4, 'Certification line with another acronym, compact form, alternatives', 'CV_14 (certifications "AWS Certified", "AWS Solutions Architect") for "1 AWS certified architect for CRM hosting"; the real olivesoft_Tool_Architecture_Framework record ("… keeping ISO 27001 compliance.") for "ISO27001 certified hosting" and "ISO 9001 certification"; CV_17 "(PMP)" for "1 project manager PMP or PRINCE2 certified"',
  'only the acronyms next to "certified" are certificates (CRM is not), "ISO27001" is named by "ISO 27001", one of "PMP or PRINCE2" is enough: a single warning, for ISO 9001 (another ISO standard)', 'RG2', async ok => {
    const FRAMEWORK = 'Name: Architecture Framework\nDescription: A proprietary architecture framework used to design AI-enabled data platforms for clients while keeping ISO 27001 compliance.';
    const t = v2Tender([['R1', 'team', '1 AWS certified architect for CRM hosting', 'un architecte certifié AWS pour l\'hébergement du CRM'], ['R2', 'technical', 'ISO27001 certified hosting', 'hébergement certifié ISO27001'],
      ['R3', 'team', '1 project manager PMP or PRINCE2 certified', 'un chef de projet certifié PMP ou PRINCE2'], ['R4', 'technical', 'ISO 9001 certification', 'le titulaire est certifié ISO 9001']]);
    const rows = [v2Row('1 AWS certified architect for CRM hosting', 'team', 'covered', { found: 1, best_doc: 'CV_14_Henry_Price.pdf', origin: 'cv_document', evidence: 'AWS Certified Solutions Architect – Associate, 2021' }),
      v2Row('ISO27001 certified hosting', 'technical', 'covered', { found: 1, best_doc: 'olivesoft_Tool_Architecture_Framework', origin: 'user_entered', statement: FRAMEWORK }),
      v2Row('1 project manager PMP or PRINCE2 certified', 'team', 'covered', { found: 1, best_doc: 'CV_17_Julian_Hayes.pdf', origin: 'cv_document', evidence: 'Project Management Professional (PMP), PMI – 2022' }),
      v2Row('ISO 9001 certification', 'technical', 'partial', { found: 1, method: 'reranker', best_doc: 'olivesoft_Tool_Architecture_Framework', origin: 'user_entered', statement: FRAMEWORK })];
    const r = await joinRag(t, ragAnswer(rows));
    const w = r.rag.warnings.filter(x => /no proof names/.test(x)), certs = r.rag.matrix.map(x => `${x.requirement_id}:${x.certs_not_in_proof.join('/')}`);
    ok(certs.join() === 'R1:,R2:,R3:,R4:ISO 9001' && w.length === 1 && /^R4 "ISO 9001 certification" is partial but no proof names ISO 9001 \(olivesoft_Tool_Architecture_Framework\)/.test(w[0]), 'one warning, ISO 9001');
    return `${certs.join(' ')} | ${w.join(' | ')}`;
  });
C(A2, 'Raw line break inside a JSON string (real)', 'real qwen3 answer for the Arabic e-services portal (DEMO-005): requirements[0].quote holds a raw line break ("…باستعمال Node" + newline + "      . يجب…"), invalid JSON',
  'answer repaired (the line break read as a space), not lost: status ok, fit high, survivor; the Node.js skill part refused (the model\'s quote lost ".js"), the other 6 skill lines kept', 'AN2 (parseAnswer)', async ok => {
    const desc = 'موضوع طلب العروض: تطوير بوابة إلكترونية تمكن المواطنين من تقديم مطالبهم الإدارية عبر الإنترنت ومتابعتها والدفع الإلكتروني. المتطلبات التقنية: يجب تطوير الواجهة باستعمال Angular. يجب تطوير الخادم باستعمال Node.js. يجب استعمال قاعدة بيانات PostgreSQL. يجب استضافة البوابة على AWS. الفريق: يجب على العارض توفير مدير مشروع و3 مطورين على الأقل. الخبرة: يجب على العارض تقديم مرجع واحد على الأقل لبوابة خدمات إلكترونية لفائدة بلدية أو هيكل عمومي. مدة الإنجاز: 7 أشهر. معايير التقييم: العرض الفني (70)، العرض المالي (30).';
    const t = tender({ id: 'portal_ar', source: 'fixture-ar', language: 'ar', title: 'بوابة الخدمات الإلكترونية للمواطنين', description: desc, body_text: `بوابة الخدمات الإلكترونية للمواطنين\n\n${desc}`,
      buyer: { name: 'بلدية سامبلفيل', country: 'TN', contacts: {} }, publication_date: '2026-10-18', deadline: '2026-11-15', cpv: ['72413000'] });
    const text = `{
  "tender_type": "software_build",
  "fit": "high",
  "reason": "The tender requires developing a digital portal with Angular frontend, Node.js backend, PostgreSQL database, and AWS hosting — matching OliveSoft's web and mobile applications, and cloud services.",
  "services": [
    "1. web and mobile applications, custom software and digital platforms"
  ],
  "quote": "يجب تطوير الواجهة باستعمال Angular. يجب تطوير الخادم باستعمال Node.js. يجب استعمال قاعدة بيانات PostgreSQL. يجب استضافة البوابة على AWS.",
  "sector": "public sector",
  "requirements": [
    {
      "category": "technical",
      "text": "يجب تطوير الواجهة باستعمال Angular. يجب تطوير الخادم باستعمال Node.js. يجب استعمال قاعدة بيانات PostgreSQL. يجب استضافة البوابة على AWS.",
      "skill": "Angular frontend, Node.js backend, PostgreSQL, AWS hosting",
      "quote": "يجب تطوير الواجهة باستعمال Angular. يجب تطوير الخادم باستعمال Node
      . يجب استعمال قاعدة بيانات PostgreSQL. يجب استضافة البوابة على AWS."
    },
    {
      "category": "team",
      "text": "يجب على العارض توفير مدير مشروع و3 مطورين على الأقل.",
      "skill": "1 project manager and 3 developers",
      "quote": "يجب على العارض توفير مدير مشروع و3 مطورين على الأقل."
    },
    {
      "category": "experience",
      "text": "يجب على العارض تقديم مرجع واحد على الأقل لبوابة خدمات إلكترونية لفائدة بلدية أو هيكل عمومي.",
      "skill": "1 public sector digital portal project",
      "quote": "يجب على العارض تقديم مرجع واحد على الأقل لبوابة خدمات إلكترونية لفائدة بلدية أو هيكل عمومي."
    }
  ],
  "timeline": "7 أشهر"
}`;
    ok(/Node\n {6}\. /.test(text), 'fixture holds the raw line break');
    const a = await analyse(t, { text });
    const lines = a.requirements.items.map(r => r.rag_text);
    ok(a.analysis.status === 'ok' && a.analysis.fit === 'high' && a.analysis.quote_verified && a.survivor && !a.analysis.checks.includes('llm_invalid'), 'parsed, not lost');
    ok(lines.length === 6 && !lines.some(l => /Node/.test(l)) && lines.includes('PostgreSQL') && lines.includes('1 public sector digital portal project'), '6 skill lines, Node.js refused');
    return `status ${a.analysis.status}, fit ${a.analysis.fit}, checks [${a.analysis.checks}]; ${lines.length} lines: ${lines.join(' | ')}; dropped ${a.requirements.dropped.map(d => d.why).join(' | ')}`;
  });
C(A5, 'One award listed under several DECP ids (real)', 'T136zpko market: ENTR\'OUVERT "won" 4 comparables, 3 of them one Essonne award (DEPARTEMENT DE L\' ESSONNE, 2026-07-06, 600 000, D1rl9qaf / D1q4swcs / D8t0v3j) + Antibes; DESIGN SYSTEM 2 awards of one buyer and day with different amounts',
  'a win = a distinct award (buyer, date, amount, winners): ENTR\'OUVERT 2, DESIGN SYSTEM still 2; risk "ENTR\'OUVERT won 2 comparable contracts"; the comparables themselves kept', 'PR1', async ok => {
    const row = (id, date, amount, buyer, winner, title, bids = 1) => ({ id, date, amount, currency: 'EUR', buyer, winners: [winner], bids, others: [], cpv: '72267100', framework: true, source: 'DECP', title });
    const publik = 'Hébergement, maintenance, assistance technique, et prestations associées relatives à la solution « Publik » et';
    const comparables = [row('D1rl9qaf', '2026-07-06', 600000, 'DEPARTEMENT DE L\' ESSONNE', 'ENTR\'OUVERT', `2026_2957_2_00 - ${publik}`.slice(0, 110)),
      row('D1q4swcs', '2026-07-06', 600000, 'DEPARTEMENT DE L\' ESSONNE', 'ENTR\'OUVERT', publik), row('D8t0v3j', '2026-07-06', 600000, 'DEPARTEMENT DE L\' ESSONNE', 'ENTR\'OUVERT', publik),
      row('Dj4emam', '2026-06-23', 12450, 'COMMUNE D\'ANTIBES (MAIRIE)', 'ENTR\'OUVERT', 'CONTRAT D HEBERGEMENT ET DE MAINTENANCE POUR LE LOGICIEL DE GESTION DE LA RELATION USAGER', null),
      row('Dagrg1h', '2026-04-30', 40000, 'COMMUNAUTE INTERCOMMUNALE NORD REUNION', 'DESIGN SYSTEM', 'Accord Cadre à marchés subséquents mono attributaire élaboration et évolution de formulaires électroniques pou', 4),
      row('D1v5g0hz', '2026-04-30', 69900, 'COMMUNAUTE INTERCOMMUNALE NORD REUNION', 'DESIGN SYSTEM', 'ELABORATION ET EVOLUTION DE FORMULAIRES ELECTRONIQUES POUR LE PORTAIL DE GESTION RELATION CLIENTELE DE LA CINO', 4),
      { ...row('Du8l9kf', '2026-03-19', 43078, 'COMMUNE DE CAMBO LES BAINS (MAIRIE)', 'DIPTICK', 'Fourniture, installation et maintenance dun logiciel de billetterie pour la commune de Cambo-les-Bains', 2), framework: false }];
    const market = { status: 'studied', declared_value: null, budget: null, median_bids: 3, comparables, positioning: '', budget_comment: '', checks: [],
      competitors: [{ name: 'ENTR\'OUVERT', wins: 4, lost: null, last_win: '2026-07-06', amount_won: null, avg_amount: null }, { name: 'DESIGN SYSTEM', wins: 2, lost: null, last_win: '2026-04-30', amount_won: null, avg_amount: null },
        { name: 'DIPTICK', wins: 1, lost: null, last_win: '2026-03-19', amount_won: 43078, avg_amount: 43078 }] };
    const p = await proposal(ragTender({ market }));
    const wins = p.competition.competitors.map(c => `${c.name} ${c.past_wins}`);
    ok(wins.join() === 'ENTR\'OUVERT 2,DESIGN SYSTEM 2,DIPTICK 1' && p.competition.comparables.length === 7, 'distinct awards');
    ok(p.analysis.risks.includes('ENTR\'OUVERT won 2 comparable contracts') && !p.analysis.risks.some(x => /won 4/.test(x)), 'risk');
    // 2 lots of one buyer and day without a price (the real TED row of the Département de l'Eure, no amount): 2 awards, never merged
    const eure = k => ({ ...row(`T303385-2025-${k}`, '2025-05-13', null, 'Département de l\'Eure', 'SECUTIX', `Acquisition d'une solution de billetterie, réservation, contrôle d'accès - lot ${k}`, null), source: 'TED', framework: false });
    const p2 = await proposal(ragTender({ market: { ...market, comparables: [...comparables, eure(1), eure(2)], competitors: [...market.competitors, { name: 'SECUTIX', wins: 2, lost: null, last_win: '2025-05-13', amount_won: null, avg_amount: null }] } }));
    ok(p2.competition.competitors.find(c => c.name === 'SECUTIX').past_wins === 2, 'unpriced lots: 2 wins');
    return `${wins.join(', ')}; risk "${p.analysis.risks.find(x => / won /.test(x))}"; 2 unpriced lots: SECUTIX ${p2.competition.competitors.find(c => c.name === 'SECUTIX').past_wins}`;
  });

// ---- obligations left out of the matrix, buyer website, run report (Build Proposal Input, Rank & Export, Run Summary, build order)
// the real Power BI demo T1w50xyr (run of 2026-10-19): Verify Analysis kept 6 rows, the RAG covered them all (R1-R3, R6 by demo
// records, R4-R5 by CVs); its notice's "L'accès doit être géré par rôles." is quoted by none of them (requirements.uncovered, AN2 case above)
const PBI_QA = 'Les tableaux de bord doivent être réalisés sous Power BI. Les flux de données doivent être automatisés avec des pipelines Python. La solution doit être hébergée sur Azure.';
const PBI_QB = 'le titulaire doit proposer 1 chef de projet et 2 ingénieurs data.', PBI_QC = "le titulaire doit justifier d'au moins 1 projet de tableau de bord dans le secteur de la santé.";
const PBI_REQS = [['technical', 'Power BI', PBI_QA], ['technical', 'Python pipelines', PBI_QA], ['technical', 'Azure hosting', PBI_QA], ['team', '1 project manager', PBI_QB],
  ['team', '2 data engineers', PBI_QB], ['experience', '1 health sector dashboard project', PBI_QC]].map(([category, text, quote], k) => ({ id: `R${k + 1}`, category, text, rag_text: text, quote, mandatory: true }));
const PBI_DOCS = [['demo', 'demo_Tool_PowerBI_Licences'], ['demo', 'demo_Project_HealthAnalytics_Dashboard'], ['demo', 'demo_Project_Manufacturer_ERP'], ['cv_document', 'CV_14_Henry_Price.pdf'],
  ['cv_document', 'CV_13_Isabella_Ross.pdf'], ['demo', 'demo_Project_HealthAnalytics_Dashboard']];
const PBI_RAG = ragAnswer(PBI_REQS.map((r, k) => ragRow(r, 'covered', { origin: PBI_DOCS[k][0], best_doc: PBI_DOCS[k][1] })));
const pbiTender = uncovered => ragTender({ tender_id: 'T1w50xyr', title: 'Tableau de bord décisionnel des indicateurs de santé publique', source: 'demo', source_url: 'http://localhost:8004/tenders/DEMO-003',
  days_left: 21, effective_deadline: '2026-11-09', buyer: { name: 'Direction Régionale de la Santé de Sampleville (démo)', country: 'FR', contacts: {} },
  requirements: { items: PBI_REQS, dropped: [], low_input: false, ...(uncovered ? { uncovered } : {}) } });
C(A4, 'Obligation of the notice left out of the matrix (real demo)', 'real Power BI demo T1w50xyr: 6 verified rows, all covered by the RAG (the run handed off "bid", "every requirement is covered by internal evidence"), but "L\'accès doit être géré par rôles." is in no row (requirements.uncovered); the tourism-licence demo\'s "Une certification ISO 27001 est souhaitée." left out of a bid_with_partner matrix (team gaps); control: the Power BI tender with nothing left out',
  'review "1 obligation sentence(s) of the notice are not in the matrix (…): check them before deciding", never "every requirement is covered"; the sentence in matrix.summary.obligations_not_in_matrix and in the risks; bid_with_partner stays, its reason names the sentence; export column requirements_uncovered right after requirements_dropped; control: bid', 'PR1, EX1', async ok => {
    const ROLE = "L'accès doit être géré par rôles.", ISO = 'Une certification ISO 27001 est souhaitée.';
    const r = await joinRag(pbiTender([ROLE]), PBI_RAG), p = await proposal(r), s = p.matrix.summary, c = await proposal(await joinRag(pbiTender(), PBI_RAG));
    ok(s.recommendation === 'review' && s.recommendation_reason.startsWith(`1 obligation sentence(s) of the notice are not in the matrix ("${ROLE}"): check them before deciding`) && !/every requirement is covered/.test(s.recommendation_reason), 'review, not bid');
    ok(JSON.stringify(s.obligations_not_in_matrix) === JSON.stringify([ROLE]) && p.analysis.risks.some(x => x.startsWith('Obligation(s) of the notice not in the requirements matrix') && x.includes(`"${ROLE}"`)), 'passed on, risk');
    ok(c.matrix.summary.recommendation === 'bid' && !c.matrix.summary.obligations_not_in_matrix.length && !c.analysis.risks.some(x => /^Obligation/.test(x)), 'control bid');
    const w = await proposal(await joinRag(ragTender({ requirements: { items: REQS, dropped: [], low_input: false, uncovered: [ISO] } }), ragAnswer(statuses('covered', 'covered', 'missing', 'partial'))));
    ok(w.matrix.summary.recommendation === 'bid_with_partner' && w.matrix.summary.recommendation_reason.includes(`; 1 obligation sentence(s) of the notice are not in the matrix ("${ISO}")`), 'bid_with_partner names it');
    const [row] = await run('Rank & Export', [r]), keys = Object.keys(row);
    ok(row.requirements_uncovered === ROLE && keys.indexOf('requirements_uncovered') === keys.indexOf('requirements_dropped') + 1, 'export column');
    return `${s.recommendation} (${s.recommendation_reason.slice(0, 110)}…); control ${c.matrix.summary.recommendation}; tourism ${w.matrix.summary.recommendation}; export "${row.requirements_uncovered}"`;
  });
C(A3, 'Buyer website "https://undefined" or a tender platform (real)', 'real T1vll2ea (City\'up (972)): Parse Research gave official_website "https://undefined" (a Wikidata row without website=), the notice gives "https://v2.marches-securises.fr"; control T3j2315 (Métropole européenne de Lille, not researched): the notice\'s "https://www.lillemetropole.fr/"',
  'proposal input buyer_profile.website null and export buyer_website empty (a host without a dot, then a tender platform: never the buyer\'s site); the control keeps lillemetropole.fr in both', 'PR1, EX1', async ok => {
    const cityup = { tender_id: 'T1vll2ea', title: 'Prestations de développement d\'agents LLM et services associés', source: 'francemarches',
      buyer: { name: 'City\'up (972)', country: 'FR', contacts: { email: 'cu.commandepublique@cityup.mq', phone: null, website: 'https://v2.marches-securises.fr', address: 'Fort de France, 97200' } },
      buyer_profile: { research_status: 'researched', legal_name: 'CITY\'UP (CFTU)', official_website: 'https://undefined',
        contacts: { emails: ['cu.commandepublique@cityup.mq'], phones: [], website: 'https://undefined', addresses: ['Fort de France, 97200', '19 RUE DE LA LIBERTE 97200 FORT DE FRANCE'] } } };
    const mel = { tender_id: 'T3j2315', title: 'Prestations de développement numérique, d\'information et d\'accompagnement aux usages sur dataMEL', source: 'boamp',
      buyer: { name: 'Métropole européenne de Lille', country: 'FR', contacts: { email: 'marches.support@lillemetropole.fr', phone: '+33 320212223', website: 'https://www.lillemetropole.fr/', address: '2 boulevard des Cités Unies - CS 70043 59040 Lille' } },
      buyer_profile: { research_status: 'not_researched_budget' } };
    const [a, b] = [await proposal(ragTender(cityup)), await proposal(ragTender(mel))];
    const rows = await run('Rank & Export', [merged('1vll2ea', cityup), merged('3j2315', mel)]), web = id => rows.find(x => x.tender_id === id).buyer_website;
    ok(a.buyer_profile.website === null && web('T1vll2ea') === '', 'no "https://undefined", no platform');
    ok(b.buyer_profile.website === 'https://www.lillemetropole.fr/' && web('T3j2315') === 'https://www.lillemetropole.fr/', 'control kept');
    return `City'up: proposal ${a.buyer_profile.website}, export "${web('T1vll2ea')}"; MEL: ${b.buyer_profile.website}`;
  });
C(A6, 'Run Summary: fit tenders without requirements told apart (real)', 'real fit tenders with an empty matrix: T180cy2h "Prestation informatique" (title-only notice, nothing extracted), T18xqq3x (title-only notice, the LLM\'s row dropped "title-only text"); T18hhow2 "Développement d\'une application mobile de signalement citoyen" (recorded ollama answer whose 3 rows copy the French quote: all dropped "text is the untranslated quote (no skill line)", the 3 sentences in requirements.uncovered); control T136zpko with 2 rows',
  '"2 fit tender(s) have no requirement in their notice" (the title-only ones) and apart "1 fit tender(s) whose requirements were all dropped or left out by the analysis"; quality counts the uncovered sentences and the fit tenders holding some', 'EX2', async ok => {
    const ts = [merged('180cy2h', { source: 'boamp', source_type: 'api', title: 'Prestation informatique', documents_url: 'https://achatpublic.com', requirements: { items: [], dropped: [], low_input: true } }),
      merged('18xqq3x', { source: 'boamp', source_type: 'api', title: 'Prestation d\'externalisation de la fonction de Direction des Systèmes d\'Information.', requirements: { items: [], low_input: true,
        dropped: [{ text: 'The bidder must have a team of qualified IT professionals with experience in public sector digital transformation', why: 'title-only text' }] } }),
      merged('18hhow2', { title: 'Développement d\'une application mobile de signalement citoyen', buyer: { name: 'Ville de Sampleville', country: 'FR', contacts: {} },
        requirements: { items: [], dropped: [Q.ios, Q.host, Q.refs].map(q => ({ text: q, why: 'text is the untranslated quote (no skill line)' })), low_input: false, uncovered: [Q.ios, Q.host, Q.refs] } }),
      merged('136zpko', { source: 'boamp', source_type: 'api', title: 'RENOUVELLEMENT DE LA SOLUTION DE BILLETTERIE ET DE GESTION DE LA RELATION CLIENT (GRC)', requirements: { items: REQS.slice(0, 2), dropped: [], low_input: false } })];
    const s = await runSummary([SRC.boamp], { 'Merge Market': ts }), lines = s.message.split('\n').filter(l => /^\d+ fit tender/.test(l));
    ok(s.totals.fit_without_requirements === 2 && lines[0] === '2 fit tender(s) have no requirement in their notice: download their tender documents (documents_url in the export) before deciding', 'title-only notices');
    ok(s.totals.fit_requirements_all_dropped === 1 && /^1 fit tender\(s\) whose requirements were all dropped or left out by the analysis \(see requirements_dropped \/ requirements_uncovered in the export\)/.test(lines[1] || ''), 'all dropped, apart');
    ok(s.quality.requirements_uncovered === 3 && s.quality.fit_with_uncovered === 1 && s.quality.requirements_dropped === 4, 'quality');
    return lines.join(' / ');
  });
C(A6, 'Run Summary: a page of the task list the scout never opened (real)', 'real francemarches scout: page 1 asked on "www.franc-than.com" (DNS failure), page 2 read; real domainetat-tn scout: "?cat=19&lang=-fr" (lands on page 1), page 2 read; a francemarches scout that reads page 1 only, whose NEXT PAGE is page 2 (written with %20); one whose page 1 landed on francemarches.fr (open_page NOTE)',
  'francemarches: ONE coverage error "list page 1 never read, its tenders are missing: the scout asked franc-than.com instead of francemarches.com (firecrawl: DNS …) - <page 1>"; domainetat-tn: nothing; page 2 named once (not again as "stopped before the next page"); the NOTE listed as "page note: …" with no coverage error of its own', 'EX2 (scoutRun)', async ok => {
    const s = await runSummary([SRC.fm, SRC.dt], { 'URL1 - Scout Tasks': [TASK_FM, TASK_DOM], 'Tender Scout Agent': [fmAgent(FM_DNS), DOM_AGENT] });
    const fm = s.per_source.francemarches, dom = s.per_source['domainetat-tn'];
    ok(fm.errors.length === 1 && fm.errors[0].startsWith('list page 1 never read, its tenders are missing: the scout asked franc-than.com instead of francemarches.com (firecrawl: DNS resolution failed')
      && fm.errors[0].endsWith(` - ${TASK_FM.url}`) && fm.coverage_errors === 1, 'page 1 never opened');
    ok(!dom.errors.some(e => /never opened/.test(e)), 'domainetat read both');
    const p2 = 'https://www.francemarches.com/recherche?q=Intelligence%20Artificielle&etat=en-cours&page=2';
    const p1 = [`PAGE [k3v9d1] | ${TASK_FM.url} | Appel d'offre / Avis publics sur France Marchés`, 'TEXT: Accueil/Appels d’offres', 'REPEATED LABELS: none', `NEXT PAGE: [n2pg7x] | ${p2}`,
      'LINKS (same site, 2 of 2):', `[${FM_LINKS[0][0]}] ${FM_LINKS[0][1]} | ${fmUrl(FM_LINKS[0][2])}`, `[n2pg7x] 20 avis de marchés publics suivants | ${p2}`].join('\n');
    const one = await runSummary([SRC.fm], { 'URL1 - Scout Tasks': [TASK_FM], 'Tender Scout Agent': [scoutAnswer([FM_LINKS[0][0]], [step('open_page', { url: TASK_FM.url }, p1)])] });
    ok(JSON.stringify(one.per_source.francemarches.errors) === JSON.stringify([`the scout never opened ${TASK_FM.other_pages[0]} (pages of the task list: their tenders are missing)`]), 'page 2 named once');
    const fr = u => u.replace(/francemarches\.com/g, 'francemarches.fr');
    const landed = await openPage(TASK_FM.url, scraped(fr(TASK_FM.url), FM_LIST2.data.metadata.title, fr(FM_LIST2.data.markdown).split('\n').filter(l => !/suivants/.test(l))));
    const note = (landed.result.match(/^NOTE: (.*)$/m) || [])[1] || '';
    const n = await runSummary([SRC.fm], { 'URL1 - Scout Tasks': [TASK_FM], 'Tender Scout Agent': [scoutAnswer(['we362f'], [step('open_page', { url: TASK_FM.url }, landed.result), step('open_page', { url: TASK_FM.other_pages[0] }, FM_SEEN2)])] });
    ok(/^redirected to francemarches\.fr, which is not in the allowedHosts/.test(note) && JSON.stringify(n.per_source.francemarches.errors) === JSON.stringify([`page note: ${note}`])
      && !n.per_source.francemarches.coverage_errors && n.per_source.francemarches.scout.pages[0].note === note, 'NOTE listed');
    return `${fm.errors[0].slice(0, 150)}… | ${one.per_source.francemarches.errors[0].slice(0, 60)}… | ${n.per_source.francemarches.errors[0].slice(0, 70)}…`;
  });
C(A6, 'Run Summary: a failed sheet write is reported', '"Save to Google Sheet" (enabled, On Error: continue) answers [{error: "Forbidden - perhaps check your credentials?"}] for the export of T1wp05cp; control: it returns the written row',
  'the node is drawn above Run Summary (n8n v1 runs the branches of Rank & Export top to bottom), so Run Summary sees the write: failed_calls "Sheet write" 1, in the message, has_warnings; control 0, no WARNINGS', 'build (positions), EX2', async ok => {
    const pos = n => wf.nodes.find(x => x.name === n).position;
    const order = wf.connections['Rank & Export'].main[0].map(c => c.node).sort((a, b) => pos(a)[1] - pos(b)[1] || pos(a)[0] - pos(b)[0]);
    ok(order.includes('Save to Google Sheet') && order.indexOf('Save to Google Sheet') < order.indexOf('Run Summary'), 'runs before Run Summary');
    const fit = merged('1wp05cp', { source: 'demo', source_type: 'api' }), [row] = await run('Rank & Export', [fit]);
    const lane = sheet => runSummary([SRC.demo], { ...apiLane('demo', [fit]), 'Merge Market': [fit], 'Rank & Export': [row], 'Save to Google Sheet': sheet });
    const [s, c] = [await lane([{ error: 'Forbidden - perhaps check your credentials?' }]), await lane([row])];
    ok(s.failed_calls['Sheet write'] === 1 && s.has_warnings && s.message.includes('Failed calls: 1 -> Sheet write 1'), 'failed write reported');
    ok(c.failed_calls['Sheet write'] === 0 && !c.has_warnings, 'control');
    return `branches ${order.join(' > ')}; ${s.message.split('\n').find(l => l.startsWith('Failed calls'))}`;
  });

// RAG v2 answers and buyer research of the run of 2026-10-20 (qwen3 4B, team RAG v2): the row's proof, its quote and score, the proposal input
C(A4, 'Partial row whose own document matched nothing (real)', 'T1vll2ea (City\'up, LLM agents): "document intelligence" partial (reranker), best_doc CV_06 "B.Sc. in Data Engineering" at -3.681 matched on nothing, CV_05 -4.382 and a company record -5.427 listed too; "LLM agents" covered by olivesoft_Project_GenAI_Content_Agent (4.018, "llm"); T3j2315 (dataMEL): partial, CV_05 "Professional Experience" at -5.646 matched on nothing; variant: the same CV_06 row marked covered by the RAG',
  'the partial row keeps the RAG\'s status, best_doc and quote, but CV_06 proves nothing (proof_weak; proposal justification_weak, CV_06 weak_for R3, not a suggested team asset); dataMEL: justification_is_header too, no suggested team asset; the covered row and the covered variant keep their own document as proof', 'RG2, PR1', async ok => {
    const qAI = 'prestations de conseil, conception, développement, intégration, évolution, optimisation, sécurisation et industrialisation de solutions reposant sur l’intelligence artificielle générative, notamment des agents LLM et des chaînes de génération augmentée par recherche documentaire (RAG)';
    const t = v2Tender([['R1', 'technical', 'LLM agents', qAI, false], ['R3', 'technical', 'document intelligence', qAI, false]]);
    const GENAI = 'Name: Generative AI content agent and multi-LLM chat interface\nDescription: Deployed an AI agent generating social-media content, a chat interface selecting among 5 LLMs, and RAG with LangChain and Pinecone.';
    const rows = st => [v2Row('LLM agents', 'technical', 'covered', { found: 2, method: 'rules+reranker', best_doc: 'olivesoft_Project_GenAI_Content_Agent', origin: 'user_entered', statement: GENAI }),
      v2Row('document intelligence', 'technical', st, { found: 3, method: 'reranker', best_doc: 'CV_06_Ethan_Brooks.pdf', evidence: 'B.Sc. in Data Engineering', origin: 'cv_document' })];
    const matches = [{ requirement: 'LLM agents', matches: [v2Match('olivesoft_Project_GenAI_Content_Agent', 'user_entered', 4.018, ['llm'], GENAI),
      v2Match('CV_12_Mateo_Silva.pdf', 'cv_document', 2.1, ['llm'], '% AI & Machine Learning: LLM fine-tuning, Retrieval-Augmented Generation, LangChain, Prompt Engineering')] },
    { requirement: 'document intelligence', matches: [v2Match('CV_06_Ethan_Brooks.pdf', 'cv_document', -3.681, [], 'B.Sc. in Data Engineering'),
      v2Match('CV_05_Sofia_Nguyen.pdf', 'cv_document', -4.382, [], 'Data-driven BI Consultant with 5+ years of experience designing end-to-end analytics solutions across finance, telecom, and'),
      v2Match('olivesoft_Project_Story_Retail_Customer_Intelligence', 'user_entered', -5.427, [], 'Name: Unified customer intelligence for a retail and e-commerce brand (website success story)')] }];
    const r = await joinRag(t, ragAnswer(rows('partial'), { requirement_matches: matches })), m = id => r.rag.matrix.find(x => x.requirement_id === id);
    ok(m('R3').status === 'partial' && m('R3').best_doc === 'CV_06_Ethan_Brooks.pdf' && m('R3').best_quote === 'B.Sc. in Data Engineering' && m('R3').proof_weak
      && m('R3').evidence.every(e => !e.proves) && !m('R1').proof_weak && m('R1').evidence.every(e => e.proves), 'partial row: its own document weak');
    const p = await proposal(r), row = id => p.matrix.rows.find(x => x.requirement_id === id), cv6 = p.rag.assets.find(x => x.asset_id === 'CV_06_Ethan_Brooks.pdf');
    ok(row('R3').coverage === 'partial' && row('R3').justification === 'B.Sc. in Data Engineering' && row('R3').justification_weak && !row('R1').justification_weak
      && cv6.for.length === 0 && cv6.weak_for.join() === 'R3' && !p.rag.suggested_assets.team.includes('CV_06_Ethan_Brooks.pdf')
      && p.rag.suggested_assets.projects.includes('olivesoft_Project_GenAI_Content_Agent'), 'proposal: weak, not suggested');
    const c = (await joinRag(t, ragAnswer(rows('covered'), { requirement_matches: matches }))).rag.matrix.find(x => x.requirement_id === 'R3');
    ok(!c.proof_weak && c.evidence[0].doc_id === 'CV_06_Ethan_Brooks.pdf' && c.evidence[0].proves, 'covered by the RAG: its own proof');
    const mel = v2Tender([['R1', 'experience', 'Experience in open source data management with public or private actors required', 'Pertinence de l’expérience des équipes affectées au marché dans l’environnement open source, dans le cadre de la gestion et l’exploitation données, auprès d’acteurs publics ou privés', false]]);
    const melRow = v2Row(mel.requirements.items[0].text, 'experience', 'partial', { method: 'reranker', best_doc: 'CV_05_Sofia_Nguyen.pdf', evidence: 'Professional Experience', origin: 'cv_document' });
    const rm = await joinRag(mel, ragAnswer([melRow], { requirement_matches: [{ requirement: melRow.requirement, matches: [v2Match('CV_05_Sofia_Nguyen.pdf', 'cv_document', -5.646, [], 'Professional Experience')] }] }));
    const pm = await proposal(rm), x = pm.matrix.rows[0];
    ok(x.justification_is_header && x.justification_weak && !pm.rag.suggested_assets.team.length && rm.rag.warnings.some(w => /is only a header line \(CV_05_Sofia_Nguyen\.pdf\)/.test(w)), 'header line said in the proposal');
    return `R3 ${m('R3').status} ${m('R3').best_doc} proof_weak ${m('R3').proof_weak}, proves ${m('R3').evidence.map(e => e.proves).join('/')}; suggested team [${p.rag.suggested_assets.team}]; covered variant proves ${c.evidence[0].proves}; dataMEL weak ${x.justification_weak}, header ${x.justification_is_header}, team [${pm.rag.suggested_assets.team}]`;
  });
C(A4, 'Mid-sentence RAG chunk as the row\'s proof (real)', 'T1w50xyr (Power BI demo, no reranker scores): "Power BI" covered by a demo record + CV_05 whose quote starts mid-sentence ("payments. Proven ability to translate ... into interactive Power BI dashboards and scalable data"); "Python pipelines": a demo record + CV_09 "operational visibility through Datadog monitoring. Proficient in Python, SQL, ..." + CV_07 "Automated data ingestion ... using Python and Airflow ..."; control T1xiyyfm "Salesforce CRM integration": CV_06 "and build data-driven CRM solutions on Salesforce Data Cloud. Passionate about ..." (the matched term only in the leading fragment)',
  'the leading fragment dropped ("Proven ability ... scalable data…", "Proficient in Python, SQL, and cloud-native data platforms, delivering…"); among real proofs of the same score the whole sentence is the row\'s proof (CV_07, first in the evidence) and the proposal justification; a fragment holding the matched term, or a chunk without a sentence break, is left as is', 'RG2, PR1', async ok => {
    const PBI_LIC = 'Name: Power BI Pro licences (fictional)\nDescription: Fictional sample: a pool of Power BI Pro licences available for client reporting projects.';
    const t = v2Tender([['R1', 'technical', 'Power BI', 'Les tableaux de bord doivent être réalisés sous Power BI'], ['R2', 'technical', 'Python pipelines', 'Les flux de données doivent être automatisés avec des pipelines Python']]);
    const rows = [v2Row('Power BI', 'technical', 'covered', { found: 15, best_doc: 'demo_Tool_PowerBI_Licences', origin: 'demo', statement: PBI_LIC }),
      v2Row('Python pipelines', 'technical', 'covered', { found: 22, best_doc: 'demo_Project_HealthAnalytics_Dashboard', origin: 'demo', statement: DEMO_ST.health })];
    const matches = [{ requirement: 'Power BI', matches: [v2Match('demo_Tool_PowerBI_Licences', 'demo', null, ['power bi'], PBI_LIC),
      v2Match('CV_05_Sofia_Nguyen.pdf', 'cv_document', null, ['power bi'], 'payments. Proven ability to translate complex business requirements into interactive Power BI dashboards and scalable data'),
      v2Match('demo_Project_HealthAnalytics_Dashboard', 'demo', null, ['power bi'], DEMO_ST.health)] },
    { requirement: 'Python pipelines', matches: [v2Match('demo_Project_HealthAnalytics_Dashboard', 'demo', null, ['python'], DEMO_ST.health),
      v2Match('CV_09_Emma_Foster.pdf', 'cv_document', null, ['python'], 'operational visibility through Datadog monitoring. Proficient in Python, SQL, and cloud-native data platforms, delivering'),
      v2Match('CV_07_Olivia_Morris.pdf', 'cv_document', null, ['python'], 'Automated data ingestion from 5 external APIs using Python and Airflow, reducing manual data collection time by 80 %.')] }];
    const r = await joinRag(t, ragAnswer(rows, { requirement_matches: matches, data_mode: 'demo' })), m = id => r.rag.matrix.find(x => x.requirement_id === id);
    const PBI = 'Proven ability to translate complex business requirements into interactive Power BI dashboards and scalable data…', PY = 'Automated data ingestion from 5 external APIs using Python and Airflow, reducing manual data collection time by 80 %.';
    ok(m('R1').best_doc === 'CV_05_Sofia_Nguyen.pdf' && m('R1').best_quote === PBI && m('R1').evidence[0].quote === PBI, 'fragment dropped');
    ok(m('R2').best_doc === 'CV_07_Olivia_Morris.pdf' && m('R2').best_quote === PY && m('R2').evidence.map(e => e.doc_id.slice(0, 5)).join() === 'CV_07,CV_09,demo_'
      && m('R2').evidence[1].quote === 'Proficient in Python, SQL, and cloud-native data platforms, delivering…', 'whole sentence preferred');
    const p = await proposal(r), row = id => p.matrix.rows.find(x => x.requirement_id === id);
    ok(row('R1').justification === PBI && row('R2').justification === PY && row('R2').evidence[0].asset_id === 'CV_07_Olivia_Morris.pdf', 'proposal justification');
    const SF = ['% Programming: Apex, LWC, JavaScript, SOQL, SOSL, HTML/CSS, SQL', 'complemented by hands-on expertise in Salesforce, OMS, Power BI and data-driven forecasting.',
      'and build data-driven CRM solutions on Salesforce Data Cloud. Passionate about turning massive, heterogeneous datasets into'];
    const sf = await joinRag(v2Tender([['R2', 'technical', 'Salesforce CRM integration', 'L\'application doit être intégrée au CRM Salesforce de la collectivité']]),
      ragAnswer([v2Row('Salesforce CRM integration', 'technical', 'covered', { found: 3, method: 'rules+reranker', best_doc: 'CV_08_Lucas_Reed.pdf', evidence: SF[0], origin: 'cv_document' })],
        { requirement_matches: [{ requirement: 'Salesforce CRM integration', matches: [['CV_08_Lucas_Reed.pdf', 6.326], ['CV_04_Noah_Bennett.pdf', 4.651], ['CV_06_Ethan_Brooks.pdf', 2.763]].map(([d, s], k) => v2Match(d, 'cv_document', s, ['salesforce'], SF[k])) }] }));
    ok(JSON.stringify(sf.rag.matrix[0].evidence.map(e => e.quote)) === JSON.stringify(SF) && sf.rag.matrix[0].best_quote === SF[0], 'control: left as is');
    return `R1 "${m('R1').best_quote.slice(0, 40)}…"; R2 ${m('R2').best_doc} "${m('R2').best_quote.slice(0, 40)}…", evidence ${m('R2').evidence.map(e => e.doc_id).join(' / ')}; control unchanged`;
  });
C(A4, 'Row score after a real proof replaces a demo record (real)', 'T1xsyk4l (Arabic e-services portal demo): "Node.js server" partial, the RAG\'s best_doc demo_Project_Municipality_EServices (rerank -2.358, "node.js") + CV_11 (-3.595, "node.js") + demo_TechStack_PublicSector_Cloud (-5.286)',
  'the row\'s proof is CV_11 and best_rerank its own score -3.59 (not the swapped-out demo record\'s -2.36); proposal rerank_score -3.59 next to the CV_11 justification', 'RG2, PR1', async ok => {
    const SFAX = 'Name: Municipality of Sfax - Citizen E-Services Portal (2022)\nDescription: Public-sector citizen portal with online requests and payments, Angular + Node.js on AWS.';
    const t = v2Tender([['R2', 'technical', 'Node.js server', 'يجب تطوير الخادم باستعمال Node.js']]);
    const r = await joinRag(t, ragAnswer([v2Row('Node.js server', 'technical', 'partial', { found: 3, method: 'rules+reranker', best_doc: 'demo_Project_Municipality_EServices', origin: 'demo', statement: SFAX })],
      { requirement_matches: [{ requirement: 'Node.js server', matches: [v2Match('demo_Project_Municipality_EServices', 'demo', -2.358, ['node.js', 'javascript'], SFAX),
        v2Match('CV_11_Chloe_Martin.pdf', 'cv_document', -3.595, ['node.js', 'javascript'], 'Developed a responsive web portal using React, Node.js and PostgreSQL that served 1 200+ internal users.'),
        v2Match('demo_TechStack_PublicSector_Cloud', 'demo', -5.286, ['node.js', 'javascript'], DEMO_ST.web)] }], data_mode: 'demo' }));
    const x = r.rag.matrix[0], p = await proposal(r), row = p.matrix.rows[0];
    ok(x.best_doc === 'CV_11_Chloe_Martin.pdf' && x.origin === 'cv_document' && x.best_rerank === -3.59 && !r.rag.demo_evidence.length, 'score of the proof document');
    ok(row.rerank_score === -3.59 && /^Developed a responsive web portal/.test(row.justification), 'proposal rerank_score');
    return `best_doc ${x.best_doc}, best_rerank ${x.best_rerank}; proposal rerank_score ${row.rerank_score}`;
  });
C(A5, 'Declared value given as a range (real)', 'T180cy2h (BOAMP 26-101637, "Prestation informatique"): estimated_value "80000-215000 EUR" (the fourchette Map Records writes); comparable contracts from 200 000 (median 250 000), from 500 000 (median 600 000), up to 20 000 (median 15 000); control: the real single values "78 772,50EUR", "20,000,000Euro", "175000 EUR", "4 166 666,00EUR", "2768322", and a leading span of years "2024-2027 : 500 000 €"',
  'declared_value_amount 215000 (the high bound, the buyer\'s ceiling) + declared_value_range {low 80000, high 215000}; no "far below" risk against contracts from 200 000 (its low bound alone, 80 000, did), "far below" from 500 000 and "far above" up to 20 000, naming the range; the single values unchanged, range null; the span of years is no range (range null, never 2024 to 2027)', 'PR1', async ok => {
    const budget = (low, median, high) => ({ low, median, high, min: low, max: high, currency: 'EUR', confidence: 'medium', comparables: 5, spread: null, outliers: [], basis: 'DECP awards' });
    const go = (v, b) => proposal(ragTender({ tender_id: 'T180cy2h', title: 'Prestation informatique', source: 'boamp', estimated_value: v,
      market: { status: 'studied', declared_value: v, budget: b, competitors: [], comparables: [], median_bids: null } }));
    const RANGE = '80000-215000 EUR', risk = p => p.analysis.risks.filter(x => /^Declared value/.test(x));
    const [mid, high, low] = [await go(RANGE, budget(200000, 250000, 300000)), await go(RANGE, budget(500000, 600000, 700000)), await go(RANGE, budget(8000, 15000, 20000))];
    ok(mid.competition.declared_value === RANGE && mid.competition.declared_value_amount === 215000 && JSON.stringify(mid.competition.declared_value_range) === '{"low":80000,"high":215000}' && !risk(mid).length, 'high bound, no false risk');
    ok(risk(high).join() === 'Declared value (80000-215000) far below comparable contracts (median 600000)'
      && risk(low).join() === 'Declared value (80000-215000) far above comparable contracts (median 15000): maybe a multi-year ceiling', 'range risks');
    const singles = [];
    for (const v of ['78 772,50EUR', '20,000,000Euro', '175000 EUR', '4 166 666,00EUR', '2768322']) singles.push((await go(v, null)).competition);
    ok(singles.map(c => c.declared_value_amount).join() === '78772.5,20000000,175000,4166666,2768322' && singles.every(c => c.declared_value_range === null), 'single values');
    const years = (await go('2024-2027 : 500 000 €', null)).competition;
    ok(years.declared_value_range === null && years.declared_value_amount !== 2027, 'a span of years is no money range');
    return `${RANGE}: amount ${mid.competition.declared_value_amount}, range ${JSON.stringify(mid.competition.declared_value_range)}; risks [${risk(high)}] [${risk(low)}]; singles ${singles.map(c => c.declared_value_amount).join(', ')}; "2024-2027 : 500 000 €" range ${JSON.stringify(years.declared_value_range)}`;
  });
C(A3, 'Buyer\'s past notices: a bare "site" is no web site (real)', 'Parse Research past_projects of OPPIC ("ARABIE SAOUDITE – KING KHALED PALACE (RIYADH) - Mission de programmation pour la réutilisation du site", digital:false; "Opération d’assainissement des réseaux enterrés …", digital:true), of the Ministère de l\'Intérieur ("Avis d\'attribution - Prestations multiservices et multitechniques pour le site de l’administration centrale du", digital:false; "AOO AMOA SI", digital:false) and of City\'up (972) (3 IT notices); controls: the Shom\'s "... sur le site du Shom à Brest" (real) and generic web titles ("Refonte du site institutionnel de la ville", "Hébergement et maintenance du site extranet", "Site e-commerce", an intranet, "Refonte du site de la ville") against "Création d\'un site de compostage" and "TRAVAUX SI NECESSAIRE"',
  'past_digital_projects: OPPIC "Marché d’infogérance informatique" only (no building site, no sewer network); the Ministère "DEMATERIALISATION …" and "AOO AMOA SI" (SI in capitals = information system), never the multiservices site; City\'up\'s 3 IT notices kept; the 5 web titles kept (a site named by its web kind or its web redesign), no Shom laboratory, no composting site, no conjunction "SI"', 'PR1', async ok => {
    const pp = rows => rows.map(([title, date, id, kind, digital]) => ({ title, date, source: 'BOAMP', id, kind, digital }));
    const OPPIC = pp([['Marché d’infogérance informatique', '2026-09-22', '26-91336', 'notice', true],
      ['Opération d’assainissement des réseaux enterrés et de restauration de 5 cours (Bonaparte, Honneur, Loges, Mât', '2026-09-16', '26-88830', 'notice', true],
      ['Marché de prestations intellectuelles pour les missions d’ordonnancement, de pilotage et de coordination, de l', '2026-09-30', '26-93844', 'notice', false],
      ['Travaux de mise en conformité des installations électriques et du système de sécurité incendie du château de S', '2026-09-07', '26-86523', 'notice', false],
      ['MISSION DE PROGRAMMATION POUR LE PROJET DE RESTRUCTURATION DU MUSEE GUIMET', '2026-09-01', '26-84389', 'award', false],
      ['ARABIE SAOUDITE – KING KHALED PALACE (RIYADH) - Mission de programmation pour la réutilisation du site', '2026-08-19', '26-81071', 'notice', false]]);
    const MININT = pp([['DEMATERIALISATION DES COUPONS REPAS UTILISES PAR LES SGCD DANS LE CADRE DE CONVENTIONNEMENT AVEC LES RESTAURAT', '2026-09-06', '26-86361', 'award', true],
      ['Conception et animation de formations et d\'accompagnement individuels ou collectifs à destination des agents d', '2026-10-18', '26-100643', 'notice', false],
      ['AOO AMOA SI', '2026-10-16', '26-99707', 'award', false], ['FOURNITURE DE PORTIERS DE RUE', '2026-10-09', '26-97166', 'notice', false],
      ['Avis d\'attribution - Prestations multiservices et multitechniques pour le site de l’administration centrale du', '2026-10-09', '26-97239', 'award', false],
      ['Acquisition et maintenance de systèmes de punchage semi-automatique sur support papier FTA pour les laboratoir', '2026-09-08', '26-86478', 'award', false]]);
    const CITYUP = pp([['CONCEPTION, DEVELOPPEMENT ET MAINTENANCE DEVELOPPEMENT D’APPLICATIONS WEB ET MOBILES', '2026-01-31', '26-10457', 'notice', true],
      ['ATTRIBUTION DE MARCHE - INFOGERANCE ET FOURNITURE DE MATERIELS INFORMATIQUES LOTS 2 ET 3', '2024-05-25', '24-59996', 'award', true],
      ['INFOGERANCE ET FOURNITURE DE MATERIELS INFORMATIQUES', '2024-03-16', '24-31958', 'notice', true],
      ['Prestations d\'entretien et de nettoyage de locaux', '2026-01-13', '26-4195', 'notice', false], ['Prestations d\'archivage externalisé', '2025-08-29', '25-96804', 'notice', false]]);
    const past = async (name, projects) => (await proposal(ragTender({ buyer: { name, country: 'FR', contacts: {} }, buyer_profile: { research_status: 'researched', past_projects: projects } }))).buyer_profile.past_digital_projects.map(x => x.title);
    const WEB = ['Refonte du site institutionnel de la ville', 'Hébergement et maintenance du site extranet', 'Site e-commerce', 'Mise en place d\'un intranet', 'Refonte du site de la ville'];
    const OTHER = pp([['Construction d’un laboratoire de métrologie et de chimie océanographique sur le site du Shom à Brest', '2026-09-10', '26-87000', 'notice', false],
      ['Création d\'un site de compostage', '2026-05-01', null, 'notice', false], ['TRAVAUX SI NECESSAIRE', '2026-04-01', null, 'notice', false], ...WEB.map(x => [x, '2026-03-01', null, 'notice', true])]);
    const [o, mi, cu, ot] = [await past('OPPIC', OPPIC), await past('Ministère de l\'Intérieur', MININT), await past('City\'up (972)', CITYUP), await past('Ville', OTHER)];
    ok(JSON.stringify(o) === JSON.stringify(['Marché d’infogérance informatique']), 'OPPIC: no building site, no sewer network');
    ok(JSON.stringify(mi) === JSON.stringify([MININT[0].title, 'AOO AMOA SI']), 'Ministère: no multiservices site, AMOA SI kept');
    ok(cu.length === 3 && cu.every(x => /INFORMATIQUES|APPLICATIONS WEB/.test(x)), 'City\'up: 3 IT notices');
    ok(JSON.stringify(ot) === JSON.stringify(WEB), 'web sites kept; Shom laboratory, composting site, conjunction SI dropped');
    return `OPPIC [${o.join(' | ')}]; Ministère [${mi.map(x => x.slice(0, 40)).join(' | ')}]; City'up ${cu.length}; controls kept [${ot.join(' | ')}]`;
  });

// ======================= 5. market edge cases (Parse Market, Build Proposal Input) =======================
C(A5, 'Framework ceilings', 'chosen: 3 priced contracts (45k, 60k, 75k) + a DECP "ACCORD-CADRE …" (2 M) + a TED fw=yes (1.5 M)',
  'budget from the 3 priced ones (median 60 000); the 2 frameworks left out (basis says so); their winners still listed, without amount', 'MK2', async ok => {
    const rows = [award('D1', { amount: 45000, winners: 'SOPRA STERIA', bids: 3 }), award('D2', { amount: 60000, winners: 'ATOS', bids: 4 }), award('D3', { amount: 75000, winners: 'CGI', bids: 2 }),
      award('D4', { amount: 2000000, winners: 'CAPGEMINI', fw: '?', title: 'ACCORD-CADRE plateforme de téléservices et démarches en ligne' }),
      award('T5', { amount: 1500000, winners: 'ORANGE BUSINESS SERVICES', fw: 'yes', src: 'TED', title: 'Plateforme de téléservices régionale' })];
    const m = (await market(marketAgent({ comparable_ids: ['D1', 'D2', 'D3', 'D4', 'T5'] }, [similar(rows)]))).market;
    const cap = m.competitors.find(c => c.name === 'CAPGEMINI');
    ok(m.budget.comparables === 3 && m.budget.median === 60000 && m.budget.max === 75000 && /2 framework agreement\(s\) left out/.test(m.budget.basis), 'budget');
    ok(cap && cap.avg_amount === null, 'framework winner listed without amount');
    return `budget ${m.budget.low} / ${m.budget.median} / ${m.budget.high} (${m.budget.basis})`;
  });
C(A5, 'Outlier', 'chosen: 40k, 50k, 60k, 70k and one 18 000 000 contract', 'the 18 M contract listed as an outlier, not in the range (max 70 000)', 'MK2', async ok => {
  const rows = [40000, 50000, 60000, 70000].map((a, k) => award(`D${k}`, { amount: a, winners: `VENDOR ${k}` })).concat(award('DX', { amount: 18000000, winners: 'BIG INTEGRATOR', title: 'Plateforme de téléservices et GRC nationale' }));
  const m = (await market(marketAgent({ comparable_ids: ['D0', 'D1', 'D2', 'D3', 'DX'] }, [similar(rows)]))).market;
  ok(m.budget.max === 70000 && m.budget.outliers.length === 1 && m.budget.outliers[0].id === 'DX' && /1 outlier/.test(m.budget.basis), 'outlier');
  return `range ${m.budget.min}-${m.budget.max}, outliers ${m.budget.outliers.map(o => o.id)}, confidence ${m.budget.confidence}`;
});
C(A5, 'No data for a country', 'Moroccan tender: both tools return "NO RESULTS"; agent: no ids, "No public award data was found for Morocco."',
  'status no_data, no budget, no positioning (nothing to base it on); proposal competition NO_DATA', 'MK2, PR1', async ok => {
    const task = marketTask({ country: 'MA', country_name: 'Morocco', cpv: [] });
    const t = await market(marketAgent({ comparable_ids: [], positioning: 'No public award data was found for Morocco.' },
      [similar([], 'TOTAL TED 0 found'), step('buyer_awards', { buyer_name: 'Ville de Testville', country: 'MA' }, awardsObs([], 'TOTAL TED 0 found'))]), task);
    ok(t.market.status === 'no_data' && t.market.budget === null && t.market.positioning === '', 'no_data');
    const p = await proposal(ragTender({ market: t.market })); ok(p.competition.status === 'NO_DATA', 'NO_DATA');
    return `status ${t.market.status}, competition ${p.competition.status}`;
  });
C(A5, 'Award APIs down', 'similar_awards: "TED error: Request failed with status code 503, DECP error: timeout…"; buyer_awards: "ERROR: getaddrinfo ENOTFOUND api.ted.europa.eu"',
  'status tools_failed (not "no data in the market"), the errors in checks; proposal competition FAILED', 'MK2, PR1', async ok => {
    const t = await market(marketAgent({ comparable_ids: [] }, [similar([], 'TOTAL TED error: Request failed with status code 503, DECP error: timeout of 25000ms exceeded'),
      step('buyer_awards', { buyer_name: 'Ville de Testville' }, 'ERROR: getaddrinfo ENOTFOUND api.ted.europa.eu')]));
    ok(t.market.status === 'tools_failed' && t.market.checks.some(c => /TED error: Request failed with status code 503/.test(c)) && t.market.checks.some(c => /ENOTFOUND/.test(c)), 'tools_failed');
    const p = await proposal(ragTender({ market: t.market })); ok(p.competition.status === 'FAILED' && p.competition.detail === 'tools_failed', 'FAILED');
    return `status ${t.market.status}; checks ${t.market.checks.join(' | ')}`;
  });
C(A5, 'One award API down', 'TED error but DECP returns 3 rows; agent picks them', 'studied from the rows that came back; the TED error kept in checks', 'MK2', async ok => {
  const t = await market(marketAgent({ comparable_ids: ['D1', 'D2', 'D3'] }, [similar(ROWS3, 'TOTAL DECP 3 found, TED error: Request failed with status code 503')]));
  ok(t.market.status === 'studied' && t.market.budget.comparables === 3 && t.market.checks.some(c => /TED error/.test(c)), 'studied'); return `status ${t.market.status}, ${t.market.checks}`;
});
C(A5, 'Unknown ids, invented numbers and names', 'ids D1-D3 + "D999"; positioning with "won 2", "The usual winner is Capgemini.", "about 3 bids", "400 000 EUR"; budget comment "around 52 000 EUR"',
  'D999 ignored (check); sentences with Capgemini and 400 000 removed; the ones matching the rows (2 wins, 3 bids, 52 000) kept', 'MK2', async ok => {
    const pos = ['SOPRA STERIA won 2 of these contracts.', 'The usual winner is Capgemini.', 'Expect about 3 bids.', 'Budgets reach 400 000 EUR.'];
    const t = await market(marketAgent({ comparable_ids: ['D1', 'D2', 'D3', 'D999'], positioning: pos.join(' '), budget_comment: 'The likely budget is around 52 000 EUR.' }, [similar(ROWS3)]));
    ok(t.market.checks.some(c => /1 comparable id\(s\) not in the tool results ignored/.test(c)), 'unknown id');
    ok(t.market.positioning === `${pos[0]} ${pos[2]}` && t.market.budget_comment === 'The likely budget is around 52 000 EUR.', 'sentences');
    return `positioning "${t.market.positioning}"; budget comment "${t.market.budget_comment}"`;
  });
C(A5, 'Invented competitor as the subject of a sentence', 'rows won by SOPRA STERIA and ATOS; positioning "Capgemini usually wins these contracts.", "Accenture remporte souvent ces marchés."; controls: "SOPRA STERIA won 2 of them.", "Expect about 3 bids.", "Bids are few.", "Typically ATOS wins once.", and advice or adjectives as first words (review of 2026-10-20): "Leverage OliveSoft experience ...", "Stress hosting in France ...", "Showcase ...", "Avoid a low price.", "OliveSoft\'s portal experience is an asset.", "Smaller firms rarely win.", "Strong references matter."; budget comment "Capgemini quoted 52 000 EUR."',
  'the Capgemini and Accenture sentences removed (not winners of the chosen contracts: a first word is checked when it reads as a name, here the subject of wins / remporte / quoted); the controls stay (a winner, usual openers, advice, the company\'s own name with its possessive)', 'MK2', async ok => {
  const keep = ['SOPRA STERIA won 2 of them.', 'Expect about 3 bids.', 'Bids are few.', 'Typically ATOS wins once.', 'Leverage OliveSoft experience with citizen portals.',
    'Stress hosting in France and fast support.', 'Showcase similar municipal projects.', 'Avoid a low price.', 'OliveSoft\'s portal experience is an asset.', 'Smaller firms rarely win.', 'Strong references matter.'];
  const t = await market(marketAgent({ comparable_ids: ['D1', 'D2', 'D3'], positioning: ['Capgemini usually wins these contracts.', ...keep.slice(0, 5), 'Accenture remporte souvent ces marchés.', ...keep.slice(5)].join(' '),
    budget_comment: 'Capgemini quoted 52 000 EUR.' }, [similar(ROWS3)]));
  ok(!/Capgemini|Accenture/.test(t.market.positioning) && t.market.budget_comment === '', 'removed'); ok(t.market.positioning === keep.join(' '), 'controls kept');
  return `positioning "${t.market.positioning}", budget comment "${t.market.budget_comment}"`;
});
C(A5, 'Same contract from TED and DECP', 'TED row (SOPRA STERIA, 100 000, 2026-03-01, 4 bids) + DECP row (SOPRA STERIA, 101 000, 2026-03-20) + one other', 'counted once (the TED row, more information): 2 comparables, SOPRA STERIA 1 win', 'MK2', async ok => {
  const rows = [award('T1', { amount: 100000, winners: 'SOPRA STERIA', bids: 4, src: 'TED' }), award('D1', { amount: 101000, winners: 'SOPRA STERIA', date: '2026-03-20' }), award('D2', { amount: 80000, winners: 'ATOS' })];
  const m = (await market(marketAgent({ comparable_ids: ['T1', 'D1', 'D2'] }, [similar(rows)]))).market;
  ok(m.comparables.length === 2 && m.comparables.some(c => c.id === 'T1') && m.competitors.find(c => c.name === 'SOPRA STERIA').wins === 1, 'once');
  return `comparables ${m.comparables.map(c => c.id)}, SOPRA STERIA wins ${m.competitors.find(c => c.name === 'SOPRA STERIA').wins}`;
});
C(A5, 'The tender itself chosen as comparable', 'agent picks a row with the tender\'s own title and buyer', 'excluded from the comparables', 'MK2', async ok => {
  const self = award('DS', { amount: 90000, winners: '', buyer: 'Ville de Testville', title: 'Développement d’une plateforme de téléservices' });
  const m = (await market(marketAgent({ comparable_ids: ['D1', 'D2', 'D3', 'DS'] }, [similar([...ROWS3, self])]))).market;
  ok(!m.comparables.some(c => c.id === 'DS') && m.comparables.length === 3, 'excluded'); return `comparables ${m.comparables.map(c => c.id)}`;
});
C(A5, 'Unrelated contract chosen', 'agent picks a school catering contract (CPV 55520000, 900 000) with 3 software ones for a CPV 72 tender', 'catering left out of budget and competitors (check)', 'MK2', async ok => {
  const cat = award('DC', { amount: 900000, winners: 'API RESTAURATION', cpv: '55520000', title: 'Restauration collective des écoles' });
  const m = (await market(marketAgent({ comparable_ids: ['D1', 'D2', 'D3', 'DC'] }, [similar([...ROWS3, cat])]))).market;
  ok(!m.competitors.some(c => c.name === 'API RESTAURATION') && m.budget.max === 61000 && m.checks.some(c => /share no word with the tender/.test(c)), 'left out');
  return `budget max ${m.budget.max}, competitors ${m.competitors.map(c => c.name)}`;
});
C(A5, 'Market agent error', 'agent error item "429 Too Many Requests", no tool call', 'status study_failed, no budget; proposal competition FAILED', 'MK2, PR1', async ok => {
  const t = await market({ error: { message: '429 Too Many Requests' } });
  const p = await proposal(ragTender({ market: t.market }));
  ok(t.market.status === 'study_failed' && t.market.budget === null && p.competition.status === 'FAILED', 'failed'); return `status ${t.market.status}, competition ${p.competition.status}`;
});
C(A5, 'Lab-analyser market (real)', 'real Competitor & Budget Agent run for RESAH (19 ids chosen; budget comment "from €500,000 to €30 million … €1M to €10M … €1M to €5M")',
  'studied in EUR; the budget comment, whose amounts are not in the chosen contracts, removed', 'MK2', async ok => {
    const x = REAL.market.find(m => /AUTOMATES/.test(m.item.title));
    const t = (await run('Parse Market', [x.agent], { 'Select Market Studies': [x.item] }))[0];
    ok(t.market.status === 'studied' && t.market.budget.currency === 'EUR' && t.market.budget_comment === '', 'comment removed');
    return `budget ${t.market.budget.low} / ${t.market.budget.median} / ${t.market.budget.high} EUR (${t.market.budget.comparables} contracts, ${t.market.budget.confidence}); ${t.market.checks.length} check(s)`;
  });

// ======================= run of 2026-10-20 (BOAMP + demo + URL agent): buyer research, market study, public API tools =======================
// the City'up (972) research as recorded: Select Buyers item + the agent's 5 tool calls (web_search: 2 of its 5 rows)
const cityup = o => buyer({ buyer_key: 'city up 972', buyer_id: 'Bdjlu99', name: 'City\'up (972)', search_name: 'City\'up (972)',
  tender_titles: ['Prestations de développement d\'agents LLM et services associés'], tenders: [{ tender_id: 'T1vll2ea', external_id: null, title: 'Prestations de développement d\'agents LLM et services associés' }],
  notice_contacts: { emails: ['cu.commandepublique@cityup.mq'], phones: [], websites: ['https://v2.marches-securises.fr'], addresses: ['Fort de France, 97200'] },
  exclude_hosts: ['boamp-datadila.opendatasoft.com', 'host.docker.internal:8004', 'francemarches.com', 'domainetat.tn'], ...o });
const CITYUP_REG = 'REG | CITY\'UP (CFTU) | siren=431938091 | siret=43193809100110 | addr=19 RUE DE LA LIBERTE 97200 FORT DE FRANCE | city=FORT DE FRANCE | nature=5515 | public=no | staff=11 | staff_year=2024 | ca=2024:0\n'
  + 'REG | CITY\'UP MOBILITE | siren=924930217 | siret=92493021700014 | addr=19 RUE DE LA LIBERTE 97200 FORT-DE-FRANCE | city=FORT-DE-FRANCE | nature=5710 | public=no | staff=NN | staff_year=\n'
  + 'REG | CITY\'UP DIGITAL (TU DEV) | siren=814097978 | siret=81409797800021 | addr=STDE. LOCAL 8B IMM. CTRE. D AFFAIRE 7 RUE GEORGES EUCHARIS 97200 FORT-DE-FRANCE | city=FORT-DE-FRANCE | nature=5710 | public=no | staff=01 | staff_year=2024';
const cityupAgent = (o = {}) => researchAgent({ buyer_type: 'private_company', size_hint: 'small', summary: 'City\'up (CFTU) is a private company based in Fort-de-France, Martinique, with 11 employees as of 2024.', ...o }, [
  step('wikidata_lookup', { q: 'City\'up' }, 'WD | City\'up |  | id=Q115468931 | match=label:City\'up\nWD | City upon a Hill | phrase | id=Q367202 | match=label:City upon a Hill'),
  step('registry_search', { q: 'City\'up' }, CITYUP_REG), step('boamp_history', { buyer_name: 'CITY\'UP (CFTU)' }, 'NO RESULTS'), step('decp_awards', { siren: '431938091' }, 'NO RESULTS'),
  step('web_search', { query: 'City\'up Fort-de-France official website' }, 'WEB | https://tourcrib.com/en/martinique/city/fort-de-france | Fort de France: Things to visit and useful information - Tourcrib | Located on the west coast of Martinique, the city of Fort de France is the economic heart of the island.\n'
    + 'WEB | https://en.wikipedia.org/wiki/Fort-de-France | Fort-de-France - Wikipedia | ## External links - [Official website](http://www.fortdefrance.fr/)')]);
C(A3, 'Wikidata row without a website (real City\'up)', 'real City\'up (972) research: Wikidata "WD | City\'up |  | id=Q115468931" (no description, no website=), no search title match; notice email cu.commandepublique@cityup.mq; 2nd run without that email',
  'never "https://undefined": website = the notice email\'s domain https://cityup.mq (spelled with the buyer name\'s words), else none; the label-only Wikidata hit is no fact (wikidata false, enrichment partial, no "Wikidata:" evidence, no wikidata_id)', 'BU2', async ok => {
    const b = await research(cityup(), cityupAgent());
    const n = await research(cityup({ notice_contacts: { emails: [], phones: [], websites: ['https://v2.marches-securises.fr'], addresses: [] } }), cityupAgent());
    ok(b.profile.official_website === 'https://cityup.mq' && b.profile.contacts.sources.website === 'notice email domain', 'email domain');
    ok(n.profile.official_website === '' && n.profile.contacts.website === '' && n.profile.contacts.sources.website === null, 'no website without it');
    ok(!b.facts.wikidata && b.enrichment_status === 'partial' && b.profile.wikidata_id === null, 'label-only hit is no fact');
    return `website "${b.profile.official_website}" (${b.profile.contacts.sources.website}); without the email "${n.profile.official_website}"; facts ${Object.keys(b.facts).filter(k => b.facts[k])}, ${b.enrichment_status}, wikidata_id ${b.profile.wikidata_id}`;
  });
C(A3, 'Notice email domain as the website', '"Ville de Testville": notice emails testville.mairie@gmail.com + marches@testville.fr; 2nd run gmail only; 3rd run contact@cdg-testshire.fr (another body)',
  'testville.fr taken (spelled with the name), never the mailbox provider nor another body\'s domain', 'BU2', async ok => {
    const nc = emails => ({ notice_contacts: { emails, phones: [], websites: [], addresses: [] } });
    const a = await research(buyer(nc(['testville.mairie@gmail.com', 'marches@testville.fr'])), researchAgent({}, [step('registry_search', { q: 'Ville de Testville' }, REG_TESTVILLE)]));
    const g = await research(buyer(nc(['testville.mairie@gmail.com'])), researchAgent({}, [step('registry_search', { q: 'Ville de Testville' }, REG_TESTVILLE)]));
    const o = await research(buyer(nc(['contact@cdg-testshire.fr'])), researchAgent({}, [step('registry_search', { q: 'Ville de Testville' }, REG_TESTVILLE)]));
    ok(a.profile.official_website === 'https://testville.fr' && g.profile.official_website === '' && o.profile.official_website === '', 'own domain only');
    return `"${a.profile.official_website}" / gmail only "${g.profile.official_website}" / other body "${o.profile.official_website}"`;
  });
C(A3, 'SEM typed private company (real City\'up)', 'real City\'up research: registry match "CITY\'UP (CFTU) | nature=5515" (SA d\'économie mixte); agent buyer_type private_company; 2nd: a commune (7210) typed private_company; 3rd: a SAS (5710) typed private_company',
  'public legal form wins over private / other / unknown: public_company (check names the legal form), local_authority; the private SAS stays private_company', 'BU2', async ok => {
    const b = await research(cityup(), cityupAgent());
    const c = await research(buyer(), researchAgent({ buyer_type: 'private_company' }, [step('registry_search', { q: 'Ville de Testville' }, REG_TESTVILLE)]));
    const s = await research(cityup({ name: 'City\'up Mobilité', search_name: 'City\'up Mobilité', buyer_key: 'city up mobilite' }), researchAgent({ buyer_type: 'private_company' }, [step('registry_search', { q: 'City\'up Mobilité' }, CITYUP_REG)]));
    ok(b.profile.buyer_type === 'public_company' && b.profile.checks.some(x => /from the registry legal form 5515 \(agent said private_company\)/.test(x)), 'SEM -> public_company');
    ok(c.profile.buyer_type === 'local_authority' && s.profile.legal_form === '5710' && s.profile.buyer_type === 'private_company', 'commune / SAS');
    return `SEM ${b.profile.buyer_type}; commune ${c.profile.buyer_type}; SAS (${s.profile.legal_name}) ${s.profile.buyer_type}`;
  });
C(A3, 'decp_awards with the matched SIREN, no row (real City\'up)', 'real: decp_awards {siren: "431938091"} = the matched registry SIREN, answer "NO RESULTS"; 2nd run: decp_awards with another SIREN (814097978)',
  'no "not queried with the matched SIREN" check, but "awards: no DECP contract for SIREN 431938091"; the wrong-SIREN check stays for the 2nd run', 'BU2', async ok => {
    const b = await research(cityup(), cityupAgent());
    const w = await research(cityup(), researchAgent({}, [step('registry_search', { q: 'City\'up' }, CITYUP_REG), step('decp_awards', { siren: '814097978' }, 'TOTAL 1\nDECP | 2025-03-02 | 45000 | Refonte du site internet | cpv=72413000 | bids=3 | supplier_siret=')]));
    ok(!b.profile.checks.some(x => /not queried with the matched SIREN/.test(x)) && b.profile.checks.includes('awards: no DECP contract for SIREN 431938091'), 'right SIREN');
    ok(w.profile.checks.includes('awards ignored: not queried with the matched SIREN') && !w.facts.awards, 'wrong SIREN');
    return `${b.profile.checks.filter(x => /awards/.test(x)).join('; ')} | wrong SIREN: ${w.profile.checks.filter(x => /awards/.test(x)).join('; ')}`;
  });
C(A3, 'boamp_history searched under another name', '"Ville de Testville": boamp_history only with the registry name "COMMUNE DE TESTVILLE" -> NO RESULTS; real City\'up: "CITY\'UP (CFTU)" (the tool drops parentheses: "CITY\'UP")',
  'check "history not searched under the published name"; none for City\'up (its query reaches "City\'up (972)")', 'BU2', async ok => {
    const t = await research(buyer(), researchAgent({}, [step('registry_search', { q: 'Ville de Testville' }, REG_TESTVILLE), step('boamp_history', { buyer_name: 'COMMUNE DE TESTVILLE' }, 'NO RESULTS')]));
    const c = await research(cityup(), cityupAgent());
    ok(t.profile.checks.some(x => /^history not searched under the published name "Ville de Testville" \(searched: COMMUNE DE TESTVILLE\)/.test(x)), 'check');
    ok(!c.profile.checks.some(x => /history not searched/.test(x)), 'none for City\'up');
    return t.profile.checks.find(x => /history/.test(x)) || 'no history check';
  });
C(A3, 'Fictional buyers of a demo source (real)', 'the run\'s buyers, maxBuyersToResearch 3: City\'up (francemarches, 7 days left), 2 "(démo)" buyers of the demo source (18, 21 days), Vimeu (25), SDET (28), EPCC Metz (32); a demo tender also seen on BOAMP',
  'demo buyers: skipped_demo (no slot); the 3 slots go to City\'up, Vimeu, SDET; EPCC: not_researched_budget; a buyer also seen on a real source is real', 'BU1', async ok => {
    const t = (id, name, source, days, o = {}) => ({ tender_id: id, buyer_key: fold(name), buyer_id: `B${id}`, survivor: true, too_late: false, days_left: days, title: `Tender ${id}`, source, language: 'fr',
      source_url: `https://fixture.test/${id}`, analysis: { fit: 'high' }, buyer: { name, country: 'FR', contacts: {} }, ...o });
    const fold = s => s.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, ' ').trim();
    const ts = [t('T1vll2ea', 'City\'up (972)', 'francemarches', 7), t('T1xiyyfm', 'Communauté de Communes de Sampleville (démo)', 'demo', 18), t('T1w50xyr', 'Direction Régionale de la Santé de Sampleville (démo)', 'demo', 21),
      t('T1prbaoh', 'Communauté de communes du Vimeu', 'boamp', 25), t('T180cy2h', 'Syndicat Départemental d\'Energie du Tarn (SDET)', 'boamp', 28), t('T136zpko', 'EPCC Metz en scènes', 'boamp', 32)];
    const cfg = { ...CFG, sources: [...CFG.sources, { type: 'api', name: 'demo', demo: true }] };
    const out = await run('Select Buyers', ts, { '00 - Config': [cfg] });
    const st = Object.fromEntries(out.map(b => [b.name, b.research_status]));
    ok(st['Communauté de Communes de Sampleville (démo)'] === 'skipped_demo' && st['Direction Régionale de la Santé de Sampleville (démo)'] === 'skipped_demo', 'demo skipped');
    ok(out.filter(b => b._run).map(b => b.name).join() === 'City\'up (972),Communauté de communes du Vimeu,Syndicat Départemental d\'Energie du Tarn (SDET)' && st['EPCC Metz en scènes'] === 'not_researched_budget', 'slots to real buyers');
    const seen = await run('Select Buyers', [t('T1xiyyfm', 'Communauté de Communes de Sampleville (démo)', 'demo', 18, { also_seen_in: [{ source: 'boamp', url: 'https://www.boamp.fr/x' }] })], { '00 - Config': [cfg] });
    ok(seen[0].research_status === 'researched', 'also on a real source');
    return Object.entries(st).map(([k, v]) => `${k.slice(0, 28)}: ${v}`).join('; ');
  });
C(A5, 'Market slots and demo tenders; buyer SIREN from the notice', 'maxMarketStudies 3: 2 demo tenders (fit high, coverage 0.9) + 2 real ones (high 0.3, medium 0.5); the real City\'up notice text "N° National d\'identification : 43193809100094"; EPCC Metz with the notice SIRET 50962999400013 mapped as buyer.siret; a 2nd run with demo tenders only',
  'the 2 real tenders + 1 demo (a demo tender takes only a slot no real one needs); demo only: they still get studies; buyer_siren 431938091 from the notice text, 509629994 from buyer.siret (Luhn-checked), "" when there is none', 'MK1', async ok => {
    const body = 'Section 1 - Identification de l\'acheteur\n\nNom complet de l\'acheteur : City\'up (972)\n\nType de Numéro national d\'indentification : SIRET\n\nN° National d\'identification : 43193809100094\n\nVille : Fort de France';
    const mk = (id, source, fit, coverage, o = {}) => ({ tender_id: id, title: `Tender ${id}`, survivor: true, too_late: false, source, analysis: { fit, tender_type: 'software_build' }, rag: { coverage },
      effective_deadline: '2026-11-20', buyer: { name: `Buyer ${id}`, country: 'FR', contacts: {} }, cpv: [], body_text: '', ...o });
    const cfg = { ...CFG, limits: { ...CFG.limits, maxMarketStudies: 3 }, sources: [...CFG.sources, { type: 'api', name: 'demo', demo: true }] };
    const out = await run('Select Market Studies', [mk('D1', 'demo', 'high', 0.9), mk('D2', 'demo', 'high', 0.9), mk('R1', 'francemarches', 'high', 0.3, { body_text: body, buyer: { name: 'City\'up (972)', country: 'FR', contacts: {} } }),
      mk('R2', 'boamp', 'medium', 0.5, { buyer: { name: 'EPCC Metz en scènes', country: 'FR', siret: '50962999400013', contacts: {} } })], { '00 - Config': [cfg] });
    const chosen = out.filter(t => t._market).map(t => t.tender_id).sort().join();
    const demoOnly = (await run('Select Market Studies', [mk('D1', 'demo', 'high', 0.9), mk('D2', 'demo', 'high', 0.9)], { '00 - Config': [cfg] })).filter(t => t._market).length;
    const sirenOf = id => out.find(t => t.tender_id === id).market_task.buyer_siren;
    ok(chosen === 'D1,R1,R2' && demoOnly === 2, 'slots'); ok(sirenOf('R1') === '431938091' && sirenOf('R2') === '509629994' && sirenOf('D1') === '', 'SIREN from the notice');
    return `studied ${chosen}; demo only: ${demoOnly}; buyer_siren City'up ${sirenOf('R1')}, EPCC ${sirenOf('R2')}, demo "${sirenOf('D1')}"`;
  });
// the EPCC Metz en scènes study as recorded (T136zpko, no CPV): 11 of the 31 rows of its similar_awards call
const EPCC_TASK = marketTask({ title: 'RENOUVELLEMENT DE LA SOLUTION DE BILLETTERIE ET DE GESTION DE LA RELATION CLIENT (GRC)', buyer: 'EPCC Metz en scènes', cpv: [],
  summary: 'La consultation porte sur la fourniture, la mise en oeuvre, l\'hébergement et la maintenance d\'une solution de billetterie et de gestion de la relation client, ainsi que du matériel associé, pour les trois sites de l\'EPCC Metz en Scènes.',
  requirements: ['web and mobile applications', 'CRM integration'] });
const EPCC_ROWS = [
  'AWARD | D1p98oxj | 2026-10-08 | amount=8345 | cur=EUR | buyer=COMMUNE DE MARSEILLE (DIRECTION RESSOURCES HUMAINES) | winners=MONNAIE SERVICES | bids=3 | cpv=72000000 | fw=no | src=DECP | title=Acquisition d’un logiciel et d’un système de billetterie multi-activités pour le Château de la Buzine',
  'AWARD | Dcz8cmu | 2026-08-26 | amount=75000 | cur=EUR | buyer=COMMUNE DE REIMS (MAIRIE) | winners=SECUTIX | bids=1 | cpv=72260000 | fw=yes | src=DECP | title=Abonnement (maintenance et support) et hébergement de la solution de billetterie multi-établissements SECUTIX ',
  'AWARD | Du8l9kf | 2026-03-19 | amount=43078 | cur=EUR | buyer=COMMUNE DE CAMBO LES BAINS (MAIRIE) | winners=DIPTICK | bids=2 | cpv=72222300 | fw=no | src=DECP | title=Fourniture, installation et maintenance dun logiciel de billetterie pour la commune de Cambo-les-Bains',
  'AWARD | Dfokf3t | 2026-10-02 | amount=180457 | cur=EUR | buyer=OFFICE MUNICIPAL TOURISME BIARRITZ TOURISME (DESTINATION BIARRITZ) | winners=LAB EVENT | bids=4 | cpv=72268000 | fw=no | src=DECP | title=Fourniture, déploiement complet et maintenance d’une solution logicielle de Gestion de la Relation Client (GRC',
  'AWARD | D1rl9qaf | 2026-07-06 | amount=600000 | cur=EUR | buyer=DEPARTEMENT DE L\' ESSONNE | winners=ENTR\'OUVERT | bids=1 | cpv=72267100 | fw=yes | src=DECP | title=2026_2957_2_00 - Hébergement, maintenance, assistance technique, et prestations associées relatives à la solut',
  'AWARD | D1q4swcs | 2026-07-06 | amount=600000 | cur=EUR | buyer=DEPARTEMENT DE L\' ESSONNE | winners=ENTR\'OUVERT | bids=1 | cpv=72267100 | fw=yes | src=DECP | title=Hébergement, maintenance, assistance technique, et prestations associées relatives à la solution « Publik » et',
  'AWARD | D8t0v3j | 2026-07-06 | amount=600000 | cur=EUR | buyer=DEPARTEMENT DE L\' ESSONNE | winners=ENTR\'OUVERT | bids=1 | cpv=72267100 | fw=yes | src=DECP | title=Hébergement, maintenance, assistance technique, et prestations associées relatives à la solution « Publik » et',
  'AWARD | Dj4emam | 2026-06-23 | amount=12450 | cur=EUR | buyer=COMMUNE D\'ANTIBES (MAIRIE) | winners=ENTR\'OUVERT | bids= | cpv=72267000 | fw=yes | src=DECP | title=CONTRAT D HEBERGEMENT ET DE MAINTENANCE POUR LE LOGICIEL DE GESTION DE LA RELATION USAGER',
  'AWARD | Dagrg1h | 2026-04-30 | amount=40000 | cur=EUR | buyer=COMMUNAUTE INTERCOMMUNALE NORD REUNION | winners=DESIGN SYSTEM | bids=4 | cpv=72212445 | fw=yes | src=DECP | title=Accord Cadre à marchés subséquents mono attributaire élaboration et évolution de formulaires électroniques pou',
  'AWARD | D1v5g0hz | 2026-04-30 | amount=69900 | cur=EUR | buyer=COMMUNAUTE INTERCOMMUNALE NORD REUNION | winners=DESIGN SYSTEM | bids=4 | cpv=72212445 | fw=yes | src=DECP | title=ELABORATION ET EVOLUTION DE FORMULAIRES ELECTRONIQUES POUR LE PORTAIL DE GESTION RELATION CLIENTELE DE LA CINO',
  'AWARD | T12923-2025 | 2025-01-09 | amount=10000000 | cur=EUR | buyer=Museum National d\'Histoire Naturelle | winners=SECUTIX S.A. | bids=2 | cpv=72000000 | fw=yes | src=TED | title=FOURNITURE ET MAINTENANCE D\'UNE SOLUTION DE BILLETTERIE ET D\'UNE SOLUTION DE COMMERCIALISATION POUR LES SITES '];
C(A5, 'One award listed 3 times, one winner under 2 names (real EPCC Metz)', 'real rows: D1rl9qaf, D1q4swcs, D8t0v3j (DEPARTEMENT DE L\' ESSONNE, 2026-07-06, 600 000, ENTR\'OUVERT; one title prefixed "2026_2957_2_00 - ") + Antibes; SECUTIX (Reims) and SECUTIX S.A. (TED); the agent chose all but Dfokf3t',
  'Essonne counted once as one award decision (copies or same-winner lots: the data cannot tell): ENTR\'OUVERT 2 wins (check "2 more row(s) of one award decision"); SECUTIX 2 wins; budget still from the 2 priced rows chosen (17 028 / 25 712 / 34 395)', 'MK2', async ok => {
    const ids = EPCC_ROWS.map(l => l.split(' | ')[1]).filter(id => id !== 'Dfokf3t');
    const m = (await market(marketAgent({ comparable_ids: ids }, [step('similar_awards', { cpv: '72', query: 'solution de billetterie, gestion de relation client', country: 'FR' }, awardsObs(EPCC_ROWS, 'TOTAL DECP 88 found (CPV 72*, "billetterie"), newest 12 shown, DECP 123 found (CPV 72*, "relation"), newest 12 shown, TED 7 found'))]), EPCC_TASK)).market;
    const wins = n => (m.competitors.find(c => c.name === n) || {}).wins;
    ok(wins('ENTR\'OUVERT') === 2 && m.checks.some(c => /^2 more row\(s\) of one award decision/.test(c)) && m.comparables.filter(c => /ESSONNE/.test(c.buyer)).length === 1, 'Essonne once');
    ok(wins('SECUTIX') === 2 && !m.competitors.some(c => c.name === 'SECUTIX S.A.'), 'SECUTIX merged');
    ok(m.budget.comparables === 2 && m.budget.low === 17028 && m.budget.median === 25712 && m.budget.high === 34395, 'budget unchanged');
    return `competitors ${m.competitors.map(c => `${c.name} ${c.wins}`).join(', ')}; budget ${m.budget.low} / ${m.budget.median} / ${m.budget.high}`;
  });
C(A5, 'Closest priced contract not chosen (real EPCC Metz)', 'same real rows; the agent left out Dfokf3t "… solution logicielle de Gestion de la Relation Client (GRC" (180 457 EUR, fw=no, 4 bids) for a GRC renewal',
  'named in the checks for a person to judge (the only unchosen priced non-framework row sharing most of the title\'s words); the budget stays the agent\'s choice', 'MK2', async ok => {
    const ids = EPCC_ROWS.map(l => l.split(' | ')[1]).filter(id => id !== 'Dfokf3t');
    const m = (await market(marketAgent({ comparable_ids: ids }, [step('similar_awards', { cpv: '72', query: 'solution de billetterie, gestion de relation client', country: 'FR' }, awardsObs(EPCC_ROWS))]), EPCC_TASK)).market;
    const all = (await market(marketAgent({ comparable_ids: EPCC_ROWS.map(l => l.split(' | ')[1]) }, [step('similar_awards', { cpv: '72', query: 'billetterie', country: 'FR' }, awardsObs(EPCC_ROWS))]), EPCC_TASK)).market;
    const c = m.checks.find(x => /close to the tender title not chosen/.test(x)) || '';
    ok(/^1 priced contract\(s\)/.test(c) && /Dfokf3t 180457 EUR/.test(c), 'flagged'); ok(!all.checks.some(x => /not chosen/.test(x)), 'nothing when chosen');
    return c;
  });
C(A5, 'No data after one narrow search (real DRS)', 'real demo DRS study: similar_awards {cpv "72316000,48482000", query "tableau de bord, santé publique, Power BI"} -> 0; buyer_awards -> TED 0',
  'status no_data, with a check listing the searches made (a person sees the 8-digit CPV)', 'MK2', async ok => {
    const task = marketTask({ title: 'Tableau de bord décisionnel des indicateurs de santé publique', buyer: 'Direction Régionale de la Santé de Sampleville (démo)', cpv: ['72316000', '48482000'] });
    const t = await market(marketAgent({ comparable_ids: [], positioning: 'No comparable contracts found in the database for the specified criteria.' }, [
      step('similar_awards', { cpv: '72316000,48482000', query: 'tableau de bord, santé publique, Power BI', country: 'FR' }, 'TOTAL DECP 0 found (CPV 72316*, "tableau"), newest 0 shown, DECP 0 found (CPV 72316*, "publique"), newest 0 shown, TED 0 found (showing 0)\nNO RESULTS'),
      step('buyer_awards', { buyer_name: 'Direction Régionale de la Santé de Sampleville', cpv: '72316000', country: 'FR' }, 'TOTAL TED 0 found (showing 0)\nNO RESULTS')]), task);
    const c = t.market.checks.find(x => /^no awarded contract found by/.test(x)) || '';
    ok(t.market.status === 'no_data' && /similar_awards \{"cpv":"72316000,48482000"/.test(c) && /buyer_awards/.test(c), 'searches listed');
    return c.slice(0, 160);
  });
// Research Tools sub-workflow: its Public APIs node with the HTTP layer stubbed (no network); `answer(request)` gives each response
const TOOLS = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist/RFP - Research Tools.json'), 'utf8'));
async function publicApi(input, answer) {
  const reqs = [], fn = new AsyncFunction('$', '$input', '$execution', TOOLS.nodes.find(n => n.name === 'Public APIs').parameters.jsCode);
  const res = await fn.call({ helpers: { httpRequest: async o => { reqs.push(clone(o)); return answer(o); } } }, () => { throw new Error('no $ in the tools'); }, { all: () => [{ json: input }], first: () => ({ json: input }) }, { mode: 'test' });
  return { result: res[0].json.result, reqs };
}
const decpRow = o => ({ uid: 'u1', dateNotification: '2026-05-04', acheteur_nom: 'COMMUNE DE AUTREVILLE', objet: 'Développement d’un tableau de bord', codeCPV: '72212000', nature: 'Marché', techniques: 'Sans objet',
  montant: 85000, montant_anomalie: null, titulaire_id: '12345678900011', titulaire_nom: 'DATA CONSULT', offresRecues: 3, ...o });
const stubApis = decp => o => /tabular-api\.data\.gouv\.fr/.test(o.url) ? decp(o.qs) : /api\.ted\.europa\.eu/.test(o.url) ? { totalNoticeCount: 0, notices: [] }
  : /tuneps\.tn/.test(o.url) ? { payload: { data: [], total: 0 } } : /boamp-datadila/.test(o.url) ? { total_count: 0, results: [] } : {};
C(A5, 'similar_awards: 8-digit CPV finds nothing (real DRS input)', 'real input cpv "72316000,48482000", query "tableau de bord, santé publique, Power BI"; DECP: 0 under 72316*, 1 contract under 72*',
  'every keyword searched ("Power" too, not only 2); 0 rows -> once more at the 2-digit divisions 72 and 48 ("DECP widened" in the TOTAL line), so the contract under 72 is found', 'public_apis (similar_awards)', async ok => {
    const { result, reqs } = await publicApi({ tool: 'similar_awards', cpv: '72316000,48482000', query: 'tableau de bord, santé publique, Power BI', country: 'FR' },
      stubApis(qs => (qs.codeCPV__greater === '72' && qs.objet__contains === 'tableau' ? { data: [decpRow()], meta: { total: 1 } } : { data: [], meta: { total: 0 } })));
    const decp = reqs.filter(r => /tabular-api/.test(r.url)).map(r => `${r.qs.codeCPV__greater}:${r.qs.objet__contains}`);
    ok(decp.slice(0, 3).join() === '72316:tableau,72316:publique,72316:Power', 'every keyword'); ok(decp.includes('72:tableau') && decp.includes('48:tableau'), 'widened to 72 and 48');
    ok(/DECP widened 1 found \(CPV 72\*, "tableau"\)/.test(result) && /\| src=DECP \| title=Développement d’un tableau de bord/.test(result), 'row found');
    return `${decp.join(' ')} -> ${result.split('\n')[0].slice(0, 150)}`;
  });
C(A5, 'similar_awards: third keyword for Tunisia (real input)', 'real input query "plateforme numérique, gestion licences, tourisme", country TN', 'the 3 keywords each searched in TUNEPS ("tourisme" was silently dropped)', 'public_apis (similar_awards)', async ok => {
  const { result, reqs } = await publicApi({ tool: 'similar_awards', cpv: '72212000,72262000', query: 'plateforme numérique, gestion licences, tourisme', country: 'TN' }, stubApis(() => ({ data: [] })));
  const searched = reqs.filter(r => /bid\/master\/data/.test(r.url)).map(r => r.body.dataSearch[0].value);
  ok(searched.join('|') === 'plateforme numérique|gestion licences|tourisme' && /TUNEPS 0 tenders for "tourisme"/.test(result), 'all 3');
  return searched.join(' | ');
});
C(A5, 'buyer_awards for a French buyer without SIREN (real EPCC Metz input)', 'real input {buyer_name "EPCC Metz en scènes", cpv "72", country FR}, no siren; DECP by name returns EPCC METZ EN SCENES and a namesake THEATRE DES SCENES DE LYON',
  'DECP searched by the buyer name\'s longest distinctive word ("SCENES"), only this buyer\'s row kept (not TED only)', 'public_apis (buyer_awards)', async ok => {
    const { result, reqs } = await publicApi({ tool: 'buyer_awards', buyer_name: 'EPCC Metz en scènes', cpv: '72', country: 'FR', siren: '' },
      stubApis(qs => (qs.acheteur_nom__contains ? { data: [decpRow({ uid: 'a', acheteur_nom: 'EPCC METZ EN SCENES', objet: 'Solution de billetterie', titulaire_nom: 'SECUTIX' }), decpRow({ uid: 'b', acheteur_nom: 'THEATRE DES SCENES DE LYON' })], meta: { total: 2 } } : { data: [], meta: { total: 0 } })));
    const q = reqs.find(r => /tabular-api/.test(r.url));
    ok(q && q.qs.acheteur_nom__contains === 'SCENES' && q.qs.codeCPV__greater === '72', 'DECP by name'); ok(/buyer=EPCC METZ EN SCENES/.test(result) && !/THEATRE/.test(result) && /DECP 1 of this buyer among 2 found by buyer name "SCENES"/.test(result), 'only this buyer');
    return result.split('\n')[0];
  });
C(A3, 'Registry legal form and BOAMP name (tools)', 'registry rows CITY\'UP (CFTU) nature 5515 and ARS ILE DE FRANCE nature 7385 (registry flags both "not public"); boamp_history {buyer_name "CITY\'UP (CFTU)"} (real input)',
  'public=mixed for the SEM, public=yes for the 7385 body; BOAMP phrase searched without the parenthesised acronym ("CITY\'UP")', 'public_apis (registry_search, boamp_history)', async ok => {
    const reg = await publicApi({ tool: 'registry_search', q: 'City\'up' }, () => ({ results: [
      { nom_complet: 'CITY\'UP (CFTU)', siren: '431938091', nature_juridique: '5515', siege: { siret: '43193809100110', adresse: '19 RUE DE LA LIBERTE 97200 FORT DE FRANCE', libelle_commune: 'FORT DE FRANCE' }, complements: {}, tranche_effectif_salarie: '11', annee_tranche_effectif_salarie: '2024' },
      { nom_complet: 'AGENCE REGIONALE SANTE ILE DE FRANCE (ARS)', siren: '130008014', nature_juridique: '7385', siege: { siret: '13000801400149', adresse: '13 RUE DU LANDY 93200 SAINT-DENIS', libelle_commune: 'SAINT-DENIS' }, complements: {}, tranche_effectif_salarie: '42', annee_tranche_effectif_salarie: '2024' }] }));
    const bo = await publicApi({ tool: 'boamp_history', buyer_name: 'CITY\'UP (CFTU)' }, stubApis(() => ({})));
    ok(/nature=5515 \| public=mixed/.test(reg.result) && /nature=7385 \| public=yes/.test(reg.result), 'public='); ok(/search\(nomacheteur, "\\"CITY'UP\\""\)/.test(bo.reqs[0].qs.where), 'parentheses dropped');
    return `${reg.result.split('\n').map(l => l.match(/nature=\d+ \| public=\w+/)[0]).join('; ')}; BOAMP where ${bo.reqs[0].qs.where.slice(0, 40)}`;
  });
C(A5, 'buyer_awards by name: a city and its metropole', '{buyer_name "Ville de Nantes", country FR}, no siren; DECP by name returns COMMUNE DE NANTES, NANTES METROPOLE, VILLE DE NANTES (DIRECTION DU NUMERIQUE); 2nd: the run\'s "Communauté de communes du Vimeu" with CC DU VIMEU and COMMUNE DE FRIVILLE ESCARBOTIN (VIMEU)',
  'search word NANTES / VIMEU (never the kind of body); the commune\'s rows kept (VILLE = MAIRIE = COMMUNE, CC = COMMUNAUTE DE COMMUNES), the metropole\'s and the other commune\'s dropped', 'public_apis (buyer_awards)', async ok => {
    const byName = async (name, rows) => publicApi({ tool: 'buyer_awards', buyer_name: name, cpv: '', country: 'FR', siren: '' },
      stubApis(qs => (qs.acheteur_nom__contains ? { data: rows.map((n, k) => decpRow({ uid: `r${k}`, acheteur_nom: n, objet: `Contrat ${k}` })), meta: { total: rows.length } } : { data: [], meta: { total: 0 } })));
    const n = await byName('Ville de Nantes', ['COMMUNE DE NANTES', 'NANTES METROPOLE', 'VILLE DE NANTES (DIRECTION DU NUMERIQUE)']);
    const v = await byName('Communauté de communes du Vimeu', ['CC DU VIMEU', 'COMMUNE DE FRIVILLE ESCARBOTIN (VIMEU)']);
    const word = r => (r.reqs.find(q => /tabular-api/.test(q.url)) || { qs: {} }).qs.acheteur_nom__contains;
    ok(word(n) === 'NANTES' && /buyer=COMMUNE DE NANTES/.test(n.result) && /buyer=VILLE DE NANTES/.test(n.result) && !/METROPOLE/.test(n.result) && /DECP 2 of this buyer among 3/.test(n.result), 'Nantes');
    ok(word(v) === 'VIMEU' && /buyer=CC DU VIMEU/.test(v.result) && !/FRIVILLE/.test(v.result), 'Vimeu');
    return `${n.result.split('\n')[0].slice(0, 110)}; Vimeu: ${v.result.split('\n')[0].slice(0, 80)}`;
  });
C(A5, 'similar_awards widened: no query made twice', 'cpv "72, 48482000" (the first already a 2-digit division), query "tableau de bord, santé publique", FR; DECP finds nothing',
  'widened only to the new division 48 (72 + "tableau" / "publique" are not asked again), no repeated "DECP widened ... CPV 72*" note', 'public_apis (similar_awards)', async ok => {
    const { result, reqs } = await publicApi({ tool: 'similar_awards', cpv: '72, 48482000', query: 'tableau de bord, santé publique', country: 'FR' }, stubApis(() => ({ data: [], meta: { total: 0 } })));
    const decp = reqs.filter(r => /tabular-api/.test(r.url)).map(r => `${r.qs.codeCPV__greater}:${r.qs.objet__contains}`);
    ok(decp.join() === '72:tableau,72:publique,48:tableau,48:publique', 'each once'); ok(!/DECP widened 0 found \(CPV 72\*/.test(result) && /DECP widened 0 found \(CPV 48\*, "tableau"\)/.test(result), 'notes');
    return `${decp.join(' ')} -> ${result.split('\n')[0].slice(0, 150)}`;
  });
C(A3, 'Local public agency is not a local authority (registry legal form)', '"EPCC Metz en scènes" (real notice SIRET 50962999400013, Metz) typed other, registry nature 7373 (établissement public local culturel); the run\'s "Syndicat Départemental d\'Energie du Tarn (SDET)" (SIRET 25810007200044, Albi) typed other, nature 7355 (syndicat mixte)',
  'EPCC -> public_agency (a 73xx local public body), SDET -> local_authority (735x syndicat), each with the legal-form check', 'BU2', async ok => {
    const epcc = await research(buyer({ buyer_key: 'epcc metz en scenes', name: 'EPCC Metz en scènes', search_name: 'EPCC Metz en scènes' }), researchAgent({ buyer_type: 'other' }, [step('registry_search', { q: 'EPCC Metz en scènes' },
      'REG | EPCC METZ EN SCENES | siren=509629994 | siret=50962999400013 | addr=57000 METZ | city=METZ | nature=7373 | public=yes | staff=32 | staff_year=2024')]));
    const sdet = await research(buyer({ buyer_key: 'syndicat departemental d energie du tarn sdet', name: 'Syndicat Départemental d\'Energie du Tarn (SDET)', search_name: 'Syndicat Départemental d\'Energie du Tarn (SDET)' }),
      researchAgent({ buyer_type: 'other' }, [step('registry_search', { q: 'Syndicat Départemental d\'Energie du Tarn' },
        'REG | SYNDICAT DEPARTEMENTAL D\'ENERGIE DU TARN (SDET) | siren=258100072 | siret=25810007200044 | addr=81000 ALBI | city=ALBI | nature=7355 | public=yes | staff=21 | staff_year=2024')]));
    ok(epcc.profile.legal_form === '7373' && epcc.profile.buyer_type === 'public_agency' && epcc.profile.checks.some(x => /^buyer type public_agency from the registry legal form 7373 \(agent said other\)/.test(x)), 'EPCC');
    ok(sdet.profile.legal_form === '7355' && sdet.profile.buyer_type === 'local_authority', 'SDET');
    return `EPCC ${epcc.profile.legal_form} -> ${epcc.profile.buyer_type}; SDET ${sdet.profile.legal_form} -> ${sdet.profile.buyer_type}`;
  });
C(A5, 'Market task SIREN from the API notice\'s national id (real 26-101357)', 'BOAMP 26-101357 (EPCC Metz en scènes) as API2 maps it: buyer.national_id 50962999400013, no buyer.siret; buyer research skipped (research_status not_researched_budget, as in the run of 2026-10-20); the same notice with a TN buyer, and with a national id failing the Luhn key (50962999500013)',
  'buyer_siren 509629994 (the SIRET\'s first 9 digits) so buyer_awards can read the EPCC\'s own DECP contracts; "" for the TN buyer and for the bad key', 'API2, MK1', async ok => {
    const [r] = await api2([B101357]);
    const mk = (id, o = {}) => ({ ...r, tender_id: id, survivor: true, too_late: false, analysis: { fit: 'high', tender_type: 'software_build' }, rag: { coverage: 0.5 }, effective_deadline: '2026-11-20',
      buyer_profile: { research_status: 'not_researched_budget', enrichment_status: 'not_researched' }, ...o });
    const out = await run('Select Market Studies', [mk('Tepcc'), mk('Ttn', { buyer: { ...r.buyer, country: 'TN' } }), mk('Tbad', { buyer: { ...r.buyer, national_id: '50962999500013' } })]);
    const siren = id => out.find(t => t.tender_id === id).market_task.buyer_siren;
    ok(!r.buyer.siret && r.buyer.national_id === '50962999400013' && out.every(t => t._market), 'real mapped notice, all studied');
    ok(siren('Tepcc') === '509629994' && siren('Ttn') === '' && siren('Tbad') === '', 'SIREN from national_id, France only, Luhn-checked');
    return `national_id ${r.buyer.national_id} -> buyer_siren EPCC "${siren('Tepcc')}", TN "${siren('Ttn')}", bad key "${siren('Tbad')}"`;
  });
C(A5, 'One priced award republished under a reworded title; unpriced lots of one day (real EPCC Metz rows)', 'the real EPCC Metz rows + D1x7qk2c, the DIPTICK / Cambo-les-Bains award (2026-03-19, 43 078, DECP) again under another id with its object reworded; + 2 TED lots of the real Département de l\'Eure row (T303385-2025, 2025-05-13, no amount, title cut before the lot number), both won by SECUTIX; the agent chose all but Dfokf3t',
  'one award = same buyer, day, amount and winners whatever the title: DIPTICK 1 win and the budget still from 2 priced rows (17 028 / 25 712 / 34 395), check "3 more row(s) of one award decision"; never without an amount: the 2 unpriced lots stay 2 wins (SECUTIX 4: Reims, MNHN, 2 lots); Build Proposal Input\'s recount then changes no win', 'MK2, PR1', async ok => {
    const eure = k => `AWARD | T303385-2025-${k} | 2025-05-13 | amount= | cur=EUR | buyer=Département de l'Eure | winners=SECUTIX | bids=4 | cpv=72268000 | fw=yes | src=TED | title=Acquisition d'une solution de billetterie, réservation, contrôle d'accès et boutique pour les sites touristiqu`;
    const rows = [...EPCC_ROWS, 'AWARD | D1x7qk2c | 2026-03-19 | amount=43078 | cur=EUR | buyer=COMMUNE DE CAMBO LES BAINS (MAIRIE) | winners=DIPTICK | bids=2 | cpv=72222300 | fw=no | src=DECP | title=Logiciel de billetterie de la commune de Cambo-les-Bains : fourniture, installation et maintenance', eure(1), eure(2)];
    const ids = rows.map(l => l.split(' | ')[1]).filter(id => id !== 'Dfokf3t');
    const m = (await market(marketAgent({ comparable_ids: ids }, [step('similar_awards', { cpv: '72', query: 'solution de billetterie, gestion de relation client', country: 'FR' }, awardsObs(rows, 'TOTAL DECP 88 found (CPV 72*, "billetterie"), newest 12 shown, TED 7 found'))]), EPCC_TASK)).market;
    const wins = n => (m.competitors.find(c => c.name === n) || {}).wins;
    ok(wins('DIPTICK') === 1 && m.comparables.filter(c => c.winners.includes('DIPTICK')).length === 1 && m.budget.comparables === 2 && m.budget.low === 17028 && m.budget.median === 25712 && m.budget.high === 34395, 'reworded copy counted once');
    ok(wins('SECUTIX') === 4 && m.comparables.filter(c => /^T303385/.test(c.id)).length === 2, 'unpriced lots never merged');
    ok(wins('ENTR\'OUVERT') === 2 && wins('DESIGN SYSTEM') === 2 && m.checks.some(c => /^3 more row\(s\) of one award decision \(copies or same-winner lots of one procedure: same buyer, date, amount and winners\)/.test(c)), 'Essonne once, 2 CINOR prices stay 2');
    const p = await proposal(ragTender({ market: m }));
    ok(p.competition.competitors.every(c => c.past_wins === wins(c.name)), 'proposal recount finds no repeat');
    return `competitors ${m.competitors.map(c => `${c.name} ${c.wins}`).join(', ')}; budget ${m.budget.low} / ${m.budget.median} / ${m.budget.high} (${m.budget.comparables}); proposal ${p.competition.competitors.map(c => `${c.name} ${c.past_wins}`).join(', ')}`;
  });
// francemarches result notice (GIP RESAH 26-87830, real lines) and two real open pages: Ville de Lyon (eForms "Mise en concurrence") and
// domainetat-tn ?p=16390 (an open consultation whose "you may also like" block lists a "RESULTAT DE CONSULTATION")
const RESAH_AWARD = ["Intitulé de l'appel d'offre public\nAcquisition d'une plateforme innovante de services d'intelligenceartificielle générative multi-modèles", 'Localisation :\n\nParis (75)',
  'Date de parution :\n\n11/09/2026', 'Européen\n\nAvis d\'attribution\n\nFournitures\n\nProcédure formalisée', '## Nom et adresse officiels de l’organisme acheteur public\n\n**GIP RESAH**\n\n9 rue Brahms\n\n75012\nParis',
  '## Texte légal de l’appel d’offre (marché public)\n\nAvis d’attribution de marché\n\nDépartement(s) de publication :**75**\n\nAnnonce n° **26-87830**',
  'Titre:Acquisition d’une plateforme innovante de services d’intelligenceartificielle générative multi-modèles', 'Identifiant du marché:2024-R055-001-005\n\nDate à laquelle le lauréat a été choisi:19/08/2026\n\nDate de conclusion du marché:03/09/2026',
  'Type de formulaire:Résultats\n\nType d’avis:Avis d’attribution de marché ou de concession – régime ordinaire\n\nDate d’envoi de l’avis:10/09/2026à 14:43'].join('\n\n');
const RESAH_EXTRACT = { title: 'Acquisition d\'une plateforme innovante de services d\'intelligenceartificielle générative multi-modèles', buyer: 'GIP RESAH',
  description: 'Acquisition d\'une plateforme innovante de services d\'intelligenceartificielle générative multi-modèles', publication_date: '11/09/2026', deadline: '19/08/2026', notice_type: 'other' };
const LYON_OPEN = ["Intitulé de l'appel d'offre public\nEvaluation de conformité de la protection des données personnelles (RGPD) et du règlement sur l'intelligenceartificielle (RIA) à la Ville de Lyon et au CCAS",
  'Localisation :\n\nRhône (69)\n\nDate de clotûre :\n\n21/10/2026\n\nDate de parution :\n\n16/09/2026\n\nEuropéen\n\nAAPC\n\nServices\n\nProcédure formalisée', 'Avis de marché',
  "Titre: Evaluation de conformité de la protection des données personnelles (RGPD) et du règlement sur l'intelligenceartificielle (RIA) à la Ville de Lyon et au CCAS",
  "Date limite de réception des offres: 21/10/202616:00:00 (UTC+02:00) Heure de l'Europe orientale, heure d'été de l'Europe centrale",
  'Type de formulaire: Mise en concurrence\n\nType d’avis: Avis de marché ou de concession – régime ordinaire\n\nSous-type d’avis: 16'].join('\n\n');
const DT_16390 = ['- Publication publiée :6 mai 2026\n- Catégorie de la publication : Annonces/ Appel d\'offre',
  'Le Ministère des Domaines de l’Etat et des Affaires Foncières se propose de lancer une consultation N° 16/2026 auprès des centres de formation spécialisés dans le domaine Informatique pour réaliser des sessions de formation sur le logiciel : **« DevOps Foundation ».**',
  '**Le dernier délai** de la remise des offres est fixé au **Jeudi 28 Mai 2026 à 10h00**, la participation à travers la procédure en ligne TUNEPS s’arrête automatiquement le même jour et à la même heure, toute offre parvenue après la date et l’heure limite sera rejetée.',
  '### Vous devriez également aimer', '### RESULTAT DE CONSULTATION N° 53/2021 Mise en place et installation d’une solutions d’annuaire d’entreprise Active Directory et acquisition des licences Windows server\n\n7 mars 2022',
  '### AVIS DE CONSULTATION N° 31/2020 Pour la Réalisation de Sessions de Formation sur les Logiciels « Java EE Avancé »\n\n23 février 2021'].join('\n\n');
C(A1, 'Award notice by its form label, open notices untouched (real francemarches / domainetat pages)', 'GIP RESAH 26-87830 page (card "Avis d\'attribution", "Type de formulaire:Résultats" without a space, anchor cut before its label), LLM: notice_type other, deadline 19/08/2026 (the winner\'s choice date); the INNOP\'IA page with its labels cut off, only the anchor "… Européen Avis d\'attribution Services Procédure"; Ville de Lyon (card "AAPC", "Type de formulaire: Mise en concurrence") and domainetat ?p=16390 (sidebar "### RESULTAT DE CONSULTATION N° 53/2021 …"), LLM open',
  'RESAH and INNOP\'IA: notice_type award, no deadline, warning notice_type_from_page_label, dropped "award notice"; Lyon and ?p=16390 stay open with their deadlines 21/10/2026 and 28 Mai 2026, Lyon even under an award anchor (its page says AAPC: labels disagree, the LLM decides)', 'URL5, Clean', async ok => {
    const fm = (slug, text, anchor) => page({ source: 'francemarches', url: `https://www.francemarches.com/appel-offre/${slug}?q=Intelligence%20Artificielle`, text, anchor_text: anchor });
    const [resah] = await url5(fm('3boamp2687830-2026-acquisition-plateforme-innovante', RESAH_AWARD, '022 GIP RESAH Acquisition d\'une plateforme innovante de services d\'intelligence artificielle générative multi-modèles Eu'), extractAnswer(RESAH_EXTRACT));
    const innop = ["Intitulé de l'appel d'offre public\nProjet INNOP'IA - Phase2 - Missions d'assistance", 'Date de parution :\n\n08/09/2026', '## Nom et adresse officiels de l’organisme acheteur public\n\n**CCI ROUEN METROPOLE**',
      "Titre: Projet INNOP'IA - Phase2 - Missions d'assistance", 'Date de conclusion du marché/concession: 02/09/2026'].join('\n\n');
    const [anchorOnly] = await url5(fm('13joue006176972026-2026-projet-innop-phase2', innop, "021 CCI ROUEN METROPOLE Projet INNOP'IA - Phase2 - Missions d'assistance Européen Avis d'attribution Services Procédure"),
      extractAnswer({ title: "Projet INNOP'IA - Phase2 - Missions d'assistance", buyer: 'CCI ROUEN METROPOLE', publication_date: '08/09/2026', deadline: '02/09/2026' }));
    const [lyon] = await url5(fm('13joue006378442026-2026-evaluation-conformite-protection', LYON_OPEN, '026 Ville de Lyon Evaluation de conformité de la protection des données personnelles (RGPD) et du règlement sur l\'intell'),
      extractAnswer({ title: "Evaluation de conformité de la protection des données personnelles (RGPD) et du règlement sur l'intelligenceartificielle (RIA) à la Ville de Lyon et au CCAS", buyer: 'Ville de Lyon', publication_date: '16/09/2026', deadline: '21/10/2026' }));
    const [dt16390] = await url5(page({ source: 'domainetat-tn', url: dtUrl(16390), text: DT_16390, anchor_text: 'AVIS DE CONSULTATION N° 16/2026Pour la Réalisation des Sessions de Formation sur le Logiciel « DevOps Foundation »' }),
      extractAnswer({ title: 'Consultation N° 16/2026 pour la réalisation de sessions de formation sur le logiciel « DevOps Foundation »', buyer: 'Ministère des Domaines de l’Etat et des Affaires Foncières', publication_date: '6 mai 2026', deadline: 'Jeudi 28 Mai 2026 à 10h00', country: 'TN' }));
    // labels that disagree (an award anchor on the Lyon page, which says "AAPC" / "Mise en concurrence"): the LLM's answer stays
    const [mixed] = await url5(fm('13joue006378442026-2026-evaluation-conformite-protection', LYON_OPEN, '026 Ville de Lyon Evaluation de conformité … Européen Avis d\'attribution Services Procédure'),
      extractAnswer({ title: "Evaluation de conformité de la protection des données personnelles (RGPD) et du règlement sur l'intelligenceartificielle (RIA) à la Ville de Lyon et au CCAS", buyer: 'Ville de Lyon', publication_date: '16/09/2026', deadline: '21/10/2026' }));
    ok(mixed.notice_type === 'open' && mixed.deadline === '21/10/2026', 'contract-notice label in the page: left to the LLM');
    const cl = await clean([resah, anchorOnly]);
    for (const [k, t] of [['RESAH', resah], ['anchor', anchorOnly]]) ok(t.notice_type === 'award' && t.deadline === null && t.extraction.warnings.includes('notice_type_from_page_label') && t.extraction.warnings.includes('deadline_dropped_award_notice'), `${k}: award, no deadline`);
    ok(cl.every(c => c.drop_reason === 'award notice'), 'dropped as award notices');
    ok(lyon.notice_type === 'open' && lyon.deadline === '21/10/2026' && dt16390.notice_type === 'open' && dt16390.deadline === 'Jeudi 28 Mai 2026 à 10h00' && ![lyon, dt16390].some(t => t.extraction.warnings.includes('notice_type_from_page_label')), 'open notices untouched');
    return `RESAH ${resah.notice_type} (deadline ${resah.deadline}), INNOP'IA by anchor ${anchorOnly.notice_type} -> ${cl.map(c => c.drop_reason).join(' / ')}; Lyon ${lyon.notice_type} ${lyon.deadline}; ?p=16390 ${dt16390.notice_type} ${dt16390.deadline}`;
  });

// research and market inputs of the run of 2026-10-20 (qwen3 4B, RAG v2), as the Buyer Research and Competitor & Budget agents got them
const MININT = buyer({ buyer_key: 'ministere de l interieur', buyer_id: 'B5zdlbz', name: "Ministère de l'Intérieur", search_name: "Ministère de l'Intérieur",
  tender_titles: ['RFI - SYSTEME DE VIDEOPROTECTION ET DE CAMERAS AEROPORTEES'], tenders: [{ tender_id: 'Tdoatt8', external_id: null, title: 'RFI - SYSTEME DE VIDEOPROTECTION ET DE CAMERAS AEROPORTEES' }], exclude_hosts: ['francemarches.com'] });
const WD_MININT = ["WD | ministère de l'Intérieur | ministère tchèque | id=Q11781499 | match=label:ministère de l'Intérieur | website=https://mv.gov.cz",
  "WD | ministère de l'Intérieur | traite des questions de politique intérieure, en particulier, est sous son administration et de la sécurité intérieure | id=Q6589202 | match=label:ministère de l'Intérieur"];
const REG_MININT = "REG | MINISTERE DE L'INTERIEUR | siren=110014016 | siret=11001401600015 | addr=HOTEL DE BEAUVAU PLACE BEAUVAU 75008 PARIS 08 | city=PARIS 08 | nature=7113 | public=yes | staff=51 | staff_year=2024";
const BOAMP_MININT = ["TOTAL 648", "BOAMP | 26-100643 | 2026-10-18 | APPEL_OFFRE | Conception et animation de formations et d'accompagnement individuels ou collectifs à destination des agents d | buyer=Ministère de l'Intérieur | winners=",
  "BOAMP | 26-99707 | 2026-10-16 | ATTRIBUTION | AOO AMOA SI | buyer=Ministère de l'Interieur | winners=BEARING POINT; MC2i; CGI France; Eurogroup Consulting; SIA Partners; TASMANE"].join('\n');
const minint = wdRows => researchAgent({ buyer_type: 'state_administration', size_hint: 'medium', official_website: 'https://www.intérieur.gouv.fr',
  summary: "The Ministère de l'Intérieur is a state administration in France with around 51 employees. It has published multiple tenders in the last three years, including those for security, training, and infrastructure projects. Its official website is not listed in Wikidata but can be found via the French public procurement portal." },
  [step('wikidata_lookup', { q: "Ministère de l'Intérieur" }, wdRows.join('\n')), step('registry_search', { q: "Ministère de l'Intérieur" }, REG_MININT), step('boamp_history', { buyer_name: "Ministère de l'Intérieur" }, BOAMP_MININT)]);
const CITYUP = buyer({ buyer_key: 'city up 972', buyer_id: 'Bdjlu99', name: "City'up (972)", search_name: "City'up (972)", tender_titles: ["Prestations de développement d'agents LLM et services associés"],
  tenders: [{ tender_id: 'T1vll2ea', external_id: null, title: "Prestations de développement d'agents LLM et services associés" }],
  notice_contacts: { emails: ['cu.commandepublique@cityup.mq'], phones: [], websites: ['https://v2.marches-securises.fr'], addresses: ['Fort de France, 97200'] }, exclude_hosts: ['francemarches.com'] });
const REG_CITYUP = "REG | CITY'UP (CFTU) | siren=431938091 | siret=43193809100110 | addr=19 RUE DE LA LIBERTE 97200 FORT DE FRANCE | city=FORT DE FRANCE | nature=5515 | public=mixed | staff=11 | staff_year=2024 | ca=2024:0";
const BOAMP_CITYUP = ['TOTAL 12', "BOAMP | 26-96703 | 2026-10-06 | APPEL_OFFRE | Accord cadre Prestations de développement d'agents LLM et services associés | buyer=City'up (972) | winners=",
  "BOAMP | 26-10457 | 2026-01-31 | APPEL_OFFRE | CONCEPTION, DEVELOPPEMENT ET MAINTENANCE DEVELOPPEMENT D’APPLICATIONS WEB ET MOBILES | buyer=City'up (972) | winners=",
  "BOAMP | 25-29588 | 2025-03-14 | ATTRIBUTION | PRESTATIONS DE SERVICES POUR L’EXERCICE DE LA MISSION DE COMMISSAIRE AUX COMPTES POUR LES EXERCICES 2024 A 202 | buyer=City'up (972) | winners=",
  "BOAMP | 24-59996 | 2024-05-25 | ATTRIBUTION | ATTRIBUTION DE MARCHE - INFOGERANCE ET FOURNITURE DE MATERIELS INFORMATIQUES LOTS 2 ET 3 | buyer=City'up (972) | winners="].join('\n');
const CITYUP_STEPS = [step('registry_search', { q: "City'up" }, REG_CITYUP), step('boamp_history', { buyer_name: "City'up (972)" }, BOAMP_CITYUP),
  step('wikidata_lookup', { q: "City'up" }, "WD | City'up |  | id=Q115468931 | match=label:City'up\nWD | City upon a Hill | phrase | id=Q367202 | match=label:City upon a Hill")];
const cityupR2 = steps => researchAgent({ buyer_type: 'public_company', size_hint: 'small', official_website: null,
  summary: "City'up (972) is a mixed-economy company based in Fort-de-France, with 11 employees in 2024. It has published tenders for services like LLM agent development and IT infrastructure, with 12 public notices in the last three years. Its official website is not listed in Wikidata but can be found via web search." }, steps);
C(A3, 'Wikidata namesake abroad: the Czech interior ministry for the French one (real run of 2026-10-20)', "Ministère de l'Intérieur (FR): wikidata_lookup gave \"ministère tchèque\" Q11781499 (website=https://mv.gov.cz) first and Q6589202 second (no country, website nor SIREN; its description names no country: by all signs the generic \"interior ministry\" item), both labelled alike; registry MINISTERE DE L'INTERIEUR 110014016 (Paris); as recorded (no country= yet) and as the tool now prints them (country=CZ, a class item has no P17); then beside the Czech row a stub row (Q900000001, not a real item) placed in France by country=FR, by the registry's SIREN or by a .fr website, and that stub alone",
  'the Czech entity ignored (website under .cz / country CZ), and Q6589202 too: a namesake abroad as well named and nothing places it in France (check "named like Q11781499 of another country"): no wikidata_id, no website (sources.website null), the summary sentence about the website removed; the proposal input has no buyer website (it had mv.gov.cz). A row placed by its country, SIREN or .fr website is used (its website too); a row with no namesake abroad is used as before', 'BU2, PR1', async ok => {
    const rec = await research(MININT, minint(WD_MININT));
    const cty = await research(MININT, minint([WD_MININT[0].replace(' | website=', ' | country=CZ | website='), WD_MININT[1]]));
    for (const [k, r] of [['recorded', rec], ['country=', cty]]) ok(r.profile.wikidata_id === null && !r.facts.wikidata && r.profile.official_website === '' && r.profile.contacts.sources.website === null && r.profile.checks.some(c => /^Wikidata Q11781499 "ministère de l'Intérieur" ignored: another country's/.test(c))
      && r.profile.checks.some(c => /^Wikidata Q6589202 "ministère de l'Intérieur" ignored: named like Q11781499 of another country, and nothing places it in FR/.test(c)), k);
    ok(!/website|wikidata/i.test(rec.profile.summary) && rec.profile.checks.some(c => /^summary sentence removed \(the website is set by code\)/.test(c)), 'summary');
    const p = await proposal(ragTender({ buyer: { name: MININT.name, country: 'FR', contacts: {} }, buyer_profile: { research_status: 'researched', enrichment_status: rec.enrichment_status, ...rec.profile } }));
    ok(p.buyer_profile.website === null, 'proposal website');
    const STUB = "WD | ministère de l'Intérieur | ministère français | id=Q900000001 | match=label:ministère de l'Intérieur";
    const [byCountry, bySiren, bySite, alone] = await Promise.all([[WD_MININT[0], `${STUB} | country=FR`], [WD_MININT[0], `${STUB} | siren=110014016`], [WD_MININT[0], `${STUB} | website=https://www.interieur.gouv.fr`], [STUB]].map(rows => research(MININT, minint(rows))));
    ok([byCountry, bySiren, bySite, alone].every(r => r.profile.wikidata_id === 'Q900000001') && bySite.profile.official_website === 'https://interieur.gouv.fr' && bySite.profile.contacts.sources.website === 'Wikidata', 'placed');
    return `wikidata ${rec.profile.wikidata_id}, website "${rec.profile.official_website}"; ${rec.profile.checks.find(c => /^Wikidata Q6589202/.test(c))}; placed by country / SIREN / .fr site / alone: ${[byCountry, bySiren, bySite, alone].map(r => r.profile.wikidata_id).join(' / ')}; proposal website ${p.buyer_profile.website}`;
  });
C(A3, 'Wikidata namesakes nothing tells apart, and the SIREN that does', "the 2 real \"ministère de l'Intérieur\" rows, both given country=FR here (not their real countries), no website: a tie; then the second one given siren=110014016 (the registry's); then one row with another SIREN (130020316)",
  'tie: no Wikidata fact (check "... nothing tells apart"); the row with the registry\'s SIREN is the buyer\'s; a row with another SIREN is ignored', 'BU2', async ok => {
    const fr = WD_MININT.map(l => `${l.replace(/ \| website=\S+/, '')} | country=FR`);
    const tie = await research(MININT, minint(fr)), own = await research(MININT, minint([fr[0], `${fr[1]} | siren=110014016`])), other = await research(MININT, minint([`${fr[0]} | siren=130020316`]));
    ok(tie.profile.wikidata_id === null && !tie.facts.wikidata && tie.profile.checks.some(c => /^Wikidata ignored: 2 entities named like the buyer that nothing tells apart \(Q11781499, Q6589202\)/.test(c)), 'tie');
    ok(own.profile.wikidata_id === 'Q6589202', 'SIREN settles it'); ok(other.profile.wikidata_id === null && other.profile.checks.some(c => /SIREN 130020316, not the registry's 110014016/.test(c)), 'other SIREN');
    return `tie -> ${tie.profile.wikidata_id}; own SIREN -> ${own.profile.wikidata_id}; other SIREN -> ${other.profile.wikidata_id}`;
  });
C(A3, 'wikidata_lookup gives each entity\'s country and SIREN (tool)', "search \"Ministère de l'Intérieur\": Q11781499 (P17 Czech Republic Q213, a deprecated Czechoslovakia Q33946, P856 mv.gov.cz) and a stub French entity Q900000001 (not a real item: P17 France Q142, P1616 110014016); then an entity of a country outside the built-in list (Q1041)",
  'rows end with "country=CZ | website=https://mv.gov.cz" and "country=FR | siren=110014016"; the deprecated country is skipped; an unlisted country is read from its own ISO code (P297): country=SN', 'public_apis (wikidata_lookup)', async ok => {
    const snak = v => ({ rank: 'normal', mainsnak: { datavalue: { value: v } } });
    const ENT = { Q11781499: { P17: [snak({ id: 'Q213' }), { ...snak({ id: 'Q33946' }), rank: 'deprecated' }], P856: [snak('https://mv.gov.cz')] }, Q900000001: { P17: [snak({ id: 'Q142' })], P1616: [snak('110014016')] }, Q99: { P17: [snak({ id: 'Q1041' })] } };
    const answer = o => o.qs.action === 'wbsearchentities' ? { search: o.qs.search === 'X' ? [{ id: 'Q99', label: 'X', description: 'agence', match: { type: 'label', text: 'X' } }]
      : [{ id: 'Q11781499', label: "ministère de l'Intérieur", description: 'ministère tchèque', match: { type: 'label', text: "ministère de l'Intérieur" } }, { id: 'Q900000001', label: "ministère de l'Intérieur", description: 'ministère français', match: { type: 'label', text: "ministère de l'Intérieur" } }] }
      : o.qs.action === 'wbgetclaims' ? { claims: o.qs.entity === 'Q1041' ? { P297: [snak('SN')] } : {} } : { entities: Object.fromEntries(Object.entries(ENT).filter(([id]) => o.url.includes(id)).map(([id, claims]) => [id, { claims }])) };
    const { result } = await publicApi({ tool: 'wikidata_lookup', q: "Ministère de l'Intérieur" }, answer), x = await publicApi({ tool: 'wikidata_lookup', q: 'X' }, answer);
    const [cz, fr] = result.split('\n');
    ok(/\| id=Q11781499 \| match=label:ministère de l'Intérieur \| country=CZ \| website=https:\/\/mv\.gov\.cz$/.test(cz) && /\| id=Q900000001 \| match=label:ministère de l'Intérieur \| country=FR \| siren=110014016$/.test(fr), 'country + siren');
    ok(/\| country=SN$/.test(x.result) && x.reqs.some(r => r.qs.action === 'wbgetclaims' && r.qs.entity === 'Q1041' && r.qs.property === 'P297'), 'P297');
    return `${cz.slice(cz.indexOf('| country'))} / ${fr.slice(fr.indexOf('| country'))} / ${x.result.slice(x.result.indexOf('| country'))}`;
  });
C(A3, 'Registry staff band read as a headcount, a true count removed (real City\'up / OPPIC)', "registry_search printed the raw INSEE code (staff=11, staff=22): the agents wrote \"11 employees\", \"22 employees\" and size small for a 100-199 body; City'up's sentence \"... with 12 public notices in the last three years\" (BOAMP TOTAL 12) was removed",
  'the tool prints the band (staff=10-19, NN -> staff=unknown); Parse Research reads band or code, keeps the 12-notices sentence (the BOAMP count is evidence), and sets size_hint from the band (OPPIC 100-199: medium, check "agent said small")', 'public_apis (registry_search), BU2', async ok => {
    const reg = await publicApi({ tool: 'registry_search', q: "City'up" }, () => ({ results: [
      { nom_complet: "CITY'UP (CFTU)", siren: '431938091', nature_juridique: '5515', siege: { siret: '43193809100110', adresse: '19 RUE DE LA LIBERTE 97200 FORT DE FRANCE', libelle_commune: 'FORT DE FRANCE' }, complements: {}, tranche_effectif_salarie: '11', annee_tranche_effectif_salarie: '2024' },
      { nom_complet: "CITY'UP MOBILITE", siren: '924930217', nature_juridique: '5710', siege: { siret: '92493021700014', adresse: '19 RUE DE LA LIBERTE 97200 FORT-DE-FRANCE', libelle_commune: 'FORT-DE-FRANCE' }, complements: {}, tranche_effectif_salarie: 'NN', annee_tranche_effectif_salarie: null }] }));
    ok(/\| staff=10-19 \| staff_year=2024/.test(reg.result) && /CITY'UP MOBILITE .*\| staff=unknown \|/.test(reg.result), 'band printed');
    const c = await research(CITYUP, cityupR2(CITYUP_STEPS)), cb = await research(CITYUP, cityupR2([step('registry_search', { q: "City'up" }, REG_CITYUP.replace('staff=11', 'staff=10-19')), ...CITYUP_STEPS.slice(1)]));
    ok(c.profile.summary === 'It has published tenders for services like LLM agent development and IT infrastructure, with 12 public notices in the last three years.' && cb.profile.summary === c.profile.summary, '12 notices kept');
    ok(c.profile.staff === cb.profile.staff && /^10-19 employees/.test(c.profile.staff) && c.profile.size_hint === 'small' && c.profile.checks.some(x => /number not in evidence\): City'up \(972\) is a mixed-economy company based in Fort-de-France, with 11/.test(x)), 'code or band');
    const oppic = await research(buyer({ buyer_key: 'oppic', name: 'OPPIC', search_name: 'OPPIC' }), researchAgent({ buyer_type: 'public_agency', size_hint: 'small' },
      [step('registry_search', { q: 'OPPIC' }, 'REG | OPERATEUR DU PATRIMOINE ET DES PROJETS IMMOBILIERS DE LA CULTURE (OPPIC) | siren=180092082 | siret=18009208200049 | addr=19 AVENUE DU MAINE 75015 PARIS | city=PARIS | nature=7389 | public=yes | staff=22 | staff_year=2024')]));
    ok(oppic.profile.size_hint === 'medium' && oppic.profile.checks.includes('size medium from the registry staff band 100-199 (agent said small)'), 'size from band');
    return `${reg.result.split('\n').map(l => l.match(/staff=[^|]*/)[0].trim()).join(', ')}; City'up "${c.profile.summary}" (${c.profile.size_hint}); OPPIC size ${oppic.profile.size_hint}`;
  });
C(A3, 'Agent stops before decp_awards and web_search (real City\'up run)', "City'up's 3 calls of the run (registry_search, boamp_history, wikidata_lookup, made at once before any SIREN), then its answer: registry matched (431938091), no decp_awards, no web_search, no website in the notice (Ministère de l'Intérieur: same calls, no e-mail either)",
  'checks "awards not searched: decp_awards not called with the matched SIREN 431938091" and, without a website found, "website not searched"; facts.awards null (unknown), not false; with the call made, awards false as before', 'BU2', async ok => {
    const c = await research(CITYUP, cityupR2(CITYUP_STEPS)), m = await research(MININT, minint(WD_MININT));
    const searched = await research(CITYUP, cityupR2([...CITYUP_STEPS, step('decp_awards', { siren: '431938091' }, 'NO RESULTS')]));
    ok(c.facts.awards === null && c.profile.checks.includes('awards not searched: decp_awards not called with the matched SIREN 431938091') && !c.profile.checks.some(x => /website not searched/.test(x)) && c.profile.official_website === 'https://cityup.mq', 'City\'up');
    ok(m.facts.awards === null && m.profile.checks.includes('website not searched: web_search not called (no website in the notice)'), 'Ministère');
    ok(searched.facts.awards === false && !searched.profile.checks.some(x => /not searched: decp/.test(x)), 'searched');
    return `facts.awards ${c.facts.awards} -> with the call ${searched.facts.awards}; ${c.profile.checks.find(x => /not searched/.test(x))}; Ministère: ${m.profile.checks.find(x => /website not searched/.test(x))}`;
  });
C(A3, 'One answer field outside its list loses the whole answer (real OPPIC answer)', 'OPPIC (registry 7389, public=yes, staff 22 = 100-199) answered buyer_type "public" (not in the list), size_hint small, a 3-sentence summary and http://www.oppic.fr/',
  'only buyer_type becomes unknown (check "-> unknown"), so the legal form 7389 types it public_agency; the summary keeps its supported sentence (the 22 employees one and the website one removed); size medium from the staff band', 'BU2', async ok => {
    const o = await research(buyer({ buyer_key: 'oppic', name: 'OPPIC', search_name: 'OPPIC', tender_titles: ['Prestations d’infogérance de l’ensemble des équipements informatiques de l’OPPIC'] }), researchAgent({ buyer_type: 'public', size_hint: 'small', official_website: 'http://www.oppic.fr/',
      summary: 'OPPIC is a public body based in Paris, France, with 22 employees. It has published multiple tenders, including infogérance services and cultural projects, in the last three years. Its official website is http://www.oppic.fr/' },
      [step('wikidata_lookup', { q: 'OPPIC' }, 'WD | Opérateur du patrimoine et des projets immobiliers de la culture |  | id=Q3354607 | match=alias:OPPIC | website=http://www.oppic.fr/'),
        step('registry_search', { q: 'OPPIC' }, 'REG | OPERATEUR DU PATRIMOINE ET DES PROJETS IMMOBILIERS DE LA CULTURE (OPPIC) | siren=180092082 | siret=18009208200049 | addr=19 AVENUE DU MAINE 75015 PARIS | city=PARIS | nature=7389 | public=yes | staff=22 | staff_year=2024'),
        step('boamp_history', { buyer_name: 'OPPIC' }, 'TOTAL 333\nBOAMP | 26-91336 | 2026-09-22 | APPEL_OFFRE | Marché d’infogérance informatique | buyer=OPPIC | winners=')]));
    ok(o.profile.checks.some(c => /^agent answer: \$\.buyer_type: "public" not in .* -> unknown$/.test(c)) && !o.profile.checks.some(c => /final answer invalid/.test(c)), 'field only');
    ok(o.profile.buyer_type === 'public_agency' && o.profile.size_hint === 'medium' && o.profile.summary === 'It has published multiple tenders, including infogérance services and cultural projects, in the last three years.', 'rest kept');
    return `buyer_type ${o.profile.buyer_type}, size ${o.profile.size_hint}, summary "${o.profile.summary}"`;
  });
const MEL_TASK = marketTask({ title: "Prestations de développement numérique, d'information et d'accompagnement aux usages sur dataMEL - plateforme métropolitaine de données open source de la Métropole Européenne de Lille", buyer: 'Métropole européenne de Lille',
  summary: "La marché porte sur des prestations de développement numérique, d'information et d'accompagnement aux usages sur dataMEL - plateforme métropolitaine de données open source de la Métropole Européenne de Lille", requirements: ['Experience in open source data management with public or private actors required'] });
const MEL_ROWS = [['D1iawp2m', '2026-07-29', 640292, 'WA CONCEPT', 1, '72212422', 'yes', 'Maintenance, hébergement, prestations associées et équipements d’une solution informatique de télégestion des '],
  ['D2wb6ch', '2026-07-16', 978839, 'OSLO', 1, '72212422', 'yes', 'Maintenance et prestations de développement associées de l’outil de gestion informatique du patrimoine métropo'],
  ['Dgdas68', '2026-06-15', 991896, 'ASYS', 1, '72267100', 'yes', 'Maintenance, acquisition, hébergement et prestations d’une solution de gestion du temps de travail'],
  ['D1q95xr9', '2026-06-12', 956657, 'EKSAE', 1, '72267100', 'yes', 'Maintenance, acquisition et prestations associées sur la suite logicielle de gestion des ressources humaines :'],
  ['D11p9vme', '2026-04-17', 184000, 'KONDUCO', 1, '72267100', 'yes', 'Maintenance, acquisition, hébergement et prestations associées sur l’application GESTMAX'],
  ['D6wv0mx', '2026-03-09', 400000, 'SANTERNE NORD PICARDIE INFRA', 3, '72315000', 'yes', 'Prestations d’installation de compteurs routiers et autres matériels de mesure sur le territoire de la MEL'],
  ['Ddgf9u3', '2026-03-06', 1200000, '', 4, '72500000', 'yes', 'ACQUISITION D’UNE SOLUTION DE BILLETTERIE POUR LES SERVICES DE LA MEL'],
  ['D1oybnqv', '2026-03-06', 750000, 'ESRI FRANCE', 1, '72267100', 'yes', 'Maintenance, acquisition et prestations associées sur une suite de logiciels d’information géographique : ArcG'],
  ['D1n73gbh', '2026-01-09', 294994, 'EFFICY FRANCE', 1, '72267100', 'yes', 'Maintenance, acquisition et prestations associées sur l’application E-DEAL'],
  ['D14sq6bi', '2026-01-06', 207790, 'SYSTRA FRANCE', 6, '72241000', 'no', 'La consultation porte sur une mission de définition et de mise en œuvre de la stratégie foncière du projet par']]
  .map(([id, date, amount, winners, bids, cpv, fw, title]) => award(id, { date, amount, winners, bids, cpv, fw, title, buyer: 'METROPOLE EUROPEENNE DE LILLE' }))
  .concat("AWARD | T643461-2026 | 2026-09-18 | amount=5000000 | cur=EUR | buyer=Métropole européenne de Lille | winners=ADVENS; EXTERN DPO | bids=12 | cpv=72810000 | fw=yes | src=TED | title=Centrale d’Achat Métropolitaine – Prestations de service en sécurité des systèmes d'information et de mise en ");
C(A5, 'Market answer cut short by a full context (real MEL study)', 'MEL: the agent\'s answer stopped after 141 characters, \'{"comparable_ids":["D1iawp2m",...,"T643461-2026","\' (16.4k characters of rows in an 8k-token context); then 3 priced rows answered cut short, and complete but closed too early (\'...]}\\n,"positioning":...\')',
  'studied, not answer_invalid: the 11 ids written are the comparables (check "agent answer cut short ... 11 comparable id(s)"); cut short = confidence a level less (low -> very low), the complete malformed one keeps low', 'MK2', async ok => {
    const cut = '{"comparable_ids":["D1iawp2m","D2wb6ch","Dgdas68","D1q95xr9","D11p9vme","D6wv0mx","Ddgf9u3","D1oybnqv","D1n73gbh","D14sq6bi","T643461-2026","';
    const mel = (await market({ output: cut, intermediateSteps: [step('buyer_awards', { buyer_name: 'Métropole européenne de Lille', cpv: '7200', country: 'FR' }, awardsObs(MEL_ROWS, 'TOTAL DECP 10 of this buyer among 186 found by buyer name "EUROPEENNE" (no SIREN), TED 9 found'))] }, MEL_TASK)).market;
    ok(mel.status === 'studied' && mel.comparables.length === 11 && mel.checks.some(c => /^agent answer cut short \(no JSON object in answer\): 11 comparable id\(s\) read from it/.test(c)) && mel.budget.median === 207790, 'MEL salvaged');
    const ids = '"D1","D2","D3"', obs = [similar(ROWS3)];
    const cutShort = (await market({ output: `{"comparable_ids":[${ids},"`, intermediateSteps: obs })).market, closed = (await market({ output: `{"comparable_ids":[${ids}]}\n,"positioning":"SOPRA STERIA won 2."}`, intermediateSteps: obs })).market;
    ok(cutShort.budget.confidence === 'very low' && closed.budget.confidence === 'low' && closed.checks.some(c => /^agent answer malformed/.test(c)) && closed.comparables.length === 3, 'confidence');
    return `MEL ${mel.status}, ${mel.comparables.length} comparables, budget ${mel.budget.median} (${mel.budget.confidence}); 3 rows cut short ${cutShort.budget.confidence}, closed early ${closed.budget.confidence}`;
  });
C(A5, 'One market tool call fills the model\'s context (real MEL input)', 'similar_awards {cpv "7200", query "développement numérique, information, accompagnement", FR} (real MEL input): DECP returns its 30 newest rows per keyword, one row under 2 keywords; TED 464 found',
  'about 18 rows / 5000 characters in all (it was 24 DECP + 20 TED rows, 11.6k characters: with buyer_awards the answer was cut): 4 DECP rows per keyword, never a row twice, TED asked for the rest (6), the rows past the size budget left out and said so', 'public_apis (similar_awards)', async ok => {
    const t = 'Prestations de développement et d’accompagnement aux usages de la plateforme de données ouvertes de la collectivité';
    const { result, reqs } = await publicApi({ tool: 'similar_awards', cpv: '7200', query: 'développement numérique, information, accompagnement', country: 'FR' }, o => /tabular-api/.test(o.url)
      ? { data: Array.from({ length: 30 }, (_, k) => decpRow({ uid: k === 0 ? 'both' : `${o.qs.objet__contains}${k}`, objet: `${t} (${o.qs.objet__contains} ${k})`, acheteur_nom: 'METROPOLE EUROPEENNE DE LILLE', titulaire_nom: 'OPEN DATA SOFT SAS' })), meta: { total: 1343 } }
      : /api\.ted\.europa\.eu/.test(o.url) ? { totalNoticeCount: 464, notices: Array.from({ length: o.body.limit }, (_, k) => ({ 'publication-number': `${700100 + k}-2026`, 'publication-date': '2026-10-01+02:00', 'title-proc': { fra: `${t} n° ${k}` },
        'buyer-name': { fra: ['Métropole européenne de Lille'] }, 'classification-cpv': ['72000000'], 'total-value': 400000 + k, 'winner-name': { fra: ['OPEN DATA SOFT'] } })) } : {});
    const rows = result.split('\n').filter(l => l.startsWith('AWARD')), ids = rows.map(l => l.split(' | ')[1]), ted = reqs.find(r => /api\.ted/.test(r.url));
    ok(rows.length <= 18 && rows.join('\n').length <= 5000 && new Set(ids).size === ids.length, 'size'); ok(rows.filter(l => /src=DECP/.test(l)).length === 12 && ted.body.limit === 6, '4 per keyword, TED the rest');
    ok(/DECP 1343 found \(CPV 72\*, "développement"\), newest 4 shown/.test(result) && /\(showing \d+ of 18: the others left out to keep the answer short\)/.test(result), 'said');
    return `${rows.length} rows, ${rows.join('\n').length} characters; ${result.split('\n')[0].slice(-80)}`;
  });
C(A5, 'DECP keyword: an acronym, not the homonym "agents" (real City\'up input)', 'similar_awards {cpv "72000000", query "agents LLM, RAG chains", FR} (real): DECP was searched "agents" (78 found: payroll slips, housing for city staff) and "chains" (0); "RAG" is also inside "maîtrise d’ouvrage"',
  'DECP searched "LLM" and "RAG" (the acronyms), and of the RAG rows only those with the whole word are kept (the AMOA row dropped, said in the TOTAL line)', 'public_apis (similar_awards)', async ok => {
    const { result, reqs } = await publicApi({ tool: 'similar_awards', cpv: '72000000', query: 'agents LLM, RAG chains', country: 'FR' }, stubApis(qs => (qs.objet__contains === 'LLM' ? { data: [decpRow({ uid: 'l1', objet: 'Développement d’agents LLM pour la relation aux usagers' })], meta: { total: 1 } }
      : qs.objet__contains === 'RAG' ? { data: [decpRow({ uid: 'r1', objet: 'Assistance à maîtrise d’ouvrage pour la refonte du système d’information' }), decpRow({ uid: 'r2', objet: 'Chaîne RAG de recherche documentaire pour les services' })], meta: { total: 2 } } : { data: [], meta: { total: 0 } })));
    const words = reqs.filter(r => /tabular-api/.test(r.url)).map(r => r.qs.objet__contains);
    ok(words.join() === 'LLM,RAG', 'acronyms searched'); ok(/Chaîne RAG/.test(result) && /agents LLM/.test(result) && !/maîtrise/.test(result) && /DECP 2 found \(CPV 72\*, "RAG"\), 1 of the newest 2 with the whole word, newest 1 shown/.test(result), 'whole word');
    return `${words.join(' / ')} -> ${result.split('\n')[0].slice(0, 150)}`;
  });
C(A5, 'One award republished 2 days apart reads as 2 wins (real City\'up comparables)', "City'up's 12 rows and the agent's 5 picks: DECP D1eipd4z (2026-01-08) and D12exx6m (2026-01-06), same buyer CA CANNES PAYS DE LERINS, 39 000, POLARIA TECHNOLOGIES, the title reworded; the budget rests on one contract (315 708) for a declared 180000 euros",
  'both rows listed, POLARIA 1 win (check "may repeat an award a few days apart ... D12exx6m ~ D1eipd4z"), so no "won 2 comparable contracts" risk in the proposal input; check "budget rests on one contract ... far from the value the notice declares"', 'MK2, PR1', async ok => {
    const row = (id, date, amount, buyer, winners, bids, cpv, fw, title) => `AWARD | ${id} | ${date} | amount=${amount} | cur=EUR | buyer=${buyer} | winners=${winners} | bids=${bids} | cpv=${cpv} | fw=${fw} | src=DECP | title=${title}`;
    const rows = [row('Dfeb4l7', '2026-06-29', 7000, "EAU D 'AZUR (SERVICES SUPPORTS MUTUALISES)", 'SEPTEO HR SOLUTIONS', 1, '72000000', 'yes', 'Solution de mise à disposition des bulletins de paies dématérialisés pour les agents d’EAU d’AZUR'),
      row('D1eipd4z', '2026-01-08', 39000, "COMMUNAUTE D'AGGLOMERATION CANNES PAYS DE LERINS", 'POLARIA TECHNOLOGIES', 1, '72253000', 'yes', 'RELANCE ASSISTANCE TECHNIQUE D’UN OUTIL CONVERSATIONNEL POUR LES AGENTS COMMUNAUTAIRES EN MATIERE DE RESSOURCE'),
      row('D12exx6m', '2026-01-06', 39000, "COMMUNAUTE D'AGGLOMERATION CANNES PAYS DE LERINS", 'POLARIA TECHNOLOGIES', 1, '72253000', 'yes', 'RELANCE MISE A DISPOSITION ET ASSISTANCE TECHNIQUE D&#8217;UN OUTIL CONVERSATIONNEL POUR LES AGENTS COMMUNAUTA'),
      row('D1fq5e99', '2025-12-30', 315708, 'CENTRE DEPARTEMENTAL DE GESTION DE LA FONCTION PUBLIQUE TERRITORIALE', 'VAL SOLUTIONS', 3, '72267000', 'no', 'La consultation a pour objet la fourniture et la maintenance d’un logiciel dédié aux missions du pôle médecine'),
      row('D15gllaq', '2025-11-25', 47171, 'CENTRE NATIONAL DE LA RECHERCHE SCIENTIFIQUE (CNRS UMR 5277 IRAP)', 'CGI FRANCE', 1, '72250000', 'yes', 'MS070 Fait générateur agents sortis lot 2')];
    const task = marketTask({ title: 'Prestations de développement d\'agents LLM et services associés', buyer: "City'up (972)", declared_value: '180000 euros', requirements: ['LLM agents', 'RAG chains', 'document intelligence'] });
    const m = (await market(marketAgent({ comparable_ids: ['Dfeb4l7', 'D1eipd4z', 'D12exx6m', 'D1fq5e99', 'D15gllaq'] }, [step('similar_awards', { cpv: '72000000', query: 'agents LLM, RAG chains', country: 'FR' }, awardsObs(rows, 'TOTAL DECP 78 found (CPV 72*, "agents"), newest 12 shown'))]), task)).market;
    const wins = n => (m.competitors.find(c => c.name === n) || {}).wins;
    ok(wins('POLARIA TECHNOLOGIES') === 1 && m.comparables.length === 5 && m.checks.some(c => /^1 row\(s\) may repeat an award a few days apart \(same buyer, amount and winners\): counted once \(D12exx6m ~ D1eipd4z\)/.test(c)), 'one win');
    ok(m.checks.some(c => /^budget rests on one contract \(315708 EUR\) far from the value the notice declares \(180000 euros\)/.test(c)), 'declared');
    const p = await proposal(ragTender({ market: m }));
    ok((p.competition.competitors.find(c => c.name === 'POLARIA TECHNOLOGIES') || {}).past_wins === 1 && !p.analysis.risks.some(r => /won 2 comparable/.test(r)), 'proposal');
    return `competitors ${m.competitors.map(c => `${c.name} ${c.wins}`).join(', ')}; proposal risks: ${p.analysis.risks.filter(r => /won/.test(r)).join(' | ') || 'no win risk'}`;
  });
C(A5, 'Budget set by printers for an IT infogérance (real OPPIC comparables)', 'OPPIC "Prestations d’infogérance de l’ensemble des équipements informatiques" (CPV 50312310): of 12 real rows the agent chose 11, among them T724527-2026 (purchase and maintenance of printing systems, CPV 30120000,...) and T705134-2026 (printers, 50313000,30120000) at 365 000 / 380 000; RATP firewalls supply 30200000',
  'rows that also buy goods (a 03-44 supply CPV the tender has none of) left out with a check, SHARP and "objectif pour la bureautique" no competitors; 11 of 12 chosen: confidence a level less', 'MK2', async ok => {
    const rows = ['AWARD | D8asqpy | 2024-10-31 | amount=39920 | cur=EUR | buyer=COMMUNE DE SAINT-JULIEN-DE-CONCELLES (MAIRIE) | winners=APS SOLUTIONS INFORMATIQUES | bids=3 | cpv=50312300 | fw=no | src=DECP | title=Infogérance, maintenance et prestation à distance du parc informatique de la commune de saint julien de concel',
      "AWARD | Dxwgekz | 2025-06-19 | amount=179040 | cur=EUR | buyer=COMMUNAUTE D'AGGLOMERATION DU BASSIN D'ARCACHON NORD | winners=TELELEC INFORMATIQUE | bids=5 | cpv=50312000 | fw=no | src=DECP | title=Infogérance informatique pour la COBAN",
      'AWARD | D1ytcn5z | 2026-09-18 | amount=240000 | cur=EUR | buyer=SCE DEPARTEMENTAL INCENDIE ET SECOURS | winners=A.P.S INT | bids=1 | cpv=50312300 | fw=no | src=DECP | title=PRESTATION DE MAINTENANCE DES ONDULEURS',
      'AWARD | D1otkqyi | 2024-10-07 | amount=5492 | cur=EUR | buyer=SM DU PAYS DE RENNES | winners= | bids=2 | cpv=50312000 | fw=no | src=DECP | title=La consultation concerne la maintenance, l’assistance et l’infogérance du parc informatique du Syndicat Mixte ',
      'AWARD | D1uzniot | 2025-12-24 | amount=80000 | cur=EUR | buyer=ETABLISSEMENT PUBLIC FONCIER DE NOUVELLE-AQUITAINE | winners=A2I INFORMATIQUE | bids=3 | cpv=50312310 | fw=yes | src=DECP | title=Infogérance du système d’information de l’Etablissement Public Foncier de Nouvelle Aquitaine (EPFNA)',
      'AWARD | Dqivbz8 | 2024-10-01 | amount=55000 | cur=EUR | buyer=COMMUNE DE SAINT MANDRIER SUR MER (MAIRIE) | winners=SYMEXO | bids=2 | cpv=50312000 | fw=yes | src=DECP | title=Hébergement et infogérance du Système d’Information de la ville de Saint Mandrier sur Mer',
      "AWARD | D3r75f1 | 2026-09-21 | amount=400000 | cur=EUR | buyer=DEPARTEMENT DE L'INDRE | winners=MAINTRONIC | bids=1 | cpv=50312000 | fw=yes | src=DECP | title=Maintenance des matériels informatiques dans les collèges publics du Département de l’Indre",
      'AWARD | T577684-2026 | 2026-08-20 | amount=73875 | cur=EUR | buyer=Mairie du Lamentin | winners=EIFFAGE ENERGIE SYSTEMES MARTINIQUE SAS | bids=1 | cpv=50312000,50343000 | fw=no | src=TED | title=MAINTENANCE DES SYSTEMES DE VIDEO PROTECTION DE LA VILLE DU LAMENTIN',
      "AWARD | T724527-2026 | 2026-10-20 | amount=365000 | cur=EUR | buyer=Communauté d'agglomération du Grand Cahors | winners=SHARP BUSINESS SYSTEMS FRANCE | bids=3 | cpv=30120000,50313100,50313200 | fw=no | src=TED | title=ACHAT ET MAINTENANCE DE SYSTEMES D'IMPRESSION NEUFS, PROLONGATION DE MAINTENANCE DU PARC ACTUEL, ACQUISITION E",
      "AWARD | T705134-2026 | 2026-10-13 | amount=380000 | cur=EUR | buyer=Ville d'Elancourt | winners=objectif pour la bureautique | bids=1 | cpv=50313000,30120000 | fw=no | src=TED | title=MARCHE PUBLIC D'ACQUISITION ET MAINTENANCE DE MATERIELS D'IMPRESSION DE LA COMMUNE D'ELANCOURT",
      'AWARD | T622790-2026 | 2026-09-10 | amount=541009 | cur=EUR | buyer=RATP | winners=MIND TECHNOLOGIES | bids= | cpv=30200000,50312310 | fw=yes | src=TED | title=FOURNITURE ET MAINTENANCE D EQUIPEMENTS DE CLOISONNEMENT RESEAU << PARE FEUX>>',
      'AWARD | T585974-2026 | 2026-08-25 | amount=135000 | cur=EUR | buyer=CONSEIL DEPARTEMENTAL DES VOSGES | winners=KOSEIO EST | bids=1 | cpv=50313100,50313200 | fw=yes | src=TED | title=Maintenance de copieurs et imprimantes'];
    const task = marketTask({ title: 'Prestations d’infogérance de l’ensemble des équipements informatiques de l’OPPIC', buyer: 'OPPIC', cpv: ['50312310'], tender_type: 'maintenance_support',
      summary: 'Le présent marché est un marché d’infogérance informatique ayant pour objet la réalisation des prestations de maintenance préventive et corrective de l’ensemble des équipements informatiques de l’OPPIC', requirements: ['Maintenance préventive et corrective des équipements informatiques'] });
    const m = (await market(marketAgent({ comparable_ids: rows.slice(0, 11).map(l => l.split(' | ')[1]) }, [step('similar_awards', { cpv: '5031', query: 'infogérance, maintenance, équipements informatiques', country: 'FR' }, awardsObs(rows, 'TOTAL DECP 11 found (CPV 5031*, "infogérance"), newest 8 shown, TED 371 found'))]), task)).market;
    const names = m.competitors.map(c => c.name);
    ok(m.checks.some(c => /^3 chosen contract\(s\) also buy goods the tender does not \(supply CPV\): left out \(T724527-2026 .* \| T705134-2026 .* \| T622790-2026 /.test(c)) && !names.includes('SHARP BUSINESS SYSTEMS FRANCE') && !names.includes('objectif pour la bureautique'), 'goods out');
    ok(m.budget.comparables === 4 && m.budget.high < 365000 && m.budget.confidence === 'very low' && m.checks.includes('agent chose 11 of the 12 contracts shown: budget confidence lowered'), 'budget');
    return `budget ${m.budget.low} / ${m.budget.median} / ${m.budget.high} (${m.budget.comparables}, ${m.budget.confidence}); competitors ${names.join(', ')}`;
  });
C(A5, 'buyer_awards by name: the town, not an adjective (real MEL input)', 'buyer_awards {buyer_name "Métropole européenne de Lille", cpv "7200", FR}, no SIREN (real): searched "EUROPEENNE", 186 rows of which only the newest 30 are read, the note said "among 186 found"',
  'search word LILLE (EUROPEENNE is a common adjective); the note says only the newest 30 rows were read when there are more', 'public_apis (buyer_awards)', async ok => {
    const { result, reqs } = await publicApi({ tool: 'buyer_awards', buyer_name: 'Métropole européenne de Lille', cpv: '7200', country: 'FR', siren: '' },
      stubApis(qs => (qs.acheteur_nom__contains ? { data: [decpRow({ uid: 'm1', acheteur_nom: 'METROPOLE EUROPEENNE DE LILLE', objet: 'Maintenance et prestations associées sur l’application E-DEAL' })], meta: { total: 186 } } : { data: [], meta: { total: 0 } })));
    const q = reqs.find(r => /tabular-api/.test(r.url));
    ok(q.qs.acheteur_nom__contains === 'LILLE' && /DECP 1 of this buyer among 186 found by buyer name "LILLE" \(only the newest 30 read\) \(no SIREN\)/.test(result), 'LILLE');
    return result.split('\n')[0];
  });
C(A5, 'HTML entities in award titles (real DECP / TED titles)', 'DECP objet "RELANCE MISE A DISPOSITION ET ASSISTANCE TECHNIQUE D&#8217;UN OUTIL CONVERSATIONNEL" (D12exx6m) and a TED title "... sur les sujets Cloud, Data &amp;amp; IA" (T677198-2026)',
  'decoded in the AWARD rows: "D’UN OUTIL", "Cloud, Data & IA"', 'public_apis (similar_awards)', async ok => {
    const { result } = await publicApi({ tool: 'similar_awards', cpv: '72', query: 'outil conversationnel', country: 'FR' }, o => /tabular-api/.test(o.url)
      ? { data: [decpRow({ uid: 'p1', objet: 'RELANCE MISE A DISPOSITION ET ASSISTANCE TECHNIQUE D&#8217;UN OUTIL CONVERSATIONNEL POUR LES AGENTS COMMUNAUTAIRES', acheteur_nom: "COMMUNAUTE D'AGGLOMERATION CANNES PAYS DE LERINS", montant: 39000, titulaire_nom: 'POLARIA TECHNOLOGIES' })], meta: { total: 1 } }
      : /api\.ted/.test(o.url) ? { totalNoticeCount: 1, notices: [{ 'publication-number': '677198-2026', 'publication-date': '2026-10-01+02:00', 'title-proc': { fra: "La fourniture de service et d'accompagnement sur les sujets Cloud, Data &amp;amp; IA" }, 'buyer-name': { fra: ['KEDGE BUSINESS SCHOOL'] }, 'total-value': 3600000 }] } : {});
    ok(/title=RELANCE MISE A DISPOSITION ET ASSISTANCE TECHNIQUE D’UN OUTIL CONVERSATIONNEL/.test(result) && /sur les sujets Cloud, Data & IA$/m.test(result) && !/&#|&amp;/.test(result), 'decoded');
    return result.split('\n').filter(l => l.startsWith('AWARD')).map(l => l.slice(l.indexOf('title=') + 6, l.indexOf('title=') + 66)).join(' | ');
  });
C(A3, '"website not searched" when the notice gave only a tender platform (real City\'up input)', "City'up's 3 calls of the run (no web_search), its notice website https://v2.marches-securises.fr (a tender platform: Select Buyers leaves known_website empty) and no e-mail address this time, so no website is found",
  'the check gives the real cause: "website not searched: web_search not called (the notice gives only v2.marches-securises.fr, not the buyer\'s own site)", not "no website in the notice"', 'BU2', async ok => {
    const c = await research({ ...CITYUP, notice_contacts: { ...CITYUP.notice_contacts, emails: [] } }, cityupR2(CITYUP_STEPS));
    ok(c.profile.official_website === '' && c.profile.checks.includes('website not searched: web_search not called (the notice gives only v2.marches-securises.fr, not the buyer\'s own site)'), 'cause');
    return c.profile.checks.find(x => /website not searched/.test(x));
  });
C(A5, 'A service contract with a supply CPV besides its main one (real OPPIC rows)', 'OPPIC infogérance (CPV 50312310), the agent chose 6 real rows: 3 DECP infogérance rows, T577684-2026 (maintenance of video protection, here with a 3rd TED code 32323500, video equipment, besides its main 50312000), T705134-2026 (main 50313000, "MARCHE PUBLIC D\'ACQUISITION ET MAINTENANCE DE MATERIELS D\'IMPRESSION") and T724527-2026 (main 30120000, printers)',
  'T705134 (its title buys) and T724527 (main CPV supply) left out; T577684 kept, its amount in the budget, with the check "list a supply CPV besides their main service: kept"', 'MK2', async ok => {
    const rows = ['AWARD | D8asqpy | 2024-10-31 | amount=39920 | cur=EUR | buyer=COMMUNE DE SAINT-JULIEN-DE-CONCELLES (MAIRIE) | winners=APS SOLUTIONS INFORMATIQUES | bids=3 | cpv=50312300 | fw=no | src=DECP | title=Infogérance, maintenance et prestation à distance du parc informatique de la commune de saint julien de concel',
      "AWARD | Dxwgekz | 2025-06-19 | amount=179040 | cur=EUR | buyer=COMMUNAUTE D'AGGLOMERATION DU BASSIN D'ARCACHON NORD | winners=TELELEC INFORMATIQUE | bids=5 | cpv=50312000 | fw=no | src=DECP | title=Infogérance informatique pour la COBAN",
      'AWARD | D1uzniot | 2025-12-24 | amount=80000 | cur=EUR | buyer=ETABLISSEMENT PUBLIC FONCIER DE NOUVELLE-AQUITAINE | winners=A2I INFORMATIQUE | bids=3 | cpv=50312310 | fw=yes | src=DECP | title=Infogérance du système d’information de l’Etablissement Public Foncier de Nouvelle Aquitaine (EPFNA)',
      'AWARD | T577684-2026 | 2026-08-20 | amount=73875 | cur=EUR | buyer=Mairie du Lamentin | winners=EIFFAGE ENERGIE SYSTEMES MARTINIQUE SAS | bids=1 | cpv=50312000,50343000,32323500 | fw=no | src=TED | title=MAINTENANCE DES SYSTEMES DE VIDEO PROTECTION DE LA VILLE DU LAMENTIN',
      "AWARD | T705134-2026 | 2026-10-13 | amount=380000 | cur=EUR | buyer=Ville d'Elancourt | winners=objectif pour la bureautique | bids=1 | cpv=50313000,30120000 | fw=no | src=TED | title=MARCHE PUBLIC D'ACQUISITION ET MAINTENANCE DE MATERIELS D'IMPRESSION DE LA COMMUNE D'ELANCOURT",
      "AWARD | T724527-2026 | 2026-10-20 | amount=365000 | cur=EUR | buyer=Communauté d'agglomération du Grand Cahors | winners=SHARP BUSINESS SYSTEMS FRANCE | bids=3 | cpv=30120000,50313100,50313200 | fw=no | src=TED | title=ACHAT ET MAINTENANCE DE SYSTEMES D'IMPRESSION NEUFS, PROLONGATION DE MAINTENANCE DU PARC ACTUEL, ACQUISITION E"];
    const task = marketTask({ title: 'Prestations d’infogérance de l’ensemble des équipements informatiques de l’OPPIC', buyer: 'OPPIC', cpv: ['50312310'], tender_type: 'maintenance_support',
      summary: 'Le présent marché est un marché d’infogérance informatique ayant pour objet la réalisation des prestations de maintenance préventive et corrective de l’ensemble des équipements informatiques de l’OPPIC', requirements: ['Maintenance préventive et corrective des équipements informatiques'] });
    const m = (await market(marketAgent({ comparable_ids: rows.map(l => l.split(' | ')[1]) }, [step('similar_awards', { cpv: '5031', query: 'infogérance, maintenance, équipements informatiques', country: 'FR' }, awardsObs(rows, 'TOTAL DECP 11 found (CPV 5031*, "infogérance"), newest 8 shown, TED 371 found'))]), task)).market;
    ok(m.checks.some(c => /^2 chosen contract\(s\) also buy goods the tender does not \(supply CPV\): left out \(T705134-2026 .* \| T724527-2026 /.test(c)) && m.comparables.some(c => c.id === 'T577684-2026'), 'main goods out, service kept');
    ok(m.checks.includes('1 chosen contract(s) list a supply CPV besides their main service: kept, their amount may include goods (T577684-2026 50312000,50343000,32323500)') && m.budget.comparables === 3 && m.budget.min === 39920, 'budget');
    return `comparables ${m.comparables.map(c => c.id).join(' ')}; budget ${m.budget.low} / ${m.budget.median} / ${m.budget.high} (${m.budget.comparables})`;
  });
C(A5, 'DECP keyword that is one 3-letter acronym in capitals ("CRM", "SIG")', 'similar_awards {cpv "72", query "CRM, SIG", FR}: each keyword is a lone acronym in capitals, below the 4-letter plain-word floor, so DECP was searched by CPV alone; "SIG" is also inside "SIGNALISATION"',
  'DECP searched "CRM" and "SIG", only the rows with the whole word kept (the signalisation row dropped)', 'public_apis (similar_awards)', async ok => {
    const { result, reqs } = await publicApi({ tool: 'similar_awards', cpv: '72', query: 'CRM, SIG', country: 'FR' }, stubApis(qs => (qs.objet__contains === 'CRM' ? { data: [decpRow({ uid: 'c1', objet: 'Maintenance et évolution du logiciel CRM de la relation usagers' })], meta: { total: 1 } }
      : qs.objet__contains === 'SIG' ? { data: [decpRow({ uid: 's1', objet: 'Marché de travaux de signalisation horizontale et verticale' }), decpRow({ uid: 's2', objet: 'Hébergement et maintenance du SIG communautaire' })], meta: { total: 2 } } : { data: [], meta: { total: 0 } })));
    const words = reqs.filter(r => /tabular-api/.test(r.url)).map(r => r.qs.objet__contains);
    ok(words.join() === 'CRM,SIG' && /logiciel CRM/.test(result) && /du SIG communautaire/.test(result) && !/signalisation/.test(result), 'acronyms');
    return `${words.join(' / ')} -> ${result.split('\n')[0].slice(0, 160)}`;
  });
// buyer identity by acronym (third run of 2026-10-20, BOAMP 26-101315): "ATIH." (the Agence technique de l'information sur
// l'hospitalisation, Lyon) took the registry's Paris translation firm "(ATIH)"; the notice gave the agency's SIRET 18009229800033
const ATIH_TITLE = 'Prestation d’ingénierie en matière de traitements et d\'analyse de données, d\'études statistiques et de restitutions de données';
const ATIH_TENDER = { tender_id: 'T1ytbl1u', buyer_key: 'atih', buyer_id: 'Ba3jvpd', survivor: true, too_late: false, days_left: 31, title: ATIH_TITLE, source: 'boamp',
  source_url: 'https://www.boamp.fr/pages/avis/?q=idweb:26-101315', submission_url: 'https://www.marches-publics.gouv.fr/entreprise/consultation/3067944?orgAcronyme=h8j',
  documents_url: 'https://www.marches-publics.gouv.fr/', external_id: '26-101315', language: 'fr', place: '69', analysis: { fit: 'high' },
  buyer: { name: 'ATIH.', country: 'FR', national_id: '18009229800033', contacts: { email: 'marchespublics@atih.sante.fr', phone: '04 37 91 33 10', website: null, address: '69329 LYON' } } };
// the Select Buyers item the run researched (no notice SIREN nor place then)
const ATIH_RUN3 = buyer({ buyer_key: 'atih', buyer_id: 'Ba3jvpd', name: 'ATIH.', search_name: 'ATIH.', tender_titles: [ATIH_TITLE], tenders: [{ tender_id: 'T1ytbl1u', external_id: '26-101315', title: ATIH_TITLE }],
  notice_contacts: { emails: ['marchespublics@atih.sante.fr'], phones: ['04 37 91 33 10'], websites: [], addresses: ['69329 LYON'] },
  exclude_hosts: ['boamp-datadila.opendatasoft.com', 'host.docker.internal:8004', 'francemarches.com', 'domainetat.tn', 'boamp.fr', 'marches-publics.gouv.fr'] });
const REG_ATIH_AGENCY = "REG | AGENCE TECHNIQUE DE L'INFORMATION SUR L'HOSPITALISATION (ATIH) | siren=180092298 | siret=18009229800033 | addr=IMMEUBLE LE TRIANGLE PART-DIEU 117 BOULEVARD MARIUS VIVIER-MERLE 69003 LYON | city=LYON | nature=7389 | public=yes | staff=100-199 | staff_year=2024";
const REG_ATIH_FIRM = 'REG | AGENCE DE TRADUCTION INTERPRETARIAT HASSIBI (ATIH) (ATIH) | siren=810234849 | siret=81023484900018 | addr=115 RUE DE L ABBE GROULT 75015 PARIS 15 | city=PARIS 15 | nature=5710 | public=no | staff=unknown | staff_year=';
const REG_ATIH_ESI = 'REG | PAYE SANS ORDONNANCEMENT ESI LYON | siren=101900009 | siret=10190000900016 | addr=[NON-DIFFUSIBLE] | city=LYON 3EME | nature=7111 | public=yes | staff=unknown | staff_year=';
const DECP_ATIH = ['TOTAL 25', 'DECP | 2025-11-06 | 598525 | INX L’objet de ce marché est de renforcer les capacités d’action de la direction DATA à travers les prestation | cpv=72246000-1 | bids=9 | supplier_siret=84313308300041',
  'DECP | 2025-08-25 | 369187.5 | INX L’objet la présente consultation porte sur la réalisation de prestations d’accompagnement de l’ATIH à la g | cpv=72224000-1 | bids=15 | supplier_siret=84313308300041',
  'DECP | 2025-08-25 | 2000000 | INX L’objet du présent marché est d’accompagner la mise en œuvre des travaux de traitements et restitution des | cpv=72000000-5 | bids=6 | supplier_siret=47976684200443'].join('\n');
const BOAMP_ATIH = ['TOTAL 17', 'BOAMP | 26-101315 | 2026-10-20 | APPEL_OFFRE | Prestation d’ingénierie en matière de traitements et d\'analyse de données, d\'études statistiques et de restitu | buyer=ATIH. | winners=',
  'BOAMP | 26-53923 | 2026-06-03 | ATTRIBUTION | Marché complémentaire de prestations d’ingénierie en matière de traitements de données, d’analyses et études s | buyer=ATIH. | winners=SOLADIS SAS',
  'BOAMP | 26-29606 | 2026-03-24 | ATTRIBUTION | Supervision d’une Etude de Coûts en Psychiatrie pour l’ATIH | buyer=ATIH. | winners=KALITIS SAS'].join('\n');
const atihAgent = (regRows, more = []) => researchAgent({ buyer_type: 'public_agency', size_hint: 'medium', official_website: 'https://www.atih.fr',
  summary: 'ATIH is a public agency based in Lyon, France, with 100-199 employees. It has awarded contracts with a total value of 5 million euros and received bids from multiple suppliers.' },
  [step('wikidata_lookup', { q: 'ATIH' }, "WD | mariage | mode d'organisation de la conjugalité | id=Q8445 | match=alias:atihl\nWD | atikamekw | langue algonquienne | id=Q56590 | match=alias:Atihkamekw | country=CA"),
    step('registry_search', { q: 'ATIH' }, regRows.join('\n')), step('decp_awards', { siren: '180092298' }, DECP_ATIH), step('boamp_history', { buyer_name: 'ATIH' }, BOAMP_ATIH), ...more]);
C(A3, 'Acronym buyer matched to a company sharing only its acronym (real ATIH., BOAMP 26-101315)', 'the real tender as Map Records gives it (buyer "ATIH.", national_id 18009229800033, address "69329 LYON", place 69); the agent\'s real calls: registry_search "ATIH" -> the agency (180092298, Lyon, 7389), the translation firm "AGENCE DE TRADUCTION INTERPRETARIAT HASSIBI (ATIH) (ATIH)" (810234849, Paris 15, 5710) and an ESI; decp_awards 180092298; boamp_history "ATIH"; then one registry_search by the SIREN alone',
  'Select Buyers passes notice_sirens ["180092298"] and place 69, the agent task says "BUYER SIREN (given by the tender notice): 180092298" and its rules say to search the registry by it first; Parse Research takes the agency by that SIREN (the firm refused, check), so its DECP contracts, staff band and Lyon address are the profile\'s (never the firm\'s Paris address); the proposal input carries the agency\'s legal name', 'BU1, build (agent task), BU2, PR1', async ok => {
    const [sb] = await run('Select Buyers', [ATIH_TENDER]);
    ok(JSON.stringify(sb.notice_sirens) === '["180092298"]' && sb.national_id === '18009229800033' && JSON.stringify(sb.notice_places) === '["69"]', 'notice SIREN + place');
    const agentNode = wf.nodes.find(n => n.name === 'Buyer Research Agent'), task = new Function('$json', `return (${agentNode.parameters.text.replace(/^=\{\{([\s\S]*)\}\}$/, '$1')});`)(sb);
    ok(task.includes('\nBUYER SIREN (given by the tender notice): 180092298\n') && /registry_search with q = that 9-digit SIREN before any registry search by name/.test(agentNode.parameters.options.systemMessage), 'agent told');
    const r = await research(sb, atihAgent([REG_ATIH_AGENCY, REG_ATIH_FIRM, REG_ATIH_ESI]));
    ok(r.profile.legal_name === "AGENCE TECHNIQUE DE L'INFORMATION SUR L'HOSPITALISATION (ATIH)" && r.profile.siren === '180092298' && r.profile.registry.reason === 'SIREN given by the notice (180092298)', 'agency');
    ok(r.profile.checks.includes('registry "AGENCE DE TRADUCTION INTERPRETARIAT HASSIBI (ATIH) (ATIH)" (SIREN 810234849) ignored: the notice gives SIREN 180092298'), 'firm refused');
    ok(r.facts.awards === true && r.profile.budget_signals.contracts === 3 && r.profile.staff === '100-199 employees (registry, 2024)' && r.profile.size_hint === 'medium'
      && JSON.stringify(r.profile.contacts.addresses) === '["69329 LYON","IMMEUBLE LE TRIANGLE PART-DIEU 117 BOULEVARD MARIUS VIVIER-MERLE 69003 LYON"]', 'agency data');
    const only = await research(sb, researchAgent({}, [step('registry_search', { q: '180092298' }, REG_ATIH_AGENCY)]));
    ok(only.profile.siren === '180092298' && !only.profile.checks.some(c => /^registry/.test(c)), 'searched by SIREN');
    const p = await proposal(ragTender({ buyer: ATIH_TENDER.buyer, buyer_profile: { research_status: 'researched', enrichment_status: r.enrichment_status, ...r.profile } }));
    ok(p.buyer_profile.legal_name === r.profile.legal_name, 'proposal');
    return `sirens ${sb.notice_sirens}, places ${sb.notice_places}; ${r.profile.legal_name} ${r.profile.siren} (${r.profile.registry.reason}), ${r.profile.staff}, DECP ${r.profile.budget_signals.contracts}; by SIREN only ${only.profile.siren}; proposal "${p.buyer_profile.legal_name}"`;
  });
C(A3, 'Acronym-only identity without the notice\'s SIREN (real ATIH. rows)', 'the Select Buyers item the run researched (no SIREN, address "69329 LYON") with the same 3 registry rows; then the firm alone came back; then a notice giving nothing to check (no SIREN, address, place, e-mail); then no address but the notice e-mail domain atih.sante.fr and a search title there "ATIH : Agence technique de l\'information sur l\'hospitalisation"',
  'the firm (Paris 15) refused: department 69 of the notice, not 75 (check); the agency, whose initials "sur" breaks, is taken by its own "(ATIH)" confirmed by department 69; the firm alone: no identity at all (no legal name, SIREN, staff nor its Paris address); nothing to check: the firm is refused as a company, and the agency is not taken on its acronym alone; the e-mail domain\'s own site names the agency in full: taken', 'BU2', async ok => {
    const rows = [REG_ATIH_AGENCY, REG_ATIH_FIRM, REG_ATIH_ESI];
    const r = await research(ATIH_RUN3, atihAgent(rows));
    ok(r.profile.siren === '180092298' && r.profile.registry.reason === 'name similarity above threshold (its acronym ATIH, acronym confirmed by the notice\'s department 69)', 'agency by department');
    ok(r.profile.checks.includes('registry "AGENCE DE TRADUCTION INTERPRETARIAT HASSIBI (ATIH) (ATIH)" (SIREN 810234849) ignored: it shares only the acronym ATIH with "ATIH.", and the notice confirms it by no SIREN, department (69, not 75), town or website'), 'firm refused');
    const firm = await research(ATIH_RUN3, atihAgent([REG_ATIH_FIRM]));
    ok(firm.profile.legal_name === '' && firm.profile.siren === '' && !firm.facts.registry && firm.profile.staff === null && JSON.stringify(firm.profile.contacts.addresses) === '["69329 LYON"]'
      && /^no candidate confirmed \(1 seen, 1 refused/.test(firm.profile.registry.reason), 'firm alone: nothing');
    const bare = await research({ ...ATIH_RUN3, notice_contacts: { emails: [], phones: [], websites: [], addresses: [] } }, atihAgent(rows));
    ok(bare.profile.siren === '' && bare.profile.checks.some(c => /\(SIREN 810234849\) ignored: it shares only the acronym ATIH with "ATIH\.", and it is not a public body/.test(c)), 'nothing to check');
    const site = await research({ ...ATIH_RUN3, notice_contacts: { ...ATIH_RUN3.notice_contacts, addresses: [] } }, atihAgent([REG_ATIH_FIRM, REG_ATIH_AGENCY],
      [step('web_search', { query: 'ATIH site officiel' }, "WEB | https://www.atih.sante.fr/ | ATIH : Agence technique de l'information sur l'hospitalisation | Données hospitalières, nomenclatures et classifications")]));
    ok(site.profile.siren === '180092298' && /acronym confirmed by the notice's website atih\.sante\.fr\)$/.test(site.profile.registry.reason) && site.profile.official_website === 'https://atih.sante.fr', 'own site');
    return `by department: ${r.profile.siren}; firm alone: "${firm.profile.legal_name}" (${firm.profile.registry.reason}); nothing to check: "${bare.profile.legal_name}"; own site: ${site.profile.siren} (${site.profile.registry.reason.replace(/^.*confirmed by /, '')})`;
  });
const REG_MININT_ALL = [REG_MININT.replace('staff=51', 'staff=2000-4999'),
  "REG | SECRETARIAT GENERAL POUR L'ADMINISTRATION DU MINISTERE DE L'INTERIEUR NORD (SGAMI) | siren=130020316 | siret=13002031600159 | addr=CITE MARIANNE - BATIMENT D 2 BOULEVARD DE STRASBOURG 59000 LILLE | city=LILLE | nature=7179 | public=yes | staff=1000-1999 | staff_year=2024",
  "REG | SECRETARIAT GENERAL POUR L'ADMINISTRATION DU MINISTERE DE L'INTERIEUR SUD (SGAMI) | siren=130020357 | siret=13002035700013 | addr=299 CHEMIN DE SAINTE MARTHE 13014 MARSEILLE | city=MARSEILLE | nature=7179 | public=yes | staff=2000-4999 | staff_year=2024"].join('\n');
C(A3, 'Correct identities kept with the notice\'s SIREN and place (real run 2 / run 3 controls)', 'OPPIC as Map Records gives BOAMP 26-101489 (national_id 18009208200023, place 75) with its real research: Wikidata alias OPPIC Q3354607 (oppic.fr), registry "OPERATEUR DU PATRIMOINE ... (OPPIC)" (Paris) and "OBSERVATOIRE DES PUBLICS ... (OPPIC)" (Anduze, association); the same with the item the run researched (no SIREN, address nor place); City\'up (972) (place "Martinique", no SIREN), Ministère de l\'Intérieur (a place naming every department, no SIREN), the real RESAH research',
  'OPPIC: the operator 180092082 by the notice\'s SIREN, Q3354607 and https://oppic.fr kept; without anything to check, the operator is still the only public body seen under "(OPPIC)" (check "taken by its acronym only"); City\'up CITY\'UP (CFTU) 431938091 and cityup.mq, the Ministère MINISTERE DE L\'INTERIEUR 110014016, RESAH 130005010: unchanged', 'BU1, BU2', async ok => {
    const REG_OPPIC = ['REG | OPERATEUR DU PATRIMOINE ET DES PROJETS IMMOBILIERS DE LA CULTURE (OPPIC) | siren=180092082 | siret=18009208200049 | addr=19 AVENUE DU MAINE 75015 PARIS | city=PARIS | nature=7389 | public=yes | staff=100-199 | staff_year=2024',
      "REG | OBSERVATOIRE DES PUBLICS DES PROFESSIONNELS ET DES INSTITUTIONS DE LA CULTURE (OPPIC) | siren=500767801 | siret=50076780100011 | addr=5 RUE DE L'ARBOUSSET 30140 ANDUZE | city=ANDUZE | nature=9220 | public=no | staff=unknown | staff_year="].join('\n');
    const oppicAgent = researchAgent({ buyer_type: 'public_agency' }, [step('wikidata_lookup', { q: 'OPPIC' }, 'WD | Opérateur du patrimoine et des projets immobiliers de la culture |  | id=Q3354607 | match=alias:OPPIC | website=http://www.oppic.fr/\nWD | Nicolò Oppicelli | mycologue, journaliste | id=Q41951215 | match=alias:Oppicelli | website=https://www.nicolooppicelli.com'),
      step('registry_search', { q: 'OPPIC' }, REG_OPPIC)]);
    const [osb] = await run('Select Buyers', [{ tender_id: 'T112fsui', buyer_key: 'oppic', buyer_id: 'B43b2oi', survivor: true, too_late: false, days_left: 7, title: 'Prestations d’infogérance de l’ensemble des équipements informatiques de l’OPPIC',
      source: 'boamp', source_url: 'https://www.boamp.fr/pages/avis/?q=idweb:26-101489', external_id: '26-101489', language: 'fr', place: '75', analysis: { fit: 'high' },
      buyer: { name: 'OPPIC', country: 'FR', national_id: '18009208200023', contacts: { email: null, phone: null, website: null, address: null } } }]);
    const [oppic, old] = await Promise.all([osb, buyer({ buyer_key: 'oppic', buyer_id: 'B43b2oi', name: 'OPPIC', search_name: 'OPPIC' })].map(b => research(b, oppicAgent)));
    for (const [k, o] of [['notice SIREN', oppic], ['nothing to check', old]]) ok(o.profile.siren === '180092082' && o.profile.wikidata_id === 'Q3354607' && o.profile.official_website === 'https://oppic.fr' && o.profile.buyer_type === 'public_agency', k);
    ok(JSON.stringify(osb.notice_sirens) === '["180092082"]' && oppic.profile.registry.reason === 'SIREN given by the notice (180092082)' && !oppic.profile.checks.some(c => /acronym/.test(c)), 'OPPIC by SIREN');
    ok(old.profile.checks.includes('registry "OPERATEUR DU PATRIMOINE ET DES PROJETS IMMOBILIERS DE LA CULTURE (OPPIC)" taken by its acronym only: the notice gives no SIREN, address or website to confirm it'), 'OPPIC check');
    const c = await research({ ...CITYUP, notice_sirens: [], notice_places: ['Martinique'] }, cityupR2(CITYUP_STEPS));
    const placeAll = '(67) Bas-Rhin, (68) Haut-Rhin, (24) Dordogne, (33) Gironde, (40) Landes, (47) Lot-et-Garonne, (64) Pyrénées-Atlantiques,';
    const m = await research({ ...MININT, notice_sirens: [], notice_places: [placeAll] }, researchAgent({ buyer_type: 'state_administration' }, [step('registry_search', { q: "Ministère de l'Intérieur" }, REG_MININT_ALL)]));
    const x = REAL.research.find(q => q.buyer.name === 'RESAH'), resah = await research(x.buyer, x.agent);
    ok(c.profile.legal_name === "CITY'UP (CFTU)" && c.profile.siren === '431938091' && c.profile.official_website === 'https://cityup.mq', 'City\'up');
    ok(m.profile.legal_name === "MINISTERE DE L'INTERIEUR" && m.profile.siren === '110014016' && resah.profile.siren === '130005010' && resah.profile.wikidata_id === 'Q104481023', 'Ministère, RESAH');
    return `OPPIC ${oppic.profile.siren} ${oppic.profile.wikidata_id} ${oppic.profile.official_website} / item of the run: ${old.profile.siren}; City'up ${c.profile.siren}; Ministère ${m.profile.siren}; RESAH ${resah.profile.siren}`;
  });
C(A3, 'The notice\'s SIREN against a registry / Wikidata identity named like the buyer (real Ministère rows)', "Ministère de l'Intérieur's real registry rows (MINISTERE DE L'INTERIEUR 110014016, SGAMI Nord 130020316, SGAMI Sud 130020357) for a notice giving SGAMI Sud's SIRET (notice_sirens 130020357), with a Wikidata stub Q900000001 (country FR, siren=110014016); then a notice SIREN no row carries (130020365) that no registry_search used",
  'SGAMI Sud is the buyer (by the notice\'s SIREN, its name aside); the ministry and the Wikidata entity with SIREN 110014016 are refused (checks); with the unknown SIREN no registry identity (no legal name, check "registry not searched with the notice\'s SIREN 130020365")', 'BU2', async ok => {
    const wdStub = "WD | ministère de l'Intérieur | ministère français | id=Q900000001 | match=label:ministère de l'Intérieur | country=FR | siren=110014016";
    const agent = researchAgent({ buyer_type: 'state_administration' }, [step('wikidata_lookup', { q: "Ministère de l'Intérieur" }, wdStub), step('registry_search', { q: "Ministère de l'Intérieur" }, REG_MININT_ALL)]);
    const sud = await research({ ...MININT, notice_sirens: ['130020357'] }, agent), none = await research({ ...MININT, notice_sirens: ['130020365'] }, agent);
    ok(sud.profile.siren === '130020357' && /SUD \(SGAMI\)$/.test(sud.profile.legal_name) && sud.profile.wikidata_id === null, 'SGAMI Sud');
    ok(sud.profile.checks.includes('registry "MINISTERE DE L\'INTERIEUR" (SIREN 110014016) ignored: the notice gives SIREN 130020357') && sud.profile.checks.includes('Wikidata Q900000001 "ministère de l\'Intérieur" ignored: SIREN 110014016, not the notice\'s 130020357'), 'checks');
    ok(none.profile.legal_name === '' && none.profile.siren === '' && none.profile.checks.includes('registry not searched with the notice\'s SIREN 130020365'), 'unknown SIREN');
    return `${sud.profile.legal_name} (${sud.profile.registry.reason}); unknown SIREN: "${none.profile.legal_name}" (${none.profile.registry.reason})`;
  });
C(A3, 'Notice department from a postal code, never a CS box number (real MEL address)', 'buyer "MEL" with the real address of the Métropole européenne de Lille\'s notice "2 boulevard des Cités Unies - CS 70043 59040 Lille" (no SIREN); registry rows (written for the case): "MEL (MAISON DE L\'EMPLOI DE LA HAUTE-SAONE)" in 70000 VESOUL, a public body named exactly MEL, then "METROPOLE EUROPEENNE DE LILLE (MEL)" 200093201 in 59000 LILLE',
  'notice department 59 (59040), not 70 (CS 70043): the Vesoul body refused (59, not 70), the métropole taken, confirmed by department 59', 'BU2', async ok => {
    const r = await research(buyer({ buyer_key: 'mel', name: 'MEL', search_name: 'MEL', notice_contacts: { emails: [], phones: [], websites: [], addresses: ['2 boulevard des Cités Unies - CS 70043 59040 Lille'] } }),
      researchAgent({ buyer_type: 'local_authority' }, [step('registry_search', { q: 'MEL' }, ["REG | MEL (MAISON DE L'EMPLOI DE LA HAUTE-SAONE) | siren=199999999 | siret=19999999900019 | addr=1 RUE DE LA GARE 70000 VESOUL | city=VESOUL | nature=7470 | public=yes | staff=unknown | staff_year=",
        'REG | METROPOLE EUROPEENNE DE LILLE (MEL) | siren=200093201 | siret=20009320100081 | addr=2 BOULEVARD DES CITES UNIES 59000 LILLE | city=LILLE | nature=7344 | public=yes | staff=unknown | staff_year='].join('\n'))]));
    ok(r.profile.siren === '200093201' && /acronym confirmed by the notice's department 59\)$/.test(r.profile.registry.reason), 'métropole');
    ok(r.profile.checks.some(c => /^registry "MEL \(MAISON DE L'EMPLOI DE LA HAUTE-SAONE\)" \(SIREN 199999999\) ignored: .*department \(59, not 70\)/.test(c)), 'Vesoul refused');
    return `${r.profile.legal_name} (${r.profile.registry.reason})`;
  });

// ======================= proposal studio hand-off (Adapt for Studio, Send to Proposal Service, Start Deck, Run Summary) =======================
// the 10 real proposal inputs of run 3 (2026-10-20, RAG v2 with demo records in its knowledge base), as Build Proposal Input gave them
const RUN3_FILE = path.join(__dirname, 'out', 'execution_ragv2_run3_nodes', 'Build_Proposal_Input.json');
let run3Cache = null;
const RUN3 = () => clone(run3Cache || (run3Cache = Object.values(JSON.parse(fs.readFileSync(RUN3_FILE, 'utf8'))[0].items[0]).map(i => i.json || i)));
const adapt = (inputs, cfg = CFG) => run('Adapt for Studio', inputs, { '00 - Config': [cfg] });
const pick = (out, id) => out.find(x => x.tender_id === id);
const demoA = a => a.demo === true || a.origin === 'demo';
const cvIds = x => x.rag.assets.filter(a => a.asset_type === 'cv').map(a => a.asset_id).sort();
// an n8n expression of a built node, with $json and a stubbed $: "={{ ... }}" gives its value, a template ("={{ ... }}/api/...") its text
const evalExpr = (s, $json, $) => { const fn = e => new Function('$json', '$', `return (${e});`)($json, $), m = /^=\{\{([\s\S]*)\}\}$/.exec(s);
  return m ? fn(m[1]) : String(s).replace(/^=/, '').replace(/\{\{([\s\S]*?)\}\}/g, (_, e) => String(fn(e))); };
const nodeOf = name => wf.nodes.find(n => n.name === name);
const stub$ = adapted => n => (n === '00 - Config' ? { first: () => ({ json: CFG }) } : n === 'Adapt for Studio' ? { item: { json: adapted } } : (() => { throw new Error(`no ${n}`); })());
// the studio's error answers as n8n's HTTP Request node gives them with On Error: continue (shape of the recorded Firecrawl 429 item)
const studioError = (code, message) => ({ error: { message: `Request failed with status code ${code}`, name: 'AxiosError', code: 'ERR_BAD_REQUEST', status: code },
  details: { message: 'The service was not able to process your request', httpCode: String(code), body: { status: 'error', message } } });

C(A4, 'Studio copy: demo records and weak proofs left out (real run 3)', 'the 10 real proposal inputs of run 3: demo_Project_* / demo_TechStack_* records proving rows of T1w50xyr, T1xiyyfm, T1vv1c9s and T1wp05cp (the studio made them "Références pertinentes"), T1ytbl1u with 6 CVs of which 5 only weak neighbours (proves false, weak_for only: 6 "Ingénieurs spécialisés")',
  'Adapt for Studio sends no demo or non-proving evidence and no demo or weak-only asset (counted in studio_adapter.dropped); T1ytbl1u keeps CV_10 only (it proves R2); suggested_assets only name what is left; the rows keep their coverage; T1vll2ea (no demo, no weak) is unchanged but for the adapter\'s own fields', 'Adapt for Studio', async ok => {
    const ins = RUN3(), out = await adapt(ins);
    ok(out.length === 10 && out.every((x, k) => x.tender_id === ins[k].tender_id), 'one copy per input, same order');
    ok(out.every(x => x.matrix.rows.every(r => r.evidence.every(e => !demoA(e) && e.proves !== false))), 'no demo / weak evidence');
    ok(out.every(x => x.rag.assets.every(a => !demoA(a) && (a.asset_type === 'certification' || a.for.length))), 'no demo / weak-only asset');
    for (const id of ['T1w50xyr', 'T1xiyyfm', 'T1vv1c9s', 'T1wp05cp']) { const x = pick(out, id); ok(!x.rag.assets.some(a => /^demo_/.test(a.asset_id)) && x.studio_adapter.dropped.demo_assets > 0, `${id} demo assets dropped`); }
    const y = pick(out, 'T1ytbl1u');
    ok(JSON.stringify(cvIds(y)) === '["CV_10_Daniel_Kim.pdf"]' && y.studio_adapter.dropped.weak_assets === 5 && y.studio_adapter.dropped.weak_evidence === 6, 'T1ytbl1u: CV_10 only');
    ok(out.every(x => Object.values(x.rag.suggested_assets).flat().every(id => x.rag.assets.some(a => a.asset_id === id))), 'suggested assets left');
    ok(out.every((x, k) => x.matrix.rows.every((r, j) => r.coverage === ins[k].matrix.rows[j].coverage && r.coverage_score === ins[k].matrix.rows[j].coverage_score)), 'coverage kept');
    const v = pick(out, 'T1vll2ea'), v0 = pick(ins, 'T1vll2ea'), strip = x => { const c = clone(x); delete c.studio_adapter; c.options.template_id = null; return JSON.stringify(c); };
    ok(strip(v) === strip(v0) && !Object.values(v.studio_adapter.dropped).some(Boolean), 'T1vll2ea unchanged');
    return out.map(x => `${x.tender_id} -${Object.entries(x.studio_adapter.dropped).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', -') || '0'}`).join('; ');
  });
C(A4, 'Studio copy: the proposed team and its certifications (real run 3)', 'T1w50xyr: 11 CVs prove rows, team_proposal = Isabella Ross (CV_13, data engineer, Azure Data Engineer), Henry Price (CV_14, delivery manager / project manager, AWS Certified, AWS Solutions Architect, Scrum Master (PSM/CSM)), Leila Morgan (CV_18); T1wp05cp: 1 member (Julian Hayes CV_17, PMP, TOGAF) of 6 CVs; variant of T1xiyyfm: a member whose CV proves no row (CV_99) and a demo member; control: T1ytbl1u without team_proposal',
  'only the members\' CVs are sent (the studio counts every CV as an engineer: 11 -> 3, 6 -> 1), each with metadata.role = its roles; one certification asset per certification (cert_<slug>, with its holders), the only place the studio reads them; a member without a proving CV is added as a team CV, a demo member never; no team_proposal: the proving CVs stay', 'Adapt for Studio', async ok => {
    const ins = RUN3(), out = await adapt(ins), w = pick(out, 'T1w50xyr'), p = pick(out, 'T1wp05cp');
    ok(JSON.stringify(cvIds(w)) === '["CV_13_Isabella_Ross.pdf","CV_14_Henry_Price.pdf","CV_18_Leila_Morgan.pdf"]' && w.studio_adapter.dropped.cvs_not_in_team === 8, 'T1w50xyr: the 3 members');
    const henry = w.rag.assets.find(a => a.asset_id === 'CV_14_Henry_Price.pdf'), ev = w.matrix.rows.flatMap(r => r.evidence).filter(e => e.asset_id === 'CV_14_Henry_Price.pdf');
    ok(henry.metadata.role === 'delivery manager, project manager' && ev.length && ev.every(e => e.metadata.role === henry.metadata.role), 'role on asset and evidence');
    const certs = w.rag.assets.filter(a => a.asset_type === 'certification');
    ok(JSON.stringify(certs.map(c => c.asset_id)) === '["cert_azure_data_engineer","cert_aws_certified","cert_aws_solutions_architect","cert_scrum_master_psm_csm"]'
      && certs[3].title === 'Scrum Master (PSM/CSM)' && certs[3].holders.join() === 'Henry Price' && w.studio_adapter.added.certifications === 4, 'certification assets');
    ok(JSON.stringify(cvIds(p)) === '["CV_17_Julian_Hayes.pdf"]' && p.rag.assets.filter(a => a.asset_type === 'certification').map(a => a.title).join() === 'PMP,TOGAF', 'T1wp05cp');
    const x0 = pick(ins, 'T1xiyyfm');
    x0.rag.team_proposal.members.push({ name: 'New Dev', asset_id: 'CV_99_New_Dev.pdf', title: 'New Dev - Backend Developer', roles: ['backend developer'], certifications: [], assigned_to: [{ requirement_id: 'R5', requirement: 'Minimum 5 senior developers' }] },
      { name: 'Demo Person', asset_id: 'demo_CV_Fictional', title: 'Fictional', roles: ['pm'], certifications: ['Fake Cert'], assigned_to: [] });
    const [x] = await adapt([x0]), added = x.rag.assets.find(a => a.asset_id === 'CV_99_New_Dev.pdf');
    ok(added && added.metadata.role === 'backend developer' && added.for.join() === 'R5' && x.studio_adapter.added.team_cvs === 1, 'member without a proving CV added');
    ok(!x.rag.assets.some(a => /demo_CV|fake_cert/i.test(a.asset_id)), 'demo member never');
    ok(JSON.stringify(cvIds(pick(out, 'T1ytbl1u'))) === '["CV_10_Daniel_Kim.pdf"]', 'no team_proposal: the proving CV');
    return `T1w50xyr CVs ${cvIds(w).length} (-${w.studio_adapter.dropped.cvs_not_in_team}), certs ${certs.map(c => c.title).join(' / ')}; T1wp05cp ${cvIds(p)}; variant +${x.studio_adapter.added.team_cvs} team CV`;
  });
C(A4, 'Studio copy: "why us" lines (real run 3)', 'covered rows whose justification is a demo record (T1w50xyr R6, T1xiyyfm R1, T1wp05cp R9), a weak proof (T1vv1c9s R3 "users by 35 % within six months.") or a CV skills line ("% Programming: Apex, LWC, JavaScript, …", "Containerization: Docker, Kubernetes, Helm", "Databases: MySQL, phpMyAdmin, PostgreSQL"); controls: OliveSoft\'s declaration (T1vll2ea R1), "Certified Scrum Master (CSM) – Scrum Alliance, 2022", CV sentences',
  'those justifications are cleared (the studio turns every covered justification into a "Nos atouts" bullet; counted demo / weak / header), the rows keep their coverage and evidence; the declaration and the real CV sentences stay', 'Adapt for Studio', async ok => {
    const out = await adapt(RUN3()), row = (id, r) => pick(out, id).matrix.rows.find(x => x.requirement_id === r);
    ok(['T1w50xyr R6', 'T1xiyyfm R1', 'T1xiyyfm R7', 'T1wp05cp R9', 'T1vv1c9s R2', 'T1vv1c9s R3'].every(s => row(...s.split(' ')).justification === null), 'demo / weak cleared');
    ok(['T1xiyyfm R2', 'T1xiyyfm R3', 'T1vv1c9s R1', 'T1wp05cp R3'].every(s => row(...s.split(' ')).justification === null && row(...s.split(' ')).coverage === 'covered'), 'skills lines cleared, row covered');
    ok(/^Deployed an AI agent/.test(row('T1vll2ea', 'R1').justification) && row('T1xiyyfm', 'R6').justification === 'Certified Scrum Master (CSM) – Scrum Alliance, 2022'
      && /^Provisioned Google Cloud/.test(row('T1xiyyfm', 'R4').justification) && /^Developed a responsive web portal/.test(row('T1wp05cp', 'R1').justification), 'declaration and sentences kept');
    const d = pick(out, 'T1xiyyfm').studio_adapter.dropped;
    ok(d.demo_justifications === 2 && d.header_justifications === 2, 'counted');
    return `T1xiyyfm: ${d.demo_justifications} demo + ${d.header_justifications} header cleared; kept "${row('T1xiyyfm', 'R6').justification}"`;
  });
C(A4, 'Studio copy: budget, template, language, unknown coverage', 'real Tdoatt8 (budget 2.8 bn, confidence very low, 1 comparable) and T1ytbl1u (49 250, very low); variants of T1vll2ea: an OK study with 5 comparables (low), one with 2, a NO_COMPARABLE study with an estimate; template "olivesoft_default" (all run-3 inputs); language "ar", null, "fr"; a tender whose RAG call failed (every row coverage unknown, score null)',
  'budget_estimate null unless the study is OK with 3+ comparables above "very low" (the studio builds 3 budget scenarios from any estimate), with a note; template_id null (the studio\'s default; "olivesoft_default" does not exist there); language fr / en only (ar -> en, language_original kept; no language stays unset: the studio uses its default); unknown rows get coverage_score 0 ("À préciser"), never null (keyword guesses for the whole deck)', 'Adapt for Studio, RG2, PR1', async ok => {
    const ins = RUN3(), out = await adapt(ins), dd = pick(out, 'Tdoatt8'), y = pick(out, 'T1ytbl1u');
    ok(dd.competition.budget_estimate === null && dd.studio_adapter.dropped.budget_estimate === 1 && dd.studio_adapter.notes.includes('budget estimate left out: confidence very low'), 'Tdoatt8');
    ok(y.competition.budget_estimate === null && pick(ins, 'Tdoatt8').competition.budget_estimate.mid === 2822000000, 'T1ytbl1u, original kept');
    const v = pick(ins, 'T1vll2ea'), est = (comparables, confidence) => ({ low: 30000, mid: 50000, high: 80000, min: 20000, max: 90000, currency: 'EUR', confidence, comparables, spread: 2.7, outliers: [], basis: 'test' });
    const [ok5, two, noc] = await adapt([{ ...v, competition: { status: 'OK', budget_estimate: est(5, 'low') } }, { ...v, competition: { status: 'OK', budget_estimate: est(2, 'low') } },
      { ...v, competition: { status: 'NO_COMPARABLE', budget_estimate: est(5, 'low') } }]);
    ok(ok5.competition.budget_estimate.mid === 50000 && two.competition.budget_estimate === null && two.studio_adapter.notes[0] === 'budget estimate left out: 2 comparable contract(s)'
      && noc.competition.budget_estimate === null && /market study NO_COMPARABLE/.test(noc.studio_adapter.notes[0]), 'variants');
    ok(out.every(x => x.options.template_id === null && x.studio_adapter.notes.includes('template_id "olivesoft_default" replaced by the studio\'s default')) && ins[0].options.template_id === 'olivesoft_default', 'template');
    const [ar, nul, fr] = await adapt([{ ...v, language: 'ar' }, { ...v, language: null }, v]);
    ok(ar.language === 'en' && ar.language_original === 'ar' && nul.language === null && !('language_original' in nul) && fr.language === 'fr' && !('language_original' in fr), 'language');
    const r = await joinRag(ragTender(), { error: { message: 'connect ECONNREFUSED 127.0.0.1:8001' } }), [u] = await adapt([await proposal(r)]);
    ok(u.matrix.rows.length === 4 && u.matrix.rows.every(x => x.coverage === 'unknown' && x.coverage_score === 0) && u.studio_adapter.coverage_unknown_to_zero === 4, 'unknown -> 0');
    return `Tdoatt8 / T1ytbl1u budget dropped; 5 comparables kept, 2 dropped, NO_COMPARABLE dropped; template null; ar -> ${ar.language}; unknown rows score ${u.matrix.rows[0].coverage_score}`;
  });
C(A5, 'Two priced comparables far apart (real Tdoatt8 market study)', 'the agent\'s real choice for "RFI - SYSTEME DE VIDEOPROTECTION ET DE CAMERAS AEROPORTEES" (no CPV): 2 priced contracts, 2 822 000 000 (CANUT) and 206 619 (Ville de Falaise), plus 3 framework ceilings; control: a third priced contract of 250 000',
  'with 2 priced contracts there is no outlier (their "median" is their midpoint, so the smaller one was always dropped and the budget was 2.8 bn): both kept, confidence very low (spread); the studio copy then carries no budget; with 3 the 2.8 bn contract is the outlier (median 250 000)', 'MK2, PR1, Adapt for Studio', async ok => {
    const task = marketTask({ title: 'RFI - SYSTEME DE VIDEOPROTECTION ET DE CAMERAS AEROPORTEES', buyer: "Ministère de l'Intérieur", buyer_official_name: "MINISTERE DE L'INTERIEUR", buyer_siren: '110014016', cpv: [], tender_type: 'ai_data',
      summary: "La consultation est un appel à compétences relatif à l'expérimentation à des fins de sécurité, de traitement algorithmiques comportant un système d'intelligence artificielle permettant l'analyse d'images issues de systèmes de vidéoprotection et de camera aéroportées",
      requirements: ["Le système doit permettre l'analyse d'images issues de systèmes de vidéoprotection et de caméras aéroportées"] });
    const rows = [award('T648561-2026', { amount: 2822000000, src: 'TED', buyer: 'CANUT', winners: 'E-CONEX;TPF INGENIERIE;ERYMA SAS', cpv: '32323500,32333200,35125300', date: '2026-09-21', title: 'FOURNITURE, INSTALLATION, MAINTENANCE ET PRESTATIONS DE CONSEIL AUTOUR DES SYSTEMES DE VIDEOPROTECTION' }),
      award('T667197-2026', { amount: 1000000, fw: 'yes', src: 'TED', buyer: 'CENOVIA', winners: 'INTEGRAL EXPERT SURETE', cpv: '32323500', date: '2026-09-28', title: 'ACCORD-CADRE MULTI-ATTRIBUTAIRES DE FOURNITURES DE SYSTEMES DE VIDEOPROTECTION' }),
      award('T555454-2026', { amount: 2400000, fw: 'yes', src: 'TED', buyer: 'Ville de Vénissieux', winners: 'SERFIM T.I.C', cpv: '32323500', date: '2026-08-11', title: 'FOURNITURE, INSTALLATION, MISE EN SERVICE ET MAINTENANCE DU SYSTÈME DE VIDÉOPROTECTION' }),
      award('T527735-2026', { amount: 206619, src: 'TED', buyer: 'Ville de Falaise', winners: 'EIFFAGE ENERGIE SYSTEMES - NORMANDIE', cpv: '32323500,50324100,32562200', date: '2026-07-30', title: "Extension et maintenance d'un système de vidéoprotection sur la Ville de Falaise" }),
      award('T699509-2026', { amount: 16000000, fw: 'yes', src: 'TED', buyer: "Ministère de l'Intérieur", winners: 'DERICHEBOURG ENERGIE;ATALIAN PROPRETE', cpv: '79993000', date: '2026-10-09', title: "Prestations multiservices et multitechniques pour le site de l'administration centrale" })];
    const ids = rows.map(r => r.split(' | ')[1]);
    const t = await market(marketAgent({ comparable_ids: ids }, [similar(rows)]), task), b = t.market.budget;
    ok(b.comparables === 2 && b.min === 206619 && b.max === 2822000000 && !b.outliers.length && b.confidence === 'very low' && !/outlier/.test(b.basis), 'both kept');
    const [s] = await adapt([await proposal(ragTender({ market: t.market }))]);
    ok(s.competition.budget_estimate === null && s.studio_adapter.notes.includes('budget estimate left out: confidence very low'), 'no budget for the studio');
    const third = award('D3x', { amount: 250000, winners: 'CITEOS', title: 'Maintenance du système de vidéoprotection urbaine', date: '2026-06-01' });
    const c = (await market(marketAgent({ comparable_ids: [...ids, 'D3x'] }, [similar([...rows, third])]), task)).market.budget;
    ok(c.comparables === 2 && c.median === 228310 && c.outliers.map(o => o.id).join() === 'T648561-2026', 'control: 3 priced');
    return `2 priced: ${b.min}-${b.max} (${b.confidence}), outliers ${b.outliers.length}; 3 priced: outlier ${c.outliers.map(o => o.id)}, range ${c.min}-${c.max}`;
  });
C(A6, 'Hand-off to the proposal studio: Config and wiring', 'the built workflow and Config: proposal block, Build Proposal Input -> Adapt for Studio -> Send to Proposal Service -> Start Deck? -> Start Deck',
  'proposal.url = studioUrl + /api/tenders (http://host.docker.internal:8091), autoDeck top1, template_id null, maxTenders 10; Send and Start Deck enabled, On Error: continue, timeout 15 s, credential "Proposal Studio key" (StudioKey0000001, header auth); Start Deck posts {tenderId: the id the studio returned, params {language auto, project_type}} to studioUrl/api/generations, no templateId; the branch is drawn above Run Summary (runs before it)', 'build, Config', async ok => {
    const p = CFG.proposal;
    ok(p.studioUrl === 'http://host.docker.internal:8091' && p.url === 'http://host.docker.internal:8091/api/tenders' && p.autoDeck === 'top1' && p.options.template_id === null && p.maxTenders === 10, 'Config');
    const next = n => ((wf.connections[n] || {}).main || [[]])[0].map(c => c.node).join();
    ok(next('Build Proposal Input') === 'Adapt for Studio' && next('Adapt for Studio') === 'Send to Proposal Service' && next('Send to Proposal Service') === 'Start Deck?' && next('Start Deck?') === 'Start Deck', 'chain');
    for (const n of ['Send to Proposal Service', 'Start Deck']) { const x = nodeOf(n);
      ok(!x.disabled && x.onError === 'continueRegularOutput' && x.parameters.options.timeout === 15000 && x.parameters.genericAuthType === 'httpHeaderAuth'
        && x.credentials.httpHeaderAuth.id === 'StudioKey0000001' && x.credentials.httpHeaderAuth.name === 'Proposal Studio key', `${n} settings`); }
    const [a] = await adapt([RUN3()[0]]), $ = stub$(a), send = nodeOf('Send to Proposal Service').parameters, deck = nodeOf('Start Deck').parameters;
    ok(evalExpr(send.url, a, $) === p.url && JSON.parse(evalExpr(send.jsonBody, a, $)).tender_id === 'T1vll2ea', 'send: the adapted item to the inbox');
    const body = JSON.parse(evalExpr(deck.jsonBody, { status: 'ok', id: 'T1vll2ea' }, $));
    ok(evalExpr(deck.url, {}, $) === 'http://host.docker.internal:8091/api/generations' && JSON.stringify(body) === '{"tenderId":"T1vll2ea","params":{"language":"auto","project_type":"software"}}', 'deck body');
    const pos = n => nodeOf(n).position;
    ok(pos('Build Proposal Input')[1] < pos('Run Summary')[1] && ['Adapt for Studio', 'Send to Proposal Service', 'Start Deck?', 'Start Deck'].every(n => pos(n)[1] === pos('Build Proposal Input')[1]), 'drawn above Run Summary');
    return `${p.url}, autoDeck ${p.autoDeck}; Start Deck ${evalExpr(deck.url, {}, $)} ${JSON.stringify(body)}`;
  });
C(A6, 'Start Deck: only the rank-1 tender, once the studio stored it', 'the 10 real proposal inputs of run 3 (rank 1 = T1vll2ea, ai_data); the Send answers {status: "ok", id}, an HTTP 401 error item, the proposal input itself (Send disabled: n8n passes it through); Config autoDeck top1 / none; tender types software_build, ai_data, integration_saas, consulting',
  'auto_deck only on the rank-1 copy (top1), on none with none; "Start Deck?" is true only for the rank-1 tender with a successful send; project_type software (software_build, ai_data), saas (integration_saas), other (the rest)', 'Adapt for Studio, Start Deck?', async ok => {
    const ins = RUN3(), out = await adapt(ins), none = await adapt(ins, { ...CFG, proposal: { ...CFG.proposal, autoDeck: 'none' } });
    ok(out.filter(x => x.studio_adapter.auto_deck).map(x => x.tender_id).join() === 'T1vll2ea' && !none.some(x => x.studio_adapter.auto_deck), 'auto_deck');
    const cond = nodeOf('Start Deck?').parameters.conditions.conditions[0].leftValue, top = out[0], second = out[1];
    const go = (answer, item) => evalExpr(cond, answer, stub$(item)) === true;
    ok(go({ status: 'ok', id: 'T1vll2ea' }, top), 'rank 1 stored: start');
    ok(!go(studioError(401, 'Unauthorized: invalid or missing API key'), top) && !go(top, top) && !go({ status: 'ok', id: 'T1w50xyr' }, second) && !go({ status: 'ok', id: 'T1vll2ea' }, none[0]), 'no start otherwise');
    const types = await adapt(['software_build', 'ai_data', 'integration_saas', 'consulting'].map(tt => ({ ...ins[1], analysis: { ...ins[1].analysis, tender_type: tt } })));
    ok(types.map(x => x.studio_adapter.deck_params.project_type).join() === 'software,software,saas,other' && types.every(x => x.studio_adapter.deck_params.language === 'auto'), 'project_type');
    return `auto_deck ${out.filter(x => x.studio_adapter.auto_deck).map(x => x.tender_id)}; project types ${types.map(x => x.studio_adapter.deck_params.project_type).join(' ')}`;
  });
C(A6, 'Run Summary: the proposal studio line', '3 real proposal inputs of run 3 (rank 1 "Prestations de développement d\'agents LLM et services associés"): all stored and Start Deck answers 202 {runId}; the rank-1 send fails HTTP 401; Start Deck answers 409 (another deck running) / 503 (not configured); autoDeck none; Send disabled (pass-through); no proposal input',
  '"Proposal inputs: N sent to the studio (M failed: …)" and "deck started for <title> (run …)" or why not: the 401 counted (Proposal service, WARNINGS), the 409 only told (no failed call), the 503 a failed call (Deck start); "N not sent (Send to Proposal Service is disabled)"; no line without proposal input', 'EX2', async ok => {
    const ins = RUN3().slice(0, 3), ad = await adapt(ins), stored = ins.map(x => ({ status: 'ok', id: x.tender_id }));
    const sum = (sends, decks, cfg = CFG) => run('Run Summary', [{}], { '00 - Config': [{ ...cfg, sources: [] }], 'Build Proposal Input': ins, 'Adapt for Studio': ad,
      ...(sends ? { 'Send to Proposal Service': sends } : {}), ...(decks ? { 'Start Deck': decks } : {}) }).then(r => r[0]);
    const line = s => s.message.split('\n').find(l => l.startsWith('Proposal inputs:')) || '';
    const title = '"Prestations de développement d\'agents LLM et services associés"';
    const a = await sum(stored, [{ status: 'ok', runId: '0a1b2c3d4e5f' }]);
    ok(line(a) === `Proposal inputs: 3 sent to the studio | deck started for ${title} (run 0a1b2c3d4e5f)` && a.studio.deck.started && !a.has_warnings && a.failed_calls['Deck start'] === 0, 'started');
    const b = await sum([studioError(401, 'Unauthorized: invalid or missing API key'), ...stored.slice(1)]);
    ok(line(b) === `Proposal inputs: 2 sent to the studio (1 failed: HTTP 401: Unauthorized: invalid or missing API key) | no deck started: the rank-1 tender ${title} is not in the studio (HTTP 401: Unauthorized: invalid or missing API key)`
      && b.failed_calls['Proposal service'] === 1 && b.has_warnings, '401');
    const c = await sum(stored, [studioError(409, "Une génération est déjà en cours. Attendez sa fin avant d'en lancer une autre.")]);
    ok(line(c).endsWith(`no deck started: Start Deck for ${title}: another deck is being generated (the studio makes one at a time): start it from the interface once it is done`)
      && c.failed_calls['Deck start'] === 0 && !c.has_warnings && c.studio.deck.http === 409, '409 told, not failed');
    const d = await sum(stored, [{ error: { message: '503 - "{\\"status\\": \\"error\\", \\"message\\": \\"Génération non configurée (GENERATE_WEBHOOK_URL manquant)\\"}"' } }]);
    ok(/deck generation is not configured in the studio/.test(line(d)) && d.failed_calls['Deck start'] === 1 && d.has_warnings, '503 failed');
    const e = await sum(stored, null, { ...CFG, proposal: { ...CFG.proposal, autoDeck: 'none' } });
    ok(line(e) === "Proposal inputs: 3 sent to the studio | no deck started: proposal.autoDeck is 'none': decks are started from the interface", 'autoDeck none');
    const f = await sum(ad);
    ok(line(f) === `Proposal inputs: 0 sent to the studio, 3 not sent (Send to Proposal Service is disabled) | no deck started: the rank-1 tender ${title} is not in the studio (Send to Proposal Service is disabled)` && f.failed_calls['Proposal service'] === 0, 'disabled');
    const g = (await run('Run Summary', [{}], { '00 - Config': [{ ...CFG, sources: [] }] }))[0];
    ok(!line(g) && g.studio.deck.reason === 'no proposal input' && g.failed_calls['Deck start'] === null, 'nothing to send');
    return [a, b, c].map(line).join(' || ');
  });

// ---- run
(async () => {
  const cfg = await run('00 - Config', [{}], s => s.replace('const FORCE_PRESET = null;', "const FORCE_PRESET = 'test';"));
  CFG = cfg[0]; CFG.today = TODAY; CFG.runId = 'edge-cases';
  // the saved-page sources of test/e2e.js (the real recorded cases come from them)
  CFG.sources.push({ type: 'url', name: 'fixture-fr', country: 'FR', language: 'fr', url: 'https://fixture.test/', maxPages: 2 },
    { type: 'url', name: 'fixture-ar', country: 'TN', language: 'ar', url: 'https://fixture.test/ar/tenders', maxPages: 1 },
    { type: 'url', name: 'fixture-en', country: 'TN', language: 'en', url: 'https://fixture.test/en/notice/ai-chatbot' });
  const results = [];
  for (const c of cases) {
    const failed = []; let got = '', error = null;
    try { got = await c.fn((cond, label) => { if (!cond) failed.push(label); }); } catch (e) { error = e; }
    const pass = !error && !failed.length;
    const status = pass ? (c.gap ? 'FIXED?' : 'PASS') : c.gap ? 'KNOWN GAP' : 'FAIL';
    results.push({ ...c, status, got: error ? `ERROR ${error.message}` : got, failed });
  }
  // grouped by area in the order each area first appears (a stable sort: the cases of an area keep their order), so each
  // "== area" header prints once and the --md table is grouped too
  const areas = [...new Set(results.map(r => r.area))];
  results.sort((a, b) => areas.indexOf(a.area) - areas.indexOf(b.area));
  let area = '';
  for (const r of results) {
    if (r.area !== area) { area = r.area; console.log(`\n== ${area}`); }
    console.log(`${r.status.padEnd(9)} ${r.name}\n          ${r.got}${r.failed.length ? `\n          failed: ${r.failed.join('; ')}` : ''}${r.status === 'FIXED?' ? '\n          now passes: remove its `gap` and update EDGE_CASES.md' : ''}`);
    if (r.status === 'FAIL' && r.got.startsWith('ERROR')) console.log(r.got);
  }
  const n = s => results.filter(r => r.status === s).length;
  console.log(`\n${results.length} cases: ${n('PASS')} passed, ${n('KNOWN GAP')} known gaps, ${n('FAIL')} failed${n('FIXED?') ? `, ${n('FIXED?')} known gap(s) now passing` : ''}`);
  if (process.argv.includes('--md')) {
    const md = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
    console.log('\n| # | area | case | input | expected handling | node | result |\n|---|---|---|---|---|---|---|');
    results.forEach((r, i) => console.log(`| ${i + 1} | ${md(r.area)} | ${md(r.name)} | ${md(r.input)} | ${md(r.expected)} | ${md(r.node)} | ${r.status === 'PASS' ? 'PASS' : `**${r.status}**`}: ${md(r.got)} |`));
  }
  process.exit(n('FAIL') ? 1 : 0);
})().catch(e => { console.error('EDGE CASES FAILED TO RUN:', e.stack); process.exit(2); });
