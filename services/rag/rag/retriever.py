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
from dataclasses import replace
from functools import lru_cache
from typing import Any, Dict, List, Optional, Tuple

from .context import current
from . import records
from . import config
from . import taxonomy as tx
from .gaps import knowledge_report
from .hybrid import hybrid_rank
from .index import load_doc_store, rerank_scores
from .reqparse import ParsedRequirement, parse
from .team import build_team

CATEGORIES = ("technical", "team", "experience")


# ---------------------------------------------------------------- 1-2. filter
def doc_types_for(req: ParsedRequirement):
    if req.category == "experience" and (req.sectors or re.search(
            r"\b(projects?|projets?|deliveries|realisations?)\b", tx.normalize(req.text))):
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
        held = prof.get("certifications", [])
        # One certificate of each group: "PSM or CSM and PMP" needs the PMP and the PSM or the CSM.
        if not all(any(c in held for c in group) for group in req.needed_cert_groups):
            return []
        reasons += [c for c in req.certs if c in held]
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
            via = prof.get("role_sources", {})
            reasons += [f"{r} (via {via[r]})" if r in via else r for r in have]
        if req.seniority and prof.get("seniority") != req.seniority:
            return []
        if req.seniority:
            reasons.append(f"{req.seniority} ({prof.get('years')} years)")
    return reasons


def meets_with_equivalent(req: ParsedRequirement, prof: dict, doc_type: str) -> list[str]:
    """Reasons a document would meet the requirement with an equivalent certificate, or [].

    "1 PSM certified Scrum Master": a CSM holder is not a PSM holder, but the buyer may accept
    the CSM. Such a document only partly meets the requirement, with a note saying why.
    """
    held = prof.get("certifications", [])
    asked = {}                    # certificate asked -> equivalent certificate held
    for cert in req.certs:
        alt = None if cert in held else next((c for c in tx.equivalent_certs(cert) if c in held), None)
        if alt:
            asked[cert] = alt
    if not asked:
        return []
    swap = {}                     # equivalent certificate held -> the certificates it stands for
    for cert, alt in asked.items():
        swap.setdefault(alt, []).append(cert)
    certs = list(dict.fromkeys(asked.get(c, c) for c in req.certs))
    groups = [list(dict.fromkeys(asked.get(c, c) for c in group)) for group in req.needed_cert_groups]
    why = meets_constraints(replace(req, certs=certs, cert_groups=groups), prof, doc_type)
    return [f"{r} instead of {' or '.join(swap[r])}: equivalent certification, check it is accepted"
            if r in swap else r for r in why]


# ---------------------------------------------------------------- 5. evidence
def _terms(req: ParsedRequirement):
    terms = []
    for name in req.skills:
        terms += tx.SKILLS[name]
        for other in tx.implied_by(name):      # "ETL" is proven by a line that says "Talend"
            terms += tx.SKILLS[other]
    for name in req.certs:
        terms += tx.cert_aliases(name)         # "PSPO I" proves "Product Owner certified"
    for name in req.sectors:
        terms += tx.SECTORS[name]
    for name in req.roles:
        terms += tx.role_proof_terms(name)   # a PMP line proves "project manager"
    if req.seniority:
        terms.append(req.seniority)
    return terms


def _hits(terms, line):
    norm = f" {tx.normalize(line)} "
    return sum(bool(re.search(rf"(?<![a-z0-9]){re.escape(t)}(?![a-z0-9])", norm)) for t in terms)


def _word_pattern(word: str) -> str:
    """Regex for a word the rules do not know, with light stemming.

    "testing" also matches "tests", "pipelines" matches "pipeline".
    Short words must appear whole ("sense" does not match "sensor", "sap" not "sapient").
    """
    if len(word) <= 5:
        base = word[:-1] if word.endswith("s") and len(word) > 3 else word     # "banks" also matches "bank"
        return r"(?<![a-z0-9])" + re.escape(base) + r"(?:s|es)?(?![a-z0-9])"
    return r"(?<![a-z0-9])" + re.escape(word[:max(4, len(word) - 2)])


