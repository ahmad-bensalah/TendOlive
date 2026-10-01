"""Start the RAG dashboard and open it in the browser.

    python app.py            (or double-click start.bat on Windows / run ./start.sh)
    python app.py --port 8005 --no-browser
    python app.py --host 0.0.0.0   (only if n8n in Docker cannot reach http://host.docker.internal:8001)

If the dashboard is already running, this opens it instead of starting a second copy.
Keep the window open while you use the dashboard. Press Ctrl+C to stop.
"""
import argparse
import json
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

MODELS = ("intfloat/multilingual-e5-small", "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1")
LOCAL_HOST = "127.0.0.1"
BIND_HOST = os.getenv("RAG_HOST", "127.0.0.1")


def models_cached() -> bool:
    """Check if default models exist locally in Hugging Face cache."""
    cache = os.getenv("HF_HUB_CACHE") or os.path.join(
        os.getenv("HF_HOME") or os.path.join(Path.home(), ".cache", "huggingface"), "hub"
    )
    for repo in MODELS:
        snapshots = Path(cache) / ("models--" + repo.replace("/", "--")) / "snapshots"
        if not any(snapshots.glob("*/config.json")):
            return False
    return True


def check_port(port: int, wait_seconds: int = 0) -> str:
    """Inspect port occupancy: returns 'dashboard', 'other', or 'closed'."""
    deadline = time.time() + wait_seconds
    notified = False
    while True:
        try:
            with urllib.request.urlopen(f"http://{LOCAL_HOST}:{port}/health", timeout=3) as response:
                data = json.load(response)
            ours = isinstance(data, dict) and data.get("status") == "ok" and "index_ready" in data
            return "dashboard" if ours else "other"
        except urllib.error.HTTPError:
            return "other"
        except urllib.error.URLError as e:
            if not isinstance(e.reason, (socket.timeout, TimeoutError)):
                return "closed"
        except (socket.timeout, TimeoutError):
            pass
        except Exception:
            return "other"

        if time.time() > deadline:
            return "other"
        if not notified:
            print(f"  Port {port} is active; waiting for existing instance initialization...")
            notified = True
        time.sleep(1)


def reserve_port(start: int):
    """Bind and listen on the first free port now, before the models load,
    so two starts cannot pick the same port.

    Returns (socket, port), or (None, port) when our dashboard already runs on that port.
    """
    for port in range(start, start + 20):
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):  # Windows: nobody else may share the port
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        else:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((BIND_HOST, port))
            sock.listen(128)
            sock.set_inheritable(True)
            return sock, port
        except OSError:
            sock.close()
        if check_port(port, wait_seconds=600) == "dashboard":
            return None, port
        print(f"  Port {port} is used by another program, trying {port + 1}...")
    raise SystemExit(f"No free port between {start} and {start + 19}.")


def open_when_ready(url: str):
    for _ in range(900):  # the first run downloads the models, so wait up to 15 minutes
        try:
            with urllib.request.urlopen(url + "health", timeout=2):
                break
        except OSError:
            time.sleep(1)
    else:
        return
    # /health answers only after the models are loaded (see the lifespan in rag/api.py)
    print(f"  Ready: {url}\n")
    webbrowser.open(url)


def main():
    ap = argparse.ArgumentParser(description="Start the RAG dashboard.")
    ap.add_argument("--port", type=int, default=8001)
    ap.add_argument("--host", default=None,
                    help="address to listen on (default 127.0.0.1, this PC only). 0.0.0.0 also accepts "
                         "other machines and Docker containers.")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    global BIND_HOST
    BIND_HOST = args.host or BIND_HOST

    os.chdir(Path(__file__).resolve().parent)
    sys.path.insert(0, os.getcwd())

    sock, port = reserve_port(args.port)
    url = f"http://{LOCAL_HOST}:{port}/"
    if sock is None:
        print(f"\n  The dashboard is already running: {url}")
        print("  Opening it in the browser. (To stop it, close the window where it runs, or press Ctrl+C there.)\n")
        if not args.no_browser:
            webbrowser.open(url)
        return

    if models_cached():
        # Models are on disk: work fully offline (no Hugging Face requests or warnings).
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
    else:
        print("First run: downloading the models (about 1 GB). This happens only once.")

    print("\n  OliveSoft RAG dashboard")
    print(f"  Starting... the browser opens by itself when it is ready: {url}")
    print("  Keep this window open. Press Ctrl+C to stop.\n")
    if BIND_HOST != LOCAL_HOST:
        print(f"  Listening on {BIND_HOST}: network clients can connect to this instance.\n")
    if not args.no_browser:
        threading.Thread(target=open_when_ready, args=(url,), daemon=True).start()

    import uvicorn
    config = uvicorn.Config("rag.api:app", host=BIND_HOST, port=port, log_level="warning")
    try:
        uvicorn.Server(config).run(sockets=[sock])
    except KeyboardInterrupt:
        pass
    finally:
        sock.close()


if __name__ == "__main__":
    main()
