# Integration and API workflow

How the parts of OliveSoft RFP Intelligence call each other: every HTTP call, the data contract between the pipeline
and the proposal studio, the webhook contracts, errors, security and configuration. Paths were checked against the code
(`services/rag/rag/api.py`, `services/rag/rag/dashboard.py`, `services/proposal-studio/server.py`, `n8n/build.js`,
`apps/web/src/lib/*.ts`) on 2026-10-20.

Related: [README](../README.md) (architecture diagrams), [n8n-pipeline.md](n8n-pipeline.md) (what the pipeline does and
the rules behind the proposal input), [architecture.md](architecture.md) (node-by-node reference).

## 1. Who calls whom

| Caller | Callee | Why |
|---|---|---|
| Browser (web app, `http://localhost:5173`) | RAG through the web app's nginx (`/api`, `/retrieve`, `/health` are proxied to `rag:8001`) | dashboard, knowledge base, tender analyses, Quality page |
| Browser | Proposal studio `http://localhost:8091` | tender inbox, deck generation status, templates, the embedded deck editor |
| Browser | n8n `http://localhost:5679` | "Refine with AI" (webhook `cstam/refine-slide`) |
| n8n "RFP - Main" | public sources, Firecrawl, research APIs, the LLM | detection, analysis, buyer research, market study |
| n8n "RFP - Main" | RAG `http://rag:8001` | requirements matrix and fit score per tender |
| n8n "RFP - Main" | Studio `http://proposal-studio:8091` | store each proposal input, start the deck of the best tender |
| Studio | n8n `http://n8n:5678` | run the deck agents (generate) and rewrite one slide (regenerate) |
| n8n deck agents | Studio | progress, publish the finished deck |
| n8n "RFP - Refine Slide" | n8n (same container) and Studio | regenerate one slide with an instruction, then save it |

Inside the compose network the services use their names (`rag`, `proposal-studio`, `n8n`, `demo-tenders`). The
`host.docker.internal` defaults in `n8n/src/` are for a stand-alone n8n; `n8n/init/init.js` replaces them at import and
the image build fails if a replacement no longer applies.

## 2. Every HTTP call between services

Key columns: **studio key** = header `X-API-Key: <STUDIO_API_KEY>`; **webhook key** = header `X-API-Key: <AGENTS_WEBHOOK_KEY>`.

