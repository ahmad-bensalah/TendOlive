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

PDF text keeps the line breaks of the page, so a sentence can be cut in two lines
("...increasing monthly active" / "users by 35 % within six months."). The loader
joins them back with join_wrapped_lines() before anything else reads the CV.
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


# ---------------------------------------------------------------- wrapped PDF lines
# A bullet item starts with a bullet sign. clean_pdf_text() removes the LaTeX bullet and
# leaves the space that followed it, so a line starting with a space starts an item too.
_BULLET_SIGNS = "•●▪◦‣∙*" + "".join(map(chr, (0xF0B7, 0xF0A7, 0xF0D8)))   # and Symbol-font bullets
_BULLET = re.compile(r"\s+\S|[" + re.escape(_BULLET_SIGNS) + r"]\s|[-–]\s")
# "Cloud Platforms: AWS, Azure", "Arabic : Native": a skills or languages line, never a tail.
_LABEL = re.compile(r"[^\W\d_][^:.;!?]{0,40}\s?:\s")
# Signs that never start a new item: "%." ends the sentence of the line before.
_TAIL_SIGNS = set("%)]},.;:")
_SENTENCE_END = re.compile(r"[.!?][\"')\]]?$")
# Words often written with a hyphen ("high-impact", "large-scale"): a hyphen after them at
# the end of a line belongs to the compound. After other cuts ("ex-" / "periences") it goes.
_COMPOUND_HEADS = {"high", "low", "large", "small", "full", "well", "self", "cross", "end", "real",
                   "long", "short", "top", "fine", "state", "data", "cloud", "time", "cost", "open",
                   "cutting", "hands", "day", "face", "peer", "front", "back", "multi", "user",
                   "client", "customer", "business", "team"}
# "e.g.", "etc.", "Dr.", an initial ("J.") or "M.Sc." do not end a sentence.
_ABBREVIATION = re.compile(r"(?:\b(?:e\.g|i\.e|etc|vs|incl|approx|cf|al|dr|mr|mrs|ms|st|no|inc|ltd|co|"
                           r"jr|sr|dept|univ|ing)|\b[^\W\d_]|\w\.\w+)\.$", re.I)


def _continues(prev: str, line: str, raw: str, width: int) -> bool:
    """True when a PDF line is the rest of the line before it (the text was wrapped)."""
    if heading(prev) or heading(line) or _BULLET.match(raw):
        return False
    if re.search(r"[^\W\d_]-$", prev) and line[:1].islower():
        return True                       # a word cut at the end of the line
    if line[:1] in _TAIL_SIGNS:
        return True                       # "%."
    if _RANGE.search(line) or _LABEL.match(line):
        return False                      # a job title with its dates, a "Skills: ..." line
    # Otherwise the line before must fill the width of the page without ending its sentence:
    # "...increasing monthly active" / "users by 35 % within six months.",
    # "...saving the project" / "$8,000 in overtime costs.", "...using" / "Talend and Azure".
    wrapped = len(prev) >= 0.7 * width and not _SENTENCE_END.search(prev)
    if line[:1].islower():
        return wrapped
    return wrapped and not _RANGE.search(prev)   # not the line after a job title with its dates


def _glue(text: str, line: str, words: set) -> str:
    """Add a wrapped line to the text before it, mending a word cut with a hyphen."""
    cut = re.search(r"([^\W\d_]+)-$", text)
    if cut and line[:1].islower():
        head = cut.group(1)
        whole = (head + re.match(r"[^\W\d_]*", line).group(0)).lower()
        keep = whole not in words and (head[:1].isupper() or head.lower() in words
                                       or head.lower() in _COMPOUND_HEADS)
        return text[:-1] + ("-" if keep else "") + line
    return text + " " + line


def split_sentences(text: str) -> list[str]:
    """ "Built a Talend job. Cut costs by 20 %." -> two sentences (abbreviations and initials do not cut)."""
    out, start = [], 0
    for m in re.finditer(r"[.!?][\"')\]]?\s+", text):
        following = text[m.end():].lstrip("\"'(")[:1]
        if not following.isupper() or _ABBREVIATION.search(text[:m.start() + 1]):
            continue
        out.append(text[start:m.end()].strip())
        start = m.end()
    out.append(text[start:].strip())
    out = [s for s in out if s]
    # A piece that reads as a section heading ("Leadership.") would open a section: keep the item whole.
    return [text] if any(heading(s) for s in out) and len(out) > 1 else out


def join_wrapped_lines(text: str) -> str:
    """One sentence or bullet item per line, rebuilt from the wrapped lines of a PDF.

    A line continues the one before when the line before fills the page width without
    ending its sentence, ends with a cut word ("ex-" / "periences"), or when the line starts
    with a sign that never starts an item ("%."). Section headings, bullet items, job titles
    with their dates and "Skills: ..." lines always start a new line. Each item is then cut
    into sentences, so a quoted line is a whole sentence.
    """
    raw = [ln.rstrip() for ln in text.splitlines() if ln.strip()]
    if not raw:
        return text
    lengths = sorted(len(ln.strip()) for ln in raw)
    width = lengths[int(0.9 * (len(lengths) - 1))]
    # Words of the document, without the halves of the words cut at a line end.
    words = set(re.findall(r"[^\W\d_]+", re.sub(r"[^\W\d_]+-[ \t]*\n\s*[^\W\d_]+", " ", text).lower()))
    items, prev = [], ""
    for ln in raw:
        line = ln.strip()
        if items and _continues(prev, line, ln, width):
            items[-1] = _glue(items[-1], line, words)
        else:
            items.append(line)
        prev = line
    return "\n".join(s for item in items for s in split_sentences(item))
