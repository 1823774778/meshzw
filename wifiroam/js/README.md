# wifiroam 守护进程 JS 重写版

原版 `wifiroam-0.1.0-r47`（`wifiroamd.uc`，5498 行 ucode，`DAEMON_VERSION=5`）的
Node.js 重写。LuCI 前端（`luci-app-wifiroam/`）随包原样交付，未改逻辑。
本 README 只写已验证的事实：凡是没在真机上跑过的，一律标明“待验”，不写成已完成。

## 1. 先决条件：Node 二进制（上机前必须先解决）

- 目标 Node 版本：**22.23.4**；包名：openwrt-25.12 feed `lang/node` 中的 `node`。
- **该包是 `PKG_HOST_ONLY` / `BUILDONLY`，目标机没有官方 node 可装。**
  重写能上机之前，必须先解决 Node 二进制来源，二选一：
  1. 静态交叉编译一个 Node 22.23.4 二进制，放到目标机上；
  2. 自建 target 包（把 `lang/node` 的 target 构建打通，自己出 `node` ipk）。
- 在这件事解决之前，本包只能在开发机/沙箱里跑测试，**不能上路由器**。
- init 脚本里写的是 `node`（不带版本号的路径），不写死版本路径：
  `procd_set_param command node /usr/share/wifiroam/wifiroamd.mjs`。
- 零 npm 依赖（`package.json` 的 `engines.node >= 22.23.4`），不需要装任何包。

## 2. 固件里要加什么

构建固件时，除 Node 二进制外，需要把以下文件打进固件（或装机后手动拷入，
见第 3 节）：

| 本包文件 | 目标机落点 |
| --- | --- |
| `wifiroamd.mjs` | `/usr/share/wifiroam/wifiroamd.mjs` |
| `daemon/*.mjs` | `/usr/share/wifiroam/daemon/` |
| `lib/*.js` | `/usr/share/wifiroam/lib/` |
| `etc/init.d/wifiroam` | `/etc/init.d/wifiroam`（可执行权限） |
| `etc/config/wifiroam` | `/etc/config/wifiroam` |
| `luci-app-wifiroam/usr/**` | `/usr/**`（按原目录结构合并） |
| `luci-app-wifiroam/www/**` | `/www/**`（按原目录结构合并） |

不需要改动系统其它部分。守护进程不依赖 ucode，不再需要 `/usr/bin/ucode`。

## 3. 装到路由器上

```sh
# 1. 拷文件（按第 2 节的表；scp/rsync 均可，注意保留 /etc/init.d/wifiroam 的可执行位）
# 2. 确认 node 可用（见第 1 节；PATH 里必须有 node 22.23.4）
node --version          # 应为 v22.23.4

# 3. 启用并启动服务
/etc/init.d/wifiroam enable
/etc/init.d/wifiroam start
logread -f              # 看 wifiroam: started role=... 一行

# 4. 停用 / 停止
/etc/init.d/wifiroam stop
/etc/init.d/wifiroam disable
```

UCI 配置（`/etc/config/wifiroam`，与原版逐字相同，41 行）：

```sh
uci show wifiroam            # 查看
uci set wifiroam.core.enabled=1
uci set wifiroam.core.role='cap'   # cap / sap / unconfigured
uci set wifiroam.core.token='...'  # 配对口令
uci commit wifiroam
/etc/init.d/wifiroam restart
```

`START=99`、`STOP=10`、`USE_PROCD=1`、`respawn 3600 5 5` 与原版 init 脚本一致，
唯一改动是执行命令由 `/usr/bin/ucode /usr/share/wifiroam/wifiroamd.uc` 改为
`node /usr/share/wifiroam/wifiroamd.mjs`。

## 4. 不变的东西

- `DAEMON_VERSION = 5`（`daemon/core.mjs` 导出；ubus `status` 返回 `version: 5`）。
- 端口不变：UDP **50607**（发现 hello / 广播），TCP **50608**（CAP–SAP 通道）。
- 配置与状态路径不变：UCI `wifiroam`；别名 `/etc/wifiroam/aliases.json`；
  应用统计 `/etc/wifiroam/appstats.json`；nft 脚本 `/tmp/wifiroam-ban.nft`、
  `/tmp/wifiroam-appctl.nft`；DPI blocklist `/tmp/wifiroam/dpi_blocklist`、
  pidfile `/tmp/wifiroam-dpi.pid`。
- ubus 对象名 `wifiroam`，注册 **31 个方法**，与原版一致。

