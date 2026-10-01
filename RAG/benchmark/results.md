# RAG Retrieval Benchmark

Knowledge bases: parts 1-3 use the OliveSoft mock data (16 CVs, 11 past projects, 4 tech stacks, client portfolio); part 4 uses the sample OliveSoft CVs (PDF). Each has its own index.
Test sets: 40 labeled queries (English + French), 17 requirements OliveSoft does not meet, 19 hard constraint tests, 20 unseen requirements, 42 checks on the real CVs.

## Summary

- Ranking (Hit@1 / Recall@3): dense only 100% / 93%, hybrid + rules 100% / 98%.
- Coverage decisions: accuracy goes from 75% (similarity threshold) to 100% (final system).
- Hard constraint tests passed: 3/19 (baseline) -> 19/19 (final).
- Unseen requirements (never used for tuning): 12/20 (baseline) -> 20/20 (final).
- Real PDF CVs (19 sample OliveSoft CVs): 8/42 (baseline) -> 40/42 (final).

## 1. Embedding model (dense search only)

| Model | Hit@1 | Recall@3 | MRR | Hit@1 EN | Hit@1 FR | ms/query |
|---|---|---|---|---|---|---|
| sentence-transformers/all-MiniLM-L6-v2 | 93% | 91% | 0.96 | 92% | 93% | 16 |
| sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2 | 93% | 88% | 0.96 | 92% | 93% | 26 |
| intfloat/multilingual-e5-small | 100% | 93% | 1.00 | 100% | 100% | 24 |
| BAAI/bge-m3 | 98% | 94% | 0.99 | 96% | 100% | 165 |

Chosen: `intfloat/multilingual-e5-small` (best Hit@1, strong in English and French). About 7x faster than bge-m3 on CPU.

## 2. Ablation: adding one step at a time (intfloat/multilingual-e5-small)

| Retrieval | Hit@1 | Recall@3 | MRR | Hit@1 FR | ms/query |
|---|---|---|---|---|---|
| Dense vectors only | 100% | 93% | 1.00 | 100% | 304 |
| BM25 keywords only | 90% | 98% | 0.95 | 87% | 84 |
| Hybrid (BM25 + dense, RRF) | 100% | 96% | 1.00 | 100% | 423 |
| Hybrid + structured rules | 100% | 98% | 1.00 | 100% | 152 |

## 3a. Coverage check: does the system know what OliveSoft has?

40 requirements OliveSoft meets should be found; 17 it does not meet (blockchain, COBOL, Salesforce...) should be marked missing.

| Decision method | Found | Rejected | Accuracy |
|---|---|---|---|
| Similarity threshold (baseline) | 100% | 18% | 75% |
| Reranker only | 100% | 94% | 98% |
| Rules + reranker (final) | 100% | 100% | 100% |

## 3b. Hard constraint tests

A test passes only if the status is right, no wrong person or project is proposed, and the count is met.

| Decision method | Passed |
|---|---|
| Similarity threshold (baseline) | 3/19 |
| Reranker only | 9/19 |
| Rules + reranker (final) | 19/19 |

Final system, test by test:

