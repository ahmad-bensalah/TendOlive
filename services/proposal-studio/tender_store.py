"""tender_store.py — Selected tenders (tenders/inbox/*.json) and generation runs (generations/*.json).

Tenders: one JSON file per tender, in the agent input format (the olivesoft.proposal-input.v2
contract from the RAG step, or the simple test format of tests/inputs/). The RAG step writes
them through POST /api/tenders; for now they are mock files dropped in the inbox.

Generations: one record per run. The platform creates it, starts the agents (n8n webhook, or the
local CLI), and the agents push their progress to POST /api/generations/<runId>/progress.
"""
import json
import re
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

MAX_TENDER_BYTES = 1024 * 1024
TERMINAL = ("done", "failed")
STEP_NAMES = ["agent1", "agent5", "diagrams", "agent4", "agent6", "publish"]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def safe_id(value: Any) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "-", str(value or ""))[:64].strip("-")


def tender_id_of(raw: dict) -> str:
    return safe_id(raw.get("tender_id") or (raw.get("tender") or {}).get("id") or (raw.get("tender") or {}).get("reference"))


def validate_tender(raw: Any) -> List[str]:
    """Minimal contract check: an object with a tender id and a title. Unknown fields are kept."""
    if not isinstance(raw, dict):
        return ["the tender must be a JSON object"]
    errors = []
    if not isinstance(raw.get("tender"), dict):
        errors.append("missing object 'tender'")
    if not tender_id_of(raw):
        errors.append("missing tender id ('tender_id', 'tender.id' or 'tender.reference')")
    if not str((raw.get("tender") or {}).get("title") or "").strip():
        errors.append("missing 'tender.title'")
    for key in ("match", "matrix", "rag", "analysis", "competition", "research"):
        if key in raw and raw[key] is not None and not isinstance(raw[key], dict):
            errors.append(f"'{key}' must be an object")
    return errors


def summarize(raw: dict) -> dict:
    """Card data for the main screen, for both input formats."""
    t = raw.get("tender") or {}
    if "matrix" in raw or "analysis" in raw or "contract" in raw:   # v2 (RAG output)
        analysis, matrix, rag = raw.get("analysis") or {}, raw.get("matrix") or {}, raw.get("rag") or {}
        buyer = raw.get("buyer_profile") or {}
        score = analysis.get("relevance_score", (matrix.get("summary") or {}).get("fit_score"))
        assets = rag.get("assets") or []
        ev = [e for r in matrix.get("rows") or [] for e in r.get("evidence") or []]
        by_type = lambda k: len({a.get("asset_id") for a in assets + ev if a.get("asset_type") == k})
        ttype = str(analysis.get("tender_type") or "")
        summary = {
            "title": t.get("title", ""), "client": buyer.get("legal_name") or buyer.get("name") or t.get("issuer") or "",
            "deadline": t.get("deadline") or "", "language": raw.get("language") or "fr",
            "project_type": "saas" if "saas" in ttype else ("software" if ("software" in ttype or "platform" in ttype) else (ttype or "other")),
            "matchScore": round(score) if isinstance(score, (int, float)) and score > 1 else (round(score * 100) if isinstance(score, (int, float)) else None),
            "counts": {"requirements": len(matrix.get("rows") or []), "similarProjects": by_type("project"),
                       "certifications": None, "engineers": by_type("cv")},
            "hasResearch": (raw.get("competition") or {}).get("status") == "OK" or bool(raw.get("research")),
            "estimatedValue": t.get("estimated_value") or "",
        }
    else:                                                               # simple format (tests/inputs)
        m = raw.get("match") or {}
        score = m.get("score")
        summary = {
            "title": t.get("title", ""), "client": t.get("client", ""), "deadline": t.get("deadline", ""),
            "language": t.get("language", "fr"), "project_type": t.get("project_type", "other"),
            "matchScore": round(score * 100) if isinstance(score, (int, float)) and score <= 1 else score,
            "counts": {"requirements": len(t.get("requirements") or []),
                       "similarProjects": len(m.get("similar_projects") or []),
                       "certifications": (m.get("certifications") or {}).get("matching"),
                       "engineers": (m.get("engineers") or {}).get("specialized")},
            "hasResearch": bool(raw.get("research")),
            "estimatedValue": "",
        }
    summary["id"] = tender_id_of(raw)
    return summary


