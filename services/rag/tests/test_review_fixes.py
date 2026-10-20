"""Fixes from the final review of the RAG v2 matching changes.

1. A context word (interface, server, API, web, integration...) is dropped only when it is directly attached
   to a named skill or certificate and ends its phrase ("Angular interface"); elsewhere it stays and the
   reranker decides ("Java web services integration", "Python developer with API integration experience").
2. Certificates are read as groups of alternatives: "(PSM, CSM or equivalent)" and "(PSM, CSM)" accept
   either, "PSM or CSM and PMP" needs the PMP and one of PSM / CSM.
3. The safety net (rules matched, reranker rejected everything) never rescues a product name written in
   lowercase ("hibernate", "openshift", "nomad", "ios"): every other word must be a plain word.
4. A proof line names the requirement with whole words: "dynamics" (a name) never matches "dynamic".
5. Only the dashboard origins may call the API from a browser (CORS).
6. The tender inbox is not committed.
"""
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from rag import retriever
from rag import taxonomy as tx
from rag.api import app
from rag.context import for_mode, retrieval_scope
from rag.index import build_index, index_ready, index_up_to_date, load_doc_store
from rag.reqparse import parse
from rag.retriever import find_evidence, match_requirement, meets_constraints, meets_with_equivalent, names_requirement

PSM, CSM = "Professional Scrum Master (PSM)", "Certified Scrum Master (CSM)"
REPO = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def index():
    if not index_ready():
        build_index()


def in_both_modes(fn):
    """Run fn() in company mode, then in demo mode (building the demo index if needed)."""
    out = [fn()]
    with retrieval_scope(for_mode("demo")):
        if not index_up_to_date():
            build_index()
        out.append(fn())
    return out


def doc(lines):
    return {"title": "Test CV", "summary": "", "lines": list(lines), "origin": "cv_document", "record": {}}


ROLES = ["scrum master", "project manager"]


def profile(*certs):
    """A CV profile with these certificates. It has the roles and the skill ("Scrum" is agile) the
    requirements below also ask for, so only the certificates decide."""
    text = " | ".join(certs)
    return {"certifications": sorted(set(tx.find_certs(text))), "roles": ROLES, "skills": ["agile"]}


# ---------------------------------------------------------------- 1. context words
@pytest.mark.parametrize("text,skill", [
    ("Angular interface", "angular"), ("REST API exposure", "rest api"), ("Node.js server", "node.js"),
    ("Salesforce integration", "salesforce"), ("LLM with RAG architecture", "rag"),
    ("Angular interface and Node.js server", "node.js"), ("Développement d'une interface Angular", "angular"),
    ("Microservices architecture with Kubernetes", "microservices"),
])
def test_context_word_attached_to_a_technology_is_dropped(text, skill):
    r = parse(text, "technical")
    assert skill in r.skills and r.leftover == [] and r.fully_understood, r


@pytest.mark.parametrize("text,kept", [
    # Not attached, or part of a longer name ("web services", "web development"), and no chaining.
    ("Java web services integration", ["services", "integration"]),
    ("Python developer with API integration experience", ["api", "integration"]),
    ("Python web development", ["web"]),
    ("MuleSoft API integration", ["api", "integration"]),
])
def test_context_words_not_attached_stay_the_need(text, kept):
    r = parse(text, "technical")
    assert r.skills and all(w in r.leftover for w in kept) and not r.fully_understood, r


def test_context_words_not_attached_go_through_the_reranker(index):
    for text in ("Java web services integration", "Python developer with API integration experience",
                 "Python web development"):
        r = match_requirement(text, "technical")
        assert r["method"] in ("rules+reranker", "reranker"), (text, r["method"])
        assert r["parsed"]["leftover"], text


def test_context_words_never_make_a_document_without_the_technology_count(index, monkeypatch):
    # The reranker accepts everything: only the documents with the named technology may count.
    monkeypatch.setattr(retriever, "rerank_scores", lambda model, query, passages: [10.0] * len(passages))
    for text in ("Java web services integration", "Python web development", "MuleSoft API integration"):
        req = parse(text, "technical")
        assert req.only_context_left, text
        r = match_requirement(text, "technical")
        assert all(m["matched_on"] for m in r["matches"]), (text, [m["doc_id"] for m in r["matches"]])
    # Other unknown words ("iOS") still let the reranker look beyond the rules.
    assert not parse("iOS mobile development with Swift", "technical").only_context_left