## 5. 沙箱里实际跑过的检查（2026-11-15，沙箱 Node v24.22.1）

> 注意：沙箱只有 Node v24.22.1，目标是 22.23.4。代码只用 22.23.4 已有 API
>（`tests/infra.test.mjs` 的 F16 用例 grep 禁用清单：`Promise.try`、
> `RegExp.escape`、`Float16Array`、`Error.isError`、`Atomics.pause`、
> `URLPattern`、`using` 声明）。上机验收仍须用 22.23.4 二进制重跑全部测试。

| 套件 | 用例 | 通过 |
| --- | --- | --- |
| infra（`lib/`：blobmsg/ubus/uci/shell/util/store） | 44 | 44 |
| daemon-core | 41 | 41 |
| daemon-discovery | 47 | 47 |
| daemon-clients | 37 | 37 |
| daemon-wifi | 33 | 33 |
| daemon-guest | 39 | 39 |
| daemon-policy | 33 | 33 |
| frontend-mock（LuCI 前端 mock） | 22 | 22 |
| integration（模拟集成，见下） | 1 | 1 |
| **合计** | **297** | **297** |

- `node --check`：`wifiroamd.mjs`、`daemon/*.mjs`、`lib/*.js`、`tests/*.mjs`
  全部通过。
- LuCI 的 9 个 JS 文件（`luci-app-wifiroam/www/luci-static/resources/` 下
  `view/wifiroam/{settings,advanced,clients,topology}.js` 与
  `wifiroam/{common,devices,logos,modelart,oui}.js`）用函数包裹验语法，9/9 通过。
  裸 `node --check` 会报 `Illegal return statement`，那只是工作目录
  `package.json` 的 `type:module` 让 Node 按 ESM 解析顶层 `return` 所致，
  不是代码问题，不要“修”它。正确验法（逐文件）：
  ```sh
  { echo 'function __check(){'; cat <文件>; echo '}'; } > /tmp/luci-check.cjs
  node --check /tmp/luci-check.cjs
  ```
  （`.cjs` 强制按 CommonJS 解析；`/tmp` 里的临时文件验完即删，不进交付包。）

### 跑测试的方法

```sh
npm test            # 等价于 node --test tests/*.test.mjs
node --test         # 裸跑也可以（会同时跑 tests/ 下全部 *.test.mjs）
```

不要用 `node --test tests/` 目录模式：在沙箱 Node v24.22.1 上它会把
`tests/` 当模块路径报 `MODULE_NOT_FOUND`；同一个失败在 `/tmp` 下的平凡目录上
也能复现，是 Node runner 对裸目录参数的处理怪癖，与测试内容无关。

### 集成测试覆盖了什么（`tests/integration.test.mjs`，1 个用例，设 30 秒总超时）

假 ubusd（按 `lib/ubus.js` 实现的协议，unix socket）+ 内存 FakeUci +
mock dgram + 真实 `node:net` TCP 对端，跑一次守护进程完整启动流程：

加载配置 → 注册 ubus 对象（31 个方法，SIGNATURE 可解码）→ 收到发现 hello →
ubus `status`（`version: 5`，role `cap`）→ ubus `topology`（含本机节点）→
`udpRx` 未配置 hello 进 `discovered` → ubus `pair`（未知 MAC 报 `not_found`；
已知 MAC 配对成功）→ TCP 对端建连、收 server hello、`auth`
（`digest = sha256(token:nonce)`）通过 → 对端收到 `push_roam_config` 与
`push_offload` → 对端 `report_status` 回执正常、拓扑含对端 → ubus `set_roam`
返回 `{ok:true, ver:2}`，UCI roam ssids 为 `['HomeWiFi']`、config_ver 为 `'2'` →
`daemon.stop()` 停干净（`started === false`，无 exit 调用）。

两处沙箱限制，已在测试里注明：

- **真实 UDP 发送跳过**：沙箱禁 UDP 发送（`send` 报 `EPERM`），mock dgram 的
  `send` 只记录不真发；UDP 接收路径用直接调 `udpRx` 与 mock 覆盖。真机上
  UDP 收发仍待验（见第 7 节）。
- 集成测试的 hello 发现断言只看 mock dgram 记录到了 `magic 'WIFIROAM1'` 的
  hello 帧，不证明真机组网可达。

## 6. 合拢时修掉的 bug（相对各模块单独交付时）

