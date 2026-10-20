# Setup guide: the complete RFP Deck Studio on your machine

This guide rebuilds the full working setup: the slide platform, the AI agents in n8n, the
OliveSoft templates, the tenders list and the "Générer le deck" button. At the end, you open
<http://localhost:8091>, click **Générer le deck** on a tender, and get an OliveSoft deck in a few
minutes.

Time needed: about 30 minutes. Commands are for Linux or macOS (on Windows, use WSL).

```
Browser  ──►  Platform (Python, port 8091)  ──►  n8n in Docker (port 5679)  ──►  Groq (AI)
                 ▲                                      │
                 └──────── deck + progress ─────────────┘
```

---

## 1. What you need

| Tool | Version | Check |
|---|---|---|
| Python | 3.10 or newer | `python3 --version` |
| Node.js | 18 or newer | `node --version` |
| Docker | any recent | `docker --version` |
| A Groq account | free tier works | <https://console.groq.com> → API Keys → create a key |

Keep the Groq key private: never put it in the project folder, a chat or a git commit.

---

## 2. Get the project and install it

Put the project folder (`rfp-studio/`) in a parent folder of your choice, then:

```bash
cd rfp-studio/..                 # the folder that CONTAINS rfp-studio
python3 -m venv .venv            # the virtual environment sits next to the project
source .venv/bin/activate
pip install -r rfp-studio/requirements.txt
playwright install chromium      # browser used for PDF / PPTX export and template previews
```

Check:

```bash
cd rfp-studio
python3 -m unittest tests.test_save        # must end with OK
node --test agents/tests/*.test.js 2>&1 | grep "^# fail"   # must print "# fail 0"
```

---

## 3. Create your private keys folder

Everything secret lives in `~/.rfp-secrets/`, outside the project, readable only by you.

```bash
mkdir -p ~/.rfp-secrets && chmod 700 ~/.rfp-secrets && cd ~/.rfp-secrets && umask 077

# 1. Your Groq key (replace the value)
echo 'GROQ_API_KEY=gsk_REPLACE_WITH_YOUR_KEY' > groq.env

# 2. Three random keys: the platform key and the two n8n webhook keys
printf 'STUDIO_KEY=%s\nMAIN_HOOK_KEY=%s\nREGEN_HOOK_KEY=%s\n' \
  "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" > keys.env
```

Check that the Groq key works (from the project folder, virtual environment active):

```bash
set -a; . ~/.rfp-secrets/groq.env; set +a
GROQ_MODEL=qwen/qwen3.8-27b python3 tools/check_llm.py     # prints "OK: ..."
```

---

## 4. The platform start script

Create `~/.rfp-secrets/start_platform.sh` (adapt the `cd` line to where your project is):

```bash
#!/usr/bin/env bash
# Starts the platform on :8091, wired to n8n on :5679. Keys from ~/.rfp-secrets/keys.env
set -a; . ~/.rfp-secrets/keys.env; set +a
cd ~/PATH/TO/rfp-studio                      # <-- your project folder
source ../.venv/bin/activate
export STUDIO_API_KEY="$STUDIO_KEY"
# Regenerate one slide (editor button)
export REGENERATE_WEBHOOK_URL="http://127.0.0.1:5679/webhook/rfp/regenerate"
export REGENERATE_WEBHOOK_KEY="$REGEN_HOOK_KEY"
# Generate a deck (home page button); the agents push their progress back
export GENERATE_WEBHOOK_URL="http://127.0.0.1:5679/webhook/rfp/generate"
export GENERATE_WEBHOOK_KEY="$MAIN_HOOK_KEY"
export GENERATE_TIMEOUT_SECONDS=1500
exec ./start.sh 8091
```

```bash
chmod +x ~/.rfp-secrets/start_platform.sh
~/.rfp-secrets/start_platform.sh            # leave this terminal open
```

