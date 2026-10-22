"""Long runs behind short requests.

A POST starts something that takes minutes - a sign-in is a person typing - and
returns an id; the console polls GET /api/tasks/{id} until the state leaves
`running`. Ids carry the `srv-` prefix so the frontend's stand-in can tell a
server task from one of its own and route the poll accordingly.
"""

from __future__ import annotations

import asyncio
import secrets
from typing import Any, Awaitable, Callable


class Task:
    def __init__(self, title: str) -> None:
        self.id = "srv-" + secrets.token_hex(4)
        self.title = title
        self.state = "running"          # running | done | failed | stopped
        self.progress = 0.0
        self.detail = ""
        self.result: Any = None
        self._job: asyncio.Task | None = None

    def public(self) -> dict[str, Any]:
        return {"id": self.id, "title": self.title, "state": self.state,
                "progress": self.progress, "detail": self.detail, "result": self.result}

    def finish(self, result: Any = None, detail: str = "") -> None:
        self.state = "done"
        self.progress = 1.0
        self.result = result
        if detail:
            self.detail = detail

    def fail(self, detail: str) -> None:
        self.state = "failed"
        self.detail = detail

    def stop(self) -> None:
        if self.state == "running":
            self.state = "stopped"
        if self._job and not self._job.done():
            self._job.cancel()


_tasks: dict[str, Task] = {}


def start(title: str, run: Callable[[Task], Awaitable[None]]) -> Task:
    """Run `run(task)` in the background. The coroutine owns the task's state;
    an exception it lets out marks the task failed with its message."""
    task = Task(title)
    _tasks[task.id] = task

    async def wrapped() -> None:
        try:
            await run(task)
            if task.state == "running":
                task.finish()
        except asyncio.CancelledError:
            if task.state == "running":
                task.state = "stopped"
        except Exception as exc:  # noqa: BLE001 - the task reports, not the server
            task.fail(str(exc) or exc.__class__.__name__)

    task._job = asyncio.get_running_loop().create_task(wrapped())
    return task


def get(task_id: str) -> Task | None:
    return _tasks.get(task_id)


def any_running() -> bool:
    return any(t.state == "running" for t in _tasks.values())


def stop_all() -> list[str]:
    stopped = []
    for t in _tasks.values():
        if t.state == "running":
            t.stop()
            stopped.append(t.title)
    return stopped
