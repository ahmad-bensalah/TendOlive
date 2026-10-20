import os
import sys
import json
import time
import shutil
import tempfile
import unittest
import threading
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.error import HTTPError

# Set temporary SAVES_DIR before importing server
TEST_TEMP_DIR = tempfile.mkdtemp(prefix="rfp_test_elements_")
os.environ["SAVES_DIR"] = TEST_TEMP_DIR

STUDIO_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(STUDIO_DIR))

import server
sys.path.insert(0, str(Path(__file__).resolve().parent))
import _runtime

_runtime.isolate(server)


class TestElementTypes(unittest.TestCase):
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

    def _post_json(self, endpoint, payload):
        data = json.dumps(payload).encode("utf-8")
        req = Request(
            f"{self.base_url}{endpoint}",
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urlopen(req) as resp:
                status = resp.status
                body = json.loads(resp.read().decode("utf-8"))
                return status, body
        except HTTPError as e:
            body = None
            try:
                body = json.loads(e.read().decode("utf-8"))
            except Exception:
                pass
            return e.code, body

    def _get_json(self, endpoint):
        req = Request(f"{self.base_url}{endpoint}", method="GET")
        with urlopen(req) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))

    def test_roundtrip_all_new_element_types(self):
        """Save then load a project containing one of each new element type; assert JSON round-trips unchanged."""
        project_payload = {
            "name": "Phase 1 Acceptance Deck",
            "theme": {
                "primary": "#4338ca",
                "text": "#ffffff",
                "bg": "#0f172a",
                "fontHeading": "'Plus Jakarta Sans', sans-serif",
                "fontBody": "'Inter', sans-serif",
            },
            "slides": [
                {
                    "type": "blank",
                    "label": "RFP Elements Showcase",
                    "elements": [
                        {
                            "id": "el_title_1",
                            "type": "text",
                            "content": "Proposition Technique et Financière",
                            "x": 100, "y": 80, "width": 1200, "height": 70,
                            "fontSize": 48, "color": "#ffffff", "zIndex": 1,
                        },
                        {
                            "id": "el_bullets_1",
                            "type": "bullets",
                            "items": [
                                "Disponibilité cloud SecNumCloud 99.95%",
                                "Accompagnement méthodologique Agile & Scrum",
                                "Sécurité des flux et chiffrement de bout en bout",
                            ],
                            "bulletStyle": "check",
                            "fontFamily": "'Inter', sans-serif",
                            "fontSize": 24,
                            "color": "#e2e8f0",
                            "lineHeight": 1.6,
                            "autoHeight": True,
                            "x": 100, "y": 200, "width": 800, "height": 220,
                            "zIndex": 2,
                        },
                        {
                            "id": "el_table_1",
                            "type": "table",
                            "columns": ["Lot", "Livrable", "Délai", "Conformité"],
                            "rows": [
                                ["Lot 1", "Cadrage & Spécifications", "T0 + 4 semaines", "100% Conforme"],
                                ["Lot 2", "Développement MVP", "T0 + 12 semaines", "100% Conforme"],
                                ["Lot 3", "Recette & Mise en prod", "T0 + 16 semaines", "100% Conforme"],
                            ],
                            "headerFill": "#4338ca",
                            "headerColor": "#ffffff",
                            "rowFill": "#1e293b",
                            "altRowFill": "#0f172a",
                            "borderColor": "#334155",
                            "fontSize": 18,
                            "colWidths": [20, 40, 20, 20],
                            "x": 100, "y": 480, "width": 1000, "height": 300,
                            "zIndex": 3,
                        },
                        {
                            "id": "el_card_1",
                            "type": "card",
                            "title": "Directeur de Projet Dédié",
                            "text": "15 ans d'expérience dans les projets SI ministériels et secteur public.",
                            "image": "https://example.com/avatar.jpg",
                            "fill": "#1e293b",
                            "radius": 16,
                            "x": 1150, "y": 200, "width": 450, "height": 360,
                            "zIndex": 4,
                        },
                        {
                            "id": "el_svg_img",
                            "type": "image",
                            "src": "/uploads/logo.svg",
                            "alt": "Logo vectoriel",
                            "x": 1150, "y": 600, "width": 200, "height": 100,
                            "zIndex": 5,
                        },
                        {
                            "id": "el_locked_shape",
                            "type": "shape",
                            "shapeType": "rectangle",
                            "fill": "#4338ca",
                            "stroke": "transparent",
                            "strokeWidth": 0,
                            "borderRadius": 24,
                            "locked": True,
                            "x": 1400, "y": 600, "width": 240, "height": 120,
                            "zIndex": 6,
                        },
                    ],
                }
            ],
        }

        # 1. Save
        save_status, save_res = self._post_json("/api/save", project_payload)
        self.assertEqual(save_status, 200)
        self.assertEqual(save_res.get("status"), "ok")
        saved_id = save_res.get("id")
        self.assertIsNotNone(saved_id)

        # 2. Load
        load_status, loaded = self._get_json(f"/api/save/{saved_id}")
        self.assertEqual(load_status, 200)
        self.assertEqual(loaded.get("name"), project_payload["name"])

        # Check round-trip elements
        loaded_elements = loaded["slides"][0]["elements"]
        self.assertEqual(len(loaded_elements), 6)

        bullets_el = next(e for e in loaded_elements if e["type"] == "bullets")
        self.assertEqual(bullets_el["bulletStyle"], "check")
        self.assertEqual(len(bullets_el["items"]), 3)

        table_el = next(e for e in loaded_elements if e["type"] == "table")
        self.assertEqual(len(table_el["columns"]), 4)
        self.assertEqual(len(table_el["rows"]), 3)
        self.assertEqual(table_el["rows"][0][3], "100% Conforme")

        card_el = next(e for e in loaded_elements if e["type"] == "card")
        self.assertEqual(card_el["title"], "Directeur de Projet Dédié")
        self.assertEqual(card_el["radius"], 16)

        locked_shape = next(e for e in loaded_elements if e["id"] == "el_locked_shape")
        self.assertTrue(locked_shape["locked"])
        self.assertEqual(locked_shape["borderRadius"], 24)

    def test_svg_upload_clean_accepted(self):
        """Clean SVG is accepted through upload."""
        clean_svg = b'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="40" fill="green"/></svg>'
        boundary = "---------------------------974767299852498929531610575"
        body = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="clean.svg"\r\n'
            f"Content-Type: image/svg+xml\r\n\r\n"
        ).encode("utf-8") + clean_svg + f"\r\n--{boundary}--\r\n".encode("utf-8")

        req = Request(
            f"{self.base_url}/api/upload",
            data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            method="POST",
        )
        with urlopen(req) as resp:
            self.assertEqual(resp.status, 200)
            res = json.loads(resp.read().decode("utf-8"))
            self.assertEqual(res.get("status"), "ok")
            self.assertTrue(res.get("url", "").endswith("_clean.svg"))

    def test_svg_upload_script_rejected(self):
        """SVG containing <script> is rejected with 400."""
        malicious_svg = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert("xss")</script><rect width="50" height="50"/></svg>'
        boundary = "---------------------------974767299852498929531610575"
        body = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="exploit.svg"\r\n'
            f"Content-Type: image/svg+xml\r\n\r\n"
        ).encode("utf-8") + malicious_svg + f"\r\n--{boundary}--\r\n".encode("utf-8")

        req = Request(
            f"{self.base_url}/api/upload",
            data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            method="POST",
        )
        try:
            with urlopen(req) as resp:
                self.fail("Expected HTTPError 400")
        except HTTPError as e:
            self.assertEqual(e.code, 400)
            err_data = json.loads(e.read().decode("utf-8"))
            self.assertEqual(err_data.get("status"), "error")
            self.assertIn("Rejected SVG", err_data.get("message", ""))


if __name__ == "__main__":
    unittest.main()
