// util.js -- pure helpers ported verbatim from wifiroamd.uc.
// Target: Node 22.23.4, core modules only, zero npm dependencies.
// Semantics follow the ucode originals (spec.md §2); where ucode integer
// semantics differ from JS (64-bit ints vs 32-bit bitwise ops) the JS
// code uses Math.pow / BigInt so the *value* matches, see ipv4_cidr.
//
// This module has no state except the xorshift32 RNG (srand/rand/randhex)
// and the log writer (log/setLogWriter). It imports cmdOutput from
// shell.js only for now_minutes(); pass an explicit string to
// nowMinutes() to avoid the shell call.

import { createHash } from 'node:crypto';
import { cmdOutput } from './shell.js';

// ---------------------------------------------------------------- log
// Original: function log(msg) { printf("wifiroam: %s\n", msg); }
// Output goes to stdout (procd collects it); never to stderr.
let logWriter = (s) => process.stdout.write(s);

// Test hook only: replace where log lines go. Business code must not use it.
export function setLogWriter(fn) {
  logWriter = typeof fn === 'function' ? fn : (s) => process.stdout.write(s);
}

export function log(msg) {
  logWriter(`wifiroam: ${msg}\n`);
}

// ---------------------------------------------------------------- MAC
// Original: function macnorm(m) { return lc(replace(m ?? "", /[^0-9a-fA-F]/g, "")); }
export function macnorm(m) {
  return String(m ?? '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
}

// Original: 12-hex MAC -> upper-case colon form; anything else returned as-is.
export function maccolon(mn) {
  if (typeof mn !== 'string' || mn.length !== 12) return mn;
  return (
    mn.slice(0, 2) + ':' + mn.slice(2, 4) + ':' + mn.slice(4, 6) + ':' +
    mn.slice(6, 8) + ':' + mn.slice(8, 10) + ':' + mn.slice(10, 12)
  ).toUpperCase();
}

// Device-group id: "g" + 12 lowercase hex digits.
export function isGroupId(v) {
  return typeof v === 'string' && /^g[0-9a-f]{12}$/.test(v);
}

// Original devnorm: keep a g<12hex> group id, otherwise macnorm.
export function devnorm(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (isGroupId(s)) return s;
  return macnorm(s);
}

// Original mac_is_random: first byte's second hex digit is 2/6/a/e
// (IEEE 802 locally-administered bit).
export function macIsRandom(mn) {
  return typeof mn === 'string' && mn.length === 12 && ['2', '6', 'a', 'e'].includes(mn[1]);
}

// ------------------------------------------------------- xorshift32 RNG
// Originals (ucode):
//   srand(seed): rng_state = int(seed) & 0x7fffffff; 0 -> 0x9e3779b9
//   rand(): xorshift32, returns rng_state & 0x7fffffff
//   randhex(n): n hex chars, one rand()%16 per char ("%x", no padding)
let rngState = 0;

export function srand(seed) {
  rngState = (toInt(seed) | 0) & 0x7fffffff;
  if (rngState === 0) rngState = 0x9e3779b9;
}

export function rand() {
  rngState ^= (rngState << 13) & 0x7fffffff;
  rngState ^= rngState >> 17;
  rngState ^= (rngState << 5) & 0x7fffffff;
  return rngState & 0x7fffffff;
}

export function randhex(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += (rand() % 16).toString(16);
  return s;
}

// ------------------------------------------------------------ ucode ints
// ucode int(v): truncates numbers; for strings parses a leading optional
// sign + digits, and yields 0 when there is no leading number at all
// (int("") == 0, int("ab") == 0). Used wherever the original calls int()
// on UCI values, split fields, or CLI output.
export function toInt(v) {
  if (typeof v === 'number') return Math.trunc(v);
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    const m = /^[+-]?\d+/.exec(v.trim());
    return m ? parseInt(m[0], 10) : 0;
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  return 0;
}

// -------------------------------------------------------------- field_after
// Original: index(words, key) >= 0 ? words[i + 1] : null
// (out-of-range words[i+1] is null in ucode, hence the bounds check here).
export function fieldAfter(words, key) {
  if (!Array.isArray(words)) return null;
  const i = words.indexOf(key);
  return i >= 0 && i + 1 < words.length ? words[i + 1] : null;
}

// ------------------------------------------------------------- time helpers
// ucode time() == seconds since the epoch.
export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// "HH:MM" -> minutes since midnight; malformed input -> null.
// Original hhmm_minutes: split on ":", exactly 2 fields, h 0..23, m 0..59.
export function hhmmMinutes(s) {
  const f = String(s ?? '').trim().split(':');
  if (f.length !== 2) return null;
  const h = toInt(f[0]);
  const m = toInt(f[1]);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

// Original now_minutes: trim(cmd_output("date +%H:%M")) -> hhmm_minutes ?? 0.
// Pass an explicit "HH:MM" string to parse it without running `date`
// (used by tests and by callers that already have the clock reading).
export function nowMinutes(dateOutput) {
  const s = dateOutput !== undefined ? String(dateOutput).trim() : cmdOutput('date +%H:%M').trim();
  return hhmmMinutes(s) ?? 0;
}

// "YYYY-MM-DD" in *local* time, matching appctl_roll_day's
// localtime(time()) + sprintf("%04d-%02d-%02d", year, mon, mday).
export function localDayString(d = new Date()) {
  const y = String(d.getFullYear()).padStart(4, '0');
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

// ------------------------------------------------------------ IPv4 helpers
// Original mask_prefix: no "." -> int(m ?? "24"); dotted mask -> count
// leading 1 bits, stopping (and returning) at the first 0 bit.
export function maskPrefix(m) {
  if (String(m ?? '').indexOf('.') < 0) return toInt(m ?? '24');
  const parts = String(m).split('.');
  let bits = 0;
  for (let i = 0; i < 4; i++) {
    const v = toInt(parts[i] ?? '0');
    for (let b = 7; b >= 0; b--) {
      if (v & (1 << b)) bits++;
      else return bits;
    }
  }
  return bits;
}

// Original ipv4_cidr (verbatim, including the reversed octet order
// o[3],o[2],o[1],o[0] -- do NOT "fix" it to forward order; spec §9.14):
//   "192.168.0.1" + "255.255.255.0" -> "192.168.0.0/24"
// One deliberate deviation in *mechanism* only: the original computes
// div = 1 << host with ucode 64-bit ints; JS `1 << 31` goes negative,
// so 2 ** host is used -- the numeric result is identical.
export function ipv4Cidr(ipmask, mask) {
  const a = String(ipmask ?? '').split('/');
  const ip = a[0];
  const prefix = a[1] !== null && a[1] !== undefined && a[1] !== '' ? toInt(a[1]) : maskPrefix(mask ?? '255.255.255.0');
  let host = 32 - prefix;
  if (host < 0) host = 0;
  if (host > 31) host = 31;
  const parts = ip.split('.');
  let ipint = 0;
  for (let i = 0; i < 4; i++) ipint = ipint * 256 + toInt(parts[i] ?? '0');
  const div = 2 ** host;
  const net = ipint - (ipint % div);
  const o = [];
  let v = net;
  for (let i = 0; i < 4; i++) {
    o.push(String(v % 256));
    v = Math.trunc(v / 256);
  }
  return `${o[3]}.${o[2]}.${o[1]}.${o[0]}/${prefix}`;
}

// ---------------------------------------------------------- small adapters
// Original local `pick` in guest_lan_info: array -> first element, else as-is.
// (ucode get() returns an array for UCI list options.)
export function pick(v) {
  if (Array.isArray(v)) return v[0];
  return v;
}

// Original local `as_list` in appctl_dnsmasq_sync: array as-is,
// non-empty string wrapped in one element, everything else -> [].
export function asList(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v !== '') return [v];
  return [];
}

// -------------------------------------------------------------- sha256
// Original: digest.sha256(string) -> lowercase hex string.
// (Node crypto is the only non-pure dependency in this module.)
export function sha256(s) {
  return createHash('sha256').update(String(s), 'utf8').digest('hex');
}
