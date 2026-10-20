import os
import sys
import time
import shutil
import tempfile
import unittest
import threading
from pathlib import Path

TEST_TEMP_DIR = tempfile.mkdtemp(prefix="rfp_render_test_")
os.environ["SAVES_DIR"] = TEST_TEMP_DIR

STUDIO_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(STUDIO_DIR))

import server
sys.path.insert(0, str(Path(__file__).resolve().parent))
import _runtime

_runtime.isolate(server)
from playwright.sync_api import sync_playwright


class TestUnifiedRenderer(unittest.TestCase):
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
    def test_unified_renderer_all_element_types(self):
        """Test rendering of all 8 element types in editor vs export HTML."""
        elements = [
            {
                "id": "el_text",
                "type": "text",
                "content": "Titre Principal RFP",
                "x": 80, "y": 80, "width": 400, "height": 80,
                "fontSize": 32, "color": "#f8fafc"
            },
            {
                "id": "el_img",
                "type": "image",
                "src": "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'><rect width='100' height='100' fill='%236366f1'/></svg>",
                "alt": "SVG icon",
                "x": 520, "y": 80, "width": 100, "height": 100
            },
            {
                "id": "el_video",
                "type": "video",
                "src": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                "videoType": "link",
                "x": 660, "y": 80, "width": 300, "height": 180
            },
            {
                "id": "el_shape",
                "type": "shape",
                "shapeType": "rectangle",
                "fill": "rgba(99, 102, 241, 0.2)",
                "stroke": "#6366f1",
                "strokeWidth": 2,
                "borderRadius": 8,
                "x": 1000, "y": 80, "width": 200, "height": 120
            },
            {
                "id": "el_split",
                "type": "split",
                "x": 1240, "y": 80, "width": 250, "height": 140
            },
            {
                "id": "el_bullets",
                "type": "bullets",
                "items": ["Point A sécurisé", "Point B certifié ISO", "Point C réactif"],
                "bulletStyle": "check",
                "fontSize": 20,
                "x": 80, "y": 320, "width": 450, "height": 160
            },
            {
                "id": "el_table",
                "type": "table",
                "columns": ["Critère", "CCTP", "Offre"],
                "rows": [
                    ["Disponibilité", "99.9%", "99.95%"],
                    ["Support", "24/7", "Inclus"]
                ],
                "x": 580, "y": 320, "width": 550, "height": 180
            },
            {
                "id": "el_card",
                "type": "card",
                "title": "Chef de projet dédié",
                "text": "10 ans d'expérience dans les projets d'envergure.",
                "x": 1180, "y": 320, "width": 320, "height": 220
            }
        ]

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1920, "height": 1080})

            # Open editor
            page.goto(f"{self.base_url}/editor.html")
            page.wait_for_selector("#slide-canvas")

            # Load slide elements via CanvasEngine
            page.evaluate(
                """(els) => {
                    engine.setState(els);
                    project.slides[project.activeSlideIndex].elements = els;
                }""",
                elements
            )
            page.wait_for_timeout(400)

            # Deselect any element so no selection outline/handles interfere
            page.evaluate("engine.selectElement(null);")
            page.wait_for_timeout(200)

            # Check that all 8 elements are present on canvas
            canvas_elements = page.query_selector_all(".canvas-element")
            self.assertEqual(len(canvas_elements), 8)

            # Compare HTML produced by renderElementHTML for both modes
            render_checks = page.evaluate(
                """() => {
                    const els = project.slides[project.activeSlideIndex].elements;
                    const results = {};
                    els.forEach(el => {
                        results[el.type] = {
                            edit: window.renderElementHTML(el, project.theme, 'edit'),
                            export: window.renderElementHTML(el, project.theme, 'export')
                        };
                    });
                    return results;
                }"""
            )

            # Check that all element types are rendered by renderElementHTML
            for el_type in ["text", "image", "video", "shape", "split", "bullets", "table", "card"]:
                self.assertIn(el_type, render_checks)
                edit_html = render_checks[el_type]["edit"]
                export_html = render_checks[el_type]["export"]
                self.assertTrue(len(edit_html) > 0)
                self.assertTrue(len(export_html) > 0)

            # Export mode for video has poster card
            self.assertIn("export-video-poster", render_checks["video"]["export"])
            self.assertIn("Vidéo RFP", render_checks["video"]["export"])

            # Editor mode for card has overflow marker placeholder, export does not
            self.assertIn("card-overflow-marker", render_checks["card"]["edit"])
            self.assertNotIn("card-overflow-marker", render_checks["card"]["export"])

            # Build export HTML and verify it is non-empty and well-formed
            export_html = page.evaluate("buildExportHTML()")
            self.assertIn("<!doctype html>", export_html)
            self.assertIn("slide-page", export_html)
            self.assertIn("Titre Principal RFP", export_html)
            self.assertIn("Point A sécurisé", export_html)
            self.assertIn("Disponibilité", export_html)
            self.assertIn("Chef de projet dédié", export_html)

            # Test PDF export via UI
            page.click("#btn-export-dropdown")
            page.wait_for_selector("#btn-export-pdf")
            page.click("#btn-export-pdf")

            page.wait_for_selector("#modal-download", timeout=20000)
            download_btn = page.query_selector("#modal-download")
            pdf_url = download_btn.get_attribute("href")
            self.assertTrue(pdf_url and pdf_url.endswith(".pdf"))

            pdf_rel = pdf_url.replace("/exports/", "")
            exported_file = server.EXPORTS_DIR / pdf_rel
            self.assertTrue(exported_file.exists())
            self.assertGreater(exported_file.stat().st_size, 10000)

            browser.close()


if __name__ == "__main__":
    unittest.main()
