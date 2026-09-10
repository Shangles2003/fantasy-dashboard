'use strict';
// Multi-user store: users (with scrypt-hashed passwords and their own platform accounts),
// login sessions, and the invite code new members need. Persisted as one JSON file in the data dir.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readJson, DATA_DIR } = require('./cache');

const FILE = 'users.json';
const SESSION_DAYS = 180;

let db = null;

function load() {
  if (db) return db;
  db = readJson(FILE, null) || { inviteCode: null, users: [], sessions: {} };
  if (!db.inviteCode) db.inviteCode = newInviteCode();
  if (!db.sessions) db.sessions = {};
  return db;
}

function save() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = path.join(DATA_DIR, `${FILE}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, path.join(DATA_DIR, FILE));
}

function newInviteCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase().replace(/(.{4})(.{4})/, '$1-$2');
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function normName(name) {
  return String(name || '').trim().toLowerCase();
}

function validName(name) {
  return /^[a-z0-9_.-]{2,32}$/i.test(String(name || '').trim());
}

// ----- users -----
function listUsers() {
  return load().users;
}

function findUser(id) {
  return load().users.find((u) => u.id === id) || null;
}

function findByName(name) {
  const n = normName(name);
  return load().users.find((u) => u.nameLower === n) || null;
}

function createUser({ name, password, admin = false, accounts = [] }) {
  const d = load();
  if (!validName(name)) throw new Error('Username must be 2-32 letters, numbers, dots, dashes or underscores');
  if (String(password || '').length < 8) throw new Error('Password must be at least 8 characters');
  if (String(password || '').length > 200) throw new Error('Password is too long');
  if (findByName(name)) throw new Error('That username is taken');
  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: crypto.randomBytes(8).toString('hex'),
    name: String(name).trim(),
    nameLower: normName(name),
    salt,
    hash: hashPassword(password, salt),
    admin: !!admin || d.users.length === 0, // first user is the admin
    accounts,
    createdAt: new Date().toISOString(),
  };
  d.users.push(user);
  save();
  return user;
}

function checkPassword(user, password) {
  return !!user && safeEqual(hashPassword(password, user.salt), user.hash);
}

function setPassword(user, password) {
  if (String(password || '').length < 8) throw new Error('Password must be at least 8 characters');
  if (String(password || '').length > 200) throw new Error('Password is too long');
  user.salt = crypto.randomBytes(16).toString('hex');
  user.hash = hashPassword(password, user.salt);
  save();
}

// Sign the user out everywhere (used after a password change)
function destroyAllSessions(userId) {
  const d = load();
  for (const [t, s] of Object.entries(d.sessions)) if (s.userId === userId) delete d.sessions[t];
  save();
}

function updateAccounts(user, accounts) {
  user.accounts = accounts;
  save();
}

function setHidden(user, leagueKey, hidden) {
  const set = new Set(user.hiddenLeagues || []);
  if (hidden) set.add(leagueKey);
  else set.delete(leagueKey);
  user.hiddenLeagues = [...set];
  save();
  return user.hiddenLeagues;
}

function deleteUser(id) {
  const d = load();
  const i = d.users.findIndex((u) => u.id === id);
  if (i < 0) return false;
  d.users.splice(i, 1);
  for (const [tok, s] of Object.entries(d.sessions)) if (s.userId === id) delete d.sessions[tok];
  save();
  return true;
}

// ----- invite code -----
function inviteCode() {
  return load().inviteCode;
}
function checkInvite(code) {
  return safeEqual(String(code || '').trim().toUpperCase(), load().inviteCode);
}
function regenerateInvite() {
  const d = load();
  d.inviteCode = newInviteCode();
  save();
  return d.inviteCode;
}

// ----- sessions -----
function tokenKey(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function createSession(user) {
  const d = load();
  const token = crypto.randomBytes(32).toString('hex');
  d.sessions[tokenKey(token)] = { userId: user.id, expires: Date.now() + SESSION_DAYS * 86400 * 1000 };
  // prune expired
  for (const [t, s] of Object.entries(d.sessions)) if (s.expires < Date.now()) delete d.sessions[t];
  save();
  return token;
}

function userForSession(token) {
  if (!token) return null;
  const s = load().sessions[tokenKey(token)];
  if (!s || s.expires < Date.now()) return null;
  return findUser(s.userId);
}

function destroySession(token) {
  const d = load();
  const k = tokenKey(token);
  if (d.sessions[k]) {
    delete d.sessions[k];
    save();
  }
}

// Public view of a user (never the hash)
function publicUser(u) {
  return { id: u.id, name: u.name, admin: !!u.admin, accountCount: (u.accounts || []).length, createdAt: u.createdAt };
}

module.exports = {
  SESSION_DAYS,
  listUsers,
  findUser,
  findByName,
  createUser,
  checkPassword,
  setPassword,
  updateAccounts,
  setHidden,
  destroyAllSessions,
  deleteUser,
  inviteCode,
  checkInvite,
  regenerateInvite,
  createSession,
  userForSession,
  destroySession,
  publicUser,
  validName,
};
