/* bluesky-bot UI — vanilla, no build step.
 *
 * One file on purpose: the whole app is five panels over a REST API, and a
 * bundler would add more moving parts than it removes.
 *
 * The shape is meetup-bot's, deliberately. What changed is the domain under it:
 * a target's follower list where meetup-bot had an event's attendee list, a DM
 * where it had a message, and a "collect" mode — followers, likers, list members
 * — where it had nothing, because an event has exactly one attendee list and an
 * X account has half a dozen pools hanging off it.
 *
 * There is NO backend in this repo yet. `mock.js` stands in for one: it answers
 * the same paths with the same shapes, out of localStorage. Everything below is
 * written against the HTTP contract, not against the mock — see `api()`.
 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* This file is one script with wiring at the top level all the way down it, so
 * an error part-way through does not fail loudly - it just stops, and every
 * listener BELOW the error is silently never attached. The console then renders
 * perfectly and half its buttons do nothing, which is the hardest possible
 * thing to report: nothing is on screen to report.
 *
 * The usual cause is a stale script over fresh markup - the page is served
 * `no-store` and the assets used not to be - so the message says so and offers
 * the reload that fixes it. First thing in the file, because it can only catch
 * what throws after it.
 *
 * Deliberately built out of nothing: no toast(), no helper, no stylesheet class.
 * Everything this could lean on is defined further down the file, which is
 * exactly the part that did not run. */
window.addEventListener('error', event => {
  // Only while the file is still running. Past the last line it has all been
  // wired, and an error after that is an ordinary runtime one - which the app
  // already reports as a toast, and which "did not finish loading" would
  // describe wrongly.
  if (window.__consoleReady) return;
  if (document.getElementById('boot-broke')) return;   // one banner, not twenty
  const bar = document.createElement('div');
  bar.id = 'boot-broke';
  bar.setAttribute('role', 'alert');
  bar.style.cssText = 'position:fixed;inset:0 0 auto 0;z-index:9999;padding:10px 16px;'
    + 'background:#f4515f;color:#fff;font:13px/1.5 ui-sans-serif,system-ui,sans-serif;'
    + 'display:flex;align-items:center;gap:12px';
  const said = document.createElement('span');
  said.style.flex = '1';
  said.textContent = 'The console did not finish loading, so some buttons will '
    + 'do nothing. This is usually a cached script over a newer page. '
    + `(${event.message || 'script error'})`;
  const again = document.createElement('button');
  again.textContent = 'Reload';
  again.style.cssText = 'padding:4px 12px;border-radius:6px;border:1px solid #fff;'
    + 'background:transparent;color:#fff;cursor:pointer;font:inherit';
  // `reload(true)` has been a no-op for years; the cache-buster is what actually
  // gets past a script the browser is holding on to.
  again.addEventListener('click', () => {
    const url = new URL(location.href);
    url.searchParams.set('reload', Date.now());
    location.replace(url);
  });
  bar.append(said, again);
  (document.body || document.documentElement).prepend(bar);
});

/* Every read and write in this app goes through here.
 *
 * The one concession to there being no server: if mock.js has installed itself,
 * calls are handed to it instead of to fetch. Same paths, same methods, same
 * response shapes — so wiring a real backend is deleting one <script> tag, not
 * rewriting the calls. */
async function api(path, options = {}) {
  if (window.XBOT_BACKEND) return window.XBOT_BACKEND.handle(path, options);

  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { detail: text }; }
  if (!res.ok) throw new Error(data.detail || `${res.status} ${res.statusText}`);
  return data;
}

/* ── Pop-up panels ───────────────────────────────────────────── */

/* Click outside a modal <dialog> and it closes. Applied to EVERY dialog on the
 * page rather than wired per panel, so a new one gets the behaviour by existing.
 * (Escape already closes a native dialog — this is the other half of what people
 * expect from an overlay.)
 *
 * A modal dialog's backdrop belongs to the dialog element itself, so a click on
 * it arrives with `target === dialog`. That alone is not enough to act on: a
 * click on the dialog's own PADDING reports the same target, and closing on
 * those would make the panel disappear when somebody clicks a millimetre off a
 * button. The rect test is what separates the two. */
function outside(dialog, event) {
  if (event.target !== dialog) return false;       // something inside it
  const box = dialog.getBoundingClientRect();
  return event.clientX < box.left || event.clientX > box.right
      || event.clientY < box.top || event.clientY > box.bottom;
}

function closeOnClickOutside(dialog) {
  // Where the press STARTED matters as much as where it ended. Selecting text
  // in the live table and releasing past the edge is one gesture that ends on
  // the backdrop, and closing the panel out from under it would throw away both
  // the selection and the operator's place in a long list.
  let began = false;
  dialog.addEventListener('mousedown', e => { began = outside(dialog, e); });
  dialog.addEventListener('click', e => {
    if (began && outside(dialog, e)) dialog.close();
    began = false;
  });
}

$$('dialog').forEach(closeOnClickOutside);

/* ── Activity rows ───────────────────────────────────────────── */

function feedRow({ at, level = 'info', source = 'ui', message = '', status = null }) {
  const li = document.createElement('li');
  li.className = level;

  // The middleware logs "GET /api/x → 503". Split the code off so it can sit in
  // its own column: a wall of 200s and a wall of 503s should look different
  // from across the room, which they don't when the code is buried in prose.
  const match = String(message).match(/^(.*?)\s*→\s*(\d{3})\s*$/);
  const text = match ? match[1] : message;
  const code = status ?? (match ? Number(match[2]) : null);

  const time = at ? new Date(at) : new Date();
  li.innerHTML = `
    <time>${time.toLocaleTimeString()}</time>
    <span class="src" data-src="${escapeHtml(source)}">${escapeHtml(source)}</span>
    <span class="msg">${escapeHtml(text)}</span>
    ${code ? `<span class="code c${String(code)[0]}">${code}</span>` : '<span></span>'}`;
  return li;
}

function toast(message, level = 'info') {
  // Errors go into the same feed as everything else rather than an alert box:
  // a modal interrupts a run the operator is watching, and the feed is already
  // where they are looking.
  $('#feed').prepend(feedRow({ level, source: 'ui', message }));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function truncate(text, n = 90) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > n ? clean.slice(0, n - 1) + '…' : clean;
}

/* A follower count is read at a glance, never added up — so 48,200 is noise and
 * 48.2K is the answer. */
function compact(n) {
  // null is what the server sends for "not read yet", and Number(null) is 0 —
  // a real count, in the column the roster is filtered on. Caught before the
  // conversion, because after it there is nothing left to tell the two apart.
  if (n === null || n === undefined || n === '') return '—';
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K';
  return String(v);
}

/* A handle is stored bare and shown the way it is addressed. Doing it in one
 * place means the store, the tables and the composer can never disagree about
 * whether the sigil is part of the name.
 *
 * Bluesky has two kinds of handle and they do not look alike: a vanity
 * username, which reads as a name and takes the @, and a bare numeric id for
 * the accounts that never set one — "@100087..." reads as a mistake, so a
 * number is shown as a number. */
const at = h => {
  const raw = String(h || '').replace(/^@+/, '');
  return /^\d+$/.test(raw) ? raw : '@' + raw;
};

/* Where a handle's profile lives. Three tables link to it and they were three
 * copies of the same hardcoded URL, which is how one of them gets missed the
 * next time the platform moves.
 *
 * Bluesky addresses an account two ways and the store holds either: a vanity
 * username goes straight after the slash, and an account that never set one is
 * reachable only as profile.php?id=<number>. */
const profileHref = handle => {
  const raw = String(handle || '').replace(/^@+/, '');
  // bsky.app/profile/ takes either form: a handle or a did:plc identifier.
  return `https://bsky.app/profile/${encodeURIComponent(raw)}`;
};

/* Mark a button as the one currently working. Disabled AND accent-coloured: the
 * disable stops a second click, the colour says which of the greyed-out row is
 * actually running rather than merely unavailable. */
function setBusy(button, busy) {
  if (!button) return;
  button.classList.toggle('busy', busy);
  button.disabled = busy;
}

/* ── Tabs ────────────────────────────────────────────────────── */

$('#tabs').addEventListener('click', e => {
  const button = e.target.closest('button[data-panel]');
  if (!button) return;
  showPanel(button.dataset.panel);
});

/* Switching panels, from a tab click or from code — the scraping gate sends the
 * operator to Accounts, and that has to do exactly what pressing the tab does. */
function showPanel(name) {
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.panel === name));
  $$('.panel').forEach(p => p.classList.toggle('on', p.dataset.panel === name));
  refreshPanel(name);
}

function panelIsOn(name) {
  const panel = $(`.panel[data-panel="${name}"]`);
  return !!panel && panel.classList.contains('on');
}

function refreshPanel(name) {
  ({ accounts: loadAccounts, scraping: loadScraping, data: loadDataPanel,
     campaign: loadCampaign, settings: loadSettings, actions: loadActions,
     fb: loadFb, groups: loadGroups
   }[name] || (() => {}))();
}

/* ── Accounts ────────────────────────────────────────────────── */

async function loadAccounts() {
  const [{ accounts }, { sessions }] = await Promise.all([
    api('/api/accounts'), api('/api/accounts/sessions'),
  ]);
  const byId = Object.fromEntries(sessions.map(s => [s.id, s]));

  renderAccountCards(accounts, byId);

  // The campaign's own picker, from the one place accounts are loaded.
  // Scraping has none — it runs on whichever session is live.
  renderAccountPicker(accounts, byId);
}

/* One card per account, everything on it: handle, the email X sends its
 * challenges to, the password behind an eye, and the actions as icons. A blue
 * card is a stored session. */
function renderAccountCards(accounts, byId) {
  const wrap = $('#account-cards');
  if (!wrap) return;
  const live = accounts.filter(a => (byId[a.id] || {}).logged_in).length;
  $('#sessions-count').textContent =
    accounts.length ? `${live} of ${accounts.length} stored` : '';

  wrap.innerHTML = accounts.map(a => {
    const s = byId[a.id] || {};
    const stored = !!s.logged_in;
    return `
      <div class="acct-card ${stored ? 'stored' : ''}" data-id="${a.id}">
        <div class="ac-top">
          <span class="dot ${stored ? 'ok' : 'off'}"></span>
          ${s.active ? '<span class="ac-live">ACTIVE</span>' : ''}
          <div class="grow"></div>
          <!-- The one button. It opens this account's own Chrome profile and
               then watches it: whatever signs in there - Bluesky's own form, a
               two-factor code, a checkpoint cleared by hand - is recorded
               against this card the moment it lands, with no second button to
               remember. The session IS that profile directory, so a stored card
               reopening is Bluesky already signed in. -->
          <button class="tiny ${stored ? '' : 'primary'}" data-act="session" data-id="${a.id}"
                  title="${stored
                    ? 'Open the browser on this saved session — Bluesky already signed in'
                    : 'Open the browser and save whatever you sign in as'}">
            <svg class="ic" viewBox="0 0 24 24"><use href="#${stored ? 'i-external' : 'i-login'}"/></svg>${stored ? 'Open' : 'Sign in &amp; save'}</button>
          <button class="icon-btn tiny" data-act="logout" data-id="${a.id}"
                  title="Log out — clear the stored session">
            <svg class="ic" viewBox="0 0 24 24"><use href="#i-logout"/></svg></button>
          <button class="icon-btn tiny danger" data-act="delete" data-id="${a.id}"
                  title="Remove account">
            <svg class="ic" viewBox="0 0 24 24"><use href="#i-trash"/></svg></button>
        </div>
        <!-- The account name, here rather than up in the top row: sat beside the
             action buttons it was overrun by them and clipped to nothing. On its
             own line under the buttons it has the width of the card. -->
        <div class="ac-name">${escapeHtml(at(a.login))}</div>
        <!-- The address, said separately from the handle. X asks for it by name
             when it challenges a login, and an operator who cannot answer that
             prompt has an account that silently stops working. -->
        <div class="ac-sub">${a.email ? escapeHtml(a.email) : 'no email on file'}</div>
        <div class="ac-pass">
          <span class="ac-secret" data-id="${a.id}">••••••••</span>
          ${a.has_password ? `
          <button class="icon-btn tiny" data-act="reveal" data-id="${a.id}"
                  title="Show / hide password">
            <svg class="ic" viewBox="0 0 24 24"><use href="#i-eye"/></svg></button>` : ''}
        </div>
        <div class="ac-sub">${statusLine(s)}</div>
      </div>`;
  }).join('') || '<p class="muted">No accounts yet — add one above.</p>';
}

/* The one-line session state a card shows under the password. */
/* Re-read the sessions and redraw the account row, without refetching the
 * accounts themselves - those change when somebody adds one, which is not
 * something to poll for every five seconds. */
async function refreshCampSessions() {
  try {
    const { sessions } = await api('/api/accounts/sessions');
    renderAccountPicker(camp.accounts, Object.fromEntries(sessions.map(s => [s.id, s])));
  } catch { /* the server is restarting - the next tick will pick it up */ }
}

/* Past this, a stored session is old enough that the card stops implying it is
 * still good. Thirty days because that is what X's own session cookie is issued
 * for - the same number `expires_at` is built from - so a check older than one
 * cannot have seen the cookie the account is using now. */
const SESSION_STALE_DAYS = 30;

/* "2 hours ago", for the one timestamp on a card that is about OUR knowledge
 * rather than about X. Coarse on purpose: the difference between 40 and 41 days
 * is not a difference anybody acts on, and the only reading that matters is
 * "recent" against "long enough that I should re-check". */
function ago(iso) {
  if (!iso) return null;
  const then = new Date(iso);
  if (isNaN(then)) return null;
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  // Clock skew, or a store copied off a machine an hour ahead. "in 3 minutes"
  // on a card is worse than rounding it to now.
  if (mins < 1) return { text: 'just now', days: 0 };
  const days = Math.floor(mins / 1440);
  if (mins < 60) return { text: `${mins} min ago`, days };
  const hours = Math.round(mins / 60);
  if (hours < 24) return { text: `${hours} hour${hours === 1 ? '' : 's'} ago`, days };
  return { text: `${days} day${days === 1 ? '' : 's'} ago`, days };
}

function statusLine(s) {
  // A profile signed in as somebody other than the card's handle is the one
  // state worth interrupting for: a run against it sends from the wrong account
  // and never errors once, so it is said before anything else on the line.
  if (s && s.mismatch && s.as_handle) {
    return `<b class="bad">signed in as ${escapeHtml(at(s.as_handle))}</b> — not this account`;
  }
  if (s && s.logged_in) {
    const expiry = s.expires_at ? new Date(s.expires_at).toLocaleDateString() : '';
    const stored = `stored${expiry ? ' · until ' + escapeHtml(expiry) : ''}`;
    // Who it is signed in AS, not just that it is. Through Google there is no
    // password on this side at all, so without this the card can only say
    // "stored" about a session it cannot otherwise describe.
    const who = s.as_handle ? `as ${escapeHtml(at(s.as_handle))} · ` : '';
    const how = '';
    // A window that is open right now was just read, so its state is current by
    // definition and the age would only be noise. The age is for the other
    // case: a closed profile, whose "signed in" is only as good as the last
    // time anything looked - and nothing looks at a closed profile.
    if (s.active) return `${who}${how}active now · ${stored}`;
    const seen = ago(s.checked_at);
    if (!seen) return `${who}${how}${stored}`;
    const note = seen.days >= SESSION_STALE_DAYS
      ? `<b class="warn">checked ${seen.text} — may have expired</b>`
      : `checked ${seen.text}`;
    return `${who}${how}${stored} · ${note}`;
  }
  // An active profile with nothing stored yet. The server's own detail is the
  // better sentence here — it knows whether a watcher is sitting on this window
  // waiting for the sign-in, and closing the window is no longer what saves it.
  if (s && s.active) return escapeHtml(s.detail || 'active now — sign in, it saves itself');
  return escapeHtml((s && s.detail) || 'no session');
}

/* All account-card actions, off the icons' data-act. */
$('#account-cards').addEventListener('click', async e => {
  const iconBtn = e.target.closest('button[data-act]');
  const card = e.target.closest('.acct-card');
  if (!card || !iconBtn) return;
  const id = card.dataset.id;

  const act = iconBtn.dataset.act;
  if (act === 'reveal') return togglePassword(iconBtn, id);   // no busy/reload

  setBusy(iconBtn, true);
  try {
    if (act === 'session') {
      // The window opens now; the saving happens whenever the sign-in finishes,
      // which is minutes away and is a person's business, not this click's. So
      // the card is redrawn on the task rather than on the response.
      const { task } = await api(`/api/accounts/${id}/session`, { method: 'POST' });
      toast('Window open — sign in there. It saves itself the moment Bluesky is in.', 'ok');
      watchTask(task, { onDone: () => { loadAccounts(); refreshScrapeSessions(); refreshActGate(); } });
    } else if (act === 'logout') {
      await api(`/api/accounts/${id}/logout`, { method: 'POST' });
    } else if (act === 'delete') {
      if (!confirm('Remove this account and its stored session?')) return;
      await api(`/api/accounts/${id}`, { method: 'DELETE' });
    }
    loadAccounts();
    // Opening is the action the Scraping and Actions panels wait on, and logging
    // out or removing takes that window away again — so re-read both gates after
    // any of them rather than when the tab is next opened.
    refreshScrapeSessions();
    refreshActGate();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    setBusy(iconBtn, false);
  }
});

/* Reveal or re-hide one card's password. Fetched only when first shown — the
 * secret is kept off the list response and out of the DOM until asked for. */
async function togglePassword(button, id) {
  const field = $(`#account-cards .ac-secret[data-id="${id}"]`);
  if (!field) return;
  if (field.dataset.shown === '1') {
    field.textContent = '••••••••';
    field.dataset.shown = '';
    return;
  }
  try {
    const { password } = await api(`/api/accounts/${id}/secret`);
    field.textContent = password || '(none)';
    field.dataset.shown = '1';
  } catch (err) {
    toast(err.message, 'error');
  }
}

$('#acc-add').addEventListener('submit', async e => {
  e.preventDefault();
  const form = new FormData(e.target);
  try {
    await api('/api/accounts', { method: 'POST', body: Object.fromEntries(form) });
    e.target.reset();
    loadAccounts();
  } catch (err) { toast(err.message, 'error'); }
});

$('#acc-check').addEventListener('click', async e => {
  setBusy(e.currentTarget, true);
  try {
    const result = await api('/api/accounts/sessions/check', { method: 'POST' });
    toast(`${result.logged_in}/${result.checked} logged in`, 'ok');
    loadAccounts();
  } catch (err) {
    toast(err.message, 'error');
  } finally { setBusy(e.currentTarget, false); }
});

/* ── Who is busy where ───────────────────────────────────────── */

/* Which accounts a run is using right now, and which service has them: the
 * server's answer, polled, and read by every account picker. An account
 * Scraping is walking is greyed out on FB Campaign and Campaign, and the other
 * way round - and unticked, so a press cannot aim a run at it. The refusal
 * itself is the server's (`busy.claim`); this is only what the pickers show. */
let busyMap = {};                     // account id -> { service, label }

const busyLabel = id => (busyMap[String(id)] || {}).label || '';

async function refreshBusy() {
  try {
    const { busy } = await api('/api/accounts/busy');
    busyMap = busy || {};
  } catch { busyMap = {}; }
  // Anything ticked that has since become busy is unticked, on every picker.
  let changed = false;
  for (const id of [...scrapePicked]) if (busyMap[id]) { scrapePicked.delete(id); changed = true; }
  for (const id of [...fbPicked]) if (busyMap[id]) { fbPicked.delete(id); changed = true; }
  for (const id of [...camp.picked]) if (busyMap[id]) { camp.picked.delete(id); changed = true; }
  if (panelIsOn('scraping')) { paintScrapeAccounts(); paintRunButtons(); }
  if (panelIsOn('fb')) paintFbAccounts();
  if (panelIsOn('campaign') && changed) refreshCampSessions();
}

/* ── Scraping ────────────────────────────────────────────────── */

/* Opening the panel: which windows are open, because that decides whether Scrape
 * can be pressed at all. There is nothing else to load — the page a scrape walks
 * is Home and the table fills itself from the run. */
async function loadScraping() {
  refreshScrapeSessions();
  paintPipeline();
  try {
    const { settings } = await api('/api/settings');
    if (settings && settings.scrape_stall_seconds !== undefined) {
      pipe.stall = Number(settings.scrape_stall_seconds) || 0;
    }
  } catch { /* the clocks still run without it */ }

  // A walk that does not stop outlives the page that started it — a reload, a
  // second tab. Find it again and pick the watch back up, rather than showing an
  // idle panel over a browser that is still scrolling.
  try {
    const state = await api('/api/scrape/status');
    pipe.running = !!state.running;
    applySweepTick(state);
    if (state.running && state.task && watching !== state.task) {
      pipe.task = state.task;
      watchTask(state.task, {
        onTick: applySweepTick,
        onDone: result => {
        pipe.running = false; applySweepTick(result);
        // A groups scrape moves groups from Unscraped to Scraped.
        if (scrapeSource === 'groups') loadScrapeGroups({ pull: false });
      },
      });
    }
  } catch { /* the panel still works without it */ }
}

/* The accounts a sweep can run on, and the ones ticked to run on. Not one
 * account — a run walks every account that is ticked, all at once, so this is a
 * multiple choice and the answer is a set.
 *
 * `known` is what makes "lit by default" work without overriding the operator: a
 * window seen for the first time joins the run, a window they turned OFF stays
 * off through every poll after it. Without it, either a fresh window never
 * joined or an unticked one lit itself again five seconds later. */
let openSessions = [];               // the open windows, newest read
let scrapePicked = new Set();        // the ids ticked to walk
let scrapeKnown = new Set();         // every id this page has offered
let scrapeLanes = {};                // id -> what the running sweep says of it
let scrapeSource = 'feed';           // 'feed' (bsky.app home), 'inbox' (bsky.app) or 'groups'
const SCRAPE_LABEL = { feed: 'Scrape Feed', followers: 'Scrape Followers', inbox: 'Scrape Chats', groups: 'Scrape Groups' };
const SCRAPE_TITLE = {
  feed: 'Scroll the home feed on bsky.app in every ticked window at once, hover every new author for the profile card, and collect the handle, name, bio and followers. Saved to the Data panel and to the handles file on MinIO. It does not stop on its own — press Stop.',
  followers: 'In every ticked window: open an author\'s profile off the home feed, open their Followers list and collect everyone on it — name, handle and bio — then back to Home for the next author. Saved to the Data panel and the handles file on MinIO. It does not stop on its own — press Stop.',
  inbox: 'Scroll the chat list on bsky.app in every ticked window at once and collect the conversations. It does not stop on its own — press Stop.',
  groups: 'Open every group each ticked account is in, one by one by clicking its name, and collect everyone on the group\'s People tab. It stops when every group has been read, or press Stop.',
};

/* Which page to walk. One lit at a time; settled at the press, so the chips are
 * dead while a run is going for the same reason the account chips are. */
function paintScrapeSource() {
  $$('#scrape-source .as-chip').forEach(chip => {
    chip.classList.toggle('on', chip.dataset.source === scrapeSource);
  });
}

/* Live while a walk is going as well: the running walk keeps the type it
 * started with - the server settled that when it started - and picking another
 * one here sets up the next run and shows what that type has collected. */
$('#scrape-source').addEventListener('click', e => {
  const chip = e.target.closest('.as-chip[data-source]');
  if (!chip) return;
  scrapeSource = chip.dataset.source;
  paintScrapeSource();
  paintScrapeGroupsVisible();
  paintRunButtons();
  renderPipeRows();
});

const sessionKey = s => String(s && s.id != null ? s.id : 'default');

async function refreshScrapeSessions() {
  try {
    const { accounts } = await api('/api/scrape/accounts');
    openSessions = accounts;
  } catch {
    // The server is down or restarting. An empty strip says "no windows", which
    // is the safe reading of "cannot tell".
    openSessions = [];
  }

  const live = new Set(openSessions.map(a => a.id));
  // A window that has gone takes its tick with it, so a run cannot be aimed at
  // something that is not there.
  scrapePicked.forEach(id => { if (!live.has(id)) scrapePicked.delete(id); });
  scrapeKnown.forEach(id => { if (!live.has(id)) scrapeKnown.delete(id); });
  openSessions.forEach(a => {
    if (!scrapeKnown.has(a.id)) { scrapeKnown.add(a.id); scrapePicked.add(a.id); }
    if (busyLabel(a.id)) scrapePicked.delete(a.id);
  });

  paintScrapeAccounts();
  paintRunButtons();
}

/* One chip per open window: a tick before a run, a counter during one. */
function paintScrapeAccounts() {
  const strip = $('#scrape-accounts');
  if (!openSessions.length) {
    strip.innerHTML = `<span class="muted">No browser window is open — open one
      from <b>Accounts</b> and it appears here.</span>`;
    return;
  }
  strip.innerHTML =
    `<span class="as-label">Walk</span>` +
    openSessions.map(a => {
      const lane = scrapeLanes[a.id];
      const on = scrapePicked.has(a.id);
      // The count comes off the running sweep while there is one, and off the
      // accounts read otherwise — which is what keeps the last run's numbers on
      // screen after it ends instead of blanking them.
      const n = lane ? lane.count : a.count;
      const bad = (lane && lane.error) || a.error;
      // Spoken for by another service: shown, named, and not a choice. A
      // lane of THIS run is busy with Scraping too, and stays a lane.
      const busy = (!lane || !lane.running) ? busyLabel(a.id) : '';
      return `<button class="as-chip ${on ? 'on' : ''}${bad ? ' lane-bad' : ''}${busy ? ' busy' : ''}"
                 data-id="${escapeHtml(a.id)}"
                 ${pipe.running || busy ? 'disabled' : ''}
                 title="${busy ? `Busy with ${escapeHtml(busy)} — stop that first`
                          : bad ? escapeHtml(bad)
                          : on ? 'Walking this feed — click to leave it out'
                               : 'Left out — click to walk this feed too'}">
        <svg class="ic" viewBox="0 0 24 24"><use href="#i-user"/></svg>${
          escapeHtml(a.label || a.account || 'account')}${
          busy ? `<span class="as-busy">${escapeHtml(busy)}</span>` : ''}${
          (n || (lane && lane.running)) ? `<span class="as-n" title="Collected by this window">${n || 0}</span>` : ''}${
          lane && lane.running ? `<span class="as-dot"></span>` : ''}</button>`;
    }).join('');
}

$('#scrape-accounts').addEventListener('click', e => {
  const chip = e.target.closest('.as-chip[data-id]');
  // Not mid-run. Which accounts a walk is on was settled when it started, and a
  // chip that looked like it could change that would be lying.
  if (!chip || pipe.running || chip.classList.contains('busy')) return;
  const id = chip.dataset.id;
  if (scrapePicked.has(id)) scrapePicked.delete(id); else scrapePicked.add(id);
  paintScrapeAccounts();
  paintRunButtons();
  if (scrapeSource === 'groups') loadScrapeGroups();
});

/* ── The roster ──────────────────────────────────────────────── */

const pipe = {
  target: null,           // the feed, once a run has opened it
  rows: [],               // the tail of what has been collected — see `total`
  total: 0,               // how many in all: a non-stop run outgrows its table
  done: [],               // the runs this session has finished
  task: null,             // the walk, while it is walking
  running: false,
  mode: 'feed',           // which page the rows on screen came off
  view: 'all',            // 'all' for the merged roster, or a lane id
  startedAt: '',          // when the walk began, off the frame
  endedAt: '',            // when it ended, or '' while it is going
  stall: 90,              // the watchdog's limit, off the settings
};

/* ── The clocks ──────────────────────────────────────────────── */

const mmss = ms => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(r).padStart(2, '0');
};

/* Seconds since a lane last found someone, or null when it is not walking. */
function quietSeconds(lane) {
  if (!lane || !lane.running || !lane.last_new_at) return null;
  const then = Date.parse(lane.last_new_at);
  if (isNaN(then)) return null;
  return Math.max(0, Math.floor((Date.now() - then) / 1000));
}

