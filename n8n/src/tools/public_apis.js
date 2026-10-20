// Public APIs (Research Tools). Free public sources, no key. One compact line per result: "TAG | value | key=value | ...".
// "Parse Research" in the main workflow reads these lines, so keep the formats stable.
//   registry_search  (France)  recherche-entreprises.api.gouv.fr    REG | name | siren= | siret= | addr= | city= | nature= | public=yes|mixed|no | staff=BAND|unknown | staff_year= | ca=YEAR:EUR
//   boamp_history    (France)  BOAMP notices of a buyer (3 years)   BOAMP | idweb | date | nature | title | buyer= | winners=
//   decp_awards      (France)  DECP awarded contracts by SIREN      DECP | date | amount | title | cpv= | bids= | supplier_siret=
//   wikidata_lookup  (any)     Wikidata entity search              WD | label | description | id= | match=label|alias:text | country=FR[,..] | siren= | website= | employees= | revenue= | unit= | revenue_year=
//   similar_awards   (FR, EU, TN) awarded contracts of ANY buyer by CPV + title keywords, last 3 years (TED; DECP for France; TUNEPS for Tunisia)
//   buyer_awards     (FR, EU, TN) contracts THIS buyer awarded, last 3 years (TED by name; DECP by SIREN for France, else by name; TUNEPS by name for Tunisia)
//       both:  AWARD | id | date | amount= | cur= | buyer= | winners= | bids= | [others= (TUNEPS: losing bidders)] | cpv= | fw=yes|no|? | src=TED|DECP|TUNEPS | title=
//       ("Parse Market" in the main workflow reads these rows: keep the format stable; title stays last, it may contain "=")
/*@lib fnv*/
const T = $input.first().json;
const cut = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
// HTML entities in the sources' text are decoded (a DECP object "MISE A DISPOSITION D&#8217;UN OUTIL" reached the comparables as is,
// and its copy in TED, written with "’", never deduped against it). Twice: TED also double-encodes ("Cloud, Data &amp;amp; IA")
const ENT = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
const unent1 = s => s.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|(amp|quot|apos|lt|gt|nbsp));/gi, (m, d, h, e) => {
  if (e) return ENT[e.toLowerCase()]; const n = d ? Number(d) : parseInt(h, 16); return n > 0 && n <= 0x10FFFF ? String.fromCodePoint(n) : m; });
const unent = s => unent1(unent1(String(s == null ? '' : s)));
const cell = (s, n = 200) => cut(unent(s), n).replace(/\|/g, '/');
const get = (url, qs) => this.helpers.httpRequest({ method: 'GET', url, qs, json: true, timeout: 25000, headers: { 'User-Agent': 'RFP-Intelligence/1.0 (research agent)' } });
const claim = (c, p) => { const a = c && c[p]; const x = a && a.length ? a[a.length - 1] : null; return x ? { value: x.mainsnak && x.mainsnak.datavalue && x.mainsnak.datavalue.value, q: x.qualifiers || {} } : null; };
const yearOf = q => { const t = q && q.P585 && q.P585[0] && q.P585[0].datavalue && q.P585[0].datavalue.value && q.P585[0].datavalue.value.time; return t ? String(t).slice(1, 5) : ''; };
// ---- awarded contracts (Competitor & Budget Agent). TED search API v3, no key (verified 2026-10-19): award notices
// can-standard / can-social; amount = total-value, else the sum of the lot values; values <= 1000 are placeholders (dropped);
// frameworks report a ceiling (fw=yes); bids = "tenders received" (else "submitted electronically"), max over lots.
const ISO3 = { FR: 'FRA', BE: 'BEL', DE: 'DEU', ES: 'ESP', IT: 'ITA', NL: 'NLD', LU: 'LUX', PT: 'PRT', IE: 'IRL', AT: 'AUT', PL: 'POL', CZ: 'CZE', SK: 'SVK',
  HU: 'HUN', RO: 'ROU', BG: 'BGR', GR: 'GRC', HR: 'HRV', SI: 'SVN', SE: 'SWE', FI: 'FIN', DK: 'DNK', EE: 'EST', LV: 'LVA', LT: 'LTU', MT: 'MLT', CY: 'CYP',
  NO: 'NOR', IS: 'ISL', LI: 'LIE', CH: 'CHE', TN: 'TUN', MA: 'MAR', DZ: 'DZA' };
