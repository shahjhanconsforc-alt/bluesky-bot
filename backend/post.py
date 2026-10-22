"""A post: one Campaign message and one picture, through Bluesky's composer.

What the Compose action does in the open window: opens the composer off the
rail, types one of the Campaign messages (a draft picked at random from the
enabled ones in the insta messages file on MinIO, unless the press names
one), attaches one picture from the media bucket through the composer's own
Gallery button (the file chooser it opens is answered with the picture), and
presses Post. The post is confirmed by the window's traffic: Bluesky writes
it with `com.atproto.repo.createRecord`, and that reply names the record.

Found by Bluesky's own test ids, which have been stable across its releases:
composerTextInput, openGalleryBtn (label "Gallery"), composerPublishBtn.
"""

from __future__ import annotations

import asyncio
import random
import tempfile
from pathlib import Path
from typing import Any

from . import minio_store as minio

# The composer's parts, each by every name Bluesky has given it. The text box
# is a TipTap/ProseMirror editor (`div.tiptap.ProseMirror[contenteditable]`)
# that carries no test id of its own; the id sits on a wrapper in some builds
# and nowhere in others, so the editor is what is looked for.
TEXT_INPUT = (
    '.tiptap.ProseMirror[contenteditable="true"]',
    '[data-testid="composerTextInput"] [contenteditable="true"]',
    '[data-testid="composerTextInput"]',
    '[role="dialog"] [contenteditable="true"]',
)
GALLERY_BTN = (
    '[data-testid="openGalleryBtn"]', '[aria-label="Gallery"]',
    'button[aria-label*="photo" i]', 'button[aria-label*="image" i]',
    '[role="dialog"] input[type="file"][accept*="image"]',
)
PUBLISH_BTN = (
    '[data-testid="composerPublishBtn"]', 'button[aria-label="Publish post"]',
    '[role="dialog"] button[aria-label="Post"]', '[role="dialog"] [role="button"][aria-label="Post"]',
    '[role="dialog"] button:has-text("Post")',
)
CANCEL_BTN = (
    '[data-testid="composerDiscardButton"]', '[data-testid="composerCancelButton"]',
    'button[aria-label="Cancel"]', '[role="dialog"] [aria-label="Cancel"]',
    '[role="dialog"] [aria-label="Discard"]',
)
# Any picture the composer shows once the file is in: the preview.
PREVIEW_JS = "() => !!document.querySelector('[role=dialog] img, [data-testid^=\"composer\"] img, [data-testid=\"composerImagePreview\"], [aria-label=\"Remove image\"]')"

# The picture pasted into the editor: a paste event carrying the file, which
# is what the composer gets when a copied image is pasted with Ctrl+V. The
# bytes travel as base64 and become a File inside the page.
PASTE_JS = """async ([b64, name, type]) => {
  const editor = document.querySelector('.tiptap.ProseMirror[contenteditable="true"], [role="dialog"] [contenteditable="true"]');
  if (!editor) return 'no editor';
  const blob = await (await fetch('data:' + type + ';base64,' + b64)).blob();
  const file = new File([blob], name, { type });
  const dt = new DataTransfer(); dt.items.add(file);
  editor.focus();
  const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
  editor.dispatchEvent(ev);
  return 'pasted';
}"""
CREATE_CALL = "com.atproto.repo.createRecord"
MAX_CHARS = 300          # Bluesky's limit; a longer draft is cut at a word


def pick_draft(name: str = "") -> dict[str, Any]:
    """One enabled draft off the Campaign messages, by name or at random."""
    drafts = [d for d in minio.messages()["drafts"] if d.get("text")]
    if name:
        wanted = next((d for d in drafts if d["name"] == name), None)
        if wanted is None:
            raise ValueError(f"No draft called '{name}' in the messages file.")
        return wanted
    enabled = [d for d in drafts if d.get("enabled", True)] or drafts
    if not enabled:
        raise ValueError("No messages to post - the Campaign messages file is empty.")
    return random.choice(enabled)