Open <http://localhost:8091>: the home page shows three sections (Appels d'offres sélectionnés,
Projets récents, Modèles).

---

## 5. n8n (the AI agents) in Docker

### 5.1 Settings file

```bash
cd ~/.rfp-secrets && umask 077 && set -a && . ./keys.env && . ./groq.env && set +a
cat > n8n.env <<EOF
N8N_BLOCK_ENV_ACCESS_IN_NODE=false
NODE_FUNCTION_ALLOW_BUILTIN=fs,path,crypto
N8N_SECURE_COOKIE=false
N8N_RUNNERS_TASK_TIMEOUT=1200
RFP_STUDIO_DIR=/data/rfp-studio
AGENTS_REGISTRY_DIR=/home/node/.n8n/rfp-registry
STUDIO_BASE_URL=http://host.docker.internal:8091
PUBLIC_EDITOR_URL=http://localhost:8091
STUDIO_API_KEY=$STUDIO_KEY
LLM_MODE=real
GROQ_API_KEY=$GROQ_API_KEY
GROQ_MODEL=openai/gpt-oss-20b
MAX_CORRECTION_ROUNDS=0
EOF
```

| Setting | Why |
|---|---|
| `LLM_MODE=real` | Real AI. Use `mock` to test without Groq (answers come from test files). |
| `GROQ_MODEL=openai/gpt-oss-20b` | Fast model. Each Groq model has its own free daily quota (200 000 tokens a day; a deck uses about 36 000). When it is used up, switch model (for example `openai/gpt-oss-120b` or `qwen/qwen3.8-27b`) and recreate the container (5.2). |
| `MAX_CORRECTION_ROUNDS=0` | The review step lists its remarks as warnings instead of re-running agents (minutes faster on the free tier). |
| `N8N_RUNNERS_TASK_TIMEOUT=1200` | n8n stops a step after 300 s by default; Groq waits can be longer. |

### 5.2 Start the container

```bash
cd ~/PATH/TO/rfp-studio                       # <-- your project folder
docker run -d --name rfp-n8n --restart unless-stopped \
  -p 127.0.0.1:5679:5678 --add-host=host.docker.internal:host-gateway \
  -v "$PWD":/data/rfp-studio:ro -v rfp-n8n-data:/home/node/.n8n \
  --env-file ~/.rfp-secrets/n8n.env n8nio/n8n:latest
curl -s http://127.0.0.1:5679/healthz         # {"status":"ok"} after ~20 s
```

n8n listens on port **5679** on your machine (5678 is often taken). `--restart unless-stopped`
restarts it automatically after a reboot. After changing `n8n.env`, recreate the container:
`docker rm -f rfp-n8n` then the same `docker run` command.

### 5.3 Webhook credentials (once)

```bash
cd ~/PATH/TO/rfp-studio
set -a; . ~/.rfp-secrets/keys.env; set +a; umask 077
python3 - <<'EOF'
import json, os
c = json.load(open('agents/n8n/credentials.example.json'))
c[0]['data']['value'] = os.environ['MAIN_HOOK_KEY']
c[1]['data']['value'] = os.environ['REGEN_HOOK_KEY']
json.dump(c, open(os.path.expanduser('~/.rfp-secrets/credentials.json'), 'w'))
EOF
docker cp ~/.rfp-secrets/credentials.json rfp-n8n:/tmp/c.json
docker exec rfp-n8n n8n import:credentials --input=/tmp/c.json
docker exec -u root rfp-n8n rm -f /tmp/c.json; rm -f ~/.rfp-secrets/credentials.json
```

### 5.4 Import and publish the nine workflows

```bash
agents/tools/n8n_reload.sh       # prints "n8n reloaded: 9 workflows published"
```

Run the same command after any change in `agents/lib/`: it regenerates the workflows from the
code, imports them, publishes them and restarts n8n.

Check: `curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:5679/webhook/rfp/generate`
prints **403** (the webhook exists and refuses calls without the key).