| From | Method and path | Auth | Body | Answer |
|---|---|---|---|---|
| web | `GET /health` (RAG) | none | - | `{status, version, model, reranker, index_ready}` |
| web | `GET /api/tenders`, `GET /api/tenders/{id}` (RAG) | none | - | stored tenders with their latest analysis |
| web | `DELETE /api/tenders`, `DELETE /api/tenders/{id}` (RAG) | none | - | `{deleted: count}` / `{deleted: id}`, 404 unknown |
| web | `POST /retrieve/tender` (RAG) | none | tender record (section 4.1) | analysis (section 4.1) |
| web | `GET /api/documents`, `GET/POST /api/records`, `PUT/DELETE /api/records/{id}` (RAG) | none | record form fields | records; 409 when other records link to it |
| web | `GET /api/benchmark` (RAG) | none | - | `results.json` of the benchmark + parsed `test_results.txt` |
| web | `GET /api/tenders`, `GET /api/tenders/<id>` (studio) | none | - | `{tenders, generationEnabled, llmModels}` / one proposal input |
| web | `POST /api/generations` (studio) | none | `{tenderId, templateId?, params?}` | `202 {status, runId}` |
| web | `GET /api/generations?tenderId=`, `GET /api/generations/<runId>` (studio) | none | - | runs: `status`, `steps`, `deckId`, `url`, `warnings`, `placeholders`, `usage`, `timings` |
| web | `GET/POST /api/templates`, `PUT /api/templates/default`, `DELETE /api/templates/<id>`, `POST /api/templates/rescan` (studio) | none | `.pptx` upload (multipart) / `{id}` | template library, default template |
| web | `GET /api/save/<deckId>` (studio) | none | - | the deck as last saved |
| web | `/editor.html?id=<deckId>` (studio, in an iframe) | none | - | the deck editor (edit, export PPTX / PDF) |
| web | `GET /healthz` (n8n, no-cors probe) | none | - | tells whether n8n answers |
| web | `POST /webhook/cstam/refine-slide` (n8n) | none, CORS origin check | `{deckId, slideIndex, instruction}` | section 4.4 |
| Main | `GET http://demo-tenders:8004/tenders` | none | - | `{synthetic, total, results[]}` (6 synthetic tenders) |
| Main | `POST http://rag:8001/retrieve/tender` | none | tender record | analysis; timeout 120 s, one call at a time, 1 s apart |
| Main | `POST http://proposal-studio:8091/api/tenders` | studio key | proposal input (studio copy) | `200 {status: "ok", id}`; timeout 15 s, 1 s apart |
| Main | `POST http://proposal-studio:8091/api/generations` | studio key (not required) | `{tenderId, params: {language, project_type}}` | `202 {status, runId}`; rank-1 tender only |
| studio | `POST http://n8n:5678/webhook/rfp/generate` | webhook key | stored proposal input + `{runId, template, params}` | accepted; the agents then work in the background (timeout of the call 10 s) |
| studio | `POST http://n8n:5678/webhook/rfp/regenerate` | webhook key | `{deckId, slideIndex}` | one slide spec (editor's own Regenerate button) |
| agents | `POST /api/generations/<runId>/progress` (studio) | studio key | `{steps, ...}` (step states, status) | `{status, runStatus}` |
| agents | `POST /api/decks`, `GET /api/decks/<id>` (studio) | studio key | deck spec (`services/proposal-studio/deck.schema.json`) | deck id, editor URL |
| Refine Slide | `POST http://127.0.0.1:5678/webhook/rfp/regenerate` | webhook key | `{deckId, slideIndex, instruction}` | one slide spec; timeout 90 s |
| Refine Slide | `POST /api/decks/<deckId>/slides/<slideIndex>` (studio) | studio key | slide spec | slide validated, laid out and saved; timeout 30 s |
| Refine Slide | `GET /api/save/<deckId>`, `POST /api/save` (studio) | none | the deck without `approvals.pricing` | only when the refined slide has prices |
| Main, agents | LLM provider (Groq, Gemini, OpenAI-compatible API, or Ollama) | provider key | chat completion | section 7 |

External APIs called by Main (no key unless noted): BOAMP open data, TED (configured, disabled by default), Firecrawl
(`FIRECRAWL_KEY`, portals and buyer web pages), the French company registry, DECP awards, Wikidata, TUNEPS (Tunisia).

Interactive references: http://localhost:8001/docs (RAG, FastAPI). The studio's own reference is
`services/proposal-studio/README.md`.

## 3. Data contract: `olivesoft.proposal-input.v2`

One JSON per fit tender still open for bidding, best rank first, at most 10 per run. Built by `Build Proposal Input`
(`n8n/src/main/PR1_build_proposal_input.js`). Full examples: [n8n/examples/proposal_input_example.json](../n8n/examples/proposal_input_example.json)
and the commented [proposal_input_example.jsonc](../n8n/examples/proposal_input_example.jsonc).

| Block | Main fields |
|---|---|
| top | `contract` (`olivesoft.proposal-input.v2`), `tender_id`, `language`, `rank`, `run_id`, `generated_on` |
| `tender` | `title`, `reference`, `issuer`, `country`, `publication_date`, `deadline`, `days_to_deadline`, `estimated_value`, `cpv[]`, `duration`, `source`, `source_url`, `documents_url`, `description`, `lots[]`, `award_criteria[]` |
| `analysis` | `relevance_score` + `relevance_basis`, `fit` (high / medium), `tender_type`, `matched_service_lines[]`, `reason`, `proof_quote` (verbatim, `quote_verified`), `sector`, `risks[]`, `requirements{technical[], team[], experience[], timeline}` |
| `buyer_profile` | `name`, `legal_name`, `sector`, `size`, `organization_description`, `staff`, `website`, `contacts`, `past_digital_projects[]`, `past_winners[]`, `key_partners[]`, `research_status` |
| `rag` | `status` (FULL / PARTIAL / NONE / SKIPPED / ERROR), `data_mode`, `assets[]`, `suggested_assets`, `team_proposal`, `knowledge_counts` |
| `matrix` | `status`, `rows[]{requirement_id, category, requirement, quote, mandatory, coverage, coverage_score, origin, justification, evidence[]}`, `summary{fit_score, covered, partial, gaps, blocking[], knowledge_gaps[], recommendation, recommendation_reason}` |
| `competition` | `status` (OK / NO_COMPARABLE / NO_DATA / FAILED / NOT_STUDIED), `declared_value`, `budget_estimate{low, mid, high, currency, confidence, comparables}`, `competitors[]`, `median_bids`, `positioning`, `comparables[]` |
| `options` | `template_id` (`null` = the studio's default template), `formats[]`, `sections[]`, `overrides` |
| `company` | `name`, `services[]`, `technologies[]` |

Rules: a field is `null` or empty when unknown (the deck must say "not known"); numbers and the recommendation
(`bid`, `bid_with_partner`, `no_bid`, `review`) come from rules in code, not from an LLM. The studio receives a copy made by
`Adapt for Studio` (`PR2_adapt_for_studio.js`) without what a deck would show as proof without being one (demo records,
weak evidence, CVs outside the proposed team, a budget the market study does not support). The rules are listed in
[n8n-pipeline.md](n8n-pipeline.md#proposal-input-and-the-studio-copy). A breaking change gets a new `contract` version;
adding a field does not.

## 4. Webhook and endpoint contracts

### 4.1 RAG `POST /retrieve/tender`

Request (from Main, and from the web app):

```json
{ "tender_id": "T1w50xyr", "title": "...", "client": "...", "sector": "health", "country": "France", "source": "demo",
  "source_url": "...", "published": "2026-10-20", "deadline": "2026-11-20", "language": "fr", "estimated_budget": "...",
  "data_mode": "company",
  "requirements": { "technical": ["Power BI", "Python pipelines"], "team": ["1 project manager"],
                    "experience": ["1 health sector project"], "timeline": "6 mois" } }
```

`requirements.*` are short English skill lines (2 to 8 words). `data_mode` is `company` (OliveSoft's real knowledge base)
or `demo` (adds the fictional demo records, labelled `origin: demo`). The metadata is stored for the web app's tender list
and does not change the matching. Answer: `requirements_matrix[]` (`requirement`, `category`, `mandatory`, `status`
covered / partial / missing, `best_doc`, `evidence`, `origin`, `note`), `requirement_matches[]`, `fit_score{technical_fit,
team_fit, experience_fit, domain_fit, certification_fit, overall}`, `team_proposal`, `knowledge_gaps[]`, `warnings[]`,
`matches[]`. A `closest` document of a `missing` row is not evidence. Other RAG routes: `POST /retrieve`, `POST /match`
(one requirement), `POST /reindex`, `GET /api/benchmark`, `POST /api/jobs/{benchmark|tests}` and `GET /api/jobs/{id}`
(background runs; not used by the web app).

### 4.2 Studio inbox and generation

- `POST /api/tenders` (studio key): body = one proposal input. `200 {"status": "ok", "id": "<tender_id>"}`. One tender per
  id (a new run replaces it). `400` no `tender` object, id or title; `401` key; `413` over 1 MB.
- `POST /api/generations`: `{tenderId, templateId?, params?: {language: auto|fr|en, project_type: auto|software|saas|other}}`.
  No `templateId` = the default template. `202 {"status": "ok", "runId": "<12 hex>"}`; `404` unknown tender; `409` a deck is
  already being generated (one at a time); `502` agents unreachable; `503` generation not configured.
- `GET /api/generations/<runId>`: `status` `queued` / `running` / `done` / `failed`, `steps[]` (`agent1`, `agent5`, `diagrams`,
  `agent4`, `agent6`, `publish`, each `done` / `degraded` / `failed`), `deckId`, `url` (the editor), `placeholders`
  (`[TO FILL]` count), `usage` (tokens per agent), `timings` (ms per agent).
- `DELETE /api/tenders/<id>` needs the studio key.

### 4.3 Deck agents: `rfp/generate` and `rfp/regenerate` (teammate's workflows)

`POST /webhook/rfp/generate` ("RFP 00 Main", credential MainWebhook) runs Agent 1 (requirements and solution), Agent 5
(credibility: team, references), Agents 2+3 (diagrams), Agent 4 (budget from `pricing_catalog.json`), Agent 6 (reviewer),
then publishes with `POST /api/decks`. Progress goes to `POST /api/generations/<runId>/progress`. `POST /webhook/rfp/regenerate`
("RFP 60", credential RegenWebhook) takes `{deckId, slideIndex, instruction?}` (instruction at most 200 characters) and
answers one slide spec. It needs the deck's entry in the agents' registry (`/home/node/.n8n/rfp-registry`), written when
the deck was published.

### 4.4 Refine with AI

`POST /webhook/cstam/refine-slide`, workflow "RFP - Refine Slide". Request (from the browser):

```json
{ "deckId": "d1733e9d", "slideIndex": 14, "instruction": "Rends cette diapositive plus concise" }
```

`deckId` matches `[A-Za-z0-9_-]{1,64}`; `slideIndex` is 0-based (the editor's own index; the title slide, the closing slide
and slides added by hand cannot be refined); `instruction` is 3 to 200 characters. Flow: Check request, Regenerate with
instruction (RFP 60, 90 s timeout), Check slide (a slide of placeholders or the unchanged slide is never saved), Save slide
(studio), Reset price approval when the slide has prices, Respond.

| Status | Body | When |
|---|---|---|
| 200 | `{status: "ok", slideIndex, title, warnings[]}` | slide rewritten and saved |
| 400 | `{status: "error", message}` | bad request, title slide, a slide the agents do not own, an index the deck no longer has |
| 404 | same | deck not in the agents' registry (made before the agents ran in n8n) or no longer in the studio |
| 502 | same | agents failed, regenerate webhook not published or key refused, studio refused the slide |
| 503 | same | the LLM is out of quota or gave no usable answer (nothing saved) |
| 504 | same | the agents exceeded their 45 s per-stage budget (slide not changed) |

The web app closes the embedded editor before the call and reopens it after the answer; otherwise the editor's autosave
(about every 10 s) would write its old copy over the refined slide.

### 4.5 Studio deck, save and template routes

| Method and path | Key | Purpose |
|---|---|---|
| `POST /api/decks`, `GET /api/decks/<id>` | studio key | create a deck from a deck spec; read it |
| `POST /api/decks/<id>/slides/<index>` | studio key | replace one slide (Refine Slide) |
| `POST /api/decks/<id>/slides/<index>/regenerate` | none | the editor's Regenerate: forwards `{deckId, slideIndex}` to `rfp/regenerate` |
| `POST /api/save`, `GET /api/save/<id>`, `GET /api/saves`, `DELETE /api/save/<id>` | none | editor save, load, list, delete |
| `GET/POST /api/templates`, `GET/PUT /api/templates/default`, `GET/DELETE /api/templates/<id>`, `POST /api/templates/rescan` | none | template library: import a `.pptx` (text removed, design kept, previews rendered), default template |
| `POST /api/export` | none | PPTX or PDF export (Chromium); the file is served under `/exports/` |
| `GET /api/config` | none | editor settings (`hasRegenerate`, ...); also the container health check |

## 5. Error handling

Nothing is retried automatically; every failure is counted in Main's Run Summary and the run continues.

| Case | What happens |
|---|---|
| RAG call fails (4xx / 5xx, 120 s timeout, refused) | tender gets `rag.status: ERROR`, every matrix row `coverage: unknown`, recommendation `review`; counted as a failed RAG call |
| RAG answers fewer rows than sent | missing rows count as `missing`, with a warning "RAG answered k of N requirements" |
| Studio inbox fails (401, 15 s timeout, refused) | that proposal input is not stored, no deck for it; Run Summary: "M failed" |
| Start Deck `409` | another deck is running: reported, not counted as a failure; start it later from the web app |
| Start Deck `502` / `503` | reported and counted (`Failed calls -> Deck start`) |
| LLM analysis fails or rate limit (429) | fit `unknown` for that tender (analysed again next run); counted in Run Summary |
| Deck agent stage fails validation | the stage retries, then marks the step `degraded` and replaces doubtful text with `[TO FILL]` placeholders |
| Deck agents' LLM out of quota | the agents wait on 429 up to `LLM_MAX_RATE_LIMIT_WAITS` (6) times per call, then fail the step |
| Refine errors | table in 4.4; the slide is only saved when a new, valid slide comes back |
| n8n configuration error (missing key, unknown provider) | n8n stops at start with a `CONFIGURATION ERROR` line in `docker compose logs n8n` |

## 6. Security

- Keys live only in `.env` (ignored by git; `.env.example` has empty values). They reach containers as environment
  variables. `n8n/init/init.js` writes the n8n credentials to a temporary file (mode 600) that it deletes right after
  `n8n import:credentials`, and never prints a key.
- Service-to-service calls carry header keys: `STUDIO_API_KEY` for the studio's write routes, `AGENTS_WEBHOOK_KEY` for the
  deck agents' webhooks (n8n Header Auth credentials MainWebhook and RegenWebhook). The browser holds no key.
- Every host port is bound to `127.0.0.1` (5173, 8001, 8091, 5679, 8004): nothing is reachable from another machine.
- The RAG's CORS allows only `http://localhost:5173` and `http://127.0.0.1:5173`.
- `cstam/refine-slide` has no authentication (a browser cannot keep a secret); it checks the origin and is reachable only
  from this machine. If n8n is ever exposed, put this call behind a backend that holds a key.
- The agents' webhooks output the request headers, so a stored n8n execution of RFP 00 / RFP 60 contains the webhook key.
  n8n keeps no successful execution (`EXECUTIONS_DATA_SAVE_ON_SUCCESS=none`); failed ones are kept until deleted.
- `services/proposal-studio` is mounted read-only into n8n.

## 7. Configuration

All settings are in `.env` (template: [.env.example](../.env.example)); `docker compose up -d --force-recreate n8n
proposal-studio` applies a change (no rebuild).

| Setting | Default | Effect |
|---|---|---|
| `STUDIO_API_KEY` | required | the studio's key; n8n's "Proposal Studio key" credential and the deck agents send it |
| `AGENTS_WEBHOOK_KEY` | required | the deck agents' webhook key (studio sends it, n8n checks it) |
| `LLM_PROVIDER` | `groq` | `groq`, `gemini`, `openai` or `ollama`: Main's model node and credential, and the deck agents |
| `LLM_MODEL` | provider default | `openai/gpt-oss-120b`, `models/gemini-3.1-flash-lite`, `gpt-4.1-mini`, `qwen3:4b-instruct` (from `n8n/llm.json`) |
| `DECK_LLM_PROVIDER`, `DECK_LLM_MODEL` | empty (= Main's) | a different LLM for the deck agents only |
| `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY` | empty | the key of each provider used |
| `OLLAMA_URL` | `http://host.docker.internal:11434` | Ollama on the host, seen from the n8n container |
| `PIPELINE_LLM_DELAY_MS` | by provider: ollama 0, groq 15000, gemini 4000, openai 1000 | pause between Main's LLM calls |
| `FIRECRAWL_KEY` | empty | real tender portals and buyer web pages; empty = URL sources off |
| `PIPELINE_URL_SOURCES` | `auto` | `auto` (on with a Firecrawl key), `on`, `off` |
| `PIPELINE_DEMO_MODE` | `false` | `true` = only the 6 demo tenders; `with` = the demo tenders and the real sources |
| `PIPELINE_PRESET` | (n8n rule) | `test` = small limits (20 records per API, 3 buyers, 3 market studies); `production` = full limits |
| `PIPELINE_AUTO_DECK` | `top1` | `none` = no deck is started by Main |
| `RFP_FORCE_IMPORT` | `0` | `1` = import and publish the workflows again at the next n8n start |
| `EXECUTIONS_DATA_SAVE_ON_SUCCESS` | `none` | `all` keeps every n8n execution (they then hold the webhook key) |
| `GENERIC_TIMEZONE` | `Europe/Paris` | n8n's timezone ("today" of a run) |

Fixed in `docker-compose.yml`: the internal URLs (`PIPELINE_RAG_URL`, `PIPELINE_STUDIO_URL`, `GENERATE_WEBHOOK_URL`,
`REGENERATE_WEBHOOK_URL`), `GENERATE_MODE=webhook`, `MAX_CORRECTION_ROUNDS=0`, `LLM_MAX_RATE_LIMIT_WAITS=6`,
`N8N_RUNNERS_TASK_TIMEOUT=1200`, `TEMPLATES_AUTOIMPORT=1`. The deck agents' `GROQ_BASE_URL`, `GROQ_API_KEY` and
`GROQ_MODEL` are computed from `LLM_PROVIDER` / `DECK_LLM_PROVIDER` at every n8n start (their client speaks the OpenAI
chat API, so any compatible provider works).

## 8. Check the integration by hand

```bash
curl -s http://localhost:8001/health
curl -s -X POST http://localhost:8001/retrieve/tender -H "Content-Type: application/json" \
  -d '{"tender_id":"SMOKE-1","sector":"public sector","data_mode":"company","requirements":{"technical":["Terraform"],"team":[],"experience":[]}}'
curl -s http://localhost:8091/api/tenders          # the studio inbox
curl -s http://localhost:8091/api/generations      # deck runs, steps, tokens, timings
```

The pipeline side is checked offline by `node n8n/test/edge_cases.js` and `node n8n/test/studio_adapter.test.js`
([tests/README.md](../tests/README.md)).
