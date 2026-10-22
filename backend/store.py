"""The account store: one JSON file under data/.

Accounts, their passwords and what is known about each one's session, in one
place. The file is small - a handful of accounts - so it is rewritten whole on
every change rather than kept open. Under data/ and therefore gitignored: the
passwords are here, and the profile directories beside it ARE the sessions.
"""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from typing import Any

from . import config

NO_SESSION: dict[str, Any] = {"logged_in": False, "active": False, "detail": "no session"}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Store:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.data: dict[str, Any] = {"next": 1, "accounts": [], "sessions": {}}
        self.load()

    # ── file ───────────────────────────────────────────────────────────────

    def load(self) -> None:
        if config.STORE_FILE.is_file():
            try:
                self.data = json.loads(config.STORE_FILE.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                pass
        self.data.setdefault("next", 1)
        self.data.setdefault("accounts", [])
        self.data.setdefault("sessions", {})
        # A window never survives a restart, so nothing is active on load.
        for s in self.data["sessions"].values():
            s["active"] = False

    def save(self) -> None:
        config.DATA_DIR.mkdir(parents=True, exist_ok=True)
        tmp = config.STORE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, indent=2), encoding="utf-8")
        tmp.replace(config.STORE_FILE)

    # ── accounts ───────────────────────────────────────────────────────────

    def accounts(self) -> list[dict[str, Any]]:
        return list(self.data["accounts"])

    def public(self, a: dict[str, Any]) -> dict[str, Any]:
        """The list shape: no password, only whether there is one."""
        return {"id": a["id"], "label": a.get("label", ""), "login": a["login"],
                "email": a.get("email", ""), "has_password": bool(a.get("password"))}

    def get(self, account_id: str) -> dict[str, Any] | None:
        return next((a for a in self.data["accounts"] if a["id"] == str(account_id)), None)

    def add(self, login: str, email: str = "", password: str = "", label: str = "") -> dict[str, Any]:
        login = login.strip().lstrip("@")
        if not login:
            raise ValueError("A handle is required.")
        if any(a["login"].lower() == login.lower() for a in self.data["accounts"]):
            raise ValueError(f"@{login} is already on the list.")
        with self._lock:
            account_id = str(self.data["next"])
            self.data["next"] += 1
            account = {"id": account_id, "login": login, "email": email.strip(),
                       "password": password, "label": label}
            self.data["accounts"].append(account)
            self.data["sessions"][account_id] = dict(NO_SESSION)
            self.save()
        return account

    def remove(self, account_id: str) -> None:
        with self._lock:
            self.data["accounts"] = [a for a in self.data["accounts"] if a["id"] != str(account_id)]
            self.data["sessions"].pop(str(account_id), None)
            self.save()

    # ── sessions ───────────────────────────────────────────────────────────

    def session(self, account_id: str) -> dict[str, Any]:
        return self.data["sessions"].setdefault(str(account_id), dict(NO_SESSION))

    def set_session(self, account_id: str, **fields: Any) -> dict[str, Any]:
        with self._lock:
            s = self.session(account_id)
            s.update(fields)
            self.save()
        return s

    def clear_session(self, account_id: str) -> None:
        with self._lock:
            self.data["sessions"][str(account_id)] = dict(NO_SESSION)
            self.save()

    def session_rows(self) -> list[dict[str, Any]]:
        """What the Accounts panel draws: one row per account, session fields
        flattened in. Email rides along so the mock can mirror the account list
        off this one response."""
        return [{"id": a["id"], "login": a["login"], "label": a.get("label", ""),
                 "email": a.get("email", ""), **self.session(a["id"])}
                for a in self.data["accounts"]]


store = Store()
