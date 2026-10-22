"""The campaign: a message to each picked recipient, in the account's window.

For every recipient, in the sending account's own Bluesky window: open Chat
off the rail, press New chat, type the handle into the search, take the
first result, type the dealt message key by key, drop in the dealt picture,
and - when the "click send" setting is on - send it. Off, the message is
typed and left in the composer, which is the dry run.

The recipients are dealt out before anything goes: round-robin across the
picked accounts, each with a draft and a picture drawn from a shuffled bag,
so what the live panel shows as the plan is exactly what runs. The lanes run
side by side, one per account window, and inside a window several tabs (the
"parallel tabs" setting, five by default) each work a recipient at once: a
tab sends, waits out the gap rolled from the settings range, refreshes, and
takes the next pending recipient; a tab that breaks is closed and replaced.

A picture cannot travel in a Bluesky message: the protocol allows a message
only text, links and an embedded post (chat.bsky.convo.defs#messageInput),
and the app drops a pasted image. So a dealt picture goes the one way it can:
before the lane starts, the account publishes that picture as a post of its
own, and each chat gets that post's link first - which Bluesky draws as the
post, picture and all - and the message under it.

Every so many messages a lane takes a break, dealt into its rows when the
run is planned so the live table shows where each will fall: how many
messages come before it and how long it lasts are both rolled from their
ranges, afresh for every break, and a few of the account's rail items (the
Actions panel's list, minus Compose) are drawn for it. When a tab reaches the break the lane's other tabs finish the
message they are on and wait; the account's window presses the drawn items
one by one, the way the Actions panel does; and the rest of the break is
waited out before any tab takes another recipient.

What confirms a send is the window's traffic: Bluesky writes a message with
`chat.bsky.convo.sendMessage`, and that reply is what moves a row to `sent`.
A chat that cannot be opened (the profile does not take messages from this
account) fails the row with that reason and the run goes on.

The chat UI is found by the labels Bluesky gives its controls - "New chat",
"Search", "Write a message", "Send message" - with the structure of the
screen as fallback, never by its scrambled class names.
"""

from __future__ import annotations

import asyncio
import base64
import json
import mimetypes
import random
import threading
import time
from pathlib import Path
from typing import Any

from . import actions as rail
from . import config, tasks
from . import minio_store as minio
from .automation.browser import browser
from . import post as posting
from .post import fetch_image, pick_image
from .scrape import human_scroll, now
from .store import store

SENT_FILE = config.DATA_DIR / "sent.jsonl"
_sent_lock = threading.Lock()

WAIT: dict[str, Any] = {"kind": "wait"}   # what _take hands a tab while the lane is on a break

SEND_CALL = "chat.bsky.convo.sendMessage"
CONVO_CALL = "chat.bsky.convo.getConvoForMembers"
SEARCH_CALL = "searchActorsTypeahead"

# The chat controls, each by every name Bluesky has given it.
CHAT_RAIL = ('nav[role="navigation"] a[aria-label="Chat"]', 'a[aria-label="Chat"]', 'a[href="/messages"]')
NEW_CHAT = ('[data-testid="newChatBtn"]', 'button[aria-label="New chat"]', '[role="button"][aria-label="New chat"]',
            'a[aria-label="New chat"]', 'button:has-text("New chat")')
SEARCH_INPUT = ('[role="dialog"] input[placeholder*="earch"]', '[role="dialog"] input[type="text"]',
                '[role="dialog"] input', 'input[placeholder*="earch"]')
RESULT = ('[role="dialog"] a[href^="/profile/"]', '[role="dialog"] [role="button"]:has-text("@")',
          '[role="dialog"] button:has-text("@")', '[role="dialog"] [data-testid^="newChat"]')
MESSAGE_INPUT = ('textarea[placeholder*="essage"]', '[data-testid="messageInput"]', 'textarea',
                 '[contenteditable="true"]')
SEND_BTN = ('button[aria-label="Send message"]', '[role="button"][aria-label="Send message"]',
            '[data-testid="sendMessageBtn"]', 'button[aria-label="Send"]')
CLOSED_TEXT = ("can't message", "cannot message", "doesn't accept", "does not accept", "not accepting",
               "can't be messaged", "cannot be messaged", "only accepts messages", "has disabled")

