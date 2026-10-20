// Select Buyers. One item per buyer of a SURVIVING tender (non-fit tenders are never researched). Research budget
// (Config maxBuyersToResearch): buyers with a tender still open for bidding, best fit, then nearest deadline; the fictional buyers of
// a demo: true source are never researched (skipped_demo, no slot used). Tender-portal hosts (every source host + the hosts
// of the buyer's own tender pages) are passed on so Parse Research never takes a portal for the buyer's official website.
/*@lib hostOfUrl PLATFORM_HOST*/
const cfg = $('00 - Config').first().json;
const FIT = { high: 3, medium: 2, low: 1, none: 0 };
const countryName = code => { try { return code && /^[A-Z]{2}$/i.test(code) ? new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase()) : code; } catch { return code; } };
const sourceHosts = cfg.sources.flatMap(s => [s.url, s.request && s.request.url]).filter(Boolean).map(hostOfUrl);
// a source marked demo: true (Config) serves SYNTHETIC tenders whose buyers are fictional: researching them spends a slot on
// live registry / web calls that can only return homonyms. A buyer is real as soon as one of its tenders is also seen elsewhere
const demoSources = new Set(cfg.sources.filter(s => s.demo).map(s => s.name));
// the notice's own identity of its buyer: its national id (API2 buyer.national_id: BOAMP codeIdentificationNational, eForms
// CompanyID) -> the SIREN in France (a SIRET's 9 first digits; Luhn key checked as in Select Market Studies: a phone or reference
// number is never one), and where the notice places it (place: BOAMP department codes, or the page's own words). The agent searches
// the registry by that SIREN first, and Parse Research refuses an identity with another SIREN ("ATIH." took the Paris translation
// firm "AGENCE DE TRADUCTION INTERPRETARIAT HASSIBI (ATIH)", the notice gave the agency's SIRET 18009229800033)
const luhn = d => { let s = 0; for (let i = 0; i < d.length; i++) { let x = Number(d[d.length - 1 - i]); if (i % 2) { x *= 2; if (x > 9) x -= 9; } s += x; } return s % 10 === 0; };
const sirenOf = v => { const d = String(v || '').replace(/\D/g, ''); return (d.length === 9 || d.length === 14) && luhn(d.slice(0, 9)) ? d.slice(0, 9) : ''; };
const groups = new Map();
for (const { json: t } of $input.all()) {
  if (t._type || !t.survivor) continue;
  const g = groups.get(t.buyer_key) || { buyer_key: t.buyer_key, buyer_id: t.buyer_id, name: (t.buyer && t.buyer.name) || '', country: (t.buyer && t.buyer.country) || null,
    language: t.language || null, tenders: [], emails: new Set(), phones: new Set(), websites: new Set(), addresses: new Set(), portals: new Set(), submission: new Set(), fit: 0, nearest: 99999, real: false,
    ids: new Set(), sirens: new Set(), places: new Set() };
  g.real = g.real || [t.source, ...(t.also_seen_in || []).map(x => x.source)].some(s => !demoSources.has(s));
  const c = (t.buyer && t.buyer.contacts) || {};
  if (c.email) g.emails.add(c.email); if (c.phone) g.phones.add(c.phone); if (c.website) g.websites.add(c.website); if (c.address) g.addresses.add(c.address);
  const bu = t.buyer || {}, id = String(bu.national_id || '').replace(/\s/g, '');
  if (id) g.ids.add(id);
  if (String(bu.country || g.country || '').toUpperCase() === 'FR') for (const v of [bu.national_id, bu.siret, bu.siren]) if (sirenOf(v)) g.sirens.add(sirenOf(v));
  if (t.place && String(t.place).trim()) g.places.add(String(t.place).trim().slice(0, 200));
  for (const u of [t.source_url, t.submission_url, t.documents_url, ...(t.also_seen_in || []).map(x => x.url)]) if (u) g.portals.add(hostOfUrl(u));
  if (t.submission_url) g.submission.add(hostOfUrl(t.submission_url));
  g.tenders.push({ tender_id: t.tender_id, external_id: t.external_id, title: t.title });
  g.fit = Math.max(g.fit, FIT[t.analysis.fit] || 0);
  if (!t.too_late) g.nearest = Math.min(g.nearest, t.days_left ?? 99999);   // a too-late tender never pulls a buyer up the queue
  g.open = g.open || !t.too_late;
  groups.set(t.buyer_key, g);
}
const list = [...groups.values()].sort((a, b) => (!!b.open - !!a.open) || b.fit - a.fit || a.nearest - b.nearest || b.tenders.length - a.tenders.length);
const max = cfg.limits.maxBuyersToResearch || 0;
let used = 0;                                                  // only named, real buyers use a research slot
const out = list.map(g => {
  // a website declared in the notice is trusted, unless it is also a source / submission platform host
  const declared = [...g.websites].map(hostOfUrl).filter(h => !sourceHosts.includes(h) && !g.submission.has(h));
  const exclude = [...new Set([...sourceHosts, ...g.portals])].filter(h => h && !declared.includes(h));
  const named = !!g.name && !String(g.buyer_key).startsWith('unknown:');
  const run = named && g.real && used < max;
  if (run) used++;
  return { json: { _type: 'buyer', _run: run, research_status: !named ? 'skipped_no_buyer_name' : !g.real ? 'skipped_demo' : run ? 'researched' : 'not_researched_budget',
    buyer_key: g.buyer_key, buyer_id: g.buyer_id, name: g.name, country: g.country, country_name: countryName(g.country) || 'unknown', language: g.language,
    known_website: [...g.websites].find(w => !exclude.includes(hostOfUrl(w)) && !PLATFORM_HOST.test(hostOfUrl(w))) || '',
    // the name without a legal form around it ("EPA-SHOM" -> "SHOM", "GIP RESAH" -> "RESAH"): registries often know the short name
    search_name: g.name.replace(/\((EPA|EPIC|EPST|EPSCP|GIP|GIE|SEM|SPL|SA|SAS|SARL)\)/gi, ' ').replace(/^\s*(EPA|EPIC|EPST|EPSCP|GIP|GIE|SEM|SPL)\b[\s\-:]*/i, '').replace(/[\s\-:]*\b(EPA|EPIC|GIP|SA|SAS|SARL)\s*$/i, '').replace(/\s+/g, ' ').trim(),
    tender_titles: g.tenders.slice(0, 3).map(x => x.title), tenders: g.tenders,
    notice_contacts: { emails: [...g.emails], phones: [...g.phones], websites: [...g.websites], addresses: [...g.addresses] },
    national_id: [...g.ids][0] || null, notice_sirens: [...g.sirens].slice(0, 3), notice_places: [...g.places].slice(0, 5),
    exclude_hosts: exclude } };
});
return out.length ? out : [{ json: { _type: 'buyer', _run: false, research_status: 'no_survivors', name: '', buyer_key: null } }];
