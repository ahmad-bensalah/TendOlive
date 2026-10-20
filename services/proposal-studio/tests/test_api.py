"""tests/test_api.py — HTTP API checks: auth, regenerate guards, save ids, theme extraction, export.

Runs server.py in-process on a random port. Saves, uploads and exports go to temporary
folders (see tests/_runtime.py), so nothing is written into the project.
"""
import io
import json
import os
import shutil
import sys
import tempfile
import threading
import types
import unittest
import urllib.error
import urllib.request
import uuid
from pathlib import Path

TEST_TEMP_DIR = tempfile.mkdtemp(prefix="rfp_api_test_")
os.environ["SAVES_DIR"] = TEST_TEMP_DIR

STUDIO_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(STUDIO_DIR))

import server
sys.path.insert(0, str(Path(__file__).resolve().parent))
import _runtime

_runtime.isolate(server)

ENV_VARS = ("STUDIO_API_KEY", "REGENERATE_WEBHOOK_URL", "REGENERATE_WEBHOOK_KEY")
SAMPLE = json.loads((STUDIO_DIR / "samples" / "non_software.json").read_text(encoding="utf-8"))


class ApiTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp_dir = Path(TEST_TEMP_DIR)
        cls.server = server.ThreadingHTTPServer(("127.0.0.1", 0), server.StudioHandler)
        cls.server.saves_dir = cls.temp_dir
        cls.base_url = f"http://127.0.0.1:{cls.server.server_address[1]}"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        shutil.rmtree(TEST_TEMP_DIR, ignore_errors=True)

    def setUp(self):
        # Each test sets the env vars it needs; restore the outer values afterwards.
        self._saved_env = {k: os.environ.get(k) for k in ENV_VARS}
        for k in ENV_VARS:
            os.environ.pop(k, None)

    def tearDown(self):
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def request(self, method, path, payload=None, headers=None, raw=None):
        data = raw if raw is not None else (json.dumps(payload).encode("utf-8") if payload is not None else None)
        req = urllib.request.Request(f"{self.base_url}{path}", data=data, method=method)
        if payload is not None:
            req.add_header("Content-Type", "application/json")
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.getcode(), resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def json_request(self, method, path, payload=None, headers=None, raw=None):
        code, body = self.request(method, path, payload, headers, raw)
        return code, json.loads(body.decode("utf-8"))

    def create_deck(self):
        code, res = self.json_request("POST", "/api/decks", SAMPLE)
        self.assertEqual(code, 200, res)
        return res["id"]


class TestAuth(ApiTestCase):
    def test_key_set_missing_or_wrong_key_returns_401(self):
        os.environ["STUDIO_API_KEY"] = "api-test-key"
        for headers in ({}, {"X-API-Key": "wrong"}):
            code, res = self.json_request("POST", "/api/decks", SAMPLE, headers)
            self.assertEqual(code, 401)
            self.assertIn("Unauthorized", res["message"])

    def test_key_set_correct_key_returns_200(self):
        os.environ["STUDIO_API_KEY"] = "api-test-key"
        code, res = self.json_request("POST", "/api/decks", SAMPLE, {"X-API-Key": "api-test-key"})
        self.assertEqual(code, 200)
        self.assertEqual(res["url"], f"/editor.html?id={res['id']}")

    def test_all_deck_endpoints_require_the_key(self):
        deck_id = self.create_deck()  # no key set yet: localhost allowed
        os.environ["STUDIO_API_KEY"] = "api-test-key"
        slide = {"type": "content", "title": "New", "blocks": [{"kind": "text", "text": "x"}]}
        self.assertEqual(self.request("GET", f"/api/decks/{deck_id}")[0], 401)
        self.assertEqual(self.request("POST", f"/api/decks/{deck_id}/slides/1", slide)[0], 401)
        self.assertEqual(self.request("GET", f"/api/decks/{deck_id}", headers={"X-API-Key": "api-test-key"})[0], 200)

    def test_key_unset_localhost_is_accepted(self):
        self.assertEqual(self.json_request("POST", "/api/decks", SAMPLE)[0], 200)

    def test_key_unset_other_hosts_are_rejected(self):
        for ip, allowed in (("127.0.0.1", True), ("::1", True), ("10.0.0.5", False), ("192.168.1.20", False)):
            fake = types.SimpleNamespace(client_address=(ip, 50000), headers={})
            self.assertEqual(server.StudioHandler._check_api_auth(fake), allowed, ip)

    def test_editor_save_endpoints_need_no_key(self):
        os.environ["STUDIO_API_KEY"] = "api-test-key"
        code, res = self.json_request("POST", "/api/save", {"id": None, "name": "p", "slides": []})
        self.assertEqual(code, 200)
        self.assertEqual(self.request("GET", f"/api/save/{res['id']}")[0], 200)


