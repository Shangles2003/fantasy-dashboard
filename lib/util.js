'use strict';

// Normalize NFL team abbreviations across platforms (ESPN, Sleeper, Yahoo)
const TEAM_ALIASES = {
  WSH: 'WAS', OAK: 'LV', JAC: 'JAX', LA: 'LAR', SD: 'LAC', STL: 'LAR', HST: 'HOU', BLT: 'BAL', CLV: 'CLE', ARZ: 'ARI',
};
function normTeam(abbr) {
  if (!abbr) return '';
  const up = String(abbr).toUpperCase();
  return TEAM_ALIASES[up] || up;
}

// Name key for matching the same player across platforms
function nameKey(name, pos) {
  const n = String(name || '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${n}|${(pos || '').toUpperCase()}`;
}

// Canonical stat keys shared by all adapters
// passYd passTd passInt passAtt passCmp rushAtt rushYd rushTd rec tgt recYd recTd fumLost twoPt fgm xpm sacks defInt defFumRec defTd ptsAllowed
const STAT_ORDER = [
  ['passCmp', 'passAtt', (s) => `${s.passCmp}/${s.passAtt}`],
  ['passYd', null, (s) => `${s.passYd} pass yd`],
  ['passTd', null, (s) => `${s.passTd} pass TD`],
  ['passInt', null, (s) => `${s.passInt} INT`],
  ['rushAtt', null, (s) => `${s.rushAtt} car`],
  ['rushYd', null, (s) => `${s.rushYd} rush yd`],
  ['rushTd', null, (s) => `${s.rushTd} rush TD`],
  ['rec', null, (s) => `${s.rec} rec` + (s.tgt != null ? ` (${s.tgt} tgt)` : '')],
  ['recYd', null, (s) => `${s.recYd} rec yd`],
  ['recTd', null, (s) => `${s.recTd} rec TD`],
  ['fumLost', null, (s) => `${s.fumLost} FL`],
  ['twoPt', null, (s) => `${s.twoPt} 2PT`],
  ['fgm', null, (s) => `${s.fgm} FG`],
  ['xpm', null, (s) => `${s.xpm} XP`],
  ['sacks', null, (s) => `${s.sacks} sck`],
  ['defInt', null, (s) => `${s.defInt} INT`],
  ['defFumRec', null, (s) => `${s.defFumRec} FR`],
  ['defTd', null, (s) => `${s.defTd} TD`],
  ['ptsAllowed', null, (s) => `${s.ptsAllowed} PA`],
];

function statLine(stats) {
  if (!stats) return '';
  const parts = [];
  for (const [key, key2, fmt] of STAT_ORDER) {
    const v = stats[key];
    if (v == null || v === 0) continue;
    if (key2 && stats[key2] == null) continue;
    parts.push(fmt(stats));
  }
  return parts.join(', ');
}

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function round1(v) {
  return Math.round(num(v) * 100) / 100;
}

async function fetchJson(url, opts = {}, { retries = 2, timeoutMs = 15000 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(t);
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} for ${url.split('?')[0]}: ${text.slice(0, 200)}`);
        err.status = res.status;
        // Don't retry auth errors
        if (res.status === 401 || res.status === 403 || res.status === 404) throw err;
        lastErr = err;
        continue;
      }
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new Error(`Non-JSON response from ${url.split('?')[0]}: ${text.slice(0, 120)}`);
      }
    } catch (e) {
      clearTimeout(t);
      if (e.status === 401 || e.status === 403 || e.status === 404) throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}

module.exports = { normTeam, nameKey, statLine, num, round1, fetchJson };
