// daemon-clients.test.mjs -- node:test suite for daemon/clients.mjs.
// ubus/uci/shell are all mocked; no router, no real ubusd, no network
// beyond localhost is required. WOL uses an injected fake socket.
// Run: node --test tests/daemon-clients.test.mjs (from ~/workspace/wifiroam-js)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClients } from '../daemon/clients.mjs';
import { UciClient } from '../lib/uci.js';
import { shellCommands } from '../lib/shell.js';

// ------------------------------------------------------------ fake UCI
// In-memory UciClient runner: implements the argv surface lib/uci.js
// uses (show/set/add/delete/add_list/commit) over a sections Map.
function makeFakeUci() {
  const sections = new Map();
  let counter = 0;
  const serialize = () => {
    const lines = [];
    for (const sec of sections.values()) {
      lines.push(`wifiroam.${sec['.name']}=${sec['.type']}`);
      for (const [k, v] of Object.entries(sec)) {
        if (k === '.name' || k === '.type') continue;
        const toks = Array.isArray(v) ? v : [v];
        lines.push(`wifiroam.${sec['.name']}.${k}=${toks.map((t) => `'${t}'`).join(' ')}`);
      }
    }
    return lines.join('\n') + (lines.length ? '\n' : '');
  };
  const runner = (argv) => {
    const [cmd, ...rest] = argv;
    if (cmd === 'show') {
      return rest[0] === 'wifiroam' ? { code: 0, stdout: serialize() } : { code: 1, stdout: '' };
    }
    if (cmd === 'set') {
      const m = /^wifiroam\.([^.]+)(?:\.([^=]+))?=(.*)$/.exec(rest[0]);
      if (!m) return { code: 1, stdout: '' };
      const [, sid, opt, value] = m;
      if (opt === undefined) {
        const sec = sections.get(sid) ?? { '.name': sid, '.type': value };
        sec['.type'] = value;
        sections.set(sid, sec);
        return { code: 0, stdout: '' };
      }
      const sec = sections.get(sid);
      if (!sec) return { code: 1, stdout: '' };
      sec[opt] = value;
      return { code: 0, stdout: '' };
    }
    if (cmd === 'add') {
      const sid = `cfg${String(++counter).padStart(8, '0')}`;
      sections.set(sid, { '.name': sid, '.type': rest[1] });
      return { code: 0, stdout: `${sid}\n` };
    }
    if (cmd === 'delete') {
      const m = /^wifiroam\.([^.]+)(?:\.(.+))?$/.exec(rest[0]);
      if (!m) return { code: 1, stdout: '' };
      const sec = sections.get(m[1]);
      if (!sec) return { code: 1, stdout: '' };
      if (m[2] === undefined) sections.delete(m[1]);
      else delete sec[m[2]];
      return { code: 0, stdout: '' };
    }
    if (cmd === 'add_list') {
      const m = /^wifiroam\.([^.]+)\.([^=]+)=(.*)$/.exec(rest[0]);
      if (!m) return { code: 1, stdout: '' };
      const sec = sections.get(m[1]);
      if (!sec) return { code: 1, stdout: '' };
      const cur = sec[m[2]];
      sec[m[2]] = Array.isArray(cur) ? [...cur, m[3]] : (cur === undefined ? [m[3]] : [cur, m[3]]);
      return { code: 0, stdout: '' };
    }
    if (cmd === 'commit') return { code: 0, stdout: '' };
    return { code: 1, stdout: '' };
  };
  const uci = new UciClient({ runner });
  return {
    uci,
    sections,
    addSection(sid, type, opts = {}) {
      sections.set(sid, { '.name': sid, '.type': type, ...opts });
    },
  };
}

// ------------------------------------------------------------ ctx factory
function makeState() {
  return {
    cfg: { enabled: true, role: 'cap', token: 'tok', cap_ip: '', name: '' },
    self: {
      mac: 'AA:BB:CC:DD:EE:01', ip: '192.168.12.1', name: 'CAP',
      hostname: 'OpenWrt', model: 'Test', firmware: 'ImmortalWrt',
      nonce: 'abcd', ifaces: { aabbccddee01: true },
    },
    brdev: 'br-lan',
    bcast: '255.255.255.255',
    peers: {},
    discovered: {},
    aliases: { ver: 0, map: {}, groups: {}, redirect: {}, isolated: {}, pin: {} },
    pin_last: {},
    devices: {},
    dev_dirty: false,
    dev_saved: 0,
    device_index: {},
    device_obs: {},
    link: null,
    cap_learned: null,
    events: [],
    client_seen: {},
    client_bytes: {},
    bytes_cache: {},
    prev_clients: null,
    wired_seen: {},
    wifi_seen: {},
    prev_owner: null,
    net_names: {},
    roster: null,
    appctl: { enabled: false, enhanced: false, strict: false, devices: {}, stats: {}, day: '', online: {}, ndata: {} },
    ban: { enabled: false, list: [], sig: '', active: {} },
  };
}

