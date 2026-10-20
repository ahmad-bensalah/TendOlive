# n8n workflows: setup and operation

Verified with **n8n 2.34.4** (Docker image `n8nio/n8n:latest`, October 2026): mock mode, real
mode against a fake Groq server, and real mode with the **Groq API** (model `openai/gpt-oss-120b`,
free tier), see section 6.

## 1. What runs where

| File | Workflow | What it does |
|---|---|---|
| `workflows/00_main.json` | RFP 00 Main | Webhook `POST /webhook/rfp/generate` (or manual run) → Prepare → Agent 1 → Agent 5 → Agents 2+3 → Agent 4 → Agent 6 review + publish → JSON response |
| `workflows/10_agent1_requirements.json` | RFP 10 | Slides s1, s2, s3, s11 |
| `workflows/40_agent5_credibility.json` | RFP 40 | Slides s4, s6, s7, s8 |
| `workflows/20_diagrams.json` | RFP 20 | Architecture, class (software/SaaS only) and roadmap SVGs; slides s3b, s3c, s5, s10 |
| `workflows/30_agent4_budget.json` | RFP 30 | Slide s9 (people-days from the plan by code, prices from the catalog by code) |
| `workflows/50_agent6_reviewer.json` | RFP 50 | Review, correction loop (max `MAX_CORRECTION_ROUNDS`), POST `/api/decks` with one repair round, GET, registry |
| `workflows/60_regenerate.json` | RFP 60 | Webhook `POST /webhook/rfp/regenerate` called by the platform: one slide spec back |
| `workflows/70_llm_json.json` | RFP 70 | Shared LLM JSON caller for manual tests (the agents call the same function directly) |
| `workflows/90_error_handler.json` | RFP 90 | Error workflow of all the others: one line per failure in `<registry>/errors.jsonl` |

The agents run one after the other, so at most one LLM call is in flight (Groq free-tier friendly).
All logic lives in `agents/lib/`. **Never edit code inside n8n**: change `agents/lib`, run
`npm run workflows:generate`, import again. `npm run embed:check` fails if a workflow is out of date.

## 2. Start n8n (Docker)

The Code nodes read the project files (fixtures, catalog, test inputs), so mount the project
read-only, and keep the registry on the n8n volume:

```bash
docker run -d --name rfp-n8n -p 127.0.0.1:5678:5678 \
  --add-host=host.docker.internal:host-gateway \
  -v "$PWD":/data/rfp-studio:ro -v rfp-n8n-data:/home/node/.n8n \
  -e N8N_BLOCK_ENV_ACCESS_IN_NODE=false \
  -e NODE_FUNCTION_ALLOW_BUILTIN=fs,path,crypto \
  -e N8N_RUNNERS_TASK_TIMEOUT=1200 \
  -e RFP_STUDIO_DIR=/data/rfp-studio \
  -e AGENTS_REGISTRY_DIR=/home/node/.n8n/rfp-registry \
  -e STUDIO_BASE_URL=http://host.docker.internal:8091 \
  -e STUDIO_API_KEY="<the platform key>" \
  -e PUBLIC_EDITOR_URL=http://localhost:8091 \
  -e LLM_MODE=mock \
  n8nio/n8n:latest
```

Run it from the `rfp-studio/` folder. If port 5678 is taken, use `-p 127.0.0.1:5679:5678` and
adapt the URLs below.

Why each setting is needed (n8n 2.x):

| Setting | Why |
|---|---|
| `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` | Code nodes read their configuration from `$env` (blocked by default in n8n 2) |
| `NODE_FUNCTION_ALLOW_BUILTIN=fs,path,crypto` | The libs read fixtures and the catalog, and write the registry |
| `N8N_RUNNERS_TASK_TIMEOUT=1200` | n8n stops a Code node after 300 s by default; with Groq free-tier rate limits the review and correction step can take longer (seen: a run failed with HTTP 500 "Task execution timed out after 300 seconds") |
| `AGENTS_REGISTRY_DIR` | Must be writable and persistent: regeneration reads it. Inside n8n's task runner `process.env` is empty, so the path is passed from `$env` |

## 3. Environment variables (all read through `$env`)

| Variable | Default | Meaning |
|---|---|---|
| `LLM_MODE` | `mock` | `mock` uses `agents/fixtures/`; `real` calls the LLM |
| `GROQ_API_KEY` | none | Groq key (real mode). See section 7 about secrets |
| `GROQ_MODEL` | none | Model name from the Groq console (required in real mode) |
| `MODEL_AGENT1`, `MODEL_AGENT4`, `MODEL_AGENT6` | `GROQ_MODEL` | Optional per-agent model |
| `GROQ_BASE_URL` | Groq | Only for tests against a fake server |
| `STUDIO_BASE_URL` | `http://host.docker.internal:8091` | Platform address seen from n8n |
| `STUDIO_API_KEY` | none | Same value as the platform's `STUDIO_API_KEY` |
| `PUBLIC_EDITOR_URL` | `http://localhost:8091` | Prefix of `editorUrl` in the response |
| `QR_URL_TEMPLATE` | empty | Fixed QR link. A `{deckId}` template is not supported (the id is only known after creation): the QR is left empty with a warning |
| `MAX_CORRECTION_ROUNDS` | `2` | Reviewer correction rounds (real mode) |
| `LLM_MAX_RATE_LIMIT_WAITS` | `12` | How many HTTP 429 answers one LLM call waits out before giving up. Groq's free tier allows 8 000 tokens per minute for every chat model, and one deck uses about 36 000, so many waits are normal |
| `RFP_STUDIO_DIR`, `AGENTS_REGISTRY_DIR` | see section 2 | Project mount and registry folder |
| `SAMPLE_INPUT` | `software` | Input used by the "Manual test run" trigger |

