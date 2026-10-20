// Run Summary. Per-source funnel (fetched -> extracted -> kept -> fit -> researched -> RAG), drop reasons, LLM failures,
// failed calls, and hints (a tender list reached from a home page, a scout that used all its page reads, a keyword list
// that removes too much). The message (the alert e-mail) also names each source's first error (one that lost tenders first),
// the tenders whose analysis or market study failed, a cap that cut a source's list, a failed read of the known-ids sheet, and
// the hand-off to the proposal studio (proposal inputs it stored, the deck started for the rank-1 tender or why none was).
// Reads every stage by node name, so it also explains a source that produced nothing. Feeds the optional email alert.
/*@lib parseAnswer pageError normUrl canonicalId scoutRun tryAll*/
const cfg = $('00 - Config').first().json;
const J = name => tryAll(name).map(i => i.json);
const per = {};
const P = s => (per[s] ||= { type: (cfg.sources.find(x => x.name === s) || {}).type || '?', fetched: 0, extracted: 0, kept: 0, dropped: {}, fit: { high: 0, medium: 0, low: 0, none: 0, unknown: 0 },
  analysis_failed: 0, survivors: 0, errors: [], coverage_errors: 0, hints: [] });
cfg.sources.forEach(s => P(s.name));
// coverage_errors: errors that lost part of the source this run (a fetch, a list / scout / detail page, a scout that stopped
// early, an invalid extraction answer); they raise has_warnings. Not lost: a page rejected as "not a notice" (pagination or
// category links a scout picks on every run), one API record without id or title, a page open_page refused (no page read, no
// credit), still listed in errors. lostErr: the texts that lost something, listed first (the e-mail line shows a loss first)
const lostErr = new Map();
const err = (s, e, lost = true) => { s.errors.push(e); if (lost) { s.coverage_errors++; (lostErr.get(s) || lostErr.set(s, new Set()).get(s)).add(e); } };
// one line of the e-mail per source: an HTTP / LLM error body may hold newlines (they would split it) or runs of spaces
const clip = (s, n) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };
const marker = (() => { try { return $('02 - Collect Known IDs').first().json; } catch { return null; } })();

// ---- API lane
const apiReq = J('API1 - Build Requests');
// the API's own count of matching records (opendatasoft total_count, TED totalNoticeCount...) when its answer gives one at the
// top level: "20 found" alone reads like the size of the market when limits.maxRecordsPerApi cut a list of 698
const TOTAL = /^(total|total_?count|total_?results|total_?hits|total_?notice_?count|nhits)$/i;
const getPath = (o, p) => String(p).split('.').reduce((x, k) => (x == null ? x : x[k]), o);
J('API Fetch').forEach((r, i) => { const s = (apiReq[i] || {}).source; if (s) { P(s).requests = (P(s).requests || 0) + 1; if (r.error) err(P(s), `fetch page ${apiReq[i].page}: ${String(r.error.message || r.error).slice(0, 120)}`);
  const src = cfg.sources.find(x => x.name === s) || {};
  if (r.error || ['', '.', '$'].includes(src.records)) return;   // '$': n8n split the list into items, no count to read
  const recs = getPath(r, src.records || 'results'), k = Object.keys(r).find(k => TOTAL.test(k) && /^\d+$/.test(String(r[k])));
  if (Array.isArray(recs)) P(s).records_read = (P(s).records_read || 0) + recs.length;
  if (k) P(s).matched = Math.max(P(s).matched || 0, Number(r[k])); } });
for (const e of J('API2 - Map Records').filter(x => x._type === 'source_error' && x.stage !== 'fetch')) err(P(e.source), `${e.stage}: ${e.error}`, !/^record without/.test(e.error));
for (const e of J('API2 - Map Records').filter(x => x._type === 'source_error' && x.empty)) err(P(e.source), e.error, false);   // warned as "nothing fetched"
J('API2 - Map Records').filter(t => !t._type).forEach(t => { P(t.source).fetched++; });