function paintScrapeClocks() {
  const timer = $('#scrape-timer');
  const quiet = $('#scrape-quiet');
  const started = pipe.startedAt ? Date.parse(pipe.startedAt) : NaN;
  if (isNaN(started)) { timer.hidden = true; quiet.hidden = true; return; }
  const ended = pipe.endedAt ? Date.parse(pipe.endedAt) : NaN;
  const until = pipe.running || isNaN(ended) ? Date.now() : ended;
  timer.hidden = false;
  timer.classList.toggle('live', pipe.running);
  $('#scrape-elapsed').textContent = mmss(until - started);

  // The stall clock is per account, so it shows for the tab on screen; on All
  // it shows the quietest lane, which is the one about to be reloaded.
  const lanes = Object.values(scrapeLanes);
  const picked = pipe.view === 'all' ? lanes : lanes.filter(l => String(l.id) === pipe.view);
  const secs = picked.map(quietSeconds).filter(v => v !== null);
  if (!pipe.running || !secs.length) { quiet.hidden = true; return; }
  const worst = Math.max(...secs);
  quiet.hidden = false;
  quiet.classList.toggle('warn', pipe.stall > 0 && worst >= pipe.stall * 0.75);
  quiet.textContent = `quiet ${worst}s`;
}

// Once a second while a walk is going: the clocks move on their own, and so
// do the stall counters on the tabs.
setInterval(() => {
  if (!pipe.running) return;
  paintScrapeClocks();
  paintScrapeTabs();
}, 1000);

function paintPipeline() {
  paintScrapeTabs();
  paintScrapeClocks();
  renderPipeRows();
  paintScrapeAccounts();
  paintScrapeSource();
  paintRunButtons();
}

/* Scrape and Stop are one control in two states, and with the bar gone they are
 * the whole of what says which state the panel is in: exactly one of them is on
 * screen, and it is the one that does the thing that can be done next.
 *
 * Only a run going disables Scrape. It used to be held off on this side's own
 * reading of whether a browser window was open, which is a SECOND answer to a
 * question the server already answers — and a second answer is one that can be
 * wrong on its own: a read that had not come back yet, or one that came back
 * while the panel was not on screen, left the button dead over a window that
 * was up. The server decides, at the press, and says so if the answer is no. */
function paintRunButtons() {
  // Nothing ticked is the ONE thing this side can rule out for itself, because
  // it is this side's own question — the server never sees a choice that was
  // never made. Everything else about whether a run can start is the server's.
  const nothingPicked = openSessions.length > 0 && scrapePicked.size === 0;
  const button = $('#pipe-auto');
  button.disabled = pipe.running || nothingPicked;
  button.title = nothingPicked
    ? 'Tick at least one account above to walk its page.'
    : (SCRAPE_TITLE[scrapeSource] || SCRAPE_TITLE.feed);
  // What it says as well as whether it works: with two of three ticked, "Scrape
  // 2 accounts" is the confirmation that the third was left out on purpose.
  const many = scrapePicked.size > 1;
  $('#pipe-auto-label').textContent = many
    ? `Scrape ${scrapePicked.size} accounts` : (SCRAPE_LABEL[scrapeSource] || 'Scrape');
  $('#pipe-stop').hidden = !pipe.running;
  if (scrapeSource === 'groups') renderScrapeGroups();
}

/* How a run ENDED — "stopped" and "X threw us off the feed" are different
 * mornings, and the run is the only thing that knows which this was. It used to
 * sit under the buttons as a line of standing text; said once, when it happens,
 * is what it was always for. Guarded against repeating: the tick and the done
 * callback both arrive carrying the final frame. */
let lastNote = '';
function setPipeNote(message) {
  if (!message || message === lastNote) return;
  lastNote = message;
  toast(message);
}

/* ── Running a sweep ─────────────────────────────────────────── */

/* The walk has no end of its own, so this only ever starts it. What ends it is
 * Stop, and until that is pressed the run keeps scrolling Home. */
async function startSweep(extra = {}) {
  lastNote = '';
  try {
    // The ticked ids, as a list. The server decides what is actually walkable
    // out of them — a window that closed between the tick and the press is its
    // answer to give, not this side's guess.
    const body = { sessions: [...scrapePicked], source: scrapeSource, ...extra };
    const { task } = await api('/api/scrape/sweep', { method: 'POST', body });
    pipe.task = task;
    pipe.running = true;
    paintRunButtons();
    watchTask(task, {
      onTick: applySweepTick,
      // The note comes off the frame, not from here: `stopped` and `X threw us
      // off the feed` are different endings, and only the run knows which.
      onDone: result => {
        pipe.running = false; applySweepTick(result);
        // A groups scrape moves groups from Unscraped to Scraped.
        if (scrapeSource === 'groups') loadScrapeGroups({ pull: false });
      },
    });
  } catch (err) {
    pipe.running = false;
    paintRunButtons();
    toast(err.message, 'error');
  }
}

$('#pipe-auto').addEventListener('click', () => startSweep());

/* ── FB Groups: scraped and unscraped, on the panel ─────────── */

/* Shown while the scraping type is FB Groups. The columns come from the groups
 * registry (mirrored to fb-groups.txt); each has a button that scrapes exactly
 * the groups in it. Refresh brings in MinIO's scrape dates at once and then
 * reads each ticked account's group list off Bluesky, the columns filling
 * while it reads. */
const scrGroups = { accounts: [], scraped: [], refreshing: false, tab: 'all',
                    query: '', page: 1, picked: new Set(), polledAt: 0 };

function scrSessionsQuery(extra = '') {
  // Every open window, not only the ticked ones: each has a tab of its own,
  // and a tab that shows nothing until its account is ticked is a dead tab.
  const ids = openSessions.map(a => a.id);
  const q = [`sessions=${encodeURIComponent(ids.join(',') || '-')}`];
  if (extra) q.push(extra);
  return q.length ? `?${q.join('&')}` : '';
}

async function loadScrapeGroups({ pull = true } = {}) {
  try {
    const out = await api(`/api/scrape/groups${scrSessionsQuery(pull ? '' : 'pull=0')}`);
    scrGroups.accounts = out.accounts || [];
    scrGroups.scraped = out.scraped || [];
    const r = out.refresh || {};
    scrGroups.refreshing = r.state === 'running';
    const m = out.minio || {};
    let note = '';
    if (scrGroups.refreshing) note = r.note || 'reading the groups off Bluesky…';
    else if (r.state === 'error') note = `Bluesky list not read: ${r.note}`;
    else if (r.state && r.note) note = r.note;
    else if (pull) note = m.ok ? `scraped dates from ${m.bucket}/${m.object}`
                               : `fb-groups.txt not read: ${m.reason || 'MinIO unavailable'}`;
    if (note) $('#scr-groups-note').textContent = note;
    renderScrapeGroups();
    return r;
  } catch (err) {
    $('#scr-groups-note').textContent = err.message;
    return {};
  }
}

/* The two lists. Scraped: groups read from any account. Unscraped: the groups
 * of the account picked on the left that are not in that list - once each. */
function scrapeColumns() {
  const scrapedIds = new Set(scrGroups.scraped.map(g => g.group_id));
  const shown = scrTabAccounts();
  // On one account, both lists are that account's: the groups it has scraped
  // (whoever scraped them) and the groups of its own that are left.
  const mine = new Set(shown.flatMap(a => (a.rows || []).map(r => r.group_id)));
  const done = scrGroups.scraped
    .filter(g => scrGroups.tab === 'all' || mine.has(g.group_id))
    .map(g => ({ ...g, account: { id: g.account_id, label: g.account } }));
  const un = [], seen = new Set();
  for (const a of shown) {
    for (const r of a.rows || []) {
      if (scrapedIds.has(r.group_id) || seen.has(r.group_id)) continue;
      seen.add(r.group_id);
      un.push({ ...r, account: a });
    }
  }
  return { un, done };
}

/* Which accounts the lists are showing: the one picked on the left, or - on
 * All accounts - every account with a window up. */
function scrTabAccounts() {
  if (scrGroups.tab === 'all') return scrGroups.accounts;
  return scrGroups.accounts.filter(a => String(a.id) === scrGroups.tab);
}

/* Re-scrape: a scraped group is read again by an account that is in it -
 * whoever scraped it first may not be the window open now. */
function rescrapeRows(done) {
  const rows = [];
  for (const g of done) {
    const a = scrTabAccounts().find(acc => (acc.rows || []).some(r => r.group_id === g.group_id));
    if (a) rows.push({ ...g, account: a });
  }
  return rows;
}

/* The unscraped rows actually on screen: what the search box leaves, and the
 * page of them being shown. */
const SCR_PER_PAGE = 12;
function scrFiltered(un) {
  const q = scrGroups.query.trim().toLowerCase();
  if (!q) return un;
  return un.filter(r => `${r.name || ''} ${r.group_id}`.toLowerCase().includes(q));
}

function scrPageRows(rows) {
  const pages = Math.max(1, Math.ceil(rows.length / SCR_PER_PAGE));
  if (scrGroups.page > pages) scrGroups.page = pages;
  if (scrGroups.page < 1) scrGroups.page = 1;
  const from = (scrGroups.page - 1) * SCR_PER_PAGE;
  return { pages, rows: rows.slice(from, from + SCR_PER_PAGE), from };
}

/* The accounts down the left: each with how many groups it still has to
 * scrape, and a dot for its browser window. */
function paintScrapeAccountList() {
  const list = $('#scr-rail');
  const accounts = scrGroups.accounts;
  if (scrGroups.tab !== 'all' && !accounts.some(a => String(a.id) === scrGroups.tab)) {
    scrGroups.tab = 'all';
  }
  if (!accounts.length) {
    list.innerHTML = '<span class="muted">No browser window is open.</span>';
    return;
  }
  const scrapedIds = new Set(scrGroups.scraped.map(g => g.group_id));
  const left = a => (a.rows || []).filter(r => !scrapedIds.has(r.group_id)).length;
  const row = (id, label, n, icon) => `
    <button class="scr-acct-btn${scrGroups.tab === id ? ' on' : ''}" data-tab="${escapeHtml(id)}">
      <svg class="ic" viewBox="0 0 24 24"><use href="#${icon}"/></svg>
      <span class="nm">${escapeHtml(label)}</span>
      <span class="tab-n">${n}</span></button>`;
  const all = new Set(accounts.flatMap(a => (a.rows || [])
    .filter(r => !scrapedIds.has(r.group_id)).map(r => r.group_id))).size;
  list.innerHTML = (accounts.length > 1 ? row('all', 'All accounts', all, 'i-users') : '')
    + accounts.map(a => row(String(a.id), a.label, left(a), 'i-user')).join('');
}

$('#scr-rail').addEventListener('click', e => {
  const pick = e.target.closest('button[data-tab]');
  if (!pick) return;
  scrGroups.tab = pick.dataset.tab;
  scrGroups.page = 1;
  scrGroups.picked.clear();
  renderScrapeGroups();
});

$('#scr-find').addEventListener('input', e => {
  scrGroups.query = e.target.value;
  scrGroups.page = 1;
  renderScrapeGroups();
});

$('#scr-pages').addEventListener('click', e => {
  const go = e.target.closest('button[data-page]');
  if (!go) return;
  scrGroups.page = Number(go.dataset.page);
  renderScrapeGroups();
});

/* A tick is a group to scrape. None ticked means the whole list - pressing
 * Scrape without picking anything is the usual case, not an error. */
$('#scr-un-body').addEventListener('change', e => {
  const tick = e.target.closest('input[data-id]');
  if (!tick) return;
  if (tick.checked) scrGroups.picked.add(tick.dataset.id);
  else scrGroups.picked.delete(tick.dataset.id);
  renderScrapeGroups();
});

$('#scr-all-tick').addEventListener('change', e => {
  const { un } = scrapeColumns();
  const page = scrPageRows(scrFiltered(un)).rows;
  page.forEach(r => e.target.checked ? scrGroups.picked.add(r.group_id)
                                     : scrGroups.picked.delete(r.group_id));
  renderScrapeGroups();
});

$('#scr-sync').addEventListener('click', () =>
  refreshScrapeGroups({ only: scrTabAccounts().map(a => String(a.id)) }));

$('#scr-un-go').addEventListener('click', () => {
  const rows = scrFiltered(scrapeColumns().un);
  const ticked = rows.filter(r => scrGroups.picked.has(r.group_id));
  scrapeColumn(ticked.length ? ticked : rows);
});

$('#scr-done-go').addEventListener('click', () =>
  scrapeColumn(rescrapeRows(scrapeColumns().done)));

/* Remove a group from the list. Confirmed, and the confirmation says exactly
 * what goes: the group's row here and in fb-groups.txt, not the people already
 * collected from it and not the group itself on Bluesky. */
$('#scr-done-body').addEventListener('click', async e => {
  const bin = e.target.closest('button[data-del]');
  if (!bin || bin.disabled) return;
  const name = bin.dataset.name || bin.dataset.del;
  const ok = confirm(
    `Remove "${name}" from the groups list?\n\n`
    + 'Its row goes from this list and from fb-groups.txt on MinIO. The people '
    + 'already collected from it are kept.\n\n'
    + 'The group itself is untouched on Bluesky — it comes back as unscraped '
    + 'the next time you sync an account that is in it.');
  if (!ok) return;
  setBusy(bin, true);
  try {
    const out = await api('/api/scrape/groups/delete',
                          { method: 'POST', body: { group_ids: [bin.dataset.del] } });
    toast(out.reason ? `Removed here, but fb-groups.txt was not updated: ${out.reason}`
                     : `Removed "${name}".`, out.reason ? 'error' : '');
    await loadScrapeGroups({ pull: false });
  } catch (err) {
    toast(err.message, 'error');
    setBusy(bin, false);
  }
});

/* The group each account is inside right now, off the run's frames: its
 * name, how many people have been read and how many the group says it has. */
function readingNow() {
  return Object.values(scrapeLanes).flatMap(lane => {
    if (!lane.running) return [];
    // Several groups at once: a line per tab that has a group in it.
    if (Array.isArray(lane.tabs) && lane.tabs.length) {
      return lane.tabs
        .map((t, i) => (t && t.group ? {
          account: lane.account || '', name: t.group, tab: i + 1,
          read: Number(t.read || 0), total: Number(t.total || 0),
        } : null))
        .filter(Boolean);
    }
    return [oneGroupLine(lane)].filter(Boolean);
  });
}

/* One group at a time: what this account is inside right now. */
function oneGroupLine(lane) {
  {
    if (lane.group && lane.group.name) {
      return { account: lane.account || '', name: lane.group.name,
               read: Number(lane.group.read || 0), total: Number(lane.group.total || 0) };
    }
    // A server that predates the group being sent on the frame still says it in
    // words: 'people in "X"', or '"X" - 240 of 4532 people'.
    const said = String(lane.status || '');
    const m = /^(?:people in )?"(.+?)"(?: - (\d+)(?: of (\d+))? people)?$/.exec(said);
    if (!m) return null;
    return { account: lane.account || '', name: m[1],
             read: Number(m[2] || 0), total: Number(m[3] || 0) };
  }
}

function paintScrapeLive() {
  const box = $('#scr-live');
  const busy = readingNow();
  box.hidden = !busy.length;
  if (box.hidden) return;
  box.innerHTML = busy.map(l => {
    const { read, total } = l;
    const part = total ? Math.min(100, Math.round((read / total) * 100)) : 0;
    return `<div class="row1">
        <span class="dot"></span>
        <span class="who">${escapeHtml(l.account)}${l.tab ? ` · tab ${l.tab}` : ''}</span>
        <span class="g">Reading ${escapeHtml(l.name)}</span>
        <div class="grow"></div>
        <span class="n">${read.toLocaleString()}${
          total ? ` of ${total.toLocaleString()}` : ''} people</span>
      </div>${total ? `<div class="bar"><i style="width:${part}%"></i></div>` : ''}`;
  }).join('');
}

function renderScrapeGroups() {
  paintScrapeAccountList();
  paintScrapeLive();
  const { un, done } = scrapeColumns();
  const many = scrGroups.tab === 'all' && scrGroups.accounts.length > 1;
  const acct = r => many && r.account.label
    ? `<span class="scr-acct">${escapeHtml(r.account.label)}</span>` : '';
  const blocked = pipe.running || scrGroups.refreshing;

  // -- the groups still to scrape, searched and paged
  const found = scrFiltered(un);
  const { pages, rows, from } = scrPageRows(found);
  $('#scr-un-n').textContent = `(${found.length}${found.length !== un.length ? ` of ${un.length}` : ''})`;
  $('#scr-un-body').innerHTML = rows.length
    ? rows.map((r, i) => `<tr>
        <td class="c-tick"><input type="checkbox" data-id="${escapeHtml(r.group_id)}"
            ${scrGroups.picked.has(r.group_id) ? 'checked' : ''}></td>
        <td><span class="m-name">${escapeHtml(r.name || r.group_id)}</span>${acct(r)}</td>
        <td class="muted c-gid">${escapeHtml(r.group_id)}</td>
        <td class="c-go">${r.url
          ? `<a class="scr-view" href="${escapeHtml(r.url)}" target="_blank" rel="noreferrer noopener">View</a>`
          : ''}</td></tr>`).join('')
    : `<tr><td class="pad muted" colspan="4">${
        !scrGroups.accounts.length ? 'No account window open.'
        : un.length ? 'No group matches that search.'
        : 'No unscraped group. Press Sync to ask Bluesky for this account\'s groups.'}</td></tr>`;
  void from;

  // -- the pages
  const page = n => `<button data-page="${n}" class="tiny${n === scrGroups.page ? ' on' : ''}">${n}</button>`;
  let strip = '';
  if (pages > 1) {
    const near = [1, pages, scrGroups.page, scrGroups.page - 1, scrGroups.page + 1]
      .filter(n => n >= 1 && n <= pages);
    const list = [...new Set(near)].sort((x, y) => x - y);
    strip = `<button data-page="${Math.max(1, scrGroups.page - 1)}" class="tiny"
               ${scrGroups.page === 1 ? 'disabled' : ''}>‹</button>`;
    list.forEach((n, i) => {
      if (i && n - list[i - 1] > 1) strip += '<span class="gap">…</span>';
      strip += page(n);
    });
    strip += `<button data-page="${Math.min(pages, scrGroups.page + 1)}" class="tiny"
                ${scrGroups.page === pages ? 'disabled' : ''}>›</button>`;
  }
  $('#scr-pages').innerHTML = strip;
  const ticked = found.filter(r => scrGroups.picked.has(r.group_id)).length;
  $('#scr-all-tick').checked = rows.length > 0 && rows.every(r => scrGroups.picked.has(r.group_id));
  $('#scr-un-go').disabled = blocked || !found.length;
  $('#scr-un-go .lbl').textContent = ticked
    ? `Scrape ${ticked} ticked` : found.length ? `Scrape ${found.length} group${found.length === 1 ? '' : 's'}` : 'Scrape';

  // -- when Bluesky was last asked about this account's groups
  const stamps = scrTabAccounts().map(a => a.synced_at).filter(Boolean);
  const sync = $('#scr-synced');
  sync.textContent = !scrTabAccounts().length ? ''
    : !stamps.length ? 'not synced yet'
    : `synced ${(ago(stamps.sort()[0]) || {}).text || 'just now'}`;
  if (stamps.length) sync.title = new Date(stamps[0]).toLocaleString();
  $('#scr-sync').disabled = blocked || !scrTabAccounts().length;
  $('#scr-sync .lbl').textContent = scrGroups.refreshing ? 'Syncing…' : 'Sync';

  // -- the groups already read
  // The group being read right now, at the top of the list it is joining -
  // with how many of its people have been read so far.
  const live = readingNow();
  const liveNames = new Set(live.map(l => l.name));
  const liveRows = live.map(l => `<tr class="scr-reading">
      <td><span class="m-name">${escapeHtml(l.name)}</span>
          <span class="scr-acct">reading${l.tab ? ` · tab ${l.tab}` : ''}${
            l.account ? ` · ${escapeHtml(l.account)}` : ''}</span></td>
      <td class="c-ppl">${l.read.toLocaleString()}${l.total ? ` / ${l.total.toLocaleString()}` : ''}</td>
      <td class="c-when muted">now</td><td class="c-del"></td></tr>`).join('');
  const rest = done.filter(r => !liveNames.has(r.name));
  $('#scr-done-n').textContent = `${done.length} group${done.length === 1 ? '' : 's'}`;
  $('#scr-done-body').innerHTML = liveRows + (rest.length ? rest
    .map(r => `<tr>
        <td><span class="m-name">${escapeHtml(r.name || r.group_id)}</span>${acct(r)}</td>
        <td class="c-ppl">${Number(r.scraped_members || 0).toLocaleString()}${
          r.members_total ? `<span class="of-total">of ${
            Number(r.members_total).toLocaleString()}</span>` : ''}</td>
        <td class="c-when muted">${escapeHtml(new Date(r.scraped_at).toLocaleDateString())}</td>
        <td class="c-del"><button class="scr-del" data-del="${escapeHtml(r.group_id)}"
            data-name="${escapeHtml(r.name || r.group_id)}" ${blocked ? 'disabled' : ''}
            title="Remove this group from the list">
            <svg class="ic" viewBox="0 0 24 24"><use href="#i-trash"/></svg></button></td></tr>`).join('')
    : liveRows ? '' : `<tr><td colspan="4"><div class="scr-empty">
         <strong>No scraped groups yet</strong>
         <span>Groups you scrape appear here.</span></div></td></tr>`);
  const again = rescrapeRows(done).length;
  $('#scr-done-go').disabled = blocked || !again;
  $('#scr-done-go .lbl').textContent = again ? `Re-scrape ${again}` : 'Re-scrape';

  const refresh = $('#scr-refresh');
  refresh.disabled = blocked;
  refresh.querySelector('.lbl').textContent = scrGroups.refreshing
    ? 'Syncing…' : 'Sync all accounts';
}

/* The columns are part of the panel only while FB Groups is the type. */
function paintScrapeGroupsVisible() {
  const on = scrapeSource === 'groups';
  $('#scr-groups').hidden = !on;
  $('.panel[data-panel="scraping"]').classList.toggle('groups-mode', on);
  if (!on) return;
  // What is on record, and nothing else. Asking Bluesky drives the account's
  // browser window, so it happens when Re-sync or Refresh is pressed - never
  // on its own because a panel was opened or the app was started.
  loadScrapeGroups();
}

/* Scrape exactly the groups in one column: per account, so each account's
 * walk reads only its own groups, and only accounts that have any. */
function scrapeColumn(rows) {
  const only = {};
  for (const r of rows) (only[r.account.id] = only[r.account.id] || []).push(r.group_id);
  startSweep({ only, sessions: Object.keys(only) });
}

async function refreshScrapeGroups({ only = null } = {}) {
  if (scrGroups.refreshing) return;
  const sessions = only || openSessions.map(a => a.id);
  if (!sessions.length) {
    toast('No browser window is open.', 'error');
    return loadScrapeGroups();
  }
  try {
    const out = await api('/api/scrape/groups/refresh', { method: 'POST', body: { sessions } });
    scrGroups.refreshing = true;
    // MinIO's answer is in already: show the scraped column from it at once.
    await loadScrapeGroups({ pull: false });
    const m = out.minio || {};
    if (!m.ok) toast(`fb-groups.txt not read: ${m.reason || 'MinIO unavailable'}`, 'error');
    // Then fill as Bluesky's list is read, until the read is over.
    while (scrGroups.refreshing) {
      await new Promise(done => setTimeout(done, 1500));
      const r = await loadScrapeGroups({ pull: false });
      if (!r.state) break;
    }
    const { un, done } = scrapeColumns();
    toast(`${done.length} scraped, ${un.length} unscraped`);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    scrGroups.refreshing = false;
    renderScrapeGroups();
  }
}

$('#scr-refresh').addEventListener('click', () => refreshScrapeGroups());

/* Not confirmed, and deliberately: everything the walk collected is already on
 * disk, so this costs nothing but the scrolling — and a run that will not stop
 * without a dialog in the way is worse than one that stops too readily. */
$('#pipe-stop').addEventListener('click', async e => {
  setBusy(e.currentTarget, true);
  try {
    const state = await api('/api/scrape/stop', { method: 'POST' });
    applySweepTick(state);
    setPipeNote(state.note || 'stopping');
  } catch (err) {
    toast(err.message, 'error');
  } finally { setBusy(e.currentTarget, false); }
});

/* One shape from the run, applied wherever it lands. The run owns the roster —
 * it decides what it found — so this paints what came back rather than
 * reassembling it on this side from a percentage. */
function applySweepTick(status) {
  if (!status) return;
  if (status.target) pipe.target = status.target;
  if (status.mode) pipe.mode = status.mode;
  if ('started_at' in status) pipe.startedAt = status.started_at || '';
  if ('ended_at' in status) pipe.endedAt = status.ended_at || '';
  // `rows` is the tail of the roster, `total` is all of it. A walk that does not
  // stop outgrows anything a table can paint, so the run sends the recent slice
  // and the count beside it rather than ten thousand rows every 900ms.
  if (Array.isArray(status.rows)) pipe.rows = status.rows;
  if (typeof status.total === 'number') pipe.total = status.total;
  else if (Array.isArray(status.rows)) pipe.total = status.rows.length;
  // Per lane: which accounts are still walking and how many each has found. The
  // strip is the only thing that says a lane died while the others carried on.
  if (Array.isArray(status.lanes)) {
    scrapeLanes = Object.fromEntries(status.lanes.map(l => [String(l.id), l]));
  }
  if (Array.isArray(status.done)) pipe.done = status.done;
  if (status.note) setPipeNote(status.note);
  paintPipeline();
  // A groups run moves groups from one list to the other as it goes: the group
  // it is inside counts as scraped the moment its first people come in. The
  // lists are re-read every few seconds so that shows while the run is going.
  if (!$('#scr-groups').hidden) {
    renderScrapeGroups();
    const now = Date.now();
    if (now - scrGroups.polledAt > 4000) {
      scrGroups.polledAt = now;
      loadScrapeGroups({ pull: false });
    }
  }
}

/* One tab per lane, plus All. Drawn from `scrapeLanes`, which the run's frame
 * fills and which outlives the run, so the tabs of the last walk stay on
 * screen until the next one replaces them. A lane that has gone (a window
 * closed, a new run on other accounts) takes its tab with it, and a view
 * pointing at it falls back to All. */
function paintScrapeTabs() {
  const bar = $('#scrape-tabs');
  const lanes = Object.values(scrapeLanes);
  if (!lanes.length) { bar.hidden = true; pipe.view = 'all'; return; }
  if (pipe.view !== 'all' && !scrapeLanes[pipe.view]) pipe.view = 'all';
  bar.hidden = false;
  bar.innerHTML =
    `<button data-view="all" class="${pipe.view === 'all' ? 'on' : ''}">
       <svg class="ic" viewBox="0 0 24 24"><use href="#i-users"/></svg>All
       <span class="tab-n">${pipe.total}</span></button>` +
    lanes.map(l => {
      const q = quietSeconds(l);
      const warn = q !== null && pipe.stall > 0 && q >= pipe.stall * 0.75;
      const title = l.error ? l.error : `${l.account || ''} — ${l.status || 'walking'}`;
      return `
      <button data-view="${escapeHtml(String(l.id))}"
              class="${pipe.view === String(l.id) ? 'on' : ''}${l.error ? ' lane-bad' : ''}"
              title="${escapeHtml(title)}">
        <svg class="ic" viewBox="0 0 24 24"><use href="#i-user"/></svg>${
          escapeHtml(l.account || l.id)}
        <span class="tab-n" title="Collected by this window">${l.count || 0}</span>${
          q !== null ? `<span class="tab-sep">·</span><span class="tab-quiet ${warn ? 'warn' : ''}" title="Seconds since this window last found someone">${q}s quiet</span>` : ''}${
          l.skipped ? `<span class="tab-sep">·</span><span class="tab-skip" title="Passed over: chat closed to this account">✕${l.skipped} skipped</span>` : ''}${
          l.restarts ? `<span class="tab-sep">·</span><span class="tab-r" title="Reloads and restarts">↻${l.restarts}</span>` : ''}${
          l.running ? '<span class="as-dot"></span>' : ''}</button>`;
    }).join('');
}

