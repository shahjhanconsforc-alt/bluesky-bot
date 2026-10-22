"""The real browser: one Chrome profile per account, opened on bsky.app.

The profile directory IS the session. Bluesky keeps its sign-in inside the
page's own storage, and a persistent context keeps that between launches - so
an account that signed in once reopens signed in. The directory is kept on
MinIO (backend/minio_store.py), not in the project: before a window opens the
account's zip is pulled into a cache directory, and the directory is zipped
back up the moment a sign-in lands and again when the window closes. "Log
out" deletes the zip from the bucket and the cache directory with it.

How a sign-in is noticed: by the traffic, not the page. The moment an account
is signed in, every call the web app makes to its server carries that
account's token, and the token names the account (`sub` is the DID). The
window is listened to for exactly that, and the handle is read off the
server's own session replies (or looked up from the DID on the public API).
Nothing here depends on how the page is drawn or where it keeps its storage,
both of which Bluesky changes without notice - the storage key this used to
read is already gone.

With an app password on file the sign-in form is filled in to save the
typing; if Bluesky's page has moved and the fields are not where expected, the
window is simply left for the operator, which is the state it would have been
in anyway.
"""

from __future__ import annotations

import asyncio
import base64
import json
import shutil
import urllib.parse
import urllib.request
from typing import Any

from playwright.async_api import BrowserContext, Page, Request, Response, async_playwright

from .. import config
from .. import minio_store as minio
from ..store import now, store

PUBLIC_API = "https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor="

# The server calls whose reply names the signed-in account outright.
SESSION_CALLS = ("com.atproto.server.getSession", "com.atproto.server.refreshSession",
                 "com.atproto.server.createSession")
SIGN_OUT_CALL = "com.atproto.server.deleteSession"

# Bluesky's own test ids on the sign-in form (still current). The button that
# opens the form on the logged-out landing page has none, so it is found by
# its name.
LOGIN_FORM = '[data-testid="loginForm"]'
USERNAME_INPUT = '[data-testid="loginUsernameInput"]'
PASSWORD_INPUT = '[data-testid="loginPasswordInput"]'
NEXT_BUTTON = '[data-testid="loginNextButton"]'

# The old place the session lived. Kept as a last resort for an older build
# of the web app; the traffic is what is relied on.
READ_STORAGE_JS = """
() => {
  try {
    const s = JSON.parse(localStorage.getItem('BSKY_STORAGE') || 'null');
    const a = s && s.session && s.session.currentAccount;
    return a && a.did ? { handle: a.handle || '', did: a.did } : null;
  } catch (e) { return null; }
}
"""


def did_from_token(header: str | None) -> str:
    """The DID inside a `Bearer <jwt>` header, or '' if it is not one."""
    if not header or not header.lower().startswith("bearer "):
        return ""
    token = header[7:].strip()
    parts = token.split(".")
    if len(parts) != 3:
        return ""
    try:
        payload = parts[1] + "=" * (-len(parts[1]) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload))
        sub = str(claims.get("sub", ""))
        return sub if sub.startswith("did:") else ""
    except (ValueError, TypeError):
        return ""


def _lookup_handle(did: str) -> str:
    """The handle behind a DID, from the public API. No auth, one GET."""
    try:
        with urllib.request.urlopen(PUBLIC_API + urllib.parse.quote(did), timeout=10) as r:
            return str(json.load(r).get("handle", ""))
    except Exception:  # noqa: BLE001 - offline, rate-limited: the DID still stands
        return ""