---

## 6. Content: templates, tenders, prices

### Templates (OliveSoft design)
Put the `.pptx` templates in `templates/inbox/`, then click **Recharger** in the **Modèles**
section (or restart the platform). The two reference templates (`template 1.pptx`,
`template 2.pptx`) are already there. How a template must be built (cover, Sommaire with
"place1" slots, À propos, content page with "Titre de la diapositive" / "Contenu", closing page):
see [`templates/TEMPLATE_GUIDE.md`](../templates/TEMPLATE_GUIDE.md). Choose the default template with
**Définir par défaut**.

### Tenders
One JSON file per tender in `tenders/inbox/` (the RAG step's `olivesoft.proposal-input.v2` format,
example: `agents/fixtures/inputs/proposal_v2_example.json`), then **Recharger** in the tenders
section. Demo tenders: `python3 tools/seed_demo_tenders.py`.

### Prices
Prices come from `agents/catalog/pricing_catalog.json`. To load OliveSoft's rates, fill the
`value` column of a copy of `agents/catalog/rates.template.csv` and run
`node agents/tools/import_catalog.js my_rates.csv`. Rows whose note contains "ESTIMATE" mark the
catalog as estimated: the budget slide then says "Tarifs estimés, à confirmer".

---

## 7. First deck

1. Open <http://localhost:8091>.
2. On a tender, click **Générer le deck**, choose the template and the options, click **Générer**.
3. Watch the steps (Exigences, Atouts, Diagrammes, Budget, Revue, Assemblage): 2 to 5 minutes.
4. Click **Ouvrir le deck**. In the editor, open the **Revue** panel: it lists every
   `[TO FILL: ...]` to complete and the warnings. Tick the pricing approval, then export PDF or PPTX.

Each content slide has a **Régénérer** button that asks the agents for a new version of that slide.

---

## 8. Every day

| Task | Command |
|---|---|
| Start the platform | `~/.rfp-secrets/start_platform.sh` (n8n restarts by itself) |
| Start n8n if stopped | `docker start rfp-n8n` |
| After changing agent code | `node --test agents/tests/*.test.js` then `agents/tools/n8n_reload.sh` |
| n8n logs | `docker logs --since 10m rfp-n8n` |
| Agent errors | `docker exec rfp-n8n tail -5 /home/node/.n8n/rfp-registry/errors.jsonl` |
| Change the AI model | edit `GROQ_MODEL` in `~/.rfp-secrets/n8n.env`, recreate the container (5.2) |

---

## 9. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| **Générer le deck** is greyed out | The platform was started without `GENERATE_WEBHOOK_URL`: start it with `~/.rfp-secrets/start_platform.sh`. |
| The panel shows **Échec**, "quota du fournisseur IA atteint (limite quotidienne)" | The Groq daily quota of that model is used: switch `GROQ_MODEL` (5.1) and recreate the container, or wait. |
| A step stays "en cours" more than 10 minutes | `docker logs --since 15m rfp-n8n` and the errors file above. Restart n8n (`docker restart rfp-n8n`). |
| HTTP 502 "Le service des agents (n8n) est injoignable" | n8n is not running: `docker start rfp-n8n`. |
| 403 on the webhooks with the right key | The credentials were not imported (5.3). |
| "Workflow is not active" in n8n logs | Run `agents/tools/n8n_reload.sh` (all nine workflows must be published). |
| `Address already in use` on 8091 | A platform is already running: `ss -ltnp | grep 8091`, stop it, start again. |
| Images missing in exports | Install the browser: `playwright install chromium`. |
| Template looks wrong | Check it against `templates/TEMPLATE_GUIDE.md`, then **Recharger**. |

More detail: [`docs/agents/N8N_WORKFLOWS.md`](agents/N8N_WORKFLOWS.md) (the workflows),
[`README.md`](../README.md) (platform API and deck format).
