// policy.mjs -- 应用管控 + wifiroam-dpi 管理 + flow offload.
//
// Port of wifiroamd.uc (r47) policy functions (spec.md §8 module 6):
//   appctl_app, appctl_read_devices, appctl_write_device,
//   appctl_dnsmasq_sync, appctl_enhanced, appctl_strict, appctl_timeout,
//   appctl_nft_schema_id, appctl_nft_schema, appctl_nft_base,
//   appctl_apply_rules, appctl_hw_suspend, appctl_table_remove,
//   appctl_dpi_write_blocklist, appctl_dpi_pid, appctl_dpi_daemon,
//   appctl_dnslock_apply, prune_days, appctl_roll_day, appctl_add_time,
//   appctl_add_bytes, appctl_add_traffic, appctl_sample, appstats_load,
//   appstats_save, appctl_warm_list, appctl_warm_step, appctl_tick,
//   appctl_load, appctl_track_macs, online_sample, appctl_public_stats,
//   appctl_public_days, offload_apply, offload_request_cap.
// 定时断网（ban）不属于本模块：唯一实现在 clients（ban_* 与
// ban_list/set_ban/ban_set/ban_del 均由 clients 导出，core 只接
// clients）；本模块在 appctl_tick 设备组变化时只经 ctx.banApply
// 调 clients.banApply(true) 同步一次，不自带任何 ban 实现。
// plus the ubus method bodies that only touch this module (§3.1):
//   appctl_status, offload_status, set_offload, set_appctl, set_app_policy.
//
// Target: Node 22.23.4, core modules only, zero npm dependencies, ESM.
// Only lib/ is imported for business logic (blobmsg/ubus/uci/shell/util/
// store); node:fs is used solely for reading the DPI pidfile and
// unlinking the transient nft scripts / pidfile, which no lib function
// covers. No other business module is imported (spec §8 loop ban):
// clients/discovery functions this module needs arrive as ctx callbacks.
//
// ctx contract -- createPolicy(ctx):
//   ctx.S       shared state (core-owned; field names verbatim per spec §1.2).
//               This module reads/writes only:
//                 S.cfg.role, S.self.ip, S.brdev, S.peers, S.link,
//                 S.appctl{enabled,enhanced,strict,devices,stats,day,online,ndata},
//                 （S.ban 只由 clients 的 ban 实现读写，本模块不碰）
//                 S._nft_snap, S._dnslock_on, S._appstat_ts, S._appstat_dirty,
//                 S._appstat_saved, S._track_key, S._warm_list, S._warm_i,
//                 S._group_changed (set by clients.device_group_refresh),
//                 S._online_ts (set by online_sample itself; NOT listed in
//                 spec §1.2 -- copied verbatim from the original, see below).
//   ctx.bus     ubus client (unused by this module; accepted for the shared
//               factory signature only).
//   ctx.uci     UciClient (default: lib default singleton).
//   ctx.shell   { cmdOutput, shellCommands } (default: lib/shell.js).
//   ctx.util    lib/util.js exports (default: imported).
//   ctx.store   lib/store.js exports (default: imported).
//   ctx.paths   optional overrides for on-disk paths (tests only):
//               { schema, appstats, nftFile, dpiBlocklist, dpiPidfile }.
//   Cross-module callbacks (wired by core; defaults are the no-group
//   behaviour so the module still runs standalone in tests):
//   ctx.deviceKey(v)        clients.device_key
//   ctx.deviceMembersOf(v)  clients.device_members_of
//   ctx.deviceAliasOf(v)    clients.device_alias_of (null when unknown)
//   ctx.localClients()      clients.local_clients ({} when unwired)
//   ctx.findClient(key)     clients.find_client (null when unwired)
//   ctx.parseLeases()       clients.parse_leases ({} when unwired)
//   ctx.deviceGroupRefresh() clients.device_group_refresh (no-op when unwired)
//   ctx.pushOffloadTo(mn)   discovery.push_offload_to (no-op when unwired)
//   ctx.banApply(force)     clients.ban_apply (no-op when unwired;
//                           core 注入 clients.banApply；appctl_tick
//                           设备组变化时调它同步定时断网规则)
//
// Non-equivalence notes (see final report for the full list):
//   - S._online_ts is not in spec §1.2's state list; the original sets and
//     reads it in online_sample(), so it is copied verbatim here.
//   - appctl_dpi_pid() compares the `kill -0` probe output with "1"
//     exactly as the original does (no trim); see the comment there.
//   - File writes go through store.writeTextAtomic/saveAppStats/saveSchema
//     (atomic write is the one deliberate improvement required by
//     INTERFACE.md §8.5); the nft temp scripts are still unlinked right
//     after `nft -f`, as in the original.

import { readFileSync, unlinkSync } from 'node:fs';
import { cmdOutput as libCmdOutput, shellCommands as libShellCommands } from '../lib/shell.js';
import { uci as defaultUci } from '../lib/uci.js';
import * as libUtil from '../lib/util.js';
import * as libStore from '../lib/store.js';

