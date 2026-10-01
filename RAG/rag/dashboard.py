"""Endpoints behind the web dashboard (rag/ui/index.html).

The dashboard is a local tool: the server listens on 127.0.0.1 only (see app.py).
It adds, next to the n8n API in api.py:
    GET    /                         the dashboard page
    GET    /api/examples             example tenders
    GET    /api/documents            knowledge base (profiles)
    GET    /api/documents/{doc_id}   one document (profile + text lines)
    POST   /api/documents            upload a file (base64 JSON), then reindex
    DELETE /api/documents/{doc_id}   delete an uploaded file, then reindex
    GET    /api/benchmark            last benchmark results
    POST   /api/jobs/{kind}          start "benchmark" or "tests" in the background
    GET    /api/jobs/{job_id}        job status and output
"""
import base64
import binascii
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import config
from .index import build_index, index_meta, index_ready, load_doc_store
from .loader import EXTENSIONS, MIN_WORDS, UPLOAD_FOLDERS, read_file

UI_FILE = Path(__file__).parent / "ui" / "index.html"
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


def reindex() -> int:
    with index_lock.write():
        return build_index()


# ---------------------------------------------------------------- page + examples
@router.get("/", include_in_schema=False)
def dashboard_page():
    return FileResponse(UI_FILE, media_type="text/html")


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


# ---------------------------------------------------------------- knowledge base
def _doc_summary(doc_id: str, d: dict) -> dict:
    p = d.get("profile", {})
    return {"doc_id": doc_id, "type": d["type"], "title": d["title"], "summary": d["summary"],
            "uploaded": d.get("uploaded", False), "path": d.get("path", ""),
            "lines": len(d.get("lines", [])),
            "profile": {k: p.get(k) for k in ("name", "role", "roles", "seniority", "years", "skills",
                                              "certifications", "sectors", "year", "client", "extractor")
                        if p.get(k) not in (None, "", [])}}


@router.get("/api/documents")
def documents():
    if not index_ready():
        return {"ready": False, "documents": []}
    store = load_doc_store()
    docs = [_doc_summary(k, v) for k, v in store.items()]
    return {"ready": True, "documents": docs, "built_at": index_meta().get("built_at")}


@router.get("/api/documents/{doc_id}")
def document(doc_id: str):
    store = load_doc_store() if index_ready() else {}
    if doc_id not in store:
        raise HTTPException(404, "Document not found")
    d = store[doc_id]
    return {**_doc_summary(doc_id, d), "text_lines": d.get("lines", []),
            "full_profile": d.get("profile", {})}


class Upload(BaseModel):
    filename: str
    content_base64: str
    doc_type: Literal["cv", "past_project", "tech_stack", "client_portfolio"] = "cv"


def _safe_name(filename: str) -> str:
    name = Path(filename.replace("\\", "/")).name
    stem, suffix = os.path.splitext(name)
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", stem).strip("._") or "document"
    return stem[:80] + suffix.lower()


@router.post("/api/documents")
def upload(body: Upload):
    name = _safe_name(body.filename)
    if Path(name).suffix not in EXTENSIONS:
        raise HTTPException(400, f"Unsupported file type. Use one of: {', '.join(sorted(EXTENSIONS))}")
    try:
        content = base64.b64decode(body.content_base64, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(400, "The file content is not valid base64.")
    if not content:
        raise HTTPException(400, "The file is empty.")
    if len(content) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(400, f"The file is larger than {MAX_UPLOAD_MB} MB.")

    # Check the text can be read before touching the index.
    with tempfile.TemporaryDirectory() as tmp:
        probe = Path(tmp) / name
        probe.write_bytes(content)
        try:
            words = len(read_file(probe).split())
        except Exception:
            raise HTTPException(422, "This file could not be read. Is it a valid PDF, Word or text file?")
    if words < MIN_WORDS:
        raise HTTPException(422, "No text could be read from this file (empty or a scanned image?). "
                                 "It was not added.")

    # A name already used by a built-in document would be skipped by the loader.
    store = load_doc_store() if index_ready() else {}
    if name in store and not store[name].get("uploaded"):
        stem, suffix = os.path.splitext(name)
        name = f"{stem}_upload{suffix}"

    folder = config.DATA_DIR / UPLOAD_FOLDERS[body.doc_type]
    with index_lock.write():
        folder.mkdir(parents=True, exist_ok=True)
        for other in UPLOAD_FOLDERS.values():  # same name in another type folder: replace it
            stale = config.DATA_DIR / other / name
            if other != UPLOAD_FOLDERS[body.doc_type] and stale.exists():
                stale.unlink()
        (folder / name).write_bytes(content)
        chunks = build_index()

    store = load_doc_store()
    if name not in store:
        raise HTTPException(500, "The file was saved but not indexed. Check the server window.")
    return {"added": _doc_summary(name, store[name]), "chunks": chunks}


@router.delete("/api/documents/{doc_id}")
def delete(doc_id: str):
    store = load_doc_store() if index_ready() else {}
    d = store.get(doc_id)
    if not d:
        raise HTTPException(404, "Document not found")
    if not d.get("uploaded"):
        raise HTTPException(403, "Only documents added from the dashboard can be deleted here.")
    path = (config.DATA_DIR / d["path"]).resolve()
    if config.DATA_DIR.resolve() / "uploads" not in path.parents:
        raise HTTPException(403, "Refusing to delete a file outside data/uploads.")
    with index_lock.write():
        path.unlink(missing_ok=True)
        chunks = build_index()
    return {"deleted": doc_id, "chunks": chunks}


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
    # The benchmark uses its own indexes (benchmark/.index/) and switches between the mock
    # data and the real CVs, so it runs in its own process. The dashboard keeps answering
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