# ---------------------------------------------------------------- 2. certificate groups
@pytest.mark.parametrize("text,groups", [
    ("1 Scrum Master certified (PSM, CSM or equivalent)", [[PSM, CSM]]),
    ("1 Scrum Master (PSM, CSM)", [[PSM, CSM]]),
    ("1 Scrum Master certified PSM or CSM", [[PSM, CSM]]),
    ("1 Scrum Master certified PSM / CSM", [[PSM, CSM]]),
    ("Scrum Master PSM or CSM and PMP project manager", [[PSM, CSM], ["PMP"]]),
    ("Scrum Master PSM and CSM", [[PSM], [CSM]]),                       # "and" joins them: both
    ("PMP and PRINCE2 certified project manager or program manager", [["PMP"], ["PRINCE2"]]),
    ("PMP or PRINCE2 certified project manager", [["PMP", "PRINCE2"]]),
    ("1 project manager certified PMP or PRINCE2 or equivalent", [["PMP", "PRINCE2"]]),
    ("1 project manager certified PMP, PRINCE2 or equivalent", [["PMP", "PRINCE2"]]),
    ("PMP, PRINCE2 or ITIL", [["PMP", "PRINCE2", "ITIL"]]),
    ("PMP, PRINCE2 and ITIL", [["PMP"], ["PRINCE2"], ["ITIL"]]),
    ("PMP, PRINCE2", [["PMP"], ["PRINCE2"]]),
    ("PMP certified project manager; Scrum Master PSM or equivalent", [["PMP"], [PSM]]),
])
def test_certificates_are_read_as_groups_of_alternatives(text, groups):
    r = parse(text, "team")
    assert r.cert_groups == groups and r.any_cert is (len(groups) == 1 and len(groups[0]) > 1), r


def test_parsed_lists_cert_groups_only_when_any_cert_cannot_say_it():
    assert parse("Scrum Master PSM or CSM and PMP project manager", "team").as_dict()["cert_groups"] == [
        [PSM, CSM], ["PMP"]]
    for text in ("PMP or PRINCE2", "PMP and PRINCE2", "1 PSM certified Scrum Master"):
        assert "cert_groups" not in parse(text, "team").as_dict(), text


def test_one_certificate_of_each_group_is_needed():
    csm, pmp, csm_pmp, psm_pmp = (profile("Certified Scrum Master (CSM)"), profile("PMP"),
                                  profile("Certified Scrum Master (CSM)", "PMP"), profile("PSM I", "PMP"))
    for text in ("1 Scrum Master certified (PSM, CSM or equivalent)", "1 Scrum Master (PSM, CSM)"):
        assert CSM in meets_constraints(parse(text, "team"), csm, "cv"), text
    mixed = parse("Scrum Master PSM or CSM and PMP project manager", "team")
    assert meets_constraints(mixed, csm, "cv") == [] and meets_constraints(mixed, pmp, "cv") == []
    assert {CSM, "PMP"} <= set(meets_constraints(mixed, csm_pmp, "cv"))
    assert {PSM, "PMP"} <= set(meets_constraints(mixed, psm_pmp, "cv"))
    both = parse("PMP and PRINCE2 certified project manager or program manager", "team")
    assert meets_constraints(both, pmp, "cv") == []
    assert meets_constraints(parse("PMP or PRINCE2", "team"), pmp, "cv") == ["PMP"]
    # An equivalent certificate still only stands in for the certificate it replaces.
    family_only = {"certifications": ["Scrum Master (PSM/CSM)", "PMP"], "roles": ROLES, "skills": ["agile"]}
    why = meets_with_equivalent(mixed, family_only, "cv")
    assert any("instead of" in w and "equivalent certification" in w for w in why) and "PMP" in why


def test_a_csm_holder_covers_a_psm_or_csm_list(index):
    def run():
        return [match_requirement(t, "team") for t in
                ("1 Scrum Master certified (PSM, CSM or equivalent)", "1 Scrum Master (PSM, CSM)")]
    for rows in in_both_modes(run):
        for r in rows:
            assert r["status"] == "covered" and r["method"] == "rules", r["requirement"]
            assert not r["note"] and "CV_14_Henry_Price.pdf" in [m["doc_id"] for m in r["matches"]]


def test_alternatives_and_needed_certificates_together(index):
    def run():
        return (match_requirement("Scrum Master PSM or CSM and PMP project manager", "team"),
                match_requirement("PMP and PRINCE2 certified project manager or program manager", "team"),
                match_requirement("PMP or PRINCE2 certified project manager", "team"),
                match_requirement("1 project manager certified PMP, PRINCE2 or equivalent", "team"))
    for mixed, both, either, listed in in_both_modes(run):
        assert mixed["parsed"]["cert_groups"] == [[PSM, CSM], ["PMP"]] and mixed["method"] == "rules"
        for m in mixed["matches"]:            # every match holds the PMP and a Scrum Master certificate
            assert "PMP" in m["matched_on"] and any(c in " ".join(m["matched_on"]) for c in (PSM, CSM))
        assert both["status"] == "missing" and both["method"] == "rules"
        assert either["status"] == "covered" and listed["status"] == "covered"