class Browser:
    def __init__(self) -> None:
        self._pw: Any = None
        self.contexts: dict[str, BrowserContext] = {}
        # account id -> {did, handle}: what the window's traffic has shown.
        self.seen: dict[str, dict[str, str]] = {}
        self._handles: dict[str, str] = {}     # did -> handle, looked up once

    # ── lifecycle ──────────────────────────────────────────────────────────

    async def start(self) -> None:
        if self._pw is None:
            self._pw = await async_playwright().start()

    async def stop(self) -> None:
        for account_id in list(self.contexts):
            await self.close(account_id)
        if self._pw is not None:
            await self._pw.stop()
            self._pw = None

    def is_open(self, account_id: str) -> bool:
        return str(account_id) in self.contexts

    def open_ids(self) -> list[str]:
        return list(self.contexts)

    def page_count(self) -> int:
        return sum(len(c.pages) for c in self.contexts.values())

    # ── windows ────────────────────────────────────────────────────────────

    async def open(self, account_id: str) -> Page:
        """Open (or focus) the account's window on bsky.app."""
        account_id = str(account_id)
        await self.start()
        ctx = self.contexts.get(account_id)
        if ctx is not None:
            page = ctx.pages[0] if ctx.pages else await ctx.new_page()
            await page.bring_to_front()
            return page

        profile = config.PROFILES_DIR / account_id
        profile.mkdir(parents=True, exist_ok=True)
        # The saved session, if there is one, into the working directory. A
        # MinIO that is off is reported on the card, and the window still opens
        # - on whatever the cache holds, which is a fresh sign-in at worst.
        try:
            if await asyncio.to_thread(minio.session_download, account_id, profile):
                store.set_session(account_id, detail="session pulled from MinIO")
        except minio.MinioError as exc:
            store.set_session(account_id, detail=f"MinIO: {exc}")
        launch: dict[str, Any] = dict(
            user_data_dir=str(profile),
            headless=config.HEADLESS,
            no_viewport=True,
            args=["--start-maximized", "--disable-blink-features=AutomationControlled"],
            ignore_default_args=["--enable-automation"],
        )
        if config.BROWSER_CHANNEL:
            launch["channel"] = config.BROWSER_CHANNEL
        try:
            ctx = await self._pw.chromium.launch_persistent_context(**launch)
        except Exception as exc:  # noqa: BLE001
            if config.BROWSER_CHANNEL:
                # No Google Chrome (or an old one): fall back to Playwright's
                # Chromium rather than failing the press.
                launch.pop("channel", None)
                ctx = await self._pw.chromium.launch_persistent_context(**launch)
            else:
                raise RuntimeError(f"Could not start the browser: {exc}") from exc

        self.contexts[account_id] = ctx
        self.seen.pop(account_id, None)
        ctx.on("request", lambda req: self._on_request(account_id, req))
        ctx.on("response", lambda res: self._on_response(account_id, res))
        ctx.on("close", lambda: self._closed(account_id))
        store.set_session(account_id, active=True,
                          detail="active now — sign in, it saves itself")

        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        await page.goto(config.BSKY_URL, wait_until="domcontentloaded")
        return page

    def _closed(self, account_id: str) -> None:
        if account_id not in self.contexts:
            return                              # close() already handled it
        self.contexts.pop(account_id, None)
        self.seen.pop(account_id, None)
        s = store.session(account_id)
        store.set_session(account_id, active=False,
                          detail=("stored" if s.get("logged_in") else "window closed before sign-in"))
        if s.get("logged_in"):
            # The operator closed the window: whatever Bluesky wrote since the
            # sign-in (a refreshed token) goes up with it. Chrome lets go of
            # its files a beat after the event, hence the delay.
            asyncio.get_running_loop().create_task(self.save(account_id, delay=1.5))

    async def save(self, account_id: str, delay: float = 0.0) -> dict[str, Any] | None:
        """Zip the profile to MinIO as the account's session. Best effort: a
        MinIO that is off is written on the card, and the window carries on."""
        account_id = str(account_id)
        if delay:
            await asyncio.sleep(delay)
        profile = config.PROFILES_DIR / account_id
        if not (profile / "Default").is_dir():
            return None
        s = store.session(account_id)
        meta = {"handle": s.get("as_handle", ""), "did": s.get("did", ""),
                "login": (store.get(account_id) or {}).get("login", "")}
        try:
            out = await asyncio.to_thread(minio.session_upload, account_id, profile, meta)
        except minio.MinioError as exc:
            store.set_session(account_id, saved=False, detail=f"signed in, not saved - MinIO: {exc}")
            return None
        store.set_session(account_id, saved=True, saved_at=now(),
                          detail="stored on MinIO" if s.get("logged_in") else s.get("detail", ""))
        return out

    async def close(self, account_id: str) -> None:
        ctx = self.contexts.pop(str(account_id), None)
        self.seen.pop(str(account_id), None)
        if ctx is not None:
            try:
                await ctx.close()
            except Exception:  # noqa: BLE001 - already gone is fine
                pass
            store.set_session(account_id, active=False)
            if store.session(account_id).get("logged_in"):
                await self.save(account_id, delay=1.0)

    async def forget(self, account_id: str) -> None:
        """Log out: close the window, delete every object of the session from
        MinIO, and the working directory with it. The bucket is the only place
        the session is kept, so a MinIO that cannot be reached is an error
        here - a log-out that left the session behind would be a lie."""
        account_id = str(account_id)
        ctx = self.contexts.pop(account_id, None)
        self.seen.pop(account_id, None)
        if ctx is not None:
            try:
                await ctx.close()
            except Exception:  # noqa: BLE001
                pass
        profile = config.PROFILES_DIR / account_id
        for _ in range(5):                     # Chrome lets go of its files a beat late
            shutil.rmtree(profile, ignore_errors=True)
            if not profile.exists():
                break
            await asyncio.sleep(0.4)
        store.clear_session(account_id)
        try:
            removed = await asyncio.to_thread(minio.session_delete, account_id)
        except minio.MinioError as exc:
            store.set_session(account_id, detail=f"logged out here; MinIO not cleared: {exc}")
            raise RuntimeError(f"Session files not removed from MinIO: {exc}") from exc
        store.set_session(account_id, detail=(f"no session ({removed} file(s) removed from MinIO)"
                                              if removed else "no session"))

    # ── listening to the window ────────────────────────────────────────────

    def _on_request(self, account_id: str, request: Request) -> None:
        url = request.url
        if "/xrpc/" not in url:
            return
        if SIGN_OUT_CALL in url:
            self.seen.pop(account_id, None)
            return
        did = did_from_token(request.headers.get("authorization"))
        if did:
            entry = self.seen.setdefault(account_id, {"did": "", "handle": ""})
            if entry["did"] != did:
                entry.update(did=did, handle=self._handles.get(did, ""))

    async def _on_response(self, account_id: str, response: Response) -> None:
        url = response.url
        if not any(call in url for call in SESSION_CALLS) or not response.ok:
            return
        try:
            data = await response.json()
        except Exception:  # noqa: BLE001 - not JSON, or the body is gone
            return
        did, handle = str(data.get("did", "")), str(data.get("handle", ""))
        if did and handle:
            self._handles[did] = handle
            self.seen[account_id] = {"did": did, "handle": handle}

    # ── reading the session ────────────────────────────────────────────────

    async def read(self, account_id: str) -> dict[str, Any] | None:
        """Who the open window is signed in as, or None if nobody / no window."""
        account_id = str(account_id)
        ctx = self.contexts.get(account_id)
        if ctx is None:
            return None

        who = self.seen.get(account_id)
        if who and who.get("did"):
            if not who.get("handle"):
                did = who["did"]
                handle = self._handles.get(did) or await asyncio.to_thread(_lookup_handle, did)
                if handle:
                    self._handles[did] = handle
                    who["handle"] = handle
            return dict(who)

        # An older build of the web app: the session sat in localStorage.
        for page in ctx.pages:
            try:
                if "bsky.app" in page.url:
                    found = await page.evaluate(READ_STORAGE_JS)
                    if found:
                        return found
            except Exception:  # noqa: BLE001 - a page mid-navigation
                continue
        return None

    async def record(self, account_id: str, who: dict[str, Any] | None) -> dict[str, Any]:
        account = store.get(account_id) or {}
        if who:
            handle = (who.get("handle") or "").lower()
            login = (account.get("login") or "").lower()
            mismatch = bool(handle and login and handle != login
                            and handle != f"{login}.bsky.social" and login != f"{handle}.bsky.social")
            was = store.session(account_id).get("logged_in")
            row = store.set_session(
                account_id, logged_in=True, as_handle=who.get("handle", ""), did=who.get("did", ""),
                mismatch=mismatch, checked_at=now(),
                detail=("signed in as another account" if mismatch else "stored"))
            if not was or not row.get("saved"):
                # The sign-in just landed: it is on MinIO before anything else
                # can happen to the window.
                await self.save(account_id)
            return store.session(account_id)
        return store.set_session(account_id, logged_in=False, as_handle="", mismatch=False,
                                 checked_at=now(),
                                 detail=("active now — sign in, it saves itself"
                                         if self.is_open(account_id) else "no session"))

    # ── the sign-in itself ─────────────────────────────────────────────────

    async def prefill(self, page: Page, login: str, password: str) -> bool:
        """Type the handle and app password into Bluesky's form and press
        Sign in. True if it got that far; False leaves the window as it is."""
        try:
            if not await page.locator(LOGIN_FORM).count():
                await page.get_by_role("button", name="Sign in").first.click(timeout=4000)
            await page.locator(USERNAME_INPUT).first.fill(login, timeout=8000)
            await page.locator(PASSWORD_INPUT).first.fill(password, timeout=4000)
            await page.locator(NEXT_BUTTON).first.click(timeout=4000)
            return True
        except Exception:  # noqa: BLE001 - the page is not where the ids say
            return False

    async def watch(self, account_id: str, task: Any) -> None:
        """Poll the window until a signed-in account appears, it closes, or the
        wait runs out. A stored password is typed in once it is clear the
        profile did not come back already signed in."""
        account_id = str(account_id)
        account = store.get(account_id) or {}
        loop = asyncio.get_running_loop()
        started = loop.time()
        deadline = started + config.SIGNIN_WAIT_SECONDS
        task.detail = f"waiting for the sign-in on @{account.get('login', account_id)}"
        filled = not account.get("password")      # nothing to type: skip that step
        while loop.time() < deadline:
            if not self.is_open(account_id):
                task.finish(store.session(account_id), "window closed")
                return
            who = await self.read(account_id)
            if who:
                row = await self.record(account_id, who)
                task.finish(row, f"signed in as @{who.get('handle') or '?'}")
                return
            # A profile that came back signed in says so in its first few
            # seconds of traffic; past that it is a fresh sign-in, so type it.
            if not filled and loop.time() - started > 5:
                filled = True
                ctx = self.contexts.get(account_id)
                if ctx and ctx.pages:
                    task.detail = "typing the handle and app password"
                    typed = await self.prefill(ctx.pages[0], account["login"], account["password"])
                    task.detail = ("filled in — finish the sign-in in the window" if typed
                                   else "sign in in the window")
            await asyncio.sleep(1)
        task.finish(store.session(account_id), "no sign-in seen — the window is still open")


browser = Browser()
