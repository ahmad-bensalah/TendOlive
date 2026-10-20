# Agent Part — n8n Workflows for RFP Deck Generation

This directory contains the complete n8n agent system that generates RFP slide decks from tender matching data.

## Architecture

```
Input (tender + match data)
  ↓
Orchestrator (00_main.json)
  ↓
├─→ Agent 1: Requirements (s1, s2, s3, s11)
├─→ Agent 2+3: Diagrams (s3b, s3c, s5, s10)
├─→ Agent 4: Budget (s9)
├─→ Agent 5: Credibility (s4, s6, s7, s8)
├─→ Agent 6: Reviewer (correction loop)
  ↓
Merge & Validate
  ↓
POST /api/decks → Slide Editor → Human → Export
```

## Directory Structure

- **`lib/`**: Pure JavaScript functions (no require, no n8n objects)
  - `input.js`: Normalize input, injection scan
  - `contracts.js`: Schema validation mirroring layout_engine.py
  - `checks.js`: Number, name, claim, placeholder checks
  - `rank.js`: Reference project ranking
  - `budget.js`: Price calculator (integer cents)
  - `merge.js`: Slide ordering, ID stripping, deck building
  - `llm.js`: Prompt helpers, safe JSON parse, usage accounting
  - `log.js`: Run logging and cost estimation
  - `svg.js`: Deterministic SVG fallback renderer

- **`prompts/`**: System prompts per agent (agent1.md through agent6.md)

- **`render_service/`**: Optional local HTTP service for Mermaid validation/rendering

- **`catalog/`**: Price catalog and LLM token pricing

- **`fixtures/`**: Mock LLM responses for testing (agent/input pairs)

- **`tools/`**: Utilities
  - `platform_manifest.json`: SHA-256 hashes of platform files
  - `guard_check.js`: Verifies platform files unchanged
  - `platform_facts.js`: API behavior verification
  - `embed_check.js`: Verifies Code nodes match lib/
  - `embed.js`: Rewrites Code node blocks from lib/
  - `run_eval.js`: Evaluation runner

- **`tests/`**: Node.js test suite (run with `node --test agents/tests`)

## Workflows

See `../workflows/README.md` for the complete list. Main workflows:

- **00_main.json**: Orchestrator
- **10_agent1_requirements.json**: Requirements and solution
- **20_diagrams.json**: Architecture and planning diagrams
- **30_agent4_budget.json**: Financial proposal
- **40_agent5_credibility.json**: Credibility and references
- **50_agent6_reviewer.json**: Review and correction loop
- **60_regenerate.json**: Single slide regeneration webhook
- **70_llm_json.json**: Shared LLM caller (Groq)
- **90_error_handler.json**: Error handling

## Running

1. **Platform**: Start the slide editor: `./start.sh 8091`
2. **n8n**: Import workflows from `../workflows/`
3. **Credentials**: Create in n8n (see `../docs/N8N_SETUP.md`):
   - `Studio` (Header Auth, `X-API-Key`)
   - `Groq` (Bearer token)
   - `RegenWebhook` (Header Auth)
4. **Variables** (n8n):
   - `STUDIO_BASE_URL` (http://localhost:8091 or http://host.docker.internal:8091)
   - `GROQ_MODEL` (e.g., llama-3.3-70b-versatile)
   - `LLM_MODE` (mock or real)
   - `MAX_CORRECTION_ROUNDS` (default 2)

## Testing

```bash
# Node.js tests (contracts, checks, pure logic)
node --test agents/tests

# Integration tests (needs platform running)
node agents/tools/run_eval.js

# Platform tests (baseline)
RFP_FAST=1 python3 -m unittest discover tests
```

## Guard Check

After every phase, verify no platform files changed:

```bash
node agents/tools/guard_check.js
```

Exit code 0 = PASS (all files intact), 1 = FAIL.

## Documentation

- `../docs/agents/CONTRACTS.md`: Input/output contracts
- `../docs/agents/PLATFORM_FACTS.md`: API behavior verification results
- `../docs/agents/RUNBOOK.md`: Operations guide
- `../docs/agents/EVAL_REPORT.md`: Evaluation results
- `../docs/agents/INTEGRATE_AGENTS.md`: Teammate integration status

## Key Constraints

- **Platform is read-only**: Never modify existing files
- **Code checks come first**: LLM only writes, code verifies
- **Never invent facts**: Missing data becomes `[TO FILL: ...]`
- **No secrets in files**: Use n8n credentials only
- **All failures are graceful**: Placeholders + warnings, never crash

## Motto

**"Agents write. Code checks. Human approves."**
