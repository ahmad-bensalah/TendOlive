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
TEST_TEMP_DIR = tempfile.mkdtemp(prefix="rfp_test_saves_")
os.environ["SAVES_DIR"] = TEST_TEMP_DIR

# Add rfp-studio directory to sys.path
STUDIO_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(STUDIO_DIR))

import server
sys.path.insert(0, str(Path(__file__).resolve().parent))
import _runtime

_runtime.isolate(server)


class TestSaveAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp_dir = Path(TEST_TEMP_DIR)
        cls.server = server.ThreadingHTTPServer(("127.0.0.1", 0), server.StudioHandler)
        cls.server.saves_dir = cls.temp_dir
        cls.port = cls.server.server_address[1]
        cls.base_url = f"http://127.0.0.1:{cls.port}"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        # Give server thread a moment to initialize
        time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        try:
            cls.server.shutdown()
            cls.server.server_close()
        except Exception:
            pass
        shutil.rmtree(TEST_TEMP_DIR, ignore_errors=True)

    def tearDown(self):
        # Clear files in test temp dir between test cases
        for f in self.temp_dir.iterdir():
            if f.is_file():
                f.unlink(missing_ok=True)
            elif f.is_dir():
                shutil.rmtree(f, ignore_errors=True)

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

    def _delete_json(self, endpoint):
        req = Request(f"{self.base_url}{endpoint}", method="DELETE")
        try:
            with urlopen(req) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except HTTPError as e:
            return e.code, json.loads(e.read().decode("utf-8"))

    def test_a_post_save_null_id_generates_two_different_ids(self):
        """POST /api/save with {'id': null} twice returns two different ids, neither is 'None', and two files exist."""
        status1, body1 = self._post_json("/api/save", {"id": None, "name": "Project 1", "slides": []})
        self.assertEqual(status1, 200)
        self.assertEqual(body1.get("status"), "ok")
        id1 = body1.get("id")
        self.assertIsNotNone(id1)
        self.assertNotEqual(id1, "None")

        status2, body2 = self._post_json("/api/save", {"id": None, "name": "Project 2", "slides": []})
        self.assertEqual(status2, 200)
        self.assertEqual(body2.get("status"), "ok")
        id2 = body2.get("id")
        self.assertIsNotNone(id2)
        self.assertNotEqual(id2, "None")

        self.assertNotEqual(id1, id2)
        self.assertTrue((self.temp_dir / f"{id1}.json").exists())
        self.assertTrue((self.temp_dir / f"{id2}.json").exists())
        self.assertFalse((self.temp_dir / "None.json").exists())

    def test_b_post_save_none_string_and_no_id_key(self):
        """POST with {'id': 'None'} and with no id key behaves the same as (a)."""
        status1, body1 = self._post_json("/api/save", {"id": "None", "name": "None Str Project", "slides": []})
        self.assertEqual(status1, 200)
        id1 = body1.get("id")
        self.assertNotEqual(id1, "None")
        self.assertTrue((self.temp_dir / f"{id1}.json").exists())

        status2, body2 = self._post_json("/api/save", {"name": "No Key Project", "slides": []})
        self.assertEqual(status2, 200)
        id2 = body2.get("id")
        self.assertNotEqual(id2, "None")
        self.assertNotEqual(id1, id2)
        self.assertTrue((self.temp_dir / f"{id2}.json").exists())
        self.assertFalse((self.temp_dir / "None.json").exists())

    def test_c_post_save_valid_id_and_update(self):
        """POST with a valid id 'abc123' saves to saves/abc123.json, and saving again updates the same file."""
        status1, body1 = self._post_json("/api/save", {"id": "abc123", "name": "Version 1", "slides": []})
        self.assertEqual(status1, 200)
        self.assertEqual(body1.get("id"), "abc123")
        target_file = self.temp_dir / "abc123.json"
        self.assertTrue(target_file.exists())
        saved_data1 = json.loads(target_file.read_text(encoding="utf-8"))
        self.assertEqual(saved_data1["name"], "Version 1")

        status2, body2 = self._post_json("/api/save", {"id": "abc123", "name": "Version 2", "slides": [{"type": "blank"}]})
        self.assertEqual(status2, 200)
        self.assertEqual(body2.get("id"), "abc123")
        saved_data2 = json.loads(target_file.read_text(encoding="utf-8"))
        self.assertEqual(saved_data2["name"], "Version 2")
        self.assertEqual(len(saved_data2["slides"]), 1)

    def test_d_post_save_invalid_id_path_traversal(self):
        """POST with {'id': '../x'} returns 400."""
        status, body = self._post_json("/api/save", {"id": "../x", "name": "Bad Project", "slides": []})
        self.assertEqual(status, 400)
        self.assertEqual(body.get("status"), "error")
        self.assertFalse((self.temp_dir.parent / "x.json").exists())

    def test_e_legacy_migration_none_json(self):
        """Legacy migration: with a None.json present at startup, it is renamed to a new id, content preserved, inner id matches."""
        none_file = self.temp_dir / "None.json"
        dummy_content = {
            "id": "None",
            "name": "Legacy Saved Project",
            "slides": [{"type": "title", "elements": []}],
        }
        none_file.write_text(json.dumps(dummy_content, indent=2), encoding="utf-8")
        self.assertTrue(none_file.exists())

        # Trigger migration explicitly on this directory
        server.migrate_legacy_saves(self.temp_dir)

        # None.json should now be gone
        self.assertFalse(none_file.exists())

        # Find migrated json file
        json_files = list(self.temp_dir.glob("*.json"))
        self.assertEqual(len(json_files), 1)
        migrated_path = json_files[0]
        migrated_id = migrated_path.stem
        self.assertNotEqual(migrated_id, "None")

        migrated_data = json.loads(migrated_path.read_text(encoding="utf-8"))
        self.assertEqual(migrated_data.get("name"), "Legacy Saved Project")
        self.assertEqual(migrated_data.get("id"), migrated_id)

    def test_f_get_saves_lists_migrated_project(self):
        """GET /api/saves lists the migrated project."""
        none_file = self.temp_dir / "None.json"
        dummy_content = {
            "id": "None",
            "name": "Migrated RFP Deck",
            "slides": [{"type": "title"}, {"type": "blank"}],
        }
        none_file.write_text(json.dumps(dummy_content, indent=2), encoding="utf-8")
        server.migrate_legacy_saves(self.temp_dir)

        status, saves = self._get_json("/api/saves")
        self.assertEqual(status, 200)
        self.assertIsInstance(saves, list)
        matched = [s for s in saves if s.get("name") == "Migrated RFP Deck"]
        self.assertEqual(len(matched), 1)
        self.assertNotEqual(matched[0]["id"], "None")
        self.assertEqual(matched[0]["slideCount"], 2)

    def test_g_delete_saved_project(self):
        """Dashboard deletion removes exactly the requested saved deck."""
        status, saved = self._post_json("/api/save", {"id": "delete-me", "name": "À supprimer", "slides": []})
        self.assertEqual(status, 200)
        self.assertTrue((self.temp_dir / "delete-me.json").exists())

        status, result = self._delete_json("/api/save/delete-me")
        self.assertEqual(status, 200)
        self.assertEqual(result["status"], "ok")
        self.assertFalse((self.temp_dir / "delete-me.json").exists())

        status, result = self._delete_json("/api/save/delete-me")
        self.assertEqual(status, 404)
        self.assertEqual(result["status"], "error")


if __name__ == "__main__":
    unittest.main()