| Requirement | Expected | Got | Method | Pass | Why this test matters |
|---|---|---|---|---|---|
| 1 project manager PMP certified | covered | covered | rules | yes | Hana is a Scrum Master without PMP; she must not be proposed |
| Chef de projet certifie PRINCE2 | covered | covered | rules | yes | French wording + certification |
| 1 Scrum Master PSM certified | covered | covered | rules | yes | exact certification |
| Minimum 3 senior developers | covered | covered | rules | yes | count + seniority; the junior PHP developer must not count |
| Minimum 5 senior developers | partial | partial | rules | yes | only 4 senior developers exist |
| Senior PHP developer | missing | missing | rules | yes | the only PHP developer is junior |
| Senior iOS Swift developer | missing | missing | rules+reranker | yes | senior web developers exist, but nobody knows iOS or Swift |
| 2 formateurs certifies en intelligence artificielle | partial | partial | rules | yes | only one AI trainer |
| ISO 27001 lead auditor | covered | covered | rules+reranker | yes | certification held by one person only |
| AWS certified engineer | covered | covered | rules | yes | Ahmed uses AWS but is not certified |
| 1 data engineer | covered | covered | rules | yes | role match |
| Kubernetes and Terraform | covered | covered | rules | yes | AND: both skills needed |
| React and Flutter | missing | missing | rules | yes | AND: nobody has both |
| Salesforce CRM integration | missing | missing | reranker | yes | not in the knowledge base |
| Solidity smart contracts | missing | missing | reranker | yes | not in the knowledge base |
| 3+ public sector projects | covered | covered | rules | yes | count of public projects |
| 2+ projects in the health sector | partial | partial | rules | yes | only one health project |
| Experience in the tourism sector | covered | covered | rules | yes | sector match |
| Blockchain supply-chain traceability for a port authority | missing | missing | reranker | yes | not in the knowledge base |

## 3c. Unseen requirements

Written after the system was built and never used to tune it: 10 things OliveSoft has,
10 it does not have. Correct = found when we have it, missing when we do not.

| Decision method | Correct |
|---|---|
| Similarity threshold (baseline) | 12/20 |
| Reranker only | 16/20 |
| Rules + reranker (final) | 20/20 |

Final system mistakes: none

## 4. Real CVs: 19 sample OliveSoft CVs (PDF)

PDF CVs made with LaTeX, with sections (Profile, Professional Experience, Skills, Certifications and Awards) and no labelled fields. The system must read the job title, the years of experience and the certifications from the layout.

A check passes only if the status is right, no wrong person is proposed, and the count is met. "found" means covered or partial.

| Decision method | Passed |
|---|---|
| Similarity threshold (baseline) | 8/42 |
| Reranker only | 17/42 |
| Rules + reranker (final) | 40/42 |

Final system, check by check:

