// URL5 - Verify Extraction (URL lane). Extract-LLM fields -> standard tender object. Every field must be provable in the page:
// title / buyer / description by token overlap, dates by digit groups, phone by digits, email literally, website by host, CPV literally.
// Unprovable values are dropped (warning); no title, or no date AND no description (a category page) = rejected source_error.
/*@lib INVIS fold toks overlap fnv parseUrl hostOfUrl normUrl canonicalId parseAnswer*/
const cfg = $('00 - Config').first().json;
const srcBy = Object.fromEntries(cfg.sources.map(s => [s.name, s]));
const schema = { type: 'object', properties: {
  title: { type: 'string', nullable: true, maxLength: 400 }, buyer: { type: 'string', nullable: true, maxLength: 300 },
  description: { type: 'string', nullable: true, maxLength: 3000 },
  publication_date: { type: 'string', nullable: true }, deadline: { type: 'string', nullable: true },
  rectified_deadline: { type: 'string', nullable: true }, place: { type: 'string', nullable: true },
  cpv: { type: 'array', items: { type: 'string' } }, estimated_value: { type: 'string', nullable: true },
  contacts: { type: 'object', nullable: true, properties: {
    email: { type: 'string', nullable: true }, phone: { type: 'string', nullable: true },
    website: { type: 'string', nullable: true }, address: { type: 'string', nullable: true } } },
  notice_type: { type: 'string', enum: ['open', 'award', 'rectification', 'cancelled', 'other'], default: 'other' },
  language: { type: 'string', nullable: true, maxLength: 5 }, country: { type: 'string', nullable: true, maxLength: 3 } } };
