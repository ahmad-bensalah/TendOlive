// API2 - Map Records (API lane). API answers -> standard tender objects, driven ONLY by each source's `fields` map in Config.
// No LLM, no Firecrawl. When `fields.body` points to a structured notice (EU eForms / UBL as JSON, or BOAMP's legacy FNSimple /
// MAPA layout, e.g. BOAMP "donnees"), it is parsed for description, CPV, lots, award criteria, duration, value, the buyer's own
// contact block and national id, and (legacy) the selection text and a rectification's new deadline.
// Failed or empty calls become {_type:'source_error'} items (counted by Run Summary).
/*@lib INVIS fnv*/
const cfg = $('00 - Config').first().json;
const srcBy = Object.fromEntries(cfg.sources.map(s => [s.name, s]));

// ---------- helpers ----------
const decodeEntities = s => String(s ?? '')
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[e]));
const clean = s => decodeEntities(s).replace(/<[^>]+>/g, ' ').replace(INVIS, '').replace(/[\u00A0\u202F]/g, ' ').replace(/\s+/g, ' ').trim();
const uniq = a => [...new Set(a.filter(Boolean))];
const tokens = s => clean(s).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036F]/g, '').split(/[^\p{L}\p{N}]+/u).filter(t => t.length > 2);
const sim = (a, b) => { const A = new Set(tokens(a)), B = new Set(tokens(b)); if (!A.size || !B.size) return 0; let i = 0; A.forEach(t => B.has(t) && i++); return i / Math.min(A.size, B.size); };
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const get = (o, path) => String(path).split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
// multilingual object {fra: "...", eng: "..."} -> preferred language, else the first one
const pickLang = (v, prefs) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const keys = Object.keys(v);
  if (!keys.length || !keys.every(k => /^[a-z]{2,3}$/i.test(k))) return v;
  const k = (prefs || []).map(p => keys.find(x => x.toLowerCase() === String(p).toLowerCase())).find(Boolean) || keys[0];
  return v[k];
};
const asText = v => v == null ? '' : Array.isArray(v) ? uniq(v.map(asText)).join(', ') : typeof v === 'object' ? '' : clean(v);
const firstOf = v => (Array.isArray(v) ? v.find(x => x != null && x !== '') : v);
const field = (rec, src, name) => { const p = (src.fields || {})[name]; return p ? pickLang(get(rec, p), src.preferLanguages) : undefined; };
// ISO 3166 alpha-3 -> alpha-2 (TED and eForms use alpha-3); unknown codes pass through
const ISO3 = { FRA: 'FR', DEU: 'DE', BEL: 'BE', LUX: 'LU', NLD: 'NL', ITA: 'IT', ESP: 'ES', PRT: 'PT', AUT: 'AT', IRL: 'IE', DNK: 'DK', SWE: 'SE',
  FIN: 'FI', POL: 'PL', CZE: 'CZ', SVK: 'SK', SVN: 'SI', HRV: 'HR', HUN: 'HU', ROU: 'RO', BGR: 'BG', GRC: 'GR', CYP: 'CY', MLT: 'MT', EST: 'EE',
  LVA: 'LV', LTU: 'LT', NOR: 'NO', ISL: 'IS', LIE: 'LI', CHE: 'CH', GBR: 'GB', TUN: 'TN', MAR: 'MA', DZA: 'DZ', EGY: 'EG', SEN: 'SN', CIV: 'CI', USA: 'US', CAN: 'CA' };
const iso2 = c => { const s = String(c || '').trim().toUpperCase(); return ISO3[s] || s || null; };
const noticeTypeOf = (rec, src) => {
  for (const r of src.noticeTypes || []) if (Object.entries(r.when || {}).every(([f, re]) => new RegExp(re, 'i').test(asText(get(rec, f))))) return r.type;
  return 'open';
};

