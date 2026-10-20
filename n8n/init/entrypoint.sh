#!/bin/sh
# n8n with the RFP workflows: init (credentials from .env, workflows imported and published when they changed), then n8n itself.
# The deck agents' LLM settings (GROQ_BASE_URL / GROQ_API_KEY / GROQ_MODEL, computed from LLM_PROVIDER) reach n8n through a pipe
# and `eval`, never a file or a log.
set -eu

node /opt/rfp/init.js prepare

AGENTS_LLM_EXPORTS="$(node /opt/rfp/init.js env)"
eval "$AGENTS_LLM_EXPORTS"
unset AGENTS_LLM_EXPORTS

echo "[rfp-init] starting n8n: editor http://localhost:5679 (published webhooks register now)"
exec /docker-entrypoint.sh "$@"
