// daemon-wifi.test.mjs -- node:test suite for daemon/wifi.mjs.
// ubus / uci / shell 一律 mock；覆盖：RSSI 预设与阈值、漫游配置签名
// 比对、SSID 改名、引导冷却与最短稳定时间、回程配置、固定 AP、
// Wi-Fi 前台改名/密码、邻居同步去重、首次默认漫游。
// Run: node --test tests/daemon-wifi.test.mjs (from ~/workspace/wifiroam-js)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createWifi } from '../daemon/wifi.mjs';
import { createClients } from '../daemon/clients.mjs';
import { nowSeconds, sha256, maccolon } from '../lib/util.js';

// ------------------------------------------------------------ fake UCI
// 内存版 UCI：section = { '.name', '.type', ...options }，语义与
// lib/uci.js 的 CLI 包装一致（get 缺失回 null；set 数组 = 替换列表；
// foreach 只访问指定类型；commit 恒 true）。
class FakeUci {
  constructor(seed = {}) {
    // seed: { pkg: { sid: { '.type': t, opt: v } } }
    this.pkgs = {};
    for (const [pkg, secs] of Object.entries(seed)) {
      this.pkgs[pkg] = {};
      for (const [sid, sec] of Object.entries(secs)) {
        this.pkgs[pkg][sid] = { '.name': sid, ...sec };
      }
    }
    this.commits = [];
    this.sets = [];
  }

  load() { return true; }

  _sec(pkg, sid) { return this.pkgs[pkg]?.[sid] ?? null; }

  get(pkg, section, option) {
    const sec = this._sec(pkg, section);
    if (!sec) return null;
    if (option === undefined) return sec;
    const v = sec[option];
    return v === undefined ? null : v;
  }

  getList(pkg, section, option) {
    const v = this.get(pkg, section, option);
    if (Array.isArray(v)) return v;
    if (typeof v === 'string' && v !== '') return [v];
    return [];
  }

  set(pkg, section, option, value) {
    this.sets.push([pkg, section, option, value]);
    if (value === undefined) {
      // 三参数式：建指定类型、指定名的 section
      this.pkgs[pkg] ??= {};
      this.pkgs[pkg][section] = { '.name': section, '.type': option };
      return true;
    }
    const sec = this._sec(pkg, section);
    if (!sec) return false;
    sec[option] = Array.isArray(value) ? [...value] : value;
    return true;
  }

  add(pkg, type, name) {
    this.pkgs[pkg] ??= {};
    const sid = name ?? `cfg${Math.floor(Math.random() * 0xffffffff).toString(16)}`;
    this.pkgs[pkg][sid] = { '.name': sid, '.type': type };
    return sid;
  }

  delete(pkg, section, option) {
    const sec = this._sec(pkg, section);
    if (!sec) return false;
    if (option === undefined) { delete this.pkgs[pkg][section]; return true; }
    delete sec[option];
    return true;
  }

  commit(pkg) { this.commits.push(pkg); return true; }

  foreach(pkg, type, cb) {
    let n = 0;
    for (const sec of Object.values(this.pkgs[pkg] ?? {})) {
      if (sec['.type'] !== type) continue;
      n++;
      cb(sec);
    }
    return n;
  }
}

// ------------------------------------------------------------ fake bus
class FakeBus {
  constructor(handlers = {}) {
    this.handlers = handlers; // "path.method" -> value | fn(data) | Error
    this.calls = []; // [{ path, method, data }]
  }

  async call(path, method, data) {
    this.calls.push({ path, method, data });
    const h = this.handlers[`${path}.${method}`];
    if (h instanceof Error) throw h;
    if (typeof h === 'function') return h(data);
    return h ?? null;
  }
}

// ------------------------------------------------------------ canonical pin
// pin 的唯一实现在 clients：这里每个 wifi 实例都从同一份 S 上建一个
// 真实的 clients 模块，取其 pinOf / pinApply 注入（合拢去重后 wifi
// 不再自带 pin 实现，工厂缺 pinOf 即抛）。store.saveAliases 用空实现，
// 避免 pinApply 落盘碰 /etc/wifiroam。
function canonicalPin(S, uci, shell) {
  const clients = createClients({
    S, uci: uci ?? new FakeUci(), shell: shell ?? fakeShell(),
    store: { saveAliases: () => true },
  });
  return { pinOf: clients.pinOf, pinApply: clients.pinApply, clients };
}

function makeWifi(opts) {
  const pin = canonicalPin(opts.S, opts.uci, opts.shell);
  return createWifi({ ...opts, pinOf: pin.pinOf, pinApply: pin.pinApply });
}

// ------------------------------------------------------------ fake shell
function fakeShell({ cmdMap = {}, runProcessCode = 0 } = {}) {
  const cmds = [];
  const procs = [];
  return {
    cmds,
    procs,
    cmdOutput(cmd) {
      cmds.push(cmd);
      for (const [pat, out] of Object.entries(cmdMap)) {
        if (cmd.includes(pat)) return out;
      }
      return '';
    },
    async runProcess(path, args, opts = {}) {
      procs.push([path, args]);
      if (typeof opts.onExit === 'function') opts.onExit(runProcessCode);
      return runProcessCode;
    },
  };
}

const fakeFs = (files = {}, accessPaths = new Set()) => ({
  readFile: (p) => (p in files ? files[p] : null),
  glob: (pat) => {
    if (pat === '/sys/class/net/*/address') {
      return Object.keys(files).filter((p) => p.startsWith('/sys/class/net/') && p.endsWith('/address'));
    }
    return [];
  },
  access: (p) => accessPaths.has(p),
});

function baseState(over = {}) {
  return {
    cfg: { enabled: true, role: 'cap', token: 'tok123', cap_ip: '', name: 'CAP' },
    self: { mac: 'AA:BB:CC:DD:EE:01', ip: '192.168.12.1', name: 'CAP', hostname: 'OpenWrt', model: 'AP8220', firmware: 'OpenWrt', nonce: '0123456789abcdef', ifaces: {} },
    brdev: 'br-lan',
    peers: {},
    discovered: {},
    aliases: { ver: 1, map: {}, groups: {}, redirect: {}, isolated: {}, pin: {} },
    device_index: {},
    pin_last: {},
    roam_ver_applied: 0,
    backhaul_ver_applied: 0,
    last_apply: null,
    last_backhaul: null,
    last_wifi: null,
    steer_last: {},
    steer_tries: {},
    kick_last: {},
    steer_mute: {},
    nr_sig: '',
    cap_nr: [],
    net_names: {},
    roster: null,
    events: [],
    ...over,
  };
}

function wirelessSeed(ifaces = [], devices = []) {
  const secs = {};
  for (const [i, s] of ifaces.entries()) {
    secs[`iface${i}`] = { '.type': 'wifi-iface', ...s };
  }
  for (const [i, s] of devices.entries()) {
    secs[`radio${i}`] = { '.type': 'wifi-device', ...s };
  }
  return { wireless: secs };
}

