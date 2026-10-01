"""Structured document profiling and metadata extraction.

Extracts canonical profiles from unstructured text (CVs, past projects, tech stacks):
- Roles, seniority levels, professional experience duration
- Verified skills, certifications, industry domain tags
- Dual extraction strategy: fast deterministic rule parser with optional LLM augmentation
"""
import json
import logging
import os
import re
from typing import Any, Dict, List, Optional, Tuple

from . import cvparse
from . import taxonomy as tx
from .loader import Document

logger = logging.getLogger(__name__)

PROFILE_FIELDS = ("role", "seniority", "years", "skills", "certifications", "sectors", "year")


def _field(text, *names):
    for name in names:
        m = re.search(rf"^\s*{name}\s*:\s*(.+)$", text, re.I | re.M)
        if m:
            return m.group(1).strip()
    return ""


_NUMBER_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
                 "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "fifteen": 15, "twenty": 20,
                 "deux": 2, "trois": 3, "quatre": 4, "cinq": 5, "sept": 7, "huit": 8, "neuf": 9,
                 "dix": 10, "quinze": 15, "vingt": 20}


def _digits(t):
    """ "over three years" -> "over 3 years" (only before years / ans)."""
    return re.sub(r"\b(" + "|".join(_NUMBER_WORDS) + r")(?=\s*\+?\s*(?:years?|ans)\b)",
                  lambda m: str(_NUMBER_WORDS[m.group(1)]), t)


def _years(text):
    """Years of experience.

    1. written: "Experience: 6 years", "6+ years of experience", "over three years", "6 ans d'experience"
    2. else counted from the job dates in the Experience section (internships not counted)
    """
    t = _digits(tx.normalize(text))
    m = (re.search(r"experiences?\s*:?\s*(\d{1,2})\s*\+?\s*(?:years?|ans)\b", t)
         or re.search(r"\b(\d{1,2})\s*\+?\s*(?:years?|ans)\s+(?:of\s+|d')?(?:\w+\s+)?experience", t))
    if not m:
        # Any "N years": in the Profile paragraph of a real CV, anywhere in a short mock file.
        para = cvparse.profile_paragraph(text)
        scope = _digits(tx.normalize(para)) if para else (t if not cvparse.has_sections(text) else "")
        m = re.search(r"\b(\d{1,2})\s*\+?\s*(?:years?|ans)\b", scope)
    if m:
        return int(m.group(1)), "written"
    years = cvparse.years_from_dates(text)
    return years, ("job dates" if years is not None else None)


def _headline(text):
    """Job title of a free-form CV: the first short line near the top that names a role."""
    top = [ln.strip() for ln in text.splitlines() if ln.strip()][:8]
    for ln in top:
        if len(ln) <= 80 and tx.find_roles(ln):
            return ln
    return top[1] if len(top) > 1 else (top[0] if top else "")


def _seniority(title, years, source="written"):
    t = tx.normalize(title)
    if re.search(r"\b(junior|student|etudiant|intern|stagiaire|apprentice|apprenti|trainee)\b", t) \
            or "junior" in t:
        return "junior"
    if re.search(r"\b(senior|lead|architect|architecte|principal)\b", t):
        return "senior"
    if years is None:
        return "unknown"
    if years >= 5:
        # Years added up from job dates can mix unrelated jobs (6 years as a designer,
        # then 1 as an analyst), so they never make someone "senior" on their own.
        return "senior" if source == "written" else "mid"
    return "mid" if years >= 3 else "junior"


