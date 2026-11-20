// core.mjs -- wifiroam 守护进程 JS 重写：core 模块（入口 + 状态 + 主循环）
//
// 对应原版 wifiroamd.uc（5498 行，DAEMON_VERSION=5）的 core 部分，按
// spec.md §8 划分：入口、共享状态 S、主循环、定时器、ubus 对象 `wifiroam`
// 的 31 个方法（api_obj）分发、启动/停止流程。只写 core，不写其他 5 个
// 业务模块，不改 lib/、不改前端、不改底版。
//
// 组装约定（6 个模块统一口径）：
//  - 共享状态 S 由本模块定义并导出 createState()，字段与原版全局变量
//    一一对应（spec §1.2，第 249-302 行），初始值与原版一致。
//  - 每个业务模块导出 createX(ctx) 工厂，ctx = { S, bus, uci, shell,
//    util, store }，返回该模块的函数对象；core 创建 ctx、组装各模块、
//    把模块函数挂进 api_obj 分发。模块之间不许直接 import，只经 ctx
//    回调；discovery 的 push 经注入回调调 apply_*_local。
//  - 业务模块的真实导出（以 daemon/ 下已落地的 5 个模块为准，core 不自造接口）：
//      ./discovery.mjs  createDiscovery(ctx):
//        setupUdp, setupTcp, sendHello, expireTick, sapTick, sapReport,
//        sapConnect, sapDisconnect, aliasBroadcast,
//        pushAliasesTo(mn), pushRoamTo(mn), pushBackhaulTo(mn),
//        pushWifiTo(mn, ssids), pushGuestTo(mn, cfg), pushOffloadTo(mn),
//        startPairing({ip, token, capIp, nonceEcho, onPaired}), sendLeave(mn), stop
//        （peer 通道为 lib/ubus.js 的 UbusChannel 实例；
//         chan.defer(method, data) 为 Promise 形，见 fireDefer）
//      ./clients.mjs  createClients(ctx):
//        aliasLoad, aliasSave, aliasApply(mac, name, icon, note),
//        pinApply(mac, ap), pinOf(mn), deviceKey(v), deviceMembersOf(v),
//        deviceAliasOf(v), deviceUngroup(mn), findClient(key), localClients,
//        buildTopology, devlistLoad, devlistTick, devlistView, devlistLive,
//        deviceGroupRefresh, diffEvents(prev, cur, name), ownerEvents(cur),
//        wolSend(mn), clientNames(), parseLeases(), parseFdb(), detectUplink 经 ctx,
//        banHm/banHmStr/banWeekdays/banRead/banInWindow/banApply/banLoad/banTick，
//        以及 ubus handler：topology/deviceHistory/wake/clientDetail/
//        setAlias/setPin/ungroupDevice/banList/setBan/banSet/banDel
//        （localClients/buildTopology/devlist*/findClient/deviceGroupRefresh
//         是 async，core 凡调一律 await）
//      ./wifi.mjs  createWifi(ctx):
//        detectSelf, selfUptime, selfInfo, currentRoamCfg, currentBackhaulCfg,
//        rssiPreset(profile), roamSig(r), memberList, ssidGroups, appliedKvr(ssids),
//        applyRoamLocal(roam, members), applyBackhaulLocal(bh, role),
//        applyWifiLocal(ssids), wifiSummary, wifiRadios, wifiIfaces,
//        roamRenameSsids(pairs), roamDefaultInit, precheck, apOverview, bssPublic,
//        backhaulTick, steerTick, pinTick
//        （pin_of / pin_apply 的唯一实现在 clients；wifi 只经 ctx.pinOf
//         读固定关系。detectSelf/selfInfo/wirelessUplink/apNrSelf/
//         steerTick/pinTick 是 async）
//      ./guest.mjs  createGuest(ctx):
//        guestCfg, guestSummary, guestSaveLocal(cfg),
//        applyGuestLocal(cfg), guestTick, guestOpenNow, guestPortSync,
//        guestAfterReload, handlePushGuestConfig
//      ./policy.mjs  createPolicy(ctx):
//        appctlLoad, appctlTick, appctlReadDevices, appctlWriteDevice,
//        appctlApp(id), appctlApplyRules, appctlDpiDaemon(action),
//        appctlDnsmasqSync(on), appctlNftSchema, appctlDnslockApply(on),
//        appctlHwSuspend(on), appctlTableRemove,
//        appctlPublicStats, appctlPublicDays(src, online),
//        offloadApply(on), offloadRequestCap(on), offloadStatus, setOffload,
//        以及 ubus handler：appctlStatus/setAppctl/setAppPolicy。
//        （定时断网 ban 不在本模块：唯一实现在 clients，policy 的
//        重复实现已在合拢时裁撤，policy 只经 ctx.banApply 回调 clients）
//    上述工厂名若缺失，createDaemon 会抛错点名模块与导出名。
//  - ubus 连接先于业务模块建立：clients/wifi 在工厂内捕获 ctx.bus
//    （localClients/detectSelf 经它调 hostapd/network 对象），
//    故 createDaemon 先连 ubusd（失败则 log + exit(1)，与原版 main
//    的 fail-fast 一致），再建 ctx、再调各 createX 工厂。
//    注入 modules 的单测缝可不连 ubus（ctx.bus 为 null）。
//  - api_obj 分发优先用业务模块自带的 handler（clients: topology/
//    deviceHistory/wake/clientDetail/setAlias/setPin/ungroupDevice/
//    banList/setBan/banSet/banDel；policy: appctlStatus/setAppctl/
//    setAppPolicy/offloadStatus/setOffload；wifi: precheck），
//    模块缺失时回落到 core 内与原版逐行对齐的实现；status/get_roam/
//    set_roam/get_backhaul/get_wifi/set_wifi/get_guest/set_guest/
//    set_backhaul/discover/pair/unpair/roam_log 由 core 实现
//    （pair 经 discovery.startPairing，unpair 经 discovery.sendLeave）。
//  - ban（定时断网）与 pin（固定 AP）的唯一实现都在 clients：
//    core 的 ban_*Of / ctx.pinOf / ctx.pinApply / ctx.banApply 与
//    ban_list/set_ban/ban_set/ban_del 分发只接 clients；wifi 的 pin
//    实现与 policy 的 ban 实现已在合拢时删掉，不留第二份。
//  - 只用 Node 核心模块，零 npm 依赖；只用 Node 22.23.4 已有的 API
//    （research-node-ubus.md §1.5 禁用清单一条不用）；ESM .mjs。
//  - 定时器：12 个常驻（1 个 5000ms send_hello + 11 个 10000ms tick）
//    + 4 处一次性 timer（pair 的 8000ms 在本模块；其余 3 处在 discovery/
//    guest 模块内）+ 2 个 handle 监听（discovery 的 UDP 50607 / TCP 50608）。
//  - ubus 对象发布走 lib/ubus.js 的 UbusClient.addObject；31 个方法名、
//    参数、返回值形状按 spec §3 一个不少；client_detail 前端无调用，照样实现。
//
// 未等价项（见本文件末尾注释与最终回复，不悄悄改行为）：
//  N1. lib/ubus.js 的 handler 收到的是 req = { method, data, ... }，
//      原版是 req.args；本模块在 ubus 包装层把 req.data 译为 args。
//  N2. 原版 4 处返回 libubus.STATUS_INVALID_ARGUMENT(2) /
//      STATUS_NOT_FOUND(4)（client_detail / set_alias / set_pin /
//      pair / unpair 缺 mac 时）；lib/ubus.js 的 handler 只能回 DATA +
//      STATUS OK（抛错只会得 STATUS UNKNOWN_ERROR=9），发不出 2/4。
//      分发表（buildApiHandlers）仍原样返回整数 2/4；ubus 包装层遇整数
//      结果时不发 DATA，只回 STATUS OK。LuCI 侧等价（safeCall 失败都得
//      null），直接 `ubus call` 的状态码不同。
//  N3. uloop.run() 没有 Node 等价物：Node 事件循环在 intervals /
//      sockets 存活时自然保持进程运行，start() 注册完即返回。
//  N4. 每轮 tick 外包一层 try/catch + log（原版无此保护，ucode 抛错会
//      中断 uloop）；只把“某轮崩溃导致整个守护进程退出”改为“记日志后
//      继续下一轮”，不改变任何一轮的正常行为。

import * as util from '../lib/util.js';
import * as shell from '../lib/shell.js';
import * as store from '../lib/store.js';
import { uci as defaultUci } from '../lib/uci.js';
import { UbusClient, UbusChannel, UBUS_STATUS } from '../lib/ubus.js';

const {
  log, srand, rand, randhex, sha256, nowSeconds, toInt,
  hhmmMinutes, macnorm, maccolon, devnorm,
} = util;
const { cmdOutput } = shell;

export { log, cmdOutput };

// ------------------------------------------------------------------ 常量
// 原版第 20-56 行、第 184-234 行（含中文注释承载的决策，原样保留）。
export const UDP_PORT = 50607;
export const TCP_PORT = 50608;
export const MAGIC = 'WIFIROAM1';
export const ALIAS_DIR = '/etc/wifiroam';
export const ALIAS_PATH = `${ALIAS_DIR}/aliases.json`;
export const PEER_TTL = 30; // s without hello -> offline
export const DISCOVER_TTL = 180; // s unconfigured device stays in discover list
export const HELLO_INTERVAL = 5000;
export const TICK_INTERVAL = 10000;
export const MAX_EVENTS = 100;
export const WIRED_TTL = 300; // s wired client stays listed after last FDB sighting
export const STEER_COOLDOWN = 60; // s 同一终端两次 BSS Transition 引导的最小间隔
export const MIN_STEER_ASSOC = 20; // s 终端入网后至少稳定这么久才允许被引导
export const STEER_KICK_AFTER = 3; // 连续 BTM 引导无果的次数，达到后强制断开让终端重新选 AP
export const STEER_KICK_COOLDOWN = 1800; // s 同一终端两次强制断开的最小间隔
export const PIN_BAN_MS = 120000; // 固定终端连错 AP 时 hostapd 禁入时长（毫秒）
export const PIN_KICK_COOLDOWN = 30; // s 同一终端两次踢回目标 AP 的最小间隔
export const BACKHAUL_SECTION = 'wifiroam_bh';
export const BACKHAUL_DEFAULT_SSID = 'wifiroam-bh';

