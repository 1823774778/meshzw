// SPDX-License-Identifier: GPL-2.0-or-later
// wifiroamd - multi-AP topology & 802.11k/v/r roaming orchestration daemon
// Roles: cap (controller AP) / sap (satellite AP) / unconfigured
//
// ucode notes:
//  - for (v in array) iterates VALUES; for (k, v in obj) iterates key+value
//  - libubus.open_channel(sock, rx_cb, disconnect_cb); rx_cb(req) single arg
//  - channel.request({method, data, return:"ignore"}) fire & forget
//  - channel.defer({method, data, data_cb, cb}) request/response
'use strict';

import * as libubus from "ubus";
import * as uloop from "uloop";
import * as socket from "socket";
import * as fs from "fs";
import * as uci from "uci";
import { sha256 } from "digest";

// ---------------------------------------------------------------- constants
const UDP_PORT = 50607;
const TCP_PORT = 50608;
const MAGIC = "WIFIROAM1";
const ALIAS_DIR = "/etc/wifiroam";
const ALIAS_PATH = ALIAS_DIR + "/aliases.json";
const USAGE_PATH = ALIAS_DIR + "/usage.json";
const USAGE_TABLE = "wifiroam_usage";
const USAGE_FLUSH = 15;     // s：统计落盘的最小间隔
const PEER_TTL = 30;        // s without hello -> offline
const DISCOVER_TTL = 180;   // s unconfigured device stays in discover list
const CAP_LOST_GRACE = 15;  // s：CAP 持续处于未配置/换 token 状态后，SAP 自动回到未配置
const HELLO_INTERVAL = 5000;
const TICK_INTERVAL = 10000;
const USAGE_TICK = 5000;    // s：在线时长/流量采样间隔
const MAX_EVENTS = 100;
const CONN_AUTH_TIMEOUT = 15;   // s：未认证 TCP 连接最长存活时间
const MAX_UNAUTH_CONNS = 16;    // 未认证连接上限，避免 fd 被耗尽
const WIRED_TTL = 300;    // s wired client stays listed after last FDB sighting
const STEER_COOLDOWN = 15;  // s 同一终端两次引导/断开尝试的最小间隔
const MIN_STEER_ASSOC = 5;  // s 终端入网后至少稳定这么久才允许被引导
const STEER_CONFIRM = 1;    // 连续低于阈值的采样次数（steer_tick 每 3s）
const STEER_CRITICAL_DROP = 5;    // 低于阈值多少 dBm 视为临界
const STEER_CRITICAL_CONFIRM = 2; // 临界信号需要连续采样次数
const STEER_KICK_AFTER = 2;       // 连续 BTM 无果次数，达到后强制断开
const STEER_KICK_COOLDOWN = 1800; // s 同一终端两次强制断开的最小间隔
const STEER_FORCE_TIMER = 10;     // TBTT：强制 BTM 的 disassociation timer（约 1s）
const STEER_VALIDITY = 30;        // TBTT：BTM 候选有效期
const STEER_TICK = 3000;    // ms：steering 采样间隔（只走 ubus，不扫 iw）
const RRM_SYNC_INTERVAL = 15000; // ms：向 hostapd 同步 11k 邻居库的间隔
const BACKHAUL_SECTION = "wifiroam_bh";
const BACKHAUL_DEFAULT_SSID = "wifiroam-bh";

// 访客网络：每台 AP 各自建一个独立子网 + DHCP + 防火墙隔离区，
// 访客口统一挂到 br-guest（接口名 netifd 限制为 15 字符以内）。
const GUEST_SECTION = "guest";
const GUEST_IFACE = "wifiroam_guest";
const GUEST_DEV = "wifiroam_guest_dev";
const GUEST_BRIDGE = "br-guest";
const GUEST_ZONE = "wifiroam_guest_zone";
const GUEST_FWD_WAN = "wifiroam_guest_fwd_wan";
const GUEST_FWD_LAN = "wifiroam_guest_fwd_lan";
const GUEST_ALLOW_LAN = "wifiroam_guest_allow_lan";
const GUEST_SNAT = "wifiroam_guest_snat";
const GUEST_IP = "172.16.10.1";
const GUEST_NET = "172.16.10.0/24";
const GUEST_DEFAULT_SSID = "Guest";
const GUEST_SEC_PREFIX = "wifiroam_guest_";
const GUEST_NFT_TABLE = "wifiroam_guest";
const GUEST_TC_HANDLE = "57:";
const GUEST_APPLY_TIMEOUT = 60;  // s：等待 SAP 上报新 guest_ver 的上限
const WIFI_PUSH_GRACE = 60;      // s：同一 Wi-Fi 签名重复下发的保护间隔
const FW4_TEMPLATE = "/usr/share/firewall4/templates/ruleset.uc";
const FW4_FLOW_RULE = "meta l4proto { tcp, udp } flow offload @ft;";
const FW4_GUEST_FLOW_RULE = `iifname != "${GUEST_BRIDGE}" oifname != "${GUEST_BRIDGE}" ` + FW4_FLOW_RULE;
// 协议/行为版本：LuCI 侧要求一致，不一致时「重启」会自动 stop+start 修复
const DAEMON_VERSION = 53;

const ROAM_FT_KEYS = [
	"ieee80211r", "mobility_domain", "ft_over_ds", "ft_psk_generate_local",
	"nas_identifier", "pmk_r1_push", "r0kh", "r1kh", "reassociation_deadline",
];
const ROAM_KEYS = [
	...ROAM_FT_KEYS, "ieee80211k", "rrm_neighbor_report", "rrm_beacon_report",
	"ieee80211v", "bss_transition",
];

// ------------------------------------------------------ app access control
// 内置应用清单。只收录应用独占域名，主动排除两类域名以降低误计：
// 1) alicdn.com / byteimg.com 这类跨厂商共用 CDN；
// 2) bdstatic / zhimg / pddpic 这类「厂商独占但被第三方页面大量嵌入」的
//    静态资源域——没装 App、只是浏览网页或微信文章也会命中。
// 取舍上宁少计勿错计（如 QQ 只留 qq.com/qpic.cn，腾讯系共用的 gtimg.cn 剔除）。
// dnsmasq 解析这些域名后把 IP 写入对应 nft set，nft 规则再按
// (终端 MAC, 目标 IP 集合) 匹配，实现免 DPI 的应用级管控。
// cat 用于前端分类展示（对齐 TP-Link 的应用分类）
const APP_DEFS = [
	{ id: "wechat", name: "微信", cat: "social", domains: [
		"weixin.qq.com", "wx.qq.com", "wechat.com" ] },
	{ id: "qq", name: "QQ", cat: "social", domains: [
		"qq.com", "qpic.cn" ] },
	{ id: "douyin", name: "抖音", cat: "video", domains: [
		"douyin.com", "douyinvod.com", "idouyinvod.com", "douyincdn.com",
		"douyinpic.com", "douyinstatic.com", "amemv.com",
		/* ByteDance CDN infra used by Douyin video/audio delivery.
		 * bytegecko / bytecdn / bytednsdoc / bvgtm / ibytedtos serve
		 * Douyin's gecko resource CDN, DNS-over-HTTPS, GTM and DTS.
		 * byteimg / ecombdapi / byteeffecttos / bytetcc / ecombdimg
		 * are Douyin image/ecom/object-storage endpoints observed in
		 * actual traffic.
		 * snssdk / zijieapi are ByteDance-wide SDK/API endpoints that
		 * Douyin relies on; included because this is per-device DPI
		 * blocking (not global DNS), so over-blocking other ByteDance
		 * apps on the SAME device is acceptable.
		 * TikTok domains (tiktok.com / tiktokv.com / tiktokcdn.com /
		 * tiktok-row.net / wmzfylgdsz.com) share ByteDance infra and
		 * are observed on devices that have Douyin installed. */
		"bytegecko.com", "bytegeckoext.com", "bytecdn.com",
		"bytednsdoc.com", "bvgtm.com", "ibytedtos.com",
		"bytegoofy.com", "bytedance.com",
		"byteimg.com", "ecombdapi.com", "ecombdimg.com",
		"byteeffecttos.com", "bytetcc.com",
		"snssdk.com", "zijieapi.com",
		"tiktok.com", "tiktokv.com", "tiktokcdn.com",
		"tiktok-row.net", "tiktokwsesn.com", "wmzfylgdsz.com" ],
	  // apex 域名多数不可解析，预热时用这些具体视频主机把 CDN 池灌进集合；
	  // 注意 snssdk/pstatp 是字节全系共用，不能收录
	  probes: [ "www.douyin.com", "v3-web.douyinvod.com",
	            "v26-web.douyinvod.com", "p3-pc-sign.douyinpic.com" ] },
	{ id: "kuaishou", name: "快手", cat: "video", domains: [
		"kuaishou.com", "gifshow.com", "kwai.com", "kwaicdn.com" ] },
	{ id: "bilibili", name: "哔哩哔哩", cat: "video", domains: [
		"bilibili.com", "hdslb.com", "bilivideo.com", "biliapi.net" ] },
	{ id: "xiaohongshu", name: "小红书", cat: "social", domains: [
		"xiaohongshu.com", "xhscdn.com" ] },
	{ id: "weibo", name: "微博", cat: "social", domains: [
		"weibo.com", "weibo.cn" ] },
	{ id: "taobao", name: "淘宝/天猫", cat: "shop", domains: [
		"taobao.com", "tmall.com" ] },
	{ id: "iqiyi", name: "爱奇艺", cat: "video", domains: [
		"iqiyi.com", "iqiyipic.com", "qiyi.com" ] },
	{ id: "netease_music", name: "网易云音乐", cat: "music", domains: [
		"music.163.com", "music.126.net" ] },   // 126.net 全域被邮箱/新闻共用
	{ id: "youku", name: "优酷", cat: "video", domains: [
		"youku.com" ] },                          // ykimg 第三方嵌入多
	{ id: "mgtv", name: "芒果TV", cat: "video", domains: [
		"mgtv.com", "hitv.com" ] },
	{ id: "zhihu", name: "知乎", cat: "news", domains: [
		"zhihu.com" ] },                          // zhimg 微信文章嵌入多
	{ id: "toutiao", name: "今日头条", cat: "news", domains: [
		"toutiao.com", "toutiaoapi.com" ] },      // toutiaoimg 嵌入多
	{ id: "xigua", name: "西瓜视频", cat: "video", domains: [
		"ixigua.com" ] },
	{ id: "jd", name: "京东", cat: "shop", domains: [
		"jd.com" ] },                             // 360buyimg/jdstatic 广告嵌入多
	{ id: "pinduoduo", name: "拼多多", cat: "shop", domains: [
		"pinduoduo.com", "yangkeduo.com" ] },     // pddpic 分享链接嵌入多
	{ id: "meituan", name: "美团/大众点评", cat: "shop", domains: [
		"meituan.com", "dianping.com" ] },        // meituan.net 静态域嵌入多
	{ id: "eleme", name: "饿了么", cat: "shop", domains: [
		"ele.me" ] },                             // elemecdn H5 分享嵌入多
	{ id: "dingtalk", name: "钉钉", cat: "office", domains: [
		"dingtalk.com" ] },
	{ id: "baidu", name: "百度", cat: "web", domains: [
		"baidu.com" ] },                          // bdstatic 全网嵌入最严重
	{ id: "ximalaya", name: "喜马拉雅", cat: "music", domains: [
		"ximalaya.com" ] },                       // xmcdn 网页播放器嵌入多
	{ id: "huya", name: "虎牙直播", cat: "live", domains: [
		"huya.com" ] },
	{ id: "douyu", name: "斗鱼直播", cat: "live", domains: [
		"douyu.com" ] },
	{ id: "mihoyo", name: "原神/米哈游", cat: "game", domains: [
		"mihoyo.com", "hoyoverse.com", "miyoushe.com" ] },
	{ id: "kugou", name: "酷狗音乐", cat: "music", domains: [
		"kugou.com" ] },
];

// 活跃判定阈值：一个采样窗口内只有零星心跳包（推送、SDK 保活）不算「在使用」。
// 之前只要包数有增长就累计整个窗口，导致「装了没开」的 App 也显示大量时长。
const APP_ACT_MIN_PK = 3;        // 窗口内包数下限
const APP_ACT_MIN_BYTES = 2048;  // 窗口内字节下限
const APP_SET_TIMEOUT = "12h";   // DNS 集合元素有效期，防止旧 IP 被复用时误计

/* 精准识别模式（高级设置里的开关，关闭时保持上面这套宽松口径）：
   - 活跃判定更严：包数与字节必须同时达标（且关系），锁屏心跳不再计时长；
   - 集合超时缩短到 30m：CDN 回收/复用 IP 后更快退出归属。命中刷新不受
     内核支持（实测 Not supported），靠 dnsmasq 重复解析自然续期；
   - DNS 出口锁定：53 重定向到本机 dnsmasq、拦 DoT(853) 与知名公共 DoH，
     防止 App 用内置 HTTPDNS/私有 DNS 绕过识别。
   DoH 清单只收纯 DNS 服务商地址（Cloudflare 1.1.1.1 同时承载网页服务，
   为避免误伤不收录）。 */
const APP_ACT_ENH_PK = 5;
const APP_ACT_ENH_BYTES = 4096;
const APP_SET_TIMEOUT_ENH = "30m";
const APP_DOH_V4 = [ "8.8.8.8", "8.8.4.4", "9.9.9.9", "149.112.112.112",
	"223.5.5.5", "223.6.6.6", "119.29.29.29", "180.76.76.76",
	"114.114.114.114", "114.114.115.115" ];
const APP_DOH_V6 = [ "2001:4860:4860::8888", "2001:4860:4860::8844",
	"2620:fe::fe", "2620:fe::9", "2400:3200::1", "2400:3200:baba::1",
	"2402:4e00::" ];

const APPCTL_TABLE = "wifiroam";
const APPCTL_NFT_FILE = "/tmp/wifiroam-appctl.nft";
const APPSTATS_PATH = ALIAS_DIR + "/appstats.json";
const APPCTL_SCHEMA_PATH = ALIAS_DIR + "/nft_schema";
const APPSTATS_FLUSH = 15;   // s：统计落盘的最小间隔（重启最多丢这一轮）

// DPI（深度包检测）：把每个新建连接的首包送到 wifiroam-dpi 守护进程，
// 解析 TLS SNI / QUIC SNI，命中被禁应用域名即 drop。兜底 DNS/IP 集合方案
// 无法覆盖的 HTTPDNS 直连与 P2P 流量。blocklist 由本进程写，dpi 读。
const DPI_QUEUE = 0;
const DPI_BLOCKLIST = "/tmp/wifiroam/dpi_blocklist";
const DPI_DAEMON = "/usr/sbin/wifiroam-dpi";
const DPI_PIDFILE = "/tmp/wifiroam-dpi.pid";

// 终端暂停联网：仅 CAP 生效，按源 MAC 在 forward 链 drop。
// 放在 priority 10，晚于应用统计链（-10），被暂停终端的流量仍会被计数。
const BLOCK_PATH = ALIAS_DIR + "/blocked.json";
const BLOCK_TABLE = "wifiroam_acl";
const ACL_NFT_FILE = "/tmp/wifiroam-acl.nft";

// 上网时段（定时断网）：CAP 按终端 MAC 在 forward 链丢弃，跨午夜/按星期生效
const BAN_TABLE = "wifiroam_sched";
const BAN_NFT_FILE = "/tmp/wifiroam-sched.nft";
const BAN_DEFAULT_ON = "22:00";
const BAN_DEFAULT_OFF = "07:00";

// 终端历史 / 固定 AP / 唤醒
const DEVICES_PATH = ALIAS_DIR + "/devices.json";
const DEVICES_FLUSH = 300;  // s：历史落盘最小间隔（last_online 每 5 分钟落盘一次）
const DEVICES_MAX = 200;    // 条数上限
const PIN_KICK_COOLDOWN = 30; // s：同一终端两次固定 AP 纠正的最小间隔
const PIN_BAN_MS = 120000;    // ms：踢回目标 AP 时禁止立即重连的时间

// ------------------------------------------------------------------ globals
let daemon_started = time();  // 进程启动时刻，用于识别「重启后仍是旧进程」
let ubusc;              // ubus connection
let udp_sock;           // discovery socket
let tcp_srv;            // sync listen socket
let active_conns = {};  // id -> conn：未认证连接超时/数量限制
let conn_seq = 0;
// 性能：同一秒内多个 tick/ubus 请求共享解析结果与客户端快照，
// 避免 usage_tick / appctl_tick / status / topology 重复执行 shell 与 ubus 调用。
let _sec_cache = {};
let _clients_cache = { ts: 0, data: null };

// 前向声明：ucode 单遍编译不提升函数声明，使用点必须晚于绑定点
let sap_report, push_aliases_to, push_roam_to, push_backhaul_to, push_offload_to, push_blocked_to, push_devices_to, push_wifi_to, push_guest_to, apply_result_update, apply_backhaul_result_update, apply_wifi_result_update, apply_guest_result_update, ensure_token, reconfigure, conn_close;
let sap_self_reset, sap_disconnect, roam_default_init, backhaul_stp_ensure;
// 访客网络：前向声明后置赋值函数（ucode 不提升函数声明）
let guest_after_reload, apply_guest_local, guest_save_local, guest_tick;
let write_roam_iface, guest_fw4_sync;
let rrm_sync_local, rrm_sync_tick;
let wifi_sync_to;
// 需要 local_clients()，只能在它之后绑定
let appctl_track_macs, online_sample;

let state = {
	cfg: {},            // uci wifiroam
	self: {},           // self system info
	brdev: "br-lan",
	peers: {},          // macnorm -> AP peer (hello + report merged)
	discovered: {},     // macnorm -> unconfigured device seen
	aliases: { ver: 0, map: {}, pin: {} },
	link: null,         // SAP: outgoing channel to CAP {sock,chan,authed}
	cap_learned: null,  // CAP ip learned from hello
	cap_lost_since: null, // SAP: 首次发现主 AP 丢失配置的时间
	events: [],         // ring buffer
	last_apply: null,   // last roam push result summary
	last_backhaul: null, // last wireless-backhaul push result summary
	last_wifi: null,    // last Wi-Fi rename push result summary
	last_guest: null,   // last guest-network push result summary
	cap_offload: null,  // SAP: last flow offload state pushed by CAP
	cap_usage: null,    // SAP: usage snapshot pushed by CAP
	guest_open: null,   // 访客网络当前是否在开放时段内（null = 未知）
	guest_tc_devs: {},  // 访客无线接口 → 已成功安装的限速规则签名
	guest_tc_error: "",
	guest_fw4_error: null,
	guest_fw4_failed: null,
	guest_fw4_retry_at: 0,
	_guest_nft_sig: "",  // 访客 nft 表（隔离 + 子AP SNAT）的签名，避免每轮重建
	_guest_zone_migrated: false, // 访客区是否已从 option network 迁移到 device+subnet
	_guest_bridged: null, // 访客出口是否走 lan + SNAT（桥接上行），null = 尚未判定
	client_seen: {},    // macnorm -> first seen ts
	client_bytes: {},   // macnorm -> 站点字节计数采样 { ts, rx, tx }（算实时速率）
	bytes_cache: {},    // ifname -> { ts, map }：1s 内复用，避免同一轮重复调用 iw
	prev_clients: null, // for join/leave event diffing; null = 首轮扫描不产事件
	wired_seen: {},     // macnorm -> 最后一次出现在 FDB 的时间（有线存活依据+防抖）
	prev_owner: null,   // CAP 视角 macnorm -> 归属 AP（跨 AP 迁移事件；null = 首轮抑制）
	roam_ver_applied: 0,
	backhaul_ver_applied: 0,
	guest_ver_applied: 0,  // SAP: 真正完成本机 apply 的访客配置版本
	steer_last: {},     // macnorm -> 上次 BSS Transition 引导时间
	steer_low: {},      // macnorm -> 连续低于阈值的采样次数
	steer_stage: {},    // macnorm -> 0/1/2（建议/强制阶段）
	steer_tries: {},    // macnorm -> 连续 BTM 无果次数
	steer_mute: {},     // macnorm -> 强制断开后的静默截止时间
	kick_last: {},      // macnorm -> 上次强制断开时间
	devices: {},        // macnorm -> 终端历史（在线/离线、首次/最后在线）
	_dev_dirty: false,
	_dev_saved: 0,
	pin_last: {},       // macnorm -> 上次固定 AP 纠正时间
	bss_list: null,     // SAP: CAP 下发的全网络 BSS 列表
	_bss_cache: null,   // CAP: 全网络 BSS 列表缓存
	_bss_sig: "",       // SAP: CAP 下发的 BSS 列表签名，变化时立即同步 11k 邻居库
	_own_nr: {},        // ifname -> { ts, nr }：本机 hostapd 的 own Neighbor Report 缓存
	net_names: {},      // SAP: CAP 下发的 macnorm -> { hostname, ip }（SAP 无 DHCP，名称需由 CAP 提供）
	roster: null,       // SAP: CAP 下发的全网络 AP/SSID 概览（用于开启前检查一致展示）
	blocked: {},        // CAP: 被暂停联网的终端 macnorm -> true
	ban: { enabled: false, list: [], active: {}, sig: "" }, // 上网时段（定时断网）
	usage: { day: "", online: {}, ndata: {}, ndir: {} }, // CAP: 每终端每日在线秒数 / 总流量 / 上下行
	_usage_snap: null,  // CAP: 上次 nft counter 快照 { mac: bytes }
	_usage_station_snap: null, // CAP: 上次站点计数快照 { mac: { rx, tx } }
	_usage_ts: 0,
	_usage_online_ts: 0,
	_usage_dirty: false,
	_usage_saved: 0,
	_usage_track: null,
	appctl: { enabled: false, enhanced: false, strict: false, devices: {}, stats: {}, day: "", online: {}, ndata: {} },
	_nft_snap: null,    // CAP: 上次 nft 计数快照 { "<mac>|<app>": { pk, by } }
	_dnslock_on: null,  // CAP: DNS 出口锁定链当前状态（null = 未同步，首轮强制对齐）
	_appstat_ts: 0,     // CAP: 上次采样时刻
	_appstat_dirty: false,
	_appstat_saved: 0,
	_track_key: "",     // CAP: 上次建规则时的终端集合签名
	_warm_list: null,   // CAP: 预热用的域名/主机名清单（扁平化）
	_warm_i: 0,         // CAP: 下次预热哪个
};

// ------------------------------------------------------------------ helpers
function log(msg) { printf("wifiroam: %s\n", msg); }

function macnorm(m) { return lc(replace(m ?? "", /[^0-9a-fA-F]/g, "")); }

function maccolon(mn) {
	if (length(mn) != 12) return mn;
	return uc(substr(mn,0,2)+":"+substr(mn,2,2)+":"+substr(mn,4,2)+":"+
	          substr(mn,6,2)+":"+substr(mn,8,2)+":"+substr(mn,10,2));
}

// xorshift32 伪随机（避免依赖 ucode-mod-math 的 rand/srand）
let rng_state = 0;
function srand(seed) {
	rng_state = int(seed) & 0x7fffffff;
	if (rng_state == 0) rng_state = 0x9e3779b9;
}
function rand() {
	rng_state ^= (rng_state << 13) & 0x7fffffff;
	rng_state ^= rng_state >> 17;
	rng_state ^= (rng_state << 5) & 0x7fffffff;
	return rng_state & 0x7fffffff;
}

function randhex(n) {
	let s = "";
	for (let i = 0; i < n; i++)
		s += sprintf("%x", rand() % 16);
	return s;
}

function cmd_output(cmd) {
	let f = fs.popen(cmd, "r");
	if (!f) return "";
	let out = f.read("all");
	f.close();
	return out ?? "";
}

/* 同一秒内复用昂贵的解析结果（leases / ip neigh / bridge fdb）。
   tick、ubus 请求和拓扑构建经常落在同一秒，缓存可显著减少 shell 调用。 */
function cached_sec(key, fn) {
	let now = time();
	let e = _sec_cache[key];
	if (e && e.ts == now) return e.data;
	let data = fn();
	_sec_cache[key] = { ts: now, data };
	return data;
}

function push_event(type, mac, info, name, extra) {
	let ev = { ts: time(), type, mac: mac ?? "", name: name ?? "", info: info ?? "" };
	if (extra != null)
		for (let k, v in extra)
			ev[k] = v;
	push(state.events, ev);
	if (length(state.events) > MAX_EVENTS)
		state.events = slice(state.events, length(state.events) - MAX_EVENTS);
	log(sprintf("event %s %s %s %s", type, mac ?? "-", name ?? "-", info ?? ""));
}

// 终端展示名：自定义别名 > 本机/对端主机名 > 本网络名称表 > MAC
// local 传入本次已有客户端表（local_clients / peer clients），避免重复扫描
function client_name_of(mn, local) {
	let al = state.aliases.map[mn];
	if (al?.name != null && al.name != "") return al.name;

	let c = local?.[mn];
	if (c?.hostname != null && c.hostname != "") return c.hostname;

	for (let pmn, p in state.peers) {
		let pc = p.clients?.[mn];
		if (pc?.hostname != null && pc.hostname != "") return pc.hostname;
	}

	let n = state.net_names?.[mn];
	if (n?.hostname != null && n.hostname != "") return n.hostname;

	return maccolon(mn);
}

function field_after(words, key) {
	let i = index(words, key);
	return i >= 0 ? words[i + 1] : null;
}

// ------------------------------------------------------------- uci handling
function load_config() {
	let cur = uci.cursor();
	cur.load("wifiroam");
	state.cfg = {
		enabled: cur.get("wifiroam", "core", "enabled") != "0",
		role: cur.get("wifiroam", "core", "role") ?? "unconfigured",
		token: cur.get("wifiroam", "core", "token") ?? "",
		cap_ip: cur.get("wifiroam", "core", "cap_ip") ?? "",
		cap_mac: cur.get("wifiroam", "core", "cap_mac") ?? "",
		name: cur.get("wifiroam", "core", "name") ?? "",
	};
	// 只有 SAP 需要记住主 AP 的 MAC；切换成 CAP 后清掉，避免误判
	if (state.cfg.role != "sap")
		state.cfg.cap_mac = "";
	state.roam_ver_applied = int(cur.get("wifiroam", "roam", "config_ver") ?? "0");
	state.backhaul_ver_applied = int(cur.get("wifiroam", "backhaul", "config_ver") ?? "0");
	let aver = int(cur.get("wifiroam", "alias_sync", "ver") ?? "0");
	if (aver > state.aliases.ver) state.aliases.ver = aver;
}

function save_config() {
	let cur = uci.cursor();
	cur.load("wifiroam");
	cur.set("wifiroam", "core", "role", state.cfg.role);
	cur.set("wifiroam", "core", "token", state.cfg.token);
	cur.set("wifiroam", "core", "cap_ip", state.cfg.cap_ip);
	cur.set("wifiroam", "core", "cap_mac", state.cfg.cap_mac);
	cur.set("wifiroam", "core", "name", state.cfg.name);
	cur.commit("wifiroam");
}

// 被主 AP 配对成子路由后，如果 luci-app-router-tool 已安装并提供了
// 「网络 → 接口 → 全局网络选项 → 中继 AP 模式」，就打开它。
// 该选项由 router-tool 的 LuCI 页面提供，实际保存在
// /etc/config/router-tool 的 main.ap_mode；没有这个配置时完全不动。
function enable_relay_ap_mode() {
	let cur = uci.cursor();
	cur.load("router-tool");

	// 没装 router-tool：没有 main 段，直接无视
	if (cur.get("router-tool", "main") == null)
		return false;

	if (cur.get("router-tool", "main", "ap_mode") == "1")
		return false;

	cur.set("router-tool", "main", "ap_mode", "1");
	cur.commit("router-tool");
	log("relay AP mode enabled (router-tool.main.ap_mode)");
	return true;
}

function rssi_preset(profile) {
	return { aggressive: -62, gaming: -67, balanced: -70, conservative: -78 }[profile] ?? -70;
}

function current_roam_cfg() {
	let cur = uci.cursor();
	cur.load("wifiroam");
	let ssids = [];
	let raw = cur.get("wifiroam", "roam", "ssids");
	if (type(raw) == "array") ssids = raw;
	else if (type(raw) == "string" && raw != "") ssids = [ raw ];
	let profile = cur.get("wifiroam", "roam", "rssi_profile") ?? "balanced";
	if (index([ "aggressive", "gaming", "balanced", "conservative", "custom" ], profile) < 0)
		profile = "balanced";
	let threshold = int(cur.get("wifiroam", "roam", "rssi_threshold") ?? rssi_preset(profile));
	if (profile != "custom") threshold = rssi_preset(profile);
	if (threshold > -30) threshold = -30;
	if (threshold < -95) threshold = -95;
	return {
		enabled: cur.get("wifiroam", "roam", "enabled") == "1",
		ssids,
		r_fast: cur.get("wifiroam", "roam", "r_fast") != "0",
		ft_mode: cur.get("wifiroam", "roam", "ft_mode") ?? "simple",
		ft_over_ds: cur.get("wifiroam", "roam", "ft_over_ds") != "0",
		k_neighbor: cur.get("wifiroam", "roam", "k_neighbor") != "0",
		k_beacon: cur.get("wifiroam", "roam", "k_beacon") != "0",
		v_bss_transition: cur.get("wifiroam", "roam", "v_bss_transition") != "0",
		rssi_profile: profile,
		rssi_threshold: threshold,
		config_ver: int(cur.get("wifiroam", "roam", "config_ver") ?? "0"),
	};
}

// 漫游配置内容签名：SAP 上报本地已落盘配置的签名，CAP 据此判断是否与主 AP 一致。
// 只比 ver 无法发现历史遗留的不一致（旧版 SAP 只落盘 ver/enabled，其他字段仍是默认值）。
function roam_sig_base(r) {
	return sprintf("%d|%s|%d|%s|%d|%d|%d|%d|%s|%d",
		r.enabled ? 1 : 0, join(",", r.ssids ?? []), r.r_fast ? 1 : 0,
		r.ft_mode ?? "simple",
		r.ft_over_ds ? 1 : 0, r.k_neighbor ? 1 : 0, r.k_beacon ? 1 : 0,
		r.v_bss_transition ? 1 : 0, r.rssi_profile ?? "balanced",
		r.rssi_threshold ?? rssi_preset(r.rssi_profile));
}

/* 与旧版本互操作：旧 CAP 在 guest_selected=1 时会追加 "|guest"。
   本机仍保留该 UCI 值（只是不再提供访客漫游 UI/逻辑），
   计算签名时带上，保证和旧 CAP 的判断一致。 */
function roam_sig(r) {
	let cur = uci.cursor();
	cur.load("wifiroam");
	let guest = cur.get("wifiroam", "roam", "guest_selected") == "1";
	return sha256(roam_sig_base(r) + (guest ? "|guest" : ""));
}

/* 比较对端签名：新旧两种格式都接受，避免混版本时反复下发并重载无线 */
function roam_sig_ok(peer, r) {
	if (peer == "") return true;
	let base = roam_sig_base(r);
	return peer == sha256(base) || peer == sha256(base + "|guest");
}

function current_backhaul_cfg() {
	let cur = uci.cursor();
	cur.load("wifiroam");
	return {
		enabled: cur.get("wifiroam", "backhaul", "enabled") == "1",
		ssid: cur.get("wifiroam", "backhaul", "ssid") ?? BACKHAUL_DEFAULT_SSID,
		key: cur.get("wifiroam", "backhaul", "key") ?? "",
		device: cur.get("wifiroam", "backhaul", "device") ?? "",
		config_ver: int(cur.get("wifiroam", "backhaul", "config_ver") ?? "0"),
	};
}

// ------------------------------------------------------------ alias storage
function alias_load() {
	try {
		let data = json(fs.readfile(ALIAS_PATH));
		if (type(data) == "object") {
			state.aliases.map = data.map ?? {};
			state.aliases.pin = data.pin ?? {};
			if ((data.ver ?? 0) > state.aliases.ver)
				state.aliases.ver = data.ver;
		}
	} catch (e) { /* first boot */ }
}

function alias_save() {
	fs.mkdir(ALIAS_DIR);
	fs.writefile(ALIAS_PATH, sprintf("%.J", state.aliases));
	let cur = uci.cursor();
	cur.load("wifiroam");
	cur.set("wifiroam", "alias_sync", "ver", "" + state.aliases.ver);
	cur.commit("wifiroam");
}

/* 版本号单调递增：同一秒内连续改名 + 固定 AP 时，
   SAP 侧「ver 变大才更新」的判断仍能收到第二次变更 */
function alias_bump() {
	let now = time();
	state.aliases.ver = (state.aliases.ver >= now) ? state.aliases.ver + 1 : now;
}

// ---------------------------------------------------------- AP pinning
function ap_name_of(mn) {
	if (mn == "") return state.self.name;
	let al = state.aliases.map[mn];
	if (al?.name != null && al.name != "") return al.name;
	if (mn == macnorm(state.self.mac)) return state.self.name;
	let p = state.peers[mn];
	if (!p) return mn;
	return p.info?.name ?? p.name ?? mn;
}

function pin_of(mn) {
	return state.aliases.pin?.[mn] ?? null;
}

function pin_apply(mac, ap) {
	let mn = macnorm(mac);
	if (length(mn) != 12) return { ok: false, error: "invalid_mac" };

	ap = trim("" + (ap ?? ""));
	let target = "";
	if (ap != "") {
		target = macnorm(ap);
		if (length(target) != 12) return { ok: false, error: "invalid_ap" };
		let self_mn = macnorm(state.self.mac);
		if (target != self_mn && !state.peers[target])
			return { ok: false, error: "unknown_ap" };
	}

	if (!state.aliases.pin) state.aliases.pin = {};
	if (target == "") delete state.aliases.pin[mn];
	else state.aliases.pin[mn] = target;
	alias_bump();
	alias_save();
	return { ok: true, mac: mn, ap: target };
}

function alias_apply(mac, name, icon, note) {
	let mn = macnorm(mac);
	if (length(mn) != 12) return false;
	if ((name ?? "") == "" && !icon && !note)
		delete state.aliases.map[mn];
	else
		state.aliases.map[mn] = {
			name: name ?? "", icon: icon ?? null, note: note ?? null,
		};
	alias_bump();
	alias_save();
	return true;
}

function alias_broadcast() {
	if (state.cfg.role != "cap") return;
	for (let mn, p in state.peers) {
		if (!p.authed || !p.chan) continue;
		try {
			p.chan.defer({
				method: "push_aliases",
				data: { aliases: state.aliases },
				data_cb: function() {}, cb: function() {},
			});
		} catch (e) {
			p.authed = false;
			p.chan = null;
			if (p.conn) { let c = p.conn; p.conn = null; conn_close(c); }
		}
	}
}

// ------------------------------------------------------ app access control
function appctl_app(id) {
	for (let a in APP_DEFS)
		if (a.id == id) return a;
	return null;
}

function appctl_read_devices() {
	let cur = uci.cursor();
	cur.load("wifiroam");
	let devs = {};
	cur.foreach("wifiroam", "appdev", function(s) {
		let mn = macnorm(s.mac ?? "");
		if (length(mn) != 12) return;
		let b = s.block, blocks = [];
		if (type(b) == "array") blocks = b;
		else if (type(b) == "string" && b != "") blocks = [ b ];
		devs[mn] = { name: s.name ?? "", block: blocks };
	});
	state.appctl.devices = devs;
	return devs;
}

// 写回某终端的禁止应用列表；列表空时删除 section（等价于不再关注该设备）
function appctl_write_device(mn, blocks, name) {
	let cur = uci.cursor();
	cur.load("wifiroam");
	let sid = null;
	cur.foreach("wifiroam", "appdev", function(s) {
		if (macnorm(s.mac ?? "") == mn) sid = s[".name"];
	});
	if (!length(blocks)) {
		if (sid) {
			cur.delete("wifiroam", sid);
			cur.commit("wifiroam");
		}
		return;
	}
	if (!sid) sid = cur.add("wifiroam", "appdev");
	cur.set("wifiroam", sid, "mac", mn);
	if (name != null && name != "") cur.set("wifiroam", sid, "name", name);
	cur.set("wifiroam", sid, "block", blocks);
	cur.commit("wifiroam");
}

