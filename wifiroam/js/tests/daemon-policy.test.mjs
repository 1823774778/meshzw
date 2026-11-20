// daemon-policy.test.mjs -- node:test suite for daemon/policy.mjs.
// uci/shell are mocked; no real router, nft, dnsmasq or DPI is touched.
// File writes go to a tmpdir via ctx.paths. Run:
//   node --test tests/daemon-policy.test.mjs   (from ~/workspace/wifiroam-js)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { APP_DEFS, createPolicy } from '../daemon/policy.mjs';
import { createClients } from '../daemon/clients.mjs';
import { UciClient } from '../lib/uci.js';
import { shellCommands } from '../lib/shell.js';
import { devnorm, localDayString, setLogWriter } from '../lib/util.js';

setLogWriter(() => {}); // silence `wifiroam: ban: ...` log lines in tests

const MAC1 = 'aabbccddeeff';
const MAC2 = '001122334455';
const COLON1 = 'AA:BB:CC:DD:EE:FF';

// ------------------------------------------------------------ fake UCI
// In-memory `uci` binary behind the real UciClient (exercises parseShow,
// list handling and the add/set/delete/commit argv shapes for real).
function makeUci() {
  const pkgs = new Map(); // pkg -> Map(sid -> { type, opts: Map })
  let counter = 0;
  const ensure = (pkg) => {
    if (!pkgs.has(pkg)) pkgs.set(pkg, new Map());
    return pkgs.get(pkg);
  };
  const parseTarget = (lhs) => {
    const dot = lhs.indexOf('.');
    const pkg = lhs.slice(0, dot);
    const rest = lhs.slice(dot + 1);
    const dot2 = rest.indexOf('.');
    if (dot2 < 0) return { pkg, sid: rest, opt: null };
    return { pkg, sid: rest.slice(0, dot2), opt: rest.slice(dot2 + 1) };
  };
  const runner = (argv) => {
    const [op, a, b, c] = argv;
    if (op === 'show') {
      const sections = pkgs.get(a);
      const lines = [];
      if (sections) {
        for (const [sid, sec] of sections) {
          lines.push(`${a}.${sid}=${sec.type}`);
          for (const [opt, val] of sec.opts) {
            const toks = Array.isArray(val) ? val : [val];
            lines.push(`${a}.${sid}.${opt}=${toks.map((t) => `'${t}'`).join(' ')}`);
          }
        }
      }
      return { code: 0, stdout: lines.length ? lines.join('\n') + '\n' : '' };
    }
    if (op === 'set') {
      const eq = a.indexOf('=');
      const { pkg, sid, opt } = parseTarget(a.slice(0, eq));
      const value = a.slice(eq + 1);
      const sections = ensure(pkg);
      if (opt === null) {
        sections.set(sid, { type: value, opts: new Map() });
        return { code: 0, stdout: '' };
      }
      const sec = sections.get(sid);
      if (!sec) return { code: 1, stdout: '' };
      sec.opts.set(opt, value);
      return { code: 0, stdout: '' };
    }
    if (op === 'add_list') {
      const eq = a.indexOf('=');
      const { pkg, sid, opt } = parseTarget(a.slice(0, eq));
      const sec = pkgs.get(pkg)?.get(sid);
      if (!sec) return { code: 1, stdout: '' };
      const cur = sec.opts.get(opt);
      const arr = Array.isArray(cur) ? [...cur] : cur === undefined ? [] : [cur];
      arr.push(a.slice(eq + 1));
      sec.opts.set(opt, arr);
      return { code: 0, stdout: '' };
    }
    if (op === 'delete') {
      const { pkg, sid, opt } = parseTarget(a);
      const sec = pkgs.get(pkg)?.get(sid);
      if (!sec) return { code: 1, stdout: '' };
      if (opt === null) pkgs.get(pkg).delete(sid);
      else sec.opts.delete(opt);
      return { code: 0, stdout: '' };
    }
    if (op === 'add') {
      const sid = 'cfg' + (counter++).toString(16).padStart(8, '0');
      const sections = ensure(a);
      sections.set(sid, { type: b, opts: new Map() });
      return { code: 0, stdout: sid + '\n' };
    }
    if (op === 'commit') return { code: 0, stdout: '' };
    return { code: 1, stdout: '' };
  };
  return new UciClient({ runner });
}

// Seed one named section directly through the fake runner's UCI surface.
function seedSection(uci, pkg, sid, type, opts) {
  uci.set(pkg, sid, type);
  for (const [k, v] of Object.entries(opts)) uci.set(pkg, sid, k, v);
}

// ------------------------------------------------------------ fake shell
function makeShell(handler) {
  const cmds = [];
  const nftScripts = []; // contents of files passed to `nft -f`
  const cmdOutput = (c) => {
    cmds.push(c);
    if (c.startsWith('nft -f ')) {
      const f = c.split(' ')[2];
      try { nftScripts.push(readFileSync(f, 'utf8')); } catch (_e) { /* gone */ }
      return '';
    }
    if (typeof handler === 'function') {
      const r = handler(c);
      if (r !== undefined) return r;
    }
    return '';
  };
  return { cmds, nftScripts, shell: { cmdOutput, shellCommands } };
}

// ------------------------------------------------------------ state
function freshState(role = 'cap') {
  return {
    cfg: { role },
    self: { ip: '192.168.12.1' },
    brdev: 'br-lan',
    peers: {},
    link: null,
    appctl: {
      enabled: true, enhanced: false, strict: false,
      devices: {}, stats: {}, day: '', online: {}, ndata: {},
    },
    ban: { enabled: false, list: [], sig: '', active: {} },
    _nft_snap: null, _dnslock_on: null, _appstat_ts: 0,
    _appstat_dirty: false, _appstat_saved: 0,
    _track_key: '', _warm_list: null, _warm_i: 0,
  };
}

function makeEnv(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wifiroam-policy-'));
  const S = freshState(overrides.role ?? 'cap');
  const uci = makeUci();
  const sh = makeShell(overrides.shellHandler);
  const paths = {
    schema: join(dir, 'nft_schema'),
    appstats: join(dir, 'appstats.json'),
    nftFile: join(dir, 'appctl.nft'),
    dpiBlocklist: join(dir, 'dpi_blocklist'),
    dpiPidfile: join(dir, 'dpi.pid'),
  };
  const policy = createPolicy({
    S, uci, shell: sh.shell, paths,
    localClients: overrides.localClients ?? (() => ({})),
    deviceKey: overrides.deviceKey,
    deviceMembersOf: overrides.deviceMembersOf,
    deviceAliasOf: overrides.deviceAliasOf,
    findClient: overrides.findClient,
    parseLeases: overrides.parseLeases,
    deviceGroupRefresh: overrides.deviceGroupRefresh,
    pushOffloadTo: overrides.pushOffloadTo,
    banApply: overrides.banApply,
  });
  return { dir, S, uci, sh, paths, policy };
}

