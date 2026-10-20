// URL1 - Scout Tasks (URL lane). One task per URL source for the Tender Scout Agent: where to start, and how many pages it
// may open. The start URL can be the tender list, ONE notice, or just the home page (the agent finds the list).
// A source that declares its pagination (`pageParam` or "{page}" in the URL) gets the URLs of its pages 2..maxPages too.
// open_page calls allowed = pages of the list + limits.maxListHops (home page -> menu -> list); each call = 1 Firecrawl credit.
/*@lib parseUrl hostOfUrl*/
const cfg = $('00 - Config').first().json;
const MAX_HOPS = cfg.limits.maxListHops ?? 2;
const pageUrl = (s, n) => {
  if (String(s.url).includes('{page}')) return s.url.split('{page}').join(String(n));
  if (n <= 1 || !s.pageParam) return s.url;
  const [base, hash] = String(s.url).split('#');
  const re = new RegExp('([?&])' + s.pageParam.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=[^&]*');
  const u = re.test(base) ? base.replace(re, `$1${s.pageParam}=${n}`) : `${base}${base.includes('?') ? '&' : '?'}${s.pageParam}=${n}`;
  return hash ? `${u}#${hash}` : u;
};
return cfg.sources.filter(s => s.type === 'url').map(s => {
  const pages = Math.max(1, Math.min(s.maxPages || 1, cfg.limits.maxPagesPerUrl));
  const paginated = !!s.pageParam || String(s.url).includes('{page}');
  const listed = paginated ? Array.from({ length: pages }, (_, k) => pageUrl(s, k + 1)) : [pageUrl(s, 1)];
  return { json: { source: s.name, url: listed[0], other_pages: listed.slice(1), country: s.country || '', language: s.language || '',
    max_pages: pages, max_calls: pages + MAX_HOPS, allowed_hosts: [hostOfUrl(s.url), ...(s.allowedHosts || [])].filter(Boolean),
    onlyMainContent: s.onlyMainContent ?? true } };
});
