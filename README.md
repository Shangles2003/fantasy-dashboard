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

## Hosting it so your phone can reach it anywhere

The server has to keep running to keep scores fresh, so host it on a small always-on box instead of your PC. It's set up for [Fly.io](https://fly.io) (roughly $2–4/month for a tiny machine plus a 1 GB disk), but any host that runs a Docker container with a persistent volume works the same way.

Environment variables the server understands:

| Variable | Purpose |
|---|---|
| `FHQ_PASSWORD` | Require a sign-in. **Set this before exposing the app to the internet.** |
| `FHQ_DATA_DIR` | Directory for `config.json`, tokens and caches (mount a persistent disk here) |
| `PORT` | Port to listen on (defaults to `config.json`'s `port`, i.e. 3000) |

One-time setup on Fly:

```bash
# 1. Install flyctl (Windows, in PowerShell):  iwr https://fly.io/install.ps1 -useb | iex
#    then sign up / sign in:
fly auth signup      # or: fly auth login

# 2. From the project folder, create the app (accept the defaults, say NO to Postgres/Redis)
fly launch --no-deploy

# 3. Persistent disk for your settings, then your password
fly volumes create fhq_data --size 1
fly secrets set FHQ_PASSWORD="pick-a-strong-password"

# 4. Deploy
fly deploy
```

Then open `https://<your-app-name>.fly.dev` on your phone, sign in, add your accounts in Settings (they're stored on the disk, not on your PC), and use **Add to Home Screen** for an app-style icon. Redeploy any time you change the code with `fly deploy`.

## API

- `GET /api/state` — everything the dashboard renders
- `POST /api/refresh` — refresh now
- `GET/PUT /api/config` — settings (secrets are masked on read)