// 把应用域名同步到 dhcp 配置，让 dnsmasq 把解析结果写入 nft 集合。
// 本固件 dnsmasq 的 init 脚本只认独立的 `config ipset` section
// （dnsmasq_ipset_add 读 table/table_family/family/name/domain），
// 不识别 dhcp.@dnsmasq[0].nftset；因此每个应用建一个 section。
// 返回 true 表示配置有变化、需要重启 dnsmasq 才生效。
function appctl_dnsmasq_sync(on) {
	let cur = uci.cursor();
	cur.load("dhcp");
	let changed = false;

	let as_list = function(v) {
		if (type(v) == "array") return v;
		if (type(v) == "string" && v != "") return [ v ];
		return [];
	};

	// 清掉早期版本写入 @dnsmasq[0].nftset 的残留（该选项在此固件无效）
	let legacy = as_list(cur.get("dhcp", "@dnsmasq[0]", "nftset"));
	let keep = [];
	for (let v in legacy)
		if (index(v, "#" + APPCTL_TABLE + "#") < 0)
			push(keep, v);
	if (length(keep) != length(legacy)) {
		if (length(keep)) cur.set("dhcp", "@dnsmasq[0]", "nftset", keep);
		else cur.delete("dhcp", "@dnsmasq[0]", "nftset");
		changed = true;
	}

	for (let a in APP_DEFS) {
		let sid = "wifiroam_" + a.id;

		// 过渡清理：曾把 v6 单独建段，但 dnsmasq 的 domain_find_sets() 对同一域名
		// 只返回一条匹配项（等长时后者覆盖前者），拆成两段会导致只有一个 family
		// 生效。正确做法是同一段里放两个集合名。
		if (cur.get("dhcp", sid + "_v6") != null) {
			cur.delete("dhcp", sid + "_v6");
			changed = true;
		}

		if (!on) {
			if (cur.get("dhcp", sid) != null) {
				cur.delete("dhcp", sid);
				changed = true;
			}
			continue;
		}

		// family 必须留空：init 脚本的 add_nftset 会按集合名后缀 _v4/_v6 逐个
		// 推断地址族；若写死 family=4，会把 v6 集合也标成 4#。
		if (cur.get("dhcp", sid, "family") != null) {
			cur.delete("dhcp", sid, "family");
			changed = true;
		}

		let want = {
			table: APPCTL_TABLE,
			table_family: "inet",
			name: [ a.id + "_v4", a.id + "_v6" ],
			domain: a.domains,
		};

		// 已有配置完全一致时跳过，避免每次开关都无谓重启 dnsmasq
		let same = true;
		for (let k, v in want) {
			let have = as_list(cur.get("dhcp", sid, k));
			let need = as_list(v);
			if (length(have) != length(need)) { same = false; break; }
			for (let i = 0; i < length(need); i++)
				if (have[i] != need[i]) { same = false; break; }
			if (!same) break;
		}
		if (same) continue;

		// uci 不会为不存在的 section 隐式建段，先按类型创建
		if (cur.get("dhcp", sid) == null)
			cur.set("dhcp", sid, "ipset");
		for (let k, v in want)
			cur.set("dhcp", sid, k, v);
		changed = true;
	}

	if (!changed) return false;
	cur.commit("dhcp");
	return true;
}

// 精准模式（高级设置开关）：活跃判定更严、集合超时更短、锁定 DNS 出口。
// 关闭时保持宽松口径，行为与旧版一致。
function appctl_enhanced() {
	return state.appctl.enhanced == true;
}

/* 严格模式（高级设置开关）：对启用了应用管控的终端，额外阻断可绕过
   DNS/SNI 识别的通道（QUIC、外部 DNS、已知 DoH），提高拦截准确率。 */
function appctl_strict() {
	return state.appctl.strict == true;
}

function appctl_timeout() {
	return appctl_enhanced() ? APP_SET_TIMEOUT_ENH : APP_SET_TIMEOUT;
}

// 升级旧集合：早期版本没有默认超时，DNS 写入的 IP 会永久驻留，CDN 回收
// 地址后会被误算到原应用。用标记文件记录当前生效的默认超时（精准 30m /
// 宽松 12h），不一致时执行一次：nft 表跨进程重启保留，旧规则仍引用集合
// 会导致 delete 失败，所以先清空规则链再删集合，由 appctl_nft_base 按新
// 结构重建，元素随预热解析重新填回。
function appctl_nft_schema() {
	if (fs.readfile(APPCTL_SCHEMA_PATH) == appctl_timeout()) return false;
	cmd_output(sprintf("nft flush chain inet %s forward 2>/dev/null", APPCTL_TABLE));
	for (let a in APP_DEFS)
		for (let fam in [ "v4", "v6" ])
			cmd_output(sprintf("nft delete set inet %s %s_%s 2>/dev/null",
			                   APPCTL_TABLE, a.id, fam));
	fs.mkdir(ALIAS_DIR);
	fs.writefile(APPCTL_SCHEMA_PATH, appctl_timeout());
	// 集合被重建，dnsmasq 缓存的句柄可能失效，需要重启后重新绑定
	return true;
}

// 幂等创建表 / 集合 / 转发链。已存在时 nft 报错被丢弃，不影响后续。
// 集合带默认 timeout：dnsmasq 写元素时不带显式超时，内核会按集合默认值计时，
// 超时内无新解析即自动过期，避免旧 IP 被复用后长期误归属。
// 精准模式 30m / 宽松模式 12h（appctl_timeout）。
function appctl_nft_base() {
	cmd_output(sprintf("nft add table inet %s 2>/dev/null", APPCTL_TABLE));
	for (let a in APP_DEFS) {
		cmd_output(sprintf(
			"nft add set inet %s %s_v4 '{ type ipv4_addr; flags interval; timeout %s; }' 2>/dev/null",
			APPCTL_TABLE, a.id, appctl_timeout()));
		// IPv6 必须单独建集合：iptables 时代的 ip daddr 规则完全匹配不到 v6 流量，
		// 实测手机 8 秒内 211 个 v6 包 vs 6 个 v4 包，缺 v6 等于完全不生效
		cmd_output(sprintf(
			"nft add set inet %s %s_v6 '{ type ipv6_addr; flags interval; timeout %s; }' 2>/dev/null",
			APPCTL_TABLE, a.id, appctl_timeout()));
	}
	cmd_output(sprintf(
		"nft add chain inet %s forward '{ type filter hook forward priority -10; policy accept; }' 2>/dev/null",
		APPCTL_TABLE));
	// NFQUEUE 返回 accept 会终止当前链，queue 之后的规则不再执行。
	// 因此把 packet mark -> ct mark 的复制放到 -5（晚于 -10、早于防火墙 filter）
	// 的独立链，队列放行的包重入后才会走到这里。
	cmd_output(sprintf(
		"nft add chain inet %s fwpost '{ type filter hook forward priority -5; policy accept; }' 2>/dev/null",
		APPCTL_TABLE));
}

// 重建规则：集合与元素保留（dnsmasq 填好的 IP 不会被清空），仅刷新 chain。
// 每条 (终端, 应用) 规则都带 counter 用于时长统计；禁止的额外 drop。
// IPv4 与 IPv6 各一条，comment 相同，采样时按 key 累加。
function appctl_apply_rules() {
	appctl_nft_base();
	let devs = appctl_read_devices();
	let set = appctl_track_macs();
	let script = sprintf("flush chain inet %s forward\nflush chain inet %s fwpost\n",
	                     APPCTL_TABLE, APPCTL_TABLE);
	for (let mn in set) {
		let d = devs[mn];
		let has_block = d != null && length(d.block) > 0;
		// 统计规则必须排在 DPI 之前：队列放行的包会终止本链，
		// 后面的规则不再执行，否则被管控终端的应用时长会几乎归零。
		for (let a in APP_DEFS) {
			let blocked = d != null && index(d.block, a.id) >= 0;
			for (let fam in [ "v4", "v6" ]) {
				script += sprintf(
					"add rule inet %s forward ether saddr %s %s daddr @%s_%s counter%s comment \"wr:%s:%s:%s\"\n",
					APPCTL_TABLE, maccolon(mn), (fam == "v4") ? "ip" : "ip6",
					a.id, fam, blocked ? " drop" : "",
					mn, a.id, blocked ? "block" : "allow");
			}
		}
		// 本终端总流量（不受 daddr 限制），用于反推「未识别应用」的用量：
		// 允许类规则没有 verdict，包会继续走到这条，所以 total 含已识别部分。
		// 被 drop 的禁止流量不会到这里，符合「禁止不计入使用」的预期。
		script += sprintf(
			"add rule inet %s forward ether saddr %s counter comment \"wr:%s:*:total\"\n",
			APPCTL_TABLE, maccolon(mn), mn);
		// 严格模式：在 DPI 队列之前丢弃可绕过识别的通道。必须排在
		// ct mark accept 快速路径之前，否则已被 DPI 放行的流会跳过这些规则。
		if (has_block && appctl_strict()) {
			let gw = state.self.ip ?? "";
			// QUIC：阻断 UDP 443，迫使应用回落 TCP/TLS，便于按 SNI 识别
			script += sprintf(
				"add rule inet %s forward ether saddr %s udp dport 443 counter drop\n",
				APPCTL_TABLE, maccolon(mn));
			// 外部 DNS：只允许发往本机 dnsmasq（v6 地址不固定，直接全禁）
			if (match(gw, /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/)) {
				script += sprintf(
					"add rule inet %s forward ether saddr %s udp dport 53 ip daddr != %s counter drop\n" +
					"add rule inet %s forward ether saddr %s tcp dport 53 ip daddr != %s counter drop\n",
					APPCTL_TABLE, maccolon(mn), gw,
					APPCTL_TABLE, maccolon(mn), gw);
			}
			script += sprintf(
				"add rule inet %s forward ether saddr %s meta nfproto ipv6 udp dport 53 counter drop\n" +
				"add rule inet %s forward ether saddr %s meta nfproto ipv6 tcp dport 53 counter drop\n",
				APPCTL_TABLE, maccolon(mn),
				APPCTL_TABLE, maccolon(mn));
			// 静态 DoH 地址（Cloudflare 1.1.1.1 同时承载网页服务，清单里未收录）
			script += sprintf(
				"add rule inet %s forward ether saddr %s ip daddr { %s } tcp dport 443 counter drop\n" +
				"add rule inet %s forward ether saddr %s ip6 daddr { %s } tcp dport 443 counter drop\n",
				APPCTL_TABLE, maccolon(mn), join(", ", APP_DOH_V4),
				APPCTL_TABLE, maccolon(mn), join(", ", APP_DOH_V6));
		}
		// 对有被禁应用的终端，把新建连接首包送 DPI 解析 SNI：
		//   - ct mark 0x1 = 已放行 (dpi 返回 accept 时携带)，命中即走快速路径
		//   - 被拦截的包 dpi 直接 drop，不设 mark，靠其流缓存丢弃后续重传
		//   - tcp 只送首个带载荷的数据包 (ACK & payload)；udp 送首包
		//   - 队列返回后由 fwpost 链把 packet mark 复制到 ct mark
		//     （meta mark 为 0 的普通包不复制，避免把已标记的流冲掉）
		if (has_block) {
			script += sprintf(
				"add rule inet %s forward ether saddr %s ct mark & 0x3 == 0x1 accept\n" +
				"add rule inet %s forward ether saddr %s ct state established " +
					"tcp flags & (fin|syn|rst|ack) == ack queue num %d\n" +
				"add rule inet %s forward ether saddr %s ct state new meta l4proto udp queue num %d\n" +
				"add rule inet %s fwpost ether saddr %s meta mark != 0 ct mark set meta mark\n",
				APPCTL_TABLE, maccolon(mn),
				APPCTL_TABLE, maccolon(mn), DPI_QUEUE,
				APPCTL_TABLE, maccolon(mn), DPI_QUEUE,
				APPCTL_TABLE, maccolon(mn));
		}
	}
	fs.writefile(APPCTL_NFT_FILE, script);
	cmd_output(sprintf("nft -f %s 2>/dev/null", APPCTL_NFT_FILE));
	fs.unlink(APPCTL_NFT_FILE);
	// chain 重建会把 counter 归零，重置快照避免把归零误判成「无流量」
	state._nft_snap = null;
	state._appstat_ts = 0;
	state._track_key = join(",", sort(keys(set)));
}

/* 硬件 flow offload 与统计不可兼得：MTK hnat 卸载后流量不再经过 netfilter
   forward 链，应用统计只能看到流建立时的首包（软件 flowtable 在 priority 0，
   晚于本插件的 -10，不受影响，可保留）。精准模式开启时自动挂起 hw offload，
   退出时恢复。只操作本机：统计发生在 CAP 的 forward 链，SAP 不做三层转发，
   其 hw 状态与统计无关。hw_suspended 标记记录「是我们关的」，避免覆盖
   用户手动关闭的设置。 */
function appctl_hw_suspend(on) {
	let cur = uci.cursor();
	cur.load("firewall");
	if (cur.get("firewall", "@defaults[0]") == null) return false;
	let hw_on = cur.get("firewall", "@defaults[0]", "flow_offloading_hw") == "1";
	let cur2 = uci.cursor();
	cur2.load("wifiroam");
	let marked = cur2.get("wifiroam", "appctl", "hw_suspended") == "1";
	if (on) {
		if (!hw_on || marked) return false;   // 本来就关着/已挂起：不动
		cur.set("firewall", "@defaults[0]", "flow_offloading_hw", "0");
		cur.commit("firewall");
		if (cur2.get("wifiroam", "appctl") == null)
			cur2.set("wifiroam", "appctl", "appctl");
		cur2.set("wifiroam", "appctl", "hw_suspended", "1");
		cur2.commit("wifiroam");
	} else {
		if (!marked) return false;           // 不是我们挂起的：别动用户设置
		cur.set("firewall", "@defaults[0]", "flow_offloading_hw", "1");
		cur.commit("firewall");
		cur2.delete("wifiroam", "appctl", "hw_suspended");
		cur2.commit("wifiroam");
	}
	return true;
}

/* ---------- DPI ---------- */
/* 把「有被禁应用的终端 → 该终端所有被禁应用的域名」写到 blocklist，
   wifiroam-dpi 读取后对匹配 SNI 的连接 drop。
   格式：每行 <mac> <dom1>,<dom2>,...
   域名来自 APP_DEFS[*].domains（只取被禁应用的）。 */
function appctl_dpi_write_blocklist() {
	let devs = appctl_read_devices();
	let lines = [];
	for (let mn in devs) {
		let d = devs[mn];
		if (!d || !length(d.block)) continue;
		let doms = {};
		for (let bid in d.block) {
			let a = appctl_app(bid);
			if (!a) continue;
			for (let dmn in a.domains) doms[dmn] = true;
		}
		if (!length(keys(doms))) continue;
		push(lines, sprintf("%s %s", maccolon(mn), join(",", keys(doms))));
	}
	fs.mkdir("/tmp/wifiroam");
	fs.writefile(DPI_BLOCKLIST, join("\n", lines) + "\n");
}

/* Resolve the actual running wifiroam-dpi PID.  The PID file may be
 * stale (e.g. daemon restarted by a different path), so fall back to
 * pidof which scans /proc.  Returns "" if not running. */
function appctl_dpi_pid() {
	let live = trim(cmd_output("pidof wifiroam-dpi 2>/dev/null"));
	if (live != "") return split(live, " ")[0];   /* first match */
	let pid = fs.readfile(DPI_PIDFILE);
	if (pid && cmd_output(sprintf("kill -0 %s 2>/dev/null && echo 1", trim(pid))) == "1")
		return trim(pid);
	return "";
}

/* 管理 wifiroam-dpi 守护进程。action: start|stop|reload */
function appctl_dpi_daemon(action) {
	if (action == "stop") {
		let pid = appctl_dpi_pid();
		if (pid != "") cmd_output(sprintf("kill %s 2>/dev/null", pid));
		fs.unlink(DPI_PIDFILE);
		return;
	}
	let pid = appctl_dpi_pid();
	let running = pid != "";
	if (action == "reload") {
		if (running) {
			appctl_dpi_write_blocklist();
			cmd_output(sprintf("kill -HUP %s 2>/dev/null", pid));
		}
		return;
	}
	/* start */
	appctl_dpi_write_blocklist();
	if (running) {
		/* Already running: blocklist was just rewritten, notify the
		 * daemon so it picks up the new domain set.  (Without this,
		 * a wifiroamd restart leaves the daemon serving the stale
		 * in-memory blocklist.) */
		cmd_output(sprintf("kill -HUP %s 2>/dev/null", pid));
		return;
	}
	// 不能让后台 DPI 持有 popen 的输出管道，否则读不到 EOF，ubus 无法继续处理请求。
	cmd_output(sprintf("%s </dev/null >/dev/null & echo $! > %s", DPI_DAEMON, DPI_PIDFILE));
}

function appctl_table_remove() {
	let removed = system(sprintf("nft delete table inet %s 2>/dev/null", APPCTL_TABLE)) == 0;
	appctl_dpi_daemon("stop");
	state._nft_snap = null;
	state._appstat_ts = 0;
	state._track_key = "";
	state._dnslock_on = false;
	return removed;
}

/* DNS 出口锁定（精准模式）：把客户端侧的 53 重定向到本机 dnsmasq，
   拦截 DoT(853) 与知名公共 DoH 的 443，防止 App 用内置 HTTPDNS/私有 DNS
   绕过路由器解析（域名识别最大的漏网来源）。
   只匹配 br-lan / br-guest 入方向，路由器自身出向不受影响；
   redirect 的回包由 conntrack 自动改回原始源地址，客户端无感知。
   实测内核不支持规则内带 timeout 的集合元素刷新，故只锁 DNS 不做刷新。 */
function appctl_dnslock_apply(on) {
	if (on == state._dnslock_on) return;
	state._dnslock_on = on;
	// 先单独清旧链：链不存在/非空的报错由 shell 吞掉（nft -f 遇错会中止
	// 整个文件，不能把幂等清理和创建放进同一脚本）
	cmd_output(sprintf("nft flush chain inet %s dnsnat 2>/dev/null; nft delete chain inet %s dnsnat 2>/dev/null",
		APPCTL_TABLE, APPCTL_TABLE));
	cmd_output(sprintf("nft flush chain inet %s dnslock 2>/dev/null; nft delete chain inet %s dnslock 2>/dev/null",
		APPCTL_TABLE, APPCTL_TABLE));
	if (!on) return;
	let iifs = sprintf('{ "%s", "%s" }', state.brdev, GUEST_BRIDGE);
	// 注意：这是 nft -f 脚本（无 shell），块定义不能带单引号
	let script = sprintf(
		"add chain inet %s dnsnat { type nat hook prerouting priority dstnat; policy accept; }\n" +
		"add chain inet %s dnslock { type filter hook prerouting priority -5; policy accept; }\n" +
		"add rule inet %s dnsnat iifname %s udp dport 53 counter redirect\n" +
		"add rule inet %s dnsnat iifname %s tcp dport 53 counter redirect\n" +
		"add rule inet %s dnsnat iifname %s meta nfproto ipv6 udp dport 53 counter redirect\n" +
		"add rule inet %s dnsnat iifname %s meta nfproto ipv6 tcp dport 53 counter redirect\n" +
		"add rule inet %s dnslock iifname %s meta l4proto { tcp, udp } th dport 853 counter drop\n" +
		"add rule inet %s dnslock iifname %s ip daddr { %s } tcp dport 443 counter drop\n" +
		"add rule inet %s dnslock iifname %s ip6 daddr { %s } tcp dport 443 counter drop\n",
		APPCTL_TABLE, APPCTL_TABLE,
		APPCTL_TABLE, iifs, APPCTL_TABLE, iifs,
		APPCTL_TABLE, iifs, APPCTL_TABLE, iifs,
		APPCTL_TABLE, iifs,
		APPCTL_TABLE, iifs, join(", ", APP_DOH_V4),
		APPCTL_TABLE, iifs, join(", ", APP_DOH_V6));
	fs.writefile(APPCTL_NFT_FILE, script);
	cmd_output(sprintf("nft -f %s 2>/dev/null", APPCTL_NFT_FILE));
	fs.unlink(APPCTL_NFT_FILE);
}

// 按天分桶只保留最近 7 天：日期字符串字典序即时间序，删最旧的
function prune_days(map, keep) {
	let ks = sort(keys(map));
	while (length(ks) > (keep ?? 7)) {
		delete map[ks[0]];
		shift(ks);
	}
}

function appctl_roll_day() {
	let lt = localtime(time());
	let day = sprintf("%04d-%02d-%02d", lt.year, lt.mon, lt.mday);
	if (state.appctl.day == day) return;
	state.appctl.day = day;
	for (let mn, apps in state.appctl.stats)
		for (let app, v in apps) {
			v.today = 0;
			v.btoday = 0;
			if (v.days) prune_days(v.days);
			if (v.bdays) prune_days(v.bdays);
		}
	for (let mn, d in state.appctl.online)
		prune_days(d);
	for (let mn, d in state.appctl.ndata)
		prune_days(d);
	state._appstat_dirty = true;
}

function appctl_add_time(mn, app, dt, now) {
	if (!state.appctl.stats[mn]) state.appctl.stats[mn] = {};
	if (!state.appctl.stats[mn][app])
		state.appctl.stats[mn][app] = { today: 0, total: 0, last: 0 };
	let v = state.appctl.stats[mn][app];
	v.today += dt;
	v.total += dt;
	v.last = now;
	if (!v.days) v.days = {};
	v.days[state.appctl.day] = (v.days[state.appctl.day] ?? 0) + dt;
	state._appstat_dirty = true;
}

// 应用流量（字节）：按天分桶，与时长分开存放，老数据没有这些字段时按 0 处理
function appctl_add_bytes(mn, app, by, now) {
	if (by <= 0) return;
	if (!state.appctl.stats[mn]) state.appctl.stats[mn] = {};
	if (!state.appctl.stats[mn][app])
		state.appctl.stats[mn][app] = { today: 0, total: 0, last: 0 };
	let v = state.appctl.stats[mn][app];
	v.btoday = (v.btoday ?? 0) + by;
	v.btotal = (v.btotal ?? 0) + by;
	if (!v.bdays) v.bdays = {};
	v.bdays[state.appctl.day] = (v.bdays[state.appctl.day] ?? 0) + by;
	state._appstat_dirty = true;
}

// 终端总流量（含未识别应用），用于在界面上展示「其他」的用量
function appctl_add_traffic(mn, by) {
	if (by <= 0) return;
	if (!state.appctl.ndata[mn]) state.appctl.ndata[mn] = {};
	let d = state.appctl.ndata[mn];
	d[state.appctl.day] = (d[state.appctl.day] ?? 0) + by;
	state._appstat_dirty = true;
}

// 每轮取一次 nft counter 快照（包数与字节），达到阈值的应用才累加时长，
// 时间按实际差值累加（不按固定 TICK 累加，避免调度漂移累积误差）。
function appctl_sample() {
	if (state.cfg.role != "cap" || !state.appctl.enabled) return;
	let out = cmd_output(sprintf("nft -j list table inet %s 2>/dev/null", APPCTL_TABLE));
	if (out == "") return;
	let data;
	try { data = json(out); } catch (e) { return; }
	if (type(data) != "object" || type(data.nftables) != "array") return;

	let now = time();
	let dt = now - state._appstat_ts;
	if (!state._appstat_ts || dt <= 0 || dt > 180)
		dt = int(TICK_INTERVAL / 1000);

	let snap = state._nft_snap ?? {};
	let fresh = {};
	let owner = {};

	for (let item in data.nftables) {
		let r = item.rule;
		if (!r) continue;
		let p = split(r.comment ?? "", ":");
		if (length(p) != 4 || p[0] != "wr") continue;
		let mn = p[1], app = p[2], verdict = p[3];
		let pk = 0, by = 0;
		for (let e in r.expr)
			if (e.counter) {
				pk = int(e.counter.packets ?? 0);
				by = int(e.counter.bytes ?? 0);
				break;
			}
		// v4/v6 两条规则 comment 相同，必须累加；直接赋值会让后者覆盖前者
		let key = mn + "|" + app;
		let f = fresh[key];
		if (!f) {
			f = { pk: 0, by: 0, block: false };
			fresh[key] = f;
		}
		f.pk += pk;
		f.by += by;
		if (verdict == "block") f.block = true;
		owner[key] = [ mn, app ];
	}

	for (let key, t in fresh) {
		let prev = snap[key];
		// 计数被清零（规则重建 / 服务重启）时跳过本轮，避免把归零当增量
		if (!prev || t.pk < prev.pk) continue;
		let dpk = t.pk - prev.pk;
		let dby = t.by - (prev.by ?? 0);
		if (dby < 0) dby = 0;
		let mn = owner[key][0], app = owner[key][1];
		// 被禁止的流量是「拦截尝试」，既不算流量也不算使用时长
		if (t.block) continue;
		if (app == "*") {
			appctl_add_traffic(mn, dby);
			continue;
		}
		appctl_add_bytes(mn, app, dby, now);
		// 达标才算「在使用」：单包心跳、SDK 保活不再被计成整窗口时长。
		// 精准模式要求包数与字节同时达标（且关系），锁屏长连接心跳（
		// 一个窗口内通常只有零星小包）不再被误判为使用
		let active;
		if (appctl_enhanced())
			active = (dpk >= APP_ACT_ENH_PK && dby >= APP_ACT_ENH_BYTES);
		else
			active = (dpk >= APP_ACT_MIN_PK || dby >= APP_ACT_MIN_BYTES);
		if (active)
			appctl_add_time(mn, app, dt, now);
	}

	state._nft_snap = fresh;
	state._appstat_ts = now;
}

function appstats_load() {
	try {
		let d = json(fs.readfile(APPSTATS_PATH));
		if (type(d) == "object") {
			state.appctl.stats = d.stats ?? {};
			state.appctl.day = d.day ?? "";
			state.appctl.online = d.online ?? {};
			state.appctl.ndata = d.ndata ?? {};
		}
	} catch (e) { /* first boot */ }
}

function appstats_save() {
	fs.mkdir(ALIAS_DIR);
	fs.writefile(APPSTATS_PATH, sprintf("%.J", {
		ver: 1, day: state.appctl.day, stats: state.appctl.stats,
		online: state.appctl.online, ndata: state.appctl.ndata,
	}));
	state._appstat_dirty = false;
	state._appstat_saved = time();
}

// 客户端常用 App 内置 HTTPDNS 或外部 DNS，dnsmasq 看不到这些查询，集合长期
// 只有零星 IP，规则自然拦不住。这里由路由器自己周期性解析应用域名：dnsmasq
// 的 nftset 对任何来源的应答都会写集合，等于替客户端补一次 DNS。
function appctl_warm_list() {
	let out = [];
	// 具体主机（probes）先解析：它们才是真正承载视频的 CDN 入口
	for (let a in APP_DEFS)
		for (let d in (a.probes ?? []))
			push(out, d);
	for (let a in APP_DEFS) {
		for (let d in a.domains) {
			push(out, d);
			push(out, "www." + d);
		}
	}
	return out;
}

function appctl_warm_step() {
	if (state._warm_list == null)
		state._warm_list = appctl_warm_list();
	let list = state._warm_list;
	if (!length(list)) return;
	let host = list[state._warm_i % length(list)];
	state._warm_i++;
	// 每个 tick 只解析一个主机，避免一次性几十次查询拖住主循环
	cmd_output(sprintf("timeout 3 nslookup %s 127.0.0.1 >/dev/null 2>&1", host));
}

function appctl_tick() {
	appctl_roll_day();
	online_sample();
	if (state.cfg.role == "cap" && state.appctl.enabled) {
		// 在线终端变化（入网/离网/漫游）时重建规则，新终端立即纳入统计
		let set = appctl_track_macs();
		if (join(",", sort(keys(set))) != state._track_key)
			appctl_apply_rules();
		appctl_warm_step();
		// 精准模式的 DNS 出口锁定：幂等，状态变化时才重建链
		appctl_dnslock_apply(appctl_enhanced());
	}
	appctl_sample();
	if (state._appstat_dirty && time() - state._appstat_saved >= APPSTATS_FLUSH)
		appstats_save();
}

let appctl_service_proc;
let appctl_firewall_pending = false, appctl_dns_pending = false;

// 慢速的服务重载不能阻塞 ubus；串行执行，期间的新改动在下一轮应用。
function appctl_reload_services(firewall, dnsmasq) {
	appctl_firewall_pending = appctl_firewall_pending || firewall;
	appctl_dns_pending = appctl_dns_pending || dnsmasq;
	if (appctl_service_proc || (!appctl_firewall_pending && !appctl_dns_pending)) return;

	let service = appctl_firewall_pending ? "firewall" : "dnsmasq";
	let action = appctl_firewall_pending ? "reload" : "restart";
	if (appctl_firewall_pending) appctl_firewall_pending = false;
	else appctl_dns_pending = false;

	appctl_service_proc = uloop.process("/etc/init.d/" + service, [action], getenv(), function(code) {
		if (code != 0) log(sprintf("appctl: %s %s failed (%d)", service, action, code));
		appctl_service_proc = null;
		appctl_reload_services(false, false);
	});
	if (!appctl_service_proc) log(sprintf("appctl: could not start %s %s", service, action));
}

function appctl_apply() {
	let on = state.appctl.enabled;
	let enh = on && appctl_enhanced();
	let dns_changed = appctl_dnsmasq_sync(on);
	if (on) {
		// 集合结构变更时，dnsmasq 需要重新绑定集合。
		if (appctl_nft_schema()) dns_changed = true;
		appctl_apply_rules();
		appctl_dpi_daemon("start");
		appctl_dnslock_apply(enh);
	} else if (appctl_table_remove()) {
		// 旧版关闭中断后，磁盘配置可能已清理，但 dnsmasq 仍引用旧集合。
		dns_changed = true;
	}
	appctl_reload_services(appctl_hw_suspend(enh), dns_changed);
}

function appctl_load() {
	let cur = uci.cursor();
	cur.load("wifiroam");
	state.appctl.enabled = cur.get("wifiroam", "appctl", "enabled") == "1";
	state.appctl.enhanced = cur.get("wifiroam", "appctl", "enhanced") == "1";
	state.appctl.strict = cur.get("wifiroam", "appctl", "strict") == "1";
	appctl_read_devices();
	appstats_load();
	if (state.cfg.role == "cap") appctl_apply();
}

// ------------------------------------------------- flow offloading (network)
// 软件与硬件 offload 必须一起改：只关 hw 时软件 flowtable 依然会绕过规则。
// 值未变化时不 reload，避免跨 AP 每次同步都重建 flowtable 打断在用连接。
function offload_apply(on) {
	let cur = uci.cursor();
	cur.load("firewall");
	if (cur.get("firewall", "@defaults[0]") == null) return false;
	let want = on ? "1" : "0";
	let changed = cur.get("firewall", "@defaults[0]", "flow_offloading") != want ||
	              cur.get("firewall", "@defaults[0]", "flow_offloading_hw") != want;
	if (changed) {
		cur.set("firewall", "@defaults[0]", "flow_offloading", want);
		cur.set("firewall", "@defaults[0]", "flow_offloading_hw", want);
		cur.commit("firewall");
	}
	guest_fw4_sync(null, changed);
	return true;
}

/* 硬件/软件加速默认关闭：core.offload 为插件保存的开关，缺失时写入 0
   并立即应用，之后每次启动都按该值恢复。 */
function offload_default_init() {
	let cur = uci.cursor();
	cur.load("wifiroam");
	let pref = cur.get("wifiroam", "core", "offload");
	if (pref == null) {
		pref = "0";
		cur.set("wifiroam", "core", "offload", pref);
		cur.commit("wifiroam");
	}
	return offload_apply(pref == "1");
}

// ---------------------------------------------------------- self / sys info
// 由 LAN ip/mask 计算定向广播地址。网关设备默认路由走 WAN，
// 发 255.255.255.255 会被路由到 WAN 侧，必须用定向广播才能落在 LAN。
function lan_broadcast(ip, mask) {
	let parts = split(ip ?? "", ".");
	if (length(parts) != 4) return "255.255.255.255";
	let v = 0;
	for (let p in parts) v = (v << 8) | (int(p) & 255);
	let m = int(mask);
	// ucode 无 >>> 运算符；0xffffffff 在 int64 下为正数，>> 等效逻辑右移
	let hostmask = (m > 0 && m < 32) ? (0xffffffff >> m) : 0xff;
	let b = (v | hostmask) & 0xffffffff;
	return sprintf("%d.%d.%d.%d", (b >> 24) & 255, (b >> 16) & 255,
	               (b >> 8) & 255, b & 255);
}

// 本机所有网络接口 MAC：用于把 AP 自身的接口（如无线回程 STA 口）
// 从"下挂终端"中排除，避免 AP 被同时计为终端导致数量虚高
function local_iface_macs() {
	let out = {};
	for (let f in fs.glob("/sys/class/net/*/address")) {
		if (index(f, "/lo/") >= 0) continue;
		let m = macnorm(trim(fs.readfile(f) ?? ""));
		if (length(m) == 12 && m != "000000000000") out[m] = true;
	}
	return out;
}

function detect_self() {
	let st = ubusc.call("network.interface.lan", "status");
	let dev = st?.device ?? st?.l3_device ?? "br-lan";
	state.brdev = dev;
	let ip = st?.["ipv4-address"]?.[0]?.address ?? null;
	let mask = st?.["ipv4-address"]?.[0]?.mask ?? 24;
	state.bcast = lan_broadcast(ip, mask);
	let mac = trim(fs.readfile(`/sys/class/net/${dev}/address`) ?? "");
	if (length(macnorm(mac)) != 12) {
		for (let f in fs.glob("/sys/class/net/*/address")) {
			if (index(f, "/lo/") >= 0) continue;
			let m = trim(fs.readfile(f) ?? "");
			if (length(macnorm(m)) == 12) { mac = m; break; }
		}
	}
	let rel = fs.readfile("/etc/openwrt_release") ?? "";
	let fw = "OpenWrt";
	let m = match(rel, /DISTRIB_DESCRIPTION='([^']+)'/);
	if (m) fw = m[1];

	state.self = {
		mac: uc(mac),
		ip,
		hostname: trim(fs.readfile("/proc/sys/kernel/hostname") ?? "OpenWrt"),
		model: trim(fs.readfile("/tmp/sysinfo/model") ?? "OpenWrt device"),
		firmware: fw,
		nonce: randhex(16),
		ifaces: local_iface_macs(),
	};
	state.self.name = state.cfg.name != "" ? state.cfg.name : state.self.hostname;
	log(sprintf("self: %s %s %s bcast=%s", state.self.mac,
		state.self.ip ?? "?", state.self.name, state.bcast));
}

/* 中继 AP 模式下 router-tool 会把 lan 改为 proto dhcp。启动时租约可能
   还没拿到，运行中也可能重新获取；周期性刷新上报地址，避免一直显示
   旧的 lan 静态 IP。 */
function refresh_self_ip() {
	let st = ubusc.call("network.interface.lan", "status");
	let a = st?.["ipv4-address"]?.[0];
	if (!a?.address || a.address == state.self.ip)
		return false;
	state.self.ip = a.address;
	state.bcast = lan_broadcast(a.address, a.mask ?? 24);
	log("self ip updated: " + a.address);
	return true;
}

// 无线回程检测：优先看本插件托管的 STA 接口，其次看其它已关联的 STA。
// 仅当 STA 真实关联（iw link 显示 Connected）才算无线上行，避免把
// "配置了但没连上" 的接口误报成回程。
function wireless_uplink() {
	let ws = ubusc.call("network.wireless", "status") ?? {};
	let fallback = null;
	for (let rname, r in ws) {
		for (let ifc in r.interfaces ?? []) {
			if (ifc.config?.mode != "sta" || !ifc.ifname) continue;
			let link = cmd_output(sprintf("iw dev %s link 2>/dev/null", ifc.ifname));
			if (index(link, "Connected to") < 0) continue;
			let m = match(link, /Connected to ([0-9a-fA-F:]+)/);
			let s = match(link, /signal:\s*(-?[0-9]+)/);
			let info = {
				type: "wireless", port: ifc.ifname,
				device: rname,
				ssid: ifc.config?.ssid ?? null,
				bssid: m ? lc(m[1]) : null,
				rssi: s ? int(s[1]) : null,
				band: r.config?.band ?? r.config?.hwmode ?? "",
			};
			if (ifc.section == BACKHAUL_SECTION) return info;
			if (!fallback) fallback = info;
		}
	}
	return fallback;
}

function detect_uplink() {
	let out = cmd_output("ip route show default 2>/dev/null");
	let words = split(trim(split(out, "\n")[0] ?? ""), " ");
	let gw = field_after(words, "via");
	let dev = field_after(words, "dev");
	let wireless = dev && (fs.access(`/sys/class/net/${dev}/wireless`) ||
	                       index(dev, "wlan") == 0 || index(dev, "wl") == 0);
	let wl = wireless_uplink();
	// 本插件托管的无线回程已关联时，回程类型以它为准（即使物理上还有网线）
	if (wl && (wl.port == BACKHAUL_SECTION || current_backhaul_cfg().enabled))
		return { type: "wireless", port: wl.port, gw, ssid: wl.ssid,
		         bssid: wl.bssid, rssi: wl.rssi, band: wl.band };
	return { type: wireless ? "wireless" : "wired", port: dev, gw };
}

function self_uptime() {
	return int(split(trim(fs.readfile("/proc/uptime") ?? "0"), " ")[0]);
}

function wifi_ifaces() {
	let out = [];
	let cur = uci.cursor();
	cur.load("wireless");
	cur.foreach("wireless", "wifi-iface", function(s) {
		if (s.mode && s.mode != "ap") return;
		if (s.disabled == "1") return;
		if (s.wifiroam_guest == "1") return;   // 访客口不算主人网络
		push(out, {
			ssid: s.ssid ?? "",
			encryption: s.encryption ?? "none",
			band: cur.get("wireless", s.device, "band") ?? "?",
			device: s.device,
			section: s[".name"],
		});
	});
	return out;
}

// ------------------------------------------------------- radio band helpers
function channel_band_key(b) {
	b = "" + (b ?? "");
	if (index(b, "2") == 0 || index(b, "11g") == 0 || index(b, "11b") == 0) return "2g";
	if (index(b, "5") == 0 || index(b, "11a") == 0) return "5g";
	if (index(b, "6") == 0) return "6g";
	return b;
}

function channel_num(v) {
	let s = "" + (v ?? "");
	return match(s, /^[0-9]+$/) ? int(s) : 0;
}

// 本机 hostapd 的 own Neighbor Report：包含正确的 BSSID Info、操作类、
// 信道和宽带宽子元素，直接用于 11k 邻居库与 BTM 候选，避免手工拼接出错。
// 只缓存成功结果（10s），与 BSS 列表缓存同周期；hostapd 重启/频道变化
// 或接口未就绪时下一轮自动重试。
function own_nr(ifname) {
	let cached = state._own_nr[ifname];
	let now = time();
	if (cached && now - cached.ts < 10) return cached.nr;

	let res = ubusc.call("hostapd." + ifname, "rrm_nr_get_own");
	let nr = res?.value?.[2];
	if (type(nr) != "string" || length(nr) < 26 || (length(nr) % 2))
		return null;

	state._own_nr[ifname] = { ts: now, nr };
	return nr;
}

