'use strict';
// Yahoo Fantasy adapter. Needs an OAuth2 app (client id/secret) from https://developer.yahoo.com/apps/
// Auth uses the out-of-band flow: user opens the auth URL, pastes the code back into the dashboard.
const { fetchJson, normTeam, statLine, num, round1 } = require('../lib/util');
const { readJson, writeJson } = require('../lib/cache');
const { gameFor } = require('../lib/nfl');

const AUTH = 'https://api.login.yahoo.com/oauth2/request_auth';
const TOKEN = 'https://api.login.yahoo.com/oauth2/get_token';
const API = 'https://fantasysports.yahooapis.com/fantasy/v2';
// One token file per configured Yahoo account (each user connects their own Yahoo login)
function tokenFile(account) {
  return account && account.id ? `yahoo_token_${String(account.id).replace(/[^\w.-]/g, '_')}.json` : 'yahoo_token.json';
}

const STAT_MAP = {
  1: 'passAtt', 2: 'passCmp', 4: 'passYd', 5: 'passTd', 6: 'passInt',
  8: 'rushAtt', 9: 'rushYd', 10: 'rushTd',
  11: 'rec', 12: 'recYd', 13: 'recTd', 78: 'tgt',
  18: 'fumLost', 16: 'twoPt',
  19: 'fgm', 20: 'fgm', 21: 'fgm', 22: 'fgm', 23: 'fgm', 29: 'xpm',
  32: 'sacks', 33: 'defInt', 34: 'defFumRec', 35: 'defTd', 31: 'ptsAllowed',
};

function authUrl(account) {
  const q = new URLSearchParams({
    client_id: account.clientId,
    redirect_uri: 'oob',
    response_type: 'code',
    language: 'en-us',
  });
  return `${AUTH}?${q}`;
}

