"""HTTP API for n8n and the React website.

Run:        python app.py                    (starts the API)
   or:      uvicorn rag.api:app --port 8001
Website:    http://localhost:5173/
API docs:   http://127.0.0.1:8001/docs
"""
import os
from contextlib import asynccontextmanager
from typing import Literal, Optional, Union

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field

from .context import DataMode, for_mode, retrieval_scope
from . import __version__, config
from .dashboard import index_lock, reindex as locked_reindex, router as dashboard_router
from .index import build_index, embed, index_ready, index_up_to_date, rerank_scores
from .retriever import match_requirement, retrieve
from . import tenders


@asynccontextmanager
async def lifespan(app: FastAPI):
    for mode in ("company", "demo"):
        with retrieval_scope(for_mode(mode)):
            if not index_up_to_date():
                build_index()
    # Load (and on the first run, download) both models now, so the first
    # request in a live demo is fast.
    embed(config.EMBEDDING_MODEL, ["warm up"], "query")
    if config.RERANKER_MODEL:
        rerank_scores(config.RERANKER_MODEL, "warm up", ["warm up"])
    print("[api] ready")
    yield


app = FastAPI(title="OliveSoft RAG Retrieval", version=__version__, lifespan=lifespan,
              description="Evidence-based matching of tender requirements to OliveSoft CVs, "
                          "past projects and tech stacks. React website: http://localhost:5173/")
# Only the React dashboard may call the API from a browser. It normally goes through the Vite proxy
# (same origin, no CORS); these origins also let it call port 8001 directly. Any other web page open
# in the browser is refused, so it cannot, for example, empty the tender inbox (DELETE /api/tenders).
# n8n calls the API server to server, where CORS does not apply. The API serves no page itself
# ("/" redirects to the dashboard). RAG_CORS_ORIGINS (comma-separated) adds origins.
DASHBOARD_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"] + [
    o.strip().rstrip("/") for o in os.getenv("RAG_CORS_ORIGINS", "").split(",") if o.strip()]
app.add_middleware(CORSMiddleware, allow_origins=DASHBOARD_ORIGINS, allow_methods=["*"], allow_headers=["*"])
app.include_router(dashboard_router)

StrList = Union[list[str], str, None]


class Requirements(BaseModel):
    data_mode: DataMode = "company"
    technical: StrList = []
    team: StrList = []
    experience: StrList = []
    timeline: Optional[str] = None
    sector: Optional[str] = None
    client: Optional[str] = None


class TenderRecord(BaseModel):
    """Tender metadata plus requirements from the extraction workflow."""
    model_config = ConfigDict(extra="allow")
    data_mode: DataMode = "company"
    tender_id: Optional[str] = None
    title: Optional[str] = None
    client: Optional[str] = None
    sector: Optional[str] = None
    country: Optional[str] = None
    source: Optional[str] = None
    source_url: Optional[str] = None
    published: Optional[str] = None
    deadline: Optional[str] = None
    language: Optional[str] = None
    estimated_budget: Optional[str] = None
    requirements: Requirements = Field(default_factory=Requirements)


class OneRequirement(BaseModel):
    data_mode: DataMode = "company"
    requirement: str
    category: Literal["technical", "team", "experience"] = "technical"


@app.get("/health")
def health():
    return {"status": "ok", "version": __version__, "model": config.EMBEDDING_MODEL,
            "reranker": config.RERANKER_MODEL or None, "index_ready": index_ready()}


@app.post("/retrieve")
def retrieve_endpoint(req: Requirements):
    """Match a requirements object: {"technical": [...], "team": [...], "experience": [...]}."""
    with index_lock.read(), retrieval_scope(for_mode(req.data_mode)):
        return retrieve(req.model_dump())


@app.post("/retrieve/tender")
def retrieve_from_tender(tender: TenderRecord):
    """Match and persist Person 2's full tender record (the main n8n endpoint)."""
    body = tender.requirements.model_dump()
    body["sector"] = body.get("sector") or tender.sector
    body["client"] = body.get("client") or tender.client
    with index_lock.read(), retrieval_scope(for_mode(tender.data_mode)):
        out = retrieve(body)
    out["tender_id"] = tender.tender_id
    metadata = tender.model_dump(exclude={"requirements"}, exclude_none=True)
    metadata["requirements"] = tender.requirements.model_dump()
    metadata["rag_analysis"] = out
    tenders.save(metadata)
    for key in ("title", "client", "sector", "country", "source", "source_url",
                "published", "deadline", "language", "estimated_budget"):
        if key in metadata:
            out[key] = metadata[key]
    return out


@app.post("/match")
def match_one(body: OneRequirement):
    """Check a single requirement (useful for the dashboard and for debugging)."""
    with index_lock.read(), retrieval_scope(for_mode(body.data_mode)):
        out = match_requirement(body.requirement, body.category)
    out.pop("ranking", None)
    out.pop("eligible", None)
    return out


@app.post("/reindex")
def reindex(data_mode: DataMode = "company"):
    """Rebuild the indexes after adding or changing files in data/."""
    return {"chunks": locked_reindex(data_mode)}
