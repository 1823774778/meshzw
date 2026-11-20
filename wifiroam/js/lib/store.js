// store.js -- JSON file persistence for /etc/wifiroam/*.
// Target: Node 22.23.4, core modules only, zero npm dependencies.
//
// Field shapes follow the original daemon exactly (spec §6.2/§6.3):
//   aliases.json : { ver, map, groups, redirect, isolated, pin }
//   appstats.json: { ver: 1, day, stats, online, ndata }
//   devices.json : { <group id>: { mac, ip, hostname, first_seen,
//                    last_online, last_offline, online, ap, conn } }
//   nft_schema   : plain-text sha256 string (no JSON).
//
// Read semantics (original: try { json(readfile) } catch { first boot }):
// a missing file, unreadable file, or invalid JSON yields the documented
// default -- never a throw. Writes are atomic (write a temp file in the
// same directory, then rename over the target) and return a boolean
// instead of throwing; the original wrote in place with fs.writefile,
// so atomicity is the one deliberate improvement, required by the task.
//
// NOTE: alias_save() in the original also mirrors state.aliases.ver
// into UCI `wifiroam alias_sync.ver`. That UCI write is NOT done here
// (store.js owns files only); the caller syncs UCI after saveAliases().

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const ALIAS_DIR = '/etc/wifiroam';
export const ALIAS_PATH = `${ALIAS_DIR}/aliases.json`;
export const DEVICES_PATH = `${ALIAS_DIR}/devices.json`;
export const APPSTATS_PATH = `${ALIAS_DIR}/appstats.json`;
export const APPCTL_SCHEMA_PATH = `${ALIAS_DIR}/nft_schema`;

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function objectOr(value, fallback) {
  return isObject(value) ? value : fallback;
}

// Generic read: parse JSON, return `fallback` on missing file, bad JSON,
// or a parsed value that fails `accept` (when given). Never throws.
export function readJsonFile(path, fallback, accept) {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof accept === 'function' && !accept(data)) return fallback;
    return data;
  } catch (_e) {
    return fallback;
  }
}

// Generic atomic write: temp file in the same directory + rename.
// Creates the parent directory first. Returns true/false, never throws.
export function writeJsonAtomic(path, value) {
  return writeTextAtomic(path, JSON.stringify(value));
}

// Atomic plain-text write (used for nft_schema and by writeJsonAtomic).
export function writeTextAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, path);
    return true;
  } catch (_e) {
    try { unlinkSync(tmp); } catch (_ignored) { /* best effort cleanup */ }
    return false;
  }
}

// ------------------------------------------------------------ aliases.json
export function defaultAliases() {
  return { ver: 0, map: {}, groups: {}, redirect: {}, isolated: {}, pin: {} };
}

// Original alias_load(): fields default to {} when absent; ver is taken
// from the file (a fresh process starts at ver 0, so "only if greater"
// and "take the file value" coincide here).
export function loadAliases(path = ALIAS_PATH) {
  const data = readJsonFile(path, null, isObject);
  if (!data) return defaultAliases();
  return {
    ver: typeof data.ver === 'number' ? data.ver : 0,
    map: objectOr(data.map, {}),
    groups: objectOr(data.groups, {}),
    redirect: objectOr(data.redirect, {}),
    isolated: objectOr(data.isolated, {}),
    pin: objectOr(data.pin, {}),
  };
}

// Original alias_save() wrote the whole state.aliases object. Returns
// true on success. (UCI alias_sync.ver mirroring is the caller's job.)
export function saveAliases(path, aliases) {
  return writeJsonAtomic(path, aliases ?? defaultAliases());
}

// ------------------------------------------------------------ appstats.json
export function defaultAppStats() {
  return { day: '', stats: {}, online: {}, ndata: {} };
}

// Original appstats_load(): stats/day/online/ndata restored, each
// defaulting to {} (day to "") when absent.
export function loadAppStats(path = APPSTATS_PATH) {
  const data = readJsonFile(path, null, isObject);
  if (!data) return defaultAppStats();
  return {
    day: typeof data.day === 'string' ? data.day : '',
    stats: objectOr(data.stats, {}),
    online: objectOr(data.online, {}),
    ndata: objectOr(data.ndata, {}),
  };
}

// Original appstats_save(): writes { ver: 1, day, stats, online, ndata }.
// Returns true on success.
export function saveAppStats(path, data) {
  const d = data ?? defaultAppStats();
  return writeJsonAtomic(path, {
    ver: 1,
    day: d.day ?? '',
    stats: d.stats ?? {},
    online: d.online ?? {},
    ndata: d.ndata ?? {},
  });
}

// ------------------------------------------------------------ devices.json
// Original devlist_load(): non-object entries are skipped, and every
// loaded entry is forced offline (online=false) -- a device that was
// online at shutdown is not pretended to still be online after restart;
// the current scan marks it online again.
export function loadDevices(path = DEVICES_PATH) {
  const data = readJsonFile(path, null, isObject);
  if (!data) return {};
  const out = {};
  for (const [key, entry] of Object.entries(data)) {
    if (!isObject(entry)) continue;
    out[key] = { ...entry, online: false };
  }
  return out;
}

// Original devlist_save(): writes the whole state.devices object.
// Returns true on success.
export function saveDevices(path, devices) {
  return writeJsonAtomic(path, devices ?? {});
}

// ------------------------------------------------------------ nft_schema
// Plain-text file holding the schema sha256. Missing file -> null
// (the original compared fs.readfile(...) == schema, so a missing file
// simply never matches and forces a rebuild).
export function loadSchema(path = APPCTL_SCHEMA_PATH) {
  try {
    return readFileSync(path, 'utf8');
  } catch (_e) {
    return null;
  }
}

export function saveSchema(path, schema) {
  return writeTextAtomic(path, String(schema));
}
