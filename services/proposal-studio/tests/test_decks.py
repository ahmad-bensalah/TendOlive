import os
import sys
import time
import json
import shutil
import tempfile
import unittest
import threading
import urllib.request
import urllib.error
from pathlib import Path

TEST_TEMP_DIR = tempfile.mkdtemp(prefix="rfp_decks_test_")
os.environ["SAVES_DIR"] = TEST_TEMP_DIR
os.environ["STUDIO_API_KEY"] = "secret-test-key-12345"

STUDIO_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(STUDIO_DIR))

import server
sys.path.insert(0, str(Path(__file__).resolve().parent))
import _runtime

_runtime.isolate(server)
import layout_engine
from playwright.sync_api import sync_playwright


class TestDecksAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp_dir = Path(TEST_TEMP_DIR)
        cls.server = server.ThreadingHTTPServer(("127.0.0.1", 0), server.StudioHandler)
        cls.server.saves_dir = cls.temp_dir
        cls.port = cls.server.server_address[1]
        cls.base_url = f"http://127.0.0.1:{cls.port}"
        cls.api_key = "secret-test-key-12345"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        try:
            cls.server.shutdown()
            cls.server.server_close()
        except Exception:
            pass
        shutil.rmtree(TEST_TEMP_DIR, ignore_errors=True)

    def _post_json(self, path: str, payload: dict, api_key: str = None) -> tuple[int, dict]:
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(f"{self.base_url}{path}", data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        if api_key is not None:
            req.add_header("X-API-Key", api_key)
        try:
            with urllib.request.urlopen(req) as resp:
                code = resp.getcode()
                body = json.loads(resp.read().decode("utf-8"))
                return code, body
        except urllib.error.HTTPError as e:
            body = json.loads(e.read().decode("utf-8"))
            return e.code, body

    def _get_json(self, path: str, api_key: str = None) -> tuple[int, dict]:
        req = urllib.request.Request(f"{self.base_url}{path}", method="GET")
        if api_key is not None:
            req.add_header("X-API-Key", api_key)
        try:
            with urllib.request.urlopen(req) as resp:
                code = resp.getcode()
                body = json.loads(resp.read().decode("utf-8"))
                return code, body
        except urllib.error.HTTPError as e:
            body = json.loads(e.read().decode("utf-8"))
            return e.code, body

    def test_auth_rejection_and_success(self):
        sample = json.loads((STUDIO_DIR / "samples" / "software.json").read_text(encoding="utf-8"))

        # Bad key -> 401
        code, res = self._post_json("/api/decks", sample, api_key="wrong-key")
        self.assertEqual(code, 401)
        self.assertIn("error", res.get("status", "") or res.get("message", ""))

        # Missing key -> 401 (when STUDIO_API_KEY env is set)
        code, res = self._post_json("/api/decks", sample)
        self.assertEqual(code, 401)

        # Good key -> 200
        code, res = self._post_json("/api/decks", sample, api_key=self.api_key)
        self.assertEqual(code, 200)
        self.assertIn("id", res)
        self.assertIn("url", res)
        self.assertTrue(res["url"].startswith("/editor.html?id="))

    def test_schema_validation_rejection(self):
        # Missing name -> 400
        bad_sample = {"slides": [{"type": "content", "title": "T", "blocks": []}]}
        code, res = self._post_json("/api/decks", bad_sample, api_key=self.api_key)
        self.assertEqual(code, 400)

        # Unknown field on deck top-level -> 400 listing allowed fields
        unknown_top_field = {
            "name": "Test",
            "slides": [{"type": "content", "title": "Title", "blocks": []}],
            "unexpectedExtraField": 123
        }
        code, res = self._post_json("/api/decks", unknown_top_field, api_key=self.api_key)
        self.assertEqual(code, 400)
        self.assertIn("errors", res)
        self.assertTrue(any("unexpectedExtraField" in err and "Allowed deck fields" in err for err in res["errors"]))

        # Unknown field on slide level -> 400 listing allowed slide fields
        unknown_slide_field = {
            "name": "Test",
            "slides": [{
                "type": "content",
                "title": "Title",
                "blocks": [],
                "rogueSlideProperty": "forbidden"
            }]
        }
        code, res = self._post_json("/api/decks", unknown_slide_field, api_key=self.api_key)
        self.assertEqual(code, 400)
        self.assertIn("errors", res)
        self.assertTrue(any("rogueSlideProperty" in err and "Allowed slide fields" in err for err in res["errors"]))

        # Unknown block kind -> 400
        unknown_block = {
            "name": "Test",
            "slides": [{
                "type": "content",
                "title": "Title",
                "blocks": [{"kind": "unsupported_kind", "foo": "bar"}]
            }]
        }
        code, res = self._post_json("/api/decks", unknown_block, api_key=self.api_key)
        self.assertEqual(code, 400)
        self.assertIn("errors", res)

    def test_warnings_and_requires_approval_roundtrip(self):
        deck_spec = {
            "name": "Deck With Approvals",
            "slides": [
                {
                    "type": "content",
                    "title": "Slide d'Architecture Sensible",
                    "requiresApproval": True,
                    "warnings": ["Besoin de confirmation RSSI", "Données RH chiffrées"],
                    "blocks": [
                        {"kind": "text", "text": "Architecture sous conditions d'homologation."}
                    ]
                }
            ]
        }
        code, res = self._post_json("/api/decks", deck_spec, api_key=self.api_key)
        self.assertEqual(code, 200)
        deck_id = res["id"]

        code, deck = self._get_json(f"/api/decks/{deck_id}", api_key=self.api_key)
        self.assertEqual(code, 200)
        content_slide = next(s for s in deck["slides"] if s.get("type") == "content")
        self.assertTrue(content_slide.get("requiresApproval"))
        self.assertEqual(content_slide.get("warnings"), ["Besoin de confirmation RSSI", "Données RH chiffrées"])


    def test_all_samples_post_and_layout(self):
        samples = ["software.json", "non_software.json", "thin.json"]
        for s_name in samples:
            data = json.loads((STUDIO_DIR / "samples" / s_name).read_text(encoding="utf-8"))
            code, res = self._post_json("/api/decks", data, api_key=self.api_key)
            self.assertEqual(code, 200, f"Failed posting {s_name}: {res}")
            deck_id = res["id"]

            # GET /api/decks/<id>
            code, deck = self._get_json(f"/api/decks/{deck_id}", api_key=self.api_key)
            self.assertEqual(code, 200)

            # Check that every element is within 1920x1080 canvas
            # And verify no two text-bearing elements overlap vertically in content area
            for slide in deck["slides"]:
                els = slide.get("elements", [])
                for el in els:
                    self.assertGreaterEqual(el["x"], 0)
                    self.assertGreaterEqual(el["y"], 0)
                    self.assertLessEqual(el["x"] + el["width"], 1920)
                    self.assertLessEqual(el["y"] + el["height"], 1080)

                # Check text-bearing non-overlap on content slides
                if slide.get("type") == "content":
                    text_els = [e for e in els if e.get("type") in ("text", "bullets", "table", "card")]
                    # Check for any bounding box collision where both x and y overlap
                    for i in range(len(text_els)):
                        for j in range(i + 1, len(text_els)):
                            e1, e2 = text_els[i], text_els[j]
                            x_overlap = not (e1["x"] + e1["width"] <= e2["x"] or e2["x"] + e2["width"] <= e1["x"])
                            y_overlap = not (e1["y"] + e1["height"] <= e2["y"] or e2["y"] + e2["height"] <= e1["y"])
                            self.assertFalse(x_overlap and y_overlap, f"Overlap detected between {e1['id']} and {e2['id']} on slide {slide.get('label')}")

    def test_slide_replacement(self):
        sample = json.loads((STUDIO_DIR / "samples" / "software.json").read_text(encoding="utf-8"))
        code, res = self._post_json("/api/decks", sample, api_key=self.api_key)
        self.assertEqual(code, 200)
        deck_id = res["id"]

        # Replace slide 1
        replacement = {
            "type": "content",
            "title": "Architecture Régénérée Spéciale",
            "blocks": [
                {"kind": "text", "text": "Nouveau contenu généré par l'agent IA."},
                {"kind": "bullets", "items": ["Jalon 1 atteint", "Jalon 2 validé"]}
            ]
        }
        code, rep_res = self._post_json(f"/api/decks/{deck_id}/slides/1", replacement, api_key=self.api_key)
        self.assertEqual(code, 200)
        self.assertEqual(rep_res["slideIndex"], 1)

        # Verify only slide 1 changed
        code, updated_deck = self._get_json(f"/api/decks/{deck_id}", api_key=self.api_key)
        self.assertEqual(code, 200)
        title_el = next(e for e in updated_deck["slides"][1]["elements"] if e.get("type") == "text")
        self.assertEqual(title_el["content"], "Architecture Régénérée Spéciale")
        self.assertEqual(updated_deck["slides"][0]["type"], "title")

    def test_40_row_table_splits_into_multiple_slides(self):
        rows = [[f"Critère {i}", f"Exigence {i}", f"Réponse {i}"] for i in range(1, 41)]
        deck_with_huge_table = {
            "name": "Deck Matrice Complète",
            "client": "Client Test",
            "slides": [
                {
                    "type": "content",
                    "title": "Matrice Exhaustive",
                    "blocks": [
                        {
                            "kind": "table",
                            "columns": ["Réf", "Exigence", "Engagement"],
                            "rows": rows
                        }
                    ]
                }
            ]
        }
        code, res = self._post_json("/api/decks", deck_with_huge_table, api_key=self.api_key)
        self.assertEqual(code, 200)
        deck_id = res["id"]

        code, deck = self._get_json(f"/api/decks/{deck_id}", api_key=self.api_key)
        self.assertEqual(code, 200)
        # Title + 4 table slides (10 rows each) + Thank-you = 6 slides
        self.assertEqual(len(deck["slides"]), 6)
        content_slides = [s for s in deck["slides"] if s.get("type") == "content"]
        self.assertEqual(len(content_slides), 4)
        for i, cs in enumerate(content_slides):
            self.assertIn(f"({i+1}/4)", cs["label"])
            # Each slide repeats header columns
            table_el = next(e for e in cs["elements"] if e.get("type") == "table")
            self.assertEqual(table_el["columns"], ["Réf", "Exigence", "Engagement"])
            self.assertLessEqual(len(table_el["rows"]), 10)


    @_runtime.slow
    def test_playwright_screenshots_and_pdf_export(self):
        """Open each sample deck in the editor with Playwright, screenshot each slide, and export a PDF."""
        screenshots_dir = _runtime.RUNTIME_DIR / "screenshots"
        screenshots_dir.mkdir(exist_ok=True)

        samples = ["software.json", "non_software.json", "thin.json"]
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1920, "height": 1080})

            for s_name in samples:
                data = json.loads((STUDIO_DIR / "samples" / s_name).read_text(encoding="utf-8"))
                code, res = self._post_json("/api/decks", data, api_key=self.api_key)
                self.assertEqual(code, 200)
                deck_id = res["id"]

                # Open deck URL in editor
                page.goto(f"{self.base_url}/editor.html?id={deck_id}")
                page.wait_for_selector("#slide-canvas")
                page.wait_for_timeout(600)

                # Get slide count
                slide_count = page.evaluate("project.slides.length")
                self.assertGreaterEqual(slide_count, 3)

                sample_base = Path(s_name).stem
                # Screenshot each slide
                for s_idx in range(slide_count):
                    page.evaluate(f"switchToSlide({s_idx})")
                    page.wait_for_timeout(300)
                    canvas = page.query_selector("#slide-canvas")
                    img_path = screenshots_dir / f"{sample_base}_slide_{s_idx + 1}.png"
                    canvas.screenshot(path=str(img_path))
                    self.assertTrue(img_path.exists() and img_path.stat().st_size > 1000)

                # Export to PDF and verify
                page.click("#btn-export-dropdown")
                page.wait_for_selector("#btn-export-pdf")
                page.click("#btn-export-pdf")

                # If gating appeared (e.g. for thin.json with placeholders), click "Exporter quand même"
                page.wait_for_timeout(300)
                if page.is_visible("#modal-export-anyway-btn"):
                    page.click("#modal-export-anyway-btn")

                page.wait_for_selector("#modal-download", timeout=25000)
                download_btn = page.query_selector("#modal-download")
                pdf_url = download_btn.get_attribute("href")
                self.assertTrue(pdf_url and pdf_url.endswith(".pdf"))

                pdf_rel = pdf_url.replace("/exports/", "")
                pdf_file = server.EXPORTS_DIR / pdf_rel
                self.assertTrue(pdf_file.exists())
                self.assertGreater(pdf_file.stat().st_size, 10000)

                # Close modal
                page.click("#modal-close-btn")
                page.wait_for_timeout(300)

            browser.close()


if __name__ == "__main__":
    unittest.main()

