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

Then open <http://localhost:3000>. The first visit asks you to create an account (that account is the admin). Click **Settings** to connect your fantasy accounts.

## Multiple people, each with their own leagues

Every member signs in with their own username and password and connects their own Sleeper / ESPN / Yahoo / CBS accounts. Nobody can see anyone else's leagues or credentials.

- The **first account created is the admin**. In Settings the admin sees an **invite code** and the member list.
- To add someone, give them the invite code and the address; they open `/register`, pick a username and password, enter the code, and connect their leagues in Settings.
- The admin can generate a new invite code at any time (the old one stops working) and remove members.
- Anyone can change their own password in Settings; doing so signs out every other device.

Security notes: passwords are stored as salted scrypt hashes; sessions are random tokens stored hashed on the server, in HttpOnly SameSite cookies (marked Secure over HTTPS); sign-in and registration are rate-limited; state-changing requests must come from the site's own origin; the app sends a strict Content-Security-Policy and related headers; platform secrets (cookies, tokens) are never returned to the browser after saving; the container runs as an unprivileged user. `npm test` runs a smoke test that exercises all of this (isolation between users, admin gating, CSRF, rate limits, traversal, revocation).

Upgrading a single-user install: your existing accounts are moved to the first user automatically. On a hosted copy that used `FHQ_PASSWORD`, that becomes user `admin` with the same password.

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
| `FHQ_PASSWORD` | Only used once, to migrate a pre-multi-user install: becomes the password of user `admin`. New installs create the admin account in the browser instead. |
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

### Free option A: an always-free cloud VM (recommended)

Google Cloud gives one **e2-micro** VM free forever (regions `us-west1`, `us-central1`, `us-east1`); Oracle Cloud's *Always Free* tier is similar. Both ask for a card to verify identity but don't charge for this. The VM runs the app 24/7 with its own disk, so nothing sleeps and settings persist.

1. Push this project to a GitHub repo (nothing secret is in it; `config.json` and `data/` are git-ignored).
2. Get a free hostname at <https://www.duckdns.org> (e.g. `myleagues.duckdns.org`).
3. Create the VM (Google: Compute Engine → Create instance → e2-micro, Debian, allow HTTP + HTTPS traffic). Note its external IP and set it as the DuckDNS IP.
4. Open the VM's browser SSH and run:

```bash
sudo apt-get install -y git
git clone https://github.com/<you>/fantasy-dashboard.git
cd fantasy-dashboard/deploy
DOMAIN=myleagues.duckdns.org FHQ_PASSWORD='choose-a-password' ./setup-vm.sh
```

That installs Docker and starts the app behind Caddy, which fetches a free HTTPS certificate. Open `https://myleagues.duckdns.org` on your phone, sign in, add accounts in Settings. To update later: `git pull && sudo docker compose up -d --build` in the `deploy` folder.

### Free option B: Render (quickest, slightly hacky)

Render's free web service sleeps after 15 minutes without traffic and has no persistent disk.

1. Push the project to GitHub, then on <https://render.com> choose **New → Blueprint** and pick the repo (`render.yaml` sets everything up on the free plan).
2. In the service's Environment tab set `FHQ_PASSWORD`, and set `FHQ_CONFIG` to your whole config as one line of JSON, e.g. `{"accounts":[{"platform":"sleeper","username":"you"},{"platform":"cbs","leagueName":"torfl","accessToken":"..."}]}` (copy it from your local `config.json`).
3. Keep it awake: at <https://cron-job.org> (free) create a job that requests `https://<your-service>.onrender.com/healthz` every 5 minutes.

Downsides: a cold start takes ~30 s if the pinger misses, and Yahoo tokens / the CBS stale-score memory reset whenever Render restarts the service.

## API

- `GET /api/state` — everything the dashboard renders
- `POST /api/refresh` — refresh now
- `GET/PUT /api/config` — settings (secrets are masked on read)
