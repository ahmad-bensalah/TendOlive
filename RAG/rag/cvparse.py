"""Read free-form CVs (PDF / Word exports): sections, name, job title, years.

Real CVs have no "Role:" or "Certifications:" lines. They have sections:

    Lucas Reed
    Sfax, Tunisia  email  phone
    Profile
    Data Integration Engineer with 3+ years of experience ...
    Professional Experience
    Data Engineer   July 2023 – Present
    OliveSoft, Sfax
    ...
    Certifications and Awards
    Professional Integration Developer Certification (Talend)

This module finds those parts. The loader uses it for the title and summary,
the profile extractor for the role, years of experience and certifications.
"""
import re
from datetime import date

from . import taxonomy as tx

# Section headings (English + French). The key is what the rest of the code uses.
SECTION_NAMES = {
    "profile": ["profile", "professional profile", "summary", "professional summary", "about", "about me",
                "profil", "profil professionnel", "resume", "objective", "career objective", "a propos"],
    "experience": ["experience", "experiences", "professional experience", "work experience",
                   "employment", "employment history", "work history", "career history",
                   "experience professionnelle", "experiences professionnelles", "parcours professionnel"],
    "education": ["education", "formation", "formations", "academic background", "etudes", "diplomes",
                  "education and training"],
    "projects": ["projects", "academic projects", "personal projects", "key projects", "projets",
                 "projets academiques", "projets personnels"],
    "skills": ["skills", "technical skills", "core skills", "key skills", "competences",
               "competences techniques", "technologies", "tech stack"],
    "certifications": ["certifications", "certification", "certificates", "certifications and awards",
                       "awards and certifications", "licenses and certifications", "certificats",
                       "certifications et prix", "honors and certifications"],
    "languages": ["languages", "langues"],
    "other": ["associative experience", "volunteering", "volunteer experience", "activites associatives",
              "vie associative", "interests", "hobbies", "centres d'interet", "awards", "honors",
              "references", "publications", "extracurricular activities", "leadership"],
}


def _key(text: str) -> str:
    t = tx.normalize(text).replace("&", " and ")
    t = re.sub(r"^[\W\d_]+|[\W_]+$", "", t)   # bullets, numbering, trailing colon
    return re.sub(r"\s+", " ", t)


_HEADINGS = {_key(name).replace(" ", ""): key for key, names in SECTION_NAMES.items() for name in names}


def heading(line: str) -> str | None:
    """Section key if this line is a section heading, else None.

    Spaces are ignored, because PDF text can split words ("Professional Exp erience").
    """
    return _HEADINGS.get(_key(line).replace(" ", "")) if len(line) <= 60 else None


def sections(text: str) -> list[tuple[str, list[str]]]:
    """[(key, lines)] in order. Lines before the first heading have the key "top"."""
    out = [("top", [])]
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        key = heading(line)
        if key:
            out.append((key, []))
        else:
            out[-1][1].append(line)
    return out


def section_lines(text: str, key: str) -> list[str]:
    return [ln for k, lines in sections(text) if k == key for ln in lines]


def has_sections(text: str) -> bool:
    return len(sections(text)) > 1


# ---------------------------------------------------------------- name, profile, headline
_NOT_A_NAME = {"curriculum", "vitae", "resume", "cv", "profile", "profil", "contact", "page"}
_PARTICLES = {"de", "da", "di", "du", "del", "der", "van", "von", "la", "le", "ben", "bin", "el", "al"}


def _glue_name(line: str) -> str:
    """ "A va Thompson" -> "Ava Thompson": a PDF can split a big name with spaces."""
    out = []
    for w in line.split():
        if out and w[:1].islower() and w.lower() not in _PARTICLES:
            out[-1] += w
        else:
            out.append(w)
    return " ".join(out)


def person_name(text: str) -> str | None:
    """The person's name: a short line of 2-4 capitalised words at the top."""
    for line in section_lines(text, "top")[:3]:
        line = _glue_name(line)
        words = line.split()
        if (2 <= len(words) <= 4 and len(line) <= 40
                and all(re.fullmatch(r"[A-ZÀ-Ý][\w'.-]*", w) or w.lower() in _PARTICLES for w in words)
                and not any(c.isdigit() for c in line)
                and not {tx.normalize(w).strip(".") for w in words} & _NOT_A_NAME):
            return line
    return None


