'use strict';
// ESPN Fantasy Football adapter. Needs the espn_s2 and SWID cookies from a logged-in browser session.
const { fetchJson, normTeam, statLine, num, round1 } = require('../lib/util');
const { gameFor } = require('../lib/nfl');

const LM = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons';

const SLOT = {
  0: 'QB', 1: 'TQB', 2: 'RB', 3: 'RB/WR', 4: 'WR', 5: 'WR/TE', 6: 'TE', 7: 'OP', 8: 'DT', 9: 'DE', 10: 'LB',
  11: 'DL', 12: 'CB', 13: 'S', 14: 'DB', 15: 'DP', 16: 'D/ST', 17: 'K', 18: 'P', 19: 'HC', 20: 'BN', 21: 'IR',
  22: 'UNK', 23: 'FLEX', 24: 'EDR', 25: 'RB/WR/TE',
};
const POS = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 7: 'P', 9: 'DT', 10: 'DE', 11: 'LB', 12: 'CB', 13: 'S', 14: 'HC', 16: 'DEF' };
const PRO_TEAM = {
  0: '', 1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET', 9: 'GB', 10: 'TEN', 11: 'IND',
  12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA', 16: 'MIN', 17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ', 21: 'PHI', 22: 'ARI',
  23: 'PIT', 24: 'LAC', 25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WAS', 29: 'CAR', 30: 'JAX', 33: 'BAL', 34: 'HOU',
};
const STAT_MAP = {
  0: 'passAtt', 1: 'passCmp', 3: 'passYd', 4: 'passTd', 20: 'passInt',
  23: 'rushAtt', 24: 'rushYd', 25: 'rushTd',
  58: 'tgt', 53: 'rec', 42: 'recYd', 43: 'recTd',
  72: 'fumLost', 19: 'twoPt', 26: 'twoPt', 44: 'twoPt',
  80: 'fgm', 86: 'xpm',
  99: 'sacks', 95: 'defInt', 96: 'defFumRec', 103: 'defTd', 120: 'ptsAllowed',
};

function mapStats(raw) {
  if (!raw) return null;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = STAT_MAP[k];
    if (!key) continue;
    out[key] = (out[key] || 0) + num(v);
  }
  return Object.keys(out).length ? out : null;
}

