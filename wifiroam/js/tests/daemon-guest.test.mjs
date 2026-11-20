// daemon-guest.test.mjs -- node:test suite for daemon/guest.mjs.
// Covers (per task): guest schedule open/close incl. cross-midnight,
// subnet + isolation-zone config generation, SSID/password application.
// uci/shell are fully mocked (in-memory MockUci + recording shell);
// no real uci binary, nft, tc, iw or router is touched.
// Run: node --test tests/daemon-guest.test.mjs (from ~/workspace/wifiroam-js)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createGuest, GUEST_IP, GUEST_NET } from '../daemon/guest.mjs';
import * as utilLib from '../lib/util.js';

// ------------------------------------------------------------ MockUci
// In-memory UciClient-compatible store: sections are
// { '.name', '.type', ...options }. get/set/delete/commit/foreach/load
// mirror lib/uci.js semantics (set with 3 args creates a section;
// set with an array value stores the array, as add_list would).
class MockUci {
  constructor() {
    this.pkgs = new Map();
  }

  _pkg(p) {
    if (!this.pkgs.has(p)) this.pkgs.set(p, new Map());
    return this.pkgs.get(p);
  }

  seed(pkg, name, type, opts = {}) {
    this._pkg(pkg).set(name, { '.name': name, '.type': type, ...opts });
  }

  load() {
    return true;
  }

  get(pkg, section, option) {
    const sec = this._pkg(pkg).get(section);
    if (!sec) return null;
    if (option === undefined) return sec;
    const v = sec[option];
    return v === undefined ? null : v;
  }

  set(pkg, section, option, value) {
    const secs = this._pkg(pkg);
    if (value === undefined) {
      if (!secs.has(section)) secs.set(section, { '.name': section, '.type': option });
      return true;
    }
    const sec = secs.get(section);
    if (!sec) return false;
    sec[option] = value;
    return true;
  }

  delete(pkg, section, option) {
    const secs = this._pkg(pkg);
    if (option === undefined) return secs.delete(section);
    const sec = secs.get(section);
    if (!sec) return false;
    delete sec[option];
    return true;
  }

  commit() {
    return true;
  }

  foreach(pkg, type, cb) {
    let n = 0;
    for (const sec of [...this._pkg(pkg).values()]) {
      if (sec['.type'] !== type) continue;
      n++;
      cb(sec);
    }
    return n;
  }
}

// ------------------------------------------------------------ Mock shell
// cmdOutput records every command and answers from a per-test responder;
// runProcess records [path, args] and invokes opts.onExit(0) synchronously
// (mirroring uloop.process callbacks firing on completion).
function makeShell(respond = () => '') {
  const cmds = [];
  const procs = [];
  return {
    cmds,
    procs,
    cmdOutput(cmd) {
      cmds.push(cmd);
      return respond(cmd);
    },
    runProcess(path, args, opts = {}) {
      procs.push([path, [...args]]);
      if (typeof opts?.onExit === 'function') opts.onExit(0);
      return Promise.resolve(0);
    },
  };
}

const IW_DEV_TWO_GUEST =
  'phy#0\n' +
  '\tInterface phy0-ap0\n' +
  '\t\tssid MainWifi\n' +
  '\tInterface phy0-ap1\n' +
  '\t\tssid Guest\n' +
  'phy#1\n' +
  '\tInterface phy1-ap1\n' +
  '\t\tssid Guest\n';

// ------------------------------------------------------------ fixtures
function makeState(role = 'cap') {
  return {
    cfg: { role },
    self: { ip: '192.168.12.1' },
    brdev: 'br-lan',
    events: [],
    last_guest: null,
    guest_open: null,
    guest_tc_sig: '',
    guest_tc_devs: [],
    _guest_nft_sig: '',
    _guest_zone_migrated: false,
  };
}

function seedBase(uci, { guest = {}, role } = {}) {
  uci.seed('wifiroam', 'guest', 'guest', {
    enabled: '1',
    ssid: 'Guest',
    key: 'guestpass123',
    bandwidth: '10',
    schedule: '1',
    start: '08:00',
    end: '23:00',
    allow_lan: '0',
    config_ver: '3',
    ...guest,
  });
  uci.seed('wireless', 'radio0', 'wifi-device', { band: '2g' });
  uci.seed('wireless', 'radio1', 'wifi-device', { band: '5g' });
  uci.seed('network', 'lan', 'interface', {
    ipaddr: ['192.168.12.1'],
    netmask: '255.255.255.0',
    gateway: '192.168.12.1',
  });
  return uci;
}

function makeTimer() {
  const pending = [];
  const fn = (cb, ms) => {
    pending.push({ cb, ms });
    return pending.length;
  };
  fn.pending = pending;
  fn.runOne = () => {
    const t = pending.shift();
    if (t) t.cb();
  };
  fn.runAll = () => {
    while (pending.length) pending.shift().cb();
  };
  return fn;
}

function makeCtx({ role = 'cap', uci, shell, nowMin = 600, timer, leases = '', events } = {}) {
  const S = makeState(role);
  if (events) S.events = events;
  const pushed = [];
  const ctx = {
    S,
    uci,
    shell,
    util: { ...utilLib, nowMinutes: () => nowMin, log: () => {} },
    setTimeout: timer ?? makeTimer(),
    readLeases: () => leases,
    pushEvent: (type, mac, info, name) => pushed.push({ type, mac, info, name }),
  };
  return { ctx, S, pushed };
}

