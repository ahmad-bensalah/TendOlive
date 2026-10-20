# RAG Knowledge Retrieval & Benchmark: progress notes

Person 4 (Dali) · CSTAM 3.0 · OliveSoft challenge · Status on 16 October 2026

How to use this file: each "Slide" section is one Canva slide.
"Say" lines are speaker notes. "Screenshot" says which image to put on the slide.
The screenshot checklist is at the end.

---

## Slide 1: Title

**RAG Knowledge Retrieval & Benchmark**
Matching tender requirements to OliveSoft's people, projects and technology stacks.
Person 4 (Dali), CSTAM 3.0, OliveSoft challenge.

---

## Slide 2: My place in the pipeline

```text
n8n trigger (P1) -> Tender extraction (P2) -> RAG retrieval (P4, me) -> Proposal (P5)
                                           \-> Prospect research (P3) -/
```

- **Input:** the requirements Person 2 extracts (technical, team, experience), plus client and sector.
- **Output:** the best matching CVs, projects and technology stacks for Person 5, with evidence and a score.
- **Connection:** n8n calls my service with `POST /retrieve/tender` on port 8001.

---

## Slide 3: What the team contract asked

From `team-tasks.pdf`, Person 4:

- Index CVs, past projects and technology stacks in a vector database.
- For each tender: query embedding -> vector search -> top-k chunks -> relevance rerank.
- Return `matches` (`doc_id`, `type`, `similarity_score`, `summary`) and `benchmark_context`.

**Status: built.** The contract fields are kept, so Person 5 and n8n can use the output as agreed.

---

## Slide 4: How matching works (5 steps)

1. **Read** the requirement. A rule parser finds skills, certifications, roles, seniority,
   headcount ("at least 3"), sector, "and / or", and mandatory vs preferred. French and English.
2. **Filter.** Keep only documents that meet the hard constraints.
   Example: only PMP holders can answer a PMP requirement.
3. **Rank.** Hybrid search: BM25 keywords + dense vectors, fused with Reciprocal Rank Fusion (RRF).
4. **Decide.** Rules decide when the requirement is fully understood.
   Otherwise a cross-encoder reranker checks the top candidates.
5. **Prove.** Pick the exact line of the source document as evidence.

| Part | Choice |
|---|---|
| Embeddings | `intfloat/multilingual-e5-small` (French + English) |
| Vector database | ChromaDB (local) |
| Keyword search | BM25 |
| Fusion | Reciprocal Rank Fusion |
| Reranker | `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1` (multilingual) |
| Chunks | 200 words, 50 words overlap (as in the contract) |
| API | FastAPI |
| Cost | No paid AI API. Runs offline after the first model download. |

Vocabulary used by the rules: 91 skills, 27 certifications, 22 roles, 8 sectors, each with French and English names.

Say: "Plain vector search finds similar text. It cannot count people or check a certificate. The rules do that."

---

## Slide 5: What the service returns

For each tender:

- **Matches:** the contract fields, plus title, evidence and origin.
- **Requirements matrix:** for each requirement, covered / partial / missing,
  found vs needed (for example 8 found / 3 needed data engineers), best document and evidence quote.
- **Fit score (0-100):** technical, team, experience, domain, certification and overall.
  These are the same keys as the fit-score object in Person 5's input.
- **Warnings:** BLOCKING when a mandatory requirement has no evidence, plus optional gaps,
  partial coverage and unknown sectors.

Example: data-platform tender, Company mode.
7 covered, 0 partial, 3 missing. Overall 43%.
Technical 89, team 75, certification 50, experience 0, domain 0.

Say: "The score is recorded coverage. It is not a probability of winning."

Screenshot: the Tender matching screen with the 4 KPI cards and the requirement table
(take a new screenshot from the dashboard).

---

## Slide 6: Evidence and honesty

- Every CV match carries a quote and its line number from the CV.
- Every match is labelled: **CV document**, **user declaration** or **demo (fictional) record**.
  Declarations are never shown as document quotes.
- Certifications are read only from the Certifications section of a CV.
  A CV that talks about ISO 27001 projects does not make the person certified.
  Structured records cannot grant certifications.
- When nothing qualifies, the closest document is shown separately as "not a qualifying match".
- Preferred (optional) requirements count half in the score.

Screenshot: one requirement opened, showing the matching CVs and the quote.

---

## Slide 7: Knowledge base and data modes

- **19 CVs (PDF)** with fake names and placeholder contacts. Read-only.
- **Structured records:** projects, technology stacks and clients, entered with guided forms
  (Save draft or Save and index).
- **Company mode (default):** CVs + records entered by the company.
- **Demo mode:** CVs + fictional sample data: 11 projects (10 indexed, 1 draft), 4 stacks, 12 clients.
- Each mode has its own index. A rebuild is atomic: if it fails, the previous index keeps working.
- **PDF repair:** fixes broken text in the LaTeX-made CVs (accents, ligatures, split words).

Screenshot: Knowledge base, People tab (CV profiles: role, seniority, skills, certifications).
Screenshot: the Add record form.

---

## Slide 8: Dashboard

Three screens:

1. **Tender matching:** type requirements, paste a tender JSON or pick an example. Choose the mode.
   See coverage, the requirement review, evidence, and Export JSON / Export CSV.
2. **Knowledge base:** People, Projects, Technology stacks, Clients. Add, edit and index records.
3. **Evaluation:** run the benchmark and the application tests from the browser.

