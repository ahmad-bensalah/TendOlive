# Tender Pipeline: Summary (main + Scout Tools + Research Tools)

## 1. Purpose

A weekly n8n pipeline that:
1. collects open public tenders (France + Tunisia) relevant to the company profile (data/CRM/BI/AI/e-commerce/ERP/supply chain, retail & fashion),
2. enriches each buyer (legal identity, contacts, past projects),
3. uses an LLM to score the tender and extract the supplier requirements,
4. exports a master table (Google Sheet / CSV / JSON) and
5. **sends a compact payload per relevant tender to the RAG service** (`POST http://rag:8001/retrieve/tender`).

Trigger: Schedule, weekly (Monday 06:00). Manual runs use the `test` preset (small limits), scheduled runs use `production`.

---

## 2. Workflows

| Workflow | Role | Called by |
|---|---|---|
| **main** | Orchestrator: collect → normalize → dedupe → enrich buyers → analyse → export → RAG | Schedule |
| **Scout Tools** (`J3UqUINaTj18D4Xd`) | Tools for the *Scout Agent*: `inspect_page`, `list_tenders` (Firecrawl scrape + link-pattern detection) | Scout Agent |
| **Research Tools** (`TIquAhCIdi1asYww`) | Tools for the *Buyer Research Agent*: `web_search`, `web_scrape`, `registry_search`, `boamp_history`, `decp_awards`, `wikidata_lookup` | Buyer Research Agent |

---

## 3. General structure of `main`

```
Schedule
  └─ 00 Config (limits, taxonomy keywords, LLM provider, sources, company profile)
       └─ 01 Load Known IDs (Google Sheet) → 02 Collect Known IDs
            ├─ BRANCH A: BOAMP API ───────────────────────────────┐
            │    BOAMP1 Build Requests (SERVICES/FOURNITURES/TRAVAUX, 100/page)
            │    → BOAMP Fetch → BOAMP2 Filter & Adapt (keyword/CPV relevance gate)
            │                                                      ├─► Merge Sources
            └─ BRANCH B: Scout Agent (web portals) ───────────────┘
                 A1 Sources (France Marchés, domainetat.tn + paging)
                 → A2 Scout Agent (LLM + tools inspect_page / list_tenders)
                 → A3 Pick Tender URLs (drops already-known URLs)
                 → A4 Firecrawl Detail → A5 Parse Detail (regex extraction, skips award notices)

Merge Sources
  → Normalize & Classify   (ISO dates, expired filter, taxonomy categories, urgency, heuristic score)
  → Dedupe & Assign IDs    (within/across sources; tender_id = "T-" + hash; skips IDs already in the sheet)
  → Select Unique Buyers   (one record per buyer; France first; capped by maxBuyersToEnrich)
  → Buyer in enrichment budget?
       ├─ yes → Buyer Research Agent (tools: wikidata, registry, boamp_history, decp_awards, web_search, web_scrape)
       │        → Parse Agent Output → LLM Buyer Profile → Finish Buyer Profile
       └─ no  → passes through un-enriched
  → Merge Buyers → Join Buyers to Tenders   (attaches contacts + buyer_profile to every tender)
  → Build Tender Prompt → Run AI analysis? (top-N by heuristic score)
       └─ LLM Tender Analysis → Parse Tender Analysis
  → Merge Analysis ─┬─► Build RAG Payload → Call RAG        ◄── RAG output
                    └─► Finalize & Export (CSV+JSON) → Save to Google Sheet → Run Summary → Email alert
```

LLM provider is chosen in Config (`ollama` by default; gemini/groq/openai/anthropic available through the Model Selector).

---

## 4. Sub-workflows

### 4.1 Scout Tools
Input: `tool` (`inspect` | `list`), `url`, `pattern`, `maxTenders`, `keywords`.
Flow: Tool Input → Firecrawl Scrape (v2, markdown) → Inspect or List (code).
- **inspect** returns `PAGE_TYPE` (listing / detail / navigation / unknown), `BEST_PATTERN` (URL shape that repeats), candidate NAV links and `NEXT_PAGE`.
- **list** returns up to 50 lines `title | url` of tender links matching the repeated URL pattern, plus `NEXT_PAGE`.
Output is always a single text field `result`.

### 4.2 Research Tools
Input: `tool`, `q`, `buyer_name`, `siren`, `query`, `url`. A Switch routes on `tool`:
| Tool | Source | Returns (text lines) |
|---|---|---|
| `web_search` | Firecrawl search (3 results) | `WEB \| url \| title \| snippet` |
| `web_scrape` | Firecrawl scrape | `PAGE \| url`, `EMAILS`, `PHONES`, `TEXT` (1200 chars) |
| `registry_search` | recherche-entreprises.api.gouv.fr | `REG \| name \| siren \| siret \| addr \| nature \| ca` |
| `boamp_history` | BOAMP open data | `BOAMP \| id \| date \| object \| buyer` |
| `decp_awards` | DECP (data.economie.gouv.fr), needs 9-digit siren | `DECP \| date \| amount \| object \| supplier` |
| `wikidata_lookup` | Wikidata | `WD \| label \| desc \| id \| website \| employees \| revenue` |

Registry/BOAMP/DECP are French-only; the agent is told to use Wikidata + web search for other countries.

---

## 5. Final outputs

### 5.1 Output sent to the RAG (the one you need)