const arabicDigits = s => String(s || '').replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 0x660));
const digits = s => arabicDigits(s).replace(/\D/g, '');
// the number groups of a copied date / value must appear TOGETHER in the text, in order (or reversed: 2026-11-15 vs 15/11/2026),
// as whole numbers with at most 20 non-digit characters between them ("15 novembre 2026" ok; 10 from "10h00" + 11 + 2026 no)
const groupsInText = (v, text) => {
  const groups = arabicDigits(String(v).replace(INVIS, '')).match(/\d+/g) || [];
  if (!groups.length) return false;
  const T = arabicDigits(String(text).replace(INVIS, ''));
  return [groups, [...groups].reverse()].some(g => new RegExp('(?<!\\d)' + g.join('\\D{1,20}') + '(?!\\d)').test(T));
};
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// a date is proven when its number groups are together in the page AND its words (the month) are in that same part of the page
// ("13 octobre 2026" against a page saying "13 novembre 2026" fails). A date the model cut ("November 9,", "٢٦ أكتوبر ٢") is
// completed from the page when the page has it with a year right after; otherwise it is dropped as incomplete.
const clean = s => arabicDigits(String(s || '').replace(INVIS, '')).replace(/\s+/g, ' ').trim();
// the page's markdown bold can cut a date ("**mardi 04 Aout 202** **6**"): the markers go and a year cut after its 3rd digit
// is joined ("Aout 202 6", "04/08/202 6" -> 2026, as Clean's parseDate does) in the page AND in the copied value, so the model's
// correct "mardi 04 Aout 2026" is proven, and so is a copy of the cut form
const joinYear = s => clean(String(s || '').replace(/\*\*|__/g, ' ')).replace(/(\p{L}\s+|\d{1,2}[\/.\-]\d{1,2}[\/.\-])((?:19|20)\d)\s+(\d)(?!\d)/gu, '$1$2$3');
const dateIn = (v, text) => {
  let val = joinYear(v).replace(/[\s,.;:\-\u2013/]+$/, '');
  const T = joinYear(text);
  if (!val) return null;
  let groups = val.match(/\d+/g) || [];
  if (!groups.length) return null;
  let completed = false;
  if (!groups.some(g => g.length === 4) && groups.length < 3) {                // no year: complete it from the page
    // a cut year goes ("26 أكتوبر 2" -> "26 أكتوبر"); a lone last number is the day and stays ("November 9")
    const stem = groups.length >= 2 ? val.replace(/\s*\d{1,3}$/, '').trim() || val : val;
    const m = T.match(new RegExp(escRe(stem) + '[^\\d]{0,25}?((?:19|20)\\d{2})(?!\\d)', 'i'));
    if (!m) return null;
    val = m[0]; groups = val.match(/\d+/g); completed = true;
  }
  for (const g of [groups, [...groups].reverse()]) {
    const m = T.match(new RegExp('(?<!\\d)' + g.join('\\D{1,20}') + '(?!\\d)'));
    if (!m) continue;
    const window = fold(T.slice(Math.max(0, m.index - 15), m.index + m[0].length + 15));
    // the words BETWEEN the date's numbers (the month); words after it ("à 12h00", "على الساعة العاشرة") are not part of the date
    const first = val.search(/\d/), lastM = [...val.matchAll(/\d+/g)].pop(), span = val.slice(first, lastM.index + lastM[0].length);
    const words = fold(span).split(' ').filter(w => w.length >= 3 && !/\d/.test(w) && !/^(le|du|de|the|of)$/.test(w));
    if (words.every(w => window.includes(w))) return { value: val, completed };
  }
  return null;
};
const DEADLINE_CUE = /(date limite|date et heure limite|limite de (remise|réception|dépôt)|deadline|closing date|clôture|آخر أجل|آخر موعد)\s*(de [^:]{0,40})?[:\s]*([^\n|]{6,40})/i;
// the notice's own form label beats the extract LLM's notice_type: an eForms result notice ("Type de formulaire: Résultats",
// "Type d’avis: Avis d’attribution de marché ou de concession", "Form type: Result", "Contract award notice") or a francemarches
// card whose type line is "Avis d'attribution" (in the page, or in the listing anchor "… Européen Avis d'attribution Services
// Procédure"; an open one says "AAPC") is an award: the LLM read the INNOP'IA award as open with the "Date de conclusion du
// marché" 02/09/2026 as its deadline, and Clean dropped it as expired instead of "award notice". A label is a field ("X: value")
// or a line of its own, never a word of a sentence nor of a list of other notices (domainetat's "### RESULTAT DE CONSULTATION
// N° 53/2021 …" under an open consultation, francemarches' "- AVIS DE MARCHÉ <title>"); a page that also carries a contract-notice
// label ("Type de formulaire: Mise en concurrence", "Avis de marché", "AAPC") is left to the LLM
const AWARD_LABEL = /Type de formulaire\s*:\s*R[ée]sultats?\b|Type d['’]avis\s*:\s*Avis d['’]attribution|Form type\s*:\s*Results?\b|^[ \t#*]*(?:Notice type\s*:\s*)?Contract (?:or concession )?award notice\b|^[ \t#*]*Avis d['’]attribution(?: de march[ée])?[ \t*]*$/im;
const OPEN_LABEL = /Type de formulaire\s*:\s*Mise en concurrence|Type d['’]avis\s*:\s*Avis de march[ée]|Form type\s*:\s*Competition\b|^[ \t#*]*(?:Notice type\s*:\s*)?Contract (?:or concession )?notice\b|^[ \t#*]*(?:Avis de march[ée]|AAPC|Avis d['’]appel public [àa] la concurrence)[ \t*]*$/im;
// the listing anchor: the card's type word (capitalised, a label: "Avis d'attribution", never "… des avis d'attribution"), or a
// title that starts as a result ("RESULTAT DE CONSULTATION N° 53/2021 …", "Résultat de l'appel d'offres …")
const AWARD_ANCHOR = /(?:^|\s)(?:Avis d['’]attribution|AVIS D['’]ATTRIBUTION)(?=[\s:|\-–—]|$)/, RESULT_ANCHOR = /^\s*(?:r[ée]sultats?\s+(?:de\s+(?:la\s+)?|d['’])(?:consultation|march[ée]|appel|attribution|l['’]appel)|contract (?:or concession )?award notice\b)/i;
const OPEN_ANCHOR = /(?:^|\s)(?:AAPC|Avis de march[ée]|AVIS DE MARCH[ÉE])(?=[\s:|\-–—]|$)/;
// notice-type labels are not part of a title ("AVIS RECTIFICATIF – Plateforme X" is the notice "Plateforme X"): stripped, kept in title_raw
const NOTICE_LABEL = /^\s*(avis\s+(rectificatif|modificatif|d[’']attribution)|rectificatif|modificatif|corrigendum|erratum|addendum|تعديل|إصلاح)\s*(n[°o]\s*\d+)?\s*[-:\u2013\u2014|]\s*|\s*[-:\u2013\u2014|(]\s*(avis\s+rectificatif|rectificatif|modificatif|corrigendum|erratum)\s*\)?\s*$/iu;
// the notice reference "N°:20/2026", "AO 08/2026", "عدد 05/2026" (Clean's same-reference dedupe uses it): a number/year AFTER a
// reference marker, so a dd/mm/yyyy date and a period "01/2026 à 12/2026" are not one
const refOf = s => { const m = arabicDigits(s).match(/(?:\bn\s?[°º]|\bno\.?|\bnum(?:[ée]ro)?|\br[ée]f(?:[ée]rence)?|\bao[ino]?|رقم|عدد)\s*[.:]?\s*(\d{1,5})\s*\/\s*((?:19|20)\d{2})(?![\d/])/i); return m ? `${+m[1]}/${m[2]}` : null; };
// words of a title that say its object: not the notice type ("Avis d'appel d'offres N°12/2026" says none), not a link word, not a number
const NOTICE_WORD = /^(avis|appel|appels|offre|offres|consultation|consultations|marche|marches|public|publics|publique|publiques|national|nationale|international|internationale|ouvert|restreint|ao|aoi|aon|aoo|tender|tenders|notice|invitation|call|bid|bids|rfp|rfq|no|ref|reference|numero|de|du|des|la|le|les|en|au|aux|pour|sur|of|the|for|and|et|اعلان|طلب|عروض|استشاره|صفقه|مناقصه|عدد|رقم)$/;
const objectWords = (s, not) => { const N = new Set(toks(not)); return toks(s).filter(t => !/^\d+$/.test(t) && !N.has(t) && !NOTICE_WORD.test(t.replace(/^(?:و?ال|لل)(?=..)/, ''))); };
const out = [];
const items = $input.all();
for (let i = 0; i < items.length; i++) {
  const base = $('URL4 - Build Extract Prompt').itemMatching(i).json;
  const src = srcBy[base.source] || { name: base.source };
  const text = base.text || '';
  const p = parseAnswer(items[i].json, schema, null);
  const reject = why => out.push({ json: { _type: 'source_error', source: src.name, stage: 'extract', url: base.url, error: `${base.url}: ${why}` } });
  if (!p.ok) { reject(`extraction invalid (${p.errors.slice(0, 2).join('; ')})`); continue; }
  const v = p.value, warnings = [], flags = [];
  // title: must come from the page; card labels learned by the scout ("read more") are stripped only when they are the
  // whole title or a leading / trailing segment (a category word inside a real title stays)
  const unlabel = s => (base.repeated_labels || []).reduce((t, l) => {
    const L = escRe(l);
    return t.replace(new RegExp(`^\\s*${L}\\s*[-:|\\u2013\\u2014]?\\s*|\\s*[-:|\\u2013\\u2014]?\\s*${L}\\s*$`, 'iu'), ' ');
  }, String(s || '')).replace(/\s+/g, ' ').trim();
  const titleRaw = unlabel(v.title);
  let title = titleRaw.replace(NOTICE_LABEL, ' ').replace(/\s+/g, ' ').trim() || titleRaw;
  if (overlap(title, text) < 0.8) {
    warnings.push('title_not_in_text');
    const alt = unlabel(base.anchor_text) || unlabel(base.page_title);
    if (overlap(alt, text) >= 0.6) title = alt;
    if (overlap(title, text) < 0.6) flags.push('title_unverified');
  }
  // the model cut the title to its reference ("Consultation N°28/2026" for "Consultation N°28/2026 auprès des centres ... « Les
  // fondamentaux de l'IA »") or wrote a body sentence without it ("Appel d'offre pour l'acquisition de Matériels informatiques" for
  // "Appel d'offres N°:20/2026 Matériels Réseaux"): the site's own title wins when it has the reference, real words and is in the
  // page (the page <title> without its " – site name" part, else the listing link text), and 2+ words of an object (not the notice
  // type nor the buyer: "Avis d'appel d'offres N°12/2026 – Ministère X" never replaces "Acquisition de 200 ordinateurs portables").
  // A complete title keeps the model's wording
  const own = [...String(base.page_title || '').split(/\s+[|–—]\s+/), base.anchor_text].map(s => unlabel(s).replace(NOTICE_LABEL, ' ').replace(/\s+/g, ' ').trim())
    .find(s => refOf(s) && objectWords(s, v.buyer).length >= 2 && overlap(s, text) >= 0.8
      && (!refOf(title) || (refOf(s) === refOf(title) && overlap(title, s) === 1 && toks(s).length > toks(title).length + 3)));
  if (own && own !== title) { warnings.push('title_from_site_title'); title = own; }
  let description = v.description || '';
  if (description && overlap(description, text) < 0.6) { warnings.push('description_not_in_text'); description = ''; }
  const buyer = v.buyer && overlap(v.buyer, text) >= 0.6 ? v.buyer : '';
  if (v.buyer && !buyer) warnings.push('buyer_not_in_text');
  const dates = {};
  for (const f of ['publication_date', 'deadline', 'rectified_deadline']) {
    const d = v[f] ? dateIn(v[f], text) : null;
    dates[f] = d ? d.value : null;
    if (d && d.completed) warnings.push(`${f}_completed_from_page`);
    if (v[f] && !dates[f]) warnings.push(`${f}_not_in_text_or_incomplete`);
  }
  // an award by its own label (AWARD_LABEL): notice_type award. Any award, by its label or by the extract LLM's own notice_type, has
  // no deadline (its dates are the award's: winner chosen, conclusion, sending): the LLM typed the RESAH result notice "award" itself
  // and kept "Date à laquelle le lauréat a été choisi: 19/08/2026" as its deadline, which Clean made its effective deadline and the
  // export wrote on the dropped "award notice" row (Clean drops every award, so no tender loses a date here)
  const anchor = String(base.anchor_text || '');
  const labelled = !['award', 'cancelled'].includes(v.notice_type) && (AWARD_LABEL.test(text) || AWARD_ANCHOR.test(anchor) || RESULT_ANCHOR.test(anchor)) && !OPEN_LABEL.test(text) && !OPEN_ANCHOR.test(anchor);
  const award = labelled || v.notice_type === 'award', dated = !!(dates.publication_date || dates.deadline || dates.rectified_deadline);   // its dates still make it a notice
  if (labelled) warnings.push('notice_type_from_page_label');
  if (award) {
    if (dates.deadline || dates.rectified_deadline) warnings.push('deadline_dropped_award_notice');
    dates.deadline = null; dates.rectified_deadline = null;
  }
  // still no deadline: the listing card often shows it ("Date limite : 15 novembre 2026"), and the listing is a page too
  if (!award && !dates.deadline && base.listing_snippet) {
    const m = String(base.listing_snippet).match(DEADLINE_CUE), d = m ? dateIn(m[4], base.listing_snippet) : null;
    if (d) { dates.deadline = d.value; flags.push('deadline_from_listing'); }
  }
  const low = fold(text), textDigits = digits(text), c = v.contacts || {};
  const site = c.website ? normUrl(c.website) : null;
  const contacts = {
    email: c.email && /@/.test(c.email) && String(text).toLowerCase().includes(c.email.trim().toLowerCase()) ? c.email.trim().toLowerCase() : null,
    phone: c.phone && digits(c.phone).length >= 6 && textDigits.includes(digits(c.phone)) ? c.phone.trim() : null,
    website: site && hostOfUrl(site) && low.includes(fold(hostOfUrl(site))) ? site : null,
    address: c.address && overlap(c.address, text) >= 0.7 ? c.address : null,
  };
  for (const k of Object.keys(contacts)) if (c[k] && !contacts[k]) warnings.push(`contact_${k}_dropped`);
  const cpv = [...new Set((v.cpv || []).flatMap(x => String(x).match(/\b\d{8}\b/g) || []).filter(x => text.includes(x)))];
  // a CPV or a value the page does not hold is dropped with a warning, like the buyer and the contacts (a "N/A" or "non précisé"
  // without a digit is no value: dropped silently)
  if ((v.cpv || []).some(x => /\d/.test(arabicDigits(x)) && !(String(x).match(/\b\d{8}\b/g) || []).some(c => cpv.includes(c)))) warnings.push('cpv_not_in_text');
  const estimated_value = v.estimated_value && groupsInText(v.estimated_value, text) ? v.estimated_value : null;
  if (v.estimated_value && !estimated_value && /\d/.test(arabicDigits(v.estimated_value))) warnings.push('estimated_value_not_in_text');
  if (!title) { reject('no title'); continue; }
  if (!dated && !dates.deadline && !description && toks(text).length > 30) { reject('not a notice (no date, no description)'); continue; }
  const canonical_id = canonicalId(cfg, base.url);
  out.push({ json: {
    tender_id: 'T' + fnv(canonical_id), canonical_id, source: src.name, source_type: 'url', source_url: base.url, external_id: null,
    title, title_raw: titleRaw !== title ? titleRaw : undefined, description, body_text: text.slice(0, 15000),
    buyer: { name: buyer, country: (/^[A-Za-z]{2}$/.test(v.country || '') ? v.country.toUpperCase() : null) || src.country || null, contacts },
    publication_date: dates.publication_date, deadline: dates.deadline, rectified_deadline: dates.rectified_deadline,
    place: v.place && overlap(v.place, text) >= 0.6 ? v.place : null,
    cpv, estimated_value,
    duration: null, award_criteria: [], submission_url: null, documents_url: null, lots: [], market_type: null, categories: [], supersedes: [],
    notice_type: award ? 'award' : v.notice_type === 'other' && titleRaw !== title && /rectif|modif|corrig|errat|addend|تعديل|إصلاح/i.test(titleRaw) ? 'rectification' : v.notice_type, language: v.language || src.language || null, currency: src.currency || null, date_order: src.dateOrder || 'dmy',
    listing: { anchor_text: base.anchor_text, snippet: base.listing_snippet, page: base.page, self_page: !!base.self_page },
    flags, extraction: { method: 'llm', warnings, low_input: toks(text).length < 40 },
  } });
}
return out;
