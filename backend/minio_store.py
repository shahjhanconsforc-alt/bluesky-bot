"""The object store: sessions, and the Campaign panel's Messages and Media.

Sessions. An account's session is its Chrome profile - Bluesky keeps the
sign-in inside the page's own storage, and the profile directory is where that
storage lives. It is kept on MinIO, one zip per account in the sessions bucket
(`session-acct-<id>.zip`, the shape the other bots on this MinIO use), and
NOT in the project: the directory Chrome actually runs on is a cache under the
user's local app data that is filled from the bucket before a window opens and
written back when a sign-in lands and when the window closes. Logging out or
removing the account deletes every object of that session from the bucket and
the cache with it.

Messages and media are read from the Instagram bot's buckets, exactly as the
Pinterest bot reads them: the drafts table in MINIO_MESSAGES_BUCKET /
MINIO_MESSAGES_OBJECT and every picture in MINIO_MEDIA_BUCKET. Read-only here;
that file is edited where it was written.

Every call is synchronous (the minio client is) and short: three seconds to
connect, no retries. A MinIO that is switched off must say so at once rather
than hang a panel. The async server runs these through asyncio.to_thread.
"""

from __future__ import annotations

import io
import json
import mimetypes
import re
import shutil
import urllib.parse
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import config

IMAGE_TYPES = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp")

# What a Chrome profile carries that is NOT the session: caches, GPU shader
# blobs, crash dumps, metrics, and the lock files of a running instance. Left
# out of the zip - they are rebuilt by Chrome, and they are most of the bytes.
SKIP_DIRS = {
    "Cache", "Code Cache", "GPUCache", "ShaderCache", "GrShaderCache", "DawnCache",
    "DawnGraphiteCache", "DawnWebGPUCache", "Crashpad", "BrowserMetrics",
    "CacheStorage", "Service Worker", "optimization_guide_model_store",
    "OptimizationGuidePredictionModels", "component_crx_cache", "extensions_crx_cache",
    "Safe Browsing", "segmentation_platform", "blob_storage", "File System",
    "Download Service", "MediaDeviceSalts", "WebStorage", "Platform Notifications",
    "VideoDecodeStats", "Feature Engagement Tracker", "AutofillStrikeDatabase",
    "shared_proto_db", "Site Characteristics Database", "heavy_ad_intervention_opt_out.db",
    "PersistentOriginTrials", "commerce_subscription_db", "parcel_tracking_db",
    "ZxcvbnData", "Extension State", "Extension Rules", "Extension Scripts",
}
SKIP_FILES = {"lockfile", "LOCK", "SingletonLock", "SingletonSocket", "SingletonCookie",
              "DevToolsActivePort", "RunningChromeVersion", "CrashpadMetrics-active.pma",
              "first_party_sets.db", "first_party_sets.db-journal"}
SKIP_SUFFIXES = (".tmp", ".old", "-journal", ".bak", ".log.old")

ETAG_MARK = ".minio-etag"       # in the cache dir: which upload this copy is


class MinioError(Exception):
    pass


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── client ───────────────────────────────────────────────────────────────────

def settings() -> dict[str, Any]:
    url = config.MINIO_URL.strip()
    return {
        "endpoint": re.sub(r"^https?://", "", url).rstrip("/"),
        "secure": url.startswith("https://") or config.MINIO_SECURE,
        "user": config.MINIO_USER,
        "password": config.MINIO_PASSWORD,
        "bucket": config.MINIO_BUCKET,
        "sessions_bucket": config.MINIO_SESSIONS_BUCKET,
        "messages_bucket": config.MINIO_MESSAGES_BUCKET,
        "messages": config.MINIO_MESSAGES_OBJECT,
        "media_bucket": config.MINIO_MEDIA_BUCKET,
        "media": config.MINIO_MEDIA_PREFIX,
    }


def configured() -> bool:
    cfg = settings()
    return bool(cfg["endpoint"] and cfg["user"])


def client():
    cfg = settings()
    if not configured():
        raise MinioError("MinIO is not configured - set MINIO_URL, MINIO_USER and "
                         "MINIO_PASSWORD in backend/.env")
    try:
        from minio import Minio
        import urllib3
    except ImportError:
        raise MinioError("The minio package is missing - run: pip install minio")
    http = urllib3.PoolManager(timeout=urllib3.Timeout(connect=3, read=30),
                               retries=urllib3.Retry(total=0))
    return Minio(cfg["endpoint"], access_key=cfg["user"], secret_key=cfg["password"],
                 secure=cfg["secure"], http_client=http), cfg


def call(fn, bucket: str = ""):
    """Run one MinIO call, turning its many failure types into one message."""
    try:
        return fn()
    except MinioError:
        raise
    except Exception as e:  # noqa: BLE001 - every transport and S3 error lands here
        code = getattr(e, "code", None)
        if code == "NoSuchKey":
            raise MinioError("not found in the bucket")
        if code == "NoSuchBucket":
            raise MinioError(f"bucket {bucket or '?'} does not exist")
        if code in ("AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch"):
            raise MinioError("MinIO refused the login - check MINIO_USER / MINIO_PASSWORD")
        raise MinioError(f"MinIO at {settings()['endpoint']} is not reachable "
                         f"({type(e).__name__})")


