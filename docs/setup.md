# Setup and operations

Everything needed to run the system beyond the [README quick start](../README.md#quick-start): choosing the LLM, every
`.env` setting, what happens when n8n starts, where data lives, and troubleshooting. `.env.example` is the source of
truth for setting names; `docker-compose.yml` shows how each one reaches the containers.

## Ports

All ports are bound to 127.0.0.1.

| URL | Service |
|---|---|
| http://localhost:5173 | **The web app**: dashboard, tenders and their analysis, knowledge base, proposals, templates, quality |
| http://localhost:8001/docs | RAG API reference (OpenAPI) |
| http://localhost:8091 | Proposal studio (the deck editor opens here from the web app) |
| http://localhost:5679 | n8n editor (create the owner account on the first visit; it stays local) |
| http://localhost:8004/tenders | Synthetic demo tenders (read by Main when `PIPELINE_DEMO_MODE=true`) |

The web app's origin must stay `http://localhost:5173`: the RAG CORS and the Refine Slide webhook allow exactly that origin.

## Change the LLM

**One setting, `LLM_PROVIDER`, switches Main and the deck agents together.** In `.env`:

| `LLM_PROVIDER` | Key | Default model (`LLM_MODEL` overrides it for both) |
|---|---|---|
| `groq` (default) | `GROQ_API_KEY` | `openai/gpt-oss-120b` |
| `gemini` | `GEMINI_API_KEY` | `models/gemini-3.1-flash-lite` |
| `openai` | `OPENAI_API_KEY` | `gpt-4.1-mini` |
| `ollama` | none (`OLLAMA_URL`, default `http://host.docker.internal:11434`) | `qwen3:4b-instruct` |

Then restart with `docker compose up -d --force-recreate n8n proposal-studio` (no image rebuild: keys and providers are read
at container start).

**Optional split:** `DECK_LLM_PROVIDER` (and `DECK_LLM_MODEL`) give the deck agents another LLM than Main; empty = the same.
Tested setup: `LLM_PROVIDER=ollama` (Main on a local Ollama: no rate limit, data stays on the machine) and
`DECK_LLM_PROVIDER=groq` (fast decks; "Refine with AI" answers in 10-20 s). With one cloud free tier for everything, Main is
paced (`PIPELINE_LLM_DELAY_MS`, Groq default 15 s between calls) because Groq's free tier allows about 8 000 tokens a minute.

At every n8n start `n8n/init/init.js` sets Main's `LLM_PROVIDER` (its LLM Model Selector), puts the key in that
provider's n8n credential, patches the model node when `LLM_MODEL` is set, and gives the deck agents `GROQ_BASE_URL` /
`GROQ_API_KEY` / `GROQ_MODEL` for the same provider (their client speaks the OpenAI chat API; the names say GROQ but
any compatible API works). The studio's model list (`GROQ_MODELS`) gets the same model. `anthropic` is refused (the
deck agents speak the OpenAI API only), and so is a missing key: n8n then stops with a `CONFIGURATION ERROR` line in
`docker compose logs n8n`. The defaults live in `n8n/llm.json`; the n8n image build checks them against `n8n/build.js`.

Free tiers are rate limited: Groq allows about 200 000 tokens a day per model and a deck uses about 36 000. When a quota
runs out, set another `LLM_MODEL` (for example `openai/gpt-oss-20b`) and recreate n8n and the studio.

## Settings (`.env`)

