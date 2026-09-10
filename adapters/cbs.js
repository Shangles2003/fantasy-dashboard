'use strict';
// CBS Sports Fantasy adapter. Uses CBS's legacy v3 API, which still works with a per-league access token.
// The token is embedded in a logged-in league page (`var token = "..."`) or visible in the page's
// network requests to api.cbssports.com. One CBS account entry = one league.
const { fetchJson, normTeam, num, round1 } = require('../lib/util');
const { gameFor } = require('../lib/nfl');
const { readJson, writeJson } = require('../lib/cache');

// CBS's live feed carries each player's numbers from the previous period into the new one and only
// replaces them once that player records a stat. Individual players reset at kickoff, but team units
// (D/ST, team QB) and kickers keep stale values well into a game. So we remember every player's value
// while their game is still 'pre' and treat an unchanged value after kickoff as stale.
const BASELINE_FILE = 'cbs_baseline.json';
let baselineCache = null;
function baselineFor(key) {
  if (!baselineCache) baselineCache = readJson(BASELINE_FILE, {}) || {};
  const league = key.split(':')[0];
  for (const k of Object.keys(baselineCache)) if (k.startsWith(`${league}:`) && k !== key) delete baselineCache[k];
  if (!baselineCache[key]) baselineCache[key] = {};
  return baselineCache[key];
}
function saveBaseline() {
  if (baselineCache) writeJson(BASELINE_FILE, baselineCache);
}

const API = 'https://api.cbssports.com/fantasy';