def profile_paragraph(text: str) -> str:
    """The text of the Profile / Summary section, as one paragraph."""
    para = " ".join(section_lines(text, "profile"))
    para = re.sub(r"(\w)- (\w)", r"\1\2", para)   # word cut at the end of a PDF line
    return re.sub(r"\s+", " ", para).strip()


_CUT = re.compile(r"\s(?:with|specialized|specialised|specializing|who|passionate|experienced|skilled|"
                  r"focused|having|offering|at|in|from|for|dedicated|avec|specialise|specialisee)\b|[,.;:(]",
                  re.I)


def headline(text: str) -> str:
    """Job title at the start of the profile: "Data Engineer with 3+ years..." -> "Data Engineer"."""
    para = profile_paragraph(text)
    if not para:
        return ""
    para = re.sub(r"^(?:i am|i'm|je suis)\s+(?:an?\s+|une?\s+)?", "", para, flags=re.I)
    m = _CUT.search(para)
    title = (para[:m.start()] if m else para).strip(" -–")
    return title if 0 < len(title.split()) <= 10 else ""


# ---------------------------------------------------------------- experience dates
_MONTHS = {"jan": 1, "feb": 2, "fev": 2, "mar": 3, "apr": 4, "avr": 4, "may": 5, "mai": 5,
           "jun": 6, "juin": 6, "jul": 7, "juil": 7, "aug": 8, "aou": 8, "sep": 9, "oct": 10,
           "nov": 11, "dec": 12}
_RANGE = re.compile(
    r"(?:(?P<m1>[^\W\d_]{3,9})\.?\s*)?(?P<y1>(?:19|20)\d\d)\s*(?:–|—|-|\bto\b|\bà\b|\bau\b)\s*"
    r"(?:(?P<now>present|current|now|today|ongoing|aujourd'hui|actuel|en cours)"
    r"|(?:(?P<m2>[^\W\d_]{3,9})\.?\s*)?(?P<y2>(?:19|20)\d\d))", re.I)
_TRAINEE = re.compile(r"\b(intern|internship|stage|stagiaire|apprentice|apprenti|alternan\w*|student|"
                      r"etudiant|volunteer|benevole|trainee)\b")


def _month(word: str | None) -> int | None:
    if not word:
        return None
    w = tx.normalize(word)
    return _MONTHS.get(w[:4]) or _MONTHS.get(w[:3])


def experience_entries(text: str, today: date | None = None) -> list[dict]:
    """Jobs in the Experience section: title, start and end (as month numbers), trainee or not."""
    today = today or date.today()
    now = today.year * 12 + today.month
    entries, previous = [], ""
    for line in section_lines(text, "experience"):
        m = _RANGE.search(line)
        if not m:
            previous = line
            continue
        m1, m2 = _month(m.group("m1")), _month(m.group("m2"))
        title = line[:m.start() if m1 else m.start("y1")].strip(" |,-–—")
        if not title:                      # dates on their own line: the title is the line before
            title = previous
        start = int(m.group("y1")) * 12 + (m1 or 1)
        end = now if m.group("now") else int(m.group("y2")) * 12 + (m2 or 12)
        if end >= start:
            entries.append({"title": title, "start": start, "end": min(end, now),
                            "current": bool(m.group("now")),
                            "trainee": bool(_TRAINEE.search(tx.normalize(title)))})
        previous = line
    return entries


def current_job_title(text: str) -> str:
    """Title of the current job (first job marked "Present"), else of the first job listed."""
    entries = experience_entries(text)
    current = [e for e in entries if e["current"]] or entries
    return current[0]["title"] if current else ""


def years_from_dates(text: str, today: date | None = None) -> int | None:
    """Years of work from the job dates (internships not counted, overlaps counted once)."""
    entries = experience_entries(text, today)
    if not entries:
        return None
    spans = sorted((e["start"], e["end"] + 1) for e in entries if not e["trainee"])
    months, cur_start, cur_end = 0, None, None
    for s, e in spans:
        if cur_end is None or s > cur_end:
            if cur_end is not None:
                months += cur_end - cur_start
            cur_start, cur_end = s, e
        else:
            cur_end = max(cur_end, e)
    if cur_end is not None:
        months += cur_end - cur_start
    return months // 12


def cv_title(text: str) -> str | None:
    """"Name - Job title" for a CV without a Title: line, or None if no name is found."""
    name = person_name(text)
    if not name:
        return None
    job = current_job_title(text)
    if not tx.find_roles(job):
        job = headline(text) or job
    return f"{name} - {job}" if job else name