def pick_image(name: str = "") -> dict[str, Any]:
    """One picture off the media bucket, by name or at random."""
    pictures = minio.media()["media"]
    if name:
        wanted = next((m for m in pictures if m["name"] == name or m["object"] == name), None)
        if wanted is None:
            raise ValueError(f"No picture called '{name}' in the media bucket.")
        return wanted
    if not pictures:
        raise ValueError("No pictures to attach - the media bucket is empty.")
    return random.choice(pictures)


def fetch_image(picture: dict[str, Any]) -> Path:
    data, _ = minio.media_object(picture["object"])
    out = Path(tempfile.gettempdir()) / "bluesky-bot" / "post" / Path(picture["name"]).name
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(data)
    return out


def fit(text: str) -> str:
    text = text.strip()
    if len(text) <= MAX_CHARS:
        return text
    cut = text[:MAX_CHARS].rsplit(" ", 1)[0]
    return (cut or text[:MAX_CHARS]).rstrip() + "…"


async def find(page: Any, candidates: tuple[str, ...], timeout: float = 8.0):
    """The first of these that is on the page and visible, waited for."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        for sel in candidates:
            loc = page.locator(sel).first
            try:
                if await loc.count() and await loc.is_visible():
                    return loc
            except Exception:  # noqa: BLE001 - mid-render
                continue
        if loop.time() >= deadline:
            return None
        await asyncio.sleep(0.2)


async def type_like_a_person(page: Any, text: str) -> None:
    """Keystrokes with uneven gaps, a longer one at a space or line end."""
    for ch in text:
        await page.keyboard.type(ch)
        if ch in "\n":
            await asyncio.sleep(random.uniform(0.15, 0.35))
        elif ch in " .,!?":
            await asyncio.sleep(random.uniform(0.04, 0.14))
        else:
            await asyncio.sleep(random.uniform(0.015, 0.06))


async def paste_image(page: Any, path: Path, picture: dict[str, Any]) -> bool:
    """The picture into the composer by paste. True once the preview shows."""
    import base64
    import mimetypes
    b64 = base64.b64encode(path.read_bytes()).decode("ascii")
    ctype = mimetypes.guess_type(picture["name"])[0] or "image/png"
    said = await page.evaluate(PASTE_JS, [b64, Path(picture["name"]).name, ctype])
    if said != "pasted":
        return False
    try:
        await page.wait_for_function(PREVIEW_JS, timeout=8000)
        return True
    except Exception:  # noqa: BLE001 - the editor took no file from the paste
        return False


async def gallery_image(page: Any, path: Path) -> None:
    """The picture through the composer's own Gallery button: the file
    chooser it opens is answered with the file. A bare file input (some
    builds) takes the file directly."""
    gallery = await find(page, GALLERY_BTN, timeout=5.0)
    if gallery is None:
        raise ValueError("No Gallery button in the composer to attach the picture with.")
    if (await gallery.evaluate("e => e.tagName.toLowerCase()")) == "input":
        await gallery.set_input_files(str(path))
    else:
        async with page.expect_file_chooser(timeout=8000) as chooser_info:
            await gallery.click()
        chooser = await chooser_info.value
        await chooser.set_files(str(path))
    try:
        await page.wait_for_function(PREVIEW_JS, timeout=10000)
    except Exception:  # noqa: BLE001 - the preview's shape is Bluesky's; the upload still went
        pass


async def compose(page: Any, open_composer, text: str = "", draft_name: str = "",
                  image: str = "", mode: str = "both", dry_run: bool = False) -> dict[str, Any]:
    """Open the composer with `open_composer()` (the rail press), fill it and
    post. `mode` is what goes in: `text` (a Campaign message), `photo` (a
    picture from Media) or `both`. `draft_name` picks a message by name,
    `text` posts that text as given; neither means one enabled draft at
    random. With dry_run the composer is filled and then discarded."""
    mode = mode if mode in ("text", "photo", "both") else "both"
    with_text, with_photo = mode != "photo", mode != "text"
    draft = ({"name": "given", "text": text} if text else pick_draft(draft_name)) if with_text \
        else {"name": "", "text": ""}
    picture = pick_image(image) if with_photo else {"name": "", "object": ""}
    body = fit(draft["text"]) if with_text else ""
    path = await asyncio.to_thread(fetch_image, picture) if with_photo else None

    created: list[dict[str, Any]] = []

    async def on_response(response: Any) -> None:
        if CREATE_CALL in response.url and response.ok:
            try:
                created.append(await response.json())
            except Exception:  # noqa: BLE001
                pass

    listener = lambda r: asyncio.ensure_future(on_response(r))  # noqa: E731
    page.context.on("response", listener)
    try:
        await open_composer()
        box = await find(page, TEXT_INPUT)
        if box is None:
            raise ValueError("The composer did not open - no text box appeared in the window.")
        await asyncio.sleep(random.uniform(0.4, 0.9))
        await box.click()
        await asyncio.sleep(random.uniform(0.2, 0.4))
        if with_text:
            await type_like_a_person(page, body)
            await asyncio.sleep(random.uniform(0.5, 1.2))
            # Did it land? ProseMirror takes keystrokes, but a box that lost
            # focus (a tooltip, a late re-render) takes none: then the text is
            # inserted as one paste-like edit, which the editor also accepts.
            typed = (await box.inner_text()).strip()
            if body[:20].strip() not in typed:
                await box.click()
                await page.keyboard.press("Control+A")
                await page.keyboard.insert_text(body)
                await asyncio.sleep(0.5)
                typed = (await box.inner_text()).strip()
                if body[:20].strip() not in typed:
                    raise ValueError("The message could not be written into the composer.")

        attached = ""
        if with_photo:
            # Copied from Media and pasted into the composer, the way a person
            # drops a picture in with Ctrl+V; the Gallery button when the
            # editor takes nothing from the paste.
            if await paste_image(page, path, picture):
                attached = "pasted"
            else:
                await gallery_image(page, path)
                attached = "gallery"
            await asyncio.sleep(random.uniform(1.0, 2.0))

        if dry_run:
            cancel = await find(page, CANCEL_BTN, timeout=2.0)
            try:
                await cancel.click(timeout=5000)
            except Exception:  # noqa: BLE001 - no such button, or out of reach: Escape does it
                await page.keyboard.press("Escape")
            await asyncio.sleep(0.5)
            return {"result": "filled, not posted (dry run)", "draft": draft["name"],
                    "text": body, "image": picture["name"], "attached": attached, "mode": mode,
                    "posted": False}

        publish = await find(page, PUBLISH_BTN, timeout=5.0)
        if publish is None:
            raise ValueError("No Post button in the composer.")
        for _ in range(40):                                   # the upload has to finish first
            if await publish.is_enabled():
                break
            await asyncio.sleep(0.25)
        await publish.click(timeout=10000)
        # The write is what says it posted; the composer closing is only the UI.
        for _ in range(60):
            if created:
                break
            await asyncio.sleep(0.25)
        if not created:
            # No write seen: the composer closing is the only other sign.
            still = await find(page, TEXT_INPUT, timeout=3.0)
            if still is not None:
                raise ValueError("Post was pressed but Bluesky did not confirm the post.")
        uri = (created[0].get("uri") or "") if created else ""
        return {"result": "posted", "draft": draft["name"], "text": body,
                "image": picture["name"], "attached": attached, "mode": mode,
                "posted": True, "uri": uri}
    finally:
        try:
            page.context.remove_listener("response", listener)
        except Exception:  # noqa: BLE001
            pass
        if path is not None:
            try:
                path.unlink()
            except OSError:
                pass
