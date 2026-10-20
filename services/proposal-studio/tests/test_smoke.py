import os
import sys
import json
import time
import urllib.request
import shutil
import tempfile
import unittest
import threading
from pathlib import Path

# Use temporary SAVES_DIR
TEST_TEMP_DIR = tempfile.mkdtemp(prefix="rfp_smoke_saves_")
os.environ["SAVES_DIR"] = TEST_TEMP_DIR

STUDIO_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(STUDIO_DIR))

import server
sys.path.insert(0, str(Path(__file__).resolve().parent))
import _runtime

_runtime.isolate(server)

from playwright.sync_api import sync_playwright


class TestBrowserSmoke(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp_dir = Path(TEST_TEMP_DIR)
        cls.server = server.ThreadingHTTPServer(("127.0.0.1", 0), server.StudioHandler)
        cls.server.saves_dir = cls.temp_dir
        cls.port = cls.server.server_address[1]
        cls.base_url = f"http://127.0.0.1:{cls.port}"
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

    @_runtime.slow
    def test_acceptance_flow(self):
        """Open editor, add elements (title text, table, bullets, cards), edit, save, reload, export to PDF."""
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1920, "height": 1080})

            # 1. Open editor
            page.goto(f"{self.base_url}/editor.html")
            page.wait_for_selector("#slide-canvas")

            # 2. Add elements from drawer
            page.click('[data-panel="panel-elements"]')
            page.wait_for_selector("#add-element-bullets")

            # Add Bullets
            page.click("#add-element-bullets")
            page.wait_for_timeout(300)

            # Add Table
            page.click("#add-element-table")
            page.wait_for_timeout(300)

            # Add 3 Cards
            for _ in range(3):
                page.click("#add-element-card")
                page.wait_for_timeout(200)

            # Verify elements are on canvas
            canvas_elements = page.query_selector_all(".canvas-element")
            self.assertGreaterEqual(len(canvas_elements), 5)

            # 3. Save manually
            page.click("#btn-manual-save")
            page.wait_for_timeout(500)

            # 4. Reload page
            page.reload()
            page.wait_for_selector("#slide-canvas")
            page.wait_for_timeout(500)

            reloaded_elements = page.query_selector_all(".canvas-element")
            self.assertGreaterEqual(len(reloaded_elements), 5)

            # 5. Export to PDF
            page.click("#btn-export-dropdown")
            page.wait_for_selector("#btn-export-pdf")
            page.click("#btn-export-pdf")

            # Wait for export modal completion
            page.wait_for_selector("#modal-download", timeout=20000)
            download_btn = page.query_selector("#modal-download")
            pdf_url = download_btn.get_attribute("href")
            self.assertTrue(pdf_url and pdf_url.endswith(".pdf"))

            # Check that exported PDF file exists and is not empty
            pdf_rel = pdf_url.replace("/exports/", "")
            exported_file = server.EXPORTS_DIR / pdf_rel
            self.assertTrue(exported_file.exists())
            self.assertGreater(exported_file.stat().st_size, 1000)

            browser.close()


    @_runtime.slow
    def test_end_to_end_flow(self):
        """Create an RFP, add every element type, import a sample deck through POST /api/decks,
        open the review panel, export PDF and PPTX, reload and check the project is unchanged."""
        key = os.environ.get("STUDIO_API_KEY")
        png = _runtime.RUNTIME_DIR / "smoke_logo.png"
        from PIL import Image
        Image.new("RGB", (64, 64), (99, 102, 241)).save(png)

        def api(method, path, payload=None):
            req = urllib.request.Request(f"{self.base_url}{path}", method=method,
                                         data=json.dumps(payload).encode("utf-8") if payload is not None else None)
            req.add_header("Content-Type", "application/json")
            if key:
                req.add_header("X-API-Key", key)
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))

        def export(page, fmt):
            page.click("#btn-export-dropdown")
            page.click(f"#btn-export-{fmt}")
            page.wait_for_timeout(300)
            if page.is_visible("#modal-export-anyway-btn"):
                page.click("#modal-export-anyway-btn")
            page.wait_for_selector("#modal-download", state="visible", timeout=60000)
            url = page.get_attribute("#modal-download", "href")
            self.assertTrue(url.endswith(f".{fmt}"), url)
            out = server.EXPORTS_DIR / url.replace("/exports/", "")
            self.assertGreater(out.stat().st_size, 1000)
            page.click("#modal-close-btn")
            page.wait_for_timeout(200)

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1920, "height": 1080})
            page.on("dialog", lambda d: d.accept("https://www.youtube.com/watch?v=dQw4w9WgXcQ"))

            # 1. Create an RFP (the start cards were replaced by tenders: decks come from POST /api/decks)
            created = api("POST", "/api/decks", {"name": "Smoke RFP", "slides": [{"type": "content", "title": "Vide", "blocks": []}]})
            page.goto(f"{self.base_url}/editor.html?id={created['id']}")
            page.wait_for_function("typeof switchToSlide === 'function' && project.slides.length === 3")
            page.evaluate("switchToSlide(1)")

            # 2. Add one element of each type
            page.click('[data-panel="panel-elements"]')
            for btn in ("#add-text-heading", "#add-shape-rect", "#add-element-bullets",
                        "#add-element-table", "#add-element-card"):
                page.click(btn)
                page.wait_for_timeout(150)
            page.click('[data-panel="panel-uploads"]')
            page.set_input_files("#media-file-input", str(png))
            page.wait_for_function("project.slides[project.activeSlideIndex].elements"
                                   ".some(e => e.type === 'image')", timeout=10000)
            page.click("#add-video-btn")
            page.wait_for_timeout(200)
            types = set(page.evaluate("engine.elements ? engine.elements.map(e => e.type) : "
                                      "project.slides[project.activeSlideIndex].elements.map(e => e.type)"))
            self.assertTrue({"text", "shape", "bullets", "table", "card", "image", "video"} <= types, types)
            page.click("#btn-manual-save")
            page.wait_for_function("!!project.id", timeout=10000)
            rfp_id = page.evaluate("project.id")
            saved = api("GET", f"/api/save/{rfp_id}")
            self.assertEqual(saved["name"], "Smoke RFP")

            # 3. Import a sample deck through the API and open it
            spec = json.loads((STUDIO_DIR / "samples" / "thin.json").read_text(encoding="utf-8"))
            deck_id = api("POST", "/api/decks", spec)["id"]
            page.goto(f"{self.base_url}/editor.html?id={deck_id}")
            page.wait_for_selector("#slide-canvas")
            page.wait_for_timeout(500)

            # 4. Review panel lists the placeholders of the thin sample
            page.click('[data-panel="panel-review"]')
            page.wait_for_selector("#review-list")
            self.assertIn("TO FILL", page.inner_text("#review-list"))

            # 5. Save, export PDF and PPTX
            page.click("#btn-manual-save")
            page.wait_for_timeout(500)
            before = api("GET", f"/api/save/{deck_id}")
            export(page, "pdf")
            export(page, "pptx")

            # 6. Reload: the project is unchanged
            page.goto(f"{self.base_url}/editor.html?id={deck_id}")
            page.wait_for_selector("#slide-canvas")
            page.wait_for_timeout(500)
            self.assertEqual(page.evaluate("project.slides.length"), len(before["slides"]))
            after = api("GET", f"/api/save/{deck_id}")
            self.assertEqual(after["slides"], before["slides"])
            self.assertEqual(after["name"], before["name"])

            browser.close()


if __name__ == "__main__":
    unittest.main()