$('#scrape-tabs').addEventListener('click', e => {
  const tab = e.target.closest('button[data-view]');
  if (!tab) return;
  pipe.view = tab.dataset.view;
  paintScrapeTabs();
  paintScrapeClocks();
  renderPipeRows();
});

/* The rows the picked tab shows: the merged roster, or one lane's own. */
function viewedRows() {
  if (pipe.view === 'all') return { rows: pipe.rows, total: pipe.total };
  const lane = scrapeLanes[pipe.view];
  const rows = (lane && lane.rows) || [];
  return { rows, total: lane ? (lane.count || rows.length) : rows.length };
}

function renderPipeRows() {
  const body = $('#pipe-mem-table tbody');
  const { rows, total } = viewedRows();
  $('#sum-total').textContent = total;
  // The big number IS the sum of the windows; with more than one walking it
  // is written out as that sum, in the order of the tabs, so it can be read
  // against them at a glance.
  const breakdown = $('#sum-breakdown');
  if (breakdown) {
    const lanes = Object.values(scrapeLanes);
    const many = pipe.view === 'all' && lanes.length > 1;
    breakdown.hidden = !many;
    if (many) {
      breakdown.textContent = `= ${lanes.map(l => l.count || 0).join(' + ')}`;
      breakdown.title = lanes.map(l => `${l.account || l.id}: ${l.count || 0}`).join('\n');
    }
  }
  if (!rows.length) {
    body.innerHTML = `<tr class="note"><td colspan="5" class="muted">${
      pipe.view === 'all'
        ? `Nothing collected yet — press <b>${SCRAPE_LABEL[scrapeSource] || 'Scrape'}</b>.`
        : 'Nothing from this account yet.'}</td></tr>`;
    return;
  }
  // A feed row never gets a bio: the feed shows none and the walk opens no
  // profiles. "reading…" there would be waiting on nothing.
  // Nor a group member row: the People page shows no bio either.
  const live = pipe.mode !== 'feed' && pipe.mode !== 'groups' && pipe.mode !== 'followers';
  body.innerHTML = rows.map((r, i) => `
    <tr class="${r.dm_open === false ? 'unreachable' : ''}">
      <td class="c-n">${i + 1}</td>
      <td>
        <div class="c-who">
          <span class="avatar"><svg class="ic" viewBox="0 0 24 24"><use href="#i-user"/></svg></span>
          <span class="who-text">${whoText(r, { title: r.card || '' })}</span>
        </div>
      </td>
      <td class="c-bio">${bioCell(r, { live })}</td>
      <td class="c-followers">${compact(r.followers)}</td>
      <td class="c-dm">${dmBadge(r.dm_open)}</td>
    </tr>`).join('');
}

/* What the account says it is, off the card X pops up on hover — the line under
 * the username in that popup. One line, clipped, with the whole of it on the
 * hover: it is read by running an eye down the column looking for the handful
 * worth messaging, and a wrapped paragraph per row makes that scroll for ever.
 *
 * Blank is said, not left empty. A row still being read and a row whose author
 * wrote no bio look identical otherwise, and only one of them is worth waiting
 * on. */
function bioCell(row, { live = true } = {}) {
  const bio = (row.bio || '').trim();
  if (bio) return `<span class="bio-text" title="${escapeHtml(bio)}">${escapeHtml(bio)}</span>`;
  // "reading…" only where something still IS reading. On a saved roster the walk
  // finished long ago, so a row with no card is one whose card was never caught
  // — waiting on it would be waiting on nothing.
  return row.card || !live
    ? `<span class="bio-none">no bio</span>`
    : `<span class="bio-none pending">reading…</span>`;
}

/* Whether a DM can reach this account at all. It is the single fact that decides
 * if a row is worth a slot in a campaign, so it gets a badge rather than a tick:
 * "closed" has to be as readable as "open" from a scroll away.
 *
 * THREE answers, not two. Nothing short of opening the profile says whether an
 * inbox is open, and the walk does not open profiles — so a scraped row arrives
 * with this unknown, and drawing unknown as "closed" is the console inventing a
 * fact about an account nobody checked. Unknown says so. */
function dmBadge(open) {
  if (open === null || open === undefined) {
    return `<span class="st none" title="Not checked — a hover card does not say whether an inbox is open"
      ><svg class="ic" viewBox="0 0 24 24"><use href="#i-dots"/></svg></span>`;
  }
  return open
    ? `<span class="st sent"><svg class="ic" viewBox="0 0 24 24"><use href="#i-check"/></svg>open</span>`
    : `<span class="st none"><svg class="ic" viewBox="0 0 24 24"><use href="#i-x"/></svg>closed</span>`;
}

/* ── Actions: Groups joining ─────────────────────────────────── */

/* Two cards. Groups joining is a task, watched through the same poller
 * everything long-running is watched through - the panel asks the server what
 * state it is in rather than remembering, same as FB Campaign. Under it, the
 * four Bluesky rail buttons, each an inline press in the open window. */
async function loadActions() {
  renderActionGrid();
  await refreshActGate();
}

async function paintGjFromServer() {
  try {
    paintGj(await api('/api/groups/join/status'));
  } catch (err) {
    paintGj({ state: 'idle', note: err.message, windows: [] });
  }
}

function paintGj(status) {
  const running = status.state === 'running';
  gjRunning = running;
  gjLast = status;
  if (running) grpView = 'joining';
  const win = $('#gj-window');
  if (win && status.windows) {
    win.textContent = status.windows.length
      ? `window open on ${status.windows.map(w => w.label).join(', ')}`
      : 'no window open yet';
  }
  $('#gj-start').hidden = running;
  $('#gj-stop').hidden = !running;
  for (const [id, key] of [['#gj-min', 'min'], ['#gj-max', 'max']]) {
    const box = $(id);
    if (status[key] && (running || box.dataset.touched !== '1')) box.value = status[key];
  }

  const say = status.state && status.state !== 'idle';
  $('#gj-live').hidden = !say;
  paintGroupsShared();
  if (!say) return;

  $('#gj-dot').className = `dot ${running ? 'on' : status.state === 'done' ? '' : 'bad'}`;
  $('#gj-state').textContent = {
    running: 'Joining', stopped: 'Stopped', done: 'Finished',
  }[status.state] || status.state;
  $('#gj-note').textContent = [status.account, status.note].filter(Boolean).join(' — ');
  $('#gj-joined').textContent = status.joined || 0;
  $('#gj-want').textContent = status.want || 0;
  $('#gj-tried').textContent = status.tried || 0;
}

for (const id of ['#gj-min', '#gj-max']) {
  $(id).addEventListener('input', e => { e.currentTarget.dataset.touched = '1'; });
}

$('#gj-start').addEventListener('click', async e => {
  const min = Math.max(1, Math.min(50, parseInt($('#gj-min').value, 10) || 5));
  const max = Math.max(1, Math.min(50, parseInt($('#gj-max').value, 10) || 10));
  setBusy(e.currentTarget, true);
  // The table follows this job from the moment it is pressed.
  grpView = 'joining';
  try {
    const out = await api('/api/groups/join', {
      method: 'POST',
      // The panel's account chips choose the window for both jobs.
      body: { min, max, ...(grpPicked ? { account: grpPicked } : {}) },
    });
    paintGj(out);
    watchTask(out.task, {
      onTick: st => paintGj(st),
      onDone: () => paintGjFromServer(),
    });
  } catch (err) {
    toast(err.message, 'error');
  } finally { setBusy(e.currentTarget, false); }
});

$('#gj-stop').addEventListener('click', async e => {
  setBusy(e.currentTarget, true);
  try {
    paintGj(await api('/api/groups/join/stop', { method: 'POST' }));
  } catch (err) {
    toast(err.message, 'error');
  } finally { setBusy(e.currentTarget, false); }
});

/* ── Actions: Bluesky's rail ───────────────────────────────── */

/* One button per item down the left of bsky.app, each pressed on its own.
 * Pressing one presses that item in the live browser window - the real element,
 * not a navigation to its URL. The backend's MESSENGER_ACTIONS decides which
 * keys exist and NAV_ACTIONS which selector each maps to; this list only puts an
 * icon beside each, in the rail's own order. */
const MSG_ACTIONS = [
  // Top to bottom, as the rail has them. A place is clicked and then scrolled
  // like a reader would; a popup (the account switcher, the composer) is
  // opened, left a moment, and closed again.
  { key: 'switch',        label: 'Switch accounts',  icon: 'i-users', popup: true },
  { key: 'home',          label: 'Home',             icon: 'i-home' },
  { key: 'explore',       label: 'Explore',          icon: 'i-search' },
  { key: 'notifications', label: 'Notifications',    icon: 'i-bell' },
  { key: 'chat',          label: 'Chat',             icon: 'i-chat' },
  { key: 'feeds',         label: 'Feeds',            icon: 'i-hash' },
  { key: 'lists',         label: 'Lists',            icon: 'i-list' },
  { key: 'saved',         label: 'Saved',            icon: 'i-save' },
  { key: 'profile',       label: 'Profile',          icon: 'i-user' },
  { key: 'settings',      label: 'Settings',         icon: 'i-gear' },
  { key: 'compose',       label: 'Compose new post', icon: 'i-plus',  post: true },
];

/* Like the scrape, a press runs against whichever window is open - this reads
 * what IS open rather than asking, and only offers a picker when there is more
 * than one to choose between. */
let actSessions = [];
let actSession = null;

function renderActionGrid() {
  const grid = $('#act-grid');
  if (!grid || grid.childElementCount) return;
  grid.innerHTML = MSG_ACTIONS.map(a => `
    <button class="act-btn" data-action="${a.key}" disabled
            title="${a.post
              ? 'Open the composer, type one Campaign message, attach one picture from Media, and post it'
              : a.popup
              ? `Open ${escapeHtml(a.label)} in the open bsky.app window, then close it again`
              : `Click ${escapeHtml(a.label)} in the open bsky.app window and scroll the page that opens`}">
      <svg class="ic" viewBox="0 0 24 24"><use href="#${a.icon}"/></svg>
      <span>${escapeHtml(a.label)}</span>
    </button>`).join('');
}

async function refreshActGate() {
  try {
    const { sessions } = await api('/api/accounts/sessions');
    actSessions = sessions.filter(s => s.active);
    // Keep the operator's pick if its window is still up; otherwise fall to the
    // first open one, rather than silently driving a different account.
    const stillUp = actSessions.some(s => sessionKey(s) === sessionKey(actSession));
    if (!stillUp) actSession = actSessions[0] || null;
    paintActGate(actSessions.length > 0);
  } catch {
    actSessions = [];
    actSession = null;
    paintActGate(false);
  }
}

function paintActGate(active) {
  const gate = $('#act-gate');
  if (!gate) return;
  gate.hidden = active;
  $('#act-ready').hidden = !active;
  document.querySelectorAll('#act-grid .act-btn').forEach(b => {
    if (!b.classList.contains('busy')) b.disabled = !active;
  });
  if (!active) return;

  const many = actSessions.length > 1;
  $('#act-ready').innerHTML =
    `<span class="as-label">Pressing as</span>` +
    actSessions.map(s => {
      const on = sessionKey(s) === sessionKey(actSession);
      const name = escapeHtml(s.label || (s.login ? '@' + s.login : 'account'));
      return many
        ? `<button class="as-chip ${on ? 'on' : ''}" data-key="${escapeHtml(sessionKey(s))}">
             <svg class="ic" viewBox="0 0 24 24"><use href="#i-user"/></svg>${name}</button>`
        : `<span class="as-chip static">
             <svg class="ic" viewBox="0 0 24 24"><use href="#i-user"/></svg>${name}</span>`;
    }).join('');
}

$('#act-ready').addEventListener('click', e => {
  const chip = e.target.closest('.as-chip[data-key]');
  if (!chip) return;
  actSession = actSessions.find(s => sessionKey(s) === chip.dataset.key) || actSession;
  paintActGate(true);
});

$('#act-open-accounts').addEventListener('click', () => showPanel('accounts'));

/* What a Compose press posts: text, a photo, or both. Both unless changed. */
let postMode = 'both';
$('#act-post-mode').addEventListener('click', e => {
  const chip = e.target.closest('.as-chip[data-mode]');
  if (!chip) return;
  postMode = chip.dataset.mode;
  $$('#act-post-mode .as-chip').forEach(c => c.classList.toggle('on', c === chip));
});

