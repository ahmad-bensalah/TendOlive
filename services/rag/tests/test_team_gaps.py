"""PMP role inference, tool records, team builder and knowledge coverage report."""
import pytest

from rag import records
from rag.context import for_mode, retrieval_scope
from rag.index import build_index, index_ready, load_doc_store
from rag.retriever import match_requirement, retrieve


@pytest.fixture(scope="module", autouse=True)
def index():
    if not index_ready():
        build_index()


def test_pmp_holder_counts_as_project_manager():
    r = match_requirement("1 project manager PMP certified", "team")
    assert r["status"] == "covered"
    m = r["matches"][0]
    assert m["doc_id"] == "CV_17_Julian_Hayes.pdf"
    assert any("via PMP" in why for why in m["matched_on"])
    assert "PMP" in m["evidence"]["quote"] or "Project Management Professional" in m["evidence"]["quote"]


def test_prince2_still_missing():
    assert match_requirement("PRINCE2 certified project manager", "team")["status"] == "missing"


def test_tool_record_validation_and_profile():
    tool = records.new_record(records.RecordInput(type="tool", title="Test accelerator",
                                                  description="Reusable ingestion component.",
                                                  tool_kind="internal_accelerator", technologies=["Talend"],
                                                  use_cases="Data integration"))
    assert records.validate_record(tool, [])["valid"]
    assert "talend" in records.profile(tool)["skills"]
    incomplete = records.new_record(records.RecordInput(type="tool", title="No kind", description="x",
                                                        technologies=["Talend"], use_cases="x"))
    assert "tool_kind" in records.validate_record(incomplete, [])["errors"]


def test_project_team_must_reference_real_cvs():
    base = dict(type="past_project", title="Team test", description="d", client="c", company_role="r",
                scope="s", technologies=["Python"], delivery_status="completed")
    ok = records.new_record(records.RecordInput(**base, team_cv_ids=["CV_08_Lucas_Reed.pdf"]))
    assert records.validate_record(ok, [])["valid"]
    assert "Lucas Reed (CV_08)" in "\n".join(records.statements(ok))
    bad = records.new_record(records.RecordInput(**base, team_cv_ids=["CV_99_Nobody.pdf"]))
    assert "team_cv_ids" in records.validate_record(bad, [])["errors"]
    no_sector = records.validate_record(ok, [])
    assert any("sector" in w for w in no_sector["warnings"])


def test_tools_answer_technical_requirements_in_demo():
    with retrieval_scope(for_mode("demo")):
        build_index()
        assert any(d["type"] == "tool" for d in load_doc_store().values())
        out = match_requirement("Power BI dashboards", "technical")
        assert any(m["type"] == "tool" for m in out["matches"]) or out["status"] == "covered"


def test_team_builder_finds_smallest_team():
    out = retrieve({"team": ["At least 3 data engineers", "1 Google Cloud Professional Data Engineer certified",
                             "1 project manager PMP certified"]})
    team = out["team_proposal"]
    assert team and team["unfilled"] == []
    # The certified data engineer also counts as one of the 3, and the PMP holder is the PM: 4 people.
    assert team["size"] == 4 and team["places_filled"] == team["places_needed"]
    ids = [m["doc_id"] for m in team["members"]]
    assert "CV_17_Julian_Hayes.pdf" in ids
    assert len(set(ids)) == len(ids)


def test_team_builder_reports_unfillable_roles():
    out = retrieve({"team": ["Minimum 3 senior developers", "1 UX/UI designer"]})
    unfilled = {u["requirement"] for u in out["team_proposal"]["unfilled"]}
    assert {"Minimum 3 senior developers", "1 UX/UI designer"} <= unfilled


def test_knowledge_gaps_explain_missing_items():
    out = retrieve({"technical": ["Qlik Sense reporting"], "team": ["1 UX/UI designer"],
                    "experience": ["At least 1 previous project in the finance sector"], "sector": "Finance"})
    kinds = {(g["requirement"], g["kind"]) for g in out["knowledge_gaps"]}
    assert ("1 UX/UI designer", "people") in kinds
    assert ("At least 1 previous project in the finance sector", "project") in kinds
    assert any(g["requirement"] == "Qlik Sense reporting" for g in out["knowledge_gaps"])
    assert all(g["suggestion"] for g in out["knowledge_gaps"])
    assert out["knowledge_counts"]["cv"] == 19


def test_contract_fields_unchanged():
    out = retrieve({"technical": ["Terraform infrastructure as code"]})
    assert all({"doc_id", "type", "similarity_score", "summary"} <= set(m) for m in out["matches"])
