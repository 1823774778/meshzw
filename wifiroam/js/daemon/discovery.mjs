// discovery.mjs -- 设备发现、UDP hello、TCP 对端通道、配对/加入/认证、push 配置下发。
// Target: Node >= 22.23.4, ESM, Node 核心模块 only, 零 npm 依赖。
// 对照原版: wifiroamd.uc 第 2746-2828 行 (UDP)、3528-3770 行 (SAP 侧)、
//   3751-3764 行 (conn_close)、3765-3976 行 (srv_rx/srv_accept/setup_tcp/peer_link_dead)、
//   3977-4165 行 (push_*_to / apply_*_result_update)、606-624 行 (alias_broadcast)、
//   4856-4912 行 (pair 的通道握手部分)、4913-4934 行 (unpair 的 leave 发送)。
// 规格: spec.md §4 (对端协议)、§8 模块 2 (discovery)。
//
// 本模块只 import lib/ (util 的纯函数、ubus 的 UbusChannel) 与 Node 核心模块
// (node:dgram / node:net)。不 import 其他业务模块: 需要调 wifi/guest/policy/
// clients/core 的函数时, 一律走 ctx 注入的回调 (spec §8 循环依赖禁区)。
//
// 工厂: createDiscovery(ctx), ctx = {
//   S,            // core 持有的共享状态单例 (spec §1.2, 字段名逐字照抄)。
//                  // 本模块只用下列字段, 不发明 S 字段:
//                  //   cfg{role,token,cap_ip,name}, self{mac,ip,name,model,nonce},
//                  //   bcast, peers{}, discovered{}, cap_learned, link,
//                  //   roster, cap_nr, net_names, aliases{ver,...},
//                  //   last_apply, last_backhaul, last_wifi, last_guest,
//                  //   roam_ver_applied, backhaul_ver_applied, prev_clients, events
//   bus,          // (保留位) 本地 ubusd 客户端; 发现/对端协议不走本地 ubus, 本模块不用。
//   uci,          // lib/uci.js 的 UciClient; 仅 push_offload_to 读 firewall 开关用。
//   shell,        // (保留位) 本模块不调外部命令, 不用。
//   util,         // (可选) 覆盖 lib/util.js 的同名纯函数; 不传则用 lib 默认实现。
//   store,        // (保留位) 本模块不直接读写 JSON 文件 (alias_save 走回调), 不用。
//   // ---- 跨模块回调 (调用方注入, 缺失时工厂直接抛 TypeError, 不静默降级) ----
//   pushEvent,    // (type, mac, info, name) -- core 的 push_event
//   saveConfig,   // () -- core 的 save_config
//   reconfigure,  // () -- core 的 reconfigure
//   currentRoamCfg, currentBackhaulCfg, guestCfg, // wifi/guest 模块的现读配置
//   roamSig,      // (roam) -> sha256 签名 -- wifi 模块
//   selfInfo,     // () -> 本机信息对象 -- wifi 模块
//   localClients, // () -> 本机终端表 -- clients 模块
//   diffEvents,   // (prev, cur, apname) -- clients 模块
//   ownerEvents,  // (myClients) -- clients 模块
//   clientNames,  // () -> macnorm -> {hostname, ip} -- clients 模块
//   apOverview,   // () -> 全网 AP/SSID 概览 -- wifi 模块
//   bssPublic,    // () -> 公开 11k 邻居列表 -- wifi 模块
//   memberList,   // () -> [{mac, name}] -- wifi 模块
//   appliedKvr,   // (ssids) -> 已落盘 K/V/R 状态 -- wifi 模块
//   applyRoamLocal, applyBackhaulLocal, applyWifiLocal, // wifi 模块
//   roamRenameSsids, wifiSummary,        // wifi 模块
//   guestSaveLocal, applyGuestLocal,      // guest 模块
//   offloadApply,  // (on) -> bool -- policy 模块
//   aliasApply, pinApply,                // 别名/固定 AP 写盘 -- 归属见下
//   aliasSave,     // () -- 写 aliases.json + UCI alias_sync.ver 镜像
//   deviceReindex, // () -- clients 模块, 按 aliases 重建 device_index
//   findClient,    // (key) -> {node, ap} | null -- clients 模块
//   buildTopology, // () -> {nodes, self, role, now} -- clients 模块
//   // ---- 测试缝 (可选; 生产环境不传, 用真实实现) ----
//   dgram, net,   // node:dgram / node:net 的替代实现 (单测 mock 用)
//   channelConnect,   // (host, port) -> Promise<channel>, 默认 UbusChannel.connect
//   channelFromSocket, // (socket) -> channel, 默认 UbusChannel.fromSocket
//   timers,       // { setTimeout, clearTimeout }, 默认全局定时器
//   exit,         // (code) -> void, 默认 process.exit (bind 失败 fail-fast 用)
// }
//
// 与 lib/ubus.js 的对齐说明 (INTERFACE.md, 非本模块能改的行为, 见最终回复):
//  1. 原版 chan.disconnect() 对应 lib 的 chan.close() (lib 没有 disconnect)。
//  2. 通道入站 handler 的返回值会被 lib 当作 DATA 回执: 原版 srv_rx/sap_rx
//     返回 0 表示"已处理、无回执", 在 JS 里必须返回 undefined, 否则 lib 会把
//     0 编成一条 DATA 发出去; 无回执的丢弃分支同样返回 undefined, lib 仍会
//     补发一条 STATUS OK (ucode 侧是静默丢弃、无 STATUS, 属 lib 层差异)。
//  3. 原版 defer 的 data_cb/cb(rc) 映射为 lib 的 { onData } + Promise:
//     resolve {status} 为完成, reject 为失败/超时; rc != 0 的分支按
//     "reject 或 status != 0" 处理。defer 默认超时 30 秒 (lib 缺省值)。
//  4. 原版 join 成功/leave 的 300ms 延迟、pair 的 8000ms 兜底定时器原样保留。

import dgramNode from 'node:dgram';
import netNode from 'node:net';

import { UbusChannel } from '../lib/ubus.js';
import {
  devnorm as libDevnorm,
  log as libLog,
  maccolon as libMaccolon,
  macnorm as libMacnorm,
  nowSeconds as libNowSeconds,
  randhex as libRandhex,
  sha256 as libSha256,
} from '../lib/util.js';