| Setting | Default | Effect |
|---|---|---|
| `STUDIO_API_KEY` | required | The studio's API key; n8n's "Proposal Studio key" credential and the deck agents use it |
| `AGENTS_WEBHOOK_KEY` | required | The deck agents' webhook key: the studio sends it, n8n's MainWebhook / RegenWebhook credentials check it |
| `LLM_PROVIDER`, `LLM_MODEL`, `DECK_LLM_PROVIDER`, `DECK_LLM_MODEL`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `OLLAMA_URL` | `groq` | See [Change the LLM](#change-the-llm) |
| `FIRECRAWL_KEY` | empty | Real tender portals (URL sources) and buyers' web pages. Empty: the URL sources are off (`PIPELINE_URL_SOURCES=auto`); BOAMP and the rest still run |
| `PIPELINE_DEMO_MODE` | `false` | `true`: Main reads only the synthetic tenders of `demo-tenders` |
| `PIPELINE_URL_SOURCES` | `auto` | `on` / `off` force the URL sources |
| `PIPELINE_AUTO_DECK` | `top1` | `none`: Main starts no deck |
| `PIPELINE_LLM_DELAY_MS` | by provider | Pause between Main's LLM calls (ollama 0, groq 15000, gemini 4000, openai 1000) |
| `RFP_FORCE_IMPORT` | `0` | `1`: import and publish the workflows again at the next n8n start |
| `EXECUTIONS_DATA_SAVE_ON_SUCCESS` | `none` | n8n keeps failed runs only (the agents' webhook runs hold the webhook key); `all` keeps every run |
| `GENERIC_TIMEZONE` | `Europe/Paris` | n8n's timezone ("today" of a run) |

## How n8n starts

`n8n/init/entrypoint.sh`, at every start:

1. `init.js prepare` checks the keys and `LLM_PROVIDER`, writes the 9 credentials from the environment to a temporary
   file (mode 600, deleted right after) and runs `n8n import:credentials` (Firecrawl, Ollama, Gemini, Groq, OpenAI,
   Anthropic, Proposal Studio key, MainWebhook, RegenWebhook, with the fixed ids the workflows use).
2. When the workflows changed since the last start (or `RFP_FORCE_IMPORT=1`): our 4 workflows (generated at image build
   by `n8n/build.js`, patched for the compose network: RAG `http://rag:8001/retrieve/tender`, studio
   `http://proposal-studio:8091`, demo tenders, `LLM_PROVIDER`) and the agents' 9 (`services/proposal-studio/workflows`,
   read-only mount) are imported; Research Tools, Scout Tools, the agents' 9 and Refine Slide are published. **RFP - Main
   stays unpublished**: run it from the editor (published, its schedule would run the production preset every day). A
   re-import replaces edits made to these workflows in the n8n editor.
3. `init.js env` computes the agents' `GROQ_*` settings; n8n starts and registers the published webhooks.

## Data and volumes

Data lives in Docker volumes: `rag_state` (tender store), `rag_index`, `studio_*` (saves, tenders, generations,
exports, uploads, templates), `n8n_data` (n8n database, encryption key, agents' registry). The knowledge base is the
bind-mounted `knowledge-base/` folder: records added in the web app are written there. `docker compose down` keeps the
volumes; `docker compose down -v` deletes them all.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `port is already allocated` | Something on this machine uses 5173, 8001, 8091, 5679 or 8004 (for example a part started by hand, or another n8n). Stop it, then `docker compose up -d` |
| n8n restarts in a loop | `docker compose logs n8n`: a `CONFIGURATION ERROR` line says what to fix in `.env`; then `docker compose up -d --force-recreate n8n proposal-studio` |
| Web app: "The RAG service is not reachable" | The first start builds the index: wait for `rag` to be healthy (`docker compose logs -f rag`) |
| Deck generation answers 502 or stays queued | n8n is not up yet or its webhooks are not published: `docker compose logs n8n` must show "published 13 workflows" then n8n's start; else set `RFP_FORCE_IMPORT=1` and recreate n8n |
| The studio answers 401 to n8n | The keys changed: `docker compose up -d --force-recreate n8n proposal-studio` (the credentials are re-imported at every start) |
| "Refine with AI": the refine webhook does not answer | Open the web app at exactly http://localhost:5173 (not 127.0.0.1); check that "RFP - Refine Slide" is published in n8n |
| LLM errors 429 / quota | Free tier exhausted: change `LLM_MODEL` or `LLM_PROVIDER`, recreate n8n and the studio |
| `LLM_PROVIDER=ollama` cannot connect | Ollama must listen on all interfaces (`OLLAMA_HOST=0.0.0.0`) or set `OLLAMA_URL`; its context window must be 8192 or more |
| A new template in `services/proposal-studio/templates/inbox` does not appear | The templates folder is a volume filled from the image once. Import it in the web app's Templates page, or `docker compose build proposal-studio` then `docker volume rm cstam-olivesoft_studio_templates` (loses imported templates) |
| Start from zero | `docker compose down -v` (deletes every volume: tenders, decks, n8n database) |
