"""Run: python -m pytest -q
Unit tests for the parser and profiles, plus end-to-end checks on the mock knowledge base."""
import json
from pathlib import Path

import pytest

from rag.index import build_index, doc_store_path, index_ready
from rag.loader import chunk_words, load_documents
from rag.profiles import build_profile
from rag.reqparse import parse
from rag.retriever import match_requirement, retrieve

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="session", autouse=True)
def index():
    if not index_ready():
        build_index()


# ---------------------------------------------------------------- parser
@pytest.mark.parametrize("text,category,expected", [
    ("Minimum 3 senior developers", "team", {"roles": ["developer"], "seniority": "senior", "min_count": 3}),
    ("1 project manager PMP certified", "team", {"certs": ["PMP"], "roles": ["project manager"]}),
    ("Chef de projet certifie PMP", "team", {"certs": ["PMP"], "roles": ["project manager"]}),
    ("React or Angular frontend", "technical", {"skills": ["react", "angular"]}),
    ("2+ previous public sector digital projects", "experience", {"sectors": ["public"], "min_count": 2}),
    ("Au moins 2 projets dans le secteur public", "experience", {"sectors": ["public"], "min_count": 2}),
])
def test_parser(text, category, expected):
    got = parse(text, category).as_dict()
    for key, value in expected.items():
        assert got[key] == value, (key, got)


def test_optional_and_and():
    assert parse("ISO 27001 preferred", "experience").mandatory is False
    assert parse("Certification ISO 27001 souhaitée", "experience").mandatory is False
    assert parse("Certification ISO 27001 préférée", "experience").mandatory is False
    assert parse("ISO 27001 required", "experience").mandatory is True
    assert parse("Kubernetes and Terraform", "technical").all_skills is True
    assert parse("AWS ou Azure", "technical").all_skills is False


def test_unknown_words_are_not_decided_by_rules():
    assert not parse("SAP ABAP developer", "team").fully_understood
    assert not parse("Blockchain traceability", "experience").fully_understood


# ---------------------------------------------------------------- profiles
def test_profiles():
    store = json.loads(doc_store_path().read_text(encoding="utf-8"))
    sami = store["CV_Sami_Trabelsi.md"]["profile"]
    hana = store["CV_Hana_Ktari.md"]["profile"]
    walid = store["CV_Walid_Masmoudi.md"]["profile"]
    assert "PMP" in sami["certifications"] and "PMP" not in hana["certifications"]
    assert walid["seniority"] == "junior"
    assert "public" in store["Project_MinistryInterior_LicensingPortal.md"]["profile"]["sectors"]


# ---------------------------------------------------------------- loader (real files)
REAL_CV = """Yassine Ben Ali
Senior Backend Developer
6+ years of experience building APIs for banks and ministries.
Skills: Java, Spring Boot, PostgreSQL, Docker, AWS
Certifications
AWS Certified Developer - Associate
Languages: French, English"""


def _check_real_cv(docs, name):
    doc = next(d for d in docs if d.doc_id == name)
    prof = build_profile(doc)
    assert doc.doc_type == "cv"
    assert "developer" in prof["roles"] and prof["seniority"] == "senior" and prof["years"] == 6
    assert {"java", "spring", "postgresql", "aws"} <= set(prof["skills"])
    assert "AWS Certified" in prof["certifications"]


def test_loader_reads_docx(tmp_path):
    docx = pytest.importorskip("docx")
    (tmp_path / "team_cvs").mkdir()
    d = docx.Document()
    for line in REAL_CV.splitlines():
        d.add_paragraph(line)
    d.save(tmp_path / "team_cvs" / "CV_Yassine.docx")
    _check_real_cv(load_documents(tmp_path), "CV_Yassine.docx")


def test_loader_reads_pdf(tmp_path):
    canvas = pytest.importorskip("reportlab.pdfgen.canvas")
    (tmp_path / "team_cvs").mkdir()
    c = canvas.Canvas(str(tmp_path / "team_cvs" / "CV_Yassine.pdf"))
    y = 800
    for line in REAL_CV.splitlines():
        c.drawString(50, y, line)
        y -= 18
    c.save()
    _check_real_cv(load_documents(tmp_path), "CV_Yassine.pdf")


def test_loader_skips_empty_and_broken_files(tmp_path):
    (tmp_path / "cvs").mkdir()
    (tmp_path / "cvs" / "empty.txt").write_text("", encoding="utf-8")
    (tmp_path / "cvs" / "broken.pdf").write_bytes(b"not a pdf")
    (tmp_path / "cvs" / "README.md").write_text("instructions " * 30, encoding="utf-8")
    assert load_documents(tmp_path) == []


def test_chunking_overlap():
    words = [f"w{i}" for i in range(450)]
    chunks = chunk_words(" ".join(words), size=200, overlap=50)
    assert len(chunks) == 3
    assert chunks[1].split()[0] == "w150" and chunks[-1].split()[-1] == "w449"


# ---------------------------------------------------------------- end to end
TESTS = json.loads((ROOT / "benchmark" / "constraint_tests.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", TESTS, ids=[t["q"][:40] for t in TESTS])
def test_constraint_cases(case):
    r = match_requirement(case["q"], case["category"])
    assert r["status"] == case["expect"], case["why"]
    docs = [m["doc_id"] for m in r["matches"]]
    if "allowed" in case:
        assert set(docs) <= set(case["allowed"]), case["why"]
    assert r["found"] >= case.get("min_found", 0)


def test_every_match_has_evidence():
    out = retrieve(json.loads((ROOT / "examples" / "tender_requirements.json").read_text(encoding="utf-8")))
    assert out["matches"]
    for m in out["matches"]:
        assert m["evidence"] and m["evidence"]["quote"]
        assert {"doc_id", "type", "similarity_score", "summary"} <= set(m)


def test_incomplete_tender_does_not_crash():
    out = retrieve({"technical": ["", "Logiciels de securite informatique"], "team": None,
                    "experience": "Blockchain supply-chain traceability"})
    assert out["fit_score"]["team_fit"] is None
    assert any("BLOCKING" in w for w in out["warnings"])


def test_missing_requirement_shows_closest_document_separately():
    r = match_requirement("Salesforce CRM integration", "technical")
    assert r["status"] == "missing" and r["matches"] == []
    assert r["closest"] and r["closest"]["doc_id"]


def test_empty_tender():
    out = retrieve({})
    assert out["matches"] == [] and out["fit_score"]["overall"] is None
