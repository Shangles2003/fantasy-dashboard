'use strict';
// Security smoke test: boots the server on a random port with a throwaway data dir and checks
// auth, per-user isolation, admin gating, CSRF/origin blocking, rate limits, and static-file safety.
// Run: npm test
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const PORT = 3900 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fhq-test-'));

const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), FHQ_DATA_DIR: tmp, FHQ_CONFIG: JSON.stringify({ accounts: [{ platform: 'sleeper', username: 'justin' }] }) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));

const cookieOf = (res) => ((res.headers.get('set-cookie') || '').match(/fhq=([a-f0-9]*)/) || [])[1] || '';
async function req(method, p, { cookie, body, headers = {}, form } = {}) {
  const h = { ...headers };
  if (cookie) h.Cookie = `fhq=${cookie}`;
  let payload;
  if (form) {
    h['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(form).toString();
  } else if (body !== undefined) {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + p, { method, headers: h, body: payload, redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* html */
  }
  return { status: res.status, headers: res.headers, text, json, cookie: cookieOf(res) };
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`);
}

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not start:\n${log}`);
}

(async () => {
  await waitUp();

  // --- first visit: no users, must go to register; API refuses
  let r = await req('GET', '/');
  check('unauthenticated / redirects to /register', r.status === 302 && r.headers.get('location') === '/register', `${r.status} ${r.headers.get('location')}`);
  r = await req('GET', '/api/state');
  check('unauthenticated API is 401', r.status === 401, String(r.status));
  check('security headers present', r.headers.get('content-security-policy')?.includes("script-src 'self'") && r.headers.get('x-frame-options') === 'DENY' && r.headers.get('x-content-type-options') === 'nosniff');

  // --- register the first (admin) user; legacy accounts attach to them
  r = await req('POST', '/register', { form: { name: 'joe', password: 'short' } });
  check('rejects short password', r.status === 400 && r.text.includes('8 characters'), String(r.status));
  r = await req('POST', '/register', { form: { name: 'joe', password: 'correct-horse-1' } });
  const joe = r.cookie;
  check('first user registers and gets a session', r.status === 302 && joe.length === 64, `${r.status} cookie=${joe.length}`);
  check('session cookie is HttpOnly + SameSite', /HttpOnly/.test(r.headers.get('set-cookie')) && /SameSite=Lax/.test(r.headers.get('set-cookie')));
  r = await req('GET', '/api/config', { cookie: joe });
  check('first user is admin and inherited legacy accounts', r.json?.user?.admin === true && r.json?.accounts?.[0]?.username === 'justin' && typeof r.json?.admin?.inviteCode === 'string', r.text.slice(0, 200));
  const invite = r.json.admin.inviteCode;

  // --- second user needs a valid invite code
  r = await req('POST', '/register', { form: { name: 'sam', password: 'another-pass-2', invite: 'NOPE-0000' } });
  check('registration with bad invite is refused', r.status === 403, String(r.status));
  r = await req('POST', '/register', { form: { name: 'joe', password: 'another-pass-2', invite } });
  check('duplicate username refused', r.status === 400 && /taken/.test(r.text), String(r.status));
  r = await req('POST', '/register', { form: { name: 'sam', password: 'another-pass-2', invite } });
  const sam = r.cookie;
  check('second user registers with invite', r.status === 302 && sam.length === 64, String(r.status));

  // --- isolation
  await new Promise((s) => setTimeout(s, 4000)); // let the startup/register refresh finish
  const sJoe = (await req('GET', '/api/state', { cookie: joe })).json;
  const sSam = (await req('GET', '/api/state', { cookie: sam })).json;
  check("joe sees his own leagues", sJoe.user.name === 'joe' && sJoe.leagues.length > 0, `leagues=${sJoe.leagues.length}`);
  check("sam sees none of joe's leagues", sSam.user.name === 'sam' && sSam.leagues.length === 0 && sSam.players.length === 0, `leagues=${sSam.leagues.length}`);
  r = await req('GET', '/api/config', { cookie: sam });
  check("sam's config has no accounts and no admin block", r.json.accounts.length === 0 && r.json.admin === undefined && r.json.user.admin === false);
  r = await req('POST', '/api/admin/invite', { cookie: sam });
  check('non-admin cannot regenerate invite', r.status === 403, String(r.status));
  r = await req('DELETE', `/api/admin/users/${'0'.repeat(16)}`, { cookie: sam });
  check('non-admin cannot delete users', r.status === 403, String(r.status));

  // --- secrets never come back
  r = await req('PUT', '/api/config', { cookie: sam, body: { accounts: [{ platform: 'cbs', leagueName: 'x', accessToken: 'SUPERSECRET' }] } });
  check('save accounts ok', r.status === 200 && r.json.accounts[0].accessToken === '********', r.text.slice(0, 120));
  r = await req('GET', '/api/config', { cookie: sam });
  check('secret is masked on read', !r.text.includes('SUPERSECRET'));
  r = await req('PUT', '/api/config', { cookie: sam, body: { accounts: [{ ...r.json.accounts[0] }] } });
  const stored = JSON.parse(fs.readFileSync(path.join(tmp, 'users.json'), 'utf8')).users.find((u) => u.name === 'sam');
  check('re-saving the mask keeps the real secret', stored.accounts[0].accessToken === 'SUPERSECRET');
  r = await req('PUT', '/api/config', { cookie: sam, body: { accounts: [{ platform: 'evil', foo: 'bar' }] } });
  check('unknown platform rejected', r.status === 400, String(r.status));
  r = await req('PUT', '/api/config', { cookie: sam, body: { accounts: [], refresh: { live: 1, idle: 1 } } });
  const cfg = (await req('GET', '/api/config', { cookie: joe })).json;
  check('non-admin cannot change refresh cadence', cfg.refresh.live === 30 && cfg.refresh.idle === 300, JSON.stringify(cfg.refresh));

  // --- passwords hashed at rest, tokens hashed at rest
  const dbRaw = fs.readFileSync(path.join(tmp, 'users.json'), 'utf8');
  check('no plaintext passwords on disk', !dbRaw.includes('correct-horse-1') && !dbRaw.includes('another-pass-2'));
  check('session tokens not stored in plaintext', !dbRaw.includes(joe) && !dbRaw.includes(sam));

  // --- cross-site request blocked
  r = await req('PUT', '/api/config', { cookie: sam, body: { accounts: [] }, headers: { Origin: 'https://evil.example' } });
  check('cross-origin mutation blocked', r.status === 403, String(r.status));
  r = await req('POST', '/api/refresh', { cookie: sam, headers: { Origin: BASE.replace('127.0.0.1', '127.0.0.1') } });
  check('same-origin mutation allowed', r.status === 202, String(r.status));

  // --- static file safety
  r = await req('GET', '/..%2fserver.js', { cookie: sam });
  const r2 = await req('GET', '/%2e%2e/server.js', { cookie: sam });
  const r3 = await req('GET', '/../package.json', { cookie: sam });
  check('path traversal refused', r.status === 404 && r2.status === 404 && !r3.text.includes('"scripts"'), `${r.status} ${r2.status} ${r3.status}`);

  // --- password change revokes other sessions
  const samAgain = (await req('POST', '/login', { form: { name: 'sam', password: 'another-pass-2' } })).cookie;
  r = await req('POST', '/api/password', { cookie: sam, body: { current: 'wrong', next: 'new-pass-word-3' } });
  check('password change needs current password', r.status === 403, String(r.status));
  r = await req('POST', '/api/password', { cookie: sam, body: { current: 'another-pass-2', next: 'new-pass-word-3' } });
  const samNew = r.cookie;
  check('password change ok and issues a fresh session', r.status === 200 && samNew.length === 64, String(r.status));
  r = await req('GET', '/api/state', { cookie: samAgain });
  check('other sessions revoked after password change', r.status === 401, String(r.status));
  r = await req('POST', '/login', { form: { name: 'sam', password: 'another-pass-2' } });
  check('old password no longer works', r.status === 401, String(r.status));

  // --- logout
  r = await req('GET', '/logout', { cookie: samNew });
  r = await req('GET', '/api/state', { cookie: samNew });
  check('logout invalidates session', r.status === 401, String(r.status));
  r = await req('GET', '/api/state', { cookie: 'a'.repeat(64) });
  check('forged token rejected', r.status === 401, String(r.status));

  // --- rate limit on login
  let last = 0;
  for (let i = 0; i < 22; i++) last = (await req('POST', '/login', { form: { name: 'joe', password: 'bad' } })).status;
  check('login brute force rate-limited', last === 429, String(last));

  // --- admin removes a user
  const samId = (await req('GET', '/api/config', { cookie: joe })).json.admin.users.find((u) => u.name === 'sam').id;
  r = await req('DELETE', `/api/admin/users/${samId}`, { cookie: joe });
  check('admin can remove a member', r.status === 200, String(r.status));
  r = await req('POST', '/login', { form: { name: 'sam', password: 'new-pass-word-3' } });
  check('removed member cannot sign in', r.status === 401 || r.status === 429, String(r.status));

  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  child.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('TEST ERROR', e, '\n--- server log ---\n', log);
  child.kill();
  process.exit(1);
});
