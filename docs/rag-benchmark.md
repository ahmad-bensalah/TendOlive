# RAG benchmark

OliveSoft RFP Intelligence · Person 4 (RAG retrieval and benchmark) · 18 October 2026 · real tender set and live-run fixes 20 October 2026

Phase 2 item: *"RAG Benchmark & Retrieval Precision: benchmarking and optimizing semantic search accuracy to ensure
correct CV and project matching based on tender requirements."* Deliverables: benchmark, evaluation report (this file),
test-suite execution results (`test_results.txt`).

## 1. Summary

| Question | Answer |
|---|---|
| How good is the ranking? | Final system: **nDCG@5 0.90, MRR 1.00, P@3 0.81** on 42 labelled tender requirements (CVs, projects, stacks, tools) |
| How trustworthy are its decisions? | **95 % of the documents it accepts are relevant** (set precision); it rejects 5 of 6 requirements nobody can meet |
| Does it handle French tenders? | French nDCG@5 **0.89** (English 0.90) |
| Does it count people and check certificates? | **40/42** CV decision checks, against 8/42 for a similarity-threshold RAG and 15/42 for a reranker alone |
| Does it hold on real tender wording? | **30/39** lines sent by n8n in a live run get the right status (77 %, 28/39 before the live-run fixes); 1 Demo row still cites a fictional record first, 3 rows cite a fragment (see 5.3) |
| Is it fast enough? | Median **0.24 s** per requirement on a laptop CPU, so about 2.5 s for a 10-requirement tender |

## 2. What is measured

Three test sets, all versioned in `services/rag/benchmark/`:

| Set | File | Size | Measures |
|---|---|---|---|
| **Retrieval set** | `retrieval_set.json` | 49 queries: 42 labelled requirements (24 technical, 12 team, 6 experience; 11 in French) + 6 negatives | Ranking quality over the **Company knowledge base**: 19 CVs, 37 projects, 5 stacks, 4 tools (25 client records are indexed but not searched by these categories) |
| **CV decision checks** | `real_cvs.json` | 42 checks | Whether the decision is right: covered / partial / missing, headcounts ("at least 5 data engineers"), certificates (PMP, CKA…), seniority, documents allowed |
| **Real tender requirements** | `real_tenders.json` | 39 lines of 9 tenders, as n8n sent them in live run 3 (9 in Company mode, 30 in Demo mode) | Whether the status is right on real wording, whether the cited document is a labelled proof, whether its quote is a whole proof line, and whether Demo mode cites a real document when one qualifies |

**Labels.** Graded relevance: **2** = the document's work clearly delivers the requirement; **1** = passing mention
(skills list, ongoing project, related work). Labels were written from each document's text, before any system was run,
and are fingerprinted in `results.json` (`labels_sha256`, retrieval set `e123086bac08…`; line endings are ignored, so a
Windows checkout gives the same value).
Negatives are requirements with no relevant document (SAP S/4HANA, iOS/Swift, COBOL, blockchain, Cisco CCNP, Oracle EBS).

**Isolation.** Each benchmark builds its own index in `benchmark/.index/`; the application's indexes are not touched.

## 3. Systems compared (ablation)

| System | What it does |
|---|---|
| BM25 only | Keyword ranking (with French/English aliases from the vocabulary) |
| Dense E5-small | `intfloat/multilingual-e5-small` vectors, cosine similarity |
| Dense MiniLM-L6 | `all-MiniLM-L6-v2`, the model named in the team contract |
| Hybrid (BM25 + E5) | Both rankings fused with Reciprocal Rank Fusion |
| Hybrid + reranker | Cross-encoder `mmarco-mMiniLMv2-L12-H384` reorders the top 10 |
| **Final (rules + reranker)** | Production system: rules check skills, certificates, roles, seniority, headcount and sector; the reranker decides the rest; returns only the documents it accepts |

All systems search the same document types for a requirement (technical: CVs, projects, stacks, tools; team: CVs;
experience with a sector or "projects": completed projects).

## 4. Metrics

For ranked lists (positive queries; relevant = grade ≥ 1): **P@3** (share of the top 3 that is relevant), **R@5**
(share of relevant documents found in the top 5), **MRR** (1 / rank of the first relevant document), **nDCG@5**
(graded, position-aware; the BEIR standard metric family), **Hit@1**. For the final system, which returns a decision set:
**set precision** and **set recall**, and the **false-positive rate on negatives**. Latency is the median per requirement.
Metric code is unit-tested (`tests/test_benchmark_metrics.py`).

