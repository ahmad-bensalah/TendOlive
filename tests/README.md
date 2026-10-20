# Tests

Every part keeps its tests next to its code. All commands run from the repository root and need only Docker (the
images are the ones `docker compose build` makes). `--no-deps` runs one container without starting the others;
`--rm` removes it afterwards.

| Suite | Where | Command | What it checks |
|---|---|---|---|
| Pipeline edge cases | `n8n/test/edge_cases.js` | `docker run --rm -v "${PWD}/n8n:/w" -w /w node:20-alpine node test/edge_cases.js` | 223 cases on the built Code nodes and wiring of `n8n/dist/` (incomplete tenders, noisy research, missing references, LLM failures, market, run report, hand-off to the studio); under a second. Results and known gaps: [docs/edge-cases.md](../docs/edge-cases.md) |
| Studio adapter | `n8n/test/studio_adapter.test.js` | `docker run --rm -v "${PWD}/n8n:/w/n8n" -v "${PWD}/services/proposal-studio:/w/studio:ro" -w /w/n8n -e STUDIO_DIR=/w/studio node:20-alpine node test/studio_adapter.test.js` | our `Adapt for Studio` then the studio's own normaliser on the 10 real proposal inputs of run 3 (fixture in `n8n/test/out/`) |
| n8n packaging | `n8n/init/init.js check` | `docker compose build n8n` | runs `node build.js` and checks that every Config / Refine Slide patch applies for every `LLM_PROVIDER` and that `n8n/llm.json` matches the model nodes of `build.js` (the build fails otherwise) |
| RAG application tests | `services/rag/tests/` | `docker compose run --rm --no-deps rag python -m pytest` | matching rules, records, tenders store, dashboard API, real CVs (the knowledge base is the bind-mounted `knowledge-base/`) |
| RAG benchmark | `services/rag/benchmark/` | `docker compose run --rm --no-deps rag python -m benchmark.run_benchmark --quick` | CV decision checks, graded retrieval set, real tender lines: [docs/rag-benchmark.md](../docs/rag-benchmark.md) |
| Web app type check and build | `apps/web` | `docker compose build web` | `tsc -b` (strict TypeScript) then `vite build` |
| Proposal studio (Python) | `services/proposal-studio/tests/` | `docker compose run --rm --no-deps proposal-studio python -m unittest discover tests` (add `-e RFP_FAST=1` after `run` to skip the 9 slow browser tests) | server API, layout engine, PPTX / PDF export, templates, tenders and generations; writes only to temporary folders |
| Proposal studio (agents, Node) | `services/proposal-studio/agents/tests/` | `docker compose run --rm --no-deps proposal-studio node --test agents/tests/` | the deck agents' contracts, input normaliser, LLM client, budget, diagrams, reviewer, registry |
| Proposal studio (inputs) | `services/proposal-studio/tests/check_inputs.py` | `docker compose run --rm --no-deps proposal-studio python tests/check_inputs.py` | agent test inputs and folder parity |

PowerShell understands `${PWD}` as written. With Node installed locally, the two pipeline suites also run directly:
`cd n8n`, then `node test/edge_cases.js` and `STUDIO_DIR=<absolute path of services/proposal-studio> node test/studio_adapter.test.js`.

After editing `n8n/src/` or `n8n/build.js`, run `node build.js` in `n8n/` before the edge cases: they read `n8n/dist/`.

## Known results

- Pipeline edge cases: 223 cases, 223 passed (checked on this repository). Studio adapter: 11 inputs, every check passed.
- RAG: `tests/test_review_fixes.py::test_tender_inbox_is_ignored_by_git` reads the `.gitignore` of the former CSTAM
  repository root (two folders above the test), which does not exist in the container: it fails here. Skip it with
  `docker compose run --rm --no-deps rag python -m pytest --deselect tests/test_review_fixes.py::test_tender_inbox_is_ignored_by_git`.
  The tender store is ignored by git in this repository's `.gitignore` (`services/rag/tenders.json`).
- The web app's Quality page shows the reference benchmark and test results shipped in `services/rag/benchmark/`
  until you run them again from the page (they then run inside the `rag` container).

## Development harnesses (not part of the packaged run)

- `n8n/test/replay.js <execution.json>`: replays the current Code nodes on the answers recorded in a real n8n run. The
  recordings are several MB each and not shipped: export an execution from n8n (`docker compose exec n8n n8n
  export:workflow` exports workflows; executions are downloaded from the editor).
- `n8n/test/e2e.js` with `n8n/test/mock_server.js`: runs Main end to end in a throwaway n8n container next to services
  started by hand on the host (Firecrawl and the RAG mocked). Read its header before using it: it creates and removes
  its own container (`rfp-n8n-test`) and reads keys from files outside the repository.
- The whole system: `docker compose up -d`, then the demo flow of the [README](../README.md).