const baseCfg = {
  enabled: true,
  ssid: 'Guest',
  key: 'guestpass123',
  bandwidth: 10,
  schedule: true,
  start: '08:00',
  end: '23:00',
  allow_lan: false,
  ver: 3,
};

// ============================================================ schedule
test('guestOpenNow: disabled -> false, no schedule -> true', () => {
  const { ctx } = makeCtx({});
  const g = createGuest(ctx);
  assert.equal(g.guestOpenNow({ ...baseCfg, enabled: false }), false);
  assert.equal(g.guestOpenNow({ ...baseCfg, schedule: false }, 0), true);
  assert.equal(g.guestOpenNow({ ...baseCfg, schedule: false }, 1439), true);
});

test('guestOpenNow: same-day window, start inclusive / end exclusive', () => {
  const { ctx } = makeCtx({});
  const g = createGuest(ctx);
  const cfg = { ...baseCfg, start: '08:00', end: '23:00' };
  assert.equal(g.guestOpenNow(cfg, 479), false); // 07:59
  assert.equal(g.guestOpenNow(cfg, 480), true); // 08:00
  assert.equal(g.guestOpenNow(cfg, 720), true); // 12:00
  assert.equal(g.guestOpenNow(cfg, 1379), true); // 22:59
  assert.equal(g.guestOpenNow(cfg, 1380), false); // 23:00
});

test('guestOpenNow: cross-midnight window 22:00-07:00', () => {
  const { ctx } = makeCtx({});
  const g = createGuest(ctx);
  const cfg = { ...baseCfg, start: '22:00', end: '07:00' };
  assert.equal(g.guestOpenNow(cfg, 1319), false); // 21:59
  assert.equal(g.guestOpenNow(cfg, 1320), true); // 22:00
  assert.equal(g.guestOpenNow(cfg, 0), true); // 00:00
  assert.equal(g.guestOpenNow(cfg, 359), true); // 05:59
  assert.equal(g.guestOpenNow(cfg, 419), true); // 06:59
  assert.equal(g.guestOpenNow(cfg, 420), false); // 07:00
  assert.equal(g.guestOpenNow(cfg, 720), false); // 12:00
});

test('guestOpenNow: invalid start/end -> true (original fallback)', () => {
  const { ctx } = makeCtx({});
  const g = createGuest(ctx);
  assert.equal(g.guestOpenNow({ ...baseCfg, start: 'xx' }, 0), true);
  assert.equal(g.guestOpenNow({ ...baseCfg, end: '25:00' }, 0), true);
  assert.equal(g.guestOpenNow({ ...baseCfg, start: '' }, 0), true);
});

// ============================================================ guestCfg / summary
test('guestCfg: defaults when options missing, values when present', () => {
  const uci = new MockUci();
  uci.seed('wifiroam', 'guest', 'guest', {});
  const { ctx } = makeCtx({ uci, shell: makeShell() });
  const g = createGuest(ctx);
  assert.deepEqual(g.guestCfg(), {
    enabled: false,
    ssid: 'Guest',
    key: '',
    bandwidth: 0,
    schedule: false,
    start: '08:00',
    end: '23:00',
    allow_lan: false,
    ver: 0,
  });

  const uci2 = seedBase(new MockUci());
  const { ctx: ctx2 } = makeCtx({ uci: uci2, shell: makeShell(), nowMin: 600 });
  assert.deepEqual(createGuest(ctx2).guestCfg(), {
    enabled: true,
    ssid: 'Guest',
    key: 'guestpass123',
    bandwidth: 10,
    schedule: true,
    start: '08:00',
    end: '23:00',
    allow_lan: false,
    ver: 3,
  });
});

test('guestSummary: config + open + guest ifaces with band/disabled', () => {
  const uci = seedBase(new MockUci());
  uci.seed('wireless', 'wifiroam_guest_radio0', 'wifi-iface', {
    device: 'radio0',
    wifiroam_guest: '1',
    disabled: '0',
  });
  uci.seed('wireless', 'wifiroam_guest_radio1', 'wifi-iface', {
    device: 'radio1',
    wifiroam_guest: '1',
    disabled: '1',
  });
  uci.seed('wireless', 'main0', 'wifi-iface', { device: 'radio0', ssid: 'MainWifi' });
  const { ctx, S } = makeCtx({ uci, shell: makeShell(), nowMin: 600 });
  S.last_guest = { ts: 1 };
  const s = createGuest(ctx).guestSummary();
  assert.equal(s.role, 'cap');
  assert.equal(s.enabled, true);
  assert.equal(s.ssid, 'Guest');
  assert.equal(s.has_key, true);
  assert.equal(s.bandwidth, 10);
  assert.equal(s.open, true);
  assert.equal(s.last.ts, 1);
  assert.deepEqual(s.ifaces, [
    { section: 'wifiroam_guest_radio0', device: 'radio0', band: '2g', disabled: false },
    { section: 'wifiroam_guest_radio1', device: 'radio1', band: '5g', disabled: true },
  ]);
});

test('guestLanInfo: list ipaddr picks first, cidr from lan netmask', () => {
  const uci = seedBase(new MockUci());
  const { ctx } = makeCtx({ uci, shell: makeShell() });
  const info = createGuest(ctx).guestLanInfo();
  assert.equal(info.ip, '192.168.12.1');
  assert.equal(info.cidr, '192.168.12.0/24');
  assert.equal(info.gw, '192.168.12.1');

  const uci2 = new MockUci();
  uci2.seed('network', 'lan', 'interface', {});
  const { ctx: ctx2 } = makeCtx({ uci: uci2, shell: makeShell() });
  const info2 = createGuest(ctx2).guestLanInfo();
  assert.equal(info2.ip, '192.168.0.1');
  assert.equal(info2.cidr, '192.168.0.0/24');
  assert.equal(info2.gw, '192.168.12.1'); // falls back to state.self.ip
});

