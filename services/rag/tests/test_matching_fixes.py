"""Fixes from the live n8n runs (RAG v2, run 3).

- PSM and CSM are two certificates: a requirement naming one is met only by it; the other is partial.
  One certificate is enough only when the choice is between them ("PMP or PRINCE2", not
  "PMP and PRINCE2 ... or program manager", not "or equivalent").
- A proof line must name the requirement ("vector database" was "proved" by "users by 35 % within six months.").
- A filler word next to a technology ("Angular interface") does not send the row to the reranker,
  and the reranker alone never makes a row missing when the rules matched the named technologies.
  Without a technology ("API integration", "Web development") these words are the need and stay.
- In demo mode a real document is the best document when it scores about the same as a demo record.
"""
import pytest

from rag import retriever
from rag import taxonomy as tx
from rag.context import for_mode, retrieval_scope
from rag.index import build_index, index_ready, index_up_to_date
from rag.reqparse import parse
from rag.retriever import (find_evidence, match_requirement, meets_constraints, meets_with_equivalent,
                           names_requirement, retrieve)

PSM, CSM, ANY_SM = "Professional Scrum Master (PSM)", "Certified Scrum Master (CSM)", "Scrum Master (PSM/CSM)"


@pytest.fixture(scope="module")
def index():
    if not index_ready():
        build_index()


def cv_profile(*certs, roles=()):
    """A CV profile whose Certifications section lists these lines (skills read from them too)."""
    text = " | ".join(certs)
    return {"certifications": sorted(set(tx.find_certs(text))), "roles": list(roles),
            "skills": tx.expand_skills(tx.find_skills(text))}


# ---------------------------------------------------------------- certificates
@pytest.mark.parametrize("text,certs,any_cert", [
    ("1 PSM certified Scrum Master", [PSM], False),
    ("1 CSM certified Scrum Master", [CSM], False),
    ("Certified Scrum Master", [ANY_SM], False),            # no acronym: either certificate
    ("Scrum Master certification", [ANY_SM], False),
    ("PSM or CSM certified Scrum Master", [PSM, CSM], True),
    ("Scrum Master PSM/CSM", [PSM, CSM], True),
    ("PMP or PRINCE2 certified project manager", ["PMP", "PRINCE2"], True),
    ("Product owner PSPO certified", ["Professional Scrum Product Owner (PSPO)"], False),
    ("Azure Solutions Architect (AZ-305)", ["Azure Solutions Architect (AZ-305)"], False),
    ("Azure certified engineer", ["Azure Certified"], False),
    ("AWS Certified Solutions Architect", ["AWS Solutions Architect"], False),
    ("Certified Salesforce administrator", ["Salesforce Administrator"], False),
    ("Senior DevOps engineer expert in Kubernetes", [], False),     # a role, not the AZ-400 exam
])
def test_requirement_names_a_specific_certificate(text, certs, any_cert):
    r = parse(text, "team")
    assert r.certs == certs and r.any_cert is any_cert


def test_a_certificate_also_counts_as_its_family():
    assert set(tx.find_certs("Certified Scrum Master (CSM) - Scrum Alliance, 2022")) == {CSM, ANY_SM}
    assert set(tx.find_certs("Professional Scrum Master I (PSM I)")) == {PSM, ANY_SM}
    assert "Azure Certified" in tx.find_certs("Microsoft Certified: Data Engineer Associate")
    assert "Azure Solutions Architect (AZ-305)" not in tx.find_certs("Microsoft Certified: Azure Fundamentals")
    assert tx.implied_roles([], [CSM, ANY_SM]) == {"scrum master": f"{ANY_SM} certification"}


def test_csm_holder_only_partly_meets_a_psm_requirement():
    csm = cv_profile("Certified Scrum Master (CSM)")
    psm_req, csm_req, any_req = (parse(t, "team") for t in
                                 ("1 PSM certified Scrum Master", "1 CSM certified Scrum Master", "Certified Scrum Master"))
    assert meets_constraints(psm_req, csm, "cv") == []
    why = meets_with_equivalent(psm_req, csm, "cv")
    assert any(f"{CSM} instead of {PSM}" in w and "equivalent certification" in w for w in why)
    assert CSM in meets_constraints(csm_req, csm, "cv")
    assert ANY_SM in meets_constraints(any_req, csm, "cv")
    assert ANY_SM in meets_constraints(any_req, cv_profile("Professional Scrum Master I (PSM I)"), "cv")


