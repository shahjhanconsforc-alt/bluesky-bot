"""The server: the console's page and the part of its API that needs a machine.

What is real here is accounts and their browser windows. "Sign in & save" on
the Accounts panel opens a Chrome profile on bsky.app and watches it until the
sign-in lands; "Open" brings a saved one back signed in; "Log out" deletes the
profile. Everything else the console asks for - scraping, campaigns, groups,
settings - is still answered in the browser by frontend/mock.js, which hands
exactly these paths to this server and mirrors what it says about sessions so
its other panels see the real windows.

Run it with `python run.py` from the repo root.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import actions, campaign, config, feed, scrape, tasks
from . import minio_store as minio
from .automation.browser import browser
from .store import store


async def reconcile_sessions() -> dict[str, Any]:
    """Make the cards agree with the bucket. A session is stored when its zip
    is on MinIO, and only then: one deleted there is gone here too, and one
    saved by another copy of this console shows up. Accounts with a window
    open are left to the window."""
    saved = await asyncio.to_thread(minio.sessions_saved)
    changed = 0
    for a in store.accounts():
        if browser.is_open(a["id"]):
            continue
        s = store.session(a["id"])
        on_minio = a["id"] in saved
        if on_minio and not s.get("logged_in"):
            store.set_session(a["id"], logged_in=True, saved=True, active=False,
                              saved_at=saved[a["id"]]["saved_at"], detail="stored on MinIO")
            changed += 1
        elif not on_minio and s.get("logged_in"):
            store.set_session(a["id"], logged_in=False, saved=False, as_handle="",
                              active=False, detail="no session (not on MinIO)")
            changed += 1
        elif on_minio and not s.get("saved"):
            store.set_session(a["id"], saved=True, saved_at=saved[a["id"]]["saved_at"])
    return {"on_minio": len(saved), "changed": changed}


@asynccontextmanager
async def lifespan(_: FastAPI):
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    config.PROFILES_DIR.mkdir(parents=True, exist_ok=True)
    try:
        out = await reconcile_sessions()
        print(f"MinIO: {out['on_minio']} saved session(s) in {config.MINIO_SESSIONS_BUCKET}")
    except minio.MinioError as exc:
        print(f"MinIO: {exc} - cards show what was last known")
    yield
    tasks.stop_all()
    await browser.stop()


app = FastAPI(title="bluesky-bot", lifespan=lifespan)


@app.middleware("http")
async def no_store(request: Request, call_next):
    # app.js is one script with its wiring at top level; a stale copy over
    # fresh markup renders a console whose buttons do nothing.
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store, max-age=0"
    return response


@app.exception_handler(ValueError)
async def bad_request(_: Request, exc: ValueError):
    return JSONResponse({"detail": str(exc)}, status_code=400)


@app.exception_handler(minio.MinioError)
async def minio_down(_: Request, exc: minio.MinioError):
    return JSONResponse({"detail": str(exc)}, status_code=503)


@app.exception_handler(RuntimeError)
async def runtime_failed(_: Request, exc: RuntimeError):
    return JSONResponse({"detail": str(exc)}, status_code=500)


def account_or_404(account_id: str) -> dict[str, Any]:
    account = store.get(account_id)
    if account is None:
        raise HTTPException(404, "That account is not on the list.")
    return account


# ── Accounts ─────────────────────────────────────────────────────────────────

@app.get("/api/accounts")
async def list_accounts():
    return {"accounts": [store.public(a) for a in store.accounts()]}


@app.post("/api/accounts")
async def add_account(body: dict[str, Any]):
    account = store.add(login=str(body.get("login", "")), email=str(body.get("email", "")),
                        password=str(body.get("password", "")), label=str(body.get("label", "")))
    return {"id": account["id"]}


@app.get("/api/accounts/sessions")
async def sessions():
    return {"sessions": store.session_rows()}


@app.get("/api/accounts/busy")
async def busy():
    """Which accounts a run holds right now: a campaign's lanes while it
    sends, a scrape's while it walks. The pickers read it every few seconds."""
    held: dict[str, str] = {}
    if scrape.RUN["running"]:
        for lane_id, lane in scrape.RUN["lanes"].items():
            if lane.get("running"):
                held[str(lane_id)] = "Scraping"
    if campaign.CAMP["state"] in ("running", "paused"):
        for lane in campaign.CAMP["lanes"]:
            if any(r["status"] in ("pending", "processing") for r in lane["rows"]):
                held[str(lane["id"])] = "Campaign"
    if feed.RUN["running"]:
        for lane_id, lane in feed.RUN["lanes"].items():
            if lane.get("state") == "running":
                held[str(lane_id)] = "Feed Campaign"
    return {"busy": held}


