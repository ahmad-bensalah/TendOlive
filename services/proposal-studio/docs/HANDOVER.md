# Project Handover & Context Guide (AI / IDE Agent Knowledge Base)

> Historical design log written before v1.0.0. For current facts use [`README.md`](../README.md)
> (API, deck spec, layout) and [`CHANGELOG.md`](../CHANGELOG.md). Index of all docs: [`docs/README.md`](README.md).

> **Document Purpose**: Comprehensive end-to-end technical documentation capturing the complete conversation history, architectural decisions, contracts, test suites, and workflows for **RFP Slide Deck Studio**. Any AI assistant or developer reading this document will have complete context to continue development without missing any historical requirements or design choices.

---

## 1. Project Overview & Core Philosophy

- **Goal**: Automatically transform structured JSON tender specifications (emitted by automated AI agent pipelines like n8n) into professional, pixel-perfect 1920×1080 slide decks.
- **Review & Export Loop**: Provides a browser-based, Canva-like visual editor (`editor.html`) allowing human bid managers to review, refine, sign off on gated slides, and export to:
  1. High-fidelity **PDF** via headless Playwright Chromium.
  2. Native, fully editable **PowerPoint (.pptx)** via `python-pptx` (real shapes, textboxes, tables, and speaker notes; no full-slide screenshot fallback images).
- **Core Stack Constraints**:
  - **Backend**: Python standard-library HTTP server (`http.server.BaseHTTPRequestHandler`) without heavyweight web frameworks (no FastAPI/Flask/Django).
  - **Frontend**: Vanilla JavaScript (ES6+), HTML5, and CSS3. **Strictly no React, Vue, build steps, bundlers, or TailwindCSS**.
  - **Zero Regressions**: Legacy saves and project JSONs must always load cleanly.
- **Team Motto**: *"Agents write. Code checks. Human approves."*

---

## 2. Chronological History of Phases & Changes

### Phase 0–3: Foundation, Layout Engine & Visual Editor
- **Canvas System (`static/canvas.js`, `static/render.js`, `static/history.js`, `editor.html`)**:
  - Fixed 1920×1080 canvas with responsive scaling and center-stage alignment.
  - Interactive selection, dragging, resizing, rotation, z-ordering, alignment guides, and undo/redo stacks (`Ctrl+Z`, `Ctrl+Y`).
  - Standard element types: `text`, `bullets`, `table`, `card`, `shape` (rectangle/circle), `image`, `video`, and `note`.
- **Layout Engine (`layout_engine.py`)**:
  - Converts external structured block specifications into exact 2D element coordinates.
  - Automatically prepends an attractive Title / Cover slide and appends a Thank-You / QR Code closing slide.
  - Handles table and bullet overflow:
    - Tables $> 10$ rows split automatically into continuation slides (`Title (1/2)`, `Title (2/2)`) repeating table headers.
    - Fonts stay at their defaults (bullets 28px, tables 22px, never below 24px / 20px); content that does not fit moves to continuation slides. Since v1.0.0, bullet lists longer than 12 items are split too.
- **Persistence (`server.py`, `saves/`)**:
  - Saved as plain JSON files in `saves/`.
  - Robust auto-ID generation avoiding legacy `None.json` collisions, with path traversal prevention (`../` rejected).

### Phase 4: Native PowerPoint (.pptx) Object Generation
- **Architecture (`pptx_exporter.py`)**:
  - Replaced screenshot-based PPTX export with true editable native PowerPoint shapes using `python-pptx`.
  - 16:9 widescreen layout (`13.333` in × `7.5` in) with proportional scaling from the 1920×1080 canvas.
  - Native element mapping:
    - **Textboxes**: Fixed width with word wrap, font families, pt sizes, hex/RGB colors, bold, italic, underline, alignment, and line spacing.
    - **Bullet Lists**: Native paragraphs with bullet characters (`disc`, `number`, `check`).
    - **Tables**: Native PowerPoint tables with header fills, alternating row fills, column widths, font sizes, and borders.
    - **Cards**: Native rounded rectangle background shapes + title & body textboxes + optional picture headers.
    - **Auto-Shapes**: Native rectangles, rounded rectangles, and circles/ellipses.
    - **Images**: Embedded pictures from disk and data URLs; SVG rasterization at 2x resolution via Playwright Chromium.
    - **Videos**: Styled poster shapes with clickable hyperlinks to the video URL.
    - **Speaker Notes**: Automatically populated into PowerPoint slide notes.
