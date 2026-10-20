"""Dashboard APIs: guided record management, mode-scoped knowledge, the tender inbox and evaluation jobs.

Document uploads are disabled. CVs and predefined Demo records are read-only.
The local service uses explicit Company/Demo retrieval contexts and a read/write lock.
"""
import json
import os
import re
import subprocess
import sys
import threading
import time
import uuid
from contextlib import contextmanager
from typing import Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from .context import DataMode, for_mode, retrieval_scope
from . import records
from . import config
from .index import build_index, index_meta, index_ready, load_doc_store
from . import tenders

EXAMPLES_DIR = config.ROOT / "examples"
BENCHMARK_DIR = config.ROOT / "benchmark"
MAX_UPLOAD_MB = 15

router = APIRouter()


# ---------------------------------------------------------------- read/write lock
class RWLock:
    """Many readers (matching) or one writer (reindex) at a time."""

    def __init__(self):
        self._cond = threading.Condition()
        self._readers = 0
        self._writer = False

    @contextmanager
    def read(self):
        with self._cond:
            while self._writer:
                self._cond.wait()
            self._readers += 1
        try:
            yield
        finally:
            with self._cond:
                self._readers -= 1
                self._cond.notify_all()

    @contextmanager
    def write(self):
        with self._cond:
            while self._writer or self._readers:
                self._cond.wait()
            self._writer = True
        try:
            yield
        finally:
            with self._cond:
                self._writer = False
                self._cond.notify_all()


index_lock = RWLock()


def reindex(data_mode: DataMode = "company") -> int:
    with index_lock.write(), retrieval_scope(for_mode(data_mode)):
        return build_index()


# ---------------------------------------------------------------- page + examples
@router.get("/", include_in_schema=False)
def dashboard_page():
    return RedirectResponse("http://localhost:5173/", status_code=307)


@router.get("/api/examples")
def examples():
    """Example tender inputs shipped in examples/ (outputs excluded)."""
    items = []
    for path in sorted(EXAMPLES_DIR.glob("*.json")):
        if path.name.startswith("output_"):
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        items.append({"name": path.stem, "file": path.name, "data": data})
    return items


@router.get("/api/tenders")
def list_tenders():
    return {"tenders": tenders.list_all()}


@router.delete("/api/tenders")
def clear_tenders():
    """Empty the tender inbox: every stored tender and its latest analysis.
    The knowledge base and the indexes are not touched."""
    return {"deleted": tenders.clear()}


# ":path" keeps IDs that contain a slash (e.g. "BOAMP/26-101240") in one parameter.
@router.get("/api/tenders/{tender_id:path}")
def get_tender(tender_id: str):
    tender = tenders.get(tender_id)
    if tender is None:
        raise HTTPException(404, "Tender not found")
    return tender


@router.delete("/api/tenders/{tender_id:path}")
def delete_tender(tender_id: str):
    """Remove one stored tender and its latest analysis. n8n stores it again on its next /retrieve/tender call."""
    if not tenders.delete(tender_id):
        raise HTTPException(404, "Tender not found")
    return {"deleted": tender_id}


# ---------------------------------------------------------------- knowledge base
def _projects_by_cv(store: dict) -> dict:
    """CV ID -> the indexed project records that list this person in their team."""
    out = {}
    for key, d in store.items():
        for cv in (d.get("record") or {}).get("team_cv_ids", []):
            out.setdefault(cv, []).append({"doc_id": key, "title": d["title"],
                                           "delivery_status": d["record"].get("delivery_status")})
    return out


def _doc_summary(doc_id: str, d: dict, projects: dict | None = None) -> dict:
    p = d.get("profile", {})
    return {"projects": (projects or {}).get(doc_id, []),"doc_id": doc_id, "type": d["type"], "title": d["title"], "summary": d["summary"],
            "origin": d.get("origin", "cv_document"), "record": d.get("record", {}),
            "uploaded": d.get("uploaded", False), "path": d.get("path", ""),
            "lines": len(d.get("lines", [])),
            "profile": {k: p.get(k) for k in ("name", "role", "roles", "role_sources", "seniority", "years", "skills",
                                              "certifications", "sectors", "year", "client", "extractor")
                        if p.get(k) not in (None, "", [])}}


@router.get("/api/documents")
def documents(data_mode: DataMode = "company"):
    with index_lock.read(), retrieval_scope(for_mode(data_mode)):
        if not index_ready():
            return {"ready": False, "documents": []}
        store = load_doc_store()
        projects = _projects_by_cv(store)
        return {"ready": True, "documents": [_doc_summary(k, v, projects) for k, v in store.items()],
                "built_at": index_meta().get("built_at"), "data_mode": data_mode}