// ------------------------------------------------------------------ 常量
// 原版第 20-29 行, 逐字照抄。
export const UDP_PORT = 50607;
export const TCP_PORT = 50608;
export const MAGIC = 'WIFIROAM1';
export const PEER_TTL = 30; // s without hello -> offline
export const DISCOVER_TTL = 180; // s unconfigured device stays in discover list
export const HELLO_INTERVAL = 5000;
export const TICK_INTERVAL = 10000;
export const MAX_EVENTS = 100;
export const SAP_WATCHDOG_S = 45; // sap_tick 心跳看门狗: last_pong 超 45s 断开重连
export const PAIR_TIMEOUT_MS = 8000; // pair 兜底断开定时器
export const RECONFIGURE_DELAY_MS = 300; // join 成功 / leave 后延迟 reconfigure

// 本模块需要的跨模块回调 (缺一不可, 工厂内逐项校验)。
const REQUIRED_CALLBACKS = [
  'pushEvent', 'saveConfig', 'reconfigure',
  'currentRoamCfg', 'currentBackhaulCfg', 'guestCfg', 'roamSig',
  'selfInfo', 'localClients', 'diffEvents', 'ownerEvents', 'clientNames',
  'apOverview', 'bssPublic', 'memberList', 'appliedKvr',
  'applyRoamLocal', 'applyBackhaulLocal', 'applyWifiLocal',
  'roamRenameSsids', 'wifiSummary', 'guestSaveLocal', 'applyGuestLocal',
  'offloadApply', 'aliasApply', 'pinApply', 'aliasSave', 'deviceReindex',
  'findClient', 'buildTopology',
];