def read(c, bucket: str, name: str) -> bytes:
    resp = c.get_object(bucket, name)
    try:
        return resp.read()
    finally:
        resp.close()
        resp.release_conn()


def put(c, bucket: str, name: str, data: bytes, content_type: str = "application/octet-stream") -> None:
    call(lambda: c.put_object(bucket, name, io.BytesIO(data), length=len(data),
                              content_type=content_type), bucket)


def ensure_bucket(c, bucket: str) -> None:
    """The sessions bucket is this bot's own, so it is made on first use. The
    insta buckets are not touched: a missing one is reported, not created."""
    if not call(lambda: c.bucket_exists(bucket), bucket):
        call(lambda: c.make_bucket(bucket), bucket)


def status() -> dict[str, Any]:
    cfg = settings()
    if not configured():
        return {"configured": False, "up": False, "bucket": None,
                "detail": "not configured - see backend/.env"}
    try:
        c, cfg = client()
        exists = call(lambda: c.bucket_exists(cfg["sessions_bucket"]), cfg["sessions_bucket"])
    except MinioError as e:
        return {"configured": True, "up": False, "bucket": cfg["sessions_bucket"], "detail": str(e)}
    return {"configured": True, "up": True, "bucket": cfg["sessions_bucket"],
            "detail": "reachable" if exists else
            f"reachable - {cfg['sessions_bucket']} is made on the first saved session"}


# ── sessions ─────────────────────────────────────────────────────────────────

def session_object(account_id: str) -> str:
    return f"session-acct-{account_id}.zip"


def session_meta_object(account_id: str) -> str:
    return f"session-acct-{account_id}.json"


def _wanted(rel: Path) -> bool:
    if any(part in SKIP_DIRS for part in rel.parts[:-1]):
        return False
    name = rel.name
    if name in SKIP_FILES or name.endswith(SKIP_SUFFIXES):
        return False
    return True


def zip_profile(profile: Path) -> bytes:
    """The profile directory as a zip, caches and lock files left out. A file
    Chrome still holds exclusively is skipped rather than failing the save:
    the session itself (Local Storage, Cookies, IndexedDB) reads fine."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for path in sorted(profile.rglob("*")):
            if not path.is_file():
                continue
            rel = path.relative_to(profile)
            if not _wanted(rel):
                continue
            try:
                z.write(path, rel.as_posix())
            except OSError:
                continue
    return buf.getvalue()


def unzip_profile(data: bytes, profile: Path) -> None:
    """Replace the cache directory with the zip's contents. A path that would
    land outside the directory is refused - the zip came off the network."""
    shutil.rmtree(profile, ignore_errors=True)
    profile.mkdir(parents=True, exist_ok=True)
    root = profile.resolve()
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            target = (profile / info.filename).resolve()
            if root not in target.parents:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with z.open(info) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)


def session_upload(account_id: str, profile: Path, meta: dict[str, Any]) -> dict[str, Any]:
    """Write the profile to the bucket as the session, with a small JSON
    beside it saying whose it is and when. Returns what was written."""
    c, cfg = client()
    bucket = cfg["sessions_bucket"]
    ensure_bucket(c, bucket)
    data = zip_profile(profile)
    put(c, bucket, session_object(account_id), data, "application/zip")
    record = {**meta, "account_id": str(account_id), "saved_at": now(), "bytes": len(data)}
    put(c, bucket, session_meta_object(account_id),
        json.dumps(record, indent=2).encode("utf-8"), "application/json")
    stat = call(lambda: c.stat_object(bucket, session_object(account_id)), bucket)
    (profile / ETAG_MARK).write_text(stat.etag or "", encoding="utf-8")
    return {"bucket": bucket, "object": session_object(account_id), "bytes": len(data)}


def session_stat(account_id: str):
    """The zip's stat, or None when there is no saved session for the account."""
    c, cfg = client()
    bucket = cfg["sessions_bucket"]
    try:
        return call(lambda: c.stat_object(bucket, session_object(account_id)), bucket)
    except MinioError as e:
        if "not found" in str(e) or "does not exist" in str(e):
            return None
        raise


def session_download(account_id: str, profile: Path) -> bool:
    """Fill the cache directory from the bucket. True when the directory was
    (re)written, False when there is no saved session or the cache already
    holds exactly the saved copy."""
    stat = session_stat(account_id)
    if stat is None:
        return False
    mark = profile / ETAG_MARK
    if mark.is_file() and mark.read_text(encoding="utf-8").strip() == (stat.etag or "") \
            and (profile / "Default").is_dir():
        return False
    c, cfg = client()
    data = call(lambda: read(c, cfg["sessions_bucket"], session_object(account_id)),
                cfg["sessions_bucket"])
    unzip_profile(data, profile)
    mark.write_text(stat.etag or "", encoding="utf-8")
    return True


