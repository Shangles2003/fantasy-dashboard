'use strict';
// CBS Sports Fantasy adapter. Uses CBS's legacy v3 API, which still works with a per-league access token.
// The token is embedded in a logged-in league page (`var token = "..."`) or visible in the page's
// network requests to api.cbssports.com. One CBS account entry = one league.
const { fetchJson, normTeam, num, round1 } = require('../lib/util');
const { gameFor } = require('../lib/nfl');

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

function player(p, projMap, ctx) {
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
  return {
    id: String(p.id),
    name,
    pos,
    team,
    injury,
    slot,
    starter,
    points: pts(p.fpts_period != null ? p.fpts_period : p.fpts),
    projected: proj != null ? pts(proj) : null,
    stats: null,
    statLine: String(p.stats_period || '').trim(),
    game: gameFor(ctx.nfl, team),
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

  // Projections come from the rosters resource (optional)
  const projMap = {};
  try {
    const ids = [myId, oppId].filter(Boolean).join(',');
    const rosters = await cget('league/rosters', account, { team_id: ids, period: week });
    for (const t of (rosters.rosters && rosters.rosters.teams) || []) {
      for (const p of t.players || []) if (p.projected_points != null) projMap[String(p.id)] = p.projected_points;
    }
  } catch {
    /* projections optional */
  }

  const mkTeam = (t) => {
    const roster = (t.players || []).map((p) => player(p, projMap, ctx));
    const starters = roster.filter((p) => p.starter);
    const live = round1(starters.reduce((s, p) => s + p.points, 0));
    return {
      id: String(t.id),
      name: t.name || t.long_abbr || `Team ${t.id}`,
      owner: '',
      record: `${num(t.w)}-${num(t.l)}${num(t.t) ? `-${num(t.t)}` : ''}`,
      points: Math.max(pts(t.pts), live),
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
    scoreboard.push({
      teams: [t, o].filter(Boolean).map((x) => ({ id: String(x.id), name: x.name || x.long_abbr, points: pts(x.pts), isMe: String(x.id) === myId })),
    });
  }

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