@app.post("/api/accounts/sessions/check")
async def check_sessions():
    """Read every OPEN window for who it is signed in as, and every closed
    one against the bucket: a closed profile cannot be read without opening
    it, so what counts is whether its session is on MinIO."""
    for a in store.accounts():
        if browser.is_open(a["id"]):
            await browser.record(a["id"], await browser.read(a["id"]))
    try:
        await reconcile_sessions()
    except minio.MinioError as exc:
        return {"checked": len(store.accounts()),
                "logged_in": sum(1 for a in store.accounts() if store.session(a["id"]).get("logged_in")),
                "warning": f"MinIO: {exc}"}
    live = sum(1 for a in store.accounts() if store.session(a["id"]).get("logged_in"))
    return {"checked": len(store.accounts()), "logged_in": live}


async def open_window(account_id: str) -> tasks.Task:
    """Open the account's window and start watching it. The watcher records
    the sign-in when it lands and types a stored app password if the profile
    did not come back already signed in - see Browser.watch."""
    account_or_404(account_id)
    await browser.open(account_id)
    return tasks.start("signing in", lambda t: browser.watch(account_id, t))


@app.post("/api/accounts/login")
async def login_many(body: dict[str, Any]):
    ids = [str(i) for i in body.get("ids", [])]

    async def run(task: tasks.Task) -> None:
        # One at a time with a gap: a burst of simultaneous logins from one
        # address is the clearest signal that a set of accounts belongs together.
        for n, account_id in enumerate(ids):
            task.detail = f"account {account_id}"
            await open_window(account_id)
            task.progress = (n + 1) / max(len(ids), 1)
            if n + 1 < len(ids):
                await asyncio.sleep(3)
        task.finish({"opened": ids})

    return {"task": tasks.start("logging in", run).id}


@app.delete("/api/accounts/{account_id}")
async def remove_account(account_id: str):
    account_or_404(account_id)
    await browser.forget(account_id)
    store.remove(account_id)
    return {"ok": True}


@app.get("/api/accounts/{account_id}/secret")
async def secret(account_id: str):
    return {"password": account_or_404(account_id).get("password", "")}


@app.post("/api/accounts/{account_id}/session")
@app.post("/api/accounts/{account_id}/open")
async def open_session(account_id: str):
    """Open the window now; the saving happens whenever the sign-in finishes,
    which is a person's business and minutes away - so it returns a task the
    console polls, and the card redraws when that task ends."""
    task = await open_window(account_id)
    return {"task": task.id, "url": config.BSKY_URL}


@app.post("/api/accounts/{account_id}/logout")
async def logout(account_id: str):
    account_or_404(account_id)
    await browser.forget(account_id)
    return {"ok": True}


# ── Campaign: a message to each picked recipient ─────────────────────────────

@app.post("/api/campaign/plan")
async def campaign_plan(body: dict[str, Any]):
    """The send dealt out, nothing sent: what the live panel shows first. A
    run in progress owns the panel and hands back its real rows instead."""
    if campaign.CAMP["state"] in ("running", "paused"):
        return campaign.state()
    lanes = campaign.plan(body)
    total = sum(1 for l in lanes for r in l["rows"] if not r.get("kind"))
    breaks = sum(1 for l in lanes for r in l["rows"] if r.get("kind") == "break")
    return {"state": "planned", "lanes": [{k: v for k, v in l.items() if k != "login"} for l in lanes],
            "note": f"{total} recipients dealt across {len(lanes)} account{'s' if len(lanes) != 1 else ''}"
                    + (f", {breaks} break{'s' if breaks != 1 else ''} planned" if breaks else "")
                    + " - nothing sent yet."}


@app.post("/api/campaign/start")
async def campaign_start(body: dict[str, Any]):
    return campaign.start(body)


@app.get("/api/campaign/status")
async def campaign_status():
    return campaign.state()


@app.post("/api/campaign/pause")
async def campaign_pause():
    return campaign.pause()


@app.post("/api/campaign/resume")
async def campaign_resume():
    return campaign.resume()


@app.post("/api/campaign/stop")
async def campaign_stop():
    return campaign.stop()


@app.get("/api/campaign/sent")
async def campaign_sent():
    """How many times each handle has been messaged, off the record of sends."""
    return {"sent": campaign.sent_counts()}


# ── Actions: Bluesky's rail, one press at a time ─────────────────────────────

@app.get("/api/actions/messenger")
async def actions_list():
    return {"actions": actions.actions(), "windows": actions.windows()}


@app.post("/api/actions/messenger/click")
async def actions_click(body: dict[str, Any]):
    """Press one rail item in the open window (the picked one, else the
    first), then scroll the page that opened."""
    return await actions.press(str(body.get("action") or ""), body.get("session"),
                               text=str(body.get("text") or ""), draft=str(body.get("draft") or ""),
                               image=str(body.get("image") or ""), mode=str(body.get("mode") or "both"),
                               dry_run=bool(body.get("dry_run")))


# ── Feed Campaign: the Home feed, every post liked and commented on ──────────

