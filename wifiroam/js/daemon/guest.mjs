// guest.mjs -- 访客网络模块（wifiroam 守护进程 JS 重写，spec §8 模块 5）。
//
// 对应原版 wifiroamd.uc 第 1625-2185 行：
//   hhmm_minutes / now_minutes（lib/util.js 已有，此处不重写，只用）、
//   guest_cfg / guest_open_now / guest_summary / mask_prefix / ipv4_cidr
//   （mask_prefix / ipv4_cidr 在 lib/util.js，只用不重写）、
//   guest_lan_info（含局部 pick，lib/util.js 的 pick）、guest_netdevs、
//   guest_write_wireless / guest_remove_infra / guest_write_infra、
//   guest_nft_apply / guest_client_ips / guest_tc_cleanup / guest_tc_apply、
//   guest_port_sync / guest_after_reload / apply_guest_local /
//   guest_save_local / guest_tick。
//
// 访客网络：每台 AP 各自建一个独立子网 + DHCP + 防火墙隔离区，
// 访客口统一挂到 br-guest（接口名 netifd 限制为 15 字符以内）。
// （原版第 40-41 行中文注释，原样保留。）
//
// 约定（与其它 5 个模块统一）：
//   * 只 export 一个工厂 createGuest(ctx)，ctx = { S, bus, uci, shell, util, store }。
//     S 只用 spec §1.2 写明的字段：cfg.role、self.ip、brdev、events、last_guest、
//     guest_open、guest_tc_sig、guest_tc_devs、_guest_nft_sig、_guest_zone_migrated。
//     bus / store 本模块不用（访客不直接调 ubus、不读写 JSON 文件）。
//   * 需要调其它模块函数时只经 ctx 注入的回调：pushEvent（core 的 push_event，
//     guest_tick 发 "guest_schedule" 事件用）、setTimeout（guest_port_sync 的
//     1000ms 重试定时器）、readLeases（guest_client_ips 读 /tmp/dhcp.leases）。
//     未注入时分别用等价的本地回落（见 createGuest 内注释）。
//   * UCI / shell 调用走 lib/uci.js 与 lib/shell.js；命令字面值、参数、
//     2>/dev/null 静默语义按 spec §7 原样保留，不转义、不改 argv（spec §9.23）。
//   * 只用 Node 核心模块（node:fs 读租约文件），零 npm 依赖；
//     不用 research §1.5 禁用清单里的任何 API。
//   * 含糊项按 spec §9 原样抄，不发明，见文件末尾的 NOTES。

import { readFileSync } from 'node:fs';
import { uci as defaultUci } from '../lib/uci.js';
import {
  cmdOutput as libCmdOutput,
  runProcess as libRunProcess,
  shellCommands as libShellCommands,
  PROC as libPROC,
} from '../lib/shell.js';
import * as utilLib from '../lib/util.js';

// ------------------------------------------------------------------ 常量
// 原版第 42-54 行（GUEST_SECTION 等），逐字照抄。
export const GUEST_SECTION = 'guest';
export const GUEST_IFACE = 'wifiroam_guest';
export const GUEST_DEV = 'wifiroam_guest_dev';
export const GUEST_BRIDGE = 'br-guest';
export const GUEST_ZONE = 'wifiroam_guest_zone';
export const GUEST_FWD_WAN = 'wifiroam_guest_fwd_wan';
export const GUEST_FWD_LAN = 'wifiroam_guest_fwd_lan';
export const GUEST_SNAT = 'wifiroam_guest_snat';
export const GUEST_IP = '172.16.10.1';
export const GUEST_NET = '172.16.10.0/24';
export const GUEST_DEFAULT_SSID = 'Guest';
export const GUEST_SEC_PREFIX = 'wifiroam_guest_';
export const GUEST_NFT_TABLE = 'wifiroam_guest';

const DHCP_LEASES_PATH = '/tmp/dhcp.leases';
const GUEST_PORT_SYNC_MAX_TRIES = 10; // 原版 guest_port_sync：tries < 10 才重试
const GUEST_PORT_SYNC_DELAY_MS = 1000;

