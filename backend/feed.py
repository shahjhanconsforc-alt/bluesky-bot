"""Feed Campaign: the Home feed or the Video feed, read and answered, in the
account's window.

Start opens bsky.app Home in each picked account's window (launching one on
the first account when none is up) and walks the feed the way a reader
does: a wheel's worth down, and on every post that comes onto the screen,
Like pressed first, then Reply, and a comment typed into the reply box key
by key - slips, backspaces and all - and posted. A tab is one such reader;
the "tabs" box opens that many copies of Home in the window and they share
one list of posts already answered, so no post is commented on twice.

What goes in the comment is the panel's choice. "Write own" posts the box's
text on every post. "Database" draws one message at random, per post, from
the Campaign messages on MinIO (sms_drafts.txt - what the Messages step
saves), so no two comments in a row need read alike.

Where it reads is the panel's other choice. "Home" walks the Home feed.
"Videos" walks Bluesky's Video feed instead: each video is watched a few
seconds, liked, its author followed off the profile card the name pops on a
hover, and then commented on. An author is followed once per run.

A comment counts once the window's traffic shows it written: Bluesky makes
a reply with `com.atproto.repo.createRecord`, and that reply is what moves
the count. A follow counts the same way, by its `app.bsky.graph.follow`
record. The run ends at the per-account limit, or on Stop.
"""

from __future__ import annotations

import asyncio
import json
import random
import urllib.parse
from typing import Any

from . import config, tasks
from . import minio_store as minio
from .automation.browser import browser
from .campaign import type_at
from .post import CANCEL_BTN, CREATE_CALL, TEXT_INPUT, fit
from .scrape import NAME_AT_JS, bring_into_band, human_scroll, now
from .store import store

REMEMBER_FILE = config.DATA_DIR / "feed.json"

# Which feed a run walks: the panel's choice, and where each choice opens.
PAGES = {"home": ("Home", config.BSKY_URL), "videos": ("Videos", config.BSKY_VIDEO_URL)}

# Every post on the feed: keyed by its own address (one author can have
# several posts on screen), with where it sits.
POSTS_JS = """(skip) => {
  const out = [], seen = new Set(skip);
  for (const it of document.querySelectorAll('[data-testid^="feedItem-by-"]')) {
    const h = it.getAttribute('data-testid').slice('feedItem-by-'.length);
    const a = it.querySelector('a[href*="/post/"]');
    const key = a ? a.getAttribute('href') : '';
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const r = it.getBoundingClientRect();
    if (r.height < 10) continue;
    out.push({ key, handle: h, top: r.top, bottom: r.bottom });
  }
  out.sort((a, b) => a.top - b.top);
  return { items: out, height: window.innerHeight };
}"""

# A control on one post - Like or Reply - and where it is right now. The
# post is found by its address; the button by Bluesky's test id, then by
# the label it gives the button. `done` says whether Like is already lit.
BUTTON_JS = """([key, which]) => {
  const a = document.querySelector('a[href="' + key + '"]');
  const it = a && a.closest('[data-testid^="feedItem-by-"]');
  if (!it) return null;
  const ids = which === 'like' ? ['[data-testid="likeBtn"]', '[aria-label^="Like ("]', '[aria-label^="Like"]', '[aria-label^="Unlike"]']
                                : ['[data-testid="replyBtn"]', '[aria-label^="Reply ("]', '[aria-label^="Reply"]'];
  let b = null;
  for (const s of ids) { b = it.querySelector(s); if (b) break; }
  if (!b) return null;
  const r = b.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const label = (b.getAttribute('aria-label') || '').toLowerCase();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, height: window.innerHeight,
           done: label.startsWith('unlike') };
}"""

# The reply composer's Post button, by every name it has had.
PUBLISH_BTN = (
    '[data-testid="composerPublishBtn"]', 'button[aria-label="Publish reply"]',
    'button[aria-label="Publish post"]', '[role="dialog"] button[aria-label="Reply"]',
    '[role="dialog"] button:has-text("Reply")', '[role="dialog"] button:has-text("Post")',
)

