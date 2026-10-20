"""server.py — RFP Slide Deck Studio backend.

Serves the SPA, handles PPTX upload & theme extraction, QR generation,
image/video uploads, auto-save, and PDF/PPTX export.
"""
import json, os, sys, re, base64, subprocess, uuid, time, shutil
from pathlib import Path
from typing import Optional, Dict, Any
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, unquote, parse_qs

VERSION = "1.0.0"

ROOT = Path(__file__).resolve().parent
UPLOADS = ROOT / "uploads"
UPLOADS.mkdir(exist_ok=True)
def get_saves_dir(server_instance=None) -> Path:
    if server_instance and hasattr(server_instance, "saves_dir"):
        p = Path(server_instance.saves_dir)
    else:
        p = Path(os.environ.get("SAVES_DIR", str(ROOT / "saves")))
    p.mkdir(exist_ok=True)
    return p
SAVES_DIR = get_saves_dir()
EXPORTS_DIR = ROOT / "exports"
EXPORTS_DIR.mkdir(exist_ok=True)

sys.path.insert(0, str(ROOT))
from pptx_extractor import extract_theme
import layout_engine

MAX_UPLOAD_SIZE = 25 * 1024 * 1024  # 25 MB
MAX_DECK_SIZE = 5 * 1024 * 1024     # 5 MB
MAX_TEMPLATE_SIZE = 60 * 1024 * 1024  # 60 MB: real brand templates are heavy
ALLOWED_UPLOAD_EXTS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
    ".mp4", ".webm", ".pdf", ".pptx"
}


def _is_safe_svg(raw_bytes: bytes) -> tuple[bool, str]:
    """Check SVG for executable scripts or dangerous event handlers."""
    try:
        text = raw_bytes.decode("utf-8", errors="ignore").lower()
    except Exception:
        return False, "Could not decode SVG file"

    dangerous_patterns = [
        (r'<\s*script', "SVG contains script tag"),
        (r'\bonload\s*=', "SVG contains onload handler"),
        (r'\bonclick\s*=', "SVG contains onclick handler"),
        (r'\bonerror\s*=', "SVG contains onerror handler"),
        (r'javascript\s*:', "SVG contains javascript: protocol URI"),
    ]
    for pattern, reason in dangerous_patterns:
        if re.search(pattern, text):
            return False, reason
    return True, ""


def _store_imported_media(blob: bytes, ext: str) -> str:
    """Save an image or video taken from an imported template into uploads/ and return its URL.
    Files are named by content hash, so media repeated across slides is stored once."""
    import hashlib
    ext = ext.lower().lstrip(".")
    if f".{ext}" not in ALLOWED_UPLOAD_EXTS:
        raise ValueError(f"unsupported media type: {ext}")
    if ext == "svg":
        ok, reason = _is_safe_svg(blob)
        if not ok:
            raise ValueError(reason)
    name = f"tpl_{hashlib.sha1(blob).hexdigest()[:16]}.{ext}"
    target = UPLOADS / name
    if not target.exists():
        target.write_bytes(blob)
    return f"/uploads/{name}"


_template_library = None


def get_template_library():
    """Design-only template store (templates/ next to server.py; TEMPLATES_DIR overrides)."""
    global _template_library
    base = Path(os.environ.get("TEMPLATES_DIR", str(ROOT / "templates")))
    if _template_library is None or _template_library.base != base:
        import template_importer
        _template_library = template_importer.TemplateLibrary(base)
    return _template_library


def autoimport_templates():
    """Import new files of templates/inbox at startup (TEMPLATES_AUTOIMPORT=0 disables). Never fatal."""
    if os.environ.get("TEMPLATES_AUTOIMPORT", "1") in ("0", "false", "no"):
        return
    try:
        res = get_template_library().rescan()
        if res["imported"]:
            print(f"[templates] imported: {', '.join(res['imported'])}")
        for name, err in res["errors"].items():
            print(f"[templates] could not import {name}: {err}")
    except Exception as e:
        print(f"[templates] auto-import failed: {e}")


# ── Tenders and generations ────────────────────────────────────────────
def get_tender_store():
    import tender_store
    return tender_store.TenderStore(Path(os.environ.get("TENDERS_DIR", str(ROOT / "tenders"))))


def get_generation_store():
    import tender_store
    return tender_store.GenerationStore(Path(os.environ.get("GENERATIONS_DIR", str(ROOT / "generations"))))


def _gen_timeout() -> float:
    try:
        return float(os.environ.get("GENERATE_TIMEOUT_SECONDS", "1200"))
    except ValueError:
        return 1200.0


GEN_PARAM_KEYS = {"language", "project_type", "deckName", "includeCompetitorSlide", "qr_url", "model"}

# Groq models offered in the "Générer le deck" dialog (GROQ_MODELS="id1,id2" overrides the list).
# Empty choice = the model configured in n8n (GROQ_MODEL).
DEFAULT_GROQ_MODELS = ["openai/gpt-oss-20b", "openai/gpt-oss-120b", "qwen/qwen3.8-27b", "llama-3.3-70b-versatile"]


def groq_models() -> list:
    env = os.environ.get("GROQ_MODELS", "").strip()
    models = [m.strip() for m in env.split(",") if m.strip()] if env else DEFAULT_GROQ_MODELS
    return [m for m in models if re.fullmatch(r"[A-Za-z0-9._/:-]{1,80}", m)]