// ============================================================ save / SSID+key
test('guestSaveLocal: validation rejects bad ssid/key/time, writes nothing', () => {
  const uci = seedBase(new MockUci());
  const { ctx } = makeCtx({ uci, shell: makeShell() });
  const g = createGuest(ctx);
  assert.equal(g.guestSaveLocal({ ...baseCfg, ssid: '' }), false);
  assert.equal(g.guestSaveLocal({ ...baseCfg, ssid: 'x'.repeat(33) }), false);
  assert.equal(g.guestSaveLocal({ ...baseCfg, key: 'short' }), false);
  assert.equal(g.guestSaveLocal({ ...baseCfg, key: 'x'.repeat(65) }), false);
  // 'ab:cd' is NOT invalid: int('ab')==0 in both ucode and lib/util.js,
  // so it parses as 00:00. Truly invalid: out-of-range hour, missing ':'.
  assert.equal(g.guestSaveLocal({ ...baseCfg, start: '24:00' }), false);
  assert.equal(g.guestSaveLocal({ ...baseCfg, start: '08' }), false);
  // disabled + empty ssid is allowed (only enabled validates ssid)
  assert.equal(g.guestSaveLocal({ ...baseCfg, enabled: false, ssid: '' }), true);
  // nothing was written by the failing calls except the last valid one
  assert.equal(uci.get('wifiroam', 'guest', 'enabled'), '0');
});

test('guestSaveLocal: open network forces empty key; writes ver + defaults', () => {
  const uci = seedBase(new MockUci());
  const { ctx } = makeCtx({ uci, shell: makeShell() });
  const g = createGuest(ctx);
  assert.equal(
    g.guestSaveLocal({ enabled: true, ssid: '  CafeGuest ', key: 'ignored', open: true, bandwidth: 42, schedule: false, start: '09:00', end: '21:00', allow_lan: true, ver: 7 }),
    true,
  );
  assert.equal(uci.get('wifiroam', 'guest', 'ssid'), 'CafeGuest');
  assert.equal(uci.get('wifiroam', 'guest', 'key'), '');
  assert.equal(uci.get('wifiroam', 'guest', 'bandwidth'), '42');
  assert.equal(uci.get('wifiroam', 'guest', 'schedule'), '0');
  assert.equal(uci.get('wifiroam', 'guest', 'start'), '09:00');
  assert.equal(uci.get('wifiroam', 'guest', 'end'), '21:00');
  assert.equal(uci.get('wifiroam', 'guest', 'allow_lan'), '1');
  assert.equal(uci.get('wifiroam', 'guest', 'config_ver'), '7');
});

test('guestSaveLocal: empty ssid falls back to Guest default', () => {
  const uci = seedBase(new MockUci());
  const { ctx } = makeCtx({ uci, shell: makeShell() });
  const g = createGuest(ctx);
  assert.equal(g.guestSaveLocal({ ...baseCfg, enabled: false, ssid: '' }), true);
  assert.equal(uci.get('wifiroam', 'guest', 'ssid'), 'Guest');
});

test('guestWriteWireless: creates per-radio guest ifaces, psk2 + key, open', () => {
  const uci = seedBase(new MockUci());
  const { ctx } = makeCtx({ uci, shell: makeShell(), nowMin: 600 });
  const g = createGuest(ctx);
  assert.equal(g.guestWriteWireless(baseCfg), true);
  for (const radio of ['radio0', 'radio1']) {
    const sid = `wifiroam_guest_${radio}`;
    assert.equal(uci.get('wireless', sid, 'device'), radio);
    assert.equal(uci.get('wireless', sid, 'mode'), 'ap');
    assert.equal(uci.get('wireless', sid, 'ssid'), 'Guest');
    assert.equal(uci.get('wireless', sid, 'encryption'), 'psk2');
    assert.equal(uci.get('wireless', sid, 'key'), 'guestpass123');
    assert.equal(uci.get('wireless', sid, 'network'), 'wifiroam_guest');
    assert.equal(uci.get('wireless', sid, 'wifiroam_guest'), '1');
    assert.equal(uci.get('wireless', sid, 'disabled'), '0');
  }
});

test('guestWriteWireless: open network -> encryption none, key deleted; closed -> disabled', () => {
  const uci = seedBase(new MockUci());
  uci.seed('wireless', 'wifiroam_guest_radio0', 'wifi-iface', {
    device: 'radio0',
    wifiroam_guest: '1',
    key: 'oldkey123',
    encryption: 'psk2',
  });
  const { ctx } = makeCtx({ uci, shell: makeShell(), nowMin: 600 });
  const g = createGuest(ctx);
  assert.equal(g.guestWriteWireless({ ...baseCfg, key: '' }), true);
  assert.equal(uci.get('wireless', 'wifiroam_guest_radio0', 'encryption'), 'none');
  assert.equal(uci.get('wireless', 'wifiroam_guest_radio0', 'key'), null);

  // outside the schedule window -> disabled=1, returns open=false
  assert.equal(g.guestWriteWireless({ ...baseCfg, key: 'guestpass123' }), true); // nowMin 600 is inside; use explicit closed cfg
  const { ctx: ctx2 } = makeCtx({ uci, shell: makeShell(), nowMin: 60 });
  assert.equal(createGuest(ctx2).guestWriteWireless(baseCfg), false);
  assert.equal(uci.get('wireless', 'wifiroam_guest_radio0', 'disabled'), '1');
});

