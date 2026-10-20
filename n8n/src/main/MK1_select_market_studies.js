// Select Market Studies. Every item passes through; the best-ranked fit tenders still open for bidding (Config
// limits.maxMarketStudies, same order as Rank & Export, except that a SYNTHETIC tender of a demo: true source only gets a slot no
// real fit tender needs) get _market = true and a task for the Competitor & Budget Agent:
// what is bought (title, CPV, short description, verified requirements), by whom, where, and the value the notice declares.
const cfg = $('00 - Config').first().json;
const FIT = { high: 3, medium: 2, low: 1, none: 0 };
const all = $input.all().map(i => i.json);
const cov = t => (t.rag && t.rag.coverage) ?? 0;
// demo tenders are written to match the company's documents, so they outrank real ones on fit and coverage: in a mixed run they
// would take every slot. Alone (demo mode) they still get their study (it runs on real public award data)
const demoSources = new Set((cfg.sources || []).filter(s => s.demo).map(s => s.name));
const isDemo = t => demoSources.has(t.source) && !(t.also_seen_in || []).some(x => !demoSources.has(x.source));
const queue = all.filter(t => !t._type && t.survivor && !t.too_late)
  .sort((a, b) => (isDemo(a) - isDemo(b)) || (FIT[b.analysis.fit] - FIT[a.analysis.fit]) || (cov(b) - cov(a)) || String(a.effective_deadline || '9999').localeCompare(String(b.effective_deadline || '9999')));
const chosen = new Set(queue.slice(0, cfg.limits.maxMarketStudies ?? 5).map(t => t.tender_id));
const countryName = code => { try { return code && /^[A-Z]{2}$/i.test(code) ? new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase()) : code; } catch { return code; } };
// the buyer's SIREN lets buyer_awards read its own contracts in DECP (France): from the research, else from the notice (the SIRET
// the source mapped: API2's buyer.national_id, BOAMP organisme.codeIdentificationNational "50962999400013" -> 509629994, so a
// buyer the research budget skipped still gets its own awards; or "N° National d'identification : <SIRET>" of a BOAMP-style text,
// the buyer's section coming first). Every SIREN carries a Luhn key: a phone or reference number is never taken for one
const luhn = d => { let s = 0; for (let i = 0; i < d.length; i++) { let x = Number(d[d.length - 1 - i]); if (i % 2) { x *= 2; if (x > 9) x -= 9; } s += x; } return s % 10 === 0; };
const sirenOf = v => { const d = String(v || '').replace(/\D/g, ''); return (d.length === 9 || d.length === 14) && luhn(d.slice(0, 9)) ? d.slice(0, 9) : ''; };
const noticeSiren = t => { const m = String(t.body_text || t.description || '').match(/(?:\bSIRE[NT]|national d['’]identification|identifiant national|num[ée]ro d['’]enregistrement)\D{0,30}?(\d{3} ?\d{3} ?\d{3}(?: ?\d{5})?)(?!\d)/i); return m ? sirenOf(m[1]) : ''; };
return all.map(t => {
  if (!chosen.has(t.tender_id) || t._type) return { json: { ...t, _market: false } };
  const bp = t.buyer_profile || {}, country = (t.buyer && t.buyer.country) || null;
  const b = t.buyer || {};
  const siren = bp.siren || (String(country).toUpperCase() === 'FR' ? [b.national_id, b.siret, b.siren].map(sirenOf).find(Boolean) || noticeSiren(t) : '');
  return { json: { ...t, _market: true, market_task: {
    title: t.title, buyer: (t.buyer && t.buyer.name) || '', buyer_official_name: bp.legal_name || '', buyer_siren: siren || '',
    country, country_name: countryName(country) || 'unknown', language: t.language || null, cpv: (t.cpv || []).slice(0, 5),
    declared_value: t.estimated_value || null, tender_type: t.analysis && t.analysis.tender_type,
    summary: String(t.description || t.body_text || '').replace(/\s+/g, ' ').slice(0, 400),
    requirements: ((t.requirements && t.requirements.items) || []).slice(0, 6).map(r => r.text) } } };
});
