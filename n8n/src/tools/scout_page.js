// open_page (Scout Tools). ONE page read by Firecrawl -> short text for the Tender Scout Agent: the page id, its text,
// and its same-site links, each with a short id. The agent answers with ids; URL3 maps them back to the URLs written here,
// so a model can never corrupt a tender URL. Nothing here knows a website: hosts come from the page and the source,
// card labels repeated on the page ("read more") are learned per page.
//   PAGE [id] | url | title          (or: PAGE ERROR | url | reason)
//   TEXT: start of the page
//   REPEATED LABELS: label | label
//   NEXT PAGE: [id] | url        (the link to the next page of this list, found by code; or: NEXT PAGE: none)
//   NOTE: redirected to host ... (only when Firecrawl landed on a host of no source: open_page refuses its links)
//   LINKS (same site, k of n):
//   [id] link text — context | url
/*@lib fnv parseUrl hostOfUrl normUrl stripMd pageError urlKey*/
const T = $('Resolve Source').first().json;          // the requested url + the hosts and main-content mode of its source
const r = $input.first().json || {};
const MAX = Number(T.max_links) || 100;
const IMG = /\.(png|jpe?g|gif|svg|webp|ico|bmp)(\?|#|$)/i, FILE = /\.(css|js|xml|rss|zip|json)(\?|#|$)/i;
// generic "read more" button words (glued to the title on many sites: "Continuer la lectureAppel d'offres ...")
const READ_MORE = /^\s*(continuer la lecture|lire la suite|lire plus|en savoir plus|voir plus|voir le d[ée]tail|read more|learn more|view details|إقرأ المزيد|اقرأ المزيد|المزيد)\s*[:»>.-]*\s*|\s*[«<.-]*\s*(continuer la lecture|lire la suite|lire plus|en savoir plus|voir plus|read more|إقرأ المزيد|اقرأ المزيد)\s*$/i;

// bracket-aware markdown link scanner: [![alt](img) text](url), "]" inside alt text, (url "title")
function scanLinks(s) {
  const found = [];
  for (let i = s.indexOf(']('); i >= 0; i = s.indexOf('](', i + 2)) {
    let depth = 0, a = -1;
    for (let k = i; k >= 0 && i - k < 600; k--) { if (s[k] === ']') depth++; else if (s[k] === '[') { depth--; if (depth === 0) { a = k; break; } } }
    if (a < 0) continue;
    let p = 0, b = -1;
    for (let k = i + 1; k < s.length && k - i < 2000; k++) { if (s[k] === '(') p++; else if (s[k] === ')') { p--; if (p === 0) { b = k; break; } } else if (s[k] === '\n') break; }
    if (b < 0) continue;
    const isImage = a > 0 && s[a - 1] === '!';
    found.push({ start: isImage ? a - 1 : a, end: b + 1, label: s.slice(a + 1, i), target: s.slice(i + 2, b).trim().replace(/\s+"[^"]*"$/, '').replace(/^<|>$/g, ''), isImage });
  }
  return found;
}

const err = T.refused || pageError(r);         // refused by Resolve Source (host of no source): whatever Firecrawl Scrape answered
if (err) return [{ json: { result: `PAGE ERROR | ${T.url} | ${err}` } }];
const d = r.data, md = String(d.markdown), meta = d.metadata || {};
const pageUrl = meta.url || meta.sourceURL || T.url;
const srcHosts = String(T.allowed_hosts || '').split(',').map(h => h.trim().replace(/^www\./, '').toLowerCase()).filter(Boolean);
const allowed = new Set([hostOfUrl(T.url), hostOfUrl(pageUrl), ...srcHosts]);
const idOf = u => fnv(normUrl(u));
const lines = md.split('\n');
const starts = []; { let pos = 0; for (const l of lines) { starts.push(pos); pos += l.length + 1; } }
const lineOf = off => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= off) lo = m; else hi = m - 1; } return lo; };