test('guestWriteWireless: stale guest iface (unknown radio) is deleted', () => {
  const uci = seedBase(new MockUci());
  uci.seed('wireless', 'wifiroam_guest_radio9', 'wifi-iface', {
    device: 'radio9',
    wifiroam_guest: '1',
  });
  const { ctx } = makeCtx({ uci, shell: makeShell(), nowMin: 600 });
  createGuest(ctx).guestWriteWireless(baseCfg);
  assert.equal(uci.get('wireless', 'wifiroam_guest_radio9'), null);
  assert.notEqual(uci.get('wireless', 'wifiroam_guest_radio0'), null);
});

// ============================================================ infra / nft
test('guestWriteInfra (CAP): bridge+interface+dhcp, zone device-only, fwd wan only', () => {
  const uci = seedBase(new MockUci());
  const { ctx } = makeCtx({ uci, shell: makeShell() });
  createGuest(ctx).guestWriteInfra({ ...baseCfg, allow_lan: false });
  assert.equal(uci.get('network', 'wifiroam_guest_dev', 'type'), 'bridge');
  assert.equal(uci.get('network', 'wifiroam_guest_dev', 'name'), 'br-guest');
  assert.equal(uci.get('network', 'wifiroam_guest', 'proto'), 'static');
  assert.equal(uci.get('network', 'wifiroam_guest', 'device'), 'br-guest');
  assert.equal(uci.get('network', 'wifiroam_guest', 'ipaddr'), GUEST_IP);
  assert.equal(uci.get('network', 'wifiroam_guest', 'netmask'), '255.255.255.0');
  assert.equal(uci.get('dhcp', 'wifiroam_guest', 'interface'), 'wifiroam_guest');
  assert.equal(uci.get('dhcp', 'wifiroam_guest', 'start'), '10');
  assert.equal(uci.get('dhcp', 'wifiroam_guest', 'limit'), '100');
  assert.equal(uci.get('dhcp', 'wifiroam_guest', 'leasetime'), '12h');
  assert.equal(uci.get('dhcp', 'wifiroam_guest', 'dhcpv4'), 'server');
  assert.equal(uci.get('dhcp', 'wifiroam_guest', 'dhcpv6'), 'disabled');
  assert.equal(uci.get('dhcp', 'wifiroam_guest', 'force'), '1');

  const zone = uci.get('firewall', 'wifiroam_guest_zone');
  assert.equal(zone.name, 'guest');
  assert.equal(zone.device, 'br-guest');
  assert.equal(zone.network, undefined); // device-only: no network/subnet
  assert.equal(zone.subnet, undefined);
  assert.equal(zone.input, 'REJECT');
  assert.equal(zone.output, 'ACCEPT');
  assert.equal(zone.forward, 'REJECT');
  for (const [sec, proto, port] of [
    ['wifiroam_guest_dhcp', 'udp', '67'],
    ['wifiroam_guest_dns_u', 'udp', '53'],
    ['wifiroam_guest_dns_t', 'tcp', '53'],
  ]) {
    assert.equal(uci.get('firewall', sec, 'src'), 'guest');
    assert.equal(uci.get('firewall', sec, 'proto'), proto);
    assert.equal(uci.get('firewall', sec, 'dest_port'), port);
    assert.equal(uci.get('firewall', sec, 'target'), 'ACCEPT');
    assert.equal(uci.get('firewall', sec, 'family'), 'ipv4');
  }
  assert.equal(uci.get('firewall', 'wifiroam_guest_fwd_wan', 'dest'), 'wan');
  assert.equal(uci.get('firewall', 'wifiroam_guest_fwd_lan'), null);
  assert.equal(uci.get('firewall', 'wifiroam_guest_snat'), null);
});

test('guestWriteInfra (SAP): no fwd_wan, fwd_lan present, allow_lan adds fwd_lan on CAP', () => {
  const uci = seedBase(new MockUci());
  const { ctx } = makeCtx({ role: 'sap', uci, shell: makeShell() });
  createGuest(ctx).guestWriteInfra({ ...baseCfg, allow_lan: false });
  assert.equal(uci.get('firewall', 'wifiroam_guest_fwd_wan'), null);
  assert.equal(uci.get('firewall', 'wifiroam_guest_fwd_lan', 'dest'), 'lan');

  const uci2 = seedBase(new MockUci());
  const { ctx: ctx2 } = makeCtx({ uci: uci2, shell: makeShell() });
  createGuest(ctx2).guestWriteInfra({ ...baseCfg, allow_lan: true });
  assert.equal(uci2.get('firewall', 'wifiroam_guest_fwd_wan', 'dest'), 'wan');
  assert.equal(uci2.get('firewall', 'wifiroam_guest_fwd_lan', 'dest'), 'lan');
});

test('guestWriteInfra reuses existing guest zone instead of creating a new one', () => {
  const uci = seedBase(new MockUci());
  uci.seed('firewall', 'cfg0abc', 'zone', { name: 'guest', network: 'wifiroam_guest' });
  const { ctx } = makeCtx({ uci, shell: makeShell() });
  createGuest(ctx).guestWriteInfra(baseCfg);
  assert.equal(uci.get('firewall', 'wifiroam_guest_zone'), null);
  assert.equal(uci.get('firewall', 'cfg0abc', 'device'), 'br-guest');
  assert.equal(uci.get('firewall', 'cfg0abc', 'network'), null);
});

