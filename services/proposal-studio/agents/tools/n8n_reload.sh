#!/usr/bin/env bash
# Regenerates the workflows from agents/lib, imports them into the n8n container, publishes all nine
# (n8n 2 runs only published sub-workflows) and restarts n8n.
# Usage: agents/tools/n8n_reload.sh [container]   (default container: rfp-n8n)
set -euo pipefail
C="${1:-rfp-n8n}"
cd "$(dirname "$0")/../.."
node agents/tools/generate_workflows.js
node agents/tools/embed_check.js
docker exec "$C" sh -c 'rm -rf /tmp/wf && mkdir -p /tmp/wf && cp /data/rfp-studio/workflows/*.json /tmp/wf/ && n8n import:workflow --separate --input=/tmp/wf/' 2>&1 | grep -i "imported"
for id in rfpMain000000001 rfpAgent10000001 rfpDiagrams00001 rfpAgent40000001 rfpAgent50000001 \
          rfpAgent60000001 rfpRegenerate001 rfpLlmJson000001 rfpErrors0000001; do
  docker exec "$C" n8n publish:workflow --id="$id" >/dev/null 2>&1 || { echo "publish failed: $id"; exit 1; }
done
docker restart "$C" >/dev/null
for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:5679/healthz && break; sleep 1; done
sleep 5
echo "n8n reloaded: 9 workflows published"
