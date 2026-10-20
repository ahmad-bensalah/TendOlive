"""Retrieval benchmark on the Company knowledge base: CVs + company projects, stacks and tools.

    python -m benchmark.retrieval_eval            (adds a "retrieval" section to results.json / results.md)

Labels: benchmark/retrieval_set.json (graded, written before any system was run).
Every system searches the same document types for a requirement (see retriever.doc_types_for), on its own
index in benchmark/.index/company_corpus, so the application's indexes are never touched.

Systems
  BM25 only · Dense E5-small · Dense MiniLM-L6 (model of the team contract) · Hybrid (BM25 + E5, RRF)
  Hybrid + reranker (cross-encoder reorders the top 10) · Final system (rules + reranker, the documents it accepts)

Metrics (positive queries; relevant = grade >= 1, nDCG uses grades 1 and 2)
  P@3, R@5, MRR, nDCG@5, Hit@1 for ranked lists. The final system returns a decision set, so it also gets
  set precision and set recall. Negative queries (no relevant document): false-positive rate of the final system.
"""
import hashlib
import json
import math
import statistics
import time
from pathlib import Path

from rag import config
from rag.context import RetrievalContext, retrieval_scope
from rag.hybrid import clear_cache, hybrid_rank
from rag.index import build_index, index_up_to_date, load_doc_store, rerank_scores
from rag.reqparse import parse
from rag.retriever import doc_types_for, match_requirement, rerank_passage

HERE = Path(__file__).parent
LABELS = HERE / "retrieval_set.json"
INDEX = HERE / ".index" / "company_corpus"
E5 = config.EMBEDDING_MODEL
MINILM = "sentence-transformers/all-MiniLM-L6-v2"
RERANK_TOP = 10


