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
const HELLO_INTERVAL = 5000;
const TICK_INTERVAL = 10000;
const MAX_EVENTS = 100;
const WIRED_TTL = 300;    // s wired client stays listed after last FDB sighting
const STEER_COOLDOWN = 30;  // s 同一终端两次 BSS Transition 引导的最小间隔
const MIN_STEER_ASSOC = 20; // s 终端入网后至少稳定这么久才允许被引导
const STEER_CONFIRM = 2;    // 连续低于阈值的采样次数（steer_tick 每 5s）
const STEER_CRITICAL_DROP = 8;    // 低于阈值多少 dBm 视为临界
const STEER_CRITICAL_CONFIRM = 3; // 临界信号需要连续采样次数
const STEER_CRITICAL_DELAY = 15;  // 建议式 BTM 后多久仍未改善才强制
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
const GUEST_SNAT = "wifiroam_guest_snat";
const GUEST_IP = "172.16.10.1";
const GUEST_NET = "172.16.10.0/24";
const GUEST_DEFAULT_SSID = "Guest";
const GUEST_SEC_PREFIX = "wifiroam_guest_";
const GUEST_NFT_TABLE = "wifiroam_guest";
const GUEST_TC_HANDLE = "57:";
const FW4_TEMPLATE = "/usr/share/firewall4/templates/ruleset.uc";
// OpenWrt 25.12.6, firewall4 2025.03.17~b6e51575-r2（官方 x86/64 与 Cortex-A53 模板一致）。
const FW4_TEMPLATE_SHA256 = "3c67659a861500b4bcc3fbc058790c7b40adf5ff861ff9c87584813fb325805b";
const FW4_FLOW_RULE = "meta l4proto { tcp, udp } flow offload @ft;";
const FW4_GUEST_FLOW_RULE = `iifname != "${GUEST_BRIDGE}" oifname != "${GUEST_BRIDGE}" ` + FW4_FLOW_RULE;
// 协议/行为版本：LuCI 侧要求一致，不一致时「重启」会自动 stop+start 修复
const DAEMON_VERSION = 20;

const ROAM_FT_KEYS = [
	"ieee80211r", "mobility_domain", "ft_over_ds", "ft_psk_generate_local",
	"nas_identifier", "pmk_r1_push", "r0kh", "r1kh", "reassociation_deadline",
];
const ROAM_KEYS = [
	...ROAM_FT_KEYS, "ieee80211k", "rrm_neighbor_report", "rrm_beacon_report",
	"ieee80211v", "bss_transition",
];

// ------------------------------------------------------------------ globals
let daemon_started = time();  // 进程启动时刻，用于识别「重启后仍是旧进程」
let ubusc;              // ubus connection
let udp_sock;           // discovery socket
let tcp_srv;            // sync listen socket

// 前向声明：ucode 单遍编译不提升函数声明，使用点必须晚于绑定点
let sap_report, push_aliases_to, push_roam_to, push_backhaul_to, push_offload_to, push_wifi_to, push_guest_to, push_channel_to, apply_result_update, apply_backhaul_result_update, apply_wifi_result_update, apply_guest_result_update, ensure_token, reconfigure, conn_close;
// 访客网络：前向声明后置赋值函数（ucode 不提升函数声明）
let guest_after_reload, apply_guest_local, guest_save_local, guest_tick;
let write_roam_iface, guest_fw4_sync;

let state = {
	cfg: {},            // uci wifiroam
	self: {},           // self system info
	brdev: "br-lan",
	peers: {},          // macnorm -> AP peer (hello + report merged)
	discovered: {},     // macnorm -> unconfigured device seen
	aliases: { ver: 0, map: {} },
	link: null,         // SAP: outgoing channel to CAP {sock,chan,authed}
	cap_learned: null,  // CAP ip learned from hello
	events: [],         // ring buffer
	last_apply: null,   // last roam push result summary
	last_backhaul: null, // last wireless-backhaul push result summary
	last_wifi: null,    // last Wi-Fi rename push result summary
	last_guest: null,   // last guest-network push result summary
	cap_offload: null,  // SAP: last flow offload state pushed by CAP
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
	steer_last: {},     // macnorm -> 上次 BSS Transition 引导时间
	steer_low: {},      // macnorm -> 连续低于阈值的采样次数
	steer_stage: {},    // macnorm -> 0/1/2（建议/强制阶段）
	bss_list: null,     // SAP: CAP 下发的全网络 BSS 列表
	_bss_cache: null,   // CAP: 全网络 BSS 列表缓存
	channel_ver: 0,     // 信道计划版本：变化后重新下发给各 SAP
	channel_plan: null, // 最近一次信道计划
	net_names: {},      // SAP: CAP 下发的 macnorm -> { hostname, ip }（SAP 无 DHCP，名称需由 CAP 提供）
	roster: null,       // SAP: CAP 下发的全网络 AP/SSID 概览（用于开启前检查一致展示）
	usage: { day: "", online: {}, ndata: {} }, // CAP: 每终端每日在线秒数 / 总流量
	_usage_snap: null,  // CAP: 上次 nft counter 快照 { mac: bytes }
	_usage_station_snap: null, // CAP: 上次站点计数快照 { mac: { rx, tx } }
	_usage_ts: 0,
	_usage_online_ts: 0,
	_usage_dirty: false,
	_usage_saved: 0,
	_usage_track: null,
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

function push_event(type, mac, info, name) {
	push(state.events, { ts: time(), type, mac: mac ?? "", name: name ?? "", info: info ?? "" });
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
		name: cur.get("wifiroam", "core", "name") ?? "",
	};
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

function alias_apply(mac, name, icon, note) {
	let mn = macnorm(mac);
	if (length(mn) != 12) return false;
	if ((name ?? "") == "" && !icon && !note)
		delete state.aliases.map[mn];
	else
		state.aliases.map[mn] = {
			name: name ?? "", icon: icon ?? null, note: note ?? null,
		};
	state.aliases.ver = time();
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
		         bssid: wl.bssid, rssi: wl.rssi };
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

// ------------------------------------------------------- channel planning
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
			            ssid: ifc.config?.ssid ?? "" });
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

