// Rank & Export. Order = fit (high, medium), then RAG coverage (grounded relevance), then nearest deadline; too-late
// survivors last. One flat row per KEPT tender (survivors first, ranked). The first row also carries the full CSV and JSON
// as binary files (download them from this node's output, or wire them to Google Drive / email / Write File).
// canonical_id + pair_key columns feed "01 - Load Known IDs" on the next run (incremental runs); URL-source notices dropped for
// good follow as unranked status "dropped" rows (for the sheet only, see below).
/*@lib hostOfUrl PLATFORM_HOST*/
const cfg = $('00 - Config').first().json;
const all = $input.all().map(i => i.json);
const FIT = { high: 3, medium: 2, low: 1, none: 0 };
const kept = all.filter(t => !t._type && t.status === 'kept');
const cov = t => (t.rag && t.rag.coverage) ?? 0;              // RAG down / no requirements = unknown, ranked like 0 (the deadline decides)
const survivors = kept.filter(t => t.survivor).sort((a, b) => (!!a.too_late - !!b.too_late) || (FIT[b.analysis.fit] - FIT[a.analysis.fit])
  || (cov(b) - cov(a)) || String(a.effective_deadline || '9999').localeCompare(String(b.effective_deadline || '9999')));
survivors.forEach((t, i) => { t.rank = i + 1; });
const rows = [...survivors, ...kept.filter(t => !t.survivor)];
const j = (a, s = '; ') => (Array.isArray(a) ? a.filter(Boolean).join(s) : a || '');
// a buyer website = a web host (it has a dot) that is no tender platform, as Parse Research checks it (defence in depth: the
// recorded run exported "https://undefined", a Wikidata row without website=; notices give the platform's buyer page)
const siteOf = w => { const h = String(w ?? '').trim() ? hostOfUrl(w) : ''; return h.includes('.') && !PLATFORM_HOST.test(h) ? w : ''; };
const cols = {
  // no keys for a tender whose analysis failed: the next run sees it as new and analyses it again
  rank: t => t.rank ?? '', tender_id: t => t.tender_id, canonical_id: t => (t.analysis && t.analysis.status === 'failed' ? '' : t.canonical_id),
  pair_key: t => (t.analysis && t.analysis.status === 'failed' ? '' : t.pair_key), analysis_status: t => t.analysis && t.analysis.status,
  source: t => j([t.source, ...(t.also_seen_in || []).map(x => x.source)], ' + '), source_url: t => t.source_url, country: t => t.buyer && t.buyer.country,
  title: t => t.title, buyer: t => t.buyer && t.buyer.name, notice_type: t => t.notice_type, publication_date: t => t.publication_date,
  deadline: t => t.effective_deadline, days_left: t => t.days_left ?? '', too_late: t => !!t.too_late,
  tender_type: t => t.analysis && t.analysis.tender_type, fit: t => t.analysis && t.analysis.fit, fit_llm: t => t.analysis && t.analysis.fit_llm,
  fit_reason: t => t.analysis && (t.analysis.reason || (t.analysis.quote_verified && t.analysis.quote ? `Tender text: "${t.analysis.quote}"` : '')), quote_verified: t => t.analysis && t.analysis.quote_verified, analysis_checks: t => j(t.analysis && t.analysis.checks, ' '),
  sector: t => t.analysis && t.analysis.sector, timeline: t => t.analysis && t.analysis.timeline,
  requirements_technical: t => j(((t.requirements && t.requirements.items) || []).filter(r => r.category === 'technical').map(r => r.text)),
  requirements_team: t => j(((t.requirements && t.requirements.items) || []).filter(r => r.category === 'team').map(r => r.text)),
  requirements_experience: t => j(((t.requirements && t.requirements.items) || []).filter(r => r.category === 'experience').map(r => r.text)),
  requirements_dropped: t => (t.requirements && t.requirements.dropped && t.requirements.dropped.length) || '',
  // obligation sentences of the notice that no kept requirement quotes (Verify Analysis): never sent to the RAG, read them
  requirements_uncovered: t => j(t.requirements && t.requirements.uncovered, ' | '), low_input: t => (t.requirements && t.requirements.low_input) || '',
  rag_status: t => t.rag && t.rag.status, rag_coverage: t => t.rag && t.rag.coverage, rag_covered: t => t.rag && t.rag.covered,
  rag_partial: t => t.rag && t.rag.partial, rag_missing: t => t.rag && t.rag.missing, rag_mandatory_missing: t => t.rag && t.rag.mandatory_missing,
  rag_fit_overall: t => t.rag && t.rag.fit && t.rag.fit.overall, rag_technical_fit: t => t.rag && t.rag.fit && t.rag.fit.technical,
  rag_team_fit: t => t.rag && t.rag.fit && t.rag.fit.team, rag_experience_fit: t => t.rag && t.rag.fit && t.rag.fit.experience,
  rag_domain_fit: t => t.rag && t.rag.fit && t.rag.fit.domain, rag_blocking: t => j(t.rag && t.rag.blocking, ' | '),
  best_docs: t => j(t.rag && t.rag.best_docs, ' | '),
  // nearest internal documents for requirements the RAG marked missing (not evidence: a lead for the bid team)
  closest_docs: t => j([...new Set(((t.rag && t.rag.matrix) || []).filter(m => m.status === 'missing' && m.closest && m.closest.doc_id).map(m => m.closest.doc_id))].slice(0, 5), ' | '),
  rag_warnings: t => j(t.rag && t.rag.warnings, ' | '),
  buyer_research: t => t.buyer_profile && t.buyer_profile.research_status, buyer_enrichment: t => t.buyer_profile && t.buyer_profile.enrichment_status,
  buyer_type: t => t.buyer_profile && t.buyer_profile.buyer_type, buyer_summary: t => t.buyer_profile && t.buyer_profile.summary,
  buyer_legal_name: t => t.buyer_profile && t.buyer_profile.legal_name,
  buyer_website: t => siteOf(t.buyer_profile && t.buyer_profile.official_website) || siteOf(t.buyer && t.buyer.contacts && t.buyer.contacts.website),
  buyer_emails: t => j((t.buyer_profile && t.buyer_profile.contacts && t.buyer_profile.contacts.emails) || [t.buyer && t.buyer.contacts && t.buyer.contacts.email], ' '),
  buyer_phones: t => j((t.buyer_profile && t.buyer_profile.contacts && t.buyer_profile.contacts.phones) || [t.buyer && t.buyer.contacts && t.buyer.contacts.phone], ' '),
  buyer_revenue: t => t.buyer_profile && t.buyer_profile.estimated_revenue, buyer_staff: t => t.buyer_profile && t.buyer_profile.staff,
  buyer_past_projects: t => j(((t.buyer_profile && t.buyer_profile.past_projects) || []).slice(0, 5).map(p => `[${p.date || ''}] ${p.title}`)),
  // every winner of this buyer's past contracts, any field (the tender-specific competitors are the market_* columns)
  buyer_past_winners: t => j(((t.buyer_profile && t.buyer_profile.competitors) || []).map(c => `${c.name} (${c.wins})`)),
  buyer_contracts_median: t => t.buyer_profile && t.buyer_profile.budget_signals && t.buyer_profile.budget_signals.median,
  buyer_contracts_currency: t => t.buyer_profile && t.buyer_profile.budget_signals && t.buyer_profile.budget_signals.currency,
  // Competitor & Budget Agent: budget range and competitors from awarded contracts comparable to THIS tender
  market_status: t => t.market && t.market.status, market_budget_low: t => t.market && t.market.budget && t.market.budget.low,
  market_budget_median: t => t.market && t.market.budget && t.market.budget.median, market_budget_high: t => t.market && t.market.budget && t.market.budget.high,
  // the range is in the currency most chosen contracts use (TND for Tunisia, EUR for France): one column mixes both, so a
  // reader or a sort never compares 165735 TND with 25712 EUR as one unit
  market_budget_currency: t => t.market && t.market.budget && t.market.budget.currency,
  market_budget_confidence: t => t.market && t.market.budget && t.market.budget.confidence, market_comparables: t => t.market && t.market.budget && t.market.budget.comparables,
  market_competitors: t => j(((t.market && t.market.competitors) || []).map(c => `${c.name} (${c.wins})`)), market_median_bids: t => t.market && t.market.median_bids,
  market_positioning: t => t.market && t.market.positioning, market_notes: t => j(t.market && t.market.checks, ' | '),
  estimated_value: t => t.estimated_value, cpv: t => j(t.cpv, ' '), duration: t => t.duration, submission_url: t => t.submission_url, documents_url: t => t.documents_url,
  relaunch_of: t => t.relaunch_of, flags: t => j(t.flags, ' '),
};
const esc = v => { const s = v == null ? '' : String(v).replace(/[\r\n]+/g, ' '); return /[",;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = '\uFEFF' + [Object.keys(cols).join(','), ...rows.map(t => Object.values(cols).map(f => esc(f(t))).join(','))].join('\r\n');
const flatOf = t => Object.fromEntries(Object.entries(cols).map(([k, f]) => { const v = f(t); return [k, v == null ? '' : v]; }));
const flat = rows.map(t => ({ ...flatOf(t), status: 'kept' }));
// URL-source notices whose fate is final (expired, award, cancelled, superseded, or a copy of one / of a tender kept here) are
// ALSO written, after the ranked rows and NOT in the CSV / JSON files, as status "dropped" rows: the sheet is the only source
// of known keys, so their canonical_id is skipped by URL3 next run instead of paying Firecrawl + the extract LLM on every run.
// Failed scrapes / extractions never get here (retried next run). No pair_key: a later relaunch (same title + buyer, new
// deadline) is not taken for a known tender. A copy sharing an id with a kept row is left out (it would overwrite its sheet row).
// Final = a fact of the notice: "expired (no deadline, published …)" is Clean's staleNoDeadlineDays guess (the extract LLM may
// have missed the deadline, or the page gets one later), so that page is read again next run rather than skipped for ever
const FINAL = /\b(expired \(deadline|award notice|cancelled notice|superseded by)\b/;
const keptIds = new Set(kept.flatMap(t => [t.tender_id, t.canonical_id]));
// a tender already in the sheet (exported or remembered by an earlier run: its canonical_id is a known key) gets no "dropped"
// row either: appendOrUpdate on tender_id would overwrite that row (status, rank, and the pair_key that flags a later relaunch).
// Reached with skipKnown off, or as a cross-source copy (a francemarches link of boamp:X shares the id of the exported boamp:X)
const known = new Set((() => { try { return $('02 - Collect Known IDs').first().json.keys || []; } catch { return []; } })());
const memo = new Map();
for (const t of all.filter(t => !t._type && t.status === 'dropped' && t.source_type === 'url' && t.canonical_id)) {
  const twin = (String(t.drop_reason || '').match(/^duplicate of (\S+)/) || [])[1];
  if (!FINAL.test(t.drop_reason || '') && !(twin && keptIds.has(twin))) continue;
  if (!keptIds.has(t.tender_id) && !keptIds.has(t.canonical_id) && !known.has(t.canonical_id) && !memo.has(t.canonical_id))
    memo.set(t.canonical_id, { json: { ...flatOf(t), pair_key: '', status: 'dropped', drop_reason: t.drop_reason } });
}
if (!flat.length) return [{ json: { note: 'no kept tenders in this run (see Run Summary)', run_id: cfg.runId } }, ...memo.values()];
const files = {};
try {
  files.tenders_csv = await this.helpers.prepareBinaryData(Buffer.from(csv, 'utf8'), `tenders_${cfg.today}.csv`, 'text/csv');
  files.tenders_json = await this.helpers.prepareBinaryData(Buffer.from(JSON.stringify({ run_id: cfg.runId, tenders: rows }, null, 1), 'utf8'), `tenders_${cfg.today}.json`, 'application/json');
} catch (e) { flat[0].export_note = 'files not attached: ' + e.message; }
return [...flat.map((r, i) => (i === 0 && Object.keys(files).length ? { json: r, binary: files } : { json: r })), ...memo.values()];
