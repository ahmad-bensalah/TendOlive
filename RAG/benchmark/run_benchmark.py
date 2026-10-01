"""RAG retrieval benchmark.

Parts 1-3 run on the mock data (data/cvs, projects, tech_stacks, clients), part 4 on the
sample OliveSoft CVs (data/olivesoft_cvs). Each part has its own index in
benchmark/.index/, so the benchmark never touches the index the dashboard uses, and
adding documents to data/ never changes the numbers of parts 1-3.

  1. Embedding models  - dense search only, 4 models, 40 labeled queries (EN + FR)
  2. Ablation          - add one step at a time: dense -> BM25 -> hybrid -> + structured rules
  3. Decisions         - can the system say covered / partial / missing correctly?
       a. coverage check: 40 things OliveSoft has + 17 it does not have
       b. constraint tests: 19 hard cases (certifications, counts, seniority, AND)
       c. unseen requirements: 20, never used for tuning
  4. Real CVs          - the same decisions on the sample PDF CVs (certifications, roles, counts,
                         seniority, things nobody has)

Metrics:
  Hit@1     first result is correct
  Recall@3  share of correct documents in the top 3 (max 3 needed)
  MRR       1 / rank of the first correct document, averaged
  ms        average time per query

Run:  python -m benchmark.run_benchmark            (all parts, rebuilds the indexes)
      python -m benchmark.run_benchmark --quick    (skip the 4-model comparison, reuse indexes)
Writes benchmark/results.md and benchmark/results.json
"""
import argparse
import json
import time
from contextlib import contextmanager
from pathlib import Path

from rag import config
from rag.hybrid import clear_cache, hybrid_rank
from rag.index import build_index, embed, index_up_to_date, load_doc_store
from rag.loader import EXTENSIONS
from rag.retriever import doc_types_for, match_requirement
from rag.reqparse import parse

HERE = Path(__file__).parent
INDEX_DIR = HERE / ".index"
MOCK_FOLDERS = ["cvs", "projects", "tech_stacks", "clients"]
REAL_FOLDERS = ["olivesoft_cvs"]
MODELS = [
    "sentence-transformers/all-MiniLM-L6-v2",
    "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
    "intfloat/multilingual-e5-small",
    "BAAI/bge-m3",
]
MAIN = config.EMBEDDING_MODEL


def load(name):
    return json.loads((HERE / name).read_text(encoding="utf-8"))


@contextmanager
def knowledge_base(name, folders):
    """Use only these data/ folders, with a separate index in benchmark/.index/<name>."""
    old = config.DB_DIR, config.FOLDERS
    config.DB_DIR, config.FOLDERS = INDEX_DIR / name, list(folders)
    clear_cache()
    load_doc_store.cache_clear()
    try:
        yield
    finally:
        config.DB_DIR, config.FOLDERS = old
        clear_cache()
        load_doc_store.cache_clear()


def ensure_index(model, rebuild):
    if rebuild or not index_up_to_date(model):
        build_index(model)


def has_files(folders):
    return any(p.suffix.lower() in EXTENSIONS and p.stem.upper() != "README"
               for f in folders for p in (config.DATA_DIR / f).glob("*"))


# ------------------------------------------------------------------ ranking metrics
def score_ranking(ranked, relevant):
    rel = set(relevant)
    first = next((i + 1 for i, d in enumerate(ranked) if d in rel), None)
    return {"hit1": int(bool(ranked) and ranked[0] in rel),
            "recall3": len(rel & set(ranked[:3])) / min(3, len(rel)),
            "mrr": 1 / first if first else 0.0}


def run_ranking(queries, fn):
    rows = []
    for q in queries:
        t0 = time.perf_counter()
        ranked = fn(q)
        ms = (time.perf_counter() - t0) * 1000
        rows.append({**score_ranking(ranked, q["relevant"]), "ms": ms, "q": q["q"],
                     "lang": q.get("lang", "en"), "top1": ranked[0] if ranked else None})
    return rows


def avg(rows, key, lang=None):
    rs = [r for r in rows if lang is None or r["lang"] == lang]
    return sum(r[key] for r in rs) / max(1, len(rs))


def ranking_modes(model):
    def by_mode(mode):
        def fn(q):
            types = doc_types_for(parse(q["q"], q["category"]))
            return [r["doc_id"] for r in hybrid_rank(model, q["q"], types, mode=mode)]
        return fn

    def with_rules(q):
        return match_requirement(q["q"], q["category"], model, use_reranker=False)["ranking"]

    return {"Dense vectors only": by_mode("dense"),
            "BM25 keywords only": by_mode("bm25"),
            "Hybrid (BM25 + dense, RRF)": by_mode("hybrid"),
            "Hybrid + structured rules": with_rules}


