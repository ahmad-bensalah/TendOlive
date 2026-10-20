// Shared helpers. build.js inlines ONLY the snippets a Code node asks for (/*@lib a b c*/) plus their dependencies.
// Every invisible / combining character is written as a \u escape so copy-paste can never corrupt a regex.

//@snippet INVIS
const INVIS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u061C\uFEFF\u00AD]/g;

//@snippet fold needs INVIS
// script-agnostic folding: lowercase, no accents / Arabic diacritics / tatweel, unified alef / ya / ta marbuta,
// Arabic-Indic digits -> ASCII, punctuation -> space
const fold = s => String(s ?? '').replace(INVIS, '').replace(/[\u00A0\u202F\u2007]/g, ' ').toLowerCase().normalize('NFKD')
  .replace(/[\u0300-\u036F\u064B-\u065F\u0670ـ]/g, '')
  .replace(/[آأإ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
  .replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, c => String(c.charCodeAt(0) - 0x6F0))
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

//@snippet toks needs fold
const toks = s => fold(s).split(' ').filter(t => t.length > 1);

//@snippet overlap needs toks
// share of the tokens of `part` that also appear in `whole` (0..1)
const overlap = (part, whole) => { const P = toks(part); if (!P.length) return 0; const W = new Set(toks(whole)); return P.filter(t => W.has(t)).length / P.length; };

//@snippet nameSim needs toks
// symmetric name similarity (Dice on folded tokens longer than 2 chars, plural -s / -x ignored)
const stem = t => (t.length > 4 ? t.replace(/[sx]$/, '') : t);
const NAME_STOP = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'of', 'the', 'and', 'et', 'pour', 'en', 'au', 'aux', 'for']);
const nameSim = (a, b) => { const A = new Set(toks(a).filter(t => t.length > 2).map(stem)), B = new Set(toks(b).filter(t => t.length > 2).map(stem)); if (!A.size || !B.size) return 0; let i = 0; A.forEach(t => B.has(t) && i++); return 2 * i / (A.size + B.size); };
// share of the name's words found in a text (for page titles such as "Ville de X - Site officiel")
const containment = (name, text) => { const N = toks(name).filter(t => !NAME_STOP.has(t)).map(stem); if (!N.length) return 0; const T = new Set(toks(text).map(stem)); return N.filter(t => T.has(t)).length / N.length; };

//@snippet nameMatch needs toks nameSim
// nameSim that also understands acronyms written as initials:
// "CCAS de Bourgoin-Jallieu" ~ "CENTRE COMMUNAL D'ACTION SOCIALE DE BOURGOIN JALLIEU"
const expandAcronyms = (a, b) => {
  const B = toks(b).filter(t => !NAME_STOP.has(t)), out = [];
  for (const t of toks(a).filter(x => !NAME_STOP.has(x))) {
    let hit = null;
    if (/^[a-z]{2,6}$/.test(t)) for (let i = 0; i + t.length <= B.length && !hit; i++) if (B.slice(i, i + t.length).map(w => w[0]).join('') === t) hit = B.slice(i, i + t.length);
    out.push(...(hit || [t]));
  }
  return out.join(' ');
};
const nameMatch = (a, b) => Math.max(nameSim(a, b), nameSim(expandAcronyms(a, b), b), nameSim(a, expandAcronyms(b, a)));

