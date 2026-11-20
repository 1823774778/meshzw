// clients.mjs -- 终端发现 / 分组 / 拓扑 / 历史记录、别名、固定 AP、
// 解组、定时断网（ban）与 WOL 唤醒。
// Target: Node 22.23.4, core modules only, zero npm dependencies.
// Ported verbatim from wifiroamd.uc (r47, 5498 lines); function mapping
// follows spec.md §2/§8. Only lib/ is imported; no business module is
// imported directly (spec §8 circular-dependency ban) -- cross-module
// work goes through ctx-injected callbacks, see createClients() below.
//
// Notable porting notes (kept, not "fixed"):
//  - local_clients() was synchronous in ucode (ubusc.call blocks); the
//    JS ubus client is Promise-based (INTERFACE.md §2), so localClients
//    and everything downstream of it (deviceGroupRefresh, buildTopology,
//    devlistLive/Tick/View, findClient, banSet's name lookup) are async
//    and must be awaited by core/discovery/api.
//  - hostapd get_clients has NO try/catch in the original (spec §9.22):
//    a throwing bus.call() propagates out of localClients(), exactly as
//    the original would abort the round. A null return is still skipped.
//  - ban_list weekdays is an ARRAY of numbers (ban_read returns
//    ban_weekdays(), 1=Mon..7=Sun); ban_set input and the UCI value are
//    the SPACE-JOINED STRING of the same numbers. No conversion is
//    invented on either side; the frontend's load() sorts the array and
//    its read() joins it back to a string, which matches both shapes.
//  - state._group_changed is set by device_group_refresh() in the
//    original although spec §1.2 does not list it; it is kept verbatim.
//  - S fields used here are only those listed in spec §1.2 (plus the
//    _group_changed quirk above and _online_ts, which belongs to
//    policy's online_sample and is NOT touched here).
//
// ctx = { S, bus, uci, shell, util, store, ...callbacks }
//   S    : core's shared state object (spec §1.2 field names verbatim).
//   bus  : lib/ubus UbusClient (or a mock with async call(path, method)).
//   uci  : lib/uci UciClient (or a mock with get/set/add/delete/commit/
//          foreach/load). Defaults to the real singleton.
//   shell: lib/shell module ({ cmdOutput, shellCommands }).
//   util : lib/util module (macnorm/maccolon/devnorm/macIsRandom/sha256/
//          toInt/fieldAfter/nowSeconds/log).
//   store: lib/store module (loadAliases/saveAliases/loadDevices/
//          saveDevices).
//   Optional test/cross-module hooks (all optional, core injects the
//   real ones at wiring time):
//     now()             -> seconds since epoch (default util.nowSeconds)
//     readFile(path)    -> string|null (default fs read, null on error)
//     writeFile(path, text), unlinkFile(path)
//     localtime(sec)    -> { wday, hour, min } (default local Date)
//     aliasPath, devicesPath (default /etc/wifiroam/*.json)
//     detectUplink()   -> wifi module's detect_uplink() (build_topology)
//     selfUptime()     -> wifi module's self_uptime(); default reads
//                         /proc/uptime.
//     aliasBroadcast() -> discovery's alias_broadcast(); if absent, the
//                         original peer loop is run inline (best effort).
//     sapDisconnect()  -> discovery's sap_disconnect().
//     connClose(conn)  -> discovery's conn_close().
//     appctlReadDevices(), appctlApplyRules(), appctlDpiDaemon(action)
//                      -> policy module hooks for ungroup_device().
//     pushEvent(type, mac, info, name) -> core's push_event(); if
//                         absent, an internal faithful copy is used.
//     wolSocketFactory() -> { setBroadcast, send, close, on } for WOL;
//                         default is node:dgram.

import { createSocket } from 'node:dgram';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';

import { UBUS_STATUS } from '../lib/ubus.js';
import { cmdOutput as libCmdOutput, shellCommands as libShellCommands } from '../lib/shell.js';
import {
  ALIAS_PATH,
  DEVICES_PATH,
  loadAliases as libLoadAliases,
  loadDevices as libLoadDevices,
  saveAliases as libSaveAliases,
  saveDevices as libSaveDevices,
} from '../lib/store.js';
import { uci as defaultUci } from '../lib/uci.js';
import {
  devnorm as libDevnorm,
  fieldAfter as libFieldAfter,
  log as libLog,
  macIsRandom as libMacIsRandom,
  maccolon as libMaccolon,
  macnorm as libMacnorm,
  nowSeconds as libNowSeconds,
  sha256 as libSha256,
  toInt as libToInt,
} from '../lib/util.js';

export const MAX_EVENTS = 100;
export const WIRED_TTL = 300; // s wired client stays listed after last FDB sighting
export const DEVICES_MAX = 512;
export const DEVICES_FLUSH = 60; // s: minimum interval between history saves
export const BAN_TABLE = 'wifiroam_ban';
export const BAN_NFT_FILE = '/tmp/wifiroam-ban.nft';
export const BAN_DEFAULT_ON = '22:00';
export const BAN_DEFAULT_OFF = '07:00';
const LEASES_PATH = '/tmp/dhcp.leases';

