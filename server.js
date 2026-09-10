'use strict';
// Fantasy HQ: one dashboard for every fantasy league across Sleeper, ESPN, Yahoo and CBS.
// Multi-user: each person signs in and connects their own platform accounts.
// Zero dependencies. Run with: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { nameKey } = require('./lib/util');
const { DATA_DIR } = require('./lib/cache');
const users = require('./lib/users');
const { enrichLeague } = require('./lib/outlook');

// Adapters and lib modules are re-required on every refresh so fixes to them take effect
// without restarting the server. (Changes to server.js itself still need a restart.)
function loadAdapters() {
  for (const k of Object.keys(require.cache)) if (/[\\/](adapters|lib)[\\/](?!users\.js)/.test(k)) delete require.cache[k];
  return {
    sleeper: require('./adapters/sleeper'),
    espn: require('./adapters/espn'),
    yahoo: require('./adapters/yahoo'),
    cbs: require('./adapters/cbs'),
  };
}
let ADAPTERS = loadAdapters();
const PLATFORMS = new Set(['sleeper', 'espn', 'yahoo', 'cbs']);
const SECRET_FIELDS = ['espn_s2', 'clientSecret', 'accessToken'];
const MASK = '********';
// Hosted: config lives on the persistent data disk. Local: config.json next to server.js.
const CONFIG_PATH = process.env.FHQ_DATA_DIR ? path.join(DATA_DIR, 'config.json') : path.join(__dirname, 'config.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const COOKIE = 'fhq';
const MAX_BODY = 256 * 1024;

// ---------- global config (refresh cadence, port) ----------
const DEFAULT_CONFIG = { port: 3000, refresh: { live: 30, idle: 300 } };

function loadConfig() {
  let c = null;
  try {
    c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    if (process.env.FHQ_CONFIG) {
      try {
        c = JSON.parse(process.env.FHQ_CONFIG);
      } catch (e) {
        console.error('FHQ_CONFIG is not valid JSON:', e.message);
      }
    }
  }
  if (!c) return { ...DEFAULT_CONFIG };
  return { ...DEFAULT_CONFIG, ...c, refresh: { ...DEFAULT_CONFIG.refresh, ...(c.refresh || {}) } };
}
function saveConfig(c) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  const { accounts: _legacy, ...rest } = c;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(rest, null, 2));
}
let config = loadConfig();

function withId(a, i = 0) {
  return a.id ? a : { ...a, id: `${a.platform}-${Date.now()}-${i}-${crypto.randomBytes(2).toString('hex')}` };
}

// Migration from the single-user version: accounts used to live in config.json and the login
// was FHQ_PASSWORD. Move them onto a user so nothing is lost.
let pendingLegacyAccounts = null;
(function migrate() {
  const legacy = Array.isArray(config.accounts) ? config.accounts : null;
  if (!legacy || !legacy.length) return;
  if (users.listUsers().length) {
    saveConfig(config); // users already exist; drop the stale copy from config.json
    return;
  }
  if (process.env.FHQ_PASSWORD) {
    try {
      users.createUser({ name: 'admin', password: process.env.FHQ_PASSWORD, admin: true, accounts: legacy.map(withId) });
      saveConfig(config);
      console.log('Migrated existing leagues to user "admin" (same password as before).');
    } catch (e) {
      console.error(`Could not migrate to a user account: ${e.message}. Leagues stay pending until the first account is created.`);
      pendingLegacyAccounts = legacy.map(withId);
    }
  } else {
    pendingLegacyAccounts = legacy.map(withId); // attach to whoever creates the first account
  }
})();

function maskedAccounts(user) {
  return (user.accounts || []).map((a) => {
    const out = { ...a };
    for (const f of SECRET_FIELDS) if (out[f]) out[f] = MASK;
    if (a.platform === 'yahoo') out.connected = ADAPTERS.yahoo.isConnected(a);
    return out;
  });
}

