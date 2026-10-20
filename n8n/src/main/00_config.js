// ============================================================================
// 00 - Config: the ONLY place that knows your company, your sources and your model. No secrets here (Firecrawl key, model
// keys and the proposal studio's key live in n8n Credentials). Another company = edit `company` and `sources`, nothing else.
// Manual run = "test" preset, scheduled run = "production". Set FORCE_PRESET to 'test' or 'production' to override.
// ============================================================================
const FORCE_PRESET = null;
// DEMO_MODE = true: the run reads ONLY the synthetic demo tenders (node demo/server.js, port 8004; demo/demo_tenders.json), so a
// demo always has fitting tenders. Everything after the source is real (analysis LLM, checks, RAG, market study, proposal input).
// To mix them with the real sources instead (BOAMP + demo + the URL agent), leave DEMO_MODE false and set enabled: true on
// the 'demo' source below: every enabled source runs, API and URL alike.
const DEMO_MODE = false;
const PRESET = FORCE_PRESET || ($execution.mode === 'test' ? 'test' : 'production');
const PRESETS = {
  //           records per API   pages per URL source   tenders per URL source     buyers researched by the agent   skip tenders already exported   market studies (competitor & budget agent)
  test:       { maxRecordsPerApi: 20,  maxPagesPerUrl: 1, maxTendersPerUrlSource: 5,  maxBuyersToResearch: 3,  skipKnown: false, maxMarketStudies: 3 },
  production: { maxRecordsPerApi: 300, maxPagesPerUrl: 3, maxTendersPerUrlSource: 40, maxBuyersToResearch: 40, skipKnown: true, maxMarketStudies: 15 },
};

// ===== the only LLM setting: which "Model - ..." node the LLM Model Selector uses (model name + credential live in that node)
const LLM_PROVIDER = 'ollama';   // ollama | gemini | groq | openai | anthropic
if (!['ollama', 'gemini', 'groq', 'openai', 'anthropic'].includes(LLM_PROVIDER)) throw new Error('Unknown LLM_PROVIDER: ' + LLM_PROVIDER);

const company = {
  name: 'OliveSoft',
  services: [
    'web and mobile applications, custom software and digital platforms',
    'AI / LLM solutions (chatbots, RAG, document intelligence)',
    'workflow automation and RPA',
    'data platforms, integration and BI / analytics',
    'CRM and enterprise software integration',
  ],
  technologies: ['Python', 'JavaScript/TypeScript', 'React', 'Node.js', 'PostgreSQL', 'cloud', 'LLM', 'RAG', 'machine learning', 'n8n', 'Power BI', 'Salesforce'],
  // the kinds of tender the analysis LLM chooses from (rename / add your own for another business; 'other' always exists).
  // bid: false = never a fit, whatever the LLM says (a rule in code, not an opinion)
  tenderTypes: {
    software_build: { bid: true, desc: 'develop or modernise software, apps, websites' },
    ai_data: { bid: true, desc: 'AI, data, analytics, BI, document AI' },
    integration_saas: { bid: true, desc: 'integrate, configure or host existing software / SaaS / ERP' },
    consulting: { bid: true, desc: 'IT studies, project management assistance' },
    maintenance_support: { bid: true, desc: 'support and maintenance of existing software' },
    training: { bid: false, desc: 'training courses for staff' },
    hardware_supply: { bid: false, desc: "computers, devices, audio-video or network equipment, or reselling a vendor's licences" },
    non_it: { bid: false, desc: 'works, goods or services that are not IT' },
  },
  exclusions: ['travaux', 'construction', 'nettoyage', 'entretien ménager', 'ordures ménagères'],
  // broad words (any language) used ONLY to drop obvious non-fit API records (exclusion word AND none of these)
  keywords: ['logiciel', 'informatique', 'numérique', 'application', 'plateforme', 'données', 'intelligence artificielle', 'IA', 'LLM', 'chatbot',
    'machine learning', 'automatisation', 'workflow', 'dématérialisation', 'data', 'décisionnel', 'tableaux de bord', 'CRM', 'ERP', 'API',
    'progiciel', "système d'information", 'site internet', 'site web', 'développement', 'e-commerce', 'software', 'digital',
    'برمجيات', 'رقمنة', 'منصة', 'تطبيق'],
};