Also: dark theme, one-command start (`docker compose up`), and interactive API docs at `/docs`.

---

## Slide 9: Benchmark

42 checks on the 19 CVs: 16 "covered", 11 "found", 2 "partial", and 13 "missing".
The "missing" checks are skills nobody has (SAP, iOS, COBOL...).

| Method | Passed |
|---|---|
| Similarity threshold (basic RAG) | 8 / 42 |
| Reranker only | 17 / 42 |
| **Rules + reranker (final)** | **40 / 42** |

Say: "A basic vector-similarity RAG passes 8 of 42. Adding rules and a reranker brings it to 40."

The 2 failures: "Blockchain smart contracts (Solidity)" and "Microsoft Dynamics 365".
Nobody has them, but the system returned "partial" instead of "missing". They are reported, not hidden.

Limits (say them):

- These are regression checks, not an untouched holdout set.
- They cover CVs only, not projects and stacks yet.
- The result is pass/fail per check. There is no precision@k, recall or MRR yet.

Screenshot: Evaluation screen with the benchmark table.

---

## Slide 10: Tests and edge cases

**59 automated tests passed** (last run 12 October 2026):
11 API and dashboard, 30 parsing and end-to-end, 9 real-CV reading, 9 records and modes.

Edge cases handled:

- empty tender, blank lines, text instead of a list
- a missing category: excluded from the score, with a warning
- an unknown sector: warning
- a broken or scanned PDF: skipped
- a failed index rebuild: the old index stays active
- a mandatory requirement with no evidence: BLOCKING warning

Screenshot: Evaluation screen, application tests (or the terminal with "59 passed").

---

## Slide 11: Work beyond the contract

| Extra | Why it matters |
|---|---|
| Requirements matrix + fit score | Matches the bonus "Automated Requirements Matrix & Score" (+2). Feeds Person 5 directly. |
| Hybrid search + reranker + rules | 40 / 42 instead of 8 / 42 |
| Evidence quotes + provenance labels | Every claim can be checked |
| Company / Demo modes + guided forms | Real company data stays separate from fictional data |
| Dashboard with 3 screens + CSV/JSON export | Head start on Phase 3 (UI/UX) |
| Benchmark and tests runnable from the dashboard | Supports the Phase 2 deliverable |
| French + English | Tunisian and French tenders |
| PDF text repair | The real CVs become readable |
| Offline, no paid API | Low cost, works without internet after setup |

---

## Slide 12: Phase 2 checklist (RAG side)

| Phase 2 item | Status |
|---|---|
| RAG Benchmark & Retrieval Precision (10 pts) | Built for CVs: 40 / 42. To add: projects and stacks, standard metrics. |
| Edge Case & Data Validation (5 pts) | Built and tested on the RAG side. |
| Proposal output (15 pts) | Person 5. The RAG supplies the input JSON. |
| Deliverable: benchmark, evaluation report, test results | `results.md` and `test_results.txt` exist. The full evaluation report is still to write. |
| Deliverable: integration & API documentation | README, ARCHITECTURE, `/docs`. The n8n documentation is still short. |

---

## Slide 13: Known gaps and next steps (not built yet)

1. **n8n wiring:** the "Call RAG" node's output is not connected to anything yet,
   so results are not saved or sent to Person 5. To do with Person 1.
2. **No real project records:** Company mode has none, so through n8n, project-based experience
   and domain fit are 0. Options: enter real OliveSoft records, or send `data_mode: "demo"` for the demo.
3. **PMP project manager:** reported missing although CV_17 holds the PMP. His title,
   "Strategic Managing Partner", is not read as "project manager".
4. **Benchmark:** add projects and stacks, add precision@k / recall / MRR, and fix or explain the 2 failures.
5. **Evaluation report:** write it (method, metrics, failures, limits).
6. **Re-run:** run the tests and the benchmark again before submission.

---

## Slide 14: Live demo plan (optional)

1. Open the dashboard. Pick the "tender data platform" example, Company mode, and click Match requirements.
2. Click "At least 3 data engineers": 8 found, with quotes.
3. Switch to Demo mode and pick "tender requirements" (public sector tender):
   public-sector projects should appear, labelled as demo records.
4. Open the Evaluation screen: the benchmark table.
5. Open `/docs` and run `POST /retrieve/tender`.

---

## Screenshot checklist

| # | Screen | How to get it | Slide |
|---|---|---|---|
| 1 | Tender matching, Company mode, "tender data platform", with results | Take from the dashboard | 5 |
| 2 | One requirement opened, with matching CVs and quotes | Click "At least 3 data engineers" | 6 |
| 3 | Same screen in Demo mode, with project and stack matches | Data mode = Demo, example "tender requirements" | 7 |
| 4 | Knowledge base, People tab | Knowledge base -> People | 7 |
| 5 | Add record form | Knowledge base -> Projects -> Add record | 7 |
| 6 | Limitations and gaps box (BLOCKING warning) | Bottom of the results | 6 |
| 7 | Evaluation, benchmark table | Evaluation -> Run benchmark (or last results) | 9 |
| 8 | Evaluation, application tests | Evaluation -> Run application tests | 10 |
| 9 | Exported CSV in a spreadsheet | Export CSV, open it | 5 |
| 10 | API docs | http://127.0.0.1:8001/docs | 8 |
| 11 | n8n: Build RAG Payload -> Call RAG nodes | n8n editor | 2 |
