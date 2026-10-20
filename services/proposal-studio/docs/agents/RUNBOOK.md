# RFP Deck Studio - Agent System Runbook

## Overview

This runbook covers deployment, configuration, operation, and troubleshooting of the RFP agent system.

**System Status:** Production Ready (after real LLM integration)

**Components:**
- Agent logic (JavaScript libraries in `agents/lib/`)
- n8n workflows (to be built: `workflows/*.json`)
- Pricing catalog (`agents/catalog/pricing_catalog.json`)
- Registry storage (`agents/registry/`)

---

## Prerequisites

### Platform Requirements
- RFP Deck Studio platform running on `http://localhost:8091` (or configured URL)
- Platform API key set in environment: `STUDIO_API_KEY`
- Python 3.8+ with requirements installed
- Node.js 18+ for agent tests

### n8n Requirements
- n8n instance (native or Docker)
- Node.js 18+ (for n8n)
- Groq API key (for real LLM calls)

### Docker-Specific
If running n8n in Docker:
- Use `http://host.docker.internal:8091` as platform base URL
- Linux: add `--add-host=host.docker.internal:host-gateway` to docker run

---

## Configuration

### 1. Platform API Key

**Shared dev key** (from `START_HERE.md`):
```bash
export STUDIO_API_KEY="your-key-here"
```

**Production:** Use separate keys per environment, never commit them.

### 2. n8n Credentials

Create these credentials in n8n (Settings → Credentials):

**Studio (Header Auth)**
- Name: `Studio`
- Header Name: `X-API-Key`
- Value: `${STUDIO_API_KEY}` (from environment or n8n variable)

**Groq (HTTP Request - Bearer Auth)**
- Name: `Groq`
- Authentication: Bearer Token
- Token: Your Groq API key

**RegenWebhook (Header Auth)** - Optional
- Name: `RegenWebhook`
- Header Name: `X-API-Key`
- Value: Strong random key (if `REGENERATE_WEBHOOK_KEY` is set in platform)

**MainWebhook (Header Auth)** - Optional
- Name: `MainWebhook`
- For incoming generate requests

### 3. n8n Variables

Set these in n8n (Settings → Variables):

**Required:**
- `STUDIO_BASE_URL`: `http://localhost:8091` or Docker variant
- `GROQ_MODEL`: `llama-3.1-70b-versatile` (or your chosen model)
- `LLM_MODE`: `mock` for testing, `real` for production

**Optional:**
- `MODEL_AGENT1`: Override model for Agent 1
- `MODEL_AGENT4`: Override model for Agent 4  
- `MODEL_AGENT6`: Override model for Agent 6 (stronger recommended)
- `QR_URL_TEMPLATE`: Template with `{deckId}` placeholder (empty = no QR)
- `PUBLIC_EDITOR_URL`: Base URL for editor links
- `MAX_CORRECTION_ROUNDS`: Default 2
- `MAX_TOKENS_PER_RUN`: Hard cap on total tokens (e.g., 50000)

### 4. Pricing Catalog

Update `agents/catalog/pricing_catalog.json` with real OliveSoft values:
- Daily rates per role (backend, frontend, devops, pm, designer, qa)
- Cloud infrastructure costs
- API/LLM token prices
- License costs

**Until updated:** All prices are 0, slides show `[TO FILL: tarif <item>]` placeholders.

---

## Startup Sequence

### 1. Start Platform

```bash
cd rfp-studio
./start.sh
```

Verify: `curl http://localhost:8091/health` should return 200.

### 2. Run Pre-flight Checks

```bash
# Check platform connection
node agents/tools/platform_facts.js

# Check LLM availability (real mode only)
python3 tools/check_llm.py

# Run all agent tests
npm test

# Platform tests baseline
python3 -m unittest discover tests
```

All should pass (or show expected baseline).

### 3. Start n8n

**Native:**
```bash
n8n start
```

**Docker:**
```bash
docker run -d \
  --name n8n \
  -p 5678:5678 \
  -v ~/.n8n:/home/node/.n8n \
  --add-host=host.docker.internal:host-gateway \
  n8nio/n8n
```

