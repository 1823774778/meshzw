// wifi.mjs -- 本机 Wi-Fi 配置应用、漫游配置（802.11k/v/r、ft_mode、
// RSSI 预设与阈值）、无线回程、终端引导（BSS Transition）、固定 AP。
// 对照原版 wifiroamd.uc（5498 行）§8 划分的 wifi 模块函数逐字搬运，
// 行号见 spec.md §2。只 import lib/（util / shell / ubus 常量 /
// uci / store）；不 import 其他业务模块。
//
// 工厂：createWifi(ctx)，ctx = { S, bus, uci, shell, util, store }，
// S 是 core 持有的共享 state（字段名与 spec §1.2 逐字一致）。
// 需要调其他模块的函数时只经 ctx 注入的回调（localClients /
// deviceKey / pushEvent / clientNameOf / apDisplay /
// parseFdb）；未注入时用本模块内的原样 fallback（按原版逻辑抄，
// 见各 fallback 处的注释），不直接 import 其他业务模块。
//
// 固定 AP（pin）归属：pin_of / pin_apply 的唯一实现在 clients 模块
// （core 的 set_pin 与 ctx.pinApply 接的都是 clients）；本模块不自带
// pin 实现。pinTick / steerTick 读固定关系只经 ctx.pinOf（core 注入
// clients.pinOf），未注入时工厂直接抛 TypeError，不留第二份实现。
//
// 目标：Node 22.23.4，ESM，零 npm 依赖，只用 Node 核心模块。
// research-node-ubus.md §1.5 的禁用清单一条不用（见该文档表）。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import {
  cmdOutput as libCmdOutput,
  runProcess as libRunProcess,
  shellCommands,
  PROC,
} from '../lib/shell.js';
import {
  fieldAfter,
  hhmmMinutes,
  log,
  maccolon,
  macnorm,
  nowSeconds,
  randhex,
  sha256,
  toInt,
} from '../lib/util.js';
import { uci as defaultUci } from '../lib/uci.js';

// ------------------------------------------------------------- 常量（原版）
// STEER_COOLDOWN=60s 同一终端两次 BSS Transition 引导的最小间隔；
// MIN_STEER_ASSOC=20s 终端入网后至少稳定这么久才允许被引导；
// STEER_KICK_AFTER=3 连续 BTM 引导无果的次数，达到后强制断开让终端重新选 AP；
// STEER_KICK_COOLDOWN=1800s 同一终端两次强制断开的最小间隔；
// PIN_BAN_MS=120000 固定终端连错 AP 时 hostapd 禁入时长（毫秒）；
// PIN_KICK_COOLDOWN=30s 同一终端两次踢回目标 AP 的最小间隔。
export const STEER_COOLDOWN = 60;
export const MIN_STEER_ASSOC = 20;
export const STEER_KICK_AFTER = 3;
export const STEER_KICK_COOLDOWN = 1800;
export const PIN_BAN_MS = 120000;
export const PIN_KICK_COOLDOWN = 30;
export const BACKHAUL_SECTION = 'wifiroam_bh';
export const BACKHAUL_DEFAULT_SSID = 'wifiroam-bh';
export const MAX_EVENTS = 100;

// 回程转发方式（wifiroam.backhaul.mode）：
//   relay（默认）：普通三段地址 STA + relayd 伪桥，不依赖驱动的 4addr/WDS；
//   wds：旧的四地址桥接，需要 hostapd 端 wds_sta 与 AP_VLAN 正常工作。
export const BACKHAUL_DEFAULT_MODE = 'relay';
// relay 模式下 SAP 的 STA 独占一个 netifd 接口（不挂 br-lan），由 relayd
// 在 br-lan 与 STA 之间代理；wds 模式下才把 STA 桥进 LAN。
export const BACKHAUL_STA_SECTION = 'wifiroam_sta';
export const RELAYD_PATH = '/usr/sbin/relayd';
export const RELAY_FW_MARK = 'wifiroam-relay';
export const NFT_PATH = '/usr/sbin/nft';
// udhcpc 钩子追加的租约记录（JS 版没有 ubus 订阅，靠这条文件确认新租约）
export const DHCP_LEASE_LOG = '/tmp/wifiroam/dhcp-leases.log';

// 时序常量（与 ucode 版 r135 完全一致，改一处必须两边一起改）
export const BH_WIRED_DEBOUNCE = 12; // s：有线持续存在多久才暂停 STA
export const BH_WIRELESS_DEBOUNCE = 10; // s：有线消失多久才重新启用 STA
export const BH_STA_REARM = 60; // s：STA 已启用却不转发多久后重新拉起
export const BH_LOOP_CONFIRM = 4; // s：环路连续确认时间
export const BH_WIRED_HOLD = 30; // s：有线口最后确认后，载波仍在则继续视为有线
export const BH_STA_REBUILD_INTERVAL = 30; // s：STA 接口缺失时的重建间隔
export const BH_DHCP_RETRY = 8; // s：重试启动未运行的 DHCP 客户端
export const BH_DHCP_RENEW_HOLD = 35; // s：STA 短暂抖动时让上次续租完成
export const BH_DHCP_WARN = 45; // s：未确认新租约时告警
export const BH_RELAY_PROBE = 5; // s：relayd 缺失时重新拉起的检查间隔
export const BH_FW_PROBE = 30; // s：防火墙放行规则缺失后补回的检查间隔
export const BH_WEDGE_CONFIRM = 30; // s：关联但从不授权持续多久算楔死
export const BH_WEDGE_PROBE = 60; // s：翻日志判楔死的检查间隔
export const BH_WEDGE_LOG = 300; // s：同一条楔死日志的最小间隔

// 漫游键（原版 ROAM_KEYS，14 个）：不在漫游组的 SSID 仅当其现含
// ieee80211r/k/v 任一键时才删除全部这些键。
export const ROAM_KEYS = [
  'ieee80211r', 'mobility_domain', 'ft_over_ds', 'ft_psk_generate_local',
  'nas_identifier', 'pmk_r1_push', 'r0kh', 'r1kh', 'reassociation_deadline',
  'ieee80211k', 'rrm_neighbor_report', 'rrm_beacon_report',
  'ieee80211v', 'bss_transition',
];

// 默认 fs 适配器：detect_self / local_iface_macs / self_uptime /
// precheck 读 /proc、/sys、/tmp/sysinfo、/etc/openwrt_release 与
// apk 存在性判断。测试可经 ctx.fs 注入同形适配器。
// readFile(path) -> string | null；glob(pattern) -> string[]；
// access(path) -> boolean。
const defaultFs = {
  readFile(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch (_e) {
      return null;
    }
  },
  glob(pattern) {
    // 只服务 "/sys/class/net/*/address" 这一形；其余返回 []。
    const m = /^(\/[^*]*)\/\*(\/.*)$/.exec(pattern);
    if (!m) return [];
    let names = [];
    try {
      names = readdirSync(m[1]);
    } catch (_e) {
      return [];
    }
    const out = [];
    for (const n of names) {
      const p = `${m[1]}/${n}${m[2]}`;
      if (existsSync(p)) out.push(p);
    }
    return out;
  },
  access(path) {
    return existsSync(path);
  },
};