// Normalize a pasted espn_s2: people copy it URL-encoded (%2F...) or decoded (/, +, =), sometimes with
// quotes or an "espn_s2=" prefix. ESPN wants the encoded form.
function normalizeS2(raw) {
  let v = String(raw || '').trim().replace(/^espn_s2=/i, '').replace(/^["']|["']$/g, '').replace(/;.*$/, '').trim();
  try {
    return encodeURIComponent(decodeURIComponent(v));
  } catch {
    return encodeURIComponent(v);
  }
}

function cookieHeader(account) {
  let swid = String(account.swid || '').trim().replace(/^SWID=/i, '').replace(/^["']|["']$/g, '');
  if (swid && !swid.startsWith('{')) swid = `{${swid}}`;
  swid = swid.toUpperCase();
  return { swid, headers: { Cookie: `espn_s2=${normalizeS2(account.espn_s2)}; SWID=${swid}`, Accept: 'application/json' } };
}

// Discover the leagues this SWID belongs to via ESPN's fan API. Falls back to account.leagueIds.
async function discoverLeagues(account, season, hdr) {
  const explicit = (account.leagueIds || []).map((x) => String(x).trim()).filter(Boolean);
  if (explicit.length) return explicit;
  const swid = hdr.swid;
  // ESPN moved its "fan" profile API from fan.espn.com to fan.api.espn.com; try both.
  let data = null;
  let lastErr = null;
  for (const host of ['fan.api.espn.com', 'fan.espn.com']) {
    const url = `https://${host}/apis/v2/fans/${encodeURIComponent(swid)}?displayEvents=false&displayNow=false&displayRecs=false&platform=web&lang=en&region=us&source=espn`;
    try {
      data = await fetchJson(url, { headers: hdr.headers }, { retries: 0 });
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!data) throw new Error(`ESPN league discovery failed (${lastErr && lastErr.message}). Add league IDs manually in Settings.`);
  const ids = new Set();
  for (const p of data.preferences || []) {
    const entry = p.metaData && p.metaData.entry;
    if (!entry) continue;
    if (String(entry.gameId) !== '1') continue; // 1 = fantasy football
    if (String(entry.seasonId) !== String(season)) continue;
    for (const g of entry.groups || []) ids.add(String(g.groupId));
  }
  if (!ids.size) throw new Error('No ESPN fantasy football leagues found for this SWID this season. Add league IDs manually in Settings.');
  return [...ids];
}

function playerFromEntry(entry, week, ctx) {
  const ppe = entry.playerPoolEntry || {};
  const p = ppe.player || {};
  const pos = POS[p.defaultPositionId] || '';
  const team = normTeam(PRO_TEAM[p.proTeamId] || '');
  const slot = SLOT[entry.lineupSlotId] || 'BN';
  const starter = !['BN', 'IR'].includes(slot);
  const weekStats = (p.stats || []).filter((s) => s.scoringPeriodId === week && s.statSplitTypeId === 1);
  const actual = weekStats.find((s) => s.statSourceId === 0);
  const proj = weekStats.find((s) => s.statSourceId === 1);
  const stats = mapStats(actual && actual.stats);
  const points = ppe.appliedStatTotal != null ? ppe.appliedStatTotal : actual ? actual.appliedTotal : 0;
  return {
    id: String(p.id),
    name: p.fullName || `${p.firstName || ''} ${p.lastName || ''}`.trim(),
    pos,
    team,
    injury: p.injuryStatus && p.injuryStatus !== 'ACTIVE' ? p.injuryStatus : '',
    slot,
    starter,
    points: round1(points),
    projected: proj ? round1(proj.appliedTotal) : null,
    stats,
    statLine: statLine(stats),
    game: gameFor(ctx.nfl, team),
  };
}

async function fetchLeagues(account, ctx) {
  const hdr = cookieHeader(account);
  const season = account.season || ctx.season || new Date().getFullYear();
  const ids = await discoverLeagues(account, season, hdr);
  const results = [];
  for (const id of ids) {
    try {
      results.push(await fetchLeague(id, season, hdr, ctx));
    } catch (e) {
      let msg = e.message;
      if (e.status === 401 || /not authorized/i.test(msg)) {
        msg = 'ESPN says this login is not authorized for the league. Usually the espn_s2 cookie was copied incompletely or from a different ESPN login. Re-copy SWID and the full espn_s2 value (it is ~300 characters) from fantasy.espn.com and save again.';
      }
      results.push({ key: `espn:${id}`, platform: 'espn', leagueId: id, name: `ESPN league ${id}`, error: msg });
    }
  }
  return results;
}

async function fetchLeague(leagueId, season, hdr, ctx) {
  const base = `${LM}/${season}/segments/0/leagues/${leagueId}`;
  // First call to learn the current scoring period, then fetch with the roster for that period
  const meta = await fetchJson(`${base}?view=mSettings`, { headers: hdr.headers });
  const week = meta.scoringPeriodId || meta.status?.latestScoringPeriod || ctx.week || 1;
  const data = await fetchJson(
    `${base}?view=mMatchupScore&view=mRoster&view=mTeam&view=mSettings&scoringPeriodId=${week}`,
    { headers: hdr.headers },
  );
  const teams = data.teams || [];
  const members = Object.fromEntries((data.members || []).map((m) => [String(m.id).toUpperCase(), m]));
  const mySwid = hdr.swid.toUpperCase();
  const myTeamRaw = teams.find((t) => (t.owners || []).some((o) => String(o).toUpperCase() === mySwid));
  if (!myTeamRaw) throw new Error('Your SWID is not an owner of any team in this league');

  const teamName = (t) => t.name || `${t.location || ''} ${t.nickname || ''}`.trim() || `Team ${t.id}`;
  const ownerName = (t) => {
    const m = members[String((t.owners || [])[0] || '').toUpperCase()];
    return m ? m.displayName || `${m.firstName || ''} ${m.lastName || ''}`.trim() : '';
  };
  const record = (t) => {
    const o = (t.record && t.record.overall) || {};
    return `${o.wins || 0}-${o.losses || 0}${o.ties ? `-${o.ties}` : ''}`;
  };

  const matchupPeriod = data.status?.currentMatchupPeriod || week;
  const schedule = (data.schedule || []).filter((m) => m.matchupPeriodId === matchupPeriod);
  const sideFor = (teamId) => {
    for (const m of schedule) {
      if (m.home && m.home.teamId === teamId) return { me: m.home, opp: m.away };
      if (m.away && m.away.teamId === teamId) return { me: m.away, opp: m.home };
    }
    return { me: null, opp: null };
  };

  const mkTeam = (t, side) => {
    // ESPN's matchup view strips player identity from its per-period roster, so use the team's
    // full roster (mRoster for this scoringPeriodId): it carries names, slots, live points and projections.
    const entries = (t.roster && t.roster.entries) || [];
    const roster = entries.map((e) => playerFromEntry(e, week, ctx));
    const starters = roster.filter((p) => p.starter);
    const liveTotal = starters.reduce((s, p) => s + p.points, 0);
    const points = side && side.totalPointsLive != null ? side.totalPointsLive : side && side.totalPoints ? side.totalPoints : liveTotal;
    return {
      id: String(t.id),
      name: teamName(t),
      owner: ownerName(t),
      record: record(t),
      points: round1(Math.max(points, liveTotal)),
      projected: starters.length && starters.every((p) => p.projected != null) ? round1(starters.reduce((s, p) => s + p.projected, 0)) : null,
      roster,
    };
  };

  const sides = sideFor(myTeamRaw.id);
  const oppRaw = sides.opp ? teams.find((t) => t.id === sides.opp.teamId) : null;

  const sideProjection = (s) => {
    if (s.totalProjectedPointsLive != null) return round1(s.totalProjectedPointsLive);
    const entries = (s.rosterForCurrentScoringPeriod && s.rosterForCurrentScoringPeriod.entries) || [];
    let sum = 0;
    let any = false;
    for (const e of entries) {
      const slot = SLOT[e.lineupSlotId] || 'BN';
      if (slot === 'BN' || slot === 'IR') continue;
      const st = (((e.playerPoolEntry || {}).player || {}).stats || []).find((x) => x.scoringPeriodId === week && x.statSourceId === 1 && x.statSplitTypeId === 1);
      if (st) {
        any = true;
        sum += num(st.appliedTotal);
      }
    }
    return any ? round1(sum) : null;
  };
  const scoreboard = schedule.map((m) => ({
    teams: [m.home, m.away].filter(Boolean).map((s) => {
      const t = teams.find((x) => x.id === s.teamId) || { id: s.teamId };
      return { id: String(s.teamId), name: teamName(t), points: round1(s.totalPointsLive != null ? s.totalPointsLive : s.totalPoints || 0), isMe: s.teamId === myTeamRaw.id, projected: sideProjection(s) };
    }),
  }));

  const recVal = data.settings?.scoringSettings?.scoringItems?.find((i) => i.statId === 53)?.points;
  return {
    key: `espn:${leagueId}`,
    platform: 'espn',
    leagueId: String(leagueId),
    name: data.settings?.name || `ESPN league ${leagueId}`,
    season,
    week,
    url: `https://fantasy.espn.com/football/league?leagueId=${leagueId}`,
    scoring: recVal === 1 ? 'PPR' : recVal === 0.5 ? 'Half PPR' : recVal ? `${recVal}/rec` : 'Standard',
    teamCount: teams.length,
    myTeam: mkTeam(myTeamRaw, sides.me),
    opponent: oppRaw ? mkTeam(oppRaw, sides.opp) : null,
    scoreboard,
  };
}

module.exports = { platform: 'espn', fetchLeagues };