class TestDeckErrors(ApiTestCase):
    def test_malformed_json_returns_400(self):
        code, res = self.json_request("POST", "/api/decks", raw=b"{not json",
                                      headers={"Content-Type": "application/json"})
        self.assertEqual(code, 400)
        self.assertIn("Malformed JSON", res["message"])

    def test_unknown_field_returns_400_with_allowed_fields(self):
        code, res = self.json_request("POST", "/api/decks", dict(SAMPLE, author="me"))
        self.assertEqual(code, 400)
        self.assertEqual(res["message"], "Validation failed against schema")
        self.assertIn("Allowed deck fields are", res["errors"][0])

    def test_unknown_deck_returns_404(self):
        self.assertEqual(self.request("GET", "/api/decks/doesnotexist")[0], 404)


class TestRegenerate(ApiTestCase):
    def test_without_webhook_returns_503(self):
        deck_id = self.create_deck()
        code, res = self.json_request("POST", f"/api/decks/{deck_id}/slides/1/regenerate", {})
        self.assertEqual(code, 503)
        self.assertEqual(res["message"], "Regeneration webhook is not configured")
        self.assertEqual(self.json_request("GET", "/api/config")[1], {"hasRegenerate": False})

    def test_fixed_slides_return_400(self):
        os.environ["REGENERATE_WEBHOOK_URL"] = "http://127.0.0.1:9/never-called"
        deck_id = self.create_deck()
        slide_count = len(json.loads((self.temp_dir / f"{deck_id}.json").read_text(encoding="utf-8"))["slides"])
        for idx in (0, slide_count - 1):
            code, res = self.json_request("POST", f"/api/decks/{deck_id}/slides/{idx}/regenerate", {})
            self.assertEqual(code, 400, idx)
            self.assertEqual(res["message"], "fixed slides cannot be regenerated")
        code, _ = self.json_request("POST", f"/api/decks/{deck_id}/slides/{slide_count}/regenerate", {})
        self.assertEqual(code, 400)

    def test_non_http_webhook_is_refused(self):
        os.environ["REGENERATE_WEBHOOK_URL"] = "file:///etc/passwd"
        deck_id = self.create_deck()
        code, res = self.json_request("POST", f"/api/decks/{deck_id}/slides/1/regenerate", {})
        self.assertEqual(code, 400)
        self.assertEqual(res["message"], "Invalid webhook protocol")


class TestSaveIds(ApiTestCase):
    def test_invalid_ids_are_rejected(self):
        for bad in ("../x", "a/b", "a" * 65, "x y", "é"):
            with self.subTest(id=bad):
                code, _ = self.json_request("POST", "/api/save", {"id": bad, "name": "p", "slides": []})
                self.assertEqual(code, 400)

    def test_invalid_ids_cannot_be_read(self):
        for path in ("/api/save/..%2Fsecret", "/api/save/a%20b", "/api/decks/..%2Fx"):
            with self.subTest(path=path):
                self.assertIn(self.request("GET", path)[0], (400, 403, 404))

    def test_placeholder_ids_create_new_projects(self):
        ids = set()
        for placeholder in (None, "", "None", "null", "undefined"):
            code, res = self.json_request("POST", "/api/save", {"id": placeholder, "name": "p", "slides": []})
            self.assertEqual(code, 200)
            self.assertRegex(res["id"], r"^[0-9a-f]{8}$")
            ids.add(res["id"])
        self.assertEqual(len(ids), 5)
        self.assertFalse((self.temp_dir / "None.json").exists())


def multipart(filename, data, content_type="application/octet-stream"):
    boundary = uuid.uuid4().hex
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n"
            f"Content-Type: {content_type}\r\n\r\n").encode("utf-8") + data + f"\r\n--{boundary}--\r\n".encode("utf-8")
    return body, {"Content-Type": f"multipart/form-data; boundary={boundary}"}


