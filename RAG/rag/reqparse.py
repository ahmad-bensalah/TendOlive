"""Natural language requirement parser and constraint extraction.

Deconstructs free-text RFP requirements into structured technical constraints:
- Roles, seniority levels, headcounts
- Required and implied skill sets with boolean AND/OR evaluation
- Target professional certifications
- Target client industry sectors and mandatory/preferred flags
"""
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from . import taxonomy as tx


@dataclass
class ParsedRequirement:
    text: str
    category: str
    skills: List[str] = field(default_factory=list)
    certs: List[str] = field(default_factory=list)
    roles: List[str] = field(default_factory=list)
    sectors: List[str] = field(default_factory=list)
    seniority: Optional[str] = None
    min_count: int = 1
    mandatory: bool = True
    all_skills: bool = False
    leftover: List[str] = field(default_factory=list)

    @property
    def has_constraints(self) -> bool:
        """Indicate whether the requirement contains any identifiable hard constraints."""
        return bool(self.skills or self.certs or self.sectors or
                    (self.category == "team" and self.roles))

    @property
    def fully_understood(self) -> bool:
        """True when the known taxonomy fully covers all salient tokens without unresolved terms."""
        return self.has_constraints and not self.leftover

    def as_dict(self) -> Dict[str, Any]:
        """Serialize parsed constraint parameters into a clean dictionary representation."""
        d = {k: v for k, v in self.__dict__.items() if v not in (None, [], False) and k != "text"}
        d["min_count"] = self.min_count
        return d


def parse(text: str, category: str) -> ParsedRequirement:
    t = tx.normalize(text)
    r = ParsedRequirement(text=text, category=category)
    r.skills = tx.find_skills(text)
    r.certs = tx.find_certs(text)
    r.sectors = tx.find_sectors(text) if category in ("experience", "domain") else []
    # Roles are read without the certification names: "Power BI Data Analyst (PL-300)"
    # asks for a certificate, not for someone whose job title is Data Analyst.
    r.roles = tx.find_roles(tx.strip_aliases(text, tx.CERTIFICATIONS)) if category == "team" else []

    m = re.search(r"(?:minimum|at least|au moins|min\.?)\s*(\d+)|(\d+)\s*\+|^\s*(\d+)\s+\w", t)
    if m:
        r.min_count = int(next(g for g in m.groups() if g))
    if re.search(r"\bsenior", t):
        r.seniority = "senior"
    elif re.search(r"\bjunior", t):
        r.seniority = "junior"
    if re.search(r"\b(preferred|prefer\w*|souhait\w*|nice to have|optional|optionnel\w*|un plus|a plus|bonus)\b", t):
        r.mandatory = False
    if len(r.skills) > 1 and not re.search(r"\b(or|ou)\b", t):
        # "Kubernetes and Terraform" needs both. So does "Tableau dashboards" (no "or", no list):
        # a Power BI dashboard does not prove Tableau.
        if re.search(r"\b(and|et)\b", t) or not tx.has_or(text):
            r.all_skills = True

    r.leftover = tx.leftover_words(text)
    # Filler words that only matter for mandatory/optional or counting.
    r.leftover = [w for w in r.leftover
                  if not re.fullmatch(r"\d+\+?|prefer\w*|souhait\w*|optional|optionnel\w*|bonus", w)]
    return r