function roamSeed(over = {}) {
  return {
    wifiroam: {
      roam: {
        '.type': 'roam', enabled: '1', ft_mode: 'simple', ft_over_ds: '1',
        k_neighbor: '1', k_beacon: '1', v_bss_transition: '1',
        rssi_profile: 'balanced', rssi_threshold: '-70', config_ver: '3',
        ssids: ['HomeWiFi'], ...over,
      },
      backhaul: { '.type': 'backhaul', enabled: '0', ssid: 'wifiroam-bh', key: '', device: '', config_ver: '0' },
    },
  };
}

// sha256 原版 roam_sig 格式的期望值（独立按 spec §2 格式串算出）
function expectedRoamSig(r) {
  const s = `${r.enabled ? 1 : 0}|${(r.ssids ?? []).join(',')}|${r.r_fast ? 1 : 0}|`
    + `${r.ft_mode ?? 'simple'}|${r.ft_over_ds ? 1 : 0}|${r.k_neighbor ? 1 : 0}|`
    + `${r.k_beacon ? 1 : 0}|${r.v_bss_transition ? 1 : 0}|${r.rssi_profile ?? 'balanced'}|`
    + `${r.rssi_threshold ?? -70}`;
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// ============================================================ RSSI 预设与阈值
test('rssi_preset：三档阈值与未知档回落 balanced', () => {
  const wifi = makeWifi({ S: baseState(), uci: new FakeUci(), shell: fakeShell() });
  assert.equal(wifi.rssiPreset('aggressive'), -62);
  assert.equal(wifi.rssiPreset('balanced'), -70);
  assert.equal(wifi.rssiPreset('conservative'), -78);
  assert.equal(wifi.rssiPreset('weird'), -70);
  assert.equal(wifi.rssiPreset(undefined), -70);
});

test('current_roam_cfg：非 custom 档位强制取 preset，阈值夹取 -95..-30', () => {
  const uci = new FakeUci(roamSeed({ rssi_profile: 'aggressive', rssi_threshold: '-99' }));
  const wifi = makeWifi({ S: baseState(), uci, shell: fakeShell() });
  const c = wifi.currentRoamCfg();
  assert.equal(c.rssi_profile, 'aggressive');
  assert.equal(c.rssi_threshold, -62); // 非 custom：preset 覆盖 UCI 写死的 -99
  assert.equal(c.enabled, true);
  assert.deepEqual(c.ssids, ['HomeWiFi']);
  assert.equal(c.config_ver, 3);
  // custom 档位保留 UCI 阈值，但仍夹取
  const uci2 = new FakeUci(roamSeed({ rssi_profile: 'custom', rssi_threshold: '-10' }));
  const wifi2 = makeWifi({ S: baseState(), uci: uci2, shell: fakeShell() });
  assert.equal(wifi2.currentRoamCfg().rssi_threshold, -30);
  const uci3 = new FakeUci(roamSeed({ rssi_profile: 'custom', rssi_threshold: '-100' }));
  const wifi3 = makeWifi({ S: baseState(), uci: uci3, shell: fakeShell() });
  assert.equal(wifi3.currentRoamCfg().rssi_threshold, -95);
});

test('current_roam_cfg：非法 profile 回落 balanced；r_fast 缺失时默认开（§9.3 字面比较）', () => {
  const uci = new FakeUci(roamSeed({ rssi_profile: 'turbo' }));
  const wifi = makeWifi({ S: baseState(), uci, shell: fakeShell() });
  const c = wifi.currentRoamCfg();
  assert.equal(c.rssi_profile, 'balanced');
  assert.equal(c.rssi_threshold, -70);
  assert.equal(c.r_fast, true); // 默认配置无 r_fast 行，null != "0" 为 true
  const uci2 = new FakeUci(roamSeed({ r_fast: '0' }));
  const wifi2 = makeWifi({ S: baseState(), uci: uci2, shell: fakeShell() });
  assert.equal(wifi2.currentRoamCfg().r_fast, false);
});

test('current_roam_cfg：ssids 字符串单值包成数组，缺失为空数组', () => {
  const uci = new FakeUci(roamSeed({ ssids: 'Solo' }));
  const wifi = makeWifi({ S: baseState(), uci, shell: fakeShell() });
  assert.deepEqual(wifi.currentRoamCfg().ssids, ['Solo']);
  const uci2 = new FakeUci({ wifiroam: { roam: { '.type': 'roam' } } });
  const wifi2 = makeWifi({ S: baseState(), uci: uci2, shell: fakeShell() });
  const c2 = wifi2.currentRoamCfg();
  assert.deepEqual(c2.ssids, []);
  assert.equal(c2.enabled, false);
  assert.equal(c2.ft_mode, 'simple');
});

// ============================================================ 漫游配置签名比对
test('roam_sig：与 spec 格式串逐字节一致，任一字段变化签名即变', () => {
  const wifi = makeWifi({ S: baseState(), uci: new FakeUci(), shell: fakeShell() });
  const r = {
    enabled: true, ssids: ['HomeWiFi', 'Guest'], r_fast: true, ft_mode: 'explicit',
    ft_over_ds: true, k_neighbor: true, k_beacon: false, v_bss_transition: true,
    rssi_profile: 'balanced', rssi_threshold: -70,
  };
  assert.equal(wifi.roamSig(r), expectedRoamSig(r));
  assert.equal(wifi.roamSig(r), sha256('1|HomeWiFi,Guest|1|explicit|1|1|0|1|balanced|-70'));
  // 只改一个开关，签名必须变（CAP 靠它发现历史遗留不一致）
  assert.notEqual(wifi.roamSig({ ...r, k_beacon: true }), wifi.roamSig(r));
  assert.notEqual(wifi.roamSig({ ...r, rssi_threshold: -62 }), wifi.roamSig(r));
  assert.notEqual(wifi.roamSig({ ...r, ssids: ['HomeWiFi'] }), wifi.roamSig(r));
});

test('roam_md / roam_key0 / roam_key1：派生格式与原版一致', () => {
  const S = baseState();
  const wifi = makeWifi({ S, uci: new FakeUci(), shell: fakeShell() });
  assert.equal(wifi.roamMd('HomeWiFi'), sha256('md:HomeWiFi').slice(0, 4));
  assert.equal(wifi.roamKey0('aa:bb:cc:dd:ee:02'), sha256('tok123:r0:aabbccdde e02'.replace(' ', '')).slice(0, 32));
  assert.equal(wifi.roamKey0('AA:BB:CC:DD:EE:02'), sha256('tok123:r0:aabbccdde e02'.replace(' ', '')).slice(0, 32));
  assert.equal(wifi.roamKey1('aabbccddeeff'), sha256('tok123:r1:aabbccddeeff').slice(0, 32));
  assert.equal(wifi.roamKey0('aabbccddeeff').length, 32);
});

// ============================================================ 漫游配置应用
function roamApplySetup({ ftMode = 'explicit', rFast = true, extraIface = {} } = {}) {
  const uci = new FakeUci({
    ...wirelessSeed([
      { ssid: 'HomeWiFi', mode: 'ap', device: 'radio0', encryption: 'psk2', ...extraIface },
      { ssid: 'OtherNet', mode: 'ap', device: 'radio1', encryption: 'psk2', ieee80211r: '1', ieee80211k: '1', ieee80211v: '1' },
      { ssid: 'Guest', mode: 'ap', device: 'radio0', encryption: 'psk2', wifiroam_guest: '1' },
    ]),
    ...roamSeed(),
  });
  const S = baseState();
  S.peers = { aabbccddeeff: { authed: true, mac: 'AA:BB:CC:DD:EE:FF', name: 'SAP1' } };
  const shell = fakeShell();
  const wifi = makeWifi({ S, uci, shell });
  return { uci, S, shell, wifi };
}

test('apply_roam_local explicit：写 r0kh/r1kh/nas_identifier，访客口与非漫游组不动/只清键', () => {
  const { uci, S, wifi } = roamApplySetup();
  const roam = {
    enabled: true, ssids: ['HomeWiFi'], r_fast: true, ft_mode: 'explicit',
    ft_over_ds: true, k_neighbor: true, k_beacon: false, v_bss_transition: true,
    rssi_profile: 'balanced', rssi_threshold: -70, config_ver: 4,
  };
  const res = wifi.applyRoamLocal(roam, wifi.memberList());
  assert.equal(res.ok, true);
  assert.deepEqual(res.touched, ['HomeWiFi']);
  assert.equal(S.roam_ver_applied, 4);
  const home = uci.get('wireless', 'iface0');
  assert.equal(home.ieee80211r, '1');
  assert.equal(home.mobility_domain, sha256('md:HomeWiFi').slice(0, 4));
  assert.equal(home.ft_psk_generate_local, '0');
  assert.equal(home.nas_identifier, 'AABBCCDDEE01-HomeWiFi');
  assert.equal(home.pmk_r1_push, '1');
  assert.equal(home.ieee80211k, '1');
  assert.equal(home.rrm_neighbor_report, '1');
  assert.equal(home.rrm_beacon_report, '0');
  assert.equal(home.ieee80211v, '1');
  assert.equal(home.bss_transition, '1');
  // r0kh/r1kh：本机 + 已认证 peer 各一条，格式 "<MAC>,<大写MAC>-<SSID>,<key32>"
  assert.equal(home.r0kh.length, 2);
  assert.match(home.r0kh[0], /^AA:BB:CC:DD:EE:01,AABBCCDDEE01-HomeWiFi,[0-9a-f]{32}$/);
  assert.match(home.r1kh[1], /^AA:BB:CC:DD:EE:FF,AA:BB:CC:DD:EE:FF,[0-9a-f]{32}$/);
  // 非漫游组：现含 r/k/v 键，全部 ROAM_KEYS 被删
  const other = uci.get('wireless', 'iface1');
  assert.equal(other.ieee80211r, undefined);
  assert.equal(other.ieee80211k, undefined);
  assert.equal(other.ieee80211v, undefined);
  // 访客口不碰
  assert.equal(uci.get('wireless', 'iface2').ieee80211r, undefined);
  // wifiroam roam 段整份落盘
  assert.equal(uci.get('wifiroam', 'roam', 'config_ver'), '4');
  assert.equal(uci.get('wifiroam', 'roam', 'ft_mode'), 'explicit');
});


test('apply_roam_local simple：ft_psk_generate_local=1 并删 explicit 四键', () => {
  const { uci, S, wifi } = roamApplySetup();
  // 先放 explicit 残留，确认 simple 会删掉
  uci.set('wireless', 'iface0', 'nas_identifier', 'X-HomeWiFi');
  uci.set('wireless', 'iface0', 'r0kh', ['x']);
  const roam = {
    enabled: true, ssids: ['HomeWiFi'], r_fast: true, ft_mode: 'simple',
    ft_over_ds: false, k_neighbor: false, k_beacon: true, v_bss_transition: false,
    rssi_profile: 'balanced', rssi_threshold: -70, config_ver: 5,
  };
  wifi.applyRoamLocal(roam, wifi.memberList());
  const home = uci.get('wireless', 'iface0');
  assert.equal(home.ft_psk_generate_local, '1');
  assert.equal(home.nas_identifier, undefined);
  assert.equal(home.pmk_r1_push, undefined);
  assert.equal(home.r0kh, undefined);
  assert.equal(home.r1kh, undefined);
  assert.equal(home.ft_over_ds, '0');
  assert.equal(home.rrm_neighbor_report, '0');
  assert.equal(home.bss_transition, '0');
  assert.equal(S.roam_ver_applied, 5);
});

test('apply_roam_local r_fast 关闭：只保留 K/V，FT 键全删', () => {
  const { uci, wifi } = roamApplySetup();
  const roam = {
    enabled: true, ssids: ['HomeWiFi'], r_fast: false, ft_mode: 'explicit',
    ft_over_ds: true, k_neighbor: true, k_beacon: true, v_bss_transition: true,
    rssi_profile: 'balanced', rssi_threshold: -70, config_ver: 6,
  };
  wifi.applyRoamLocal(roam, wifi.memberList());
  const home = uci.get('wireless', 'iface0');
  assert.equal(home.ieee80211r, undefined);
  assert.equal(home.mobility_domain, undefined);
  assert.equal(home.ft_psk_generate_local, undefined);
  assert.equal(home.ieee80211k, '1');
  assert.equal(home.ieee80211v, '1');
});

test('apply_roam_local：漫游关闭时组内口也按非组处理；reload 进程与 roam_apply 事件', async () => {
  const { uci, S, shell, wifi } = roamApplySetup();
  const roam = {
    enabled: false, ssids: ['HomeWiFi'], r_fast: true, ft_mode: 'simple',
    ft_over_ds: true, k_neighbor: true, k_beacon: true, v_bss_transition: true,
    rssi_profile: 'balanced', rssi_threshold: -70, config_ver: 7,
  };
  const res = wifi.applyRoamLocal(roam, []);
  assert.deepEqual(res.touched, []);
  assert.equal(uci.get('wireless', 'iface0').ieee80211r, undefined);
  assert.deepEqual(shell.procs, [['/sbin/wifi', ['reload']]]);
  assert.equal(S.events.at(-1).type, 'roam_apply');
  assert.match(S.events.at(-1).info, /ver=7 ssids=0/);
});

test('applied_kvr：按落盘值逐项判定，无匹配 SSID 时全 false', () => {
  const uci = new FakeUci(wirelessSeed([
    { ssid: 'HomeWiFi', mode: 'ap', device: 'radio0', ieee80211r: '1', mobility_domain: 'abcd', ieee80211k: '1', rrm_neighbor_report: '1', ieee80211v: '1', bss_transition: '1' },
    { ssid: 'HomeWiFi', mode: 'ap', device: 'radio1', ieee80211r: '1', mobility_domain: 'abcd', ieee80211k: '1', rrm_neighbor_report: '0', ieee80211v: '1', bss_transition: '1' },
  ]));
  const wifi = makeWifi({ S: baseState(), uci, shell: fakeShell() });
  // 第二口 rrm_neighbor_report=0 → k 为 false；r/v 为 true
  assert.deepEqual(wifi.appliedKvr(['HomeWiFi']), { r: true, k: false, v: true, seen: 2 });
  assert.deepEqual(wifi.appliedKvr(['NoSuch']), { r: false, k: false, v: false, seen: 0 });
});

// ============================================================ SSID 改名
test('roam_rename_ssids：旧名→新名替换、补齐新名、去重；无有效对时不动 UCI', () => {
  const uci = new FakeUci(roamSeed({ ssids: ['Old2G', 'Old5G'] }));
  const wifi = makeWifi({ S: baseState(), uci, shell: fakeShell() });
  wifi.roamRenameSsids([{ old: 'Old2G', new: 'HomeWiFi' }, { old: 'Old5G', new: 'HomeWiFi' }]);
  assert.deepEqual(uci.get('wifiroam', 'roam', 'ssids'), ['HomeWiFi']); // 两频段并一，去重
  const setsBefore = uci.sets.length;
  wifi.roamRenameSsids([{ old: '', new: 'X' }, { old: 'A', new: 'A' }]);
  assert.equal(uci.sets.length, setsBefore); // hit==0，直接返回
  // 补齐：新名不在列表时追加
  wifi.roamRenameSsids([{ old: 'HomeWiFi', new: 'NewName' }, { old: 'Missing', new: 'Extra' }]);
  assert.deepEqual(uci.get('wifiroam', 'roam', 'ssids'), ['NewName', 'Extra']);
});

// ============================================================ Wi-Fi 前台
test('wifi_summary：unified/mixed/has_key 判定，密码不对外返回', () => {
  const uci = new FakeUci(wirelessSeed([
    { ssid: 'HomeWiFi', mode: 'ap', device: 'radio0', encryption: 'psk2', key: 'secret123' },
    { ssid: 'HomeWiFi', mode: 'ap', device: 'radio1', encryption: 'psk2', key: 'secret123' },
    { ssid: 'Guest', mode: 'ap', device: 'radio0', encryption: 'psk2', wifiroam_guest: '1', key: 'guest123' },
    { ssid: 'STA', mode: 'sta', device: 'radio1' },
  ]));
  const wifi = makeWifi({ S: baseState(), uci, shell: fakeShell() });
  const s = wifi.wifiSummary();
  assert.equal(s.ssid, 'HomeWiFi');
  assert.equal(s.has_key, true);
  assert.equal(s.unified, true);
  assert.equal(s.mixed, false);
  assert.equal(s.ifaces.length, 2); // 访客口与 sta 口均排除
  assert.equal(JSON.stringify(s).includes('secret123'), false);
  assert.equal(JSON.stringify(s).includes('guest123'), false);
});

test('apply_wifi_local：按频段改名改密、空 key 不动密码、开放口补 psk2、延迟 reload', () => {
  const uci = new FakeUci(wirelessSeed([
    { ssid: 'Old2G', mode: 'ap', device: 'radio0', encryption: 'none', key: '' },
    { ssid: 'Old5G', mode: 'ap', device: 'radio1', encryption: 'psk2', key: 'oldpass99' },
    { ssid: 'Guest', mode: 'ap', device: 'radio0', wifiroam_guest: '1', key: 'guest' },
  ], [
    { band: '2g' }, { band: '5g' },
  ]));
  // FakeUci 的 get('wireless', device, 'band') 需 radio section 存在
  uci.pkgs.wireless.radio0 = { '.name': 'radio0', '.type': 'wifi-device', band: '2g' };
  uci.pkgs.wireless.radio1 = { '.name': 'radio1', '.type': 'wifi-device', band: '5g' };
  const shell = fakeShell();
  const wifi = makeWifi({ S: baseState(), uci, shell });
  const res = wifi.applyWifiLocal([
    { band: '2g', ssid: 'HomeWiFi', key: 'newpass99' },
    { band: '5g', ssid: 'HomeWiFi', key: '' },
  ]);
  assert.deepEqual(res, { ok: true, count: 2 });
  const g2 = uci.get('wireless', 'iface0');
  assert.equal(g2.ssid, 'HomeWiFi');
  assert.equal(g2.key, 'newpass99');
  assert.equal(g2.encryption, 'psk2'); // 开放口补 WPA2
  const g5 = uci.get('wireless', 'iface1');
  assert.equal(g5.ssid, 'HomeWiFi');
  assert.equal(g5.key, 'oldpass99'); // 空 key 不动密码
  assert.equal(uci.get('wireless', 'iface2').ssid, 'Guest'); // 访客口不动
  assert.equal(shell.cmds.length, 1);
  assert.equal(shell.cmds[0], '( sleep 2; /sbin/wifi reload >/dev/null 2>&1 ) >/dev/null 2>&1 & echo ok');
});

test('apply_wifi_local：无 ap 口时 ok=false 且不 reload', () => {
  const uci = new FakeUci(wirelessSeed([{ ssid: 'STA', mode: 'sta', device: 'radio0' }]));
  const shell = fakeShell();
  const wifi = makeWifi({ S: baseState(), uci, shell });
  assert.deepEqual(wifi.applyWifiLocal([{ band: '2g', ssid: 'X', key: '' }]), { ok: false, count: 0 });
  assert.deepEqual(shell.cmds, []);
});

// ============================================================ 引导冷却与最短稳定时间
function steerSetup({ clients, roamOver = {}, peersAuthed = true, nrSelf = null } = {}) {
  const uci = new FakeUci({
    ...wirelessSeed([{ ssid: 'HomeWiFi', mode: 'ap', device: 'radio0' }]),
    ...roamSeed(roamOver),
  });
  const S = baseState();
  if (peersAuthed) {
    S.peers = {
      aabbccddeeff: {
        authed: true, mac: 'AA:BB:CC:DD:EE:FF', name: 'SAP1',
        info: { nr: [{ bssid: 'aa:bb:cc:dd:ee:ff', ssid: 'HomeWiFi', nr: 'PEER-NR', band: '5g', channel: 36 }] },
      },
    };
  }
  const bus = new FakeBus({
    'network.wireless.status': {
      radio0: {
        interfaces: [{ ifname: 'wlan0', config: { mode: 'ap', ssid: 'HomeWiFi' } }],
      },
    },
    'hostapd.wlan0.rrm_nr_get_own': { value: ['aa:bb:cc:dd:ee:01', 'HomeWiFi', 'SELF-NR'] },
    'hostapd.wlan0.get_status': { freq: 5180, channel: 36 },
  });
  const shell = fakeShell();
  const wifi = makeWifi({
    S, uci, shell, bus,
    localClients: () => clients,
  });
  return { uci, S, bus, shell, wifi };
}

const WEAK = '112233445566';
function weakClient(over = {}) {
  return {
    [WEAK]: {
      type: 'wifi', ifname: 'wlan0', ssid: 'HomeWiFi', rssi: -80,
      connected_time: 120, hostname: 'phone', ...over,
    },
  };
}

test('steer_tick：弱信号终端收到 BTM 引导，带候选邻居，冷却与计数更新', async () => {
  const { S, bus, wifi } = steerSetup({ clients: weakClient() });
  await wifi.steerTick();
  const btm = bus.calls.find((c) => c.method === 'bss_transition_request');
  assert.ok(btm, '应调用 bss_transition_request');
  assert.equal(btm.path, 'hostapd.wlan0');
  assert.equal(btm.data.addr, maccolon(WEAK));
  assert.equal(btm.data.disassociation_imminent, true);
  assert.equal(btm.data.disassociation_timer, 10);
  assert.equal(btm.data.validity_period, 30);
  assert.equal(btm.data.abridged, false);
  assert.deepEqual(btm.data.neighbors, ['PEER-NR']); // 排除本机 SELF-NR
  assert.equal(S.steer_tries[WEAK], 1);
  assert.ok(S.steer_last[WEAK] > 0);
  assert.equal(S.events.at(-1).type, 'roam_steer');
  assert.match(S.events.at(-1).info, /rssi=-80 < -70 cand=1/);
});

test('steer_tick：冷却期内（60s）不重复引导；信号达标清零计数', async () => {
  const now = nowSeconds();
  const { S, bus, wifi } = steerSetup({ clients: weakClient() });
  S.steer_last[WEAK] = now - 30; // 30s 前刚引导过
  await wifi.steerTick();
  assert.equal(bus.calls.filter((c) => c.method === 'bss_transition_request').length, 0);
  // 信号回升到阈值以上：清零失败计数
  const { S: S2, bus: bus2, wifi: wifi2 } = steerSetup({ clients: weakClient({ rssi: -65 }) });
  S2.steer_tries[WEAK] = 2;
  await wifi2.steerTick();
  assert.equal(bus2.calls.filter((c) => c.method === 'bss_transition_request').length, 0);
  assert.equal(S2.steer_tries[WEAK], undefined);
});

test('steer_tick：入网不足 20s（MIN_STEER_ASSOC）不引导并清零计数', async () => {
  const { S, bus, wifi } = steerSetup({ clients: weakClient({ connected_time: 5 }) });
  S.steer_tries[WEAK] = 2;
  await wifi.steerTick();
  assert.equal(bus.calls.filter((c) => c.method === 'bss_transition_request').length, 0);
  assert.equal(S.steer_tries[WEAK], undefined);
  // 恰好 20s：允许引导
  const t2 = steerSetup({ clients: weakClient({ connected_time: 20 }) });
  await t2.wifi.steerTick();
  assert.equal(t2.bus.calls.filter((c) => c.method === 'bss_transition_request').length, 1);
});

test('steer_tick：连续 3 次无果后强制 del_client（ban_time 0），并静默 1800s', async () => {
  const now = nowSeconds();
  const { S, bus, wifi } = steerSetup({ clients: weakClient() });
  S.steer_tries[WEAK] = 3;
  await wifi.steerTick();
  const kick = bus.calls.find((c) => c.method === 'del_client');
  assert.ok(kick, '应强制断开');
  assert.deepEqual(kick.data, { addr: maccolon(WEAK), deauth: true, reason: 1, ban_time: 0 });
  assert.equal(S.steer_tries[WEAK], 0);
  assert.ok(S.steer_mute[WEAK] >= now + 1800 - 1);
  assert.equal(S.events.at(-1).type, 'roam_kick');
  // 静默期内即使仍弱信号也不再踢（只数 del_client / BTM 调用，ap_nr_self 的查询调用不计）
  const kicksBefore = bus.calls.filter((c) => c.method === 'del_client' || c.method === 'bss_transition_request').length;
  await wifi.steerTick();
  assert.equal(bus.calls.filter((c) => c.method === 'del_client' || c.method === 'bss_transition_request').length, kicksBefore);
});

test('steer_tick：无候选 / 无已认证 peer / 漫游关闭 / 非漫游 SSID 均不引导', async () => {
  // 无候选：peer 无 nr，cap_nr 为空
  const noCand = steerSetup({ clients: weakClient() });
  noCand.S.peers.aabbccddeeff.info.nr = [];
  await noCand.wifi.steerTick();
  assert.equal(noCand.bus.calls.filter((c) => c.method === 'bss_transition_request').length, 0);
  // 无已认证 peer
  const noPeer = steerSetup({ clients: weakClient(), peersAuthed: false });
  await noPeer.wifi.steerTick();
  assert.equal(noPeer.bus.calls.filter((c) => c.method === 'bss_transition_request').length, 0);
  // 漫游关闭
  const off = steerSetup({ clients: weakClient(), roamOver: { enabled: '0' } });
  await off.wifi.steerTick();
  assert.equal(off.bus.calls.filter((c) => c.method === 'bss_transition_request').length, 0);
  // 非漫游 SSID
  const other = steerSetup({ clients: weakClient({ ssid: 'OtherNet' }) });
  await other.wifi.steerTick();
  assert.equal(other.bus.calls.filter((c) => c.method === 'bss_transition_request').length, 0);
});

test('steer_tick：固定 AP 终端退出引导；k_neighbor 时同步邻居库', async () => {
  const { S, bus, wifi } = steerSetup({ clients: weakClient() });
  S.aliases.pin = { [WEAK]: 'aabbccddeeff' }; // 钉在 SAP 上
  S.steer_tries[WEAK] = 2;
  await wifi.steerTick();
  assert.equal(bus.calls.filter((c) => c.method === 'bss_transition_request').length, 0);
  assert.equal(S.steer_tries[WEAK], undefined);
  // 邻居同步：本机 wlan0 的同 SSID 邻居应写入 hostapd
  const t2 = steerSetup({ clients: weakClient({ rssi: -65 }) }); // 不引导但仍同步
  await t2.wifi.steerTick();
  const nrSet = t2.bus.calls.find((c) => c.method === 'rrm_nr_set');
  assert.ok(nrSet, 'k_neighbor 开时应同步邻居库');
  assert.deepEqual(nrSet.data.list, [['aa:bb:cc:dd:ee:ff', 'HomeWiFi', 'PEER-NR']]);
});

test('steer_tick：hostapd 调用抛错时只 log，不更新冷却与计数（原版 try/catch 语义）', async () => {
  const { S, bus, wifi } = steerSetup({ clients: weakClient() });
  bus.handlers['hostapd.wlan0.bss_transition_request'] = new Error('no such object');
  await wifi.steerTick();
  assert.equal(S.steer_last[WEAK], undefined);
  assert.equal(S.steer_tries[WEAK], undefined);
  assert.equal(S.events.filter((e) => e.type === 'roam_steer').length, 0);
});

test('neighbor_sync：签名不变跳过；无 ifname 的条目不调用', async () => {
  const { S, bus, wifi } = steerSetup({ clients: {} });
  const bsses = [
    { ifname: 'wlan0', bssid: 'aa:bb:cc:dd:ee:01', ssid: 'HomeWiFi', nr: 'SELF-NR' },
    { bssid: 'aa:bb:cc:dd:ee:ff', ssid: 'HomeWiFi', nr: 'PEER-NR' },
  ];
  await wifi.neighborSync(bsses);
  assert.equal(bus.calls.filter((c) => c.method === 'rrm_nr_set').length, 1);
  const before = bus.calls.length;
  await wifi.neighborSync(bsses); // 签名相同
  assert.equal(bus.calls.length, before);
});

// ============================================================ 固定 AP
test('pin：唯一实现在 clients；wifi 只经注入的 pinOf 读固定关系（无自有实现）', () => {
  const S = baseState();
  S.peers = { aabbccddeeff: { authed: true, name: 'SAP1' } };
  const uci = new FakeUci();
  const { pinOf, pinApply } = canonicalPin(S, uci, fakeShell());
  const wifi = makeWifi({ S, uci, shell: fakeShell() });
  assert.equal(wifi.pinApply, undefined);
  assert.equal(wifi.pinOf, undefined);
  assert.deepEqual(pinApply('11:22:33:44:55:66', 'AA:BB:CC:DD:EE:FF'), { ok: true, mac: '112233445566', ap: 'aabbccddeeff' });
  assert.equal(S.aliases.pin['112233445566'], 'aabbccddeeff');
  assert.equal(pinOf('112233445566'), 'aabbccddeeff');
  // 非法 MAC / 非法 AP / 未知 AP
  assert.deepEqual(pinApply('xyz', 'aabbccddeeff'), { ok: false, error: 'invalid_mac' });
  assert.deepEqual(pinApply('112233445566', 'not-a-mac'), { ok: false, error: 'invalid_ap' });
  assert.deepEqual(pinApply('112233445566', 'aabbccddeeee'), { ok: false, error: 'unknown_ap' });
  // 本机 AP 合法；清空
  assert.deepEqual(pinApply('112233445566', 'AA:BB:CC:DD:EE:01'), { ok: true, mac: '112233445566', ap: 'aabbccdde e01'.replace(' ', '') });
  assert.deepEqual(pinApply('112233445566', ''), { ok: true, mac: '112233445566', ap: '' });
  assert.equal(S.aliases.pin['112233445566'], undefined);
  // wifi 读 pin 只走注入的 pinOf：钉上后 steerTick 应跳过该终端
  pinApply('11:22:33:44:55:66', 'AA:BB:CC:DD:EE:FF');
  assert.equal(pinOf('112233445566'), 'aabbccddeeff');
});

test('pin_tick：连错 AP 的终端被 del_client（ban_time 120000），30s 冷却；钉在本机不踢', async () => {
  const S = baseState();
  S.aliases.pin = { [WEAK]: 'aabbccddeeff' };
  const bus = new FakeBus({});
  const wifi = makeWifi({
    S, uci: new FakeUci(), shell: fakeShell(), bus,
    localClients: () => weakClient(),
  });
  await wifi.pinTick();
  const kick = bus.calls.find((c) => c.method === 'del_client');
  assert.ok(kick);
  assert.deepEqual(kick.data, { addr: maccolon(WEAK), deauth: true, reason: 1, ban_time: 120000 });
  assert.equal(S.events.at(-1).type, 'pin_kick');
  // 30s 冷却内不再踢
  const n = bus.calls.length;
  await wifi.pinTick();
  assert.equal(bus.calls.length, n);
  // 钉在本机：不踢
  const S2 = baseState();
  S2.aliases.pin = { [WEAK]: 'aabbccdde e01'.replace(' ', '') };
  const bus2 = new FakeBus({});
  const wifi2 = makeWifi({
    S: S2, uci: new FakeUci(), shell: fakeShell(), bus: bus2,
    localClients: () => weakClient(),
  });
  await wifi2.pinTick();
  assert.equal(bus2.calls.length, 0);
});

// ============================================================ 回程配置
test('current_backhaul_cfg：缺失字段取默认值，mode 缺省 relay、非法值回落 relay', () => {
  const uci = new FakeUci({ wifiroam: { backhaul: { '.type': 'backhaul' } } });
  const wifi = makeWifi({ S: baseState(), uci, shell: fakeShell() });
  assert.deepEqual(wifi.currentBackhaulCfg(), {
    enabled: false, ssid: 'wifiroam-bh', key: '', device: '', mode: 'relay', config_ver: 0,
  });
  // wds 是唯一可选的另一档；拼错的值必须回落 relay，不能变成“未知模式”
  uci.set('wifiroam', 'backhaul', 'mode', 'wds');
  assert.equal(wifi.currentBackhaulCfg().mode, 'wds');
  uci.set('wifiroam', 'backhaul', 'mode', 'four-address');
  assert.equal(wifi.currentBackhaulCfg().mode, 'relay');
});

test('apply_backhaul_local CAP：普通隐藏 AP（relay 不开四地址），写回 wifiroam 段', () => {
  const uci = new FakeUci({
    ...wirelessSeed([], [{ band: '5g' }, { band: '2g' }]),
    ...roamSeed(),
  });
  uci.pkgs.wireless.radio0 = { '.name': 'radio0', '.type': 'wifi-device', band: '5g' };
  uci.pkgs.wireless.radio1 = { '.name': 'radio1', '.type': 'wifi-device', band: '2g' };
  const S = baseState();
  const shell = fakeShell();
  const wifi = makeWifi({ S, uci, shell });
  const res = wifi.applyBackhaulLocal(
    { enabled: true, ssid: 'wifiroam-bh', key: 'bhkey123', device: 'radio1', config_ver: 2 }, 'cap');
  assert.deepEqual(res, { ok: true, ver: 2 });
  const bh = uci.get('wireless', 'wifiroam_bh');
  assert.equal(bh.mode, 'ap');
  assert.equal(bh.device, 'radio1'); // CAP 用 bh.device 优先
  assert.equal(bh.ssid, 'wifiroam-bh');
  assert.equal(bh.encryption, 'psk2+ccmp');
  // 回程 AP 必须挂在 LAN 上才可能把帧送给主路由 LAN；四地址在
  // ath11k/NSS 上不会建出 AP_VLAN，所以 relay 模式一律 wds=0
  assert.equal(bh.network, 'lan');
  assert.equal(bh.wds, '0');
  assert.equal(bh.hidden, '1');
  assert.equal(bh.disabled, '0');
  assert.equal(uci.get('wifiroam', 'backhaul', 'mode'), 'relay');
  assert.equal(uci.get('wifiroam', 'backhaul', 'config_ver'), '2');
  // CAP 不需要 STA 侧的 netifd 接口
  assert.equal(uci.get('network', 'wifiroam_sta'), null);
  assert.equal(S.backhaul_ver_applied, 2);
  // 只重启回程所在射频，不整机 reload
  assert.deepEqual(shell.procs, [['/sbin/wifi', ['up', 'radio1']]]);
});

test('apply_backhaul_local CAP(wds)：显式选 wds 时才回到四地址桥接', () => {
  const uci = new FakeUci({ ...wirelessSeed([], [{ band: '5g' }]), ...roamSeed() });
  uci.pkgs.wireless.radio0 = { '.name': 'radio0', '.type': 'wifi-device', band: '5g' };
  const wifi = makeWifi({ S: baseState(), uci, shell: fakeShell() });
  const res = wifi.applyBackhaulLocal(
    { enabled: true, ssid: 'wifiroam-bh', key: 'bhkey123', device: '', mode: 'wds', config_ver: 4 }, 'cap');
  assert.deepEqual(res, { ok: true, ver: 4 });
  const bh = uci.get('wireless', 'wifiroam_bh');
  assert.equal(bh.network, 'lan');
  assert.equal(bh.wds, '1');
  assert.equal(uci.get('wifiroam', 'backhaul', 'mode'), 'wds');
});

test('apply_backhaul_local SAP：relay 下 STA 独占 wifiroam_sta（proto dhcp）；有线在位时 disabled=1', () => {
  const uci = new FakeUci({
    ...wirelessSeed([], [{ band: '5g' }]),
    ...roamSeed(),
  });
  uci.pkgs.wireless.radio0 = { '.name': 'radio0', '.type': 'wifi-device', band: '5g' };
  const S = baseState({ cfg: { enabled: true, role: 'sap', token: 'tok123', cap_ip: '192.168.12.1', name: 'SAP' } });
  S.peers = { aabbccddeeff: { role: 'cap', authed: true } };
  const wifi = makeWifi({
    S, uci, shell: fakeShell(),
    parseFdb: () => ({ aabbccddeeff: 'eth0' }), // CAP MAC 出现在以太口
    fs: fakeFs({
      '/sys/class/net/eth0/carrier': '1\n',
      '/sys/class/net/eth0/operstate': 'up\n',
    }),
  });
  const res = wifi.applyBackhaulLocal(
    { enabled: true, ssid: 'wifiroam-bh', key: 'bhkey123', device: '', config_ver: 1 }, 'sap');
  assert.deepEqual(res, { ok: true, ver: 1 });
  const bh = uci.get('wireless', 'wifiroam_bh');
  assert.equal(bh.mode, 'sta');
  // STA 不能挂 br-lan：bridge 型 STA 在该固件上会被 wifi-scripts 拒绝
  // （BRIDGE_NOT_ALLOWED），并在 4 地址缺失时丢掉单播 OFFER
  assert.equal(bh.network, 'wifiroam_sta');
  assert.equal(bh.wds, '0');
  assert.equal(bh.disabled, '1'); // 有线在位，STA 暂停防环路
  assert.equal(bh.hidden, undefined);
  // STA 自己经由独立接口向上游取址
  assert.equal(uci.get('network', 'wifiroam_sta', 'proto'), 'dhcp');
  assert.equal(uci.get('network', 'wifiroam_sta', 'device'), 'phy0-sta0');
  assert.equal(uci.get('network', 'wifiroam_sta', 'auto'), '1');
  // 无 radio
  const uci2 = new FakeUci(roamSeed());
  const wifi2 = makeWifi({ S: baseState(), uci: uci2, shell: fakeShell() });
  assert.deepEqual(
    wifi2.applyBackhaulLocal({ enabled: true, ssid: 'wifiroam-bh', key: 'k', device: '', config_ver: 1 }, 'sap'),
    { ok: false, error: 'no_radio' });
});

test('apply_backhaul_local 关闭：删回程口与 STA 接口并写 ver；pick_radio 优先 5g 再任意', () => {
  const uci = new FakeUci({
    ...wirelessSeed([{ ssid: 'wifiroam-bh', mode: 'sta', device: 'radio0' }]),
    ...roamSeed(),
    network: { wifiroam_sta: { '.type': 'interface', proto: 'dhcp', device: 'phy0-sta0', auto: '1' } },
  });
  uci.pkgs.wireless.wifiroam_bh = { '.name': 'wifiroam_bh', '.type': 'wifi-iface', ssid: 'wifiroam-bh', mode: 'sta', device: 'radio0' };
  const S = baseState();
  const wifi = makeWifi({ S, uci, shell: fakeShell() });
  assert.deepEqual(
    wifi.applyBackhaulLocal({ enabled: false, ssid: '', key: '', device: '', config_ver: 3 }, 'sap'),
    { ok: true, ver: 3 });
  assert.equal(uci.get('wireless', 'wifiroam_bh'), null);
  assert.equal(uci.get('wifiroam', 'backhaul', 'enabled'), '0');
  // 关闭回程必须连 STA 接口一起收掉，否则留下一个永远没有设备的 netifd 接口
  assert.equal(uci.get('network', 'wifiroam_sta'), null);
  // pick_radio
  const uci2 = new FakeUci(wirelessSeed([], [{ band: '2g' }, { band: '5g', disabled: '1' }, { band: '5g' }]));
  uci2.pkgs.wireless.radio0 = { '.name': 'radio0', '.type': 'wifi-device', band: '2g' };
  uci2.pkgs.wireless.radio1 = { '.name': 'radio1', '.type': 'wifi-device', band: '5g', disabled: '1' };
  uci2.pkgs.wireless.radio2 = { '.name': 'radio2', '.type': 'wifi-device', band: '5g' };
  const wifi2 = makeWifi({ S: baseState(), uci: uci2, shell: fakeShell() });
  assert.equal(wifi2.pickRadio('radio0'), 'radio0');
  assert.equal(wifi2.pickRadio('radio1'), 'radio2'); // 指定口被禁用 → 退 5g
  assert.equal(wifi2.pickRadio('nope'), 'radio2');
});

test('backhaul_tick：SAP 拔线（防抖后）启用 STA / 插线暂停；非 SAP 走 CAP 对账', () => {
  const mk = (fdb, disabled = '1') => {
    const uci = new FakeUci({
      ...wirelessSeed([{ ssid: 'wifiroam-bh', mode: 'sta', device: 'radio0' }], [{ band: '5g' }]),
      ...roamSeed(),
      network: { wifiroam_sta: { '.type': 'interface', proto: 'dhcp', device: 'phy0-sta0', auto: '1' } },
    });
    uci.pkgs.wireless.radio0 = { '.name': 'radio0', '.type': 'wifi-device', band: '5g' };
    uci.pkgs.wireless.wifiroam_bh = {
      '.name': 'wifiroam_bh', '.type': 'wifi-iface', ssid: 'wifiroam-bh',
      mode: 'sta', device: 'radio0', network: 'wifiroam_sta', wds: '0', disabled,
      key: 'bhkey123', encryption: 'psk2+ccmp',
    };
    uci.set('wifiroam', 'backhaul', 'enabled', '1');
    uci.set('wifiroam', 'backhaul', 'ssid', 'wifiroam-bh');
    uci.set('wifiroam', 'backhaul', 'key', 'bhkey123');
    uci.set('wifiroam', 'backhaul', 'mode', 'relay');
    const S = baseState({ cfg: { enabled: true, role: 'sap', token: 't', cap_ip: '', name: 'SAP' } });
    S.peers = { aabbccddeeff: { role: 'cap', authed: true } };
    const shell = fakeShell();
    const wifi = makeWifi({
      S, uci, shell,
      parseFdb: () => fdb,
      fs: fakeFs({
        '/sys/class/net/eth0/carrier': '1\n',
        '/sys/class/net/eth0/operstate': 'up\n',
      }),
    });
    return { uci, S, shell, wifi };
  };
  // 拔线：FDB 无 CAP，无线计时器已过 10s 防抖 → disabled 1→0，并拉起射频
  const t1 = mk({});
  t1.S._bh = { was_wired: true, wireless_since: nowSeconds() - 30, pause_ts: 0 };
  t1.wifi.backhaulTick();
  assert.equal(t1.uci.get('wireless', 'wifiroam_bh', 'disabled'), '0');
  assert.equal(t1.S.events.at(-1).type, 'backhaul_link');
  assert.deepEqual(t1.shell.procs, [['/sbin/wifi', ['up', 'radio0']]]);
  // 插线：FDB 有 CAP 在 eth0，有线计时器过 12s 防抖 → 暂停 STA
  const t2 = mk({ aabbccddeeff: 'eth0' }, '0');
  t2.S._bh = { was_wired: false, wired_since: nowSeconds() - 30, pause_ts: 0 };
  t2.wifi.backhaulTick();
  assert.equal(t2.uci.get('wireless', 'wifiroam_bh', 'disabled'), '1');
  assert.deepEqual(t2.shell.procs, [['/sbin/wifi', ['up', 'radio0']]]);
  // 防抖未满不动作：刚拔线 2 秒
  const t3 = mk({}, '1');
  t3.S._bh = { was_wired: true, wireless_since: nowSeconds() - 2, pause_ts: 0 };
  t3.wifi.backhaulTick();
  assert.equal(t3.uci.get('wireless', 'wifiroam_bh', 'disabled'), '1');
  assert.deepEqual(t3.shell.procs, []);
  // CAP 侧不跑 SAP 状态机（回程未启用时对账直接返回）
  const t4 = mk({}, '1');
  t4.S.cfg.role = 'cap';
  t4.uci.set('wifiroam', 'backhaul', 'enabled', '0');
  t4.S._bh = { wireless_since: nowSeconds() - 30, pause_ts: 0 };
  t4.wifi.backhaulTick();
  assert.equal(t4.uci.get('wireless', 'wifiroam_bh', 'disabled'), '1');
  assert.deepEqual(t4.shell.procs, []);
});

// ============================================================ 自检 / 预检查 / 默认漫游
test('detect_self：LAN 状态、MAC 回退、固件名、nonce 长度', async () => {
  const bus = new FakeBus({
    'network.interface.lan.status': {
      device: 'br-lan', 'ipv4-address': [{ address: '192.168.12.1', mask: 24 }],
    },
  });
  const S = baseState();
  S.cfg.name = '';
  const wifi = makeWifi({
    S, uci: new FakeUci(), shell: fakeShell(), bus,
    fs: fakeFs({
      '/sys/class/net/br-lan/address': 'aa:bb:cc:dd:ee:01\n',
      '/proc/sys/kernel/hostname': 'MyAP\n',
      '/tmp/sysinfo/model': 'Aliyun AP8220\n',
      '/etc/openwrt_release': "DISTRIB_DESCRIPTION='ImmortalWrt 25.12'\n",
    }),
  });
  await wifi.detectSelf();
  assert.equal(S.self.mac, 'AA:BB:CC:DD:EE:01');
  assert.equal(S.self.ip, '192.168.12.1');
  assert.equal(S.bcast, '192.168.12.255');
  assert.equal(S.self.name, 'MyAP'); // cfg.name 为空时用 hostname
  assert.equal(S.self.firmware, 'ImmortalWrt 25.12');
  assert.equal(S.self.nonce.length, 16);
  assert.equal(wifi.lanBroadcast('10.0.0.5', 24), '10.0.0.255');
  assert.equal(wifi.lanBroadcast('bad', 24), '255.255.255.255');
});

test('precheck：wpad 命中、SSID 组计数、角色检查', () => {
  const uci = new FakeUci({
    ...wirelessSeed([{ ssid: 'HomeWiFi', mode: 'ap', device: 'radio0', encryption: 'psk2' }]),
    ...roamSeed(),
  });
  uci.pkgs.wireless.radio0 = { '.name': 'radio0', '.type': 'wifi-device', band: '5g' };
  const S = baseState();
  S.peers = {
    aabbccddeeff: {
      authed: true, name: 'SAP1',
      info: { name: 'SAP1', role: 'sap', ip: '192.168.12.2', wifi: [{ ssid: 'HomeWiFi', encryption: 'psk2', band: '5g' }] },
    },
  };
  const shell = fakeShell({ cmdMap: { 'apk list': 'wpad-mbedtls 2024\n' } });
  const wifi = makeWifi({ S, uci, shell, fs: fakeFs({}, new Set(['/usr/bin/apk'])) });
  const p = wifi.precheck();
  assert.equal(p.role, 'cap');
  assert.equal(p.checks.find((c) => c.id === 'wpad').ok, true);
  assert.equal(p.checks.find((c) => c.id === 'wpad').info, 'wpad-mbedtls 2024');
  assert.equal(p.checks.find((c) => c.id === 'ssid_group').ok, true);
  assert.equal(p.checks.find((c) => c.id === 'ssid_group').info, '1');
  assert.equal(p.checks.find((c) => c.id === 'role').ok, true);
  assert.equal(p.aps.length, 2);
  assert.equal(p.aps[0].self, true);
  assert.equal(p.aps[1].self, false);
});

test('roam_default_init：首次启用自动选中本机 SSID 并落盘 ver=1；已有配置不动', () => {
  const uci = new FakeUci({
    ...wirelessSeed([
      { ssid: 'HomeWiFi', mode: 'ap', device: 'radio0' },
      { ssid: 'HomeWiFi', mode: 'ap', device: 'radio1' },
      { ssid: 'Guest', mode: 'ap', device: 'radio0', wifiroam_guest: '1' },
    ]),
    wifiroam: {
      roam: { '.type': 'roam', enabled: '1', config_ver: '0', ssids: [] },
      backhaul: { '.type': 'backhaul', enabled: '0', config_ver: '0' },
    },
  });
  const S = baseState();
  const shell = fakeShell();
  const wifi = makeWifi({ S, uci, shell });
  wifi.roamDefaultInit();
  assert.deepEqual(uci.get('wifiroam', 'roam', 'ssids'), ['HomeWiFi']);
  assert.equal(uci.get('wifiroam', 'roam', 'config_ver'), '1');
  assert.equal(S.last_apply.ver, 1);
  assert.equal(S.last_apply.results[0].ok, true);
  // 已有 config_ver=1 时不再跑
  const setsBefore = uci.sets.length;
  wifi.roamDefaultInit();
  assert.equal(uci.sets.length, setsBefore);
});
