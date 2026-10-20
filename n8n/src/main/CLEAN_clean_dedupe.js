// Clean & Dedupe (pure code, every source). Rules here are FACTS, not opinions: dates -> ISO (French / English / Arabic months,
// Arabic-Indic digits, invisible characters), rectifications and superseded notices, awards / cancellations, expiry, obvious
// non-fit API records (an exclusion word and none of the company keywords), duplicates across sources (canonical id, then
// title + buyer with Unicode keys), relaunches, known keys from previous runs, buyer groups.
// Nothing is deleted silently: dropped tenders keep `drop_reason` and are counted in Run Summary.
/*@lib INVIS fnv nameSim*/
const cfg = $('00 - Config').first().json;
const today = cfg.today;
const known = new Set((() => { try { return $('02 - Collect Known IDs').first().json.keys || []; } catch { return []; } })());
const pairDeadlines = (() => { try { return $('02 - Collect Known IDs').first().json.pair_deadlines || {}; } catch { return {}; } })();   // pair_key -> exported ISO deadlines

// ---------- dates ----------
const MONTHS = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
  janv: 1, fevr: 2, fev: 2, avr: 4, juil: 7, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9,
  'يناير': 1, 'جانفي': 1, 'فبراير': 2, 'فيفري': 2, 'مارس': 3, 'أبريل': 4, 'ابريل': 4, 'أفريل': 4, 'افريل': 4,
  'مايو': 5, 'ماي': 5, 'يونيو': 6, 'جوان': 6, 'يوليو': 7, 'جويلية': 7, 'يوليوز': 7, 'أغسطس': 8, 'اغسطس': 8, 'أوت': 8, 'غشت': 8,
  'سبتمبر': 9, 'شتنبر': 9, 'أكتوبر': 10, 'اكتوبر': 10, 'نوفمبر': 11, 'نونبر': 11, 'ديسمبر': 12, 'دجنبر': 12,
  'كانون الثاني': 1, 'شباط': 2, 'آذار': 3, 'نيسان': 4, 'أيار': 5, 'حزيران': 6, 'تموز': 7, 'آب': 8, 'أيلول': 9,
  'تشرين الأول': 10, 'تشرين الثاني': 11, 'كانون الأول': 12,
};
const stripMarks = s => s.normalize('NFKD').replace(/[\u0300-\u036F]/g, '').normalize('NFC');
// month names of any other language come from Intl (es, de, it, pt, nl, ...), added to the table above once per language
const intlMonths = lang => { const o = {}; try { for (const style of ['long', 'short']) { const f = new Intl.DateTimeFormat(lang, { month: style, timeZone: 'UTC' });
  for (let m = 0; m < 12; m++) { const k = f.format(new Date(Date.UTC(2026, m, 15))).toLowerCase().replace(/\.$/, ''); if (k.length > 2 && !/\d/.test(k)) o[k] = m + 1; } } } catch {} return o; };
const langs = [...new Set($input.all().map(i => String(i.json.language || '').slice(0, 2).toLowerCase()).filter(l => /^[a-z]{2}$/.test(l) && !['fr', 'en', 'ar'].includes(l)))];
for (const l of langs) for (const [k, m] of Object.entries(intlMonths(l))) if (!(k in MONTHS)) MONTHS[k] = m;
const monthKeys = Object.keys(MONTHS).map(k => [stripMarks(k), MONTHS[k]]).sort((a, b) => b[0].length - a[0].length);
const pad = n => String(n).padStart(2, '0');
const iso = (y, m, d) => { const dt = new Date(Date.UTC(y, m - 1, d)); return y > 1990 && y < 2100 && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null; };
const normDate = raw => stripMarks(String(raw).replace(INVIS, '').replace(/[\u00A0\u202F\u2007]/g, ' ')
    .replace(/[٠-٩]/g, c => c.charCodeAt(0) - 0x660).replace(/[۰-۹]/g, c => c.charCodeAt(0) - 0x6F0).toLowerCase())
    .replace(/(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{3})\s+(\d)(?!\d)/g, '$1$2').replace(/(\p{L}\s+\d{3})\s+(\d)(?!\d)/gu, '$1$2')   // year written "202 6"
    .replace(/\s+/g, ' ').trim();