1. **去重 pin**：`pin_of` / `pin_apply` 在 clients 与 wifi 各有一份，唯一实现
   定为 **clients**（core 的 `set_pin` 本来就接 clients）。删掉 wifi 的
   `pinOf` / `pinApply` 定义、`aliasSave` 回退与 `saveAliases` 导入；
   wifi 改为必须注入 `ctx.pinOf`（缺失时抛 `TypeError`），`steerTick` /
   `pinTick` 只经注入的 `pinOf` 读 pin。
2. **去重 ban**：`ban_*` 在 clients 与 policy 各有一份，唯一实现定为
   **clients**（core 的 ban 路由本来就接 clients；policy 那份还有个 latent
   bug：`banSet` 是同步的且 `findClient` 没 await，clients 的是 async 且正确）。
   删掉 policy 的 15 个 ban 函数与相关常量；policy 的 `appctlTick` 重组路径
   改走注入的 `ctx.banApply`（未注入时为空操作）。
3. **规格笔误**：`spec.md` 附录 C 的 `APP_DEFS` 是 47 个不是 44 个（policy 与
   core 均已逐项核对），已改成 47。
4. **测试跑法**：`node --test tests/` 目录模式失败的原因查清（见第 5 节），
   `tests/frontend-mock.mjs` 改名 `tests/frontend-mock.test.mjs`，
   `package.json` 增加 `"test": "node --test tests/*.test.mjs"`，
   删掉 `tests/dbg-restart.test.mjs`（3 行 scratch）。
5. **lib 无回执哨兵**：`lib/ubus.js` 新增导出的 `UBUS_NO_REPLY`
   Symbol——handler 返回它时，对该 INVOKE 不发任何回包（既不发 DATA 也不发
   STATUS），对端挂起直至超时，复刻原版对未认证/未知方法请求的静默丢弃。
   infra 测试补 D13/E14 覆盖。注意：core 的 handler 目前**还没接上**这个哨兵
   （见第 8 节第 11 条），只是 lib 具备了能力。
6. **异步接口不一致（合拢时集成测试抓出来的真 bug）**：clients 的
   `localClients` / `buildTopology` / `findClient` / `deviceGroupRefresh`、
   wifi 的 `bssPublic` / `selfInfo` 都是 async，但 discovery 的 `srvRx` /
   `sapRx` / `sapReport`、policy 的 `appctlTick` / `appctlTrackMacs` /
   `onlineSample` / `appctlApplyRules` / `appctlLoad` / `setAppctl` /
   `setAppPolicy`、core 的 `client_detail` / `set_appctl` / `ungroup_device`、
   clients 自身的 `ungroupDevice` 之前都把它们当同步用。后果分三档：
   - **直接崩**：`srvRx` 的 `report_status` 回执里塞进未 await 的 `bssPublic()`
     Promise，`get_topology` 直接 `req.reply()` 一个 Promise，blobmsg 编码抛错，
     lib 回 STATUS 9（`UNKNOWN_ERROR`）；`sapReport` 的 defer DATA 里塞进
     `localClients()` / `selfInfo()` Promise，编码抛错被 catch 后断开 SAP 链路——
     真机上 SAP 每 10 秒上报都会断链重连。
   - **静默算错**：`ownerEvents(Promise)` 得空归属表；`findClient` 的 Promise
     恒为真值，`get_client_detail` / `client_detail` 恒回 `{ok:true, client: undefined}`；
     `onlineSample` / `appctlTrackMacs` 拿 `Object.keys(Promise)` 得空集，本机终端
     的在线时长与应用规则集恒为空；`appctlTick` 里 `deviceGroupRefresh()` 不 await，
     `regrouped` 恒落后一个 tick。
   - 修法：上述函数全部改 async 并 await 对应的跨模块调用；lib 的
     `_handleInvoke` 本来就 `await handler(req)`，所以 channel handler 改 async
     不破坏协议。相关测试的 FakeChannel `deliver` 改 async，全部调用点加 await。
     修复后集成测试全绿。原模块测试里这些 mock 本来就是同步返回值，
     `await` 非 Promise 不改变行为，所以单模块测试之前全绿、合拢才暴露——
     教训记在这里：**单模块 mock 掩盖了跨模块的 async/sync 错配**。

## 7. 真机待验项（没做过的，不写进“已完成”）

1. **ubus 真机互通**：与真实 `ubusd` / 真实 ucode 对端对测，尤其 `SIGNATURE`
   的具体编码、`DATA` 多条返回、`ubus call` 逐字段比对；按 research §2.12 的
   C/D/E 组在路由器上跑闭环。
