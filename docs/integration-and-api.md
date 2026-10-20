# Integration and API contracts

Sections 1-4: the contracts between our n8n pipeline and the other parts. Sections 5-8: the API reference of the RAG
service, the proposal studio and the n8n webhooks, and the team's original n8n to RAG handoff notes.

The n8n workflow (`n8n/dist/RFP - Main.json`) does detection, cleaning, analysis, buyer research and the market study, then
**calls two services built by the team** over HTTP. This file is the contract between them: what each service receives,
what it must return, and how to test it without running the pipeline.

```
n8n: Sources → Clean → Analysis → Buyer research → Join Buyers & Build RAG ──POST──► RAG service      (team)
                                                   Join RAG ◄──────────────── requirements matrix + scores
     → Competitor & Budget Agent → Rank & Export → Build Proposal Input → Adapt for Studio
       ──POST /api/tenders──► Proposal studio (team, rfp-studio)  ──POST /api/generations──► its deck agents (rank-1 tender)
                                                                     (in the studio, or the teammate's 9 n8n workflows)
CSTAM interface ──POST /webhook/cstam/refine-slide──► n8n "RFP - Refine Slide" ──► the deck agents' regenerate webhook
                                                      (one slide + an instruction) ──► the studio's slide route (saved)
```

| service | URL in `00 - Config` | n8n node that calls it | status |
|---|---|---|---|
| RAG retrieval | `rag.url` (`http://rag:8001/retrieve/tender`) | `Call RAG` | connected, verified live 2026-10-19 |
| Proposal studio (rfp-studio: tender inbox + deck agents) | `proposal.url` (`http://proposal-studio:8091/api/tenders`), `proposal.studioUrl` + `/api/generations` | `Send to Proposal Service`, then `Start Deck` (rank-1 tender, `proposal.autoDeck: 'top1'`) | wired 2026-10-20 (credential "Proposal Studio key"); end-to-end run 2026-10-20 (`test/out/e2e_studio.log`: 5 proposal inputs stored, the rank-1 deck made by the studio's agents in cli mode, mock LLM) |
| Deck agents in n8n (the teammate's 9 workflows) + our `RFP - Refine Slide` | `Check request` of Refine Slide (`REGENERATE_URL`, `STUDIO_URL`) | the studio calls the agents' webhooks; the CSTAM interface calls Refine Slide | built 2026-10-20 (section 3); live run in the test n8n pending |

In docker compose the services are reached by their service names (`rag`, `proposal-studio`, `n8n`, `demo-tenders`):
`n8n/init/init.js` writes these URLs into Config at import. The defaults in `n8n/src/main/00_config.js`
(`host.docker.internal`) are for an n8n container next to services started by hand ([architecture.md](architecture.md)).

### Transport, at a glance

| | RAG service | Proposal studio |
|---|---|---|
| request | `POST rag.url`, JSON body | `POST proposal.url` (the studio's tender inbox), JSON body = the `Adapt for Studio` copy of the proposal input; then `POST proposal.studioUrl/api/generations` for the rank-1 tender |
| headers | `Content-Type: application/json` (set by n8n); no authentication | `Content-Type: application/json`; `X-API-Key` from the n8n credential **Proposal Studio key** (Header Auth) |
| calls per run | one per fit tender (fit high / medium) that has verified requirements, too-late ones included | inbox: one per fit tender still open for bidding, best rank first, at most `proposal.maxTenders` (10); deck: at most one (`proposal.autoDeck: 'top1'`, none with `'none'`) |
| pacing | one call at a time, 1 s apart | one call at a time, 1 s apart |
| timeout | 120 s per call | 15 s per call (the studio answers at once; a deck is made in the background) |
| retry | none | none |
| on failure | the tender gets `rag.status: error`; the run goes on | counted in Run Summary (its "Proposal inputs: …" line); the run goes on |
| answer read by | `Join RAG` | `Start Deck?` (the inbox's `{status, id}`), Run Summary (both answers) |
| n8n node | `Call RAG` (On Error: continue) | `Send to Proposal Service`, `Start Deck` (On Error: continue) |

The workflow around these two calls (which node builds what, what happens on failure) is described node by node in
[architecture.md](architecture.md).

---

## 1. RAG service — `POST rag.url`

### What n8n sends (one call per fit tender that has verified requirements)

```json
{
  "tender_id": "T1h16z8m",
  "title": "Mise en place d'un assistant conversationnel IA",
  "client": "AGENCE NATIONALE X",
  "sector": "public sector",
  "country": "France",
  "source": "boamp",
  "source_url": "https://www.boamp.fr/pages/avis/?q=idweb:26-101178",
  "published": "2026-10-16",
  "deadline": "2026-11-18",
  "language": "fr",
  "estimated_budget": "350 000 EUR",
  "data_mode": "company",
  "requirements": {
    "technical": ["LLM chatbot with RAG", "Vector database", "Python development"],
    "team": ["1 AI engineer", "1 project manager"],
    "experience": ["1 chatbot or AI assistant reference"],
    "timeline": "5 mois"
  }
}
```

- `requirements.*` are **short skill lines in English** (Config `rag.language`, 2 to 8 words, like a CV line: "PostgreSQL",
  "Minimum 3 senior developers"), written by the analysis LLM next to the full requirement sentence. Your RAG's rules
  understand that form; a long sentence ("The system must…") goes to its reranker and comes back `missing` (measured
  2026-10-19: "LLM agents and RAG chatbot" is covered at +9.2, the sentence form is missing at −3.8). The prompt shows only
  slot forms ("<technology>", "Minimum <n> senior <role>s"), no example values to copy. Generic words next to a technology
  are dropped first ("Angular interface" → "Angular") unless they are part of its name ("SQL Server", "Google Cloud"), and
  so are a trailing "required" and a "public or private" pair. A skill line is then kept only when its quote (the tender's
  own words) states it: its numbers; every technology / role / certification it names (IA = AI, relation client = CRM...);
  a kind of system (chatbot, mobile app, website, dashboard...) only when the quote or the tender's title names it; a sector
  only when the quote names it, never narrowing "public or private clients" to one of them ("Private cloud hosting" is no
  sector); a company service phrase ("document intelligence", "data platforms") only when its words stand together in the
  quote; at least half of its words (any language), and each word of a 1-2 word line naming nothing, unless the model's own
  English text uses it ("1 chief project" for "1 chef de projet" is refused). A small model copied prompt examples or the
  company's service lines ("LLM chatbot with RAG" for a video-analysis tender, "React frontend" for a ticketing notice
  naming no technology). A line that only adds a kind of system or a sector, or a trailing "in <Name>" the quote does not
  state, is sent without it ("LLM chatbot with RAG" → "LLM with RAG" when neither the quote nor the title names a
  chatbot). A line listing several skills becomes one requirement each (a part that fails is dropped; a refused part with
  a count, "1 chief project", takes the model's own words for that count, "1 project manager"). Otherwise the full English
  sentence is sent, checked the same way; a "translation" that only repeats the untranslated quote is never sent (the
  requirement is dropped). The full sentence and the verbatim quote stay on the n8n side (proof, proposal).
- `sector` is always one of the words the RAG understands: `public sector, health, education, telecom, finance, retail,
  tourism` (Config `rag.sectors`), or `null`. It must be written in the tender (title, buyer, text, or a CPV division such as
  33 / 85 for health); otherwise `public sector` is sent (analysis check `sector_not_in_text`).
- `requirements.timeline`: the contract duration as written ("12 mois"), only when the text states it. A bare number takes
  its unit from a label ("Durée (en mois) : 12") or from "<n> <unit>" after a duration word. A timeline with a unit is kept
  when one of its "<n> <unit>" is in the text in any wording ("4 years" = "48 mois", "douze mois"), but not as experience
  ("3 ans d'expérience"); or when it is copied word for word (3+ words, not a single date), equals the span between the
  start and end dates the text gives, or is a date range the text gives as such. Else `null` (analysis check
  `timeline_not_in_text`). Any stated period, a warranty too, can be taken as the timeline.
- A tender with no verified requirement is **not** sent (`rag.status = skipped_no_requirements`).
- `client` is the legal name found in the registry by the buyer research, else the buyer name as published.
- Our requirement ids (R1, R2...) are not sent: rows are matched back by text (below). Built by `Join Buyers & Build RAG`.
- **Since the team RAG v2 (2026-10-20, `docs/integration/N8N_RAG_HANDOFF.md` of the team repo):** the tender's metadata
  (title, country, source, source_url, published, deadline, language, estimated_budget, `requirements.timeline`) is sent too.
  The service stores it and shows it in its tender inbox (`GET /api/tenders`); it does not change the matching.
- `data_mode`: `company` (Config `rag.dataMode`) = OliveSoft's real knowledge base only. A source with `ragDataMode: 'demo'`
  (the synthetic demo tenders) sends `demo`: the service then also uses its FICTIONAL demo records, labelled `origin: demo`.

### What the service answers (real format)

Trimmed from a real answer of the service (2026-10-19 run, one of three requirements shown):

```json
{
  "tender_id": "Tx12mku",
  "requirements_matrix": [
    { "requirement": "The system must collect and track sales data from pharmacies and parapharmacies.", "category": "technical",
      "mandatory": true, "status": "missing", "found": 0, "needed": 1, "method": "reranker",
      "best_doc": null, "evidence": null, "closest_doc": "Project_HealthAnalytics_Dashboard.md", "percent": 0 }
  ],
  "requirement_matches": [
    { "requirement": "The system must collect and track sales data from pharmacies and parapharmacies.", "category": "technical",
      "method": "reranker", "matches": [],
      "closest": { "doc_id": "Project_HealthAnalytics_Dashboard.md", "type": "past_project", "similarity_score": 0.7672, "rrf_score": 0.0311,
                   "rerank_score": -5.37, "summary": "Public health KPI dashboard for a national agency, Power BI and Airflow pipelines on Azure.",
                   "evidence": { "quote": "Year: 2024. Duration: 6 months", "line": 2 } } }
  ],
  "fit_score": { "technical_fit": 0, "team_fit": null, "experience_fit": null, "domain_fit": 100, "certification_fit": null, "overall": 50 },
  "warnings": ["No 'team' requirements given; team_fit not computed.",
               "BLOCKING - no internal evidence for mandatory requirement(s): The system must collect and track sales data from ..."],
  "matches": [], "domain_evidence": ["..."], "benchmark_context": { "reranker": "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1", "...": "..." }
}
```

A covered row has `status: "covered"`, `best_doc`, `evidence` (a quote) and its document in `requirement_matches[].matches[]`.

### What n8n reads in the answer (`Join RAG`)

| field | used for |
|---|---|
| `requirements_matrix[]`: `requirement`, `category`, `mandatory`, `status` (`covered` / `partial` / `missing`), `best_doc`, `evidence` (a quote), `closest_doc`, `found`, `needed` | the requirements matrix (status per requirement + proof document) |
| `requirement_matches[]`: `requirement`, `matches[]` (`doc_id`, `type`, `summary`, `rerank_score`, `matched_on`, `origin`, `evidence{quote, kind, statement}`), `closest` | proof documents, their type (cv / project / tech stack), whether each one proves the row, nearest document for missing requirements |
| `fit_score`: `technical_fit`, `team_fit`, `experience_fit`, `domain_fit`, `certification_fit`, `overall` | the score columns |
| `warnings[]` | copied as they are into `rag.warnings` (export column `rag_warnings`) |

Rows are matched back to our requirements **by text**, then by the order sent (technical, team, experience). A requirement
the service does not return counts as **missing**. The service's own `status` is always used; n8n only derives one from
`rerank_score` (Config `rerankCovered` / `rerankPartial`) when a row has none. `rerankPartial` is also the score from which
a real (non-demo) document with no `matched_on` hit proves a row (below).

- **Blocking gaps** are computed by n8n, not read from the warnings: our requirements whose own tender words make them
  mandatory and whose status is `missing`. The service's `mandatory` flag is used only for a row that matches none of our
  requirements (the service marks every requirement mandatory by default).
- Coverage = (covered + 0.5 × partial) / requirements sent.
- Not used: `method`, `percent`, `parsed`, top-level `matches`, `domain_evidence`, `benchmark_context`. `found` /
  `needed` are copied into the matrix rows of the export JSON; `needed` also decides whether real proofs replace a demo
  `best_doc` (below). `Join RAG` also accepts `matrix` for `requirements_matrix`, `fit` for `fit_score`, and in evidence
  items `id` / `title` / `quote` / `reranker_score` / `meta` for `doc_id` / `summary` / `evidence.quote` / `rerank_score` /
  `metadata`.

### Errors and timeouts

| case | what n8n does |
|---|---|
| HTTP 4xx / 5xx, timeout (120 s), connection refused | the item carries `error`; `rag.status: "error"`, `rag.warnings: ["RAG call failed: <status and message>"]`. In the proposal input: `rag.status: "ERROR"`, `matrix.status: "ERROR"`, every row `coverage: "unknown"`, `recommendation: "review"`, risk "No requirements matrix (error)". Run Summary: `Failed calls -> RAG calls N`, `totals.rag_error`. |
| HTTP 200 without `requirements_matrix` | every requirement counts as missing (`status_source: "not_returned"`), warning `RAG answered 0 of N requirements`. |
| fewer rows than requirements sent | the missing ones count as missing, warning `RAG answered k of N requirements`. |
| evidence quote that is only a header line (`"COMPETENCES :"`) | kept, with a warning naming the document; the row is flagged `quote_is_header` (`justification_is_header` in the proposal input). |
| covered / partial row asking a certification by its acronym that no proof names ("1 PSM certified Scrum Master" proved by a CSM certificate) | status kept; `rag.matrix[].certs_not_in_proof`, warning `<id> "<requirement>" is <status> but no proof names PSM (<doc>: "<quote>"): check the certification held is accepted`, and a proposal risk. Only acronyms next to a certif* word count (2 words before or after, or a bracket just after); ISO27001 = ISO 27001; "PMP or PRINCE2" is satisfied by one of them. |

Nothing is retried and the run never stops on a RAG failure; the next run calls the service again. For a bad request,
answer 4xx with `{"error": "..."}`: `rag_warnings` gets n8n's error message and the full answer stays visible in the
output of `Call RAG`.

### Test the service without running the pipeline

1. One request by hand (the example above):

```bash
curl -s -X POST http://localhost:8001/retrieve/tender -H "Content-Type: application/json" -d '{"tender_id":"T1h16z8m","client":"AGENCE NATIONALE X","sector":"public sector","requirements":{"technical":["Develop LLM-based conversational agents","Build retrieval-augmented generation (RAG) pipelines"],"team":["Project manager with AI project experience"],"experience":["Three similar references in the public sector"]}}'
```

2. The real requests of a run, rebuilt from `proposal_inputs_<date>.json` (the file attached to `Build Proposal Input`,
   section 2). Each proposal input carries exactly what the RAG received: `tender_id`, `client` =
   `buyer_profile.legal_name` or else `tender.issuer`, `sector` = `analysis.sector`, `requirements` = the `technical`, `team`
   and `experience` lists of `analysis.requirements`. The file only holds the fit tenders still open (top 10); too-late
   tenders are also sent to the RAG by the pipeline. Save this as `rag_check.js` (Node 18 or later):

```js
// node rag_check.js proposal_inputs_2026-10-19.json http://localhost:8001/retrieve/tender
const [file, url] = process.argv.slice(2);
(async () => {
  for (const p of require(require('path').resolve(file))) {
    const q = p.analysis.requirements;
    if (!q.technical.length && !q.team.length && !q.experience.length) continue;   // n8n does not call the RAG for these
    const body = { tender_id: p.tender_id, client: p.buyer_profile.legal_name || p.tender.issuer, sector: p.analysis.sector,
      requirements: { technical: q.technical, team: q.team, experience: q.experience } };
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    const j = await r.json().catch(() => ({}));
    console.log(p.tender_id, r.status, (j.requirements_matrix || []).map(m => m.status).join(' ') || j.error || '');
  }
})();
```

```bash
node rag_check.js proposal_inputs_2026-10-19.json http://localhost:8001/retrieve/tender
```

3. The whole chain on a recorded run, against your running RAG (no n8n, no model):
   `RAG_LOCAL=http://localhost:8001/retrieve/tender node test/replay.js test/out/execution_real.json`; `Join RAG`'s
   result is written to `test/out/replay_rag.json`. Without `RAG_LOCAL`, the replay uses the mock of
   `node test/mock_server.js` (same answer format, word-overlap scores).

### What n8n keeps from the RAG v2 answer (2026-10-20)

| answer field | kept as | used for |
|---|---|---|
| `requirements_matrix[].origin`, `.statement`, `.best_doc`, `.evidence` | `rag.matrix[].origin`, `.statement`, `.best_doc`, `.best_quote`, `.best_rerank`, `.proof_weak`, `.quote_is_header` | `cv_document` = a CV quote; `user_entered` = a company record (a **declaration**, never shown as a quote); `demo` = fictional. Taken from the RAG's `best_doc`; when that is a demo record and at least `needed` (min. 1) real proofs are listed, all of them come from the best real proof instead (a whole sentence before a mid-sentence chunk of the same score), never a mix of two documents. `best_rerank` = that document's own score (the row's best when it is not listed); `proof_weak` = that document proves nothing by itself (below); `quote_is_header` = its quote is only a header line |
| `requirement_matches[].matches[]` | `rag.matrix[].evidence[]{doc_id, type, summary, origin, kind, quote, statement, rerank, matched_on, metadata, proves}` | every match is kept (no cap), by reranker score (the RAG's order on ties), real proofs first. `proves` = a rule hit (`matched_on` not empty), a score ≥ `rerankPartial` (no signal at all: trusted), or the own `best_doc` of a covered row (a partial row's own document proves only by a rule hit or that score); `false` = a weak neighbour the RAG also listed. A quote that starts mid-sentence ("payments. Proven ability to ...") loses that leading fragment when a matched term remains, with "…" when it stops mid-sentence (display only) |
| `team_proposal` | `rag.team_proposal` | the team slide (named people from the CVs, unfilled places); in the proposal input each place is mapped to our requirement id and gets our `mandatory` flag |
| `knowledge_gaps` | `rag.knowledge_gaps` | the gap plan (what is missing and how to close it); mapped to our requirement ids and `mandatory` flags the same way |
| `data_mode`, `coverage_basis`, `knowledge_counts` | same names | context |

`rag.demo_evidence` lists the covered / partial rows whose proof rests on demo records: the RAG's `best_doc` is a demo
record and fewer real proofs than `needed` are listed (a CV matched on nothing and scored below `rerankPartial` is no real
proof; 1 real proof when 2 are needed keeps the row demo). They become a risk and a note in the recommendation reason of
the proposal input.

**Open issue in RAG v2 (2026-10-20):** a line with several skills and no "or" needs ALL of them in ONE document, so
"LLM chatbot with RAG" is `missing` although the GenAI project lists llm + rag (it says "chat interface", not "chatbot").
Fix on the RAG side: alias "chat interface" / "assistant" to chatbot, or let the reranker decide such lines.

**For the RAG team** (seen in the RAG v2 runs of 2026-10-20; n8n keeps the RAG's status and only reports them):
- PSM and CSM are aliased: "1 PSM certified Scrum Master" is covered by a "Certified Scrum Master (CSM)" CV. Keep them
  distinct, or answer `partial` with a note "equivalent certification" (n8n now warns, see the errors table above).
- Fragment quotes: "vector database" was `partial` with the quote "users by 35 % within six months.". Reject quote lines
  that are too short or do not hold the skill term.
- The rules read only a record's technologies list: "LLM chatbot with RAG" was a gap although the demo record titled
  "RAG Customer Service Chatbot" exists (its technologies: fastapi, langchain, llm, python). Let the rules read the title /
  description of project records too.
- A generic word next to a technology ("Angular interface", "REST API exposure", "Node.js server") sent the line to the
  reranker, whose negative score made it missing / partial although the rules matched the technology. n8n now trims such
  words; a rule hit on the named technology could decide the row on the RAG side too.
- In demo mode the RAG picks a demo `best_doc` over a CV with equal or higher similarity (CV 0.8769 vs demo 0.8692). Choose a
  real document when one qualifies (n8n swaps them only when enough real proofs are listed, above).

### Known issue to fix on the RAG side (measured on the real run, 2026-10-19; fixed on our side by the short skill lines)

All 22 requirements of 13 real tenders came back `missing`, including clear IT ones whose right document **was** retrieved:
"Conception et mise en œuvre du backoffice et des logiciels associés" → closest `TechStack_PublicSector_Cloud.md`, rerank −6.5.
The reranker scores real tender wording (French, long sentences) far below its cut-off.

Second run (requirements now short and in English): still all `missing`, even
"Development and integration of LLM agents and RAG-based generation chains" → closest `Project_Telecom_RAGChatbot.md`,
which is exactly the right document. So the input is not the cause: the RAG needs a **threshold calibrated on real tender
requirements** (your benchmark measures hit@1, not this cut-off) and / or a **multilingual reranker**
(e.g. `bge-reranker-v2-m3`). Until then every proposal input said `rag.status: NONE` and `recommendation: no_bid`; with
RAG v2 and the short skill lines, rows come back covered / partial.

---

## 2. Proposal / deck service — `POST proposal.url`

### Where it goes: the team's proposal studio (rfp-studio)

The proposal / deck service is the team's **proposal studio** (`rfp-studio`): a Python server on port 8091 with a tender
inbox, a deck editor and its deck agents (`services/proposal-studio`, the `proposal-studio` container). Its deck agents
can run in two places, the same code in both (the n8n Code nodes embed `agents/lib`):

- `GENERATE_MODE=webhook` (**this repository**): the agents' **9 n8n workflows** run them, in the same n8n as ours
  (section 3). The studio POSTs each Generate to `http://n8n:5678/webhook/rfp/generate` and each Regenerate to
  `.../rfp/regenerate` with `AGENTS_WEBHOOK_KEY`; the agents report their progress and publish the deck back to the
  studio. This is the layout that lets a sales person refine a slide with an instruction (`RFP - Refine Slide`).
- `GENERATE_MODE=cli`: the studio starts them itself (`node agents/tools/generate.js`); no regenerate and no refine.

For our workflow nothing changes between the two: `Start Deck` POSTs `/api/generations` to the studio either way.

```
Build Proposal Input ─► Adapt for Studio ─► Send to Proposal Service ─► Start Deck? ─► Start Deck
 (full v2 + its file)    (the studio's copy)   POST /api/tenders            rank 1, stored,   POST /api/generations
                                               X-API-Key                    autoDeck 'top1'
```

1. **Inbox** (`Send to Proposal Service`, every proposal input): `POST {proposal.url}` = `http://proposal-studio:8091/api/tenders`,
   header `X-API-Key` (credential "Proposal Studio key", the studio's `STUDIO_API_KEY`), body = the `Adapt for Studio` copy.
   Answer `200 {"status": "ok", "id": "T1vll2ea"}`: `id` is our `tender_id` with any character outside `A-Z a-z 0-9 _ -`
   replaced by `-` (ours never have one). One tender per id: a new run replaces it. Errors: `401` (no or wrong key; calls
   from Docker are never "localhost" for the studio, so the key is required), `413` (over 1 MB; ours are 5-32 KB), `400`
   (no `tender` object, id or `tender.title`). Every stored tender is listed on the studio's home page and by
   `GET /api/tenders`, ready for a person to generate its deck there or from the interface.
2. **Deck** (`Start Deck`, Config `proposal.autoDeck: 'top1'`): only for the rank-1 tender, and only when the inbox stored it
   (`status: "ok"` and an `id`). `POST {proposal.studioUrl}/api/generations` with
   `{"tenderId": "<the id the inbox returned>", "params": {"language": "auto", "project_type": "software" | "saas" | "other"}}`
   and no `templateId`: the deck uses the studio's default template, set on the interface's Templates page or on the
   studio's home page (with none, the tender's colours). Answer `202 {"status": "ok", "runId": "<12 hex>"}`; the deck is
   made in the background (4-5 min and about 36 000 LLM tokens with Groq), its progress at `GET /api/generations/<runId>`
   (`queued` / `running` / `done` / `failed`, then `deckId` and `url`: the editor at `{studioUrl}{url}`). Only one deck at a
   time: `409` while another one runs; `503` generation not configured; `502` deck agents unreachable; `404` unknown
   tender. Each is only reported (Run Summary), never retried. With `autoDeck: 'none'` every deck is started by a person
   (studio or interface).

`project_type` (the studio knows software / saas / other; it maps our `tender_type` itself only by words, so `ai_data`
became `other` and lost its class-diagram slide): `software_build`, `ai_data` → `software`; `integration_saas` → `saas`;
`consulting`, `maintenance_support`, anything else → `other`. `analysis.tender_type` itself is sent unchanged.

### What the studio receives: the `Adapt for Studio` copy

The studio reads this contract as it is, but none of its honesty flags: every asset becomes a reference or an engineer,
every covered justification a "why us" bullet ("Nos atouts"), any `budget_estimate` three budget scenarios. On run 3 that
showed fictional demo records as references on 4 of 10 decks and 6 engineers where 5 CVs proved nothing. `Adapt for
Studio` (`src/main/PR2_adapt_for_studio.js`) therefore sends a **deep copy** without what the deck would present as proof
without being one. The full v2 below (the output of `Build Proposal Input` and its file `proposal_inputs_<date>.json`)
is unchanged.

| rule | fields | why |
|---|---|---|
| demo and non-proving evidence left out | `matrix.rows[].evidence[]` with `origin: "demo"` or `proves: false` | the studio merges evidence and assets into references and engineers, whatever their origin |
| demo and weak-only assets left out | `rag.assets[]` with `demo: true`, `origin: "demo"` or an empty `for` (only `weak_for`); `rag.suggested_assets` keeps what is left | same |
| justifications that are no argument cleared (`null`) | `matrix.rows[].justification` when the row rests on a demo record (`justification_kind` / `origin` `demo`), a weak proof (`justification_weak`) or a header line (`justification_is_header`, or a CV skills line: a label, a colon, a list of short items, "Databases: MySQL, phpMyAdmin, PostgreSQL") | each covered justification becomes a "Nos atouts" bullet; the row keeps its coverage and evidence |
| OliveSoft's declarations kept | `justification_kind: "declaration"` (a company record, the company's own statement in its own proposal) | decided with the user |
| the proposed team | with a `rag.team_proposal`: only the CVs of its `members[]` (rows' evidence and assets); each gets `metadata.role` = its `roles` joined (else its title); a member whose CV proves no row is added as a CV asset (`for` = the rows it is assigned to); a demo member never | the studio counts every CV asset as an engineer (T1w50xyr: 11 against a team of 3) |
| the team's certifications | one asset per `members[].certifications[]` entry: `{asset_id: "cert_<slug>", asset_type: "certification", origin: "cv_document", title, holders[]}` | the only place the studio reads certifications from; it never reads `team_proposal` |
| unknown coverage | `coverage_score: 0` when `coverage` is `unknown` (no matrix) | shown "À préciser"; a null score switches the whole deck to keyword guesses |
| no template id | `options.template_id: null` (Config default too) | the studio's default template; an id it does not know (the old `olivesoft_default`) fails the deck |
| budget only when the study stands behind it | `competition.budget_estimate: null` unless `competition.status` is `OK`, `confidence` is not `very low` and `comparables` ≥ 3 | the studio turns any estimate into 3 budget scenarios (Tdoatt8: 2.8 bn EUR) |
| language | `language` not `fr` / `en` → `en`, the original in `language_original` | the studio writes French or English only; another code gives a mixed deck |

Everything else is sent unchanged (`knowledge_gaps`, `obligations_not_in_matrix`, `blocking`, `recommendation`,
`analysis.risks`: the studio ignores them today; the interface shows them before a person starts a deck). The copy also
carries `studio_adapter` (ignored by the studio), so a person can see what was left out:
`{version, dropped{demo_evidence, weak_evidence, demo_assets, weak_assets, cvs_not_in_team, demo_justifications,
weak_justifications, header_justifications, budget_estimate}, added{team_cvs, certifications}, coverage_unknown_to_zero,
notes[], auto_deck (true = the rank-1 tender, Config autoDeck 'top1'), deck_params{language, project_type}}`.
`node test/studio_adapter.test.js` runs the copy through the studio's own normaliser on the 10 real inputs of run 3.

These rules stand in for fixes on the studio side (read `proves` / `demo` / `origin` / `justification_kind`, read
`rag.team_proposal`, the coverage `status`, `tender_type`, validate the language, let the budget respect `confidence`);
once the studio does, only the template, budget and language rules are still needed.

### What n8n sends: `olivesoft.proposal-input.v2`

One proposal input per fit tender still open for bidding, best-ranked first, at most `proposal.maxTenders` (10) per run
(`Build Proposal Input`; the studio gets the `Adapt for Studio` copy above). The structure
is the one the deck service asked for (`tender` / `analysis` / `buyer_profile` / `rag` / `matrix` / `competition` /
`options`), plus the verified extras a proposal needs: the tender's **own words** for each requirement (`quote`), the
`mandatory` flags, the `award_criteria`, the buyer's contacts and the awarded contracts behind the budget.
Every number and recommendation comes from data or from a rule written in `src/main/PR1_build_proposal_input.js` (listed
below), never from an LLM's opinion. A field is `null` / empty when unknown: the deck must say "not known", not invent.

| block | fields |
|---|---|
| top | `contract`, `tender_id`, `language` (write the proposal in it), `rank` (1 = best of the run), `run_id`, `generated_on` |
| `tender` | `title`, `reference`, `issuer`, `country`, `country_code`, `publication_date`, `deadline`, `days_to_deadline`, `estimated_value` (as written; a BOAMP range keeps both ends and its currency: "80000-215000 EUR"), `cpv[]`, `duration` (the notice's, BOAMP written like eForms: "36 month"; else the analysis timeline), `source`, `source_url`, `submission_url`, `documents_url` (consultation page holding the tender documents: short notices keep their requirements there), `description` (≤ 4000 chars), `lots[]{title, description, estimated_value}`, `award_criteria[]` (e.g. "Valeur technique (65)", "Prix (30)": **argue on these**) |
| `analysis` | `relevance_score` + `relevance_basis`, `fit` (high / medium), `tender_type`, `matched_service_lines[]` (from the company's services, each stated by the tender), `reason` (when the model gave none: `Tender text: "<verified quote>"`), `proof_quote` (verbatim), `quote_verified`, `sector`, `suggested_angle` (always `null`: the deck service writes it), `risks[]`, `requirements{technical[], team[], experience[], timeline}` |
| `buyer_profile` | `name`, `legal_name`, `sector` (from the buyer type; "Public company" also from a public registry legal form such as a SEM), `size`, `organization_description`, `estimated_revenue`, `staff`, `website` (`null` for a host without a dot, e.g. "https://undefined", or a tender platform), `contacts{emails[], phones[], addresses[]}`, `past_digital_projects[]{title, date, source}`, `past_winners[]{name, wins}` (all fields), `key_partners[]` (not researched yet: empty), `domain_requirements[]`, `research_status` (researched / research_failed / research_invalid / not_researched_budget / skipped_no_buyer_name / skipped_demo = a fictional demo buyer / missing), `enrichment_status` |
| `rag` | `status` (FULL / PARTIAL / NONE / SKIPPED / ERROR), `data_mode` (company / demo), `coverage_basis`, `suggested_assets{projects[], team[], stack[], other[]}` (ids of the documents that prove at least one row), `assets[]{asset_id, asset_type, origin, demo, title, for[] (rows it proves), weak_for[] (rows where it is only listed next to the proof, or is a partial row's own document with no rule hit and a score below `rerankPartial`: never suggested)}`, `team_proposal{size, places_filled, places_needed, members[]{name, asset_id, title, seniority, years, roles[], certifications[], assigned_to[]{requirement_id, requirement}}, unfilled[]{requirement_id, requirement, needed, available, mandatory}, notes[]}` (null = no team requirement; `mandatory` = our flag), `knowledge_counts` |
| `matrix` | `status` (OK / SKIPPED / ERROR), `rows[]{requirement_id, category, requirement (English), skill (the short line sent to the RAG), quote (tender, original language), mandatory, coverage (covered / partial / gap / unknown), coverage_score (100 / 50 / 0), rerank_score, origin (cv_document / user_entered / demo), justification_kind (document_quote / declaration / demo), justification, justification_weak (its document proves nothing by itself: no rule hit and a score below rerankPartial on a partial row), justification_is_header (its quote is only a header line), evidence[]{asset_id, asset_type, origin, evidence_kind, title, snippet, metadata, proves (false = listed by the RAG, proves nothing)}, closest_asset}` (justification and snippets drop a leading mid-sentence fragment of the RAG chunk when the matched term remains, "…" when the chunk stops mid-sentence), `summary{fit_score, rag_overall, by_category{technical, team, experience}, covered, partial, gaps, gaps_list[], mandatory_gaps[], obligations_not_in_matrix[] (the notice's obligation sentences, original language, that no row quotes), coverage (0-1), blocking[], demo_evidence[], knowledge_gaps[]{requirement_id, requirement, category, mandatory (our flag), kind, gap, suggestion}, recommendation, recommendation_reason}` |
| `competition` | `status` (OK / NO_COMPARABLE / NO_DATA / FAILED / NOT_STUDIED) + `detail`, `declared_value` (as written) + `declared_value_amount` (the high bound of a range) + `declared_value_range{low, high}` (null for one value, and for a span of years such as "2024-2027"), `budget_estimate{low, mid, high, min, max, currency (EUR, TND for Tunisia), confidence, comparables, spread, outliers[], basis}`, `competitors[]{name, past_wins (distinct awards among the comparables, most first), past_losses (null = not known; known for Tunisia), avg_amount (real prices only), last_win}`, `median_bids`, `positioning`, `budget_comment`, `comparables[]` (the awarded contracts used) |
| `options` | from Config `proposal.options` (the UI may override them per tender): `template_id` (`null` = the studio's default template), `formats[]`, `sections[]`, `overrides{tone, max_slides, gap_strategy}` (the studio reads only `template_id`) |
| `company` | `name`, `services[]`, `technologies[]` |

**Rules (in code):**
- `relevance_score` = 70 for fit high (50 for medium) + 30 × RAG coverage (no coverage term when there is no matrix).
  `relevance_basis` writes the calculation.
- `matrix.rows[].coverage`: the RAG's status per requirement (`missing` is called `gap`); `unknown` when the RAG was not
  called or failed. `coverage_score` = 100 / 50 / 0 for covered / partial / gap; `rerank_score` = the RAG reranker's raw score
  of the justification's own document (not the row's highest; a gap with no listed document: the closest document's).
- `matrix.rows[].mandatory`: true only when the tender's own words require it (doit, obligatoire, must, shall, يجب...); an
  award criterion or a weighted sub-criterion is never mandatory. `blocking` = mandatory requirements that are gaps.
- `matrix.summary.fit_score` = the average of the technical / team / experience fits (the RAG's `overall`, kept as
  `rag_overall`, includes a domain fit that is 100 for every public tender).
- `matrix.summary.recommendation`: `review` when there is no matrix (RAG skipped / failed; the reason points to
  `documents_url`); `bid` when every requirement is covered AND no obligation sentence of the notice is left out of the
  matrix; `no_bid` when a **mandatory technical** requirement is a gap and technical coverage is under 50 %;
  `bid_with_partner` when every gap is a team / experience requirement (technical ones covered or partial: the reason names
  the partial ones, "technical requirements covered or partial (R1 partial); gaps in ..."); otherwise `review` (partial or
  missing evidence to check, e.g. covered + partial rows only). `recommendation_reason` says which rule applied.
  Obligation sentences left out (`obligations_not_in_matrix`, from Verify Analysis: `doit`, `must`, `souhaité`... sentences
  that no kept requirement quotes, procedure sentences aside) turn `bid` into `review` ("N obligation sentence(s) of the
  notice are not in the matrix (...): check them before deciding"); with the other outcomes the rule stays and the reason
  ends with "; N obligation sentence(s) of the notice are not in the matrix (...)". When the RAG answered, a reason also
  ends with "; proof from fictional demo records only: R6" when `demo_evidence` is not empty.
- `competition.budget_estimate`: quartiles of the comparables' real prices: framework agreements (a ceiling) and outliers
  beyond 10x the median are left out (listed in `outliers`; only from 3 priced contracts: the "median" of 2 is their
  midpoint, which made the smaller one an outlier), in the currency most comparables use. `confidence` = medium
  with 5+ comparables, low with 2-4, very low with 1, one level lower when `spread` (75th / 25th percentile ratio) is above
  5 or max / min above 50. Competitors' `avg_amount` uses real prices only (no ceiling, no outlier).
  Comparables sharing no word and no CPV division with the tender are left out. `positioning` / `budget_comment` keep only
  sentences whose amounts, counts and names are in the chosen contracts.
- `analysis.risks` (facts only): short deadline (< 15 days) or none found; mandatory gaps; obligation(s) of the notice not
  in the requirements matrix (never checked against internal evidence); proof from fictional demo records; certification
  asked but not named in the proof ("R5 PSM": an equivalent one?); team places that cannot be staffed from the CV bank;
  service lines not stated clearly by the analysis (checks `no_service_matched`, `services_from_reason`,
  `services_all_listed`); no matrix; little detail in the notice; framework agreement; sovereign / certified hosting;
  strong competition (median ≥ 8 bids); a competitor with 2+ comparable wins; declared value far below (its high bound under
  half the 25th percentile) / far above (its low bound over 3 × the 75th percentile) comparable contracts.
- `competition.competitors[].past_wins`: one award counts once: comparables with the same buyer, date, amount and winners
  are one award; rows without an amount are never merged (two unpriced lots of one buyer on one day stay two wins).
- `buyer_profile.domain_requirements`: requirements about accessibility, GDPR, hosting, security, certification,
  interoperability, open source, cloud. `past_digital_projects`: the buyer's past notices about software / digital / data
  only. A web site counts when named by its kind (site internet / web / institutionnel / vitrine / marchand / mobile /
  e-commerce, intranet, extranet) or by web work (refonte du site; création / hébergement d'un site not followed by "de X",
  a place); a bare "site" is a place. A network counts only as an IT one; "SI" only in capitals, never the conjunction
  ("TRAVAUX SI NECESSAIRE").

Example (real format). The `tender` block is the CITY'UP notice of the 2026-10-19 runs; the other blocks are illustrative,
written so that every value follows the rules above (a real run's file: see "Test the service" below):

```json
{
  "contract": "olivesoft.proposal-input.v2",
  "tender_id": "T1i2ghpq", "language": "fr", "rank": 1, "run_id": "2026-10-19T11-17-15-285Z", "generated_on": "2026-10-19",
  "tender": {
    "title": "AAPC PRESTATIONS DE DEVELOPPEMENT D'AGENTS LLM ET SERVICES ASSOCIES", "reference": "T1i2ghpq", "issuer": "CITY'UP",
    "country": "France", "country_code": "FR", "publication_date": "2026-10-13", "deadline": "2026-10-26", "days_to_deadline": 7,
    "estimated_value": "180000 euros", "cpv": ["72000000"], "duration": null, "source": "francemarches",
    "source_url": "https://www.francemarches.com/appel-offre/10mt21350-2026-aapc-prestations-developpement", "submission_url": null,
    "description": "Le présent marché a pour objet prestations de conseil, conception, développement, intégration ... agents LLM et des chaînes de génération augmentée par recherche documentaire (RAG).",
    "lots": [], "award_criteria": []
  },
  "analysis": {
    "relevance_score": 93, "relevance_basis": "fit high (70) + 30 x RAG coverage 0.75",
    "fit": "high", "tender_type": "ai_data", "matched_service_lines": ["AI / LLM solutions (chatbots, RAG, document intelligence)"],
    "reason": "The tender focuses on LLM agents and RAG services.",
    "proof_quote": "solutions reposant sur l'intelligence artificielle générative, notamment des agents LLM et des chaînes de génération augmentée par recherche documentaire (RAG)",
    "quote_verified": true, "sector": "public sector", "suggested_angle": null,
    "risks": ["Short deadline: 7 days left", "ASKMONA won 2 comparable contracts"],
    "requirements": { "technical": ["Develop LLM-based agents", "Build retrieval-augmented generation pipelines"], "team": [], "experience": [], "timeline": "12 mois" }
  },
  "buyer_profile": {
    "name": "CITY'UP", "legal_name": "CITY'UP (CFTU)", "sector": "Public company", "size": "medium",
    "organization_description": "CITY'UP is a public company based in Fort-de-France.",
    "estimated_revenue": null, "staff": "10-19 employees (registry, 2024)", "website": null,
    "contacts": { "emails": ["cu.commandepublique@cityup.mq"], "phones": [], "addresses": ["19 RUE DE LA LIBERTE 97200 FORT DE FRANCE"] },
    "past_digital_projects": [], "past_winners": [], "key_partners": [], "domain_requirements": [],
    "research_status": "researched", "enrichment_status": "partial"
  },
  "rag": {
    "status": "PARTIAL",
    "suggested_assets": { "projects": ["Project_Telecom_RAGChatbot.md"], "team": [], "stack": ["TechStack_Data_AI.md"], "other": [] },
    "assets": [ { "asset_id": "Project_Telecom_RAGChatbot.md", "asset_type": "project", "title": "RAG chatbot for a telecom operator", "for": ["R1"], "weak_for": [] },
                { "asset_id": "TechStack_Data_AI.md", "asset_type": "stack", "title": "Data & AI stack", "for": ["R2"], "weak_for": [] } ]
  },
  "matrix": {
    "status": "OK",
    "rows": [
      { "requirement_id": "R1", "category": "technical", "requirement": "Develop LLM-based agents", "quote": "notamment des agents LLM",
        "mandatory": false, "coverage": "covered", "coverage_score": 100, "rerank_score": 4.12, "justification": "Built a RAG chatbot answering customer questions...",
        "evidence": [ { "asset_id": "Project_Telecom_RAGChatbot.md", "asset_type": "project", "title": "RAG chatbot for a telecom operator",
                        "snippet": "Built a RAG chatbot answering customer questions...", "metadata": null, "proves": true } ],
        "closest_asset": null },
      { "requirement_id": "R2", "category": "technical", "requirement": "Build retrieval-augmented generation pipelines",
        "quote": "chaînes de génération augmentée par recherche documentaire (RAG)", "mandatory": false, "coverage": "partial", "coverage_score": 50, "rerank_score": 0.85,
        "justification": "LangChain, Qdrant, pgvector", "evidence": [ { "asset_id": "TechStack_Data_AI.md", "asset_type": "stack", "title": "Data & AI stack", "snippet": "LangChain, Qdrant, pgvector", "metadata": null, "proves": true } ],
        "closest_asset": null }
    ],
    "summary": { "fit_score": 75, "rag_overall": 82, "by_category": { "technical": 75, "team": null, "experience": null }, "covered": 1, "partial": 1, "gaps": 0,
      "gaps_list": [], "mandatory_gaps": [], "obligations_not_in_matrix": [], "coverage": 0.75, "blocking": [], "recommendation": "review",
      "recommendation_reason": "partial or missing evidence: R2 partial: check them before deciding" }
  },
  "competition": {
    "status": "OK", "detail": "studied", "declared_value": "180000 euros", "declared_value_amount": 180000, "declared_value_range": null,
    "budget_estimate": { "low": 10000, "mid": 30168, "high": 128640, "min": 5328, "max": 285000, "currency": "EUR", "confidence": "low",
      "comparables": 11, "spread": 12.9, "outliers": [ { "id": "T673401-2026", "amount": 785000, "title": "Mise en place d’un outil conversationnel (chatbot)." } ],
      "basis": "amounts of 11 awarded contract(s) the agent judged comparable (1 outlier(s) beyond 10x the median left out)" },
    "competitors": [ { "name": "ASKMONA", "past_wins": 2, "past_losses": null, "avg_amount": 19800, "last_win": "2026-02-24" },
                     { "name": "CRAFTMAN DATA", "past_wins": 2, "past_losses": null, "avg_amount": 17748, "last_win": "2026-03-02" },
                     { "name": "YELDA", "past_wins": 1, "past_losses": null, "avg_amount": null, "last_win": "2026-09-30" } ],
    "median_bids": 2, "positioning": "Chatbot contracts are mostly small; specialised start-ups win most of them.", "budget_comment": null,
    "comparables": [ { "id": "T673401-2026", "date": "2026-09-30", "amount": 785000, "currency": "EUR", "buyer": "INPI", "winners": ["YELDA"],
                       "bids": 20, "others": [], "cpv": "72000000", "framework": false, "source": "TED", "title": "Mise en place d’un outil conversationnel (chatbot)." } ]
  },
  "options": { "template_id": null, "formats": ["pptx", "pdf"],
    "sections": ["context", "understanding", "solution", "team", "references", "timeline", "pricing", "why_us"],
    "overrides": { "tone": "formal", "max_slides": 15, "gap_strategy": "mitigate" } },
  "company": { "name": "OliveSoft", "services": ["web and mobile applications, custom software and digital platforms", "AI / LLM solutions (chatbots, RAG, document intelligence)", "..."], "technologies": ["Python", "React", "LLM", "RAG", "..."] }
}
```

### What the studio answers

```json
{ "status": "ok", "id": "T1vll2ea" }
```
(the inbox, HTTP 200; `Start Deck`: HTTP 202 `{"status": "ok", "runId": "0a1b2c3d4e5f"}`). Errors are 4xx / 5xx with
`{"status": "error", "message": "..."}`. There is no PPTX / PDF URL: the studio exports a deck from its editor (where the
placeholder and pricing approval checks are), so a deck is reached as `{studioUrl}/editor.html?id=<deckId>` once
`GET /api/generations/<runId>` says `done` (the CSTAM interface shows that editor inside its own deck page,
`#/decks/<deckId>`). Run Summary reads both answers ("Proposal inputs: 10 sent to the studio | deck started for "…" (run
0a1b2c3d4e5f)"), and its JSON has them in `studio{auto_deck, sent, failed, not_sent, deck}`.

### Errors and timeouts

| case | what n8n does |
|---|---|
| inbox: HTTP 4xx / 5xx (401 = no or wrong key), timeout (15 s), connection refused (studio not started) | that item of `Send to Proposal Service` carries `error`; the next tender is sent 1 s later; no deck for that tender. Run Summary: "Proposal inputs: N sent to the studio (M failed: HTTP 401: …)", `Failed calls -> Proposal service M`, `has_warnings: true` (the optional alert e-mail says `WARNINGS`; it is also raised by a failed or invalid analysis, a failed market study, a coverage error (an API page, a scout list page or a detail page lost, a scout that failed, stopped early or left a page of its task list unread, an invalid extraction answer) and a source with nothing fetched; not by pages rejected as "not a notice", nor by a page `open_page` refused as a host of no source when no list page was lost). |
| deck: `409` (another deck is being generated) | only told: "no deck started: Start Deck for "…": another deck is being generated (the studio makes one at a time): start it from the interface once it is done"; no failed call. |
| deck: `503` (generation not configured), `502` (deck agents unreachable), other errors | told the same way, and counted: `Failed calls -> Deck start 1`, `has_warnings: true`. |
| rank-1 tender not stored, or `autoDeck: 'none'` | `Start Deck` does not run; the Run Summary line says why ("the rank-1 tender "…" is not in the studio (…)", "proposal.autoDeck is 'none'…"). |
| `Send to Proposal Service` disabled | n8n passes the proposal inputs through without calling anything: "Proposal inputs: 0 sent to the studio, N not sent (Send to Proposal Service is disabled)"; no deck. |
| no fit tender open for bidding | `Build Proposal Input` outputs nothing and the studio is not called (no studio line). |
| more fit open tenders than `proposal.maxTenders` | the best-ranked ones are sent; Run Summary counts the others (`proposal_not_sent`, "raise proposal.maxTenders"). |

Nothing is retried. By default (Google Sheet nodes disabled) every run processes all current tenders again, so the same
`tender_id` can reach the studio in several runs (its inbox keeps the last one; `run_id` says which) and a failed call gets
another chance next run. A deck already made stays in the studio; each `Start Deck` makes a new one. With incremental runs (sheet enabled, production preset) a tender exported by a previous run is skipped, even if its
proposal call failed, and so is the same notice reached under another URL with the same title, buyer and deadline. URL
notices a previous run found expired (deadline passed), awarded, cancelled or superseded are not read again either. The
service must also accept `null` / empty fields: the deck says "not known" instead of inventing.

### Test the service without running the pipeline

Every run attaches **all** proposal inputs as one file, `proposal_inputs_<date>.json`, to the first output item of
**Build Proposal Input** (download it from the node's Binary tab). It is a JSON array of `olivesoft.proposal-input.v2`
objects, best rank first: the full v2, before `Adapt for Studio` (the bodies n8n posts are the output items of
`Adapt for Studio`). Without any server, `node test/studio_adapter.test.js` runs the adapter and then the studio's own
normaliser (`services/proposal-studio/agents/lib/input.js`, read-only) on the 10 real inputs of run 3 and the example, and prints what a
deck would show before and after (references, engineers, certifications, "why us" bullets, budget scenarios).

To post a file to a running studio the way n8n does (one at a time, the key in the header), this script,
`proposal_check.js` (Node 18 or later; it writes to the studio's inbox, and a full v2 file still holds what the adapter
leaves out):

```js
// STUDIO_API_KEY=... node proposal_check.js proposal_inputs_2026-10-19.json http://localhost:8091/api/tenders
const [file, url] = process.argv.slice(2);
(async () => {
  for (const p of require(require('path').resolve(file))) {
    const t0 = Date.now();
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.STUDIO_API_KEY || '' },
        body: JSON.stringify(p), signal: AbortSignal.timeout(15000) });
      console.log(p.rank, p.tender_id, r.status, `${Date.now() - t0} ms`, (await r.text()).slice(0, 200));
    } catch (e) { console.log(p.rank, p.tender_id, 'FAILED', e.message); }
    await new Promise(ok => setTimeout(ok, 1000));                                   // n8n waits 1 s between calls
  }
})();
```

A file of 10 real proposal inputs (from a replay of a recorded run) is also in the repository:
`n8n/test/out/execution_ragv2_run3_nodes/Build_Proposal_Input.json` (the 10 proposal inputs of run 3, a test fixture).

### Connect it

In this repository it is connected by `docker compose up`:

1. `STUDIO_API_KEY` in `.env` is the studio's key and the value of n8n's credential **Proposal Studio key** (Header Auth,
   Name `X-API-Key`, id `StudioKey0000001`), written by `n8n/init/init.js` at every n8n start.
2. `00 - Config`: `proposal.studioUrl` = `http://proposal-studio:8091` (set at import), `proposal.autoDeck`
   (`PIPELINE_AUTO_DECK` in `.env`: `top1` or `none`), `proposal.maxTenders` (10, in `n8n/src/main/00_config.js`).
3. Run the workflow; check Run Summary's line "Proposal inputs: N sent to the studio | deck started for …" and the
   studio's home page (the tenders, then the deck of the rank-1 one).

---

## 3. Deck agents in n8n (webhook mode) and `RFP - Refine Slide`

### What runs where

```
CSTAM interface :5173 ──► studio :8091 ──POST /webhook/rfp/generate (X-API-Key)──► n8n (n8n:5678)        
  or Main's Start Deck                   ◄── progress, POST /api/decks (studio key) RFP 00 Main → 10 / 40 / 20 / 30 / 50
  (Generate, the editor's                                                          (agents 1, 5, 2+3, 4, 6 + publish)
   Regenerate)                           ──POST /webhook/rfp/regenerate──────────► RFP 60 Regenerate one slide
CSTAM interface ──POST /webhook/cstam/refine-slide──► RFP - Refine Slide ──► RFP 60 (+ instruction) ──► studio slide route
```

The `n8n` container holds our 4 workflows and the agents' 9 (imported by `n8n/init/init.js` from
`services/proposal-studio/workflows/[0-9]*.json` as they are, never regenerated: `agents/tools/n8n_reload.sh` and
`generate_workflows.js` rewrite that folder). Its port is bound to `127.0.0.1:5679` on the host only. The
teammate's workflows have fixed ids (`rfpMain000000001`, `rfpAgent10000001`, `rfpDiagrams00001`, `rfpAgent40000001`,
`rfpAgent50000001`, `rfpAgent60000001`, `rfpRegenerate001`, `rfpLlmJson000001`, `rfpErrors0000001`); none collides with
ours, and none of ours had a webhook before Refine Slide (`cstam/refine-slide`).

### Start order

`docker compose up -d` starts everything; no order is needed. The n8n container imports and publishes the workflows
before n8n starts (`n8n/init/entrypoint.sh`), so the webhooks answer as soon as it is healthy. The studio answers
Generate with 502 while n8n is not up yet.


### The n8n container's settings (`docker-compose.yml`)

| setting | value | why |
|---|---|---|
| port | `127.0.0.1:5679:5678` | the browser (Refine with AI) reaches n8n at `http://localhost:5679`; only this machine can |
| mount | `services/proposal-studio` at `/data/rfp-studio`, **read-only** | the agents read their prompts, `company_profile.json`, `pricing_catalog.json` and the mock fixtures there; init reads their 9 workflows |
| volume | `n8n_data` at `/home/node/.n8n` (with `rfp-registry/`) | n8n's database and encryption key, and the agents' registry: one entry per published deck (needed by regenerate and refine) and `errors.jsonl` |
| `N8N_BLOCK_ENV_ACCESS_IN_NODE` | `false` | the agents' Code nodes read every setting with `$env` |
| `NODE_FUNCTION_ALLOW_BUILTIN` | `fs,path,crypto` | they `require('fs')` and `require('path')` |
| `N8N_RUNNERS_TASK_TIMEOUT` | `1200` | one agent stage is one Code node; the default 300 s kills a stage that waits out rate limits |
| `RFP_STUDIO_DIR`, `AGENTS_REGISTRY_DIR` | `/data/rfp-studio`, `/home/node/.n8n/rfp-registry` | the mount and the registry |
| `STUDIO_BASE_URL`, `STUDIO_API_KEY` | `http://proposal-studio:8091`, `.env` `STUDIO_API_KEY` | progress pushes, `POST /api/decks`, `GET /api/decks/<id>` |
| `PUBLIC_EDITOR_URL` | `http://localhost:8091` | the editor link in the agents' result |
| `LLM_MODE`, `GROQ_BASE_URL`, `GROQ_API_KEY`, `GROQ_MODEL` | `real`; the other three computed from `LLM_PROVIDER` by `n8n/init/entrypoint.sh` (groq: `https://api.groq.com/openai/v1`; gemini: Google's OpenAI-compatible API; openai; ollama: `OLLAMA_URL/v1`), the provider's key, Main's model or `LLM_MODEL` | the agents' own OpenAI-style client |
| `MAX_CORRECTION_ROUNDS`, `LLM_MAX_RATE_LIMIT_WAITS` | `0`, `6` | one pass per agent (free tiers); at most about 63 s of 429 waits per call |
| `EXECUTIONS_DATA_SAVE_ON_SUCCESS` | `none` (`.env` can change it) | a kept execution of the agents' webhooks holds the webhook key (below); failed runs are still kept |
| credentials | `MainWebhook` (`rfpMainWebhook01`) and `RegenWebhook` (`rfpRegenWebhook1`), Header Auth `X-API-Key` = `.env` `AGENTS_WEBHOOK_KEY` | the studio sends that key as `GENERATE_WEBHOOK_KEY` / `REGENERATE_WEBHOOK_KEY` |

The keys reach n8n through the container environment; `init.js` writes the credentials to a temporary file (mode 600)
that is deleted right after `n8n import:credentials`, and never prints a key.

One copy stays inside n8n: the agents' two webhooks output the request headers, and n8n hides only `authorization` and
`cookie`, so an execution of `RFP 00` or `RFP 60` holds the webhook key (`x-api-key`) in clear. This n8n keeps no
successful run (`EXECUTIONS_DATA_SAVE_ON_SUCCESS=none`); a failed one is kept, with the key, until it is deleted in the
n8n editor or the `n8n_data` volume is removed.


### Refine one slide — `POST /webhook/cstam/refine-slide`

The spec's Human-in-the-Loop bonus: a sales person rewrites one section of a deck with a prompt. The teammate's
regenerate code already takes an instruction (`pipeline.regenerate`, at most 200 characters, given to the agent as a
correction it must apply; the code checks still lock the facts), but neither his editor nor his server send one, and his
webhook answers the slide without saving it. `RFP - Refine Slide` (`dist/RFP - Refine Slide.json`, id
`RfpRefineSlide01`) adds both ends:

```
Refine request (Webhook) → Check request → Request OK? → Regenerate with instruction (POST rfp/regenerate, RegenWebhook)
  → Check slide → Slide OK? → Save slide (POST {studio}/api/decks/<deckId>/slides/<slideIndex>, Proposal Studio key)
  → Answer → Prices on slide? → Reset price approval → Respond          (every "no" goes straight to Respond)
```

Request (JSON, from the browser; CORS allowed for `http://localhost:5173` and `http://127.0.0.1:5173`):

```json
{ "deckId": "a2fd6151", "slideIndex": 3, "instruction": "Rends cette diapositive plus concise et mets en avant l'expérience dans le secteur public" }
```

- `deckId`: the studio's deck id (`[A-Za-z0-9_-]{1,64}`).
- `slideIndex`: the slide's place in the studio's editor, **0-based**: the index the editor's own Regenerate button sends,
  the index of the studio's `slides` array and of the agents' registry map. 0 (title) and the last slide (closing) are
  fixed; so are the contents / about pages of a structured template and slides added by hand.
- `instruction`: 3 to 200 characters (spaces collapsed).

Answers (JSON, the HTTP status as shown):

| status | body | when |
|---|---|---|
| 200 | `{"status": "ok", "slideIndex": 3, "title": "...", "warnings": [...]}` | the agent rewrote the slide and the studio saved it (validated, laid out with the deck's theme, like the editor's Regenerate); `warnings` = the slide's own (they also show in the editor) |
| 400 | `{"status": "error", "message": "..."}` | a bad request; the title slide; a slide the agents do not own ("This slide cannot be refined: ..."); a slide index the deck no longer has |
| 404 | same | "This deck was made before the agents ran in n8n: generate it again to refine it." (not in the registry), or the deck is no longer in the studio |
| 502 | same | the agents failed or could not rewrite the slide, or could not redo its diagram or plan (it was not changed), the regenerate webhook is not published or refused the key, the studio refused the key or the new slide |
| 503 | same | the agents' LLM is out of quota or gave no usable answer: their slide of `[TO FILL]` placeholders is **not** saved |
| 504 | same | the agents took too long (their budget is 45 s; the call waits 90 s): the slide was not changed |

What the caller must know:

- **Close the deck editor first** (unmount its frame) and open it again after the answer. The editor saves the whole
  deck about every 10 s (and 2 s after a change): left open, it writes its old copy over the refined slide. Wait for its
  last save before closing it.
- The agent rewrites the slide from the tender as it was at generation time and the instruction, not from the slide's
  current text: edits made by hand on that slide are replaced.
- A refined slide with prices (`requiresApproval`) drops the deck's price approval, as the editor does after its own
  Regenerate (`Reset price approval` reads the deck with `GET /api/save/<id>` and writes it back without
  `approvals.pricing` when one is set); a warning says to approve the prices again.
- Indexes come from the deck as published: after slides are added or removed by hand, an index may point to another
  agent slide.
- No authentication: the browser cannot hold a key. That is fine here, where n8n's port only listens on 127.0.0.1;
  in an n8n reachable from other machines, put the call behind the CSTAM backend instead.

Settings at the top of `Check request`: `REGENERATE_URL` (`http://127.0.0.1:5678/webhook/rfp/regenerate`: the agents in
the same n8n) and `STUDIO_URL` (`http://proposal-studio:8091`, like Main's Config, set at import). `n8n/test/e2e.js` tests it with
`REFINE=1`: the call from origin `http://localhost:5173`, then the slide read back with `GET /api/save/<deckId>`.

### The studio's own Regenerate (for comparison)

`POST {studio}/api/decks/<deckId>/slides/<n>/regenerate` (no key, no body): the studio forwards `{deckId, slideIndex}`
(no instruction) to `rfp/regenerate` with a 60 s timeout, lays the answer out and saves it. Without
`REGENERATE_WEBHOOK_URL` (cli mode) it answers 503 and the editor hides the button. `test/e2e.js` tests it with `REGEN=1`.

---

## 4. Versioning

The `contract` field names the format. A breaking change (renamed or removed field) gets a new version
(`olivesoft.proposal-input.v3`); adding a field does not. Agree on changes in this file before changing the code
(`n8n/src/main/PR1_build_proposal_input.js` builds it, `n8n/src/main/PR2_adapt_for_studio.js` makes the studio's copy;
`n8n/src/main/RG1_join_buyers_build_rag.js` and `RG2_join_rag.js` handle the RAG). The `studio_adapter` block has its own
`version`. The Refine Slide contract (section 3) is written in `n8n/src/refine/*.js` and the `RFP - Refine Slide` part of
`n8n/build.js`.

---

## 5. RAG service API (`rag`, port 8001)

The React website is the only user interface. Port 8001 is the backend API;
opening its root redirects to http://localhost:5173.

`POST /retrieve/tender` accepts the existing team payload:

```json
{"tender_id":"TN-001","client":"Anonymized buyer","sector":"public",
 "data_mode":"company","requirements":{"technical":["Terraform"],"team":[],"experience":[]}}
```

`data_mode` is optional and defaults to `company`. Use `demo` explicitly for fictional records.
From n8n (compose network): `http://rag:8001/retrieve/tender`. From the host: `http://localhost:8001`. The web app
reaches it through its own origin (nginx proxies `/api`, `/retrieve` and `/health`). CORS allows only the web app's
origins (`RAG_CORS_ORIGINS`); server-to-server calls (n8n) are not affected.

Other endpoints: `POST /retrieve`, `POST /match`, `GET /health`, `POST /reindex?data_mode=company`,
`GET /api/tenders`, `GET /api/tenders/{tender_id}`, `DELETE /api/tenders` (empties the inbox,
returns `{"deleted": count}`) and `DELETE /api/tenders/{tender_id}` (returns `{"deleted": id}`, 404 when unknown).
A tender ID may contain `/`. Each `/retrieve/tender` call persists the submitted tender metadata and latest
analysis, so the React tender inbox can display real n8n submissions and their deadlines.
On the **Tenders** page, **Clear tenders** empties the inbox and the delete button on a row removes one tender,
each after a confirmation. The knowledge base is not changed; n8n stores a tender again the next time it sends it.
Matching preserves `doc_id`, `type`, `similarity_score`, `summary`, and adds origin and evidence kind.
Response matrices retain nullable `evidence` for CV quotes, plus `statement` for declarations.
Added fields: `team_proposal`, `knowledge_gaps`, `knowledge_counts`, `evidence.weak` and `evidence.note`,
`requirements_matrix[].evidence_weak` and `.note`, and `parsed.any_cert`.

Records: `GET/POST /api/records`, `PUT/DELETE /api/records/{id}`,
`POST /api/records/validate`, `POST /api/records/{id}/index`.
Create/update accepts form fields plus `action: draft|index`. The server assigns IDs, origin and timestamps.
`GET /api/records?data_mode=demo` lists read-only samples. Validation gives field errors and warnings.
Direct `POST /api/documents` returns 410 with guidance to use records. CV uploads remain unavailable.
Delete returns 409 if records link to the target; repeat with `confirm_links=true` after reviewing the warning.
Indexing failure saves a draft and returns 503 with a retry message. The previous index stays available;
edited drafts and deleted records are filtered out even before a successful rebuild.
Interactive API reference: http://localhost:8001/docs.

## 6. Proposal studio API (`proposal-studio`, port 8091)

Code: `services/proposal-studio/server.py` (the teammate's own reference: `services/proposal-studio/README.md`). Key =
header `X-API-Key` with `STUDIO_API_KEY`; requests from other containers always need it where the table says so.

| Method and path | Key | Purpose |
|---|---|---|
| `GET /api/tenders`, `GET /api/tenders/<id>` | no | The tender inbox (`{tenders, generationEnabled, llmModels}`) and one stored proposal input |
| `POST /api/tenders` | yes | Store one proposal input (n8n's `Send to Proposal Service`, section 2). `200 {status, id}` |
| `DELETE /api/tenders/<id>`, `POST /api/tenders/rescan` | no | Delete one tender (to `tenders/trash`), reload the inbox folder |
| `POST /api/generations` | no | Start a deck: `{tenderId, templateId?, params?}` → `202 {runId}`; `409` one already running, `502` agents unreachable, `503` not configured |
| `GET /api/generations`, `GET /api/generations/<runId>` | no | Runs and their status (`queued` / `running` / `done` / `failed`, `deckId`, `url`, steps, warnings) |
| `POST /api/generations/<runId>/progress` | yes | Progress pushed by the deck agents |
| `POST /api/decks`, `GET /api/decks/<id>` | yes | Create a deck from a deck spec (`deck.schema.json`); read it |
| `POST /api/decks/<id>/slides/<index>` | yes | Replace one slide (n8n's Refine Slide `Save slide`) |
| `POST /api/decks/<id>/slides/<index>/regenerate` | no | The editor's Regenerate: forwards `{deckId, slideIndex}` to `REGENERATE_WEBHOOK_URL` |
| `GET/POST /api/templates`, `GET/PUT /api/templates/default`, `GET/DELETE /api/templates/<id>`, `POST /api/templates/rescan` | no | Template library (import a `.pptx`, default template, previews) |
| `POST /api/save`, `GET /api/save/<id>`, `GET /api/saves`, `DELETE /api/save/<id>` | no | Editor save, load, list, delete |
| `POST /api/upload`, `GET /api/media`, `POST /api/extract-theme`, `POST /api/qrcode` | no | Media and theme helpers |
| `POST /api/export` | no | PDF or PPTX export (Chromium); the file under `/exports/` |
| `GET /api/config` | no | `{hasRegenerate, ...}` for the editor (also the container health check) |

## 7. n8n webhooks (`n8n`, port 5679 on the host, `n8n:5678` inside)

| Webhook | Workflow | Caller | Auth |
|---|---|---|---|
| `POST /webhook/rfp/generate` | RFP 00 Main (generate deck) | proposal studio (`GENERATE_WEBHOOK_URL`) | `X-API-Key` = `AGENTS_WEBHOOK_KEY` (credential MainWebhook) |
| `POST /webhook/rfp/regenerate` | RFP 60 Regenerate one slide | studio (editor's Regenerate), RFP - Refine Slide | `X-API-Key` = `AGENTS_WEBHOOK_KEY` (credential RegenWebhook) |
| `POST /webhook/cstam/refine-slide` | RFP - Refine Slide | the web app's deck page (browser, origin `http://localhost:5173`) | none (allowed origins `http://localhost:5173`, `http://127.0.0.1:5173`) |

RFP - Main has a manual trigger and a daily schedule; it is not published, so it runs only when started from the n8n
editor. Its sub-workflows RFP - Research Tools (`QHV4m1jKm8fKBXNA`) and RFP - Scout Tools (`kJh2xit7vcFVsP7i`) are
published (agents call the published version).

---

## 8. n8n to RAG handoff (team notes)

This guide is for the n8n owner integrating real tender data with the OliveSoft RAG service.
The React website is only the user interface. The RAG service on port `8001` is the API.

### Start the RAG API

`docker compose up -d rag`; it answers at http://localhost:8001/health from the host and at
`http://rag:8001/retrieve/tender` from n8n (same compose network).


### Main endpoint

```text
POST /retrieve/tender
Content-Type: application/json
```

The endpoint accepts the structured tender output from the extraction step.
The current RAG retrieval uses the requirements, client and sector fields. Metadata
such as `title`, `deadline`, `language`, `estimated_budget` and `source_url` is
accepted, persisted with the analysis, and exposed through `GET /api/tenders`, but
does not affect matching.

### Request payload

```json
{
  "tender_id": "TN-REAL-001",
  "title": "Digital platform implementation",
  "client": "Real client name",
  "sector": "Public administration",
  "country": "France",
  "source": "BOAMP",
  "source_url": "https://example.com/tender/TN-REAL-001",
  "published": "2026-10-20",
  "deadline": "2026-11-20T23:59:00+01:00",
  "language": "fr",
  "estimated_budget": "250000 EUR",
  "data_mode": "company",
  "requirements": {
    "technical": [
      "React or Angular frontend",
      "PostgreSQL",
      "REST API",
      "Cloud hosting AWS or Azure"
    ],
    "team": [
      "3 senior developers",
      "1 project manager PMP certified",
      "1 UX UI designer"
    ],
    "experience": [
      "2 previous public-sector digital projects"
    ],
    "timeline": "6 months from contract signature"
  }
}
```

#### Field rules

- `tender_id`: optional string, but n8n should always provide a stable identifier.
- `title`: optional tender title. It is displayed in the React tender inbox.
- `client`: optional string. Pass the extracted client name when available.
- `sector`: optional string. Pass the extracted sector when available.
- `country`: optional country or geographic scope.
- `source`: optional source name, such as `BOAMP`, `TED` or the buyer portal.
- `source_url`: optional public URL of the original tender.
- `published`: optional publication date or timestamp.
- `deadline`: optional submission deadline. Pass the original timezone when known.
- `language`: optional tender language, such as `fr` or `en`.
- `estimated_budget`: optional budget string, including currency when available.
- `data_mode`: `company` or `demo`; omit it or use `company` for real tenders.
- `requirements.technical`: array of one requirement per item.
- `requirements.team`: array of one requirement per item.
- `requirements.experience`: array of one requirement per item.
- `requirements.timeline`: optional context field; it is not currently searched by RAG.
- Empty categories are valid. Do not invent requirements to fill them.

### Response contract

The response includes:

```json
{
  "tender_id": "TN-REAL-001",
  "data_mode": "company",
  "matches": [],
  "requirement_matches": [],
  "requirements_matrix": [],
  "fit_score": {
    "technical_fit": null,
    "experience_fit": null,
    "team_fit": null,
    "domain_fit": null,
    "certification_fit": null,
    "overall": null
  },
  "team_proposal": null,
  "knowledge_gaps": [],
  "knowledge_counts": {},
  "warnings": []
}
```

`team_proposal` is an object when team requirements are evaluated and may be `null`
when no team requirements are supplied. `tender_id` is copied from the request and
is present in the actual response. Supplied tender metadata such as `title`,
`deadline`, `language`, `source_url` and `estimated_budget` is also echoed in the
response and persisted in the tender inbox.

The `matches` contract must be preserved for downstream nodes:

```text
matches[].doc_id
matches[].type
matches[].similarity_score
matches[].summary
```

Additional match fields include `origin`, `evidence`, `matched_on` and the requirement
that the match supports.

#### Added fields (backward compatible)

These fields were added after live run 3. No existing field was removed or renamed, so current nodes keep working.

- `evidence.weak` (boolean, on every evidence object in `matches[]` and `requirement_matches[].matches[]`):
  `true` when no line of the document names the requirement; the quote is only the closest line.
- `evidence.note` (string, only when `weak` is `true`): what to check manually.
- `requirements_matrix[].evidence_weak`: the best document's `evidence.weak`, or `null` when the row has no match.
- `requirements_matrix[].note`: string or `null`. It explains an equivalent certificate ("Not enough holders of
  Professional Scrum Master (PSM): an equivalent certification is counted. Check it is accepted."), weak evidence,
  or words the rules matched but the reranker did not confirm.
- `requirements_matrix[].parsed.cert_groups`: present when a line mixes alternatives and required certificates
  ("PSM or CSM and PMP" -> `[["Professional Scrum Master (PSM)", "Certified Scrum Master (CSM)"], ["PMP"]]`): one
  certificate of each group is needed.
- `requirements_matrix[].parsed.any_cert`: present and `true` when one of the named certificates is enough
  ("PMP or PRINCE2", "PSM/CSM"); absent when all are needed ("PMP and PRINCE2").
- `matched_on` of a match that holds an equivalent certificate reads, for example, "Certified Scrum Master (CSM)
  instead of Professional Scrum Master (PSM): equivalent certification, check it is accepted".
- `POST /match` also returns `note` and `equivalent` (the documents that qualify only with an equivalent
  certificate, and why).

n8n can read `evidence_weak` and `note` instead of guessing from the quote text whether a justification is weak or a
certificate is only an equivalent. Do not quote weak evidence as proof in a proposal.

Certificate names changed: PSM, CSM, PSPO, CSPO and each Azure exam (AZ-900, AZ-104, AZ-305...) are separate
certificates, and "Scrum Master (PSM/CSM)", "Product Owner (PSPO/CSPO)" and "Azure Certified" are family names that
any member satisfies. Analyses already stored keep the old names until the tender is sent again.

### Evidence handling

- `origin: cv_document` means the result comes from a source CV and includes a document quote.
- `origin: user_entered` means a company knowledge record and includes a declaration, not a CV quote.
- `origin: demo` means fictional demo data and must not be presented as a company reference.
- A `closest` document in a requirement result is not an accepted match when the status is
  `missing`; it is provided for transparent review only.

### Status interpretation

Each row in `requirements_matrix` has:

- `covered`: enough qualifying evidence was found.
- `partial`: some evidence was found, but the requested count or constraint is not fulfilled.
  It is also used for an equivalent certificate (a CSM for "PSM certified") and for weak evidence; `note` says which.
- `missing`: no accepted internal evidence was found.

For example, `5 senior data engineers` must not be reported as covered when only two
qualifying CVs are returned.

### n8n node sequence

Recommended workflow:

```text
Trigger or tender source
  -> raw tender extraction
  -> normalize one tender into the request schema
  -> HTTP Request: POST /retrieve/tender
  -> inspect warnings, requirements_matrix and fit_score
  -> pass the complete response to proposal strategy/rendering
```

In the HTTP Request node:

1. Method: `POST`.
2. URL: `http://rag:8001/retrieve/tender`.
3. Authentication: none (the service is only on the compose network and 127.0.0.1).
4. Send body as JSON.
5. Header: `Content-Type: application/json`.
6. Set a reasonable timeout because the first API start may load models.

The `/retrieve/tender` call persists the original tender metadata and the latest
RAG response. The React tender list loads these stored tenders from
`GET /api/tenders`, so an n8n submission appears after refreshing the Tenders page.
The API stores the latest result per `tender_id`.

Additional endpoints:

```text
GET    /api/tenders
GET    /api/tenders/{tender_id}
DELETE /api/tenders               -> {"deleted": <count>}  empties the inbox
DELETE /api/tenders/{tender_id}   -> {"deleted": "<id>"}   or 404 "Tender not found"
```

A `tender_id` may contain `/`. The delete endpoints remove stored tenders and their analyses only; the knowledge
base and the indexes are not touched. The React Tenders page uses them for **Clear tenders** and the delete button
on each row. A deleted tender comes back the next time n8n sends it to `/retrieve/tender` with the same `tender_id`.

### Validation and edge cases

#### Incomplete tender

Send only the requirements that are known. The API returns warnings for omitted
categories and still evaluates the available requirements.

#### No internal match

```json
{
  "data_mode": "company",
  "requirements": {
    "technical": ["COBOL mainframe development"],
    "team": [],
    "experience": []
  }
}
```

Do not treat `closest` as evidence. The matrix should show `missing`.

#### Partial team match

The matrix and `team_proposal.unfilled` identify unmet headcount or role requirements.
Do not convert partial coverage into a successful bid automatically.

#### Missing prospect research

Keep unknown prospect fields empty and add a warning in the n8n flow. Do not fabricate
revenue, partners or past projects.

### Smoke test

From the host:

```bash
curl -X POST http://127.0.0.1:8001/retrieve/tender \
  -H 'Content-Type: application/json' \
  -d '{
    "tender_id": "HANDOFF-SMOKE-001",
    "client": "Smoke test buyer",
    "sector": "public",
    "data_mode": "company",
    "requirements": {
      "technical": ["Terraform"],
      "team": [],
      "experience": []
    }
  }'
```

The response must contain `matches`, `requirements_matrix`, `fit_score`,
`team_proposal`, `knowledge_gaps` and `warnings`.

For this smoke test, `team_proposal` may be `null`; that is valid because the
request has no team requirements.

### Verification commands

See [tests/README.md](../tests/README.md) (RAG tests, benchmark, web app build).