function channel_aps() {
	let self_radios = channel_radios();
	let bh = current_backhaul_cfg();
	let self_bh = "";
	if (bh.enabled)
		for (let r in self_radios) {
			let hit = (bh.device && bh.device == r.device);
			if (!hit)
				for (let b in (r.bss ?? []))
					if (b.ssid == bh.ssid) { hit = true; break; }
			if (hit) { self_bh = r.device; break; }
		}

	let aps = [ {
		id: macnorm(state.self.mac),
		name: state.self.name || state.self.hostname || maccolon(state.self.mac),
		self: true, wireless: false, backhaul_device: self_bh,
		role: state.cfg.role, radios: self_radios,
	} ];
	for (let mn, p in state.peers) {
		if (!p.authed) continue;
		push(aps, {
			id: mn, name: p.info?.name ?? p.name ?? maccolon(mn),
			self: false, wireless: p.info?.uplink?.type == "wireless",
			wireless_band: channel_band_key(p.info?.uplink?.band),
			backhaul_device: p.info?.uplink?.device ?? "",
			role: p.info?.role ?? "sap",
			radios: p.info?.channels ?? [],
		});
	}
	return aps;
}

function channel_cochannel(aps) {
	let buckets = {};
	for (let a in aps) {
		for (let r in (a.radios ?? [])) {
			let band = channel_band_key(r.band);
			if (band != "2g" && band != "5g") continue;
			let ch = int(r.current ?? 0);
			if (ch <= 0) ch = channel_num(r.channel);
			if (ch <= 0) continue;
			let key = band + ":" + ch;
			let b = buckets[key];
			if (!b) { b = { band, channel: ch, aps: [], wireless: false, all160: true }; buckets[key] = b; }
			if (a.backhaul_device && a.backhaul_device == r.device) b.wireless = true;
			if (index(r.htmode ?? "", "160") < 0) b.all160 = false;
			let label = a.name + (r.device ? " · " + r.device : "");
			if (index(b.aps, label) < 0) push(b.aps, label);
		}
	}
	let items = [];
	for (let k, b in buckets)
		if (length(b.aps) > 1 && !b.wireless && !b.all160) push(items, b);
	return { any: length(items) > 0, items };
}

function channel_cfg() {
	let cur = uci.cursor();
	cur.load("wifiroam");
	let hour = int(cur.get("wifiroam", "channel", "hour") ?? "4");
	if (hour < 0 || hour > 23) hour = 4;
	return {
		enabled: cur.get("wifiroam", "channel", "enabled") == "1",
		band2g: cur.get("wifiroam", "channel", "band2g") != "0",
		band5g: cur.get("wifiroam", "channel", "band5g") != "0",
		hour,
		last: cur.get("wifiroam", "channel", "last") ?? "",
	};
}

function channel_block_80(ch) {
	ch = int(ch);
	if (ch >= 36 && ch <= 48) return 36;
	if (ch >= 52 && ch <= 64) return 52;
	if (ch >= 100 && ch <= 112) return 100;
	if (ch >= 116 && ch <= 128) return 116;
	if (ch >= 149 && ch <= 161) return 149;
	return ch;
}

/* 给所有 AP 生成信道计划：2.4G 只在 1/6/11 中选，5G 优先不重叠的
   80MHz 块；已有信道有粘性，只有冲突时才调整。 */
function channel_make_plan(aps, settings) {
	let plan = [];
	let bands = [];
	if (settings.band2g !== false) push(bands, "2g");
	if (settings.band5g !== false) push(bands, "5g");

	let self_mn = macnorm(state.self.mac);
	let self_ap = null;
	for (let a in aps)
		if (a.self) { self_ap = a; break; }
	let cap_bh = {};
	if (self_ap?.backhaul_device)
		for (let r in (self_ap.radios ?? []))
			if (r.device == self_ap.backhaul_device)
				cap_bh[channel_band_key(r.band)] = int(r.current ?? r.channel ?? 0);

	for (let band in bands) {
		let entries = [];
		for (let a in aps) {
			for (let r in (a.radios ?? [])) {
				if (channel_band_key(r.band) != band) continue;
				let current = int(r.current ?? 0);
				if (current <= 0) current = channel_num(r.channel);
				push(entries, {
					ap: a.id, name: a.name, band,
					device: r.device ?? "",
					current, htmode: r.htmode ?? "",
					auto: channel_num(r.channel) <= 0,
					wide160: index(r.htmode ?? "", "160") >= 0,
					backhaul: !!(a.backhaul_device && a.backhaul_device == r.device),
				});
			}
		}

		if (length(entries) < 2) {
			for (let e in entries) {
				let to = e.current;
				if (to <= 0) to = (band == "2g") ? 1 : 36;
				if (e.backhaul && e.ap != self_mn && cap_bh[band])
					to = cap_bh[band];
				push(plan, { ap: e.ap, name: e.name, band, device: e.device,
				             backhaul: e.backhaul, from: e.auto ? 0 : e.current, to,
				             width: e.htmode ?? "",
				             wide160: index(e.htmode ?? "", "160") >= 0,
				             changed: to != e.current || !!e.auto });
			}
			continue;
		}

		let used = {};
		/* 主 AP 回程射频占用自己的信道，其它射频避免与之同频 */
		if (cap_bh[band]) used[cap_bh[band]] = 1;

		/* 5G 达到 3 个射频时，80MHz 射频用 36/149/52（52 为 DFS）
		   错开；160MHz 射频始终保留 36，同频属于正常。 */
		let multi5 = false;
		if (band == "5g") {
			let n5 = 0;
			for (let e in entries)
				if (!e.backhaul) n5++;
			multi5 = n5 >= 3;
		}

		/* 160MHz 射频优先占用 36，80MHz 射频随后避开 */
		let ordered = [];
		for (let e in entries)
			if (e.wide160 && !e.backhaul) push(ordered, e);
		for (let e in entries)
			if (!(e.wide160 && !e.backhaul)) push(ordered, e);

		for (let e in ordered) {
			/* 回程射频必须跟随主 AP，否则无线回程 STA 会断 */
			if (e.backhaul) {
				let to = (e.ap == self_mn) ? e.current
				         : (cap_bh[band] || e.current);
				if (to <= 0) to = cap_bh[band] || ((band == "2g") ? 1 : 36);
				push(plan, { ap: e.ap, name: e.name, band, device: e.device,
				             backhaul: true, from: e.auto ? 0 : e.current, to,
				             width: e.htmode ?? "",
				             wide160: index(e.htmode ?? "", "160") >= 0,
				             changed: to != e.current || !!e.auto });
				continue;
			}

			/* 160MHz 在非 DFS 频段只有 36 一个块，保留 160 就保持 36；
			   80MHz 在 2 个 5G 射频时用 36/149，3 个及以上时用
			   36/149/52（52 为 DFS）错开。 */
			let e160 = index(e.htmode ?? "", "160") >= 0;
			let e80 = e160 || index(e.htmode ?? "", "80") >= 0;
			let cands;
			if (band == "2g")
				cands = [1, 6, 11];
			else if (e160)
				cands = [36];
			else if (multi5)
				cands = [36, 149, 52];
			else if (e80)
				cands = [36, 149];
			else
				cands = [36, 44, 149, 157];

			let best = 0, best_score = 1000000;
			for (let i, ch in cands) {
				let score = (used[ch] ?? 0) * 1000;
				if (band == "5g") {
					let blk = channel_block_80(ch);
					for (let u in used)
						if (channel_block_80(int(u)) == blk) score += 500;
				}
				if (ch == e.current) score -= 30;
				score += i;
				if (score < best_score) { best_score = score; best = ch; }
			}
			if (!best) continue;
			used[best] = (used[best] ?? 0) + 1;
			push(plan, { ap: e.ap, name: e.name, band, device: e.device,
			             backhaul: false, from: e.auto ? 0 : e.current, to: best,
			             width: e.htmode ?? "",
			             wide160: e160,
			             changed: best != e.current || !!e.auto });
		}
	}
	return plan;
}

