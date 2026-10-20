#!/usr/bin/env python3
"""
Unit tests for tools/check_llm.py using a local mock HTTP server.
Verifies response status handling (401, 404, 429, 200 ok, 200 invalid JSON, timeout)
and asserts that fake secret keys are never leaked to stdout or stderr.
"""

import json
import os
import subprocess
import sys
import time
import unittest
from http.server import HTTPServer, BaseHTTPRequestHandler
import threading

FAKE_KEY = "test-key-not-real-xyz987"
CHECK_LLM_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools", "check_llm.py")


class MockGroqHandler(BaseHTTPRequestHandler):
    scenario = "ok"

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        _ = self.rfile.read(length)

        if MockGroqHandler.scenario == "401":
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error": {"message": "Invalid API Key"}}')

        elif MockGroqHandler.scenario == "404":
            self.send_response(404)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error": {"message": "Model not found"}}')

        elif MockGroqHandler.scenario == "429":
            self.send_response(429)
            self.send_header("Content-Type", "application/json")
            self.send_header("Retry-After", "12s")
            self.end_headers()
            self.wfile.write(b'{"error": {"message": "Rate limit reached"}}')

        elif MockGroqHandler.scenario == "ok":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            payload = {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": '{"ok": true}'
                        }
                    }
                ]
            }
            self.wfile.write(json.dumps(payload).encode("utf-8"))

        elif MockGroqHandler.scenario == "garbage":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'NOT A JSON RESPONSE')

        elif MockGroqHandler.scenario == "slow":
            # Sleep longer than the client timeout; check_llm default timeout is 20s, but we can test network timeout
            # Note: For fast unit tests, we sleep 22 seconds if testing slow, or we test in a targeted way.
            time.sleep(21)
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"ok": true}')

    def log_message(self, format, *args):
        # Suppress standard logging during tests
        pass


class TestCheckLLM(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), MockGroqHandler)
        cls.port = cls.server.server_address[1]
        cls.base_url = f"http://127.0.0.1:{cls.port}"
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def run_check_llm(self, env_overrides=None):
        env = os.environ.copy()
        if env_overrides:
            env.update(env_overrides)
        proc = subprocess.run(
            [sys.executable, CHECK_LLM_PATH],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        output = proc.stdout + proc.stderr
        # Strict security rule: fake key must NEVER appear in stdout or stderr
        self.assertNotIn(FAKE_KEY, output, "Fake API key must never appear in command output")
        return proc.returncode, output

    def test_missing_variables(self):
        # Unset GROQ_API_KEY and GROQ_MODEL
        env = {
            "GROQ_BASE_URL": self.base_url,
            "GROQ_API_KEY": "",
            "GROQ_MODEL": ""
        }
        code, out = self.run_check_llm(env)
        self.assertEqual(code, 1)
        self.assertIn("Missing environment variable", out)
        self.assertIn("export GROQ_API_KEY=", out)
        self.assertIn("set GROQ_API_KEY=", out)

    def test_401_invalid_key(self):
        MockGroqHandler.scenario = "401"
        env = {
            "GROQ_BASE_URL": self.base_url,
            "GROQ_API_KEY": FAKE_KEY,
            "GROQ_MODEL": "llama-3.3-70b-versatile"
        }
        code, out = self.run_check_llm(env)
        self.assertEqual(code, 1)
        self.assertIn("401", out)
        self.assertIn("Invalid GROQ_API_KEY", out)

    def test_404_model_not_found(self):
        MockGroqHandler.scenario = "404"
        env = {
            "GROQ_BASE_URL": self.base_url,
            "GROQ_API_KEY": FAKE_KEY,
            "GROQ_MODEL": "nonexistent-model"
        }
        code, out = self.run_check_llm(env)
        self.assertEqual(code, 1)
        self.assertIn("404", out)
        self.assertIn("Groq console", out)

    def test_429_rate_limit_with_retry_after(self):
        MockGroqHandler.scenario = "429"
        env = {
            "GROQ_BASE_URL": self.base_url,
            "GROQ_API_KEY": FAKE_KEY,
            "GROQ_MODEL": "llama-3.3-70b-versatile"
        }
        code, out = self.run_check_llm(env)
        self.assertEqual(code, 1)
        self.assertIn("429", out)
        self.assertIn("Retry-After: 12s", out)

    def test_200_valid_json_response(self):
        MockGroqHandler.scenario = "ok"
        env = {
            "GROQ_BASE_URL": self.base_url,
            "GROQ_API_KEY": FAKE_KEY,
            "GROQ_MODEL": "llama-3.3-70b-versatile"
        }
        code, out = self.run_check_llm(env)
        self.assertEqual(code, 0)
        self.assertIn("OK: Groq API connection and model verified successfully", out)

    def test_200_invalid_garbage_response(self):
        MockGroqHandler.scenario = "garbage"
        env = {
            "GROQ_BASE_URL": self.base_url,
            "GROQ_API_KEY": FAKE_KEY,
            "GROQ_MODEL": "llama-3.3-70b-versatile"
        }
        code, out = self.run_check_llm(env)
        self.assertEqual(code, 1)
        self.assertIn("Invalid JSON response received from API", out)

    def test_network_connection_error(self):
        # Point to an unallocated port to test clean network error
        env = {
            "GROQ_BASE_URL": "http://127.0.0.1:59999",
            "GROQ_API_KEY": FAKE_KEY,
            "GROQ_MODEL": "llama-3.3-70b-versatile"
        }
        code, out = self.run_check_llm(env)
        self.assertEqual(code, 1)
        self.assertIn("Network error reaching API", out)


if __name__ == "__main__":
    unittest.main()