export function createWifi(ctx = {}) {
  const S = ctx.S ?? {};
  const bus = ctx.bus ?? null; // UbusClient（lib/ubus.js），可为 null（纯配置路径）
  const uci = ctx.uci ?? defaultUci;
  const shell = ctx.shell ?? {};
  const cmdOutput = typeof shell.cmdOutput === 'function' ? shell.cmdOutput : libCmdOutput;
  const runProcess = typeof shell.runProcess === 'function' ? shell.runProcess : libRunProcess;
  const fs = ctx.fs ?? defaultFs;

  // --- 跨模块回调（ctx 注入；未注入时用本模块的原样 fallback） ---
  // device_key：clients 模块的函数。fallback 按原版 device_key 逐字抄：
  // g 开头走 redirect 链（最多 16 跳），否则查 state.device_index。
  const deviceKey = typeof ctx.deviceKey === 'function'
    ? ctx.deviceKey
    : (v) => {
      const s = String(v ?? '').trim().toLowerCase();
      let key = /^g[0-9a-f]{12}$/.test(s) ? s : macnorm(s);
      if (key.startsWith('g')) {
        let guard = 0;
        while (S.aliases?.redirect?.[key] && guard++ < 16) key = S.aliases.redirect[key];
        return key;
      }
      return S.device_index?.[key] ?? key;
    };
  // push_event：core 的函数。fallback 按原版 push_event 抄：环形缓冲
  // 上限 MAX_EVENTS(100)，并 log。
  const pushEvent = typeof ctx.pushEvent === 'function'
    ? ctx.pushEvent
    : (type, mac, info, name) => {
      if (!Array.isArray(S.events)) S.events = [];
      S.events.push({ ts: nowSeconds(), type, mac: mac ?? '', name: name ?? '', info: info ?? '' });
      if (S.events.length > MAX_EVENTS) S.events = S.events.slice(S.events.length - MAX_EVENTS);
      log(`event ${type} ${mac ?? '-'} ${name ?? '-'} ${info ?? ''}`);
    };
  // pin_of：clients 模块的唯一实现（core 注入 clients.pinOf）。
  // pin 的写路径 pin_apply 只在 clients（set_pin 经 core 调它），
  // 本模块从不写 pin，因此只接 pinOf；未注入时 fail-fast，不留
  // 第二份 pin 实现。
  if (typeof ctx.pinOf !== 'function') {
    throw new TypeError('wifi: ctx.pinOf (clients.pinOf) is required');
  }
  const pinOf = ctx.pinOf;
  // local_clients：clients 模块的唯一终端数据源。
  const localClients = typeof ctx.localClients === 'function'
    ? ctx.localClients
    : () => ({});
  // client_name_of：终端展示名优先级：自定义别名 > 本机/对端主机名 >
  // 本网络名称表 > MAC。fallback 按原版抄（local 为本次已有客户端表）。
  const clientNameOf = typeof ctx.clientNameOf === 'function'
    ? ctx.clientNameOf
    : (mn, local) => {
      const key = deviceKey(mn);
      const al = S.aliases?.map?.[key] ?? S.aliases?.map?.[macnorm(mn)] ?? null;
      if (al?.name != null && al.name !== '') return al.name;
      const c = local?.[mn];
      if (c?.hostname != null && c.hostname !== '') return c.hostname;
      for (const p of Object.values(S.peers ?? {})) {
        const pc = p.clients?.[mn];
        if (pc?.hostname != null && pc.hostname !== '') return pc.hostname;
      }
      const n = S.net_names?.[mn];
      if (n?.hostname != null && n.hostname !== '') return n.hostname;
      return maccolon(mn);
    };
  // ap_display：本机返回 self.name，否则 peer 名，未知返回冒号 MAC。
  const apDisplay = typeof ctx.apDisplay === 'function'
    ? ctx.apDisplay
    : (mn) => {
      if (mn === macnorm(S.self?.mac)) return S.self?.name;
      const p = S.peers?.[mn];
      if (p) return p.info?.name ?? p.name ?? maccolon(mn);
      return maccolon(mn);
    };
  // parse_fdb：clients 模块的函数（ethernet_uplink_port 用）。
  // fallback 按原版 parse_fdb 逐字抄：`bridge fdb show`，空输出时回退
  // `brctl showmacs` + `brctl showstp` 端口名映射。
  const parseFdb = typeof ctx.parseFdb === 'function'
    ? ctx.parseFdb
    : () => {
      const out = {};
      const data = cmdOutput(shellCommands.bridgeFdbShow(S.brdev ?? 'br-lan'));
      if (data !== '') {
        for (const line of data.split('\n')) {
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
      const pnames = {};
      const stp = cmdOutput(shellCommands.bridgePortNames(S.brdev ?? 'br-lan'));
      for (const line of stp.split('\n')) {
        const m = /^([^\s]+) \(([0-9]+)\)/.exec(line);
        if (m) pnames[m[2]] = m[1];
      }
      const data2 = cmdOutput(shellCommands.brctlShowmacs(S.brdev ?? 'br-lan'));
      for (const line of data2.split('\n')) {
        const f = line.trim().split(/[ \t]+/);
        if (f.length < 3) continue;
        const mn = macnorm(f[1]);
        if (mn.length !== 12) continue;
        if (f[2] === 'yes') continue; // 网桥自身接口 MAC
        out[mn] = pnames[f[0]] ?? f[0];
      }
      return out;
    };

  // ubus 调用：原版 ubusc.call 为同步，失败返回 null/抛错（见 §9.22
  // 附近的讨论）；lib/ubus.js 的 call() 是 async 且失败时抛
  // UbusError。这里按原版调用点的兜底语义：detect_self /
  // wireless_uplink / self_info 路径上失败返回 null；ap_nr_self、
  // neighbor_sync、steer_tick、pin_tick 各自有 try/catch（原版同）。
  async function busCall(path, method, data) {
    if (!bus) return null;
    try {
      return await bus.call(path, method, data);
    } catch (_e) {
      return null;
    }
  }

  // 抛错版：steer_tick / pin_tick 原版在每次 hostapd 调用外包
  // try/catch，失败时只 log，不更新 steer_last / steer_tries /
  // kick_last / pin_last；若在此处吞掉错误，失败的引导会被误记
  // 为成功，故这几处必须用抛错版，让外层 catch 接住。
  async function busCallThrow(path, method, data) {
    if (!bus) throw new Error('wifi: no ubus client');
    return bus.call(path, method, data);
  }

  // ------------------------------------------------------------ 自检/探测
  // lan_broadcast：由 LAN IP 与掩码算广播地址；解析失败返回
  // 255.255.255.255。ucode 无 >>> 运算符，0xffffffff 在 int64 下为
  // 正数，>> 等效逻辑右移；JS 用 >>> 保持等价。
  function lanBroadcast(ip, mask) {
    const parts = String(ip ?? '').split('.');
    if (parts.length !== 4) return '255.255.255.255';
    let v = 0;
    for (const p of parts) v = ((v << 8) | (toInt(p) & 255)) >>> 0;
    const m = toInt(mask);
    const hostmask = (m > 0 && m < 32) ? (0xffffffff >>> m) : 0xff;
    const b = (v | hostmask) >>> 0;
    return `${(b >>> 24) & 255}.${(b >>> 16) & 255}.${(b >>> 8) & 255}.${b & 255}`;
  }

  // 本机所有网络接口 MAC：用于把 AP 自身的接口（如无线回程 STA 口）
  // 从“下挂终端”中排除，避免 AP 被同时计为终端导致数量虚高。
  function localIfaceMacs() {
    const out = {};
    for (const f of fs.glob('/sys/class/net/*/address')) {
      if (f.includes('/lo/')) continue;
      const m = macnorm(String(fs.readFile(f) ?? '').trim());
      if (m.length === 12 && m !== '000000000000') out[m] = true;
    }
    return out;
  }

  // 探测本机：读 network.interface.lan 状态、/sys 接口 MAC、
  // /etc/openwrt_release、hostname、model，填 state.self 与 state.bcast、
  // nonce（randhex(16)）。（spec §9.7：各字段回落值以原文为准。）
  async function detectSelf() {
    const st = await busCall('network.interface.lan', 'status');
    const dev = st?.device ?? st?.l3_device ?? 'br-lan';
    S.brdev = dev;
    const ip = st?.['ipv4-address']?.[0]?.address ?? null;
    const mask = st?.['ipv4-address']?.[0]?.mask ?? 24;
    S.bcast = lanBroadcast(ip, mask);
    let mac = String(fs.readFile(`/sys/class/net/${dev}/address`) ?? '').trim();
    if (macnorm(mac).length !== 12) {
      for (const f of fs.glob('/sys/class/net/*/address')) {
        if (f.includes('/lo/')) continue;
        const m = String(fs.readFile(f) ?? '').trim();
        if (macnorm(m).length === 12) { mac = m; break; }
      }
    }
    const rel = fs.readFile('/etc/openwrt_release') ?? '';
    let fw = 'OpenWrt';
    const m = /DISTRIB_DESCRIPTION='([^']+)'/.exec(rel);
    if (m) fw = m[1];
    S.self = {
      mac: String(mac).toUpperCase(),
      ip,
      hostname: String(fs.readFile('/proc/sys/kernel/hostname') ?? 'OpenWrt').trim(),
      model: String(fs.readFile('/tmp/sysinfo/model') ?? 'OpenWrt device').trim(),
      firmware: fw,
      nonce: randhex(16),
      ifaces: localIfaceMacs(),
    };
    S.self.name = S.cfg?.name !== '' ? S.cfg.name : S.self.hostname;
    log(`self: ${S.self.mac} ${S.self.ip ?? '?'} ${S.self.name}`);
  }

  // 无线回程检测：优先看本插件托管的 STA 接口，其次看其它已关联的 STA。
  // 仅当 STA 真实关联（iw link 显示 Connected）才算无线上行，避免把
  // “配置了但没连上”的接口误报成回程。
  async function wirelessUplink() {
    const ws = (await busCall('network.wireless', 'status')) ?? {};
    let fallback = null;
    for (const r of Object.values(ws)) {
      for (const ifc of r.interfaces ?? []) {
        if (ifc.config?.mode !== 'sta' || !ifc.ifname) continue;
        const link = cmdOutput(shellCommands.iwDevLink(ifc.ifname));
        if (link.indexOf('Connected to') < 0) continue;
        const m = /Connected to ([0-9a-fA-F:]+)/.exec(link);
        const s = /signal:\s*(-?[0-9]+)/.exec(link);
        const info = {
          type: 'wireless', port: ifc.ifname,
          ssid: ifc.config?.ssid ?? null,
          bssid: m ? m[1].toLowerCase() : null,
          rssi: s ? toInt(s[1]) : null,
        };
        if (ifc.section === BACKHAUL_SECTION) return info;
        if (!fallback) fallback = info;
      }
    }
    return fallback;
  }

  function detectUplink() {
    const out = cmdOutput(shellCommands.ipRouteDefault());
    const words = String(out.split('\n')[0] ?? '').trim().split(' ');
    const gw = fieldAfter(words, 'via');
    const dev = fieldAfter(words, 'dev');
    const wireless = dev && (fs.access(`/sys/class/net/${dev}/wireless`)
      || dev.indexOf('wlan') === 0 || dev.indexOf('wl') === 0);
    // 同步路径上 wireless_uplink 是 ubus+shell 调用：原版 detect_uplink
    // 直接调用 wireless_uplink()（同步 ucode call）。JS 侧 bus.call 是
    // 异步，故 detectUplink 只在已有缓存/同步场景用；selfInfo() 用
    // detectUplinkAsync()。此处保留同步签名：无线回程信息由调用方
    // 经 wirelessUplink() 另行取得后传入（见 detectUplinkAsync）。
    return { type: wireless ? 'wireless' : 'wired', port: dev, gw };
  }

  // detect_uplink 的完整异步版：先取无线回程，再按原版规则决定类型。
  // 本插件托管的无线回程已关联时，回程类型以它为准（即使物理上还有网线）。
  async function detectUplinkAsync() {
    const out = cmdOutput(shellCommands.ipRouteDefault());
    const words = String(out.split('\n')[0] ?? '').trim().split(' ');
    const gw = fieldAfter(words, 'via');
    const dev = fieldAfter(words, 'dev');
    const wireless = dev && (fs.access(`/sys/class/net/${dev}/wireless`)
      || dev.indexOf('wlan') === 0 || dev.indexOf('wl') === 0);
    const wl = await wirelessUplink();
    if (wl && (wl.port === BACKHAUL_SECTION || currentBackhaulCfg().enabled)) {
      return {
        type: 'wireless', port: wl.port, gw, ssid: wl.ssid,
        bssid: wl.bssid, rssi: wl.rssi,
      };
    }
    return { type: wireless ? 'wireless' : 'wired', port: dev, gw };
  }

  function selfUptime() {
    return toInt(String(fs.readFile('/proc/uptime') ?? '0').trim().split(' ')[0]);
  }

  function wifiIfaces() {
    const out = [];
    uci.load('wireless');
    uci.foreach('wireless', 'wifi-iface', (s) => {
      if (s.mode && s.mode !== 'ap') return;
      if (s.disabled === '1') return;
      if (s.wifiroam_guest === '1') return; // 访客口不算主人网络
      out.push({
        ssid: s.ssid ?? '',
        encryption: s.encryption ?? 'none',
        band: uci.get('wireless', s.device, 'band') ?? '?',
        device: s.device,
        section: s['.name'],
      });
    });
    return out;
  }

  // 本机各 AP 口的 11k 邻居报告元素：直接取 hostapd 自己生成的 NR
  // （含正确的 op_class / channel / PHY 类型），避免自行推算信道分组
  // 出错，也保证与 AP 实际信道一致（5G 信道在各 AP 上并不相同）。
  async function apNrSelf() {
    const out = [];
    let ws = null;
    try {
      ws = (await busCall('network.wireless', 'status')) ?? {};
    } catch (_e) {
      return out;
    }
    for (const r of Object.values(ws ?? {})) {
      for (const ifc of r.interfaces ?? []) {
        if (!ifc.ifname) continue;
        if (ifc.config?.mode && ifc.config.mode !== 'ap') continue;
        let own = null;
        let st = null;
        try {
          own = await busCall(`hostapd.${ifc.ifname}`, 'rrm_nr_get_own');
          st = await busCall(`hostapd.${ifc.ifname}`, 'get_status');
        } catch (_e) {
          continue;
        }
        const v = own?.value;
        if (!Array.isArray(v) || v.length < 3) continue;
        out.push({
          ifname: ifc.ifname,
          bssid: String(v[0]).toLowerCase(),
          ssid: v[1] ?? '',
          nr: v[2],
          band: toInt(st?.freq ?? 0) < 3000 ? '2g' : '5g',
          channel: st?.channel ?? null,
        });
      }
    }
    return out;
  }

  // 可广播给对端的部分（不含本机网卡名，对端不能直接调用本机 hostapd）
  async function apNrPublic() {
    const out = [];
    for (const e of await apNrSelf()) {
      out.push({
        bssid: e.bssid, ssid: e.ssid, nr: e.nr,
        band: e.band, channel: e.channel,
      });
    }
    return out;
  }

  async function selfInfo() {
    return {
      mac: S.self?.mac, ip: S.self?.ip,
      name: S.self?.name, hostname: S.self?.hostname,
      model: S.self?.model, firmware: S.self?.firmware,
      role: S.cfg?.role, uptime: selfUptime(),
      ifaces: S.self?.ifaces ?? {},
      wifi: wifiIfaces(), uplink: await detectUplinkAsync(),
      nr: await apNrPublic(),
    };
  }

  // ------------------------------------------------------- Wi-Fi 前台设置
  // 读取本机所有 AP 口的 SSID / 是否设了密码，供「无线设置」表单回填。
  // unified 表示「多频合一」：所有 AP 口同名且同密码（密码不对外返回）。
  function wifiSummary() {
    uci.load('wireless');
    const ifaces = [];
    let hasKey = false;
    let unified = true;
    let firstSsid = null;
    let firstKey = null;
    uci.foreach('wireless', 'wifi-iface', (s) => {
      if (s.mode && s.mode !== 'ap') return;
      if (s.wifiroam_guest === '1') return; // 访客网络有独立面板，不参与多频合一判断
      const ssid = s.ssid ?? '';
      const key = s.key ?? '';
      ifaces.push({
        section: s['.name'], device: s.device, ssid,
        encryption: s.encryption ?? 'none',
        band: uci.get('wireless', s.device, 'band') ?? '?',
      });
      if (key !== '') hasKey = true;
      if (firstSsid == null) { firstSsid = ssid; firstKey = key; } else if (ssid !== firstSsid || key !== firstKey) unified = false;
    });
    const first = ifaces[0];
    // 只显示第一组 SSID，多口不一致时标记出来，避免把不同 SSID 合并成假象
    let mixed = false;
    for (const i of ifaces) if (i.ssid !== (first?.ssid ?? '')) mixed = true;
    return {
      ssid: first?.ssid ?? '', has_key: hasKey, mixed,
      unified, ifaces,
    };
  }

  // 改本机全部 AP 口的 SSID 与密码。ssids = [{ band, ssid, key }]，
  // 同频段的接口取同名同密码。某一项的 key 为空表示该频段只改名称、
  // 不动密码。无线重启放在后台：前端请求先返回，避免重启把连接断开
  // 导致界面误判失败。
  function applyWifiLocal(ssids) {
    uci.load('wireless');
    let n = 0;
    uci.foreach('wireless', 'wifi-iface', (s) => {
      if (s.mode && s.mode !== 'ap') return;
      if (s.wifiroam_guest === '1') return; // 访客口由访客面板单独管理
      const band = uci.get('wireless', s.device, 'band') ?? '?';
      let want = null;
      for (const it of ssids ?? []) if (it.band === band) want = it;
      if (want != null && want.ssid !== '') uci.set('wireless', s['.name'], 'ssid', want.ssid);
      if (want != null && want.key !== '') {
        uci.set('wireless', s['.name'], 'key', want.key);
        // 开放网络加密为 none/空时补上 WPA2，否则设了密码也不生效
        const enc = s.encryption ?? '';
        if (enc === '' || enc === 'none') uci.set('wireless', s['.name'], 'encryption', 'psk2');
      }
      n++;
    });
    uci.commit('wireless');
    if (n > 0) cmdOutput(shellCommands.wifiReloadDelayed());
    return { ok: n > 0, count: n };
  }

  // 漫游组里记录的 SSID 必须跟着改名，否则 802.11k/v/r 会因找不到
  // 同名 SSID 失效。pairs = [{ old, new }]：按「旧名 -> 新名」替换，
  // 并把仍是新名的条目补齐，避免两个频段同名时连续重命名把另一个
  // 频段的组从列表里挤掉。
  function roamRenameSsids(pairs) {
    let hit = 0;
    for (const p of pairs ?? []) if (p.old !== '' && p.old !== p.new) hit++;
    if (hit === 0) return;
    uci.load('wifiroam');
    const raw = uci.get('wifiroam', 'roam', 'ssids') ?? [];
    let list = [];
    if (Array.isArray(raw)) list = raw;
    else if (raw !== '') list = [raw];
    const out = [];
    for (const s of list) {
      let mapped = s;
      for (const p of pairs) {
        if (p.old === s && p.new !== '') { mapped = p.new; break; }
      }
      out.push(mapped);
    }
    for (const p of pairs) if (p.new !== '' && !out.includes(p.new)) out.push(p.new);
    // 两个频段并成一组合一时，替换后可能留下重复项
    const dedup = [];
    for (const s of out) if (!dedup.includes(s)) dedup.push(s);
    uci.set('wifiroam', 'roam', 'ssids', dedup);
    uci.commit('wifiroam');
  }

  // ------------------------------------------------------------- 漫游配置
  function rssiPreset(profile) {
    return { aggressive: -62, balanced: -70, conservative: -78 }[profile] ?? -70;
  }

  function currentRoamCfg() {
    uci.load('wifiroam');
    let ssids = [];
    const raw = uci.get('wifiroam', 'roam', 'ssids');
    if (Array.isArray(raw)) ssids = raw;
    else if (typeof raw === 'string' && raw !== '') ssids = [raw];
    let profile = uci.get('wifiroam', 'roam', 'rssi_profile') ?? 'balanced';
    if (!['aggressive', 'balanced', 'conservative', 'custom'].includes(profile)) profile = 'balanced';
    let threshold = toInt(uci.get('wifiroam', 'roam', 'rssi_threshold') ?? rssiPreset(profile));
    if (profile !== 'custom') threshold = rssiPreset(profile);
    if (threshold > -30) threshold = -30;
    if (threshold < -95) threshold = -95;
    return {
      enabled: uci.get('wifiroam', 'roam', 'enabled') === '1',
      ssids,
      // spec §9.3：r_fast 缺失时 `null != "0"` 的 ucode 求值未在规格中
      // 说明；此处按字面比较：缺失（null）时 != "0" 为 true，即默认开。
      r_fast: uci.get('wifiroam', 'roam', 'r_fast') !== '0',
      ft_mode: uci.get('wifiroam', 'roam', 'ft_mode') ?? 'simple',
      ft_over_ds: uci.get('wifiroam', 'roam', 'ft_over_ds') !== '0',
      k_neighbor: uci.get('wifiroam', 'roam', 'k_neighbor') !== '0',
      k_beacon: uci.get('wifiroam', 'roam', 'k_beacon') !== '0',
      v_bss_transition: uci.get('wifiroam', 'roam', 'v_bss_transition') !== '0',
      rssi_profile: profile,
      rssi_threshold: threshold,
      config_ver: toInt(uci.get('wifiroam', 'roam', 'config_ver') ?? '0'),
    };
  }

  // 漫游配置内容签名：SAP 上报本地已落盘配置的签名，CAP 据此判断是否
  // 与主 AP 一致。只比 ver 无法发现历史遗留的不一致（旧版 SAP 只落盘
  // ver/enabled，其他字段仍是默认值）。
  function roamSig(r) {
    return sha256(
      `${r.enabled ? 1 : 0}|${(r.ssids ?? []).join(',')}|${r.r_fast ? 1 : 0}|`
      + `${r.ft_mode ?? 'simple'}|${r.ft_over_ds ? 1 : 0}|${r.k_neighbor ? 1 : 0}|`
      + `${r.k_beacon ? 1 : 0}|${r.v_bss_transition ? 1 : 0}|${r.rssi_profile ?? 'balanced'}|`
      + `${r.rssi_threshold ?? rssiPreset(r.rssi_profile)}`,
    );
  }

  function roamMd(ssid) {
    return sha256(`md:${ssid}`).slice(0, 4);
  }
  function roamKey0(mac) {
    return sha256(`${S.cfg?.token ?? ''}:r0:${macnorm(mac)}`).slice(0, 32);
  }
  function roamKey1(mac) {
    return sha256(`${S.cfg?.token ?? ''}:r1:${macnorm(mac)}`).slice(0, 32);
  }

  function memberList() {
    const members = [{ mac: S.self?.mac, name: S.self?.name }];
    for (const [mn, p] of Object.entries(S.peers ?? {})) {
      if (p.authed) {
        members.push({
          mac: p.mac ?? maccolon(mn),
          name: p.info?.name ?? p.name ?? mn,
        });
      }
    }
    return members;
  }

  function applyRoamLocal(roam, members) {
    uci.load('wireless');
    const touched = [];
    const selfNasid = macnorm(S.self?.mac).toUpperCase();
    uci.foreach('wireless', 'wifi-iface', (s) => {
      if (s.mode && s.mode !== 'ap') return;
      if (s.wifiroam_guest === '1') return;
      const sid = s['.name'];
      const inGroup = roam.enabled && (roam.ssids ?? []).includes(s.ssid);
      if (inGroup) {
        // R（802.11r）可单独关闭：关闭时移除全部 FT 相关键，只保留 K/V
        if (roam.r_fast) {
          uci.set('wireless', sid, 'ieee80211r', '1');
          uci.set('wireless', sid, 'mobility_domain', roamMd(s.ssid));
          uci.set('wireless', sid, 'ft_over_ds', roam.ft_over_ds ? '1' : '0');
          uci.set('wireless', sid, 'reassociation_deadline', '2000');
          if (roam.ft_mode === 'explicit') {
            uci.set('wireless', sid, 'ft_psk_generate_local', '0');
            uci.set('wireless', sid, 'nas_identifier', `${selfNasid}-${s.ssid}`);
            uci.set('wireless', sid, 'pmk_r1_push', '1');
            const r0 = [];
            const r1 = [];
            for (const m of members ?? []) {
              const mm = m.mac;
              r0.push(`${mm},${macnorm(mm).toUpperCase()}-${s.ssid},${roamKey0(mm)}`);
              r1.push(`${mm},${mm},${roamKey1(mm)}`);
            }
            uci.set('wireless', sid, 'r0kh', r0);
            uci.set('wireless', sid, 'r1kh', r1);
          } else {
            uci.set('wireless', sid, 'ft_psk_generate_local', '1');
            for (const k of ['nas_identifier', 'pmk_r1_push', 'r0kh', 'r1kh']) uci.delete('wireless', sid, k);
          }
        } else {
          for (const k of ['ieee80211r', 'mobility_domain', 'ft_over_ds',
            'ft_psk_generate_local', 'reassociation_deadline',
            'nas_identifier', 'pmk_r1_push', 'r0kh', 'r1kh']) uci.delete('wireless', sid, k);
        }
        uci.set('wireless', sid, 'ieee80211k', '1');
        uci.set('wireless', sid, 'rrm_neighbor_report', roam.k_neighbor ? '1' : '0');
        uci.set('wireless', sid, 'rrm_beacon_report', roam.k_beacon ? '1' : '0');
        uci.set('wireless', sid, 'ieee80211v', '1');
        uci.set('wireless', sid, 'bss_transition', roam.v_bss_transition ? '1' : '0');
        touched.push(s.ssid);
      } else {
        // only strip keys we manage, and only if present
        if (uci.get('wireless', sid, 'ieee80211r') != null
          || uci.get('wireless', sid, 'ieee80211k') != null
          || uci.get('wireless', sid, 'ieee80211v') != null) {
          for (const k of ROAM_KEYS) uci.delete('wireless', sid, k);
        }
      }
    });
    uci.commit('wireless');
    S.roam_ver_applied = roam.config_ver ?? S.roam_ver_applied;
    // 整份漫游配置落盘：SAP 的设置页读取本地 uci，只写 ver/enabled 会让
    // 子 AP 显示与主 AP 不一致（SSID 组、FT 模式、k/v 开关等仍是默认值）
    uci.load('wifiroam');
    let dirty = false;
    let wantSsids = roam.ssids ?? [];
    if (!Array.isArray(wantSsids)) wantSsids = wantSsids === '' ? [] : [wantSsids];
    let curSsids = uci.get('wifiroam', 'roam', 'ssids') ?? [];
    if (!Array.isArray(curSsids)) curSsids = curSsids === '' ? [] : [curSsids];
    const want = {
      enabled: roam.enabled ? '1' : '0',
      r_fast: roam.r_fast ? '1' : '0',
      ft_mode: roam.ft_mode === 'explicit' ? 'explicit' : 'simple',
      ft_over_ds: roam.ft_over_ds ? '1' : '0',
      k_neighbor: roam.k_neighbor ? '1' : '0',
      k_beacon: roam.k_beacon ? '1' : '0',
      v_bss_transition: roam.v_bss_transition ? '1' : '0',
      rssi_profile: roam.rssi_profile ?? 'balanced',
      rssi_threshold: String(roam.rssi_threshold ?? rssiPreset(roam.rssi_profile)),
      config_ver: String(S.roam_ver_applied),
    };
    if (curSsids.join('\n') !== wantSsids.join('\n')) {
      uci.set('wifiroam', 'roam', 'ssids', wantSsids);
      dirty = true;
    }
    for (const [k, v] of Object.entries(want)) {
      if ((uci.get('wifiroam', 'roam', k) ?? '') !== v) {
        uci.set('wifiroam', 'roam', k, v);
        dirty = true;
      }
    }
    if (dirty) uci.commit('wifiroam');
    runProcess(...PROC.wifiReload, {
      onExit: (res) => log(`wifi reload rc=${res}`),
    });
    pushEvent('roam_apply', '', `ver=${roam.config_ver ?? 0} ssids=${touched.length}`);
    return { ok: true, touched, ver: S.roam_ver_applied };
  }

  // 本机实际落盘的 K/V/R：随 push_roam_config 回执上报，主AP可显示各 AP 生效状态
  function appliedKvr(ssids) {
    let r = true;
    let k = true;
    let v = true;
    let seen = 0;
    uci.load('wireless');
    uci.foreach('wireless', 'wifi-iface', (s) => {
      if (s.mode && s.mode !== 'ap') return;
      if (s.disabled === '1') return;
      if (s.wifiroam_guest === '1') return;
      if (!(ssids ?? []).includes(s.ssid)) return;
      seen++;
      if (s.ieee80211r !== '1' || (s.mobility_domain ?? '') === '') r = false;
      if (s.ieee80211k !== '1' || (s.rrm_neighbor_report ?? '0') !== '1') k = false;
      if (s.ieee80211v !== '1' || (s.bss_transition ?? '0') !== '1') v = false;
    });
    return { r: seen > 0 && r, k: seen > 0 && k, v: seen > 0 && v, seen };
  }

  // ------------------------------------------------------------- 无线回程
  function wifiRadios() {
    const out = [];
    uci.load('wireless');
    uci.foreach('wireless', 'wifi-device', (s) => {
      out.push({
        name: s['.name'], band: s.band ?? '?',
        disabled: s.disabled === '1',
      });
    });
    return out;
  }

  function pickRadio(prefer) {
    const radios = wifiRadios();
    for (const r of radios) if (!r.disabled && r.name === prefer) return r.name;
    for (const r of radios) if (!r.disabled && r.band === '5g') return r.name;
    for (const r of radios) if (!r.disabled) return r.name;
    return null;
  }

  // ------------------------------------------------------- 回程状态与 sysfs
  // 回程的运行时状态集中放在 S._bh（与 ucode 版 state._bh_* 一一对应），
  // 只在这一处创建，避免散落十几个顶层字段。
  function bhState() {
    if (S._bh == null || typeof S._bh !== 'object') S._bh = {};
    return S._bh;
  }

  function readSys(path) {
    const v = fs.readFile(path);
    return v == null ? '' : String(v).trim();
  }

  function brdev() {
    return S.brdev ?? 'br-lan';
  }

  // ubus 调用：CLI 用退出码表达失败，而 cmdOutput 只给 stdout，
  // 所以自己拼 RC 一并读回来。
  function ubusCall(path, method) {
    const out = cmdOutput(`ubus call ${path} ${method} 2>&1; echo RC=$?`);
    const m = /RC=(\d+)\s*$/.exec(out);
    const rc = m ? Number(m[1]) : 1;
    const body = out.replace(/RC=\d+\s*$/, '').trim();
    if (rc === 0) return { ok: true, error: null, data: null, body };
    let msg = body;
    try {
      const j = JSON.parse(body);
      msg = j?.error ?? body;
    } catch (_e) { /* 原样保留 */ }
    return { ok: false, error: msg === '' ? `rc=${rc}` : msg, data: null, body };
  }

  function ubusJson(path, method) {
    const r = ubusCall(path, method);
    if (!r.ok || r.body === '') return null;
    try {
      return JSON.parse(r.body);
    } catch (_e) {
      return null;
    }
  }

  // 有线口必须真正 forwarding 才算可用：STP 阻塞的环路端口只会在 FDB
  // 里留下主路由 MAC，不能据此判定“有线回程已恢复”。qca-ppe 在端口
  // admin down 之后仍可能报 carrier=1，所以 operstate 也要看。
  function wiredPortForwarding(port) {
    if (!port) return false;
    if (readSys(`/sys/class/net/${port}/carrier`) !== '1') return false;
    const st = readSys(`/sys/class/net/${port}/brport/state`);
    if (st !== '' && st !== '3') return false; // 3 = forwarding
    return readSys(`/sys/class/net/${port}/operstate`) === 'up';
  }

  // 端口物理载波是否仍在：射频重启/桥抖动期间 FDB 会短暂清空，
  // 载波仍在就说明网线没拔，不能据此切换到无线回程。
  function wiredPortCarrier(port) {
    if (!port) return false;
    return readSys(`/sys/class/net/${port}/carrier`) === '1';
  }

  // 上级 AP 的 MAC 若出现在以太网口上，说明当前仍有有线回程。
  // 此时不能把 STA 桥进 br-lan，否则会形成二层环路；只暂存配置待拔线后自动启用。
  function ethernetUplinkPort() {
    const fdb = parseFdb();
    for (const [mn, p] of Object.entries(S.peers ?? {})) {
      const role = p.info?.role ?? p.role;
      if (role !== 'cap') continue;
      const port = fdb[mn];
      if (port && port.indexOf('phy') !== 0 && port.indexOf('wl') !== 0
        && port.indexOf('vap') !== 0 && port.indexOf('br') !== 0
        && wiredPortForwarding(port)) return port;
    }
    return null;
  }

  function backhaulMode(raw) {
    return (raw ?? '') === 'wds' ? 'wds' : BACKHAUL_DEFAULT_MODE;
  }

  function currentBackhaulCfg() {
    uci.load('wifiroam');
    return {
      enabled: uci.get('wifiroam', 'backhaul', 'enabled') === '1',
      ssid: uci.get('wifiroam', 'backhaul', 'ssid') ?? BACKHAUL_DEFAULT_SSID,
      key: uci.get('wifiroam', 'backhaul', 'key') ?? '',
      device: uci.get('wifiroam', 'backhaul', 'device') ?? '',
      mode: backhaulMode(uci.get('wifiroam', 'backhaul', 'mode') ?? ''),
      config_ver: toInt(uci.get('wifiroam', 'backhaul', 'config_ver') ?? '0'),
    };
  }

  // --------------------------------------------------------- 回程接口探测
  // 回程接口在 netifd 中的运行时状态（AP/STA 通用）
  function backhaulIfaceStatus() {
    const ws = ubusJson('network.wireless', 'status') ?? {};
    for (const [rname, r] of Object.entries(ws)) {
      for (const ifc of (r?.interfaces ?? [])) {
        if (ifc?.section !== BACKHAUL_SECTION) continue;
        return { ifname: ifc.ifname ?? null, up: !!ifc.up, radio: rname };
      }
    }
    return null;
  }

  function backhaulUciRadio() {
    uci.load('wireless');
    return uci.get('wireless', BACKHAUL_SECTION, 'device');
  }

  function backhaulStaForwarding(ifname, br) {
    if (!ifname) return false;
    const base = `/sys/class/net/${ifname}`;
    // relay 模式下 STA 是独立接口，不在网桥里：只看链路与运营状态，
    // 真正能否透传由 relayd 决定
    if (currentBackhaulCfg().mode === 'relay') {
      return readSys(`${base}/carrier`) === '1' && readSys(`${base}/operstate`) === 'up';
    }
    if (!br || !fs.access(`/sys/class/net/${br}/brif/${ifname}`)) return false;
    return readSys(`${base}/carrier`) === '1' && readSys(`${base}/brport/state`) === '3';
  }

  // --------------------------------------------------------- relayd 伪桥
  // 伪桥依赖内核的代理 ARP：网桥侧替上行主机应答 ARP，上行侧同时打开
  // IP 转发，才能把帧真正送到对端。
  function backhaulRelaySysctl(br, ifname) {
    const pairs = [
      ['net.ipv4.ip_forward', '1'],
      ['net.ipv4.conf.all.proxy_arp', '1'],
      [`net.ipv4.conf.${br}.proxy_arp`, '1'],
      [`net.ipv4.conf.${ifname}.proxy_arp`, '1'],
      [`net.ipv4.conf.${br}.proxy_arp_pvlan`, '1'],
    ];
    for (const [k, v] of pairs) cmdOutput(`sysctl -q -w ${k}=${v} 2>/dev/null`);
  }

  // 伪桥要放行 STA 侧的入站与双向转发。fw4 的 forward 链里先 jump
  // forward_lan 再 jump handle_reject，追加的规则永远不会命中，必须
  // insert 到链首；规则带 comment 标记，便于 fw4 reload 之后重新补齐。
  function backhaulRelayFwClear() {
    if (!fs.access(NFT_PATH)) return;
    for (const ch of ['forward', 'input']) {
      const out = cmdOutput(`nft -a list chain inet fw4 ${ch} 2>/dev/null`);
      for (const line of out.split('\n')) {
        if (line.indexOf(RELAY_FW_MARK) < 0) continue;
        const h = /handle ([0-9]+)/.exec(line);
        if (h) cmdOutput(`nft delete rule inet fw4 ${ch} handle ${h[1]} 2>/dev/null`);
      }
    }
  }

  function backhaulRelayFwApply(br, ifname) {
    if (!fs.access(NFT_PATH)) return;
    backhaulRelayFwClear();
    const rules = [
      ['forward', `iifname "${br}" oifname "${ifname}"`],
      ['forward', `iifname "${ifname}" oifname "${br}"`],
      ['input', `iifname "${ifname}"`],
    ];
    for (const [ch, expr] of rules) {
      cmdOutput(`nft insert rule inet fw4 ${ch} ${expr} counter accept comment ${RELAY_FW_MARK} 2>/dev/null`);
    }
  }

  function backhaulRelayFwOk() {
    if (!fs.access(NFT_PATH)) return true;
    return cmdOutput('nft list chain inet fw4 forward 2>/dev/null').indexOf(RELAY_FW_MARK) >= 0;
  }

  // 伪桥模式下不能保留本机 LAN DHCP：地址由上游发放，本机 dnsmasq
  // 再用自己的池子发出去会给出错误的网关。
  function backhaulRelayDhcpIgnore() {
    uci.load('dhcp');
    if ((uci.get('dhcp', 'lan', 'ignore') ?? '') === '1') return;
    if (!uci.set('dhcp', 'lan', 'ignore', '1')) {
      log('backhaul relay dhcp set failed');
      return;
    }
    if (!uci.commit('dhcp')) log('backhaul relay dhcp commit failed');
    runProcess(...PROC.dnsmasqReload, { onExit: () => {} });
  }

  // 伪桥里 br-lan 与上行同网段：网关必须有一条走 STA 的 /32 路由，
  // 否则内核按 on-link 把包交给 br-lan，proxy_arp 再替上游应答，
  // 报文被本机吞掉（表现为 "Destination port unreachable"）。
  function backhaulRelayRoute(ifname) {
    if (!ifname) return;
    const out = cmdOutput(`ip route show default dev ${ifname} 2>/dev/null`);
    const gw = /via ([0-9.]+)/.exec(out);
    if (!gw) return;
    const st = bhState();
    st.gw = gw[1];
    cmdOutput(`ip route replace ${gw[1]}/32 dev ${ifname} scope link 2>/dev/null`);
  }

  // relayd 进程是否在跑；pid 失效时清空状态
  function backhaulRelayPid() {
    const st = bhState();
    const pid = st.relay_pid;
    if (pid && fs.access(`/proc/${pid}`)) return pid;
    st.relay_pid = null;
    return null;
  }

  function backhaulRelayStop(reason) {
    const st = bhState();
    const pid = backhaulRelayPid();
    st.relay_pid = null;
    // 伪桥停下后必须撤回代理 ARP，否则网桥会继续替上行主机应答，
    // 本机到这些地址的流量会被自己“吃”掉（表现为 port unreachable）
    const br = brdev();
    const ifn = st.relay_ifname ?? null;
    st.relay_ifname = null;
    for (const k of [br, ifn]) {
      if (!k) continue;
      cmdOutput(`sysctl -q -w net.ipv4.conf.${k}.proxy_arp=0 2>/dev/null`);
      cmdOutput(`sysctl -q -w net.ipv4.conf.${k}.proxy_arp_pvlan=0 2>/dev/null`);
    }
    if (ifn && st.gw) {
      cmdOutput(`ip route del ${st.gw}/32 dev ${ifn} 2>/dev/null`);
      st.gw = null;
    }
    backhaulRelayFwClear();
    if (!pid) return;
    cmdOutput(`kill ${pid} 2>/dev/null`);
    log(`backhaul: relayd stopped${reason ? ` (${reason})` : ''}`);
  }

  // relayd 伪桥：-i 侧暴露 br-lan（Linux 侧负责 ARP/NDP 与 DHCP 转发），
  // -I 侧是无线 STA 上行，辅以 -B 广播转发、-D DHCP 转发
  function backhaulRelayStart(ifname) {
    if (currentBackhaulCfg().mode !== 'relay') return;
    if (backhaulRelayPid()) return;
    if (!fs.access(RELAYD_PATH)) return;
    const br = brdev();
    if (!ifname) return;
    // relayd 区分两侧：-i 是客户端所在网桥（ARP/NDP 与 DHCP 都从这里进来），
    // -I 是上行接口。两侧都传 -I 时 DHCP 转发不生效。
    backhaulRelaySysctl(br, ifname);
    backhaulRelayDhcpIgnore();
    backhaulRelayFwApply(br, ifname);
    backhaulRelayRoute(ifname);
    const out = cmdOutput(
      `setsid ${RELAYD_PATH} -D -B -i ${br} -I ${ifname} >/dev/null 2>&1 </dev/null & echo $!`,
    ).trim();
    if (!/^[0-9]+$/.test(out)) {
      log('backhaul: relayd start failed');
      return;
    }
    const st = bhState();
    st.relay_pid = out;
    st.relay_ifname = ifname;
    st.relay_ts = nowSeconds();
    log(`backhaul: relayd started on ${br} + ${ifname} (pid ${out})`);
  }

  // 需要伪桥时保持 relayd 存活；不需要时确保退出，避免残留进程抢占 DHCP
  function backhaulRelayKeep(ifname, want) {
    const st = bhState();
    if (currentBackhaulCfg().mode !== 'relay') {
      backhaulRelayStop('mode is not relay');
      return;
    }
    if (!want) {
      backhaulRelayStop();
      return;
    }
    const now = nowSeconds();
    if (backhaulRelayPid()) {
      // fw4 reload 会清掉标记规则，周期性补回，否则伪桥流量会被 handle_reject 丢弃
      if (now - (st.fw_ts ?? 0) >= BH_FW_PROBE && !backhaulRelayFwOk()) {
        st.fw_ts = now;
        backhaulRelayFwApply(brdev(), ifname);
      }
      // 网关 /32 也补：STA 起来那一刻默认路由可能还没下发，那一次就白做了
      if (now - (st.route_ts ?? 0) >= BH_FW_PROBE) {
        st.route_ts = now;
        backhaulRelayRoute(ifname);
      }
      return;
    }
    if (now - (st.relay_ts ?? 0) < BH_RELAY_PROBE) return;
    backhaulRelayStart(ifname);
  }

  // ------------------------------------------------------------- DHCP 监督
  // relay 模式下 SAP 自己的地址取自 STA 接口，wds 模式下取自 LAN
  function backhaulDhcpIface() {
    return currentBackhaulCfg().mode === 'relay' ? BACKHAUL_STA_SECTION : 'lan';
  }

  // udhcpc 钩子（etc/udhcpc.user.d/90-wifiroam-dhcp-lease）每拿到一次
  // bound/renew 就追加一行 "<epoch> <逻辑接口> <设备> <地址> <事件>"。
  // JS 版没有 ubus 订阅，用这条文件当租约事件源；只认两分钟内的记录。
  function backhaulFreshLease(ifname, dev, now) {
    const data = fs.readFile(DHCP_LEASE_LOG) ?? '';
    if (data === '') return null;
    const lines = String(data).trimEnd().split('\n');
    for (let i = lines.length - 1, n = 0; i >= 0 && n < 32; i--, n++) {
      const f = lines[i].trim().split(/\s+/);
      if (f.length < 5) continue;
      const ts = toInt(f[0]);
      if (now - ts > 120) break;
      if (f[1] !== ifname || f[2] !== dev) continue;
      return f[3];
    }
    return null;
  }

  function backhaulDhcpTick(ifc, now) {
    const ifname = backhaulDhcpIface();
    const st = ubusJson(`network.interface.${ifname}`, 'status');
    if (!st || !st.proto) return;
    if (st.proto !== 'dhcp' || !st.autostart) {
      bhState().dhcp = null;
      return;
    }
    // dev 是取址设备，br 是伪桥的本地网桥（仅用于代理与日志）
    const br = brdev();
    const dev = st.device ?? st.l3_device ?? br;
    const sta = ifc?.ifname ?? null;
    const forwarding = backhaulStaForwarding(sta, br);
    const addrs = st['ipv4-address'] ?? [];
    let cur = null;
    for (const a of addrs) {
      if (a?.address) { cur = a.address; break; }
    }
    const state = bhState();
    if (!state.dhcp || state.dhcp.dev !== dev || state.dhcp.sta !== sta) {
      state.dhcp = {
        dev, br, sta, addr0: cur, lease: null,
        since: null, active: false, warned: false,
        renew_after: 0, start_after: 0,
      };
    }
    const rec = state.dhcp;
    if (!forwarding) return;
    // 每轮幂等补一次网关 /32：起链时还没有默认路由，只靠事件会漏
    if (currentBackhaulCfg().mode === 'relay') backhaulRelayRoute(sta);
    if (rec.since == null) rec.since = now;

    const confirmed = (addr) => {
      state.dhcp = null;
      if (currentBackhaulCfg().mode === 'relay') backhaulRelayRoute(sta);
      log(`backhaul: ${ifname} DHCP lease confirmed: ${addr}`);
    };

    // 事件可能丢失（钩子未安装、报文被吞）：地址从不存到有、或换成了
    // 别的地址，同样是拿到了新租约。恢复开始时就在的旧地址本身不算。
    if (st.up && cur && cur !== rec.addr0) {
      confirmed(cur);
      return;
    }
    // 同一 IP 也可以是新租约：必须有 bound/renew 事件，且该地址已生效。
    const fresh = backhaulFreshLease(ifname, dev, now);
    if (fresh && st.up) {
      for (const a of addrs) {
        if (a?.address !== fresh) continue;
        confirmed(fresh);
        return;
      }
    }
    // 已在取址时不打断 DHCP；不要用可能重载整个接口的 restart。
    if (st.pending) rec.active = true;
    const renew = !!st.up && !rec.active && now >= (rec.renew_after ?? 0);
    const start = !st.up && !st.pending && st.available && now >= (rec.start_after ?? 0);
    const method = renew ? 'renew' : (start ? 'up' : null);
    if (method) {
      const r = ubusCall(`network.interface.${ifname}`, method);
      if (renew) rec.renew_after = now + (r.ok ? BH_DHCP_RENEW_HOLD : BH_DHCP_RETRY);
      else rec.start_after = now + BH_DHCP_RETRY;
      if (r.ok) rec.active = true;
      log(`backhaul: ${ifname} DHCP ${method}${r.ok ? ' requested' : ` failed: ${r.error}`}`);
    }
    if (!rec.warned && now - rec.since >= BH_DHCP_WARN) {
      rec.warned = true;
      log(`backhaul: no ${ifname} DHCP lease confirmed after wireless failover`);
    }
  }

  // ------------------------------------------------------- STA 生命周期
  function backhaulWpaCli(ifname, cmd) {
    if (!fs.access('/usr/sbin/wpa_cli') && !fs.access('/sbin/wpa_cli')
      && !fs.access('/usr/bin/wpa_cli')) return false;
    const out = cmdOutput(
      `wpa_cli -p /var/run/wpa_supplicant -i ${ifname} ${cmd} >/dev/null 2>&1; echo RC=$?`,
    );
    return out.indexOf('RC=0') >= 0;
  }

  // 该接口当前是否仍由 supplicant 管理：wifi down 之后 netdev 还在、
  // IFF_UP 也可能还挂着，只有 wpa_state 能说明 supplicant 到底有没有在跑
  function backhaulStaSupplicantOk(ifname) {
    if (!ifname) return false;
    if (!backhaulWpaCli(ifname, 'status')) return false;
    return cmdOutput(
      `wpa_cli -p /var/run/wpa_supplicant -i ${ifname} status 2>/dev/null`,
    ).indexOf('wpa_state=') >= 0;
  }

  function backhaulStaIfname(dev) {
    const ifc = backhaulIfaceStatus();
    if (ifc?.ifname) return ifc.ifname;
    let phy = dev ?? backhaulUciRadio() ?? '';
    if (/^radio[0-9]+$/.test(phy)) phy = `phy${phy.slice(5)}`;
    if (!/^phy[0-9]+$/.test(phy)) phy = 'phy0';
    return `${phy}-sta0`;
  }

  // SAP 的 STA 在 relay 模式下独占一个 netifd 接口（不挂 br-lan），
  // 由 relayd 在 br-lan 与 STA 之间代理；wds 模式下才需要把 STA 桥进 LAN。
  function backhaulRelayNetifEnsure(ifname) {
    uci.load('network');
    const sd = uci.get('network', BACKHAUL_STA_SECTION);
    let chg = false;
    if (sd == null || sd['.type'] !== 'interface') {
      if (sd != null) uci.delete('network', BACKHAUL_STA_SECTION);
      uci.set('network', BACKHAUL_STA_SECTION, 'interface');
      chg = true;
    }
    // proto dhcp：STA 接口自己向上游取址。SAP 本机的 DHCP 报文是本机生成
    // 的，不经过 relayd 的嗅探口，所以 LAN 上的 udhcpc 在伪桥里永远等不到 OFFER。
    for (const [k, v] of [['proto', 'dhcp'], ['device', ifname], ['auto', '1']]) {
      if ((uci.get('network', BACKHAUL_STA_SECTION, k) ?? '') !== v) {
        uci.set('network', BACKHAUL_STA_SECTION, k, v);
        chg = true;
      }
    }
    if (chg && !uci.commit('network')) log('backhaul relay netif commit failed');
    return chg;
  }

  function backhaulRelayNetifRemove() {
    uci.load('network');
    if (uci.get('network', BACKHAUL_STA_SECTION) == null) return;
    uci.delete('network', BACKHAUL_STA_SECTION);
    if (!uci.commit('network')) log('backhaul relay netif delete failed');
  }

  function backhaulRelayNetifExists() {
    uci.load('network');
    return uci.get('network', BACKHAUL_STA_SECTION) != null;
  }

  // 回程 STA 暂停：先收掉伪桥，避免 relayd 在断链状态继续代理 DHCP
  function backhaulStaSetDisabled(on) {
    if (on) backhaulRelayStop('STA disabled');
    uci.load('wireless');
    const want = on ? '1' : '0';
    if ((uci.get('wireless', BACKHAUL_SECTION, 'disabled') ?? '0') === want) return;
    uci.set('wireless', BACKHAUL_SECTION, 'disabled', want);
    uci.commit('wireless');
  }

  function backhaulStaRadioUp(tag) {
    const radio = backhaulUciRadio() ?? pickRadio('');
    if (!radio) return;
    log(`backhaul ${tag}: wifi up ${radio}`);
    runProcess('/sbin/wifi', ['up', radio], {
      onExit: (res) => log(`backhaul ${tag} rc=${res}`),
    });
  }

  // 暂停无线 STA：优先 wpa_cli 定向断开，避免整网/整卡 reload
  function backhaulStaPause(reason) {
    const st = bhState();
    const now = nowSeconds();
    if ((st.pause_ts ?? 0) > 0 && now - st.pause_ts < 3) return;
    st.pause_ts = now;
    backhaulStaSetDisabled(true);
    const ifc = backhaulIfaceStatus();
    if (ifc?.ifname && backhaulWpaCli(ifc.ifname, 'disconnect')) {
      log(`backhaul STA paused: ${reason}`);
    } else {
      backhaulStaRadioUp('pause');
    }
    pushEvent('backhaul_link', '', reason);
  }

  // 恢复无线 STA：接口还在就 reconnect，已被 reload 移除时只拉起该射频
  function backhaulStaResume() {
    const st = bhState();
    backhaulStaSetDisabled(false);
    st.pause_ts = 0;
    const ifc = backhaulIfaceStatus();
    const ifname = ifc?.ifname ?? null;
    // wds 模式必须确保 4 地址：3 地址下广播 DHCPDISCOVER 能过去，但单播
    // DHCPOFFER 会被 STA 网卡丢弃，表现就是一直拿不到 IPv4；relay 模式走
    // 普通三段地址、由 relayd 代理，绝不能开 4addr。
    if (ifname && currentBackhaulCfg().mode === 'wds') {
      cmdOutput(`iw dev ${ifname} set 4addr on 2>/dev/null`);
    }
    // STA 仍有关联：不 reconnect 也不整射频 reload，避免拆掉正在工作的回程。
    // 注意 ifc.up 是 netifd 的配置态，接口被 wifi down 之后它仍可能为真，
    // 所以还要看内核里是否真的 IFF_UP，否则 reconnect 只是对着死接口喊话。
    if (ifname && backhaulStaForwarding(ifname, brdev())) {
      log('backhaul STA already forwarding, skip reload');
    } else if (ifname && backhaulStaSupplicantOk(ifname)
      && backhaulWpaCli(ifname, 'reconnect')) {
      log('backhaul STA resumed');
    } else {
      backhaulStaRadioUp('resume');
    }
    pushEvent('backhaul_link', '', 'cable removed, wireless backhaul enabled');
  }

  function backhaulStoreCfg(bh, ver, mode) {
    uci.load('wifiroam');
    uci.set('wifiroam', 'backhaul', 'enabled', bh.enabled ? '1' : '0');
    uci.set('wifiroam', 'backhaul', 'ssid', bh.ssid ?? BACKHAUL_DEFAULT_SSID);
    uci.set('wifiroam', 'backhaul', 'key', bh.key ?? '');
    uci.set('wifiroam', 'backhaul', 'device', bh.device ?? '');
    uci.set('wifiroam', 'backhaul', 'mode', mode ?? backhaulMode(bh.mode ?? ''));
    uci.set('wifiroam', 'backhaul', 'config_ver', String(ver));
    uci.commit('wifiroam');
    S.backhaul_ver_applied = ver;
  }

  // 回程启用期间给 LAN 网桥打开 STP，作为有线/无线同时存在时的兜底。
  // 运行时用 brctl 立即生效，uci 只写一次 stp=1 供重启后保留。
  function backhaulStpEnsure() {
    const st = bhState();
    if (st.stp_done) return;
    st.stp_done = true;
    const br = brdev();
    cmdOutput(`brctl stp ${br} on 2>/dev/null`);
    uci.load('network');
    let hit = false;
    uci.foreach('network', 'device', (s) => {
      if ((s.name ?? '') !== br) return;
      uci.set('network', s['.name'], 'stp', '1');
      hit = true;
    });
    if (!hit) {
      uci.foreach('network', 'interface', (s) => {
        if (hit) return;
        if (s['.name'] === 'lan' && ((s.device ?? '') === br || s.type === 'bridge')) {
          uci.set('network', s['.name'], 'stp', '1');
          hit = true;
        }
      });
    }
    if (hit) uci.commit('network');
  }

  function applyBackhaulLocal(bh, role) {
    uci.load('wireless');
    const exists = uci.get('wireless', BACKHAUL_SECTION) != null;
    // enabled 但 SSID/密钥缺失时不能静默删除现有 STA 并回 ok，
    // 否则上层会显示“已应用”，实际却没有任何无线回程接口
    if (bh.enabled && ((bh.ssid ?? '') === '' || (bh.key ?? '') === '')) {
      return { ok: false, error: 'backhaul_credentials' };
    }
    const ver = bh.config_ver ?? 0;
    // 对端可能还是旧版本、载荷里没有 mode：统一在此归一化
    const bhMode = backhaulMode(bh.mode ?? '');
    const wantMode = role === 'cap' ? 'ap' : 'sta';
    const dev = pickRadio(role === 'cap' ? (bh.device ?? '') : '');
    const curRadio = exists ? (uci.get('wireless', BACKHAUL_SECTION, 'device') ?? null) : null;
    const ifc = backhaulIfaceStatus();
    // 有线在位时首次开启无线回程：只存配置、STA 保持 disabled，
    // 不重启射频，避免打断有线回程上的 AP/终端
    let staDeferred = false;

    const wantNet = role === 'cap' || bhMode === 'wds' ? 'lan' : BACKHAUL_STA_SECTION;
    const wantWds = bhMode === 'wds' ? '1' : '0';

    // 配置内容和运行时接口都没变时只更新版本号，不再 reload：
    // 同一份配置重复下发/重复保存不会再把回程和所有 AP 打断
    const runtimeOk = ifc != null
      || (role === 'sap' && (uci.get('wireless', BACKHAUL_SECTION, 'disabled') ?? '0') === '1');
    if (bh.enabled && dev && exists && runtimeOk) {
      const sd = uci.get('wireless', BACKHAUL_SECTION);
      let same = sd != null && sd['.type'] === 'wifi-iface'
        && uci.get('wireless', BACKHAUL_SECTION, 'mode') === wantMode
        && uci.get('wireless', BACKHAUL_SECTION, 'device') === dev
        && (uci.get('wireless', BACKHAUL_SECTION, 'ssid') ?? '') === (bh.ssid ?? '')
        && (uci.get('wireless', BACKHAUL_SECTION, 'key') ?? '') === (bh.key ?? '')
        // 回程的转发方式（relay 伪桥 / wds 四地址桥接）必须与配置一致，
        // 旧配置缺 network/wds 时必须重建，否则表现就是能关联但拿不到 IP
        && (uci.get('wireless', BACKHAUL_SECTION, 'network') ?? '') === wantNet
        && (uci.get('wireless', BACKHAUL_SECTION, 'wds') ?? '0') === wantWds
        && (uci.get('wireless', BACKHAUL_SECTION, 'encryption') ?? '') === 'psk2+ccmp';
      if (role !== 'cap' && bhMode === 'relay') {
        // 段内配置一致还不够：STA 接口没建出来就永远拿不到地址
        same = same && backhaulRelayNetifExists();
      }
      if (role === 'cap') {
        same = same
          && (uci.get('wireless', BACKHAUL_SECTION, 'hidden') ?? '0') === '1'
          && (uci.get('wireless', BACKHAUL_SECTION, 'disabled') ?? '0') === '0';
      }
      if (same) {
        if (role === 'cap') backhaulStpEnsure();
        backhaulStoreCfg(bh, ver, bhMode);
        log(`backhaul unchanged ver=${ver}, skip reload`);
        return { ok: true, ver, unchanged: true };
      }
    }
    if (!bh.enabled && !exists) {
      backhaulStoreCfg(bh, ver, bhMode);
      log(`backhaul already off ver=${ver}, skip reload`);
      return { ok: true, ver, unchanged: true };
    }

    if (bh.enabled) {
      if (!dev) return { ok: false, error: 'no_radio' };
      // CAP 侧强制重建回程 AP：旧接口可能因 netifd/NSS 未真正创建或未挂进
      // br-lan，只改选项再 reload 不会重新建接口
      if (role === 'cap' && exists) uci.delete('wireless', BACKHAUL_SECTION);
      // 命名段必须先声明 uci 类型为 wifi-iface，否则 wifi reload 会忽略
      // 这段，STA/AP 都不会真正创建
      const sd = uci.get('wireless', BACKHAUL_SECTION);
      if (sd == null || sd['.type'] !== 'wifi-iface') {
        if (sd != null) uci.delete('wireless', BACKHAUL_SECTION);
        uci.set('wireless', BACKHAUL_SECTION, 'wifi-iface');
      }
      uci.set('wireless', BACKHAUL_SECTION, 'device', dev);
      uci.set('wireless', BACKHAUL_SECTION, 'mode', wantMode);
      uci.set('wireless', BACKHAUL_SECTION, 'ssid', bh.ssid);
      uci.set('wireless', BACKHAUL_SECTION, 'encryption', 'psk2+ccmp');
      uci.set('wireless', BACKHAUL_SECTION, 'key', bh.key);
      // relay：SAP 的 STA 独占 wifiroam_sta 接口、由 relayd 代理，AP 保持
      // 普通三段地址；wds：两边都走四地址桥接
      if (bhMode === 'wds') {
        uci.set('wireless', BACKHAUL_SECTION, 'network', 'lan');
        uci.set('wireless', BACKHAUL_SECTION, 'wds', '1');
      } else {
        uci.set('wireless', BACKHAUL_SECTION, 'wds', '0');
        uci.set('wireless', BACKHAUL_SECTION, 'network',
          role === 'cap' ? 'lan' : BACKHAUL_STA_SECTION);
      }
      if (role === 'cap') {
        uci.set('wireless', BACKHAUL_SECTION, 'hidden', '1');
        uci.set('wireless', BACKHAUL_SECTION, 'disabled', '0');
      } else {
        uci.delete('wireless', BACKHAUL_SECTION, 'hidden');
        const upPort = ethernetUplinkPort();
        staDeferred = upPort != null;
        // 首次下发后主路由会重启射频，可能让有线口瞬断 1-3 秒；这里先记住
        // 有线状态，tick 里用载波兜底，避免误判拔线
        if (staDeferred) {
          const st = bhState();
          st.was_wired = true;
          st.wired_port = upPort;
          st.wired_seen = nowSeconds();
          st.wired_since = nowSeconds();
          st.wireless_since = null;
        }
        uci.set('wireless', BACKHAUL_SECTION, 'disabled', staDeferred ? '1' : '0');
      }
    } else if (exists) {
      uci.delete('wireless', BACKHAUL_SECTION);
    }
    if (!uci.commit('wireless')) log('backhaul wireless commit failed');
    if (uci.get('wireless', BACKHAUL_SECTION) == null) {
      log('backhaul wireless section missing after commit');
    }

    // relay 模式要有配套的 STA 接口；切回 wds/关闭时要清理，避免残留一个
    // 永远没有设备的 netifd 接口
    let netChg = false;
    if (bh.enabled && role !== 'cap' && bhMode === 'relay') {
      netChg = backhaulRelayNetifEnsure(backhaulStaIfname(dev));
    } else if (bhMode !== 'relay' || role === 'cap' || !bh.enabled) {
      netChg = backhaulRelayNetifExists();
      if (netChg) backhaulRelayNetifRemove();
    }
    if (netChg) {
      // 新接口必须让 netifd 重新读配置才会建出来；wds 模式下 STA 挂在 lan
      // 上，由下面的无线重启一起生效
      const ubusBin = fs.access('/bin/ubus') ? '/bin/ubus'
        : (fs.access('/sbin/ubus') ? '/sbin/ubus' : null);
      if (ubusBin) {
        runProcess(ubusBin, ['call', 'network', 'reload'], {
          onExit: (res) => log(`backhaul network reload rc=${res}`),
        });
      }
    }

    backhaulStoreCfg(bh, ver, bhMode);
    if (role === 'cap' && bh.enabled) backhaulStpEnsure();

    // 优先只重启回程所在射频；只有找不到射频时才回退整机 reload。
    // 有线在位时 STA 保持 disabled、配置无需立刻生效：完全跳过重启
    if (staDeferred) {
      log('backhaul STA deferred: wired uplink present, config stored only');
    } else {
      const reloadRadios = [];
      for (const r of [dev, curRadio]) {
        if (r && !reloadRadios.includes(r)) reloadRadios.push(r);
      }
      if (reloadRadios.length) {
        for (const radioName of reloadRadios) {
          runProcess('/sbin/wifi', ['up', radioName], {
            onExit: (res) => log(`backhaul wifi up ${radioName} rc=${res}`),
          });
        }
      } else {
        runProcess(...PROC.wifiReload, {
          onExit: (res) => log(`backhaul wifi reload rc=${res}`),
        });
      }
      // 8s 后检查 netifd 是否真的建出接口，定位“配置存在但 br-lan 里没有
      // 回程接口”的情况
      const t = setTimeout(() => {
        const hit = backhaulIfaceStatus();
        if (hit == null) {
          log('backhaul iface missing from wireless status');
        } else {
          uci.load('wireless');
          const mode = uci.get('wireless', BACKHAUL_SECTION, 'mode') ?? '?';
          log(`backhaul iface: ifname=${hit.ifname ?? '?'} up=${hit.up ? '1' : '0'} mode=${mode}`);
        }
      }, 8000);
      if (typeof t.unref === 'function') t.unref();
    }
    pushEvent('backhaul_apply', '', `ver=${ver} ${bh.enabled ? 'wireless' : 'off'}`);
    return { ok: true, ver };
  }

  // ------------------------------------------------------- CAP 侧对账
  // 回程 STA 的 netdev MAC：用于不依赖主路由 MAC 的环路检测
  function backhaulStaMac() {
    const ifc = backhaulIfaceStatus();
    if (!ifc?.ifname) return '';
    return macnorm(readSys(`/sys/class/net/${ifc.ifname}/address`));
  }

  // STA 自己的 MAC 若出现在有线端口的 FDB 上，说明有线/无线已形成环路
  function backhaulLoopPort() {
    const mac = backhaulStaMac();
    if (mac.length !== 12) return null;
    const port = (parseFdb() ?? {})[mac];
    if (port && port.indexOf('phy') !== 0 && port.indexOf('wl') !== 0
      && port.indexOf('vap') !== 0 && port.indexOf('br') !== 0
      && wiredPortForwarding(port)) return port;
    return null;
  }

  // CAP 侧的 wifiroam_bh AP 可能被旧版本的“保存无线设置”覆盖成主人网络的
  // SSID/密码，或配置被手工改过；与 wifiroam.backhaul 不一致时自动重建，
  // 否则 SAP 会一直 4-way handshake 失败（WRONG_KEY）。
  function backhaulCapReconcile() {
    const bh = currentBackhaulCfg();
    if (!bh.enabled) return;
    uci.load('wireless');
    const sd = uci.get('wireless', BACKHAUL_SECTION);
    const ifc = backhaulIfaceStatus();
    const wantWds = bh.mode === 'wds' ? '1' : '0';
    const ok = sd != null && sd['.type'] === 'wifi-iface' && ifc != null
      && (uci.get('wireless', BACKHAUL_SECTION, 'mode') ?? '') === 'ap'
      && (uci.get('wireless', BACKHAUL_SECTION, 'ssid') ?? '') === (bh.ssid ?? '')
      && (uci.get('wireless', BACKHAUL_SECTION, 'key') ?? '') === (bh.key ?? '')
      && (uci.get('wireless', BACKHAUL_SECTION, 'network') ?? '') === 'lan'
      && (uci.get('wireless', BACKHAUL_SECTION, 'wds') ?? '0') === wantWds
      && (uci.get('wireless', BACKHAUL_SECTION, 'encryption') ?? '') === 'psk2+ccmp'
      && (uci.get('wireless', BACKHAUL_SECTION, 'hidden') ?? '0') === '1'
      && (uci.get('wireless', BACKHAUL_SECTION, 'disabled') ?? '0') === '0';
    // hostapd 可以接受 STA 关联，但 AP 没挂进 br-lan 时 DHCP/ARP 都进不了
    // 主路由 LAN；旧版 network 选项缺失就会留下这种“能连上、拿不到 IP”的状态
    if (ifc?.ifname && !fs.access(`/sys/class/net/${brdev()}/brif/${ifc.ifname}`)) {
      log(`backhaul AP ${ifc.ifname} missing from ${brdev()}, adding`);
      cmdOutput(`brctl addif ${brdev()} ${ifc.ifname} 2>&1`);
    }
    // 这台固件的 NSS 数据面会在该 vif 上烂掉：站能关联，但 EAPOL 再也上不
    // 来（内核成对打印 `interface ... refused: 26` 与 `peer ...: delete
    // failed: -71, record kept`），只有整机重启能清。两种表现都要抓：
    // 关联后一直不授权，或者反复关联又被 hostapd 本地踢掉。这里只喊。
    if (ifc?.ifname) {
      const st = bhState();
      const now = nowSeconds();
      const dump = cmdOutput(`iw dev ${ifc.ifname} station dump 2>/dev/null`);
      let stas = 0;
      let authed = 0;
      for (const line of dump.split('\n')) {
        if (line.indexOf('Station ') === 0) stas++;
        else if (line.indexOf('authorized: yes') >= 0) authed++;
      }
      if (stas > 0 && authed > 0) st.wedge_since = null;
      else if (stas > 0 && st.wedge_since == null) st.wedge_since = now;
      let stuck = stas > 0 && authed === 0 && now - (st.wedge_since ?? now) >= BH_WEDGE_CONFIRM;
      // 踢掉之后的空表只能靠日志判：一分钟最多查一次
      if (!stuck && stas === 0 && now - (st.wedge_probe ?? 0) >= BH_WEDGE_PROBE) {
        st.wedge_probe = now;
        const n = cmdOutput(
          `logread -l 200 2>/dev/null | grep -c '${ifc.ifname}: STA.*local deauth request'`,
        ).trim();
        stuck = toInt(n || '0') >= 3;
      }
      if (stuck && now - (st.wedge_ts ?? 0) >= BH_WEDGE_LOG) {
        st.wedge_ts = now;
        log(`backhaul AP ${ifc.ifname} wedged: station(s) associate but never authorize — reboot the router to clear the NSS peer table`);
      }
    }
    if (ok) return;
    const st = bhState();
    if (nowSeconds() - (st.rebuild_ts ?? 0) < 60) return;
    st.rebuild_ts = nowSeconds();
    log('backhaul AP config drift, re-applying on CAP');
    applyBackhaulLocal(bh, 'cap');
  }

  // ------------------------------------------------------------- 回程 tick
  // SAP 侧：有线/无线回程互斥。网线在位时 STA 保持 disabled，拔线后自动
  // 启用；重新插回网线则暂停 STA，避免二层环路。CAP 侧只做配置对账。
  function backhaulTick() {
    if (S.cfg?.role === 'cap') {
      backhaulCapReconcile();
      return;
    }
    if (S.cfg?.role !== 'sap') return;
    const st = bhState();
    const bh = currentBackhaulCfg();
    if (!bh.enabled) {
      backhaulRelayStop('backhaul disabled');
      st.wired_since = null;
      st.wireless_since = null;
      st.loop_since = null;
      st.was_wired = false;
      st.dhcp = null;
      return;
    }
    if ((bh.ssid ?? '') === '' || (bh.key ?? '') === '') return;
    uci.load('wireless');
    const sd = uci.get('wireless', BACKHAUL_SECTION);
    const wtype = sd != null ? sd['.type'] : null;
    const wmode = uci.get('wireless', BACKHAUL_SECTION, 'mode');
    const wssid = uci.get('wireless', BACKHAUL_SECTION, 'ssid') ?? '';
    const wkey = uci.get('wireless', BACKHAUL_SECTION, 'key') ?? '';
    // 回程转发方式也必须与配置一致：r131 及更早的配置是 network=lan +
    // wds=1，relay 模式下这种旧段无法透传，必须重建才能完成迁移
    const wantNet = bh.mode === 'wds' ? 'lan' : BACKHAUL_STA_SECTION;
    const wnet = uci.get('wireless', BACKHAUL_SECTION, 'network') ?? '';
    const wwds = uci.get('wireless', BACKHAUL_SECTION, 'wds') ?? '0';
    // 回程已启用但 STA 段丢失/被改坏时自动重建，否则拔掉网线后没有可启用
    // 的无线回程接口，表现就是一直不走无线
    if (sd == null || wtype !== 'wifi-iface' || wmode !== 'sta'
      || wssid !== bh.ssid || wkey !== bh.key
      || wnet !== wantNet || wwds !== (bh.mode === 'wds' ? '1' : '0')) {
      // 重建会重载无线，最多 60s 一次，避免配置异常时每 10s 打断 Wi-Fi
      if (nowSeconds() - (st.rebuild_ts ?? 0) < 60) return;
      st.rebuild_ts = nowSeconds();
      log(`backhaul STA stale: sec=${sd == null ? 'null' : 'set'} type=${wtype ?? 'null'} mode=${wmode ?? 'null'} ssid=${wssid}/${bh.ssid} keylen=${wkey.length}/${(bh.key ?? '').length} net=${wnet}/${wantNet} ver=${bh.config_ver ?? 0}`);
      applyBackhaulLocal(bh, 'sap');
      return;
    }
    backhaulStpEnsure();

    const now = nowSeconds();
    const ifc = backhaulIfaceStatus();
    const disabled = (uci.get('wireless', BACKHAUL_SECTION, 'disabled') ?? '0') === '1';

    // 环路：STA 自己的 MAC 出现在有线口，连续确认后再暂停，避免单次 FDB
    // 抖动把回程误停。relay 模式下 STA 不在桥里，它的 MAC 本来就是桥的
    // 本地表项（brctl 会挂在 port 1），这条判据只剩误报，有线在场与否交给
    // 下面的 CAP-MAC 判定。
    if (!disabled && currentBackhaulCfg().mode !== 'relay') {
      const lp = backhaulLoopPort();
      if (lp != null) {
        if (st.loop_since == null) st.loop_since = now;
        if (now - st.loop_since >= BH_LOOP_CONFIRM) {
          st.loop_since = null;
          log(`backhaul loop detected on ${lp}, pausing wireless STA`);
          // 环路说明有线已经通到对端：按有线记账，并清掉无线计时，否则
          // 下一轮 !wired 会拿着旧时间戳立刻恢复 STA，来回打摆
          st.was_wired = true;
          st.wireless_since = null;
          st.dhcp = null;
          backhaulStaPause('loop detected, wireless STA paused');
          return;
        }
      } else {
        st.loop_since = null;
      }
    } else {
      st.loop_since = null;
    }

    // 有线/无线路径防抖：持续稳定一段时间后才切换回程方式
    const upPort = ethernetUplinkPort();
    let wired = upPort != null;
    if (wired) {
      st.wired_seen = now;
      st.wired_port = upPort;
    }
    // 射频重启/桥抖动会短暂清空 FDB，甚至让有线口瞬断 1-3 秒：原端口载波
    // 仍在且在保护期内就维持有线判定，避免误触发启用 STA
    if (!wired && st.wired_port && now - (st.wired_seen ?? 0) <= BH_WIRED_HOLD
      && wiredPortCarrier(st.wired_port)) {
      wired = true;
    }
    if (wired) {
      st.was_wired = true;
      st.dhcp = null;
      if (st.wired_since == null) st.wired_since = now;
      st.wireless_since = null;
    } else {
      if (st.was_wired) {
        st.was_wired = false;
        st.dhcp = {};
        log('backhaul: wired uplink lost, waiting for STA forwarding before LAN DHCP check');
      }
      if (st.wireless_since == null) st.wireless_since = now;
      st.wired_since = null;
    }

    if (!disabled && wired && now - (st.wired_since ?? now) >= BH_WIRED_DEBOUNCE) {
      backhaulStaPause('wired uplink detected, wireless STA paused');
      return;
    }
    if (disabled && !wired
      && now - (st.wireless_since ?? now) >= BH_WIRELESS_DEBOUNCE
      && now - (st.pause_ts ?? 0) >= BH_WIRELESS_DEBOUNCE) {
      backhaulStaResume();
      return;
    }

    // 有线判定靠 FDB 里的 CAP MAC，CAP 链路断了就永远是“无线”，而
    // disabled 可能还是 0：此时既不走 pause 也不走 resume，STA 会一直瘫着。
    // 已启用却迟迟不转发就重新拉起，兜住这个死点。
    const staNow = ifc?.ifname ?? null;
    const fwdNow = !disabled && backhaulStaForwarding(staNow, brdev());
    if (!disabled && !wired && !fwdNow) {
      if (st.sta_idle_since == null) st.sta_idle_since = now;
      if (now - st.sta_idle_since >= BH_STA_REARM) {
        st.sta_idle_since = null;
        log('backhaul: STA enabled but not forwarding, re-arming');
        backhaulStaResume();
        return;
      }
    } else {
      st.sta_idle_since = null;
    }

    // relay 伪桥必须在 DHCP 之前就位：它才是把 DHCP/ARP 送过无线的那一层
    const sta = ifc?.ifname ?? null;
    const fwd = !disabled && !wired && sta != null && backhaulStaForwarding(sta, brdev());
    backhaulRelayKeep(sta, fwd);

    if (st.dhcp && !wired && !disabled) backhaulDhcpTick(ifc, now);

    // 无线回程应启用但运行时接口被 reload 移除：只拉起对应射频重建 STA
    if (!disabled && !wired && ifc == null
      && now - (st.sta_rebuild_ts ?? 0) >= BH_STA_REBUILD_INTERVAL) {
      st.sta_rebuild_ts = now;
      backhaulStaRadioUp('sta rebuild');
    }
  }

  // --------------------------------------------------------------- 预检查
  function ssidGroups() {
    const groups = {};
    const selfMn = macnorm(S.self?.mac);
    for (const w of wifiIfaces()) {
      const g = groups[w.ssid] ?? (groups[w.ssid] = { ssid: w.ssid, aps: {}, encs: {}, bands: {} });
      g.aps[selfMn] = true;
      g.encs[selfMn] = w.encryption;
      g.bands[w.band] = true;
    }
    for (const [mn, p] of Object.entries(S.peers ?? {})) {
      for (const w of p.info?.wifi ?? []) {
        const g = groups[w.ssid] ?? (groups[w.ssid] = { ssid: w.ssid, aps: {}, encs: {}, bands: {} });
        g.aps[mn] = true;
        g.encs[mn] = w.encryption;
        g.bands[w.band] = true;
      }
    }
    const out = [];
    for (const [ssid, g] of Object.entries(groups)) {
      const encset = {};
      for (const e of Object.values(g.encs)) encset[e] = true;
      const encList = Object.keys(encset);
      let encOk = true;
      for (const e of encList) if (e.indexOf('psk') < 0 && e.indexOf('sae') < 0) encOk = false;
      out.push({
        ssid, ap_count: Object.keys(g.aps).length,
        bands: Object.keys(g.bands), encryptions: encList,
        consistent: encList.length === 1,
        enc_ok: encOk,
      });
    }
    return out;
  }

  // 全网络 AP 概览：CAP 汇总后下发给 SAP，子 AP 的“开启前检查”与主 AP 保持一致
  function apOverview() {
    const selfMn = macnorm(S.self?.mac);
    const aps = [{
      id: selfMn, name: S.self?.name, role: S.cfg?.role,
      ip: S.self?.ip, online: true, self: true,
      ssids: wifiIfaces().map((w) => w.ssid),
      // 本机实际落盘的 K/V/R，便于主 AP 与子 AP 看到一致的生效状态
      kvr: appliedKvr(currentRoamCfg().ssids),
    }];
    for (const [mn, p] of Object.entries(S.peers ?? {})) {
      const list = [];
      for (const w of p.info?.wifi ?? []) if (!list.includes(w.ssid)) list.push(w.ssid);
      aps.push({
        id: mn, name: p.info?.name ?? p.name ?? maccolon(mn),
        role: p.info?.role ?? p.role ?? 'sap',
        ip: p.info?.ip ?? p.ip, online: !!p.authed, self: false,
        ssids: list,
        kvr: p.kvr ?? null,
      });
    }
    return { groups: ssidGroups(), aps };
  }

  function precheck() {
    const checks = [];
    // apk (24.10+) / opkg (legacy) 双栈检测
    let wp = '';
    if (fs.access('/usr/bin/apk') || fs.access('/sbin/apk')) {
      wp = cmdOutput(shellCommands.wpadApk()).trim();
    }
    if (wp === '') wp = cmdOutput(shellCommands.wpadOpkg()).trim();
    checks.push({
      id: 'wpad', ok: wp !== '' && wp.indexOf('basic') < 0,
      info: wp !== '' ? wp : 'none',
    });
    // SAP 用 CAP 下发的全网络概览，避免子 AP 只看到本机接口导致计数/状态不一致
    const overview = (S.cfg?.role === 'sap' && S.roster?.aps) ? S.roster : apOverview();
    const groups = overview.groups;
    let nMulti = 0;
    for (const g of groups) if (g.ap_count >= 2) nMulti++;
    checks.push({ id: 'ssid_group', ok: nMulti > 0, info: String(nMulti) });
    for (const g of groups) {
      checks.push({ id: 'enc_consistent', ok: g.consistent, info: `${g.ssid}: ${g.encryptions.join(',')}` });
      checks.push({ id: 'enc_allowed', ok: g.enc_ok, info: `${g.ssid}: ${g.encryptions.join(',')}` });
    }
    checks.push({ id: 'role', ok: S.cfg?.role === 'cap', info: S.cfg?.role });
    // 成员 AP 概览：让“开启前检查”能直接看出子路由上报的 SSID/频段是否正确，
    // 而不是只显示一个汇总计数
    // self 标记必须按本机 MAC 重新计算：CAP 下发的 roster 里 "self" 指 CAP 自己
    const selfMn = macnorm(S.self?.mac);
    const aps = [];
    for (const a of overview.aps) {
      aps.push({
        id: a.id, name: a.name, role: a.role, ip: a.ip,
        online: a.online, self: a.id === selfMn, ssids: a.ssids,
        kvr: a.kvr ?? null,
      });
    }
    return { checks, groups, role: S.cfg?.role, aps };
  }

  // ------------------------------------------------------- 11k 邻居与引导
  function steerBssList() {
    return (async () => {
      const out = [];
      const seen = {};
      for (const e of await apNrSelf()) {
        out.push(e);
        seen[`${String(e.bssid).toLowerCase()}|${e.ssid}`] = true;
      }
      const others = [];
      for (const p of Object.values(S.peers ?? {})) {
        for (const e of p.info?.nr ?? []) others.push(e);
      }
      for (const e of S.cap_nr ?? []) others.push(e);
      for (const e of others) {
        if (e?.bssid == null || e?.nr == null) continue;
        const k = `${String(e.bssid).toLowerCase()}|${e.ssid ?? ''}`;
        if (seen[k]) continue;
        seen[k] = true;
        out.push({
          bssid: String(e.bssid).toLowerCase(), ssid: e.ssid ?? '',
          nr: e.nr, band: e.band, channel: e.channel,
        });
      }
      return out;
    })();
  }

  // 全拓扑视角的 BSS 列表（去掉本机网卡名）。CAP 用它在 report_status
  // 回执里下发候选：SAP 之间没有直连通道，只能经 CAP 交换，否则各自
  // 只认识 CAP，邻居库里缺少另一台 SAP，终端也就看不到那台更近的 AP。
  async function bssPublic() {
    const out = [];
    for (const e of await steerBssList()) {
      out.push({
        bssid: e.bssid, ssid: e.ssid, nr: e.nr,
        band: e.band, channel: e.channel,
      });
    }
    return out;
  }

  // 把其它 AP 的同 SSID BSS 写进本机 hostapd 的 11k 邻居库。终端主动发
  // BSS Transition Query 询问候选时，hostapd 才有内容可答；邻居库为空时
  // 手机只能自己扫描，华为/荣耀等机型往往干脆不动。
  async function neighborSync(bsses) {
    let sig = '';
    for (const e of bsses) sig += `${e.ssid}|${e.bssid};`;
    if (sig === S.nr_sig) return;
    S.nr_sig = sig;
    for (const e of bsses) {
      if (!e.ifname) continue; // 只有本机接口能调用
      const list = [];
      for (const o of bsses) {
        if (o.ssid !== e.ssid) continue;
        if (String(o.bssid).toLowerCase() === String(e.bssid).toLowerCase()) continue;
        if (o.nr == null || o.nr === '') continue;
        list.push([o.bssid, o.ssid, o.nr]);
      }
      if (!list.length) continue;
      try {
        await busCall(`hostapd.${e.ifname}`, 'rrm_nr_set', { list });
      } catch (_err) {
        log(`nr_set ${e.ifname} failed`);
      }
    }
  }

  // 信号低于阈值时，通过 hostapd 的 BSS Transition Management 主动引导
  // 终端切换到更合适的 AP。CAP/SAP 各自对自己下挂的终端执行，避免跨节点转发。
  // 关键点：BTM 请求必须带候选列表（neighbors）。没有候选时多数手机
  // （华为/荣耀/部分 IoT）会直接忽略请求，表现为“信号很差也不切换”。
  async function steerTick() {
    if (S.cfg?.role === 'unconfigured') return;
    const roam = currentRoamCfg();
    if (!roam.enabled || !roam.v_bss_transition) return;
    const threshold = roam.rssi_threshold;
    if (threshold == null || threshold >= 0) return;
    if (!roam.ssids.length) return;
    let hasPeer = false;
    for (const p of Object.values(S.peers ?? {})) {
      if (p.authed) { hasPeer = true; break; }
    }
    if (!hasPeer) return; // 单 AP 无处分流，引导只会让终端掉线
    const selfNr = await apNrSelf();
    const bsses = await steerBssList();
    if (roam.k_neighbor) await neighborSync(bsses);
    const now = nowSeconds();
    const clients = await localClients();
    for (const [mn, c] of Object.entries(clients ?? {})) {
      if (c.type !== 'wifi' || !c.ifname) continue;
      // 固定 AP 的终端完全退出自动引导：钉在本 AP 时信号再差也不迁走
      if (pinOf(mn)) { delete S.steer_tries[mn]; continue; }
      if (c.ssid == null || !roam.ssids.includes(c.ssid)) continue;
      const rssi0 = c.rssi;
      if (rssi0 == null) continue;
      const rssi = toInt(rssi0);
      if (rssi >= threshold) { delete S.steer_tries[mn]; continue; }
      // 刚入网（含刚被引导成功）时先观察，同时清零失败计数
      if (c.connected_time != null && toInt(c.connected_time) < MIN_STEER_ASSOC) {
        delete S.steer_tries[mn];
        continue;
      }
      // 候选：同 SSID 的其它 BSS（排除终端当前所在的 BSS）
      let curBssid = null;
      for (const e of selfNr) if (e.ifname === c.ifname) curBssid = String(e.bssid).toLowerCase();
      const candNr = [];
      let cand = 0;
      for (const e of bsses) {
        if (e.ssid !== c.ssid) continue;
        if (curBssid != null && String(e.bssid).toLowerCase() === curBssid) continue;
        if (e.nr == null || e.nr === '') continue;
        candNr.push(e.nr);
        cand++;
      }
      if (!cand) { delete S.steer_tries[mn]; continue; }
      if (now - (S.steer_last[mn] ?? 0) < STEER_COOLDOWN) continue;
      const tries = S.steer_tries[mn] ?? 0;
      if (tries >= STEER_KICK_AFTER) {
        // 刚被踢过又回到原 AP，说明附近没有更强的 AP，别再反复踢
        if ((S.steer_mute[mn] ?? 0) > now) continue;
        try {
          await busCallThrow(`hostapd.${c.ifname}`, 'del_client', {
            addr: maccolon(mn), deauth: true, reason: 1, ban_time: 0,
          });
          S.kick_last[mn] = now;
          S.steer_mute[mn] = now + STEER_KICK_COOLDOWN;
          S.steer_tries[mn] = 0;
          S.steer_last[mn] = now;
          pushEvent('roam_kick', maccolon(mn),
            `rssi=${rssi} < ${threshold}`, clientNameOf(mn, clients));
        } catch (_e) {
          log(`kick ${mn} failed`);
        }
        continue;
      }
      try {
        await busCallThrow(`hostapd.${c.ifname}`, 'bss_transition_request', {
          addr: maccolon(mn),
          disassociation_imminent: true,
          disassociation_timer: 10,
          validity_period: 30,
          abridged: false,
          neighbors: candNr,
        });
        S.steer_last[mn] = now;
        S.steer_tries[mn] = tries + 1;
        pushEvent('roam_steer', maccolon(mn),
          `rssi=${rssi} < ${threshold} cand=${cand}`, clientNameOf(mn, clients));
      } catch (_e) {
        log(`steer ${mn} failed`);
      }
    }
  }

  // 固定 AP 的本机执行：连到非目标 AP 的终端直接断开并禁入一段时间
  // （pin 关系经 ctx.pinOf 读 clients 的实现）。
  async function pinTick() {
    if (S.cfg?.role === 'unconfigured') return;
    const pin = S.aliases?.pin;
    if (!pin || !Object.keys(pin).length) return;
    const selfMn = macnorm(S.self?.mac);
    const now = nowSeconds();
    const clients = await localClients();
    for (const [mn, c] of Object.entries(clients ?? {})) {
      if (c.type !== 'wifi' || !c.ifname) continue;
      const ap = pinOf(mn);
      if (!ap || ap === selfMn) continue;
      if (now - (S.pin_last?.[mn] ?? 0) < PIN_KICK_COOLDOWN) continue;
      try {
        await busCallThrow(`hostapd.${c.ifname}`, 'del_client', {
          addr: maccolon(mn), deauth: true, reason: 1,
          ban_time: PIN_BAN_MS,
        });
        S.pin_last[mn] = now;
        pushEvent('pin_kick', maccolon(mn),
          `${apDisplay(selfMn)} → ${apDisplay(ap)}`, clientNameOf(mn, clients));
      } catch (_e) {
        log(`pin kick ${mn} failed`);
      }
    }
  }

  // ------------------------------------------------- 首次启用默认漫游
  // 插件启用后按默认设置开启漫游：首次启动（从未保存过漫游配置）时，
  // 自动选中本机全部主网络 SSID，并按默认 k/v/r 参数下发一次。
  function roamDefaultInit() {
    uci.load('wifiroam');
    if (toInt(uci.get('wifiroam', 'roam', 'config_ver') ?? '0') !== 0) return;
    if (uci.get('wifiroam', 'roam', 'enabled') !== '1') return;
    const raw = uci.get('wifiroam', 'roam', 'ssids');
    if (Array.isArray(raw) ? raw.length > 0 : (raw ?? '') !== '') return;
    const ssids = [];
    for (const w of wifiIfaces()) {
      if (w.ssid !== '' && !ssids.includes(w.ssid)) ssids.push(w.ssid);
    }
    if (!ssids.length) return;
    uci.set('wifiroam', 'roam', 'ssids', ssids);
    uci.set('wifiroam', 'roam', 'config_ver', '1');
    uci.commit('wifiroam');
    const roam = currentRoamCfg();
    applyRoamLocal(roam, memberList());
    S.last_apply = {
      ts: nowSeconds(), ver: roam.config_ver,
      results: [{
        ap: S.self?.mac, name: S.self?.name,
        ok: true, ver: roam.config_ver,
        kvr: appliedKvr(roam.ssids),
      }],
    };
    log(`roam defaults enabled for ${ssids.length} SSID(s)`);
  }

  return {
    // 常量
    STEER_COOLDOWN, MIN_STEER_ASSOC, STEER_KICK_AFTER, STEER_KICK_COOLDOWN,
    PIN_BAN_MS, PIN_KICK_COOLDOWN, BACKHAUL_SECTION, BACKHAUL_DEFAULT_SSID,
    ROAM_KEYS,
    // 自检 / 探测
    lanBroadcast, localIfaceMacs, detectSelf, wirelessUplink, detectUplink,
    detectUplinkAsync, selfUptime, selfInfo, apNrSelf, apNrPublic,
    // Wi-Fi 前台
    wifiIfaces, wifiSummary, applyWifiLocal, roamRenameSsids,
    // 漫游
    rssiPreset, currentRoamCfg, roamSig, roamMd, roamKey0, roamKey1,
    memberList, applyRoamLocal, appliedKvr, roamDefaultInit,
    // 回程
    wifiRadios, pickRadio, ethernetUplinkPort, wiredPortForwarding,
    wiredPortCarrier, backhaulMode, currentBackhaulCfg, backhaulIfaceStatus,
    backhaulStaForwarding, applyBackhaulLocal, backhaulTick, backhaulDhcpTick,
    backhaulRelayStart, backhaulRelayStop, backhaulRelayKeep, backhaulRelayPid,
    backhaulRelayRoute, backhaulRelayFwApply, backhaulRelayFwOk, backhaulStpEnsure,
    BACKHAUL_DEFAULT_MODE, BACKHAUL_STA_SECTION, RELAYD_PATH, RELAY_FW_MARK,
    DHCP_LEASE_LOG, BH_DHCP_RENEW_HOLD, BH_DHCP_WARN, BH_DHCP_RETRY,
    BH_STA_REARM, BH_WIRELESS_DEBOUNCE, BH_WIRED_DEBOUNCE, BH_FW_PROBE,
    // 预检查
    ssidGroups, apOverview, precheck,
    // 邻居与引导
    steerBssList, bssPublic, neighborSync, steerTick,
    // 固定 AP（本机执行；pin 读/写实现在 clients，本模块只调 ctx.pinOf）
    pinTick,
  };
}