PASTE_JS = """async ([b64, name, type, sel]) => {
  const box = document.querySelector(sel);
  if (!box) return 'no input';
  const blob = await (await fetch('data:' + type + ';base64,' + b64)).blob();
  const file = new File([blob], name, { type });
  const dt = new DataTransfer(); dt.items.add(file);
  box.focus();
  box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  return 'pasted';
}"""
EMBED_JS = "() => !!document.querySelector('[aria-label=\"Remove embed\"], [aria-label=\"Remove quote\"], form a[href*=\"/post/\"], [data-testid*=\"mbed\"] img, [data-testid=\"messageInputEmbed\"]')"
PREVIEW_JS = "() => !!document.querySelector('[aria-label=\"Remove image\"], [aria-label=\"Remove attachment\"], form img, [data-testid*=\"mage\"] img')"


# ── the record of what went ──────────────────────────────────────────────────

def record_sent(handle: str, account: str) -> None:
    with _sent_lock:
        try:
            SENT_FILE.parent.mkdir(parents=True, exist_ok=True)
            with open(SENT_FILE, "a", encoding="utf-8") as f:
                f.write(json.dumps({"handle": handle.lstrip("@"), "account": account, "at": now()}) + "\n")
        except OSError:
            pass


def sent_counts() -> dict[str, int]:
    counts: dict[str, int] = {}
    with _sent_lock:
        try:
            with open(SENT_FILE, encoding="utf-8") as f:
                for line in f:
                    try:
                        h = str(json.loads(line).get("handle") or "").lower()
                    except ValueError:
                        continue
                    if h:
                        counts[h] = counts.get(h, 0) + 1
        except OSError:
            pass
    return counts


# ── the plan ─────────────────────────────────────────────────────────────────

CAMP: dict[str, Any] = {"state": "idle", "lanes": [], "note": "", "task": None,
                        "stop": None, "paused": None, "settings": {}}


def dealer(items: list[Any]):
    bag: list[Any] = []

    def draw():
        nonlocal bag
        if not items:
            return None
        if not bag:
            bag = list(items)
            random.shuffle(bag)
        return bag.pop()
    return draw


def plan(body: dict[str, Any]) -> list[dict[str, Any]]:
    ids = [str(i) for i in (body.get("accounts") or [])]
    recipients = [str(h).lstrip("@").strip() for h in (body.get("recipients") or []) if str(h).strip()]
    if not ids:
        raise ValueError("Pick an account to send from.")
    if not recipients:
        raise ValueError("No recipients.")
    accounts = [a for a in store.accounts() if a["id"] in ids]
    if not accounts:
        raise ValueError("None of the picked accounts is on the list.")
    drafts = [] if body.get("skip_messages") else [
        (d if isinstance(d, dict) else {"name": str(d), "text": ""}) for d in (body.get("drafts") or [])]
    drafts = [d for d in drafts if d.get("text")]
    if not body.get("skip_messages") and not drafts:
        raise ValueError("No draft selected - tick Skip messages to send without one.")
    media = [] if body.get("skip_media") else [str(m) for m in (body.get("media") or [])]
    draw_draft, draw_media = dealer(drafts), dealer(media)
    lanes = [{"id": a["id"], "account": "@" + a["login"], "login": a["login"], "rows": []} for a in accounts]
    for i, handle in enumerate(recipients):
        d = draw_draft()
        lanes[i % len(lanes)]["rows"].append({
            "handle": handle, "name": "", "draft": d["name"] if d else "", "text": d["text"] if d else "",
            "media": draw_media() or "", "status": "pending", "why": "", "chat": "",
        })
    settings = body.get("settings") or {}
    for lane in lanes:
        lane["rows"] = with_breaks(lane["rows"], settings)
    return lanes


# The rail items a break may press: the Actions panel's list, minus Compose -
# a break is a look around, never a post.
BREAK_ACTIONS = [k for k, (_, kind) in rail.RAIL.items() if kind != "post"]