def validate_generation_params(params) -> list:
    if params is None:
        return []
    if not isinstance(params, dict):
        return ["params must be an object"]
    errors = [f"unknown parameter '{k}'. Allowed: {sorted(GEN_PARAM_KEYS)}" for k in params if k not in GEN_PARAM_KEYS]
    if "language" in params and params["language"] not in ("auto", "fr", "en"):
        errors.append("language must be auto, fr or en")
    if "project_type" in params and params["project_type"] not in ("auto", "software", "saas", "other"):
        errors.append("project_type must be auto, software, saas or other")
    if "deckName" in params and (not isinstance(params["deckName"], str) or len(params["deckName"]) > 80):
        errors.append("deckName must be a string of at most 80 characters")
    if "model" in params and params["model"] not in ("", *groq_models()):
        errors.append(f"model must be one of {groq_models()}")
    if "includeCompetitorSlide" in params and not isinstance(params["includeCompetitorSlide"], bool):
        errors.append("includeCompetitorSlide must be true or false")
    if params.get("qr_url") and not re.fullmatch(r"https?://\S{1,500}", str(params["qr_url"])):
        errors.append("qr_url must be an http(s) URL")
    return errors


def start_generation(handler, tender_id, template_id, params):
    """Creates the run record and starts the agents. Returns (status_code, body)."""
    tenders, gens = get_tender_store(), get_generation_store()
    raw = tenders.get(tender_id)
    if raw is None:
        return 404, {"status": "error", "message": f"Appel d'offres introuvable : {tender_id}"}
    lib = get_template_library()
    if template_id is None:
        template_id = lib.get_default()
    elif template_id == "":
        template_id = None
    elif lib.get(template_id) is None:
        return 400, {"status": "error", "message": f"Modèle introuvable : {template_id}"}
    errors = validate_generation_params(params)
    if errors:
        return 400, {"status": "error", "message": "; ".join(errors), "errors": errors}
    mode = os.environ.get("GENERATE_MODE", "webhook")
    url = os.environ.get("GENERATE_WEBHOOK_URL", "").strip()
    if mode != "cli" and not url:
        return 503, {"status": "error", "message": "Génération non configurée (GENERATE_WEBHOOK_URL manquant)"}
    try:
        max_runs = int(os.environ.get("MAX_CONCURRENT_GENERATIONS", "1"))
    except ValueError:
        max_runs = 1
    if len(gens.active(_gen_timeout())) >= max_runs:
        return 409, {"status": "error", "message": "Une génération est déjà en cours. Attendez sa fin avant d'en lancer une autre."}

    rec = gens.create(tender_id, template_id, params or {})
    payload = dict(raw)
    payload.update({"runId": rec["runId"], "template": template_id, "params": params or {}})
    try:
        if mode == "cli":
            _start_cli_generation(handler, payload)
        else:
            import urllib.request as u_req
            req = u_req.Request(url, data=json.dumps(payload).encode("utf-8"), method="POST",
                                headers={"Content-Type": "application/json"})
            key = os.environ.get("GENERATE_WEBHOOK_KEY", "").strip()
            if key:
                req.add_header("X-API-Key", key)
            with u_req.urlopen(req, timeout=10) as resp:
                resp.read()
    except Exception as e:
        gens.update(rec["runId"], {"status": "failed", "error": f"agents unreachable: {type(e).__name__}"})
        return 502, {"status": "error", "message": "Le service des agents (n8n) est injoignable", "runId": rec["runId"]}
    return 202, {"status": "ok", "runId": rec["runId"]}


def _start_cli_generation(handler, payload):
    """GENERATE_MODE=cli: run the agent chain with Node next to the platform (no n8n)."""
    import tempfile
    gen_dir = Path(os.environ.get("GENERATIONS_DIR", str(ROOT / "generations")))
    gen_dir.mkdir(parents=True, exist_ok=True)
    input_file = gen_dir / f"{payload['runId']}.input.json"
    input_file.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    env = dict(os.environ)
    env["STUDIO_BASE_URL"] = f"http://127.0.0.1:{handler.server.server_address[1]}"
    env.setdefault("PUBLIC_EDITOR_URL", "")
    log = open(gen_dir / f"{payload['runId']}.log", "w")
    subprocess.Popen(["node", str(ROOT / "agents" / "tools" / "generate.js"), str(input_file)],
                     cwd=str(ROOT), env=env, stdout=log, stderr=subprocess.STDOUT)


PREVIEW_SAMPLE = {
    "name": "Proposition commerciale", "client": "Client", "date": "2026",
    "slides": [{"type": "content", "title": "Synthèse de notre réponse", "blocks": [
        {"kind": "bullets", "items": ["Compréhension précise de vos besoins", "Équipe dédiée et expérimentée",
                                      "Planning maîtrisé et transparent"]},
        {"kind": "table", "columns": ["Exigence", "Réponse"], "rows": [["Sécurité", "Conforme"], ["Hébergement", "Conforme"]]}]}]
}


def _render_template_previews(tid, port=None):
    """Renders title / content / thank-you previews (960x540) of a template with the real layout,
    in a background thread. Without Playwright the UI shows a color swatch instead."""
    def work():
        try:
            lib = get_template_library()
            template = lib.get(tid)
            if not template or not port:
                return
            project, _ = layout_engine.layout_deck(PREVIEW_SAMPLE, template=template)
            preview_id = f"tplpreview-{uuid.uuid4().hex[:8]}"
            project["id"] = preview_id
            saves = get_saves_dir()
            save_file = saves / f"{preview_id}.json"
            save_file.write_text(json.dumps(project), encoding="utf-8")
            out = lib.library / tid
            script = f'''
from playwright.sync_api import sync_playwright
with sync_playwright() as pw:
    b = pw.chromium.launch()
    pg = b.new_page(viewport={{"width": 1600, "height": 900}})
    pg.goto("http://127.0.0.1:{port}/editor.html?id={preview_id}")
    pg.wait_for_function("project.id === '{preview_id}'", timeout=20000)
    pg.wait_for_timeout(800)
    n = pg.evaluate("project.slides.length")
    for role, idx in (("title", 0), ("content", 1), ("thankyou", n - 1)):
        pg.evaluate(f"switchToSlide({{idx}})")
        pg.wait_for_timeout(500)
        el = pg.query_selector("#slide-canvas")
        el.screenshot(path=r"{out}/preview_" + role + ".png")
    b.close()
'''
            try:
                subprocess.run([_get_python_executable(), "-c", script], capture_output=True, timeout=90)
            finally:
                save_file.unlink(missing_ok=True)
            from PIL import Image
            for role in ("title", "content", "thankyou"):
                f = out / f"preview_{role}.png"
                if f.exists():
                    Image.open(f).convert("RGB").resize((960, 540)).save(f)
        except Exception as e:
            print(f"[templates] preview of {tid} failed: {e}")
    import threading
    threading.Thread(target=work, daemon=True).start()