export function createDiscovery(ctx = {}) {
  const S = ctx.S;
  if (!S || typeof S !== 'object') {
    throw new TypeError('discovery: ctx.S (shared state) is required');
  }
  if (!ctx.uci || typeof ctx.uci.get !== 'function') {
    throw new TypeError('discovery: ctx.uci (UciClient) is required');
  }
  for (const name of REQUIRED_CALLBACKS) {
    if (typeof ctx[name] !== 'function') {
      throw new TypeError(`discovery: ctx.${name} callback is required`);
    }
  }

  // util: 优先用 ctx 注入的实现, 否则用 lib/util.js (纯函数, 无需 mock)。
  const log = ctx.util?.log ?? libLog;
  const macnorm = ctx.util?.macnorm ?? libMacnorm;
  const maccolon = ctx.util?.maccolon ?? libMaccolon;
  const devnorm = ctx.util?.devnorm ?? libDevnorm;
  const randhex = ctx.util?.randhex ?? libRandhex;
  const sha256 = ctx.util?.sha256 ?? libSha256;
  const nowSeconds = ctx.util?.nowSeconds ?? libNowSeconds;

  const dgram = ctx.dgram ?? dgramNode;
  const net = ctx.net ?? netNode;
  const channelConnect = ctx.channelConnect ?? ((host, port) => UbusChannel.connect(host, port));
  const channelFromSocket = ctx.channelFromSocket ?? ((socket) => UbusChannel.fromSocket(socket));
  const timers = ctx.timers ?? { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const exitFn = ctx.exit ?? ((code) => process.exit(code));

  const pushEvent = ctx.pushEvent;

  let udpSocket = null;
  let udpBound = false;
  let tcpServer = null;
  let tcpListening = false;

  // ---------------------------------------------------------- 小工具
  // 原版 chan.disconnect() -> lib chan.close(); mock 通道可能只提供其一, 都兼容。
  function chanClose(chan) {
    if (!chan) return;
    if (typeof chan.close === 'function') chan.close();
    else if (typeof chan.disconnect === 'function') chan.disconnect();
  }

  // net.Socket 没有 close(), 只有 destroy(); mock 可能只提供 close()。
  function closeSocket(sock) {
    if (!sock) return;
    if (typeof sock.destroy === 'function') sock.destroy();
    else if (typeof sock.close === 'function') sock.close();
  }

  // fire-and-forget 的 defer: 忽略其 Promise 结果, 但必须挂住 rejection,
  // 否则 Node 会以 unhandledRejection 崩溃。原版的空 data_cb/cb 即"忽略一切"。
  function fireAndForget(promise) {
    if (promise && typeof promise.then === 'function') {
      promise.then(undefined, () => {});
    }
  }

  // defer 的完成回调: resolve {status} 为完成 (status != 0 视同失败),
  // reject 为失败/超时。原版 cb(rc) 只关心 rc != 0。
  function onDeferSettled(promise, onFailure) {
    if (!promise || typeof promise.then !== 'function') return;
    promise.then(
      (res) => { if (res && res.status !== 0) onFailure(); },
      () => onFailure(),
    );
  }

  // thash = substr(sha256("wifiroam:" + token), 0, 16), 同网识别用, 不直接传 token。
  function tokenHash() {
    return sha256(`wifiroam:${S.cfg.token ?? ''}`).slice(0, 16);
  }

  // ---------------------------------------------------------------- UDP
  // 原版 udp_send (第 2746-2750 行): 对象 JSON 经 UDP 发往 state.bcast:50607。
  function udpSend(obj) {
    if (!udpSocket) return;
    const buf = Buffer.from(JSON.stringify(obj), 'utf8');
    try {
      udpSocket.send(buf, UDP_PORT, S.bcast ?? '255.255.255.255');
    } catch (_e) { /* 发送失败静默丢弃, 与原版 send 无返回值检查一致 */ }
  }

  // 原版 send_hello (第 2752-2761 行): 每 5 秒广播一次。
  // ver: 1 是 hello 协议版本, 与 DAEMON_VERSION=5 不同。
  function sendHello() {
    udpSend({
      magic: MAGIC, ver: 1, role: S.cfg.role,
      mac: S.self.mac, ip: S.self.ip,
      name: S.self.name, model: S.self.model,
      nonce: S.self.nonce,
      thash: tokenHash(),
      alias_ver: S.aliases.ver, ts: nowSeconds(),
    });
  }

  // 原版 udp_rx (第 2763-2796 行): 接收循环逐条处理。
  // Node 侧是 dgram 'message' 事件, 每事件一条数据报, 与原版 recv 循环等价。
  // peer.address 为发送方地址 (原版 recv 的 peer 参数)。
  function udpRx(data, rinfo) {
    let msg;
    try {
      msg = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
    } catch (_e) {
      return; // JSON 解析失败跳过
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.magic !== MAGIC) return;
    const mn = macnorm(msg.mac);
    if (mn.length !== 12 || mn === macnorm(S.self.mac)) return;

    if (msg.role === 'unconfigured') {
      S.discovered[mn] = {
        mac: String(msg.mac).toUpperCase(), ip: msg.ip ?? rinfo?.address,
        name: msg.name ?? null, model: msg.model ?? null,
        nonce: msg.nonce ?? null, last_seen: nowSeconds(),
      };
      return; // 不进入 peer 表, 不校验 token
    }

    const myTh = tokenHash();
    if ((S.cfg.token ?? '') === '' || msg.thash !== myTh) return; // foreign net

    const p = (S.peers[mn] ??= { clients: null }); // null = 未收过 report, 首轮 diff 抑制
    p.mac = String(msg.mac).toUpperCase();
    p.ip = msg.ip ?? rinfo?.address;
    p.name = msg.name ?? null;
    p.model = msg.model ?? null;
    p.role = msg.role;
    p.last_seen = nowSeconds();
    if (msg.role === 'cap' && msg.ip) {
      S.cap_learned = msg.ip;
    }
  }

  // 原版 expire_tick (第 2798-2811 行): 每 10 秒。
  function expireTick() {
    const now = nowSeconds();
    for (const mn of Object.keys(S.peers)) {
      if (now - (S.peers[mn].last_seen ?? 0) > PEER_TTL) {
        const p = S.peers[mn];
        pushEvent('ap_offline', maccolon(mn), p.name ?? '');
        if (p.chan) chanClose(p.chan);
        delete S.peers[mn];
      }
    }
    for (const mn of Object.keys(S.discovered)) {
      if (now - S.discovered[mn].last_seen > DISCOVER_TTL) {
        delete S.discovered[mn];
      }
    }
  }

  // 原版 setup_udp (第 2813-2826 行):
  // 建 UDP socket (AF_INET/SOCK_DGRAM/NONBLOCK, SO_REUSEADDR+SO_BROADCAST),
  // bind 0.0.0.0:50607, 读事件 -> udp_rx; bind 失败 exit(1)。
  // 传输不可用 = 守护进程无意义, fail-fast 交 procd 处置。
  // 返回 Promise, bind 成功后 resolve (供 core 在 main 里 await)。
  function setupUdp() {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    udpSocket = sock;
    udpBound = false;
    sock.on('message', (msg, rinfo) => udpRx(msg, rinfo));
    sock.on('error', (err) => {
      if (!udpBound) {
        log(`udp bind failed: ${err?.message ?? err}`);
        try { sock.close(); } catch (_e) { /* ignore */ }
        udpSocket = null;
        exitFn(1);
      } else {
        log(`udp error: ${err?.message ?? err}`);
      }
    });
    return new Promise((resolve) => {
      sock.bind(UDP_PORT, '0.0.0.0', () => {
        udpBound = true;
        try { sock.setBroadcast(true); } catch (_e) { /* ignore */ }
        resolve();
      });
    });
  }

  // ------------------------------------------------------- TCP 服务端
  // 原版 conn_close (第 3751-3764 行): 关闭一条 TCP 连接, 清除对应 peer 的
  // conn/chan/authed。_closed 守卫保证幂等 (close 事件会再次触发本函数)。
  function connClose(conn) {
    if (!conn || conn._closed) return;
    conn._closed = true;
    if (conn.chan) { try { chanClose(conn.chan); } catch (_e) { /* ignore */ } }
    if (conn.sock) { try { closeSocket(conn.sock); } catch (_e) { /* ignore */ } }
    if (conn.mac) {
      const mn = macnorm(conn.mac);
      const p = S.peers[mn];
      if (p && p.conn === conn) {
        p.conn = null;
        p.chan = null;
        p.authed = false;
      }
    }
  }

  // 原版 peer_link_dead (第 3968-3976 行):
  // 通道写失败时清理对端状态, 避免僵尸连接导致守护进程崩溃。
  function peerLinkDead(mn, what) {
    const p = S.peers[mn];
    log(`${what} to ${mn} failed, marking peer offline`);
    if (!p) return;
    p.authed = false;
    p.chan = null;
    if (p.conn) { const c = p.conn; p.conn = null; connClose(c); }
  }

  // ------------------------------------------------- push 结果回执更新
  // 原版 apply_result_update / apply_backhaul_result_update /
  // apply_wifi_result_update / apply_guest_result_update
  // (第 4022-4031、4138-4147、4091-4100、4129-4137 行):
  // 更新 state.last_* .results 中指定 AP 的回执项; last_* 为 null 时直接返回。
  function applyResultUpdate(mn, _name, ok, ver, err, kvr) {
    if (!S.last_apply) return;
    for (const r of S.last_apply.results ?? []) {
      if (r.ap === maccolon(mn) || r.ap === mn) {
        r.ok = ok; r.ver = ver; r.error = err;
        if (kvr) r.kvr = kvr;
      }
    }
  }

  function applyBackhaulResultUpdate(mn, _name, ok, ver, err) {
    if (!S.last_backhaul) return;
    for (const r of S.last_backhaul.results ?? []) {
      if (r.ap === maccolon(mn) || r.ap === mn) {
        r.ok = ok; r.ver = ver; r.error = err;
      }
    }
  }

  function applyWifiResultUpdate(mn, ok, err) {
    if (!S.last_wifi) return;
    for (const r of S.last_wifi.results ?? []) {
      if (r.ap === maccolon(mn) || r.ap === mn) {
        r.ok = ok; r.error = err;
      }
    }
  }

  function applyGuestResultUpdate(mn, ok, err) {
    if (!S.last_guest) return;
    for (const r of S.last_guest.results ?? []) {
      if (r.ap === maccolon(mn) || r.ap === mn) {
        r.ok = ok; r.error = err;
      }
    }
  }

  // ------------------------------------------------------- CAP 侧 push
  // 原版 alias_broadcast (第 606-624 行): CAP 向全部已认证 peer 的 channel
  // defer push_aliases (data.aliases = state.aliases 全量); 写失败时断开该 peer。
  // 注: spec §8 的模块 2 列表漏列了本函数, 但它是 push_aliases_to 的广播版,
  // 只能属于 discovery (见最终回复)。
  function aliasBroadcast() {
    if (S.cfg.role !== 'cap') return;
    for (const [mn, p] of Object.entries(S.peers)) {
      if (!p.authed || !p.chan) continue;
      try {
        fireAndForget(p.chan.defer('push_aliases', { aliases: S.aliases }, {}));
      } catch (_e) {
        p.authed = false;
        p.chan = null;
        if (p.conn) { const c = p.conn; p.conn = null; connClose(c); }
      }
    }
  }

  // 原版 push_aliases_to (第 3977-3989 行): 未认证/无通道返回 (原版无返回值)。
  function pushAliasesTo(mn) {
    const p = S.peers[mn];
    if (!p?.authed || !p.chan) return;
    try {
      fireAndForget(p.chan.defer('push_aliases', { aliases: S.aliases }, {}));
    } catch (_e) {
      peerLinkDead(mn, 'push_aliases');
    }
  }

  // 原版 push_roam_to (第 3991-4021 行)。
  // 推送在途避免 auth+report 竞争重复下发 (p.roam_pushing)。
  function pushRoamTo(mn) {
    const p = S.peers[mn];
    if (!p?.authed || !p.chan) return false;
    if (p.roam_pushing) return true; // 推送在途, 避免 auth+report 竞争重复下发
    const roam = ctx.currentRoamCfg();
    const name = p.info?.name ?? p.name ?? mn;
    p.roam_pushing = true;
    try {
      const promise = p.chan.defer('push_roam_config',
        { roam, members: ctx.memberList() },
        {
          onData: (m) => {
            p.roam_pushing = false;
            applyResultUpdate(mn, name, m?.ok ?? false, m?.ver ?? null, null, m?.kvr ?? null);
          },
        });
      // 成功时 data_cb 已写入结果; 仅失败/超时标记 timeout。
      onDeferSettled(promise, () => {
        p.roam_pushing = false;
        applyResultUpdate(mn, name, false, null, 'timeout');
      });
    } catch (_e) {
      p.roam_pushing = false;
      peerLinkDead(mn, 'push_roam_config');
      return false;
    }
    return true;
  }

  // 原版 push_backhaul_to (第 4032-4062 行)。
  function pushBackhaulTo(mn) {
    const p = S.peers[mn];
    if (!p?.authed || !p.chan) return false;
    if (p.bh_pushing) return true;
    const bh = ctx.currentBackhaulCfg();
    const name = p.info?.name ?? p.name ?? mn;
    p.bh_pushing = true;
    try {
      const promise = p.chan.defer('push_backhaul_config',
        { backhaul: bh },
        {
          onData: (m) => {
            p.bh_pushing = false;
            applyBackhaulResultUpdate(mn, name, m?.ok ?? false, m?.ver ?? null, m?.error ?? null);
          },
        });
      onDeferSettled(promise, () => {
        p.bh_pushing = false;
        applyBackhaulResultUpdate(mn, name, false, null, 'timeout');
      });
    } catch (_e) {
      p.bh_pushing = false;
      peerLinkDead(mn, 'push_backhaul_config');
      return false;
    }
    return true;
  }

  // 原版 push_wifi_to (第 4063-4090 行):
  // 把新的 SSID / 密码 (按频段) 推给成员 AP (SAP 收到后改写本地 wireless 并重启无线)。
  function pushWifiTo(mn, ssids) {
    const p = S.peers[mn];
    if (!p?.authed || !p.chan) return false;
    if (p.wifi_pushing) return true;
    p.wifi_pushing = true;
    try {
      const promise = p.chan.defer('push_wifi_config',
        { ssids },
        {
          onData: (m) => {
            p.wifi_pushing = false;
            applyWifiResultUpdate(mn, m?.ok ?? false, m?.error ?? null);
          },
        });
      onDeferSettled(promise, () => {
        p.wifi_pushing = false;
        applyWifiResultUpdate(mn, false, 'timeout');
      });
    } catch (_e) {
      p.wifi_pushing = false;
      peerLinkDead(mn, 'push_wifi_config');
      return false;
    }
    return true;
  }

  // 原版 push_guest_to (第 4101-4128 行):
  // 把访客网络配置推给成员 AP (SAP 收到后重建本机访客子网)。
  function pushGuestTo(mn, cfg) {
    const p = S.peers[mn];
    if (!p?.authed || !p.chan) return false;
    if (p.guest_pushing) return true;
    p.guest_pushing = true;
    try {
      const promise = p.chan.defer('push_guest_config',
        { guest: cfg },
        {
          onData: (m) => {
            p.guest_pushing = false;
            applyGuestResultUpdate(mn, m?.ok ?? false, m?.error ?? null);
          },
        });
      onDeferSettled(promise, () => {
        p.guest_pushing = false;
        applyGuestResultUpdate(mn, false, 'timeout');
      });
    } catch (_e) {
      p.guest_pushing = false;
      peerLinkDead(mn, 'push_guest_config');
      return false;
    }
    return true;
  }

  // 原版 push_offload_to (第 4148-4165 行):
  // CAP: 把 flow offload 开关广播给所有已认证的子 AP, 保证各页面看到同一状态。
  // 开关现读 firewall @defaults[0].flow_offloading (原版每次现建 uci cursor 读)。
  function pushOffloadTo(mn) {
    const p = S.peers[mn];
    if (!p?.authed || !p.chan) return;
    const on = ctx.uci.get('firewall', '@defaults[0]', 'flow_offloading') === '1';
    try {
      fireAndForget(p.chan.defer('push_offload', { enabled: on }, {}));
    } catch (_e) {
      peerLinkDead(mn, 'push_offload');
    }
  }

  // ------------------------------------------------------- CAP 侧 srv_rx
  // 原版 srv_rx (第 3765-3933 行, 169 行): CAP/全角色 TCP 服务端接收回调。
  // 未认证处理 join (配对) 与 auth; 已认证处理 report_status/report_event/
  // set_offload/get_topology/get_client_detail/alias_update/pin_update;
  // 未知方法回 {ok:false, error:"unknown_method"}。
  // 注意: 本函数不返回值 (返回 undefined); 见文件头第 2 条对齐说明。
  async function srvRx(conn, req) {
    const args = req.data ?? {};

    if (!conn.authed) {
      if (req.method === 'join' && S.cfg.role === 'unconfigured') {
        // pairing: CAP pushes credentials to an unconfigured device
        if (args.nonce_echo !== S.self.nonce || !args.token) {
          req.reply({ ok: false, error: 'bad_nonce' });
          return;
        }
        S.cfg.token = args.token;
        S.cfg.cap_ip = args.cap_ip ?? '';
        S.cfg.role = 'sap';
        ctx.saveConfig();
        req.reply({ ok: true });
        pushEvent('paired', '', args.cap_ip ?? '');
        timers.setTimeout(() => ctx.reconfigure(), RECONFIGURE_DELAY_MS);
        return;
      }
      if (req.method === 'auth') {
        const expect = sha256(`${S.cfg.token}:${conn.nonce}`);
        if ((S.cfg.token ?? '') === '' || args.digest !== expect) {
          req.reply({ ok: false, error: 'auth' });
          connClose(conn);
          return;
        }
        const mn = macnorm(args.mac);
        conn.authed = true;
        conn.mac = String(args.mac ?? '').toUpperCase();
        conn.name = args.name;
        const p = (S.peers[mn] ??= { clients: null }); // null = 未收过 report, 首轮 diff 抑制
        p.mac = conn.mac;
        if (args.name) p.name = args.name;
        p.authed = true;
        p.last_seen = nowSeconds();
        p.chan = conn.chan; // 存 channel 本体, conn 仅用于关闭时清理
        p.conn = conn;
        pushEvent('ap_online', conn.mac, conn.name ?? '');
        req.reply({
          ok: true, role: S.cfg.role,
          alias_ver: S.aliases.ver,
          roam_ver: ctx.currentRoamCfg().config_ver,
          backhaul_ver: ctx.currentBackhaulCfg().config_ver,
          // CAP 的 DHCP 租约表: SAP 无 DHCP, 借此在子 AP 拓扑显示主机名
          names: S.cfg.role === 'cap' ? ctx.clientNames() : {},
          // 全网络 AP/SSID 概览: 子 AP 的开启前检查与主 AP 保持一致
          roster: S.cfg.role === 'cap' ? ctx.apOverview() : null,
        });
        if ((args.alias_ver ?? 0) < S.aliases.ver) pushAliasesTo(mn);
        const roam = ctx.currentRoamCfg();
        const rsig = ctx.roamSig(roam);
        // ver 落后或内容签名不一致都重新下发: 后者用于修复历史遗留的
        // SAP 本地配置与主 AP 不一致 (例如只同步了 enabled/ver)
        if (S.cfg.role === 'cap' &&
          ((args.roam_ver ?? -1) < roam.config_ver ||
            (args.roam_sig && args.roam_sig !== rsig))) {
          pushRoamTo(mn);
        }
        const bh = ctx.currentBackhaulCfg();
        if (S.cfg.role === 'cap' && bh.enabled &&
          (args.backhaul_ver ?? -1) < bh.config_ver) {
          pushBackhaulTo(mn);
        }
        /* 访客配置也要在这里补发: 只在保存那一刻推送的话,
           子 AP 重连后仍会保留本地旧配置 (旧密码/旧限速) */
        const ga = ctx.guestCfg();
        if (S.cfg.role === 'cap' && (args.guest_ver ?? -1) < ga.ver) {
          pushGuestTo(mn, ga);
        }
        if (S.cfg.role === 'cap') pushOffloadTo(mn);
        return;
      }
      return; // 未认证的其他方法直接丢弃, 无回执
    }

    // authed dispatch
    const mn = macnorm(conn.mac);
    switch (req.method) {
      case 'report_status': {
        const p = (S.peers[mn] ??= { clients: null });
        const prev = p.clients;
        p.info = args.info;
        p.clients = args.clients ?? {};
        p.alias_ver = args.alias_ver ?? 0;
        p.roam_ver = args.roam_ver ?? 0;
        p.roam_sig = args.roam_sig ?? '';
        p.backhaul_ver = args.backhaul_ver ?? 0;
        p.guest_ver = args.guest_ver ?? 0;
        p.kvr = args.kvr ?? null;
        p.last_seen = nowSeconds();
        if (prev != null) { // 首轮 report 不产 join/leave 事件
          ctx.diffEvents(prev, p.clients, p.info?.name ?? conn.name ?? mn);
        }
        ctx.ownerEvents(await ctx.localClients()); // SAP 终端表更新后立即重算归属 (含跨 AP 迁移)
        if (p.alias_ver < S.aliases.ver) pushAliasesTo(mn);
        const roam = ctx.currentRoamCfg();
        if (p.roam_ver < roam.config_ver ||
          (p.roam_sig !== '' && p.roam_sig !== ctx.roamSig(roam))) {
          pushRoamTo(mn);
        }
        const bh = ctx.currentBackhaulCfg();
        if (bh.enabled && p.backhaul_ver < bh.config_ver) pushBackhaulTo(mn);
        const ga = ctx.guestCfg();
        if (S.cfg.role === 'cap' && p.guest_ver < ga.ver) pushGuestTo(mn, ga);
        req.reply({
          ok: true, alias_ver: S.aliases.ver,
          roam_ver: roam.config_ver, backhaul_ver: bh.config_ver,
          names: S.cfg.role === 'cap' ? ctx.clientNames() : {},
          roster: S.cfg.role === 'cap' ? ctx.apOverview() : null,
          // SAP 要用 CAP 的 11k 邻居元素做候选列表, CAP 的 info 不经 hello 下发;
          // 这里给全拓扑 BSS 列表, 另一台 SAP 才能被互相看见
          nr: await ctx.bssPublic(),
        });
        break;
      }
      case 'report_event':
        // spec §9.24: srv_rx 有 report_event 分支, 但全文无发送点; 只保留接收分支, 不补发送点。
        pushEvent(args.etype ?? 'peer_event', args.mac ?? '', args.info ?? '', args.name ?? '');
        req.reply({ ok: true });
        break;
      case 'set_offload': {
        // SAP 页面上的开关: 转发在 CAP, 必须由 CAP 执行后再广播回全部子 AP
        if (S.cfg.role !== 'cap') {
          req.reply({ ok: false, error: 'not_cap' });
          break;
        }
        const on = req.data.enabled ? true : false;
        const ok = ctx.offloadApply(on);
        for (const [pmn, p] of Object.entries(S.peers)) {
          if (p.authed) pushOffloadTo(pmn);
        }
        req.reply({ ok, enabled: on });
        break;
      }
      case 'get_topology':
        req.reply(await ctx.buildTopology());
        break;
      case 'get_client_detail': {
        const r = await ctx.findClient(devnorm(args.mac));
        if (r) req.reply({ ok: true, client: r.node, ap: r.ap });
        else req.reply({ ok: false });
        break;
      }
      case 'alias_update':
        if (S.cfg.role === 'cap' &&
          ctx.aliasApply(args.mac, args.name, args.icon, args.note)) {
          aliasBroadcast();
          req.reply({ ok: true, ver: S.aliases.ver });
        } else {
          req.reply({ ok: false });
        }
        break;
      case 'pin_update':
        if (S.cfg.role === 'cap') {
          const pr = ctx.pinApply(args.mac, args.ap ?? '');
          if (pr.ok) {
            aliasBroadcast();
            req.reply({ ok: true, ver: S.aliases.ver });
          } else {
            req.reply({ ok: false, error: pr.error });
          }
        } else {
          req.reply({ ok: false });
        }
        break;
      default:
        req.reply({ ok: false, error: 'unknown_method' });
    }
  }

  // 原版 srv_accept (第 3934-3951 行): TCP 监听接受循环。
  // accept 后建 conn{nonce:randhex(16)}, open_channel(srv_rx, conn_close),
  // 立即 request hello{mac,role,nonce} (return:"ignore")。
  // Node 侧: net server 的 'connection' 事件即一次 accept。
  function srvAccept(socket) {
    const conn = { sock: socket, chan: null, authed: false, nonce: randhex(16), mac: null, name: null };
    let chan;
    try {
      chan = channelFromSocket(socket);
    } catch (_e) {
      try { closeSocket(socket); } catch (_e2) { /* ignore */ }
      return;
    }
    conn.chan = chan;
    chan.setRequestHandler((req) => srvRx(conn, req));
    chan.on('close', () => connClose(conn));
    try {
      fireAndForget(chan.request('hello',
        { mac: S.self.mac, role: S.cfg.role, nonce: conn.nonce },
        { noReply: true }));
    } catch (_e) {
      connClose(conn);
    }
  }

  // 原版 setup_tcp (第 3953-3966 行):
  // 建 TCP 监听 socket (AF_INET/SOCK_STREAM/NONBLOCK, SO_REUSEADDR),
  // bind 0.0.0.0:50608, listen(8), 读事件 -> srv_accept; 失败 exit(1)。
  // fail-fast: 避免僵尸实例与正常实例竞争。
  // 返回 Promise, listen 成功后 resolve。
  function setupTcp() {
    const server = net.createServer();
    tcpServer = server;
    tcpListening = false;
    server.on('connection', (socket) => srvAccept(socket));
    server.on('error', (err) => {
      if (!tcpListening) {
        log(`tcp bind/listen failed: ${err?.message ?? err}`);
        try { server.close(); } catch (_e) { /* ignore */ }
        tcpServer = null;
        exitFn(1);
      } else {
        log(`tcp error: ${err?.message ?? err}`);
      }
    });
    return new Promise((resolve) => {
      server.listen(TCP_PORT, '0.0.0.0', 8, () => {
        tcpListening = true;
        resolve();
      });
    });
  }

  // ------------------------------------------------------- SAP 侧 sap_rx
  // 原版 sap_rx (第 3528-3667 行, 140 行): SAP 侧 TCP 通道接收回调。
  // 未认证时处理 hello -> defer auth; 已认证时 switch 处理
  // push_roam_config/push_aliases/push_backhaul_config/push_wifi_config/
  // push_guest_config/push_offload/get_client_detail/get_topology/leave;
  // 无 default 分支 (未知类型静默丢弃)。不返回值 (见文件头第 2 条)。
  async function sapRx(req) {
    const link = S.link;
    if (!link || !link.chan) return;

    if (!link.authed) {
      if (req.method === 'hello') {
        link.cap_mac = macnorm(req.data?.mac ?? '');
        const digest = sha256(`${S.cfg.token ?? ''}:${req.data?.nonce ?? ''}`);
        let promise;
        try {
          promise = link.chan.defer('auth',
            {
              mac: S.self.mac, role: S.cfg.role,
              name: S.self.name, digest,
              alias_ver: S.aliases.ver,
              roam_ver: S.roam_ver_applied,
              roam_sig: ctx.roamSig(ctx.currentRoamCfg()),
              backhaul_ver: S.backhaul_ver_applied,
              guest_ver: ctx.guestCfg().ver,
            },
            {
              onData: (m) => {
                if (m?.ok) {
                  link.authed = true;
                  link.last_pong = nowSeconds();
                  S.net_names = m.names ?? {};
                  if (m.roster) S.roster = m.roster;
                  // 让 SAP 侧 status/peers_online 反映 CAP 在线
                  if (link.cap_mac) {
                    const cp = (S.peers[link.cap_mac] ??= { clients: {} });
                    cp.authed = true;
                  }
                  pushEvent('cap_connected', '', S.cfg.cap_ip);
                  log('link to CAP established');
                  sapReport();
                } else {
                  log('CAP auth rejected');
                  chanClose(link.chan);
                }
              },
            });
        } catch (_e) {
          // defer 同步抛错 (通道已关): 视同请求失败, 见下方完成回调的等价处理。
          if (S.link === link) {
            log('CAP auth request failed');
            sapDisconnect();
          }
          return;
        }
        // cb 为 complete 回调 (成功也触发), 仅 rc != 0 表示失败/超时。
        onDeferSettled(promise, () => {
          if (S.link === link) {
            log('CAP auth request failed');
            sapDisconnect();
          }
        });
      }
      return;
    }

    switch (req.method) {
      case 'push_roam_config': {
        const r = ctx.applyRoamLocal(req.data.roam, req.data.members ?? []);
        req.reply({
          ok: r.ok, ver: r.ver,
          kvr: ctx.appliedKvr(req.data.roam?.ssids ?? []),
        });
        break;
      }
      case 'push_aliases': {
        const a = req.data.aliases;
        if (a && (a.ver ?? 0) > S.aliases.ver) {
          S.aliases = a;
          ctx.deviceReindex();
          ctx.aliasSave();
        }
        req.reply({ ok: true, ver: S.aliases.ver });
        break;
      }
      case 'push_backhaul_config': {
        const r = ctx.applyBackhaulLocal(req.data.backhaul ?? {}, 'sap');
        req.reply({ ok: r.ok, ver: r.ver, error: r.error });
        break;
      }
      case 'push_wifi_config': {
        // CAP 下发的前台 SSID/密码: SAP 按频段改写本地 wireless 并重启无线
        const ssids = [];
        let bad = false;
        for (const it of (req.data.ssids ?? [])) {
          const ssid = String(it.ssid ?? '').trim();
          const key = it.key ?? '';
          if (ssid.length < 1 || ssid.length > 32) bad = true;
          if (key !== '' && (key.length < 8 || key.length > 64)) bad = true;
          ssids.push({ band: it.band ?? '?', ssid, key });
        }
        let r = { ok: false, error: 'ssid_invalid' };
        if (!bad && ssids.length > 0) {
          const pairs = [];
          for (const it of ctx.wifiSummary().ifaces) {
            for (const s of ssids) {
              if (s.band === it.band) pairs.push({ old: it.ssid, new: s.ssid });
            }
          }
          ctx.roamRenameSsids(pairs);
          r = ctx.applyWifiLocal(ssids);
        }
        req.reply({ ok: r.ok, error: r.error });
        break;
      }
      case 'push_guest_config': {
        // CAP 下发的访客网络配置: SAP 本地落盘并重建访客子网
        const g = req.data.guest ?? {};
        if (!ctx.guestSaveLocal(g)) {
          req.reply({ ok: false, error: 'invalid' });
          break;
        }
        const r = ctx.applyGuestLocal(ctx.guestCfg());
        req.reply({ ok: r.ok, error: r.error });
        break;
      }
      case 'push_offload': {
        // CAP 广播下来的 flow offload 开关: SAP 本地落盘并重建自己的 flowtable
        const on = req.data.enabled ? true : false;
        req.reply({ ok: ctx.offloadApply(on), enabled: on });
        break;
      }
      case 'get_client_detail': {
        const r = await ctx.findClient(devnorm(req.data.mac));
        if (r) req.reply({ ok: true, client: r.node, ap: r.ap });
        else req.reply({ ok: false });
        break;
      }
      case 'get_topology':
        req.reply(await ctx.buildTopology());
        break;
      case 'leave':
        req.reply({ ok: true });
        pushEvent('unpaired', '', '');
        timers.setTimeout(() => {
          ctx.applyRoamLocal({ enabled: false, ssids: [], config_ver: 0 }, []);
          S.cfg.role = 'unconfigured';
          S.cfg.token = '';
          S.cfg.cap_ip = '';
          ctx.saveConfig();
          ctx.reconfigure();
        }, RECONFIGURE_DELAY_MS);
        break;
      // 无 default 分支: 未知类型静默丢弃 (原版同)。
    }
  }

  // 原版 sap_disconnect (第 3668-3678 行): 断开 SAP->CAP 链路。
  function sapDisconnect() {
    const link = S.link;
    if (!link) return;
    log('link to CAP closed');
    if (link.chan) { try { chanClose(link.chan); } catch (_e) { /* ignore */ } }
    if (link.sock) { try { closeSocket(link.sock); } catch (_e) { /* ignore */ } }
    if (link.cap_mac && S.peers[link.cap_mac]) {
      S.peers[link.cap_mac].authed = false;
    }
    S.link = null;
  }

  // 原版 sap_connect (第 3679-3692 行): SAP 向 cap_ip 建 TCP socket
  // (SOCK_STREAM/NONBLOCK), libubus.open_channel(sock, sap_rx, sap_disconnect),
  // 置 state.link (authed=false)。
  // Node 侧: UbusChannel.connect 是异步的 (TCP 建连完成后才有 channel);
  // 建连失败时视同通道断开 (原版 nonblocking connect 失败后走 disconnect_cb)。
  // 若在建连完成前又被调了一次, 旧的 pending 连接会被抛弃 (以 S.link 为准)。
  function sapConnect(capIp) {
    sapDisconnect();
    const link = { sock: null, chan: null, authed: false, ts: nowSeconds(), last_pong: nowSeconds() };
    S.link = link;
    log(`connecting to CAP ${capIp}`);
    let promise;
    try {
      promise = channelConnect(capIp, TCP_PORT);
    } catch (_e) {
      if (S.link === link) sapDisconnect();
      return;
    }
    Promise.resolve(promise).then((chan) => {
      if (S.link !== link) {
        // 已被更新的连接取代: 关掉这条多余通道。
        try { chanClose(chan); } catch (_e) { /* ignore */ }
        return;
      }
      link.chan = chan;
      link.sock = chan?.socket ?? null;
      chan.setRequestHandler((req) => sapRx(req));
      chan.on('close', () => { if (S.link === link) sapDisconnect(); });
    }, () => {
      if (S.link === link) sapDisconnect();
    });
  }

  // 原版 sap_tick (第 3693-3707 行): 每 10 秒 (仅 SAP)。
  // 已认证且 last_pong 超 45 秒则断开重连; 未连接则按 cfg.cap_ip 或 cap_learned 连接。
  function sapTick() {
    if (S.cfg.role !== 'sap') return;
    if (S.link?.authed) {
      // 心跳看门狗: ucode 通道可能感知不到对端死亡 (CLOSE_WAIT 半开),
      // 以 report_status 回执刷新 last_pong, 超时主动断开重连
      if (nowSeconds() - (S.link.last_pong ?? S.link.ts) > SAP_WATCHDOG_S) {
        log('CAP link timeout, reconnecting');
        sapDisconnect();
      } else {
        return;
      }
    }
    const cap = (S.cfg.cap_ip != null && S.cfg.cap_ip !== '') ? S.cfg.cap_ip : S.cap_learned;
    if (cap) sapConnect(cap);
  }

  // 原版 sap_report (第 3709-3750 行): 每 10 秒 (仅 SAP, 已认证)。
  // 上报 report_status (info/clients/alias_ver/roam_ver/roam_sig/
  // backhaul_ver/guest_ver/kvr), 回执刷新 last_pong/net_names/roster/cap_nr;
  // 失败断开。
  async function sapReport() {
    if (S.cfg.role !== 'sap' || !S.link?.authed) return;
    let clients;
    try {
      clients = await ctx.localClients();
    } catch (_e) {
      log('CAP link report error');
      return;
    }
    if (S.prev_clients != null) {
      ctx.diffEvents(S.prev_clients, clients, S.self.name);
    }
    S.prev_clients = clients;
    const link = S.link;
    try {
      const promise = link.chan.defer('report_status',
        {
          info: await ctx.selfInfo(),
          clients,
          alias_ver: S.aliases.ver,
          roam_ver: S.roam_ver_applied,
          roam_sig: ctx.roamSig(ctx.currentRoamCfg()),
          backhaul_ver: S.backhaul_ver_applied,
          guest_ver: ctx.guestCfg().ver,
          // 本机落盘的 K/V/R 生效状态, CAP 汇总后展示给用户
          kvr: ctx.appliedKvr(ctx.currentRoamCfg().ssids),
        },
        {
          onData: (m) => {
            link.last_pong = nowSeconds();
            if (m?.names) S.net_names = m.names;
            if (m?.roster) S.roster = m.roster;
            if (m?.nr) S.cap_nr = m.nr;
          },
        });
      // complete 回调: rc == 0 为成功, 仅失败/超时才断开重连。
      onDeferSettled(promise, () => {
        log('CAP link report failed');
        if (S.link === link) sapDisconnect();
      });
    } catch (_e) {
      log('CAP link report error');
      if (S.link === link) sapDisconnect();
    }
  }

  // ------------------------------------------------- pair / unpair 通道侧
  // 原版 pair (第 4856-4912 行, api_obj 方法) 的通道握手部分:
  // CAP 新建 TCP 通道直连未配置设备, 对端 srv_accept 先发 hello 后,
  // defer join{token, cap_ip, nonce_echo}, data_cb 中 m.ok 时发 paired 事件
  // 并删 discovered; 8000ms 定时器兜底断开。
  // 本函数只做通道握手; ubus 层面的参数校验 / 返回值仍由 api 模块负责,
  // 配对成功后的事件与 discovered 清理由 onPaired 回调交回 api/core。
  // 返回 handle { done, channel, close() }; 建连同步失败时返回 null。
  function startPairing({ ip, token, capIp, nonceEcho, onPaired }) {
    let done = false;
    let chan = null;
    const timer = timers.setTimeout(() => {
      if (!done && chan) { try { chanClose(chan); } catch (_e) { /* ignore */ } }
    }, PAIR_TIMEOUT_MS);
    let promise;
    try {
      promise = channelConnect(ip, TCP_PORT);
    } catch (_e) {
      timers.clearTimeout(timer);
      return null;
    }
    Promise.resolve(promise).then((c) => {
      chan = c;
      c.setRequestHandler((req) => {
        if (req.method === 'hello' && chan) {
          try {
            const p = chan.defer('join',
              { token, cap_ip: capIp, nonce_echo: nonceEcho },
              {
                onData: (m) => {
                  done = true;
                  if (m?.ok && typeof onPaired === 'function') onPaired();
                  try { chanClose(chan); } catch (_e) { /* ignore */ }
                },
              });
            // 成功时 data_cb 已处理并断开; 仅失败时兜底断开。
            onDeferSettled(p, () => {
              if (chan) { try { chanClose(chan); } catch (_e) { /* ignore */ } }
            });
          } catch (_e) {
            try { chanClose(chan); } catch (_e2) { /* ignore */ }
          }
        }
        return undefined;
      });
      c.on('close', () => timers.clearTimeout(timer));
    }, () => {
      timers.clearTimeout(timer);
    });
    return {
      get done() { return done; },
      get channel() { return chan; },
      close() {
        timers.clearTimeout(timer);
        if (chan) { try { chanClose(chan); } catch (_e) { /* ignore */ } }
      },
    };
  }

  // 原版 unpair (第 4913-4934 行, api_obj 方法) 的 leave 发送部分:
  // 已认证时先 defer leave, 再删 peer、发 unpaired 事件 (后两步由 api 做)。
  // 返回是否发出了 leave。
  function sendLeave(mn) {
    const p = S.peers[mn];
    if (!p?.authed || !p.chan) return false;
    try {
      fireAndForget(p.chan.defer('leave', {}, {}));
    } catch (_e) { /* ignore */ }
    return true;
  }

  // 停止监听 (测试与 core 关闭时用; 原版进程退出即 procd 重启, 无此路径)。
  function stop() {
    if (udpSocket) {
      const s = udpSocket;
      udpSocket = null;
      try { s.close(); } catch (_e) { /* ignore */ }
    }
    if (tcpServer) {
      const s = tcpServer;
      tcpServer = null;
      try { s.close(); } catch (_e) { /* ignore */ }
    }
  }

  return {
    // 对外接口 (spec §8 模块 2): setupUdp/setupTcp/sendHello/expireTick/
    // sapTick/sapReport/push*To, 另加 aliasBroadcast/startPairing/sendLeave/stop。
    // srvRx/sapRx/connClose/peerLinkDead/apply*ResultUpdate 不对外暴露:
    // 入站分发走通道 handler, 回执更新只在 push 回调内用。
    setupUdp,
    setupTcp,
    sendHello,
    udpSend,
    udpRx,
    expireTick,
    sapTick,
    sapReport,
    sapConnect,
    sapDisconnect,
    aliasBroadcast,
    pushAliasesTo,
    pushRoamTo,
    pushBackhaulTo,
    pushWifiTo,
    pushGuestTo,
    pushOffloadTo,
    startPairing,
    sendLeave,
    stop,
  };
}
