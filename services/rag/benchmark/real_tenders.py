"""Real tender requirements: the lines the n8n pipeline sent to the RAG in its third live run.

    python -m benchmark.real_tenders                    (adds a "real_tenders" section to results.json / results.md)
    python -m benchmark.real_tenders --recorded FILE    (scores recorded answers, e.g. the n8n "Call RAG" node output;
                                                         prints the report, writes nothing)

Labels: benchmark/real_tenders.json. It holds the requests as n8n sent them and, for each line, the expected
status and the documents that prove it, written from the documents before the run's answers were read.
Each tender goes through retrieve(), the function behind POST /retrieve/tender, in its own data mode, on private
indexes in benchmark/.index/real_tenders/, so the application's indexes and tender inbox are never touched.

Per line
  status       expected vs got (covered / partial / missing); accuracy = exact matches
  over-claim   the answer says more than the documents prove (missing -> partial / covered, partial -> covered)
  under-claim  the answer says less
  right proof  the row's best_doc is a labelled proof (any grade)
  fragment     the quoted proof line is shorter than 4 words or holds none of the line's terms
               (terms match at a word start; terms of 3 letters or less match whole words only)
  demo over real   Demo mode: the best_doc is a fictional record although a CV clearly proves the line (grade 2)
"""
import argparse
import json
import re
from pathlib import Path

from rag import config
from rag import taxonomy as tx
from rag.context import RetrievalContext, retrieval_scope
from rag.hybrid import clear_cache
from rag.index import build_index, index_up_to_date, load_doc_store
from rag.retriever import retrieve

from benchmark.retrieval_eval import grade, labels_sha256

HERE = Path(__file__).parent
LABELS = HERE / "real_tenders.json"
INDEX = HERE / ".index" / "real_tenders"
MODEL = config.EMBEDDING_MODEL
RANK = {"missing": 0, "partial": 1, "covered": 2}
CATEGORIES = ("technical", "team", "experience")


def load_tenders():
    return json.loads(LABELS.read_text(encoding="utf-8"))["tenders"]


def request_body(tender):
    """The body retrieve() receives from POST /retrieve/tender for this tender."""
    body = {c: list(tender["requirements"].get(c) or []) for c in CATEGORIES}
    body.update(timeline=tender["requirements"].get("timeline"), sector=tender.get("sector"), client=tender.get("client"))
    return body


# ---------------------------------------------------------------- checks on one row
def holds_term(quote, terms):
    """True when the quote holds one of the terms ("analy" matches "analysis"; "ai" does not match "aims")."""
    text = " " + tx.normalize(quote) + " "
    for term in terms:
        t = tx.normalize(term)
        end = r"(?![a-z0-9])" if len(t) <= 3 else ""
        if re.search(r"(?<![a-z0-9])" + re.escape(t) + end, text):
            return True
    return False


def is_fragment(quote, terms):
    """A quoted proof line that cannot prove anything: too short, or none of the line's terms."""
    if not quote:
        return False                     # records give a declaration, not a quote
    return len(quote.split()) < 4 or not holds_term(quote, terms)


def score_row(label, mode, row, matches):
    """Compare one requirements_matrix row (None = not returned) with its label."""
    got = (row or {}).get("status") or "missing"
    best = (row or {}).get("best_doc")
    origin = (row or {}).get("origin") or ("demo" if (best or "").startswith("demo_") else "cv_document" if best else None)
    quote = (row or {}).get("evidence")
    claimed = got != "missing"
    real_proof = [k for k, g in label["proof"].items() if k.startswith("CV_") and g == 2]
    listed = [m.get("doc_id") for m in matches or []]
    return {
        "id": label["id"], "data_mode": mode, "category": label["category"], "line": label["line"],
        "expect": label["expect"], "got": got, "ok": got == label["expect"],
        "method": (row or {}).get("method"), "found": (row or {}).get("found"), "needed": (row or {}).get("needed"),
        "best_doc": best, "origin": origin,
        "proof_grade": grade(best, label["proof"]) if best else None,
        "quote": quote[:160] if quote else None,
        "fragment": claimed and is_fragment(quote, label["terms"]),
        "demo_over_real": claimed and mode == "demo" and origin == "demo" and bool(real_proof),
        "real_proof_listed": any(grade(d, {k: 2 for k in real_proof}) for d in listed if d),
        "returned": row is not None, "why": label["why"],
    }


