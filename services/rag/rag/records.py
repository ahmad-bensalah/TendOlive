"""Typed company declarations, local persistence and indexing validation."""
import hashlib
import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from . import config, taxonomy as tx
from .context import current

FOLDERS = {"past_project": "projects", "tech_stack": "tech_stacks", "client_portfolio": "clients", "tool": "tools"}
TOOL_KINDS = ("licence", "internal_accelerator", "framework", "software")


class RecordInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    type: Literal["past_project", "tech_stack", "client_portfolio", "tool"]
    title: str = Field(default="", max_length=200)
    description: str = Field(default="", max_length=8000)
    client: str = Field(default="", max_length=200)
    sector: str = Field(default="", max_length=100)
    company_role: str = Field(default="", max_length=1000)
    scope: str = Field(default="", max_length=4000)
    technologies: list[str] = Field(default_factory=list, max_length=100)
    delivery_status: Literal["", "completed", "ongoing", "planned"] = ""
    use_cases: str = Field(default="", max_length=4000)
    relationship: str = Field(default="", max_length=2000)
    country: str = Field(default="", max_length=100)
    year: int | None = Field(default=None, ge=1900, le=2100)
    outcomes: str = Field(default="", max_length=4000)
    budget: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    currency: str = Field(default="", max_length=8)
    linked_ids: list[str] = Field(default_factory=list, max_length=100)
    # Engineers who worked on a project: CV document IDs such as "CV_08_Lucas_Reed.pdf".
    team_cv_ids: list[str] = Field(default_factory=list, max_length=50)
    # Tools: what kind of asset it is, and licence facts if any (seats, expiry).
    tool_kind: Literal["", "licence", "internal_accelerator", "framework", "software"] = ""
    licence_details: str = Field(default="", max_length=1000)
    # Where the information comes from, for example a CV and its experience entry.
    source: str = Field(default="", max_length=1000)


REQUIRED = {
    "past_project": ["title", "description", "client", "company_role", "scope", "technologies", "delivery_status"],
    "tech_stack": ["title", "description", "technologies", "use_cases"],
    "client_portfolio": ["title", "description", "sector", "relationship"],
    "tool": ["title", "description", "tool_kind", "technologies", "use_cases"],
}


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def all_records(data_dir=None):
    root = Path(data_dir or current().data_dir)
    out = []
    for kind, folder in FOLDERS.items():
        for path in sorted((root / folder).glob("*.json")):
            record = json.loads(path.read_text(encoding="utf-8"))
            if record.get("type") != kind or record.get("origin") not in ("demo", "user_entered"):
                raise ValueError(f"Invalid record: {path.name}")
            if record.get("schema_version") != 1 or record.get("status") not in ("draft", "indexed"):
                raise ValueError(f"Unsupported record schema or lifecycle: {path.name}")
            if record.get("id") != path.stem or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", record.get("id", "")):
                raise ValueError(f"Record ID does not match its file: {path.name}")
            RecordInput.model_validate({k: record[k] for k in RecordInput.model_fields if k in record})
            out.append(record)
    ids = [r["id"] for r in out]
    if len(set(ids)) != len(ids):
        raise ValueError("Duplicate stable record IDs")
    return out


def visible_records(mode=None, data_dir=None):
    mode = mode or current().mode
    origin = "demo" if mode == "demo" else "user_entered"
    return [r for r in all_records(data_dir) if r["origin"] == origin]


def identity(record):
    # Repeated records for the same named delivery cannot inflate project counts.
    return (record["type"], tx.normalize(record.get("title", "")),
            tx.normalize(record.get("client", "")) if record["type"] == "past_project" else "")


def validate_record(record, existing=None):
    errors, warnings = {}, []
    for field in REQUIRED[record["type"]]:
        value = record.get(field)
        if not value or (isinstance(value, list) and not any(str(x).strip() for x in value)):
            errors[field] = "This field is required before indexing."
    for field in ("technologies", "linked_ids", "team_cv_ids"):
        if any(not isinstance(x, str) or not x.strip() or len(x) > 200 for x in record.get(field, [])):
            errors[field] = "Use non-empty values of at most 200 characters."
    if record.get("budget") is not None and not record.get("currency"):
        errors["currency"] = "Specify the currency when entering a budget."
    existing = all_records() if existing is None else existing
    same_origin = [r for r in existing if r["origin"] == record.get("origin", "user_entered") and r["id"] != record.get("id")]
    duplicates = [r["id"] for r in same_origin if record.get("title") and identity(r) == identity(record)]
    if duplicates:
        warnings.append("A record with the same title and client already exists. Edit that record instead.")
        errors["title"] = "Duplicate record: " + ", ".join(duplicates)
    targets = {r["id"] for r in same_origin}
    if any(link not in targets for link in record.get("linked_ids", [])):
        errors["linked_ids"] = "Links must reference other records in the same mode."
    cv_ids = {"CV_" + p.name for p in config.CV_DIR.glob("*.pdf")} if config.CV_DIR.is_dir() else set()
    unknown_cvs = [c for c in record.get("team_cv_ids", []) if c not in cv_ids]
    if unknown_cvs:
        errors["team_cv_ids"] = "Unknown CV: " + ", ".join(unknown_cvs)
    if record.get("team_cv_ids") and record["type"] != "past_project":
        errors["team_cv_ids"] = "Only projects have assigned engineers."
    if record["type"] == "past_project" and not record.get("sector"):
        named = prose_sectors(_prose(record))
        warnings.append(f"No sector: the {', '.join(named)} sector named in the title or description counts "
                        "as sector experience." if named else "No sector: this project will not count as sector experience.")
    if record["type"] == "past_project" and record.get("delivery_status") != "completed":
        warnings.append("This project will not count as previous completed delivery.")
    if record.get("origin") == "demo":
        warnings.append("Fictional sample data; not a company reference.")
    else:
        warnings.append("User-entered information; not verified document evidence.")
    return {"valid": not errors, "errors": errors, "warnings": warnings, "duplicate_ids": duplicates}