# The Follow button on the profile card a hover on the author's name pops:
# the floating box that says "followers" and is not a post. `done` when the
# card already says Following - nothing to press.
FOLLOW_JS = """() => {
  const boxes = [...document.querySelectorAll('div')].filter(d => {
    const t = d.innerText || '';
    if (!/followers/i.test(t) || t.length > 900) return false;
    const r = d.getBoundingClientRect();
    return r.width > 200 && r.width < 460 && r.height > 60 && r.height < 560 && !d.closest('[data-testid^="feedItem-by-"]');
  });
  const card = boxes[boxes.length - 1];
  if (!card) return null;
  for (const b of card.querySelectorAll('button, [role="button"]')) {
    const t = ((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || '')).trim().toLowerCase();
    const r = b.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (/\\bfollowing\\b|unfollow/.test(t)) return { done: true };
    if (/\\bfollow( back)?\\b/.test(t))
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, done: false };
  }
  return null;
}"""

REPLY_RECORD = "/app.bsky.feed.post/"
FOLLOW_RECORD = "/app.bsky.graph.follow/"

RUN: dict[str, Any] = {
    "running": False, "state": "idle", "note": "", "task": None, "stop": None,
    "comment": "", "source": "own", "where": "home", "tabs": 1, "lanes": {}, "drafts": [],
    "started_at": "", "ended_at": "",
}


# ── what the panel remembers ─────────────────────────────────────────────────