def _num(settings: dict[str, Any], key: str, default: float) -> float:
    value = settings.get(key)
    if value in (None, ""):
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def with_breaks(rows: list[dict[str, Any]], settings: dict[str, Any]) -> list[dict[str, Any]]:
    """The lane's rows with breaks dealt in. How many messages come before
    each break, how long it lasts and which rail items it presses are all
    rolled here, at planning - a fresh roll for every break, so one falls
    after 13 messages for 17 minutes and the next after 18 for 12 - and the
    live table shows the breaks that will run."""
    # `batch_size` is the old single value, honoured if that is all there is.
    old = int(_num(settings, "batch_size", 0))
    lo_n = max(0, int(_num(settings, "batch_min_messages", old)))
    hi_n = max(lo_n, int(_num(settings, "batch_max_messages", old)))
    lo = max(0.0, _num(settings, "break_min_minutes", 0))
    hi = max(lo, _num(settings, "break_max_minutes", 0))
    count = max(0, min(len(BREAK_ACTIONS), int(_num(settings, "break_actions", 3))))
    if hi_n <= 0 or (hi <= 0 and count <= 0):
        return rows
    out: list[dict[str, Any]] = []
    since, after = 0, random.randint(max(lo_n, 1), hi_n)
    for i, row in enumerate(rows, 1):
        out.append(row)
        since += 1
        if since >= after and i < len(rows):
            minutes = round(random.uniform(lo, hi), 1)
            picked = random.sample(BREAK_ACTIONS, count)
            out.append({"kind": "break", "after": after, "minutes": minutes, "actions": picked,
                        "status": "pending", "why": break_note(after, minutes, picked)})
            since, after = 0, random.randint(max(lo_n, 1), hi_n)
    return out


def break_note(after: int, minutes: float, picked: list[str]) -> str:
    items = ", ".join(rail.RAIL[k][0] for k in picked) if picked else "no actions"
    return f"after {after} messages · {minutes:g} min · {items}"


def state() -> dict[str, Any]:
    return {"state": CAMP["state"], "note": CAMP["note"], "task": CAMP["task"],
            "lanes": [{k: v for k, v in l.items() if k != "login"} for l in CAMP["lanes"]]}


# ── one message ──────────────────────────────────────────────────────────────

async def find(page: Any, candidates: tuple[str, ...], timeout: float = 8.0):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        for sel in candidates:
            loc = page.locator(sel).first
            try:
                if await loc.count() and await loc.is_visible():
                    return loc
            except Exception:  # noqa: BLE001
                continue
        if loop.time() >= deadline:
            return None
        await asyncio.sleep(0.2)


async def click_like_a_person(page: Any, loc: Any) -> None:
    box = await loc.bounding_box()
    if not box:
        await loc.click(timeout=5000)
        return
    x = box["x"] + box["width"] * random.uniform(0.3, 0.7)
    y = box["y"] + box["height"] * random.uniform(0.3, 0.7)
    await page.mouse.move(x + random.randint(-30, 30), y + random.randint(-20, 20), steps=random.randint(6, 12))
    await asyncio.sleep(random.uniform(0.05, 0.15))
    await page.mouse.move(x, y, steps=random.randint(3, 6))
    await page.mouse.click(x, y)


# The keys around each key on a QWERTY board: what a finger lands on when it
# misses. A slip is one of these, not a random letter.
NEIGHBOURS = {
    "q": "wa", "w": "qeas", "e": "wrsd", "r": "etdf", "t": "ryfg", "y": "tugh", "u": "yihj",
    "i": "uojk", "o": "ipkl", "p": "ol", "a": "qwsz", "s": "wedxza", "d": "erfcxs", "f": "rtgvcd",
    "g": "tyhbvf", "h": "yujnbg", "j": "uikmnh", "k": "iolmj", "l": "opk", "z": "asx", "x": "zsdc",
    "c": "xdfv", "v": "cfgb", "b": "vghn", "n": "bhjm", "m": "njk",
    "1": "2q", "2": "13w", "3": "24e", "4": "35r", "5": "46t", "6": "57y", "7": "68u", "8": "79i",
    "9": "80o", "0": "9p",
}


def slip_for(ch: str) -> str:
    """The key a finger hits instead of `ch`, in the same case."""
    pool = NEIGHBOURS.get(ch.lower(), "")
    if not pool:
        return ""
    wrong = random.choice(pool)
    return wrong.upper() if ch.isupper() else wrong


