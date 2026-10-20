"""Knowledge coverage report: what the knowledge base lacks for a tender, and what to add.

For each requirement that is missing or only partly covered, explain the cause from the
indexed knowledge (no CV with that role, no completed project in that sector, a skill
nobody lists...) and suggest the record or CV that would close the gap.
"""
from . import records
from . import taxonomy as tx

ADD = {
    "cv": "Add the CV of a qualified employee to the CV bank (data/cvs), or plan recruitment or a partner.",
    "project": "Add a completed project record in Knowledge base > Projects.",
    "tech": "Add a technology stack or tool record that lists it, or the CV of someone who uses it.",
}


def _holders(store, key, value, doc_types=("cv",)):
    return [k for k, d in store.items() if d["type"] in doc_types and value in d.get("profile", {}).get(key, [])]


def _completed_projects(store, sector=None):
    return [k for k, d in store.items() if d["type"] == "past_project"
            and d.get("profile", {}).get("delivery_status") == "completed"
            and (sector is None or sector in d.get("profile", {}).get("sectors", []))]


def _draft_projects(sector):
    return [r for r in records.visible_records() if r["type"] == "past_project"
            and (r["status"] == "draft" or r.get("delivery_status") != "completed")
            and sector in tx.find_sectors(r.get("sector", ""))]


def _gap(row, kind, gap, suggestion):
    return {"requirement": row["requirement"], "category": row["category"], "status": row["status"],
            "mandatory": row["mandatory"], "kind": kind, "gap": gap, "suggestion": suggestion}


def requirement_gaps(row: dict, store: dict) -> list[dict]:
    if row["status"] == "covered":
        return []
    p, out = row["parsed"], []
    short = row["needed"] - row["found"]

    certs = p.get("certs", [])
    # Groups of alternatives ("PSM or CSM and PMP" -> [[PSM, CSM], [PMP]]): a group with a holder is met, and a gap names
    # the whole group, never one member the line does not require on its own.
    groups = p.get("cert_groups") or ([certs] if p.get("any_cert") else [[c] for c in certs])
    for group in groups:
        if any(_holders(store, "certifications", c) for c in group):
            continue        # "PMP or PRINCE2": one of them is held
        cert = " or ".join(group)
        gap = f"No CV lists the {cert} certification."
        suggestion = f"{ADD['cv']} Company certifications (such as ISO 27001) need their certificate holder's CV."
        near = {alt: _holders(store, "certifications", alt)
                for member in group for alt in tx.equivalent_certs(member) if alt not in group}
        alt = next((a for a, who in near.items() if who), None)
        if alt:
            gap += (f" {len(near[alt])} CV(s) list {alt}, an equivalent certification: "
                    "it counts only if the buyer accepts it.")
            suggestion = f"Ask the buyer whether {alt} is accepted instead of {cert}. " + suggestion
        out.append(_gap(row, "certification", gap, suggestion))
    if row["category"] == "team":
        for role in p.get("roles", []):
            with_role = _holders(store, "roles", role)
            seniority = p.get("seniority")
            fitting = [k for k in with_role if not seniority or store[k]["profile"].get("seniority") == seniority]
            who = f"{seniority + ' ' if seniority else ''}{role}"
            if not with_role:
                out.append(_gap(row, "people", f"No CV with the role '{role}'.", ADD["cv"]))
            elif len(fitting) < row["needed"]:
                out.append(_gap(row, "people",
                                f"{len(with_role)} CV(s) with the role '{role}', but only {len(fitting)} {who}(s); "
                                f"{row['needed']} needed.",
                                f"Need {row['needed'] - len(fitting)} more {who}(s). {ADD['cv']}"))
    if row["category"] == "experience":
        for sector in p.get("sectors", []):
            done = _completed_projects(store, sector)
            if len(done) < row["needed"]:
                drafts = _draft_projects(sector)
                hint = (f" {len(drafts)} {sector} project record(s) exist but are drafts or not completed: "
                        + ", ".join(r["title"] for r in drafts[:3]) + ". Complete and index them if they were delivered."
                        if drafts else "")
                out.append(_gap(row, "project",
                                f"{len(done)} completed project(s) in the {sector} sector; {row['needed']} needed.",
                                ADD["project"] + f" Set its sector to '{sector}' and status to completed." + hint))
        if not p.get("sectors") and not p.get("certs") and short > 0:
            out.append(_gap(row, "project", f"Only {row['found']} matching completed project(s); {row['needed']} needed.",
                            ADD["project"]))
    if row["category"] == "technical":
        missing = [s for s in p.get("skills", []) if not _holders(store, "skills", s, tuple({d["type"] for d in store.values()}))]
        for s in missing:
            out.append(_gap(row, "technology", f"No CV, project, stack or tool lists '{s}'.", ADD["tech"]))
        unknown = [w for w in p.get("leftover", []) if len(w) > 2]
        if row["status"] == "missing" and unknown and not missing:
            out.append(_gap(row, "technology", f"Nothing in the knowledge base mentions: {', '.join(unknown)}.",
                            ADD["tech"] + " If OliveSoft has no such capability, consider a partner."))
    if not out:
        if row["status"] == "partial" and short > 0:
            out.append(_gap(row, "evidence", f"Only {row['found']} of {row['needed']} found.", ADD["cv"]))
        elif row["status"] == "partial":
            out.append(_gap(row, "evidence", row.get("note") or "Weak evidence only: the best match is not a clear fit.",
                            "Check the closest documents manually; add a record or CV that states this capability explicitly."))
        else:
            out.append(_gap(row, "evidence", "No document in the knowledge base qualifies.",
                            "Add the CV, project, stack or tool that proves this requirement."))
    return out


def knowledge_report(rows: list[dict], store: dict, sectors: list[str], domain_percent) -> dict:
    gaps = [g for row in rows for g in requirement_gaps(row, store)]
    if sectors and not domain_percent:
        for s in sectors:
            if not _completed_projects(store, s):
                gaps.append({"requirement": f"Domain fit ({s} sector)", "category": "domain", "status": "missing",
                             "mandatory": False, "kind": "project",
                             "gap": f"No completed project in the {s} sector, so domain fit is 0.",
                             "suggestion": ADD["project"] + f" Set its sector to '{s}'."})
    counts = {t: sum(1 for d in store.values() if d["type"] == t)
              for t in ("cv", "past_project", "tech_stack", "tool", "client_portfolio")}
    counts["completed_projects"] = len(_completed_projects(store))
    return {"gaps": gaps, "knowledge_counts": counts,
            "summary": (f"{len(gaps)} gap(s) found." if gaps else "No knowledge gaps for this tender.")}