const langPick = v => { if (!v || typeof v !== 'object' || Array.isArray(v)) return v; for (const l of ['fra', 'eng', ...Object.keys(v)]) if (v[l] != null) return v[l]; return null; };
const nums = a => [].concat(a ?? []).map(Number).filter(n => Number.isFinite(n));
const tedAward = n => {
  const sum = a => { const x = nums(a); return x.length ? x.reduce((s, v) => s + v, 0) : null; };
  const tv = n['total-value'] != null && n['total-value'] !== '' ? Number(n['total-value']) : NaN;
  let amount = Number.isFinite(tv) && tv > 0 ? tv : sum(n['result-value-lot']) ?? sum(n['tender-value']);
  if (!(amount > 1000)) amount = null;
  const cur = [].concat(n['total-value-cur'] || n['result-value-cur-lot'] || n['tender-value-cur'] || [])[0] || 'EUR';
  const codes = [].concat(n['received-submissions-type-code'] || []), vals = [].concat(n['received-submissions-type-val'] || []);
  const bidsOf = code => Math.max(0, ...codes.map((c, i) => (c === code ? Number(vals[i]) || 0 : 0)));
  const bids = bidsOf('tenders') || bidsOf('t-esubm') || '';
  const winners = [...new Map([].concat(langPick(n['winner-name']) || []).map(w => [String(w).trim().toUpperCase().replace(/\s+/g, ' '), String(w).trim()])).values()];
  // a framework agreement reports its ceiling: flagged by any of these (framework-agreement-lot "fa-wo-rc" / "fa-w-rc" is the
  // reliable one: many frameworks say contract-framework-agreement = false, checked live 2026-10-19)
  const fw = /accord[- ]?cadre|framework agreement/i.test(String(langPick(n['title-proc']) || '')) || [].concat(n['contract-framework-agreement'] || []).some(x => x === true || x === 'true')
    || [].concat(n['framework-agreement-lot'] || []).some(x => x && x !== 'none') || !!n['framework-maximum-value-lot'] || !!n['framework-value-notice'];
  return ['AWARD', `T${n['publication-number']}`, String(n['publication-date'] || '').slice(0, 10), `amount=${amount ?? ''}`, `cur=${cur}`,
    `buyer=${cell([].concat(langPick(n['buyer-name']) || [])[0], 90)}`, `winners=${cell(winners.slice(0, 3).join('; '), 140)}`, `bids=${bids}`,
    `cpv=${[...new Set([].concat(n['classification-cpv'] || []))].slice(0, 3).join(',')}`, `fw=${fw ? 'yes' : 'no'}`, 'src=TED',
    `title=${cell(langPick(n['title-proc']) || langPick(n['notice-title']), 110)}`].join(' | ');
};
const TED_FIELDS = ['publication-number', 'publication-date', 'notice-title', 'title-proc', 'buyer-name', 'classification-cpv', 'total-value', 'total-value-cur',
  'result-value-lot', 'result-value-cur-lot', 'tender-value', 'tender-value-cur', 'framework-maximum-value-lot', 'contract-framework-agreement',
  'framework-agreement-lot', 'framework-value-notice', 'winner-name',
  'received-submissions-type-code', 'received-submissions-type-val'];
const tedSearch = async (clauses, limit) => {
  const query = ['notice-type IN (can-standard can-social)', ...clauses, 'publication-date>=today(-1095)'].join(' AND ') + ' SORT BY publication-date DESC';
  const r = await this.helpers.httpRequest({ method: 'POST', url: 'https://api.ted.europa.eu/v3/notices/search', json: true, timeout: 25000,
    body: { query, fields: TED_FIELDS, limit, page: 1, scope: 'ALL', paginationMode: 'PAGE_NUMBER' } });
  return { total: r.totalNoticeCount ?? 0, rows: (r.notices || []).map(tedAward) };
};
// France: consolidated DECP (data.gouv.fr tabular API, no key, updated daily; verified 2026-10-19). One row per contract x
// winner and per modification: original awards only (modification_id 0), rows grouped by contract uid (amount counted once),
// amounts flagged as anomalies dropped. A CPV prefix is a string range (no startswith), one keyword per call (no OR).
const DECP = 'https://tabular-api.data.gouv.fr/api/resources/22847056-61df-452d-837d-8b8ceadbfc52/data/';
const DECP_COLS = 'uid,dateNotification,acheteur_nom,objet,codeCPV,nature,techniques,montant,montant_anomalie,titulaire_id,titulaire_nom,offresRecues';
// a framework (amount = its ceiling): `techniques` (or `nature`) says Accord-cadre, unless the title is a call-off under it
// ("MS ...", "marché subséquent", "bon de commande": a real price). Checked live 2026-10-19: `nature` alone is always "Marché".
const decpFw = x => { const fw = /accord/i.test(`${x.techniques || ''} ${x.nature || ''}`) || /accord[- ]?cadre/i.test(x.objet || '');
  return fw ? (/^\s*MS\b|march[eé] subs[eé]quent|bons? de commande/i.test(x.objet || '') ? 'no' : 'yes') : (x.techniques || x.nature ? 'no' : '?'); };
