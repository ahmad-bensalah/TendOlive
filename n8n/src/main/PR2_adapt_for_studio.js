// Adapt for Studio. The team's proposal studio (rfp-studio) reads our olivesoft.proposal-input.v2 as it is, but none of its
// honesty flags: every asset becomes a reference or an engineer, every covered justification a "why us" bullet, any budget
// estimate three budget scenarios. So the copy it receives (a deep copy: Build Proposal Input's output and its file stay the
// full, honest v2) leaves out what the deck would present as proof without being one, and says what it left out
// (studio_adapter.dropped):
// - matrix evidence of a fictional demo record (origin demo) or that proves nothing (proves false); rag assets that are demo
//   records or prove no row (weak_for only: T1ytbl1u showed 6 engineers, 5 of them weak neighbours)
// - the justification of a row resting on a demo record, a weak proof or a header line (Join RAG's flags, or a CV skills line
//   "Databases: MySQL, phpMyAdmin, PostgreSQL"); OliveSoft's own declarations stay (its statement, in its own proposal)
// - with a team_proposal: only the CVs of its members (role = their roles), plus their certifications as certification assets
//   (the only place the studio reads certifications from)
// - coverage unknown (no matrix): score 0, shown "À préciser" (a null score switches the whole deck to keyword guesses)
// - no template id (the studio's default template; an id it does not know fails the deck)
// - no budget estimate unless the market study is OK with 3+ comparables and more than "very low" confidence
// - a language other than fr / en becomes en (language_original keeps it): the studio writes French or English only
// studio_adapter also carries what "Start Deck" needs: auto_deck (Config proposal.autoDeck 'top1': the rank-1 tender only)
// and deck_params (project_type from tender_type: software_build / ai_data -> software, integration_saas -> saas, else other).
const cfg = $('00 - Config').first().json;
const VERSION = 1;
const autoDeck = (cfg.proposal && cfg.proposal.autoDeck) || 'none';
const items = $input.all();
const ranks = items.map(i => Number(i.json.rank)).filter(Number.isFinite), top = ranks.length ? Math.min(...ranks) : null;
const PROJECT_TYPE = { software_build: 'software', ai_data: 'software', integration_saas: 'saas' };
const isDemo = a => !!a && (a.demo === true || a.origin === 'demo');
// a CV skills-section line ("% Programming: Apex, LWC, JavaScript", "Containerization: Docker, Kubernetes, Helm"): a label, a
// colon, then a list of short items and no sentence. A true line of a CV, but no argument: never a "why us" bullet
const skillsLine = s => { const m = /^[^\p{L}]*\p{L}[^:]{0,40}:\s*(.+)$/u.exec(String(s || '').trim()); if (!m) return false;
  const parts = m[1].split(/\s*,\s*/); return parts.length >= 2 && !/[.!?…]$/.test(m[1]) && parts.every(p => p && p.length <= 40 && p.split(/\s+/).length <= 5); };
const slug = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