async def type_at(page: Any, text: str, wpm: float, slips: bool = False) -> None:
    """Key by key at roughly `wpm` words a minute, uneven, slower at spaces.
    A new line goes as Shift+Enter, since Enter sends a chat.

    With `slips` on, every few words a finger misses: a neighbouring key goes
    in instead of the right one - or two letters land swapped - and a letter
    or two more may follow before it is noticed; then a beat, Backspace over
    the damage, and the right letters typed again. The text that ends up in
    the box is exactly `text`; only the way it got there has the slips."""
    per_char = 60.0 / max(wpm, 40) / 5.0

    async def key(ch: str) -> None:
        await page.keyboard.type(ch)
        await asyncio.sleep(random.uniform(per_char * 0.5, per_char * 1.6) + (0.08 if ch in " .,!?" else 0))

    words_since, next_slip = 0, random.randint(2, 6)
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == "\n":
            await page.keyboard.press("Shift+Enter")
            await asyncio.sleep(random.uniform(0.15, 0.35))
            i += 1
            continue
        if ch == " ":
            words_since += 1
        if slips and ch.isalnum() and words_since >= next_slip:
            nxt = text[i + 1] if i + 1 < len(text) else ""
            if nxt.isalnum() and random.random() < 0.3:
                # Two letters swapped: the second lands first.
                typed = [nxt, ch]
                carried = 2
            else:
                wrong = slip_for(ch)
                if not wrong:
                    i += 1
                    await key(ch)
                    continue
                typed = [wrong]
                carried = 1
            # A letter or two more may go in before the slip is seen.
            j = i + carried
            for _ in range(random.randint(0, 2)):
                if j < len(text) and text[j].isalnum():
                    typed.append(text[j])
                    j += 1
            for c in typed:
                await key(c)
            await asyncio.sleep(random.uniform(0.25, 0.7))         # noticing it
            for _ in typed:
                await page.keyboard.press("Backspace")
                await asyncio.sleep(random.uniform(0.05, 0.12))
            await asyncio.sleep(random.uniform(0.1, 0.3))
            words_since, next_slip = 0, random.randint(3, 8)
            continue                                                 # the right letters, from `ch`
        await key(ch)
        i += 1


