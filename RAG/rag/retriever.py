"""Evidence-based requirement matching and constraint satisfaction engine.

Pipeline execution for each requirement:
  1. PARSE     Requirement text -> structured constraints (skills, certs, role, seniority, count, sector)
  2. FILTER    Profile-based filtering against verified organizational capabilities
  3. RANK      Hybrid retrieval (BM25 lexical + dense multilingual vectors with RRF)
  4. DECIDE    Dual-track evaluation (deterministic rule validation or cross-encoder reranking)
  5. EVIDENCE  Line-level attribution and quotation extraction from source documents

Input schema:   {"technical": [...], "team": [...], "experience": [...], "sector": ..., "client": ...}
Output schema:  {"matches", "requirement_matches", "requirements_matrix", "fit_score", "warnings"}
"""
import re
from typing import Any, Dict, List, Optional, Tuple

from . import config
from . import taxonomy as tx
from .hybrid import hybrid_rank
from .index import load_doc_store, rerank_scores
from .reqparse import ParsedRequirement, parse

CATEGORIES = ("technical", "team", "experience")


# ---------------------------------------------------------------- 1-2. filter
def doc_types_for(req: ParsedRequirement):
    if req.category == "experience" and req.sectors:
        return ["past_project"]           # "2+ public sector projects" counts projects
    return config.CATEGORY_TYPES[req.category]


def meets_constraints(req: ParsedRequirement, prof: dict, doc_type: str) -> list[str]:
    """Return the reasons a document meets the requirement, or [] if it does not."""
    reasons = []
    if req.skills:
        have = [s for s in req.skills if s in prof.get("skills", [])]
        if not have or (req.all_skills and len(have) < len(req.skills)):
            return []
        reasons += have
    if req.certs:
        have = [c for c in req.certs if c in prof.get("certifications", [])]
        if len(have) < len(req.certs):
            return []
        reasons += have
    if req.sectors and doc_type != "cv":
        have = [s for s in req.sectors if s in prof.get("sectors", [])]
        if not have:
            return []
        reasons += [f"{s} sector" for s in have]
    if req.category == "team":
        if doc_type != "cv":
            return []
        if req.roles:
            have = [r for r in req.roles if r in prof.get("roles", [])]
            if not have:
                return []
            reasons += have
        if req.seniority and prof.get("seniority") != req.seniority:
            return []
        if req.seniority:
            reasons.append(f"{req.seniority} ({prof.get('years')} years)")
    return reasons


# ---------------------------------------------------------------- 5. evidence
def _terms(req: ParsedRequirement):
    terms = []
    for name in req.skills:
        terms += tx.SKILLS[name]
        for other in tx.implied_by(name):      # "ETL" is proven by a line that says "Talend"
            terms += tx.SKILLS[other]
    for name in req.certs:
        terms += tx.CERTIFICATIONS[name]
    for name in req.sectors:
        terms += tx.SECTORS[name]
    for name in req.roles:
        terms += tx.ROLES[name]
    if req.seniority:
        terms.append(req.seniority)
    return terms


def _hits(terms, line):
    norm = f" {tx.normalize(line)} "
    return sum(bool(re.search(rf"(?<![a-z0-9]){re.escape(t)}(?![a-z0-9])", norm)) for t in terms)


def find_evidence(req: ParsedRequirement, doc: dict, use_reranker: bool):
    """Pick the line of the document that best proves the requirement.

    A line naming a required certification counts 3 times: for "GCP Data Engineer certified"
    the certificate line is better proof than a skills line that says "Google Cloud".
    """
    lines = doc["lines"]
    if not lines:
        return None
    terms = _terms(req)
    cert_terms = [a for name in req.certs for a in tx.CERTIFICATIONS[name]]
    scored = []
    for i, line in enumerate(lines):
        scored.append((_hits(terms, line) + 2 * _hits(cert_terms, line), i))
    scored.sort(key=lambda x: (-x[0], x[1]))
    if scored[0][0] > 0 and not use_reranker:
        i = scored[0][1]
    elif use_reranker and config.RERANKER_MODEL:
        # Let the cross-encoder choose among the most promising lines.
        pool = [i for _, i in scored[:30]]
        scores = rerank_scores(config.RERANKER_MODEL, req.text, [lines[i] for i in pool])
        i = pool[max(range(len(pool)), key=lambda k: scores[k] + 2 * scored[k][0])]
    else:
        i = scored[0][1]
    return {"quote": lines[i][:300], "line": i + 1}