@router.get("/api/documents/{doc_id}")
def document(doc_id: str, data_mode: DataMode = "company"):
    with index_lock.read(), retrieval_scope(for_mode(data_mode)):
        store = load_doc_store() if index_ready() else {}
        if doc_id not in store:
            raise HTTPException(404, "Document not found")
        d = store[doc_id]
        return {**_doc_summary(doc_id, d, _projects_by_cv(store)), "text_lines": d.get("lines", []), "full_profile": d.get("profile", {})}


@router.post("/api/documents")
def upload():
    raise HTTPException(410, "Document uploads have been replaced by guided record forms. Use /api/records. CVs are read-only.")


@router.delete("/api/documents/{doc_id}")
def delete(doc_id: str):
    raise HTTPException(403, "CVs are read-only. Manage non-CV records through /api/records.")


class SaveRecord(records.RecordInput):
    action: Literal["draft", "index"] = "draft"


@router.get("/api/records")
def list_records(data_mode: DataMode = "company"):
    with index_lock.read():
        # Read the record files once for the duplicate and link checks. Letting validate_record read them
        # again for every record made this list take ~20 s on the company records (N+1 full reads).
        existing = records.all_records()
        return {"records": [{**r, "validation": records.validate_record(r, existing), "read_only": r["origin"] == "demo"}
                            for r in records.visible_records(data_mode)], "data_mode": data_mode}


@router.post("/api/records/validate")
def validate_record(payload: records.RecordInput):
    with index_lock.read():
        return records.validate_record(records.new_record(payload))


def _get_record(record_id):
    record = next((r for r in records.all_records() if r["id"] == record_id), None)
    if record is None:
        raise HTTPException(404, "Record not found")
    if record["origin"] != "user_entered":
        raise HTTPException(403, "Predefined demo records are read-only.")
    return record


def _save_record(payload, previous=None):
    values = records.RecordInput.model_validate(payload.model_dump(exclude={"action"}))
    if previous and values.type != previous["type"]:
        raise HTTPException(422, {"errors": {"type": "Record type cannot be changed. Create a new record instead."}})
    candidate = records.new_record(values)
    if previous:
        candidate.update(id=previous["id"], created_at=previous["created_at"])
    validation = records.validate_record(candidate)
    if payload.action == "index" and not validation["valid"]:
        raise HTTPException(422, validation)
    candidate["status"] = "indexed" if payload.action == "index" else "draft"
    records.persist(candidate)
    try:
        if payload.action == "index" or previous and previous["status"] == "indexed":
            build_index()
    except Exception:
        candidate["status"] = "draft"
        records.persist(candidate)
        raise HTTPException(503, {"message": "Saved as a draft. Indexing failed; the previous index remains available. Retry Save and index.", "record": candidate})
    return {"record": candidate, "validation": validation}


@router.post("/api/records")
def create_record(payload: SaveRecord):
    with index_lock.write(), retrieval_scope(for_mode("company")):
        return _save_record(payload)


@router.put("/api/records/{record_id}")
def update_record(record_id: str, payload: SaveRecord):
    with index_lock.write(), retrieval_scope(for_mode("company")):
        return _save_record(payload, _get_record(record_id))


@router.post("/api/records/{record_id}/index")
def index_record(record_id: str):
    with index_lock.write(), retrieval_scope(for_mode("company")):
        record = _get_record(record_id)
        values = {k: record[k] for k in records.RecordInput.model_fields if k in record}
        return _save_record(SaveRecord(**values, action="index"), record)


@router.delete("/api/records/{record_id}")
def delete_record(record_id: str, confirm_links: bool = False):
    with index_lock.write(), retrieval_scope(for_mode("company")):
        record = _get_record(record_id)
        linked = [r for r in records.visible_records("company") if record_id in r.get("linked_ids", [])]
        if linked and not confirm_links:
            raise HTTPException(409, {"message": "Other records link to this record.", "linked_by": [r["id"] for r in linked]})
        records.record_path(record).unlink()
        for r in linked:
            r["linked_ids"].remove(record_id)
            r["updated_at"] = records.now()
            records.persist(r)
        try:
            build_index()
        except Exception:
            raise HTTPException(503, "Record deleted and excluded from retrieval. Index refresh failed; retry Rebuild index.")
        return {"deleted": record_id, "warnings": ["Removed links from " + r["title"] for r in linked]}