// 本机每块射频的当前信道：优先 iw 实际信道，取不到时退回 UCI 配置
function channel_radios() {
	let out = [];
	let ws = ubusc.call("network.wireless", "status") ?? {};

	for (let rname, r in ws) {
		let cfg = r.config ?? {};
		let band = channel_band_key(cfg.band ?? cfg.hwmode);
		let channel = cfg.channel ?? "auto";
		let htmode = cfg.htmode ?? "";
		let ifnames = [], bssids = [], bss = [], current = 0;

		for (let ifc in r.interfaces ?? []) {
			if (ifc.config?.mode && ifc.config.mode != "ap") continue;
			if (ifc.config?.disabled == "1") continue;
			if (!ifc.ifname) continue;
			push(ifnames, ifc.ifname);
			let mac = trim(fs.readfile(`/sys/class/net/${ifc.ifname}/address`) ?? "");
			let bssid = "";
			if (length(macnorm(mac)) == 12) { bssid = mac; push(bssids, mac); }
			push(bss, { ifname: ifc.ifname, bssid,
			            ssid: ifc.config?.ssid ?? "",
			            nr: (ifc.config?.rrm_neighbor_report == "1")
			                ? own_nr(ifc.ifname) : null });
			if (!current) {
				let info = cmd_output(`iw dev ${ifc.ifname} info 2>/dev/null`);
				let m = match(info, /channel\s+(\d+)/);
				if (m) current = int(m[1]);
			}
		}
		if (!length(ifnames)) continue;
		if (!current) current = channel_num(channel);
		push(out, { device: rname, band, channel, htmode, current, ifnames, bssids, bss });
	}

	if (!length(out)) {
		let cur = uci.cursor();
		cur.load("wireless");
		cur.foreach("wireless", "wifi-device", function(d) {
			let channel = d.channel ?? "auto";
			push(out, {
				device: d[".name"], band: channel_band_key(d.band ?? d.hwmode),
				channel, htmode: d.htmode ?? "", current: channel_num(channel),
				ifnames: [], bssids: [], bss: [],
			});
		});
	}
	return out;
}

// 全网络 BSS 列表：CAP 汇总自己的和各 SAP 上报的信道/BSSID；
// SAP 侧再合并 CAP 回执里的 bss。BTM 候选和 11k 邻居都基于它。
function steer_bss_all() {
	let now = time();
	let cache = state._bss_cache;
	if (cache && now - cache.ts < 10)
		return cache.list;

	let map = {};
	function add(r, ap, ap_mac) {
		for (let b in (r.bss ?? [])) {
			let mn = macnorm(b.bssid ?? "");
			if (length(mn) != 12) continue;
			if (map[mn]) {
				/* 同一 BSS 多来源合并：本机 own report 失败时用对端/ CAP
				   下发的 nr 补上，避免邻居报告丢字段 */
				if (!map[mn].nr && b.nr) map[mn].nr = b.nr;
				continue;
			}
			map[mn] = {
				bssid: b.bssid, ssid: b.ssid ?? "",
				ifname: b.ifname ?? "", ap: ap ?? "", ap_mac: ap_mac ?? "",
				band: channel_band_key(r.band),
				channel: int(r.current ?? r.channel ?? 0),
				htmode: r.htmode ?? "",
				nr: b.nr ?? null,
			};
		}
	}

	for (let r in channel_radios())
		add(r, state.self.name, macnorm(state.self.mac));
	for (let mn, p in state.peers)
		if (p.authed)
			for (let r in (p.info?.channels ?? []))
				add(r, p.info?.name ?? p.name ?? mn, mn);
	for (let b in (state.bss_list ?? [])) {
		let mn = macnorm(b.bssid ?? "");
		if (length(mn) != 12) continue;
		if (map[mn]) {
			if (!map[mn].nr && b.nr) map[mn].nr = b.nr;
			continue;
		}
		map[mn] = b;
	}

	let list = [];
	for (let mn, b in map) push(list, b);
	state._bss_cache = { ts: now, list };
	return list;
}

function self_info() {
	return {
		mac: state.self.mac, ip: state.self.ip,
		name: state.self.name, hostname: state.self.hostname,
		model: state.self.model, firmware: state.self.firmware,
		role: state.cfg.role, uptime: self_uptime(),
		ifaces: state.self.ifaces ?? {},
		wifi: wifi_ifaces(), uplink: detect_uplink(),
		channels: channel_radios(),
	};
}

// ------------------------------------------------------- Wi-Fi 前台设置
// 读取本机所有 AP 口的 SSID / 是否设了密码，供「无线设置」表单回填。
// unified 表示「多频合一」：所有 AP 口同名且同密码（密码不对外返回）
function wifi_summary() {
	let cur = uci.cursor();
	cur.load("wireless");
	let ifaces = [];
	let has_key = false;
	let unified = true;
	let first_ssid = null, first_key = null;
	cur.foreach("wireless", "wifi-iface", function(s) {
		if (s.mode && s.mode != "ap") return;
		if (s.wifiroam_guest == "1") return;   // 访客网络有独立面板，不参与多频合一判断
		let ssid = s.ssid ?? "";
		let key = s.key ?? "";
		push(ifaces, {
			section: s[".name"], device: s.device, ssid: ssid,
			encryption: s.encryption ?? "none",
			band: cur.get("wireless", s.device, "band") ?? "?",
		});
		if (key != "") has_key = true;
		if (first_ssid == null) { first_ssid = ssid; first_key = key; }
		else if (ssid != first_ssid || key != first_key) unified = false;
	});
	let first = ifaces[0];
	// 只显示第一组 SSID，多口不一致时标记出来，避免把不同 SSID 合并成假象
	let mixed = false;
	for (let i in ifaces)
		if (i.ssid != (first?.ssid ?? "")) mixed = true;
	return {
		ssid: first?.ssid ?? "", has_key: has_key, mixed: mixed,
		unified: unified, ifaces: ifaces,
	};
}

// CAP 自动下发用的 Wi-Fi 快照：每个频段取主 SSID/密码（与「无线设置」
// 保存时的取值一致），排除访客和回程口，避免把回程 SSID 当主 SSID。
function wifi_push_payload() {
	let cur = uci.cursor();
	cur.load("wireless");
	let by = {};

	cur.foreach("wireless", "wifi-iface", function(s) {
		if (s[".name"] == BACKHAUL_SECTION) return;
		if (s.wifiroam_guest == "1") return;
		if (s.mode && s.mode != "ap") return;

		let band = cur.get("wireless", s.device, "band") ?? "?";
		let key = s.key ?? "";
		let enc = s.encryption ?? "";
		let it = by[band];
		if (!it) {
			it = by[band] = {
				band, ssid: s.ssid ?? "", key: "",
				open: (key == "" && (enc == "" || enc == "none")),
			};
		}
		// 与 set_wifi 的 cap_keys 逻辑一致：同频段取第一个非空密码
		if (it.key == "" && key != "") {
			it.key = key;
			it.open = false;
		}
	});

	let out = [];
	for (let band in sort(keys(by))) push(out, by[band]);
	return out;
}

// Wi-Fi 配置签名：只包含实际会下发的字段（频段/SSID/密码/是否开放），
// 用于主 AP 判断子 AP 是否已经同步，避免重复重启无线。
function wifi_sig(ssids) {
	let parts = [];
	for (let it in ssids)
		push(parts, sprintf("%s|%s|%s|%s", it.band, it.ssid, it.key,
		                    it.open ? "open" : (it.key != "" ? "psk" : "none")));
	return sha256(join("\n", parts));
}

function wifi_sig_local() { return wifi_sig(wifi_push_payload()); }

// 改本机全部 AP 口的 SSID 与密码。ssids = [{ band, ssid, key }]，同频段的接口取同名同密码。
// 某一项的 key 为空表示该频段只改名称、不动密码。无线重启放在后台：
// 前端请求先返回，避免重启把连接断开导致界面误判失败。
function apply_wifi_local(ssids) {
	let cur = uci.cursor();
	cur.load("wireless");
	let n = 0;
	cur.foreach("wireless", "wifi-iface", function(s) {
		if (s.mode && s.mode != "ap") return;
		if (s.wifiroam_guest == "1") return;   // 访客口由访客面板单独管理
		let band = cur.get("wireless", s.device, "band") ?? "?";
		let want = null;
		for (let it in ssids)
			if (it.band == band) want = it;
		if (want != null && want.ssid != "")
			cur.set("wireless", s[".name"], "ssid", want.ssid);
		if (want != null && want.open) {
			cur.set("wireless", s[".name"], "encryption", "none");
			cur.set("wireless", s[".name"], "key", "");
		}
		else if (want != null && want.key != "") {
			cur.set("wireless", s[".name"], "key", want.key);
			// 开放网络加密为 none/空时补上 WPA2，否则设了密码也不生效
			let enc = s.encryption ?? "";
			if (enc == "" || enc == "none")
				cur.set("wireless", s[".name"], "encryption", "psk2");
		}
		n++;
	});
	cur.commit("wireless");
	if (n > 0)
		cmd_output("( sleep 2; /sbin/wifi reload >/dev/null 2>&1 ) >/dev/null 2>&1 & echo ok");
	return { ok: n > 0, count: n };
}

// 漫游组里记录的 SSID 必须跟着改名，否则 802.11k/v/r 会因找不到同名 SSID 失效。
// pairs = [{ old, new }]：按「旧名 -> 新名」替换，并把仍是新名的条目补齐，
// 避免两个频段同名时连续重命名把另一个频段的组从列表里挤掉。
function roam_rename_ssids(pairs) {
	let hit = 0;
	for (let p in pairs)
		if (p.old != "" && p.old != p.new) hit++;
	if (hit == 0) return;

	let cur = uci.cursor();
	cur.load("wifiroam");
	let raw = cur.get("wifiroam", "roam", "ssids") ?? [];
	let list = [];
	if (type(raw) == "array") list = raw;
	else if (raw != "") list = [ raw ];

	let out = [];
	for (let s in list) {
		let mapped = s;
		for (let p in pairs)
			if (p.old == s && p.new != "") { mapped = p.new; break; }
		push(out, mapped);
	}
	for (let p in pairs)
		if (p.new != "" && index(out, p.new) < 0) push(out, p.new);
	// 两个频段并成一组合一时，替换后可能留下重复项
	let dedup = [];
	for (let s in out)
		if (index(dedup, s) < 0) push(dedup, s);
	cur.set("wifiroam", "roam", "ssids", dedup);
	cur.commit("wifiroam");
}

// ------------------------------------------------------- 访客网络
// 每台 AP 建一个独立访客子网（172.16.10.0/24）+ 自己的 DHCP + 隔离防火墙区。
// 主AP 保存后把 SSID/密码/限速/时段推给已配对 AP，各 AP 本地落地。
function hhmm_minutes(s) {
	let f = split(trim(s ?? ""), ":");
	if (length(f) != 2) return null;
	let h = int(f[0]), m = int(f[1]);
	if (h < 0 || h > 23 || m < 0 || m > 59) return null;
	return h * 60 + m;
}

function now_minutes() {
	let s = trim(cmd_output("date +%H:%M"));
	return hhmm_minutes(s) ?? 0;
}

function guest_cfg() {
	let cur = uci.cursor();
	cur.load("wifiroam");
	return {
		enabled: cur.get("wifiroam", GUEST_SECTION, "enabled") == "1",
		ssid: cur.get("wifiroam", GUEST_SECTION, "ssid") ?? GUEST_DEFAULT_SSID,
		key: cur.get("wifiroam", GUEST_SECTION, "key") ?? "",
		bandwidth: int(cur.get("wifiroam", GUEST_SECTION, "bandwidth") ?? "0"),
		schedule: cur.get("wifiroam", GUEST_SECTION, "schedule") == "1",
		start: cur.get("wifiroam", GUEST_SECTION, "start") ?? "08:00",
		end: cur.get("wifiroam", GUEST_SECTION, "end") ?? "23:00",
		allow_lan: cur.get("wifiroam", GUEST_SECTION, "allow_lan") == "1",
		ver: int(cur.get("wifiroam", GUEST_SECTION, "config_ver") ?? "0"),
	};
}

// 同时检查入、出方向；WAN 回程也能命中 flowtable，不能只从 devices 去掉访客桥。
function fw4_forward_state() {
	let proc = fs.popen("nft list chain inet fw4 forward 2>/dev/null", "r");
	if (!proc) return null;
	let rules = proc.read("all") ?? "";
	if (proc.close() != 0) return null;
	let active = false, guarded = true;
	for (let line in split(rules, "\n")) {
		let m = match(line, /^(.*?)\s*flow\s+(add|offload)\s+@ft(\s|;|$)/);
		if (!m) continue;
		active = true;
		if (!match(m[1], /(^|\s)iifname\s+!=\s+"?br-guest"?(\s|$)/) ||
		    !match(m[1], /(^|\s)oifname\s+!=\s+"?br-guest"?(\s|$)/)) guarded = false;
	}
	return { active, guarded: active && guarded };
}

function fw4_replace_template(expected, body) {
	let stat = fs.lstat(FW4_TEMPLATE);
	if (stat?.type != "file" || stat.uid != 0 || stat.gid != 0) return false;
	let dir = fs.mkdtemp(FW4_TEMPLATE + ".wifiroam-XXXXXX");
	if (!dir) return false;
	let file = dir + "/ruleset.uc";
	let ok = fs.writefile(file, body) == length(body) && fs.chmod(file, stat.mode & 0777) &&
	         fs.readfile(FW4_TEMPLATE) == expected && fs.rename(file, FW4_TEMPLATE);
	if (!ok) fs.unlink(file);
	fs.rmdir(dir);
	return ok;
}

function guest_fw4_status(error) {
	if (error && state.guest_fw4_error != error) log("guest flow offload protection: " + error);
	state.guest_fw4_error = error;
}

guest_fw4_sync = function(cfg, reload) {
	cfg = cfg ?? guest_cfg();
	let protect = cfg.enabled && cfg.bandwidth > 0;
	let source = fs.readfile(FW4_TEMPLATE) ?? "";
	let patched = index(source, FW4_GUEST_FLOW_RULE) >= 0;
	let original = patched ? replace(source, FW4_GUEST_FLOW_RULE, FW4_FLOW_RULE) : source;
	/* 只要求模板里存在唯一一条标准 flow offload 规则，避免绑定某个
	   firewall4 小版本；规则结构不符时仍然安全降级，不做修改。 */
	let supported = (protect || patched) &&
	                length(split(original, FW4_FLOW_RULE)) == 2 &&
	                index(original, "@ft") >= 0;
	if (!supported) {
		guest_fw4_status(protect || patched ? "unsupported" : null);
		if (reload) system("/sbin/fw4 reload >/dev/null 2>&1");
		return !protect && !patched;
	}

	let desired = protect ? replace(original, FW4_FLOW_RULE, FW4_GUEST_FLOW_RULE) : original;
	let changed = desired != source;
	let live = protect ? fw4_forward_state() : null;
	if (!reload && protect && !live) {
		guest_fw4_status("pending");
		return false;
	}
	if (!changed && !reload && (!live?.active || live.guarded)) {
		guest_fw4_status(null);
		state.guest_fw4_failed = null;
		return true;
	}

	let attempt = (protect ? "protect:" : "restore:") + sha256(source);
	if (!reload && state.guest_fw4_failed == attempt && time() < state.guest_fw4_retry_at) return false;
	let written = changed && fw4_replace_template(source, desired);
	let ok = (!changed || written) && (!changed || system("/sbin/fw4 -q check") == 0) &&
	         system("/sbin/fw4 reload >/dev/null 2>&1") == 0;
	if (ok) {
		live = fw4_forward_state();
		ok = live && (!live.active || live.guarded === protect);
	}
	if (!ok) {
		// 只回滚自己的改动；不覆盖被软件包更新或手动编辑过的模板。
		if (written && !fw4_replace_template(desired, source)) log("guest firewall template rollback failed");
		if (written || (reload && changed)) system("/sbin/fw4 reload >/dev/null 2>&1");
		state.guest_fw4_failed = attempt;
		state.guest_fw4_retry_at = time() + 60;
		guest_fw4_status("apply_failed");
		return false;
	}

	state.guest_fw4_failed = null;
	guest_fw4_status(null);
	return true;
};

// 开放时段判断：start <= end 为当天区间，否则视为跨零点（如 22:00-07:00）
function guest_open_now(cfg) {
	if (!cfg.enabled) return false;
	if (!cfg.schedule) return true;
	let a = hhmm_minutes(cfg.start), b = hhmm_minutes(cfg.end);
	if (a == null || b == null) return true;
	let t = now_minutes();
	if (a <= b) return t >= a && t < b;
	return t >= a || t < b;
}

function guest_summary() {
	let g = guest_cfg();
	let cur = uci.cursor();
	cur.load("wireless");
	let ifaces = [], open = guest_open_now(g);
	cur.foreach("wireless", "wifi-iface", function(s) {
		if (s.wifiroam_guest != "1") return;
		push(ifaces, {
			section: s[".name"], device: s.device,
			band: cur.get("wireless", s.device, "band") ?? "?",
			disabled: s.disabled == "1",
		});
	});
	return {
		role: state.cfg.role,
		enabled: g.enabled, ssid: g.ssid, has_key: g.key != "",
		bandwidth: g.bandwidth,
		schedule: g.schedule, start: g.start, end: g.end,
		allow_lan: g.allow_lan, open: open, ifaces: ifaces,
		last: state.last_guest ?? null,
	};
}

function mask_prefix(m) {
	if (index(m ?? "", ".") < 0) return int(m ?? "24");
	let parts = split(m, ".");
	let bits = 0;
	for (let i = 0; i < 4; i++) {
		let v = int(parts[i] ?? "0");
		for (let b = 7; b >= 0; b--) {
			if (v & (1 << b)) bits++;
			else return bits;
		}
	}
	return bits;
}

// "192.168.0.1" + "255.255.255.0" -> "192.168.0.0/24"
function ipv4_cidr(ipmask, mask) {
	let a = split(ipmask ?? "", "/");
	let ip = a[0];
	let prefix = (a[1] != null && a[1] != "") ? int(a[1]) : mask_prefix(mask ?? "255.255.255.0");
	let host = 32 - prefix;
	if (host < 0) host = 0;
	if (host > 31) host = 31;
	let parts = split(ip, ".");
	let ipint = 0;
	for (let i = 0; i < 4; i++) ipint = (ipint * 256) + int(parts[i] ?? "0");
	let div = 1 << host;
	let net = ipint - (ipint % div);
	let o = [];
	let v = net;
	for (let i = 0; i < 4; i++) { push(o, "" + (v % 256)); v = int(v / 256); }
	return sprintf("%s.%s.%s.%s/%d", o[3], o[2], o[1], o[0], prefix);
}

function guest_lan_info() {
	/* lan 可能由上游 DHCP 获取地址（中继 AP 模式下 router-tool 会把 lan
	   改成 proto dhcp 并清掉 ipaddr/netmask），UCI 里没有地址时旧逻辑会
	   退到 192.168.0.1，子 AP 的访客 SNAT 到一个不存在的地址后回程流量
	   全部丢失——表现就是访客能连上 Wi-Fi 但上不了网。这里优先读 netifd
	   运行态，读不到再退回 UCI。 */
	let st = ubusc.call("network.interface.lan", "status");
	let a = st?.["ipv4-address"]?.[0];
	if (a?.address != null) {
		let prefix = int(a.mask ?? 24);
		if (prefix < 0) prefix = 0;
		if (prefix > 32) prefix = 32;
		return {
			cidr: ipv4_cidr(a.address, "" + prefix),
			ip: a.address,
			gw: state.self.ip,
			dev: st?.device ?? state.brdev,
		};
	}

	let cur = uci.cursor();
	cur.load("network");
	/* lan 的 ipaddr 可能是 list（本机即 list ipaddr），get() 会返回数组。
	   注意 get_first 的第二参数是 section 类型（interface）而不是段名，
	   这里统一用 get + 数组取首值最稳妥 */
	let pick = function(v) {
		if (type(v) == "array") return v[0];
		return v;
	};
	let ip = pick(cur.get("network", "lan", "ipaddr")) ?? "192.168.0.1";
	let nm = pick(cur.get("network", "lan", "netmask")) ?? "255.255.255.0";
	let gw = pick(cur.get("network", "lan", "gateway"));
	return {
		cidr: ipv4_cidr(ip, nm),
		ip: split(ip, "/")[0],
		gw: gw != null ? split(gw, "/")[0] : state.self.ip,
		dev: state.brdev,
	};
}

// WAN 是否可作为访客出口。中继 AP 模式下 router-tool 会把 wan 置为
// proto none 并禁用，此时设备本质是二层桥接 AP，访客只能走 guest→lan + SNAT。
function guest_wan_uplink() {
	let cur = uci.cursor();
	cur.load("network");
	if (cur.get("network", "wan") == null) return false;
	let proto = cur.get("network", "wan", "proto");
	if (proto == null || proto == "" || proto == "none") return false;
	if (cur.get("network", "wan", "disabled") == "1") return false;
	return true;
}

function guest_network_only(network) {
	return network == GUEST_IFACE ||
	       (type(network) == "array" && length(network) == 1 && network[0] == GUEST_IFACE);
}

function is_guest_iface(s) {
	return s?.wifiroam_guest == "1" && s.mode == "ap" && guest_network_only(s.network);
}

function guest_netdevs() {
	let cur = uci.cursor(), sections = {}, ports = {};
	cur.load("wireless");
	cur.foreach("wireless", "wifi-iface", function(s) {
		if (is_guest_iface(s) && s.disabled != "1") sections[s[".name"]] = true;
	});
	let radios = ubusc.call("network.wireless", "status");
	for (let name, radio in radios ?? {}) {
		if (!radio.up || radio.pending) continue;
		for (let vif in radio.interfaces ?? []) {
			let dev = vif.ifname;
			if (vif.section && sections[vif.section] && vif.config?.mode == "ap" && guest_network_only(vif.config.network) &&
			    dev && match(dev, /^[a-zA-Z0-9_.:-]+$/) && fs.access(`/sys/class/net/${dev}`))
				ports[dev] = true;
		}
	}
	return sort(keys(ports));
}

// 把访客 SSID/密码/开关写入本机 wireless；时段外保持 disabled
function guest_write_wireless(cfg) {
	let open = guest_open_now(cfg);
	let roam = current_roam_cfg();
	let wc = uci.cursor();
	wc.load("wireless");
	let keep = {};
	let radios = [];
	wc.foreach("wireless", "wifi-device", function(d) {
		push(radios, d[".name"]);
	});
	for (let rname in radios) {
		let sid = GUEST_SEC_PREFIX + rname;
		keep[sid] = true;
		if (wc.get("wireless", sid) == null)
			wc.set("wireless", sid, "wifi-iface");
		wc.set("wireless", sid, "device", rname);
		wc.set("wireless", sid, "mode", "ap");
		wc.set("wireless", sid, "ssid", cfg.ssid != "" ? cfg.ssid : GUEST_DEFAULT_SSID);
		if (cfg.key != "") {
			wc.set("wireless", sid, "encryption", "psk2");
			wc.set("wireless", sid, "key", cfg.key);
		} else {
			wc.set("wireless", sid, "encryption", "none");
			wc.delete("wireless", sid, "key");
		}
		wc.set("wireless", sid, "network", GUEST_IFACE);
		wc.set("wireless", sid, "wifiroam_guest", "1");
		wc.set("wireless", sid, "disabled", (cfg.enabled && open) ? "0" : "1");
		// 访客配置可晚于漫游配置到达；访客网络不参与漫游，清掉残留的 k/v/r。
		write_roam_iface(wc, wc.get_all("wireless", sid), roam, [], false);
	}
	let stale = [];
	wc.foreach("wireless", "wifi-iface", function(s) {
		if (s.wifiroam_guest != "1") return;
		if (!keep[s[".name"]]) push(stale, s[".name"]);
	});
	for (let sid in stale) wc.delete("wireless", sid);
	wc.commit("wireless");
	return open;
}

// 关闭访客网络时删除残留的桥/接口/DHCP/防火墙段（nft 与 tc 由 after_reload 清理）
function guest_remove_infra() {
	let nc = uci.cursor();
	nc.load("network");
	nc.delete("network", GUEST_IFACE);
	nc.delete("network", GUEST_DEV);
	nc.commit("network");

	let dc = uci.cursor();
	dc.load("dhcp");
	dc.delete("dhcp", GUEST_IFACE);
	dc.commit("dhcp");

	let fc = uci.cursor();
	fc.load("firewall");
	fc.foreach("firewall", "zone", function(z) {
		if (z.name == "guest" && z.network == GUEST_IFACE)
			fc.delete("firewall", z[".name"]);
	});
	fc.delete("firewall", GUEST_ZONE);
	for (let r in [ "wifiroam_guest_dhcp", "wifiroam_guest_dns_u", "wifiroam_guest_dns_t",
	                GUEST_FWD_WAN, GUEST_FWD_LAN, GUEST_ALLOW_LAN, GUEST_SNAT ])
		fc.delete("firewall", r);
	fc.commit("firewall");
}

// 无线配置通过 network=wifiroam_guest 交给 netifd 动态挂桥，不固化无线口名。
function guest_write_infra(cfg) {
	let nc = uci.cursor();
	nc.load("network");
	if (nc.get("network", GUEST_DEV) == null)
		nc.set("network", GUEST_DEV, "device");
	nc.set("network", GUEST_DEV, "type", "bridge");
	nc.set("network", GUEST_DEV, "name", GUEST_BRIDGE);
	nc.set("network", GUEST_DEV, "bridge_empty", "1");
	nc.delete("network", GUEST_DEV, "ports");
	if (nc.get("network", GUEST_IFACE) == null)
		nc.set("network", GUEST_IFACE, "interface");
	nc.set("network", GUEST_IFACE, "proto", "static");
	nc.set("network", GUEST_IFACE, "device", GUEST_BRIDGE);
	nc.set("network", GUEST_IFACE, "ipaddr", GUEST_IP);
	nc.set("network", GUEST_IFACE, "netmask", "255.255.255.0");
	nc.commit("network");

	let dc = uci.cursor();
	dc.load("dhcp");
	if (dc.get("dhcp", GUEST_IFACE) == null)
		dc.set("dhcp", GUEST_IFACE, "dhcp");
	dc.set("dhcp", GUEST_IFACE, "interface", GUEST_IFACE);
	dc.set("dhcp", GUEST_IFACE, "start", "10");
	dc.set("dhcp", GUEST_IFACE, "limit", "100");
	dc.set("dhcp", GUEST_IFACE, "leasetime", "12h");
	/* 本机 dnsmasq 的 dhcpv4/dhcpv6 默认值是 disabled，不显式置 server 就不出 dhcp-range。
	   访客只有 IPv4，DHCPv6/RA 全部关闭。force 跳过 br-guest 上的 udhcpc 探测。 */
	dc.set("dhcp", GUEST_IFACE, "dhcpv4", "server");
	dc.set("dhcp", GUEST_IFACE, "dhcpv6", "disabled");
	dc.set("dhcp", GUEST_IFACE, "force", "1");
	dc.commit("dhcp");

	let fc = uci.cursor();
	fc.load("firewall");
	let zsec = null;
	fc.foreach("firewall", "zone", function(z) {
		if (z.name == "guest" && zsec == null) zsec = z[".name"];
	});
	if (zsec == null) { zsec = GUEST_ZONE; fc.set("firewall", zsec, "zone"); }
	fc.set("firewall", zsec, "name", "guest");
	/* 访客区只用 device 定义，不能写 network / subnet：
	   1) 写 network 时 fw4 会把访客物理设备（br-guest / phy*-ap1）自动加进
	      flowtable，流量被（硬件）卸载后绕过 qdisc，限速失效；
	   2) 写 subnet 时 fw4 会给 input 链加 "ip saddr 172.16.10.0/24" 条件，
	      DHCPDISCOVER 的源地址是 0.0.0.0，匹配不上就进不了 input_guest，
	      DHCP 放行规则不生效，访客拿不到 IP。
	   只写 device 时 related_physdevs / related_subnets 都为空，不会进
	   flowtable、也不带 saddr；NAT 由 srcnat_wan 的全局 masq 处理。 */
	fc.delete("firewall", zsec, "network");
	fc.delete("firewall", zsec, "subnet");
	fc.set("firewall", zsec, "device", GUEST_BRIDGE);
	fc.set("firewall", zsec, "input", "REJECT");
	fc.set("firewall", zsec, "output", "ACCEPT");
	fc.set("firewall", zsec, "forward", "REJECT");

	// input 默认 REJECT，只放行访客自己需要的 DHCP 与 DNS
	let rules = [
		{ sec: "wifiroam_guest_dhcp",    proto: "udp", port: "67" },
		{ sec: "wifiroam_guest_dns_u",   proto: "udp", port: "53" },
		{ sec: "wifiroam_guest_dns_t",   proto: "tcp", port: "53" },
	];
	for (let r in rules) {
		if (fc.get("firewall", r.sec) == null) fc.set("firewall", r.sec, "rule");
		fc.set("firewall", r.sec, "name", r.sec);
		fc.set("firewall", r.sec, "src", "guest");
		fc.set("firewall", r.sec, "proto", r.proto);
		fc.set("firewall", r.sec, "dest_port", r.port);
		fc.set("firewall", r.sec, "target", "ACCEPT");
		fc.set("firewall", r.sec, "family", "ipv4");
		fc.set("firewall", r.sec, "enabled", "1");
	}

	/* 有可用 WAN 时访客走 wan 出口；子 AP 或处于中继 AP 模式（wan 已禁用）
	   的设备本质是二层桥接 AP，改由 guest→lan 转发 + SNAT。不用的
	   forwarding 直接删除，避免 fw4 每次 reload 报「section is disabled」 */
	let bridged = state.cfg.role == "sap" || !guest_wan_uplink();
	state._guest_bridged = bridged;
	if (!bridged) {
		if (fc.get("firewall", GUEST_FWD_WAN) == null)
			fc.set("firewall", GUEST_FWD_WAN, "forwarding");
		fc.set("firewall", GUEST_FWD_WAN, "src", "guest");
		fc.set("firewall", GUEST_FWD_WAN, "dest", "wan");
		fc.set("firewall", GUEST_FWD_WAN, "enabled", "1");
	} else {
		fc.delete("firewall", GUEST_FWD_WAN);
	}

	if (bridged || cfg.allow_lan) {
		if (fc.get("firewall", GUEST_FWD_LAN) == null)
			fc.set("firewall", GUEST_FWD_LAN, "forwarding");
		fc.set("firewall", GUEST_FWD_LAN, "src", "guest");
		fc.set("firewall", GUEST_FWD_LAN, "dest", "lan");
		fc.set("firewall", GUEST_FWD_LAN, "enabled", "1");
	} else {
		fc.delete("firewall", GUEST_FWD_LAN);
	}

	/* 访问内网资源除了访客→lan 的转发，还要放行目的地址为内网网段的
	   input 流量，否则访客打不开主路由 LuCI、路由器上的 Samba/NAS 等
	   本机服务（input 默认 REJECT）。input 规则不能带 dest 区，只能
	   用 dest_ip 限定内网地址。 */
	let lan = cfg.allow_lan ? guest_lan_info() : null;
	if (lan && lan.cidr != "") {
		if (fc.get("firewall", GUEST_ALLOW_LAN) == null)
			fc.set("firewall", GUEST_ALLOW_LAN, "rule");
		fc.set("firewall", GUEST_ALLOW_LAN, "name", GUEST_ALLOW_LAN);
		fc.set("firewall", GUEST_ALLOW_LAN, "src", "guest");
		fc.set("firewall", GUEST_ALLOW_LAN, "dest_ip", lan.cidr);
		fc.set("firewall", GUEST_ALLOW_LAN, "proto", "all");
		fc.set("firewall", GUEST_ALLOW_LAN, "target", "ACCEPT");
		fc.set("firewall", GUEST_ALLOW_LAN, "family", "ipv4");
		fc.set("firewall", GUEST_ALLOW_LAN, "enabled", "1");
	} else {
		fc.delete("firewall", GUEST_ALLOW_LAN);
	}

	// 子AP 的“外网”其实走 lan 桥到主AP，必须放行 guest→lan 并做 SNAT，
	// 否则主AP 没有访客子网的回程路由。
	// 不能用 uci 的 nat 段：fw4 按出接口归 zone，src=guest 的规则只会出现在
	// "oifname br-guest" 的 srcnat_guest 链里，反而会把去访客的下行包 SNAT 掉。
	// SNAT 改由 guest_nft_apply 写在自建表（oifname 为 lan 侧）。
	fc.delete("firewall", GUEST_SNAT);
	fc.commit("firewall");
}

// 独立 nft 表做访客→内网的兜底拦截（fw4 的 accept 规则之前生效）。
// 允许访客访问内网资源时整表删除。
// 注意：本机 nft 的 -f 文件模式不能解析 table/chain 声明，必须先建表与链。
function guest_nft_apply(cfg) {
	let info = guest_lan_info();
	let snat_ip = info.ip != "" ? info.ip : state.self.ip;
	let bridged = state.cfg.role == "sap" || !guest_wan_uplink();
	let sig = (cfg.enabled ? "1" : "0") + "|" + (cfg.allow_lan ? "1" : "0") + "|" +
	          (bridged ? "1" : "0") + "|" + snat_ip + "|" + info.cidr;
	if (sig == state._guest_nft_sig) return;
	state._guest_nft_sig = sig;

	cmd_output(sprintf("nft delete table inet %s 2>/dev/null", GUEST_NFT_TABLE));
	if (!cfg.enabled) return;
	cmd_output(sprintf("nft add table inet %s 2>/dev/null", GUEST_NFT_TABLE));

	/* 桥接上行（子AP / 中继AP 模式）没有自己的 wan：访客流量经 br-lan
	   送上游网关，必须在本机 SNAT 成 lan 地址，上游才能把回包按访客
	   子网送回。fw4 的 nat 段按出接口归 zone，覆盖不到这个方向，所以
	   放在自建表里做。 */
	if (bridged && snat_ip != "") {
		cmd_output(sprintf(
			"nft add chain inet %s nat '{ type nat hook postrouting priority srcnat; policy accept; }' 2>/dev/null",
			GUEST_NFT_TABLE));
		cmd_output(sprintf("nft add rule inet %s nat ip saddr %s oifname %s snat ip to %s 2>/dev/null",
			GUEST_NFT_TABLE, GUEST_NET, info.dev ?? state.brdev, snat_ip));
	}

	if (cfg.allow_lan) return;
	/* 链名不能用 fwd：nft 把 fwd 当保留字，会报 unexpected fwd */
	cmd_output(sprintf(
		"nft add chain inet %s guard '{ type filter hook forward priority -20; policy accept; }' 2>/dev/null",
		GUEST_NFT_TABLE));
	cmd_output(sprintf("nft add rule inet %s guard iifname %s ip daddr %s drop 2>/dev/null",
		GUEST_NFT_TABLE, GUEST_BRIDGE, info.cidr));
}

function guest_client_ips() {
	let ips = {};
	let prefix = replace(GUEST_IP, /[0-9]+$/, "");
	let add = function(ip) {
		if (index(ip, prefix) != 0 || ip == GUEST_IP) return;
		let host = substr(ip, length(prefix));
		if (match(host, /^[1-9][0-9]{0,2}$/) && int(host) < 255)
			ips[ip] = true;
	};
	let data = fs.readfile("/tmp/dhcp.leases") ?? "";
	for (let line in split(data, "\n")) {
		let fields = split(trim(line), /\s+/);
		if (fields[2]) add(fields[2]);
	}
	let neigh = cmd_output("ip -4 neigh show dev " + GUEST_BRIDGE + " 2>/dev/null");
	for (let line in split(neigh, "\n")) {
		let m = match(line, /^([0-9.]+)\s/);
		if (m) add(m[1]);
	}
	return sort(keys(ips));
}

function guest_tc_remove(dev, handle) {
	cmd_output(sprintf("tc qdisc del dev %s root handle %s 2>/dev/null", dev, handle));
}

