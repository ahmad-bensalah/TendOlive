"""API tests for the dashboard endpoints (run on the private test copy of data/)."""
import base64
import uuid

import pytest
from fastapi.testclient import TestClient

from rag import config
from rag.api import app


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:  # runs the startup: builds the index if needed, loads the models
        yield c


def b64(text: str) -> str:
    return base64.b64encode(text.encode("utf-8")).decode()


def test_tests_use_a_private_copy():
    assert "rag_tests_" in str(config.DATA_DIR) and "rag_tests_" in str(config.DB_DIR)


def test_page_and_health(client):
    r = client.get("/")
    assert r.status_code == 200 and "RAG Console" in r.text
    assert client.get("/health").json()["index_ready"] is True


def test_examples_and_documents(client):
    names = [e["name"] for e in client.get("/api/examples").json()]
    assert "tender_requirements" in names and not any(n.startswith("output_") for n in names)
    docs = client.get("/api/documents").json()
    assert docs["ready"] and len(docs["documents"]) >= 32
    one = client.get("/api/documents/CV_Sami_Trabelsi.md").json()
    assert "PMP" in one["profile"]["certifications"] and one["text_lines"]
    assert client.get("/api/documents/nope.md").status_code == 404


def test_upload_is_matched_then_deleted(client):
    name = f"CV_Test_{uuid.uuid4().hex[:6]}.md"
    cv = ("Nadia Test\nSenior Mobile Developer\n9 years of experience in mobile apps for banks.\n"
          "Skills: Flutter, Dart, Firebase\nCertifications\nISTQB Foundation\n")
    r = client.post("/api/documents", json={"filename": name, "content_base64": b64(cv), "doc_type": "cv"})
    assert r.status_code == 200, r.text
    added = r.json()["added"]
    assert added["uploaded"] and added["profile"]["seniority"] == "senior"
    assert "ISTQB" in added["profile"]["certifications"]

    m = client.post("/match", json={"requirement": "Flutter developer ISTQB certified", "category": "team"}).json()
    assert m["status"] == "covered" and name in [x["doc_id"] for x in m["matches"]], m

    assert client.delete(f"/api/documents/{name}").status_code == 200
    assert name not in [d["doc_id"] for d in client.get("/api/documents").json()["documents"]]


def test_upload_rejects_bad_files(client):
    assert client.post("/api/documents", json={"filename": "x.exe", "content_base64": b64("hello " * 30)}).status_code == 400
    assert client.post("/api/documents", json={"filename": "x.md", "content_base64": "not base64!"}).status_code == 400
    assert client.post("/api/documents", json={"filename": "x.md", "content_base64": b64("too short")}).status_code == 422
    assert client.post("/api/documents", json={"filename": "x.pdf", "content_base64": b64("%PDF-1.4 broken")}).status_code == 422


def test_builtin_documents_cannot_be_deleted(client):
    assert client.delete("/api/documents/CV_Sami_Trabelsi.md").status_code == 403


def test_benchmark_results(client):
    r = client.get("/api/benchmark").json()
    assert r["available"] and "constraints" in r


def test_unknown_job_kind(client):
    assert client.post("/api/jobs/deploy").status_code == 422
    assert client.get("/api/jobs/unknown").status_code == 404