function defaultState() {
  return {
    cfg: { enabled: true, role: 'unconfigured', token: '', cap_ip: '', name: '' },
    self: { mac: '', ip: null, name: '', hostname: '', model: '', firmware: '', nonce: '', ifaces: {} },
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

export function createClients(ctx = {}) {
  const S = ctx.S ?? defaultState();
  const bus = ctx.bus && typeof ctx.bus.call === 'function' ? ctx.bus : null;
  const uci = ctx.uci && typeof ctx.uci.get === 'function' ? ctx.uci
    : (ctx.uci && ctx.uci.uci ? ctx.uci.uci : defaultUci);
  const shell = ctx.shell ?? {};
  const cmdOutput = typeof shell.cmdOutput === 'function' ? shell.cmdOutput
    : (typeof ctx.cmdOutput === 'function' ? ctx.cmdOutput : libCmdOutput);
  const shellCommands = shell.shellCommands ?? libShellCommands;
  const util = ctx.util ?? {};
  const macnorm = util.macnorm ?? libMacnorm;
  const maccolon = util.maccolon ?? libMaccolon;
  const devnorm = util.devnorm ?? libDevnorm;
  const macIsRandom = util.macIsRandom ?? libMacIsRandom;
  const sha256 = util.sha256 ?? libSha256;
  const toInt = util.toInt ?? libToInt;
  const fieldAfter = util.fieldAfter ?? libFieldAfter;
  const log = util.log ?? libLog;
  const nowSeconds = ctx.now ?? util.nowSeconds ?? libNowSeconds;
  const store = ctx.store ?? {};
  const loadAliases = store.loadAliases ?? libLoadAliases;
  const saveAliases = store.saveAliases ?? libSaveAliases;
  const loadDevices = store.loadDevices ?? libLoadDevices;
  const saveDevices = store.saveDevices ?? libSaveDevices;
  const aliasPath = ctx.aliasPath ?? ALIAS_PATH;
  const devicesPath = ctx.devicesPath ?? DEVICES_PATH;
  const readFile = typeof ctx.readFile === 'function'
    ? ctx.readFile
    : (p) => { try { return readFileSync(p, 'utf8'); } catch (_e) { return null; } };
  const writeFile = typeof ctx.writeFile === 'function'
    ? ctx.writeFile
    : (p, text) => { try { writeFileSync(p, text, 'utf8'); return true; } catch (_e) { return false; } };
  const unlinkFile = typeof ctx.unlinkFile === 'function'
    ? ctx.unlinkFile
    : (p) => { try { unlinkSync(p); } catch (_e) { /* already gone */ } };
  const localtime = typeof ctx.localtime === 'function'
    ? ctx.localtime
    : (sec) => {
        const d = new Date(sec * 1000);
        return { wday: d.getDay(), hour: d.getHours(), min: d.getMinutes() };
      };
  const now = () => nowSeconds();

  // ------------------------------------------------------------ push_event
  // Core's push_event; used by device_merge_groups/diff_events/
  // owner_events. Injected when core wires the modules; otherwise a
  // faithful local copy (ring buffer MAX_EVENTS=100 + log line).
  const pushEvent = typeof ctx.pushEvent === 'function' ? ctx.pushEvent : (type, mac, info, name) => {
    S.events.push({ ts: now(), type, mac: mac ?? '', name: name ?? '', info: info ?? '' });
    if (S.events.length > MAX_EVENTS) S.events = S.events.slice(S.events.length - MAX_EVENTS);
    log(`event ${type} ${mac ?? '-'} ${name ?? '-'} ${info ?? ''}`);
  };

  const detectUplink = typeof ctx.detectUplink === 'function' ? ctx.detectUplink : null;
  const selfUptime = typeof ctx.selfUptime === 'function'
    ? ctx.selfUptime
    : () => {
        const out = readFile('/proc/uptime');
        if (!out) return 0;
        return toInt(String(out).trim().split(' ')[0]);
      };

  // ------------------------------------------------------- device key/group
  function deviceKey(v) {
    let key = devnorm(v);
    if (key.slice(0, 1) === 'g') {
      let guard = 0;
      while (S.aliases.redirect?.[key] && guard++ < 16) key = S.aliases.redirect[key];
      return key;
    }
    return S.device_index[key] ?? key;
  }

  function deviceReindex() {
    S.aliases.groups ??= {};
    S.aliases.redirect ??= {};
    S.aliases.isolated ??= {};
    S.aliases.map ??= {};
    S.device_index = {};
    for (const [gid, g] of Object.entries(S.aliases.groups)) {
      let target = gid;
      let guard = 0;
      while (S.aliases.redirect[target] && guard++ < 16) target = S.aliases.redirect[target];
      for (const mn of Object.keys(g.members ?? {})) S.device_index[mn] = target;
    }
    // 固定 AP 记录跟随设备组迁移，避免分组变化后设置丢失
    S.aliases.pin ??= {};
    for (const k of Object.keys(S.aliases.pin)) {
      const nk = deviceKey(k);
      if (nk === k) continue;
      if (S.aliases.pin[nk] == null) S.aliases.pin[nk] = S.aliases.pin[k];
      delete S.aliases.pin[k];
    }
  }

  function deviceMembersOf(v) {
    const key = deviceKey(v);
    const g = S.aliases.groups?.[key];
    if (g) return Object.keys(g.members ?? {}).sort();
    const mn = macnorm(key);
    return mn.length === 12 ? [mn] : [];
  }

  function deviceAliasOf(v) {
    const key = deviceKey(v);
    let al = S.aliases.map?.[key];
    if (al) return al;
    const mn = macnorm(v);
    al = S.aliases.map?.[mn];
    if (al) return al;
    for (const member of deviceMembersOf(key)) {
      al = S.aliases.map?.[member];
      if (al) return al;
    }
    return null;
  }

  // ------------------------------------------------------------- aliases
  function aliasLoad() {
    const data = loadAliases(aliasPath);
    if (data && typeof data === 'object') {
      S.aliases.map = data.map ?? {};
      S.aliases.groups = data.groups ?? {};
      S.aliases.redirect = data.redirect ?? {};
      S.aliases.isolated = data.isolated ?? {};
      S.aliases.pin = data.pin ?? {};
      if ((data.ver ?? 0) > S.aliases.ver) S.aliases.ver = data.ver;
    }
    deviceReindex();
  }

  function aliasSave() {
    saveAliases(aliasPath, S.aliases);
    // INTERFACE.md §8.6: the UCI alias_sync.ver mirror is the caller's
    // job; this module is that caller (original alias_save() did it).
    uci.load('wifiroam');
    uci.set('wifiroam', 'alias_sync', 'ver', String(S.aliases.ver));
    uci.commit('wifiroam');
  }

  // ------------------------------------------------------------ AP pinning
  // 固定 AP：把终端钉在某台 AP 上。固定后的终端退出所有自动引导；若它连到了
  // 别的 AP，由所在 AP 主动断开并短时禁入，迫使它回到目标 AP（信号差也不放开）。
  function pinOf(mn) {
    const pin = S.aliases.pin;
    if (!pin) return null;
    return pin[deviceKey(mn)] ?? pin[mn] ?? null;
  }

  function pinApply(mac, ap) {
    const key = deviceKey(mac);
    if (key.length !== 12 && !/^g[0-9a-f]{12}$/.test(key)) return { ok: false, error: 'invalid_mac' };
    const selfMn = macnorm(S.self.mac);
    ap = String(ap ?? '').trim();
    // 非空但不是合法 MAC 的输入不能当成「清除」（macnorm 会把非十六进制字符滤空）
    if (ap !== '' && macnorm(ap).length !== 12) return { ok: false, error: 'invalid_ap' };
    ap = ap === '' ? '' : macnorm(ap);
    if (ap !== '' && ap !== selfMn && !S.peers[ap]) return { ok: false, error: 'unknown_ap' };
    S.aliases.pin ??= {};
    if (ap === '') delete S.aliases.pin[key];
    else S.aliases.pin[key] = ap;
    S.aliases.ver = now();
    aliasSave();
    return { ok: true, mac: key, ap };
  }

  function aliasApply(mac, name, icon, note) {
    const raw = devnorm(mac);
    const mn = deviceKey(raw);
    if (mn.length !== 12 && !/^g[0-9a-f]{12}$/.test(mn)) return false;
    if ((name ?? '') === '' && !icon && !note) delete S.aliases.map[mn];
    else {
      S.aliases.map[mn] = {
        name: name ?? '', icon: icon ?? null, note: note ?? null,
      };
    }
    // 清理同一组旧 MAC 别名，避免轮询时新旧名称互相覆盖。
    if (mn.slice(0, 1) === 'g') {
      for (const member of deviceMembersOf(mn)) {
        if (member !== raw) delete S.aliases.map[member];
      }
    }
    S.aliases.ver = now();
    aliasSave();
    return true;
  }

  function aliasBroadcast() {
    if (typeof ctx.aliasBroadcast === 'function') { ctx.aliasBroadcast(); return; }
    // No discovery callback injected: run the original peer loop inline.
    if (S.cfg.role !== 'cap') return;
    for (const [mn, p] of Object.entries(S.peers)) {
      if (!p.authed || !p.chan) continue;
      try {
        const r = p.chan.defer('push_aliases', { aliases: S.aliases });
        if (r && typeof r.catch === 'function') {
          r.catch(() => {
            p.authed = false;
            p.chan = null;
            if (p.conn) { const c = p.conn; p.conn = null; if (typeof ctx.connClose === 'function') ctx.connClose(c); }
          });
        }
      } catch (_e) {
        p.authed = false;
        p.chan = null;
        if (p.conn) { const c = p.conn; p.conn = null; if (typeof ctx.connClose === 'function') ctx.connClose(c); }
      }
    }
  }

  function sapDisconnect() {
    if (typeof ctx.sapDisconnect === 'function') { ctx.sapDisconnect(); return; }
    S.link = null;
  }

  // ------------------------------------------------------------- parsing
  function freqBand(f) {
    if (!f) return null;
    if (f < 3000) return '2g';
    if (f < 5900) return '5g';
    return '6g';
  }

  function parseLeases() {
    const out = {};
    const data = readFile(LEASES_PATH);
    if (!data) return out;
    for (const line of String(data).split('\n')) {
      const f = line.trim().split(' ');
      if (f.length < 4) continue;
      const mn = macnorm(f[1]);
      if (mn.length !== 12) continue;
      out[mn] = {
        ip: f[2], hostname: f[3] !== '*' ? f[3] : null,
        expires: toInt(f[0]) ?? 0,
        clientid: f.length >= 5 && f[4] !== '*' ? f[4] : null,
      };
    }
    return out;
  }

  function parseNeigh() {
    const out = {};
    const data = cmdOutput(shellCommands.ipNeighDev(S.brdev));
    for (const line of String(data).split('\n')) {
      const f = line.trim().split(' ');
      if (f.length < 3) continue;
      const ip = f[0];
      const mac = fieldAfter(f, 'lladdr');
      const st = f[f.length - 1];
      if (!mac || ip.indexOf(':') >= 0) continue; // ipv4 only
      if (st === 'FAILED' || st === 'INCOMPLETE') continue;
      out[macnorm(mac)] = { ip };
    }
    return out;
  }

  // CAP 下发的终端名称表：SAP 上没有 DHCP 服务，/tmp/dhcp.leases 为空，
  // 只能由 CAP 把租约里的主机名/IP 同步过来，子 AP 拓扑才能显示名称
  function clientNames() {
    const out = {};
    for (const [mn, n] of Object.entries(parseNeigh())) out[mn] = { ip: n.ip };
    for (const [mn, l] of Object.entries(parseLeases())) out[mn] = { hostname: l.hostname, ip: l.ip };
    return out;
  }

  // brctl showstp 输出 "lan6 (7)"：端口号 → 接口名。
  // ImmortalWrt 默认不装 iproute2 的 bridge 命令，只能走 brctl 读 MAC 表。
  function bridgePortNames() {
    const map = {};
    const data = cmdOutput(shellCommands.bridgePortNames(S.brdev));
    for (const line of String(data).split('\n')) {
      const m = /^([^\s]+) \(([0-9]+)\)/.exec(line);
      if (m) map[m[2]] = m[1];
    }
    return map;
  }

  function parseFdb() {
    const out = {};
    const data = cmdOutput(shellCommands.bridgeFdbShow(S.brdev));
    if (data !== '') {
      for (const line of String(data).split('\n')) {
        const f = line.trim().split(' ');
        if (f.length < 3) continue;
        const mn = macnorm(f[0]);
        if (mn.length !== 12) continue;
        if (f.includes('self') || f.includes('permanent')) continue;
        const port = fieldAfter(f, 'dev');
        if (!port) continue;
        out[mn] = port;
      }
      return out;
    }
    const pnames = bridgePortNames();
    const data2 = cmdOutput(shellCommands.brctlShowmacs(S.brdev));
    // brctl 的列分隔符是 TAB（且年龄列前有额外空格），必须按任意空白分割
    for (const line of String(data2).split('\n')) {
      const f = line.trim().split(/[ \t]+/);
      if (f.length < 3) continue;
      const mn = macnorm(f[1]);
      if (mn.length !== 12) continue;
      if (f[2] === 'yes') continue; // 网桥自身接口 MAC
      out[mn] = pnames[f[0]] ?? f[0];
    }
    return out;
  }

  // 各站点的累计字节数（iw station dump）：用于由两次采样差分出实时上下行速率。
  // hostapd 的 get_clients 只给信号/协商速率，没有字节计数，故单独取一次。
  function stationBytes(ifname) {
    const nowTs = now();
    const cache = S.bytes_cache[ifname];
    if (cache && nowTs - cache.ts <= 1) return cache.map;
    const out = {};
    const data = cmdOutput(shellCommands.iwStationDump(ifname));
    let mac = null, rx = 0, tx = 0;
    for (const line of String(data).split('\n')) {
      const t = line.trim();
      if (t.slice(0, 8) === 'Station ') {
        if (mac) out[mac] = { rx, tx };
        mac = macnorm(t.slice(8, 8 + 17));
        rx = 0; tx = 0;
      } else if (mac && t.slice(0, 9) === 'rx bytes:') {
        rx = toInt(t.slice(9).trim()) ?? 0;
      } else if (mac && t.slice(0, 9) === 'tx bytes:') {
        tx = toInt(t.slice(9).trim()) ?? 0;
      }
    }
    if (mac) out[mac] = { rx, tx };
    S.bytes_cache[ifname] = { ts: nowTs, map: out };
    return out;
  }

  // 终端展示名：自定义别名 > 本机/对端主机名 > 本网络名称表 > MAC
  // local 传入本次已有客户端表（local_clients / peer clients），避免重复扫描
  function clientNameOf(mn, local) {
    const al = deviceAliasOf(mn);
    if (al?.name != null && al.name !== '') return al.name;
    const c = local?.[mn];
    if (c?.hostname != null && c.hostname !== '') return c.hostname;
    for (const p of Object.values(S.peers)) {
      const pc = p.clients?.[mn];
      if (pc?.hostname != null && pc.hostname !== '') return pc.hostname;
    }
    const n = S.net_names?.[mn];
    if (n?.hostname != null && n.hostname !== '') return n.hostname;
    return maccolon(mn);
  }

  // 本机终端全表（原版 160 行核心函数）：hostapd get_clients 得无线终端
  // （速率换算、实时速率差分），leases/neigh/net_names 补 IP/主机名，
  // FDB+WIRED_TTL 得有线终端，排除 AP 自身接口/级联口/组播 MAC。
  async function localClients() {
    const clients = {};
    const nowTs = now();
    // AP 自身接口 MAC（含无线回程 STA 口）不是终端：对端 AP 用无线回程接入时，
    // 其 STA 口会在本机 hostapd 客户端表里出现，若不排除会与 AP 节点重复计数
    const excl = {};
    for (const m of Object.keys(S.self.ifaces ?? {})) excl[m] = true;
    for (const p of Object.values(S.peers)) {
      for (const m of Object.keys(p.info?.ifaces ?? {})) excl[m] = true;
    }
    // wireless stations via hostapd ubus
    const ifmap = {};
    const ws = bus ? await bus.call('network.wireless', 'status') : null;
    for (const r of Object.values(ws ?? {})) {
      const band = r.config?.band;
      for (const ifc of r.interfaces ?? []) {
        if (ifc.ifname) ifmap[ifc.ifname] = { ssid: ifc.config?.ssid, band };
      }
    }
    // hostapd ubus 对象名为 hostapd.<ifname>；ubus list(pattern) 在本平台
    // 返回签名表而非名称，故按 ifname 直接拼装
    for (const ifname of Object.keys(ifmap)) {
      // spec §9.22: 原版此处无 try/catch，bus.call 抛错即中断本轮。
      const res = bus ? await bus.call(`hostapd.${ifname}`, 'get_clients') : null;
      if (!res?.clients) continue;
      const bytes = stationBytes(ifname);
      for (const [mac, ci] of Object.entries(res.clients)) {
        const mn = macnorm(mac);
        if (excl[mn]) continue; // AP 自身接口，不是终端
        clients[mn] = {
          mac: String(mac).toUpperCase(), type: 'wifi', ifname,
          ssid: ifmap[ifname]?.ssid,
          band: ifmap[ifname]?.band ?? freqBand(res.freq),
          rssi: ci.signal ?? null,
          connected_time: ci.connected_time ?? null,
          // hostapd 上报的 rate 单位是 100 kbit/s（驱动速率 ×100），
          // 除以 100000 换算为 Mbps（如 7220000 -> 72.2 Mbps）；
          // 注意 ucode 整数相除会截断，必须用浮点字面量
          tx_rate: ci.rate?.tx != null ? ci.rate.tx / 100000.0 : null,
          rx_rate: ci.rate?.rx != null ? ci.rate.rx / 100000.0 : null,
          // 实时速率（Mbps）：由站点字节计数两次采样差分得到。
          // rx_speed = 终端 → AP（终端发送），tx_speed = AP → 终端（终端接收）
          rx_speed: null, tx_speed: null,
        };
        S.wifi_seen[mn] = nowTs;
        const b = bytes[mn];
        if (!b) continue;
        const prev = S.client_bytes[mn];
        if (prev && nowTs > prev.ts) {
          const dt = nowTs - prev.ts;
          // 计数回退（终端重连/计数器复位）时本轮不出速率。
          // 关键：ucode 整数相除会截断（全 int 运算时 <1Mbps 的速率
          // 全被截成 0），必须用浮点字面量 8.0 提升精度
          if (b.rx >= prev.rx) clients[mn].rx_speed = (b.rx - prev.rx) * 8.0 / dt / 1000000;
          if (b.tx >= prev.tx) clients[mn].tx_speed = (b.tx - prev.tx) * 8.0 / dt / 1000000;
        }
        S.client_bytes[mn] = { ts: nowTs, rx: b.rx, tx: b.tx };
      }
    }
    // ip/hostname enrichment + wired clients
    const leases = parseLeases();
    const neigh = parseNeigh();
    const fdb = parseFdb();
    // 无线网桥端口集合。FDB 会记录无线站点 MAC（端口为 phy*-ap*），
    // 终端漫游/换频段的一瞬间会从 hostapd 客户端表消失，但 FDB 仍保留
    // 数分钟，若据此判为有线，手机就会被显示成"有线连接"。凡是学自无线
    // 端口的 MAC 一律不当作有线终端。
    const wlanPort = {};
    for (const name of Object.keys(ifmap)) wlanPort[name] = true;
    for (const [mn, l] of Object.entries(leases)) {
      if (clients[mn]) {
        clients[mn].ip = l.ip;
        clients[mn].hostname = l.hostname;
      }
    }
    for (const [mn, n] of Object.entries(neigh)) {
      if (clients[mn] && !clients[mn].ip) clients[mn].ip = n.ip;
    }
    // SAP：用 CAP 下发的名称表补全主机名/IP（本机无 DHCP 租约）
    for (const [mn, n] of Object.entries(S.net_names ?? {})) {
      if (!clients[mn]) continue;
      if (clients[mn].hostname == null && n.hostname != null) clients[mn].hostname = n.hostname;
      if (clients[mn].ip == null && n.ip != null) clients[mn].ip = n.ip;
    }
    const selfMn = macnorm(S.self.mac);
    // 级联/上行口：其他 AP（peers/discovered）的 MAC 在 FDB 中所处的端口，
    // 其下游终端由对端 AP 自行上报，本机不再计为终端
    // （否则对端 WiFi 终端会被本机 FDB 从上行口学成 wired 幻影，漫游后长期挂在旧 AP 下）
    const cascade = {};
    for (const [mn, p] of Object.entries(S.peers)) {
      const pt = fdb[mn];
      if (pt) cascade[pt] = true;
      // 无线回程/桥接的 SAP 可能只暴露其 STA/AP 接口 MAC，
      // 这些 MAC 所在的网桥端口同样是"通往对端 AP"的级联口
      for (const m of Object.keys(p.info?.ifaces ?? {})) {
        const q = fdb[m];
        if (q) cascade[q] = true;
      }
    }
    for (const mn of Object.keys(S.discovered)) {
      const pt = fdb[mn];
      if (pt) cascade[pt] = true;
    }
    // 有线终端在线依据只用 FDB（帧级存活，~5min 老化）：
    // DHCP lease（12h）与 ARP STALE 长期残留，会把已离线设备算进来；
    // wired_seen 提供 WIRED_TTL 滞后，防止 FDB 老化边缘抖动
    const seen = S.wired_seen;
    for (const [mn, port] of Object.entries(fdb)) {
      if (mn === selfMn) continue;
      if (excl[mn]) { delete seen[mn]; continue; } // AP 自身接口
      if (mn.slice(0, 6) === '01005e' || mn.slice(0, 4) === '3333') continue;
      if (mn.slice(0, 6) === '0180c2') continue; // L2 控制帧（STP/LLDP 等）
      // AP 节点或级联口下游：立即从有线表清除，避免重启初期对端尚未
      // 上报时被记成有线终端后残留 WIRED_TTL 那么久
      if (S.peers[mn] || S.discovered[mn]) { delete seen[mn]; continue; }
      if (cascade[port]) { delete seen[mn]; continue; } // 对端 AP 下游
      if (wlanPort[port]) { delete seen[mn]; continue; } // 无线网桥口学到的是无线终端
      // 最近仍作为无线站点出现过（漫游/换频段的空档期）：不降级为有线
      const wf = S.wifi_seen[mn];
      if (wf != null && nowTs - wf <= WIRED_TTL) { delete seen[mn]; continue; }
      seen[mn] = nowTs;
    }
    for (const mn of Object.keys(S.wifi_seen)) {
      if (nowTs - S.wifi_seen[mn] > WIRED_TTL * 2) delete S.wifi_seen[mn];
    }
    for (const mn of Object.keys(seen)) {
      if (nowTs - seen[mn] > WIRED_TTL) {
        delete seen[mn];
        continue;
      }
      if (clients[mn]) continue; // already wifi
      clients[mn] = {
        mac: maccolon(mn), type: 'wired',
        ip: leases[mn]?.ip ?? neigh[mn]?.ip ?? S.net_names?.[mn]?.ip ?? null,
        hostname: leases[mn]?.hostname ?? S.net_names?.[mn]?.hostname ?? null,
        port: fdb[mn] ?? null,
      };
    }
    // first-seen tracking
    for (const mn of Object.keys(clients)) {
      if (!S.client_seen[mn]) S.client_seen[mn] = nowTs;
      clients[mn].since = S.client_seen[mn];
    }
    return clients;
  }

  // ------------------------------------------------------- physical device groups
  function deviceHostKey(v) {
    return String(v ?? '').trim().replace(/[_ ]+/g, '-').toLowerCase();
  }

  function deviceGenericHost(v) {
    const h = deviceHostKey(v);
    return h === '' || [
      '*', 'unknown', 'localhost', 'android', 'iphone', 'ipad',
      'windows', 'desktop', 'laptop', 'openwrt', 'huawei', 'xiaomi', 'redmi',
    ].includes(h);
  }

  function deviceGroupAuto(g) {
    if (!g) return true;
    for (const mn of Object.keys(g.members ?? {})) {
      if (S.aliases.isolated[mn]) return false;
    }
    return true;
  }

  function deviceNewGroup(mn, salt) {
    let gid;
    for (let i = 0; i < 20; i++) {
      gid = 'g' + sha256(`device:${mn}:${salt ?? ''}:${i}`).slice(0, 12);
      if (!S.aliases.groups[gid]) break;
    }
    const nowTs = now();
    const members = {};
    members[mn] = { first_seen: nowTs, last_seen: nowTs };
    S.aliases.groups[gid] = { created: nowTs, members };
    S.device_index[mn] = gid;
    return gid;
  }

  function deviceMergeGroups(a, b) {
    // 保留创建较早的组 ID；即使当前代表 MAC 或频段改变，配置键也不变。
    if ((S.aliases.groups[a].created ?? 0) > (S.aliases.groups[b].created ?? 0)) {
      const t = a; a = b; b = t;
    }
    const ga = S.aliases.groups[a], gb = S.aliases.groups[b];
    for (const [mn, meta] of Object.entries(gb.members ?? {})) {
      ga.members[mn] = meta;
      S.device_index[mn] = a;
    }
    if (!S.aliases.map[a] && S.aliases.map[b]) S.aliases.map[a] = S.aliases.map[b];
    delete S.aliases.map[b];
    delete S.aliases.groups[b];
    S.aliases.redirect[b] = a;
    pushEvent('device_merge', maccolon(Object.keys(gb.members ?? {})[0] ?? ''),
      '→ ' + a, deviceAliasOf(a)?.name ?? '');
    return a;
  }

  function deviceMergeEvidence(a, b) {
    const ga = S.aliases.groups[a], gb = S.aliases.groups[b];
    if (!deviceGroupAuto(ga) || !deviceGroupAuto(gb)) return null;
    let simultaneous = false;
    for (const ma of Object.keys(ga.members ?? {})) {
      for (const mb of Object.keys(gb.members ?? {})) {
        if (S.device_obs[ma]?.online && S.device_obs[mb]?.online) simultaneous = true;
      }
    }
    for (const [ma, maMeta] of Object.entries(ga.members ?? {})) {
      for (const [mb, mbMeta] of Object.entries(gb.members ?? {})) {
        // 实时观测缺主机名/IP 时回退到成员元数据（上次在线时的记录），
        // 否则离线设备永远匹配不上双频规则。
        const oa = S.device_obs[ma] ?? {}, ob = S.device_obs[mb] ?? {};
        const ha = deviceHostKey(oa.hostname ?? maMeta.hostname);
        const hb = deviceHostKey(ob.hostname ?? mbMeta.hostname);
        const sameHost = !deviceGenericHost(ha) && ha === hb;
        const ca = String(oa.clientid ?? maMeta.clientid ?? '').trim().toLowerCase();
        const cb = String(ob.clientid ?? mbMeta.clientid ?? '').trim().toLowerCase();
        if (sameHost && ca.length >= 4 && ca === cb && ca !== '*') return 'dhcp_clientid';
        const aa = deviceAliasOf(ma), ab = deviceAliasOf(mb);
        const an = deviceHostKey(aa?.name), bn = deviceHostKey(ab?.name);
        if (!deviceGenericHost(an) && an === bn) return 'custom_alias';
        // 同一台设备的 2.4G/5G 双频：多数手机每个 SSID 各用一个私有 MAC，
        // 两个 MAC 的主机名相同但 IP、DHCP clientid 都不同。只要没有同时
        // 在线（换频段时旧连接通常先消失），就按同一台设备合并。
        if (sameHost && !simultaneous) return 'dual_band';
        // 同 IP 在短时间内由旧随机 MAC 交给新随机 MAC，且没有双端同时在线。
        // 只比较最近 15 分钟的接替，避免 DHCP 地址自然复用造成误并。
        const ia = oa.ip ?? maMeta.ip, ib = ob.ip ?? mbMeta.ip;
        if (sameHost && !simultaneous && ia && ia === ib) {
          let delta = (oa.ip_ts ?? maMeta.ip_ts ?? 0) - (ob.ip_ts ?? mbMeta.ip_ts ?? 0);
          if (delta < 0) delta = -delta;
          if (delta <= 900) return 'lease_handover';
        }
      }
    }
    return null;
  }

  async function deviceGroupRefresh() {
    if (S.cfg.role !== 'cap') return;
    const nowTs = now();
    const obs = {};
    let changed = false;
    const leases = parseLeases();
    for (const [mn, l] of Object.entries(leases)) {
      // 出厂 MAC 也要进 obs：它可能和同名随机 MAC 组是同一台设备
      obs[mn] = {
        hostname: l.hostname, ip: l.ip, clientid: l.clientid,
        expires: l.expires, ip_ts: nowTs, last_seen: nowTs, online: false,
      };
    }
    const all = await localClients();
    for (const p of Object.values(S.peers)) {
      for (const [mn, c] of Object.entries(p.clients ?? {})) all[mn] ??= c;
    }
    for (const [mn, c] of Object.entries(all)) {
      const o = obs[mn] ??= { ip_ts: nowTs };
      if (c.hostname) o.hostname = c.hostname;
      if (c.ip) { o.ip = c.ip; o.ip_ts = nowTs; }
      o.last_seen = nowTs;
      o.online = true;
    }
    // 已持久化成员在离线期间也保留最后一次租约证据，供下次接替判断。
    for (const g of Object.values(S.aliases.groups)) {
      for (const [mn, meta] of Object.entries(g.members ?? {})) {
        if (!obs[mn]) {
          obs[mn] = meta;
          obs[mn].online = false;
        }
      }
    }
    S.device_obs = obs;
    for (const [mn, o] of Object.entries(obs)) {
      if (!macIsRandom(mn)) continue;
      let gid = S.device_index[mn];
      if (!gid || !S.aliases.groups[gid]) {
        gid = deviceNewGroup(mn, '');
        changed = true;
      }
      const meta = S.aliases.groups[gid].members[mn] ??= { first_seen: nowTs };
      for (const k of ['hostname', 'ip', 'clientid', 'expires', 'ip_ts', 'last_seen', 'online']) {
        if (o[k] != null) meta[k] = o[k];
      }
    }
    // 一轮可能形成 A+B、再与 C 合并；每次只接受强证据，人工拆分组不参与。
    let merged = true;
    while (merged) {
      merged = false;
      const gids = Object.keys(S.aliases.groups).sort();
      for (let i = 0; i < gids.length && !merged; i++) {
        for (let j = i + 1; j < gids.length; j++) {
          const a = deviceKey(gids[i]), b = deviceKey(gids[j]);
          if (a === b || !S.aliases.groups[a] || !S.aliases.groups[b]) continue;
          if (!deviceMergeEvidence(a, b)) continue;
          deviceMergeGroups(a, b);
          changed = merged = true;
          break;
        }
      }
    }
    // 出厂 MAC 与随机 MAC 的跨频段合并：同一台设备可能在 2.4G 用出厂 MAC、
    // 5G 用随机 MAC，而出厂 MAC 自己不会建组，需要并入同名（非通用名）的
    // 随机 MAC 组，否则终端列表会出现两条记录。
    for (const [mn, o] of Object.entries(obs)) {
      if (macIsRandom(mn) || S.device_index[mn]) continue;
      if (S.aliases.isolated[mn]) continue; // 人工拆分过的不再自动合并
      const rh = o.hostname ?? S.net_names?.[mn]?.hostname;
      if (!rh || deviceGenericHost(rh)) continue;
      const h = deviceHostKey(rh);
      let best = null, bestOnline = false;
      for (const [gid, g] of Object.entries(S.aliases.groups)) {
        if (!deviceGroupAuto(g)) continue;
        for (const [mb, meta] of Object.entries(g.members ?? {})) {
          if (!macIsRandom(mb)) continue;
          if (deviceHostKey(obs[mb]?.hostname ?? meta.hostname ?? '') !== h) continue;
          const on = !!(obs[mb]?.online);
          if (best == null || (on && !bestOnline)) {
            best = gid;
            bestOnline = on;
          }
        }
      }
      // 两端同时在线时可能真是两台同型号设备，宁可不并
      if (best == null || (o.online && bestOnline)) continue;
      S.aliases.groups[best].members[mn] = {
        first_seen: o.last_seen ?? nowTs, hostname: rh, ip: o.ip,
        last_seen: o.last_seen, online: o.online,
      };
      S.device_index[mn] = best;
      changed = true;
    }
    deviceReindex();
    if (changed) {
      S._group_changed = true;
      S.aliases.ver = nowTs;
      aliasSave();
      aliasBroadcast();
    }
  }

  function deviceUngroup(mac) {
    const mn = macnorm(mac);
    const old = deviceKey(mn), g = S.aliases.groups[old];
    if (!g?.members?.[mn]) return { ok: false, error: 'not_found' };
    const nowTs = now();
    // 出厂 MAC 只是被自动并入同名随机 MAC 组：移出并标记隔离即可恢复
    // 独立设备（它本来就不参与随机 MAC 分组），不必再建组。
    if (!macIsRandom(mn)) {
      delete g.members[mn];
      S.aliases.isolated[mn] = true;
      deviceReindex();
      S.aliases.ver = nowTs;
      aliasSave();
      aliasBroadcast();
      return { ok: true, id: mn, mac: maccolon(mn), isolated: true };
    }
    delete g.members[mn];
    S.aliases.isolated[mn] = true;
    const gid = deviceNewGroup(mn, 'split:' + nowTs);
    if (!Object.keys(g.members).length) {
      delete S.aliases.groups[old];
      S.aliases.redirect[old] = gid;
      if (S.aliases.map[old]) {
        S.aliases.map[gid] = S.aliases.map[old];
        delete S.aliases.map[old];
      }
    }
    deviceReindex();
    S.aliases.ver = nowTs;
    aliasSave();
    aliasBroadcast();
    return { ok: true, id: gid, mac: maccolon(mn), isolated: true };
  }

  // ------------------------------------------------------- events / owner
  function diffEvents(prev, cur, apname) {
    if (!prev) return; // callers guard null (first round produces no events)
    for (const mn of Object.keys(cur)) {
      if (!prev[mn]) pushEvent('client_join', maccolon(mn), apname, clientNameOf(mn, cur));
    }
    for (const mn of Object.keys(prev)) {
      if (!cur[mn]) pushEvent('client_leave', maccolon(mn), apname, clientNameOf(mn, prev));
    }
  }

  function apDisplay(mn) {
    if (mn === macnorm(S.self.mac)) return S.self.name;
    const p = S.peers[mn];
    return p ? (p.info?.name ?? p.name ?? maccolon(mn)) : maccolon(mn);
  }

  // 终端归属表：同一终端可能被多个 AP 的 FDB 学到（对端 WiFi 终端会被
  // SAP 侧报成 wired），按 mac 去重，归属优先级：wifi > wired，本机 > 对端
  function computeOwner(my, selfMn) {
    const owner = {};
    for (const pass of ['wifi', 'wired']) {
      for (const [mn, c] of Object.entries(my)) {
        if (!owner[mn] && (c.type ?? 'wired') === pass) owner[mn] = selfMn;
      }
      for (const [pmn, p] of Object.entries(S.peers)) {
        for (const [mn, c] of Object.entries(p.clients ?? {})) {
          if (!owner[mn] && (c.type ?? 'wired') === pass) owner[mn] = pmn;
        }
      }
    }
    return owner;
  }

  // CAP 视角跨 AP 迁移事件：归属从一台 AP 变到另一台 => roam_move
  // （各 AP 本地的 join/leave 事件照旧保留，roam_move 是网络视角的结论）
  function ownerEvents(my) {
    if (S.cfg.role !== 'cap') return;
    const owner = computeOwner(my, macnorm(S.self.mac));
    if (S.prev_owner != null) {
      for (const [mn, ap] of Object.entries(owner)) {
        const old = S.prev_owner[mn];
        if (old != null && old !== ap) {
          pushEvent('roam_move', maccolon(mn),
            `${apDisplay(old)} → ${apDisplay(ap)}`, clientNameOf(mn, my));
        }
      }
    }
    S.prev_owner = owner;
  }

  function clientNode(mn, c, parent) {
    const key = deviceKey(mn), al = deviceAliasOf(key);
    const pin = pinOf(mn);
    const members = [];
    for (const member of deviceMembersOf(key)) members.push(maccolon(member));
    return {
      id: key, type: 'client',
      name: (al?.name != null && al.name !== '') ? al.name : (c.hostname ?? maccolon(mn)),
      custom_name: (al?.name != null && al.name !== '') ? al.name : null,
      hostname: c.hostname ?? null,
      ip: c.ip ?? null, mac: c.mac ?? maccolon(mn),
      members, grouped: members.length > 1,
      isolated: S.aliases.isolated[mn] === true,
      parent,
      conn: {
        type: c.type, band: c.band ?? null, ssid: c.ssid ?? null,
        rssi: c.rssi ?? null,
        tx_rate: c.tx_rate ?? null, rx_rate: c.rx_rate ?? null,
        // 实时速率（Mbps），由站点字节计数差分得到；无采样时为 null
        tx_speed: c.tx_speed ?? null, rx_speed: c.rx_speed ?? null,
        port: c.port ?? null, since: c.since ?? null,
      },
      icon: al?.icon ?? null, note: al?.note ?? null,
      pin, pin_name: pin ? apDisplay(pin) : null,
    };
  }

  async function buildTopology() {
    const nodes = [];
    const selfMn = macnorm(S.self.mac);
    await deviceGroupRefresh();
    const myclients = await localClients();
    const apNodes = {};
    const selfAl = S.aliases.map[selfMn];
    const uplink = detectUplink ? await detectUplink() : null;
    const uptime = await selfUptime();
    const selfNode = {
      id: selfMn, type: 'ap', role: S.cfg.role,
      name: (selfAl?.name != null && selfAl.name !== '') ? selfAl.name : S.self.name,
      custom_name: (selfAl?.name != null && selfAl.name !== '') ? selfAl.name : null,
      model: S.self.model,
      ip: S.self.ip, mac: S.self.mac,
      parent: null, uplink,
      firmware: S.self.firmware, uptime,
      clients: [],
    };
    nodes.push(selfNode);
    apNodes[selfMn] = selfNode;
    const peerClients = {};
    for (const [mn, p] of Object.entries(S.peers)) {
      const pal = S.aliases.map[mn];
      const pname = (pal?.name != null && pal.name !== '') ? pal.name
        : (p.info?.name ?? p.name ?? mn);
      const n = {
        id: mn, type: 'ap',
        role: p.info?.role ?? p.role ?? 'sap',
        name: pname,
        custom_name: (pal?.name != null && pal.name !== '') ? pal.name : null,
        model: p.info?.model ?? p.model ?? null,
        ip: p.info?.ip ?? p.ip, mac: p.mac ?? maccolon(mn),
        parent: selfMn,
        uplink: p.info?.uplink ?? null,
        firmware: p.info?.firmware ?? null,
        uptime: p.info?.uptime ?? null,
        authed: !!p.authed,
        clients: [],
      };
      nodes.push(n);
      apNodes[mn] = n;
      peerClients[mn] = p.clients ?? {};
    }
    // 按 mac 去重归属（规则见 compute_owner）
    const owner = computeOwner(myclients, selfMn);
    // 对端（SAP）无 DHCP 服务，其上报终端可能缺 ip/hostname，
    // 用本机 leases/ARP 补全，保证各 AP 下挂设备信息一致
    const leases = parseLeases();
    const neigh = parseNeigh();
    const grouped = {};
    for (const [mn, ap] of Object.entries(owner)) {
      const c = (ap === selfMn ? myclients : peerClients[ap])[mn];
      if (!c) continue;
      if (c.ip == null) c.ip = leases[mn]?.ip ?? neigh[mn]?.ip ?? S.net_names?.[mn]?.ip ?? null;
      if (c.hostname == null) c.hostname = leases[mn]?.hostname ?? S.net_names?.[mn]?.hostname ?? null;
      const key = deviceKey(mn);
      const old = grouped[key];
      const prefer = !old || (c.type === 'wifi' && old.c.type !== 'wifi') ||
        (c.type === old.c.type && c.rssi != null && (old.c.rssi == null || c.rssi > old.c.rssi));
      if (prefer) grouped[key] = { mn, c, ap };
    }
    for (const [key, item] of Object.entries(grouped)) {
      nodes.push(clientNode(item.mn, item.c, item.ap));
      apNodes[item.ap].clients.push(key);
    }
    return { nodes, self: selfMn, role: S.cfg.role, now: now() };
  }

  // -------------------------------------------------------- device history
  // 全网络当前在线的终端表（与 build_topology 相同的归属与信息补全规则）。
  // 返回：设备组 ID -> { mn, c, ap }
  async function devlistLive() {
    const my = await localClients();
    const selfMn = macnorm(S.self.mac);
    const live = {};
    for (const [mn, ap] of Object.entries(computeOwner(my, selfMn))) {
      const c = (ap === selfMn ? my : (S.peers[ap]?.clients ?? {}))[mn];
      if (!c) continue;
      const key = deviceKey(mn);
      const old = live[key];
      const prefer = !old || (c.type === 'wifi' && old.c.type !== 'wifi') ||
        (c.type === old.c.type && c.rssi != null && (old.c.rssi == null || c.rssi > old.c.rssi));
      if (prefer) live[key] = { mn, c, ap };
    }
    const leases = parseLeases();
    const neigh = parseNeigh();
    for (const it of Object.values(live)) {
      // SAP 无 DHCP，租约与主机名要由 CAP 下发的名称表补全
      if (it.c.ip == null) it.c.ip = leases[it.mn]?.ip ?? neigh[it.mn]?.ip ?? S.net_names?.[it.mn]?.ip ?? null;
      if (it.c.hostname == null) it.c.hostname = leases[it.mn]?.hostname ?? S.net_names?.[it.mn]?.hostname ?? null;
    }
    return live;
  }

  function devlistLoad() {
    const data = loadDevices(devicesPath);
    for (const [key, d] of Object.entries(data ?? {})) {
      if (!d || typeof d !== 'object') continue;
      // 重启后先全部置为离线，本轮扫描到的会立即被标回在线；
      // 这样断电期间产生的"最后离线时间"不会被伪造
      // (loadDevices already forces online=false; kept here for parity)
      d.online = false;
      S.devices[key] = d;
    }
  }

  function devlistSave(force) {
    const nowTs = now();
    if (!S.dev_dirty) return;
    if (!force && nowTs - S.dev_saved < DEVICES_FLUSH) return;
    saveDevices(devicesPath, S.devices);
    S.dev_saved = nowTs;
    S.dev_dirty = false;
  }

  // 历史条数上限：优先淘汰最久未上线、且从未被手动命名/分组的记录
  function devlistTrim() {
    let total = Object.keys(S.devices).length;
    if (total <= DEVICES_MAX) return;
    const cand = [];
    for (const [key, d] of Object.entries(S.devices)) {
      if (d.online) continue;
      if (S.aliases.map?.[key] || S.aliases.groups?.[key]) continue;
      cand.push({ key, ts: d.last_online ?? d.first_seen ?? 0 });
    }
    cand.sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < cand.length && total > DEVICES_MAX; i++, total--) delete S.devices[cand[i].key];
  }

  // 分组变化后历史键可能仍停留在旧 MAC / 旧组 ID：统一迁移到当前 device_key，
  // 同一物理设备的多条记录合并为一条（首次发现取最早，上下线时间取最新）。
  function devlistMergeEntry(dstk, src) {
    const dst = S.devices[dstk];
    if (!dst) { S.devices[dstk] = src; return; }
    if (src.first_seen && (!dst.first_seen || src.first_seen < dst.first_seen)) dst.first_seen = src.first_seen;
    if ((src.last_online ?? 0) > (dst.last_online ?? 0)) {
      dst.last_online = src.last_online;
      dst.mac = src.mac ?? dst.mac;
      dst.ip = src.ip ?? dst.ip;
      dst.hostname = src.hostname ?? dst.hostname;
      dst.ap = src.ap ?? dst.ap;
      dst.conn = src.conn ?? dst.conn;
    } else {
      dst.ip ??= src.ip;
      dst.hostname ??= src.hostname;
    }
    if ((src.last_offline ?? 0) > (dst.last_offline ?? 0)) dst.last_offline = src.last_offline;
    dst.online = dst.online || src.online;
  }

  function devlistNormalize() {
    let changed = false;
    for (const key of Object.keys(S.devices)) {
      const nk = deviceKey(key);
      if (nk === key) continue;
      devlistMergeEntry(nk, S.devices[key]);
      delete S.devices[key];
      changed = true;
    }
    if (changed) S.dev_dirty = true;
    return changed;
  }

  // 每轮 tick 更新在线状态与上下线时间
  async function devlistTick() {
    devlistNormalize();
    const nowTs = now();
    const live = await devlistLive();
    for (const [key, it] of Object.entries(live)) {
      let d = S.devices[key];
      if (!d) d = S.devices[key] = { first_seen: nowTs };
      if (!d.first_seen) d.first_seen = nowTs;
      if (!d.online) d.online = true;
      d.last_online = nowTs; // 只要在线就持续刷新，语义是"最后一次在线时间"
      d.mac = maccolon(it.mn);
      d.ip = it.c.ip ?? d.ip ?? null;
      d.hostname = it.c.hostname ?? d.hostname ?? null;
      d.ap = it.ap;
      d.conn = it.c.type ?? null;
      S.dev_dirty = true;
    }
    for (const [key, d] of Object.entries(S.devices)) {
      if (!live[key] && d.online) {
        d.online = false;
        d.last_offline = nowTs;
        S.dev_dirty = true;
      }
    }
    devlistTrim();
    devlistSave(false);
    return live;
  }

  // 终端设备页数据：历史记录 + 本轮在线信息合并，在线优先、最近在线靠前
  async function devlistView() {
    // 先刷新分组（含出厂 MAC 与随机 MAC 的跨频段合并），再读历史，
    // 保证页面看到的是合并后的记录而不是旧的两条
    await deviceGroupRefresh();
    const live = await devlistTick();
    const nowTs = now();
    const out = [];
    for (const [key, d] of Object.entries(S.devices)) {
      const it = live[key];
      const node = it ? clientNode(it.mn, it.c, it.ap) : null;
      const al = S.aliases.map?.[key] ?? deviceAliasOf(key);
      const custom = (al?.name != null && al.name !== '') ? al.name : null;
      const name = custom ?? node?.hostname ?? d.hostname ??
        node?.mac ?? d.mac ?? maccolon(macnorm(key));
      const ap = it?.ap ?? d.ap ?? null;
      const pin = pinOf(key);
      out.push({
        id: key,
        mac: node?.mac ?? d.mac ?? key,
        members: node?.members ?? [],
        grouped: node?.grouped ?? false,
        name, custom_name: custom,
        hostname: node?.hostname ?? d.hostname ?? null,
        ip: node?.ip ?? d.ip ?? null,
        online: !!it,
        first_seen: d.first_seen ?? null,
        last_online: it ? nowTs : (d.last_online ?? null),
        last_offline: d.last_offline ?? null,
        ap, ap_name: ap ? apDisplay(ap) : null,
        conn: node?.conn ?? null,
        icon: al?.icon ?? null, note: al?.note ?? null,
        isolated: node?.isolated ?? false,
        pin, pin_name: pin ? apDisplay(pin) : null,
        can_wake: !it,
      });
    }
    out.sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return (b.last_online ?? 0) - (a.last_online ?? 0);
    });
    // 固定 AP 下拉框的候选：本机 + 已知对端
    const aps = [{ id: macnorm(S.self.mac), name: S.self.name }];
    for (const mn of Object.keys(S.peers)) aps.push({ id: mn, name: apDisplay(mn) });
    aps.sort((a, b) => (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)));
    return { now: nowTs, devices: out, aps };
  }

  async function findClient(key) {
    const local = await localClients();
    const leases = parseLeases(), neigh = parseNeigh();
    let best = null;
    for (const mn of deviceMembersOf(key)) {
      let c = local[mn];
      let pmn = macnorm(S.self.mac), ap = S.self.name;
      if (!c) {
        for (const [pkey, p] of Object.entries(S.peers)) {
          if (!p.clients?.[mn]) continue;
          c = p.clients[mn]; pmn = pkey;
          ap = p.info?.name ?? p.name ?? pkey;
          break;
        }
      }
      if (!c) continue;
      if (c.ip == null) c.ip = leases[mn]?.ip ?? neigh[mn]?.ip ?? null;
      if (c.hostname == null) c.hostname = leases[mn]?.hostname ?? null;
      if (!best || (c.type === 'wifi' && best.c.type !== 'wifi') ||
        (c.rssi != null && (best.c.rssi == null || c.rssi > best.c.rssi))) {
        best = { mn, c, pmn, ap };
      }
    }
    if (!best) return null;
    return { node: clientNode(best.mn, best.c, best.pmn), ap: best.ap };
  }

  // --------------------------------------------------------------- wake on LAN
  // 直接在本机发魔术包：6×0xFF + 16×目标 MAC，UDP 广播到 7/9 端口。
  // 不依赖 etherwake/wakeonlan 二进制，SAP 与 CAP 都能用；广播域相同即可达。
  function wolPacket(mn) {
    const raw = Buffer.alloc(6);
    for (let i = 0; i < 12; i += 2) {
      const v = parseInt(String(mn).slice(i, i + 2), 16);
      raw[i / 2] = Number.isNaN(v) ? 0 : v;
    }
    const pkt = Buffer.alloc(6 + 16 * 6);
    pkt.fill(0xff, 0, 6);
    for (let i = 0; i < 16; i++) raw.copy(pkt, 6 + i * 6);
    return pkt;
  }

  function wolSend(mn) {
    const pkt = wolPacket(mn);
    let sock;
    try {
      sock = typeof ctx.wolSocketFactory === 'function'
        ? ctx.wolSocketFactory()
        : createSocket('udp4');
    } catch (_e) { return 0; }
    if (typeof sock.on === 'function') sock.on('error', () => { /* async send errors are per-target, below */ });
    try { sock.setBroadcast(true); } catch (_e) { /* broadcast flag failure: sends below still count per-target */ }
    const targets = [
      { address: '255.255.255.255', port: 9 },
      { address: '255.255.255.255', port: 7 },
    ];
    // 本机网段广播地址更容易被交换机/AP 转发（部分设备会丢弃 255.255.255.255）
    if (S.bcast && S.bcast !== '255.255.255.255') targets.push({ address: S.bcast, port: 9 });
    let sent = 0;
    for (const t of targets) {
      try {
        // node:dgram send() is async; a synchronous throw means the
        // datagram could not even be queued (original counted only
        // successful sock.send calls). Errors raised later surface on
        // the socket's 'error' event and do not change this count.
        sock.send(pkt, t.port, t.address);
        sent++;
      } catch (_e) { /* 单个目标失败不影响其它目标 */ }
    }
    // Defer close one tick so queued datagrams flush; unref so the
    // daemon's event loop is not kept alive by a wake-up socket.
    try {
      if (typeof sock.unref === 'function') sock.unref();
      const timer = setTimeout(() => { try { sock.close(); } catch (_e) { /* already closed */ } }, 10);
      if (typeof timer.unref === 'function') timer.unref();
    } catch (_e) {
      try { sock.close(); } catch (_ignored) { /* already closed */ }
    }
    return sent;
  }

  // ------------------------------------------------------ internet schedule
  // 定时断网规则存放在 wifiroam 的 ban section：
  //   mac(原始 MAC 或设备组 ID) / name / timeon(HH:MM) / timeoff(HH:MM) / weekdays
  // weekdays 为 "1 2 3"，1=周一 … 7=周日；timeon > timeoff 表示跨午夜。
  // 只在 CAP 执行：CAP 是网关，终端流量最终经由它的 forward 链转发。
  // NOTE on shapes: ban_read()/ban_list() return weekdays as an ARRAY of
  // numbers ([1,2,3,4,5]); the UCI value and the ban_set argument are the
  // SPACE-JOINED STRING ("1 2 3 4 5"). ban_weekdays() accepts both.
  function banHm(v) {
    const m = /^([0-9]{1,2}):([0-9]{1,2})$/.exec(String(v ?? ''));
    if (!m) return null;
    const h = toInt(m[1]), mi = toInt(m[2]);
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  }

  function banHmStr(mins) {
    const h = Math.trunc(mins / 60), mi = mins % 60;
    return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
  }

  function banWeekdays(v) {
    const s = Array.isArray(v) ? v.join('') : String(v ?? '').replace(/[^0-9]/g, '');
    const out = [];
    for (let i = 0; i < s.length; i++) {
      const d = toInt(s.slice(i, i + 1));
      if (d >= 1 && d <= 7 && !out.includes(d)) out.push(d);
    }
    out.sort((a, b) => a - b);
    return out;
  }

  function banRead() {
    uci.load('wifiroam');
    const leases = parseLeases();
    const list = [];
    const seen = {};
    uci.foreach('wifiroam', 'ban', (s) => {
      const mn = deviceKey(s.mac ?? '');
      if ((mn.length !== 12 && !/^g[0-9a-f]{12}$/.test(mn)) || seen[mn]) return;
      seen[mn] = true;
      const on = banHm(s.timeon), off = banHm(s.timeoff);
      const days = banWeekdays(s.weekdays);
      const members = deviceMembersOf(mn);
      const leaseName = members.length ? leases[members[0]]?.hostname : null;
      list.push({
        sid: s['.name'], mac: mn,
        name: (s.name ?? '') !== '' ? s.name : (deviceAliasOf(mn)?.name ?? leaseName ?? ''),
        timeon: on == null ? BAN_DEFAULT_ON : banHmStr(on),
        timeoff: off == null ? BAN_DEFAULT_OFF : banHmStr(off),
        weekdays: days.length ? days : [1, 2, 3, 4, 5, 6, 7],
      });
    });
    S.ban.list = list;
    return list;
  }

  // 当前是否处于断网时段；起止时间相同视为全天生效
  function banInWindow(b, lt, nowmin) {
    if (!b.weekdays || !b.weekdays.length) return false;
    const on = banHm(b.timeon), off = banHm(b.timeoff);
    if (on == null || off == null) return false;
    const wd = lt.wday === 0 ? 7 : lt.wday; // ucode: 0=周日
    if (on === off) return b.weekdays.includes(wd);
    if (on < off) return b.weekdays.includes(wd) && nowmin >= on && nowmin < off;
    // 跨午夜：今天已过起始时间，或昨天是起始日且还没到结束时间
    const prev = wd === 1 ? 7 : wd - 1;
    return (b.weekdays.includes(wd) && nowmin >= on) ||
      (b.weekdays.includes(prev) && nowmin < off);
  }

  // 软件/硬件 flow offload 命中的连接会绕过 forward 钩子。开始断网时清空
  // flowtable，让这些连接回落到正常转发路径，从而立即命中丢弃规则
  // （conntrack 状态保留，已有连接只是不再走快路径，不会被重置）。
  function banFlushFlows() {
    let fam = null, tab = null;
    for (const line of String(cmdOutput(shellCommands.nftListFlowtables())).split('\n')) {
      const t = /^[ \t]*table[ \t]+(\w+)[ \t]+(\w+)[ \t]*\{/.exec(line);
      if (t) { fam = t[1]; tab = t[2]; continue; }
      const f = /^[ \t]*flowtable[ \t]+(\w+)[ \t]*\{/.exec(line);
      if (f && fam && tab) cmdOutput(shellCommands.nftFlushFlowtable(fam, tab, f[1]));
    }
  }

  // 同步 nft：只在生效集合变化时重建，避免每 10s 刷链
  function banApply(force) {
    const blocked = {};
    const macs = [];
    if (S.cfg.role === 'cap' && S.ban.enabled) {
      const lt = localtime(now());
      const nowmin = lt.hour * 60 + lt.min;
      for (const b of banRead()) {
        if (!banInWindow(b, lt, nowmin)) continue;
        for (const x of deviceMembersOf(b.mac)) {
          if (!macs.includes(x)) macs.push(x);
          blocked[x] = true;
        }
      }
    }
    macs.sort();
    S.ban.active = blocked;
    // 只有 CAP 需要这张表；角色降级为 SAP 时清掉残留规则
    if (S.cfg.role !== 'cap') {
      if (force || S.ban.sig !== '') {
        cmdOutput(shellCommands.nftDeleteTable(BAN_TABLE));
        S.ban.sig = '';
      }
      return macs;
    }
    const sig = macs.join(',');
    if (!force && sig === S.ban.sig) return macs;
    S.ban.sig = sig;
    cmdOutput(shellCommands.nftAddTable(BAN_TABLE));
    cmdOutput(`nft add chain inet ${BAN_TABLE} forward '{ type filter hook forward priority -10; policy accept; }' 2>/dev/null`);
    cmdOutput(shellCommands.nftFlushChain(BAN_TABLE, 'forward'));
    if (macs.length) {
      let script = '';
      for (const mn of macs) {
        script += `add rule inet ${BAN_TABLE} forward ether saddr ${maccolon(mn)} counter drop\n`;
      }
      writeFile(BAN_NFT_FILE, script);
      cmdOutput(shellCommands.nftApplyFile(BAN_NFT_FILE));
      unlinkFile(BAN_NFT_FILE);
      banFlushFlows();
    }
    log(`ban: ${macs.length} device(s) blocked`);
    return macs;
  }

  // 已设置的上网时段数量。总开关的默认值只看时段是否设置过：
  // 未设置时间时默认关闭，保存过时间后默认开启。
  function banRuleCount() {
    uci.load('wifiroam');
    let n = 0;
    uci.foreach('wifiroam', 'ban', () => { n++; });
    return n;
  }

  // 总开关：显式配置优先；从未设置时按是否存在时段规则决定默认值。
  function banReloadEnabled() {
    uci.load('wifiroam');
    const configured = uci.get('wifiroam', 'schedule', 'enabled');
    S.ban.enabled = configured == null ? banRuleCount() > 0 : configured === '1';
    return S.ban.enabled;
  }

  function banLoad() {
    banReloadEnabled();
    banApply(true);
  }

  function banTick() {
    if (S.cfg.role !== 'cap') return;
    banApply(false);
  }

  // ------------------------------------------------------- ubus api handlers
  // Handlers for the wifiroam object's client-facing methods (spec §3.1
  // #2-8, #24-27). They take the plain args object (req.args) and return
  // the same shapes as the original call functions, including the raw
  // ubus status numbers for client_detail errors (INVALID_ARGUMENT=2,
  // NOT_FOUND=4). The api/core layer publishes them under their names.
  async function topology() {
    return buildTopology();
  }

  async function deviceHistory() {
    return devlistView();
  }

  async function wake(args) {
    let key = deviceKey(args.mac ?? '');
    if (!S.devices[key]) {
      key = macnorm(args.mac ?? '');
      if (!S.devices[key]) return { ok: false, error: 'unknown_device' };
    }
    // 只唤醒曾经在线过的设备（历史白名单），在线设备直接拒绝
    if (S.devices[key].online) return { ok: false, error: 'already_online' };
    const members = deviceMembersOf(key);
    if (!members.length) return { ok: false, error: 'invalid_mac' };
    let sent = 0;
    for (const mn of members) {
      if (mn.length === 12) sent += wolSend(mn);
    }
    if (!sent) return { ok: false, error: 'send_failed' };
    return { ok: true, sent, mac: maccolon(members[0]) };
  }

  async function clientDetail(args) {
    const mac = args.mac;
    if (!mac) return UBUS_STATUS.INVALID_ARGUMENT;
    const r = await findClient(devnorm(mac));
    if (!r) return UBUS_STATUS.NOT_FOUND;
    return { ok: true, client: r.node, ap: r.ap };
  }

  function setAlias(args) {
    const a = args;
    if (!a.mac) return UBUS_STATUS.INVALID_ARGUMENT;
    if (S.cfg.role === 'sap' && S.link?.authed) {
      // forward to CAP; CAP broadcasts the new alias table
      try {
        const p = S.link.chan.defer('alias_update',
          { mac: a.mac, name: a.name, icon: a.icon, note: a.note });
        if (p && typeof p.catch === 'function') p.catch(() => { /* empty cb: result ignored */ });
      } catch (_e) {
        sapDisconnect();
        return { ok: false, error: 'link_down' };
      }
      return { ok: true, forwarded: true };
    }
    if (!aliasApply(a.mac, a.name, a.icon, a.note)) return { ok: false, error: 'invalid_mac' };
    aliasBroadcast();
    return { ok: true, ver: S.aliases.ver };
  }

  function setPin(args) {
    const a = args;
    if (!a.mac) return UBUS_STATUS.INVALID_ARGUMENT;
    // SAP 侧改动同样交给 CAP 统一保存并广播，避免各 AP 记录不一致
    if (S.cfg.role === 'sap' && S.link?.authed) {
      try {
        const p = S.link.chan.defer('pin_update', { mac: a.mac, ap: a.ap ?? '' });
        if (p && typeof p.catch === 'function') p.catch(() => { /* empty cb: result ignored */ });
      } catch (_e) {
        sapDisconnect();
        return { ok: false, error: 'link_down' };
      }
      return { ok: true, forwarded: true };
    }
    const r = pinApply(a.mac, a.ap ?? '');
    if (r.ok) aliasBroadcast();
    return r;
  }

  async function ungroupDevice(args) {
    if (S.cfg.role !== 'cap') return { ok: false, error: 'not_cap' };
    const mn = macnorm(args.mac ?? '');
    if (mn.length !== 12) return { ok: false, error: 'invalid_mac' };
    const r = deviceUngroup(mn);
    if (r.ok) {
      // policy hooks, injected by core at wiring time (spec §8: clients
      // must not import policy directly).
      if (typeof ctx.appctlReadDevices === 'function') ctx.appctlReadDevices();
      if (S.appctl.enabled) {
        if (typeof ctx.appctlApplyRules === 'function') await ctx.appctlApplyRules();
        if (typeof ctx.appctlDpiDaemon === 'function') ctx.appctlDpiDaemon('reload');
      }
      banApply(true);
    }
    return r;
  }

  function banList() {
    const lt = localtime(now());
    const nowmin = lt.hour * 60 + lt.min;
    const items = [];
    for (const b of banRead()) {
      items.push({
        mac: b.mac, name: b.name,
        timeon: b.timeon, timeoff: b.timeoff,
        weekdays: b.weekdays, // ARRAY of numbers, 1=Mon..7=Sun (see note above)
        active: S.ban.enabled && banInWindow(b, lt, nowmin),
      });
    }
    return {
      ok: S.cfg.role === 'cap',
      error: S.cfg.role === 'cap' ? '' : 'not_cap',
      enabled: S.ban.enabled,
      items,
      blocked: Object.keys(S.ban.active).sort(),
    };
  }

  function setBan(args) {
    if (S.cfg.role !== 'cap') return { ok: false, error: 'not_cap' };
    const on = args.enabled ? true : false;
    uci.load('wifiroam');
    if (uci.get('wifiroam', 'schedule') == null) uci.set('wifiroam', 'schedule', 'schedule');
    uci.set('wifiroam', 'schedule', 'enabled', on ? '1' : '0');
    uci.commit('wifiroam');
    S.ban.enabled = on;
    banApply(true);
    return { ok: true, enabled: on };
  }

  async function banSet(args) {
    if (S.cfg.role !== 'cap') return { ok: false, error: 'not_cap' };
    const a = args;
    const mn = deviceKey(a.mac ?? '');
    if (mn.length !== 12 && !/^g[0-9a-f]{12}$/.test(mn)) return { ok: false, error: 'invalid_mac' };
    const on = banHm(a.timeon), off = banHm(a.timeoff);
    if (on == null || off == null) return { ok: false, error: 'invalid_time' };
    const days = banWeekdays(a.weekdays);
    if (!days.length) return { ok: false, error: 'invalid_weekdays' };
    let name = a.name ?? '';
    if (name === '') {
      const r = await findClient(mn);
      name = r?.node?.name ?? '';
    }
    uci.load('wifiroam');
    let sid = null;
    const old = [];
    uci.foreach('wifiroam', 'ban', (s) => {
      if (deviceKey(s.mac ?? '') === mn) {
        if (!sid) sid = s['.name'];
        old.push(s['.name']);
      }
    });
    if (!sid) {
      sid = uci.add('wifiroam', 'ban');
      uci.set('wifiroam', sid, 'mac', mn);
    }
    uci.set('wifiroam', sid, 'mac', mn);
    uci.set('wifiroam', sid, 'name', name);
    uci.delete('wifiroam', sid, 'enabled');
    uci.set('wifiroam', sid, 'timeon', banHmStr(on));
    uci.set('wifiroam', sid, 'timeoff', banHmStr(off));
    // UCI stores weekdays as the space-joined STRING ("1 2 3 4 5");
    // ban_read()/ban_list() return it as an ARRAY (see note above).
    uci.set('wifiroam', sid, 'weekdays', days.join(' '));
    for (const id of old) {
      if (id !== sid) uci.delete('wifiroam', id);
    }
    uci.commit('wifiroam');
    // 首次保存时段时总开关默认开启（已显式关闭的保持关闭）
    banReloadEnabled();
    banApply(true);
    let blocked = false;
    for (const member of deviceMembersOf(mn)) {
      if (S.ban.active[member]) blocked = true;
    }
    return { ok: true, mac: mn, blocked };
  }

  function banDel(args) {
    if (S.cfg.role !== 'cap') return { ok: false, error: 'not_cap' };
    const mn = deviceKey(args.mac ?? '');
    uci.load('wifiroam');
    const old = [];
    uci.foreach('wifiroam', 'ban', (s) => {
      if (deviceKey(s.mac ?? '') === mn) old.push(s['.name']);
    });
    if (!old.length) return { ok: false, error: 'not_found' };
    for (const sid of old) uci.delete('wifiroam', sid);
    uci.commit('wifiroam');
    // 删掉最后一个时段后，未显式配置的总开关回到默认关闭
    banReloadEnabled();
    banApply(true);
    return { ok: true };
  }

  return {
    // state / deps (exposed for core wiring and tests)
    state: S,
    // device key / grouping
    deviceKey, deviceReindex, deviceMembersOf, deviceAliasOf,
    deviceHostKey, deviceGenericHost, deviceGroupAuto, deviceNewGroup,
    deviceMergeGroups, deviceMergeEvidence, deviceGroupRefresh, deviceUngroup,
    // alias / pin
    aliasLoad, aliasSave, pinOf, pinApply, aliasApply, aliasBroadcast,
    // discovery / parsing
    freqBand, parseLeases, parseNeigh, clientNames, bridgePortNames,
    parseFdb, stationBytes, localClients, clientNameOf,
    // events / ownership / topology
    diffEvents, apDisplay, computeOwner, ownerEvents, clientNode,
    buildTopology, findClient,
    // history
    devlistLive, devlistLoad, devlistSave, devlistTrim, devlistMergeEntry,
    devlistNormalize, devlistTick, devlistView,
    // WOL
    wolPacket, wolSend,
    // ban
    banHm, banHmStr, banWeekdays, banRead, banInWindow, banFlushFlows,
    banApply, banRuleCount, banReloadEnabled, banLoad, banTick,
    // ubus api handlers (spec §3.1)
    topology, deviceHistory, wake, clientDetail,
    setAlias, setPin, ungroupDevice,
    banList, setBan, banSet, banDel,
  };
}