// ---------- structured notice body (eForms UBL as JSON; legacy French layout as fallback) ----------
// value of a JSON-from-XML node: "x" | {"#text":"x"} | {"_":"x"} | {"value":"x"} | [..]
const txt = v => {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return clean(v);
  if (Array.isArray(v)) return v.map(txt).filter(Boolean).join(' ');
  for (const k of ['#text', '_', '$', 'value', '#']) if (k in v) return txt(v[k]);
  return '';
};
function* walk(node, key = '') {   // [key without namespace, value]
  yield [key.replace(/^.*:/, ''), node];
  if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) {
    if (Array.isArray(v)) for (const x of v) yield* walk(x, k); else yield* walk(v, k);
  }
}
const collect = (root, keyRe, filter = () => true) => { const out = []; for (const [k, v] of walk(root)) if (keyRe.test(k)) { const t = txt(v); if (t && filter(t)) out.push(t); } return uniq(out); };
function* walkP(node, path = []) {  // [path of keys, leaf value]
  if (node && typeof node === 'object' && !Array.isArray(node) && !('#text' in node) && !('_' in node)) {
    for (const [k, v] of Object.entries(node)) {
      const key = k.replace(/^.*:/, '');
      if (Array.isArray(v)) for (const x of v) yield* walkP(x, [...path, key]); else yield* walkP(v, [...path, key]);
    }
  } else yield [path.join('/'), node];
}
const byPath = (root, re, notRe) => { const out = []; for (const [p, v] of walkP(root)) if (re.test(p) && !(notRe && notRe.test(p))) { const t = txt(v); if (t) out.push(t); } return uniq(out); };
function* walkN(node, path = '') {  // [path of keys, node] for EVERY node, objects included (an amount is an object: {valeur, @devise})
  yield [path, node];
  if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) { const p = `${path}/${k.replace(/^.*:/, '')}`; if (Array.isArray(v)) for (const x of v) yield* walkN(x, p); else yield* walkN(v, p); }
}
const NOT_OBJECT = /AppealTerms|RealizedLocation|DocumentReference|AwardingCriterion|Awarding|Justification|Financing|Guarantee/i;
const IN_LOT = /(^|\/)(lots?|LOTS_LOT)(\/|$)/i;   // legacy lot subtree: a lot's value / duration / description is never the notice's
const NAT_ID = /^\d[\d ]{7,}\d$/;                  // a national registration number as written ("25810007200044", "381 053 768 00028"), spaces dropped after
// the notice's own texts first, then a lot's text only when none of them already holds it: 26-101203 writes its 3 lots in its own
// description ("-lot 1 : Suivi des données ..."), which each lot text read again (then a 3rd time from the lots in body_text) only repeated
const withLots = (own, ofLots) => uniq([...own, ...ofLots.filter(t => !own.some(x => x.includes(t)))]);
// legacy amount: "x" | {valeur} | {fourchette: {valeurBasse, valeurHaute}}, with "@devise" -> "175000 EUR", "80000-215000 EUR"
const money = v => {
  if (v == null || v === '') return null;
  if (typeof v !== 'object') return txt(v) || null;
  const f = v.fourchette && typeof v.fourchette === 'object' ? v.fourchette : {}, lo = txt(f.valeurBasse), hi = txt(f.valeurHaute);
  const s = txt(v.valeur ?? v.VALEUR ?? v.MONTANT) || txt(v) || (lo && hi && lo !== hi ? `${lo}-${hi}` : hi || lo), cur = txt(v['@devise'] ?? v.devise ?? v.DEVISE);
  return s ? `${s}${cur ? ' ' + cur : ''}` : null;
};
const amounts = (root, notRe) => { const out = []; for (const [p, v] of walkN(root)) if (/(^|\/)(valeurEstimee|VALEUR_ESTIMEE|estimationValeur|VALEUR|MONTANT)$/i.test(p) && !(notRe && notRe.test(p))) { const m = money(v); if (m) out.push(m); } return uniq(out); };
// legacy award criteria written as text, one per line or ';' ("Prix - 30", "Prix : 40 %", "Valeur technique - sur 55 points. Le jugement ...",
// "Le critère unique du prix (100%)") -> "Prix (30)"; a line without a weight is no criterion. A number without a unit is a weight only
// at the end of its line or before punctuation, after a label that is no numbering: "Délai de livraison : 15 jours", "Valeur technique :
// 3 sous-critères" and "Article 4 - 2" are no weights
const CRIT = [/^(?:[-•*·]|\d{1,2}[.)])?\s*(\S.{0,80}?)\s*\(\s*(\d{1,3}(?:[.,]\d+)?)\s*(?:%|points?|pts?)\s*\)/i,
  /^(?:[-•*·]|\d{1,2}[.)])?\s*(\S.{0,80}?)(?:\s[-–—]\s*|\s*:\s*)(?:sur\s+|on\s+|out of\s+)?(\d{1,3}(?:[.,]\d+)?)\s*(?:%|points?|pts?)(?![\d\/.,]?\d)/i,
  /^(?:[-•*·]|\d{1,2}[.)])?\s*(\S.{0,80}?[^\d\s])(?:\s[-–—]\s*|\s*:\s*)(?:sur\s+|on\s+|out of\s+)?(\d{1,3}(?:[.,]\d+)?)\s*(?=$|[.;,()]|\s+[-–—\/|]\s)/i];
