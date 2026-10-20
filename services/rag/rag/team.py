"""Team builder: the fewest CVs that fill every team requirement of a tender.

Each team requirement has a set of qualifying CVs (from the matcher) and a headcount.
One person may count for several requirements when their CV qualifies for each one
(for example a GCP-certified data engineer also counts as one of "3 data engineers").
The search tries teams of increasing size, so the first team found is the smallest.
"""
from itertools import combinations
from math import comb

from . import records

MAX_COMBINATIONS = 200_000   # above this, fall back to a greedy choice


def _covers(team, needs):
    return all(len(team & eligible) >= need for eligible, need in needs)


def _assign(team_order, needs, texts):
    """Give each requirement its headcount, spreading the work across members."""
    load = {d: [] for d in team_order}
    for i in sorted(range(len(needs)), key=lambda i: len(set(team_order) & needs[i][0])):
        eligible, need = needs[i]
        for d in sorted((d for d in team_order if d in eligible), key=lambda d: len(load[d]))[:need]:
            load[d].append(texts[i])
    return load


def build_team(results: list[dict], store: dict, matches: list[dict] | None = None) -> dict | None:
    """results: match_requirement outputs. Uses only the team requirements."""
    team_rows = [r for r in results if r["category"] == "team"]
    if not team_rows:
        return None
    texts = [r["requirement"] for r in team_rows]
    needs, unfilled = [], []
    for r in team_rows:
        eligible = [d for d in r.get("eligible", []) if store.get(d, {}).get("type") == "cv"]
        need = min(r["needed"], len(eligible))
        if len(eligible) < r["needed"]:
            unfilled.append({"requirement": r["requirement"], "needed": r["needed"], "available": len(eligible),
                             "mandatory": r["mandatory"]})
        needs.append((set(eligible), need))

    # Candidates in a useful order: people who qualify for more requirements first,
    # then by their best rank in the matcher.
    rank = {}
    for r in team_rows:
        for pos, d in enumerate(r.get("eligible", [])):
            rank[d] = min(rank.get(d, 10**6), pos)
    candidates = sorted({d for eligible, _ in needs for d in eligible},
                        key=lambda d: (-sum(d in e for e, n in needs if n), rank.get(d, 10**6)))
    active = [(e, n) for e, n in needs if n]

    team, method = None, "exact minimum"
    lower = max([n for _, n in active], default=0)
    for size in range(lower, len(candidates) + 1):
        if comb(len(candidates), size) > MAX_COMBINATIONS:
            break
        team = next((list(c) for c in combinations(candidates, size) if _covers(set(c), active)), None)
        if team is not None:
            break
    if team is None:
        # Greedy: repeatedly take the person who fills the most remaining places.
        method, team, remaining = "greedy", [], [list(x) for x in active]
        while any(n > 0 for _, n in remaining):
            best = max((d for d in candidates if d not in team),
                       key=lambda d: sum(1 for e, n in remaining if n > 0 and d in e), default=None)
            if best is None:
                break
            team.append(best)
            for item in remaining:
                if best in item[0] and item[1] > 0:
                    item[1] -= 1

    load = _assign(team, needs, texts)
    matched_projects = {m["doc_id"] for m in (matches or []) if m.get("type") == "past_project"}
    projects_by_cv = {}
    for doc_id, d in store.items():
        for cv in (d.get("record") or {}).get("team_cv_ids", []):
            projects_by_cv.setdefault(cv, []).append(
                {"doc_id": doc_id, "title": d["title"], "matches_tender": doc_id in matched_projects})
    members = []
    for d in team:
        prof = store[d].get("profile", {})
        qualifies = [t for t, (e, _) in zip(texts, needs) if d in e]
        members.append({
            "doc_id": d, "title": store[d]["title"], "name": prof.get("name") or records.cv_person(d),
            "seniority": prof.get("seniority"), "years": prof.get("years"), "roles": prof.get("roles", []),
            "certifications": prof.get("certifications", []),
            "assigned_to": load.get(d, []),
            "also_qualifies_for": [t for t in qualifies if t not in load.get(d, [])],
            "company_projects": projects_by_cv.get(d, []),
        })
    filled = sum(len(m["assigned_to"]) for m in members)
    notes = ["A person may fill several requirements when their CV qualifies for each. Check availability and workload."]
    if unfilled:
        notes.append("Some requirements cannot be filled from the CV bank; see 'unfilled'.")
    # A CSM holder can fill "1 PSM certified Scrum Master" only if the buyer accepts the equivalence.
    for r in team_rows:
        for m in members:
            why = r.get("equivalent", {}).get(m["doc_id"])
            if why and r["requirement"] in m["assigned_to"]:
                cert = next((x for x in why if "equivalent certification" in x), why[0])
                notes.append(f"{m['name']} fills '{r['requirement']}' with {cert}.")
    return {"size": len(members), "method": method, "members": members, "unfilled": unfilled,
            "places_filled": filled, "places_needed": sum(r["needed"] for r in team_rows), "notes": notes}
