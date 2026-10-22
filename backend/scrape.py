"""Scraping: the Home feed, one account at a time, every new author hovered.

What a run does, in every ticked window at once: scrolls bsky.app's Home,
and for every post by an author not yet collected, hovers the author's name.
Bluesky pops its profile card on that hover - name, handle, bio, followers -
and to draw it the web app asks its server for the profile. That reply is
what is read: the window's traffic is listened to for
`app.bsky.actor.getProfile`, which names the account outright (handle,
displayName, description, followersCount, and whether its chat takes
incoming messages). The card's own text is kept beside it as `card`. When the
app already had the profile cached and asked for nothing, the public API is
asked for the same record, so a row is never left half-read.

Rows land in three places as they are found: the run's frame (the Scraping
panel's table, polled through its task), an append-only file under data/ so
a restart loses nothing, and - every few rows and at the end - the handles
file on MinIO, the shared text record the other bots on this machine keep.

A run has no end of its own: it scrolls until Stop. A window whose feed goes
quiet for longer than the stall limit is reloaded and walked on.
"""

from __future__ import annotations

import asyncio
import json
import random
import re
import threading
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any

from . import config, tasks
from . import minio_store as minio
from .automation.browser import browser
from .store import store

PUBLIC_PROFILE = "https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor="
PROFILE_CALL = "app.bsky.actor.getProfile"

SCRAPE_FILE = config.DATA_DIR / "scraped.jsonl"
# When the record was last wiped. Sent with the rows, so a page that mirrored
# them into its own store drops that copy the next time it looks.
CLEARED_FILE = config.DATA_DIR / "scraped.cleared"
FRAME_ROWS = 500          # the tail a frame carries; the count rides beside it
PUSH_EVERY = 25           # rows between MinIO writes while a run is going

TARGET = {"key": "home", "name": "Home feed", "mode": "feed",
          "note": "the home feed of the account it runs as"}
TARGET_FOLLOWERS = {"key": "followers", "name": "Followers", "mode": "followers",
                    "note": "the followers of the authors on the home feed"}
TARGETS = {"feed": TARGET, "followers": TARGET_FOLLOWERS}
FOLLOWERS_CALL = "app.bsky.graph.getFollowers"

_file_lock = threading.Lock()


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── the record on disk ───────────────────────────────────────────────────────

def save_row(row: dict[str, Any]) -> None:
    """Append one row. One object per line, so a crash mid-write costs at most
    the last line; best effort, because the live row is already in memory."""
    with _file_lock:
        try:
            SCRAPE_FILE.parent.mkdir(parents=True, exist_ok=True)
            with open(SCRAPE_FILE, "a", encoding="utf-8") as f:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
        except OSError:
            pass