function cleanup(env) {
  rmSync(env.dir, { recursive: true, force: true });
}

// Seed one appdev rule: mac -> block list (+optional name).
function seedAppdev(env, mac, block, name = '') {
  const sid = env.uci.add('wifiroam', 'appdev');
  env.uci.set('wifiroam', sid, 'mac', mac);
  if (name) env.uci.set('wifiroam', sid, 'name', name);
  env.uci.set('wifiroam', sid, 'block', block);
  env.uci.commit('wifiroam');
  return sid;
}

function nftJson(rules) {
  return JSON.stringify({ nftables: rules.map((r) => ({ rule: r })) });
}

function counterRule(comment, pk, by) {
  return { comment, expr: [{ counter: { packets: pk, bytes: by } }] };
}

// ================================================================ APP_DEFS
test('APP_DEFS: 47 entries verbatim from the original (spec App. C, corrected from 44)', () => {
  assert.equal(APP_DEFS.length, 47);
  const ids = APP_DEFS.map((a) => a.id);
  assert.deepEqual(ids.slice(0, 10),
    ['wechat', 'qq', 'douyin', 'tiktok', 'kuaishou', 'kwai', 'bilibili', 'xiaohongshu', 'weibo', 'taobao']);
  assert.equal(APP_DEFS.find((a) => a.id === 'qq').domains.length, 0); // 空条目仅兼容
  const douyin = APP_DEFS.find((a) => a.id === 'douyin');
  assert.deepEqual(douyin.probes,
    ['www.douyin.com', 'v3-web.douyinvod.com', 'v26-web.douyinvod.com', 'p3-pc-sign.douyinpic.com']);
  assert.deepEqual(APP_DEFS.find((a) => a.id === 'mihoyo').domains,
    ['dispatchcnglobal.yuanshen.com', 'hk4e-sdk.mihoyo.com', 'hk4e-api.mihoyo.com']);
  assert.equal(APP_DEFS.find((a) => a.id === 'roku').domains.join(','), 'ravm.tv,rokutime.com');
});

test('APP_DEFS: shared-CDN / embeddable-static domains are excluded (宁少计勿错计)', () => {
  const all = APP_DEFS.flatMap((a) => a.domains);
  for (const banned of ['alicdn.com', 'byteimg.com', 'bdstatic.com', 'zhimg.com', 'pddpic.com', 'kwaicdn.com']) {
    assert.ok(!all.includes(banned), banned + ' must not be listed');
  }
  // tiktok/kwai are separate products, not folded into douyin/kuaishou
  assert.ok(!APP_DEFS.find((a) => a.id === 'douyin').domains.includes('tiktok.com'));
  assert.ok(!APP_DEFS.find((a) => a.id === 'kuaishou').domains.includes('kwaicdn.com'));
  for (const a of APP_DEFS) {
    assert.equal(typeof a.id, 'string');
    assert.equal(typeof a.name, 'string');
    assert.ok(['social', 'video', 'shop', 'music', 'news', 'office', 'web', 'live', 'game', 'iot'].includes(a.cat));
    assert.ok(Array.isArray(a.domains));
  }
});

// ================================================================ nft rules
test('appctl_apply_rules: per-app counters, block drop, total rule, DPI queue only for blocked macs', async () => {
  const env = makeEnv({ localClients: () => ({ [MAC2]: {} }) });
  try {
    seedAppdev(env, MAC1, ['wechat']);
    await env.policy.appctlApplyRules();
    assert.equal(env.sh.nftScripts.length, 1);
    const script = env.sh.nftScripts[0];
    assert.ok(script.startsWith('flush chain inet wifiroam forward\nflush chain inet wifiroam fwpost\n'));
    assert.ok(script.includes(`ether saddr ${COLON1} ip daddr @wechat_v4 counter drop comment "wr:${MAC1}:wechat:block"`));
    assert.ok(script.includes(`ether saddr ${COLON1} ip6 daddr @wechat_v6 counter drop comment "wr:${MAC1}:wechat:block"`));
    assert.ok(script.includes(`ether saddr ${COLON1} ip daddr @qq_v4 counter comment "wr:${MAC1}:qq:allow"`));
    assert.ok(script.includes(`ether saddr ${COLON1} counter comment "wr:${MAC1}:*:total"`));
    // DPI queue (tcp first-payload + udp first packet) + fwpost mark copy, mac1 only
    assert.ok(script.includes(`ct state established tcp flags & (fin|syn|rst|ack) == ack queue num 0`));
    assert.ok(script.includes(`ct state new meta l4proto udp queue num 0`));
    assert.ok(script.includes(`add rule inet wifiroam fwpost ether saddr ${COLON1} meta mark != 0 ct mark set meta mark`));
    assert.equal((script.match(/queue num 0/g) || []).length, 2);
    assert.ok(!script.includes('00:11:22:33:44:55') || !/00:11:22:33:44:55[^]*queue num 0/.test(script.split(COLON1).pop() ?? ''));
    // unblocked mac2 gets allow + total rules, no queue rules after its own lines
    assert.ok(script.includes(`comment "wr:${MAC2}:wechat:allow"`));
    assert.ok(script.includes(`comment "wr:${MAC2}:*:total"`));
    assert.equal(env.S._track_key, [MAC1, MAC2].sort().join(','));
    assert.equal(env.S._nft_snap, null);
    assert.equal(env.S._appstat_ts, 0);
    assert.equal(existsSync(env.paths.nftFile), false); // unlinked after nft -f
  } finally { cleanup(env); }
});

