"""tests/test_tenders_generations.py — Tender store, generation runs (fake n8n and CLI mode), main screen.

All folders are temporary; the fake n8n server records what the platform sends.
"""
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

STUDIO_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(STUDIO_DIR))
sys.path.insert(0, str(Path(__file__).resolve().parent))

TMP = Path(tempfile.mkdtemp(prefix="rfp_tenders_test_"))
os.environ.setdefault("SAVES_DIR", str(TMP / "saves"))
os.environ["STUDIO_API_KEY"] = "secret-test-key-12345"

import server
import _runtime
import tender_store

_runtime.isolate(server)
KEY = "secret-test-key-12345"


class FakeN8n(BaseHTTPRequestHandler):
    received = []
    status = 200

    def log_message(self, *a):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        FakeN8n.received.append({"headers": dict(self.headers), "body": json.loads(body or b"{}")})
        self.send_response(FakeN8n.status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"message":"Workflow was started"}')


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dirs = {k: TMP / f"{cls.__name__}_{k}" for k in ("tenders", "generations", "templates")}
        for var, key in (("TENDERS_DIR", "tenders"), ("GENERATIONS_DIR", "generations"), ("TEMPLATES_DIR", "templates")):
            os.environ[var] = str(cls.dirs[key])
        (cls.dirs["tenders"] / "inbox").mkdir(parents=True, exist_ok=True)
        for name in ("software", "non_software"):
            shutil.copy(STUDIO_DIR / "tests" / "inputs" / f"{name}.json", cls.dirs["tenders"] / "inbox")
        shutil.copy(STUDIO_DIR / "agents" / "fixtures" / "inputs" / "proposal_v2_example.json", cls.dirs["tenders"] / "inbox")
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), server.StudioHandler)
        # Own saves folder: SAVES_DIR may point to another module's temp folder, deleted when it ends
        cls.srv.saves_dir = TMP / f"{cls.__name__}_saves"
        cls.srv.saves_dir.mkdir(parents=True, exist_ok=True)
        cls.base = f"http://127.0.0.1:{cls.srv.server_address[1]}"
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def setUp(self):
        # Other test modules change these variables during the same run: set them for every test
        os.environ["STUDIO_API_KEY"] = KEY
        for var, key in (("TENDERS_DIR", "tenders"), ("GENERATIONS_DIR", "generations"), ("TEMPLATES_DIR", "templates")):
            os.environ[var] = str(self.dirs[key])

    def call(self, method, path, body=None, key=None):
        headers = {"Content-Type": "application/json"}
        if key:
            headers["X-API-Key"] = key
        req = urllib.request.Request(self.base + path, method=method, headers=headers,
                                     data=json.dumps(body).encode() if body is not None else None)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            raw = e.read() or b"{}"
            try:
                return e.code, json.loads(raw)
            except ValueError:
                return e.code, {}


class TestTenders(Base):
    def test_list_sorted_by_match_with_summaries(self):
        code, res = self.call("GET", "/api/tenders")
        self.assertEqual(code, 200)
        ids = [t["id"] for t in res["tenders"]]
        self.assertEqual(ids[0], "T1wp05cp")             # match 100 % first
        v2 = res["tenders"][0]
        self.assertEqual((v2["counts"]["requirements"], v2["counts"]["engineers"]), (10, 7))
        self.assertTrue(v2["hasResearch"])

    def test_invalid_and_oversized_files_are_error_entries(self):
        inbox = self.dirs["tenders"] / "inbox"
        (inbox / "broken.json").write_text("{not json")
        (inbox / "notitle.json").write_text(json.dumps({"tender": {"id": "X1"}}))
        (inbox / "big.json").write_text(json.dumps({"tender": {"id": "B", "title": "t"}, "pad": "x" * 1_100_000}))
        try:
            code, res = self.call("GET", "/api/tenders")
            self.assertEqual(code, 200)
            files = {e["file"] for e in res["errors"]}
            self.assertEqual(files, {"broken.json", "notitle.json", "big.json"})
        finally:
            for f in ("broken.json", "notitle.json", "big.json"):
                (inbox / f).unlink()

    def test_post_requires_key_and_traversal_is_refused(self):
        tender = {"tender": {"id": "NEW-1", "title": "Nouveau"}, "match": {}}
        self.assertEqual(self.call("POST", "/api/tenders", tender)[0], 401)
        code, res = self.call("POST", "/api/tenders", tender, KEY)
        self.assertEqual((code, res["id"]), (200, "NEW-1"))
        self.assertEqual(self.call("GET", "/api/tenders/NEW-1")[1]["tender"]["title"], "Nouveau")
        self.assertEqual(self.call("GET", "/api/tenders/..%2F..%2Fetc")[0], 404)
        self.assertEqual(self.call("DELETE", "/api/tenders/NEW-1")[0], 401)
        self.assertEqual(self.call("DELETE", "/api/tenders/NEW-1", key=KEY)[0], 200)
        self.assertEqual(self.call("GET", "/api/tenders/NEW-1")[0], 404)

    def test_file_dropped_while_running_appears_on_rescan(self):
        inbox = self.dirs["tenders"] / "inbox"
        (inbox / "late.json").write_text(json.dumps({"tender": {"id": "LATE", "title": "Tardif"}}))
        try:
            self.assertEqual(self.call("POST", "/api/tenders/rescan")[0], 200)
            self.assertIn("LATE", [t["id"] for t in self.call("GET", "/api/tenders")[1]["tenders"]])
        finally:
            (inbox / "late.json").unlink()