// 下行整形挂在访客桥的实际无线出口，不依赖 SSID 或无线接口命名。
function guest_tc_apply(cfg) {
	let bw = cfg.bandwidth ?? 0;
	let active = bw > 0 && guest_open_now(cfg);
	let ports = [];
	for (let path in fs.glob(`/sys/class/net/${GUEST_BRIDGE}/brif/*`)) {
		let dev = fs.basename(path);
		if (match(dev, /^[a-zA-Z0-9_.:-]+$/) && fs.access(`/sys/class/net/${dev}/phy80211`))
			push(ports, dev);
	}
	for (let dev in keys(state.guest_tc_devs)) {
		if (index(ports, dev) >= 0) continue;
		guest_tc_remove(dev, GUEST_TC_HANDLE);
		delete state.guest_tc_devs[dev];
	}

	let guest_ports = active && length(ports) ? guest_netdevs() : [];
	let ips = length(guest_ports) ? guest_client_ips() : [];
	let sig = bw + "|" + join(",", ips);
	let errors = [];
	for (let dev in ports) {
		let qdisc = cmd_output(`tc qdisc show dev ${dev} 2>/dev/null`);
		let installed = index(qdisc, `qdisc htb ${GUEST_TC_HANDLE} root`) >= 0;
		if (!active) {
			if (installed) guest_tc_remove(dev, GUEST_TC_HANDLE);
			else if (index(qdisc, "qdisc htb 1: root") >= 0 && index(qdisc, "default 0x20") >= 0)
				guest_tc_remove(dev, "1:"); // 上一版本的访客限速队列
			delete state.guest_tc_devs[dev];
			continue;
		}
		if (index(guest_ports, dev) < 0) continue;
		if (installed && state.guest_tc_devs[dev] == sig) continue;
		if (installed) guest_tc_remove(dev, GUEST_TC_HANDLE);

		let rate = (bw * 1000) + "kbit";
		let cls = `class add dev ${dev} parent ${GUEST_TC_HANDLE}`;
		let batch = `qdisc replace dev ${dev} root handle ${GUEST_TC_HANDLE} htb default 20\n` +
		            `${cls} classid ${GUEST_TC_HANDLE}20 htb rate ${rate} ceil ${rate}\n`;
		// 新入网、还未读到地址的终端也先使用限速的默认类。
		let i = 0x20;
		for (let ip in ips) {
			let cid = GUEST_TC_HANDLE + sprintf("%x", ++i);
			batch += `${cls} classid ${cid} htb rate ${rate} ceil ${rate}\n` +
			         `filter add dev ${dev} parent ${GUEST_TC_HANDLE} protocol ip prio 1 u32 match ip dst ${ip}/32 flowid ${cid}\n`;
		}
		let proc = fs.popen("tc -batch - 2>&1 <<'WIFIROAM_TC'\n" + batch + "WIFIROAM_TC", "r");
		let output = proc ? trim(proc.read("all") ?? "") : "";
		if (proc && proc.close() == 0) {
			state.guest_tc_devs[dev] = sig;
		} else {
			guest_tc_remove(dev, GUEST_TC_HANDLE);
			delete state.guest_tc_devs[dev];
			push(errors, dev + ": " + (output || "tc failed"));
		}
	}
	let error = join("; ", errors);
	if (error && error != state.guest_tc_error)
		log("guest bandwidth limit failed: " + error);
	state.guest_tc_error = error;
}

guest_after_reload = function() {
	let cfg = guest_cfg();
	uloop.process("/etc/init.d/dnsmasq", [ "reload" ], null, function() {});
	let fw = guest_fw4_sync(cfg, true);
	guest_nft_apply(cfg);
	guest_tc_apply(cfg);
	return fw;
};

// 本机落地：先加载访客接口和防火墙，再重载无线，端口由 netifd 绑定。
// done 可选：在网络/无线真正重载完成后回调，避免前端只看到「已提交」。
apply_guest_local = function(cfg, done) {
	state.guest_open = guest_open_now(cfg);
	if (cfg.enabled && cfg.bandwidth > 0) guest_fw4_sync(cfg, false);
	guest_write_wireless(cfg);
	if (cfg.enabled)
		guest_write_infra(cfg);
	else
		guest_remove_infra();

	let finish = function(ok, error) {
		if (ok && cfg.ver != null)
			state.guest_ver_applied = int(cfg.ver);
		if (done) done({ ok: ok, error: error ?? null });
	};

	uloop.process("/etc/init.d/network", [ "reload" ], null, function(rc) {
		if (rc != 0) {
			log("guest network reload failed rc=" + rc);
			finish(false, "network_failed");
			return;
		}
		let fw = guest_after_reload();
		uloop.process("/sbin/wifi", [ "reload" ], null, function(res) {
			log("guest wifi reload rc=" + res);
			guest_tc_apply(guest_cfg());
			if (res != 0) {
				finish(false, "wifi_failed");
				return;
			}
			if (fw === false) {
				finish(false, "fw4_failed");
				return;
			}
			finish(true, null);
		});
	});
	return { ok: true, pending: true };
};

// 校验并写入本机 wifiroam.guest（主AP/子AP 都走这里）
guest_save_local = function(g) {
	let enabled = g.enabled ? true : false;
	let ssid = trim(g.ssid ?? "");
	let key = g.open ? "" : (g.key ?? "");
	let start = trim(g.start ?? "08:00");
	let end = trim(g.end ?? "23:00");
	if (enabled && (length(ssid) < 1 || length(ssid) > 32)) return false;
	if (key != "" && (length(key) < 8 || length(key) > 64)) return false;
	if (hhmm_minutes(start) == null || hhmm_minutes(end) == null) return false;

	let cur = uci.cursor();
	cur.load("wifiroam");
	if (cur.get("wifiroam", GUEST_SECTION) == null)
		cur.set("wifiroam", GUEST_SECTION, "guest");
	cur.set("wifiroam", GUEST_SECTION, "enabled", enabled ? "1" : "0");
	cur.set("wifiroam", GUEST_SECTION, "ssid",
		ssid != "" ? ssid : GUEST_DEFAULT_SSID);
	cur.set("wifiroam", GUEST_SECTION, "key", key);
	cur.set("wifiroam", GUEST_SECTION, "bandwidth", "" + int(g.bandwidth ?? 0));
	cur.set("wifiroam", GUEST_SECTION, "schedule", g.schedule ? "1" : "0");
	cur.set("wifiroam", GUEST_SECTION, "start", start);
	cur.set("wifiroam", GUEST_SECTION, "end", end);
	cur.set("wifiroam", GUEST_SECTION, "allow_lan", g.allow_lan ? "1" : "0");
	cur.set("wifiroam", GUEST_SECTION, "config_ver", "" + int(g.ver ?? 0));
	if (!cur.commit("wifiroam")) return false;
	return true;
};

// 定时检查开放时段；只在跨过边界时重启无线。限速规则每轮同步一次
guest_tick = function() {
	if (state.cfg.role == "unconfigured") return;

	/* 成员 AP 未在超时前上报新版本，标记失败，避免永久 pending */
	if (state.cfg.role == "cap" && state.last_guest &&
	    time() - (state.last_guest.ts ?? 0) > GUEST_APPLY_TIMEOUT) {
		for (let r in state.last_guest.results)
			if (r.ok == null) { r.ok = false; r.error = "timeout"; }
		for (let mn, p in state.peers)
			if (p.guest_pushing) p.guest_pushing = false;
	}

	/* 没有 UI 结果记录的自动补推也要有超时，避免 guest_pushing 永久卡住 */
	if (state.cfg.role == "cap") {
		for (let mn, p in state.peers)
			if (p.guest_pushing &&
			    time() - (p.guest_pushing_ts ?? 0) > GUEST_APPLY_TIMEOUT)
				p.guest_pushing = false;
	}

	let g = guest_cfg();
	if (!g.enabled) {
		state.guest_open = false;
		guest_fw4_sync(g, false);
		guest_tc_apply(g);
		guest_nft_apply(g);
		return;
	}
	/* 旧版本访客区用 option network / subnet 定义（会让 vif 进 flowtable、
	   并给 DHCP 加上 saddr 限制），子AP 还留着无效的 uci nat 段；
	   进程升级后做一次性迁移 */
	if (state._guest_zone_migrated != true) {
		let mc = uci.cursor();
		mc.load("network");
		mc.load("firewall");
		state._guest_zone_migrated = true;
		// 清除旧版按 SSID 写入的桥端口，后续完全由 netifd 管理。
		if (mc.get("network", GUEST_DEV, "ports") != null ||
		    mc.get("network", GUEST_DEV, "bridge_empty") != "1") {
			apply_guest_local(g);
			return;
		}
		if (mc.get("firewall", GUEST_ZONE, "network") != null ||
		    mc.get("firewall", GUEST_ZONE, "subnet") != null ||
		    (state.cfg.role == "sap" && mc.get("firewall", GUEST_SNAT) != null)) {
			guest_write_infra(g);
			guest_fw4_sync(g, true);
			state._guest_nft_sig = "";
		}
	}
	/* 访客出口取决于 wan 是否可用：router-tool 切到中继 AP 模式会禁用
	   wan，此时必须把转发从 guest→wan 换成 guest→lan + SNAT，否则访客
	   能连上 Wi-Fi 但没有回程路由，表现为无法上网 */
	let bridged = state.cfg.role == "sap" || !guest_wan_uplink();
	if (state._guest_bridged == null) {
		let fc = uci.cursor();
		fc.load("firewall");
		let fw_wan = fc.get("firewall", GUEST_FWD_WAN) != null;
		state._guest_bridged = bridged;
		if (fw_wan == bridged) {
			guest_write_infra(g);
			guest_fw4_sync(g, true);
			state._guest_nft_sig = "";
		}
	}
	else if (state._guest_bridged != bridged) {
		guest_write_infra(g);
		guest_fw4_sync(g, true);
		state._guest_nft_sig = "";
	}
	guest_fw4_sync(g, false);
	/* 进程重启后内核里的 nft 表可能丢失（设备重启），按需补建/清理 */
	guest_nft_apply(g);
	let open = guest_open_now(g);
	if (open == state.guest_open) {
		guest_tc_apply(g);
		return;
	}
	let was_open = state.guest_open;
	state.guest_open = open;

	let wc = uci.cursor(), changed = false;
	wc.load("wireless");
	wc.foreach("wireless", "wifi-iface", function(s) {
		if (!is_guest_iface(s) || (s.disabled != "1") == open) return;
		wc.set("wireless", s[".name"], "disabled", open ? "0" : "1");
		changed = true;
	});
	if (!changed) {
		guest_tc_apply(g);
		return;
	}
	wc.commit("wireless");
	if (was_open != null) push_event("guest_schedule", "", open ? "open" : "closed");
	uloop.process("/sbin/wifi", [ "reload" ], null, function() {
		guest_tc_apply(guest_cfg());
	});
};

// ------------------------------------------------------- client collection
function freq_band(f) {
	if (!f) return null;
	if (f < 3000) return "2g";
	if (f < 5900) return "5g";
	return "6g";
}

function parse_leases_raw() {
	let out = {};
	let data = fs.readfile("/tmp/dhcp.leases");
	if (!data) return out;
	for (let line in split(data, "\n")) {
		let f = split(trim(line), " ");
		if (length(f) < 4) continue;
		let mn = macnorm(f[1]);
		if (length(mn) != 12) continue;
		out[mn] = { ip: f[2], hostname: f[3] != "*" ? f[3] : null };
	}
	return out;
}

function parse_leases() { return cached_sec("leases", parse_leases_raw); }

function parse_neigh_raw() {
	let out = {};
	let data = cmd_output(`ip neigh show dev ${state.brdev} 2>/dev/null`);
	for (let line in split(data, "\n")) {
		let f = split(trim(line), " ");
		if (length(f) < 3) continue;
		let ip = f[0];
		let mac = field_after(f, "lladdr");
		let st = f[length(f) - 1];
		if (!mac || index(ip, ":") >= 0) continue;      // ipv4 only
		if (st == "FAILED" || st == "INCOMPLETE") continue;
		out[macnorm(mac)] = { ip };
	}
	return out;
}

function parse_neigh() { return cached_sec("neigh", parse_neigh_raw); }

// CAP 下发的终端名称表：SAP 上没有 DHCP 服务，/tmp/dhcp.leases 为空，
// 只能由 CAP 把租约里的主机名/IP 同步过来，子 AP 拓扑才能显示名称
function client_names() {
	let out = {};
	for (let mn, n in parse_neigh())
		out[mn] = { ip: n.ip };
	for (let mn, l in parse_leases())
		out[mn] = { hostname: l.hostname, ip: l.ip };
	return out;
}

// brctl showstp 输出 "lan6 (7)"：端口号 → 接口名。
// ImmortalWrt 默认不装 iproute2 的 bridge 命令，只能走 brctl 读 MAC 表。
function bridge_port_names() {
	let map = {};
	let data = cmd_output(`brctl showstp ${state.brdev} 2>/dev/null`);
	for (let line in split(data, "\n")) {
		let m = match(line, /^([^\s]+) \(([0-9]+)\)/);
		if (m) map[m[2]] = m[1];
	}
	return map;
}

function parse_fdb_raw() {
	let out = {};
	let data = cmd_output(`bridge fdb show br ${state.brdev} 2>/dev/null`);
	if (data != "") {
		for (let line in split(data, "\n")) {
			let f = split(trim(line), " ");
			if (length(f) < 3) continue;
			let mn = macnorm(f[0]);
			if (length(mn) != 12) continue;
			if (index(f, "self") >= 0 || index(f, "permanent") >= 0) continue;
			let port = field_after(f, "dev");
			if (!port) continue;
			out[mn] = port;
		}
		return out;
	}

	let pnames = bridge_port_names();
	data = cmd_output(`brctl showmacs ${state.brdev} 2>/dev/null`);
	// brctl 的列分隔符是 TAB（且年龄列前有额外空格），必须按任意空白分割
	for (let line in split(data, "\n")) {
		let f = split(trim(line), /[ \t]+/);
		if (length(f) < 3) continue;
		let mn = macnorm(f[1]);
		if (length(mn) != 12) continue;
		if (f[2] == "yes") continue;   // 网桥自身接口 MAC
		out[mn] = pnames[f[0]] ?? f[0];
	}
	return out;
}

function parse_fdb() { return cached_sec("fdb", parse_fdb_raw); }

// --------------------------------------------------- client internet pause
// 只拦主路由的 forward 链：终端仍可访问路由器本身（DHCP/DNS/管理页），
// 但无法经主路由上网；流量先经过应用统计链计数，再在这里丢弃。
function acl_load() {
	try {
		let data = json(fs.readfile(BLOCK_PATH));
		if (type(data) == "object") {
			state.blocked = {};
			for (let mn, v in (data.blocked ?? {}))
				if (v && length(mn) == 12) state.blocked[mn] = true;
		}
	} catch (e) { /* first boot */ }
}

function acl_save() {
	fs.mkdir(ALIAS_DIR);
	fs.writefile(BLOCK_PATH, sprintf("%.J", { ver: 1, blocked: state.blocked }));
}

function acl_apply() {
	if (state.cfg.role != "cap") {
		/* 角色切到子路由/未配置后，旧 CAP 留下的拦截表必须撤掉 */
		cmd_output(sprintf("nft delete table inet %s 2>/dev/null", BLOCK_TABLE));
		return false;
	}

	let mns = keys(state.blocked);
	if (!length(mns)) {
		cmd_output(sprintf("nft delete table inet %s 2>/dev/null", BLOCK_TABLE));
		return false;
	}

	cmd_output(sprintf("nft add table inet %s 2>/dev/null", BLOCK_TABLE));
	cmd_output(sprintf(
		"nft add chain inet %s forward '{ type filter hook forward priority 10; policy accept; }' 2>/dev/null",
		BLOCK_TABLE));

	let script = sprintf("flush chain inet %s forward\n", BLOCK_TABLE);
	for (let mn in mns)
		script += sprintf(
			"add rule inet %s forward ether saddr %s counter drop comment \"wr-acl:%s\"\n",
			BLOCK_TABLE, maccolon(mn), mn);
	fs.writefile(ACL_NFT_FILE, script);
	cmd_output(sprintf("nft -f %s 2>/dev/null", ACL_NFT_FILE));
	fs.unlink(ACL_NFT_FILE);
	return true;
}

function acl_set(mn, on) {
	if (on) {
		state.blocked[mn] = true;
		/* 已卸载到 flowtable 的连接会绕过 forward 链：先清掉该终端的
		   conntrack 条目，让后续报文重新经过 ACL 被丢弃。 */
		try {
			let ip = parse_leases()[mn]?.ip ?? parse_neigh()[mn]?.ip ?? null;
			if (ip) cmd_output(sprintf("conntrack -D -s %s 2>/dev/null", ip));
		} catch (e) {}
	}
	else {
		delete state.blocked[mn];
	}
	acl_save();
	acl_apply();

	/* 暂停状态立即同步到各子 AP，子 AP 页面无需等下一轮拓扑轮询 */
	if (state.cfg.role == "cap")
		for (let pmn, p in state.peers)
			if (p.authed) push_blocked_to(pmn);
}

// ---------------------------------------------------- internet schedule (ban)
// 上网时段：uci wifiroam/ban 每个终端一条（mac/name/timeon/timeoff/weekdays）。
// weekdays 为 "1 2 3"（1=周一 … 7=周日）；timeon > timeoff 表示跨午夜。
function ban_hm(v) {
	let m = match("" + (v ?? ""), /^([0-9]{1,2}):([0-9]{1,2})$/);
	if (!m) return null;
	let h = int(m[1]), mi = int(m[2]);
	if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
	return h * 60 + mi;
}

function ban_hm_str(mins) {
	let h = int(mins / 60), mi = mins % 60;
	return sprintf("%02d:%02d", h, mi);
}

function ban_weekdays(v) {
	let s = (type(v) == "array") ? join("", v)
		: replace("" + (v ?? ""), /[^0-9]/g, "");
	let out = [];
	for (let i = 0; i < length(s); i++) {
		let d = int(substr(s, i, 1));
		if (d >= 1 && d <= 7 && index(out, d) < 0) push(out, d);
	}
	sort(out, function(a, b) { return a - b; });
	return out;
}

function ban_read() {
	let cur = uci.cursor();
	cur.load("wifiroam");
	let leases = parse_leases();
	let list = [];
	let seen = {};
	cur.foreach("wifiroam", "ban", function(s) {
		let mn = macnorm(s.mac ?? "");
		if (length(mn) != 12 || seen[mn]) return;
		seen[mn] = true;
		let on = ban_hm(s.timeon), off = ban_hm(s.timeoff);
		let days = ban_weekdays(s.weekdays);
		let al = state.aliases.map[mn];
		push(list, {
			sid: s[".name"], mac: mn,
			name: (s.name ?? "") != "" ? s.name
				: (al?.name ?? leases[mn]?.hostname ?? ""),
			timeon: on == null ? BAN_DEFAULT_ON : ban_hm_str(on),
			timeoff: off == null ? BAN_DEFAULT_OFF : ban_hm_str(off),
			weekdays: length(days) ? days : [ 1, 2, 3, 4, 5, 6, 7 ],
		});
	});
	state.ban.list = list;
	return list;
}

/* 当前是否处于断网时段；起止时间相同视为全天生效 */
function ban_in_window(b, lt, nowmin) {
	if (!b.weekdays || !length(b.weekdays)) return false;
	let on = ban_hm(b.timeon), off = ban_hm(b.timeoff);
	if (on == null || off == null) return false;
	let wd = (lt.wday == 0) ? 7 : lt.wday;
	if (on == off) return index(b.weekdays, wd) >= 0;
	if (on < off)
		return index(b.weekdays, wd) >= 0 && nowmin >= on && nowmin < off;
	/* 跨午夜：今天已过起始时间，或昨天是起始日且还没到结束时间 */
	let prev = (wd == 1) ? 7 : wd - 1;
	return (index(b.weekdays, wd) >= 0 && nowmin >= on) ||
	       (index(b.weekdays, prev) >= 0 && nowmin < off);
}

/* 同步 nft：只在生效集合变化时重建，避免每轮 tick 刷链 */
function ban_apply(force) {
	let macs = [], blocked = {};
	if (state.cfg.role == "cap" && state.ban.enabled) {
		let lt = localtime(time());
		let nowmin = lt.hour * 60 + lt.min;
		for (let b in ban_read()) {
			if (!ban_in_window(b, lt, nowmin)) continue;
			if (blocked[b.mac]) continue;
			blocked[b.mac] = true;
			push(macs, b.mac);
		}
	}
	sort(macs);
	state.ban.active = blocked;

	/* 只有 CAP 需要这张表；角色降级为 SAP 时清掉残留规则 */
	if (state.cfg.role != "cap") {
		if (force || state.ban.sig != "") {
			cmd_output(sprintf("nft delete table inet %s 2>/dev/null", BAN_TABLE));
			state.ban.sig = "";
		}
		return macs;
	}

	let sig = join(",", macs);
	if (!force && sig == state.ban.sig) return macs;
	state.ban.sig = sig;

	if (!length(macs)) {
		cmd_output(sprintf("nft delete table inet %s 2>/dev/null", BAN_TABLE));
		return macs;
	}

	cmd_output(sprintf("nft add table inet %s 2>/dev/null", BAN_TABLE));
	cmd_output(sprintf(
		"nft add chain inet %s forward '{ type filter hook forward priority 10; policy accept; }' 2>/dev/null",
		BAN_TABLE));
	let script = sprintf("flush chain inet %s forward\n", BAN_TABLE);
	for (let mn in macs)
		script += sprintf(
			"add rule inet %s forward ether saddr %s counter drop comment \"wr-sched:%s\"\n",
			BAN_TABLE, maccolon(mn), mn);
	fs.writefile(BAN_NFT_FILE, script);
	cmd_output(sprintf("nft -f %s 2>/dev/null", BAN_NFT_FILE));
	fs.unlink(BAN_NFT_FILE);

	/* 已建立的连接/卸载流：删除 conntrack，让后续报文重新命中丢弃规则 */
	let leases = parse_leases(), neigh = parse_neigh();
	for (let mn in macs) {
		let ip = leases[mn]?.ip ?? neigh[mn]?.ip ?? null;
		if (ip) cmd_output(sprintf("conntrack -D -s %s 2>/dev/null", ip));
	}
	log(sprintf("ban: %d device(s) blocked", length(macs)));
	return macs;
}

function ban_rule_count() {
	let cur = uci.cursor();
	cur.load("wifiroam");
	let n = 0;
	cur.foreach("wifiroam", "ban", function() { n++; });
	return n;
}

/* 总开关：显式配置优先；从未设置时按是否存在时段规则决定默认值 */
function ban_reload_enabled() {
	let cur = uci.cursor();
	cur.load("wifiroam");
	let v = cur.get("wifiroam", "schedule", "enabled");
	state.ban.enabled = (v == null) ? (ban_rule_count() > 0) : (v == "1");
	return state.ban.enabled;
}

function ban_load() {
	ban_reload_enabled();
	ban_apply(true);
}

function ban_tick() {
	try {
		ban_apply(false);
	} catch (e) {
		log("ban tick failed: " + e);
	}
}


// 各站点的累计字节数（iw station dump）：用于由两次采样差分出实时上下行速率。
// hostapd 的 get_clients 只给信号/协商速率，没有字节计数，故单独取一次。
function station_bytes(ifname) {
	let now = time();
	let cache = state.bytes_cache[ifname];
	if (cache && now - cache.ts <= 1) return cache.map;

	let out = {};
	let data = cmd_output(`iw dev ${ifname} station dump 2>/dev/null`);
	let mac = null, rx = 0, tx = 0;

	for (let line in split(data, "\n")) {
		let t = trim(line);
		if (substr(t, 0, 8) == "Station ") {
			if (mac) out[mac] = { rx, tx };
			mac = macnorm(substr(t, 8, 17));
			rx = 0; tx = 0;
		}
		else if (mac && substr(t, 0, 9) == "rx bytes:") {
			rx = int(trim(substr(t, 9))) ?? 0;
		}
		else if (mac && substr(t, 0, 9) == "tx bytes:") {
			tx = int(trim(substr(t, 9))) ?? 0;
		}
	}
	if (mac) out[mac] = { rx, tx };

	state.bytes_cache[ifname] = { ts: now, map: out };
	return out;
}

function local_clients() {
	let clients = {};
	let now = time();

	// AP 自身接口 MAC（含无线回程 STA 口）不是终端：对端 AP 用无线回程接入时，
	// 其 STA 口会在本机 hostapd 客户端表里出现，若不排除会与 AP 节点重复计数
	let excl = {};
	for (let m in keys(state.self.ifaces ?? {})) excl[m] = true;
	for (let pmn, p in state.peers)
		for (let m in keys(p.info?.ifaces ?? {})) excl[m] = true;

	// wireless stations via hostapd ubus
	let ifmap = {};
	let ws = ubusc.call("network.wireless", "status");
	for (let rname, r in ws ?? {}) {
		let band = r.config?.band;
		for (let ifc in r.interfaces ?? []) {
			if (ifc.ifname)
				ifmap[ifc.ifname] = { ssid: ifc.config?.ssid, band, guest: guest_network_only(ifc.config?.network) };
		}
	}
	// hostapd ubus 对象名为 hostapd.<ifname>；ubus list(pattern) 在本平台
	// 返回签名表而非名称，故按 ifname 直接拼装
	for (let ifname in keys(ifmap)) {
		let res = ubusc.call("hostapd." + ifname, "get_clients");
		if (!res?.clients) continue;
		let bytes = station_bytes(ifname);
		for (let mac, ci in res.clients) {
			let mn = macnorm(mac);
			if (excl[mn]) continue;   // AP 自身接口，不是终端
			clients[mn] = {
				mac: uc(mac), type: "wifi", ifname,
				ssid: ifmap[ifname]?.ssid, guest: ifmap[ifname]?.guest,
				band: ifmap[ifname]?.band ?? freq_band(res.freq),
				rssi: ci.signal ?? null,
				connected_time: ci.connected_time ?? null,
				// hostapd 上报的 rate 单位是 100 kbit/s（驱动速率 ×100），
				// 除以 100000 换算为 Mbps（如 7220000 -> 72.2 Mbps）；
				// 注意 ucode 整数相除会截断，必须用浮点字面量
				tx_rate: ci.rate?.tx != null ? ci.rate.tx / 100000.0 : null,
				rx_rate: ci.rate?.rx != null ? ci.rate.rx / 100000.0 : null,
				// 站点累计字节：rx=终端上行，tx=终端下行，用于总流量统计
				rx_bytes: null, tx_bytes: null,
				// 实时速率（Mbps）：由站点字节计数两次采样差分得到。
				// rx_speed = 终端 → AP（终端发送），tx_speed = AP → 终端（终端接收）
				rx_speed: null, tx_speed: null,
			};

			let b = bytes[mn];
			if (!b) continue;

			clients[mn].rx_bytes = b.rx;
			clients[mn].tx_bytes = b.tx;

			let prev = state.client_bytes[mn];
			if (prev && now > prev.ts) {
				let dt = now - prev.ts;
				// 计数回退（终端重连/计数器复位）时本轮不出速率。
				// 关键：ucode 整数相除会截断（全 int 运算时 <1Mbps 的速率
				// 全被截成 0），必须用浮点字面量 8.0 提升精度
				if (b.rx >= prev.rx)
					clients[mn].rx_speed = (b.rx - prev.rx) * 8.0 / dt / 1000000;
				if (b.tx >= prev.tx)
					clients[mn].tx_speed = (b.tx - prev.tx) * 8.0 / dt / 1000000;
			}
			state.client_bytes[mn] = { ts: now, rx: b.rx, tx: b.tx };
		}
	}

	// ip/hostname enrichment + wired clients
	let leases = parse_leases();
	let neigh = parse_neigh();
	let fdb = parse_fdb();

	for (let mn, l in leases) {
		if (clients[mn]) {
			clients[mn].ip = l.ip;
			clients[mn].hostname = l.hostname;
		}
	}
	for (let mn, n in neigh) {
		if (clients[mn] && !clients[mn].ip) clients[mn].ip = n.ip;
	}
	// SAP：用 CAP 下发的名称表补全主机名/IP（本机无 DHCP 租约）
	for (let mn, n in state.net_names ?? {}) {
		if (!clients[mn]) continue;
		if (clients[mn].hostname == null && n.hostname != null)
			clients[mn].hostname = n.hostname;
		if (clients[mn].ip == null && n.ip != null)
			clients[mn].ip = n.ip;
	}

	let self_mn = macnorm(state.self.mac);

	// 级联/上行口：其他 AP（peers/discovered）的 MAC 在 FDB 中所处的端口，
	// 其下游终端由对端 AP 自行上报，本机不再计为终端
	// （否则对端 WiFi 终端会被本机 FDB 从上行口学成 wired 幻影，漫游后长期挂在旧 AP 下）
	let cascade = {};
	for (let mn, p in state.peers) {
		let pt = fdb[mn];
		if (pt) cascade[pt] = true;
		// 无线回程/桥接的 SAP 可能只暴露其 STA/AP 接口 MAC，
		// 这些 MAC 所在的网桥端口同样是"通往对端 AP"的级联口
		for (let m in keys(p.info?.ifaces ?? {})) {
			let q = fdb[m];
			if (q) cascade[q] = true;
		}
	}
	for (let mn in keys(state.discovered)) {
		let pt = fdb[mn];
		if (pt) cascade[pt] = true;
	}

	// 有线终端在线依据只用 FDB（帧级存活，~5min 老化）：
	// DHCP lease（12h）与 ARP STALE 长期残留，会把已离线设备算进来；
	// wired_seen 提供 WIRED_TTL 滞后，防止 FDB 老化边缘抖动
	let seen = state.wired_seen;
	for (let mn, port in fdb) {
		if (mn == self_mn) continue;
		if (excl[mn]) { delete seen[mn]; continue; }      // AP 自身接口
		if (substr(mn, 0, 6) == "01005e" || substr(mn, 0, 4) == "3333") continue;
		if (substr(mn, 0, 6) == "0180c2") continue;       // L2 控制帧（STP/LLDP 等）
		// AP 节点或级联口下游：立即从有线表清除，避免重启初期对端尚未
		// 上报时被记成有线终端后残留 WIRED_TTL 那么久
		if (state.peers[mn] || state.discovered[mn]) { delete seen[mn]; continue; }
		if (cascade[port]) { delete seen[mn]; continue; } // 对端 AP 下游
		seen[mn] = now;
	}
	for (let mn in keys(seen)) {
		if (now - seen[mn] > WIRED_TTL) {
			delete seen[mn];
			continue;
		}
		if (clients[mn]) continue;                        // already wifi
		clients[mn] = {
			mac: maccolon(mn), type: "wired",
			ip: leases[mn]?.ip ?? neigh[mn]?.ip ?? state.net_names?.[mn]?.ip ?? null,
			hostname: leases[mn]?.hostname ?? state.net_names?.[mn]?.hostname ?? null,
			port: fdb[mn] ?? null,
		};
	}

	// first-seen tracking
	for (let mn in keys(clients)) {
		if (!state.client_seen[mn]) state.client_seen[mn] = now;
		clients[mn].since = state.client_seen[mn];
	}
	return clients;
}

/* 同一秒内的客户端快照复用：sap_tick/sap_report、usage_tick、appctl_tick、
   status 与 topology 会连续触发，共享快照可避免重复的 hostapd ubus 与 iw 调用。
   站点评率采样本身按秒差分，秒内复用不会影响速率计算。 */
function local_clients_cached() {
	let now = time();
	if (_clients_cache.data && _clients_cache.ts == now)
		return _clients_cache.data;
	let data = local_clients();
	_clients_cache = { ts: now, data };
	return data;
}

// steering 专用轻量客户端表：只走 hostapd ubus 取 RSSI/在线时长，
// 不做 iw 字节采样、DHCP/ARP/FDB 解析；3s 采样也不会带来明显开销。
function wifi_clients() {
	let clients = {};

	let excl = {};
	for (let m in keys(state.self.ifaces ?? {})) excl[m] = true;
	for (let pmn, p in state.peers)
		for (let m in keys(p.info?.ifaces ?? {})) excl[m] = true;

	let ws = ubusc.call("network.wireless", "status") ?? {};
	for (let rname, r in ws) {
		let band = r.config?.band;
		for (let ifc in r.interfaces ?? []) {
			if (ifc.config?.mode && ifc.config.mode != "ap") continue;
			if (!ifc.ifname) continue;
			let res = ubusc.call("hostapd." + ifc.ifname, "get_clients");
			if (!res?.clients) continue;
			for (let mac, ci in res.clients) {
				let mn = macnorm(mac);
				if (excl[mn]) continue;
				clients[mn] = {
					mac: uc(mac), type: "wifi", ifname: ifc.ifname,
					ssid: ifc.config?.ssid,
					guest: guest_network_only(ifc.config?.network),
					band: band ?? freq_band(res.freq),
					rssi: ci.signal ?? null,
					connected_time: ci.connected_time ?? null,
				};
			}
		}
	}
	return clients;
}

// ------------------------------------------------ 上网统计（在线时长 + 流量）
// 只统计总量：用 nft 的 per-MAC counter 累计终端每日流量，不做应用识别。
function usage_day() {
	let lt = localtime(time());
	return sprintf("%04d-%02d-%02d", lt.year, lt.mon, lt.mday);
}

// 按天分桶只保留最近 7 天：日期字符串字典序即时间序，删最旧的
function usage_prune(map, keep) {
	let ks = sort(keys(map));
	while (length(ks) > (keep ?? 7)) {
		delete map[ks[0]];
		shift(ks);
	}
}

function usage_roll_day() {
	let day = usage_day();
	if (state.usage.day == day) return;
	state.usage.day = day;
	for (let mn, d in state.usage.online) usage_prune(d);
	for (let mn, d in state.usage.ndata) usage_prune(d);
	for (let mn, d in state.usage.ndir) usage_prune(d);
	state._usage_dirty = true;
}

function usage_track_macs(clients) {
	let set = {};
	for (let mn in (clients ?? local_clients_cached())) set[mn] = true;
	for (let pmn, p in state.peers)
		for (let mn in (p.clients ?? {})) set[mn] = true;
	return set;
}

/* CAP 只把该 SAP 自己终端的统计回传给 SAP，避免子 AP 页面看到全量数据 */
function usage_for_clients(clients) {
	let out = { day: state.usage.day, online: {}, ndata: {}, ndir: {} };
	for (let mn in (clients ?? {})) {
		if (state.usage.online[mn]) out.online[mn] = state.usage.online[mn];
		if (state.usage.ndata[mn]) out.ndata[mn] = state.usage.ndata[mn];
		if (state.usage.ndir[mn]) out.ndir[mn] = state.usage.ndir[mn];
	}
	return out;
}

/* 站点计数作为 nft 的补充：同时包含上下行，且不受 flow offload 影响。
   SAP 会在客户端信息里上报 rx_bytes/tx_bytes，CAP 汇总后做差分。 */
function station_usage_map(clients) {
	let map = {};

	function take(src, only_new) {
		for (let mn, c in src) {
			if (only_new && map[mn]) continue;
			if (!c || c.type != "wifi" || c.rx_bytes == null || c.tx_bytes == null)
				continue;
			map[mn] = { rx: int(c.rx_bytes), tx: int(c.tx_bytes) };
		}
	}

	take(clients ?? {}, false);
	for (let pmn, p in state.peers)
		take(p.clients ?? {}, true);
	return map;
}

/* ucode 单遍绑定：usage_add_traffic 必须在 station_usage_sample 之前定义 */
function usage_add_traffic(mn, up, down) {
	let u = int(up ?? 0), d = int(down ?? 0);
	if (u <= 0 && d <= 0) return;
	if (!state.usage.ndata[mn]) state.usage.ndata[mn] = {};
	let nd = state.usage.ndata[mn];
	nd[state.usage.day] = (nd[state.usage.day] ?? 0) + u + d;
	if (!state.usage.ndir[mn]) state.usage.ndir[mn] = {};
	let dir = state.usage.ndir[mn];
	let e = dir[state.usage.day] ??= { u: 0, d: 0 };
	e.u = (e.u ?? 0) + u;
	e.d = (e.d ?? 0) + d;
	state._usage_dirty = true;
}

/* 站点计数用于补充 nft 看不到的流量（flow offload），只返回本轮增量。
   hostapd 的 rx 是终端发往 AP（上行），tx 是 AP 发往终端（下行）。 */
function station_usage_sample(map) {
	let snap = state._usage_station_snap ?? {};
	let fresh = {};
	let deltas = {};

	for (let mn, b in map) {
		let prev = snap[mn];
		if (prev && b.rx >= prev.rx && b.tx >= prev.tx) {
			let du = b.rx - prev.rx, dd = b.tx - prev.tx;
			if (du > 0 || dd > 0) deltas[mn] = { u: du, d: dd };
		}
		fresh[mn] = b;
	}
	state._usage_station_snap = fresh;
	return deltas;
}

/* 终端 MAC -> IPv4：下行按目的 IP 计数（与 OAF 的 forward hook 一致），
   不依赖 Ethernet 目的 MAC，避免路由模式下只统计到上行。 */
function usage_ip_map(clients) {
	let map = {};

	function take(src) {
		for (let mn, c in src)
			if (!map[mn] && c?.ip) map[mn] = c.ip;
	}

	take(clients ?? {});
	for (let pmn, p in state.peers)
		take(p.clients ?? {});
	for (let mn, n in (state.net_names ?? {}))
		if (!map[mn] && n?.ip) map[mn] = n.ip;
	return map;
}

function usage_ip6_map(clients) {
	let map = {};

	let data = cmd_output(`ip -6 neigh show dev ${state.brdev} 2>/dev/null`);
	for (let line in split(data, "\n")) {
		let m = match(line, /^([0-9a-fA-F:]+)\s+.*lladdr\s+([0-9a-fA-F:]{17})/);
		if (!m) continue;
		let mn = macnorm(m[2]);
		if (length(mn) != 12) continue;
		/* 优先全局地址，避免把 fe80:: 当成下行目的地址 */
		if (!map[mn] || index(map[mn], "fe80:") == 0)
			map[mn] = m[1];
	}
	return map;
}

function usage_apply_rules(force, set, ips, ips6, before_flush) {
	if (state.cfg.role != "cap") return false;
	set = set ?? usage_track_macs();
	ips = ips ?? {};
	ips6 = ips6 ?? {};
	let parts = [];
	for (let mn in set)
		push(parts, mn + "=" + (ips[mn] ?? "") + "|" + (ips6[mn] ?? ""));
	let key = join(",", sort(parts));
	if (!force && state._usage_track != null && key == state._usage_track) return false;

	/* 规则重建会清空计数器；先采样旧计数，避免丢掉这一轮的增量 */
	if (before_flush) before_flush();

	cmd_output(sprintf("nft add table inet %s 2>/dev/null", USAGE_TABLE));
	cmd_output(sprintf(
		"nft add chain inet %s forward '{ type filter hook forward priority -10; policy accept; }' 2>/dev/null",
		USAGE_TABLE));
	let script = sprintf("flush chain inet %s forward\n", USAGE_TABLE);
	for (let mn in set) {
		/* 上行按源 MAC，下行按目的 IPv4/IPv6，两个方向分别计数 */
		script += sprintf(
			"add rule inet %s forward ether saddr %s counter comment \"wu-u:%s\"\n",
			USAGE_TABLE, maccolon(mn), mn);
		let ip = "" + (ips[mn] ?? "");
		if (match(ip, /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/))
			script += sprintf(
				"add rule inet %s forward ip daddr %s counter comment \"wu-d:%s\"\n",
				USAGE_TABLE, ip, mn);
		let ip6 = "" + (ips6[mn] ?? "");
		if (match(ip6, /^[0-9a-fA-F:]+$/) && index(ip6, ":") >= 0)
			script += sprintf(
				"add rule inet %s forward ip6 daddr %s counter comment \"wu-d:%s\"\n",
				USAGE_TABLE, ip6, mn);
	}
	let path = "/tmp/wifiroam-usage.nft";
	fs.writefile(path, script);
	cmd_output(sprintf("nft -f %s 2>/dev/null", path));
	fs.unlink(path);

	// chain 重建会把 counter 归零，重置快照避免把归零误判成负增量
	state._usage_snap = null;
	state._usage_ts = 0;
	state._usage_track = key;
	return true;
}