// 访客网络：每台 AP 各自建一个独立子网 + DHCP + 防火墙隔离区，
// 访客口统一挂到 br-guest（接口名 netifd 限制为 15 字符以内）。
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
// 协议/行为版本：LuCI 侧要求一致，不一致时「重启」会自动 stop+start 修复
export const DAEMON_VERSION = 5;

export const ROAM_KEYS = [
  'ieee80211r', 'mobility_domain', 'ft_over_ds', 'ft_psk_generate_local',
  'nas_identifier', 'pmk_r1_push', 'r0kh', 'r1kh', 'reassociation_deadline',
  'ieee80211k', 'rrm_neighbor_report', 'rrm_beacon_report',
  'ieee80211v', 'bss_transition',
];

// ------------------------------------------------------ app access control
// 内置应用清单。统计准确性优先于域名数量，只收录可归属于对应产品的域名：
// 1) 排除 alicdn.com / byteimg.com 等跨产品、跨厂商共享基础设施；
// 2) 排除 bdstatic / zhimg / pddpic 等会被第三方页面大量嵌入的静态资源域；
// 3) 同一公司的不同产品分开统计，避免把 TikTok、Kwai 等计入国内产品。
// QQ 暂无可覆盖核心聊天流量且不与其他腾讯产品混用的域名，保留空条目仅为
// 兼容和解除旧策略；dnsmasq 不为空条目生成配置，也不会产生新的 QQ 统计。
// dnsmasq 将解析结果写入每应用 IPv4/IPv6 nft set，再按
// (原始终端 MAC, 目标 IP 集合) 统计或封禁，TLS/QUIC SNI DPI 作为封禁兜底。
// cat 用于前端分类展示（对齐 TP-Link 的应用分类）。
export const APP_DEFS = [
  { id: 'wechat', name: '微信', cat: 'social', domains: ['weixin.qq.com', 'wx.qq.com', 'wechat.com'] },
  { id: 'qq', name: 'QQ', cat: 'social', domains: [] },
  { id: 'douyin', name: '抖音', cat: 'video', domains: ['douyin.com', 'douyinvod.com', 'idouyinvod.com', 'douyincdn.com', 'douyinpic.com', 'douyinstatic.com', 'amemv.com', 'iesdouyin.com'],
    // apex 域名多数不可解析，预热时解析具体视频主机补充 CDN 地址池。
    probes: ['www.douyin.com', 'v3-web.douyinvod.com', 'v26-web.douyinvod.com', 'p3-pc-sign.douyinpic.com'] },
  { id: 'tiktok', name: 'TikTok', cat: 'video', domains: ['tiktok.com', 'tiktokv.com', 'tiktokcdn.com', 'tiktok-row.net'] },
  { id: 'kuaishou', name: '快手', cat: 'video', domains: ['kuaishou.com', 'gifshow.com'] },
  // kwaicdn.com 同时服务国内快手与海外 Kwai，不作为任一产品的独占依据。
  { id: 'kwai', name: 'Kwai', cat: 'video', domains: ['kwai.com'] },
  { id: 'bilibili', name: '哔哩哔哩', cat: 'video', domains: ['bilibili.com', 'hdslb.com', 'bilivideo.com', 'biliapi.net'] },
  { id: 'xiaohongshu', name: '小红书', cat: 'social', domains: ['xiaohongshu.com', 'xhscdn.com'] },
  { id: 'weibo', name: '微博', cat: 'social', domains: ['weibo.com', 'weibo.cn'] },
  { id: 'taobao', name: '淘宝/天猫', cat: 'shop', domains: ['taobao.com', 'tmall.com'] },
  { id: 'iqiyi', name: '爱奇艺', cat: 'video', domains: ['iqiyi.com', 'iqiyipic.com', 'qiyi.com'] },
  { id: 'netease_music', name: '网易云音乐', cat: 'music', domains: ['music.163.com', 'music.126.net'] },
  { id: 'youku', name: '优酷', cat: 'video', domains: ['youku.com'] },
  { id: 'mgtv', name: '芒果TV', cat: 'video', domains: ['mgtv.com', 'hitv.com'] },
  { id: 'zhihu', name: '知乎', cat: 'news', domains: ['zhihu.com'] },
  { id: 'toutiao', name: '今日头条', cat: 'news', domains: ['toutiao.com', 'toutiaoapi.com'] },
  { id: 'xigua', name: '西瓜视频', cat: 'video', domains: ['ixigua.com'] },
  { id: 'jd', name: '京东', cat: 'shop', domains: ['jd.com'] },
  { id: 'pinduoduo', name: '拼多多', cat: 'shop', domains: ['pinduoduo.com', 'yangkeduo.com'] },
  { id: 'meituan', name: '美团/大众点评', cat: 'shop', domains: ['meituan.com', 'dianping.com'] },
  { id: 'eleme', name: '饿了么', cat: 'shop', domains: ['ele.me'] },
  { id: 'dingtalk', name: '钉钉', cat: 'office', domains: ['dingtalk.com'] },
  { id: 'feishu', name: '飞书', cat: 'office', domains: ['feishu.cn', 'feishu.net'] },
  { id: 'wps', name: 'WPS', cat: 'office', domains: ['wps.cn', 'wps.com'] },
  { id: 'baidu', name: '百度', cat: 'web', domains: ['baidu.com'] },
  { id: 'ximalaya', name: '喜马拉雅', cat: 'music', domains: ['ximalaya.com'] },
  { id: 'huya', name: '虎牙直播', cat: 'live', domains: ['huya.com'] },
  { id: 'douyu', name: '斗鱼直播', cat: 'live', domains: ['douyu.com', 'douyu.tv'] },
  // 只保留国服原神高置信度服务域名。官网、米游社、HoYoLAB、补丁 CDN
  // 及国际服 CloudFront/Cloudflare 都会与其他服务共用 IP；预热会持续
  // 写入这些共享地址，不能再用于按 IP 的使用统计。
  { id: 'mihoyo', name: '原神/米哈游', cat: 'game', domains: ['dispatchcnglobal.yuanshen.com', 'hk4e-sdk.mihoyo.com', 'hk4e-api.mihoyo.com'] },
  { id: 'kugou', name: '酷狗音乐', cat: 'music', domains: ['kugou.com', 'kugou.net'] },
  { id: 'ctrip', name: '携程', cat: 'web', domains: ['ctrip.com', 'ctrip.cn'] },
  { id: 'rail12306', name: '铁路12306', cat: 'web', domains: ['12306.cn'] },
  { id: 'zuoyebang', name: '作业帮', cat: 'office', domains: ['zuoyebang.com', 'zuoyebang.cc', 'zybang.com'] },
  { id: 'steam', name: 'Steam', cat: 'game', domains: ['steampowered.com', 'steamcommunity.com', 'steamcontent.com'] },
  { id: 'netflix', name: 'Netflix', cat: 'video', domains: ['netflix.com'] },
  { id: 'spotify', name: 'Spotify', cat: 'music', domains: ['spotify.com'] },
  { id: 'bosszhipin', name: 'BOSS直聘', cat: 'office', domains: ['zhipin.com'] },
  // 以下来自商业 IOTD 指纹库，仅保留已核实可解析、能独立归属于
  // 对应 IoT 云服务的域名；共享 CDN、公共云入口和宽泛域名不收录。
  { id: 'mijia', name: '米家', cat: 'iot', domains: ['api.io.mi.com', 'ot.io.mi.com'] },
  { id: 'aqara', name: 'Aqara', cat: 'iot', domains: ['aiot-coap.aqara.cn', 'aiot-coap-usa.aqara.com', 'usa.aqara.com'] },
  { id: 'arlo', name: 'Arlo', cat: 'iot', domains: ['deviceapi.messaging.arlo.com'] },
  { id: 'philips_hue', name: 'Philips Hue', cat: 'iot', domains: ['diagnostics.meethue.com'] },
  { id: 'eufy', name: 'eufy', cat: 'iot', domains: ['security-app.eufylife.com'] },
  { id: 'dlink', name: 'D-Link', cat: 'iot', domains: ['api.fota.dlink.com', 'auto.mydlink.com'] },
  { id: 'xiaoyi', name: '小蚁', cat: 'iot', domains: ['api.us.xiaoyi.com', 'log.xiaoyi.com'] },
  { id: 'netatmo', name: 'Netatmo', cat: 'iot', domains: ['netatmo.net'] },
  { id: 'withings', name: 'Withings', cat: 'iot', domains: ['ws.withings.net'] },
  { id: 'roku', name: 'Roku', cat: 'iot', domains: ['ravm.tv', 'rokutime.com'] },
];

// 活跃判定阈值：一个采样窗口内只有零星心跳包（推送、SDK 保活）不算「在使用」。
// 之前只要包数有增长就累计整个窗口，导致「装了没开」的 App 也显示大量时长。
export const APP_ACT_MIN_PK = 3; // 窗口内包数下限
export const APP_ACT_MIN_BYTES = 2048; // 窗口内字节下限
export const APP_SET_TIMEOUT = '12h'; // DNS 集合元素有效期，防止旧 IP 被复用时误计

/* 精准识别模式（高级设置里的开关，关闭时保持上面这套宽松口径）：
   - 活跃判定更严：包数与字节必须同时达标（且关系），锁屏心跳不再计时长；
   - 集合超时缩短到 30m：CDN 回收/复用 IP 后更快退出归属。命中刷新不受
     内核支持（实测 Not supported），靠 dnsmasq 重复解析自然续期；
   - DNS 出口锁定：53 重定向到本机 dnsmasq、拦 DoT(853) 与知名公共 DoH，
     防止 App 用内置 HTTPDNS/私有 DNS 绕过识别。
   DoH 清单只收纯 DNS 服务商地址（Cloudflare 1.1.1.1 同时承载网页服务，
   为避免误伤不收录）。 */
export const APP_ACT_ENH_PK = 5;
export const APP_ACT_ENH_BYTES = 4096;
export const APP_SET_TIMEOUT_ENH = '30m';
export const APP_DOH_V4 = ['8.8.8.8', '8.8.4.4', '9.9.9.9', '149.112.112.112',
  '223.5.5.5', '223.6.6.6', '119.29.29.29', '180.76.76.76',
  '114.114.114.114', '114.114.115.115'];
export const APP_DOH_V6 = ['2001:4860:4860::8888', '2001:4860:4860::8844',
  '2620:fe::fe', '2620:fe::9', '2400:3200::1', '2400:3200:baba::1',
  '2402:4e00::'];

