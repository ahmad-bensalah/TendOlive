"""Configuration and runtime settings for the RAG retrieval service."""
import os
from pathlib import Path
from typing import Dict, List, Tuple

ROOT: Path = Path(__file__).resolve().parents[1]
DATA_DIR: Path = Path(os.getenv("RAG_DATA_DIR", ROOT / "data"))
DB_DIR: Path = Path(os.getenv("RAG_DB_DIR", ROOT / "chroma_db"))

# Partitioned knowledge base folders (comma-separated). Empty defaults to all active folders.
FOLDERS: List[str] = [f.strip() for f in os.getenv("RAG_FOLDERS", "").split(",") if f.strip()]

# Default embedding model selected via empirical benchmarking (intfloat/multilingual-e5-small)
EMBEDDING_MODEL: str = os.getenv("RAG_EMBEDDING_MODEL", "intfloat/multilingual-e5-small")

CHUNK_SIZE_WORDS: int = int(os.getenv("RAG_CHUNK_SIZE", 200))
CHUNK_OVERLAP_WORDS: int = int(os.getenv("RAG_CHUNK_OVERLAP", 50))

# Retrieval hyperparameters
TOP_K_CHUNKS: int = 50
TOP_N_DOCS: int = 3

# Model query and passage prefix specifications
MODEL_PREFIXES: Dict[str, Tuple[str, str]] = {
    "intfloat/multilingual-e5-small": ("query: ", "passage: "),
    "intfloat/multilingual-e5-base": ("query: ", "passage: "),
    "intfloat/multilingual-e5-large": ("query: ", "passage: "),
}

# Cosine similarity calibration thresholds (fallback baseline)
THRESHOLDS: Dict[str, Tuple[float, float]] = {
    "intfloat/multilingual-e5-small": (0.80, 0.85),
    "sentence-transformers/all-MiniLM-L6-v2": (0.35, 0.50),
    "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2": (0.40, 0.55),
    "BAAI/bge-m3": (0.50, 0.62),
}
DEFAULT_THRESHOLDS: Tuple[float, float] = (0.40, 0.55)

# Cross-encoder reranker model for zero-shot semantic constraint verification
RERANKER_MODEL: str = os.getenv("RAG_RERANKER", "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1")
RERANK_THRESHOLDS: Tuple[float, float] = (-4.0, 0.0)
RERANK_FLOOR_WITH_TEXT: float = -6.0
RERANK_CANDIDATES: int = 5

# Document domain mapping per tender requirement category
CATEGORY_TYPES: Dict[str, List[str]] = {
    "technical": ["cv", "past_project", "tech_stack"],
    "team": ["cv"],
    "experience": ["past_project", "client_portfolio", "cv"],
}


def thresholds(model_name: str) -> Tuple[float, float]:
    """Return calibrated score thresholds for a given embedding model."""
    return THRESHOLDS.get(model_name, DEFAULT_THRESHOLDS)


def prefixes(model_name: str) -> Tuple[str, str]:
    """Retrieve query/passage prefixes required by asymmetric embedding architectures."""
    return MODEL_PREFIXES.get(model_name, ("", ""))


def collection_name(model_name: str) -> str:
    """Generate a sanitized, unique ChromaDB collection name for a given embedding model."""
    safe = "".join(c if c.isalnum() else "_" for c in model_name)
    return f"olivesoft_{safe}"[:60].rstrip("_")