| Requirement | Expected | Got | Method | Found | Pass | Why this check matters |
|---|---|---|---|---|---|---|
| PMP certification | covered | covered | rules | 1 | yes | one person holds the PMP |
| Certified Kubernetes Administrator (CKA) | covered | covered | rules | 1 | yes | many people use Kubernetes, 1 holds the certificate |
| AWS Solutions Architect certification | covered | covered | rules | 2 | yes | two holders, nobody else |
| Google Cloud Professional Data Engineer certification | covered | covered | rules | 3 | yes | CV 18 only has Google Cloud course certificates |
| Power BI Data Analyst certification (PL-300) | covered | covered | rules | 2 | yes | many people use Power BI, 2 are certified |
| Certified Scrum Master | covered | covered | rules | 1 | yes | CV 12 lists Scrum Master as a skill only; CV 19 has Scrum Fundamentals |
| Certified Salesforce administrator | found | covered | rules | 1 | yes | CV 08 is Salesforce-certified as a developer, not as an administrator |
| Databricks certified data engineer | covered | covered | rules | 1 | yes | several people use Databricks, 1 is certified |
| Azure Data Engineer Associate certification | covered | covered | rules | 2 | yes | the certificate is written in two different ways |
| TOGAF certification | covered | covered | rules | 1 | yes | written 'TOGAF 9 Certified - 2020' |
| At least 5 data engineers | covered | covered | rules | 8 | yes | count people by their current job title |
| 3 senior data engineers | partial | partial | rules | 1 | yes | only the team lead is senior; the others have 0 to 3 years |
| Junior data engineer | covered | covered | rules | 4 | yes | years counted from the job dates when the CV does not say them |
| 1 Salesforce developer | covered | covered | rules | 1 | yes | the product owner and the data engineers who know Salesforce are not developers |
| 2 product owners | covered | covered | rules | 2 | yes | role read from the current job |
| 1 business analyst | covered | covered | rules | 1 | yes | CV 12 was a business analyst in 2023, now a product owner |
| 1 DevOps engineer | covered | covered | rules | 1 | yes | CV 14 was a DevOps engineer before, he is a delivery manager now |
| Senior delivery manager | covered | covered | rules | 1 | yes | CV 04 is a delivery manager with 3 years: not senior |
| 2 BI consultants | partial | partial | rules | 1 | yes | only one BI consultant: found 1 of 2 |
| Apache Airflow orchestration | found | covered | rules+reranker | 2 | yes | several people |
| Kafka streaming pipelines | found | covered | rules+reranker | 3 | yes | several people |
| Talend ETL jobs | found | covered | rules+reranker | 3 | yes | several people |
| Microsoft Fabric | found | covered | rules | 2 | yes | 2 people |
| LangChain RAG assistant | found | covered | rules+reranker | 2 | yes | a few people |
| Terraform infrastructure as code | found | covered | rules | 6 | yes | several people |
| Snowflake data warehouse | found | covered | rules | 4 | yes | 4 people |
| Looker dashboards | found | covered | rules | 5 | yes | a Power BI dashboard is not a Looker dashboard |
| ETL tools | found | covered | rules | 11 | yes | Talend, SSIS, NiFi, Azure Data Factory... are ETL tools even when 'ETL' is not written |
| Salesforce CRM | found | covered | rules+reranker | 3 | yes | a few people |
| SAP S/4HANA consultant | missing | missing | reranker | 0 | yes | nobody |
| iOS Swift mobile developer | missing | missing | rules+reranker | 0 | yes | two people built a mobile app, none with iOS or Swift |
| Blockchain smart contracts (Solidity) | missing | partial | reranker | 1 | NO | nobody |
| Cisco CCNP network engineer | missing | missing | rules | 0 | yes | nobody |
| Oracle E-Business Suite | missing | missing | reranker | 0 | yes | nobody |
| ISO 27001 lead auditor certification | missing | missing | reranker | 0 | yes | CV 18 mentions ISO 27001 work, but nobody holds the certificate |
| COBOL mainframe developer | missing | missing | rules+reranker | 0 | yes | nobody |
| Flutter mobile app | missing | missing | rules | 0 | yes | mobile apps exist, but not with Flutter |
| PRINCE2 certified project manager | missing | missing | rules | 0 | yes | nobody |
| Angular frontend developer | missing | missing | rules | 0 | yes | the web developer uses PHP and jQuery |
| Microsoft Dynamics 365 | missing | partial | reranker | 1 | NO | CV 12 has Microsoft 365, which is a different product |
| Qlik Sense dashboards | missing | missing | rules+reranker | 0 | yes | many dashboards, none in Qlik |
| Kotlin Android developer | missing | missing | rules+reranker | 0 | yes | nobody |

## Misses (first result wrong)

**Dense vectors only**: 0
**BM25 keywords only**: 4
- `Previous public sector digital projects` -> `Project_University_AITraining.md`
- `Licensing platform for a government ministry` -> `Project_University_AITraining.md`
- `Acquisition de materiels informatiques en plusieurs lots pour un ministere` -> `Project_University_AITraining.md`
- `Portail de services en ligne pour une municipalite` -> `Project_University_AITraining.md`
**Hybrid (BM25 + dense, RRF)**: 0
**Hybrid + structured rules**: 0

## Limits

- Mock data written by the team; real documents will be noisier.
- The has / has-not set and the hard cases include a few cases added after we saw them fail
  (iOS Swift, SAP, Oracle EBS), so their scores are optimistic. The unseen set (3c) is the honest number.
- The fit score measures coverage (do we have proof?), not quality: a requirement met by rules scores 100.
- The rules depend on the vocabulary in `rag/taxonomy.py`; unknown terms fall back to the reranker.
- Part 4 was written after we added the vocabulary of these CVs (skills, roles, certifications),
  so it shows that the system reads real PDF CVs, not that it handles unseen words.
- Test sets are small; the next step is 100+ queries checked by hand.
