"""Build and load the indexes.

    python -m rag.index                      (default model)
    python -m rag.index --model BAAI/bge-m3  (another model)

Creates, inside chroma_db/:
  * one ChromaDB collection per embedding model (vectors)
  * doc_store.json: structured profile + text lines of every document
The BM25 keyword index is rebuilt in memory from the collection (see hybrid.py).
"""
import argparse
import hashlib
import inspect
import json
import time
import uuid
import os
from functools import lru_cache
from pathlib import Path

import chromadb
from chromadb.config import Settings
from sentence_transformers import SentenceTransformer

from .context import current
from . import records
from . import config
from .loader import chunk_words, data_fingerprint, load_documents
from .profiles import build_profile

# Bump when the doc store or profile format changes, so old indexes are rebuilt.
# 7: CV lines are whole sentences / bullet items; record profiles read the title and description.
INDEX_FORMAT = 7
# The modules that read documents and build the doc store. A change in any of them changes
# code_fingerprint(), and the API rebuilds both indexes at its next start (see api.lifespan).
INGESTION_MODULES = ("taxonomy.py", "profiles.py", "cvparse.py", "loader.py", "records.py", "context.py",
                     "index.py")


def doc_store_path():
    # A function, not a constant: the benchmark points current().db_dir to its own index.
    return current().db_dir / index_meta().get("store_file", "doc_store.json")


def index_meta_path():
    return current().db_dir / "index_meta.json"


def code_fingerprint() -> str:
    """Hash of the code that reads documents and builds profiles.

    When the vocabulary, the CV reader, the record profiles or the doc store change,
    the index is rebuilt at the next start.
    """
    h = hashlib.sha1()
    here = Path(__file__).parent
    for name in INGESTION_MODULES:
        h.update((here / name).read_bytes().replace(b"\r\n", b"\n"))
    return h.hexdigest()[:12]


# ---------------------------------------------------------------- models
@lru_cache(maxsize=4)
def get_model(model_name: str) -> SentenceTransformer:
    return SentenceTransformer(model_name)


def embed(model_name: str, texts: list[str], kind: str) -> list[list[float]]:
    """kind is "query" or "passage" (E5 models need a different prefix for each)."""
    q_prefix, p_prefix = config.prefixes(model_name)
    prefix = q_prefix if kind == "query" else p_prefix
    vectors = get_model(model_name).encode(
        [prefix + t for t in texts], normalize_embeddings=True, batch_size=16)
    return vectors.tolist()


@lru_cache(maxsize=2)
def get_reranker(model_name: str):
    from sentence_transformers import CrossEncoder
    return CrossEncoder(model_name)


def rerank_scores(model_name: str, query: str, passages: list[str]) -> list[float]:
    """Raw cross-encoder scores (logits). Higher means more relevant.

    The thresholds in config.py are logits, so we always ask for raw scores.
    (Older sentence-transformers versions apply a sigmoid by default, and the
    argument name changed between versions, so we check which one exists.)
    """
    if not passages:
        return []
    import torch
    model = get_reranker(model_name)
    params = inspect.signature(model.predict).parameters
    kwargs = {"show_progress_bar": False}
    for name in ("activation_fn", "activation_fct"):
        if name in params:
            kwargs[name] = torch.nn.Identity()
            break
    return [float(s) for s in model.predict([(query, p) for p in passages], **kwargs)]


# ---------------------------------------------------------------- vector store
@lru_cache(maxsize=4)
def _client_for(path: str):
    return chromadb.PersistentClient(path=path, settings=Settings(anonymized_telemetry=False))


def get_client():
    # One client per index folder: the benchmark switches between its own indexes.
    return _client_for(str(current().db_dir))


def _collection_names() -> list[str]:
    # ChromaDB 0.6 returns names, other versions return Collection objects.
    return [c if isinstance(c, str) else c.name for c in get_client().list_collections()]


def get_collection(model_name: str = config.EMBEDDING_MODEL):
    return get_client().get_collection(index_meta().get("collections", {}).get(model_name, config.collection_name(model_name)))


def index_ready(model_name: str = config.EMBEDDING_MODEL) -> bool:
    return doc_store_path().exists() and index_meta().get("collections", {}).get(model_name, config.collection_name(model_name)) in _collection_names()