### 4. Import Workflows

1. Open n8n: `http://localhost:5678`
2. Import workflows in order:
   - `70_llm_json.json` (shared LLM caller)
   - `90_error_handler.json`
   - `00_main.json` (orchestrator)
   - `10_agent1_requirements.json`
   - `40_agent5_credibility.json`
   - `20_diagrams.json`
   - `30_agent4_budget.json`
   - `50_agent6_reviewer.json`
   - `60_regenerate.json`
3. Configure credentials for each workflow
4. Activate all workflows

### 5. Test End-to-End

**Mock mode:**
```bash
curl -X POST http://localhost:5678/webhook/rfp/generate \
  -H "Content-Type: application/json" \
  -d @tests/inputs/software.json
```

**Expected:** Returns `{ deckId, url, editorUrl, ... }` within 30s (mock mode).

**Real mode:** Set `LLM_MODE=real` and test with one input first.

---

## Health Checks

### Platform Health

```bash
# Basic health
curl http://localhost:8091/health

# API with auth
curl -H "X-API-Key: $STUDIO_API_KEY" \
  http://localhost:8091/api/decks
```

### n8n Health

```bash
# n8n UI
curl http://localhost:5678

# Webhook endpoint (if exposed)
curl http://localhost:5678/webhook-test/ping
```

### Registry Health

```bash
# List stored decks
ls -la agents/registry/ | wc -l

# Check disk usage
du -sh agents/registry/
```

**Alert if:** Registry > 50 MB or > 300 files (purge threshold: 200).

---

## Common Errors and Troubleshooting

### Error: 401 Unauthorized

**Symptom:** `POST /api/decks` returns 401

**Causes:**
1. Missing or wrong `STUDIO_API_KEY`
2. n8n credential not configured
3. Key expired or changed

**Fix:**
```bash
# Check key is set
echo $STUDIO_API_KEY

# Test directly
curl -H "X-API-Key: $STUDIO_API_KEY" \
  http://localhost:8091/api/decks

# Update n8n credential if needed
```

---

### Error: 400 Bad Request (validation errors)

**Symptom:** `POST /api/decks` returns 400 with `errors[]`

**Causes:**
1. Unknown slide field (extra fields not allowed)
2. Unknown block kind
3. Table cells not strings (numbers must be stringified)
4. Missing required fields

**Fix:**
1. Check `errors[]` array in response
2. Verify against `deck.schema.json`
3. Run contract tests: `npm run test:contracts`
4. Check platform facts: `node agents/tools/platform_facts.js`

