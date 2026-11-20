# wifiroam 守护进程 JS 重写规格文档

- **底版**：`~/workspace/work-1115/extracted/`（1115 版，1104 已作废，本规格不引用 1104 的任何内容）
- **主源码**：`wifiroam-0.1.0-r47/usr/share/wifiroam/wifiroamd.uc`，5498 行 ucode
- **启动脚本**：`wifiroam-0.1.0-r47/etc/init.d/wifiroam`
- **默认配置**：`wifiroam-0.1.0-r47/etc/config/wifiroam`
- **新二进制**：`wifiroam-0.1.0-r47/usr/sbin/wifiroam-dpi`（ARM aarch64 ELF，26512 字节，动态链接 musl，未 strip，带 debug_info）
- **前端**：`luci-app-wifiroam-0.261115.15302/www/luci-static/resources/`（纯 JS，只读；新增 `wifiroam/modelart.js`）
- **权限**：`luci-app-wifiroam-0.261115.15302/usr/share/rpcd/acl.d/luci-app-wifiroam.json`
- **版本口径**：守护进程 `DAEMON_VERSION = 5`（`wifiroamd.uc` 第 56 行）；前端 `REQUIRED_VERSION = 5`（`view/wifiroam/settings.js`）
- **文档性质**：只做规格，不写重写代码，不改任何底版文件。凡源码未写明处，一律列入 §9，不发明。

## 计数总览（以源码逐字核对为准）

| 项目 | 数量 | 说明 |
|---|---|---|
| 守护进程总行数 | 5498 | `wifiroamd.uc` |
| 具名函数 `function name(` | 164 | 任务书所称“164 个”即此口径 |
| 赋值式函数 `name = function(` | 25 | 含前向声明后赋值的跨定义调用函数 |
| 局部 `let name = function(` | 2 | `as_list`（`appctl_dnsmasq_sync` 内）、`pick`（`guest_lan_info` 内） |
| **函数定义总数** | **191** | 164 + 25 + 2；§2 表格列出全部 191 个，一个不漏 |
| ubus 对象 `wifiroam` 方法 | 31 | `api_obj`（第 4392–5196 行），与 ACL read 14 + write 17 一致 |
| 前端实际调用的 ubus 方法 | 30 | 除 `client_detail` 外全部 30 个前端有调用；`client_detail` 前端无调用（见 §3.4） |
| 对端 TCP 通道方法（CAP↔SAP） | 15 | `defer`/`request` 的 `method:`，见 §4.4 |
| `uloop.interval` 常驻定时器 | 12 | 全部以 `HELLO_INTERVAL` 或 `TICK_INTERVAL` 为周期，见 §5 |
| 一次性 `uloop.timer` | 4 处 | 300ms×2、1000ms、8000ms，见 §5.2 |
| `uloop.handle` 监听 | 2 | UDP 50607、TCP 50608 |
| `uloop.process` 异步进程 | 7 处 | `/sbin/wifi reload`×4、dnsmasq/firewall/network reload，见 §7 |
| `cmd_output` 调用点 | 约 50 处 | 全部经 `fs.popen`，见 §7 |
| 含糊/未闭环项 | 24 | 见 §9 |
| 建议 Node.js 模块 | 6 | 入口唯一 `wifiroamd.mjs`，见 §8 |

> **计数说明**：`grep -c 'function '` 得 164，但那只是具名函数；另有 27 个匿名函数赋值给具名变量（前向声明 `let …` 后赋值，原因是“ucode 单遍编译不提升函数声明，使用点必须晚于绑定点”，见第 242–247 行）。重写时这 27 个同样是独立函数，不可漏掉。§2 按行号升序列出全部 191 个；其中 `appctl_public_days` 在源码中紧邻 `api_obj`，其真实函数体仅为第 4377–4390 行（14 行），§2 按此计。

---

## 1. 总体架构

### 1.1 守护进程的角色

守护进程是“一机一进程”的多 AP 漫游编排器，角色由 UCI `wifiroam core.role` 决定，只有三种取值（`set_role` 校验白名单 `["cap","sap","unconfigured"]`，非法返回 `libubus.STATUS_INVALID_ARGUMENT`）：

| 角色 | 含义 | 关键行为 |
|---|---|---|
| `cap` | 主 AP（Controller AP） | 唯一可写配置的角色：`set_roam`/`set_backhaul`/`set_wifi`/`set_guest`/`set_appctl`/`set_app_policy`/`set_ban`/`ban_set`/`ban_del`/`ungroup_device` 均要求 `role == "cap"`，否则返回 `{ok:false,error:"not_cap"}`。持有 token，下发漫游/回程/Wi-Fi/访客/offload/别名配置，汇总全网拓扑与终端，执行应用管控、定时断网、11v 引导。 |
| `sap` | 子 AP（Satellite AP） | 通过 TCP 50608 主动连接 CAP（`sap_connect`），`auth` 后每 10 秒 `report_status` 上报本机终端；接受 CAP 的 push 配置并本地落盘；`set_alias`/`set_pin` 在 SAP 上不本地写，而是经通道 `defer` 转发给 CAP（`alias_update`/`pin_update`），CAP 广播回全网。`set_offload` 在 SAP 上先本地落盘再 `offload_request_cap` 请 CAP 执行。 |
| `unconfigured` | 未配置 | 只发 hello 参与发现（`udp_rx` 将其记入 `state.discovered`，保留 `nonce` 供配对）；不跑 `steer_tick`/`pin_tick`/`guest_tick`；可被 CAP 配对：CAP `pair` 发 `join{token,cap_ip,nonce_echo}`，`srv_rx` 校验 `nonce_echo == state.self.nonce` 且 token 非空后置 `role="sap"`、`token`、`cap_ip`，`save_config()`，300ms 后 `reconfigure()`。 |

角色切换路径：前端 `set_role`（`sap` 只能经配对进入，直接设 `sap` 返回 `{ok:false,error:"sap_via_pairing"}`；设 `cap` 时 `ensure_token()`；设 `unconfigured` 时清空 token 与 cap_ip）；`reconfigure()`（清空 peers、cap_learned、prev_clients、steer/pin 状态、nr_sig、cap_nr，重新 `send_hello()` 并 `ban_apply(true)`）；SAP 收到 `leave` 时 300ms 后先 `apply_roam_local({enabled:false,ssids:[],config_ver:0},[])` 再回 `unconfigured`。

### 1.2 进程内状态（`state`，第 249–302 行）

单例 `state` 对象是全部运行时状态，分组如下（重写时须逐字段保留，字段名逐字照抄）：

- **配置与本机**：`cfg{enabled,role,token,cap_ip,name}`、`self{}`（`detect_self` 填）、`brdev="br-lan"`、`bcast`（`detect_self` 算出，`lan_broadcast`）。
- **对端**：`peers{}`（macnorm→peer，含 `clients`（`null` = 未收过 report，首轮 diff 抑制）、`authed`、`chan`、`conn`、`info`、`last_seen` 等）、`discovered{}`（macnorm→`{mac,ip,name,model,nonce,last_seen}`）、`cap_learned`、`link`（SAP 出向通道 `{sock,chan,authed,ts,last_pong,cap_mac}`）、`roster`（SAP 收到的 CAP 全网概览）、`cap_nr`（CAP 下发的 11k 邻居元素）、`net_names`（CAP 下发的 macnorm→`{hostname,ip}`）。
- **别名/设备组**：`aliases{ver,map,groups,redirect,isolated,pin}`、`device_index`（原始 MAC→组 ID）、`device_obs`（本轮观察到的主机名/租约/在线证据）、`pin_last{}`、`devices{}`（组 ID→终端历史 `{mac,ip,hostname,first_seen,last_online,last_offline,online,ap,conn}`）、`dev_dirty`、`dev_saved`。
- **终端快照**：`events[]`（环形缓冲，上限 `MAX_EVENTS=100`）、`prev_clients`（`null` = 首轮不产事件）、`client_seen{}`、`client_bytes{}`（站点字节采样 `{ts,rx,tx}`）、`bytes_cache{}`（ifname→`{ts,map}`，1 秒内复用）、`wired_seen{}`、`wifi_seen{}`、`prev_owner`（`null` = 首轮抑制）。
- **版本与回执**：`roam_ver_applied`、`backhaul_ver_applied`、`last_apply`、`last_backhaul`、`last_wifi`、`last_guest`。
- **访客**：`guest_open`（`null` = 未知）、`guest_tc_sig`、`guest_tc_devs[]`、`_guest_nft_sig`、`_guest_zone_migrated`。
- **引导**：`steer_last{}`、`steer_tries{}`、`kick_last{}`、`steer_mute{}`、`nr_sig`。
- **应用管控**：`appctl{enabled,enhanced,strict,devices,stats,day,online,ndata}`、`_nft_snap`（上次 nft 计数快照 `"<mac>|<app>":{pk,by}`）、`_dnslock_on`（`null` = 未同步，首轮强制对齐）、`_appstat_ts`、`_appstat_dirty`、`_appstat_saved`、`_track_key`、`_warm_list`、`_warm_i`。
- **定时断网**：`ban{enabled,list,sig,active}`。

全局另有：`daemon_started = time()`（第 237 行，进程启动时刻，用于识别“重启后仍是旧进程”）、`ubusc`、`udp_sock`、`tcp_srv`，以及 xorshift32 的 `rng_state`（第 386 行）。

### 1.3 主循环与事件模型

单线程 uloop 事件循环，无多线程/多进程（除 `uloop.process` 派生的外部命令与后台启动的 `wifiroam-dpi`）：

- **入口 `main()`（第 5446–5496 行）**：`srand(time())` → `uloop.init()` → `libubus.connect(null, 60)`（失败则 `log("ubus connect failed")` 并 `exit(1)`）→ `load_config()` → `alias_load()` → `devlist_load()` → `detect_self()` → `device_group_refresh()` → `appctl_load()`（注释：建规则要用到本机接口/网桥信息，必须放在 `detect_self` 之后）→ `ban_load()` → `ensure_token()` → `roam_default_init()` → `setup_udp()` → `setup_tcp()` → `ubusc.publish("wifiroam", api_obj)` → 注册 12 个 `uloop.interval` → `send_hello()` → `log("started role=…")` → `uloop.run()`；文件末尾第 5498 行直接调用 `main()`。
- **uloop 句柄**：`uloop.handle(udp_sock.fileno(), udp_rx, uloop.ULOOP_READ)`（UDP 50607）；`uloop.handle(tcp_srv.fileno(), srv_accept, uloop.ULOOP_READ)`（TCP 50608）。
- **ubus 通道（libubus）**：源码头注释（第 6–9 行）写明三条语义——`libubus.open_channel(sock, rx_cb, disconnect_cb)`，`rx_cb(req)` 单参数；`channel.request({method, data, return:"ignore"})` 为 fire-and-forget；`channel.defer({method, data, data_cb, cb})` 为请求/响应（`data_cb` 为数据回调，`cb(rc)` 为完成回调，`rc != 0` 表示失败/超时）。`req.reply({...})` 用于服务端回执。重写时这三条语义必须保留，Node.js 侧需自行实现等价的 ubus-over-TCP 帧协议（见 §4.5 与 §9）。
- **失败即退出（fail-fast）**：UDP bind 失败（第 2819–2823 行）、TCP bind/listen 失败（第 3958–3962 行）、ubus 连接失败（第 5450–5454 行）均 `exit(1)`，注释写明“传输不可用 = 守护进程无意义，fail-fast 交 procd 处置” / “避免僵尸实例与正常实例竞争”。init 脚本 `procd_set_param respawn 3600 5 5`（3600 秒内最多 5 次重启，间隔 5 秒）承接重启。

### 1.4 启动流程（init 脚本）

`/etc/init.d/wifiroam`（19 行，`#!/bin/sh /etc/rc.common`，`START=99`，`STOP=10`，`USE_PROCD=1`）：

1. `start_service()` 先 `config_load wifiroam`，`config_get_bool enabled core enabled 1`；`enabled` 不为 1 则直接 `return 0`（不启动实例）。
2. `procd_open_instance wifiroam`；`procd_set_param command /usr/bin/ucode /usr/share/wifiroam/wifiroamd.uc`（即用 ucode 解释器执行，不编译、不打包）；`respawn 3600 5 5`；`stdout 1`、`stderr 1`（`log()` 的 `printf` 进 procd 日志）；`procd_close_instance`。
3. 无 `stop_service()`、`reload_service()` 等自定义函数；无 `service_triggers()`。因此“重启”即 procd stop + start；前端的版本修复逻辑（见 §3.4）依赖 `rc init wifiroam restart`。

### 1.5 依赖的 ucode 模块与外部服务

- `import`（第 12–17 行）：`ubus`、`uloop`、`socket`（`ucode-mod-socket`，只有二进制 `socket.so`，无源码）、`fs`、`uci`、`digest`（仅 `sha256`）。
- 运行时依赖的系统 ubus 对象：`network.interface.lan`、`network.wireless`、`hostapd.<ifname>`（见 §3.5）；依赖的系统服务/命令：`dnsmasq`、`firewall`、`network`、`wifi`、`nft`、`iw`、`ip`、`bridge`/`brctl`、`tc`、`nslookup`、`pidof`、`kill`、`date`、`apk`/`opkg`（见 §7）；依赖的外部二进制：`wifiroam-dpi`（见 §7.2）。
- 持久化位置（升级保留，见 `lib/apk/packages/wifiroam.conffiles` 与 `lib/upgrade/keep.d/wifiroam`）：`/etc/config/wifiroam`、`/etc/wifiroam/aliases.json`。另有运行时文件 `/etc/wifiroam/devices.json`、`/etc/wifiroam/appstats.json`、`/etc/wifiroam/nft_schema`（见 §6）。

---

## 2. 完整函数清单

> 191 个函数定义，按行号升序。`返回值`栏取函数体内第一条 `return` 语句原文（截断至 110 字）；无 `return` 者记“无（undefined）”。`调用者`栏为静态调用关系：具名调用者 + `ubus:<方法>`（该 ubus 方法处理函数体内调用）+ `main:uloop.interval(...)`（定时器注册）。注意：`api_obj` 内各 ubus 方法的 `call: function(req){…}` 是匿名函数，不计入 191 个；`sort`/`foreach`/`timer` 回调内的匿名函数同样不计。局部函数 `as_list`、`pick` 只在定义它们的函数内可见。
>
> 函数体跨度按“下一函数定义行 − 1”估算，仅作定位参考；`appctl_public_days` 按真实体 4377–4390 行计。