test('guestRemoveInfra: deletes interface/device/dhcp/zone/rules', () => {
  const uci = seedBase(new MockUci());
  uci.seed('network', 'wifiroam_guest', 'interface', { proto: 'static' });
  uci.seed('network', 'wifiroam_guest_dev', 'device', { type: 'bridge' });
  uci.seed('dhcp', 'wifiroam_guest', 'dhcp', { interface: 'wifiroam_guest' });
  uci.seed('firewall', 'cfgzone1', 'zone', { name: 'guest', network: 'wifiroam_guest' });
  uci.seed('firewall', 'wifiroam_guest_zone', 'zone', { name: 'guest', device: 'br-guest' });
  for (const s of ['wifiroam_guest_dhcp', 'wifiroam_guest_fwd_wan', 'wifiroam_guest_snat']) {
    uci.seed('firewall', s, 'rule', {});
  }
  const { ctx } = makeCtx({ uci, shell: makeShell() });
  createGuest(ctx).guestRemoveInfra();
  for (const [pkg, sec] of [
    ['network', 'wifiroam_guest'],
    ['network', 'wifiroam_guest_dev'],
    ['dhcp', 'wifiroam_guest'],
    ['firewall', 'cfgzone1'],
    ['firewall', 'wifiroam_guest_zone'],
    ['firewall', 'wifiroam_guest_dhcp'],
    ['firewall', 'wifiroam_guest_fwd_wan'],
    ['firewall', 'wifiroam_guest_snat'],
  ]) {
    assert.equal(uci.get(pkg, sec), null, `${pkg}.${sec} should be gone`);
  }
});

test('guestNftApply: CAP isolated -> delete+add table + guard, deduped by signature', () => {
  const uci = seedBase(new MockUci());
  const shell = makeShell();
  const { ctx, S } = makeCtx({ uci, shell, nowMin: 600 });
  const g = createGuest(ctx);
  g.guestNftApply(baseCfg);
  assert.deepEqual(shell.cmds, [
    'nft delete table inet wifiroam_guest 2>/dev/null',
    'nft add table inet wifiroam_guest 2>/dev/null',
    "nft add chain inet wifiroam_guest guard '{ type filter hook forward priority -20; policy accept; }' 2>/dev/null",
    'nft add rule inet wifiroam_guest guard iifname br-guest ip daddr 192.168.12.0/24 drop 2>/dev/null',
  ]);
  // second call with identical signature issues no commands
  g.guestNftApply(baseCfg);
  assert.equal(shell.cmds.length, 4);
  assert.notEqual(S._guest_nft_sig, '');
});

test('guestNftApply: disabled -> only delete table; allow_lan -> no guard chain', () => {
  const uci = seedBase(new MockUci());
  const shell = makeShell();
  const { ctx } = makeCtx({ uci, shell });
  const g = createGuest(ctx);
  g.guestNftApply({ ...baseCfg, enabled: false });
  assert.deepEqual(shell.cmds, ['nft delete table inet wifiroam_guest 2>/dev/null']);

  const shell2 = makeShell();
  const { ctx: ctx2 } = makeCtx({ uci, shell: shell2 });
  createGuest(ctx2).guestNftApply({ ...baseCfg, allow_lan: true });
  assert.deepEqual(shell2.cmds, [
    'nft delete table inet wifiroam_guest 2>/dev/null',
    'nft add table inet wifiroam_guest 2>/dev/null',
  ]);
});

test('guestNftApply: SAP isolated -> SNAT nat chain+rule before guard', () => {
  const uci = seedBase(new MockUci());
  const shell = makeShell();
  const { ctx } = makeCtx({ role: 'sap', uci, shell });
  createGuest(ctx).guestNftApply(baseCfg);
  assert.deepEqual(shell.cmds, [
    'nft delete table inet wifiroam_guest 2>/dev/null',
    'nft add table inet wifiroam_guest 2>/dev/null',
    "nft add chain inet wifiroam_guest nat '{ type nat hook postrouting priority srcnat; policy accept; }' 2>/dev/null",
    'nft add rule inet wifiroam_guest nat ip saddr 172.16.10.0/24 oifname br-lan snat ip to 192.168.12.1 2>/dev/null',
    "nft add chain inet wifiroam_guest guard '{ type filter hook forward priority -20; policy accept; }' 2>/dev/null",
    'nft add rule inet wifiroam_guest guard iifname br-guest ip daddr 192.168.12.0/24 drop 2>/dev/null',
  ]);
});

// ============================================================ netdevs / client ips
test('guestNetdevs: matches interfaces by SSID, ignores others', () => {
  const { ctx } = makeCtx({ shell: makeShell((cmd) => (cmd.startsWith('iw dev') ? IW_DEV_TWO_GUEST : '')) });
  const g = createGuest(ctx);
  assert.deepEqual(g.guestNetdevs('Guest'), ['phy0-ap1', 'phy1-ap1']);
  assert.deepEqual(g.guestNetdevs('MainWifi'), ['phy0-ap0']);
  assert.deepEqual(g.guestNetdevs('Nope'), []);
});