- **Fail-Safe Isolation**: Per-element errors fall back cleanly without corrupting the slide or degrading to full-slide screenshot images.

### Phase 5: Gating, Selective Approval & Regeneration Hardening
- **Review Panel & Placeholders**:
  - Highlights missing facts marked as `[TO FILL: <description>]` in red in the editor.
  - Warning badges on slides. Export gating blocks export until all placeholders are cleared or explicitly overridden ("Export anyway").
- **Selective Approval Reset**:
  - Slides can specify `requiresApproval: true` (e.g. pricing, SLA, commercial terms).
  - Tracked on `project.approvals.pricing`.
  - Editing, deleting, reordering, or regenerating an approval-required slide resets the approval state. Edits to normal content slides preserve the human sign-off.
- **Slide Regeneration (`POST /api/decks/<id>/slides/<index>/regenerate`)**:
  - Forwards the slide prompt/context to an external n8n/agent webhook (`REGENERATE_WEBHOOK_URL`).
  - Guards: Fixed slides (index 0 title slide and last slide thank-you) cannot be regenerated (rejected with HTTP 400).
  - Unset webhook returns HTTP 503 ("Regeneration webhook is not configured").
  - Sends optional `X-API-Key: <REGENERATE_WEBHOOK_KEY>` to the webhook when set.
  - Editor automatically saves project before regenerating and replaces only the regenerated slide in memory.

### Phase 6: PDF Brand Template Theme Extraction
- **Extractor (`pdf_extractor.py`)**:
  - `/api/extract-theme` accepts `.pdf` presentations and brand books up to 25 MB (analyzing the first 5 pages).
  - Built using `pymupdf` (pip-installable, fully offline, no system binaries like poppler or libreoffice required).
  - Features:
    - Background sampling from corner and edge margins.
    - Deterministic palette extraction: renders pages at 72 DPI, downsamples to 160×90, clusters dominant colors deterministically with distance/luminance thresholding.
    - Embedded font extraction: strips subset prefixes (`ABCDEF+Arial` $\to$ `Arial`), filters symbol/dingbat fonts, and maps to clean standard font families.
    - Resilience: handles scanned/image-only PDFs (provides informative French message and fallback font), encrypted PDFs (HTTP 422), and corrupt files.
    - Flags response with `"approximate": true`.
- **UI Integration (`index.html`)**:
  - Interactive color pickers for background, primary, and secondary colors, plus a detected font dropdown so users can visually verify and adjust extracted colors before creating the RFP deck.

### Handoff Pack (before Phase 7): Teammate Onboarding & Credibility Agent 5 Brief
- **Canonical Test Inputs (`tests/inputs/`, `tests/credibility/`, `tests/diagram/`)**:
  - Source of truth inputs for all agents: `software.json`, `non_software.json`, `thin.json`, `injection.json`, `many_projects.json`.
  - Verified with `tests/check_inputs.py` for schema compliance, role numbers, and cross-folder byte-level parity.
- **Launcher Scripts**:
  - `start.sh` (macOS/Linux) and `start.bat` (Windows): defaults `STUDIO_API_KEY` to the shared local dev key (see `START_HERE.md`) if unset, supports custom port `${1:-8091}`, logs URL and header name `X-API-Key` without leaking keys.
- **LLM Verification Tool (`tools/check_llm.py`, `tests/test_check_llm.py`)**:
  - Standard-library tool verifying Groq API connectivity and models using strict `response_format: {"type": "json_object"}`.
  - Supports `GROQ_BASE_URL` for local mock tests.
  - Clear, single-line error messages for missing env variables (instructing terminal `export` / `set`), 401 (invalid key), 400/404 (model not found), 429 (`Retry-After`), and network timeouts.
- **Documentation**:
  - `docs/N8N_SETUP.md`: Complete beginner setup guide for n8n (npm/Docker, network URLs, Header Auth credentials, retry on 429).
  - `docs/AGENT5_BRIEF.md`: Full specification for Agent 5 (Credibility / "Why Us"): deterministic JavaScript checks, project ranking on `many_projects.json`, LLM prompt guardrails, and platform verification.
  - `START_HERE.md`: Quickstart onboarding guide with verified curl commands.
- **Handoff Archive (`rfp-studio-handoff.tar.gz`)**:
  - Clean 134 KB distribution tarball containing single top-level `rfp-studio/` directory, strictly excluding runtime directories (`uploads/`, `saves/`, `exports/`, `screenshots/`), `.venv/`, `.git/`, `.env`, and `__pycache__/`.

---

## 3. Architecture & File Structure