// Only keep known fields, as trimmed strings, so nothing odd can be stored or rendered
const ACCOUNT_FIELDS = {
  sleeper: ['username'],
  espn: ['label', 'swid', 'espn_s2', 'leagueIds', 'teamName', 'season'],
  yahoo: ['label', 'clientId', 'clientSecret'],
  cbs: ['label', 'leagueName', 'accessToken'],
};
function sanitizeAccounts(user, incoming) {
  if (!Array.isArray(incoming)) throw new Error('accounts must be a list');
  if (incoming.length > 20) throw new Error('Too many accounts');
  return incoming.map((raw, i) => {
    const platform = String((raw && raw.platform) || '');
    if (!PLATFORMS.has(platform)) throw new Error(`Unknown platform: ${platform.slice(0, 20)}`);
    const clean = { platform, id: typeof raw.id === 'string' && /^[\w.-]{1,80}$/.test(raw.id) ? raw.id : undefined };
    for (const f of ACCOUNT_FIELDS[platform]) {
      let v = raw[f];
      if (v == null) continue;
      if (Array.isArray(v)) v = v.join(',');
      v = String(v).trim().slice(0, 2000);
      if (f === 'leagueIds') v = v.split(/[\s,]+/).filter((x) => /^\d{1,20}$/.test(x));
      clean[f] = v;
    }
    const out = withId(clean, i);
    for (const f of SECRET_FIELDS) {
      if (out[f] === MASK) {
        const prev = (user.accounts || []).find((x) => x.id === out.id);
        out[f] = prev ? prev[f] : '';
      }
    }
    return out;
  });
}

// ---------- state ----------
let state = {
  updatedAt: null,
  refreshing: false,
  nfl: { season: null, week: null, games: [], anyLive: false },
  warnings: [],
  byUser: {}, // userId -> { accounts, leagues, players }
};
let refreshTimer = null;
let refreshing = false;

async function refresh(reason = 'timer') {
  if (refreshing) return;
  refreshing = true;
  state.refreshing = true;
  try {
    await doRefresh(reason);
  } catch (e) {
    console.error(`Refresh failed (${reason}):`, e);
    state.refreshing = false;
  } finally {
    refreshing = false;
    scheduleNext();
  }
}

async function doRefresh(reason) {
  const started = Date.now();
  const warnings = [];
  const ctx = { warn: (m) => warnings.push(m) };
  try {
    ADAPTERS = loadAdapters();
  } catch (e) {
    warnings.push(`Adapter reload failed, using previous code: ${e.message}`);
  }
  let nfl = state.nfl;
  try {
    nfl = await require('./lib/nfl').getNfl();
  } catch (e) {
    warnings.push(`NFL scoreboard unavailable: ${e.message}`);
    nfl = { ...nfl, byTeam: nfl.byTeam || {} };
  }
  ctx.nfl = nfl;
  ctx.season = nfl.season;
  ctx.week = nfl.week;

  const byUser = {};
  await Promise.all(
    users.listUsers().map(async (u) => {
      const accountResults = await Promise.all(
        (u.accounts || []).map(async (acct, i) => {
          const adapter = ADAPTERS[acct.platform];
          const label = acct.label || acct.username || acct.platform;
          if (!adapter) return { index: i, platform: acct.platform, label, error: `Unknown platform ${acct.platform}`, leagues: [] };
          try {
            const leagues = await adapter.fetchLeagues(acct, ctx);
            return { index: i, platform: acct.platform, label, error: null, leagues };
          } catch (e) {
            return { index: i, platform: acct.platform, label, error: e.message, leagues: [] };
          }
        }),
      );
      const leagues = accountResults.flatMap((r) => r.leagues.map((l) => enrichLeague({ ...l, accountIndex: r.index })));
      byUser[u.id] = {
        accounts: accountResults.map(({ leagues: _l, ...r }) => ({ ...r, leagueCount: _l.length })),
        allLeagues: leagues,
      };
    }),
  );

  const { byTeam, ...nflPublic } = nfl;
  state = {
    updatedAt: new Date().toISOString(),
    refreshing: false,
    refreshMs: Date.now() - started,
    reason,
    nfl: nflPublic,
    warnings,
    byUser,
  };
  const nLeagues = Object.values(byUser).reduce((s, u) => s + u.allLeagues.length, 0);
  console.log(`[${new Date().toLocaleTimeString()}] refreshed (${reason}) in ${state.refreshMs}ms: ${users.listUsers().length} users, ${nLeagues} leagues, live=${nfl.anyLive}`);
}

function scheduleNext() {
  clearTimeout(refreshTimer);
  const { live, idle } = config.refresh;
  let delay = idle;
  if (state.nfl.anyLive) delay = live;
  else if (state.nfl.nextKickoff && new Date(state.nfl.nextKickoff) - Date.now() < 20 * 60 * 1000) delay = Math.min(idle, 60);
  refreshTimer = setTimeout(() => refresh('timer').catch((e) => console.error(e)), Math.max(10, delay) * 1000);
}

