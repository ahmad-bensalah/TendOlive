"""Settings for the RAG service. Change values here or with environment variables."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.getenv("RAG_DATA_DIR", ROOT.parent / "data"))
DB_DIR = Path(os.getenv("RAG_DB_DIR", ROOT / "chroma_db"))
TENDERS_FILE = Path(os.getenv("RAG_TENDERS_FILE", ROOT / "tenders.json"))
# The only CV source. Resolve relative to the checkout, not the working directory.
CV_DIR = ROOT.parent / "data" / "cvs"
# Load only these data/ folders (comma separated), e.g. "cvs,projects". Empty = all.
FOLDERS = [f.strip() for f in os.getenv("RAG_FOLDERS", "").split(",") if f.strip()]

# Default model. Chosen with the benchmark (see benchmark/results.md).
EMBEDDING_MODEL = os.getenv("RAG_EMBEDDING_MODEL", "intfloat/multilingual-e5-small")

CHUNK_SIZE_WORDS = int(os.getenv("RAG_CHUNK_SIZE", 200))
CHUNK_OVERLAP_WORDS = int(os.getenv("RAG_CHUNK_OVERLAP", 50))

# How many chunks to pull per requirement before grouping them by document.
TOP_K_CHUNKS = 50
# How many documents to keep per requirement.
TOP_N_DOCS = 3

# Some models need a prefix on queries and passages (E5 family).
MODEL_PREFIXES = {
    "intfloat/multilingual-e5-small": ("query: ", "passage: "),
    "intfloat/multilingual-e5-base": ("query: ", "passage: "),
    "intfloat/multilingual-e5-large": ("query: ", "passage: "),
}

# Cosine-similarity thresholds (>= high: covered, >= low: partial). Only used by
# the "similarity threshold" baseline in the benchmark and when both the rules and
# the reranker are turned off. Each model spreads its scores differently.
THRESHOLDS = {
    "intfloat/multilingual-e5-small": (0.80, 0.85),
    "sentence-transformers/all-MiniLM-L6-v2": (0.35, 0.50),
    "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2": (0.40, 0.55),
    "BAAI/bge-m3": (0.50, 0.62),
}
DEFAULT_THRESHOLDS = (0.40, 0.55)

# Cross-encoder that checks "is this requirement really covered by this document?".
# Its scores separate good and bad matches much better than cosine similarity
# (see benchmark/results.md). Set RAG_RERANKER="" to turn it off.
RERANKER_MODEL = os.getenv("RAG_RERANKER", "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1")
# Reranker logit thresholds. A document "covers" a requirement at >= 0.
# Below that it only counts (as "partial") when the words the rules do not know
# appear in its text and its score is at least RERANK_FLOOR_WITH_TEXT.
# The first value is used to map scores to 0-100 for the fit score.
RERANK_THRESHOLDS = (-4.0, 0.0)
RERANK_FLOOR_WITH_TEXT = -6.0
RERANK_CANDIDATES = 5  # how many top documents the reranker checks per requirement

# Which document types answer which requirement category.
CATEGORY_TYPES = {
    "technical": ["cv", "past_project", "tech_stack", "tool"],
    "team": ["cv"],
    "experience": ["past_project", "client_portfolio", "cv"],
}


def thresholds(model_name: str):
    return THRESHOLDS.get(model_name, DEFAULT_THRESHOLDS)


def prefixes(model_name: str):
    return MODEL_PREFIXES.get(model_name, ("", ""))


def collection_name(model_name: str) -> str:
    # One collection per model, so the benchmark can compare models side by side.
    safe = "".join(c if c.isalnum() else "_" for c in model_name)
    return f"olivesoft_{safe}"[:60].rstrip("_")
