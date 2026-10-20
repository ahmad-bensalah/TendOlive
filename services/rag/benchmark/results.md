# Authoritative PDF CV benchmark

Run: 2026-10-20T09:57:37+01:00 | Corpus: C:\Users\yassin\Desktop\Workspace\win2win\CSTAM v2\CSTAM\data\cvs
Documents: 19 | Checks: 42
CV document IDs keep the CV_NN prefix; source filenames are unchanged.

This run tests CV matching only. No mock employees, company projects, stacks or clients are indexed.
Old mixed-corpus datasets and results have been deleted.

| Method | Passed |
|---|---|
| Similarity threshold (baseline) | 8/42 |
| Reranker only | 15/42 |
| Rules + reranker (final) | 40/42 |

## Final system checks

| Requirement | Expected | Got | Found | Pass |
|---|---|---|---|---|
| PMP certification | covered | covered | 1 | yes |
| Certified Kubernetes Administrator (CKA) | covered | covered | 1 | yes |
| AWS Solutions Architect certification | covered | covered | 2 | yes |
| Google Cloud Professional Data Engineer certification | covered | covered | 3 | yes |
| Power BI Data Analyst certification (PL-300) | covered | covered | 2 | yes |
| Certified Scrum Master | covered | covered | 1 | yes |
| Certified Salesforce administrator | found | covered | 1 | yes |
| Databricks certified data engineer | covered | covered | 1 | yes |
| Azure Data Engineer Associate certification | covered | covered | 2 | yes |
| TOGAF certification | covered | covered | 1 | yes |
| At least 5 data engineers | covered | covered | 8 | yes |
| 3 senior data engineers | partial | partial | 1 | yes |
| Junior data engineer | covered | covered | 4 | yes |
| 1 Salesforce developer | covered | covered | 1 | yes |
| 2 product owners | covered | covered | 2 | yes |
| 1 business analyst | covered | covered | 1 | yes |
| 1 DevOps engineer | covered | covered | 1 | yes |
| Senior delivery manager | covered | covered | 1 | yes |
| 2 BI consultants | partial | partial | 1 | yes |
| Apache Airflow orchestration | found | covered | 2 | yes |
| Kafka streaming pipelines | found | covered | 3 | yes |
| Talend ETL jobs | found | covered | 3 | yes |
| Microsoft Fabric | found | covered | 2 | yes |
| LangChain RAG assistant | found | covered | 2 | yes |
| Terraform infrastructure as code | found | covered | 6 | yes |
| Snowflake data warehouse | found | covered | 4 | yes |
| Looker dashboards | found | covered | 5 | yes |
| ETL tools | found | covered | 11 | yes |
| Salesforce CRM | found | covered | 3 | yes |
| SAP S/4HANA consultant | missing | missing | 0 | yes |
| iOS Swift mobile developer | missing | missing | 0 | yes |
| Blockchain smart contracts (Solidity) | missing | partial | 1 | NO |
| Cisco CCNP network engineer | missing | missing | 0 | yes |
| Oracle E-Business Suite | missing | missing | 0 | yes |
| ISO 27001 lead auditor certification | missing | missing | 0 | yes |
| COBOL mainframe developer | missing | missing | 0 | yes |
| Flutter mobile app | missing | missing | 0 | yes |
| PRINCE2 certified project manager | missing | missing | 0 | yes |
| Angular frontend developer | missing | missing | 0 | yes |
| Microsoft Dynamics 365 | missing | partial | 1 | NO |
| Qlik Sense dashboards | missing | missing | 0 | yes |
| Kotlin Android developer | missing | missing | 0 | yes |

## Limits

These are existing regression checks, not an untouched holdout set.
A passing check validates its status, allowed returned documents where labelled, and minimum count.
It does not establish complete retrieval recall or that each quote proves every constraint.
Known failures are reported without changing labels or tuning retrieval during this cleanup.

## Retrieval benchmark: company knowledge base

Corpus: 25 client_portfolio, 19 cv, 37 past_project, 5 tech_stack, 4 tool. Queries: 42 labelled requirements (11 in French) and 6 negatives.
Labels are graded (2 = clear proof, 1 = passing mention) and were written before running the systems.

| System | P@3 | R@5 | MRR | nDCG@5 | Hit@1 | Median latency |
|---|---|---|---|---|---|---|
| BM25 only | 0.79 | 0.65 | 0.99 | 0.90 | 0.98 | 12 ms |
| Dense E5-small | 0.80 | 0.63 | 0.94 | 0.83 | 0.91 | 34 ms |
| Dense MiniLM-L6 | 0.68 | 0.56 | 0.90 | 0.77 | 0.83 | 20 ms |
| Hybrid (BM25 + E5) | 0.81 | 0.66 | 1.00 | 0.91 | 1.00 | 36 ms |
| Hybrid + reranker | 0.86 | 0.67 | 1.00 | 0.91 | 1.00 | 825 ms |
| Final (rules + reranker) | 0.81 | 0.62 | 1.00 | 0.90 | 1.00 | 237 ms |

Final system as a decision: set precision 0.95, set recall 0.73; negatives answered with no document: 5/6 (false positives: N04).

### nDCG@5 by category and language

| System | Technical | Team | Experience | English | French |
|---|---|---|---|---|---|
| BM25 only | 0.88 | 0.96 | 0.86 | 0.92 | 0.86 |
| Dense E5-small | 0.86 | 0.79 | 0.84 | 0.86 | 0.75 |
| Dense MiniLM-L6 | 0.81 | 0.71 | 0.72 | 0.81 | 0.66 |
| Hybrid (BM25 + E5) | 0.90 | 0.91 | 0.91 | 0.91 | 0.90 |
| Hybrid + reranker | 0.90 | 0.94 | 0.91 | 0.94 | 0.84 |
| Final (rules + reranker) | 0.90 | 0.90 | 0.89 | 0.90 | 0.89 |

