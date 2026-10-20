// Builds the four importable workflows from src/: node build.js  ->  dist/RFP - Main.json, dist/RFP - Research Tools.json,
// dist/RFP - Scout Tools.json, dist/RFP - Refine Slide.json
// Code nodes come from src/main/*.js, src/tools/*.js and src/refine/*.js; a "/*@lib a b*/" line is replaced by those helpers
// from src/lib.js (plus their dependencies), so each node only carries the helpers it uses.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROOT = __dirname, SRC = path.join(ROOT, 'src'), DIST = path.join(ROOT, 'dist');

// ---------- helper snippets ----------
const lib = fs.readFileSync(path.join(SRC, 'lib.js'), 'utf8');
const snippets = {};
for (const part of lib.split(/^\/\/@snippet /m).slice(1)) {
  const [head, ...rest] = part.split('\n');
  const [name, , ...needs] = head.trim().split(/\s+/);
  snippets[name] = { needs: head.includes(' needs ') ? needs : [], code: rest.join('\n').trim() };
}
const expand = (names, seen = new Set()) => names.flatMap(n => {
  if (seen.has(n)) return [];
  if (!snippets[n]) throw new Error(`unknown snippet ${n}`);
  seen.add(n);
  return [...expand(snippets[n].needs, seen), snippets[n].code];
});
// invisible / combining characters are written as backslash-u escapes, so copy-paste can never silently change a regex
const BS = String.fromCharCode(92);
const HIDDEN = new RegExp('[' + BS + 'p{Cf}' + BS + 'p{Mn}' + String.fromCharCode(0xA0, 0x2007, 0x202F) + ']', 'gu');
const code = rel => {
  const src = fs.readFileSync(path.join(SRC, rel), 'utf8');
  return src.replace(/^\/\*@lib ([^*]+)\*\/$/m, (_, list) => `// ---- shared helpers ----\n${expand(list.trim().split(/\s+/)).join('\n')}\n// ---- end helpers ----`).trim()
    .replace(HIDDEN, c => BS + 'u' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')) + '\n';
};

// ---------- your sub-workflows (their ids in YOUR n8n: open the workflow, the id is in the URL) ----------
const SCOUT_TOOLS_ID = 'kJh2xit7vcFVsP7i';      // "Scout Tools": paste dist/RFP - Scout Tools.json into it
const RESEARCH_TOOLS_ID = 'QHV4m1jKm8fKBXNA';   // "Research Tools": paste dist/RFP - Research Tools.json into it

// ---------- node factories ----------
const uuid = name => { const h = crypto.createHash('sha1').update('rfp-v3:' + name).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const node = (name, type, typeVersion, position, parameters, extra = {}) => ({ parameters, type, typeVersion, position, id: uuid(name), name, ...extra });
const codeNode = (name, file, pos, extra) => node(name, 'n8n-nodes-base.code', 2, pos, { jsCode: code(file) }, extra);
const ifRun = (name, pos, field = '_run') => node(name, 'n8n-nodes-base.if', 2.2, pos, { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
  conditions: [{ id: uuid(name + ':c'), leftValue: `={{ $json.${field} }}`, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} });
const merge = (name, pos, inputs = 2) => node(name, 'n8n-nodes-base.merge', 3, pos, inputs === 2 ? {} : { numberInputs: inputs });
const chain = (name, pos) => node(name, '@n8n/n8n-nodes-langchain.chainLlm', 1.7, pos, { promptType: 'define', text: '={{ $json._sys }}\n\n{{ $json._usr }}',
  // n8n waits between batches only when batchSize > 1: local model = 1 call at a time, cloud = pairs + pause (Config llm.delayMs)
  batching: { batchSize: "={{ $('00 - Config').first().json.llm.delayMs > 0 ? 2 : 1 }}", delayBetweenBatches: "={{ $('00 - Config').first().json.llm.delayMs * 2 }}" } }, { onError: 'continueRegularOutput' });
const CFG = "$('00 - Config').first().json";
const FIRECRAWL = { httpHeaderAuth: { id: 'CfeiKFMFWXxIkMe6', name: 'Header Auth account' } };
// the proposal studio's API key: a Header Auth credential (name X-API-Key, value = the studio's STUDIO_API_KEY) you create in n8n,
// so the key never goes into the repository
const STUDIO_KEY = { httpHeaderAuth: { id: 'StudioKey0000001', name: 'Proposal Studio key' } };
// Firecrawl's per-minute budget (Config firecrawl.intervalMs: 6500 ms = 9 calls a minute) is shared with the scout's open_page scrapes
// made just before (11 req/min -> HTTP 429 on the 7th detail call). Their count, from the agent's steps (no times there: worst case,
// all of them in the last minute); paced(f) = an n8n expression of f with I = intervalMs and B = calls a minute. A call Resolve Source
// refused ("refused, no page read": a host of no source, sent around Firecrawl Scrape by "Known source?") is no scrape: the real run's
// 5 open_page calls were 4 scrapes, and counting 5 made detail item 4 wait 41.5 s (9 calls with a refused one: a 61 s Pace for nothing)
const SCOUT_SCRAPES = "$('Tender Scout Agent').all().reduce((s, x) => s + (x.json.intermediateSteps || []).filter(t => t.action && t.action.tool === 'open_page' && !/refused, no page read/.test(typeof t.observation === 'string' ? t.observation : JSON.stringify(t.observation || ''))).length, 0)";
const paced = f => `={{ (I => (B => ${f})(Math.floor(60000 / I)))(${CFG}.firecrawl.intervalMs) }}`;
const firecrawl = (name, pos) => node(name, 'n8n-nodes-base.httpRequest', 4.5, pos, {
  method: 'POST', url: `={{ ${CFG}.firecrawl.baseUrl }}/v2/scrape`, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
  sendBody: true, specifyBody: 'json', jsonBody: "={{ JSON.stringify({ url: $json.url, formats: ['markdown'], onlyMainContent: $json.onlyMainContent ?? true, timeout: 45000 }) }}",
  // the first minute keeps room for the scout's scrapes: n detail calls, then the call that would go over waits for that minute to
  // pass. Options are read per item: $itemIndex is the call about to be made. n8n never delays item 0: after a scout that used the
  // whole budget (B or more open_page calls) "Firecrawl Pace" waited 61 s before URL3, so the detail calls start a fresh minute (n = B)
  options: { batching: { batch: { batchSize: 1, batchInterval: paced(`(n => $itemIndex === n ? Math.max(I, 61000 - (n - 1) * I) : I)((k => (k >= B ? B : Math.max(1, B - k)))(${SCOUT_SCRAPES}))`) } }, timeout: 60000 } },
  { credentials: FIRECRAWL, onError: 'continueRegularOutput' });   // no retryOnFail: n8n would re-scrape EVERY page when item 0 fails
const sticky = (name, pos, w, h, content, color = 7) => node(name, 'n8n-nodes-base.stickyNote', 1, pos, { content, height: h, width: w, color });
const toolNode = (name, pos, description, inputs, optional = []) => node(name, '@n8n/n8n-nodes-langchain.toolWorkflow', 2.2, pos, {
  description, workflowId: { __rl: true, value: RESEARCH_TOOLS_ID, mode: 'id' },
  workflowInputs: { mappingMode: 'defineBelow', value: { tool: name, firecrawl_base: "={{ $('00 - Config').first().json.firecrawl.baseUrl }}", ...Object.fromEntries(Object.entries(inputs).map(([k, d]) => [k, `={{ /*n8n-auto-generated-fromAI-override*/ $fromAI('${k}', \`${d}\`, 'string'${optional.includes(k) ? ", ''" : ''}) }}`])) },
    matchingColumns: [], schema: ['tool', 'firecrawl_base', 'q', 'buyer_name', 'siren', 'query', 'url', 'cpv', 'country'].map(id => ({ id, displayName: id, required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string', ...(id === 'tool' || id === 'firecrawl_base' || id in inputs ? {} : { removed: true }) })),
    attemptToConvertTypes: false, convertFieldsToString: false } });
const modelRule = (provider, index) => ({ ...(index > 1 ? { modelIndex: index } : {}), conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
  conditions: [{ id: uuid('rule:' + provider), leftValue: `={{ ${CFG}.llm.provider }}`, rightValue: provider, operator: { type: 'string', operation: 'equals' } }], combinator: 'and' } });

// ---------- RFP - Main ----------
const Y = { api: 700, main: 900, url: 1160, agent: 400, tools: 640, models: 1560 };
const AGENT_SYSTEM = `You research ONE organisation that published a public tender, by calling tools. Code checks every fact against the tool results, so only report what the tools returned.
GOAL: official website, contact email and phone, past tenders or contracts, supervising bodies or partners, size or budget signals.
RULES
- Several tools cover ONE country only (see each tool description). Call them only when COUNTRY matches.
- First call: wikidata_lookup with the buyer name (when the task gives BUYER SIREN: registry_search with that SIREN first).
- BUYER SIREN (France) is the buyer's own number, given by the tender notice: call registry_search with q = that 9-digit SIREN before any registry search by name, then decp_awards with it. The row with that siren IS the buyer, whatever its legal name; a registry row or a Wikidata siren= with another siren is another organisation, even when it shares the buyer's acronym.
- When the registry tool applies and finds no match, retry it ONCE with a shorter name (without the administrative prefix, e.g. "Ville de", "Commune de", "Ministry of").
- If the buyer name is an acronym or a short name and wikidata_lookup shows a longer official name for it, call registry_search with that official name (and boamp_history too when the first one found nothing).
- When the task gives ALSO SEARCH AS, use that name too when a search under the full name finds no matching row.
- When registry_search gives the buyer's siren (France), call decp_awards with it in your NEXT step (it needs that siren): its contracts give amounts and numbers of bids.
- boamp_history: call it with the buyer name exactly as written after BUYER (the name its notices publish), never with the registry's legal name.
- web_search: ALWAYS call it at least once when no website was given in the tender: the buyer name plus the country name, written in the buyer's LANGUAGE (LANGUAGE fr: French words such as "site officiel", never English). If no official site appears, retry ONCE with another query (the name with its town or its activity).
- buyer_type: when registry_search matched the buyer, public=yes means one of local_authority, regional_authority, state_administration, public_agency, health, education_research, and public=mixed means public_company; never private_company.
- registry staff= is a BAND of employees (staff=100-199: between 100 and 199), never an exact number.
- web_scrape: only pages of the buyer's own website (contact or about page), at most 2 pages.
- Never repeat an identical call. At most 8 calls.
- Before the final answer: decp_awards must have been called (France, when registry_search gave the siren) and web_search too (when no website was given). If not, call them first.
FINAL ANSWER: ONE JSON object and nothing else:
{"buyer_type":"local_authority|regional_authority|state_administration|public_agency|public_company|health|education_research|private_company|other|unknown","size_hint":"small|medium|large|unknown","summary":"1 to 3 sentences, only facts read in the tool results","official_website":"https://... or null"}`;

const MARKET_SYSTEM = `You study the MARKET of ONE public tender for a company that will bid on it: which AWARDED contracts are comparable, at what
price, and who won them. Code computes the budget range and the competitors from the contracts YOU choose, so choose carefully.
Each tool row is one awarded contract: AWARD | id | date | amount= | cur= | buyer= | winners= | bids= | cpv= | fw= | src= | title=
(fw=yes: a framework agreement, its amount is often a ceiling, not a price).
HOW TO WORK
1. Call similar_awards with the tender's CPV codes cut to their 2 or 3 first digits (72 = IT services, 48 = software packages;
   a full 8-digit code finds few contracts) and 1 to 3 short keywords of the title, in the tender's language (for Tunisia: in
   French, even when the tender is in Arabic): the words that name the deliverable or its acronym ("LLM", "billetterie"),
   never generic ones alone ("agents", "services", "solution").
2. If a call returns no row, or fewer than 5 rows are comparable, call it again with broader keywords or a broader CPV; if most
   rows are unrelated, narrower.
3. Call buyer_awards with the buyer name (and the siren when the task gives one).
4. Choose the COMPARABLE contracts: the same kind of deliverable and a similar scope (not hardware supply for a software tender,
   not a national framework for a small local project). Several buyers are fine. Never leave out a row with an amount and fw=no
   whose title names the tender's deliverable: it is the best price reference.
RULES: at most 3 tool calls (their results are long and your memory is small); never repeat an identical call; use only ids
returned by the tools. If no tool returns rows (for example a country without public award data), answer with an empty list and say so.
FINAL ANSWER: ONE JSON object and nothing else:
{"comparable_ids":["id","id"],"positioning":"2 to 4 sentences: who usually wins this kind of contract, how many bids to expect, how to position the bid. Only facts from the rows.","budget_comment":"one sentence on the likely budget, only from the rows"}`;

const SCOUT_SYSTEM = `You find the CURRENT calls for tenders (public procurement notices) published on ONE website, with the tool open_page.
Code checks everything you report against what the tool returned, so only use ids and URLs that the tool showed you.
open_page returns the page id, the start of its text, then its same-site links, one per line: [id] link text — context | url
HOW TO WORK
1. Call open_page with the START URL (then with each OTHER PAGE given in the task).
2. If the START page is itself ONE tender notice (one buyer, one object, its own dates): its PAGE id is the only tender.
   Open no other page and answer.
3. If the page lists tenders: note the ids of the links that each open ONE tender / call for bids / consultation notice.
   open_page shows the list's next page as "NEXT PAGE: [id] | url": while you have pages left, open it and note its tenders too.
4. If the page is not the list of current tenders (home page, menu, section page, a page with only a few "latest" notices):
   open the ONE link that most likely leads to that list (e.g. "Appels d'offres", "Marchés publics", "Consultations",
   "Tenders", "Procurement", "طلبات العروض", "الصفقات العمومية"), then continue from step 3.
RULES
- ONE page per open_page call, one call at a time (never several calls at once): every page costs a credit.
- Open only URLs written in a tool result or in the task, each URL at most once, and never more pages than allowed.
- Do not open the tender notices themselves: their ids on the list are enough.
- Not tenders: news, events, jobs, categories, filters, sorting, search, pagination, login, contact, social and help pages.
FINAL ANSWER: ONE JSON object and nothing else:
{"tender_links":["id","id"],"list_url":"URL of the page that lists the tenders, or null"}`;

const mainNodes = [
  sticky('Note - Sources', [-900, 520], 2000, 860, '## 1. Discover and extract tenders (two lanes, one standard tender object)\n**API lane** (top): public JSON APIs described in Config (`request`, `records`, `fields`). No LLM, no Firecrawl.\n**URL lane** (bottom): ANY site: the tender list, one notice or just the home page. The **Tender Scout Agent** opens pages with its tool `open_page` (Scout Tools sub-workflow: Firecrawl + numbered links): from a home page it finds the tender list, follows the next pages, and answers with the **ids** of the tender links (it never writes a tender URL; URL3 maps the ids back). Then Firecrawl reads each tender, the extract LLM fills the fields, code verifies them against the page.', 4),
  sticky('Note - Analysis', [1120, 680], 1500, 420, '## 2. Clean, then ONE analysis call per kept tender\nClean = facts in code (dates, awards, expiry, duplicates). Analysis = type + fit + proof quote + requirements (only when fit is high/medium). Code verifies the quote and every requirement.', 5),
  sticky('Note - Buyers', [2680, 180], 1240, 960, '## 3. Research only the buyers of fit tenders\nThe agent calls the tools; **Parse Research** builds the profile from the tool results with name / domain gates. The agent never writes facts into the profile directly.', 6),
  sticky('Note - Models', [940, 1440], 760, 420, '## Models\nPick the provider in `00 - Config` (`LLM_PROVIDER`), the model name in its node.\nn8n loads **every** connected model on each call: give each Model node a credential (a placeholder key is fine for providers you do not use) and do not disable them.', 7),
  sticky('Note - RAG',[3980, 680], 1120, 500, '## 4. Match requirements with your knowledge base (RAG)\nThe RAG service of your team returns the requirements matrix (covered / partial / missing + proof document) and fit scores. **Join RAG** keeps its status per requirement.', 3),
  sticky('Note - Market', [5130, 180], 1180, 960, '## 5. Competitor & Budget Agent (market study)\nFor the best fit tenders: the agent searches awarded contracts (TED for France / EU, DECP for France) by CPV and keywords, plus the buyer\'s own past awards, and **chooses the comparable ones by id**. **Parse Market** computes the budget range (25th-75th percentile), the competitors (who won them) and the usual number of bids from those rows; sentences with numbers not in the data are removed.', 6),
  sticky('Note - Export', [6330, 560], 1400, 620, '## 6. Rank, export, hand off to the proposal studio\n**Build Proposal Input** = one JSON per fit tender (contract in INTEGRATION.md) + a file with all of them (the full v2). **Adapt for Studio** = the copy the studio gets: no demo record or weak proof shown as proof, the proposed team and its certifications, no budget the market study does not support, the studio\'s default template. **Send to Proposal Service** POSTs it to the studio\'s tender inbox (Config proposal.url, credential "Proposal Studio key"). **Start Deck** starts the deck of the rank-1 tender (Config proposal.autoDeck \'top1\'; \'none\' = every deck from the interface). Run Summary = the run report.', 5),

  node('Weekly Schedule', 'n8n-nodes-base.scheduleTrigger', 1.2, [-1760, 820], { rule: { interval: [{ field: 'weeks', triggerAtDay: [1], triggerAtHour: 6 }] } }),
  node('When clicking ‘Execute workflow’', 'n8n-nodes-base.manualTrigger', 1, [-1760, 1000], {}),
  codeNode('00 - Config', 'main/00_config.js', [-1552, 900], { notes: 'Company, sources, limits and model choice. Manual run = test preset, scheduled run = production preset.' }),
  node('01 - Load Known IDs (Google Sheets)', 'n8n-nodes-base.googleSheets', 4.5, [-1328, 900], { documentId: { __rl: true, value: 'YOUR_GOOGLE_SHEET_ID', mode: 'id' }, sheetName: { __rl: true, value: 'tenders', mode: 'name' }, options: {} },
    { alwaysOutputData: true, disabled: true, onError: 'continueRegularOutput', notes: 'OPTIONAL. Enable with "Save to Google Sheet" for incremental runs (known canonical_id / pair_key are skipped).' }),
  codeNode('02 - Collect Known IDs', 'main/02_known_ids.js', [-1104, 900]),

  codeNode('API1 - Build Requests', 'main/API1_build_requests.js', [-848, Y.api]),
  node('API Fetch', 'n8n-nodes-base.httpRequest', 4.5, [-624, Y.api], {
    method: '={{ $json.method }}', url: '={{ $json.url }}', sendQuery: true, specifyQuery: 'json', jsonQuery: '={{ JSON.stringify($json.qs || {}) }}',
    // Send Body must stay a literal true (an expression hides the JSON body settings); a null body (GET) sends nothing
    sendBody: true, specifyBody: 'json', jsonBody: '={{ $json.body }}',
    sendHeaders: true, specifyHeaders: 'json', jsonHeaders: '={{ JSON.stringify($json.headers || {}) }}',
    options: { batching: { batch: { batchSize: 1, batchInterval: 500 } }, timeout: 30000 } },
    { onError: 'continueRegularOutput' }),
  codeNode('API2 - Map Records', 'main/API2_map_records.js', [-400, Y.api]),

  codeNode('URL1 - Scout Tasks', 'main/URL1_scout_tasks.js', [-848, Y.url]),
  node('Tender Scout Agent', '@n8n/n8n-nodes-langchain.agent', 2, [-608, Y.url], {
    promptType: 'define',
    text: "={{ 'SITE: ' + $json.source + ' (country ' + ($json.country || '?') + ', language ' + ($json.language || '?') + ')\\nSTART URL: ' + $json.url + ($json.other_pages.length ? '\\nOTHER PAGES OF THE SAME LIST (open each of them too): ' + $json.other_pages.join(' ') : '') + '\\nPAGES YOU MAY OPEN IN TOTAL: ' + $json.max_calls + ' (home and menu pages count too; keep the rest for the NEXT PAGES of the list)' }}",
    options: { systemMessage: SCOUT_SYSTEM, maxIterations: '={{ $json.max_calls + 2 }}', returnIntermediateSteps: true } }, { onError: 'continueRegularOutput' }),
  node('open_page', '@n8n/n8n-nodes-langchain.toolWorkflow', 2.2, [-560, Y.url + 240], {
    description: 'Any website. Open ONE page and get its id, the start of its text, its NEXT PAGE (if it is a list) and its same-site links, each as: [id] link text — context | url. Input url: a full https URL from the task or from an earlier open_page result.',
    workflowId: { __rl: true, value: SCOUT_TOOLS_ID, mode: 'id' },
    workflowInputs: { mappingMode: 'defineBelow', value: { tool: 'open_page', firecrawl_base: `={{ ${CFG}.firecrawl.baseUrl }}`,
      // fixed by code, not by the model: every URL source of Config (Resolve Source picks the page's one by host), links shown
      url_sources: `={{ JSON.stringify(${CFG}.sources.filter(s => s.type === 'url').map(s => ({ name: s.name, url: s.url, allowedHosts: s.allowedHosts || [], only_main: s.onlyMainContent !== false }))) }}`,
      max_links: `={{ ${CFG}.limits.scoutMaxLinks }}`,
      url: "={{ /*n8n-auto-generated-fromAI-override*/ $fromAI('url', `Full https URL of the page to open`, 'string') }}" },
      matchingColumns: [], schema: ['tool', 'firecrawl_base', 'url_sources', 'max_links', 'url'].map(id => ({ id, displayName: id, required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' })),
      attemptToConvertTypes: false, convertFieldsToString: false } }),
  // item 0 of Firecrawl Detail is never delayed by its batching: when the scout's open_page calls used the whole minute (B or more),
  // wait 61 s once so the first detail call is not the 429 one. In front of URL3, not of Firecrawl Detail: the agent gives ONE item
  // per task, so the pairing URL3 -> URL1 and URL4 -> URL3 never crosses this pass-through node after a one-to-many node.
  // Under 65 s n8n waits in the running execution (no database round trip)
  node('Firecrawl Pace', 'n8n-nodes-base.wait', 1.1, [-448, Y.url], { amount: paced(`${SCOUT_SCRAPES} >= B ? 61 : 0`), unit: 'seconds' },
    { webhookId: uuid('Firecrawl Pace:webhook'), notes: 'Waits 61 s only when the scout\'s open_page scrapes used the whole Firecrawl minute (Config firecrawl.intervalMs).' }),
  codeNode('URL3 - Links to URLs', 'main/URL3_links_to_urls.js', [-288, Y.url]),
  firecrawl('Firecrawl Detail', [-64, Y.url]),
  codeNode('URL4 - Build Extract Prompt', 'main/URL4_build_extract_prompt.js', [160, Y.url]),
  chain('LLM - Extract', [384, Y.url]),
  codeNode('URL5 - Verify Extraction', 'main/URL5_verify_extraction.js', [608, Y.url]),

  merge('Merge Sources', [1168, Y.main], 3),
  codeNode('Clean & Dedupe', 'main/CLEAN_clean_dedupe.js', [1392, Y.main]),
  codeNode('Build Analysis Prompt', 'main/AN1_build_analysis_prompt.js', [1616, Y.main]),
  ifRun('Kept?', [1840, Y.main]),
  chain('LLM - Analyze Tender', [2064, Y.main - 120]),
  merge('Merge Analysis', [2288, Y.main]),
  codeNode('Verify Analysis', 'main/AN2_verify_analysis.js', [2512, Y.main]),

  codeNode('Select Buyers', 'main/BU1_select_buyers.js', [2736, Y.main]),
  ifRun('Research?', [2960, Y.main]),
  node('Buyer Research Agent', '@n8n/n8n-nodes-langchain.agent', 2, [3184, Y.agent], {
    promptType: 'define',
    text: "={{ 'BUYER: ' + $json.name + ($json.search_name && $json.search_name !== $json.name ? '\\nALSO SEARCH AS: ' + $json.search_name : '') + (($json.notice_sirens || []).length ? '\\nBUYER SIREN (given by the tender notice): ' + $json.notice_sirens.join(', ') : '') + '\\nCOUNTRY: ' + $json.country + ' (' + $json.country_name + ')\\nLANGUAGE: ' + ($json.language || 'unknown') + '\\nWEBSITE GIVEN IN THE TENDER: ' + ($json.known_website || 'none') + '\\nTHEIR CURRENT TENDERS: ' + $json.tender_titles.join(' | ') }}",
    options: { systemMessage: AGENT_SYSTEM, maxIterations: 10, returnIntermediateSteps: true } }, { onError: 'continueRegularOutput' }),
  toolNode('wikidata_lookup', [3040, Y.tools], 'Any country. Look up an organisation on Wikidata. Returns up to 2 lines: label, description, country, SIREN (France), official website, employees and revenue (with year) when known. Namesakes abroad are other bodies. Input q: the organisation name.', { q: 'Name of the organisation' }),
  toolNode('registry_search', [3160, Y.tools], 'FRANCE ONLY. Search the French company and administration registry by name or by 9-digit SIREN. Returns up to 5 lines: legal name, siren, siret, address, legal form, public body (yes / mixed = SEM, a mixed-economy company with majority public capital / no), staff band (a range of employees, e.g. 100-199), revenue when known. Input q: the 9-digit BUYER SIREN when the task gives one, else the buyer name.', { q: 'BUYER SIREN (9 digits) when given, else the buyer name' }),
  toolNode('boamp_history', [3280, Y.tools], 'FRANCE ONLY. List the public notices (calls for tenders and award notices with winners) published by this buyer in the last 3 years. Input buyer_name: the buyer name exactly as published in the tender (BUYER), not the registry\'s legal name.', { buyer_name: 'Buyer name as published in the tender' }),
  toolNode('decp_awards', [3400, Y.tools], 'FRANCE ONLY. List the contracts this buyer awarded, with amounts and number of bids received. Input siren: the 9-digit SIREN found with registry_search.', { siren: '9-digit SIREN of the buyer' }),
  toolNode('web_search', [3520, Y.tools], 'Any country. Search the web. Returns up to 5 lines (url, title, snippet). Use it to find the official website and digital projects. Input query: a short search query.', { query: 'Short web search query' }),
  toolNode('web_scrape', [3640, Y.tools], 'Any country. Read ONE page of the buyer\'s own website (contact or about page). Returns the emails and phones found and a text excerpt. Input url: full https URL.', { url: 'Full https URL of the page to read' }),
  codeNode('Parse Research', 'main/BU2_parse_research.js', [3600, Y.agent]),
  merge('Merge Buyers', [3824, Y.main]),
  codeNode('Join Buyers & Build RAG', 'main/RG1_join_buyers_build_rag.js', [4048, Y.main]),
  ifRun('Has requirements?', [4272, Y.main]),
  node('Call RAG', 'n8n-nodes-base.httpRequest', 4.5, [4496, Y.main - 120], {
    method: 'POST', url: `={{ ${CFG}.rag.url }}`, sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.rag_body) }}', options: { timeout: 120000, batching: { batch: { batchSize: 1, batchInterval: 1000 } } } },
    { onError: 'continueRegularOutput' }),
  merge('Merge RAG', [4720, Y.main]),
  codeNode('Join RAG', 'main/RG2_join_rag.js', [4944, Y.main]),
  codeNode('Select Market Studies', 'main/MK1_select_market_studies.js', [5168, Y.main]),
  ifRun('Study market?', [5392, Y.main], '_market'),
  node('Competitor & Budget Agent', '@n8n/n8n-nodes-langchain.agent', 2, [5616, Y.agent], {
    promptType: 'define',
    text: "={{ (t => 'TENDER: ' + t.title + '\\nBUYER: ' + t.buyer + (t.buyer_official_name ? ' (official name: ' + t.buyer_official_name + ')' : '') + (t.buyer_siren ? '\\nBUYER SIREN: ' + t.buyer_siren : '') + '\\nCOUNTRY: ' + (t.country || '?') + ' (' + t.country_name + ')' + '\\nLANGUAGE: ' + (t.language || '?') + '\\nCPV: ' + (t.cpv.join(', ') || 'none given') + '\\nTYPE: ' + (t.tender_type || '?') + '\\nVALUE DECLARED IN THE NOTICE: ' + (t.declared_value || 'none') + '\\nSUMMARY: ' + t.summary + (t.requirements.length ? '\\nREQUIREMENTS: ' + t.requirements.join(' | ') : ''))($json.market_task) }}",
    options: { systemMessage: MARKET_SYSTEM, maxIterations: 7, returnIntermediateSteps: true } }, { onError: 'continueRegularOutput' }),
  toolNode('similar_awards', [5560, Y.tools], 'France, other EU countries and Tunisia. Awarded contracts of ANY buyer similar to a tender, newest first (TED; DECP for France; TUNEPS for Tunisia, amounts in TND). Inputs: cpv = CPV prefixes of 2 or 3 digits separated by commas (e.g. "72, 48"; a full 8-digit code finds few contracts); query = 1 to 3 short keywords or phrases of the tender title separated by commas (each one is searched; in France by its acronym or its most specific word, so "agents LLM" searches LLM), in its language (REQUIRED for Tunisia: TUNEPS has no CPV; its titles are in French, so French keywords find the most, and it matches them literally, as titles write them: "gestion des licences", not "gestion licences"); country = 2-letter country code of the buyer (FR, BE, TN ...).', { cpv: 'CPV codes or prefixes, comma separated', query: 'Short keywords of the tender title, comma separated', country: '2-letter country code of the buyer' }, ['cpv', 'query', 'country']),
  toolNode('buyer_awards', [5700, Y.tools], 'France, other EU countries and Tunisia. Contracts THIS buyer awarded in the last 3 years (amount, winners, bids). Inputs: buyer_name = the buyer name as published; siren = its 9-digit SIREN if known (France; without it, France is searched by buyer name), else empty; cpv = optional CPV prefix to keep only similar contracts (e.g. 72); country = 2-letter country code.', { buyer_name: 'Buyer name as published', siren: '9-digit SIREN of the buyer, or empty', cpv: 'Optional CPV prefix, e.g. 72', country: '2-letter country code of the buyer' }, ['siren', 'cpv', 'country']),
  codeNode('Parse Market', 'main/MK2_parse_market.js', [5940, Y.agent]),
  merge('Merge Market', [6140, Y.main]),
  codeNode('Rank & Export', 'main/EX1_rank_export.js', [6364, Y.main]),
  // above Run Summary on purpose: n8n (v1 order) runs the topmost branch first (Build Proposal Input to Start Deck), so Run
  // Summary can count what was handed off and whether a deck was started
  codeNode('Build Proposal Input', 'main/PR1_build_proposal_input.js', [6588, Y.main - 220]),
  codeNode('Adapt for Studio', 'main/PR2_adapt_for_studio.js', [6812, Y.main - 220], { notes: 'The copy the proposal studio receives: demo records, weak proofs, header lines, non-team CVs and an unsupported budget left out (counted in studio_adapter). Build Proposal Input\'s file stays the full v2.' }),
  node('Send to Proposal Service', 'n8n-nodes-base.httpRequest', 4.5, [7036, Y.main - 220], {
    method: 'POST', url: `={{ ${CFG}.proposal.url }}`, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json) }}',
    options: { timeout: 15000, batching: { batch: { batchSize: 1, batchInterval: 1000 } } } },
    { credentials: STUDIO_KEY, onError: 'continueRegularOutput', notes: 'Stores each proposal input in the proposal studio\'s tender inbox (contract olivesoft.proposal-input.v2, see INTEGRATION.md): Config proposal.url, credential "Proposal Studio key" (header X-API-Key). Answer {status: "ok", id}: one tender per tender_id, a new run replaces it.' }),
  // the rank-1 tender the studio stored, when Config proposal.autoDeck is 'top1' (Adapt for Studio sets studio_adapter.auto_deck);
  // an error item or a pass-through (Send disabled) has no status 'ok'
  node('Start Deck?', 'n8n-nodes-base.if', 2.2, [7260, Y.main - 220], { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
    conditions: [{ id: uuid('Start Deck?:c'), leftValue: "={{ $json.status === 'ok' && !!$json.id && $('Adapt for Studio').item.json.studio_adapter.auto_deck === true }}", rightValue: '',
      operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} }),
  // the studio generates one deck at a time (409 while another runs) and answers at once: 202 {runId}, the deck is made in the
  // background (4-5 min with a real LLM). No templateId: the studio's default template. The key is sent for when the studio
  // checks it on this route too (it does not today)
  node('Start Deck', 'n8n-nodes-base.httpRequest', 4.5, [7484, Y.main - 220], {
    method: 'POST', url: `={{ ${CFG}.proposal.studioUrl }}/api/generations`, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendBody: true, specifyBody: 'json', jsonBody: "={{ JSON.stringify({ tenderId: $json.id, params: $('Adapt for Studio').item.json.studio_adapter.deck_params }) }}",
    options: { timeout: 15000 } },
    { credentials: STUDIO_KEY, onError: 'continueRegularOutput', notes: 'Starts the deck of the rank-1 tender in the proposal studio (Config proposal.autoDeck \'top1\'): 202 {runId}. 409 (another deck is being generated), 503 (generation not configured), 502 (deck agents unreachable) are only reported by Run Summary.' }),
  // above Run Summary too (between the two rows, a half column right): it runs before it, so a failed write is counted (Sheet write)
  node('Save to Google Sheet', 'n8n-nodes-base.googleSheets', 4.5, [6700, Y.main - 110], { operation: 'appendOrUpdate', documentId: { __rl: true, value: 'YOUR_GOOGLE_SHEET_ID', mode: 'id' },
    sheetName: { __rl: true, value: 'tenders', mode: 'name' }, columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['tender_id'], schema: [], attemptToConvertTypes: false, convertFieldsToString: false }, options: {} },
    { disabled: true, onError: 'continueRegularOutput', notes: 'OPTIONAL persistence keyed on tender_id; canonical_id and pair_key columns feed the known-ids check of the next run.' }),
  codeNode('Run Summary', 'main/EX2_run_summary.js', [6588, Y.main]),
  node('Send Run Alert (optional)', 'n8n-nodes-base.emailSend', 2.1, [6812, Y.main], { fromEmail: 'pipeline@example.com', toEmail: 'you@example.com',
    subject: '={{ "RFP pipeline: " + ($json.has_warnings ? "WARNINGS" : "OK") }}', emailFormat: 'text', text: '={{ $json.message }}', options: {} }, { disabled: true }),

  node('LLM Model Selector', '@n8n/n8n-nodes-langchain.modelSelector', 1, [1240, Y.models], { numberInputs: 5, rules: { rule: ['ollama', 'gemini', 'groq', 'openai', 'anthropic'].map((p, i) => modelRule(p, i + 1)) } }),
  node('Model - Ollama', '@n8n/n8n-nodes-langchain.lmChatOllama', 1, [1000, Y.models + 220], { model: 'qwen3:4b-instruct', options: { temperature: 0, numCtx: 8192 } }, { credentials: { ollamaApi: { id: 'WJErbMQ0BDKh8uZB', name: 'Ollama account' } } }),
  node('Model - Gemini', '@n8n/n8n-nodes-langchain.lmChatGoogleGemini', 1, [1140, Y.models + 220], { modelName: 'models/gemini-3.1-flash-lite', options: { temperature: 0 } }, { credentials: { googlePalmApi: { id: 'aMTyXr6dYELQA8DQ', name: 'Google Gemini(PaLM) Api account' } } }),
  node('Model - Groq', '@n8n/n8n-nodes-langchain.lmChatGroq', 1, [1280, Y.models + 220], { model: 'openai/gpt-oss-120b', options: { temperature: 0 } }, { credentials: { groqApi: { id: 'FPcfbtrrjsRjQcB5', name: 'Groq account' } } }),
  node('Model - OpenAI', '@n8n/n8n-nodes-langchain.lmChatOpenAi', 1.2, [1420, Y.models + 220], { model: { __rl: true, mode: 'list', value: 'gpt-4.1-mini' }, options: { temperature: 0 } }, { credentials: { openAiApi: { id: '3oFuvY33PPiWwnf1', name: 'OpenAI account' } } }),
  node('Model - Anthropic', '@n8n/n8n-nodes-langchain.lmChatAnthropic', 1.3, [1560, Y.models + 220], { model: { __rl: true, mode: 'id', value: 'claude-haiku-5-5' }, options: { temperature: 0 } }, { credentials: { anthropicApi: { id: 'XzG8ORjaa0RmjUCR', name: 'Anthropic account' } } }),
];
const M = (to, index = 0, type = 'main') => ({ node: to, type, index });
const mainConnections = {
  'Weekly Schedule': { main: [[M('00 - Config')]] },
  'When clicking ‘Execute workflow’': { main: [[M('00 - Config')]] },
  '00 - Config': { main: [[M('01 - Load Known IDs (Google Sheets)')]] },
  '01 - Load Known IDs (Google Sheets)': { main: [[M('02 - Collect Known IDs')]] },
  '02 - Collect Known IDs': { main: [[M('API1 - Build Requests'), M('URL1 - Scout Tasks'), M('Merge Sources', 2)]] },
  'API1 - Build Requests': { main: [[M('API Fetch')]] },
  'API Fetch': { main: [[M('API2 - Map Records')]] },
  'API2 - Map Records': { main: [[M('Merge Sources', 0)]] },
  'URL1 - Scout Tasks': { main: [[M('Tender Scout Agent')]] },
  'Tender Scout Agent': { main: [[M('Firecrawl Pace')]] },
  'Firecrawl Pace': { main: [[M('URL3 - Links to URLs')]] },
  'open_page': { ai_tool: [[M('Tender Scout Agent', 0, 'ai_tool')]] },
  'URL3 - Links to URLs': { main: [[M('Firecrawl Detail')]] },
  'Firecrawl Detail': { main: [[M('URL4 - Build Extract Prompt')]] },
  'URL4 - Build Extract Prompt': { main: [[M('LLM - Extract')]] },
  'LLM - Extract': { main: [[M('URL5 - Verify Extraction')]] },
  'URL5 - Verify Extraction': { main: [[M('Merge Sources', 1)]] },
  'Merge Sources': { main: [[M('Clean & Dedupe')]] },
  'Clean & Dedupe': { main: [[M('Build Analysis Prompt')]] },
  'Build Analysis Prompt': { main: [[M('Kept?')]] },
  'Kept?': { main: [[M('LLM - Analyze Tender')], [M('Merge Analysis', 1)]] },
  'LLM - Analyze Tender': { main: [[M('Merge Analysis', 0)]] },
  'Merge Analysis': { main: [[M('Verify Analysis')]] },
  'Verify Analysis': { main: [[M('Select Buyers')]] },
  'Select Buyers': { main: [[M('Research?')]] },
  'Research?': { main: [[M('Buyer Research Agent')], [M('Merge Buyers', 1)]] },
  'Buyer Research Agent': { main: [[M('Parse Research')]] },
  'Parse Research': { main: [[M('Merge Buyers', 0)]] },
  'Merge Buyers': { main: [[M('Join Buyers & Build RAG')]] },
  'Join Buyers & Build RAG': { main: [[M('Has requirements?')]] },
  'Has requirements?': { main: [[M('Call RAG')], [M('Merge RAG', 1)]] },
  'Call RAG': { main: [[M('Merge RAG', 0)]] },
  'Merge RAG': { main: [[M('Join RAG')]] },
  'Join RAG': { main: [[M('Select Market Studies')]] },
  'Select Market Studies': { main: [[M('Study market?')]] },
  'Study market?': { main: [[M('Competitor & Budget Agent')], [M('Merge Market', 1)]] },
  'Competitor & Budget Agent': { main: [[M('Parse Market')]] },
  'Parse Market': { main: [[M('Merge Market', 0)]] },
  'Merge Market': { main: [[M('Rank & Export')]] },
  'Rank & Export': { main: [[M('Build Proposal Input'), M('Run Summary'), M('Save to Google Sheet')]] },
  'Build Proposal Input': { main: [[M('Adapt for Studio')]] },
  'Adapt for Studio': { main: [[M('Send to Proposal Service')]] },
  'Send to Proposal Service': { main: [[M('Start Deck?')]] },
  'Start Deck?': { main: [[M('Start Deck')], []] },
  'Run Summary': { main: [[M('Send Run Alert (optional)')]] },
  ...Object.fromEntries(['wikidata_lookup', 'registry_search', 'boamp_history', 'decp_awards', 'web_search', 'web_scrape'].map(t => [t, { ai_tool: [[M('Buyer Research Agent', 0, 'ai_tool')]] }])),
  ...Object.fromEntries(['similar_awards', 'buyer_awards'].map(t => [t, { ai_tool: [[M('Competitor & Budget Agent', 0, 'ai_tool')]] }])),
  ...Object.fromEntries(['Ollama', 'Gemini', 'Groq', 'OpenAI', 'Anthropic'].map((m, i) => [`Model - ${m}`, { ai_languageModel: [[M('LLM Model Selector', i, 'ai_languageModel')]] }])),
  'LLM Model Selector': { ai_languageModel: [['Tender Scout Agent', 'LLM - Extract', 'LLM - Analyze Tender', 'Buyer Research Agent', 'Competitor & Budget Agent'].map(n => M(n, 0, 'ai_languageModel'))] },
};

// ---------- RFP - Research Tools (sub-workflow used by the agent's 6 tool nodes) ----------
const route = (key, value) => ({ conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
  conditions: [{ id: uuid('route:' + key), leftValue: '={{ $json.tool }}', rightValue: value, operator: { type: 'string', operation: 'equals' } }], combinator: 'and' }, renameOutput: true, outputKey: key });
const toolsNodes = [
  node('Tool Input', 'n8n-nodes-base.executeWorkflowTrigger', 1.1, [0, 300], { workflowInputs: { values: ['tool', 'firecrawl_base', 'q', 'buyer_name', 'siren', 'query', 'url', 'cpv', 'country'].map(name => ({ name })) } }),
  node('Route', 'n8n-nodes-base.switch', 3.2, [220, 300], { rules: { values: [route('search', 'web_search'), route('scrape', 'web_scrape')] }, options: { fallbackOutput: 'extra' } }),
  node('Firecrawl Search', 'n8n-nodes-base.httpRequest', 4.5, [460, 160], { method: 'POST', url: "={{ ($json.firecrawl_base || 'https://api.firecrawl.dev') + '/v1/search' }}", authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify({ query: $json.query, limit: 5 }) }}', options: { timeout: 45000 } }, { credentials: FIRECRAWL, onError: 'continueRegularOutput' }),
  node('Firecrawl Scrape', 'n8n-nodes-base.httpRequest', 4.5, [460, 320], { method: 'POST', url: "={{ ($json.firecrawl_base || 'https://api.firecrawl.dev') + '/v2/scrape' }}", authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendBody: true, specifyBody: 'json', jsonBody: "={{ JSON.stringify({ url: $json.url, formats: ['markdown'], onlyMainContent: true, timeout: 30000 }) }}", options: { timeout: 45000 } }, { credentials: FIRECRAWL, onError: 'continueRegularOutput' }),
  node('Compact Web', 'n8n-nodes-base.code', 2, [700, 240], { jsCode: code('tools/compact_web.js') }),
  node('Public APIs', 'n8n-nodes-base.code', 2, [460, 500], { jsCode: code('tools/public_apis.js') }),
];
const toolsConnections = {
  'Tool Input': { main: [[M('Route')]] },
  Route: { main: [[M('Firecrawl Search')], [M('Firecrawl Scrape')], [M('Public APIs')]] },
  'Firecrawl Search': { main: [[M('Compact Web')]] },
  'Firecrawl Scrape': { main: [[M('Compact Web')]] },
};

// ---------- RFP - Scout Tools (sub-workflow of the Tender Scout Agent's open_page tool) ----------
const scoutNodes = [
  node('Tool Input', 'n8n-nodes-base.executeWorkflowTrigger', 1.1, [0, 300], { workflowInputs: { values: ['tool', 'firecrawl_base', 'url_sources', 'max_links', 'url'].map(name => ({ name })) } }),
  node('Resolve Source', 'n8n-nodes-base.code', 2, [220, 300], { jsCode: code('tools/scout_source.js') }),
  // a host of no configured source (a URL the model typed wrong) never reaches Firecrawl: no request, no credit, no rate budget.
  // false -> straight to Page Links, which answers "PAGE ERROR | url | refused, no page read ..." from Resolve Source's item
  node('Known source?', 'n8n-nodes-base.if', 2.2, [440, 300], { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [{ id: uuid('Known source?:c'), leftValue: '={{ !$json.refused }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} }),
  node('Firecrawl Scrape', 'n8n-nodes-base.httpRequest', 4.5, [660, 220], { method: 'POST', url: "={{ ($json.firecrawl_base || 'https://api.firecrawl.dev') + '/v2/scrape' }}", authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendBody: true, specifyBody: 'json', jsonBody: "={{ JSON.stringify({ url: $json.url, formats: ['markdown'], onlyMainContent: $json.only_main !== false, timeout: 45000 }) }}", options: { timeout: 60000 } },
    { credentials: FIRECRAWL, onError: 'continueRegularOutput' }),
  node('Page Links', 'n8n-nodes-base.code', 2, [880, 300], { jsCode: code('tools/scout_page.js') }),
];
const scoutConnections = { 'Tool Input': { main: [[M('Resolve Source')]] }, 'Resolve Source': { main: [[M('Known source?')]] },
  'Known source?': { main: [[M('Firecrawl Scrape')], [M('Page Links')]] }, 'Firecrawl Scrape': { main: [[M('Page Links')]] } };

// ---------- RFP - Refine Slide (Human-in-the-Loop AI refinement: a sales person prompt-edits one slide of a deck) ----------
// CSTAM interface -> this webhook -> the deck agents' regenerate webhook (the teammate's "RFP 60 Regenerate one slide", in
// the same n8n) with the instruction -> the studio's slide route (validates, lays out with the deck theme, saves). Contract
// in INTEGRATION.md. No authentication: the browser calls it without a key, so its n8n must only listen on 127.0.0.1
const REFINE_ID = 'RfpRefineSlide01';
// the teammate's credential for his regenerate webhook (Header Auth X-API-Key, the studio's REGENERATE_WEBHOOK_KEY)
const REGEN_KEY = { httpHeaderAuth: { id: 'rfpRegenWebhook1', name: 'RegenWebhook' } };
const fullResponse = timeout => ({ timeout, response: { response: { fullResponse: true, neverError: true } } });   // the Code node reads every status
const refineNodes = [
  sticky('Note - Refine', [-40, -200], 2460, 240, '## Refine one slide with an instruction (Human-in-the-Loop)\n**Refine request** = POST `/webhook/cstam/refine-slide` `{deckId, slideIndex, instruction}` from the CSTAM interface (close the deck editor first: it saves the whole deck every 10 s). **Regenerate with instruction** calls the deck agents\' regenerate webhook (the teammate\'s "RFP 60", credential RegenWebhook): the agent that owns the slide runs again with the instruction, code still checks the facts. **Save slide** writes the new slide through the studio\'s slide route (credential "Proposal Studio key"): validated and laid out with the deck\'s theme, like the editor\'s Regenerate. Answer: 200 `{status: "ok", slideIndex, title, warnings}` or `{status: "error", message}` (400 / 404 / 502 / 503 / 504).', 5),
  node('Refine request', 'n8n-nodes-base.webhook', 2, [0, 300], { httpMethod: 'POST', path: 'cstam/refine-slide', responseMode: 'responseNode',
    // the CSTAM interface (Vite dev server) calls it from the browser
    options: { allowedOrigins: 'http://localhost:5173,http://127.0.0.1:5173' } }, { webhookId: uuid('Refine request:webhook') }),
  codeNode('Check request', 'refine/check_request.js', [220, 300], { notes: 'deckId, slideIndex (1 or more: 0 is the title slide), instruction of 3 to 200 characters; else 400. REGENERATE_URL and STUDIO_URL at its top.' }),
  ifRun('Request OK?', [440, 300], '_ok'),
  // the agents answer within about 45 s (their budget), then keep the current slide with a warning
  node('Regenerate with instruction', 'n8n-nodes-base.httpRequest', 4.5, [660, 220], {
    method: 'POST', url: '={{ $json.regenerateUrl }}', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify({ deckId: $json.deckId, slideIndex: $json.slideIndex, instruction: $json.instruction }) }}',
    options: fullResponse(90000) },
    { credentials: REGEN_KEY, onError: 'continueRegularOutput', notes: 'POST {deckId, slideIndex, instruction} to the deck agents\' regenerate webhook (RFP 60, credential RegenWebhook): one slide spec, or 400 / 404. Timeout 90 s, every HTTP status read by Check slide.' }),
  codeNode('Check slide', 'refine/check_slide.js', [880, 220], { notes: 'Only a NEW slide goes on: the current slide kept by the agents (too slow, invalid) or a slide of placeholders (LLM down) is never saved.' }),
  ifRun('Slide OK?', [1100, 220], '_ok'),
  node('Save slide', 'n8n-nodes-base.httpRequest', 4.5, [1320, 140], {
    method: 'POST', url: '={{ $json.saveUrl }}', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.spec) }}', options: fullResponse(30000) },
    { credentials: STUDIO_KEY, onError: 'continueRegularOutput', notes: 'POST the slide spec to the studio\'s /api/decks/<deckId>/slides/<slideIndex> (credential "Proposal Studio key"): validated, laid out with the deck\'s theme and saved, like the editor\'s Regenerate.' }),
  codeNode('Answer', 'refine/answer.js', [1540, 140]),
  ifRun('Prices on slide?', [1760, 140], '_prices'),
  codeNode('Reset price approval', 'refine/reset_approval.js', [1980, 60], { notes: 'Like the editor after its own Regenerate: a refined slide with prices needs a new approval before export.' }),
  node('Respond', 'n8n-nodes-base.respondToWebhook', 1.1, [2200, 300], { respondWith: 'json', responseBody: '={{ JSON.stringify($json.body) }}',
    options: { responseCode: '={{ $json.statusCode }}' } }),
];
const refineConnections = {
  'Refine request': { main: [[M('Check request')]] },
  'Check request': { main: [[M('Request OK?')]] },
  'Request OK?': { main: [[M('Regenerate with instruction')], [M('Respond')]] },
  'Regenerate with instruction': { main: [[M('Check slide')]] },
  'Check slide': { main: [[M('Slide OK?')]] },
  'Slide OK?': { main: [[M('Save slide')], [M('Respond')]] },
  'Save slide': { main: [[M('Answer')]] },
  Answer: { main: [[M('Prices on slide?')]] },
  'Prices on slide?': { main: [[M('Reset price approval')], [M('Respond')]] },
  'Reset price approval': { main: [[M('Respond')]] },
};

// ---------- write ----------
const wf = (name, nodes, connections) => ({ name, nodes, connections, pinData: {}, settings: { executionOrder: 'v1' } });
fs.mkdirSync(DIST, { recursive: true });
const outputs = { 'RFP - Main.json': wf('RFP - Main', mainNodes, mainConnections), 'RFP - Research Tools.json': wf('RFP - Research Tools', toolsNodes, toolsConnections),
  'RFP - Scout Tools.json': wf('RFP - Scout Tools', scoutNodes, scoutConnections),
  // a fixed id and inactive, like the deck agents' workflows: import, then publish it (it has a webhook)
  'RFP - Refine Slide.json': { id: REFINE_ID, ...wf('RFP - Refine Slide', refineNodes, refineConnections), active: false } };
for (const [file, w] of Object.entries(outputs)) {
  const names = new Set(w.nodes.map(n => n.name));
  for (const [from, c] of Object.entries(w.connections)) {
    if (!names.has(from)) throw new Error(`${file}: connection from unknown node ${from}`);
    for (const outs of Object.values(c)) for (const list of outs) for (const l of list) if (!names.has(l.node)) throw new Error(`${file}: connection to unknown node ${l.node}`);
  }
  fs.writeFileSync(path.join(DIST, file), JSON.stringify(w, null, 2));
  console.log(`${file}: ${w.nodes.filter(n => !n.type.endsWith('stickyNote')).length} nodes`);
}