# ---------------------------------------------------------------- benchmark results
@router.get("/api/benchmark")
def benchmark_results():
    path = BENCHMARK_DIR / "results.json"
    if not path.exists():
        return {"available": False}
    data = json.loads(path.read_text(encoding="utf-8"))
    data["available"] = True
    data["updated"] = time.strftime("%Y-%m-%d %H:%M", time.localtime(path.stat().st_mtime))
    tests = BENCHMARK_DIR / "test_results.txt"
    if tests.exists():
        data["tests"] = _parse_pytest(tests.read_text(encoding="utf-8", errors="replace"))
    return data


def _parse_pytest(output: str) -> dict:
    rows = []
    for line in output.splitlines():
        m = re.match(r"^(tests/\S+::\S.*?)\s+(PASSED|FAILED|ERROR|SKIPPED)", line.strip())
        if m:
            rows.append({"test": m.group(1).split("::", 1)[1], "result": m.group(2)})
    counts = {k: int(v) for v, k in re.findall(r"(\d+) (passed|failed|error|errors|skipped)", output)}
    summary = next((ln.strip("= ").strip() for ln in reversed(output.splitlines())
                    if re.search(r"\d+ (passed|failed)", ln)), "")
    return {"rows": rows, "counts": counts, "summary": summary}


# ---------------------------------------------------------------- background jobs
JOBS: dict[str, dict] = {}
_jobs_lock = threading.Lock()


def _new_job(kind: str) -> dict:
    with _jobs_lock:
        for job in JOBS.values():
            if job["kind"] == kind and job["status"] == "running":
                raise HTTPException(409, f"A {kind} run is already in progress.")
        job = {"id": uuid.uuid4().hex[:12], "kind": kind, "status": "running",
               "started": time.time(), "finished": None, "log": [], "result": None, "error": None}
        JOBS[job["id"]] = job
        return job


def _run_benchmark(job):
    # The benchmark uses its own authoritative-CV index and runs in its own process. The dashboard keeps answering
    # from chroma_db/ in the meantime.
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1"}
    try:
        proc = subprocess.Popen(
            [sys.executable, "-m", "benchmark.run_benchmark", "--quick"],
            cwd=config.ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace")
        for line in proc.stdout:
            line = line.strip()
            if line and not re.search(r"Loading weights|Batches|Warning|warn\(|^\s*from ", line):
                job["log"].append(line[-300:])
        code = proc.wait()
        job["status"] = "done" if code == 0 else "failed"
        if code:
            job["error"] = job["log"][-1] if job["log"] else f"The benchmark stopped (exit code {code})."
    except Exception as e:  # report, never crash the server
        job["status"], job["error"] = "failed", f"{type(e).__name__}: {e}"
    job["finished"] = time.time()


def _run_tests(job):
    # tests/conftest.py gives the tests their own copy of data/ and their own
    # index, so they never touch what the dashboard is using.
    if True:
        env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
        try:
            proc = subprocess.run(
                [sys.executable, "-m", "pytest", "-v", "-o", "addopts=", "-p", "no:cacheprovider"],
                cwd=config.ROOT, env=env, capture_output=True, text=True,
                encoding="utf-8", errors="replace", timeout=900)
            output = proc.stdout + proc.stderr
            job["log"] = output.splitlines()[-400:]
            job["result"] = _parse_pytest(output)
            job["status"] = "done" if proc.returncode == 0 else "failed"
            if proc.returncode == 0:  # keep the report file in sync with the last green run
                lines = [ln for ln in output.splitlines()
                         if re.search(r"PASSED|FAILED|ERROR|passed|failed", ln)]
                (BENCHMARK_DIR / "test_results.txt").write_text(
                    "\n".join(re.sub(r"\s*\[\s*\d+%\]", "", ln) for ln in lines) + "\n", encoding="utf-8")
            else:
                job["error"] = job["result"]["summary"] or "Some tests failed."
        except subprocess.TimeoutExpired:
            job["status"], job["error"] = "failed", "The tests took longer than 15 minutes."
        except Exception as e:
            job["status"], job["error"] = "failed", f"{type(e).__name__}: {e}"
    job["finished"] = time.time()


@router.post("/api/jobs/{kind}")
def start_job(kind: Literal["benchmark", "tests"]):
    job = _new_job(kind)
    target = _run_benchmark if kind == "benchmark" else _run_tests
    threading.Thread(target=target, args=(job,), daemon=True).start()
    return {"id": job["id"], "kind": kind, "status": job["status"]}


@router.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    end = job["finished"] or time.time()
    return {**job, "log": job["log"][-60:], "seconds": round(end - job["started"])}
