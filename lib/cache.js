'use strict';
const fs = require('fs');
const path = require('path');

// FHQ_DATA_DIR lets a hosted deployment keep config, tokens and caches on a persistent disk
const DATA_DIR = process.env.FHQ_DATA_DIR || path.join(__dirname, '..', 'data');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(name, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(name, obj) {
  ensureDir();
  fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(obj));
}

function ageMs(name) {
  try {
    return Date.now() - fs.statSync(path.join(DATA_DIR, name)).mtimeMs;
  } catch {
    return Infinity;
  }
}

// Fetch-or-cache helper for big, slow-changing payloads (e.g. player databases)
async function cached(name, maxAgeMs, loader) {
  if (ageMs(name) < maxAgeMs) {
    const v = readJson(name);
    if (v) return v;
  }
  const v = await loader();
  writeJson(name, v);
  return v;
}

module.exports = { readJson, writeJson, ageMs, cached, DATA_DIR };