// 只改信道/带宽，不动加密；按射频（device）精确落盘，支持三频设备
function channel_apply_local(targets) {
	let cur = uci.cursor();
	cur.load("wireless");
	let n = 0;
	let dfs = false;

	let radios = channel_radios();
	let current = {}, current_ht = {};
	for (let r in radios) {
		current[r.device] = int(r.current ?? 0);
		current_ht[r.device] = r.htmode ?? "";
	}

	for (let t in targets) {
		let band = channel_band_key(t.band);
		let ch = "" + int(t.channel);
		let dev = t.device ?? "";
		let ht = t.htmode ?? "";
		let target = "";

		if (dev && current[dev] != null)
			target = dev;
		if (!target) {
			/* 旧版对端只给 band：只有一个射频时直接匹配，否则用 from 区分 */
			let cands = [];
			for (let r in radios)
				if (channel_band_key(r.band) == band) push(cands, r);
			if (length(cands) == 1)
				target = cands[0].device;
			else {
				for (let r in cands)
					if (int(r.current ?? 0) == int(t.from ?? -1)) {
						target = r.device; break;
					}
			}
		}
		if (!target) continue;

		let found = false;
		cur.foreach("wireless", "wifi-device", function(d) {
			if (d[".name"] != target) return;
			if (channel_band_key(d.band ?? d.hwmode) != band) return;
			found = true;
			let ch_changed = (d.channel ?? "") != ch;
			let ht_changed = !!ht && (d.htmode ?? "") != ht;
			if (ch_changed) {
				cur.set("wireless", target, "channel", ch);
				n++;
				if (band == "5g" && int(ch) >= 52 && int(ch) <= 144)
					dfs = true;
			}
			if (ht_changed) {
				cur.set("wireless", target, "htmode", ht);
				n++;
			}
		});
		if (!found) log("channel: radio " + target + " not found for " + band);
	}

	if (n > 0) {
		cur.commit("wireless");
		uloop.timer(1000, function() {
			uloop.process("/sbin/wifi", [ "reload" ], null, function(res) {
				log("channel wifi reload rc=" + res);
			});
		});
	}
	return { ok: true, count: n, dfs };
}

push_channel_to = function(mn) {
	let p = state.peers[mn];
	if (!p?.authed || !p.chan) return false;
	/* 旧版 SAP 不上报信道，跳过，避免反复重算计划 */
	if (!length(p.info?.channels ?? [])) {
		p.channel_ver = state.channel_ver ?? 0;
		return true;
	}

	let ver0 = state.channel_ver ?? 0;
	if (p.channel_ver == ver0 && state.channel_plan) return true;

	let plan = state.channel_plan;
	let has = false;
	if (plan)
		for (let it in plan)
			if (it.ap == mn) { has = true; break; }
	if (!plan || !has) {
		plan = channel_make_plan(channel_aps(), channel_cfg());
		state.channel_plan = plan;
		state.channel_ver = (state.channel_ver ?? 0) + 1;
	}

	let ver = state.channel_ver ?? 0;
	if (p.channel_ver == ver) return true;

	let targets = [];
	for (let it in plan)
		if (it.ap == mn)
			push(targets, { device: it.device ?? "", band: it.band,
			                from: it.from ?? 0, channel: it.to,
			                htmode: it.htmode ?? "" });
	if (!length(targets)) { p.channel_ver = ver; return true; }
	try {
		p.chan.defer({
			method: "push_channel_config",
			data: { radios: targets },
			data_cb: function(m) { if (!m?.ok) log("channel push rejected " + mn); },
			cb: function(rc) { if (rc != 0) log("channel push failed " + mn); },
		});
		p.channel_ver = ver;
	} catch (e) { return false; }
	return true;
};


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
			if (length(mn) != 12 || map[mn]) continue;
			map[mn] = {
				bssid: b.bssid, ssid: b.ssid ?? "",
				ifname: b.ifname ?? "", ap: ap ?? "", ap_mac: ap_mac ?? "",
				band: channel_band_key(r.band),
				channel: int(r.current ?? r.channel ?? 0),
				htmode: r.htmode ?? "",
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
		if (length(mn) == 12 && !map[mn]) map[mn] = b;
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
		if (want != null && want.key != "") {
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
	let supported = (protect || patched) && sha256(original) == FW4_TEMPLATE_SHA256 &&
	                length(split(original, FW4_FLOW_RULE)) == 2;
	if (protect && !patched && !match(fs.readfile("/etc/openwrt_release") ?? "", /(^|\n)DISTRIB_RELEASE='25\.12\.6'(\n|$)/))
		supported = false;
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
	                GUEST_FWD_WAN, GUEST_FWD_LAN, GUEST_SNAT ])
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
	guest_fw4_sync(cfg, true);
	guest_nft_apply(cfg);
	guest_tc_apply(cfg);
};

