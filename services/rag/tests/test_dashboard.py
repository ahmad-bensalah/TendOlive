"""API tests for the dashboard endpoints (run on the private test copy of data/)."""
import base64
import json
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
    r = client.get("/", follow_redirects=False)
    assert r.status_code == 307 and r.headers["location"] == "http://localhost:5173/"
    assert client.get("/health").json()["index_ready"] is True


def test_examples_and_documents(client):
    names = [e["name"] for e in client.get("/api/examples").json()]
    assert "tender_requirements" in names and not any(n.startswith("output_") for n in names)
    docs = client.get("/api/documents").json()
    assert docs["ready"] and len(docs["documents"]) == 19
    one = client.get("/api/documents/CV_17_Julian_Hayes.pdf").json()
    assert "PMP" in one["profile"]["certifications"] and one["text_lines"]
    assert client.get("/api/documents/nope.md").status_code == 404


def test_record_is_indexed_then_deleted(client):
    payload = {"type": "tech_stack", "title": "Test stack " + uuid.uuid4().hex,
               "description": "Local test stack for data workloads.", "technologies": ["Snowflake"],
               "use_cases": "Data warehousing", "action": "index"}
    r = client.post("/api/records", json=payload)
    assert r.status_code == 200, r.text
    added = r.json()["record"]
    assert added["origin"] == "user_entered" and added["status"] == "indexed"
    assert added["id"] in [x["doc_id"] for x in client.get("/api/documents").json()["documents"]]
    assert client.delete("/api/records/" + added["id"]).status_code == 200
    assert added["id"] not in [x["doc_id"] for x in client.get("/api/documents").json()["documents"]]


def test_uploads_are_replaced_by_forms(client):
    assert client.post("/api/documents", json={"filename": "CV_Test.pdf", "doc_type": "cv"}).status_code == 410
    assert client.post("/api/documents", json={"filename": "project.pdf", "doc_type": "past_project"}).status_code == 410


def test_builtin_documents_cannot_be_deleted(client):
    assert client.delete("/api/documents/CV_17_Julian_Hayes.pdf").status_code == 403


def test_benchmark_results(client, tmp_path, monkeypatch):
    from rag import dashboard
    monkeypatch.setattr(dashboard, "BENCHMARK_DIR", tmp_path)
    assert client.get("/api/benchmark").json() == {"available": False}
    (tmp_path / "results.json").write_text(json.dumps({
        "meta": {"corpus": "authoritative_cv_only"}, "real_cvs": {}, "constraints": {}
    }), encoding="utf-8")
    r = client.get("/api/benchmark").json()
    assert r["available"] and r["meta"]["corpus"] == "authoritative_cv_only"


def test_unknown_job_kind(client):
    assert client.post("/api/jobs/deploy").status_code == 422
    assert client.get("/api/jobs/unknown").status_code == 404


def test_draft_validation_update_and_duplicate_rejection(client):
    draft = client.post("/api/records", json={"type": "tech_stack", "title": "Draft workflow"}).json()["record"]
    record_id = draft["id"]
    try:
        assert record_id not in [d["doc_id"] for d in client.get("/api/documents").json()["documents"]]
        invalid = client.post(f"/api/records/{record_id}/index")
        assert invalid.status_code == 422 and "technologies" in invalid.json()["detail"]["errors"]
        complete = {"type": "tech_stack", "title": "Draft workflow", "description": "Warehouse services",
                    "technologies": ["Snowflake"], "use_cases": "Analytics", "action": "index"}
        assert client.put(f"/api/records/{record_id}", json=complete).status_code == 200
        duplicate = client.post("/api/records", json=complete)
        assert duplicate.status_code == 422 and "title" in duplicate.json()["detail"]["errors"]
        assert client.put(f"/api/records/{record_id}", json={"type": "client_portfolio"}).status_code == 422
        complete["action"] = "draft"
        assert client.put(f"/api/records/{record_id}", json=complete).status_code == 200
        assert record_id not in [d["doc_id"] for d in client.get("/api/documents").json()["documents"]]
    finally:
        client.delete(f"/api/records/{record_id}")