// a text that only points to the tender documents ("énoncé dans le Rc", "Voir article 4 du Règlement de Consultation.", "Renvoi au
// règlement de la consultation") holds no requirement: it never becomes a body_text section
const POINTER = /^(?=.*(?<!\p{L})(voir|cf|renvoi|se reporter|énoncée?s?|indiquée?s?|précisée?s?|définie?s?|mentionnée?s?|see|refer|as stated|set out)(?!\p{L}))(?=.*(?<!\p{L})(r[èe]glement|rc|dce|ccap|cctp|cahier|documents?)(?!\p{L}))/isu;
const pointerOnly = t => t.split(' ').length <= 8 && POINTER.test(t);
// a rectification's text names its new deadline ("Remise des offres reportées au 27 octobre 2026 à 12h00"); other changes (a visit, an address) do not.
// Other dated events of the same text (the opening of the bids, a site visit, the start of the work) are blanked first with their next
// words, so "Ouverture des plis le 28 octobre 2026" never passes as the deadline and "Suite à la visite du site la date limite ..." still does
const DEADLINE_WORDS = /offres?|remise|r[ée]ception|date limite|candidatures?|\bplis?\b|d[ée]p[ôo]t|\b(deadline|tenders?|submission|bids?)\b/i;
const OTHER_EVENTS = /(?<!\p{L})(ouverture|opening|visite?|d[ée]marrage|d[ée]but|commencement|start)(?:\s+[^\s,;]+){0,3}/giu;