# ------------------------------------------------------------------ decision metrics
SYSTEMS = {
    "Similarity threshold (baseline)": dict(use_rules=False, use_reranker=False),
    "Reranker only": dict(use_rules=False, use_reranker=True),
    "Rules + reranker (final)": dict(use_rules=True, use_reranker=True),
}


def coverage_check(model, positives, negatives, opts):
    found = sum(match_requirement(q["q"], q["category"], model, **opts)["status"] != "missing" for q in positives)
    rejected = sum(match_requirement(q["q"], q["category"], model, **opts)["status"] == "missing" for q in negatives)
    return {"found": found / len(positives), "rejected": rejected / len(negatives),
            "accuracy": (found + rejected) / (len(positives) + len(negatives))}


def unseen_check(model, items, opts):
    """Requirements written after the system was built and never used to tune it."""
    rows = []
    for t in items:
        r = match_requirement(t["q"], t["category"], model, **opts)
        found = r["status"] != "missing"
        rows.append({"q": t["q"], "have": t["have"], "got": r["status"], "method": r["method"],
                     "pass": found == t["have"]})
    return {"correct": sum(r["pass"] for r in rows), "total": len(rows), "rows": rows}


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


# ------------------------------------------------------------------ report
def pct(x):
    return f"{round(100 * x + 1e-9)}%"


def run(quick: bool = False, rebuild: bool | None = None, log=print) -> dict:
    """Run the benchmark and write results.md / results.json.

    quick   skip the 4-model comparison (keeps the numbers from the last full run)
    rebuild rebuild the benchmark indexes first (default: only for a full run;
            otherwise they are rebuilt only when data/ or the code changed)
    """
    rebuild = (not quick) if rebuild is None else rebuild
    queries, negatives, tests = load("queries.json"), load("negatives.json"), load("constraint_tests.json")
    holdout, real_tests = load("holdout.json"), load("real_cvs.json")
    out = {"models": {}, "ablation": {}, "coverage": {}, "constraints": {}, "holdout": {}, "real_cvs": {}}

    # 1. embedding models (with quick, keep the numbers from the last full run)
    previous = HERE / "results.json"
    if quick and previous.exists():
        out["models"] = json.loads(previous.read_text(encoding="utf-8")).get("models", {})

    with knowledge_base("mock", MOCK_FOLDERS):
        if not quick:
            for model in MODELS:
                log(f"[models] {model}")
                build_index(model)
                embed(model, ["warm up"], "query")
                rows = run_ranking(queries, ranking_modes(model)["Dense vectors only"])
                out["models"][model] = {"hit1": avg(rows, "hit1"), "recall3": avg(rows, "recall3"),
                                        "mrr": avg(rows, "mrr"), "hit1_en": avg(rows, "hit1", "en"),
                                        "hit1_fr": avg(rows, "hit1", "fr"), "ms": avg(rows, "ms")}

        # 2-3. everything else on the chosen model
        log("[index] mock data")
        ensure_index(MAIN, rebuild)
        embed(MAIN, ["warm up"], "query")
        match_requirement("warm up", "technical", MAIN)
        for name, fn in ranking_modes(MAIN).items():
            log(f"[ablation] {name}")
            rows = run_ranking(queries, fn)
            out["ablation"][name] = {"hit1": avg(rows, "hit1"), "recall3": avg(rows, "recall3"),
                                     "mrr": avg(rows, "mrr"), "hit1_fr": avg(rows, "hit1", "fr"),
                                     "ms": avg(rows, "ms"),
                                     "misses": [(r["q"], r["top1"]) for r in rows if not r["hit1"]]}
        for name, opts in SYSTEMS.items():
            log(f"[decisions] {name}")
            out["coverage"][name] = coverage_check(MAIN, queries, negatives, opts)
            rows = constraint_tests(MAIN, tests, opts)
            out["constraints"][name] = {"passed": sum(r["pass"] for r in rows), "total": len(rows), "rows": rows}
            out["holdout"][name] = unseen_check(MAIN, holdout, opts)

    # 4. the sample OliveSoft CVs (PDF)
    if has_files(REAL_FOLDERS):
        with knowledge_base("real", REAL_FOLDERS):
            log("[index] sample OliveSoft CVs")
            ensure_index(MAIN, rebuild)
            docs = len(load_doc_store())
            for name, opts in SYSTEMS.items():
                log(f"[real CVs] {name}")
                rows = constraint_tests(MAIN, real_tests, opts)
                out["real_cvs"][name] = {"passed": sum(r["pass"] for r in rows), "total": len(rows),
                                         "rows": rows, "documents": docs}
    else:
        log("[real CVs] skipped: data/olivesoft_cvs/ is empty")

    out["meta"] = {"queries": len(queries), "negatives": len(negatives), "constraint_tests": len(tests),
                   "holdout": len(holdout), "real_cv_tests": len(real_tests),
                   "embedding_model": MAIN, "reranker": config.RERANKER_MODEL or None,
                   "finished_at": time.strftime("%Y-%m-%d %H:%M:%S"), "quick": quick}
    (HERE / "results.json").write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
    write_report(out, len(queries), len(negatives), len(tests))
    log("Wrote benchmark/results.md")
    return out


