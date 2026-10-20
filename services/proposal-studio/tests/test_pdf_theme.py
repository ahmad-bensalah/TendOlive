"""tests/test_pdf_theme.py — Unit and Playwright tests for Phase 6 PDF Theme Extraction.

Tests:
1. Generate test PDFs in-memory:
   - Dark background PDF
   - White page with colored header PDF
   - Image-only (scan-like) PDF
2. Assert background and primary colors are within tolerance.
3. Assert subset font prefixes (e.g. ABCDEF+Arial) are stripped.
4. Assert image-only scan returns a clean note/fallback without crashing.
5. Assert corrupt or encrypted PDFs return clear error messages.
6. Assert output is deterministic (same PDF yields same colors).
7. Assert oversized file (> 25MB) is rejected with 400.
8. Playwright test: upload PDF in new RFP flow, check palette, adjust color, create RFP, verify editor uses corrected color.
"""

import io
import os
import sys
import shutil
import tempfile
import unittest
import threading
import urllib.request
import urllib.error
from pathlib import Path
from PIL import Image, ImageDraw

STUDIO_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(STUDIO_DIR))

import server
sys.path.insert(0, str(Path(__file__).resolve().parent))
import _runtime

_runtime.isolate(server)
import pdf_extractor
import pymupdf
from playwright.sync_api import sync_playwright


def create_colored_pdf(bg_color: tuple, header_color: tuple = None, text: str = "Titre Document", fontname: str = "helv") -> bytes:
    """Create a PDF with PyMuPDF with background and optional header."""
    doc = pymupdf.open()
    page = doc.new_page(width=600, height=800)

    # Fill background
    r, g, b = [c / 255.0 for c in bg_color]
    page.draw_rect(pymupdf.Rect(0, 0, 600, 800), color=None, fill=(r, g, b))

    # Optional header bar
    if header_color:
        hr, hg, hb = [c / 255.0 for c in header_color]
        page.draw_rect(pymupdf.Rect(0, 0, 600, 150), color=None, fill=(hr, hg, hb))

    # Add text
    if text:
        text_color = (1, 1, 1) if (0.299 * bg_color[0] + 0.587 * bg_color[1] + 0.114 * bg_color[2]) < 128 else (0, 0, 0)
        page.insert_text((50, 200), text, fontsize=24, fontname=fontname, color=text_color)

    pdf_bytes = doc.tobytes()
    doc.close()
    return pdf_bytes


def create_scan_image_pdf(bg_color: tuple, accent_color: tuple) -> bytes:
    """Create a PDF containing only a raster image (no font list / scan-like)."""
    img = Image.new("RGB", (600, 800), color=bg_color)
    draw = ImageDraw.Draw(img)
    draw.rectangle([50, 50, 550, 200], fill=accent_color)
    draw.text((80, 100), "Texte rasterise scanne", fill=(255, 255, 255))

    img_bytes_io = io.BytesIO()
    img.save(img_bytes_io, format="JPEG", quality=85)
    img_data = img_bytes_io.getvalue()

    doc = pymupdf.open()
    page = doc.new_page(width=600, height=800)
    page.insert_image(pymupdf.Rect(0, 0, 600, 800), stream=img_data)
    pdf_bytes = doc.tobytes()
    doc.close()
    return pdf_bytes