2. **UDP 真实收发**：50607 的 hello 广播/接收在真机上跑通（沙箱禁发，只测了接收路径）。
3. **hostapd 联调**：wifi 模块的 hostapd/无线配置下发、漫游切换在真机上跑通。
4. **双机配对漫游**：两台真机（CAP + SAP）配对、拓扑、漫游配置下发、终端跨 AP
   迁移全流程。
5. **Node 22.23.4 重跑全部测试**：沙箱是 v24.22.1；拿到 22.23.4 二进制后，
   `npm test` 297 个用例要在 22.23.4 上重跑全绿。
6. **固件集成**：按第 2 节把文件打进固件（或手动拷入）后，`init enable/start`
   与重启自启在真机上验证。

## 8. 未等价项（汇总自 INTERFACE.md §8、各模块汇报与 lib 差异）

1. 真机 ubusd 对测未做（见第 7 节第 1 条）；帧格式、HELLO 握手、`(seq, peer)`
   匹配、对象发布均按 research 文档的源码引用实现，沙箱里用假 ubusd / 假对端
   对测通过，但 research §2.13 明确指出“未在真机上抓包验证”。
2. `SIGNATURE` 编码为按文档推断：research 只写“每个方法一个 TABLE，内含
   `{参数名: 类型码}`”，未给逐字节样例。实现为方法名 TABLE + INT32 类型码字段；
   若真机 `ubus call` 对照发现出入，以真机为准修正。
3. uci `set()` 要求 section 已存在：CLI 行为；ucode cursor 是否隐式建
   section 未在原版源码中写明。本模块 `set()` 在 section 不存在时回 `false`
   （不抛），调用方须先 `add()`。原版所有 `set()` 目标均已存在或刚被创建，
   搬运时不受影响。
4. `get()` 的 list 判定来自 `uci show` 解析：单 token 回字符串、多 token /
   重复行回数组；ucode cursor 同样按 list 与否区分返回类型，语义一致，但
   CLI 输出的引号转义解析只覆盖常规值（含空格的值用单引号包裹；值内含单引号
   的极端情况不在覆盖内）。
5. 原子写是唯一 deliberate 的行为改动：原版 `fs.writefile` 直接覆盖；本任务
   要求写临时文件再 rename。读路径与字段形状与原版一致。
6. `alias_save()` 的 UCI 同步不在 `store.js`：原版 `alias_save()` 写完 JSON
   还写 UCI `alias_sync.ver`；`saveAliases()` 只写 JSON，调用方（业务模块）
   须随后调 `uci.set('wifiroam','alias_sync','ver',…)` + `commit`，否则别名
   版本号的 UCI 镜像会落后。
7. `cmdOutput` 的 stderr 丢弃位置：原版 `fs.popen` 下不带 `2>/dev/null` 的命令
   其 stderr 会进 procd 日志；本模块的同步执行器一律丢弃 stderr（命令串自身的
   `2>/dev/null` 原样保留）。只影响日志可见性，不影响返回值。
8. Node 版本：沙箱只有 Node v24，测试在 v24 上跑过；代码只用 Node 22.23.4
   已有 API（见第 5 节），上机验收仍须用 22.23.4 二进制重跑。
9. `ipv4_cidr` 的倒序拼接原样保留（spec §9.14），`1 << host` 改为 `2 ** host`
   只是 JS 32 位位运算的数值等价替换，结果不变。
10. 订阅/事件（SUBSCRIBE/NOTIFY/事件总线）未实现：wifiroam 不用；收到的这类
    消息只透出 `'message'` 事件，不崩溃。`notify()` 只发送，不跟踪订阅者。
11. **lib 的 STATUS / 无回执差异（合拢结论）**：lib 已支持 `UBUS_NO_REPLY`
    哨兵（见第 6 节第 5 条），但 core 的 handler 目前**没有**返回它：整数
    handler 结果仍按原有逻辑回 STATUS OK 且无 DATA（INTERFACE.md 记的 N2
    行为）。即“原版对未认证/未知方法静默丢弃”在 lib 层已可复刻，在业务层
    尚未接线——属于待办，不悄悄改行为。
12. 本重写只覆盖守护进程 + LuCI 前端；`wifiroam-dpi` 等外部二进制、hostapd、
    dnsmasq、nft 等系统依赖与原版相同，不在本包内。

## 9. 边界：什么叫“没有 bug”