async function tokenRequest(account, params) {
  const basic = Buffer.from(`${account.clientId}:${account.clientSecret}`).toString('base64');
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Yahoo token error ${res.status}: ${text.slice(0, 200)}`);
  const tok = JSON.parse(text);
  tok.expires_at = Date.now() + (num(tok.expires_in, 3600) - 60) * 1000;
  writeJson(tokenFile(account), tok);
  return tok;
}

async function exchangeCode(account, code) {
  return tokenRequest(account, { grant_type: 'authorization_code', redirect_uri: 'oob', code: code.trim() });
}

async function getToken(account) {
  let tok = readJson(tokenFile(account));
  if (!tok || !tok.access_token) throw new Error('Yahoo not connected yet. Open Settings and connect Yahoo.');
  if (Date.now() >= (tok.expires_at || 0)) {
    tok = await tokenRequest(account, { grant_type: 'refresh_token', redirect_uri: 'oob', refresh_token: tok.refresh_token });
  }
  return tok.access_token;
}

function isConnected(account) {
  const tok = readJson(tokenFile(account));
  return !!(tok && tok.refresh_token);
}

function disconnect(account) {
  writeJson(tokenFile(account), {});
}

async function yget(account, path) {
  const token = await getToken(account);
  const data = await fetchJson(`${API}/${path}${path.includes('?') ? '&' : '?'}format=json`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  return data.fantasy_content;
}

// Yahoo JSON is arrays-of-single-key-objects. Flatten one of those into a plain object.
function flat(x) {
  if (Array.isArray(x)) {
    const out = {};
    for (const item of x) {
      if (item && typeof item === 'object' && !Array.isArray(item)) Object.assign(out, item);
      else if (Array.isArray(item)) Object.assign(out, flat(item));
    }
    return out;
  }
  return x && typeof x === 'object' ? x : {};
}

// Iterate a Yahoo "collection" object: {"0": {...}, "1": {...}, count: n}
function items(coll, key) {
  if (!coll) return [];
  const out = [];
  const n = num(coll.count, Object.keys(coll).filter((k) => /^\d+$/.test(k)).length);
  for (let i = 0; i < n; i++) {
    const it = coll[String(i)];
    if (it && it[key] != null) out.push(it[key]);
  }
  return out;
}

// A Yahoo entity is an array where [0] is meta (array of objects) and [1..] are sub-resources (objects)
function entity(arr) {
  if (!Array.isArray(arr)) return { meta: flat(arr), subs: {} };
  const meta = flat(arr[0]);
  const subs = {};
  for (const s of arr.slice(1)) if (s && typeof s === 'object') Object.assign(subs, s);
  return { meta, subs };
}

function mapStats(statsArr) {
  if (!statsArr) return null;
  const out = {};
  for (const s of statsArr) {
    const st = s.stat || s;
    const key = STAT_MAP[st.stat_id];
    if (!key) continue;
    out[key] = (out[key] || 0) + num(st.value);
  }
  return Object.keys(out).length ? out : null;
}

function parseRoster(teamArr, ctx) {
  const { subs } = entity(teamArr);
  const rosterColl = subs.roster && subs.roster['0'] && subs.roster['0'].players;
  const players = items(rosterColl, 'player');
  return players.map((pArr) => {
    const { meta, subs: ps } = entity(pArr);
    const sel = flat(ps.selected_position);
    const slot = sel.position || 'BN';
    const starter = !['BN', 'IR', 'IR+', 'NA'].includes(slot);
    const stats = mapStats(ps.player_stats && ps.player_stats.stats);
    const pos = meta.display_position || meta.primary_position || '';
    const team = normTeam(meta.editorial_team_abbr);
    return {
      id: String(meta.player_id || meta.player_key),
      name: pos === 'DEF' ? `${(meta.name && meta.name.full) || team} D/ST` : (meta.name && meta.name.full) || '',
      pos,
      team,
      injury: meta.status || '',
      slot,
      starter,
      points: round1(ps.player_points && ps.player_points.total),
      projected: ps.player_projected_points ? round1(ps.player_projected_points.total) : null,
      stats,
      statLine: statLine(stats),
      game: gameFor(ctx.nfl, team),
    };
  });
}

async function fetchLeagues(account, ctx) {
  const fc = await yget(account, 'users;use_login=1/games;game_keys=nfl/teams');
  const user = entity(items(fc.users, 'user')[0]);
  const games = items(user.subs.games, 'game');
  const results = [];
  for (const gArr of games) {
    const g = entity(gArr);
    const teams = items(g.subs.teams, 'team');
    for (const tArr of teams) {
      const t = entity(tArr);
      const teamKey = t.meta.team_key;
      const leagueKey = teamKey.split('.t.')[0];
      try {
        results.push(await fetchLeague(account, leagueKey, teamKey, ctx));
      } catch (e) {
        results.push({ key: `yahoo:${leagueKey}`, platform: 'yahoo', leagueId: leagueKey, name: `Yahoo league ${leagueKey}`, error: e.message });
      }
    }
  }
  return results;
}

async function fetchLeague(account, leagueKey, myTeamKey, ctx) {
  const lfc = await yget(account, `league/${leagueKey};out=settings/scoreboard`);
  const lg = entity(lfc.league);
  const week = num(lg.meta.current_week, ctx.week || 1);
  const sb = lg.subs.scoreboard;
  const matchups = items(sb && sb['0'] && sb['0'].matchups, 'matchup');

  let myMeta = null;
  let oppMeta = null;
  const scoreboard = [];
  for (const m of matchups) {
    const teamsColl = m['0'] && m['0'].teams;
    const ts = items(teamsColl, 'team').map((tArr) => {
      const t = entity(tArr);
      return {
        key: t.meta.team_key,
        id: String(t.meta.team_id),
        name: t.meta.name,
        owner: (((t.meta.managers || [])[0] || {}).manager || {}).nickname || '',
        points: round1(t.subs.team_points && t.subs.team_points.total),
        projected: t.subs.team_projected_points ? round1(t.subs.team_projected_points.total) : null,
        isMe: t.meta.team_key === myTeamKey,
      };
    });
    scoreboard.push({ teams: ts.map(({ id, name, points, isMe }) => ({ id, name, points, isMe })) });
    const mine = ts.find((t) => t.isMe);
    if (mine) {
      myMeta = mine;
      oppMeta = ts.find((t) => !t.isMe) || null;
    }
  }
  if (!myMeta) {
    const tfc = await yget(account, `team/${myTeamKey}`);
    const t = entity(tfc.team);
    myMeta = { key: myTeamKey, id: String(t.meta.team_id), name: t.meta.name, owner: '', points: 0, projected: null };
  }

  const loadTeam = async (meta) => {
    const tfc = await yget(account, `team/${meta.key}/roster;week=${week}/players/stats;type=week;week=${week}`);
    const roster = parseRoster(tfc.team, ctx);
    const starters = roster.filter((p) => p.starter);
    const live = round1(starters.reduce((s, p) => s + p.points, 0));
    return {
      id: meta.id,
      name: meta.name,
      owner: meta.owner,
      record: '',
      points: Math.max(meta.points || 0, live),
      projected: meta.projected,
      roster,
    };
  };

  const settings = flat(lg.subs.settings);
  const standingsFc = await yget(account, `league/${leagueKey}/standings`).catch(() => null);
  const recordFor = (teamKey) => {
    if (!standingsFc) return '';
    const st = entity(standingsFc.league).subs.standings;
    for (const tArr of items(st && st['0'] && st['0'].teams, 'team')) {
      const t = entity(tArr);
      if (t.meta.team_key !== teamKey) continue;
      const o = (t.subs.team_standings && t.subs.team_standings.outcome_totals) || {};
      return `${o.wins || 0}-${o.losses || 0}${num(o.ties) ? `-${o.ties}` : ''}`;
    }
    return '';
  };

  const myTeam = await loadTeam(myMeta);
  myTeam.record = recordFor(myMeta.key);
  let opponent = null;
  if (oppMeta) {
    opponent = await loadTeam(oppMeta);
    opponent.record = recordFor(oppMeta.key);
  }

  const recStat = ((settings.stat_modifiers && settings.stat_modifiers.stats) || []).map((s) => s.stat).find((s) => s && String(s.stat_id) === '11');
  const recVal = recStat ? num(recStat.value) : 0;
  return {
    key: `yahoo:${leagueKey}`,
    platform: 'yahoo',
    leagueId: leagueKey,
    name: lg.meta.name,
    season: lg.meta.season,
    week,
    url: lg.meta.url || 'https://football.fantasysports.yahoo.com/',
    scoring: recVal === 1 ? 'PPR' : recVal === 0.5 ? 'Half PPR' : 'Standard',
    teamCount: num(lg.meta.num_teams),
    myTeam,
    opponent,
    scoreboard,
  };
}

module.exports = { platform: 'yahoo', fetchLeagues, authUrl, exchangeCode, isConnected, disconnect };