// 内置应用清单。统计准确性优先于域名数量，只收录可归属于对应产品的域名：
// 1) 排除 alicdn.com / byteimg.com 等跨产品、跨厂商共享基础设施；
// 2) 排除 bdstatic / zhimg / pddpic 等会被第三方页面大量嵌入的静态资源域；
// 3) 同一公司的不同产品分开统计，避免把 TikTok、Kwai 等计入国内产品。
// QQ 暂无可覆盖核心聊天流量且不与其他腾讯产品混用的域名，保留空条目仅为
// 兼容和解除旧策略；dnsmasq 不为空条目生成配置，也不会产生新的 QQ 统计。
// dnsmasq 将解析结果写入每应用 IPv4/IPv6 nft set，再按
// (原始终端 MAC, 目标 IP 集合) 统计或封禁，TLS/QUIC SNI DPI 作为封禁兜底。
// cat 用于前端分类展示（对齐 TP-Link 的应用分类）。
const APP_DEFS = [
	{ id: "wechat", name: "微信", cat: "social", domains: [
		"weixin.qq.com", "wx.qq.com", "wechat.com" ] },
	{ id: "qq", name: "QQ", cat: "social", domains: [] },
	{ id: "douyin", name: "抖音", cat: "video", domains: [
		"douyin.com", "douyinvod.com", "idouyinvod.com", "douyincdn.com",
		"douyinpic.com", "douyinstatic.com", "amemv.com", "iesdouyin.com" ],
	  // apex 域名多数不可解析，预热时解析具体视频主机补充 CDN 地址池。
	  probes: [ "www.douyin.com", "v3-web.douyinvod.com",
	            "v26-web.douyinvod.com", "p3-pc-sign.douyinpic.com" ] },
	{ id: "tiktok", name: "TikTok", cat: "video", domains: [
		"tiktok.com", "tiktokv.com", "tiktokcdn.com", "tiktok-row.net" ] },
	{ id: "kuaishou", name: "快手", cat: "video", domains: [
		"kuaishou.com", "gifshow.com" ] },
	// kwaicdn.com 同时服务国内快手与海外 Kwai，不作为任一产品的独占依据。
	{ id: "kwai", name: "Kwai", cat: "video", domains: [
		"kwai.com" ] },
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
		"music.163.com", "music.126.net" ] },
	{ id: "youku", name: "优酷", cat: "video", domains: [
		"youku.com" ] },
	{ id: "mgtv", name: "芒果TV", cat: "video", domains: [
		"mgtv.com", "hitv.com" ] },
	{ id: "zhihu", name: "知乎", cat: "news", domains: [
		"zhihu.com" ] },
	{ id: "toutiao", name: "今日头条", cat: "news", domains: [
		"toutiao.com", "toutiaoapi.com" ] },
	{ id: "xigua", name: "西瓜视频", cat: "video", domains: [
		"ixigua.com" ] },
	{ id: "jd", name: "京东", cat: "shop", domains: [
		"jd.com" ] },
	{ id: "pinduoduo", name: "拼多多", cat: "shop", domains: [
		"pinduoduo.com", "yangkeduo.com" ] },
	{ id: "meituan", name: "美团/大众点评", cat: "shop", domains: [
		"meituan.com", "dianping.com" ] },
	{ id: "eleme", name: "饿了么", cat: "shop", domains: [
		"ele.me" ] },
	{ id: "dingtalk", name: "钉钉", cat: "office", domains: [
		"dingtalk.com" ] },
	{ id: "feishu", name: "飞书", cat: "office", domains: [
		"feishu.cn", "feishu.net" ] },
	{ id: "wps", name: "WPS", cat: "office", domains: [
		"wps.cn", "wps.com" ] },
	{ id: "baidu", name: "百度", cat: "web", domains: [
		"baidu.com" ] },
	{ id: "ximalaya", name: "喜马拉雅", cat: "music", domains: [
		"ximalaya.com" ] },
	{ id: "huya", name: "虎牙直播", cat: "live", domains: [
		"huya.com" ] },
	{ id: "douyu", name: "斗鱼直播", cat: "live", domains: [
		"douyu.com", "douyu.tv" ] },
	// 只保留国服原神高置信度服务域名。官网、米游社、HoYoLAB、补丁 CDN
	// 及国际服 CloudFront/Cloudflare 都会与其他服务共用 IP；预热会持续
	// 写入这些共享地址，不能再用于按 IP 的使用统计。
	{ id: "mihoyo", name: "原神/米哈游", cat: "game", domains: [
		"dispatchcnglobal.yuanshen.com", "hk4e-sdk.mihoyo.com",
		"hk4e-api.mihoyo.com" ] },
	{ id: "kugou", name: "酷狗音乐", cat: "music", domains: [
		"kugou.com", "kugou.net" ] },
	{ id: "ctrip", name: "携程", cat: "web", domains: [
		"ctrip.com", "ctrip.cn" ] },
	{ id: "rail12306", name: "铁路12306", cat: "web", domains: [
		"12306.cn" ] },
	{ id: "zuoyebang", name: "作业帮", cat: "office", domains: [
		"zuoyebang.com", "zuoyebang.cc", "zybang.com" ] },
	{ id: "steam", name: "Steam", cat: "game", domains: [
		"steampowered.com", "steamcommunity.com", "steamcontent.com" ] },
	{ id: "netflix", name: "Netflix", cat: "video", domains: [
		"netflix.com" ] },
	{ id: "spotify", name: "Spotify", cat: "music", domains: [
		"spotify.com" ] },
	{ id: "bosszhipin", name: "BOSS直聘", cat: "office", domains: [
		"zhipin.com" ] },
	// 以下来自商业 IOTD 指纹库，仅保留已核实可解析、能独立归属于
	// 对应 IoT 云服务的域名；共享 CDN、公共云入口和宽泛官网不收录。
	{ id: "mijia", name: "米家", cat: "iot", domains: [
		"api.io.mi.com", "ot.io.mi.com" ] },
	{ id: "aqara", name: "Aqara", cat: "iot", domains: [
		"aiot-coap.aqara.cn", "aiot-coap-usa.aqara.com", "usa.aqara.com" ] },
	{ id: "arlo", name: "Arlo", cat: "iot", domains: [
		"deviceapi.messaging.arlo.com" ] },
	{ id: "philips_hue", name: "Philips Hue", cat: "iot", domains: [
		"diagnostics.meethue.com" ] },
	{ id: "eufy", name: "eufy", cat: "iot", domains: [
		"security-app.eufylife.com" ] },
	{ id: "dlink", name: "D-Link", cat: "iot", domains: [
		"api.fota.dlink.com", "auto.mydlink.com" ] },
	{ id: "xiaoyi", name: "小蚁", cat: "iot", domains: [
		"api.us.xiaoyi.com", "log.xiaoyi.com" ] },
	{ id: "netatmo", name: "Netatmo", cat: "iot", domains: [
		"netatmo.net" ] },
	{ id: "withings", name: "Withings", cat: "iot", domains: [
		"ws.withings.net" ] },
	{ id: "roku", name: "Roku", cat: "iot", domains: [
		"ravm.tv", "rokutime.com" ] },
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
const APPSTATS_PATH = "/etc/wifiroam/appstats.json";
const APPCTL_SCHEMA_PATH = "/etc/wifiroam/nft_schema";
const APPSTATS_FLUSH = 15;   // s：统计落盘的最小间隔（重启最多丢这一轮）

// DPI（深度包检测）：把每个新建连接的首包送到 wifiroam-dpi 守护进程，
// 解析 TLS SNI / QUIC SNI，命中被禁应用域名即 drop。兜底 DNS/IP 集合方案
// 无法覆盖的 HTTPDNS 直连与 P2P 流量。blocklist 由本进程写，dpi 读。
const DPI_QUEUE = 0;
const DPI_BLOCKLIST = "/tmp/wifiroam/dpi_blocklist";
const DPI_DAEMON = "/usr/sbin/wifiroam-dpi";
const DPI_PIDFILE = "/tmp/wifiroam-dpi.pid";

const GUEST_BRIDGE = "br-guest";
const TICK_INTERVAL = 10000; // ms; appctl_sample/online_sample 的 dt 回落值

function unlinkQuiet(path) {
  try { unlinkSync(path); } catch (_e) { /* missing file is fine */ }
}

export {
  APP_DEFS, APP_DOH_V4, APP_DOH_V6,
  APP_ACT_MIN_PK, APP_ACT_MIN_BYTES, APP_SET_TIMEOUT,
  APP_ACT_ENH_PK, APP_ACT_ENH_BYTES, APP_SET_TIMEOUT_ENH,
  APPCTL_TABLE, APPCTL_NFT_FILE, APPSTATS_PATH, APPCTL_SCHEMA_PATH,
  APPSTATS_FLUSH, DPI_QUEUE, DPI_BLOCKLIST, DPI_DAEMON, DPI_PIDFILE,
};

