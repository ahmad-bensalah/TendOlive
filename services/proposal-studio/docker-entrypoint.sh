#!/bin/sh
# Container entrypoint of the proposal studio (his code unchanged: only its environment is set here).
#   no arguments  -> the studio: python server.py 8091
#   arguments     -> that command instead, e.g. the tests: docker compose run --rm --no-deps proposal-studio python -m unittest discover tests
# GROQ_MODELS (the model list of its "Generer le deck" dialog) = the model the deck agents use in n8n: DECK_LLM_MODEL / LLM_MODEL,
# or the default model of DECK_LLM_PROVIDER (else LLM_PROVIDER) in n8n/llm.json (the table n8n/init/init.js uses too).
set -eu

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

if [ -z "${GROQ_MODELS:-}" ]; then
  GROQ_MODELS="$(python - <<'EOF'
import json, os, sys
table = json.load(open("/opt/rfp/llm.json", encoding="utf-8"))
main = (os.environ.get("LLM_PROVIDER") or "groq").strip().lower()
provider = (os.environ.get("DECK_LLM_PROVIDER") or main).strip().lower()
model = (os.environ.get("DECK_LLM_MODEL") or (os.environ.get("LLM_MODEL") if provider == main else "") or "").strip()
if not model:
    entry = table.get(provider) if not provider.startswith("_") else None
    if entry is None:
        sys.stderr.write(f"[studio] LLM_PROVIDER={provider} is not one of groq, gemini, openai, ollama: the model list stays the studio default\n")
    else:
        model = entry["defaultModel"]
print(model)
EOF
)"
  export GROQ_MODELS
fi
if [ -z "${STUDIO_API_KEY:-}" ] || [ -z "${GENERATE_WEBHOOK_KEY:-}" ]; then
  echo "[studio] CONFIGURATION ERROR: STUDIO_API_KEY and AGENTS_WEBHOOK_KEY must be set in .env (see .env.example)" >&2
  exit 2
fi
echo "[studio] generate mode ${GENERATE_MODE:-webhook} -> ${GENERATE_WEBHOOK_URL:-?}; model list: ${GROQ_MODELS:-studio default}"
exec python server.py "${STUDIO_PORT:-8091}"
