// Build Proposal Input. Hand-off to the team's proposal / deck service: ONE JSON per fit tender still open for bidding,
// best-ranked first (Config proposal.maxTenders), contract "olivesoft.proposal-input.v2" (INTEGRATION.md): the structure
// the deck service asked for (tender / analysis / buyer_profile / rag / matrix / competition / options) plus the verified
// extras a proposal needs (the tender's own quote for each requirement, mandatory flags, award criteria, buyer contacts,
// the awarded contracts behind the budget, the buyer's suppliers with the awards that name them). Every number and
// recommendation here comes from data or from a rule written below, never from an LLM's opinion. The first item also
// carries all of them as one file (proposal_inputs_<date>.json)
// so the deck service can be built on real data before it is connected. "Adapt for Studio" makes the proposal studio's copy
// of each item (this output and its file stay the full v2), "Send to Proposal Service" POSTs that copy.
/*@lib hostOfUrl PLATFORM_HOST*/
const cfg = $('00 - Config').first().json;
const rankOf = new Map($input.all().map(i => i.json).filter(r => r.rank).map(r => [r.tender_id, r.rank]));
const tenders = $('Merge Market').all().map(i => i.json).filter(t => !t._type && t.survivor && !t.too_late && rankOf.has(t.tender_id))
  .sort((a, b) => rankOf.get(a.tender_id) - rankOf.get(b.tender_id)).slice(0, (cfg.proposal && cfg.proposal.maxTenders) || 10);
const cut = (s, n) => (s == null ? null : String(s).slice(0, n));
// a buyer website = a web host (it has a dot) that is no tender platform, as Parse Research checks it (defence in depth: the
// recorded run handed off "https://undefined", a Wikidata row without website=; notices give the platform's buyer page)
const siteOf = w => { const h = String(w ?? '').trim() ? hostOfUrl(w) : ''; return h.includes('.') && !PLATFORM_HOST.test(h) ? w : null; };
const countryName = c => { try { return c && /^[A-Z]{2}$/i.test(c) ? new Intl.DisplayNames(['en'], { type: 'region' }).of(c.toUpperCase()) : c || null; } catch { return c || null; } };
// "180000 euros", "12 000 000,00EUR", "1.200.000" -> a number (null if none)
const parseMoney = s => { let x = (String(s ?? '').replace(/[\s\u00A0\u202F]/g, '').match(/\d[\d.,]*/) || [])[0]; if (!x) return null;
  x = /,\d{1,2}$/.test(x) ? x.replace(/\./g, '').replace(',', '.') : x.replace(/[.,](?=\d{3}(\D|$))/g, ''); const n = Number(x); return Number.isFinite(n) && n > 0 ? n : null; };
// a value range: "80000-215000 EUR" (a BOAMP fourchette, Map Records), "50 000 à 100 000 €" -> [low, high]; null for one value
// (parseMoney alone read the range as its low bound, so a ceiling of 215 000 looked "far below" 300 000 contracts). Only a range
// that is the value's first number (the one parseMoney reads), low below high, never a span of years ("2024-2027 : 500 000 €" is a
// period, not a money range of 2024 to 2027)
const parseRange = s => { const m = String(s ?? '').replace(/\s/g, '').match(/^\D*?(\d[\d.,]*)(?:[-–—]|à|to)(\d[\d.,]*)/i); if (!m) return null;
  if ([m[1], m[2]].every(x => /^(19|20)\d\d$/.test(x))) return null;
  const [lo, hi] = [parseMoney(m[1]), parseMoney(m[2])]; return lo && hi && lo < hi ? [lo, hi] : null; };
// an internal document's kind, from the type the RAG gives it, else from its file name
const kindOf = (id, type) => { const s = `${type || ''} ${id || ''}`.toLowerCase(); return /\bcv\b|cv_|resume/.test(s) ? 'cv' : /project|reference|case/.test(s) ? 'project' : /tech|stack|tool/.test(s) ? 'stack' : 'document'; };
const BUYER_SECTOR = { local_authority: 'Local authority', regional_authority: 'Regional authority', state_administration: 'State administration',
  public_agency: 'Public agency', public_company: 'Public company', health: 'Health', education_research: 'Education / research', private_company: 'Private company', other: 'Other' };