def test_demo_is_read_only_and_existing_tender_contract_defaults_to_company(client):
    demo = client.get("/api/records?data_mode=demo").json()["records"]
    assert demo and all(r["read_only"] for r in demo)
    record_id = demo[0]["id"]
    assert client.put(f"/api/records/{record_id}", json={"type": demo[0]["type"]}).status_code == 403
    assert client.delete(f"/api/records/{record_id}").status_code == 403
    out = client.post("/retrieve/tender", json={"tender_id": "compatibility-test",
        "title": "Compatibility tender", "deadline": "2026-12-15", "language": "fr",
        "requirements": {"technical": [], "team": ["PMP certification"], "experience": []}}).json()
    assert out["data_mode"] == "company" and out["tender_id"] == "compatibility-test"
    assert out["matches"] and all({"doc_id", "type", "similarity_score", "summary"} <= set(m) for m in out["matches"])
    stored = client.get("/api/tenders").json()["tenders"]
    saved = next(t for t in stored if t["tender_id"] == "compatibility-test")
    assert saved["deadline"] == "2026-12-15" and saved["language"] == "fr"
    assert saved["rag_analysis"]["tender_id"] == "compatibility-test"


def test_analysed_tenders_can_be_deleted_and_cleared(client, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "TENDERS_FILE", tmp_path / "tenders.json")
    documents_before = len(client.get("/api/documents").json()["documents"])
    for tender_id in ("inbox-1", "inbox-2"):
        r = client.post("/retrieve/tender", json={"tender_id": tender_id, "title": "Inbox " + tender_id,
                                                 "requirements": {"technical": ["Terraform"]}})
        assert r.status_code == 200
    assert {t["tender_id"] for t in client.get("/api/tenders").json()["tenders"]} == {"inbox-1", "inbox-2"}
    assert client.delete("/api/tenders/inbox-1").json() == {"deleted": "inbox-1"}
    assert client.get("/api/tenders/inbox-1").status_code == 404
    assert client.get("/api/tenders/inbox-2").json()["rag_analysis"]["tender_id"] == "inbox-2"
    assert client.delete("/api/tenders").json() == {"deleted": 1}
    assert client.get("/api/tenders").json()["tenders"] == []
    # Clearing the inbox leaves the knowledge base and its index alone.
    assert len(client.get("/api/documents").json()["documents"]) == documents_before


def test_record_list_reads_the_record_files_once(client, monkeypatch):
    from rag import records
    real, calls = records.all_records, []

    def counting(*args, **kwargs):
        calls.append(1)
        return real(*args, **kwargs)
    monkeypatch.setattr(records, "all_records", counting)
    listed = client.get("/api/records?data_mode=demo").json()["records"]
    # One read for the list and one for the checks, however many records there are (it was one per record).
    assert len(listed) > 5 and len(calls) <= 2
    monkeypatch.undo()
    for item in listed[:5]:  # the same validation as a record checked on its own
        record = {k: v for k, v in item.items() if k not in ("validation", "read_only")}
        assert item["validation"] == records.validate_record(record)


def test_index_failure_saves_draft_and_provides_retry(client, monkeypatch):
    from rag import dashboard
    def fail():
        raise RuntimeError("simulated index failure")
    monkeypatch.setattr(dashboard, "build_index", fail)
    r = client.post("/api/records", json={"type": "tech_stack", "title": "Retry test",
        "description": "Local analytics", "technologies": ["Python"], "use_cases": "Analytics", "action": "index"})
    assert r.status_code == 503
    record = r.json()["detail"]["record"]
    assert record["status"] == "draft" and "Retry" in r.json()["detail"]["message"]
    assert record["id"] not in [d["doc_id"] for d in client.get("/api/documents").json()["documents"]]
    from rag import records
    records.record_path(record).unlink()