//@snippet quoteInText needs fold
// a quote is "verbatim" if its folded form is inside the folded text, or (weak-model tolerance) an in-order token
// window of the text covers >= 85% of the quote's tokens AND every number of the quote ("3 ans" quoted as "5 ans" fails).
const quoteInText = (quote, text, min = 0.85) => {
  const q = fold(quote), t = fold(text);
  if (!q || q.split(' ').length < 3) return false;
  if ((' ' + t + ' ').includes(' ' + q + ' ')) return true;
  // words glued or split by the page itself ("intelligenceartificielle"): compare without spaces; a number at either end
  // must not continue into a longer number (inside the quote, numbers stay anchored by the letters around them)
  const qs = q.replace(/ /g, ''), ts = t.replace(/ /g, ''), at = ts.indexOf(qs);
  if (at >= 0 && !(/\d/.test(qs[0]) && /\d/.test(ts[at - 1] || '')) && !(/\d/.test(qs[qs.length - 1]) && /\d/.test(ts[at + qs.length] || ''))) return true;
  const Q = q.split(' '), T = t.split(' ');
  // anchors that must be matched exactly: numbers in digits or in words ("trois références" quoted for "deux" fails)
  const NUMW = /^(deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|quinze|vingt|trente|quarante|cinquante|cent|mille|two|three|four|five|seven|eight|nine|ten|twelve|fifteen|twenty|thirty|forty|fifty|hundred|thousand)$/;
  // a negation the window skips (text "ne comprend PAS", quote "comprend") or that the quote adds, changes the meaning
  const NEG = /^(ne|n|pas|non|sans|aucun|aucune|jamais|ni|not|no|never|without|nor|لا|ليس|غير|دون|لن|لم)$/;
  const anchors = Q.map((x, k) => (/\d/.test(x) || NUMW.test(x) ? k : -1)).filter(k => k >= 0);
  for (let i = 0; i < T.length; i++) {
    const start = [0, 1, 2].find(k => Q[k] !== undefined && T[i] === Q[k]);   // the first words may differ a little
    if (start === undefined) continue;
    let qi = start, last = i;
    const hits = new Set(), skipped = [];
    for (let ti = i; qi < Q.length && ti < T.length && ti - i < Q.length * 1.3 + 3; ti++) {
      if (T[ti] === Q[qi]) { hits.add(qi); qi++; last = ti; } else if (T[ti] === Q[qi + 1]) { hits.add(qi + 1); qi += 2; last = ti; } else skipped.push(ti);
    }
    if (hits.size / Q.length < min || !anchors.every(k => hits.has(k))) continue;
    if (skipped.some(ti => ti <= last && NEG.test(T[ti])) || Q.some((x, k) => !hits.has(k) && NEG.test(x))) continue;
    return true;
  }
  return false;
};