// 终端历史：记录每个终端（按设备组去重）的首次发现、最后在线、最后离线时间。
// 用途：1) 终端设备页展示在线状态与上下线时间；2) 网络唤醒白名单——只允许
// 唤醒曾经在线过的设备，避免把任意 MAC 当作放大器发广播。
export const DEVICES_PATH = `${ALIAS_DIR}/devices.json`;
export const DEVICES_MAX = 512; // 保存的历史设备上限（超出的最久未上线记录被淘汰）
export const DEVICES_FLUSH = 60; // s：历史落盘最小间隔，避免每次 tick 都写 flash

export const APPCTL_TABLE = 'wifiroam';
export const APPCTL_NFT_FILE = '/tmp/wifiroam-appctl.nft';
export const APPSTATS_PATH = `${ALIAS_DIR}/appstats.json`;
export const APPCTL_SCHEMA_PATH = `${ALIAS_DIR}/nft_schema`;
export const APPSTATS_FLUSH = 15; // s：统计落盘的最小间隔（重启最多丢这一轮）

// DPI（深度包检测）：把每个新建连接的首包送到 wifiroam-dpi 守护进程，
// 解析 TLS SNI / QUIC SNI，命中被禁应用域名即 drop。兜底 DNS/IP 集合方案
// 无法覆盖的 HTTPDNS 直连与 P2P 流量。blocklist 由本进程写，dpi 读。
export const DPI_QUEUE = 0;
export const DPI_BLOCKLIST = '/tmp/wifiroam/dpi_blocklist';
export const DPI_DAEMON = '/usr/sbin/wifiroam-dpi';
export const DPI_PIDFILE = '/tmp/wifiroam-dpi.pid';

// 定时断网（上网时间）：按终端 MAC + 时间段 + 星期，在 CAP 的 forward 链
// 丢弃该终端的转发流量。用独立 nft 表，避免与应用管控的规则重建互相干扰；
// 是否生效由守护进程每个 tick 计算，不依赖内核 time 模块（跨午夜/星期判定
// 更直观，也不受内核时区与模块裁剪影响）。
export const BAN_TABLE = 'wifiroam_ban';
export const BAN_NFT_FILE = '/tmp/wifiroam-ban.nft';
export const BAN_DEFAULT_ON = '22:00';
export const BAN_DEFAULT_OFF = '07:00';

// ------------------------------------------------------------------ 状态
// 原版第 249-302 行 state 单例，字段名逐字照抄，初始值一致。
export function createState() {
  return {
    cfg: {}, // uci wifiroam
    self: {}, // self system info
    brdev: 'br-lan',
    peers: {}, // macnorm -> AP peer (hello + report merged)
    discovered: {}, // macnorm -> unconfigured device seen
    aliases: { ver: 0, map: {}, groups: {}, redirect: {}, isolated: {}, pin: {} },
    pin_last: {}, // macnorm -> 上一次因固定 AP 被踢回的时刻
    devices: {}, // 设备组 ID -> 终端历史 { mac, ip, hostname, first_seen,
    //   last_online, last_offline, online, ap, conn }
    dev_dirty: false, // 历史是否有未落盘的变更
    dev_saved: 0, // 上次落盘时刻
    device_index: {}, // 原始 MAC -> 稳定设备组 ID
    device_obs: {}, // 本轮运行期观察到的主机名、租约与在线证据
    link: null, // SAP: outgoing channel to CAP {sock,chan,authed}
    cap_learned: null, // CAP ip learned from hello
    events: [], // ring buffer
    last_apply: null, // last roam push result summary
    last_backhaul: null, // last wireless-backhaul push result summary
    _bh: {}, // 回程运行时状态（relay pid/计时/DHCP 恢复记录，见 wifi.mjs bhState）
    last_wifi: null, // last Wi-Fi rename push result summary
    last_guest: null, // last guest-network push result summary
    guest_open: null, // 访客网络当前是否在开放时段内（null = 未知）
    guest_tc_sig: '', // 访客限速 tc 规则的签名，避免每次 tick 重建
    guest_tc_devs: [], // 已挂了 qdisc 的访客 netdev（桥不参与桥转发路径，必须挂到 vif）
    _guest_nft_sig: '', // 访客 nft 表（隔离 + 子AP SNAT）的签名，避免每轮重建
    _guest_zone_migrated: false, // 访客区是否已从 option network 迁移到 device+subnet
    client_seen: {}, // macnorm -> first seen ts
    client_bytes: {}, // macnorm -> 站点字节计数采样 { ts, rx, tx }（算实时速率）
    bytes_cache: {}, // ifname -> { ts, map }：1s 内复用，避免同一轮重复调用 iw
    prev_clients: null, // for join/leave event diffing; null = 首轮扫描不产事件
    wired_seen: {}, // macnorm -> 最后一次出现在 FDB 的时间（有线存活依据+防抖）
    wifi_seen: {}, // macnorm -> 最后一次作为无线站点出现的时间（防止被 FDB 误判为有线）
    prev_owner: null, // CAP 视角 macnorm -> 归属 AP（跨 AP 迁移事件；null = 首轮抑制）
    roam_ver_applied: 0,
    backhaul_ver_applied: 0,
    steer_last: {}, // macnorm -> 上次 BSS Transition 引导时间
    steer_tries: {}, // macnorm -> 连续引导仍未换 AP 的次数
    kick_last: {}, // macnorm -> 上次强制断开的时间
    steer_mute: {}, // macnorm -> 该时间前不再强制断开（被踢后仍回到原 AP 说明附近没有更好的 AP）
    nr_sig: '', // 本机已下发的 11k 邻居表签名
    cap_nr: [], // SAP: CAP 下发的 11k 邻居元素
    net_names: {}, // SAP: CAP 下发的 macnorm -> { hostname, ip }（SAP 无 DHCP，名称需由 CAP 提供）
    roster: null, // SAP: CAP 下发的全网络 AP/SSID 概览（用于开启前检查一致展示）
    appctl: { enabled: false, enhanced: false, strict: false, devices: {}, stats: {}, day: '', online: {}, ndata: {} },
    ban: { enabled: false, list: [], sig: '', active: {} }, // 独立全局开关、定时规则与当前生效集合
    _nft_snap: null, // CAP: 上次 nft 计数快照 { "<mac>|<app>": { pk, by } }
    _dnslock_on: null, // CAP: DNS 出口锁定链当前状态（null = 未同步，首轮强制对齐）
    _appstat_ts: 0, // CAP: 上次采样时刻
    _appstat_dirty: false,
    _appstat_saved: 0,
    _track_key: '', // CAP: 上次建规则时的终端集合签名
    _warm_list: null, // CAP: 预热用的域名/主机名清单（扁平化）
    _warm_i: 0, // CAP: 下次预热哪个
  };
}

// ucode localtime(time()) 的最小等价物：ban_list / ban_in_window 用。
// wday: 0=周日（JS Date.getDay()），与原版 localtime 的 wday 一致。
export function localtimeNow(d = new Date()) {
  return {
    hour: d.getHours(), min: d.getMinutes(), sec: d.getSeconds(),
    wday: d.getDay(), year: d.getFullYear(), mon: d.getMonth() + 1, mday: d.getDate(),
  };
}

// ------------------------------------------------------------------ 小工具
// fire-and-forget 的通道 defer：原版 defer 带空 data_cb / cb，异步失败
// 也无动作；但同步抛错要透传给调用方（set_alias/set_pin 的 try/catch
// 靠它判 link_down）。lib 形为 chan.defer(method, data) -> Promise。
export function fireDefer(chan, method, data) {
  const r = chan.defer(method, data);
  if (r && typeof r.catch === 'function') r.catch(() => {});
}

// ------------------------------------------------------------------ core 函数
// 以下函数均以 (S, deps) 显式取状态与依赖，便于单测注入；daemon 对象
// 再把它们绑成无参/少参方法。函数体按原版逐行翻译。

export function loadConfig(S, uciClient) {
  uciClient.load('wifiroam');
  S.cfg = {
    enabled: uciClient.get('wifiroam', 'core', 'enabled') !== '0',
    role: uciClient.get('wifiroam', 'core', 'role') ?? 'unconfigured',
    token: uciClient.get('wifiroam', 'core', 'token') ?? '',
    cap_ip: uciClient.get('wifiroam', 'core', 'cap_ip') ?? '',
    name: uciClient.get('wifiroam', 'core', 'name') ?? '',
  };
  S.roam_ver_applied = toInt(uciClient.get('wifiroam', 'roam', 'config_ver') ?? '0');
  S.backhaul_ver_applied = toInt(uciClient.get('wifiroam', 'backhaul', 'config_ver') ?? '0');
  const aver = toInt(uciClient.get('wifiroam', 'alias_sync', 'ver') ?? '0');
  if (aver > S.aliases.ver) S.aliases.ver = aver;
}

export function saveConfig(S, uciClient) {
  uciClient.load('wifiroam');
  uciClient.set('wifiroam', 'core', 'role', S.cfg.role);
  uciClient.set('wifiroam', 'core', 'token', S.cfg.token);
  uciClient.set('wifiroam', 'core', 'cap_ip', S.cfg.cap_ip);
  uciClient.set('wifiroam', 'core', 'name', S.cfg.name);
  uciClient.commit('wifiroam');
}

export function pushEvent(S, type, mac, info, name) {
  S.events.push({ ts: nowSeconds(), type, mac: mac ?? '', name: name ?? '', info: info ?? '' });
  if (S.events.length > MAX_EVENTS) S.events = S.events.slice(S.events.length - MAX_EVENTS);
  log(`event ${type} ${mac ?? '-'} ${name ?? '-'} ${info ?? ''}`);
}

export function ensureToken(S, saveConfigFn) {
  if (S.cfg.role === 'cap' && S.cfg.token === '') {
    S.cfg.token = sha256(`wifiroam-${nowSeconds()}-${rand()}-${S.self.mac}`);
    saveConfigFn();
    log('generated new network token');
  }
}

export function reconfigure(S, deps) {
  loadConfig(S, deps.uci);
  S.self.name = S.cfg.name !== '' ? S.cfg.name : S.self.hostname;
  deps.modules.discovery.sapDisconnect();
  S.peers = {};
  S.cap_learned = null;
  S.prev_clients = null;
  S.wired_seen = {};
  S.wifi_seen = {};
  S.prev_owner = null;
  S.steer_last = {};
  S.steer_tries = {};
  S.kick_last = {};
  S.steer_mute = {};
  S.nr_sig = '';
  S.cap_nr = [];
  deps.modules.discovery.sendHello();
  // 角色/网段变化后重新评估定时断网（例如从 SAP 提升为 CAP）
  // ban 的唯一实现在 clients。
  banApplyOf(deps.modules, true);
}

