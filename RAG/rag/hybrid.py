"""Hybrid search engine: BM25 lexical ranking and dense multilingual vectors fused via RRF."""
import re
from typing import Any, Dict, List, Optional, Set, Tuple

from rank_bm25 import BM25Okapi

from . import config
from . import taxonomy as tx
from .index import embed, get_collection

RRF_K: int = 60

# Common multilingual stopwords to prevent uninformative BM25 scoring collisions
STOPWORDS: Set[str] = set("""
a an the of for in on with and or to at by as is are be was from this that it its our your
au aux de des du le la les un une et ou en pour sur avec dans par ce ces cette son sa ses
leur leurs l d qui que est sont a plus ne pas se
""".split())


def tokenize(text: str) -> list[str]:
    return [t for t in re.findall(r"[a-z0-9]+", tx.normalize(text)) if t not in STOPWORDS]


def expand_query(query: str) -> str:
    """Add known aliases so a French query also hits English words (and back)."""
    extra = []
    for table, finder in ((tx.SKILLS, tx.find_skills), (tx.CERTIFICATIONS, tx.find_certs),
                          (tx.ROLES, tx.find_roles), (tx.SECTORS, tx.find_sectors)):
        for name in finder(query):
            extra += [name] + table[name]
    return query + " " + " ".join(extra)


_bm25_cache: dict = {}


def _bm25(model_name: str):
    """BM25 index over the collection, rebuilt when the collection changes."""
    col = get_collection(model_name)
    key = (str(col.id), col.count())
    cached = _bm25_cache.get(model_name)
    if cached and cached[0] == key:
        return cached[1], cached[2]
    data = col.get(include=["documents", "metadatas"])
    bm = BM25Okapi([tokenize(d) for d in data["documents"]])
    _bm25_cache[model_name] = (key, bm, data["metadatas"])
    return bm, data["metadatas"]


def clear_cache():
    _bm25_cache.clear()


def _best_per_doc(pairs: List[Tuple[str, float]]) -> List[Tuple[str, float]]:
    """Deduplicate candidate chunks to retain the highest-scoring occurrence per document."""
    seen: Set[str] = set()
    out: List[Tuple[str, float]] = []
    for doc_id, score in pairs:
        if doc_id not in seen:
            seen.add(doc_id)
            out.append((doc_id, score))
    return out


def bm25_rank(model_name: str, query: str, doc_types: Optional[List[str]]) -> List[Tuple[str, float]]:
    """Perform BM25 keyword scoring over tokenized passages with query expansion."""
    bm, metas = _bm25(model_name)
    scores = bm.get_scores(tokenize(expand_query(query)))
    pairs = sorted(((m["doc_id"], float(s)) for m, s in zip(metas, scores)
                    if (not doc_types or m["type"] in doc_types) and s > 0),
                   key=lambda x: -x[1])
    return _best_per_doc(pairs)


def dense_rank(model_name: str, query: str, doc_types: Optional[List[str]]) -> List[Tuple[str, float]]:
    """Perform dense vector retrieval against the active ChromaDB collection."""
    col = get_collection(model_name)
    where = {"type": {"$in": doc_types}} if doc_types else None
    res = col.query(query_embeddings=embed(model_name, [query], "query"),
                    n_results=min(config.TOP_K_CHUNKS, col.count()), where=where,
                    include=["metadatas", "distances"])
    pairs = [(m["doc_id"], round(1 - d, 4)) for m, d in zip(res["metadatas"][0], res["distances"][0])]
    return _best_per_doc(pairs)


def hybrid_rank(
    model_name: str,
    query: str,
    doc_types: Optional[List[str]],
    mode: str = "hybrid"
) -> List[Dict[str, Any]]:
    """Execute hybrid search combining BM25 and dense retrieval using Reciprocal Rank Fusion."""
    dense = dense_rank(model_name, query, doc_types) if mode in ("dense", "hybrid") else []
    sparse = bm25_rank(model_name, query, doc_types) if mode in ("bm25", "hybrid") else []
    rows: Dict[str, Dict[str, Any]] = {}
    for name, ranking in (("dense", dense), ("bm25", sparse)):
        for rank, (doc_id, score) in enumerate(ranking, start=1):
            r = rows.setdefault(doc_id, {"doc_id": doc_id, "rrf": 0.0})
            r["rrf"] += 1 / (RRF_K + rank)
            r[name] = score
            r[f"{name}_rank"] = rank
    return sorted(rows.values(), key=lambda r: -r["rrf"])