@app.get("/api/fb/status")
async def fb_status():
    """The run's state with the open windows and how many stored messages
    the Database choice can draw from."""
    return feed.frame(with_windows=True)


@app.post("/api/fb/start")
async def fb_start(body: dict[str, Any]):
    return feed.start(body)


@app.post("/api/fb/stop")
async def fb_stop():
    return feed.stop()


# ── Scraping: the Home feed, every new author hovered ────────────────────────

@app.get("/api/scrape/accounts")
async def scrape_accounts():
    """The windows a run can walk - the chips on the Scraping panel."""
    return {"accounts": scrape.open_accounts()}


@app.post("/api/scrape/sweep")
async def scrape_sweep(body: dict[str, Any]):
    """Start the walk on every ticked window. Returns a task the panel polls;
    each frame carries the rows found so far and a lane per window."""
    task = scrape.start(body)
    return {"task": task.id, **scrape.frame()}


@app.get("/api/scrape/status")
async def scrape_status():
    return scrape.frame()


@app.post("/api/scrape/stop")
async def scrape_stop():
    return scrape.stop()


@app.post("/api/scrape/reset")
async def scrape_reset():
    scrape.reset()
    return {"ok": True}


@app.get("/api/scrape/rows")
async def scrape_rows():
    """Everything ever collected - the record on disk plus the live run - for
    the Data panel. Not trimmed the way a frame is."""
    return scrape.all_rows()


@app.post("/api/scrape/clear")
async def scrape_clear(body: dict[str, Any] | None = None):
    """Every scraped handle, gone - disk, the live run, the handles file on
    MinIO, and every page's mirrored copy on its next load."""
    return await asyncio.to_thread(scrape.clear_all, (body or {}).get("minio", True))


@app.post("/api/scrape/minio/push")
async def scrape_minio_push(body: dict[str, Any]):
    """The collected rows (all, or the handles named) into the handles file
    on MinIO. Reports how many were new against the file."""
    wanted = {str(h).lstrip("@").lower() for h in (body.get("handles") or []) if str(h).strip()}
    rows = scrape.all_rows()["rows"]
    if wanted:
        have = {r["handle"].lower(): r for r in rows}
        rows = [have.get(h) or {"handle": h} for h in wanted]
    if not rows:
        raise ValueError("Nothing to send.")
    return await asyncio.to_thread(scrape.handles_push, rows)


@app.post("/api/scrape/minio/import")
async def scrape_minio_import():
    """The handles file, as rows, for the store to merge in."""
    rows, bucket, name = await asyncio.to_thread(scrape.handles_read)
    return {"rows": rows, "bucket": bucket, "object": name, "total": len(rows)}


# ── MinIO: sessions status, the insta messages and media ─────────────────────

@app.get("/api/minio/status")
async def minio_status():
    return await asyncio.to_thread(minio.status)


@app.get("/api/minio/messages")
async def minio_messages():
    """The insta drafts file, as drafts. Read-only: it is edited where it was
    written, and the console's own copy is the one a campaign sends from."""
    return await asyncio.to_thread(minio.messages)


@app.get("/api/minio/media")
async def minio_media():
    """Every picture in the insta media bucket, listed live - a file added to
    the bucket is in the Campaign panel on its next load."""
    return await asyncio.to_thread(minio.media)


@app.get("/api/minio/object")
async def minio_object(name: str = ""):
    try:
        data, ctype = await asyncio.to_thread(minio.media_object, name)
    except minio.MinioError as exc:
        raise HTTPException(404, str(exc))
    return Response(content=data, media_type=ctype,
                    headers={"Cache-Control": "private, max-age=300"})


@app.get("/api/minio/sessions")
async def minio_sessions():
    """What the sessions bucket holds, by account id."""
    return {"bucket": config.MINIO_SESSIONS_BUCKET,
            "sessions": await asyncio.to_thread(minio.sessions_saved)}


# ── Tasks and status ─────────────────────────────────────────────────────────

@app.get("/api/tasks/{task_id}")
async def task_status(task_id: str):
    task = tasks.get(task_id)
    if task is None:
        raise HTTPException(404, "That run is no longer on the server.")
    return task.public()


@app.get("/api/automation/status")
async def automation_status():
    open_ids = browser.open_ids()
    return {
        "browser": {"open": bool(open_ids), "count": len(open_ids), "pages": browser.page_count()},
        "run": {"state": "running" if tasks.any_running() else "idle"},
    }


@app.post("/api/app/reset")
async def reset():
    stopped = tasks.stop_all()
    for account_id in browser.open_ids():
        await browser.close(account_id)
    return {"ok": True, "stopped": stopped, "waited_on": len(stopped), "still_going": []}


# ── The page ─────────────────────────────────────────────────────────────────

@app.get("/")
async def index():
    return FileResponse(config.FRONTEND_DIR / "index.html")


app.mount("/", StaticFiles(directory=str(config.FRONTEND_DIR)), name="frontend")