class TenderStore:
    def __init__(self, base: Path):
        self.base = Path(base)
        self.inbox = self.base / "inbox"
        self.trash = self.base / "trash"
        self.inbox.mkdir(parents=True, exist_ok=True)

    def _files(self):
        return sorted(p for p in self.inbox.glob("*.json") if p.is_file())

    def scan(self):
        """(tenders by id, error entries). Read on every call: dropped files appear without restart."""
        tenders, errors = {}, []
        for f in self._files():
            try:
                if f.stat().st_size > MAX_TENDER_BYTES:
                    raise ValueError("file larger than 1 MB")
                raw = json.loads(f.read_text(encoding="utf-8"))
                problems = validate_tender(raw)
                if problems:
                    raise ValueError("; ".join(problems))
                tenders[tender_id_of(raw)] = (f, raw)
            except Exception as e:
                errors.append({"file": f.name, "message": str(e)})
        return tenders, errors

    def get(self, tid: str) -> Optional[dict]:
        found = self.scan()[0].get(tid)
        return found[1] if found else None

    def put(self, raw: dict) -> str:
        problems = validate_tender(raw)
        if problems:
            raise ValueError("; ".join(problems))
        tid = tender_id_of(raw)
        existing = self.scan()[0].get(tid)
        target = existing[0] if existing else self.inbox / f"{tid}.json"
        target.write_text(json.dumps(raw, indent=2, ensure_ascii=False), encoding="utf-8")
        return tid

    def delete(self, tid: str) -> bool:
        found = self.scan()[0].get(tid)
        if not found:
            return False
        self.trash.mkdir(parents=True, exist_ok=True)
        found[0].rename(self.trash / f"{found[0].stem}-{int(time.time())}.json")
        return True


class GenerationStore:
    def __init__(self, base: Path):
        self.base = Path(base)
        self.base.mkdir(parents=True, exist_ok=True)

    def _path(self, run_id: str) -> Path:
        return self.base / f"{run_id}.json"

    def create(self, tender_id: str, template_id: Optional[str], params: dict) -> dict:
        run_id = uuid.uuid4().hex[:12]
        rec = {"runId": run_id, "tenderId": tender_id, "templateId": template_id, "params": params,
               "status": "queued", "step": None, "steps": [{"agent": s, "status": "pending"} for s in STEP_NAMES],
               "createdAt": _now(), "updatedAt": time.time()}
        self.save(rec)
        return rec

    def save(self, rec: dict) -> None:
        tmp = self._path(rec["runId"]).with_suffix(".tmp")
        tmp.write_text(json.dumps(rec, indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self._path(rec["runId"]))

    def get(self, run_id: str, timeout_s: float = 1200) -> Optional[dict]:
        if not re.fullmatch(r"[a-f0-9]{12}", run_id or ""):
            return None
        try:
            rec = json.loads(self._path(run_id).read_text(encoding="utf-8"))
        except Exception:
            return None
        if rec.get("status") not in TERMINAL and time.time() - rec.get("updatedAt", 0) > timeout_s:
            rec.update(status="failed", error="timeout", updatedAt=time.time())
            self.save(rec)
        return rec

    def update(self, run_id: str, patch: dict) -> Optional[dict]:
        rec = self.get(run_id)
        if not rec:
            return None
        if rec.get("status") in TERMINAL:
            return rec                              # terminal states are final
        allowed = ("status", "step", "steps", "deckId", "url", "warnings", "placeholders",
                   "problemsRemaining", "usage", "timings", "error", "waitingRateLimit")
        for k in allowed:
            if k in patch:
                rec[k] = patch[k]
        if rec.get("status") not in ("queued", "running", "done", "failed"):
            rec["status"] = "running"
        rec["updatedAt"] = time.time()
        self.save(rec)
        return rec

    def list(self, tender_id: Optional[str] = None, timeout_s: float = 1200) -> List[dict]:
        out = []
        for f in self.base.glob("*.json"):
            rec = self.get(f.stem, timeout_s)
            if rec and (tender_id is None or rec.get("tenderId") == tender_id):
                out.append(rec)
        out.sort(key=lambda r: r.get("createdAt", ""), reverse=True)
        return out

    def active(self, timeout_s: float = 1200) -> List[dict]:
        return [r for r in self.list(timeout_s=timeout_s) if r.get("status") not in TERMINAL]