def score_answer(tender, answer):
    """Score one RAG answer (the /retrieve/tender response) against the tender's labels."""
    rows = list((answer or {}).get("requirements_matrix") or [])
    per_req = {(m.get("category"), m.get("requirement")): m.get("matches")
               for m in (answer or {}).get("requirement_matches") or []}
    out = []
    for label in tender["labels"]:
        key = (label["category"], label["line"])
        row = next((r for r in rows if (r.get("category"), r.get("requirement")) == key), None)
        if row is not None:
            rows.remove(row)              # the same line twice in a tender is matched in order
        out.append(score_row(label, tender["data_mode"], row, per_req.get(key)) | {"tender_id": tender["tender_id"]})
    return out


# ---------------------------------------------------------------- summary
def _share(rows):
    ok = sum(r["ok"] for r in rows)
    return {"lines": len(rows), "correct": ok, "accuracy": round(ok / len(rows), 3) if rows else None}


def summarise(per_line):
    claimed = [r for r in per_line if r["got"] != "missing"]
    return {
        **_share(per_line),
        "by_mode": {m: _share([r for r in per_line if r["data_mode"] == m]) for m in ("company", "demo")},
        "by_category": {c: _share([r for r in per_line if r["category"] == c]) for c in CATEGORIES},
        "by_expected": {s: _share([r for r in per_line if r["expect"] == s]) for s in RANK},
        "confusion": {e: {g: sum(r["expect"] == e and r["got"] == g for r in per_line) for g in RANK} for e in RANK},
        "over_claims": [r["id"] for r in per_line if RANK[r["got"]] > RANK[r["expect"]]],
        "under_claims": [r["id"] for r in per_line if RANK[r["got"]] < RANK[r["expect"]]],
        "claimed": len(claimed),
        "right_proof": sum(bool(r["proof_grade"]) for r in claimed),
        "wrong_proof": [r["id"] for r in claimed if not r["proof_grade"]],
        "fragment_proofs": [r["id"] for r in per_line if r["fragment"]],
        "demo_over_real": [r["id"] for r in per_line if r["demo_over_real"]],
        "not_returned": [r["id"] for r in per_line if not r["returned"]],
    }


def _result(per_line, tenders, source):
    return {"labels_sha256": labels_sha256(LABELS), "source": source,
            "tenders": len(tenders), "lines": len(per_line),
            "modes": {m: sum(len(t["labels"]) for t in tenders if t["data_mode"] == m) for m in ("company", "demo")},
            "summary": summarise(per_line), "per_line": per_line}


# ---------------------------------------------------------------- run
def run(log=print):
    tenders = load_tenders()
    per_line = []
    for mode in ("company", "demo"):
        ctx = RetrievalContext(mode, config.DATA_DIR, INDEX / mode, ())
        with retrieval_scope(ctx):
            clear_cache()
            load_doc_store.cache_clear()
            if not index_up_to_date(MODEL):
                log(f"[real tenders] building the {mode} index")
                build_index(MODEL)
            for t in (t for t in tenders if t["data_mode"] == mode):
                per_line += score_answer(t, retrieve(request_body(t)))
                log(f"[real tenders] {t['tender_id']} ({mode}) done")
    clear_cache()
    load_doc_store.cache_clear()
    order = {lab["id"]: i for i, lab in enumerate(lab for t in tenders for lab in t["labels"])}
    per_line.sort(key=lambda r: order[r["id"]])
    return _result(per_line, tenders, "current code (retrieve() on private indexes)")


def recorded_answers(data):
    """Every RAG answer in a JSON file (an n8n node export or a list of answers), by tender_id."""
    found = {}
    stack = [data]
    while stack:
        x = stack.pop()
        if isinstance(x, dict):
            if "requirements_matrix" in x and x.get("tender_id"):
                found[x["tender_id"]] = x
            else:
                stack += list(x.values())
        elif isinstance(x, list):
            stack += x
    return found