function usage_sample(set) {
	if (state.cfg.role != "cap") return {};
	let out = cmd_output(sprintf("nft -j list table inet %s 2>/dev/null", USAGE_TABLE));
	if (out == "") {
		// 表被防火墙清掉：下一轮强制重建
		state._usage_track = "";
		return {};
	}
	let data;
	try { data = json(out); } catch (e) { return {}; }
	if (type(data) != "object" || type(data.nftables) != "array") return {};
	let snap = state._usage_snap ?? {};
	let fresh = {};
	let deltas = {};
	let want = {};
	for (let mn in (set ?? {})) want[mn] = true;

	for (let item in data.nftables) {
		let r = item.rule;
		if (!r) continue;
		let p = split(r.comment ?? "", ":");
		if (length(p) != 2 || (p[0] != "wu-u" && p[0] != "wu-d")) continue;
		let mn = p[1], by = 0;
		for (let e in (r.expr ?? []))
			if (e.counter) { by = int(e.counter.bytes ?? 0); break; }
		let f = fresh[mn] ??= { u: 0, d: 0 };
		if (p[0] == "wu-u") f.u += by;
		else f.d += by;
		delete want[mn];
	}
	// 规则被防火墙清掉时强制下一轮重建，避免统计永久停摆
	if (length(keys(want))) state._usage_track = "";

	for (let mn, v in fresh) {
		let prev = snap[mn];
		if (prev == null || v.u < prev.u || v.d < prev.d) continue;
		let du = v.u - prev.u, dd = v.d - prev.d;
		if (du > 0 || dd > 0) deltas[mn] = { u: du, d: dd };
	}
	state._usage_snap = fresh;
	state._usage_ts = time();
	return deltas;
}

function usage_online_sample(seen) {
	if (state.cfg.role != "cap") return;
	let now = time();
	let dt = now - (state._usage_online_ts ?? 0);
	if (!state._usage_online_ts || dt <= 0 || dt > 180)
		dt = int(USAGE_TICK / 1000);
	state._usage_online_ts = now;

	seen = seen ?? usage_track_macs();
	if (!length(keys(seen))) return;
	for (let mn in seen) {
		if (!state.usage.online[mn]) state.usage.online[mn] = {};
		let d = state.usage.online[mn];
		d[state.usage.day] = (d[state.usage.day] ?? 0) + dt;
	}
	state._usage_dirty = true;
}

function usage_load() {
	try {
		let d = json(fs.readfile(USAGE_PATH));
		if (type(d) == "object") {
			state.usage.day = d.day ?? "";
			state.usage.online = d.online ?? {};
			state.usage.ndata = d.ndata ?? {};
			state.usage.ndir = d.ndir ?? {};
		}
	} catch (e) { /* first boot */ }
}

function usage_save() {
	fs.mkdir(ALIAS_DIR);
	fs.writefile(USAGE_PATH, sprintf("%.J", {
		ver: 1, day: state.usage.day,
		online: state.usage.online, ndata: state.usage.ndata,
		ndir: state.usage.ndir,
	}));
	state._usage_dirty = false;
	state._usage_saved = time();
}

function usage_tick() {
	if (state.cfg.role != "cap") return;
	try {
		usage_roll_day();
		let clients = local_clients_cached();
		let all = usage_track_macs(clients);
		let stations = station_usage_map(clients);

		/* 在线时长与流量采集解耦：某一项异常不影响另一项 */
		usage_online_sample(all);

		let nft = {};
		try {
			let ips = usage_ip_map(clients);
			let ips6 = usage_ip6_map(clients);
			let changed = usage_apply_rules(false, all, ips, ips6, function() {
				nft = usage_sample(all);
			});
			if (!changed) nft = usage_sample(all);
		} catch (e) { log("usage nft failed: " + e); }

		let st = {};
		try { st = station_usage_sample(stations); }
		catch (e) { log("usage station failed: " + e); }

		let add = {};
		for (let mn, v in nft)
			add[mn] = { u: int(v.u), d: int(v.d) };
		for (let mn, v0 in st) {
			let v = add[mn] ??= { u: 0, d: 0 };
			if (int(v0.u) > v.u) v.u = int(v0.u);
			if (int(v0.d) > v.d) v.d = int(v0.d);
		}
		for (let mn, v in add)
			usage_add_traffic(mn, v.u, v.d);
		if (state._usage_dirty && time() - state._usage_saved >= USAGE_FLUSH)
			usage_save();
	} catch (e) {
		/* 单个统计异常不能让整个 wifiroamd 退出，否则 procd 会不断重启 */
		log("usage_tick failed: " + e);
	}
}

// 参与统计/管控的终端：已配置 appdev 的设备 + 本机在线终端 + 对端 AP 上报的终端。
// 若只给「配置过禁止应用」的设备建规则，其余终端没有任何 counter，时长永远为 0。
appctl_track_macs = function() {
	let set = {};
	for (let mn in state.appctl.devices) set[mn] = true;
	let lc = local_clients_cached();
	for (let mn in lc) set[mn] = true;
	for (let pmn, p in state.peers)
		for (let mn in (p.clients ?? {})) set[mn] = true;
	return set;
};

// 在线时长按天累计：CAP 每 tick 给当前在线终端（本机 + SAP 上报）加窗口秒数，
// 与 appctl 开关无关，供「上网统计」的昨日/今日/过去七天查询
online_sample = function() {
	if (state.cfg.role != "cap") return;
	let now = time();
	let dt = now - (state._online_ts ?? 0);
	if (!state._online_ts || dt <= 0 || dt > 180)
		dt = int(TICK_INTERVAL / 1000);
	state._online_ts = now;

	let seen = {};
	let lc = local_clients_cached();
	for (let mn in lc) seen[mn] = true;
	for (let pmn, p in state.peers)
		for (let mn in (p.clients ?? {})) seen[mn] = true;

	let day = state.appctl.day;
	for (let mn in seen) {
		if (!state.appctl.online[mn]) state.appctl.online[mn] = {};
		state.appctl.online[mn][day] = (state.appctl.online[mn][day] ?? 0) + dt;
	}
	if (length(keys(seen))) state._appstat_dirty = true;
};

function diff_events(prev, cur, apname) {
	for (let mn in keys(cur))
		if (!prev[mn]) push_event("client_join", maccolon(mn), apname, client_name_of(mn, cur));
	for (let mn in keys(prev))
		if (!cur[mn]) push_event("client_leave", maccolon(mn), apname, client_name_of(mn, prev));
}

// ------------------------------------------------------------- UDP discovery
function udp_send(obj) {
	if (!udp_sock) return;
	udp_sock.send(sprintf("%.J", obj), 0,
		{ address: state.bcast ?? "255.255.255.255", port: UDP_PORT });
}

function send_hello() {
	udp_send({
		magic: MAGIC, ver: 1, role: state.cfg.role,
		mac: state.self.mac, ip: state.self.ip,
		name: state.self.name, model: state.self.model,
		nonce: state.self.nonce,
		thash: substr(sha256("wifiroam:" + state.cfg.token), 0, 16),
		alias_ver: state.aliases.ver, ts: time(),
	});
}

// 判断 UDP hello 是否说明「已配对的主 AP 已经丢失配置」。
// 返回 ""（无关）、"ok"（同一网络）、"unconfigured"（主 AP 回到未配置）、
// "token"（主 AP 换了网络令牌）。优先用持久化的 CAP MAC 识别，
// 旧配对没有 MAC 时才退回 IP 比较。
function cap_lost_kind(msg, mn, src, cap_mac, cap_ip, token) {
	let cm = macnorm(cap_mac ?? "");
	let from_cap = cm != ""
		? (mn == cm)
		: (cap_ip != "" && (msg.ip ?? src) == cap_ip);
	if (!from_cap) return "";
	if (msg.role == "unconfigured") return "unconfigured";
	if (msg.role != "cap" || msg.thash == null) return "";
	let my_th = substr(sha256("wifiroam:" + token), 0, 16);
	return msg.thash == my_th ? "ok" : "token";
}

function sap_cap_lost(msg, mn, src) {
	if (state.cfg.role != "sap") return false;
	let cap_ip = state.cfg.cap_ip != "" ? state.cfg.cap_ip : (state.cap_learned ?? "");
	let kind = cap_lost_kind(msg, mn, src,
		state.cfg.cap_mac, cap_ip, state.cfg.token);
	if (kind == "ok") {
		state.cap_lost_since = null;
		return false;
	}
	if (kind == "") return false;

	/* 连续 15s 看到主 AP 处于未配置/换 token 状态才重置，
	   避免单包丢失或主 AP 短暂重启时误把子 AP 退出组网 */
	state.cap_lost_since ??= time();
	if (time() - state.cap_lost_since < CAP_LOST_GRACE) return false;

	sap_self_reset(kind == "unconfigured" ? "cap_unconfigured" : "cap_token_changed");
	return true;
}

function udp_rx() {
	while (true) {
		let peer = {};
		let data = udp_sock.recv(4096, 0, peer);
		if (!data) break;
		let msg;
		try { msg = json(data); } catch (e) { continue; }
		if (type(msg) != "object" || msg.magic != MAGIC) continue;
		let mn = macnorm(msg.mac);
		if (length(mn) != 12 || mn == macnorm(state.self.mac)) continue;

		/* SAP：主 AP 被重置/换 token 后，UDP 里能第一时间看出来，
		   不必等 TCP 重连超时，也不会一直卡在旧的组网角色 */
		if (sap_cap_lost(msg, mn, peer.address)) continue;

		if (msg.role == "unconfigured") {
			let dip = msg.ip ?? peer.address;

			/* CAP：已配对设备重新变成未配置（重置/刷机），立即从成员列表
			   摘掉并关掉旧连接，让它马上出现在「发现新设备」里 */
			if (state.cfg.role == "cap") {
				let oldp = state.peers[mn];
				/* 刚配对的 SAP 可能还有一个未配置 UDP 包在途，
				   认证后 5s 内不据此摘除，避免刚配对就被踢掉 */
				let just_authed = oldp?.authed &&
					time() - (oldp.authed_at ?? 0) < 5;
				if (oldp && !just_authed) {
					delete state.peers[mn];
					if (oldp.chan) try { oldp.chan.disconnect(); } catch (e) {}
					push_event("unpaired", msg.mac,
						oldp.info?.name ?? oldp.name ?? "");
					log(sprintf("peer %s reverted to unconfigured", msg.mac));
				}
			}

			let old = state.discovered[mn];
			if (!old || old.ip != dip)
				log(sprintf("discovery: %s at %s name=%s",
					msg.mac, dip ?? "?", msg.name ?? "?"));
			state.discovered[mn] = {
				mac: uc(msg.mac), ip: dip,
				name: msg.name, model: msg.model,
				nonce: msg.nonce, last_seen: time(),
			};
			continue;
		}

		let my_th = substr(sha256("wifiroam:" + state.cfg.token), 0, 16);
		if (state.cfg.token == "" || msg.thash != my_th) continue; // foreign net

		let p = state.peers[mn] ??= { clients: null }; // null = 未收过 report，首轮 diff 抑制
		p.mac = uc(msg.mac);
		p.ip = msg.ip ?? peer.address;
		p.name = msg.name;
		p.model = msg.model;
		p.role = msg.role;
		p.last_seen = time();
		if (msg.role == "cap" && msg.ip)
			state.cap_learned = msg.ip;
	}
}

function expire_tick() {
	refresh_self_ip();

	let now = time();
	for (let mn in keys(state.peers)) {
		if (now - (state.peers[mn].last_seen ?? 0) > PEER_TTL) {
			let p = state.peers[mn];
			push_event("ap_offline", maccolon(mn), p.name ?? "");
			if (p.chan) p.chan.disconnect();
			delete state.peers[mn];
		}
	}
	for (let mn in keys(state.discovered))
		if (now - state.discovered[mn].last_seen > DISCOVER_TTL)
			delete state.discovered[mn];
}

function setup_udp() {
	udp_sock = socket.create(socket.AF_INET,
		socket.SOCK_DGRAM | socket.SOCK_NONBLOCK, 0);
	if (!udp_sock) { log("udp create failed"); return; }
	udp_sock.setopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, true);
	udp_sock.setopt(socket.SOL_SOCKET, socket.SO_BROADCAST, true);
	if (!udp_sock.bind("0.0.0.0:" + UDP_PORT)) {
		log("udp bind failed: " + socket.error());
		udp_sock.close(); udp_sock = null;
		exit(1);   // 传输不可用 = 守护进程无意义，fail-fast 交 procd 处置
	}
	log(sprintf("discovery udp %d bcast=%s", UDP_PORT, state.bcast ?? "?"));
	uloop.handle(udp_sock.fileno(), udp_rx, uloop.ULOOP_READ);
}

// ---------------------------------------------------------- topology build
function ap_display(mn) {
	if (mn == "") return state.self.name;
	let al = state.aliases.map[mn];
	if (al?.name != null && al.name != "") return al.name;
	if (mn == macnorm(state.self.mac)) return state.self.name;
	let p = state.peers[mn];
	return p ? (p.info?.name ?? p.name ?? maccolon(mn)) : maccolon(mn);
}

// 终端归属表：同一终端可能被多个 AP 的 FDB 学到（对端 WiFi 终端会被
// SAP 侧报成 wired），按 mac 去重，归属优先级：wifi > wired，本机 > 对端
function compute_owner(my, self_mn) {
	let owner = {};
	for (let pass in [ "wifi", "wired" ]) {
		for (let mn, c in my)
			if (!owner[mn] && (c.type ?? "wired") == pass)
				owner[mn] = self_mn;
		for (let pmn, p in state.peers)
			for (let mn, c in p.clients ?? {})
				if (!owner[mn] && (c.type ?? "wired") == pass)
					owner[mn] = pmn;
	}
	return owner;
}

// CAP 视角跨 AP 迁移事件：归属从一台 AP 变到另一台 => roam_move
//（各 AP 本地的 join/leave 事件照旧保留，roam_move 是网络视角的结论）
function owner_events(my) {
	if (state.cfg.role != "cap") return;
	let owner = compute_owner(my, macnorm(state.self.mac));
	if (state.prev_owner != null)
		for (let mn, ap in owner) {
			let old = state.prev_owner[mn];
			if (old != null && old != ap)
				push_event("roam_move", maccolon(mn),
					sprintf("%s → %s", ap_display(old), ap_display(ap)),
					client_name_of(mn, my), { from: old, to: ap });
		}
	state.prev_owner = owner;
}

function client_node(mn, c, parent) {
	let al = state.aliases.map[mn];
	return {
		id: mn, type: "client",
		name: (al?.name != null && al.name != "") ? al.name :
		      (c.hostname ?? maccolon(mn)),
		custom_name: (al?.name != null && al.name != "") ? al.name : null,
		hostname: c.hostname ?? null,
		ip: c.ip ?? null, mac: c.mac ?? maccolon(mn),
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
		blocked: !!state.blocked[mn],
		pin: pin_of(mn),
		pin_name: pin_of(mn) ? ap_name_of(pin_of(mn)) : null,
	};
}

function build_topology() {
	let nodes = [];
	let self_mn = macnorm(state.self.mac);
	let myclients = local_clients_cached();

	let ap_nodes = {};
	let self_al = state.aliases.map[self_mn];
	let self_node = {
		id: self_mn, type: "ap", role: state.cfg.role,
		name: (self_al?.name != null && self_al.name != "") ? self_al.name : state.self.name,
		custom_name: (self_al?.name != null && self_al.name != "") ? self_al.name : null,
		model: state.self.model,
		ip: state.self.ip, mac: state.self.mac,
		parent: null, uplink: detect_uplink(),
		firmware: state.self.firmware, uptime: self_uptime(),
		online: true,
		clients: [],
	};
	push(nodes, self_node);
	ap_nodes[self_mn] = self_node;

	let peer_clients = {};
	for (let mn, p in state.peers) {
		let pal = state.aliases.map[mn];
		let pname = (pal?.name != null && pal.name != "") ? pal.name
		                                                 : (p.info?.name ?? p.name ?? mn);
		let n = {
			id: mn, type: "ap",
			role: p.info?.role ?? p.role ?? "sap",
			name: pname,
			custom_name: (pal?.name != null && pal.name != "") ? pal.name : null,
			model: p.info?.model ?? p.model ?? null,
			ip: p.info?.ip ?? p.ip, mac: p.mac ?? maccolon(mn),
			parent: self_mn,
			uplink: p.info?.uplink ?? null,
			firmware: p.info?.firmware ?? null,
			uptime: p.info?.uptime ?? null,
			authed: !!p.authed,
			/* 能留在 peers 里说明 30s 内收到过 hello（含 SAP 视角的其它子 AP） */
			online: true,
			clients: [],
		};
		push(nodes, n);
		ap_nodes[mn] = n;
		peer_clients[mn] = p.clients ?? {};
	}

	// 按 mac 去重归属（规则见 compute_owner）
	let owner = compute_owner(myclients, self_mn);
	// 对端（SAP）无 DHCP 服务，其上报终端可能缺 ip/hostname，
	// 用本机 leases/ARP 补全，保证各 AP 下挂设备信息一致
	let leases = parse_leases();
	let neigh = parse_neigh();
	for (let mn, ap in owner) {
		let c = (ap == self_mn ? myclients : peer_clients[ap])[mn];
		if (c.ip == null)
			c.ip = leases[mn]?.ip ?? neigh[mn]?.ip ?? state.net_names?.[mn]?.ip ?? null;
		if (c.hostname == null)
			c.hostname = leases[mn]?.hostname ?? state.net_names?.[mn]?.hostname ?? null;
		push(nodes, client_node(mn, c, ap));
		push(ap_nodes[ap].clients, mn);
	}
	return { nodes, self: self_mn, role: state.cfg.role, now: time() };
}

// --------------------------------------------------------- device history
// 终端历史：在线状态由本机 + 对端上报的客户端表推导，离线记录保留供
// 设备页展示与网络唤醒使用，落盘 /etc/wifiroam/devices.json。

function devices_load() {
	let data;
	try { data = json(fs.readfile(DEVICES_PATH)); } catch (e) { return; }
	if (type(data) != "object") return;
	for (let key, d in data) {
		if (type(d) != "object") continue;
		/* 重启后先全部置为离线，本轮扫描到的会立即标回在线；
		   这样断电期间产生的「最后离线时间」不会被伪造 */
		d.online = false;
		state.devices[key] = d;
	}
}

function devices_save(force) {
	if (!state._dev_dirty) return;
	let now = time();
	if (!force && now - state._dev_saved < DEVICES_FLUSH) return;
	try {
		fs.mkdir(ALIAS_DIR);
		fs.writefile(DEVICES_PATH, sprintf("%.J", state.devices));
		state._dev_saved = now;
		state._dev_dirty = false;
	} catch (e) {
		log("devices save failed");
	}
}

/* 终端管理设置：历史条数上限、固定 AP 纠正开关与禁入时长。
   保存在 uci wifiroam/devices，CAP 保存后同步给所有子 AP。 */
function devices_cfg() {
	let cur = uci.cursor();
	cur.load("wifiroam");
	let max = int(cur.get("wifiroam", "devices", "max") ?? DEVICES_MAX);
	let ban = int(cur.get("wifiroam", "devices", "ban") ?? (PIN_BAN_MS / 1000));
	if (max < 20) max = 20;
	if (max > 2000) max = 2000;
	if (ban < 10) ban = 10;
	if (ban > 3600) ban = 3600;
	return {
		max,
		ban,
		pin_enforce: cur.get("wifiroam", "devices", "pin_enforce") != "0",
	};
}

/* SAP：应用 CAP 下发的终端管理设置（仅在值变化时写 uci） */
function devices_cfg_apply(d) {
	if (type(d) != "object") return;
	let cur = uci.cursor();
	cur.load("wifiroam");
	let changed = false;
	for (let k in [ "max", "ban", "pin_enforce" ]) {
		if (d[k] == null) continue;
		let v = (k == "pin_enforce") ? (d[k] ? "1" : "0") : ("" + int(d[k]));
		if (cur.get("wifiroam", "devices", k) != v) {
			cur.set("wifiroam", "devices", k, v);
			changed = true;
		}
	}
	if (changed) cur.commit("wifiroam");
}

/* 历史条数上限：优先淘汰最久未上线、且没有被手动命名的记录 */
function devices_trim() {
	let max = devices_cfg().max;
	let total = length(keys(state.devices));
	if (total <= max) return;
	let cand = [];
	for (let key, d in state.devices) {
		if (d.online) continue;
		if (state.aliases.map?.[key]) continue;
		if (state.aliases.pin?.[key]) continue;
		push(cand, { key, ts: d.last_online ?? d.first_seen ?? 0 });
	}
	sort(cand, function(a, b) { return a.ts - b.ts; });
	for (let i = 0; i < length(cand) && total > max; i++, total--)
		delete state.devices[cand[i].key];
}

/* 当前全网络在线终端：归属规则与 build_topology 一致，
   SAP 缺失的 IP/主机名由 CAP 的租约/ARP/名称表补全 */
function devices_live() {
	let my = local_clients_cached();
	let self_mn = macnorm(state.self.mac);
	let owner = compute_owner(my, self_mn);
	let leases = parse_leases();
	let neigh = parse_neigh();
	let live = {};
	for (let mn, ap in owner) {
		let c = (ap == self_mn ? my : (state.peers[ap]?.clients ?? {}))[mn];
		if (!c) continue;
		if (c.ip == null)
			c.ip = leases[mn]?.ip ?? neigh[mn]?.ip ?? state.net_names?.[mn]?.ip ?? null;
		if (c.hostname == null)
			c.hostname = leases[mn]?.hostname ?? state.net_names?.[mn]?.hostname ?? null;
		live[mn] = { mn, c, ap };
	}
	return live;
}

/* 终端历史里如果出现的是本机/成员 AP，返回其组网身份（cap/sap），
   用于终端页显示「主路由 / 子路由」标识。 */
function device_ap_role(mn) {
	let self_mn = macnorm(state.self.mac);
	if (mn == self_mn) return state.cfg.role;
	let p = state.peers[mn];
	if (!p) return null;
	return p.info?.role ?? p.role ?? "sap";
}

function devices_tick_impl() {
	let now = time();
	let live = devices_live();
	for (let key, it in live) {
		let d = state.devices[key];
		if (!d) d = state.devices[key] = { first_seen: now };
		if (!d.first_seen) d.first_seen = now;
		d.online = true;
		d.last_online = now;   // 在线期间持续刷新：语义是「最后一次在线时间」
		d.mac = maccolon(it.mn);
		d.ip = it.c.ip ?? d.ip ?? null;
		d.hostname = it.c.hostname ?? d.hostname ?? null;
		d.ap = it.ap;
		d.conn = it.c.type ?? null;
		let role = device_ap_role(key);
		if (role == "cap" || role == "sap") d.device_role = role;
		state._dev_dirty = true;
	}
	for (let key, d in state.devices) {
		if (!live[key] && d.online) {
			d.online = false;
			d.last_offline = now;
			state._dev_dirty = true;
		}
	}

	/* 本机与已配对成员 AP 不一定出现在 FDB 客户端表里，
	   按组网关系补其在线状态与名称，避免终端页把子路由显示成离线。 */
	let self_mn = macnorm(state.self.mac);
	let ap_mns = [ self_mn ];
	for (let mn in state.peers)
		push(ap_mns, mn);

	for (let mn in ap_mns) {
		let d = state.devices[mn];
		if (!d) {
			d = state.devices[mn] = { first_seen: now };
			d.mac = maccolon(mn);
		}
		if (!d.first_seen) d.first_seen = now;
		d.online = true;
		d.last_online = now;
		d.hostname = ap_display(mn);
		let role = device_ap_role(mn);
		if (role == "cap" || role == "sap") d.device_role = role;
		state._dev_dirty = true;
	}

	devices_trim();
	devices_save(false);
	return live;
}

function devices_tick() {
	if (state.cfg.role == "unconfigured") return;
	try {
		devices_tick_impl();
	} catch (e) {
		log("devices tick failed: " + e);
	}
}

/* 设备页数据：历史记录 + 本轮在线信息合并，在线优先、最近在线靠前 */
function device_history_view() {
	let live = devices_tick_impl();
	let now = time();
	let self_mn = macnorm(state.self.mac);
	let out = [];
	for (let key, d in state.devices) {
		let it = live[key];
		let node = it ? client_node(it.mn, it.c, it.ap) : null;
		let al = state.aliases.map[key];
		let custom = (al?.name != null && al.name != "") ? al.name : null;
		let name = custom ?? node?.hostname ?? d.hostname ??
			node?.mac ?? d.mac ?? maccolon(macnorm(key));
		let ap = it?.ap ?? d.ap ?? null;
		let pin = pin_of(key);
		let liveRole = device_ap_role(key);   // 本机或在线成员 AP 才有值
		let role = liveRole ?? d.device_role ?? null;
		if (role != "cap" && role != "sap") role = null;
		let apOnline = !!liveRole;

		/* 子路由自身的连接 = 回程：有线显示端口，无线显示 SSID/信号，
		   与普通终端的连接信息保持一致 */
		let apConn = null;
		if (apOnline && role == "sap") {
			let up = (key == self_mn) ? detect_uplink()
				: (state.peers[key]?.info?.uplink ?? null);
			if (up) {
				if (up.type == "wireless")
					apConn = { type: "wifi", ssid: up.ssid ?? null,
					           band: up.band ?? null, rssi: up.rssi ?? null };
				else
					apConn = { type: "wired", port: up.port ?? null };
			}
		}

		push(out, {
			id: key,
			mac: node?.mac ?? d.mac ?? key,
			name, custom_name: custom,
			hostname: node?.hostname ?? d.hostname ?? null,
			ip: node?.ip ?? d.ip ?? null,
			online: !!it || apOnline,
			first_seen: d.first_seen ?? null,
			last_online: (it || apOnline) ? now : (d.last_online ?? null),
			last_offline: d.last_offline ?? null,
			ap, ap_name: ap ? ap_display(ap) : null,
			conn: (role == "sap" && apConn) ? apConn : (node?.conn ?? null),
			icon: al?.icon ?? null, note: al?.note ?? null,
			blocked: !!state.blocked[key],
			pin, pin_name: pin ? ap_name_of(pin) : null,
			device_role: role,
			can_wake: !it && !apOnline,
		});
	}
	sort(out, function(a, b) {
		if (a.online != b.online) return a.online ? -1 : 1;
		return (b.last_online ?? 0) - (a.last_online ?? 0);
	});

	/* 固定 AP 下拉框候选：本机 + 已知对端 */
	let aps = [ { id: self_mn, name: ap_name_of(self_mn) } ];
	for (let mn in keys(state.peers))
		push(aps, { id: mn, name: ap_name_of(mn) });
	sort(aps, function(a, b) {
		return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
	});

	return { now, role: state.cfg.role, devices: out, aps };
}

// ------------------------------------------------------------ wake on LAN
// 直接在本机发魔术包：6×0xFF + 16×目标 MAC，UDP 广播到 7/9 端口。
// 不依赖 etherwake/wakeonlan，SAP 与 CAP 都能用；广播域相同即可达。
function hex_bytes(s) {
	let out = "";
	for (let i = 0; i < length(s); i += 2) {
		let hi = index("0123456789abcdef", lc(substr(s, i, 1)));
		let lo = index("0123456789abcdef", lc(substr(s, i + 1, 1)));
		if (hi < 0 || lo < 0) return null;
		out += chr(hi * 16 + lo);
	}
	return out;
}

function wol_send(mn) {
	let raw = hex_bytes(mn);
	if (!raw || length(raw) != 6) return 0;
	let pkt = "";
	for (let i = 0; i < 6; i++) pkt += chr(255);
	for (let i = 0; i < 16; i++) pkt += raw;

	let sock = null;
	try {
		sock = socket.create(socket.AF_INET, socket.SOCK_DGRAM, 0);
		sock.setopt(socket.SOL_SOCKET, socket.SO_BROADCAST, true);
	} catch (e) {
		sock = null;
	}
	if (!sock) return 0;

	/* 关键：把发送接口锁定到 LAN 桥。否则 255.255.255.255 可能按默认路由
	   从 WAN 发出，魔术包永远到不了睡眠终端所在的局域网。 */
	let dev = state.brdev ?? "";
	if (dev != "") {
		try { sock.setopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, dev); }
		catch (e) { /* 旧版 ucode 没有该选项时仍走网段广播 */ }
	}

	/* 优先网段广播，再补全局广播；部分设备/交换机只认其中一种 */
	let targets = [];
	if (state.bcast && state.bcast != "255.255.255.255") {
		push(targets, { address: state.bcast, port: 9 });
		push(targets, { address: state.bcast, port: 7 });
	}
	push(targets, { address: "255.255.255.255", port: 9 });
	push(targets, { address: "255.255.255.255", port: 7 });

	/* 邻居/租约还在时再发一次单播，兼容不转发广播的交换机 */
	let ip = parse_leases()[mn]?.ip ?? parse_neigh()[mn]?.ip ?? null;
	if (ip) push(targets, { address: ip, port: 9 });

	let sent = 0;
	/* 魔术包本身无确认，连发 3 轮降低 UDP 丢包导致的唤醒失败 */
	for (let round = 0; round < 3; round++)
		for (let t in targets) {
			try { sock.send(pkt, 0, t); sent++; }
			catch (e) { /* 单个目标失败不影响其它目标 */ }
		}
	try { sock.close(); } catch (e) {}
	return sent;
}

/* 唤醒入口：立即发一轮，再在 0.4s / 1.2s 各补发一轮。
   部分网卡/交换机对单次广播不敏感，间隔重发可以显著提高成功率。 */
function wol_wake(mn) {
	let sent = wol_send(mn);
	if (!sent) return 0;
	uloop.timer(400, function() { wol_send(mn); });
	uloop.timer(1200, function() { wol_send(mn); });
	return sent;
}

// ---------------------------------------------------------- pin enforcement
/* 固定 AP 的本机执行：连到非目标 AP 的终端直接断开并禁入一段时间。
   每台 AP 各自纠正直连终端，CAP 不需要跨设备下发。 */
function pin_tick() {
	if (state.cfg.role == "unconfigured") return;
	let cfg = devices_cfg();
	if (!cfg.pin_enforce) return;
	let pin = state.aliases.pin;
	if (!pin || !length(keys(pin))) return;
	let self_mn = macnorm(state.self.mac);
	let now = time();
	let clients = wifi_clients();
	for (let mn, c in clients) {
		if (c.type != "wifi" || !c.ifname) continue;
		let ap = pin_of(mn);
		if (!ap || ap == self_mn) continue;
		/* 目标 AP 已离线/退网时不再纠正，避免终端被反复踢下线
		   （SAP 侧其它成员 AP 只有 UDP 心跳，不一定有 TCP authed） */
		if (!state.peers[ap]) continue;
		if (now - (state.pin_last[mn] ?? 0) < PIN_KICK_COOLDOWN) continue;
		try {
			ubusc.call("hostapd." + c.ifname, "del_client", {
				addr: maccolon(mn), deauth: true, reason: 1,
				ban_time: cfg.ban * 1000,
			});
			state.pin_last[mn] = now;
			push_event("pin_kick", maccolon(mn),
				sprintf("%s → %s", ap_display(self_mn), ap_display(ap)),
				client_name_of(mn, clients));
		} catch (e) {
			log("pin kick " + mn + " failed");
		}
	}
}

// --------------------------------------------------------- roam configurator
function roam_md(ssid) { return substr(sha256("md:" + ssid), 0, 4); }
function roam_key0(mac) { return substr(sha256(state.cfg.token + ":r0:" + macnorm(mac)), 0, 32); }
function roam_key1(mac) { return substr(sha256(state.cfg.token + ":r1:" + macnorm(mac)), 0, 32); }

function member_list() {
	let members = [ { mac: state.self.mac, name: state.self.name } ];
	for (let mn, p in state.peers)
		if (p.authed)
			push(members, { mac: p.mac ?? maccolon(mn),
			                name: p.info?.name ?? p.name ?? mn });
	return members;
}

write_roam_iface = function(cur, s, roam, members, selected) {
	let sid = s[".name"];
	if (!selected) {
		if (s.ieee80211r != null || s.ieee80211k != null || s.ieee80211v != null)
			for (let k in ROAM_KEYS) cur.delete("wireless", sid, k);
		return;
	}

	if (roam.r_fast) {
		let md = roam_md(s.ssid);
		cur.set("wireless", sid, "ieee80211r", "1");
		cur.set("wireless", sid, "mobility_domain", md);
		cur.set("wireless", sid, "ft_over_ds", roam.ft_over_ds ? "1" : "0");
		cur.set("wireless", sid, "reassociation_deadline", "1000");
		if (roam.ft_mode == "explicit") {
			cur.set("wireless", sid, "ft_psk_generate_local", "0");
			cur.set("wireless", sid, "nas_identifier", uc(macnorm(state.self.mac)) + "-" + s.ssid);
			cur.set("wireless", sid, "pmk_r1_push", "1");
			let r0 = [], r1 = [];
			for (let m in members) {
				let mm = m.mac;
				push(r0, sprintf("%s,%s-%s,%s", mm, uc(macnorm(mm)), s.ssid, roam_key0(mm)));
				push(r1, sprintf("%s,%s,%s", mm, mm, roam_key1(mm)));
			}
			cur.set("wireless", sid, "r0kh", r0);
			cur.set("wireless", sid, "r1kh", r1);
		} else {
			cur.set("wireless", sid, "ft_psk_generate_local", "1");
			for (let k in [ "nas_identifier", "pmk_r1_push", "r0kh", "r1kh" ])
				cur.delete("wireless", sid, k);
		}
	} else {
		for (let k in ROAM_FT_KEYS) cur.delete("wireless", sid, k);
	}
	cur.set("wireless", sid, "ieee80211k", "1");
	cur.set("wireless", sid, "rrm_neighbor_report", roam.k_neighbor ? "1" : "0");
	cur.set("wireless", sid, "rrm_beacon_report", roam.k_beacon ? "1" : "0");
	cur.set("wireless", sid, "ieee80211v", "1");
	cur.set("wireless", sid, "bss_transition", roam.v_bss_transition ? "1" : "0");
};

function apply_roam_local(roam, members) {
	let cur = uci.cursor();
	cur.load("wireless");
	let touched = [];
	cur.foreach("wireless", "wifi-iface", function(s) {
		if (s.mode && s.mode != "ap") return;
		/* 访客网络不再参与漫游：清理旧版本可能写入的 k/v/r 配置 */
		if (s.wifiroam_guest == "1") {
			write_roam_iface(cur, s, roam, members, false);
			return;
		}
		let selected = roam.enabled && index(roam.ssids ?? [], s.ssid) >= 0;
		write_roam_iface(cur, s, roam, members, selected);
		if (selected) push(touched, s.ssid);
	});

	cur.commit("wireless");
	state.roam_ver_applied = roam.config_ver ?? state.roam_ver_applied;
	// 整份漫游配置落盘：SAP 的设置页读取本地 uci，只写 ver/enabled 会让
	// 子 AP 显示与主 AP 不一致（SSID 组、FT 模式、k/v 开关等仍是默认值）
	let wc = uci.cursor();
	wc.load("wifiroam");
	let dirty = false;
	let want_ssids = roam.ssids ?? [];
	if (type(want_ssids) != "array") want_ssids = want_ssids == "" ? [] : [ want_ssids ];
	let cur_ssids = wc.get("wifiroam", "roam", "ssids") ?? [];
	if (type(cur_ssids) != "array") cur_ssids = cur_ssids == "" ? [] : [ cur_ssids ];
	let want = {
		enabled: roam.enabled ? "1" : "0",
		r_fast: roam.r_fast ? "1" : "0",
		ft_mode: roam.ft_mode == "explicit" ? "explicit" : "simple",
		ft_over_ds: roam.ft_over_ds ? "1" : "0",
		k_neighbor: roam.k_neighbor ? "1" : "0",
		k_beacon: roam.k_beacon ? "1" : "0",
		v_bss_transition: roam.v_bss_transition ? "1" : "0",
		rssi_profile: roam.rssi_profile ?? "balanced",
		rssi_threshold: "" + (roam.rssi_threshold ?? rssi_preset(roam.rssi_profile)),
		config_ver: "" + state.roam_ver_applied,
	};
	/* 旧版 CAP 会下发 guest_selected；保留该值仅用于 roam_sig 兼容，
	   新版本不再据此启用访客漫游 */
	if (roam.guest_selected != null)
		want.guest_selected = roam.guest_selected ? "1" : "0";
	if (join("\n", cur_ssids) != join("\n", want_ssids)) {
		if (length(want_ssids)) wc.set("wifiroam", "roam", "ssids", want_ssids);
		else wc.delete("wifiroam", "roam", "ssids");
		dirty = true;
	}
	for (let k, v in want) {
		if ((wc.get("wifiroam", "roam", k) ?? "") != v) {
			wc.set("wifiroam", "roam", k, v);
			dirty = true;
		}
	}
	if (dirty) wc.commit("wifiroam");
	/* 延迟重启无线：先让 ubus 响应和向成员 AP 的配置推送发出去，
	   否则首次保存时管理连接会先被 wifi reload 打断，页面误以为服务停止 */
	state._own_nr = {};
	state._bss_cache = null;
	uloop.timer(1000, function() {
		uloop.process("/sbin/wifi", [ "reload" ], null, function(res) {
			log("wifi reload rc=" + res);
			guest_tc_apply(guest_cfg());
			/* hostapd 重启后邻居库是空的，稍后重新下发 11k 邻居 */
			uloop.timer(5000, rrm_sync_tick);
		});
	});
	push_event("roam_apply", "",
		sprintf("ver=%d ssids=%d", roam.config_ver ?? 0, length(touched)));
	return { ok: true, touched, ver: state.roam_ver_applied };
}