# ---------------------------------------------------------------- 3. safety net
def test_lowercase_product_names_are_names():
    corpus = {"java", "kubernetes", "docker", "orchestration", "wrangling"}
    for text, words in [("Java with hibernate", ["hibernate"]), ("Kubernetes on openshift", ["openshift"]),
                        ("Docker and nomad scheduling", ["nomad", "scheduling"]), ("AWS with ios app", ["ios"])]:
        assert words[0] in tx.unknown_names(text, words, corpus), text
    assert "scheduling" not in tx.unknown_names("Docker and nomad scheduling", ["nomad", "scheduling"], corpus)
    assert tx.unknown_names("Kubernetes cluster orchestration", ["orchestration"], corpus) == []
    assert tx.unknown_names("Python data wrangling", ["wrangling"], corpus) == []        # written so in a document
    assert tx.unknown_names("Terraform provisioning", ["provisioning"], set()) == []     # a common word
    assert tx.unknown_names("Java with Hibernate", ["hibernate"], corpus | {"hibernate"}) == ["hibernate"]


def test_documents_write_no_product_name_in_lowercase(index):
    words = retriever.corpus_words(load_doc_store())
    assert "orchestration" in words or "orchestrated" in words
    assert not {"hibernate", "openshift", "nomad", "ios"} & words


@pytest.mark.parametrize("text", ["Java with hibernate", "Kubernetes on openshift", "Docker and nomad scheduling",
                                  "AWS with ios app", "Java with Hibernate", "Kubernetes on OpenShift",
                                  "AWS with iOS app"])
def test_safety_net_never_rescues_a_product_name(index, monkeypatch, text):
    monkeypatch.setattr(retriever, "rerank_scores", lambda model, query, passages: [-10.0] * len(passages))
    for r in in_both_modes(lambda: match_requirement(text, "technical")):
        assert r["status"] == "missing" and r["note"] is None, (text, r["data_mode"], r["note"])


def test_safety_net_still_rescues_plain_words(index, monkeypatch):
    monkeypatch.setattr(retriever, "rerank_scores", lambda model, query, passages: [-10.0] * len(passages))
    for text in ("Kubernetes cluster orchestration", "Terraform provisioning"):
        r = match_requirement(text, "technical")
        assert r["status"] == "partial" and r["percent"] == 50 and "not confirmed" in r["note"], text


# ---------------------------------------------------------------- 4. whole words in the proof line
def test_dynamics_never_matches_dynamic():
    req = parse("Microsoft Dynamics 365", "technical")
    line = "Developed a dynamic pricing model that improved profit margin by 15 %."
    assert not names_requirement(req, line)
    assert names_requirement(req, "Implemented Microsoft Dynamics 365 Sales for the retail team.")
    ev = find_evidence(req, doc(["Jane Doe", line]), False)
    assert ev["weak"] is True and ev["note"]


def test_plain_words_match_whole_with_suffixes_only():
    req = parse("API integration", "technical")
    assert names_requirement(req, "Built API integrations for the ERP.")
    assert not names_requirement(req, "Integrated the APIs of the ERP.")           # no stem: "integrat"
    req = parse("Kubernetes cluster orchestration", "technical")
    assert req.leftover == ["cluster", "orchestration"]
    assert names_requirement(req, "Managed container clusters and service orchestrations.")
    assert not names_requirement(req, "Orchestrated a clustered setup.")           # "orchestrat" is not a suffix form
    assert tx.word_forms("test") >= {"tests", "testing", "tested"} and "dynamic" not in tx.word_forms("dynamics")
    assert "scheduling" in tx.word_forms("schedule") and "studies" in tx.word_forms("study")


def test_dynamics_quote_is_never_a_strong_dynamic_line(index):
    for r in in_both_modes(lambda: match_requirement("Microsoft Dynamics 365", "technical")):
        for m in r["matches"] + ([r["closest"]] if r["closest"] else []):
            ev = m["evidence"] or {}
            if ev.get("quote") and not ev["weak"]:
                assert "dynamics" in ev["quote"].lower() or "365" in ev["quote"], ev["quote"]


# ---------------------------------------------------------------- 5. CORS
def preflight(client, origin, method="DELETE"):
    return client.options("/api/tenders", headers={"Origin": origin, "Access-Control-Request-Method": method})


def test_only_the_dashboard_may_call_the_api_from_a_browser():
    client = TestClient(app)          # no lifespan: CORS is answered before any route runs
    for origin in ("http://localhost:5173", "http://127.0.0.1:5173"):
        r = preflight(client, origin)
        assert r.status_code == 200 and r.headers["access-control-allow-origin"] == origin
    for origin in ("http://evil.example", "http://localhost:8080", "null"):
        r = preflight(client, origin)
        assert r.status_code == 400 and "access-control-allow-origin" not in r.headers, origin
    r = client.get("/api/tenders", headers={"Origin": "http://evil.example"})
    assert "access-control-allow-origin" not in r.headers
    # n8n calls the API server to server, without an Origin header: nothing changes for it.
    assert client.get("/api/tenders").status_code == 200


# ---------------------------------------------------------------- 6. tender inbox not committed
def test_tender_inbox_is_ignored_by_git():
    lines = {ln.strip() for ln in (REPO / ".gitignore").read_text(encoding="utf-8").splitlines()}
    assert {"RAG/tenders.json", "RAG/tenders.tmp"} <= lines
