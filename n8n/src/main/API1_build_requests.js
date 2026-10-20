// API1 - Build Requests (API lane). One HTTP request per page of every enabled API source, built only from the source's
// `request` block in Config. Placeholders: {since} {sinceCompact} {keywords} {limit} {offset} {page}.
const cfg = $('00 - Config').first().json;
const since = new Date((Date.parse(cfg.today) || Date.now()) - cfg.limits.lookbackDays * 864e5).toISOString().slice(0, 10);   // from the run's local "today" (Config)
const out = [];
for (const src of cfg.sources.filter(s => s.type === 'api')) {
  const R = src.request || {}, P = R.paging || {};
  const kws = (src.keywords || cfg.company.keywords || []).map(k => String(k).replace(/["\\]/g, '').trim()).filter(Boolean);
  const keywords = R.keywordClause ? kws.map(k => R.keywordClause.split('{kw}').join(k)).join(R.keywordJoin || ' OR ') : kws.join(' ');
  const max = Math.max(1, cfg.limits.maxRecordsPerApi), size = Math.max(1, Math.min(P.pageSize || 100, max));
  for (let p = 0; p * size < max; p++) {
    // page-number paging keeps the full page size on every page (a smaller last page would shift the API's offset)
    const vars = { since, sinceCompact: since.replace(/-/g, ''), keywords, limit: P.style === 'page' ? size : Math.min(size, max - p * size), offset: p * size, page: (P.firstPage ?? 1) + p };
    // "{limit}" alone -> a number (JSON bodies); placeholders inside text -> text
    const fill = v => typeof v === 'string'
      ? (/^\{(limit|offset|page)\}$/.test(v) ? vars[v.slice(1, -1)] : v.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)))
      : Array.isArray(v) ? v.map(fill)
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)])) : v;
    const qs = fill(R.query || {});
    if (P.style === 'offset') { qs[P.offsetParam || 'offset'] = vars.offset; qs[P.limitParam || 'limit'] = vars.limit; }
    if (P.style === 'page' && P.in !== 'body') { qs[P.pageParam || 'page'] = vars.page; if (P.limitParam) qs[P.limitParam] = vars.limit; }
    out.push({ json: { source: src.name, page: p + 1, method: String(R.method || 'GET').toUpperCase(), url: R.url, qs, headers: fill(R.headers || {}), body: R.body ? fill(R.body) : null } });
  }
}
return out;