// 插件启用后按默认设置开启漫游：首次启动（从未保存过漫游配置）时，
// 自动选中本机全部主网络 SSID，并按默认 k/v/r 参数下发一次。
// 注意：ucode 的函数声明不做提升，本函数必须定义在 wifi_ifaces /
// member_list / apply_roam_local / applied_kvr 之后。
export function roamDefaultInit(S, deps) {
  const { uci, modules } = deps;
  uci.load('wifiroam');
  if (toInt(uci.get('wifiroam', 'roam', 'config_ver') ?? '0') !== 0) return;
  if (uci.get('wifiroam', 'roam', 'enabled') !== '1') return;

  const raw = uci.get('wifiroam', 'roam', 'ssids');
  if (Array.isArray(raw) ? raw.length > 0 : (raw ?? '') !== '') return;

  const ssids = [];
  for (const w of modules.wifi.wifiIfaces()) {
    if (w.ssid !== '' && !ssids.includes(w.ssid)) ssids.push(w.ssid);
  }
  if (!ssids.length) return;

  uci.set('wifiroam', 'roam', 'ssids', ssids);
  uci.set('wifiroam', 'roam', 'config_ver', '1');
  uci.commit('wifiroam');

  const roam = modules.wifi.currentRoamCfg();
  modules.wifi.applyRoamLocal(roam, modules.wifi.memberList());
  S.last_apply = {
    ts: nowSeconds(), ver: roam.config_ver,
    results: [{ ap: S.self.mac, name: S.self.name,
      ok: true, ver: roam.config_ver,
      kvr: modules.wifi.appliedKvr(roam.ssids) }],
  };
  log(`roam defaults enabled for ${ssids.length} SSID(s)`);
}

// ban 的唯一实现在 clients（policy 的重复实现已裁撤），只接 clients。
export function banApplyOf(modules, force) {
  const fn = modules.clients?.banApply;
  if (typeof fn !== 'function') throw new TypeError('core: no banApply in clients module');
  return fn(force);
}
export function banReloadEnabledOf(modules) {
  const fn = modules.clients?.banReloadEnabled;
  if (typeof fn !== 'function') throw new TypeError('core: no banReloadEnabled in clients module');
  return fn();
}
export function banLoadOf(modules) {
  const fn = modules.clients?.banLoad;
  if (typeof fn !== 'function') throw new TypeError('core: no banLoad in clients module');
  return fn();
}
export function banTickOf(modules) {
  const fn = modules.clients?.banTick;
  if (typeof fn !== 'function') throw new TypeError('core: no banTick in clients module');
  return fn();
}

// 第 12 个常驻 tick（原版 main 里匿名函数）：仅 CAP，本机终端
// join/leave 与跨 AP 迁移事件。
// clients.localClients 是 async，凡调一律 await。
export async function capTick(S, modules) {
  if (S.cfg.role !== 'cap') return;
  const cur = await modules.clients.localClients();
  if (S.prev_clients !== null) modules.clients.diffEvents(S.prev_clients, cur, S.self.name);
  S.prev_clients = cur;
  modules.clients.ownerEvents(cur);
}

// ------------------------------------------------------------------ api_obj
// 31 个 ubus 方法，按原版 api_obj（第 4392-5196 行）顺序。分发表函数取
// args（已由 ubus 包装层从 req.data 译出），返回对象，或返回整数 ubus
// 状态码（INVALID_ARGUMENT=2 / NOT_FOUND=4，见文件头 N2）。
// 每个方法只调本文件头约定的模块接口，不直接碰其他模块的内部状态。

export const API_METHODS = [
  'status', 'topology', 'device_history', 'wake', 'client_detail',
  'set_alias', 'set_pin', 'ungroup_device', 'set_role', 'get_roam',
  'set_roam', 'precheck', 'get_backhaul', 'get_wifi', 'set_wifi',
  'get_guest', 'set_guest', 'set_backhaul', 'discover', 'pair',
  'unpair', 'roam_log', 'appctl_status', 'ban_list', 'set_ban',
  'ban_set', 'ban_del', 'offload_status', 'set_offload', 'set_appctl',
  'set_app_policy',
];

// addObject 用的参数签名（类型名按 lib/ubus.js SIGNATURE_TYPE_CODES）。
export const API_ARGS = {
  status: { ubus_rpc_session: 'string' },
  topology: { ubus_rpc_session: 'string' },
  device_history: { ubus_rpc_session: 'string' },
  wake: { ubus_rpc_session: 'string', mac: 'string' },
  client_detail: { ubus_rpc_session: 'string', mac: 'string' },
  set_alias: { ubus_rpc_session: 'string', mac: 'string', name: 'string', icon: 'string', note: 'string' },
  set_pin: { ubus_rpc_session: 'string', mac: 'string', ap: 'string' },
  ungroup_device: { ubus_rpc_session: 'string', mac: 'string' },
  set_role: { ubus_rpc_session: 'string', role: 'string' },
  get_roam: { ubus_rpc_session: 'string' },
  set_roam: { ubus_rpc_session: 'string', enabled: 'bool', ssids: 'array', r_fast: 'bool', ft_mode: 'string', ft_over_ds: 'bool', k_neighbor: 'bool', k_beacon: 'bool', v_bss_transition: 'bool', rssi_profile: 'string', rssi_threshold: 'int' },
  precheck: { ubus_rpc_session: 'string' },
  get_backhaul: { ubus_rpc_session: 'string' },
  get_wifi: { ubus_rpc_session: 'string' },
  set_wifi: { ubus_rpc_session: 'string', unified: 'bool', ifaces: 'array' },
  get_guest: { ubus_rpc_session: 'string' },
  set_guest: { ubus_rpc_session: 'string', enabled: 'bool', ssid: 'string', key: 'string', bandwidth: 'int', schedule: 'bool', start: 'string', end: 'string', allow_lan: 'bool', open: 'bool' },
  set_backhaul: { ubus_rpc_session: 'string', enabled: 'bool', ssid: 'string', key: 'string', device: 'string', mode: 'string' },
  discover: { ubus_rpc_session: 'string' },
  pair: { ubus_rpc_session: 'string', mac: 'string' },
  unpair: { ubus_rpc_session: 'string', mac: 'string' },
  roam_log: { ubus_rpc_session: 'string', limit: 'int' },
  appctl_status: { ubus_rpc_session: 'string' },
  ban_list: { ubus_rpc_session: 'string' },
  set_ban: { ubus_rpc_session: 'string', enabled: 'bool' },
  ban_set: { ubus_rpc_session: 'string', mac: 'string', name: 'string', timeon: 'string', timeoff: 'string', weekdays: 'string' },
  ban_del: { ubus_rpc_session: 'string', mac: 'string' },
  offload_status: { ubus_rpc_session: 'string' },
  set_offload: { ubus_rpc_session: 'string', enabled: 'bool' },
  set_appctl: { ubus_rpc_session: 'string', enabled: 'bool', enhanced: 'bool', strict: 'string' },
  set_app_policy: { ubus_rpc_session: 'string', mac: 'string', app: 'string', action: 'string' },
};

