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
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

TEST_TEMP_DIR = tempfile.mkdtemp(prefix="rfp_review_test_")
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


class FakeWebhookHandler(BaseHTTPRequestHandler):
    last_request = None

    def log_message(self, format, *args):
        pass

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)
        data = json.loads(body.decode("utf-8")) if body else {}

        FakeWebhookHandler.last_request = {
            "headers": dict(self.headers),
            "payload": data
        }

        # Return a regenerated slide block spec
        response = {
            "title": "Slide Régénérée avec Succès",
            "type": "content",
            "warnings": ["Attention mise à jour"],
            "blocks": [
                {
                    "kind": "text",
                    "text": "Ce contenu a été régénéré par le webhook n8n."
                }
            ]
        }
        resp_data = json.dumps(response).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(resp_data)))
        self.end_headers()
        self.wfile.write(resp_data)


class TestReviewAndGating(unittest.TestCase):
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

        # Start fake webhook server
        cls.webhook_server = HTTPServer(("127.0.0.1", 0), FakeWebhookHandler)
        cls.webhook_port = cls.webhook_server.server_address[1]
        cls.webhook_url = f"http://127.0.0.1:{cls.webhook_port}/webhook/regenerate"
        cls.webhook_thread = threading.Thread(target=cls.webhook_server.serve_forever, daemon=True)
        cls.webhook_thread.start()
        time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        try:
            cls.server.shutdown()
            cls.server.server_close()
        except Exception:
            pass
        try:
            cls.webhook_server.shutdown()
            cls.webhook_server.server_close()
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

    def _get_json(self, path: str) -> tuple[int, dict]:
        req = urllib.request.Request(f"{self.base_url}{path}", method="GET")
        with urllib.request.urlopen(req) as resp:
            code = resp.getcode()
            body = json.loads(resp.read().decode("utf-8"))
            return code, body

    def test_schema_assumptions_and_catalog_date_roundtrip(self):
        """Test assumptions and catalogDate persist through POST /api/decks and GET /api/save/<id>."""
        spec = {
            "name": "Audit Tarifs",
            "client": "Client Test",
            "date": "2026-10-17",
            "language": "fr",
            "slides": [
                {
                    "type": "content",
                    "title": "Grille Tarifaire",
                    "requiresApproval": True,
                    "catalogDate": "2026-09-01",
                    "assumptions": [
                        "Frais de déplacement non inclus",
                        "TVA applicable en sus"
                    ],
                    "warnings": ["Prix sujets à révision trimestrielle"],
                    "sources": {
                        "mermaid": "graph TD; A-->B;",
                        "drawio": "<mxfile><diagram>test</diagram></mxfile>"
                    },
                    "blocks": [
                        {"kind": "text", "text": "Forfait standard: 15 000 EUR HT."}
                    ]
                }
            ]
        }
        code, res = self._post_json("/api/decks", spec, api_key=self.api_key)
        self.assertEqual(code, 200)
        deck_id = res["id"]

        code_get, deck = self._get_json(f"/api/save/{deck_id}")
        self.assertEqual(code_get, 200)

        content_slide = next(s for s in deck["slides"] if s.get("type") == "content")
        self.assertTrue(content_slide.get("requiresApproval"))
        self.assertEqual(content_slide.get("catalogDate"), "2026-09-01")
        self.assertEqual(content_slide.get("assumptions"), [
            "Frais de déplacement non inclus",
            "TVA applicable en sus"
        ])
        self.assertEqual(content_slide.get("warnings"), ["Prix sujets à révision trimestrielle"])
        self.assertEqual(content_slide.get("sources", {}).get("mermaid"), "graph TD; A-->B;")
        self.assertEqual(content_slide.get("sources", {}).get("drawio"), "<mxfile><diagram>test</diagram></mxfile>")

    @_runtime.slow
    def test_playwright_review_panel_placeholders_and_gating(self):
        """Test with samples/thin.json: placeholders appear in review panel, red badge, gate blocks export until 'Export anyway'."""
        data = json.loads((STUDIO_DIR / "samples" / "thin.json").read_text(encoding="utf-8"))
        code, res = self._post_json("/api/decks", data, api_key=self.api_key)
        self.assertEqual(code, 200)
        deck_id = res["id"]

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1920, "height": 1080})

            page.goto(f"{self.base_url}/editor.html?id={deck_id}")
            page.wait_for_selector("#slide-canvas")
            page.wait_for_timeout(600)

            # Check that thumbnail has a red badge for placeholders
            red_badge = page.query_selector(".slide-status-badge.red")
            self.assertIsNotNone(red_badge, "Expected red badge for placeholders on thumbnail")

            # Open Review panel
            page.click("#nav-btn-review")
            page.wait_for_selector("#panel-review.active")
            page.wait_for_timeout(300)

            # Check placeholders listed
            review_text = page.inner_text("#review-list")
            self.assertIn("[TO FILL:", review_text)

            # Click a review placeholder item to select the canvas element
            review_items = page.query_selector_all(".review-item")
            self.assertGreater(len(review_items), 0)
            review_items[0].click()
            page.wait_for_timeout(300)

            # An element on canvas should now be selected
            selected_el = page.query_selector(".canvas-element.selected")
            self.assertIsNotNone(selected_el, "Clicking review item must select element on canvas")

            # Try to export PDF -> Gating dialog should appear
            page.click("#btn-export-dropdown")
            page.wait_for_selector("#btn-export-pdf")
            page.click("#btn-export-pdf")

            page.wait_for_selector("#export-modal.active")
            self.assertTrue(page.is_visible("#export-gate-box"))
            self.assertTrue(page.is_visible("#export-gate-placeholders-msg"))
            self.assertTrue(page.is_visible("#modal-export-anyway-btn"))

            # Click "Exporter quand même" -> export proceeds and downloads
            page.click("#modal-export-anyway-btn")
            page.wait_for_selector("#modal-download", timeout=25000)
            download_btn = page.query_selector("#modal-download")
            pdf_url = download_btn.get_attribute("href")
            self.assertTrue(pdf_url and pdf_url.endswith(".pdf"))

            # Close modal
            page.click("#modal-close-btn")
            page.wait_for_timeout(300)

            browser.close()

    @_runtime.slow
    def test_playwright_approval_gating_and_sources_modal(self):
        """Test slide with requiresApproval: blocked until ticked, sources modal, and edit resets approval."""
        spec = {
            "name": "Audit Tarifs Approbation",
            "client": "Client Valid",
            "date": "2026-10-17",
            "language": "fr",
            "slides": [
                {
                    "type": "content",
                    "title": "Grille Tarifaire Validée",
                    "requiresApproval": True,
                    "catalogDate": "2026-10-01",
                    "assumptions": ["Assomption A", "Assomption B"],
                    "warnings": ["Avertissement prix"],
                    "sources": {
                        "mermaid": "graph LR; X-->Y;",
                        "drawio": "<mxGraphModel></mxGraphModel>"
                    },
                    "blocks": [
                        {"kind": "text", "text": "Montant ferme: 20 000 EUR."}
                    ]
                }
            ]
        }
        code, res = self._post_json("/api/decks", spec, api_key=self.api_key)
        self.assertEqual(code, 200)
        deck_id = res["id"]

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1920, "height": 1080})

            page.goto(f"{self.base_url}/editor.html?id={deck_id}")
            page.wait_for_selector("#slide-canvas")
            page.wait_for_timeout(600)

            # Open Review panel
            page.click("#nav-btn-review")
            page.wait_for_selector("#panel-review.active")

            # Check assumptions & catalog date appear
            review_text = page.inner_text("#review-list")
            self.assertIn("Catalogue de prix au : 2026-10-01", review_text)
            self.assertIn("Assomption A", review_text)

            # Test Sources button opens sources modal
            page.click(".review-source-btn")
            page.wait_for_selector("#sources-modal.active")
            sources_body = page.inner_text("#sources-modal-body")
            self.assertIn("graph LR; X-->Y;", sources_body)
            self.assertIn("<mxGraphModel>", sources_body)
            page.click("#sources-close-btn")
            page.wait_for_timeout(300)

            # Try to export PDF -> Gated by pricing approval
            page.click("#btn-export-dropdown")
            page.wait_for_selector("#btn-export-pdf")
            page.click("#btn-export-pdf")

            page.wait_for_selector("#export-modal.active")
            self.assertTrue(page.is_visible("#export-gate-approval-row"))

            # The "Exporter quand même" button must be disabled because approval is not ticked
            export_anyway = page.query_selector("#modal-export-anyway-btn")
            self.assertTrue(export_anyway.is_disabled(), "Export anyway button must be disabled until approval is checked")

            # Check the approval box
            page.check("#chk-pricing-approval")
            page.wait_for_timeout(200)
            self.assertFalse(export_anyway.is_disabled(), "Export anyway button must be enabled once approval is checked")

            # Close export modal
            page.click("#modal-close-btn")
            page.wait_for_timeout(300)

            # Thumbnail should now display checkmark badge
            check_badge = page.query_selector(".slide-status-badge.check")
            self.assertIsNotNone(check_badge, "Approved slide should show check badge")

            # Edit an element on the slide -> approval should be reset
            page.evaluate("""() => {
                switchToSlide(1);
                project.slides[1].elements[0].content = 'Montant modifie: 25 000 EUR';
                onCanvasChanged();
            }""")
            page.wait_for_timeout(300)

            # Now try export again -> Gating should reappear with unchecked box and disabled button
            page.click("#btn-export-dropdown")
            page.wait_for_selector("#btn-export-pdf")
            page.click("#btn-export-pdf")

            page.wait_for_selector("#export-modal.active")
            self.assertTrue(page.is_visible("#export-gate-approval-row"))
            export_anyway2 = page.query_selector("#modal-export-anyway-btn")
            self.assertTrue(export_anyway2.is_disabled(), "Editing must invalidate approval and disable export button again")

            page.click("#modal-close-btn")
            browser.close()

    def test_slide_regeneration_endpoint(self):
        """Test POST /api/decks/<id>/slides/<index>/regenerate with fake webhook."""
        # Save a deck
        spec = {
            "name": "Audit Deck Regen",
            "client": "Client Regen",
            "date": "2026-10-17",
            "language": "fr",
            "slides": [
                {
                    "type": "content",
                    "title": "Slide Initiale Avant Regen",
                    "blocks": [
                        {"kind": "text", "text": "Texte initial avant webhook."}
                    ]
                }
            ]
        }
        code, res = self._post_json("/api/decks", spec, api_key=self.api_key)
        self.assertEqual(code, 200)
        deck_id = res["id"]

        # Call without webhook configured -> 503
        old_env = os.environ.get("REGENERATE_WEBHOOK_URL")
        old_key = os.environ.get("REGENERATE_WEBHOOK_KEY")
        if "REGENERATE_WEBHOOK_URL" in os.environ:
            del os.environ["REGENERATE_WEBHOOK_URL"]
        if "REGENERATE_WEBHOOK_KEY" in os.environ:
            del os.environ["REGENERATE_WEBHOOK_KEY"]

        code_err, res_err = self._post_json(f"/api/decks/{deck_id}/slides/1/regenerate", {})
        self.assertEqual(code_err, 503)

        # Set webhook URL and webhook key
        os.environ["REGENERATE_WEBHOOK_URL"] = self.webhook_url
        os.environ["REGENERATE_WEBHOOK_KEY"] = "super-secret-webhook-key"
        try:
            # 1. Test index 0 and last index return 400 ("fixed slides cannot be regenerated")
            # The deck has 3 slides: [0: Title, 1: Content, 2: ThankYou]
            code_0, res_0 = self._post_json(f"/api/decks/{deck_id}/slides/0/regenerate", {})
            self.assertEqual(code_0, 400)
            self.assertIn("fixed slides cannot be regenerated", res_0.get("message", ""))

            code_last, res_last = self._post_json(f"/api/decks/{deck_id}/slides/2/regenerate", {})
            self.assertEqual(code_last, 400)
            self.assertIn("fixed slides cannot be regenerated", res_last.get("message", ""))

            # 2. Test normal regeneration on content slide (index 1)
            code_ok, res_ok = self._post_json(f"/api/decks/{deck_id}/slides/1/regenerate", {})
            self.assertEqual(code_ok, 200)
            self.assertEqual(res_ok.get("status"), "ok")
            regen_slide = res_ok.get("slide")
            self.assertEqual(regen_slide.get("label"), "Slide Régénérée avec Succès")
            # Text element inside should have the webhook text (skip the title element)
            text_els = [e for e in regen_slide.get("elements", []) if e.get("type") == "text" and not e.get("id", "").startswith("el_title")]
            self.assertGreater(len(text_els), 0)
            text_el = text_els[0]
            self.assertIn("Ce contenu a été régénéré par le webhook n8n", text_el.get("content", ""))

            # Check that X-API-Key was sent to the webhook
            self.assertIsNotNone(FakeWebhookHandler.last_request)
            self.assertEqual(FakeWebhookHandler.last_request["headers"].get("X-Api-Key"), "super-secret-webhook-key")
            self.assertEqual(FakeWebhookHandler.last_request["payload"], {"deckId": deck_id, "slideIndex": 1})

            # Verify saved project was updated in storage
            code_get, deck_updated = self._get_json(f"/api/save/{deck_id}")
            self.assertEqual(code_get, 200)
            self.assertEqual(deck_updated["slides"][1]["label"], "Slide Régénérée avec Succès")
        finally:
            if old_env is not None:
                os.environ["REGENERATE_WEBHOOK_URL"] = old_env
            elif "REGENERATE_WEBHOOK_URL" in os.environ:
                del os.environ["REGENERATE_WEBHOOK_URL"]
            if old_key is not None:
                os.environ["REGENERATE_WEBHOOK_KEY"] = old_key
            elif "REGENERATE_WEBHOOK_KEY" in os.environ:
                del os.environ["REGENERATE_WEBHOOK_KEY"]

    @_runtime.slow
    def test_playwright_selective_approval_reset_and_unsaved_regen(self):
        """Test approval survives edits to non-pricing slides and resets on pricing slides;
        and regenerate after adding an unsaved slide replaces the right slide."""
        old_env = os.environ.get("REGENERATE_WEBHOOK_URL")
        os.environ["REGENERATE_WEBHOOK_URL"] = self.webhook_url

        try:
            # Create a deck with 2 content slides:
            # slide 1: standard slide (requiresApproval=False)
            # slide 2: pricing slide (requiresApproval=True)
            spec = {
                "name": "Audit Approval & Regen Deck",
                "client": "Client Alpha",
                "date": "2026-10-17",
                "language": "fr",
                "slides": [
                    {
                        "type": "content",
                        "title": "Slide Standard Non-Tarifs",
                        "blocks": [
                            {"kind": "text", "text": "Présentation technique."}
                        ]
                    },
                    {
                        "type": "content",
                        "title": "Slide Tarifs & Budget",
                        "requiresApproval": True,
                        "blocks": [
                            {"kind": "text", "text": "Montant total: 50 000 EUR."}
                        ]
                    }
                ]
            }
            code, res = self._post_json("/api/decks", spec, api_key=self.api_key)
            self.assertEqual(code, 200)
            deck_id = res["id"]

            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True)
                page = browser.new_page(viewport={"width": 1400, "height": 900})
                page.goto(f"{self.base_url}/editor.html?id={deck_id}", wait_until="networkidle")
                page.wait_for_selector(".slide-thumb")

                # The slides are:
                # 0: Titre
                # 1: Slide Standard Non-Tarifs
                # 2: Slide Tarifs & Budget (requiresApproval: True)
                # 3: Thank-You
                thumbs = page.query_selector_all(".slide-thumb")
                self.assertEqual(len(thumbs), 4)

                # Verify fixed slides (0 and 3) do NOT have the regenerate button
                self.assertIsNone(thumbs[0].query_selector(".btn-slide-regen"))
                self.assertIsNone(thumbs[3].query_selector(".btn-slide-regen"))
                # Content slides (1 and 2) DO have the regenerate button
                self.assertIsNotNone(thumbs[1].query_selector(".btn-slide-regen"))
                self.assertIsNotNone(thumbs[2].query_selector(".btn-slide-regen"))

                # 1. Approve pricing in review panel
                page.click("#nav-btn-review")
                page.wait_for_selector("#panel-review.active")

                # Switch to slide 2 (pricing) and approve via export modal or set approval
                page.evaluate("""() => {
                    project.approvals = { pricing: true, at: Date.now() };
                    renderSlideList();
                    updateReviewPanel();
                }""")
                page.wait_for_timeout(300)

                is_approved = page.evaluate("() => !!(project.approvals && project.approvals.pricing)")
                self.assertTrue(is_approved, "Project pricing should be approved")

                # 2. Edit on a non-pricing slide (slide 1) -> Approval must SURVIVE
                page.evaluate("""() => {
                    switchToSlide(1);
                    // modify an element on non-pricing slide
                    if (project.slides[1].elements && project.slides[1].elements.length > 0) {
                        project.slides[1].elements[0].content = 'Texte modifié non pricing';
                    }
                    onCanvasChanged();
                }""")
                page.wait_for_timeout(300)

                is_still_approved = page.evaluate("() => !!(project.approvals && project.approvals.pricing)")
                self.assertTrue(is_still_approved, "Approval must SURVIVE edit on a non-pricing slide")

                # 3. Edit on pricing slide (slide 2) -> Approval must RESET
                page.evaluate("""() => {
                    switchToSlide(2);
                    if (project.slides[2].elements && project.slides[2].elements.length > 0) {
                        project.slides[2].elements[0].content = 'Montant modifié: 60 000 EUR';
                    }
                    onCanvasChanged();
                }""")
                page.wait_for_timeout(300)

                is_reset = page.evaluate("() => !project.approvals || !project.approvals.pricing")
                self.assertTrue(is_reset, "Approval must RESET on a slide with requiresApproval=True")

                # 4. Test regenerate after adding an unsaved slide replaces the right slide
                # Automatically accept confirm dialogs
                page.on("dialog", lambda dialog: dialog.accept())

                # Add a new blank slide at index 2 (between 1 and 2) without manually saving
                page.evaluate("""() => {
                    switchToSlide(1);
                    addSlide('blank');
                }""")
                page.wait_for_timeout(300)

                # Now slide 2 is the newly added slide, and slide 3 is the pricing slide
                new_slide_label = page.evaluate("() => project.slides[2].label")
                self.assertEqual(new_slide_label, "Diapositive de contenu")

                # Call regenerate on slide 3 (the pricing slide)
                # app.js regenerateSlide(3) will await executeSave(), then call API for slide 3
                page.evaluate("""async () => {
                    await regenerateSlide(3);
                }""")
                page.wait_for_timeout(1000)

                # Verify slide 2 is still "Diapositive de contenu" and slide 3 was replaced with regenerated slide
                slide2_label = page.evaluate("() => project.slides[2].label")
                slide3_label = page.evaluate("() => project.slides[3].label")
                self.assertEqual(slide2_label, "Diapositive de contenu", "Unsaved slide 2 must not be overwritten")
                self.assertEqual(slide3_label, "Slide Régénérée avec Succès", "Slide 3 must be replaced with regenerated slide")

                browser.close()
        finally:
            if old_env is not None:
                os.environ["REGENERATE_WEBHOOK_URL"] = old_env
            elif "REGENERATE_WEBHOOK_URL" in os.environ:
                del os.environ["REGENERATE_WEBHOOK_URL"]


if __name__ == "__main__":
    unittest.main()