`Build RAG Payload` emits **one JSON object per tender** and `Call RAG` POSTs it as the request body.

**Sent only if** the tender has an AI analysis, `relevance_score >= 40`, and at least one requirement in technical/team/experience.

```json
{
  "tender_id": "26-104512",
  "language": "fr",
  "title": "Développement d'une application mobile citoyenne",
  "deadline": "2026-11-20",
  "client": "COMMUNE DE LYON",
  "sector": "Public administration (local government)",
  "requirements": {
    "technical":  ["Application iOS et Android", "Hébergement conforme RGPD"],
    "team":       ["1 chef de projet certifié PMP"],
    "experience": ["3 références secteur public"]
  }
}
```

| Field | Source / rule |
|---|---|
| `tender_id` | Tender `reference` with the `domainetat-` / `boamp-` prefix removed; falls back to the internal hash id `T-xxxxxxxx` when there is no reference |
| `language` | Language of the tender text: `fr` for France/Tunisia tenders, `en` otherwise (derived from `country`) |
| `title` | Tender title (`title`, cleaned) |
| `deadline` | Submission deadline, ISO `yyyy-mm-dd` (`deadline`); `null` if not found |
| `client` | Registry legal name → buyer name → issuer → `null` |
| `sector` | LLM sector → buyer-profile sector → `null` |
| `requirements.technical` | Technologies, platforms, standards, certifications, concrete technical scope (max 8 items) |
| `requirements.team` | Roles, profiles, qualifications, headcount (max 8) |
| `requirements.experience` | Years, references, sector/public-sector experience (max 8) |

Notes:
- Requirements keep the **tender's original language** (French or English). They are extracted only from the tender text, never invented.
- `timeline`, `issuer`, budget, etc. are **not** in this payload (they are in the master export). `client` plays the role of the issuer.
- The main workflow ignores the RAG response (nothing is stored from it). The RAG service returns the matching evidence (projects/CVs), which the proposal-generator workflow later consumes as `rag` / `matrix`.

### 5.2 Master export (Google Sheet `tenders`, CSV, JSON)

Upsert key: `tender_id`. Sorted by `priority_score`. Files: `tenders_master_<date>.csv` and `.json` (the JSON holds the full nested objects).

Main columns: `tender_id, source, country, currency, priority (high/medium/low), priority_score, relevance_score, relevance_basis, urgency, reference, title, issuer, legal_name, siret, date, deadline, days_to_deadline, categories, estimated_value, duration, cpv`, buyer contacts (`buyer_email/phone/website/address`, `contact_status`, `contact_sources`), buyer profile (`client_sector, client_scale, client_org_description, client_past_projects, client_past_digital_projects, client_key_partners, client_past_suppliers, client_estimated_revenue, client_domain_requirements`), analysis (`requirements_technical/team/experience`, `timeline`, `matched_service_lines`, `relevance_rationale`, `suggested_angle`, `risks`), and status fields (`enrichment_status`, `analysis_status`, `scrape_status`, `source_url`).

Priority formula: `0.6 × relevance + 0.25 × urgency points + 0.15 × evidence` (high ≥ 70, medium ≥ 45).

### 5.3 Run summary email
Counts per source, new tenders, buyers, exported rows, high-priority count, enrichment statuses, failed calls.

---

## 6. Tender object (internal, before export)

```
tender_id, source(s), country, currency, reference, title, issuer, date, deadline, days_to_deadline,
urgency, categories[], cpv, duration, estimated_value, source_url, raw_text
buyer_information{name,email,phone,website,address,legal_form,profile_url}
buyer_profile{sector, organization_description, scale, estimated_revenue, past_digital_projects[],
              key_partners[], past_suppliers[], past_projects[], domain_requirements[], evidence_confidence}
analysis{relevance_score, relevance_rationale, matched_service_lines[], suggested_angle, risks[], sector,
         requirements{technical[], team[], experience[], timeline}}
```

---

## 7. Points to be aware of

- **Run Summary** references nodes that no longer exist (`FM2…`, `TN2…`, `Gemini - …`), so some failure counters come out `null`. Harmless but misleading.
- **AI analysis is limited** to the top-N tenders by heuristic score (`aiMaxTenders`: 10 in test, all in production). Tenders without analysis never reach the RAG.
- **Buyer enrichment budget** `maxBuyersToEnrich` (5 test / 60 production), France only; others are labelled `not_attempted_budget` or `skipped_no_buyer_name`.
- **Google Sheet ID** in `Save to Google Sheet1` is still the placeholder `YOUR_GOOGLE_SHEET_ID`.
- **`Build RAG Payload` must be updated** to emit `language`, `title` and `deadline` (the current node only sends `tender_id`, `client`, `sector`, `requirements`). Replace its `rag_payload` with:
  ```js
  rag_payload: {
    tender_id: ref || t.tender_id,
    language: (t.country === 'France' || t.country === 'Tunisia') ? 'fr' : 'en',
    title: t.title || null,
    deadline: t.deadline || null,
    client: t.legal_name || (t.buyer_information && t.buyer_information.name) || t.issuer || null,
    sector: a.sector || (t.buyer_profile && t.buyer_profile.sector) || null,
    requirements
  }
  ```
- The proposal generator also requires an issuer (`tender.issuer` or `buyer_profile.legal_name`) and at least one requirement; `client` covers the issuer on the RAG side.