export function createGuest(ctx = {}) {
  const S = ctx.S ?? {};
  // S 的访客字段初值按 spec §1.2（core 持有的 state 单例定义）补齐；
  // core 正常传入时这些字段本就存在，这里只防未初始化的 S。
  if (S.guest_open === undefined) S.guest_open = null;
  if (S.guest_tc_sig === undefined) S.guest_tc_sig = '';
  if (!Array.isArray(S.guest_tc_devs)) S.guest_tc_devs = [];
  if (S._guest_nft_sig === undefined) S._guest_nft_sig = '';
  if (S._guest_zone_migrated === undefined) S._guest_zone_migrated = false;

  const uci = ctx.uci ?? defaultUci;
  // util：ctx 传入的覆盖 lib 默认值（测试可只覆盖 nowMinutes/log）。
  const util = { ...utilLib, ...(ctx.util ?? {}) };
  const log = typeof util.log === 'function' ? util.log : utilLib.log;

  // shell：ctx.shell 可以是 lib/shell 模块命名空间、{ cmdOutput, runProcess }
  // 对象，或直接就是 cmdOutput 函数；未注入时用 lib 的真实实现。
  const shellObj = ctx.shell ?? null;
  const cmdOutput =
    (shellObj && typeof shellObj.cmdOutput === 'function' && shellObj.cmdOutput) ||
    (typeof shellObj === 'function' ? shellObj : libCmdOutput);
  const runProcess =
    (shellObj && typeof shellObj.runProcess === 'function' && shellObj.runProcess) ||
    libRunProcess;
  const shellCommands = (shellObj && shellObj.shellCommands) || libShellCommands;
  const PROC = (shellObj && shellObj.PROC) || libPROC;

  const timerFn =
    typeof ctx.setTimeout === 'function'
      ? ctx.setTimeout
      : typeof ctx.timer === 'function'
        ? ctx.timer
        : setTimeout;

  // pushEvent：core 的 push_event（type, mac, info, name）。
  // 未注入时按原版 push_event（第 413-421 行）等价回落：往 S.events 环形缓冲
  // 追加 {ts,type,mac,name,info}（上限 100）并 log。
  const pushEvent =
    typeof ctx.pushEvent === 'function'
      ? ctx.pushEvent
      : typeof ctx.push_event === 'function'
        ? ctx.push_event
        : (type, mac, info, name) => {
            if (!Array.isArray(S.events)) S.events = [];
            S.events.push({
              ts: util.nowSeconds(),
              type,
              mac: mac ?? '',
              name: name ?? '',
              info: info ?? '',
            });
            if (S.events.length > 100) S.events = S.events.slice(S.events.length - 100);
            log(`event ${type} ${mac ?? '-'} ${name ?? '-'} ${info ?? ''}`);
          };

  // 读 /tmp/dhcp.leases：原版 guest_client_ips 用 fs.readfile 直接读（非 shell）。
  // 失败回 ""（原版 `?? ""`）。
  const readLeases =
    typeof ctx.readLeases === 'function'
      ? ctx.readLeases
      : () => {
          try {
            return readFileSync(DHCP_LEASES_PATH, 'utf8');
          } catch (_e) {
            return '';
          }
        };

  const role = () => S.cfg?.role ?? '';

  // fire-and-forget 的异步进程：原版 uloop.process 不等结果；lib 的
  // runProcess 永不 reject，但防注入的 mock 返回非 Promise 时同样不抛。
  function spawnProcess(proc, opts) {
    let p;
    try {
      p = runProcess(proc[0], proc[1], opts);
    } catch (_e) {
      return;
    }
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }

  // ---------------------------------------------------------- guest_cfg
  // 原版第 1638-1654 行逐字照抄。ver 即 UCI guest.config_ver（spec §9.5：
  // 对应关系未在规格中逐字确认，此处以原文为准，不另作推断）。
  function guestCfg() {
    uci.load('wifiroam');
    return {
      enabled: uci.get('wifiroam', GUEST_SECTION, 'enabled') == '1',
      ssid: uci.get('wifiroam', GUEST_SECTION, 'ssid') ?? GUEST_DEFAULT_SSID,
      key: uci.get('wifiroam', GUEST_SECTION, 'key') ?? '',
      bandwidth: util.toInt(uci.get('wifiroam', GUEST_SECTION, 'bandwidth') ?? '0'),
      schedule: uci.get('wifiroam', GUEST_SECTION, 'schedule') == '1',
      start: uci.get('wifiroam', GUEST_SECTION, 'start') ?? '08:00',
      end: uci.get('wifiroam', GUEST_SECTION, 'end') ?? '23:00',
      allow_lan: uci.get('wifiroam', GUEST_SECTION, 'allow_lan') == '1',
      ver: util.toInt(uci.get('wifiroam', GUEST_SECTION, 'config_ver') ?? '0'),
    };
  }

  // ------------------------------------------------------- guest_open_now
  // 开放时段判断：start <= end 为当天区间，否则视为跨零点（如 22:00-07:00）
  // （原版第 1655-1664 行注释与逻辑，原样保留。）
  // nowMin 为测试注入的“当前分钟数”；不传时按原版经 date +%H:%M 取值
  // （lib/util.js 的 nowMinutes，无参即跑 `date +%H:%M`）。
  function guestOpenNow(cfg, nowMin) {
    if (!cfg.enabled) return false;
    if (!cfg.schedule) return true;
    const a = util.hhmmMinutes(cfg.start);
    const b = util.hhmmMinutes(cfg.end);
    if (a == null || b == null) return true;
    const t = typeof nowMin === 'number' ? nowMin : util.nowMinutes();
    if (a <= b) return t >= a && t < b;
    return t >= a || t < b;
  }

  // -------------------------------------------------------- guest_summary
  // 原版第 1665-1686 行。返回访客摘要：配置 + open + 本机访客口状态。
  function guestSummary() {
    const g = guestCfg();
    uci.load('wireless');
    const ifaces = [];
    const open = guestOpenNow(g);
    uci.foreach('wireless', 'wifi-iface', (s) => {
      if (s.wifiroam_guest != '1') return;
      ifaces.push({
        section: s['.name'],
        device: s.device,
        band: uci.get('wireless', s.device, 'band') ?? '?',
        disabled: s.disabled == '1',
      });
    });
    return {
      role: role(),
      enabled: g.enabled,
      ssid: g.ssid,
      has_key: g.key != '',
      bandwidth: g.bandwidth,
      schedule: g.schedule,
      start: g.start,
      end: g.end,
      allow_lan: g.allow_lan,
      open,
      ifaces,
      last: S.last_guest ?? null,
    };
  }

  // ------------------------------------------------------- guest_lan_info
  // 原版第 1721-1741 行。lan 的 ipaddr 可能是 list（本机即 list ipaddr），
  // get() 会返回数组。
  // 注意 get_first 的第二参数是 section 类型（interface）而不是段名，
  // 这里统一用 get + 数组取首值最稳妥
  // （原版注释原样保留；pick 即 lib/util.js 的 pick，不重写。）
  function guestLanInfo() {
    uci.load('network');
    const ip = util.pick(uci.get('network', 'lan', 'ipaddr')) ?? '192.168.0.1';
    const nm = util.pick(uci.get('network', 'lan', 'netmask')) ?? '255.255.255.0';
    const gw = util.pick(uci.get('network', 'lan', 'gateway'));
    return {
      cidr: util.ipv4Cidr(ip, nm),
      ip: String(ip).split('/')[0],
      gw: gw != null ? String(gw).split('/')[0] : S.self?.ip,
    };
  }

  // --------------------------------------------------------- guest_netdevs
  // 已配置的访客 BSS 内核接口名（如 phy0-ap1）。netdev 名不固定，必须按
  // SSID 反查，不能假定是 ap1。（原版第 1743-1755 行。）
  function guestNetdevs(ssid) {
    const out = [];
    let cur = null;
    const data = cmdOutput(shellCommands.iwDev());
    for (const line of String(data).split('\n')) {
      const mi = /^\s*Interface ([^\s]+)/.exec(line);
      if (mi) {
        cur = mi[1];
        continue;
      }
      if (cur == null) continue;
      const ms = /^\s*ssid (.+)$/.exec(line);
      if (ms && ms[1].trim() == ssid) out.push(cur);
    }
    return out;
  }

  // --------------------------------------------------- guest_write_wireless
  // 把访客 SSID/密码/开关写入本机 wireless；时段外保持 disabled
  // （原版第 1757-1794 行。）
  function guestWriteWireless(cfg) {
    const open = guestOpenNow(cfg);
    uci.load('wireless');
    const keep = {};
    const radios = [];
    uci.foreach('wireless', 'wifi-device', (d) => {
      radios.push(d['.name']);
    });
    for (const rname of radios) {
      const sid = GUEST_SEC_PREFIX + rname;
      keep[sid] = true;
      if (uci.get('wireless', sid) == null) uci.set('wireless', sid, 'wifi-iface');
      uci.set('wireless', sid, 'device', rname);
      uci.set('wireless', sid, 'mode', 'ap');
      uci.set('wireless', sid, 'ssid', cfg.ssid != '' ? cfg.ssid : GUEST_DEFAULT_SSID);
      if (cfg.key != '') {
        uci.set('wireless', sid, 'encryption', 'psk2');
        uci.set('wireless', sid, 'key', cfg.key);
      } else {
        uci.set('wireless', sid, 'encryption', 'none');
        uci.delete('wireless', sid, 'key');
      }
      uci.set('wireless', sid, 'network', GUEST_IFACE);
      uci.set('wireless', sid, 'wifiroam_guest', '1');
      uci.set('wireless', sid, 'disabled', cfg.enabled && open ? '0' : '1');
    }
    const stale = [];
    uci.foreach('wireless', 'wifi-iface', (s) => {
      if (s.wifiroam_guest != '1') return;
      if (!keep[s['.name']]) stale.push(s['.name']);
    });
    for (const sid of stale) uci.delete('wireless', sid);
    uci.commit('wireless');
    return open;
  }

  // ----------------------------------------------------- guest_remove_infra
  // 关闭访客网络时删除残留的桥/接口/DHCP/防火墙段（nft 与 tc 由 after_reload 清理）
  // （原版第 1796-1820 行。）
  function guestRemoveInfra() {
    uci.load('network');
    uci.delete('network', GUEST_IFACE);
    uci.delete('network', GUEST_DEV);
    uci.commit('network');

    uci.load('dhcp');
    uci.delete('dhcp', GUEST_IFACE);
    uci.commit('dhcp');

    uci.load('firewall');
    uci.foreach('firewall', 'zone', (z) => {
      if (z.name == 'guest' && z.network == GUEST_IFACE) uci.delete('firewall', z['.name']);
    });
    uci.delete('firewall', GUEST_ZONE);
    for (const r of [
      'wifiroam_guest_dhcp',
      'wifiroam_guest_dns_u',
      'wifiroam_guest_dns_t',
      GUEST_FWD_WAN,
      GUEST_FWD_LAN,
      GUEST_SNAT,
    ]) {
      uci.delete('firewall', r);
    }
    uci.commit('firewall');
  }

  // ------------------------------------------------------ guest_write_infra
  // 访客桥 / 接口 / DHCP / 防火墙。桥本身固定 br-guest，端口由 guest_port_sync 填。
  // （原版第 1822-1927 行。）
  function guestWriteInfra(cfg) {
    uci.load('network');
    if (uci.get('network', GUEST_DEV) == null) uci.set('network', GUEST_DEV, 'device');
    uci.set('network', GUEST_DEV, 'type', 'bridge');
    uci.set('network', GUEST_DEV, 'name', GUEST_BRIDGE);
    if (uci.get('network', GUEST_IFACE) == null) uci.set('network', GUEST_IFACE, 'interface');
    uci.set('network', GUEST_IFACE, 'proto', 'static');
    uci.set('network', GUEST_IFACE, 'device', GUEST_BRIDGE);
    uci.set('network', GUEST_IFACE, 'ipaddr', GUEST_IP);
    uci.set('network', GUEST_IFACE, 'netmask', '255.255.255.0');
    uci.commit('network');

    uci.load('dhcp');
    if (uci.get('dhcp', GUEST_IFACE) == null) uci.set('dhcp', GUEST_IFACE, 'dhcp');
    uci.set('dhcp', GUEST_IFACE, 'interface', GUEST_IFACE);
    uci.set('dhcp', GUEST_IFACE, 'start', '10');
    uci.set('dhcp', GUEST_IFACE, 'limit', '100');
    uci.set('dhcp', GUEST_IFACE, 'leasetime', '12h');
    /* 本机 dnsmasq 的 dhcpv4/dhcpv6 默认值是 disabled，不显式置 server 就不出 dhcp-range。
       访客只有 IPv4，DHCPv6/RA 全部关闭。force 跳过 br-guest 上的 udhcpc 探测。 */
    uci.set('dhcp', GUEST_IFACE, 'dhcpv4', 'server');
    uci.set('dhcp', GUEST_IFACE, 'dhcpv6', 'disabled');
    uci.set('dhcp', GUEST_IFACE, 'force', '1');
    uci.commit('dhcp');

    uci.load('firewall');
    let zsec = null;
    uci.foreach('firewall', 'zone', (z) => {
      if (z.name == 'guest' && zsec == null) zsec = z['.name'];
    });
    if (zsec == null) {
      zsec = GUEST_ZONE;
      uci.set('firewall', zsec, 'zone');
    }
    uci.set('firewall', zsec, 'name', 'guest');
    /* 访客区只用 device 定义，不能写 network / subnet：
       1) 写 network 时 fw4 会把访客物理设备（br-guest / phy*-ap1）自动加进
          flowtable，流量被（硬件）卸载后绕过 qdisc，限速失效；
       2) 写 subnet 时 fw4 会给 input 链加 "ip saddr 172.16.10.0/24" 条件，
          DHCPDISCOVER 的源地址是 0.0.0.0，匹配不上就进不了 input_guest，
          DHCP 放行规则不生效，访客拿不到 IP。
       只写 device 时 related_physdevs / related_subnets 都为空，不会进
       flowtable、也不带 saddr；NAT 由 srcnat_wan 的全局 masq 处理。 */
    uci.delete('firewall', zsec, 'network');
    uci.delete('firewall', zsec, 'subnet');
    uci.set('firewall', zsec, 'device', GUEST_BRIDGE);
    uci.set('firewall', zsec, 'input', 'REJECT');
    uci.set('firewall', zsec, 'output', 'ACCEPT');
    uci.set('firewall', zsec, 'forward', 'REJECT');

    // input 默认 REJECT，只放行访客自己需要的 DHCP 与 DNS
    const rules = [
      { sec: 'wifiroam_guest_dhcp', proto: 'udp', port: '67' },
      { sec: 'wifiroam_guest_dns_u', proto: 'udp', port: '53' },
      { sec: 'wifiroam_guest_dns_t', proto: 'tcp', port: '53' },
    ];
    for (const r of rules) {
      if (uci.get('firewall', r.sec) == null) uci.set('firewall', r.sec, 'rule');
      uci.set('firewall', r.sec, 'name', r.sec);
      uci.set('firewall', r.sec, 'src', 'guest');
      uci.set('firewall', r.sec, 'proto', r.proto);
      uci.set('firewall', r.sec, 'dest_port', r.port);
      uci.set('firewall', r.sec, 'target', 'ACCEPT');
      uci.set('firewall', r.sec, 'family', 'ipv4');
      uci.set('firewall', r.sec, 'enabled', '1');
    }

    const isSap = role() == 'sap';
    /* 主AP 走 wan 出口；子AP 是二层桥接 AP，没有自己的 wan，改由
       guest→lan 转发 + SNAT。不用的 forwarding 直接删除，避免 fw4 每次
       reload 报「section is disabled」 */
    if (!isSap) {
      if (uci.get('firewall', GUEST_FWD_WAN) == null) uci.set('firewall', GUEST_FWD_WAN, 'forwarding');
      uci.set('firewall', GUEST_FWD_WAN, 'src', 'guest');
      uci.set('firewall', GUEST_FWD_WAN, 'dest', 'wan');
      uci.set('firewall', GUEST_FWD_WAN, 'enabled', '1');
    } else {
      uci.delete('firewall', GUEST_FWD_WAN);
    }

    if (isSap || cfg.allow_lan) {
      if (uci.get('firewall', GUEST_FWD_LAN) == null) uci.set('firewall', GUEST_FWD_LAN, 'forwarding');
      uci.set('firewall', GUEST_FWD_LAN, 'src', 'guest');
      uci.set('firewall', GUEST_FWD_LAN, 'dest', 'lan');
      uci.set('firewall', GUEST_FWD_LAN, 'enabled', '1');
    } else {
      uci.delete('firewall', GUEST_FWD_LAN);
    }

    // 子AP 的“外网”其实走 lan 桥到主AP，必须放行 guest→lan 并做 SNAT，
    // 否则主AP 没有访客子网的回程路由。
    // 不能用 uci 的 nat 段：fw4 按出接口归 zone，src=guest 的规则只会出现在
    // "oifname br-guest" 的 srcnat_guest 链里，反而会把去访客的下行包 SNAT 掉。
    // SNAT 改由 guest_nft_apply 写在自建表（oifname 为 lan 侧）。
    uci.delete('firewall', GUEST_SNAT);
    uci.commit('firewall');
  }

  // -------------------------------------------------------- guest_nft_apply
  // 独立 nft 表做访客→内网的兜底拦截（fw4 的 accept 规则之前生效）。
  // 允许访客访问内网资源时整表删除。
  // 注意：本机 nft 的 -f 文件模式不能解析 table/chain 声明，必须先建表与链。
  // （原版第 1928-1958 行。）
  function guestNftApply(cfg) {
    const info = guestLanInfo();
    const snatIp = info.ip != '' ? info.ip : S.self?.ip;
    const sig =
      (cfg.enabled ? '1' : '0') +
      '|' +
      (cfg.allow_lan ? '1' : '0') +
      '|' +
      (role() ?? '') +
      '|' +
      snatIp +
      '|' +
      info.cidr;
    if (sig == S._guest_nft_sig) return;
    S._guest_nft_sig = sig;

    cmdOutput(`nft delete table inet ${GUEST_NFT_TABLE} 2>/dev/null`);
    if (!cfg.enabled) return;
    cmdOutput(`nft add table inet ${GUEST_NFT_TABLE} 2>/dev/null`);

    /* 子AP 没有独立 wan：访客流量经 br-lan 送主AP，必须在本机 SNAT 成 lan
       地址，主AP 才能把回包按访客子网送回。fw4 的 nat 段按出接口归 zone，
       覆盖不到这个方向，所以放在自建表里做。 */
    if (role() == 'sap' && snatIp != '') {
      cmdOutput(
        `nft add chain inet ${GUEST_NFT_TABLE} nat '{ type nat hook postrouting priority srcnat; policy accept; }' 2>/dev/null`,
      );
      cmdOutput(
        `nft add rule inet ${GUEST_NFT_TABLE} nat ip saddr ${GUEST_NET} oifname ${S.brdev} snat ip to ${snatIp} 2>/dev/null`,
      );
    }

    if (cfg.allow_lan) return;
    /* 链名不能用 fwd：nft 把 fwd 当保留字，会报 unexpected fwd */
    cmdOutput(
      `nft add chain inet ${GUEST_NFT_TABLE} guard '{ type filter hook forward priority -20; policy accept; }' 2>/dev/null`,
    );
    cmdOutput(
      `nft add rule inet ${GUEST_NFT_TABLE} guard iifname ${GUEST_BRIDGE} ip daddr ${info.cidr} drop 2>/dev/null`,
    );
  }

  // ------------------------------------------------------- guest_client_ips
  // 原版第 1960-1982 行：先读 /tmp/dhcp.leases，再补 `ip neigh show dev br-guest`
  // 的邻居 IP；只取 172.16.10.0/24 前缀、排除 GUEST_IP 本身，去重。
  // （spec §7.3 把本函数列为 `ip neigh show dev br-guest` 的调用点；租约文件
  // 是 fs.readfile 直读，见上文 readLeases。）
  function guestClientIps() {
    const out = [];
    const seen = {};
    const netBase = GUEST_NET.split('/')[0];
    const netPrefix =
      netBase.slice(0, netBase.length - netBase.split('.')[3].length - 1) + '.';
    const data = readLeases() ?? '';
    for (const line of String(data).split('\n')) {
      const f = line.trim().split(/\s+/);
      if (f.length < 4) continue;
      const ip = f[2];
      if (ip.indexOf(netPrefix) != 0 || ip == GUEST_IP || seen[ip]) continue;
      seen[ip] = true;
      out.push(ip);
    }
    const neigh = cmdOutput(shellCommands.ipNeighDev(GUEST_BRIDGE));
    for (const line of String(neigh).split('\n')) {
      const m = /^([0-9.]+)\s/.exec(line);
      if (!m) continue;
      const ip = m[1];
      if (ip.indexOf(netPrefix) != 0 || ip == GUEST_IP || seen[ip]) continue;
      seen[ip] = true;
      out.push(ip);
    }
    return out;
  }

  // ------------------------------------------------------- guest_tc_cleanup
  // 清理已不需要 qdisc 的访客 netdev；桥上的旧 qdisc 一并删除（历史版本挂在桥上）
  // （原版第 1984-1994 行。）
  function guestTcCleanup(keep) {
    for (const d of S.guest_tc_devs) {
      if (keep != null && keep.indexOf(d) >= 0) continue;
      cmdOutput(shellCommands.tcQdiscDel(d));
    }
    cmdOutput(shellCommands.tcQdiscDel(GUEST_BRIDGE));
    S.guest_tc_devs = keep ?? [];
  }

  // ---------------------------------------------------------- guest_tc_apply
  // 每台访客设备下行限速：qdisc 必须挂在具体的访客 netdev 上。
  // 挂在 br-guest 上的方案实测无效——桥转发（br_dev_xmit）发出的报文不经过
  // 桥设备自身的根 qdisc，桥端口才是真正的出队点，所以限制完全不生效。
  // （原版第 1996-2044 行。带宽单位与 classid 分配见 spec §9.17：按原文抄，
  // rate 一律为 bandwidth*1000 kbit，classid 从 1:21 起按 IP 顺序递增，
  // 默认类 1:20 同样按限速值；不另作单位推断。）
  function guestTcApply(cfg) {
    const bw = cfg.bandwidth ?? 0;
    const ports = cfg.enabled && bw > 0 ? guestNetdevs(cfg.ssid) : [];

    if (ports.length == 0) {
      // 关闭/时段外/无线还没起来：清掉旧规则，等下一轮再建
      if (
        S.guest_tc_devs.length > 0 ||
        cmdOutput(shellCommands.tcQdiscShow(GUEST_BRIDGE)).indexOf('htb') >= 0
      ) {
        S.guest_tc_sig = '';
        guestTcCleanup([]);
      }
      return;
    }

    const ips = guestClientIps();
    let sig = '' + bw;
    for (const p of ports) sig += '|d' + p;
    for (const ip of ips) sig += '|' + ip;

    let have = true;
    for (const p of ports) {
      if (cmdOutput(shellCommands.tcQdiscShow(p)).indexOf('htb') < 0) {
        have = false;
        break;
      }
    }
    if (sig == S.guest_tc_sig && have) return;
    S.guest_tc_sig = sig;
    guestTcCleanup(ports);

    for (const p of ports) {
      cmdOutput(shellCommands.tcQdiscAddHtb(p));
      // 默认类同样按限速值：拿不到终端 IP（静态 IP、租约未落盘、刚入网）时
      // 流量会落到这里，若仍给 2Gbit 就等于完全不限
      cmdOutput(shellCommands.tcClassAdd(p, '1:20', bw * 1000));
      let i = 20;
      for (const ip of ips) {
        i++;
        const cid = '1:' + i;
        cmdOutput(shellCommands.tcClassAdd(p, cid, bw * 1000));
        cmdOutput(shellCommands.tcFilterAdd(p, ip, cid));
      }
    }
  }

  // --------------------------------------------------------- guest_port_sync
  // 无线重启后 netdev 才会出现，先按 SSID 找到接口再挂到 br-guest
  // （原版第 2045-2074 行。前向声明的赋值式函数，见 spec §9.16：
  //  tries < 10 才重试，超限后不再等、直接按无端口写桥并调 cb。）
  function guestPortSync(cfg, cb, tries) {
    tries = tries ?? 0;
    const open = guestOpenNow(cfg);
    if (!cfg.enabled) {
      uci.load('network');
      uci.delete('network', GUEST_DEV);
      uci.commit('network');
      if (cb) cb();
      return;
    }
    const ports = cfg.enabled && open ? guestNetdevs(cfg.ssid) : [];
    if (ports.length == 0 && cfg.enabled && open && tries < GUEST_PORT_SYNC_MAX_TRIES) {
      timerFn(() => {
        guestPortSync(cfg, cb, tries + 1);
      }, GUEST_PORT_SYNC_DELAY_MS);
      return;
    }
    uci.load('network');
    if (uci.get('network', GUEST_DEV) == null) uci.set('network', GUEST_DEV, 'device');
    uci.set('network', GUEST_DEV, 'type', 'bridge');
    uci.set('network', GUEST_DEV, 'name', GUEST_BRIDGE);
    if (ports.length > 0) uci.set('network', GUEST_DEV, 'ports', ports);
    else uci.delete('network', GUEST_DEV, 'ports');
    uci.commit('network');
    if (cb) cb();
  }

  // ------------------------------------------------------ guest_after_reload
  // 原版第 2075-2084 行：dnsmasq reload 与 firewall reload 各自异步发出
  // （原版两个 uloop.process 并列调用，非串行）；firewall 完成后才做
  // guest_nft_apply + guest_tc_apply（并先清 guest_tc_sig 强制重建）。
  function guestAfterReload(cfg) {
    spawnProcess(PROC.dnsmasqReload, { onExit: () => {} });
    spawnProcess(PROC.firewallReload, {
      onExit: () => {
        guestNftApply(cfg);
        S.guest_tc_sig = '';
        guestTcApply(cfg);
      },
    });
  }

  // ------------------------------------------------------- apply_guest_local
  // 本机落地：写 wireless / network / dhcp / firewall，再异步重启无线并补齐桥端口
  // （原版第 2086-2105 行。network reload 与 wifi reload 并列发出；
  // wifi 回调里 log "guest wifi reload rc=<res>"，再 guest_port_sync，
  // 其回调里再 network reload，完成后 guest_after_reload。）
  function applyGuestLocal(cfg) {
    S.guest_open = guestOpenNow(cfg);
    guestWriteWireless(cfg);
    if (cfg.enabled) guestWriteInfra(cfg);
    else guestRemoveInfra();

    spawnProcess(PROC.networkReload, { onExit: () => {} });
    spawnProcess(PROC.wifiReload, {
      onExit: (res) => {
        log('guest wifi reload rc=' + res);
        guestPortSync(cfg, () => {
          spawnProcess(PROC.networkReload, {
            onExit: () => {
              guestAfterReload(cfg);
            },
          });
        }, 0);
      },
    });
    return { ok: true };
  }

  // -------------------------------------------------------- guest_save_local
  // 校验并写入本机 wifiroam.guest（主AP/子AP 都走这里）
  // （原版第 2107-2134 行。注意：g.ver 原样写回 config_ver，不 +1；
  // +1 是 set_guest（api 侧）组装 cfg 时做的事，不在本函数内。）
  function guestSaveLocal(g) {
    const enabled = g.enabled ? true : false;
    const ssid = String(g.ssid ?? '').trim();
    const key = g.open ? '' : (g.key ?? '');
    const start = String(g.start ?? '08:00').trim();
    const end = String(g.end ?? '23:00').trim();
    if (enabled && (ssid.length < 1 || ssid.length > 32)) return false;
    if (key != '' && (key.length < 8 || key.length > 64)) return false;
    if (util.hhmmMinutes(start) == null || util.hhmmMinutes(end) == null) return false;

    uci.load('wifiroam');
    if (uci.get('wifiroam', GUEST_SECTION) == null) uci.set('wifiroam', GUEST_SECTION, 'guest');
    uci.set('wifiroam', GUEST_SECTION, 'enabled', enabled ? '1' : '0');
    uci.set('wifiroam', GUEST_SECTION, 'ssid', ssid != '' ? ssid : GUEST_DEFAULT_SSID);
    uci.set('wifiroam', GUEST_SECTION, 'key', key);
    uci.set('wifiroam', GUEST_SECTION, 'bandwidth', '' + util.toInt(g.bandwidth ?? 0));
    uci.set('wifiroam', GUEST_SECTION, 'schedule', g.schedule ? '1' : '0');
    uci.set('wifiroam', GUEST_SECTION, 'start', start);
    uci.set('wifiroam', GUEST_SECTION, 'end', end);
    uci.set('wifiroam', GUEST_SECTION, 'allow_lan', g.allow_lan ? '1' : '0');
    uci.set('wifiroam', GUEST_SECTION, 'config_ver', '' + util.toInt(g.ver ?? 0));
    uci.commit('wifiroam');
    return true;
  }

  // ------------------------------------------------------------- guest_tick
  // 定时检查开放时段；只在跨过边界时重启无线。限速规则每轮同步一次
  // （原版第 2136-2184 行。）
  function guestTick() {
    if (role() == 'unconfigured') return;
    const g = guestCfg();
    if (!g.enabled) {
      S.guest_open = false;
      S.guest_tc_sig = '';
      guestNftApply(g);
      return;
    }
    /* 旧版本访客区用 option network / subnet 定义（会让 vif 进 flowtable、
       并给 DHCP 加上 saddr 限制），子AP 还留着无效的 uci nat 段；
       进程升级后做一次性迁移 */
    if (S._guest_zone_migrated != true) {
      uci.load('firewall');
      S._guest_zone_migrated = true;
      if (
        uci.get('firewall', GUEST_ZONE, 'network') != null ||
        uci.get('firewall', GUEST_ZONE, 'subnet') != null ||
        (role() == 'sap' && uci.get('firewall', GUEST_SNAT) != null)
      ) {
        guestWriteInfra(g);
        cmdOutput(shellCommands.guestFirewallReload());
        S._guest_nft_sig = '';
      }
    }
    /* 进程重启后内核里的 nft 表可能丢失（设备重启），按需补建/清理 */
    guestNftApply(g);
    const open = guestOpenNow(g);
    if (S.guest_open == null) {
      S.guest_open = open;
      return;
    }
    if (open == S.guest_open) {
      guestTcApply(g);
      return;
    }
    S.guest_open = open;

    uci.load('wireless');
    uci.foreach('wireless', 'wifi-iface', (s) => {
      if (s.wifiroam_guest != '1') return;
      uci.set('wireless', s['.name'], 'disabled', open ? '0' : '1');
    });
    uci.commit('wireless');
    pushEvent('guest_schedule', '', open ? 'open' : 'closed');
    spawnProcess(PROC.wifiReload, {
      onExit: () => {
        guestPortSync(g, () => {
          spawnProcess(PROC.networkReload, {
            onExit: () => {
              guestAfterReload(g);
            },
          });
        }, 0);
      },
    });
  }

  // ------------------------------------------- handle_push_guest_config
  // discovery 的 sap_rx 里 "push_guest_config" 分支的本体（原版第 3624-3633 行）：
  // CAP 下发的访客网络配置：SAP 本地落盘并重建访客子网。
  // 保存失败回 { ok:false, error:"invalid" }；成功回 { ok:true }
  // （原版成功分支回 { ok:r.ok, error:r.error }，其中 r.error 为 undefined，
  // 即线上无 error 字段；此处等价地省略该字段）。
  function handlePushGuestConfig(g) {
    if (!guestSaveLocal(g ?? {})) return { ok: false, error: 'invalid' };
    const r = applyGuestLocal(guestCfg());
    return r.ok ? { ok: true } : { ok: false, error: 'invalid' };
  }

  return {
    // spec §8 对外接口
    guestCfg,
    guestSummary,
    applyGuestLocal,
    guestSaveLocal,
    guestTick,
    // 其余访客函数（供 discovery 的 sap_rx / 测试与合拢时调用）
    guestOpenNow,
    guestLanInfo,
    guestNetdevs,
    guestWriteWireless,
    guestRemoveInfra,
    guestWriteInfra,
    guestNftApply,
    guestClientIps,
    guestTcCleanup,
    guestTcApply,
    guestPortSync,
    guestAfterReload,
    handlePushGuestConfig,
  };
}

