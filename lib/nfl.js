'use strict';
// Live NFL game state from ESPN's public scoreboard (no auth needed).
const { fetchJson, normTeam } = require('./util');

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

async function getNfl() {
  const data = await fetchJson(SCOREBOARD);
  const games = [];
  for (const ev of data.events || []) {
    const comp = (ev.competitions || [])[0] || {};
    const home = (comp.competitors || []).find((c) => c.homeAway === 'home') || {};
    const away = (comp.competitors || []).find((c) => c.homeAway === 'away') || {};
    const st = ev.status || {};
    const type = st.type || {};
    games.push({
      id: ev.id,
      start: ev.date,
      state: type.state || 'pre', // pre | in | post
      completed: !!type.completed,
      detail: type.shortDetail || type.detail || '',
      period: st.period || 0,
      clock: st.displayClock || '',
      home: { team: normTeam(home.team && home.team.abbreviation), name: home.team && home.team.displayName, score: Number(home.score || 0) },
      away: { team: normTeam(away.team && away.team.abbreviation), name: away.team && away.team.displayName, score: Number(away.score || 0) },
      possession: normTeam(comp.situation && comp.situation.possession
        ? [home, away].find((c) => c.id === comp.situation.possession)?.team?.abbreviation
        : ''),
      downDistance: (comp.situation && comp.situation.downDistanceText) || '',
      broadcast: ((comp.broadcasts || [])[0]?.names || [])[0] || '',
    });
  }
  games.sort((a, b) => new Date(a.start) - new Date(b.start));
  const byTeam = {};
  for (const g of games) {
    byTeam[g.home.team] = g;
    byTeam[g.away.team] = g;
  }
  return {
    season: data.season && data.season.year,
    seasonType: data.season && data.season.type, // 1 pre, 2 regular, 3 post
    week: data.week && data.week.number,
    games,
    byTeam,
    anyLive: games.some((g) => g.state === 'in'),
    nextKickoff: games.filter((g) => g.state === 'pre').map((g) => g.start)[0] || null,
  };
}

// Attach game context to a normalized player
function gameFor(nfl, team) {
  const g = nfl && nfl.byTeam[normTeam(team)];
  if (!g) return { state: 'none', detail: 'No game', opponent: '', start: null };
  const isHome = g.home.team === normTeam(team);
  const opp = isHome ? g.away.team : g.home.team;
  return {
    id: g.id,
    state: g.state,
    detail: g.detail,
    clock: g.clock,
    period: g.period,
    start: g.start,
    opponent: (isHome ? 'vs ' : '@ ') + opp,
    score: `${g.away.team} ${g.away.score} - ${g.home.team} ${g.home.score}`,
    hasBall: g.possession === normTeam(team),
  };
}

module.exports = { getNfl, gameFor };
