# RFP Slide Deck Studio — v1.1.0

A Canva-style slide editor for RFP responses. External systems (the n8n agents) send a
deck as JSON blocks; the server lays the blocks out on 1920×1080 slides; a person reviews
and edits the deck in the browser, then exports it to PDF and native, editable PowerPoint.

**Agents write. Code checks. Human approves.**

- New to the project or building an n8n agent? Start with [START_HERE.md](START_HERE.md).
- **Agent system complete:** All 6 agents operational with budget scenarios, competitive analysis, and regeneration.
- All documents and who should read them: [docs/README.md](docs/README.md).
- History of every phase: [CHANGELOG.md](CHANGELOG.md).

---

## Project layout

```text
rfp-studio/
├── server.py  layout_engine.py  pptx_exporter.py  pptx_extractor.py  pdf_extractor.py
├── index.html  editor.html  deck.schema.json  requirements.txt
├── start.sh  start.bat  .env.example
├── README.md  START_HERE.md  CHANGELOG.md
├── static/      samples/     docs/      tools/
├── tests/       workflows/
└── exports/  uploads/  saves/      (created by the server at run time, never committed)
```

**Platform**

| Path | What it is |
|---|---|
| `server.py` | Standard-library HTTP server: pages, REST API, uploads, saves, PDF/PPTX export |
| `layout_engine.py` | Validates deck specs and turns blocks into positioned elements (splits long content) |
| `pptx_exporter.py` | Native PowerPoint export (python-pptx): text boxes, bullets, tables, shapes, notes |
| `pptx_extractor.py` | Reads colors, fonts and background from a `.pptx` template |
| `pdf_extractor.py` | Reads an approximate theme from a `.pdf` template (PyMuPDF) |
| `index.html` | Start page: name the RFP, pick a template or a theme |
| `editor.html` | The slide editor (review panel, export gate, regenerate, sources) |
| `static/` | Editor code: `app.js` (app logic), `canvas.js` (selection, drag, resize), `render.js` (one renderer for editor and export), `history.js` (undo/redo), `app.css` |
| `deck.schema.json` | JSON Schema of the deck spec accepted by `POST /api/decks` |
| `requirements.txt` | Pinned Python dependencies |
| `start.sh`, `start.bat` | Start the server with the shared local dev key (see [START_HERE.md](START_HERE.md)) |
| `exports/`, `uploads/`, `saves/` | Runtime folders created by the server: export files, uploaded media, saved projects |

**Agent integration kit (used by the n8n teammates)**

| Path | What it is |
|---|---|
| `START_HERE.md` | Quick start for agent builders: run the editor, send a deck with curl, slide rules |
| `docs/AGENT5_BRIEF.md` | The full task brief for Agent 5 (Credibility) |
| `docs/N8N_SETUP.md` | Install n8n, reach the editor from Docker, store credentials, Groq setup |
| `samples/` | Working deck specs: `software.json`, `non_software.json`, `thin.json` |
| `tests/inputs/` | Fake tender inputs for the agents (source of truth), described in `tests/inputs/README.md` |
| `tests/diagram/`, `tests/credibility/` | Identical copies of `tests/inputs/` for each agent team |
| `tests/check_inputs.py` | Checks the inputs and that the three folders are identical |
| `tools/check_llm.py` | Checks a Groq key and model name |
| `tools/export_deck.py` | Exports a saved deck to PDF or PPTX from the command line |
| `workflows/` | Exported n8n workflows (never with credentials), see `workflows/README.md` |
| `.env.example` | List of all environment variables (reference only, nothing reads `.env`) |

**Agent system (n8n workflows + business logic)**

