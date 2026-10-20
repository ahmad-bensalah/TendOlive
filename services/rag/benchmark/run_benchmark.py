"""Benchmark the authoritative PDF CV corpus, then the company-knowledge retrieval set and the real tender
requirements of the n8n live run (benchmark/retrieval_eval.py, benchmark/real_tenders.py), each on its own index.
Obsolete mixed-corpus records have been removed."""
import argparse
import hashlib
import json
import time
from datetime import datetime, timedelta, timezone
from contextlib import contextmanager
from pathlib import Path

from rag import config
from rag.hybrid import clear_cache
from rag.index import build_index, index_up_to_date, load_doc_store
from rag.retriever import match_requirement

from benchmark.retrieval_eval import labels_sha256

HERE = Path(__file__).parent
INDEX_DIR = HERE / ".index"
MAIN = config.EMBEDDING_MODEL
SYSTEMS = {
    "Similarity threshold (baseline)": dict(use_rules=False, use_reranker=False),
    "Reranker only": dict(use_rules=False, use_reranker=True),
    "Rules + reranker (final)": dict(use_rules=True, use_reranker=True),
}

@contextmanager
def knowledge_base():
    old = config.DB_DIR, config.FOLDERS
    config.DB_DIR, config.FOLDERS = INDEX_DIR / "authoritative_cvs", ["authoritative_cvs"]
    clear_cache()
    load_doc_store.cache_clear()
    try:
        yield
    finally:
        config.DB_DIR, config.FOLDERS = old
        clear_cache()
        load_doc_store.cache_clear()

def _allowed(doc_id, keys):
    # "CV_03" accepts CV_03.pdf and CV_03_Daniel_Kim.pdf (files may be renamed).
    return any(doc_id == k or doc_id.startswith((k + "_", k + ".")) for k in keys)


def constraint_tests(model, tests, opts):
    rows = []
    for t in tests:
        r = match_requirement(t["q"], t["category"], model, **opts)
        docs = [m["doc_id"] for m in r["matches"]]
        ok_status = (r["status"] != "missing") if t["expect"] == "found" else (r["status"] == t["expect"])
        wrong_docs = [d for d in docs if "allowed" in t and not _allowed(d, t["allowed"])]
        ok_count = r["found"] >= t.get("min_found", 0)
        rows.append({"q": t["q"], "expect": t["expect"], "got": r["status"], "method": r["method"],
                     "found": r["found"], "wrong_docs": wrong_docs,
                     "pass": ok_status and not wrong_docs and ok_count, "why": t["why"]})
    return rows


def write_report(out, *unused):
    meta = out["meta"]
    lines = ["# Authoritative PDF CV benchmark", "",
             f"Run: {meta['finished_at']} | Corpus: {meta['cv_source']}",
             f"Documents: {meta['documents']} | Checks: {meta['real_cv_tests']}",
             "CV document IDs keep the CV_NN prefix; source filenames are unchanged.", "",
             "This run tests CV matching only. No mock employees, company projects, stacks or clients are indexed.",
             "Old mixed-corpus datasets and results have been deleted.", "",
             "| Method | Passed |", "|---|---|"]
    for name, result in out["real_cvs"].items():
        lines.append(f"| {name} | {result['passed']}/{result['total']} |")
    lines += ["", "## Final system checks", "",
              "| Requirement | Expected | Got | Found | Pass |", "|---|---|---|---|---|"]
    for row in out["real_cvs"]["Rules + reranker (final)"]["rows"]:
        lines.append(f"| {row['q']} | {row['expect']} | {row['got']} | {row['found']} | {'yes' if row['pass'] else 'NO'} |")
    lines += ["", "## Limits", "",
              "These are existing regression checks, not an untouched holdout set.",
              "A passing check validates its status, allowed returned documents where labelled, and minimum count.",
              "It does not establish complete retrieval recall or that each quote proves every constraint.",
              "Known failures are reported without changing labels or tuning retrieval during this cleanup."]
    if out.get("retrieval"):
        from benchmark.retrieval_eval import report_lines
        lines += report_lines(out["retrieval"])
    if out.get("real_tenders"):
        from benchmark.real_tenders import report_lines as real_tender_lines
        lines += real_tender_lines(out["real_tenders"])
    (HERE / "results.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def run(quick=False, rebuild=None, log=print, retrieval=True, real_tenders=True):
    label_file = HERE / "real_cvs.json"
    tests = json.loads(label_file.read_text(encoding="utf-8"))
    out = {"real_cvs": {}}
    with knowledge_base():
        if rebuild or not index_up_to_date(MAIN):
            build_index(MAIN)
        store = load_doc_store()
        sources = sorted(config.CV_DIR.glob("*.pdf"))
        expected_ids = {"CV_" + p.name for p in sources}
        if set(store) != expected_ids or any(d["type"] != "cv" for d in store.values()):
            raise RuntimeError("Benchmark index differs from the authoritative CV corpus")
        for name, opts in SYSTEMS.items():
            log(f"[authoritative CVs] {name}")
            rows = constraint_tests(MAIN, tests, opts)
            out["real_cvs"][name] = {"passed": sum(r["pass"] for r in rows), "total": len(rows),
                                     "rows": rows, "documents": len(store)}
        digest = hashlib.sha256()
        for p in sources:
            digest.update(p.name.encode())
            digest.update(p.read_bytes())
        out["meta"] = {"corpus": "authoritative_cv_only", "cv_source": str(config.CV_DIR.resolve()),
                       "documents": len(store), "corpus_sha256": digest.hexdigest(),
                       "labels_sha256": labels_sha256(label_file),
                       "real_cv_tests": len(tests), "embedding_model": MAIN,
                       "reranker": config.RERANKER_MODEL or None,
                       "finished_at": datetime.now(timezone(timedelta(hours=1))).isoformat(timespec="seconds"), "quick": quick}
    previous = json.loads((HERE / "results.json").read_text(encoding="utf-8")) if (HERE / "results.json").exists() else {}
    if retrieval:
        from benchmark.retrieval_eval import run as run_retrieval
        out["retrieval"] = run_retrieval(log=log)
    else:   # keep the previous retrieval section
        out["retrieval"] = previous.get("retrieval")
    if real_tenders:
        from benchmark.real_tenders import run as run_real_tenders
        out["real_tenders"] = run_real_tenders(log=log)
    elif previous.get("real_tenders"):   # keep the previous real-tender section
        out["real_tenders"] = previous["real_tenders"]
    (HERE / "results.json").write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
    write_report(out)
    log("Wrote benchmark/results.md (authoritative CVs only)")
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--quick", action="store_true", help="compatibility flag; all runs use only authoritative CVs")
    ap.add_argument("--rebuild", action="store_true")
    ap.add_argument("--report-only", action="store_true")
    ap.add_argument("--cv-only", action="store_true",
                    help="run only the CV checks (the previous retrieval and real-tender sections are kept)")
    ap.add_argument("--no-real-tenders", action="store_true", help="skip the real tender requirements set")
    args = ap.parse_args()
    if args.report_only:
        write_report(json.loads((HERE / "results.json").read_text(encoding="utf-8")))
    else:
        run(args.quick, args.rebuild, log=lambda msg: print(msg, flush=True), retrieval=not args.cv_only,
            real_tenders=not (args.cv_only or args.no_real_tenders))

if __name__ == "__main__":
    main()