// 本机实际落盘的 K/V/R：随 push_roam_config 回执上报，主AP可显示各 AP 生效状态
function applied_kvr(roam) {
	let main = { seen: 0, r: true, k: true, v: true };
	let cur = uci.cursor();
	cur.load("wireless");
	cur.foreach("wireless", "wifi-iface", function(s) {
		if ((s.mode && s.mode != "ap") || s.disabled == "1") return;
		if (s.wifiroam_guest == "1") return;   // 访客网络不参与漫游
		if (index(roam.ssids ?? [], s.ssid) < 0) return;
		main.seen++;
		if (s.ieee80211r != "1" || (s.mobility_domain ?? "") == "") main.r = false;
		if (s.ieee80211k != "1" || (s.rrm_neighbor_report ?? "0") != "1") main.k = false;
		if (s.ieee80211v != "1" || (s.bss_transition ?? "0") != "1") main.v = false;
	});
	if (!main.seen) main.r = main.k = main.v = false;
	return main;
}

// ----------------------------------------------------- wireless backhaul
function wifi_radios() {
	let out = [];
	let cur = uci.cursor();
	cur.load("wireless");
	cur.foreach("wireless", "wifi-device", function(s) {
		push(out, {
			name: s[".name"], band: s.band ?? "?",
			disabled: s.disabled == "1",
		});
	});
	return out;
}

function pick_radio(prefer) {
	let radios = wifi_radios();
	for (let r in radios)
		if (!r.disabled && r.name == prefer) return r.name;
	for (let r in radios)
		if (!r.disabled && r.band == "5g") return r.name;
	for (let r in radios)
		if (!r.disabled) return r.name;
	return null;
}

// 上级 AP 的 MAC 若出现在以太网口上，说明当前仍有有线回程。
// 此时不能把 STA 桥进 br-lan，否则会形成二层环路；只暂存配置待拔线后自动启用。
function ethernet_uplink_port() {
	let fdb = parse_fdb();
	for (let mn, p in state.peers) {
		let role = p.info?.role ?? p.role;
		if (role != "cap") continue;
		let port = fdb[mn];
		if (port && index(port, "phy") != 0 && index(port, "wl") != 0 &&
		    index(port, "vap") != 0 && index(port, "br") != 0)
			return port;
	}
	return null;
}

function apply_backhaul_local(bh, role) {
	let cur = uci.cursor();
	cur.load("wireless");
	let exists = cur.get("wireless", BACKHAUL_SECTION) != null;
	/* enabled 但 SSID/密钥缺失时不能静默删除现有 STA 并回 ok，
	   否则上层会显示“已应用”，实际却没有任何无线回程接口 */
	if (bh.enabled && ((bh.ssid ?? "") == "" || (bh.key ?? "") == ""))
		return { ok: false, error: "backhaul_credentials" };

	if (bh.enabled) {
		let dev = pick_radio(role == "cap" ? (bh.device ?? "") : "");
		if (!dev) return { ok: false, error: "no_radio" };
		/* CAP 侧强制重建回程 AP：旧接口可能因 netifd/NSS 未真正创建
		   或未挂进 br-lan，只改选项再 reload 不会重新建接口 */
		if (role == "cap" && exists)
			cur.delete("wireless", BACKHAUL_SECTION);
		/* 命名段必须先声明 uci 类型为 wifi-iface，否则 wifi reload
		   会忽略这段，STA/AP 都不会真正创建 */
		let sd = cur.get_all("wireless", BACKHAUL_SECTION);
		if (sd == null || sd[".type"] != "wifi-iface") {
			if (sd != null) cur.delete("wireless", BACKHAUL_SECTION);
			cur.set("wireless", BACKHAUL_SECTION, "wifi-iface");
		}
		cur.set("wireless", BACKHAUL_SECTION, "device", dev);
		cur.set("wireless", BACKHAUL_SECTION, "mode", role == "cap" ? "ap" : "sta");
		cur.set("wireless", BACKHAUL_SECTION, "ssid", bh.ssid);
		cur.set("wireless", BACKHAUL_SECTION, "encryption", "psk2+ccmp");
		cur.set("wireless", BACKHAUL_SECTION, "key", bh.key);
		cur.set("wireless", BACKHAUL_SECTION, "network", "lan");
		cur.set("wireless", BACKHAUL_SECTION, "wds", "1");
		if (role == "cap") {
			cur.set("wireless", BACKHAUL_SECTION, "hidden", "1");
			cur.set("wireless", BACKHAUL_SECTION, "disabled", "0");
		} else {
			cur.delete("wireless", BACKHAUL_SECTION, "hidden");
			cur.set("wireless", BACKHAUL_SECTION, "disabled",
				ethernet_uplink_port() ? "1" : "0");
		}
	} else if (exists) {
		cur.delete("wireless", BACKHAUL_SECTION);
	}
	if (!cur.commit("wireless"))
		log("backhaul wireless commit failed");
	let chk = uci.cursor();
	chk.load("wireless");
	if (chk.get("wireless", BACKHAUL_SECTION) == null)
		log("backhaul wireless section missing after commit");

	let ver = bh.config_ver ?? 0;
	let wc = uci.cursor();
	wc.load("wifiroam");
	wc.set("wifiroam", "backhaul", "enabled", bh.enabled ? "1" : "0");
	wc.set("wifiroam", "backhaul", "ssid", bh.ssid ?? BACKHAUL_DEFAULT_SSID);
	wc.set("wifiroam", "backhaul", "key", bh.key ?? "");
	wc.set("wifiroam", "backhaul", "device", bh.device ?? "");
	wc.set("wifiroam", "backhaul", "config_ver", "" + ver);
	wc.commit("wifiroam");
	state.backhaul_ver_applied = ver;
	if (role == "cap" && bh.enabled)
		backhaul_stp_ensure();

	uloop.process("/sbin/wifi", [ "reload" ], null,
		function(res) { log("backhaul wifi reload rc=" + res); });
	/* 8s 后检查 netifd 是否真的建出接口，定位“配置存在但 br-lan
	   里没有回程接口”的情况 */
	uloop.timer(8000, function() {
		let ws = ubusc.call("network.wireless", "status") ?? {};
		let hit = null;
		for (let rname, r in ws)
			for (let ifc in r.interfaces ?? [])
				if (ifc.section == BACKHAUL_SECTION) hit = ifc;
		if (hit == null)
			log("backhaul iface missing from wireless status");
		else
			log(sprintf("backhaul iface: ifname=%s up=%s mode=%s",
				hit.ifname ?? "?", hit.up ? "1" : "0",
				hit.config?.mode ?? "?"));
	});
	push_event("backhaul_apply", "",
		sprintf("ver=%d %s", ver, bh.enabled ? "wireless" : "off"));
	return { ok: true, ver };
}

// 回程启用期间给 LAN 网桥打开 STP，作为有线/无线同时存在时的兜底。
// 运行时用 brctl 立即生效，uci 只写一次 stp=1 供重启后保留。
backhaul_stp_ensure = function() {
	if (state._bh_stp_done) return;
	state._bh_stp_done = true;
	cmd_output("brctl stp " + state.brdev + " on 2>/dev/null");
	let nc = uci.cursor();
	nc.load("network");
	let hit = false;
	nc.foreach("network", "device", function(s) {
		if ((s.name ?? "") != state.brdev) return;
		nc.set("network", s[".name"], "stp", "1");
		hit = true;
	});
	if (!hit) {
		nc.foreach("network", "interface", function(s) {
			if (hit) return;
			if (s[".name"] == "lan" &&
			    ((s.device ?? "") == state.brdev || s.type == "bridge")) {
				nc.set("network", s[".name"], "stp", "1");
				hit = true;
			}
		});
	}
	if (hit) nc.commit("network");
};

/* 回程 STA 的 netdev MAC：用于不依赖主路由 MAC 的环路检测 */
function backhaul_sta_mac() {
	let ws = ubusc.call("network.wireless", "status") ?? {};
	for (let rname, r in ws)
		for (let ifc in r.interfaces ?? [])
			if (ifc.section == BACKHAUL_SECTION && ifc.ifname) {
				let mac = trim(fs.readfile(
					`/sys/class/net/${ifc.ifname}/address`) ?? "");
				return macnorm(mac);
			}
	return "";
}

/* STA 自己的 MAC 若出现在有线端口的 FDB 上，说明有线/无线已形成环路 */
function backhaul_loop_port() {
	let mac = backhaul_sta_mac();
	if (length(mac) != 12) return null;
	let port = parse_fdb()[mac];
	if (port && index(port, "phy") != 0 && index(port, "wl") != 0 &&
	    index(port, "vap") != 0 && index(port, "br") != 0)
		return port;
	return null;
}

// SAP 侧：有线/无线回程互斥。网线在位时 STA 保持 disabled，拔线后自动启用；
// 重新插回网线则暂停 STA，避免二层环路。
function backhaul_tick() {
	if (state.cfg.role != "sap") return;
	let bh = current_backhaul_cfg();
	if (!bh.enabled) return;
	if ((bh.ssid ?? "") == "" || (bh.key ?? "") == "") return;
	let cur = uci.cursor();
	cur.load("wireless");
	let sec = cur.get("wireless", BACKHAUL_SECTION);
	let sdata = cur.get_all("wireless", BACKHAUL_SECTION);
	let wtype = sdata != null ? sdata[".type"] : null;
	let wmode = cur.get("wireless", BACKHAUL_SECTION, "mode");
	let wssid = cur.get("wireless", BACKHAUL_SECTION, "ssid") ?? "";
	let wkey = cur.get("wireless", BACKHAUL_SECTION, "key") ?? "";
	/* 回程已启用但 STA 段丢失/被改坏时自动重建，否则拔掉网线后
	   没有可启用的无线回程接口，表现就是一直不走无线 */
	if (sec == null || wtype != "wifi-iface" || wmode != "sta" ||
	    wssid != bh.ssid || wkey != bh.key) {
		/* 重建会重载无线，最多 60s 一次，避免配置异常时每 10s 打断 Wi-Fi */
		if (time() - (state._bh_rebuild_ts ?? 0) < 60) return;
		state._bh_rebuild_ts = time();
		log(sprintf("backhaul STA stale: sec=%s type=%s mode=%s ssid=%s/%s keylen=%d/%d ver=%d",
			sec ?? "null", wtype ?? "null", wmode ?? "null", wssid, bh.ssid,
			length(wkey), length(bh.key ?? ""), bh.config_ver ?? 0));
		apply_backhaul_local(bh, "sap");
		return;
	}
	backhaul_stp_ensure();
	/* 插回网线时主路由 MAC 可能仍只学到无线 STA 口，FDB 判据会漏检；
	   若 STA 自己的 MAC 出现在有线口，说明两条路径都通，立即暂停 STA */
	let disabled = (cur.get("wireless", BACKHAUL_SECTION, "disabled") ?? "0") == "1";
	if (!disabled) {
		let lp = backhaul_loop_port();
		if (lp != null) {
			log("backhaul loop detected on " + lp + ", pausing wireless STA");
			cur.set("wireless", BACKHAUL_SECTION, "disabled", "1");
			cur.commit("wireless");
			push_event("backhaul_link", "", "loop detected, wireless STA paused");
			uloop.process("/sbin/wifi", [ "reload" ], null,
				function(res) { log("backhaul switch rc=" + res); });
			return;
		}
	}
	let want = ethernet_uplink_port() ? "1" : "0";
	if ((cur.get("wireless", BACKHAUL_SECTION, "disabled") ?? "0") == want) return;
	cur.set("wireless", BACKHAUL_SECTION, "disabled", want);
	cur.commit("wireless");
	push_event("backhaul_link", "",
		want == "1" ? "wired uplink detected, wireless STA paused"
		            : "cable removed, wireless backhaul enabled");
	uloop.process("/sbin/wifi", [ "reload" ], null,
		function(res) { log("backhaul switch rc=" + res); });
}

// --------------------------------------------------------------- prechecks
function ssid_groups() {
	let groups = {};
	let self_mn = macnorm(state.self.mac);
	for (let w in wifi_ifaces()) {
		let g = groups[w.ssid] ??= { ssid: w.ssid, aps: {}, encs: {}, bands: {} };
		g.aps[self_mn] = true;
		g.encs[self_mn] = w.encryption;
		g.bands[w.band] = true;
	}
	for (let mn, p in state.peers) {
		for (let w in p.info?.wifi ?? []) {
			let g = groups[w.ssid] ??= { ssid: w.ssid, aps: {}, encs: {}, bands: {} };
			g.aps[mn] = true;
			g.encs[mn] = w.encryption;
			g.bands[w.band] = true;
		}
	}
	let out = [];
	for (let ssid, g in groups) {
		let encset = {};
		for (let mn, e in g.encs) encset[e] = true;
		let enc_list = keys(encset);
		let enc_ok = true;
		for (let e in enc_list)
			if (index(e, "psk") < 0 && index(e, "sae") < 0) enc_ok = false;
		push(out, {
			ssid, ap_count: length(keys(g.aps)),
			bands: keys(g.bands), encryptions: enc_list,
			consistent: length(enc_list) == 1,
			enc_ok,
		});
	}
	return out;
}

// 全网络 AP 概览：CAP 汇总后下发给 SAP，子 AP 的“开启前检查”与主 AP 保持一致
function ap_overview() {
	let self_mn = macnorm(state.self.mac);
	let aps = [ {
		id: self_mn, name: state.self.name, role: state.cfg.role,
		ip: state.self.ip, online: true, self: true,
		ssids: map(wifi_ifaces(), function(w) { return w.ssid; }),
		// 本机实际落盘的 K/V/R，便于主 AP 与子 AP 看到一致的生效状态
		kvr: applied_kvr(current_roam_cfg()),
	} ];
	for (let mn, p in state.peers) {
		let list = [];
		for (let w in p.info?.wifi ?? [])
			if (index(list, w.ssid) < 0) push(list, w.ssid);
		push(aps, {
			id: mn, name: p.info?.name ?? p.name ?? maccolon(mn),
			role: p.info?.role ?? p.role ?? "sap",
			ip: p.info?.ip ?? p.ip, online: !!p.authed, self: false,
			ssids: list,
			kvr: p.kvr ?? null,
		});
	}
	return { groups: ssid_groups(), aps };
}

function precheck() {
	let checks = [];

	// apk (24.10+) / opkg (legacy) 双栈检测
	let wp = "";
	if (fs.access("/usr/bin/apk") || fs.access("/sbin/apk"))
		wp = trim(cmd_output("apk list --installed 2>/dev/null | awk '{print $1}' | grep -E '^wpad' | head -1"));
	if (wp == "")
		wp = trim(cmd_output("opkg list-installed 2>/dev/null | grep -E '^wpad' | head -1"));
	push(checks, { id: "wpad", ok: wp != "" && index(wp, "basic") < 0,
		info: wp != "" ? wp : "none" });

	// SAP 用 CAP 下发的全网络概览，避免子 AP 只看到本机接口导致计数/状态不一致
	let overview = (state.cfg.role == "sap" && state.roster?.aps) ? state.roster
	                                                               : ap_overview();
	let groups = overview.groups;
	let n_multi = 0;
	for (let g in groups) if (g.ap_count >= 2) n_multi++;
	push(checks, { id: "ssid_group", ok: n_multi > 0,
		info: sprintf("%d", n_multi) });

	for (let g in groups) {
		push(checks, { id: "enc_consistent", ok: g.consistent,
			info: sprintf("%s: %s", g.ssid, join(",", g.encryptions)) });
		push(checks, { id: "enc_allowed", ok: g.enc_ok,
			info: sprintf("%s: %s", g.ssid, join(",", g.encryptions)) });
	}
	push(checks, { id: "role", ok: state.cfg.role == "cap", info: state.cfg.role });

	// 成员 AP 概览：让"开启前检查"能直接看出子路由上报的 SSID/频段是否正确，
	// 而不是只显示一个汇总计数
	// self 标记必须按本机 MAC 重新计算：CAP 下发的 roster 里 "self" 指 CAP 自己
	let self_mn = macnorm(state.self.mac);
	let aps = [];
	for (let a in overview.aps) {
		push(aps, {
			id: a.id, name: a.name, role: a.role, ip: a.ip,
			online: a.online, self: a.id == self_mn, ssids: a.ssids,
			kvr: a.kvr ?? null,
		});
	}
	return { checks, groups, role: state.cfg.role, aps };
}

// ------------------------------------------------------- SAP -> CAP uplink
function sap_rx(req) {
	let link = state.link;
	if (!link || !link.chan) return 0;

	if (!link.authed) {
		if (req.type == "hello") {
			let cm = macnorm(req.args?.mac ?? "");
			if (cm != "") {
				link.cap_mac = cm;
				/* 持久化主 AP MAC：重启/换 IP 后仍能识别它是否被重置。
				   注意不要在这里清 cap_lost_since：未配置的 CAP 仍会回
				   TCP hello，清掉会让 15s 计时永远走不完；由 UDP 的正常
				   hello（thash 匹配）来清。 */
				if (state.cfg.cap_mac != cm) {
					state.cfg.cap_mac = cm;
					save_config();
				}
			}
			let digest = sha256(state.cfg.token + ":" + (req.args?.nonce ?? ""));
			link.chan.defer({
				method: "auth",
				data: {
					mac: state.self.mac, role: state.cfg.role,
					name: state.self.name, digest,
					alias_ver: state.aliases.ver,
					roam_ver: state.roam_ver_applied,
					roam_sig: roam_sig(current_roam_cfg()),
					// 兼容旧 CAP：告知其本端曾支持访客漫游签名格式
					guest_roaming: true,
					backhaul_ver: state.backhaul_ver_applied,
					guest_ver: state.guest_ver_applied,
					wifi_sig: wifi_sig_local(),
				},
				data_cb: function(m) {
					if (m?.ok) {
						link.authed = true;
						link.last_pong = time();
						state.net_names = m.names ?? {};
						if (m?.roster) state.roster = m.roster;
						if (m?.devices) devices_cfg_apply(m.devices);
						// 让 SAP 侧 status/peers_online 反映 CAP 在线
						if (link.cap_mac) {
							let cp = state.peers[link.cap_mac] ??= { clients: {} };
							cp.authed = true;
						}
						push_event("cap_connected", "", state.cfg.cap_ip);
						log("link to CAP established");
						sap_report();
					} else {
						log("CAP auth rejected");
						/* 不能在 channel 回调里直接 disconnect 自身（可能
						   use-after-free 崩溃）；交给下一轮 uloop 处理 */
						uloop.timer(100, function() {
							if (state.link == link) sap_disconnect();
						});
					}
				},
				// cb 为 complete 回调（成功也触发），仅 rc != 0 表示失败/超时
				cb: function(rc) {
					if (rc != 0 && state.link == link) {
						log("CAP auth request failed");
						uloop.timer(100, function() {
							if (state.link == link) sap_disconnect();
						});
					}
				},
			});
		}
		return 0;
	}

	switch (req.type) {
	case "push_roam_config": {
		let r = apply_roam_local(req.args.roam, req.args.members ?? []);
		req.reply({ ok: r.ok, ver: r.ver,
		            kvr: applied_kvr(req.args.roam) });
		break;
	}
	case "push_aliases": {
		let a = req.args.aliases;
		if (a && (a.ver ?? 0) > state.aliases.ver) {
			state.aliases = a;
			alias_save();
		}
		req.reply({ ok: true, ver: state.aliases.ver });
		break;
	}
	case "block_sync": {
		/* CAP 同步暂停联网列表：只更新展示状态，实际丢包在主 AP 执行 */
		let b = req.args.blocked;
		if (type(b) == "object") {
			state.blocked = {};
			for (let mn, v in b)
				if (v && length(mn) == 12) state.blocked[mn] = true;
			acl_save();
		}
		req.reply({ ok: true });
		break;
	}
	case "devices_config": {
		/* CAP 同步终端管理设置：历史上限 / 固定 AP 纠正 / 禁入时长 */
		if (state.cfg.role == "sap")
			devices_cfg_apply(args.devices ?? {});
		req.reply({ ok: true });
		break;
	}
	case "push_backhaul_config": {
		let r = apply_backhaul_local(req.args.backhaul ?? {}, "sap");
		req.reply({ ok: r.ok, ver: r.ver, error: r.error });
		break;
	}
	case "push_wifi_config": {
		// CAP 下发的前台 SSID/密码：SAP 按频段改写本地 wireless 并重启无线
		let ssids = [];
		let bad = false;
		for (let it in (req.args.ssids ?? [])) {
			let ssid = trim(it.ssid ?? "");
			let key = it.key ?? "";
			if (length(ssid) < 1 || length(ssid) > 32) bad = true;
			if (key != "" && (length(key) < 8 || length(key) > 64)) bad = true;
			push(ssids, { band: it.band ?? "?", ssid: ssid, key: key,
			              open: it.open ? true : false });
		}
		let r = { ok: false, error: "ssid_invalid" };
		if (!bad && length(ssids) > 0) {
			let pairs = [];
			for (let it in wifi_summary().ifaces) {
				for (let s in ssids)
					if (s.band == it.band) push(pairs, { old: it.ssid, new: s.ssid });
			}
			roam_rename_ssids(pairs);
			r = apply_wifi_local(ssids);
		}
		req.reply({ ok: r.ok, error: r.error });
		break;
	}
	case "push_guest_config": {
		// CAP 下发的访客网络配置：SAP 本地落盘并重建访客子网
		let g = req.args.guest ?? {};
		if (!guest_save_local(g)) {
			req.reply({ ok: false, error: "invalid" });
			break;
		}
		/* 等 network/wifi 真正 reload 完再回执，避免 CAP 把「已接受」当成已生效 */
		req.reply({ ok: true, pending: true });
		try {
			apply_guest_local(guest_cfg(), function(r) {
				if (!r.ok)
					log("guest apply failed: " + (r.error ?? "unknown"));
			});
		} catch (e) {
			log("guest apply failed: " + e);
		}
		break;
	}
	case "push_offload": {
		// CAP 广播下来的 flow offload 开关：SAP 本地落盘并重建自己的 flowtable
		let on = req.args.enabled ? true : false;
		state.cap_offload = on;
		req.reply({ ok: offload_apply(on), enabled: on });
		break;
	}
	case "get_client_detail": {
		let mn = macnorm(req.args.mac);
		let c = local_clients_cached()[mn];
		if (c)
			req.reply({ ok: true, client: client_node(mn, c, macnorm(state.self.mac)) });
		else
			req.reply({ ok: false });
		break;
	}
	case "get_topology":
		req.reply(build_topology());
		break;
	case "leave":
		req.reply({ ok: true });
		push_event("unpaired", "", "");
		uloop.timer(300, function() {
			apply_roam_local({ enabled: false, ssids: [], config_ver: 0 }, []);
			state.cfg.role = "unconfigured";
			state.cfg.token = "";
			state.cfg.cap_ip = "";
			state.cfg.cap_mac = "";
			state.cap_lost_since = null;
			state.cap_learned = null;
			state.last_apply = null;
			state.last_backhaul = null;
			save_config();
			reconfigure();
		});
		break;
	}
	return 0;
}

sap_disconnect = function() {
	let link = state.link;
	if (!link) return;
	log("link to CAP closed");
	try { link.chan.disconnect(); } catch (e) {}
	try { link.sock.close(); } catch (e) {}
	if (link.cap_mac && state.peers[link.cap_mac])
		state.peers[link.cap_mac].authed = false;
	state.link = null;
	/* CAP 断链后旧 BSS 列表已不可信：清掉并让 hostapd 尽快移除旧邻居 */
	state.bss_list = null;
	state._bss_cache = null;
	state._bss_sig = "";
	state.net_names = {};
	state.roster = null;
	uloop.timer(1000, rrm_sync_tick);
};

// SAP 发现已配对的主 AP 丢失配置/换了网络令牌：自动回到未配置，
// 否则会一直以「子路由」身份重连旧 token，主 AP 也无法在发现列表里看到它。
sap_self_reset = function(reason) {
	if (state.cfg.role != "sap") return;
	log("CAP " + reason + ", resetting to unconfigured");
	push_event("unpaired", "", reason);
	apply_roam_local({ enabled: false, ssids: [], config_ver: 0 }, []);
	state.cfg.role = "unconfigured";
	state.cfg.token = "";
	state.cfg.cap_ip = "";
	state.cfg.cap_mac = "";
	state.cap_lost_since = null;
	state.cap_learned = null;
	state.last_apply = null;
	state.last_backhaul = null;
	save_config();
	reconfigure();
};

function sap_connect(cap_ip) {
	sap_disconnect();
	let addr = socket.sockaddr({ address: cap_ip, port: TCP_PORT });
	if (!addr) return;
	let sock = socket.create(socket.AF_INET,
		socket.SOCK_STREAM | socket.SOCK_NONBLOCK, 0);
	if (!sock) return;
	sock.connect(addr); // nonblocking: completes via channel machinery
	let link = { sock, authed: false, ts: time(), last_pong: time() };
	link.chan = libubus.open_channel(sock, sap_rx, function() {
		/* 通道已由 libubus 关闭：先清句柄，只做状态清理 */
		link.chan = null;
		link.sock = null;
		if (state.link == link) sap_disconnect();
	});
	state.link = link;
	log(sprintf("connecting to CAP %s", cap_ip));
}

function sap_tick() {
	if (state.cfg.role != "sap") return;
	if (state.link?.authed) {
		// 心跳看门狗：ucode 通道可能感知不到对端死亡（CLOSE_WAIT 半开），
		// 以 report_status 回执刷新 last_pong，超时主动断开重连
		if (time() - (state.link.last_pong ?? state.link.ts) > 45) {
			log("CAP link timeout, reconnecting");
			sap_disconnect();
		} else {
			return;
		}
	}
	let cap = state.cfg.cap_ip != "" ? state.cfg.cap_ip : state.cap_learned;
	if (cap) sap_connect(cap);
}

sap_report = function() {
	if (state.cfg.role != "sap" || !state.link?.authed) return;
	let clients = local_clients_cached();
	if (state.prev_clients != null)
		diff_events(state.prev_clients, clients, state.self.name);
	state.prev_clients = clients;
	let link = state.link;
	try {
		link.chan.defer({
			method: "report_status",
			data: {
				info: self_info(),
				clients,
				alias_ver: state.aliases.ver,
				roam_ver: state.roam_ver_applied,
				roam_sig: roam_sig(current_roam_cfg()),
				// 兼容旧 CAP 的签名判断
				guest_roaming: true,
				backhaul_ver: state.backhaul_ver_applied,
				guest_ver: state.guest_ver_applied,
				wifi_sig: wifi_sig_local(),
				// 本机落盘的 K/V/R 生效状态，CAP 汇总后展示给用户
				kvr: applied_kvr(current_roam_cfg()),
			},
			data_cb: function(m) {
				link.last_pong = time();
				if (m?.names) state.net_names = m.names;
				if (m?.roster) state.roster = m.roster;
				if (m?.devices) devices_cfg_apply(m.devices);
				if (m?.usage) state.cap_usage = m.usage;
				/* CAP 汇总的最近应用结果同步到本机，供 SAP 页面展示 */
				state.last_apply = m?.last_apply ?? null;
				state.last_backhaul = m?.last_backhaul ?? null;
				if (m?.bss) {
					/* 只有 BSS 列表真正变化时才触发一次立即同步，
					   避免每 10s 的上报都重建 hostapd 邻居库 */
					let parts = [];
					for (let b in m.bss)
						push(parts, sprintf("%s|%s|%s|%s",
							b.bssid ?? "", b.ssid ?? "",
							b.channel ?? "", b.nr ?? ""));
					let sig = sha256(join("\n", parts));
					let changed = (sig != state._bss_sig);

					state.bss_list = m.bss;
					state._bss_sig = sig;
					state._bss_cache = null;
					if (changed) uloop.timer(1000, rrm_sync_tick);
				}
			},
			cb: function(rc) {
				// complete 回调：rc == 0 为成功，仅失败/超时才断开重连
				if (rc != 0) {
					log("CAP link report failed");
					if (state.link == link) sap_disconnect();
				}
			},
		});
	} catch (e) {
		log("CAP link report error");
		if (state.link == link) sap_disconnect();
	}
};

// 最近应用结果：把新接入/需要补发的 SAP 加入结果表并标记 pending。
// CAP 首次组网时 last_apply 只有本机，新 SAP 入网后补进来，页面才能看到完整结果。
function last_result_mark_pending(results, mn, name, with_kvr) {
	if (!results) return false;
	for (let r in results) {
		if (macnorm(r.ap) != mn) continue;
		r.ok = null;
		r.error = "pending";
		if (name) r.name = name;
		return true;
	}
	let row = { ap: maccolon(mn), name: name ?? maccolon(mn),
	            ok: null, error: "pending" };
	if (with_kvr) row.kvr = null;
	push(results, row);
	return true;
}

// ------------------------------------------------------- TCP server (all)
conn_close = function(conn) {
	if (!conn || conn.closed) return;
	conn.closed = true;
	if (conn.id != null) delete active_conns[conn.id];
	/* 先摘掉句柄再关闭：disconnect 回调可能重入，对已释放的
	   channel/socket 再次 disconnect/close 会让守护进程静默崩溃
	   （主路由在子路由 WiFi 重载断链时反复重启就是这个问题） */
	let ch = conn.chan;
	conn.chan = null;
	if (ch) { try { ch.disconnect(); } catch (e) {} }
	let sk = conn.sock;
	conn.sock = null;
	if (sk) { try { sk.close(); } catch (e) {} }
	if (conn.mac) {
		let mn = macnorm(conn.mac);
		let p = state.peers[mn];
		if (p && p.conn == conn) {
			p.conn = null;
			p.chan = null;
			p.authed = false;
			/* 在途推送的回调可能随连接一起丢失，必须清锁，否则重连后不再推送 */
			p.roam_pushing = false;
			p.bh_pushing = false;
			p.wifi_pushing = false;
			p.guest_pushing = false;
		}
	}
};

/* 清空 peers 前关闭所有服务端连接，避免 active_conns/fd 悬空 */
function close_all_conns() {
	let list = [];
	for (let id, c in active_conns)
		push(list, c);
	for (let c in list)
		conn_close(c);
}

function srv_rx(conn, req) {
	let args = req.args ?? {};

	if (!conn.authed) {
		if (req.type == "join" && state.cfg.role == "unconfigured") {
			// pairing: CAP pushes credentials to an unconfigured device
			/* 兼容旧/新 CAP：升级或重启后主 AP 缓存的 discovery nonce
			   可能已过期，只要 token 正确就允许配对，避免跨版本升级后
			   一直卡在 bad_nonce */
			if (!args.token) {
				req.reply({ ok: false, error: "bad_nonce" });
				return 0;
			}
			if (args.nonce_echo != state.self.nonce)
				log("join: stale nonce accepted (token ok)");
			state.cfg.token = args.token;
			state.cfg.cap_ip = args.cap_ip ?? "";
			if (args.cap_mac) state.cfg.cap_mac = macnorm(args.cap_mac);
			state.cfg.role = "sap";
			state.cap_lost_since = null;
			save_config();
			enable_relay_ap_mode();
			req.reply({ ok: true });
			push_event("paired", "", args.cap_ip ?? "");
			uloop.timer(300, reconfigure);
			return 0;
		}
		if (req.type == "auth") {
			let expect = sha256(state.cfg.token + ":" + conn.nonce);
			if (state.cfg.token == "" || args.digest != expect) {
				log(sprintf("reject auth from %s (role=%s)",
					args.mac ?? "?", state.cfg.role));
				req.reply({ ok: false, error: "auth" });
				/* 不能在 ubus channel 请求回调里同步关闭自身连接，
				   先让拒绝回执发出去，下一轮 uloop 再关闭 */
				let c = conn;
				uloop.timer(1000, function() { conn_close(c); });
				return 0;
			}
			let mn = macnorm(args.mac);
			conn.authed = true;
			conn.mac = uc(args.mac ?? "");
			conn.name = args.name;
			let p = state.peers[mn] ??= { clients: null }; // null = 未收过 report，首轮 diff 抑制
			/* 旧连接可能还有在途推送，换新连接时一并清锁，避免配置卡住 */
			if (p.conn && p.conn != conn) {
				let old = p.conn;
				p.conn = null;
				conn_close(old);
			}
			p.roam_pushing = false;
			p.bh_pushing = false;
			p.wifi_pushing = false;
			p.guest_pushing = false;
			p.wifi_sig = args.wifi_sig ?? null;
			p.mac = conn.mac;
			if (args.name) p.name = args.name;
			p.authed = true;
			p.authed_at = time();
			p.last_seen = time();
			p.chan = conn.chan;   // 存 channel 本体，conn 仅用于关闭时清理
			p.conn = conn;
			push_event("ap_online", conn.mac, conn.name ?? "");
			req.reply({
				ok: true, role: state.cfg.role,
				alias_ver: state.aliases.ver,
				roam_ver: current_roam_cfg().config_ver,
				backhaul_ver: current_backhaul_cfg().config_ver,
				// CAP 的 DHCP 租约表：SAP 无 DHCP，借此在子 AP 拓扑显示主机名
				names: state.cfg.role == "cap" ? client_names() : {},
				// 全网络 AP/SSID 概览：子 AP 的开启前检查与主 AP 保持一致
				roster: state.cfg.role == "cap" ? ap_overview() : null,
				devices: state.cfg.role == "cap" ? devices_cfg() : null,
			});
			if ((args.alias_ver ?? 0) < state.aliases.ver)
				push_aliases_to(mn);
			/* 先下发 Wi-Fi，再下发漫游：新 SAP 的 SSID 改名后，
			   随后的 802.11k/v/r 才能匹配到正确的 AP 接口 */
			wifi_sync_to(mn, p, args.wifi_sig ?? null);
			let roam = current_roam_cfg();
			// ver 落后或内容签名不一致都重新下发：后者用于修复历史遗留的
			// SAP 本地配置与主 AP 不一致（例如只同步了 enabled/ver）
			let roam_push = state.cfg.role == "cap" &&
			    ((args.roam_ver ?? -1) < roam.config_ver ||
			     (args.roam_sig && !roam_sig_ok(args.roam_sig, roam)));
			if (roam_push) {
				if (state.last_apply)
					last_result_mark_pending(state.last_apply.results, mn,
						p.info?.name ?? p.name ?? mn, true);
				push_roam_to(mn);
			}
			let bh = current_backhaul_cfg();
			let bh_push = state.cfg.role == "cap" && bh.enabled &&
			    (args.backhaul_ver ?? -1) < bh.config_ver;
			if (bh_push) {
				if (state.last_backhaul)
					last_result_mark_pending(state.last_backhaul.results, mn,
						p.info?.name ?? p.name ?? mn, false);
				push_backhaul_to(mn);
			}
			/* 访客配置也要在这里补发：只在保存那一刻推送的话，
			   子 AP 重连后仍会保留本地旧配置（旧密码/旧限速） */
			let ga = guest_cfg();
			if (state.cfg.role == "cap" && (args.guest_ver ?? -1) < ga.ver)
				push_guest_to(mn, ga);
			if (state.cfg.role == "cap")
				push_offload_to(mn);
			if (state.cfg.role == "cap")
				push_blocked_to(mn);
			/* 旧版 SAP 不发送 wifi_sig，保持原有「保存 Wi-Fi 时才推送」的行为 */
			return 0;
		}
		return 0;
	}

	// authed dispatch
	let mn = macnorm(conn.mac);
	switch (req.type) {
	case "report_status": {
		let p = state.peers[mn] ??= { clients: null };
		let prev = p.clients;
		p.info = args.info;
		p.clients = args.clients ?? {};
		p.alias_ver = args.alias_ver ?? 0;
		p.roam_ver = args.roam_ver ?? 0;
		p.roam_sig = args.roam_sig ?? "";
		p.backhaul_ver = args.backhaul_ver ?? 0;
		p.guest_ver = args.guest_ver ?? 0;
		p.wifi_sig = args.wifi_sig ?? null;
		/* SAP 真正应用后会带着新的 guest_ver 上报，据此确认结果 */
		if (state.cfg.role == "cap" && state.last_guest &&
		    p.guest_ver >= (state.last_guest.ver ?? 0)) {
			p.guest_pushing = false;
			apply_guest_result_update(mn, true, null);
		}
		p.kvr = args.kvr ?? null;
		p.last_seen = time();
		if (prev != null) // 首轮 report 不产 join/leave 事件
			diff_events(prev, p.clients, p.info?.name ?? conn.name ?? mn);
		owner_events(local_clients_cached()); // SAP 终端表更新后立即重算归属（含跨 AP 迁移）
		if (p.alias_ver < state.aliases.ver)
			push_aliases_to(mn);
		/* 同 auth：先 Wi-Fi 改名，再补发漫游配置 */
		wifi_sync_to(mn, p, p.wifi_sig);
		let roam = current_roam_cfg();
		if (p.roam_ver < roam.config_ver ||
		    (p.roam_sig != "" && !roam_sig_ok(p.roam_sig, roam)))
			push_roam_to(mn);
		let bh = current_backhaul_cfg();
		if (bh.enabled && p.backhaul_ver < bh.config_ver)
			push_backhaul_to(mn);
		let ga = guest_cfg();
		if (state.cfg.role == "cap" && p.guest_ver >= ga.ver)
			p.guest_pushing = false;
		if (state.cfg.role == "cap" && p.guest_ver < ga.ver)
			push_guest_to(mn, ga);
		/* flow offload 可能在防火墙页面被直接改动，主 AP 发现与已下发值
		   不一致时补推，保证子 AP 的开关状态与主路由一致 */
		if (state.cfg.role == "cap") {
			let fc = uci.cursor();
			fc.load("firewall");
			let cl = fc.get("firewall", "@defaults[0]", "flow_offloading") == "1";
			if (cl !== p.offload_last)
				push_offload_to(mn);
		}
		req.reply({ ok: true, alias_ver: state.aliases.ver,
		            roam_ver: roam.config_ver, backhaul_ver: bh.config_ver,
		            names: state.cfg.role == "cap" ? client_names() : {},
		            roster: state.cfg.role == "cap" ? ap_overview() : null,
		            devices: state.cfg.role == "cap" ? devices_cfg() : null,
		            usage: state.cfg.role == "cap" ? usage_for_clients(p.clients) : null,
		            bss: state.cfg.role == "cap" ? steer_bss_all() : null,
		            /* 最近一次漫游/无线回程应用结果：SAP 页面也显示全网络结果 */
		            last_apply: state.cfg.role == "cap" ? state.last_apply : null,
		            last_backhaul: state.cfg.role == "cap" ? state.last_backhaul : null });
		break;
	}
	case "report_event":
		push_event(args.etype ?? "peer_event", args.mac ?? "", args.info ?? "", args.name ?? "");
		req.reply({ ok: true });
		break;
	case "set_offload": {
		// SAP 页面上的开关：转发在 CAP，必须由 CAP 执行后再广播回全部子 AP
		if (state.cfg.role != "cap") {
			req.reply({ ok: false, error: "not_cap" });
			break;
		}
		let on = req.args.enabled ? true : false;
		let ok = offload_apply(on);
		for (let pmn, p in state.peers)
			if (p.authed) push_offload_to(pmn);
		req.reply({ ok: ok, enabled: on });
		break;
	}
	case "get_topology":
		req.reply(build_topology());
		break;
	case "get_client_detail": {
		let cmn = macnorm(args.mac);
		let c = local_clients_cached()[cmn];
		if (c)
			req.reply({ ok: true, client: client_node(cmn, c, mn) });
		else
			req.reply({ ok: false });
		break;
	}
	case "alias_update":
		if (state.cfg.role == "cap" &&
		    alias_apply(args.mac, args.name, args.icon, args.note)) {
			alias_broadcast();
			req.reply({ ok: true, ver: state.aliases.ver });
		} else {
			req.reply({ ok: false });
		}
		break;
	case "block_update": {
		/* 子 AP 页面触发的禁用/恢复：CAP 执行 nft 规则并同步回全部子 AP */
		if (state.cfg.role == "cap") {
			let bmn = macnorm(args.mac ?? "");
			if (length(bmn) == 12) {
				acl_set(bmn, args.block ? true : false);
				req.reply({ ok: true, blocked: args.block ? true : false });
				break;
			}
		}
		req.reply({ ok: false });
		break;
	}
	case "pin_update":
		if (state.cfg.role == "cap" &&
		    pin_apply(args.mac, args.ap ?? "").ok) {
			alias_broadcast();
			req.reply({ ok: true });
		} else {
			req.reply({ ok: false });
		}
		break;
	default:
		req.reply({ ok: false, error: "unknown_method" });
	}
	return 0;
}