| Path | What it is |
|---|---|
| `agents/README.md` | How the agent part works, how to run, how to test |
| `agents/lib/` | Pure JavaScript business logic (no n8n dependencies) |
| `agents/lib/pipeline.js` | Main orchestration: prepare, run stages, finalize, regenerate |
| `agents/lib/agent1.js` | Agent 1: Requirements & solution (s1, s2, s3, s11) |
| `agents/lib/agent5.js` | Agent 5: Credibility (s4, s6, s7, s8) |
| `agents/lib/diagrams.js` | Agents 2&3: Architecture & planning (s3b, s3c, s5, s10) |
| `agents/lib/agent4.js` | Agent 4: Budget (s9) with scenarios |
| `agents/lib/reviewer.js` | Agent 6: Review & correction loop |
| `agents/lib/coverage.js` | Requirements coverage score (Phase C) |
| `agents/lib/profile.js` | Company profile integration (Phase D) |
| `agents/lib/competitive.js` | Budget scenarios & competitive positioning s12 (Phase B) |
| `agents/lib/token_budget.js` | Token optimization to max 15k (Phase S) |
| `agents/config/` | Company profile, pricing catalog, LLM token prices |
| `agents/tests/` | Unit tests (Node test runner) |
| `agents/fixtures/` | Mock LLM responses for tests |
| `agents/tools/` | Platform facts check, embed check, evaluation |

**Tests**

| Path | What it is |
|---|---|
| `tests/test_*.py` | Unit, API and browser tests; run them all with one command (below) |
| `tests/_runtime.py` | Test helper: sends uploads and exports to a temp folder, marks slow browser tests |
| `tests/test_docs_paths.py` | Fails if a document mentions a file that does not exist |

---

## Install

Python 3.10 or newer (tested on 3.12). Use a virtual environment:

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
playwright install chromium        # browser used for PDF export and SVG rendering
```

On a fresh Linux machine Chromium may also need system libraries:
`playwright install --with-deps chromium` (asks for sudo).

## Run

```bash
./start.sh            # macOS / Linux, port 8091
./start.sh 8099       # another port
```

```bat
start.bat             REM Windows, port 8091
start.bat 8099
```

The start scripts set `STUDIO_API_KEY` to the shared local dev key **only if it is not
already set**, and never print it. Manual start, with your own key:

```bash
export STUDIO_API_KEY="choose-a-long-random-value"
python3 server.py 8091
```

Open <http://localhost:8091>. Stop with `Ctrl+C`.

## Run the tests

```bash
python3 -m unittest discover tests        # everything: 94 tests, about 85 s
RFP_FAST=1 python3 -m unittest discover tests   # skip the 9 slow browser tests (about 10 s)
python3 tests/check_inputs.py             # agent test inputs and folder parity
```

The tests run the server in-process and write only to temporary folders: a test run
leaves `exports/`, `uploads/` and `saves/` unchanged.

---

## Environment variables

**No `.env` file is read** by the server or the tools. Set variables in the terminal
(`export NAME=value` on macOS/Linux, `set NAME=value` on Windows) or in n8n credentials.
`.env.example` only lists the names.

| Variable | Read by | Meaning |
|---|---|---|
| `STUDIO_API_KEY` | `server.py` | Key expected in the `X-API-Key` header of the `/api/decks` endpoints. Unset: only requests from localhost are accepted. |
| `SAVES_DIR` | `server.py` | Folder for saved projects. Default: `saves/` next to `server.py`. |
| `REGENERATE_WEBHOOK_URL` | `server.py` | n8n webhook called by the editor's "regenerate slide" button. Unset: button hidden, endpoint returns 503. Only http/https. |
| `REGENERATE_WEBHOOK_KEY` | `server.py` | Optional; sent as `X-API-Key` to that webhook. |
| `GROQ_API_KEY` | `tools/check_llm.py`, n8n | Groq key for the agents. **Not used by `server.py`.** |
| `GROQ_MODEL` | `tools/check_llm.py`, n8n | Groq model name (pick it in the Groq console). |
| `GROQ_BASE_URL` | `tools/check_llm.py` | Only for offline tests against a fake server. |
| `RFP_FAST` | tests | `1` skips the slow browser tests. |

---

## API

All bodies are JSON unless noted. The examples use port 8091 and read the key from
`STUDIO_API_KEY`; with `./start.sh`, export the same value in the terminal where you run
curl, or replace `$STUDIO_API_KEY` by the key from `START_HERE.md`.

| Method and path | Key | Purpose |
|---|---|---|
| `POST /api/decks` | yes | Validate a deck spec, lay it out, save it. Returns `{id, url, warnings}` |
| `GET /api/decks/<id>` | yes | The saved project JSON (slides with positioned elements) |
| `POST /api/decks/<id>/slides/<index>` | yes | Replace one slide with a new slide spec |
| `POST /api/decks/<id>/slides/<index>/regenerate` | no | Ask the n8n webhook for a new version of one slide |
| `POST /api/upload` | no | Upload media (multipart field `file`). Returns `{url}` |
| `POST /api/extract-theme` | no | Theme from a `.pptx` or `.pdf` template (multipart field `file`) |
| `POST /api/export` | no | Export to PDF or PPTX. Returns `{url}` of the file under `/exports/` |
| `POST /api/save`, `GET /api/save/<id>`, `GET /api/saves` | no | Editor save, load, list |
| `POST /api/qrcode` | no | `{url}` → QR code as a data URL |
| `GET /api/config` | no | `{hasRegenerate}` for the editor |

Errors: `401` wrong or missing key; `400` bad JSON or spec (`errors` lists every
problem); `404` unknown deck; `413` body too large (deck 5 MB, upload 25 MB);
`503` regenerate without webhook.

### Create a deck

```bash
curl -s -X POST http://localhost:8091/api/decks \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $STUDIO_API_KEY" \
  -d @samples/software.json
