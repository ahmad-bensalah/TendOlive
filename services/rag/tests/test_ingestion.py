"""Ingestion fixes seen in the third live n8n run, and the automatic index rebuild after them.

Run 3 quoted the tail of a CV sentence ("users by 35 % within six months.") and missed
"LLM chatbot with RAG" although a demo record titled "RAG Customer Service Chatbot" exists.
"""
import json

import pytest

from rag import index
from rag.context import for_mode, retrieval_scope
from rag.index import build_index, index_meta, index_meta_path, index_up_to_date, load_doc_store
from rag.reqparse import parse
from rag.retriever import find_evidence, match_requirement


@pytest.fixture(scope="module", autouse=True)
def indexes():
    for mode in ("company", "demo"):
        with retrieval_scope(for_mode(mode)):
            if not index_up_to_date():
                build_index()


def test_cv_quote_is_a_whole_sentence():
    doc = load_doc_store()["CV_12_Mateo_Silva.pdf"]
    quote = find_evidence(parse("vector database", "technical"), doc, use_reranker=True)["quote"]
    assert quote == ("Integrated LangChain and Pinecone vector databases to power semantic search and "
                     "Retrieval-Augmented Generation, cutting content-generation latency by 55 %.")


def test_llm_chatbot_with_rag_is_proved_by_the_demo_record():
    with retrieval_scope(for_mode("demo")):
        out = match_requirement("LLM chatbot with RAG", "technical")
    assert out["status"] == "covered"
    match = next(m for m in out["matches"] if m["doc_id"] == "demo_Project_Telecom_RAGChatbot")
    assert {"llm", "chatbot", "rag"} <= set(match["matched_on"])
    assert match["origin"] == "demo" and match["evidence"]["quote"] is None


def test_index_is_out_of_date_when_the_ingestion_code_changes(monkeypatch):
    assert index_up_to_date()
    assert {"cvparse.py", "loader.py", "records.py", "profiles.py", "index.py", "taxonomy.py"} \
        <= set(index.INGESTION_MODULES)
    monkeypatch.setattr(index, "code_fingerprint", lambda: "other code")
    assert not index_up_to_date()
    monkeypatch.undo()
    monkeypatch.setattr(index, "INDEX_FORMAT", index.INDEX_FORMAT + 1)
    assert not index_up_to_date()


def test_api_start_rebuilds_an_index_made_by_older_ingestion_code():
    from fastapi.testclient import TestClient
    from rag.api import app

    meta = index_meta()
    meta.update(format=index.INDEX_FORMAT - 1, code="older ingestion code")
    index_meta_path().write_text(json.dumps(meta), encoding="utf-8")
    assert not index_up_to_date()
    with TestClient(app):   # the startup rebuilds every index that is out of date
        pass
    assert index_up_to_date()
    assert index_meta()["format"] == index.INDEX_FORMAT and index_meta()["code"] == index.code_fingerprint()
    assert len(load_doc_store()) == 19