// ---------------------------------------------------------------------------------------------------------------
// SOURCES. Two kinds, both config-only:
//  type 'url': ANY site, any language. `url` can be the list of tenders itself, ONE notice, or just the home page: the
//              Tender Scout Agent opens pages with its tool (home page -> menu -> list, then the next pages) and answers with the
//              ids of the tender links; Firecrawl reads each one, the extract LLM fills the standard fields.
//              `maxPages` = pages of the list it may read (it follows "next"); it may also open `limits.maxListHops` pages to
//              reach the list. `pageParam` (?paged=2) or a "{page}" placeholder in the URL = the page URLs are given to it.
//  type 'api': a public JSON API. `request` says how to call it ({since} {sinceCompact} {keywords} {limit} {offset} {page}
//              placeholders), `records` where the list is, `fields` which record field holds each standard field
//              (dot paths; multilingual objects are resolved with `preferLanguages`), `noticeTypes` how to recognise
//              awards / cancellations / rectifications. `fields.body` = a structured notice body (EU eForms JSON, or BOAMP's
//              legacy FNSimple / MAPA layout) parsed for description, CPV, lots, criteria, duration, value, the buyer's contact
//              block and national id (SIRET), the selection text and a rectification's new deadline. No LLM, no Firecrawl.
//              Other optional `fields`: description, cpv, country (ISO-2 or ISO-3), estimated_value, currency, duration,
//              submission_url, documents_url (where the tender documents are), language, email, phone, website, address. `records: '$'` = the answer itself is the list.
//              `request.headers` = extra HTTP headers. `titleStrip` = regex removed from titles (e.g. a "Country – " prefix).
// Both kinds: `dateOrder` 'dmy' (default, 03/11/2026 = 3 Nov) | 'mdy' (US) | 'ymd'.
// ---------------------------------------------------------------------------------------------------------------
const sources = [
  { type: 'api', name: 'boamp', enabled: true, country: 'FR', language: 'fr', currency: 'EUR',
    request: {
      method: 'GET', url: 'https://boamp-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/boamp/records',
      query: { where: "dateparution >= date'{since}' AND type_marche != 'TRAVAUX' AND ({keywords})", order_by: 'dateparution desc' },
      keywordClause: 'search(objet, "{kw}") OR search(descripteur_libelle, "{kw}")',   // title + descriptors only (full text hits legal boilerplate)
      paging: { style: 'offset', offsetParam: 'offset', limitParam: 'limit', pageSize: 100 } },
    keywords: ['logiciel', 'informatique', 'application', 'plateforme', 'numérique', 'intelligence artificielle', 'chatbot', 'données',
      'automatisation', "système d'information", 'dématérialisation', 'site internet', 'développement'],
    records: 'results',
    fields: { id: 'idweb', title: 'objet', buyer: 'nomacheteur', publication_date: 'dateparution', deadline: 'datelimitereponse',
      url: 'url_avis', categories: 'descripteur_libelle', market_type: 'type_marche', place: 'code_departement',
      supersedes: 'annonce_lie', body: 'donnees' },
    noticeTypes: [   // first matching rule wins ({field: regex}); no match = 'open'
      { type: 'cancelled', when: { etat: 'ANNULATION' } }, { type: 'cancelled', when: { nature: 'ANNULATION' } },
      { type: 'award', when: { nature: 'ATTRIBUTION|MODIFICATION|EX_ANTE' } },
      { type: 'rectification', when: { nature: '^RECTIFICATIF$' } },
      { type: 'other', when: { nature: 'PRE-INFORMATION|PERIODIQUE|QUALIFICATION' } } ] },

  // EU-wide TED notices (public API, no key; verified 2026-10-19). To search other EU countries edit buyer-country IN (...):
  // each record keeps its own buyer country. French above-threshold notices are also in BOAMP: Clean merges the copies.
  { type: 'api', name: 'ted', enabled: false, language: 'fr', currency: 'EUR', titleStrip: '^[^–]+ – [^–]+ – ',
    request: {
      method: 'POST', url: 'https://api.ted.europa.eu/v3/notices/search',
      body: { query: '({keywords}) AND publication-date>={sinceCompact} AND notice-type IN (cn-standard cn-social pin-cfc-standard) AND buyer-country IN (FRA)',
        fields: ['publication-number', 'notice-title', 'buyer-name', 'buyer-country', 'publication-date', 'deadline-receipt-tender-date-lot', 'classification-cpv', 'description-lot', 'notice-type', 'links'],
        limit: '{limit}', page: '{page}' },
      keywordClause: 'FT~"{kw}"',
      paging: { style: 'page', in: 'body', pageSize: 50, firstPage: 1 } },
    keywords: ['logiciel', 'application web', 'intelligence artificielle', 'plateforme numérique'],
    records: 'notices', preferLanguages: ['fra', 'eng'],
    fields: { id: 'publication-number', title: 'notice-title', buyer: 'buyer-name', country: 'buyer-country', publication_date: 'publication-date',
      deadline: 'deadline-receipt-tender-date-lot', cpv: 'classification-cpv', description: 'description-lot', url: 'links.html.FRA' },
    noticeTypes: [{ type: 'award', when: { 'notice-type': '^can' } }] },

  { type: 'url', name: 'francemarches', enabled: true, country: 'FR', language: 'fr',
    url: 'https://www.francemarches.com/recherche?q=Intelligence+Artificielle&etat=en-cours', pageParam: 'page', maxPages: 3 },
  { type: 'url', name: 'domainetat-tn', enabled: true, country: 'TN', language: 'fr',
    url: 'https://www.domainetat.tn/?cat=19&lang=fr', pageParam: 'paged', maxPages: 3 },
  // SYNTHETIC demo tenders (fictional buyers): alone when DEMO_MODE = true, or with the other sources when enabled: true.
  { type: 'api', name: 'demo', demo: true, enabled: false, ragDataMode: 'demo', language: 'fr', currency: 'EUR',
    request: { method: 'GET', url: 'http://host.docker.internal:8004/tenders' },
    records: 'results',
    fields: { id: 'id', title: 'title', buyer: 'buyer', country: 'country', publication_date: 'publication_date', deadline: 'deadline',
      description: 'description', cpv: 'cpv', estimated_value: 'estimated_value', currency: 'currency', language: 'language', email: 'email', url: 'url',
      duration: 'duration', award_criteria: 'award_criteria' } },
  // { type: 'url', name: 'my-portal', enabled: true, country: 'TN', language: 'ar', url: 'https://.../list?page={page}', maxPages: 2, allowedHosts: [] },
];

