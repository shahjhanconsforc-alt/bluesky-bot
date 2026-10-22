"""Where the server runs and where it keeps things.

Read from backend/.env when that file exists, then from the environment, so a
value exported in the shell wins over the file. Nothing here is secret: the
account passwords live in the store under data/, never in the environment.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent
ROOT_DIR = BACKEND_DIR.parent
FRONTEND_DIR = ROOT_DIR / "frontend"
DATA_DIR = BACKEND_DIR / "data"
STORE_FILE = DATA_DIR / "accounts.json"

BSKY_URL = "https://bsky.app/"
# Bluesky's own Video feed (the "Video" tab): every post on it is a video.
BSKY_VIDEO_URL = "https://bsky.app/profile/did:plc:z72i7hdynmk6r22z27h6tvur/feed/thevids"


def _read_env_file(path: Path) -> dict[str, str]:
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


_ENV = {**_read_env_file(BACKEND_DIR / ".env"), **os.environ}


def env(key: str, default: str = "") -> str:
    return _ENV.get(key, default) or default


HOST = env("XBOT_HOST", "127.0.0.1")
PORT = int(env("XBOT_PORT", "4300") or 4300)
HEADLESS = env("XBOT_HEADLESS", "0") == "1"
# "chrome" drives the installed Google Chrome; blank means Playwright's own
# Chromium. Chrome is the default when it is on the machine, because a sign-in
# done in the browser the operator already knows is the less unusual client.
BROWSER_CHANNEL = env("XBOT_BROWSER_CHANNEL", "chrome")
# How long a freshly opened window is watched for the sign-in to land before
# the watcher gives up (the window stays open; only the task ends).
SIGNIN_WAIT_SECONDS = int(env("XBOT_SIGNIN_WAIT", "1200") or 1200)

# Where Chrome actually runs an account's profile. NOT in the project: the
# session lives on MinIO (below), and this is only the working copy, filled
# from the bucket before a window opens and written back after. Under the
# user's local app data by default; XBOT_PROFILE_CACHE points it elsewhere.
_cache_default = Path(os.environ.get("LOCALAPPDATA") or tempfile.gettempdir()) / "bluesky-bot" / "profiles"
PROFILES_DIR = Path(env("XBOT_PROFILE_CACHE", str(_cache_default)))

# ── MinIO ───────────────────────────────────────────────────────────────────
# The sessions bucket is this bot's own (made on first use). Messages and
# media are the Instagram bot's buckets, read as they are.
MINIO_URL = env("MINIO_URL", "")
MINIO_USER = env("MINIO_USER", "")
MINIO_PASSWORD = env("MINIO_PASSWORD", "")
MINIO_SECURE = env("MINIO_SECURE", "0") == "1"
MINIO_BUCKET = env("MINIO_BUCKET", "")
MINIO_SESSIONS_BUCKET = env("MINIO_SESSIONS_BUCKET", "bluesky-bot-sessions")
# The handles file a scrape writes: a tab table (handle, name, bio, followers
# ...) in MINIO_BUCKET, beside the other bots' username files.
MINIO_HANDLES_OBJECT = env("MINIO_HANDLES_OBJECT", "bluesky_handles.txt")
MINIO_MESSAGES_BUCKET = env("MINIO_MESSAGES_BUCKET", "campaign-sms")
MINIO_MESSAGES_OBJECT = env("MINIO_MESSAGES_OBJECT", "sms_drafts.txt")
MINIO_MEDIA_BUCKET = env("MINIO_MEDIA_BUCKET", "campaign-media")
MINIO_MEDIA_PREFIX = os.environ.get("MINIO_MEDIA_PREFIX", _ENV.get("MINIO_MEDIA_PREFIX", ""))