def rule_profile(doc) -> dict:
    text, title = doc.text, doc.title
    head = title.split(" - ", 1)
    is_cv = doc.doc_type == "cv"
    # Real CVs (PDF / Word) have no "Role:" line: use the headline of the Profile
    # section ("Data Engineer with 3+ years...") and the title of the current job.
    headline = cvparse.headline(text) if is_cv else ""
    current_job = cvparse.current_job_title(text) if is_cv else ""
    # Job title: a "Role:" line, else the part after " - " in the title, else the CV itself.
    role_text = (_field(text, "Role", "Poste", "Position", "Job title")
                 or (head[1] if len(head) > 1 else (current_job or headline or _headline(text))))
    all_roles = " | ".join(x for x in (role_text, headline, current_job, title) if x)
    # Certifications: a "Certifications:" line, or the lines of a "Certifications" section.
    certs_line = _field(text, "Certifications") or " | ".join(cvparse.section_lines(text, "certifications"))
    # In project files, the "Team:" line lists people; their certifications are
    # not the project's, so that line is ignored for certifications.
    no_team = "\n".join(ln for ln in text.splitlines()
                        if not re.match(r"\s*(team|equipe|équipe)\s*:", ln, re.I))
    p = {
        "name": head[0] if is_cv else None,
        "role": role_text,
        "roles": tx.find_roles(all_roles),
        "skills": tx.expand_skills(tx.find_skills(text)),
        "certifications": sorted(set(tx.find_certs(certs_line or no_team))),
        "sectors": tx.find_sectors(_field(text, "Client") or text),
    }
    if is_cv:
        p["years"], p["years_source"] = _years(text)
        p["seniority"] = _seniority(all_roles, p["years"], p["years_source"])
        # A CV only "has" a certification if it is in the certifications line or section
        # (a CV can mention ISO 27001 projects without the person being certified).
        if certs_line:
            p["certifications"] = sorted(set(tx.find_certs(certs_line)))
        elif cvparse.has_sections(text) or not re.search(r"certifi", tx.normalize(text)):
            p["certifications"] = []
    if doc.doc_type == "past_project":
        m = re.search(r"\b(20\d\d)\b", title + " " + _field(text, "Year", "Annee"))
        p["year"] = int(m.group(1)) if m else None
        p["client"] = _field(text, "Client")
    return p


_LLM_PROMPT = """Extract a JSON profile from this {kind} document.
Return only JSON with keys: role (string), seniority ("junior"|"mid"|"senior"|"unknown"),
years (integer or null), skills (list of short lowercase names), certifications (list),
sectors (list from: public, tourism, health, finance, telecom, education, retail, industry).
Use only facts written in the document.

Document:
{text}"""


def llm_profile(doc) -> dict | None:
    base = os.getenv("RAG_LLM_BASE_URL")
    model = os.getenv("RAG_LLM_MODEL")
    if not (base and model):
        return None
    try:
        import httpx
        r = httpx.post(
            base.rstrip("/") + "/chat/completions",
            headers={"Authorization": f"Bearer {os.getenv('RAG_LLM_API_KEY', 'none')}"},
            json={"model": model, "temperature": 0,
                  "response_format": {"type": "json_object"},
                  "messages": [{"role": "user", "content": _LLM_PROMPT.format(
                      kind=doc.doc_type, text=doc.text[:6000])}]},
            timeout=60)
        r.raise_for_status()
        content = r.json()["choices"][0]["message"]["content"]
        data = json.loads(content[content.find("{"): content.rfind("}") + 1])
        return data if isinstance(data, dict) else None
    except Exception as e:  # never break indexing because of the LLM
        print(f"[profiles] LLM extraction failed for {doc.doc_id}: {e}")
        return None


def build_profile(doc) -> dict:
    p = rule_profile(doc)
    extra = llm_profile(doc)
    if extra:
        # Map the LLM's free-text names back to our vocabulary, then merge.
        p["skills"] = sorted(set(p["skills"]) | set(tx.find_skills(" , ".join(map(str, extra.get("skills") or [])))))
        p["certifications"] = sorted(set(p["certifications"]) |
                                     set(tx.find_certs(" , ".join(map(str, extra.get("certifications") or [])))))
        p["sectors"] = sorted(set(p["sectors"]) | {s for s in extra.get("sectors") or [] if s in tx.SECTORS})
        if p.get("seniority") in (None, "unknown") and extra.get("seniority"):
            p["seniority"] = extra["seniority"]
        if p.get("years") is None and isinstance(extra.get("years"), int):
            p["years"], p["years_source"] = extra["years"], "llm"
        p["extractor"] = "rules+llm"
    else:
        p["extractor"] = "rules"
    return p
