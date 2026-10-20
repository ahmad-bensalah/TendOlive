// Join RAG (requirements matrix). Reads the answer of your RAG service (POST /retrieve/tender, checked 2026-10-19):
//   requirements_matrix[]: {requirement, category, mandatory, status covered|partial|missing, found, needed, best_doc, evidence (a quote), closest_doc}
//   requirement_matches[]: {requirement, category, matches[{doc_id, type, summary, rerank_score, matched_on[], evidence:{quote}}], closest}
//   fit_score {technical_fit, team_fit, experience_fit, domain_fit, certification_fit, overall}, warnings[] ("BLOCKING - ..." = mandatory gap)
// Since 2026-10-20 also: origin per row / match (cv_document = a quote from a CV | user_entered = a company record, a
// DECLARATION, not a document quote | demo = fictional, never a company reference), evidence {kind, quote, statement},
// team_proposal {members, unfilled...}, knowledge_gaps [{requirement, kind, gap, suggestion}], data_mode, coverage_basis.
// The service's own status is used (its reranker + rules such as "2 references needed, 1 found"). Only a row without a status
// gets one from its best reranker score (Config rag.rerankCovered / rerankPartial). Rows are matched to OUR requirements by
// text (our ids are not sent); a requirement the service did not answer counts as missing, an answer with no row at all is a
// RAG fault (status error, as a failed call).
/*@lib fold*/
const cfg = $('00 - Config').first().json;
const { rerankCovered: COV, rerankPartial: PART } = cfg.rag;
const STATUS = ['covered', 'partial', 'missing'];
const isHeader = q => { const s = String(q || '').trim(); return s.length < 25 || /:$/.test(s) || /^#+\s/.test(s) || (s === s.toUpperCase() && /[A-Z]/.test(s) && s.length < 80); };
// a RAG window chunk that starts inside a sentence: its first word is all lower case ("payments. Proven ability to translate ...
// into interactive Power BI dashboards", never "iOS ..." / "jQuery ..."). As the row's proof (the deck's justification) it loses
// the leading fragment up to the first sentence break, only when a term the RAG matched (matched_on) is still in the rest (no term
// known = left as is: the fragment can hold the proof itself, "and build CRM solutions on Salesforce. Passionate about ..."); the
// rest gets "..." when it stops mid-sentence. Display only: the certification check reads the RAG's own text
const isFragment = q => /^\p{Ll}+(?=[\s,.;:!?])/u.test(String(q || ''));
const tidy = (q, terms) => { const s = String(q || ''), m = /^\p{Ll}+(?=[\s,.;:!?])[^.!?]*[.!?]\s+(?=[\p{Lu}\d])/u.exec(s); if (!m) return q;
  const r = s.slice(m[0].length).trimEnd(); return (terms || []).some(x => r.toLowerCase().includes(String(x).toLowerCase())) ? (/[.!?…)"»]$/.test(r) ? r : r + '…') : q; };
const pick = (o, ...ks) => { for (const k of ks) if (o && o[k] !== undefined && o[k] !== null) return o[k]; };
const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100) / 100);
// the certifications a requirement asks by acronym: only the words next to a certif* word (2 before / 2 after, or the first
// bracket just after it, in its clause), so "1 PSM certified Scrum Master" asks PSM and "AWS certified architect for CRM hosting"
// asks AWS, not CRM. Acronyms of 3+ capitals (PMP, PSM, ITIL, CKA) with their number (ISO 27001), never "OR", "EU", "UX".
// Alternatives ("PMP or PRINCE2 certified", "PSM/CSM") are one group "PMP|PRINCE2": asked = one of them
const certAsked = s => [...new Set(String(s || '').replace(/\b([A-Z][A-Z0-9]{2,7}(?:[\s-]?\d{3,5})?)\s*(?:\/|\b(?:or|ou|oder)\b)\s*(?=[A-Z][A-Z0-9]{2,7}\b)/g, '$1|')
  .split(/[;,]|\.\s/).flatMap(cl => { const w = cl.trim().split(/\s+/);
    return w.flatMap((x, i) => (/certifi|zertifi/i.test(x) ? [`${w.slice(Math.max(0, i - 2), i + 3).join(' ')} ${(w.slice(i + 1, i + 5).join(' ').match(/\([^)]*\)/) || [''])[0]}`] : [])); })
  .flatMap(z => z.match(/\b[A-Z][A-Z0-9]{2,7}(?:[\s-]?\d{3,5})?(?:\|[A-Z][A-Z0-9]{2,7}(?:[\s-]?\d{3,5})?)*\b/g) || []))];
// a proof names it when each letter / digit part stands in it on its own: "ISO27001" is named by "ISO 27001" or "ISO/IEC 27001",
// "PSM" is not named by "CSM" (case ignored: a CV writes "Itil" too)
const named = (a, txt) => (a.match(/[A-Z]+|\d+/g) || []).every(p => new RegExp(/\d/.test(p) ? `(?<!\\d)${p}(?!\\d)` : `(?<![A-Za-z])${p}(?![A-Za-z])`, 'i').test(txt));
const out = [];
const items = $input.all();
for (let i = 0; i < items.length; i++) {
  const t = { ...$('Join Buyers & Build RAG').itemMatching(i).json };
  const run = t._run, sentMode = t.rag_body && t.rag_body.data_mode; delete t._run; delete t.rag_body;
  if (t._type || !t.survivor) { out.push({ json: t }); continue; }
  const rag = { status: run ? 'error' : 'skipped_no_requirements', matrix: [], warnings: [] };
  const d = run ? items[i].json || {} : null;
  const rows = run && !d.error ? [].concat(pick(d, 'requirements_matrix', 'matrix') || []) : [];
  if (run && d.error) rag.warnings.push('RAG call failed: ' + String((d.error && (d.error.message || d.error.description)) || d.error).slice(0, 200));
  // an answer with no row at all (HTTP 200 with {} or an empty matrix) is a RAG fault, not "none of our requirements is covered":
  // it stays an error (no matrix: the proposal input says review, never no_bid), with the RAG's own warnings
  else if (run && !rows.length) rag.warnings.push('RAG returned an empty matrix', ...[].concat(d.warnings || []).map(String));
  else if (run) {
    const reqs = t.requirements.items;
    const order = ['technical', 'team', 'experience'].flatMap(c => reqs.filter(r => r.category === c));   // the order we sent them in
    const details = [].concat(d.requirement_matches || []);
    const used = new Set();
    rag.matrix = rows.map((m, k) => {
      const text = String(pick(m, 'requirement', 'text') || '');
      const mine = reqs.find(r => !used.has(r.id) && fold(r.rag_text || r.text) === fold(text)) || (order[k] && !used.has(order[k].id) ? order[k] : null);
      if (mine) used.add(mine.id);
      const det = details.find(x => fold(x.requirement) === fold(text)) || {};
      const raw = det.matches || (Array.isArray(m.evidence) ? m.evidence : []);
      // a document PROVES the row when the RAG says so: one of its rules matched in it (matched_on) or its reranker score reaches
      // the partial threshold (no signal at all, older answers: trusted as listed). A weak CV next to a demo record (matched on
      // nothing, rerank -3.9 for "1 deployed AI chatbot reference") proves nothing, so that row stays demo
      const proves = e => (e.matched_on ? e.matched_on.length > 0 || (e.rerank != null && e.rerank >= PART) : e.rerank == null || e.rerank >= PART);
      const real = e => !!(e.origin && e.origin !== 'demo' && proves(e));   // a CV quote / company record, never a fictional one
      // every proof document is kept (a cap at 2 dropped the only real CV proof behind 2 demo records), by reranker score (the RAG's
      // order on ties), then real proofs first (in demo mode the RAG lists demo records first even when a CV matches as well or better)
      const all = raw.map(e => ({ doc_id: pick(e, 'doc_id', 'id') || null, type: e.type || null, summary: pick(e, 'summary', 'title') || '',
        origin: e.origin || null, kind: (e.evidence && e.evidence.kind) || null,
        statement: (e.evidence && typeof e.evidence === 'object' && e.evidence.statement) || null,
        quote: e.evidence && typeof e.evidence === 'object' ? e.evidence.quote || '' : pick(e, 'quote', 'text', 'chunk') || '',
        rerank: num(pick(e, 'rerank_score', 'reranker_score', 'cross_score')), matched_on: Array.isArray(e.matched_on) ? e.matched_on : null,
        metadata: e.metadata || e.meta || null }))   // metadata (year, sector, stack...) passed through when the RAG gives it
        .sort((x, y) => (y.rerank ?? -99) - (x.rerank ?? -99));
      const ev = all.slice().sort((x, y) => real(y) - real(x));   // stable: by score within each group
      // the RAG's own lead document (its best_doc, else its top match): the row's proof when no real one replaces a demo record, so
      // quote, origin, statement and best_doc all come from ONE document (never a CV line under a demo record's origin)
      const lead = all.find(e => m.best_doc && e.doc_id === m.best_doc) || all[0] || null;
      const best = ev.reduce((b, e) => (e.rerank != null && (b == null || e.rerank > b) ? e.rerank : b), null);
      const service = STATUS.includes(m.status) ? m.status : null;
      const status = service || (best == null ? 'missing' : best >= COV ? 'covered' : best >= PART ? 'partial' : 'missing');
      // the RAG's row origin is its best_doc's: a demo record while real proofs are listed too -> the best real proof is the row's
      // proof (quote, origin, best_doc), the demo record stays as extra evidence. Not when the RAG needs N documents ("2+ projects")
      // and fewer than N real ones are listed: then the coverage still rests on fictional records
      // Among real proofs of the same score (the RAG gives none in rules mode: its order), one whose quote is a whole sentence beats
      // a mid-sentence chunk ("operational visibility through Datadog monitoring. Proficient in Python" vs "Automated data ingestion
      // ... using Python and Airflow"), and goes first in the evidence (a higher score always wins)
      const reals = ev.filter(real);
      const swap = status !== 'missing' && m.origin === 'demo' && reals.length && reals.length >= Math.max(1, Number(m.needed) || 1)
        ? reals.find(e => e.rerank === reals[0].rerank && !isFragment(e.quote)) || reals[0] : null;
      if (swap && ev[0] !== swap) ev.unshift(...ev.splice(ev.indexOf(swap), 1));
      // a document quote (CV) or, for a company / demo record, its declaration (never presented as a quote)
      const quote = swap ? swap.quote || null : typeof m.evidence === 'string' ? m.evidence : (lead && lead.quote) || null;
      const origin = swap ? swap.origin : m.origin || (status !== 'missing' && lead && lead.origin) || null;
      const statement = swap ? (!quote && swap.statement) || null : m.statement || (!quote && lead && lead.statement) || null;
      const bestDoc = swap ? swap.doc_id : m.best_doc || (lead && lead.doc_id) || null;
      // proves: this document supports the row (a rule hit, a score at the partial threshold, or the row's own proof of a COVERED row);
      // false = a weak neighbour the RAG listed too (a CV matched on nothing at -4.1 for "1 deployed AI chatbot reference"), kept but
      // never a proof. A partial row's own document with no rule hit below rerankPartial proves nothing either (the RAG's "weak
      // evidence only": CV_05 "Professional Experience" at -5.65 was a suggested team asset): the row keeps it as its justification,
      // flagged proof_weak, and never as a suggested asset
      const evidence = ev.map(e => ({ ...e, proves: status !== 'missing' && (proves(e) || (!!bestDoc && e.doc_id === bestDoc && status === 'covered')) }));
      // the row's proof document: its score is the row's best_rerank (the row's highest score can be a demo record swapped out above)
      const bestEv = bestDoc ? evidence.find(e => e.doc_id === bestDoc) || null : null;
      const shown = tidy(quote, bestEv && bestEv.matched_on), quoteIsHeader = status !== 'missing' && !!shown && isHeader(shown);
      if (quoteIsHeader) rag.warnings.push(`evidence for "${text.slice(0, 50)}" is only a header line (${bestDoc})`);
      // a certification asked by its acronym that no proof names ("1 PSM certified Scrum Master" covered by "Certified Scrum Master
      // (CSM)": the RAG aliases equivalent ones): the RAG's status is kept, but it is said, never presented as the asked certificate.
      // Proofs = the row's own and the documents that prove it (not a weak neighbour)
      const proofText = [quote, statement, m.statement, ...evidence.filter(e => e.proves).map(e => `${e.quote} ${e.statement || ''} ${e.summary}`)].filter(Boolean).join(' ');
      const certsNotInProof = status === 'missing' ? [] : certAsked(text).filter(g => !g.split('|').some(a => named(a, proofText))).map(g => g.replace(/\|/g, '/'));
      const id = mine ? mine.id : `X${k + 1}`;
      if (certsNotInProof.length) rag.warnings.push(`${id} "${text.slice(0, 60)}" is ${status} but no proof names ${certsNotInProof.join(', ')} (${bestDoc}${quote ? `: "${quote.slice(0, 80)}"` : ''}): check the certification held is accepted`);
      const closest = status === 'covered' ? null : det.closest ? { doc_id: det.closest.doc_id, summary: det.closest.summary || '', rerank: num(det.closest.rerank_score) }
        : m.closest_doc ? { doc_id: m.closest_doc } : null;
      return { requirement_id: id, category: mine ? mine.category : pick(m, 'category') || null, requirement: mine ? mine.text : text, rag_query: text,
        mandatory: mine ? !!mine.mandatory : !!m.mandatory, status, status_source: service ? 'rag' : 'reranker_threshold',
        found: m.found ?? null, needed: m.needed ?? null, best_doc: bestDoc, best_quote: shown,
        best_rerank: bestEv ? bestEv.rerank : best, origin, statement, proof_weak: status !== 'missing' && !!bestEv && !bestEv.proves, quote_is_header: quoteIsHeader,
        evidence: evidence.map(e => ({ ...e, quote: tidy(e.quote, e.matched_on) })), certs_not_in_proof: certsNotInProof, closest };
    });
    // a requirement the service did not answer counts as missing (coverage is over what we SENT, not what came back)
    const lost = reqs.filter(r => !used.has(r.id));
    for (const r of lost) rag.matrix.push({ requirement_id: r.id, category: r.category, requirement: r.text, mandatory: r.mandatory, status: 'missing', status_source: 'not_returned', best_doc: null, evidence: [], closest: null });
    if (lost.length) rag.warnings.push(`RAG answered ${reqs.length - lost.length} of ${reqs.length} requirements`);
    const n = rag.matrix.length, c = rag.matrix.filter(m => m.status === 'covered').length, p = rag.matrix.filter(m => m.status === 'partial').length;
    const fs = pick(d, 'fit_score', 'fit') || {};
    const warnings = [].concat(d.warnings || []).map(String);
    Object.assign(rag, { status: 'ok', total: n, covered: c, partial: p, missing: n - c - p,
      coverage: n ? Math.round(((c + 0.5 * p) / n) * 100) / 100 : null,
      mandatory_missing: rag.matrix.filter(m => m.mandatory && m.status === 'missing').length,
      fit: { overall: fs.overall ?? null, technical: fs.technical_fit ?? fs.technical ?? null, team: fs.team_fit ?? fs.team ?? null,
        experience: fs.experience_fit ?? fs.experience ?? null, domain: fs.domain_fit ?? fs.domain ?? null, certification: fs.certification_fit ?? null },
      // blocking = OUR mandatory requirements without evidence (the RAG marks every requirement mandatory by default)
      blocking: rag.matrix.filter(m => m.mandatory && m.status === 'missing').map(m => `${m.requirement_id}: ${m.requirement}`),
      best_docs: [...new Set(rag.matrix.filter(m => m.status !== 'missing' && m.best_doc).map(m => m.best_doc))].slice(0, 5),
      data_mode: d.data_mode || sentMode || null, coverage_basis: d.coverage_basis || null, knowledge_counts: d.knowledge_counts || null,
      // rows proved only by fictional demo records (no real proof listed, see the swap above): shown, never as a company reference
      demo_evidence: rag.matrix.filter(m => m.status !== 'missing' && m.origin === 'demo').map(m => m.requirement_id),
      team_proposal: d.team_proposal || null, knowledge_gaps: [].concat(d.knowledge_gaps || []) });
    rag.warnings.push(...warnings);
  }
  t.rag = rag;
  out.push({ json: t });
}
return out;