def session_delete(account_id: str) -> int:
    """Remove every object of the session from the bucket: the zip, its JSON,
    and anything else filed under that account's name. Returns how many."""
    c, cfg = client()
    bucket = cfg["sessions_bucket"]
    if not call(lambda: c.bucket_exists(bucket), bucket):
        return 0
    prefix = f"session-acct-{account_id}."
    names = [o.object_name for o in call(lambda: list(c.list_objects(bucket, prefix=prefix)), bucket)
             if o.object_name.startswith(prefix)]
    for name in names:
        call(lambda n=name: c.remove_object(bucket, n), bucket)
    return len(names)


def sessions_saved() -> dict[str, dict[str, Any]]:
    """account id -> {saved_at, bytes} for every session in the bucket."""
    c, cfg = client()
    bucket = cfg["sessions_bucket"]
    if not call(lambda: c.bucket_exists(bucket), bucket):
        return {}
    out: dict[str, dict[str, Any]] = {}
    for o in call(lambda: list(c.list_objects(bucket, prefix="session-acct-")), bucket):
        m = re.fullmatch(r"session-acct-(.+)\.zip", o.object_name)
        if m:
            out[m.group(1)] = {"saved_at": o.last_modified.isoformat() if o.last_modified else "",
                               "bytes": o.size}
    return out


# ── messages ─────────────────────────────────────────────────────────────────

def parse_drafts(text: str) -> list[dict[str, Any]]:
    """The drafts file the other bots share: a tab-separated table with a
    header row - id, name, text, disabled. A draft is named by its name, else
    its id, and a non-empty "disabled" cell keeps it out of rotation.

    A plain text file (no such header) still works: drafts separated by a
    blank line, or one per line when there are no blank lines at all."""
    text = text.replace("\r\n", "\n").strip()
    if not text:
        return []
    lines = text.split("\n")
    header = [h.strip().lower() for h in lines[0].split("\t")]
    if "text" in header:
        col = {h: i for i, h in enumerate(header)}
        drafts = []
        for n, line in enumerate(lines[1:], 1):
            cells = line.split("\t")

            def cell(key: str) -> str:
                return cells[col[key]].strip() if key in col and col[key] < len(cells) else ""

            # The other bots escape a line break in a cell as \n (and \t, \\).
            body = re.sub(r"\\([nrt\\])",
                          lambda m: {"n": "\n", "r": "\r", "t": "\t"}.get(m.group(1), "\\"),
                          cell("text"))
            if not body:
                continue
            drafts.append({
                "name": cell("name") or cell("id") or f"sms{n}",
                "text": body,
                "enabled": cell("disabled").lower() in ("", "0", "false", "no"),
            })
        return drafts
    parts = re.split(r"\n\s*\n", text) if re.search(r"\n\s*\n", text) else lines
    return [{"name": f"sms{i + 1}", "text": p.strip(), "enabled": True}
            for i, p in enumerate(p for p in parts if p.strip())]


def messages() -> dict[str, Any]:
    c, cfg = client()
    bucket, name = cfg["messages_bucket"], cfg["messages"]
    try:
        raw = call(lambda: read(c, bucket, name), bucket)
    except MinioError as e:
        raise MinioError(f"{bucket}/{name}: {e}")
    return {"drafts": parse_drafts(raw.decode("utf-8-sig", errors="replace")),
            "bucket": bucket, "object": name}


# ── media ────────────────────────────────────────────────────────────────────

def media() -> dict[str, Any]:
    c, cfg = client()
    bucket, prefix = cfg["media_bucket"], cfg["media"]
    objects = call(lambda: list(c.list_objects(bucket, prefix=prefix, recursive=True)), bucket)
    out, skipped = [], 0
    for o in objects:
        if o.is_dir:
            continue
        if not o.object_name.lower().endswith(IMAGE_TYPES):
            skipped += 1
            continue
        out.append({
            "name": o.object_name[len(prefix):] or o.object_name,
            "object": o.object_name,
            "size": o.size,
            "url": "/api/minio/object?name=" + urllib.parse.quote(o.object_name),
            "source": "minio",
        })
    return {"media": out, "skipped": skipped, "bucket": bucket, "prefix": prefix}


def media_object(name: str) -> tuple[bytes, str]:
    """One picture's bytes and type, for an <img> on the page. Only images
    from the media bucket - this is not a way to read anything else."""
    c, cfg = client()
    if (not name.startswith(cfg["media"]) or ".." in name
            or not name.lower().endswith(IMAGE_TYPES)):
        raise MinioError("not a media file")
    data = call(lambda: read(c, cfg["media_bucket"], name), cfg["media_bucket"])
    return data, mimetypes.guess_type(name)[0] or "application/octet-stream"