Limits: one labeller, 49 queries, labels for a knowledge base partly built from the same CVs. These are development results, not an untouched holdout.

## Real tender requirements (n8n live run 3)

Source: current code (retrieve() on private indexes). 39 requirement lines from 9 tenders (9 in Company mode, 30 in Demo mode), sent as n8n wrote them. Expected statuses and proof documents were written from the documents before the run's answers were read (labels sha256 ce18de4c7e5d).

| Lines | Correct status | Company | Demo | Technical | Team | Experience |
|---|---|---|---|---|---|---|
| 39 | **30/39 (77%)** | 5/9 | 25/30 | 21/26 | 6/9 | 3/4 |

| Expected \ got | covered | partial | missing |
|---|---|---|---|
| missing | 0 | 1 | 3 |
| partial | 0 | 3 | 4 |
| covered | 24 | 3 | 1 |

- Over-claims (more than the documents prove): 1 (R07).
- Under-claims: 8 (R01, R04, R08, R16, R18, R21, R26, R37).
- Covered or partial rows whose best document is a labelled proof: 29/31 (wrong: R03, R07).
- Fragment proofs (quote under 4 words or without the line's terms): 3 (R03, R07, R34).
- Demo over real (Demo mode, fictional best document although a CV proves the line): 1 (R10).

| Id | Mode | Requirement | Expected | Got | Best document | Note |
|---|---|---|---|---|---|---|
| R01 | company | data processing | covered | **partial** | CV_07_Olivia_Morris.pdf |  |
| R02 | company | data analysis | covered | covered | CV_10_Daniel_Kim.pdf |  |
| R03 | company | statistical studies | partial | partial | CV_13_Isabella_Ross.pdf | fragment, not a proof |
| R04 | company | data restitutions | covered | **missing** |  |  |
| R05 | company | The quality of the organization setup must be demonstrated | missing | missing |  |  |
| R06 | company | The quality of the start of a service must be demonstrated | missing | missing |  |  |
| R07 | company | Financial capacity proof document | missing | **partial** | CV_05_Sofia_Nguyen.pdf | fragment, not a proof |
| R08 | company | Le système doit permettre l'analyse d'images issues de sy... | partial | **missing** |  |  |
| R09 | company | LLM agents | covered | covered | olivesoft_Project_GenAI_Content_Agent |  |
| R10 | demo | React or Angular | covered | covered | demo_TechStack_PublicSector_Cloud | demo over real |
| R11 | demo | Node.js or Java/Spring | covered | covered | CV_18_Leila_Morgan.pdf |  |
| R12 | demo | PostgreSQL | covered | covered | CV_02_Liam_Carter.pdf |  |
| R13 | demo | REST API | covered | covered | CV_02_Liam_Carter.pdf |  |
| R14 | demo | AWS or Azure | covered | covered | CV_01_Ava_Thompson.pdf |  |
| R15 | demo | ISO 27001 certification | missing | missing |  |  |
| R16 | demo | Minimum 3 senior developers | partial | **missing** |  |  |
| R17 | demo | 1 PMP certified | covered | covered | CV_17_Julian_Hayes.pdf |  |
| R18 | demo | 1 UX/UI designer | partial | **missing** |  |  |
| R19 | demo | 2+ public sector digital projects | covered | covered | demo_Project_MinistryInterior_LicensingPortal |  |
| R20 | demo | LLM with RAG architecture | covered | covered | CV_12_Mateo_Silva.pdf |  |
| R21 | demo | respond in French and Arabic | covered | **partial** | demo_Project_Telecom_RAGChatbot |  |
| R22 | demo | vector database | covered | covered | CV_12_Mateo_Silva.pdf |  |
| R23 | demo | Python | covered | covered | CV_13_Isabella_Ross.pdf |  |
| R24 | demo | 1 AI engineer | covered | covered | CV_18_Leila_Morgan.pdf |  |
| R25 | demo | 1 project manager | covered | covered | CV_14_Henry_Price.pdf |  |
| R26 | demo | 1 chatbot or AI assistant project reference | covered | **partial** | demo_Project_Telecom_RAGChatbot |  |
| R27 | demo | Power BI | covered | covered | CV_05_Sofia_Nguyen.pdf |  |
| R28 | demo | Python pipelines | covered | covered | CV_09_Emma_Foster.pdf |  |
| R29 | demo | Azure | covered | covered | CV_03_Maya_Patel.pdf |  |
| R30 | demo | 1 project manager | covered | covered | CV_14_Henry_Price.pdf |  |
| R31 | demo | 2 data engineers | covered | covered | CV_13_Isabella_Ross.pdf |  |
| R32 | demo | 1 health sector project | covered | covered | demo_Project_HealthAnalytics_Dashboard |  |
| R33 | demo | Flutter | covered | covered | demo_TechStack_Mobile |  |
| R34 | demo | Salesforce integration | covered | covered | CV_08_Lucas_Reed.pdf | fragment |
| R35 | demo | Kubernetes | covered | covered | CV_01_Ava_Thompson.pdf |  |
| R36 | demo | Terraform | covered | covered | CV_11_Chloe_Martin.pdf |  |
| R37 | demo | Minimum 5 senior developers | partial | **missing** |  |  |
| R38 | demo | 1 PSM certified Scrum Master | partial | partial | CV_14_Henry_Price.pdf |  |
| R39 | demo | 2 health sector projects | partial | partial | demo_Project_HealthAnalytics_Dashboard |  |

Limits: one labeller, 39 lines from one run; the demo tenders are synthetic. This set was not used to tune the system before these labels were written.