export function buildApiHandlers(daemon) {
  const { S, modules, uci } = daemon;
  const { discovery, clients, wifi, guest, policy } = modules;
  // ban 读路径：唯一实现在 clients（policy 的重复实现已裁撤）。
  const banMod = clients;
  const saveCfg = () => saveConfig(S, uci);
  const ensureTok = () => ensureToken(S, saveCfg);
  const reconf = () => reconfigure(S, daemon);
  const roamInit = () => roamDefaultInit(S, daemon);

  const coreHandlers = {
    async status() {
      let online = 0; let nclients = 0; const deviceSet = {};
      for (const [mn, p] of Object.entries(S.peers)) {
        if (p.authed) online++;
        for (const cmn of Object.keys(p.clients ?? {})) deviceSet[clients.deviceKey(cmn)] = true;
      }
      for (const cmn of Object.keys(await clients.localClients())) deviceSet[clients.deviceKey(cmn)] = true;
      nclients = Object.keys(deviceSet).length;
      // SAP 以 CAP 下发的概览为准，成员 AP 计数与主AP保持一致
      let peersTotal = Object.keys(S.peers).length;
      if (S.cfg.role === 'sap' && Array.isArray(S.roster?.aps)) {
        let o = 0; let t = 0;
        const selfMn = macnorm(S.self.mac);
        for (const a of S.roster.aps) {
          if (a.id === selfMn) continue;
          t++;
          if (a.online) o++;
        }
        online = o; peersTotal = t;
      }
      const roam = wifi.currentRoamCfg();
      return {
        version: DAEMON_VERSION,
        daemon_started: daemon.daemonStarted,
        kvr: wifi.appliedKvr(roam.ssids),
        role: S.cfg.role, name: S.self.name,
        mac: S.self.mac, ip: S.self.ip,
        cap_ip: S.cfg.cap_ip !== '' ? S.cfg.cap_ip : S.cap_learned,
        model: S.self.model, firmware: S.self.firmware,
        uptime: wifi.selfUptime(),
        peers_online: online, peers_total: peersTotal,
        clients_total: nclients,
        roam,
        backhaul: wifi.currentBackhaulCfg(),
        alias_ver: S.aliases.ver,
        last_apply: S.last_apply,
        last_backhaul: S.last_backhaul,
      };
    },

    topology() { return clients.buildTopology(); },

    // 终端历史（含已离线设备）：设备页卡片与网络唤醒的数据源
    device_history() { return clients.devlistView(); },

    wake(args) {
      let key = clients.deviceKey(args.mac ?? '');
      if (!S.devices[key]) {
        key = macnorm(args.mac ?? '');
        if (!S.devices[key]) return { ok: false, error: 'unknown_device' };
      }
      // 只唤醒曾经在线过的设备（历史白名单），在线设备直接拒绝
      if (S.devices[key].online) return { ok: false, error: 'already_online' };
      const members = clients.deviceMembersOf(key);
      if (!members.length) return { ok: false, error: 'invalid_mac' };
      let sent = 0;
      for (const mn of members) if (mn.length === 12) sent += clients.wolSend(mn);
      if (!sent) return { ok: false, error: 'send_failed' };
      return { ok: true, sent, mac: maccolon(members[0]) };
    },

    async client_detail(args) {
      const mac = args.mac;
      if (!mac) return UBUS_STATUS.INVALID_ARGUMENT;
      const r = await clients.findClient(devnorm(mac));
      if (!r) return UBUS_STATUS.NOT_FOUND;
      return { ok: true, client: r.node, ap: r.ap };
    },

    set_alias(args) {
      const a = args;
      if (!a.mac) return UBUS_STATUS.INVALID_ARGUMENT;
      if (S.cfg.role === 'sap' && S.link?.authed) {
        // forward to CAP; CAP broadcasts the new alias table
        try {
          fireDefer(S.link.chan, 'alias_update', { mac: a.mac, name: a.name, icon: a.icon, note: a.note });
        } catch (_e) {
          discovery.sapDisconnect();
          return { ok: false, error: 'link_down' };
        }
        return { ok: true, forwarded: true };
      }
      if (!clients.aliasApply(a.mac, a.name, a.icon, a.note)) return { ok: false, error: 'invalid_mac' };
      discovery.aliasBroadcast();
      return { ok: true, ver: S.aliases.ver };
    },

    set_pin(args) {
      const a = args;
      if (!a.mac) return UBUS_STATUS.INVALID_ARGUMENT;
      // SAP 侧改动同样交给 CAP 统一保存并广播，避免各 AP 记录不一致
      if (S.cfg.role === 'sap' && S.link?.authed) {
        try {
          fireDefer(S.link.chan, 'pin_update', { mac: a.mac, ap: a.ap ?? '' });
        } catch (_e) {
          discovery.sapDisconnect();
          return { ok: false, error: 'link_down' };
        }
        return { ok: true, forwarded: true };
      }
      const r = clients.pinApply(a.mac, a.ap ?? '');
      if (r.ok) discovery.aliasBroadcast();
      return r;
    },

    async ungroup_device(args) {
      if (S.cfg.role !== 'cap') return { ok: false, error: 'not_cap' };
      const mn = macnorm(args.mac ?? '');
      if (mn.length !== 12) return { ok: false, error: 'invalid_mac' };
      const r = clients.deviceUngroup(mn);
      if (r.ok) {
        policy.appctlReadDevices();
        if (S.appctl.enabled) {
          await policy.appctlApplyRules();
          policy.appctlDpiDaemon('reload');
        }
        banApplyOf(modules, true);
      }
      return r;
    },

    set_role(args) {
      const r = args.role;
      if (!['cap', 'sap', 'unconfigured'].includes(r)) return UBUS_STATUS.INVALID_ARGUMENT;
      if (r === 'sap') return { ok: false, error: 'sap_via_pairing' };
      S.cfg.role = r;
      if (r === 'cap') ensureTok();
      if (r === 'unconfigured') {
        S.cfg.token = '';
        S.cfg.cap_ip = '';
      }
      saveCfg();
      if (r === 'cap') roamInit();
      reconf();
      return { ok: true, role: r };
    },

    get_roam() {
      // SAP 侧用 CAP 下发的全网络概览，避免 SSID 组 AP 数量与成员列表
      // 只看到本机（显示 1 台）而与主AP不一致
      const useRoster = (S.cfg.role === 'sap' && S.roster?.groups);
      let members = wifi.memberList();
      if (useRoster && Array.isArray(S.roster.aps)) {
        members = [];
        for (const a of S.roster.aps) members.push({ mac: maccolon(a.id), name: a.name ?? a.id });
      }
      const roam = wifi.currentRoamCfg();
      return {
        roam,
        groups: useRoster ? S.roster.groups : wifi.ssidGroups(),
        members,
        kvr: wifi.appliedKvr(roam.ssids),
      };
    },

    set_roam(args) {
      const a = args;
      if (S.cfg.role !== 'cap') return { ok: false, error: 'not_cap' };
      let profile = a.rssi_profile ?? 'balanced';
      if (!['aggressive', 'balanced', 'conservative', 'custom'].includes(profile)) profile = 'balanced';
      let threshold = toInt(a.rssi_threshold ?? 0);
      if (profile !== 'custom' || threshold === 0) threshold = wifi.rssiPreset(profile);
      if (threshold > -30) threshold = -30;
      if (threshold < -95) threshold = -95;
      uci.load('wifiroam');
      const ver = toInt(uci.get('wifiroam', 'roam', 'config_ver') ?? '0') + 1;
      uci.set('wifiroam', 'roam', 'enabled', a.enabled ? '1' : '0');
      uci.set('wifiroam', 'roam', 'ssids', a.ssids ?? []);
      uci.set('wifiroam', 'roam', 'r_fast', a.r_fast ? '1' : '0');
      uci.set('wifiroam', 'roam', 'ft_mode', a.ft_mode === 'explicit' ? 'explicit' : 'simple');
      uci.set('wifiroam', 'roam', 'ft_over_ds', a.ft_over_ds ? '1' : '0');
      uci.set('wifiroam', 'roam', 'k_neighbor', a.k_neighbor ? '1' : '0');
      uci.set('wifiroam', 'roam', 'k_beacon', a.k_beacon ? '1' : '0');
      uci.set('wifiroam', 'roam', 'v_bss_transition', a.v_bss_transition ? '1' : '0');
      uci.set('wifiroam', 'roam', 'rssi_profile', profile);
      uci.set('wifiroam', 'roam', 'rssi_threshold', String(threshold));
      uci.set('wifiroam', 'roam', 'config_ver', String(ver));
      uci.commit('wifiroam');

      const roam = wifi.currentRoamCfg();
      const members = wifi.memberList();
      const results = [];
      const lr = wifi.applyRoamLocal(roam, members);
      results.push({ ap: S.self.mac, name: S.self.name, ok: lr.ok, ver: lr.ver, kvr: wifi.appliedKvr(roam.ssids) });
      // 先落 last_apply，再推送，才能收集到各 SAP 的异步回执
      S.last_apply = { ts: nowSeconds(), ver, results };
      for (const [mn, p] of Object.entries(S.peers)) {
        if (!p.authed) continue;
        results.push({ ap: p.mac ?? maccolon(mn), name: p.info?.name ?? p.name ?? mn, ok: null, error: 'pending' });
        discovery.pushRoamTo(mn);
      }
      return { ok: true, ver, results };
    },

    precheck() { return wifi.precheck(); },

    get_backhaul() {
      return {
        backhaul: wifi.currentBackhaulCfg(),
        radios: wifi.wifiRadios(),
        self: { mac: S.self.mac, name: S.self.name },
      };
    },

    // 「无线设置」：读取本机 SSID / 密码状态（SAP 上也返回本机值，仅展示）
    get_wifi() {
      const s = wifi.wifiSummary();
      s.role = S.cfg.role;
      s.last = S.last_wifi ?? null;
      return s;
    },

    // 改名 / 改密码：主AP 生效后同步到所有已配对 AP。
    // ifaces = [{ band, ssid, key }]：每个频段一个名称/密码（多频合一时各项相同）
    set_wifi(args) {
      if (S.cfg.role !== 'cap') return { ok: false, error: 'not_cap' };
      const list = args.ifaces;
      if (!Array.isArray(list) || list.length < 1) return { ok: false, error: 'ssid_invalid' };

      const ssids = [];
      for (const it of list) {
        const ssid = (it.ssid ?? '').trim();
        const key = it.key ?? '';
        if (ssid.length < 1 || ssid.length > 32) return { ok: false, error: 'ssid_invalid' };
        // WPA2/WPA3 的口令为 8-63 字符；64 位十六进制也接受（原始 PSK）
        if (key !== '' && (key.length < 8 || key.length > 64)) return { ok: false, error: 'key_invalid' };
        ssids.push({ band: it.band ?? '?', ssid, key });
      }

      // 多频合一且密码留空：沿用现有密码复制到所有频段，避免只合一名称
      if (args.unified) {
        uci.load('wireless');
        let common = '';
        uci.foreach('wireless', 'wifi-iface', (sec) => {
          if (common !== '') return;
          if (sec.mode && sec.mode !== 'ap') return;
          if (sec.wifiroam_guest === '1') return;
          if (sec.key != null && sec.key !== '') common = sec.key;
        });
        if (common !== '') for (const it of ssids) if (it.key === '') it.key = common;
      }

      // 漫游组记录里的 SSID 跟随改名（两频段同名时按频段逐条映射）
      const pairs = [];
      for (const it of wifi.wifiSummary().ifaces) {
        for (const s of ssids) if (s.band === it.band) pairs.push({ old: it.ssid, new: s.ssid });
      }
      wifi.roamRenameSsids(pairs);

      const lr = wifi.applyWifiLocal(ssids);

      const results = [{ ap: S.self.mac, name: S.self.name, ok: lr.ok, error: lr.ok ? null : 'no_ap_iface' }];
      for (const [mn, p] of Object.entries(S.peers)) {
        if (!p.authed) continue;
        results.push({ ap: p.mac ?? maccolon(mn), name: p.info?.name ?? p.name ?? mn, ok: null, error: 'pending' });
        discovery.pushWifiTo(mn, ssids);
      }
      S.last_wifi = { ts: nowSeconds(), ssids, results };
      return { ok: lr.ok, results };
    },

    // 访客网络：读取本机配置（SAP 上也返回本机值）
    get_guest() { return guest.guestSummary(); },

    // 保存访客网络：主AP 生效后同步到所有已配对 AP
    set_guest(args) {
      if (S.cfg.role !== 'cap') return { ok: false, error: 'not_cap' };
      const a = args;
      const prev = guest.guestCfg();
      const enabled = a.enabled ? true : false;
      const ssid = (a.ssid ?? '').trim();
      let key = a.key ?? '';
      // 开放网络（无密码）：显式标记，避免和「留空沿用旧密码」混淆
      const openNet = a.open ? true : false;

      if (openNet) key = '';
      else if (key === '') key = prev.key;

      if (enabled) {
        if (ssid.length < 1 || ssid.length > 32) return { ok: false, error: 'ssid_invalid' };
        if (!openNet) {
          // 密码留空沿用旧密码，密码框只改名称时不必重输
          if (key === '') return { ok: false, error: 'key_invalid' };
          if (key.length < 8 || key.length > 64) return { ok: false, error: 'key_invalid' };
        }
      }
      if (key !== '' && (key.length < 8 || key.length > 64)) return { ok: false, error: 'key_invalid' };

      const start = (a.start ?? prev.start).trim();
      const end = (a.end ?? prev.end).trim();
      if (hhmmMinutes(start) == null || hhmmMinutes(end) == null) return { ok: false, error: 'time_invalid' };

      let bandwidth = toInt(a.bandwidth ?? 0);
      if (bandwidth < 0) bandwidth = 0;
      if (bandwidth > 1000) bandwidth = 1000;

      const cfg = {
        enabled,
        ssid: ssid !== '' ? ssid : prev.ssid,
        key,
        bandwidth,
        schedule: a.schedule ? true : false,
        start, end,
        allow_lan: a.allow_lan ? true : false,
        ver: prev.ver + 1,
      };

      if (!guest.guestSaveLocal(cfg)) return { ok: false, error: 'invalid' };
      const lr = guest.applyGuestLocal(guest.guestCfg());

      const results = [{ ap: S.self.mac, name: S.self.name, ok: lr.ok, error: lr.ok ? null : 'invalid' }];
      for (const [mn, p] of Object.entries(S.peers)) {
        if (!p.authed) continue;
        results.push({ ap: p.mac ?? maccolon(mn), name: p.info?.name ?? p.name ?? mn, ok: null, error: 'pending' });
        discovery.pushGuestTo(mn, cfg);
      }
      S.last_guest = { ts: nowSeconds(), config: cfg, results };
      return { ok: lr.ok, results };
    },

    set_backhaul(args) {
      const a = args;
      if (S.cfg.role !== 'cap') return { ok: false, error: 'not_cap' };
      const prev = wifi.currentBackhaulCfg();
      const ssid = (a.ssid ?? '') !== '' ? a.ssid : BACKHAUL_DEFAULT_SSID;
      let key = a.key ?? '';
      if (key === '' && a.enabled) key = prev.key !== '' ? prev.key : randhex(16);
      const ver = (prev.config_ver ?? 0) + 1;

      uci.load('wifiroam');
      uci.set('wifiroam', 'backhaul', 'enabled', a.enabled ? '1' : '0');
      uci.set('wifiroam', 'backhaul', 'ssid', ssid);
      uci.set('wifiroam', 'backhaul', 'key', key);
      uci.set('wifiroam', 'backhaul', 'device', a.device ?? '');
      // mode 缺省时沿用当前值：老前端不带这个字段，不能让回程被悄悄改成 relay
      uci.set('wifiroam', 'backhaul', 'mode',
        wifi.backhaulMode(a.mode ?? prev.mode ?? ''));
      uci.set('wifiroam', 'backhaul', 'config_ver', String(ver));
      uci.commit('wifiroam');

      const bh = wifi.currentBackhaulCfg();
      const results = [];
      const lr = wifi.applyBackhaulLocal(bh, 'cap');
      results.push({ ap: S.self.mac, name: S.self.name, ok: lr.ok, ver: lr.ver, error: lr.error ?? null });
      S.last_backhaul = { ts: nowSeconds(), ver, results };
      for (const [mn, p] of Object.entries(S.peers)) {
        if (!p.authed) continue;
        results.push({ ap: p.mac ?? maccolon(mn), name: p.info?.name ?? p.name ?? mn, ok: null, error: 'pending' });
        discovery.pushBackhaulTo(mn);
      }
      return { ok: true, ver, results, backhaul: bh };
    },

    discover() {
      const out = [];
      for (const [mn, d] of Object.entries(S.discovered)) {
        void mn;
        out.push({ mac: d.mac, ip: d.ip, name: d.name, model: d.model, last_seen: d.last_seen });
      } // 不下发 nonce，配对所需凭据仅留在守护进程内
      return { devices: out };
    },

    pair(args) {
      const mac = args.mac;
      if (!mac) return UBUS_STATUS.INVALID_ARGUMENT;
      if (S.cfg.role !== 'cap') return { ok: false, error: 'not_cap' };
      const mn = macnorm(mac);
      const d = S.discovered[mn];
      if (!d) return { ok: false, error: 'not_found' };
      if (!d.ip) return { ok: false, error: 'no_ip' };
      // 配对是异步的：新建 TCP 通道，收到对端 hello 后 defer join；
      // 8000ms 定时器兜底断开。立即返回 { ok: true, ip }（原版同）。
      const onPaired = () => {
        pushEvent(S, 'paired', d.mac, d.ip);
        delete S.discovered[mn];
      };
      if (typeof discovery.startPairing === 'function') {
        try {
          const res = discovery.startPairing({
            ip: d.ip, token: S.cfg.token, capIp: S.self.ip,
            nonceEcho: d.nonce, onPaired,
          });
          if (res === null) return { ok: false, error: 'socket' };
        } catch (_e) {
          return { ok: false, error: 'socket' };
        }
      } else {
        // 业务模块缺失 startPairing 时的回落：core 自带的通道握手。
        daemon.pairConnect(d, mn);
      }
      return { ok: true, ip: d.ip };
    },

    unpair(args) {
      const mac = args.mac;
      if (!mac) return UBUS_STATUS.INVALID_ARGUMENT;
      if (S.cfg.role !== 'cap') return { ok: false, error: 'not_cap' };
      const mn = macnorm(mac);
      const p = S.peers[mn];
      if (!p) return { ok: false, error: 'not_found' };
      if (typeof discovery.sendLeave === 'function') {
        discovery.sendLeave(mn);
      } else if (p.authed && p.chan) {
        try { fireDefer(p.chan, 'leave', {}); } catch (_e) { /* 忽略 */ }
      }
      delete S.peers[mn];
      pushEvent(S, 'unpaired', maccolon(mn), p.name ?? '');
      return { ok: true };
    },

    roam_log(args) {
      let limit = toInt(args.limit ?? 50);
      if (limit <= 0) limit = 50;
      if (limit > MAX_EVENTS) limit = MAX_EVENTS;
      let ev = S.events;
      if (ev.length > limit) ev = ev.slice(ev.length - limit);
      return { events: ev };
    },

    appctl_status() {
      const apps = [];
      for (const a of APP_DEFS) apps.push({ id: a.id, name: a.name, cat: a.cat ?? '' });

      const devices = {};
      for (const [mn, d] of Object.entries(S.appctl.devices)) devices[mn] = { name: d.name, block: d.block };

      return {
        ok: S.cfg.role === 'cap',
        error: S.cfg.role === 'cap' ? '' : 'not_cap',
        enabled: S.appctl.enabled,
        enhanced: S.appctl.enhanced === true,
        strict: S.appctl.strict === true,
        day: S.appctl.day,
        apps, devices, stats: policy.appctlPublicStats(),
        online: policy.appctlPublicDays(S.appctl.online, true),
        ndata: policy.appctlPublicDays(S.appctl.ndata, false),
      };
    },

    /* 定时断网：规则列表 + 当前生效集合。只在 CAP 可配置/生效。 */
    ban_list() {
      const lt = localtimeNow();
      const nowmin = lt.hour * 60 + lt.min;
      const items = [];
      for (const b of banMod.banRead()) {
        items.push({
          mac: b.mac, name: b.name,
          timeon: b.timeon, timeoff: b.timeoff,
          weekdays: b.weekdays,
          active: S.ban.enabled && banMod.banInWindow(b, lt, nowmin),
        });
      }
      return {
        ok: S.cfg.role === 'cap',
        error: S.cfg.role === 'cap' ? '' : 'not_cap',
        enabled: S.ban.enabled,
        items,
        blocked: Object.keys(S.ban.active).sort(),
      };
    },

    set_ban(args) {
      if (S.cfg.role !== 'cap') return { ok: false, error: 'not_cap' };
      const on = args.enabled ? true : false;
      uci.load('wifiroam');
      if (uci.get('wifiroam', 'schedule') == null) uci.set('wifiroam', 'schedule', 'schedule');
      uci.set('wifiroam', 'schedule', 'enabled', on ? '1' : '0');
      uci.commit('wifiroam');
      S.ban.enabled = on;
      banApplyOf(modules, true);
      return { ok: true, enabled: on };
    },

    async ban_set(args) {
      if (S.cfg.role !== 'cap') return { ok: false, error: 'not_cap' };
      const a = args;
      const mn = clients.deviceKey(a.mac ?? '');
      if (mn.length !== 12 && !/^g[0-9a-f]{12}$/.test(mn)) return { ok: false, error: 'invalid_mac' };
      const on = banMod.banHm(a.timeon); const off = banMod.banHm(a.timeoff);
      if (on == null || off == null) return { ok: false, error: 'invalid_time' };
      const days = banMod.banWeekdays(a.weekdays);
      if (!days.length) return { ok: false, error: 'invalid_weekdays' };

      let name = a.name ?? '';
      if (name === '') {
        const r = await clients.findClient(mn);
        name = r?.node?.name ?? '';
      }

      uci.load('wifiroam');
      let sid = null; const old = [];
      uci.foreach('wifiroam', 'ban', (sec) => {
        if (clients.deviceKey(sec.mac ?? '') === mn) {
          if (!sid) sid = sec['.name'];
          old.push(sec['.name']);
        }
      });
      if (!sid) {
        sid = uci.add('wifiroam', 'ban');
        uci.set('wifiroam', sid, 'mac', mn);
      }
      uci.set('wifiroam', sid, 'mac', mn);
      uci.set('wifiroam', sid, 'name', name);
      uci.delete('wifiroam', sid, 'enabled');
      uci.set('wifiroam', sid, 'timeon', banMod.banHmStr(on));
      uci.set('wifiroam', sid, 'timeoff', banMod.banHmStr(off));
      uci.set('wifiroam', sid, 'weekdays', days.join(' '));
      for (const id of old) if (id !== sid) uci.delete('wifiroam', id);
      uci.commit('wifiroam');

      // 首次保存时段时总开关默认开启（已显式关闭的保持关闭）
      banReloadEnabledOf(modules);
      banApplyOf(modules, true);
      let blocked = false;
      for (const member of clients.deviceMembersOf(mn)) if (S.ban.active[member]) blocked = true;
      return { ok: true, mac: mn, blocked };
    },

    ban_del(args) {
      if (S.cfg.role !== 'cap') return { ok: false, error: 'not_cap' };
      const mn = clients.deviceKey(args.mac ?? '');
      uci.load('wifiroam');
      const old = [];
      uci.foreach('wifiroam', 'ban', (sec) => {
        if (clients.deviceKey(sec.mac ?? '') === mn) old.push(sec['.name']);
      });
      if (!old.length) return { ok: false, error: 'not_found' };
      for (const sid of old) uci.delete('wifiroam', sid);
      uci.commit('wifiroam');
      // 删掉最后一个时段后，未显式配置的总开关回到默认关闭
      banReloadEnabledOf(modules);
      banApplyOf(modules, true);
      return { ok: true };
    },

    /* 硬件/软件 flow offload 状态：fw4 的 flowtable 一旦命中，后续数据包会绕过
       netfilter 链，inet wifiroam forward 里的 counter 不再增长，应用统计与
       访问控制都会受影响。这里读 fw4 的实际 forward 链判断是否真的生效。 */
    offload_status() {
      uci.load('firewall');
      const sw = uci.get('firewall', '@defaults[0]', 'flow_offloading') === '1';
      const hw = uci.get('firewall', '@defaults[0]', 'flow_offloading_hw') === '1';
      const active = cmdOutput('nft list chain inet fw4 forward 2>/dev/null').indexOf('flow add') >= 0;
      return { enabled: sw, hw, active };
    },

    set_offload(args) {
      const on = args.enabled ? true : false;
      // 子 AP 的转发不发生在本地：本地先落盘保持一致，再通知 CAP 统一执行，
      // CAP 改完会把最终状态广播回所有子 AP（含本机）
      if (S.cfg.role === 'sap') {
        policy.offloadApply(on);
        policy.offloadRequestCap(on);
        return { ok: true, enabled: on };
      }
      if (!policy.offloadApply(on)) return { ok: false, error: 'no_firewall_defaults' };
      for (const [mn, p] of Object.entries(S.peers)) if (p.authed) discovery.pushOffloadTo(mn);
      return { ok: true, enabled: on };
    },

    async set_appctl(args) {
      // 调用方必须显式传 enhanced（ubus 参数是白名单校验，未声明的参数会被拒；
      // 默认值取 false，类型可推断，publish 正常）
      // strict 留空表示沿用当前值，避免旧调用点（总开关）把严格模式重置
      if (S.cfg.role !== 'cap') return { ok: false, error: 'not_cap' };
      const on = args.enabled ? true : false;
      uci.load('wifiroam');
      // 老配置里可能没有 appctl section，先按类型创建再写选项
      if (uci.get('wifiroam', 'appctl') == null) uci.set('wifiroam', 'appctl', 'appctl');
      // enhanced 为必填调用参数（前端所有调用点都显式传当前值）
      const enh = args.enhanced ? true : false;
      let strict = S.appctl.strict === true;
      if (args.strict === '1') strict = true;
      else if (args.strict === '0') strict = false;
      uci.set('wifiroam', 'appctl', 'enabled', on ? '1' : '0');
      uci.set('wifiroam', 'appctl', 'enhanced', enh ? '1' : '0');
      uci.set('wifiroam', 'appctl', 'strict', strict ? '1' : '0');
      uci.commit('wifiroam');
      S.appctl.enabled = on;
      S.appctl.enhanced = enh;
      S.appctl.strict = strict;

      let dirty = policy.appctlDnsmasqSync(on);
      if (on) {
        // 精准/宽松切换会改变集合默认超时：schema 标记不一致即重建集合
        if (policy.appctlNftSchema()) dirty = true;
        await policy.appctlApplyRules();
        policy.appctlDpiDaemon('start');
        policy.appctlDnslockApply(enh);
        policy.appctlHwSuspend(enh);
      } else {
        policy.appctlTableRemove();
        policy.appctlHwSuspend(false);
      }
      // dnsmasq 需要重读 nftset 配置才生效，约 1s DNS 瞬断
      if (dirty) cmdOutput('/etc/init.d/dnsmasq restart >/dev/null 2>&1');
      return { ok: true, enabled: on, enhanced: enh, strict };
    },

    async set_app_policy(args) {
      if (S.cfg.role !== 'cap') return { ok: false, error: 'not_cap' };
      const a = args;
      const mn = clients.deviceKey(a.mac ?? '');
      if ((mn.length !== 12 && !/^g[0-9a-f]{12}$/.test(mn)) || !policy.appctlApp(a.app ?? '')) {
        return { ok: false, error: 'invalid_args' };
      }
      if (!S.appctl.enabled) return { ok: false, error: 'disabled' };
      if (!['block', 'allow'].includes(a.action ?? '')) return { ok: false, error: 'invalid_action' };

      const devs = policy.appctlReadDevices();
      const blocks = [];
      for (const b of (devs[mn]?.block ?? [])) blocks.push(b);
      const i = blocks.indexOf(a.app);
      if (a.action === 'block' && i < 0) blocks.push(a.app);
      if (a.action === 'allow' && i >= 0) blocks.splice(i, 1);

      let name = devs[mn]?.name ?? '';
      if (name === '') name = (await clients.findClient(mn))?.node?.name ?? '';
      policy.appctlWriteDevice(mn, blocks, name);
      policy.appctlReadDevices();
      await policy.appctlApplyRules();
      policy.appctlDpiDaemon('reload');
      return { ok: true, mac: mn, app: a.app, action: a.action, block: blocks };
    },
  };

  // 分发优先用业务模块自带的 handler（与原版逐行对齐，见各模块头注），
  // 模块缺失时回落到上面的 core 实现。handler 一律取 args、返回结果
  // （或其 Promise）；整数 ubus 状态码由 buildApiObject 的包装层处理。
  const pick = (mod, name, coreName) =>
    (mod && typeof mod[name] === 'function' ? mod[name] : coreHandlers[coreName]);
  const handlers = { ...coreHandlers };
  handlers.topology = pick(clients, 'topology', 'topology');
  handlers.device_history = pick(clients, 'deviceHistory', 'device_history');
  handlers.wake = pick(clients, 'wake', 'wake');
  handlers.client_detail = pick(clients, 'clientDetail', 'client_detail');
  handlers.set_alias = pick(clients, 'setAlias', 'set_alias');
  handlers.set_pin = pick(clients, 'setPin', 'set_pin');
  handlers.ungroup_device = pick(clients, 'ungroupDevice', 'ungroup_device');
  handlers.ban_list = pick(clients, 'banList', 'ban_list');
  handlers.set_ban = pick(clients, 'setBan', 'set_ban');
  handlers.ban_set = pick(clients, 'banSet', 'ban_set');
  handlers.ban_del = pick(clients, 'banDel', 'ban_del');
  handlers.appctl_status = pick(policy, 'appctlStatus', 'appctl_status');
  handlers.set_appctl = pick(policy, 'setAppctl', 'set_appctl');
  handlers.set_app_policy = pick(policy, 'setAppPolicy', 'set_app_policy');
  handlers.offload_status = pick(policy, 'offloadStatus', 'offload_status');
  handlers.set_offload = pick(policy, 'setOffload', 'set_offload');
  handlers.precheck = pick(wifi, 'precheck', 'precheck');
  return handlers;
}

