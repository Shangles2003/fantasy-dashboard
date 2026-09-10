'use strict';
// Sleeper adapter: public API, only needs a username.
const { fetchJson, normTeam, statLine, num, round1 } = require('../lib/util');
const { cached } = require('../lib/cache');
const { gameFor } = require('../lib/nfl');

const API = 'https://api.sleeper.app/v1';
const DAY = 24 * 60 * 60 * 1000;

const STAT_MAP = {
  pass_yd: 'passYd', pass_td: 'passTd', pass_int: 'passInt', pass_att: 'passAtt', pass_cmp: 'passCmp',
  rush_att: 'rushAtt', rush_yd: 'rushYd', rush_td: 'rushTd',
  rec: 'rec', rec_tgt: 'tgt', rec_yd: 'recYd', rec_td: 'recTd',
  fum_lost: 'fumLost', pass_2pt: 'twoPt', rush_2pt: 'twoPt', rec_2pt: 'twoPt',
  fgm: 'fgm', xpm: 'xpm',
  sack: 'sacks', int: 'defInt', fum_rec: 'defFumRec', def_td: 'defTd', pts_allow: 'ptsAllowed',
};

function mapStats(raw) {
  if (!raw) return null;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = STAT_MAP[k];
    if (!key || v == null) continue;
    out[key] = (out[key] || 0) + num(v);
  }
  return Object.keys(out).length ? out : null;
}

// Per-refresh shared data (players DB, week stats, projections)
async function loadShared(ctx) {
  if (ctx._sleeper) return ctx._sleeper;
  const state = await fetchJson(`${API}/state/nfl`);
  const season = state.season;
  const week = state.week || ctx.week || 1;
  const seasonType = state.season_type || 'regular';
  const players = await cached('sleeper_players.json', DAY, () => fetchJson(`${API}/players/nfl`, {}, { timeoutMs: 60000 }));
  let stats = {};
  let proj = {};
  try {
    stats = (await fetchJson(`${API}/stats/nfl/${seasonType}/${season}/${week}`, {}, { timeoutMs: 30000 })) || {};
  } catch (e) {
    ctx.warn(`Sleeper stats unavailable: ${e.message}`);
  }
  try {
    proj = (await fetchJson(`${API}/projections/nfl/${seasonType}/${season}/${week}`, {}, { timeoutMs: 30000 })) || {};
  } catch {
    /* projections optional */
  }
  ctx._sleeper = { season, week, seasonType, players, stats, proj };
  return ctx._sleeper;
}

function playerInfo(players, pid) {
  const p = players[pid];
  if (!p) {
    // Team defenses use the team abbreviation as the id
    if (/^[A-Z]{2,3}$/.test(pid)) return { name: `${pid} D/ST`, pos: 'DEF', team: pid, injury: '' };
    return { name: `Unknown (${pid})`, pos: '', team: '', injury: '' };
  }
  const name = p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || pid;
  return {
    name: p.position === 'DEF' ? `${name} D/ST` : name,
    pos: p.position || (p.fantasy_positions || [])[0] || '',
    team: normTeam(p.team),
    injury: p.injury_status || '',
  };
}

function buildRoster(roster, matchup, league, shared, ctx) {
  const starters = (matchup && matchup.starters) || roster.starters || [];
  const allPlayers = (matchup && matchup.players) || roster.players || [];
  const slotNames = (league.roster_positions || []).filter((s) => s !== 'BN');
  const pp = (matchup && matchup.players_points) || {};
  const out = [];
  const seen = new Set();
  starters.forEach((pid, i) => {
    if (!pid || pid === '0') return;
    seen.add(pid);
    out.push(mkPlayer(pid, slotNames[i] || 'FLEX', true, pp, shared, ctx));
  });
  for (const pid of allPlayers) {
    if (seen.has(pid)) continue;
    const slot = (roster.reserve || []).includes(pid) ? 'IR' : (roster.taxi || []).includes(pid) ? 'TAXI' : 'BN';
    out.push(mkPlayer(pid, slot, false, pp, shared, ctx));
  }
  return out;
}

function mkPlayer(pid, slot, starter, pointsMap, shared, ctx) {
  const info = playerInfo(shared.players, pid);
  const raw = shared.stats[pid];
  const stats = mapStats(raw);
  const proj = shared.proj[pid];
  return {
    id: String(pid),
    name: info.name,
    pos: info.pos,
    team: info.team,
    injury: info.injury,
    slot,
    starter,
    points: round1(pointsMap[pid] != null ? pointsMap[pid] : (raw && raw.pts_ppr) || 0),
    projected: proj ? round1(proj.pts_ppr || proj.pts_half_ppr || proj.pts_std || 0) : null,
    stats,
    statLine: statLine(stats),
    game: gameFor(ctx.nfl, info.team),
  };
}