class Sender:
    """One account's lane: a pool of tabs in its window, each taking the next
    pending recipient, sending, waiting out the gap, refreshing, and taking
    another - until the lane's rows are done or the run is stopped."""

    def __init__(self, lane: dict[str, Any], settings: dict[str, Any]) -> None:
        self.lane = lane
        self.settings = settings
        self.per_page: dict[Any, dict[str, Any]] = {}      # page -> what its traffic showed
        self._next = 0
        self._lock = asyncio.Lock()
        self.in_break = False     # one tab has the lane's break; the others wait
        self.active = 0           # tabs in the middle of a message

    # ── the window's traffic, kept per tab ──────────────────────────────────

    def _st(self, page: Any) -> dict[str, Any]:
        return self.per_page.setdefault(page, {"sent": [], "convos": [], "closed_hint": False})

    async def _on_response(self, response: Any) -> None:
        url = response.url
        try:
            page = response.frame.page
        except Exception:  # noqa: BLE001
            return
        st = self._st(page)
        if SEND_CALL in url and response.ok:
            try:
                st["sent"].append(await response.json())
            except Exception:  # noqa: BLE001
                pass
        elif CONVO_CALL in url:
            if response.ok:
                try:
                    st["convos"].append(await response.json())
                except Exception:  # noqa: BLE001
                    pass
            else:
                st["closed_hint"] = True

    # ── the steps ───────────────────────────────────────────────────────────

    async def open_chat(self, page: Any) -> None:
        """The chat LIST, where New chat is - not a conversation left open
        from the last recipient. The rail's Chat goes there from anywhere."""
        from urllib.parse import urlsplit
        if urlsplit(page.url).path.rstrip("/") != "/messages":
            rail = await find(page, CHAT_RAIL, timeout=3.0)
            if rail is not None:
                await click_like_a_person(page, rail)
            else:
                await page.goto(f"{config.BSKY_URL}messages", wait_until="domcontentloaded")
            for _ in range(40):
                if urlsplit(page.url).path.rstrip("/") == "/messages":
                    break
                await asyncio.sleep(0.2)
            else:
                await page.goto(f"{config.BSKY_URL}messages", wait_until="domcontentloaded")
        await asyncio.sleep(random.uniform(1.0, 2.0))

    async def new_chat_with(self, page: Any, handle: str) -> str:
        """New chat -> search -> first result -> the conversation. Returns
        'open' when the composer is up, else the reason it is not."""
        button = await find(page, NEW_CHAT, timeout=8.0)
        if button is None:
            return "no New chat button on the Chat page"
        await click_like_a_person(page, button)
        box = await find(page, SEARCH_INPUT, timeout=8.0)
        if box is None:
            return "the New chat search did not open"
        await click_like_a_person(page, box)
        await asyncio.sleep(random.uniform(0.3, 0.6))
        await type_at(page, handle, float(self.settings.get("typing_wpm", 240) or 240))
        # The results: the one naming this handle, else the first shown.
        loop = asyncio.get_running_loop()
        deadline = loop.time() + 10
        pick = None
        while loop.time() < deadline and pick is None:
            for sel in RESULT:
                loc = page.locator(sel)
                try:
                    n = await loc.count()
                except Exception:  # noqa: BLE001
                    continue
                for i in range(min(n, 8)):
                    item = loc.nth(i)
                    try:
                        text = (await item.inner_text()).lower()
                    except Exception:  # noqa: BLE001
                        continue
                    if handle.lower() in text:
                        pick = item
                        break
                if pick is None and n:
                    first = loc.first
                    try:
                        if await first.is_visible():
                            pick = first
                    except Exception:  # noqa: BLE001
                        pass
                if pick is not None:
                    break
            if pick is None:
                await asyncio.sleep(0.3)
        if pick is None:
            await page.keyboard.press("Escape")
            return "no result for that handle"
        st = self._st(page)
        st["convos"], st["closed_hint"] = [], False
        await asyncio.sleep(random.uniform(0.4, 0.9))
        await click_like_a_person(page, pick)
        composer = await find(page, MESSAGE_INPUT, timeout=12.0)
        if composer is None:
            if st["closed_hint"]:
                return "closed"
            body = (await page.inner_text("body")).lower()
            if any(t in body for t in CLOSED_TEXT):
                return "closed"
            return "the conversation did not open"
        try:
            if await composer.is_disabled():
                return "closed"
        except Exception:  # noqa: BLE001
            pass
        body = (await page.inner_text("body")).lower()
        if any(t in body for t in CLOSED_TEXT):
            return "closed"
        return "open"

    async def attach(self, page: Any, name: str) -> bool:
        picture = pick_image(name)
        path = await asyncio.to_thread(fetch_image, picture)
        try:
            b64 = base64.b64encode(path.read_bytes()).decode("ascii")
            ctype = mimetypes.guess_type(name)[0] or "image/png"
            for sel in MESSAGE_INPUT:
                said = await page.evaluate(PASTE_JS, [b64, Path(name).name, ctype, sel])
                if said == "pasted":
                    break
            try:
                await page.wait_for_function(PREVIEW_JS, timeout=6000)
                return True
            except Exception:  # noqa: BLE001
                return False
        finally:
            try:
                path.unlink()
            except OSError:
                pass

    async def send_one(self, page: Any, row: dict[str, Any]) -> None:
        handle = row["handle"]
        click_send = bool(self.settings.get("click_send", True))
        await self.open_chat(page)
        opened = await self.new_chat_with(page, handle)
        if opened != "open":
            row["chat"] = "none" if opened == "closed" else ""
            row["status"] = "failed"
            row["why"] = "DMs are closed" if opened == "closed" else opened
            await page.keyboard.press("Escape")
            return
        row["chat"] = "open"
        composer = await find(page, MESSAGE_INPUT, timeout=5.0)
        await click_like_a_person(page, composer)
        await asyncio.sleep(random.uniform(0.4, 0.9))
        notes = []
        wpm = float(self.settings.get("typing_wpm", 240) or 240)
        if row.get("media"):
            url = (self.lane.get("media_posts") or {}).get(row["media"])
            if url:
                # The picture, first: the link of the post that carries it,
                # pasted in as a person would, which the chat draws as the
                # post itself. Then a new line (Shift+Enter - Enter sends).
                await page.keyboard.insert_text(url)
                try:
                    await page.wait_for_function(EMBED_JS, timeout=6000)
                except Exception:  # noqa: BLE001 - the card's shape is Bluesky's; the link still goes
                    pass
                await asyncio.sleep(random.uniform(0.6, 1.2))
                if row.get("text"):
                    await page.keyboard.press("Shift+Enter")
            else:
                notes.append((self.lane.get("media_failed") or {}).get(row["media"])
                             or "picture left out: no post for it")
        if row.get("text"):
            await type_at(page, row["text"], wpm, slips=bool(self.settings.get("typing_slips", True)))
            await asyncio.sleep(random.uniform(0.5, 1.2))
        if not row.get("text") and not row.get("media"):
            row["status"] = "failed"
            row["why"] = "nothing to send"
            return
        if not click_send:
            row["status"] = "typed"
            row["why"] = "; ".join(notes)
            return
        st = self._st(page)
        st["sent"] = []
        button = await find(page, SEND_BTN, timeout=3.0)
        if button is not None:
            await click_like_a_person(page, button)
        else:
            await page.keyboard.press("Enter")
        for _ in range(60):
            if st["sent"]:
                break
            await asyncio.sleep(0.25)
        if st["sent"]:
            row["status"] = "sent"
            row["why"] = "; ".join(notes)
            record_sent(handle, self.lane["account"])
        else:
            body = (await page.inner_text("body")).lower()
            row["status"] = "failed"
            row["why"] = "DMs are closed" if any(t in body for t in CLOSED_TEXT) else "Bluesky did not confirm the send"
            if row["why"] == "DMs are closed":
                row["chat"] = "none"

    # ── the tabs ────────────────────────────────────────────────────────────

    async def _take(self) -> dict[str, Any] | None:
        """The next pending row of this lane, claimed for one tab. A break row
        is claimed for the whole lane: the tab that takes it runs the break,
        and until it is over every other tab is handed `WAIT`."""
        async with self._lock:
            if self.in_break:
                return WAIT
            for row in self.lane["rows"]:
                if row["status"] == "pending":
                    row["status"] = "processing"
                    if row.get("kind") == "break":
                        self.in_break = True
                    return row
        return None

    async def take_break(self, row: dict[str, Any], stop: asyncio.Event, paused: asyncio.Event) -> None:
        """The break, for the lane: the other tabs finish the message they
        are on; this account's window presses the rail items rolled for the
        break, one by one, as the Actions panel would; and what is left of
        the rolled minutes is waited out before sending goes on."""
        loop = asyncio.get_running_loop()
        minutes = float(row.get("minutes") or 0)
        items = ", ".join(rail.RAIL.get(k, (k, ""))[0] for k in (row.get("actions") or [])) or "no actions"
        pressed: list[str] = []
        failed: list[str] = []
        row["why"] = f"{minutes:g} min · waiting for the other tabs to finish · {items}"
        try:
            for _ in range(600):
                if self.active == 0 or stop.is_set():
                    break
                await asyncio.sleep(0.5)
            # The clock starts once the window is free: the live panel counts
            # down from `ends_at` (wall-clock seconds), the actions pressed
            # inside that time.
            began = loop.time()
            row["ends_at"] = time.time() + minutes * 60
            for key in row.get("actions") or []:
                while paused.is_set() and not stop.is_set():
                    await asyncio.sleep(0.5)
                if stop.is_set():
                    break
                label = rail.RAIL.get(key, (key, ""))[0]
                row["why"] = f"{minutes:g} min · pressing {label}" + (
                    f" · pressed {', '.join(pressed)}" if pressed else "")
                try:
                    await asyncio.wait_for(rail.press(key, session=self.lane["id"]), 120)
                    pressed.append(label)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001 - that item goes unpressed; the break goes on
                    why = str(exc).splitlines()[0][:60] if str(exc) else exc.__class__.__name__
                    failed.append(f"{label} ({why})")
                await asyncio.sleep(random.uniform(4.0, 10.0))
            row["why"] = f"{minutes:g} min · pressed {', '.join(pressed) if pressed else 'nothing'} · resting"
            end = began + minutes * 60
            while loop.time() < end and not stop.is_set():
                await asyncio.sleep(0.5)
        except asyncio.CancelledError:
            row["status"], row["why"] = "pending", ""
            row.pop("ends_at", None)
            raise
        finally:
            self.in_break = False
        row.pop("ends_at", None)
        note = f"{minutes:g} min · pressed {', '.join(pressed) if pressed else 'nothing'}"
        if failed:
            note += " · could not press " + ", ".join(failed)
        if stop.is_set():
            row["status"], row["why"] = "failed", "stopped during the break · " + note
        else:
            row["status"], row["why"] = "sent", note

    async def _tab(self, ctx: Any, n: int, stop: asyncio.Event, paused: asyncio.Event) -> None:
        """One tab of the pool. It takes a recipient, sends, waits out the
        gap, refreshes, and takes the next; a tab that breaks is closed and
        a fresh one opened in its place."""
        gap_min = float(self.settings.get("gap_min_seconds", 35) or 0)
        gap_max = max(gap_min, float(self.settings.get("gap_max_seconds", 95) or 0))
        page = None
        try:
            while not stop.is_set():
                while paused.is_set() and not stop.is_set():
                    await asyncio.sleep(0.5)
                if stop.is_set():
                    break
                row = await self._take()
                if row is None:
                    break
                if row is WAIT:
                    await asyncio.sleep(0.5)
                    continue
                if row.get("kind") == "break":
                    await self.take_break(row, stop, paused)
                    continue
                if page is None or page.is_closed():
                    page = await ctx.new_page()
                    self.per_page.pop(page, None)
                    await page.goto(f"{config.BSKY_URL}messages", wait_until="domcontentloaded")
                    await asyncio.sleep(random.uniform(1.0, 2.0))
                self.active += 1
                try:
                    await asyncio.wait_for(self.send_one(page, row), 240)
                except asyncio.CancelledError:
                    row["status"], row["why"] = "pending", ""
                    raise
                except Exception as exc:  # noqa: BLE001 - this one failed; the tab is replaced
                    row["status"] = "failed"
                    row["why"] = (str(exc).splitlines()[0][:120] if str(exc) else exc.__class__.__name__)
                    try:
                        await page.close()
                    except Exception:  # noqa: BLE001
                        pass
                    page = None
                finally:
                    self.active -= 1
                # The gap after a message, rolled from the settings range, with
                # a little wandering so the tab is not a metronome; then the
                # tab is refreshed for the next recipient.
                if stop.is_set():
                    break
                gap = random.uniform(gap_min, gap_max)
                end = asyncio.get_running_loop().time() + gap
                if page is not None:
                    try:
                        await human_scroll(page, random.randint(150, 400), stop)
                    except Exception:  # noqa: BLE001
                        pass
                while asyncio.get_running_loop().time() < end and not stop.is_set():
                    await asyncio.sleep(0.5)
                if page is not None and not page.is_closed():
                    try:
                        await page.goto(f"{config.BSKY_URL}messages", wait_until="domcontentloaded")
                        await asyncio.sleep(random.uniform(0.8, 1.5))
                    except Exception:  # noqa: BLE001
                        try:
                            await page.close()
                        except Exception:  # noqa: BLE001
                            pass
                        page = None
        finally:
            if page is not None and not page.is_closed():
                try:
                    await page.close()
                except Exception:  # noqa: BLE001
                    pass

    async def post_pictures(self, ctx: Any, stop: asyncio.Event) -> None:
        """Every picture dealt to this lane, published once as a post of this
        account (picture only), so each chat can carry it as an embedded post.
        The link of each is kept on the lane; a picture whose post failed is
        left out of its messages, with the reason on the row."""
        wanted = sorted({r["media"] for r in self.lane["rows"] if r.get("media") and r["status"] == "pending"})
        self.lane.setdefault("media_posts", {})
        self.lane.setdefault("media_failed", {})
        if not wanted or not self.settings.get("media_via_post", False):
            # Off by default: the chats go text-only, straight to the people
            # picked, and nothing is published anywhere.
            for name in wanted:
                self.lane["media_failed"][name] = "Bluesky chat takes no pictures (text sent)"
            return
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        login = self.lane.get("login") or ""
        for name in wanted:
            if stop.is_set():
                return
            if name in self.lane["media_posts"]:
                continue
            self.lane["posting"] = name
            try:
                from .actions import _click_rail

                async def open_composer() -> None:
                    await page.keyboard.press("Escape")
                    await asyncio.sleep(0.3)
                    await _click_rail(page, "Compose new post")
                out = await asyncio.wait_for(
                    posting.compose(page, open_composer, image=name, mode="photo"), 120)
                uri = out.get("uri") or ""
                # at://did/app.bsky.feed.post/rkey -> the page the chat can embed
                parts = uri.split("/")
                if uri.startswith("at://") and len(parts) >= 5:
                    url = f"{config.BSKY_URL}profile/{parts[2]}/post/{parts[-1]}"
                else:
                    raise ValueError("the post was made but its address was not seen")
                self.lane["media_posts"][name] = url
            except Exception as exc:  # noqa: BLE001 - that picture goes without; the run goes on
                self.lane["media_failed"][name] = (str(exc).splitlines()[0][:120] if str(exc) else exc.__class__.__name__)
            await asyncio.sleep(random.uniform(2.0, 4.0))
        self.lane.pop("posting", None)

    async def run(self, stop: asyncio.Event, paused: asyncio.Event) -> None:
        ctx = browser.contexts.get(self.lane["id"])
        if ctx is None:
            for r in self.lane["rows"]:
                if r["status"] == "pending":
                    r["status"], r["why"] = "failed", "window closed"
            return
        listener = lambda r: asyncio.ensure_future(self._on_response(r))  # noqa: E731
        ctx.on("response", listener)
        tabs = max(1, min(10, int(float(self.settings.get("parallel_tabs", 5) or 5))))
        pending = sum(1 for r in self.lane["rows"] if r["status"] == "pending")
        tabs = max(1, min(tabs, pending))
        try:
            if ctx.pages:
                await ctx.pages[0].bring_to_front()
            await self.post_pictures(ctx, stop)
            # The tabs open a few seconds apart, not all at once.
            jobs = []
            for n in range(tabs):
                jobs.append(asyncio.ensure_future(self._tab(ctx, n, stop, paused)))
                await asyncio.sleep(random.uniform(2.0, 4.0))
            await asyncio.gather(*jobs, return_exceptions=True)
        finally:
            try:
                ctx.remove_listener("response", listener)
            except Exception:  # noqa: BLE001
                pass