test('guestClientIps: leases + neigh, guest prefix only, dedup, excludes gateway', () => {
  const leases =
    '1780000000 aa:bb:cc:dd:ee:01 172.16.10.10 host-a *\n' +
    '1780000000 aa:bb:cc:dd:ee:02 172.16.10.11 host-b *\n' +
    '1780000000 aa:bb:cc:dd:ee:03 172.16.10.1 host-gw *\n' +
    '1780000000 aa:bb:cc:dd:ee:04 192.168.12.50 host-lan *\n' +
    'bad line\n';
  const neigh =
    '172.16.10.11 dev br-guest lladdr aa:bb:cc:dd:ee:02 REACHABLE\n' +
    '172.16.10.12 dev br-guest lladdr aa:bb:cc:dd:ee:05 STALE\n' +
    '192.168.12.51 dev br-guest lladdr aa:bb:cc:dd:ee:06 REACHABLE\n';
  const shell = makeShell((cmd) => (cmd.startsWith('ip neigh') ? neigh : ''));
  const { ctx } = makeCtx({ shell, leases });
  assert.deepEqual(createGuest(ctx).guestClientIps(), ['172.16.10.10', '172.16.10.11', '172.16.10.12']);
});

// ============================================================ tc
test('guestTcApply: bandwidth>0 builds htb qdisc + default class + per-IP class/filter', () => {
  const leases = '1780000000 aa:bb:cc:dd:ee:01 172.16.10.10 h1 *\n1780000000 aa:bb:cc:dd:ee:02 172.16.10.11 h2 *\n';
  const shell = makeShell((cmd) => {
    if (cmd.startsWith('iw dev')) return IW_DEV_TWO_GUEST;
    if (cmd.startsWith('tc qdisc show')) return ''; // no htb yet
    return '';
  });
  const { ctx, S } = makeCtx({ shell, leases });
  const g = createGuest(ctx);
  g.guestTcApply({ ...baseCfg, bandwidth: 10 });
  // per port: qdisc add, class 1:20, class 1:21 + filter, class 1:22 + filter
  const perPort = [
    'tc qdisc add dev phy0-ap1 root handle 1: htb default 20 2>/dev/null',
    'tc class add dev phy0-ap1 parent 1: classid 1:20 htb rate 10000kbit ceil 10000kbit 2>/dev/null',
    'tc class add dev phy0-ap1 parent 1: classid 1:21 htb rate 10000kbit ceil 10000kbit 2>/dev/null',
    'tc filter add dev phy0-ap1 parent 1: protocol ip prio 1 u32 match ip dst 172.16.10.10/32 flowid 1:21 2>/dev/null',
    'tc class add dev phy0-ap1 parent 1: classid 1:22 htb rate 10000kbit ceil 10000kbit 2>/dev/null',
    'tc filter add dev phy0-ap1 parent 1: protocol ip prio 1 u32 match ip dst 172.16.10.11/32 flowid 1:22 2>/dev/null',
  ];
  const expected = [...perPort, ...perPort.map((c) => c.replaceAll('phy0-ap1', 'phy1-ap1'))];
  const applied = shell.cmds.filter((c) => c.startsWith('tc qdisc add') || c.startsWith('tc class') || c.startsWith('tc filter'));
  assert.deepEqual(applied, expected);
  assert.deepEqual(S.guest_tc_devs, ['phy0-ap1', 'phy1-ap1']);
  // same signature + htb present -> no rebuild
  const n = shell.cmds.length;
  const shell2 = makeShell((cmd) => {
    if (cmd.startsWith('iw dev')) return IW_DEV_TWO_GUEST;
    if (cmd.startsWith('tc qdisc show')) return 'qdisc htb 1: root';
    return '';
  });
  const { ctx: ctx2, S: S2 } = makeCtx({ shell: shell2, leases });
  S2.guest_tc_sig = S.guest_tc_sig;
  S2.guest_tc_devs = [...S.guest_tc_devs];
  createGuest(ctx2).guestTcApply({ ...baseCfg, bandwidth: 10 });
  assert.equal(shell2.cmds.filter((c) => c.startsWith('tc qdisc add')).length, 0);
  assert.ok(n > 0);
});

test('guestTcApply: bandwidth 0 cleans up existing qdiscs; idle with nothing -> silent', () => {
  const shell = makeShell((cmd) => (cmd.startsWith('tc qdisc show') ? '' : ''));
  const { ctx, S } = makeCtx({ shell });
  S.guest_tc_devs = ['phy0-ap1'];
  const g = createGuest(ctx);
  g.guestTcApply({ ...baseCfg, bandwidth: 0 });
  assert.ok(shell.cmds.includes('tc qdisc del dev phy0-ap1 root 2>/dev/null'));
  assert.ok(shell.cmds.includes('tc qdisc del dev br-guest root 2>/dev/null'));
  assert.deepEqual(S.guest_tc_devs, []);
  assert.equal(S.guest_tc_sig, '');

  const shell2 = makeShell((cmd) => (cmd.startsWith('tc qdisc show') ? '' : ''));
  const { ctx: ctx2 } = makeCtx({ shell: shell2 });
  createGuest(ctx2).guestTcApply({ ...baseCfg, bandwidth: 0 });
  assert.deepEqual(shell2.cmds, ['tc qdisc show dev br-guest 2>/dev/null']);
});

test('guestTcCleanup: keeps listed devs, deletes the rest + bridge', () => {
  const shell = makeShell();
  const { ctx, S } = makeCtx({ shell });
  S.guest_tc_devs = ['phy0-ap1', 'phy1-ap1'];
  createGuest(ctx).guestTcCleanup(['phy0-ap1']);
  assert.deepEqual(shell.cmds, [
    'tc qdisc del dev phy1-ap1 root 2>/dev/null',
    'tc qdisc del dev br-guest root 2>/dev/null',
  ]);
  assert.deepEqual(S.guest_tc_devs, ['phy0-ap1']);
});