class TestGenerationsWebhook(Base):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.n8n = ThreadingHTTPServer(("127.0.0.1", 0), FakeN8n)
        threading.Thread(target=cls.n8n.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.n8n.shutdown()
        super().tearDownClass()

    def setUp(self):
        super().setUp()
        os.environ.update(GENERATE_MODE="webhook", GENERATE_WEBHOOK_KEY="hook-key",
                          GENERATE_WEBHOOK_URL=f"http://127.0.0.1:{self.n8n.server_address[1]}/webhook/rfp/generate")
        FakeN8n.received.clear()
        FakeN8n.status = 200
        for f in self.dirs["generations"].glob("*.json"):
            f.unlink()

    def tearDown(self):
        for k in ("GENERATE_MODE", "GENERATE_WEBHOOK_URL", "GENERATE_WEBHOOK_KEY", "GENERATE_TIMEOUT_SECONDS"):
            os.environ.pop(k, None)

    def test_202_payload_key_and_progress(self):
        code, res = self.call("POST", "/api/generations", {"tenderId": "T-2026-041", "templateId": "", "params": {"language": "en"}})
        self.assertEqual(code, 202, res)
        sent = FakeN8n.received[0]
        headers = {k.lower(): v for k, v in sent["headers"].items()}
        self.assertEqual(headers.get("x-api-key"), "hook-key")
        body = sent["body"]
        self.assertEqual((body["runId"], body["template"], body["params"]), (res["runId"], None, {"language": "en"}))
        self.assertEqual(body["tender"]["id"], "T-2026-041")             # tender JSON passed intact
        self.assertIn("match", body)
        # progress pushed by the agents (key required), terminal state kept
        path = f"/api/generations/{res['runId']}/progress"
        self.assertEqual(self.call("POST", path, {"status": "running", "step": "agent1"})[0], 401)
        self.assertEqual(self.call("POST", path, {"status": "running", "step": "agent1"}, KEY)[0], 200)
        self.assertEqual(self.call("GET", f"/api/generations/{res['runId']}")[1]["step"], "agent1")
        self.call("POST", path, {"status": "done", "deckId": "abc12345", "url": "/editor.html?id=abc12345"}, KEY)
        self.call("POST", path, {"status": "running"}, KEY)              # ignored after a terminal state
        rec = self.call("GET", f"/api/generations/{res['runId']}")[1]
        self.assertEqual((rec["status"], rec["deckId"]), ("done", "abc12345"))
        listed = self.call("GET", "/api/generations?tenderId=T-2026-041")[1]["generations"]
        self.assertEqual(listed[0]["runId"], res["runId"])

    def test_409_while_a_run_is_active(self):
        self.assertEqual(self.call("POST", "/api/generations", {"tenderId": "T-2026-041"})[0], 202)
        self.assertEqual(self.call("POST", "/api/generations", {"tenderId": "T1wp05cp"})[0], 409)

    def test_503_unconfigured_502_unreachable_400_bad_params(self):
        os.environ.pop("GENERATE_WEBHOOK_URL")
        self.assertEqual(self.call("POST", "/api/generations", {"tenderId": "T-2026-041"})[0], 503)
        os.environ["GENERATE_WEBHOOK_URL"] = "http://127.0.0.1:9/nothing"
        code, res = self.call("POST", "/api/generations", {"tenderId": "T-2026-041"})
        self.assertEqual(code, 502)
        self.assertEqual(self.call("GET", f"/api/generations/{res['runId']}")[1]["status"], "failed")
        self.assertEqual(self.call("POST", "/api/generations", {"tenderId": "T-2026-041", "params": {"color": "red"}})[0], 400)
        self.assertEqual(self.call("POST", "/api/generations", {"tenderId": "T-2026-041", "params": {"qr_url": "javascript:x"}})[0], 400)
        self.assertEqual(self.call("POST", "/api/generations", {"tenderId": "missing"})[0], 404)
        self.assertEqual(self.call("POST", "/api/generations", {"tenderId": "T-2026-041", "templateId": "nope"})[0], 400)

    def test_timeout_marks_the_run_failed(self):
        code, res = self.call("POST", "/api/generations", {"tenderId": "T-2026-041"})
        os.environ["GENERATE_TIMEOUT_SECONDS"] = "0"
        time.sleep(0.05)
        rec = self.call("GET", f"/api/generations/{res['runId']}")[1]
        self.assertEqual((rec["status"], rec["error"]), ("failed", "timeout"))


class TestGenerationCli(Base):
    """GENERATE_MODE=cli runs the real agent chain (mock LLM) with Node and pushes progress."""

    def setUp(self):
        super().setUp()
        os.environ.update(GENERATE_MODE="cli", LLM_MODE="mock", AGENTS_REGISTRY_DIR=str(TMP / "registry"))

    def tearDown(self):
        for k in ("GENERATE_MODE", "LLM_MODE"):
            os.environ.pop(k, None)

    def test_full_run_creates_a_deck(self):
        if not shutil.which("node"):
            self.skipTest("node not installed")
        code, res = self.call("POST", "/api/generations",
                              {"tenderId": "T-2026-041", "templateId": "", "params": {"deckName": "Deck CLI"}})
        self.assertEqual(code, 202, res)
        t0, rec = time.time(), {}
        while time.time() - t0 < 90:
            rec = self.call("GET", f"/api/generations/{res['runId']}")[1]
            if rec["status"] in ("done", "failed"):
                break
            time.sleep(0.5)
        self.assertEqual(rec["status"], "done", rec)
        self.assertEqual([s["status"] for s in rec["steps"]], ["done"] * 6)
        deck = self.call("GET", f"/api/decks/{rec['deckId']}", key=KEY)[1]
        self.assertEqual(deck["name"], "Deck CLI")
        self.assertEqual(len(deck["slides"]), 16)   # 12 content slides + 2 continuations (compliance table, 4 rows per slide) + title + thank-you


class TestMainScreen(Base):
    @_runtime.slow
    def test_sections_inspect_escape_and_generate_flow(self):
        from playwright.sync_api import sync_playwright
        inbox = self.dirs["tenders"] / "inbox"
        hostile = {"tender": {"id": "XSS-1", "title": "<script>window.__pwned=1</script>Titre", "client": "C"}, "match": {"score": 0.5}}
        (inbox / "xss.json").write_text(json.dumps(hostile))
        os.environ.update(GENERATE_MODE="cli", LLM_MODE="mock", AGENTS_REGISTRY_DIR=str(TMP / "registry"))
        try:
            with sync_playwright() as pw:
                b = pw.chromium.launch()
                pg = b.new_page(viewport={"width": 1400, "height": 900})
                pg.goto(self.base + "/")
                pg.wait_for_selector(".tender-card")
                for gone in ("#card-opt-upload", "#card-opt-blank", "#card-opt-theme", "#btn-create-rfp", "#rfp-name-input"):
                    self.assertIsNone(pg.query_selector(gone), gone)
                for section in ("#tenders-section", "#saved-section", "#templates-section"):
                    self.assertIsNotNone(pg.query_selector(section))
                self.assertTrue(pg.is_visible("#template-empty"))     # no templates in this folder
                titles = pg.eval_on_selector_all(".tender-title", "els => els.map(e => e.textContent)")
                self.assertEqual(titles[0], "Développement d'une plateforme numérique de gestion des licences touristiques")
                self.assertIn("<script>window.__pwned=1</script>Titre", titles)
                self.assertIsNone(pg.evaluate("window.__pwned"))
                pg.fill("#tender-search", "portail citoyen")
                self.assertEqual(len(pg.query_selector_all(".tender-card")), 1)
                pg.fill("#tender-search", "")
                pg.click("[data-inspect='T1wp05cp']")
                body = pg.inner_text("#inspect-body").lower()   # headings are shown in capitals by CSS
                for part in ("exigences et couverture", "équipe (cv)", "concurrence et budget"):
                    self.assertIn(part, body)
                pg.click("#inspect-modal [data-close]")
                pg.click("[data-generate='T-2026-041']")
                self.assertFalse(pg.is_visible("#gen-competitor-field"))   # no research in this tender
                pg.click("#btn-gen-start")
                pg.wait_for_selector("#btn-progress-open", state="visible", timeout=90000)
                self.assertIn("Deck prêt", pg.inner_text("#progress-title"))
                pg.reload()
                pg.wait_for_selector(".badge.ok")                    # finished run kept after reload
                b.close()
        finally:
            (inbox / "xss.json").unlink()
            for k in ("GENERATE_MODE", "LLM_MODE"):
                os.environ.pop(k, None)


if __name__ == "__main__":
    unittest.main()
