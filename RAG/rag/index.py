"""Vector index management and persistent document store.

Manages persistent ChromaDB vector collections, passage embeddings, cross-encoder
reranker caching, and document profile storage with atomic collection swapping.
"""
import argparse
import hashlib
import inspect
import json
import logging
import time
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import chromadb
from chromadb.config import Settings
from sentence_transformers import SentenceTransformer

from . import config
from .loader import Document, chunk_words, data_fingerprint, load_documents
from .profiles import build_profile

logger = logging.getLogger(__name__)

# Bump when the doc store or profile format changes, so old indexes are rebuilt.
INDEX_FORMAT = 3


def doc_store_path():
    # A function, not a constant: the benchmark points config.DB_DIR to its own index.
    return config.DB_DIR / "doc_store.json"


def index_meta_path():
    return config.DB_DIR / "index_meta.json"


def code_fingerprint() -> str:
    """Hash of the code that reads documents and builds profiles.

    When the vocabulary or the CV reader changes, the index is rebuilt at the next start.
    """
    h = hashlib.sha1()
    here = Path(__file__).parent
    for name in ("taxonomy.py", "profiles.py", "cvparse.py", "loader.py"):
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
    return _client_for(str(config.DB_DIR))


def _collection_names() -> list[str]:
    # ChromaDB 0.6 returns names, other versions return Collection objects.
    return [c if isinstance(c, str) else c.name for c in get_client().list_collections()]


def get_collection(model_name: str = config.EMBEDDING_MODEL):
    return get_client().get_collection(config.collection_name(model_name))


def index_ready(model_name: str = config.EMBEDDING_MODEL) -> bool:
    return doc_store_path().exists() and config.collection_name(model_name) in _collection_names()


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
        raise NoDocumentsError(f"No valid documents found in {config.DATA_DIR}.")
    client = get_client()
    name = config.collection_name(model_name)
    tmp = (name[:52] + "_building").strip("_")
    if tmp in _collection_names():
        client.delete_collection(tmp)
    col = client.create_collection(tmp, metadata={"hnsw:space": "cosine", "model": model_name})

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
        client.delete_collection(tmp)
        raise

    # Swap the new collection in.
    if name in _collection_names():
        client.delete_collection(name)
    try:
        col.modify(name=name)
    except Exception:  # very old ChromaDB without rename: copy instead
        new = client.create_collection(name, metadata={"hnsw:space": "cosine", "model": model_name})
        for start in range(0, len(ids), 1000):
            end = start + 1000
            new.add(ids=ids[start:end], documents=texts[start:end],
                    metadatas=metas[start:end], embeddings=vectors[start:end])
        client.delete_collection(tmp)
    save_doc_store(docs)
    meta = index_meta() if index_meta().get("format") == INDEX_FORMAT else {}
    fingerprint, code = data_fingerprint(), code_fingerprint()
    same = meta.get("fingerprint") == fingerprint and meta.get("code") == code
    models = meta.get("models", []) if same else []
    index_meta_path().write_text(json.dumps({
        "format": INDEX_FORMAT, "fingerprint": fingerprint, "code": code,
        "models": sorted(set(models) | {model_name}), "documents": len(docs),
        "built_at": time.strftime("%Y-%m-%d %H:%M")}, indent=1), encoding="utf-8")
    logger.info("Index updated for %s: %d chunks across %d documents", model_name, len(ids), len(docs))

    from .hybrid import clear_cache  # local import: hybrid.py imports this module
    clear_cache()
    return len(ids)


# ---------------------------------------------------------------- doc store
def save_doc_store(docs: List[Document]) -> None:
    """Persist structured profiles and textual lines for all documents."""
    store = {}
    for d in docs:
        lines = [ln.strip() for ln in d.text.splitlines()
                 if ln.strip() and not ln.startswith(("Title:", "Type:", "Summary:"))]
        store[d.doc_id] = {"type": d.doc_type, "title": d.title, "summary": d.summary,
                           "path": d.path, "uploaded": d.path.startswith("uploads/"),
                           "lines": lines, "profile": build_profile(d)}
    config.DB_DIR.mkdir(parents=True, exist_ok=True)
    doc_store_path().write_text(json.dumps(store, indent=1, ensure_ascii=False), encoding="utf-8")
    load_doc_store.cache_clear()
    logger.info("Saved %d document profiles to %s", len(store), doc_store_path().name)


_store_cache = {"key": None, "data": None}


def load_doc_store() -> dict:
    """The doc store, reloaded when the file changes (e.g. a rebuild from another window)."""
    path = doc_store_path()
    stat = path.stat()
    key = (str(path), stat.st_mtime_ns, stat.st_size)
    if _store_cache["key"] != key:
        _store_cache["data"] = json.loads(path.read_text(encoding="utf-8"))
        _store_cache["key"] = key
    return _store_cache["data"]


load_doc_store.cache_clear = lambda: _store_cache.update(key=None, data=None)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Build the RAG indexes.")
    ap.add_argument("--model", default=config.EMBEDDING_MODEL)
    try:
        build_index(ap.parse_args().model)
    except NoDocumentsError as e:
        raise SystemExit(str(e))