function parseDate(raw, order = 'dmy') {
  if (raw == null || raw === '') return { value: null, unreadable: false };
  const s = normDate(raw);
  let m;
  if ((m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/))) { const v = iso(+m[1], +m[2], +m[3]); return { value: v, unreadable: !v }; }
  if ((m = s.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})/))) { const v = order === 'mdy' ? iso(+m[3], +m[1], +m[2]) : iso(+m[3], +m[2], +m[1]); return { value: v, unreadable: !v }; }
  for (const [k, month] of monthKeys) {                       // "12 mars 2026" / "12 مارس 2026" / "March 12, 2026"
    const i = s.indexOf(k);
    if (i < 0) continue;
    const before = s.slice(0, i), after = s.slice(i + k.length);
    if (/[a-z]$/.test(before) || /^[a-z]/.test(after)) continue;   // part of a longer word
    const d1 = before.match(/(\d{1,2})(?:st|nd|rd|th|er|\.)?\s*(?:de\s+)?$/), y1 = after.match(/^\.?,?\s*(?:de\s+)?(\d{4})/);   // "15. Oktober 2026", "15 de noviembre de 2026"
    if (d1 && y1) { const v = iso(+y1[1], month, +d1[1]); if (v) return { value: v, unreadable: false }; }
    const d2 = after.match(/^\.?\s*(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})/);
    if (d2) { const v = iso(+d2[2], month, +d2[1]); if (v) return { value: v, unreadable: false }; }
  }
  return { value: null, unreadable: true };
}
// a rectification's text may give the old date, the new one and other events' ("initialement fixée au 20 octobre 2026, reportée au 27
// octobre 2026", "avancée au 25 octobre 2026 au lieu du 30 octobre 2026", "reportée du 20/10/2026 au 27/10/2026", "... Ouverture des plis le
// 28 octobre 2026", "date de démarrage : 1er janvier 2027"): its new deadline is the first full date whose own clause does not mark it as the
// old one ("du X au Y": X) or another event's (the end of a range "visite du X au Y" too). Neither the latest date nor, when every date is
// such one, the old date: then no readable new deadline
const DATE_IN_TEXT = /\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{4}|\d{1,2}(?:er|st|nd|rd|th)?\.?\s+(?:de\s+)?\p{L}+(?:\s\p{L}+)?\.?,?\s+(?:de\s+)?\d{4}|\p{L}+\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}/gu;
const OLD_CUE = /(?<!\p{L})(initial(e|es|ement|ly)?|inicial(es|mente)?|inizial(e|i|mente)|au lieu d(e|u|es)?|instead of|en (lugar|vez) de|invece d(i|el|ella)?|anziche|(an)?statt|precedemment|precedente?s?|previously|anterior(es|mente)?|ancien(ne)?|originally|ursprunglich(e|en)?|بدلا?)(?!\p{L})/iu;
const OTHER_CUE = /(?<!\p{L})(ouverture|opening|visite?|demarrage|debut|commencement|start|apertura|offnung|فتح)/iu;
const RANGE_TO = /^\s*(a\s+\S+\s*)?(au|to|al|auf|bis|et|and|->|→|-|–)\s*(le\s+)?$/u;   // dates are normalised: "à 12h00 au" -> "a 12h00 au"
const parseNewDeadline = (raw, order) => {
  const s = normDate(raw ?? ''), ds = [...s.matchAll(DATE_IN_TEXT)].map(m => ({ i: m.index, end: m.index + m[0].length, v: parseDate(m[0], order).value })).filter(d => d.v);
  if (!ds.length) return parseDate(raw, order);
  let prevOther = false;
  for (const [k, d] of ds.entries()) {
    const clause = s.slice(k ? ds[k - 1].end : 0, d.i).split(/[.;,!?](?:\s|$)/).pop().slice(-50), next = ds[k + 1];
    const other = OTHER_CUE.test(clause) || (prevOther && RANGE_TO.test(clause)); prevOther = other;
    const from = next && /(?<!\p{L})(du|from|del|vom|von)\s+(le\s+)?$/u.test(clause) && RANGE_TO.test(s.slice(d.end, next.i));
    if (!other && !from && !OLD_CUE.test(clause)) return { value: d.v, unreadable: false };
  }
  return { value: null, unreadable: true };
};
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