$('#act-grid').addEventListener('click', async e => {
  const button = e.target.closest('.act-btn[data-action]');
  if (!button || button.disabled) return;
  const label = button.querySelector('span').textContent;
  setBusy(button, true);
  try {
    const out = await api('/api/actions/messenger/click', {
      method: 'POST',
      body: { action: button.dataset.action, session: sessionKey(actSession), mode: postMode },
    });
    if (out.posted) {
      const what = out.mode === 'text' ? `"${out.draft}"`
                 : out.mode === 'photo' ? out.image
                 : `"${out.draft}" with ${out.image} (${out.attached})`;
      toast(`Posted ${what}`, 'ok');
    } else {
      const said = { 'opened and closed': 'Opened and closed', 'clicked and scrolled': 'Clicked and scrolled' }[out.result] || 'Pressed';
      toast(`${said}: ${label} in the open window`, 'ok');
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally { setBusy(button, false); }
});

/* ── Group Posting ───────────────────────────────────────────── */

/* Groups joined: one button, run as a task and watched through the same
 * poller everything long-running is. The panel asks the server what state it
 * is in rather than remembering; the list under it is the picked account's
 * last walk, kept in the store, so it is there before anything is pressed. */
let grpRunning = false;
let gjRunning = false;               // is the joining job going
let gjLast = null;                   // the joining job's last status
let grpView = 'posting';             // which job the shared table is showing
let grpTable = { rows: [], label: '', when: '' };   // the posting job's table
let grpWindows = [];
let grpSaved = {};
let grpPicked = null;                 // account id the table shows / the run uses
let grpMedia = [];                    // pictures chosen for the post, by library name
let grpRunAccount = { id: '', label: '' };   // whose run the panel is showing

async function loadGroups() {
  await Promise.all([paintGrpFromServer(), paintGjFromServer()]);
}

async function paintGrpFromServer() {
  try {
    paintGrp(await api('/api/groups/status'));
  } catch (err) {
    paintGrp({ state: 'idle', note: err.message, windows: [], saved: {} });
  }
}

function paintGrp(status) {
  const running = status.state === 'running';
  grpRunning = running;
  if (running) grpView = 'posting';
  if (status.windows) grpWindows = status.windows;
  if (status.saved) grpSaved = status.saved;
  if (status.account_id) grpRunAccount = { id: String(status.account_id),
                                           label: status.account || '' };
  // Follow the run's account while it goes; otherwise keep the pick if it is
  // still there, else the first open window, else the first account with a
  // list.
  if (running && status.account_id) grpPicked = String(status.account_id);
  // The account the run used counts as a choice even when its window has since
  // been closed. Without it a finished run vanished off the panel the moment
  // the browser was shut - the rows were there, with nothing willing to show
  // them.
  const ids = [...new Set([
    ...grpWindows.map(w => String(w.id)),
    ...Object.keys(grpSaved),
    ...(status.account_id ? [String(status.account_id)] : []),
  ])];
  if (!grpPicked || !ids.includes(grpPicked)) grpPicked = ids[0] || null;

  const win = $('#grp-window');
  if (win && status.windows) {
    win.textContent = grpWindows.length
      ? `window open on ${grpWindows.map(w => w.label).join(', ')}`
      : 'no window open yet';
  }
  paintGrpAccounts();

  $('#grp-joined').hidden = running;
  $('#grp-stop').hidden = !running;

  // The post box is LOCKED while a run is going: what is on screen is what is
  // being typed into groups, and the two must not be able to drift apart.
  // Running, it shows the run's own words, so a reload mid-run shows what is
  // actually going out.
  const box = $('#grp-text');
  if (running && typeof status.text === 'string') box.value = status.text;
  if (running && Array.isArray(status.media)) grpMedia = status.media.slice();
  paintGrpMedia();

  const say = status.state && status.state !== 'idle';
  $('#grp-live').hidden = !say;
  if (say) {
    $('#grp-dot').className = `dot ${running ? 'on' : status.state === 'done' ? '' : 'bad'}`;
    $('#grp-state').textContent = {
      running: 'Reading', stopped: 'Stopped', done: 'Finished',
    }[status.state] || status.state;
    $('#grp-note').textContent = [status.account, status.note].filter(Boolean).join(' — ');
    $('#grp-count').textContent = status.count || 0;
    $('#grp-visited').textContent = status.visited || 0;
    // Only on screen when this run is posting - a "0 posted" beside a run that
    // was never meant to post reads as a failure.
    const posting = !!(status.text || (status.media && status.media.length));
    $('#grp-posted-wrap').hidden = !posting;
    $('#grp-posted').textContent = status.posted || 0;
  }

  // The table: the run's own list while it is on the picked account, else the
  // store's copy for that account.
  const mine = status.account_id && String(status.account_id) === grpPicked
            && Array.isArray(status.groups) && (running || status.groups.length);
  // Label the run's own account even when it is not an open window any more.
  const runLabel = status.account || '';
  const kept = grpSaved[grpPicked] || null;
  const rows = mine ? status.groups : (kept ? kept.groups : []);
  const label = (grpWindows.find(w => String(w.id) === grpPicked) || {}).label
             || (kept && kept.label) || (mine ? runLabel : '');
  grpTable = { rows, label, when: mine ? (running ? '' : 'now') : (kept ? kept.at : '') };
  paintGroupsShared();
}

/* The two jobs on this panel share one table and never run together.
 *
 * Whichever is going owns the table and the other section is locked - faded
 * and every control in it disabled - so a second job cannot be started over
 * the first. Nothing running, the table stays on the job that ran last. */
function paintGroupsShared() {
  if (gjRunning) grpView = 'joining';
  else if (grpRunning) grpView = 'posting';
  else if (grpView === 'posting' && !(grpTable.rows || []).length
           && gjLast && (gjLast.rows || []).length) grpView = 'joining';

  const busy = grpRunning || gjRunning;
  $('.grp-left').classList.toggle('locked', gjRunning);
  $('.grp-join').classList.toggle('locked', grpRunning);
  // Posting's controls: out while EITHER job runs; its Start only while joining.
  for (const sel of ['#grp-text', '#grp-pick', '#grp-existing']) $(sel).disabled = busy;
  $('#grp-joined').disabled = gjRunning;
  // Joining's controls, the same way round.
  for (const sel of ['#gj-min', '#gj-max']) $(sel).disabled = busy;
  $('#gj-start').disabled = grpRunning;
  paintGrpMedia();
  paintGrpAccounts();

  if (grpView === 'joining') paintJoinTable(gjLast);
  else paintGrpTable(grpTable.rows, grpTable.label, grpTable.when);
}

const GRP_HEAD_POSTING = '<tr><th class="c-n">#</th><th>Group</th><th>Address</th>'
                       + '<th>Opened</th><th>Posted</th></tr>';
const GRP_HEAD_JOINING = '<tr><th class="c-n">#</th><th>Group</th>'
                       + '<th>Joined</th><th>Details</th></tr>';

/* The joining job in the shared table: every group it pressed Join on. */
function paintJoinTable(status) {
  const rows = (status && status.rows) || [];
  const head = $('#grp-list-head');
  const wrap = $('#grp-wrap');
  head.hidden = !rows.length;
  wrap.hidden = !rows.length;
  if (!rows.length) return;
  $('#grp-thead').innerHTML = GRP_HEAD_JOINING;
  $('#grp-list-title').textContent =
    `Joined ${status.joined || 0} of ${status.want || 0}${status.account ? ` — ${status.account}` : ''}`;
  $('#grp-list-when').textContent = status.state === 'running' ? 'joining now'
    : status.state === 'stopped' ? 'stopped' : 'last joining run';
  $('#grp-table tbody').innerHTML = rows.map((g, i) => {
    const requested = g.ok && /request/i.test(g.note || '');
    const badge = g.ok
      ? `<span class="st ${requested ? 'typed' : 'sent'}"><svg class="ic" viewBox="0 0 24 24"><use href="#i-${
          requested ? 'clock' : 'check'}"/></svg>${requested ? 'requested' : 'joined'}</span>`
      : '<span class="st failed"><svg class="ic" viewBox="0 0 24 24"><use href="#i-x"/></svg>not joined</span>';
    return `
    <tr>
      <td class="c-n">${i + 1}</td>
      <td><span class="m-name">${escapeHtml(g.name)}</span></td>
      <td>${badge}</td>
      <td class="muted" title="${escapeHtml(g.note || '')}">${escapeHtml(truncate(g.note || '', 80))}</td>
    </tr>`;
  }).join('');
}

function paintGrpAccounts() {
  const strip = $('#grp-accounts');
  if (!strip) return;
  const ids = [...new Set([...grpWindows.map(w => String(w.id)), ...Object.keys(grpSaved)])];
  if (!ids.length) {
    strip.innerHTML = `<span class="muted">No window open — Start opens one on the first account.</span>`;
    return;
  }
  strip.innerHTML = `<span class="as-label">Account</span>` + ids.map(id => {
    const open = grpWindows.some(w => String(w.id) === id);
    const label = (grpWindows.find(w => String(w.id) === id) || {}).label
               || (grpSaved[id] && grpSaved[id].label)
               || (String(id) === String(grpRunAccount.id) ? grpRunAccount.label : '')
               || id;
    const n = grpSaved[id] ? grpSaved[id].groups.length : 0;
    return `<button class="as-chip ${id === grpPicked ? 'on' : ''}" data-id="${escapeHtml(id)}"
               ${grpRunning || gjRunning ? 'disabled' : ''}
               title="${open ? 'Window open' : 'No window open - the button will launch one'}">
      <svg class="ic" viewBox="0 0 24 24"><use href="#i-user"/></svg>${escapeHtml(label)}${
        n ? `<span class="as-n">${n}</span>` : ''}</button>`;
  }).join('');
}

/* What became of the post in this group. Blank when the run was not posting,
 * because an empty column is honest and a red cross is not. */
function postedCell(g) {
  if (!g.posted) return '<span class="st none">—</span>';
  const said = escapeHtml(g.said || '');
  if (g.posted === 'yes') {
    const pending = /approv/i.test(g.said || '');
    return `<span class="st ${pending ? 'typed' : 'sent'}" title="${said}">
        <svg class="ic" viewBox="0 0 24 24"><use href="#i-${pending ? 'clock' : 'check'}"/></svg>${
          pending ? 'waiting for an admin' : 'posted'}</span>`;
  }
  return `<span class="st failed" title="${said}">
      <svg class="ic" viewBox="0 0 24 24"><use href="#i-x"/></svg>not posted</span>
    ${g.said ? `<span class="st-why">${escapeHtml(truncate(g.said, 44))}</span>` : ''}`;
}

function paintGrpTable(rows, label, when) {
  const head = $('#grp-list-head');
  const wrap = $('#grp-wrap');
  const has = rows && rows.length;
  head.hidden = !has;
  wrap.hidden = !has;
  if (!has) return;
  $('#grp-thead').innerHTML = GRP_HEAD_POSTING;
  $('#grp-list-title').textContent = `${rows.length} group${rows.length === 1 ? '' : 's'}${label ? ` — ${label}` : ''}`;
  $('#grp-list-when').textContent = when === 'now' ? 'read just now'
    : when ? `read ${new Date(when).toLocaleString()}` : 'reading now';
  // A group that opened with a welcome or rules sheet over it says so: the
  // sheet was closed by its X, and how many went is worth seeing at a glance.
  const opened = g => g.visited === 'yes'
    ? `<span class="st sent" title="${escapeHtml(g.how || g.title || '')}"><svg class="ic" viewBox="0 0 24 24"><use href="#i-check"/></svg>opened</span>${
        g.closed ? `<span class="st-why">closed ${g.closed} panel${g.closed === 1 ? '' : 's'}</span>` : ''}`
    : g.visited === 'no'
      ? `<span class="st failed" title="${escapeHtml(g.how || '')}"><svg class="ic" viewBox="0 0 24 24"><use href="#i-x"/></svg>could not open</span>${
          g.how ? `<span class="st-why">${escapeHtml(truncate(g.how, 40))}</span>` : ''}`
      : '<span class="st none">—</span>';
  $('#grp-table tbody').innerHTML = rows.map((g, i) => `
    <tr>
      <td class="c-n">${i + 1}</td>
      <td><span class="m-name">${escapeHtml(g.name)}</span></td>
      <td><a href="${escapeHtml(g.url)}" target="_blank" rel="noopener" class="muted">${escapeHtml(g.url.replace('https://bsky.app', ''))}</a></td>
      <td>${opened(g)}</td>
      <td>${postedCell(g)}</td>
    </tr>`).join('');
}

/* The pictures chosen for the post, as chips that can be taken off again. */
function paintGrpMedia() {
  const box = $('#grp-media');
  if (!box) return;
  box.innerHTML = grpMedia.map(name => `
    <span class="grp-chip" title="${escapeHtml(name)}">
      <svg class="ic" viewBox="0 0 24 24"><use href="#i-image"/></svg>
      ${escapeHtml(truncate(name, 22))}
      <button class="grp-x" data-name="${escapeHtml(name)}" ${grpRunning || gjRunning ? 'disabled' : ''}
              title="Take this picture off the post">
        <svg class="ic" viewBox="0 0 24 24"><use href="#i-x"/></svg></button>
    </span>`).join('');
}

$('#grp-media').addEventListener('click', e => {
  const x = e.target.closest('.grp-x[data-name]');
  if (!x || grpRunning || gjRunning) return;
  grpMedia = grpMedia.filter(n => n !== x.dataset.name);
  paintGrpMedia();
});

$('#grp-pick').addEventListener('click', () => $('#grp-file').click());

/* Uploaded into the SAME media library the campaign uses, so a picture put in
 * here is available there and the other way about - one library, not two. */
$('#grp-file').addEventListener('change', async e => {
  const files = [...(e.currentTarget.files || [])];
  e.currentTarget.value = '';
  if (!files.length) return;
  setBusy($('#grp-pick'), true);
  try {
    // The same upload the campaign's media step uses, into the same library.
    await postFiles('/api/media', files, 'files');
    // The server keeps each file under its own name and renames on a clash,
    // so the library is re-read rather than the names being guessed at.
    const { media } = await api('/api/media');
    const newest = (media || []).slice(-files.length).map(m => m.name);
    for (const name of newest) if (!grpMedia.includes(name)) grpMedia.push(name);
    paintGrpMedia();
    toast(`${newest.length} picture${newest.length === 1 ? '' : 's'} added`, 'ok');
  } catch (err) {
    toast(err.message, 'error');
  } finally { setBusy($('#grp-pick'), false); }
});

$('#grp-accounts').addEventListener('click', e => {
  const chip = e.target.closest('.as-chip[data-id]');
  if (!chip || grpRunning || gjRunning) return;
  grpPicked = chip.dataset.id;
  paintGrpFromServer();
});

/* Start Group posting. With something to post, the chooser comes first and
 * its Post button starts the run; with nothing to post the run only opens
 * each group, and starts at once. */
$('#grp-joined').addEventListener('click', async e => {
  const text = $('#grp-text').value.trim();
  // "Posting in existing groups": every group in the Bluesky list, one by
  // one, whatever the counts say - so no chooser.
  if ((text || grpMedia.length) && $('#grp-existing').checked) {
    if (!confirm('Post in every group this account has joined on Bluesky? There is no unpost.')) return;
    setBusy(e.currentTarget, true);
    try { await startGroupRun({}); }
    catch (err) { toast(err.message, 'error'); }
    finally { setBusy(e.currentTarget, false); }
    return;
  }
  if (text || grpMedia.length) {
    setBusy(e.currentTarget, true);
    try { await openGroupChooser(); }
    catch (err) { toast(err.message, 'error'); }
    finally { setBusy(e.currentTarget, false); }
    return;
  }
  setBusy(e.currentTarget, true);
  try { await startGroupRun({}); }
  catch (err) { toast(err.message, 'error'); }
  finally { setBusy(e.currentTarget, false); }
});

async function startGroupRun(extra) {
  grpView = 'posting';
  const body = {
    ...(grpPicked ? { account: grpPicked } : {}),
    text: $('#grp-text').value.trim(),
    media: grpMedia,
    // Post is always pressed: there is no dry-run option on this panel.
    click_post: true,
    ...extra,
  };
  const out = await api('/api/groups/joined', { method: 'POST', body });
  paintGrp(out);
  watchTask(out.task, {
    onTick: st => paintGrp(st),
    onDone: () => paintGrpFromServer(),
  });
}

/* ── The group chooser ───────────────────────────────────────── */

/* Every group the posting account is in, ticked by default. Skip unticks the
 * ones already posted in and keeps them unticked; turning it off ticks them
 * again. What is ticked when Post is pressed is what the run posts in - the
 * walk still reaches each by pressing its name in the Groups list, and passes
 * over the rest without a click. */
const grpChoose = { rows: [], ticked: new Set(), account: '' };

async function openGroupChooser() {
  const q = grpPicked ? `?account=${encodeURIComponent(grpPicked)}` : '';
  const out = await api(`/api/groups/list${q}`);
  grpChoose.rows = out.rows || [];
  grpChoose.account = out.account || '';
  grpChoose.ticked = new Set(grpChoose.rows.map(r => r.group_id));
  $('#grp-skip-used').checked = false;
  $('#grp-choose-sub').textContent = grpChoose.account ? `— posting as ${grpChoose.account}` : '';
  const m = out.minio || {};
  $('#grp-choose-minio').textContent = m.ok
    ? `counts from ${m.bucket}/${m.object}`
    : `fb-groups.txt not read: ${m.reason || 'MinIO unavailable'} - using the counts kept here`;
  renderGroupChooser();
  $('#grp-choose').showModal();
}

function renderGroupChooser() {
  const rows = grpChoose.rows;
  const used = rows.filter(r => r.used_count > 0).length;
  $('#grp-skip-n').textContent = used ? `(${used})` : '(none yet)';
  const body = $('#grp-choose-table tbody');
  if (!rows.length) {
    body.innerHTML = `<tr><td class="pad muted" colspan="4">No saved groups for this account
      yet. Posting will go through every group in its Bluesky list, and the list is saved
      as it goes.</td></tr>`;
  } else {
    body.innerHTML = rows.map(r => {
      const on = grpChoose.ticked.has(r.group_id);
      return `<tr class="${on ? '' : 'off'} ${r.used_count ? 'used' : ''}" data-id="${escapeHtml(r.group_id)}">
        <td class="c-tick"><input type="checkbox" ${on ? 'checked' : ''}></td>
        <td><span class="m-name">${escapeHtml(r.name || r.group_id)}</span></td>
        <td class="grp-used">${r.used_count ? `${r.used_count} time${r.used_count === 1 ? '' : 's'}` : '<span class="muted">never</span>'}</td>
        <td class="muted">${r.last_posted ? escapeHtml(new Date(r.last_posted).toLocaleString()) : '—'}</td>
      </tr>`;
    }).join('');
  }
  const n = rows.filter(r => grpChoose.ticked.has(r.group_id)).length;
  const head = $('#grp-choose-head');
  head.checked = rows.length > 0 && n === rows.length;
  head.indeterminate = n > 0 && n < rows.length;
  head.disabled = !rows.length;
  $('#grp-choose-count').textContent = rows.length ? `${n} of ${rows.length} selected` : '';
  const go = $('#grp-choose-go');
  go.disabled = rows.length > 0 && n === 0;
  go.querySelector('.lbl').textContent = rows.length
    ? `Post in ${n} group${n === 1 ? '' : 's'}` : 'Post in every group';
}

function tickGroups(test, on) {
  for (const r of grpChoose.rows) {
    if (!test(r)) continue;
    if (on) grpChoose.ticked.add(r.group_id); else grpChoose.ticked.delete(r.group_id);
  }
  renderGroupChooser();
}

$('#grp-choose-table').addEventListener('click', e => {
  const row = e.target.closest('tr[data-id]');
  if (!row) return;
  const id = row.dataset.id;
  const r = grpChoose.rows.find(x => x.group_id === id);
  // A group already posted in stays out while Skip is on.
  if ($('#grp-skip-used').checked && r && r.used_count > 0 && !grpChoose.ticked.has(id)) {
    toast('Turn off "Skip groups already posted in" to choose this group.', 'warn');
    renderGroupChooser();
    return;
  }
  if (grpChoose.ticked.has(id)) grpChoose.ticked.delete(id); else grpChoose.ticked.add(id);
  renderGroupChooser();
});

$('#grp-choose-head').addEventListener('change', e => {
  const skip = $('#grp-skip-used').checked;
  tickGroups(r => !(e.currentTarget.checked && skip && r.used_count > 0), e.currentTarget.checked);
});
$('#grp-choose-all').addEventListener('click', () => {
  const skip = $('#grp-skip-used').checked;
  tickGroups(r => !(skip && r.used_count > 0), true);
});
$('#grp-choose-none').addEventListener('click', () => tickGroups(() => true, false));
$('#grp-skip-used').addEventListener('change', e =>
  tickGroups(r => r.used_count > 0, !e.currentTarget.checked));

for (const id of ['#grp-choose-close', '#grp-choose-cancel']) {
  $(id).addEventListener('click', () => $('#grp-choose').close());
}

$('#grp-choose-go').addEventListener('click', async e => {
  const chosen = grpChoose.rows.filter(r => grpChoose.ticked.has(r.group_id)).map(r => r.group_id);
  const every = !grpChoose.rows.length;
  if (!every && !chosen.length) return;
  const n = every ? 'every group this account is in' : `${chosen.length} group${chosen.length === 1 ? '' : 's'}`;
  if (!confirm(`Post in ${n}? There is no unpost.`)) return;
  setBusy(e.currentTarget, true);
  try {
    await startGroupRun(every ? {} : { only: chosen });
    $('#grp-choose').close();
  } catch (err) {
    toast(err.message, 'error');
  } finally { setBusy(e.currentTarget, false); }
});

$('#grp-stop').addEventListener('click', async e => {
  setBusy(e.currentTarget, true);
  try {
    paintGrp(await api('/api/groups/stop', { method: 'POST' }));
  } catch (err) {
    toast(err.message, 'error');
  } finally { setBusy(e.currentTarget, false); }
});

/* ── FB Campaign ─────────────────────────────────────────────── */

/* One box, one button. Start is a run with no natural end - a home feed is
 * infinite - so it is a task, watched through the same poller everything else
 * long-running is watched through. The server opens the window itself.
 *
 * The panel asks the server what state it is in rather than remembering: a
 * console that tracks a run in a variable is a console that shows Stop over a
 * run the server finished ten minutes ago. */
let fbWindows = [];                  // the open windows, newest read
let fbPicked = new Set();            // the ids ticked to comment from
let fbKnown = new Set();             // every id this page has offered
let fbLanes = [];                    // the running (or last) run's lanes
let fbView = 'all';                  // 'all' or a lane id
let fbRunning = false;
let fbSource = 'own';                // 'own': the box · 'db': a stored message per post
let fbWhere = 'home';                // 'home': the Home feed · 'videos': the Video feed

/* Which chip is lit, and the box dimmed when it is not what will be posted. */
function paintFbSource() {
  $$('#fb-source .as-chip').forEach(c => {
    c.classList.toggle('on', c.dataset.source === fbSource);
    c.disabled = fbRunning;
  });
  $$('#fb-where .as-chip').forEach(c => {
    c.classList.toggle('on', c.dataset.where === fbWhere);
    c.disabled = fbRunning;
  });
  $('.fb-run-controls').classList.toggle('from-db', fbSource === 'db');
  $('#fb-comment-text').placeholder = fbSource === 'db'
    ? 'Comments come from the stored messages' : 'Comment to post on each post';
}

$('#fb-source').addEventListener('click', e => {
  const chip = e.target.closest('.as-chip[data-source]');
  if (!chip || fbRunning) return;
  fbSource = chip.dataset.source;
  paintFbSource();
});

$('#fb-where').addEventListener('click', e => {
  const chip = e.target.closest('.as-chip[data-where]');
  if (!chip || fbRunning) return;
  fbWhere = chip.dataset.where;
  paintFbSource();
});

async function loadFb() {
  await refreshBusy();
  await paintFbFromServer();
}

/* One chip per open window: a tick before a run, that account's state during
 * one. Lit by default the first time a window is seen, unticked stays unticked,
 * and busy elsewhere is not a choice at all - the same rules as Scraping. */
function paintFbAccounts() {
  const strip = $('#fb-accounts');
  if (!strip) return;
  const live = new Set(fbWindows.map(w => String(w.id)));
  fbPicked.forEach(id => { if (!live.has(id)) fbPicked.delete(id); });
  fbKnown.forEach(id => { if (!live.has(id)) fbKnown.delete(id); });
  fbWindows.forEach(w => {
    const id = String(w.id);
    if (!fbKnown.has(id)) { fbKnown.add(id); fbPicked.add(id); }
    if (busyLabel(id) && !laneOf(id)) fbPicked.delete(id);
  });
  if (!fbWindows.length) {
    strip.innerHTML = `<span class="muted">No browser window is open — press
      <b>Start</b> to launch one on the first account, or open one from <b>Accounts</b>.</span>`;
    return;
  }
  strip.innerHTML =
    `<span class="as-label">Comment from</span>` +
    fbWindows.map(w => {
      const id = String(w.id);
      const lane = laneOf(id);
      const mine = lane && lane.state === 'running';
      const busy = mine ? '' : busyLabel(id);
      const on = fbPicked.has(id);
      return `<button class="as-chip ${on ? 'on' : ''}${busy ? ' busy' : ''}${lane && lane.error ? ' lane-bad' : ''}"
                 data-id="${escapeHtml(id)}" ${fbRunning || busy ? 'disabled' : ''}
                 title="${busy ? `Busy with ${escapeHtml(busy)} — stop that first`
                          : on ? 'Commenting from this account — click to leave it out'
                               : 'Left out — click to comment from this account too'}">
        <svg class="ic" viewBox="0 0 24 24"><use href="#i-user"/></svg>${escapeHtml(w.label || id)}${
          busy ? `<span class="as-busy">${escapeHtml(busy)}</span>` : ''}${
          lane && lane.commented ? `<span class="as-n">${lane.commented}</span>` : ''}${
          mine ? '<span class="as-dot"></span>' : ''}</button>`;
    }).join('');
}

const laneOf = id => fbLanes.find(l => String(l.id) === String(id));

$('#fb-accounts').addEventListener('click', e => {
  const chip = e.target.closest('.as-chip[data-id]');
  if (!chip || fbRunning || chip.classList.contains('busy')) return;
  const id = chip.dataset.id;
  if (fbPicked.has(id)) fbPicked.delete(id); else fbPicked.add(id);
  paintFbAccounts();
});

/* One tab per account on the run, plus All. The strip under them shows the
 * picked tab's own state and counts; All shows the sums. */
function paintFbTabs() {
  const bar = $('#fb-tabs');
  if (!fbLanes.length) { bar.hidden = true; fbView = 'all'; return; }
  if (fbView !== 'all' && !laneOf(fbView)) fbView = 'all';
  bar.hidden = false;
  const total = fbLanes.reduce((n, l) => n + (l.commented || 0), 0);
  bar.innerHTML =
    `<button data-view="all" class="${fbView === 'all' ? 'on' : ''}">
       <svg class="ic" viewBox="0 0 24 24"><use href="#i-users"/></svg>All
       <span class="tab-n">${total}</span></button>` +
    fbLanes.map(l => `
      <button data-view="${escapeHtml(String(l.id))}"
              class="${fbView === String(l.id) ? 'on' : ''}${l.error ? ' lane-bad' : ''}"
              title="${escapeHtml(l.error || l.note || '')}">
        <svg class="ic" viewBox="0 0 24 24"><use href="#i-user"/></svg>${escapeHtml(l.account || l.id)}
        <span class="tab-n">${l.commented || 0}</span>${
          l.state === 'running' ? '<span class="as-dot"></span>' : ''}</button>`).join('');
}

$('#fb-tabs').addEventListener('click', e => {
  const tab = e.target.closest('button[data-view]');
  if (!tab) return;
  fbView = tab.dataset.view;
  paintFbTabs();
  paintFbStrip();
});

let fbLast = null;                   // the last status painted, for the strip

function paintFbStrip() {
  const status = fbLast;
  if (!status) return;
  const lane = fbView === 'all' ? null : laneOf(fbView);
  const shown = lane || status;
  const running = shown.state === 'running';
  const say = shown.state && shown.state !== 'idle';
  $('#fb-live').hidden = !say;
  if (!say) return;
  $('#fb-dot').className = `dot ${running ? 'on' : shown.state === 'done' && !shown.error ? '' : 'bad'}`;
  $('#fb-state').textContent = {
    running: 'Scrolling', stopped: 'Stopped', done: 'Finished',
  }[shown.state] || shown.state;
  $('#fb-note').textContent = lane
    ? [lane.account, lane.note].filter(Boolean).join(' — ')
    : [status.lanes && status.lanes.length > 1 ? `${status.lanes.length} accounts` : status.account,
       status.note].filter(Boolean).join(' — ');
  $('#fb-passes').textContent = shown.passes || 0;
  $('#fb-posts').textContent = shown.posts || 0;
  $('#fb-commented').textContent = shown.commented || 0;
  // Hidden at zero rather than shown as "0 failed"; shown as soon as it is not.
  $('#fb-failed').textContent = shown.failed || 0;
  $('#fb-failed-wrap').hidden = !(shown.failed > 0);
  $('#fb-followed').textContent = shown.followed || 0;
  $('#fb-followed-wrap').hidden = !(shown.followed > 0 || status.where === 'videos');
}

async function paintFbFromServer() {
  try {
    paintFb(await api('/api/fb/status'));
  } catch (err) {
    paintFb({ state: 'idle', note: err.message, windows: [] });
  }
}

function paintFb(status) {
  const running = status.state === 'running';
  fbRunning = running;
  fbLast = status;
  if (Array.isArray(status.lanes)) fbLanes = status.lanes;
  const win = $('#fb-window');
  // Only `/api/fb/status` carries the window list; the per-pass state the task
  // pushes does not. So an absent `windows` means "not asked" and the line is
  // LEFT ALONE.
  if (win && status.windows) {
    const open = status.windows;
    fbWindows = open;
    win.textContent = open.length
      ? `window open on ${open.map(w => w.label).join(', ')}`
      : 'no window open yet';
  }
  paintFbAccounts();
  paintFbTabs();

  $('#fb-start').hidden = running;
  $('#fb-stop').hidden = !running;

  // The comment box is LOCKED while a run is going: the text on screen is the
  // text being typed into posts, and it must not be able to drift from it.
  // While running it shows the run's own text (so a reload mid-run shows what
  // is actually being posted); idle, it is filled from the remembered setting
  // only when it is empty, so a half-typed edit is never overwritten by a tick.
  const box = $('#fb-comment-text');
  if (box) {
    box.disabled = running;
    if (running && typeof status.comment === 'string') box.value = status.comment;
    else if (!running && !box.value && status.comment) box.value = status.comment;
  }
  // The source the same way: the run's own while it goes, the remembered one
  // once, and the count of stored messages whenever the server says it.
  if (status.source && (running || !paintFb.sourceSeen)) {
    fbSource = status.source === 'db' ? 'db' : 'own';
    paintFb.sourceSeen = true;
  }
  if (status.where && (running || !paintFb.whereSeen)) {
    fbWhere = status.where === 'videos' ? 'videos' : 'home';
    paintFb.whereSeen = true;
  }
  if (typeof status.drafts === 'number') {
    const n = $('#fb-drafts-n');
    n.textContent = status.drafts;
    n.hidden = false;
  }
  paintFbSource();
  // Tabs: locked the same way, and filled from the server's answer only when
  // it is not being edited (it starts at 1, so "untouched" is "equals 1").
  const tabsBox = $('#fb-tabs-box');
  if (tabsBox) {
    tabsBox.disabled = running;
    if (status.tabs && (running || tabsBox.dataset.touched !== '1')) {
      tabsBox.value = status.tabs;
    }
  }

  // The strip appears once there is something to report and stays afterwards:
  // how a finished run ENDED is worth as much as watching it go. What it
  // shows is the picked tab's - see paintFbStrip.
  paintFbStrip();
}

$('#fb-tabs-box').addEventListener('input', e => { e.currentTarget.dataset.touched = '1'; });

$('#fb-comment-text').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); $('#fb-start').click(); }
});

$('#fb-start').addEventListener('click', async e => {
  let comment = ($('#fb-comment-text').value || '').trim();
  if (!comment && fbSource === 'own') {
    // An empty box falls back to the remembered text rather than refusing: a
    // page opened before the box was filled in shows it empty, and a press
    // that only raised a toast read as "the button does nothing".
    try {
      const st = await api('/api/fb/status');
      comment = (st.comment || '').trim();
      if (comment) $('#fb-comment-text').value = comment;
    } catch (_) { /* the toast below says it */ }
  }
  if (!comment && fbSource === 'own') {
    toast('Type the comment first, or pick Database.', 'error');
    $('#fb-comment-text').focus();
    return;
  }
  const tabs = Math.max(1, Math.min(10, parseInt($('#fb-tabs-box').value, 10) || 1));
  // The ticked accounts. None ticked with windows open is a choice that was
  // never made - said here; with no window at all the server launches one.
  if (fbWindows.length && !fbPicked.size) {
    toast('Tick at least one account above to comment from.', 'error');
    return;
  }
  setBusy(e.currentTarget, true);
  try {
    const out = await api('/api/fb/start', {
      method: 'POST', body: { comment, tabs, source: fbSource, where: fbWhere, accounts: [...fbPicked] },
    });
    fbView = 'all';
    paintFb(out);
    refreshBusy();
    // `result` is the panel's own state, pushed by the task every pass - so the
    // counts move without this polling a second endpoint alongside the first.
    watchTask(out.task, {
      onTick: st => paintFb(st),
      onDone: () => paintFbFromServer(),
    });
  } catch (err) {
    toast(err.message, 'error');
  } finally { setBusy(e.currentTarget, false); }
});

$('#fb-stop').addEventListener('click', async e => {
  setBusy(e.currentTarget, true);
  try {
    paintFb(await api('/api/fb/stop', { method: 'POST' }));
    setTimeout(refreshBusy, 1500);
  } catch (err) {
    toast(err.message, 'error');
  } finally { setBusy(e.currentTarget, false); }
});

/* ── Runs ────────────────────────────────────────────────────── */

/* One run watched at a time. A second watcher on the same task would double
 * every repaint and race the two answers against each other. */
let watching = null;

async function watchTask(taskId, { onTick, onDone } = {}) {
  if (!taskId) return;
  watching = taskId;

  while (watching === taskId) {
    let status;
    try {
      status = await api(`/api/tasks/${encodeURIComponent(taskId)}`);
    } catch (err) {
      // A restart mid-run: the task is gone. Said once, in the feed, rather than
      // left as a control stuck part-way for ever.
      setPill('#pill-run', 'idle', '');
      toast(err.message, 'error');
      break;
    }

    setPill('#pill-run', status.state === 'running' ? 'running' : 'idle',
            status.state === 'running' ? '' : '');
    onTick && onTick(status.result || status);

    if (status.state !== 'running') {
      onDone && onDone(status.result || status);
      break;
    }
    await new Promise(r => setTimeout(r, 900));
  }

  if (watching === taskId) watching = null;
}

/* ── Data ────────────────────────────────────────────────────── */

function loadDataPanel() { loadCollected(); }

/* What a saved roster was collected off. `home` is what a scrape writes now;
 * the rest are the lists this console used to walk, and a roster is a record —
 * the ones written then still have to read as themselves. */
const ROSTER_MODES = {
  inbox: 'Chats', followers: 'Followers', following: 'Following',
  likers: 'Likers of a post', repliers: 'Repliers to a post',
  reposters: 'Reposters of a post', list: 'List members', search: 'Search results',
};

/* This panel reads the STORE, not the rosters.
 *
 * They are very different sizes, and the difference was the panel's own bug: a
 * roster is keyed by target and mode and REPLACED every time that target is
 * walked again, so the rosters are the latest sweep of each target — while the
 * store keeps everyone ever seen. Measured on a real store: four rosters holding
 * 193 handles, against 1,290 collected across twenty-six-plus runs. "193
 * collected" read as "this is everything you have", and it was not.
 *
 * So the table is the store, and the rosters stay for the two things only they
 * can answer: which sweeps are still on file, and which one a Delete acts on. */
let dataRows = [];
let dataRosters = [];

// A store that has been collecting for a week runs to thousands. Rendered in
// pages rather than all at once: the browser will happily build fifteen thousand
// table cells and then be unusable, and nobody reads past the first few hundred
// anyway - the search box is how you get to a particular account.
const ACCT_PAGE = 300;
let acctShown = ACCT_PAGE;

/* Every scraped handle, gone - on the server, on MinIO and here. Confirmed
 * first: there is no undo, and the rows took hours of walking to collect. */
$('#acct-clear').addEventListener('click', async e => {
  if (!confirm('Delete every scraped handle?\n\n'
    + 'This clears the server\'s record, the handles file on MinIO and the copy on this page. '
    + 'Uploaded and imported handles stay. There is no undo.')) return;
  setBusy(e.currentTarget, true);
  try {
    const out = await api('/api/scrape/clear', { method: 'POST', body: {} });
    toast(`Cleared ${out.removed} scraped handle${out.removed === 1 ? '' : 's'}` + (out.minio ? ' — and the handles file on MinIO' : ''), 'ok');
    loadCollected();
  } catch (err) {
    toast(err.message, 'error');
  } finally { setBusy(e.currentTarget, false); }
});

async function loadCollected() {
  const [rows, rosters] = await Promise.all([
    api('/api/store/accounts').then(r => r.rows).catch(err => { toast(err.message, 'error'); return null; }),
    // The sweeps are secondary here — the table stands without them, so a
    // failure to read them must not blank the panel.
    api('/api/data/rosters').then(r => r.rosters).catch(() => null),
  ]);
  if (rows) dataRows = rows;
  if (rosters) dataRosters = rosters;
  renderTargetPicker();
  renderCategoryPicker();
  renderAccounts();
}

/* Every category present in what has been collected, not every category the
 * server knows how to give: an option that matches nothing is an option that
 * wastes a click. "No category" is one of them — an account that says nothing
 * about itself is a real thing to want to look at, usually to decide whether the
 * scrape is working. */
function renderCategoryPicker() {
  const select = $('#acct-cat');
  if (!select) return;
  const keep = select.value;
  const seen = new Map();
  let blank = 0;
  for (const row of dataRows) {
    if (row.category) seen.set(row.category, (seen.get(row.category) || 0) + 1);
    else blank++;
  }
  const options = [...seen.entries()].sort((a, b) => b[1] - a[1]);
  select.innerHTML = '<option value="">Any</option>'
    + options.map(([cat, n]) =>
        `<option value="${escapeHtml(cat)}">${escapeHtml(cat)} (${n})</option>`).join('')
    + (blank ? `<option value="__none__">No category (${blank})</option>` : '');
  select.value = seen.has(keep) || keep === '__none__' ? keep : '';
}

/* Which target to look inside.
 *
 * By target NAME rather than by roster key, because the name is the granularity
 * the store actually records — a stored row says it came off "Chats", not
 * off "inbox-inbox". Counted out of the store too, so the numbers here add up to
 * the head count rather than to the rosters' much smaller one.
 *
 * A target can appear here with its sweep long since deleted or overwritten. That
 * is the point: the handles are still collected, so they are still listed. */
function renderTargetPicker() {
  const select = $('#acct-roster');
  if (!select) return;
  const keep = select.value;
  const seen = new Map();
  for (const row of dataRows) {
    for (const target of row.targets || []) {
      seen.set(target, (seen.get(target) || 0) + 1);
    }
  }
  const options = [...seen.entries()].sort((a, b) => b[1] - a[1]);
  select.innerHTML = '<option value="">All targets</option>'
    + options.map(([target, n]) => {
        // The mode is a fact about the sweep, so it only shows while one is
        // still on file for this target.
        const roster = dataRosters.find(r => r.target === target);
        const mode = roster ? ` — ${ROSTER_MODES[roster.mode] || roster.mode || ''}` : '';
        return `<option value="${escapeHtml(target)}">${
          escapeHtml(target)}${escapeHtml(mode)} (${n})</option>`;
      }).join('');
  select.value = seen.has(keep) ? keep : '';
}

/* Everything the pickers and the search box leave standing.
 *
 * No de-duplication here any more: the store holds each handle once by
 * construction, where the rosters this used to read overlapped and had to be
 * merged by hand. */
function shownAccountRows() {
  const target = $('#acct-roster').value;
  const cat = $('#acct-cat').value;
  const query = $('#acct-search').value.trim().toLowerCase();

  return dataRows.filter(row => {
    if (target && !(row.targets || []).includes(target)) return false;
    // A sentinel rather than an empty value, which the Any option already uses:
    // "has no category" and "do not filter by category" are different questions
    // and one select has to be able to ask both.
    if (cat === '__none__') { if (row.category) return false; }
    else if (cat && row.category !== cat) return false;
    if (!query) return true;
    return `${row.handle} ${row.name || ''} ${row.bio || ''} ${row.category || ''}`
      .toLowerCase().includes(query);
  });
}

/* What the bio says this account IS. A chip rather than plain text: it is the
 * column the table gets scanned down for a shape, and a word in the same weight
 * as the bio beside it disappears into the sentence.
 *
 * Tinted by the label itself, so the same category is the same colour every time
 * the panel is opened - a hue picked from the word rather than from the row's
 * position, which would change as rows are filtered.
 *
 * Shared with the recipients table in step 2, which draws the same column. */
function catCell(row) {
  const cat = row.category || '';
  if (!cat) return `<span class="cat-none">—</span>`;
  let hash = 0;
  for (let i = 0; i < cat.length; i++) hash = (hash * 31 + cat.charCodeAt(i)) % 360;
  return `<span class="cat-chip" style="--cat-h:${hash}">${escapeHtml(cat)}</span>`;
}

/* Who a row is: the name with the handle under it - or, with no name, the
 * handle ONCE. Printing the handle as the name and then again as the handle
 * made every unnamed row read "@waseem / @waseem", which on a list of two
 * thousand looked like every account collected twice. */
function whoText(r, { title = '' } = {}) {
  const tip = title ? ` title="${escapeHtml(title)}"` : '';
  const link = `href="${profileHref(r.handle)}" target="_blank" rel="noreferrer noopener"`;
  return r.name
    ? `<span class="m-name"${tip}>${escapeHtml(r.name)}</span>
       <a class="m-handle" ${link}>${escapeHtml(at(r.handle))}</a>`
    : `<a class="m-name m-only" ${link}${tip}>${escapeHtml(at(r.handle))}</a>`;
}

