'use strict';
// Fantasy HQ: one dashboard for every fantasy league across Sleeper, ESPN and Yahoo.
// Zero dependencies. Run with: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const { getNfl } = require('./lib/nfl');
const { nameKey } = require('./lib/util');

const ADAPTERS = {
  sleeper: require('./adapters/sleeper'),
  espn: require('./adapters/espn'),
  yahoo: require('./adapters/yahoo'),
  cbs: require('./adapters/cbs'),
};
const SECRET_FIELDS = ['espn_s2', 'clientSecret', 'accessToken'];
const MASK = '********';
const CONFIG_PATH = path.join(__dirname, 'config.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

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
  let nfl = state.nfl;
  try {
    nfl = await getNfl();
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
    if (url.pathname === '/api/state') return send(res, 200, state);
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

server.listen(config.port, () => {
  console.log(`Fantasy HQ running at http://localhost:${config.port}`);
  if (!config.accounts.length) console.log('No accounts configured yet. Open the dashboard and click Settings to connect your leagues.');
  refresh('startup').catch((e) => console.error(e));
});