def main():
    ap = argparse.ArgumentParser(description="Run the RAG benchmark.")
    ap.add_argument("--quick", action="store_true", help="skip the embedding model comparison")
    ap.add_argument("--rebuild", action="store_true", help="rebuild the benchmark indexes even if up to date")
    ap.add_argument("--report-only", action="store_true", help="rewrite results.md from results.json")
    args = ap.parse_args()
    if args.report_only:
        out = json.loads((HERE / "results.json").read_text(encoding="utf-8"))
        meta = out.get("meta", {})
        write_report(out, meta.get("queries", 40), meta.get("negatives", 17), meta.get("constraint_tests", 19))
        print("Wrote benchmark/results.md")
        return
    run(quick=args.quick, rebuild=True if args.rebuild else None, log=lambda m: print(m, flush=True))


def write_report(out, nq, nneg, ntests):
    real = out.get("real_cvs", {})
    nreal = (out.get("meta") or {}).get("real_cv_tests", 0)
    L = ["# RAG Retrieval Benchmark", "",
         "Knowledge bases: parts 1-3 use the OliveSoft mock data (16 CVs, 11 past projects, 4 tech stacks, "
         "client portfolio); part 4 uses the sample OliveSoft CVs (PDF). Each has its own index.",
         f"Test sets: {nq} labeled queries (English + French), {nneg} requirements OliveSoft does not meet, "
         f"{ntests} hard constraint tests, 20 unseen requirements"
         + (f", {nreal} checks on the real CVs." if nreal else "."), ""]

    L += ["## Summary", ""]
    final = out["constraints"].get("Rules + reranker (final)")
    base = out["constraints"].get("Similarity threshold (baseline)")
    abl = out["ablation"]
    if final and base and abl:
        a0, a1 = abl["Dense vectors only"], abl["Hybrid + structured rules"]
        L += [f"- Ranking (Hit@1 / Recall@3): dense only {pct(a0['hit1'])} / {pct(a0['recall3'])}, "
              f"hybrid + rules {pct(a1['hit1'])} / {pct(a1['recall3'])}.",
              f"- Coverage decisions: accuracy goes from {pct(out['coverage']['Similarity threshold (baseline)']['accuracy'])} "
              f"(similarity threshold) to {pct(out['coverage']['Rules + reranker (final)']['accuracy'])} (final system).",
              f"- Hard constraint tests passed: {base['passed']}/{base['total']} (baseline) -> "
              f"{final['passed']}/{final['total']} (final).", ""]
        ho = out.get("holdout", {})
        if ho.get("Rules + reranker (final)"):
            hf, hb = ho["Rules + reranker (final)"], ho["Similarity threshold (baseline)"]
            L[-1:-1] = [f"- Unseen requirements (never used for tuning): {hb['correct']}/{hb['total']} (baseline) -> "
                        f"{hf['correct']}/{hf['total']} (final)."]
        if real.get("Rules + reranker (final)"):
            rf, rb = real["Rules + reranker (final)"], real["Similarity threshold (baseline)"]
            L[-1:-1] = [f"- Real PDF CVs ({rf.get('documents', '?')} sample OliveSoft CVs): {rb['passed']}/{rb['total']} "
                        f"(baseline) -> {rf['passed']}/{rf['total']} (final)."]

    if out["models"]:
        L += ["## 1. Embedding model (dense search only)", "",
              "| Model | Hit@1 | Recall@3 | MRR | Hit@1 EN | Hit@1 FR | ms/query |", "|---|---|---|---|---|---|---|"]
        for m, s in out["models"].items():
            L.append(f"| {m} | {pct(s['hit1'])} | {pct(s['recall3'])} | {s['mrr']:.2f} | {pct(s['hit1_en'])} | "
                     f"{pct(s['hit1_fr'])} | {s['ms']:.0f} |")
        note = ""
        if MAIN in out["models"] and "BAAI/bge-m3" in out["models"]:
            ratio = out["models"]["BAAI/bge-m3"]["ms"] / max(out["models"][MAIN]["ms"], 1e-9)
            note = f" About {ratio:.0f}x faster than bge-m3 on CPU."
        L += ["", f"Chosen: `{MAIN}` (best Hit@1, strong in English and French).{note}", ""]

    L += [f"## 2. Ablation: adding one step at a time ({MAIN})", "",
          "| Retrieval | Hit@1 | Recall@3 | MRR | Hit@1 FR | ms/query |", "|---|---|---|---|---|---|"]
    for name, s in abl.items():
        L.append(f"| {name} | {pct(s['hit1'])} | {pct(s['recall3'])} | {s['mrr']:.2f} | {pct(s['hit1_fr'])} | {s['ms']:.0f} |")
    L += [""]

    L += ["## 3a. Coverage check: does the system know what OliveSoft has?", "",
          f"{nq} requirements OliveSoft meets should be found; {nneg} it does not meet "
          "(blockchain, COBOL, Salesforce...) should be marked missing.", "",
          "| Decision method | Found | Rejected | Accuracy |", "|---|---|---|---|"]
    for name, c in out["coverage"].items():
        L.append(f"| {name} | {pct(c['found'])} | {pct(c['rejected'])} | {pct(c['accuracy'])} |")
    L += [""]

    L += ["## 3b. Hard constraint tests", "",
          "A test passes only if the status is right, no wrong person or project is proposed, "
          "and the count is met.", "",
          "| Decision method | Passed |", "|---|---|"]
    for name, c in out["constraints"].items():
        L.append(f"| {name} | {c['passed']}/{c['total']} |")
    if final:
        L += ["", "Final system, test by test:", "",
              "| Requirement | Expected | Got | Method | Pass | Why this test matters |", "|---|---|---|---|---|---|"]
        for r in final["rows"]:
            L.append(f"| {r['q']} | {r['expect']} | {r['got']} | {r['method']} | "
                     f"{'yes' if r['pass'] else 'NO'} | {r['why']} |")
    ho = out.get("holdout", {})
    if ho:
        L += ["", "## 3c. Unseen requirements",
              "",
              "Written after the system was built and never used to tune it: 10 things OliveSoft has,",
              "10 it does not have. Correct = found when we have it, missing when we do not.", "",
              "| Decision method | Correct |", "|---|---|"]
        for name, h in ho.items():
            L.append(f"| {name} | {h['correct']}/{h['total']} |")
        fin = ho.get("Rules + reranker (final)")
        if fin:
            bad = [r for r in fin["rows"] if not r["pass"]]
            L += ["", "Final system mistakes: " + ("none" if not bad else "; ".join(
                f"`{r['q']}` ({'we have it' if r['have'] else 'we do not have it'}, got {r['got']})" for r in bad))]
    if real:
        docs = next(iter(real.values())).get("documents", "?")
        L += ["", f"## 4. Real CVs: {docs} sample OliveSoft CVs (PDF)", "",
              "PDF CVs made with LaTeX, with sections (Profile, Professional Experience, Skills, "
              "Certifications and Awards) and no labelled fields. The system must read the job title, "
              "the years of experience and the certifications from the layout.", "",
              "A check passes only if the status is right, no wrong person is proposed, and the count is met. "
              "\"found\" means covered or partial.", "",
              "| Decision method | Passed |", "|---|---|"]
        for name, c in real.items():
            L.append(f"| {name} | {c['passed']}/{c['total']} |")
        fin = real.get("Rules + reranker (final)")
        if fin:
            L += ["", "Final system, check by check:", "",
                  "| Requirement | Expected | Got | Method | Found | Pass | Why this check matters |",
                  "|---|---|---|---|---|---|---|"]
            for r in fin["rows"]:
                L.append(f"| {r['q']} | {r['expect']} | {r['got']} | {r['method']} | {r['found']} | "
                         f"{'yes' if r['pass'] else 'NO'} | {r['why']} |")
    L += ["", "## Misses (first result wrong)", ""]
    for name, s in abl.items():
        L.append(f"**{name}**: {len(s['misses'])}" + ("" if not s["misses"] else ""))
        for q, got in s["misses"]:
            L.append(f"- `{q}` -> `{got}`")
    L += ["", "## Limits", "",
          "- Mock data written by the team; real documents will be noisier.",
          "- The has / has-not set and the hard cases include a few cases added after we saw them fail",
          "  (iOS Swift, SAP, Oracle EBS), so their scores are optimistic. The unseen set (3c) is the honest number.",
          "- The fit score measures coverage (do we have proof?), not quality: a requirement met by rules scores 100.",
          "- The rules depend on the vocabulary in `rag/taxonomy.py`; unknown terms fall back to the reranker.",
          "- Part 4 was written after we added the vocabulary of these CVs (skills, roles, certifications),",
          "  so it shows that the system reads real PDF CVs, not that it handles unseen words.",
          "- Test sets are small; the next step is 100+ queries checked by hand."]
    (HERE / "results.md").write_text("\n".join(L) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
