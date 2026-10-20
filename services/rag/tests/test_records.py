import json
from concurrent.futures import ThreadPoolExecutor

import pytest

from rag import records
from rag.context import current, for_mode, retrieval_scope
from rag.index import build_index, load_doc_store, index_meta, index_ready
from rag.retriever import match_requirement


@pytest.fixture(scope="module", autouse=True)
def records_index():
    if not index_ready():
        build_index()


def project(title="Test project", delivery_status="completed"):
    return {"type": "past_project", "title": title, "description": "A Python analytics delivery.",
            "client": "Anonymized client", "sector": "public", "company_role": "Implementation",
            "scope": "Analytics pipelines", "technologies": ["Python"], "delivery_status": delivery_status}


def test_validation_drafts_and_duplicate_identity():
    draft = records.new_record(records.RecordInput(type="past_project"))
    assert not records.validate_record(draft, [])["valid"]
    record = records.new_record(records.RecordInput(**project()))
    assert records.validate_record(record, [])["valid"]
    other = records.new_record(records.RecordInput(**project()))
    assert records.validate_record(other, [record])["duplicate_ids"] == [record["id"]]
    assert records.validate_record(other, [record])["errors"]["title"]


def test_certification_is_not_inferred_from_records():
    record = records.new_record(records.RecordInput(type="tech_stack", title="ISO aligned",
           description="AWS certified team and ISO 27001-aligned delivery", technologies=["AWS"], use_cases="Hosting"))
    profile = records.profile(record)
    assert profile["certifications"] == []
    assert "aws" in profile["skills"]
    record["title"] = "ISO 27001 certified hosting with PMP project managers"
    assert records.profile(record)["certifications"] == [] and records.profile(record)["roles"] == []


def test_record_profile_reads_the_title_and_description():
    # Run 3: "LLM chatbot with RAG" was a gap although this demo record exists (technologies:
    # fastapi, langchain, llm, python). Its title and description name RAG and the chatbot.
    chatbot = next(r for r in records.all_records() if r["id"] == "demo_Project_Telecom_RAGChatbot")
    p = records.profile(chatbot)
    assert {"rag", "chatbot", "generative ai", "llm", "langchain"} <= set(p["skills"])
    assert p["skills_from_text"] == ["chatbot", "generative ai", "rag"]
    assert p["sectors"] == ["telecom"] and p["sectors_from_text"] == []
    assert p["certifications"] == [] and p["roles"] == []

    def make(**fields):
        return records.new_record(records.RecordInput(**{"type": "past_project", "technologies": ["Docker"], **fields}))
    hospital = make(title="Patient portal for a regional hospital",
                    description="Moved 20 servers to a 5-node Docker Swarm and built social-media dashboards.")
    p = records.profile(hospital)
    assert "dashboard" in p["skills"] and "node.js" not in p["skills"]       # "5-node" is not Node.js
    assert p["sectors"] == ["health"] and p["sectors_from_text"] == ["health"]  # not "media"
    assert any("health sector named in the title" in w for w in records.validate_record(hospital, [])["warnings"])
    # An explicit sector field decides; a product word is not a sector.
    assert records.profile({**hospital, "sector": "public"})["sectors"] == ["public"]
    assert records.profile(make(title="Health-monitoring app", description="Built a mobile app."))["sectors"] == []
    assert any("will not count as sector experience" in w
               for w in records.validate_record(make(title="Health-monitoring app"), [])["warnings"])
    # A client record describes the client's business, not OliveSoft skills.
    client = records.new_record(records.RecordInput(type="client_portfolio", title="Skill and You",
                                description="Online training and Python courses.", sector="education",
                                relationship="OliveSoft client"))
    assert records.profile(client)["skills"] == [] and records.profile(client)["sectors"] == ["education"]


def test_context_isolation_in_parallel_threads():
    def resolve(mode):
        with retrieval_scope(for_mode(mode)):
            return current().mode, str(current().db_dir)
    with ThreadPoolExecutor(max_workers=2) as pool:
        a, b = list(pool.map(resolve, ["company", "demo"]))
    assert a[0] == "company" and b[0] == "demo" and a[1] != b[1]
    assert current().mode == "company"


def test_index_failure_keeps_previous_generation(monkeypatch):
    from rag import index
    before = index_meta()
    before_store = load_doc_store()
    def fail(*args, **kwargs):
        raise RuntimeError("embedding failure")
    monkeypatch.setattr(index, "embed", fail)
    with pytest.raises(RuntimeError, match="embedding failure"):
        build_index()
    assert index_meta() == before
    assert load_doc_store() == before_store


def test_draft_and_incomplete_projects_never_count():
    record = records.new_record(records.RecordInput(**project(delivery_status="ongoing")))
    records.persist(record)
    try:
        build_index()
        assert record["id"] not in load_doc_store()
        record["status"] = "indexed"
        records.persist(record)
        build_index()
        assert record["id"] in load_doc_store()
        out = match_requirement("Previous public sector projects", "experience")
        assert record["id"] not in [m["doc_id"] for m in out["matches"]]
    finally:
        records.record_path(record).unlink()
        build_index()


def test_user_statement_provenance_and_edit_invalidation():
    record = records.new_record(records.RecordInput(**project()))
    record["status"] = "indexed"
    records.persist(record)
    try:
        build_index()
        out = match_requirement("Previous public sector projects", "experience")
        match = next(m for m in out["matches"] if m["doc_id"] == record["id"])
        assert match["origin"] == "user_entered"
        assert match["evidence"]["quote"] is None and match["evidence"]["statement"]
        record["status"] = "draft"
        records.persist(record)
        assert record["id"] not in load_doc_store()  # excludes edited draft before reindex
    finally:
        records.record_path(record).unlink()
        build_index()


def test_demo_records_are_separate_and_client_portfolio_is_split():
    with retrieval_scope(for_mode("demo")):
        build_index()
        store = load_doc_store()
        assert any(d["origin"] == "demo" for d in store.values())
        assert not any(d["origin"] == "user_entered" for d in store.values())
        assert len([r for r in records.visible_records() if r["type"] == "client_portfolio"]) == 12
    assert not any(d["origin"] == "demo" for d in load_doc_store().values())


def test_parallel_matching_uses_separate_modes():
    def match(mode):
        with retrieval_scope(for_mode(mode)):
            out = match_requirement("Previous public sector projects", "experience")
            return out
    with ThreadPoolExecutor(max_workers=2) as pool:
        company, demo = list(pool.map(match, ["company", "demo"]))
    assert company["data_mode"] == "company" and company["status"] == "missing"
    assert demo["data_mode"] == "demo" and demo["status"] == "covered"
    assert all(m["origin"] == "demo" for m in demo["matches"])


def test_generic_project_counts_exclude_clients_and_personal_cv_experience():
    client = records.new_record(records.RecordInput(type="client_portfolio", title="Test client",
        description="A client relationship, not a delivered project.", sector="health", relationship="Customer"))
    client["status"] = "indexed"
    records.persist(client)
    try:
        build_index()
        out = match_requirement("3 previous projects", "experience")
        assert out["status"] == "missing" and out["found"] == 0
    finally:
        records.record_path(client).unlink()
        build_index()