```

```json
{"id": "4c1d2e3f", "url": "/editor.html?id=4c1d2e3f", "warnings": []}
```

Open `http://localhost:8091/editor.html?id=<id>` to review the deck.

### Read a deck, replace one slide

```bash
curl -s http://localhost:8091/api/decks/<id> -H "X-API-Key: $STUDIO_API_KEY"

curl -s -X POST http://localhost:8091/api/decks/<id>/slides/1 \
  -H "Content-Type: application/json" -H "X-API-Key: $STUDIO_API_KEY" \
  -d '{"type":"content","title":"Synthèse","blocks":[{"kind":"text","text":"Nouveau texte."}]}'
```

Index 0 is the title slide; the last index is the thank-you slide.

### Regenerate one slide

```bash
curl -s -X POST http://localhost:8091/api/decks/<id>/slides/1/regenerate
```

The server POSTs `{deckId, slideIndex}` to `REGENERATE_WEBHOOK_URL` (60 s timeout) and
expects one slide spec back, which goes through the same validation and layout. The title
and thank-you slides return `400` ("fixed slides cannot be regenerated").

### Upload media and extract a theme

```bash
curl -s -X POST http://localhost:8091/api/upload -F "file=@logo.png"
curl -s -X POST http://localhost:8091/api/extract-theme -F "file=@template.pdf"
```

Uploads accept png, jpg, jpeg, gif, webp, svg, mp4, webm, pdf, pptx. SVGs containing
scripts, event handlers or `javascript:` are rejected. PDF themes are marked
`"approximate": true`.

### Export to PDF or PPTX

The export endpoint renders the HTML that the editor builds, so the simplest way to export
from a script is the helper, which opens the deck headless and calls `/api/export` exactly
like the editor's export button:

```bash
python3 tools/export_deck.py <id> pdf  --out deck.pdf
python3 tools/export_deck.py <id> pptx --out deck.pptx
```

Like the editor, it refuses to export while `[TO FILL: ...]` placeholders remain or
pricing is not approved (exit code 2); `--force` exports anyway. `--base-url` changes the
server address. Raw request, if you build the HTML yourself:
`POST /api/export` with `{"format": "pdf"|"pptx", "html": "<deck html>", "slideCount": n, "project": {...}}`.
For PPTX the native objects come from `project`.

---

## Deck spec (`POST /api/decks`)

Unknown fields are rejected with `400` and a message listing the allowed ones.