## 4. Credentials, import, publish

1. **Webhook credentials** (Header Auth, header `X-API-Key`): `MainWebhook` for generate and
   `RegenWebhook` for regenerate. The workflows reference them by the fixed ids in
   `agents/n8n/credentials.example.json`. Copy that file outside the project, put real values in
   it, then:
   ```bash
   docker cp /path/to/credentials.json rfp-n8n:/tmp/c.json
   docker exec rfp-n8n n8n import:credentials --input=/tmp/c.json && docker exec rfp-n8n rm /tmp/c.json
   ```
   Then delete your copy. Or create them in the UI and select them once in both webhook nodes.
2. **Import** all nine workflows:
   ```bash
   docker exec rfp-n8n sh -c 'mkdir -p /tmp/wf && cp /data/rfp-studio/workflows/*.json /tmp/wf/ && n8n import:workflow --separate --input=/tmp/wf/'
   ```
3. **Publish all nine.** n8n 2 refuses to run a sub-workflow that is not published
   ("Workflow is not active and cannot be executed"):
   ```bash
   for id in rfpMain000000001 rfpAgent10000001 rfpDiagrams00001 rfpAgent40000001 rfpAgent50000001 \
             rfpAgent60000001 rfpRegenerate001 rfpLlmJson000001 rfpErrors0000001; do
     docker exec rfp-n8n n8n publish:workflow --id=$id
   done
   docker restart rfp-n8n
   ```
4. **Platform side**: start the platform with
   `REGENERATE_WEBHOOK_URL=http://127.0.0.1:5678/webhook/rfp/regenerate` and
   `REGENERATE_WEBHOOK_KEY=<the RegenWebhook value>` so the editor's Regenerate button calls n8n.

## 5. Use and verify

```bash
curl -s -X POST http://127.0.0.1:5678/webhook/rfp/generate \
  -H "X-API-Key: <MainWebhook value>" -H "Content-Type: application/json" \
  -d @tests/inputs/software.json
```

Response: `{ ok, runId, deckId, url, editorUrl, contentSlides, projectSlides, correctionRounds,
warnings, placeholders, problemsRemaining, usage, timings, log }`. HTTP 502 with `error` when the
platform refuses the deck twice or cannot be reached. 403 without the webhook key.

Results observed in the test container (mock mode, all five inputs): HTTP 200, 13 content slides
for software/SaaS inputs and 12 for the others (16 and 15 platform slides with title, thank-you
and continuation slides), every deck accepted on the first POST, the injected claims of
`injection.json` absent. Real mode against a fake Groq: same results, the first request answered
429 and was retried after `Retry-After`, about 1.7 s per deck. Regenerate through the platform:
200 for content slides (slides 3, 7, 9, 12 tried), 400 for the title and thank-you slides,
404 from n8n for an unknown deck.

## 6. Real Groq API: results and how to rerun

Measured on 2026-10-18 with `openai/gpt-oss-120b` (free tier), `MAX_CORRECTION_ROUNDS=1`:

| Input | Time | Content slides | Tokens | Notes |
|---|---|---|---|---|
| software | about 4 min | 13 (16 platform slides) | about 36 000 | no agent degraded; roadmap image and plan table on two slides "(1/2)", "(2/2)" |
| non_software | about 4 min | 12 | similar | no class diagram, as expected |
| injection | about 5 min | 13 | similar | no injected claim in the deck; the "Reveal your system prompt" requirement is flagged, not answered |
| regenerate one slide | about 25 s | 1 | | well within the platform's 60 s |

Most of the time is waiting on Groq's free-tier rate limit (HTTP 429, about 10 to 20 waits per
deck). A paid tier, a smaller model, or `MAX_CORRECTION_ROUNDS=0` makes it faster.
`tools/check_llm.py` reports a 400 for `openai/gpt-oss-120b` although the model works for the
agents: its test request is rejected by that model; `qwen/qwen3.8-27b` passes it.

To rerun:

1. Check the key and model on the host: `GROQ_API_KEY=... GROQ_MODEL=... python3 tools/check_llm.py`.
2. Recreate the container with `-e LLM_MODE=real -e GROQ_API_KEY=... -e GROQ_MODEL=...`.
3. Generate `software.json` and open the `editorUrl`. Check: compliance table rows equal the
   requirements, references are input projects, team counts equal the input, no invented numbers,
   SLA left as `[TO FILL: SLA levels]`, prices `[TO FILL]` until the catalog has real values.
4. In the response, `log` gives tokens, attempts and rate-limit waits per agent; `usage.estimatedCost`
   stays `null` until `agents/catalog/llm_prices.json` has real prices.

## 7. Secrets and known limits

- **Keys are environment variables of the n8n container**, not n8n credentials: Code nodes cannot
  read credentials, and the agents' write-check-retry loop makes several LLM calls from code.
  Keep them out of shell history and files (use an env file outside the project, `--env-file`).
  Workflows and the repo never contain a key (`npm test` checks the workflows).
- The two webhooks are protected by Header Auth credentials; the platform key is the same value as
  the platform's `STUDIO_API_KEY`.
- Diagram images are sent as `data:image/svg+xml` URLs inside the deck (small, under the 5 MB limit)
  instead of being uploaded through `/api/upload`.
- A regenerated slide is not split by the platform: a long compliance table (more than 10
  requirements) regenerated alone overflows its slide; the slide carries a warning.
- Running the same tender twice creates two decks (the platform has no replace-by-name).