test('appctl_apply_rules: strict mode adds QUIC / external-DNS / DoH drops before the DPI fast path', async () => {
  const env = makeEnv();
  try {
    env.S.appctl.strict = true;
    seedAppdev(env, MAC1, ['douyin']);
    await env.policy.appctlApplyRules();
    const script = env.sh.nftScripts[0];
    assert.ok(script.includes(`ether saddr ${COLON1} udp dport 443 counter drop`));
    assert.ok(script.includes(`ether saddr ${COLON1} udp dport 53 ip daddr != 192.168.12.1 counter drop`));
    assert.ok(script.includes(`ether saddr ${COLON1} tcp dport 53 ip daddr != 192.168.12.1 counter drop`));
    assert.ok(script.includes(`meta nfproto ipv6 udp dport 53 counter drop`));
    assert.ok(script.includes(`ip daddr { 8.8.8.8, 8.8.4.4, 9.9.9.9, 149.112.112.112, 223.5.5.5, 223.6.6.6, 119.29.29.29, 180.76.76.76, 114.114.114.114, 114.114.115.115 } tcp dport 443 counter drop`));
    assert.ok(!script.includes('1.1.1.1')); // Cloudflare 1.1.1.1 deliberately not listed
    // strict rules precede the DPI queue rules for the same mac
    assert.ok(script.indexOf('udp dport 443') < script.indexOf('queue num 0'));
  } finally { cleanup(env); }
});

test('appctl_nft_base: set timeout follows enhanced mode (12h loose / 30m precise)', () => {
  const env = makeEnv();
  try {
    env.policy.appctlNftBase();
    assert.ok(env.sh.cmds.some((c) => c.includes(`wechat_v4 '{ type ipv4_addr; flags interval; timeout 12h; }'`)));
    assert.ok(env.sh.cmds.some((c) => c.includes(`wechat_v6 '{ type ipv6_addr; flags interval; timeout 12h; }'`)));
    assert.ok(env.sh.cmds.some((c) => c.includes(`forward '{ type filter hook forward priority -10; policy accept; }'`)));
    assert.ok(env.sh.cmds.some((c) => c.includes(`fwpost '{ type filter hook forward priority -5; policy accept; }'`)));
    env.sh.cmds.length = 0;
    env.S.appctl.enhanced = true;
    env.policy.appctlNftBase();
    assert.ok(env.sh.cmds.some((c) => c.includes('timeout 30m')));
    assert.ok(!env.sh.cmds.some((c) => c.includes('timeout 12h')));
  } finally { cleanup(env); }
});

test('appctl_nft_schema: first call writes schema + flushes, second call is a no-op', () => {
  const env = makeEnv();
  try {
    assert.equal(env.policy.appctlNftSchema(), true);
    assert.equal(readFileSync(env.paths.schema, 'utf8'), env.policy.appctlNftSchemaId());
    assert.ok(env.sh.cmds.some((c) => c === 'nft flush chain inet wifiroam forward 2>/dev/null'));
    assert.ok(env.sh.cmds.some((c) => c === 'nft delete set inet wifiroam wechat_v4 2>/dev/null'));
    assert.ok(env.sh.cmds.some((c) => c === 'nft delete set inet wifiroam roku_v6 2>/dev/null'));
    const n = env.sh.cmds.length;
    assert.equal(env.policy.appctlNftSchema(), false);
    assert.equal(env.sh.cmds.length, n);
    // enhanced mode changes the timeout -> new schema id -> rebuild again
    env.S.appctl.enhanced = true;
    assert.equal(env.policy.appctlNftSchema(), true);
  } finally { cleanup(env); }
});

// ================================================================ dnsmasq sync
test('appctl_dnsmasq_sync: one ipset section per app with domains; empty apps skipped; idempotent', () => {
  const env = makeEnv();
  try {
    assert.equal(env.policy.appctlDnsmasqSync(true), true);
    const wechat = env.uci.get('dhcp', 'wifiroam_wechat');
    assert.equal(wechat.table, 'wifiroam');
    assert.equal(wechat.table_family, 'inet');
    assert.deepEqual(wechat.name, ['wechat_v4', 'wechat_v6']);
    assert.deepEqual(wechat.domain, ['weixin.qq.com', 'wx.qq.com', 'wechat.com']);
    assert.equal(env.uci.get('dhcp', 'wifiroam_qq'), null); // 空条目不建段
    assert.equal(env.uci.get('dhcp', 'wifiroam_roku').domain.join(','), 'ravm.tv,rokutime.com');
    assert.equal(env.policy.appctlDnsmasqSync(true), false); // 内容一致不再重启
    assert.equal(env.policy.appctlDnsmasqSync(false), true); // 关：删段
    assert.equal(env.uci.get('dhcp', 'wifiroam_wechat'), null);
    assert.equal(env.policy.appctlDnsmasqSync(false), false);
  } finally { cleanup(env); }
});

test('appctl_dnsmasq_sync: cleans legacy @dnsmasq nftset residue and _v6 split sections', () => {
  const env = makeEnv();
  try {
    seedSection(env.uci, 'dhcp', '@dnsmasq[0]', 'dnsmasq',
      { nftset: ['#wifiroam#wechat_v4', 'other-set'] });
    seedSection(env.uci, 'dhcp', 'wifiroam_wechat_v6', 'ipset', { name: ['wechat_v6'] });
    assert.equal(env.policy.appctlDnsmasqSync(true), true);
    assert.deepEqual(env.uci.getList('dhcp', '@dnsmasq[0]', 'nftset'), ['other-set']);
    assert.equal(env.uci.get('dhcp', 'wifiroam_wechat_v6'), null);
    assert.ok(env.uci.get('dhcp', 'wifiroam_wechat'));
  } finally { cleanup(env); }
});

