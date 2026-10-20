# Evaluation report (Phase 2)

OliveSoft RFP Intelligence, CSTAM 3.0 challenge "Automated RFP Intelligence & Commercial Proposal Generation".
This report covers the RAG benchmark, the end-to-end runs of the packaged system, the quality of a generated deck, the
human-in-the-loop refinement, the test suite results, the coverage of the specification and the known limitations.
Every number below was measured on 2026-10-20 unless a different date is given.

Contents: [1. Scope and setup](#1-scope-and-setup) · [2. RAG benchmark](#2-rag-benchmark) ·
[3. End-to-end runs](#3-end-to-end-runs) · [4. Deck quality](#4-deck-quality) ·
[5. Human-in-the-loop refinement](#5-human-in-the-loop-refinement) · [6. Test suite results](#6-test-suite-results) ·
[7. Specification coverage](#7-specification-coverage) · [8. Known limitations](#8-known-limitations) ·
[9. How to reproduce](#9-how-to-reproduce)

## 1. Scope and setup

| Item | Value |
|---|---|
| Date | 2026-10-20 |
| Platform | Docker Compose on Windows 11 (Docker Desktop), the five containers of `docker-compose.yml` |
| Orchestration | n8n 2.41.3: our 4 workflows (RFP - Main, Scout Tools, Research Tools, Refine Slide) and the teammate's 9 deck-agent workflows |
| RAG models | `intfloat/multilingual-e5-small` embeddings, BM25, cross-encoder `mmarco-mMiniLMv2-L12-H384-v1`, rules (CPU) |
| LLM, main configuration | Main on a local Ollama `qwen3:4b-instruct` (`LLM_PROVIDER=ollama`); deck agents and refine on Groq `openai/gpt-oss-120b` (`DECK_LLM_PROVIDER=groq`) |
| LLM, second configuration | Groq `openai/gpt-oss-120b` for everything (`LLM_PROVIDER=groq`), run once |
| Tender source | the synthetic demo feed (6 tenders, fictional buyers marked "démo") for the packaged runs; real sources in earlier runs |
| Deck template | `template-1`, one of the 2 default OliveSoft templates shipped with the studio |

What is evaluated: retrieval and matching quality (section 2), whether one command runs the whole chain from detection
to an exported deck (3), what the deck looks like (4), the refine loop (5), and the automated tests (6).

## 2. RAG benchmark

Full method, labels and failure analysis: [rag-benchmark.md](rag-benchmark.md). The numbers below are from the full run
written to `services/rag/benchmark/results.md` on 2026-10-20 at 18:55, inside the `rag` container.

**Three test sets.** (1) 42 CV decision checks on the 19 real CVs (status covered / partial / missing, headcounts,
certificates, seniority). (2) A graded retrieval set: 42 labelled requirements (11 in French) and 6 negatives over the
company knowledge base (19 CVs, 37 projects, 5 tech stacks, 4 tools, 25 client records). (3) 39 real requirement lines
of 9 tenders, exactly as n8n sent them in live run 3. Labels were written from the documents before the systems were
run and are fingerprinted in `results.json`.

### 2.1 CV decision checks (42)

| Method | Passed |
|---|---|
| Similarity threshold (typical basic RAG, baseline) | 8 / 42 |
| Reranker only | 15 / 42 |
| **Rules + reranker (final system)** | **40 / 42** |

The two failures are negatives returned as partial: "Blockchain smart contracts (Solidity)" and "Microsoft Dynamics 365".
Ranking alone cannot tell "mentions project management" from "holds the PMP", or count three people; the rules can.

### 2.2 Retrieval quality (42 requirements + 6 negatives)

| System | nDCG@5 | P@3 | R@5 | MRR | Hit@1 | Median latency |
|---|---|---|---|---|---|---|
| BM25 only | 0.90 | 0.79 | 0.65 | 0.99 | 0.98 | 43 ms |
| Dense E5-small | 0.83 | 0.80 | 0.63 | 0.94 | 0.91 | 72 ms |
| Dense MiniLM-L6 | 0.77 | 0.68 | 0.56 | 0.90 | 0.83 | 57 ms |
| Hybrid (BM25 + E5) | 0.91 | 0.81 | 0.66 | 1.00 | 1.00 | 81 ms |
| Hybrid + reranker | 0.91 | 0.86 | 0.67 | 1.00 | 1.00 | 840 ms |
| **Final (rules + reranker)** | **0.90** | **0.81** | **0.62** | **1.00** | **1.00** | **1084 ms** |

The final system returns a decision set, not a fixed top 5: **set precision 0.95, set recall 0.73**, and it returns no
document for **5 of 6** requirements nobody can meet (false positive: N04). French nDCG@5 is 0.89 against 0.90 for
English. The final system trades some recall for precision on purpose: in a bid, a wrong claim costs more than a missing
one, and the gap report lists what is missing. Latency was measured in the container on CPU while the rest of the system
was running; about 1 s per requirement is acceptable for a batch pipeline.

### 2.3 Real tender requirements (39 lines, live run 3)

| Lines | Correct status | Company mode | Demo mode | Technical | Team | Experience |
|---|---|---|---|---|---|---|
| 39 | **30 / 39 (77 %)** | 5 / 9 | 25 / 30 | 21 / 26 | 6 / 9 | 3 / 4 |

1 over-claim (R07 "Financial capacity proof document", partial on weak evidence) and 8 under-claims (generic or French
lines such as "data restitutions", and team sizes such as "Minimum 3 senior developers" answered missing instead of
partial). 29 of 31 covered or partial rows cite a labelled proof document; 3 quote a fragment; 1 demo row cites a
fictional record although a CV proves the line.

**Limits.** One labeller who also built the system; small sets (49 queries, 39 real lines); development sets, not an
untouched holdout (the French-English glossary and the live-run fixes were made after seeing results); 30 of the 39 real
lines come from synthetic demo tenders.

## 3. End-to-end runs

Both runs used the packaged system (`docker compose up`), the demo tender feed, and Main started by hand from the n8n
editor. Each run went from detection to a deck in the studio without manual steps in between.

| | Run A: Groq for everything | Run B: Main on Ollama, decks on Groq |
|---|---|---|
| Tenders extracted / kept / fit | 18 / 6 / 4 | 18 / 6 / 5 (high or medium) |
| LLM analyses | 2 failed (Groq "too many requests") | all done |
| RAG calls OK | 4 | 4 |
| Market studies | all 4 failed (rate limit) | 3 done, 2 without comparable contracts |
| Proposal inputs sent to the studio | 4 | 5 |
| Failed calls | rate-limited LLM calls above | 0 |
| Deck | "Mise en place d'un assistant conversationnel IA (chatbot RAG) ..." | "Tableau de bord décisionnel des indicateurs de santé publique" (deck `d1733e9d`) |
| Deck agent steps | 6 / 6, Agent 5 `degraded` | 6 / 6 done (agent1, agent5, diagrams, agent4, reviewer, publish) |
| `[TO FILL]` placeholders | 3 | 2 |
| Deck tokens (Groq) | 25 070 | 25 707 (13 992 prompt, 11 715 completion) |
| Deck generation time | 172 s | 137 s (agent1 15 s, agent5 34 s, diagrams 25 s, agent4 45 s, finish 18 s) |

Times and token counts come from the studio's run records (`GET /api/generations`).

**What run A showed.** Groq's free tier allows about 8 000 tokens a minute. Main's analysis and market-study calls plus
the deck agents on the same key exceeded it, so 2 analyses and every market study failed. Two changes followed and are
in the packaged system: `DECK_LLM_PROVIDER` (the decks can use another LLM than Main) and pacing of Main's LLM calls
(`PIPELINE_LLM_DELAY_MS`, Groq default 15 s). Run B, with Main on a local model, had no failed call.

**Earlier development runs** (same code, a test n8n): with Gemini `models/gemini-3.1-flash-lite` a deck took 182 s
(Agent 5 degraded, 2 placeholders, 13 728 tokens), but Gemini also returned 503 "high demand" and was too slow for
refine; with Groq a deck took 132 s (Agent 1 in 5 s), 19 slides, 2 placeholders, 24 237 tokens. Real sources (BOAMP,
two portals through Firecrawl, buyer research on public registries) were run on 2026-10-19 and 2026-10-20 in a test n8n;
see [n8n-pipeline.md](n8n-pipeline.md#verified-vs-not-verified-2026-10-20).

**Export.** Deck `d1733e9d` exported from the studio's editor: PPTX, 18 slides, 489 KB, native editable objects
(text boxes, tables; the diagrams are pictures), in 5 s; PDF, 18 pages at 1440 x 810, 568 KB, in 4 s. Both files are in
[samples/](samples/): [sample-deck.pptx](samples/sample-deck.pptx), [sample-deck.pdf](samples/sample-deck.pdf).

## 4. Deck quality

The sample deck is deck `d1733e9d` of run B (demo tender, fictional buyer "Direction Régionale de la Santé de
Sampleville (démo)"), on OliveSoft template 1. Its 18 slides: title, contents, about OliveSoft, executive summary,
objectives, solution and compliance matrix (2 slides), technical architecture diagram, why OliveSoft, team, references,
implementation plan (Gantt), plan details, risks and mitigations, financial offer, support and quality, next steps,
closing slide with OliveSoft's offices.

| Title slide | Executive summary |
|---|---|
| ![Title slide](samples/sample-deck-p01-title.png) | ![Executive summary](samples/sample-deck-p04-context.png) |

![Implementation plan](samples/sample-deck-p12-plan.png)

What works:
- The OliveSoft template is applied throughout (logo, colours, background shapes, page numbers); the content is in French,
  the tender's language.
- The compliance matrix lists the tender's requirements with OliveSoft's answer and coverage from the RAG.
- Diagrams (architecture, Gantt plan) are generated from the tender by Agents 2+3. In the PPTX they are pictures; text
  and tables are native, editable objects.
- The financial offer is computed from the pricing catalogue, with a note that prices are estimates to be confirmed.
- The deck states unknowns instead of inventing them: the references slide keeps `[TO FILL]` because the RAG found no
  similar project for this demo tender, and the export dialog checks placeholders and pricing approval first.

What a reviewer must still fix (observed in the sample):
- 2 `[TO FILL]` placeholders on the references slide.
- The "Preuve" (proof) column of the compliance matrix reads "À préciser" on covered rows: the evidence found by the RAG
  is not carried into that column.
- Some text stays in English inside the French deck (requirement lines such as "1 project manager", the risk
  "Insufficient health sector experience", pricing items such as "app server month").
- The architecture diagram is drawn small on its slide and is hard to read at full-page size.
- On the financial offer slide, the one-time total in the note (28 420 EUR) is not the sum of the one-time lines shown
  (20 300 EUR plus 15 % support, 23 345 EUR). This slide was also the one used in the refine test (section 5); we did not
  establish whether the difference comes from the refine or from Agent 4. Prices need OliveSoft's approval before export
  in any case.

## 5. Human-in-the-loop refinement

Flow: web app deck page, **Refine with AI** (slide + instruction) → n8n "RFP - Refine Slide" → the teammate's "RFP 60
Regenerate" with the instruction → the studio saves the slide → the editor reopens. Contract:
[integration-and-api.md, section 4.4](integration-and-api.md#44-refine-with-ai).

| Test | Result |
|---|---|
| From the UI: "Rends cette diapositive plus concise" on "Offre financière" | slide rewritten and saved; the editor reopened with the new slide |
| Refine answer time with Groq | 10 to 20 s |
| Refine with Gemini | budget and diagram slides 15-17 s (OK); slides of Agents 1 and 5 exceeded the agents' 45 s per-stage limit (answered 504, slide unchanged) |
| Studio's own Regenerate button (RFP 60, no instruction) | 200 OK in tests |
| A refined slide with prices | by design the pricing approval is reset (node "Reset price approval"), so prices must be approved again before export; not measured separately |

Other human-in-the-loop points: every slide can be edited in the embedded editor; templates are uploaded, set as default
and deleted from the web app's Templates page (each tested: upload, set default, delete); the deck's language, project
type and template are chosen in the tender's Proposal tab before generation.

## 6. Test suite results

Commands from [tests/README.md](../tests/README.md), run from the repository root. All suites run inside Docker except
the two pipeline suites, which were run with Node 22 on the host (`cd n8n` first).

| Suite | Command | Result (2026-10-20) |
|---|---|---|
| Pipeline edge cases | `node test/edge_cases.js` | **223 cases, 223 pass, 0 known gaps** ([edge-cases.md](edge-cases.md)) |
| Studio adapter | `STUDIO_DIR=<path of services/proposal-studio> node test/studio_adapter.test.js` | **11 recorded proposal inputs, every check passed** |
| n8n packaging check | `docker compose build n8n` (runs `init.js check`) | passed (the image used for the runs built; the build fails otherwise) |
| RAG application tests | `docker compose run --rm --no-deps rag python -m pytest --deselect tests/test_review_fixes.py::test_tender_inbox_is_ignored_by_git` | **202 passed, 1 deselected, 1 warning** |
| RAG benchmark | `docker compose run --rm --no-deps rag python -m benchmark.run_benchmark --quick` | full run completed; `results.md` regenerated 2026-10-20T18:55 (section 2) |
| Web app | `docker compose build web` | `tsc -b` (strict TypeScript) and `vite build` pass |
| Proposal studio, Python (teammate) | `docker compose run --rm --no-deps -e RFP_FAST=1 proposal-studio python -m unittest discover tests` | **126 tests OK, 12 skipped** (`RFP_FAST=1` skips the slow browser tests) |
| Proposal studio, agents (teammate) | `docker compose run --rm --no-deps proposal-studio node --test agents/tests/` | **373 tests, 373 pass** |

The deselected RAG test checks the `.gitignore` of the repository the RAG came from, which does not exist in the
container. The warning is a Starlette deprecation notice from the test client.

## 7. Specification coverage

Items are those of the CSTAM book ([docs/competition/CSTAM-BOOK.pdf](competition/CSTAM-BOOK.pdf)).

| Item | Status | Evidence |
|---|---|---|
| **Phase 1** Tender detection | Done | API lane (BOAMP; TED configured), URL lane (Tender Scout Agent over portals through Firecrawl), demo feed; cleaning, deduplication, LLM analysis with verbatim quotes checked in code. Runs A and B (section 3); [n8n-pipeline.md](n8n-pipeline.md) |
| **Phase 1** RAG | Done | `services/rag`: hybrid search, reranker, rules; requirements matrix with quoted evidence; team builder; gap report. Section 2 |
| **Phase 1** Prospect research | Done, with a limit | Buyer Research Agent (company registry, BOAMP history, DECP awards, Wikidata, web search, buyer's site), facts kept only behind code checks; Prospect tab of the web app. Demo buyers are skipped, so the packaged demo runs show no buyer research |
| **Phase 1** n8n orchestration | Done | 13 workflows in one n8n: Main with 3 agents (scout, buyer research, competitor and budget), the 6 deck agents, Refine Slide; imported and published at start by `n8n/init/init.js` |
| **Phase 2** Generative deck with OliveSoft templates | Done | 6 deck agents in n8n; 2 default OliveSoft templates; deck `d1733e9d` (18 slides, section 4) |
| **Phase 2** RAG benchmark and report | Done | [rag-benchmark.md](rag-benchmark.md), section 2, the web app's Quality page |
| **Phase 2** Integration and API documentation | Done | [integration-and-api.md](integration-and-api.md) |
| **Phase 3** UI | Done | web app: tenders (leads), requirements and team (matched assets), Prospect and Market tabs, deck parameters and editor, export |
| **Phase 3** Edge cases | Done | 223 cases, 223 pass (section 6) |
| **Bonus** Multi-format export | Done | PPTX (editable) and PDF from the editor (section 3) |
| **Bonus** Requirements matrix and score | Done | RAG matrix per requirement with evidence; fit score; recommendation bid / bid_with_partner / no_bid / review |
| **Bonus** Competitor and budget agent | Done, with a limit | Competitor & Budget Agent on awarded-contract data (TED, DECP, TUNEPS): budget range, competitors, usual number of bids; shown in the web app's Market tab, not in the deck |
| **Bonus** Human-in-the-loop AI refinement | Done | Refine with AI on any agent slide (section 5) |
| **Bonus** Multi-source crawler | Done, with a limit | API sources by configuration, any website through the scout agent; real portals need a Firecrawl key |

## 8. Known limitations

- **Demo tenders have no buyer research.** The demo buyers are fictional and skipped on purpose; buyer research was
  verified on real tenders in earlier runs only.
- **Prices are estimates.** Agent 4 prices from a catalogue; OliveSoft must confirm them. The deck carries `[TO FILL]`
  and a pricing approval that the editor checks before export.
- **No competitor slide in the deck.** The market study (competitors, budget range) is shown in the web app's Market tab;
  the studio has no slide for it.
- **Free-tier LLM limits.** Groq's free tier allows about 8 000 tokens a minute and about 200 000 tokens a day per model;
  a deck uses about 25 000. With one key for everything, Main is slowed down by pacing and can still be rate limited
  (run A).
- **Slide indexes.** Regenerate and refine rely on the slide map of the generated deck; adding or moving slides in the
  editor can shift the indexes.
- **Real portals need Firecrawl.** Without `FIRECRAWL_KEY` the URL sources are off; the BOAMP API and the demo feed still
  run.
- **RAG under-claims some lines.** Team-size lines and generic or French wording come back missing where partial is
  right (real tender set 30 / 39, section 2.3).
- **Small local model as judge.** With `qwen3:4b-instruct`, about 1 fit decision in 8 was doubtful in earlier real runs;
  a stronger model for Main is advisable for production.
- **Deck review is still needed** (section 4): proof column, English fragments, diagram size, pricing total.

## 9. How to reproduce

1. Install Docker Desktop. `cp .env.example .env` and fill in `STUDIO_API_KEY`, `AGENTS_WEBHOOK_KEY` and the LLM settings.
   For run B: `LLM_PROVIDER=ollama` (Ollama running on the host with `qwen3:4b-instruct`), `DECK_LLM_PROVIDER=groq` and
   `GROQ_API_KEY`. For run A: `LLM_PROVIDER=groq`. Set `PIPELINE_DEMO_MODE=true`.
2. `docker compose up -d --build`, wait until `docker compose ps` shows the services healthy.
3. Open http://localhost:5679, create the n8n owner account, open **RFP - Main**, click **Execute workflow**. Read the
   counts in the last node, **Run Summary**.
4. Open http://localhost:5173: Tenders, then the best tender's Proposal tab (deck progress), then the deck. Try
   **Refine with AI** on one slide; export PPTX and PDF from the editor.
5. Deck runs, tokens and timings: `curl http://localhost:8091/api/generations`.
6. Tests and benchmark: the commands of section 6.