# ---------------------------------------------------------------- reranker input
PASSAGE_CHARS = 1500


def rerank_passage(req: ParsedRequirement, doc: dict) -> str:
    """Text the reranker reads for one document.

    Short documents are read whole. In a long one (a 2-page CV) the skills and
    certifications are often past the first 1500 characters, so we keep the title,
    the summary and the lines that mention the requirement.
    """
    full = " ".join([doc["title"]] + doc["lines"])
    if len(full) <= PASSAGE_CHARS:
        return full
    terms = _terms(req)
    stems = [w[:max(4, len(w) - 2)] for w in req.leftover]
    scored = []
    for i, line in enumerate(doc["lines"]):
        norm = " " + tx.normalize(line) + " "
        hits = _hits(terms, line) + sum(bool(re.search(r"(?<![a-z0-9])" + re.escape(st), norm)) for st in stems)
        if hits:
            scored.append((-hits, i))
    if not scored:
        return full[:PASSAGE_CHARS]
    keep = sorted(i for _, i in sorted(scored)[:12])
    return " ".join([doc["title"], doc["summary"]] + [doc["lines"][i] for i in keep])[:PASSAGE_CHARS]


# ---------------------------------------------------------------- unknown words
def unknown_word_support(words: list[str], doc: dict) -> float:
    """Share of the words unknown to the rules that appear in the document (0 to 1).

    Light stemming: "testing" also matches "tests", "pipelines" matches "pipeline".
    Short words must appear whole ("sense" does not match "sensor", "sap" not "sapient").
    With no unknown words there is nothing specific to check, so the support is 1.
    """
    if not words:
        return 1.0
    text = " " + tx.normalize(" ".join([doc["title"]] + doc["lines"])) + " "
    found = 0
    for w in words:
        if len(w) <= 5:
            base = w[:-1] if w.endswith("s") and len(w) > 3 else w     # "banks" also matches "bank"
            pattern = r"(?<![a-z0-9])" + re.escape(base) + r"(?:s|es)?(?![a-z0-9])"
        else:
            pattern = r"(?<![a-z0-9])" + re.escape(w[:max(4, len(w) - 2)])
        if re.search(pattern, text):
            found += 1
    return found / len(words)


# ---------------------------------------------------------------- 3-4. match one requirement
def _status_from_count(found, needed):
    if found >= needed:
        return "covered"
    return "partial" if found > 0 else "missing"


def _rerank_percent(score):
    low, high = config.RERANK_THRESHOLDS
    span = high - low
    return max(0.0, min(100.0, 100 * (score - (low - span)) / (2 * span)))