def saved_rows() -> list[dict[str, Any]]:
    """Everything ever collected, newest line per handle winning."""
    seen: dict[str, dict[str, Any]] = {}
    with _file_lock:
        try:
            with open(SCRAPE_FILE, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        r = json.loads(line)
                    except ValueError:
                        continue
                    h = str(r.get("handle") or "").lstrip("@").strip().lower()
                    if h:
                        seen[h] = r
        except OSError:
            pass
    return list(seen.values())


# ── the handles file on MinIO ────────────────────────────────────────────────

COLUMNS = ("handle", "name", "bio", "followers", "following", "posts", "did", "by", "scraped_at")


def _clean(v: Any) -> str:
    return re.sub(r"[\t\r\n]+", " ", str(v if v is not None else "")).strip()


def parse_handles(text: str) -> list[dict[str, Any]]:
    """The handles file: a tab table with a `handle` header column (this bot
    writes one), or one `@handle` per line (the older shape)."""
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    text = (text or "").replace("\r\n", "\n").strip()
    if not text:
        return rows
    lines = text.split("\n")
    header = [h.strip().lower() for h in lines[0].split("\t")]
    if "handle" in header and len(header) > 1:
        col = {h: i for i, h in enumerate(header)}
        for line in lines[1:]:
            if not line.strip():
                continue
            cells = line.split("\t")

            def get(key: str) -> str:
                return cells[col[key]].strip() if key in col and col[key] < len(cells) else ""

            h = get("handle").lstrip("@").strip()
            if not h or h.lower() in seen:
                continue
            seen.add(h.lower())
            rows.append({"handle": h, "name": get("name"), "bio": get("bio"),
                         "followers": _int_or_none(get("followers")),
                         "following": _int_or_none(get("following")),
                         "posts": _int_or_none(get("posts")), "did": get("did"),
                         "by": get("by"), "at": get("scraped_at"), "dm_open": None})
    else:
        for line in lines:
            h = line.strip().lstrip("@").strip()
            if h and h.lower() not in seen:
                seen.add(h.lower())
                rows.append({"handle": h, "name": "", "bio": "", "followers": None, "dm_open": None})
    return rows


def _int_or_none(s: str) -> int | None:
    try:
        return int(float(s))
    except (TypeError, ValueError):
        return None


def dump_handles(rows: list[dict[str, Any]]) -> bytes:
    out = ["\t".join(COLUMNS)]
    for r in rows:
        out.append("\t".join(_clean(r.get(k if k != "scraped_at" else "at", "")) for k in COLUMNS))
    return ("\n".join(out) + "\n").encode("utf-8")


def handles_read() -> tuple[list[dict[str, Any]], str, str]:
    """What the handles file holds. A missing file is an empty list - the
    first push is what creates it."""
    c, cfg = minio.client()
    bucket, name = cfg["bucket"], config.MINIO_HANDLES_OBJECT
    if not bucket:
        raise minio.MinioError("MINIO_BUCKET is not set in backend/.env")
    try:
        raw = minio.call(lambda: minio.read(c, bucket, name), bucket)
    except minio.MinioError as e:
        if "not found" in str(e):
            return [], bucket, name
        raise
    return parse_handles(raw.decode("utf-8-sig", errors="replace")), bucket, name


def handles_push(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Merge rows into the handles file by handle. A row already there is
    refreshed with the fuller record (a bio where there was none); nothing is
    dropped. Reports how many were new against the file."""
    existing, bucket, name = handles_read()
    by_handle = {r["handle"].lower(): r for r in existing}
    new = skipped = 0
    for r in rows:
        h = str(r.get("handle") or "").lstrip("@").strip()
        if not h:
            continue
        key = h.lower()
        if key in by_handle:
            old = by_handle[key]
            for k in ("name", "bio", "did", "by", "at"):
                if r.get(k):
                    old[k] = r[k]
            for k in ("followers", "following", "posts"):
                if r.get(k) is not None:
                    old[k] = r[k]
            skipped += 1
        else:
            by_handle[key] = {"handle": h, **{k: r.get(k) for k in
                              ("name", "bio", "followers", "following", "posts", "did", "by", "at")}}
            new += 1
    c, cfg = minio.client()
    minio.put(c, bucket, name, dump_handles(list(by_handle.values())), "text/plain; charset=utf-8")
    return {"new": new, "skipped": skipped, "total": len(by_handle), "bucket": bucket, "object": name}


# ── the run ──────────────────────────────────────────────────────────────────

RUN: dict[str, Any] = {
    "running": False, "task": None, "started_at": "", "ended_at": "", "note": "",
    "rows": [], "lanes": {}, "known": set(), "stop": None, "unpushed": 0, "done": [],
    "target": TARGET, "walked": set(),      # walked: profiles whose followers were read
}

# The author's name on their post, for the click that opens the profile.
# Same link as the hover: the one with the display name.
FOLLOWERS_LINK_JS = """(h) => {
  const a = [...document.querySelectorAll('a[href$="/followers"]')].find(a => a.getBoundingClientRect().height > 0);
  if (!a) return null;
  const r = a.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, href: a.getAttribute('href') };
}"""

# The followers list as drawn: one link per follower, its text being the
# name, the handle and the first line of the bio. Read when the app had the
# page cached and asked its server for nothing.
FOLLOWERS_DOM_JS = """() => {
  const root = document.querySelector('[data-testid="profileFollowersScreen"]') || document;
  const out = [], seen = new Set();
  for (const a of root.querySelectorAll('a[href^="/profile/"]')) {
    const lines = a.innerText.split('\n').map(t => t.trim()).filter(Boolean);
    const at = lines.find(t => t.startsWith('@'));
    const h = at ? at.slice(1) : (a.getAttribute('href') || '').split('/')[2];
    if (!h || h.startsWith('did:') || seen.has(h.toLowerCase())) continue;
    seen.add(h.toLowerCase());
    const name = lines.find(t => !t.startsWith('@')) || '';
    const bio = lines.filter(t => t !== name && !t.startsWith('@')).join(' ');
    out.push({ handle: h, name: name === h ? '' : name, bio });
  }
  return out;
}"""

# Posts on the page by authors not in `skip`, top to bottom: the handle off
# the item's own test id, which Bluesky names after the author.
ITEMS_JS = """(skip) => {
  const out = [], seen = new Set(skip);
  for (const it of document.querySelectorAll('[data-testid^="feedItem-by-"]')) {
    const h = it.getAttribute('data-testid').slice('feedItem-by-'.length);
    if (!h || seen.has(h.toLowerCase())) continue;
    seen.add(h.toLowerCase());
    const r = it.getBoundingClientRect();
    if (r.height < 10) continue;
    out.push({ handle: h, top: r.top, bottom: r.bottom });
  }
  out.sort((a, b) => a.top - b.top);
  return { items: out, height: window.innerHeight };
}"""

# The author's NAME on their post - the link with text, not the avatar - and
# where it is on screen once scrolled into view.
NAME_AT_JS = """(h) => {
  const it = document.querySelector('[data-testid="feedItem-by-' + CSS.escape(h) + '"]');
  if (!it) return null;
  const links = [...it.querySelectorAll('a[href="/profile/' + h + '"]')];
  const link = links.find(a => a.innerText.trim() && !a.innerText.trim().startsWith('@')) || links.find(a => a.innerText.trim()) || links[0];
  if (!link) return null;
  const r = link.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return { x: r.left + Math.min(r.width / 2, 40), y: r.top + r.height / 2, name: link.innerText.trim(),
           top: r.top, height: window.innerHeight };
}"""

# Where the name is right now, once the smooth scroll has stopped moving it.
NAME_RECT_JS = """(h) => {
  const it = document.querySelector('[data-testid="feedItem-by-' + CSS.escape(h) + '"]');
  if (!it) return null;
  const links = [...it.querySelectorAll('a[href="/profile/' + h + '"]')];
  const link = links.find(a => a.innerText.trim() && !a.innerText.trim().startsWith('@')) || links.find(a => a.innerText.trim()) || links[0];
  if (!link) return null;
  const r = link.getBoundingClientRect();
  return { x: r.left + Math.min(r.width / 2, 40), y: r.top + r.height / 2, top: r.top,
           name: link.innerText.trim(), height: window.innerHeight };
}"""


async def human_scroll(page: Any, total: int, stop: asyncio.Event) -> None:
    """Scroll `total` pixels the way a hand on a wheel does: a run of small
    ticks, uneven in size and timing, a breath now and then, and once in a
    while a short nudge back up as if something caught the eye."""
    vw = page.viewport_size or {"width": 1200, "height": 800}
    # The pointer sits over the feed column, where a reader's hand would be.
    await page.mouse.move(random.randint(int(vw["width"] * 0.35), int(vw["width"] * 0.6)),
                          random.randint(int(vw["height"] * 0.3), int(vw["height"] * 0.7)), steps=8)
    done = 0
    sign = 1 if total >= 0 else -1
    total = abs(total)
    while done < total and not stop.is_set():
        tick = min(random.randint(60, 140), total - done)
        await page.mouse.wheel(0, sign * tick)
        done += tick
        await asyncio.sleep(random.uniform(0.03, 0.11))
        if random.random() < 0.08:                      # a breath mid-scroll
            await asyncio.sleep(random.uniform(0.3, 0.9))
        if random.random() < 0.03:                      # a glance back up
            back = random.randint(80, 200)
            for _ in range(2):
                await page.mouse.wheel(0, -back // 2)
                await asyncio.sleep(random.uniform(0.05, 0.12))
            await asyncio.sleep(random.uniform(0.4, 1.0))
            done -= back


async def bring_into_band(page: Any, handle: str, stop: asyncio.Event) -> dict[str, Any] | None:
    """Wheel the page, tick by tick, until the author's name sits in the
    middle band of the window - the way a reader scrolls a post up to read it
    - and say where the name is then. None if the post has gone."""
    for _ in range(3):
        at = await page.evaluate(NAME_RECT_JS, handle)
        if at is None:
            return None
        height = at.get("height") or 800
        low, high = height * 0.25, height * 0.7
        if low <= at["top"] <= high:
            return at
        want = at["top"] - random.uniform(height * 0.35, height * 0.55)
        await human_scroll(page, int(want), stop)
        await asyncio.sleep(random.uniform(0.15, 0.35))
    return await page.evaluate(NAME_RECT_JS, handle)

# The profile card Bluesky pops on the hover: the floating box that says
# "followers" and is not the post itself. Its text, for the row's `card`.
CARD_TEXT_JS = """() => {
  const boxes = [...document.querySelectorAll('div')].filter(d => {
    const t = d.innerText || '';
    if (!/followers/i.test(t) || t.length > 700) return false;
    const r = d.getBoundingClientRect();
    return r.width > 200 && r.width < 460 && r.height > 60 && r.height < 520 && !d.closest('[data-testid^="feedItem-by-"]');
  });
  const b = boxes[boxes.length - 1];
  return b ? b.innerText.trim() : '';
}"""


def frame(tail: int = FRAME_ROWS) -> dict[str, Any]:
    lanes = []
    for l in RUN["lanes"].values():
        lanes.append({k: v for k, v in l.items() if k != "rows"} | {"rows": l["rows"][-tail:]})
    target = RUN["target"]
    return {
        "running": RUN["running"], "task": RUN["task"],
        "target": target, "mode": target["mode"],
        "rows": RUN["rows"][-tail:], "total": len(RUN["rows"]),
        "lanes": lanes, "done": RUN["done"],
        "started_at": RUN["started_at"], "ended_at": RUN["ended_at"], "note": RUN["note"],
    }


def cleared_at() -> str:
    try:
        return CLEARED_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def all_rows() -> dict[str, Any]:
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for r in saved_rows() + list(RUN["rows"]):
        h = str(r.get("handle") or "").lower()
        if h and h not in seen:
            seen.add(h)
            merged.append(r)
    return {"rows": merged, "total": len(merged), "cleared_at": cleared_at()}


def clear_all(minio_too: bool = True) -> dict[str, Any]:
    """Every scraped handle, gone: the record on disk, the live run's rows,
    the handles file on MinIO, and - through the marker - every page's
    mirrored copy. A run that is going keeps going from zero."""
    if RUN["running"]:
        raise ValueError("The scrape is still running — stop it first.")
    on_disk = len(saved_rows())
    with _file_lock:
        try:
            SCRAPE_FILE.unlink()
        except OSError:
            pass
    RUN.update(rows=[], lanes={}, done=[], task=None, started_at="", ended_at="", note="",
               known=set(), walked=set(), unpushed=0)
    stamp = now()
    CLEARED_FILE.parent.mkdir(parents=True, exist_ok=True)
    CLEARED_FILE.write_text(stamp, encoding="utf-8")
    removed_minio = False
    minio_note = ""
    if minio_too:
        try:
            c, cfg = minio.client()
            c.remove_object(cfg["bucket"], config.MINIO_HANDLES_OBJECT)
            removed_minio = True
        except minio.MinioError as exc:
            minio_note = str(exc)
        except Exception as exc:  # noqa: BLE001 - no such file is fine
            minio_note = exc.__class__.__name__
    return {"ok": True, "removed": on_disk, "minio": removed_minio, "minio_note": minio_note,
            "cleared_at": stamp}


def open_accounts() -> list[dict[str, Any]]:
    """The windows a run can walk: every account with a window open."""
    out = []
    for a in store.accounts():
        if browser.is_open(a["id"]):
            lane = RUN["lanes"].get(a["id"])
            out.append({"id": a["id"], "account": "@" + a["login"], "label": a.get("label", ""),
                        "busy": "", "count": lane["count"] if lane else 0,
                        "error": lane["error"] if lane else ""})
    return out


def dm_open_for(data: dict[str, Any]) -> bool:
    """Whether THIS account can message the profile, off Bluesky's own chat
    setting: `all` takes anyone; `following` only people the profile
    follows, so it is open exactly when the profile follows this account;
    `none` takes nobody. No setting at all is Bluesky's default, which is
    `following`."""
    chat = ((data.get("associated") or {}).get("chat") or {}).get("allowIncoming") or "following"
    viewer = data.get("viewer") or {}
    if chat == "all":
        return True
    if chat == "none":
        return False
    return bool(viewer.get("followedBy"))


def _profile_row(data: dict[str, Any], by: str, card: str) -> dict[str, Any]:
    dm_open = dm_open_for(data)
    return {
        "handle": str(data.get("handle") or ""), "name": str(data.get("displayName") or ""),
        "bio": str(data.get("description") or ""), "followers": data.get("followersCount"),
        "following": data.get("followsCount"), "posts": data.get("postsCount"),
        "did": str(data.get("did") or ""), "dm_open": dm_open, "card": card,
        "by": by, "at": now(),
    }


def _public_followers(handle: str, limit: int = 0) -> list[dict[str, Any]]:
    """The whole followers list off the public API, page after page. Empty
    when offline or the list is hidden; never an error."""
    out: list[dict[str, Any]] = []
    cursor = ""
    for _ in range(400):                                   # 40,000 at most
        url = (PUBLIC_PROFILE.replace("app.bsky.actor.getProfile?actor=", "app.bsky.graph.getFollowers?actor=")
               + urllib.parse.quote(handle) + "&limit=100" + (f"&cursor={urllib.parse.quote(cursor)}" if cursor else ""))
        try:
            with urllib.request.urlopen(url, timeout=15) as r:
                data = json.load(r)
        except Exception:  # noqa: BLE001
            break
        out.extend(data.get("followers") or [])
        cursor = str(data.get("cursor") or "")
        if not cursor or (limit and len(out) >= limit):
            break
    return out


def _public_profile(handle: str) -> dict[str, Any] | None:
    try:
        with urllib.request.urlopen(PUBLIC_PROFILE + urllib.parse.quote(handle), timeout=10) as r:
            return json.load(r)
    except Exception:  # noqa: BLE001 - offline or gone: the row is kept bare
        return None


class Lane:
    def __init__(self, account: dict[str, Any], settings: dict[str, Any]) -> None:
        self.id = account["id"]
        self.login = account["login"]
        self.settings = settings
        self.profiles: dict[str, dict[str, Any]] = {}      # handle (lower) -> getProfile reply
        self.followers: list[dict[str, Any]] = []            # getFollowers replies, as they come
        self.followers_pages = 0                             # pages of the list seen so far
        self.followers_end = False                           # the last page has come
        self.state = RUN["lanes"][self.id]

    # the window's traffic: every profile card Bluesky draws asks for this
    async def _on_response(self, response: Any) -> None:
        if not response.ok:
            return
        if FOLLOWERS_CALL in response.url:
            try:
                data = await response.json()
            except Exception:  # noqa: BLE001
                return
            self.followers.extend(data.get("followers") or [])
            self.followers_pages += 1
            # No cursor on a page means it was the last one: the list is read.
            if not data.get("cursor"):
                self.followers_end = True
            return
        if PROFILE_CALL not in response.url:
            return
        try:
            data = await response.json()
        except Exception:  # noqa: BLE001
            return
        handle = str(data.get("handle") or "").lower()
        if handle:
            self.profiles[handle] = data

    def _say(self, status: str) -> None:
        self.state["status"] = status

    # How long one step - a hover, a profile, a followers list - may take
    # before it counts as stuck and the page is refreshed.
    STEP_TIMEOUT = 90.0
    REOPEN_TRIES = 6          # a closed window is reopened this many times

    async def run(self, stop: asyncio.Event) -> None:
        """The lane, for as long as the run goes. Nothing short of Stop ends
        it: an error or a stuck step refreshes the page and walks on, a
        window that closed is opened again, and only a window that will not
        reopen after several tries gives the lane up."""
        reopen_failures = 0
        while not stop.is_set():
            ctx = browser.contexts.get(self.id)
            if ctx is None:
                self._say("window closed - opening it again")
                try:
                    await browser.open(self.id)
                    reopen_failures = 0
                except Exception as exc:  # noqa: BLE001
                    reopen_failures += 1
                    self.state["error"] = f"could not reopen the window: {str(exc)[:120]}"
                    if reopen_failures >= self.REOPEN_TRIES:
                        self.state.update(running=False, status="gave up: the window will not reopen")
                        return
                    await asyncio.sleep(10)
                    continue
                ctx = browser.contexts.get(self.id)
                if ctx is None:
                    await asyncio.sleep(5)
                    continue
                self.state["restarts"] += 1
            try:
                page = ctx.pages[0] if ctx.pages else await ctx.new_page()
            except Exception:  # noqa: BLE001 - the context died under us
                await asyncio.sleep(3)
                continue
            listener = lambda r: asyncio.ensure_future(self._on_response(r))  # noqa: E731
            ctx.on("response", listener)
            try:
                if RUN["target"]["mode"] == "followers":
                    await self._walk_followers(page, stop)
                else:
                    await self._walk(page, stop)
                # The walk only returns on Stop.
                break
            except asyncio.CancelledError:
                self.state.update(running=False, status="stopped")
                raise
            except Exception as exc:  # noqa: BLE001 - refreshed and walked on, never fatal
                self.state["restarts"] += 1
                self.state["error"] = ""
                self._say(f"stuck ({exc.__class__.__name__}) - refreshing and carrying on")
                await self._refresh(page)
            finally:
                try:
                    ctx.remove_listener("response", listener)
                except Exception:  # noqa: BLE001
                    pass
        self.state.update(running=False, status="stopped")

    async def _refresh(self, page: Any) -> None:
        """Home again, whatever state the page is in. A page that will not
        load is left for the outer loop, which reopens the window."""
        await asyncio.sleep(random.uniform(1.5, 3.0))
        try:
            await asyncio.wait_for(page.goto(config.BSKY_URL, wait_until="domcontentloaded"), 30)
            await asyncio.sleep(random.uniform(2.0, 3.5))
        except Exception:  # noqa: BLE001
            try:
                await page.close()
            except Exception:  # noqa: BLE001
                pass

    async def _step(self, coro, what: str):
        """One step under a clock: past STEP_TIMEOUT it is stuck, and the
        error that raises is what refreshes the page."""
        try:
            return await asyncio.wait_for(coro, self.STEP_TIMEOUT)
        except asyncio.TimeoutError:
            raise RuntimeError(f"{what} took longer than {int(self.STEP_TIMEOUT)}s") from None

    async def _walk(self, page: Any, stop: asyncio.Event) -> None:
        pause_min = float(self.settings.get("scroll_pause_min", 0.8) or 0)
        pause_max = max(pause_min, float(self.settings.get("scroll_pause_max", 2.4) or 0))
        stall = float(self.settings.get("scrape_stall_seconds", 90) or 0)
        hover_wait = float(self.settings.get("hover_wait", 2.5) or 2.5)

        self._say("opening Home")
        if "bsky.app" not in page.url or urllib.parse.urlsplit(page.url).path not in ("", "/"):
            await asyncio.wait_for(page.goto(config.BSKY_URL, wait_until="domcontentloaded"), 45)
        await page.bring_to_front()
        await asyncio.sleep(2)
        loop = asyncio.get_running_loop()
        last_new = loop.time()
        seen: set[str] = set()

        trouble = 0                       # passes in a row that went wrong
        while not stop.is_set():
            try:
                found = await self._step(page.evaluate(ITEMS_JS, list(seen | RUN["known"])), "reading the feed")
                height = found.get("height") or 800
                # Only the posts on screen (or just under its edge). The ones
                # further down are reached by the wheel on the next pass.
                handles = [o["handle"] for o in found.get("items", []) if o["top"] < height * 1.1]
                for h in handles:
                    if stop.is_set():
                        break
                    seen.add(h.lower())
                    if h.lower() == self.login.lower():
                        continue                               # the account's own posts
                    self._say(f"hovering @{h}")
                    row = await self._step(self._hover(page, h, hover_wait, stop), f"hovering @{h}")
                    if row is None:
                        continue
                    self._add(row)
                    last_new = loop.time()
                    await asyncio.sleep(random.uniform(0.3, 0.9))

                # Further down the feed, a few posts at a time and tick by tick.
                # Bluesky loads more as the bottom nears.
                self._say("scrolling")
                await self._step(human_scroll(page, random.randint(500, 900), stop), "scrolling")
                await asyncio.sleep(random.uniform(pause_min, pause_max))
                trouble = 0
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - this pass went wrong: refresh, walk on
                trouble += 1
                self.state["restarts"] += 1
                self._say(f"stuck ({exc.__class__.__name__}) - refreshing Home")
                if trouble >= 3:
                    raise                 # the page itself is the problem: the runner reopens it
                await self._refresh(page)
                last_new = loop.time()
                continue

            if stall and loop.time() - last_new > stall:
                self.state["restarts"] += 1
                self._say("quiet too long - reloading Home")
                await self._refresh(page)
                last_new = loop.time()

    # ── followers: open a profile off Home, read who follows it ─────────────

    async def _go_home(self, page: Any) -> None:
        """Back to Home: the rail's own Home, else the address."""
        home = page.locator('nav[role="navigation"] a[aria-label="Home"], a[aria-label="Home"]').first
        try:
            if await home.count() and await home.is_visible():
                box = await home.bounding_box()
                if box:
                    await page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2,
                                          steps=random.randint(6, 12))
                    await page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
                    await asyncio.sleep(random.uniform(1.0, 2.0))
                    if urllib.parse.urlsplit(page.url).path in ("", "/"):
                        return
        except Exception:  # noqa: BLE001
            pass
        await page.goto(config.BSKY_URL, wait_until="domcontentloaded")
        await asyncio.sleep(random.uniform(1.5, 2.5))

    async def _open_profile(self, page: Any, handle: str, stop: asyncio.Event) -> bool:
        """Click the author's name on their post; True once the profile is up."""
        at = await page.evaluate(NAME_AT_JS, handle)
        if not at:
            return False
        height = at.get("height") or 800
        if not (height * 0.2 <= at["top"] <= height * 0.75):
            at = await bring_into_band(page, handle, stop) or at
            if not at.get("x"):
                return False
        await page.mouse.move(at["x"] + random.randint(-30, 30), at["y"] + random.randint(-20, 20),
                              steps=random.randint(8, 14))
        await asyncio.sleep(random.uniform(0.05, 0.15))
        await page.mouse.move(at["x"], at["y"], steps=random.randint(4, 8))
        await page.mouse.click(at["x"], at["y"])
        for _ in range(40):
            if "/profile/" in page.url:
                break
            await asyncio.sleep(0.2)
        else:
            return False
        await asyncio.sleep(random.uniform(1.2, 2.2))
        return True

    async def _open_followers(self, page: Any, handle: str, stop: asyncio.Event) -> bool:
        """The profile's own "N followers" link; the address when it is not drawn."""
        # A short look at the profile first, as a person would.
        await human_scroll(page, random.randint(150, 350), stop)
        await asyncio.sleep(random.uniform(0.4, 0.9))
        await human_scroll(page, -random.randint(150, 350), stop)
        at = await page.evaluate(FOLLOWERS_LINK_JS, handle)
        if at:
            await page.mouse.move(at["x"] + random.randint(-20, 20), at["y"] + random.randint(-8, 8),
                                  steps=random.randint(8, 14))
            await page.mouse.move(at["x"], at["y"], steps=random.randint(3, 6))
            await page.mouse.click(at["x"], at["y"])
        else:
            await page.goto(f"{config.BSKY_URL}profile/{handle}/followers", wait_until="domcontentloaded")
        try:
            await page.locator('[data-testid="profileFollowersScreen"]').first.wait_for(timeout=10000)
        except Exception:  # noqa: BLE001
            return page.url.rstrip("/").endswith("/followers")
        return True

    def _follower_row(self, f: dict[str, Any], of: str) -> dict[str, Any]:
        dm_open = dm_open_for(f)
        return {"handle": str(f.get("handle") or ""), "name": str(f.get("displayName") or ""),
                "bio": str(f.get("description") or ""), "followers": None, "following": None,
                "posts": None, "did": str(f.get("did") or ""), "dm_open": dm_open,
                "card": "", "by": "@" + self.login, "follower_of": "@" + of, "at": now()}

    # A list counts as read when this much of the profile's follower count
    # has been seen - the count includes accounts the list never shows
    # (suspended, blocked, deleted), so 100% is not reachable on a big list.
    LIST_DONE_SHARE = 0.9
    # Passes with nothing new before a list is given up on. Each pass nudges
    # the list again, so a slow server gets a fair wait, not a quick exit.
    LIST_QUIET_PASSES = 10

    def _begin_list(self) -> None:
        """Before a followers list opens: its pages are collected from the
        first one, which arrives while the page is still loading."""
        self.followers = []
        self.followers_pages = 0
        self.followers_end = False

    async def _read_followers(self, page: Any, of: str, limit: int, stop: asyncio.Event) -> int:
        """Scroll the list to its end and take every follower on it. The app
        asks its server for each page of the list as the bottom nears; those
        replies are what is read (the drawn list when none come), and a page
        without a cursor is the last one. The profile's own follower count,
        from the profile reply, says how far along the read is; `limit`, when
        not 0, caps it."""
        taken: set[str] = set()
        got, quiet = 0, 0
        expected = int((self.profiles.get(of.lower()) or {}).get("followersCount") or 0)
        if not expected:
            # The profile reply was not seen (cached): the public record has the count.
            data = await asyncio.to_thread(_public_profile, of)
            expected = int((data or {}).get("followersCount") or 0)
        enough = int(expected * self.LIST_DONE_SHARE) if expected else 0
        await asyncio.sleep(random.uniform(1.0, 1.8))

        def done() -> bool:
            if limit and got >= limit:
                return True
            if self.followers_end and not self.followers:
                return True                     # the last page came and was taken
            if enough and got >= enough and not self.followers:
                return True
            return quiet >= self.LIST_QUIET_PASSES

        while not stop.is_set() and not done():
            fresh = 0
            batch = list(self.followers)
            self.followers = []
            if not batch:
                try:
                    batch = await page.evaluate(FOLLOWERS_DOM_JS)
                except Exception:  # noqa: BLE001
                    batch = []
            for f in batch:
                h = str(f.get("handle") or "").lower()
                if not h or h in taken or h.startswith("did:"):
                    continue
                taken.add(h)
                got += 1
                fresh += 1
                row = self._follower_row(f, of)
                if row["handle"].lower() in RUN["known"]:
                    self.state["dupes"] += 1
                else:
                    self._add(row)
                if limit and got >= limit:
                    break
            quiet = 0 if fresh else quiet + 1
            share = f" of {expected:,} ({got * 100 // expected}%)" if expected else ""
            self._say(f"reading followers of @{of}: {got:,}{share}")
            self.state["list"] = {"of": "@" + of, "read": got, "expected": expected,
                                  "pages": self.followers_pages, "end": self.followers_end}
            if quiet and quiet % 3 == 0:
                # Nothing came for a while: back up a screen and down again,
                # which is what makes the list ask for its next page.
                await human_scroll(page, -random.randint(600, 900), stop)
                await asyncio.sleep(random.uniform(0.6, 1.0))
            await human_scroll(page, random.randint(700, 1100), stop)
            await asyncio.sleep(random.uniform(0.9, 1.8) if not quiet else random.uniform(1.5, 2.5))
        # The window's list has ended (or gone quiet). Bluesky's public record
        # of the same list is read through to the end and anyone the window
        # did not show - scrolled past, not drawn, a page that never came - is
        # taken from there, so the list is whole.
        if not stop.is_set() and not (limit and got >= limit):
            filled = 0
            for f in await asyncio.to_thread(_public_followers, of, 0 if not limit else limit):
                h = str(f.get("handle") or "").lower()
                if not h or h in taken or h.startswith("did:"):
                    continue
                taken.add(h)
                got += 1
                filled += 1
                row = self._follower_row(f, of)
                if row["handle"].lower() in RUN["known"]:
                    self.state["dupes"] += 1
                else:
                    self._add(row)
                if limit and got >= limit:
                    break
            if filled:
                self.state["list"] = {**(self.state.get("list") or {}), "read": got, "filled": filled}
        self._say(f"@{of}: {got:,} follower(s) read" + (f" of {expected:,}" if expected else "")
                  + (" - whole list" if self.followers_end or (enough and got >= enough) else ""))
        return got

    async def _walk_followers(self, page: Any, stop: asyncio.Event) -> None:
        pause_min = float(self.settings.get("scroll_pause_min", 0.8) or 0)
        pause_max = max(pause_min, float(self.settings.get("scroll_pause_max", 2.4) or 0))
        stall = float(self.settings.get("scrape_stall_seconds", 90) or 0)
        # 0: the whole list, which is the default. A number caps each profile.
        limit = int(float(self.settings.get("scrape_followers_max", 0) or 0))

        self._say("opening Home")
        await self._go_home(page)
        loop = asyncio.get_running_loop()
        last_new = loop.time()

        trouble = 0
        while not stop.is_set():
            try:
                found = await self._step(page.evaluate(ITEMS_JS, list(RUN["walked"])), "reading the feed")
                height = found.get("height") or 800
                authors = [o["handle"] for o in found.get("items", [])
                           if o["top"] < height * 1.1 and o["handle"].lower() != self.login.lower()]
                if authors:
                    h = authors[0]
                    RUN["walked"].add(h.lower())
                    self._say(f"opening @{h}")
                    if await self._step(self._open_profile(page, h, stop), f"opening @{h}"):
                        self._say(f"opening followers of @{h}")
                        self._begin_list()
                        if await self._step(self._open_followers(page, h, stop), f"followers of @{h}"):
                            # The list is read under the stall clock: a list
                            # that stops answering is left, not waited on.
                            # A whole list can be long; the read is only cut
                            # off when it has gone quiet, not by a clock here.
                            got = await self._read_followers(page, h, limit, stop)
                            self.state["profiles"] = self.state.get("profiles", 0) + 1
                            if got:
                                last_new = loop.time()
                        else:
                            self._say(f"@{h}: followers list did not open")
                    self._say("back to Home")
                    await self._step(self._go_home(page), "going Home")
                    await asyncio.sleep(random.uniform(pause_min, pause_max))
                    trouble = 0
                    continue

                # Nobody new on screen: further down the feed, tick by tick.
                self._say("scrolling Home")
                await self._step(human_scroll(page, random.randint(500, 900), stop), "scrolling")
                await asyncio.sleep(random.uniform(pause_min, pause_max))
                trouble = 0
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - this pass went wrong: refresh, walk on
                trouble += 1
                self.state["restarts"] += 1
                self._say(f"stuck ({exc.__class__.__name__}) - refreshing Home")
                if trouble >= 3:
                    raise                 # the page itself is the problem: the runner reopens it
                await self._refresh(page)
                last_new = loop.time()
                continue

            if stall and loop.time() - last_new > stall:
                self.state["restarts"] += 1
                self._say("quiet too long - reloading Home")
                await self._refresh(page)
                last_new = loop.time()

    async def _hover(self, page: Any, handle: str, hover_wait: float,
                     stop: asyncio.Event | None = None) -> dict[str, Any] | None:
        stop = stop or asyncio.Event()
        key = handle.lower()
        self.profiles.pop(key, None)
        at = await page.evaluate(NAME_AT_JS, handle)
        if not at:
            return None
        height = at.get("height") or 800
        if not (height * 0.2 <= at["top"] <= height * 0.75):
            at = await bring_into_band(page, handle, stop) or at
            if not at.get("x"):
                return None
        # The pointer wanders over, not in a straight line at machine speed.
        await page.mouse.move(at["x"] + random.randint(-30, 30), at["y"] + random.randint(-25, 25),
                              steps=random.randint(8, 14))
        await asyncio.sleep(random.uniform(0.05, 0.15))
        await page.mouse.move(at["x"] + random.randint(-4, 4), at["y"] + random.randint(-2, 2),
                              steps=random.randint(4, 8))
        # The card takes a beat to open and ask for the profile.
        deadline = asyncio.get_running_loop().time() + hover_wait
        while key not in self.profiles and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.15)
        card = ""
        try:
            card = await page.evaluate(CARD_TEXT_JS)
        except Exception:  # noqa: BLE001 - mid-navigation
            pass
        data = self.profiles.get(key)
        if data is None:
            # Cached by the app, so no request went out: ask the public API.
            data = await asyncio.to_thread(_public_profile, handle)
        # Off the name, which closes the card: a drift aside, not a jump.
        await page.mouse.move(at["x"] + random.randint(180, 320), at["y"] + random.randint(40, 120),
                              steps=random.randint(6, 10))
        if data is None:
            return {"handle": handle, "name": at.get("name", ""), "bio": "", "followers": None,
                    "following": None, "posts": None, "did": "", "dm_open": False,
                    "card": card, "by": "@" + self.login, "at": now()}
        row = _profile_row(data, "@" + self.login, card)
        if not row["handle"]:
            row["handle"] = handle
        if not row["name"]:
            row["name"] = at.get("name", "")
        return row

    def _add(self, row: dict[str, Any]) -> None:
        key = row["handle"].lower()
        if key in RUN["known"]:
            self.state["dupes"] += 1
            return
        # Only accounts a message can reach are kept: a row whose chat is
        # closed to this account is passed over, counted, and not stored.
        if self.settings.get("skip_no_dm", True) and not row.get("dm_open"):
            self.state["skipped"] += 1
            return
        RUN["known"].add(key)
        row["lane"] = self.id
        RUN["rows"].append(row)
        self.state["rows"].append(row)
        self.state["count"] += 1
        self.state["last_new_at"] = now()
        RUN["unpushed"] += 1
        save_row(row)