// 本机落地：先加载访客接口和防火墙，再重载无线，端口由 netifd 绑定。
apply_guest_local = function(cfg) {
	state.guest_open = guest_open_now(cfg);
	if (cfg.enabled && cfg.bandwidth > 0) guest_fw4_sync(cfg, false);
	guest_write_wireless(cfg);
	if (cfg.enabled)
		guest_write_infra(cfg);
	else
		guest_remove_infra();

	uloop.process("/etc/init.d/network", [ "reload" ], null, function() {
		guest_after_reload();
		uloop.process("/sbin/wifi", [ "reload" ], null, function(res) {
			log("guest wifi reload rc=" + res);
			guest_tc_apply(guest_cfg());
		});
	});
	return { ok: true };
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
	cur.commit("wifiroam");
	return true;
};

// 定时检查开放时段；只在跨过边界时重启无线。限速规则每轮同步一次
guest_tick = function() {
	if (state.cfg.role == "unconfigured") return;
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

function parse_leases() {
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

function parse_neigh() {
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

function parse_fdb() {
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
	state._usage_dirty = true;
}

function usage_track_macs(clients) {
	let set = {};
	for (let mn in (clients ?? local_clients())) set[mn] = true;
	for (let pmn, p in state.peers)
		for (let mn in (p.clients ?? {})) set[mn] = true;
	return set;
}

/* 站点计数优先用于 WiFi 终端：同时包含上下行，且不受 flow offload 影响。
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
function usage_add_traffic(mn, by) {
	if (by <= 0) return;
	if (!state.usage.ndata[mn]) state.usage.ndata[mn] = {};
	let d = state.usage.ndata[mn];
	d[state.usage.day] = (d[state.usage.day] ?? 0) + by;
	state._usage_dirty = true;
}

function station_usage_sample(map) {
	let snap = state._usage_station_snap ?? {};
	let fresh = {};

	for (let mn, b in map) {
		let prev = snap[mn];
		if (prev && b.rx >= prev.rx && b.tx >= prev.tx)
			usage_add_traffic(mn, (b.rx - prev.rx) + (b.tx - prev.tx));
		fresh[mn] = b;
	}
	state._usage_station_snap = fresh;
}

function usage_apply_rules(force, set) {
	if (state.cfg.role != "cap") return;
	set = set ?? usage_track_macs();
	let key = join(",", sort(keys(set)));
	if (!force && state._usage_track != null && key == state._usage_track) return;

	cmd_output(sprintf("nft add table inet %s 2>/dev/null", USAGE_TABLE));
	cmd_output(sprintf(
		"nft add chain inet %s forward '{ type filter hook forward priority -10; policy accept; }' 2>/dev/null",
		USAGE_TABLE));
	let script = sprintf("flush chain inet %s forward\n", USAGE_TABLE);
	for (let mn in set) {
		/* 上下行都计数：saddr=终端发送，daddr=终端接收 */
		script += sprintf(
			"add rule inet %s forward ether saddr %s counter comment \"wu:%s\"\n",
			USAGE_TABLE, maccolon(mn), mn);
		script += sprintf(
			"add rule inet %s forward ether daddr %s counter comment \"wu:%s\"\n",
			USAGE_TABLE, maccolon(mn), mn);
	}
	let path = "/tmp/wifiroam-usage.nft";
	fs.writefile(path, script);
	cmd_output(sprintf("nft -f %s 2>/dev/null", path));
	fs.unlink(path);

	// chain 重建会把 counter 归零，重置快照避免把归零误判成负增量
	state._usage_snap = null;
	state._usage_ts = 0;
	state._usage_track = key;
}

function usage_sample() {
	if (state.cfg.role != "cap") return;
	let out = cmd_output(sprintf("nft -j list table inet %s 2>/dev/null", USAGE_TABLE));
	if (out == "") {
		// 表被防火墙清掉：下一轮强制重建
		state._usage_track = "";
		return;
	}
	let data;
	try { data = json(out); } catch (e) { return; }
	if (type(data) != "object" || type(data.nftables) != "array") return;
	let snap = state._usage_snap ?? {};
	let fresh = {};
	let want = {};
	if (state._usage_track)
		for (let mn in split(state._usage_track, ",")) want[mn] = true;

	for (let item in data.nftables) {
		let r = item.rule;
		if (!r) continue;
		let p = split(r.comment ?? "", ":");
		if (length(p) != 2 || p[0] != "wu") continue;
		let mn = p[1], by = 0;
		for (let e in (r.expr ?? []))
			if (e.counter) { by = int(e.counter.bytes ?? 0); break; }
		fresh[mn] = (fresh[mn] ?? 0) + by;
		delete want[mn];
	}
	// 规则被防火墙清掉时强制下一轮重建，避免统计永久停摆
	if (length(keys(want))) state._usage_track = "";

	for (let mn, by in fresh) {
		let prev = snap[mn];
		if (prev == null || by < prev) continue;
		usage_add_traffic(mn, by - prev);
	}
	state._usage_snap = fresh;
	state._usage_ts = time();
}

function usage_online_sample(seen) {
	if (state.cfg.role != "cap") return;
	let now = time();
	let dt = now - (state._usage_online_ts ?? 0);
	if (!state._usage_online_ts || dt <= 0 || dt > 180)
		dt = int(TICK_INTERVAL / 1000);
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
		}
	} catch (e) { /* first boot */ }
}

function usage_save() {
	fs.mkdir(ALIAS_DIR);
	fs.writefile(USAGE_PATH, sprintf("%.J", {
		ver: 1, day: state.usage.day,
		online: state.usage.online, ndata: state.usage.ndata,
	}));
	state._usage_dirty = false;
	state._usage_saved = time();
}