def record_path(record, data_dir=None):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", record["id"]):
        raise ValueError("Invalid record ID")
    return Path(data_dir or current().data_dir) / FOLDERS[record["type"]] / (record["id"] + ".json")


def persist(record):
    path = record_path(record)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(path)


def new_record(payload):
    values = payload.model_dump()
    values["technologies"] = list(dict.fromkeys(t.strip() for t in values["technologies"] if t.strip()))
    return {"schema_version": 1, "id": "record_" + uuid.uuid4().hex, **values,
            "origin": "user_entered", "status": "draft", "created_at": now(), "updated_at": now()}


def digest(record):
    return hashlib.sha256(json.dumps(record, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def statements(record):
    labels = {"title": "Name", "description": "Description", "client": "Client", "sector": "Sector",
              "company_role": "Company role", "scope": "Scope", "technologies": "Technologies",
              "delivery_status": "Delivery status", "use_cases": "Use cases", "relationship": "Relationship",
              "country": "Country", "year": "Year", "outcomes": "Outcomes", "budget": "Budget", "currency": "Currency",
              "tool_kind": "Tool kind", "licence_details": "Licence", "source": "Source"}
    out = [f"{label}: {', '.join(record[key]) if isinstance(record[key], list) else record[key]}"
           for key, label in labels.items() if record.get(key) not in (None, "", [])]
    if record.get("team_cv_ids"):
        out.append("Team: " + ", ".join(cv_person(c) for c in record["team_cv_ids"]))
    return out


def cv_person(cv_id):
    """ "CV_08_Lucas_Reed.pdf" -> "Lucas Reed (CV_08)"."""
    m = re.fullmatch(r"CV_(\d+)_(.+)\.pdf", cv_id)
    return f"{m.group(2).replace('_', ' ')} (CV_{m.group(1)})" if m else cv_id


# Projects, stacks and tools describe OliveSoft's own work, so the skills their title or
# description names count. A client record describes the client's business: no skills.
PROSE_SKILL_TYPES = ("past_project", "tech_stack", "tool")


def _written(aliases, text, whole_word=False):
    """True when one of these names is written in the text as a word of its own.

    The end of a hyphenated word does not count: "5-node" is not Node.js, "social-media"
    is not the media sector. With whole_word, the start of one does not count either:
    a "health-monitoring app" is a product, not work in the health sector.
    """
    t = f" {tx.normalize(text)} "
    after = r"(?![a-z0-9])(?!-[a-z0-9])" if whole_word else r"(?![a-z0-9])"
    return any(re.search(rf"(?<![a-z0-9])(?<![a-z0-9]-){re.escape(a)}{after}", t) for a in aliases)


def prose_skills(text):
    """Skills named in a title or description ("RAG Customer Service Chatbot" -> rag, chatbot)."""
    return [s for s in tx.find_skills(text) if _written(tx.SKILLS[s], text)]


def prose_sectors(text):
    """Sectors named in a title or description ("for a telecom operator" -> telecom)."""
    text = re.sub(r"\bsocial[ -]media\b", " ", tx.normalize(text))   # a channel, not the media sector
    return [s for s in tx.find_sectors(text) if _written(tx.SECTORS[s], text, whole_word=True)]


def _prose(record):
    return " | ".join(record.get(key) or "" for key in ("title", "description"))


def profile(record):
    # Skills: the technologies field, plus the skills named in the title or description of a
    # project, stack or tool. Sectors: the sector field; when it is empty, the sectors named in
    # the title or description. Prose and client names never grant certifications or roles.
    explicit = {tx.normalize(t) for t in record.get("technologies", [])}
    skills = set(tx.find_skills(" | ".join(explicit))) | (explicit & set(tx.SKILLS))
    skills_from_text = set(prose_skills(_prose(record))) - skills if record["type"] in PROSE_SKILL_TYPES else set()
    sector = record.get("sector") or ""
    canonical_sectors = {tx.normalize(s.strip()) for s in re.split(r"[/,]", sector)} & set(tx.SECTORS)
    sectors_from_text = [] if sector.strip() else prose_sectors(_prose(record))
    return {"skills": tx.expand_skills(sorted(skills | skills_from_text)),
            "certifications": [], "roles": [],
            "sectors": sorted(set(tx.find_sectors(sector)) | canonical_sectors | set(sectors_from_text)),
            # What the title or description added, so a match can say where a skill comes from.
            "skills_from_text": sorted(skills_from_text), "sectors_from_text": sorted(sectors_from_text),
            "client": record.get("client", ""), "year": record.get("year"),
            "delivery_status": record.get("delivery_status"), "team": record.get("team_cv_ids", []),
            "tool_kind": record.get("tool_kind") or None, "extractor": "structured_record"}