def match_requirement(text: str, category: str, model_name: str = config.EMBEDDING_MODEL,
                      top_n: int = config.TOP_N_DOCS, use_rules: bool = True,
                      use_reranker: bool = True, mode: str = "hybrid") -> dict:
    store = load_doc_store()
    req = parse(text, category)
    types = doc_types_for(req)
    ranked = hybrid_rank(model_name, text, types, mode=mode)
    rank_pos = {r["doc_id"]: i for i, r in enumerate(ranked)}
    info = {r["doc_id"]: r for r in ranked}
    use_reranker = use_reranker and bool(config.RERANKER_MODEL)

    qualified = {}
    if use_rules and req.has_constraints:
        for doc_id, d in store.items():
            if d["type"] in types:
                why = meets_constraints(req, d["profile"], d["type"])
                if why:
                    qualified[doc_id] = why
    # Rule-qualified documents first (in hybrid order), then the rest.
    order = sorted(qualified, key=lambda d: rank_pos.get(d, 10**6))
    if not (use_rules and req.fully_understood) and not (use_rules and req.certs):
        # Other words to check: the reranker may also look at documents the rules did
        # not select. Not when a certification is asked: only its holders can count.
        order += [r["doc_id"] for r in ranked if r["doc_id"] not in qualified]

    rerank = {}
    if use_rules and req.fully_understood:
        method = "rules"
        status = _status_from_count(len(qualified), req.min_count)
        percent = 100.0 * min(len(qualified), req.min_count) / req.min_count
        kept = order[:max(top_n, req.min_count)]
        score = float(len(qualified))
    elif use_reranker:
        method = "rules+reranker" if qualified else "reranker"
        cands = order[:max(config.RERANK_CANDIDATES, req.min_count)]
        texts = [rerank_passage(req, store[d]) for d in cands]
        rerank = dict(zip(cands, rerank_scores(config.RERANKER_MODEL, text, texts)))
        high = config.RERANK_THRESHOLDS[1]
        # The words the rules do not know are the specific part of the requirement
        # ("iOS", "Swift"). A document counts when the reranker is confident, or when
        # those words really appear in it and the reranker does not reject it.
        support = {d: unknown_word_support(req.leftover, store[d]) for d in cands}
        good = [d for d in cands if rerank[d] >= high
                or (support[d] >= 0.5 and rerank[d] >= config.RERANK_FLOOR_WITH_TEXT)]
        good.sort(key=lambda d: -rerank[d])
        if good:
            score = rerank[good[0]]
            strong = sum(rerank[d] >= high for d in good)
            status = "covered" if strong >= req.min_count else "partial"
            percent = min(_rerank_percent(score), 100.0 * len(good) / req.min_count)
        else:
            score = max(rerank.values()) if rerank else -99.0
            status, percent = "missing", 0.0
        kept = good[:max(top_n, req.min_count)]
    else:
        method = "similarity"
        kept = order[:top_n]
        best = info[kept[0]].get("dense", 0.0) if kept else 0.0
        low, high = config.thresholds(model_name)
        status = "covered" if best >= high else "partial" if best >= low else "missing"
        percent = max(0.0, min(100.0, 100 * (best - low) / ((high - low) or 1)))
        score = best

    def entry(doc_id, evidence_by_reranker):
        d = store[doc_id]
        return {
            "doc_id": doc_id, "type": d["type"], "title": d["title"],
            "similarity_score": info.get(doc_id, {}).get("dense"),
            "rrf_score": round(info[doc_id]["rrf"], 4) if doc_id in info else None,
            "rerank_score": round(rerank[doc_id], 3) if doc_id in rerank else None,
            "matched_on": qualified.get(doc_id, []),
            "summary": d["summary"],
            "evidence": find_evidence(req, d, evidence_by_reranker),
        }

    matches, closest = [], None
    if status != "missing":
        matches = [entry(doc_id, use_reranker and not qualified.get(doc_id)) for doc_id in kept]
    else:
        # When unfulfilled, provide the closest candidate document for transparency
        # without presenting it as an approved match.
        pool = rerank or {r["doc_id"]: r["rrf"] for r in ranked}
        if pool:
            closest = entry(max(pool, key=pool.get), use_reranker)
    found = len(qualified) if method == "rules" else len(matches)
    return {
        "requirement": text, "category": category, "mandatory": req.mandatory,
        "parsed": req.as_dict(), "method": method, "status": status,
        "found": found, "needed": req.min_count,
        "score": round(score, 3), "percent": round(percent),
        "matches": matches,
        "closest": closest,
        "ranking": order,  # full order, used by the benchmark
    }


# ---------------------------------------------------------------- whole tender
def _clean_list(values):
    if isinstance(values, str):
        values = [values]
    return [v.strip() for v in (values or []) if isinstance(v, str) and v.strip()]