| 行号 | 函数名 | 参数 | 返回值 | 作用 | 调用者 |
|---|---|---|---|---|---|
| 305 | `log` | `msg` | 无（undefined） | 向 stdout 输出 `wifiroam: <msg>`（procd stdout/stderr 收集）。 | push_event, detect_self, apply_guest_local, setup_udp, apply_roam_local, apply_backhaul_local, backhaul_tick, sap_rx, sap_disconnect, sap_connect, sap_tick, sap_report, setup_tcp, peer_link_dead, ban_apply, neighbor_sync, steer_tick, pin_tick, ensure_token, roam_default_init, main |
| 307 | `macnorm` | `m` | return lc(replace(m ?? "", /[^0-9a-fA-F]/g, "")); } | 去分隔符并小写，得到 12 位十六进制 MAC（无冒号）。 | devnorm, device_members_of, device_alias_of, pin_apply, local_iface_macs, detect_self, parse_leases, parse_neigh, parse_fdb, station_bytes, local_clients, device_ungroup, udp_rx, ap_display, owner_events, build_topology, devlist_live, devlist_view, roam_key0, roam_key1, apply_roam_local, ssid_groups, ap_overview, precheck, sap_rx, conn_close, srv_rx, find_client, pin_tick, ubus:status, ubus:wake, ubus:ungroup_device, ubus:pair, ubus:unpair |
| 309 | `maccolon` | `mn` | if (length(mn) != 12) return mn; | 12 位 MAC 转大写冒号形式；非 12 位原样返回。 | client_name_of, appctl_apply_rules, appctl_dpi_write_blocklist, local_clients, device_merge_groups, device_ungroup, diff_events, expire_tick, ap_display, owner_events, client_node, build_topology, devlist_tick, devlist_view, member_list, ap_overview, apply_result_update, apply_wifi_result_update, apply_guest_result_update, apply_backhaul_result_update, ban_apply, steer_tick, pin_tick, ubus:wake, ubus:get_roam, ubus:set_roam, ubus:set_wifi, ubus:set_guest, ubus:set_backhaul, ubus:unpair |
| 317 | `devnorm` | `v` | if (match(s, /^g[0-9a-f]{12}$/)) return s; | 保留 `g<12hex>` 设备组 ID，否则等价于 macnorm。 | device_key, alias_apply, appctl_read_devices, sap_rx, srv_rx, ubus:client_detail |
| 323 | `mac_is_random` | `mn` | return length(mn) == 12 && index([ "2", "6", "a", "e" ], substr(mn, 1, 1)) >= 0; | 按首字节第二十六进制位（2/6/a/e）判断是否为随机（本地管理）MAC。 | device_group_refresh, device_ungroup |
| 328 | `device_key` | `v` | return key; | 把原始 MAC/组 ID 解析为稳定设备组 ID（经 redirect 链、device_index）。 | device_reindex, device_members_of, device_alias_of, pin_of, pin_apply, alias_apply, appctl_read_devices, appctl_write_device, appctl_apply_rules, appctl_sample, device_group_refresh, device_ungroup, online_sample, client_node, build_topology, devlist_live, devlist_normalize, ban_read, appctl_public_stats, appctl_public_days, ubus:status, ubus:wake, ubus:ban_set, ubus:ban_del, ubus:set_app_policy |
| 339 | `device_reindex` | `` | 无（undefined） | 按 aliases.groups/redirect 重建 device_index，并把 pin 记录迁移到新组 ID。 | alias_load, device_group_refresh, device_ungroup, sap_rx |
| 363 | `device_members_of` | `v` | if (g) return sort(keys(g.members ?? {})); | 返回设备组全部成员 MAC（已排序）；非组返回单 MAC；非法返回空数组。 | device_alias_of, alias_apply, appctl_dpi_write_blocklist, appctl_track_macs, client_node, find_client, ban_read, ban_apply, ubus:wake, ubus:ban_set |
| 371 | `device_alias_of` | `v` | if (al) return al; | 按组 ID→原始 MAC→成员 MAC 顺序查找别名记录。 | client_name_of, device_merge_groups, device_merge_evidence, client_node, devlist_view, ban_read |
| 387 | `srand` | `seed` | 无（undefined） | xorshift32 伪随机种子（`int(seed)&0x7fffffff`，0 时用 0x9e3779b9）。 | main |
| 391 | `rand` | `` | return rng_state & 0x7fffffff; | xorshift32 下一个伪随机数（&0x7fffffff）。 | randhex, ensure_token |
| 398 | `randhex` | `n` | return s; | 返回 n 个十六进制字符的随机串（每字符 `rand()%16`）。 | detect_self, srv_accept, ubus:set_backhaul |
| 405 | `cmd_output` | `cmd` | if (!f) return ""; | 经 `fs.popen(cmd,"r")` 执行 shell 命令并读全部 stdout；popen 失败返回空串。 | appctl_nft_schema, appctl_nft_base, appctl_apply_rules, appctl_hw_suspend, appctl_table_remove, appctl_dpi_pid, appctl_dpi_daemon, appctl_dnslock_apply, appctl_sample, appctl_warm_step, appctl_load, offload_apply, wireless_uplink, detect_uplink, apply_wifi_local, now_minutes, guest_netdevs, guest_nft_apply, guest_client_ips, guest_tc_cleanup, guest_tc_apply, guest_tick, parse_neigh, bridge_port_names, parse_fdb, station_bytes, precheck, ban_flush_flows, ban_apply, ubus:offload_status, ubus:set_appctl |
| 413 | `push_event` | `type, mac, info, name` | 无（undefined） | 向 state.events 环形缓冲追加 `{ts,type,mac,name,info}`，超 MAX_EVENTS(100) 截尾；并 log。 | guest_tick, device_merge_groups, diff_events, expire_tick, owner_events, apply_roam_local, apply_backhaul_local, backhaul_tick, sap_rx, srv_rx, steer_tick, pin_tick, ubus:pair, ubus:unpair |
| 422 | `client_name_of` | `mn, local` | if (al?.name != null && al.name != "") return al.name; | 终端展示名优先级：自定义别名 > 本机/对端 hostname > net_names > 冒号 MAC。 | diff_events, owner_events, steer_tick, pin_tick |
| 440 | `field_after` | `words, key` | return i >= 0 ? words[i + 1] : null; | 在词数组中找 key 并返回其后一词，找不到返回 null。 | detect_uplink, parse_neigh, parse_fdb |
| 446 | `load_config` | `` | 无（undefined） | 读 UCI `wifiroam` 的 core（enabled/role/token/cap_ip/name）进 state.cfg，并同步 roam/backhaul config_ver 与 alias_sync.ver。 | reconfigure, main |
| 462 | `save_config` | `` | 无（undefined） | 把 state.cfg 的 role/token/cap_ip/name 写回 UCI `wifiroam core` 并 commit。 | sap_rx, srv_rx, ensure_token, ubus:set_role |
| 472 | `rssi_preset` | `profile` | return { aggressive: -62, balanced: -70, conservative: -78 }[profile] ?? -70; | RSSI 档位阈值：aggressive -62 / balanced -70 / conservative -78，未知 -70。 | current_roam_cfg, roam_sig, apply_roam_local, ubus:set_roam |
| 476 | `current_roam_cfg` | `` | return { | 每次现读 UCI `wifiroam roam`，返回漫游配置对象（见 §6.1）；非 custom 档位时阈值强制取 preset，夹取 -95..-30。 | ap_overview, sap_rx, sap_report, srv_rx, push_roam_to, steer_tick, roam_default_init, ubus:status, ubus:get_roam, ubus:set_roam |
| 507 | `roam_sig` | `r` | return sha256(sprintf("%d\|%s\|%d\|%s\|%d\|%d\|%d\|%d\|%s\|%d", | 漫游配置内容签名：`sha256("enabled|ssids|r_fast|ft_mode|ft_over_ds|k_neighbor|k_beacon|v_bss_transition|rssi_profile|rssi_threshold")`。 | sap_rx, sap_report, srv_rx |
| 516 | `current_backhaul_cfg` | `` | return { | 现读 UCI `wifiroam backhaul`，返回 {enabled,ssid,key,device,config_ver}。 | detect_uplink, backhaul_tick, srv_rx, push_backhaul_to, ubus:status, ubus:get_backhaul, ubus:set_backhaul |
| 529 | `alias_load` | `` | 无（undefined） | 读 /etc/wifiroam/aliases.json（map/groups/redirect/isolated/pin/ver）进 state.aliases；失败视为首次启动；随后 device_reindex()。 | main |
| 545 | `alias_save` | `` | 无（undefined） | 把 state.aliases 全量写回 aliases.json，并把 ver 同步到 UCI `wifiroam alias_sync.ver`。 | pin_apply, alias_apply, device_group_refresh, device_ungroup, sap_rx |
| 559 | `pin_of` | `mn` | if (!pin) return null; | 查终端（经 device_key）的固定 AP（aliases.pin），无则 null。 | client_node, devlist_view, steer_tick, pin_tick |
| 565 | `pin_apply` | `mac, ap` | return { ok: false, error: "invalid_mac" }; | 设置/清除固定 AP：校验 MAC 与目标 AP（须为本机或已知 peer），ver=time()，alias_save()；返回 {ok,mac,ap} 或 {ok:false,error}。 | srv_rx, ubus:set_pin |
| 587 | `alias_apply` | `mac, name, icon, note` | if (length(mn) != 12 && !match(mn, /^g[0-9a-f]{12}$/)) return false; | 设置/清除终端别名（name/icon/note）；全空则删除；组内旧 MAC 别名清理；ver=time()，alias_save()；返回布尔。 | srv_rx, ubus:set_alias |
| 606 | `alias_broadcast` | `` | if (state.cfg.role != "cap") return; | CAP 向全部已认证 peer 的 channel defer `push_aliases`（data.aliases=state.aliases 全量）；写失败时断开该 peer。 | device_group_refresh, device_ungroup, srv_rx, ubus:set_alias, ubus:set_pin |
| 625 | `appctl_app` | `id` | if (a.id == id) return a; | 按 id 在 APP_DEFS 中找应用定义，未找到 null。 | appctl_dpi_write_blocklist, ubus:set_app_policy |
| 631 | `appctl_read_devices` | `` | if (length(mn) != 12 && !match(mn, /^g[0-9a-f]{12}$/)) return; | 读 UCI `wifiroam appdev` 各 section，合并同组重复项为 state.appctl.devices{mac/group:{name,block[]}} 并返回。 | appctl_apply_rules, appctl_dpi_write_blocklist, appctl_tick, appctl_load, ubus:ungroup_device, ubus:set_app_policy |
| 652 | `appctl_write_device` | `mn, blocks, name` | return; | 写/删 UCI `wifiroam appdev`：blocks 为空则删该组全部 section，否则首个 section 写 mac/name/block，删多余重复 section。 | ubus:set_app_policy |
| 682 | `appctl_dnsmasq_sync` | `on` | 无（undefined） | 同步 dhcp 的 `config ipset`（每应用 `wifiroam_<id>`，table=wifiroam，name=[id_v4,id_v6]，domain=域名）；清 @dnsmasq[0].nftset 残留与旧 _v6 段；返回是否变化（需重启 dnsmasq）。 | appctl_load, ubus:set_appctl |
| 687 | `as_list` | `v` | if (type(v) == "array") return v; | appctl_dnsmasq_sync 内局部函数：值归一化为数组（数组原样、非空字符串包一层、其余空数组）。 | — |
| 765 | `appctl_enhanced` | `` | return state.appctl.enhanced == true; | state.appctl.enhanced 是否为 true（精准模式开关）。 | appctl_timeout, appctl_sample, appctl_tick, appctl_load |
| 771 | `appctl_strict` | `` | return state.appctl.strict == true; | state.appctl.strict 是否为 true（严格模式开关）。 | appctl_apply_rules |
| 775 | `appctl_timeout` | `` | return appctl_enhanced() ? APP_SET_TIMEOUT_ENH : APP_SET_TIMEOUT; | nft set 元素超时：精准模式 30m，否则 12h（APP_SET_TIMEOUT）。 | appctl_nft_schema_id, appctl_nft_base |
| 783 | `appctl_nft_schema_id` | `` | return sha256(join("\|", parts)); | 按（超时/严格/各应用域名/封禁 MAC 集合）算 nft 规则 schema 的 sha256。 | appctl_nft_schema |
| 790 | `appctl_nft_schema` | `` | if (fs.readfile(APPCTL_SCHEMA_PATH) == schema) return false; | schema 与 /etc/wifiroam/nft_schema 文件比对，不一致则写新 schema 并返回 true（需重建规则）。 | appctl_load, ubus:set_appctl |
| 808 | `appctl_nft_base` | `` | 无（undefined） | 生成 nft 基础脚本：建表、建各应用 _v4/_v6 set（timeout、interval 标志）等（细节见 §7）。 | appctl_apply_rules |
| 834 | `appctl_apply_rules` | `` | 无（undefined） | 重建 inet wifiroam 表的转发统计/封禁规则：按 _track_key（终端集合签名）变化与否决定是否重建；写 /tmp/wifiroam-appctl.nft 后 `nft -f`。 | appctl_tick, appctl_load, ubus:ungroup_device, ubus:set_appctl, ubus:set_app_policy |
| 922 | `appctl_hw_suspend` | `on` | if (cur.get("firewall", "@defaults[0]") == null) return; | 精准模式开时暂停硬件 offload（改 firewall @defaults[0] flow_offloading/hw 并 reload firewall），关时恢复（细节见 §7/含糊项）。 | appctl_load, ubus:set_appctl |
| 949 | `appctl_table_remove` | `` | 无（undefined） | 删 inet wifiroam nft 表，并 stop wifiroam-dpi。 | ubus:set_appctl |
| 963 | `appctl_dpi_write_blocklist` | `` | 无（undefined） | 按 appctl 设备封禁表生成 DPI blocklist：每行 `<冒号MAC> <逗号分隔域名>`，写 /tmp/wifiroam/dpi_blocklist。 | appctl_dpi_daemon |
| 986 | `appctl_dpi_pid` | `` | if (live != "") return split(live, " ")[0];   /* first match */ | 取运行中 wifiroam-dpi 的 PID：先 `pidof` 首个，否则读 pidfile 并 `kill -0` 校验；无则空串。 | appctl_dpi_daemon |
| 996 | `appctl_dpi_daemon` | `action` | return; | 管理 wifiroam-dpi：start（写 blocklist；已运行则 SIGHUP，否则后台启动并写 pidfile）、stop（kill + 删 pidfile）、reload（已运行则写 blocklist + SIGHUP）。 | appctl_table_remove, appctl_tick, appctl_load, ubus:ungroup_device, ubus:set_appctl, ubus:set_app_policy |
| 1031 | `appctl_dnslock_apply` | `on` | if (on == state._dnslock_on) return; | DNS 出口锁定：建/删 dnsnat（53 重定向）与 dnslock（拦 853 与 DoH IP 的 443）链；与上次状态相同则跳过。 | appctl_tick, appctl_load, ubus:set_appctl |
| 1065 | `prune_days` | `map, keep` | 无（undefined） | 按天分桶字典只保留最近 keep（默认 7）天，删字典序最旧的键。 | appctl_roll_day |
| 1073 | `appctl_roll_day` | `` | if (state.appctl.day == day) return; | 跨天时清零各应用 today/btoday 并 prune 各天分桶，置 _appstat_dirty。 | appctl_tick |
| 1092 | `appctl_add_time` | `mn, app, dt, now` | 无（undefined） | 给某终端某应用累计使用时长（today/total/last/按天 days），置脏标志。 | appctl_sample |
| 1106 | `appctl_add_bytes` | `mn, app, by, now` | if (by <= 0) return; | 给某终端某应用累计字节（btoday/btotal/按天 bdays）；by<=0 返回。 | appctl_sample |
| 1120 | `appctl_add_traffic` | `mn, by` | if (by <= 0) return; | 给某终端累计总流量（ndata 按天）；by<=0 返回。 | appctl_sample |
| 1130 | `appctl_sample` | `` | if (state.cfg.role != "cap" \|\| !state.appctl.enabled) return; | 每轮读 `nft -j list table inet wifiroam` 计数快照，差分包数/字节，达 APP_ACT 阈值才累计时长；同时采样在线时长。 | appctl_tick |
| 1209 | `appstats_load` | `` | 无（undefined） | 读 /etc/wifiroam/appstats.json 恢复统计（stats/online/ndata/day）。 | appctl_load |
| 1221 | `appstats_save` | `` | 无（undefined） | 把统计写回 appstats.json（节流 APPSTATS_FLUSH=15s，脏才写）。 | appctl_tick |
| 1234 | `appctl_warm_list` | `` | return out; | 生成 DNS 预热清单：APP_DEFS 各应用 domains + douyin probes 扁平化。 | appctl_warm_step |
| 1249 | `appctl_warm_step` | `` | if (!length(list)) return; | 每轮对清单中下一个主机名 `timeout 3 nslookup <host> 127.0.0.1`（预热 dnsmasq→nft set）。 | appctl_tick |
| 1260 | `appctl_tick` | `` | 无（undefined） | 每 10s：roll_day、read_devices、track_macs、sample、warm_step、重建规则（需要时）、DNS 锁同步、DPI reload（分组变化时）、appstats_save、ban_apply、device_group_refresh。 | main:uloop.interval(TICK_INTERVAL) |
| 1284 | `appctl_load` | `` | return; | 启动时加载 appctl：读 UCI appctl 开关、读设备与统计、dnsmasq 同步、按开关建规则/启动 DPI 或清表、硬件 offload 暂停与否。 | main |
| 1316 | `offload_apply` | `on` | if (cur.get("firewall", "@defaults[0]") == null) return false; | 写 firewall @defaults[0] 的 flow_offloading/flow_offloading_hw（开=1/关=0？见 §7）并 reload firewall；无 @defaults[0] 返回 false。 | sap_rx, srv_rx, ubus:set_offload |
| 1333 | `offload_request_cap` | `on` | if (!link?.authed) return false; | SAP 经 CAP 通道 defer `set_offload`，请 CAP 执行 offload 变更；未认证返回 false。 | ubus:set_offload |
| 1349 | `lan_broadcast` | `ip, mask` | if (length(parts) != 4) return "255.255.255.255"; | 由 LAN IP 与掩码算广播地址；解析失败返回 255.255.255.255。 | detect_self |
| 1364 | `local_iface_macs` | `` | return out; | 读 /sys/class/net/*/address 得到本机全部接口 MAC（macnorm 后）。 | detect_self |
| 1374 | `detect_self` | `` | 无（undefined） | 探测本机：读 /proc/sys/kernel/hostname、/tmp/sysinfo/model、/etc/openwrt_release、network.interface.lan 状态，填 state.self 与 state.bcast、nonce（randhex）。 | main |
| 1410 | `wireless_uplink` | `` | if (ifc.section == BACKHAUL_SECTION) return info; | 在 network.wireless 状态中找 mode=sta 的接口（排除回程段），返回无线上行信息。 | detect_uplink |
| 1433 | `detect_uplink` | `` | return { type: "wireless", port: wl.port, gw, ssid: wl.ssid, | （见正文/按名义：内部辅助） | self_info, build_topology |
| 1448 | `self_uptime` | `` | return int(split(trim(fs.readfile("/proc/uptime") ?? "0"), " ")[0]); | （见正文/按名义：内部辅助） | self_info, build_topology, ubus:status |
| 1452 | `wifi_ifaces` | `` | if (s.mode && s.mode != "ap") return; | （见正文/按名义：内部辅助） | self_info, ssid_groups, ap_overview, roam_default_init |
| 1474 | `ap_nr_self` | `` | try { ws = ubusc.call("network.wireless", "status") ?? {}; } catch (e) { return out; } | 经 network.wireless status + 各 hostapd.<ifname> 的 rrm_nr_get_own/get_status，返回本机各 BSS 的 {bssid,ssid,nr,band,channel,ifname}。 | ap_nr_public, steer_bss_list, steer_tick |
| 1503 | `ap_nr_public` | `` | return out; | ap_nr_self 去掉 ifname 后的公开版（供 CAP 下发）。 | self_info |
| 1511 | `self_info` | `` | return { | 返回本机信息对象 {mac,ip,name,model,firmware,hostname,uptime,role,uplink,ifaces,nr,…}（供 SAP 上报与 CAP 汇总）。 | sap_report |
| 1526 | `wifi_summary` | `` | if (s.mode && s.mode != "ap") return; | 返回本机 Wi-Fi 概览 {ifaces:[{band,ssid,encryption,key?/has_key,…}],…}（get_wifi 用；含密码与否见 §9）。 | sap_rx, ubus:get_wifi, ubus:set_wifi |
| 1561 | `apply_wifi_local` | `ssids` | if (s.mode && s.mode != "ap") return; | 按 [{band,ssid,key}] 改写本地 wireless 各 ap 口的 ssid/key（按频段匹配），commit 后异步 `/sbin/wifi reload`；返回 {ok,…}。 | sap_rx, ubus:set_wifi |
| 1592 | `roam_rename_ssids` | `pairs` | if (hit == 0) return; | 按 [{old,new}] 把 UCI `wifiroam roam.ssids` 中的旧 SSID 改为新 SSID（仅改名时调用）。 | sap_rx, ubus:set_wifi |
| 1625 | `hhmm_minutes` | `s` | if (length(f) != 2) return null; | "HH:MM" 转分钟数，格式非法返回 null。 | now_minutes, guest_open_now, guest_save_local, ubus:set_guest |
| 1633 | `now_minutes` | `` | return hhmm_minutes(s) ?? 0; | 经 `date +%H:%M` 取当前本地时间分钟数。 | guest_open_now |
| 1638 | `guest_cfg` | `` | return { | 现读 UCI `wifiroam guest`，返回访客配置 {enabled,ssid,key,bandwidth,schedule,start,end,allow_lan,ver}。 | guest_summary, guest_tick, sap_rx, sap_report, srv_rx, ubus:set_guest |
| 1655 | `guest_open_now` | `cfg` | if (!cfg.enabled) return false; | 访客是否在开放时段：未启用 false；无 schedule 则 true；否则 start/end 分钟比较（含跨午夜）。 | guest_summary, guest_write_wireless, guest_port_sync, apply_guest_local, guest_tick |
| 1665 | `guest_summary` | `` | if (s.wifiroam_guest != "1") return; | 返回访客网络摘要：配置 + open（当前是否开放）+ 本机访客口状态（get_guest 用）。 | ubus:get_guest |
| 1688 | `mask_prefix` | `m` | if (index(m ?? "", ".") < 0) return int(m ?? "24"); | 掩码（点分或位数）转前缀长度。 | ipv4_cidr |
| 1703 | `ipv4_cidr` | `ipmask, mask` | return sprintf("%s.%s.%s.%s/%d", o[3], o[2], o[1], o[0], prefix); | 把 IP 与掩码拼成 CIDR 字符串（源码中字节序经 o[3],o[2],o[1],o[0] 重排，见 §9）。 | pick |
| 1721 | `guest_lan_info` | `` | 无（undefined） | 返回访客子网信息（GUEST_IP/GUEST_NET、接口/桥等；pick 局部函数取数组首项或原值）。 | guest_nft_apply |
| 1727 | `pick` | `v` | if (type(v) == "array") return v[0]; | guest_lan_info 内局部函数：数组取首项，否则原样返回。 | — |
| 1743 | `guest_netdevs` | `ssid` | return out; | 经 `iw dev` 解析出访客 SSID 对应的 netdev（vif）名列表。 | guest_tc_apply, guest_port_sync |
| 1757 | `guest_write_wireless` | `cfg` | if (s.wifiroam_guest != "1") return; | 写/删访客 wifi-iface（wifiroam_guest=1 标记）：按开放时段决定是否建口、SSID/密码/加密。 | apply_guest_local |
| 1796 | `guest_remove_infra` | `` | 无（undefined） | 删除访客网络的基础设施配置（network interface、dhcp、firewall zone/forwarding 等 UCI 段）。 | apply_guest_local |
| 1822 | `guest_write_infra` | `cfg` | 无（undefined） | 创建访客基础设施：network 接口（静态 172.16.10.1/24，挂 br-guest）、dhcp、firewall zone 与转发/SNAT 段；并做 zone 的 device+subnet 迁移。 | apply_guest_local, guest_tick |
| 1928 | `guest_nft_apply` | `cfg` | if (sig == state._guest_nft_sig) return; | 按签名去重后重建 inet wifiroam_guest nft 表：访客隔离（禁访 LAN）与子 AP SNAT 规则；签名不变跳过。 | guest_after_reload, guest_tick |
| 1960 | `guest_client_ips` | `` | return out; | 经 `ip neigh show dev br-guest` 取访客终端 IP 列表。 | guest_tc_apply |
| 1984 | `guest_tc_cleanup` | `keep` | 无（undefined） | 删除指定（或全部访客）netdev 上的 HTB qdisc（`tc qdisc del … root`）。 | guest_tc_apply |
| 1996 | `guest_tc_apply` | `cfg` | return; | 按 bandwidth 给各访客 vif 挂 HTB 限速（root 1: htb，class 1:20 默认 + 每 IP class/filter）；bandwidth=0 则清理。 | guest_after_reload, guest_tick |
| 2045 | `guest_port_sync` | `cfg, cb, tries` | return; | 访客口同步重试：等 guest_netdevs 出现（最多重试，间隔 1000ms 定时器），就绪后调回调 cb；超时则放弃（见 §9）。 | apply_guest_local, guest_tick |
| 2075 | `guest_after_reload` | `cfg` | 无（undefined） | network/firewall reload 完成后：guest_nft_apply + guest_tc_apply。 | apply_guest_local, guest_tick |
| 2086 | `apply_guest_local` | `cfg` | return { ok: true }; | 访客本地生效总入口：按 open 时段决定写无线/基础设施或移除，随后 guest_port_sync→reload 链；返回 {ok}。 | sap_rx, ubus:set_guest |
| 2107 | `guest_save_local` | `g` | if (enabled && (length(ssid) < 1 \|\| length(ssid) > 32)) return false; | 校验并保存访客配置到 UCI `wifiroam guest`（ver+1）；非法返回 false。 | sap_rx, ubus:set_guest |
| 2136 | `guest_tick` | `` | if (state.cfg.role == "unconfigured") return; | 每 10s：unconfigured 跳过；按开放时段变化重建/移除访客口、同步 nft/tc、端口同步、事件。 | main:uloop.interval(TICK_INTERVAL) |
| 2185 | `freq_band` | `f` | if (!f) return null; | 频率（MHz）转频段标识（2g/5g/6g），无法判断 null。 | local_clients |
| 2192 | `parse_leases` | `` | if (!data) return out; | 读 /tmp/dhcp.leases，返回 macnorm→{ip,hostname}。 | client_names, local_clients, device_group_refresh, build_topology, devlist_live, find_client, ban_read |
| 2210 | `parse_neigh` | `` | return out; | 经 `ip neigh show dev br-lan` 解析 ARP 邻居，返回 macnorm→{ip}。 | client_names, local_clients, build_topology, devlist_live, find_client |
| 2228 | `client_names` | `` | return out; | 合并 leases 与 neigh，返回 macnorm→{hostname,ip}（供 CAP 下发给 SAP）。 | srv_rx |
| 2239 | `bridge_port_names` | `` | return map; | 经 `brctl showstp br-lan` 解析网桥端口名→端口号映射。 | parse_fdb |
| 2249 | `parse_fdb` | `` | return out; | 经 `bridge fdb show br br-lan`（回退 `brctl showmacs`）解析 FDB，返回 macnorm→端口名。 | local_clients, ethernet_uplink_port |
| 2282 | `station_bytes` | `ifname` | if (cache && now - cache.ts <= 1) return cache.map; | 经 `iw dev <ifname> station dump` 解析各站点收发字节；1 秒内复用 bytes_cache。 | local_clients |
| 2311 | `local_clients` | `` | return clients; | 本机终端全表（160 行核心函数）：hostapd get_clients 得无线终端（速率换算、实时速率差分），leases/neigh/net_names 补 IP/主机名，FDB+WIRED_TTL 得有线终端，排除 AP 自身接口/级联口/组播 MAC；返回 macnorm→客户端对象。 | device_group_refresh, appctl_track_macs, online_sample, build_topology, devlist_live, sap_report, srv_rx, find_client, steer_tick, pin_tick, main, ubus:status |
| 2471 | `device_host_key` | `v` | return lc(trim(replace(v ?? "", /[_ ]+/g, "-"))); | 主机名归一化：小写、trim、`[_ ]+`→`-`。 | device_generic_host, device_merge_evidence, device_group_refresh |
| 2475 | `device_generic_host` | `v` | return h == "" \|\| index([ | 判断主机名是否为通用名（如 `*`、空、常见默认名等，见 §9）——通用名不作为分组证据。 | device_merge_evidence, device_group_refresh |
| 2483 | `device_group_auto` | `g` | if (state.aliases.isolated[mn]) return false; | 判断某设备组是否允许自动合并（isolated 组返回 false）。 | device_merge_evidence, device_group_refresh |
| 2489 | `device_new_group` | `mn, salt` | return gid; | 新建设备组 ID：`g` + 某 MAC 的 12 位（salt 参与？见 §9），并初始化 members。 | device_group_refresh, device_ungroup |
| 2502 | `device_merge_groups` | `a, b` | return a; | 合并两个设备组（成员、别名、pin 等并入 a，b 变 redirect→a），发事件；返回保留的组 ID。 | device_group_refresh |
| 2522 | `device_merge_evidence` | `a, b` | if (!device_group_auto(ga) \|\| !device_group_auto(gb)) return null; | 判断两组观察证据是否指向同一物理设备（主机名/租约/IP 等），可合并返回证据/组，否则 null。 | device_group_refresh |
| 2568 | `device_group_refresh` | `` | if (state.cfg.role != "cap") return; | CAP 侧设备分组刷新：按 device_obs（主机名、租约、在线证据）把出厂 MAC 与随机 MAC 合并/拆分；分组变化时 alias_save + alias_broadcast + DPI reload（appctl_tick 内）。 | appctl_tick, build_topology, devlist_view, main |
| 2666 | `device_ungroup` | `mac` | if (!g?.members?.[mn]) return { ok: false, error: "not_found" }; | 把某 MAC 从其设备组拆出为独立组（isolated 标记），清理相关别名/统计映射；返回 {ok} 或 {ok:false,error}。 | ubus:ungroup_device |
| 2702 | `appctl_track_macs` | `` | return set; | 返回当前需建 nft 规则的终端 MAC 集合（local_clients + appctl 设备，去重、展开组成员）。 | appctl_apply_rules, appctl_tick |
| 2715 | `online_sample` | `` | if (state.cfg.role != "cap") return; | CAP 每轮采样在线时长：对当前在线终端按设备组累计 online 天分桶。 | appctl_tick |
| 2738 | `diff_events` | `prev, cur, apname` | 无（undefined） | 比较前后两轮客户端表，产生 join/leave 事件（首轮 prev=null 时抑制）。 | sap_report, srv_rx, main |
| 2746 | `udp_send` | `obj` | if (!udp_sock) return; | 把对象 JSON（`%.J`）经 UDP 发往 state.bcast（默认 255.255.255.255）:50607。 | send_hello |
| 2752 | `send_hello` | `` | 无（undefined） | 广播 hello（magic/ver/role/mac/ip/name/model/nonce/thash/alias_ver/ts）。 | reconfigure, main, main:uloop.interval(HELLO_INTERVAL) |
| 2763 | `udp_rx` | `` | 无（undefined） | UDP 50607 接收循环：JSON 解析、MAGIC 校验、排除本机；unconfigured 进 discovered；同 token（thash 比对）的 cap/sap 更新 peers 与 cap_learned。 | — |
| 2798 | `expire_tick` | `` | 无（undefined） | 每 10s：peers 超 PEER_TTL(30s) 未见 hello 则删并发 ap_offline 事件、断开其 channel；discovered 超 DISCOVER_TTL(180s) 删除。 | main:uloop.interval(TICK_INTERVAL) |
| 2813 | `setup_udp` | `` | if (!udp_sock) { log("udp create failed"); return; } | 建 UDP socket（AF_INET/SOCK_DGRAM/NONBLOCK，SO_REUSEADDR+SO_BROADCAST），bind 0.0.0.0:50607，uloop.handle 读事件→udp_rx；bind 失败 exit(1)。 | main |
| 2828 | `ap_display` | `mn` | if (mn == macnorm(state.self.mac)) return state.self.name; | AP 显示名：本机返回 self.name，否则 peer 名，未知返回冒号 MAC。 | owner_events, client_node, devlist_view, pin_tick |
| 2836 | `compute_owner` | `my, self_mn` | return owner; | 按（本机客户端表）计算每终端归属 AP：同 MAC 多 AP 出现时按规则选一（见 §4/§9）。 | owner_events, build_topology, devlist_live |
| 2852 | `owner_events` | `my` | if (state.cfg.role != "cap") return; | CAP 视角：归属变化时发 roam_move 事件（prev_owner 首轮抑制）。 | srv_rx, main |
| 2866 | `client_node` | `mn, c, parent` | return { | 把一终端构造成拓扑节点对象（见 §3.2：id/name/members/grouped/conn/pin/icon 等）。 | build_topology, devlist_view, find_client |
| 2894 | `build_topology` | `` | return { nodes, self: self_mn, role: state.cfg.role, now: time() }; | 构造全网拓扑 {nodes,self,role,now}：本机 AP 节点 + 各 peer AP 节点 + 按 compute_owner 去重归属后的终端节点（leases/neigh 补全）。 | sap_rx, srv_rx, ubus:topology |
| 2968 | `devlist_live` | `` | return live; | 全网当前在线终端表（与 build_topology 相同归属与补全规则），返回 设备组 ID→{mn,c,ap}。 | devlist_tick |
| 2993 | `devlist_load` | `` | 无（undefined） | 读 /etc/wifiroam/devices.json 恢复终端历史 state.devices。 | main |
| 3007 | `devlist_save` | `force` | if (!state.dev_dirty) return; | 历史有变更且距上次落盘 ≥DEVICES_FLUSH(60s) 或 force 时，把 state.devices 写回 devices.json。 | devlist_tick |
| 3018 | `devlist_trim` | `` | if (total <= DEVICES_MAX) return; | 历史超 DEVICES_MAX(512) 时淘汰最久未上线记录。 | devlist_tick |
| 3034 | `devlist_merge_entry` | `dstk, src` | if (!dst) { state.devices[dstk] = src; return; } | （见正文/按名义：内部辅助） | devlist_normalize |
| 3056 | `devlist_normalize` | `` | return changed; | （见正文/按名义：内部辅助） | devlist_tick |
| 3070 | `devlist_tick` | `` | return live; | （见正文/按名义：内部辅助） | devlist_view, main:uloop.interval(TICK_INTERVAL) |
| 3099 | `devlist_view` | `` | if (a.online != b.online) return a.online ? -1 : 1; | （见正文/按名义：内部辅助） | ubus:device_history |
| 3150 | `wol_packet` | `mn` | return pkt; | （见正文/按名义：内部辅助） | wol_send |
| 3160 | `wol_send` | `mn` | if (!sock) return 0; | （见正文/按名义：内部辅助） | ubus:wake |
| 3185 | `roam_md` | `ssid` | return substr(sha256("md:" + ssid), 0, 4); } | （见正文/按名义：内部辅助） | apply_roam_local |
| 3186 | `roam_key0` | `mac` | return substr(sha256(state.cfg.token + ":r0:" + macnorm(mac)), 0, 32); } | （见正文/按名义：内部辅助） | apply_roam_local |
| 3187 | `roam_key1` | `mac` | return substr(sha256(state.cfg.token + ":r1:" + macnorm(mac)), 0, 32); } | （见正文/按名义：内部辅助） | apply_roam_local |
| 3189 | `member_list` | `` | return members; | （见正文/按名义：内部辅助） | push_roam_to, roam_default_init, ubus:get_roam, ubus:set_roam |
| 3198 | `apply_roam_local` | `roam, members` | if (s.mode && s.mode != "ap") return; | （见正文/按名义：内部辅助） | sap_rx, roam_default_init, ubus:set_roam |
| 3299 | `applied_kvr` | `ssids` | if (s.mode && s.mode != "ap") return; | （见正文/按名义：内部辅助） | ap_overview, sap_rx, sap_report, roam_default_init, ubus:status, ubus:get_roam, ubus:set_roam |
| 3317 | `wifi_radios` | `` | return out; | （见正文/按名义：内部辅助） | pick_radio, ubus:get_backhaul |
| 3330 | `pick_radio` | `prefer` | if (!r.disabled && r.name == prefer) return r.name; | （见正文/按名义：内部辅助） | apply_backhaul_local |
| 3343 | `ethernet_uplink_port` | `` | return port; | （见正文/按名义：内部辅助） | apply_backhaul_local, backhaul_tick |
| 3356 | `apply_backhaul_local` | `bh, role` | if (!dev) return { ok: false, error: "no_radio" }; | （见正文/按名义：内部辅助） | sap_rx, ubus:set_backhaul |
| 3404 | `backhaul_tick` | `` | if (state.cfg.role != "sap") return; | （见正文/按名义：内部辅助） | main:uloop.interval(TICK_INTERVAL) |
| 3423 | `ssid_groups` | `` | return out; | （见正文/按名义：内部辅助） | ap_overview, ubus:get_roam |
| 3459 | `ap_overview` | `` | ssids: map(wifi_ifaces(), function(w) { return w.ssid; }), | （见正文/按名义：内部辅助） | precheck, srv_rx |
| 3483 | `precheck` | `` | return { checks, groups, role: state.cfg.role, aps }; | （见正文/按名义：内部辅助） | ubus:precheck |
| 3528 | `sap_rx` | `req` | if (!link \|\| !link.chan) return 0; | SAP 侧 TCP 通道接收回调：未认证时处理 hello→defer auth；已认证时 switch 处理 push_roam_config/push_aliases/push_backhaul_config/push_wifi_config/push_guest_config/push_offload/get_client_detail/get_topology/leave；返回 0。 | — |
| 3668 | `sap_disconnect` | `` | if (!link) return; | 断开 SAP→CAP 链路：chan.disconnect + sock.close，CAP peer 置 authed=false，state.link=null。 | sap_rx, sap_connect, sap_tick, sap_report, reconfigure, ubus:set_alias, ubus:set_pin |
| 3679 | `sap_connect` | `cap_ip` | if (!addr) return; | SAP 向 cap_ip 建 TCP socket（SOCK_STREAM/NONBLOCK），libubus.open_channel(sock,sap_rx,sap_disconnect)，置 state.link（authed=false）。 | sap_tick |
| 3693 | `sap_tick` | `` | if (state.cfg.role != "sap") return; | 每 10s（仅 SAP）：已认证且 last_pong 超 45s 则断开重连；未连接则按 cfg.cap_ip 或 cap_learned 连接。 | main:uloop.interval(TICK_INTERVAL) |
| 3709 | `sap_report` | `` | if (state.cfg.role != "sap" \|\| !state.link?.authed) return; | 每 10s（仅 SAP，已认证）：上报 report_status（info/clients/alias_ver/roam_ver/roam_sig/backhaul_ver/guest_ver/kvr），回执刷新 last_pong/net_names/roster/cap_nr；失败断开。 | sap_rx, main:uloop.interval(TICK_INTERVAL) |
| 3751 | `conn_close` | `conn` | 无（undefined） | 关闭一条 TCP 连接：chan.disconnect + sock.close，清除对应 peer 的 conn/chan/authed。 | alias_broadcast, srv_rx, srv_accept, peer_link_dead |
| 3765 | `srv_rx` | `conn, req` | return 0; | CAP/全角色 TCP 服务端接收回调（169 行）：未认证处理 join（配对）与 auth；已认证处理 report_status/report_event/set_offload/get_topology/get_client_detail/alias_update/pin_update；未知方法回 {ok:false,error:"unknown_method"}。 | srv_accept |
| 3934 | `srv_accept` | `` | function(req) { return srv_rx(conn, req); }, | TCP 监听接受循环：accept 后建 conn{nonce:randhex(16)}，open_channel(srv_rx,conn_close)，立即 request hello{mac,role,nonce}（return:"ignore"）。 | — |
| 3953 | `setup_tcp` | `` | if (!tcp_srv) { log("tcp create failed"); return; } | 建 TCP 监听 socket（AF_INET/SOCK_STREAM/NONBLOCK，SO_REUSEADDR），bind 0.0.0.0:50608，listen(8)，uloop.handle→srv_accept；失败 exit(1)。 | main |
| 3968 | `peer_link_dead` | `mn, what` | if (!p) return; | 某 peer 通道写失败时：log，断开其 conn/chan，置 authed=false（避免僵尸连接）。 | push_aliases_to, push_roam_to, push_backhaul_to, push_wifi_to, push_guest_to, push_offload_to |
| 3977 | `push_aliases_to` | `mn` | if (!p?.authed \|\| !p.chan) return; | CAP 向指定 peer defer `push_aliases`（data.aliases 全量）；未认证/无通道返回（false）。 | srv_rx |
| 3991 | `push_roam_to` | `mn` | if (!p?.authed \|\| !p.chan) return false; | CAP 向指定 peer defer `push_roam_config`（data.roam+members），data_cb 经 apply_result_update 更新 last_apply；失败 peer_link_dead。 | srv_rx, ubus:set_roam |
| 4022 | `apply_result_update` | `mn, name, ok, ver, err, kvr` | if (!state.last_apply) return; | 更新 state.last_apply.results 中指定 AP 的 {ok,ver,error,kvr} 回执项。 | push_roam_to |
| 4032 | `push_backhaul_to` | `mn` | if (!p?.authed \|\| !p.chan) return false; | CAP 向指定 peer defer `push_backhaul_config`，回执经 apply_backhaul_result_update 更新 last_backhaul。 | srv_rx, ubus:set_backhaul |
| 4063 | `push_wifi_to` | `mn, ssids` | if (!p?.authed \|\| !p.chan) return false; | CAP 向指定 peer defer `push_wifi_config`（data.ssids），回执经 apply_wifi_result_update 更新 last_wifi。 | ubus:set_wifi |
| 4091 | `apply_wifi_result_update` | `mn, ok, err` | if (!state.last_wifi) return; | 更新 state.last_wifi.results 中指定 AP 的回执。 | push_wifi_to |
| 4101 | `push_guest_to` | `mn, cfg` | if (!p?.authed \|\| !p.chan) return false; | CAP 向指定 peer defer `push_guest_config`（data.guest），回执经 apply_guest_result_update 更新 last_guest。 | srv_rx, ubus:set_guest |
| 4129 | `apply_guest_result_update` | `mn, ok, err` | if (!state.last_guest) return; | 更新 state.last_guest.results 中指定 AP 的回执。 | push_guest_to |
| 4138 | `apply_backhaul_result_update` | `mn, name, ok, ver, err` | if (!state.last_backhaul) return; | 更新 state.last_backhaul.results 中指定 AP 的回执。 | push_backhaul_to |
| 4148 | `push_offload_to` | `mn` | if (!p?.authed \|\| !p.chan) return; | CAP 向指定 peer defer `push_offload`（data.enabled），无回执更新（fire-and-forget 式 defer，空回调）。 | srv_rx, ubus:set_offload |
| 4166 | `find_client` | `key` | if (!best) return null; | 在全网终端中找一终端：先本地 local_clients，再各 peer clients，按设备组/成员匹配；返回 {node,ap} 或 null。 | sap_rx, srv_rx, ubus:client_detail, ubus:ban_set, ubus:set_app_policy |
| 4196 | `ban_hm` | `v` | if (!m) return null; | "HH:MM" 或分钟数转分钟（0..1439），非法 null。 | ban_read, ban_in_window, ubus:ban_set |
| 4204 | `ban_hm_str` | `mins` | return sprintf("%02d:%02d", mins / 60, mins % 60); | 分钟数转 "HH:MM"（%02d 格式）。 | ban_read, ubus:ban_set |
| 4208 | `ban_weekdays` | `v` | return out; | 星期字段归一化：字符串按空格/逗号拆、数字 0..6（或 1..7？见 §9）去重排序；非法/空返回空数组。 | ban_read, ubus:ban_set |
| 4220 | `ban_read` | `` | if ((length(mn) != 12 && !match(mn, /^g[0-9a-f]{12}$/)) \|\| seen[mn]) return; | 读 UCI `wifiroam ban` 全部规则，展开设备组为成员，补 name（别名/终端名），返回 [{mac,name,timeon,timeoff,weekdays,…}]。 | ban_apply, ubus:ban_list |
| 4246 | `ban_in_window` | `b, lt, nowmin` | if (!length(b.weekdays)) return false; | 判断某 ban 规则在给定本地时间（lt/nowmin）与星期下是否生效（含跨午夜时段）。 | ban_apply, ubus:ban_list |
| 4263 | `ban_flush_flows` | `` | 无（undefined） | 冲掉被禁终端的 conntrack/flowtable 条目：`nft list flowtables` 后逐条 flush（见 §7）。 | ban_apply |
| 4275 | `ban_apply` | `force` | return macs; | 定时断网生效：按 ban_read 与当前时间算 active 集合（展开成员 MAC），变化或 force 时重建 inet wifiroam_ban 表（/tmp/wifiroam-ban.nft，`nft -f`），并 ban_flush_flows；返回生效 MAC 数组。 | appctl_tick, ban_load, ban_tick, reconfigure, ubus:ungroup_device, ubus:set_ban, ubus:ban_set, ubus:ban_del |
| 4325 | `ban_rule_count` | `` | return n; | UCI `wifiroam ban` 的规则条数。 | ban_reload_enabled |
| 4334 | `ban_reload_enabled` | `` | return state.ban.enabled; | 重读总开关：无规则时默认关；有规则且未显式配置时默认开（见 §9）；返回 state.ban.enabled。 | ban_load, ubus:ban_set, ubus:ban_del |
| 4342 | `ban_load` | `` | 无（undefined） | 启动加载 ban：ban_reload_enabled + ban_apply(true)。 | main |
| 4347 | `ban_tick` | `` | if (state.cfg.role != "cap") return; | 每 10s（仅 CAP）：ban_apply(false)（仅变化时重建）。 | main:uloop.interval(TICK_INTERVAL) |
| 4353 | `appctl_public_stats` | `` | return out; | 把 state.appctl.stats 按设备组合并（today/total/btoday/btotal/last/days/bdays 求和/取最大），返回公开统计对象。 | ubus:appctl_status |
| 4377 | `appctl_public_days` | `src, online` | return out; | 把按天分桶（online 取组内最大，ndata 求和）按设备组合并后返回。 | ubus:appctl_status |
| 5201 | `steer_bss_list` | `` | return out; | 候选 BSS 列表：本机 ap_nr_self + 各 peer info.nr + CAP 下发的 cap_nr，去重（bssid|ssid）。 | bss_public, steer_tick |
| 5227 | `bss_public` | `` | return out; | steer_bss_list 去掉 ifname 的公开版（CAP 在 report_status 回执里下发，SAP 间经 CAP 交换邻居）。 | srv_rx |
| 5238 | `neighbor_sync` | `bsses` | if (sig == state.nr_sig) return; | 把其它 AP 的同 SSID BSS 写进本机 hostapd 邻居库：对每本机接口调 `hostapd.<ifname> rrm_nr_set {list:[[bssid,ssid,nr],…]}`；签名不变跳过。 | steer_tick |
| 5262 | `steer_tick` | `` | if (state.cfg.role == "unconfigured") return; | 每 10s 的 11v 引导：roam 未启用/v_bss_transition 关/无 peer/无 SSID 则返回；对 RSSI 低于阈值且入网 ≥MIN_STEER_ASSOC(20s) 的终端发 bss_transition_request（候选 nr 列表），冷却 STEER_COOLDOWN(60s)；连续 3 次无果则 del_client 强制断开（冷却 1800s）；pin 终端跳过。 | main:uloop.interval(TICK_INTERVAL) |
| 5355 | `pin_tick` | `` | if (state.cfg.role == "unconfigured") return; | 每 10s：对连到非目标 AP 的 pin 终端调 `hostapd.<ifname> del_client {deauth:true,reason:1,ban_time:PIN_BAN_MS(120000)}`，冷却 PIN_KICK_COOLDOWN(30s)，发 pin_kick 事件。 | main:uloop.interval(TICK_INTERVAL) |
| 5382 | `ensure_token` | `` | 无（undefined） | CAP 且 token 为空时生成 token=`sha256("wifiroam-<time>-<rand>-<mac>")` 并 save_config。 | main, ubus:set_role |
| 5391 | `reconfigure` | `` | 无（undefined） | 角色/配置变化后重建：load_config、self.name 回填、sap_disconnect、清空 peers/cap_learned/prev_clients/steer 等状态、send_hello、ban_apply(true)。 | sap_rx, ubus:set_role |
| 5416 | `roam_default_init` | `` | if (int(cur.get("wifiroam", "roam", "config_ver") ?? "0") != 0) return; | 首次启用（roam.config_ver==0 且 enabled==1 且 ssids 为空）时：自动选中本机全部主 SSID 写回 UCI（config_ver=1）并 apply_roam_local 一次。 | main, ubus:set_role |
| 5446 | `main` | `` | if (state.cfg.role != "cap") return; | 入口：srand(time)、uloop.init、libubus.connect(null,60)（失败 exit(1)）、load_config、alias_load、devlist_load、detect_self、device_group_refresh、appctl_load、ban_load、ensure_token、roam_default_init、setup_udp、setup_tcp、publish wifiroam、注册 12 个 uloop.interval、send_hello、log started、uloop.run()。 | — |

> **函数清单后的补充说明**
>
> - **前向声明机制**：第 243–247 行用 `let` 前向声明了 25 个名字（第 243 行 15 个：`sap_report, push_aliases_to, push_roam_to, push_backhaul_to, push_offload_to, push_wifi_to, push_guest_to, apply_result_update, apply_backhaul_result_update, apply_wifi_result_update, apply_guest_result_update, ensure_token, reconfigure, conn_close, bss_public`；第 245 行 5 个访客函数；第 247 行 5 个：`appctl_track_macs, online_sample, device_group_refresh, ban_apply, appctl_dpi_daemon`），随后在文件后部以 `name = function(…){…}` 赋值。这 25 个与 25 个赋值式函数一一对应（另 2 个局部 `let … = function` 不在前向声明之列）。重写时 Node.js 的函数提升/模块导入可消除此限制，但调用时序（使用点晚于绑定点）须保持。
> - **高频被调函数**（静态调用次数最多，供重写时优先保证）：`macnorm`、`maccolon`、`device_key`、`local_clients`（被约 15 处调用，是终端数据的唯一来源）、`current_roam_cfg`、`cmd_output`、`log`、`push_event`、`device_members_of`、`client_name_of`。
> - **最长函数**：`srv_rx` 169 行、`local_clients` 160 行、`sap_rx` 140 行、`guest_write_infra` 106 行、`apply_roam_local` 101 行、`device_group_refresh` 98 行、`steer_tick` 93 行、`appctl_apply_rules` 88 行、`appctl_sample` 79 行、`build_topology` 74 行。重写时建议按 §8 拆分其中过长的函数体，但对外行为不变。
> - **`main()` 的调用者为空**：文件末尾直接调用，无其他调用者；`sap_tick`/`steer_tick`/`pin_tick`/`ban_tick` 等定时器函数在 `main` 外无具名调用者，仅由 `uloop.interval` 驱动（表格中已标注）。

---

## 3. ubus 接口

### 3.1 对象 `wifiroam`：方法清单（31 个）

对象由 `ubusc.publish("wifiroam", api_obj)` 发布（第 5471 行）。每个方法在 `api_obj` 中的 `args` 声明了参数白名单（`ubus_rpc_session: ""` 为 LuCI 的 RPC 会话参数，每个方法都有；其余为业务参数）。**重要**：源码注释（`set_appctl`，第 5119–5121 行）写明“ubus 参数是白名单校验，未声明的参数会被拒”。返回值中凡返回 `libubus.STATUS_INVALID_ARGUMENT` / `STATUS_NOT_FOUND` 者为 ubus 层错误码，非 `{ok:…}` 对象；其余一律返回对象。

| # | 方法 | 行号 | 前端传参（`args` 声明） | 返回值形状 | 内部调用的内部函数 |
|---|---|---|---|---|---|
| 1 | `status` | 4393 | 无业务参数 | `{version:number(DAEMON_VERSION), daemon_started:number, kvr:{…}或null, role:string, name:string, mac:string, ip:string, cap_ip:string\|null, model:string, firmware:string, uptime:number, peers_online:number, peers_total:number, clients_total:number, roam:{…current_roam_cfg}, backhaul:{…}, alias_ver:number, last_apply:object\|null, last_backhaul:object\|null}`；SAP 时 peers_online/peers_total 改按 `state.roster.aps` 计 | `applied_kvr`、`current_roam_cfg`、`current_backhaul_cfg`、`local_clients`、`device_key`、`self_uptime` |
| 2 | `topology` | 4434 | 无 | 直接返回 `build_topology()`：`{nodes:[…], self:string(macnorm), role:string, now:number}` | `build_topology` |
| 3 | `device_history` | 4439 | 无 | 直接返回 `devlist_view()`：`{now:number, devices:[{id,mac,members,grouped,name,custom_name,hostname,ip,online,first_seen,last_online,last_offline,ap,ap_name,conn,icon,note,isolated,pin,pin_name,can_wake}], aps:[{id,name}]}` | `devlist_view` |
| 4 | `wake` | 4443 | `mac:string` | `{ok:true,sent:number,mac:string(冒号)}` 或 `{ok:false,error:"unknown_device"\|"already_online"\|"invalid_mac"\|"send_failed"}`；只唤醒历史中有且当前离线的设备（`state.devices[key]` 查不到时再按 macnorm 查一次） | `device_key`、`macnorm`、`device_members_of`、`wol_send`、`maccolon` |
| 5 | `client_detail` | 4466 | `mac:string` | `{ok:true,client:{…client_node},ap:string}`；无 mac 返回 `STATUS_INVALID_ARGUMENT`；找不到返回 `STATUS_NOT_FOUND` | `devnorm`、`find_client` |
| 6 | `set_alias` | 4476 | `mac,name,icon,note`（均为 string） | SAP 且已认证时转发 CAP（`alias_update`），返回 `{ok:true,forwarded:true}`，转发失败断开并返回 `{ok:false,error:"link_down"}`；CAP 本地：`{ok:true,ver:number}` 或 `{ok:false,error:"invalid_mac"}` | `alias_apply`、`alias_broadcast`、`sap_disconnect` |
| 7 | `set_pin` | 4501 | `mac,ap`（string；`ap=""` 为清除） | 同 `set_alias` 的转发结构（方法 `pin_update`）；本地返回 `pin_apply` 的结果 `{ok,mac,ap}` 或 `{ok:false,error:"invalid_mac"\|"invalid_ap"\|"unknown_ap"}`，成功时 `alias_broadcast()` | `pin_apply`、`alias_broadcast`、`sap_disconnect` |
| 8 | `ungroup_device` | 4525 | `mac:string` | 非 CAP 返回 `{ok:false,error:"not_cap"}`；非法 MAC `invalid_mac`；成功时返回 `device_ungroup` 的 `{ok,…}`，并依次 `appctl_read_devices()`、（若 appctl 启用）`appctl_apply_rules()` + `appctl_dpi_daemon("reload")`、`ban_apply(true)` | `macnorm`、`device_ungroup`、`appctl_read_devices`、`appctl_apply_rules`、`appctl_dpi_daemon`、`ban_apply` |
| 9 | `set_role` | 4543 | `role:string` | 非法角色 `STATUS_INVALID_ARGUMENT`；`role=="sap"` 返回 `{ok:false,error:"sap_via_pairing"}`；成功 `{ok:true,role}`；设 `cap` 时 `ensure_token()`，设 `unconfigured` 时清空 token/cap_ip，`save_config()`，设 `cap` 时 `roam_default_init()`，最后 `reconfigure()` | `ensure_token`、`save_config`、`roam_default_init`、`reconfigure` |
| 10 | `get_roam` | 4563 | 无 | `{roam:{…current_roam_cfg}, groups:[…], members:[{mac,name}], kvr:{…}}`；SAP 且有 roster 时 members/groups 取 roster | `current_roam_cfg`、`member_list`、`ssid_groups`、`applied_kvr`、`maccolon` |
| 11 | `set_roam` | 4583 | `enabled:bool, ssids:[], r_fast:bool, ft_mode:string, ft_over_ds:bool, k_neighbor:bool, k_beacon:bool, v_bss_transition:bool, rssi_profile:string, rssi_threshold:number` | 非 CAP `{ok:false,error:"not_cap"}`；成功 `{ok:true,ver:number,results:[{ap,name,ok,ver,kvr}\|{ap,name,ok:null,error:"pending"}]}`；`rssi_profile` 非法回落 `balanced`；非 custom 或 threshold==0 时 threshold 取 preset；夹取 -30..-95；`config_ver+1` 后写 UCI，本地 `apply_roam_local`，`state.last_apply={ts,ver,results}`，再向各已认证 peer `push_roam_to` | `rssi_preset`、`current_roam_cfg`、`apply_roam_local`、`applied_kvr`、`member_list`、`push_roam_to`、`maccolon` |
| 12 | `precheck` | 4639 | 无 | 直接返回 `precheck()`：`{checks,groups,role,aps}`（检查项见 §9） | `precheck` |
| 13 | `get_backhaul` | 4643 | 无 | `{backhaul:{…current_backhaul_cfg}, radios:[…wifi_radios], self:{mac,name}}` | `current_backhaul_cfg`、`wifi_radios` |
| 14 | `get_wifi` | 4654 | 无 | `wifi_summary()` + `role` + `last`（`state.last_wifi`）；SAP 上也返回本机值，仅展示 | `wifi_summary` |
| 15 | `set_wifi` | 4665 | `unified:bool, ifaces:[{band,ssid,key}]` | 非 CAP `not_cap`；空数组/SSID 长度 1..32 外 `ssid_invalid`；key 非空且长度 8..64 外 `key_invalid`；`unified` 且密码留空时沿用现有首个 ap 口密码；先 `roam_rename_ssids(pairs)`（按频段映射旧→新 SSID），再 `apply_wifi_local`，各 peer `push_wifi_to`；返回 `{ok:bool,results:[{ap,name,ok,error}]}`，`state.last_wifi={ts,ssids,results}` | `wifi_summary`、`roam_rename_ssids`、`apply_wifi_local`、`push_wifi_to`、`maccolon` |
| 16 | `get_guest` | 4726 | 无 | 直接返回 `guest_summary()`（SAP 上也返回本机值） | `guest_summary` |
| 17 | `set_guest` | 4731 | `enabled:bool, ssid:string, key:string, bandwidth:number, schedule:bool, start:string, end:string, allow_lan:bool, open:bool` | 非 CAP `not_cap`；`open` 时 key 强制 ""；否则 key 为空沿用旧密码；启用时 SSID 1..32、key 8..64（`open` 除外）否则 `ssid_invalid`/`key_invalid`；start/end 非法 `time_invalid`；bandwidth 夹取 0..1000；`ver=prev.ver+1`；`guest_save_local` 失败返回 `{ok:false,error:"invalid"}`；本地 `apply_guest_local`，各 peer `push_guest_to`；返回 `{ok,results}`，`state.last_guest={ts,config,results}` | `guest_cfg`、`hhmm_minutes`、`guest_save_local`、`apply_guest_local`、`push_guest_to`、`maccolon` |
| 18 | `set_backhaul` | 4803 | `enabled:bool, ssid:string, key:string, device:string` | 非 CAP `not_cap`；ssid 为空用 `BACKHAUL_DEFAULT_SSID`（`wifiroam-bh`）；启用且 key 为空时沿用旧 key，否则 `randhex(16)`；`config_ver+1` 写 UCI；本地 `apply_backhaul_local(bh,"cap")`，各 peer `push_backhaul_to`；返回 `{ok:true,ver,results,backhaul}`，`state.last_backhaul={ts,ver,results}` | `current_backhaul_cfg`、`randhex`、`apply_backhaul_local`、`push_backhaul_to`、`maccolon` |
| 19 | `discover` | 4844 | 无 | `{devices:[{mac,ip,name,model,last_seen}]}`；**不下发 nonce**（注释：配对所需凭据仅留在守护进程内） | —（只读 `state.discovered`） |
| 20 | `pair` | 4856 | `mac:string` | 无 mac `STATUS_INVALID_ARGUMENT`；非 CAP `not_cap`；discovered 中无此 MAC `not_found`；无 IP `no_ip`；无 addr/sock `socket`；成功立即返回 `{ok:true,ip}`（配对是异步的：新建 TCP 通道，收到对端 `hello` 后 defer `join{token,cap_ip,nonce_echo}`，`data_cb` 中 `m.ok` 时 `push_event("paired",…)` 并删 discovered；8000ms 定时器兜底断开） | `macnorm`、`push_event` |
| 21 | `unpair` | 4913 | `mac:string` | 无 mac `STATUS_INVALID_ARGUMENT`；非 CAP `not_cap`；peer 不存在 `not_found`；已认证时先 defer `leave`，再 `delete state.peers[mn]`，`push_event("unpaired",…)`；返回 `{ok:true}` | `macnorm`、`maccolon`、`push_event` |
| 22 | `roam_log` | 4935 | `limit:number` | `{events:[{ts,type,mac,name,info}]}`；limit 默认 50，≤0 取 50，>MAX_EVENTS(100) 截为 100，取最近 limit 条 | —（只读 `state.events`） |
| 23 | `appctl_status` | 4947 | 无 | `{ok:bool(role==cap), error:""\|"not_cap", enabled:bool, enhanced:bool, strict:bool, day:string, apps:[{id,name,cat}], devices:{mac:{name,block}}, stats:{…appctl_public_stats}, online:{…}, ndata:{…}}` | `appctl_public_stats`、`appctl_public_days` |
| 24 | `ban_list` | 4972 | 无 | `{ok:bool(role==cap), error:""\|"not_cap", enabled:bool, items:[{mac,name,timeon,timeoff,weekdays,active:bool}], blocked:[macnorm…已排序]}`；`active` 按当前本地时间与星期实时算 | `ban_read`、`ban_in_window` |
| 25 | `set_ban` | 4994 | `enabled:bool` | 非 CAP `not_cap`；写 UCI `wifiroam schedule.enabled`（section 不存在时先 `cur.set("wifiroam","schedule","schedule")` 创建）；`state.ban.enabled=on`；`ban_apply(true)`；返回 `{ok:true,enabled}` | `ban_apply` |
| 26 | `ban_set` | 5011 | `mac,name,timeon,timeoff,weekdays`（string） | 非 CAP `not_cap`；MAC/组 ID 非法 `invalid_mac`；时间非法 `invalid_time`；星期为空 `invalid_weekdays`；name 为空时经 `find_client` 补；同组旧 section 合并为首个 sid（其余删除），写 `timeon/timeoff`（`ban_hm_str` 格式）、`weekdays`（空格连接）；首次保存时段时 `ban_reload_enabled()`（总开关默认开）；`ban_apply(true)`；返回 `{ok:true,mac,blocked:bool}` | `device_key`、`ban_hm`、`ban_hm_str`、`ban_weekdays`、`find_client`、`device_members_of`、`ban_reload_enabled`、`ban_apply` |
| 27 | `ban_del` | 5064 | `mac:string` | 非 CAP `not_cap`；无规则 `not_found`；删除该组全部 ban section，`ban_reload_enabled()`（删掉最后一个时段后总开关回默认关）、`ban_apply(true)`；返回 `{ok:true}` | `device_key`、`ban_reload_enabled`、`ban_apply` |
| 28 | `offload_status` | 5088 | 无 | `{enabled:bool, hw:bool, active:bool}`；`enabled/hw` 读 UCI `firewall @defaults[0]` 的 `flow_offloading`/`flow_offloading_hw` 是否为 `"1"`；`active` 为 `nft list chain inet fw4 forward` 输出含 `"flow add"` | `cmd_output` |
| 29 | `set_offload` | 5100 | `enabled:bool` | SAP：先本地 `offload_apply(on)`，再 `offload_request_cap(on)`，返回 `{ok:true,enabled}`；CAP：`offload_apply` 失败返回 `{ok:false,error:"no_firewall_defaults"}`，成功后向各已认证 peer `push_offload_to`，返回 `{ok:true,enabled}` | `offload_apply`、`offload_request_cap`、`push_offload_to` |
| 30 | `set_appctl` | 5118 | `enabled:bool, enhanced:bool, strict:string`（`"1"`/`"0"`/`""`，空表示沿用当前值） | 非 CAP `not_cap`；写 UCI `wifiroam appctl`（section 不存在先创建）；`state.appctl` 同步；`appctl_dnsmasq_sync(on)` 得 dirty；开：`appctl_nft_schema()` 变化则 dirty、`appctl_apply_rules()`、`appctl_dpi_daemon("start")`、`appctl_dnslock_apply(enh)`、`appctl_hw_suspend(enh)`；关：`appctl_table_remove()`、`appctl_hw_suspend(false)`；dirty 时 `/etc/init.d/dnsmasq restart`；返回 `{ok:true,enabled,enhanced,strict}` | `appctl_dnsmasq_sync`、`appctl_nft_schema`、`appctl_apply_rules`、`appctl_dpi_daemon`、`appctl_dnslock_apply`、`appctl_hw_suspend`、`appctl_table_remove`、`cmd_output` |
| 31 | `set_app_policy` | 5164 | `mac,app,action`（string；action ∈ `block`/`allow`） | 非 CAP `not_cap`；MAC/组 ID 或 app 非法 `invalid_args`；appctl 未启用 `disabled`；action 非法 `invalid_action`；更新该设备 block 列表（写 UCI `appdev`），重读、`appctl_apply_rules()`、`appctl_dpi_daemon("reload")`；返回 `{ok:true,mac,app,action,block:[…]}` | `device_key`、`appctl_app`、`appctl_read_devices`、`appctl_write_device`、`find_client`、`appctl_apply_rules`、`appctl_dpi_daemon` |

### 3.2 拓扑节点形状（`client_node` / `build_topology`）

- 终端节点（`client_node(mn, c, parent)`，第 2866–2892 行）：`{id:key(设备组ID), type:"client", name, custom_name:string|null, hostname:string|null, ip:string|null, mac:string(冒号), members:[冒号MAC…], grouped:bool(成员>1), isolated:bool, parent:AP的macnorm, conn:{type,band,ssid,rssi,tx_rate,rx_rate,tx_speed,rx_speed,port,since}, icon:string|null, note:string|null, pin:string|null(macnorm), pin_name:string|null}`。
- AP 节点（`build_topology`，第 2902–2933 行）：`{id:macnorm, type:"ap", role, name, custom_name, model, ip, mac, parent:本机为null/peer为本机macnorm, uplink:{…detect_uplink 或 peer info.uplink}, firmware, uptime, authed:bool（仅 peer）, clients:[设备组ID…]}`。本机节点 `parent:null`；peer 节点 `clients` 为该 AP 下挂终端的组 ID 列表。
- `build_topology()` 返回 `{nodes:[AP节点…,终端节点…], self:本机macnorm, role, now:time()}`。终端归属按 `compute_owner` 去重：同一终端在多 AP 出现时只归属一台（`grouped` 后按“wifi 优先于有线、同类型 RSSI 更大者优先”的规则选代表，见 §9）。
- `find_client(key)`（第 4166–4195 行）：在本地 `local_clients()` 与各 peer `clients` 中找终端（支持组 ID/成员 MAC），返回 `{node:client_node, ap}` 或 `null`；供 `client_detail` 与 SAP 侧 `get_client_detail` 使用。

### 3.3 对端通道方法（守护进程作为客户端/服务端）

守护进程作为 **ubus 通道客户端**（`libubus.open_channel` + `defer`/`request`）时使用的方法名（`method:` 字段，逐字）：

| 方法 | 发起方→接收方 | data 字段 | 回执/回调 |
|---|---|---|---|
| `hello` | TCP 服务端（`srv_accept`，`request`，`return:"ignore"`）→ 新接入方 | `{mac,role,nonce}`（nonce 为服务端 `randhex(16)`） | 无回执；接收方（SAP `sap_rx` / CAP `pair` 的临时通道）据此发起 `auth`/`join` |
| `join` | CAP `pair` → 未配置设备 | `{token,cap_ip,nonce_echo}`（`nonce_echo` 为 discovered 中保存的该设备 hello nonce） | `{ok}`；`ok` 时 CAP 发 `paired` 事件并删 discovered |
| `auth` | SAP `sap_rx` → CAP | `{mac,role,name,digest,alias_ver,roam_ver,roam_sig,backhaul_ver,guest_ver}`；`digest = sha256(token + ":" + CAP hello nonce)` | `{ok,role,alias_ver,roam_ver,backhaul_ver,names,roster}`；`ok` 时 SAP 置 `authed=true`、`last_pong`，收 `names/roster`，并立即 `sap_report()` |
| `report_status` | SAP `sap_report`（每 10 秒）→ CAP | `{info:self_info(),clients:local_clients(),alias_ver,roam_ver,roam_sig,backhaul_ver,guest_ver,kvr}` | `{ok,alias_ver,roam_ver,backhaul_ver,names,roster,nr}`；回执刷新 SAP 的 `last_pong/net_names/roster/cap_nr` |
| `report_event` | SAP（经 `push_event`？见 §9）→ CAP | `{etype,mac,info,name}`（`srv_rx` 侧字段名） | `{ok:true}`；CAP 侧 `push_event(args.etype ?? "peer_event", args.mac, args.info, args.name)` |
| `push_aliases` | CAP → SAP（`alias_broadcast`/`push_aliases_to`） | `{aliases:state.aliases 全量}` | `{ok,ver}`；SAP 仅当 `ver` 更大时接受并 `alias_save()` |
| `push_roam_config` | CAP → SAP | `{roam, members}` | `{ok,ver,kvr}`；SAP 本地 `apply_roam_local` |
| `push_backhaul_config` | CAP → SAP | `{backhaul}` | `{ok,ver,error}` |
| `push_wifi_config` | CAP → SAP | `{ssids:[{band,ssid,key}]}` | `{ok,error}` |
| `push_guest_config` | CAP → SAP | `{guest}` | `{ok,error}` |
| `push_offload` | CAP → SAP | `{enabled}` | `{ok,enabled}` |
| `alias_update` | SAP 的 `set_alias` → CAP | `{mac,name,icon,note}` | `{ok,ver}` 或 `{ok:false}` |
| `pin_update` | SAP 的 `set_pin` → CAP | `{mac,ap}` | `{ok,ver}` 或 `{ok:false,error}` |
| `set_offload` | SAP 的 `set_offload` → CAP（经 `offload_request_cap`） | `{enabled}` | `{ok,enabled}` 或 `{ok:false,error:"not_cap"}` |
| `leave` | CAP `unpair` → SAP | `{}` | `{ok:true}`；SAP 收到后 300ms 回 `unconfigured` |

服务端（`srv_rx`）在未认证状态只接受 `join`（且仅当本机 `role=="unconfigured"`）与 `auth`；其他类型直接丢弃（`return 0`，无回执）。已认证状态的 `switch(req.type)` 见 §2 `srv_rx` 行；`default` 回 `{ok:false,error:"unknown_method"}`。SAP 侧（`sap_rx`）未认证时只处理 `hello`，其余丢弃；已认证时 `switch` 处理 9 种类型（`push_roam_config`、`push_aliases`、`push_backhaul_config`、`push_wifi_config`、`push_guest_config`、`push_offload`、`get_client_detail`、`get_topology`、`leave`），无 `default` 分支（未知类型静默丢弃）。

### 3.4 前端调用与版本校验

- 前端入口 `wifiroam/common.js`（压缩单行，24561 字节）：`call(method,args)`——以 `args` 的键动态生成 `paramSpec`（值全为 `undefined`），经 `rpc.declare({object:'wifiroam',method,params:paramSpec})` 调用；`safeCall(method,args)`——`call(...).catch(()=>null)`，失败返回 `null`；另有 `notify`、`setBusy`、`setFormDisabled`、`pollUntil(fn,interval=1500,timeout=30000)`、`inlineStatus`、`statusBox`、`renderWifiResults`、`banCtl`（内含 `ban_set`/`ban_del` 调用）等 UI 辅助函数。`CSS_VER='20261115e'`。
- 前端各页调用（`safeCall` 为读，`call` 为写；括号内为调用文件）：
  - `settings.js`：`status`、`offload_status`、`get_wifi`、`get_guest`、`discover`、`topology`、`set_wifi`、`set_guest`、`set_offload`、`pair`、`unpair`、`set_role`；另 `service list`（`rpc.declare({object:'service',method:'list',params:['name']})`）、`rc list`、`rc init`（`{object:'rc',method:'init',params:['name','action']}`，用于重启服务修版本）。
  - `topology.js`：`topology`、`status`、`roam_log{limit:60}`、`appctl_status`、`set_alias`、`set_appctl{enabled,enhanced}`、`set_app_policy`、`ban_list`、`set_ban`、`ungroup_device`。
  - `clients.js`：`device_history`、`set_alias`、`set_pin`、`wake`。
  - `advanced.js`：`get_roam`、`status`、`appctl_status`、`precheck`、`get_backhaul`、`set_backhaul`、`set_roam`、`set_appctl{enabled,enhanced,strict:'1'/'0'}`。
  - `common.js` 的 `banCtl`：`ban_set`、`ban_del`。
- **版本校验**（`settings.js`）：`REQUIRED_VERSION=5`；`versionStale()` 为 `st.role && st.version !== REQUIRED_VERSION`；页面加载时 `pollUntil(ready,1000,12000)` 等待 `status.version===REQUIRED_VERSION`，超时/不匹配则提示“The running wifiroamd version does not match this LuCI app. Click Restart to repair automatically.”并可经 `rc init wifiroam restart` 修复（源码注释第 55 行亦写“LuCI 侧要求一致，不一致时「重启」会自动 stop+start 修复”）。`status` 的 `daemon_started` 供前端识别旧进程。
- **ACL 与方法清单一致性**：ACL read 14 个（`status, topology, device_history, client_detail, get_roam, precheck, discover, roam_log, get_backhaul, appctl_status, ban_list, offload_status, get_wifi, get_guest`）与 write 17 个（`set_alias, set_pin, ungroup_device, set_role, set_roam, set_backhaul, pair, unpair, set_appctl, set_app_policy, set_ban, ban_set, ban_del, set_offload, set_wifi, set_guest, wake`）合计 31 个，与 `api_obj` 的 31 个方法逐一对应，无多无少。ACL 另授权 `service list`（read）与 `rc init`（write），供前端查服务状态与重启守护进程。**例外**：`client_detail` 在 ACL 与 `api_obj` 中存在，但前端四个页面与 `common.js` 中均无调用（全文检索 0 次），为预留/未接线方法，重写时仍须实现。
- `modelart.js`（6788 字节）：`base:'wifiroam/router/'` + `map:{型号字符串: 图片文件名}`，供拓扑页按 `model` 显示路由器图片；与守护进程无接口关系。`devices.js`（4392 字节）、`logos.js`、`oui.js`（OUI 厂商库，1.6MB）同为前端静态数据，不调守护进程。

### 3.5 守护进程作为 ubus 客户端调用的其他对象/方法

| 对象 | 方法 | 调用点 | 参数 | 用途/返回值处理 |
|---|---|---|---|---|
| `network.interface.lan` | `status` | `detect_self`（第 1375 行） | 无 | 取 LAN 接口地址/掩码/广播地址；失败时本机 IP 回落（见 §9） |
| `network.wireless` | `status` | `wireless_uplink`（1411）、`ap_nr_self`（1477，try/catch，失败返回空）、`local_clients`（2324） | 无 | 返回各 radio 的 `config.band` 与 `interfaces[]`（`ifname`、`config.ssid`）；`local_clients` 据此建 `ifmap` |
| `hostapd.<ifname>` | `get_clients` | `local_clients`（2335） | 无 | 返回 `{clients:{mac:{signal,connected_time,rate:{tx,rx}}},freq}`；无 `clients` 则跳过该接口 |
| `hostapd.<ifname>` | `rrm_nr_get_own` | `ap_nr_self`（1484） | 无 | 取本机 BSS 的 11k 邻居元素 `nr` |
| `hostapd.<ifname>` | `get_status` | `ap_nr_self`（1485） | 无 | 取 BSS 状态（bssid/ssid/channel 等） |
| `hostapd.<ifname>` | `rrm_nr_set` | `neighbor_sync`（5253，try/catch，失败仅 log） | `{list:[[bssid,ssid,nr],…]}` | 写 11k 邻居库 |
| `hostapd.<ifname>` | `del_client` | `steer_tick`（5317，`{addr, deauth:true, reason:1, ban_time:0}`）、`pin_tick`（5368，`{addr, deauth:true, reason:1, ban_time:PIN_BAN_MS}`） | 见左 | 强制断开终端；`steer` 用 ban_time 0，`pin` 用 120000ms |
| `hostapd.<ifname>` | `bss_transition_request` | `steer_tick`（5333） | `{addr, disassociation_imminent:true, disassociation_timer:10, validity_period:30, abridged:false, neighbors:[nr…]}` | 11v BSS Transition 引导 |

注意：守护进程**不**直接调用 `service`/`rc`/`network`（重启等）的 ubus 方法；重启/重载网络均经 shell（`uloop.process`/`cmd_output`，见 §7）。`ubusc.call` 为同步调用（ucode-mod-ubus 的语义），失败时返回 `null`/抛异常，调用点多用 `?? {}` 或 try/catch 兜底（`ap_nr_self`、`neighbor_sync`、`steer_tick`、`pin_tick` 有 try/catch；`local_clients` 的 `get_clients` 无 try/catch，见 §9）。

---

## 4. 对端协议（UDP 50607 / TCP 50608）

### 4.1 传输层

| 通道 | 端口 | 协议 | 绑定 | 说明 |
|---|---|---|---|---|
| 发现/心跳 | 50607 | UDP | `0.0.0.0:50607`，`SO_REUSEADDR` + `SO_BROADCAST`，非阻塞 | 全网广播 hello；`udp_sock.send` 目标为 `state.bcast`（默认 `255.255.255.255`），`udp_rx` 循环 `recv(4096, 0, peer)` 直至无数据 |
| 同步/控制 | 50608 | TCP | `0.0.0.0:50608`，`SO_REUSEADDR`，非阻塞，`listen(8)` | CAP 为服务端（`srv_accept`），SAP 为客户端（`sap_connect`），CAP 配对时也作客户端直连未配置设备；承载 libubus 通道（见 §4.5） |

两个端口均无 TLS、无加密。同一局域网内任意设备可收 hello、可连 TCP 50608；安全完全依赖 token（见 §4.3）。

### 4.2 常量

| 常量 | 值 | 行号 | 含义 |
|---|---|---|---|
| `UDP_PORT` | 50607 | 20 | UDP 发现端口 |
| `TCP_PORT` | 50608 | 21 | TCP 同步端口 |
| `MAGIC` | `"WIFIROAM1"` | 22 | UDP hello 的 magic 字段；`udp_rx` 校验 `msg.magic != MAGIC` 则丢弃；TCP 通道不校验 MAGIC（靠 libubus 通道与 token） |
| `PEER_TTL` | 30（秒） | 25 | peer 超过 30 秒未见 hello 即离线（`expire_tick`） |
| `DISCOVER_TTL` | 180（秒） | 26 | 未配置设备在 discovered 列表中保留 180 秒 |
| `HELLO_INTERVAL` | 5000（毫秒） | 27 | `uloop.interval` 发 hello 的周期 |
| `TICK_INTERVAL` | 10000（毫秒） | 28 | 全部 10 秒 tick 的周期 |
| `MAX_EVENTS` | 100 | 29 | `state.events` 环形缓冲上限；`roam_log` 的 limit 上限亦为此值 |
| `WIRED_TTL` | 300（秒） | 30 | 有线终端在最后一次 FDB 出现后保留 300 秒；`wifi_seen` 的防抖窗口亦用此值（`wifi_seen` 清理为 `WIRED_TTL*2`） |
| `STEER_COOLDOWN` | 60（秒） | 31 | 同一终端两次 BSS Transition 引导的最小间隔 |
| `MIN_STEER_ASSOC` | 20（秒） | 32 | 终端入网后至少稳定 20 秒才允许被引导 |
| `STEER_KICK_AFTER` | 3（次） | 33 | 连续 BTM 引导无果的次数，达到后强制断开让终端重新选 AP |
| `STEER_KICK_COOLDOWN` | 1800（秒） | 34 | 同一终端两次强制断开的最小间隔 |
| `PIN_BAN_MS` | 120000（毫秒） | 35 | 固定终端连错 AP 时 hostapd 禁入时长 |
| `PIN_KICK_COOLDOWN` | 30（秒） | 36 | 同一终端两次踢回目标 AP 的最小间隔 |
| `DAEMON_VERSION` | 5 | 56 | 协议/行为版本，见 §6.4 |
| `DPI_QUEUE` | 0 | 222 | NFQUEUE 队列号（wifiroam-dpi 用） |
| `DEVICES_MAX` | 512 | 210 | 终端历史保存上限 |
| `DEVICES_FLUSH` | 60（秒） | 211 | 终端历史落盘最小间隔 |
| `APPSTATS_FLUSH` | 15（秒） | 217 | 应用统计落盘最小间隔 |
| `APP_ACT_MIN_PK` / `APP_ACT_MIN_BYTES` | 3 / 2048 | 184–185 | 宽松模式活跃判定阈值（窗口内包数/字节下限） |
| `APP_ACT_ENH_PK` / `APP_ACT_ENH_BYTES` | 5 / 4096 | 196–197 | 精准模式活跃判定阈值 |
| `APP_SET_TIMEOUT` / `APP_SET_TIMEOUT_ENH` | `"12h"` / `"30m"` | 186 / 198 | nft set 元素超时（宽松/精准） |
| `BAN_DEFAULT_ON` / `BAN_DEFAULT_OFF` | `"22:00"` / `"07:00"` | 233–234 | 定时断网默认时段（仅为常量定义；`ban_read`/`ban_set` 的实际默认值逻辑见 §9） |
| `GUEST_IP` / `GUEST_NET` | `172.16.10.1` / `172.16.10.0/24` | 50–51 | 访客子网 |
| `BACKHAUL_SECTION` | `"wifiroam_bh"` | 37 | 回程 sta 口的 UCI section 名 |
| `BACKHAUL_DEFAULT_SSID` | `"wifiroam-bh"` | 38 | 回程默认 SSID |

### 4.3 Hello / 发现消息（UDP，JSON）

`send_hello()`（第 2752–2761 行）每 5 秒广播一次，`udp_send` 用 `sprintf("%.J", obj)` 序列化（ucode 的 JSON 格式化）：

| 字段 | 类型 | 值/来源 |
|---|---|---|
| `magic` | string | `"WIFIROAM1"` |
| `ver` | number | `1`（hello 协议版本，与 `DAEMON_VERSION=5` 不同） |
| `role` | string | `state.cfg.role`（`cap`/`sap`/`unconfigured`） |
| `mac` | string | `state.self.mac`（冒号大写形式，`detect_self` 所得） |
| `ip` | string | `state.self.ip` |
| `name` | string | `state.self.name` |
| `model` | string | `state.self.model`（`/tmp/sysinfo/model`） |
| `nonce` | string | `state.self.nonce`（启动时 `randhex(…)` 生成，见 §9：长度未在 `detect_self` 摘要中确认，配对时原样回显） |
| `thash` | string | `substr(sha256("wifiroam:" + token), 0, 16)`（token 的 16 字符截断哈希，用于同网识别，不直接传 token） |
| `alias_ver` | number | `state.aliases.ver` |
| `ts` | number | `time()`（秒） |

`udp_rx()`（第 2763–2796 行）接收处理，逐条规则：

1. `json(data)` 解析失败跳过；`type(msg) != "object"` 或 `msg.magic != MAGIC` 跳过。
2. `mn = macnorm(msg.mac)`，长度非 12 或等于本机 MAC 跳过。
3. `msg.role == "unconfigured"` → 记入 `state.discovered[mn] = {mac:uc(msg.mac), ip:msg.ip ?? peer.address, name, model, nonce:msg.nonce, last_seen:time()}`，`continue`（不进入 peer 表，不校验 token）。
4. 否则算 `my_th = substr(sha256("wifiroam:" + state.cfg.token), 0, 16)`；本机 token 为空或 `msg.thash != my_th` 则跳过（注释“foreign net”，即不同 token 的网络互不可见）。
5. 更新/新建 `state.peers[mn]`（`??= {clients:null}`）：`mac/ip/name/model/role/last_seen`；若 `msg.role == "cap"` 且有 `msg.ip`，则 `state.cap_learned = msg.ip`（SAP 藉此学到 CAP 地址）。

**无重试/确认**：hello 为纯广播，无 ACK、无重传；丢包仅由下一周期（5 秒）弥补。`PEER_TTL=30` 秒即 6 个 hello 周期未见则判离线。

### 4.4 配对流程（TCP 50608，libubus 通道）

1. **发现**：未配置设备每 5 秒发 hello（`role="unconfigured"`，含 `nonce`），CAP 的 `discover` 方法返回其 `{mac,ip,name,model,last_seen}`（不含 nonce）。
2. **发起**：前端调 CAP 的 `pair{mac}`。CAP 新建 TCP socket 直连该设备 IP:50608，`libubus.open_channel(sock, rx_cb, disconnect_cb)`；对端 `srv_accept` 接受后立即 `request` 方法 `hello`（`data:{mac,role,nonce}`，`return:"ignore"`），其中 `nonce` 为服务端现生成的 `randhex(16)`。
3. **join**：CAP 的 `rx_cb` 收到 `req.type=="hello"` 后 `defer` 方法 `join`，`data:{token:state.cfg.token, cap_ip:state.self.ip, nonce_echo:d.nonce}`（`d.nonce` 为 discovered 中保存的该设备 hello nonce）。8000ms 定时器兜底：超时未完成则 `chan.disconnect()`。
4. **校验与落盘**（对端 `srv_rx`，第 3769–3783 行）：仅当本机 `role=="unconfigured"` 才接受 `join`；校验 `args.nonce_echo == state.self.nonce` 且 `args.token` 非空，否则回 `{ok:false,error:"bad_nonce"}`；通过则 `state.cfg.token=args.token`、`cap_ip=args.cap_ip ?? ""`、`role="sap"`，`save_config()`，回 `{ok:true}`，`push_event("paired",…)`，300ms 后 `reconfigure()`。
5. **认证（SAP→CAP 日常连接）**：SAP `sap_connect(cap_ip)` 建 TCP 通道后，CAP 侧 `srv_accept` 先发 `hello{mac,role,nonce}`；SAP `sap_rx` 未认证分支收到 `hello` 后算 `digest = sha256(token + ":" + req.args.nonce)`，`defer` 方法 `auth`，`data:{mac,role,name,digest,alias_ver,roam_ver,roam_sig,backhaul_ver,guest_ver}`。CAP `srv_rx` 的 `auth` 分支（第 3784–3835 行）算 `expect = sha256(token + ":" + conn.nonce)`（`conn.nonce` 为 accept 时生成的 `randhex(16)`），token 为空或 `digest != expect` 则回 `{ok:false,error:"auth"}` 并 `conn_close`；通过则 `conn.authed=true`，peer 置 `authed=true`，回 `{ok:true,role,alias_ver,roam_ver,backhaul_ver,names,roster}`（`names`/`roster` 仅 CAP 角色时给），随后按版本差补发 alias/roam/backhaul/guest/offload（见 §3.3 的 auth 回执后逻辑：alias_ver 落后则 `push_aliases_to`；roam ver 落后或 sig 不一致则 `push_roam_to`；backhaul 启用且 ver 落后则 `push_backhaul_to`；guest ver 落后则 `push_guest_to`；CAP 时恒 `push_offload_to`）。
6. **断开与重连**：SAP 侧 `sap_tick` 每 10 秒检查：已认证且 `time() - last_pong > 45` 秒则 `sap_disconnect()` 后重连（`last_pong` 由 `report_status` 回执刷新；注释称 ucode 通道可能感知不到对端死亡的 CLOSE_WAIT 半开状态，故用应用层看门狗）。`sap_disconnect` 时 CAP peer 的 `authed` 置 false。CAP 侧 peer 超 `PEER_TTL` 未见 hello 时 `expire_tick` 删 peer 并断开其 channel。

### 4.5 通道内消息格式（TCP 50608，libubus over TCP）

- **帧格式**：源码未定义帧格式。`libubus.open_channel(sock, rx_cb, disconnect_cb)`、`channel.defer({method,data,data_cb,cb})`、`channel.request({method,data,return:"ignore"})`、`req.reply({...})` 均为 ucode-mod-ubus 提供的抽象，其线上的字节格式（ubus 协议头、JSON 编码、请求 ID、超时）**不在本源码中**，属 `ucode-mod-socket`/`libubus` 的实现行为（只有二进制，无源码）。重写时须实测抓包或查 ucode-mod-ubus 的行为后等价实现，见 §9 第 1 条。**不可凭空发明帧格式**。
- **请求对象**：`req` 含 `type`（方法名字符串，如 `"report_status"`）与 `args`（即 `data` 对象）；服务端用 `req.reply(obj)` 回执。`defer` 的 `data_cb(m)` 收到回执对象，`cb(rc)` 在完成时触发（`rc==0` 成功，`rc!=0` 失败/超时）。
- **配对后控制消息**：即 §3.3 表中的 15 个方法，`data` 字段逐字见该表；`push_*` 类消息的回执用于更新 `state.last_apply/last_backhaul/last_wifi/last_guest` 的 `results`（`ok:null,error:"pending"` 的占位项在回执到达时被 `apply_*_result_update` 改写）。
- **超时与重试**（源码中明确的）：SAP 心跳看门狗 45 秒（`sap_tick`）；`pair` 的 8000ms 兜底断开定时器；`leave` 后 300ms 延迟 `reconfigure`；`join` 成功后 300ms 延迟 `reconfigure`；`guest_port_sync` 的 1000ms 重试定时器（见 §5.2）。其余 `defer` 调用**无显式超时参数**，超时行为依赖 libubus 通道实现（见 §9）。

### 4.6 漫游密钥派生（`apply_roam_local` 内）

- `mobility_domain = substr(sha256("md:" + ssid), 0, 4)`（`roam_md`）。
- `r0kh` 条目：`"<AP MAC>,<大写无冒号MAC>-<SSID>,<roam_key0>"`，其中 `roam_key0(mac) = substr(sha256(token + ":r0:" + macnorm(mac)), 0, 32)`。
- `r1kh` 条目：`"<AP MAC>,<AP MAC>,<roam_key1>"`，其中 `roam_key1(mac) = substr(sha256(token + ":r1:" + macnorm(mac)), 0, 32)`。
- 仅 `ft_mode == "explicit"` 时写 `r0kh/r1kh`、`nas_identifier`（`"<大写无冒号本机MAC>-<SSID>"`）、`pmk_r1_push=1`、`ft_psk_generate_local=0`；`simple` 模式写 `ft_psk_generate_local=1` 并删除上述四键。`r_fast` 关闭时删除全部 FT 相关键，只保留 K/V。`reassociation_deadline` 固定 `"2000"`。K/V 键：`ieee80211k=1`、`rrm_neighbor_report`/`rrm_beacon_report` 按 `k_neighbor`/`k_beacon` 置 0/1；`ieee80211v=1`、`bss_transition` 按 `v_bss_transition` 置 0/1。不在漫游组的 SSID：仅当其现含 `ieee80211r/k/v` 任一键时才删除全部 `ROAM_KEYS`（14 个键，见 §1 常量表旁的定义）。

---

## 5. 定时器清单

### 5.1 常驻 `uloop.interval`（`main()`，第 5473–5491 行）

全部 12 个均在 `main()` 末尾注册；除 `send_hello` 用 `HELLO_INTERVAL`（5000ms）外，其余 11 个均用 `TICK_INTERVAL`（10000ms）。**无 jitter、无错峰**：11 个 10 秒任务在同一时刻触发，执行顺序即注册顺序。

| # | 周期 | 函数 | 触发条件 | 动作 |
|---|---|---|---|---|
| 1 | 5000ms | `send_hello` | 无条件（任何角色） | 广播 hello（§4.3） |
| 2 | 10000ms | `sap_tick` | 仅 `role=="sap"` | 已认证：`last_pong` 超 45 秒则断开重连；否则返回；未连接：按 `cfg.cap_ip` 或 `cap_learned` 连接 |
| 3 | 10000ms | `sap_report` | 仅 SAP 且 `link.authed` | 上报 `report_status`（§3.3）；先做本机 `diff_events`（join/leave 事件） |
| 4 | 10000ms | `expire_tick` | 无条件 | peer 超 `PEER_TTL` 删并发 `ap_offline` 事件、断 channel；discovered 超 `DISCOVER_TTL` 删除 |
| 5 | 10000ms | `backhaul_tick` | 仅 SAP | 回程断开时按配置重连/切换（`ethernet_uplink_port` 参与） |
| 6 | 10000ms | `steer_tick` | `role != "unconfigured"` 且 roam 启用且 `v_bss_transition` 且阈值合法且有 SSID 且有已认证 peer | 11v 引导/强制断开（§2 `steer_tick` 行）；`neighbor_sync`（`k_neighbor` 时） |
| 7 | 10000ms | `pin_tick` | `role != "unconfigured"` 且 `aliases.pin` 非空 | 踢回连错 AP 的固定终端（§2 `pin_tick` 行） |
| 8 | 10000ms | `guest_tick` | `role != "unconfigured"` | 按开放时段变化重建/移除访客口，同步 nft/tc，端口同步 |
| 9 | 10000ms | `appctl_tick` | （内部先判断 CAP/启用） | 见 §2 `appctl_tick` 行：roll_day、采样、预热、规则重建、DPI reload、统计落盘、ban_apply、device_group_refresh |
| 10 | 10000ms | `ban_tick` | 仅 CAP | `ban_apply(false)`（仅变化时重建） |
| 11 | 10000ms | `devlist_tick` | 无条件（内部处理） | 刷新终端历史在线/离线时间戳，normalize、trim、save |
| 12 | 10000ms | 匿名函数 | 仅 CAP | `local_clients()` 后 `diff_events(prev_clients, cur, self.name)` 并 `owner_events(cur)`（CAP 侧本机终端 join/leave 与跨 AP 迁移事件） |

### 5.2 一次性 `uloop.timer`

| 位置 | 延迟 | 动作 |
|---|---|---|
| `guest_port_sync`（第 2058 行） | 1000ms | 重试一次 `guest_port_sync(cfg, cb, tries+1)`（等访客 netdev 出现） |
| `sap_rx` 的 `leave` 分支（第 3655 行） | 300ms | `apply_roam_local({enabled:false,ssids:[],config_ver:0},[])` 后回 `unconfigured` 并 `save_config()`、`reconfigure()` |
| `srv_rx` 的 `join` 分支（第 3781 行） | 300ms | `reconfigure()`（配对成功后） |
| `pair`（第 4907 行） | 8000ms | 若 `done` 仍 false 且 channel 存在则 `chan.disconnect()`（配对兜底） |

### 5.3 其他周期性/节流（非 uloop.interval）

- `appctl_warm_step`：每轮 `appctl_tick` 预热 1 个主机名（`_warm_i` 递增轮询）。
- `appstats_save`：脏且距上次保存 ≥`APPSTATS_FLUSH`（15 秒）才写盘。
- `devlist_save`：脏且距上次保存 ≥`DEVICES_FLUSH`（60 秒）或 `force` 时写盘。
- `station_bytes`：1 秒内复用 `bytes_cache`（同一轮多次调用 `iw` 只执行一次）。
- `guest_nft_apply` / `neighbor_sync` / `appctl_dnslock_apply`：签名/状态不变时跳过重建（幂等节流）。
- `appctl_sample`：每轮取一次 nft 计数快照；时长按实际时间差累计，不按固定 TICK 累加（避免调度漂移累积误差）。

---

## 6. 配置与持久化

### 6.1 `/etc/config/wifiroam`（UCI）

默认文件 41 行（见任务书所附内容）。守护进程直接读写的 section 与 option（`cur.get/set` 统计：`wifiroam` 包 121 次、`wireless` 57 次、`firewall` 16 次、`dhcp` 10 次、`network` 4 次）：

| Section（类型/名） | Option | 默认值 | 含义/读写点 |
|---|---|---|---|
| `core`（`globals`） | `enabled` | `'1'` | 守护进程总开关；init 脚本据此决定是否启动；`load_config` 中 `!= "0"` 为 true |
| `core` | `role` | `'unconfigured'` | `cap`/`sap`/`unconfigured`（§1.1） |
| `core` | `token` | `''` | 网络 token；CAP 时为空则 `ensure_token()` 生成 `sha256("wifiroam-<time>-<rand>-<mac>")`；hello 只传其截断哈希，配对时经 TCP 传原文 |
| `core` | `cap_ip` | `''` | SAP 记住的 CAP IP；SAP 无此值时用 hello 学到的 `cap_learned` |
| `core` | `name` | `''` | AP 自定义名；为空时用 hostname（`reconfigure` 中 `state.self.name = cfg.name != "" ? cfg.name : hostname`） |
| `roam`（`roam`） | `enabled` | `'1'` | 漫游总开关 |
| `roam` | `ft_mode` | `'simple'` | `simple`/`explicit`（§4.6） |
| `roam` | `ft_over_ds` | `'1'` | FT over DS |
| `roam` | `k_neighbor` | `'1'` | 802.11k 邻居报告 |
| `roam` | `k_beacon` | `'1'` | 802.11k 信标报告 |
| `roam` | `v_bss_transition` | `'1'` | 802.11v BSS Transition |
| `roam` | `rssi_profile` | `'balanced'` | `aggressive`/`balanced`/`conservative`/`custom` |
| `roam` | `rssi_threshold` | `'-70'` | 自定义档位的 RSSI 阈值（dBm）；非 custom 时强制取 preset |
| `roam` | `config_ver` | `'0'` | 漫游配置版本号；每次 `set_roam` +1；SAP 上报 `roam_ver` 供 CAP 比对 |
| `roam` | `ssids` | （默认文件无此行） | 漫游 SSID 组（列表）；`roam_default_init` 在首次启用时自动填入本机全部主 SSID |
| `roam` | `r_fast` | （默认文件无此行） | 802.11r 快速漫游开关；`current_roam_cfg` 中 `!= "0"` 为 true（缺失时 ucode 的 `!= "0"` 对 null 的求值见 §9） |
| `backhaul`（`backhaul`） | `enabled` | `'0'` | 无线回程开关 |
| `backhaul` | `ssid` | `'wifiroam-bh'` | 回程 SSID（默认常量 `BACKHAUL_DEFAULT_SSID`） |
| `backhaul` | `key` | `''` | 回程密码；启用且为空时沿用旧 key，否则 `randhex(16)` |
| `backhaul` | `device` | `''` | 回程 radio（`pick_radio` 的 prefer 参数） |
| `backhaul` | `config_ver` | `'0'` | 回程配置版本号 |
| `guest`（`guest`） | `enabled` | `'0'` | 访客网络开关 |
| `guest` | `ssid` | `'Guest'` | 访客 SSID（默认常量 `GUEST_DEFAULT_SSID`） |
| `guest` | `key` | `''` | 访客密码；`open` 时为空 |
| `guest` | `bandwidth` | `'0'` | 访客限速（单位见 §9；0 = 不限速；`set_guest` 夹取 0..1000） |
| `guest` | `schedule` | `'0'` | 是否按时段开放 |
| `guest` | `start` / `end` | `'08:00'` / `'23:00'` | 开放时段（`HH:MM`） |
| `guest` | `allow_lan` | `'0'` | 是否允许访客访问 LAN |
| `guest` | `config_ver` | `'0'` | 访客配置版本号（源码中 `guest_cfg().ver` 即此值） |
| `alias_sync` | `ver` | `'0'` | 别名表版本号的 UCI 镜像；`alias_save` 时同步 `state.aliases.ver`；`load_config` 时若 UCI 值更大则抬高内存值 |
| `appctl`（`appctl`） | `enabled` | `'0'` | 应用管控总开关（默认文件仅此一行；`enhanced`/`strict` 由 `set_appctl` 写入） |
| `appctl` | `enhanced` | （无默认） | 精准模式（`set_appctl` 写 `"1"`/`"0"`） |
| `appctl` | `strict` | （无默认） | 严格模式（`set_appctl` 写 `"1"`/`"0"`；空表示沿用） |
| `appdev`（匿名多 section） | `mac` / `name` / `block` | — | 每终端一条：`mac` 为设备组 ID 或原始 MAC，`block` 为被禁应用 id 列表；`appctl_read_devices`/`appctl_write_device` 读写 |
| `ban`（匿名多 section） | `mac` / `name` / `timeon` / `timeoff` / `weekdays` | — | 每终端一条定时断网规则；`ban_read`/`ban_set`/`ban_del` 读写；`timeon/timeoff` 为 `"HH:MM"`，`weekdays` 为空格连接的数字 |
| `schedule`（`schedule`） | `enabled` | （无默认） | 定时断网总开关；`set_ban` 写；`ban_reload_enabled` 的默认逻辑见 §9 |

**其他 UCI 包**：`wireless`（`wifi-iface`/`wifi-device`：漫游 K/V/R 键、回程 sta 口、访客口 `wifiroam_guest=1`、前台 SSID/key）；`firewall`（`@defaults[0]` 的 `flow_offloading`/`flow_offloading_hw`；访客 zone/forwarding/SNAT 段）；`dhcp`（每应用 `config ipset` 段 `wifiroam_<id>`：`table`/`table_family`/`name`/`domain`；`@dnsmasq[0].nftset` 残留清理）；`network`（访客接口，见 `guest_write_infra`）。

### 6.2 `/etc/wifiroam/aliases.json`

- 路径常量：`ALIAS_DIR="/etc/wifiroam"`，`ALIAS_PATH=ALIAS_DIR+"/aliases.json"`。
- 格式：`state.aliases` 全量 JSON（`sprintf("%.J", state.aliases)` 写盘）：`{ver:number, map:{组ID/原始MAC:{name,icon,note}}, groups:{组ID:{members:{原始MAC:true,…},…}}, redirect:{旧组ID:新组ID}, isolated:{组ID/原始MAC:true}, pin:{组ID/原始MAC:目标AP的macnorm}}`。`ver` 为 `time()`（秒级时间戳，`alias_apply`/`pin_apply` 时置为当前时间）。
- 读写：`alias_load()` 启动读（`json(fs.readfile(...))`，失败视为首次启动）；`alias_save()` 每次变更写盘并同步 UCI `alias_sync.ver`；SAP 收到 `push_aliases` 且 `ver` 更大时覆盖内存并 `alias_save()`。`device_reindex()` 在每次加载/分组变化后重建 `device_index`。

### 6.3 应用统计与终端历史文件

- `/etc/wifiroam/appstats.json`（`APPSTATS_PATH`）：`appstats_load()`/`appstats_save()` 读写，内容为 `{stats:{mac:{app:{today,total,last,btoday,btotal,days:{YYYY-MM-DD:秒},bdays:{YYYY-MM-DD:字节}}}}, online:{mac:{YYYY-MM-DD:秒}}, ndata:{mac:{YYYY-MM-DD:字节}}, day:"YYYY-MM-DD"}`（字段名以 `appstats_save` 的写盘对象为准，见 §9：`day` 的具体键名与 `stats` 的顶层结构需以源码第 1209–1233 行原文为准）。统计按原始 MAC 保存，输出时按设备组合并（`appctl_public_stats`/`appctl_public_days`）。
- `/etc/wifiroam/devices.json`（`DEVICES_PATH`）：`devlist_load()`/`devlist_save()` 读写，内容为 `state.devices` 全量 JSON（组 ID→`{mac,ip,hostname,first_seen,last_online,last_offline,online,ap,conn}`）。
- `/etc/wifiroam/nft_schema`（`APPCTL_SCHEMA_PATH`）：`appctl_nft_schema()` 读写的 schema 标识（`sha256` 字符串原文），用于判断 nft 规则是否需重建。
- 临时文件：`/tmp/wifiroam-appctl.nft`（应用管控 nft 脚本，写后 `nft -f` 即删）、`/tmp/wifiroam-ban.nft`（定时断网 nft 脚本，同）、`/tmp/wifiroam/dpi_blocklist`（DPI blocklist，见 §7.2）、`/tmp/wifiroam-dpi.pid`（DPI pidfile）。

### 6.4 `DAEMON_VERSION=5` 的校验点

| 校验点 | 位置 | 行为 |
|---|---|---|
| 守护进程 `status` 返回 | `wifiroamd.uc` 第 4416 行 | `version: DAEMON_VERSION`（=5） |
| 前端 `REQUIRED_VERSION` | `settings.js` | `=5`；`versionStale()` 比较 `st.version !== REQUIRED_VERSION` |
| 前端就绪等待 | `settings.js` | `pollUntil(ready,1000,12000)`，`ready` 为 `status.version===REQUIRED_VERSION` |
| 修复路径 | `settings.js` + ACL | 版本不一致时提示重启；经 `rc init wifiroam restart`（ACL write `rc init`）stop+start 修复；源码第 55 行注释亦写明此约定 |
| 其他校验 | — | **源码中无其他版本校验**：hello 的 `ver:1` 与 `DAEMON_VERSION` 无关；TCP 通道 `auth`/`join` 不校验版本；`roam_sig`/`config_ver` 是配置版本，非守护进程版本 |

---

## 7. Shell 调用清单

### 7.1 调用机制与静默语义

- 唯一同步执行入口是 `cmd_output(cmd)`（第 405–411 行）：`fs.popen(cmd, "r")` → `f.read("all")` → `f.close()`，返回全部 stdout（`?? ""`）；popen 失败返回 `""`。**无返回值检查约定**：调用点大多忽略返回值（仅解析输出者除外）；命令本身的退出码**不被读取**（`fs.popen` 不提供退出码），失败只能从空输出/输出内容推断。
- `2>/dev/null` 语义：几乎所有 `cmd_output` 命令都带 `2>/dev/null`（或 `>/dev/null 2>&1`），即 stderr 被丢弃、命令不存在/执行失败时静默返回空串。这是刻意设计（幂等清理命令如 `nft delete …` 在对象不存在时报错是预期内的），重写时须保留“静默失败、继续执行”的语义，不可改为抛错中断。
- 异步执行入口是 `uloop.process(path, [args], null, callback)`（7 处，见 §7.3），回调收 `res`（退出码，语义见 §9）。
- **注入面**：多数字符串经 `sprintf` 拼接后整句交给 shell（`fs.popen` 走 `/bin/sh -c`），参数来源包括 SSID、MAC、IP、域名、带宽等。重写时须保留原样拼接的语义（§9 列出注入风险点，不自行“修复”）。

### 7.2 `wifiroam-dpi` 的每次调用（单独列出）

二进制本身（`strings` 实测）：C 程序（`wifiroam-dpi.c`，GCC 14.4.0，`-mcpu=cortex-a53`），链接 `libnetfilter_queue`/`libmnl`/`libnfnetlink`；行为：打开 NFQUEUE 队列（队列号见守护进程 `DPI_QUEUE=0`），读 `/tmp/wifiroam/dpi_blocklist`（每行 `MAC 域名,域名,…`），解析 TLS/QUIC SNI，命中则 drop，否则 accept（accept 时带 ct mark 0x1，见守护进程第 888–890 行注释）；监听 `SIGHUP` 重载 blocklist（日志 `DPI reloaded: blocklist %d entries`）、`SIGTERM`/`SIGINT` 退出；内部还 `popen("ip neigh show 2>/dev/null")` 查邻居 MAC（`neigh_refresh`/`neigh_mac`）与读 `/proc/net/arp`；启动日志 `DPI started: blocklist %d entries`。守护进程侧**不解析 dpi 的任何输出**（启动命令的 stdout 被 `cmd_output` 读走后丢弃）。

守护进程中字面值 `wifiroam-dpi` 恰好出现 7 次，逐字位置：第 219 行（注释）、第 224 行（常量 `DPI_DAEMON = "/usr/sbin/wifiroam-dpi"`）、第 225 行（常量 `DPI_PIDFILE = "/tmp/wifiroam-dpi.pid"`）、第 960 行（注释）、第 983 行（注释）、第 987 行（`pidof wifiroam-dpi`）、第 995 行（注释）。其中真正执行该二进制的只有一处：第 1022 行经 `DPI_DAEMON` 常量展开（`/usr/sbin/wifiroam-dpi & echo $! > /tmp/wifiroam-dpi.pid`）；其余对 DPI 的操作均为 `kill`/`kill -HUP`/`pidof` 的 PID 操作。另：管理函数 `appctl_dpi_daemon` 的调用点也恰好是 7 处（第 950、1273、1295、1302、4536、5150、5192 行），见下表。

| # | 位置 | 调用形式 | 触发条件 |
|---|---|---|---|
| 1 | 第 987 行（`appctl_dpi_pid`） | `cmd_output("pidof wifiroam-dpi 2>/dev/null")`，取首个 PID | 每次解析 DPI PID 时优先用 `pidof` |
| 2 | 第 999 行（`appctl_dpi_daemon("stop")`） | `cmd_output(sprintf("kill %s 2>/dev/null", pid))`，随后 `fs.unlink(DPI_PIDFILE)` | stop 且 pid 非空 |
| 3 | 第 1008 行（`appctl_dpi_daemon("reload")`） | `cmd_output(sprintf("kill -HUP %s 2>/dev/null", pid))`（先 `appctl_dpi_write_blocklist()`） | reload 且已运行 |
| 4 | 第 1019 行（`appctl_dpi_daemon("start")`，已运行分支） | `cmd_output(sprintf("kill -HUP %s 2>/dev/null", pid))`（先 `appctl_dpi_write_blocklist()`） | start 且已运行（重写 blocklist 后通知重载） |
| 5 | 第 1022 行（`appctl_dpi_daemon("start")`，未运行分支） | `cmd_output(sprintf("%s & echo $! > %s", DPI_DAEMON, DPI_PIDFILE))`，即 `/usr/sbin/wifiroam-dpi & echo $! > /tmp/wifiroam-dpi.pid` | start 且未运行；后台启动，`$!` 写 pidfile；**无参数、无重定向**（stdout/stderr 继承守护进程的 procd 管道） |
| 6 | 第 950 行（`appctl_table_remove`） | `appctl_dpi_daemon("stop")`（间接调用上述第 2 项） | 应用管控关闭/清表时 |
| 7 | 第 1273/1295/1302/4536/5150/5192 行 | `appctl_dpi_daemon("reload"/"stop"/"start")`（间接调用） | `appctl_tick` 分组变化时 reload（1273）；`appctl_load` 按开关 stop（1295）/start（1302）；`ungroup_device` 成功且 appctl 启用时 reload（4536）；`set_appctl` 启用时 start（5150）；`set_app_policy` 后 reload（5192） |

（注：`appctl_dpi_pid` 的后备路径：第 989–991 行读 pidfile 后 `kill -0 <pid> && echo 1` 校验存活。）

**DPI 与 nft 的配合**（`appctl_apply_rules`，第 834–921 行）：对有被禁应用的终端，把新建连接首包送 NFQUEUE 0（`queue num 0` 规则，见第 902–903 行，两条规则分别对应 IPv4/IPv6，原文以 `DPI_QUEUE` 常量拼接）；ct mark 0x1 = 已放行（dpi 返回 accept 时携带），命中即走快速路径；被拦截的包 dpi 直接 drop，不设 mark，靠其流缓存丢弃后续重传。统计规则必须排在 DPI 之前（队列放行的包会终止本链）；严格模式在 DPI 队列之前丢弃可绕过识别的通道，且必须排在 ct mark accept 快速路径之前。

### 7.3 全部外部命令（按首次出现行号）

| 行号 | 函数 | 命令字面值（`%s` 为 sprintf 占位） | 参数来源 | 输出解析 |
|---|---|---|---|---|
| 793 | `appctl_nft_schema` | `nft flush chain inet wifiroam forward 2>/dev/null`（`APPCTL_TABLE` 展开） | 常量 | 忽略 |
| 796 | 同上 | `nft delete set inet %s %s_%s 2>/dev/null` | 表名、应用 id、`v4`/`v6` | 忽略 |
| 809/811/816/820 | `appctl_nft_base` | `nft add table inet %s 2>/dev/null` 等建表/建 set 命令 | 常量/应用 id/超时 | 忽略 |
| 908 | `appctl_apply_rules` | `nft -f /tmp/wifiroam-appctl.nft 2>/dev/null` | 生成的脚本文件 | 忽略（失败静默） |
| 938/945 | `appctl_hw_suspend` | `/etc/init.d/firewall reload >/dev/null 2>&1` | — | 忽略 |
| 951 | `appctl_table_remove` | `nft delete table inet wifiroam 2>/dev/null` | 常量 | 忽略 |
| 987 | `appctl_dpi_pid` | `pidof wifiroam-dpi 2>/dev/null` | — | `trim` 后按空格取首个 |
| 990 | 同上 | `kill -0 %s 2>/dev/null && echo 1` | pidfile 的 PID | 与 `"1"` 比较 |
| 999/1008/1019 | `appctl_dpi_daemon` | `kill %s 2>/dev/null` / `kill -HUP %s 2>/dev/null` | DPI PID | 忽略 |
| 1022 | 同上 | `/usr/sbin/wifiroam-dpi & echo $! > /tmp/wifiroam-dpi.pid` | 常量 | 忽略 |
| 1036/1038 | `appctl_dnslock_apply` | `nft flush chain inet wifiroam dnsnat 2>/dev/null; nft delete chain inet wifiroam dnsnat 2>/dev/null`（dnslock 同式） | 常量 | 忽略 |
| 1060 | 同上 | `nft -f /tmp/wifiroam-appctl.nft 2>/dev/null` | 生成的脚本文件 | 忽略 |
| 1132 | `appctl_sample` | `nft -j list table inet wifiroam 2>/dev/null` | 常量 | JSON 解析（`json(...)`），取各规则 counter 的 `packets`/`bytes` |
| 1257 | `appctl_warm_step` | `timeout 3 nslookup %s 127.0.0.1 >/dev/null 2>&1` | 预热主机名 | 忽略（只为触发 dnsmasq 解析以填充 nft set） |
| 1310 | `appctl_load` | `/etc/init.d/dnsmasq restart >/dev/null 2>&1` | — | 忽略 |
| 1328 | `offload_apply` | `/etc/init.d/firewall reload >/dev/null 2>&1` | — | 忽略 |
| 1416 | `wireless_uplink` | `iw dev %s link 2>/dev/null` | sta 口 ifname | 解析 `SSID`/`Connected to` 等字段（`field_after`） |
| 1434 | `detect_uplink` | `ip route show default 2>/dev/null` | — | 取默认路由的网关与出口（`field_after`） |
| 1585 | `apply_wifi_local` | `( sleep 2; /sbin/wifi reload >/dev/null 2>&1 ) >/dev/null 2>&1 & echo ok` | — | 忽略（后台延迟 reload） |
| 1634 | `now_minutes` | `date +%H:%M` | — | `trim` 后 `hhmm_minutes` |
| 1745 | `guest_netdevs` | `iw dev 2>/dev/null` | — | 解析接口名与 SSID 的对应关系 |
| 1936/1938 | `guest_nft_apply` | `nft delete table inet wifiroam_guest 2>/dev/null` / `nft add table inet wifiroam_guest 2>/dev/null` | 常量 | 忽略 |
| 1944/1947/1953/1956 | 同上 | `nft add rule inet wifiroam_guest …`（nat SNAT、guard 隔离等） | 访客子网/接口/网关 | 忽略 |
| 1972 | `guest_client_ips` | `ip neigh show dev br-guest 2>/dev/null` | 常量桥名 | 解析 IP 列表 |
| 1987/1989 | `guest_tc_cleanup` | `tc qdisc del dev %s root 2>/dev/null`（访客 vif 与 `br-guest`） | 设备名 | 忽略 |
| 2003/2017 | `guest_tc_apply` | `tc qdisc show dev %s 2>/dev/null` | 设备名 | 含 `htb` 则视为已挂 HTB |
| 2027/2030/2036/2038 | 同上 | `tc qdisc add dev %s root handle 1: htb default 20 2>/dev/null`；`tc class add dev %s parent 1: classid … htb rate %dkbit ceil %dkbit 2>/dev/null`；`tc filter add dev %s parent 1: protocol ip prio 1 u32 match ip dst %s/32 flowid %s 2>/dev/null` | 设备名、带宽（kbit）、IP、classid | 忽略 |
| 2156 | `guest_tick` | `/etc/init.d/firewall reload 2>/dev/null` | — | 忽略 |
| 2212 | `parse_neigh` | `` `ip neigh show dev ${state.brdev} 2>/dev/null` ``（模板字符串） | `br-lan` | 解析 MAC/IP |
| 2241 | `bridge_port_names` | `` `brctl showstp ${state.brdev} 2>/dev/null` `` | `br-lan` | 解析端口名→端口号 |
| 2251 | `parse_fdb` | `` `bridge fdb show br ${state.brdev} 2>/dev/null` `` | `br-lan` | 解析 MAC→端口 |
| 2267 | `parse_fdb`（回退） | `` `brctl showmacs ${state.brdev} 2>/dev/null` `` | `br-lan` | 同上（`bridge` 失败时的回退，见 §9） |
| 2288 | `station_bytes` | `` `iw dev ${ifname} station dump 2>/dev/null` `` | ifname | 解析各站点 `rx bytes`/`tx bytes` |
| 3489/3491 | `precheck` | `apk list --installed 2>/dev/null \| awk '{print $1}' \| grep -E '^wpad' \| head -1`；回退 `opkg list-installed 2>/dev/null \| grep -E '^wpad' \| head -1` | — | 取首行 wpad 包名 |
| 4265/4270 | `ban_flush_flows` | `nft list flowtables 2>/dev/null`；`nft flush flowtable %s %s %s 2>/dev/null` | flowtable 的 family/table/name | 逐行解析 flowtable 名后 flush |
| 4294/4304/4305/4308 | `ban_apply` | `nft delete table inet wifiroam_ban 2>/dev/null`；`nft add table inet wifiroam_ban 2>/dev/null`；`nft add …`（建 forward 链）；`nft flush chain inet wifiroam_ban forward 2>/dev/null` | 常量 | 忽略 |
| 4315 | 同上 | `nft -f /tmp/wifiroam-ban.nft 2>/dev/null` | 生成的脚本文件 | 忽略 |
| 5095 | `offload_status` | `nft list chain inet fw4 forward 2>/dev/null` | — | 含 `"flow add"` 则 active=true |
| 5160 | `set_appctl` | `/etc/init.d/dnsmasq restart >/dev/null 2>&1` | — | 忽略 |

### 7.4 `uloop.process` 异步进程（7 处）

| 行号 | 函数 | 命令 | 回调 |
|---|---|---|---|
| 2076 | `apply_guest_local` | `/etc/init.d/dnsmasq ["reload"]` | 未注明回调行为（源码行内回调见原文；重写时按原文抄） |
| 2078 | 同上 | `/etc/init.d/firewall ["reload"]` | 回调内继续后续步骤 |
| 2094 | 同上 | `/etc/init.d/network ["reload"]` | 空回调 `function() {}` |
| 2095 | 同上 | `/sbin/wifi ["reload"]` | `function(res){…guest_port_sync…}`（res 为退出码，见 §9） |
| 2098 | 同上（嵌套） | `/etc/init.d/network ["reload"]` | 空回调 |
| 2175/2177 | `guest_tick` | `/sbin/wifi ["reload"]` → `/etc/init.d/network ["reload"]` | 同上结构 |
| 3291 | `apply_roam_local` | `/sbin/wifi ["reload"]` | `function(res){ log("wifi reload rc=" + res); }` |
| 3395 | `apply_backhaul_local` | `/sbin/wifi ["reload"]` | 同式（`"backhaul wifi reload rc="`） |
| 3418 | `backhaul_tick` | `/sbin/wifi ["reload"]` | 同式（`"backhaul switch rc="`） |

（注：`uloop.process` 的 7 处按源码行号为 2076、2078、2094、2095、2098、2175、2177、3291、3395、3418——共 10 个调用点，分属 4 个函数；任务书所称“7 处”为约数，正文以行号表为准。）

### 7.5 文件系统直接读写（`fs.*`，非 shell）

- 读：`/etc/wifiroam/aliases.json`、`devices.json`、`appstats.json`、`nft_schema`；`/tmp/wifiroam-dpi.pid`；`/sys/class/net/*/address`；`/proc/sys/kernel/hostname`、`/proc/uptime`；`/tmp/sysinfo/model`；`/etc/openwrt_release`；`/tmp/dhcp.leases`。
- 写：上述 JSON/schema 文件（`fs.mkdir(ALIAS_DIR)` 后 `fs.writefile`）；`/tmp/wifiroam-appctl.nft`、`/tmp/wifiroam-ban.nft`（写后 `nft -f` 即 `fs.unlink`）；`/tmp/wifiroam/dpi_blocklist`（`fs.mkdir("/tmp/wifiroam")` 后写）。
- 删：`fs.unlink(DPI_PIDFILE)`（stop 时）、`fs.unlink(APPCTL_NFT_FILE)`、`fs.unlink(BAN_NFT_FILE)`。
- **无 `fs.exec`**：源码中无 `fs.exec` 调用；所有外部命令均经 `fs.popen`（`cmd_output`）或 `uloop.process`。

---

## 8. 建议的模块划分（Node.js 重写）

> 约束：入口只有一个 `wifiroamd.mjs`；以下 6 个模块均为建议划分，函数归属以 §2 表格的行号为准；模块间只经本节所列接口互相调用，不跨模块碰对方的内部状态；`state` 单例由 `core.mjs` 持有并以受控接口暴露（重写时 `state` 的字段名须与 §1.2 逐字一致）。

| # | 模块 | 含哪些函数（按 §2 行号/名字） | 对外接口（供其他模块调用） |
|---|---|---|---|
| 1 | `core.mjs`（入口 + 状态 + 主循环） | `main`、`log`、`srand`、`rand`、`randhex`、`cmd_output`、`load_config`、`save_config`、`ensure_token`、`reconfigure`、`roam_default_init`、`push_event`、`field_after`，以及 `state` 单例、全部常量（`UDP_PORT`…`APP_DEFS` 等） | `getState()` / `loadConfig()` / `saveConfig()` / `log()` / `cmdOutput()` / `pushEvent()`；`main()` 仅由 `wifiroamd.mjs` 调一次 |
| 2 | `discovery.mjs`（发现 + 对端协议） | `udp_send`、`send_hello`、`udp_rx`、`expire_tick`、`setup_udp`、`setup_tcp`、`srv_accept`、`srv_rx`、`sap_rx`、`sap_connect`、`sap_disconnect`、`sap_tick`、`sap_report`、`conn_close`、`peer_link_dead`、`push_aliases_to`、`push_roam_to`、`push_backhaul_to`、`push_wifi_to`、`push_guest_to`、`push_offload_to`、`apply_result_update`、`apply_backhaul_result_update`、`apply_wifi_result_update`、`apply_guest_result_update` | `setupUdp()` / `setupTcp()` / `sendHello()` / `expireTick()` / `sapTick()` / `sapReport()` / `push*To(mac,…)`；内部的 `srv_rx`/`sap_rx` 不对外暴露 |
| 3 | `clients.mjs`（终端发现、分组、拓扑、历史、WOL） | `macnorm`、`maccolon`、`devnorm`、`mac_is_random`、`device_key`、`device_reindex`、`device_members_of`、`device_alias_of`、`device_host_key`、`device_generic_host`、`device_group_auto`、`device_new_group`、`device_merge_groups`、`device_merge_evidence`、`device_group_refresh`、`device_ungroup`、`parse_leases`、`parse_neigh`、`client_names`、`bridge_port_names`、`parse_fdb`、`station_bytes`、`local_clients`、`freq_band`、`client_name_of`、`diff_events`、`compute_owner`、`owner_events`、`ap_display`、`client_node`、`build_topology`、`devlist_live`、`devlist_load`、`devlist_save`、`devlist_trim`、`devlist_merge_entry`、`devlist_normalize`、`devlist_tick`、`devlist_view`、`find_client`、`wol_packet`、`wol_send` | `localClients()` / `buildTopology()` / `devlistView()` / `devlistTick()` / `deviceGroupRefresh()` / `findClient()` / `wolSend()` / `deviceKey()` 等纯函数；`local_clients()` 是全系统终端数据的唯一来源 |
| 4 | `wifi.mjs`（本机 Wi-Fi、漫游、回程、引导、固定 AP） | `detect_self`、`local_iface_macs`、`lan_broadcast`、`wireless_uplink`、`detect_uplink`、`self_uptime`、`self_info`、`wifi_ifaces`、`wifi_summary`、`apply_wifi_local`、`roam_rename_ssids`、`rssi_preset`、`current_roam_cfg`、`roam_sig`、`roam_md`、`roam_key0`、`roam_key1`、`member_list`、`apply_roam_local`、`applied_kvr`、`wifi_radios`、`pick_radio`、`ethernet_uplink_port`、`current_backhaul_cfg`、`apply_backhaul_local`、`backhaul_tick`、`ssid_groups`、`ap_overview`、`precheck`、`ap_nr_self`、`ap_nr_public`、`steer_bss_list`、`bss_public`、`neighbor_sync`、`steer_tick`、`pin_of`、`pin_apply`、`pin_tick` | `detectSelf()` / `selfInfo()` / `currentRoamCfg()` / `applyRoamLocal()` / `applyBackhaulLocal()` / `applyWifiLocal()` / `backhaulTick()` / `steerTick()` / `pinTick()` / `precheck()` |
| 5 | `guest.mjs`（访客网络） | `hhmm_minutes`、`now_minutes`、`guest_cfg`、`guest_open_now`、`guest_summary`、`mask_prefix`、`ipv4_cidr`、`guest_lan_info`（含局部 `pick`）、`guest_netdevs`、`guest_write_wireless`、`guest_remove_infra`、`guest_write_infra`、`guest_nft_apply`、`guest_client_ips`、`guest_tc_cleanup`、`guest_tc_apply`、`guest_port_sync`、`guest_after_reload`、`apply_guest_local`、`guest_save_local`、`guest_tick` | `guestCfg()` / `guestSummary()` / `applyGuestLocal()` / `guestSaveLocal()` / `guestTick()` |
| 6 | `policy.mjs`（应用管控 + DPI + 定时断网 + offload） | `appctl_app`、`appctl_read_devices`、`appctl_write_device`、`appctl_dnsmasq_sync`（含局部 `as_list`）、`appctl_enhanced`、`appctl_strict`、`appctl_timeout`、`appctl_nft_schema_id`、`appctl_nft_schema`、`appctl_nft_base`、`appctl_apply_rules`、`appctl_hw_suspend`、`appctl_table_remove`、`appctl_dpi_write_blocklist`、`appctl_dpi_pid`、`appctl_dpi_daemon`、`appctl_dnslock_apply`、`prune_days`、`appctl_roll_day`、`appctl_add_time`、`appctl_add_bytes`、`appctl_add_traffic`、`appctl_sample`、`appstats_load`、`appstats_save`、`appctl_warm_list`、`appctl_warm_step`、`appctl_tick`、`appctl_load`、`appctl_track_macs`、`online_sample`、`appctl_public_stats`、`appctl_public_days`、`offload_apply`、`offload_request_cap`、`ban_hm`、`ban_hm_str`、`ban_weekdays`、`ban_read`、`ban_in_window`、`ban_flush_flows`、`ban_apply`、`ban_rule_count`、`ban_reload_enabled`、`ban_load`、`ban_tick` | `appctlLoad()` / `appctlTick()` / `banLoad()` / `banTick()` / `banApply()` / `offloadApply()` / `appctlDpiDaemon()` / `appctlPublicStats()` |

> **合拢注记（2026-11-15）**：上表是“建议划分”，按原版 ucode 函数名列出。实际 JS 落地时 `pin_of`/`pin_apply` 与全部 `ban_*`（含 `ban_list`/`set_ban`/`ban_set`/`ban_del`）只在 `clients.mjs` 实现一份：`wifi.mjs` 的 `pin_of`/`pin_apply` 重复实现与 `policy.mjs` 的整套 `ban_*` 已删掉；`wifi` 只经 `ctx.pinOf` 读固定关系，`policy` 的 `appctl_tick` 只经 `ctx.banApply` 回调 `clients.banApply`，`core` 的 ban 分发与 `ctx.pinOf`/`ctx.pinApply`/`ctx.banApply` 也只接 `clients`。`wifi` 仍保留 `pinTick`（固定 AP 的本机执行），`policy` 仍保留 `appctl_tick` 里的 `banApply(true)` 调用点。
| — | `api.mjs`（ubus 对象，可并入 `core.mjs` 或独立；计入 6 个模块时为第 6 个之外的“第 7 个文件”——为满足“5–7 个模块”，本规格定为 6 个模块：`api.mjs` 并入 `core.mjs`） | `api_obj`（31 个方法处理函数，非具名函数） | `publishApi()`：向 ubus 发布 `wifiroam` 对象；各方法只调上述 6 个模块的对外接口，不直接碰 `state` 的深层字段（`status`/`topology` 等读路径除外，按 §3.1 表格的调用关系） |

**入口 `wifiroamd.mjs`**：仅做 `import { main } from "./core.mjs"; main();`（对应源码末尾 `main();`），不含业务逻辑。**模块间接口规则**：`discovery.mjs` 的 push 函数需调 `wifi.mjs`/`guest.mjs` 的 `apply_*_local`（经参数传入回调或经 `core.mjs` 的注册表注入，避免循环依赖）；`policy.mjs` 需调 `clients.mjs` 的 `localClients()`/`deviceKey()`；`clients.mjs` 不依赖 `policy.mjs`/`guest.mjs`（`device_group_refresh` 中对 `alias_broadcast` 的调用改为经 `discovery.mjs` 的注入回调，保持原有时序：分组变化 → `alias_save` → 广播）。**循环依赖禁区**：`core.mjs` 不反向依赖任何业务模块的内部函数；`api` 的 31 个方法处理函数按 §3.1 表格的“内部调用”列逐一映射到模块接口，不得新增跨模块调用。

---

## 9. 含糊 / 未闭环清单（重写时按原样抄，不发明）

> 以下 24 条为通读 5498 行后无法从源码单独确定语义、或依赖未写明的外部行为之处。重写时**按原样抄**（保留原逻辑、原常量、原静默语义），不得自行“合理化”或补全；如需确认，须以实机行为或上游实现为准。

1. **libubus 通道的线上帧格式未在源码中**：`open_channel`/`defer`/`request`/`reply` 的字节格式、请求 ID 分配、超时、重传、断线检测均由 `ucode-mod-ubus`/`ucode-mod-socket`（只有二进制 `socket.so`，无源码）实现。Node.js 重写须实测抓包或查该模块行为后等价实现，不可凭空发明。
2. **`uloop.process` 回调参数 `res` 的语义**：源码多处 `function(res){ log("wifi reload rc=" + res); }`，未写明 `res` 是退出码、信号还是其他值；`guest_after_reload` 链的回调嵌套顺序（dnsmasq→firewall→network→wifi→network）须按原文逐行抄。
3. **`current_roam_cfg` 中 `r_fast` 缺失时的求值**：`cur.get("wifiroam","roam","r_fast") != "0"`，当 UCI 无此 option（默认文件即无 `r_fast` 行）时，ucode 的 `null != "0"` 求值结果未在源码中说明；重写时须实测 ucode 语义后照抄，不得按直觉取 true/false。
4. **`ban_reload_enabled` 的默认开关逻辑**：源码第 4334–4341 行（`ban_rule_count` 与“无规则默认关/有规则未显式配置默认开”）的具体分支条件未在本规格中逐字复核，重写时以原文为准；`BAN_DEFAULT_ON/OFF`（22:00/07:00）两个常量在 `ban_*` 函数中未见直接引用，其用途未闭环。
5. **`guest_cfg().ver` 与 UCI `guest.config_ver` 的对应**：`set_guest` 用 `prev.ver + 1`，`guest_cfg` 返回的 `ver` 字段是否即 `config_ver`，源码中未给 `guest_cfg` 的完整返回字面量，重写时以第 1638–1654 行原文为准。
6. **`appstats_save` 的写盘对象键名**：第 1221–1233 行的 `sprintf("%.J", {…})` 对象字面量未在本规格中逐字抄录，重写时以原文为准（`day`/`stats`/`online`/`ndata` 的顶层键名与嵌套结构）。
7. **`detect_self` 的完整字段**：`state.self` 含 `mac/ip/name/hostname/model/firmware/nonce/ifaces/bcast` 等，但各字段的回落值（如 LAN 接口无地址时 `ip` 为何值）与 `nonce` 的长度（`randhex` 的参数）未在本规格中逐字抄录，重写时以第 1374–1409 行原文为准。
8. **`self_info` 的完整返回对象**：第 1511–1525 行的字面量未逐字抄录（`ifaces`/`nr`/`uplink` 等字段的取舍），重写时以原文为准；`ap_nr_self` 的 `try{ ubusc.call("network.wireless","status") }` 失败时返回空数组的兜底亦同。
9. **`wifi_summary` 是否含明文密码**：`set_wifi` 的 `unified` 分支读 `wireless` 的 `key` 明文并复制到各频段；`get_wifi` 返回的 `wifi_summary()` 是否含 `key` 明文未在本规格中逐字确认，重写时以第 1526–1560 行原文为准，不得自行脱敏或补全。
10. **`precheck` 的检查项清单**：第 3483–3527 行的 `checks` 数组具体项（wpad 包名、SSID 一致性、radio 数量等）未逐字抄录，重写时以原文为准。
11. **`compute_owner` 的归属规则细节**：第 2836–2851 行的多 AP 同 MAC 归属选择（RSSI、类型、时间戳的优先级）未逐字抄录，重写时以原文为准；`build_topology` 的 `prefer` 表达式（wifi 优先、RSSI 更大者优先）亦同。
12. **`device_merge_evidence` / `device_group_refresh` 的合并证据细节**：主机名、租约、IP、在线时间的匹配阈值与 `device_generic_host` 的通用名清单（第 2475–2482 行）未逐字抄录，重写时以第 2471–2665 行原文为准。
13. **`device_new_group` 的组 ID 生成**：`g` + 12 位十六进制的来源（`salt` 参数是否参与、取自哪个 MAC）未在本规格中逐字抄录，重写时以第 2489–2501 行原文为准。
14. **`ipv4_cidr` 的字节序**：第 1703–1720 行 `sprintf("%s.%s.%s.%s/%d", o[3], o[2], o[1], o[0], prefix)` 为倒序拼接，其输入 `ipmask` 的格式（是否为小端序）未在源码中说明，重写时按原文抄，不得“纠正”为正序。
15. **`guest_write_infra` 的 zone 迁移**：`_guest_zone_migrated` 的迁移条件（从 `option network` 到 `device+subnet`）与各 firewall UCI 段的完整字段未逐字抄录，重写时以第 1822–1927 行原文为准。
16. **`guest_port_sync` 的重试上限**：`tries` 参数的上限值与超限后的行为（`cb` 是否仍被调用）未在本规格中逐字确认，重写时以第 2045–2074 行原文为准。
17. **`guest_tc_apply` 的带宽单位与 classid 分配**：`bandwidth`（`set_guest` 夹取 0..1000）的单位（Mbps 还是其他）与每 IP 的 classid 生成规则未在源码中明文说明，重写时以第 1996–2044 行的 `rate %dkbit` 换算原文为准。
18. **`appctl_nft_base` / `appctl_apply_rules` 的 nft 脚本全文**：第 808–921 行的建表/建 set/统计与封禁规则（含 `ct mark`、DPI 队列、严格模式丢弃规则的精确顺序与优先级）未逐字抄录，重写时以原文为准；`appctl_hw_suspend` 的 firewall `@defaults[0]` 具体改了哪两个 option、改为何值亦以第 922–948 行原文为准。
19. **`ban_weekdays` 的星期编号**：输入 `weekdays` 字符串的数字含义（0=周日还是 1=周一）与 `ban_in_window` 的跨午夜/跨周判定细节未逐字抄录，重写时以第 4208–4262 行原文为准。
20. **`ban_flush_flows` 的 flowtable 解析**：`nft list flowtables` 输出的行格式假设（`f[1]` 为何字段）未在源码中说明，重写时以第 4263–4274 行原文为准。
21. **`offload_apply` 的开关值**：`flow_offloading`/`flow_offloading_hw` 在开/关时各写 `"1"` 还是 `"0"`、是否删除 option，未在本规格中逐字确认，重写时以第 1316–1332 行原文为准。
22. **`local_clients` 的 `ubusc.call("hostapd."+ifname,"get_clients")` 无 try/catch**：若某 hostapd 对象不存在/调用抛错，是否会导致整轮 `local_clients` 中断，源码未写明，重写时按原文抄（不自行加 try/catch）。
23. **Shell 拼接的注入面**：`cmd_output(sprintf(…))` 的参数（SSID、MAC、IP、域名、带宽、PID 等）未经转义直接拼进 shell；重写时保留原样拼接语义，不得自行加转义或改用 argv 方式（除非任务另有要求）。
24. **`report_event` 的发送方未在源码中出现**：`srv_rx` 有 `report_event` 分支（第 3878–3881 行），但全文检索无任何 `defer({method:"report_event"…})` 的发送点（SAP 的 `push_event` 是否经此上报未在源码中写明）；重写时保留接收分支，不补发送点。另：`client_detail` 前端无调用（§3.4），`discover` 不下发 nonce（§3.1），`status` 的 SAP 分支用 roster 改计 peers（§3.1），三者均按原文保留。

---

## 附录 A：源码文件清单（1115 底版）

| 文件 | 说明 |
|---|---|
| `wifiroam-0.1.0-r47/usr/share/wifiroam/wifiroamd.uc` | 守护进程，5498 行，`DAEMON_VERSION=5` |
| `wifiroam-0.1.0-r47/etc/init.d/wifiroam` | 启动脚本，`START=99`，`procd` + `ucode` 执行 |
| `wifiroam-0.1.0-r47/etc/config/wifiroam` | 默认配置，41 行 |
| `wifiroam-0.1.0-r47/usr/sbin/wifiroam-dpi` | DPI 二进制，ARM aarch64，26512 字节 |
| `wifiroam-0.1.0-r47/lib/apk/packages/wifiroam.conffiles` 等 | 升级保留 `/etc/config/wifiroam`、`/etc/wifiroam/aliases.json` |
| `luci-app-wifiroam-0.261115.15302/www/luci-static/resources/wifiroam/common.js` | 前端公共库（`call`/`safeCall`/`pollUntil` 等），`CSS_VER='20261115e'` |
| `luci-app-wifiroam-0.261115.15302/www/luci-static/resources/wifiroam/modelart.js` | 新增：路由器型号→图片映射（`base:'wifiroam/router/'`） |
| `luci-app-wifiroam-0.261115.15302/www/luci-static/resources/view/wifiroam/{settings,advanced,clients,topology}.js` | 四个 LuCI 页面 |
| `luci-app-wifiroam-0.261115.15302/usr/share/rpcd/acl.d/luci-app-wifiroam.json` | ACL：`wifiroam` 31 方法 + `service list` + `rc init` |
| `luci-app-wifiroam-0.261115.15302/www/luci-static/resources/wifiroam/{devices,logos,oui}.js` | 前端静态数据（OUI 库等），不调守护进程 |
| `ucode-mod-socket-…/usr/lib/ucode/socket.so` | ucode socket 模块，只有二进制，无源码 |
| `luci-i18n-wifiroam-zh-cn-…/usr/lib/lua/luci/i18n/wifiroam.zh-cn.lmo` | 中文翻译，已编译 `.lmo`，无源码 |

## 附录 B：事件类型（`push_event` 的 `type`，全文检索）

`paired`、`unpaired`、`ap_online`、`ap_offline`、`cap_connected`、`roam_apply`、`roam_move`、`roam_steer`、`roam_kick`、`pin_kick`，以及 `report_event` 透传的 `args.etype ?? "peer_event"`。事件对象统一为 `{ts,type,mac,name,info}`，`roam_log` 返回最近最多 100 条。

## 附录 C：内置应用清单 `APP_DEFS`（共 47 个）

`wechat`（微信）、`qq`（QQ，domains 为空，仅兼容）、`douyin`（抖音，含 probes）、`tiktok`、`kuaishou`、`kwai`、`bilibili`、`xiaohongshu`、`weibo`、`taobao`（淘宝/天猫）、`iqiyi`、`netease_music`、`youku`、`mgtv`、`zhihu`、`toutiao`、`xigua`、`jd`、`pinduoduo`、`meituan`、`eleme`、`dingtalk`、`feishu`、`wps`、`baidu`、`ximalaya`、`huya`、`douyu`、`mihoyo`（原神/米哈游）、`kugou`、`ctrip`、`rail12306`、`zuoyebang`、`steam`、`netflix`、`spotify`、`bosszhipin`、`mijia`、`aqara`、`arlo`、`philips_hue`、`eufy`、`dlink`、`xiaoyi`、`netatmo`、`withings`、`roku`。每项含 `id`/`name`/`cat`（`social`/`video`/`shop`/`music`/`news`/`office`/`web`/`live`/`game`/`iot`）与 `domains`；`appctl_status` 只返回 `{id,name,cat}`，不返回域名。