def index_meta() -> dict:
    try:
        return json.loads(index_meta_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def index_up_to_date(model_name: str = config.EMBEDDING_MODEL) -> bool:
    """Ready, built by this code version, and built from the current files in data/."""
    if not index_ready(model_name):
        return False
    meta = index_meta()
    return (meta.get("format") == INDEX_FORMAT
            and meta.get("fingerprint") == data_fingerprint()
            and meta.get("code") == code_fingerprint()
            and model_name in meta.get("models", []))


class NoDocumentsError(RuntimeError):
    pass


def build_index(model_name: str = config.EMBEDDING_MODEL) -> int:
    """(Re)build the vector collection and the doc store for one model.

    The new collection is filled under a temporary name and swapped in at the end,
    so a failed rebuild never leaves the service without an index.
    """
    docs = load_documents()
    if not docs:
        raise NoDocumentsError(f"No documents found in {config.DATA_DIR}. "
                               "Restore data/cvs or add structured records through the dashboard.")
    client = get_client()
    generation = uuid.uuid4().hex[:12]
    name = config.collection_name(model_name)[:44] + "_" + generation
    col = client.create_collection(name, metadata={"hnsw:space": "cosine", "model": model_name})
    old_meta = index_meta()
    fingerprint, code = data_fingerprint(), code_fingerprint()
    # Profiles and metadata are prepared before activation; failures leave the old manifest intact.
    store = document_store(docs)
    ids, texts, metas = [], [], []
    for doc in docs:
        for i, chunk in enumerate(chunk_words(doc.text)):
            ids.append(f"{doc.doc_id}::{i}")
            # Put the title in every chunk so each chunk keeps its context.
            texts.append(f"{doc.title}. {chunk}")
            metas.append({"doc_id": doc.doc_id, "type": doc.doc_type,
                          "title": doc.title, "summary": doc.summary, "chunk": i})
    try:
        vectors = embed(model_name, texts, "passage")
        for start in range(0, len(ids), 1000):  # stay under ChromaDB's batch limit
            end = start + 1000
            col.add(ids=ids[start:end], documents=texts[start:end],
                    metadatas=metas[start:end], embeddings=vectors[start:end])
    except Exception:
        client.delete_collection(name)
        raise

    current().db_dir.mkdir(parents=True, exist_ok=True)
    store_file = "store_" + generation + ".json"
    (current().db_dir / store_file).write_text(json.dumps(store, indent=1, ensure_ascii=False), encoding="utf-8")
    same = old_meta.get("fingerprint") == fingerprint and old_meta.get("code") == code
    collections = dict(old_meta.get("collections", {})) if same else {}
    collections[model_name] = name
    metadata = {"format": INDEX_FORMAT, "fingerprint": fingerprint, "code": code,
                "models": sorted(collections), "collections": collections, "store_file": store_file,
                "documents": len(docs), "data_mode": current().mode,
                "built_at": time.strftime("%Y-%m-%d %H:%M")}
    manifest_tmp = index_meta_path().with_suffix(".tmp")
    manifest_tmp.write_text(json.dumps(metadata, indent=1), encoding="utf-8")
    os.replace(manifest_tmp, index_meta_path())  # single atomic activation point
    load_doc_store.cache_clear()
    # Now obsolete generations can be removed; a cleanup error cannot invalidate activation.
    for old_name in old_meta.get("collections", {}).values():
        if old_name not in collections.values():
            try:
                client.delete_collection(old_name)
            except Exception:
                pass
    old_store = old_meta.get("store_file")
    if old_store and old_store != store_file:
        try:
            (current().db_dir / old_store).unlink(missing_ok=True)
        except OSError:
            pass
    print(f"[index] {model_name}: {len(ids)} chunks from {len(docs)} documents")

    from .hybrid import clear_cache  # local import: hybrid.py imports this module
    clear_cache()
    return len(ids)


# ---------------------------------------------------------------- doc store
def document_store(docs):
    store = {}
    for d in docs:
        lines = [ln.strip() for ln in d.text.splitlines() if ln.strip() and not ln.startswith(("Title:", "Type:", "Summary:"))]
        store[d.doc_id] = {"type": d.doc_type, "title": d.title, "summary": d.summary,
                           "path": d.path, "uploaded": False, "lines": lines,
                           "origin": d.record.get("origin", "cv_document"),
                           "record": d.record, "record_digest": records.digest(d.record) if d.record else None,
                           "profile": records.profile(d.record) if d.record else build_profile(d)}
    return store


@lru_cache(maxsize=12)
def _read_store(path, mtime, size):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def load_doc_store():
    path = doc_store_path()
    stat = path.stat()
    store = _read_store(str(path), stat.st_mtime_ns, stat.st_size)
    live = {r["id"]: r for r in records.visible_records()}
    # An edited draft or deleted record is excluded even if rebuilding failed.
    return {key: d for key, d in store.items() if d["type"] == "cv" or
            (key in live and live[key]["status"] == "indexed" and records.digest(live[key]) == d.get("record_digest"))}


load_doc_store.cache_clear = _read_store.cache_clear


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Build the RAG indexes.")
    ap.add_argument("--model", default=config.EMBEDDING_MODEL)
    try:
        build_index(ap.parse_args().model)
    except NoDocumentsError as e:
        raise SystemExit(str(e))
