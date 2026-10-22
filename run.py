"""Start the bluesky-bot console.

Double-click run.bat, or `python run.py` from this folder. The console comes up
at http://127.0.0.1:4300 and the browser is opened on it.

Two ways to serve, picked at start:

  1. The real backend, when there is one. If backend/app.py defines a FastAPI
     `app`, this runs it under uvicorn and the console talks to it.
  2. The frontend alone, otherwise. The backend files in this repo are still
     empty, so for now this is what runs: a plain static server over frontend/
     with mock.js answering the API out of localStorage. Nothing opens a
     browser window or touches bsky.app in that mode — it is the design, live.

Host and port come from backend/.env (XBOT_HOST, XBOT_PORT) when that file
exists, so the same address serves both modes.
"""

from __future__ import annotations

import os
import socket
import sys
import threading
import time
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
FRONTEND = HERE / "frontend"
ENV_FILE = HERE / "backend" / ".env"

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 4300


def read_env(path: Path) -> dict[str, str]:
    """KEY=value lines, `#` comments and blanks skipped. No quoting rules: the
    values this file carries are a host, a port and a few flags."""
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        out[key.strip()] = value.strip()
    return out


def address() -> tuple[str, int]:
    env = {**read_env(ENV_FILE), **os.environ}
    host = env.get("XBOT_HOST", DEFAULT_HOST) or DEFAULT_HOST
    try:
        port = int(env.get("XBOT_PORT", DEFAULT_PORT))
    except ValueError:
        port = DEFAULT_PORT
    return host, port


def open_browser_later(url: str, host: str, port: int, timeout: float = 30.0) -> None:
    """Open the page once the server is actually accepting connections.

    Not on a fixed timer: a page that loads before the server is listening has
    its first API call fail, and the console then runs with nothing behind it
    for that whole visit. So this waits on the port (uvicorn's startup, the
    playwright import) and opens the tab only when a connection goes through.
    From a thread rather than before serve_forever(), so a port already in use
    fails loudly instead of opening a tab onto whatever else is listening."""
    if os.environ.get("XBOT_NO_BROWSER") == "1":   # a script driving the page itself
        return
    target = "127.0.0.1" if host in ("0.0.0.0", "") else host

    def go() -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                with socket.create_connection((target, port), timeout=1):
                    break
            except OSError:
                time.sleep(0.25)
        webbrowser.open(url)

    threading.Thread(target=go, daemon=True).start()


# ── Mode 1: the backend, if there is one ─────────────────────────────────────

def backend_app():
    """The FastAPI app from backend/app.py, or None while that file is empty or
    does not define one. Import errors other than 'nothing there' are shown:
    a half-written backend should fail visibly, not fall back to the mock."""
    sys.path.insert(0, str(HERE))
    try:
        from backend import app as module  # type: ignore
    except ModuleNotFoundError as exc:
        top = (exc.name or "").split(".")[0]
        if top in ("fastapi", "starlette", "pydantic", "uvicorn", "playwright", "multipart"):
            print(f"The backend needs the '{top}' package. Install it with:\n"
                  f"    pip install -r backend/requirements.txt\n"
                  f"    python -m playwright install chromium\n"
                  "Serving the frontend alone until then — no real browser windows.")
            return None
        if top == "backend":
            return None
        raise
    return getattr(module, "app", None)


def run_backend(app, host: str, port: int) -> None:
    import uvicorn  # only needed in this mode

    reload = os.environ.get("XBOT_RELOAD", read_env(ENV_FILE).get("XBOT_RELOAD", "0")) == "1"
    print(f"bluesky-bot backend on http://{host}:{port}")
    open_browser_later(f"http://{host}:{port}/", host, port)
    if reload:
        uvicorn.run("backend.app:app", host=host, port=port, reload=True)
    else:
        uvicorn.run(app, host=host, port=port)


# ── Mode 2: the frontend on its own ──────────────────────────────────────────

class ConsoleHandler(SimpleHTTPRequestHandler):
    """frontend/ at the root, nothing cached.

    `no-store` on everything: app.js is one script with its wiring at top level,
    and a stale copy of it over fresh markup renders a console whose buttons do
    nothing. The page is tiny; re-fetching it is cheaper than that bug."""

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:
        # One line per request is noise on a page that polls; keep errors only.
        if args and str(args[1]).startswith(("4", "5")):
            super().log_message(fmt, *args)


def run_static(host: str, port: int) -> None:
    if not (FRONTEND / "index.html").is_file():
        sys.exit(f"frontend/index.html not found under {HERE}")
    handler = partial(ConsoleHandler, directory=str(FRONTEND))
    try:
        server = ThreadingHTTPServer((host, port), handler)
    except OSError as exc:
        sys.exit(f"Could not listen on {host}:{port} — {exc}. "
                 "Another server is on that port; set XBOT_PORT in backend/.env.")
    url = f"http://{host}:{port}/"
    print(f"bluesky-bot console on {url}")
    print("No backend yet — mock.js is answering the API from localStorage.")
    print("Ctrl+C stops the server.")
    open_browser_later(url, host, port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        server.server_close()


def main() -> None:
    os.chdir(HERE)
    host, port = address()
    app = backend_app()
    if app is not None:
        run_backend(app, host, port)
    else:
        run_static(host, port)


if __name__ == "__main__":
    main()
