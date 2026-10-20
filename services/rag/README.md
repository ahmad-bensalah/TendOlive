# RAG service

Matches tender requirements against the company knowledge base and answers, per requirement, covered / partial /
missing with the cited document and a quoted proof line. It also proposes a team, reports knowledge gaps, stores the
analysed tenders the n8n pipeline sends, and serves the data behind the web app. FastAPI, container `rag`, port 8001.

## How it fits

n8n's **Call RAG** node posts each tender's requirements to `POST /retrieve/tender`; the web app reads tenders,
knowledge base records and benchmark results through `/api/...`. The knowledge base is [knowledge-base/](../../knowledge-base/),
bind-mounted at `/app/data`.

## Code

| File | Role |
|---|---|
| [rag/api.py](rag/api.py) | HTTP endpoints (`/health`, `/retrieve`, `/retrieve/tender`, `/match`, `/reindex`, dashboard API) |
| [rag/retriever.py](rag/retriever.py) | Per-requirement decision: candidates, rule checks, reranker, accepted set |
| [rag/reqparse.py](rag/reqparse.py) | Reads counts, certificates, roles, seniority and sector out of a requirement line |
| [rag/hybrid.py](rag/hybrid.py) | BM25 + dense vectors fused with Reciprocal Rank Fusion |
| [rag/index.py](rag/index.py), [rag/loader.py](rag/loader.py), [rag/cvparse.py](rag/cvparse.py) | Chroma index, embeddings, reranker scores; loading CV PDFs and JSON records |
| [rag/team.py](rag/team.py), [rag/gaps.py](rag/gaps.py) | Team builder and knowledge-gap report |
| [rag/records.py](rag/records.py), [rag/tenders.py](rag/tenders.py) | Knowledge base records (add / edit from the web app) and the tender store |
| [benchmark/](benchmark/) | Retrieval set, CV decision checks, real tender lines, and the shipped reference results |

## Configuration

Set in [docker-compose.yml](../../docker-compose.yml); defaults in [rag/config.py](rag/config.py).

| Variable | Meaning |
|---|---|
| `RAG_DATA_DIR` | Knowledge base folder |
| `RAG_DB_DIR` | Chroma index (rebuilt at start when the knowledge base or code changed) |
| `RAG_TENDERS_FILE` | Tender store written by `POST /retrieve/tender` |
| `RAG_CORS_ORIGINS` | Extra allowed origins (comma-separated) |
| `RAG_EMBEDDING_MODEL` | Default `intfloat/multilingual-e5-small` |
| `RAG_RERANKER` | Default `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1` |

## Run and test

```bash
docker compose up -d rag                                                        # API docs: http://localhost:8001/docs
docker compose run --rm --no-deps rag python -m pytest                          # application tests
docker compose run --rm --no-deps rag python -m benchmark.run_benchmark --quick # benchmark
```

The web app's Quality page shows the shipped reference results ([screenshot](../../docs/screenshots/web-quality-benchmark.png)).
One test fails in the container for a repository-layout reason; see [tests/README.md](../../tests/README.md#known-results).

## Further reading

- [docs/rag-service.md](../../docs/rag-service.md): data modes, adding knowledge, how matching decides
- [docs/rag-benchmark.md](../../docs/rag-benchmark.md): evaluation method, results, failure analysis
- [docs/architecture.md](../../docs/architecture.md) (Part 2) and [docs/integration-and-api.md](../../docs/integration-and-api.md) (section 5)