// Per-user view: hidden leagues removed, players merged from the visible ones only.
const derivedCache = new Map();
function visibleFor(user) {
  const mine = state.byUser[user.id] || { accounts: [], allLeagues: [] };
  const hiddenSet = new Set(user.hiddenLeagues || []);
  const cacheKey = `${state.updatedAt}|${[...hiddenSet].sort().join(',')}`;
  const c = derivedCache.get(user.id);
  if (c && c.key === cacheKey) return c.value;
  const leagues = mine.allLeagues.filter((l) => !hiddenSet.has(l.key));
  const hidden = mine.allLeagues.filter((l) => hiddenSet.has(l.key)).map((l) => ({ key: l.key, name: l.name, platform: l.platform }));
  const value = { accounts: mine.accounts, leagues, hidden, players: aggregatePlayers(leagues) };
  derivedCache.set(user.id, { key: cacheKey, value });
  return value;
}
function stateFor(user) {
  return {
    updatedAt: state.updatedAt,
    refreshing: state.refreshing,
    refreshMs: state.refreshMs,
    nfl: state.nfl,
    warnings: state.warnings,
    user: { name: user.name, admin: !!user.admin },
    ...visibleFor(user),
  };
}

// Merge every roster into one cross-platform player list.
function aggregatePlayers(leagues) {
  const map = new Map();
  const add = (p, league, side) => {
    // Team defenses are named differently on every platform, so key them by NFL team instead
    const key = p.pos === 'DEF' && p.team ? `dst|${p.team}` : p.name ? nameKey(p.name, p.pos) : `${league.platform}:${p.id}`;
    let agg = map.get(key);
    if (!agg) {
      agg = {
        key,
        name: p.name,
        pos: p.pos,
        team: p.team,
        injury: p.injury,
        game: p.game,
        stats: p.stats,
        statLine: p.statLine,
        mine: [],
        against: [],
        maxPoints: 0,
      };
      map.set(key, agg);
    }
    // Prefer the richest stat line available across platforms
    if (p.stats && (!agg.stats || Object.keys(p.stats).length > Object.keys(agg.stats).length)) {
      agg.stats = p.stats;
      agg.statLine = p.statLine;
    }
    if (!agg.stats && !agg.statLine && p.statLine) agg.statLine = p.statLine;
    if (!agg.injury && p.injury) agg.injury = p.injury;
    const entry = {
      league: league.key,
      leagueName: league.name,
      platform: league.platform,
      slot: p.slot,
      starter: p.starter,
      points: p.points,
      projected: p.projected,
      myTeam: league.myTeam ? league.myTeam.name : '',
      opponent: league.opponent ? league.opponent.name : '',
    };
    (side === 'mine' ? agg.mine : agg.against).push(entry);
    agg.maxPoints = Math.max(agg.maxPoints, p.points || 0);
  };
  for (const lg of leagues) {
    if (lg.error) continue;
    for (const p of (lg.myTeam && lg.myTeam.roster) || []) add(p, lg, 'mine');
    for (const p of (lg.opponent && lg.opponent.roster) || []) if (p.starter) add(p, lg, 'against');
  }
  const order = { in: 0, pre: 1, post: 2, none: 3 };
  return [...map.values()].sort((a, b) => {
    const d = order[a.game.state] - order[b.game.state];
    if (d) return d;
    if (a.game.state === 'pre') return new Date(a.game.start || 0) - new Date(b.game.start || 0);
    return b.maxPoints - a.maxPoints;
  });
}

