// Parse Market. The Competitor & Budget Agent's TOOL RESULTS (not its prose) become the market study of ONE tender:
//   every tool row is an awarded contract "AWARD | id | date | amount= | cur= | buyer= | winners= | bids= | cpv= | src= | title=".
//   The agent only CHOOSES the comparable contracts (by id) and writes a short positioning; code computes:
//   - budget: low / median / high of the comparables' amounts (25th / 50th / 75th percentile), how many, and a confidence;
//     framework agreements (fw=yes) are left out of it, their amount being a ceiling
//   - competitors: who won the comparables (wins, last win, amounts won), most wins first; "X" and "X S.A." are one company,
//     and one award listed twice (TED + DECP, or twice in DECP) counts once
//   - median_bids: competition intensity (offers received per contract)
//   - buyer_awards: the buyer's own awarded contracts among every row seen (by its SIREN or its name): who supplies it already
//   Unknown ids are ignored; positioning sentences with a number that is not in the rows are removed; contracts mainly for goods
//   the tender does not buy are left out; an answer cut short keeps the ids written before the cut (confidence a level less).
// The value declared in the notice (estimated_value) is kept apart: it is the buyer's own figure.
/*@lib fold nameSim parseAnswer*/
const cfg = $('00 - Config').first().json;
const unwrap = obs => {
  const s = typeof obs === 'string' ? obs : JSON.stringify(obs ?? '');
  try { const j = JSON.parse(s); const pick = x => (x && typeof x === 'object' ? String(x.result ?? x.response ?? x.output ?? JSON.stringify(x)) : String(x)); return Array.isArray(j) ? j.map(pick).join('\n') : pick(j); }
  catch { return s.replace(/\\n/g, '\n').replace(/\\"/g, '"'); }
};
const MARKET_TOOLS = new Set(['similar_awards', 'buyer_awards']);
// the FIRST word of a sentence is capitalised anyway ("Capgemini usually wins these contracts." kept an invented competitor as its
// subject): it is checked as a name when it reads as one, by its shape (a capital, '&' or '.' after its first letter: "SOPRA",
// "OliveSoft", "BLUEDROP.FR") or as the subject of a supplier's claim (it wins, runs, supplies, hosts..., "is the incumbent"; a
// passive is none: "Maintenance provided by ..."), never when it is a word a sentence starts with ("Bids", "Winners", "Expect", "Therefore", an English ending: "Typically"). Advice
// ("Leverage ...", "Stress hosting in France.") and adjectives ("Strong references matter.") are no names: checking every other
// first word removed them. A possessive is the name ("OliveSoft's"). Same rule in Parse Research
const OPENERS = new Set(('the this that these those its they their there here his her she our one some any each every all both either neither none not nor several ' +
  'many much most more less few other another such only also just even for from with within without into onto over under about after before ' +
  'between during through across against along among around despite since until upon via per and but yet then thus therefore hence however ' +
  'although though while whereas when where whether which who what why how unless because moreover furthermore additionally overall finally ' +
  'first second third lastly meanwhile otherwise instead still already often today now given according based known expect consider focus ' +
  'emphasize emphasise highlight position offer propose note bids bid bidders winners winner companies company firms firm suppliers supplier ' +
  'providers provider vendors competitors competition players incumbent contracts contract awards award notices notice tenders tender ' +
  'procurement budget budgets prices price amounts amount values value costs cost data information records registry history staff employees ' +
  'revenue size website web search results public private digital large small medium major main key local national regional recent past ' +
  'previous similar comparable typical average median total buyer buyers organisation organization body entity agency authority municipality ' +
  'commune city town region department ministry government state sector market projects project services service two three four five six seven ' +
  'eight nine ten les une des cet cette ces elle ils elles son ses leur leurs dans depuis selon avec sans pour par sur sous entre aucun aucune ' +
  'plusieurs ainsi donc toutefois cependant enfin').split(' '));
const opener = w => OPENERS.has(fold(w)) || (/^\p{Lu}\p{Ll}+$/u.test(w) && /(ly|ed|ing|ies|tion|sion|ment|ness|ity)$/.test(fold(w)));
const ROLE = /^(?:,[^,.]{1,60},)?\s*(?:\p{L}+ly\s+|(?:also|already|often|still|now|d[eé]j[aà])\s+)?(?:(?:wins?|won|runs?|ran|suppl(?:y|ies|ied)|provides?|provided|hosts?|hosted|operates?|operated|manages?|managed|maintains?|maintained|holds?|held|dominates?|dominated|builds?|built|develops?|developed|delivers?|delivered|serves?|served|leads?|led|owns?|quot(?:es?|ed)|bids?|offer(?:s|ed)|charge[sd]?|priced|submit(?:s|ted)|propos(?:es|ed)|secure[sd]|compet(?:es|ed))(?![\p{L}])(?!\s+(?:by|to|in|on|at|for|from|under|with|as|par)(?![\p{L}]))|(?:is|was|remains) (?:the|a|an|its|their) (?:\p{L}+ )?(?:incumbent|supplier|provider|contractor|vendor|operator|partner|holder|competitor|player|leader)(?![\p{L}])|(?:g[eè]re|exploite|fournit|h[eé]berge|remporte|a remport[eé]|d[eé]tient|maintient|d[eé]veloppe|a d[eé]velopp[eé]|est (?:le |l.)(?:titulaire|attributaire|prestataire|fournisseur))(?![\p{L}]))/iu;
const firstName = s => { const m = s.match(/^[^\p{L}]*([A-ZÀ-Ý][\p{L}'&.-]{2,})(.*)$/su); if (!m) return [];
  const w = m[1].replace(/['’]s$/, '').replace(/[.'&-]+$/, '');
  return w.length > 2 && !opener(w) && (/[\p{Lu}&.]/u.test(w.slice(1)) || ROLE.test(m[2].trim())) ? [w] : []; };
const schema = { type: 'object', required: ['comparable_ids'], properties: {
  comparable_ids: { type: 'array', items: { type: 'string' }, maxItems: 60 },
  positioning: { type: 'string', maxLength: 1200, nullable: true }, budget_comment: { type: 'string', maxLength: 600, nullable: true } } };
const q = (a, p) => { if (!a.length) return null; const x = (a.length - 1) * p, lo = Math.floor(x), hi = Math.ceil(x); return Math.round(a[lo] + (a[hi] - a[lo]) * (x - lo)); };
// the notice's declared value as a number ("180000 euros", "1 200 000,00 €"): the same reading as Build Proposal Input's
const parseMoney = s => { let x = (String(s ?? '').replace(/[\s  ]/g, '').match(/\d[\d.,]*/) || [])[0]; if (!x) return null;
  x = /,\d{1,2}$/.test(x) ? x.replace(/\./g, '').replace(',', '.') : x.replace(/[.,](?=\d{3}(\D|$))/g, ''); const n = Number(x); return Number.isFinite(n) && n > 0 ? n : null; };
const out = [];
const items = $input.all();
for (let i = 0; i < items.length; i++) {
  const t = { ...$('Select Market Studies').itemMatching(i).json };
  const task = t.market_task || {}; delete t.market_task; delete t._market;
  const r = items[i].json || {}, checks = [];
  const rows = new Map(), toolErrors = [], searches = [], sirenIds = new Set();
  for (const st of r.intermediateSteps || []) {
    if (!MARKET_TOOLS.has(String((st.action && st.action.tool) || ''))) continue;
    const inp = st.action.toolInput; searches.push(`${st.action.tool} ${(typeof inp === 'string' ? inp : JSON.stringify(inp || {})).slice(0, 140)}`);
    // a buyer_awards call made with the task's SIREN reads DECP by that SIREN: its DECP rows are this buyer's contracts
    let args = inp; if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    const bySiren = st.action.tool === 'buyer_awards' && /^\d{9}$/.test(task.buyer_siren || '') && String((args || {}).siren || '').replace(/\D/g, '') === task.buyer_siren;
    const obs = unwrap(st.observation);
    const err = obs.match(/^ERROR: .*$|\b(?:TED|DECP|TUNEPS) error: [^,\n]*/m); if (err) toolErrors.push(err[0].slice(0, 140));
    for (const line of obs.split('\n')) {
      const m = line.match(/^AWARD \| ([^|]+?) \| ([^|]*?) \| (.*)$/); if (!m) continue;
      const kv = {}; for (const part of m[3].split(' | ')) { const k = part.indexOf('='); if (k > 0) kv[part.slice(0, k).trim()] = part.slice(k + 1).trim(); }
      const amount = Number(kv.amount); const bids = Number(kv.bids);
      if (!rows.has(m[1])) rows.set(m[1], { id: m[1], date: m[2], amount: Number.isFinite(amount) && amount > 0 ? amount : null, currency: kv.cur || 'EUR',
        buyer: kv.buyer || '', winners: (kv.winners || '').split(';').map(s => s.trim()).filter(Boolean), bids: Number.isFinite(bids) && bids > 0 ? bids : null,
        others: (kv.others || '').split(';').map(s => s.trim()).filter(Boolean),   // losing bidders (TUNEPS)
        // a framework (its amount = a ceiling): flagged by the source, or said by its title; a call-off under one ("MS ...",
        // "marché subséquent") is a real price
        cpv: kv.cpv || '', framework: kv.fw === 'yes' || (/accord[- ]?cadre|framework agreement/i.test(kv.title || '') && !/^\s*MS\b|march[eé] subs[eé]quent/i.test(kv.title || '')),
        source: kv.src || '', title: kv.title || '' });
      if (bySiren && kv.src === 'DECP') sirenIds.add(m[1]);
    }
  }
  let a = parseAnswer(r, schema, null), salvaged = false;
  // an answer cut short still holds the ids written before the cut (MEL, run of 2026-10-20: '{"comparable_ids":["D1iawp2m",...,
  // "T643461-2026","' after 141 characters, the model's context full of rows): those that are row ids are the agent's choice, the
  // positioning is lost and, the choice being partial, the budget's confidence drops a level. A malformed but complete answer (an
  // object closed after the ids, '...]}\n,"positioning":...') keeps its ids the same way, at full confidence
  if (!a.ok && !r.error && rows.size) {
    const raw = String(typeof r.output === 'string' ? r.output : r.text || ''), at = raw.search(/"comparable_ids"\s*:\s*\[/);
    const ids = at < 0 ? [] : [...new Set([...raw.slice(at).matchAll(/"([^"\\\s]{2,40})"/g)].map(m => m[1]).filter(id => rows.has(id)))];
    if (ids.length) {
      salvaged = !/\}\s*$/.test(raw.trim());
      checks.push(`agent answer ${salvaged ? 'cut short' : 'malformed'} (${a.errors.slice(0, 1).join('')}): ${ids.length} comparable id(s) read from it, no positioning${salvaged ? ', budget confidence lowered' : ''}`);
      a = { ok: true, value: { comparable_ids: ids, positioning: '', budget_comment: '' }, errors: [] };
    }
  }
  // no row because the award APIs failed is a failure, not "no comparable contract in the market"
  let status = r.error ? 'study_failed' : !rows.size && toolErrors.length ? 'tools_failed' : !a.ok ? 'answer_invalid' : !rows.size ? 'no_data' : 'studied';
  if (toolErrors.length) checks.push(...[...new Set(toolErrors)].slice(0, 3).map(e => 'tool: ' + e));
  if (r.error) checks.push('agent error: ' + String((r.error && r.error.message) || r.error).slice(0, 160));
  else if (!a.ok) checks.push('agent final answer invalid: ' + a.errors.slice(0, 2).join('; '));
  // "no data" from one narrow query (an 8-digit CPV) is not "no market": the searches made are kept so a person can judge
  if (status === 'no_data' && searches.length) checks.push(`no awarded contract found by: ${searches.join(' | ')}`);
  const picked = [], unknown = [];
  for (const id of (a.value && a.value.comparable_ids) || []) {
    const k = String(id).trim().replace(/^\[|\]$/g, ''), row = rows.get(k);
    if (!row) { unknown.push(k); continue; }
    if (fold(row.title) === fold(t.title) && fold(row.buyer) === fold(task.buyer)) continue;   // the tender itself is not a comparable
    if (!picked.includes(row)) picked.push(row);
  }
  if (unknown.length) checks.push(`${unknown.length} comparable id(s) not in the tool results ignored`);
  const chosenIds = new Set(picked.map(x => x.id));
  // one company, several spellings ("SECUTIX" / "SECUTIX S.A.", "SEE TICKETS S.A.S", "STE NACHD IT"): a legal form around the
  // name is not part of it (dotted initials "S.A.S" are joined first). Used for the competitors and for the duplicate checks
  const FIRM_TAIL = new Set(['sa', 'sas', 'sasu', 'sarl', 'eurl', 'sl', 'slu', 'srl', 'spa', 'se', 'sca', 'scop', 'scic', 'gmbh', 'ag', 'bv', 'nv', 'ltd', 'limited', 'inc', 'llc', 'plc', 'sprl']);
  const FIRM_HEAD = new Set(['ste', 'societe', 'ets', 'etablissements']);
  const firmKey = n => {
    const w = fold(n).replace(/\b[a-z](?: [a-z]\b)+/g, m => m.replace(/ /g, '')).split(' ').filter(Boolean);
    while (w.length > 1 && FIRM_TAIL.has(w[w.length - 1])) w.pop();
    while (w.length > 1 && FIRM_HEAD.has(w[0])) w.shift();
    return w.join(' ');
  };
  // the same contract often comes from TED AND from DECP under two ids: same winners, amount within 2 %, dates within 90 days
  // -> counted once (the row with more information is kept)
  const winKey = x => x.winners.map(firmKey).sort().join('|');
  const crossSource = (x, y) => x.source !== y.source && winKey(x) && winKey(x) === winKey(y)
    && (x.amount && y.amount ? Math.abs(x.amount - y.amount) <= 0.02 * Math.max(x.amount, y.amount) : !x.amount && !y.amount)
    && Math.abs(new Date(x.date) - new Date(y.date)) <= 90 * 864e5;
  // ...and ONE source may list one award decision under several ids: DECP republishes it (Essonne 2026-07-06, 600 000, ENTR'OUVERT
  // under D1rl9qaf / D1q4swcs / D8t0v3j), the object prefixed with the contract number "2026_2957_2_00 - ", cut at 110 characters
  // or reworded. Same folded buyer, day, amount and winners = one award, whatever the title (copies or same-winner lots of one
  // procedure at one price cannot be told apart): one win, one price, so 3 identical rows never triple a competitor's wins, the
  // budget's weight nor the counts the positioning is checked against (the key of Build Proposal Input's recount, which then finds
  // no repeat). Never without an amount: two unpriced awards of one buyer on one day can be two contracts (the Département de
  // l'Eure's lots on TED), each stays a win. The tool keeps them all (its dedupeAwards drops only cross-source copies) for the agent
  const copy = (x, y) => x.source === y.source && x.amount != null && x.amount === y.amount && winKey(x) && winKey(x) === winKey(y) && x.date === y.date && fold(x.buyer) === fold(y.buyer);
  const info = x => (x.amount ? 2 : 0) + (x.bids ? 1 : 0) + (x.framework ? 1 : 0) + x.others.length;
  let copies = 0;
  for (let k = picked.length - 1; k >= 0; k--) {
    const j = picked.findIndex((y, n) => n !== k && (crossSource(picked[k], y) || copy(picked[k], y)));
    if (j >= 0) { if (copy(picked[k], picked[j])) copies++; const drop = info(picked[k]) >= info(picked[j]) ? j : k; picked.splice(drop, 1); if (drop < k) k--; }
  }
  if (copies) checks.push(`${copies} more row(s) of one award decision (copies or same-winner lots of one procedure: same buyer, date, amount and winners) counted once`);
  if (status === 'studied' && !picked.length) status = 'no_comparable';
  // the buyer's OWN awarded contracts among every row the tools gave, chosen as comparable or not: their winners are the buyer's
  // suppliers (Build Proposal Input's key partners). A DECP row read by the task's SIREN is the buyer's; any other row by its buyer
  // name, the notice's or the registry's (its acronym in brackets too), the legal form aside ("GIP RESAH" ~ "RESAH", "Epa Shom" ~
  // "EPA-SHOM"; Dice >= 0.85: "Île-de-France Mobilités" is not the Région): TED's search by name also returns other bodies. The
  // KIND of body stays a word, its synonyms made one as buyer_awards' own buyer test does (public_apis buyerWords): "COMMUNE DE X" ~
  // "Ville de X", "CONSEIL DEPARTEMENTAL DE X" ~ "Département de X", but the "METROPOLE DE LYON", the "CENTRE HOSPITALIER DE CHOLET"
  // or the "DEPARTEMENT DE LA GUADELOUPE" are not the Ville de Lyon, the Ville de Cholet nor the Région Guadeloupe (the kind once
  // removed, they were: a comparable of the Métropole made its winner a partner of the Ville). With the SIREN known, a DECP row read
  // another way (a comparable, a search by name) counts only by that SIREN: DECP prints no SIREN on a row and namesakes exist
  // (COMMUNE DE SAINT-DENIS, 93 and 974). Rows without a winner tell no supplier; one award listed twice counts once
  const KIND_SAME = { ville: 'commune', mairie: 'commune', municipalite: 'commune', municipality: 'commune', city: 'commune', town: 'commune',
    cc: 'communaute communes', ca: 'communaute agglomeration', cu: 'communaute urbaine', agglo: 'agglomeration', ministry: 'ministere' };
  const LEGAL = new Set(['gip', 'gie', 'epa', 'epic', 'epst', 'epscp', 'sem', 'spl', ...FIRM_TAIL, ...FIRM_HEAD]);
  const bodyOf = n => fold(String(n || '').replace(/\([^)]*\)/g, ' ')).replace(/\bconseil (departement|region)al\b/g, '$1').split(' ')
    .flatMap(w => (KIND_SAME[w] || w).split(' ')).filter(w => w.length > 1 && !LEGAL.has(w)).join(' ');
  const ownNames = [task.buyer, task.buyer_official_name].filter(Boolean).flatMap(n => [n, ...(String(n).match(/\(([^)]+)\)/g) || []).map(p => p.slice(1, -1))]).map(bodyOf).filter(Boolean);
  const sirenKnown = /^\d{9}$/.test(task.buyer_siren || '');
  const ownRow = x => sirenIds.has(x.id) || (!(sirenKnown && x.source === 'DECP') && !!bodyOf(x.buyer) && ownNames.some(n => nameSim(bodyOf(x.buyer), n) >= 0.85));
  const own = [];
  for (const x of rows.values()) if (x.winners.length && ownRow(x) && !own.some(y => crossSource(x, y) || copy(x, y))) own.push(x);
  const buyer_awards = own.sort((x, y) => String(y.date).localeCompare(String(x.date))).slice(0, 20)
    .map(x => ({ id: x.id, date: x.date || null, amount: x.amount, currency: x.currency, buyer: x.buyer, winners: x.winners, cpv: x.cpv, framework: x.framework, source: x.source, title: x.title }));
  // a framework agreement reports its ceiling, not a price: its winners count as competitors, its amount stays out of the budget.
  // The budget is in the currency most comparables use (EUR for France / EU, TND for Tunisia); others are not converted.
  // a chosen contract sharing NO meaningful word with the tender (title, summary, requirements) is low-relevance (catering picked
  // for lab analysers): listed, but kept out of the budget and of the competitors
  // (generic words are no shared subject: "agents" is staff in a payroll contract and software agents in an LLM tender)
  const STOP = /^(pour|avec|dans|des|les|une|sur|par|aux|leur|leurs|lot|lots|marche|marches|prestations?|services?|fourniture|travaux|accord|cadre|contrat|the|and|for|with|supply|services|public|agents?|solutions?|outils?|gestion|ensemble|disposition)$/;
  const tw = new Set(fold(`${task.title} ${task.summary || ''} ${(task.requirements || []).join(' ')}`).split(' ').filter(w => w.length >= 5 && !STOP.test(w)).map(w => w.slice(0, 6)));
  // ...and no CPV division with it (lab reagents, CPV 33, stay for a CPV 33 tender whatever their wording); without a tender CPV
  // there is nothing reliable to compare, so nothing is left out
  const divs = new Set((task.cpv || []).map(c => String(c).slice(0, 2)));
  const relevant = x => !divs.size || String(x.cpv || '').split(',').some(c => divs.has(c.trim().slice(0, 2)))
    || fold(x.title).split(' ').some(w => w.length >= 5 && tw.has(w.slice(0, 6)));
  const lowRel = picked.filter(x => !relevant(x));
  if (lowRel.length && lowRel.length < picked.length) { for (const x of lowRel) picked.splice(picked.indexOf(x), 1); checks.push(`${lowRel.length} chosen contract(s) share no word with the tender: left out (${lowRel.slice(0, 3).map(x => x.title.slice(0, 40)).join(' | ')})`); }
  // a contract that also BUYS goods (a supply CPV: divisions 03 to 44; software packages 48 are not goods here) has their price in
  // its amount and their vendors as winners: for a tender that buys none (OPPIC's IT infogérance) "purchase and maintenance of
  // printers" (30120000) set the budget's upper half. Left out like the above, never all of them; but only a contract MAINLY for
  // goods: its first (main) CPV a supply one, or a title that says it buys them (achat, acquisition, location, fourniture of
  // things). TED lists extra CPVs: an infogérance with a computer-equipment code beside it stays a comparable, with a check
  const GOODS = c => { const d = Number(String(c).trim().slice(0, 2)); return String(c).trim().length >= 2 && d >= 3 && d <= 44; };
  const BUYS = /\b(fournitures?(?! d[e'’]\s?(services?|prestations?))|acquisitions?|achats?|location|livraisons?|supply(?! of (\w+ )?services)|supplies|purchase|rental|leasing)\b/i;
  const withGoods = divs.size && !(task.cpv || []).some(GOODS) ? picked.filter(x => String(x.cpv || '').split(',').some(GOODS)) : [];
  const goods = withGoods.filter(x => GOODS(String(x.cpv).split(',')[0]) || BUYS.test(x.title)), alsoGoods = withGoods.filter(x => !goods.includes(x));
  if (goods.length && goods.length < picked.length) { for (const x of goods) picked.splice(picked.indexOf(x), 1); checks.push(`${goods.length} chosen contract(s) also buy goods the tender does not (supply CPV): left out (${goods.slice(0, 3).map(x => `${x.id} ${x.title.slice(0, 40)}`).join(' | ')})`); }
  if (alsoGoods.length) checks.push(`${alsoGoods.length} chosen contract(s) list a supply CPV besides their main service: kept, their amount may include goods (${alsoGoods.slice(0, 3).map(x => `${x.id} ${x.cpv}`).join(' | ')})`);
  // ...and the same award a few days apart (DECP D1eipd4z 2026-01-08 / D12exx6m 2026-01-06: one buyer, 39 000, POLARIA TECHNOLOGIES,
  // one conversational tool reworded) may be one award republished, or two contracts: both rows stay listed, the later-listed one
  // adds no win and no price (it read as "won 2 comparable contracts"), and a check names the pair
  const nearCopy = (x, y) => x.source === y.source && x.amount != null && x.amount === y.amount && winKey(x) && winKey(x) === winKey(y) && fold(x.buyer) === fold(y.buyer)
    && x.date !== y.date && Math.abs(new Date(x.date) - new Date(y.date)) <= 7 * 864e5;
  const repeats = new Map();
  for (let k = 0; k < picked.length; k++) { const y = picked.find((z, n) => n < k && !repeats.has(z) && nearCopy(picked[k], z)); if (y) repeats.set(picked[k], y); }
  if (repeats.size) checks.push(`${repeats.size} row(s) may repeat an award a few days apart (same buyer, amount and winners): counted once (${[...repeats].slice(0, 3).map(([x, y]) => `${x.id} ~ ${y.id}`).join(', ')})`);
  // the agent may skip the closest PRICED contract (a small model left out "... solution logicielle de Gestion de la Relation
  // Client" for a GRC renewal, the budget then resting on 2 small ones): an unchosen priced, non-framework row sharing most of
  // the tender TITLE's words is named here for a person to check; the budget stays the agent's choice. Rows whose title starts
  // with the tender's own title are its lots or the tender itself (RESAH "AUTOMATES D'AUTO-IMMUNITE ... - Lot x"): not flagged
  const ownT = fold(task.title || t.title), titleW = [...new Set(ownT.split(' ').filter(w => w.length >= 5 && !STOP.test(w)).map(w => w.slice(0, 6)))];
  const ownLot = x => { const f = fold(x.title), n = Math.min(f.length, ownT.length, 60); return n >= 20 && f.slice(0, n) === ownT.slice(0, n); };
  const missed = titleW.length < 2 ? [] : [...rows.values()].filter(x => !chosenIds.has(x.id) && x.amount && !x.framework && !ownLot(x)
    && titleW.filter(w => fold(x.title).split(' ').some(v => v.length >= 5 && v.slice(0, 6) === w)).length >= Math.max(2, Math.ceil(titleW.length / 2)));
  if (missed.length) checks.push(`${missed.length} priced contract(s) close to the tender title not chosen: ${missed.slice(0, 3).map(x => `${x.id} ${x.amount} ${x.currency} "${x.title.slice(0, 70)}"`).join(' | ')}`);
  const curCount = {}; for (const x of picked) if (x.amount && !x.framework && !repeats.has(x)) curCount[x.currency] = (curCount[x.currency] || 0) + 1;
  const CUR = Object.entries(curCount).sort((a, b) => b[1] - a[1])[0]?.[0] || 'EUR';
  const priced = picked.filter(x => x.amount && x.currency === CUR && !x.framework && !repeats.has(x)), frameworks = picked.filter(x => x.framework && !repeats.has(x)).length;
  const otherCur = picked.filter(x => x.amount && !x.framework && x.currency !== CUR).length;
  // outliers (beyond 10x the median either way) are listed, not averaged in: one 18 M catering contract must not set the range.
  // Only from 3 priced contracts: the "median" of 2 is their midpoint, so the smaller one was always the outlier (Tdoatt8 kept a
  // 2.8 bn contract and dropped the 206 619 one); 2 far apart stay both, their spread lowers the confidence
  const all = priced.map(x => x.amount).sort((x, y) => x - y), mid = all.length >= 3 ? q(all, 0.5) : 0;
  const outliers = priced.filter(x => mid && (x.amount > mid * 10 || x.amount < mid / 10));
  const amounts = all.filter(v => !mid || (v <= mid * 10 && v >= mid / 10));
  const levels = ['very low', 'low', 'medium'];
  let conf = amounts.length >= 5 ? 2 : amounts.length >= 2 ? 1 : 0;
  const spread = amounts.length >= 2 ? q(amounts, 0.75) / Math.max(1, q(amounts, 0.25)) : 1;
  if (spread > 5 || (amounts.length >= 2 && amounts[amounts.length - 1] / Math.max(1, amounts[0]) > 50)) conf = Math.max(0, conf - 1);   // a wide range is not a precise estimate
  // an agent that "chose" nearly every row shown (36 of 42 at OPPIC, printers and UPS maintenance included) did not choose; a cut
  // answer is a partial choice: either way a level less
  const overPicked = rows.size >= 10 && chosenIds.size > 0.8 * rows.size;
  if (overPicked && amounts.length) checks.push(`agent chose ${chosenIds.size} of the ${rows.size} contracts shown: budget confidence lowered`);
  if (overPicked || salvaged) conf = Math.max(0, conf - 1);
  const budget = amounts.length ? { low: q(amounts, 0.25), median: q(amounts, 0.5), high: q(amounts, 0.75), min: amounts[0], max: amounts[amounts.length - 1],
    currency: CUR, comparables: amounts.length, confidence: levels[conf], spread: Math.round(spread * 10) / 10,
    outliers: outliers.map(x => ({ id: x.id, amount: x.amount, title: x.title })),
    basis: `amounts of ${amounts.length} awarded contract(s) the agent judged comparable${frameworks ? ` (${frameworks} framework agreement(s) left out: their amount is a ceiling)` : ''}${outliers.length ? ` (${outliers.length} outlier(s) beyond 10x the median left out)` : ''}${otherCur ? ` (${otherCur} in another currency left out)` : ''}` } : null;
  // competitors: who won the comparables. Amounts only from real prices (not framework ceilings), averaged over the wins that
  // have one; "lost" only where the source lists the other bidders (TUNEPS), else unknown (null), never a fake 0
  const listsBidders = picked.some(x => x.source === 'TUNEPS');
  const comp = new Map();
  const entry = n => { const k = firmKey(n); if (!k) return null; const c = comp.get(k) || { name: n, wins: 0, lost: 0, last_win: '', amount_won: 0, priced_wins: 0 }; comp.set(k, c); return c; };
  // one contract far from the value the notice declares is no estimate (City'up: one occupational-medicine software at 315 708 for
  // a declared 180 000): said so, its confidence being "very low" already
  const declared = parseMoney(task.declared_value || t.estimated_value);
  if (budget && budget.comparables === 1 && declared && Math.max(declared, budget.median) / Math.min(declared, budget.median) > 1.5)
    checks.push(`budget rests on one contract (${budget.median} ${CUR}) far from the value the notice declares (${task.declared_value || t.estimated_value}): read with care`);
  for (const x of picked) {
    if (repeats.has(x)) continue;                                  // a possible repeat adds no win (see nearCopy)
    const real = x.amount && x.currency === CUR && !x.framework && !outliers.includes(x);
    for (const w of new Set(x.winners)) { const c = entry(w); if (!c) continue; c.wins++; if (String(x.date) > c.last_win) c.last_win = String(x.date); if (real) { c.amount_won += x.amount; c.priced_wins++; } }
    for (const o of new Set(x.others)) { const c = entry(o); if (c) c.lost++; }
  }
  const competitors = [...comp.values()].sort((x, y) => y.wins - x.wins || (y.wins + y.lost) - (x.wins + x.lost) || y.amount_won - x.amount_won).slice(0, 8)
    .map(c => ({ name: c.name, wins: c.wins, lost: listsBidders ? c.lost : null, last_win: c.last_win || null, amount_won: c.amount_won || null,
      avg_amount: c.priced_wins ? Math.round(c.amount_won / c.priced_wins) : null }));
  const bids = picked.map(x => x.bids).filter(Boolean).sort((x, y) => x - y);
  // the agent's words: every AMOUNT (with its magnitude: "1,2 M EUR", "500k", "2 millions") must be within 10 % of an amount of the
  // chosen contracts or of the budget; every small number must be a count the data gives; every name (Roche, Siemens...) must be a
  // winner, buyer or word of the CHOSEN contracts. Otherwise the sentence goes.
  const evAmounts = [...picked.map(x => x.amount).filter(Boolean), ...(budget ? [budget.low, budget.median, budget.high, budget.min, budget.max] : [])];
  const evCounts = new Set([picked.length, amounts.length, competitors.length, ...bids, ...competitors.flatMap(c => [c.wins, c.lost || 0]), q(bids, 0.5)].filter(n => n != null).map(String));
  const evText = fold([...picked.map(x => `${x.title} ${x.buyer} ${x.winners.join(' ')} ${x.others.join(' ')} ${String(x.date).slice(0, 4)}`), task.title, task.buyer, task.country_name, cfg.company.name].join(' '));
  const BIDS_CTX = /\b(bids?|offers?|offres?|soumission|soumissionnaires?|candidat|tenders? received|competitors? per)\b/i, WIN_CTX = /\b(won|wins|win|remport|gagn|attribu|awarded)/i;
  const MULT = { k: 1e3, keur: 1e3, 'k€': 1e3, m: 1e6, meur: 1e6, 'm€': 1e6, million: 1e6, millions: 1e6, md: 1e9, milliard: 1e9, milliards: 1e9, billion: 1e9, mds: 1e9 };
  const sentenceOk = x => {
    const why = [];
    for (const m of x.matchAll(/(\d+(?:[\s.,'\u00A0\u202F]\d{3})*(?:[.,]\d+)?)\s*(k€|keur|k|m€|meur|millions?|milliards?|mds?|md|billion|m)?(?![\p{L}])\s*(%)?/giu)) {
      const raw = m[1], unit = (m[2] || '').toLowerCase(), pct = !!m[3];
      const n = Number(unit ? raw.replace(/[\s'\u00A0\u202F]/g, '').replace(/,(?=\d{1,2}$)|,(?=\d$)/, '.').replace(/,/g, '') : raw.replace(/[\s.,'\u00A0\u202F](?=\d{3}\b)/g, '').replace(',', '.'));
      if (!Number.isFinite(n)) continue;
      const v = unit ? n * (MULT[unit] || 1) : n;
      if (pct) { if (!evCounts.has(String(n))) why.push(`${raw}%`); continue; }
      if (/^(19|20)\d{2}$/.test(raw) && evText.includes(raw)) continue;                  // a year of the contracts
      if (unit || v >= 1000) { if (!evAmounts.some(a => Math.abs(a - v) <= 0.1 * Math.max(a, v))) why.push(m[0].trim()); }
      // a small number about bids must be a bid count of the data; about wins, a win count; else any count of the data
      else if (BIDS_CTX.test(x) ? !bids.concat(q(bids, 0.5)).map(String).includes(String(n)) : WIN_CTX.test(x) ? !competitors.map(c => String(c.wins)).concat(String(picked.length)).includes(String(n)) : !evCounts.has(String(n))) why.push(raw);
    }
    // "OliveSoft won ..." is only true when the company is among the winners of the chosen contracts
    if (WIN_CTX.test(x) && fold(x).includes(fold(cfg.company.name)) && !competitors.some(c => fold(c.name).includes(fold(cfg.company.name)))) why.push(`${cfg.company.name} is not a winner`);
    const names = [...firstName(x), ...(x.match(/(?<=\S\s+)[A-ZÀ-Ý][\p{L}'&.-]{2,}/gu) || [])].flatMap(w => fold(w.replace(/['’]s$/, '')).split(' '))
      .filter(w => w && !/^(eur|tnd|the|they|this|these|it|its|in|on|of|and|for|with|france|tunisia|tunisie|public|state)$/.test(w));
    for (const w of names) if (!evText.split(' ').includes(w)) why.push(w);
    return why;
  };
  const checked = s => String(s || '').split(/(?<=[.!?؟])\s+/).filter(Boolean).filter(x => {
    const why = sentenceOk(x);
    if (why.length) checks.push(`sentence removed (not in the chosen contracts: ${why.slice(0, 3).join(', ')}): ${x.slice(0, 80)}`);
    return !why.length;
  }).join(' ');
  t.market = { status, declared_value: task.declared_value || t.estimated_value || null, budget, competitors, median_bids: q(bids, 0.5),
    comparables: picked.slice(0, 30), contracts_seen: rows.size, buyer_awards,
    positioning: a.value && picked.length ? checked(a.value.positioning) : '', budget_comment: a.value && picked.length ? checked(a.value.budget_comment) : '',
    tools_used: (r.intermediateSteps || []).map(st => String((st.action && st.action.tool) || '')), checks };
  out.push({ json: t });
}
return out;