// ===== the team's proposal studio (rfp-studio: a tender inbox + its own deck agents, started with tools/start_studio.ps1)
const STUDIO_URL = 'http://host.docker.internal:8091';
// 'top1' = after the send, "Start Deck" asks the studio for the deck of the rank-1 tender (the studio makes one deck at a time,
// about 36k LLM tokens and 4-5 min each); 'none' = every deck is started by a person, in the studio or the interface
const AUTO_DECK = 'top1';
if (!['none', 'top1'].includes(AUTO_DECK)) throw new Error("proposal autoDeck must be 'none' or 'top1': " + AUTO_DECK);

// "today" = the date in the workflow's timezone (n8n's $now: the workflow setting, else GENERIC_TIMEZONE), not the UTC date: a run at
// 01:58 in Paris (23:58 UTC) is already the next day there, and expiry / days_left count from it
const TIMEZONE = (typeof $now !== 'undefined' && $now && $now.zoneName) || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const localDay = d => { try { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
  .formatToParts(d).map(x => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}`; } catch { return d.toISOString().slice(0, 10); } };   // unknown zone name: UTC
const now = new Date();

return [{ json: {
  preset: PRESET,
  runId: now.toISOString().replace(/[:.]/g, '-'),
  today: localDay(now), timezone: TIMEZONE,
  limits: { ...PRESETS[PRESET], lookbackDays: 30, staleNoDeadlineDays: 90, tooLateDays: 3,
            scoutMaxLinks: 100, extractMaxChars: 10000, analysisMaxChars: 10000,
            maxListHops: 2 },   // URL sources: pages the scout may open to reach the list (home -> menu -> list), 1 Firecrawl credit each
  llm: { provider: LLM_PROVIDER, delayMs: LLM_PROVIDER === 'ollama' ? 0 : 4000 },   // pause between LLM calls (free cloud tiers are rate limited)
  firecrawl: { baseUrl: 'https://api.firecrawl.dev', intervalMs: 6500 },           // free plan: ~10 scrapes / minute
  rag: { url: 'http://host.docker.internal:8001/retrieve/tender',
    // the language of the RAG documents (CVs, projects, tech stack): requirements are written in it, the proof quote stays original
    language: 'English',
    // 'company' = OliveSoft's real knowledge base only (CVs, company records). 'demo' also uses the service's fictional demo
    // records (labelled origin "demo", never a real reference); a source can set its own (the demo source: ragDataMode 'demo')
    dataMode: 'company',
    // the sector words your RAG understands for domain fit (checked 2026-10-19); the analysis LLM must pick one of them or null
    sectors: ['public sector', 'health', 'education', 'telecom', 'finance', 'retail', 'tourism'],
    // reranker scores: a requirement the RAG gives no status of its own is covered from rerankCovered, partial from rerankPartial;
    // Join RAG also takes rerankPartial as the score from which a real (non-demo) document with no matched_on rule hit proves a row
    // (it clears the row's demo flag and sets evidence[].proves)
    rerankCovered: 2.0, rerankPartial: 0.0 },
  // the proposal studio of your team: Build Proposal Input makes one JSON per fit tender (contract in INTEGRATION.md), Adapt for
  // Studio leaves out what the studio would show as proof without being one, "Send to Proposal Service" POSTs it to url (the
  // studio's tender inbox, n8n credential "Proposal Studio key"), "Start Deck" starts a deck (autoDeck). maxTenders = best-ranked
  // fit tenders sent
  proposal: { studioUrl: STUDIO_URL, url: STUDIO_URL + '/api/tenders', autoDeck: AUTO_DECK, maxTenders: 10,
    // default deck options sent with every proposal input (the UI can override them per tender: human in the loop).
    // template_id null = the studio's default template (an id it does not know fails the deck)
    options: { template_id: null, formats: ['pptx', 'pdf'],
      sections: ['context', 'understanding', 'solution', 'team', 'references', 'timeline', 'pricing', 'why_us'],
      overrides: { tone: 'formal', max_slides: 15, gap_strategy: 'mitigate' } } },
  company,
  demoMode: DEMO_MODE,
  sources: sources.filter(s => (DEMO_MODE ? s.demo : s.enabled !== false)),
  // same notice on a portal and on an API -> one tender: ".../3boamp2699266..." -> "boamp:26-99266"
  crossSourceIdRules: [{ pattern: 'boamp[^0-9]*(\\d{2})(\\d{4,6})', canonical: 'boamp:$1-$2' }],
  buyerNameSimilarity: 0.75,   // registry / Wikidata name gate of the buyer research (0..1)
} }];