## 5. Results

### 5.1 Retrieval set (42 requirements + 6 negatives)

Run of 20 October 2026, after the live-run fixes (5.3). The final system's ranking is unchanged. Some baselines moved
by up to 0.05 because CV lines are now whole sentences; latency depends on the load of the machine.

| System | P@3 | R@5 | MRR | nDCG@5 | Hit@1 | Median latency |
|---|---|---|---|---|---|---|
| BM25 only | 0.79 | 0.65 | 0.99 | 0.90 | 0.98 | 12 ms |
| Dense E5-small | 0.80 | 0.63 | 0.94 | 0.83 | 0.91 | 34 ms |
| Dense MiniLM-L6 (contract model) | 0.68 | 0.56 | 0.90 | 0.77 | 0.83 | 20 ms |
| Hybrid (BM25 + E5) | 0.81 | 0.66 | 1.00 | 0.91 | 1.00 | 36 ms |
| Hybrid + reranker | 0.86 | 0.67 | 1.00 | 0.91 | 1.00 | 825 ms |
| **Final (rules + reranker)** | **0.81** | **0.62** | **1.00** | **0.90** | **1.00** | **237 ms** |

Final system as a decision: **set precision 0.95, set recall 0.73** (0.94 and 0.72 before the fixes: T20 "MuleSoft API
integration" no longer accepts two irrelevant documents, and T04, T05, T15 find more relevant ones); negatives with no
document returned: **5/6**.

nDCG@5 by category and language:

| System | Technical | Team | Experience | English | French |
|---|---|---|---|---|---|
| BM25 only | 0.88 | 0.96 | 0.86 | 0.92 | 0.86 |
| Dense E5-small | 0.86 | 0.79 | 0.84 | 0.86 | 0.75 |
| Dense MiniLM-L6 | 0.81 | 0.71 | 0.72 | 0.81 | 0.66 |
| Hybrid (BM25 + E5) | 0.90 | 0.91 | 0.91 | 0.91 | 0.90 |
| Hybrid + reranker | 0.90 | 0.94 | 0.91 | 0.94 | 0.84 |
| **Final (rules + reranker)** | **0.90** | **0.90** | **0.89** | **0.90** | **0.89** |

### 5.2 CV decision checks (42)

| Method | Passed |
|---|---|
| Similarity threshold (typical basic RAG) | 8 / 42 |
| Reranker only | 15 / 42 |
| **Rules + reranker (final)** | **40 / 42** |

The final system is unchanged by the fixes (the same two failures, see 7). The reranker-only baseline lost one check
("ISO 27001 lead auditor certification" is now partial in that comparison system only).

### 5.3 Real tender requirements (39 lines, n8n live run 3)

**Why this set exists.** The two sets above are clean lines written by hand in tender style, and the final system
scores 40/42 and nDCG@5 0.90 on them. The three live n8n runs (19-20 October 2026) sent real tender wording and
showed problems those sets do not measure: generic or translated lines ("data restitutions"), award criteria and
administrative items sent as requirements ("Financial capacity proof document"), certificates read as equivalent
(a CSM accepted for "PSM certified"), quotes that are a sentence fragment ("users by 35 % within six months." as
proof of "vector database"), and Demo answers citing a fictional record when a CV proves the line. This set keeps
the exact 39 lines of live run 3 as a regression set, so each fix is measured on the traffic that exposed it.

**Labels.** For each line: the expected status and the documents that prove it (grade 2 = clear proof, 1 = related
or passing proof), plus the words a quoted proof line must hold. They were written from the documents (CV PDFs
through the loader, JSON records; demo records only in Demo mode) before the run's answers were opened, and are
fingerprinted (`labels_sha256` `ce18de4c7e5d…`). The labelling rules are in the file: for example an award criterion
or an administrative document is `missing`, an equivalent certificate is `partial`, a count not reached is `partial`.

**Before and after the live-run fixes.** Each tender goes through `retrieve()`, the function behind
`POST /retrieve/tender`, on private indexes. *Before* is the code of live run 3; it gives the live run's answers
(`--recorded` on the n8n "Call RAG" output also scores 28/39). *After* is the code with the fixes merged
(20 October 2026): separate PSM / CSM certificates with equivalents as partial, proof lines that must name the
requirement, whole-sentence CV lines, record skills from title and description, real documents before demo records.
The labels were not changed (same fingerprint).

| Code | Correct status | Company | Demo | Technical | Team | Experience |
|---|---|---|---|---|---|---|
| Before (live run 3) | 28 / 39 (72 %) | 5 / 9 | 23 / 30 | 20 / 26 | 5 / 9 | 3 / 4 |
| **After the fixes** | **30 / 39 (77 %)** | 5 / 9 | 25 / 30 | 21 / 26 | 6 / 9 | 3 / 4 |

| Check | Before → after | What changed |
|---|---|---|
| Over-claims (more than the documents prove) | 2 → 1 | R38 "1 PSM certified Scrum Master": covered → partial; CV 14's CSM now counts as an equivalent, with a note |
| Under-claims | 9 → 8 | R22 "vector database": partial → covered; the quote is now CV 12's whole Pinecone sentence |
| Cited document is a labelled proof | 29 / 31 → 29 / 31 | unchanged (R03, R07) |
| Fragment proofs (quote under 4 words or without the line's terms) | 4 → 3 | R22 no longer quotes "users by 35 % within six months." |
| Demo over real (fictional record cited although a CV clearly proves the line) | 8 → 1 | Node.js / Java, PostgreSQL, RAG, Python, Power BI, Python pipelines and Azure now cite the CV first |

**Remaining errors (after).**
- 8 under-claims. "data restitutions" and the French image-analysis sentence are missing, and "data processing" is
  partial: the reranker scores this generic or French wording too low. "Minimum 3 / 5 senior developers" and
  "1 UX/UI designer" are missing although CV 14, CV 02 and CV 10 give partial evidence (role vocabulary).
  "respond in French and Arabic" and "1 chatbot or AI assistant project reference" stay partial although the demo
  telecom chatbot proves them.
- 3 fragment proofs. "statistical studies" and "Financial capacity proof document" quote a job-title line, because no
  line names them; the RAG now marks both as weak evidence with a note (`evidence_weak`), so neither can be covered.
  "Salesforce integration" is covered by the rules but quotes a skills line (Apex, LWC, SOQL) that does not name Salesforce.
- 1 over-claim on an administrative line: "Financial capacity proof document" is partial (weak evidence) where the
  label is missing, because the knowledge base holds no financial documents.
- "React or Angular" still cites the demo stack before a CV (the one demo-over-real row): the stack scores above the
  best CV by more than the "about the same" margin. The stack is a valid Demo proof, and the CVs are listed after it.

The per-line table of the run after the fixes (expected, got, cited document, notes) is in `results.md`.
New live-run lines must be added as new labels, never by editing these to fit.

## 6. Optimisation: what each design choice adds

| Choice | Evidence |
|---|---|
| **E5 instead of the contract's MiniLM** | nDCG@5 0.83 vs 0.77 overall and **0.75 vs 0.66 in French**; MiniLM is English-only |
| **Hybrid instead of a single retriever** | 0.91 vs 0.90 (BM25) and 0.83 (E5); French rises to 0.90, because BM25 aliases and multilingual vectors cover each other's misses |
| **Cross-encoder reranker** | Best top 3 (P@3 0.86; nDCG@5 0.91), at about 1 s per requirement |
| **Rules for counts, certificates, roles, seniority** | CV decisions 15/42 → **40/42**: ranking alone cannot tell "talks about project management" from "holds the PMP", or count three people |
| **Decision set instead of a fixed top-k** | The final system returns nothing for 5 of 6 impossible requirements, where every ranking system always returns 5 documents; 95 % of what it accepts is relevant |
| **French–English glossary for unknown words** (added after the first run, see 7) | Final system, French nDCG@5 0.73 → **0.89**, experience 0.77 → **0.89**, set precision 0.89 → **0.94**; CV checks unchanged (40/42) |

**Trade-off.** The final system favours precision over recall (set recall 0.73; R@5 0.62 vs 0.67 for the
reranker alone): it proposes fewer documents but almost all are correct. For a bid, a wrong claim costs more than a
missing one, and the knowledge-gap report lists what is missing.

## 7. Failure analysis

| Case | What happens | Cause | Status |
|---|---|---|---|
| "Blockchain smart contracts" (negative), "Blockchain… (Solidity)", "Microsoft Dynamics 365" (CV checks) | Returned as *partial* | Reranker score above the floor, and some unknown words ("smart", "contracts") occur in unrelated text | Known; reported in both benchmarks |
| First run: "Streaming temps réel avec Kafka", "Références… mode et luxe" returned nothing | Rules found the right documents, then rejected them | French words unknown to the vocabulary were required to appear in English documents | **Fixed** with the glossary; found on this set, so these two queries are no longer independent evidence |
| "DevOps engineer with Kubernetes" returns 1 person (labels: 2 core, 5 related) | Only CVs with the DevOps role qualify | A "cloud infrastructure engineer" is not read as DevOps | Open: role vocabulary |
| Reranker latency | ~1 s per requirement for 10 candidates | Cross-encoder on CPU | Acceptable for weekly batches; a GPU or fewer candidates would cut it |
| Real tender wording (5.3): fragment quotes, CSM accepted for PSM, demo record cited before a qualifying CV | Live run 3: 28/39 lines right; 4 fragment proofs; 8 demo-over-real rows | Evidence line picked without checking it names the requirement; PSM and CSM were one certificate; best document chosen by score only | **Mostly fixed** (proof lines must name the requirement, else weak evidence; certificate families with equivalents as partial; whole-sentence CV lines; real documents first): 30/39, fragment proofs 4 → 3 (two now flagged weak), demo-over-real rows 8 → 1 |
| Real tender wording (5.3): generic or French lines ("data restitutions"), senior developers and UX/UI roles, an administrative line | 8 under-claims, 1 over-claim ("Financial capacity proof document" partial on weak evidence) | Reranker cut-off on untranslated or generic wording; role vocabulary; administrative items sent as requirements | Open; measured by `real_tenders.json` |

## 8. Limits (threats to validity)

- **One labeller**, who also built the system; labels should be reviewed by a second person (an OliveSoft mentor).
- **Small set** (49 queries, one knowledge base); confidence intervals would be wide.
- **Development set, not a holdout**: one fix (the glossary) was made after seeing results on it.
- Part of the knowledge base (company projects) was derived from the same CVs, which makes CV and project evidence correlated.
- **Few real tenders**: the retrieval set and the CV checks were written by hand in tender style. The real tender set
  (5.3) adds 39 lines of one live n8n run; 30 of them come from synthetic demo tenders, and its labels have one author.
  The live-run fixes were designed from the problems this run showed, so its 30/39 is not independent evidence.
  Add the lines of later live runs to it, labelled the same way before their answers are read.

## 9. Reproduce

In the `rag` container (results are written in `benchmark/` inside the container; the shipped `results.json`,
`results.md` and `test_results.txt` in `services/rag/benchmark/` are the reference run shown on the web app's
Quality page):

```bash
docker compose run --rm --no-deps rag python -m benchmark.run_benchmark --quick    # CV checks + retrieval + real tenders
docker compose run --rm --no-deps rag python -m benchmark.retrieval_eval           # retrieval benchmark only
docker compose run --rm --no-deps rag python -m benchmark.real_tenders             # real tender requirements only
docker compose run --rm --no-deps rag python -m pytest                             # application tests
```

`python -m benchmark.real_tenders --recorded Call_RAG.json` scores answers recorded by n8n without writing anything.

## 10. The three parts in short

The benchmark has three parts, each on its own isolated index:
- 42 CV decision checks (covered/partial/missing, headcounts, certificates), comparing a similarity threshold,
  the reranker alone and rules + reranker;
- a graded retrieval set of 49 tender requirements (11 in French, 6 negatives) over the Company knowledge base,
  comparing BM25, dense E5, dense MiniLM, hybrid, hybrid + reranker and the final system with P@3, R@5, MRR, nDCG@5;
- 39 real tender lines (9 tenders) as n8n sent them in live run 3, in Company and Demo mode, checking the status,
  the cited document, fragment quotes and demo records cited before a CV.
`run_benchmark` runs all three (`--no-real-tenders` skips the third); `python -m benchmark.real_tenders` runs only
the third, and `--recorded FILE` scores answers recorded by n8n without writing anything.
It is a development set, not an untouched holdout.
Known failures are shown honestly. Application tests are displayed separately from benchmark scores.