def test_other_exams_are_not_equivalent():
    fundamentals = cv_profile("Microsoft Certified: Azure Fundamentals")
    architect = parse("Azure Solutions Architect certification (AZ-305)", "team")
    assert meets_constraints(architect, fundamentals, "cv") == []
    assert meets_with_equivalent(architect, fundamentals, "cv") == []
    assert meets_constraints(parse("Azure certified", "team"), fundamentals, "cv")
    developer = cv_profile("Salesforce Platform Developer I")
    admin = parse("Certified Salesforce administrator", "team")
    assert meets_constraints(admin, developer, "cv") == [] and meets_with_equivalent(admin, developer, "cv") == []


def test_one_of_several_certificates_is_enough_when_the_tender_says_or():
    prince2 = {"certifications": ["PRINCE2"], "roles": ["project manager"], "skills": []}
    assert meets_constraints(parse("PMP or PRINCE2 certified project manager", "team"), prince2, "cv")
    assert not meets_constraints(parse("PMP and PRINCE2 certified project manager", "team"), prince2, "cv")


@pytest.mark.parametrize("text,any_cert", [
    # The "or" is between the roles, or it is "or more" / "or equivalent": both certificates are needed.
    ("PMP and PRINCE2 certified project manager or program manager", False),
    ("1 project manager certified PMP and PRINCE2, or a delivery manager", False),
    ("PMP and PRINCE2 certified project manager, 10 or more years of experience", False),
    ("PMP certified project manager; Scrum Master PSM or equivalent", False),
    ("Chef de projet certifie PMP et PRINCE2, ou equivalent", False),
    ("PMP, PRINCE2", False),
    # The choice is between the certificates.
    ("PMP or PRINCE2 certified project manager", True),
    ("PMP and/or PRINCE2 certified project manager", True),
    ("Chef de projet certifie PMP ou PRINCE2", True),
    ("Scrum Master PSM/CSM", True),
    ("PSM/CSM", True),
])
def test_one_certificate_is_enough_only_when_the_choice_is_between_them(text, any_cert):
    assert parse(text, "team").any_cert is any_cert


def test_counting_and_equivalence_words_are_not_left_over():
    assert parse("PMP and PRINCE2 certified project manager, 10 or more years of experience", "team").leftover == []
    assert parse("PMP certified project manager; Scrum Master PSM or equivalent", "team").leftover == []


def test_and_between_certificates_needs_both(index):
    out = retrieve({"team": ["PMP and PRINCE2 certified project manager or program manager"]})
    assert out["requirements_matrix"][0]["status"] == "missing"
    assert any("No CV lists the PRINCE2 certification" in g["gap"] for g in out["knowledge_gaps"])
    r = match_requirement("PMP and PRINCE2 certified project manager, 10 or more years of experience", "team")
    assert r["status"] == "missing" and r["method"] == "rules"
    r = match_requirement("PMP certified project manager; Scrum Master PSM or equivalent", "team")
    assert r["status"] == "missing" and r["method"] == "rules"


def test_a_member_certificate_proves_its_family():
    # "Product Owner certified" asks for any Product Owner certificate: the PSPO line is the proof.
    req = parse("Product Owner certified", "team")
    lines = ["Noah Bennett", "Product Owner / Delivery Manager July 2023 - Present",
             "Professional Scrum Product Owner I (PSPO I) - Scrum.org"]
    ev = find_evidence(req, doc(lines), False)
    assert ev["line"] == 3 and ev["weak"] is False
    # A CSM line proves the Scrum Master role (CERT_ROLES names the family).
    assert "csm" in tx.role_proof_terms("scrum master") and "psm" in tx.role_proof_terms("scrum master")


def test_product_owner_certificate_holder_has_a_naming_line(index):
    r = match_requirement("Product Owner certified", "team")
    assert r["status"] == "covered" and r["matches"][0]["doc_id"] == "CV_04_Noah_Bennett.pdf"
    assert r["matches"][0]["evidence"]["weak"] is False
    assert "PSPO" in r["matches"][0]["evidence"]["quote"]


