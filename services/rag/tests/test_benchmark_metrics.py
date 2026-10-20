"""The retrieval metrics give known values on small hand-made rankings, and the label files are consistent.

The real-tender scoring is checked on hand-made answers shaped like the /retrieve/tender response.
"""
import math

from benchmark.real_tenders import (RANK, holds_term, is_fragment, load_tenders, recorded_answers,
                                    report_lines, request_body, score_answer, summarise)
from benchmark.retrieval_eval import grade, labels_sha256, load_queries, ranked_metrics, set_metrics


def test_grade_matches_cv_prefix_and_full_ids():
    rel = {"CV_17": 2, "olivesoft_Project_X": 1}
    assert grade("CV_17_Julian_Hayes.pdf", rel) == 2
    assert grade("CV_1_Other.pdf", rel) == 0
    assert grade("olivesoft_Project_X", rel) == 1 and grade("olivesoft_Project_XY", rel) == 0


def test_ranked_metrics_known_values():
    rel = {"a": 2, "b": 1}
    m = ranked_metrics(["x", "a", "y", "b"], rel)
    assert m["p@3"] == 1 / 3 and m["r@5"] == 1.0 and m["mrr"] == 0.5 and m["hit@1"] == 0.0
    dcg = 3 / math.log2(3) + 1 / math.log2(5)
    idcg = 3 / math.log2(2) + 1 / math.log2(3)
    assert math.isclose(m["ndcg@5"], dcg / idcg)
    perfect = ranked_metrics(["a", "b"], rel)
    assert perfect["ndcg@5"] == 1.0 and perfect["mrr"] == 1.0 and perfect["hit@1"] == 1.0


def test_set_metrics():
    assert set_metrics(["a", "x"], {"a": 2, "b": 1}) == {"set_precision": 0.5, "set_recall": 0.5, "returned": 2}
    assert set_metrics([], {"a": 2})["set_precision"] == 0.0


def test_label_file_is_consistent():
    qs = load_queries()
    ids = [q["id"] for q in qs]
    assert len(ids) == len(set(ids))
    assert all(q["category"] in ("technical", "team", "experience") and q["lang"] in ("en", "fr") for q in qs)
    assert all(set(q["relevant"].values()) <= {1, 2} for q in qs)
    assert sum(not q["relevant"] for q in qs) >= 5          # negatives are present
    assert all(all(k.startswith("CV_") for k in q["relevant"]) for q in qs if q["category"] == "team")


def test_label_fingerprint_ignores_line_endings(tmp_path):
    # Git stores the label files with LF; a Windows checkout has CRLF and must give the same fingerprint.
    lf, crlf = tmp_path / "lf.json", tmp_path / "crlf.json"
    lf.write_bytes(b'{"a": 1,\n "b": 2}\n')
    crlf.write_bytes(b'{"a": 1,\r\n "b": 2}\r\n')
    assert labels_sha256(lf) == labels_sha256(crlf)
    lf.write_bytes(b'{"a": 2,\n "b": 2}\n')
    assert labels_sha256(lf) != labels_sha256(crlf)


# ---------------------------------------------------------------- real tender requirements
def test_fragment_quotes_are_detected():
    # The quote of the live run: a sentence end that does not hold the skill.
    assert is_fragment("users by 35 % within six months.", ["vector", "pinecone"])
    assert is_fragment("30 %.", ["financ"])                                   # too short
    assert not is_fragment("Integrated LangChain and Pinecone vector databases to power semantic search",
                           ["vector", "pinecone"])
    assert not is_fragment(None, ["vector"])                                  # a record declaration, no quote
    assert holds_term("Business and Data Analyst", ["analy"])                 # word-start prefix
    assert not holds_term("Data platforms with clear aims", ["ai"])           # short terms match whole words
    assert holds_term("Data & AI Engineer", ["ai"])
    assert holds_term("Intégré à des données", ["integre"])                   # accents are ignored


TENDER = {"tender_id": "T-TEST", "data_mode": "demo", "sector": "public sector", "client": "Buyer",
          "requirements": {"technical": ["PostgreSQL", "ISO 27001 certification"], "team": ["1 PSM certified Scrum Master"],
                           "experience": ["1 health sector project"], "timeline": None},
          "labels": [
              {"id": "X1", "category": "technical", "line": "PostgreSQL", "expect": "covered",
               "proof": {"demo_Project_A": 2, "CV_07": 2}, "terms": ["postgres"], "why": ""},
              {"id": "X2", "category": "technical", "line": "ISO 27001 certification", "expect": "missing",
               "proof": {}, "terms": ["27001"], "why": ""},
              {"id": "X3", "category": "team", "line": "1 PSM certified Scrum Master", "expect": "partial",
               "proof": {"CV_14": 1}, "terms": ["psm", "csm"], "why": ""},
              {"id": "X4", "category": "experience", "line": "1 health sector project", "expect": "covered",
               "proof": {"demo_Project_H": 2}, "terms": ["health"], "why": ""}]}


