// daemon-core.test.mjs -- node:test suite for daemon/core.mjs + wifiroamd.mjs.
// ubus/uci/shell are all mocked; no real ubusd, no router, no network
// beyond localhost is required.
//
// Coverage: state initial values, timer registration, api_obj dispatch
// table (all 31 methods), start/stop flow, pair channel flow.
// The business modules (discovery/clients/wifi/guest/policy) do not
// exist yet, so they are injected as stubs through createDaemon({ modules }).
//
// Run: node --test tests/daemon-core.test.mjs   (from ~/workspace/wifiroam-js)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  API_ARGS,
  API_METHODS,
  APP_DEFS,
  DAEMON_VERSION,
  HELLO_INTERVAL,
  MAX_EVENTS,
  TCP_PORT,
  TICK_INTERVAL,
  UDP_PORT,
  buildApiHandlers,
  buildApiObject,
  createDaemon,
  createState,
  loadConfig,
  localtimeNow,
  pushEvent,
  reconfigure,
  roamDefaultInit,
  saveConfig,
} from '../daemon/core.mjs';
import { macnorm, setLogWriter } from '../lib/util.js';
import { UBUS_STATUS } from '../lib/ubus.js';

// Silence daemon logs during tests; individual tests install their own writer.
const silenceLogs = () => {};
setLogWriter(silenceLogs);

// ------------------------------------------------------------------ mocks
class MockUci {
  constructor() {
    this.pkgs = new Map(); // pkg -> Map(sectionName -> section)
    this.commits = [];
    this.counter = 0;
  }
  _pkg(pkg) {
    if (!this.pkgs.has(pkg)) this.pkgs.set(pkg, new Map());
    return this.pkgs.get(pkg);
  }
  seed(pkg, section, type, opts = {}) {
    const sec = { '.name': section, '.type': type, ...opts };
    this._pkg(pkg).set(section, sec);
    return sec;
  }
  load(_pkg) { return true; }
  get(pkg, section, option) {
    const sec = this._pkg(pkg).get(section);
    if (!sec) return null;
    if (option === undefined) return sec;
    const v = sec[option];
    return v === undefined ? null : v;
  }
  set(pkg, section, option, value) {
    if (value === undefined) {
      // 3-arg: create a section of the given type.
      if (!this._pkg(pkg).has(section)) {
        this._pkg(pkg).set(section, { '.name': section, '.type': option });
      }
      return true;
    }
    const sec = this._pkg(pkg).get(section);
    if (!sec) return false;
    sec[option] = value;
    return true;
  }
  add(pkg, type) {
    this.counter += 1;
    const sid = `cfg${String(this.counter).padStart(6, '0')}`;
    this._pkg(pkg).set(sid, { '.name': sid, '.type': type });
    return sid;
  }
  delete(pkg, section, option) {
    const map = this._pkg(pkg);
    if (option === undefined) return map.delete(section);
    const sec = map.get(section);
    if (!sec) return false;
    delete sec[option];
    return true;
  }
  commit(pkg) { this.commits.push(pkg); return true; }
  foreach(pkg, type, cb) {
    let n = 0;
    for (const sec of this._pkg(pkg).values()) {
      if (sec['.type'] === type) { cb(sec); n += 1; }
    }
    return n;
  }
}

function seedUci(uci) {
  uci.seed('wifiroam', 'core', 'globals', { enabled: '1', role: 'cap', token: 'tok123', cap_ip: '', name: 'cap1' });
  uci.seed('wifiroam', 'roam', 'roam', { enabled: '1', config_ver: '1', ssids: ['HomeWiFi'], rssi_profile: 'balanced', rssi_threshold: '-70' });
  uci.seed('wifiroam', 'backhaul', 'backhaul', { enabled: '0', ssid: 'wifiroam-bh', key: '', device: '', config_ver: '0' });
  uci.seed('wifiroam', 'guest', 'guest', { enabled: '0', ssid: 'Guest', key: '', bandwidth: '0', schedule: '0', start: '08:00', end: '23:00', allow_lan: '0', config_ver: '0' });
  uci.seed('wifiroam', 'alias_sync', 'alias_sync', { ver: '0' });
  uci.seed('firewall', '@defaults[0]', 'defaults', { flow_offloading: '0', flow_offloading_hw: '0' });
  uci.seed('wireless', 'default_radio0', 'wifi-iface', { mode: 'ap', ssid: 'OldSSID', key: 'oldkey123' });
  return uci;
}