// Tolerate tokens pasted straight from page source, e.g.  "U2Fsd...";  or  CBSi.token = "U2Fsd..."
function cleanToken(raw) {
  let t = String(raw || '').trim();
  const m = t.match(/["']([^"']+)["']/);
  if (m) t = m[1];
  return t.replace(/[\s;"']/g, '');
}

function url(path, account, params = {}) {
  const q = new URLSearchParams({ version: '3.0', response_format: 'JSON', access_token: cleanToken(account.accessToken), ...params });
  return `${API}/${path}?${q}`;
}

async function cget(path, account, params) {
  let data;
  try {
    data = await fetchJson(url(path, account, params));
  } catch (e) {
    if (/access token|authenticat/i.test(e.message)) throw new Error('CBS rejected the access token. Grab a fresh one from your league page (see Settings help).');
    throw e;
  }
  if (data && data.statusCode && data.statusCode !== 200) {
    throw new Error(`CBS API error ${data.statusCode}: ${data.statusMessage || ''}`);
  }
  return (data && data.body) || {};
}

function pts(v) {
  return round1(num(String(v == null ? 0 : v).trim()));
}

function player(p, projMap, ctx, scheduled, base) {
  const status = String(p.status || 'Active');
  const starter = status === 'Active';
  let pos = String(p.position || '').toUpperCase();
  if (pos === 'D' || pos === 'DST' || pos === 'DEF') pos = 'DEF';
  const team = normTeam(p.pro_team);
  let slot = String(p.roster_pos || '').toUpperCase();
  if (!starter) slot = status === 'Injured' ? 'IR' : status === 'Practice Squad' ? 'PS' : 'BN';
  else if (slot === 'D' || slot === 'DST') slot = 'DEF';
  const name = pos === 'DEF' ? `${p.fullname || team} D/ST` : p.fullname || `${p.firstname || ''} ${p.lastname || ''}`.trim();
  const injury = p.icons && p.icons.injury ? String(p.icons.injury).split(':')[0] : '';
  const proj = projMap[String(p.id)];
  const game = gameFor(ctx.nfl, team);
  // CBS reports stale points from the previous period until the week's games start; ignore them
  // while the matchup is still scheduled or the player's NFL game hasn't kicked off.
  const notStarted = scheduled || game.state === 'pre' || game.state === 'none';
  const id = String(p.id);
  const rawPts = pts(p.fpts_period != null ? p.fpts_period : p.fpts);
  const rawLine = String(p.stats_period || '').trim();
  let points = rawPts;
  let line = rawLine;
  if (notStarted) {
    base[id] = { p: rawPts, s: rawLine };
    points = 0;
    line = '';
  } else if (base[id] && base[id].p === rawPts && base[id].s === rawLine && (rawPts !== 0 || rawLine)) {
    points = 0; // unchanged since before kickoff: stale carry-over
    line = '';
  } else {
    delete base[id];
  }
  return {
    id,
    name,
    pos,
    team,
    injury,
    slot,
    starter,
    points,
    projected: proj != null ? pts(proj) : null,
    stats: null,
    statLine: line,
    game,
  };
}

async function fetchLeagues(account, ctx) {
  if (!account.accessToken) throw new Error('CBS access token missing');
  const sub = String(account.leagueName || '').trim();
  const leagueId = sub || account.label || 'cbs';
  try {
    return [await fetchLeague(account, leagueId, ctx)];
  } catch (e) {
    return [{ key: `cbs:${leagueId}`, platform: 'cbs', leagueId, name: account.label || (sub ? `CBS ${sub}` : 'CBS league'), error: e.message }];
  }
}

async function fetchLeague(account, leagueId, ctx) {
  const [details, live] = await Promise.all([
    cget('league/details', account).catch(() => ({})),
    cget('league/scoring/live', account),
  ]);
  const ls = live.live_scoring || {};
  const teams = ls.teams || [];
  const myId = String(ls.my_team_id || '');
  const myRaw = teams.find((t) => String(t.id) === myId);
  if (!myRaw) throw new Error('Could not find your team in the live scoring response (is this token for the right league?)');
  const oppId = myRaw.opp_team_id != null ? String(myRaw.opp_team_id) : (myRaw.matchups && myRaw.matchups[0] && String(myRaw.matchups[0].opponent_team_id)) || '';
  const oppRaw = oppId ? teams.find((t) => String(t.id) === oppId) : null;
  const week = num(ls.period, ctx.week || 1);
  const scheduled = String(ls.matchup_status || '').toLowerCase() === 'scheduled';
  const base = baselineFor(`${leagueId}:${ctx.season}:${week}`);

  // Projections come from the rosters resource (optional)
  const projMap = {};
  try {
    const rosters = await cget('league/rosters', account, { team_id: 'all', period: week });
    for (const t of (rosters.rosters && rosters.rosters.teams) || []) {
      for (const p of t.players || []) if (p.projected_points != null) projMap[String(p.id)] = p.projected_points;
    }
  } catch {
    /* projections optional */
  }

  const mkTeam = (t) => {
    const roster = (t.players || []).map((p) => player(p, projMap, ctx, scheduled, base));
    const starters = roster.filter((p) => p.starter);
    const live = round1(starters.reduce((s, p) => s + p.points, 0));
    const teamPts = live; // never trust CBS's team total: it carries stale numbers into a new period
    return {
      id: String(t.id),
      name: t.name || t.long_abbr || `Team ${t.id}`,
      owner: '',
      record: `${num(t.w)}-${num(t.l)}${num(t.t) ? `-${num(t.t)}` : ''}`,
      points: teamPts,
      projected: starters.length && starters.every((p) => p.projected != null) ? round1(starters.reduce((s, p) => s + p.projected, 0)) : null,
      roster,
    };
  };

  // Scoreboard: pair each team with its opponent once
  const seen = new Set();
  const scoreboard = [];
  for (const t of teams) {
    const id = String(t.id);
    if (seen.has(id)) continue;
    const oid = t.opp_team_id != null ? String(t.opp_team_id) : (t.matchups && t.matchups[0] && String(t.matchups[0].opponent_team_id)) || '';
    const o = oid ? teams.find((x) => String(x.id) === oid) : null;
    seen.add(id);
    if (o) seen.add(oid);
    const startersOf = (x) => (x.players || []).map((p) => player(p, projMap, ctx, scheduled, base)).filter((p) => p.starter);
    scoreboard.push({
      teams: [t, o].filter(Boolean).map((x) => {
        const st = startersOf(x);
        return {
          id: String(x.id),
          name: x.name || x.long_abbr,
          points: round1(st.reduce((sum, p) => sum + p.points, 0)),
          isMe: String(x.id) === myId,
          starters: st.map((p) => ({ points: p.points, projected: p.projected, game: p.game })),
        };
      }),
    });
  }

  saveBaseline();
  const d = details.league_details || {};
  const sub = String(account.leagueName || '').trim();
  return {
    key: `cbs:${leagueId}`,
    platform: 'cbs',
    leagueId,
    name: d.name || account.label || `CBS ${leagueId}`,
    season: ctx.season,
    week,
    url: sub ? `https://${sub}.football.cbssports.com/` : 'https://www.cbssports.com/fantasy/football/',
    scoring: ls.scoring_type ? String(ls.scoring_type) : '',
    teamCount: num(d.num_teams, teams.length),
    myTeam: mkTeam(myRaw),
    opponent: oppRaw ? mkTeam(oppRaw) : null,
    scoreboard,
  };
}

module.exports = { platform: 'cbs', fetchLeagues };