**Common mistakes:**
- Using `chart` block (doesn't exist, use `image`)
- Passing number in table cell instead of string
- Adding custom fields to slide
- Wrong `bulletStyle` value

---

### Error: 413 Payload Too Large

**Symptom:** Request rejected, deck > 5 MB

**Causes:**
1. Too many large images embedded as data URLs
2. Very long text blocks

**Fix:**
1. Upload images to `/api/upload` first, use returned URLs
2. Truncate excessively long text
3. Remove unnecessary data

---

### Error: Groq 429 Rate Limit

**Symptom:** LLM calls fail with 429, workflow slows down

**Causes:**
1. Free tier rate limits hit
2. Too many concurrent LLM calls
3. Requests too frequent

**Fix:**
1. **Automatic:** Shared LLM caller handles retries with exponential back-off
2. **Manual:** Wait 60s and retry
3. **Prevention:** Limit parallelism (max 2 concurrent LLM calls), add small delays between calls

**Check rate limits:**
- Groq free tier: ~14K requests/day, ~30 requests/minute
- Documented at: https://console.groq.com/docs/rate-limits

---

### Error: Regenerate 504 Timeout

**Symptom:** Regenerate button in editor times out

**Causes:**
1. Agent takes > 60s (platform timeout)
2. Diagrams workflow too slow
3. n8n workflow not responding

**Fix:**
1. **Fallback:** After 45s, return current slide with warning (implemented)
2. **Long-term:** Optimize diagram generation (use fallback SVG)
3. Check n8n logs for stuck nodes

---

### Error: Docker Can't Reach Platform

**Symptom:** n8n in Docker gets connection errors to platform

**Causes:**
1. Using `localhost:8091` instead of `host.docker.internal:8091`
2. Missing `--add-host` flag (Linux only)

**Fix:**
```bash
# Stop container
docker stop n8n

# Linux: add host mapping
docker run -d \
  --name n8n \
  -p 5678:5678 \
  -v ~/.n8n:/home/node/.n8n \
  --add-host=host.docker.internal:host-gateway \
  n8nio/n8n

# Update STUDIO_BASE_URL in n8n variables
# to http://host.docker.internal:8091
```

---

### Error: Missing Dependencies

**Symptom:** Platform or n8n startup fails

**Fix:**
```bash
# Platform dependencies
cd rfp-studio
pip install -r requirements.txt

# n8n (if native)
npm install -g n8n

# Agent tests
cd rfp-studio
# No dependencies needed (pure Node.js)
```

---

### Error: Placeholders in Output

**Symptom:** Deck has `[TO FILL: ...]` in many places

**Causes:**
1. **Expected:** Pricing catalog has zero values → pricing placeholders
2. **Expected:** Input missing data (no similar projects, no requirements)
3. **Problem:** Agent failing silently → placeholder slides

**Fix:**
1. Check `warnings` array in response
2. If pricing: Update `agents/catalog/pricing_catalog.json`
3. If input: Provide richer input data
4. If agent failure: Check n8n logs, LLM responses

**Verify agents ran:**
```json
{
  "usage": {
    "agent1": { "attempts": 1, "ms": 1500 },
    "agent5": { "attempts": 1, "ms": 2000 },
    ...
  }
}
```

If `attempts: 0` or missing → agent didn't run.

---

## Monitoring

### Metrics to Track

1. **Success rate:** Decks created successfully / total runs
2. **Placeholder count:** Average placeholders per deck
3. **LLM costs:** Total tokens × price (from log entries)
4. **Latency:** P50, P95, P99 response times
5. **Error rate:** 4xx/5xx responses per endpoint
6. **Registry size:** Disk usage, file count

### Logs

**Platform logs:**
```bash
# Server output
tail -f path/to/platform.log

# Or stderr if running in terminal
```

**n8n logs:**
```bash
# Docker
docker logs -f n8n

# Native
~/.n8n/logs/
```

**Agent logs:**
- Workflow execution logs in n8n UI
- JSONL run logs (if enabled in config)

---

## Backup and Recovery

### Backup

**Registry:**
```bash
# Daily backup
tar -czf registry-backup-$(date +%Y%m%d).tar.gz agents/registry/
```

**Workflows:**
```bash
# Export from n8n UI → Download as JSON
# Store in git or backup location
```

**Pricing catalog:**
```bash
# Part of git repository
git log agents/catalog/pricing_catalog.json
```

### Recovery

**Lost registry:**
- Decks in platform are unaffected (still editable)
- Regenerate won't work for old decks
- New decks create new registry entries

**Lost workflows:**
- Re-import from git or backup
- Reconfigure credentials

---

## Security

### Secrets Management

**Never commit:**
- API keys
- Groq tokens
- Webhook secrets

**Storage:**
- Environment variables (platform)
- n8n credentials store (encrypted)
- External secrets manager (production)

### Audit

Run secrets scan:
```bash
# Check for exposed keys
grep -r "gsk_" agents/
grep -r "sk-" agents/
grep -r "Bearer" workflows/

# Should find nothing
```

### Prompt Injection Defense

Verify injection tests pass:
```bash
# Run injection fixture through all agents
npm test | grep injection

# All must pass (no injected claims in output)
```

---

## Performance Tuning

### Reduce Latency

1. **Use faster models** for non-critical agents (Agent 1, Agent 4)
2. **Parallelize** Agent 1 and Agent 5 (independent)
3. **Cache** diagram SVGs (if same components reused)
4. **Preload** pricing catalog once at startup

### Reduce Cost

1. **Mock mode** for development/testing
2. **Smaller models** where appropriate (8B instead of 70B)
3. **Truncate inputs** aggressively (keep only essential data)
4. **Hard cap** per run: `MAX_TOKENS_PER_RUN`

### Scale Limits

**Single n8n instance:**
- ~10 concurrent deck generations
- Limited by Groq rate limits (free tier)

**To scale:**
- Multiple n8n instances with load balancer
- Paid Groq tier (higher limits)
- Queue system (Redis + workers)

---

## Maintenance

### Weekly

- Check registry size, purge if > 200 decks
- Review error logs, fix recurring issues
- Update pricing catalog if rates changed

### Monthly

- Review LLM costs vs budget
- Audit for security (secrets scan)
- Test with latest platform version
- Update dependencies (platform, n8n)

### Quarterly

- Evaluate model performance (accuracy, cost)
- Review and update system prompts
- Performance benchmarks (latency, quality)

---

## Contact and Support

**Platform issues:** See `START_HERE.md` and platform README

**Agent issues:** Check this runbook first, then:
1. Run diagnostic tests: `npm test`
2. Check n8n execution logs
3. Review `docs/agents/` documentation

**Known issues:** See GitHub issues (if applicable) or project tracker

---

## Appendices

### A. Useful Commands

```bash
# Full system test (mock mode)
npm test && npm run test:platform

# Check guard (no files changed)
npm run guard

# Platform facts verification
node agents/tools/platform_facts.js

# Export a deck to PDF
python3 tools/export_deck.py <deckId> --pdf

# List registry
node -e "console.log(require('./agents/lib/registry.js').listDecks())"

# Purge old registry entries
node -e "require('./agents/lib/registry.js').purgeOldDecks(100)"
```

### B. Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `STUDIO_API_KEY` | Yes | - | Platform API key |
| `STUDIO_BASE_URL` | Yes (n8n) | `http://localhost:8091` | Platform URL |
| `GROQ_MODEL` | Yes (real) | - | Default LLM model |
| `LLM_MODE` | Yes | `mock` | `mock` or `real` |
| `QR_URL_TEMPLATE` | No | - | QR code URL template |
| `PUBLIC_EDITOR_URL` | No | - | Public editor base URL |
| `MAX_CORRECTION_ROUNDS` | No | `2` | Reviewer loop limit |
| `MAX_TOKENS_PER_RUN` | No | - | Hard cap on tokens |
| `REGENERATE_WEBHOOK_KEY` | No | - | Webhook auth key |

### C. Model Recommendations

| Agent | Complexity | Recommended Model | Rationale |
|-------|------------|-------------------|-----------|
| Agent 1 | Medium | `llama-3.1-70b-versatile` | Requirements parsing |
| Agent 2 | Medium | `llama-3.1-70b-versatile` | Architecture design |
| Agent 3 | Low | `llama-3.1-8b-instant` | Planning (structured) |
| Agent 4 | Low | `llama-3.1-8b-instant` | Budget (code calculates) |
| Agent 5 | High | `llama-3.1-70b-versatile` | Credibility (nuanced) |
| Agent 6 | High | `llama-3.1-70b-versatile` | Review (critical) |

**Cost vs Quality:** 70B models are more accurate but 8-10× more expensive than 8B. Test with 8B first.

---

**Document Version:** 1.0.0  
**Last Updated:** 2024-10-18  
**Status:** Production Ready (after LLM integration)


---

## 🚀 PRODUCTION SETUP (For New Implementation)

**If you're setting up this system for the first time or in a fresh Claude Code session**, use:

**📄 Master Prompt:** `/home/ahmed-bensalah/cstam-olive/phase2/try2/rfp-studio/docs/agents/CLAUDE_CODE_MASTER_PROMPT.md`

This comprehensive guide includes:
- Building all 9 n8n workflow JSON files
- End-to-end integration testing
- Real Groq API testing
- Bug fixes and hardening
- Complete deployment documentation
- Production readiness checklist

**Status:** Logic 100% complete (316 tests passing) | n8n workflows need to be generated

See `CLAUDE_CODE_MASTER_PROMPT.md` for the complete build-and-deploy guide.
