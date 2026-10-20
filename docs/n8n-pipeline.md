# n8n pipeline

Our n8n part of OliveSoft RFP Intelligence (folder `n8n/`). `build.js` generates 4 workflows in `dist/`:

| workflow | what it is |
|---|---|
| `RFP - Main` (62 nodes) | the whole pipeline on one canvas: sources (BOAMP / TED APIs, portals through the Tender Scout Agent), cleaning, analysis LLM and its code checks, buyer research, RAG, market study, ranking, export, proposal input, hand-off to the proposal studio |
| `RFP - Scout Tools` (id `kJh2xit7vcFVsP7i`) | the `open_page` tool of the **Tender Scout Agent** |
| `RFP - Research Tools` (id `QHV4m1jKm8fKBXNA`) | the tools of the **Buyer Research Agent** and of the **Competitor & Budget Agent** |
| `RFP - Refine Slide` (id `RfpRefineSlide01`) | **Human-in-the-Loop refinement**: the web app sends one slide and an instruction, the deck agents rewrite it, the studio saves it (webhook `cstam/refine-slide`) |

Also in `n8n/`: `src/` (Code nodes), `test/`, `demo/` (synthetic tenders), `examples/` (a commented proposal input),
`init/` (the container's import / publish script), `llm.json` (the LLM provider table) and the `Dockerfile`.
Contracts with the other parts: [integration-and-api.md](integration-and-api.md); every node and the data flow:
[architecture.md](architecture.md); the edge-case suite: [edge-cases.md](edge-cases.md).

## What the workflow does

```
API lane   API1 Build Requests → API Fetch → API2 Map Records                                  (no LLM, no Firecrawl)
URL lane   URL1 Scout Tasks → Tender Scout Agent (tool open_page) → Firecrawl Pace → URL3 Links to URLs
           → Firecrawl Detail → URL4 Build Extract Prompt → LLM Extract → URL5 Verify Extraction
                    ↓ both lanes + a run marker
Merge Sources → Clean & Dedupe → Build Analysis Prompt → Kept? → LLM Analyze Tender → Merge → Verify Analysis
→ Select Buyers → Research? → Buyer Research Agent (6 tools) → Parse Research → Merge → Join Buyers & Build RAG
→ Has requirements? → Call RAG (team service) → Merge → Join RAG
→ Select Market Studies → Study market? → Competitor & Budget Agent (2 tools) → Parse Market → Merge Market
→ Rank & Export → Build Proposal Input → Adapt for Studio → Send to Proposal Service (team studio) → Start Deck? → Start Deck
               → Save to Google Sheet (optional), then Run Summary (→ email, optional)
```

Your part is the workflow: it finds the tenders, prepares every input and calls the team's services. The RAG and the
proposal / deck generator are services (HTTP): their exact contracts are in [integration-and-api.md](integration-and-api.md). The diagrams and the
node-by-node reference are in [architecture.md](architecture.md).

## The answer to "API or agent?"

Both, as two **entry lanes** that produce the **same tender object**. After `Merge Sources`, every tender goes through the
exact same nodes whatever its origin.

- **A free API (BOAMP, TED, any JSON API)** gives exact dates, ids and the full notice. It is read by **config only**:
  `request` (how to call it), `records` (where the list is), `fields` (which field is the title, the buyer, the deadline...),
  `noticeTypes` (how to spot awards and cancellations). TED was added with config only (it is in `00 - Config`, disabled).
- **Any website** goes through the URL lane and its agent (below). Nothing in it knows a website.

New website = one line in `sources` (its home page is enough). New API = one block in `sources`. New company = edit
`company`. No code change.

## Three agents; code checks what they say

Each agent decides **what to do** (which page, which tool, which contract is comparable). Code builds the facts from the
**tool results**, never from the agent's own words, and removes any sentence with a number that is not in the data.

**1. Tender Scout Agent (URL lane).** One run per URL source. Its tool `open_page` (Scout Tools sub-workflow: Firecrawl +
code) returns the page text and its same-site links, each with a short id: `[1qvfhuy] Appel d'offres N°20/2026 | https://...`.
From a home page it opens the link that leads to the tenders ("Appels d'offres", "Marchés publics", "طلبات العروض"...),
follows "next page" when allowed, and answers with the **ids** of the tender links. `URL3` maps the ids back to the URLs the
tool really returned: an unknown id is dropped, the agent never writes a tender URL, and a page it navigated from (home,
menu, list page 1), a list page, another page or sort order of the list and its NEXT PAGE link are never taken as a tender
(a notice opened to check it stays one). Pages it may open = `maxPages` + `limits.maxListHops` (1 Firecrawl credit each);
`open_page` refuses, without a scrape, a host that belongs to no URL source of Config (`url` + `allowedHosts`), e.g. a URL
the model typed wrong, and names the URL to open instead when it can tell which (the asked path is a source's START URL or
list page, or there is one source). The scout's scrapes and the detail scrapes share Firecrawl's per-minute budget
(`firecrawl.intervalMs` sets the pace): Firecrawl Detail keeps room for the scout's scrapes in its first minute, and
`Firecrawl Pace` waits 61 s when the scout used the whole minute (one wait of up to about a minute per run). Run Summary says where the list was found ("use it as the source
url to save N credits per run"), and which list page was never read and why ("the scout asked franc-than.com instead of
francemarches.com"); a refused host alone is no failed call.

**2. Buyer Research Agent.** For the buyers of fit tenders: registry (France), BOAMP history, DECP awards, Wikidata, web
search, the buyer's own site. When the notice gives the buyer's SIREN (its SIRET), the agent searches the registry by it
first, and that row is the buyer whatever its name; a row or Wikidata entity with another SIREN is refused. `Parse
Research` keeps a fact only behind a gate: registry match by name similarity (under the notice name **or the official name
Wikidata gives**, e.g. "EPA-SHOM" → "Service hydrographique et océanographique de la Marine"; a match on an acronym alone
must be confirmed by the notice's SIREN, department, town or own website / e-mail domain: "ATIH." is no longer the
translation firm "... (ATIH)" but the Agence technique de l'information sur l'hospitalisation; with nothing to check, only
a public body no other one shares the acronym with is kept, with a check; a refused identity leaves the profile empty),
history rows of this exact buyer, official site from the notice / Wikidata / a search result whose title matches
/ the notice e-mail's domain when it spells the buyer's name (never a tender portal, nor a site under another country's
domain), contacts only from that site. A Wikidata entity of another country or with another SIREN than the registry's is
never used (the Czech interior ministry for the French one), nor one nothing tells apart from a namesake. A public
legal form in the registry (SEM, EPIC, 7xxx) replaces an agent's "private company" / "other" / "unknown" buyer type. The
fictional buyers of the demo source are never researched (`skipped_demo`).

**3. Competitor & Budget Agent (bonus).** For the best fit tenders still open (`limits.maxMarketStudies`). Tools:
`similar_awards` (awarded contracts of ANY buyer by CPV + title keywords: TED for the EU, the consolidated DECP for France,
TUNEPS for Tunisia, with amounts, winners, bids; every keyword is searched) and `buyer_awards` (this buyer's past contracts;
in France by the SIREN the research or the notice gives, else by name). The agent **chooses the comparable contracts
by id** and writes a short positioning; `Parse Market` computes from those rows the budget range (25th / 50th / 75th
percentile, framework ceilings left out, in the currency most comparables use: EUR, or TND for Tunisia), the competitors
(who won them, how often, last win; for Tunisia also who bid and lost; one award republished under several ids counts
once) and the usual number of bids.
Tunisia: TUNEPS (tuneps.tn) has no official open-data API; the tools read the JSON backend of its public site (no key,
undocumented, so it may change). Its server sends an incomplete certificate chain, so TUNEPS calls skip the certificate
check (public read-only data, nothing sent; a fix on their side would remove this). Final amounts typed in millimes are
corrected from the offer.

## Hand-off to the team's services

- **RAG** (`Call RAG`): one request per fit tender with verified requirements. Requirements are now **short single
  statements in English** (Config `rag.language`, the language of the RAG documents) and the analysis also asks for **team**
  and **experience** requirements; the French quote stays on our side as proof. `Join RAG` reads the matrix and the scores,
  keeps every proof document and tells a real proof (CV, company record) from a fictional demo record or a weak neighbour.
- **Proposal / deck** (`Build Proposal Input` → `Send to Proposal Service`): one JSON per fit tender (tender, verified
  requirements + RAG status + proof documents, matched CVs / projects / tech stack, buyer profile, market study, company
  profile), contract `olivesoft.proposal-input.v2`: the structure the deck service asked for (tender / analysis /
  buyer_profile / rag / matrix / competition / options) plus quotes, mandatory flags, award criteria, contacts and comparables;
  relevance score, recommendation (bid / bid_with_partner / no_bid / review) and risks come from rules in code (`bid` only
  when every requirement is covered and no obligation sentence of the notice is left out of the matrix). The first item also carries all of them as `proposal_inputs_<date>.json`,
  the full v2.
- **Proposal studio** (`Adapt for Studio` → `Send to Proposal Service` → `Start Deck`): the team's studio (rfp-studio,
  port 8091) stores every proposal input in its tender inbox (`proposal.url`, header `X-API-Key` from the n8n credential
  **Proposal Studio key**) and makes the decks with its agents, which run in this n8n as the teammate's 9 workflows
  (`GENERATE_MODE=webhook`; `RFP - Refine Slide` then lets a sales person rewrite one slide with an instruction). The
  studio does not read our honesty flags, so `Adapt for Studio` sends
  it a copy without what a deck would show as proof without being one: fictional demo records, weak neighbours, header
  and CV skills lines as "why us", CVs outside the proposed team (whose certifications it adds), a budget the market
  study does not support, an unknown template id (OliveSoft's own declarations stay). `Start Deck` then starts the deck
  of the rank-1 tender (`proposal.autoDeck: 'top1'`; `'none'` = every deck from the interface): the studio makes one deck
  at a time (about 2-3 min with Groq in the runs of 2026-10-20). Run Summary says "Proposal inputs: N sent to the studio |
  deck started for …" or why not. Rules: [Proposal input and the studio copy](#proposal-input-and-the-studio-copy) below;
  routes, answers and errors: [integration-and-api.md](integration-and-api.md) sections 4 and 5.

## Proposal input and the studio copy

Moved here from the integration document (which keeps the field summary). Code: `src/main/PR1_build_proposal_input.js`
(the proposal input) and `src/main/PR2_adapt_for_studio.js` (the studio's copy).

**RAG request lines.** `requirements.*` sent to the RAG are short English skill lines (2 to 8 words, like a CV line). A
line is kept only when the tender's own quote states it: its numbers, every technology / role / certification it names,
a kind of system or a sector only when the quote or the title names it, at least half of its words. Filler words next to
a technology are dropped ("Angular interface" becomes "Angular", never "SQL Server"). A line listing several skills
becomes one requirement each. `sector` is one of the RAG's words (public sector, health, education, telecom, finance,
retail, tourism) and must be written in the tender, else `public sector`. A tender with no verified requirement is not
sent (`rag.status = skipped_no_requirements`). Rows are matched back to our requirements by text, then by order; a row the
RAG does not return counts as missing.

**Rules in the proposal input.**
- `relevance_score` = 70 for fit high (50 for medium) + 30 x RAG coverage; `relevance_basis` writes the calculation.
- `matrix.rows[].coverage`: covered / partial / gap (the RAG's `missing`) / unknown (RAG not called or failed);
  `coverage_score` 100 / 50 / 0. `mandatory` is true only when the tender's own words require it.
- `matrix.summary.recommendation`: `review` without a matrix; `bid` when every requirement is covered and no obligation
  sentence of the notice is left out of the matrix; `no_bid` when a mandatory technical requirement is a gap and technical
  coverage is under 50 %; `bid_with_partner` when every gap is a team / experience requirement; otherwise `review`.
  `recommendation_reason` names the rule.
- `competition.budget_estimate`: quartiles of the comparables' real prices (framework ceilings and outliers beyond 10x
  the median left out, from 3 priced contracts); `confidence` medium with 5+ comparables, low with 2-4, very low with 1,
  one level lower for a wide spread.
- `analysis.risks` are facts only: short deadline, mandatory gaps, obligations not in the matrix, proof from demo records,
  certification asked but not named in the proof, team places that cannot be staffed, framework agreement, strong
  competition, declared value far from comparable contracts.

**What `Adapt for Studio` changes in the studio's copy** (the studio reads every asset as a reference and every
justification as a "why us" bullet, so the copy leaves out what is not proof):

| Rule | Fields |
|---|---|
| demo and non-proving evidence left out | `matrix.rows[].evidence[]` with `origin: "demo"` or `proves: false` |
| demo and weak-only assets left out | `rag.assets[]` that are demo or only `weak_for` |
| justifications that are no argument cleared | rows resting on a demo record, a weak proof or a header / skills line |
| OliveSoft's declarations kept | `justification_kind: "declaration"` |
| the proposed team only | CVs of `rag.team_proposal.members[]`, with their roles and certifications as assets |
| unknown coverage | `coverage_score: 0` when `coverage` is `unknown` |
| default template | `options.template_id: null` |
| budget only when the study supports it | `budget_estimate: null` unless status OK, confidence above very low and 3+ comparables |
| language | not `fr` / `en` becomes `en` (original kept in `language_original`) |

The copy carries a `studio_adapter` block listing what was dropped or added, `auto_deck` (rank 1) and `deck_params`
(`language`, `project_type`: `software_build` and `ai_data` give `software`, `integration_saas` gives `saas`, anything
else `other`). `node test/studio_adapter.test.js` runs the copy through the studio's own normaliser on the recorded
inputs.

## What was removed from the hybrid, and why

| removed | why |
|---|---|
| Scout tools `inspect_page` + `list_tenders` (2 scrapes of the same page) | one tool `open_page` (1 scrape) returns the text and the numbered links; the agent picks by id |
| Separate `Keyword Pre-filter` node | one rule inside `Clean & Dedupe` (API records only: an exclusion word and no company keyword) |
| Separate triage and requirements LLM steps (2 calls per tender, 10 nodes) | one analysis call: type + fit + quote, requirements only when fit is high/medium |
| `aiMaxTenders` cap | every kept tender is analysed (limit at the source with `maxRecordsPerApi` for tests) |
| `LLM - Buyer Profile` step | the agent's final answer is the short profile; code verifies it |
| Proposal / deck renderer nodes inside the workflow | the deck is the team's service: the workflow prepares its input and calls it |
| `retryOnFail` on LLM, Firecrawl and API nodes | with "On Error: continue", n8n only retries when the FIRST item fails, and then re-runs every item; failures are counted in Run Summary instead |
| Hardcoded portal list (`PORTAL_RE`), `{FR:'France', TN:'Tunisia'}` maps, "OliveSoft" in prompts | portals = hosts of your own sources; country names from the ISO code; company name from Config |
| Heuristic `priority_score` / `heuristic_score` | ranking = fit level, then RAG coverage, then deadline |

## Bugs fixed on the way

- **DECP awards always empty** (your tools sub-workflow): `acheteur_id like "<siren>%"` returns 0; `startswith(acheteur_id, "<siren>")` works (checked live).
- **BOAMP history** (your tools sub-workflow): `nomacheteur = "Région Hauts-de-France"` returns 0 (checked live); now phrase search + exact name match in code.
- **POST APIs such as TED**: "Send Body" written as an expression makes n8n drop the JSON body settings (HTTP 415). Now literal.
- **Rectified BOAMP notices**: the newest version lists the old ones in `annonce_lie`; old versions are dropped as superseded.
- **Invisible characters in regexes**: written as `\u` escapes, so copy-paste cannot turn `[​-‏]` into "remove every hyphen".
- **`enriched` with no evidence**: `enrichment_status` counts facts (registry, history, awards, official site, Wikidata);
  `facts.awards` is `null` (unknown) when DECP was not searched with the matched SIREN.
- From the real pages: quotes on sites that glue words ("IntelligenceArtificielle") verify; "Lire la suite" no longer glued
  to link texts; a notice reached twice (category page + its own page, same "N° 28/2026") is one tender; a category tag
  repeated on every card ("Appel d'offre" → the tender list) keeps its text for the scout.
- From a full run in n8n (every node's output read from 4 angles, 45 confirmed findings, fixed): the scout tool now shows
  the list's NEXT PAGE itself and the agent has one page budget (a small model stopped before page 2); a date must have
  its month in the page and a cut date ("November 9,", "٢٦ أكتوبر ٢") is completed from the page or from the listing card
  (the best AI tender had lost its deadline and its proposal slot); "AVIS RECTIFICATIF" leaves the title; the quote check
  refuses a quote that skips a negation or changes a number in words; `mandatory` comes from the tender's own words, not
  from a template anchor; the analysis prompt has no example values to copy and shows what each CPV code means; numbers
  in requirements are digits; the registry gate ignores legal forms ("EPA-SHOM"), BOAMP history matches "GIP RESAH" to
  "RESAH" and keeps the award of a same-titled contract (the incumbent), past winners count once per notice, staff bands
  are decoded ("22" = 100-199 employees), a summary sentence naming a place the evidence does not have is removed; DECP
  frameworks are read from `techniques`, outliers and wide ranges lower the budget confidence, amounts written with
  "M" / "million" and names (Roche, Siemens...) in the agent's text are checked against the chosen contracts; the Tunisian
  study searches TUNEPS' Arabic titles for Arabic keywords; `coverage_score` follows coverage, partial evidence gives
  `review` (not `bid`), `fit_score` leaves out the RAG's domain fit, Run Summary says why analysis calls failed and how
  many fit tenders the proposal cap left out.
- Two review rounds after the RAG v2 integration (2026-10-20; checked by the edge-case suite and replays of the recorded
  runs): a skill line can no longer add a kind of system, a sector or a company service its quote does not state (a kind
  the tender's title names counts), and a "translation" that copies the French quote is never sent; obligation sentences
  no requirement quotes are listed (`requirements_uncovered`) and turn `bid` into `review`; the sector must be written in
  the tender; `Join RAG` keeps every proof document, tells real proof from demo records and weak neighbours, and warns when
  the certification asked (PSM) is proved by another (CSM); BOAMP's legacy notices now give CPV, value (ranges too),
  duration, contacts, the buyer's SIRET and their selection text, and a rectification's new deadline is never the old date;
  "today" is the workflow's local date; an award notice on a URL page is read as an award; a raw line break inside an
  LLM's JSON string is repaired; `open_page` refuses hosts of no source and its errors show Firecrawl's HTTP status; a new
  search query no longer gives francemarches notices new ids; demo buyers are not researched; no "https://undefined"
  website; one award republished under several ids counts once; URL notices found expired / awarded are remembered so they
  are not scraped again; Run Summary names each source's first error, the pages the scout never opened, a failed sheet
  read and the fit tenders whose requirements were all dropped or left out (no longer counted as notices without
  requirements), and its `WARNINGS` ignore rejects that come back on every run.
- Third review round (2026-10-20, same checks): the analysis prompt rates IT operations, IT equipment maintenance,
  helpdesk and audits low, asks only for the service lines the text asks for, wants technologies by their name only and
  gives placeholder timelines; service lines found only in the reason, or a list of every service, are kept only when the
  tender states them (flags `services_from_reason`, `services_all_listed`, `reason_was_service_list`); a company service
  phrase must stand as a phrase in the quote; filler words around a technology are trimmed ("Angular interface" →
  "Angular", never "SQL Server"); the timeline must be stated by the text (`timeline_not_in_text`); eForms form fields are
  no obligations. Join RAG trims mid-sentence chunks from the proof, flags weak or header-only proofs and gives the proof
  document's own score; a declared value range gives its high bound; `past_digital_projects` holds only digital projects;
  an empty reason falls back to the verified quote; unclear service lines are a risk. The eForms buyer's SIRET is read;
  lot texts appear once. The `open_page` refusal names the URL to open; every award notice loses its date; refused calls
  do not slow Firecrawl. A foreign Wikidata namesake is never used; staff bands are read as bands; a cut-short market
  answer keeps its ids; goods contracts and repeated DECP rows no longer weigh in the budget; similar_awards searches the
  acronym ("agents LLM" → LLM) and the market agent makes at most 3 calls. Run Summary puts what is missing first, names
  failed market studies and pages read twice.
- Review of this update (4 reviewers; findings checked by hand and fixed): requirements split from one sentence were
  dropped as duplicates; numbers written in words ("dix-huit mois", "Three references") are now checked on both sides;
  framework agreements (TED `framework-agreement-lot`, DECP `nature`) no longer put their ceiling in the budget; the same
  contract from TED and DECP counts once; CPV "30" no longer becomes "3" (divisions 30-39); DECP keywords survive
  apostrophes / accents; an API outage is `tools_failed`, not "no data"; the scout keeps a tender page that links back to
  the list, never takes a list page for a tender, keeps a START notice, and maps URLs with spaces; `open_page` takes each
  source's settings from Config by host (Resolve Source), not from the agent's item; optional tool inputs have defaults;
  a generic Wikidata class ("centre communal d'action sociale") can no longer match another town's body in the registry;
  the proposal input falls back to the notice's own contacts.
- Found by the study of the proposal studio (2026-10-20): with exactly 2 priced comparables, `Parse Market` took their
  midpoint for the median and left the smaller one out as an outlier (Tdoatt8 kept 2.8 bn EUR and dropped 206 619): the
  10x outlier rule now needs 3 priced contracts; 2 far apart are both kept and their spread makes the confidence very low.
- Earlier adversarial review (5 reviewers + skeptics): an invalid requirement no longer empties the list; a quote with a
  changed number fails; dates must appear with their digits together; quotes are checked against the page text only; a
  failed LLM call gives fit `unknown` (retried next run), not a fake "low"; the research budget skips too-late tenders and
  unnamed buyers; "Retry on fail" removed; the LLM pause really applies; RAG coverage counts unreturned requirements as
  missing; rectification order; `company.tenderTypes` with `bid: true/false` so a non-IT company can use the pipeline.

## Install and run

`docker compose up -d` does the whole installation (see the [README](../README.md)): the n8n image runs
`node build.js`, and at start `n8n/init/init.js` imports the 4 workflows of `n8n/dist/` and the deck agents' 9 with
their credentials (Firecrawl, Ollama, Gemini, Groq, OpenAI, Anthropic, Proposal Studio key, MainWebhook, RegenWebhook:
fixed ids, values from `.env`), points Config at the compose services, sets `LLM_PROVIDER`, and publishes Scout Tools,
Research Tools, the agents' 9 and Refine Slide. RFP - Main stays unpublished.

1. Open n8n (http://localhost:5679), create the owner account (local), open **RFP - Main**.
2. **Execute workflow** (a manual run = the "test" preset: 5 tenders per URL source, 3 buyers, 3 market studies).
3. Results: `Rank & Export` (one row of 76 columns per kept tender, with the requirements, RAG and market columns, e.g.
   `requirements_uncovered` = the notice's obligation sentences that no requirement quotes, joined with " | "; the first
   row carries the CSV and JSON files), `Build Proposal Input` (one JSON per fit tender + `proposal_inputs_<date>.json`),
   `Adapt for Studio` (the studio's copies, `studio_adapter` says what each left out), `Run Summary` (its line "Proposal
   inputs: N sent to the studio | deck started for …"); in the web app (http://localhost:5173) the tenders and their
   analysis, in the studio (http://localhost:8091) the proposal inputs and the deck.

Change the pipeline: edit `n8n/src/` (Code nodes) or `n8n/build.js` (nodes, wiring), run `node build.js` in `n8n/`
(updates `dist/`, checked by the tests), then `docker compose up -d --build n8n`: the workflows changed, so they are
imported and published again (this replaces edits made in the n8n editor). Company profile, sources and limits are in
`n8n/src/main/00_config.js`; the LLM is chosen in `.env` (`LLM_PROVIDER`, README "Change the LLM").

Optional: enable `01 - Load Known IDs` and `Save to Google Sheet` together for incremental runs. With `skipKnown`
(production preset) the next runs skip the tenders already exported, and the URL notices a run found expired (deadline
passed), awarded, cancelled or superseded: those are written to the sheet as `status = dropped` rows (columns `status`
and `drop_reason`; filter on `status = kept` to list the exported tenders). One-time effect of this update: francemarches
notices get a new `canonical_id` / `tender_id` (the searched words are no longer part of it); a notice exported before is
recognised by title, buyer and deadline and dropped as already exported.

## Demo mode (synthetic tenders, everything else real)

Real portals rarely have, on the day of a demo, a tender that fits OliveSoft's documents. Demo mode feeds the workflow
6 **synthetic** tenders written for the demo (fictional buyers marked "démo"; `demo/demo_tenders.json`, edit freely):
a tourism licensing platform, a RAG chatbot, a health Power BI dashboard (should match), a Flutter + Salesforce +
Kubernetes app (shows real gaps), an Arabic e-services portal (multilingual), office furniture (rejected as not IT).
Everything after the source is **real**: the analysis LLM and its checks, your RAG service, the market study on public
award data, the proposal input. Say it is demo data when you present it.

1. The `demo-tenders` container serves them (`n8n/demo/server.js`, port 8004; dates are computed from today, so the demo
   never goes stale).
2. Set `PIPELINE_DEMO_MODE=true` in `.env`, then `docker compose up -d --force-recreate n8n` (Config gets
   `DEMO_MODE = true`: only the `demo` source runs; set it back to `false` after).
3. Run RFP - Main. The buyers are fictional: they are skipped automatically (`research_status: skipped_demo`, no research
   slot used).

**Demo tenders WITH the real sources** (BOAMP + the URL agent on your portals + demo, all ranked together): leave
`DEMO_MODE = false` and set `enabled: true` on the `demo` source (`n8n/src/main/00_config.js`, then rebuild n8n). Every enabled source runs, API and URL alike; demo
tenders get a market-study slot only after the real fit tenders, and their buyers are not researched. Test run:
`DEMO_ADD=1 KEEP_SOURCES=boamp,demo,francemarches,domainetat-tn RAG_URL=... node test/e2e.js` (real Firecrawl, ~10 min).
A commented proposal input of one demo tender, field by field: [n8n/examples/proposal_input_example.jsonc](../n8n/examples/proposal_input_example.jsonc).

## Tests

How to run every suite: [tests/README.md](../tests/README.md). In short:

- **Edge cases** (incomplete tender specifications, noisy web research, missing internal references, LLM failures,
  market edge cases, run report and incremental runs, the hand-off to the proposal studio): `node test/edge_cases.js`
  runs 223 cases on the built Code nodes (and the wiring) of `dist/` in under a second. Results, the known gaps (with
  their code location) and the case table: [edge-cases.md](edge-cases.md).
- **What the proposal studio makes of our inputs**: `node test/studio_adapter.test.js` runs `Adapt for Studio` and then
  the studio's own normaliser (`services/proposal-studio/agents/lib/input.js`, read-only, `STUDIO_DIR`) on the 10 real
  proposal inputs of run 3 (`test/out/execution_ragv2_run3_nodes/Build_Proposal_Input.json`, shipped as a fixture) and
  the example. No server, no network.
- **Replay** (`node test/replay.js <execution.json>`): runs the current code of every Code node on the HTTP / LLM / agent
  answers recorded in a real run. The recordings (`test/out/execution_*.json`, several MB each) are not shipped: export
  an execution from n8n to replay it.
- **End to end in a throwaway n8n** (`test/e2e.js`, with `test/mock_server.js` for Firecrawl and the RAG): a development
  harness that starts its own container next to services running on the host; see the header of `test/e2e.js`. The
  packaged system is tested by `docker compose up` itself (the init's checks, the health checks).


## Verified vs not verified (2026-10-20)

Verified in a real n8n 2.41.3 with your local `qwen3:4b-instruct` (earlier runs): the whole pipeline end to end, joins
through IF / Merge / LLM / agent nodes, live BOAMP and TED, the research agent with the live registry / BOAMP / DECP /
Wikidata, CSV/JSON files, the failure paths. Real Firecrawl run on your 2 sites (0 failed calls). The numbered-links loop
that preceded the scout agent also ran in n8n (4 rounds: home → menu → list → page 2, everything after it once).

Verified outside n8n (this update):
- `open_page` code on the saved pages and on a page shaped like domainetat's home page; `URL3` mapping the ids back to
  the real tender URLs, dropping unknown ids and the pages the agent navigated from;
- `similar_awards` / `buyer_awards` called **live** (TED + DECP): e.g. "chatbot" in France → 11 comparable contracts with
  amounts and winners; `Parse Market` on that live data → budget 10 000 / 30 168 / 128 640 EUR, competitors CRAFTMAN DATA
  (2 wins), YELDA, ORANGE BUSINESS SERVICES..., median 2 bids; an invented number in the agent's text was removed;
- Tunisia, live on TUNEPS: "plateforme, logiciel" → budget 8 742 / 16 157 / 95 663 TND, competitors STE BRAIN
  INFORMATIQUE (3 won, 1 lost), NEXT STEP IT (2 / 2), ALLIANCE SOFTWARE (1 / 2), ADACTIM (0 / 3), median 3 bids;
- the whole chain with `test/replay.js` (real run): 3 market studies selected, 10 proposal inputs + the file, Run Summary.

Verified in a real n8n with this version (throwaway container, your real tool ids, your RAG, saved pages, 2026-10-19):
- with your local `qwen3:4b-instruct`: the whole workflow, **0 failed calls**: scout agent (3 sources, 7 tenders), buyer
  research agent (3 buyers), Competitor & Budget Agent (3 studies, its tools running through Research Tools: bioMérieux,
  Becton Dickinson, Abbott found as the lab-analyser market), RAG 15 calls, 10 v2 proposal inputs, Run Summary;
- with **Gemini 3.8 Flash** (until its 20 free calls ran out): the scout agent did exactly the right thing on its own
  (home → "Marchés publics" → list → page 2, the 4 real tenders and nothing else; the Arabic list; the single notice), and
  its analyses were right where the 4B model was wrong (market-data purchase = non_it, training = training);
- every node's output was then read from 4 angles; the confirmed findings are fixed (above) and checked by replaying that
  run (`node test/replay.js` on that recording, not shipped) and by unit cases.

Verified in a real n8n with the team RAG v2 (throwaway container, real Firecrawl on your 2 sites, BOAMP, the demo
tenders, local `qwen3:4b-instruct`, 2026-10-20), three full runs, each followed by a review of every node's output:
- run 1: 62 findings, 55 confirmed by independent skeptics; fixed in three rounds (each fix tested in its own copy of the
  project and re-checked by a skeptic before the merge);
- run 2 (fixes merged): 48 of the findings resolved on live data, the rest not exercised or fixed in round 3; its new
  findings fixed in round 3;
- run 3: no workflow error, 1 failed call (a Firecrawl page that timed out after 5 minutes), the real "agents LLM" tender
  ranked 1st with RAG coverage 1.0 and recommendation bid, `Firecrawl Pace` and the `Known source?` IF working (the
  scout's mistyped host refused without a credit). Its 3 answers without a proof quote and the ATIH buyer matched to a
  namesake were fixed after it and checked on its recorded data (all 22 answers valid; ATIH found by the notice's SIREN).

Verified in the packaged system (`docker compose`, 2026-10-20): two end-to-end runs on the demo tenders, from Main to
an exported deck, with the deck agents in n8n (webhook mode) and Refine Slide used from the web app. Results, tokens and
timings: [evaluation-report.md](evaluation-report.md).

Not verified yet:
- a run with a stronger model for Main on real sources: the 4B model is fine for wiring, weak as a judge (about 1
  doubtful fit in 8 in the real runs above);
- the real portals (URL sources) in the packaged system: they need a Firecrawl key, and the packaged runs used the demo
  feed;
- `Save to Google Sheet` (disabled in the tests) running before `Run Summary`.

The RAG side (team RAG v2, `rag:8001`): `Join RAG` reads its whole answer (matrix, every proof with its origin: CV quote,
company declaration or fictional demo record, `team_proposal`, `knowledge_gaps`). Open issues measured on real tender
wording (generic or French lines under-claimed, team-size lines, a demo record cited before a CV in one case) are in
[rag-benchmark.md](rag-benchmark.md) section 5.3.
