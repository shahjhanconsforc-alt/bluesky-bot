# bluesky-bot

An operator console for running Bluesky accounts: scraping, campaigns, group
posting and per-account actions, styled after bsky.app.

## Run it

```
pip install -r backend/requirements.txt
python -m playwright install chromium      # once; Google Chrome is used when installed

run.bat          (Windows: double-click, or `run` in a terminal here)
python run.py    (any platform)
```

The console opens at http://127.0.0.1:4300. Host, port and browser settings
come from `backend/.env` when that file exists (copy `backend/.env.example`
to make one).

## What is real today

**Accounts and browser windows.** `backend/app.py` owns the account list and
each account's session. On the Accounts panel, *Sign in & save* opens a real
Chrome window on bsky.app in a profile that belongs to that account, fills in
the handle and app password when one is stored, and watches the window until
the sign-in lands; the card then shows who it is signed in as. *Open* brings
a saved profile back already signed in. *Log out* (and *Remove*) deletes the
session.

**Sessions live on MinIO, not in the project.** The moment a sign-in lands
the account's Chrome profile is zipped to the sessions bucket as
`session-acct-<id>.zip` (plus a small `.json` beside it), and again whenever
its window closes. Opening a card pulls that zip into a working directory
under `%LOCALAPPDATA%\bluesky-bot\profiles` first. *Log out* removes every
file of that session from the bucket and the working copy. On start, cards
are read against the bucket: a session deleted there is gone here too. The
account list (handles, passwords) stays in `backend/data/accounts.json`,
gitignored. Settings - MinIO address, login and bucket names - are in
`backend/.env`.

**Scraping walks the Home feed for real.** With a window open, *Scrape Home
feed* scrolls bsky.app's Home in every ticked window and, for every post by
an author not yet collected, hovers the author's name. Bluesky pops its
profile card on that hover and asks its server for the profile; that reply is
read off the window's traffic - handle, name, bio, followers, following,
posts and whether the account takes incoming chats - with the card's own text
kept beside it. Rows land in the Scraping table as they are found, in the
Data panel (store and the "Home feed" roster), in `backend/data/scraped.jsonl`,
and in the handles file on MinIO (`MINIO_BUCKET` / `bluesky_handles.txt`, a
tab table: handle, name, bio, followers, following, posts, did, by,
scraped_at), written every 25 rows and when the run stops. The Data panel's
*Send to MinIO* and *Load from MinIO* use the same file. A run has no end of
its own: press Stop. Chats and Groups scraping are still simulated.

**Actions press Bluesky's own rail.** One button per item down the left of
bsky.app (Switch accounts, Home, Explore, Notifications, Chat, Feeds, Lists,
Saved, Profile, Settings, Compose new post), each clicked in the open window
and, for a page, read by scrolling it in small wheel ticks. *Compose new
post* is a post: one enabled Campaign message off the insta messages file,
one picture off the media bucket, typed and attached through the composer's
own Gallery button, and published; the window's `createRecord` reply is what
confirms it. The press body takes `draft` (a message by name), `text` (as
given), `image` (a picture by name) and `dry_run` (fill, then discard).

**Campaign messages and media come from MinIO** - the Instagram bot's
buckets, read as they are: the drafts table in `insta-bot-messages /
sms_drafts.txt` and every picture in `insta-bot-media`. Both are listed live,
so a file added to the bucket is in the panel on its next load. The drafts
are read-only here; the file is edited where it was written.

**Everything else** - scraping, campaigns, group posting, actions, settings -
is still answered in the browser by `frontend/mock.js`, which hands the
account and session paths to the server and mirrors its answers so the other
panels see the real windows. With no server answering (the page served by a
plain static server) those paths fall back to the simulation too.