function makeCtx(overrides = {}) {
  const S = overrides.S ?? makeState();
  const fakeUci = overrides.fakeUci ?? makeFakeUci();
  fakeUci.addSection('alias_sync', 'alias_sync', { ver: '0' });
  const tmp = mkdtempSync(join(tmpdir(), 'wifiroam-clients-'));
  const shellCmds = [];
  let shellFn = overrides.shellFn ?? (() => '');
  let leasesText = overrides.leasesText ?? '';
  let nowValue = overrides.now ?? 1700000000;
  let localtimeValue = overrides.localtime ?? { wday: 1, hour: 23, min: 0 };
  const wolSockets = [];
  const writtenFiles = {};
  const unlinkedFiles = [];
  const aliasBroadcastCalls = [];
  let sapDisconnectCalls = 0;
  const appctlCalls = [];
  const busCalls = [];
  let wirelessStatus = overrides.wirelessStatus ?? {};
  const hostapdClients = overrides.hostapdClients ?? {};
  const bus = {
    call: async (path, method) => {
      busCalls.push([path, method]);
      if (path === 'network.wireless') return wirelessStatus;
      if (path.startsWith('hostapd.')) return { clients: hostapdClients[path.slice(8)] ?? {} };
      return null;
    },
  };
  const clients = createClients({
    S,
    bus: overrides.bus ?? bus,
    uci: fakeUci.uci,
    shell: {
      cmdOutput: (cmd) => { shellCmds.push(cmd); return shellFn(cmd); },
      shellCommands,
    },
    aliasPath: join(tmp, 'aliases.json'),
    devicesPath: join(tmp, 'devices.json'),
    now: () => nowValue,
    localtime: () => localtimeValue,
    readFile: (p) => (p === '/tmp/dhcp.leases' ? leasesText : null),
    writeFile: (p, text) => { writtenFiles[p] = text; return true; },
    unlinkFile: (p) => { unlinkedFiles.push(p); },
    detectUplink: () => ({ type: 'wired', port: 'eth0', gw: '192.168.12.1' }),
    selfUptime: () => 12345,
    aliasBroadcast: () => { aliasBroadcastCalls.push(1); },
    sapDisconnect: () => { sapDisconnectCalls++; },
    appctlReadDevices: () => { appctlCalls.push('read_devices'); },
    appctlApplyRules: () => { appctlCalls.push('apply_rules'); },
    appctlDpiDaemon: (a) => { appctlCalls.push(`dpi:${a}`); },
    wolSocketFactory: () => {
      const sock = {
        sent: [],
        setBroadcast() {},
        send(pkt, port, address) { sock.sent.push({ port, address, len: pkt.length }); },
        close() {},
        on() {},
        unref() {},
      };
      wolSockets.push(sock);
      return sock;
    },
    ...overrides.ctx,
  });
  return {
    S, clients, fakeUci, tmp, shellCmds, wolSockets, writtenFiles, unlinkedFiles,
    aliasBroadcastCalls, appctlCalls, busCalls,
    get sapDisconnectCalls() { return sapDisconnectCalls; },
    setNow: (v) => { nowValue = v; },
    setLeases: (t) => { leasesText = t; },
    setShellFn: (fn) => { shellFn = fn; },
    setLocaltime: (v) => { localtimeValue = v; },
    setWireless: (v) => { wirelessStatus = v; },
    setHostapd: (ifname, v) => { hostapdClients[ifname] = v; },
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}

// MAC helpers for tests
const SELF = 'aabbccddee01';
const PHONE_RANDOM = '123456789abc'; // 0x12: locally administered -> random
const PHONE_FACTORY = '102030405060'; // 0x10: 2nd hex digit 0 -> not random
const WIRED = '001122334455';
const PEER = 'aabbccddee03';

// ------------------------------------------------------------ MAC / grouping
test('deviceKey follows redirect chain (guard 16)', (t) => {
  const h = makeCtx();
  h.S.aliases.redirect = { g111111111111: 'g222222222222', g222222222222: 'g333333333333' };
  assert.equal(h.clients.deviceKey('g111111111111'), 'g333333333333');
  assert.equal(h.clients.deviceKey('10:20:30:40:50:60'), PHONE_FACTORY);
  h.cleanup();
});

test('deviceMembersOf: group sorted, single MAC, invalid empty', (t) => {
  const h = makeCtx();
  h.S.aliases.groups = { gaaaaaaaaaaaa: { created: 1, members: { '001122334455': {}, '123456789abc': {} } } };
  h.S.device_index = { '001122334455': 'gaaaaaaaaaaaa', '123456789abc': 'gaaaaaaaaaaaa' };
  assert.deepEqual(h.clients.deviceMembersOf('gaaaaaaaaaaaa'), ['001122334455', '123456789abc']);
  assert.deepEqual(h.clients.deviceMembersOf(PHONE_FACTORY), [PHONE_FACTORY]);
  assert.deepEqual(h.clients.deviceMembersOf('not-a-mac'), []);
  h.cleanup();
});

test('deviceAliasOf priority: group key, then raw MAC, then member', (t) => {
  const h = makeCtx();
  h.S.aliases.groups = { gaaaaaaaaaaaa: { created: 1, members: { [PHONE_RANDOM]: {} } } };
  h.S.device_index = { [PHONE_RANDOM]: 'gaaaaaaaaaaaa' };
  h.S.aliases.map = {
    [PHONE_RANDOM]: { name: 'member-name', icon: null, note: null },
    gaaaaaaaaaaaa: { name: 'group-name', icon: null, note: null },
  };
  assert.equal(h.clients.deviceAliasOf(PHONE_RANDOM).name, 'group-name');
  delete h.S.aliases.map.gaaaaaaaaaaaa;
  assert.equal(h.clients.deviceAliasOf(PHONE_RANDOM).name, 'member-name');
  h.cleanup();
});

test('deviceNewGroup: g + 12 hex, members + index set', (t) => {
  const h = makeCtx();
  const gid = h.clients.deviceNewGroup(PHONE_RANDOM, '');
  assert.match(gid, /^g[0-9a-f]{12}$/);
  assert.equal(h.S.device_index[PHONE_RANDOM], gid);
  assert.equal(h.S.aliases.groups[gid].members[PHONE_RANDOM].first_seen, 1700000000);
  h.cleanup();
});

test('deviceMergeGroups keeps earlier created, moves alias, sets redirect, emits event', (t) => {
  const h = makeCtx();
  h.S.aliases.groups = {
    gaaaaaaaaaaaa: { created: 100, members: { [PHONE_RANDOM]: {} } },
    gbbbbbbbbbbbb: { created: 200, members: { [WIRED]: {} } },
  };
  h.S.aliases.map = { gbbbbbbbbbbbb: { name: 'B', icon: null, note: null } };
  const kept = h.clients.deviceMergeGroups('gaaaaaaaaaaaa', 'gbbbbbbbbbbbb');
  assert.equal(kept, 'gaaaaaaaaaaaa');
  assert.equal(h.S.aliases.redirect.gbbbbbbbbbbbb, 'gaaaaaaaaaaaa');
  assert.equal(h.S.aliases.map.gaaaaaaaaaaaa.name, 'B');
  assert.equal(h.S.aliases.groups.gbbbbbbbbbbbb, undefined);
  assert.equal(h.S.events[0].type, 'device_merge');
  h.cleanup();
});

test('deviceMergeEvidence: dual_band, generic host blocked, simultaneous blocked, dhcp_clientid', (t) => {
  const h = makeCtx();
  const mk = (gid, mn, meta) => {
    h.S.aliases.groups[gid] = { created: 1, members: { [mn]: meta } };
  };
  mk('gaaaaaaaaaaaa', PHONE_RANDOM, { hostname: 'Phone-1' });
  mk('gbbbbbbbbbbbb', '223456789abc', { hostname: 'Phone-1' });
  h.S.device_obs = {
    [PHONE_RANDOM]: { hostname: 'Phone-1', online: false },
    '223456789abc': { hostname: 'Phone-1', online: false },
  };
  assert.equal(h.clients.deviceMergeEvidence('gaaaaaaaaaaaa', 'gbbbbbbbbbbbb'), 'dual_band');
  // simultaneous online blocks dual_band
  h.S.device_obs[PHONE_RANDOM].online = true;
  h.S.device_obs['223456789abc'].online = true;
  assert.equal(h.clients.deviceMergeEvidence('gaaaaaaaaaaaa', 'gbbbbbbbbbbbb'), null);
  // generic hostname never merges
  h.S.device_obs[PHONE_RANDOM] = { hostname: 'android', online: false };
  h.S.device_obs['223456789abc'] = { hostname: 'android', online: false };
  assert.equal(h.clients.deviceMergeEvidence('gaaaaaaaaaaaa', 'gbbbbbbbbbbbb'), null);
  // dhcp clientid wins over hostname mismatch
  h.S.device_obs[PHONE_RANDOM] = { hostname: 'Phone-1', clientid: '1:aa:bb:cc', online: false };
  h.S.device_obs['223456789abc'] = { hostname: 'Phone-1', clientid: '1:aa:bb:cc', online: false };
  assert.equal(h.clients.deviceMergeEvidence('gaaaaaaaaaaaa', 'gbbbbbbbbbbbb'), 'dhcp_clientid');
  h.cleanup();
});

test('deviceGroupRefresh merges factory + random MAC with same hostname (cap only)', async (t) => {
  const h = makeCtx({
    leasesText: `1700000000 ${PHONE_FACTORY.toUpperCase().replace(/(..)/g, '$1:').slice(0, -1)} 192.168.12.50 Phone-1 *\n` +
      `1700000000 12:34:56:78:9A:BC 192.168.12.51 Phone-1 *\n`,
  });
  await h.clients.deviceGroupRefresh();
  const gid = h.S.device_index[PHONE_RANDOM];
  assert.match(gid, /^g[0-9a-f]{12}$/);
  assert.equal(h.S.device_index[PHONE_FACTORY], gid);
  assert.ok(h.S.aliases.groups[gid].members[PHONE_FACTORY]);
  assert.ok(h.S.aliases.groups[gid].members[PHONE_RANDOM]);
  assert.equal(h.aliasBroadcastCalls.length, 1);
  // non-cap: no grouping at all
  const h2 = makeCtx({ leasesText: '1700000000 12:34:56:78:9A:BC 192.168.12.51 Phone-1 *\n' });
  h2.S.cfg.role = 'sap';
  await h2.clients.deviceGroupRefresh();
  assert.deepEqual(h2.S.device_index, {});
  h.cleanup(); h2.cleanup();
});

test('deviceUngroup: random MAC splits to new group + isolated; factory MAC just isolated; not_found', (t) => {
  const h = makeCtx();
  h.S.aliases.groups = {
    gaaaaaaaaaaaa: { created: 100, members: { [PHONE_RANDOM]: {}, [PHONE_FACTORY]: {} } },
  };
  h.S.device_index = { [PHONE_RANDOM]: 'gaaaaaaaaaaaa', [PHONE_FACTORY]: 'gaaaaaaaaaaaa' };
  const r = h.clients.deviceUngroup(PHONE_RANDOM);
  assert.equal(r.ok, true);
  assert.match(r.id, /^g[0-9a-f]{12}$/);
  assert.equal(r.isolated, true);
  assert.equal(h.S.aliases.isolated[PHONE_RANDOM], true);
  assert.equal(h.S.device_index[PHONE_RANDOM], r.id);
  assert.equal(h.aliasBroadcastCalls.length, 1);
  const r2 = h.clients.deviceUngroup(PHONE_FACTORY);
  assert.deepEqual(r2, { ok: true, id: PHONE_FACTORY, mac: '10:20:30:40:50:60', isolated: true });
  assert.equal(h.clients.deviceUngroup(WIRED).error, 'not_found');
  h.cleanup();
});

// ------------------------------------------------------------ alias / pin
test('aliasApply set/delete + group member cleanup; pinApply ok/invalid_ap/unknown_ap/clear', (t) => {
  const h = makeCtx();
  assert.equal(h.clients.aliasApply('12:34:56:78:9A:BC', 'Phone', 'phone', 'note'), true);
  assert.equal(h.S.aliases.map[PHONE_RANDOM].name, 'Phone');
  assert.equal(h.clients.aliasApply('12:34:56:78:9A:BC', '', null, null), true);
  assert.equal(h.S.aliases.map[PHONE_RANDOM], undefined);
  assert.equal(h.clients.aliasApply('not-a-mac', 'X', null, null), false);
  // pin to self
  const ok = h.clients.pinApply(PHONE_RANDOM, SELF);
  assert.deepEqual(ok, { ok: true, mac: PHONE_RANDOM, ap: SELF });
  assert.equal(h.clients.pinOf(PHONE_RANDOM), SELF);
  assert.equal(h.clients.pinApply(PHONE_RANDOM, 'zz').error, 'invalid_ap');
  assert.equal(h.clients.pinApply(PHONE_RANDOM, 'aabbccddee99').error, 'unknown_ap');
  assert.deepEqual(h.clients.pinApply(PHONE_RANDOM, ''), { ok: true, mac: PHONE_RANDOM, ap: '' });
  assert.equal(h.clients.pinOf(PHONE_RANDOM), null);
  h.cleanup();
});

test('aliasLoad/aliasSave roundtrip via temp file + UCI alias_sync mirror', (t) => {
  const h = makeCtx();
  h.clients.aliasApply(PHONE_RANDOM, 'Phone', null, null);
  const saved = JSON.parse(readFileSync(join(h.tmp, 'aliases.json'), 'utf8'));
  assert.equal(saved.map[PHONE_RANDOM].name, 'Phone');
  assert.equal(h.fakeUci.uci.get('wifiroam', 'alias_sync', 'ver'), String(h.S.aliases.ver));
  const h2 = makeCtx();
  // load the file h wrote by pointing h2 at the same path
  const c2 = createClients({
    S: h2.S, uci: h2.fakeUci.uci, aliasPath: join(h.tmp, 'aliases.json'),
    devicesPath: join(h.tmp, 'devices.json'),
  });
  c2.aliasLoad();
  assert.equal(c2.deviceAliasOf(PHONE_RANDOM).name, 'Phone');
  h.cleanup(); h2.cleanup();
});

// ------------------------------------------------------------ parsing
test('parseLeases / parseNeigh', (t) => {
  const h = makeCtx({
    leasesText: '1700000000 12:34:56:78:9A:BC 192.168.12.50 Phone-1 1:aa:bb\n1700000000 10:20:30:40:50:60 192.168.12.51 * *\n',
    shellFn: (cmd) => cmd.includes('ip neigh')
      ? '192.168.12.50 dev br-lan lladdr 12:34:56:78:9a:bc REACHABLE\n192.168.12.99 dev br-lan lladdr 00:11:22:33:44:55 FAILED\nfe80::1 dev br-lan lladdr 00:11:22:33:44:66 REACHABLE\n'
      : '',
  });
  const leases = h.clients.parseLeases();
  assert.equal(leases[PHONE_RANDOM].hostname, 'Phone-1');
  assert.equal(leases[PHONE_RANDOM].clientid, '1:aa:bb');
  assert.equal(leases[PHONE_FACTORY].hostname, null);
  const neigh = h.clients.parseNeigh();
  assert.deepEqual(Object.keys(neigh), [PHONE_RANDOM]); // FAILED + IPv6 skipped
  h.cleanup();
});

test('parseFdb: bridge path, then brctl fallback', (t) => {
  const h = makeCtx({
    shellFn: (cmd) => {
      if (cmd.includes('bridge fdb')) return '00:11:22:33:44:55 dev lan1 vlan 1 master br-lan state forwarding\n00:11:22:33:44:66 dev lan2 self permanent\n';
      return '';
    },
  });
  assert.deepEqual(h.clients.parseFdb(), { [WIRED]: 'lan1' });
  const h2 = makeCtx({
    shellFn: (cmd) => {
      if (cmd.includes('bridge fdb')) return '';
      if (cmd.includes('showstp')) return 'lan1 (1)\nlan2 (2)\n';
      if (cmd.includes('showmacs')) return '  1\t00:11:22:33:44:55\tno\t  0.00\n  2\t00:11:22:33:44:66\tyes\t  0.00\n';
      return '';
    },
  });
  assert.deepEqual(h2.clients.parseFdb(), { [WIRED]: 'lan1' });
  h.cleanup(); h2.cleanup();
});

test('stationBytes parses rx/tx and reuses 1s cache', (t) => {
  let calls = 0;
  const dump = 'Station 12:34:56:78:9a:bc (on wlan0)\n\trx bytes:\t1000\n\ttx bytes:\t2000\n';
  const h = makeCtx({
    shellFn: (cmd) => {
      if (cmd.includes('station dump')) { calls++; return dump; }
      return '';
    },
  });
  assert.deepEqual(h.clients.stationBytes('wlan0'), { [PHONE_RANDOM]: { rx: 1000, tx: 2000 } });
  assert.deepEqual(h.clients.stationBytes('wlan0'), { [PHONE_RANDOM]: { rx: 1000, tx: 2000 } });
  assert.equal(calls, 1); // cached within 1s
  h.setNow(1700000002);
  h.clients.stationBytes('wlan0');
  assert.equal(calls, 2); // cache expired
  h.cleanup();
});

// ------------------------------------------------------------ localClients
function wifiCtx(overrides = {}) {
  return makeCtx({
    wirelessStatus: {
      radio0: { config: { band: '5g' }, interfaces: [{ ifname: 'wlan0', config: { ssid: 'Home5G' } }] },
    },
    hostapdClients: {
      wlan0: {
        '12:34:56:78:9A:BC': { signal: -50, connected_time: 120, rate: { tx: 7220000, rx: 4330000 } },
        'AA:BB:CC:DD:EE:01': { signal: -30, connected_time: 999, rate: { tx: 1000000, rx: 1000000 } },
      },
    },
    shellFn: (cmd) => {
      if (cmd.includes('station dump')) return 'Station 12:34:56:78:9a:bc (on wlan0)\n\trx bytes:\t1000000\n\ttx bytes:\t2000000\n';
      if (cmd.includes('bridge fdb')) return `${WIRED.replace(/(..)/g, '$1:').slice(0, -1)} dev lan1 vlan 1 master br-lan state forwarding\n`;
      return '';
    },
    ...overrides,
  });
}

test('localClients: wifi rates, realtime speed diff, self-iface excluded, wired via FDB, multicast skipped', async (t) => {
  const h = wifiCtx();
  h.setNow(1000);
  const c1 = await h.clients.localClients();
  assert.equal(c1[PHONE_RANDOM].type, 'wifi');
  assert.equal(c1[PHONE_RANDOM].tx_rate, 72.2);
  assert.equal(c1[PHONE_RANDOM].rx_rate, 43.3);
  assert.equal(c1[PHONE_RANDOM].rx_speed, null); // first sample: no prev bytes
  assert.equal(c1[SELF], undefined); // AP's own iface MAC excluded
  assert.equal(c1[WIRED].type, 'wired');
  assert.equal(c1[WIRED].port, 'lan1');
  // second sample 10s later, bytes grew -> speeds
  h.setShellFn((cmd) => {
    if (cmd.includes('station dump')) return 'Station 12:34:56:78:9a:bc (on wlan0)\n\trx bytes:\t2000000\n\ttx bytes:\t4000000\n';
    if (cmd.includes('bridge fdb')) return `${WIRED.replace(/(..)/g, '$1:').slice(0, -1)} dev lan1 vlan 1 master br-lan state forwarding\n`;
    return '';
  });
  h.setNow(1010);
  const c2 = await h.clients.localClients();
  assert.equal(c2[PHONE_RANDOM].rx_speed, 0.8); // (1e6 * 8 / 10 / 1e6)
  assert.equal(c2[PHONE_RANDOM].tx_speed, 1.6);
  h.cleanup();
});

test('computeOwner: wifi beats wired, self beats peer on same type', (t) => {
  const h = makeCtx();
  h.S.peers = {
    [PEER]: { clients: { [PHONE_RANDOM]: { type: 'wifi', rssi: -40 }, [WIRED]: { type: 'wifi' } } },
  };
  const owner = h.clients.computeOwner(
    { [PHONE_RANDOM]: { type: 'wired' }, [WIRED]: { type: 'wired' } }, SELF);
  assert.equal(owner[PHONE_RANDOM], PEER); // peer wifi > self wired
  assert.equal(owner[WIRED], PEER);
  // same type on both sides: self wins
  h.S.peers[PEER].clients = { [PHONE_RANDOM]: { type: 'wired' }, [WIRED]: { type: 'wired' } };
  const owner2 = h.clients.computeOwner(
    { [PHONE_RANDOM]: { type: 'wired' }, [WIRED]: { type: 'wired' } }, SELF);
  assert.equal(owner2[PHONE_RANDOM], SELF);
  assert.equal(owner2[WIRED], SELF);
  h.cleanup();
});

test('buildTopology: AP nodes + grouped client nodes, peer clients listed', async (t) => {
  const h = wifiCtx();
  h.S.peers = {
    [PEER]: {
      mac: 'AA:BB:CC:DD:EE:03', name: 'SAP1', role: 'sap', authed: true,
      info: { name: 'SAP1', model: 'X', ip: '192.168.12.2', firmware: 'ImmortalWrt', uptime: 100, uplink: { type: 'wired' } },
      clients: { [PHONE_RANDOM]: { mac: '12:34:56:78:9A:BC', type: 'wifi', ssid: 'Home5G', band: '5g', rssi: -40, hostname: 'Phone-1', ip: '192.168.12.50' } },
    },
  };
  const topo = await h.clients.buildTopology();
  assert.equal(topo.self, SELF);
  assert.equal(topo.role, 'cap');
  const aps = topo.nodes.filter((n) => n.type === 'ap');
  const clients = topo.nodes.filter((n) => n.type === 'client');
  assert.equal(aps.length, 2);
  assert.equal(clients.length, 2); // phone (wifi) + wired PC from FDB
  const phone = clients.find((c) => c.mac === '12:34:56:78:9A:BC');
  assert.equal(phone.parent, SELF); // owner: self wifi (first pass) wins
  // local client has no hostname (leases empty); the peer's hostname is
  // NOT copied onto the local entry by build_topology, so name = MAC.
  assert.equal(phone.name, '12:34:56:78:9A:BC');
  assert.equal(aps[0].clients.length, 2);
  assert.ok(aps[0].clients.includes(phone.id));
  assert.equal(aps[1].uplink.type, 'wired');
  assert.equal(aps[1].authed, true);
  h.cleanup();
});

// ------------------------------------------------------------ history
test('devlistTick/devlistView: history created, offline marked, online first, can_wake', async (t) => {
  const h = wifiCtx();
  h.S.devices = {
    [WIRED]: { mac: '00:11:22:33:44:55', ip: '192.168.12.60', hostname: 'PC', first_seen: 1000, last_online: 1500, last_offline: null, online: true, ap: SELF, conn: 'wired' },
  };
  const view = await h.clients.devlistView();
  const live = view.devices.find((d) => d.id === h.S.device_index[PHONE_RANDOM] || d.mac === '12:34:56:78:9A:BC');
  assert.ok(live);
  assert.equal(live.online, true);
  assert.equal(live.can_wake, false);
  const wired = view.devices.find((d) => d.id === WIRED);
  assert.ok(wired);
  assert.equal(wired.online, true); // wired still in FDB this round
  assert.equal(view.devices[0].online, true);
  assert.deepEqual(view.aps[0], { id: SELF, name: 'CAP' });
  // next round: FDB empty -> wired goes offline with last_offline set
  h.setShellFn(() => '');
  h.setNow(1700000400); // +400s > WIRED_TTL(300s): FDB sighting finally expires
  const view2 = await h.clients.devlistView();
  const wired2 = view2.devices.find((d) => d.id === WIRED);
  assert.equal(wired2.online, false);
  assert.equal(wired2.last_offline, 1700000400);
  assert.equal(wired2.can_wake, true);
  h.cleanup();
});

test('devlistNormalize migrates old keys to current device_key', (t) => {
  const h = makeCtx();
  h.S.aliases.groups = { gaaaaaaaaaaaa: { created: 1, members: { [PHONE_RANDOM]: {} } } };
  h.S.device_index = { [PHONE_RANDOM]: 'gaaaaaaaaaaaa' };
  h.S.devices = { [PHONE_RANDOM]: { mac: '12:34:56:78:9A:BC', first_seen: 100, last_online: 200, online: false } };
  assert.equal(h.clients.devlistNormalize(), true);
  assert.ok(h.S.devices.gaaaaaaaaaaaa);
  assert.equal(h.S.devices[PHONE_RANDOM], undefined);
  h.cleanup();
});

test('findClient: local first, peer fallback, wifi preferred over wired', async (t) => {
  const h = wifiCtx({
    shellFn: (cmd) => {
      if (cmd.includes('station dump')) return 'Station 12:34:56:78:9a:bc (on wlan0)\n\trx bytes:\t1000000\n\ttx bytes:\t2000000\n';
      return ''; // no FDB: WIRED is only known via the peer
    },
  });
  h.S.peers = {
    [PEER]: {
      mac: 'AA:BB:CC:DD:EE:03', name: 'SAP1', authed: true,
      clients: { [WIRED]: { mac: '00:11:22:33:44:55', type: 'wifi', rssi: -55, hostname: 'PC' } },
    },
  };
  const r = await h.clients.findClient(PHONE_RANDOM);
  assert.equal(r.node.mac, '12:34:56:78:9A:BC');
  assert.equal(r.ap, 'CAP');
  const r2 = await h.clients.findClient(WIRED);
  assert.equal(r2.ap, 'SAP1'); // only peer has it, as wifi
  assert.equal(await h.clients.findClient('001122334466'), null);
  h.cleanup();
});

// ------------------------------------------------------------ WOL
test('wolPacket: 6xFF + 16x MAC, 102 bytes', (t) => {
  const h = makeCtx();
  const pkt = h.clients.wolPacket(PHONE_RANDOM);
  assert.equal(pkt.length, 102);
  assert.deepEqual([...pkt.subarray(0, 6)], [255, 255, 255, 255, 255, 255]);
  assert.deepEqual([...pkt.subarray(6, 12)], [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc]);
  assert.deepEqual([...pkt.subarray(96, 102)], [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc]);
  h.cleanup();
});

test('wolSend: 2 targets on 255.255.255.255, 3rd on LAN broadcast', (t) => {
  const h = makeCtx();
  assert.equal(h.clients.wolSend(PHONE_RANDOM), 2);
  assert.deepEqual(h.wolSockets[0].sent.map((s) => s.port), [9, 7]);
  h.S.bcast = '192.168.12.255';
  assert.equal(h.clients.wolSend(PHONE_RANDOM), 3);
  assert.deepEqual(h.wolSockets[1].sent.map((s) => `${s.address}:${s.port}`),
    ['255.255.255.255:9', '255.255.255.255:7', '192.168.12.255:9']);
  h.cleanup();
});

// ------------------------------------------------------------ ban
test('banHm / banHmStr / banWeekdays (string, array, digits)', (t) => {
  const h = makeCtx();
  assert.equal(h.clients.banHm('22:00'), 1320);
  assert.equal(h.clients.banHm('7:5'), 425);
  assert.equal(h.clients.banHm('24:00'), null);
  assert.equal(h.clients.banHm('xx'), null);
  assert.equal(h.clients.banHmStr(1320), '22:00');
  assert.equal(h.clients.banHmStr(425), '07:05');
  assert.deepEqual(h.clients.banWeekdays('1 2 3 4 5'), [1, 2, 3, 4, 5]);
  assert.deepEqual(h.clients.banWeekdays([1, 2, 3]), [1, 2, 3]);
  assert.deepEqual(h.clients.banWeekdays('1234567'), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(h.clients.banWeekdays(''), []);
  assert.deepEqual(h.clients.banWeekdays('5 5 3 1'), [1, 3, 5]);
  h.cleanup();
});

function banCtx(overrides = {}) {
  const h = makeCtx(overrides);
  h.fakeUci.addSection('cfg00000001', 'ban', {
    mac: WIRED, name: '', timeon: '22:00', timeoff: '07:00', weekdays: '1 2 3 4 5 6 7',
  });
  return h;
}

test('banRead: defaults 22:00/07:00 + all week, name from alias, weekdays ARRAY', (t) => {
  const h = banCtx();
  h.S.aliases.map = { [WIRED]: { name: 'PC', icon: null, note: null } };
  const list = h.clients.banRead();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'PC');
  assert.deepEqual(list[0].weekdays, [1, 2, 3, 4, 5, 6, 7]); // ARRAY, not string
  assert.equal(h.S.ban.list.length, 1);
  const h2 = makeCtx();
  h2.fakeUci.addSection('cfg00000001', 'ban', { mac: WIRED, name: '', timeon: '', timeoff: '', weekdays: '' });
  const list2 = h2.clients.banRead();
  assert.equal(list2[0].timeon, '22:00');
  assert.equal(list2[0].timeoff, '07:00');
  assert.deepEqual(list2[0].weekdays, [1, 2, 3, 4, 5, 6, 7]);
  h.cleanup(); h2.cleanup();
});

test('banInWindow: normal, on==off all-day, cross-midnight prev day', (t) => {
  const h = makeCtx();
  const b = { weekdays: [1, 2, 3, 4, 5], timeon: '22:00', timeoff: '07:00' };
  assert.equal(h.clients.banInWindow(b, { wday: 1, hour: 23, min: 0 }, 1380), true);
  assert.equal(h.clients.banInWindow(b, { wday: 1, hour: 12, min: 0 }, 720), false);
  assert.equal(h.clients.banInWindow(b, { wday: 2, hour: 6, min: 0 }, 360), true); // Tue 06:00, Mon was a ban day
  assert.equal(h.clients.banInWindow(b, { wday: 6, hour: 6, min: 0 }, 360), true); // Sat 06:00, Fri 22:00-07:00 still running
  assert.equal(h.clients.banInWindow(b, { wday: 0, hour: 6, min: 0 }, 360), false); // Sun 06:00, Sat not a ban day
  const allDay = { weekdays: [1], timeon: '08:00', timeoff: '08:00' };
  assert.equal(h.clients.banInWindow(allDay, { wday: 1, hour: 3, min: 0 }, 180), true);
  assert.equal(h.clients.banInWindow(allDay, { wday: 2, hour: 3, min: 0 }, 180), false);
  const day = { weekdays: [1], timeon: '08:00', timeoff: '18:00' };
  assert.equal(h.clients.banInWindow(day, { wday: 1, hour: 9, min: 0 }, 540), true);
  assert.equal(h.clients.banInWindow(day, { wday: 1, hour: 18, min: 0 }, 1080), false);
  h.cleanup();
});

test('banApply: active set, nft script, sig dedupe, non-cap clears table', (t) => {
  const h = banCtx();
  h.S.ban.enabled = true;
  const macs = h.clients.banApply(true);
  assert.deepEqual(macs, [WIRED]);
  assert.deepEqual(Object.keys(h.S.ban.active), [WIRED]);
  const script = h.writtenFiles['/tmp/wifiroam-ban.nft'];
  assert.match(script, /add rule inet wifiroam_ban forward ether saddr 00:11:22:33:44:55 counter drop/);
  assert.ok(h.unlinkedFiles.includes('/tmp/wifiroam-ban.nft'));
  assert.ok(h.shellCmds.some((c) => c.includes('nft add table inet wifiroam_ban')));
  const nCmds = h.shellCmds.length;
  h.clients.banApply(false); // same sig: no rebuild
  assert.equal(h.shellCmds.length, nCmds);
  // role downgrade clears the table
  h.S.cfg.role = 'sap';
  h.clients.banApply(true);
  assert.ok(h.shellCmds.some((c) => c.includes('nft delete table inet wifiroam_ban')));
  assert.equal(h.S.ban.sig, '');
  h.cleanup();
});

test('banList returns weekdays ARRAY, blocked sorted, active from current time', (t) => {
  const h = banCtx();
  h.S.ban.enabled = true;
  h.clients.banApply(true); // fills S.ban.active
  const res = h.clients.banList();
  assert.equal(res.ok, true);
  assert.equal(res.error, '');
  assert.equal(res.enabled, true);
  assert.deepEqual(res.items[0].weekdays, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(res.items[0].active, true); // Mon 23:00 inside 22:00-07:00
  assert.deepEqual(res.blocked, [WIRED]);
  h.S.cfg.role = 'sap';
  assert.equal(h.clients.banList().ok, false);
  h.cleanup();
});

test('banSet writes UCI weekdays as space-joined STRING, merges duplicate sections', async (t) => {
  const h = makeCtx();
  h.fakeUci.addSection('cfg00000001', 'ban', { mac: WIRED, name: 'Old', timeon: '20:00', timeoff: '06:00', weekdays: '1 2' });
  h.fakeUci.addSection('cfg00000002', 'ban', { mac: WIRED, name: 'Dup', timeon: '20:00', timeoff: '06:00', weekdays: '1 2' });
  const r = await h.clients.banSet({ mac: WIRED, name: 'PC', timeon: '22:00', timeoff: '07:00', weekdays: '1 2 3 4 5' });
  assert.equal(r.ok, true);
  assert.equal(r.mac, WIRED);
  const kept = h.fakeUci.sections.get('cfg00000001');
  assert.equal(kept.weekdays, '1 2 3 4 5'); // STRING in UCI
  assert.equal(kept.timeon, '22:00');
  assert.equal(h.fakeUci.sections.get('cfg00000002'), undefined); // duplicate merged away
  assert.equal(h.S.ban.enabled, true); // first save defaults the master switch on
  assert.equal((await h.clients.banSet({ mac: 'bad', timeon: '22:00', timeoff: '07:00', weekdays: '1' })).ok, false);
  const badTime = await h.clients.banSet({ mac: WIRED, timeon: '25:00', timeoff: '07:00', weekdays: '1' });
  assert.equal(badTime.error, 'invalid_time');
  const badDays = await h.clients.banSet({ mac: WIRED, timeon: '22:00', timeoff: '07:00', weekdays: '' });
  assert.equal(badDays.error, 'invalid_weekdays');
  const h2 = makeCtx();
  h2.S.cfg.role = 'sap';
  assert.equal((await h2.clients.banSet({ mac: WIRED, timeon: '22:00', timeoff: '07:00', weekdays: '1' })).error, 'not_cap');
  h.cleanup(); h2.cleanup();
});

test('banSet fills empty name from findClient', async (t) => {
  const h = wifiCtx({
    leasesText: '1700000000 12:34:56:78:9A:BC 192.168.12.50 Phone-1 *\n',
  });
  const r = await h.clients.banSet({ mac: PHONE_RANDOM, name: '', timeon: '22:00', timeoff: '07:00', weekdays: '1 2 3 4 5' });
  assert.equal(r.ok, true);
  const sec = [...h.fakeUci.sections.values()].find((s) => s['.type'] === 'ban');
  assert.equal(sec.name, 'Phone-1');
  h.cleanup();
});

test('banDel: not_found, delete, master switch back to default off', async (t) => {
  const h = banCtx();
  assert.deepEqual(h.clients.banDel({ mac: '001122334466' }), { ok: false, error: 'not_found' });
  assert.deepEqual(h.clients.banDel({ mac: WIRED }), { ok: true });
  assert.equal(h.fakeUci.sections.size, 1); // only alias_sync left
  assert.equal(h.S.ban.enabled, false); // last rule gone -> default off
  h.cleanup();
});

test('banReloadEnabled: explicit config wins, else rule-count default; setBan creates schedule section', (t) => {
  const h = banCtx();
  assert.equal(h.clients.banReloadEnabled(), true); // rules exist, no explicit config
  h.fakeUci.addSection('schedule', 'schedule', { enabled: '0' });
  assert.equal(h.clients.banReloadEnabled(), false);
  const r = h.clients.setBan({ enabled: true });
  assert.deepEqual(r, { ok: true, enabled: true });
  assert.equal(h.fakeUci.uci.get('wifiroam', 'schedule', 'enabled'), '1');
  const h2 = makeCtx();
  assert.deepEqual(h2.clients.setBan({ enabled: true }), { ok: true, enabled: true });
  assert.equal(h2.fakeUci.uci.get('wifiroam', 'schedule', 'enabled'), '1'); // section auto-created
  h2.S.cfg.role = 'sap';
  assert.equal(h2.clients.setBan({ enabled: true }).error, 'not_cap');
  h.cleanup(); h2.cleanup();
});

// ------------------------------------------------------------ api handlers
test('wake: unknown_device / already_online / ok with sent count + colon MAC', async (t) => {
  const h = makeCtx();
  assert.deepEqual(await h.clients.wake({ mac: WIRED }), { ok: false, error: 'unknown_device' });
  h.S.devices[WIRED] = { mac: '00:11:22:33:44:55', online: true, first_seen: 1, last_online: 2 };
  assert.deepEqual(await h.clients.wake({ mac: WIRED }), { ok: false, error: 'already_online' });
  h.S.devices[WIRED].online = false;
  assert.deepEqual(await h.clients.wake({ mac: WIRED }), { ok: true, sent: 2, mac: '00:11:22:33:44:55' });
  h.cleanup();
});

test('clientDetail: INVALID_ARGUMENT=2, NOT_FOUND=4, ok shape', async (t) => {
  const h = wifiCtx();
  assert.equal(await h.clients.clientDetail({}), 2);
  assert.equal(await h.clients.clientDetail({ mac: '001122334466' }), 4);
  const r = await h.clients.clientDetail({ mac: '12:34:56:78:9A:BC' });
  assert.equal(r.ok, true);
  assert.equal(r.client.id, h.S.device_index[PHONE_RANDOM] ?? PHONE_RANDOM);
  assert.equal(r.ap, 'CAP');
  h.cleanup();
});

test('setAlias: SAP forwards to CAP; link_down on throw; local CAP path returns ver', (t) => {
  const h = makeCtx();
  h.S.cfg.role = 'sap';
  const deferCalls = [];
  h.S.link = { authed: true, chan: { defer: (method, data) => { deferCalls.push([method, data]); return Promise.resolve({}); } } };
  assert.deepEqual(h.clients.setAlias({ mac: PHONE_RANDOM, name: 'Phone', icon: null, note: null }),
    { ok: true, forwarded: true });
  assert.deepEqual(deferCalls[0], ['alias_update', { mac: PHONE_RANDOM, name: 'Phone', icon: null, note: null }]);
  h.S.link.chan.defer = () => { throw new Error('down'); };
  assert.deepEqual(h.clients.setAlias({ mac: PHONE_RANDOM, name: 'Phone' }), { ok: false, error: 'link_down' });
  assert.equal(h.sapDisconnectCalls, 1);
  const h2 = makeCtx();
  const r = h2.clients.setAlias({ mac: PHONE_RANDOM, name: 'Phone', icon: null, note: null });
  assert.equal(r.ok, true);
  assert.equal(r.ver, h2.S.aliases.ver);
  assert.equal(h2.aliasBroadcastCalls.length, 1);
  assert.equal(h2.clients.setAlias({ mac: '' }), 2); // STATUS_INVALID_ARGUMENT
  h.cleanup(); h2.cleanup();
});

test('setPin: SAP forwards pin_update; local unknown_ap', (t) => {
  const h = makeCtx();
  h.S.cfg.role = 'sap';
  const deferCalls = [];
  h.S.link = { authed: true, chan: { defer: (method, data) => { deferCalls.push([method, data]); return Promise.resolve({}); } } };
  assert.deepEqual(h.clients.setPin({ mac: PHONE_RANDOM, ap: SELF }), { ok: true, forwarded: true });
  assert.deepEqual(deferCalls[0], ['pin_update', { mac: PHONE_RANDOM, ap: SELF }]);
  const h2 = makeCtx();
  assert.equal(h2.clients.setPin({ mac: PHONE_RANDOM, ap: 'aabbccddee99' }).error, 'unknown_ap');
  assert.deepEqual(h2.clients.setPin({ mac: PHONE_RANDOM, ap: SELF }), { ok: true, mac: PHONE_RANDOM, ap: SELF });
  h.cleanup(); h2.cleanup();
});

test('ungroupDevice: not_cap / invalid_mac / ok runs policy hooks + banApply', async (t) => {
  const h = makeCtx();
  h.S.aliases.groups = { gaaaaaaaaaaaa: { created: 1, members: { [PHONE_RANDOM]: {} } } };
  h.S.device_index = { [PHONE_RANDOM]: 'gaaaaaaaaaaaa' };
  h.S.cfg.role = 'sap';
  assert.equal((await h.clients.ungroupDevice({ mac: PHONE_RANDOM })).error, 'not_cap');
  h.S.cfg.role = 'cap';
  assert.equal((await h.clients.ungroupDevice({ mac: 'bad' })).error, 'invalid_mac');
  h.S.appctl.enabled = true;
  const r = await h.clients.ungroupDevice({ mac: '12:34:56:78:9A:BC' });
  assert.equal(r.ok, true);
  assert.deepEqual(h.appctlCalls, ['read_devices', 'apply_rules', 'dpi:reload']);
  assert.ok(h.shellCmds.some((c) => c.includes('wifiroam_ban')));
  h.cleanup();
});

test('topology / deviceHistory handlers delegate to build/devlist', async (t) => {
  const h = wifiCtx();
  const topo = await h.clients.topology();
  assert.equal(topo.nodes.filter((n) => n.type === 'client').length, 2); // phone + wired
  const hist = await h.clients.deviceHistory();
  assert.equal(hist.devices.length, 2); // phone (wifi) + wired PC from FDB
  assert.equal(hist.devices[0].online, true);
  h.cleanup();
});

test('no Node 22.23.4-banned APIs in clients.mjs', (t) => {
  const src = readFileSync(new URL('../daemon/clients.mjs', import.meta.url), 'utf8');
  for (const banned of ['Promise.try', 'RegExp.escape', 'Float16Array', 'Error.isError', 'Atomics.pause', 'URLPattern']) {
    assert.equal(src.includes(banned), false, `banned API present: ${banned}`);
  }
  assert.equal(/^\s*using\s/m.test(src), false, 'using declaration present');
});
