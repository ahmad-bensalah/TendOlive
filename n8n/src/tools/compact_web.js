// Compact Web (Research Tools). Firecrawl search / scrape answer -> short text for the agent.
//   web_search: WEB | url | title | snippet            (Firecrawl v1 {data:[...]} or v2 {data:{web:[...]}})
//   web_scrape: PAGE | url \n EMAILS: ... \n PHONES: ... \n TEXT: ...
const T = $('Tool Input').first().json;
const r = $input.first().json || {};
const cut = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const cell = (s, n) => cut(s, n).replace(/\|/g, '/');
if (r.error || r.success === false) return [{ json: { result: 'ERROR: ' + cut((r.error && (r.error.message || r.error.description)) || r.error || 'request failed', 160) } }];
if (T.tool === 'web_search') {
  const rows = Array.isArray(r.data) ? r.data : (r.data && Array.isArray(r.data.web) ? r.data.web : []);
  return [{ json: { result: rows.length ? rows.slice(0, 5).map(x => ['WEB', cut(x.url, 200), cell(x.title || (x.metadata && x.metadata.title), 120), cell(x.description || x.snippet, 220)].join(' | ')).join('\n') : 'NO RESULTS' } }];
}
const d = r.data || {}, md = String(d.markdown || '');
if (md.length < 40) return [{ json: { result: 'NO CONTENT' } }];
const status = Number((d.metadata && d.metadata.statusCode) || 200);
if (status >= 400) return [{ json: { result: `ERROR: page status ${status}` } }];
const plain = md.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
const emails = [...new Set((plain.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map(e => e.toLowerCase())
  .filter(e => !/(example|noreply|no-reply|sentry|wixpress|\.(png|jpe?g|gif|svg|webp)$)/i.test(e)))].slice(0, 5);
const phones = [...new Set((plain.replace(/\]\([^)]*\)/g, ']').match(/(?:\+|00)?\d[\d .\-()\/]{7,18}\d/g) || []).map(p => p.trim())
  .filter(p => { const n = p.replace(/\D/g, ''); return n.length >= 8 && n.length <= 15 && !/^(19|20)\d{6}$/.test(n); }))].slice(0, 5);
const text = plain.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[#*_`>|]+/g, ' ');
const url = (d.metadata && (d.metadata.url || d.metadata.sourceURL)) || T.url;
return [{ json: { result: `PAGE | ${cut(url, 200)}\nEMAILS: ${emails.join(', ') || 'none'}\nPHONES: ${phones.join(', ') || 'none'}\nTEXT: ${cut(text, 1500)}` } }];