def _reset_lanes(accounts: list[dict[str, Any]]) -> None:
    RUN["lanes"] = {}
    for a in accounts:
        RUN["lanes"][a["id"]] = {
            "id": a["id"], "account": "@" + a["login"], "label": a.get("label", ""),
            "running": True, "status": "starting", "error": "", "count": 0, "dupes": 0,
            "restarts": 0, "profiles": 0, "skipped": 0, "rows": [], "last_new_at": now(),
        }


async def _push(final: bool) -> str:
    """The rows of this run to the handles file. Best effort while running;
    at the end the outcome is said in the frame's note."""
    rows = list(RUN["rows"])
    if not rows:
        return ""
    try:
        out = await asyncio.to_thread(handles_push, rows)
        RUN["unpushed"] = 0
        return f"{out['bucket']}/{out['object']} now holds {out['total']} handle(s) ({out['new']} new)"
    except minio.MinioError as exc:
        return f"MinIO: not written - {exc}"


def start(body: dict[str, Any]) -> tasks.Task:
    if RUN["running"]:
        raise ValueError("A scrape is already running — stop that one first.")
    wanted = [str(i) for i in (body.get("sessions") or [])]
    accounts = [a for a in store.accounts() if browser.is_open(a["id"])
                and (not wanted or a["id"] in wanted)]
    if not accounts:
        raise ValueError("No browser window is open." if not wanted
                         else "None of the ticked accounts has a window open.")
    settings = body.get("settings") or {}
    target = TARGETS.get(str(body.get("source") or "feed"), TARGET)
    known = {str(r.get("handle") or "").lower() for r in saved_rows()}
    known.discard("")
    RUN.update(running=True, started_at=now(), ended_at="", note="", rows=[],
               known=known, unpushed=0, target=target)
    if target is TARGET_FOLLOWERS:
        # Profiles already walked this session are not opened again; a reset
        # clears the list.
        RUN.setdefault("walked", set())
    _reset_lanes(accounts)
    stop = asyncio.Event()
    RUN["stop"] = stop

    async def run(task: tasks.Task) -> None:
        lanes = [Lane(a, settings) for a in accounts]
        jobs = [asyncio.ensure_future(l.run(stop)) for l in lanes]
        task.detail = f"walking Home on {len(lanes)} account(s)"
        try:
            while not stop.is_set() and any(not j.done() for j in jobs):
                task.detail = f"{len(RUN['rows'])} accounts off the feed"
                task.progress = (len(RUN["rows"]) % 100) / 100
                task.result = frame()
                if RUN["unpushed"] >= PUSH_EVERY:
                    RUN["unpushed"] = 0
                    asyncio.ensure_future(_push(final=False))
                await asyncio.sleep(0.9)
            if not stop.is_set():
                RUN["note"] = "Every window gave up — " + "; ".join(
                    f"{l['account']}: {l['error'] or l['status']}" for l in RUN["lanes"].values())
        finally:
            stop.set()
            for j in jobs:
                if not j.done():
                    j.cancel()
            await asyncio.gather(*jobs, return_exceptions=True)
            for l in RUN["lanes"].values():
                l["running"] = False
            RUN["running"] = False
            RUN["ended_at"] = now()
            pushed = await _push(final=True)
            if RUN["rows"]:
                tg = RUN["target"]
                RUN["done"].insert(0, {"key": tg["key"], "name": tg["name"],
                                       "mode": tg["mode"], "count": len(RUN["rows"]),
                                       "by": ", ".join(l["account"] for l in RUN["lanes"].values()),
                                       "at": RUN["ended_at"]})
            RUN["note"] = (RUN["note"] or f"Stopped — {len(RUN['rows'])} collected") + (
                f". {pushed}" if pushed else "")
            task.result = frame()
            task.finish(frame(), RUN["note"])

    task = tasks.start("scraping followers off the home feed" if target is TARGET_FOLLOWERS
                       else "scraping the home feed", run)
    RUN["task"] = task.id
    return task


def stop() -> dict[str, Any]:
    if not RUN["running"]:
        raise ValueError("No scrape is running.")
    RUN["stop"].set()
    out = frame()
    out["note"] = "Stopping — it finishes the account it is on."
    return out


def reset() -> None:
    if RUN["running"]:
        raise ValueError("The scrape is still running — stop it first.")
    RUN.update(rows=[], lanes={}, done=[], task=None, started_at="", ended_at="", note="",
               walked=set())