// ---------- security helpers ----------
// Simple in-memory rate limiter for sign-in / registration attempts, per client IP
const attempts = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const rec = attempts.get(key) || { n: 0, reset: now + windowMs };
  if (now > rec.reset) {
    rec.n = 0;
    rec.reset = now + windowMs;
  }
  rec.n++;
  attempts.set(key, rec);
  if (attempts.size > 5000) attempts.clear();
  return rec.n > max;
}
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? String(fwd).split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
}
function isHttps(req) {
  return req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted;
}
// Cross-site request check for state-changing calls: the Origin (or Referer) must be this site.
function sameOrigin(req) {
  let origin = req.headers.origin;
  if (!origin && req.headers.referer) {
    try {
      origin = new URL(req.headers.referer).origin;
    } catch {
      origin = null;
    }
  }
  // No Origin (curl) or an opaque "null" origin (privacy modes, embedded webviews): nothing to compare.
  // The session cookie is SameSite=Lax, so a cross-site POST never carries it; this check is a second layer.
  if (!origin || origin === 'null') return true;
  try {
    const ok = new URL(origin).host === req.headers.host;
    if (!ok) console.warn(`Blocked cross-site ${req.method} ${req.url}: origin=${origin} host=${req.headers.host}`);
    return ok;
  } catch {
    return false;
  }
}
function securityHeaders(req) {
  const h = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
  };
  if (isHttps(req)) h['Strict-Transport-Security'] = 'max-age=31536000';
  return h;
}

// ---------- auth pages ----------
const PAGE_CSS = `body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1216;color:#e8ebef;font-family:system-ui,sans-serif}
form{background:#171b21;border:1px solid #2a3039;border-radius:12px;padding:28px;width:min(340px,90vw);display:flex;flex-direction:column;gap:12px}
h1{margin:0;font-size:18px}p{margin:0;color:#a7afbb;font-size:13px}input{background:#1f242c;color:#e8ebef;border:1px solid #2a3039;border-radius:8px;padding:10px;font:inherit}
button{background:#5b9cf6;color:#0b1220;border:0;border-radius:8px;padding:10px;font:inherit;font-weight:600;cursor:pointer}.err{color:#f16a6a;font-size:13px}a{color:#5b9cf6;text-decoration:none;font-size:13px}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shell = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fantasy HQ</title>
<link rel="manifest" href="/manifest.json"><link rel="icon" href="/icon.svg" type="image/svg+xml"><meta name="theme-color" content="#0f1216"><style>${PAGE_CSS}</style></head><body>${body}<script src="/login.js"></script></body></html>`;

const loginPage = (err, name = '') =>
  shell(`<form method="post" action="/login"><h1>🏈 Fantasy HQ</h1>${err ? `<div class="err">${esc(err)}</div>` : ''}
<input name="name" placeholder="Username" value="${esc(name)}" autofocus autocomplete="username" required maxlength="32">
<input type="password" name="password" placeholder="Password" autocomplete="current-password" required>
<button>Sign in</button><a href="/register">Need an account? Register with an invite code</a></form>`);

const registerPage = (err, first, name = '') =>
  shell(`<form method="post" action="/register"><h1>🏈 ${first ? 'Create the first account' : 'Create your account'}</h1>
<p>${first ? 'You will be the admin. Any leagues already configured get attached to this account.' : 'Ask the admin for the invite code.'}</p>
${err ? `<div class="err">${esc(err)}</div>` : ''}
<input name="name" placeholder="Username" value="${esc(name)}" autofocus autocomplete="username" required maxlength="32">
<input type="password" name="password" placeholder="Password (8+ characters)" autocomplete="new-password" required minlength="8">
${first ? '' : '<input name="invite" placeholder="Invite code" autocomplete="off" required>'}
<button>Create account</button>${first ? '' : '<a href="/login">Already have an account? Sign in</a>'}</form>`);

function sessionCookie(req, token, maxAge = users.SESSION_DAYS * 86400) {
  return `${COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`;
}
function cookieToken(req) {
  const m = /(?:^|;\s*)fhq=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function currentUser(req) {
  return users.userForSession(cookieToken(req));
}

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const PUBLIC_PATHS = new Set(['/manifest.json', '/icon.svg', '/healthz', '/login.js']);

function send(req, res, status, body, type = 'application/json', extra = {}) {
  const data = type.startsWith('application/json') ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...securityHeaders(req), ...extra });
  res.end(data);
}
function redirect(req, res, to, extra = {}) {
  res.writeHead(302, { Location: to, ...securityHeaders(req), ...extra });
  res.end();
}
function html(req, res, status, body, extra = {}) {
  return send(req, res, status, body, 'text/html; charset=utf-8', extra);
}