def _row(requirement, category, status, best=None, origin=None, quote=None):
    return {"requirement": requirement, "category": category, "status": status, "best_doc": best,
            "origin": origin, "evidence": quote, "method": "rules", "found": 1, "needed": 1}


def test_score_answer_on_a_hand_made_answer():
    answer = {"requirements_matrix": [
        _row("PostgreSQL", "technical", "covered", "demo_Project_A", "demo"),
        _row("ISO 27001 certification", "technical", "partial", "CV_18_Leila_Morgan.pdf", "cv_document", "30 %."),
        _row("1 PSM certified Scrum Master", "team", "covered", "CV_14_Henry_Price.pdf", "cv_document",
             "Certified Scrum Master (CSM) - Scrum Alliance, 2022")],      # the experience line is not returned
        "requirement_matches": [{"requirement": "PostgreSQL", "category": "technical",
                                 "matches": [{"doc_id": "demo_Project_A"}, {"doc_id": "CV_07_Olivia_Morris.pdf"}]}]}
    rows = {r["id"]: r for r in score_answer(TENDER, answer)}
    assert rows["X1"]["ok"] and rows["X1"]["demo_over_real"] and rows["X1"]["real_proof_listed"]
    assert rows["X1"]["proof_grade"] == 2 and not rows["X1"]["fragment"]
    assert not rows["X2"]["ok"] and rows["X2"]["fragment"] and rows["X2"]["proof_grade"] == 0
    assert rows["X3"]["got"] == "covered" and rows["X3"]["proof_grade"] == 1 and not rows["X3"]["demo_over_real"]
    assert rows["X4"]["got"] == "missing" and not rows["X4"]["returned"]
    s = summarise(list(rows.values()))
    assert (s["correct"], s["lines"], s["accuracy"]) == (1, 4, 0.25)
    assert s["over_claims"] == ["X2", "X3"] and s["under_claims"] == ["X4"]
    assert s["claimed"] == 3 and s["right_proof"] == 2 and s["wrong_proof"] == ["X2"]
    assert s["fragment_proofs"] == ["X2"] and s["demo_over_real"] == ["X1"] and s["not_returned"] == ["X4"]
    assert s["confusion"]["covered"] == {"covered": 1, "partial": 0, "missing": 1}
    assert s["by_mode"]["demo"]["lines"] == 4 and s["by_mode"]["company"]["accuracy"] is None


def test_recorded_answers_are_found_in_an_n8n_export():
    answer = {"tender_id": "T-TEST", "requirements_matrix": []}
    export = [{"run": 0, "error": None, "items": [[answer, {"tender_id": "T-OTHER", "warnings": []}]]}]
    assert recorded_answers(export) == {"T-TEST": answer}


def test_request_body_is_the_api_body():
    body = request_body(TENDER)
    assert body["technical"] == ["PostgreSQL", "ISO 27001 certification"]
    assert (body["sector"], body["client"], body["timeline"]) == ("public sector", "Buyer", None)


def test_real_tender_labels_are_consistent():
    tenders = load_tenders()
    labels = [lab for t in tenders for lab in t["labels"]]
    assert len(tenders) == 9 and len(labels) == 39
    assert len({lab["id"] for lab in labels}) == len(labels)
    for t in tenders:
        assert t["data_mode"] in ("company", "demo")
        # One label per requirement line, in the order the RAG answers them.
        lines = [(c, line) for c in ("technical", "team", "experience") for line in t["requirements"][c]]
        assert lines == [(lab["category"], lab["line"]) for lab in t["labels"]]
        for lab in t["labels"]:
            assert lab["expect"] in RANK and lab["terms"] and lab["why"]
            assert set(lab["proof"].values()) <= {1, 2}
            # Demo records count only in Demo mode; company records only in Company mode.
            other = "olivesoft_" if t["data_mode"] == "demo" else "demo_"
            assert not any(k.startswith(other) for k in lab["proof"])
            if lab["expect"] == "covered":
                assert 2 in lab["proof"].values()
            if lab["category"] == "team":
                assert all(k.startswith("CV_") for k in lab["proof"])


def test_real_tender_report_lines():
    rows = score_answer(TENDER, {"requirements_matrix": []})
    result = {"source": "test", "tenders": 1, "lines": 4, "modes": {"company": 0, "demo": 4},
              "labels_sha256": "0" * 64, "summary": summarise(rows), "per_line": rows}
    text = "\n".join(report_lines(result))
    assert "Real tender requirements" in text and "**1/4 (25%)**" in text
    assert "not return" in text and "| X1 | demo | PostgreSQL | covered | **missing** |" in text