// ---- URL lane: what the Tender Scout Agent opened and picked (from its tool results, not from its words)
const tasks = J('URL1 - Scout Tasks');
const known = new Set((marker && marker.keys) || []);
const capUrl = cfg.limits.maxTendersPerUrlSource || 40;
let scoutPagesFailed = 0;
// a page open_page refused (Resolve Source: a host of no configured source, "www.franc-than.com" typed for www.francemarches.com)
// costs no Firecrawl call, so it is no failed call. Its text speaks to the agent ("open the START URL exactly as written ...; other
// hosts go in Config allowedHosts"): the operator reads what was asked, and allowedHosts only for a site that moved
const REFUSED = /^refused, no page read\b/;
J('Tender Scout Agent').forEach((r, i) => {
  const t = tasks[i]; if (!t) return;
  const s = P(t.source), run = scoutRun(r, t), read = run.pages.filter(p => !p.error);
  const failed = run.pages.filter(p => p.error), hostOf = p => hostOfUrl(p.asked || p.url) || p.url;
  s.pages = run.pages.length;
  s.scout = { pages: run.pages.map(p => ({ url: p.url, error: p.error || undefined, links: p.links.length, note: p.note || undefined })), picked: run.picks.length,
    invalid_ids: run.invalid.length, navigation_dropped: run.navigation_dropped, list_url: run.list_url, refused: failed.filter(p => REFUSED.test(p.error)).length };
  // pages of the task list (the START URL, pages 2..maxPages) that no open_page call read: their tenders are missing (the real
  // francemarches run asked "www.franc-than.com/recherche…" and never read page 1). Said once per page: a page that failed is
  // listed as such, the NEXT PAGE of the list below when it is not one of them (one page = any "www.", "+" / "%20", parameter order)
  const key = u => { const n = normUrl(u).replace(/^(https?:\/\/)www\./i, '$1').replace(/\+/g, '%20'), q = n.indexOf('?'); return q < 0 ? n : `${n.slice(0, q)}?${n.slice(q + 1).split('&').sort().join('&')}`; };
  const tried = new Set(failed.flatMap(p => [p.url, p.asked]).filter(Boolean).map(key));
  const notOpened = run.ok && run.pages.length ? run.not_opened.filter(u => !tried.has(key(u))) : [];
  // a failed page with the path + query of a page never opened, on another host, is that page asked on a mistyped host: ONE line
  // says what is missing and why ("list page 1 never read ...: the scout asked franc-than.com instead of francemarches.com")
  const pathOf = u => key(u).replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, ''), list = [t.url, ...(t.other_pages || [])], standIn = new Map(), used = new Set();
  for (const u of notOpened) { const p = failed.find(p => !used.has(p) && [p.url, p.asked].some(x => x && pathOf(x) === pathOf(u))); if (p) { standIn.set(u, p); used.add(p); } }
  // what is MISSING comes first: the source line of the message shows only the first error (+N more), and a page of the list that
  // was never read matters more than the failed call that explains it
  for (const [u, p] of standIn)
    err(s, `${list.length > 1 ? `list page ${list.indexOf(u) + 1}` : 'the source url'} never read, its tenders are missing: the scout asked ${hostOf(p) !== hostOfUrl(u) ? `${hostOf(p)} instead of ${hostOfUrl(u)}` : p.asked || p.url} (${REFUSED.test(p.error) ? 'refused: not a host of any configured source' : clip(p.error, 90)}) - ${u}`);
  const rest = notOpened.filter(u => !standIn.has(u));
  if (rest.length) err(s, `the scout never opened ${rest.join(', ')} (pages of the task list: their tenders are missing)`);
  for (const p of failed) {
    if (!REFUSED.test(p.error)) scoutPagesFailed++;
    if (used.has(p)) continue;
    if (REFUSED.test(p.error)) err(s, `page ${p.url}: refused before Firecrawl (no page read, no credit spent), ${hostOf(p)} is not a host of any configured source (add it to the source's allowedHosts in Config only if the site moved there)`, false);
    else err(s, `page ${p.url}: ${p.error}`);
  }
  // open_page keeps no memory of earlier calls: a page read twice ("+" vs "%20") is a Firecrawl credit and an agent step wasted
  for (const u of run.reread || []) s.hints.push(`page ${u} read again (one Firecrawl credit wasted)`);
  if (run.error) err(s, run.error);
  // an unknown id is a slip of the scout, not a page that failed (picks made only of them leave nothing fetched: warned as such)
  if (run.invalid.length) err(s, `scout gave ${run.invalid.length} unknown link id(s): ${run.invalid.slice(0, 3).join(', ')}`, false);
  if (!run.pages.length && !run.error) err(s, 'the scout agent opened no page');
  // open_page's NOTE (Firecrawl landed on a host of no source: open_page refuses its pages, add that host to the source's
  // allowedHosts in Config). Not a loss by itself: a page of the task list that was refused is listed as never read / opened
  for (const n of run.notes) err(s, `page note: ${n}`, false);
  // the list was reached from the url in Config: putting its address there saves the hops (credits + time) on every run
  const k = run.list_url ? read.findIndex(p => normUrl(p.url) === normUrl(run.list_url)) : -1;
  if (k > 0 && normUrl(run.list_url) !== normUrl(t.url))
    s.hints.push(`tender list found at ${run.list_url} (${k} page${k > 1 ? 's' : ''} from the url in Config): use it as the source url to save ${k} Firecrawl credit${k > 1 ? 's' : ''} per run`);
  if (run.ok && !run.picks.length && read.length) s.hints.push(`the scout found no tender from ${t.url}: check that the site lists current tenders, or give the URL of its tender list page`);
  s.links_picked = run.picks.length;
  s.skipped_known = cfg.limits.skipKnown ? run.picks.filter(l => known.has(canonicalId(cfg, l.url))).length : 0;
  if (run.next_unopened && !notOpened.some(u => key(u) === key(run.next_unopened))) {
    // the scout already picked as many new links as URL3 opens (maxTendersPerUrlSource, in pick order): the next page's tenders,
    // picked after them, would have been cut too (the real domainetat-tn run: 8 picks from 2 pages, cap 5). Nothing lost
    if (s.links_picked - s.skipped_known >= capUrl) s.hints.push(`more pages exist (${run.next_unopened}), not read: the list was already cut by limits.maxTendersPerUrlSource = ${capUrl}`);
    // every open_page call (refused, failed or repeated too) against the budget its prompt gives: max_calls
    else if (run.pages.length < t.max_calls) err(s, `the scout stopped before the next page of the list (${run.next_unopened}) with ${t.max_calls - run.pages.length} page(s) left`);
    else s.hints.push(`more pages exist (${run.next_unopened}): raise maxPages to let the scout read them`);
  }
});
const links = J('URL3 - Links to URLs');
links.forEach(l => { P(l.source).fetched++; });
J('Firecrawl Detail').forEach((r, i) => { const l = links[i] || {}; const e = pageError(r); if (e) err(P(l.source), `detail ${l.url}: ${e}`); });
// URL5 rejects a page with no title or "not a notice (no date, no description)" by design; an invalid extraction answer is a loss
for (const e of J('URL5 - Verify Extraction').filter(x => x._type === 'source_error')) err(P(e.source), `extract: ${e.error}`, /: extraction invalid\b/.test(e.error));