async function readBody(req) {
  let buf = '';
  for await (const c of req) {
    buf += c;
    if (buf.length > MAX_BODY) throw new Error('Request too large');
  }
  const ct = req.headers['content-type'] || '';
  if (ct.includes('application/json')) {
    try {
      return buf ? JSON.parse(buf) : {};
    } catch {
      throw new Error('Invalid JSON body');
    }
  }
  return Object.fromEntries(new URLSearchParams(buf));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const mutating = req.method !== 'GET' && req.method !== 'HEAD';
  try {
    if (p === '/healthz') return send(req, res, 200, { ok: true, updatedAt: state.updatedAt });
    if (mutating && !sameOrigin(req)) return send(req, res, 403, { error: 'Cross-site request blocked' });

    // ----- sign in / register / sign out -----
    const noUsers = users.listUsers().length === 0;
    if (p === '/login' && req.method === 'GET') return noUsers ? redirect(req, res, '/register') : html(req, res, 200, loginPage(''));
    if (p === '/login' && req.method === 'POST') {
      if (limited(`login:${clientIp(req)}`, 20, 15 * 60 * 1000)) return html(req, res, 429, loginPage('Too many attempts. Try again in 15 minutes.'));
      const b = await readBody(req);
      const u = users.findByName(b.name);
      if (!u || limited(`user:${u.id}`, 10, 15 * 60 * 1000) || !users.checkPassword(u, b.password)) {
        await new Promise((r) => setTimeout(r, 500));
        return html(req, res, 401, loginPage('Wrong username or password', b.name));
      }
      return redirect(req, res, '/', { 'Set-Cookie': sessionCookie(req, users.createSession(u)) });
    }
    if (p === '/register' && req.method === 'GET') return html(req, res, 200, registerPage('', noUsers));
    if (p === '/register' && req.method === 'POST') {
      if (limited(`register:${clientIp(req)}`, 10, 60 * 60 * 1000)) return html(req, res, 429, registerPage('Too many attempts. Try again later.', noUsers));
      const b = await readBody(req);
      if (!noUsers && !users.checkInvite(b.invite)) {
        await new Promise((r) => setTimeout(r, 500));
        return html(req, res, 403, registerPage('Invalid invite code', false, b.name));
      }
      let u;
      try {
        u = users.createUser({ name: b.name, password: b.password, accounts: noUsers && pendingLegacyAccounts ? pendingLegacyAccounts : [] });
      } catch (e) {
        return html(req, res, 400, registerPage(e.message, noUsers, b.name));
      }
      if (noUsers && pendingLegacyAccounts) {
        pendingLegacyAccounts = null;
        saveConfig(config);
      }
      refresh('register').catch((e) => console.error(e));
      return redirect(req, res, '/', { 'Set-Cookie': sessionCookie(req, users.createSession(u)) });
    }
    if (p === '/logout') {
      const t = cookieToken(req);
      if (t) users.destroySession(t);
      return redirect(req, res, '/login', { 'Set-Cookie': sessionCookie(req, '', 0) });
    }

    // ----- everything else needs a signed-in user (except public assets) -----
    const user = currentUser(req);
    if (!user && !PUBLIC_PATHS.has(p)) {
      if (p.startsWith('/api/')) return send(req, res, 401, { error: 'Not signed in' });
      return redirect(req, res, noUsers ? '/register' : '/login');
    }

    if (p === '/api/state') return send(req, res, 200, stateFor(user));
    if (p === '/api/refresh' && req.method === 'POST') {
      refresh('manual').catch((e) => console.error(e));
      return send(req, res, 202, { ok: true });
    }
    if (p === '/api/config' && req.method === 'GET') {
      const out = { accounts: maskedAccounts(user), refresh: config.refresh, user: { name: user.name, admin: !!user.admin }, hidden: visibleFor(user).hidden };
      if (user.admin) out.admin = { inviteCode: users.inviteCode(), users: users.listUsers().map(users.publicUser) };
      return send(req, res, 200, out);
    }
    if (p === '/api/config' && req.method === 'PUT') {
      const b = await readBody(req);
      let accounts;
      try {
        accounts = sanitizeAccounts(user, b.accounts);
      } catch (e) {
        return send(req, res, 400, { error: e.message });
      }
      users.updateAccounts(user, accounts);
      if (user.admin && b.refresh) {
        config.refresh = {
          live: Math.max(10, Number(b.refresh.live) || config.refresh.live),
          idle: Math.max(30, Number(b.refresh.idle) || config.refresh.idle),
        };
        saveConfig(config);
      }
      refresh('config').catch((e) => console.error(e));
      return send(req, res, 200, { accounts: maskedAccounts(user), refresh: config.refresh });
    }
    if (p === '/api/hidden' && req.method === 'POST') {
      const b = await readBody(req);
      const key = String(b.league || '');
      if (!/^(sleeper|espn|yahoo|cbs):[\w.-]{1,100}$/.test(key)) return send(req, res, 400, { error: 'Bad league key' });
      users.setHidden(user, key, !!b.hidden);
      return send(req, res, 200, { hiddenLeagues: user.hiddenLeagues, ...visibleFor(user) });
    }
    if (p === '/api/password' && req.method === 'POST') {
      const b = await readBody(req);
      if (!users.checkPassword(user, b.current)) return send(req, res, 403, { error: 'Current password is wrong' });
      try {
        users.setPassword(user, b.next);
      } catch (e) {
        return send(req, res, 400, { error: e.message });
      }
      users.destroyAllSessions(user.id); // sign out everywhere else, then keep this device signed in
      return send(req, res, 200, { ok: true }, 'application/json', { 'Set-Cookie': sessionCookie(req, users.createSession(user)) });
    }

    // ----- admin -----
    if (p.startsWith('/api/admin/')) {
      if (!user.admin) return send(req, res, 403, { error: 'Admins only' });
      if (p === '/api/admin/invite' && req.method === 'POST') return send(req, res, 200, { inviteCode: users.regenerateInvite() });
      const del = /^\/api\/admin\/users\/([a-f0-9]{16})$/.exec(p);
      if (del && req.method === 'DELETE') {
        if (del[1] === user.id) return send(req, res, 400, { error: 'You cannot remove yourself' });
        users.deleteUser(del[1]);
        delete state.byUser[del[1]];
        derivedCache.delete(del[1]);
        return send(req, res, 200, { ok: true });
      }
      return send(req, res, 404, { error: 'Not found' });
    }

    // ----- yahoo connect flow (per account of the current user) -----
    if (p === '/api/yahoo/auth-url') {
      const acct = (user.accounts || [])[Number(url.searchParams.get('index'))];
      if (!acct || acct.platform !== 'yahoo') return send(req, res, 404, { error: 'No such Yahoo account' });
      if (!acct.clientId) return send(req, res, 400, { error: 'Save a Yahoo Client ID first' });
      return send(req, res, 200, { url: ADAPTERS.yahoo.authUrl(acct) });
    }
    if (p === '/api/yahoo/code' && req.method === 'POST') {
      const b = await readBody(req);
      const acct = (user.accounts || [])[Number(b.index)];
      if (!acct || acct.platform !== 'yahoo') return send(req, res, 404, { error: 'No such Yahoo account' });
      await ADAPTERS.yahoo.exchangeCode(acct, String(b.code || '').slice(0, 200));
      refresh('yahoo-connect').catch((e) => console.error(e));
      return send(req, res, 200, { ok: true });
    }
    if (p === '/api/yahoo/disconnect' && req.method === 'POST') {
      const b = await readBody(req);
      const acct = (user.accounts || [])[Number(b.index)];
      if (acct && acct.platform === 'yahoo') ADAPTERS.yahoo.disconnect(acct);
      return send(req, res, 200, { ok: true });
    }
    if (p.startsWith('/api/')) return send(req, res, 404, { error: 'Not found' });

    // ----- static files -----
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, { error: 'Method not allowed' });
    const rel = path.normalize(decodeURIComponent(p === '/' ? '/index.html' : p)).replace(/^([/\\]|\.\.)+/, '');
    const full = path.join(PUBLIC_DIR, rel);
    if (!full.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return send(req, res, 404, 'Not found', 'text/plain');
    return send(req, res, 200, fs.readFileSync(full), MIME[path.extname(full)] || 'application/octet-stream');
  } catch (e) {
    console.error(e);
    return send(req, res, e.message === 'Request too large' ? 413 : 500, { error: e.message === 'Request too large' ? e.message : 'Server error' });
  }
});

// Never let a stray async error take the whole dashboard down
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));
process.on('uncaughtException', (e) => console.error('Uncaught exception:', e));

const port = Number(process.env.PORT) || config.port;
server.listen(port, '0.0.0.0', () => {
  console.log(`Fantasy HQ running at http://localhost:${port}`);
  if (!users.listUsers().length) console.log('No users yet. Open the dashboard to create the first (admin) account.');
  refresh('startup').catch((e) => console.error(e));
});
