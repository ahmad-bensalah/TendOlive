# OliveSoft RAG: Knowledge Base Guide

Person 4 (Dali) · CSTAM 3.0 · Status on 18 October 2026

This guide explains what the knowledge base contains, how data gets in, how it is indexed and used for matching,
and what to improve, judged against the CSTAM book.
Part A describes what is **built**. Part B lists **suggestions**, which are not built yet.

---

# Part A: What exists today

## 1. What the knowledge base is

The knowledge base is everything the RAG can use as proof when it matches a tender requirement.
It has two kinds of sources:

| Source | Format | Where | How it gets in | Editable in the app |
|---|---|---|---|---|
| CVs (the "CV bank") | PDF | `data/cvs/` (19 files) | Read directly from the folder | No (read-only) |
| Past projects | JSON record | `data/projects/` | Guided form or predefined demo file | Yes (user records only) |
| Technology stacks | JSON record | `data/tech_stacks/` | Guided form or predefined demo file | Yes (user records only) |
| Clients | JSON record | `data/clients/` | Guided form or predefined demo file | Yes (user records only) |

The two kinds have different status:

- **CVs are evidence.** The app quotes an exact line from the PDF, with its line number.
- **Records are declarations.** The app shows their fields as a statement (`quote: null`),
  labelled "user declaration" or "fictional sample". They are never presented as verified document quotes.

## 2. The CV bank (19 PDFs)

- Source: `data/cvs/01_Ava_Thompson.pdf` … `19_Owen_Parker.pdf`. Fake names, placeholder contacts.
- The only CV source. CVs in any other folder are ignored, and a record cannot be disguised as a CV.
- API ID = `CV_` + file name, for example `CV_17_Julian_Hayes.pdf`. File names are never changed.
- Uploading CVs is disabled (`POST /api/documents` returns 410; deleting a CV returns 403).

### What the app extracts from each CV (the "profile")

| Field | How it is found |
|---|---|
| Name and title | First lines of the PDF, plus the current job ("Name - Job title") |
| Summary | The Profile / Summary section |
| Roles | Current job title + profile headline, matched against 22 known roles (developer, data engineer, product owner…) |
| Years of experience | Written ("over three years", "6+ years"), otherwise counted from the job dates (internships excluded) |
| Seniority | junior / mid / senior, from the title (lead, senior, architect, student…) or the years |
| Skills | 91 known skills (React, Talend, Kafka, Power BI…), plus implied ones (Talend → ETL) |
| Certifications | 27 known certifications, read **only** from the Certifications section |
| Sectors | 8 sectors (public, tourism, health, finance, telecom, education, retail, industry) |

Rules used to stay honest:

- Talking about ISO 27001 projects does not make a person certified.
- Seniority counted only from job dates never gives "senior" on its own.
- The PDF text is repaired first (LaTeX export problems: accents, ligatures, words split by spaces).

### What the CV bank looks like (data profiles)

- 19 people, mostly data engineering, BI, cloud and product roles.
- Certifications present: PMP (1), TOGAF, CKA, AWS Solutions Architect, Azure, GCP Data Engineer (3),
  PL-300, DP-600, Databricks, Talend, Airflow, Salesforce, PSPO, Scrum Master.
- **Not present:** senior web developers, UX/UI designers, mobile developers, a person titled "project manager".
  This is why the team part of the contract's Ministry of Tourism tender scores 0.

## 3. Structured records (projects, stacks, clients)

### Common fields (every record)

`schema_version` (1), `id` (stable, assigned by the server), `type`, `title`, `description`,
`origin` (`demo` or `user_entered`), `status` (`draft` or `indexed`), `created_at`, `updated_at`, `linked_ids`.

### Fields per type

| Type | Required before indexing | Optional |
|---|---|---|
| Past project | name, description, client (or anonymized ID), sector, company role, scope, technologies, delivery status | country, year, outcomes, budget + currency, links |
| Technology stack | name, description, technologies, use cases | links |
| Client | name (or anonymized ID), description, sector, relationship | country, links |

Validation rules:

- A budget needs a currency.
- Technologies: non-empty values of at most 200 characters (comma-separated in the form).
- The same title + client cannot be indexed twice (duplicate check).
- Links must point to records in the same mode.
- Only **completed** projects count as previous deliveries. Ongoing or planned projects never count.
- A client relationship never counts as a delivered project.
- Records cannot grant certifications. Only explicit technology and sector fields create skills and sectors;
  prose such as "ISO 27001-aligned" in a description is ignored for certificates.

### Lifecycle

```text
Add record -> Save draft (incomplete is fine, never used for matching)
           -> Save and index (must pass validation, becomes searchable)
Edit an indexed record -> it is re-indexed; if saved as draft it leaves the index at once
Delete -> warns (409) if other records link to it; repeat with confirmation
```