function usage_tick() {
	if (state.cfg.role != "cap") return;
	try {
		usage_roll_day();
		let clients = local_clients();
		let all = usage_track_macs(clients);
		let stations = station_usage_map(clients);
		/* WiFi 终端用站点计数（上下行、含 offload），其余终端用 nft 计数 */
		let nft_set = {};
		for (let mn in all)
			if (!stations[mn]) nft_set[mn] = true;
		usage_apply_rules(false, nft_set);
		usage_sample();
		station_usage_sample(stations);
		usage_online_sample(all);
		if (state._usage_dirty && time() - state._usage_saved >= USAGE_FLUSH)
			usage_save();
	} catch (e) {
		/* 单个统计异常不能让整个 wifiroamd 退出，否则 procd 会不断重启 */
		log("usage_tick failed: " + e);
	}
}

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

		if (msg.role == "unconfigured") {
			let dip = msg.ip ?? peer.address;
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
					client_name_of(mn, my));
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
	};
}

function build_topology() {
	let nodes = [];
	let self_mn = macnorm(state.self.mac);
	let myclients = local_clients();

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
		cur.set("wireless", sid, "reassociation_deadline", "2000");
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
	uloop.timer(1000, function() {
		uloop.process("/sbin/wifi", [ "reload" ], null, function(res) {
			log("wifi reload rc=" + res);
			guest_tc_apply(guest_cfg());
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

	if (bh.enabled && (bh.ssid ?? "") != "" && (bh.key ?? "") != "") {
		let dev = pick_radio(role == "cap" ? (bh.device ?? "") : "");
		if (!dev) return { ok: false, error: "no_radio" };
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
	cur.commit("wireless");

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

	uloop.process("/sbin/wifi", [ "reload" ], null,
		function(res) { log("backhaul wifi reload rc=" + res); });
	push_event("backhaul_apply", "",
		sprintf("ver=%d %s", ver, bh.enabled ? "wireless" : "off"));
	return { ok: true, ver };
}

// SAP 侧：有线/无线回程互斥。网线在位时 STA 保持 disabled，拔线后自动启用；
// 重新插回网线则暂停 STA，避免二层环路。
function backhaul_tick() {
	if (state.cfg.role != "sap") return;
	let bh = current_backhaul_cfg();
	if (!bh.enabled) return;
	let cur = uci.cursor();
	cur.load("wireless");
	if (cur.get("wireless", BACKHAUL_SECTION) == null) return;
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
			link.cap_mac = macnorm(req.args?.mac ?? "");
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
					guest_ver: guest_cfg().ver,
				},
				data_cb: function(m) {
					if (m?.ok) {
						link.authed = true;
						link.last_pong = time();
						state.net_names = m.names ?? {};
						if (m.roster) state.roster = m.roster;
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
						link.chan.disconnect();
					}
				},
				// cb 为 complete 回调（成功也触发），仅 rc != 0 表示失败/超时
				cb: function(rc) {
					if (rc != 0 && state.link == link) {
						log("CAP auth request failed");
						sap_disconnect();
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
			push(ssids, { band: it.band ?? "?", ssid: ssid, key: key });
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
	case "push_channel_config": {
		// CAP 统一分配的信道：SAP 本地写 wireless 并按需重启无线
		let r = channel_apply_local(req.args.radios ?? []);
		req.reply({ ok: r.ok, count: r.count });
		break;
	}
	case "push_guest_config": {
		// CAP 下发的访客网络配置：SAP 本地落盘并重建访客子网
		let g = req.args.guest ?? {};
		if (!guest_save_local(g)) {
			req.reply({ ok: false, error: "invalid" });
			break;
		}
		let r = apply_guest_local(guest_cfg());
		req.reply({ ok: r.ok, error: r.error });
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
		let c = local_clients()[mn];
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
			save_config();
			reconfigure();
		});
		break;
	}
	return 0;
}

function sap_disconnect() {
	let link = state.link;
	if (!link) return;
	log("link to CAP closed");
	try { link.chan.disconnect(); } catch (e) {}
	try { link.sock.close(); } catch (e) {}
	if (link.cap_mac && state.peers[link.cap_mac])
		state.peers[link.cap_mac].authed = false;
	state.link = null;
}

function sap_connect(cap_ip) {
	sap_disconnect();
	let addr = socket.sockaddr({ address: cap_ip, port: TCP_PORT });
	if (!addr) return;
	let sock = socket.create(socket.AF_INET,
		socket.SOCK_STREAM | socket.SOCK_NONBLOCK, 0);
	if (!sock) return;
	sock.connect(addr); // nonblocking: completes via channel machinery
	let link = { sock, authed: false, ts: time(), last_pong: time() };
	link.chan = libubus.open_channel(sock, sap_rx, sap_disconnect);
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
	let clients = local_clients();
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
				guest_ver: guest_cfg().ver,
				// 本机落盘的 K/V/R 生效状态，CAP 汇总后展示给用户
				kvr: applied_kvr(current_roam_cfg()),
			},
			data_cb: function(m) {
				link.last_pong = time();
				if (m?.names) state.net_names = m.names;
				if (m?.roster) state.roster = m.roster;
				if (m?.bss) {
					state.bss_list = m.bss;
					state._bss_cache = null;
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

// ------------------------------------------------------- TCP server (all)
conn_close = function(conn) {
	if (conn.chan) { try { conn.chan.disconnect(); } catch (e) {} }
	if (conn.sock) { try { conn.sock.close(); } catch (e) {} }
	if (conn.mac) {
		let mn = macnorm(conn.mac);
		let p = state.peers[mn];
		if (p && p.conn == conn) {
			p.conn = null;
			p.chan = null;
			p.authed = false;
		}
	}
};

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
			state.cfg.role = "sap";
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
				req.reply({ ok: false, error: "auth" });
				conn_close(conn);
				return 0;
			}
			let mn = macnorm(args.mac);
			conn.authed = true;
			conn.mac = uc(args.mac ?? "");
			conn.name = args.name;
			let p = state.peers[mn] ??= { clients: null }; // null = 未收过 report，首轮 diff 抑制
			p.mac = conn.mac;
			if (args.name) p.name = args.name;
			p.authed = true;
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
			});
			if ((args.alias_ver ?? 0) < state.aliases.ver)
				push_aliases_to(mn);
			let roam = current_roam_cfg();
			// ver 落后或内容签名不一致都重新下发：后者用于修复历史遗留的
			// SAP 本地配置与主 AP 不一致（例如只同步了 enabled/ver）
			if (state.cfg.role == "cap" &&
			    ((args.roam_ver ?? -1) < roam.config_ver ||
			     (args.roam_sig && !roam_sig_ok(args.roam_sig, roam))))
				push_roam_to(mn);
			let bh = current_backhaul_cfg();
			if (state.cfg.role == "cap" && bh.enabled &&
			    (args.backhaul_ver ?? -1) < bh.config_ver)
				push_backhaul_to(mn);
			/* 访客配置也要在这里补发：只在保存那一刻推送的话，
			   子 AP 重连后仍会保留本地旧配置（旧密码/旧限速） */
			let ga = guest_cfg();
			if (state.cfg.role == "cap" && (args.guest_ver ?? -1) < ga.ver)
				push_guest_to(mn, ga);
			if (state.cfg.role == "cap")
				push_offload_to(mn);
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
		p.kvr = args.kvr ?? null;
		p.last_seen = time();
		if (state.cfg.role == "cap" && (channel_cfg().enabled || state.channel_plan))
			push_channel_to(mn);
		if (prev != null) // 首轮 report 不产 join/leave 事件
			diff_events(prev, p.clients, p.info?.name ?? conn.name ?? mn);
		owner_events(local_clients()); // SAP 终端表更新后立即重算归属（含跨 AP 迁移）
		if (p.alias_ver < state.aliases.ver)
			push_aliases_to(mn);
		let roam = current_roam_cfg();
		if (p.roam_ver < roam.config_ver ||
		    (p.roam_sig != "" && !roam_sig_ok(p.roam_sig, roam)))
			push_roam_to(mn);
		let bh = current_backhaul_cfg();
		if (bh.enabled && p.backhaul_ver < bh.config_ver)
			push_backhaul_to(mn);
		let ga = guest_cfg();
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
		            bss: state.cfg.role == "cap" ? steer_bss_all() : null });
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
		let c = local_clients()[cmn];
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
		let conn = { sock: cs, authed: false, nonce: randhex(16) };
		conn.chan = libubus.open_channel(
			cs,
			function(req) { return srv_rx(conn, req); },
			function() { conn_close(conn); });
		conn.chan.request({
			method: "hello",
			data: { mac: state.self.mac, role: state.cfg.role,
			        nonce: conn.nonce },
			return: "ignore",
		});
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
push_wifi_to = function(mn, ssids) {
	let p = state.peers[mn];
	if (!p?.authed || !p.chan) return false;
	if (p.wifi_pushing) return true;
	p.wifi_pushing = true;
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
					apply_wifi_result_update(mn, false, "timeout");
				}
			},
		});
	} catch (e) {
		p.wifi_pushing = false;
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

// 把访客网络配置推给成员 AP（SAP 收到后重建本机访客子网）
push_guest_to = function(mn, cfg) {
	let p = state.peers[mn];
	if (!p?.authed || !p.chan) return false;
	if (p.guest_pushing) return true;
	p.guest_pushing = true;
	try {
		p.chan.defer({
			method: "push_guest_config",
			data: { guest: cfg },
			data_cb: function(m) {
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

// ------------------------------------------------------------------ ubus API
function find_client(mn) {
	let local = local_clients();
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

	cur.set("wifiroam", "channel", "enabled", "0");
	cur.set("wifiroam", "channel", "band2g", "1");
	cur.set("wifiroam", "channel", "band5g", "1");
	cur.set("wifiroam", "channel", "hour", "4");
	cur.set("wifiroam", "channel", "last", "");
	cur.set("wifiroam", "alias_sync", "ver", "0");
	cur.commit("wifiroam");

	/* 清除别名、流量统计和运行态 */
	try { fs.unlink(ALIAS_PATH); } catch (e) {}
	try { fs.unlink(USAGE_PATH); } catch (e) {}
	state.aliases = { ver: 0, map: {} };
	state.usage = { day: "", online: {}, ndata: {} };
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
	state.bss_list = null;
	state._bss_cache = null;
	state.channel_plan = null;
	state.channel_ver = 0;
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

	state.cfg = {
		enabled: true, role: "unconfigured",
		token: "", cap_ip: "", name: "",
	};
	save_config();
	reconfigure();
	return { ok: true };
}

let api_obj = {
	status: {
		args: { ubus_rpc_session: "" },
		call: function(req) {
			let online = 0, nclients = 0;
			for (let mn, p in state.peers) {
				if (p.authed) online++;
				nclients += length(keys(p.clients ?? {}));
			}
			nclients += length(keys(local_clients()));
			// SAP 以 CAP 下发的概览为准，成员 AP 计数与主AP保持一致
			let peers_total = length(keys(state.peers));
			if (state.cfg.role == "sap" && type(state.roster?.aps) == "array") {
				let o = 0, t = 0;
				let self_mn = macnorm(state.self.mac);
				for (let a in state.roster.aps) {
					if (a.id == self_mn) continue;
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
				state.peers = {};
				state.cfg.token = "";
				state.cfg.cap_ip = "";
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
			return { ok: true, ver, results };
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

			// 多频合一且密码留空：沿用现有密码复制到所有频段，避免只合一名称
			if (req.args.unified) {
				let cur = uci.cursor();
				cur.load("wireless");
				let common = "";
				cur.foreach("wireless", "wifi-iface", function(s) {
					if (common != "") return;
					if (s.mode && s.mode != "ap") return;
					if (s.wifiroam_guest == "1") return;
					if (s.key != null && s.key != "") common = s.key;
				});
				if (common != "")
					for (let it in ssids)
						if (it.key == "") it.key = common;
			}

			// 漫游组记录里的 SSID 跟随改名（两频段同名时按频段逐条映射）
			let pairs = [];
			for (let it in wifi_summary().ifaces) {
				for (let s in ssids)
					if (s.band == it.band) push(pairs, { old: it.ssid, new: s.ssid });
			}
			roam_rename_ssids(pairs);

			let lr = apply_wifi_local(ssids);

			let results = [ { ap: state.self.mac, name: state.self.name,
			                 ok: lr.ok, error: lr.ok ? null : "no_ap_iface" } ];
			for (let mn, p in state.peers) {
				if (!p.authed) continue;
				push(results, { ap: p.mac ?? maccolon(mn),
				                name: p.info?.name ?? p.name ?? mn,
				                ok: null, error: "pending" });
				push_wifi_to(mn, ssids);
			}
			state.last_wifi = { ts: time(), ssids: ssids, results: results };
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
			let lr = apply_guest_local(guest_cfg());

			let results = [ { ap: state.self.mac, name: state.self.name,
			                 ok: lr.ok, error: lr.ok ? null : "invalid" } ];
			for (let mn, p in state.peers) {
				if (!p.authed) continue;
				push(results, { ap: p.mac ?? maccolon(mn),
				                name: p.info?.name ?? p.name ?? mn,
				                ok: null, error: "pending" });
				push_guest_to(mn, cfg);
			}
			state.last_guest = { ts: time(), config: cfg, results: results };
			return { ok: lr.ok, results: results };
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
			return { ok: true, ver, results, backhaul: bh };
		},
	},
	get_channel: {
		args: { ubus_rpc_session: "" },
		call: function(req) {
			let cfg = channel_cfg();
			let aps = channel_aps();
			return {
				ok: true,
				settings: cfg,
				aps,
				cochannel: channel_cochannel(aps),
				plan: channel_make_plan(aps, cfg),
				can_apply: state.cfg.role == "cap",
			};
		},
	},
	set_channel: {
		args: {
			ubus_rpc_session: "", enabled: false,
			band2g: true, band5g: true, hour: 4, apply: false,
		},
		call: function(req) {
			if (state.cfg.role != "cap")
				return { ok: false, error: "not_cap" };
			let hour = int(req.args.hour ?? 4);
			if (hour < 0 || hour > 23) hour = 4;

			let cur = uci.cursor();
			cur.load("wifiroam");
			cur.set("wifiroam", "channel", "enabled", req.args.enabled ? "1" : "0");
			cur.set("wifiroam", "channel", "band2g", req.args.band2g !== false ? "1" : "0");
			cur.set("wifiroam", "channel", "band5g", req.args.band5g !== false ? "1" : "0");
			cur.set("wifiroam", "channel", "hour", "" + hour);
			if (req.args.apply)
				cur.set("wifiroam", "channel", "last", usage_day());
			cur.commit("wifiroam");

			let cfg = channel_cfg();
			let aps = channel_aps();
			let plan = channel_make_plan(aps, cfg);
			let local = { ok: true, count: 0 };

			if (req.args.apply) {
				state.channel_plan = plan;
				state.channel_ver = (state.channel_ver ?? 0) + 1;
				let mine = [];
				let self_mn = macnorm(state.self.mac);
				for (let it in plan)
					if (it.ap == self_mn && it.changed)
						push(mine, { device: it.device ?? "", band: it.band,
						             from: it.from ?? 0, channel: it.to });
				local = channel_apply_local(mine);
				for (let mn, p in state.peers)
					if (p.authed) push_channel_to(mn);
			}

			return {
				ok: true, settings: cfg, aps,
				cochannel: channel_cochannel(aps), plan, local,
			};
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
			chan = libubus.open_channel(sock,
				function(req2) {
					if (req2.type == "hello" && chan) {
						try {
							chan.defer({
								method: "join",
								data: {
									token: state.cfg.token,
									cap_ip: state.self.ip,
									nonce_echo: d.nonce,
								},
								data_cb: function(m) {
									done = true;
									if (m?.ok) {
										push_event("paired", d.mac, d.ip);
										delete state.discovered[mn];
									}
									chan.disconnect();
								},
								cb: function(rc) {
									// 成功时 data_cb 已处理并断开；仅失败时兜底断开
									if (rc != 0 && chan)
										try { chan.disconnect(); } catch (e) {}
								},
							});
						} catch (e) {
							try { chan.disconnect(); } catch (e2) {}
						}
					}
					return 0;
				},
				function() {});
			uloop.timer(8000, function() {
				if (!done && chan) { try { chan.disconnect(); } catch (e) {} }
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
			return { events: ev };
		},
	},
	/* 上网统计：每终端每日在线时长与总流量（仅主 AP 采集） */
	usage_stats: {
		args: { ubus_rpc_session: "" },
		call: function(req) {
			return {
				ok: state.cfg.role == "cap",
				day: state.usage.day || usage_day(),
				online: state.usage.online,
				ndata: state.usage.ndata,
			};
		},
	},
	/* 硬件/软件 flow offload 状态：读 fw4 的实际 forward 链判断是否真的生效，
	   子 AP 跟随主 AP 下发的状态。 */
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
};

// ------------------------------------------------------- RSSI steering (11v)
// 先建议式 BTM（不断线），只有连续低信号且低于临界值时才强制。
// 候选 BSS 来自 steer_bss_all()；强制前必须有候选，避免把终端踢到空处。
function steer_neighbors(c, all) {
	let band = channel_band_key(c.band);
	let self_mn = macnorm(state.self.mac);
	let out = [];
	for (let b in all) {
		if (!b.bssid || int(b.channel ?? 0) <= 0) continue;
		if (b.ssid != c.ssid) continue;
		if (channel_band_key(b.band) != band) continue;
		/* 排除当前 AP 自己的 BSS，只保留其它 AP 的候选 */
		if (b.ap_mac == self_mn) continue;
		if (!b.ap_mac && b.ifname && c.ifname && b.ifname == c.ifname) continue;
		push(out, b);
		if (length(out) >= 4) break;
	}
	return out;
}

function steer_btm_neighbors(list) {
	let out = [];
	for (let b in list) {
		let w = b.htmode ?? "";
		let op = 81;
		if (channel_band_key(b.band) == "5g")
			op = index(w, "160") >= 0 ? 118
			   : index(w, "80") >= 0 ? 117
			   : index(w, "40") >= 0 ? 116 : 115;
		push(out, {
			bssid: b.bssid, ssid: b.ssid, op_class: op,
			channel: int(b.channel), phy_type: 0,
		});
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
			/* 个别 hostapd 版本不接受 neighbors 字段，退回普通 BTM */
			delete req.neighbors;
			r = ubusc.call("hostapd." + c.ifname, "bss_transition_request", req);
		}
		return r != null;
	} catch (e) {
		log("steer btm " + mn + " failed");
		return false;
	}
}

function steer_tick_impl() {
	if (state.cfg.role == "unconfigured") return;
	let roam = current_roam_cfg();
	if (!roam.enabled || !roam.v_bss_transition) return;
	let threshold = roam.rssi_threshold;
	if (threshold == null || threshold >= 0) return;
	if (!length(roam.ssids)) return;

	let has_peer = false;
	for (let mn, p in state.peers)
		if (p.authed) { has_peer = true; break; }
	if (!has_peer) return;   // 单 AP 无处分流，引导只会让终端掉线

	let now = time();
	let clients = local_clients();
	let all = steer_bss_all();
	let seen = {};
	let critical_at = threshold - STEER_CRITICAL_DROP;

	for (let mn, c in clients) {
		seen[mn] = true;
		if (c.type != "wifi" || !c.ifname || c.guest ||
		    c.ssid == null || index(roam.ssids, c.ssid) < 0 ||
		    c.rssi == null) {
			delete state.steer_low[mn];
			delete state.steer_stage[mn];
			continue;
		}

		let rssi = int(c.rssi);
		if (rssi >= threshold) {
			delete state.steer_low[mn];
			delete state.steer_stage[mn];
			continue;
		}
		if (c.connected_time != null && int(c.connected_time) < MIN_STEER_ASSOC) {
			delete state.steer_low[mn];
			delete state.steer_stage[mn];
			continue;
		}

		let low = (state.steer_low[mn] ?? 0) + 1;
		state.steer_low[mn] = low;
		let critical = rssi <= critical_at;
		let stage = state.steer_stage[mn] ?? 0;
		let last = state.steer_last[mn] ?? 0;
		let since = now - last;

		let btm_neigh = steer_btm_neighbors(steer_neighbors(c, all));

		if (stage == 0) {
			if (low < (critical ? STEER_CRITICAL_CONFIRM : STEER_CONFIRM))
				continue;
			if (steer_btm(c, mn, false, 0, 30, btm_neigh)) {
				state.steer_last[mn] = now;
				state.steer_stage[mn] = 1;
				push_event("roam_steer", maccolon(mn),
					sprintf("rssi=%d < %d advisory", rssi, threshold),
					client_name_of(mn, clients));
			}
		}
		else if (stage == 1 && critical &&
		         low >= STEER_CRITICAL_CONFIRM &&
		         since >= STEER_CRITICAL_DELAY) {
			/* 只有存在明确候选时才强制，避免把终端踢下线 */
			if (!length(btm_neigh)) continue;
			if (steer_btm(c, mn, true, 10, 30, btm_neigh)) {
				state.steer_last[mn] = now;
				state.steer_stage[mn] = 2;
				push_event("roam_steer", maccolon(mn),
					sprintf("rssi=%d < %d forced", rssi, threshold),
					client_name_of(mn, clients));
			}
		}
		else if (stage == 1 && since >= STEER_COOLDOWN) {
			/* 终端没接受建议，再发一次建议式 BTM */
			if (steer_btm(c, mn, false, 0, 30, btm_neigh))
				state.steer_last[mn] = now;
		}
	}

	for (let mn in keys(state.steer_low))
		if (!seen[mn]) {
			delete state.steer_low[mn];
			delete state.steer_stage[mn];
			delete state.steer_last[mn];
		}
}

function steer_tick() {
	try {
		steer_tick_impl();
	} catch (e) {
		log("steer_tick failed: " + e);
	}
}

function channel_tick() {
	if (state.cfg.role != "cap") return;
	try {
		let cfg = channel_cfg();
		if (!cfg.enabled) return;

		let lt = localtime(time());
		if (int(lt.hour) != cfg.hour) return;
		let today = sprintf("%04d-%02d-%02d", lt.year, lt.mon, lt.mday);
		if (cfg.last == today) return;

		// 先记日期，避免失败后每分钟重试
		let cur = uci.cursor();
		cur.load("wifiroam");
		cur.set("wifiroam", "channel", "last", today);
		cur.commit("wifiroam");

		let plan = channel_make_plan(channel_aps(), cfg);
		state.channel_plan = plan;
		state.channel_ver = (state.channel_ver ?? 0) + 1;
		let mine = [];
		let self_mn = macnorm(state.self.mac);
		for (let it in plan)
			if (it.ap == self_mn && it.changed)
				push(mine, { device: it.device ?? "", band: it.band,
				             from: it.from ?? 0, channel: it.to });
		let lr = channel_apply_local(mine);
		for (let mn, p in state.peers)
			if (p.authed) push_channel_to(mn);
		log(sprintf("auto channel: %d local change(s)", lr.count));
	} catch (e) {
		log("channel_tick failed: " + e);
	}
}

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
	state.peers = {};
	state.cap_learned = null;
	state.prev_clients = null;
	state.wired_seen = {};
	state.prev_owner = null;
	state.steer_last = {};
	state.steer_low = {};
	state.steer_stage = {};
	state.bss_list = null;
	state._bss_cache = null;
	send_hello();
};

// 插件启用后按默认设置开启漫游：首次启动（从未保存过漫游配置）时，
// 自动选中本机全部主网络 SSID，并按默认 k/v/r 参数下发一次。
// 注意：ucode 的函数声明不做提升，本函数必须定义在 wifi_ifaces /
// member_list / apply_roam_local / applied_kvr 之后。
function roam_default_init() {
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
}

function main() {
	srand(time());
	uloop.init();

	ubusc = libubus.connect(null, 60);
	if (!ubusc) {
		log("ubus connect failed");
		exit(1);
	}

	load_config();
	if (state.cfg.role == "sap")
		enable_relay_ap_mode();
	alias_load();
	usage_load();
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
	});

	uloop.interval(HELLO_INTERVAL, send_hello);
	uloop.interval(TICK_INTERVAL, sap_tick);
	uloop.interval(TICK_INTERVAL, sap_report);
	uloop.interval(TICK_INTERVAL, expire_tick);
	uloop.interval(TICK_INTERVAL, backhaul_tick);
	uloop.interval(5000, steer_tick);
	uloop.interval(TICK_INTERVAL, guest_tick);
	uloop.interval(TICK_INTERVAL, usage_tick);
	uloop.interval(60000, channel_tick);
	uloop.interval(TICK_INTERVAL, function() {
		if (state.cfg.role != "cap") return;
		let cur = local_clients();
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
