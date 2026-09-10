# Fantasy HQ

One dashboard for every fantasy football league you're in, across **Sleeper**, **ESPN**, **Yahoo** and **CBS**. Open it on game day and see, in one place:

- Every matchup you're playing this week, with live scores, projections and how many of your starters are live / done / still to play.
- Every player you roster anywhere, which leagues they're in (and whether they're starting or benched), their live NFL game clock, their stat line, and their points in each league.
- The NFL scoreboard for the week, so you know who's playing when.

No npm dependencies. Just Node 18+.

## Run it

```bash
node server.js
```

Then open <http://localhost:3000>, click **Settings**, and add your accounts. Config is saved to `config.json` (git-ignored) on this machine only.

## Connecting platforms

| Platform | What you need | Notes |
|---|---|---|
| Sleeper | Your username | Public API, no login. All your leagues are found automatically. |
| ESPN | `espn_s2` and `SWID` cookies | Log in at fantasy.espn.com, DevTools → Application → Cookies. Leagues are discovered from your account; if that fails, paste league IDs. |
| Yahoo | A Yahoo developer app (Client ID + Secret) | Create one at <https://developer.yahoo.com/apps/create/> as an *Installed Application* with Fantasy Sports read permission. Save it in Settings, click **Connect Yahoo**, approve, paste the code back. |
| CBS | League subdomain + per-league access token | CBS's legacy v3 API still works. Log in, open your league page, and copy the token from the page source (`var token = "…"`) or from any `api.cbssports.com` request's `access_token` in DevTools → Network. One entry per league. |

## How refresh works

- The backend polls each platform every **30 s while any NFL game is live** (configurable), otherwise every 5 minutes, and once a minute in the 20 minutes before a kickoff.
- The page polls the backend every 15 s, so the browser tab stays current without reloading.
- Live NFL game state (clock, quarter, possession, score) comes from ESPN's public scoreboard and needs no login.

## Layout

```
server.js           HTTP server, refresh loop, cross-league player aggregation, settings API
lib/nfl.js          NFL scoreboard feed (game state per team)
lib/util.js         Shared helpers: team-abbreviation normalization, stat-line formatting, fetch with retries
lib/cache.js        Small disk cache (Sleeper player DB, Yahoo token) in data/
adapters/*.js       One adapter per platform, each returning the same normalized league shape
public/             The dashboard (vanilla HTML/CSS/JS)
```

Every adapter returns leagues in the same shape (`myTeam`, `opponent`, rosters of normalized players with `points`, `projected`, `stats`, `game`), so adding another platform is a matter of writing one more adapter.

## API

- `GET /api/state` — everything the dashboard renders
- `POST /api/refresh` — refresh now
- `GET/PUT /api/config` — settings (secrets are masked on read)