// ------------------------------------------------------------------ NOTES
// 含糊项处理（spec §9，按原样抄，不发明）：
//   §9.5  guest_cfg().ver 即 UCI guest.config_ver（guest_save_local 把 g.ver
//          原样写回，不 +1；ver+1 由 api 侧 set_guest 组装 cfg 时做）。
//   §9.15 guest_write_infra 的 zone 迁移：迁移条件与字段以原版第 1822-1927、
//          2136-2184 行原文为准；device-only 的两条理由注释原样保留。
//   §9.16 guest_port_sync 重试上限：tries < 10（共 10 次 1000ms 重试），超限后
//          直接按无端口写桥并调 cb（cb 仍被调用）。
//   §9.17 guest_tc_apply 带宽单位与 classid：按原文抄，rate = bandwidth*1000 kbit，
//          classid 从 1:21 起按 IP 顺序递增，默认类 1:20 同样按限速值；
//          不推断 bandwidth 是 Mbps 还是其它单位。
//   §9.2  uloop.process 回调参数 res：按 lib/shell.js 的 runProcess 语义取退出码
//          （起不来/信号杀死/超时为 null），log 原样为 "guest wifi reload rc=" + res。
//   §9.23 Shell 拼接不转义：SSID/MAC/IP/带宽等直接拼进命令串，与原版一致。
// 未等价项：
//   * guest_client_ips 的租约行切分：原版 split(trim(line), " ")（单空格切分）；
//     本模块用 /\s+/ 切分。dhcp.leases 各字段间为单空格时结果完全相同；多空格
//     的畸形行原版会把 f[2] 取为空串而本模块仍取到 IP（更稳妥的解析，行为差
//     异仅见于畸形输入）。
//   * uloop.process 的并发语义：原版两个 uloop.process 调用并列发出；本模块
//     同样并列调用 runProcess（不等前一个完成），回调嵌套顺序与原文一致。
