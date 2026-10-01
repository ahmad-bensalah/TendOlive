"""REST API for RAG retrieval service and n8n pipeline integration."""
import logging
from contextlib import asynccontextmanager
from typing import Literal, Optional, Union

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import __version__, config
from .dashboard import index_lock, reindex as locked_reindex, router as dashboard_router
from .index import build_index, embed, index_ready, index_up_to_date, rerank_scores
from .retriever import match_requirement, retrieve

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not index_up_to_date():
        logger.info("Index requires rebuild; starting initial indexing...")
        build_index()
    # Pre-warm embedding and reranker models in memory for optimal request latency.
    embed(config.EMBEDDING_MODEL, ["warm up"], "query")
    if config.RERANKER_MODEL:
        rerank_scores(config.RERANKER_MODEL, "warm up", ["warm up"])
    logger.info("RAG Retrieval API service initialized and ready.")
    yield


app = FastAPI(
    title="OliveSoft RAG Retrieval Service",
    version=__version__,
    lifespan=lifespan,
    description="Evidence-based matching of tender requirements to OliveSoft internal assets (CVs, past projects, tech stacks).",
)
# Lets the web dashboard (and other local pages) call the API from the browser.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.include_router(dashboard_router)

StrList = Union[list[str], str, None]


class Requirements(BaseModel):
    technical: StrList = []
    team: StrList = []
    experience: StrList = []
    timeline: Optional[str] = None
    sector: Optional[str] = None
    client: Optional[str] = None


class TenderRecord(BaseModel):
    """Full tender record payload received from upstream RFP extraction."""
    tender_id: Optional[str] = None
    client: Optional[str] = None
    sector: Optional[str] = None
    requirements: Requirements = Field(default_factory=Requirements)


class OneRequirement(BaseModel):
    requirement: str
    category: Literal["technical", "team", "experience"] = "technical"


@app.get("/health")
def health():
    return {"status": "ok", "version": __version__, "model": config.EMBEDDING_MODEL,
            "reranker": config.RERANKER_MODEL or None, "index_ready": index_ready()}


@app.post("/retrieve")
def retrieve_endpoint(req: Requirements):
    """Match a requirements payload across technical, team, and experience categories."""
    with index_lock.read():
        return retrieve(req.model_dump())


@app.post("/retrieve/tender")
def retrieve_from_tender(tender: TenderRecord):
    """Primary pipeline endpoint: match full RFP tender record for downstream proposal synthesis."""
    body = tender.requirements.model_dump()
    body["sector"] = body.get("sector") or tender.sector
    body["client"] = body.get("client") or tender.client
    with index_lock.read():
        out = retrieve(body)
    out["tender_id"] = tender.tender_id
    return out


@app.post("/match")
def match_one(body: OneRequirement):
    """Check a single requirement (useful for the dashboard and for debugging)."""
    with index_lock.read():
        out = match_requirement(body.requirement, body.category)
    out.pop("ranking", None)
    return out


@app.post("/reindex")
def reindex():
    """Rebuild the indexes after adding or changing files in data/."""
    return {"chunks": locked_reindex()}