```json
{
  "name": "Proposition — Portail citoyen",
  "client": "Ville Exemple",
  "date": "2026-10-18",
  "language": "fr",
  "qr_url": "https://example.com/dossier",
  "theme": {"primary": "#1d4ed8", "secondary": "#3b82f6", "background": "#0f172a",
            "fontHeading": "Inter", "fontBody": "Inter"},
  "slides": [
    {"type": "content", "title": "Synthèse", "blocks": [{"kind": "text", "text": "..."}]}
  ]
}
```

**Top level:** `name` (required), `slides` (required, at least one), `client`, `date`,
`language`, `qr_url`, `theme`. The title slide and the thank-you + QR slide are generated
from these fields; agents send only content slides.

**Theme:** `primary`, `secondary`, `background` (a color string), `fontHeading`,
`fontBody`. Missing values get defaults.

**Slide fields:** `type` (always `"content"`), `title`, `blocks` (required); optional
`notes` (speaker notes), `warnings` (strings shown in the review panel),
`requiresApproval` (true for pricing: export blocked until a person approves),
`assumptions` (strings) and `catalogDate` (pricing catalog date, shown in the review panel),
`sources` (`{mermaid, drawio}` diagram sources as text).

**Block kinds:**

| Kind | Fields | Example |
|---|---|---|
| `text` | `text` | `{"kind": "text", "text": "Paragraphe."}` |
| `bullets` | `items`, optional `bulletStyle`: `disc`, `number`, `check` | `{"kind": "bullets", "items": ["A", "B"], "bulletStyle": "check"}` |
| `table` | `columns`, `rows` (strings) | `{"kind": "table", "columns": ["Exigence", "Réponse"], "rows": [["R1", "Oui"]]}` |
| `image` | `src`, optional `caption` | `{"kind": "image", "src": "/uploads/archi.svg", "caption": "Architecture"}` |
| `cards` | `cards: [{title, text, image?}]` | `{"kind": "cards", "cards": [{"title": "Équipe", "text": "12 ingénieurs"}]}` |
| `note` | `text` | `{"kind": "note", "text": "Hypothèse : ..."}` |
| `kpis` | `items: [{label, value}]` | `{"kind": "kpis", "items": [{"label": "Délai", "value": "6 mois"}]}` |

**Layout rules** (applied by `layout_engine.py`; agents never send coordinates):

- Two short blocks (text, bullets, image, cards) sit side by side; otherwise blocks stack.
- Up to 4 cards or KPIs per row; extra cards are dropped.
- Tables longer than 10 rows split into continuation slides "Title (1/2)", "Title (2/2)",
  repeating the header row.
- Bullet lists longer than 12 items split the same way.
- Blocks that do not fit the slide move to continuation slides. Fonts stay at their
  defaults (bullets 28 px, tables 22 px; never below 24 px and 20 px).
- `warnings`, `requiresApproval`, `assumptions`, `catalogDate`, `notes` and `sources`
  are copied to every continuation slide.
- Recommended for clean slides: at most 6 bullets of 8 to 12 words; card text about 35 words.
- Text is stored as plain text; HTML is never interpreted. Missing facts are written as
  `[TO FILL: what is missing]` and highlighted in the review panel.

## Element JSON (saved projects)

Elements sit on a 1920×1080 canvas with common fields `id`, `type`, `x`, `y`, `width`,
`height`, `rotation`, `opacity`, `zIndex`.

| Type | Fields |
|---|---|
| `text` | `content`, `fontFamily`, `fontSize`, `fontWeight`, `fontStyle`, `textDecoration`, `textAlign`, `color`, `lineHeight` |
| `bullets` | `items`, `bulletStyle`, `fontFamily`, `fontSize`, `color`, `lineHeight`, `autoHeight` |
| `table` | `columns`, `rows`, `headerFill`, `headerColor`, `rowFill`, `altRowFill`, `borderColor`, `fontSize`, `colWidths` |
| `card` | `title`, `text`, `fill`, `radius`, `image` |
| `image` | `src`, `alt` (SVGs are shown only through `<img>`) |
| `shape` | `shapeType` (`rectangle`, `circle`), `fill`, `stroke`, `strokeWidth`, `strokeStyle`, `borderRadius` |
| `video` | `src`, `videoType` (`file`, `link`); exported as a poster with a link |
| `split` | Old saves only (hidden from the toolbar) |