@lru_cache(maxsize=512)
def _naming_patterns(text: str, leftover: Tuple[str, ...]):
    """One regex per word the rules do not know, matching it whole.

    A plain word also matches its plural / -ing / -ed forms ("integration": "integrations");
    a word that looks like a name (taxonomy.unknown_names: "Dynamics", "365") only matches as written.
    No prefix stemming: "dynamics" never matches "dynamic".
    """
    names = set(tx.unknown_names(text, list(leftover)))
    out = []
    for w in leftover:
        forms = {w.strip("./-")} if w in names else tx.word_forms(w)
        alts = "|".join(re.escape(f) for f in sorted(forms, key=len, reverse=True) if f) or "(?!)"
        out.append(re.compile(rf"(?<![a-z0-9])(?:{alts})(?![a-z0-9])"))
    return tuple(out)


def names_requirement(req: ParsedRequirement, line: str, terms=None) -> bool:
    """True when the line names the requirement.

    It names it with a known term or alias ("Talend" for "ETL tools", "PMP" for "project manager"),
    or with most of the words the rules do not know, each whole ("vector" for "vector database",
    both words for "statistical studies", see _naming_patterns). A requirement with nothing specific
    to name (only generic words) is named by every line.
    """
    terms = _terms(req) if terms is None else terms
    if not terms and not req.leftover:
        return True
    if terms and _hits(terms, line):
        return True
    if not req.leftover:
        return False
    norm = f" {tx.normalize(line)} "
    found = sum(bool(p.search(norm)) for p in _naming_patterns(req.text, tuple(req.leftover)))
    return found > len(req.leftover) / 2


def proof_lines(doc: dict) -> list[str]:
    """The lines that can prove a requirement: the text lines of a document, the statements of a record."""
    return records.statements(doc["record"]) if doc.get("record") else doc["lines"]


def names_in_document(req: ParsedRequirement, doc: dict) -> bool:
    """True when at least one line of the document names the requirement (see names_requirement)."""
    terms = _terms(req)
    return any(names_requirement(req, line, terms) for line in proof_lines(doc))


WEAK_NOTE = "No line of this document names the requirement: the quote is only the closest line. Check it manually."


def _fragment(line: str) -> bool:
    """A piece of a sentence cut by the PDF line wrap ("users by 35 % within six months.", "30 %.")."""
    words = line.split()
    return len(words) < 4 or line[:1].islower()