const DOMAIN = /(accessib|rgaa|wcag|rgpd|gdpr|h[eé]berg|\bhost|souverain|sovereign|secnumcloud|\bhds\b|iso ?27001|s[eé]curit|security|certif|interop|open.?source|cloud)/i;
// a past notice of the buyer about software / digital / data (the test Parse Research's own digital flag is meant to make): a web
// SITE only, named by its kind ("site internet / web / institutionnel / extranet / e-commerce ...", an intranet) or by the web work
// done to it ("refonte du site (de la ville)", "création d'un site", never "création d'un site de compostage", a place); a bare "site" listed "Mission de
// programmation pour la réutilisation du site" and "Prestations multiservices ... pour le site de l'administration centrale",
// digital:false in Parse Research. A network only an IT one (never "assainissement des réseaux enterrés"), "SI" only in capitals
// ("AOO AMOA SI", never the French "si"; "sécurité des sites" is guarding) and never the all-caps conjunction ("TRAVAUX SI NECESSAIRE")
const DIGITAL = /(logiciel|application|num[eé]rique|plate-?forme|sites?[ -](internet|web|institutionnel|vitrine|marchand|mobile|e-?commerce)|intranet|extranet|\be-?commerce|refonte (du|d.un|des|de) sites?|(cr[eé]ation|h[eé]bergement) (du|d.un|des|de) sites?(?! (de|du|des)\b| d['’])|informatique|digital|donn[eé]es|\bdata\b|syst[eè]mes? d.information|web|intelligence artificielle|\bia\b|cloud|portail|d[eé]mat|software|platform|t[eé]l[eé]com(s|munications?)?\b|r[eé]seaux? (informatiques?|wi-?fi|lan)\b|cyber|s[eé]curit[eé] (des )?si\b)/i;
const isDigital = s => DIGITAL.test(s || '') || /\b(D?SI|SIRH|SIG)\b(?! (N[EÉ]CESSAIRE|BESOINS?|POSSIBLE|APPLICABLE)\b)/.test(s || '');
// a company / demo record's declaration ("Name: ...", "Description: ..." lines) -> its description line, short
const declText = st => { if (!st) return null; const d = (String(st).match(/Description:\s*(.+)/) || [])[1]; return cut((d || String(st).split(/\r?\n/)[0]).trim(), 300); };
// evidence kinds: document_quote (a line of a CV) | declaration (a company record, user entered) | demo (a fictional record)
const KIND = { cv_document: 'document_quote', user_entered: 'declaration', demo: 'demo' };
const norm = x => String(x || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const sigmoid = x => (x == null || !Number.isFinite(Number(x)) ? null : Math.round(100 / (1 + Math.exp(-Number(x)))));
// one company, several spellings ("BIOMERIEUX SA" / "BIOMERIEUX S.A", "STE NACHD IT"): a legal form around the name is not part
// of it (dotted initials "S.A.S" joined first), as Parse Market's firmKey
const FIRM_TAIL = new Set(['sa', 'sas', 'sasu', 'sarl', 'eurl', 'sl', 'slu', 'srl', 'spa', 'se', 'sca', 'scop', 'scic', 'gmbh', 'ag', 'bv', 'nv', 'ltd', 'limited', 'inc', 'llc', 'plc', 'sprl']);
const FIRM_HEAD = new Set(['ste', 'societe', 'ets', 'etablissements']);
const firmKey = n => { const w = norm(n).replace(/\b[a-z](?: [a-z]\b)+/g, x => x.replace(/ /g, '')).split(' ').filter(Boolean);
  while (w.length > 1 && FIRM_TAIL.has(w[w.length - 1])) w.pop(); while (w.length > 1 && FIRM_HEAD.has(w[0])) w.shift(); return w.join(' '); };

const out = tenders.map(t => {
  const a = t.analysis || {}, rag = t.rag || {}, bp = t.buyer_profile || {}, m = t.market || {}, c = bp.contacts || {}, nc = (t.buyer && t.buyer.contacts) || {};
  const reqs = (t.requirements && t.requirements.items) || [];
  const ragOk = rag.status === 'ok', byId = new Map((rag.matrix || []).map(r => [r.requirement_id, r]));

  // ---- matrix: one row per verified requirement, with the RAG's status and its proof documents
  const rows = reqs.map(r => {
    const x = byId.get(r.id) || {};
    const coverage = !ragOk ? 'unknown' : x.status === 'covered' ? 'covered' : x.status === 'partial' ? 'partial' : 'gap';
    return { requirement_id: r.id, category: r.category, requirement: r.text, skill: r.rag_text || null, quote: r.quote, mandatory: !!r.mandatory, coverage,
      // the RAG reranker score as 0-100 (for a gap: the closest document's, i.e. how far the nearest proof is)
      coverage_score: { covered: 100, partial: 50, gap: 0 }[coverage] ?? null,         // from coverage (documented), not a fake precision
      rerank_score: x.best_rerank ?? (x.closest && x.closest.rerank) ?? null,           // the RAG reranker's raw score, for the curious
      // the proof: a quote from a CV, or a company record's declaration (never presented as a quote), or a fictional demo record
      origin: coverage === 'covered' || coverage === 'partial' ? x.origin || null : null,
      justification_kind: coverage === 'covered' || coverage === 'partial' ? (x.best_quote ? 'document_quote' : KIND[x.origin] || (x.statement ? 'declaration' : null)) : null,
      justification: x.best_quote || declText(x.statement) || null,
      // weak = the justification's document proves nothing by itself (no rule hit, reranker score below rerankPartial: a partial row's
      // "Professional Experience" at -5.65); is_header = the quote is only a header line. Both said, the justification is kept
      justification_weak: !!x.proof_weak, justification_is_header: !!x.quote_is_header,
      evidence: coverage === 'covered' || coverage === 'partial' ? (x.evidence || []).filter(e => e.doc_id).map(e => ({ asset_id: e.doc_id,
        asset_type: kindOf(e.doc_id, e.type), origin: e.origin || null, evidence_kind: e.quote ? 'document_quote' : KIND[e.origin] || (e.statement ? 'declaration' : null),
        title: cut(e.summary, 200) || null, snippet: cut(e.quote, 300) || declText(e.statement), metadata: e.metadata || null,
        proves: e.proves !== false })) : [],   // false = a weak neighbour the RAG listed (matched on nothing, low score), never shown as proof
      closest_asset: x.closest && x.closest.doc_id ? { asset_id: x.closest.doc_id, title: cut(x.closest.summary, 200) || null } : null };
  });
  const gaps = rows.filter(r => r.coverage === 'gap'), mandatoryGaps = gaps.filter(r => r.mandatory);
  const tech = rows.filter(r => r.category === 'technical' && r.coverage !== 'unknown');
  const techCov = tech.length ? tech.reduce((s, r) => s + (r.coverage === 'covered' ? 1 : r.coverage === 'partial' ? 0.5 : 0), 0) / tech.length : null;
  // recommendation: a rule on the matrix, written here (not an opinion)
  const partials = rows.filter(r => r.coverage === 'partial'), techPartials = partials.filter(r => r.category === 'technical').map(r => r.requirement_id);
  // rows proved only by fictional demo records (Join RAG keeps a row with a real CV / company proof out of them)
  const demoRows = rows.filter(r => r.origin === 'demo').map(r => r.requirement_id);
  // no matrix: the notice was too short to hold requirements (they are in the tender documents, DCE) or the RAG was not reached
  const docsHint = t.documents_url ? `: the requirements are in the tender documents, download them at ${t.documents_url}` : ': read the tender documents';
  // obligation sentences of the notice (doit, must, souhaité...) that no kept requirement quotes (Verify Analysis): the RAG never
  // checked them, so "every requirement is covered" would be false (the real Power BI demo: "L'accès doit être géré par rôles."
  // left out, the 6 rows covered -> "bid"). They turn a bid into a review, are named in every matrix reason and in the risks
  const notInMatrix = ((t.requirements && t.requirements.uncovered) || []).filter(Boolean).map(String);
  const clip = s => (s.length > 120 ? s.slice(0, 119).trimEnd() + '…' : s);
  const notInWhy = notInMatrix.length ? `${notInMatrix.length} obligation sentence(s) of the notice are not in the matrix (${notInMatrix.slice(0, 3).map(s => `"${clip(s)}"`).join(', ')}${notInMatrix.length > 3 ? ` +${notInMatrix.length - 3} more` : ''})` : '';
  // bid_with_partner also takes partial technical rows (the documented rule): the reason names them, never "covered" alone
  // (a RAG fault is named: "error: RAG returned an empty matrix" is no reason to read the tender documents)
  const ragFault = rag.status === 'error' && (rag.warnings || [])[0] ? `error: ${String(rag.warnings[0]).slice(0, 120)}` : '';
  const [rule, ruleWhy] = !ragOk ? ['review', ragFault ? `no requirements matrix (${ragFault})` : `no requirements matrix (${rag.status || 'RAG not called'})${docsHint}`]
    : !gaps.length && !partials.length ? ['bid', 'every requirement is covered by internal evidence']
    : mandatoryGaps.some(r => r.category === 'technical') && (techCov ?? 0) < 0.5
      ? ['no_bid', `mandatory technical requirement(s) without internal evidence: ${mandatoryGaps.filter(r => r.category === 'technical').map(r => r.requirement_id).join(', ')}`]
    : gaps.length && gaps.every(r => r.category !== 'technical')
      ? ['bid_with_partner', `technical requirements ${techPartials.length ? `covered or partial (${techPartials.join(', ')} partial)` : 'covered'}; gaps in ${[...new Set(gaps.map(r => r.category))].join(' / ')}: ${gaps.map(r => r.requirement_id).join(', ')}`]
      : ['review', `partial or missing evidence: ${[...partials, ...gaps].map(r => `${r.requirement_id} ${r.coverage}`).join(', ')}: check them before deciding`];
  const [recommendation, why] = !notInWhy || !ragOk ? [rule, ruleWhy]
    : rule === 'bid' ? ['review', `${notInWhy}: check them before deciding (the ${rows.length} requirement(s) of the matrix are covered by internal evidence)`]
    : [rule, `${ruleWhy}; ${notInWhy}`];
  // "covered" by a fictional record is not company evidence: the reason says which rows rest on demo records only
  const recommendation_reason = ragOk && demoRows.length ? `${why}; proof from fictional demo records only: ${demoRows.join(', ')}` : why;

  // ---- internal assets that prove a requirement (from the matrix), grouped like the deck uses them: for = the rows it proves,
  // weak_for = the rows where the RAG only listed it next to the proof; the suggested assets are the proving ones only
  const assets = new Map();
  for (const r of rows) for (const e of r.evidence) {
    const h = assets.get(e.asset_id) || { asset_id: e.asset_id, asset_type: e.asset_type, origin: e.origin, demo: e.origin === 'demo', title: e.title, for: [], weak_for: [] };
    const l = e.proves ? h.for : h.weak_for;
    if (!h.title && e.title) h.title = e.title; if (!l.includes(r.requirement_id)) l.push(r.requirement_id); assets.set(e.asset_id, h);
  }
  const ofType = k => [...assets.values()].filter(x => x.asset_type === k && x.for.length).map(x => x.asset_id);
  const coveredCount = rows.filter(r => r.coverage === 'covered').length, partialCount = rows.filter(r => r.coverage === 'partial').length;
  const ragStatus = !ragOk ? (rag.status === 'error' ? 'ERROR' : 'SKIPPED') : !coveredCount && !partialCount ? 'NONE' : coveredCount === rows.length ? 'FULL' : 'PARTIAL';

  // ---- what the RAG says is missing in the knowledge base, and the team it can staff from the CV bank
  const rowBySkill = new Map(rows.map(r => [norm(r.skill || r.requirement), r.requirement_id]));
  // mandatory: OUR flag (the tender's own words: "souhaitée" = no), the RAG marks every requirement mandatory by default
  const mandOf = id => { const r = rows.find(x => x.requirement_id === id); return r ? r.mandatory : null; };
  const knowledge_gaps = (rag.knowledge_gaps || []).map(g => { const id = rowBySkill.get(norm(g.requirement)) || null;
    return { requirement_id: id, requirement: g.requirement || null, category: g.category || null, mandatory: id ? mandOf(id) : g.mandatory ?? null,
      kind: g.kind || null, gap: g.gap || null, suggestion: g.suggestion || null }; });
  const tp = rag.team_proposal;
  const team_proposal = tp ? { size: tp.size ?? null, places_filled: tp.places_filled ?? null, places_needed: tp.places_needed ?? null,
    members: (tp.members || []).map(p => ({ name: p.name || null, asset_id: p.doc_id || null, title: p.title || null, seniority: p.seniority || null, years: p.years ?? null,
      roles: p.roles || [], certifications: p.certifications || [], assigned_to: (p.assigned_to || []).map(q => ({ requirement_id: rowBySkill.get(norm(q)) || null, requirement: q })) })),
    unfilled: (tp.unfilled || []).map(u => { const id = rowBySkill.get(norm(u.requirement)) || null;
      return { requirement_id: id, requirement: u.requirement, needed: u.needed ?? null, available: u.available ?? null, mandatory: id ? mandOf(id) : u.mandatory ?? null }; }),
    notes: tp.notes || [] } : null;
  // a certification asked by its acronym that no proof names (Join RAG: the RAG counts an equivalent one, CSM for PSM, as covered)
  const certRows = rows.filter(r => r.coverage === 'covered' || r.coverage === 'partial').map(r => [r.requirement_id, (byId.get(r.requirement_id) || {}).certs_not_in_proof || []]).filter(x => x[1].length);

  // ---- relevance: fit level + RAG coverage (a formula, shown in relevance_basis)
  const base = { high: 70, medium: 50 }[a.fit] ?? 30, cov = ragOk ? (rag.coverage ?? 0) : null;
  const relevance_score = Math.round(base + (cov != null ? 30 * cov : 0));

  // ---- competition (Competitor & Budget Agent)
  // a range: the amount is its high bound (the buyer's ceiling), the range itself is passed on; a range is far below the comparable
  // contracts when its high bound is, far above when its low bound is
  const range = parseRange(m.declared_value || t.estimated_value), declared = range ? range[1] : parseMoney(m.declared_value || t.estimated_value), b = m.budget || null;
  const [declaredLow, declaredShown] = range ? [range[0], `${range[0]}-${range[1]}`] : [declared, declared];
  // a win = a distinct award: DECP republishes one award under several ids (same buyer, date, amount, winners: one Essonne award
  // listed 3 times read as "won 4 comparable contracts"); the repeats seen in the comparables are taken off Parse Market's row count.
  // Never without an amount: two unpriced awards of one buyer on one day can be two contracts (lots), each stays a win
  const awardKey = (x, k) => (x.amount == null ? `row${k}` : [norm(x.buyer), x.date || '', x.amount, (x.winners || []).map(norm).sort().join('|')].join('#'));
  const repeats = n => { const won = (m.comparables || []).filter(x => (x.winners || []).some(w => norm(w) === norm(n))); return won.length - new Set(won.map(awardKey)).size; };
  const competition = { status: ({ studied: 'OK', no_comparable: 'NO_COMPARABLE', no_data: 'NO_DATA', not_studied: 'NOT_STUDIED' })[m.status || 'not_studied'] || 'FAILED',
    detail: m.status || 'not_studied', declared_value: m.declared_value || t.estimated_value || null, declared_value_amount: declared,
    declared_value_range: range ? { low: range[0], high: range[1] } : null,
    budget_estimate: b ? { low: b.low, mid: b.median, high: b.high, min: b.min, max: b.max, currency: b.currency, confidence: b.confidence, comparables: b.comparables,
      spread: b.spread ?? null, outliers: b.outliers || [], basis: b.basis } : null,
    competitors: (m.competitors || []).map(x => ({ name: x.name, past_wins: x.wins == null ? null : Math.max(0, x.wins - repeats(x.name)), past_losses: x.lost ?? null,
      avg_amount: x.avg_amount ?? null, last_win: x.last_win || null })).sort((x, y) => (y.past_wins ?? 0) - (x.past_wins ?? 0)),   // stable: Parse Market's order on ties
    median_bids: m.median_bids ?? null, positioning: m.positioning || null, budget_comment: m.budget_comment || null, comparables: (m.comparables || []).slice(0, 30) };

  // ---- key partners: the suppliers that won THIS buyer's own contracts, each with the awards that prove it: its BOAMP award
  // notices (Parse Research, the buyer's name gate) and its awarded contracts in DECP / TED / TUNEPS (Parse Market's buyer_awards:
  // by its SIREN or its name). One per company ("BIOMERIEUX SA" = "BIOMERIEUX S.A"); awards = the awards naming it, one award
  // published in BOAMP and in TED once (same title start, dates a week apart at most: BLUEDROP.FR's 26-37221 / T253087-2026). An IT /
  // digital supplier comes first: a ministry's furniture vendors are its suppliers too, not the ones a software proposal deals with.
  // An award proves IT work (software, data, web... in its title, or a CPV 72 / 48) for a winner it names ALONE; one naming several
  // (lots, co-contractors: who won which part is not said) only when it is about IT alone, no CPV outside 72 / 48 ("AOO AMOA SI", 6
  // consultancies). RESAH's T703576-2026 (CPV 38900000 + 48180000: test equipment AND maintenance software) names 3 medical-equipment
  // vendors: through it, their BOAMP notice 26-97793 (6 winners) made them IT suppliers ranked first; none of them is now.
  // Nothing else makes a partner: no award, none listed. key_partners = the names (the studio's and the UI's list of strings),
  // key_partners_detail = the same with their proof
  const partners = new Map(), titleKey = s => norm(s).slice(0, 40);
  const sameAward = (x, e) => (x.source === e.source && x.id === e.id) || (x.source !== e.source && !!titleKey(x.title) && titleKey(x.title) === titleKey(e.title)
    && Math.abs(new Date(x.date) - new Date(e.date)) <= 7 * 864e5);
  // one = IT for its single winner, all = IT for each of its winners, mixed = several winners, IT and other CPVs
  const itProof = (title, cpv, n) => { const c = String(cpv || '').split(',').map(s => s.trim()).filter(Boolean), it = c.filter(x => /^(72|48)/.test(x)).length, dig = isDigital(title) || it > 0;
    return { one: n <= 1 && dig, all: n > 1 && dig && it === c.length, mixed: n > 1 && it > 0 && it < c.length }; };
  const addPartner = (name, evidence, n) => {
    const k = firmKey(name); if (!k || !evidence.length) return;
    const p = partners.get(k) || { name: String(name).trim(), awards: 0, evidence: [] };
    // (a copy adds no award; it may still tell the award is IT, TED's CPV 48 for a BOAMP notice without one: then it is listed too,
    // being the proof; or that the award is mixed)
    const fresh = [], proofs = [];
    for (const e of evidence) { const x = p.evidence.find(y => sameAward(y, e)); if (!x) { fresh.push(e); continue; }
      if (!x.one && !x.all && (e.one || e.all)) proofs.push(e); for (const f of ['one', 'all', 'mixed']) x[f] = x[f] || e[f]; }
    if (fresh.length) { p.awards += n; p.evidence.push(...fresh); }
    p.evidence.push(...proofs);
    partners.set(k, p);
  };
  for (const x of bp.competitors || []) addPartner(x.name, (x.awards || []).filter(a => a.id).map(a => ({ source: 'BOAMP', id: a.id, date: a.date || null, title: cut(a.title, 160),
    amount: null, currency: null, ...itProof(a.title, '', (a.winners || []).length), url: `https://www.boamp.fr/pages/avis/?q=idweb:${encodeURIComponent(a.id)}` })), x.wins || (x.awards || []).length);
  for (const x of m.buyer_awards || []) for (const w of new Set(x.winners || [])) addPartner(w, x.id ? [{ source: x.source || null, id: x.id, date: x.date || null, title: cut(x.title, 160),
    amount: x.amount ?? null, currency: x.amount != null ? x.currency || null : null, ...itProof(x.title, x.cpv, new Set(x.winners || []).size),
    url: x.source === 'TED' && /^T\d+-\d{4}$/.test(x.id) ? `https://ted.europa.eu/en/notice/-/detail/${x.id.slice(1)}` : null }] : [], 1);
  const key_partners = [...partners.values()].map(p => { for (const e of p.evidence) e.digital = e.one || (e.all && !e.mixed);
    const ev = p.evidence.sort((a, z) => (z.digital - a.digital) || String(z.date || '').localeCompare(String(a.date || ''))), it = ev.some(e => e.digital);
    return { name: p.name, relation: it ? 'past IT / digital supplier' : 'past supplier', awards: p.awards, last_award: ev.map(e => e.date).filter(Boolean).sort().pop() || null,
      evidence: ev.slice(0, 3).map(({ digital, one, all, mixed, ...e }) => e) }; })
    .sort((a, z) => (z.relation !== 'past supplier') - (a.relation !== 'past supplier') || z.awards - a.awards || String(z.last_award || '').localeCompare(String(a.last_award || ''))).slice(0, 8);

  // ---- risks: facts only
  const text = `${t.title || ''} ${t.description || t.body_text || ''} ${reqs.map(r => `${r.text} ${r.quote}`).join(' ')}`;
  const risks = [
    t.days_left == null ? 'No deadline found in the notice: check the tender documents' : t.days_left < 15 ? `Short deadline: ${t.days_left} days left` : '',
    mandatoryGaps.length ? `No internal evidence for mandatory requirement(s): ${mandatoryGaps.map(r => r.requirement_id).join(', ')}` : '',
    notInMatrix.length ? `Obligation(s) of the notice not in the requirements matrix (never checked against internal evidence): ${notInMatrix.map(s => `"${s}"`).join(' | ')}` : '',
    demoRows.length ? `Proof from FICTIONAL demo records (not company references): ${demoRows.join(', ')}` : '',
    // the service lines are not the model's clear answer: none matched, or found only in its reason, or it listed every service
    (a.checks || []).some(c => /^(no_service_matched|services_from_reason|services_all_listed)$/.test(c))
      ? `Service lines not stated clearly by the analysis (${(a.checks || []).filter(c => /^(no_service_matched|services_from_reason|services_all_listed)$/.test(c)).join(', ')}): check which OliveSoft services the tender needs` : '',
    certRows.length ? `Certification asked but not named in the proof (an equivalent one?): ${certRows.map(([id, a]) => `${id} ${a.join('/')}`).join(', ')}` : '',
    team_proposal && team_proposal.unfilled.length ? `Team: ${team_proposal.unfilled.map(u => `${u.requirement} (${u.available ?? 0} of ${u.needed ?? '?'} available)`).join('; ')} cannot be staffed from the CV bank` : '',
    !ragOk ? `No requirements matrix (${rag.status || 'RAG not called'})` : '',
    t.requirements && t.requirements.low_input ? 'The notice gives little detail: read the full tender documents (RC / CCTP)' : '',
    /accord[- ]cadre|framework agreement/i.test(text) ? 'Framework agreement: the amount is a ceiling, orders are not guaranteed' : '',
    /(souverain|sovereign|secnumcloud|\bhds\b)/i.test(text) ? 'Sovereign / certified hosting required' : '',
    competition.median_bids >= 8 ? `Strong competition: median ${competition.median_bids} bids on comparable contracts` : '',
    competition.competitors[0] && competition.competitors[0].past_wins >= 2 ? `${competition.competitors[0].name} won ${competition.competitors[0].past_wins} comparable contracts` : '',
    declared && b && b.currency === 'EUR' && declared < b.low / 2 ? `Declared value (${declaredShown}) far below comparable contracts (median ${b.median})` : '',
    declared && b && b.currency === 'EUR' && declaredLow > b.high * 3 ? `Declared value (${declaredShown}) far above comparable contracts (median ${b.median}): maybe a multi-year ceiling` : '',
  ].filter(Boolean);

  // the short skill lines (English, "PostgreSQL", "Minimum 3 senior developers"); the full sentence + quote are in matrix.rows
  const by = cat => reqs.filter(r => r.category === cat).map(r => r.rag_text || r.text);
  return { json: {
    contract: 'olivesoft.proposal-input.v2', tender_id: t.tender_id, language: t.language || null, rank: rankOf.get(t.tender_id), run_id: cfg.runId, generated_on: cfg.today,
    tender: { title: t.title, reference: t.external_id || t.tender_id, issuer: (t.buyer && t.buyer.name) || null, country: countryName(t.buyer && t.buyer.country),
      country_code: (t.buyer && t.buyer.country) || null, publication_date: t.publication_date || null, deadline: t.effective_deadline || null, days_to_deadline: t.days_left ?? null,
      estimated_value: t.estimated_value || null, cpv: t.cpv || [], duration: t.duration || (t.analysis && t.analysis.timeline) || null, source: t.source, source_url: t.source_url || null,
      submission_url: t.submission_url || null, documents_url: t.documents_url || null, description: cut(t.description || t.body_text, 4000), lots: t.lots || [], award_criteria: t.award_criteria || [] },
    analysis: { relevance_score, relevance_basis: `fit ${a.fit} (${base})${cov != null ? ` + 30 x RAG coverage ${cov}` : ' (no RAG coverage)'}`,
      fit: a.fit, tender_type: a.tender_type, matched_service_lines: a.matched_services || [],
      // no reason sentence (the model put the services there): the verified quote says why it fits, in the tender's own words
      reason: a.reason || (a.quote_verified && a.quote ? `Tender text: "${cut(a.quote, 300)}"` : null),
      proof_quote: a.quote || null, quote_verified: !!a.quote_verified, sector: a.sector || null, suggested_angle: null, risks,
      requirements: { technical: by('technical'), team: by('team'), experience: by('experience'), timeline: a.timeline || null } },
    buyer_profile: { name: (t.buyer && t.buyer.name) || null, legal_name: bp.legal_name || null, sector: BUYER_SECTOR[bp.buyer_type] || null, size: bp.size_hint && bp.size_hint !== 'unknown' ? bp.size_hint : null,
      organization_description: bp.summary || null, estimated_revenue: bp.estimated_revenue || null, staff: bp.staff || null,
      website: siteOf(bp.official_website) || siteOf(nc.website),
      // researched buyers: verified contacts; others: the contacts written in the notice itself
      contacts: { emails: c.emails || [nc.email].filter(Boolean), phones: c.phones || [nc.phone].filter(Boolean), addresses: c.addresses || [nc.address].filter(Boolean) },
      past_digital_projects: (bp.past_projects || []).filter(p => isDigital(p.title)).slice(0, 8).map(p => ({ title: p.title, date: p.date || null, source: p.source || null })),
      past_winners: (bp.competitors || []).slice(0, 8).map(x => ({ name: x.name, wins: x.wins })),
      key_partners: key_partners.map(p => p.name), key_partners_detail: key_partners,
      domain_requirements: reqs.filter(r => DOMAIN.test(r.text) || DOMAIN.test(r.rag_text || '')).map(r => r.rag_text || r.text),
      research_status: bp.research_status || null, enrichment_status: bp.enrichment_status || null },
    rag: { status: ragStatus, data_mode: rag.data_mode || null, coverage_basis: rag.coverage_basis || null, suggested_assets: { projects: ofType('project'), team: ofType('cv'), stack: ofType('stack'), other: ofType('document') }, assets: [...assets.values()], team_proposal, knowledge_counts: rag.knowledge_counts || null },
    matrix: { status: ragOk ? 'OK' : rag.status === 'error' ? 'ERROR' : 'SKIPPED', rows,
      summary: { fit_score: rag.fit ? (f => (f.length ? Math.round(f.reduce((s, v) => s + v, 0) / f.length) : null))([rag.fit.technical, rag.fit.team, rag.fit.experience].filter(v => v != null)) : null,
        rag_overall: rag.fit ? rag.fit.overall ?? null : null,
        by_category: { technical: rag.fit ? rag.fit.technical ?? null : null, team: rag.fit ? rag.fit.team ?? null : null, experience: rag.fit ? rag.fit.experience ?? null : null },
        covered: coveredCount, partial: partialCount, gaps: gaps.length, gaps_list: gaps.map(r => r.requirement_id), mandatory_gaps: mandatoryGaps.map(r => r.requirement_id),
        obligations_not_in_matrix: notInMatrix,   // the notice's own sentences (original language): coverage unknown, a person reads them
        coverage: cov, blocking: rag.blocking || [], demo_evidence: demoRows, knowledge_gaps, recommendation, recommendation_reason } },
    competition,
    options: JSON.parse(JSON.stringify((cfg.proposal && cfg.proposal.options) || {})),
    company: { name: cfg.company.name, services: cfg.company.services, technologies: cfg.company.technologies },
  } };
});
if (!out.length) return [];                       // nothing to send (Run Summary says why: no fit tender open for bidding)
try {
  out[0].binary = { proposal_inputs: await this.helpers.prepareBinaryData(Buffer.from(JSON.stringify(out.map(o => o.json), null, 1), 'utf8'), `proposal_inputs_${cfg.today}.json`, 'application/json') };
} catch {}
return out;