// ---------- keys (all scripts kept: Arabic titles never collapse into one key) ----------
const normKey = s => String(s || '').replace(INVIS, '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036F\u064B-\u065F\u0670ـ]/g, '')
  .replace(/[آأإ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
  .split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ');
const titleKey = t => { const k = normKey(t.title); return k.length < 15 || k.split(' ').length < 3 ? `url:${t.source_url}` : k; };
const has = (text, term) => new RegExp(`(^|[^\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u').test(text);
const kws = (cfg.company.keywords || []).map(normKey).filter(Boolean), excl = (cfg.company.exclusions || []).map(normKey).filter(Boolean);

// ---------- pass 1: normalise ----------
const all = $input.all().map(i => i.json);
const passthrough = all.filter(t => t._type);                 // source errors + run marker
const ts = all.filter(t => !t._type && t.title);
for (const t of ts) {
  t.flags = t.flags || [];
  for (const f of ['publication_date', 'deadline', 'rectified_deadline']) {
    const raw = t[f], p = (f === 'rectified_deadline' ? parseNewDeadline : parseDate)(raw, t.date_order);
    if (raw && p.unreadable) t.flags.push(`${f}_unreadable:${String(raw).slice(0, 40)}`);
    t[`${f}_raw`] = raw ?? null; t[f] = p.value;
  }
  t.title_key = titleKey(t);
  t.buyer_key = normKey(t.buyer && t.buyer.name) || `unknown:${t.tender_id}`;   // unknown buyers are never grouped together
  t.pair_key = `${t.title_key}|${t.buyer_key}`;
  if (t.source_type === 'api' && excl.length) {                // broad pre-filter, API records only (a URL source is the user's own choice)
    const text = normKey(`${t.title} ${t.market_type || ''} ${(t.categories || []).join(' ')} ${t.body_text || ''}`);
    const ex = excl.find(k => has(text, k));
    if (ex && !kws.some(k => has(text, k))) t.drop_reason = `prefilter: "${ex}" and no company keyword`;
  }
}

// ---------- pass 2: superseded notices and rectifications ----------
const byExt = new Map(ts.filter(t => t.external_id).map(t => [`${t.source}|${t.external_id}`, t]));
const byPair = {}; for (const t of ts) (byPair[t.pair_key] ||= []).push(t);
// oldest rectification first, so the newest new deadline wins; originals are taken from the input types (never from a
// rectification promoted below)
const rects = ts.filter(t => t.notice_type === 'rectification').sort((a, b) => (a.publication_date || '').localeCompare(b.publication_date || ''));
const isOriginal = o => !['rectification', 'award', 'cancelled'].includes(o.notice_type) && !o.flags.includes('rectification_without_original');
for (const r of rects) {
  const linked = (r.supersedes || []).map(id => byExt.get(`${r.source}|${id}`)).filter(Boolean);
  const originals = (linked.length ? linked : byPair[r.pair_key] || []).filter(o => o !== r && isOriginal(o));
  if (originals.length) {
    for (const o of originals) if (r.rectified_deadline) { o.rectified_deadline = r.rectified_deadline; o.flags.push(`deadline_rectified_by:${r.canonical_id}`); }
    r.drop_reason ||= `rectification merged into ${originals[0].canonical_id}`;
  } else if (r.rectified_deadline || r.deadline || r.flags.some(f => /^(rectified_)?deadline_unreadable/.test(f))) {   // the rectification is the tender
    r.notice_type = 'open'; r.flags.push('rectification_without_original');      // (a new deadline it states but no one can read: kept, deadline_unknown_kept)
  } else r.drop_reason = 'rectification without its original nor a new deadline';                                         // nothing to evaluate
}
for (const t of ts.filter(t => (t.supersedes || []).length && t.notice_type !== 'rectification')) {   // a newer version replaces older ones
  for (const id of t.supersedes) {
    const o = byExt.get(`${t.source}|${id}`);
    if (o && o !== t && !o.drop_reason && o.title_key === t.title_key && (o.publication_date || '') <= (t.publication_date || '')) o.drop_reason = `superseded by ${t.canonical_id}`;
  }
}

// ---------- pass 3: awards, cancellations, expiry ----------
for (const t of ts) {
  if (t.drop_reason) continue;
  // an award notice has no bid deadline: a date it carries is the award or the contract's (dropped row of the export, never a deadline)
  t.effective_deadline = t.notice_type === 'award' ? null : t.rectified_deadline || t.deadline || null;
  if (t.notice_type === 'award') { t.drop_reason = 'award notice'; continue; }
  if (t.notice_type === 'cancelled') { t.drop_reason = 'cancelled notice'; continue; }
  if (t.notice_type === 'other') t.flags.push('notice_type_other');
  if (t.effective_deadline) {
    if (t.effective_deadline < today) t.drop_reason = `expired (deadline ${t.effective_deadline})`;
    else t.days_left = daysBetween(today, t.effective_deadline);
  } else if (t.flags.some(f => /^(rectified_)?deadline_unreadable/.test(f))) t.flags.push('deadline_unknown_kept');
  else if (t.publication_date && daysBetween(t.publication_date, today) > cfg.limits.staleNoDeadlineDays) t.drop_reason = `expired (no deadline, published ${t.publication_date})`;
  else t.flags.push('no_deadline');
}

// ---------- pass 3b: same reference number + same buyer = same notice ----------
// e.g. "Consultation N°28/2026" reached twice on a site (a category page and the post itself): the copy without a deadline
// takes its twin's fate (duplicate of a kept one, or expired with it). A number is a reference only after its marker (n°, no, num,
// réf, AO, رقم, عدد: URL5's refOf): a period "01/2026 à 12/2026" in two titles of one buyer is no shared reference
const refOf = t => { const m = String(t.title || '').replace(/[٠-٩]/g, c => c.charCodeAt(0) - 0x660).match(/(?:\bn\s?[°º]|\bno\.?|\bnum(?:[ée]ro)?|\br[ée]f(?:[ée]rence)?|\bao[ino]?|رقم|عدد)\s*[.:]?\s*(\d{1,5})\s*\/\s*((?:19|20)\d{2})(?![\d/])/i); return m ? `${+m[1]}/${m[2]}` : null; };
const sameBuyer = (a, b) => !(a.buyer && a.buyer.name) || !(b.buyer && b.buyer.name) || nameSim(a.buyer.name, b.buyer.name) >= 0.8;
const byRef = {};
for (const t of ts) { t.reference = refOf(t); if (t.reference) (byRef[t.reference] ||= []).push(t); }
for (const group of Object.values(byRef)) {
  if (group.length < 2) continue;
  for (const t of group.filter(x => !x.effective_deadline && !x.drop_reason)) {
    const twin = group.find(o => o !== t && o.effective_deadline && sameBuyer(o, t));
    if (!twin) continue;
    t.flags.push(`same_reference_as:${twin.tender_id}`);
    t.drop_reason = twin.drop_reason ? `duplicate of ${twin.tender_id} (${twin.drop_reason})` : `duplicate of ${twin.tender_id} (same reference ${t.reference})`;
  }
}

// ---------- pass 4: duplicates (canonical id, then title + buyer), relaunches, previous runs ----------
const richness = t => (t.body_text || '').length + (t.source_type === 'api' ? 1e6 : 0);
const seen = new Map();
for (const t of ts.filter(t => !t.drop_reason).sort((a, b) => richness(b) - richness(a))) {
  const dupe = seen.get(`c:${t.canonical_id}`) || seen.get(`p:${t.pair_key}`);
  if (dupe) {
    const sameDeadline = !dupe.effective_deadline || !t.effective_deadline || dupe.effective_deadline === t.effective_deadline;
    if (dupe.canonical_id === t.canonical_id || sameDeadline) {
      t.drop_reason = dupe.drop_reason ? `duplicate of ${dupe.tender_id} (${dupe.drop_reason})` : `duplicate of ${dupe.tender_id}`;
      (dupe.also_seen_in ||= []).push({ source: t.source, url: t.source_url });
      continue;
    }
    const [older, newer] = [dupe, t].sort((a, b) => (a.publication_date || '').localeCompare(b.publication_date || ''));
    newer.relaunch_of = older.tender_id;                       // same title + buyer, new deadline: both kept
  }
  seen.set(`c:${t.canonical_id}`, t); seen.set(`p:${t.pair_key}`, t);   // registered first: a later copy of a known tender is a duplicate
  const updates = (t.supersedes || []).some(id => known.has(`${t.source}:${id}`));
  if (known.has(t.canonical_id)) {
    t.flags.push('seen_in_previous_run');
    // a known tender whose deadline moved in this run is exported again (its sheet row gets the new deadline)
    if (t.flags.some(f => f.startsWith('deadline_rectified_by:'))) t.flags.push('deadline_updated_since_export');
    else if (cfg.limits.skipKnown) t.drop_reason = 'already exported by a previous run';
  } else if (updates) t.flags.push('update_of_previous_run');          // a new version of a notice exported before
  else if (known.has(t.pair_key)) {
    // same title + buyer as an exported tender: with the deadline it was exported with (02 pair_deadlines), the same notice reached
    // under another URL (a site echoing the Config search in its links, a mirror page); a relaunch only when the deadline differs,
    // or is unknown on either side (nothing proves it is the same notice: kept)
    if (t.effective_deadline && (pairDeadlines[t.pair_key] || []).includes(t.effective_deadline)) {
      t.flags.push('seen_in_previous_run');
      if (cfg.limits.skipKnown) t.drop_reason = 'already exported by a previous run (same title, buyer and deadline)';
    } else { t.flags.push('relaunch_of_previous_run'); t.relaunch_of ||= 'previous_run'; }
  }
}

// ---------- pass 5: buyer groups ----------
const groups = {};
for (const t of ts.filter(t => !t.drop_reason)) (groups[t.buyer_key] ||= []).push(t.tender_id);
for (const t of ts) {
  t.buyer_id = 'B' + fnv(t.buyer_key);
  t.buyer_group_size = (groups[t.buyer_key] || []).length;
  t.status = t.drop_reason ? 'dropped' : 'kept';
}
return [...ts, ...passthrough].map(json => ({ json }));
