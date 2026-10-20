"""Tests use private non-CV data and indexes; CVs are read from the authoritative folder."""
import atexit
import os
import json
import shutil
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

_tmp = Path(tempfile.mkdtemp(prefix="rag_tests_"))
for folder in ("projects", "tech_stacks", "clients", "tools"):
    destination = _tmp / "data" / folder
    destination.mkdir(parents=True)
    for path in (ROOT.parent / "data" / folder).glob("*.json"):
        if json.loads(path.read_text(encoding="utf-8"))["origin"] == "demo":
            shutil.copy2(path, destination)
os.environ["RAG_DATA_DIR"] = str(_tmp / "data")
os.environ["RAG_DB_DIR"] = str(_tmp / "chroma_db")
os.environ["RAG_TENDERS_FILE"] = str(_tmp / "tenders.json")
os.environ.setdefault("ANONYMIZED_TELEMETRY", "False")
atexit.register(shutil.rmtree, _tmp, ignore_errors=True)
