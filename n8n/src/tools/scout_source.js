// Resolve Source (Scout Tools). Which URL source of Config does the requested page belong to (by host)? -> the hosts its links
// may be on, and Firecrawl's main-content mode. Read from Config (url_sources), never from the agent's item, so every source
// gets its own settings whichever source the agent is working on.
/*@lib parseUrl hostOfUrl urlKey*/
const T = $input.first().json;
let sources = []; try { sources = JSON.parse(T.url_sources || '[]'); } catch {}
const h = hostOfUrl(T.url), on = k => !!k && (h === k || h.endsWith('.' + k));
const all = sources.map(s => ({ ...s, hosts: [s.url, ...(s.allowedHosts || [])].map(hostOfUrl).filter(Boolean) }));
const src = all.find(s => s.hosts.some(on));
// a host of no configured source is a URL the model typed wrong ("www.franc-than.com" for www.francemarches.com): refused, and
// Page Links tells the agent so. The "Known source?" IF sends a refused item straight to Page Links, so Firecrawl is never
// called (no credit, no rate budget). No source list at all (older Main): nothing is refused.
// A site that moved to another domain needs that domain in the source's allowedHosts (the message ends in Run Summary too)
// The refusal names the URL to open instead, so the agent can recover: told "open the START URL exactly as written", the real
// agent re-read page 2 and never read page 1. Which source: the one whose START URL the asked URL IS on another host (the model
// kept "/recherche?q=Intelligence+Artificielle&etat=en-cours" and mistyped only the host), else whose list it is ("&page=2": that
// page on the source's host), else the only source. Two sources that fit equally well: none named (the old advice).
// Never by host name alone when there are several sources: Resolve Source cannot know which source the calling agent works on,
// and a name score cannot tell a typo from another portal ("marchespublics.gov.tn", the real Tunisian portal, is closer to
// "francemarches" than the real typo "franc-than" is): a domainetat-tn scout told to open francemarches' list would file French
// tenders under TN (URL3 tags every pick with its task's source) and leave its own site. The path + query are proof enough.
// "{page}" in a source url is page 1 there, as URL1 writes the START URL. A bare home page "/" proves no source: every site has
// one, so a source whose url is a home page would be named for any mistyped home page
const startOf = s => String(s.url || '').split('{page}').join('1');
const asked = parseUrl(/^[a-z][a-z0-9+.-]*:/i.test(String(T.url || '').trim()) ? T.url : `https://${T.url}`), listOf = u => urlKey(u, p => p.page);
const specific = !!asked && (asked.pathname.replace(/\/+$/, '') !== '' || !!asked.search);
const onHost = s => { const b = parseUrl(startOf(s)); return specific && b && b.host ? `${b.protocol}//${b.host}${asked.pathname}${asked.search}` : ''; };
let hint = 'open the START URL exactly as written, or a URL from an earlier open_page result';
if (!src && all.length) {
  const [a, b] = all.map(s => { const st = startOf(s), u = onHost(s);
    return { s, st, u, tier: u && urlKey(u) === urlKey(st) ? 2 : u && listOf(u) === listOf(st) ? 1 : 0 }; }).sort((x, y) => y.tier - x.tier);
  const best = !b || a.tier > b.tier ? a : null;
  if (best) hint = best.tier === 2 ? `open ${best.st} instead: the START URL of ${best.s.name}, copied exactly`
    : best.tier === 1 ? `open ${best.u} instead: that page on the site of ${best.s.name}`
    : `the START URL of ${best.s.name} is ${best.st}: open it, or a URL from an earlier open_page result, copied exactly`;
}
const refused = !src && sources.length ? `refused, no page read: ${h || 'no host'} is not a site of the configured sources (${hint}; other hosts go in Config allowedHosts)` : '';
return [{ json: { ...T, source: src ? src.name : null, allowed_hosts: src ? src.hosts.join(',') : '', only_main: src ? src.only_main !== false : true,
  ...(refused ? { refused } : {}) } }];
