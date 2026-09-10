'use strict';
// Fantasy HQ: one dashboard for every fantasy league across Sleeper, ESPN and Yahoo.
// Zero dependencies. Run with: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { nameKey } = require('./lib/util');
const { DATA_DIR } = require('./lib/cache');

// Adapters and lib modules are re-required on every refresh so fixes to them take effect
// without restarting the server. (Changes to server.js itself still need a restart.)
function loadAdapters() {
  for (const k of Object.keys(require.cache)) if (/[\/](adapters|lib)[\/]/.test(k)) delete require.cache[k];
  return {
    sleeper: require('./adapters/sleeper'),
    espn: require('./adapters/espn'),
    yahoo: require('./adapters/yahoo'),
    cbs: require('./adapters/cbs'),
  };
}
let ADAPTERS = loadAdapters();
const SECRET_FIELDS = ['espn_s2', 'clientSecret', 'accessToken'];
const MASK = '********';
// Hosted: config lives on the persistent data disk. Local: config.json next to server.js.
const CONFIG_PATH = process.env.FHQ_DATA_DIR ? path.join(DATA_DIR, 'config.json') : path.join(__dirname, 'config.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
// Set FHQ_PASSWORD to require a login (do this whenever the dashboard is reachable from the internet).
const PASSWORD = process.env.FHQ_PASSWORD || '';
const COOKIE = 'fhq';

// ---------- config ----------
const DEFAULT_CONFIG = { port: 3000, refresh: { live: 30, idle: 300 }, accounts: [] };

function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { ...DEFAULT_CONFIG, ...c, refresh: { ...DEFAULT_CONFIG.refresh, ...(c.refresh || {}) }, accounts: c.accounts || [] };
  } catch {
    return { ...DEFAULT_CONFIG, accounts: [] };
  }
}
function saveConfig(c) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
}
let config = loadConfig();

function publicConfig() {
  return {
    ...config,
    accounts: config.accounts.map((a) => {
      const out = { ...a };
      for (const f of SECRET_FIELDS) if (out[f]) out[f] = MASK;
      if (a.platform === 'yahoo') out.connected = ADAPTERS.yahoo.isConnected();
      return out;
    }),
  };
}

// ---------- state ----------
let state = {
  updatedAt: null,
  refreshing: false,
  nfl: { season: null, week: null, games: [], anyLive: false },
  accounts: [],
  leagues: [],
  players: [],
  warnings: [],
};
let refreshTimer = null;
let refreshing = false;