function renderAccounts() {
  const body = $('#acct-table tbody');
  if (!body) return;
  const rows = shownAccountRows();
  const page = rows.slice(0, acctShown);

  body.innerHTML = page.length
    ? page.map((r, i) => `
      <tr class="${r.dm_open === false ? 'unreachable' : ''}">
        <td class="c-n">${i + 1}</td>
        <td>
          <div class="c-who">
            <span class="avatar"><svg class="ic" viewBox="0 0 24 24"><use href="#i-user"/></svg></span>
            <span class="who-text">${whoText(r)}</span>
          </div>
        </td>
        <td class="c-cat">${catCell(r)}</td>
        <td class="c-bio">${bioCell(r, { live: false })}</td>
        <td class="c-followers">${compact(r.followers)}</td>
        <td class="c-dm">${dmBadge(r.dm_open)}</td>
        <td class="c-drop">
          <button class="icon-btn tiny danger row-drop" data-handle="${escapeHtml(r.handle)}"
                  title="Delete @${escapeHtml(r.handle)} from the store"
                  aria-label="Delete @${escapeHtml(r.handle)} from the store">
            <svg class="ic" viewBox="0 0 24 24"><use href="#i-trash"/></svg></button>
        </td>
      </tr>`).join('')
    : `<tr class="note"><td colspan="7" class="muted">${
        dataRows.length
          ? 'Nothing matches that.'
          : 'Nothing collected yet — run a scrape and it lands here.'}</td></tr>`;

  const withBio = rows.filter(r => r.bio).length;
  const withCat = rows.filter(r => r.category).length;
  $('#acct-info').textContent = rows.length
    ? `${page.length < rows.length ? `${page.length} of ` : ''}${rows.length} account${
        rows.length === 1 ? '' : 's'} · ${withBio} with a bio · ${withCat} categorised`
    : '';
  $('#acct-more').hidden = page.length >= rows.length;

  // The head count is the whole store, unfiltered — so narrowing to eleven rows
  // still says what it was narrowed out of. The sweeps are counted beside it
  // rather than instead of it: they are a much smaller number and used to be
  // shown as if they were this one.
  $('#acct-count').textContent = dataRows.length
    ? `${dataRows.length} collected · ${dataRosters.length} sweep${
        dataRosters.length === 1 ? '' : 's'} on file`
    : '';

  // Deleting acts on a SWEEP, so it needs a target that still has one.
  const drop = $('#acct-drop');
  const picked = $('#acct-roster').value;
  const sweep = picked && dataRosters.find(r => r.target === picked);
  drop.disabled = !sweep;
  drop.title = !picked
    ? 'Pick a target above to delete its saved sweep'
    : sweep
      ? `Delete the saved ${picked} sweep — its handles stay collected`
      : `No saved sweep for ${picked} — its handles are still collected`;
}

// Re-filtering resets the page: a search that matched three hundred and then two
// should not still be offering to show the rest of something else.
$('#acct-roster').addEventListener('change', () => { acctShown = ACCT_PAGE; renderAccounts(); });
$('#acct-cat').addEventListener('change', () => { acctShown = ACCT_PAGE; renderAccounts(); });
$('#acct-search').addEventListener('input', () => { acctShown = ACCT_PAGE; renderAccounts(); });
$('#acct-more').addEventListener('click', () => { acctShown += ACCT_PAGE * 3; renderAccounts(); });

$('#acct-reload').addEventListener('click', loadCollected);

/* Delete ONE handle out of the store, from its own row.
 *
 * Delegated to the table body rather than bound per row, because the table is
 * rebuilt on every keystroke in the search box - three hundred listeners
 * rebound per character is the same list of buttons with a new set of leaks
 * behind it.
 *
 * Addressed by handle, never by row number: the table is filtered and paged, so
 * its numbering is a property of the view. The row is dropped from the local
 * copy rather than the store re-read, because a re-read on a store of thousands
 * to remove one line is a lot of work to arrive back where we already are - but
 * `store.loaded` IS cleared, so the recipients picker in step 2 cannot go on
 * offering a handle this panel has just deleted. */
$('#acct-table').addEventListener('click', async e => {
  const button = e.target.closest('.row-drop');
  if (!button) return;
  const handle = button.dataset.handle;
  if (!handle) return;
  if (!confirm(`Delete @${handle} from the store?

`
             + 'They stop being a recipient anywhere in this console. '
             + 'Messages already sent to them are not undone.')) return;

  setBusy(button, true);
  try {
    await api('/api/store/accounts/delete',
              { method: 'POST', body: { handles: [handle] } });
    dataRows = dataRows.filter(r => String(r.handle).toLowerCase() !== handle.toLowerCase());
    store.loaded = false;              // step 2 re-reads before it offers anyone
    renderTargetPicker();
    renderCategoryPicker();
    renderAccounts();
    toast(`Deleted @${handle}`, 'ok');
  } catch (err) {
    toast(err.message, 'error');
    setBusy(button, false);
  }
});

/* Download what is SHOWN, not the roster it came from: the pickers above are how
 * a useful export is built — one category out of one scrape — and a button that
 * ignored them would send the operator back to a spreadsheet to do the filtering
 * again. */
$('#acct-download').addEventListener('click', () => {
  const rows = shownAccountRows();
  if (!rows.length) { toast('Nothing to download.', 'info'); return; }
  const tsv = ['handle\tname\tcategory\tbio\tfollowers\tdm_open']
    .concat(rows.map(r => [
      r.handle,
      r.name || '',
      r.category || '',
      String(r.bio || '').replace(/\s+/g, ' ').trim(),
      r.followers ?? '',
      r.dm_open ? 'yes' : 'no',
    ].join('\t')))
    .join('\n');
  const key = $('#acct-roster').value || 'all-targets';
  const cat = $('#acct-cat').value;
  downloadText(`${key}${cat && cat !== '__none__' ? '-' + cat.toLowerCase().replace(/ /g, '-') : ''}.tsv`, tsv);
});

$('#acct-minio-load').addEventListener('click', async e => {
  await importFromMinio(e.currentTarget);
  if (typeof loadAccountsData === 'function') loadAccountsData();
  else $('#acct-reload').click();
});

/* Send to the bucket what is ON SCREEN, which is the same rule the download
 * beside it follows — the pickers are how a useful export gets built.
 *
 * One call with a list of handles, not one call per sweep: the panel reads the
 * store now, and most of what it lists belongs to no sweep still on file. The
 * server sends its own copy of the rows named, so the bucket stays a record of
 * what was collected rather than of what some tab was displaying. */
$('#acct-minio').addEventListener('click', async e => {
  const rows = shownAccountRows();
  if (!rows.length) { toast('Nothing to send.', 'info'); return; }

  const picked = $('#acct-roster').value;
  setBusy(e.currentTarget, true);
  try {
    const sent = await api('/api/store/accounts/minio', {
      method: 'POST',
      body: {
        handles: rows.map(r => r.handle),
        // Names the object after what was picked, so a bucket of dated files
        // still says what each one was.
        name: picked ? `store-${picked}` : 'store',
        source: picked || 'account store',
      },
    });
    const added = sent.new || 0;
    const skipped = sent.skipped || 0;
    toast(added
      ? `Sent ${added} new to ${sent.bucket}` + (skipped ? ` — ${skipped} already there` : '')
      : `Nothing new — all ${skipped} handles are already in ${sent.bucket}`,
      added ? 'ok' : 'info');
  } catch (err) {
    toast(err.message, 'error');
  } finally { setBusy(e.currentTarget, false); }
});

/* Delete a saved SWEEP — the record of one walk, not the handles it found.
 *
 * Picked by target name, because that is what the picker holds now, and a target
 * can have more than one sweep on file (its followers and its likers are two).
 * All of them go: the picker cannot tell them apart, so neither can this. */
$('#acct-drop').addEventListener('click', async () => {
  const target = $('#acct-roster').value;
  if (!target) return;
  const sweeps = dataRosters.filter(r => r.target === target);
  if (!sweeps.length) return;

  const what = sweeps.length === 1
    ? `the saved ${target} sweep`
    : `all ${sweeps.length} saved ${target} sweeps`;
  if (!confirm(`Delete ${what}? `
             + 'The accounts it found stay collected — this only removes the '
             + 'record of the walk.')) return;
  try {
    for (const sweep of sweeps) {
      await api(`/api/data/rosters/${encodeURIComponent(sweep.key)}`, { method: 'DELETE' });
    }
    loadCollected();
  } catch (err) { toast(err.message, 'error'); }
});

