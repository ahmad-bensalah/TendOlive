# Workflows Directory

This directory stores exported n8n agent workflow JSON files.

## Instructions:
1. Export your n8n workflows as JSON and place them here.
2. Standard naming conventions:
   - **`diagrams.json`**: For Teammate 1's Architecture and Planning diagram agents.
   - **`credibility.json`**: For Teammate 2's Credibility (Agent 5) agent.
3. **Security Warning**: NEVER include credentials, API keys, webhook secrets, or private tokens inside exported workflow JSON files.

## Agent workflows (generated)

`00_main.json` to `90_error_handler.json` are generated from `agents/lib/` by
`npm run workflows:generate`; do not edit them in n8n. Import all nine, publish all nine
(n8n 2 requires it for sub-workflows), and set the environment variables listed in
[`docs/agents/N8N_WORKFLOWS.md`](../docs/agents/N8N_WORKFLOWS.md). Teammates' own versions go in
`workflows/teammates/` and are never overwritten.