function srv_accept() {
	while (true) {
		let addr = {};
		let cs = tcp_srv.accept(addr);
		if (!cs) break;

		let unauth = 0;
		for (let id, c in active_conns)
			if (!c.authed) unauth++;
		if (unauth >= MAX_UNAUTH_CONNS) {
			try { cs.close(); } catch (e) {}
			continue;
		}

		let conn = { id: ++conn_seq, ts: time(), authed: false,
		             sock: cs, nonce: randhex(16) };
		active_conns[conn.id] = conn;
		conn.chan = libubus.open_channel(
			cs,
			function(req) { return srv_rx(conn, req); },
			function() {
				/* 通道已被 libubus 关闭：清掉句柄再清理状态，
				   避免重复 disconnect/close */
				conn.chan = null;
				conn.sock = null;
				conn_close(conn);
			});
		conn.chan.request({
			method: "hello",
			data: { mac: state.self.mac, role: state.cfg.role,
			        nonce: conn.nonce },
			return: "ignore",
		});
	}
}

/* 未认证连接没有业务价值，超时或超额后主动关闭，避免 fd 耗尽 */
function conn_cleanup() {
	let now = time();
	let unauth = [], expired = [];

	for (let id, c in active_conns) {
		if (c.authed) continue;
		if (now - (c.ts ?? now) > CONN_AUTH_TIMEOUT)
			push(expired, c);
		else
			push(unauth, c);
	}

	for (let c in expired) {
		log("closing unauthenticated connection");
		conn_close(c);
	}

	while (length(unauth) > MAX_UNAUTH_CONNS) {
		let c = shift(unauth);
		log("closing excess unauthenticated connection");
		conn_close(c);
	}
}

function setup_tcp() {
	tcp_srv = socket.create(socket.AF_INET,
		socket.SOCK_STREAM | socket.SOCK_NONBLOCK, 0);
	if (!tcp_srv) { log("tcp create failed"); return; }
	tcp_srv.setopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, true);
	if (!tcp_srv.bind("0.0.0.0:" + TCP_PORT) || !tcp_srv.listen(8)) {
		log("tcp bind/listen failed: " + socket.error());
		tcp_srv.close(); tcp_srv = null;
		exit(1);   // fail-fast：避免僵尸实例与正常实例竞争
	}
	uloop.handle(tcp_srv.fileno(), srv_accept, uloop.ULOOP_READ);
}

// ------------------------------------------------------- push helpers (CAP)
// 通道写失败时清理对端状态，避免僵尸连接导致守护进程崩溃
function peer_link_dead(mn, what) {
	let p = state.peers[mn];
	log(sprintf("%s to %s failed, marking peer offline", what, mn));
	if (!p) return;
	p.authed = false;
	p.chan = null;
	if (p.conn) { let c = p.conn; p.conn = null; conn_close(c); }
}

push_aliases_to = function(mn) {
	let p = state.peers[mn];
	if (!p?.authed || !p.chan) return;
	try {
		p.chan.defer({
			method: "push_aliases",
			data: { aliases: state.aliases },
			data_cb: function() {}, cb: function() {},
		});
	} catch (e) {
		peer_link_dead(mn, "push_aliases");
	}
};

push_roam_to = function(mn) {
	let p = state.peers[mn];
	if (!p?.authed || !p.chan) return false;
	if (p.roam_pushing) return true; // 推送在途，避免 auth+report 竞争重复下发
	let roam = current_roam_cfg();
	// 旧 SAP 用 UCI set 写数组，空数组无法清除已有 SSID，空字符串占位的签名相同。
	if (!length(roam.ssids)) roam.ssids = [ "" ];
	let name = p.info?.name ?? p.name ?? mn;
	p.roam_pushing = true;
	try {
		p.chan.defer({
			method: "push_roam_config",
			data: { roam, members: member_list() },
			data_cb: function(m) {
				p.roam_pushing = false;
				apply_result_update(mn, name, m?.ok ?? false, m?.ver ?? null, null, m?.kvr ?? null);
			},
			cb: function(rc) {
				// 成功时 data_cb 已写入结果；仅失败/超时标记 timeout
				if (rc != 0) {
					p.roam_pushing = false;
					apply_result_update(mn, name, false, null, "timeout");
				}
			},
		});
	} catch (e) {
		p.roam_pushing = false;
		peer_link_dead(mn, "push_roam_config");
		return false;
	}
	return true;
};

apply_result_update = function(mn, name, ok, ver, err, kvr) {
	if (!state.last_apply) return;
	for (let r in state.last_apply.results) {
		if (r.ap == maccolon(mn) || r.ap == mn) {
			r.ok = ok; r.ver = ver; r.error = err;
			if (kvr) r.kvr = kvr;
		}
	}
};

push_backhaul_to = function(mn) {
	let p = state.peers[mn];
	if (!p?.authed || !p.chan) return false;
	if (p.bh_pushing) return true;
	let bh = current_backhaul_cfg();
	let name = p.info?.name ?? p.name ?? mn;
	p.bh_pushing = true;
	try {
		p.chan.defer({
			method: "push_backhaul_config",
			data: { backhaul: bh },
			data_cb: function(m) {
				p.bh_pushing = false;
				apply_backhaul_result_update(mn, name, m?.ok ?? false, m?.ver ?? null, m?.error ?? null);
			},
			cb: function(rc) {
				if (rc != 0) {
					p.bh_pushing = false;
					apply_backhaul_result_update(mn, name, false, null, "timeout");
				}
			},
		});
	} catch (e) {
		p.bh_pushing = false;
		peer_link_dead(mn, "push_backhaul_config");
		return false;
	}
	return true;
};

// 把新的 SSID / 密码（按频段）推给成员 AP（SAP 收到后改写本地 wireless 并重启无线）
push_wifi_to = function(mn, ssids, sig) {
	let p = state.peers[mn];
	if (!p?.authed || !p.chan) return false;
	if (p.wifi_pushing) return true;
	p.wifi_pushing = true;
	p.wifi_sig_pushed = sig ?? "";
	p.wifi_pushed_ts = time();
	try {
		p.chan.defer({
			method: "push_wifi_config",
			data: { ssids: ssids },
			data_cb: function(m) {
				p.wifi_pushing = false;
				apply_wifi_result_update(mn, m?.ok ?? false, m?.error ?? null);
			},
			cb: function(rc) {
				if (rc != 0) {
					p.wifi_pushing = false;
					p.wifi_sig_pushed = "";
					apply_wifi_result_update(mn, false, "timeout");
				}
			},
		});
	} catch (e) {
		p.wifi_pushing = false;
		p.wifi_sig_pushed = "";
		peer_link_dead(mn, "push_wifi_config");
		return false;
	}
	return true;
};

apply_wifi_result_update = function(mn, ok, err) {
	if (!state.last_wifi) return;
	for (let r in state.last_wifi.results) {
		if (r.ap == maccolon(mn) || r.ap == mn) {
			r.ok = ok; r.error = err;
		}
	}
};

// CAP：按 Wi-Fi 签名判断是否需要给某台 SAP 下发当前无线配置。
// 同一签名在 WIFI_PUSH_GRACE 内不重复下发，避免 SAP reload 期间反复重启无线。
wifi_sync_to = function(mn, p, reported_sig) {
	if (state.cfg.role != "cap" || reported_sig == null) return false;

	let ssids = wifi_push_payload();
	if (!length(ssids)) return false;

	let sig = wifi_sig(ssids);
	if (reported_sig == sig) {
		p.wifi_sig_pushed = "";
		return false;
	}
	if (p.wifi_sig_pushed == sig &&
	    time() - (p.wifi_pushed_ts ?? 0) < WIFI_PUSH_GRACE)
		return false;

	return push_wifi_to(mn, ssids, sig);
};

// 把访客网络配置推给成员 AP（SAP 收到后重建本机访客子网）
push_guest_to = function(mn, cfg) {
	let p = state.peers[mn];
	if (!p?.authed || !p.chan) return false;
	if (p.guest_pushing) return true;
	p.guest_pushing = true;
	p.guest_pushing_ts = time();
	try {
		p.chan.defer({
			method: "push_guest_config",
			data: { guest: cfg },
			data_cb: function(m) {
				/* SAP 已接受但仍在 reload：保持 pushing，避免 report 反复重发 */
				if (m?.pending) return;
				p.guest_pushing = false;
				apply_guest_result_update(mn, m?.ok ?? false, m?.error ?? null);
			},
			cb: function(rc) {
				if (rc != 0) {
					p.guest_pushing = false;
					apply_guest_result_update(mn, false, "timeout");
				}
			},
		});
	} catch (e) {
		p.guest_pushing = false;
		peer_link_dead(mn, "push_guest_config");
		return false;
	}
	return true;
};

apply_guest_result_update = function(mn, ok, err) {
	if (!state.last_guest) return;
	for (let r in state.last_guest.results) {
		if (r.ap == maccolon(mn) || r.ap == mn) {
			r.ok = ok; r.error = err;
		}
	}
};

apply_backhaul_result_update = function(mn, name, ok, ver, err) {
	if (!state.last_backhaul) return;
	for (let r in state.last_backhaul.results) {
		if (r.ap == maccolon(mn) || r.ap == mn) {
			r.ok = ok; r.ver = ver; r.error = err;
		}
	}
};

// CAP：把 flow offload 开关广播给所有已认证的子 AP，保证各页面看到同一状态
push_offload_to = function(mn) {
	let p = state.peers[mn];
	if (!p?.authed || !p.chan) return;
	let cur = uci.cursor();
	cur.load("firewall");
	let on = cur.get("firewall", "@defaults[0]", "flow_offloading") == "1";
	p.offload_last = on;
	try {
		p.chan.defer({
			method: "push_offload",
			data: { enabled: on },
			data_cb: function() {}, cb: function() {},
		});
	} catch (e) {
		peer_link_dead(mn, "push_offload");
	}
};

/* CAP：把暂停联网列表同步给子 AP。子 AP 不执行 nft 丢弃（转发在主 AP），
   只更新本地状态，让子 AP 页面/拓扑显示一致的「已暂停」。 */
push_blocked_to = function(mn) {
	let p = state.peers[mn];
	if (!p?.authed || !p.chan) return;
	try {
		p.chan.defer({
			method: "block_sync",
			data: { blocked: state.blocked },
			data_cb: function() {}, cb: function() {},
		});
	} catch (e) {
		peer_link_dead(mn, "push_blocked");
	}
};

/* CAP：把终端管理设置同步给子 AP（固定 AP 纠正由各 AP 本地执行） */
push_devices_to = function(mn) {
	let p = state.peers[mn];
	if (!p?.authed || !p.chan) return;
	try {
		p.chan.defer({
			method: "devices_config",
			data: { devices: devices_cfg() },
			data_cb: function() {}, cb: function() {},
		});
	} catch (e) {
		peer_link_dead(mn, "push_devices");
	}
};

// ------------------------------------------------------------------ ubus API
function find_client(mn) {
	let local = local_clients_cached();
	if (local[mn])
		return { node: client_node(mn, local[mn], macnorm(state.self.mac)),
		         ap: state.self.name };
	for (let pmn, p in state.peers) {
		let c = p.clients?.[mn];
		if (c) {
			// SAP 上报可能缺 ip/hostname，用本机 leases/ARP 补全
			if (c.ip == null || c.hostname == null) {
				let leases = parse_leases();
				let neigh = parse_neigh();
				if (c.ip == null)
					c.ip = leases[mn]?.ip ?? neigh[mn]?.ip ?? null;
				if (c.hostname == null)
					c.hostname = leases[mn]?.hostname ?? null;
			}
			return { node: client_node(mn, c, pmn),
			         ap: p.info?.name ?? p.name ?? pmn };
		}
	}
	return null;
}

/* 恢复插件初始状态：解除组网、清除漫游/回程/访客/信道和数据，角色回到未配置。
   UI 在接口返回后会重启服务，保证以干净状态重新加载。 */
function factory_reset() {
	for (let mn, p in state.peers) {
		if (!p.authed || !p.chan) continue;
		try {
			p.chan.defer({ method: "leave", data: {},
			               data_cb: function() {}, cb: function() {} });
		} catch (e) {}
	}
	close_all_conns();
	state.peers = {};
	state.discovered = {};

	/* 清除插件写入 wireless 的漫游/回程配置 */
	let wc = uci.cursor();
	wc.load("wireless");
	wc.foreach("wireless", "wifi-iface", function(s) {
		if (s.mode && s.mode != "ap") return;
		for (let k in ROAM_KEYS)
			wc.delete("wireless", s[".name"], k);
	});
	wc.delete("wireless", BACKHAUL_SECTION);
	wc.commit("wireless");

	/* 移除访客网络基础设施；该函数内部会重载 network/wifi */
	let g = guest_cfg();
	g.enabled = false;
	apply_guest_local(g);

	/* 恢复默认的硬件/软件加速开关 */
	offload_apply(false);

	/* 重置 wifiroam UCI 默认值 */
	let cur = uci.cursor();
	cur.load("wifiroam");
	cur.set("wifiroam", "core", "enabled", "1");
	cur.set("wifiroam", "core", "role", "unconfigured");
	cur.set("wifiroam", "core", "token", "");
	cur.set("wifiroam", "core", "cap_ip", "");
	cur.set("wifiroam", "core", "name", "");
	cur.set("wifiroam", "core", "offload", "0");

	cur.set("wifiroam", "roam", "enabled", "1");
	cur.set("wifiroam", "roam", "ft_mode", "simple");
	cur.set("wifiroam", "roam", "ft_over_ds", "1");
	cur.set("wifiroam", "roam", "k_neighbor", "1");
	cur.set("wifiroam", "roam", "k_beacon", "1");
	cur.set("wifiroam", "roam", "v_bss_transition", "1");
	cur.set("wifiroam", "roam", "rssi_profile", "balanced");
	cur.set("wifiroam", "roam", "rssi_threshold", "-70");
	cur.set("wifiroam", "roam", "config_ver", "0");
	cur.delete("wifiroam", "roam", "ssids");
	cur.delete("wifiroam", "roam", "r_fast");
	cur.delete("wifiroam", "roam", "guest_selected");

	cur.set("wifiroam", "backhaul", "enabled", "0");
	cur.set("wifiroam", "backhaul", "ssid", BACKHAUL_DEFAULT_SSID);
	cur.set("wifiroam", "backhaul", "key", "");
	cur.set("wifiroam", "backhaul", "device", "");
	cur.set("wifiroam", "backhaul", "config_ver", "0");

	cur.set("wifiroam", "guest", "enabled", "0");
	cur.set("wifiroam", "guest", "ssid", GUEST_DEFAULT_SSID);
	cur.set("wifiroam", "guest", "key", "");
	cur.set("wifiroam", "guest", "bandwidth", "0");
	cur.set("wifiroam", "guest", "schedule", "0");
	cur.set("wifiroam", "guest", "start", "08:00");
	cur.set("wifiroam", "guest", "end", "23:00");
	cur.set("wifiroam", "guest", "allow_lan", "0");
	cur.set("wifiroam", "guest", "config_ver", "0");

	cur.set("wifiroam", "alias_sync", "ver", "0");
	cur.set("wifiroam", "devices", "max", "" + DEVICES_MAX);
	cur.set("wifiroam", "devices", "ban", "" + (PIN_BAN_MS / 1000));
	cur.set("wifiroam", "devices", "pin_enforce", "1");
	/* 清除所有上网时段规则与总开关 */
	let bans = [];
	cur.foreach("wifiroam", "ban", function(s) { push(bans, s[".name"]); });
	for (let sid in bans) cur.delete("wifiroam", sid);
	cur.delete("wifiroam", "schedule");
	cur.commit("wifiroam");

	/* 清除别名、流量统计和运行态 */
	try { fs.unlink(ALIAS_PATH); } catch (e) {}
	try { fs.unlink(USAGE_PATH); } catch (e) {}
	try { fs.unlink(BLOCK_PATH); } catch (e) {}
	try { fs.unlink(DEVICES_PATH); } catch (e) {}
	state.aliases = { ver: 0, map: {}, pin: {} };
	state.blocked = {};
	state.devices = {};
	state._dev_dirty = false;
	state._dev_saved = 0;
	state.pin_last = {};
	state.ban = { enabled: false, list: [], active: {}, sig: "" };
	cmd_output(sprintf("nft delete table inet %s 2>/dev/null", BAN_TABLE));
	acl_apply();
	state.usage = { day: "", online: {}, ndata: {}, ndir: {} };
	state.events = [];
	state._usage_snap = null;
	state._usage_station_snap = null;
	state._usage_ts = 0;
	state._usage_online_ts = 0;
	state._usage_dirty = false;
	state._usage_saved = 0;
	state._usage_track = null;
	state.steer_last = {};
	state.steer_low = {};
	state.steer_stage = {};
	state.steer_tries = {};
	state.steer_mute = {};
	state.kick_last = {};
	state.bss_list = null;
	state._bss_cache = null;
	state.last_apply = null;
	state.last_backhaul = null;
	state.last_wifi = null;
	state.last_guest = null;
	state.prev_clients = null;
	state.prev_owner = null;
	state.wired_seen = {};
	state.client_seen = {};
	state.client_bytes = {};
	state.bytes_cache = {};
	_clients_cache = { ts: 0, data: null };
	_sec_cache = {};
	state.net_names = {};
	state.roster = null;
	state.cap_learned = null;
	state.guest_open = null;
	state.guest_tc_devs = {};
	state.guest_tc_error = "";
	state.guest_fw4_error = null;
	state.guest_fw4_failed = null;
	state.guest_fw4_retry_at = 0;
	state._guest_nft_sig = "";
	state._guest_zone_migrated = false;
	state._guest_bridged = null;
	state.roam_ver_applied = 0;
	state.backhaul_ver_applied = 0;
	state.cap_lost_since = null;
	state.cap_learned = null;

	state.cfg = {
		enabled: true, role: "unconfigured",
		token: "", cap_ip: "", cap_mac: "", name: "",
	};
	save_config();
	reconfigure();
	return { ok: true };
}