“没有 bug”只指**沙箱内可测部分全绿**：297 个用例（含 1 个模拟集成用例）在
沙箱 Node v24.22.1 上 0 失败，`node --check` 与 LuCI 函数包裹验语法全部通过。
真机组网行为（第 7 节）仍需用户在路由器上实测后才算数；第 8 节列出的未等价项
在真机验证前一律视为已知差异，不视为已修复。

## 10. 树结构

```
wifiroamd.mjs              入口（procd 调 node 起它）
daemon/
  core.mjs                 启动/定时器/ubus 对象（31 方法）/状态机
  discovery.mjs            UDP 50607 发现 + TCP 50608 CAP-SAP 通道 + 配对
  clients.mjs              终端/设备组/别名/pin/ban/拓扑（pin 与 ban 的唯一实现）
  wifi.mjs                 本机无线/漫游/steer/pin tick（pin 只读 clients）
  guest.mjs                访客网络
  policy.mjs               应用管控/上网统计（ban 只调 clients）
lib/
  blobmsg.js ubus.js uci.js shell.js util.js store.js
luci-app-wifiroam/         LuCI 前端（140 文件，原样交付）
etc/
  init.d/wifiroam          procd 服务脚本
  config/wifiroam          默认 UCI 配置（与原版逐字相同）
tests/                     9 套测试，297 用例
spec.md                    规格（附录 C 的 APP_DEFS 已修正为 47）
research-node-ubus.md      ubus 协议调研
INTERFACE.md               模块接口与未等价项（第 8 节为其 §8 的汇总）
package.json               type:module；"test": "node --test tests/*.test.mjs"
```

## 11. 无线回程（`mode` = `relay` / `wds`，默认 `relay`）

无线回程是 SAP 侧在网线拔掉后把 LAN 接到 CAP 的通道。两种实现：

- `relay`（默认，真机验证过的方案）：STA 走独立的 netifd 接口
  `network.wifiroam_sta`（`proto dhcp`，不挂桥），随后跑
  `relayd -D -B -i br-lan -I <sta>` 做伪桥：广播/DHCP 由 relayd 中继，
  单播靠 `proxy_arp` + `ip route replace <gw>/32 dev <sta> scope link`
  把回程流量钉到 STA 上，并在 `inet fw4 forward/input` 链首插入带
  `comment wifiroam-relay` 的放行规则（`add rule` 会被 `jump forward_lan`
  之后的 `jump handle_reject` 吃掉，必须 `insert`）。
- `wds`（旧方案）：`wireless.wifiroam_bh` 用 `wds 1` + `network lan`，
  由驱动做 4 地址封装。在本仓库验证过的 ath11k + NSS 组合上，AP 侧
  始终不创建 `phy0-ap1.sta*` AP_VLAN、`brif` 不变，4 次握手
  `Reason: 15=4WAY_HANDSHAKE_TIMEOUT`，因此只作为兼容选项保留。

回程状态全部集中在 `S._bh`，关键节拍（`BH_WIRED_DEBOUNCE` 12 s、
`BH_WIRELESS_DEBOUNCE` 10 s、`BH_STA_REARM` 60 s、`BH_FW_PROBE` 30 s、
`BH_WEDGE_LOG` 300 s）与 `.uc` 版本一致。判断“有线在场”必须同时满足
`carrier == 1` 与设备 `operstate == up`：qca-ppe 在端口 admin down 后仍会
报 `carrier=1`，只看 carrier 会让 daemon 一分钟内都以为网线还在。

DHCP 租约事件不再走 ubus 对象，而是由 `/etc/udhcpc.user.d/90-wifiroam-dhcp-lease`
追加到 `/tmp/wifiroam/dhcp-leases.log`（`<epoch> <logic-iface> <device> <addr> <event>`，
只认 `bound|renew`，超 64 KB 截断为最后 200 行），daemon 每轮 tick 只采信
120 秒内的记录。

CAP 侧 `backhaulCapReconcile()` 带楔死探测：站已关联但 30 秒内没有
`authorized`，或 station dump 为空却有连续 3 条 `local deauth request`，
每 300 秒打一条
`backhaul AP <if> wedged: station(s) associate but never authorize — reboot the router to clear the NSS peer table`。
这是固件问题（`nss-wifi-drv … interface 203 type 7 refused: 26` 与
`peer …: delete failed: -71, record kept` 成对刷屏后数据面即死），
`wifi up radio0` 与重建 vif 都清不掉，只能整机重启；daemon 只报不重启。