// ================================================================ sampling
test('appctl_sample: v4+v6 accumulate, active window adds time+bytes, blocked and reset skipped', () => {
  const env = makeEnv({
    shellHandler: (c) => {
      if (c.startsWith('nft -j list table')) {
        return nftJson([
          counterRule(`wr:${MAC1}:wechat:allow`, 15, 6000),
          counterRule(`wr:${MAC1}:wechat:allow`, 12, 3000), // v6 twin
          counterRule(`wr:${MAC1}:douyin:block`, 99, 99999),
          counterRule(`wr:${MAC1}:qq:allow`, 5, 100), // counter reset vs snap
          counterRule(`wr:${MAC1}:*:total`, 120, 15000),
          { comment: 'not-wr:ignored', expr: [{ counter: { packets: 1, bytes: 1 } }] },
          { comment: 'wr:bad', expr: [] },
        ]);
      }
      return undefined;
    },
  });
  try {
    const now = Math.floor(Date.now() / 1000);
    env.S.appctl.day = localDayString(new Date());
    env.S._appstat_ts = now - 10;
    env.S._nft_snap = {
      [`${MAC1}|wechat`]: { pk: 10, by: 1000 },
      [`${MAC1}|douyin`]: { pk: 90, by: 90000 },
      [`${MAC1}|qq`]: { pk: 50, by: 5000 },
      [`${MAC1}|*`]: { pk: 100, by: 10000 },
    };
    env.policy.appctlSample();
    const w = env.S.appctl.stats[MAC1].wechat;
    assert.equal(w.today, 10); // dt = 10s (real elapsed)
    assert.equal(w.total, 10);
    assert.equal(w.btoday, 8000); // (6000+3000) - 1000
    assert.equal(w.btotal, 8000);
    assert.equal(w.days[env.S.appctl.day], 10);
    assert.equal(w.bdays[env.S.appctl.day], 8000);
    assert.equal(env.S.appctl.stats[MAC1].douyin, undefined); // blocked: 拦截尝试不计
    assert.equal(env.S.appctl.stats[MAC1].qq, undefined); // 计数归零跳过本轮
    assert.equal(env.S.appctl.ndata[MAC1][env.S.appctl.day], 5000); // total 流量
    assert.equal(env.S._nft_snap[`${MAC1}|wechat`].pk, 27); // v4+v6 累加
    assert.equal(env.S._nft_snap[`${MAC1}|wechat`].by, 9000);
    assert.equal(env.S._appstat_dirty, true);
  } finally { cleanup(env); }
});

test('appctl_sample: below-threshold window adds bytes but no time; non-cap does nothing', () => {
  const env = makeEnv({
    shellHandler: (c) => (c.startsWith('nft -j list table')
      ? nftJson([counterRule(`wr:${MAC1}:wechat:allow`, 2, 100)]) : undefined),
  });
  try {
    const now = Math.floor(Date.now() / 1000);
    env.S.appctl.day = localDayString(new Date());
    env.S._appstat_ts = now - 10;
    env.S._nft_snap = { [`${MAC1}|wechat`]: { pk: 0, by: 0 } };
    env.policy.appctlSample();
    const w = env.S.appctl.stats[MAC1].wechat;
    assert.equal(w.btoday, 100);
    assert.equal(w.today, 0); // pk 2 < 3 且 bytes 100 < 2048
    assert.equal(w.total, 0);
    // non-cap: no shell call at all
    env.S.cfg.role = 'sap';
    env.sh.cmds.length = 0;
    env.policy.appctlSample();
    assert.equal(env.sh.cmds.length, 0);
  } finally { cleanup(env); }
});

test('appctl_sample: enhanced mode needs pk AND bytes (pk-only window is idle)', () => {
  const env = makeEnv({
    shellHandler: (c) => (c.startsWith('nft -j list table')
      ? nftJson([counterRule(`wr:${MAC1}:wechat:allow`, 6, 100)]) : undefined),
  });
  try {
    const now = Math.floor(Date.now() / 1000);
    env.S.appctl.day = localDayString(new Date());
    env.S.appctl.enhanced = true;
    env.S._appstat_ts = now - 10;
    env.S._nft_snap = { [`${MAC1}|wechat`]: { pk: 0, by: 0 } };
    env.policy.appctlSample();
    assert.equal(env.S.appctl.stats[MAC1].wechat.today, 0); // pk 6>=5 但 bytes 100<4096
  } finally { cleanup(env); }
});