If indexing fails, the record is saved as a draft and the previous index keeps working (503 with a retry message).

## 4. Company mode and Demo mode

| | Company (default) | Demo |
|---|---|---|
| CVs | 19 | 19 |
| Records used | `user_entered` + `indexed` | `demo` + `indexed` |
| Records today | **0** | 26 indexed (10 projects, 4 stacks, 12 clients) + 1 draft project |
| Documents in index | 19 | 45 |
| Editable | Yes | No (read-only samples) |
| Used by n8n | Yes (no `data_mode` sent) | Only if n8n sends `"data_mode": "demo"` |

Demo projects: Ministry of Interior licensing portal, Ministry network upgrade, Municipality of Sfax e-services,
public agency security software, national health analytics dashboard, university AI training,
hotel chain booking platform, retail e-commerce, manufacturer ERP migration, telecom RAG chatbot.
The insurance ISO 27001 project is a draft (no technology list), so Demo mode has **no finance project**.

Demo stacks: Public-Sector Web (React, Spring, PostgreSQL, AWS…), Data & AI, Mobile, Security & Infrastructure.

Each response is labelled: Demo results carry the warning
"DEMO - Fictional records are included. These are not company references."

## 5. How the knowledge base is indexed

```text
CV PDFs + indexed records
  -> text (PDF repair for CVs; "Field: value" lines for records)
  -> profile (rules above)
  -> chunks of 200 words, 50 overlap, title added to each chunk
  -> E5-small embeddings in ChromaDB (one collection per mode)
  -> doc store JSON (profiles + text lines, used for rules and quotes)
  -> BM25 keyword index, built in memory from the same chunks
```

- Separate folders: `chroma_db/company/` and `chroma_db/demo/` (Docker volume `rag_index`). The benchmark has its own in `services/rag/benchmark/.index/`.
- **Automatic rebuild** at start-up when a source file, the reading code or the index format changes.
- **Atomic switch:** the new index is fully prepared, then activated in one step. If anything fails,
  the old index stays active. Edited drafts and deleted records are hidden immediately, even before a rebuild.
- Manual rebuild: "Rebuild index" button, or `POST /reindex?data_mode=company`.

## 6. How matching uses the knowledge base

| Requirement category | Document types searched |
|---|---|
| Technical | CVs, projects, stacks |
| Team | CVs only |
| Experience | Projects, clients, CVs. If it mentions a sector or "projects": completed projects only |
| Domain fit (from tender sector) | Completed projects in that sector |

Consequence: in Company mode (no records), anything about previous projects or the sector scores 0.

## 7. The Knowledge base screen

- Tabs: **People**, **Projects**, **Technology stacks**, **Clients**.
- Search box (people, records, technologies) and a status filter (All / Indexed / Draft).
- People: extracted profile per CV (role, seniority, years, skills, certifications), plus "Read extracted CV text".
- Records: Add record, Edit, Delete, Index, validation errors per field, a preview, linked records.
- KPI cards with counts, the "Rebuild index" button, and the mode notice at the top.

## 8. API endpoints for the knowledge base

| Endpoint | Purpose |
|---|---|
| `GET /api/documents?data_mode=` | Everything in the active index, with profiles |
| `GET /api/documents/{doc_id}` | One document: profile + all text lines |
| `GET /api/records?data_mode=` | Records with validation results (demo ones marked read-only) |
| `POST /api/records` | Create (`action: draft` or `index`) |
| `PUT /api/records/{id}` | Update (type cannot change) |
| `POST /api/records/{id}/index` | Index an existing draft |
| `DELETE /api/records/{id}?confirm_links=true` | Delete |
| `POST /api/records/validate` | Validate without saving |
| `POST /reindex?data_mode=` | Rebuild an index |

## 9. Known limits today

1. Company mode has no project, stack or client records, so the n8n pipeline sees CVs only.
2. No document upload: project references or portfolios that exist as PDF/Word must be typed in by hand.
3. The CV bank has role gaps (developers, UX, PM title, mobile), and the PMP holder (CV_17) is not read as "project manager".
4. Fixed vocabulary: a skill or certification not in the 91/27 lists is only matched by the reranker, not by rules.
5. Clients have no link to the projects delivered for them unless `linked_ids` is filled in, and links are not used in matching.
6. Record IDs (`demo_Project_...`) do not follow the contract example (`Project_....pdf`).
7. No "tools" category, although the book lists "tools" separately from technical stacks.

---

# Part B: Suggestions, linked to the CSTAM book

The book items that concern the knowledge base:

- **Phase 1, Robust RAG Knowledge Retrieval (15 pts):** "indexing and extracting knowledge from Olivesoft's internal
  documentation (past project references, client portfolios, CV bank, tools, and technical stacks)".
