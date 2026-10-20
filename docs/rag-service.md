# RAG service

Matches tender requirements to OliveSoft's knowledge base (`knowledge-base/`: the CVs and recorded company
capabilities) and stores the analysed tenders for the web app. Code: `services/rag`; container `rag`, port 8001
(http://localhost:8001/docs). Architecture: [architecture.md](architecture.md) (Part 2); API:
[integration-and-api.md](integration-and-api.md) (section 5); evaluation: [rag-benchmark.md](rag-benchmark.md).

It starts with the system (`docker compose up -d`). The web app shows a loading state while the API starts and
"The RAG service is not reachable" with Retry when it is down. The first start builds the Company and Demo indexes
(a few minutes on CPU); the embedding model and the reranker are already in the image. In the container the knowledge
base is `/app/data` (`RAG_DATA_DIR`), bind-mounted from `knowledge-base/`.

## Data modes

- **Company** (default): the 19 PDFs in `knowledge-base/cvs/`, plus indexed user-entered records.
  It ships with company records, each naming its source:
  - 28 projects and 4 tools from the OliveSoft experience in the CVs, assigned to the engineer whose CV describes them;
  - 5 client engagements from the CVs, linked to clients listed on olivesoft.fr;
  - 27 clients (25 indexed) from olivesoft.fr; sectors come from public company information;
  - 5 technology stacks (one per service line) and 5 case studies from olivesoft.fr and its partner list.
  Client names and sectors stay empty when the source does not state them.
- **Demo**: the same CVs, plus fictional predefined projects, stacks and clients.

Modes have separate indexes. Demo records and CVs are read-only in the dashboard.
User-entered statements are not verified company references. CV evidence retains document quotes;
non-CV records expose declared fields and statements, with `quote: null`.

## Add company knowledge

Open **Knowledge base**, choose a category, and click **Add record**.
Fill the guided fields. Choose **Save draft** to keep incomplete information, or **Save and index**
to make a complete record available for matching. Edit or delete records from the same screen.

| Record | Required to index |
|---|---|
| Project | Name, description, client/anonymized identifier, company role, scope, technologies, delivery status |
| Technology stack | Name, description, technologies, supported use cases |
| Client | Name/anonymized identifier, description, sector, relationship |
| Tool | Name, description, tool kind (licence, internal accelerator, framework, software), technologies, use cases |

Dates, outcomes, budgets, links and source are optional. A budget needs a currency.
A project's sector is optional; without one, only a sector named in its title or description counts as sector experience.
Skills named in the title or description of a project, stack or tool count as well as its technologies
("RAG Customer Service Chatbot" gives rag and chatbot); a client's description gives no skills.
Part of a hyphenated word does not count ("social-media content" is not the media sector), and prose never
grants certifications or roles.
Projects can list assigned engineers (CVs from the CV bank); each CV then shows its company projects.
Tools answer technical requirements, like stacks. Licence details are optional.
Technology names are comma-separated in forms. Unknown facts stay empty.
Duplicate title/client identities cannot be indexed twice. Only completed project records count
as previous deliveries; client relationships do not count as projects.
Stack descriptions and technology usage do not establish certification.
JSON records live in `knowledge-base/projects/`, `knowledge-base/tech_stacks/`, `knowledge-base/clients/` and `knowledge-base/tools/`.
Document uploads, bulk import and automatic extraction are outside this release.

## Match a tender

Enter one requirement per line, paste a tender JSON, or select an example.
Choose Company or Demo, run matching, then open a requirement to see matches and their provenance.
The score measures recorded coverage, not probability of winning.
Each result also shows a **Proposed team** (the fewest CVs that fill every team requirement;
one person may fill several requirements) and a **Knowledge coverage report** (what is missing
from the knowledge base for this tender, and which CV or record to add).
Export JSON for the proposal stage or CSV for the requirements matrix. Fictional and user-entered data are explicitly labelled.

How the rules decide:
- Certificates are specific. "PSM certified" needs the Scrum.org PSM; a Scrum Alliance CSM holder is only partial,
  with the note "equivalent certification, check it is accepted" (PSPO and CSPO work the same way).
  "Certified Scrum Master" without an acronym accepts either. Each Azure exam (AZ-900, AZ-104, AZ-204, AZ-305,
  AZ-400, DP-203, DP-900, AI-900, AI-102) is its own certificate and "Azure certified" accepts any of them;
  AWS Solutions Architect, GCP Professional Data Engineer and Salesforce Administrator / Platform Developer
  are members of their vendor's family in the same way.
- Certificates come in groups of alternatives: "PMP or PRINCE2", "PSM/CSM", a comma list closed by "or <name>" or
  "or equivalent" ("PMP, PRINCE2 or equivalent"), and two certificates of the same family need one of them; "and" joins
  groups that are all needed ("PSM or CSM and PMP" = PMP plus one of PSM / CSM; "PMP and PRINCE2" = both).
- A PMP or PRINCE2 holder, and a delivery manager, can fill a "project manager" requirement; a Scrum Master
  certificate implies the scrum master role and a Product Owner certificate the product owner role. The reason is shown.
- The quoted proof must name the requirement (a known term or alias, or most of its other words). When no line
  does, the closest whole line is quoted and marked weak evidence with a note: that document is listed last and
  does not count toward covered; when it is the best document, the row is at most partial (50 %).
- Context words (interface, server, API, web, integration, architecture, stack...) are ignored only when they are
  directly attached to a named technology or certificate and end its phrase ("Angular interface", "REST API
  exposure", "Node.js server", "interface Angular" mean that technology). Anywhere else ("API integration",
  "Python web development", "Java web services integration") they are the need, and the reranker and the proof
  line look for them; when they are the only words left next to a named technology, only documents with that
  technology can count.
- If the reranker rejects every candidate but the rules matched every named technology or certificate, and the
  other words are plain words (not names like "iOS"), the rule-matched documents still count as partial, with a
  note naming the unconfirmed words.
- In Demo mode a real document (CV or user-entered record) is listed before a demo record that scores about the same.

## Local storage

- `knowledge-base/cvs/`: the only CV source; filenames are preserved and API IDs add `CV_`.
- `knowledge-base/{projects,tech_stacks,clients}/`: versioned JSON records.
- `chroma_db/company/`, `chroma_db/demo/`: generated, independent index generations (Docker volume `rag_index`).
- `benchmark/.index/` (`authoritative_cvs/`, `company_corpus/`, `real_tenders/`): private benchmark indexes.
- `tenders.json`: the tender inbox (latest analysis per `tender_id`; Docker volume `rag_state`).

CV PDFs are read as one sentence or bullet item per line: lines wrapped by the PDF are joined and words cut
by a hyphen are mended, so a quote is a whole sentence rather than the end of a wrapped line.
At start, the API rebuilds the Company and Demo indexes by itself when the files in `knowledge-base/`, the index
format or the ingestion code (vocabulary, CV reader, record profiles, doc store) changed; no `/reindex` step
is needed. After changing the code, rebuild the image: `docker compose up -d --build rag`.
Record saves are atomic; an index generation activates only after vectors, profiles and metadata are ready.
Missing source folders fail explicitly. No paid AI API is required. Optional legacy LLM configuration
is unnecessary for this workflow.
Run the tests after changes ([tests/README.md](../tests/README.md)).