const since3y = new Date(Date.now() - 3 * 365 * 864e5).toISOString().slice(0, 10);
const decpSearch = async filters => {
  const r = await get(DECP, { ...filters, modification_id__exact: 0, dateNotification__greater: since3y, dateNotification__sort: 'desc', page_size: 30, columns: DECP_COLS });
  const byUid = new Map();
  for (const x of r.data || []) {
    const g = byUid.get(x.uid) || { ...x, winners: [] };
    if (x.titulaire_nom && !g.winners.includes(x.titulaire_nom)) g.winners.push(String(x.titulaire_nom).replace(/\s*\(.*\)\s*$/, ''));
    byUid.set(x.uid, g);
  }
  const rows = [...byUid.values()].map(x => {
    const amount = !x.montant_anomalie && Number(x.montant) > 1000 ? Math.round(Number(x.montant)) : '';
    return ['AWARD', `D${fnv(x.uid)}`, String(x.dateNotification || '').slice(0, 10), `amount=${amount}`, 'cur=EUR', `buyer=${cell(x.acheteur_nom, 90)}`,
      `winners=${cell(x.winners.slice(0, 3).join('; '), 140)}`, `bids=${Number(x.offresRecues) > 0 ? Number(x.offresRecues) : ''}`, `cpv=${x.codeCPV || ''}`,
      `fw=${decpFw(x)}`, 'src=DECP', `title=${cell(x.objet, 110)}`].join(' | ');
  });
  return { total: (r.meta && r.meta.total) ?? rows.length, rows };
};
// Tunisia: TUNEPS, the national e-procurement system (www.tuneps.tn). Its public site reads a JSON backend with no key
// (verified 2026-10-19; undocumented, so it may change): tender search, then per tender the winners per lot (final amount in
// TND) and the number of offers. No CPV in Tunisia: search by words of the title or of the buyer name (literal, accents count).
const TUNEPS = 'https://www.tuneps.tn/api2/portail';
const PAGE = { pagination: { offSet: 0, limit: 50 }, listSort: [], dataSearch: [], listCol: [] };
const tunepsAwards = async (key, value, maxTenders) => {
  // tuneps.tn serves an incomplete certificate chain (browsers and Windows complete it, Node does not): the check is skipped
  // for these calls only. Public read-only data, no key or credential is sent; the risk is a tampered answer, not a leak.
  const post = (path, body) => this.helpers.httpRequest({ method: 'POST', url: TUNEPS + path, body, json: true, timeout: 20000, skipSslCertificateValidation: true });
  const s = await post('/bid/master/data', { pagination: { offSet: 0, limit: maxTenders }, sort: { nameCol: 'publicDt', direction: 'desc nulls last' },
    dataSearch: [{ key, value: String(value).replace(/['’"]/g, ' ').trim(), specificSearch: 'upper_like' }, { key: 'publicDt', value: since3y, specificSearch: '>' }] });
  const tenders = ((s.payload && s.payload.data) || []).slice(0, maxTenders), rows = [];
  for (const b of tenders) {
    const q = `?bidNo=${encodeURIComponent(b.bidNo)}&bidModSeq=${encodeURIComponent(b.bidModSeq || '00')}`;
    let wins = [];
    try { const w = await post('/bid/listWinners' + q, PAGE); wins = (w.payload && w.payload.data) || []; } catch { continue; }
    if (!wins.length) continue;                                                   // not awarded (yet), or unsuccessful
    let ranks = [];
    try { const r = await post('/ranking/rankLot/data' + q, PAGE); ranks = (r.payload && r.payload.data) || []; } catch {}
    const lots = new Map();
    for (const w of wins) {
      const k = String(w.bidCls || '1'), l = lots.get(k) || { winners: [], amount: 0, cur: w.bidPriceSuccCurr || 'TND', date: w.regDt };
      // the final amount is sometimes typed in millimes (134470000 for an offer of 134470 TND): beyond 50x the offer, the offer wins
      const succ = Number(w.bidPriceSucc) || 0, offer = Number(w.totalBidPriceCorr) || Number(w.bidPrice) || Number(w.totalBidPriceDcExch) || 0;
      if (w.bizRegNm && !l.winners.includes(w.bizRegNm)) l.winners.push(w.bizRegNm);
      l.amount += succ && offer && (succ / offer > 50 || offer / succ > 50) ? offer : succ || offer;
      lots.set(k, l);
    }
    for (const [lot, l] of lots) {
      const lr = ranks.filter(r => !r.bidCls || String(r.bidCls) === lot);
      const cnt = Math.max(0, ...lr.map(r => Number(r.cnt) || 0));
      // the other bidders of the lot: who competes, not only who wins (names only; their free-text evaluation notes are not kept)
      const others = [...new Set(lr.map(r => r.bizRegNm).filter(n => n && !l.winners.includes(n)))].slice(0, 4);
      const d = String(l.date || b.publicDt || ''), date = /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d.slice(0, 10);
      rows.push(['AWARD', `N${b.bidNo}-${lot}`, date, `amount=${l.amount > 1000 ? Math.round(l.amount) : ''}`, `cur=${l.cur}`, `buyer=${cell(b.bidInstNm, 90)}`,
        `winners=${cell(l.winners.slice(0, 3).join('; '), 140)}`, `bids=${cnt || ''}`, `others=${cell(others.join('; '), 140)}`, 'cpv=', 'fw=?', 'src=TUNEPS',
        `title=${cell(`${b.bidNmFr || ''}${lots.size > 1 ? ` (lot ${lot})` : ''}`, 110)}`].join(' | '));
    }
  }
  return { total: (s.payload && s.payload.total) ?? tenders.length, rows };
};
// the same contract is often in TED and in DECP: a row is a copy only when it comes from ANOTHER source with the same title
// (80 first characters) and the same amount (2 significant digits, magnitude kept). Lots and same-titled contracts stay.
// A row id already shown is the same row found by a second keyword (D3r75f1 under "maintenance" and "informatiques"): dropped
const dedupeAwards = rows => { const seen = new Map(), ids = new Set(); return rows.filter(l => {
  const id = l.split(' | ')[1]; if (ids.has(id)) return false; ids.add(id);
  const t = (l.match(/\| title=(.*)$/) || [])[1] || l, a = Number((l.match(/\| amount=(\d*)/) || [])[1]) || 0, src = (l.match(/\| src=(\w+)/) || [])[1] || '';
  const k = t.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80) + '|' + (a ? `${String(Math.round(a)).length}:${String(a).slice(0, 2)}` : '');
  const had = seen.get(k); if (had && had !== src) return false; if (!had) seen.set(k, src); return true; }); };
const phrases = s => String(s || '').split(/[,;\n]/).map(x => x.replace(/["\\()]/g, ' ').replace(/\s+/g, ' ').trim()).filter(x => x.length > 1).slice(0, 3);
const cpvCodes = s => [...new Set(String(s || '').split(/[,;\s]+/).map(x => x.replace(/\D/g, '')).filter(x => x.length >= 2 && x.length <= 8).map(x => x.padEnd(8, '0')))].slice(0, 4);
// a CPV prefix for DECP's string range: trailing zeros go, but never below 2 digits ("30000000" -> "30", not "3" = divisions 30-39)
const cpvPrefix = p => { const s = String(p || '').replace(/0+$/, ''); return p ? String(p).slice(0, Math.min(5, Math.max(2, s.length))) : ''; };
const nextPrefix = p => String(Number(p) + 1).padStart(p.length, '0');
// DECP "contains" is literal (apostrophes ' vs ’, accents, upper case without accents) and ignores case: send its longest plain
// word, never a generic one when the keyword has another ("agents LLM" searched "agents": payroll slips and housing for city staff
// became the comparables of an LLM tender). An acronym of 3 to 5 capitals ("LLM", "RAG", "SIRH") is the most specific word; a
// 2-letter one ("IA") only when nothing else is left. An acronym is a substring too ("RAG" in "maîtrise d'ouvrage"): only rows
// where it is a whole word are kept (decpWhole)
const GENERIC_W = /^(agents?|services?|prestations?|solutions?|outils?|gestion|mise|place|disposition|ensemble|relatifs?|relatives?|associ[eé]e?s?|divers|diverses|autres|nouveaux?|nouvelles?|g[eé]n[eé]rale?s?|supports?|travaux|fournitures?|march[eé]s?|accords?|cadres?)$/i;
const ACRO = /^[A-Z]{2,5}$/, NOT_ACRO = /^(LOT|LOTS|DE|DU|DES|LA|LE|LES|ET|EN|AU|AUX|UN|UNE|THE|AND|FOR|OF|TO|IN|ON|MS|HT|TTC|[IVX]{2,4})$/;
const decpWord = k => { const ws = String(k || '').split(/[\s'’,;:()/-]+/).filter(Boolean);
  // in an all-capitals keyword no word is an acronym, unless no word of 4+ letters is left: a keyword "CRM" or "SIG" alone
  // searched nothing (3 letters are below the plain-word floor)
  const acro = /\p{Ll}/u.test(String(k)) ? ws.filter(x => ACRO.test(x) && !NOT_ACRO.test(x)) : ws.some(x => x.length >= 4) ? [] : ws.filter(x => /^[A-Z]{3}$/.test(x) && !NOT_ACRO.test(x));
  const w = ws.filter(x => x.length >= 4 && !acro.includes(x)).sort((a, b) => (GENERIC_W.test(a) - GENERIC_W.test(b)) || (/[^\x00-\x7F]/.test(a) - /[^\x00-\x7F]/.test(b)) || b.length - a.length);
  const word = w[0] && ACRO.test(w[0]) ? w[0].toLowerCase() : w[0];   // a plain word in capitals is no acronym (decpWhole): same search, any case
  return acro.find(x => x.length >= 3) || (word && !GENERIC_W.test(word) ? word : acro[0] || word || ''); };
const decpWhole = (w, l) => !ACRO.test(w) || new RegExp(`(^|[^\\p{L}\\p{N}])${w}([^\\p{L}\\p{N}]|$)`, 'iu').test((l.match(/\| title=(.*)$/) || [])[1] || '');
// the words of a buyer name, upper case without accents as DECP writes them; a service in parentheses ("COMMUNE D'ANNECY (MAIRIE)",
// "... (SDET)") is left aside. The KIND of body stays a word: without it a city and its intercommunality are one word ("Ville de
// Nantes" = "NANTES METROPOLE"), so only articles go and the names of one kind are folded into one ("VILLE" / "MAIRIE" = "COMMUNE",
// "CC" = "COMMUNAUTE DE COMMUNES", "CONSEIL DEPARTEMENTAL" = "DEPARTEMENT")
const KIND_SAME = { VILLE: 'COMMUNE', MAIRIE: 'COMMUNE', CC: 'COMMUNAUTE COMMUNES', CA: 'COMMUNAUTE AGGLOMERATION', CU: 'COMMUNAUTE URBAINE', AGGLO: 'AGGLOMERATION' };
const buyerWords = s => [...new Set(String(s || '').replace(/\([^)]*\)/g, ' ').normalize('NFKD').replace(/\p{M}/gu, '').toUpperCase()
  .replace(/\bCONSEIL\s+(DEPARTEMENT|REGION)ALE?\b/g, '$1').split(/[^A-Z0-9]+/).flatMap(w => (KIND_SAME[w] || w).split(' ')).filter(w => w.length > 1 && !/^(DE|DU|DES|LA|LE|LES|EN|ET|AU|AUX|SUR)$/.test(w)))];
// ...and what kind of body it is (commune, syndicat...): never the DECP search word, which says WHICH body
const BODY_KIND = /^(COMMUNE|COMMUNES|DEPARTEMENT|DEPARTEMENTAL|DEPARTEMENTALE|REGION|REGIONAL|REGIONALE|COMMUNAUTE|AGGLOMERATION|URBAINE|METROPOLE|SYNDICAT|MIXTE|INTERCOMMUNAL|INTERCOMMUNALE|CENTRE|ETABLISSEMENT|PUBLIC|PUBLIQUE|OFFICE|SERVICE|DIRECTION|CONSEIL|AGENCE|NATIONAL|NATIONALE)$/;
// ...and among the other words the place comes before a common adjective: "Métropole européenne de Lille" searched "EUROPEENNE"
// (186 rows, of which only the newest 30 are read) rather than "LILLE"
const NAME_ADJ = /^(EUROPEEN|EUROPEENNE|FRANCAIS|FRANCAISE|GRAND|GRANDE|NOUVEAU|NOUVELLE|HAUT|HAUTE|HAUTS|HAUTES|BAS|BASSE|SAINT|SAINTE|GENERAL|GENERALE|TERRITORIAL|TERRITORIALE|SUPERIEUR|SUPERIEURE)$/;
const countryClause = c => { const iso = ISO3[String(c || '').trim().toUpperCase()] || (/^[A-Z]{3}$/i.test(String(c || '').trim()) ? String(c).trim().toUpperCase() : ''); return iso ? `buyer-country IN (${iso})` : ''; };
// size of ONE market tool result. The Competitor & Budget Agent may run on a model with an 8k-token context (Ollama numCtx 8192)
// shared by its prompt (~1.4k tokens), EVERY tool result of the study (about 2.35 characters a token for these rows) and its answer:
// 42 + 17 rows (16.4k characters) left ~90 tokens and the MEL study's answer was cut after 11 ids (run of 2026-10-20); past 8192
// Ollama drops the oldest messages instead (the task itself). One call shows at most about 18 rows / 5000 characters (similar_awards)
// or 14 / 3800 (buyer_awards), the newest DECP rows first, then TED: 3 calls still leave the answer room
const SIMILAR_ROWS = 18, SIMILAR_DECP = 12, SIMILAR_CHARS = 5000, BUYER_ROWS = 14, BUYER_DECP = 10, BUYER_CHARS = 3800;

// INSEE staff band codes (tranche_effectif_salarie) -> employees, the same map as Parse Research's: the raw code was read as a
// headcount ("staff=51" became "around 51 employees" for a 2000-4999 band, "staff=11" "11 employees"). NN / 00 / none = unknown
const STAFF = { '01': '1-2', '02': '3-5', '03': '6-9', 11: '10-19', 12: '20-49', 21: '50-99', 22: '100-199', 31: '200-249', 32: '250-499', 41: '500-999',
  42: '1000-1999', 51: '2000-4999', 52: '5000-9999', 53: '10000+' };
// Wikidata country (P17, an item) -> ISO code, so Parse Research can tell a namesake of another country ("ministère de l'Intérieur":
// the Czech one came first for the French buyer). Other countries: their own ISO code (P297), read once
const COUNTRY_Q = { Q142: 'FR', Q31: 'BE', Q183: 'DE', Q29: 'ES', Q38: 'IT', Q55: 'NL', Q32: 'LU', Q45: 'PT', Q27: 'IE', Q40: 'AT', Q36: 'PL', Q213: 'CZ',
  Q214: 'SK', Q28: 'HU', Q218: 'RO', Q219: 'BG', Q41: 'GR', Q224: 'HR', Q215: 'SI', Q34: 'SE', Q33: 'FI', Q35: 'DK', Q191: 'EE', Q211: 'LV', Q37: 'LT',
  Q233: 'MT', Q229: 'CY', Q20: 'NO', Q189: 'IS', Q347: 'LI', Q39: 'CH', Q948: 'TN', Q1028: 'MA', Q262: 'DZ', Q145: 'GB', Q30: 'US', Q16: 'CA', Q235: 'MC' };
const isoOf = async q => { if (COUNTRY_Q[q]) return COUNTRY_Q[q];
  try { const r = await get('https://www.wikidata.org/w/api.php', { action: 'wbgetclaims', entity: q, property: 'P297', format: 'json' }); const v = claim(r.claims || {}, 'P297');
    return v && typeof v.value === 'string' && /^[A-Z]{2}$/i.test(v.value) ? (COUNTRY_Q[q] = v.value.toUpperCase()) : ''; } catch { return ''; } };

let result = 'NO RESULTS';
try {
  if (T.tool === 'registry_search') {
    const q = cut(T.q, 200);
    if (q) {
      const r = await get('https://recherche-entreprises.api.gouv.fr/search', { q, per_page: 5, page: 1 });
      const rows = (r.results || []).slice(0, 5);
      if (rows.length) result = rows.map(c => {
        const s = c.siege || {}, f = c.finances || {}, y = Object.keys(f).sort().pop(), cp = c.complements || {};
        // public= also says what the legal form (INSEE catégorie juridique) says: 7xxx = public-law body, 41xx = public EPIC / régie,
        // 5515 / 5615 = SEM (société d'économie mixte, majority public capital, a company) -> "mixed". The registry's own flags miss
        // many: an ARS (7385) and a SEM (5515) came out "no", which the agent read as a private company
        const nj = String(c.nature_juridique || ''), pub = /^(7|41)/.test(nj) || cp.collectivite_territoriale || cp.est_service_public ? 'yes' : /^(5515|5615)$/.test(nj) ? 'mixed' : 'no';
        return ['REG', cell(c.nom_complet, 150), `siren=${c.siren || ''}`, `siret=${s.siret || ''}`, `addr=${cell(s.adresse || s.geo_adresse, 150)}`,
          `city=${cell(s.libelle_commune, 60)}`, `nature=${nj}`, `public=${pub}`,
          `staff=${STAFF[String(c.tranche_effectif_salarie || '').trim()] || 'unknown'}`, `staff_year=${c.annee_tranche_effectif_salarie || ''}`,
          y && f[y] && f[y].ca != null ? `ca=${y}:${f[y].ca}` : ''].filter(Boolean).join(' | ');
      }).join('\n');
    } else result = 'NO RESULTS (empty name)';
  } else if (T.tool === 'boamp_history') {
    // a phrase search needs every word in the published name: a registry name's acronym ("CITY'UP (CFTU)") or a notice name's
    // department ("City'up (972)") in parentheses is in only one of them, so parentheses go ("CITY'UP" finds "City'up (972)")
    const name = (cut(T.buyer_name, 200).replace(/\([^)]*\)/g, ' ').replace(/["\\()]/g, ' ').replace(/\s+/g, ' ').trim() || cut(T.buyer_name, 200).replace(/["\\()]/g, ' ').trim());
    const since = new Date(Date.now() - 3 * 365 * 864e5).toISOString().slice(0, 10);
    if (name) {
      // exact equality is unreliable on this dataset (accents / hyphens): phrase search here, exact name match done by Parse Research
      const r = await get('https://boamp-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/boamp/records', {
        where: `search(nomacheteur, "\\"${name}\\"") AND dateparution >= date'${since}'`, select: 'idweb,objet,nomacheteur,dateparution,nature,titulaire',
        limit: 20, order_by: 'dateparution DESC' });   // kept short: a small local model has an 8k-token context
      const rows = r.results || [];
      if (rows.length) result = `TOTAL ${r.total_count ?? rows.length}\n` + rows.map(x => ['BOAMP', x.idweb, String(x.dateparution || '').slice(0, 10), x.nature || '',
        cell(x.objet, 110), `buyer=${cell(x.nomacheteur, 100)}`, `winners=${/ATTRIBUTION/.test(x.nature || '') ? [...new Set([].concat(x.titulaire || []).map(w => cell(w, 60)))].slice(0, 6).join('; ') : ''}`].join(' | ')).join('\n');
    } else result = 'NO RESULTS (empty name)';
  } else if (T.tool === 'decp_awards') {
    const siren = String(T.siren || '').replace(/\D/g, '');
    if (siren.length !== 9) result = 'NO RESULTS (a 9-digit SIREN is required, from registry_search)';
    else {
      // acheteur_id is a 14-digit SIRET: prefix match with startswith() (verified 2026-10-19; like "<siren>%" returns 0)
      const r = await get('https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/decp-2022-marches-valides/records', {
        where: `startswith(acheteur_id, "${siren}")`, limit: 15, order_by: 'datenotification DESC' });
      const rows = r.results || [];
      if (rows.length) result = `TOTAL ${r.total_count ?? rows.length}\n` + rows.map(x => ['DECP', String(x.datenotification || '').slice(0, 10), x.montant ?? '', cell(x.objet, 110),
        `cpv=${x.codecpv || ''}`, `bids=${x.offresrecues ?? ''}`, `supplier_siret=${x.titulaire_id_1 && x.titulaire_id_1 !== 'CDL' ? x.titulaire_id_1 : ''}`].join(' | ')).join('\n');
    }
  } else if (T.tool === 'wikidata_lookup') {
    const q = cut(T.q, 200), hits = [];
    for (const lang of ['fr', 'en', 'ar']) {
      if (!q) break;
      const s = await get('https://www.wikidata.org/w/api.php', { action: 'wbsearchentities', search: q, language: lang, uselang: lang, type: 'item', limit: 3, format: 'json' });
      for (const h of s.search || []) if (!hits.some(x => x.id === h.id)) hits.push({ id: h.id, label: h.label || '', desc: h.description || '', match: h.match ? `${h.match.type}:${h.match.text}` : '' });
      if (hits.length) break;
    }
    const out = [];
    for (const h of hits.slice(0, 2)) {
      let extra = '';
      try {
        const e = await get(`https://www.wikidata.org/wiki/Special:EntityData/${h.id}.json`, {});
        const c = ((e.entities || {})[h.id] || {}).claims || {};
        const web = claim(c, 'P856'), emp = claim(c, 'P1128'), rev = claim(c, 'P2139'), siren = claim(c, 'P1616');
        // identity: every country (P17, deprecated values aside) and the French SIREN (P1616), checked by Parse Research
        const qs = [...new Set((c.P17 || []).filter(x => x.rank !== 'deprecated').map(x => x.mainsnak && x.mainsnak.datavalue && x.mainsnak.datavalue.value && x.mainsnak.datavalue.value.id).filter(Boolean))];
        const isos = [...new Set((await Promise.all(qs.slice(0, 4).map(isoOf))).filter(Boolean))];
        if (isos.length) extra += ` | country=${isos.join(',')}`;
        if (siren && /^\d{9}$/.test(String(siren.value || '').replace(/\s/g, ''))) extra += ` | siren=${String(siren.value).replace(/\s/g, '')}`;
        if (web && web.value) extra += ` | website=${web.value}`;
        if (emp && emp.value && emp.value.amount) extra += ` | employees=${String(emp.value.amount).replace('+', '')}${yearOf(emp.q) ? ` | employees_year=${yearOf(emp.q)}` : ''}`;
        if (rev && rev.value && rev.value.amount) extra += ` | revenue=${String(rev.value.amount).replace('+', '')} | unit=${String(rev.value.unit || '').split('/').pop()}${yearOf(rev.q) ? ` | revenue_year=${yearOf(rev.q)}` : ''}`;
      } catch {}
      out.push(`WD | ${cell(h.label, 120)} | ${cell(h.desc, 160)} | id=${h.id}${h.match ? ` | match=${cell(h.match, 120)}` : ''}${extra}`);
    }
    if (out.length) result = out.join('\n');
  } else if (T.tool === 'similar_awards' || T.tool === 'buyer_awards') {
    // FR / FRA / France and TN / TUN / Tunisia are the same country for every source
    const raw = String(T.country || '').trim().toUpperCase(), country = ({ FRA: 'FR', FRANCE: 'FR', TUN: 'TN', TUNISIA: 'TN', TUNISIE: 'TN' })[raw] || raw.slice(0, 2), cc = countryClause(country);
    const out = [], notes = [];
    if (T.tool === 'similar_awards') {
      const cpv = cpvCodes(T.cpv), kws = phrases(T.query);
      if (!cpv.length && !kws.length) result = 'NO RESULTS (give cpv and / or query)';
      else {
        const clauses = [cpv.length ? `classification-cpv IN (${cpv.join(' ')})` : '', kws.length ? `(${kws.map(k => `title-proc ~ ("${k}")`).join(' OR ')})` : '', cc].filter(Boolean);
        if (country === 'FR') {                              // DECP: every French contract above 40 kEUR, not only EU-threshold ones
          // one query per keyword, every keyword given (the API has no OR), on the first CPV; without keywords, one per CPV. The
          // newest rows come first: the TOTAL line says how many were found, so the agent knows when to narrow
          const words = [...new Set(kws.map(decpWord).filter(Boolean))], pres = (cpv.length ? cpv : ['']).slice(0, 2).map(cpvPrefix);
          let found = 0, failed = false;
          // about SIMILAR_DECP rows in all, whatever the number of queries (see SIMILAR_ROWS). A query already made is not made again
          // (cpv "72, 48482000": the widened "72" queries are the first pass's ones); a row a former keyword already showed is not
          // shown twice, and the cap counts new rows only
          const asked = new Set(), shown = new Set(), idOf = l => l.split(' | ')[1];
          const decpRun = async (all, how) => { const queries = all.filter(({ pre, w }) => !asked.has(`${pre}|${w}`) && asked.add(`${pre}|${w}`)); if (!queries.length) return;
            const cap = Math.max(4, Math.min(10, Math.floor(SIMILAR_DECP / queries.length))); for (const { pre, w } of queries) {
            const f = { ...(pre ? { codeCPV__greater: pre, codeCPV__strictly_less: nextPrefix(pre) } : {}), ...(w ? { objet__contains: w } : {}) };
            try { const d = await decpSearch(f), whole = d.rows.filter(l => decpWhole(w, l)), rows = whole.filter(l => !shown.has(idOf(l))).slice(0, cap); found += whole.length;
              notes.push(`DECP${how} ${d.total} found${pre ? ` (CPV ${pre}*` : ' ('}${w ? `${pre ? ', ' : ''}"${w}"` : ''})${whole.length < d.rows.length ? `, ${whole.length} of the newest ${d.rows.length} with the whole word` : ''}, newest ${rows.length} shown`);
              for (const l of rows) shown.add(idOf(l)); out.push(...rows); }
            catch (e) { failed = true; notes.push('DECP error: ' + cut(e.message, 100)); }
          } };
          await decpRun(words.length ? words.map(w => ({ pre: pres[0], w })) : pres.filter(Boolean).map(pre => ({ pre, w: '' })), '');
          // nothing under a CPV narrower than its division (72316000 + "tableau" found 0, the second CPV 48482000 never searched): once
          // more at the 2-digit division of EVERY given CPV, said in the TOTAL line, so "no data" never comes from one narrow query
          const divs = [...new Set(pres.filter(Boolean).map(p => p.slice(0, 2)))];
          if (!found && !failed && pres.some(p => p.length > 2)) await decpRun(words.length ? divs.flatMap(pre => words.slice(0, 2).map(w => ({ pre, w }))) : divs.map(pre => ({ pre, w: '' })), ' widened');
        }
        if (country === 'TN') {                              // TUNEPS has no CPV: title words only (accents count: try both spellings)
          if (!kws.length) notes.push('TUNEPS needs title keywords (query) for Tunisia');
          // every keyword is searched (the 3rd, often the most specific, was silently dropped); with 3, fewer tenders read per keyword
          for (const k of kws) {                             // TUNEPS stores a French AND an Arabic title: search the one in the keyword's script
            const key = /[\u0600-ۿ]/.test(k) ? 'bidNmAr' : 'bidNmFr';
            try { const n = await tunepsAwards(key, k, kws.length > 2 ? 5 : 8); notes.push(`TUNEPS ${n.total} tenders for "${k}"`); out.push(...n.rows); } catch (e) { notes.push('TUNEPS error: ' + cut(e.message, 100)); }
          }
        }
        // TED fills the call up to SIMILAR_ROWS (at least 5 rows: the EU-threshold contracts of other countries are only there)
        try { const t = await tedSearch(clauses, Math.max(5, SIMILAR_ROWS - out.length)); notes.push(`TED ${t.total} found`); out.push(...t.rows); } catch (e) { notes.push('TED error: ' + cut(e.message, 100)); }
      }
    } else {
      const name = cut(T.buyer_name, 150).replace(/["\\()]/g, ' ').replace(/\s+/g, ' ').trim(), siren = String(T.siren || '').replace(/\D/g, '');
      if (!name && siren.length !== 9) result = 'NO RESULTS (empty buyer_name)';
      else {
        if (siren.length === 9) {                            // a SIREN is the 9 first digits of the buyer's SIRET: string range
          const pre = cpvPrefix(cpvCodes(T.cpv)[0]), cpvF = pre ? { codeCPV__greater: pre, codeCPV__strictly_less: nextPrefix(pre) } : {};
          try { const d = await decpSearch({ acheteur_id__greater: siren, acheteur_id__strictly_less: String(Number(siren) + 1).padStart(9, '0'), ...cpvF }); notes.push(`DECP ${d.total} found`); out.push(...d.rows.slice(0, BUYER_DECP)); }
          catch (e) { notes.push('DECP error: ' + cut(e.message, 100)); }
        } else if (name && country === 'FR') {
          // no SIREN (buyer not researched): TED alone misses every contract under the EU thresholds, so DECP by buyer NAME, on its
          // longest word that is not a kind of body (DECP writes "EPCC METZ EN SCENES": upper case, no accents); only rows whose buyer
          // has the same words, its kind included (Dice >= 0.8, its service in parentheses aside), stay: "COMMUNE DE NANTES" is "Ville
          // de Nantes", "NANTES METROPOLE" is not
          const W = buyerWords(T.buyer_name), word = W.filter(w => !BODY_KIND.test(w)).sort((a, b) => (NAME_ADJ.test(a) - NAME_ADJ.test(b)) || b.length - a.length)[0];
          const pre = cpvPrefix(cpvCodes(T.cpv)[0]), cpvF = pre ? { codeCPV__greater: pre, codeCPV__strictly_less: nextPrefix(pre) } : {};
          if (word) try {
            const d = await decpSearch({ acheteur_nom__contains: word, ...cpvF });
            const mine = d.rows.filter(l => { const B = buyerWords((l.match(/\| buyer=([^|]*)/) || [])[1]); return 2 * W.filter(w => B.includes(w)).length / (W.length + B.length || 1) >= 0.8; });
            // only one page (the newest 30 rows) is read: said so, "among 186 found" read as every row checked
            notes.push(`DECP ${mine.length} of this buyer among ${d.total} found by buyer name "${word}"${d.total > 30 ? ' (only the newest 30 read)' : ''} (no SIREN)`); out.push(...mine.slice(0, BUYER_DECP));
          } catch (e) { notes.push('DECP error: ' + cut(e.message, 100)); }
        }
        if (name && country === 'TN') {
          try { const n = await tunepsAwards('bidInstNm', name, 10); notes.push(`TUNEPS ${n.total} tenders`); out.push(...n.rows); } catch (e) { notes.push('TUNEPS error: ' + cut(e.message, 100)); }
        }
        const cpvB = cpvCodes(T.cpv);
        if (name) try { const t = await tedSearch([`buyer-name ~ ("${name}")`, cpvB.length ? `classification-cpv IN (${cpvB.join(' ')})` : '', cc].filter(Boolean), Math.max(4, BUYER_ROWS - out.length)); notes.push(`TED ${t.total} found`); out.push(...t.rows); } catch (e) { notes.push('TED error: ' + cut(e.message, 100)); }
      }
    }
    // the size cap (SIMILAR_ROWS): rows past the character budget are left out, from the end (TED after DECP / TUNEPS), and said so
    const all = dedupeAwards(out), budget = T.tool === 'similar_awards' ? SIMILAR_CHARS : BUYER_CHARS;
    let size = 0; const rows = all.filter(l => (size += l.length + 1) <= budget);
    if (rows.length || notes.length) result = (country === 'TN' ? 'NOTE: Tunisia = TUNEPS awards (amounts in TND, one row per lot); no CPV there\n' : '')
      + `TOTAL ${notes.join(', ')} (showing ${rows.length}${rows.length < all.length ? ` of ${all.length}: the others left out to keep the answer short` : ''})\n` + (rows.join('\n') || 'NO RESULTS');
  } else result = `ERROR: unknown tool "${T.tool}"`;
} catch (e) { result = 'ERROR: ' + cut(e.message, 160); }
return [{ json: { result } }];