- **Phase 1, Edge Case & Data Validation (5 pts):** "missing internal references".
- **Phase 2, RAG Benchmark & Retrieval Precision (10 pts):** "correct CV and project matching".
- **Phase 3, Quality of Interface (10 pts):** "inspect matched internal assets".
- **Bonus, Automated Requirements Matrix & Score (+2).**

Priority: **High** = before the Phase 2 deadline (20 October), **Medium** = before Phase 3 (1 November), **Low** = if time allows.

| # | Suggestion | Book item it serves | Priority | Effort |
|---|---|---|---|---|
| 1 | **Make project matching visible through n8n**: send `data_mode: "demo"` for the demo, or enter real OliveSoft records in Company mode | Robust RAG, CV **and project** matching | High | Very small |
| 2 | **Add a finance demo project** (complete the insurance draft with technologies, or add a bank project) so the finance example is covered in Demo | Robust RAG, demo quality | High | Small |
| 3 | **Fix the PMP project manager gap**: let a PMP / PRINCE2 holder count as "project manager", or read "Managing Partner" / "Delivery Manager" as management roles | Correct CV matching | High | Small |
| 4 | **Benchmark projects and stacks** with demo records and expected IDs; add precision@k, recall, MRR | Benchmark & Retrieval Precision | High | Medium |
| 5 | **Add a "tools" record type** (or a tool list in stacks): licences, internal accelerators, frameworks OliveSoft owns | Robust RAG, "tools" is named in the book | Medium | Medium |
| 6 | **Document import for projects and portfolios**: upload a PDF/Word reference, pre-fill the guided form, a human checks and saves | Robust RAG, "indexing and extracting knowledge from internal documentation" | Medium | Medium–Large |
| 7 | **Bulk import** of records from JSON/CSV (for OliveSoft's real project list) | Robust RAG | Medium | Small |
| 8 | **Use client ↔ project links**: show "delivered for this client" and give a bonus when the tender client or a similar client is in the portfolio | Robust RAG, input for Person 3 / Person 5 | Medium | Medium |
| 9 | **Knowledge coverage report**: for a tender, list which knowledge is missing (e.g. "no UX designer CV", "no finance project") and what to add | Edge cases: missing internal references; Phase 3 usability | Medium | Small |
| 10 | **Grow the vocabulary from the data**: list skills found in CVs/records that are not in the taxonomy, and add them | Retrieval precision | Medium | Small |
| 11 | **Contract-style IDs**: return a `display_id` such as `Project_MinistryInterior_LicensingPortal` next to the stable ID | Integration with Person 5 | Low | Small |
| 12 | **Freshness and quality signals**: year of project, last CV update, missing fields shown as warnings; prefer recent projects | Proposal quality | Low | Small |
| 13 | **Proposal-ready snippets**: for each project, a one-line reference text and outcome Person 5 can paste into the deck | Generative Proposal Output (Person 5) | Low | Small |
| 14 | **Team builder**: from the matched CVs, propose a team that covers all team requirements with the fewest people | Proposal (recommended team), bonus matrix | Low | Medium |

### Detail on the top items

**1. Project matching through n8n.** Today n8n gets CVs only, so experience and domain fit are 0 for any project-based requirement.
For the demo video, add `data_mode: "demo"` in the n8n node "Build RAG Payload" and say clearly that the projects are fictional.
For the real system, OliveSoft should enter a few real (anonymized) projects through the guided form.

**2. Finance demo project.** The data-platform example asks for "a previous project in the finance sector".
The only finance project is a draft with no technologies, so it stays missing even in Demo.
Completing it is a data change (no code) and makes that example show a covered experience requirement.

**3. PMP project manager.** CV_17 holds the PMP but his title is "Strategic Managing Partner".
Options: map "managing partner" to a management role, or accept a project-management certification as proof of the role
when the requirement asks for both. Add a benchmark check for it.

**4. Project and stack benchmark.** Example checks for Demo mode:
"2+ public sector projects" → covered (Ministry of Interior, Municipality, Public Agency…);
"React and Spring Boot stack" → Public-Sector Web Stack;
"previous finance project" → missing (draft only). Then compute precision@3 and recall per check.

**6. Document import with human review.** This keeps the current honesty rule (declarations are checked by a person)
while answering the book's "extracting knowledge from internal documentation". Flow: upload → extract fields
(rules or an optional LLM) → pre-filled form → person corrects → Save and index. The CV folder stays read-only.

### What to say to the supervisor

- The knowledge base already covers CVs, past projects, technology stacks and client portfolios, with validation,
  drafts, separate Company/Demo data, and atomic indexing.
- CV evidence is quoted from documents; records are labelled declarations. This avoids presenting unverified claims.
- The main gap is real company content: Company mode has no project records yet, so project matching is shown in Demo mode.
- Next steps: items 1–4 before Phase 2, then tools, document import and client links for Phase 3.
