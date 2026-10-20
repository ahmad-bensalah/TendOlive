"""Shared test helper: keep tests out of the real runtime folders.

The tests run server.py in-process. isolate(server) points its uploads/ and
exports/ folders at a temporary directory that is removed when the test run
exits, so a full test run leaves exports/, uploads/ and saves/ untouched.
(saves/ is already redirected through the SAVES_DIR env var in each test.)
"""
import atexit
import shutil
import tempfile
from pathlib import Path

RUNTIME_DIR = Path(tempfile.mkdtemp(prefix="rfp_test_runtime_"))
atexit.register(shutil.rmtree, RUNTIME_DIR, True)


def isolate(server_module):
    """Redirect server_module.UPLOADS and server_module.EXPORTS_DIR to temp folders."""
    uploads = RUNTIME_DIR / "uploads"
    exports = RUNTIME_DIR / "exports"
    uploads.mkdir(exist_ok=True)
    exports.mkdir(exist_ok=True)
    server_module.UPLOADS = uploads
    server_module.EXPORTS_DIR = exports
    # Template library, tenders and generation runs also live in the temp folder
    import os
    for var, sub in (("TEMPLATES_DIR", "templates"), ("TENDERS_DIR", "tenders"), ("GENERATIONS_DIR", "generations")):
        if not os.environ.get(var, "").startswith(str(RUNTIME_DIR)) and var not in os.environ:
            os.environ[var] = str(RUNTIME_DIR / sub)
    os.environ.setdefault("TEMPLATES_AUTOIMPORT", "0")
    return RUNTIME_DIR


def slow(test_item):
    """Mark a browser (Playwright) test as slow. Set RFP_FAST=1 to skip slow tests."""
    import os
    import unittest
    return unittest.skipIf(os.environ.get("RFP_FAST") == "1",
                           "slow browser test skipped (RFP_FAST=1)")(test_item)
