/* Fantasy HQ frontend: polls /api/state and renders everything. No framework. */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtPts = (n) => (n == null ? '—' : Number(n).toFixed(2).replace(/\.?0+$/, '') || '0');
  const PLATFORM_NAME = { sleeper: 'Sleeper', espn: 'ESPN', yahoo: 'Yahoo', cbs: 'CBS' };

  let state = null;
  let config = null;
  let filters = { state: 'all', startersOnly: false, q: '' };
  let view = 'mine'; // mine | against | matchups
  try { view = localStorage.getItem('fhq-view') || 'mine'; } catch { /* ignore */ }
  let openLeague = null;

  // ---------- helpers ----------
  function kickoff(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (sameDay) return `Today ${time}`;
    return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  }

  function gameLabel(g) {
    if (!g || g.state === 'none') return '<span class="gstate post">No game</span>';
    if (g.state === 'in') {
      const ball = g.hasBall ? ' <span class="ball" title="Has the ball">🏈</span>' : '';
      return `<span class="gstate in">● ${esc(g.opponent)} · Q${g.period} ${esc(g.clock)}${ball}</span><div class="pmeta">${esc(g.score)}</div>`;
    }
    if (g.state === 'post') return `<span class="gstate post">Final · ${esc(g.opponent)}</span><div class="pmeta">${esc(g.score)}</div>`;
    return `<span class="gstate pre">${esc(g.opponent)} · ${esc(kickoff(g.start))}</span>`;
  }

  function ago(iso) {
    if (!iso) return 'never';
    const s = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
  }

  // ---------- render ----------
  function render() {
    if (!state) return;
    renderHeader();
    renderBanner();
    renderGames();
    renderCards();
    renderView();
    if (openLeague) renderDrawer(openLeague);
  }

  function renderView() {
    $$('#view-switch button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    const isMatchups = view === 'matchups';
    $('#players-wrap').hidden = isMatchups;
    $('#matchups-view').hidden = !isMatchups;
    $('#player-filters').hidden = isMatchups;
    if (isMatchups) renderMatchups();
    else renderPlayers();
  }

  function renderHeader() {
    const n = state.nfl || {};
    const typ = { 1: 'Preseason', 2: '', 3: 'Playoffs' }[n.seasonType] || '';
    $('#week-label').textContent = n.week ? `${n.season} · ${typ ? typ + ' ' : ''}Week ${n.week}${n.anyLive ? ' · games in progress' : ''}` : 'NFL week unknown';
    $('#updated').textContent = state.refreshing ? 'refreshing…' : `updated ${ago(state.updatedAt)}`;
    if (state.user) $('#user-name').textContent = state.user.name;
  }

  function renderBanner() {
    const b = $('#banner');
    const problems = [];
    for (const a of state.accounts || []) if (a.error) problems.push(`${PLATFORM_NAME[a.platform] || a.platform} (${a.label}): ${a.error}`);
    for (const w of state.warnings || []) problems.push(w);
    if (!config) {
      b.hidden = true;
      return;
    }
    if (!(config.accounts || []).length) {
      b.className = 'banner info';
      b.innerHTML = 'No fantasy accounts connected yet. <a href="#" id="banner-settings">Open Settings</a> to add Sleeper, ESPN or Yahoo.';
      b.hidden = false;
      $('#banner-settings').onclick = (e) => { e.preventDefault(); openSettings(); };
      return;
    }
    if (!problems.length) {
      b.hidden = true;
      return;
    }
    b.className = 'banner';
    b.innerHTML = `<b>Some sources had problems</b><ul>${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`;
    b.hidden = false;
  }

  function renderGames() {
    const el = $('#games');
    const games = (state.nfl && state.nfl.games) || [];
    if (!games.length) {
      el.innerHTML = '<div class="muted">No NFL games on the scoreboard.</div>';
      return;
    }
    el.innerHTML = games
      .map((g) => {
        const status = g.state === 'in' ? `● Q${g.period} ${esc(g.clock)}` : g.state === 'post' ? 'Final' : kickoff(g.start);
        const ball = (t) => (g.state === 'in' && g.possession === t ? ' <span class="ball">🏈</span>' : '');
        const lead = g.state !== 'pre' ? (g.away.score > g.home.score ? 'away' : g.home.score > g.away.score ? 'home' : '') : '';
        return `<div class="game ${g.state}" title="${esc(g.downDistance || '')}">
          <div class="teams"><span>${lead === 'away' ? '<b>' : ''}${esc(g.away.team)} ${g.state !== 'pre' ? g.away.score : ''}${lead === 'away' ? '</b>' : ''}${ball(g.away.team)}</span>
          <span>${lead === 'home' ? '<b>' : ''}${esc(g.home.team)} ${g.state !== 'pre' ? g.home.score : ''}${lead === 'home' ? '</b>' : ''}${ball(g.home.team)}</span></div>
          <div class="status">${status}${g.broadcast && g.state !== 'post' ? ` <span class="muted">· ${esc(g.broadcast)}</span>` : ''}</div>
        </div>`;
      })
      .join('');
  }

  const pct = (p) => (p == null ? null : Math.round(p * 100));
  function winLabel(team) {
    const w = pct(team && team.winProb);
    if (w == null) return '';
    return `<span class="win ${w >= 60 ? 'good' : w <= 40 ? 'bad' : ''}">${w}% win</span>`;
  }
  function projLabel(team) {
    if (!team) return '';
    const v = team.liveProjected != null ? team.liveProjected : team.projected;
    return v == null ? '' : `proj ${fmtPts(v)}`;
  }
  function winBar(me, opp) {
    const w = pct(me && me.winProb);
    if (w == null || !opp) return '';
    return `<div class="winbar" title="${w}% chance to win"><span style="width:${w}%"></span><span class="opp" style="width:${100 - w}%"></span></div>`;
  }
  async function hideLeague(key, hidden) {
    const r = await fetch('/api/hidden', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ league: key, hidden }) });
    if (r.ok) await load();
  }

  function rosterProgress(team) {
    const st = (team && team.roster || []).filter((p) => p.starter);
    const c = { in: 0, pre: 0, post: 0 };
    for (const p of st) c[p.game && p.game.state in c ? p.game.state : 'post']++;
    return c;
  }

  function renderCards() {
    const leagues = state.leagues || [];
    const wrap = $('#cards');
    if (!leagues.length) {
      wrap.innerHTML = '<div class="muted">No leagues loaded.</div>';
      $('#matchup-summary').textContent = '';
      return;
    }
    let wins = 0;
    let losses = 0;
    wrap.innerHTML = leagues
      .map((lg) => {
        if (lg.error) {
          return `<div class="card error"><button class="btn hide" data-hide="${esc(lg.key)}" title="Hide this league from the dashboard">hide</button><div class="card-head"><span class="badge ${lg.platform}">${esc(PLATFORM_NAME[lg.platform])}</span><span class="name">${esc(lg.name)}</span></div><div class="lose">${esc(lg.error)}</div></div>`;
        }
        const me = lg.myTeam;
        const opp = lg.opponent;
        const lead = opp ? (me.points > opp.points ? 'me' : opp.points > me.points ? 'opp' : '') : '';
        if (lead === 'me') wins++;
        if (lead === 'opp') losses++;
        const prog = rosterProgress(me);
        const oprog = opp ? rosterProgress(opp) : null;
        return `<div class="card" data-league="${esc(lg.key)}">
          <button class="btn hide" data-hide="${esc(lg.key)}" title="Hide this league from the dashboard">hide</button>
          <div class="card-head">
            <span><span class="badge ${lg.platform}">${esc(PLATFORM_NAME[lg.platform])}</span> <span class="name">${esc(lg.name)}</span></span>
            <span class="meta">${esc(lg.scoring || '')} · Wk ${lg.week}</span>
          </div>
          <div class="score">
            <div class="side">
              <span class="tname" title="${esc(me.name)}">${esc(me.name)}</span>
              <span class="rec">${esc(me.record || '')}${me.owner ? ' · you' : ''}</span>
              <span class="pts ${lead === 'me' ? 'leading' : ''}">${fmtPts(me.points)}</span>
              <span class="proj">${projLabel(me)} ${winLabel(me)}</span>
            </div>
            <div class="vs">vs</div>
            ${opp ? `<div class="side opp">
              <span class="tname" title="${esc(opp.name)}">${esc(opp.name)}</span>
              <span class="rec">${esc(opp.record || '')}${opp.owner ? ' · ' + esc(opp.owner) : ''}</span>
              <span class="pts ${lead === 'opp' ? 'leading' : ''}">${fmtPts(opp.points)}</span>
              <span class="proj">${winLabel(opp)} ${projLabel(opp)}</span>
            </div>` : '<div class="side opp"><span class="muted">No matchup this week</span></div>'}
          </div>
          ${winBar(me, opp)}
          <div class="card-foot">
            <span>
              ${prog.in ? `<span class="pill live">● ${prog.in} live</span> ` : ''}
              <span class="pill pre">${prog.pre} to play</span>
              <span class="pill post">${prog.post} done</span>
            </span>
            ${oprog ? `<span class="muted">opp: ${oprog.in} live · ${oprog.pre} left</span>` : ''}
          </div>
        </div>`;
      })
      .join('');
    const hiddenN = (state.hidden || []).length;
    $('#matchup-summary').textContent = leagues.length ? `${leagues.length} leagues · leading ${wins}, trailing ${losses}${hiddenN ? ` · ${hiddenN} hidden` : ''}` : hiddenN ? `${hiddenN} hidden` : '';
    $$('.card[data-league]').forEach((c) => (c.onclick = () => openDrawer(c.dataset.league)));
    $$('.card [data-hide]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); hideLeague(b.dataset.hide, true); }));
  }

  function chip(e, against) {
    const cls = ['chip', e.starter ? '' : 'bench', against ? 'against' : ''].filter(Boolean).join(' ');
    const title = `${PLATFORM_NAME[e.platform]} · ${e.leagueName}${against ? ` · on ${e.opponent}, playing your ${e.myTeam}` : e.opponent ? ` · vs ${e.opponent}` : ''}${e.projected != null ? ` · proj ${fmtPts(e.projected)}` : ''}`;
    const who = against && e.opponent ? ` <span class="vs">(${esc(e.opponent)})</span>` : '';
    return `<span class="${cls}" title="${esc(title)}"><span class="dot ${e.platform}"></span>${esc(e.leagueName)}${who} <span class="slot">${esc(e.slot)}</span> <span class="cpts">${fmtPts(e.points)}</span></span>`;
  }

  function renderPlayers() {
    const tbody = $('#players tbody');
    const against = view === 'against';
    $('#players-col').textContent = against ? 'Opponent · league · points' : 'Leagues & points';
    const q = filters.q.trim().toLowerCase();
    const rows = (state.players || []).filter((p) => {
      const entries = against ? p.against : p.mine;
      if (!entries.length) return false;
      if (filters.startersOnly && !entries.some((e) => e.starter)) return false;
      const st = p.game ? p.game.state : 'none';
      if (filters.state !== 'all' && st !== filters.state) return false;
      if (q) {
        const hay = `${p.name} ${p.team} ${p.pos} ${entries.map((e) => `${e.leagueName} ${e.opponent || ''}`).join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    $('#players-empty').hidden = rows.length > 0;
    $('#players-empty').textContent = against ? 'No opponent players match. (Opponents\' starters only.)' : 'No players match.';
    tbody.innerHTML = rows
      .map((p) => {
        const all = against ? p.against : p.mine;
        const entries = filters.startersOnly ? all.filter((e) => e.starter) : all;
        return `<tr class="${p.game ? p.game.state : ''}">
          <td><span class="pname">${esc(p.name)}</span>${p.injury ? `<span class="inj">${esc(p.injury)}</span>` : ''}<div class="pmeta">${esc(p.pos)} · ${esc(p.team || 'FA')}</div></td>
          <td>${gameLabel(p.game)}</td>
          <td><div class="statline">${esc(p.statLine || (p.game && p.game.state === 'pre' ? '' : '—'))}</div></td>
          <td><div class="chips">${entries.map((e) => chip(e, against)).join('')}</div></td>
        </tr>`;
      })
      .join('');
  }

  // ---------- matchups view ----------
  function muCell(p, theirs) {
    if (!p) return `<td class="who ${theirs ? 'theirs' : ''}"><span class="muted">—</span></td>`;
    return `<td class="who ${theirs ? 'theirs' : ''}">
      <div><span class="pname">${esc(p.name)}</span>${p.injury ? `<span class="inj">${esc(p.injury)}</span>` : ''} <span class="pmeta">${esc(p.pos)} ${esc(p.team)}</span></div>
      <div class="sub">${gameLabel(p.game)}</div>${p.statLine ? `<div class="sub muted">${esc(p.statLine)}</div>` : ''}
    </td>`;
  }
  function muPts(p, theirs, lead) {
    if (!p) return `<td class="pts ${theirs ? 'theirs' : 'mine'}"></td>`;
    return `<td class="pts ${theirs ? 'theirs' : 'mine'} ${lead ? 'lead' : ''}">${fmtPts(p.points)}${p.projected != null ? `<div class="sub muted">${fmtPts(p.projected)}</div>` : ''}</td>`;
  }
  function renderMatchups() {
    const el = $('#matchups-view');
    const leagues = (state.leagues || []).filter((l) => !l.error);
    if (!leagues.length) {
      el.innerHTML = '<div class="muted">No leagues loaded.</div>';
      return;
    }
    el.innerHTML = leagues
      .map((lg) => {
        const me = lg.myTeam;
        const opp = lg.opponent;
        const myS = me.roster.filter((p) => p.starter);
        const opS = opp ? opp.roster.filter((p) => p.starter) : [];
        const n = Math.max(myS.length, opS.length);
        const lead = opp ? (me.points > opp.points ? 'me' : opp.points > me.points ? 'opp' : '') : '';
        const rows = [];
        for (let i = 0; i < n; i++) {
          const a = myS[i];
          const b = opS[i];
          const slot = (a && a.slot) || (b && b.slot) || '';
          const done = a && b && a.game.state === 'post' && b.game.state === 'post';
          const aLead = a && b && a.points > b.points;
          const bLead = a && b && b.points > a.points;
          rows.push(`<tr class="${done ? 'done' : ''}">${muPts(a, false, aLead)}${muCell(a, false)}<td class="slot">${esc(slot)}</td>${muCell(b, true)}${muPts(b, true, bLead)}</tr>`);
        }
        const mp = rosterProgress(me);
        const op = opp ? rosterProgress(opp) : null;
        return `<div class="mu">
          <div class="mu-head">
            <span><span class="badge ${lg.platform}">${esc(PLATFORM_NAME[lg.platform])}</span> <span class="name">${esc(lg.name)}</span></span>
            <span class="pmeta">${esc(lg.scoring || '')} · Wk ${lg.week} · <a href="#" data-open="${esc(lg.key)}">full rosters</a></span>
          </div>
          <div class="mu-score">
            <div><div class="tname">${esc(me.name)} <span class="pmeta">${esc(me.record || '')}</span></div><div class="pts ${lead === 'me' ? 'leading' : ''}">${fmtPts(me.points)}</div><div class="proj">${projLabel(me)} ${winLabel(me)}</div></div>
            <div class="muted">vs</div>
            ${opp ? `<div class="right"><div class="tname">${esc(opp.name)} <span class="pmeta">${esc(opp.record || '')}</span></div><div class="pts ${lead === 'opp' ? 'leading' : ''}">${fmtPts(opp.points)}</div><div class="proj">${winLabel(opp)} ${projLabel(opp)}</div></div>` : '<div class="right muted">No matchup this week</div>'}
          </div>
          ${winBar(me, opp)}
          ${opp ? `<table><tbody>${rows.join('')}</tbody></table>` : ''}
          <div class="mu-foot">
            <span>${mp.in ? `<span class="pill live">● ${mp.in} live</span> ` : ''}<span class="pill pre">${mp.pre} to play</span> <span class="pill post">${mp.post} done</span></span>
            ${op ? `<span>${op.in ? `<span class="pill live">● ${op.in} live</span> ` : ''}<span class="pill pre">${op.pre} to play</span> <span class="pill post">${op.post} done</span></span>` : ''}
          </div>
        </div>`;
      })
      .join('');
    $$('#matchups-view [data-open]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); openDrawer(a.dataset.open); }));
  }

  // ---------- drawer ----------
  function openDrawer(key) {
    openLeague = key;
    $('#drawer').hidden = false;
    $('#drawer-backdrop').hidden = false;
    renderDrawer(key);
  }
  function closeDrawer() {
    openLeague = null;
    $('#drawer').hidden = true;
    $('#drawer-backdrop').hidden = true;
  }
  function rosterTable(team, other) {
    if (!team) return '<div class="muted">No opponent this week.</div>';
    const starters = team.roster.filter((p) => p.starter);
    const bench = team.roster.filter((p) => !p.starter);
    const row = (p) => `<tr class="${p.starter ? '' : 'bench'}">
      <td class="slot">${esc(p.slot)}</td>
      <td><div>${esc(p.name)}${p.injury ? `<span class="inj">${esc(p.injury)}</span>` : ''} <span class="pmeta">${esc(p.pos)} ${esc(p.team)}</span></div>
        <div class="sub">${gameLabel(p.game)}</div>${p.statLine ? `<div class="sub muted">${esc(p.statLine)}</div>` : ''}</td>
      <td class="pts">${fmtPts(p.points)}${p.projected != null ? `<div class="sub muted">${fmtPts(p.projected)}</div>` : ''}</td>
    </tr>`;
    const lead = other && team.points > other.points;
    return `<div class="roster">
      <h3><span>${esc(team.name)} <span class="pmeta">${esc(team.record || '')}</span></span><span class="mono ${lead ? 'win' : ''}">${fmtPts(team.points)}</span></h3>
      <table><tbody>${starters.map(row).join('')}${bench.length ? `<tr class="sep"><td colspan="3">Bench</td></tr>${bench.map(row).join('')}` : ''}</tbody></table>
    </div>`;
  }
  function renderDrawer(key) {
    const lg = (state.leagues || []).find((l) => l.key === key);
    if (!lg) return closeDrawer();
    $('#drawer-title').innerHTML = `<h2><span class="badge ${lg.platform}">${esc(PLATFORM_NAME[lg.platform])}</span> ${esc(lg.name)}</h2><div class="pmeta">${esc(lg.scoring || '')} · ${lg.teamCount || '?'} teams · Week ${lg.week} · <a href="${esc(lg.url)}" target="_blank" rel="noopener">open on ${esc(PLATFORM_NAME[lg.platform])}</a></div>`;
    const cell = (t) => `<td>${esc(t.name)}${t.isMe ? ' <span class="pmeta">(you)</span>' : ''}<div class="pmeta">${projLabel(t)}${t.winProb != null ? ` · ${winLabel(t)}` : ''}</div></td><td class="pts">${fmtPts(t.points)}</td>`;
    const sb = (lg.scoreboard || []).length
      ? `<div class="scoreboard"><h3>League scoreboard</h3><table><tbody>${lg.scoreboard
          .map((m) => `<tr class="${m.teams.some((t) => t.isMe) ? 'me' : ''}">${m.teams.map((t, i) => `${i ? '<td class="muted">vs</td>' : ''}${cell(t)}`).join('')}</tr>`)
          .join('')}</tbody></table></div>`
      : '';
    $('#drawer-body').innerHTML = `<div class="roster-grid">${rosterTable(lg.myTeam, lg.opponent)}${rosterTable(lg.opponent, lg.myTeam)}</div>${sb}`;
  }

  // ---------- settings ----------
  const FIELDS = {
    sleeper: [{ k: 'username', label: 'Sleeper username' }],
    espn: [
      { k: 'label', label: 'Label (optional)' },
      { k: 'swid', label: 'SWID cookie (with braces) - leave blank for public leagues' },
      { k: 'espn_s2', label: 'espn_s2 cookie - leave blank for public leagues', secret: true },
      { k: 'leagueIds', label: 'League IDs (comma separated; required without cookies)' },
      { k: 'teamName', label: 'Your team name (public leagues, or if your login does not own the team)' },
    ],
    yahoo: [
      { k: 'label', label: 'Label (optional)' },
      { k: 'clientId', label: 'Client ID' },
      { k: 'clientSecret', label: 'Client Secret', secret: true },
    ],
    cbs: [
      { k: 'label', label: 'Label (optional)' },
      { k: 'leagueName', label: 'League subdomain (the part before .football.cbssports.com)' },
      { k: 'accessToken', label: 'Access token', secret: true },
    ],
  };
  let draft = null;

  async function openSettings() {
    config = await (await fetch('/api/config')).json();
    draft = JSON.parse(JSON.stringify(config));
    $('#refresh-live').value = draft.refresh.live;
    $('#refresh-idle').value = draft.refresh.idle;
    $('#settings-status').textContent = '';
    $('#pw-status').textContent = '';
    $('#pw-current').value = '';
    $('#pw-next').value = '';
    renderAccounts();
    renderAdmin();
    renderHidden();
    $('#settings').hidden = false;
  }
  function renderHidden() {
    const list = config.hidden || [];
    $('#hidden-empty').hidden = list.length > 0;
    $('#hidden-list').innerHTML = list
      .map((l) => `<div class="add-row"><span class="badge ${l.platform}">${esc(PLATFORM_NAME[l.platform] || l.platform)}</span> <span>${esc(l.name)}</span> <button class="btn small" data-unhide="${esc(l.key)}">Show again</button></div>`)
      .join('');
    $$('#hidden-list [data-unhide]').forEach((b) => (b.onclick = async () => {
      await hideLeague(b.dataset.unhide, false);
      config.hidden = (config.hidden || []).filter((l) => l.key !== b.dataset.unhide);
      renderHidden();
    }));
  }
  function renderAdmin() {
    const isAdmin = !!(config.user && config.user.admin && config.admin);
    $('#admin-section').hidden = !isAdmin;
    if (!isAdmin) return;
    $('#invite-code').textContent = config.admin.inviteCode;
    $('#register-url').textContent = `${location.origin}/register`;
    $('#users-list').innerHTML = `<table class="players" style="margin-top:8px"><thead><tr><th>User</th><th>Leagues connected</th><th>Joined</th><th></th></tr></thead><tbody>${config.admin.users
      .map((u) => `<tr><td>${esc(u.name)}${u.admin ? ' <span class="pmeta">admin</span>' : ''}</td><td>${u.accountCount} account${u.accountCount === 1 ? '' : 's'}</td><td class="pmeta">${new Date(u.createdAt).toLocaleDateString()}</td><td>${u.name === config.user.name ? '' : `<button class="btn small danger" data-deluser="${u.id}" data-name="${esc(u.name)}">Remove</button>`}</td></tr>`)
      .join('')}</tbody></table>`;
    $('#invite-regen').onclick = async () => {
      const r = await (await fetch('/api/admin/invite', { method: 'POST' })).json();
      if (r.inviteCode) { config.admin.inviteCode = r.inviteCode; $('#invite-code').textContent = r.inviteCode; }
    };
    $$('#users-list [data-deluser]').forEach((b) => (b.onclick = async () => {
      if (!confirm(`Remove ${b.dataset.name}? Their connected leagues are deleted from this server.`)) return;
      const r = await fetch(`/api/admin/users/${b.dataset.deluser}`, { method: 'DELETE' });
      if (r.ok) { config.admin.users = config.admin.users.filter((u) => u.id !== b.dataset.deluser); renderAdmin(); }
    }));
  }
  function closeSettings() {
    $('#settings').hidden = true;
  }
  function renderAccounts() {
    const el = $('#accounts');
    if (!draft.accounts.length) {
      el.innerHTML = '<p class="muted">No accounts yet. Add one below.</p>';
      return;
    }
    el.innerHTML = draft.accounts
      .map((a, i) => {
        const fields = FIELDS[a.platform] || [];
        const inputs = fields
          .map((f) => {
            const v = Array.isArray(a[f.k]) ? a[f.k].join(', ') : a[f.k] || '';
            return `<label>${esc(f.label)}<input type="${f.secret ? 'password' : 'text'}" data-i="${i}" data-k="${f.k}" value="${esc(v)}" autocomplete="off" /></label>`;
          })
          .join('');
        let extra = '';
        if (a.platform === 'yahoo') {
          extra = `<div class="yahoo-connect">
            <span class="${a.connected ? 'status-ok' : 'status-bad'}">${a.connected ? '● Connected' : '○ Not connected'}</span>
            <button class="btn small" data-yauth="${i}">Connect Yahoo</button>
            <input type="text" placeholder="paste code from Yahoo" data-ycode="${i}" style="min-width:200px" />
            <button class="btn small" data-ysubmit="${i}">Submit code</button>
            ${a.connected ? `<button class="btn small danger" data-ydisc="${i}">Disconnect</button>` : ''}
          </div><p class="muted" style="margin:6px 0 0;font-size:12px">Save first if you just entered the Client ID/Secret. Set the app's redirect to "Installed Application" (out-of-band).</p>`;
        }
        return `<div class="acct">
          <div class="acct-head"><span class="badge ${a.platform}">${esc(PLATFORM_NAME[a.platform] || a.platform)}</span><button class="btn small danger" data-remove="${i}">Remove</button></div>
          <div class="grid2">${inputs}</div>${extra}
        </div>`;
      })
      .join('');
    $$('#accounts input[data-k]').forEach((inp) => (inp.oninput = () => (draft.accounts[+inp.dataset.i][inp.dataset.k] = inp.value)));
    $$('#accounts [data-remove]').forEach((b) => (b.onclick = () => { draft.accounts.splice(+b.dataset.remove, 1); renderAccounts(); }));
    $$('#accounts [data-yauth]').forEach((b) => (b.onclick = async () => {
      const r = await (await fetch(`/api/yahoo/auth-url?index=${b.dataset.yauth}`)).json();
      if (r.error) return setStatus(r.error, true);
      window.open(r.url, '_blank');
    }));
    $$('#accounts [data-ysubmit]').forEach((b) => (b.onclick = async () => {
      const code = $(`#accounts [data-ycode="${b.dataset.ysubmit}"]`).value;
      const r = await (await fetch('/api/yahoo/code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index: +b.dataset.ysubmit, code }) })).json();
      if (r.error) return setStatus(r.error, true);
      setStatus('Yahoo connected.');
      draft.accounts[+b.dataset.ysubmit].connected = true;
      renderAccounts();
    }));
    $$('#accounts [data-ydisc]').forEach((b) => (b.onclick = async () => {
      await fetch('/api/yahoo/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index: +b.dataset.ydisc }) });
      draft.accounts[+b.dataset.ydisc].connected = false;
      renderAccounts();
    }));
  }
  function setStatus(msg, bad) {
    const s = $('#settings-status');
    s.textContent = msg;
    s.className = bad ? 'status-bad' : 'status-ok';
  }
  async function saveSettings() {
    const body = { accounts: draft.accounts };
    if (config.user && config.user.admin) body.refresh = { live: +$('#refresh-live').value, idle: +$('#refresh-idle').value };
    draft.accounts.forEach((a, i) => { if (!a.id) a.id = `${a.platform}-${Date.now()}-${i}`; });
    const r = await fetch('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) return setStatus('Save failed: ' + (await r.text()), true);
    const saved = await r.json();
    config = { ...config, ...saved };
    setStatus('Saved. Refreshing leagues…');
    setTimeout(closeSettings, 600);
    setTimeout(load, 1500);
  }
  async function changePassword() {
    const s = $('#pw-status');
    const r = await fetch('/api/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ current: $('#pw-current').value, next: $('#pw-next').value }) });
    const j = await r.json().catch(() => ({}));
    s.className = r.ok ? 'status-ok' : 'status-bad';
    s.textContent = r.ok ? 'Password changed.' : j.error || 'Failed';
    if (r.ok) { $('#pw-current').value = ''; $('#pw-next').value = ''; }
  }

  // ---------- data loop ----------
  async function load() {
    try {
      const r = await fetch('/api/state');
      if (r.status === 401) { location.href = '/login'; return; }
      state = await r.json();
      if (!config) config = await (await fetch('/api/config')).json();
      render();
    } catch (e) {
      $('#updated').textContent = 'server unreachable';
    }
  }

  // ---------- wire up ----------
  $('#btn-refresh').onclick = async () => { await fetch('/api/refresh', { method: 'POST' }); $('#updated').textContent = 'refreshing…'; setTimeout(load, 2500); };
  $('#btn-settings').onclick = openSettings;
  $('#settings-close').onclick = closeSettings;
  $('#settings-save').onclick = saveSettings;
  $('#pw-save').onclick = changePassword;
  $$('[data-add]').forEach((b) => (b.onclick = () => { draft.accounts.push({ platform: b.dataset.add }); renderAccounts(); }));
  $('#drawer-close').onclick = closeDrawer;
  $('#drawer-backdrop').onclick = closeDrawer;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDrawer(); closeSettings(); } });
  $$('#state-filter button').forEach((b) => (b.onclick = () => { $$('#state-filter button').forEach((x) => x.classList.remove('active')); b.classList.add('active'); filters.state = b.dataset.state; renderPlayers(); }));
  $('#starters-only').onchange = (e) => { filters.startersOnly = e.target.checked; renderPlayers(); };
  $('#search').oninput = (e) => { filters.q = e.target.value; renderPlayers(); };
  $$('#view-switch button').forEach((b) => (b.onclick = () => { view = b.dataset.view; try { localStorage.setItem('fhq-view', view); } catch { /* ignore */ } if (state) renderView(); }));

  // Arriving from the "Fantasy HQ ESPN Connect" browser extension: /?espn#swid=...&espn_s2=...
  // The values live in the URL fragment (never sent to the server); pre-fill a new ESPN account.
  async function handleExtensionHandoff() {
    if (!location.hash.includes('espn_s2=')) return;
    const frag = new URLSearchParams(location.hash.slice(1));
    const swid = frag.get('swid');
    const s2 = frag.get('espn_s2');
    history.replaceState(null, '', '/');
    if (!swid || !s2) return;
    await openSettings();
    const existing = draft.accounts.find((a) => a.platform === 'espn');
    if (existing) {
      existing.swid = swid;
      existing.espn_s2 = s2;
    } else {
      draft.accounts.push({ platform: 'espn', swid, espn_s2: s2 });
    }
    renderAccounts();
    setStatus('ESPN cookies filled in from the extension. Click Save & refresh.');
  }

  load().then(handleExtensionHandoff);
  setInterval(load, 15000);
  setInterval(() => { if (state) $('#updated').textContent = state.refreshing ? 'refreshing…' : `updated ${ago(state.updatedAt)}`; }, 5000);
})();
