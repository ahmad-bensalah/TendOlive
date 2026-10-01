"""Run every test on a private copy of data/ with its own index.

The real data/ folder and chroma_db/ index are never touched, so the tests are
safe to run while the dashboard is open (the dashboard's "Run tests" button does this).
The copy holds the mock data only (the tests check exact results on it);
tests/test_real_cvs.py reads the sample OliveSoft CVs from data/olivesoft_cvs/ directly.
"""
import atexit
import os
import shutil
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

_tmp = Path(tempfile.mkdtemp(prefix="rag_tests_"))
shutil.copytree(ROOT / "data", _tmp / "data", ignore=shutil.ignore_patterns("uploads", "olivesoft_cvs"))
os.environ["RAG_DATA_DIR"] = str(_tmp / "data")
os.environ["RAG_DB_DIR"] = str(_tmp / "chroma_db")
os.environ.setdefault("ANONYMIZED_TELEMETRY", "False")
atexit.register(shutil.rmtree, _tmp, ignore_errors=True)
