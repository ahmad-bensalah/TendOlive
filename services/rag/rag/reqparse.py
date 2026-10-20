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
    any_cert: bool = False
    # The certificates needed: one of each group ("PSM or CSM and PMP": [[PSM, CSM], [PMP]]).
    cert_groups: List[List[str]] = field(default_factory=list)
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

    @property
    def only_context_left(self) -> bool:
        """True when every word the rules do not know is a context word ("Java web services integration",
        "MuleSoft API integration"): those words say how the named technology is used, so they never
        make a document without it count. The reranker still checks them on the documents that have it."""
        return bool(self.leftover) and all(w.strip("./-") in tx.CONTEXT_WORDS for w in self.leftover)

    @property
    def needed_cert_groups(self) -> List[List[str]]:
        """cert_groups, or the groups any_cert implies when they were not read (one group, or one per certificate)."""
        if self.cert_groups:
            return self.cert_groups
        return [list(self.certs)] if self.any_cert else [[c] for c in self.certs]

    def as_dict(self) -> Dict[str, Any]:
        """Serialize parsed constraint parameters into a clean dictionary representation.

        cert_groups is listed only when any_cert cannot say it: some certificates are alternatives
        and others are all needed ("PSM or CSM and PMP").
        """
        d = {k: v for k, v in self.__dict__.items() if v not in (None, [], False) and k != "text"}
        if len(self.cert_groups) < 2 or all(len(g) == 1 for g in self.cert_groups):
            d.pop("cert_groups", None)
        d["min_count"] = self.min_count
        return d


def parse(text: str, category: str) -> ParsedRequirement:
    t = tx.normalize(text)
    r = ParsedRequirement(text=text, category=category)
    r.skills = tx.find_skills(text)
    # "PSM certified Scrum Master" asks for the PSM; "certified Scrum Master" for any Scrum Master certificate.
    r.certs = tx.specific_certs(tx.find_certs(text))
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
    if r.certs:
        r.cert_groups = cert_groups(t, r.certs)
        r.any_cert = len(r.cert_groups) == 1 and len(r.certs) > 1

    # A context word attached to a named skill or certificate ("Angular interface", "REST API exposure")
    # adds nothing: the technology is the need. Anywhere else ("API integration", "Python web
    # development", "Java web services integration") it is what is asked, and the reranker decides.
    r.leftover = [w for w, qualifies_a_name in tx.leftover_tokens(text) if not qualifies_a_name]
    # Filler words that only matter for mandatory/optional, counting ("10 or more years")
    # or accepting an equivalent ("PSM or equivalent").
    r.leftover = [w for w in r.leftover
                  if not re.fullmatch(r"\d+\+?|prefer\w*|souhait\w*|optional|optionnel\w*|bonus|more|"
                                      r"equivalent\w*|equivalence", w)]
    return r


# "10 or more years", "PSM or equivalent", "ou plus": not a choice between two certificates.
NOT_A_CHOICE = r"\b(?:or|ou)\s+(?:more|plus|higher|equivalent\w*|similar|similaire\w*|superieur\w*)\b"
AND_JOIN = r"\b(?:and|et)\b|&|\+"
OR_JOIN = r"\b(?:or|ou)\b|/"
# A comma list closed by "or equivalent": "PMP, PRINCE2 or equivalent" accepts either.
OR_EQUIVALENT_AFTER = r"\s*\)?\s*,?\s*" + NOT_A_CHOICE


def cert_groups(t: str, certs: List[str]) -> List[List[str]]:
    """The certificates the tender needs, as groups of alternatives: one of each group (normalized text t).

    Only the words between two certificate names count. Alternatives are joined by "or" or "/"
    ("PMP or PRINCE2", "PSM/CSM", "PMP and/or PRINCE2"), or listed with commas when the list ends with
    "or <certificate>" or "or equivalent" ("PMP, PRINCE2 or equivalent"). Two certificates of the same
    family (taxonomy.CERT_FAMILIES) are alternatives unless "and", "et", "&" or "+" joins them:
    nobody holds both the PSM and the CSM, so "(PSM, CSM)" accepts either. Anything else needs both
    ("PMP and PRINCE2", "PMP, PRINCE2"): "PSM or CSM and PMP" needs the PMP and one of PSM / CSM.
    In "PMP and PRINCE2 certified project manager or program manager" the "or" is between the roles,
    and "10 or more years", "or equivalent" between two names are not a choice.
    """
    t = re.sub(r"\b(?:and|et)\s*/\s*(?:or|ou)\b", " or ", t)
    spans = sorted(((m.start(), m.end(), name) for name in certs for a in tx.CERTIFICATIONS[name]
                    for m in re.finditer(rf"(?<![a-z0-9]){re.escape(a)}(?![a-z0-9])", t)),
                   key=lambda s: (s[0], -s[1]))
    names, joins, last = [], [], None                # joins[k] is the text between names[k] and names[k + 1]
    for start, end, name in spans:
        if last and start < last[1]:
            continue                                  # part of a longer name ("psm" in "psm ii")
        if name in names:
            last = (start, end)                       # the same certificate written twice ("PSM (PSM I)")
            continue
        if last:
            joins.append(t[last[1]:start])
        names.append(name)
        last = (start, end)
    kinds = []
    for k, join in enumerate(joins):
        words = re.sub(NOT_A_CHOICE, " ", join)
        if re.search(AND_JOIN, words):
            kinds.append("and")
        elif re.search(OR_JOIN, words) or tx.same_cert_family(names[k], names[k + 1]):
            kinds.append("or")
        elif re.fullmatch(r"\s*,\s*", join):
            kinds.append("list")                      # decided by how the list ends
        else:
            kinds.append("and")
    for k in range(len(kinds) - 1, -1, -1):
        if kinds[k] == "list":
            if k + 1 < len(kinds):
                kinds[k] = kinds[k + 1]
            else:
                kinds[k] = "or" if re.match(OR_EQUIVALENT_AFTER, t[last[1]:]) else "and"
    groups = [[names[0]]] if names else []
    for k, kind in enumerate(kinds):
        if kind == "or":
            groups[-1].append(names[k + 1])
        else:
            groups.append([names[k + 1]])
    # A certificate whose name was not found in the text (should not happen) is needed on its own.
    groups += [[c] for c in certs if c not in names]
    return groups


def one_cert_enough(t: str, certs: List[str]) -> bool:
    """True when one of the certificates is enough (see cert_groups)."""
    return len(cert_groups(t, certs)) == 1 and len(certs) > 1