def retrieve(requirements: dict, model_name: str = config.EMBEDDING_MODEL,
             top_n: int = config.TOP_N_DOCS) -> dict:
    warnings, results = [], []
    for category in CATEGORIES:
        items = _clean_list(requirements.get(category))
        if not items:
            warnings.append(f"No '{category}' requirements given; {category}_fit not computed.")
        for text in items:
            results.append(match_requirement(text, category, model_name, top_n))

    # Fit scores. Optional requirements ("preferred") count half.
    def weighted(rows):
        if not rows:
            return None
        w = [1.0 if r["mandatory"] else 0.5 for r in rows]
        return round(sum(r["percent"] * x for r, x in zip(rows, w)) / sum(w))

    fit = {f"{c}_fit": weighted([r for r in results if r["category"] == c]) for c in CATEGORIES}
    fit["certification_fit"] = weighted([r for r in results if r["parsed"].get("certs")])

    fit["domain_fit"] = None
    sector_text = " ".join(_clean_list([requirements.get("sector"), requirements.get("client")]))
    sectors = tx.find_sectors(sector_text)
    if sectors:
        # Use only the sectors we recognise, so the rules can decide.
        sector_query = f"Previous projects in the {' or '.join(sectors)} sector"
        dom = match_requirement(sector_query, "experience", model_name, 3)
        fit["domain_fit"] = dom["percent"]
        results_domain = dom
    else:
        results_domain = None
        if sector_text:
            warnings.append(f"Sector not recognised for domain fit: '{sector_text}'.")
    order = ["technical_fit", "experience_fit", "team_fit", "domain_fit", "certification_fit"]
    fit = {k: fit[k] for k in order}
    parts = [v for v in fit.values() if v is not None]
    fit["overall"] = round(sum(parts) / len(parts)) if parts else None

    missing_mand = [r["requirement"] for r in results if r["status"] == "missing" and r["mandatory"]]
    missing_opt = [r["requirement"] for r in results if r["status"] == "missing" and not r["mandatory"]]
    partial = [f"{r['requirement']} (" + (f"found {r['found']} of {r['needed']}" if r["found"] < r["needed"]
                                            else "weak evidence, check manually") + ")"
               for r in results if r["status"] == "partial"]
    if missing_mand:
        warnings.append("BLOCKING - no internal evidence for mandatory requirement(s): " + "; ".join(missing_mand))
    if missing_opt:
        warnings.append("No internal evidence for optional requirement(s): " + "; ".join(missing_opt))
    if partial:
        warnings.append("Only partly covered: " + "; ".join(partial))
    if not results:
        warnings.append("Tender has no usable requirements; nothing retrieved.")

    # Deduplicate citations and rank by highest evidence confidence.
    docs = {}
    for r in results:
        for m in r["matches"]:
            key = (m["rerank_score"] if m["rerank_score"] is not None else 5.0) + (m["similarity_score"] or 0)
            if m["doc_id"] not in docs or key > docs[m["doc_id"]][0]:
                docs[m["doc_id"]] = (key, m, r["requirement"])
    matches = [{"doc_id": m["doc_id"], "type": m["type"], "title": m["title"],
                "similarity_score": m["similarity_score"], "summary": m["summary"],
                "evidence": m["evidence"], "supports": req_text}
               for _, m, req_text in sorted(docs.values(), key=lambda x: -x[0])]

    return {
        "matches": matches,
        "requirement_matches": [{k: r[k] for k in ("requirement", "category", "method", "matches", "closest")}
                                for r in results],
        "requirements_matrix": [{
            "requirement": r["requirement"], "category": r["category"], "mandatory": r["mandatory"],
            "status": r["status"], "found": r["found"], "needed": r["needed"], "method": r["method"],
            "best_doc": r["matches"][0]["doc_id"] if r["matches"] else None,
            "evidence": r["matches"][0]["evidence"]["quote"] if r["matches"] and r["matches"][0]["evidence"] else None,
            "closest_doc": r["closest"]["doc_id"] if r["closest"] else None,
            "percent": r["percent"],
            "parsed": r["parsed"],
        } for r in results],
        "fit_score": fit,
        "domain_evidence": (results_domain or {}).get("matches", []),
        "benchmark_context": {
            "embedding_model": model_name,
            "retrieval": "hybrid BM25 + dense (RRF)",
            "reranker": config.RERANKER_MODEL or None,
            "structured_rules": True,
            "chunk_size_words": config.CHUNK_SIZE_WORDS,
            "chunk_overlap_words": config.CHUNK_OVERLAP_WORDS,
        },
        "warnings": warnings,
    }