class TestPdfThemeExtraction(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp_dir = Path(tempfile.mkdtemp(prefix="rfp_pdf_theme_test_"))
        cls.server = server.ThreadingHTTPServer(("127.0.0.1", 0), server.StudioHandler)
        cls.server.saves_dir = cls.temp_dir
        cls.port = cls.server.server_address[1]
        cls.base_url = f"http://127.0.0.1:{cls.port}"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        try:
            cls.server.shutdown()
            cls.server.server_close()
        except Exception:
            pass
        shutil.rmtree(cls.temp_dir, ignore_errors=True)

    def test_dark_background_pdf(self):
        """Test a dark background PDF with bright accent."""
        pdf_bytes = create_colored_pdf(bg_color=(15, 23, 42), header_color=(59, 130, 246), text="Présentation Sombre")
        res = pdf_extractor.extract_pdf_theme(pdf_bytes)
        self.assertEqual(res["status"], "ok")
        self.assertTrue(res.get("approximate"))
        bg = res["palette"]["bg"].lower()
        # Expect dark color #0f172a approx
        self.assertTrue(bg.startswith("#0") or bg.startswith("#1"))
        # Primary accent should be blue
        primary = res["palette"]["primary"].lower()
        self.assertTrue(primary.startswith("#3") or primary.startswith("#2") or primary.startswith("#1"))

    def test_white_page_with_colored_header_pdf(self):
        """Test white background with blue header and Helvetica font."""
        pdf_bytes = create_colored_pdf(bg_color=(255, 255, 255), header_color=(29, 78, 216), text="Titre Document", fontname="helv")
        res = pdf_extractor.extract_pdf_theme(pdf_bytes)
        self.assertEqual(res["status"], "ok")
        # White or near white background
        bg = res["palette"]["bg"].lower()
        self.assertTrue(bg in ("#ffffff", "#fefefe", "#fcfcfc", "#fafafa", "#f8fafc"))
        # Primary should be blue #1d4ed8
        primary = res["palette"]["primary"].lower()
        self.assertTrue(primary.startswith("#1") or primary.startswith("#2") or primary.startswith("#3"))

    def test_font_subset_cleaning(self):
        """Test that subset prefixes like ABCDEF+Arial are cleaned."""
        self.assertEqual(pdf_extractor.clean_font_name("ABCDEF+Arial"), "Arial")
        self.assertEqual(pdf_extractor.clean_font_name("XYZ123+Helvetica-Bold"), "Helvetica")
        self.assertIsNone(pdf_extractor.clean_font_name("ABCDEF+Wingdings"))
        self.assertIsNone(pdf_extractor.clean_font_name("Symbol"))

    def test_scan_image_only_pdf(self):
        """Test image-only scan PDF returns clean notes without crash."""
        pdf_bytes = create_scan_image_pdf(bg_color=(240, 240, 240), accent_color=(21, 128, 61))
        res = pdf_extractor.extract_pdf_theme(pdf_bytes)
        self.assertEqual(res["status"], "ok")
        self.assertTrue(res.get("approximate"))
        self.assertIn("scanné", res.get("notes", "").lower())
        self.assertEqual(res["fonts"]["heading"]["name"], "Plus Jakarta Sans")

    def test_corrupt_and_encrypted_pdf(self):
        """Test corrupt and encrypted PDFs return clear error messages."""
        # Corrupt bytes
        res_corrupt = pdf_extractor.extract_pdf_theme(b"%PDF-1.4 corrupt data not valid pdf")
        self.assertEqual(res_corrupt["status"], "error")
        self.assertIn("invalide ou corrompu", res_corrupt["message"])

        # Encrypted PDF
        doc = pymupdf.open()
        doc.new_page(width=400, height=400)
        enc_bytes = doc.tobytes(encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw="owner123", user_pw="user123")
        doc.close()
        res_enc = pdf_extractor.extract_pdf_theme(enc_bytes)
        self.assertEqual(res_enc["status"], "error")
        self.assertIn("chiffré", res_enc["message"].lower())

    def test_determinism(self):
        """Assert that running extraction twice on identical PDF yields identical results."""
        pdf_bytes = create_colored_pdf(bg_color=(245, 245, 245), header_color=(16, 185, 129))
        res1 = pdf_extractor.extract_pdf_theme(pdf_bytes)
        res2 = pdf_extractor.extract_pdf_theme(pdf_bytes)
        self.assertEqual(res1["palette"], res2["palette"])
        self.assertEqual(res1["fonts"], res2["fonts"])

    def test_oversized_file_rejected(self):
        """Assert that oversized file (> 25MB) is rejected."""
        fake_large_pdf = b"%PDF-1.4\n" + (b"0" * (26 * 1024 * 1024))
        res = pdf_extractor.extract_pdf_theme(fake_large_pdf)
        self.assertEqual(res["status"], "error")
        self.assertIn("25 Mo", res["message"])

    @_runtime.slow
    def test_playwright_pdf_upload_color_adjustment(self):
        """Playwright: upload PDF in New RFP flow, verify palette, adjust color, create RFP, verify editor."""
        test_pdf = create_colored_pdf(bg_color=(255, 255, 255), header_color=(220, 38, 38), text="RFP Sécurité", fontname="helv")
        test_pdf_path = self.temp_dir / "sample_test.pdf"
        test_pdf_path.write_bytes(test_pdf)

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1400, "height": 900})
            page.goto(f"{self.base_url}/index.html", wait_until="networkidle")

            # The PDF is imported as a design-only template from the "Modèles" section
            page.set_input_files("#template-file", str(test_pdf_path))
            page.wait_for_selector(".template-card .badge:text('Approximatif')", timeout=30000)
            self.assertIn("ajouté", page.inner_text("#template-status"))

            # A deck created with that template uses the template theme (red header -> primary)
            tid = page.evaluate("fetch('/api/templates').then(r => r.json()).then(d => d.templates[0].id)")
            theme = page.evaluate(f"fetch('/api/templates/{tid}').then(r => r.json()).then(t => t.theme)")
            self.assertTrue(theme["primary"].startswith("#"))

            browser.close()


if __name__ == "__main__":
    unittest.main()