//@snippet fnv
const fnv = s => { let h = 0x811c9dc5; for (const c of String(s)) { h ^= c.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(36); };

//@snippet parseUrl
// the Code-node sandbox has no URL class: minimal parser + resolver for absolute and relative links
const parseUrl = (u, base) => {
  u = String(u || '').trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) {
    if (!base) return null;
    const b = parseUrl(base); if (!b || !b.host) return null;
    if (u.startsWith('//')) u = `${b.protocol}${u}`;
    else if (u.startsWith('/')) u = `${b.protocol}//${b.host}${u}`;
    else if (u.startsWith('?')) u = `${b.protocol}//${b.host}${b.pathname}${u}`;
    else if (u.startsWith('#') || u === '') u = `${b.protocol}//${b.host}${b.pathname}${b.search}${u}`;
    else u = `${b.protocol}//${b.host}${b.pathname.replace(/[^/]*$/, '')}${u}`;
  }
  const m = /^([a-z][a-z0-9+.-]*:)(?:\/\/([^/?#]*))?([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(u);
  if (!m) return null;
  const protocol = m[1].toLowerCase(), host = (m[2] || '').replace(/^[^@]*@/, '').toLowerCase().replace(/:(80|443)$/, '');
  const segs = []; for (const s of (m[3] || '/').split('/')) { if (s === '..') segs.pop(); else if (s !== '.') segs.push(s); }
  let pathname = segs.join('/'); if (!pathname.startsWith('/')) pathname = '/' + pathname;
  if (/^https?:$/.test(protocol) && !host) return null;
  const search = m[4] && m[4] !== '?' ? m[4] : '', hash = m[5] || '';
  return { protocol, host, pathname, search, hash, noHash: `${protocol}//${host}${pathname}${search}` };
};

//@snippet hostOfUrl needs parseUrl
// no value is no host: undefined / null used to become "https://undefined" (host "undefined", a Wikidata row without website=)
const hostOfUrl = u => { const s = String(u ?? '').trim(); if (!s) return ''; const x = parseUrl(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`); return x ? x.host.replace(/^www\./, '') : ''; };

//@snippet normUrl needs parseUrl
// canonical form of a page URL (no #fragment, no trailing slash) used for ids and "already seen" checks
const normUrl = u => { const x = parseUrl(/^https?:/i.test(String(u || '')) ? u : `https://${u}`); return x ? x.noHash.replace(/\/$/, '') : String(u || ''); };

//@snippet canonicalId needs parseUrl hostOfUrl normUrl
// Config.crossSourceIdRules map a portal URL to an API id (same notice on 2 sources -> same id); else "url:<normalized url>" without
// the parameters that only echo the search of its source's Config url: francemarches writes the searched words into every notice
// link ("/appel-offre/<slug>?q=Intelligence%20Artificielle" under ".../recherche?q=Intelligence+Artificielle&etat=en-cours"), so a new
// search gave every notice a new canonical_id and tender_id, and URL3 took an exported notice for a new one. Only on ANOTHER path than
// the Config url's: on the list's own path ("?p=16872&lang=fr" next to "?cat=19&lang=fr", WordPress) the parameters ARE the page.
// Same parameter = same name and value, any case or space encoding ("q=Intelligence+Artificielle" is "q=intelligence%20artificielle")
const canonicalId = (cfg, url) => {
  for (const r of cfg.crossSourceIdRules || []) { const m = String(url || '').match(new RegExp(r.pattern, 'i')); if (m) return r.canonical.replace(/\$(\d)/g, (_, i) => m[i] || ''); }
  const n = normUrl(url), x = parseUrl(n);
  if (!x || !x.search) return `url:${n}`;
  const dec = s => { try { return decodeURIComponent(s); } catch { return s; } };
  const kv = p => { const [k, v = ''] = p.replace(/\+/g, ' ').split('='); return `${dec(k).trim()}=${dec(v).trim()}`.toLowerCase(); };
  const path = u => u.pathname.replace(/\/$/, ''), echo = new Set();
  for (const s of cfg.sources || []) {
    const c = s && s.type === 'url' && parseUrl(String(s.url || ''));
    if (c && c.search && path(c) !== path(x) && [s.url, ...(s.allowedHosts || [])].map(hostOfUrl).includes(hostOfUrl(n))) for (const p of c.search.slice(1).split('&')) if (p) echo.add(kv(p));
  }
  const ps = x.search.slice(1).split('&'), keep = ps.filter(p => !echo.has(kv(p)));
  return keep.length === ps.length ? `url:${n}` : `url:${x.protocol}//${x.host}${x.pathname}${keep.length ? '?' + keep.join('&') : ''}`.replace(/\/$/, '');
};

//@snippet stripMd needs INVIS
// images are removed (their alt text may itself contain "[...]"), links keep their visible text, markdown line-break
// backslashes go (Firecrawl writes card line breaks as a backslash + newline)
const stripMd = t => String(t || '').replace(/!\[(?:[^[\]]|\[[^\]]*\])*\]\([^)]*\)/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .split(String.fromCharCode(92)).join(' ')
  .replace(/[*_`#>|]+/g, ' ').replace(INVIS, '').replace(/[\u00A0\u202F]/g, ' ').replace(/\s+/g, ' ').trim();

//@snippet pageError
// Firecrawl answer -> '' when the page is usable, else the reason (also rejects error pages served with HTTP 200).
// An HTTP error item (On Error: continue) gives its status and Firecrawl's own reason: for a 429 n8n's error.message is only its
// hint "Try spacing your requests out using the batching settings", the cause ("Rate limit exceeded. Consumed (req/min): 11")
// is in details.body.error / details.description
const pageError = r => {
  if (!r) return 'no response';
  if (r.error) {
    const d = r.details || {}, st = r.error.status || d.httpCode, body = d.body && typeof d.body.error === 'string' ? d.body.error : '';
    return `firecrawl${st ? ` HTTP ${st}` : ''}: ` + String(body || d.description || r.error.description || r.error.message || r.error).slice(0, 160);
  }
  if (r.success === false) return 'firecrawl: ' + String(r.error || r.message || 'success=false').slice(0, 160);
  const d = r.data || {}, md = String(d.markdown || ''), st = Number((d.metadata && d.metadata.statusCode) || 200);
  if (st >= 400) return `page status ${st}`;
  if (md.length < 80) return `empty page (${md.length} chars)`;
  // a bare "404" is not enough (notice numbers, amounts): it must sit next to error / page words
  if (md.length < 1500 && /\b404\b.{0,40}\b(not found|introuvable|error|erreur|page)|\b(page|error|erreur)\b.{0,40}\b404\b|\bnot found\b|page (introuvable|non trouv\w*)|الصفحة غير موجودة/i.test(md.slice(0, 600))) return 'page not found';
  return '';
};

//@snippet parseAnswer
// LLM answer (Basic LLM Chain {text} | Agent {output} | error item) -> {ok, value, errors, raw}.
// Tolerant: strips <think>, code fences and prose, repairs raw line breaks in strings / trailing commas / smart quotes, coerces
// enum case and numeric strings, then validates against a mini JSON schema {type, properties, required, enum, items, nullable, default, maxLength, maxItems}.
function extractJson(text) {
  let s = String(text || '').replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').replace(/```(?:json)?/gi, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('no JSON object in answer');
  s = s.slice(a, b + 1);
  try { return JSON.parse(s); } catch {}
  // safest repairs first: a raw line break / tab INSIDE a string (a model wrapping a long quote) is invalid JSON and lost the whole
  // answer; as a space the quote reads the same, and between tokens it stays whitespace. Smart quotes last: they may be real text
  s = s.replace(/[\u0000-\u001F]+/g, ' ').replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(s); } catch {}
  return JSON.parse(s.replace(/[“”]/g, '"'));
}
function checkSchema(v, s, path, errs, warns = []) {
  if (v === undefined || v === null || v === '' || (s.nullable && typeof v === 'string' && /^(null|none|n\/a|unknown)$/i.test(v.trim()))) {
    if (s.nullable || s.default !== undefined) return s.default ?? null;
    if (s.type === 'array') return [];
    errs.push(`${path}: missing`); return null;
  }
  switch (s.type) {
    case 'string': {
      if (typeof v === 'number' || typeof v === 'boolean') v = String(v);
      // small models sometimes answer a list where one sentence is asked ("reason": ["a", "b"]): joined, not a failed answer
      if (Array.isArray(v) && !s.enum && v.length && v.every(x => typeof x === 'string' || typeof x === 'number')) v = v.join('; ');
      if (typeof v !== 'string') { errs.push(`${path}: not a string`); return null; }
      if (s.enum) {   // "Software Build", "software-build" and "software_build" are the same label ("public sector" too)
        const nk = x => String(x).trim().toLowerCase().replace(/[\s_-]+/g, '_');
        const e = s.enum.find(x => nk(x) === nk(v)); if (!e) { errs.push(`${path}: "${v}" not in ${s.enum.join('|')}`); return null; } return e;
      }
      return v.trim().slice(0, s.maxLength || 4000);
    }
    case 'integer': case 'number': {
      const digits = String(v).replace(/[^\d.-]/g, '');
      const n = typeof v === 'number' ? v : digits ? Number(digits) : NaN;
      if (!Number.isFinite(n)) { errs.push(`${path}: not a number`); return null; }
      return s.type === 'integer' ? Math.round(n) : n;
    }
    case 'boolean': return v === true || /^(true|yes|oui|1)$/i.test(String(v));
    case 'array': {   // an invalid item is dropped on its own (listed in warns); it never invalidates the other items
      const numeric = s.items && /^(integer|number)$/.test(s.items.type);
      if (!Array.isArray(v)) v = numeric && typeof v === 'string' ? v.split(/[^\d.-]+/).filter(Boolean) : [v];   // "1, 4, 7" -> [1, 4, 7]
      return v.slice(0, s.maxItems || 50).map((x, i) => {
        const e = []; const r = checkSchema(x, s.items || {}, `${path}[${i}]`, e, warns);
        if (e.length) warns.push(e[0]);
        return e.length ? null : r;
      }).filter(x => x !== null);
    }
    case 'object': {
      if (typeof v !== 'object' || Array.isArray(v)) { errs.push(`${path}: not an object`); return null; }
      const o = {};
      for (const [k, ps] of Object.entries(s.properties || {})) {
        const sub = []; o[k] = checkSchema(v[k], ps, `${path}.${k}`, sub, warns);
        if (sub.length && (s.required || []).includes(k)) errs.push(...sub); else if (sub.length) o[k] = ps.type === 'array' ? [] : null;
      }
      return o;
    }
    default: return v;
  }
}
function parseAnswer(resp, schema, fallback = null) {
  if (!resp || resp.error) return { ok: false, value: fallback, errors: ['llm call failed: ' + String((resp && resp.error && (resp.error.message || resp.error)) || 'no answer').slice(0, 160)], raw: '' };
  const raw = String(typeof resp.text === 'string' ? resp.text : typeof resp.output === 'string' ? resp.output : (resp.response && resp.response.text) || '');
  const errors = [], warnings = []; let value = null;
  try { value = checkSchema(extractJson(raw), schema || { type: 'object' }, '$', errors, warnings); } catch (e) { errors.push(e.message); }
  return !errors.length && value !== null ? { ok: true, value, errors: [], warnings, raw: raw.slice(0, 300) } : { ok: false, value: fallback, errors, warnings, raw: raw.slice(0, 300) };
}

//@snippet PLATFORM_HOST
// a host named after procurement ("marches-securises.fr", "marches-publics.agglo-x.fr", "achatpublic.com", "tuneps.tn") is a
// tender platform, never a buyer's own website: notices often give the platform's buyer page as the "website"
const PLATFORM_HOST = /(march[eé]s?[-_.]?publics?|march[eé]s?[-_.]|marchesonline|achat|tenders?|procurement|appels?[-_.]?d[-_.]?offres?|demat|e-?marches|boamp|tuneps|ted\.europa)/i;

//@snippet urlKey needs parseUrl
// ONE rule for "the same page" and "the same list" in a URL, used by open_page's NEXT PAGE detector (Page Links) and by scoutRun, so
// the two never drift. One page whatever its parameter order, space encoding or "www.": the link "?cat=19&lang=fr&paged=2" IS the
// opened "?cat=19&paged=2&lang=fr", "q=a%20b" is "q=a+b". A page parameter counts only with a number ("?page=avis-12" is a notice);
// "p" is not one: WordPress notices are "?p=16872". A "/page/N" path end is a page number too
const PAGE_PARAM = /^(page|paged|pg|pagenum|pageno|page_no|pagenumber|pageindex|currentpage|pagina|seite|start|offset|skip|debut\w*)$/, SORT_PARAM = /^(ordre|order|orderby|sort|sortby|tri)$/;
// u -> {path: protocol + host (no "www.") + path (no trailing slash), view: that path without its "/page/N" end, params: sorted
// [{kv, page, sort}] ("+" written "%20"), n: its page number (null: none)}; null when u is no URL
const urlParts = u => {
  const x = parseUrl(/^[a-z][a-z0-9+.-]*:/i.test(String(u || '')) ? u : `https://${u}`); if (!x) return null;
  let n = null; const num = v => { n = Math.max(n ?? 0, +v); };
  const params = x.search.slice(1).replace(/\+/g, '%20').split('&').filter(Boolean).sort().map(kv => {
    let [k, v = ''] = kv.split('='); try { k = decodeURIComponent(k); } catch {} k = (k.toLowerCase().match(/[a-z0-9_]+/g) || ['']).pop();
    const page = PAGE_PARAM.test(k) && /^\d*$/.test(v); if (page && v) num(v);
    return { kv, page, sort: SORT_PARAM.test(k) };
  });
  const path = `${x.protocol}//${x.host.replace(/^www\./, '')}${x.pathname.replace(/\/$/, '')}`, m = path.match(/\/page\/(\d+)$/i); if (m) num(m[1]);
  return { path, view: m ? path.slice(0, m.index) : path, params, n };
};
// the key of a page; with `drop` (which params to leave out) the key of its view: urlKey(u, p => p.page) = its list, any page number
const urlKey = (u, drop) => { const p = urlParts(u); if (!p) return String(u || ''); const q = p.params.filter(x => !(drop && drop(x))).map(x => x.kv); return (drop ? p.view : p.path) + (q.length ? '?' + q.join('&') : ''); };

//@snippet scoutRun needs parseAnswer urlKey
// Tender Scout Agent item (output + intermediateSteps) -> what it REALLY saw and picked:
//   pages: every open_page call in order {url, id, title, error, excerpt, links:[{id,url,text,context}], repeated:[], next, asked, note}
//   picks: its final tender ids (or exact URLs) mapped to links the tool really returned. A page the agent navigated FROM
//          (it opened a link listed there: home, menu, list page 1), a list page it took tenders from, and any other page or
//          sort order of such a list (page=3, paged=26, its NEXT PAGE) is never a tender itself. Unknown ids -> invalid.
//   not_opened: with the URL1 task, its START URL and other pages that no open_page call read (Run Summary: coverage gap)
//   notes: the NOTE lines of open_page (a redirect to a host of no source: open_page refuses its pages, Config allowedHosts)
//   reread: pages read again, one Firecrawl credit each (Run Summary hint): open_page keeps no memory of the calls, and the real
//           francemarches agent read page 2 as "q=Intelligence+Artificielle" then as "q=Intelligence%20Artificielle"
const scoutRun = (r, task) => {
  const out = { ok: false, error: null, pages: [], picks: [], invalid: [], navigation_dropped: 0, list_url: null, next_unopened: null, not_opened: [], notes: [], reread: [] };
  // one page whatever its parameter order, space encoding or "www." (urlKey, the rule of open_page's NEXT PAGE detector too).
  // listView also drops the page / sort parameters and a "/page/N" end: all pages and sort orders of one list are one view
  const urlId = u => urlKey(u), listView = u => urlKey(u, p => p.page || p.sort);
  if (!r || r.error) { out.error = 'scout agent failed: ' + String((r && r.error && (r.error.message || r.error)) || 'no answer').slice(0, 160); return out; }
  const unwrap = obs => {
    const s = typeof obs === 'string' ? obs : JSON.stringify(obs ?? '');
    try { const j = JSON.parse(s); const pick = x => (x && typeof x === 'object' ? String(x.result ?? x.response ?? x.output ?? JSON.stringify(x)) : String(x)); return Array.isArray(j) ? j.map(pick).join('\n') : pick(j); }
    catch { return s.replace(/\\n/g, '\n').replace(/\\"/g, '"'); }
  };
  for (const st of r.intermediateSteps || []) {
    if (String((st.action && st.action.tool) || '') !== 'open_page') continue;
    const text = unwrap(st.observation);
    const head = text.match(/^PAGE \[([a-z0-9]+)\] \| (\S+) \| (.*)$/m), bad = text.match(/^PAGE ERROR \| (\S*) \| (.*)$/m);
    let input = st.action && st.action.toolInput; if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = { url: input }; } }
    const p = { id: head ? head[1] : null, url: head ? head[2] : bad ? bad[1] : String((input && input.url) || ''), title: head ? head[3].trim() : '',
      error: head ? null : bad ? bad[2] : 'unreadable tool result', excerpt: ((text.match(/^TEXT: (.*)$/m) || [])[1] || '').slice(0, 300), links: [], repeated: [],
      asked: String((input && input.url) || '') };   // the URL requested (the PAGE url is where Firecrawl landed: redirects)
    const rep = (text.match(/^REPEATED LABELS: (.*)$/m) || [])[1]; if (rep && rep !== 'none') p.repeated = rep.split(' | ');
    p.next = ((text.match(/^NEXT PAGE: \[[a-z0-9]+\] \| (https?:\/\/.+)$/m) || [])[1]) || null;
    p.note = ((text.match(/^NOTE: (.+)$/m) || [])[1]) || null;
    for (const m of text.matchAll(/^\[([a-z0-9]+)\] (.*) \| (https?:\/\/.+)$/gm)) {
      const k = m[2].indexOf(' — '), t = (k >= 0 ? m[2].slice(0, k) : m[2]).trim();
      p.links.push({ id: m[1], url: m[3], text: t === '(no text)' ? '' : t, context: k >= 0 ? m[2].slice(k + 3).trim() : '' });
    }
    out.pages.push(p);
  }
  const ok = out.pages.filter(p => !p.error), start = ok[0];
  out.notes = [...new Set(ok.map(p => p.note).filter(Boolean))];
  const opened = new Set(ok.map(p => urlId(p.url)));
  out.reread = ok.filter((p, k) => ok.slice(0, k).some(q => urlId(q.url) === urlId(p.url))).map(p => p.url);   // where Firecrawl landed: any spelling
  if (task) { const read = new Set([...opened, ...ok.map(p => urlId(p.asked))]); out.not_opened = [task.url, ...(task.other_pages || [])].filter(u => u && !read.has(urlId(u))); }
  // the last page read showed a NEXT PAGE the agent never opened (Run Summary: stopped early, or out of pages)
  const lastWithNext = [...ok].reverse().find(p => p.next);
  out.next_unopened = lastWithNext && !opened.has(urlId(lastWithNext.next)) ? lastWithNext.next : null;
  // navigation page: the agent opened, AFTER it, a link listed on it (home -> menu -> list -> page 2). A tender page opened to
  // check it, which links BACK to the list, stays a tender.
  const nav = new Set(ok.filter((p, k) => p.links.some(l => ok.slice(k + 1).some(q => urlId(q.url) === urlId(l.url)))).map(p => urlId(p.url)));
  const byKey = new Map();                                   // id or normalized URL -> what the tool showed
  if (start) {                                               // only the START page can be a tender by itself (ONE notice)
    const e = { url: start.url, anchor_text: start.title, listing_snippet: start.excerpt, page: 1, self_page: true };
    if (start.id) byKey.set(start.id, e); byKey.set(urlId(start.url), e);
  }
  ok.forEach((p, k) => {
    for (const l of p.links) { const e = { url: l.url, anchor_text: l.text, listing_snippet: l.context, page: k + 1 }; if (!byKey.has(l.id)) byKey.set(l.id, e); if (!byKey.has(urlId(l.url))) byKey.set(urlId(l.url), e); }
  });
  const a = parseAnswer(r, { type: 'object', required: ['tender_links'], properties: {
    tender_links: { type: 'array', items: { type: 'string' }, maxItems: 300 }, list_url: { type: 'string', nullable: true } } }, null);
  out.ok = a.ok;
  if (!a.ok) { out.error = 'scout answer invalid: ' + a.errors.slice(0, 2).join('; ') + (a.raw ? ` ("${a.raw.slice(0, 80)}")` : ''); return out; }
  const lu = a.value.list_url && urlId(a.value.list_url);
  out.list_url = lu && opened.has(lu) ? ok.find(p => urlId(p.url) === lu).url : null;
  const seen = new Set(), cand = [];
  for (const x of a.value.tender_links) {
    const key = String(x).trim().replace(/^\[|\]$/g, '');
    const e = byKey.get(key) || byKey.get(urlId(key));
    if (!e) { out.invalid.push(key.slice(0, 80)); continue; }
    const u = urlId(e.url);
    if (seen.has(u)) continue; seen.add(u);
    cand.push({ e, u });
  }
  // the START page is ONE notice only when none of its own links was picked (a page whose links are tenders is a list)
  const startLinks = new Set(start ? start.links.map(l => urlId(l.url)) : []);
  const startIsNotice = cand.some(c => c.e.self_page) && !cand.some(c => startLinks.has(c.u));
  // list pages: navigated from, the list_url, and every page a picked link was FIRST shown on (so the LAST page read too). Not a
  // notice opened to check it: itself picked from an earlier page, its own picked links (a rectificatif) are tenders with it; unless
  // it is the NEXT PAGE or another page of a list already found (the agent picked "2" and read it). Any page / sort order of a list
  // and its NEXT PAGE are navigation: the agent picked "Aller à la page suivante", "3", "26", "20 avis suivants" as tenders. The
  // NEXT PAGE of a checked notice ("Suivant : <next notice>") is a tender
  const firstAt = new Map(cand.filter(c => !c.e.self_page).map(c => [c.u, c.e.page - 1])), shownOn = new Set(firstAt.values()), lists = [];
  ok.forEach((p, k) => {
    const ids = [p.url, p.asked].filter(Boolean).map(urlId);
    const checked = ids.some(u => firstAt.get(u) < k) && !lists.some(l => (l.next && ids.includes(urlId(l.next))) || listView(l.url) === listView(p.url));
    if ((shownOn.has(k) && !checked) || nav.has(urlId(p.url)) || (out.list_url && urlId(p.url) === urlId(out.list_url))) lists.push(p);
  });
  const views = new Set(lists.map(p => listView(p.url))), nexts = new Set(lists.filter(p => p.next).map(p => urlId(p.next)));
  for (const c of cand) {
    if (c.e.self_page ? !startIsNotice : views.has(listView(c.e.url)) || nexts.has(c.u)) { out.navigation_dropped++; continue; }
    out.picks.push(c.e);
  }
  return out;
};

//@snippet tryAll
// every item of a node, ALL its runs oldest first (the URL lane loops, so its nodes can run several times); [] if it never ran.
// Each item is tagged with `run`. Output 0 is named explicitly: n8n can only guess it for nodes connected to this one.
const tryAll = name => {
  const out = [];
  for (let r = 0; r < 50; r++) { let a; try { a = $(name).all(0, r); } catch { break; } for (const i of a) out.push({ json: i.json, binary: i.binary, run: r }); }
  return out;
};
