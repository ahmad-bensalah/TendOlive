# Start Here

**You received `rfp-studio.zip`?** Follow [`docs/SETUP_GUIDE.md`](docs/SETUP_GUIDE.md) from step 1:
it installs the platform, the AI agents (n8n in Docker, your own free Groq key) and the
OliveSoft templates, in about 30 minutes. Only the platform, without AI: step 2, then
`./start.sh` (or `start.bat` on Windows) and open <http://localhost:8091>.

The rest of this file is the older quickstart for agent developers.

---

# n8n Agent Developer Quickstart

## You just received this archive? Read this first (5 minutes)

**What it is.** `rfp-studio-handoff.tar.gz` contains the finished slide editor (the
"platform") plus everything you need to build an n8n agent that sends slides to it. You do
**not** change the platform code: your agent produces JSON, the editor turns it into slides.

**What to do, in order:**

1. Unpack it and install (section 1 below). Use a virtual environment.
2. Start the editor with `./start.sh` (or `start.bat` on Windows) and open
   <http://localhost:8091> (section 2).
3. Send a sample deck with the curl command in section 3 and open the link it returns.
   If you see slides, your setup works.
4. Run `python3 tests/check_inputs.py`: the last line must say `ALL INPUT CHECKS PASSED`.
5. **Teammate 2 (Agent 5, Credibility):** now read [`docs/AGENT5_BRIEF.md`](docs/AGENT5_BRIEF.md).
   It is your task, step by step. Then set up n8n with [`docs/N8N_SETUP.md`](docs/N8N_SETUP.md).