# ── the run ──────────────────────────────────────────────────────────────────

def start(body: dict[str, Any]) -> dict[str, Any]:
    if CAMP["state"] in ("running", "paused"):
        raise ValueError("A campaign is already running — stop it first.")
    lanes = plan(body)
    pictures = sorted({r["media"] for l in lanes for r in l["rows"] if r.get("media")})
    open_lanes = [l for l in lanes if browser.is_open(l["id"])]
    if not open_lanes:
        raise ValueError("None of the picked accounts has a window open - open one from the Accounts panel first.")
    for l in lanes:
        if l not in open_lanes:
            for r in l["rows"]:
                r["status"], r["why"] = "failed", "window not open"
    settings = body.get("settings") or {}
    stop, paused = asyncio.Event(), asyncio.Event()
    total = sum(1 for l in lanes for r in l["rows"] if not r.get("kind"))
    breaks = sum(1 for l in lanes for r in l["rows"] if r.get("kind") == "break")
    note = f"{total} recipients queued."
    if breaks:
        note += f" {breaks} break{'s' if breaks != 1 else ''} planned, each pressing a few rail items."
    if pictures and settings.get("media_via_post", False):
        note += (f" {len(pictures)} picture{'s' if len(pictures) != 1 else ''} will first be published as a post"
                 f" from each sending account, so the chats can carry {'them' if len(pictures) != 1 else 'it'}.")
    elif pictures:
        note += " Bluesky chat cannot carry a picture, so the messages go text-only."
    CAMP.update(state="running", lanes=lanes, note=note, stop=stop, paused=paused, settings=settings)

    async def run(task: tasks.Task) -> None:
        senders = [Sender(l, settings) for l in open_lanes]
        jobs = [asyncio.ensure_future(s.run(stop, paused)) for s in senders]
        try:
            while any(not j.done() for j in jobs):
                rows = [r for l in CAMP["lanes"] for r in l["rows"] if not r.get("kind")]
                done = sum(1 for r in rows if r["status"] in ("sent", "typed", "failed"))
                task.progress = done / max(len(rows), 1)
                task.detail = f"{done} of {len(rows)}"
                task.result = state()
                await asyncio.sleep(0.8)
        finally:
            for j in jobs:
                if not j.done():
                    j.cancel()
            await asyncio.gather(*jobs, return_exceptions=True)
            rows = [r for l in CAMP["lanes"] for r in l["rows"] if not r.get("kind")]
            failed = sum(1 for r in rows if r["status"] == "failed")
            sent = sum(1 for r in rows if r["status"] == "sent")
            typed = sum(1 for r in rows if r["status"] == "typed")
            if stop.is_set():
                CAMP["state"] = "stopped"
                CAMP["note"] = f"Stopped — {sent} sent, {typed} typed, {failed} failed."
            else:
                CAMP["state"] = "done"
                CAMP["note"] = f"Finished — {sent} sent, {typed} typed, {failed} failed."
            task.result = state()
            task.finish(state(), CAMP["note"])

    task = tasks.start("campaign", run)
    CAMP["task"] = task.id
    return {"task": task.id, **state()}


def pause() -> dict[str, Any]:
    if CAMP["state"] != "running":
        raise ValueError("No campaign is running.")
    CAMP["paused"].set()
    CAMP["state"] = "paused"
    CAMP["note"] = "Paused. The recipient it was on finished first."
    return state()


def resume() -> dict[str, Any]:
    if CAMP["state"] != "paused":
        raise ValueError("The campaign is not paused.")
    CAMP["paused"].clear()
    CAMP["state"] = "running"
    CAMP["note"] = "Resumed."
    return state()


def stop() -> dict[str, Any]:
    if CAMP["state"] not in ("running", "paused"):
        raise ValueError("No campaign is running.")
    CAMP["stop"].set()
    CAMP["paused"].clear()
    out = state()
    out["note"] = "Stopping — it finishes the recipient it is on."
    return out