def score_recorded(path):
    tenders = load_tenders()
    answers = recorded_answers(json.loads(Path(path).read_text(encoding="utf-8")))
    per_line = [r for t in tenders for r in score_answer(t, answers.get(t["tender_id"]))]
    return _result(per_line, tenders, f"recorded answers: {Path(path).name}")


# ---------------------------------------------------------------- report
def _ids(xs):
    return ", ".join(xs) if xs else "none"


def _cell(share):
    return f"{share['correct']}/{share['lines']}"


def report_lines(r):
    s, ids, cell = r["summary"], _ids, _cell
    lines = ["", "## Real tender requirements (n8n live run 3)", "",
             f"Source: {r['source']}. {r['lines']} requirement lines from {r['tenders']} tenders "
             f"({r['modes']['company']} in Company mode, {r['modes']['demo']} in Demo mode), sent as n8n wrote them. "
             "Expected statuses and proof documents were written from the documents before the run's answers were read "
             f"(labels sha256 {r['labels_sha256'][:12]}).", "",
             "| Lines | Correct status | Company | Demo | Technical | Team | Experience |", "|---|---|---|---|---|---|---|"]
    m, c = s["by_mode"], s["by_category"]
    lines.append(f"| {s['lines']} | **{s['correct']}/{s['lines']} ({s['accuracy']:.0%})** | {cell(m['company'])} | {cell(m['demo'])} "
                 f"| {cell(c['technical'])} | {cell(c['team'])} | {cell(c['experience'])} |")
    lines += ["", "| Expected \\ got | covered | partial | missing |", "|---|---|---|---|"]
    for e, row in s["confusion"].items():
        lines.append(f"| {e} | {row['covered']} | {row['partial']} | {row['missing']} |")
    lines += ["",
              f"- Over-claims (more than the documents prove): {len(s['over_claims'])} ({ids(s['over_claims'])}).",
              f"- Under-claims: {len(s['under_claims'])} ({ids(s['under_claims'])}).",
              f"- Covered or partial rows whose best document is a labelled proof: {s['right_proof']}/{s['claimed']}"
              f" (wrong: {ids(s['wrong_proof'])}).",
              f"- Fragment proofs (quote under 4 words or without the line's terms): {len(s['fragment_proofs'])} ({ids(s['fragment_proofs'])}).",
              f"- Demo over real (Demo mode, fictional best document although a CV proves the line): "
              f"{len(s['demo_over_real'])} ({ids(s['demo_over_real'])})."]
    if s["not_returned"]:
        lines.append(f"- Lines the answer did not return (counted as missing): {ids(s['not_returned'])}.")
    lines += ["", "| Id | Mode | Requirement | Expected | Got | Best document | Note |", "|---|---|---|---|---|---|---|"]
    for row in r["per_line"]:
        notes = [n for n, on in (("fragment", row["fragment"]), ("demo over real", row["demo_over_real"]),
                                 ("not a proof", row["got"] != "missing" and not row["proof_grade"])) if on]
        text = row["line"] if len(row["line"]) <= 60 else row["line"][:57] + "..."
        lines.append(f"| {row['id']} | {row['data_mode']} | {text} | {row['expect']} | "
                     f"{row['got'] if row['ok'] else '**' + row['got'] + '**'} | {row['best_doc'] or ''} | {', '.join(notes)} |")
    lines += ["", "Limits: one labeller, 39 lines from one run; the demo tenders are synthetic. "
              "This set was not used to tune the system before these labels were written."]
    return lines


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--recorded", help="score the RAG answers recorded in this JSON file instead of running the code")
    args = ap.parse_args()
    if args.recorded:
        print("\n".join(report_lines(score_recorded(args.recorded))))
        return
    res = run(log=lambda msg: print(msg, flush=True))
    path = HERE / "results.json"
    out = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    out["real_tenders"] = res
    path.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
    if "meta" in out:
        from benchmark.run_benchmark import write_report
        write_report(out)
    print("\n".join(report_lines(res)))


if __name__ == "__main__":
    main()