**What you need besides this archive:** a Groq API key (create your own free key at
<https://console.groq.com>, or receive one privately; never in a group chat) and the Groq
model name to use. Check both with `python3 tools/check_llm.py` (section 6).

**Rules that save time:** report after each step of your brief and wait for the "next";
if you are stuck for one hour, send the exact error message; never put a key in a file,
a workflow export or a chat.

**Where things are:** this file (quick start and slide rules), [`README.md`](README.md)
(full reference: API, deck spec, troubleshooting), [`docs/README.md`](docs/README.md)
(index of all documents and who should read them).

---

Welcome to RFP Slide Deck Studio! This platform receives slide deck specifications (JSON) from external systems (such as n8n agents), automatically generates pixel-perfect 1920×1080 layouts, provides an interactive web review editor, and exports to native editable PowerPoint (`.pptx`) and PDF.

---

## 1. Unpack & Installation

### Unpack the Archive
If you received the tarball distribution, extract it:
```bash
tar -xzvf rfp-studio-handoff.tar.gz
cd rfp-studio
```

### Prerequisites
- Python 3.10+ (tested on Python 3.12)
- Chromium browser binaries for PDF/image rendering via Playwright

### Setup
```bash
# 1. Create and activate a virtual environment (do this once; activate it in every new terminal)
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate

# 2. Install Python dependencies (includes pymupdf for PDF theme extraction)
pip install -r requirements.txt

# 3. Install Playwright browser binary
playwright install chromium
```

---

## 2. Start the Server

We provide quickstart launcher scripts for macOS/Linux and Windows that automatically export the shared development key (`WIN2WIN_FSS_CSTAM_3`) if `STUDIO_API_KEY` is not already configured:

### macOS / Linux
```bash
./start.sh
# or specify a custom port:
./start.sh 8091
```

### Windows
```cmd
start.bat
REM or specify a custom port:
start.bat 8091
```

The server will be available at: **`http://localhost:8091`**
*(Note: To use a custom API key, simply set `export STUDIO_API_KEY="your-key"` before running the script).*

---

## 3. Testing the API with curl

External agents send requests to `POST /api/decks` with the `X-API-Key` header.

### 1. Create a Deck from Sample JSON
Run this command from the project root using the default dev key:
```bash
curl -X POST http://localhost:8091/api/decks \
  -H "Content-Type: application/json" \
  -H "X-API-Key: WIN2WIN_FSS_CSTAM_3" \
  -d @samples/software.json
```

**Real response received from the server:**
```json
{
  "id": "a699e358",
  "url": "/editor.html?id=a699e358",
  "warnings": []
}
```

### 2. Open the Deck in your Browser
Navigate to the returned URL in your web browser:
```text
http://localhost:8091/editor.html?id=a699e358
```

---

## 4. Contract & Input Files

All contracts and test inputs are located in:
- **`deck.schema.json`**: The strict JSON schema for deck payloads.
- **`samples/`**: Working sample deck specifications (`software.json`, `non_software.json`, `thin.json`).
- **`tests/inputs/`**: The canonical test inputs representing RFP tenders and matching data.
- **`tests/credibility/`**: Dedicated identical copy for Agent 5 (Credibility).
- **`tests/diagram/`**: Dedicated identical copy for Architecture and Planning diagram agents.

---

## 5. Strict Slide Rules (Contract Summary)

These rules are enforced by `layout_engine.py` and `deck.schema.json`:

1. **Top-Level Allowed Fields**: Only `name` (required), `slides` (required), and optional `client`, `date`, `language`, `qr_url`, `theme`. Unknown fields return HTTP 400.
2. **Slide Allowed Fields**: Only `type` (must be `"content"`), `title` (required), `blocks` (required), and optional `notes`, `requiresApproval`, `assumptions`, `catalogDate`, `warnings`, `sources`.
3. **Block Kinds**: `text`, `bullets`, `table`, `image`, `cards`, `note`, `kpis`.
4. **No HTML**: Block texts, notes, and captions must be plain text (no embedded HTML or `<script>`).
5. **Fixed Slides**: Title slide and Thank-you/QR slide are automatically generated; agents only submit `"content"` slides.
6. **Continuation & Split**: Tables exceeding 10 rows are split into continuation slides (`Title (1/2)`), repeating header columns automatically.
7. **Overflow Limits**: Fonts stay at their defaults (bullets 28px, tables 22px). Blocks that do not fit move to continuation slides; bullet lists longer than 12 items are split like tables. Keep bullets to 6 items of 8 to 12 words for clean slides.
8. **Coordinates**: Do NOT provide pixel coordinates (`x`, `y`, `width`, `height`); the server layout engine automatically computes all coordinates on the 1920×1080 canvas.

---

## 6. Helper Tools & Verification Scripts

### Validate Input Files
Check input file contracts, role numbers, and cross-folder parity:
```bash
python3 tests/check_inputs.py
```

### Verify Groq LLM Connectivity
Verify your Groq credentials and model name without leaking keys:
```bash
# 1. Export environment variables in your terminal (do not use a .env file):
# macOS / Linux:
export GROQ_API_KEY="your-groq-key"
export GROQ_MODEL="llama-3.3-70b-versatile"

# Windows cmd:
set GROQ_API_KEY=your-groq-key & set GROQ_MODEL=llama-3.3-70b-versatile

# 2. Run the validator
python3 tools/check_llm.py
```
*(Prints `OK` on success, or a descriptive French/English error for 401, 400/404, 429, or network errors).*

---

## 7. Running Existing Tests

Verify the entire test suite (including native PPTX, PDF theme extraction, and API checks):
```bash
python3 -m unittest discover tests -v
```
- Total test count: **94 tests**
- Execution time: about **85 seconds** (includes headless browser, PDF and PPTX tests). `RFP_FAST=1` skips the browser tests.

---

## 8. Team Folders & Documentation

- **`docs/N8N_SETUP.md`**: Complete beginner setup guide for n8n (npm/Docker, network setup, Groq configuration, test workflow).
- **`docs/AGENT5_BRIEF.md`**: Specification brief for Agent 5 (Credibility).
- **`workflows/`**: Export your n8n workflow JSON files here (`credibility.json` and `diagrams.json`). Never commit credentials inside these files.
- **`tests/credibility/`**: Working test inputs for Teammate 2.

---

## 9. Common Errors & Troubleshooting

- **HTTP 401 Unauthorized**:
  - Missing or mismatched `X-API-Key` header when `STUDIO_API_KEY` is configured. Check that your client or n8n credential sends the header `X-API-Key`.
- **HTTP 400 Validation Error (Unknown field)**:
  - You passed a field not permitted by the schema. Example server message:
    ```json
    {
      "status": "error",
      "message": "Validation failed against schema",
      "errors": [
        "Root: unknown field(s) 'invalid'. Allowed deck fields are: client, date, language, name, qr_url, slides, theme"
      ]
    }
    ```
- **Port already in use (`Address already in use`)**:
  - Another process is using port 8091. Pass a different port: `./start.sh 8099`.
- **Playwright Not Installed**:
  - If exports fail with browser launch errors, run `playwright install chromium`.
- **Docker Network Connection (`ECONNREFUSED`)**:
  - If n8n runs inside Docker, use `http://host.docker.internal:8091/api/decks` (and on Linux ensure `--add-host=host.docker.internal:host-gateway` is passed to `docker run`).
- **Groq Rate Limit (HTTP 429)**:
  - The free Groq tier reached rate limits. In n8n, enable "Retry On Fail" on the HTTP Request node with a 15-second delay.





 