const raw = scanLinks(md).filter(l => !l.isImage);
const links = raw.filter(l => !raw.some(o => o !== l && o.start <= l.start && o.end >= l.end));   // outermost link only (a card)
const self = parseUrl(pageUrl) && parseUrl(pageUrl).noHash.replace(/\s/g, '%20');
const byUrl = new Map();
for (const l of links) {
  const u = parseUrl(l.target, pageUrl);
  if (!u || !/^https?:$/.test(u.protocol) || IMG.test(u.pathname) || FILE.test(u.pathname)) continue;
  const url = u.noHash.replace(/\s/g, '%20');         // a raw space would break the "| url" line format
  if (!allowed.has(hostOfUrl(url)) || url === self) continue;
  const text = stripMd(l.label).replace(READ_MORE, ' ').trim();
  const ln = lineOf(l.start);
  const context = stripMd(lines.slice(Math.max(0, ln - 1), ln + 2).join(' ')).slice(0, 200);
  if (!text && !context) continue;
  const prev = byUrl.get(url);
  if (!prev) byUrl.set(url, { url, text, context, pos: l.start });
  else if (text.length > prev.text.length) prev.text = text;
}
// a label on 3+ links that go to DIFFERENT pages ("read more" on every card, any language) carries no meaning: learned
// from this page, not from a list. A label that always goes to the SAME page (a category tag "Appel d'offre" on every card)
// is kept: it is often the way to the tender list.
const count = {};
for (const l of links) {
  const t = stripMd(l.label).toLowerCase(), u = parseUrl(l.target, pageUrl);
  if (t && t.length < 40) { const c = (count[t] ||= { n: 0, urls: new Set() }); c.n++; if (u) c.urls.add(u.noHash); }
}
const repeated = Object.entries(count).filter(([, c]) => c.n >= 3 && c.urls.size >= 2).map(([t]) => t);
let cands = [...byUrl.values()].sort((a, b) => a.pos - b.pos);
for (const c of cands) if (repeated.includes(c.text.toLowerCase())) c.text = '';
cands = cands.filter(c => c.text || c.context).slice(0, MAX);

let list = '', shown = 0;                   // ~8000 chars of links (small local models have an 8k-token context): ~45 links
for (const c of cands) {
  const rest = c.text && c.context.startsWith(c.text) ? c.context.slice(c.text.length).trim() : c.context;   // context minus the link text
  // a long link text says enough: the surrounding text is shown only for short labels ("Lire la suite", "Appel d'offre")
  const t = c.text.slice(0, 120), ctx = rest && c.text.length < 40 ? ` — ${rest.slice(0, 70)}` : '';
  const line = `[${idOf(c.url)}] ${t || '(no text)'}${ctx} | ${c.url}\n`;
  if (list.length + line.length > 8000) break;
  list += line; shown++;
}
const excerpt = stripMd(md).slice(0, 700);
// next page of a list: "Suivant", "Next", "»", "التالي"... (a small model easily misses it among the links). The word can also sit
// INSIDE a short label ("Aller à la page suivante", "20 avis de marchés publics suivants", "Older posts"): then the link must be a
// LATER page of THIS list: same host, path and other parameters (sort ones too), and a higher page number ("paged=2", "page=3",
// "start=40", "/page/2"). So a short tender title "Acquisition des équipements suivants" and a sort link "Les plus anciens"
// ("&ordre=date-asc", no page number) are never taken for it. Page parameters and URL keys: urlParts / urlKey (lib.js), scoutRun's rule
const NEXT = /^(suivant|suivante|page suivante|next|next page|plus anciens|older|التالي|الصفحة التالية|الموالي)(\s|[»›>]|$)|^[»›]$|^>>?$/i;
const NEXT_IN = /(^|[\s(«])(suivante?s?|next|older|plus anciens|التالية?|الموالية?)(?=$|[\s»›>).:])/i;
// {view: the URL without its page number (sort parameters kept: another order is another list here), n: that number (null: none)}
const pageOf = u => { const p = urlParts(u); return p && { view: urlKey(u, x => x.page), n: p.n }; };
const here = pageOf(pageUrl), later = u => { const o = pageOf(u); return !!(o && here && o.n !== null && o.view === here.view && o.n > (here.n ?? 0)); };
const next = cands.find(c => NEXT.test(c.text.trim())) || cands.find(c => c.text.length <= 60 && NEXT_IN.test(c.text) && later(c.url));
// Firecrawl followed a redirect to a host of no source ("site.fr" for the configured "site.com"): its links are listed and can be
// picked (Firecrawl Detail reads them), but open_page refuses to open them (Resolve Source). Said to the agent, and kept in
// scoutRun's notes for Run Summary, so the operator adds that host to the source's allowedHosts
const landed = hostOfUrl(pageUrl);
const moved = T.source && landed && !srcHosts.some(k => landed === k || landed.endsWith('.' + k))
  ? `NOTE: redirected to ${landed}, which is not in the allowedHosts of source "${T.source}": its links can be picked, open_page will refuse them` : '';
return [{ json: { result: [
  `PAGE [${idOf(pageUrl)}] | ${pageUrl} | ${String(meta.title || '').replace(/\|/g, '/').slice(0, 150)}`,
  `TEXT: ${excerpt}`,
  `REPEATED LABELS: ${repeated.slice(0, 10).join(' | ') || 'none'}`,
  `NEXT PAGE: ${next ? `[${idOf(next.url)}] | ${next.url}` : 'none'}`,
  ...(moved ? [moved] : []),
  `LINKS (same site, ${shown} of ${byUrl.size}):`,
  list.trim() || '(none)'].join('\n') } }];
