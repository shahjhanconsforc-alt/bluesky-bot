"""Actions: the items down the left of bsky.app, pressed one at a time.

Each action is one item of Bluesky's own rail - the real element in the open
window, found by the label Bluesky gives it (`aria-label`), not a navigation
to its address. A press moves the pointer over, clicks, lets the page land,
and then scrolls it the way a reader would: a few posts' worth in small wheel
ticks, a pause, sometimes a nudge back. Items that open something over the
page (Switch accounts, Compose) are opened, left for a moment, and closed
again with Escape.
"""

from __future__ import annotations

import asyncio
import random
from typing import Any

from . import post
from .automation.browser import browser
from .scrape import human_scroll
from .store import store

# key -> (label on the rail, what the press does)
#   page:   a place; after the click the page is scrolled
#   popup:  opens a menu or a dialog; left open a moment, then closed
RAIL: dict[str, tuple[str, str]] = {
    "switch":        ("Switch accounts",  "popup"),
    "home":          ("Home",             "page"),
    "explore":       ("Explore",          "page"),
    "notifications": ("Notifications",    "page"),
    "chat":          ("Chat",             "page"),
    "feeds":         ("Feeds",            "page"),
    "lists":         ("Lists",            "page"),
    "saved":         ("Saved",            "page"),
    "profile":       ("Profile",          "page"),
    "settings":      ("Settings",         "page"),
    # Not a look: a post. One Campaign message and one picture from Media,
    # typed into the composer and published - see post.py.
    "compose":       ("Compose new post", "post"),
}

# The rail itself, so a label that also appears elsewhere on the page (a
# "Home" tab, a "Profile" link in a card) is not what gets pressed.
RAIL_SEL = 'nav[role="navigation"] [aria-label="{label}"], [role="navigation"] a[aria-label="{label}"], [aria-label="{label}"]'


def actions() -> list[dict[str, Any]]:
    return [{"key": k, "label": label, "kind": kind} for k, (label, kind) in RAIL.items()]


def windows() -> list[dict[str, Any]]:
    return [{"id": a["id"], "label": "@" + a["login"]}
            for a in store.accounts() if browser.is_open(a["id"])]


def _pick(session: str | None) -> tuple[str, Any]:
    open_ids = [a["id"] for a in store.accounts() if browser.is_open(a["id"])]
    if not open_ids:
        raise ValueError("No browser window is open - open an account from the Accounts panel first.")
    account_id = str(session) if session and str(session) in open_ids else open_ids[0]
    ctx = browser.contexts[account_id]
    page = ctx.pages[0] if ctx.pages else None
    if page is None:
        raise ValueError("That window has no page open.")
    return account_id, page


async def _settle(page: Any, seconds: float) -> None:
    try:
        await page.wait_for_load_state("domcontentloaded", timeout=int(seconds * 1000))
    except Exception:  # noqa: BLE001 - a client-side route change fires none
        pass
    await asyncio.sleep(random.uniform(0.8, 1.6))


async def press(key: str, session: str | None = None, text: str = "", draft: str = "",
                image: str = "", mode: str = "both", dry_run: bool = False) -> dict[str, Any]:
    if key not in RAIL:
        raise ValueError(f"{key or 'nothing'} is not a rail item this can press.")
    label, kind = RAIL[key]
    account_id, page = _pick(session)
    await page.bring_to_front()

    # Anything left over a previous press - a menu, a composer - goes first.
    await page.keyboard.press("Escape")
    await asyncio.sleep(0.3)

    if kind == "post":
        async def open_composer() -> None:
            await _click_rail(page, label)
        out = await post.compose(page, open_composer, text=text, draft_name=draft, image=image,
                                 mode=mode, dry_run=dry_run)
        return {"ok": True, "action": key, "label": label, "account": account_id, **out}

    await _click_rail(page, label)

    if kind == "popup":
        await asyncio.sleep(random.uniform(1.5, 2.5))
        await page.keyboard.press("Escape")
        await asyncio.sleep(0.3)
        return {"ok": True, "action": key, "label": label, "account": account_id,
                "result": "opened and closed"}

    await _settle(page, 6)
    stop = asyncio.Event()
    # A read of the page that opened: down a few screens, tick by tick, with
    # a pause between, and up a little at the end as if going back to a post.
    screens = random.randint(2, 4)
    for _ in range(screens):
        await human_scroll(page, random.randint(500, 900), stop)
        await asyncio.sleep(random.uniform(0.6, 1.8))
    await human_scroll(page, -random.randint(150, 400), stop)
    return {"ok": True, "action": key, "label": label, "account": account_id,
            "result": "clicked and scrolled", "url": page.url}


async def _click_rail(page: Any, label: str) -> None:
    """The rail item with this label, clicked the way a hand would."""
    target = None
    for sel in RAIL_SEL.format(label=label).split(", "):
        loc = page.locator(sel).first
        try:
            if await loc.count() and await loc.is_visible():
                target = loc
                break
        except Exception:  # noqa: BLE001 - mid-navigation
            continue
    if target is None:
        raise ValueError(f"'{label}' is not on the rail in that window - is it signed in to bsky.app?")

    box = await target.bounding_box()
    if not box:
        raise ValueError(f"'{label}' is on the page but has no place to click.")
    x = box["x"] + box["width"] * random.uniform(0.35, 0.65)
    y = box["y"] + box["height"] * random.uniform(0.35, 0.65)
    # Over, a beat, click: a hand, not a jump to the pixel.
    await page.mouse.move(x + random.randint(-40, 40), y + random.randint(-30, 30),
                          steps=random.randint(8, 14))
    await asyncio.sleep(random.uniform(0.08, 0.2))
    await page.mouse.move(x, y, steps=random.randint(4, 8))
    await asyncio.sleep(random.uniform(0.05, 0.15))
    await page.mouse.click(x, y)