def test_psm_requirement_is_partial_with_the_csm_holder(index):
    r = match_requirement("1 PSM certified Scrum Master", "team")
    assert r["status"] == "partial" and r["method"] == "rules"
    assert r["matches"][0]["doc_id"] == "CV_14_Henry_Price.pdf"
    assert any("equivalent certification, check it is accepted" in w for w in r["matches"][0]["matched_on"])
    assert "equivalent certification" in r["note"] and r["percent"] == 50
    assert match_requirement("1 CSM certified Scrum Master", "team")["status"] == "covered"
    assert match_requirement("Certified Scrum Master", "team")["status"] == "covered"     # benchmark check
    assert match_requirement("PSM or CSM certified Scrum Master", "team")["status"] == "covered"
    # The role is read from the certificate too: the delivery manager with a CSM can be the Scrum Master.
    assert match_requirement("1 Scrum Master CSM certified", "team")["status"] == "covered"


def test_equivalent_certificate_is_explained_in_team_and_gaps(index):
    out = retrieve({"team": ["1 PSM certified Scrum Master"]})
    row = out["requirements_matrix"][0]
    assert row["status"] == "partial" and row["note"]
    assert any("Henry Price" in n and "equivalent certification" in n for n in out["team_proposal"]["notes"])
    gap = next(g for g in out["knowledge_gaps"] if g["requirement"] == "1 PSM certified Scrum Master")
    assert PSM in gap["gap"] and CSM in gap["gap"] and "accepted" in gap["suggestion"]
    assert any("equivalent certification" in w for w in out["warnings"])


# ---------------------------------------------------------------- proof lines
LINES = ["Mateo Silva", "Product Owner", "users by 35 % within six months.",
         "Integrated LangChain and Pinecone vector databases to power semantic search.", "30 %."]


def doc(lines):
    return {"title": "Test CV", "summary": "", "lines": list(lines), "origin": "cv_document", "record": {}}


def test_proof_line_names_the_requirement():
    req = parse("vector database", "technical")
    assert names_requirement(req, LINES[3]) and not names_requirement(req, LINES[2])
    for use_reranker in (False, True):
        ev = find_evidence(req, doc(LINES), use_reranker)
        assert ev["line"] == 4 and ev["weak"] is False


def test_without_a_naming_line_the_evidence_is_weak_and_not_a_fragment():
    req = parse("statistical studies", "technical")
    assert not names_requirement(req, "Preparatory Engineering Studies")    # one word of two
    for use_reranker in (False, True):
        ev = find_evidence(req, doc(LINES), use_reranker)
        assert ev["weak"] is True and ev["note"]
        assert ev["quote"] not in ("users by 35 % within six months.", "30 %.")


def test_whole_line_preferred_to_a_wrapped_fragment():
    req = parse("Power BI", "technical")
    lines = ["payments. Proven ability to build Power BI reports.", "Designed a Power BI data model for finance."]
    assert find_evidence(req, doc(lines), False)["line"] == 2


def test_weak_line_alone_never_makes_a_row_covered(index, monkeypatch):
    # The reranker is sure, but no line of any document says "quantum annealing".
    monkeypatch.setattr(retriever, "rerank_scores", lambda model, query, passages: [5.0] * len(passages))
    r = match_requirement("quantum annealing optimisation", "technical")
    assert r["status"] == "partial" and r["matches"][0]["evidence"]["weak"]
    assert r["percent"] <= 50 and r["note"]


def test_vector_database_quote_names_it(index):
    r = match_requirement("vector database", "technical")
    quotes = [m["evidence"]["quote"] for m in r["matches"] if not m["evidence"]["weak"]]
    assert quotes and all("vect" in q.lower() for q in quotes)
    assert "users by 35 %" not in " ".join(m["evidence"]["quote"] for m in r["matches"])


# ---------------------------------------------------------------- filler words next to a technology
@pytest.mark.parametrize("text,skill", [
    ("Angular interface", "angular"), ("REST API exposure", "rest api"),
    ("Node.js server", "node.js"), ("PostgreSQL database", "postgresql"),
    ("Salesforce integration", "salesforce"), ("LLM with RAG architecture", "rag"),
])
def test_filler_words_are_generic(text, skill):
    r = parse(text, "technical")
    assert skill in r.skills and r.fully_understood, r


@pytest.mark.parametrize("text,leftover", [
    ("API integration", ["api", "integration"]),
    ("Web development", ["web"]),
    ("Web services integration", ["web", "services", "integration"]),
    ("Service architecture", ["service", "architecture"]),
    ("Integration environment", ["integration", "environment"]),
])
def test_context_words_are_the_need_without_a_technology(text, leftover):
    r = parse(text, "technical")
    assert r.leftover == leftover and not r.fully_understood, r