// ============================================================ port sync
test('guestPortSync: disabled -> deletes bridge device, calls cb', () => {
  const uci = seedBase(new MockUci());
  uci.seed('network', 'wifiroam_guest_dev', 'device', { type: 'bridge', name: 'br-guest' });
  const { ctx } = makeCtx({ uci, shell: makeShell() });
  let called = 0;
  createGuest(ctx).guestPortSync({ ...baseCfg, enabled: false }, () => called++);
  assert.equal(uci.get('network', 'wifiroam_guest_dev'), null);
  assert.equal(called, 1);
});

test('guestPortSync: ports found -> bridge ports set, cb called', () => {
  const uci = seedBase(new MockUci());
  const shell = makeShell((cmd) => (cmd.startsWith('iw dev') ? IW_DEV_TWO_GUEST : ''));
  const { ctx } = makeCtx({ uci, shell, nowMin: 600 });
  let called = 0;
  createGuest(ctx).guestPortSync(baseCfg, () => called++, 0);
  assert.deepEqual(uci.get('network', 'wifiroam_guest_dev', 'ports'), ['phy0-ap1', 'phy1-ap1']);
  assert.equal(uci.get('network', 'wifiroam_guest_dev', 'name'), 'br-guest');
  assert.equal(called, 1);
});

test('guestPortSync: no ports -> retries on 1000ms timer, gives up after 10 tries', () => {
  const uci = seedBase(new MockUci());
  const shell = makeShell(() => '');
  const timer = makeTimer();
  const { ctx } = makeCtx({ uci, shell, nowMin: 600, timer });
  let called = 0;
  const g = createGuest(ctx);
  g.guestPortSync(baseCfg, () => called++, 0);
  assert.equal(called, 0);
  assert.equal(timer.pending.length, 1);
  assert.equal(timer.pending[0].ms, 1000);
  // 9 more retries, then the 10th attempt (tries=10) writes the bridge and calls cb
  for (let i = 0; i < 9; i++) timer.runOne();
  assert.equal(called, 0);
  assert.equal(timer.pending.length, 1);
  timer.runOne();
  assert.equal(called, 1);
  assert.equal(timer.pending.length, 0);
  assert.equal(uci.get('network', 'wifiroam_guest_dev', 'ports'), null);
});

// ============================================================ apply / tick
test('applyGuestLocal (enabled): writes wireless+infra, reload chain, nft+tc after reload', () => {
  const uci = seedBase(new MockUci());
  const shell = makeShell((cmd) => {
    if (cmd.startsWith('iw dev')) return IW_DEV_TWO_GUEST;
    if (cmd.startsWith('tc qdisc show')) return '';
    return '';
  });
  const { ctx, S } = makeCtx({ uci, shell, nowMin: 600 });
  const g = createGuest(ctx);
  assert.deepEqual(g.applyGuestLocal(baseCfg), { ok: true });
  assert.equal(S.guest_open, true);
  assert.notEqual(uci.get('wireless', 'wifiroam_guest_radio0'), null);
  assert.notEqual(uci.get('network', 'wifiroam_guest'), null);
  assert.deepEqual(uci.get('network', 'wifiroam_guest_dev', 'ports'), ['phy0-ap1', 'phy1-ap1']);
  assert.deepEqual(
    shell.procs.map(([p, a]) => `${p} ${a.join(' ')}`),
    [
      '/etc/init.d/network reload',
      '/sbin/wifi reload',
      '/etc/init.d/network reload',
      '/etc/init.d/dnsmasq reload',
      '/etc/init.d/firewall reload',
    ],
  );
  assert.ok(shell.cmds.includes('nft add table inet wifiroam_guest 2>/dev/null'));
  assert.ok(shell.cmds.some((c) => c.startsWith('tc qdisc add dev phy0-ap1')));
});

test('applyGuestLocal (disabled): removes infra, still returns ok', () => {
  const uci = seedBase(new MockUci());
  uci.seed('network', 'wifiroam_guest', 'interface', { proto: 'static' });
  const shell = makeShell();
  const { ctx, S } = makeCtx({ uci, shell, nowMin: 600 });
  assert.deepEqual(createGuest(ctx).applyGuestLocal({ ...baseCfg, enabled: false }), { ok: true });
  assert.equal(S.guest_open, false);
  assert.equal(uci.get('network', 'wifiroam_guest'), null);
});

test('guestAfterReload: dnsmasq + firewall reloads, nft+tc after firewall', () => {
  const uci = seedBase(new MockUci());
  const shell = makeShell((cmd) => {
    if (cmd.startsWith('iw dev')) return IW_DEV_TWO_GUEST;
    if (cmd.startsWith('tc qdisc show')) return '';
    return '';
  });
  const { ctx, S } = makeCtx({ uci, shell });
  S.guest_tc_sig = 'stale';
  createGuest(ctx).guestAfterReload(baseCfg);
  assert.deepEqual(
    shell.procs.map(([p]) => p),
    ['/etc/init.d/dnsmasq', '/etc/init.d/firewall'],
  );
  assert.ok(shell.cmds.includes('nft add table inet wifiroam_guest 2>/dev/null'));
  assert.notEqual(S.guest_tc_sig, 'stale');
});

test('guestTick: unconfigured role is a no-op', () => {
  const uci = seedBase(new MockUci());
  const shell = makeShell();
  const { ctx, S } = makeCtx({ role: 'unconfigured', uci, shell });
  createGuest(ctx).guestTick();
  assert.equal(shell.cmds.length, 0);
  assert.equal(shell.procs.length, 0);
  assert.equal(S.guest_open, null);
});