let api_obj = {
	status: {
		args: { ubus_rpc_session: "" },
		call: function(req) {
			/* 能留在 peers 里说明 30s 内收到过 hello，与首页/拓扑口径一致 */
			let nclients = 0;
			for (let mn, p in state.peers)
				nclients += length(keys(p.clients ?? {}));
			nclients += length(keys(local_clients_cached()));
			let peers_total = 1 + length(keys(state.peers));
			let online = peers_total;
			// SAP 以 CAP 下发的概览为准，成员 AP 计数与主AP保持一致
			if (state.cfg.role == "sap" && type(state.roster?.aps) == "array" &&
			    length(state.roster.aps)) {
				let o = 0, t = 0;
				for (let a in state.roster.aps) {
					t++;
					if (a.online) o++;
				}
				online = o; peers_total = t;
			}
			return {
				version: DAEMON_VERSION,
				daemon_started: daemon_started,
				kvr: applied_kvr(current_roam_cfg()),
				role: state.cfg.role, name: state.self.name,
				mac: state.self.mac, ip: state.self.ip,
				cap_ip: state.cfg.cap_ip != "" ? state.cfg.cap_ip : state.cap_learned,
				model: state.self.model, firmware: state.self.firmware,
				uptime: self_uptime(),
				peers_online: online, peers_total,
				clients_total: nclients,
				roam: current_roam_cfg(),
				backhaul: current_backhaul_cfg(),
				devices: devices_cfg(),
				alias_ver: state.aliases.ver,
				last_apply: state.last_apply,
				last_backhaul: state.last_backhaul,
			};
		},
	},
	topology: {
		args: { ubus_rpc_session: "" },
		call: function(req) { return build_topology(); },
	},
	client_detail: {
		args: { ubus_rpc_session: "", mac: "" },
		call: function(req) {
			let mac = req.args.mac;
			if (!mac) return libubus.STATUS_INVALID_ARGUMENT;
			let r = find_client(macnorm(mac));
			if (!r) return libubus.STATUS_NOT_FOUND;
			return { ok: true, client: r.node, ap: r.ap };
		},
	},
	set_alias: {
		args: { ubus_rpc_session: "", mac: "", name: "", icon: "", note: "" },
		call: function(req) {
			let a = req.args;
			if (!a.mac) return libubus.STATUS_INVALID_ARGUMENT;
			if (state.cfg.role == "sap" && state.link?.authed) {
				// forward to CAP; CAP broadcasts the new alias table
				try {
					state.link.chan.defer({
						method: "alias_update",
						data: { mac: a.mac, name: a.name, icon: a.icon, note: a.note },
						data_cb: function() {}, cb: function() {},
					});
				} catch (e) {
					sap_disconnect();
					return { ok: false, error: "link_down" };
				}
				return { ok: true, forwarded: true };
			}
			if (!alias_apply(a.mac, a.name, a.icon, a.note))
				return { ok: false, error: "invalid_mac" };
			alias_broadcast();
			return { ok: true, ver: state.aliases.ver };
		},
	},
	/* 禁用/恢复某个终端的所有转发流量（实际规则由主 AP 执行）。 */
	set_client_block: {
		args: { ubus_rpc_session: "", mac: "", block: false },
		call: function(req) {
			if (!req.args.mac) return libubus.STATUS_INVALID_ARGUMENT;
			let mn = macnorm(req.args.mac);
			if (length(mn) != 12) return libubus.STATUS_INVALID_ARGUMENT;
			let on = req.args.block ? true : false;

			/* 子 AP 上操作时转发给主 AP，CAP 执行后会通过 block_sync
			   把状态广播回来，页面无需区分当前在哪台 AP */
			if (state.cfg.role == "sap" && state.link?.authed) {
				try {
					state.link.chan.defer({
						method: "block_update",
						data: { mac: maccolon(mn), block: on },
						data_cb: function() {}, cb: function() {},
					});
				} catch (e) {
					sap_disconnect();
					return { ok: false, error: "link_down" };
				}
				return { ok: true, blocked: on, forwarded: true };
			}
			if (state.cfg.role != "cap")
				return { ok: false, error: "not_cap" };

			acl_set(mn, on);
			log(sprintf("client block %s -> %s", maccolon(mn), on ? "on" : "off"));
			return { ok: true, blocked: on };
		},
	},
	/* 终端历史（含已离线设备）：设备页卡片与网络唤醒的数据源 */
	device_history: {
		args: { ubus_rpc_session: "" },
		call: function(req) { return device_history_view(); },
	},
	wake: {
		args: { ubus_rpc_session: "", mac: "" },
		call: function(req) {
			let mn = macnorm(req.args.mac ?? "");
			if (length(mn) != 12) return libubus.STATUS_INVALID_ARGUMENT;
			let d = state.devices[mn];
			if (!d) return { ok: false, error: "unknown_device" };
			/* 只唤醒曾经在线过的设备（历史白名单），在线设备直接拒绝 */
			if (d.online) return { ok: false, error: "already_online" };
			let sent = wol_wake(mn);
			if (!sent) return { ok: false, error: "send_failed" };
			return { ok: true, sent, mac: maccolon(mn) };
		},
	},
	/* 固定 AP：让终端只连指定 AP（空字符串取消固定）。
	   SAP 侧改动统一转发给 CAP 保存并广播，避免各 AP 记录不一致。 */
	set_pin: {
		args: { ubus_rpc_session: "", mac: "", ap: "" },
		call: function(req) {
			let a = req.args;
			if (!a.mac) return libubus.STATUS_INVALID_ARGUMENT;
			if (state.cfg.role == "sap" && state.link?.authed) {
				try {
					state.link.chan.defer({
						method: "pin_update",
						data: { mac: a.mac, ap: a.ap ?? "" },
						data_cb: function() {}, cb: function() {},
					});
				} catch (e) {
					sap_disconnect();
					return { ok: false, error: "link_down" };
				}
				return { ok: true, forwarded: true };
			}
			let r = pin_apply(a.mac, a.ap ?? "");
			if (r.ok) alias_broadcast();
			return r;
		},
	},
	/* 终端管理设置：CAP 保存后持久化并同步到全部子 AP */
	set_devices: {
		args: { ubus_rpc_session: "", max: 0, ban: 0, pin_enforce: true },
		call: function(req) {
			if (state.cfg.role != "cap") return { ok: false, error: "not_cap" };
			let max = int(req.args.max ?? 0);
			let ban = int(req.args.ban ?? 0);
			if (max < 20 || max > 2000) return { ok: false, error: "invalid_max" };
			if (ban < 10 || ban > 3600) return { ok: false, error: "invalid_ban" };

			let cur = uci.cursor();
			cur.load("wifiroam");
			cur.set("wifiroam", "devices", "max", "" + max);
			cur.set("wifiroam", "devices", "ban", "" + ban);
			cur.set("wifiroam", "devices", "pin_enforce",
				req.args.pin_enforce ? "1" : "0");
			cur.commit("wifiroam");

			for (let mn, p in state.peers)
				if (p.authed) push_devices_to(mn);
			return { ok: true, devices: devices_cfg() };
		},
	},
	/* 清除已离线终端的历史记录（在线设备与固定 AP 记录保留） */
	clear_device_history: {
		args: { ubus_rpc_session: "" },
		call: function(req) {
			let removed = 0;
			for (let key, d in state.devices) {
				if (d.online) continue;
				delete state.devices[key];
				removed++;
			}
			if (removed) {
				state._dev_dirty = true;
				devices_save(true);
			}
			return { ok: true, removed };
		},
	},
	/* 上网时段：读取全部规则 + 当前是否生效（设备详情弹窗使用） */
	ban_list: {
		args: { ubus_rpc_session: "" },
		call: function(req) {
			let lt = localtime(time());
			let nowmin = lt.hour * 60 + lt.min;
			let items = [];
			for (let b in ban_read())
				push(items, {
					mac: b.mac, name: b.name,
					timeon: b.timeon, timeoff: b.timeoff,
					weekdays: b.weekdays,
					active: state.ban.enabled && ban_in_window(b, lt, nowmin),
				});
			return {
				ok: state.cfg.role == "cap",
				error: state.cfg.role == "cap" ? "" : "not_cap",
				enabled: state.ban.enabled,
				items,
				blocked: keys(state.ban.active),
			};
		},
	},
	/* 上网时段总开关 */
	set_ban: {
		args: { ubus_rpc_session: "", enabled: false },
		call: function(req) {
			if (state.cfg.role != "cap") return { ok: false, error: "not_cap" };
			let on = req.args.enabled ? true : false;
			let cur = uci.cursor();
			cur.load("wifiroam");
			if (cur.get("wifiroam", "schedule") == null)
				cur.set("wifiroam", "schedule", "schedule");
			cur.set("wifiroam", "schedule", "enabled", on ? "1" : "0");
			cur.commit("wifiroam");
			state.ban.enabled = on;
			ban_apply(true);
			return { ok: true, enabled: on };
		},
	},
	/* 保存某终端的上网时段 */
	ban_set: {
		args: { ubus_rpc_session: "", mac: "", name: "",
		        timeon: "", timeoff: "", weekdays: "" },
		call: function(req) {
			if (state.cfg.role != "cap") return { ok: false, error: "not_cap" };
			let a = req.args;
			let mn = macnorm(a.mac ?? "");
			if (length(mn) != 12) return { ok: false, error: "invalid_mac" };
			let on = ban_hm(a.timeon), off = ban_hm(a.timeoff);
			if (on == null || off == null) return { ok: false, error: "invalid_time" };
			let days = ban_weekdays(a.weekdays);
			if (!length(days)) return { ok: false, error: "invalid_weekdays" };
			let name = a.name ?? "";
			if (name == "")
				name = state.aliases.map[mn]?.name ?? state.devices[mn]?.hostname ?? "";

			let cur = uci.cursor();
			cur.load("wifiroam");
			let sid = null, old = [];
			cur.foreach("wifiroam", "ban", function(s) {
				if (macnorm(s.mac ?? "") == mn) {
					if (!sid) sid = s[".name"];
					push(old, s[".name"]);
				}
			});
			if (!sid) sid = cur.add("wifiroam", "ban");
			cur.set("wifiroam", sid, "mac", mn);
			cur.set("wifiroam", sid, "name", name);
			cur.set("wifiroam", sid, "timeon", ban_hm_str(on));
			cur.set("wifiroam", sid, "timeoff", ban_hm_str(off));
			cur.set("wifiroam", sid, "weekdays", join(" ", days));
			for (let id in old)
				if (id != sid) cur.delete("wifiroam", id);
			cur.commit("wifiroam");

			/* 首次保存时段时总开关默认开启（显式关闭的保持关闭） */
			ban_reload_enabled();
			ban_apply(true);
			return { ok: true, mac: mn, blocked: !!state.ban.active[mn] };
		},
	},
	/* 删除某终端的上网时段 */
	ban_del: {
		args: { ubus_rpc_session: "", mac: "" },
		call: function(req) {
			if (state.cfg.role != "cap") return { ok: false, error: "not_cap" };
			let mn = macnorm(req.args.mac ?? "");
			let cur = uci.cursor();
			cur.load("wifiroam");
			let old = [];
			cur.foreach("wifiroam", "ban", function(s) {
				if (macnorm(s.mac ?? "") == mn) push(old, s[".name"]);
			});
			if (!length(old)) return { ok: false, error: "not_found" };
			for (let sid in old) cur.delete("wifiroam", sid);
			cur.commit("wifiroam");
			/* 删掉最后一个时段后，未显式配置的总开关回到默认关闭 */
			ban_reload_enabled();
			ban_apply(true);
			return { ok: true };
		},
	},
	reset: {
		args: { ubus_rpc_session: "" },
		call: function(req) {
			return factory_reset();
		},
	},
	set_role: {
		args: { ubus_rpc_session: "", role: "" },
		call: function(req) {
			let r = req.args.role;
			if (index([ "cap", "sap", "unconfigured" ], r) < 0)
				return libubus.STATUS_INVALID_ARGUMENT;
			if (r == "sap")
				return { ok: false, error: "sap_via_pairing" };
			state.cfg.role = r;
			if (r != "sap") state.cfg.cap_mac = "";
			state.cap_lost_since = null;
			if (r == "cap") ensure_token();
			if (r == "unconfigured") {
				/* 主路由重置角色时通知所有在线子路由解除组网，
				   让它们也回到未配置状态，避免继续用旧 token 重连 */
				for (let mn, p in state.peers) {
					if (!p.authed || !p.chan) continue;
					try {
						p.chan.defer({
							method: "leave", data: {},
							data_cb: function() {}, cb: function() {},
						});
					} catch (e) {}
				}
				close_all_conns();
				state.peers = {};
				state.cfg.token = "";
				state.cfg.cap_ip = "";
				state.cfg.cap_mac = "";
				state.cap_learned = null;
				state.last_apply = null;
				state.last_backhaul = null;
			}
			save_config();
			reconfigure();
			if (r == "cap") {
				/* 先返回响应，再后台应用默认漫游：避免设为主路由时
				   同步写无线/重载导致服务像是停止或页面卡住 */
				uloop.timer(300, function() {
					if (state.cfg.role != "cap") return;
					roam_default_init();
				});
			}
			return { ok: true, role: r };
		},
	},
	get_roam: {
		args: { ubus_rpc_session: "" },
		call: function(req) {
			// SAP 侧用 CAP 下发的全网络概览，避免 SSID 组 AP 数量与成员列表
			// 只看到本机（显示 1 台）而与主AP不一致
			let use_roster = (state.cfg.role == "sap" && state.roster?.groups);
			let members = member_list();
			if (use_roster && type(state.roster.aps) == "array") {
				members = [];
				for (let a in state.roster.aps)
					push(members, { mac: maccolon(a.id), name: a.name ?? a.id });
			}
			let roam = current_roam_cfg();
			return {
				roam,
				groups: use_roster ? state.roster.groups : ssid_groups(),
				members,
				kvr: applied_kvr(roam),
			};
		},
	},
	set_roam: {
		args: {
			ubus_rpc_session: "",
			enabled: false, ssids: [], r_fast: true, ft_mode: "",
			ft_over_ds: false, k_neighbor: false,
			k_beacon: false, v_bss_transition: false,
			rssi_profile: "", rssi_threshold: 0,
		},
		call: function(req) {
			let a = req.args;
			if (state.cfg.role != "cap")
				return { ok: false, error: "not_cap" };
			let profile = a.rssi_profile ?? "balanced";
			if (index([ "aggressive", "gaming", "balanced", "conservative", "custom" ], profile) < 0)
				profile = "balanced";
			let threshold = int(a.rssi_threshold ?? 0);
			if (profile != "custom" || threshold == 0)
				threshold = rssi_preset(profile);
			if (threshold > -30) threshold = -30;
			if (threshold < -95) threshold = -95;
			let cur = uci.cursor();
			cur.load("wifiroam");
			let ver = int(cur.get("wifiroam", "roam", "config_ver") ?? "0") + 1;
			cur.set("wifiroam", "roam", "enabled", a.enabled ? "1" : "0");
			if (length(a.ssids ?? [])) cur.set("wifiroam", "roam", "ssids", a.ssids);
			else cur.delete("wifiroam", "roam", "ssids");
			cur.set("wifiroam", "roam", "r_fast", a.r_fast ? "1" : "0");
			cur.set("wifiroam", "roam", "ft_mode",
				a.ft_mode == "explicit" ? "explicit" : "simple");
			cur.set("wifiroam", "roam", "ft_over_ds", a.ft_over_ds ? "1" : "0");
			cur.set("wifiroam", "roam", "k_neighbor", a.k_neighbor ? "1" : "0");
			cur.set("wifiroam", "roam", "k_beacon", a.k_beacon ? "1" : "0");
			cur.set("wifiroam", "roam", "v_bss_transition",
				a.v_bss_transition ? "1" : "0");
			cur.set("wifiroam", "roam", "rssi_profile", profile);
			cur.set("wifiroam", "roam", "rssi_threshold", "" + threshold);
			cur.set("wifiroam", "roam", "config_ver", "" + ver);
			cur.commit("wifiroam");

			let roam = current_roam_cfg();
			let members = member_list();
			let results = [];
			let lr = apply_roam_local(roam, members);
			push(results, { ap: state.self.mac, name: state.self.name,
			                ok: lr.ok, ver: lr.ver, kvr: applied_kvr(roam) });
			// 先落 last_apply，再推送，才能收集到各 SAP 的异步回执
			state.last_apply = { ts: time(), ver, results };
			for (let mn, p in state.peers) {
				if (!p.authed) continue;
				push(results, { ap: p.mac ?? maccolon(mn),
				                name: p.info?.name ?? p.name ?? mn,
				                ok: null, error: "pending" });
				push_roam_to(mn);
			}
			return { ok: true, ver, results, ts: state.last_apply.ts };
		},
	},
	precheck: {
		args: { ubus_rpc_session: "" },
		call: function(req) { return precheck(); },
	},
	get_backhaul: {
		args: { ubus_rpc_session: "" },
		call: function(req) {
			return {
				backhaul: current_backhaul_cfg(),
				radios: wifi_radios(),
				self: { mac: state.self.mac, name: state.self.name },
			};
		},
	},
	// 「无线设置」：读取本机 SSID / 密码状态（SAP 上也返回本机值，仅展示）
	get_wifi: {
		args: { ubus_rpc_session: "" },
		call: function(req) {
			let s = wifi_summary();
			s.role = state.cfg.role;
			s.last = state.last_wifi ?? null;
			return s;
		},
	},
	// 改名 / 改密码：主AP 生效后同步到所有已配对 AP。
	// ifaces = [{ band, ssid, key }]：每个频段一个名称/密码（多频合一时各项相同）
	set_wifi: {
		args: { ubus_rpc_session: "", unified: false, ifaces: [] },
		call: function(req) {
			if (state.cfg.role != "cap")
				return { ok: false, error: "not_cap" };
			let list = req.args.ifaces;
			if (type(list) != "array" || length(list) < 1)
				return { ok: false, error: "ssid_invalid" };

			let ssids = [];
			for (let it in list) {
				let ssid = trim(it.ssid ?? "");
				let key = it.key ?? "";
				if (length(ssid) < 1 || length(ssid) > 32)
					return { ok: false, error: "ssid_invalid" };
				// WPA2/WPA3 的口令为 8-63 字符；64 位十六进制也接受（原始 PSK）
				if (key != "" && (length(key) < 8 || length(key) > 64))
					return { ok: false, error: "key_invalid" };
				push(ssids, { band: it.band ?? "?", ssid: ssid, key: key });
			}

			// 留空表示沿用主路由该频段当前密码；多频合一时统一使用主路由
			// 现有密码，并把 open 状态一起下发给 SAP，避免只同步名称。
			let cap_keys = {}, cap_open = {}, common = "";
			let cur = uci.cursor();
			cur.load("wireless");
			cur.foreach("wireless", "wifi-iface", function(s) {
				if (s.mode && s.mode != "ap") return;
				if (s.wifiroam_guest == "1") return;
				let band = cur.get("wireless", s.device, "band") ?? "?";
				let key = s.key ?? "";
				let enc = s.encryption ?? "";
				if (common == "") common = key;
				if (cap_keys[band] == null) {
					cap_keys[band] = key;
					cap_open[band] = (key == "" && (enc == "" || enc == "none"));
				}
				else if (cap_keys[band] == "" && key != "") {
					cap_keys[band] = key;
					cap_open[band] = false;
				}
			});

			for (let it in ssids) {
				if (it.key == "") {
					if (req.args.unified && common != "")
						it.key = common;
					else if ((cap_keys[it.band] ?? "") != "")
						it.key = cap_keys[it.band];
					it.open = (it.key == "" && cap_open[it.band] === true);
				}
				else {
					it.open = false;
				}
			}

			// 漫游组记录里的 SSID 跟随改名（两频段同名时按频段逐条映射）
			let pairs = [];
			for (let it in wifi_summary().ifaces) {
				for (let s in ssids)
					if (s.band == it.band) push(pairs, { old: it.ssid, new: s.ssid });
			}
			roam_rename_ssids(pairs);

			let lr = apply_wifi_local(ssids);
			// 本机落盘后的签名：SAP 应用完成并上报同一签名后不再重复下发
			let wsig = wifi_sig_local();

			let results = [ { ap: state.self.mac, name: state.self.name,
			                 ok: lr.ok, error: lr.ok ? null : "no_ap_iface" } ];
			for (let mn, p in state.peers) {
				if (!p.authed) continue;
				push(results, { ap: p.mac ?? maccolon(mn),
				                name: p.info?.name ?? p.name ?? mn,
				                ok: null, error: "pending" });
				push_wifi_to(mn, ssids, wsig);
			}
			state.last_wifi = { ts: time(), results: results };
			return { ok: lr.ok, results: results };
		},
	},
	// 访客网络：读取本机配置（SAP 上也返回本机值）
	get_guest: {
		args: { ubus_rpc_session: "" },
		call: function(req) { return guest_summary(); },
	},
	// 保存访客网络：主AP 生效后同步到所有已配对 AP
	set_guest: {
		args: {
			ubus_rpc_session: "", enabled: false, ssid: "", key: "",
			bandwidth: 0, schedule: false, start: "", end: "",
			allow_lan: false, open: false,
		},
		call: function(req) {
			if (state.cfg.role != "cap")
				return { ok: false, error: "not_cap" };
			let a = req.args;
			let prev = guest_cfg();
			let enabled = a.enabled ? true : false;
			let ssid = trim(a.ssid ?? "");
			let key = a.key ?? "";
			// 开放网络（无密码）：显式标记，避免和「留空沿用旧密码」混淆
			let open_net = a.open ? true : false;

			if (open_net)
				key = "";
			else if (key == "")
				key = prev.key;

			/* 关闭访客网络时忽略密码框残留值，沿用原来的有效密码 */
			if (!enabled) {
				key = prev.key ?? "";
				if (key != "" && (length(key) < 8 || length(key) > 64))
					key = "";
			}

			if (enabled) {
				if (length(ssid) < 1 || length(ssid) > 32)
					return { ok: false, error: "ssid_invalid" };
				if (!open_net) {
					// 密码留空沿用旧密码，密码框只改名称时不必重输
					if (key == "") return { ok: false, error: "key_invalid" };
					if (length(key) < 8 || length(key) > 64)
						return { ok: false, error: "key_invalid" };
				}
			}
			if (key != "" && (length(key) < 8 || length(key) > 64))
				return { ok: false, error: "key_invalid" };

			let start = trim(a.start ?? prev.start);
			let end = trim(a.end ?? prev.end);
			if (hhmm_minutes(start) == null || hhmm_minutes(end) == null)
				return { ok: false, error: "time_invalid" };

			let bandwidth = int(a.bandwidth ?? 0);
			if (bandwidth < 0) bandwidth = 0;
			if (bandwidth > 1000) bandwidth = 1000;

			let cfg = {
				enabled: enabled,
				ssid: ssid != "" ? ssid : prev.ssid,
				key: key,
				bandwidth: bandwidth,
				schedule: a.schedule ? true : false,
				start: start, end: end,
				allow_lan: a.allow_lan ? true : false,
				ver: prev.ver + 1,
			};

			if (!guest_save_local(cfg))
				return { ok: false, error: "invalid" };

			let results = [ { ap: state.self.mac, name: state.self.name,
			                 ok: null, error: "pending" } ];
			for (let mn, p in state.peers) {
				if (!p.authed) continue;
				p.guest_pushing = false;   // 新配置优先，取消旧配置的等待
				push(results, { ap: p.mac ?? maccolon(mn),
				                name: p.info?.name ?? p.name ?? mn,
				                ok: null, error: "pending" });
				push_guest_to(mn, cfg);
			}
			state.last_guest = { ts: time(), ver: cfg.ver, results: results };

			/* 本机网络/无线重载完成后更新本机结果；成员 AP 由 push 回执更新 */
			apply_guest_local(guest_cfg(), function(r) {
				apply_guest_result_update(macnorm(state.self.mac), r.ok, r.error);
			});
			return { ok: true, results: results };
		},
	},
	set_backhaul: {
		args: {
			ubus_rpc_session: "", enabled: false,
			ssid: "", key: "", device: "",
		},
		call: function(req) {
			let a = req.args;
			if (state.cfg.role != "cap")
				return { ok: false, error: "not_cap" };
			let prev = current_backhaul_cfg();
			let ssid = (a.ssid ?? "") != "" ? a.ssid : BACKHAUL_DEFAULT_SSID;
			let key = a.key ?? "";
			if (key == "" && a.enabled)
				key = prev.key != "" ? prev.key : randhex(16);
			let ver = (prev.config_ver ?? 0) + 1;

			let cur = uci.cursor();
			cur.load("wifiroam");
			cur.set("wifiroam", "backhaul", "enabled", a.enabled ? "1" : "0");
			cur.set("wifiroam", "backhaul", "ssid", ssid);
			cur.set("wifiroam", "backhaul", "key", key);
			cur.set("wifiroam", "backhaul", "device", a.device ?? "");
			cur.set("wifiroam", "backhaul", "config_ver", "" + ver);
			cur.commit("wifiroam");

			let bh = current_backhaul_cfg();
			let results = [];
			let lr = apply_backhaul_local(bh, "cap");
			push(results, { ap: state.self.mac, name: state.self.name,
			                ok: lr.ok, ver: lr.ver, error: lr.error ?? null });
			state.last_backhaul = { ts: time(), ver, results };
			for (let mn, p in state.peers) {
				if (!p.authed) continue;
				push(results, { ap: p.mac ?? maccolon(mn),
				                name: p.info?.name ?? p.name ?? mn,
				                ok: null, error: "pending" });
				push_backhaul_to(mn);
			}
			return { ok: true, ver, results, ts: state.last_backhaul.ts, backhaul: bh };
		},
	},
	discover: {
		args: { ubus_rpc_session: "" },
		call: function(req) {
			let out = [];
			for (let mn, d in state.discovered)
				push(out, {
					mac: d.mac, ip: d.ip, name: d.name,
					model: d.model, last_seen: d.last_seen,
				});          // 不下发 nonce，配对所需凭据仅留在守护进程内
			return { devices: out };
		},
	},
	pair: {
		args: { ubus_rpc_session: "", mac: "" },
		call: function(req) {
			let mac = req.args.mac;
			if (!mac) return libubus.STATUS_INVALID_ARGUMENT;
			if (state.cfg.role != "cap")
				return { ok: false, error: "not_cap" };
			let mn = macnorm(mac);
			let d = state.discovered[mn];
			if (!d) return { ok: false, error: "not_found" };
			if (!d.ip) return { ok: false, error: "no_ip" };

			let addr = socket.sockaddr({ address: d.ip, port: TCP_PORT });
			let sock = socket.create(socket.AF_INET,
				socket.SOCK_STREAM | socket.SOCK_NONBLOCK, 0);
			if (!addr || !sock) return { ok: false, error: "socket" };
			sock.connect(addr);
			let done = false;
			let chan = null;
			/* 不能在 channel 回调里同步 disconnect 自身（会崩溃），
			   统一延迟到下一轮 uloop 再关闭 */
			let close_chan = function() {
				if (!chan) return;
				let c = chan;
				chan = null;
				uloop.timer(100, function() {
					try { c.disconnect(); } catch (e) {}
				});
			};
			chan = libubus.open_channel(sock,
				function(req2) {
					if (req2.type == "hello" && chan) {
						try {
							chan.defer({
								method: "join",
								data: {
									token: state.cfg.token,
									cap_ip: state.self.ip,
									cap_mac: state.self.mac,
									nonce_echo: d.nonce,
								},
								data_cb: function(m) {
									done = true;
									if (m?.ok) {
										/* 重新配对时清掉旧成员缓存，等 SAP 重新认证上报 */
										delete state.peers[mn];
										push_event("paired", d.mac, d.ip);
										delete state.discovered[mn];
									}
									close_chan();
								},
								cb: function(rc) {
									// 成功时 data_cb 已处理并断开；仅失败时兜底断开
									if (rc != 0) close_chan();
								},
							});
						} catch (e) {
							close_chan();
						}
					}
					return 0;
				},
				function() {});
			uloop.timer(8000, function() {
				if (!done) close_chan();
			});
			return { ok: true, ip: d.ip };
		},
	},
	unpair: {
		args: { ubus_rpc_session: "", mac: "" },
		call: function(req) {
			let mac = req.args.mac;
			if (!mac) return libubus.STATUS_INVALID_ARGUMENT;
			if (state.cfg.role != "cap")
				return { ok: false, error: "not_cap" };
			let mn = macnorm(mac);
			let p = state.peers[mn];
			if (!p) return { ok: false, error: "not_found" };
			if (p.authed && p.chan)
				try {
					p.chan.defer({
						method: "leave", data: {},
						data_cb: function() {}, cb: function() {},
					});
				} catch (e) {}
			delete state.peers[mn];
			push_event("unpaired", maccolon(mn), p.name ?? "");
			return { ok: true };
		},
	},
	roam_log: {
		args: { ubus_rpc_session: "", limit: 0 },
		call: function(req) {
			let limit = int(req.args.limit ?? 50);
			if (limit <= 0) limit = 50;
			if (limit > MAX_EVENTS) limit = MAX_EVENTS;
			let ev = state.events;
			if (length(ev) > limit)
				ev = slice(ev, length(ev) - limit);
			/* 名称按当前别名回填：拓扑里改名后，历史事件也显示新名称 */
			let out = [];
			for (let e in ev) {
				let item = {};
				for (let k, v in e)
					item[k] = v;
				let mac = e.mac ? macnorm(e.mac) : "";
				let al = mac ? state.aliases.map[mac] : null;
				if (al?.name != null && al.name != "")
					item.name = al.name;
				/* 漫游迁移详情里的来源/目标 AP 名称也按当前名称重算 */
				if (item.type == "roam_move" && item.from && item.to)
					item.info = sprintf("%s → %s", ap_display(item.from),
						ap_display(item.to));
				push(out, item);
			}
			return { events: out };
		},
	},
	/* 上网统计：每终端每日在线时长与总流量（仅主 AP 采集） */
	usage_stats: {
		args: { ubus_rpc_session: "" },
		call: function(req) {
			let u = state.cfg.role == "cap" ? state.usage : state.cap_usage;
			return {
				ok: !!u,
				day: (u?.day) || usage_day(),
				online: u?.online ?? {},
				ndata: u?.ndata ?? {},
				ndir: u?.ndir ?? {},
			};
		},
	},
	appctl_status: {
		args: { ubus_rpc_session: "" },
		call: function(req) {
			let apps = [];
			for (let a in APP_DEFS)
				push(apps, { id: a.id, name: a.name, cat: a.cat ?? "" });

			let devices = {};
			for (let mn, d in state.appctl.devices)
				devices[mn] = { name: d.name, block: d.block };

			return {
				ok: state.cfg.role == "cap",
				error: state.cfg.role == "cap" ? "" : "not_cap",
				enabled: state.appctl.enabled,
				enhanced: state.appctl.enhanced == true,
				strict: state.appctl.strict == true,
				day: state.appctl.day,
				apps, devices, stats: state.appctl.stats,
				online: state.appctl.online, ndata: state.appctl.ndata,
			};
		},
	},
	/* 硬件/软件 flow offload 状态：fw4 的 flowtable 一旦命中，后续数据包会绕过
	   netfilter 链，inet wifiroam forward 里的 counter 不再增长，应用统计与
	   访问控制都会受影响。这里读 fw4 的实际 forward 链判断是否真的生效。 */
	offload_status: {
		args: { ubus_rpc_session: "" },
		call: function(req) {
			let cur = uci.cursor();
			cur.load("firewall");
			let sw = cur.get("firewall", "@defaults[0]", "flow_offloading") == "1";
			let hw = cur.get("firewall", "@defaults[0]", "flow_offloading_hw") == "1";
			let live = fw4_forward_state();
			let guest = guest_cfg(), guest_guard = null;
			if (guest.enabled && guest.bandwidth > 0) {
				guest_guard = state.guest_fw4_error;
				if (!guest_guard)
					guest_guard = !live ? "pending" : !live.active ? "off" : live.guarded ? "protected" : "pending";
			}
			let managed = state.cfg.role == "sap";
			if (managed && state.cap_offload != null)
				sw = state.cap_offload;
			return { enabled: sw, hw, active: live?.active ?? false, managed, guest_guard };
		},
	},
	set_offload: {
		args: { ubus_rpc_session: "", enabled: false },
		call: function(req) {
			let on = req.args.enabled ? true : false;
			// 子 AP 的转发不在本机，开关由主 AP 统一控制，避免两端状态分叉
			if (state.cfg.role == "sap")
				return { ok: false, error: "cap_controlled" };
			if (!offload_apply(on))
				return { ok: false, error: "no_firewall_defaults" };
			let cur = uci.cursor();
			cur.load("wifiroam");
			cur.set("wifiroam", "core", "offload", on ? "1" : "0");
			cur.commit("wifiroam");
			for (let mn, p in state.peers)
				if (p.authed) push_offload_to(mn);
			return { ok: true, enabled: on };
		},
	},
	set_appctl: {
		// 调用方必须显式传 enhanced / strict（ubus 参数是白名单校验，
		// 未声明的参数会被拒）；strict 用字符串 '1'/'0' 表示，留空保持原值。
		args: { ubus_rpc_session: "", enabled: false, enhanced: false, strict: "" },
		call: function(req) {
			if (state.cfg.role != "cap")
				return { ok: false, error: "not_cap" };
			let on = req.args.enabled ? true : false;
			let cur = uci.cursor();
			cur.load("wifiroam");
			// 老配置里可能没有 appctl section，先按类型创建再写选项
			if (cur.get("wifiroam", "appctl") == null)
				cur.set("wifiroam", "appctl", "appctl");
			// enhanced 为必填调用参数（前端所有调用点都显式传当前值）
			let enh = req.args.enhanced ? true : false;
			let strict = state.appctl.strict == true;
			if (req.args.strict === "1") strict = true;
			else if (req.args.strict === "0") strict = false;
			cur.set("wifiroam", "appctl", "enabled", on ? "1" : "0");
			cur.set("wifiroam", "appctl", "enhanced", enh ? "1" : "0");
			cur.set("wifiroam", "appctl", "strict", strict ? "1" : "0");
			cur.commit("wifiroam");
			state.appctl.enabled = on;
			state.appctl.enhanced = enh;
			state.appctl.strict = strict;
			appctl_apply();
			return { ok: true, enabled: on, enhanced: enh, strict };
		},
	},
	set_app_policy: {
		args: { ubus_rpc_session: "", mac: "", app: "", action: "" },
		call: function(req) {
			if (state.cfg.role != "cap")
				return { ok: false, error: "not_cap" };
			let a = req.args;
			let mn = macnorm(a.mac ?? "");
			if (length(mn) != 12 || !appctl_app(a.app ?? ""))
				return { ok: false, error: "invalid_args" };
			if (!state.appctl.enabled)
				return { ok: false, error: "disabled" };
			if (index([ "block", "allow" ], a.action ?? "") < 0)
				return { ok: false, error: "invalid_action" };

			let devs = appctl_read_devices();
			let blocks = [];
			for (let b in (devs[mn]?.block ?? []))
				push(blocks, b);
			let i = index(blocks, a.app);
			if (a.action == "block" && i < 0) push(blocks, a.app);
			if (a.action == "allow" && i >= 0) splice(blocks, i, 1);

			let name = devs[mn]?.name ?? "";
			if (name == "")
				name = find_client(mn)?.node?.name ?? "";
			appctl_write_device(mn, blocks, name);
			appctl_read_devices();
			appctl_apply_rules();
			appctl_dpi_daemon("reload");
			return { ok: true, mac: mn, app: a.app, action: a.action, block: blocks };
		},
	},
};

// ------------------------------------------------------- RSSI steering (11v)
// 信号低于阈值时优先发强制 BTM（带候选）；连续 3 次仍不迁移则断开终端，
// 让它重新扫描选 AP。候选 BSS 来自 steer_bss_all()；没有候选时绝不踢。
function steer_neighbors(c, all, owner_mn) {
	let band = channel_band_key(c.band);
	let self_mn = owner_mn ?? macnorm(state.self.mac);
	let same = [], cross = [];
	for (let b in all) {
		if (!b.bssid || int(b.channel ?? 0) <= 0) continue;
		if (b.ssid != c.ssid) continue;
		/* 只排除终端当前所在的 BSS；同一台 AP 的其它频段/SSID 仍可作为
		   候选（2.4G 弱信号可引导到本机 5G，不必跨到另一台 AP）。 */
		if (b.ap_mac == self_mn &&
		    (!b.ifname || !c.ifname || b.ifname == c.ifname)) continue;
		/* 同频段优先；没有同频段候选时允许跨频段（例如 2.4G 设备
		   只能看到另一台 AP 的 5G BSS，否则会完全没有候选可引导） */
		if (channel_band_key(b.band) == band) push(same, b);
		else push(cross, b);
	}
	let out = same.concat(cross);
	return slice(out, 0, 4);
}

/* 5GHz/6GHz 操作类（IEEE 802.11 全局操作类）：
   5GHz 20MHz 按信道段取 115/118/121/124/125，80/160MHz 统一 128/129；
   6GHz 20/40/80/160/320MHz 取 131/132/133/134/137。
   40MHz 因没有主/次信道方向信息，回退到 20MHz 操作类，避免生成
   “操作类与信道不匹配”的候选被终端丢弃。 */
function steer_op_class(band, htmode, channel) {
	let w = htmode ?? "";
	let ch = int(channel ?? 0);

	if (band == "6g")
		return index(w, "320") >= 0 ? 137
		   : index(w, "160") >= 0 ? 134
		   : index(w, "80") >= 0 ? 133
		   : index(w, "40") >= 0 ? 132 : 131;

	if (band == "5g") {
		if (index(w, "160") >= 0) return 129;
		if (index(w, "80") >= 0) return 128;
		if (ch >= 36 && ch <= 48) return 115;
		if (ch >= 52 && ch <= 64) return 118;
		if (ch >= 100 && ch <= 144) return 121;
		if (ch >= 149 && ch <= 165) return 124;
		if (ch >= 166 && ch <= 177) return 125;
		return 115;
	}

	if (band == "2g")
		return ch == 14 ? 82 : 81;

	return 81;
}

/* 手工构造 Neighbor Report 时的 BSSID Info（4 字节小端）：
   AP 可达 + 安全 + Key Scope + RRM + QoS，再按 HT/VHT/HE 能力补位。
   正常路径优先使用 hostapd own report（b.nr），这里只用于旧 AP 回退。 */
function steer_bssid_info(b) {
	let info = 3 | 4 | 8 | 128 | 32;
	let w = b.htmode ?? "";

	if (channel_band_key(b.band) != "2g") info |= 16;

	if (index(w, "HT") >= 0 || index(w, "VHT") >= 0 ||
	    index(w, "HE") >= 0 || index(w, "EHT") >= 0)
		info |= 2048 | 256;
	if (index(w, "VHT") >= 0 || index(w, "HE") >= 0 || index(w, "EHT") >= 0)
		info |= 4096;
	if (index(w, "HE") >= 0 || index(w, "EHT") >= 0)
		info |= 16384;

	return sprintf("%02x%02x%02x%02x",
		info & 0xff, (info >> 8) & 0xff, (info >> 16) & 0xff, (info >> 24) & 0xff);
}

function steer_neighbor_hex(b) {
	let ch = int(b.channel ?? 0);
	let bssid = macnorm(b.bssid ?? "");
	if (ch <= 0 || ch > 255 || length(bssid) != 12) return null;
	let op = steer_op_class(channel_band_key(b.band), b.htmode, ch);
	return bssid + steer_bssid_info(b) + sprintf("%02x%02x00", op, ch);
}

/* 校验对端上报的 nr：必须是合法十六进制、长度足够，且首 6 字节 BSSID
   与目标 BSS 一致；不合法时回退到本地手工拼接，避免 hostapd 因单条
   坏数据清空整个邻居库。 */
function valid_nr(nr, bmn) {
	if (type(nr) != "string") return false;
	nr = lc(nr);
	if (length(nr) < 26 || (length(nr) % 2)) return false;
	if (match(nr, /^[0-9a-f]+$/) == null) return false;
	if (length(bmn) == 12 && substr(nr, 0, 12) != bmn) return false;
	return true;
}

/* hostapd 的 neighbors 参数要求字符串数组，每项是 Neighbor Report
   元素体（不含 EID/长度）的十六进制。优先直接用 hostapd 的 own report
   （含正确的 BSSID Info 与宽带宽子元素）；旧 AP 没有 nr 时再手工拼。 */
function steer_btm_neighbors(list) {
	let out = [];
	for (let b in list) {
		let bmn = macnorm(b.bssid ?? "");
		let nr = b.nr;
		if (!valid_nr(nr, bmn)) nr = steer_neighbor_hex(b);
		if (nr) push(out, nr);
	}
	return out;
}

function steer_btm(c, mn, imminent, timer, validity, neighbors) {
	let req = {
		addr: maccolon(mn),
		disassociation_imminent: imminent,
		disassociation_timer: timer,
		validity_period: validity,
	};
	if (length(neighbors)) req.neighbors = neighbors;
	try {
		let r = ubusc.call("hostapd." + c.ifname, "bss_transition_request", req);
		if (r == null && length(neighbors)) {
			/* 旧 hostapd 不接受 neighbors 时，只允许退回建议式 BTM；
			   强制式没有候选列表会把终端踢到空处，必须放弃。 */
			if (imminent) return false;
			delete req.neighbors;
			r = ubusc.call("hostapd." + c.ifname, "bss_transition_request", req);
		}
		return r != null;
	} catch (e) {
		log("steer btm " + mn + " failed");
		return false;
	}
}

/* 连续 BTM 无效后的兜底：断开终端，让它重新扫描并选择信号更好的 AP。
   必须已有候选（btm_neigh 非空），否则会把终端踢到空处。 */
function steer_kick(c, mn) {
	try {
		ubusc.call("hostapd." + c.ifname, "del_client", {
			addr: maccolon(mn), deauth: true, reason: 1, ban_time: 0,
		});
		return true;
	} catch (e) {
		log("steer kick " + mn + " failed");
		return false;
	}
}

function steer_tick_impl() {
	if (state.cfg.role == "unconfigured") return;
	let roam = current_roam_cfg();
	if (!roam.enabled || !roam.v_bss_transition) return;
	let threshold = roam.rssi_threshold;
	if (threshold == null || threshold >= 0) return;
	/* ssids 为空时视为对所有非访客 SSID 生效；非空时只处理用户勾选的 SSID */

	let has_peer = false;
	for (let mn, p in state.peers)
		if (p.authed) { has_peer = true; break; }
	if (!has_peer) return;   // 单 AP 无处分流，引导只会让终端掉线

	let now = time();
	let clients = wifi_clients();
	let all = steer_bss_all();
	let seen = {};
	let critical_at = threshold - STEER_CRITICAL_DROP;

	for (let mn, c in clients) {
		seen[mn] = true;
		if (c.type != "wifi" || !c.ifname || c.guest ||
		    c.ssid == null ||
		    (length(roam.ssids) && index(roam.ssids, c.ssid) < 0) ||
		    c.rssi == null) {
			delete state.steer_low[mn];
			delete state.steer_stage[mn];
			delete state.steer_tries[mn];
			continue;
		}

		let rssi = int(c.rssi);
		if (rssi >= threshold) {
			delete state.steer_low[mn];
			delete state.steer_stage[mn];
			delete state.steer_tries[mn];
			continue;
		}
		if (c.connected_time != null && int(c.connected_time) < MIN_STEER_ASSOC) {
			delete state.steer_low[mn];
			delete state.steer_stage[mn];
			delete state.steer_tries[mn];
			continue;
		}

		let low = (state.steer_low[mn] ?? 0) + 1;
		state.steer_low[mn] = low;
		let critical = rssi <= critical_at;
		let last = state.steer_last[mn] ?? 0;
		let since = now - last;
		let tries = state.steer_tries[mn] ?? 0;
		let btm_neigh = steer_btm_neighbors(steer_neighbors(c, all));
		let force = (roam.rssi_profile == "aggressive") || critical ||
		            rssi <= threshold - 3;

		if (low < (critical ? STEER_CRITICAL_CONFIRM : STEER_CONFIRM))
			continue;
		if (since < STEER_COOLDOWN)
			continue;

		/* 连续多次 BTM 都没效果：断开终端，让它重新扫描并选更好的 AP。
		   没有候选时绝不踢，避免把终端踢到空处。 */
		if (tries >= STEER_KICK_AFTER) {
			if ((state.steer_mute[mn] ?? 0) > now || !length(btm_neigh))
				continue;
			if (steer_kick(c, mn)) {
				state.kick_last[mn] = now;
				state.steer_mute[mn] = now + STEER_KICK_COOLDOWN;
				state.steer_tries[mn] = 0;
				state.steer_last[mn] = now;
				state.steer_stage[mn] = 0;
				push_event("roam_kick", maccolon(mn),
					sprintf("rssi=%d < %d cand=%d", rssi, threshold,
						length(btm_neigh)),
					client_name_of(mn, clients));
			}
			continue;
		}

		/* 积极模式 / 临界信号直接发强制 BTM（带候选），
		   其它模式先用建议式，避免普通终端被频繁打断。 */
		let imminent = force && length(btm_neigh) > 0;
		let timer = imminent ? STEER_FORCE_TIMER : 0;
		if (steer_btm(c, mn, imminent, timer, STEER_VALIDITY, btm_neigh)) {
			state.steer_last[mn] = now;
			state.steer_stage[mn] = imminent ? 2 : 1;
			state.steer_tries[mn] = tries + 1;
			push_event("roam_steer", maccolon(mn),
				sprintf("rssi=%d < %d %s cand=%d", rssi, threshold,
					imminent ? "forced" : "advisory", length(btm_neigh)),
				client_name_of(mn, clients));
		}
	}

	for (let mn in keys(state.steer_low))
		if (!seen[mn]) {
			delete state.steer_low[mn];
			delete state.steer_stage[mn];
			delete state.steer_last[mn];
			delete state.steer_tries[mn];
		}

	/* 静默期过期的记录清掉，避免长期运行后 map 无限增长 */
	for (let mn in keys(state.steer_mute))
		if (state.steer_mute[mn] <= now)
			delete state.steer_mute[mn];
}

function steer_tick() {
	try {
		steer_tick_impl();
	} catch (e) {
		log("steer_tick failed: " + e);
	}
}

// 把全网络邻居报告下发给本机每个 hostapd BSS，802.11k 才会真正返回邻居。
// 每台 AP 只同步与自身 SSID 相同、且不是自己的 BSS；hostapd 会保留 own report。
rrm_sync_local = function() {
	if (state.cfg.role == "unconfigured") return 0;
	let roam = current_roam_cfg();
	if (!roam.enabled || !roam.k_neighbor) return 0;

	let all = steer_bss_all();
	let ws = ubusc.call("network.wireless", "status") ?? {};
	let synced = 0;

	for (let rname, r in ws) {
		for (let ifc in r.interfaces ?? []) {
			if (ifc.config?.mode && ifc.config.mode != "ap") continue;
			if (ifc.config?.disabled == "1") continue;
			if (ifc.config?.rrm_neighbor_report != "1") continue;
			if (!ifc.ifname) continue;

			let ssid = ifc.config?.ssid ?? "";
			let own_mac = macnorm(trim(fs.readfile(
				`/sys/class/net/${ifc.ifname}/address`) ?? ""));
			let list = [];

			for (let b in all) {
				if ((b.ssid ?? "") != ssid) continue;
				let bmn = macnorm(b.bssid ?? "");
				if (length(bmn) != 12 || bmn == own_mac) continue;

				let nr = b.nr;
				if (!valid_nr(nr, bmn)) nr = steer_neighbor_hex(b);
				if (!nr) continue;

				push(list, [ maccolon(bmn), ssid, nr ]);
			}

			/* 空列表也要下发：hostapd 会清掉已离线 AP 的旧邻居条目 */
			ubusc.call("hostapd." + ifc.ifname, "rrm_nr_set", { list });
			synced++;
		}
	}
	return synced;
};

rrm_sync_tick = function() {
	try {
		rrm_sync_local();
	} catch (e) {
		log("rrm sync failed: " + e);
	}
};

// ---------------------------------------------------------------- lifecycle
ensure_token = function() {
	if (state.cfg.role == "cap" && state.cfg.token == "") {
		state.cfg.token = sha256(sprintf("wifiroam-%d-%d-%s",
			time(), rand(), state.self.mac));
		save_config();
		log("generated new network token");
	}
};

reconfigure = function() {
	load_config();
	if (state.cfg.role == "sap")
		enable_relay_ap_mode();
	state.self.name = state.cfg.name != "" ? state.cfg.name : state.self.hostname;
	sap_disconnect();
	close_all_conns();
	state.peers = {};
	state.cap_learned = null;
	state.cap_lost_since = null;
	state.prev_clients = null;
	state.wired_seen = {};
	state.prev_owner = null;
	state.steer_last = {};
	state.steer_low = {};
	state.steer_stage = {};
	state.steer_tries = {};
	state.steer_mute = {};
	state.kick_last = {};
	state.bss_list = null;
	state._bss_cache = null;
	state._bss_sig = "";
	state._own_nr = {};
	acl_apply();
	send_hello();
};

// 插件启用后按默认设置开启漫游：首次启动（从未保存过漫游配置）时，
// 自动选中本机全部主网络 SSID，并按默认 k/v/r 参数下发一次。
// 注意：ucode 的函数声明不做提升，本函数必须定义在 wifi_ifaces /
// member_list / apply_roam_local / applied_kvr 之后。
roam_default_init = function() {
	if (state.cfg.role != "cap") return;
	let cur = uci.cursor();
	cur.load("wifiroam");
	if (int(cur.get("wifiroam", "roam", "config_ver") ?? "0") != 0) return;
	if (cur.get("wifiroam", "roam", "enabled") != "1") return;

	let raw = cur.get("wifiroam", "roam", "ssids");
	if (type(raw) == "array" ? length(raw) > 0 : (raw ?? "") != "") return;

	let ssids = [];
	for (let w in wifi_ifaces())
		if (w.ssid != "" && index(ssids, w.ssid) < 0)
			push(ssids, w.ssid);
	if (!length(ssids)) return;

	cur.set("wifiroam", "roam", "ssids", ssids);
	cur.set("wifiroam", "roam", "config_ver", "1");
	cur.commit("wifiroam");

	let roam = current_roam_cfg();
	apply_roam_local(roam, member_list());
	state.last_apply = {
		ts: time(), ver: roam.config_ver,
		results: [ { ap: state.self.mac, name: state.self.name,
		             ok: true, ver: roam.config_ver,
		             kvr: applied_kvr(roam) } ],
	};
	log(sprintf("roam defaults enabled for %d SSID(s)", length(ssids)));
};

function main() {
	srand(time());
	uloop.init();

	ubusc = libubus.connect(null, 60);
	if (!ubusc) {
		log("ubus connect failed");
		exit(1);
	}

	load_config();
	/* 重启后本机访客配置已由 netifd/无线恢复，视为已应用 */
	state.guest_ver_applied = guest_cfg().ver;
	if (state.cfg.role == "sap")
		enable_relay_ap_mode();
	alias_load();
	devices_load();
	usage_load();
	acl_load();
	ban_load();
	detect_self();
	ensure_token();
	// 首次启用插件：按默认设置开启漫游（自动选中本机 SSID）
	roam_default_init();

	setup_udp();
	setup_tcp();
	ubusc.publish("wifiroam", api_obj);

	/* 先让 ubus/状态接口可用，再把耗时的防火墙同步放到事件循环，
	   缩短服务启动、重启以及首页读取状态时的等待 */
	uloop.timer(50, function() {
		offload_default_init();
		if (state.cfg.role != "unconfigured")
			guest_fw4_sync(null, false);
		// 建规则要用到本机接口/网桥信息，必须放在 detect_self 之后
		appctl_load();
		acl_apply();
	});
	/* 启动后尽快下发一次 11k 邻居库，之后按 RRM_SYNC_INTERVAL 周期同步 */
	uloop.timer(8000, rrm_sync_tick);

	uloop.interval(HELLO_INTERVAL, send_hello);
	uloop.interval(TICK_INTERVAL, sap_tick);
	uloop.interval(TICK_INTERVAL, sap_report);
	uloop.interval(TICK_INTERVAL, expire_tick);
	uloop.interval(10000, conn_cleanup);
	/* 有线/环路检测需要更快响应：2s 一次，其余巡检仍用 TICK_INTERVAL */
	uloop.interval(2000, backhaul_tick);
	uloop.interval(STEER_TICK, steer_tick);
	uloop.interval(TICK_INTERVAL, devices_tick);
	uloop.interval(TICK_INTERVAL, pin_tick);
	uloop.interval(TICK_INTERVAL, ban_tick);
	uloop.interval(RRM_SYNC_INTERVAL, rrm_sync_tick);
	uloop.interval(TICK_INTERVAL, guest_tick);
	uloop.interval(USAGE_TICK, usage_tick);
	uloop.interval(TICK_INTERVAL, appctl_tick);
	uloop.interval(TICK_INTERVAL, function() {
		if (state.cfg.role != "cap") return;
		let cur = local_clients_cached();
		if (state.prev_clients != null)
			diff_events(state.prev_clients, cur, state.self.name);
		state.prev_clients = cur;
		owner_events(cur);
	});

	send_hello();
	log(sprintf("started role=%s", state.cfg.role));
	uloop.run();
}

if (ARGV[0] == "--restore-guest-fw4")
	exit(guest_fw4_sync({ enabled: false }, false) ? 0 : 1);
main();