// ================================================================ day roll
test('appctl_roll_day: cross-day zeroes today/btoday and prunes day buckets to 7', () => {
  const env = makeEnv();
  try {
    const oldDays = {};
    const oldBdays = {};
    for (let i = 1; i <= 10; i++) {
      oldDays[`2026-10-${String(i).padStart(2, '0')}`] = i;
      oldBdays[`2026-10-${String(i).padStart(2, '0')}`] = i * 10;
    }
    env.S.appctl.day = '2026-10-31';
    env.S.appctl.stats = { [MAC1]: { wechat: { today: 60, total: 600, last: 1, btoday: 500, btotal: 5000, days: oldDays, bdays: oldBdays } } };
    env.S.appctl.online = { [MAC1]: { ...oldDays } };
    env.S.appctl.ndata = { [MAC1]: { ...oldDays } };
    env.policy.appctlRollDay();
    assert.notEqual(env.S.appctl.day, '2026-10-31');
    const w = env.S.appctl.stats[MAC1].wechat;
    assert.equal(w.today, 0);
    assert.equal(w.btoday, 0);
    assert.equal(w.total, 600); // total 不清零
    assert.deepEqual(Object.keys(w.days).sort(),
      ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10']);
    assert.equal(Object.keys(env.S.appctl.online[MAC1]).length, 7);
    assert.equal(env.S._appstat_dirty, true);
    // same day: no-op
    env.S._appstat_dirty = false;
    env.policy.appctlRollDay();
    assert.equal(env.S._appstat_dirty, false);
  } finally { cleanup(env); }
});

test('appctl_add_time/bytes/traffic: accumulation and by<=0 guard', () => {
  const env = makeEnv();
  try {
    env.S.appctl.day = '2026-11-15';
    env.policy.appctlAddTime(MAC1, 'wechat', 30, 1700000000);
    env.policy.appctlAddTime(MAC1, 'wechat', 15, 1700000030);
    env.policy.appctlAddBytes(MAC1, 'wechat', 1000, 1700000030);
    env.policy.appctlAddBytes(MAC1, 'wechat', 0, 1700000030);
    env.policy.appctlAddBytes(MAC1, 'wechat', -5, 1700000030);
    env.policy.appctlAddTraffic(MAC1, 700);
    env.policy.appctlAddTraffic(MAC1, 0);
    const w = env.S.appctl.stats[MAC1].wechat;
    assert.deepEqual(
      { today: w.today, total: w.total, last: w.last, btoday: w.btoday, btotal: w.btotal },
      { today: 45, total: 45, last: 1700000030, btoday: 1000, btotal: 1000 });
    assert.equal(w.days['2026-11-15'], 45);
    assert.equal(env.S.appctl.ndata[MAC1]['2026-11-15'], 700);
  } finally { cleanup(env); }
});

// ================================================================ warm-up
test('appctl_warm_list: probes first, then domains + www.; warm_step cycles one per tick', () => {
  const env = makeEnv();
  try {
    const list = env.policy.appctlWarmList();
    assert.deepEqual(list.slice(0, 4),
      ['www.douyin.com', 'v3-web.douyinvod.com', 'v26-web.douyinvod.com', 'p3-pc-sign.douyinpic.com']);
    assert.ok(list.includes('weixin.qq.com'));
    assert.ok(list.includes('www.weixin.qq.com'));
    assert.ok(!list.includes('qq.com')); // qq 无域名，不进清单
    env.policy.appctlWarmStep();
    assert.ok(env.sh.cmds[0].startsWith('timeout 3 nslookup www.douyin.com 127.0.0.1'));
    assert.equal(env.S._warm_i, 1);
    env.S._warm_i = list.length - 1;
    env.policy.appctlWarmStep();
    assert.ok(env.sh.cmds.at(-1).startsWith(`timeout 3 nslookup ${list.at(-1)} 127.0.0.1`));
    env.policy.appctlWarmStep(); // wrap to index 0
    assert.ok(env.sh.cmds.at(-1).startsWith('timeout 3 nslookup www.douyin.com 127.0.0.1'));
  } finally { cleanup(env); }
});

// ================================================================ DPI
test('appctl_dpi_write_blocklist: one line per member mac, blocked apps only', () => {
  const env = makeEnv({
    deviceMembersOf: (v) => (devnorm(v) === MAC1 ? [MAC1, MAC2] : [devnorm(v)]),
  });
  try {
    seedAppdev(env, MAC1, ['wechat', 'qq', 'nosuchapp']);
    seedAppdev(env, MAC2, []); // 空 block 不写行
    env.policy.appctlDpiWriteBlocklist();
    const text = readFileSync(env.paths.dpiBlocklist, 'utf8');
    const lines = text.trim().split('\n');
    assert.equal(lines.length, 2); // MAC1 的两个成员各一行
    assert.equal(lines[0], `${COLON1} weixin.qq.com,wx.qq.com,wechat.com`);
    assert.equal(lines[1], '00:11:22:33:44:55 weixin.qq.com,wx.qq.com,wechat.com');
  } finally { cleanup(env); }
});

test('appctl_dpi_daemon: start/stop/reload drive pidof/kill/pidfile exactly as the original', () => {
  const env = makeEnv({
    shellHandler: (c) => {
      if (c.startsWith('pidof wifiroam-dpi')) return '';
      if (c.startsWith('kill -0 ')) return '1';
      return undefined;
    },
  });
  try {
    // start, not running: background launch, no HUP
    env.policy.appctlDpiDaemon('start');
    assert.ok(env.sh.cmds.some((c) => c === '/usr/sbin/wifiroam-dpi & echo $! > /tmp/wifiroam-dpi.pid'));
    assert.ok(!env.sh.cmds.some((c) => c.includes('kill -HUP')));
    // stop with a pidfile pid: kill + unlink pidfile
    writeFileSync(env.paths.dpiPidfile, '4321\n');
    env.sh.cmds.length = 0;
    env.policy.appctlDpiDaemon('stop');
    assert.ok(env.sh.cmds.some((c) => c === 'kill 4321 2>/dev/null'));
    assert.equal(existsSync(env.paths.dpiPidfile), false);
    // reload when not running: silent no-op (no kill)
    env.sh.cmds.length = 0;
    env.policy.appctlDpiDaemon('reload');
    assert.ok(!env.sh.cmds.some((c) => c.includes('kill -HUP')));
  } finally { cleanup(env); }
});

test('appctl_dpi_daemon: running daemon gets HUP on start/reload; pidof first match wins', () => {
  const env = makeEnv({
    shellHandler: (c) => {
      if (c.startsWith('pidof wifiroam-dpi')) return '1234 5678\n';
      return undefined;
    },
  });
  try {
    env.policy.appctlDpiDaemon('start');
    assert.ok(env.sh.cmds.some((c) => c === 'kill -HUP 1234 2>/dev/null'));
    assert.ok(!env.sh.cmds.some((c) => c.includes('/usr/sbin/wifiroam-dpi &')));
    env.sh.cmds.length = 0;
    env.policy.appctlDpiDaemon('reload');
    assert.ok(env.sh.cmds.some((c) => c === 'kill -HUP 1234 2>/dev/null'));
    env.sh.cmds.length = 0;
    env.policy.appctlDpiDaemon('stop');
    assert.ok(env.sh.cmds.some((c) => c === 'kill 1234 2>/dev/null'));
    assert.equal(env.policy.appctlDpiPid(), '1234');
  } finally { cleanup(env); }
});

// ================================================================ DNS lock
test('appctl_dnslock_apply: builds dnsnat/dnslock chains once; off only flushes', () => {
  const env = makeEnv();
  try {
    env.policy.appctlDnslockApply(true);
    assert.equal(env.sh.nftScripts.length, 1);
    const script = env.sh.nftScripts[0];
    assert.ok(script.includes('add chain inet wifiroam dnsnat { type nat hook prerouting priority dstnat; policy accept; }'));
    assert.ok(script.includes('add chain inet wifiroam dnslock { type filter hook prerouting priority -5; policy accept; }'));
    assert.ok(script.includes('iifname { "br-lan", "br-guest" } udp dport 53 counter redirect'));
    assert.ok(script.includes('meta l4proto { tcp, udp } th dport 853 counter drop'));
    assert.ok(script.includes('ip daddr { 8.8.8.8, 8.8.4.4'));
    assert.ok(script.includes('ip6 daddr { 2001:4860:4860::8888'));
    const n = env.sh.cmds.length;
    env.policy.appctlDnslockApply(true); // same state: no-op
    assert.equal(env.sh.cmds.length, n);
    env.policy.appctlDnslockApply(false);
    assert.ok(env.sh.cmds.slice(n).some((c) => c.includes('nft flush chain inet wifiroam dnsnat')));
    assert.equal(env.sh.nftScripts.length, 1); // off 不写新脚本
    assert.equal(env.S._dnslock_on, false);
  } finally { cleanup(env); }
});

// ================================================================ hw suspend
test('appctl_hw_suspend: only touches hw offload when we suspended it', () => {
  const env = makeEnv();
  try {
    seedSection(env.uci, 'firewall', '@defaults[0]', 'defaults',
      { flow_offloading: '1', flow_offloading_hw: '1' });
    env.policy.appctlHwSuspend(true);
    assert.equal(env.uci.get('firewall', '@defaults[0]', 'flow_offloading_hw'), '0');
    assert.equal(env.uci.get('wifiroam', 'appctl', 'hw_suspended'), '1');
    assert.ok(env.sh.cmds.some((c) => c === '/etc/init.d/firewall reload >/dev/null 2>&1'));
    const n = env.sh.cmds.length;
    env.policy.appctlHwSuspend(true); // already marked: no-op
    assert.equal(env.sh.cmds.length, n);
    env.policy.appctlHwSuspend(false);
    assert.equal(env.uci.get('firewall', '@defaults[0]', 'flow_offloading_hw'), '1');
    assert.equal(env.uci.get('wifiroam', 'appctl', 'hw_suspended'), null);
    env.sh.cmds.length = 0;
    env.policy.appctlHwSuspend(false); // not ours: no-op
    assert.equal(env.sh.cmds.length, 0);
  } finally { cleanup(env); }
});

test('appctl_hw_suspend: no @defaults[0] section is a silent no-op', () => {
  const env = makeEnv();
  try {
    env.policy.appctlHwSuspend(true);
    env.policy.appctlHwSuspend(false);
    assert.equal(env.sh.cmds.length, 0);
  } finally { cleanup(env); }
});

// ================================================================ offload
test('offload_apply: writes both sw+hw, reloads only on change; false without defaults', () => {
  const env = makeEnv();
  try {
    seedSection(env.uci, 'firewall', '@defaults[0]', 'defaults',
      { flow_offloading: '0', flow_offloading_hw: '0' });
    assert.equal(env.policy.offloadApply(true), true);
    assert.equal(env.uci.get('firewall', '@defaults[0]', 'flow_offloading'), '1');
    assert.equal(env.uci.get('firewall', '@defaults[0]', 'flow_offloading_hw'), '1');
    assert.equal(env.sh.cmds.filter((c) => c.includes('firewall reload')).length, 1);
    assert.equal(env.policy.offloadApply(true), true); // already set: no reload
    assert.equal(env.sh.cmds.filter((c) => c.includes('firewall reload')).length, 1);
    assert.equal(env.policy.offloadApply(false), true);
    assert.equal(env.uci.get('firewall', '@defaults[0]', 'flow_offloading'), '0');
  } finally { cleanup(env); }
  const env2 = makeEnv();
  try {
    assert.equal(env2.policy.offloadApply(true), false);
    assert.equal(env2.sh.cmds.length, 0);
  } finally { cleanup(env2); }
});

test('offload_status: reads UCI flags and fw4 forward chain for active flowtable', () => {
  const env = makeEnv({
    shellHandler: (c) => (c.startsWith('nft list chain inet fw4 forward')
      ? 'table inet fw4 {\n chain forward {\n flow add @ft { ip saddr 1.2.3.4 }\n }\n}\n' : undefined),
  });
  try {
    seedSection(env.uci, 'firewall', '@defaults[0]', 'defaults',
      { flow_offloading: '1', flow_offloading_hw: '0' });
    assert.deepEqual(env.policy.offloadStatus(), { enabled: true, hw: false, active: true });
  } finally { cleanup(env); }
});

test('set_offload: SAP applies locally + asks CAP; CAP applies + broadcasts to authed peers', () => {
  const env = makeEnv({
    role: 'sap',
    pushOffloadTo: () => { throw new Error('SAP must not broadcast'); },
  });
  try {
    seedSection(env.uci, 'firewall', '@defaults[0]', 'defaults',
      { flow_offloading: '0', flow_offloading_hw: '0' });
    const defers = [];
    env.S.link = { authed: true, chan: { defer: (m, d) => defers.push([m, d]) } };
    assert.deepEqual(env.policy.setOffload({ enabled: true }), { ok: true, enabled: true });
    assert.equal(env.uci.get('firewall', '@defaults[0]', 'flow_offloading'), '1');
    assert.deepEqual(defers, [['set_offload', { enabled: true }]]);
    assert.equal(env.policy.offloadRequestCap(false), true);
    env.S.link.authed = false;
    assert.equal(env.policy.offloadRequestCap(true), false);
  } finally { cleanup(env); }

  const pushed = [];
  const env2 = makeEnv({ pushOffloadTo: (mn) => pushed.push(mn) });
  try {
    seedSection(env2.uci, 'firewall', '@defaults[0]', 'defaults',
      { flow_offloading: '0', flow_offloading_hw: '0' });
    env2.S.peers = { aaaa00000001: { authed: true }, bbbb00000002: { authed: false } };
    assert.deepEqual(env2.policy.setOffload({ enabled: true }), { ok: true, enabled: true });
    assert.deepEqual(pushed, ['aaaa00000001']);
  } finally { cleanup(env2); }

  const env3 = makeEnv();
  try {
    assert.deepEqual(env3.policy.setOffload({ enabled: true }),
      { ok: false, error: 'no_firewall_defaults' });
  } finally { cleanup(env3); }
});

// ================================================================ ban (canonical: clients)
// 定时断网的唯一实现在 clients；policy 不再导出任何 ban 函数，
// appctl_tick 设备组变化时只经注入的 ctx.banApply 调 clients.banApply。
// 下面的用例注入真实的 clients 模块重跑委派路径（ban 本体的行为由
// daemon-clients.test.mjs 覆盖）。
test('policy exports no ban functions', async () => {
  const env = makeEnv();
  try {
    for (const name of ['banHm', 'banHmStr', 'banWeekdays', 'banRead', 'banInWindow',
      'banFlushFlows', 'banApply', 'banRuleCount', 'banReloadEnabled', 'banLoad',
      'banTick', 'banList', 'setBan', 'banSet', 'banDel']) {
      assert.equal(env.policy[name], undefined, `policy.${name} must be removed`);
    }
  } finally { cleanup(env); }
});

test('ban delegation: appctlTick regroup calls injected clients.banApply(true)', async () => {
  const env = makeEnv({
    shellHandler: (c) => {
      if (c === 'nft list flowtables 2>/dev/null') return '';
      return undefined;
    },
    deviceGroupRefresh: () => { env.S._group_changed = true; },
  });
  try {
    // Seed one all-day ban rule in UCI, then build the canonical clients
    // module on the SAME state/uci/shell and inject its banApply.
    const sid = env.uci.add('wifiroam', 'ban');
    env.uci.set('wifiroam', sid, 'mac', MAC1);
    env.uci.set('wifiroam', sid, 'timeon', '00:00');
    env.uci.set('wifiroam', sid, 'timeoff', '23:59');
    env.uci.set('wifiroam', sid, 'weekdays', '1 2 3 4 5 6 7');
    env.uci.commit('wifiroam');
    env.S.ban.enabled = true;
    env.S.appctl.enabled = false; // keep appctlTick out of the rules path
    // The policy harness state is a subset of core's shared state; give
    // the canonical clients module the fields its ban path reads.
    env.S.aliases ??= { ver: 0, map: {}, groups: {}, redirect: {}, isolated: {}, pin: {} };
    env.S.device_index ??= {};
    env.S.devices ??= {};
    env.S.net_names ??= {};
    const written = {};
    const clients = createClients({
      S: env.S, uci: env.uci, shell: env.sh.shell,
      readFile: () => null, // no DHCP leases in this harness
      writeFile: (path, text) => { written[path] = text; return true; },
      unlinkFile: () => {},
      localtime: () => ({ wday: 5, hour: 23, min: 0 }), // Friday 23:00, in window
    });
    const banCalls = [];
    const policy2 = createPolicy({
      S: env.S, uci: env.uci, shell: env.sh.shell, paths: env.paths,
      localClients: () => ({}),
      deviceGroupRefresh: () => { env.S._group_changed = true; },
      banApply: (...a) => { banCalls.push(a); return clients.banApply(...a); },
    });
    await policy2.appctlTick(); // regrouped -> banApply(true) via the injected clients impl
    assert.deepEqual(banCalls, [[true]]);
    assert.deepEqual(env.S.ban.active, { [MAC1]: true });
    assert.ok(written['/tmp/wifiroam-ban.nft'].includes(
      `add rule inet wifiroam_ban forward ether saddr ${COLON1} counter drop`));
    assert.ok(env.sh.cmds.some((c) => c === 'nft add table inet wifiroam_ban 2>/dev/null'));
  } finally { cleanup(env); }
});

// ================================================================ public stats
test('appctl_public_stats/days: merge history MACs into device groups (max online, sum ndata)', () => {
  const groups = { [MAC1]: 'g111111111111', [MAC2]: 'g111111111111' };
  const env = makeEnv({ deviceKey: (v) => groups[devnorm(v)] ?? devnorm(v) });
  try {
    env.S.appctl.stats = {
      [MAC1]: { wechat: { today: 5, total: 10, last: 100, btoday: 100, btotal: 200, days: { '2026-11-15': 5 }, bdays: { '2026-11-15': 100 } } },
      [MAC2]: { wechat: { today: 7, total: 20, last: 90, btoday: 300, btotal: 400, days: { '2026-11-15': 7 }, bdays: { '2026-11-15': 300 } } },
    };
    env.S.appctl.online = { [MAC1]: { '2026-11-15': 30 }, [MAC2]: { '2026-11-15': 50 } };
    env.S.appctl.ndata = { [MAC1]: { '2026-11-15': 1000 }, [MAC2]: { '2026-11-15': 2000 } };
    const stats = env.policy.appctlPublicStats();
    const w = stats['g111111111111'].wechat;
    assert.deepEqual(
      { today: w.today, total: w.total, last: w.last, btoday: w.btoday, btotal: w.btotal },
      { today: 12, total: 30, last: 100, btoday: 400, btotal: 600 });
    assert.equal(w.days['2026-11-15'], 12);
    assert.equal(w.bdays['2026-11-15'], 400);
    const days = env.policy.appctlPublicDays(env.S.appctl.online, true);
    assert.equal(days['g111111111111']['2026-11-15'], 50); // 在线取最大
    const nd = env.policy.appctlPublicDays(env.S.appctl.ndata, false);
    assert.equal(nd['g111111111111']['2026-11-15'], 3000); // 流量求和
    const st = env.policy.appctlStatus();
    assert.equal(st.ok, true);
    assert.equal(st.apps.length, 47);
    assert.equal(st.apps[0].id, 'wechat');
    assert.equal(st.apps[0].domains, undefined); // 状态不返回域名
    assert.equal(st.stats['g111111111111'].wechat.today, 12);
  } finally { cleanup(env); }
});

// ================================================================ ubus bodies
test('set_appctl: writes UCI + state, strict empty keeps current, off removes the table', async () => {
  const env = makeEnv();
  try {
    env.S.appctl.strict = true;
    const r = await env.policy.setAppctl({ enabled: true, enhanced: true, strict: '' });
    assert.deepEqual(r, { ok: true, enabled: true, enhanced: true, strict: true });
    assert.equal(env.uci.get('wifiroam', 'appctl', 'enabled'), '1');
    assert.equal(env.uci.get('wifiroam', 'appctl', 'enhanced'), '1');
    assert.equal(env.uci.get('wifiroam', 'appctl', 'strict'), '1');
    assert.equal(env.S.appctl.enhanced, true);
    assert.ok(env.sh.cmds.some((c) => c === '/etc/init.d/dnsmasq restart >/dev/null 2>&1'));
    assert.ok(env.sh.cmds.some((c) => c === '/usr/sbin/wifiroam-dpi & echo $! > /tmp/wifiroam-dpi.pid'));
    const r2 = await env.policy.setAppctl({ enabled: true, enhanced: false, strict: '0' });
    assert.deepEqual(r2, { ok: true, enabled: true, enhanced: false, strict: false });
    const r3 = await env.policy.setAppctl({ enabled: false, enhanced: false, strict: '' });
    assert.deepEqual(r3, { ok: true, enabled: false, enhanced: false, strict: false });
    assert.ok(env.sh.cmds.some((c) => c === 'nft delete table inet wifiroam 2>/dev/null'));
    env.S.cfg.role = 'sap';
    assert.deepEqual(await env.policy.setAppctl({ enabled: true, enhanced: false, strict: '' }),
      { ok: false, error: 'not_cap' });
  } finally { cleanup(env); }
});

test('set_app_policy: block/allow round-trip, validation order matches the original', async () => {
  const env = makeEnv();
  try {
    env.S.appctl.enabled = false;
    assert.deepEqual(await env.policy.setAppPolicy({ mac: MAC1, app: 'wechat', action: 'block' }),
      { ok: false, error: 'disabled' });
    env.S.appctl.enabled = true;
    assert.deepEqual(await env.policy.setAppPolicy({ mac: 'zz', app: 'wechat', action: 'block' }),
      { ok: false, error: 'invalid_args' });
    assert.deepEqual(await env.policy.setAppPolicy({ mac: MAC1, app: 'nosuch', action: 'block' }),
      { ok: false, error: 'invalid_args' });
    assert.deepEqual(await env.policy.setAppPolicy({ mac: MAC1, app: 'wechat', action: 'mute' }),
      { ok: false, error: 'invalid_action' });
    const r = await env.policy.setAppPolicy({ mac: MAC1, app: 'wechat', action: 'block' });
    assert.deepEqual(r, { ok: true, mac: MAC1, app: 'wechat', action: 'block', block: ['wechat'] });
    const r2 = await env.policy.setAppPolicy({ mac: MAC1, app: 'douyin', action: 'block' });
    assert.deepEqual(r2.block, ['wechat', 'douyin']);
    const r3 = await env.policy.setAppPolicy({ mac: MAC1, app: 'wechat', action: 'allow' });
    assert.deepEqual(r3.block, ['douyin']);
    const r4 = await env.policy.setAppPolicy({ mac: MAC1, app: 'douyin', action: 'allow' });
    assert.deepEqual(r4.block, []); // 空列表删 section
    assert.deepEqual(env.policy.appctlReadDevices(), {});
    assert.ok(env.sh.cmds.some((c) => c.startsWith('nft -f '))); // 每次都重建规则
    env.S.cfg.role = 'sap';
    assert.deepEqual(await env.policy.setAppPolicy({ mac: MAC1, app: 'wechat', action: 'block' }),
      { ok: false, error: 'not_cap' });
  } finally { cleanup(env); }
});

test('appctl_read/write_device: merges duplicate sections, deletes on empty block', async () => {
  const env = makeEnv();
  try {
    const s1 = env.uci.add('wifiroam', 'appdev');
    env.uci.set('wifiroam', s1, 'mac', MAC1);
    env.uci.set('wifiroam', s1, 'name', 'Phone');
    env.uci.set('wifiroam', s1, 'block', ['wechat']);
    const s2 = env.uci.add('wifiroam', 'appdev');
    env.uci.set('wifiroam', s2, 'mac', MAC1);
    env.uci.set('wifiroam', s2, 'block', ['douyin', 'wechat']);
    env.uci.commit('wifiroam');
    const devs = env.policy.appctlReadDevices();
    assert.deepEqual(devs[MAC1], { name: 'Phone', block: ['wechat', 'douyin'] });
    env.policy.appctlWriteDevice(MAC1, ['wechat'], 'Phone');
    const devs2 = env.policy.appctlReadDevices();
    assert.deepEqual(devs2[MAC1].block, ['wechat']);
    env.policy.appctlWriteDevice(MAC1, [], '');
    assert.deepEqual(env.policy.appctlReadDevices(), {});
  } finally { cleanup(env); }
});

// ================================================================ tick/load
test('appctl_tick: rebuilds only on track-key/regroup change; saves throttled appstats', async () => {
  const grpOnce = { fired: false };
  const env = makeEnv({
    localClients: () => ({ [MAC1]: {} }),
    deviceGroupRefresh: () => { if (!grpOnce.fired) { grpOnce.fired = true; env.S._group_changed = true; } },
    shellHandler: (c) => (c.startsWith('nft -j list table') ? nftJson([]) : undefined),
  });
  try {
    env.S.appctl.day = localDayString(new Date());
    await env.policy.appctlTick(); // regrouped: rebuild + dpi reload + ban_apply(true)
    assert.ok(env.sh.nftScripts.length >= 1);
    assert.ok(env.sh.cmds.some((c) => c.startsWith('nft -f ')));
    const n = env.sh.cmds.length;
    env.S._group_changed = false;
    await env.policy.appctlTick(); // same track key, no regroup: no rebuild
    assert.equal(env.sh.cmds.filter((c) => c.startsWith('nft -f ')).length,
      env.sh.cmds.filter((c) => c.startsWith('nft -f ')).length); // no new nft -f
    assert.ok(!env.sh.cmds.slice(n).some((c) => c.startsWith('nft -f ')));
    // throttled save: dirty + 15s since last save -> writes appstats.json
    env.S._appstat_dirty = true;
    env.S._appstat_saved = 0;
    await env.policy.appctlTick();
    const saved = JSON.parse(readFileSync(env.paths.appstats, 'utf8'));
    assert.equal(saved.ver, 1);
    assert.equal(saved.day, env.S.appctl.day);
    assert.equal(env.S._appstat_dirty, false);
  } finally { cleanup(env); }
});

test('appctl_load: disabled cap stops DPI; enabled builds schema/rules/DPI and restarts dnsmasq', async () => {
  const env = makeEnv();
  try {
    seedSection(env.uci, 'wifiroam', 'appctl', 'appctl', { enabled: '0' });
    await env.policy.appctlLoad();
    assert.equal(env.S.appctl.enabled, false);
    assert.ok(env.sh.cmds.some((c) => c.startsWith('pidof wifiroam-dpi')));
    assert.ok(!env.sh.cmds.some((c) => c.startsWith('nft -f ')));
    env.sh.cmds.length = 0;
    env.uci.set('wifiroam', 'appctl', 'enabled', '1');
    env.uci.commit('wifiroam');
    await env.policy.appctlLoad();
    assert.equal(env.S.appctl.enabled, true);
    assert.ok(existsSync(env.paths.schema));
    assert.ok(env.sh.cmds.some((c) => c.startsWith('nft -f ')));
    assert.ok(env.sh.cmds.some((c) => c === '/usr/sbin/wifiroam-dpi & echo $! > /tmp/wifiroam-dpi.pid'));
    assert.ok(env.sh.cmds.some((c) => c === '/etc/init.d/dnsmasq restart >/dev/null 2>&1'));
  } finally { cleanup(env); }
});

test('appctl_load: non-cap role does not start DPI or build rules', async () => {
  const env = makeEnv({ role: 'sap' });
  try {
    seedSection(env.uci, 'wifiroam', 'appctl', 'appctl', { enabled: '1' });
    await env.policy.appctlLoad();
    assert.equal(env.S.appctl.enabled, true);
    assert.ok(!env.sh.cmds.some((c) => c.startsWith('nft -f ')));
    assert.ok(!env.sh.cmds.some((c) => c.includes('wifiroam-dpi')));
  } finally { cleanup(env); }
});

test('createPolicy requires shared state S', () => {
  assert.throws(() => createPolicy({}), /ctx\.S/);
  assert.throws(() => createPolicy(), /ctx\.S/);
});