function makeModules(ref) {
  const rec = (name) => (...args) => { ref.calls.push([name, ...args]); };
  const clients = {
    aliasLoad: rec('clients.aliasLoad'),
    aliasSave: rec('clients.aliasSave'),
    aliasApply: () => (ref.aliasApplyResult ?? true),
    pinApply: (mac, ap) => ({ ok: true, mac: macnorm(mac), ap }),
    deviceKey: (v) => (/^g[0-9a-f]{12}$/.test(v ?? '') ? v : macnorm(v)),
    deviceMembersOf: () => (ref.members ?? ['aabbccddeeff']),
    deviceUngroup: () => ({ ok: true, mac: 'aabbccddeeff' }),
    findClient: () => (ref.findClientResult ?? null),
    localClients: () => (ref.localClients ?? {}),
    buildTopology: () => ({ nodes: [], self: 'aabbccddeeff', role: 'cap', now: 123 }),
    devlistLoad: rec('clients.devlistLoad'),
    devlistTick: (...a) => { rec('clients.devlistTick')(...a); return {}; },
    devlistView: () => ({ now: 0, devices: [], aps: [] }),
    deviceGroupRefresh: rec('clients.deviceGroupRefresh'),
    deviceReindex: rec('clients.deviceReindex'),
    deviceAliasOf: () => null,
    parseLeases: () => ({}),
    clientNames: () => ({}),
    clientNameOf: (mn) => mn,
    apDisplay: (mn) => mn,
    banApply: (force) => { ref.calls.push(['clients.banApply', force]); },
    banLoad: rec('clients.banLoad'),
    banTick: rec('clients.banTick'),
    pinOf: () => null,
    banRead: () => (ref.banRead ?? []),
    banInWindow: () => false,
    banHm: (v) => {
      if (typeof v !== 'string') return null;
      const m = /^(\d{1,2}):(\d{2})$/.exec(v);
      if (!m) return null;
      const h = Number(m[1]); const mi = Number(m[2]);
      if (h > 23 || mi > 59) return null;
      return h * 60 + mi;
    },
    banHmStr: (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`,
    banWeekdays: (v) => {
      if (!v) return [];
      return [...new Set(String(v).split(/[\s,]+/).filter(Boolean).map(Number).filter((n) => n >= 0 && n <= 6))].sort((a, b) => a - b);
    },
    banReloadEnabled: (...a) => { rec('clients.banReloadEnabled')(...a); return true; },
    diffEvents: rec('clients.diffEvents'),
    ownerEvents: rec('clients.ownerEvents'),
    wolSend: () => (ref.wolSendResult ?? 1),
  };
  const wifi = {
    detectSelf: () => {
      Object.assign(ref.daemon.S.self, {
        mac: 'AA:BB:CC:DD:EE:FF', ip: '192.168.12.1', name: 'cap1',
        hostname: 'cap1', model: 'TestModel', firmware: '1.0',
      });
    },
    selfUptime: () => 12345,
    currentRoamCfg: () => ({
      enabled: true, ssids: ['HomeWiFi'], r_fast: true, ft_mode: 'simple',
      ft_over_ds: true, k_neighbor: true, k_beacon: true, v_bss_transition: true,
      rssi_profile: 'balanced', rssi_threshold: -70, config_ver: 1,
    }),
    currentBackhaulCfg: () => ({ enabled: false, ssid: 'wifiroam-bh', key: '', device: '', mode: 'relay', config_ver: 0 }),
    backhaulMode: (m) => (m === 'wds' ? 'wds' : 'relay'),
    rssiPreset: (p) => ({ aggressive: -62, balanced: -70, conservative: -78 }[p] ?? -70),
    memberList: () => [],
    ssidGroups: () => [],
    appliedKvr: () => ({}),
    applyRoamLocal: (...a) => { rec('wifi.applyRoamLocal')(...a); return { ok: true, ver: 1 }; },
    applyBackhaulLocal: (...a) => { rec('wifi.applyBackhaulLocal')(...a); return { ok: true, ver: 1 }; },
    applyWifiLocal: (...a) => { rec('wifi.applyWifiLocal')(...a); return { ok: true }; },
    wifiSummary: () => ({ ifaces: [{ band: '2g', ssid: 'OldSSID', key: 'oldkey123' }] }),
    wifiRadios: () => [{ name: 'radio0' }],
    wifiIfaces: () => (ref.wifiIfaces ?? [{ ssid: 'HomeWiFi', band: '2g' }]),
    roamRenameSsids: rec('wifi.roamRenameSsids'),
    precheck: () => ({ checks: [], groups: [], role: 'cap', aps: [] }),
    roamSig: () => 'sig',
    selfInfo: () => ({}),
    apOverview: () => ({}),
    bssPublic: () => [],
    detectUplink: () => ({ type: 'wired' }),
    backhaulTick: rec('wifi.backhaulTick'),
    steerTick: rec('wifi.steerTick'),
    pinTick: rec('wifi.pinTick'),
  };
  const guest = {
    guestCfg: () => (ref.guestCfg ?? {
      enabled: false, ssid: 'Guest', key: '', bandwidth: 0,
      schedule: false, start: '08:00', end: '23:00', allow_lan: false, ver: 0,
    }),
    guestSummary: () => ({ enabled: false, open: false }),
    guestSaveLocal: () => (ref.guestSaveResult ?? true),
    applyGuestLocal: (...a) => { rec('guest.applyGuestLocal')(...a); return { ok: true }; },
    guestTick: rec('guest.guestTick'),
  };
  const policy = {
    appctlLoad: rec('policy.appctlLoad'),
    appctlTick: rec('policy.appctlTick'),
    appctlReadDevices: () => (ref.appctlDevices ?? {}),
    appctlWriteDevice: rec('policy.appctlWriteDevice'),
    appctlApp: (id) => (id === 'wechat' ? { id: 'wechat', name: '微信' } : null),
    appctlApplyRules: rec('policy.appctlApplyRules'),
    appctlDpiDaemon: (a) => { ref.calls.push(['policy.appctlDpiDaemon', a]); },
    appctlDnsmasqSync: () => (ref.dnsmasqDirty ?? false),
    appctlNftSchema: () => (ref.nftSchemaChanged ?? false),
    appctlDnslockApply: rec('policy.appctlDnslockApply'),
    appctlHwSuspend: rec('policy.appctlHwSuspend'),
    appctlTableRemove: rec('policy.appctlTableRemove'),
    appctlPublicStats: () => ({}),
    appctlPublicDays: () => ({}),
    offloadApply: (on) => { ref.calls.push(['policy.offloadApply', on]); return ref.offloadApplyResult ?? true; },
    offloadRequestCap: rec('policy.offloadRequestCap'),
  };
  const discovery = {
    setupUdp: rec('discovery.setupUdp'),
    setupTcp: rec('discovery.setupTcp'),
    sendHello: rec('discovery.sendHello'),
    expireTick: rec('discovery.expireTick'),
    sapTick: rec('discovery.sapTick'),
    sapReport: rec('discovery.sapReport'),
    sapDisconnect: rec('discovery.sapDisconnect'),
    aliasBroadcast: rec('discovery.aliasBroadcast'),
    pushRoamTo: (mn) => { ref.calls.push(['discovery.pushRoamTo', mn]); },
    pushBackhaulTo: (mn) => { ref.calls.push(['discovery.pushBackhaulTo', mn]); },
    pushWifiTo: (mn, ssids) => { ref.calls.push(['discovery.pushWifiTo', mn, ssids]); },
    pushGuestTo: (mn, cfg) => { ref.calls.push(['discovery.pushGuestTo', mn, cfg]); },
    pushOffloadTo: (mn) => { ref.calls.push(['discovery.pushOffloadTo', mn]); },
    stop: rec('discovery.stop'),
  };
  return { discovery, clients, wifi, guest, policy };
}

async function makeDaemon(overrides = {}) {
  const ref = { daemon: null, calls: [] };
  const uci = seedUci(new MockUci());
  const bus = {
    added: null, closed: false,
    async addObject(path, methods) {
      this.added = { path, methods };
      ref.calls.push(['bus.addObject', path]);
      return { id: 99, type: 0 };
    },
    close() { this.closed = true; ref.calls.push(['bus.close']); },
  };
  const exitCodes = [];
  const daemon = await createDaemon({
    uci,
    modules: makeModules(ref),
    ubusConnect: async () => bus,
    exitFn: (c) => { exitCodes.push(c); },
    createChannel: overrides.createChannel,
  });
  ref.daemon = daemon;
  ref.uci = uci;
  ref.bus = bus;
  ref.exitCodes = exitCodes;
  // Handler tests run as cap with a known self identity.
  daemon.S.cfg = { enabled: true, role: 'cap', token: 'tok123', cap_ip: '', name: 'cap1' };
  daemon.S.self = {
    mac: 'AA:BB:CC:DD:EE:FF', ip: '192.168.12.1', name: 'cap1',
    hostname: 'cap1', model: 'TestModel', firmware: '1.0',
  };
  return ref;
}

function callNames(ref) { return ref.calls.map((c) => c[0]); }

// ------------------------------------------------------------------ state
test('createState: initial values match the original state literal', () => {
  const S = createState();
  assert.deepEqual(S.cfg, {});
  assert.deepEqual(S.self, {});
  assert.equal(S.brdev, 'br-lan');
  assert.deepEqual(S.peers, {});
  assert.deepEqual(S.discovered, {});
  assert.deepEqual(S.aliases, { ver: 0, map: {}, groups: {}, redirect: {}, isolated: {}, pin: {} });
  assert.deepEqual(S.pin_last, {});
  assert.deepEqual(S.devices, {});
  assert.equal(S.dev_dirty, false);
  assert.equal(S.dev_saved, 0);
  assert.deepEqual(S.device_index, {});
  assert.deepEqual(S.device_obs, {});
  assert.equal(S.link, null);
  assert.equal(S.cap_learned, null);
  assert.deepEqual(S.events, []);
  assert.equal(S.last_apply, null);
  assert.equal(S.last_backhaul, null);
  assert.equal(S.last_wifi, null);
  assert.equal(S.last_guest, null);
  assert.equal(S.guest_open, null);
  assert.equal(S.guest_tc_sig, '');
  assert.deepEqual(S.guest_tc_devs, []);
  assert.equal(S._guest_nft_sig, '');
  assert.equal(S._guest_zone_migrated, false);
  assert.deepEqual(S.client_seen, {});
  assert.deepEqual(S.client_bytes, {});
  assert.deepEqual(S.bytes_cache, {});
  assert.equal(S.prev_clients, null);
  assert.deepEqual(S.wired_seen, {});
  assert.deepEqual(S.wifi_seen, {});
  assert.equal(S.prev_owner, null);
  assert.equal(S.roam_ver_applied, 0);
  assert.equal(S.backhaul_ver_applied, 0);
  assert.deepEqual(S.steer_last, {});
  assert.deepEqual(S.steer_tries, {});
  assert.deepEqual(S.kick_last, {});
  assert.deepEqual(S.steer_mute, {});
  assert.equal(S.nr_sig, '');
  assert.deepEqual(S.cap_nr, []);
  assert.deepEqual(S.net_names, {});
  assert.equal(S.roster, null);
  assert.deepEqual(S.appctl, { enabled: false, enhanced: false, strict: false, devices: {}, stats: {}, day: '', online: {}, ndata: {} });
  assert.deepEqual(S.ban, { enabled: false, list: [], sig: '', active: {} });
  assert.equal(S._nft_snap, null);
  assert.equal(S._dnslock_on, null);
  assert.equal(S._appstat_ts, 0);
  assert.equal(S._appstat_dirty, false);
  assert.equal(S._appstat_saved, 0);
  assert.equal(S._track_key, '');
  assert.equal(S._warm_list, null);
  assert.equal(S._warm_i, 0);
});

test('createState: each call returns independent objects', () => {
  const a = createState();
  const b = createState();
  a.peers.x = 1;
  a.aliases.map.y = 2;
  a.appctl.devices.z = 3;
  assert.deepEqual(b.peers, {});
  assert.deepEqual(b.aliases.map, {});
  assert.deepEqual(b.appctl.devices, {});
});

test('constants: DAEMON_VERSION=5 and timer/transport constants', () => {
  assert.equal(DAEMON_VERSION, 5);
  assert.equal(UDP_PORT, 50607);
  assert.equal(TCP_PORT, 50608);
  assert.equal(HELLO_INTERVAL, 5000);
  assert.equal(TICK_INTERVAL, 10000);
  assert.equal(MAX_EVENTS, 100);
  assert.equal(APP_DEFS.length, 47); // 源码实测 47 项；spec 附录 C 所称 44 有误
  assert.equal(APP_DEFS[0].id, 'wechat');
  assert.equal(APP_DEFS.find((a) => a.id === 'qq').domains.length, 0);
});

test('localtimeNow: returns local clock fields', () => {
  const lt = localtimeNow(new Date(2026, 10, 15, 22, 30, 5));
  assert.equal(lt.hour, 22);
  assert.equal(lt.min, 30);
  assert.equal(lt.sec, 5);
  assert.equal(lt.wday, new Date(2026, 10, 15).getDay());
});

// ------------------------------------------------------------------ config
test('loadConfig/saveConfig: round-trip through UCI', async () => {
  const ref = await makeDaemon();
  const { daemon, uci } = ref;
  loadConfig(daemon.S, uci);
  assert.equal(daemon.S.cfg.role, 'cap');
  assert.equal(daemon.S.cfg.token, 'tok123');
  assert.equal(daemon.S.cfg.enabled, true);
  assert.equal(daemon.S.cfg.name, 'cap1');
  assert.equal(daemon.S.roam_ver_applied, 1);
  assert.equal(daemon.S.backhaul_ver_applied, 0);
  // alias_sync.ver larger than memory raises the memory value.
  uci.seed('wifiroam', 'alias_sync', 'alias_sync', { ver: '7' });
  loadConfig(daemon.S, uci);
  assert.equal(daemon.S.aliases.ver, 7);

  daemon.S.cfg.role = 'unconfigured';
  daemon.S.cfg.token = '';
  saveConfig(daemon.S, uci);
  assert.equal(uci.get('wifiroam', 'core', 'role'), 'unconfigured');
  assert.equal(uci.get('wifiroam', 'core', 'token'), '');
  assert.ok(uci.commits.includes('wifiroam'));
});

test('pushEvent: appends, caps at MAX_EVENTS, logs', () => {
  const logs = [];
  setLogWriter((s) => logs.push(s));
  try {
    const S = createState();
    for (let i = 0; i < 105; i++) pushEvent(S, 'roam_move', 'aabbccddeeff', `info${i}`, 'dev');
    assert.equal(S.events.length, 100);
    assert.equal(S.events[0].info, 'info5');
    assert.equal(S.events[99].info, 'info104');
    assert.equal(S.events[99].type, 'roam_move');
    assert.equal(typeof S.events[99].ts, 'number');
    assert.ok(logs.some((l) => l.includes('event roam_move aabbccddeeff dev info104')));
  } finally {
    setLogWriter(silenceLogs);
  }
});

test('reconfigure: reloads config, clears peer/steer state, re-hellos, re-applies ban', async () => {
  const ref = await makeDaemon();
  const { daemon, uci } = ref;
  daemon.S.peers = { aabbccddeeff: { authed: true } };
  daemon.S.cap_learned = '192.168.12.2';
  daemon.S.prev_clients = { x: 1 };
  daemon.S.prev_owner = { y: 1 };
  daemon.S.steer_last = { z: 1 };
  daemon.S.cap_nr = [{ bssid: 'x' }];
  daemon.S.cfg.name = '';
  uci.seed('wifiroam', 'core', 'globals', { enabled: '1', role: 'cap', token: 'tok123', cap_ip: '', name: '' });
  reconfigure(daemon.S, daemon);
  assert.deepEqual(daemon.S.peers, {});
  assert.equal(daemon.S.cap_learned, null);
  assert.equal(daemon.S.prev_clients, null);
  assert.equal(daemon.S.prev_owner, null);
  assert.deepEqual(daemon.S.steer_last, {});
  assert.deepEqual(daemon.S.cap_nr, []);
  assert.equal(daemon.S.self.name, 'cap1'); // cfg.name empty -> hostname
  const names = callNames(ref);
  assert.ok(names.includes('discovery.sapDisconnect'));
  assert.ok(names.includes('discovery.sendHello'));
  assert.deepEqual(ref.calls.find((c) => c[0] === 'clients.banApply'), ['clients.banApply', true]);
});

test('roamDefaultInit: no-op when config_ver != 0; defaults when ver 0 + enabled + no ssids', async () => {
  const ref = await makeDaemon();
  const { daemon, uci } = ref;
  // Seeded config_ver is 1 -> no-op.
  roamDefaultInit(daemon.S, daemon);
  assert.equal(daemon.S.last_apply, null);
  assert.ok(!callNames(ref).includes('wifi.applyRoamLocal'));

  // ver 0, enabled, empty ssids -> pick up local SSIDs and apply once.
  uci.seed('wifiroam', 'roam', 'roam', { enabled: '1', config_ver: '0', ssids: [] });
  ref.wifiIfaces = [{ ssid: 'HomeWiFi', band: '2g' }, { ssid: 'HomeWiFi', band: '5g' }, { ssid: '', band: '5g' }];
  roamDefaultInit(daemon.S, daemon);
  assert.deepEqual(uci.get('wifiroam', 'roam', 'ssids'), ['HomeWiFi']);
  assert.equal(uci.get('wifiroam', 'roam', 'config_ver'), '1');
  assert.equal(daemon.S.last_apply.ver, 1);
  assert.equal(daemon.S.last_apply.results[0].ok, true);
  assert.ok(callNames(ref).includes('wifi.applyRoamLocal'));
});

// ------------------------------------------------------------------ timers
test('registerTimers: 12 intervals, 1x5000ms + 11x10000ms, in original order', async () => {
  const ref = await makeDaemon();
  const { daemon } = ref;
  const timers = daemon.registerTimers();
  try {
    assert.equal(timers.length, 12);
    assert.deepEqual(timers.map((t) => t.name), [
      'send_hello', 'sap_tick', 'sap_report', 'expire_tick', 'backhaul_tick',
      'steer_tick', 'pin_tick', 'guest_tick', 'appctl_tick', 'ban_tick',
      'devlist_tick', 'cap_clients_tick',
    ]);
    assert.equal(timers[0].ms, 5000);
    assert.ok(timers.slice(1).every((t) => t.ms === 10000));
    // Invoking the stored fns drives the module ticks (no waiting).
    timers[1].fn(); timers[4].fn(); timers[7].fn(); timers[9].fn(); timers[10].fn();
    const names = callNames(ref);
    for (const n of ['discovery.sapTick', 'wifi.backhaulTick', 'guest.guestTick', 'clients.banTick', 'clients.devlistTick']) {
      assert.ok(names.includes(n), `expected ${n}`);
    }
    // cap_clients_tick: non-cap returns early; as cap it diffs + owner events.
    daemon.S.prev_clients = { a: 1 };
    await timers[11].fn();
    assert.ok(callNames(ref).includes('clients.diffEvents'));
    assert.ok(callNames(ref).includes('clients.ownerEvents'));
  } finally {
    daemon.stop();
  }
});

test('registerTimers: a throwing tick is logged, not fatal', async () => {
  const ref = await makeDaemon();
  const { daemon } = ref;
  daemon.modules.clients.banTick = () => { throw new Error('boom'); };
  const logs = [];
  setLogWriter((s) => logs.push(s));
  try {
    daemon.registerTimers();
    const banTimer = daemon.timers.find((t) => t.name === 'ban_tick');
    banTimer.fn();
    assert.ok(logs.some((l) => l.includes('tick ban_tick failed: boom')));
  } finally {
    setLogWriter(silenceLogs);
    daemon.stop();
  }
});

// ------------------------------------------------------------------ api table
test('api dispatch table: exactly the 31 original methods, in order, with args', async () => {
  const ref = await makeDaemon();
  const handlers = buildApiHandlers(ref.daemon);
  assert.deepEqual(Object.keys(handlers), API_METHODS);
  assert.equal(API_METHODS.length, 31);
  for (const name of API_METHODS) {
    assert.equal(typeof handlers[name], 'function', name);
    assert.ok(API_ARGS[name], `missing API_ARGS for ${name}`);
    assert.equal(API_ARGS[name].ubus_rpc_session, 'string', name);
  }
  // Spot-check signatures that carry the whitelist (spec §3.1).
  assert.deepEqual(Object.keys(API_ARGS.set_roam).sort(), [
    'enabled', 'ft_mode', 'ft_over_ds', 'k_beacon', 'k_neighbor',
    'r_fast', 'rssi_profile', 'rssi_threshold', 'ssids', 'ubus_rpc_session', 'v_bss_transition',
  ].sort());
  assert.equal(API_ARGS.set_appctl.strict, 'string');
  assert.equal(API_ARGS.roam_log.limit, 'int');
});

test('buildApiObject: ubus shape { handler, args }; integer status becomes no DATA', async () => {
  const ref = await makeDaemon();
  const obj = buildApiObject(ref.daemon);
  assert.deepEqual(Object.keys(obj), API_METHODS);
  assert.equal(typeof obj.status.handler, 'function');
  assert.deepEqual(obj.status.args, API_ARGS.status);
  // client_detail without mac returns INVALID_ARGUMENT (2) in the
  // dispatch table, but the ubus wrapper must not send it as DATA.
  const noData = await obj.client_detail.handler({ data: {} });
  assert.equal(noData, undefined);
  const ok = await obj.client_detail.handler({ data: { mac: 'AA:BB:CC:DD:EE:FF' } });
  // findClient stub returns null -> NOT_FOUND (4) -> also no DATA.
  assert.equal(ok, undefined);
  ref.findClientResult = { node: { id: 'g1234567890ab' }, ap: 'aabbccddeeff' };
  const found = await obj.client_detail.handler({ data: { mac: 'AA:BB:CC:DD:EE:FF' } });
  assert.equal(found.ok, true);
});

// ------------------------------------------------------------------ handlers
test('status: version 5, counts, SAP roster branch', async () => {
  const ref = await makeDaemon();
  const { daemon } = ref;
  const h = buildApiHandlers(daemon);
  daemon.S.peers = {
    aabbccddeeff: { authed: true, clients: { '001122334455': {} } },
    112233445566: { authed: false, clients: { '001122334455': {}, aabbccddeeff: {} } },
  };
  ref.localClients = { '001122334455': {}, '66778899aabb': {} };
  const st = await h.status({});
  assert.equal(st.version, 5);
  assert.equal(st.role, 'cap');
  assert.equal(st.peers_online, 1);
  assert.equal(st.peers_total, 2);
  assert.equal(st.clients_total, 3); // device_key dedup over peers + local
  assert.equal(st.cap_ip, null);
  assert.equal(st.alias_ver, 0);
  assert.equal(st.uptime, 12345);

  // SAP: roster overrides peer counting, self excluded.
  daemon.S.cfg.role = 'sap';
  daemon.S.roster = { aps: [
    { id: 'aabbccddeeff', online: true }, // self -> skipped
    { id: '112233445566', online: true },
    { id: '223344556677', online: false },
  ] };
  const st2 = await h.status({});
  assert.equal(st2.peers_online, 1);
  assert.equal(st2.peers_total, 2);
});

test('topology / device_history / precheck / get_backhaul / get_guest delegate', async () => {
  const ref = await makeDaemon();
  const h = buildApiHandlers(ref.daemon);
  assert.deepEqual(h.topology({}), { nodes: [], self: 'aabbccddeeff', role: 'cap', now: 123 });
  assert.deepEqual(h.device_history({}), { now: 0, devices: [], aps: [] });
  assert.deepEqual(h.precheck({}), { checks: [], groups: [], role: 'cap', aps: [] });
  assert.deepEqual(h.get_backhaul({}), {
    backhaul: { enabled: false, ssid: 'wifiroam-bh', key: '', device: '', mode: 'relay', config_ver: 0 },
    radios: [{ name: 'radio0' }],
    self: { mac: 'AA:BB:CC:DD:EE:FF', name: 'cap1' },
  });
  assert.deepEqual(h.get_guest({}), { enabled: false, open: false });
  const gw = h.get_wifi({});
  assert.equal(gw.role, 'cap');
  assert.equal(gw.last, null);
});

test('wake: unknown / already_online / invalid members / success', async () => {
  const ref = await makeDaemon();
  const { daemon } = ref;
  const h = buildApiHandlers(daemon);
  assert.deepEqual(h.wake({ mac: 'AA:BB:CC:DD:EE:FF' }), { ok: false, error: 'unknown_device' });
  daemon.S.devices = { aabbccddeeff: { online: true } };
  assert.deepEqual(h.wake({ mac: 'AA:BB:CC:DD:EE:FF' }), { ok: false, error: 'already_online' });
  daemon.S.devices = { aabbccddeeff: { online: false } };
  ref.members = [];
  assert.deepEqual(h.wake({ mac: 'AA:BB:CC:DD:EE:FF' }), { ok: false, error: 'invalid_mac' });
  ref.members = ['aabbccddeeff', '112233445566'];
  ref.wolSendResult = 1;
  assert.deepEqual(h.wake({ mac: 'AA:BB:CC:DD:EE:FF' }), { ok: true, sent: 2, mac: 'AA:BB:CC:DD:EE:FF' });
  ref.wolSendResult = 0;
  assert.deepEqual(h.wake({ mac: 'AA:BB:CC:DD:EE:FF' }), { ok: false, error: 'send_failed' });
});

test('client_detail: missing mac -> INVALID_ARGUMENT, missing client -> NOT_FOUND', async () => {
  const ref = await makeDaemon();
  const h = buildApiHandlers(ref.daemon);
  assert.equal(await h.client_detail({}), UBUS_STATUS.INVALID_ARGUMENT);
  assert.equal(await h.client_detail({ mac: 'AA:BB:CC:DD:EE:FF' }), UBUS_STATUS.NOT_FOUND);
});

test('set_alias / set_pin: SAP forwards, CAP applies locally + broadcasts', async () => {
  const ref = await makeDaemon();
  const { daemon } = ref;
  const h = buildApiHandlers(daemon);
  // CAP path.
  assert.deepEqual(h.set_alias({ mac: 'AA:BB:CC:DD:EE:FF', name: 'TV', icon: '', note: '' }), { ok: true, ver: 0 });
  assert.ok(callNames(ref).includes('discovery.aliasBroadcast'));
  assert.deepEqual(h.set_pin({ mac: 'AA:BB:CC:DD:EE:FF', ap: 'aabbccddeeff' }), { ok: true, mac: 'aabbccddeeff', ap: 'aabbccddeeff' });
  assert.equal(h.set_alias({}), UBUS_STATUS.INVALID_ARGUMENT);
  assert.equal(h.set_pin({}), UBUS_STATUS.INVALID_ARGUMENT);
  ref.aliasApplyResult = false;
  assert.deepEqual(h.set_alias({ mac: 'AA:BB:CC:DD:EE:FF' }), { ok: false, error: 'invalid_mac' });

  // SAP path: forward, no local apply.
  daemon.S.cfg.role = 'sap';
  let forwarded = null;
  daemon.S.link = { authed: true, chan: { defer: (method, data) => { forwarded = [method, data]; return Promise.resolve({ status: 0 }); } } };
  assert.deepEqual(h.set_alias({ mac: 'AA:BB:CC:DD:EE:FF', name: 'TV' }), { ok: true, forwarded: true });
  assert.deepEqual(forwarded, ['alias_update', { mac: 'AA:BB:CC:DD:EE:FF', name: 'TV', icon: undefined, note: undefined }]);
  assert.deepEqual(h.set_pin({ mac: 'AA:BB:CC:DD:EE:FF', ap: '' }), { ok: true, forwarded: true });

  // SAP forward throws synchronously -> sapDisconnect + link_down.
  daemon.S.link.chan = { defer: () => { throw new Error('dead'); } };
  assert.deepEqual(h.set_alias({ mac: 'AA:BB:CC:DD:EE:FF' }), { ok: false, error: 'link_down' });
  assert.ok(callNames(ref).includes('discovery.sapDisconnect'));
});

test('ungroup_device: not_cap / invalid_mac / success side effects', async () => {
  const ref = await makeDaemon();
  const { daemon } = ref;
  const h = buildApiHandlers(daemon);
  daemon.S.cfg.role = 'sap';
  assert.deepEqual(await h.ungroup_device({ mac: 'AA:BB:CC:DD:EE:FF' }), { ok: false, error: 'not_cap' });
  daemon.S.cfg.role = 'cap';
  assert.deepEqual(await h.ungroup_device({ mac: 'xyz' }), { ok: false, error: 'invalid_mac' });
  daemon.S.appctl.enabled = true;
  assert.deepEqual(await h.ungroup_device({ mac: 'AA:BB:CC:DD:EE:FF' }), { ok: true, mac: 'aabbccddeeff' });
  const names = callNames(ref);
  assert.ok(names.includes('policy.appctlApplyRules'));
  assert.deepEqual(ref.calls.find((c) => c[0] === 'policy.appctlDpiDaemon'), ['policy.appctlDpiDaemon', 'reload']);
  assert.deepEqual(ref.calls.find((c) => c[0] === 'clients.banApply'), ['clients.banApply', true]);
});

test('set_role: invalid / sap_via_pairing / cap / unconfigured', async () => {
  const ref = await makeDaemon();
  const { daemon, uci } = ref;
  const h = buildApiHandlers(daemon);
  assert.equal(h.set_role({ role: 'bogus' }), UBUS_STATUS.INVALID_ARGUMENT);
  assert.deepEqual(h.set_role({ role: 'sap' }), { ok: false, error: 'sap_via_pairing' });
  daemon.S.cfg.token = '';
  assert.deepEqual(h.set_role({ role: 'cap' }), { ok: true, role: 'cap' });
  assert.ok(daemon.S.cfg.token.length > 0); // ensure_token generated one
  assert.equal(uci.get('wifiroam', 'core', 'role'), 'cap');
  assert.deepEqual(h.set_role({ role: 'unconfigured' }), { ok: true, role: 'unconfigured' });
  assert.equal(daemon.S.cfg.token, '');
  assert.equal(daemon.S.cfg.cap_ip, '');
});

test('get_roam: roster members on SAP, local otherwise', async () => {
  const ref = await makeDaemon();
  const { daemon } = ref;
  const h = buildApiHandlers(daemon);
  const g = h.get_roam({});
  assert.equal(g.roam.ssids[0], 'HomeWiFi');
  assert.deepEqual(g.members, []);
  daemon.S.cfg.role = 'sap';
  daemon.S.roster = { groups: [{ ssid: 'HomeWiFi' }], aps: [{ id: 'aabbccddeeff', name: 'sap1' }] };
  const g2 = h.get_roam({});
  assert.deepEqual(g2.groups, [{ ssid: 'HomeWiFi' }]);
  assert.deepEqual(g2.members, [{ mac: 'AA:BB:CC:DD:EE:FF', name: 'sap1' }]);
});

test('set_roam: not_cap; success bumps ver, applies locally, pushes to authed peers', async () => {
  const ref = await makeDaemon();
  const { daemon, uci } = ref;
  const h = buildApiHandlers(daemon);
  daemon.S.cfg.role = 'sap';
  assert.deepEqual(h.set_roam({ enabled: true }), { ok: false, error: 'not_cap' });
  daemon.S.cfg.role = 'cap';
  daemon.S.peers = {
    aabbccddeeff: { authed: true, mac: 'AA:BB:CC:DD:EE:FF', name: 'sap1' },
    112233445566: { authed: false, mac: '11:22:33:44:55:66' },
  };
  const r = h.set_roam({
    enabled: true, ssids: ['HomeWiFi'], r_fast: true, ft_mode: 'explicit',
    ft_over_ds: true, k_neighbor: true, k_beacon: true, v_bss_transition: true,
    rssi_profile: 'weird', rssi_threshold: 0,
  });
  assert.equal(r.ok, true);
  assert.equal(r.ver, 2); // seeded config_ver 1 + 1
  assert.equal(uci.get('wifiroam', 'roam', 'config_ver'), '2');
  assert.equal(uci.get('wifiroam', 'roam', 'rssi_profile'), 'balanced'); // illegal falls back
  assert.equal(uci.get('wifiroam', 'roam', 'rssi_threshold'), '-70'); // non-custom -> preset
  assert.equal(r.results.length, 2);
  assert.equal(r.results[1].ok, null);
  assert.equal(r.results[1].error, 'pending');
  assert.equal(daemon.S.last_apply.ver, 2);
  assert.deepEqual(ref.calls.find((c) => c[0] === 'discovery.pushRoamTo'), ['discovery.pushRoamTo', 'aabbccddeeff']);
  assert.ok(!callNames(ref).includes('discovery.pushRoamTo:112233445566'));
});

test('set_wifi: validation, unified key reuse, rename pairs, push', async () => {
  const ref = await makeDaemon();
  const { daemon, uci } = ref;
  const h = buildApiHandlers(daemon);
  daemon.S.cfg.role = 'sap';
  assert.deepEqual(h.set_wifi({ ifaces: [{ band: '2g', ssid: 'X', key: '' }] }), { ok: false, error: 'not_cap' });
  daemon.S.cfg.role = 'cap';
  assert.deepEqual(h.set_wifi({ ifaces: [] }), { ok: false, error: 'ssid_invalid' });
  assert.deepEqual(h.set_wifi({ ifaces: [{ band: '2g', ssid: '', key: '' }] }), { ok: false, error: 'ssid_invalid' });
  assert.deepEqual(h.set_wifi({ ifaces: [{ band: '2g', ssid: 'X', key: 'short' }] }), { ok: false, error: 'key_invalid' });
  daemon.S.peers = { aabbccddeeff: { authed: true, mac: 'AA:BB:CC:DD:EE:FF', name: 'sap1' } };
  const r = h.set_wifi({ unified: true, ifaces: [{ band: '2g', ssid: 'NewSSID', key: '' }] });
  assert.equal(r.ok, true);
  assert.equal(r.results.length, 2);
  assert.equal(r.results[1].error, 'pending');
  assert.equal(daemon.S.last_wifi.ssids[0].key, 'oldkey123'); // unified reuses existing key
  assert.equal(daemon.S.last_wifi.ssids[0].ssid, 'NewSSID');
  const rename = ref.calls.find((c) => c[0] === 'wifi.roamRenameSsids');
  assert.deepEqual(rename[1], [{ old: 'OldSSID', new: 'NewSSID' }]);
  assert.ok(ref.calls.some((c) => c[0] === 'discovery.pushWifiTo'));
  void uci;
});

test('set_guest: validation, open network, ver bump, push', async () => {
  const ref = await makeDaemon();
  const { daemon } = ref;
  const h = buildApiHandlers(daemon);
  daemon.S.cfg.role = 'sap';
  assert.deepEqual(h.set_guest({ enabled: true, ssid: 'G', key: 'password123' }), { ok: false, error: 'not_cap' });
  daemon.S.cfg.role = 'cap';
  assert.deepEqual(h.set_guest({ enabled: true, ssid: '', key: 'password123' }), { ok: false, error: 'ssid_invalid' });
  assert.deepEqual(h.set_guest({ enabled: true, ssid: 'G', key: 'short' }), { ok: false, error: 'key_invalid' });
  assert.deepEqual(h.set_guest({ enabled: true, ssid: 'G', key: 'password123', start: 'xx', end: '23:00' }), { ok: false, error: 'time_invalid' });
  ref.guestSaveResult = false;
  assert.deepEqual(h.set_guest({ enabled: true, ssid: 'G', key: 'password123', start: '08:00', end: '23:00' }), { ok: false, error: 'invalid' });
  ref.guestSaveResult = true;
  daemon.S.peers = { aabbccddeeff: { authed: true, mac: 'AA:BB:CC:DD:EE:FF', name: 'sap1' } };
  const r = h.set_guest({ enabled: true, ssid: 'GuestNet', key: '', open: true, bandwidth: 5000, start: '08:00', end: '23:00' });
  assert.equal(r.ok, true);
  assert.equal(daemon.S.last_guest.config.ver, 1);
  assert.equal(daemon.S.last_guest.config.key, ''); // open forces empty key
  assert.equal(daemon.S.last_guest.config.bandwidth, 1000); // clamped 0..1000
  assert.ok(ref.calls.some((c) => c[0] === 'discovery.pushGuestTo'));
});

test('set_backhaul: default ssid, key reuse / randhex, push', async () => {
  const ref = await makeDaemon();
  const { daemon, uci } = ref;
  const h = buildApiHandlers(daemon);
  daemon.S.cfg.role = 'sap';
  assert.deepEqual(h.set_backhaul({ enabled: true }), { ok: false, error: 'not_cap' });
  daemon.S.cfg.role = 'cap';
  daemon.S.peers = { aabbccddeeff: { authed: true, mac: 'AA:BB:CC:DD:EE:FF', name: 'sap1' } };
  const r = h.set_backhaul({ enabled: true, ssid: '', key: '', device: 'radio0' });
  assert.equal(r.ok, true);
  assert.equal(r.ver, 1);
  assert.equal(r.backhaul.ssid, 'wifiroam-bh');
  assert.equal(uci.get('wifiroam', 'backhaul', 'ssid'), 'wifiroam-bh');
  assert.equal(daemon.S.last_backhaul.ver, 1);
  assert.ok(ref.calls.some((c) => c[0] === 'discovery.pushBackhaulTo'));
});

test('discover: nonce is never sent', async () => {
  const ref = await makeDaemon();
  const { daemon } = ref;
  const h = buildApiHandlers(daemon);
  daemon.S.discovered = {
    aabbccddeeff: { mac: 'AA:BB:CC:DD:EE:FF', ip: '192.168.12.9', name: 'new', model: 'M', nonce: 'secret-nonce', last_seen: 999 },
  };
  const out = h.discover({});
  assert.deepEqual(out, { devices: [{ mac: 'AA:BB:CC:DD:EE:FF', ip: '192.168.12.9', name: 'new', model: 'M', last_seen: 999 }] });
  assert.ok(!JSON.stringify(out).includes('secret-nonce'));
});

test('pair / unpair: guards, immediate return, leave + event', async () => {
  const ref = await makeDaemon();
  const { daemon } = ref;
  const h = buildApiHandlers(daemon);
  assert.equal(h.pair({}), UBUS_STATUS.INVALID_ARGUMENT);
  assert.equal(h.unpair({}), UBUS_STATUS.INVALID_ARGUMENT);
  daemon.S.cfg.role = 'sap';
  assert.deepEqual(h.pair({ mac: 'AA:BB:CC:DD:EE:FF' }), { ok: false, error: 'not_cap' });
  assert.deepEqual(h.unpair({ mac: 'AA:BB:CC:DD:EE:FF' }), { ok: false, error: 'not_cap' });
  daemon.S.cfg.role = 'cap';
  assert.deepEqual(h.pair({ mac: 'AA:BB:CC:DD:EE:FF' }), { ok: false, error: 'not_found' });
  daemon.S.discovered = { aabbccddeeff: { mac: 'AA:BB:CC:DD:EE:FF', ip: '', name: 'new', model: 'M', nonce: 'n1', last_seen: 1 } };
  assert.deepEqual(h.pair({ mac: 'AA:BB:CC:DD:EE:FF' }), { ok: false, error: 'no_ip' });

  assert.deepEqual(h.unpair({ mac: 'AA:BB:CC:DD:EE:FF' }), { ok: false, error: 'not_found' });
  let leaveSent = null;
  daemon.S.peers = { aabbccddeeff: { authed: true, mac: 'AA:BB:CC:DD:EE:FF', name: 'sap1', chan: { defer: (m, d) => { leaveSent = [m, d]; return Promise.resolve({ status: 0 }); } } } };
  assert.deepEqual(h.unpair({ mac: 'AA:BB:CC:DD:EE:FF' }), { ok: true });
  assert.deepEqual(leaveSent, ['leave', {}]);
  assert.deepEqual(daemon.S.peers, {});
  assert.equal(daemon.S.events.at(-1).type, 'unpaired');
});

test('pair: hello -> join defer, paired event, discovered removed', async () => {
  let chanRef = null;
  const createChannel = async (_host, _port) => {
    const chan = {
      closed: false,
      deferCalls: [],
      async defer(method, data, opts) {
        this.deferCalls.push([method, data]);
        if (method === 'join') {
          opts?.onData?.({ ok: true });
          return { status: 0, data: { ok: true }, dataList: [{ ok: true }] };
        }
        return { status: 0, data: {}, dataList: [] };
      },
      close() { this.closed = true; },
      setRequestHandler(fn) { this._handler = fn; },
      on() {},
    };
    chanRef = chan;
    return chan;
  };
  const ref = await makeDaemon({ createChannel });
  const { daemon } = ref;
  const h = buildApiHandlers(daemon);
  daemon.S.discovered = { aabbccddeeff: { mac: 'AA:BB:CC:DD:EE:FF', ip: '192.168.12.9', name: 'new', model: 'M', nonce: 'nonce-9', last_seen: 1 } };
  assert.deepEqual(h.pair({ mac: 'AA:BB:CC:DD:EE:FF' }), { ok: true, ip: '192.168.12.9' });
  // Channel setup is async; the hello arrives afterwards.
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(chanRef, 'channel should have been created');
  await chanRef._handler({ method: 'hello', data: { mac: 'AA:BB:CC:DD:EE:FF', role: 'unconfigured', nonce: 'srv-nonce' } });
  assert.deepEqual(chanRef.deferCalls[0], ['join', { token: 'tok123', cap_ip: '192.168.12.1', nonce_echo: 'nonce-9' }]);
  assert.equal(daemon.S.discovered.aabbccddeeff, undefined);
  assert.equal(daemon.S.events.at(-1).type, 'paired');
  assert.equal(chanRef.closed, true);
});

test('roam_log: limit clamping (<=0 -> 50, >100 -> 100)', async () => {
  const ref = await makeDaemon();
  const { daemon } = ref;
  const h = buildApiHandlers(daemon);
  for (let i = 0; i < 60; i++) pushEvent(daemon.S, 'x', 'm', `i${i}`);
  assert.equal(h.roam_log({}).events.length, 50);
  assert.equal(h.roam_log({ limit: 0 }).events.length, 50);
  assert.equal(h.roam_log({ limit: -3 }).events.length, 50);
  assert.equal(h.roam_log({ limit: 200 }).events.length, 60);
  assert.equal(h.roam_log({ limit: 10 }).events.length, 10);
  assert.equal(h.roam_log({ limit: 10 }).events[0].info, 'i50');
});

test('appctl_status: shape, apps without domains, cap flag', async () => {
  const ref = await makeDaemon();
  const { daemon } = ref;
  const h = buildApiHandlers(daemon);
  daemon.S.appctl.devices = { aabbccddeeff: { name: 'TV', block: ['douyin'] } };
  const s = h.appctl_status({});
  assert.equal(s.ok, true);
  assert.equal(s.error, '');
  assert.equal(s.apps.length, 47); // 与原版 APP_DEFS 实测条数一致
  assert.ok(s.apps.every((a) => a.domains === undefined));
  assert.deepEqual(s.devices, { aabbccddeeff: { name: 'TV', block: ['douyin'] } });
  daemon.S.cfg.role = 'sap';
  assert.equal(h.appctl_status({}).ok, false);
  assert.equal(h.appctl_status({}).error, 'not_cap');
});

test('ban_list / set_ban / ban_set / ban_del', async () => {
  const ref = await makeDaemon();
  const { daemon, uci } = ref;
  const h = buildApiHandlers(daemon);
  ref.banRead = [{ mac: 'aabbccddeeff', name: 'TV', timeon: '22:00', timeoff: '07:00', weekdays: [0, 1] }];
  daemon.S.ban.enabled = true;
  daemon.S.ban.active = { aabbccddeeff: true };
  const list = h.ban_list({});
  assert.equal(list.ok, true);
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].active, false); // stub banInWindow -> false
  assert.deepEqual(list.blocked, ['aabbccddeeff']);

  assert.deepEqual(h.set_ban({ enabled: false }), { ok: true, enabled: false });
  assert.equal(uci.get('wifiroam', 'schedule', 'enabled'), '0');
  assert.equal(daemon.S.ban.enabled, false);

  daemon.S.cfg.role = 'sap';
  assert.deepEqual(h.set_ban({ enabled: true }), { ok: false, error: 'not_cap' });
  assert.deepEqual(await h.ban_set({ mac: 'AA:BB:CC:DD:EE:FF', timeon: '22:00', timeoff: '07:00', weekdays: '0 1' }), { ok: false, error: 'not_cap' });
  assert.deepEqual(h.ban_del({ mac: 'AA:BB:CC:DD:EE:FF' }), { ok: false, error: 'not_cap' });
  daemon.S.cfg.role = 'cap';
  assert.deepEqual(await h.ban_set({ mac: 'bad', timeon: '22:00', timeoff: '07:00', weekdays: '0' }), { ok: false, error: 'invalid_mac' });
  assert.deepEqual(await h.ban_set({ mac: 'AA:BB:CC:DD:EE:FF', timeon: 'xx', timeoff: '07:00', weekdays: '0' }), { ok: false, error: 'invalid_time' });
  assert.deepEqual(await h.ban_set({ mac: 'AA:BB:CC:DD:EE:FF', timeon: '22:00', timeoff: '07:00', weekdays: '' }), { ok: false, error: 'invalid_weekdays' });
  const set = await h.ban_set({ mac: 'AA:BB:CC:DD:EE:FF', name: '', timeon: '22:00', timeoff: '07:00', weekdays: '0 1 1' });
  assert.deepEqual(set, { ok: true, mac: 'aabbccddeeff', blocked: true });
  assert.equal(uci.get('wifiroam', 'cfg000001', 'timeon'), '22:00');
  assert.equal(uci.get('wifiroam', 'cfg000001', 'weekdays'), '0 1');
  assert.ok(callNames(ref).includes('clients.banReloadEnabled'));

  assert.deepEqual(h.ban_del({ mac: 'AA:BB:CC:DD:EE:FF' }), { ok: true });
  assert.deepEqual(h.ban_del({ mac: 'AA:BB:CC:DD:EE:FF' }), { ok: false, error: 'not_found' });
});

test('offload_status / set_offload', async () => {
  const ref = await makeDaemon();
  const { daemon, uci } = ref;
  const h = buildApiHandlers(daemon);
  // cmdOutput is the real shell one here (nft absent -> empty output).
  const st = h.offload_status({});
  assert.deepEqual(st, { enabled: false, hw: false, active: false });
  uci.seed('firewall', '@defaults[0]', 'defaults', { flow_offloading: '1', flow_offloading_hw: '1' });
  assert.equal(h.offload_status({}).enabled, true);

  daemon.S.cfg.role = 'sap';
  assert.deepEqual(h.set_offload({ enabled: true }), { ok: true, enabled: true });
  assert.ok(callNames(ref).includes('policy.offloadRequestCap'));
  daemon.S.cfg.role = 'cap';
  ref.offloadApplyResult = false;
  assert.deepEqual(h.set_offload({ enabled: true }), { ok: false, error: 'no_firewall_defaults' });
  ref.offloadApplyResult = true;
  daemon.S.peers = { aabbccddeeff: { authed: true } };
  assert.deepEqual(h.set_offload({ enabled: false }), { ok: true, enabled: false });
  assert.ok(ref.calls.some((c) => c[0] === 'discovery.pushOffloadTo'));
});

test('set_appctl: enable path, disable path, dnsmasq restart when dirty', async () => {
  const ref = await makeDaemon();
  const { daemon, uci } = ref;
  const h = buildApiHandlers(daemon);
  daemon.S.cfg.role = 'sap';
  assert.deepEqual(await h.set_appctl({ enabled: true, enhanced: true, strict: '1' }), { ok: false, error: 'not_cap' });
  daemon.S.cfg.role = 'cap';
  const r = await h.set_appctl({ enabled: true, enhanced: true, strict: '1' });
  assert.deepEqual(r, { ok: true, enabled: true, enhanced: true, strict: true });
  assert.equal(uci.get('wifiroam', 'appctl', 'enhanced'), '1');
  assert.equal(daemon.S.appctl.strict, true);
  assert.ok(callNames(ref).includes('policy.appctlApplyRules'));
  assert.deepEqual(ref.calls.find((c) => c[0] === 'policy.appctlDpiDaemon'), ['policy.appctlDpiDaemon', 'start']);
  // strict '' keeps the current value.
  assert.deepEqual(await h.set_appctl({ enabled: true, enhanced: false, strict: '' }), { ok: true, enabled: true, enhanced: false, strict: true });
  const r2 = await h.set_appctl({ enabled: false, enhanced: false, strict: '0' });
  assert.deepEqual(r2, { ok: true, enabled: false, enhanced: false, strict: false });
  assert.ok(callNames(ref).includes('policy.appctlTableRemove'));
  assert.deepEqual(ref.calls.filter((c) => c[0] === 'policy.appctlHwSuspend').at(-1), ['policy.appctlHwSuspend', false]);
});

test('set_app_policy: guards and block/allow update', async () => {
  const ref = await makeDaemon();
  const { daemon } = ref;
  const h = buildApiHandlers(daemon);
  daemon.S.cfg.role = 'sap';
  assert.deepEqual(await h.set_app_policy({ mac: 'AA:BB:CC:DD:EE:FF', app: 'wechat', action: 'block' }), { ok: false, error: 'not_cap' });
  daemon.S.cfg.role = 'cap';
  assert.deepEqual(await h.set_app_policy({ mac: 'bad', app: 'wechat', action: 'block' }), { ok: false, error: 'invalid_args' });
  assert.deepEqual(await h.set_app_policy({ mac: 'AA:BB:CC:DD:EE:FF', app: 'nope', action: 'block' }), { ok: false, error: 'invalid_args' });
  assert.deepEqual(await h.set_app_policy({ mac: 'AA:BB:CC:DD:EE:FF', app: 'wechat', action: 'block' }), { ok: false, error: 'disabled' });
  daemon.S.appctl.enabled = true;
  assert.deepEqual(await h.set_app_policy({ mac: 'AA:BB:CC:DD:EE:FF', app: 'wechat', action: 'mute' }), { ok: false, error: 'invalid_action' });
  ref.appctlDevices = { aabbccddeeff: { name: 'TV', block: [] } };
  assert.deepEqual(
    await h.set_app_policy({ mac: 'AA:BB:CC:DD:EE:FF', app: 'wechat', action: 'block' }),
    { ok: true, mac: 'aabbccddeeff', app: 'wechat', action: 'block', block: ['wechat'] },
  );
  ref.appctlDevices = { aabbccddeeff: { name: 'TV', block: ['wechat'] } };
  assert.deepEqual(
    await h.set_app_policy({ mac: 'AA:BB:CC:DD:EE:FF', app: 'wechat', action: 'allow' }),
    { ok: true, mac: 'aabbccddeeff', app: 'wechat', action: 'allow', block: [] },
  );
  assert.ok(callNames(ref).includes('policy.appctlApplyRules'));
});

// ------------------------------------------------------------------ start/stop
test('createDaemon: ubus connect failure logs, exits 1, and throws', async () => {
  const ref = { calls: [] };
  const uci = seedUci(new MockUci());
  const exitCodes = [];
  const logs = [];
  setLogWriter((s) => logs.push(s));
  try {
    await assert.rejects(
      createDaemon({
        uci,
        modules: makeModules(ref),
        ubusConnect: async () => { throw new Error('no ubusd'); },
        exitFn: (c) => { exitCodes.push(c); },
      }),
      /ubus connect failed/,
    );
    assert.deepEqual(exitCodes, [1]);
    assert.ok(logs.some((l) => l.includes('ubus connect failed')));
  } finally {
    setLogWriter(silenceLogs);
  }
});

test('api dispatch: module handlers win over core fallbacks', async () => {
  const ref = await makeDaemon();
  ref.daemon.modules.clients.topology = async () => ({ delegated: 'topology' });
  ref.daemon.modules.policy.appctlStatus = () => ({ delegated: 'appctl' });
  const h = buildApiHandlers(ref.daemon);
  assert.deepEqual(await h.topology({}), { delegated: 'topology' });
  assert.deepEqual(await h.appctl_status({}), { delegated: 'appctl' });
  // Core fallback still serves methods no module provides.
  assert.equal((await h.status({})).version, 5);
  assert.deepEqual(h.roam_log({ limit: 1 }), { events: [] });
});

test('pair: discovery.startPairing is preferred when present', async () => {
  const ref = await makeDaemon();
  const { daemon } = ref;
  const h = buildApiHandlers(daemon);
  let pairingArgs = null;
  daemon.modules.discovery.startPairing = (args) => {
    pairingArgs = args;
    args.onPaired();
    return { done: true, channel: null, close() {} };
  };
  daemon.S.discovered = { aabbccddeeff: { mac: 'AA:BB:CC:DD:EE:FF', ip: '192.168.12.9', name: 'new', model: 'M', nonce: 'nonce-9', last_seen: 1 } };
  assert.deepEqual(h.pair({ mac: 'AA:BB:CC:DD:EE:FF' }), { ok: true, ip: '192.168.12.9' });
  assert.equal(pairingArgs.ip, '192.168.12.9');
  assert.equal(pairingArgs.token, 'tok123');
  assert.equal(pairingArgs.nonceEcho, 'nonce-9');
  assert.equal(daemon.S.discovered.aabbccddeeff, undefined);
  assert.equal(daemon.S.events.at(-1).type, 'paired');

  // startPairing returning null maps to the original { ok:false, error:'socket' }.
  daemon.modules.discovery.startPairing = () => null;
  daemon.S.discovered = { aabbccddeeff: { mac: 'AA:BB:CC:DD:EE:FF', ip: '192.168.12.9', name: 'new', model: 'M', nonce: 'nonce-9', last_seen: 1 } };
  assert.deepEqual(h.pair({ mac: 'AA:BB:CC:DD:EE:FF' }), { ok: false, error: 'socket' });
});

test('unpair: discovery.sendLeave is preferred when present', async () => {
  const ref = await makeDaemon();
  const { daemon } = ref;
  const h = buildApiHandlers(daemon);
  let left = null;
  daemon.modules.discovery.sendLeave = (mn) => { left = mn; return true; };
  daemon.S.peers = { aabbccddeeff: { authed: true, mac: 'AA:BB:CC:DD:EE:FF', name: 'sap1' } };
  assert.deepEqual(h.unpair({ mac: 'AA:BB:CC:DD:EE:FF' }), { ok: true });
  assert.equal(left, 'aabbccddeeff');
  assert.deepEqual(daemon.S.peers, {});
});

// ------------------------------------------------------------------ integration
test('integration: real modules assemble, start, publish, stop', async () => {
  const uci = seedUci(new MockUci());
  uci.seed('wireless', 'radio0', 'wifi-device', { band: '2g' });
  uci.seed('wifiroam', 'core', 'globals', { enabled: '1', role: 'cap', token: 'tok123', cap_ip: '', name: 'cap1' });
  // Make wifiIfaces see a real ap iface with a device.
  uci.seed('wireless', 'default_radio0', 'wifi-iface', { mode: 'ap', ssid: 'OldSSID', key: 'oldkey123', device: 'radio0' });

  const udpSends = [];
  const fakeUdp = {
    createSocket: () => ({
      on() {},
      bind(_port, _host, cb) { setTimeout(cb, 0); },
      setBroadcast() {},
      send(buf, _port, _host) { udpSends.push(String(buf)); },
      close() {},
    }),
  };
  const fakeNet = {
    createServer: () => ({
      on() {},
      listen(_port, _host, _backlog, cb) { setTimeout(cb, 0); },
      close() {},
    }),
  };
  const bus = {
    added: null, closed: false,
    async call(path, method) {
      if (path === 'network.interface.lan') {
        return { device: 'br-lan', 'ipv4-address': [{ address: '192.168.12.1', mask: 24 }] };
      }
      if (path === 'network.wireless') {
        return { radio0: { config: { band: '2g' }, interfaces: [{ ifname: 'wlan0', config: { ssid: 'HomeWiFi', mode: 'ap' } }] } };
      }
      return null; // hostapd.* and anything else: no data
    },
    async addObject(path, methods) {
      this.added = { path, methods };
      return { id: 99, type: 0 };
    },
    close() { this.closed = true; },
  };
  const logs = [];
  setLogWriter((s) => logs.push(s));
  const exitCodes = [];
  let daemon;
  try {
    daemon = await createDaemon({
      uci,
      bus,
      exitFn: (c) => { exitCodes.push(c); },
      extraCtx: {
        dgram: fakeDgramShim(fakeUdp), net: fakeNetShim(fakeNet),
        // Windows 没有 /sys，注入 sysfs 让 self.mac 可判定（目标机行为相同）。
        fs: {
          readFile: (p) => ({
            '/sys/class/net/br-lan/address': 'aa:bb:cc:dd:ee:ff\n',
            '/proc/sys/kernel/hostname': 'cap1\n',
            '/tmp/sysinfo/model': 'Test Model\n',
            '/etc/openwrt_release': "DISTRIB_DESCRIPTION='ImmortalWRT 24.10'\n",
          })[p.replace(/\\/g, '/')] ?? null,
          glob: () => [],
          access: () => true,
        },
      },
    });
    // Real factories captured the injected bus.
    assert.equal(daemon.modules.discovery.setupUdp.length, 0);
    const ok = await daemon.start();
    assert.equal(ok, true);
    assert.equal(daemon.started, true);
    assert.deepEqual(exitCodes, []);
    assert.equal(bus.added.path, 'wifiroam');
    assert.deepEqual(Object.keys(bus.added.methods), API_METHODS);
    assert.equal(daemon.timers.length, 12);
    assert.ok(udpSends.length >= 1, 'send_hello should have broadcast once');
    const hello = JSON.parse(udpSends[0]);
    assert.equal(hello.magic, 'WIFIROAM1');
    assert.equal(hello.role, 'cap');
    assert.ok(logs.some((l) => l.includes('started role=cap')));
    assert.match(daemon.S.self.mac, /^[0-9A-F:]{17}$/);
    assert.equal(daemon.S.self.ip, '192.168.12.1');
    // ubus wrapper dispatches to the real module handlers end to end.
    const st = await bus.added.methods.status.handler({ data: {} });
    assert.equal(st.version, 5);
    assert.equal(st.role, 'cap');
    const topo = await bus.added.methods.topology.handler({ data: {} });
    assert.equal(topo.role, 'cap');
    assert.ok(Array.isArray(topo.nodes));
    const disc = await bus.added.methods.discover.handler({ data: {} });
    assert.deepEqual(disc, { devices: [] });
  } finally {
    setLogWriter(silenceLogs);
    if (daemon) daemon.stop();
  }
  assert.equal(daemon.timers.length, 0);
  assert.equal(bus.closed, true);
});

function fakeDgramShim(fake) { return fake; }
function fakeNetShim(fake) { return fake; }

test('start: full flow in original order, then stop clears timers and bus', async () => {
  const ref = await makeDaemon();
  const { daemon, bus } = ref;
  const logs = [];
  setLogWriter((s) => logs.push(s));
  try {
    const ok = await daemon.start();
    assert.equal(ok, true);
    assert.equal(daemon.started, true);
    assert.equal(bus.added.path, 'wifiroam');
    assert.deepEqual(Object.keys(bus.added.methods), API_METHODS);
    const names = callNames(ref);
    const order = [
      'clients.aliasLoad', 'clients.devlistLoad', 'clients.deviceGroupRefresh',
      'policy.appctlLoad', 'clients.banLoad',
      'discovery.setupUdp', 'discovery.setupTcp', 'bus.addObject',
      'discovery.sendHello',
    ];
    let last = -1;
    for (const n of order) {
      const i = names.indexOf(n);
      assert.ok(i > last, `${n} should come after previous step (got ${names.join(',')})`);
      last = i;
    }
    assert.equal(daemon.timers.length, 12);
    assert.ok(logs.some((l) => l.includes('started role=cap')));
    // detectSelf ran during start (stub fills self).
    assert.equal(daemon.S.self.model, 'TestModel');
  } finally {
    setLogWriter(silenceLogs);
  }
  daemon.stop();
  assert.equal(daemon.timers.length, 0);
  assert.equal(daemon.started, false);
  assert.equal(bus.closed, true);
  assert.equal(daemon.bus, null);
});

test('start: set_role cap path generates a token when missing', async () => {
  const ref = await makeDaemon();
  const { daemon, uci } = ref;
  uci.seed('wifiroam', 'core', 'globals', { enabled: '1', role: 'cap', token: '', cap_ip: '', name: 'cap1' });
  await daemon.start();
  try {
    assert.ok(daemon.S.cfg.token.length > 0);
    assert.equal(uci.get('wifiroam', 'core', 'token'), daemon.S.cfg.token);
  } finally {
    daemon.stop();
  }
});

// ------------------------------------------------------------------ hygiene
test('no Node 22.23.4-banned APIs in core or entry (research §1.5)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const coreSrc = readFileSync(join(here, '..', 'daemon', 'core.mjs'), 'utf8');
  const entrySrc = readFileSync(join(here, '..', 'wifiroamd.mjs'), 'utf8');
  for (const banned of ['Promise.try', 'RegExp.escape', 'Float16Array', 'Error.isError', 'Atomics.pause', 'URLPattern']) {
    assert.ok(!coreSrc.includes(banned), `core.mjs uses banned ${banned}`);
    assert.ok(!entrySrc.includes(banned), `wifiroamd.mjs uses banned ${banned}`);
  }
  assert.ok(!/^\s*using\s/m.test(coreSrc), 'core.mjs uses `using` declaration');
  assert.ok(!coreSrc.includes('localStorage') && !coreSrc.includes('sessionStorage'));
});