async function refresh(reason = 'timer') {
  if (refreshing) return;
  refreshing = true;
  state.refreshing = true;
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

  const accountResults = await Promise.all(
    config.accounts.map(async (acct, i) => {
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

  const leagues = accountResults.flatMap((r) => r.leagues.map((l) => ({ ...l, accountIndex: r.index })));
  const { byTeam, ...nflPublic } = nfl;
  state = {
    updatedAt: new Date().toISOString(),
    refreshing: false,
    refreshMs: Date.now() - started,
    reason,
    nfl: nflPublic,
    accounts: accountResults.map(({ leagues: _l, ...r }) => ({ ...r, leagueCount: _l.length })),
    leagues,
    players: aggregatePlayers(leagues),
    warnings,
  };
  refreshing = false;
  scheduleNext();
  console.log(`[${new Date().toLocaleTimeString()}] refreshed (${reason}) in ${state.refreshMs}ms: ${leagues.length} leagues, ${state.players.length} players, live=${nfl.anyLive}`);
}

function scheduleNext() {
  clearTimeout(refreshTimer);
  const { live, idle } = config.refresh;
  let delay = idle;
  if (state.nfl.anyLive) delay = live;
  else if (state.nfl.nextKickoff && new Date(state.nfl.nextKickoff) - Date.now() < 20 * 60 * 1000) delay = Math.min(idle, 60);
  refreshTimer = setTimeout(() => refresh('timer'), Math.max(10, delay) * 1000);
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

// ---------- auth ----------
function sessionToken() {
  return crypto.createHmac('sha256', PASSWORD).update('fhq-session-v1').digest('hex');
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function isAuthed(req) {
  if (!PASSWORD) return true;
  const m = /(?:^|;\s*)fhq=([a-f0-9]+)/.exec(req.headers.cookie || '');
  return !!(m && safeEqual(m[1], sessionToken()));
}
const LOGIN_PAGE = (err) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fantasy HQ</title>
<link rel="manifest" href="/manifest.json"><meta name="theme-color" content="#0f1216">
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1216;color:#e8ebef;font-family:system-ui,sans-serif}
form{background:#171b21;border:1px solid #2a3039;border-radius:12px;padding:28px;width:min(320px,90vw);display:flex;flex-direction:column;gap:12px}
h1{margin:0;font-size:18px}input{background:#1f242c;color:#e8ebef;border:1px solid #2a3039;border-radius:8px;padding:10px;font:inherit}
button{background:#5b9cf6;color:#0b1220;border:0;border-radius:8px;padding:10px;font:inherit;font-weight:600}.err{color:#f16a6a;font-size:13px}</style></head>
<body><form method="post" action="/login"><h1>🏈 Fantasy HQ</h1>${err ? '<div class="err">Wrong password</div>' : ''}<input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password"><button>Sign in</button></form></body></html>`;

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function send(res, status, body, type = 'application/json') {
  const data = type.startsWith('application/json') ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      try {
        resolve(buf ? JSON.parse(buf) : {});
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function applyConfigUpdate(incoming) {
  const accounts = (incoming.accounts || []).map((a) => {
    const clean = { ...a };
    delete clean.connected;
    // Keep existing secrets when the client sends the mask back
    for (const f of SECRET_FIELDS) {
      if (clean[f] === MASK) {
        const prev = config.accounts.find((x) => x.platform === clean.platform && (x.id === clean.id || x.label === clean.label));
        clean[f] = prev ? prev[f] : '';
      }
    }
    if (clean.platform === 'espn' && typeof clean.leagueIds === 'string') {
      clean.leagueIds = clean.leagueIds.split(/[\s,]+/).filter(Boolean);
    }
    return clean;
  });
  config = {
    ...config,
    port: Number(incoming.port) || config.port,
    refresh: {
      live: Math.max(10, Number((incoming.refresh || {}).live) || config.refresh.live),
      idle: Math.max(30, Number((incoming.refresh || {}).idle) || config.refresh.idle),
    },
    accounts,
  };
  saveConfig(config);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/login' && req.method === 'POST') {
      let buf = '';
      for await (const c of req) buf += c;
      const pw = new URLSearchParams(buf).get('password') || '';
      if (PASSWORD && safeEqual(pw, PASSWORD)) {
        res.writeHead(302, { 'Set-Cookie': `${COOKIE}=${sessionToken()}; Path=/; Max-Age=${180 * 24 * 3600}; HttpOnly; SameSite=Lax`, Location: '/' });
        return res.end();
      }
      return send(res, 401, LOGIN_PAGE(true), 'text/html; charset=utf-8');
    }
    if (url.pathname === '/logout') {
      res.writeHead(302, { 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0`, Location: '/' });
      return res.end();
    }
    if (!isAuthed(req)) {
      if (url.pathname === '/manifest.json' || url.pathname === '/icon.svg' || url.pathname === '/healthz') {
        /* public assets so the home-screen icon works */
      } else if (url.pathname.startsWith('/api/')) return send(res, 401, { error: 'Not signed in' });
      else return send(res, 200, LOGIN_PAGE(false), 'text/html; charset=utf-8');
    }
    if (url.pathname === '/api/state') return send(res, 200, state);
    if (url.pathname === '/healthz') return send(res, 200, { ok: true, updatedAt: state.updatedAt });
    if (url.pathname === '/api/config' && req.method === 'GET') return send(res, 200, publicConfig());
    if (url.pathname === '/api/config' && req.method === 'PUT') {
      applyConfigUpdate(await readBody(req));
      refresh('config').catch((e) => console.error(e));
      return send(res, 200, publicConfig());
    }
    if (url.pathname === '/api/refresh' && req.method === 'POST') {
      refresh('manual').catch((e) => console.error(e));
      return send(res, 202, { ok: true });
    }
    if (url.pathname === '/api/yahoo/auth-url') {
      const acct = config.accounts[Number(url.searchParams.get('index'))];
      if (!acct || acct.platform !== 'yahoo') return send(res, 404, { error: 'No such Yahoo account' });
      if (!acct.clientId) return send(res, 400, { error: 'Save a Yahoo Client ID first' });
      return send(res, 200, { url: ADAPTERS.yahoo.authUrl(acct) });
    }
    if (url.pathname === '/api/yahoo/code' && req.method === 'POST') {
      const body = await readBody(req);
      const acct = config.accounts[Number(body.index)];
      if (!acct || acct.platform !== 'yahoo') return send(res, 404, { error: 'No such Yahoo account' });
      await ADAPTERS.yahoo.exchangeCode(acct, String(body.code || ''));
      refresh('yahoo-connect').catch((e) => console.error(e));
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/yahoo/disconnect' && req.method === 'POST') {
      ADAPTERS.yahoo.disconnect();
      return send(res, 200, { ok: true });
    }
    // static files
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(PUBLIC_DIR, file);
    if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return send(res, 404, 'Not found', 'text/plain');
    return send(res, 200, fs.readFileSync(full), MIME[path.extname(full)] || 'application/octet-stream');
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: e.message });
  }
});

const port = Number(process.env.PORT) || config.port;
server.listen(port, '0.0.0.0', () => {
  console.log(`Fantasy HQ running at http://localhost:${port}${PASSWORD ? ' (password protected)' : ''}`);
  if (!PASSWORD) console.log('No FHQ_PASSWORD set: anyone who can reach this port can see your leagues and settings. Fine at home; set it before hosting.');
  if (!config.accounts.length) console.log('No accounts configured yet. Open the dashboard and click Settings to connect your leagues.');
  refresh('startup').catch((e) => console.error(e));
});