def _remembered() -> dict[str, Any]:
    try:
        return json.loads(REMEMBER_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _remember(**fields: Any) -> None:
    data = {**_remembered(), **fields}
    try:
        REMEMBER_FILE.parent.mkdir(parents=True, exist_ok=True)
        REMEMBER_FILE.write_text(json.dumps(data), encoding="utf-8")
    except OSError:
        pass


def _load_remembered() -> None:
    saved = _remembered()
    if saved.get("comment") and not RUN["comment"]:
        RUN["comment"] = str(saved["comment"])
    if saved.get("source") in ("own", "db") and RUN["source"] == "own":
        RUN["source"] = saved["source"]
    if saved.get("tabs") and RUN["tabs"] == 1:
        RUN["tabs"] = int(saved["tabs"])
    if saved.get("where") in PAGES and RUN["where"] == "home":
        RUN["where"] = saved["where"]


_load_remembered()


def db_drafts() -> list[dict[str, Any]]:
    """The enabled Campaign messages on MinIO - the comments "Database" draws
    from. Empty when MinIO is off or the file is."""
    try:
        drafts = [d for d in minio.messages()["drafts"] if d.get("text")]
    except Exception:  # noqa: BLE001 - no MinIO, no file: nothing to draw from
        return []
    return [d for d in drafts if d.get("enabled", True)] or drafts


def windows() -> list[dict[str, Any]]:
    return [{"id": a["id"], "label": "@" + a["login"]}
            for a in store.accounts() if browser.is_open(a["id"])]


def frame(with_windows: bool = False) -> dict[str, Any]:
    lanes = list(RUN["lanes"].values())
    out: dict[str, Any] = {
        "state": RUN["state"], "note": RUN["note"], "task": RUN["task"],
        "comment": RUN["comment"], "source": RUN["source"], "where": RUN["where"], "tabs": RUN["tabs"],
        "lanes": lanes,
        "passes": sum(l["passes"] for l in lanes), "posts": sum(l["posts"] for l in lanes),
        "commented": sum(l["commented"] for l in lanes), "failed": sum(l["failed"] for l in lanes),
        "followed": sum(l.get("followed", 0) for l in lanes),
        "account": ", ".join(l["account"] for l in lanes),
    }
    if with_windows:
        out["windows"] = windows()
        out["drafts"] = len(db_drafts())
    return out


# ── one lane: an account's window, its tabs sharing the feed ─────────────────

class Lane:
    STEP_TIMEOUT = 120.0

    def __init__(self, account: dict[str, Any], settings: dict[str, Any]) -> None:
        self.id = account["id"]
        self.login = account["login"]
        self.settings = settings
        self.state = RUN["lanes"][self.id]
        self.done: set[str] = set()         # posts answered (or passed over), every tab
        self.claimed: set[str] = set()      # posts a tab is on right now
        self.created: list[str] = []         # uris of the records the window wrote
        self.followed: set[str] = set()     # authors followed (or found followed) this run
        self.videos = RUN["where"] == "videos"
        self.page_name, self.url = PAGES[RUN["where"]]
        self.limit = int(float(settings.get("fb_comment_limit", 20) or 0))
        self.like = bool(settings.get("fb_like", True))
        self.gap_min = float(settings.get("fb_gap_min_seconds", 20) or 0)
        self.gap_max = max(self.gap_min, float(settings.get("fb_gap_max_seconds", 60) or 0))
        self.wpm = float(settings.get("typing_wpm", 240) or 240)
        self.slips = bool(settings.get("typing_slips", True))

    def _say(self, status: str) -> None:
        self.state["note"] = status

    def _full(self) -> bool:
        return self.limit > 0 and self.state["commented"] >= self.limit

    async def _on_response(self, response: Any) -> None:
        if CREATE_CALL in response.url and response.ok:
            try:
                self.created.append(str((await response.json()).get("uri") or ""))
            except Exception:  # noqa: BLE001
                pass

    def _wrote(self, kind: str) -> bool:
        return any(kind in uri for uri in self.created)

    def comment_for(self) -> str:
        if RUN["source"] == "db":
            drafts = RUN["drafts"]
            if not drafts:
                raise ValueError("no messages in the database to comment with")
            return fit(random.choice(drafts)["text"])
        return fit(RUN["comment"])

    async def run(self, stop: asyncio.Event) -> None:
        ctx = browser.contexts.get(self.id)
        if ctx is None:
            try:
                await browser.open(self.id)
            except Exception as exc:  # noqa: BLE001
                self.state.update(state="failed", error=f"could not open the window: {str(exc)[:120]}")
                return
            ctx = browser.contexts.get(self.id)
            if ctx is None:
                self.state.update(state="failed", error="the window did not open")
                return
        listener = lambda r: asyncio.ensure_future(self._on_response(r))  # noqa: E731
        ctx.on("response", listener)
        tabs = max(1, min(10, int(RUN["tabs"] or 1)))
        jobs = []
        try:
            for n in range(tabs):
                jobs.append(asyncio.ensure_future(self._tab(ctx, n, stop)))
                await asyncio.sleep(random.uniform(2.0, 4.0))
            await asyncio.gather(*jobs, return_exceptions=True)
        finally:
            for j in jobs:
                if not j.done():
                    j.cancel()
            try:
                ctx.remove_listener("response", listener)
            except Exception:  # noqa: BLE001
                pass
            if self.state["state"] == "running":
                self.state["state"] = "stopped" if stop.is_set() else "done"
            if not self.state.get("error"):
                self._say(f"{self.state['commented']} commented"
                          + (f", {self.state['failed']} failed" if self.state["failed"] else ""))

    async def _tab(self, ctx: Any, n: int, stop: asyncio.Event) -> None:
        """One reader on the feed: reads the posts on screen, answers each, then
        wheels further down. A tab that breaks reloads the feed and goes on."""
        page = None
        trouble = 0
        while not stop.is_set() and not self._full():
            try:
                if page is None or page.is_closed():
                    page = (ctx.pages[0] if n == 0 and ctx.pages else await ctx.new_page())
                    await asyncio.wait_for(page.goto(self.url, wait_until="domcontentloaded"), 45)
                    if n == 0:
                        await page.bring_to_front()
                    await asyncio.sleep(random.uniform(2.0, 3.5))
                found = await self._step(page.evaluate(POSTS_JS, list(self.done | self.claimed)), "reading the feed")
                height = found.get("height") or 800
                items = [o for o in found.get("items", []) if o["top"] < height * 1.1]
                self.state["posts"] += len(items)
                for post in items:
                    if stop.is_set() or self._full():
                        break
                    key = post["key"]
                    if key in self.done or key in self.claimed:
                        continue
                    self.claimed.add(key)
                    try:
                        if post["handle"].lower() == self.login.lower():
                            continue                        # the account's own post
                        await self._step(self._answer(page, post, stop), f"commenting on @{post['handle']}")
                    finally:
                        self.claimed.discard(key)
                        self.done.add(key)
                self._say("scrolling")
                await self._step(human_scroll(page, random.randint(500, 900), stop), "scrolling")
                self.state["passes"] += 1
                await asyncio.sleep(random.uniform(
                    float(self.settings.get("scroll_pause_min", 0.8) or 0),
                    max(float(self.settings.get("scroll_pause_min", 0.8) or 0),
                        float(self.settings.get("scroll_pause_max", 2.4) or 0))))
                trouble = 0
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - this pass went wrong: the feed again, walk on
                trouble += 1
                self._say(f"stuck ({str(exc).splitlines()[0][:60] or exc.__class__.__name__}) - back to {self.page_name}")
                if trouble >= 4:
                    self.state["error"] = f"tab {n + 1} gave up: {str(exc).splitlines()[0][:100]}"
                    break
                try:
                    await page.keyboard.press("Escape")
                    await asyncio.sleep(random.uniform(1.5, 3.0))
                    await asyncio.wait_for(page.goto(self.url, wait_until="domcontentloaded"), 30)
                    await asyncio.sleep(random.uniform(2.0, 3.5))
                except Exception:  # noqa: BLE001
                    try:
                        await page.close()
                    except Exception:  # noqa: BLE001
                        pass
                    page = None
        if n > 0 and page is not None and not page.is_closed():
            try:
                await page.close()
            except Exception:  # noqa: BLE001
                pass

    async def _step(self, coro, what: str):
        try:
            return await asyncio.wait_for(coro, self.STEP_TIMEOUT)
        except asyncio.TimeoutError:
            raise RuntimeError(f"{what} took longer than {int(self.STEP_TIMEOUT)}s") from None

    async def _button(self, page: Any, key: str, which: str, stop: asyncio.Event) -> dict[str, Any] | None:
        """The post's Like or Reply, wheeled into the middle of the window."""
        for _ in range(3):
            at = await page.evaluate(BUTTON_JS, [key, which])
            if at is None:
                return None
            height = at.get("height") or 800
            if height * 0.15 <= at["top"] <= height * 0.8:
                return at
            await human_scroll(page, int(at["top"] - random.uniform(height * 0.35, height * 0.55)), stop)
            await asyncio.sleep(random.uniform(0.15, 0.35))
        return await page.evaluate(BUTTON_JS, [key, which])

    async def _press(self, page: Any, at: dict[str, Any]) -> None:
        await page.mouse.move(at["x"] + random.randint(-30, 30), at["y"] + random.randint(-20, 20),
                              steps=random.randint(8, 14))
        await asyncio.sleep(random.uniform(0.05, 0.15))
        await page.mouse.move(at["x"], at["y"], steps=random.randint(4, 8))
        await asyncio.sleep(random.uniform(0.05, 0.12))
        await page.mouse.click(at["x"], at["y"])

    async def _follow(self, page: Any, handle: str, stop: asyncio.Event) -> None:
        """The author followed off the profile card a hover on their name
        pops - Follow pressed there, and counted once the window writes the
        follow. Once per author per run; an author already followed is left."""
        key = handle.lower()
        if key in self.followed:
            return
        self.followed.add(key)
        at = await page.evaluate(NAME_AT_JS, handle)
        if not at:
            return
        height = at.get("height") or 800
        if not (height * 0.2 <= at["top"] <= height * 0.75):
            at = await bring_into_band(page, handle, stop) or at
            if not at.get("x"):
                return
        self._say(f"following @{handle}")
        await page.mouse.move(at["x"] + random.randint(-30, 30), at["y"] + random.randint(-25, 25),
                              steps=random.randint(8, 14))
        await asyncio.sleep(random.uniform(0.05, 0.15))
        await page.mouse.move(at["x"] + random.randint(-4, 4), at["y"] + random.randint(-2, 2),
                              steps=random.randint(4, 8))
        btn = None
        for _ in range(16):                              # the card takes a beat to open
            await asyncio.sleep(0.25)
            btn = await page.evaluate(FOLLOW_JS)
            if btn is not None:
                break
        if btn is None:
            self._say(f"@{handle}: no profile card to follow from")
        elif not btn.get("done"):
            self.created.clear()
            await self._press(page, btn)
            for _ in range(24):
                if self._wrote(FOLLOW_RECORD):
                    break
                await asyncio.sleep(0.25)
            if self._wrote(FOLLOW_RECORD):
                self.state["followed"] = self.state.get("followed", 0) + 1
                self._say(f"followed @{handle}")
            else:
                self._say(f"@{handle}: the follow did not go through")
            await asyncio.sleep(random.uniform(0.4, 0.9))
        # Off the name, which closes the card: a drift aside, not a jump.
        await page.mouse.move(at["x"] + random.randint(180, 320), at["y"] + random.randint(40, 120),
                              steps=random.randint(6, 10))
        await asyncio.sleep(random.uniform(0.4, 0.9))

    async def _answer(self, page: Any, post: dict[str, Any], stop: asyncio.Event) -> None:
        """One post: Like, then (on Videos) Follow, then Reply, the comment
        typed and posted."""
        key, handle = post["key"], post["handle"]
        if self.videos:
            # A video is watched a moment before anything is pressed on it.
            self._say(f"watching @{handle}")
            if await self._button(page, key, "like", stop) is None:
                return
            end = asyncio.get_running_loop().time() + random.uniform(3.0, 8.0)
            while asyncio.get_running_loop().time() < end and not stop.is_set():
                await asyncio.sleep(0.25)
        if self.like:
            self._say(f"liking @{handle}")
            at = await self._button(page, key, "like", stop)
            if at is None:
                return                                        # the post has gone off the feed
            if not at.get("done"):
                await self._press(page, at)
                await asyncio.sleep(random.uniform(0.6, 1.4))
        if self.videos:
            await self._follow(page, handle, stop)
        try:
            text = self.comment_for()
        except ValueError as exc:
            self.state["failed"] += 1
            self.state["error"] = str(exc)
            raise
        self._say(f"replying to @{handle}")
        at = await self._button(page, key, "reply", stop)
        if at is None:
            return
        await self._press(page, at)
        box = None
        for _ in range(30):
            for sel in TEXT_INPUT:
                loc = page.locator(sel).first
                try:
                    if await loc.count() and await loc.is_visible():
                        box = loc
                        break
                except Exception:  # noqa: BLE001
                    continue
            if box is not None:
                break
            await asyncio.sleep(0.25)
        if box is None:
            self.state["failed"] += 1
            self._say(f"@{handle}: the reply box did not open")
            await page.keyboard.press("Escape")
            return
        await asyncio.sleep(random.uniform(0.5, 1.0))
        await box.click()
        await asyncio.sleep(random.uniform(0.2, 0.4))
        await type_at(page, text, self.wpm, slips=self.slips)
        await asyncio.sleep(random.uniform(0.6, 1.4))
        typed = (await box.inner_text()).strip()
        if text[:20].strip() not in typed:
            await box.click()
            await page.keyboard.press("Control+A")
            await page.keyboard.insert_text(text)
            await asyncio.sleep(0.5)
        self.created.clear()
        publish = None
        for sel in PUBLISH_BTN:
            loc = page.locator(sel).first
            try:
                if await loc.count() and await loc.is_visible():
                    publish = loc
                    break
            except Exception:  # noqa: BLE001
                continue
        if publish is None:
            self.state["failed"] += 1
            self._say(f"@{handle}: no Reply button in the composer")
            await self._discard(page)
            return
        for _ in range(20):
            if await publish.is_enabled():
                break
            await asyncio.sleep(0.25)
        await publish.click(timeout=10000)
        for _ in range(60):
            if self._wrote(REPLY_RECORD):
                break
            await asyncio.sleep(0.25)
        if self._wrote(REPLY_RECORD):
            self.state["commented"] += 1
            self._say(f"commented on @{handle}")
        else:
            still = None
            for sel in TEXT_INPUT:
                loc = page.locator(sel).first
                try:
                    if await loc.count() and await loc.is_visible():
                        still = loc
                        break
                except Exception:  # noqa: BLE001
                    continue
            if still is not None:
                self.state["failed"] += 1
                self._say(f"@{handle}: Bluesky did not take the reply")
                await self._discard(page)
                return
            self.state["commented"] += 1               # the composer closed: it went
            self._say(f"commented on @{handle}")
        # A rest between comments, rolled from the range, with the tab
        # drifting down a little as a reader would.
        gap = random.uniform(self.gap_min, self.gap_max)
        end = asyncio.get_running_loop().time() + gap
        await human_scroll(page, random.randint(80, 240), stop)
        while asyncio.get_running_loop().time() < end and not stop.is_set():
            await asyncio.sleep(0.5)

    async def _discard(self, page: Any) -> None:
        for sel in CANCEL_BTN:
            loc = page.locator(sel).first
            try:
                if await loc.count() and await loc.is_visible():
                    await loc.click(timeout=5000)
                    await asyncio.sleep(0.5)
                    return
            except Exception:  # noqa: BLE001
                continue
        await page.keyboard.press("Escape")
        await asyncio.sleep(0.5)


# ── the run ──────────────────────────────────────────────────────────────────

def start(body: dict[str, Any]) -> dict[str, Any]:
    if RUN["running"]:
        raise ValueError("A feed campaign is already running - stop it first.")
    source = "db" if str(body.get("source") or "own") == "db" else "own"
    where = str(body.get("where") or "home")
    if where not in PAGES:
        where = "home"
    comment = str(body.get("comment") or "").strip()
    tabs = max(1, min(10, int(body.get("tabs") or 1)))
    drafts = db_drafts() if source == "db" else []
    if source == "own" and not comment:
        raise ValueError("Type the comment first, or pick Database to draw from the stored messages.")
    if source == "db" and not drafts:
        raise ValueError("No messages in the database - save some on the Campaign's Messages step, or write your own.")
    wanted = [str(i) for i in (body.get("accounts") or [])]
    accounts = [a for a in store.accounts() if browser.is_open(a["id"]) and (not wanted or a["id"] in wanted)]
    if not accounts:
        if wanted:
            raise ValueError("None of the ticked accounts has a window open.")
        accounts = store.accounts()[:1]
        if not accounts:
            raise ValueError("No accounts - add one on the Accounts panel first.")
    settings = body.get("settings") or {}
    RUN.update(running=True, state="running", note="", comment=comment, source=source, where=where,
               tabs=tabs, drafts=drafts, started_at=now(), ended_at="", lanes={})
    _remember(comment=comment, source=source, tabs=tabs, where=where)
    for a in accounts:
        RUN["lanes"][a["id"]] = {"id": a["id"], "account": "@" + a["login"], "state": "running",
                                 "note": f"opening {PAGES[where][0]}", "error": "", "passes": 0,
                                 "posts": 0, "commented": 0, "failed": 0, "followed": 0}
    stop = asyncio.Event()
    RUN["stop"] = stop

    async def run(task: tasks.Task) -> None:
        lanes = [Lane(a, settings) for a in accounts]
        jobs = [asyncio.ensure_future(l.run(stop)) for l in lanes]
        try:
            while any(not j.done() for j in jobs):
                fr = frame()
                task.detail = f"{fr['commented']} commented"
                task.progress = (fr["commented"] % 100) / 100
                task.result = fr
                await asyncio.sleep(0.9)
        finally:
            for j in jobs:
                if not j.done():
                    j.cancel()
            await asyncio.gather(*jobs, return_exceptions=True)
            for l in RUN["lanes"].values():
                if l["state"] == "running":
                    l["state"] = "stopped" if stop.is_set() else "done"
            RUN["running"] = False
            RUN["ended_at"] = now()
            fr = frame()
            RUN["state"] = "stopped" if stop.is_set() else "done"
            RUN["note"] = (f"{'Stopped' if stop.is_set() else 'Finished'} - {fr['commented']} commented"
                           + (f", {fr['followed']} followed" if fr["followed"] else "")
                           + (f", {fr['failed']} failed" if fr["failed"] else "") + ".")
            task.result = frame()
            task.finish(frame(), RUN["note"])

    task = tasks.start("feed campaign", run)
    RUN["task"] = task.id
    return {"task": task.id, **frame(with_windows=True)}


def stop() -> dict[str, Any]:
    if not RUN["running"]:
        raise ValueError("No feed campaign is running.")
    RUN["stop"].set()
    out = frame(with_windows=True)
    out["note"] = "Stopping - each tab finishes the post it is on."
    return out