return items.map((item, i) => {
  const x = JSON.parse(JSON.stringify(item.json));
  const dropped = { demo_evidence: 0, weak_evidence: 0, demo_assets: 0, weak_assets: 0, cvs_not_in_team: 0,
    demo_justifications: 0, weak_justifications: 0, header_justifications: 0, budget_estimate: 0 };
  const added = { team_cvs: 0, certifications: 0 }, notes = [];
  const rag = x.rag || (x.rag = {}), rows = (x.matrix && Array.isArray(x.matrix.rows)) ? x.matrix.rows : [];
  rag.assets = Array.isArray(rag.assets) ? rag.assets : [];
  const demoIds = new Set([...rows.flatMap(r => r.evidence || []), ...rag.assets].filter(isDemo).map(a => a.asset_id));

  // ---- team: the members of the RAG's team proposal (never a demo record), each with their roles
  const tp = rag.team_proposal;
  const members = tp && Array.isArray(tp.members) ? tp.members.filter(p => p && p.asset_id && !demoIds.has(p.asset_id) && !/^demo[_-]/i.test(p.asset_id)) : null;
  const team = members ? new Map(members.map(p => [p.asset_id, p])) : null;
  const roleOf = p => (p.roles || []).filter(Boolean).join(', ') || p.title || null;
  const outOfTeam = new Set();
  const keep = (a, isEvidence) => {
    if (isDemo(a)) { dropped[isEvidence ? 'demo_evidence' : 'demo_assets']++; return false; }
    if (isEvidence ? a.proves === false : !(a.for || []).length) { dropped[isEvidence ? 'weak_evidence' : 'weak_assets']++; return false; }
    if (team && a.asset_type === 'cv' && !team.has(a.asset_id)) { outOfTeam.add(a.asset_id); return false; }
    if (team && team.has(a.asset_id)) a.metadata = { ...(a.metadata || {}), role: roleOf(team.get(a.asset_id)) };
    return true;
  };

  // ---- matrix rows: proving evidence only; a justification that is no argument is cleared (the row keeps its coverage)
  for (const r of rows) {
    r.evidence = (r.evidence || []).filter(e => keep(e, true));
    const why = r.justification_kind === 'demo' || r.origin === 'demo' ? 'demo' : r.justification_weak ? 'weak'
      : r.justification_is_header || (r.justification_kind === 'document_quote' && skillsLine(r.justification)) ? 'header' : null;
    if (why && r.justification) { r.justification = null; dropped[`${why}_justifications`]++; }
    if (r.coverage === 'unknown' && r.coverage_score == null) r.coverage_score = 0;
  }
  rag.assets = rag.assets.filter(a => keep(a, false));
  dropped.cvs_not_in_team = outOfTeam.size;
  if (team) for (const p of members) if (!rag.assets.some(a => a.asset_id === p.asset_id)) {
    // a member staffed from the CV bank whose CV proves no row of the matrix: still one of the team
    rag.assets.push({ asset_id: p.asset_id, asset_type: 'cv', origin: 'cv_document', demo: false, title: p.title || p.name || null, metadata: { role: roleOf(p) },
      for: (p.assigned_to || []).map(q => q.requirement_id).filter(Boolean), weak_for: [] });
    added.team_cvs++;
  }
  // ---- certifications of the team members (read from their CVs by the RAG), one asset each
  const certs = new Map();
  for (const p of members || []) for (const c of p.certifications || []) { const k = slug(c); if (!k) continue;
    const h = certs.get(k) || { asset_id: `cert_${k}`, asset_type: 'certification', origin: 'cv_document', demo: false, title: String(c), for: [], weak_for: [], holders: [] };
    if (p.name && !h.holders.includes(p.name)) h.holders.push(p.name); certs.set(k, h); }
  for (const c of certs.values()) if (!rag.assets.some(a => a.asset_id === c.asset_id)) { rag.assets.push(c); added.certifications++; }
  if (rag.suggested_assets) { const ids = new Set(rag.assets.filter(a => (a.for || []).length).map(a => a.asset_id));
    rag.suggested_assets = Object.fromEntries(Object.entries(rag.suggested_assets).map(([k, v]) => [k, (v || []).filter(id => ids.has(id))])); }

  // ---- budget: three "scenarios" from an estimate the market study does not stand behind would be invented figures
  const comp = x.competition || {}, b = comp.budget_estimate;
  if (b) {
    const reason = comp.status !== 'OK' ? `market study ${comp.status}` : b.confidence === 'very low' ? 'confidence very low'
      : !(Number(b.comparables) >= 3) ? `${b.comparables ?? 0} comparable contract(s)` : null;
    if (reason) { comp.budget_estimate = null; dropped.budget_estimate = 1; notes.push(`budget estimate left out: ${reason}`); }
  }
  // ---- deck options and language
  if (x.options && x.options.template_id != null) notes.push(`template_id "${x.options.template_id}" replaced by the studio's default`);
  x.options = { ...(x.options || {}), template_id: null };
  // no language at all stays unset: the studio then uses the tender's own language field or its French default
  if (x.language) {
    const two = (/^(fr|en)(?:[-_]|$)/i.exec(String(x.language)) || [])[1], lang = two ? two.toLowerCase() : 'en';
    if (lang !== x.language) { x.language_original = x.language; x.language = lang; }
  }

  x.studio_adapter = { version: VERSION, dropped, added, coverage_unknown_to_zero: rows.filter(r => r.coverage === 'unknown').length, notes,
    auto_deck: autoDeck === 'top1' && Number(x.rank) === top,
    deck_params: { language: 'auto', project_type: PROJECT_TYPE[x.analysis && x.analysis.tender_type] || 'other' } };
  return { json: x, pairedItem: { item: i } };
});