function parseNoticeBody(raw, buyerName) {
  let d = raw;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return { warnings: ['notice body is not JSON'] }; } }
  if (!d || typeof d !== 'object') return { warnings: ['notice body empty'] };
  const r = { warnings: [] };
  if (byPath(d, /ProcurementProject\/(Name|Description)$/).length) {          // eForms (path-aware: appeal terms are NOT the description)
    const main = byPath(d, /(^|\/)(ContractNotice|PriorInformationNotice|ContractAwardNotice)\/ProcurementProject\/Description$/);
    const lotDesc = byPath(d, /ProcurementProjectLot\/ProcurementProject\/Description$/);
    const proc = byPath(d, /(^|\/)(ContractNotice|PriorInformationNotice)\/TenderingProcess\/Description$/);
    r.description = uniq([...withLots(main, lotDesc), ...proc]).join('\n\n').slice(0, 6000);
    r.cpv = uniq(byPath(d, /ProcurementProject\/(MainCommodityClassification|AdditionalCommodityClassification)\/ItemClassificationCode$/).flatMap(t => t.match(/\b\d{8}\b/g) || []));
    const dur = byPath(d, /ProcurementProject\/PlannedPeriod\/DurationMeasure$/)[0];
    let unit = ''; for (const [p, v] of walkP(d)) if (/PlannedPeriod\/DurationMeasure$/.test(p) && v && typeof v === 'object') { unit = v['@unitCode'] || v.unitCode || ''; break; }
    r.duration = dur ? `${dur}${unit ? ' ' + String(unit).toLowerCase() : ''}` : null;
    r.estimated_value = byPath(d, /EstimatedOverallContractAmount$/)[0] || null;
    const end = byPath(d, /TenderSubmissionDeadlinePeriod\/EndDate$/)[0];          // also present in change (rectification) notices
    r.deadline = end ? String(end).slice(0, 10) : null;
    r.submission_url = byPath(d, /(AccessToolsURI|EndpointID)$/, NOT_OBJECT).find(t => /^https?:\/\//i.test(t)) || null;
    r.lots = [];
    for (const [k, v] of walk(d)) if (k === 'ProcurementProjectLot' && v && typeof v === 'object' && !Array.isArray(v)) {
      const title = byPath(v, /^ProcurementProject\/Name$/)[0], desc = byPath(v, /^ProcurementProject\/Description$/)[0];
      if (title || desc) r.lots.push({ title: title || null, description: desc || null, estimated_value: byPath(v, /^ProcurementProject\/RequestedTenderTotal\/EstimatedOverallContractAmount$/)[0] || null });
    }
    // the buyer's national id: the CompanyID (PartyLegalEntity) of the organisation its ContractingParty points to ("ORG-0001"), never
    // another one's (an award notice lists its winners' SIRETs, CANON and LIXXBAIL in 26-100887; the review body and the eSender have
    // their own); several buyers or no link: the one named like the buyer. The field is free text: a SIRET (26-100890 Lille
    // "20009320100081", 26-100887 "381 053 768 00028") or the platform's own id (Avenue-Web "67188", "1759832-1-2-1", GUIDs), which
    // NAT_ID refuses (MK1 checks the SIREN's Luhn key too)
    const parties = byPath(d, /ContractingParty\/Party\/PartyIdentification\/ID$/), cos = [];
    for (const [k, v] of walk(d)) if (k === 'Company' && v && typeof v === 'object' && !Array.isArray(v))
      cos.push({ ref: byPath(v, /^PartyIdentification\/ID$/)[0], s: Math.max(0, ...byPath(v, /^PartyName\/Name$/).map(n => sim(n, buyerName))),
        id: byPath(v, /^PartyLegalEntity\/CompanyID$/).find(t => NAT_ID.test(t)) });
    const linked = cos.filter(c => c.ref && parties.includes(c.ref));
    const co = linked.length === 1 ? linked[0] : (linked.length ? linked : cos).filter(c => c.s >= 0.5).sort((a, b) => b.s - a.s)[0];
    r.national_id = co && co.id ? co.id.replace(/ /g, '') : null;
  } else {                                                                     // legacy layout: BOAMP FNSimple / MAPA (camelCase) or the older upper-snake one
    // MAPA's description is an object ({objet, lieuExecutionLivraison}); its main characteristics describe the contract too. A lot's
    // text (lots/lot/description) only after the notice's own and when they do not already hold it (withLots)
    const own = [], ofLots = [];
    for (const [p, v] of walkN(d)) if (/(^|\/)(OBJET_COMPLET|DESCRIPTION|OBJET_LOT|DESCRIPTION_LOT|description\/objet|caracteristiques\/principales)$/i.test(p)) {
      const t = txt(v); if (t) (IN_LOT.test(p) ? ofLots : own).push(t);
    }
    r.description = withLots(uniq(own).sort((a, b) => b.length - a.length), ofLots).slice(0, 4).join('\n\n');
    r.cpv = uniq([...collect(d, /^(CPV|CPV_PRINCIPAL|CODE_CPV|PRINCIPAL)$/i), ...byPath(d, /(^|\/)codeCPV\//i)].flatMap(t => t.match(/\b\d{8}\b/g) || []));   // FNSimple: codeCPV/objetPrincipal/classPrincipale
    // the notice's own duration (FNSimple dureeMois, MAPA duree/nbMois|nbJours), never a lot's nor the offers' validity (delais/validite/nbJours)
    const months = byPath(d, /(^|\/)(dureeMois|DUREE_MOIS|duree\/nbMois)$/i, IN_LOT)[0], days = byPath(d, /(^|\/)(dureeJours|duree\/nbJours)$/i, IN_LOT)[0];
    r.duration = months ? `${months} month` : days ? `${days} day` : collect(d, /^(DUREE_MARCHE|DUREE)$/i)[0] || null;   // same unit words as eForms
    // the notice's own estimate (natureMarche/valeurEstimee), never a lot's: 26-101212 = 80000 for 2 lots of 38000 + 42000 (each lot keeps its own)
    r.estimated_value = amounts(d, IN_LOT)[0] || null;
    r.submission_url = collect(d, /^(URL_DEPOT|URL_PROFIL_ACHETEUR|URL_DOCUMENT)$/i, t => /^https?:\/\//i.test(t))[0] || null;
    const end = byPath(d, /(^|\/)(dateReceptionOffres|delais\/receptionOffres|DATE_LIMITE_REPONSE|DATE_RECEPTION_OFFRES)$/i)[0];   // when the record has no deadline field
    r.deadline = end ? String(end).slice(0, 10) : null;
    r.lots = [];
    for (const [k, v] of walk(d)) if (/^(LOT|LOTS_LOT)$/i.test(k) && v && typeof v === 'object') {
      const title = collect(v, /^(INTITULE|TITRE|INTITULE_LOT)$/i)[0], desc = collect(v, /^(DESCRIPTION|DESCRIPTION_LOT)$/i)[0];
      if (title || desc) r.lots.push({ title: title || null, description: desc || null, estimated_value: amounts(v)[0] || null });
    }
    // the notice's selection text (FNSimple procedure/capacite*: references, team CVs, turnover) and additional information go to
    // body_text, labelled: the analysis quotes requirements from it ("3 principales références ... DSI au cours des cinq dernières années")
    r.sections = [];
    for (const [label, re] of [['Technical and professional capacity', /^(capaciteTech)$/i], ['Economic and financial capacity', /^(capaciteEcoFin)$/i],
      ['Professional suitability', /^(capaciteExercice)$/i], ['Additional information', /^(autresInformComplementaire|rensgComplt)$/i]])
      for (const t of collect(d, re)) if (t.split(' ').length >= 4 && !pointerOnly(t) && !r.sections.some(s => s.endsWith(': ' + t))) r.sections.push(`${label}: ${t}`);
    // a rectification without a structured new deadline: the sentences of its text about the offers' deadline that hold a year, passed
    // on as the raw new deadline (Clean reads the new date in it, never the old one or another event's)
    r.rectified_deadline = collect(d, /^(infosRectif|INFOS_RECTIF|TEXTE_RECTIF)$/i).flatMap(t => t.split(/(?<=[.;!?])\s+/))
      .filter(s => DEADLINE_WORDS.test(s.replace(OTHER_EVENTS, ' ')) && /(19|20)\d{2}/.test(s)).join(' ').slice(0, 300) || null;
  }
  // where the tender documents are (DCE: technical specifications, rules): the consultation page on the buyer's platform. The
  // notice itself is short; the requirements are in those files. A deep link (an id in it) beats the platform's home page.
  const docs = uniq([
    ...byPath(d, /CallForTendersDocumentReference\/Attachment\/ExternalReference\/URI$/), ...collect(d, /^(urlDocConsul|URL_DOCUMENT|URL_DCE)$/i),
    ...byPath(d, /BuyerProfileURI$/), ...collect(d, /^(urlProfilAcheteur|urlProfilAch|URL_PROFIL_ACHETEUR)$/i)]).filter(t => /^https?:\/\//i.test(t));
  const deep = u => { try { const x = new URL(u); return x.pathname.length > 1 || x.search.length > 1; } catch { return false; } };
  r.documents_url = docs.find(deep) || docs[0] || null;
  r.award_criteria = [];
  for (const [k, v] of walk(d)) if (/^(SubordinateAwardingCriterion|CRITERE|CRITERES)$/i.test(k) && v && typeof v === 'object') {
    const name = collect(v, /^(Description|Name|LIBELLE|CRITERE)$/i)[0], weight = collect(v, /^(ParameterNumeric|WeightNumeric|POIDS|PONDERATION)$/i)[0];
    if (name) r.award_criteria.push(weight ? `${name} (${weight})` : name);
  }
  for (const [k, v] of walk(d)) if (/^(criteresAttrib|CRITERES_ATTRIBUTION)$/i.test(k) && v != null && typeof v !== 'object') {   // FNSimple: one text
    let details = false;
    for (const line of String(v).split(/\n|;/).map(clean).filter(Boolean)) {
      const m = CRIT.map(re => line.match(re)).find(x => x && +x[2].replace(',', '.') <= 100);
      if (m) r.award_criteria.push(`${m[1]} (${m[2].replace(',', '.')})`);
      if (!m || line.length > m[0].length + 20) details = true;              // sub-criteria or no weight: the text itself goes to body_text
    }
    if (details && clean(v).split(' ').length >= 4 && !pointerOnly(clean(v))) (r.sections ||= []).push(`Award criteria as written: ${clean(v)}`);
  }
  r.award_criteria = uniq(r.award_criteria).slice(0, 15);
  // contact blocks: keep the organisation whose name matches the buyer (review bodies' contacts never leak in). A block counts its
  // best name: MAPA organisme holds a person (correspondantPRM/nom) before the buyer's name (acheteurPublic)
  const NAME_KEYS = /^(Name|NOM|DENOMINATION|NOM_?OFFICIEL|acheteurPublic|RegistrationName)$/i, best = v => Math.max(0, ...collect(v, NAME_KEYS).map(n => sim(n, buyerName)));
  const orgs = [];
  for (const [, v] of walk(d)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const emails = collect(v, /^(ElectronicMail|MEL|EMAIL|COURRIEL|adresseMailContact)$/i, t => EMAIL.test(t));
    if (emails.length > 1) continue;                                           // an aggregate (e.g. the root), not one organisation
    const email = emails[0] || collect(v, /^(nomContact)$/i, t => EMAIL.test(t))[0];   // FNSimple: the e-mail is sometimes written as the contact's name
    const phone = collect(v, /^(Telephone|TEL|TELEPHONE|telContact)$/i)[0];
    if (!email && !phone) continue;
    orgs.push({ name: collect(v, NAME_KEYS)[0] || '', s: best(v),
      email: email ? email.match(EMAIL)[0].toLowerCase() : null, phone: phone || null,
      // the buyer's own site only: BuyerProfileURI / URL_PROFIL_ACHETEUR point to the tender platform, never the buyer
      website: collect(v, /^(WebsiteURI|URL)$/i, t => /^(https?:\/\/|www\.)/i.test(t))[0] || null,
      address: uniq([collect(v, /^(StreetName|ADRESSE|nomvoie)$/i)[0], collect(v, /^(PostalZone|CP|CODE_POSTAL)$/i)[0], collect(v, /^(CityName|VILLE)$/i)[0]]).join(' ') || null });
  }
  const top = [...orgs].sort((a, b) => b.s - a.s)[0];
  if (top && (top.s >= 0.5 || orgs.length === 1)) { const { s, ...c } = top; r.contacts = c; }
  else { r.contacts = {}; if (orgs.length) r.warnings.push(`${orgs.length} contact blocks, none matches the buyer name`); }
  // the buyer's national registration number (FNSimple organisme/codeIdentificationNational: a SIRET or SIREN), digits only: from
  // the block holding it next to the buyer's name (or the only one); else eForms' (read above from the buyer's Company)
  const ids = [];
  for (const [, v] of walk(d)) if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, x] of Object.entries(v))
    if (/^(codeIdentificationNational|SIRET|SIREN)$/i.test(k.replace(/^.*:/, '')) && NAT_ID.test(txt(x))) ids.push({ id: txt(x).replace(/ /g, ''), s: best(v) });
  const nid = ids.sort((a, b) => b.s - a.s)[0];
  r.national_id = nid && (nid.s >= 0.5 || uniq(ids.map(x => x.id)).length === 1) ? nid.id : r.national_id || null;
  if (!r.description) r.warnings.push('no description in notice body');
  return r;
}

// ---------- main ----------
const out = [];
const err = (source, stage, error, extra = {}) => ({ json: { _type: 'source_error', source, stage, error: String(error).slice(0, 300), ...extra } });
const items = $input.all();
for (let i = 0; i < items.length; i++) {
  let req = {}; try { req = $('API1 - Build Requests').itemMatching(i).json; } catch {}
  const src = srcBy[req.source], r = items[i].json || {};
  if (!src) { out.push(err(req.source || '?', 'adapter', 'unknown source')); continue; }
  if (r.error) { out.push(err(src.name, 'fetch', `page ${req.page}: ${(r.error && (r.error.message || r.error.description)) || r.error}`)); continue; }
  const records = ['', '.', '$'].includes(src.records) ? [r] : get(r, src.records || 'results');   // '$': the answer is the list (n8n splits it)
  if (!Array.isArray(records)) { out.push(err(src.name, 'adapter', `page ${req.page}: no "${src.records || 'results'}" list in the answer (${Object.keys(r).slice(0, 6).join(', ')})`)); continue; }
  if (!records.length) { if (req.page === 1) out.push(err(src.name, 'fetch', '0 records (check the query / keywords)', { empty: true })); continue; }
  const strip = src.titleStrip ? new RegExp(src.titleStrip) : null;
  for (const rec of records) {
    try {
      const one = name => asText(firstOf(field(rec, src, name))) || null;
      const id = one('id');
      const raw = asText(field(rec, src, 'title')), title = (strip ? raw.replace(strip, '') : raw).trim() || raw;
      if (!id || !title) { out.push(err(src.name, 'adapter', `record without id or title (${id || '?'})`)); continue; }
      const buyerName = one('buyer') || '';
      const body = src.fields.body ? parseNoticeBody(get(rec, src.fields.body), buyerName) : { warnings: [] };
      const description = body.description || asText(field(rec, src, 'description'));
      const notice_type = noticeTypeOf(rec, src);
      const deadline = one('deadline') || body.deadline || null;
      const categories = [].concat(field(rec, src, 'categories') || []).map(asText).filter(Boolean);
      // award criteria: from the structured notice body, else a plain `award_criteria` field of the source ("Prix (40)")
      const lots = body.lots || [], criteria = (body.award_criteria || []).length ? body.award_criteria : [].concat(field(rec, src, 'award_criteria') || []).map(asText).filter(Boolean);
      const canonical_id = `${src.name}:${id}`;
      const c = body.contacts || {};
      // a lot in body_text: its title, and its text only when the description does not already hold it (eForms lists the lots' texts
      // in it, a legacy notice often in its own text): every lotted notice of the run of 2026-10-20 had each lot text 2 to 4 times
      const lotLine = l => [l.title, l.description && !description.includes(l.description) ? l.description : null].filter(Boolean).join(': ');
      out.push({ json: {
        tender_id: 'T' + fnv(canonical_id), canonical_id, source: src.name, source_type: 'api', external_id: id,
        source_url: one('url') || (src.urlTemplate ? src.urlTemplate.split('{id}').join(encodeURIComponent(id)) : req.url),
        title, description,
        body_text: uniq([title, description, ...lots.map(lotLine), criteria.length ? 'Award criteria: ' + criteria.join('; ') : '',
          ...(body.sections || []), categories.join(', ')]).join('\n\n').slice(0, 15000),
        buyer: { name: buyerName, country: iso2(one('country') || src.country), national_id: body.national_id || null,
          contacts: { email: c.email || one('email'), phone: c.phone || one('phone'), website: c.website || one('website'), address: c.address || one('address') } },
        publication_date: one('publication_date'),
        deadline: notice_type === 'rectification' ? null : deadline,
        rectified_deadline: notice_type === 'rectification' ? deadline || body.rectified_deadline || null : null,   // legacy: the new date only in the text
        place: asText(field(rec, src, 'place')) || null,
        cpv: uniq([...(body.cpv || []), ...[].concat(field(rec, src, 'cpv') || []).flatMap(x => String(x).match(/\b\d{8}\b/g) || [])]),
        estimated_value: body.estimated_value || one('estimated_value'), duration: body.duration || one('duration'), award_criteria: criteria,
        submission_url: body.submission_url || one('submission_url'), documents_url: body.documents_url || one('documents_url'), lots, market_type: asText(field(rec, src, 'market_type')) || null, categories,
        supersedes: [].concat(field(rec, src, 'supersedes') || []).map(String).filter(x => x && x !== id),
        notice_type, language: one('language') || src.language || null, currency: one('currency') || src.currency || null,
        date_order: src.dateOrder || 'dmy', flags: [],
        extraction: { method: 'api', warnings: body.warnings || [], low_input: !description },
      } });
    } catch (e) { out.push(err(src.name, 'adapter', e.message)); }
  }
}
return out;