def find_evidence(req: ParsedRequirement, doc: dict, use_reranker: bool):
    """Pick the line of the document that best proves the requirement.

    Only a line that names the requirement (a known term or alias, or most of the other words)
    can be the proof. A line naming a required certification counts 3 times: for
    "GCP Data Engineer certified" the certificate line is better proof than a skills line
    that says "Google Cloud". When no line names the requirement, the closest full line is
    quoted and the evidence is marked weak: it proves nothing by itself.
    """
    if doc.get("record"):
        weak = not names_in_document(req, doc)
        evidence = {"kind": "demo_statement" if doc["origin"] == "demo" else "user_statement",
                    "quote": None, "line": None, "statement": "\n".join(records.statements(doc["record"])),
                    "supporting_fields": doc["record"], "weak": weak}
        if weak:
            evidence["note"] = "This record does not name the requirement. Check it manually."
        return evidence
    lines = doc["lines"]
    if not lines:
        return None
    terms = _terms(req)
    cert_terms = [a for name in req.certs for a in tx.cert_aliases(name)]
    scored = []
    for i, line in enumerate(lines):
        scored.append((_hits(terms, line) + 2 * _hits(cert_terms, line), i))
    # Most hits first; with as many hits, a whole line before a fragment of a wrapped sentence.
    scored.sort(key=lambda x: (-x[0], _fragment(lines[x[1]]), x[1]))
    named = [(s, i) for s, i in scored if names_requirement(req, lines[i], terms)]
    # Without a naming line, never quote a sentence fragment.
    pool = named or [(s, i) for s, i in scored if not _fragment(lines[i])] or scored
    if use_reranker and config.RERANKER_MODEL:
        # Let the cross-encoder choose among the most promising lines.
        pool = pool[:30]
        scores = rerank_scores(config.RERANKER_MODEL, req.text, [lines[i] for _, i in pool])
        i = pool[max(range(len(pool)), key=lambda k: scores[k] + 2 * pool[k][0])][1]
    else:
        i = pool[0][1]
    evidence = {"kind": "document_quote", "quote": lines[i][:300], "line": i + 1, "weak": not named}
    if not named:
        evidence["note"] = WEAK_NOTE
    return evidence


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

    Light stemming (see _word_pattern): "testing" also matches "tests".
    With no unknown words there is nothing specific to check, so the support is 1.
    """
    if not words:
        return 1.0
    text = " " + tx.normalize(" ".join([doc["title"]] + doc["lines"])) + " "
    found = sum(bool(re.search(_word_pattern(w), text)) for w in words)
    return found / len(words)


_corpus_cache: Tuple[Optional[dict], frozenset] = (None, frozenset())


def corpus_words(store: dict) -> frozenset:
    """The words the documents of this store write in lowercase (titles, lines, record statements).

    A word they never write in lowercase ("hibernate", "openshift") is a product name, not a plain
    word (see taxonomy.unknown_names). Cached for the store object load_doc_store() returns.
    """
    global _corpus_cache
    cached = _corpus_cache
    if cached[0] is not store:
        texts = (" ".join([doc.get("title") or ""] + list(proof_lines(doc))) for doc in store.values())
        cached = _corpus_cache = (store, frozenset(tx.lowercase_words(texts)))
    return cached[1]


# ---------------------------------------------------------------- real documents first
# A real document (CV or user-entered record) is the best document instead of a demo record that
# scores about the same: reranker scores within REAL_FIRST_RERANK, or, without them, hybrid (RRF)
# scores within REAL_FIRST_RRF (relative) or similarities within REAL_FIRST_SIMILARITY.
REAL_FIRST_RERANK = 1.0
REAL_FIRST_RRF = 0.02
REAL_FIRST_SIMILARITY = 0.01


def _real_first(ids, store, info, rerank=None, evidence_rank=None):
    """The documents in the same order, except that the best real document comes first when a
    demo record is first and scores about the same.

    Demo records are fictional: a CV that proves the requirement as well is the better proof
    ("Power BI": CV similarity 0.8769, demo tool 0.8692, the CV is the best document).
    The other documents keep their places. A document never moves before one with better
    evidence (evidence_rank: lower is better).
    """
    rerank, evidence_rank = rerank or {}, evidence_rank or {}
    if not ids or store[ids[0]].get("origin") != "demo":
        return list(ids)
    top = ids[0]

    def about_same(real):
        if evidence_rank.get(real, 0) > evidence_rank.get(top, 0):
            return False
        if real in rerank and top in rerank:
            return rerank[real] >= rerank[top] - REAL_FIRST_RERANK
        a, b = info.get(real, {}), info.get(top, {})
        return (a.get("rrf", 0.0) >= b.get("rrf", 0.0) * (1 - REAL_FIRST_RRF)
                or (a.get("dense") or 0.0) >= (b.get("dense") or 0.0) - REAL_FIRST_SIMILARITY)

    real = next((d for d in ids if store[d].get("origin") != "demo" and about_same(d)), None)
    return list(ids) if real is None else [real] + [d for d in ids if d != real]


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
    if category == "experience":
        store = {k: d for k, d in store.items() if d["type"] != "past_project" or
                 d.get("profile", {}).get("delivery_status") == "completed"}
    types = doc_types_for(req)
    ranked = [r for r in hybrid_rank(model_name, text, types, mode=mode) if r["doc_id"] in store]
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
    # Holders of an equivalent certificate (CSM for PSM), when the exact one is short.
    equivalent = {}
    if use_rules and req.certs and len(qualified) < req.min_count:
        for doc_id, d in store.items():
            if d["type"] in types and doc_id not in qualified:
                why = meets_with_equivalent(req, d["profile"], d["type"])
                if why:
                    equivalent[doc_id] = why
    by_rank = lambda ids: sorted(ids, key=lambda d: rank_pos.get(d, 10**6))
    # Rule-qualified documents first (in hybrid order, real documents before demo records that
    # score about the same), then the equivalent certificate holders, then the rest.
    order = _real_first(by_rank(qualified), store, info) + by_rank(equivalent)
    named_only = use_rules and req.has_constraints and req.only_context_left
    if not (use_rules and req.fully_understood) and not (use_rules and req.certs) and not named_only:
        # Other words to check: the reranker may also look at documents the rules did
        # not select. Not when a certification is asked: only its holders can count. Nor when
        # the other words only say how a named technology is used ("MuleSoft API integration").
        order += [r["doc_id"] for r in ranked if r["doc_id"] not in qualified]

    rerank, note = {}, None
    if use_rules and req.fully_understood:
        method = "rules"
        # An equivalent certificate is never enough for "covered".
        status = _status_from_count(len(qualified) + len(equivalent), req.min_count)
        if status == "covered" and len(qualified) < req.min_count:
            status = "partial"
        percent = 100.0 * min(len(qualified) + 0.5 * len(equivalent), req.min_count) / req.min_count
        kept = order[:max(top_n, req.min_count)]
        eligible = list(order)
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
        # When the rules matched every named technology or certificate and the other words are
        # plain words ("orchestration", not "iOS" or a lowercase "hibernate": a common word or one
        # the documents write in lowercase), the reranker alone cannot make the requirement
        # missing: the documents the rules accepted still count, as partial.
        rescued = []
        if (not good and (qualified or equivalent)
                and not tx.unknown_names(text, req.leftover, corpus_words(load_doc_store()))):
            rescued = good = [d for d in cands if d in qualified or d in equivalent]
        # A document the rules did not select and that never names the requirement only has
        # a weak line to show (find_evidence): it is listed last and never makes the requirement
        # covered. 0: rules or a naming line, 1: equivalent certificate, 2: weak.
        evidence_rank = {d: 1 if d in equivalent else 0 if d in qualified or names_in_document(req, store[d]) else 2
                         for d in good}
        good.sort(key=lambda d: (evidence_rank[d], -rerank[d]))
        good = _real_first(good, store, info, rerank, evidence_rank)
        if good:
            score = rerank[good[0]]
            strong = sum(rerank[d] >= high and evidence_rank[d] == 0 for d in good)
            status = "covered" if strong >= req.min_count else "partial"
            percent = min(_rerank_percent(score), 100.0 * len(good) / req.min_count)
            if rescued:
                percent = min(50.0, 100.0 * len(good) / req.min_count)
                note = (f"The rules matched {', '.join(qualified.get(good[0]) or equivalent[good[0]])}; "
                        f"the other words ({', '.join(req.leftover)}) are not confirmed. Check them manually.")
            elif evidence_rank[good[0]] == 2:
                percent = min(percent, 50.0)
                note = "The best document does not name the requirement: weak evidence, check it manually."
        else:
            score = max(rerank.values()) if rerank else -99.0
            status, percent = "missing", 0.0
        kept = good[:max(top_n, req.min_count)]
        eligible = list(good)
    else:
        method = "similarity"
        kept = order[:top_n]
        eligible = list(kept)
        best = info[kept[0]].get("dense", 0.0) if kept else 0.0
        low, high = config.thresholds(model_name)
        status = "covered" if best >= high else "partial" if best >= low else "missing"
        percent = max(0.0, min(100.0, 100 * (best - low) / ((high - low) or 1)))
        score = best
    if status != "missing" and any(d in equivalent for d in eligible) and len(qualified) < req.min_count:
        need = ", ".join(" or ".join(group) for group in req.needed_cert_groups)
        note = f"Not enough holders of {need}: an equivalent certification is counted. Check it is accepted."

    def entry(doc_id, evidence_by_reranker):
        d = store[doc_id]
        return {
            "doc_id": doc_id, "type": d["type"], "title": d["title"],
            "origin": d.get("origin", "cv_document"),
            "similarity_score": info.get(doc_id, {}).get("dense"),
            "rrf_score": round(info[doc_id]["rrf"], 4) if doc_id in info else None,
            "rerank_score": round(rerank[doc_id], 3) if doc_id in rerank else None,
            "matched_on": qualified.get(doc_id) or equivalent.get(doc_id, []),
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
    found = len(qualified) + len(equivalent) if method == "rules" else len(matches)
    return {
        "requirement": text, "category": category, "mandatory": req.mandatory,
        "data_mode": current().mode,
        "parsed": req.as_dict(), "method": method, "status": status,
        "found": found, "needed": req.min_count,
        "score": round(score, 3), "percent": round(percent),
        "note": note,
        "matches": matches,
        "closest": closest,
        "ranking": order,  # full order, used by the benchmark
        "eligible": eligible if status != "missing" else [],  # every qualifying document, used by the team builder
        # documents that qualify only with an equivalent certificate, and why (used by the team builder)
        "equivalent": {d: why for d, why in equivalent.items() if d in eligible} if status != "missing" else {},
    }


# ---------------------------------------------------------------- whole tender
def _clean_list(values):
    if isinstance(values, str):
        values = [values]
    return [v.strip() for v in (values or []) if isinstance(v, str) and v.strip()]


def retrieve(requirements: dict, model_name: str = config.EMBEDDING_MODEL,
             top_n: int = config.TOP_N_DOCS) -> dict:
    warnings, results = [], []
    if current().mode == "demo":
        warnings.append("DEMO - Fictional records are included. These are not company references.")
    elif records.visible_records("company"):
        warnings.append("User-entered declarations may contribute to coverage. They are not verified document evidence.")
    for category in CATEGORIES:
        items = _clean_list(requirements.get(category))
        if not items:
            warnings.append(f"No {category} requirements supplied; this category is excluded from coverage.")
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
                                            else r.get("note") or "weak evidence, check manually") + ")"
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
                "evidence": m["evidence"], "supports": req_text, "origin": m.get("origin", "cv_document")}
               for _, m, req_text in sorted(docs.values(), key=lambda x: -x[0])]

    store = load_doc_store()
    report = knowledge_report(results, store, sectors, fit["domain_fit"])
    return {
        "data_mode": current().mode,
        "coverage_basis": "Recorded capabilities; declarations are not verified document evidence.",
        "matches": matches,
        "requirement_matches": [{k: r[k] for k in ("requirement", "category", "method", "matches", "closest", "data_mode")}
                                for r in results],
        "requirements_matrix": [{
            "requirement": r["requirement"], "category": r["category"], "mandatory": r["mandatory"],
            "status": r["status"], "found": r["found"], "needed": r["needed"], "method": r["method"],
            "best_doc": r["matches"][0]["doc_id"] if r["matches"] else None,
            "evidence": r["matches"][0]["evidence"]["quote"] if r["matches"] and r["matches"][0]["evidence"] else None,
            "closest_doc": r["closest"]["doc_id"] if r["closest"] else None,
            "origin": r["matches"][0].get("origin") if r["matches"] else None,
            "statement": r["matches"][0]["evidence"].get("statement") if r["matches"] and r["matches"][0]["evidence"] else None,
            # True when the best document has no line naming the requirement: its quote proves nothing alone.
            "evidence_weak": r["matches"][0]["evidence"].get("weak", False)
            if r["matches"] and r["matches"][0]["evidence"] else None,
            "note": r.get("note"),
            "percent": r["percent"],
            "parsed": r["parsed"],
        } for r in results],
        "fit_score": fit,
        "domain_evidence": (results_domain or {}).get("matches", []),
        # Additions for the proposal stage; the contract fields above are unchanged.
        "team_proposal": build_team(results, store, matches),
        "knowledge_gaps": report["gaps"],
        "knowledge_counts": report["knowledge_counts"],
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