def test_api_integration_proof_line_names_it():
    req = parse("API integration", "technical")
    lines = ["Institut Preparatoire aux Etudes d'Ingenieur de Sfax (IPEIS) 2019 - 2021",
             "Built the API integration between the ERP and the online shop."]
    assert not names_requirement(req, lines[0]) and names_requirement(req, lines[1])
    for use_reranker in (False, True):
        ev = find_evidence(req, doc(lines), use_reranker)
        assert ev["line"] == 2 and ev["weak"] is False
        assert find_evidence(req, doc(lines[:1]), use_reranker)["weak"] is True


def test_context_words_without_a_technology_keep_their_matches(index):
    r = match_requirement("Web development", "technical")
    assert r["status"] == "covered" and r["matches"][0]["doc_id"] == "CV_02_Liam_Carter.pdf"
    r = match_requirement("API integration", "technical")
    for m in r["matches"]:
        ev = m["evidence"]
        if not ev["weak"]:
            proof = (ev["quote"] or ev.get("statement") or "").lower()
            assert "api" in proof and "integrati" in proof, proof


def test_node_alias_needs_node_js():
    assert "node.js" not in tx.find_skills("Consolidated 20 servers into a 5-node Swarm")
    assert "node.js" not in tx.find_skills("a secure multi-node Apache NiFi cluster")
    assert "node.js" in tx.find_skills("React, Node.js and PostgreSQL") and "node.js" in tx.find_skills("NodeJS")


def test_unknown_names():
    assert tx.unknown_names("iOS Swift mobile developer", ["ios", "swift"]) == ["ios", "swift"]
    assert tx.unknown_names("Apache Airflow orchestration", ["orchestration"]) == []
    assert tx.unknown_names("SAP S/4HANA consultant", ["sap", "s/4hana"]) == ["sap", "s/4hana"]
    assert tx.unknown_names("airflow orchestration", ["orchestration"]) == ["orchestration"]   # case says nothing


def test_reranker_alone_never_makes_a_rule_match_missing(index, monkeypatch):
    monkeypatch.setattr(retriever, "rerank_scores", lambda model, query, passages: [-10.0] * len(passages))
    r = match_requirement("Terraform provisioning", "technical")
    assert r["method"] == "rules+reranker" and r["status"] == "partial"
    assert r["matches"] and all(m["matched_on"] for m in r["matches"])
    assert "terraform" in r["note"] and "provisioning" in r["note"]
    # An unknown technology name ("Kotlin") is not matched by the rules: the reranker decides.
    assert match_requirement("Kotlin Android developer", "team")["status"] == "missing"


# ---------------------------------------------------------------- demo mode: real documents first
def test_real_document_first_when_scores_are_about_the_same():
    store = {"demo": {"origin": "demo"}, "cv": {"origin": "cv_document"}, "cv2": {"origin": "cv_document"}}
    # Run 3, "Power BI": demo tool rrf 0.0320 / similarity 0.8692, CV 0.0318 / 0.8769.
    info = {"demo": {"rrf": 0.0320, "dense": 0.8692}, "cv": {"rrf": 0.0318, "dense": 0.8769}}
    assert retriever._real_first(["demo", "cv"], store, info) == ["cv", "demo"]
    far = {"demo": {"rrf": 0.0328, "dense": 0.8264}, "cv": {"rrf": 0.0290, "dense": 0.8000}}
    assert retriever._real_first(["demo", "cv"], store, far) == ["demo", "cv"]
    # Reranker scores decide when there are some; weaker evidence never moves first.
    assert retriever._real_first(["demo", "cv"], store, far, {"demo": 1.7, "cv": 1.1}) == ["cv", "demo"]
    assert retriever._real_first(["demo", "cv"], store, far, {"demo": 1.7, "cv": 1.1}, {"cv": 2}) == ["demo", "cv"]
    # Only the best real document moves; the others keep their places.
    assert retriever._real_first(["demo", "cv", "cv2"], store, info) == ["cv", "demo", "cv2"]


def test_demo_mode_prefers_a_real_document(index):
    with retrieval_scope(for_mode("demo")):
        if not index_up_to_date():
            build_index()
        out = retrieve({"technical": ["Power BI", "PostgreSQL"]})
    for row in out["requirements_matrix"]:
        assert row["origin"] == "cv_document", row
