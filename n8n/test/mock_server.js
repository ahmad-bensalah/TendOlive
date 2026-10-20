// Local stand-ins for the paid / not-yet-running services, for wiring tests only: node test/mock_server.js [port]
//   POST /v2/scrape        Firecrawl scrape  -> saved pages of test/fixtures.json (unknown URL -> a 404 page)
//   POST /v1/search        Firecrawl search  -> saved search results (substring match on the query)
//   POST /retrieve/tender  RAG service       -> deterministic word-overlap matrix in the real service's response shape
//   GET  /stats            request counters
const http = require('http'), fs = require('fs'), path = require('path');
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'));
const FR_M = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const AR_M = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const EN_M = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dates = s => s.replace(/\{\{(iso|fr|frinvis|frl|ar|en)([+-]\d+)\}\}/g, (_, f, n) => {
  const dt = new Date(Date.now() + Number(n) * 864e5), y = dt.getUTCFullYear(), m = dt.getUTCMonth(), d = dt.getUTCDate(), p2 = x => String(x).padStart(2, '0');
  const ar = x => String(x).replace(/\d/g, c => String.fromCharCode(0x660 + +c));
  return { iso: `${y}-${p2(m + 1)}-${p2(d)}`, fr: `${p2(d)}/${p2(m + 1)}/${y}`, frinvis: `${p2(d)}/${p2(m + 1)}/${String(y).slice(0, 3)}​${String(y).slice(3)}`,
    frl: `${d}\u00A0${FR_M[m]} ${y}`, ar: `${ar(d)} ${AR_M[m]} ${ar(y)}`, en: `${EN_M[m]} ${d}, ${y}` }[f];
});
const norm = u => String(u || '').replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/^www\./, '');
const stats = {};
const KB = [
  ['doc-1', 'Mobile apps for municipalities', 'We built iOS and Android citizen reporting apps for three municipalities, with back-office and hosting in France.'],
  ['doc-2', 'Hosting', 'Our platforms are hosted in certified French and Tunisian data centres.'],
  ['doc-3', 'AI chatbot', 'Conversational AI assistants in Arabic, French and English for public services, connected to document bases.'],
  ['doc-4', 'COMPETENCES :', 'COMPETENCES :'],
];
const words = s => new Set(String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[\p{L}\p{N}]{4,}/gu) || []);
// same response shape as the real OliveSoft RAG service (/retrieve/tender, checked 2026-10-19)
const rag = body => {
  const matrix = [], details = [], blocking = [];
  for (const cat of ['technical', 'team', 'experience']) for (const text of (body.requirements || {})[cat] || []) {
    const ev = KB.map(([doc_id, title, quote]) => { const n = [...words(text)].filter(w => words(title + ' ' + quote).has(w)).length;
      return { doc_id, type: 'past_project', origin: 'user_entered', summary: title, similarity_score: 0.78 + 0.01 * n, rerank_score: Math.round((-3 + 2.2 * n) * 100) / 100,
        evidence: { kind: 'user_statement', quote: null, line: null, statement: `Name: ${title}\nDescription: ${quote}` } }; })
      .sort((a, b) => b.rerank_score - a.rerank_score);
    const matches = ev.filter(e => e.rerank_score > 0), status = matches.length ? 'covered' : 'missing';
    details.push({ requirement: text, category: cat, method: 'reranker', matches, closest: matches.length ? null : ev[0] });
    matrix.push({ requirement: text, category: cat, mandatory: /must|shall|doit|devra/i.test(text), status, found: matches.length ? 1 : 0, needed: 1, method: 'reranker',
      best_doc: matches.length ? matches[0].doc_id : null, evidence: null, closest_doc: matches.length ? null : ev[0].doc_id,
      origin: matches.length ? 'user_entered' : null, statement: matches.length ? matches[0].evidence.statement : null });
    if (!matches.length && /must|shall|doit|devra/i.test(text)) blocking.push(text);
  }
  const share = c => { const r = matrix.filter(m => m.category === c); return r.length ? Math.round(100 * r.filter(m => m.status === 'covered').length / r.length) : null; };
  return { requirement_matches: details, requirements_matrix: matrix,
    fit_score: { technical_fit: share('technical'), experience_fit: share('experience'), team_fit: share('team'), domain_fit: body.sector ? 100 : null, certification_fit: null, overall: share('technical') },
    warnings: blocking.length ? [`BLOCKING - no internal evidence for mandatory requirement(s): ${blocking.join('; ')}`] : [], tender_id: body.tender_id,
    // fields of the team's RAG v2 (2026-10-20): data mode, team builder, knowledge gaps
    data_mode: body.data_mode || 'company', coverage_basis: 'Recorded capabilities; declarations are not verified document evidence.', team_proposal: null,
    knowledge_gaps: matrix.filter(m => m.status === 'missing').map(m => ({ requirement: m.requirement, category: m.category, status: 'missing', mandatory: m.mandatory,
      kind: 'technology', gap: 'No record lists it.', suggestion: 'Add a record that lists it.' })), knowledge_counts: { cv: 0, past_project: KB.length } };
};
http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => (raw += c)).on('end', () => {
    const key = `${req.method} ${req.url.split('?')[0]}`; stats[key] = (stats[key] || 0) + 1;
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch { return send(400, { success: false, error: 'bad json' }); }
    if (key === 'GET /stats') return send(200, stats);
    if (!/^Bearer /.test(req.headers.authorization || '') && /scrape|search/.test(key)) return send(401, { success: false, error: 'Unauthorized: missing Bearer token' });
    if (key === 'POST /v2/scrape' || key === 'POST /v1/scrape') {
      const p = FX.pages[norm(body.url)];
      if (!p) return send(200, { success: true, data: { markdown: '# 404 Not Found\nThe page does not exist.', metadata: { sourceURL: body.url, url: body.url, statusCode: 404, title: 'Not found' } } });
      return send(200, { success: true, data: { markdown: dates(p.markdown), metadata: { sourceURL: body.url, url: body.url, statusCode: p.status || 200, title: p.title || '' } } });
    }
    if (key === 'POST /v1/search' || key === 'POST /v2/search') {
      const q = String(body.query || '').toLowerCase();
      const hit = Object.entries(FX.search).find(([k]) => q.includes(k));
      const rows = hit ? hit[1] : [];
      return send(200, key.startsWith('POST /v2') ? { success: true, data: { web: rows } } : { success: true, data: rows });
    }
    if (key === 'POST /retrieve/tender') return send(200, rag(body));
    send(404, { error: 'unknown route ' + key });
  });
}).listen(Number(process.argv[2] || 18080), '0.0.0.0', () => console.log('mock on', process.argv[2] || 18080));