def labels_sha256(path):
    """Fingerprint of a label file. Line endings are ignored: a Windows checkout (CRLF) gives the committed value."""
    return hashlib.sha256(Path(path).read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def load_queries():
    data = json.loads(LABELS.read_text(encoding="utf-8"))
    by_id = {q["id"]: q for q in data["queries"]}
    for q in data["queries"]:
        if "same_as" in q:
            q["relevant"] = by_id[q["same_as"]]["relevant"]
    return data["queries"]


def grade(doc_id, relevant):
    for key, g in relevant.items():
        if doc_id == key or doc_id.startswith(key + "_"):
            return g
    return 0


# ---------------------------------------------------------------- metrics
def ranked_metrics(ranking, relevant):
    grades = [grade(d, relevant) for d in ranking]
    n_rel = len(relevant)
    first = next((i for i, g in enumerate(grades) if g > 0), None)
    dcg = sum((2 ** g - 1) / math.log2(i + 2) for i, g in enumerate(grades[:5]))
    ideal = sorted(relevant.values(), reverse=True)[:5]
    idcg = sum((2 ** g - 1) / math.log2(i + 2) for i, g in enumerate(ideal)) or 1
    return {"p@3": sum(g > 0 for g in grades[:3]) / 3,
            "r@5": sum(g > 0 for g in grades[:5]) / n_rel,
            "mrr": 0.0 if first is None else 1 / (first + 1),
            "ndcg@5": dcg / idcg,
            "hit@1": float(bool(grades[:1] and grades[0] > 0))}


def set_metrics(returned, relevant):
    hits = [d for d in returned if grade(d, relevant) > 0]
    return {"set_precision": len(hits) / len(returned) if returned else 0.0,
            "set_recall": len(hits) / len(relevant), "returned": len(returned)}


# ---------------------------------------------------------------- systems
def system_rankings(q, store):
    req = parse(q["q"], q["category"])
    types = doc_types_for(req)
    out, times = {}, {}

    def timed(name, fn):
        t = time.perf_counter()
        out[name] = fn()
        times[name] = (time.perf_counter() - t) * 1000

    timed("BM25 only", lambda: [r["doc_id"] for r in hybrid_rank(E5, q["q"], types, mode="bm25")])
    timed("Dense E5-small", lambda: [r["doc_id"] for r in hybrid_rank(E5, q["q"], types, mode="dense")])
    timed("Dense MiniLM-L6", lambda: [r["doc_id"] for r in hybrid_rank(MINILM, q["q"], types, mode="dense")])
    timed("Hybrid (BM25 + E5)", lambda: [r["doc_id"] for r in hybrid_rank(E5, q["q"], types, mode="hybrid")])

    def reranked():
        base = [r["doc_id"] for r in hybrid_rank(E5, q["q"], types, mode="hybrid") if r["doc_id"] in store]
        top = base[:RERANK_TOP]
        scores = rerank_scores(config.RERANKER_MODEL, q["q"], [rerank_passage(req, store[d]) for d in top])
        return [d for _, d in sorted(zip(scores, top), key=lambda x: -x[0])] + base[RERANK_TOP:]
    timed("Hybrid + reranker", reranked)

    def final():
        r = match_requirement(q["q"], q["category"])
        return r["eligible"] if r["status"] != "missing" else []
    timed("Final (rules + reranker)", final)
    return out, times


def mean(rows, key):
    vals = [r[key] for r in rows]
    return round(statistics.mean(vals), 3) if vals else None


def summarise(rows, keys):
    return {k: mean(rows, k) for k in keys} | {"queries": len(rows)}


def run(log=print):
    queries = load_queries()
    ctx = RetrievalContext("company", config.DATA_DIR, INDEX, ())
    RANK_KEYS = ["p@3", "r@5", "mrr", "ndcg@5", "hit@1"]
    per_system, per_query, latency = {}, [], {}
    with retrieval_scope(ctx):
        clear_cache()
        load_doc_store.cache_clear()
        for model in (E5, MINILM):
            if not index_up_to_date(model):
                log(f"[retrieval] building company-corpus index for {model}")
                build_index(model)
        store = load_doc_store()
        corpus = {t: sum(1 for d in store.values() if d["type"] == t) for t in sorted({d["type"] for d in store.values()})}
        for q in queries:
            rankings, times = system_rankings(q, store)
            row = {"id": q["id"], "q": q["q"], "lang": q["lang"], "category": q["category"],
                   "negative": not q["relevant"], "relevant": len(q["relevant"]), "systems": {}}
            for name, ranking in rankings.items():
                latency.setdefault(name, []).append(times[name])
                if q["relevant"]:
                    m = ranked_metrics(ranking, q["relevant"])
                    if name.startswith("Final"):
                        m |= set_metrics(ranking, q["relevant"])
                else:
                    m = {"returned": len(ranking)}
                m["top3"] = ranking[:3]
                row["systems"][name] = m
            per_query.append(row)
            log(f"[retrieval] {q['id']} done")
    clear_cache()
    load_doc_store.cache_clear()

    positives = [r for r in per_query if not r["negative"]]
    negatives = [r for r in per_query if r["negative"]]
    for name in latency:
        rows = [r["systems"][name] for r in positives]
        keys = RANK_KEYS + (["set_precision", "set_recall"] if name.startswith("Final") else [])
        s = summarise(rows, keys)
        s["latency_ms_median"] = round(statistics.median(latency[name]), 1)
        s["by_category"] = {c: summarise([r["systems"][name] for r in positives if r["category"] == c], keys)
                            for c in ("technical", "team", "experience")}
        s["by_language"] = {l: summarise([r["systems"][name] for r in positives if r["lang"] == l], keys) for l in ("en", "fr")}
        if name.startswith("Final"):
            fp = [r["id"] for r in negatives if r["systems"][name]["returned"] > 0]
            s["negatives"] = {"total": len(negatives), "false_positives": fp,
                              "false_positive_rate": round(len(fp) / len(negatives), 3) if negatives else None}
        per_system[name] = s
    return {"labels_sha256": labels_sha256(LABELS), "corpus": corpus,
            "french_positives": sum(r["lang"] == "fr" for r in positives),
            "queries": len(queries), "positives": len(positives), "negatives": len(negatives),
            "models": {"dense_main": E5, "dense_contract": MINILM, "reranker": config.RERANKER_MODEL},
            "systems": per_system, "per_query": per_query}


def report_lines(r):
    s = r["systems"]
    lines = ["", "## Retrieval benchmark: company knowledge base", "",
             f"Corpus: {', '.join(f'{n} {t}' for t, n in r['corpus'].items())}. "
             f"Queries: {r['positives']} labelled requirements ({r['french_positives']} in French) and {r['negatives']} negatives.",
             "Labels are graded (2 = clear proof, 1 = passing mention) and were written before running the systems.", "",
             "| System | P@3 | R@5 | MRR | nDCG@5 | Hit@1 | Median latency |", "|---|---|---|---|---|---|---|"]
    for name, m in s.items():
        lines.append(f"| {name} | {m['p@3']:.2f} | {m['r@5']:.2f} | {m['mrr']:.2f} | {m['ndcg@5']:.2f} | {m['hit@1']:.2f} | {m['latency_ms_median']:.0f} ms |")
    f = s["Final (rules + reranker)"]
    lines += ["", f"Final system as a decision: set precision {f['set_precision']:.2f}, set recall {f['set_recall']:.2f}; "
              f"negatives answered with no document: {f['negatives']['total'] - len(f['negatives']['false_positives'])}/{f['negatives']['total']}"
              + (f" (false positives: {', '.join(f['negatives']['false_positives'])})" if f['negatives']['false_positives'] else "") + ".",
              "", "### nDCG@5 by category and language", "",
              "| System | Technical | Team | Experience | English | French |", "|---|---|---|---|---|---|"]
    for name, m in s.items():
        c, l = m["by_category"], m["by_language"]
        lines.append(f"| {name} | {c['technical']['ndcg@5']:.2f} | {c['team']['ndcg@5']:.2f} | {c['experience']['ndcg@5']:.2f} | {l['en']['ndcg@5']:.2f} | {l['fr']['ndcg@5']:.2f} |")
    lines += ["", "Limits: one labeller, 49 queries, labels for a knowledge base partly built from the same CVs. "
              "These are development results, not an untouched holdout."]
    return lines


if __name__ == "__main__":
    import sys
    sys.path.insert(0, str(HERE.parent))
    res = run(log=lambda m: print(m, flush=True))
    out = json.loads((HERE / "results.json").read_text(encoding="utf-8"))
    out["retrieval"] = res
    (HERE / "results.json").write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
    from benchmark.run_benchmark import write_report
    write_report(out)
    print("\n".join(report_lines(res)))