test('guestTick: disabled guest -> guest_open false, nft table deleted', () => {
  const uci = seedBase(new MockUci(), { guest: { enabled: '0' } });
  const shell = makeShell();
  const { ctx, S } = makeCtx({ uci, shell });
  createGuest(ctx).guestTick();
  assert.equal(S.guest_open, false);
  assert.equal(S.guest_tc_sig, '');
  assert.deepEqual(shell.cmds, ['nft delete table inet wifiroam_guest 2>/dev/null']);
});

test('guestTick: first run only records open state, no reload', () => {
  const uci = seedBase(new MockUci());
  const shell = makeShell();
  const { ctx, S } = makeCtx({ uci, shell, nowMin: 600 });
  S._guest_zone_migrated = true;
  createGuest(ctx).guestTick();
  assert.equal(S.guest_open, true);
  assert.equal(shell.procs.length, 0);
});

test('guestTick: same open state -> tc sync only, no wifi reload', () => {
  const uci = seedBase(new MockUci());
  const shell = makeShell((cmd) => {
    if (cmd.startsWith('iw dev')) return IW_DEV_TWO_GUEST;
    if (cmd.startsWith('tc qdisc show')) return '';
    return '';
  });
  const { ctx, S } = makeCtx({ uci, shell, nowMin: 600 });
  S._guest_zone_migrated = true;
  S.guest_open = true;
  createGuest(ctx).guestTick();
  assert.equal(shell.procs.length, 0);
  assert.ok(shell.cmds.some((c) => c.startsWith('tc qdisc add dev phy0-ap1')));
});

test('guestTick: open->closed flips disabled, emits guest_schedule, reload chain runs', () => {
  const uci = seedBase(new MockUci());
  uci.seed('wireless', 'wifiroam_guest_radio0', 'wifi-iface', {
    device: 'radio0',
    wifiroam_guest: '1',
    disabled: '0',
  });
  const shell = makeShell((cmd) => {
    if (cmd.startsWith('iw dev')) return IW_DEV_TWO_GUEST;
    if (cmd.startsWith('tc qdisc show')) return '';
    return '';
  });
  // nowMin 60 = 01:00, outside 08:00-23:00
  const { ctx, S, pushed } = makeCtx({ uci, shell, nowMin: 60 });
  S._guest_zone_migrated = true;
  S.guest_open = true;
  createGuest(ctx).guestTick();
  assert.equal(S.guest_open, false);
  assert.equal(uci.get('wireless', 'wifiroam_guest_radio0', 'disabled'), '1');
  assert.deepEqual(pushed, [{ type: 'guest_schedule', mac: '', info: 'closed', name: undefined }]);
  assert.deepEqual(
    shell.procs.map(([p, a]) => `${p} ${a.join(' ')}`),
    ['/sbin/wifi reload', '/etc/init.d/network reload', '/etc/init.d/dnsmasq reload', '/etc/init.d/firewall reload'],
  );
});

test('guestTick: legacy zone (network/subnet) triggers one-time migration + firewall reload', () => {
  const uci = seedBase(new MockUci());
  uci.seed('firewall', 'wifiroam_guest_zone', 'zone', {
    name: 'guest',
    network: 'wifiroam_guest',
    subnet: '172.16.10.0/24',
  });
  const shell = makeShell();
  const { ctx, S } = makeCtx({ uci, shell, nowMin: 600 });
  assert.equal(S._guest_zone_migrated, false);
  createGuest(ctx).guestTick();
  assert.equal(S._guest_zone_migrated, true);
  assert.equal(uci.get('firewall', 'wifiroam_guest_zone', 'device'), 'br-guest');
  assert.equal(uci.get('firewall', 'wifiroam_guest_zone', 'network'), null);
  assert.ok(shell.cmds.includes('/etc/init.d/firewall reload 2>/dev/null'));
  // second tick: migration flag set, no rewrite / no second firewall reload.
  // (The idle tc probe still issues 'iw dev' + 'tc qdisc show dev br-guest',
  // so only assert no new nft / firewall-reload commands.)
  const nftAndReload = shell.cmds.filter((c) => c.startsWith('nft') || c.includes('firewall reload'));
  createGuest(ctx).guestTick();
  assert.deepEqual(
    shell.cmds.filter((c) => c.startsWith('nft') || c.includes('firewall reload')),
    nftAndReload,
  );
});

// ============================================================ push handler
test('handlePushGuestConfig: invalid config rejected, valid config saved + applied', () => {
  const uci = seedBase(new MockUci());
  const shell = makeShell((cmd) => {
    if (cmd.startsWith('iw dev')) return IW_DEV_TWO_GUEST;
    if (cmd.startsWith('tc qdisc show')) return '';
    return '';
  });
  const { ctx } = makeCtx({ role: 'sap', uci, shell, nowMin: 600 });
  const g = createGuest(ctx);
  assert.deepEqual(g.handlePushGuestConfig({ ...baseCfg, ssid: '' }), { ok: false, error: 'invalid' });
  assert.deepEqual(g.handlePushGuestConfig({ ...baseCfg, ssid: 'Guest2', ver: 9 }), { ok: true });
  assert.equal(uci.get('wifiroam', 'guest', 'ssid'), 'Guest2');
  assert.equal(uci.get('wifiroam', 'guest', 'config_ver'), '9');
  assert.notEqual(uci.get('wireless', 'wifiroam_guest_radio0'), null);
});

test('constants: guest subnet defaults match spec', () => {
  assert.equal(GUEST_IP, '172.16.10.1');
  assert.equal(GUEST_NET, '172.16.10.0/24');
});