// ---- common stages
const final = J('Merge Market');
const tenders = final.filter(t => !t._type);
const bucket = r => String(r).replace(/\s*\(.*$/, '').replace(/ (of|into|by) \S+$/, '').replace(/: ".*$/, '');
const prefilterSamples = {};
for (const t of tenders) {
  const s = P(t.source); s.extracted++;
  if (t.status === 'kept') s.kept++; else { const b = bucket(t.drop_reason || 'dropped'); s.dropped[b] = (s.dropped[b] || 0) + 1; }
  if (String(t.drop_reason || '').startsWith('prefilter')) { const a = (prefilterSamples[t.source] ||= []); if (a.length < 5) a.push(t.title.slice(0, 100)); }
  if (t.analysis) { s.fit[t.analysis.fit] = (s.fit[t.analysis.fit] || 0) + 1; if (t.analysis.status === 'failed') { s.analysis_failed++; if (!s.analysis_error && t.analysis.errors) s.analysis_error = String(t.analysis.errors[0]).slice(0, 160); } }
  if (t.survivor) s.survivors++;
}
const capApi = cfg.limits.maxRecordsPerApi;
const firstError = {};
for (const [name, s] of Object.entries(per)) {
  // the errors that lost tenders first (a stable sort: in their order otherwise), so "why 0", the e-mail line and the 8 kept in
  // the JSON show a loss before a refused page or a "not a notice" reject (francemarches: list page 1 never read, not the refusal)
  const lost = lostErr.get(s) || new Set(); s.errors.sort((a, b) => lost.has(b) - lost.has(a));
  if (prefilterSamples[name]) s.hints.push(`keyword pre-filter removed ${s.dropped.prefilter || 0}, e.g. ${prefilterSamples[name].join(' | ')}`);
  // a cap that cut the list (by design in the test preset; in production BOAMP's 698 matches would be cut to 300 silently)
  if (s.type === 'api' && s.records_read != null) {
    if (s.matched > s.records_read) s.capped = `of ${s.matched} matching${s.records_read >= capApi ? `: cut by limits.maxRecordsPerApi = ${capApi}` : `, ${s.records_read} read`}`;
    else if (s.matched == null && s.records_read >= capApi) s.capped = `cut by limits.maxRecordsPerApi = ${capApi}: the source may hold more`;
  }
  // URL3 opens at most maxTendersPerUrlSource of the links the scout picked (known ones skipped first): the rest are never checked
  if (s.type === 'url' && s.links_picked - (s.skipped_known || 0) > s.fetched)
    s.capped = `of ${s.links_picked} tender links picked${s.skipped_known ? `, ${s.skipped_known} already known` : ''}: cut by limits.maxTendersPerUrlSource = ${capUrl}`;
  if (!s.survivors) s.why_zero = s.skipped_known && !s.fetched ? `all ${s.skipped_known} links are known from a previous run (exported, or expired / awarded / cancelled): nothing new`
    : !s.fetched ? (s.errors[0] || 'the source returned nothing') : !s.extracted ? (s.errors.find(e => e.startsWith('extract')) || 'no page could be extracted')
    : !s.kept ? `all ${s.extracted} dropped by Clean: ${JSON.stringify(s.dropped)}`
    : s.analysis_failed ? `${s.analysis_failed} of ${s.kept} analysis calls failed (fit unknown, retried next run)` : `no tender with fit high/medium: ${JSON.stringify(s.fit)}`;
  // the source's first error not already given as "why 0" (a failed list page, a detail page...), counted before the slice to 8;
  // taken before the analysis failures join the errors: they have their own line in the message. A trailing " - <url>" (the page
  // the error is about, kept in the JSON) is left out of a line it would make too long, not cut to "- h…": what and why stay whole
  const other = s.errors.filter(e => e !== s.why_zero), mail = e => (e.length > 160 ? e.replace(/ - https?:\/\/\S+$/, '') : e);
  if (other.length) firstError[name] = `${clip(mail(other[0]), 160)}${other.length > 1 ? ` (+${other.length - 1} more)` : ''}`;
  if (s.analysis_failed) s.errors.unshift(`${s.analysis_failed} analysis call(s) failed${s.analysis_error ? `: ${s.analysis_error}` : ''}`);
  s.error_count = s.errors.length; s.errors = s.errors.slice(0, 8);
}
const kept = tenders.filter(t => t.status === 'kept'), surv = kept.filter(t => t.survivor);
const buyers = J('Select Buyers').filter(b => b._type === 'buyer' && b.buyer_key), research = J('Parse Research'), researched = research.filter(b => b.research_status === 'researched');
const count = f => kept.filter(f).length;
// a fit tender still open whose matrix is empty: its notice holds no requirement (a short notice, or a title only: the LLM's
// rows were dropped as "title-only text"), or the analysis found some and none was kept (all dropped: an untranslated quote, a
// quote not in the text...; or obligation sentences left out, requirements.uncovered): two different things to tell a person
const reqOf = t => t.requirements || {}, emptyMatrix = t => t.survivor && !t.too_late && !(reqOf(t).items || []).length;
const reqsLost = t => !reqOf(t).low_input && !!((reqOf(t).dropped || []).length || (reqOf(t).uncovered || []).length);
const cnt = (name, pred) => { const a = tryAll(name); return a.length ? a.filter(i => pred(i.json)).length : null; };
// ---- proposal studio: the proposal inputs it stored (Send to Proposal Service answers {status: 'ok', id}), the ones that failed,
// and the deck Start Deck started (Config proposal.autoDeck 'top1': the rank-1 tender) or why none was. An HTTP error item
// (On Error: continue) has its status in error.status / details.httpCode, the studio's reason in details.body.message
const httpCode = j => Number((j.error && j.error.status) || (j.details && j.details.httpCode) || (/^(\d{3})\b/.exec(String((j.error && j.error.message) || '')) || [])[1] || 0);
const studioErr = j => { const d = j.details || {}, b = d.body, c = httpCode(j);
  const m = (b && typeof b === 'object' && (b.message || b.error)) || d.description || (j.error && (j.error.description || j.error.message)) || j.error;
  return `${c ? `HTTP ${c}: ` : ''}${clip(typeof m === 'string' ? m : JSON.stringify(m), 100)}`; };
const studio = (() => {
  const inputs = J('Build Proposal Input').length, adapted = J('Adapt for Studio'), sends = J('Send to Proposal Service'), decks = J('Start Deck');
  const ok = j => !!j && j.status === 'ok' && !!j.id, autoDeck = (cfg.proposal && cfg.proposal.autoDeck) || 'none';
  const sent = sends.filter(ok).length, failed = sends.filter(j => j.error).length, notSent = Math.max(0, inputs - sent - failed);
  // a disabled node passes its input through: the proposal inputs themselves come out, no answer of the studio
  const notSentWhy = !tryAll('Send to Proposal Service').length ? 'Send to Proposal Service did not run'
    : sends.some(j => !j.error && !ok(j) && j.contract) ? 'Send to Proposal Service is disabled' : 'no answer {status: ok, id} from the studio';
  const k = adapted.findIndex(a => a.studio_adapter && a.studio_adapter.auto_deck), top = adapted[k] || null;
  const title = top ? `"${clip((top.tender && top.tender.title) || top.tender_id, 70)}"` : '', d = decks[0];
  const REASON = { 409: 'another deck is being generated (the studio makes one at a time): start it from the interface once it is done',
    503: 'deck generation is not configured in the studio (GENERATE_MODE / GENERATE_WEBHOOK_URL)', 502: 'the studio could not reach its deck agents',
    404: 'the studio does not have this tender' };
  const deck = !inputs ? { started: false, reason: 'no proposal input' }
    : autoDeck !== 'top1' ? { started: false, reason: `proposal.autoDeck is '${autoDeck}': decks are started from the interface` }
    : !top ? { started: false, reason: 'no rank-1 proposal input' }
    : !ok(sends[k]) ? { started: false, tender_id: top.tender_id, reason: `the rank-1 tender ${title} is not in the studio (${sends[k] && sends[k].error ? studioErr(sends[k]) : notSentWhy})` }
    : !d ? { started: false, tender_id: top.tender_id, reason: 'Start Deck did not run' }
    : d.runId ? { started: true, tender_id: top.tender_id, title: top.tender && top.tender.title, run_id: d.runId }
    : d.error ? { started: false, tender_id: top.tender_id, http: httpCode(d) || null, reason: `Start Deck for ${title}: ${REASON[httpCode(d)] || studioErr(d)}` }
    : { started: false, tender_id: top.tender_id, reason: 'Start Deck is disabled' };
  const firstErr = sends.find(j => j.error);
  return { auto_deck: autoDeck, inputs, sent, failed, not_sent: notSent, deck,
    line: !inputs ? null : `Proposal inputs: ${sent} sent to the studio${failed ? ` (${failed} failed: ${studioErr(firstErr)})` : ''}${notSent ? `, ${notSent} not sent (${notSentWhy})` : ''}`
      + ` | ${deck.started ? `deck started for ${title} (run ${deck.run_id})` : `no deck started: ${deck.reason}`}` };
})();
const failures = {
  'API calls': cnt('API Fetch', j => j.error), 'Scout pages': tryAll('Tender Scout Agent').length ? scoutPagesFailed : null, 'Firecrawl detail': cnt('Firecrawl Detail', j => !!pageError(j)),
  'Scout agent': cnt('Tender Scout Agent', j => j.error), 'LLM extract': cnt('LLM - Extract', j => j.error), 'LLM analysis': cnt('LLM - Analyze Tender', j => j.error),
  'Research agent': cnt('Buyer Research Agent', j => j.error),
  // an answer with no matrix row (HTTP 200, {}) failed too: Join RAG makes it an error, never "nothing covered"
  'RAG calls': cnt('Call RAG', j => j.error || ![].concat(j.requirements_matrix || j.matrix || []).length),
  'Market agent': cnt('Competitor & Budget Agent', j => j.error), 'Proposal service': cnt('Send to Proposal Service', j => j.error),
  // a 409 (another deck is being generated) is no failure: the deck line says it
  'Deck start': cnt('Start Deck', j => j.error && httpCode(j) !== 409),
  // a failed read of the known-ids sheet is not a first run: every tender exported before is processed and handed off again.
  // A failed write is counted only when "Save to Google Sheet" ran before this node (n8n v1 order: drawn above Run Summary)
  'Known IDs sheet': marker ? (marker.sheet_error ? 1 : 0) : null, 'Sheet write': cnt('Save to Google Sheet', j => j.error),
};
const failed_total = Object.values(failures).reduce((a, v) => a + (v || 0), 0);
// a kept tender whose analysis call failed or answered junk has fit "unknown": it drops out of the ranking (retried next run)
const analysisFailed = kept.filter(t => t.analysis && t.analysis.status === 'failed');
// a fit tender whose market study failed (agent error, every award tool failed, a final answer that is no JSON: Parse Market,
// mostly without j.error, so no failed call): no budget nor competitors in its export row, competition FAILED in its proposal input
const marketFailed = kept.filter(t => t.market && /failed|invalid/.test(t.market.status));
const summary = {
  run_id: cfg.runId, preset: cfg.preset, today: cfg.today, llm_provider: cfg.llm.provider,
  known_keys: marker ? marker.note : null,
  totals: { extracted: tenders.length, kept: kept.length, survivors: surv.length, too_late: count(t => t.survivor && t.too_late),
    buyers: buyers.length, buyers_researched: researched.length, research_failed: research.length - researched.length, buyers_enriched: researched.filter(b => b.enrichment_status === 'enriched').length,
    rag_ok: count(t => t.rag && t.rag.status === 'ok'), rag_error: count(t => t.rag && t.rag.status === 'error'),
    market_studied: count(t => t.market && t.market.status === 'studied'), market_failed: marketFailed.length,
    market_no_data: count(t => t.market && /no_data|no_comparable/.test(t.market.status)), proposal_inputs: J('Build Proposal Input').length,
    proposal_not_sent: Math.max(0, count(t => t.survivor && !t.too_late) - J('Build Proposal Input').length),
    // fit tenders whose notice holds no requirement (short notice): a person downloads the tender documents (documents_url)
    fit_without_requirements: count(t => emptyMatrix(t) && !reqsLost(t)),
    // fit tenders whose notice holds requirements that all were dropped or left out: a person reads the notice
    fit_requirements_all_dropped: count(t => emptyMatrix(t) && reqsLost(t)) },
  quality: { analysis_call_failed: count(t => t.analysis && t.analysis.checks.includes('llm_call_failed')),
    analysis_invalid: count(t => t.analysis && t.analysis.checks.includes('llm_invalid')), quote_not_in_text: count(t => t.analysis && t.analysis.checks.includes('quote_not_in_text')),
    sector_not_in_text: count(t => t.analysis && (t.analysis.checks || []).includes('sector_not_in_text')),
    // relapses of the small model's field mix-ups, visible run after run: service numbers written as the reason, service lines
    // found only in the reason, every service listed at once, a contract duration the text does not give
    ...Object.fromEntries(['quote_missing', 'reason_was_service_list', 'services_from_reason', 'services_all_listed', 'timeline_not_in_text']
      .map(c => [c, count(t => t.analysis && (t.analysis.checks || []).includes(c))])),
    requirements_kept: kept.reduce((a, t) => a + ((t.requirements && t.requirements.items.length) || 0), 0),
    requirements_dropped: kept.reduce((a, t) => a + ((t.requirements && t.requirements.dropped.length) || 0), 0),
    // obligation sentences of a fit notice that no kept requirement quotes: never checked by the RAG (proposal input: review)
    requirements_uncovered: kept.reduce((a, t) => a + (reqOf(t).uncovered || []).length, 0), fit_with_uncovered: count(t => t.survivor && (reqOf(t).uncovered || []).length > 0),
    extraction_rejected: J('URL5 - Verify Extraction').filter(x => x._type === 'source_error').length },
  failed_calls: failures, failed_total, per_source: per,
  studio: { auto_deck: studio.auto_deck, sent: studio.sent, failed: studio.failed, not_sent: studio.not_sent, deck: studio.deck },
  top: J('Rank & Export').filter(r => r.rank).slice(0, 10).map(r => ({ rank: r.rank, title: String(r.title).slice(0, 90), buyer: r.buyer, fit: r.fit,
    coverage: r.rag_coverage === '' ? null : r.rag_coverage, deadline: r.deadline, url: r.source_url })),
};
const lines = [
  `RFP pipeline ${cfg.today} (${cfg.preset}, ${cfg.llm.provider})`,
  `Extracted ${tenders.length} | kept ${kept.length} | fit high/medium ${surv.length} | buyers researched ${researched.length}${research.length > researched.length ? ` (${research.length - researched.length} failed)` : ''} | RAG ok ${summary.totals.rag_ok} | market studies ${summary.totals.market_studied}${marketFailed.length ? ` (${marketFailed.length} failed)` : ''}${summary.totals.market_no_data ? ` (+${summary.totals.market_no_data} without comparable contracts)` : ''} | proposal inputs ${summary.totals.proposal_inputs}${summary.totals.proposal_not_sent ? ` (${summary.totals.proposal_not_sent} more fit tender(s) not sent: raise proposal.maxTenders)` : ''}`,
  ...(marker && marker.sheet_error ? [`Known IDs: ${marker.note}`] : []),
  ...Object.entries(per).map(([n, s]) => `- ${n}: ${s.fetched} found${s.capped ? ` (${s.capped})` : ''} -> ${s.extracted} extracted -> ${s.kept} kept -> ${s.survivors} fit${s.why_zero ? ` (why 0: ${s.why_zero})` : ''}`
    + `${firstError[n] ? ` | error: ${firstError[n]}` : ''}${s.hints.length ? ` | hint: ${s.hints[0]}` : ''}`),
  ...(analysisFailed.length ? [`Analysis failed for ${analysisFailed.length} kept tender(s), fit unknown (not ranked, retried next run): ${analysisFailed.slice(0, 3).map(t => `"${clip(t.title, 70)}" (${t.source}, ${t.analysis.checks[0] || 'failed'}${(t.analysis.errors || [])[0] ? `: ${clip(t.analysis.errors[0], 90)}` : ''})`).join('; ')}${analysisFailed.length > 3 ? ` +${analysisFailed.length - 3} more` : ''}`] : []),
  ...(marketFailed.length ? [`Market study failed for ${marketFailed.length} fit tender(s), no budget nor competitors in the export and the proposal input: ${marketFailed.slice(0, 3).map(t => { const c = t.market.checks || []; return `"${clip(t.title, 70)}" (${t.source}, ${t.market.status}${c.length ? `: ${clip(c.find(x => /^agent /.test(x)) || c[0], 90)}` : ''})`; }).join('; ')}${marketFailed.length > 3 ? ` +${marketFailed.length - 3} more` : ''}`] : []),
  ...(summary.totals.fit_without_requirements ? [`${summary.totals.fit_without_requirements} fit tender(s) have no requirement in their notice: download their tender documents (documents_url in the export) before deciding`] : []),
  ...(summary.totals.fit_requirements_all_dropped ? [`${summary.totals.fit_requirements_all_dropped} fit tender(s) whose requirements were all dropped or left out by the analysis (see requirements_dropped / requirements_uncovered in the export): read their notice before deciding`] : []),
  ...(studio.line ? [studio.line] : []),
  `Failed calls: ${failed_total}${failed_total ? ' -> ' + Object.entries(failures).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ') : ''}`,
  ...summary.top.slice(0, 5).map((t, i) => `${i + 1}. [${t.fit}${t.coverage != null ? `, coverage ${t.coverage}` : ''}] ${t.title} - ${t.buyer || '?'} (deadline ${t.deadline || '?'})`),
];
// WARNINGS (alert subject) for anything the run lost, not only failed calls: an invalid analysis answer, a failed market study,
// a coverage error (a list page or detail page that failed, a scout that stopped early, an invalid extraction), a source with
// nothing fetched. Not for errors that come back on every run by design (a "not a notice" reject, one API record without id):
// they would bury the real warnings
const has_warnings = failed_total > 0 || analysisFailed.length > 0 || marketFailed.length > 0 || Object.values(per).some(s => s.coverage_errors || (!s.fetched && !s.skipped_known));
// one entry = one line: a title, a hint or a "why 0" error text holding a newline would split it
return [{ json: { ...summary, message: lines.map(l => l.replace(/\s*[\r\n]+\s*/g, ' ')).join('\n'), has_warnings } }];