The current file tree, one line per folder and key file, is in the "Project layout" section of
[`README.md`](../README.md#project-layout).

---

## 4. Key Contracts & API Specifications

### 4.1. Incoming Deck Payload (`POST /api/decks`)
External agents submit JSON payloads to `POST /api/decks` with header `X-API-Key`.
Unknown fields at any level are strictly rejected with **HTTP 400**.

```json
{
  "name": "Proposition Commerciale — OliveSoft",
  "client": "Région Occitanie",
  "date": "2026-10-17",
  "language": "fr",
  "qr_url": "https://example.com/dossier",
  "theme": {
    "primary": "#6366f1",
    "secondary": "#ec4899",
    "background": "#0b0f19",
    "fontHeading": "'Plus Jakarta Sans', sans-serif",
    "fontBody": "'Inter', sans-serif"
  },
  "slides": [
    {
      "type": "content",
      "title": "Défis & Objectifs Stratégiques",
      "notes": "Parler des délais serrés lors de la soutenance.",
      "requiresApproval": false,
      "warnings": [],
      "assumptions": ["Hypothèse de charge nominale : 500 req/s"],
      "catalogDate": "2026-10-01",
      "sources": { "mermaid": "graph TD; A-->B;" },
      "blocks": [
        {
          "kind": "bullets",
          "items": [
            "Modernisation de l'infrastructure vers Kubernetes",
            "Garantie de haute disponibilité 99.9%"
          ],
          "bulletStyle": "check"
        }
      ]
    }
  ]
}
```

### 4.2. Supported Block Kinds
1. **`text`**: `{"kind": "text", "text": "..."}`
2. **`bullets`**: `{"kind": "bullets", "items": ["..."], "bulletStyle": "disc" | "number" | "check"}`
3. **`table`**: `{"kind": "table", "columns": ["Col 1", "Col 2"], "rows": [["Val 1", "Val 2"]]}`
4. **`cards`**: `{"kind": "cards", "cards": [{"title": "...", "text": "...", "image": "..."}]}`
5. **`kpis`**: `{"kind": "kpis", "items": [{"label": "...", "value": "..."}]}`
6. **`image`**: `{"kind": "image", "src": "...", "caption": "..."}`
7. **`note`**: `{"kind": "note", "text": "..."}`

---

## 5. Security Rules & Secrets Policy

1. **Zero LLM Keys in Repositories or Logs**:
   - `GROQ_API_KEY` or other provider tokens must **never** be hardcoded, saved to any file, committed, or printed in logs.
   - `tools/check_llm.py` enforces key absence assertion in test suites.
2. **Shared Local Development Key**:
   - The shared local dev key is reserved for local development and appears only in `start.sh`, `start.bat`, and `START_HERE.md` (never in this file).
3. **Upload Sanitization**:
   - SVG uploads are inspected for `<script>` tags, javascript URIs, and event handlers; any malicious SVG is rejected with HTTP 400.
4. **Filesystem Traversal Defense**:
   - All project IDs and template filenames are sanitized with regex `^[A-Za-z0-9_-]+$`. Any relative path traversal (`../`) is rejected with HTTP 400.

---

## 6. How to Run the Environment & Tests

### Quickstart
```bash
# 1. Install dependencies
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
playwright install chromium

# 2. Launch server (port 8091 by default, or specify port as argument)
./start.sh 8091       # Linux / macOS
start.bat 8091        # Windows
```

### Testing Commands
```bash
# 1. Validate canonical test inputs and cross-folder parity
python3 tests/check_inputs.py

# 2. Test Groq LLM verification tool offline against mock server
python3 tests/test_check_llm.py

# 3. Run full test suite (94 tests in v1.0.0, about 85 s)
python3 -m unittest discover tests -v
```

---

## 7. Current Project Status & Next Steps

- **Completed**:
  - Full platform UI, layout engine, save persistence, PPTX/PDF export, selective approvals, and PDF theme extraction are 100% complete and verified with 42 passing automated tests.
  - Handoff package `rfp-studio-handoff.tar.gz` built, verified, and ready (release archives now live in `../dist/`, outside the project).
- **Next Steps for Next Agent / Developer**:
  - Guide Teammate 2 through implementing Agent 5 (Credibility) inside n8n following [`docs/AGENT5_BRIEF.md`](AGENT5_BRIEF.md).
  - Implement and integrate remaining agent workflows: Agent 1 (Requirements), Agent 2 & 3 (Diagrams via Teammate 1), Agent 4 (Budget), and Agent 6 (Reviewer).
