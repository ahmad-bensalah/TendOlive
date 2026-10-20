// Demo tender API: serves the SYNTHETIC tenders of demo/demo_tenders.json as a public-procurement-style JSON API, so a demo run
// always has tenders that fit OliveSoft (and two that do not), while every step after it is real: the analysis LLM, the
// checks, your RAG service, the market study on public data, the proposal input.   node demo/server.js [port]   (default 8004)
//   GET /tenders           {total, results: [...]}   (the `demo` source of 00 - Config reads this)
//   GET /tenders/:id       a small HTML page of one notice (the notice link of the export)
// Each record says synthetic: true and its buyer is fictional. Dates are computed from today, so the demo never goes stale.
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = Number(process.argv[2] || 8004);
const FILE = path.join(__dirname, 'demo_tenders.json');
const iso = days => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const load = () => JSON.parse(fs.readFileSync(FILE, 'utf8')).tenders.map(t => ({   // re-read on every call: edit the file, no restart
  id: t.id, title: t.title, buyer: t.buyer, country: t.country, language: t.language, currency: t.currency,
  publication_date: iso(-(t.pub_days_ago ?? 2)), deadline: iso(t.deadline_in_days ?? 21),
  cpv: t.cpv || [], estimated_value: t.estimated_value || null, email: t.email || null, description: t.description,
  duration: t.duration || null, award_criteria: t.award_criteria || [],
  url: `http://localhost:${PORT}/tenders/${t.id}`, synthetic: true }));
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/tenders' || u.pathname === '/tenders/') {
      const all = load();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ synthetic: true, total: all.length, results: all }));
    }
    const m = u.pathname.match(/^\/tenders\/([\w-]+)$/), t = m && load().find(x => x.id === m[1]);
    if (t) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><meta charset="utf-8"><title>${esc(t.title)}</title><body style="font-family:sans-serif;max-width:760px;margin:2em auto">
<p style="background:#fde68a;padding:.5em">SYNTHETIC DEMO NOTICE - not a real tender</p><h1>${esc(t.title)}</h1><p><b>${esc(t.buyer)}</b> - ${esc(t.country)}</p>
<p>Published ${t.publication_date} - Deadline ${t.deadline} - CPV ${esc(t.cpv.join(', '))} - ${esc(t.estimated_value || '')}</p>
<div style="white-space:pre-wrap">${esc(t.description)}</div></body>`);
    }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"not found"}');
  } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message) })); }
}).listen(PORT, '0.0.0.0', () => console.log(`demo tender API (synthetic) on http://localhost:${PORT}/tenders`));