async function fetchLeagues(account, ctx) {
  const shared = await loadShared(ctx);
  const user = await fetchJson(`${API}/user/${encodeURIComponent(account.username)}`);
  if (!user || !user.user_id) throw new Error(`Sleeper user "${account.username}" not found`);
  const uid = user.user_id;
  const leagues = await fetchJson(`${API}/user/${uid}/leagues/nfl/${shared.season}`);
  const results = [];
  for (const lg of leagues || []) {
    try {
      results.push(await fetchLeague(lg, uid, shared, ctx));
    } catch (e) {
      results.push({ key: `sleeper:${lg.league_id}`, platform: 'sleeper', leagueId: lg.league_id, name: lg.name, error: e.message });
    }
  }
  return results;
}

async function fetchLeague(lg, uid, shared, ctx) {
  const week = shared.week;
  const [rosters, users, matchups] = await Promise.all([
    fetchJson(`${API}/league/${lg.league_id}/rosters`),
    fetchJson(`${API}/league/${lg.league_id}/users`),
    fetchJson(`${API}/league/${lg.league_id}/matchups/${week}`),
  ]);
  const userById = Object.fromEntries((users || []).map((u) => [u.user_id, u]));
  const teamName = (r) => {
    const u = userById[r.owner_id] || {};
    return (u.metadata && u.metadata.team_name) || u.display_name || `Team ${r.roster_id}`;
  };
  const myRoster = (rosters || []).find((r) => r.owner_id === uid || (r.co_owners || []).includes(uid));
  if (!myRoster) throw new Error('You are not on a roster in this league');
  const mByRoster = Object.fromEntries((matchups || []).map((m) => [m.roster_id, m]));
  const myM = mByRoster[myRoster.roster_id];
  const oppRoster = myM && myM.matchup_id != null
    ? rosters.find((r) => r.roster_id !== myRoster.roster_id && mByRoster[r.roster_id]?.matchup_id === myM.matchup_id)
    : null;

  const mkTeam = (r) => {
    const m = mByRoster[r.roster_id];
    const roster = buildRoster(r, m, lg, shared, ctx);
    const starters = roster.filter((p) => p.starter);
    return {
      id: String(r.roster_id),
      name: teamName(r),
      owner: (userById[r.owner_id] || {}).display_name || '',
      record: `${r.settings?.wins || 0}-${r.settings?.losses || 0}${r.settings?.ties ? `-${r.settings.ties}` : ''}`,
      points: round1(m ? m.points : 0),
      projected: starters.length && starters.every((p) => p.projected != null) ? round1(starters.reduce((s, p) => s + (p.projected || 0), 0)) : null,
      roster,
    };
  };

  // Whole-league scoreboard
  const groups = {};
  for (const m of matchups || []) {
    if (m.matchup_id == null) continue;
    (groups[m.matchup_id] = groups[m.matchup_id] || []).push(m);
  }
  const scoreboard = Object.values(groups).map((ms) => ({
    teams: ms.map((m) => {
      const r = rosters.find((x) => x.roster_id === m.roster_id) || { roster_id: m.roster_id };
      const starters = buildRoster(r, m, lg, shared, ctx).filter((p) => p.starter).map((p) => ({ points: p.points, projected: p.projected, game: p.game }));
      return { id: String(m.roster_id), name: teamName(r), points: round1(m.points), isMe: m.roster_id === myRoster.roster_id, starters };
    }),
  }));

  return {
    key: `sleeper:${lg.league_id}`,
    platform: 'sleeper',
    leagueId: lg.league_id,
    name: lg.name,
    season: shared.season,
    week,
    url: `https://sleeper.com/leagues/${lg.league_id}`,
    scoring: lg.scoring_settings?.rec === 1 ? 'PPR' : lg.scoring_settings?.rec === 0.5 ? 'Half PPR' : 'Standard',
    teamCount: lg.total_rosters,
    myTeam: mkTeam(myRoster),
    opponent: oppRoster ? mkTeam(oppRoster) : null,
    scoreboard,
  };
}

module.exports = { platform: 'sleeper', fetchLeagues, __test: { fetchLeague } };
