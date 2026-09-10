'use strict';
// Live projections and win probability for a fantasy matchup.
//
// Each starter's expected final = points so far + (full-game projection x fraction of their NFL game left).
// Uncertainty: a player's remaining output is modelled as normal with sd = SIGMA x remaining projection
// (fantasy weekly outcomes typically vary by 60-80% of projection) plus a small floor for random events.
// Team finals are then normal; P(win) = Phi((mu_a - mu_b) / sqrt(var_a + var_b)).

const SIGMA = 0.7;
const FLOOR_SD = 0.75; // per-starter sd even when almost nothing is left (a late TD, a fumble)

function clockMinutes(clock) {
  const m = /^(\d+):(\d{2})$/.exec(String(clock || '').trim());
  return m ? Number(m[1]) + Number(m[2]) / 60 : 0;
}

// Fraction of the player's NFL game still to be played: 1 before kickoff, 0 after, in between during.
function remainingFraction(game) {
  if (!game || game.state === 'none') return 0;
  if (game.state === 'pre') return 1;
  if (game.state === 'post' || game.completed) return 0;
  const period = Number(game.period) || 1;
  const mins = clockMinutes(game.clock);
  let remaining;
  if (period <= 4) remaining = (4 - period) * 15 + mins;
  else remaining = Math.min(mins, 10); // overtime
  return Math.min(1, Math.max(0.02, remaining / 60));
}

// starters: [{ points, projected, game }]
function teamOutlook(starters) {
  let mu = 0;
  let variance = 0;
  let anyProj = false;
  let remainingProj = 0;
  for (const p of starters || []) {
    const pts = Number(p.points) || 0;
    const proj = p.projected != null ? Number(p.projected) || 0 : null;
    const frac = remainingFraction(p.game);
    if (proj != null) anyProj = true;
    const rem = proj != null ? Math.max(0, proj) * frac : 0;
    remainingProj += rem;
    mu += pts + rem;
    if (frac > 0) variance += Math.pow(SIGMA * rem, 2) + Math.pow(FLOOR_SD * frac, 2);
  }
  return { liveProjected: Math.round(mu * 100) / 100, sd: Math.sqrt(variance), remainingProj, hasProjection: anyProj };
}

// Standard normal CDF (Abramowitz-Stegun approximation, good to ~1e-7)
function phi(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z >= 0 ? 1 - p : p;
}

function winProbability(a, b) {
  if (!a || !b) return null;
  const sd = Math.sqrt(a.sd * a.sd + b.sd * b.sd);
  const diff = a.liveProjected - b.liveProjected;
  if (sd < 1e-6) return diff > 0 ? 1 : diff < 0 ? 0 : 0.5; // everything final
  return phi(diff / sd);
}

// Attach liveProjected / winProb to a league's myTeam, opponent, and any scoreboard teams that carry
// enough data (either a `starters` sample or a platform-provided projection).
function enrichLeague(league) {
  if (!league || league.error) return league;
  const outlookFor = (team) => {
    const starters = team && team.roster ? team.roster.filter((p) => p.starter) : [];
    if (!starters.length) return null; // no lineup yet (pre-draft league): nothing to project
    return teamOutlook(starters);
  };
  const me = outlookFor(league.myTeam);
  const opp = outlookFor(league.opponent);
  if (league.myTeam && me) {
    league.myTeam.liveProjected = me.liveProjected;
    league.myTeam.winProb = opp ? round3(winProbability(me, opp)) : null;
  }
  if (league.opponent && opp) {
    league.opponent.liveProjected = opp.liveProjected;
    league.opponent.winProb = me ? round3(winProbability(opp, me)) : null;
  }
  for (const m of league.scoreboard || []) {
    const outs = m.teams.map((t) => {
      if (t.starters) return teamOutlook(t.starters);
      if (t.projected != null) {
        // Platform gave a team projection but no per-player detail: treat it as the live projection
        // with uncertainty scaled to how much of the week is left (crude, but honest about spread).
        const fracLeft = t.remainingFraction != null ? t.remainingFraction : 1;
        return { liveProjected: Number(t.projected), sd: Math.max(0.5, SIGMA * Number(t.projected) * 0.45 * fracLeft), hasProjection: true };
      }
      return null;
    });
    m.teams.forEach((t, i) => {
      const o = outs[i];
      const other = outs[1 - i];
      if (o) {
        t.liveProjected = o.liveProjected;
        t.winProb = other ? round3(winProbability(o, other)) : null;
      }
      delete t.starters;
    });
  }
  return league;
}

function round3(x) {
  return x == null ? null : Math.round(x * 1000) / 1000;
}

module.exports = { remainingFraction, teamOutlook, winProbability, enrichLeague };