export function createPolicy(ctx = {}) {
  const S = ctx.S;
  if (!S || typeof S !== 'object') throw new TypeError('createPolicy: ctx.S (shared state) is required');
  const bus = ctx.bus ?? null;
  const U = ctx.uci ?? defaultUci;
  const cmd = ctx.shell?.cmdOutput ?? libCmdOutput;
  const sc = ctx.shell?.shellCommands ?? libShellCommands;
  const util = ctx.util ?? libUtil;
  const store = ctx.store ?? libStore;
  const paths = {
    schema: ctx.paths?.schema ?? APPCTL_SCHEMA_PATH,
    appstats: ctx.paths?.appstats ?? APPSTATS_PATH,
    nftFile: ctx.paths?.nftFile ?? APPCTL_NFT_FILE,
    dpiBlocklist: ctx.paths?.dpiBlocklist ?? DPI_BLOCKLIST,
    dpiPidfile: ctx.paths?.dpiPidfile ?? DPI_PIDFILE,
  };

  const macnorm = util.macnorm;
  const maccolon = util.maccolon;
  const devnorm = util.devnorm;
  const isGroupId = util.isGroupId;
  const toInt = util.toInt;
  const sha256 = util.sha256;
  const asList = util.asList;
  const log = util.log;
  const nowSeconds = util.nowSeconds;
  const localDayString = util.localDayString;

  // Cross-module callbacks (see header). Defaults are the no-group
  // behaviour: a plain MAC is its own group, no aliases, no clients.
  const deviceKey = typeof ctx.deviceKey === 'function'
    ? ctx.deviceKey : (v) => devnorm(v);
  const deviceMembersOf = typeof ctx.deviceMembersOf === 'function'
    ? ctx.deviceMembersOf : (v) => [devnorm(v)];
  const deviceAliasOf = typeof ctx.deviceAliasOf === 'function'
    ? ctx.deviceAliasOf : () => null;
  const localClients = typeof ctx.localClients === 'function'
    ? ctx.localClients : () => ({});
  const findClient = typeof ctx.findClient === 'function'
    ? ctx.findClient : () => null;
  const parseLeases = typeof ctx.parseLeases === 'function'
    ? ctx.parseLeases : () => ({});
  const deviceGroupRefresh = typeof ctx.deviceGroupRefresh === 'function'
    ? ctx.deviceGroupRefresh : () => {};
  const pushOffloadTo = typeof ctx.pushOffloadTo === 'function'
    ? ctx.pushOffloadTo : () => {};
  // ban_apply：clients 的唯一实现（core 注入）。appctl_tick 在设备组
  // 变化时调它同步定时断网；未注入时为空操作（core 永远会注入）。
  const banApply = typeof ctx.banApply === 'function'
    ? ctx.banApply : () => {};

  // ------------------------------------------------------------ app lookup
  function appctlApp(id) {
    for (const a of APP_DEFS) if (a.id === id) return a;
    return null;
  }

  function appctlReadDevices() {
    U.load('wifiroam');
    const devs = {};
    U.foreach('wifiroam', 'appdev', (s) => {
      const raw = devnorm(s.mac ?? '');
      const mn = deviceKey(raw);
      if (mn.length !== 12 && !isGroupId(mn)) return;
      const blocks = devs[mn]?.block ?? [];
      const incoming = asList(s.block);
      for (const id of incoming) if (!blocks.includes(id)) blocks.push(id);
      devs[mn] = { name: (s.name ?? '') !== '' ? s.name : (devs[mn]?.name ?? ''), block: blocks };
    });
    S.appctl.devices = devs;
    return devs;
  }

  // 写回某终端的禁止应用列表；列表空时删除 section（等价于不再关注该设备）
  function appctlWriteDevice(mn, blocks, name) {
    mn = deviceKey(mn);
    U.load('wifiroam');
    let sid = null;
    const old = [];
    U.foreach('wifiroam', 'appdev', (s) => {
      if (deviceKey(s.mac ?? '') === mn) {
        old.push(s['.name']);
        if (!sid) sid = s['.name'];
      }
    });
    if (!blocks.length) {
      for (const id of old) U.delete('wifiroam', id);
      if (old.length) U.commit('wifiroam');
      return;
    }
    if (!sid) sid = U.add('wifiroam', 'appdev');
    U.set('wifiroam', sid, 'mac', mn);
    if (name != null && name !== '') U.set('wifiroam', sid, 'name', name);
    U.set('wifiroam', sid, 'block', blocks);
    for (const id of old) if (id !== sid) U.delete('wifiroam', id);
    U.commit('wifiroam');
  }

  // 把应用域名同步到 dhcp 配置，让 dnsmasq 把解析结果写入 nft 集合。
  // 本固件 dnsmasq 的 init 脚本只认独立的 `config ipset` section
  // （dnsmasq_ipset_add 读 table/table_family/family/name/domain），
  // 不识别 dhcp.@dnsmasq[0].nftset；因此每个应用建一个 section。
  // 返回 true 表示配置有变化、需要重启 dnsmasq 才生效。
  function appctlDnsmasqSync(on) {
    U.load('dhcp');
    let changed = false;

    // 清掉早期版本写入 @dnsmasq[0].nftset 的残留（该选项在此固件无效）
    const legacy = asList(U.get('dhcp', '@dnsmasq[0]', 'nftset'));
    const keep = [];
    for (const v of legacy) if (!v.includes('#' + APPCTL_TABLE + '#')) keep.push(v);
    if (keep.length !== legacy.length) {
      if (keep.length) U.set('dhcp', '@dnsmasq[0]', 'nftset', keep);
      else U.delete('dhcp', '@dnsmasq[0]', 'nftset');
      changed = true;
    }

    for (const a of APP_DEFS) {
      const sid = 'wifiroam_' + a.id;

      // 过渡清理：曾把 v6 单独建段，但 dnsmasq 的 domain_find_sets() 对同一域名
      // 只返回一条匹配项（等长时后者覆盖前者），拆成两段会导致只有一个 family
      // 生效。正确做法是同一段里放两个集合名。
      if (U.get('dhcp', sid + '_v6') != null) {
        U.delete('dhcp', sid + '_v6');
        changed = true;
      }

      if (!on || !a.domains.length) {
        if (U.get('dhcp', sid) != null) {
          U.delete('dhcp', sid);
          changed = true;
        }
        continue;
      }

      // family 必须留空：init 脚本的 add_nftset 会按集合名后缀 _v4/_v6 逐个
      // 推断地址族；若写死 family=4，会把 v6 集合也标成 4#。
      if (U.get('dhcp', sid, 'family') != null) {
        U.delete('dhcp', sid, 'family');
        changed = true;
      }

      const want = {
        table: APPCTL_TABLE,
        table_family: 'inet',
        name: [a.id + '_v4', a.id + '_v6'],
        domain: a.domains,
      };

      // 已有配置完全一致时跳过，避免每次开关都无谓重启 dnsmasq
      let same = true;
      for (const [k, v] of Object.entries(want)) {
        const have = asList(U.get('dhcp', sid, k));
        const need = asList(v);
        if (have.length !== need.length) { same = false; break; }
        for (let i = 0; i < need.length; i++) {
          if (have[i] !== need[i]) { same = false; break; }
        }
        if (!same) break;
      }
      if (same) continue;

      // uci 不会为不存在的 section 隐式建段，先按类型创建
      if (U.get('dhcp', sid) == null) U.set('dhcp', sid, 'ipset');
      for (const [k, v] of Object.entries(want)) U.set('dhcp', sid, k, v);
      changed = true;
    }

    if (!changed) return false;
    U.commit('dhcp');
    return true;
  }

  // 精准模式（高级设置开关）：活跃判定更严、集合超时更短、锁定 DNS 出口。
  // 关闭时保持宽松口径，行为与旧版一致。
  function appctlEnhanced() {
    return S.appctl.enhanced === true;
  }

  /* 严格模式：对存在被禁应用的终端额外封锁绕过通道（QUIC / 外部 DNS / 静态
     DoH），配合 DPI 提高命中率。与应用统计的总开关相互独立。 */
  function appctlStrict() {
    return S.appctl.strict === true;
  }

  function appctlTimeout() {
    return appctlEnhanced() ? APP_SET_TIMEOUT_ENH : APP_SET_TIMEOUT;
  }

  // 集合结构/特征签名：包含默认超时与全部应用域名。早期版本没有默认超时，
  // 旧 IP 会永久驻留；仅缩短超时也不够，域名从特征库删除后，其共享地址仍可能
  // 在剩余有效期内误计。签名变化时重建集合并由预热/真实解析重新填充。
  // nft 表跨进程重启保留，旧规则仍引用集合会导致 delete 失败，所以先清规则链。
  function appctlNftSchemaId() {
    const parts = [appctlTimeout()];
    for (const a of APP_DEFS) parts.push(a.id + ':' + a.domains.join(','));
    return sha256(parts.join('|'));
  }

  function appctlNftSchema() {
    const schema = appctlNftSchemaId();
    if (store.loadSchema(paths.schema) === schema) return false;
    cmd(sc.nftFlushChain(APPCTL_TABLE, 'forward'));
    for (const a of APP_DEFS) {
      for (const fam of ['v4', 'v6']) {
        cmd(sc.nftDeleteSet(APPCTL_TABLE, a.id + '_' + fam));
      }
    }
    store.saveSchema(paths.schema, schema);
    // 集合被重建，dnsmasq 缓存的句柄可能失效，需要重启后重新绑定
    return true;
  }

  // 幂等创建表 / 集合 / 转发链。已存在时 nft 报错被丢弃，不影响后续。
  // 集合带默认 timeout：dnsmasq 写元素时不带显式超时，内核会按集合默认值计时，
  // 超时内无新解析即自动过期，避免旧 IP 被复用后长期误归属。
  // 精准模式 30m / 宽松模式 12h（appctl_timeout）。
  function appctlNftBase() {
    cmd(sc.nftAddTable(APPCTL_TABLE));
    for (const a of APP_DEFS) {
      cmd(`nft add set inet ${APPCTL_TABLE} ${a.id}_v4 '{ type ipv4_addr; flags interval; timeout ${appctlTimeout()}; }' 2>/dev/null`);
      // IPv6 必须单独建集合：iptables 时代的 ip daddr 规则完全匹配不到 v6 流量，
      // 实测手机 8 秒内 211 个 v6 包 vs 6 个 v4 包，缺 v6 等于完全不生效
      cmd(`nft add set inet ${APPCTL_TABLE} ${a.id}_v6 '{ type ipv6_addr; flags interval; timeout ${appctlTimeout()}; }' 2>/dev/null`);
    }
    cmd(`nft add chain inet ${APPCTL_TABLE} forward '{ type filter hook forward priority -10; policy accept; }' 2>/dev/null`);
    // NFQUEUE 返回 accept 会终止当前链，queue 之后的规则不再执行。
    // 因此把 packet mark -> ct mark 的复制放到 -5（晚于 -10、早于防火墙 filter）
    // 的独立链，队列放行的包重入后才会走到这里。
    cmd(`nft add chain inet ${APPCTL_TABLE} fwpost '{ type filter hook forward priority -5; policy accept; }' 2>/dev/null`);
  }

  // 重建规则：集合与元素保留（dnsmasq 填好的 IP 不会被清空），仅刷新 chain。
  // 每条 (终端, 应用) 规则都带 counter 用于时长统计；禁止的额外 drop。
  // IPv4 与 IPv6 各一条，comment 相同，采样时按 key 累加。
  async function appctlApplyRules() {
    appctlNftBase();
    const devs = appctlReadDevices();
    const set = await appctlTrackMacs();
    let script = `flush chain inet ${APPCTL_TABLE} forward\nflush chain inet ${APPCTL_TABLE} fwpost\n`;
    for (const mn of Object.keys(set)) {
      const d = devs[deviceKey(mn)];
      const hasBlock = d != null && d.block.length > 0;
      // 统计规则必须排在 DPI 之前：队列放行的包会终止本链，
      // 后面的规则不再执行，否则被管控终端的应用时长会几乎归零。
      for (const a of APP_DEFS) {
        const blocked = d != null && d.block.includes(a.id);
        for (const fam of ['v4', 'v6']) {
          script += `add rule inet ${APPCTL_TABLE} forward ether saddr ${maccolon(mn)} ${fam === 'v4' ? 'ip' : 'ip6'} daddr @${a.id}_${fam} counter${blocked ? ' drop' : ''} comment "wr:${mn}:${a.id}:${blocked ? 'block' : 'allow'}"\n`;
        }
      }
      // 本终端总流量（不受 daddr 限制），用于反推「未识别应用」的用量：
      // 允许类规则没有 verdict，包会继续走到这条，所以 total 含已识别部分。
      // 被 drop 的禁止流量不会到这里，符合「禁止不计入使用」的预期。
      script += `add rule inet ${APPCTL_TABLE} forward ether saddr ${maccolon(mn)} counter comment "wr:${mn}:*:total"\n`;
      // 严格模式：在 DPI 队列之前丢弃可绕过识别的通道。必须排在
      // ct mark accept 快速路径之前，否则已被 DPI 放行的流会跳过这些规则。
      if (hasBlock && appctlStrict()) {
        const gw = S.self.ip ?? '';
        // QUIC：阻断 UDP 443，迫使应用回落 TCP/TLS，便于按 SNI 识别
        script += `add rule inet ${APPCTL_TABLE} forward ether saddr ${maccolon(mn)} udp dport 443 counter drop\n`;
        // 外部 DNS：只允许发往本机 dnsmasq（v6 地址不固定，直接全禁）
        if (/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/.test(gw)) {
          script += `add rule inet ${APPCTL_TABLE} forward ether saddr ${maccolon(mn)} udp dport 53 ip daddr != ${gw} counter drop\n` +
            `add rule inet ${APPCTL_TABLE} forward ether saddr ${maccolon(mn)} tcp dport 53 ip daddr != ${gw} counter drop\n`;
        }
        script += `add rule inet ${APPCTL_TABLE} forward ether saddr ${maccolon(mn)} meta nfproto ipv6 udp dport 53 counter drop\n` +
          `add rule inet ${APPCTL_TABLE} forward ether saddr ${maccolon(mn)} meta nfproto ipv6 tcp dport 53 counter drop\n`;
        // 静态 DoH 地址（Cloudflare 1.1.1.1 同时承载网页服务，清单里未收录）
        script += `add rule inet ${APPCTL_TABLE} forward ether saddr ${maccolon(mn)} ip daddr { ${APP_DOH_V4.join(', ')} } tcp dport 443 counter drop\n` +
          `add rule inet ${APPCTL_TABLE} forward ether saddr ${maccolon(mn)} ip6 daddr { ${APP_DOH_V6.join(', ')} } tcp dport 443 counter drop\n`;
      }
      // 对有被禁应用的终端，把新建连接首包送 DPI 解析 SNI：
      //   - ct mark 0x1 = 已放行 (dpi 返回 accept 时携带)，命中即走快速路径
      //   - 被拦截的包 dpi 直接 drop，不设 mark，靠其流缓存丢弃后续重传
      //   - tcp 只送首个带载荷的数据包 (ACK & payload)；udp 送首包
      //   - 队列返回后由 fwpost 链把 packet mark 复制到 ct mark
      //     （meta mark 为 0 的普通包不复制，避免把已标记的流冲掉）
      if (hasBlock) {
        script += `add rule inet ${APPCTL_TABLE} forward ether saddr ${maccolon(mn)} ct mark & 0x3 == 0x1 accept\n` +
          `add rule inet ${APPCTL_TABLE} forward ether saddr ${maccolon(mn)} ct state established tcp flags & (fin|syn|rst|ack) == ack queue num ${DPI_QUEUE}\n` +
          `add rule inet ${APPCTL_TABLE} forward ether saddr ${maccolon(mn)} ct state new meta l4proto udp queue num ${DPI_QUEUE}\n` +
          `add rule inet ${APPCTL_TABLE} fwpost ether saddr ${maccolon(mn)} meta mark != 0 ct mark set meta mark\n`;
      }
    }
    store.writeTextAtomic(paths.nftFile, script);
    cmd(sc.nftApplyFile(paths.nftFile));
    unlinkQuiet(paths.nftFile);
    // chain 重建会把 counter 归零，重置快照避免把归零误判成「无流量」
    S._nft_snap = null;
    S._appstat_ts = 0;
    S._track_key = Object.keys(set).sort().join(',');
  }

  /* 硬件 flow offload 与统计不可兼得：MTK hnat 卸载后流量不再经过 netfilter
     forward 链，应用统计只能看到流建立时的首包（软件 flowtable 在 priority 0，
     晚于本插件的 -10，不受影响，可保留）。精准模式开启时自动挂起 hw offload，
     退出时恢复。只操作本机：统计发生在 CAP 的 forward 链，SAP 不做三层转发，
     其 hw 状态与统计无关。hw_suspended 标记记录「是我们关的」，避免覆盖
     用户手动关闭的设置。 */
  function appctlHwSuspend(on) {
    U.load('firewall');
    if (U.get('firewall', '@defaults[0]') == null) return;
    const hwOn = U.get('firewall', '@defaults[0]', 'flow_offloading_hw') === '1';
    U.load('wifiroam');
    const marked = U.get('wifiroam', 'appctl', 'hw_suspended') === '1';
    if (on) {
      if (!hwOn || marked) return;   // 本来就关着/已挂起：不动
      U.set('firewall', '@defaults[0]', 'flow_offloading_hw', '0');
      U.commit('firewall');
      if (U.get('wifiroam', 'appctl') == null) U.set('wifiroam', 'appctl', 'appctl');
      U.set('wifiroam', 'appctl', 'hw_suspended', '1');
      U.commit('wifiroam');
      cmd(sc.firewallReload());
    } else {
      if (!marked) return;            // 不是我们挂起的：别动用户设置
      U.set('firewall', '@defaults[0]', 'flow_offloading_hw', '1');
      U.commit('firewall');
      U.delete('wifiroam', 'appctl', 'hw_suspended');
      U.commit('wifiroam');
      cmd(sc.firewallReload());
    }
  }

  function appctlTableRemove() {
    appctlDpiDaemon('stop');
    cmd(sc.nftDeleteTable(APPCTL_TABLE));
    S._nft_snap = null;
    S._appstat_ts = 0;
    S._track_key = '';
    S._dnslock_on = false;
  }

  /* ---------- DPI ---------- */
  /* 把「有被禁应用的终端 → 该终端所有被禁应用的域名」写到 blocklist，
     wifiroam-dpi 读取后对匹配 SNI 的连接 drop。
     格式：每行 <mac> <dom1>,<dom2>,...
     域名来自 APP_DEFS[*].domains（只取被禁应用的）。 */
  function appctlDpiWriteBlocklist() {
    const devs = appctlReadDevices();
    const lines = [];
    for (const key of Object.keys(devs)) {
      const d = devs[key];
      if (!d || !d.block.length) continue;
      const doms = {};
      for (const bid of d.block) {
        const a = appctlApp(bid);
        if (!a) continue;
        for (const dmn of a.domains) doms[dmn] = true;
      }
      if (!Object.keys(doms).length) continue;
      for (const mn of deviceMembersOf(key)) {
        lines.push(`${maccolon(mn)} ${Object.keys(doms).join(',')}`);
      }
    }
    store.writeTextAtomic(paths.dpiBlocklist, lines.join('\n') + '\n');
  }

  /* Resolve the actual running wifiroam-dpi PID.  The PID file may be
   * stale (e.g. daemon restarted by a different path), so fall back to
   * pidof which scans /proc.  Returns "" if not running. */
  function appctlDpiPid() {
    const live = cmd(sc.dpiPid()).trim();
    if (live !== '') return live.split(' ')[0];   /* first match */
    let pid = null;
    try { pid = readFileSync(paths.dpiPidfile, 'utf8'); } catch (_e) { pid = null; }
    // NOTE (verbatim copy): the original compares the probe output with
    // "1" exactly -- `kill -0 <pid> && echo 1` prints "1\n" on a real
    // shell, so this comparison is only true when the runner returns the
    // bare string "1". Copied as-is per spec §9; not "fixed" here.
    if (pid && cmd(sc.dpiPidCheck(pid.trim())) === '1') return pid.trim();
    return '';
  }

  /* 管理 wifiroam-dpi 守护进程。action: start|stop|reload */
  function appctlDpiDaemon(action) {
    if (action === 'stop') {
      const pid = appctlDpiPid();
      if (pid !== '') cmd(sc.dpiKill(pid));
      unlinkQuiet(paths.dpiPidfile);
      return;
    }
    const pid = appctlDpiPid();
    const running = pid !== '';
    if (action === 'reload') {
      if (running) {
        appctlDpiWriteBlocklist();
        cmd(sc.dpiKillHup(pid));
      }
      return;
    }
    /* start */
    appctlDpiWriteBlocklist();
    if (running) {
      /* Already running: blocklist was just rewritten, notify the
       * daemon so it picks up the new domain set.  (Without this,
       * a wifiroamd restart leaves the daemon serving the stale
       * in-memory blocklist.) */
      cmd(sc.dpiKillHup(pid));
      return;
    }
    cmd(sc.dpiStart());
  }

  /* DNS 出口锁定（精准模式）：把客户端侧的 53 重定向到本机 dnsmasq，
     拦截 DoT(853) 与知名公共 DoH 的 443，防止 App 用内置 HTTPDNS/私有 DNS
     绕过路由器解析（域名识别最大的漏网来源）。
     只匹配 br-lan / br-guest 入方向，路由器自身出向不受影响；
     redirect 的回包由 conntrack 自动改回原始源地址，客户端无感知。
     实测内核不支持规则内带 timeout 的集合元素刷新，故只锁 DNS 不做刷新。 */
  function appctlDnslockApply(on) {
    if (on === S._dnslock_on) return;
    S._dnslock_on = on;
    // 先单独清旧链：链不存在/非空的报错由 shell 吞掉（nft -f 遇错会中止
    // 整个文件，不能把幂等清理和创建放进同一脚本）
    cmd(`nft flush chain inet ${APPCTL_TABLE} dnsnat 2>/dev/null; nft delete chain inet ${APPCTL_TABLE} dnsnat 2>/dev/null`);
    cmd(`nft flush chain inet ${APPCTL_TABLE} dnslock 2>/dev/null; nft delete chain inet ${APPCTL_TABLE} dnslock 2>/dev/null`);
    if (!on) return;
    const iifs = `{ "${S.brdev}", "${GUEST_BRIDGE}" }`;
    // 注意：这是 nft -f 脚本（无 shell），块定义不能带单引号
    const script =
      `add chain inet ${APPCTL_TABLE} dnsnat { type nat hook prerouting priority dstnat; policy accept; }\n` +
      `add chain inet ${APPCTL_TABLE} dnslock { type filter hook prerouting priority -5; policy accept; }\n` +
      `add rule inet ${APPCTL_TABLE} dnsnat iifname ${iifs} udp dport 53 counter redirect\n` +
      `add rule inet ${APPCTL_TABLE} dnsnat iifname ${iifs} tcp dport 53 counter redirect\n` +
      `add rule inet ${APPCTL_TABLE} dnsnat iifname ${iifs} meta nfproto ipv6 udp dport 53 counter redirect\n` +
      `add rule inet ${APPCTL_TABLE} dnsnat iifname ${iifs} meta nfproto ipv6 tcp dport 53 counter redirect\n` +
      `add rule inet ${APPCTL_TABLE} dnslock iifname ${iifs} meta l4proto { tcp, udp } th dport 853 counter drop\n` +
      `add rule inet ${APPCTL_TABLE} dnslock iifname ${iifs} ip daddr { ${APP_DOH_V4.join(', ')} } tcp dport 443 counter drop\n` +
      `add rule inet ${APPCTL_TABLE} dnslock iifname ${iifs} ip6 daddr { ${APP_DOH_V6.join(', ')} } tcp dport 443 counter drop\n`;
    store.writeTextAtomic(paths.nftFile, script);
    cmd(sc.nftApplyFile(paths.nftFile));
    unlinkQuiet(paths.nftFile);
  }

  // 按天分桶只保留最近 7 天：日期字符串字典序即时间序，删最旧的
  function pruneDays(map, keep) {
    const ks = Object.keys(map).sort();
    while (ks.length > (keep ?? 7)) {
      delete map[ks[0]];
      ks.shift();
    }
  }

  function appctlRollDay() {
    const day = localDayString(new Date(nowSeconds() * 1000));
    if (S.appctl.day === day) return;
    S.appctl.day = day;
    for (const apps of Object.values(S.appctl.stats)) {
      for (const v of Object.values(apps)) {
        v.today = 0;
        v.btoday = 0;
        if (v.days) pruneDays(v.days);
        if (v.bdays) pruneDays(v.bdays);
      }
    }
    for (const d of Object.values(S.appctl.online)) pruneDays(d);
    for (const d of Object.values(S.appctl.ndata)) pruneDays(d);
    S._appstat_dirty = true;
  }

  function appctlAddTime(mn, app, dt, now) {
    if (!S.appctl.stats[mn]) S.appctl.stats[mn] = {};
    if (!S.appctl.stats[mn][app]) S.appctl.stats[mn][app] = { today: 0, total: 0, last: 0 };
    const v = S.appctl.stats[mn][app];
    v.today += dt;
    v.total += dt;
    v.last = now;
    if (!v.days) v.days = {};
    v.days[S.appctl.day] = (v.days[S.appctl.day] ?? 0) + dt;
    S._appstat_dirty = true;
  }

  // 应用流量（字节）：按天分桶，与时长分开存放，老数据没有这些字段时按 0 处理
  function appctlAddBytes(mn, app, by, now) {
    if (by <= 0) return;
    if (!S.appctl.stats[mn]) S.appctl.stats[mn] = {};
    if (!S.appctl.stats[mn][app]) S.appctl.stats[mn][app] = { today: 0, total: 0, last: 0 };
    const v = S.appctl.stats[mn][app];
    v.btoday = (v.btoday ?? 0) + by;
    v.btotal = (v.btotal ?? 0) + by;
    if (!v.bdays) v.bdays = {};
    v.bdays[S.appctl.day] = (v.bdays[S.appctl.day] ?? 0) + by;
    S._appstat_dirty = true;
  }

  // 终端总流量（含未识别应用），用于在界面上展示「其他」的用量
  function appctlAddTraffic(mn, by) {
    if (by <= 0) return;
    if (!S.appctl.ndata[mn]) S.appctl.ndata[mn] = {};
    const d = S.appctl.ndata[mn];
    d[S.appctl.day] = (d[S.appctl.day] ?? 0) + by;
    S._appstat_dirty = true;
  }

  // 每轮取一次 nft counter 快照（包数与字节），达到阈值的应用才累加时长，
  // 时间按实际差值累加（不按固定 TICK 累加，避免调度漂移累积误差）。
  function appctlSample() {
    if (S.cfg.role !== 'cap' || !S.appctl.enabled) return;
    const out = cmd(sc.nftListTableJson(APPCTL_TABLE));
    if (out === '') return;
    let data;
    try { data = JSON.parse(out); } catch (_e) { return; }
    if (typeof data !== 'object' || data === null || !Array.isArray(data.nftables)) return;

    const now = nowSeconds();
    let dt = now - S._appstat_ts;
    if (!S._appstat_ts || dt <= 0 || dt > 180) dt = Math.trunc(TICK_INTERVAL / 1000);

    const snap = S._nft_snap ?? {};
    const fresh = {};
    const owner = {};

    for (const item of data.nftables) {
      const r = item.rule;
      if (!r) continue;
      const p = (r.comment ?? '').split(':');
      if (p.length !== 4 || p[0] !== 'wr') continue;
      const mn = p[1], app = p[2], verdict = p[3];
      let pk = 0, by = 0;
      for (const e of r.expr ?? []) {
        if (e.counter) {
          pk = toInt(e.counter.packets ?? 0);
          by = toInt(e.counter.bytes ?? 0);
          break;
        }
      }
      // v4/v6 两条规则 comment 相同，必须累加；直接赋值会让后者覆盖前者
      const key = mn + '|' + app;
      let f = fresh[key];
      if (!f) {
        f = { pk: 0, by: 0, block: false };
        fresh[key] = f;
      }
      f.pk += pk;
      f.by += by;
      if (verdict === 'block') f.block = true;
      owner[key] = [mn, app];
    }

    const deltas = {};
    for (const [key, t] of Object.entries(fresh)) {
      const prev = snap[key];
      // 计数被清零（规则重建 / 服务重启）时跳过本轮，避免把归零当增量
      if (!prev || t.pk < prev.pk) continue;
      const dpk = t.pk - prev.pk;
      let dby = t.by - (prev.by ?? 0);
      if (dby < 0) dby = 0;
      const mn = owner[key][0], app = owner[key][1];
      // 被禁止的流量是「拦截尝试」，既不算流量也不算使用时长
      if (t.block) continue;
      const gkey = deviceKey(mn) + '|' + app;
      let d = deltas[gkey];
      if (!d) {
        d = { key: deviceKey(mn), app, pk: 0, by: 0 };
        deltas[gkey] = d;
      }
      d.pk += dpk;
      d.by += dby;
    }
    for (const d of Object.values(deltas)) {
      if (d.app === '*') {
        appctlAddTraffic(d.key, d.by);
        continue;
      }
      appctlAddBytes(d.key, d.app, d.by, now);
      // 同组多成员在一个窗口只累计一次时长；字节和包数先合并再判活跃。
      let active;
      if (appctlEnhanced()) active = (d.pk >= APP_ACT_ENH_PK && d.by >= APP_ACT_ENH_BYTES);
      else active = (d.pk >= APP_ACT_MIN_PK || d.by >= APP_ACT_MIN_BYTES);
      if (active) appctlAddTime(d.key, d.app, dt, now);
    }

    S._nft_snap = fresh;
    S._appstat_ts = now;
  }

  function appstatsLoad() {
    const d = store.loadAppStats(paths.appstats);
    S.appctl.stats = d.stats ?? {};
    S.appctl.day = d.day ?? '';
    S.appctl.online = d.online ?? {};
    S.appctl.ndata = d.ndata ?? {};
  }

  function appstatsSave() {
    store.saveAppStats(paths.appstats, {
      day: S.appctl.day, stats: S.appctl.stats,
      online: S.appctl.online, ndata: S.appctl.ndata,
    });
    S._appstat_dirty = false;
    S._appstat_saved = nowSeconds();
  }

  // 客户端常用 App 内置 HTTPDNS 或外部 DNS，dnsmasq 看不到这些查询，集合长期
  // 只有零星 IP，规则自然拦不住。这里由路由器自己周期性解析应用域名：dnsmasq
  // 的 nftset 对任何来源的应答都会写集合，等于替客户端补一次 DNS。
  function appctlWarmList() {
    const out = [];
    // 具体主机（probes）先解析：它们才是真正承载视频的 CDN 入口
    for (const a of APP_DEFS) for (const d of (a.probes ?? [])) out.push(d);
    for (const a of APP_DEFS) {
      for (const d of a.domains) {
        out.push(d);
        out.push('www.' + d);
      }
    }
    return out;
  }

  function appctlWarmStep() {
    if (S._warm_list == null) S._warm_list = appctlWarmList();
    const list = S._warm_list;
    if (!list.length) return;
    const host = list[S._warm_i % list.length];
    S._warm_i++;
    // 每个 tick 只解析一个主机，避免一次性几十次查询拖住主循环
    cmd(sc.nslookupWarm(host));
  }

  async function appctlTrackMacs() {
    const set = {};
    for (const key of Object.keys(S.appctl.devices)) {
      for (const mn of deviceMembersOf(key)) set[mn] = true;
    }
    const lc = await localClients();
    for (const mn of Object.keys(lc)) set[mn] = true;
    for (const p of Object.values(S.peers)) {
      for (const mn of Object.keys(p.clients ?? {})) set[mn] = true;
    }
    return set;
  }

  // 在线时长按天累计：CAP 每 tick 给当前在线终端（本机 + SAP 上报）加窗口秒数，
  // 与 appctl 开关无关，供「上网统计」的昨日/今日/过去七天查询
  async function onlineSample() {
    if (S.cfg.role !== 'cap') return;
    const now = nowSeconds();
    let dt = now - (S._online_ts ?? 0);
    if (!S._online_ts || dt <= 0 || dt > 180) dt = Math.trunc(TICK_INTERVAL / 1000);
    S._online_ts = now;

    const seen = {};
    const lc = await localClients();
    for (const mn of Object.keys(lc)) seen[mn] = true;
    for (const p of Object.values(S.peers)) {
      for (const mn of Object.keys(p.clients ?? {})) seen[mn] = true;
    }

    const day = S.appctl.day, groups = {};
    for (const mn of Object.keys(seen)) groups[deviceKey(mn)] = true;
    for (const key of Object.keys(groups)) {
      if (!S.appctl.online[key]) S.appctl.online[key] = {};
      S.appctl.online[key][day] = (S.appctl.online[key][day] ?? 0) + dt;
    }
    if (Object.keys(groups).length) S._appstat_dirty = true;
  }

  async function appctlTick() {
    await deviceGroupRefresh();
    const regrouped = S._group_changed === true;
    S._group_changed = false;
    if (regrouped) appctlReadDevices();
    appctlRollDay();
    await onlineSample();
    if (S.cfg.role === 'cap' && S.appctl.enabled) {
      // 在线终端或设备组变化时重建规则；后者即使原始 MAC 集合不变，
      // 也可能改变每个 MAC 所继承的应用禁止策略。
      const set = await appctlTrackMacs();
      if (regrouped || Object.keys(set).sort().join(',') !== S._track_key) await appctlApplyRules();
      if (regrouped) appctlDpiDaemon('reload');
      appctlWarmStep();
      // 精准模式的 DNS 出口锁定：幂等，状态变化时才重建链
      appctlDnslockApply(appctlEnhanced());
    }
    if (regrouped) banApply(true);
    appctlSample();
    if (S._appstat_dirty && nowSeconds() - S._appstat_saved >= APPSTATS_FLUSH) appstatsSave();
  }

  async function appctlLoad() {
    U.load('wifiroam');
    S.appctl.enabled = U.get('wifiroam', 'appctl', 'enabled') === '1';
    S.appctl.enhanced = U.get('wifiroam', 'appctl', 'enhanced') === '1';
    S.appctl.strict = U.get('wifiroam', 'appctl', 'strict') === '1';
    appctlReadDevices();
    appstatsLoad();
    if (S.cfg.role !== 'cap' || !S.appctl.enabled) {
      // 关闭状态也要把之前精准模式挂起的 hw offload 恢复回来
      if (S.cfg.role === 'cap') {
        appctlDpiDaemon('stop');
        appctlHwSuspend(false);
      }
      return;
    }
    const schemaChanged = appctlNftSchema();
    await appctlApplyRules();
    appctlDpiDaemon('start');
    appctlDnslockApply(appctlEnhanced());
    appctlHwSuspend(appctlEnhanced());
    // 升级后新增了 v6 集合，需把 dnsmasq 的 ipset 段补齐（内容一致时不会重启）；
    // 集合结构刚被重建时也必须重启，让 dnsmasq 重新绑定新集合。
    // 两项检查必须都执行，不能在签名变化时短路而留下旧域名配置。
    const dnsmasqChanged = appctlDnsmasqSync(true);
    if (schemaChanged || dnsmasqChanged) cmd(sc.dnsmasqRestart());
  }

  // ------------------------------------------------- flow offloading (network)
  // 软件与硬件 offload 必须一起改：只关 hw 时软件 flowtable 依然会绕过规则。
  // 值未变化时不 reload，避免跨 AP 每次同步都重建 flowtable 打断在用连接。
  function offloadApply(on) {
    U.load('firewall');
    if (U.get('firewall', '@defaults[0]') == null) return false;
    const want = on ? '1' : '0';
    if (U.get('firewall', '@defaults[0]', 'flow_offloading') === want &&
        U.get('firewall', '@defaults[0]', 'flow_offloading_hw') === want) return true;
    U.set('firewall', '@defaults[0]', 'flow_offloading', want);
    U.set('firewall', '@defaults[0]', 'flow_offloading_hw', want);
    U.commit('firewall');
    // reload 会重建 flowtable，已 offload 的旧流随之清空，避免规则长期不生效
    cmd(sc.firewallReload());
    return true;
  }

  // SAP 侧：转发不在本机，开关必须交由 CAP 统一执行，再由 CAP 广播回全部子 AP
  function offloadRequestCap(on) {
    const link = S.link;
    if (!link?.authed) return false;
    try {
      link.chan.defer('set_offload', { enabled: on ? true : false }, {});
    } catch (_e) { return false; }
    return true;
  }

  // 历史统计仍按原始 MAC 保留，输出时合并到当前设备组；新采样已直接按组写入。
  function appctlPublicStats() {
    const out = {};
    for (const [mn, apps] of Object.entries(S.appctl.stats)) {
      const key = deviceKey(mn);
      if (!out[key]) out[key] = {};
      for (const [app, v] of Object.entries(apps)) {
        if (!out[key][app]) {
          out[key][app] = { today: 0, total: 0, last: 0, btoday: 0, btotal: 0, days: {}, bdays: {} };
        }
        const o = out[key][app];
        o.today += v.today ?? 0;
        o.total += v.total ?? 0;
        o.btoday += v.btoday ?? 0;
        o.btotal += v.btotal ?? 0;
        if ((v.last ?? 0) > o.last) o.last = v.last;
        for (const [day, sec] of Object.entries(v.days ?? {})) o.days[day] = (o.days[day] ?? 0) + sec;
        for (const [day, by] of Object.entries(v.bdays ?? {})) o.bdays[day] = (o.bdays[day] ?? 0) + by;
      }
    }
    return out;
  }

  function appctlPublicDays(src, online) {
    const out = {};
    for (const [mn, days] of Object.entries(src)) {
      const key = deviceKey(mn);
      if (!out[key]) out[key] = {};
      for (const [day, value] of Object.entries(days)) {
        // 在线时长是设备是否在线，不是各频段在线时长的总和；旧数据取最大值。
        if (online) {
          if ((value ?? 0) > (out[key][day] ?? 0)) out[key][day] = value ?? 0;
        } else out[key][day] = (out[key][day] ?? 0) + (value ?? 0);
      }
    }
    return out;
  }

  // ------------------------------------------------------- ubus method bodies
  // These implement the §3.1 handlers that touch only this module; the api
  // layer validates the role where the original did and forwards args.
  function appctlStatus() {
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
      apps, devices, stats: appctlPublicStats(),
      online: appctlPublicDays(S.appctl.online, true),
      ndata: appctlPublicDays(S.appctl.ndata, false),
    };
  }

  /* 硬件/软件 flow offload 状态：fw4 的 flowtable 一旦命中，后续数据包会绕过
     netfilter 链，inet wifiroam forward 里的 counter 不再增长，应用统计与
     访问控制都会受影响。这里读 fw4 的实际 forward 链判断是否真的生效。 */
  function offloadStatus() {
    U.load('firewall');
    const sw = U.get('firewall', '@defaults[0]', 'flow_offloading') === '1';
    const hw = U.get('firewall', '@defaults[0]', 'flow_offloading_hw') === '1';
    const active = cmd(sc.nftListChainForward()).includes('flow add');
    return { enabled: sw, hw, active };
  }

  function setOffload(args) {
    const on = args.enabled ? true : false;
    // 子 AP 的转发不发生在本地：本地先落盘保持一致，再通知 CAP 统一执行，
    // CAP 改完会把最终状态广播回所有子 AP（含本机）
    if (S.cfg.role === 'sap') {
      offloadApply(on);
      offloadRequestCap(on);
      return { ok: true, enabled: on };
    }
    if (!offloadApply(on)) return { ok: false, error: 'no_firewall_defaults' };
    for (const [mn, p] of Object.entries(S.peers)) {
      if (p.authed) pushOffloadTo(mn);
    }
    return { ok: true, enabled: on };
  }

  async function setAppctl(args) {
    // 调用方必须显式传 enhanced（ubus 参数是白名单校验，未声明的参数会被拒；
    // 默认值取 false，类型可推断，publish 正常）
    // strict 留空表示沿用当前值，避免旧调用点（总开关）把严格模式重置
    if (S.cfg.role !== 'cap') return { ok: false, error: 'not_cap' };
    const on = args.enabled ? true : false;
    U.load('wifiroam');
    // 老配置里可能没有 appctl section，先按类型创建再写选项
    if (U.get('wifiroam', 'appctl') == null) U.set('wifiroam', 'appctl', 'appctl');
    // enhanced 为必填调用参数（前端所有调用点都显式传当前值）
    const enh = args.enhanced ? true : false;
    let strict = S.appctl.strict === true;
    if (args.strict === '1') strict = true;
    else if (args.strict === '0') strict = false;
    U.set('wifiroam', 'appctl', 'enabled', on ? '1' : '0');
    U.set('wifiroam', 'appctl', 'enhanced', enh ? '1' : '0');
    U.set('wifiroam', 'appctl', 'strict', strict ? '1' : '0');
    U.commit('wifiroam');
    S.appctl.enabled = on;
    S.appctl.enhanced = enh;
    S.appctl.strict = strict;

    const dirty0 = appctlDnsmasqSync(on);
    let dirty = dirty0;
    if (on) {
      // 精准/宽松切换会改变集合默认超时：schema 标记不一致即重建集合
      if (appctlNftSchema()) dirty = true;
      await appctlApplyRules();
      appctlDpiDaemon('start');
      appctlDnslockApply(enh);
      appctlHwSuspend(enh);
    } else {
      appctlTableRemove();
      appctlHwSuspend(false);
    }
    // dnsmasq 需要重读 nftset 配置才生效，约 1s DNS 瞬断
    if (dirty) cmd(sc.dnsmasqRestart());
    return { ok: true, enabled: on, enhanced: enh, strict };
  }

  async function setAppPolicy(args) {
    if (S.cfg.role !== 'cap') return { ok: false, error: 'not_cap' };
    const mn = deviceKey(args.mac ?? '');
    if ((mn.length !== 12 && !isGroupId(mn)) || !appctlApp(args.app ?? '')) {
      return { ok: false, error: 'invalid_args' };
    }
    if (!S.appctl.enabled) return { ok: false, error: 'disabled' };
    if (!['block', 'allow'].includes(args.action ?? '')) return { ok: false, error: 'invalid_action' };

    const devs = appctlReadDevices();
    const blocks = [];
    for (const b of (devs[mn]?.block ?? [])) blocks.push(b);
    const i = blocks.indexOf(args.app);
    if (args.action === 'block' && i < 0) blocks.push(args.app);
    if (args.action === 'allow' && i >= 0) blocks.splice(i, 1);

    let name = devs[mn]?.name ?? '';
    if (name === '') name = (await findClient(mn))?.node?.name ?? '';
    appctlWriteDevice(mn, blocks, name);
    appctlReadDevices();
    await appctlApplyRules();
    appctlDpiDaemon('reload');
    return { ok: true, mac: mn, app: args.app, action: args.action, block: blocks };
  }

  return {
    // §8 outward interface
    appctlLoad, appctlTick, offloadApply,
    appctlDpiDaemon, appctlPublicStats,
    // internal functions (exposed for tests / api wiring)
    appctlApp, appctlReadDevices, appctlWriteDevice, appctlDnsmasqSync,
    appctlEnhanced, appctlStrict, appctlTimeout,
    appctlNftSchemaId, appctlNftSchema, appctlNftBase, appctlApplyRules,
    appctlHwSuspend, appctlTableRemove,
    appctlDpiWriteBlocklist, appctlDpiPid,
    appctlDnslockApply, pruneDays, appctlRollDay,
    appctlAddTime, appctlAddBytes, appctlAddTraffic, appctlSample,
    appstatsLoad, appstatsSave, appctlWarmList, appctlWarmStep,
    appctlTrackMacs, onlineSample,
    offloadRequestCap, offloadStatus, setOffload,
    appctlPublicDays,
    // ubus method bodies (§3.1)
    appctlStatus, setAppctl, setAppPolicy,
    // passthrough for callers that need the shared bus (unused here)
    bus,
  };
}
