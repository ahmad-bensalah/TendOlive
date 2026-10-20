// Join Buyers & Build RAG. Back to one item per tender: survivors get their buyer profile, and a RAG request when they have
// verified requirements (title-only tenders have none: nothing to match). The request follows the RAG service's contract
// (docs/integration/N8N_RAG_HANDOFF.md of the team repo, checked 2026-10-20): {tender_id, client, sector, requirements:
// {technical: [], team: [], experience: [], timeline}} plus the tender's metadata (title, source, dates, budget...), which the
// service stores and shows in its tender inbox without using it for matching. Each requirement is sent as its short skill line
// (rag_text, checked in Verify Analysis): the RAG's rules understand those, long sentences go to its strict reranker.
// data_mode: 'company' = OliveSoft's real knowledge base only (Config rag.dataMode); a source with ragDataMode: 'demo' (the
// synthetic demo tenders) also lets the service use its fictional demo records, which it then labels origin "demo".
const cfg = $('00 - Config').first().json;
const srcBy = Object.fromEntries(cfg.sources.map(s => [s.name, s]));
const buyers = new Map($input.all().map(i => i.json).filter(b => b._type === 'buyer' && b.buyer_key).map(b => [b.buyer_key, b]));
const countryName = c => { try { return c && /^[A-Z]{2}$/i.test(c) ? new Intl.DisplayNames(['en'], { type: 'region' }).of(c.toUpperCase()) : c || null; } catch { return c || null; } };
return $('Verify Analysis').all().map(({ json: t }) => {
  if (t._type || !t.survivor) return { json: { ...t, _run: false } };
  const b = buyers.get(t.buyer_key);
  const p = (b && b.profile) || {};
  t.buyer_profile = { research_status: b ? b.research_status : 'missing', enrichment_status: (b && b.enrichment_status) || 'not_researched', ...p };
  const reqs = (t.requirements && t.requirements.items) || [];
  const by = cat => reqs.filter(r => r.category === cat).map(r => r.rag_text || r.text);
  const src = srcBy[t.source] || {};
  return { json: { ...t, _run: reqs.length > 0, rag_body: {
    tender_id: t.tender_id, title: t.title || null, client: p.legal_name || (t.buyer && t.buyer.name) || null, sector: (t.analysis && t.analysis.sector) || null,
    country: countryName(t.buyer && t.buyer.country), source: t.source || null, source_url: t.source_url || null,
    published: t.publication_date || null, deadline: t.effective_deadline || t.deadline || null, language: t.language || null,
    estimated_budget: t.estimated_value || null, data_mode: src.ragDataMode || (cfg.rag && cfg.rag.dataMode) || 'company',
    requirements: { technical: by('technical'), team: by('team'), experience: by('experience'), timeline: (t.analysis && t.analysis.timeline) || null } } } };
});