// ubus 发布形：{ method: { handler, args } }。handler 把 lib 的
// req.data 译为分发表的 args；分发表返回整数状态码时（见 N2）不发 DATA。
export function buildApiObject(daemon) {
  const handlers = buildApiHandlers(daemon);
  const obj = {};
  for (const name of API_METHODS) {
    const fn = handlers[name];
    obj[name] = {
      args: API_ARGS[name],
      handler: async (req) => {
        const result = await fn(req.data ?? {});
        if (typeof result === 'number') return undefined; // 见 N2
        return result;
      },
    };
  }
  return obj;
}

// ------------------------------------------------------------------ 配对
// pair 的异步部分（原版 pair 内联的 open_channel + 8000ms 兜底）：
// 建 TCP 通道 -> 对端 srv_accept 先发 hello -> defer join。
// createChannel 默认走 lib UbusChannel.connect（裸 TCP，不发/不等 HELLO，
// localId 固定 1，请求 peer 一律 0，与 research §2.7 一致）；单测可注入。
export function defaultCreateChannel(host, port) {
  return UbusChannel.connect(host, port, { timeout: 30000 });
}

export function pairConnect(daemon, d, mn, createChannelFn) {
  const { S } = daemon;
  const createChannel = createChannelFn ?? daemon.createChannel ?? defaultCreateChannel;
  let done = false;
  let chan = null;
  const setup = (async () => {
    try {
      chan = await createChannel(d.ip, TCP_PORT);
    } catch (_e) {
      return; // 原版 sock.connect 失败时同样静默（断开回调为空）
    }
    const onHello = async (req) => {
      if ((req.method ?? req.type) === 'hello' && chan) {
        try {
          await chan.defer('join', {
            token: S.cfg.token,
            cap_ip: S.self.ip,
            nonce_echo: d.nonce,
          }, {
            onData: (m) => {
              done = true;
              if (m?.ok) {
                pushEvent(S, 'paired', d.mac, d.ip);
                delete S.discovered[mn];
              }
              try { chan.close(); } catch (_e) { /* 忽略 */ }
            },
          });
        } catch (_e) {
          // 成功时 onData 已处理并断开；仅失败时兜底断开
          if (chan) { try { chan.close(); } catch (_e2) { /* 忽略 */ } }
        }
      }
      return 0;
    };
    if (typeof chan.setRequestHandler === 'function') chan.setRequestHandler(onHello);
    else if (typeof chan.onRequest === 'function') chan.onRequest(onHello);
    if (typeof chan.on === 'function') chan.on('close', () => {});
  })();
  if (setup && typeof setup.catch === 'function') setup.catch(() => {});
  const timer = setTimeout(() => {
    if (!done && chan) { try { chan.close(); } catch (_e) { /* 忽略 */ } }
  }, 8000);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

// ------------------------------------------------------------------ 组装
const MODULE_SPECS = [
  ['discovery', './discovery.mjs', 'createDiscovery'],
  ['clients', './clients.mjs', 'createClients'],
  ['wifi', './wifi.mjs', 'createWifi'],
  ['guest', './guest.mjs', 'createGuest'],
  ['policy', './policy.mjs', 'createPolicy'],
];

export async function loadDefaultModules(ctx) {
  const modules = {};
  for (const [key, path, factoryName] of MODULE_SPECS) {
    let mod;
    try {
      mod = await import(path);
    } catch (e) {
      throw new Error(`core: cannot load ${key} module (${path}): ${e.message}`);
    }
    const factory = mod[factoryName] ?? mod.default;
    if (typeof factory !== 'function') {
      throw new Error(`core: ${key} module (${path}) does not export ${factoryName}(ctx)`);
    }
    modules[key] = factory(ctx);
  }
  return modules;
}

export async function createDaemon(opts = {}) {
  const S = opts.state ?? createState();
  const uciClient = opts.uci ?? defaultUci;
  const exitFn = opts.exitFn ?? ((code) => process.exit(code));

  // ubus 连接先于业务模块建立：clients/wifi 在工厂内捕获 ctx.bus，
  // 工厂创建时 bus 必须已就绪（见文件头）。失败即 log + exit(1)，
  // 与原版 main() 的 fail-fast 一致；随后抛错阻止继续启动。
  // 注入 modules 的单测缝可不连 ubus（此时 ctx.bus 为 null）。
  let bus = opts.bus ?? null;
  if (!bus && typeof opts.ubusConnect === 'function') {
    try {
      bus = await opts.ubusConnect(opts.ubusPath, { timeout: 60000 });
    } catch (_e) {
      bus = null;
    }
    if (!bus) {
      log('ubus connect failed');
      exitFn(1);
      throw new Error('core: ubus connect failed');
    }
  } else if (!bus && !opts.modules) {
    try {
      bus = await UbusClient.connect(opts.ubusPath, { timeout: 60000 });
    } catch (_e) {
      bus = null;
    }
    if (!bus) {
      log('ubus connect failed');
      exitFn(1);
      throw new Error('core: ubus connect failed');
    }
  }

  // ctx：基础字段 + 跨模块回调。回调是惰性闭包：工厂创建时只校验
  // “是函数”，真正调用发生在启动/运行时，此时 modules 已填满。
  // （discovery 的工厂会逐项校验这 31 个回调，缺一即抛 TypeError。）
  const modules = {};
  const daemonRef = { current: null };
  const ctx = {
    S,
    bus,
    uci: uciClient,
    shell,
    util,
    store,
    cmdOutput,
    now: () => nowSeconds(),
    localtime: () => localtimeNow(),
    timers: { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout },
    exit: exitFn,
    // -- core --
    pushEvent: (type, mac, info, name) => pushEvent(S, type, mac, info, name),
    saveConfig: () => saveConfig(S, uciClient),
    reconfigure: () => reconfigure(S, daemonRef.current),
    // -- wifi --
    currentRoamCfg: () => modules.wifi.currentRoamCfg(),
    currentBackhaulCfg: () => modules.wifi.currentBackhaulCfg(),
    roamSig: (r) => modules.wifi.roamSig(r),
    selfInfo: () => modules.wifi.selfInfo(),
    selfUptime: () => modules.wifi.selfUptime(),
    detectSelf: () => modules.wifi.detectSelf(),
    detectUplink: () => modules.wifi.detectUplink(),
    memberList: () => modules.wifi.memberList(),
    appliedKvr: (...a) => modules.wifi.appliedKvr(...a),
    applyRoamLocal: (...a) => modules.wifi.applyRoamLocal(...a),
    applyBackhaulLocal: (...a) => modules.wifi.applyBackhaulLocal(...a),
    applyWifiLocal: (...a) => modules.wifi.applyWifiLocal(...a),
    roamRenameSsids: (...a) => modules.wifi.roamRenameSsids(...a),
    wifiSummary: (...a) => modules.wifi.wifiSummary(...a),
    apOverview: () => modules.wifi.apOverview(),
    bssPublic: () => modules.wifi.bssPublic(),
    // -- clients --
    localClients: (...a) => modules.clients.localClients(...a),
    diffEvents: (...a) => modules.clients.diffEvents(...a),
    ownerEvents: (...a) => modules.clients.ownerEvents(...a),
    clientNames: () => modules.clients.clientNames(),
    clientNameOf: (...a) => modules.clients.clientNameOf(...a),
    apDisplay: (...a) => modules.clients.apDisplay(...a),
    findClient: (...a) => modules.clients.findClient(...a),
    buildTopology: (...a) => modules.clients.buildTopology(...a),
    deviceKey: (...a) => modules.clients.deviceKey(...a),
    deviceMembersOf: (...a) => modules.clients.deviceMembersOf(...a),
    deviceAliasOf: (...a) => modules.clients.deviceAliasOf(...a),
    deviceReindex: (...a) => modules.clients.deviceReindex(...a),
    deviceGroupRefresh: (...a) => modules.clients.deviceGroupRefresh(...a),
    parseLeases: () => modules.clients.parseLeases(),
    parseFdb: () => modules.clients.parseFdb(),
    aliasApply: (...a) => modules.clients.aliasApply(...a),
    pinOf: (...a) => modules.clients.pinOf(...a),
    pinApply: (...a) => modules.clients.pinApply(...a),
    aliasSave: (...a) => modules.clients.aliasSave(...a),
    readLeases: () => modules.clients.parseLeases(),
    // -- guest --
    guestCfg: () => modules.guest.guestCfg(),
    guestSaveLocal: (...a) => modules.guest.guestSaveLocal(...a),
    applyGuestLocal: (...a) => modules.guest.applyGuestLocal(...a),
    // -- policy --
    banApply: (force) => modules.clients.banApply(force),
    offloadApply: (...a) => modules.policy.offloadApply(...a),
    pushOffloadTo: (...a) => modules.discovery.pushOffloadTo(...a),
    appctlReadDevices: () => modules.policy.appctlReadDevices(),
    appctlApplyRules: () => modules.policy.appctlApplyRules(),
    appctlDpiDaemon: (...a) => modules.policy.appctlDpiDaemon(...a),
    // -- discovery --
    sapDisconnect: () => modules.discovery.sapDisconnect(),
    aliasBroadcast: () => modules.discovery.aliasBroadcast(),
    connClose: (conn) => {
      // discovery 不导出 conn_close；尽力而为：关通道 + 毁 socket。
      // （原版 conn_close 还清对应 peer 的 conn/chan/authed，见 §9 含糊项。）
      try { conn?.chan?.close?.(); } catch (_e) { /* 忽略 */ }
      try { conn?.sock?.destroy?.(); } catch (_e) { /* 忽略 */ }
      try { conn?.sock?.close?.(); } catch (_e) { /* 忽略 */ }
    },
    ...(opts.extraCtx ?? {}),
  };

  const loaded = opts.modules ?? await loadDefaultModules(ctx);
  Object.assign(modules, loaded);

  const daemon = {
    S,
    ctx,
    modules,
    uci: uciClient,
    daemonStarted: nowSeconds(), // 原版第 237 行：进程启动时刻
    bus,
    timers: [], // { name, ms, fn, handle }
    apiHandlers: null,
    apiObject: null,
    createChannel: opts.createChannel ?? defaultCreateChannel,
    ubusPath: opts.ubusPath,
    exitFn,
    started: false,
  };
  daemonRef.current = daemon;

  daemon.loadConfig = () => loadConfig(S, uciClient);
  daemon.saveConfig = () => saveConfig(S, uciClient);
  daemon.pushEvent = (type, mac, info, name) => pushEvent(S, type, mac, info, name);
  daemon.ensureToken = () => ensureToken(S, daemon.saveConfig);
  daemon.reconfigure = () => reconfigure(S, daemon);
  daemon.roamDefaultInit = () => roamDefaultInit(S, daemon);
  daemon.capTick = () => capTick(S, modules);
  daemon.pairConnect = (d, mn) => pairConnect(daemon, d, mn);

  daemon.apiHandlers = buildApiHandlers(daemon);
  daemon.apiObject = buildApiObject(daemon);

  daemon.registerTimers = () => {
    const specs = [
      ['send_hello', HELLO_INTERVAL, () => modules.discovery.sendHello()],
      ['sap_tick', TICK_INTERVAL, () => modules.discovery.sapTick()],
      ['sap_report', TICK_INTERVAL, () => modules.discovery.sapReport()],
      ['expire_tick', TICK_INTERVAL, () => modules.discovery.expireTick()],
      ['backhaul_tick', TICK_INTERVAL, () => modules.wifi.backhaulTick()],
      ['steer_tick', TICK_INTERVAL, () => modules.wifi.steerTick()],
      ['pin_tick', TICK_INTERVAL, () => modules.wifi.pinTick()],
      ['guest_tick', TICK_INTERVAL, () => modules.guest.guestTick()],
      ['appctl_tick', TICK_INTERVAL, () => modules.policy.appctlTick()],
      ['ban_tick', TICK_INTERVAL, () => banTickOf(modules)],
      ['devlist_tick', TICK_INTERVAL, () => modules.clients.devlistTick()],
      // 原版第 12 个为匿名函数：仅 CAP，本机终端 join/leave 与迁移事件
      ['cap_clients_tick', TICK_INTERVAL, () => daemon.capTick()],
    ];
    for (const [name, ms, fn] of specs) {
      // 见 N4：单轮抛错（同步或异步）记日志后继续下一轮，不让守护进程退出。
      const guarded = () => {
        try {
          const r = fn();
          if (r && typeof r.catch === 'function') {
            r.catch((e) => log(`tick ${name} failed: ${e?.message ?? e}`));
          }
          return r;
        } catch (e) { log(`tick ${name} failed: ${e?.message ?? e}`); }
        return undefined;
      };
      const handle = setInterval(guarded, ms);
      daemon.timers.push({ name, ms, fn: guarded, handle });
    }
    return daemon.timers;
  };

  daemon.stop = () => {
    for (const t of daemon.timers) clearInterval(t.handle);
    daemon.timers = [];
    try { modules.discovery?.stop?.(); } catch (_e) { /* 忽略 */ }
    if (daemon.bus) {
      try { daemon.bus.close(); } catch (_e) { /* 忽略 */ }
      daemon.bus = null;
      ctx.bus = null;
    }
    daemon.started = false;
  };

  // 原版 main()（第 5446-5496 行）逐行翻译；ubus 连接已在 createDaemon
  // 里完成（原版 main 也是先 connect 再 load_config）。uloop.run() 由
  // Node 事件循环代替（见 N3），start() 注册完定时器即返回。
  daemon.start = async () => {
    srand(nowSeconds());

    if (!daemon.bus) {
      log('ubus connect failed');
      daemon.exitFn(1);
      return false;
    }

    daemon.loadConfig();
    modules.clients.aliasLoad();
    modules.clients.devlistLoad();
    await modules.wifi.detectSelf();
    await modules.clients.deviceGroupRefresh();
    // 建规则要用到本机接口/网桥信息，必须放在 detect_self 之后
    await modules.policy.appctlLoad();
    banLoadOf(modules);
    daemon.ensureToken();
    // 首次启用插件：按默认设置开启漫游（自动选中本机 SSID）
    daemon.roamDefaultInit();

    await modules.discovery.setupUdp();
    await modules.discovery.setupTcp();

    await daemon.bus.addObject('wifiroam', daemon.apiObject);

    daemon.registerTimers();

    modules.discovery.sendHello();
    log(`started role=${S.cfg.role}`);
    daemon.started = true;
    return true;
  };

  return daemon;
}

export async function main(opts = {}) {
  const daemon = await createDaemon(opts);
  await daemon.start();
  return daemon;
}