A slide holds `elements`, `notes`, `warnings`, `requiresApproval`, `sources` and, for
pricing, `assumptions` and `catalogDate`. The project holds `name`, `theme`, `slides` and
`approvals.pricing`.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Executable doesn't exist` / browser launch error on export | `playwright install chromium` (on Linux maybe `playwright install --with-deps chromium`) |
| `ModuleNotFoundError: No module named pymupdf` (or `pptx`, `playwright`) | The virtual environment is not active: `source .venv/bin/activate`, then `pip install -r requirements.txt` |
| Fonts look different in the PDF or PPTX | The theme font is not installed on the machine; the export falls back to a system font. Install the font or pick a common one |
| `Address already in use` | Another program uses the port: `./start.sh 8099` |
| `401 Unauthorized` | The `X-API-Key` header does not match `STUDIO_API_KEY` of the running server (each server has its own value) |
| `400` with "unknown field(s)" | Remove the field; the message lists the allowed fields |
| n8n in Docker cannot reach the editor (`ECONNREFUSED`) | Use `http://host.docker.internal:8091`; on Linux start the container with `--add-host=host.docker.internal:host-gateway` |
| `503` on regenerate | `REGENERATE_WEBHOOK_URL` is not set |

## Architecture

`server.py` is a standard-library `ThreadingHTTPServer` that serves the two pages and a
JSON API. Agents post a deck spec to `/api/decks`; `layout_engine.py` validates it, adds
the title and thank-you slides, splits long content and converts every block into
positioned elements, and the result is saved as JSON in `saves/`. The editor (vanilla JS,
no build step) loads that JSON; `static/render.js` draws every element type for both the
editor and the export, so what you see is what you export. PDF export renders the exported
HTML in headless Chromium (Playwright); PPTX export rebuilds every element as a native
PowerPoint object with python-pptx. Templates are read by `pptx_extractor.py` and
`pdf_extractor.py`.

## Known limitations

- **PPTX fidelity:** text, bullets, tables, shapes and notes are native; images and SVGs
  are pictures (SVGs rasterized at 2×); fonts missing on the viewer's machine are replaced.
- **PDF themes are approximate:** colors and fonts are estimated from the first pages and
  must be checked by a person (the UI lets you correct them).
- **No user accounts:** anyone who can open the editor can view and edit every saved project.
- **Single-user server:** no locking; two people editing the same project overwrite each other.
- **Export gate in the UI only:** the placeholder and pricing-approval gate runs in the
  editor (and in `tools/export_deck.py`); `POST /api/export` itself does not enforce it.
- **Regenerate is not protected by the key:** anyone who can reach the editor can trigger
  the n8n webhook (and its LLM cost).
- **Shared dev key for local use only:** use your own long `STUDIO_API_KEY` on any shared
  or public server.

**Agent System (n8n integration)**

| Path | What it is |
|---|---|
| `agents/lib/` | Core agent logic: input normalization, validation, budget calculator, diagram rendering, checks, merge |
| `agents/prompts/` | System prompts for all 6 agents (requirements, architecture, planning, budget, credibility, reviewer) |
| `agents/catalog/` | Pricing catalog (daily rates, cloud costs, API prices) - update with real OliveSoft values |
| `agents/tools/` | Utilities: platform facts check, guard check, secrets audit, test workflow runner |
| `agents/tests/` | 316 automated tests (100% pass rate) covering all agent logic |
| `agents/fixtures/` | Mock LLM responses for testing (5 test inputs × 4 agents) |
| `agents/registry/` | Runtime storage for regenerate functionality (git-ignored) |
| `docs/agents/` | Agent documentation: contracts, runbook, evaluation report, phase reports |
| `workflows/` | n8n workflow definitions (to be built: orchestrator, agents, shared LLM caller) |

See [docs/agents/RUNBOOK.md](docs/agents/RUNBOOK.md) for deployment and [docs/agents/EVAL_REPORT.md](docs/agents/EVAL_REPORT.md) for system status.