function downloadText(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/tab-separated-values' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}


/* ── Campaign ────────────────────────────────────────────────── */

/* ── The message drafts, as tabs ─────────────────────────────── */
/* The drafts are ALTERNATIVES — the sender rotates between them — so they are
 * versions of one message rather than six messages in an order, and six stacked
 * textareas said the opposite while making you scroll to reach the one you
 * meant. */

/* Two lists, one editor.
 *
 * `manual` is what you write here. `stored` is what the message store and the
 * `x-messages` bucket hold. They are kept apart rather than merged into one
 * list because the button above switches BETWEEN them: pressing Stored drafts
 * and pressing it again has to give you your own sentence back, not a list you
 * now have to pick your own draft out of.
 *
 * `list` is whichever is on screen. Everything below reads it without caring
 * which mode is on - and a run sends what is on screen, like every other list in
 * this console. */
const msgs = {
  manual: [],
  stored: [],
  mode: 'manual',
  dirty: false,
  // Which tab is open, remembered PER LIST. Switching to the stored drafts and
  // back should put you on the draft you were writing, mid-word - landing on
  // whichever one happens to be first is the same as losing your place.
  activeAt: { manual: -1, stored: -1 },
  get list() { return this.mode === 'stored' ? this.stored : this.manual; },
  set list(rows) {
    if (this.mode === 'stored') this.stored = rows; else this.manual = rows;
  },
  get active() { return this.activeAt[this.mode]; },
  set active(i) { this.activeAt[this.mode] = i; },
};

/* sms1, sms2, sms3 - the next number not already taken.
 *
 * Named rather than numbered by position: a draft keeps its name when the one
 * above it is deleted, and the live table shows that name against every
 * recipient who got it. Renumbering on delete would rewrite history. */
function nextDraftName() {
  const taken = new Set(msgs.list.map(d => d.name));
  for (let n = 1; ; n++) if (!taken.has(`sms${n}`)) return `sms${n}`;
}

/* The blank the step opens on: one draft, named, empty, ready to type into.
 * An editor showing nothing at all reads as a step that has not loaded. */
function blankDraft() {
  return { name: 'sms1', text: '', enabled: true };
}

function activeDraft() { return msgs.list[msgs.active] || null; }

function liveDrafts() { return msgs.list.filter(d => d.enabled && d.text.trim()); }

function setDrafts(rows, { dirty = false, select = -1 } = {}) {
  msgs.list = rows.map((r, i) => ({
    name: r.name || `sms${i + 1}`,
    text: r.text || '',
    enabled: r.enabled !== false,
  }));
  msgs.dirty = dirty;
  msgs.active = select >= 0 ? select : (msgs.list.length ? 0 : -1);
  renderDrafts();
}

/* The stored drafts, from both places they live.
 *
 * The `x-messages` bucket is the set shared with the other bots on this MinIO;
 * the local store is this console's copy. There is one list on screen and it has
 * to show everything, so the bucket is merged in rather than sitting behind a
 * button somebody has to know to press.
 *
 * The store's copy wins on a name clash: it is the one that has been edited
 * here. The bucket only ever ADDS drafts the store has not got - so a draft
 * deleted here and saved is gone from both, and does not walk back in on the
 * next load.
 *
 * The merge lands SEPARATELY, after the store's own drafts are already on
 * screen. MinIO is a network call with a three-second timeout, and a step that
 * showed nothing for three seconds every time it was opened - on a machine where
 * MinIO is simply not running - would be a worse trade than a list that fills in
 * a moment late. */
/* Open on a blank, and fetch what is stored in the background.
 *
 * The step opens ready to type - one draft, `sms1`, empty. What is already on
 * file is a different question, and it is behind the Stored drafts button
 * because opening this step to write a message should not mean reading eight you
 * wrote last month first.
 *
 * The fetch still runs now rather than on the button press, so pressing it is
 * instant. It fills `stored`, which nothing is looking at yet. */
async function loadDrafts() {
  if (!msgs.manual.length) msgs.manual = [blankDraft()];
  if (msgs.active < 0) msgs.active = 0;
  renderDrafts();
  loadStoredDrafts();
}

/* Everything on file, from both places it lives: the message store, and the
 * `x-messages` bucket shared with the other bots on this MinIO. The store's copy
 * wins on a name clash - it is the one that has been edited here - and the
 * bucket only ever adds names the store has not got. */
async function loadStoredDrafts() {
  let stored = [];
  try {
    const { drafts } = await api('/api/messages');
    stored = drafts || [];
  } catch (err) { toast(err.message, 'error'); }

  let fromMinio = 0;
  try {
    const { drafts } = await api('/api/messages/minio');
    const known = new Set(stored.map(d => d.name));
    const added = (drafts || []).filter(d => d.name && !known.has(d.name));
    fromMinio = added.length;
    stored = stored.concat(added);
  } catch (err) {
    // The console works without MinIO, but a messages file that is configured
    // and could not be read is worth one line - otherwise the insta drafts are
    // simply missing with nothing saying why.
    toast(`MinIO messages not loaded: ${err.message}`, 'warn');
  }

  msgs.stored = stored.map(d => ({
    name: d.name, text: d.text || '', enabled: d.enabled !== false,
  }));
  // The insta messages from MinIO are what the campaign is meant to send, so
  // they come up on their own - unless something has already been typed into
  // the blank draft, which is never swapped out from under the operator.
  const untouched = msgs.manual.every(d => !d.text.trim());
  if (fromMinio && msgs.mode === 'manual' && untouched) msgs.mode = 'stored';
  // Only redraw if that is what is on screen - a list arriving behind the
  // operator's back must not move the draft they are typing into.
  if (msgs.mode === 'stored') {
    if (msgs.active < 0 || msgs.active >= msgs.stored.length) {
      msgs.active = msgs.stored.length ? 0 : -1;
    }
    renderDrafts();
  } else {
    syncDraftCount();
  }
}

function renderDrafts() {
  syncDraftCount();
  paintDraftMode();
  const wrap = $('#drafts');
  const draft = activeDraft();
  wrap.innerHTML = `
    <div class="d-tabs">${msgs.list.map((d, i) => `
      <button class="d-tab ${i === msgs.active ? 'on' : ''} ${d.enabled ? '' : 'off'}"
              data-i="${i}"><i class="d-dot"></i>${escapeHtml(d.name)}</button>`).join('')}
    </div>
    ${draft ? `
    <div class="d-editor">
      <div class="row d-bar">
        <label class="d-rename">Name
          <input id="d-name" value="${escapeHtml(draft.name)}"></label>
        <label class="opt"><input type="checkbox" id="d-on" ${draft.enabled ? 'checked' : ''}>
          Use this one</label>
        <span class="d-state ${draft.enabled ? '' : 'is-off'}">${
          draft.enabled ? 'in rotation' : 'not sent'}</span>
        <div class="grow"></div>
        <button class="tiny danger" id="d-drop">
          <svg class="ic" viewBox="0 0 24 24"><use href="#i-trash"/></svg>Delete</button>
      </div>
      <div class="d-box">
        <textarea id="d-text" rows="7"
          placeholder="The DM. {name} and {handle} are filled in per recipient.">${
          escapeHtml(draft.text)}</textarea>
        <button class="d-import" id="d-import" title="Import drafts from a file">
          <svg class="ic" viewBox="0 0 24 24"><use href="#i-upload"/></svg></button>
      </div>
      <div class="d-foot muted">
        <span>${draft.text.length} characters</span>
        <span>${liveDrafts().length} of ${msgs.list.length} in rotation</span>
      </div>
    </div>` : `<p class="muted">${msgs.mode === 'stored'
        ? 'Nothing on file yet — write one and press <b>Save drafts</b>.'
        : 'No drafts — press <b>Add draft</b>.'}</p>`}`;
}

/* Which of the two lists is on screen, said on the button that switches them.
 *
 * The label is what pressing it DOES, not which mode you are in: a button
 * reading "Stored drafts" while you are looking at stored drafts is a button
 * whose press you cannot predict. */
function paintDraftMode() {
  const button = $('#draft-toggle');
  if (!button) return;
  const stored = msgs.mode === 'stored';
  button.setAttribute('aria-expanded', String(stored));
  button.classList.toggle('on', stored);
  button.title = stored
    ? 'Put these away and go back to what you were writing'
    : `Load the ${msgs.stored.length || ''} draft${
        msgs.stored.length === 1 ? '' : 's'} already on file`.replace('  ', ' ');
  button.querySelector('.lbl').textContent = stored ? 'Write my own' : 'Stored drafts';

  // The source tag says where the list on screen came from, which is the whole
  // difference between the two modes.
  const tag = $('#draft-src');
  if (tag) {
    tag.textContent = stored ? 'store · minio' : 'writing';
    tag.title = stored
      ? 'Read from the message store and the x-messages bucket'
      : 'Yours, until Save drafts writes it to the store and the bucket';
  }
}

function syncDraftCount() {
  const count = $('#draft-count');
  const inUse = liveDrafts().length;
  count.textContent = msgs.list.length
    ? `${inUse} of ${msgs.list.length} in rotation${msgs.dirty ? ' · unsaved' : ''}`
    : '';
  count.classList.toggle('is-dirty', msgs.dirty);
  $('#draft-save').classList.toggle('dirty', msgs.dirty);

  // The checklist's "A message" line and the rail's tick are answers about THIS
  // list, so they have to be recomputed whenever it changes - a letter typed, a
  // draft added, "Use this one" unticked, or the whole list swapped for the
  // stored one. They used to be refreshed only by Save and by opening Status,
  // so eight drafts could be sitting in rotation with the step still reading
  // "write at least one draft".
  //
  // Here rather than in `renderDrafts`, because the typing handler calls this
  // one directly and never redraws the editor under the cursor.
  renderChecklist();
}

$('#drafts').addEventListener('click', e => {
  const tab = e.target.closest('.d-tab');
  if (tab) { msgs.active = Number(tab.dataset.i); return renderDrafts(); }

  if (e.target.closest('#d-drop')) {
    msgs.list.splice(msgs.active, 1);
    msgs.active = Math.min(msgs.active, msgs.list.length - 1);
    msgs.dirty = true;
    return renderDrafts();
  }
  if (e.target.closest('#d-import')) $('#msg-file').click();
});

/* Typed edits go into the model on the way past, not on a Save press: switching
 * tabs must not be a way to lose the sentence you just wrote. */
$('#drafts').addEventListener('input', e => {
  const draft = activeDraft();
  if (!draft) return;
  if (e.target.id === 'd-text') draft.text = e.target.value;
  else if (e.target.id === 'd-name') draft.name = e.target.value;
  else if (e.target.id === 'd-on') { draft.enabled = e.target.checked; renderDrafts(); }
  msgs.dirty = true;
  syncDraftCount();
});

$('#draft-add').addEventListener('click', () => {
  msgs.list.push({ name: nextDraftName(), text: '', enabled: true });
  msgs.active = msgs.list.length - 1;
  msgs.dirty = true;
  renderDrafts();
});

/* Switch between what you are writing and what is on file.
 *
 * Neither list is destroyed by the switch - that is the point of keeping two.
 * Going to stored and back gives you your own sentence exactly as you left it,
 * mid-word if that is where you left it. */
$('#draft-toggle').addEventListener('click', () => {
  msgs.mode = msgs.mode === 'stored' ? 'manual' : 'stored';
  // A blank to type into, always. Switching back to an empty manual list would
  // otherwise leave the step with nothing on it.
  if (msgs.mode === 'manual' && !msgs.manual.length) msgs.manual = [blankDraft()];
  // Clamped, not reset: the remembered tab stands unless the list it pointed
  // into has since got shorter.
  if (msgs.active < 0 || msgs.active >= msgs.list.length) {
    msgs.active = msgs.list.length ? 0 : -1;
  }
  renderDrafts();
});

/* Save every draft and every edit, to both places they live.
 *
 * The store first and on its own: that is the copy a campaign actually sends
 * from, and it must not be held hostage to a MinIO that is switched off. The
 * bucket is written after, and a failure there is REPORTED rather than thrown -
 * the drafts are safe either way, and a red toast saying "not saved" over work
 * that was saved is the worse lie of the two. */
$('#draft-save').addEventListener('click', async e => {
  setBusy(e.currentTarget, true);
  try {
    // Empty drafts are not saved. Pressing Save on a step that opens with a
    // blank `sms1` must not replace eight real drafts on file with nothing.
    const drafts = msgs.list.filter(d => d.text.trim());
    if (!drafts.length) {
      toast('Nothing written yet.', 'info');
      return;
    }
    await api('/api/messages', { method: 'POST', body: { drafts } });
    msgs.dirty = false;
    // What was just written IS what is on file now, so the other list has to
    // agree - otherwise pressing Stored drafts would show the previous set.
    msgs.stored = drafts.map(d => ({ ...d }));
    syncDraftCount();
    renderChecklist();

    const n = drafts.length;
    try {
      const sent = await api('/api/messages/minio', { method: 'POST', body: { drafts } });
      toast(`Saved ${n} draft${n === 1 ? '' : 's'} — and to ${sent.bucket}`, 'ok');
    } catch (err) {
      toast(`Saved ${n} draft${n === 1 ? '' : 's'}. MinIO: ${err.message}`, 'warn');
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally { setBusy(e.currentTarget, false); }
});

/* ── The campaign's own settings ─────────────────────────────── */

/* Grouped the way the operator thinks about a send rather than as the flat key
 * list the Settings panel shows. The same stored values, written through the
 * same endpoint, so the two can never drift apart. */
/* The scraping cog: the few settings a walk is actually run with, on the panel
 * that runs it. Written through /api/settings like every other setting, so the
 * Settings panel can never drift from it. */
const SCR_COG_NAMES = {
  scrape_group_tabs: 'Groups at once (tabs)',
  scrape_group_members_max: 'Most people per group',
  scrape_group_scroll_smooth: 'Scroll smoothly',
  scrape_group_scroll_seconds: 'Seconds between scrolls',
  scrape_group_scroll_step: 'How far each scroll (screens)',
  scroll_pause_min: 'Scroll pause (shortest)',
  scroll_pause_max: 'Scroll pause (longest)',
  scrape_stall_seconds: 'Reload after quiet',
  scrape_followers_max: 'Followers per profile (0 = whole list)',
  skip_no_dm: 'Only accounts that take messages',
};

const SCR_COG = [
  { title: 'FB Groups', keys: ['scrape_group_tabs', 'scrape_group_members_max',
                               'scrape_group_scroll_smooth', 'scrape_group_scroll_seconds',
                               'scrape_group_scroll_step'],
    help: 'Tabs read several groups at the same time in the account\'s own window '
        + '— one group is mostly waiting for Bluesky to send the next page of '
        + 'members. As a tab finishes its group it opens the next one.' },
  { title: 'Pacing', keys: ['scroll_pause_min', 'scroll_pause_max', 'scrape_stall_seconds'] },
  { title: 'Who is kept', keys: ['skip_no_dm'],
    help: 'On, a scrape stores only profiles whose chat is open to this account - '
        + 'anyone may message them, or they follow this account. The rest are '
        + 'counted on the account\'s tab and left out.' },
  { title: 'Followers', keys: ['scrape_followers_max'],
    help: 'Each profile\'s followers list is read to its end before the walk goes back to Home. Set a number to stop at that many per profile instead.' },
];

$('#scr-cog').addEventListener('click', async () => {
  try {
    const { settings, schema } = await api('/api/settings');
    const byKey = Object.fromEntries(schema.map(r => [r.key, r]));
    $('#scr-cog-body').innerHTML = SCR_COG.map(group => `
      <div class="cog-group">
        <h3>${escapeHtml(group.title)}</h3>
        ${group.help ? `<div class="cog-help">${escapeHtml(group.help)}</div>` : ''}
        ${cogRows(group, byKey, settings)}
      </div>`).join('');
    $('#scr-cog-box').showModal();
  } catch (err) { toast(err.message, 'error'); }
});

$('#scr-cog-close').addEventListener('click', () => $('#scr-cog-box').close());

$('#scr-cog-body').addEventListener('change', async e => {
  const input = e.target.closest('input[data-key]');
  if (!input) return;
  const foot = $('#scr-cog-foot');
  try {
    await api('/api/settings', { method: 'POST',
      body: { [input.dataset.key]: input.type === 'checkbox' ? input.checked : input.value } });
    foot.textContent = 'Saved.';
    foot.className = 'live-foot ok';
  } catch (err) {
    foot.textContent = err.message;
    foot.className = 'live-foot bad';
  }
});

const COG_GROUPS = [
  { title: 'Sending', keys: ['click_send'],
    help: 'The one switch that decides whether a run talks to anybody. On, a run '
        + 'sends. Off, it types each message and leaves it in the composer - the '
        + 'dry run to do first.' },
  { title: 'Pacing', keys: ['gap_min_seconds', 'gap_max_seconds', 'typing_wpm', 'typing_slips'],
    help: 'A constant gap between messages is a metronome, and a metronome is the '
        + 'easiest thing to spot in a request log. The same goes for typing that '
        + 'never misses a key: with slips on, every few words a wrong letter goes '
        + 'in, gets backspaced, and is typed again.' },
  { title: 'Caps', keys: ['daily_dm_cap', 'per_account_dm_cap'],
    help: 'Bluesky counts messages per account per day. Going past its limit is '
        + 'what gets an account stopped from starting new conversations.' },
  { title: 'Breaks', keys: ['batch_min_messages', 'batch_max_messages',
                            'break_min_minutes', 'break_max_minutes', 'break_actions'],
    help: 'Each account takes a break after a number of messages rolled from the '
        + 'first range, for a length rolled from the second - both rolled again for '
        + 'every break, so none of them fall or last alike. During it the account\'s window presses a few of the '
        + 'Actions panel\'s rail items, drawn at random for that break (Home, '
        + 'Explore, Profile and so on - never Compose), and the rest of the '
        + 'break is waited out before sending goes on. Every break is planned '
        + 'when the campaign starts and shown in the live table.' },
  { title: 'Bluesky actions',
    keys: ['actions_min_messages', 'actions_max_messages',
           'actions_min_items', 'actions_max_items',
           'actions_min_rest_minutes', 'actions_max_rest_minutes'],
    help: 'Every so many messages - rolled from the first range, and rolled again '
        + 'each time - each account presses a few of its Bluesky rail items '
        + '(Chats, Marketplace, Requests, Archive, the settings menu, the sidebar) '
        + 'in its own window, then the run rests before the next message. How many '
        + 'items and how long a rest are rolled from the other two ranges. Every '
        + 'turn is planned when the campaign starts and shown in the live table. '
        + '0 to 0 messages turns it off.' },
  { title: 'Targeting', keys: ['chat_open_seconds'] },
  { title: 'Pictures', keys: ['media_via_post'],
    help: 'Bluesky chat cannot carry a picture, so a campaign sends text only. Turn '
        + 'this on only if you want each dealt picture PUBLISHED AS A PUBLIC POST from '
        + 'the sending account first, with that post placed above the message in each chat.' },
  { title: 'Tabs', keys: ['parallel_tabs', 'close_tab_after_send'],
    help: 'Leaving the tabs open costs memory - one Chromium tab per recipient - '
        + 'and buys the run being readable afterwards: the chats it wrote to are '
        + 'still on the window, in order.' },
  { title: 'Who is skipped', keys: ['skip_no_dm', 'skip_protected'],
    help: 'Recipients a run passes over without opening a chat: accounts whose '
        + 'chat is closed to this account, and protected accounts.' },
  { title: 'Safety', keys: ['stop_on_challenge', 'campaign_auto_restart',
                            'campaign_stall_minutes', 'campaign_max_restarts'],
    help: 'The run is written to disk as it goes. If it crashes, stalls, or the '
        + 'server goes down, it picks itself up from the first recipient it had '
        + 'not reached - what was sent stays sent.' },
];

const COG_NAMES = {
  gap_min_seconds: 'Gap between messages', gap_max_seconds: 'Gap between messages',
  typing_wpm: 'Typing speed (wpm)', typing_slips: 'Slip and correct while typing',
  daily_dm_cap: 'Messages per day, all accounts',
  per_account_dm_cap: 'Messages per day, each account',
  batch_min_messages: 'Break after this many messages', batch_max_messages: 'Break after this many messages',
  break_min_minutes: 'Break length (min)', break_max_minutes: 'Break length (min)',
  break_actions: 'Actions per break',
  actions_min_messages: 'Press the rail after this many messages',
  actions_max_messages: 'Press the rail after this many messages',
  actions_min_items: 'Items pressed per turn',
  actions_max_items: 'Items pressed per turn',
  actions_min_rest_minutes: 'Rest after pressing (min)',
  actions_max_rest_minutes: 'Rest after pressing (min)',
  chat_open_seconds: 'Hold an opened chat (sec)',
  parallel_tabs: 'Chats open at once, per account',
  close_tab_after_send: 'Close the tab after sending',
  stop_on_challenge: 'Stop on a captcha or challenge',
  campaign_auto_restart: 'Restart by itself if it stops or sticks',
  click_send: 'Click Send (off = type only)',
  media_via_post: 'Publish pictures as a post and embed it (off = text only)',
  skip_no_dm: 'Skip accounts whose chat is closed', skip_protected: 'Skip protected accounts',
  groups_visit_direct: 'Open groups by their address',
  groups_visit_gap_min: 'Rest between groups (min)', groups_visit_gap_max: 'Rest between groups (min)',
  campaign_stall_minutes: 'Treat as stuck after no progress for (min)',
  campaign_max_restarts: 'Restarts before it waits for Resume',
  scrape_stall_seconds: 'Reload after no new handle for (sec)',
};

let cogSchema = null;

$('#camp-cog').addEventListener('click', openCampCog);
$('#camp-cog-close').addEventListener('click', () => $('#camp-cog-box').close());

async function openCampCog() {
  try {
    const { settings, schema } = await api('/api/settings');
    cogSchema = schema;
    const byKey = Object.fromEntries(schema.map(r => [r.key, r]));

    $('#camp-cog-body').innerHTML = COG_GROUPS.map(group => `
      <div class="cog-group">
        <h3>${escapeHtml(group.title)}</h3>
        ${group.help ? `<div class="cog-help">${escapeHtml(group.help)}</div>` : ''}
        ${cogRows(group, byKey, settings)}
      </div>`).join('');

    $('#camp-cog-box').showModal();
  } catch (err) { toast(err.message, 'error'); }
}

function cogRows(group, byKey, settings) {
  const out = [];
  const seen = new Set();
  for (const key of group.keys) {
    if (seen.has(key) || !byKey[key]) continue;
    // A min/max pair on one line: side by side with a dash between them they
    // read as the range a value is rolled from, which two stacked rows never
    // did.
    const pair = key.includes('_min_') && group.keys.includes(key.replace('_min_', '_max_'));
    if (pair) {
      const high = key.replace('_min_', '_max_');
      seen.add(key); seen.add(high);
      out.push(`
        <div class="cog-row">
          <span class="cog-k">${escapeHtml(COG_NAMES[key] || SCR_COG_NAMES[key] || key)}</span>
          <span class="cog-span">
            <input type="number" data-key="${key}" value="${settings[key]}">
            <span class="cog-dash">–</span>
            <input type="number" data-key="${high}" value="${settings[high]}">
          </span>
          <span class="cog-help">${escapeHtml(byKey[key].help || '')}</span>
        </div>`);
      continue;
    }
    seen.add(key);
    const row = byKey[key];
    out.push(`
      <div class="cog-row">
        <span class="cog-k">${escapeHtml(COG_NAMES[key] || SCR_COG_NAMES[key] || key)}</span>
        ${row.type === 'bool'
          ? `<input type="checkbox" data-key="${key}" ${settings[key] ? 'checked' : ''}>`
          : row.type === 'text'
          ? `<input type="text" spellcheck="false" data-key="${key}" value="${escapeHtml(String(settings[key] ?? ''))}">`
          : `<input type="number" step="any" data-key="${key}" value="${settings[key]}">`}
        <span class="cog-help">${escapeHtml(row.help || '')}</span>
      </div>`);
  }
  return out.join('');
}

/* Saved as they change, not behind an OK: this panel is opened mid-setup and
 * closed by clicking off it, and a value that only lands on a button nobody
 * pressed is a value that quietly did not apply. */
$('#camp-cog-body').addEventListener('change', async e => {
  const input = e.target.closest('input[data-key]');
  if (!input) return;
  const value = input.type === 'checkbox' ? input.checked : input.value;
  try {
    const { settings } = await api('/api/settings', { method: 'POST', body: { [input.dataset.key]: value } });
    setCogFoot('Saved.', 'ok');
    if (input.dataset.key === 'click_send' && settings) paintClickSend(settings.click_send);
  } catch (err) { setCogFoot(err.message, 'bad'); }
});

/* Group Posting's own settings, the same dialog shape as Campaign's. */
const GRP_COG = [
  { title: 'Visiting groups',
    keys: ['groups_visit_direct', 'groups_visit_gap_min', 'groups_visit_gap_max'],
    help: 'Whether each group is reached by its address rather than by pressing '
        + 'its name in the list, and how long the walk rests between one and the next.' },
];

$('#grp-cog').addEventListener('click', async () => {
  try {
    const { settings, schema } = await api('/api/settings');
    const byKey = Object.fromEntries(schema.map(r => [r.key, r]));
    $('#grp-cog-body').innerHTML = GRP_COG.map(group => `
      <div class="cog-group">
        <h3>${escapeHtml(group.title)}</h3>
        ${group.help ? `<div class="cog-help">${escapeHtml(group.help)}</div>` : ''}
        ${cogRows(group, byKey, settings)}
      </div>`).join('');
    $('#grp-cog-box').showModal();
  } catch (err) { toast(err.message, 'error'); }
});
$('#grp-cog-close').addEventListener('click', () => $('#grp-cog-box').close());
$('#grp-cog-body').addEventListener('change', async e => {
  const input = e.target.closest('input[data-key]');
  if (!input) return;
  const foot = $('#grp-cog-foot');
  try {
    await api('/api/settings', { method: 'POST',
      body: { [input.dataset.key]: input.type === 'checkbox' ? input.checked : input.value } });
    foot.textContent = 'Saved.'; foot.className = 'live-foot ok';
  } catch (err) { foot.textContent = err.message; foot.className = 'live-foot bad'; }
});

/* Every key a panel's own gear shows. The Settings panel leaves these out
 * rather than filing them under "Other": one place to change a value, not two
 * that can disagree about what was saved last. */
function panelFiledKeys() {
  const keys = new Set();
  for (const groups of [COG_GROUPS, SCR_COG, GRP_COG]) {
    for (const g of groups) for (const k of g.keys) keys.add(k);
  }
  return keys;
}

function setCogFoot(text, tone) {
  const foot = $('#camp-cog-foot');
  foot.textContent = text;
  foot.className = `live-foot ${tone || 'muted'}`;
}

/* ── The wizard's rail ───────────────────────────────────────── */

$('#camp-steps').addEventListener('click', e => {
  const button = e.target.closest('button[data-step]');
  if (button) showStep(button.dataset.step);
});

function showStep(name) {
  $$('#camp-steps button').forEach(b => b.classList.toggle('on', b.dataset.step === name));
  $$('.step').forEach(s => s.classList.toggle('on', s.dataset.step === name));
  // Only re-read the store if the list is the half of the step being shown.
  // Opening step 2 to upload a file has no business loading 1,290 rows, and
  // used to set every one of them as a recipient on the way past.
  if (name === 'users' && storeListShowing()) loadStoredAccounts();
  if (name === 'messages') loadDrafts();
  if (name === 'media') loadMedia();
  if (name === 'status') renderChecklist();
}

/* ── Step 1 · Accounts ───────────────────────────────────────── */

/* What the Campaign live panel is showing: the lanes as last dealt or last
 * reported, which tab is on top, and the run's own state.
 *
 * Declared HERE, beside the rest of the campaign's state, rather than down at
 * the panel that draws it. `renderChecklist` reads `live.lanes` to decide
 * whether the Live button stays reachable, and it is defined hundreds of lines
 * earlier - a `const` read before its own line is a TypeError that stops the
 * whole script, taking every listener below it with it. */
const live = { lanes: [], tab: 0, state: '', note: '', task: '' };

const camp = {
  picked: new Set(),      // the accounts a run sends from
  shown: null,            // the one whose session is on screen
  accounts: [],
  sessions: {},           // id -> session, as last read
  targets: [],            // the recipients a run sends TO
  media: new Set(),
  // Every picture in the library is ticked for the campaign by default, ONCE:
  // a picture seen for the first time joins the send, a picture the operator
  // unticked stays unticked through every reload after it.
  mediaOffered: new Set(),
  live: null,
  // Which open windows have already been offered, so "all picked by default"
  // means all picked ONCE. Without it, a poll five seconds later would put back
  // every account the operator had just unticked.
  offered: new Set(),
};

/* The accounts a campaign can send from: the ones with a browser window OPEN.
 *
 * Only those, because that is the only kind this step can use. `/campaign/start`
 * refuses a closed window outright - it would fail on every single recipient -
 * so an account listed here with no window is a tile whose only possible outcome
 * is an error message. Opening a window is done on the Accounts panel, which is
 * where the empty state below points.
 *
 * And all of them ticked. Somebody who has opened three windows has already said
 * which accounts this campaign is for; making them say it again by clicking
 * three tiles is asking the same question twice. */
function renderAccountPicker(accounts, byId) {
  camp.accounts = accounts;
  camp.sessions = byId;
  const wrap = $('#camp-accounts');
  if (!wrap) return;

  const open = accounts.filter(a => (byId[a.id] || {}).active);
  const openIds = new Set(open.map(a => String(a.id)));

  // Ticked on arrival, ONCE each. A window opened while this step is on screen
  // joins the send; one unticked by hand stays unticked, because `offered`
  // remembers that it has already been asked about.
  for (const id of openIds) {
    if (!camp.offered.has(id)) { camp.offered.add(id); camp.picked.add(id); }
    if (busyLabel(id)) camp.picked.delete(id);
  }
  // A window that has since closed is not a choice any more - drop it from both,
  // so re-opening it counts as a fresh offer and ticks itself again.
  camp.offered = new Set([...camp.offered].filter(id => openIds.has(id)));
  camp.picked = new Set([...camp.picked].filter(id => openIds.has(id)));

  wrap.innerHTML = open.map(a => {
    const s = byId[a.id] || {};
    const on = camp.picked.has(String(a.id));
    const busy = busyLabel(a.id);
    return `
      <button class="acct ${on ? 'on' : ''} ${camp.shown === String(a.id) ? 'shown' : ''}${busy ? ' busy' : ''}"
              data-id="${a.id}" ${busy ? `title="Busy with ${escapeHtml(busy)} — stop that first"` : ''}>
        <span class="acct-tick"><svg class="ic" viewBox="0 0 24 24"><use href="#i-check"/></svg></span>
        <span class="dot ${s.logged_in ? 'ok' : (s.active ? 'warn' : 'off')}"></span>
        <span class="acct-text">
          <span class="acct-name">${escapeHtml(a.label || at(a.login))}</span>
          <span class="acct-state">${busy ? `<b class="bad">busy with ${escapeHtml(busy)}</b>` : statusLine(s)}</span>
        </span>
      </button>`;
  }).join('') || campAccountGate(accounts.length);

  // Whichever tile is being LOOKED at has to be one that is on screen.
  if (!openIds.has(camp.shown)) camp.shown = open.length ? String(open[0].id) : null;

  renderCampSession();
  renderChecklist();
}

/* Nothing to send from. Two different reasons, and they need different answers:
 * accounts exist but none is open, or there are no accounts at all. */
function campAccountGate(total) {
  return `
    <div class="gate">
      <span class="gate-ic"><svg class="ic" viewBox="0 0 24 24"><use href="#i-login"/></svg></span>
      <div class="gate-text">
        <strong>${total ? 'No browser window is open' : 'No accounts yet'}</strong>
        <span>${total
          ? `A campaign sends through a window that is already up — a run against
             a closed one fails on every recipient. Go to <b>Accounts</b> and press
             the open icon
             <svg class="ic gate-hint-ic" viewBox="0 0 24 24"><use href="#i-external"/></svg>
             on the accounts you want to send from; they appear here, ticked.`
          : 'Add one on the Accounts panel, then open a window on it.'}</span>
      </div>
      <div class="grow"></div>
      <button class="primary" id="camp-open-accounts">
        <svg class="ic" viewBox="0 0 24 24"><use href="#i-user"/></svg>Go to Accounts</button>
    </div>`;
}

$('#camp-accounts').addEventListener('click', e => {
  if (e.target.closest('#camp-open-accounts')) return showPanel('accounts');

  const tile = e.target.closest('.acct[data-id]');
  if (!tile) return;
  const id = tile.dataset.id;
  if (tile.classList.contains('busy')) {
    toast(`${tile.querySelector('.acct-name').textContent} is busy with ${busyLabel(id)} — stop that first.`, 'info');
    return;
  }
  if (camp.picked.has(id)) camp.picked.delete(id); else camp.picked.add(id);
  camp.shown = id;
  tile.classList.toggle('on', camp.picked.has(id));
  $$('#camp-accounts .acct').forEach(t => t.classList.toggle('shown', t.dataset.id === id));
  renderChecklist();
  renderCampSession();
});

/* The session behind the tile you are LOOKING at — not the set you have picked.
 * Which accounts a run sends from and which one's session is on screen are two
 * different questions, and answering them with one highlight made the card
 * change under the operator every time they added an account to the set. */
function renderCampSession() {
  const card = $('#camp-session');
  const account = camp.accounts.find(a => String(a.id) === String(camp.shown));
  if (!account) {
    card.innerHTML = '<span class="muted">Pick an account to see its session.</span>';
    return;
  }
  const s = camp.sessions[account.id] || {};
  card.innerHTML = [
    ['Account', escapeHtml(account.label || at(account.login))],
    ['Handle', escapeHtml(at(account.login))],
    ['Email', escapeHtml(account.email || '—')],
    // The two the card above has no room for. "Signed in as" is the browser's
    // answer rather than the operator's — the row it disagrees with the Handle
    // line on is the one worth catching before a send.
    ['Signed in as', s.as_handle
      ? `<span class="${s.mismatch ? 'bad' : ''}">${escapeHtml(at(s.as_handle))}</span>`
      : '—'],
    ['Last checked', (() => {
      const seen = ago(s.checked_at);
      if (!seen) return '—';
      return seen.days >= SESSION_STALE_DAYS
        ? `<span class="warn">${seen.text}</span>` : seen.text;
    })()],
    ['Session', statusLine(s)],
    ['Expires', s.expires_at ? new Date(s.expires_at).toLocaleString() : '—'],
  ].map(([k, v]) => `
    <div class="field"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');
}

/* Which accounts have a browser window up. The campaign does not need one to be
 * open — a stored session is enough to send — so this is context rather than a
 * gate, which is exactly why it is a quiet strip and not the Scraping panel's
 * blocking box. */
/* How the recipients will be split, before the run rather than after. */
$('#camp-check').addEventListener('click', async e => {
  setBusy(e.currentTarget, true);
  try {
    const result = await api('/api/accounts/sessions/check', { method: 'POST' });
    showInfo('camp-login-info', `${result.logged_in}/${result.checked} logged in`, 'ok');
    loadAccounts();
  } catch (err) {
    showInfo('camp-login-info', err.message, 'bad');
  } finally { setBusy(e.currentTarget, false); }
});

$('#camp-login').addEventListener('click', async e => {
  if (!camp.picked.size) return showInfo('camp-login-info', 'Pick an account first.', 'bad');
  setBusy(e.currentTarget, true);
  try {
    // One at a time with a randomised gap: a burst of simultaneous logins from
    // one IP is the clearest signal that a set of accounts belongs together.
    const { task } = await api('/api/accounts/login',
                               { method: 'POST', body: { ids: [...camp.picked] } });
    watchTask(task, { onDone: () => { loadAccounts(); showInfo('camp-login-info', 'Done.', 'ok'); } });
  } catch (err) {
    showInfo('camp-login-info', err.message, 'bad');
  } finally { setBusy(e.currentTarget, false); }
});

/* ── Step 2 · The scraped accounts, out of the store ─────────── */

/* The rail down the right of this step is a QUESTION being composed; `applied`
 * is the answer the table is currently showing. Nothing moves as a control is
 * touched — a category, a send-count and a row range are one question asked
 * together, and a list that re-cut itself between them would make the row
 * numbers the range counts in a moving target. OK is what commits. */
const store = { rows: [], loaded: false, applied: null };

/* Categorised only is OFF, and on Bluesky it has to be.
 *
 * It used to default ON, on the reasoning that this step aims a campaign at a
 * KIND of account and a handle whose bio said nothing is one nothing can be said
 * about. That reasoning came from X, where a profile carries a bio. Bluesky
 * has no bio surface at all - a chat-list row is a handle, a name and whether it
 * is a group, and `classify.py` has nothing to read - so every Bluesky handle
 * is uncategorised and this switch hid ALL of them. Pressing Database on a store
 * with eight handles in it showed an empty table, which reads as a broken panel
 * rather than as a filter doing its job.
 *
 * `applyChatUsersFilter` below had to turn it off by hand for exactly this
 * reason. That is the tell: a default every path has to undo is the wrong
 * default. The switch stays on the rail for a store that DOES have bios in it. */
const blankFilter = () => ({
  q: '', category: '', target: '',
  openOnly: false, catOnly: false,
  times: [],                          // empty asks for any number of sends
  range: null,
});

/* How many DMs a handle has already had out of here, in the buckets anyone
 * actually asks for. Ticked rather than picked: "never, or once" is the ordinary
 * second pass over a list, and one dropdown could only ask for one of them.
 *
 * The last bucket is open-ended on purpose — past four sends the exact number
 * has stopped being a thing to filter on and started being a warning. */
const SEND_BUCKETS = [
  { key: '0', label: 'Never', hit: n => n === 0 },
  { key: '1', label: 'Once',  hit: n => n === 1 },
  { key: '2', label: '2×',    hit: n => n === 2 },
  { key: '3', label: '3×',    hit: n => n === 3 },
  { key: '4', label: '4×',    hit: n => n === 4 },
  { key: '5', label: '5+',    hit: n => n >= 5 },
];

/* Sends, not a flag. The server tallies them, but a store written before it did
 * knows only yes/no — and a row marked messaged with no tally is worth one send,
 * which is the truth as far as anything recorded it. */
function sentCount(row) {
  return Number(row.msg_count || 0) || (row.messaged ? 1 : 0);
}

/* Which half of this step is on screen: the file you are bringing, or the list
 * already collected. Exactly one at a time.
 *
 * Leaving the list clears the recipients with it. `camp.targets` is not a cache
 * of the store - it is the answer to "who is this run sending to", and the only
 * honest answer while the list is off screen is nobody. */
function showUsersView(which) {
  const onStore = which === 'store';
  $('#users-upload-card').hidden = onStore;
  $('#users-store-card').hidden = !onStore;
  if (!onStore) {
    camp.targets = [];
    renderChecklist();
  }
}

function storeListShowing() {
  const card = $('#users-store-card');
  return !!card && !card.hidden;
}

$('#users-database').addEventListener('click', () => {
  showUsersView('store');
  loadStoredAccounts();
});

/* The bucket's handles and bios, into the store. Imported rather than shown
 * beside it: a campaign draws from the store, and a second list on screen
 * that a run could not send to would be a list to be misled by. */
async function importFromMinio(button) {
  if (button) setBusy(button, true);
  try {
    const got = await api('/api/store/accounts/minio/import', { method: 'POST' });
    toast(got.added
      ? `${got.added} new from ${got.bucket}` + (got.refreshed ? ` — ${got.refreshed} bios filled in` : '')
      : `Nothing new — all ${got.total} handles in ${got.bucket} are already in the store`,
      got.added ? 'ok' : 'info');
    store.loaded = false;
    return true;
  } catch (err) {
    toast(err.message, 'error');
    return false;
  } finally { if (button) setBusy(button, false); }
}

$('#users-minio').addEventListener('click', async e => {
  const ok = await importFromMinio(e.currentTarget);
  showUsersView('store');
  await loadStoredAccounts(true);
  if (ok) {
    // Straight to what was just brought in, the way an upload lands.
    $('#store-cat-only').checked = false;
    const minio = [...$('#store-cat').options].some(o => o.value === 'minio');
    if (minio) $('#store-cat').value = 'minio';
    applyFilters();
  }
});
$('#users-upload-back').addEventListener('click', () => showUsersView('upload'));

async function loadStoredAccounts(force = false) {
  if (store.loaded && !force) return renderStoredAccounts();
  try {
    const { rows } = await api('/api/store/accounts');
    store.rows = rows;
    store.loaded = true;
    // A reload must not silently widen what a run is about to send to, so the
    // committed filter survives it. Only the very first load sets one.
    if (!store.applied) store.applied = blankFilter();
    renderSendBuckets();
    renderTargetFilter();
    renderCategoryFilter();
    renderStoredAccounts();
  } catch (err) { toast(err.message, 'error'); }
}

$('#store-reload').addEventListener('click', () => loadStoredAccounts(true));

$('#store-names').addEventListener('click', async e => {
  setBusy(e.currentTarget, true);
  try {
    const { filled } = await api('/api/store/accounts/names', { method: 'POST' });
    toast(`Filled in ${filled} name${filled === 1 ? '' : 's'}`, 'ok');
    loadStoredAccounts(true);
  } catch (err) {
    toast(err.message, 'error');
  } finally { setBusy(e.currentTarget, false); }
});

/* The send-count buckets, drawn once. Each carries how many of the store it
 * would match, because "already messaged 3 times" is worth ticking only when
 * somebody has been. */
function renderSendBuckets() {
  const box = $('#store-times');
  if (!box) return;
  const picked = new Set([...box.querySelectorAll('input:checked')].map(i => i.value));
  box.innerHTML = SEND_BUCKETS.map(b => {
    const n = store.rows.filter(r => b.hit(sentCount(r))).length;
    return `<label class="sf-chip${n ? '' : ' empty'}">
      <input type="checkbox" value="${b.key}"${picked.has(b.key) ? ' checked' : ''}>
      <span>${b.label}</span><i>${n}</i></label>`;
  }).join('');
}

/* The targets these accounts were scraped off — where they came FROM. */
function renderTargetFilter() {
  const names = [...new Set(store.rows.flatMap(r => r.targets || []))].sort();
  const select = $('#store-cat');
  const keep = select.value;
  select.innerHTML = '<option value="">All targets</option>'
    + names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  select.value = names.includes(keep) ? keep : '';
}

/* What the bios say these accounts ARE. Only the labels actually present, each
 * with its count: an option matching nothing is an option that wastes a click,
 * and the counts are how an operator picks which category is worth a campaign. */
function renderCategoryFilter() {
  const select = $('#store-category');
  if (!select) return;
  const keep = select.value;
  const seen = new Map();
  for (const row of store.rows) {
    if (row.category) seen.set(row.category, (seen.get(row.category) || 0) + 1);
  }
  const options = [...seen.entries()].sort((a, b) => b[1] - a[1]);
  select.innerHTML = '<option value="">Any category</option>'
    + options.map(([cat, n]) =>
        `<option value="${escapeHtml(cat)}">${escapeHtml(cat)} (${n})</option>`).join('');
  select.value = seen.has(keep) ? keep : '';
}

/* What the rail is asking for right now, committed or not. */
function pendingFilter() {
  return {
    q: $('#store-search').value.trim().toLowerCase(),
    category: $('#store-category').value,
    target: $('#store-cat').value,
    openOnly: $('#store-open-dm').checked,
    catOnly: $('#store-cat-only').checked,
    times: [...$('#store-times').querySelectorAll('input:checked')].map(i => i.value),
    range: readRange(),
  };
}

/* Null when neither box has a number in it — an empty range is "all of them",
 * not row zero. One end on its own is open at the other. */
function readRange() {
  const from = Number($('#store-from').value) || 0;
  const to = Number($('#store-to').value) || 0;
  return from || to ? [Math.max(1, from || 1), to || Infinity] : null;
}

/* Everything one filter leaves standing, before its range is applied. */
function matching(filter) {
  const buckets = SEND_BUCKETS.filter(b => filter.times.includes(b.key));
  return store.rows.filter(r => {
    if (filter.catOnly && !r.category) return false;
    if (filter.category && r.category !== filter.category) return false;
    if (filter.openOnly && !r.dm_open) return false;
    if (filter.target && !(r.targets || []).includes(filter.target)) return false;
    if (buckets.length && !buckets.some(b => b.hit(sentCount(r)))) return false;
    if (!filter.q) return true;
    return [r.handle, r.name, r.bio, r.category]
      .some(v => String(v || '').toLowerCase().includes(filter.q));
  });
}

function shownAccounts() {
  return matching(store.applied || blankFilter());
}

/* Ticking 200 of 291 by hand is not a thing anybody does, so there are no ticks:
 * the range IS the selection, and what is on screen is who gets messaged. */
function listedAccounts() {
  const all = shownAccounts();
  const range = (store.applied || {}).range;
  if (!range) return all;
  const [from, to] = range;
  return all.slice(from - 1, to === Infinity ? undefined : to);
}

function renderStoredAccounts() {
  const rows = listedAccounts();
  // ONLY while the list is actually on screen.
  //
  // Merely opening step 2 used to set this to every row in the store - 360 of
  // them - while the operator was still looking at the upload dropzone. The step
  // ticked itself, the checklist said "360 on the list", and Start would have
  // sent to all of them without the list ever having been seen. A recipient set
  // nobody has looked at is the one thing this step exists to prevent.
  camp.targets = storeListShowing() ? rows : [];

  const all = shownAccounts().length;
  const range = (store.applied || {}).range;
  $('#store-count').textContent = range
    ? `${rows.length} of ${all} shown · ${store.rows.length} stored`
    : `${all} shown · ${store.rows.length} stored`;

  // Why the table is shorter than the store is, said under the switch doing it.
  // An operator who has just uploaded four hundred bare handles and sees an
  // empty table needs the reason next to the thing that undoes it, not up in
  // the heading.
  const uncategorised = store.rows.filter(r => !r.category).length;
  const note = $('#store-hidden-note');
  note.hidden = !((store.applied || {}).catOnly && uncategorised);
  note.textContent = `${uncategorised} handle${uncategorised === 1 ? '' : 's'} `
    + `hidden — nothing in the bio to go on.`;

  const offset = range ? range[0] : 1;
  const body = $('#store-table tbody');
  body.innerHTML = rows.length ? rows.map((r, i) => `
    <tr>
      <td class="c-n">${offset + i}</td>
      <td>
        <span class="who-text">
          <span class="m-name ${r.name ? '' : 'none'}">${escapeHtml(r.name || 'no name yet')}</span>
          <a class="m-handle" href="${profileHref(r.handle)}"
             target="_blank" rel="noreferrer noopener">${escapeHtml(at(r.handle))}</a>
        </span>
      </td>
      <td class="c-cat">${catCell(r)}</td>
      <td class="c-cats">${(r.targets || []).map(t =>
        `<span class="tag">${escapeHtml(t)}</span>`).join(' ')}</td>
      <td class="c-groups" title="${escapeHtml(r.bio || '')}">${escapeHtml(truncate(r.bio, 70))}</td>
      <td class="c-dm">${dmBadge(r.dm_open)}</td>
      <td class="c-used">${sentCount(r)
        ? `<span class="st sent" title="Already messaged ${sentCount(r)} time${
             sentCount(r) === 1 ? '' : 's'}">${sentCount(r)}×</span>`
        : '<span class="st none">—</span>'}</td>
    </tr>`).join('')
    : `<tr class="note"><td colspan="7" class="muted">${
        store.rows.length
          ? 'Nothing matches those filters.'
          : 'Nothing stored yet — scrape a target, or upload a file.'}</td></tr>`;

  paintPending();
  renderChecklist();
}

/* Which fields of a filter each group on the rail owns, and how a shut one says
 * what it is set to. Two maps rather than one so the "is this group doing
 * anything" test stays a comparison against `blankFilter()` - add a filter and
 * the accent dot follows without a second rule to keep in step. */
const GROUP_FIELDS = {
  search: ['q'],
  category: ['category'],
  target: ['target'],
  times: ['times'],
  include: ['openOnly', 'catOnly'],
  rows: ['range'],
};

const GROUP_VALUE = {
  search: f => (f.q ? `“${f.q}”` : 'any'),
  category: f => f.category || 'any',
  target: f => f.target || 'all',
  times: f => (f.times.length
    ? SEND_BUCKETS.filter(b => f.times.includes(b.key)).map(b => b.label).join(', ')
    : 'any'),
  include: f => [f.openOnly && 'reachable', f.catOnly && 'categorised']
    .filter(Boolean).join(', ') || 'everyone',
  // Infinity is a real answer here - "from 340 on" - and reads better as 340+
  // than as a range with no end.
  rows: f => (f.range
    ? (f.range[1] === Infinity ? `${f.range[0]}+` : `${f.range[0]}–${f.range[1]}`)
    : 'all'),
};

/* Each group's summary line: what it is set to, and whether that is anything
 * other than the default.
 *
 * The value shows only while the group is SHUT. Open, the control below is
 * already saying it, and printing it twice made the summary read as a second
 * setting rather than as the same one. */
function paintGroupValues() {
  const pending = pendingFilter();
  const base = blankFilter();
  for (const group of $$('#store-filters .sf-group')) {
    const fields = GROUP_FIELDS[group.dataset.group] || [];
    const set = fields.some(k =>
      JSON.stringify(pending[k]) !== JSON.stringify(base[k]));
    group.classList.toggle('set', set);
    const slot = group.querySelector('.sf-value');
    if (slot) {
      slot.textContent = group.open ? '' : (GROUP_VALUE[group.dataset.group] || (() => ''))(pending);
    }
  }
}

/* Which groups the operator left open. Remembered for the same reason the
 * activity feed's own state is: somebody who folded away Target and Rows to get
 * at the category list wants them folded next time too.
 *
 * `toggle` does not bubble, so the listener is on the rail in the CAPTURE phase
 * rather than one listener per group - which would have to be re-bound every
 * time the rail is redrawn. */
const FILTER_GROUPS_KEY = 'x-bot.recipient-filters';

function restoreFilterGroups() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(FILTER_GROUPS_KEY) || '{}'); }
  catch { /* not fatal - the markup's own `open` stands */ }
  for (const group of $$('#store-filters .sf-group')) {
    const key = group.dataset.group;
    if (key in saved) group.open = !!saved[key];
  }
  paintGroupValues();
}

$('#store-filters').addEventListener('toggle', event => {
  if (!event.target.matches('.sf-group')) return;
  const state = {};
  for (const group of $$('#store-filters .sf-group')) state[group.dataset.group] = group.open;
  try { localStorage.setItem(FILTER_GROUPS_KEY, JSON.stringify(state)); }
  catch { /* not fatal - a fold is not worth breaking the panel over */ }
  // A group that just shut has to start saying what it holds, and one that just
  // opened has to stop.
  paintGroupValues();
}, true);

/* What OK would leave standing, answered as the rail is touched. Staged filters
 * with no preview are a guess followed by an undo. */
function paintPending() {
  const box = $('#store-pending');
  if (!box) return;
  const pending = pendingFilter();
  const total = matching(pending).length;
  const [from, to] = pending.range || [1, Infinity];
  const taken = pending.range
    ? Math.max(0, Math.min(total, to === Infinity ? total : to) - from + 1)
    : total;

  paintGroupValues();

  const applied = JSON.stringify(store.applied || blankFilter()) === JSON.stringify(pending);
  box.classList.toggle('stale', !applied);
  box.textContent = applied
    ? `${taken} shown`
    : `${taken} on OK`;
}

// Everything in the rail is staged, so a change repaints the count and nothing
// else. Enter in a text field is the same as pressing OK — a search you have
// finished typing is a search you meant.
$('#store-filters').addEventListener('input', paintPending);
$('#store-filters').addEventListener('change', paintPending);
$('#store-filters').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.matches('input')) { e.preventDefault(); applyFilters(); }
});

function applyFilters() {
  const pending = pendingFilter();
  if (pending.range) {
    const total = matching(pending).length;
    const [from, to] = pending.range;
    if (to !== Infinity && to < from) return toast('That range ends before it starts.', 'warn');
    if (from > total) return toast(`Only ${total} row${total === 1 ? '' : 's'} match that.`, 'warn');
  }
  store.applied = pending;
  renderStoredAccounts();
}

$('#store-range').addEventListener('click', applyFilters);

$('#store-clear').addEventListener('click', () => {
  const fresh = blankFilter();
  $('#store-search').value = '';
  $('#store-category').value = '';
  $('#store-cat').value = '';
  $('#store-open-dm').checked = fresh.openOnly;
  $('#store-cat-only').checked = fresh.catOnly;
  $('#store-times').querySelectorAll('input').forEach(i => { i.checked = false; });
  $('#store-from').value = '';
  $('#store-to').value = '';
  store.applied = fresh;
  renderStoredAccounts();
});

/* Every contact off the Bluesky chat list, in one press.
 *
 * It is a PRESET of the rail beside it, not a second way to choose - the
 * filters are the selection in this step and this sets them, so what lands on
 * screen is what a run sends to, exactly as it is after OK.
 *
 * The switch it turns off is the whole reason it exists. `Categorised only` is
 * on by default and is right for an X scrape, where the bio is what a campaign
 * aims at. Bluesky has no bio surface - a chat-list row carries a handle, a
 * name and whether it is a group, and nothing `classify.py` can read - so every
 * Bluesky contact has no category and that switch hides all of them. The
 * table then reads as empty on a store that is full, which looks like a broken
 * scrape rather than a filter doing its job.
 *
 * Groups are left in rather than dropped here: `walk_home` marks them, and the
 * table shows the mark, so the operator can see what they are aiming at. A
 * group is not a person and `open_chat` will report it as unmessageable. */
function applyChatUsersFilter() {
  const all = blankFilter();
  all.catOnly = false;               // the one that hides a Bluesky roster
  $('#store-search').value = '';
  $('#store-category').value = '';
  $('#store-cat').value = '';
  $('#store-open-dm').checked = all.openOnly;
  $('#store-cat-only').checked = all.catOnly;
  $('#store-times').querySelectorAll('input').forEach(i => { i.checked = false; });
  $('#store-from').value = '';
  $('#store-to').value = '';
  store.applied = all;
  // Sets `camp.targets` and repaints the checklist, which is what ticks the
  // step in the rail. The tick is not set here directly - it is an ANSWER about
  // whether there is anyone to send to, and faking it would tick a step with an
  // empty recipient list behind it.
  renderStoredAccounts();
  return camp.targets.length;
}

$('#store-chat-users').addEventListener('click', async e => {
  setBusy(e.currentTarget, true);
  try {
    // Straight off the browser, not out of the store. The store is what a SWEEP
    // has collected over time; this question is "who is in this account's chat
    // list right now", and for a run aimed at exactly those people the store is
    // a copy that can only be older than the answer.
    const { rows, count, problems } = await api('/api/scrape/chat-list', {
      method: 'POST', body: {},
    });
    (problems || []).forEach(p => toast(`${p.account}: ${p.error}`, 'warn'));
    if (!count) {
      return toast('No conversations found. Is the window signed in and the chat list loaded?', 'warn');
    }

    // The table this step renders reads `store.rows`, so the live list is put
    // there rather than a second table being built beside it - one table on
    // screen is what makes "what is shown is who gets messaged" true. It is a
    // page-local assignment: nothing is written to the account store.
    showUsersView('store');
    store.rows = rows;
    store.loaded = true;
    const n = applyChatUsersFilter();
    toast(`${n} chat contact${n === 1 ? '' : 's'} selected — this is who a run sends to`, 'ok');
  } catch (err) {
    toast(err.message, 'error');
  } finally { setBusy(e.currentTarget, false); }
});

/* ── Uploads (shared) ────────────────────────────────────────── */

async function postFiles(url, files, field = 'file') {
  if (window.XBOT_BACKEND) return window.XBOT_BACKEND.upload(url, files, field);
  const form = new FormData();
  [...files].forEach(f => form.append(field, f));
  const res = await fetch(url, { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `${res.status} ${res.statusText}`);
  return data;
}

function showInfo(id, message, level = 'ok') {
  const box = $(`#${id}`);
  if (!box) return;
  box.hidden = false;
  box.className = `upload-info ${level}`;
  box.innerHTML = message;
}

/* A dropzone and its hidden <input> are one control. Wired here so a new one is
 * three lines rather than a copy of the drag handlers. */
function wireDrop(zoneId, inputId, handler, infoId = null) {
  const zone = $(`#${zoneId}`);
  const input = $(`#${inputId}`);
  if (!zone || !input) return;

  const over = on => zone.classList.toggle('over', on);
  ['dragenter', 'dragover'].forEach(ev =>
    zone.addEventListener(ev, e => { e.preventDefault(); over(true); }));
  ['dragleave', 'drop'].forEach(ev =>
    zone.addEventListener(ev, () => over(false)));

  // Copied out of the FileList, never passed by reference.
  //
  // A FileList is a LIVE view of the input, and the line below clears the input
  // so the same file can be picked twice running - which empties the list the
  // handler is still holding. Everything before the handler's first `await`
  // survived (the upload itself was built and sent); everything after it found
  // an empty list, so `files[0].name` threw and the preview and its Import
  // button never appeared. The file had already been read by then, which is why
  // it failed as a UI that did nothing rather than as an upload that errored.
  zone.addEventListener('drop', e => {
    e.preventDefault();
    if (e.dataTransfer.files.length) run([...e.dataTransfer.files]);
  });
  input.addEventListener('change', () => {
    if (input.files.length) run([...input.files]);
    input.value = '';           // so the same file can be picked twice running
  });

  async function run(files) {
    zone.classList.add('busy');
    try { await handler(files); }
    catch (err) { infoId && showInfo(infoId, escapeHtml(err.message), 'bad'); }
    finally { zone.classList.remove('busy'); }
  }
}

/* ── Step 2 · Recipients upload ──────────────────────────────── */

wireDrop('users-drop', 'users-file', async files => {
  const { rows } = await postFiles('/api/store/accounts/parse', files);
  showInfo('users-upload-info',
           `<b>${rows.length}</b> handles read from <b>${escapeHtml(files[0].name)}</b>.`,
           'ok');

  // Shown before it is stored. A file of handles is the one input to this app
  // that nobody proof-reads, and importing 4,000 rows off a mis-picked column is
  // not undoable in any useful sense.
  $('#users-upload-preview').hidden = false;
  $('#users-upload-preview').innerHTML = `
    <div class="head">Preview · first ${Math.min(rows.length, 50)} of ${rows.length}</div>
    <div class="body">${rows.slice(0, 50).map((r, i) => `
      <div class="prow"><span class="n">${i + 1}</span>
        <span class="who-text">
          <span class="m-name">${escapeHtml(r.name || at(r.handle))}</span>
          <span class="m-handle">${escapeHtml(at(r.handle))}</span>
        </span></div>`).join('')}</div>`;

  const importBtn = $('#users-import');
  importBtn.hidden = false;
  importBtn.onclick = async () => {
    setBusy(importBtn, true);
    try {
      const { added } = await api('/api/store/accounts/import',
                                  { method: 'POST', body: { rows } });
      showInfo('users-upload-info', `<b>${added}</b> added to the store.`, 'ok');
      importBtn.hidden = true;

      // Straight to the list, showing what was just added.
      //
      // Two filters have to be moved out of the way first. Uploaded handles
      // arrive with no bio, so `Categorised only` - which is on by default -
      // would hide every single one, and the operator would land on an empty
      // table having just imported four hundred rows. Narrowing to the
      // `uploaded` target then shows the import rather than the whole store.
      showUsersView('store');
      await loadStoredAccounts(true);
      $('#store-cat-only').checked = false;
      const uploaded = [...$('#store-cat').options].some(o => o.value === 'uploaded');
      if (uploaded) $('#store-cat').value = 'uploaded';
      applyFilters();
    } catch (err) {
      showInfo('users-upload-info', escapeHtml(err.message), 'bad');
    } finally { setBusy(importBtn, false); }
  };
}, 'users-upload-info');

/* ── Step 3 · Messages upload ────────────────────────────────── */

$('#msg-file').addEventListener('change', async e => {
  if (!e.target.files.length) return;
  try {
    const { drafts } = await postFiles('/api/messages/parse', e.target.files);
    // Into the list you are writing, not the one on file: a file you picked is
    // something you are bringing, and appending it to the stored set would be
    // editing what is already saved.
    msgs.mode = 'manual';
    // A blank `sms1` nobody typed into is not worth keeping in front of an
    // import of six real drafts.
    const keep = msgs.manual.filter(d => d.text.trim());
    setDrafts([...keep, ...drafts], { dirty: true, select: keep.length });
    showInfo('msg-upload-info', `<b>${drafts.length}</b> drafts read in. Press
      <b>Save drafts</b> to store them.`, 'ok');
  } catch (err) {
    showInfo('msg-upload-info', escapeHtml(err.message), 'bad');
  }
  e.target.value = '';
});

/* The whole drafts box takes a dropped file, not just the 22px import icon:
 * aiming at that with a file in hand is not a thing to ask of anyone. */
['dragenter', 'dragover'].forEach(ev =>
  $('#drafts').addEventListener(ev, e => { e.preventDefault(); $('#drafts').classList.add('over'); }));
['dragleave', 'drop'].forEach(ev =>
  $('#drafts').addEventListener(ev, () => $('#drafts').classList.remove('over')));
$('#drafts').addEventListener('drop', e => {
  e.preventDefault();
  if (!e.dataTransfer.files.length) return;
  $('#msg-file').files = e.dataTransfer.files;
  $('#msg-file').dispatchEvent(new Event('change'));
});

/* ── Step 4 · Media ──────────────────────────────────────────── */

function showMediaView(which) {
  $('#media-upload-card').hidden = which !== 'upload';
  $('#media-library-card').hidden = which !== 'library';
}

$('#media-library').addEventListener('click', () => { showMediaView('library'); loadMedia(); });

async function pullMedia(button) {
  setBusy(button, true);
  try {
    const got = await api('/api/media/minio/pull', { method: 'POST', body: {} });
    toast(`${got.pulled} picture${got.pulled === 1 ? '' : 's'} from ${got.bucket}`
          + (got.skipped ? ` — ${got.skipped} skipped` : ''), got.pulled ? 'ok' : 'info');
  } catch (err) {
    toast(err.message, 'error');
  } finally { setBusy(button, false); }
  showMediaView('library');
  loadMedia(true);
}
$('#media-database').addEventListener('click', e => pullMedia(e.currentTarget));
$('#media-pull').addEventListener('click', e => pullMedia(e.currentTarget));
$('#media-upload-back').addEventListener('click', () => showMediaView('upload'));
$('#media-reload').addEventListener('click', () => loadMedia(true));

wireDrop('media-drop', 'media-file', async files => {
  const { added } = await postFiles('/api/media', files, 'files');
  showInfo('media-upload-info', `<b>${added}</b> image${added === 1 ? '' : 's'} uploaded.`, 'ok');
  showMediaView('library');
  loadMedia(true);
}, 'media-upload-info');

/* The library used to be ticked whole the first time each picture was seen.
 * With Media shut (Bluesky chat takes no pictures) nothing is ticked: a picked
 * picture would only be dropped by the server, and the step says so. */
function offerMedia(media) {
  for (const m of media) {
    if (m && m.name) camp.mediaOffered.add(m.name);
  }
}

/* The library read without opening the Media step, so the pictures are
 * ticked and counted the moment the Campaign panel opens. */
async function primeMedia() {
  try { offerMedia((await api('/api/media')).media || []); } catch { /* the step says why */ }
}

async function loadMedia() {
  try {
    const { media } = await api('/api/media');
    offerMedia(media);
    $('#media-count').textContent = `${media.length} image${media.length === 1 ? '' : 's'}`;
    $('#media-grid').innerHTML = media.length ? media.map(m => `
      <button class="media-tile ${camp.media.has(m.name) ? 'on' : ''}"
              data-name="${escapeHtml(m.name)}">
        <img src="${escapeHtml(m.url)}" alt="">
        <span class="pick">✓</span>
        <span class="name">${escapeHtml(m.name)}</span>
      </button>`).join('')
      : '<p class="muted">Nothing stored — upload an image.</p>';
  } catch (err) { toast(err.message, 'error'); }
}

$('#media-grid').addEventListener('click', e => {
  const tile = e.target.closest('.media-tile[data-name]');
  if (!tile) return;
  const name = tile.dataset.name;
  if (camp.media.has(name)) camp.media.delete(name); else camp.media.add(name);
  tile.classList.toggle('on', camp.media.has(name));
  renderChecklist();
});

/* ── Skipping one of Messages / Media ────────────────────────── */

/* Never both: a send carrying no text and no picture is an empty message. The
 * disabled one is dimmed rather than hidden — it has to stay visible to say WHY
 * it cannot be used, which is that the other one is. */
function applySkips() {
  // Media is always skipped: Bluesky chat carries text, links and an embedded
  // post, never a picture (chat.bsky.convo.defs#messageInput). The step stays
  // on screen with its notice and its cards greyed out; its switch is pinned
  // on, and so Messages can never be skipped - a send needs its text.
  $('#skip-media').checked = true;
  $('#skip-media').disabled = true;
  $('#skip-messages').checked = false;
  $('#skip-messages').disabled = true;
  $('#skip-media').closest('.skip').classList.add('off');
  $('#skip-messages').closest('.skip').classList.add('off');
  camp.media.clear();
  $$('#camp-steps button[data-step="media"]').forEach(b => b.classList.add('off'));
  renderChecklist();
}

$('#skip-messages').addEventListener('change', applySkips);
$('#skip-media').addEventListener('change', applySkips);

/* ── Step 5 · Status ─────────────────────────────────────────── */

function renderChecklist() {
  const list = $('#camp-checklist');
  if (!list) return;

  const noMsg = $('#skip-messages').checked;
  const noMedia = $('#skip-media').checked;

  const lines = [
    { ok: camp.picked.size > 0,
      name: 'An account to send from',
      // Step 1 lists only the accounts with a window open, so "pick one" is the
      // wrong instruction when there is nothing there to pick.
      detail: camp.picked.size
        ? `${camp.picked.size} picked`
        : (camp.accounts.some(a => (camp.sessions[a.id] || {}).active)
            ? 'Step 1 — tick at least one'
            : 'Step 1 — open a browser window on an account first') },
    { ok: camp.targets.length > 0,
      name: 'Recipients',
      detail: camp.targets.length
        ? `${camp.targets.length} on the list`
        : 'Step 2 — upload a file or take a range off the store' },
    { ok: noMsg || liveDrafts().length > 0,
      name: 'A message',
      detail: noMsg ? 'skipped — pictures only'
            : liveDrafts().length ? `${liveDrafts().length} in rotation`
            : 'Step 3 — write at least one draft' },
    { ok: noMedia || camp.media.size > 0,
      name: 'A picture',
      detail: noMedia ? 'skipped — Bluesky chat does not allow media attachments'
            : camp.media.size ? `${camp.media.size} picked`
            : 'Step 4 — pick at least one image' },
    // Not mandatory, but the one line worth reading before pressing Start: a run
    // aimed at closed inboxes burns the day's cap on actions that cannot land.
    { ok: camp.targets.every(r => r.dm_open), soft: true,
      name: 'Every recipient can be DMed',
      detail: (() => {
        const shut = camp.targets.filter(r => !r.dm_open).length;
        return shut ? `${shut} cannot be messaged — they will be skipped`
                    : 'all reachable';
      })() },
  ];

  // Three states, not two: satisfied, missing, and worth knowing. An advisory
  // line wearing the same amber as a blocking one makes the operator hunt for
  // which of the five is actually stopping the button.
  list.innerHTML = lines.map(l => `
    <li class="${l.ok ? 'ok' : (l.soft ? 'soft' : 'no')}">
      <span class="mark">${l.ok ? '✓' : (l.soft ? 'i' : '!')}</span>
      <span>${escapeHtml(l.name)}</span>
      <span class="detail">${escapeHtml(l.detail)}</span>
    </li>`).join('');

  paintStepTicks(lines);

  const missing = lines.filter(l => !l.ok && !l.soft);
  const start = $('#camp-start');
  start.disabled = missing.length > 0;
  $('#camp-start-note').textContent = missing.length
    ? `Still needed: ${missing.map(l => l.name.toLowerCase()).join(', ')}.`
    : `${camp.targets.length} recipients, from ${camp.picked.size} account${
        camp.picked.size === 1 ? '' : 's'}.`;

  // Campaign live deals the whole send out and shows it, so it needs the same
  // four answers Start does - there is no plan to draw without an account, a
  // recipient list and something to send.
  //
  // Except while something is already running, or has just run: those rows
  // exist whatever the wizard says now, and a panel you cannot reopen because
  // you have since cleared the recipient list is a panel that loses the record
  // of a send you are in the middle of.
  const liveBtn = $('#camp-live');
  const ready = missing.length === 0;
  const hasRun = live.lanes.length > 0;
  liveBtn.disabled = !ready && !hasRun;
  liveBtn.title = ready || hasRun
    ? 'Deal the send out and look at it before anything goes'
    : `Still needed: ${missing.map(l => l.name.toLowerCase()).join(', ')}`;
}

/* The rail's ticks. The numbered steps say what ORDER to work in; the ticks say
 * how far down it you are — which is the whole reason the checklist's answers
 * are worth carrying back up to a nav that is on screen the entire time. */
function paintStepTicks(lines) {
  const done = {
    login: lines[0].ok, users: lines[1].ok, messages: lines[2].ok,
    media: lines[3].ok,
    // Status is not a thing to satisfy — it is where you find out whether the
    // other four are. It ticks when they all have.
    status: lines.slice(0, 4).every(l => l.ok),
  };
  $$('#camp-steps button').forEach(b =>
    b.classList.toggle('done', !!done[b.dataset.step]));
}

$('#camp-refresh').addEventListener('click', () => {
  loadAccounts();
  loadStoredAccounts(true);
  renderChecklist();
});

$('#camp-start').addEventListener('click', async e => {
  const n = camp.targets.length;
  if (!confirm(`Send to ${n} account${n === 1 ? '' : 's'}? There is no unsend.`)) return;

  setBusy(e.currentTarget, true);
  try {
    const { task, lanes } = await api('/api/campaign/start', {
      method: 'POST',
      body: {
        accounts: [...camp.picked],
        recipients: camp.targets.map(r => r.handle),
        // Name AND text: the server deals what it is given, so a draft that
        // lives only in the MinIO bucket is dealt the same as a stored one.
        drafts: liveDrafts().map(d => ({ name: d.name, text: d.text })),
        media: [...camp.media],
        skip_messages: $('#skip-messages').checked,
        skip_media: $('#skip-media').checked,
      },
    });
    live.task = task;
    openCampLive(lanes || []);
    watchTask(task, { onTick: applyCampLive, onDone: applyCampLive });
  } catch (err) {
    toast(err.message, 'error');
  } finally { setBusy(e.currentTarget, false); }
});

/* ── Campaign live ───────────────────────────────────────────── */


/* Open the live panel on the WHOLE send, dealt out and pending.
 *
 * Reachable without starting anything, which is the point: this is where four
 * hundred rows can be read before any of them go, at the moment when the answer
 * to "that is the wrong draft" is still to close the panel.
 *
 * The server deals it with the same code `/start` uses, so what is approved here
 * is what runs - a preview built separately would be a different preview.
 *
 * A run in progress wins: `/plan` hands back the live state instead, because
 * those rows carry real statuses and replacing them with a fresh set of
 * `pending` would throw away the record of what has already gone out. */
$('#camp-live').addEventListener('click', async e => {
  setBusy(e.currentTarget, true);
  try {
    const plan = await api('/api/campaign/plan', {
      method: 'POST',
      body: {
        accounts: [...camp.picked],
        recipients: camp.targets.map(r => r.handle),
        // Name AND text: the server deals what it is given, so a draft that
        // lives only in the MinIO bucket is dealt the same as a stored one.
        drafts: liveDrafts().map(d => ({ name: d.name, text: d.text })),
        media: [...camp.media],
        skip_messages: $('#skip-messages').checked,
        skip_media: $('#skip-media').checked,
      },
    });
    applyCampLive(plan);
  } catch (err) {
    // Nothing to deal - a run that has been and gone still has rows worth
    // reading, so fall back to whatever the server last held.
    try { applyCampLive(await api('/api/campaign/status')); }
    catch { toast(err.message, 'error'); }
  } finally { setBusy(e.currentTarget, false); }
  $('#camp-live-box').showModal();
});

$('#camp-live-close').addEventListener('click', () => $('#camp-live-box').close());

function openCampLive(lanes) {
  live.lanes = lanes;
  live.tab = 0;
  renderCampLive();
  $('#camp-live-box').showModal();
}

function applyCampLive(status) {
  if (!status) return;
  if (Array.isArray(status.lanes)) live.lanes = status.lanes;
  if (status.state) live.state = status.state;
  if (status.note != null) live.note = status.note;
  renderCampLive();
  // A run that restarted itself - after a crash, a stall, or the server going
  // down - is a NEW task on the same rows. Follow it, so the table keeps
  // moving rather than freezing on the last frame of the old one.
  const going = status.state === 'running' || status.state === 'paused';
  if (going && status.task && status.task !== live.task) {
    live.task = status.task;
    watchTask(status.task, { onTick: applyCampLive, onDone: applyCampLive });
  }
}

function laneRows() {
  const lane = live.lanes[live.tab];
  return lane ? (lane.rows || []) : [];
}

function renderCampLive() {
  paintLiveTabs();
  paintLiveControls();

  const rows = laneRows();
  // The run writes its breaks and Bluesky-actions turns into the lanes as rows
  // of their own - planned up front, where they will fall, and moved to where
  // they actually fell when they happen. They are not recipients, so they are
  // drawn apart, left out of the count and the tally, and skipped by the
  // numbering.
  const isPerson = r => !r.kind;
  const all = live.lanes.flatMap(l => l.rows || []).filter(isPerson);
  $('#camp-live-sub').textContent = live.lanes.length
    ? `${all.length} recipients across ${live.lanes.length} account${
        live.lanes.length === 1 ? '' : 's'}`
    : '';

  $('#camp-live-tally').innerHTML = tallyOf(all);

  const body = $('#camp-live-table tbody');
  let n = 0;
  body.innerHTML = rows.length ? rows.map(r => isPerson(r) ? `
    <tr class="${r.status === 'processing' ? 's-processing' : ''}">
      <td class="c-n">${++n}</td>
      <td>
        <div class="c-who">
          <span class="avatar"><svg class="ic" viewBox="0 0 24 24"><use href="#i-user"/></svg></span>
          <span class="who-text">
            <span class="m-name">${escapeHtml(r.name || at(r.handle))}</span>
            <span class="m-handle">${escapeHtml(at(r.handle))}</span>
          </span>
        </div>
      </td>
      <td class="c-chat">${chatCell(r.chat)}</td>
      <td class="c-sms">${r.draft
        ? `<span class="tag" title="${escapeHtml(r.text || '')}">
             <svg class="ic" viewBox="0 0 24 24"><use href="#i-mail"/></svg>${
               escapeHtml(r.draft)}</span>`
        : '<span class="st none">—</span>'}</td>
      <td class="c-media">${r.media
        ? `<span class="tag media"><svg class="ic" viewBox="0 0 24 24"><use href="#i-image"/></svg>${
             escapeHtml(r.media)}</span>`
        : '<span class="st none">—</span>'}</td>
      <td class="c-status">${statusCell(r.status, r.why)}</td>
    </tr>` : `
    <tr class="s-action${r.status === 'processing' ? ' s-processing' : ''}${
        r.status === 'pending' ? ' s-planned' : ''}">
      <td class="c-n"></td>
      <td colspan="4">
        <div class="c-who">
          <span class="avatar act"><svg class="ic" viewBox="0 0 24 24"><use href="#${
            r.kind === 'break' ? 'i-clock' : 'i-panel'}"/></svg></span>
          <span class="who-text">
            <span class="m-name">${r.kind === 'break' ? 'Break' : 'Bluesky actions'}${
              r.kind === 'break' && r.status === 'processing' && r.ends_at
                ? ` <span class="left">${timeLeft(r.ends_at)} left</span>` : ''}</span>
            <span class="m-handle" title="${escapeHtml(r.why || '')}">${escapeHtml(r.why || '')}</span>
          </span>
        </div>
      </td>
      <td class="c-status">${planCell(r.kind, r.status)}</td>
    </tr>`).join('')
    : '<tr><td class="pad muted" colspan="6">Nothing running.</td></tr>';

  setCampLiveFoot(live.note, live.state === 'failed' ? 'bad'
                          : live.state === 'done' ? 'ok' : '');
}

const STATUS_LOOK = {
  pending: ['pending', 'i-clock', 'pending'],
  processing: ['processing', 'i-reset', 'sending'],
  sent: ['sent', 'i-check', 'sent'],
  typed: ['typed', 'i-mail', 'typed, not sent'],
  failed: ['failed', 'i-x', 'failed'],
};

/* Whether this profile had a chat to open at all — the column the run is watched
 * on. Three answers, because "not reached yet" and "reached, and there was no
 * chat" are different facts and only one of them is worth acting on: a handle
 * with no chat is one to drop from the next list, and a blank is one the run has
 * simply not got to. */
function chatCell(chat) {
  if (chat === 'open') {
    return `<span class="st sent" title="The profile had a chat button and it opened"
      ><svg class="ic" viewBox="0 0 24 24"><use href="#i-chat"/></svg>chat available</span>`;
  }
  if (chat === 'none') {
    return `<span class="st failed" title="This profile has no chat button — it cannot be messaged"
      ><svg class="ic" viewBox="0 0 24 24"><use href="#i-x"/></svg>no chat available</span>`;
  }
  return '<span class="st none">—</span>';
}

/* What is left of a break, from the end time the server put on the row
 * (wall-clock seconds). The panel is repainted on every poll, so this counts
 * down on its own. */
function timeLeft(endsAt) {
  const s = Math.max(0, Math.round(endsAt - Date.now() / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/* A break's or an actions turn's status. The detail already reads under the
 * name, so the badge carries only the word. */
function planCell(kind, status) {
  const [cls, icon, label] = {
    pending: ['pending', 'i-clock', 'planned'],
    processing: ['processing', 'i-reset', kind === 'break' ? 'on break' : 'pressing'],
    sent: ['sent', 'i-check', 'done'],
    failed: ['failed', 'i-x', 'failed'],
  }[status] || ['none', 'i-dots', '—'];
  return `<span class="st ${cls}">
      <svg class="ic" viewBox="0 0 24 24"><use href="#${icon}"/></svg>${label}</span>`;
}

function statusCell(status, why) {
  const [cls, icon, label] = STATUS_LOOK[status] || ['none', 'i-dots', '—'];
  // "failed" on its own is not something an operator can act on, so the reason
  // rides under the badge rather than in a log they would have to go and find.
  return `<span class="st ${cls}">
      <svg class="ic" viewBox="0 0 24 24"><use href="#${icon}"/></svg>${label}</span>
    ${why ? `<span class="st-why" title="${escapeHtml(why)}">${escapeHtml(truncate(why, 40))}</span>` : ''}`;
}

function tallyOf(rows) {
  const counts = rows.reduce((acc, r) => (acc[r.status] = (acc[r.status] || 0) + 1, acc), {});
  return ['sent', 'typed', 'processing', 'pending', 'failed']
    .filter(k => counts[k])
    .map(k => `<span class="st ${k}">${counts[k]} ${STATUS_LOOK[k][2]}</span>`)
    .join('');
}

/* One tab per account the campaign is running from. With three going, "which
 * one is behind" is the question, and a strip of bare names makes you click all
 * three to answer it — so the progress is ON the tab. */
function paintLiveTabs() {
  const tabs = $('#camp-live-tabs');
  tabs.hidden = live.lanes.length < 2;
  if (tabs.hidden) return;

  tabs.innerHTML = live.lanes.map((lane, i) => {
    // Recipients only: the planned breaks and actions turns are not messages.
    const rows = (lane.rows || []).filter(r => !r.kind);
    const done = rows.filter(r => r.status === 'sent' || r.status === 'typed').length;
    const bad = rows.filter(r => r.status === 'failed').length;
    return `<button class="live-tab ${i === live.tab ? 'on' : ''}" data-i="${i}">
        <span class="lt-name">${escapeHtml(lane.account)}</span>
        <span class="lt-count">${done}/${rows.length}</span>
        ${bad ? `<span class="lt-bad">${bad}</span>` : ''}
      </button>`;
  }).join('');
}

$('#camp-live-tabs').addEventListener('click', e => {
  const tab = e.target.closest('.live-tab[data-i]');
  if (!tab) return;
  live.tab = Number(tab.dataset.i);
  renderCampLive();
});

/* Pause first, then choose. End is deliberately dead while the run is going:
 * ending a campaign is not undoable, and making it reachable only from a stopped
 * run means the decision is taken with the table holding still. */
function paintLiveControls() {
  const running = live.state === 'running' || live.state === 'restarting';
  // Resume covers three things: a pause, a run the server restart cut off,
  // and one that gave up after too many restarts - all carry on from the
  // saved rows.
  const paused = live.state === 'paused' || live.state === 'interrupted'
              || live.state === 'failed';
  const over = live.state === 'done' || live.state === 'stopped';
  // A plan is a send that has not happened. There is nothing to pause and
  // nothing to end, and offering either would suggest something is under way.
  const planned = live.state === 'planned';

  const pause = $('#camp-pause');
  pause.hidden = over || planned || !live.lanes.length;
  pause.querySelector('.lbl').textContent = paused ? 'Resume' : 'Pause';

  const end = $('#camp-end');
  end.hidden = over || planned || !live.lanes.length;
  end.disabled = running && live.state !== 'restarting';
  end.title = running ? 'Pause the campaign first' : 'End this campaign';
}

$('#camp-pause').addEventListener('click', async e => {
  setBusy(e.currentTarget, true);
  try {
    const resuming = ['paused', 'interrupted', 'failed'].includes(live.state);
    const path = resuming ? '/api/campaign/resume' : '/api/campaign/pause';
    applyCampLive(await api(path, { method: 'POST' }));
  } catch (err) {
    toast(err.message, 'error');
  } finally { setBusy(e.currentTarget, false); }
});

$('#camp-end').addEventListener('click', async e => {
  if (!confirm('End this campaign? The recipients it has not reached stay unmessaged.')) return;
  setBusy(e.currentTarget, true);
  try {
    applyCampLive(await api('/api/campaign/stop', { method: 'POST' }));
  } catch (err) {
    toast(err.message, 'error');
  } finally { setBusy(e.currentTarget, false); }
});

function setCampLiveFoot(text, tone = '') {
  const foot = $('#camp-live-foot');
  foot.textContent = text || '';
  foot.className = `live-foot ${tone || 'muted'}`;
}

async function loadCampaign() {
  primeMedia();
  loadDrafts();
  applySkips();
  renderChecklist();
}

/* ── Settings ────────────────────────────────────────────────── */

/* The one setting with a control of its own — see #set-clicksend. Left out of
 * the generated list so there is one switch for it rather than two that have to
 * be kept saying the same thing. */
const OWN_CONTROL = new Set(['click_send']);

/* ── What belongs where ──────────────────────────────────────────
 *
 * The schema is one flat list in the order its keys were added, and reading it
 * top to bottom tells you nothing about which screen a key acts on: the FB
 * comment cap sat four rows above the Bluesky typing speed. So the panel is
 * laid out the way the console is — a section per panel the setting belongs
 * to, and inside it a group per job — while the schema stays the single place
 * a setting is declared.
 *
 * Nothing here decides which settings EXIST. A key the schema grows that is
 * not listed below still appears, under Uncategorised at the foot: a new row
 * is never invisible, only unsorted. */
const SETTING_SECTIONS = [
  // Each panel's settings live on that panel, behind its gear button. What is
  // listed here is only what no single panel owns - see panelFiledKeys().
  { panel: 'Feed Campaign', icon: 'i-home',
    note: 'The Home feed run: how many posts each account answers, and how it paces itself.',
    groups: [
      { title: 'Commenting',
        keys: ['fb_comment_limit', 'fb_like', 'fb_gap_min_seconds', 'fb_gap_max_seconds'],
        help: 'Each tab likes a post, opens its reply box, types the comment '
            + '(at the Campaign typing speed, slips and all) and posts it, then '
            + 'rests for a roll from the gap before the next post.' },
    ] },

  { panel: 'Scraping', icon: 'i-scan',
    note: 'The one scraping setting that is a list; the rest are behind the gear on the Scraping panel.',
    groups: [
      { title: 'Targets',
        keys: ['target_defaults'] },
    ] },

  { panel: 'Everywhere', icon: 'i-gear',
    note: 'Settings no single panel owns.',
    groups: [
      { title: 'Links',
        keys: ['profile_url'],
        help: 'How a handle becomes a profile address, everywhere one is '
            + 'opened.' },
    ] },
];

const UNSORTED = {
  panel: 'Uncategorised', icon: 'i-list',
  note: 'In the schema but not yet filed under a panel above.',
};

document.querySelectorAll('.set-moved button[data-go]').forEach(b => {
  b.addEventListener('click', () => showPanel(b.dataset.go));
});

async function loadSettings() {
  try {
    const { settings, schema } = await api('/api/settings');
    paintClickSend(settings.click_send);
    $('#settings-form').innerHTML = settingsHtml(schema, settings);
    $$('#settings-form .setting.list').forEach(box => paintList(box, listValues(box)));
    paintLinkPreview();
  } catch (err) { toast(err.message, 'error'); }
}

/* Sections are <details> rather than headings with a script behind them: the
 * open/shut is the browser's, it survives a repaint of nothing else, and a
 * panel of sixty rows opens as six lines you can read. All open to start —
 * shut by default would hide from a first-time reader exactly what this panel
 * is for. */
function settingsHtml(schema, settings) {
  const byKey = Object.fromEntries(schema.map(row => [row.key, row]));
  // The keys a panel's own gear shows are not repeated here - except a list,
  // which the gear dialogs do not draw and which therefore stays.
  const placed = new Set(OWN_CONTROL);
  for (const key of panelFiledKeys()) {
    if (byKey[key] && byKey[key].type !== 'list') placed.add(key);
  }

  const sections = SETTING_SECTIONS.map(section => {
    const groups = section.groups
      .map(group => {
        const rows = group.keys.filter(key => byKey[key] && !placed.has(key));
        rows.forEach(key => placed.add(key));
        return rows.length ? settingGroup(group, rows.map(key => byKey[key]), settings) : '';
      })
      .filter(Boolean);
    return groups.length ? settingSection(section, groups) : '';
  }).filter(Boolean);

  // Whatever the schema has grown since this list was written. It goes at the
  // foot rather than nowhere: an unfiled setting is still a setting somebody
  // has to be able to change.
  const left = schema.filter(row => !placed.has(row.key));
  if (left.length) {
    sections.push(settingSection(UNSORTED, [settingGroup({ title: 'Other' }, left, settings)]));
  }
  return sections.join('');
}

function settingSection(section, groups) {
  const n = groups.join('').split('data-key=').length - 1;
  return `
    <details class="set-sec" open>
      <summary>
        <svg class="ic" viewBox="0 0 24 24"><use href="#${escapeHtml(section.icon)}"/></svg>
        <span class="ss-name">${escapeHtml(section.panel)}</span>
        <span class="ss-n">${n}</span>
        <span class="ss-note">${escapeHtml(section.note || '')}</span>
      </summary>
      <div class="ss-body">${groups.join('')}</div>
    </details>`;
}

function settingGroup(group, rows, settings) {
  return `
    <div class="set-grp">
      <h4>${escapeHtml(group.title)}</h4>
      ${group.help ? `<p class="sg-help">${escapeHtml(group.help)}</p>` : ''}
      <div class="settings-rows">${rows.map(row => settingRow(row, settings[row.key])).join('')}</div>
    </div>`;
}

function settingRow(row, value) {
  if (row.type === 'list') return listSetting(row, value);
  if (row.type === 'text') return textSetting(row, value);
  return `
      <label class="setting">
        <span class="k">${escapeHtml(row.key)}</span>
        ${row.type === 'bool'
          ? `<input type="checkbox" data-key="${row.key}" ${value ? 'checked' : ''}>`
          : `<input type="number" step="any" data-key="${row.key}"
                    min="${row.min ?? ''}" max="${row.max ?? ''}" value="${value}">`}
        <span class="help">${escapeHtml(row.help)}</span>
      </label>`;
}

/* A URL needs the width a 120px number box does not have, and its placeholders
 * need to be readable at the moment they are being typed rather than in a help
 * line somewhere else — so a text setting gets its own row shape. */
function textSetting(row, value) {
  const tokens = (row.tokens || [])
    .map(t => `<button type="button" class="tok" data-tok="${escapeHtml(t)}"
                       data-for="${escapeHtml(row.key)}">${escapeHtml(t)}</button>`)
    .join('');
  return `
    <div class="setting wide">
      <span class="k">${escapeHtml(row.key)}</span>
      <input type="text" spellcheck="false" data-key="${escapeHtml(row.key)}"
             value="${escapeHtml(String(value ?? ''))}"
             placeholder="${escapeHtml(String(row.default ?? ''))}">
      <span class="help">${escapeHtml(row.help)}</span>
      ${tokens ? `<div class="toks">${tokens}<span class="ex" id="link-preview"></span></div>` : ''}
    </div>`;
}

/* ── A list setting ──────────────────────────────────────────────
 *
 * One row per entry, each editable in place, each with an X — rather than ten
 * entries as one 60-character comma-separated line, where changing the fourth
 * one means counting commas and a stray one splits an entry in half.
 *
 * STORED as that same comma-separated string: a hidden input carries the real
 * value, the rows are kept in sync with it, and Save collects `input[data-key]`
 * and finds exactly the shape it finds for every other setting. */
const LIST_NOUNS = {
  target_defaults: { one: 'target', many: 'targets',
                     add: 'Add a target — or paste several, comma-separated',
                     empty: 'No default targets — a sweep uses whatever is in '
                          + 'the Scraping panel’s pool.' },
};

function listSetting(row, value) {
  const noun = LIST_NOUNS[row.key] || {};
  return `
    <div class="setting wide list" data-list="${escapeHtml(row.key)}">
      <span class="k">${escapeHtml(row.key)}</span>
      <input type="hidden" data-key="${escapeHtml(row.key)}"
             value="${escapeHtml(String(value ?? ''))}">
      <div class="rows"></div>
      <div class="add">
        <input type="text" class="add-in" placeholder="${escapeHtml(noun.add || 'Add one')}">
        <button type="button" class="add-go tiny">Add</button>
        <span class="list-n"></span>
      </div>
      <span class="help">${escapeHtml(row.help)}</span>
    </div>`;
}

function listValues(box) {
  return String(box.querySelector('input[data-key]').value || '')
    .split(',').map(s => s.trim()).filter(Boolean);
}

function paintList(box, values) {
  const noun = LIST_NOUNS[box.dataset.list] || {};
  box.querySelector('.rows').innerHTML = values.length
    ? values.map((v, i) => `
      <span class="list-row">
        <input class="list-in" data-i="${i}" value="${escapeHtml(v)}">
        <button type="button" class="list-x" data-i="${i}" title="Remove">×</button>
      </span>`).join('')
    : `<span class="list-none">${escapeHtml(noun.empty || 'Nothing yet.')}</span>`;

  box.querySelector('.list-n').textContent = values.length
    ? `${values.length} ${values.length === 1 ? (noun.one || 'entry') : (noun.many || 'entries')}`
    : '';
}

function syncList(box, values) {
  box.querySelector('input[data-key]').value = values.join(', ');
  paintList(box, values);
}

$('#settings-form').addEventListener('click', e => {
  const box = e.target.closest('.setting.list');

  if (box && e.target.closest('.list-x')) {
    const values = listValues(box);
    values.splice(Number(e.target.closest('.list-x').dataset.i), 1);
    return syncList(box, values);
  }
  if (box && e.target.closest('.add-go')) return addToList(box);

  const chip = e.target.closest('.tok');
  if (!chip) return;
  const input = $(`#settings-form input[data-key="${chip.dataset.for}"]`);
  if (!input) return;
  // At the caret, not appended — the token belongs wherever the operator has
  // their cursor in the URL, which is rarely the end of it.
  const from = input.selectionStart ?? input.value.length;
  const to = input.selectionEnd ?? from;
  input.value = input.value.slice(0, from) + chip.dataset.tok + input.value.slice(to);
  input.focus();
  input.setSelectionRange(from + chip.dataset.tok.length, from + chip.dataset.tok.length);
  paintLinkPreview();
});

function addToList(box) {
  const input = box.querySelector('.add-in');
  const added = input.value.split(',').map(s => s.trim()).filter(Boolean);
  if (!added.length) return;
  const values = listValues(box);
  for (const v of added) if (!values.includes(v)) values.push(v);
  input.value = '';
  syncList(box, values);
}

$('#settings-form').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const box = e.target.closest('.setting.list');
  if (!box) return;
  e.preventDefault();                     // a bare Enter would submit nothing
  if (e.target.classList.contains('add-in')) addToList(box);
});

/* An edit to a row writes straight through to the hidden input the Save press
 * reads, so a value typed and never blurred is not silently dropped. */
$('#settings-form').addEventListener('input', e => {
  if (e.target.id === 'link-preview') return;
  const box = e.target.closest('.setting.list');
  if (box && e.target.classList.contains('list-in')) {
    const values = listValues(box);
    values[Number(e.target.dataset.i)] = e.target.value.trim();
    box.querySelector('input[data-key]').value = values.filter(Boolean).join(', ');
  }
  paintLinkPreview();
});

/* The URL setting, filled in. It is what the line MEANS, not another thing to
 * edit — so it is dimmed and sits under the tokens that build it. */
function paintLinkPreview() {
  const preview = $('#link-preview');
  if (!preview) return;
  const input = $('#settings-form input[data-key="profile_url"]');
  if (!input) return;
  preview.textContent = String(input.value || '')
    .replace('{handle}', 'jack')
    .replace('{id}', '12');
}

function paintClickSend(on) {
  const button = $('#set-clicksend');
  if (!button) return;
  button.classList.toggle('on', !!on);
  button.setAttribute('aria-pressed', String(!!on));
  button.querySelector('.lbl').textContent = on ? 'On' : 'Off';
}

/* Saved on the press, not on Save. The rest of this panel is numbers nobody
 * changes mid-run; this one decides whether the next campaign puts words in
 * other people's inboxes, and it has to be true the moment it looks true. */
$('#set-clicksend').addEventListener('click', async () => {
  const button = $('#set-clicksend');
  const next = button.getAttribute('aria-pressed') !== 'true';
  paintClickSend(next);                    // answer the press at once
  try {
    const { settings } = await api('/api/settings',
                                   { method: 'POST', body: { click_send: next } });
    // Repaint from what was STORED: a value the backend refused must not leave
    // a button claiming it took.
    paintClickSend(settings.click_send);
    toast(settings.click_send
      ? 'Click Send is on — runs will send'
      : 'Click Send is off — messages are typed and left for you', 'ok');
  } catch (err) {
    paintClickSend(!next);
    toast(err.message, 'error');
  }
});

$('#set-save').addEventListener('click', async e => {
  const changes = {};
  $$('#settings-form input[data-key]').forEach(input => {
    changes[input.dataset.key] = input.type === 'checkbox' ? input.checked : input.value;
  });
  setBusy(e.currentTarget, true);
  try {
    await api('/api/settings', { method: 'POST', body: changes });
    toast('Settings saved', 'ok');
    loadSettings();
  } catch (err) {
    toast(err.message, 'error');
  } finally { setBusy(e.currentTarget, false); }
});

$('#set-reset').addEventListener('click', async () => {
  if (!confirm('Reset every setting to its default?')) return;
  try {
    await api('/api/settings/reset', { method: 'POST' });
    loadSettings();
  } catch (err) { toast(err.message, 'error'); }
});

/* ── Status pills + activity feed ────────────────────────────── */

// The store and browser pills hold a status dot as well as their label, so only
// the label span is written — setting textContent on the pill itself would
// delete the dot. The run pill is bare text and has no span to find, and
// reaching for one that isn't there threw inside the poll loop and stopped it
// dead: a scrape would run to completion on the server and never reach the
// board.
function setPill(id, label, state) {
  const pill = $(id);
  if (!pill) return;
  const slot = pill.querySelector('span');
  if (slot) slot.textContent = label; else pill.textContent = label;
  pill.className = `pill ${id === '#pill-run' ? 'run ' : ''}${state}`;
}

/* The bucket, on the pill bar. Three states worth telling apart: not configured
 * at all (no pill — the console does not need one), configured and reachable,
 * and configured but not answering. The third is the one that matters: a scrape
 * that ends will try to send and will not be able to, and knowing that BEFORE
 * the run is what saves the trip to the log afterwards. */
function paintMinioPill(minio) {
  const pill = $('#pill-minio');
  if (!pill) return;
  if (!minio || !minio.configured) { pill.hidden = true; return; }
  pill.hidden = false;
  // Short on the pill, whole in the tooltip. The bucket's name on the pill
  // itself made it 226px wide, and in a header that has to fit eight tabs on a
  // laptop that was three tabs pushed out of sight.
  pill.title = `MinIO bucket ${minio.bucket || '?'} — ${minio.detail || (minio.up ? 'reachable' : 'not reachable')}`;
  setPill('#pill-minio', `minio: ${minio.up ? 'up' : 'down'}`, minio.up ? 'ok' : 'bad');
}

/* ── Reset: the app name and logo ────────────────────────────── */

/* Stop everything that is running and start the app fresh. Confirmed first,
 * because it ends a campaign part way through. What it keeps is said in the
 * same dialog, so nobody presses it wondering whether their accounts or
 * collected handles go too. */
async function resetApp() {
  const brand = $('#app-reset');
  if (brand.classList.contains('busy')) return;
  const ok = confirm(
    'Refresh the app?\n\n'
    + 'Everything running will be stopped: campaigns, FB Campaign, scraping, '
    + 'group posting and groups joining. Every panel goes back to a fresh start.\n\n'
    + 'Kept: your accounts and their browser windows, drafts, pictures and all '
    + 'collected data.');
  if (!ok) return;
  brand.classList.add('busy');
  toast('Stopping everything…');
  try {
    const out = await api('/api/app/reset', { method: 'POST' });
    if (out.still_going && out.still_going.length) {
      // Said before the reload wipes the toast: a run that did not stop in time
      // is still finishing the step it was on, and will end at its next check.
      alert(`Still finishing: ${out.still_going.join(', ')}. It stops at its next step.`);
    }
  } catch (err) {
    // The server could not be reached. Refreshing the page is still what was
    // asked for, and the next load shows what is actually running.
    toast(err.message, 'error');
  }
  location.reload();
}

$('#app-reset').addEventListener('click', resetApp);
$('#app-reset').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); resetApp(); }
});

async function pollStatus() {
  try {
    // MinIO is allowed to be absent, so its read is caught on its own rather
    // than taking the browser and store pills down with it.
    const [status, store, minio] = await Promise.all([
      api('/api/automation/status'),
      api('/api/store/health'),
      api('/api/minio/status').catch(() => ({ configured: false })),
    ]);
    const browser = status.browser;
    // With accounts open side by side the pill counts WINDOWS — one open window
    // showing three tabs and three accounts open are different situations, and
    // a page count alone reads the same for both.
    const windows = browser.count ?? (browser.open ? 1 : 0);
    setPill('#pill-browser',
            browser.open
              ? (windows > 1 ? `browser: ${windows} windows`
                             : `browser: ${browser.pages} page(s)`)
              : 'browser: closed',
            browser.open ? 'ok' : '');
    setPill('#pill-store', `store: ${store.up ? 'up' : 'down'}`, store.up ? 'ok' : 'bad');
    paintMinioPill(minio);

    // The browser can be closed from outside the app — by the operator, or by a
    // crash — and the Scraping panel must not keep offering buttons that would
    // then run against nothing. Only while that panel is on screen: nobody
    // needs a sessions read every five seconds to look at Settings.
    if (panelIsOn('scraping')) refreshScrapeSessions();
    if (panelIsOn('actions')) refreshActGate();
    if (panelIsOn('fb') && !fbRunning) paintFbFromServer();
    if (panelIsOn('groups') && !grpRunning) paintGrpFromServer();
    // A joining run nobody is watching - the page was reloaded mid-run - is
    // read here so its rows keep arriving in the table.
    if (panelIsOn('groups') && !watching) paintGjFromServer();
    refreshBusy();
    // The campaign's account row is a list of OPEN windows, and a window can be
    // opened or closed from outside this app. Without this the step would go on
    // offering an account whose window was shut ten minutes ago - and a run
    // against it fails on every recipient.
    if (panelIsOn('campaign')) refreshCampSessions();
    // The live table open with nobody watching a task - the page was reloaded
    // mid-run, or the run is between restarts - reads the server's copy, and
    // attaches to the new task when there is one.
    if ($('#camp-live-box').open && !watching) {
      api('/api/campaign/status').then(applyCampLive).catch(() => {});
    }
  } catch { /* the server is restarting — the next tick will pick it up */ }
  setTimeout(pollStatus, 5000);
}

function openFeed() {
  const list = $('#feed');
  const push = row => {
    list.prepend(feedRow(row));
    while (list.children.length > 300) list.lastChild.remove();
  };

  if (window.XBOT_BACKEND) return window.XBOT_BACKEND.stream(push);

  // SSE rather than a websocket: the stream is one-directional and EventSource
  // reconnects on its own when the server restarts, which during development is
  // constantly.
  const source = new EventSource('/api/data/activity/stream');
  source.onmessage = event => push(JSON.parse(event.data));
}

$('#feed-clear').addEventListener('click', async () => {
  try { await api('/api/data/activity', { method: 'DELETE' }); } catch { /* local only */ }
  $('#feed').innerHTML = '';
});

/* ── Showing and hiding the feed ─────────────────────────────── */

const FEED_KEY = 'x-bot.feed-open';

function setFeed(open) {
  document.body.classList.toggle('no-feed', !open);
  const toggle = $('#feed-toggle');
  toggle.classList.toggle('on', open);
  toggle.setAttribute('aria-pressed', String(open));
  // Remembered, because an operator who closed it wants it closed next time
  // too. Guarded: localStorage throws outright in some privacy modes, and a
  // layout preference is not worth breaking boot over.
  try { localStorage.setItem(FEED_KEY, open ? '1' : '0'); } catch { /* not fatal */ }
}

$('#feed-toggle').addEventListener('click',
  () => setFeed(document.body.classList.contains('no-feed')));
$('#feed-close').addEventListener('click', () => setFeed(false));

function restoreFeed() {
  let stored = null;
  try { stored = localStorage.getItem(FEED_KEY); } catch { /* not fatal */ }
  setFeed(stored !== '0');          // open unless it was explicitly closed
}

$('#pill-store').addEventListener('click', async () => {
  try {
    const { logs } = await api('/api/store/logs');
    $('#store-log-body').textContent = logs
      .map(l => `${String(l.at).slice(11, 19)}  ${l.level.padEnd(7)} ${l.message}`)
      .join('\n');
    $('#store-log').showModal();
  } catch (err) { toast(err.message, 'error'); }
});
$('#store-log-close').addEventListener('click', () => $('#store-log').close());

/* ── Boot ────────────────────────────────────────────────────── */

restoreFeed();
restoreFilterGroups();
// Accounts first even though Campaign is the panel on screen: it is what fills
// the wizard's own account picker.
loadAccounts().then(loadCampaign).catch(err => toast(err.message, 'error'));
pollStatus();
openFeed();          // the stream runs whether or not the panel is visible

// Reached only if every line above it ran, which is exactly what the guard at
// the top of this file is asking about.
window.__consoleReady = true;