def _cleanup_old_exports(max_age_hours=24):
    """Purge export directories older than max_age_hours."""
    now = time.time()
    cutoff = now - (max_age_hours * 3600)
    for p in EXPORTS_DIR.iterdir():
        try:
            if p.is_dir() and p.stat().st_mtime < cutoff:
                shutil.rmtree(p, ignore_errors=True)
            elif p.is_file() and p.stat().st_mtime < cutoff:
                p.unlink(missing_ok=True)
        except Exception:
            pass


_cleanup_old_exports()


def migrate_legacy_saves(saves_dir: Path = None):
    """One-time legacy migration for saves/None.json."""
    target_dir = saves_dir or SAVES_DIR
    none_path = target_dir / "None.json"
    if none_path.exists():
        try:
            content_str = none_path.read_text(encoding="utf-8")
            data = json.loads(content_str)
            while True:
                new_id = uuid.uuid4().hex[:8]
                new_path = target_dir / f"{new_id}.json"
                if not new_path.exists():
                    break
            data["id"] = new_id
            new_path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
            # Only remove after write succeeded
            none_path.unlink()
            print(f"[migration] Migrated legacy None.json -> {new_id}.json successfully.")
        except Exception as e:
            print(f"[migration] Warning: Failed to migrate legacy None.json: {e}")


migrate_legacy_saves()


def _get_python_executable():
    """Detect virtualenv python or fallback to current python."""
    for cand in (ROOT / ".venv" / "bin" / "python", ROOT.parent / ".venv" / "bin" / "python"):
        if cand.is_file() and os.access(cand, os.X_OK):
            return str(cand)
    return sys.executable


def _qr_b64(url: str) -> str:
    """Generate a QR code PNG as a base64 data-URL."""
    try:
        import qrcode
        from io import BytesIO
        qr = qrcode.QRCode(version=1, error_correction=qrcode.constants.ERROR_CORRECT_H, box_size=10, border=2)
        qr.add_data(url)
        qr.make(fit=True)
        img = qr.make_image(fill_color="white", back_color="transparent").convert("RGBA")
        # get_flattened_data() replaces getdata() (deprecated in Pillow 12); same pixels
        data = img.get_flattened_data() if hasattr(img, "get_flattened_data") else img.getdata()
        new_data = []
        for item in data:
            if item[0] > 240 and item[1] > 240 and item[2] > 240:
                new_data.append((255, 255, 255, 0))
            else:
                new_data.append(item)
        img.putdata(new_data)
        buf = BytesIO()
        img.save(buf, format="PNG")
        return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception as e:
        print(f"QR generation error: {e}")
        return ""


class StudioHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def send_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-API-Key")

    def _check_api_auth(self) -> bool:
        env_key = os.environ.get("STUDIO_API_KEY")
        if env_key:
            req_key = self.headers.get("X-API-Key", "").strip()
            return req_key == env_key
        # If STUDIO_API_KEY is unset, accept localhost requests only
        client_ip = self.client_address[0]
        return client_ip in ("127.0.0.1", "::1", "localhost")

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_cors()
        self.end_headers()

    def _is_safe_subpath(self, base: Path, target: Path) -> bool:
        try:
            return base.resolve() in target.resolve().parents or base.resolve() == target.resolve()
        except Exception:
            return False

    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        if path in ("/", "/index.html"):
            self._serve_file(ROOT / "index.html", "text/html; charset=utf-8")
        elif path in ("/editor.html", "/editor"):
            self._serve_file(ROOT / "editor.html", "text/html; charset=utf-8")
        elif path.startswith("/static/"):
            rel = path[len("/static/"):].lstrip("/")
            target = ROOT / "static" / rel
            if self._is_safe_subpath(ROOT / "static", target):
                self._serve_file(target)
            else:
                self.send_error(403, "Forbidden")
        elif path.startswith("/uploads/"):
            rel = path[len("/uploads/"):].lstrip("/")
            target = UPLOADS / rel
            if self._is_safe_subpath(UPLOADS, target):
                self._serve_file(target)
            else:
                self.send_error(403, "Forbidden")
        elif path.startswith("/exports/"):
            rel = path[len("/exports/"):].lstrip("/")
            target = EXPORTS_DIR / rel
            if self._is_safe_subpath(EXPORTS_DIR, target):
                self._serve_file(target)
            else:
                self.send_error(403, "Forbidden")
        elif path == "/api/tenders":
            tenders, errors = get_tender_store().scan()
            gens = get_generation_store().list(timeout_s=_gen_timeout())
            import tender_store
            items = []
            for tid, (f, raw) in tenders.items():
                summ = tender_store.summarize(raw)
                last = next((g for g in gens if g.get("tenderId") == tid), None)
                summ["generation"] = ({k: last.get(k) for k in ("runId", "status", "deckId", "url", "createdAt")}
                                      if last else None)
                items.append(summ)
            items.sort(key=lambda t: (-(t.get("matchScore") or 0), t.get("deadline") or "9999"))
            self._send_json({"status": "ok", "tenders": items, "errors": errors,
                             "generationEnabled": os.environ.get("GENERATE_MODE", "webhook") == "cli"
                             or bool(os.environ.get("GENERATE_WEBHOOK_URL", "").strip()),
                             "llmModels": groq_models()})
        elif re.fullmatch(r"/api/tenders/[A-Za-z0-9_-]{1,64}", path):
            raw = get_tender_store().get(path.rsplit("/", 1)[1])
            if raw is None:
                self._send_json({"status": "error", "message": "Tender not found"}, 404)
            else:
                self._send_json(raw)
        elif path == "/api/generations":
            q = parse_qs(parsed.query)
            tid = (q.get("tenderId") or [None])[0]
            self._send_json({"status": "ok", "generations": get_generation_store().list(tid, _gen_timeout())})
        elif re.fullmatch(r"/api/generations/[a-f0-9]{12}", path):
            rec = get_generation_store().get(path.rsplit("/", 1)[1], _gen_timeout())
            if rec is None:
                self._send_json({"status": "error", "message": "Run not found"}, 404)
            else:
                self._send_json(rec)
        elif path == "/api/templates":
            lib = get_template_library()
            self._send_json({"status": "ok", "templates": lib.summaries(), "default": lib.get_default(),
                             "errors": [{"file": k, "message": v} for k, v in lib.errors.items()]})
        elif path == "/api/templates/default":
            self._send_json({"status": "ok", "default": get_template_library().get_default()})
        elif re.fullmatch(r"/api/templates/[a-z0-9_-]{1,40}", path):
            t = get_template_library().get(path.rsplit("/", 1)[1])
            if t:
                self._send_json(t)
            else:
                self._send_json({"status": "error", "message": "Template not found"}, 404)
        elif path.startswith("/templates/assets/"):
            parts = path[len("/templates/assets/"):].split("/")
            target = get_template_library().asset_path(parts[0], parts[1]) if len(parts) == 2 else None
            if target:
                self._serve_file(target)
            else:
                self.send_error(404, "Not found")
        elif path.startswith("/templates/previews/"):
            parts = path[len("/templates/previews/"):].split("/")
            target = None
            if len(parts) == 2 and parts[1].endswith(".png"):
                target = get_template_library().preview_path(parts[0], parts[1][:-4])
            if target:
                self._serve_file(target)
            else:
                self.send_error(404, "Not found")
        elif path == "/api/saves":
            saves = []
            saves_dir = get_saves_dir(self.server)
            for f in sorted(saves_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
                try:
                    data = json.loads(f.read_text(encoding="utf-8"))
                    saves.append({
                        "id": f.stem,
                        "name": data.get("name", "Sans titre"),
                        "modified": int(f.stat().st_mtime * 1000),
                        "slideCount": len(data.get("slides", []))
                    })
                except Exception:
                    pass
            self._send_json(saves)
        elif path == "/api/config":
            has_regen = bool(os.environ.get("REGENERATE_WEBHOOK_URL", "").strip())
            self._send_json({"hasRegenerate": has_regen})
        elif path == "/api/media":
            # Shared workspace media library: uploads are intentionally not tied
            # to one deck so a bid team can reuse approved assets everywhere.
            media = []
            for f in UPLOADS.iterdir():
                if not f.is_file() or f.suffix.lower() not in ALLOWED_UPLOAD_EXTS:
                    continue
                ext = f.suffix.lower()
                if ext not in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".mp4", ".webm"}:
                    continue
                try:
                    stat = f.stat()
                    media.append({
                        "url": f"/uploads/{f.name}", "filename": f.name,
                        "type": "video" if ext in {".mp4", ".webm"} else "image",
                        "modified": int(stat.st_mtime * 1000), "size": stat.st_size,
                    })
                except OSError:
                    pass
            media.sort(key=lambda item: item["modified"], reverse=True)
            self._send_json({"media": media})
        elif path.startswith("/api/save/") or path.startswith("/api/decks/"):
            prefix = "/api/save/" if path.startswith("/api/save/") else "/api/decks/"
            rfp_id = path.split(prefix)[1].strip()
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', rfp_id):
                self._send_json({"error": "Invalid RFP id"}, 400)
                return
            if path.startswith("/api/decks/") and not self._check_api_auth():
                self._send_json({"error": "Unauthorized: invalid or missing API key"}, 401)
                return
            fpath = get_saves_dir(self.server) / f"{rfp_id}.json"
            if fpath.exists():
                data = json.loads(fpath.read_text(encoding="utf-8"))
                self._send_json(data)
            else:
                self._send_json({"error": "Not found"}, 404)
        else:
            self.send_error(404, "File not found")

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get("Content-Length", 0))

        limit = MAX_TEMPLATE_SIZE if path == "/api/templates" else MAX_UPLOAD_SIZE
        if length > limit:
            self._send_json({"status": "error", "message": f"Payload exceeds maximum limit ({limit // (1024 * 1024)} MB)"}, 413)
            return

        body = self.rfile.read(length) if length > 0 else b""

        if path == "/api/decks":
            if not self._check_api_auth():
                self._send_json({"status": "error", "message": "Unauthorized: invalid or missing API key"}, 401)
                return
            if length > MAX_DECK_SIZE:
                self._send_json({"status": "error", "message": "Deck spec exceeds maximum limit (5 MB)"}, 413)
                return
            try:
                deck_spec = json.loads(body.decode("utf-8"))
            except Exception as e:
                self._send_json({"status": "error", "message": f"Malformed JSON: {str(e)}"}, 400)
                return

            validation_errors = layout_engine.validate_deck_spec(deck_spec)
            if validation_errors:
                self._send_json({
                    "status": "error",
                    "message": "Validation failed against schema",
                    "errors": validation_errors
                }, 400)
                return

            template = None
            if deck_spec.get("template"):
                lib = get_template_library()
                template = lib.get(deck_spec["template"])
                if template is None:
                    self._send_json({"status": "error", "message": "Validation failed against schema",
                                     "errors": [f"template: unknown template '{deck_spec['template']}'. Available: {lib.ids()}"]}, 400)
                    return

            qr_url = deck_spec.get("qr_url", "")
            qr_dataurl = _qr_b64(qr_url) if qr_url else ""
            project_data, warnings = layout_engine.layout_deck(deck_spec, qr_dataurl=qr_dataurl, template=template)

            saves_dir = get_saves_dir(self.server)
            while True:
                deck_id = uuid.uuid4().hex[:8]
                if not (saves_dir / f"{deck_id}.json").exists():
                    break

            project_data["id"] = deck_id
            project_data["savedAt"] = int(time.time() * 1000)
            save_path = saves_dir / f"{deck_id}.json"
            save_path.write_text(json.dumps(project_data, indent=2, ensure_ascii=False), encoding="utf-8")

            self._send_json({
                "id": deck_id,
                "url": f"/editor.html?id={deck_id}",
                "warnings": warnings
            })
            return

        elif re.match(r'^/api/decks/[A-Za-z0-9_-]{1,64}/slides/\d+$', path):
            if not self._check_api_auth():
                self._send_json({"status": "error", "message": "Unauthorized: invalid or missing API key"}, 401)
                return
            if length > MAX_DECK_SIZE:
                self._send_json({"status": "error", "message": "Slide spec exceeds maximum limit (5 MB)"}, 413)
                return

            parts = path.strip("/").split("/")
            deck_id = parts[2]
            slide_idx = int(parts[4])

            saves_dir = get_saves_dir(self.server)
            deck_file = saves_dir / f"{deck_id}.json"
            if not deck_file.exists():
                self._send_json({"status": "error", "message": "Deck not found"}, 404)
                return

            try:
                slide_spec = json.loads(body.decode("utf-8"))
            except Exception as e:
                self._send_json({"status": "error", "message": f"Malformed JSON: {str(e)}"}, 400)
                return

            errors = layout_engine.validate_slide_spec(slide_spec, "slide")
            if errors:
                self._send_json({"status": "error", "message": "Validation failed", "errors": errors}, 400)
                return

            try:
                deck_data = json.loads(deck_file.read_text(encoding="utf-8"))
            except Exception as e:
                self._send_json({"status": "error", "message": f"Error reading deck: {e}"}, 500)
                return

            slides = deck_data.get("slides", [])
            if slide_idx < 0 or slide_idx >= len(slides):
                self._send_json({"status": "error", "message": f"Slide index {slide_idx} out of range (deck has {len(slides)} slides)"}, 400)
                return

            theme = deck_data.get("theme", {})
            new_slide = layout_engine.layout_content_slide(slide_spec, theme)
            slides[slide_idx] = new_slide
            deck_data["slides"] = slides
            deck_data["savedAt"] = int(time.time() * 1000)
            deck_file.write_text(json.dumps(deck_data, indent=2, ensure_ascii=False), encoding="utf-8")

            self._send_json({"status": "ok", "slideIndex": slide_idx, "slide": new_slide})
            return

        elif re.match(r'^/api/decks/[A-Za-z0-9_-]{1,64}/slides/\d+/regenerate$', path):
            webhook_url = os.environ.get("REGENERATE_WEBHOOK_URL", "").strip()
            if not webhook_url:
                self._send_json({"status": "error", "message": "Regeneration webhook is not configured"}, 503)
                return

            # Security: Only allow http / https URLs
            parsed_wh = urlparse(webhook_url)
            if parsed_wh.scheme not in ("http", "https"):
                self._send_json({"status": "error", "message": "Invalid webhook protocol"}, 400)
                return

            parts = path.strip("/").split("/")
            deck_id = parts[2]
            slide_idx = int(parts[4])

            saves_dir = get_saves_dir(self.server)
            deck_file = saves_dir / f"{deck_id}.json"
            if not deck_file.exists():
                self._send_json({"status": "error", "message": "Deck not found"}, 404)
                return

            try:
                deck_data = json.loads(deck_file.read_text(encoding="utf-8"))
            except Exception as e:
                self._send_json({"status": "error", "message": f"Error reading deck: {e}"}, 500)
                return

            slides = deck_data.get("slides", [])
            if slide_idx < 0 or slide_idx >= len(slides):
                self._send_json({"status": "error", "message": f"Slide index {slide_idx} out of range"}, 400)
                return

            if slide_idx == 0 or slide_idx == len(slides) - 1:
                self._send_json({"status": "error", "message": "fixed slides cannot be regenerated"}, 400)
                return

            # Forward to webhook with timeout of 60s
            import urllib.request as u_req
            import urllib.error as u_err
            wh_payload = json.dumps({"deckId": deck_id, "slideIndex": slide_idx}).encode("utf-8")
            wh_request = u_req.Request(webhook_url, data=wh_payload, method="POST")
            wh_request.add_header("Content-Type", "application/json")
            webhook_key = os.environ.get("REGENERATE_WEBHOOK_KEY", "").strip()
            if webhook_key:
                wh_request.add_header("X-API-Key", webhook_key)

            try:
                with u_req.urlopen(wh_request, timeout=60) as resp:
                    resp_body = resp.read().decode("utf-8")
                    new_slide_spec = json.loads(resp_body)
            except u_err.HTTPError as he:
                self._send_json({"status": "error", "message": f"Webhook returned HTTP {he.code}"}, 502)
                return
            except Exception as err:
                self._send_json({"status": "error", "message": f"Webhook call failed: {str(err)}"}, 504)
                return

            # Validate returned slide specification through strict schema validator
            errors = layout_engine.validate_slide_spec(new_slide_spec, "slide")
            if errors:
                self._send_json({
                    "status": "error",
                    "message": "Webhook returned invalid slide specification",
                    "errors": errors
                }, 400)
                return

            # Layout slide through safe layout engine
            theme = deck_data.get("theme", {})
            new_slide = layout_engine.layout_content_slide(new_slide_spec, theme)
            slides[slide_idx] = new_slide
            deck_data["slides"] = slides
            deck_data["savedAt"] = int(time.time() * 1000)
            deck_file.write_text(json.dumps(deck_data, indent=2, ensure_ascii=False), encoding="utf-8")

            self._send_json({"status": "ok", "slideIndex": slide_idx, "slide": new_slide})
            return

        elif path == "/api/templates":
            ctype = self.headers.get("Content-Type", "")
            if "multipart" not in ctype:
                self._send_json({"status": "error", "message": "Expected multipart upload (field 'file')"}, 400)
                return
            data, filename = self._parse_multipart_with_name(body, ctype)
            if not data:
                self._send_json({"status": "error", "message": "No file found in upload"}, 400)
                return
            if Path(filename or "").suffix.lower() not in (".pptx", ".pdf"):
                self._send_json({"status": "error", "message": "Seuls les fichiers .pptx et .pdf sont acceptés"}, 400)
                return
            try:
                t = get_template_library().import_bytes(data, Path(filename).name)
                lib = get_template_library()
                if not lib.get_default():
                    lib.set_default(t["id"])
                _render_template_previews(t["id"], self.server.server_address[1])
                self._send_json({"status": "ok", "template": {"id": t["id"], "name": t["name"], "warnings": t["warnings"],
                                                              "stats": t["stats"]}})
            except Exception as e:
                self._send_json({"status": "error", "message": f"Import impossible : {e}"}, 400)

        elif path == "/api/tenders/rescan":
            tenders, errors = get_tender_store().scan()
            self._send_json({"status": "ok", "count": len(tenders), "errors": errors})

        elif path == "/api/tenders":
            if not self._check_api_auth():
                self._send_json({"status": "error", "message": "Unauthorized: invalid or missing API key"}, 401)
                return
            if length > 1024 * 1024:
                self._send_json({"status": "error", "message": "Tender exceeds 1 MB"}, 413)
                return
            try:
                tid = get_tender_store().put(json.loads(body.decode("utf-8")))
                self._send_json({"status": "ok", "id": tid})
            except Exception as e:
                self._send_json({"status": "error", "message": str(e)}, 400)

        elif path == "/api/generations":
            try:
                payload = json.loads(body.decode("utf-8") or "{}")
            except Exception:
                self._send_json({"status": "error", "message": "Malformed JSON"}, 400)
                return
            unknown = set(payload) - {"tenderId", "templateId", "params"}
            if unknown or not isinstance(payload.get("tenderId"), str):
                self._send_json({"status": "error", "message": "Body: { tenderId, templateId?, params? }"}, 400)
                return
            code, res = start_generation(self, payload["tenderId"], payload.get("templateId"), payload.get("params"))
            self._send_json(res, code)

        elif re.fullmatch(r"/api/generations/[a-f0-9]{12}/progress", path):
            if not self._check_api_auth():
                self._send_json({"status": "error", "message": "Unauthorized: invalid or missing API key"}, 401)
                return
            try:
                patch = json.loads(body.decode("utf-8") or "{}")
            except Exception:
                self._send_json({"status": "error", "message": "Malformed JSON"}, 400)
                return
            rec = get_generation_store().update(path.split("/")[3], patch if isinstance(patch, dict) else {})
            if rec is None:
                self._send_json({"status": "error", "message": "Run not found"}, 404)
            else:
                self._send_json({"status": "ok", "runStatus": rec["status"]})

        elif path == "/api/templates/rescan":
            res = get_template_library().rescan()
            for tid in res["imported"]:
                _render_template_previews(tid, self.server.server_address[1])
            self._send_json({"status": "ok", **res})

        elif path == "/api/extract-theme":
            content_type = self.headers.get("Content-Type", "")
            if "multipart" in content_type:
                file_data, filename = self._parse_multipart_with_name(body, content_type)
                if not file_data:
                    file_data = self._parse_multipart(body, content_type)
                    filename = "presentation.pptx"

                if not file_data:
                    self._send_json({"status": "error", "message": "No file found in upload"}, 400)
                    return

                if len(file_data) > 25 * 1024 * 1024:
                    self._send_json({"status": "error", "message": "Fichier trop volumineux (limite 25 Mo dépassée)"}, 400)
                    return

                is_pdf = (filename and filename.lower().endswith(".pdf")) or file_data.startswith(b"%PDF-")
                if is_pdf:
                    import pdf_extractor
                    res = pdf_extractor.extract_pdf_theme(file_data)
                    if res.get("status") == "error":
                        self._send_json(res, 400)
                    else:
                        self._send_json({"status": "ok", "theme": res})
                else:
                    theme = extract_theme(file_data, store_media=_store_imported_media)
                    self._send_json({"status": "ok", "theme": theme})
            else:
                self._send_json({"status": "error", "message": "Expected multipart upload"}, 400)

        elif path == "/api/save":
            try:
                payload = json.loads(body.decode("utf-8"))
                raw = payload.get("id")
                is_new = raw in (None, "", "None", "null", "undefined")
                saves_dir = get_saves_dir(self.server)
                if is_new:
                    while True:
                        rfp_id = uuid.uuid4().hex[:8]
                        if not (saves_dir / f"{rfp_id}.json").exists():
                            break
                else:
                    rfp_id = str(raw).strip()

                if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', rfp_id):
                    self._send_json({"status": "error", "message": "Invalid save ID"}, 400)
                    return
                save_path = saves_dir / f"{rfp_id}.json"
                payload["id"] = rfp_id
                payload["savedAt"] = int(time.time() * 1000)
                save_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
                self._send_json({"status": "ok", "id": rfp_id})
            except Exception as e:
                self._send_json({"status": "error", "message": str(e)}, 500)

        elif path == "/api/upload":
            content_type = self.headers.get("Content-Type", "")
            if "multipart" in content_type:
                file_data, filename = self._parse_multipart_with_name(body, content_type)
                if file_data and filename:
                    ext = Path(filename).suffix.lower()
                    if ext not in ALLOWED_UPLOAD_EXTS:
                        self._send_json({"status": "error", "message": f"Unsupported file type: {ext}"}, 400)
                        return
                    if ext == ".svg":
                        is_safe, reason = _is_safe_svg(file_data)
                        if not is_safe:
                            self._send_json({"status": "error", "message": f"Rejected SVG: {reason}"}, 400)
                            return
                    safe_name = re.sub(r'[^\w.\-]', '_', filename)
                    unique = f"{uuid.uuid4().hex[:8]}_{safe_name}"
                    target = UPLOADS / unique
                    target.write_bytes(file_data)
                    self._send_json({"status": "ok", "url": f"/uploads/{unique}", "filename": unique})
                else:
                    self._send_json({"status": "error", "message": "No file uploaded"}, 400)
            else:
                try:
                    payload = json.loads(body.decode("utf-8"))
                    data_url = payload.get("data", "")
                    filename = payload.get("filename", "upload.png")
                    ext = Path(filename).suffix.lower() or ".png"
                    if ext not in ALLOWED_UPLOAD_EXTS:
                        self._send_json({"status": "error", "message": f"Unsupported file type: {ext}"}, 400)
                        return
                    if "," in data_url:
                        _, b64 = data_url.split(",", 1)
                        raw = base64.b64decode(b64)
                        if ext == ".svg":
                            is_safe, reason = _is_safe_svg(raw)
                            if not is_safe:
                                self._send_json({"status": "error", "message": f"Rejected SVG: {reason}"}, 400)
                                return
                        safe_name = re.sub(r'[^\w.\-]', '_', filename)
                        unique = f"{uuid.uuid4().hex[:8]}_{safe_name}"
                        target = UPLOADS / unique
                        target.write_bytes(raw)
                        self._send_json({"status": "ok", "url": f"/uploads/{unique}", "filename": unique})
                    else:
                        self._send_json({"status": "error", "message": "Invalid data URL"}, 400)
                except Exception as e:
                    self._send_json({"status": "error", "message": str(e)}, 500)

        elif path == "/api/qrcode":
            try:
                payload = json.loads(body.decode("utf-8"))
                url = payload.get("url", "https://example.com")
                b64 = _qr_b64(url)
                self._send_json({"status": "ok", "dataurl": b64})
            except Exception as e:
                self._send_json({"status": "error", "message": str(e)}, 500)

        elif path == "/api/export":
            try:
                payload = json.loads(body.decode("utf-8"))
                fmt = payload.get("format", "pdf")
                if fmt not in ("pdf", "pptx"):
                    self._send_json({"status": "error", "message": "Invalid format requested"}, 400)
                    return

                html_content = payload.get("html", "")
                if not html_content:
                    self._send_json({"status": "error", "message": "No HTML content provided"}, 400)
                    return

                export_id = uuid.uuid4().hex[:12]
                export_folder = EXPORTS_DIR / export_id
                export_folder.mkdir(parents=True, exist_ok=True)
                html_path = export_folder / "deck.html"
                html_path.write_text(html_content, encoding="utf-8")

                if fmt == "pdf":
                    err = self._export_pdf(html_path, export_folder)
                elif fmt == "pptx":
                    slide_cnt = int(payload.get("slideCount", 1))
                    project_data = payload.get("project")
                    err = self._export_pptx(html_path, export_folder, slide_cnt, project_data=project_data)

                out_file = export_folder / f"deck.{fmt}"
                if out_file.exists():
                    self._send_json({"status": "ok", "url": f"/exports/{export_id}/deck.{fmt}"})
                else:
                    msg = err or "Export file was not generated"
                    self._send_json({"status": "error", "message": msg}, 500)
            except Exception as e:
                self._send_json({"status": "error", "message": str(e)}, 500)

        else:
            self.send_error(404, "Endpoint not found")

    def do_PUT(self):
        path = unquote(urlparse(self.path).path)
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(min(length, 65536)) if length > 0 else b""
        if path != "/api/templates/default":
            self._send_json({"status": "error", "message": "Not found"}, 404)
            return
        try:
            payload = json.loads(body.decode("utf-8") or "{}")
            get_template_library().set_default(payload.get("id"))
            self._send_json({"status": "ok", "default": get_template_library().get_default()})
        except Exception as e:
            self._send_json({"status": "error", "message": str(e)}, 400)

    def do_DELETE(self):
        """Delete one saved deck; shared uploaded media deliberately remains available."""
        path = unquote(urlparse(self.path).path)
        dmatch = re.fullmatch(r"/api/tenders/([A-Za-z0-9_-]{1,64})", path)
        if dmatch:
            if not self._check_api_auth():
                self._send_json({"status": "error", "message": "Unauthorized: invalid or missing API key"}, 401)
                return
            if get_tender_store().delete(dmatch.group(1)):
                self._send_json({"status": "ok", "id": dmatch.group(1)})
            else:
                self._send_json({"status": "error", "message": "Tender not found"}, 404)
            return
        tmatch = re.fullmatch(r"/api/templates/([a-z0-9_-]{1,40})", path)
        if tmatch:
            if get_template_library().delete(tmatch.group(1)):
                self._send_json({"status": "ok", "id": tmatch.group(1)})
            else:
                self._send_json({"status": "error", "message": "Template not found"}, 404)
            return
        match = re.fullmatch(r"/api/save/([A-Za-z0-9_-]{1,64})", path)
        if not match:
            self._send_json({"status": "error", "message": "Not found"}, 404)
            return
        deck_id = match.group(1)
        target = get_saves_dir(self.server) / f"{deck_id}.json"
        if not target.exists():
            self._send_json({"status": "error", "message": "Deck not found"}, 404)
            return
        try:
            target.unlink()
            self._send_json({"status": "ok", "id": deck_id})
        except OSError as exc:
            self._send_json({"status": "error", "message": str(exc)}, 500)

    def _export_url(self, html_path: Path) -> str:
        """The export HTML over HTTP from this server: images use /uploads/... and /templates/...
        paths, which a file:// page cannot load (they pointed to file:///uploads/...)."""
        rel = html_path.resolve().relative_to(EXPORTS_DIR.resolve()).as_posix()
        return f"http://127.0.0.1:{self.server.server_address[1]}/exports/{rel}"

    def _export_pdf(self, html_path: Path, out_dir: Path):
        """Use Playwright to render the HTML to PDF."""
        py_bin = _get_python_executable()
        out_file = out_dir / "deck.pdf"
        script = f'''
import sys
from playwright.sync_api import sync_playwright
try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page()
        page.goto("{self._export_url(html_path)}")
        page.wait_for_timeout(1000)
        page.emulate_media(media="print")
        page.pdf(
            path="{out_file}",
            width="20in", height="11.25in",
            scale=96/72,
            print_background=True,
            margin={{"top":"0","right":"0","bottom":"0","left":"0"}}
        )
        browser.close()
except Exception as e:
    sys.stderr.write(str(e))
    sys.exit(1)
'''
        res = subprocess.run([py_bin, "-c", script], capture_output=True, text=True, cwd=str(ROOT))
        if res.returncode != 0:
            return res.stderr or "Playwright PDF export failed"
        return None

    def _export_pptx(self, html_path: Path, out_dir: Path, slide_count: int, project_data: Optional[Dict[str, Any]] = None):
        """Export presentation as native editable PowerPoint objects, with slide screenshot fallback on error."""
        out_file = out_dir / "deck.pptx"

        # 1. Primary path: Native PPTX objects via pptx_exporter
        if project_data and isinstance(project_data, dict):
            try:
                import pptx_exporter
                pptx_exporter.UPLOADS_DIR = UPLOADS            # the folders this server really serves
                pptx_exporter.TEMPLATES_DIR = get_template_library().base
                ok, warnings = pptx_exporter.export_deck_to_pptx(project_data, out_file)
                if ok and out_file.exists():
                    return None
            except Exception as err:
                sys.stderr.write(f"pptx_exporter failed: {err}\n")

        # 2. Fallback path: Whole-slide screenshot fallback
        py_bin = _get_python_executable()
        script = f'''
import sys, json
from playwright.sync_api import sync_playwright
from pptx import Presentation
from pptx.util import Inches

try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        z = 200 / 72
        page = browser.new_page(viewport={{"width": round(1920 * z), "height": round(1080 * z)}}, device_scale_factor=1)
        page.goto("{self._export_url(html_path)}")
        page.wait_for_timeout(1500)
        page.add_style_tag(content="body{{margin:0;background:none}}.slide-page{{margin:0;zoom:" + str(z) + "}}")

        slides = page.query_selector_all(".slide-page")
        pngs = []
        for i, el in enumerate(slides):
            path = f"{out_dir}/slide_{{i+1:02d}}.png"
            el.screenshot(path=path)
            pngs.append(path)

        browser.close()

        prs = Presentation()
        prs.slide_width = Inches(13.333)
        prs.slide_height = Inches(7.5)
        blank = prs.slide_layouts[6]
        for png in pngs:
            slide = prs.slides.add_slide(blank)
            slide.shapes.add_picture(png, 0, 0, width=prs.slide_width, height=prs.slide_height)
        prs.save("{out_file}")
except Exception as e:
    sys.stderr.write(str(e))
    sys.exit(1)
'''
        res = subprocess.run([py_bin, "-c", script], capture_output=True, text=True, cwd=str(ROOT))
        if res.returncode != 0:
            return res.stderr or "Playwright PPTX export failed"
        return None

    def _parse_multipart(self, body, content_type):
        boundary = self._get_boundary(content_type)
        if not boundary:
            return None
        parts = body.split(b"--" + boundary.encode())
        for part in parts:
            if b"filename=" in part:
                idx = part.find(b"\r\n\r\n")
                if idx >= 0:
                    return part[idx + 4:].rstrip(b"\r\n--")
        return None

    def _parse_multipart_with_name(self, body, content_type):
        boundary = self._get_boundary(content_type)
        if not boundary:
            return None, None
        parts = body.split(b"--" + boundary.encode())
        for part in parts:
            if b"filename=" in part:
                header_end = part.find(b"\r\n\r\n")
                header = part[:header_end].decode("utf-8", errors="ignore")
                m = re.search(r'filename="([^"]+)"', header)
                filename = m.group(1) if m else "upload"
                data = part[header_end + 4:].rstrip(b"\r\n--")
                if data.endswith(b"--"):
                    data = data[:-2]
                if data.endswith(b"\r\n"):
                    data = data[:-2]
                return data, filename
        return None, None

    def _get_boundary(self, content_type):
        m = re.search(r'boundary=(.+?)(?:;|$)', content_type)
        return m.group(1).strip() if m else None

    def _serve_file(self, filepath, ctype=None):
        filepath = Path(filepath)
        if not filepath.exists() or not filepath.is_file():
            self.send_error(404, f"Not found: {filepath.name}")
            return
        if ctype is None:
            ext = filepath.suffix.lower()
            ctype = {
                ".html": "text/html; charset=utf-8",
                ".css": "text/css; charset=utf-8",
                ".js": "application/javascript; charset=utf-8",
                ".json": "application/json; charset=utf-8",
                ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                ".svg": "image/svg+xml", ".gif": "image/gif", ".webp": "image/webp",
                ".mp4": "video/mp4", ".webm": "video/webm",
                ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
                ".pdf": "application/pdf",
                ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            }.get(ext, "application/octet-stream")
        data = filepath.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_cors()
        self.end_headers()
        self.wfile.write(data)

    def _send_json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_cors()
        self.end_headers()
        self.wfile.write(data)


def run(port=8091):
    autoimport_templates()
    server = ThreadingHTTPServer(("0.0.0.0", port), StudioHandler)
    try:
        lib = get_template_library()
        for tid in lib.ids():
            if not lib.preview_path(tid, "content"):
                _render_template_previews(tid, port)
    except Exception as e:
        print(f"[templates] previews skipped: {e}")
    print(f"\n{'='*65}")
    print(f"  🚀 RFP Slide Deck Studio v{VERSION} — LIVE (ThreadingHTTPServer)")
    print(f"     http://localhost:{port}")
    print(f"{'='*65}\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8091
    run(port)