class TestThemeAndUploads(ApiTestCase):
    def test_extract_theme_from_pdf_over_http(self):
        import pymupdf
        doc = pymupdf.open()
        page = doc.new_page(width=600, height=400)
        page.draw_rect(page.rect, color=None, fill=(0.06, 0.09, 0.16))
        page.insert_text((40, 80), "Brand title", fontsize=32, color=(1, 1, 1))
        body, headers = multipart("brand.pdf", doc.tobytes(), "application/pdf")
        code, res = self.json_request("POST", "/api/extract-theme", raw=body, headers=headers)
        self.assertEqual(code, 200, res)
        theme = res["theme"]
        self.assertTrue(theme["approximate"])
        self.assertRegex(theme["background"]["color"], r"^#[0-9a-f]{6}$")
        self.assertIn("primary", theme["palette"])

    def test_corrupt_pdf_returns_clean_error(self):
        body, headers = multipart("broken.pdf", b"%PDF-1.4 this is not a real pdf")
        code, res = self.json_request("POST", "/api/extract-theme", raw=body, headers=headers)
        self.assertEqual(code, 400)
        self.assertEqual(res["status"], "error")

    def test_upload_goes_to_uploads_and_rejects_bad_extension(self):
        body, headers = multipart("logo.svg", b'<svg xmlns="http://www.w3.org/2000/svg"/>', "image/svg+xml")
        code, res = self.json_request("POST", "/api/upload", raw=body, headers=headers)
        self.assertEqual(code, 200, res)
        stored = server.UPLOADS / Path(res["url"]).name
        self.assertTrue(stored.exists())
        self.assertFalse((STUDIO_DIR / "uploads" / stored.name).exists(), "test must not write the real uploads/")
        body, headers = multipart("run.exe", b"MZ")
        self.assertEqual(self.json_request("POST", "/api/upload", raw=body, headers=headers)[0], 400)


class TestExportEndpoint(ApiTestCase):
    def test_pptx_export_through_api(self):
        from pptx import Presentation
        deck_id = self.create_deck()
        project = json.loads((self.temp_dir / f"{deck_id}.json").read_text(encoding="utf-8"))
        payload = {"format": "pptx", "html": "<html><body></body></html>",
                   "slideCount": len(project["slides"]), "project": project}
        code, res = self.json_request("POST", "/api/export", payload)
        self.assertEqual(code, 200, res)
        out = server.EXPORTS_DIR / res["url"].replace("/exports/", "")
        self.assertTrue(out.exists())
        prs = Presentation(io.BytesIO(out.read_bytes()))
        self.assertEqual(len(prs.slides), len(project["slides"]))

    def test_export_rejects_bad_format_and_empty_html(self):
        self.assertEqual(self.json_request("POST", "/api/export", {"format": "docx", "html": "x"})[0], 400)
        self.assertEqual(self.json_request("POST", "/api/export", {"format": "pdf", "html": ""})[0], 400)


class TestExportTool(ApiTestCase):
    @_runtime.slow
    def test_export_deck_tool_exports_and_respects_the_gate(self):
        import subprocess
        tool = STUDIO_DIR / "tools" / "export_deck.py"

        def run(deck_id, fmt, *extra):
            out = _runtime.RUNTIME_DIR / f"tool_{deck_id}.{fmt}"
            proc = subprocess.run([sys.executable, str(tool), deck_id, fmt, "--base-url", self.base_url,
                                   "--out", str(out), *extra], capture_output=True, text=True, timeout=120)
            return proc.returncode, proc.stdout + proc.stderr, out

        clean_id = self.create_deck()
        for fmt in ("pdf", "pptx"):
            code, output, out = run(clean_id, fmt)
            self.assertEqual(code, 0, output)
            self.assertGreater(out.stat().st_size, 1000)

        spec = json.loads((STUDIO_DIR / "samples" / "thin.json").read_text(encoding="utf-8"))
        thin_id = self.json_request("POST", "/api/decks", spec)[1]["id"]
        code, output, _ = run(thin_id, "pdf")
        self.assertEqual(code, 2, output)
        self.assertIn("GATED", output)
        code, output, out = run(thin_id, "pdf", "--force")
        self.assertEqual(code, 0, output)
        self.assertTrue(out.exists())

        code, output, _ = run("doesnotexist", "pdf")
        self.assertEqual(code, 1, output)


if __name__ == "__main__":
    unittest.main()
