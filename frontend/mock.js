/* bluesky-bot — the stand-in for a backend.
 *
 * There is no server in this repo yet. meetup-bot's could not be ported: its
 * automation layer is a file of Meetup selectors, its stores are Meetup's
 * tables, and none of that survives the move to X. So the frontend was built
 * first, against an HTTP contract, and this answers that contract out of
 * localStorage until a real server exists.
 *
 * The rules it plays by, so it stays honest about what it is:
 *
 *   · Same paths, same methods, same response SHAPES as the eventual server.
 *     app.js does not branch on which one is answering — see `api()` there.
 *   · No automation. Nothing here opens a browser or touches bsky.app. "Opening"
 *     an account marks a flag; a sweep invents plausible rows on a timer.
 *   · Deleting the <script src="/mock.js"> line in index.html hands the whole
 *     app to a real server with no other edit.
 *
 * Everything it returns is FAKE. It is a fixture for building the UI against,
 * not a dry-run mode — a dry run implies the real thing was reached and
 * something was deliberately not done, and nothing here reaches anything.
 */

(() => {
  'use strict';

  const KEY = 'x-bot.db';
  const now = () => new Date().toISOString();
  const uid = () => Math.random().toString(36).slice(2, 10);
  const clone = v => JSON.parse(JSON.stringify(v));

  /* ── Defaults ─────────────────────────────────────────────────
     The settings SCHEMA lives here rather than in app.js on purpose: the panel
     is generated from whatever the server describes, so the day a real backend
     arrives with a longer list, the Settings screen grows on its own. */
  const SCHEMA = [
    { key: 'click_send', type: 'bool', default: true,
      help: 'On, a run sends. Off, it types the message and leaves the composer.' },
    { key: 'parallel_tabs', type: 'number', default: 5, min: 1, max: 10,
      help: 'How many chats one account drives at once - a tab each. A tab sends, '
          + 'waits out the gap, refreshes and takes the next recipient.' },
    { key: 'media_via_post', type: 'bool', default: false,
      help: 'Off: a campaign messages the people picked, text only - a Bluesky chat '
          + 'cannot carry a picture. On: each dealt picture is first PUBLISHED AS A '
          + 'PUBLIC POST from the sending account, and every chat gets that post\'s '
          + 'link before the message, so the picture shows as the post.' },
    { key: 'close_tab_after_send', type: 'bool', default: true,
      help: 'Shut each tab when its message has gone (the tabs are reused either way).' },

    // FB Groups scraping, the same keys the server has.
    { key: 'scrape_group_tabs', type: 'number', default: 1, min: 1, max: 8,
      help: 'How many groups are read at the same time, a tab each.' },
    { key: 'scrape_group_members_max', type: 'number', default: 0, min: 0, max: 100000,
      help: 'The most people read from one group before moving on. 0 reads them all.' },
    { key: 'scrape_group_scroll_smooth', type: 'bool', default: true,
      help: 'Scroll the People list smoothly rather than in jumps.' },
    { key: 'scrape_group_scroll_seconds', type: 'number', default: 1.2, min: 0.2, max: 8,
      help: 'The wait between one scroll and the next, in every tab.' },
    { key: 'scrape_group_scroll_step', type: 'number', default: 0.9, min: 0.2, max: 3,
      help: 'How far each scroll goes, as a share of the window.' },
    { key: 'scrape_stall_seconds', type: 'number', default: 90, min: 0, max: 3600,
      help: 'Reload a page that has added nobody for this long.' },

    { key: 'daily_dm_cap', type: 'number', default: 120, min: 0, max: 1000,
      help: 'Messages per day across every account. The run stops at this number.' },
    { key: 'per_account_dm_cap', type: 'number', default: 40, min: 0, max: 500,
      help: 'Messages per day from one account. Bluesky counts these per account, not per '
          + 'campaign, and going past its limit is what turns a working account '
          + 'into a read-only one.' },
    { key: 'batch_min_messages', type: 'number', default: 10, min: 1, max: 200,
      help: 'How many messages each account sends before it takes a break, rolled '
          + 'between the two afresh for every break - one after 13, the next after 18.' },
    { key: 'batch_max_messages', type: 'number', default: 20, min: 1, max: 200,
      help: 'The top of that range.' },
    { key: 'break_min_minutes', type: 'number', default: 10, min: 0, max: 240,
      help: 'How long a break lasts, rolled between the two each time.' },
    { key: 'break_max_minutes', type: 'number', default: 20, min: 0, max: 240,
      help: 'The top of that range.' },
    { key: 'break_actions', type: 'number', default: 3, min: 0, max: 6,
      help: 'How many of the Actions panel\'s rail items the account presses during '
          + 'each break, drawn at random (never Compose). 0 presses nothing.' },

    { key: 'actions_min_messages', type: 'number', default: 5, min: 0, max: 500,
      help: 'After this many messages - rolled between the two - every account presses '
          + 'its Bluesky rail items before sending goes on. 0 turns it off.' },
    { key: 'actions_max_messages', type: 'number', default: 10, min: 0, max: 500,
      help: 'The top of that range.' },
    { key: 'actions_min_items', type: 'number', default: 2, min: 1, max: 6,
      help: 'How many of the six rail items one turn presses, rolled between the two.' },
    { key: 'actions_max_items', type: 'number', default: 3, min: 1, max: 6,
      help: 'The top of that range.' },
    { key: 'actions_min_rest_minutes', type: 'number', default: 2, min: 0, max: 240,
      help: 'After the items are pressed the run rests this long, rolled between the two.' },
    { key: 'actions_max_rest_minutes', type: 'number', default: 5, min: 0, max: 240,
      help: 'The top of that range.' },
    { key: 'groups_visit_direct', type: 'bool', default: false,
      help: 'Off (the default), every group is reached by pressing its name in the Groups list. On, the walk goes from one group straight to the next by address.' },
    { key: 'groups_visit_gap_min', type: 'number', default: 1.0, min: 0, max: 60,
      help: 'How long the Group Posting walk rests between one group and the next.' },
    { key: 'groups_visit_gap_max', type: 'number', default: 2.5, min: 0, max: 60,
      help: 'The top of that range.' },
    { key: 'campaign_auto_restart', type: 'bool', default: true,
      help: 'A campaign that crashes, stalls or is cut off picks itself up from where it was.' },
    { key: 'campaign_stall_minutes', type: 'number', default: 12, min: 0, max: 180,
      help: 'No progress for this long and the run is restarted from the same row. 0 never.' },
    { key: 'campaign_max_restarts', type: 'number', default: 5, min: 1, max: 50,
      help: 'Restarts one campaign gets before it waits for Resume.' },
    { key: 'gap_min_seconds', type: 'number', default: 35, min: 0, max: 3600,
      help: 'The gap between two messages is rolled from this range. A constant gap '
          + 'is a metronome, and a metronome is the easiest thing to spot in a '
          + 'request log.' },
    { key: 'gap_max_seconds', type: 'number', default: 95, min: 0, max: 3600,
      help: 'The top of that range.' },
    { key: 'typing_slips', type: 'bool', default: true,
      help: 'Every few words a finger misses - a neighbouring key, or two letters '
          + 'swapped - and the slip is backspaced and retyped. The message that '
          + 'goes is still exactly the draft.' },
    { key: 'typing_wpm', type: 'number', default: 240, min: 40, max: 900,
      help: 'A message is typed key by key at roughly this speed. Setting a 400-'
          + 'character message in one call fires no keydown events at all.' },

    { key: 'fb_comment_limit', type: 'number', default: 20, min: 0, max: 500,
      help: 'Posts each account comments on in one Feed Campaign run. 0 runs until Stop.' },
    { key: 'fb_like', type: 'bool', default: true,
      help: 'Press Like on each post before commenting on it.' },
    { key: 'fb_gap_min_seconds', type: 'number', default: 20, min: 0, max: 3600,
      help: 'The rest after each comment, rolled between the two.' },
    { key: 'fb_gap_max_seconds', type: 'number', default: 60, min: 0, max: 3600,
      help: 'The top of that range.' },
    { key: 'scroll_pause_min', type: 'number', default: 0.6, min: 0, max: 30,
      help: 'The home timeline is loaded by scrolling. This is the shortest '
          + 'pause between scrolls. A scrape does not stop on its own, so this '
          + 'is the whole of how hard it leans on the feed.' },
    { key: 'scroll_pause_max', type: 'number', default: 2.4, min: 0, max: 30,
      help: 'The longest.' },
    { key: 'scrape_followers_max', type: 'number', default: 0, min: 0, max: 100000,
      help: 'Followers scraping: 0 reads each profile\'s whole followers list '
          + 'before going back to Home for the next author. A number stops at '
          + 'that many per profile.' },

    { key: 'skip_no_dm', type: 'bool', default: true,
      help: 'Keep only accounts a message can reach. A scrape passes over - and '
          + 'does not store - a profile whose chat is closed to this account; a '
          + 'campaign skips one too, since opening its composer fails and still '
          + 'counts against the day.' },
    { key: 'skip_protected', type: 'bool', default: true,
      help: 'Pass over protected accounts.' },
    { key: 'stop_on_challenge', type: 'bool', default: true,
      help: 'Stop the run on a captcha or a verification prompt. Carrying on '
          + 'means submitting actions that all silently fail, which is what '
          + 'escalates a challenge into a lock.' },

    { key: 'profile_url', type: 'text', default: 'https://bsky.app/profile/{handle}',
      tokens: ['{handle}', '{id}'],
      help: 'How a handle becomes a profile link. A setting because an account '
          + 'can also be reached by its did:plc identifier at the same path, '
          + 'and a run should not be recompiled to switch.' },
    { key: 'target_defaults', type: 'list', default: '',
      help: 'Targets a fresh sweep starts from when the pool is empty.' },
  ];

  const defaults = () => Object.fromEntries(SCHEMA.map(r => [r.key, r.default]));

  /* Enough sample data that the panels are readable the first time they are
     opened. An empty console cannot be judged — every table looks correct when
     it has nothing in it. */
  const FIRST = ['alex', 'sam', 'jordan', 'riley', 'casey', 'devon', 'noor', 'mika',
                 'priya', 'tom', 'ines', 'kai', 'omar', 'lena', 'ravi', 'zoe',
                 'hugo', 'mei', 'ada', 'juno'];
  const LAST = ['builds', 'codes', 'ships', 'writes', 'dev', 'hq', 'io', 'xyz',
                'labs', 'studio'];
  const BIOS = [
    'building things on the internet',
    'indie hacker · shipping weekly',
    'design systems, mostly',
    'ex-agency, now solo',
    'writing about small software',
    'infra + a bit of frontend',
    'founder. two apps, one dog.',
    'thoughts are my own',
    '',
  ];

  /* Deterministic per index rather than Math.random per row: a table that
     reshuffles itself on every repaint is one nobody can proof-read. */
  const pick = (list, n) => list[Math.abs(n) % list.length];

  function fakeAccount(targetKey, i) {
    const handle = `${pick(FIRST, i * 7 + targetKey.length)}${
      pick(LAST, i * 3)}${i % 5 ? '' : i}`;
    return {
      handle,
      name: pick(FIRST, i * 7 + targetKey.length).replace(/^./, c => c.toUpperCase())
            + ' ' + pick(LAST, i * 3).replace(/^./, c => c.toUpperCase()),
      bio: pick(BIOS, i * 5 + 1),
      followers: [83, 412, 1290, 5600, 240, 18400, 76, 930, 3100, 62000][i % 10],
      dm_open: i % 4 !== 0,               // roughly three in four
      protected: i % 11 === 0,
    };
  }

  /* ── The database ─────────────────────────────────────────── */

  function fresh() {
    return {
      accounts: [],
      secrets: {},            // id -> password, kept out of the list response
      sessions: {},           // id -> { logged_in, active, expires_at }
      rosters: [],            // one per scraped target
      store: [],              // every account ever collected
      drafts: [],
      media: [],
      settings: defaults(),
      logs: [{ at: now(), level: 'info', message: 'store opened (localStorage)' }],
      nextAccount: 1,
    };
  }

  let db;
  try { db = JSON.parse(localStorage.getItem(KEY)) || fresh(); }
  catch { db = fresh(); }
  // A schema that grew since this browser last stored a db: fill the new keys
  // rather than handing the settings panel an undefined to render.
  db.settings = { ...defaults(), ...(db.settings || {}) };

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(db)); }
    catch { /* private mode — the session still works, it just won't persist */ }
  }

  /* ── The activity stream ──────────────────────────────────── */

  const listeners = [];
  function log(source, message, level = 'info') {
    const row = { at: now(), source, message, level };
    db.logs.push(row);
    if (db.logs.length > 400) db.logs.shift();
    listeners.forEach(fn => fn(row));
    save();
  }

  /* ── Tasks ─────────────────────────────────────────────────
     A long run behind an HTTP request: POST starts it and returns an id, the UI
     polls that id. Same contract a real server would need — a scrape takes
     minutes and no request should be held open for it. */

  const tasks = {};

  function startTask(title, step, { interval = 700 } = {}) {
    const id = uid();
    const task = { id, state: 'running', progress: 0, title, detail: '', result: null };
    tasks[id] = task;

    let tick = 0;
    const timer = setInterval(() => {
      if (task.state === 'paused') return;
      if (task.state !== 'running') return clearInterval(timer);
      try {
        const done = step(task, tick++);
        if (done) {
          task.state = 'done';
          task.progress = 1;
          clearInterval(timer);
        }
      } catch (err) {
        task.state = 'failed';
        task.detail = err.message;
        clearInterval(timer);
      }
    }, interval);

    task.cancel = () => { task.state = 'stopped'; clearInterval(timer); };
    return id;
  }

  /* ── Routes ────────────────────────────────────────────────
     [method, pattern, handler]. The pattern is a path with :params; the handler
     gets ({ params, body }) and returns the response body. Throwing an Error is
     how a route reports a 4xx — app.js surfaces the message either way. */

  const routes = [];
  const on = (method, pattern, handler) => routes.push({ method, pattern, handler });

  function match(pattern, path) {
    const p = pattern.split('/');
    const q = path.split('/');
    if (p.length !== q.length) return null;
    const params = {};
    for (let i = 0; i < p.length; i++) {
      if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(q[i]);
      else if (p[i] !== q[i]) return null;
    }
    return params;
  }

  /* ── Accounts ─────────────────────────────────────────────── */

  on('GET', '/api/accounts', () => ({
    accounts: db.accounts.map(a => ({
      id: a.id, label: a.label, login: a.login, email: a.email,
      has_password: !!db.secrets[a.id],
    })),
  }));

  on('POST', '/api/accounts', ({ body }) => {
    const login = String(body.login || '').replace(/^@+/, '').trim();
    if (!login) throw new Error('A handle is required.');
    if (db.accounts.some(a => a.login.toLowerCase() === login.toLowerCase()))
      throw new Error(`@${login} is already on the list.`);
    const id = String(db.nextAccount++);
    db.accounts.push({ id, label: body.label || '', login, email: body.email || '' });
    if (body.password) db.secrets[id] = body.password;
    db.sessions[id] = { logged_in: false, active: false, detail: 'no session' };
    log('accounts', `added @${login}`);
    save();
    return { id };
  });

  on('DELETE', '/api/accounts/:id', ({ params }) => {
    db.accounts = db.accounts.filter(a => a.id !== params.id);
    delete db.secrets[params.id];
    delete db.sessions[params.id];
    log('accounts', `removed account ${params.id}`, 'warn');
    save();
    return { ok: true };
  });

  on('GET', '/api/accounts/:id/secret', ({ params }) => ({
    password: db.secrets[params.id] || '',
  }));

  on('POST', '/api/accounts/:id/open', ({ params }) => {
    const s = db.sessions[params.id] || (db.sessions[params.id] = {});
    s.active = true;
    // A real runner would launch Chrome on that profile here. Nothing is
    // launched — the flag is what the Scraping gate reads, and that is the whole
    // point of the stand-in.
    log('browser', `opened a window on account ${params.id} (simulated)`);
    save();
    return { url: 'https://bsky.app/' };
  });

  // The path the card presses. Same flag as /open, plus a task that is over
  // at once: there is no window here for a sign-in to land in.
  on('POST', '/api/accounts/:id/session', ({ params }) => {
    const s = db.sessions[params.id] || (db.sessions[params.id] = {});
    s.active = true;
    log('browser', `opened a window on account ${params.id} (simulated)`);
    save();
    const task = startTask('signing in', t => { t.detail = 'simulated'; return true; }, { interval: 100 });
    return { task, url: 'https://bsky.app/' };
  });

  on('POST', '/api/accounts/:id/logout', ({ params }) => {
    db.sessions[params.id] = { logged_in: false, active: false, detail: 'no session' };
    log('sessions', `cleared the session on account ${params.id}`, 'warn');
    save();
    return { ok: true };
  });

  on('GET', '/api/accounts/sessions', () => ({
    sessions: db.accounts.map(a => ({
      id: a.id,
      login: a.login,
      label: a.label,
      ...(db.sessions[a.id] || { logged_in: false, active: false, detail: 'no session' }),
    })),
  }));

  on('POST', '/api/accounts/sessions/check', () => {
    let live = 0;
    for (const a of db.accounts) {
      const s = db.sessions[a.id] || (db.sessions[a.id] = {});
      // Whatever has been "opened" counts as signed in. A real check reads the
      // cookie jar.
      if (s.active) {
        s.logged_in = true;
        s.expires_at = new Date(Date.now() + 30 * 864e5).toISOString();
        live++;
      }
    }
    log('sessions', `checked ${db.accounts.length}, ${live} logged in`);
    save();
    return { checked: db.accounts.length, logged_in: live };
  });

  on('POST', '/api/accounts/login', ({ body }) => {
    const ids = body.ids || [];
    // One at a time with a gap, because that is the shape the real one has to
    // take: a burst of simultaneous logins from one IP is the clearest signal
    // that a set of accounts belongs together.
    const task = startTask('logging in', (t, i) => {
      const id = ids[i];
      if (id == null) return true;
      const s = db.sessions[id] || (db.sessions[id] = {});
      s.logged_in = true;
      s.active = true;
      s.expires_at = new Date(Date.now() + 30 * 864e5).toISOString();
      t.progress = (i + 1) / ids.length;
      t.detail = `account ${id}`;
      log('accounts', `logged in account ${id} (simulated)`);
      save();
      return i + 1 >= ids.length;
    }, { interval: 900 });
    return { task };
  });

  /* ── Automation status + the store's health ───────────────── */

  on('GET', '/api/automation/status', () => {
    const open = db.accounts.filter(a => (db.sessions[a.id] || {}).active);
    return {
      browser: { open: open.length > 0, count: open.length, pages: open.length * 2 },
      run: { state: Object.values(tasks).some(t => t.state === 'running') ? 'running' : 'idle' },
    };
  });

  // Always up: the "store" is this tab's localStorage. Kept as an endpoint
  // because the pill and its log are how a real object store reports itself,
  // and a UI that only learns about outages the day one happens is untested.
  on('GET', '/api/store/health', () => ({ up: true, kind: 'localStorage' }));
  on('GET', '/api/store/logs', () => ({ logs: db.logs.slice(-200) }));

  /* ── Sweeps ───────────────────────────────────────────────── */

  /* The one page a scrape walks. There is no target to pick and no list to
     choose between — the real thing scrolls the signed-in account's own feed —
     so the stand-in keeps the target shape and fills it in with the feed. */
  const HOME_TARGET = { key: 'inbox', name: 'Chats', mode: 'inbox',
                        note: 'the feed of the account it runs as' };
  const MODE = 'home';
  const GROUPS_TARGET = { key: 'groups', name: 'FB groups', mode: 'groups',
                          note: 'the members of every group the account is in' };
  const FRAME_ROWS = 500;

  let sweep = { target: null, rows: [], done: [], task: null };

  function sweepState(extra = {}) {
    return {
      target: sweep.target,
      mode: MODE,
      // The tail, plus the true count. A walk that does not stop outgrows
      // anything a table can paint, and the real server answers the same shape.
      rows: sweep.rows.slice(-FRAME_ROWS),
      total: sweep.rows.length,
      done: sweep.done,
      ...extra,
    };
  }

  function sweepRunning() {
    const task = tasks[sweep.task];
    return task && (task.state === 'running' || task.state === 'paused') ? task : null;
  }

  /* The real walk: scrolling Home and hovering every new author happens in
     the account's Chrome window, which only the server has. Its frames come
     back through the task poll and are mirrored into the rosters and the
     store here, so the Data panel lists what the window found. */
  const HOME_FEED = { key: 'home', name: 'Home feed', mode: 'feed' };
  const SERVER_WALKS = ['home', 'followers'];   // the walks the server does
  let serverRun = false;    // the server has (or had) a walk this page saw

  function mergeRoster(fr) {
    const rows = (fr.rows || []).filter(r => r && r.handle);
    if (!rows.length) return;
    const tg = fr.target && fr.target.key ? fr.target : HOME_FEED;
    const key = `${tg.key}-${tg.mode}`;
    const by = (fr.lanes || []).map(l => l.account).filter(Boolean).join(', ') || 'server';
    let roster = db.rosters.find(r => r.key === key);
    if (!roster) {
      roster = { key, target: tg.name, mode: tg.mode, at: now(), by, accounts: [] };
      db.rosters = [roster, ...db.rosters];
    }
    const have = new Map(roster.accounts.map(a => [String(a.handle).toLowerCase(), a]));
    let changed = false;
    for (const r of rows) {
      const k = String(r.handle).toLowerCase();
      if (have.has(k)) continue;
      const row = clone(r);
      roster.accounts.push(row); have.set(k, row); changed = true;
      const existing = db.store.find(x => String(x.handle).toLowerCase() === k);
      if (existing) {
        if (!existing.targets.includes(tg.name)) existing.targets.push(tg.name);
        existing.name = existing.name || r.name;
        existing.bio = existing.bio || r.bio;
        if (r.followers != null) existing.followers = r.followers;
        if (r.dm_open != null) existing.dm_open = r.dm_open;
      } else {
        db.store.push({ ...clone(r), targets: [tg.name], messaged: false, msg_count: 0, at: now() });
      }
    }
    if (changed) { roster.at = now(); roster.by = by; save(); }
  }

  on('POST', '/api/scrape/sweep', async ({ body }) => {
    const source = (body && body.source) || 'feed';
    if ((source === 'feed' || source === 'followers') && server !== false) {
      if (sweepRunning()) throw new Error('A scrape is already running — stop that one first.');
      const st = db.settings || {};
      const out = await fromServer('/api/scrape/sweep', 'POST', {
        sessions: body.sessions || [], source,
        settings: { scroll_pause_min: st.scroll_pause_min, scroll_pause_max: st.scroll_pause_max,
                    scrape_stall_seconds: st.scrape_stall_seconds,
                    scrape_followers_max: st.scrape_followers_max,
                    skip_no_dm: st.skip_no_dm !== false },
      });
      serverRun = true;
      log('scrape', source === 'followers'
        ? 'opening authors off the home feed and reading their followers'
        : 'walking the home feed — hovering every new author for the profile card');
      return out;
    }
    const openAccount = db.accounts.find(a => (db.sessions[a.id] || {}).active);
    if (!openAccount) throw new Error('No browser window is open.');
    if (sweepRunning()) throw new Error('A scrape is already running — stop that one first.');

    const groups = (body && body.source) === 'groups';
    sweep.target = groups ? { ...GROUPS_TARGET } : { ...HOME_TARGET };
    sweep.rows = [];

    // No end condition. The real walk scrolls Home until Stop is pressed, and a
    // stand-in that quietly finished on its own would be testing a different
    // panel from the one that ships.
    const task = startTask('scraping the home timeline', (t, i) => {
      for (let n = 0; n < 6; n++) {
        const acct = fakeAccount(MODE, sweep.rows.length);
        // Every new account is hovered — that is not an option in the real one
        // either — so the card is always filled.
        acct.card = `${acct.name}
@${acct.handle}
${acct.bio}
`
                  + `${acct.followers} Followers`;
        acct.dm_open = null;              // only a profile load can say
        // Group members come off a People page: a name and a handle, no bio.
        if (groups) { acct.bio = ''; acct.card = ''; acct.followers = null; }
        sweep.rows.push(acct);
      }
      if (sweep.rows.length % 24 < 6) storeRoster(HOME_TARGET, MODE, sweep.rows, openAccount);

      t.detail = `${sweep.rows.length} accounts off the ${groups ? 'groups' : 'feed'}`;
      // A heartbeat, not a fraction: there is no denominator to be a fraction of.
      t.progress = (sweep.rows.length % 100) / 100;
      t.result = sweepState();
      return false;
    });

    sweep.task = task;
    tasks[task].result = sweepState();
    log('scrape', 'walking the home timeline — hovering every new account');
    return { task };
  });

  // The windows a scrape can run on - the chips on the Scraping panel.
  on('GET', '/api/scrape/accounts', () => ({
    accounts: db.accounts.filter(a => (db.sessions[a.id] || {}).active).map(a => ({
      id: String(a.id), account: '@' + a.login, label: a.label || '', busy: '',
    })),
  }));

  // Refresh: four "new" groups turn up from Bluesky, one every 800ms.
  let groupsRefresh = null;
  const groupsGone = new Set();
  on('POST', '/api/scrape/groups/delete', ({ body }) => {
    (body.group_ids || []).forEach(id => groupsGone.add(String(id)));
    return { ok: true, removed: (body.group_ids || []).length };
  });

  on('POST', '/api/scrape/groups/refresh', () => {
    groupsRefresh = { started: Date.now() };
    return { task: 'mock-refresh', minio: { ok: false, reason: 'no MinIO in the mock' } };
  });

  on('GET', '/api/scrape/groups', ({ query }) => {
    const wanted = (query.get('sessions') || '').split(',').filter(Boolean);
    const open = db.accounts.filter(a => (db.sessions[a.id] || {}).active
                                    && (!wanted.length || wanted.includes(String(a.id))));
    const names = ['Buy & Sell Lahore', 'Heavy Equipment Traders', 'Model Town Community',
                   'Freelance Pakistan', 'Askari 11 Lahore', 'Car pooling',
                   // enough to page through, the way a real account's list does
                   ...Array.from({ length: 22 }, (_, i) => `Lahore Traders ${i + 1}`)];
    let refresh = { state: '', note: '' };
    if (groupsRefresh) {
      const got = Math.min(4, Math.floor((Date.now() - groupsRefresh.started) / 800));
      for (let i = 0; i < got; i++) names.push(`New group ${i + 1}`);
      refresh = got < 4 ? { state: 'running', note: `${got} groups so far - scrolling the list for more` }
                        : { state: 'done', note: '10 group(s) read from Bluesky' };
    }
    return {
      accounts: open.map(a => ({ id: String(a.id), label: '@' + a.login,
        checked: !!groupsRefresh, synced_at: groupsRefresh ? now() : '',
        rows: names.map((name, i) => ({ group_id: `mock${a.id}-${i + 1}`, name: `${name} (${a.login})`,
          url: `https://bsky.app/groups/mock${i + 1}/`,
          scraped_at: i < 2 ? now() : '', scraped_members: i < 2 ? 120 + i * 37 : 0 })) })),
      scraped: open.flatMap(a => names.slice(0, 2).map((name, i) => ({
        group_id: `mock${a.id}-${i + 1}`, name: `${name} (${a.login})`,
        url: `https://bsky.app/groups/mock${a.id}-${i + 1}/`,
        account_id: String(a.id), account: '@' + a.login,
        scraped_at: now(), scraped_members: 120 + i * 37,
        members_total: 900 + i * 1200 })))
        .filter(g => !groupsGone.has(g.group_id)),
      minio: { ok: false, reason: 'no MinIO in the mock' },
      refresh,
    };
  });

  on('POST', '/api/scrape/stop', async () => {
    const task = sweepRunning();
    if (!task && server !== false) {
      const out = await fromServer('/api/scrape/stop', 'POST', {});
      mergeRoster(out);
      log('scrape', 'scrape ended by the operator', 'warn');
      return out;
    }
    if (!task) throw new Error('No scrape is running.');
    task.cancel();
    const openAccount = db.accounts.find(a => (db.sessions[a.id] || {}).active);
    if (sweep.rows.length && openAccount) {
      storeRoster(HOME_TARGET, MODE, sweep.rows, openAccount);
      sweep.done.unshift({
        key: HOME_TARGET.key, name: HOME_TARGET.name, mode: MODE,
        count: sweep.rows.length, by: '@' + openAccount.login,
      });
    }
    task.result = sweepState();
    log('scrape', 'scrape ended by the operator', 'warn');
    return sweepState({ note: 'Stopping — it finishes the account it is on.' });
  });

  on('GET', '/api/scrape/status', async () => {
    const task = sweepRunning();
    if (!task && server !== false) {
      // The server's walk, if it has one going or has rows from the last: a
      // page reloaded mid-run finds it again here.
      try {
        const fr = await fromServer('/api/scrape/status');
        if (fr.running || fr.total) { serverRun = true; mergeRoster(fr); return fr; }
      } catch { /* the server is away - the local state stands */ }
    }
    return sweepState({ task: task ? task.id : null, running: !!task });
  });

  /* A roster is per target AND per mode: the followers of an account and the
     likers of its post are two different lists, and merging them under one key
     would make the Data panel lie about where a handle came from. */
  function storeRoster(target, mode, rows, by) {
    const key = `${target.key}-${mode}`;
    const roster = {
      key, target: target.name, mode, at: now(),
      by: '@' + by.login,
      accounts: clone(rows),
    };
    db.rosters = [roster, ...db.rosters.filter(r => r.key !== key)];

    // The account store overlaps the rosters BY DESIGN — same reason meetup-bot
    // kept two tables. The roster says who came off one target on one day; the
    // store says who has ever been seen, which is what a campaign draws from.
    for (const a of rows) {
      const existing = db.store.find(r => r.handle === a.handle);
      if (existing) {
        if (!existing.targets.includes(target.name)) existing.targets.push(target.name);
        existing.name = existing.name || a.name;
        existing.bio = existing.bio || a.bio;
        existing.followers = a.followers;
        existing.dm_open = a.dm_open;
      } else {
        db.store.push({ ...clone(a), targets: [target.name], messaged: false,
                        msg_count: 0, at: now() });
      }
    }
    save();
  }

  on('POST', '/api/scrape/members', () => {
    if (sweepRunning()) throw new Error('The scrape is still running — stop it first.');
    if (!sweep.target) throw new Error('Nothing has been scraped yet.');
    const task = startTask('re-reading accounts', (t, i) => {
      // Opening each profile is what fills in the one thing the hover card
      // cannot say — whether the inbox is open. Here it just re-rolls the rows.
      sweep.rows = sweep.rows.map((r, n) => ({ ...r, ...fakeAccount(MODE, n) }));
      t.progress = Math.min(1, (i + 1) / 4);
      t.detail = `${sweep.rows.length} profiles`;
      t.result = sweepState();
      return i >= 3;
    });
    return { task };
  });

  on('POST', '/api/scrape/open-all', () => {
    const total = sweep.rows.length;
    if (!total) throw new Error('Nothing to open.');
    const task = startTask('opening profiles', (t, i) => {
      const done = Math.min(total, (i + 1) * 5);
      t.progress = done / total;
      t.detail = `${done} of ${total}`;
      t.result = sweepState();
      return done >= total;
    });
    return { task };
  });

  on('POST', '/api/scrape/close-tabs', () => {
    log('browser', 'closed the profile tabs');
    return { ok: true };
  });

  on('POST', '/api/scrape/reset', async () => {
    if (sweepRunning()) throw new Error('The scrape is still running — stop it first.');
    if (serverRun) { await fromServer('/api/scrape/reset', 'POST', {}); serverRun = false; }
    sweep = { target: null, rows: [], done: [], task: null };
    log('scrape', 'run reset', 'warn');
    return { ok: true };
  });

  /* ── Actions — Bluesky's own rail ────────────────────────
     No browser to drive here, so a press is just a line in the feed. The order
     is Bluesky's rail, top to bottom, which is the order Click all walks. */

  const ACTIONS = [
    ['home', 'Home'], ['search', 'Search'], ['chats', 'Chat'],
    ['requests', 'Notifications'], ['marketplace', 'Feeds'], ['archive', 'Lists'],
    ['groups', 'Starter packs'], ['new', 'New post'],
    ['profile', 'Profile'], ['settings', 'Settings'],
    // Not one of Bluesky's rail items: the way out of the panel one of them opened.
    ['close', 'Close'],
  ];
  const ACTION_LABEL = Object.fromEntries(ACTIONS);

  on('GET', '/api/actions', () => ({
    actions: ACTIONS.map(([key, label]) => ({ key, label })),
  }));

  on('POST', '/api/actions/click', ({ body }) => {
    const key = String(body.action || '');
    const label = ACTION_LABEL[key];
    if (!label) throw new Error(`${key || 'nothing'} is not a menu item this can press.`);
    if (!db.accounts.some(a => (db.sessions[a.id] || {}).active))
      throw new Error('No browser window is open.');
    log('actions', `pressed ${label} (simulated)`);
    // The real one clears whatever is covering the page before each press, and
    // closes again after an item marked as opening one. There is no page here,
    // so the results are the two words the server would answer with.
    if (key === 'close') return { ok: true, action: key, result: 'nothing open' };
    return { ok: true, action: key,
             result: key === 'premium' ? 'clicked and closed' : 'clicked' };
  });

  /* The four on the Actions panel's Bluesky card, pressed one at a time. */
  const MSG_ACTIONS = ['chats', 'marketplace', 'requests', 'archive', 'menu', 'sidebar'];
  const MSG_LABEL = { ...ACTION_LABEL, menu: 'Settings menu', sidebar: 'Chat sidebar' };
  const MSG_TWICE = ['menu', 'sidebar'];

  on('GET', '/api/actions/messenger', () => ({
    actions: MSG_ACTIONS.map(key => ({ key, label: MSG_LABEL[key] })),
    windows: db.accounts.filter(a => (db.sessions[a.id] || {}).active)
      .map(a => ({ id: String(a.id), label: '@' + a.login })),
  }));

  on('POST', '/api/actions/messenger/click', ({ body }) => {
    const key = String(body.action || '');
    if (!MSG_ACTIONS.includes(key))
      throw new Error(`${key || 'nothing'} is not a Bluesky item this can press.`);
    if (!db.accounts.some(a => (db.sessions[a.id] || {}).active))
      throw new Error('No browser window is open - open an account from the Accounts panel first.');
    const twice = MSG_TWICE.includes(key);
    log('actions', `clicked ${MSG_LABEL[key]}${twice ? ' twice' : ''} (simulated)`);
    return { ok: true, action: key, label: MSG_LABEL[key], result: twice ? 'clicked twice' : 'clicked' };
  });

  on('POST', '/api/actions/all', () => {
    if (!db.accounts.some(a => (db.sessions[a.id] || {}).active))
      throw new Error('No browser window is open.');
    const task = startTask('clicking every menu item', (t, i) => {
      const [key, label] = ACTIONS[i] || [];
      if (!label) return true;
      t.detail = label;
      t.progress = (i + 1) / ACTIONS.length;
      log('actions', `clicked ${label} (simulated)`);
      return i + 1 >= ACTIONS.length;
    }, { interval: 500 });
    return { task };
  });

  /* ── Group Posting ───────────────────────────────────────── */
  const grp = { state: 'idle', account: '', account_id: '', note: '', count: 0,
                visited: 0, posted: 0, text: '', media: [], groups: [] };
  const grpStatus = () => ({ ...grp, groups: [...grp.groups],
    windows: db.accounts.filter(a => (db.sessions[a.id] || {}).active)
      .map(a => ({ id: String(a.id), label: '@' + a.login })),
    saved: {} });
  on('GET', '/api/groups/status', () => grpStatus());
  /* Joining groups, the other half of the Group Posting panel. */
  const gj = { task: '', state: 'idle', account: '', note: '', joined: 0, tried: 0,
               want: 0, names: [], rows: [] };
  const gjStatus = () => ({ ...gj, names: [...gj.names], rows: gj.rows.map(r => ({ ...r })),
    min: 5, max: 10,
    windows: db.accounts.filter(a => (db.sessions[a.id] || {}).active)
      .map(a => ({ id: String(a.id), label: '@' + a.login })) });
  on('GET', '/api/groups/join/status', () => gjStatus());
  on('POST', '/api/groups/join', ({ body }) => {
    const a = db.accounts[0];
    if (!a) throw new Error('There are no accounts yet - add one on the Accounts panel first.');
    const want = Math.max(1, Math.min(50, parseInt(body && body.min, 10) || 5));
    Object.assign(gj, { state: 'running', account: '@' + a.login, note: 'Opening Bluesky.',
                        joined: 0, tried: 0, want, names: [], rows: [] });
    const names = ['Buy & Sell Lahore', 'Heavy Equipment Traders', 'Model Town Community',
                   'Freelance Pakistan', 'Construction Machinery'];
    const task = startTask('joining groups', (t, i) => {
      const name = names[i % names.length] + (i >= names.length ? ' ' + (i + 1) : '');
      gj.tried += 1;
      // One that will not let itself be joined, so the feed has both answers.
      const ok = i !== 1;
      if (ok) { gj.joined += 1; gj.names.push(name); }
      gj.rows.push({ name, ok, note: ok ? (i === 3 ? 'requested' : 'joined')
                                        : 'the card still says Join Group' });
      gj.note = ok ? `joined "${name}"` : `could not join "${name}"`;
      log('groups', `${ok ? 'joined' : 'could not join'} "${name}" (simulated)`, ok ? 'info' : 'warn');
      t.progress = gj.joined / Math.max(1, want);
      t.result = gjStatus();
      if (gj.joined >= want) {
        gj.state = 'done';
        gj.note = `Finished - joined ${gj.joined} of ${want} group(s).`;
        t.result = gjStatus();
        return true;
      }
      return false;
    }, { interval: 700 });
    // The id goes on the state FIRST: spreading the state after it would put
    // the state's own empty `task` back over the top of it, which is how the
    // panel ended up watching a run with no id.
    gj.task = task;
    return { task, ...gjStatus() };
  });
  on('POST', '/api/groups/join/stop', () => {
    gj.state = 'stopped'; gj.note = 'Stopped.'; return gjStatus();
  });

  /* The groups registry that fb-groups.txt mirrors, per account. */
  const MOCK_GROUPS = ['Freelancers Hub', 'Startup Founders', 'Remote Jobs Daily', 'Tech Talk',
                       'Buy & Sell Lahore', 'Model Town Community'];
  const grpReg = {};                  // account id -> [{group_id, name, url, used_count, last_posted}]
  const regFor = (id) => grpReg[id] || (grpReg[id] = MOCK_GROUPS.map((name, i) => ({
    group_id: `mock${i + 1}`, name, url: `https://bsky.app/groups/mock${i + 1}/`,
    // Two already posted in, so Skip has something to skip.
    used_count: i === 1 ? 2 : i === 4 ? 1 : 0,
    last_posted: i === 1 || i === 4 ? now() : '', joined_at: '' })));
  on('GET', '/api/groups/list', () => {
    const a = db.accounts[0];
    if (!a) throw new Error('There are no accounts yet - add one on the Accounts panel first.');
    return { account: '@' + a.login, account_id: String(a.id), rows: regFor(String(a.id)),
             minio: { ok: false, reason: 'no MinIO in the mock' } };
  });

  on('POST', '/api/groups/joined', ({ body }) => {
    const a = db.accounts[0];
    if (!a) throw new Error('There are no accounts yet - add one on the Accounts panel first.');
    const text = String((body && body.text) || '').trim();
    const media = (body && body.media) || [];
    Object.assign(grp, { state: 'running', account: '@' + a.login, account_id: String(a.id),
                         note: 'Opening Bluesky.', count: 0, visited: 0, posted: 0,
                         text, media, groups: [] });
    const only = Array.isArray(body && body.only) ? new Set(body.only) : null;
    if (only && !only.size) throw new Error('Choose at least one group to post in.');
    const reg = regFor(String(a.id));
    const chosen = reg.filter(r => !only || only.has(r.group_id));
    const names = chosen.map(r => r.name);
    // Interleaved, as the real one is: found, then opened, then the next.
    const task = startTask('going through the joined groups', (t, i) => {
      const at = Math.floor(i / 2);
      if (i % 2 === 0) {
        grp.groups.push({ name: names[at], url: chosen[at].url,
                          visited: '', closed: 0, how: '', posted: '', said: '' });
        grp.count = grp.groups.length;
        grp.note = `found "${names[at]}" (${grp.count}) - opening it`;
      } else {
        const g = grp.groups[at];
        const shut = at === 1 ? 1 : 0;
        g.visited = 'yes';
        g.closed = shut;
        g.how = shut ? `clicked, closed ${shut} panel(s)` : 'clicked';
        grp.visited += 1;
        grp.note = `opened "${g.name}"`;
        if (grp.text || grp.media.length) {
          // One group that will not take a post, so the column has both answers.
          const no = at === 2;
          g.posted = no ? 'no' : 'yes';
          g.said = no ? 'this group has no box to write in - it may not let this account post'
                      : (at === 3 ? 'posted - waiting for an admin to approve it' : 'posted');
          if (!no) {
            grp.posted += 1;
            chosen[at].used_count += 1;
            chosen[at].last_posted = now();
          }
          grp.note = `${g.said} in "${g.name}"`;
        }
      }
      t.result = grpStatus();
      if (i + 1 >= names.length * 2) {
        grp.state = 'done';
        grp.note = `Finished - ${grp.count} group(s), ${grp.visited} opened`
          + ((grp.text || grp.media.length) ? `, posted in ${grp.posted}.` : '.');
        t.result = grpStatus();
        return true;
      }
      return false;
    }, { interval: 450 });
    return { task, ...grpStatus() };
  });
  on('POST', '/api/groups/stop', () => { grp.state = 'stopped'; grp.note = 'Stopped.'; return grpStatus(); });

  on('POST', '/api/app/reset', () => {
    const stopped = [];
    for (const t of Object.values(tasks)) {
      if (t.state === 'running' || t.state === 'paused') {
        stopped.push(t.title);
        if (t.cancel) t.cancel(); else t.state = 'stopped';
      }
    }
    log('server', 'app reset (simulated)', 'warn');
    return { ok: true, stopped, waited_on: stopped.length, still_going: [] };
  });

  on('GET', '/api/tasks/:id', ({ params }) => {
    const t = tasks[params.id];
    if (!t) throw new Error('That run is no longer on the server.');
    const { cancel, ...rest } = t;
    return rest;
  });

  /* ── Data ─────────────────────────────────────────────────── */

  /* A handful of the labels the server derives from a bio, so the Data panel's
     category column and its picker have something to show. The real rule set is
     `backend/classify.py`; this is a stand-in, and it says so by being a
     keyword each rather than the ordered patterns the server carries. */
  const CATEGORIES = [
    ['Real estate', /real ?estate|apartment|broker|property/i],
    ['Crypto', /crypto|bitcoin|web ?3|nft/i],
    ['AI', /ai|machine learning|llm/i],
    ['Tech', /developer|engineer|software|saas|indie ?hack/i],
    ['Marketing', /marketing|seo|growth|copywrit/i],
    ['Design', /designer|design|ux/i],
    ['Business', /founder|ceo|entrepreneur|startup/i],
  ];
  const categorize = (bio, name) => {
    const text = `${bio || ''} ${name || ''}`;
    for (const [label, re] of CATEGORIES) if (re.test(text)) return label;
    return '';
  };

  /* What the server has on disk from every walk, folded in first: a page
     opened after a restart still lists what earlier runs found. */
  /* The server's scraped record was wiped: the copy this page mirrored from
     it goes too. Rows that came from somewhere else (uploaded, imported from
     MinIO) only lose the scrape as a source, and stay if that was not all. */
  function dropMirrored() {
    const walks = new Set(SERVER_WALKS.map(k => (k === 'home' ? HOME_FEED.name : 'Followers')));
    db.rosters = db.rosters.filter(r => !SERVER_WALKS.includes(String(r.key).split('-')[0]));
    db.store = db.store.filter(r => {
      r.targets = (r.targets || []).filter(t => !walks.has(t));
      return r.targets.length > 0;
    });
    save();
  }

  async function pullServerRows() {
    if (server === false) return;
    try {
      const got = await fromServer('/api/scrape/rows');
      if (got.cleared_at && got.cleared_at !== db.scrapeClearedAt) {
        dropMirrored();
        db.scrapeClearedAt = got.cleared_at;
        save();
        log('data', 'scraped handles were cleared on the server — the copy here is dropped', 'warn');
      }
      mergeRoster(got);
    } catch { /* server away */ }
  }

  on('POST', '/api/scrape/clear', async () => {
    const out = await fromServer('/api/scrape/clear', 'POST', {});
    dropMirrored();
    db.scrapeClearedAt = out.cleared_at; save();
    log('data', `cleared ${out.removed} scraped handle(s) everywhere`, 'warn');
    return out;
  });

  on('GET', '/api/data/rosters', async () => ({
    rosters: (await pullServerRows(), db.rosters).map(r => ({
      ...r,
      // Derived on the way out, exactly as the server does it: retuning the
      // rules re-labels everything already collected, with no re-scrape.
      accounts: (r.accounts || []).map(a => ({ ...a, category: categorize(a.bio, a.name) })),
    })),
  }));

  on('GET', '/api/data/categories', () => ({ categories: CATEGORIES.map(([c]) => c) }));

  /* The object store, with nothing behind it.

     There is no MinIO in a browser tab, and pretending otherwise would be the
     one thing this stand-in must not do — every route here answers the real
     contract, and the honest answer to "is a bucket reachable from this tab" is
     no. So the pill reports NOT CONFIGURED, which is a real state the server can
     be in too, and the send button says why it cannot. */
  on('GET', '/api/minio/status', () => ({
    configured: false, up: false, bucket: null,
    detail: 'no object store behind the stand-in',
  }));

  on('POST', '/api/data/rosters/:key/minio', ({ params }) => {
    const roster = db.rosters.find(r => r.key === params.key);
    if (!roster) throw new Error('That roster is no longer saved.');
    return fromServer('/api/scrape/minio/push', 'POST',
                      { handles: roster.accounts.map(a => a.handle) });
  });

  on('DELETE', '/api/data/rosters/:key', ({ params }) => {
    db.rosters = db.rosters.filter(r => r.key !== params.key);
    log('data', `deleted roster ${params.key}`, 'warn');
    save();
    return { ok: true };
  });

  on('DELETE', '/api/data/activity', () => {
    db.logs = [];
    save();
    return { ok: true };
  });

  /* ── The account store ────────────────────────────────────── */

  /* Labelled and tallied on the way out, exactly as the server does it: the
     category is derived from the bio rather than stored, and `msg_count`
     falls back to the old yes/no flag so a store written before sends were
     counted still answers "messaged once". */
  on('GET', '/api/store/accounts', async () => ({
    rows: (await pullServerRows(), db.store).map(r => ({
      ...r,
      category: categorize(r.bio, r.name),
      msg_count: Number(r.msg_count || 0) || (r.messaged ? 1 : 0),
    })),
  }));

  /* Out of the store for good, by handle - the row's own delete button. Kept
     in step with the server's route so the demo can be clicked through: a
     button that works against the real backend and throws against the mock is
     worse than no demo of it at all. */
  on('POST', '/api/store/accounts/delete', ({ body }) => {
    const wanted = new Set((body.handles || [])
      .map(h => String(h).replace(/^@+/, '').trim().toLowerCase())
      .filter(Boolean));
    if (!wanted.size) throw new Error('No handles to delete.');
    const before = db.store.length;
    db.store = db.store.filter(r => !wanted.has(String(r.handle || '').toLowerCase()));
    const removed = before - db.store.length;
    if (!removed) throw new Error('Nothing in the store matched that.');
    return { ok: true, removed };
  });

  /* The store's own send. There is no bucket behind a browser tab, so it fails
     the way the server does with nothing configured - see the note on
     /api/minio/status above. */
  on('POST', '/api/store/accounts/minio', ({ body }) =>
    fromServer('/api/scrape/minio/push', 'POST', { handles: body.handles || [] }));

  /* The handles file off MinIO, folded into the store: new handles are added,
     and a stored row with no name or bio takes the file's. */
  on('POST', '/api/store/accounts/minio/import', async () => {
    const got = await fromServer('/api/scrape/minio/import', 'POST', {});
    let added = 0, refreshed = 0;
    for (const r of got.rows || []) {
      const handle = String(r.handle || '').replace(/^@+/, '').trim();
      if (!handle) continue;
      const existing = db.store.find(x => String(x.handle).toLowerCase() === handle.toLowerCase());
      if (existing) {
        let touched = false;
        if (!existing.name && r.name) { existing.name = r.name; touched = true; }
        if (!existing.bio && r.bio) { existing.bio = r.bio; touched = true; }
        if (existing.followers == null && r.followers != null) { existing.followers = r.followers; touched = true; }
        if (!existing.targets.includes('minio')) existing.targets.push('minio');
        if (touched) refreshed++;
      } else {
        db.store.push({ handle, name: r.name || '', bio: r.bio || '', followers: r.followers ?? null,
                        dm_open: r.dm_open ?? true, targets: ['minio'], messaged: false,
                        msg_count: 0, at: now() });
        added++;
      }
    }
    save();
    log('data', `${added} new handle(s) from ${got.bucket}/${got.object}`);
    return { added, refreshed, total: (got.rows || []).length, bucket: `${got.bucket}/${got.object}` };
  });

  /* The insta messages file on MinIO, as drafts - read through the server,
     which is where the MinIO login is. Read-only: drafts edited here are kept
     in this console, and the file on MinIO is changed on MinIO. */
  on('GET', '/api/messages/minio', () => fromServer('/api/minio/messages'));
  on('POST', '/api/messages/minio', () => {
    throw new Error('saved here only - the insta messages file is edited on MinIO');
  });

  on('POST', '/api/store/accounts/import', ({ body }) => {
    let added = 0;
    for (const row of body.rows || []) {
      const handle = String(row.handle || '').replace(/^@+/, '').trim();
      if (!handle || db.store.some(r => r.handle === handle)) continue;
      db.store.push({
        handle, name: row.name || '', bio: '', followers: null,
        // Unknown, not closed. A file of handles says nothing about inboxes, and
        // marking them shut would hide every one of them behind the Open DMs
        // filter the moment it was ticked.
        dm_open: true,
        targets: ['uploaded'], messaged: false, msg_count: 0, at: now(),
      });
      added++;
    }
    log('data', `imported ${added} handles`);
    save();
    return { added };
  });

  on('POST', '/api/store/accounts/names', () => {
    let filled = 0;
    for (const row of db.store) {
      if (row.name) continue;
      const found = db.rosters.flatMap(r => r.accounts).find(a => a.handle === row.handle);
      if (found && found.name) { row.name = found.name; filled++; }
    }
    save();
    return { filled };
  });

  /* ── Messages and media ───────────────────────────────────── */

  on('GET', '/api/messages', () => ({ drafts: db.drafts }));

  on('POST', '/api/messages', ({ body }) => {
    db.drafts = (body.drafts || []).map(d => ({
      name: d.name || 'draft', text: d.text || '', enabled: d.enabled !== false,
    }));
    log('data', `saved ${db.drafts.length} drafts`);
    save();
    return { drafts: db.drafts };
  });

  /* The library: pictures uploaded here, plus every picture in the insta media
     bucket on MinIO - listed live, not copied, so a file added to the bucket is
     in the Campaign panel on the next load. MinIO being down only leaves its
     half out; the pill says why. */
  on('GET', '/api/media', async () => {
    let remote = [];
    try { remote = (await fromServer('/api/minio/media')).media || []; } catch { /* pill says why */ }
    const local = new Set(db.media.map(m => m.name));
    return { media: db.media.concat(remote.filter(m => !local.has(m.name))) };
  });

  on('POST', '/api/media/minio/pull', async () => {
    const got = await fromServer('/api/minio/media');
    log('data', `${got.media.length} picture(s) in ${got.bucket}/${got.prefix}`);
    return { pulled: got.media.length, skipped: got.skipped,
             bucket: `${got.bucket}/${got.prefix}` };
  });

  /* ── Campaign ─────────────────────────────────────────────── */

  let campaign = { lanes: [], state: '', note: '', task: null };

  /* Deal the send out without sending it, the way the server does - the same
     shuffled bag, so a draft is used about as often as its neighbours and the
     ORDER is what is unpredictable. */
  function dealer(items) {
    let bag = [];
    return () => {
      if (!items.length) return '';
      if (!bag.length) {
        bag = [...items];
        for (let i = bag.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [bag[i], bag[j]] = [bag[j], bag[i]];
        }
      }
      return bag.pop();
    };
  }

  function planLanes(body) {
    const accounts = body.accounts || [];
    const recipients = body.recipients || [];
    if (!accounts.length) throw new Error('Pick an account to send from.');
    if (!recipients.length) throw new Error('No recipients.');

    // Names or {name, text} objects, as the real server takes them.
    const drafts = body.skip_messages ? []
      : (body.drafts || []).map(d => (typeof d === 'string' ? { name: d, text: '' } : d));
    const media = body.skip_media ? [] : (body.media || []);
    if (!body.skip_messages && !drafts.length) {
      throw new Error('No draft selected - tick Skip messages to send without one.');
    }
    const drawDraft = dealer(drafts);
    const drawMedia = dealer(media);

    const lanes = accounts.map(id => {
      const a = db.accounts.find(x => x.id === id);
      return { account: a ? '@' + a.login : id, id, rows: [] };
    });
    recipients.forEach((handle, i) => {
      const row = db.store.find(r => r.handle === handle) || { handle };
      // The accounts stay round-robin: which text somebody gets has no wrong
      // answer, which account sends it is a daily cap.
      const dealt = drawDraft();
      lanes[i % lanes.length].rows.push({
        handle,
        name: row.name || '',
        draft: dealt ? dealt.name : '',
        text: dealt ? dealt.text : '',
        media: drawMedia() || '',
        status: 'pending',
        why: '',
      });
    });
    return lanes;
  }

  /* The real send happens in the account's Chrome window, which only the
     server has: New chat, the handle searched, the first result, the dealt
     message typed, the picture pasted, Send. These paths go to the server
     when it answers; its frames come back through the task poll, and a row
     that reaches `sent` counts one more message against that handle in the
     store here, which is what the recipients picker filters on. */
  const campaignSettings = () => {
    const st = db.settings || {};
    return { click_send: st.click_send !== false, gap_min_seconds: st.gap_min_seconds,
             gap_max_seconds: st.gap_max_seconds, typing_wpm: st.typing_wpm,
             typing_slips: st.typing_slips !== false,
             parallel_tabs: st.parallel_tabs, media_via_post: st.media_via_post === true,
             batch_min_messages: st.batch_min_messages, batch_max_messages: st.batch_max_messages,
             break_min_minutes: st.break_min_minutes,
             break_max_minutes: st.break_max_minutes, break_actions: st.break_actions };
  };
  const mirroredSends = new Set();     // `${task}:${handle}` already tallied
  function mirrorSends(fr) {
    if (!fr || !Array.isArray(fr.lanes)) return;
    let changed = false;
    for (const lane of fr.lanes) {
      for (const r of lane.rows || []) {
        if (r.status !== 'sent') continue;
        const key = `${fr.task || 'srv'}:${String(r.handle).toLowerCase()}`;
        if (mirroredSends.has(key)) continue;
        mirroredSends.add(key);
        const stored = db.store.find(x => String(x.handle).toLowerCase() === String(r.handle).toLowerCase());
        if (stored) {
          stored.msg_count = (Number(stored.msg_count || 0) || (stored.messaged ? 1 : 0)) + 1;
          stored.messaged = true;
          changed = true;
        }
      }
    }
    if (changed) save();
  }
  /* The Feed Campaign runs in the account windows, which only the server
     has. Start goes there with the settings it paces itself by; status and
     stop are real paths above. */
  on('POST', '/api/fb/start', async ({ body }) => {
    if (server === false) throw new Error('This needs the server - start it with run.py');
    const st = db.settings || {};
    return fromServer('/api/fb/start', 'POST', { ...(body || {}), settings: {
      fb_comment_limit: st.fb_comment_limit, fb_like: st.fb_like !== false,
      fb_gap_min_seconds: st.fb_gap_min_seconds, fb_gap_max_seconds: st.fb_gap_max_seconds,
      typing_wpm: st.typing_wpm, typing_slips: st.typing_slips !== false,
      scroll_pause_min: st.scroll_pause_min, scroll_pause_max: st.scroll_pause_max,
    } });
  });

  for (const path of ['/api/campaign/plan', '/api/campaign/start', '/api/campaign/pause',
                      '/api/campaign/resume', '/api/campaign/stop']) {
    on('POST', path, async ({ body }) => {
      if (server === false) return null;        // falls through to the simulation below
      const out = await fromServer(path, 'POST', { ...(body || {}), settings: campaignSettings() });
      mirrorSends(out);
      if (path === '/api/campaign/start') log('campaign', `started — ${(body && body.recipients || []).length} recipients, in the account windows`);
      return out;
    });
  }
  on('GET', '/api/campaign/status', async () => {
    if (server === false) return null;
    const out = await fromServer('/api/campaign/status');
    mirrorSends(out);
    return out;
  });

  on('POST', '/api/campaign/plan', ({ body }) => {
    // A run in progress owns the panel: its rows carry real statuses.
    if (campaign.state === 'running') {
      return { state: campaign.state, lanes: campaign.lanes, note: campaign.note };
    }
    const lanes = planLanes(body);
    const total = lanes.reduce((n, l) => n + l.rows.length, 0);
    return { state: 'planned', lanes,
             note: `${total} recipients dealt across ${lanes.length} account${
               lanes.length === 1 ? '' : 's'} - nothing sent yet.` };
  });

  on('POST', '/api/campaign/start', ({ body }) => {
    const accounts = body.accounts || [];
    const recipients = body.recipients || [];
    if (!accounts.length) throw new Error('Pick an account to send from.');
    if (!recipients.length) throw new Error('No recipients.');

    // The pairing is decided BEFORE anything is sent, by the same code the
    // preview uses — so what was approved in the live panel is what runs.
    campaign.lanes = planLanes(body);
    campaign.state = 'running';
    campaign.note = `${recipients.length} recipients queued.`;
    log('campaign', `started — ${recipients.length} recipients`);

    const all = () => campaign.lanes.flatMap(l => l.rows);
    const task = startTask('campaign', (t) => {
      const rows = all();
      const running = rows.find(r => r.status === 'processing');
      if (running) {
        // Closed DMs is the one failure worth naming: it is the difference
        // between "X refused" and "this account was never reachable".
        const stored = db.store.find(r => r.handle === running.handle);
        if (stored && stored.dm_open === false) {
          running.status = 'failed';
          running.why = 'DMs are closed';
        } else {
          running.status = db.settings.click_send ? 'sent' : 'typed';
          if (stored && db.settings.click_send) {
            // A tally, not a flag, as the server keeps it — the recipients
            // picker filters on "already messaged twice". Seeded off the old
            // flag, and read before it is set, so a first send scores one.
            stored.msg_count = (Number(stored.msg_count || 0)
                                || (stored.messaged ? 1 : 0)) + 1;
            stored.messaged = true;
          }
        }
        log('campaign', `${running.status} → @${running.handle}`,
            running.status === 'failed' ? 'warn' : 'info');
      }
      const next = rows.find(r => r.status === 'pending');
      if (next) next.status = 'processing';

      const done = rows.filter(r => ['sent', 'typed', 'failed'].includes(r.status)).length;
      t.progress = done / rows.length;
      t.detail = `${done} of ${rows.length}`;
      t.result = campaignState();

      if (done >= rows.length) {
        campaign.state = 'done';
        campaign.note = `Finished — ${rows.filter(r => r.status === 'failed').length} failed.`;
        t.result = campaignState();
        save();
        return true;
      }
      save();
      return false;
    }, { interval: 800 });

    campaign.task = task;
    tasks[task].result = campaignState();
    return { task, lanes: campaign.lanes };
  });

  function campaignState() {
    return { lanes: campaign.lanes, state: campaign.state, note: campaign.note };
  }

  on('GET', '/api/campaign/status', () => campaignState());

  on('POST', '/api/campaign/pause', () => {
    if (campaign.task && tasks[campaign.task]) tasks[campaign.task].state = 'paused';
    campaign.state = 'paused';
    campaign.note = 'Paused. The recipient it was on finished first.';
    log('campaign', 'paused', 'warn');
    return campaignState();
  });

  on('POST', '/api/campaign/resume', () => {
    if (campaign.task && tasks[campaign.task]) tasks[campaign.task].state = 'running';
    campaign.state = 'running';
    campaign.note = 'Running.';
    log('campaign', 'resumed');
    return campaignState();
  });

  on('POST', '/api/campaign/stop', () => {
    const t = campaign.task && tasks[campaign.task];
    if (t && t.cancel) t.cancel();
    campaign.state = 'stopped';
    campaign.note = 'Ended. The recipients it did not reach stay unmessaged.';
    log('campaign', 'ended', 'warn');
    return campaignState();
  });

  /* ── Settings ─────────────────────────────────────────────── */

  on('GET', '/api/settings', () => ({ settings: db.settings, schema: SCHEMA }));

  on('POST', '/api/settings', ({ body }) => {
    for (const [key, value] of Object.entries(body || {})) {
      const row = SCHEMA.find(r => r.key === key);
      if (!row) continue;
      // Coerced here, not on the way out of the form: everything arriving from
      // an <input> is a string, and a cap stored as "40" compares wrong against
      // a number for ever after.
      db.settings[key] = row.type === 'bool' ? !!value
                       : row.type === 'number' ? Number(value)
                       : String(value);
    }
    log('config', 'settings saved');
    save();
    return { settings: db.settings };
  });

  on('POST', '/api/settings/reset', () => {
    db.settings = defaults();
    log('config', 'settings reset to defaults', 'warn');
    save();
    return { settings: db.settings };
  });

  /* ── The real server, where there is one ──────────────────────
     Accounts and their browser windows are the one thing a stand-in cannot
     fake: "Sign in & save" has to open Chrome. So those paths go to the server
     (backend/app.py) when it answers, and what it says about accounts and
     sessions is mirrored into this db - so every other route here, the
     Scraping chips, the Actions gate, the campaign picker, sees the real
     windows. Everything else stays simulated.

     With no server - the page served by a plain static server - the first
     answer that is not JSON turns the proxy off and these paths fall back to
     the routes above. A server that simply does not answer (fetch fails: it
     is starting, restarting, or was closed) is NOT that case: the call fails
     with a message and the next one tries again. Falling back there is what
     used to put accounts into this tab's localStorage behind the server's
     back - cards that looked saved and were gone the next time the server
     answered, because its list replaced them. Server task ids carry `srv-`,
     which is how a poll knows where to go. */
  class NoServer extends Error {}
  let server = null;   // null: untried · true: answering · false: not there
  let unreachable = false;   // said once in the feed, not once per poll
  const NOT_ANSWERING = 'The server is not answering. Is run.py still running?';

  /* Cards made on this page while no server answered - the simulated kind -
     are handed to the server the first time it does, with their passwords, so
     a console that ran on the stand-in for a while keeps its list. Their
     sessions were never real and are not carried; the server's own list is
     mirrored back over this one right after. */
  async function adopt() {
    const local = db.accounts.filter(a => a.login);
    if (!local.length) return;
    const { accounts } = await real('GET', '/api/accounts');
    const known = new Set(accounts.map(a => String(a.login).toLowerCase()));
    let moved = 0;
    for (const a of local) {
      if (known.has(String(a.login).toLowerCase())) continue;
      try {
        await real('POST', '/api/accounts', {
          login: a.login, email: a.email || '', label: a.label || '',
          password: db.secrets[a.id] || '' });
        moved++;
      } catch (err) {
        if (err instanceof NoServer || err instanceof TypeError) throw err;
        // A handle the server will not take: left behind, not fatal.
      }
    }
    db.secrets = {};
    save();
    if (moved) log('accounts', `${moved} account(s) added here before the server answered were handed to it`);
  }
  const REAL = path =>
    path.startsWith('/api/accounts') || path.startsWith('/api/tasks/srv-')
    || path.startsWith('/api/minio/') || path === '/api/automation/status'
    || path === '/api/scrape/accounts' || path === '/api/scrape/rows'
    || path === '/api/fb/status' || path === '/api/fb/stop'
    || path.startsWith('/api/actions/messenger');

  /* One server call from a route below, for the parts of a simulated route
     that are real: the insta messages and media on MinIO. With no server the
     call fails as NoServer and the route says so. */
  async function fromServer(path, method = 'GET', body) {
    if (server === false) throw new Error('This needs the server - start it with run.py');
    try {
      return await real(method, path, body);
    } catch (err) {
      if (err instanceof NoServer) { server = false; throw new Error('This needs the server - start it with run.py'); }
      if (err instanceof TypeError) throw new Error(NOT_ANSWERING);
      throw err;
    }
  }

  async function real(method, path, body) {
    const res = await fetch(path, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body && method !== 'GET' ? JSON.stringify(body) : undefined,
    });
    if (!(res.headers.get('content-type') || '').includes('json')) throw new NoServer();
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `${res.status} ${res.statusText}`);
    return data;
  }

  function mirror(method, path, data) {
    if (path === '/api/accounts/sessions' && Array.isArray(data.sessions)) {
      db.accounts = data.sessions.map(s => ({
        id: String(s.id), login: s.login, label: s.label || '', email: s.email || '' }));
      for (const row of data.sessions) {
        const { id, login, label, email, ...state } = row;
        db.sessions[String(id)] = state;
      }
      for (const id of Object.keys(db.sessions))
        if (!db.accounts.some(a => a.id === id)) delete db.sessions[id];
      save();
    } else if (method === 'POST' && /\/api\/accounts\/[^/]+\/(session|open)$/.test(path)) {
      log('browser', `opened Chrome on ${path.split('/')[3] ? 'account ' + path.split('/')[3] : 'an account'} — sign in there`);
    } else if (method === 'POST' && /\/api\/accounts\/[^/]+\/logout$/.test(path)) {
      log('sessions', `logged out account ${path.split('/')[3]} — profile deleted`, 'warn');
    }
  }

  /* ── The adapter app.js talks to ──────────────────────────── */

  window.XBOT_BACKEND = {
    async handle(path, options = {}) {
      const method = (options.method || 'GET').toUpperCase();

      if (REAL(path) && server !== false) {
        try {
          if (server === null) await adopt();     // first contact probes it too
          const data = await real(method, path, options.body);
          if (server !== true) { server = true; log('server', 'backend answering — accounts and browser windows are real'); }
          unreachable = false;
          mirror(method, path, data);
          if (path.startsWith('/api/tasks/srv-') && data.result && data.result.target
              && SERVER_WALKS.includes(data.result.target.key)) mergeRoster(data.result);
          if (path.startsWith('/api/tasks/srv-') && data.result && Array.isArray(data.result.lanes)
              && data.result.lanes.some(l => (l.rows || []).some(r => r.draft !== undefined))) {
            mirrorSends({ ...data.result, task: data.id });
          }
          if (path === '/api/automation/status') {
            // The server knows about its windows; the runs it does not know
            // about are the simulated ones here.
            const running = (data.run || {}).state === 'running'
              || Object.values(tasks).some(t => t.state === 'running');
            data.run = { state: running ? 'running' : 'idle' };
          }
          return data;
        } catch (err) {
          if (err instanceof NoServer) {
            // A static server: text where JSON was expected. Simulate from here.
            server = false;
            log('server', 'no backend answering — accounts and windows are simulated', 'warn');
          } else if (err instanceof TypeError) {
            // No answer at all. Not a reason to simulate - the server is the
            // only place accounts are saved - so the call fails and the next
            // one asks again.
            if (!unreachable) { unreachable = true; log('server', NOT_ANSWERING, 'error'); }
            throw new Error(NOT_ANSWERING);
          } else {
            throw err;
          }
        }
      }
      // A reset closes the real windows too, if there are any.
      if (path === '/api/app/reset' && server) fetch(path, { method: 'POST' }).catch(() => {});

      // A real request is not instant, and a UI only ever tested against an
      // instant one hides every missing busy state it has.
      await new Promise(r => setTimeout(r, 60));

      for (const route of routes) {
        if (route.method !== method) continue;
        const params = match(route.pattern, path.split('?')[0]);
        if (!params) continue;
        const out = await route.handler({ params, body: options.body || {},
                                          query: new URLSearchParams(path.split('?')[1] || '') });
        if (out === null) continue;              // "not mine": the next route answers
        return clone(out ?? {});
      }
      throw new Error(`No mock route for ${method} ${path}`);
    },

    /* Uploads. Parsed in the browser because there is nowhere to send them —
       the shapes match what the endpoints would return. */
    async upload(url, files, field) {
      if (url === '/api/media') {
        for (const file of files) {
          db.media.push({
            name: file.name,
            size: file.size,
            // A data URI, so a stored image survives a reload. A blob: URL would
            // be dead the moment the tab that made it went away.
            url: await readAsDataURL(file),
          });
        }
        log('data', `uploaded ${files.length} image(s)`);
        save();
        return { added: files.length };
      }

      const text = await files[0].text();

      if (url === '/api/store/accounts/parse') {
        const rows = text.split(/\r?\n/)
          .map(line => line.split(/[,\t]/)[0].trim())
          .filter(Boolean)
          .filter(h => !/^(handle|username|user|account)$/i.test(h))
          .map(h => ({ handle: h.replace(/^@+/, ''), name: '' }));
        return { rows };
      }

      if (url === '/api/messages/parse') {
        // Blank-line separated, because a DM has line breaks in it and
        // one-per-line would cut every multi-paragraph message into pieces.
        const drafts = text.split(/\r?\n\s*\r?\n/)
          .map(s => s.trim()).filter(Boolean)
          .map((t, i) => ({ name: `imported ${i + 1}`, text: t, enabled: true }));
        return { drafts };
      }

      throw new Error(`No mock upload route for ${url}`);
    },

    /* The activity stream. A callback where the real one is an EventSource —
       app.js picks between them in openFeed(). */
    stream(push) {
      db.logs.slice(-60).forEach(push);
      listeners.push(push);
    },
  };

  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
      reader.readAsDataURL(file);
    });
  }

  log('server', 'mock backend ready — no server, nothing leaves this tab');
})();
