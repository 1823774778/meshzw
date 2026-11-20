# wifiroam JS 重写 · 调研：Node.js 版本与 ubus 协议

- 调研日期：2026-11-15
- 调研范围：只做调研，不写重写代码，不改底版文件。
- 底版对照：`~/workspace/work-1104/extracted/wifiroam-0.1.0-r34/usr/share/wifiroam/wifiroamd.uc`（下称“底版”）、`~/workspace/wifiroam-js/spec.md`
- 方法：全部结论来自实测或源码原文。Node 版本用 `raw.githubusercontent.com` 读 feed 文件核对，并下载官方 `node-v22.23.4-linux-x64` 二进制实测 API；ubus 用 `openwrt/ubus`、`openwrt/libubox`、`jow-/ucode` 三个仓库 master 分支（2026-11-15 拉取）的源码原文。凡写“实测”即沙箱内真实跑过；凡写行号即本次拉取文件的行号，master 分支后续移动后行号可能漂移，以文件名为准。

## 结论先行（TL;DR）

### Node

- **目标版本：Node.js 22.23.4，包名 `node`**（`lang/node/Makefile`：`PKG_NAME:=node` 第 10 行，`PKG_VERSION:=22.23.4` 第 11 行，`PKG_RELEASE:=1` 第 12 行）。分支已核对为 `openwrt-25.12`（分支 HEAD `c2c619e6f065b238ab000b6cfc5afa238658b0c9`，2026-11-12）。
- **最大风险：该包是 `PKG_HOST_ONLY`（第 29 行）且 `Package/node` 带 `BUILDONLY:=1`（第 41 行）**——它是只编宿主机、不出目标机 ipk 的包。按此 Makefile，`opkg install node` 在 25.12 目标机上没有官方包可用；重写若要在路由器上跑 Node，必须另行解决 Node 二进制来源（静态编译、自建 feed 等，本调研不展开，只点出缺口）。
- V8 12.4.254.21、npm 10.9.9、libuv 1.51.0、OpenSSL 3.5.9；`NODE_MODULE_VERSION:=127`（第 13 行）；宿主机编译依赖只有 `python3/host`（第 27 行）；无目标机运行时依赖（`Package/node` 段内无 `DEPENDS`）。
- **任务前提纠正（重要）：`Array.fromAsync`、`Object.groupBy`、`Promise.withResolvers` 在 Node 22.23.4 里全部存在**——实测 `typeof` 均为 `function`。它们不是禁用项，不要从重写里删掉。真正禁用的见 §1.5。
- 沙箱 Node v24.22.1 有、目标 22.23.4 没有（实测）：`Promise.try`、`RegExp.escape`、`Float16Array`、`Error.isError`、`Atomics.pause`、`URLPattern`（全局）、`using`/`await using` 声明语法。

### ubus

- 线路格式：**8 字节 `ubus_msghdr`（`version=0`，`type`，`seq` BE16，`peer` BE32）+ 一个外层 `blob_attr`**；**没有独立的长度前缀**，长度由外层 `blob_attr` 的 `id_len` 字段（低 24 位，含自身 4 字节头）给出；单条消息上限 1 MiB（`UBUS_MAX_MSGLEN=1048576`，`ubus/CMakeLists.txt:18`）。
- **握手是服务端先发**：连上 `/var/run/ubus/ubus.sock` 后第一条消息必须是服务端发来的 `UBUS_MSG_HELLO`，客户端从它的 `hdr.peer` 取自己的 `local_id`（必须 > 1）；客户端不发 HELLO。
- 调用对应关系：请求序号是客户端自增的 `uint16 request_seq`，响应按 **(seq, peer) 二元组**匹配 pending 表；一次调用的正常响应是 0..n 条 `UBUS_MSG_DATA` + 一条 `UBUS_MSG_STATUS`（状态码在 `UBUS_ATTR_STATUS` 里）。
- blobmsg：属性头 4 字节大端（最高位 extended、次 7 位类型 id、低 24 位长度），全部按 4 字节对齐；名字段是 `namelen(BE16)+名字+NUL`，头部再垫到 4 字节；数值一律大端；字符串含结尾 NUL；`BOOL` 就是 `INT8`（0/1）；没有“空值”类型，JSON `null` 对应零长度的 `UNSPEC` 字段，缺失字段就是属性不存在。
- 对端直连（`open_channel`）：同一套消息流走裸 TCP，不经过 ubusd，不握手 HELLO，`local_id` 固定为 1，请求 `peer` 一律填 0，不能 `ADD_OBJECT`/`LOOKUP`。

---

# 第一章 Node 版本结论

## 1.1 版本号、包名与分支核对

来源：`https://raw.githubusercontent.com/openwrt/packages/openwrt-25.12/lang/node/Makefile`（2026-11-15 拉取）。

| 项 | 值 | 来源行 |
|---|---|---|
| 包名 | `node` | `PKG_NAME:=node`，第 10 行 |
| 版本 | **22.23.4** | `PKG_VERSION:=22.23.4`，第 11 行 |
| Release | 1 | `PKG_RELEASE:=1`，第 12 行 |
| 源码包 | `node-v22.23.4.tar.gz`，`https://nodejs.org/dist/v22.23.4` | 第 15–16 行 |
| 源码 SHA256 | `4dd79de8cdc85d65cb32f48a75aee1067bf00bf94b96ecc8e4c2f82f6f0272c2` | `PKG_HASH`，第 17 行 |
| 原生模块 ABI | `NODE_MODULE_VERSION:=127` | 第 13 行 |
| 维护者 | Hirokazu MORIKAWA、Adrian Panella | 第 22 行 |
| 许可证 | MIT | 第 23 行 |
| 宿主机编译依赖 | `python3/host` | `HOST_BUILD_DEPENDS`，第 27 行 |
| 目标机依赖 | 无（`Package/node` 段内无 `DEPENDS` 行） | 第 33–42 行 |

分支核对：GitHub API `repos/openwrt/packages/branches/openwrt-25.12` 返回分支名 `openwrt-25.12`，HEAD 提交 `c2c619e6f065b238ab000b6cfc5afa238658b0c9`（2026-11-12，`apache: update to version 2.4.71`）。本次读到的 Makefile 即该分支 HEAD 的内容。

版本历史（`GET repos/openwrt/packages/commits?path=lang/node/Makefile&sha=openwrt-25.12`）：最近一次 bump 是 `d6d01b496f20f055536a98b9433e4e061051ced8`，`node: bump to 22.23.4`（提交者日期 2026-10-26），说明是安全更新合入；再往前是 22.23.2（2026-08-04）、22.23.0（2026-06-24）。即 feed 的 22.23.4 是 2026-10-20 发布的 Node 安全版。

**滞后提醒**：Node 官方 `https://nodejs.org/dist/index.json` 显示 `v22.23.5` 已于 2026-11-11 发布（npm 10.9.9，OpenSSL 3.5.9），feed 在 2026-11-12 的 HEAD 上仍是 22.23.4。两者同属 22 大版本、同一 V8 系，API 层面无差别；写代码按 22.23.4 测，升级补丁时只跟 patch 号即可。

## 1.2 关键发现：这个 `node` 包不出目标机 ipk

`lang/node/Makefile` 第 29 行：

```
PKG_HOST_ONLY:=1
```

第 41 行（`define Package/node` 段内）：

```
BUILDONLY:=1
```

含义（按 Makefile 字面）：该包只做宿主机编译、不生成目标机安装包。`lang/` 目录下也没有第二个目标机用的 node 包（同目录只有 `node-javascript-obfuscator`、`node-yarn` 等，与运行时无关）。**结论：按 openwrt-25.12 feed 原样，路由器上没有官方 `node` 可装；JS 重写要落地，必须先解决 Node 22 二进制的上机方式**（例如静态交叉编译一个 `node` 二进制随 wifiroam 包一起发，或自建 target 包）。这不是代码写法问题，是部署前置条件，重写开工前须先定。

## 1.3 运行时参数（Node 22.23.4）

来源：`https://nodejs.org/dist/index.json` 中 `v22.23.4` 条目 + 沙箱下载官方二进制实测（`node-v22.23.4-linux-x64.tar.xz`，31,029,996 字节）。

| 项 | 值 |
|---|---|
| `process.version` | `v22.23.4`（实测） |
| V8 | `12.4.254.21-node.57`（实测 `process.versions.v8`） |
| npm | 10.9.9 |
| libuv | 1.51.0 |
| OpenSSL | 3.5.9 |
| LTS 代号 | Jod（Maintenance，EOL 2027-04-30，按 Node 官方发布日程） |
| 沙箱对照 | Node v24.22.1：V8 13.6.233.17、npm 11.19.1、libuv 1.52.1、OpenSSL 3.5.9 |

## 1.4 与重写相关的 API：22.23.4 实测可用清单

实测方法：下载官方 `node-v22.23.4-linux-x64`，跑 `typeof` / `require` 探针；沙箱 Node v24.22.1 同脚本对照。凡打 `✓` 均在 22.23.4 上真实返回可用。

| 用途（对照底版行为） | API | 22.23.4 |
|---|---|---|
| UDP 收发、广播发现（底版 `detect_self` 算 `bcast`、UDP 服务） | `node:dgram` `createSocket('udp4')`、`setBroadcast(true)`、`send`/`bind` | ✓ |
| TCP 服务/客户端（底版 TCP 通道） | `node:net` `createServer`/`createConnection`、`net.isIP` | ✓ |
| 随机数、SHA-256 签名（底版 `randhex`、`roam_sig` 用 sha256） | `node:crypto` `randomBytes`、`createHash('sha256')`、`webcrypto.subtle` | ✓ |
| 调外部命令（底版大量 `fs.popen` 调 `nft`/`iw`/`ubus` 等） | `node:child_process` `spawn`/`execFile` | ✓ |
| 读写 `/etc/wifiroam/*`、`/proc`、`/sys` | `node:fs`、`node:fs/promises`（`readFile`/`writeFile`/`mkdir`）、`fs.glob`/`fs/promises.glob` | ✓（glob 在 22.23.4 上实测存在） |
| 定时器（底版 `uloop` interval/timer） | `node:timers/promises` `setTimeout`/`setInterval` | ✓ |
| 二进制拼包（ubus/blobmsg 全靠它） | 全局 `Buffer`（`from`/`alloc`/`concat`、`readUInt16BE` 等）、`TextEncoder`/`TextDecoder` | ✓ |
| JSON、结构化克隆、fetch | 全局 `JSON`、`structuredClone`、`fetch`、`FormData`、`Headers`、`AbortController`、`AbortSignal.timeout` | ✓ |
| WebSocket 客户端 | 全局 `WebSocket` | ✓（22.4 起默认开启） |
| 事件、流、工具 | `node:events`、`node:stream`、`node:path`、`node:os`、`node:util`（`promisify`、`styleText`）、`node:string_decoder`、`node:worker_threads`、`node:async_hooks`、`node:diagnostics_channel`、`node:readline`、`node:zlib`、`node:url`、`node:assert`、`node:querystring` | ✓（逐个 `require` 实测通过） |
| `process.getBuiltinModule` | 22.3 起加入 | ✓ |
| `require()` 加载 ESM | `require(esm)` | ✓（22.23.4 实测 `require('/tmp/esm-test.mjs')` 返回 `{v: 42}`） |
| TypeScript 类型剥离 | `node file.mts`（仅擦除式语法） | ✓（22.23.4 实测无 flag 直接跑通） |
| `node:sqlite`（`DatabaseSync`） | `require('node:sqlite')` 无需 flag 即可加载，实测建表成功 | △ 见 §1.6（实验性，守护进程不要用它存状态） |

## 1.5 禁用清单：沙箱 v24 有、目标 22.23.4 没有

下表每一项都在两个二进制上用同一探针实测过（`typeof`），不是凭印象。

| 禁用（22.23.4 上不存在） | 在 v24.22.1 上 | 说明 |
|---|---|---|
| `Promise.try` | `function` | ES2025，V8 12.9+ / Node 23+。替代：`Promise.resolve().then(fn)` 或 `async` 包装 |
| `RegExp.escape` | `function` | ES2025，Node 24+。替代：手写转义 `s.replace(/[.*+?^${}()\|[\]\\]/g, '\\$&')` |
| `Float16Array` | `function` | ES2025，Node 24+。与本次重写无关，列出防误用 |
| `Error.isError` | `function` | Node 24+。替代：`instanceof Error`（跨 realm 时注意） |
| `Atomics.pause` | `function` | Node 24+。与本次重写无关 |
| 全局 `URLPattern` | `function` | Node 24 默认提供；**22.23.4 上连实验旗标都没有**（`--experimental-urlpattern` 报 `bad option`）。路由匹配不要用它 |
| `using` / `await using` 声明语法 | 文件实测通过 | 22.23.4 上 `.mjs` 文件实测报 `SyntaxError`；`Symbol.dispose`/`Symbol.asyncDispose` 本身存在，但声明语法不可用。不要用 `using` 管资源，改 `try/finally` |
| 全局 `localStorage` / `sessionStorage` | 均 `undefined` | 两个版本默认都没有（24 需实验旗标、25 才默认开）。守护进程不要用 |
| 全局 `Temporal` | 均 `undefined` | 两个版本都没有，时间继续用 `Date` |

### 任务前提纠正：以下三项在 22.23.4 里**有**，不是禁用项

| API | 22.23.4 实测 | 备注 |
|---|---|---|
| `Array.fromAsync` | `function` | ES2024，Node 22.0 起（V8 12.4） |
| `Object.groupBy` / `Map.groupBy` | `function` | ES2024，Node 21.0 起 |
| `Promise.withResolvers` | `function` | ES2024，Node 22.0 起 |
| 另：`Set` 的 `union`/`intersection`/`difference` 等、`Iterator` 助手（`map`/`filter`/`take`…）、`ArrayBuffer.prototype.transfer`、`Symbol.dispose` | 均为 `function` | ES2025 的这批在 Node 22.0 已随 V8 12.4 落地 |

## 1.6 其他注意事项

- **`node:sqlite` 能用但别用**：22.23.4 上 `require('node:sqlite')` 无需 flag，`new DatabaseSync(':memory:')` 建表成功，但每次加载都打 `ExperimentalWarning: SQLite is an experimental feature`。守护进程的状态文件继续用 JSON 文件（与底版 `alias_save`/`appstats_save` 一致），不要引入它。
- **不要依赖 v24 的 undici/fetch 新行为**：22 用 undici 6.29.1（见 bump 提交说明），24 用 undici 7；重写只用 `dgram`/`net`/`fs`/`child_process`，不碰 fetch 细节即可避开。
- **目标机 CPU 是 ARM（AP8220/R3S）**：沙箱实测用的是 x64 二进制，只用于核对 API 有无；字节序、性能、内存占用须在目标机上再测。`Buffer` 读写一律显式用 `*BE` 方法，与 ubus 的大端约定一致。
- **版本锁定建议**：重写代码顶部注明 `node >= 22.23.4`，CI/沙箱测试用 22.23.4 二进制跑，不要用沙箱默认的 v24.22.1 当验收标准（两者 API 差集见 §1.5）。

---

# 第二章 ubus 协议

参考源码（均为 2026-11-15 拉取的 master 分支；行号以本次拉取为准）：

| 文件 | 作用 | 链接 |
|---|---|---|
| `ubus/ubusmsg.h` | 消息头、消息/属性/状态枚举 | https://github.com/openwrt/ubus/blob/master/ubusmsg.h |
| `ubus/libubus.h` | 客户端 API（`ubus_connect`、`ubus_channel_connect`、`ubus_invoke` 等） | https://github.com/openwrt/ubus/blob/master/libubus.h |
| `ubus/libubus-io.c` | 收发帧、HELLO 握手、消息校验 | https://github.com/openwrt/ubus/blob/master/libubus-io.c |
| `ubus/libubus.c` | 连接、`ubus_lookup`、事件发送 | https://github.com/openwrt/ubus/blob/master/libubus.c |
| `ubus/libubus-req.c` | 请求/响应匹配、INVOKE、DATA/STATUS 回复 | https://github.com/openwrt/ubus/blob/master/libubus-req.c |
| `ubus/libubus-obj.c` | 对象注册/注销 | https://github.com/openwrt/ubus/blob/master/libubus-obj.c |
| `ubus/ubusd_proto.c` | 服务端分发、服务端 HELLO | https://github.com/openwrt/ubus/blob/master/ubusd_proto.c |
| `ubus/ubusd_main.c` | 服务端读帧 | https://github.com/openwrt/ubus/blob/master/ubusd_main.c |
| `ubus/CMakeLists.txt` | `UBUS_MAX_MSGLEN`、`UBUS_UNIX_SOCKET` 常量定义 | https://github.com/openwrt/ubus/blob/master/CMakeLists.txt |
| `libubox/blob.h` | `blob_attr` 结构、对齐、长度规则 | https://github.com/openwrt/libubox/blob/master/blob.h |
| `libubox/blobmsg.h` | blobmsg 类型枚举、名字段结构 | https://github.com/openwrt/libubox/blob/master/blobmsg.h |
| `libubox/blobmsg.c` | `blobmsg_add_field`（编码名字段） | https://github.com/openwrt/libubox/blob/master/blobmsg.c |
| `libubox/blobmsg_json.c` | blobmsg ↔ JSON 映射 | https://github.com/openwrt/libubox/blob/master/blobmsg_json.c |
| `ucode/lib/ubus.c`（`jow-/ucode`） | ucode 的 ubus 模块语义（`connect`/`call`/`defer`/`open_channel` 等） | https://github.com/jow-/ucode/blob/master/lib/ubus.c |

## 2.1 总览

- ubus 是 OpenWrt 的本地消息总线：一个中心 `ubusd` + 若干客户端。客户端之间不直连，所有消息经 `ubusd` 按对象 id 路由。
- 本地连接走 Unix 域套接字，地址编译进 libubus：`/var/run/ubus/ubus.sock`（`ubus/CMakeLists.txt:17`，`SET(UBUS_UNIX_SOCKET "/var/run/ubus/ubus.sock")`）。
- **例外——直连通道（channel）**：`libubus.open_channel(fd)` 把一个已建立的 TCP 套接字直接当成 ubus 传输，不经过 ubusd（见 §2.7）。wifiroam 的 AP 间同步就用这个（§2.11）。
- 传输是**字节流**（Unix 流套接字或 TCP 流），无记录边界，靠消息自带长度分帧（§2.2）。**无认证、无加密**：本地 socket 靠文件权限，对端 TCP 通道靠应用层自己做认证——底版在通道上先跑 `auth` 方法交换 token（`wifiroamd.uc` 的 `srv_rx`/`sap_rx` 处理 `auth`），Node 重写必须保留这一层，不能以为 ubus 本身会认证。

## 2.2 线路格式：消息头 + blob

### 2.2.1 `ubus_msghdr`（8 字节，`ubusmsg.h:27-32`）

```c
struct ubus_msghdr {
	uint8_t  version;  /* 必须为 0 */
	uint8_t  type;     /* enum ubus_msg_type */
	uint16_t seq;      /* 大端 */
	uint32_t peer;     /* 大端 */
} __attribute__((packed, aligned(4)));
```

- 字节序：`seq`/`peer` 一律大端。发送端：`hdr.seq = cpu_to_be16(seq); hdr.peer = cpu_to_be32(peer)`（`libubus-io.c:134-137`）；接收端反向转换（`libubus-io.c` `get_next_msg` 内 `be16_to_cpu`/`be32_to_cpu`）。
- `version` 必须为 0，否则整条消息作废、连接断开（`ubus_validate_hdr`，`libubus-io.c:232-245`）。

### 2.2.2 帧结构与分帧（无独立长度前缀）

发送（`ubus_send_msg`，`libubus-io.c:125-164`）：一次 `writev` 发两个 iov——8 字节头 + 一个外层 `blob_attr`（长度 `blob_raw_len(msg)`，即头 4 字节 + payload）。

接收（`get_next_msg`，`libubus-io.c:约 280-320`；服务端同款逻辑在 `ubusd_main.c:约 160-200`）：

1. 先读 `8 + 4 = 12` 字节：消息头 + 外层 `blob_attr` 的头；
2. 校验头（`version==0`、外层长度 ≥ 4、`blob_pad_len ≤ UBUS_MAX_MSGLEN`），失败则断开且**无法重同步**（注释原话：`The header is already consumed, so the body cannot be skipped and the stream cannot be resynchronised`）；
3. 由外层 `blob_attr` 的长度字段算出剩余字节数 `blob_len`，再读那么多字节，即一条完整消息。

即：**帧总长度 = 8 + 外层 blob_attr 的 `raw_len`**，其中 `raw_len` 从其 `id_len` 低 24 位读出（含自身 4 字节头）。Node 实现的读循环必须按这个规则攒字节：先攒 12 字节定长，再按长度攒余下部分；半包、粘包都按流处理，不能假设一次 `data` 事件就是一条消息。

### 2.2.3 大小上限

`UBUS_MAX_MSGLEN = 1048576`（1 MiB，`ubus/CMakeLists.txt:18`，编译期 `-D` 传入）。发送方超过就直接失败（`libubus-io.c:149`）；接收方超过就断开（`libubus-io.c:242`、`ubusd_main.c:170`）。Node 实现发送前也要自查。

## 2.3 消息类型与属性

### 2.3.1 `enum ubus_msg_type`（`ubusmsg.h:34-66`，按声明顺序从 0 编号）

| 值 | 类型 | 含义 |
|---|---|---|
| 0 | `UBUS_MSG_HELLO` | 服务端发给新客户端的首条消息（见 §2.5） |
| 1 | `UBUS_MSG_STATUS` | 通用命令响应，带 `UBUS_ATTR_STATUS` 状态码 |
| 2 | `UBUS_MSG_DATA` | 数据响应，一条调用可返回多条 |
| 3 | `UBUS_MSG_PING` | ping；服务端回 `UBUS_MSG_DATA`（`ubusd_proto.c` `ubusd_send_pong`） |
| 4 | `UBUS_MSG_LOOKUP` | 按路径查找对象 |
| 5 | `UBUS_MSG_INVOKE` | 调用对象方法 |
| 6 | `UBUS_MSG_ADD_OBJECT` | 注册对象 |
| 7 | `UBUS_MSG_REMOVE_OBJECT` | 注销对象 |
| 8 | `UBUS_MSG_SUBSCRIBE` | 订阅对象通知 |
| 9 | `UBUS_MSG_UNSUBSCRIBE` | 退订（对象消失时服务端主动发） |
| 10 | `UBUS_MSG_NOTIFY` | 向订阅者发通知 |
| 11 | `UBUS_MSG_MONITOR` | 监控 |

### 2.3.2 `enum ubus_msg_attr`（`ubusmsg.h:68-89`，从 0 编号）

| 值 | 属性 | 类型（`libubus-io.c:34-42` 的 `ubus_policy`） |
|---|---|---|
| 0 | `UBUS_ATTR_UNSPEC` | — |
| 1 | `UBUS_ATTR_STATUS` | INT32（状态码，§2.4） |
| 2 | `UBUS_ATTR_OBJPATH` | STRING（对象路径，如 `network.interface.lan`） |
| 3 | `UBUS_ATTR_OBJID` | INT32（对象 id） |
| 4 | `UBUS_ATTR_METHOD` | STRING（方法名） |
| 5 | `UBUS_ATTR_OBJTYPE` | INT32（对象类型 id） |
| 6 | `UBUS_ATTR_SIGNATURE` | NESTED（方法签名表） |
| 7 | `UBUS_ATTR_DATA` | 任意 blobmsg（方法参数/返回值就装在这里） |
| 8 | `UBUS_ATTR_TARGET` | — |
| 9 | `UBUS_ATTR_ACTIVE` | INT8 |
| 10 | `UBUS_ATTR_NO_REPLY` | INT8（置位则不回响应） |
| 11 | `UBUS_ATTR_SUBSCRIBERS` | NESTED（订阅者 id 列表） |
| 12 | `UBUS_ATTR_USER` | — |
| 13 | `UBUS_ATTR_GROUP` | — |

注意：外层消息属性用的是 `blob_attr` 的 id（`BLOB_ATTR_*`，§2.8），属性“名”为空；内层方法数据（`UBUS_ATTR_DATA` 的内容）才是带名字的 blobmsg 字段。

### 2.3.3 `enum ubus_msg_status`（`ubusmsg.h:112-128`，从 0 编号）

`0 OK`、`1 INVALID_COMMAND`、`2 INVALID_ARGUMENT`、`3 METHOD_NOT_FOUND`、`4 NOT_FOUND`、`5 NO_DATA`、`6 PERMISSION_DENIED`、`7 TIMEOUT`、`8 NOT_SUPPORTED`、`9 UNKNOWN_ERROR`、`10 CONNECTION_FAILED`、`11 NO_MEMORY`、`12 PARSE_ERROR`、`13 SYSTEM_ERROR`。响应里状态码用 `UBUS_ATTR_STATUS`（INT32）承载。

## 2.4 握手流程（本地连接）

客户端 `ubus_reconnect`（`libubus-io.c:422-493`）：

1. 连 Unix socket（默认 `/var/run/ubus/ubus.sock`，可传 path；失败返回 `UBUS_STATUS_CONNECTION_FAILED`）；
2. **阻塞读 12 字节，等服务端先发 HELLO**；校验头、要求 `hdr.type == UBUS_MSG_HELLO`，否则关闭；
3. 按外层 blob 长度读完剩余字节；
4. `ctx->local_id = be32_to_cpu(hdr.hdr.peer)`——**自己的客户端 id 来自 HELLO 的 `peer` 字段**；若 `local_id <= 1`（`UBUS_CLIENT_ID_CHANNEL`，见 §2.7）则失败关闭；
5. 把 socket 置 `O_NONBLOCK` + `FD_CLOEXEC`，重发已注册对象（`ubus_refresh_state`）。

服务端（`ubusd_send_hello`，`ubusd_proto.c:102-116`）：新客户端接入时（`ubusd_proto.c:624` 附近调用）发一条空 blob 的 `UBUS_MSG_HELLO`，`seq=0`，`peer=分配给该客户端的 id`（`ubus_msg_init(ub, UBUS_MSG_HELLO, 0, cl->id.id)`）。

**要点**：客户端在握手阶段不发任何字节；HELLO 的 `seq` 是 0，不参与请求匹配；`local_id` 是服务端分配的，之后发出的消息里 `peer` 填目标，自己的 id 只在被调用/被通知时出现在对方发来的 `peer` 里。

## 2.5 对象注册、查找与方法调用

### 2.5.1 注册对象（`ubus_add_object`，`libubus-obj.c:236-267`）

- 发 `UBUS_MSG_ADD_OBJECT`，`peer=0`（发给 ubusd 本身）；
- 属性：`UBUS_ATTR_OBJPATH`（STRING，对象名）+ `UBUS_ATTR_OBJTYPE`（INT32，已知类型 id 时）或 `UBUS_ATTR_SIGNATURE`（NESTED，方法签名表：每个方法一个 TABLE，内含 `{参数名: 类型码}`，类型码是 `blobmsg_type` 的数值，见 `ubus_push_method_data` / `ubus_push_object_type`，`libubus-obj.c:197-234`）；
- 响应是 `UBUS_MSG_DATA`，含 `UBUS_ATTR_OBJID`（分配到的对象 id）与 `UBUS_ATTR_OBJTYPE`；客户端把 `obj->id` 记下来。注册失败返回 `UBUS_STATUS_NO_DATA`（无 id 回来时）。
- 注销：`UBUS_MSG_REMOVE_OBJECT` + `UBUS_ATTR_OBJID`（`libubus-obj.c:约 280-300`）。
- **channel 上禁止注册/注销/查找**：`ubus_add_object`、`ubus_remove_object`、`ubus_lookup` 开头都有 `if (ubus_context_is_channel(ctx)) return UBUS_STATUS_INVALID_ARGUMENT`。

### 2.5.2 查找对象（`ubus_lookup`，`libubus.c:177-196`）

- 发 `UBUS_MSG_LOOKUP`，`peer=0`，带 `UBUS_ATTR_OBJPATH`（STRING；传 `NULL` 则列出全部对象）；
- 每个匹配对象回一条 `UBUS_MSG_DATA`，含 `UBUS_ATTR_OBJID` + `UBUS_ATTR_OBJPATH` + `UBUS_ATTR_OBJTYPE` + `UBUS_ATTR_SIGNATURE`（回调 `ubus_lookup_cb`，`libubus.c:158-175`，三项缺一则跳过该条）；
- 最后一条 `UBUS_MSG_STATUS` 表示查找结束。`ubus_lookup_id`（`libubus.c:211-235`）是只取第一个 id 的变体。

### 2.5.3 调用方法（`ubus_invoke_async_fd`，`libubus-req.c:238-252`）

请求（`UBUS_MSG_INVOKE`，`peer = 目标对象 id`）：

- `UBUS_ATTR_OBJID`（INT32，目标对象 id）
- `UBUS_ATTR_METHOD`（STRING，方法名）
- `UBUS_ATTR_DATA`（方法参数，blobmsg TABLE；无参时为空 TABLE）
- 可选 `UBUS_ATTR_NO_REPLY`（INT8=1，见 `libubus-req.c:310` 附近的 notify 路径；调用方不需要响应时置位）

响应：

- 被调方先回 0..n 条 `UBUS_MSG_DATA`（每条含 `UBUS_ATTR_OBJID` + `UBUS_ATTR_DATA`，见 `ubus_send_reply`，`libubus-req.c:220-236`），最后回一条 `UBUS_MSG_STATUS`（含 `UBUS_ATTR_OBJID` + `UBUS_ATTR_STATUS`，见 `ubus_complete_deferred_request`，`libubus-req.c:约 200-215`）；
- **无 DATA 只有 STATUS 是合法的**（方法无返回值时）；
- 服务端实现注意：`ubus_send_reply` 发 DATA 时用的还是请求的 `seq`（`ubus_send_msg(ctx, req->seq, ...)`），STATUS 同样——响应与请求靠 `seq` 关联。

### 2.5.4 请求/响应对应关系（seq、peer）

- 序号分配：`req->seq = ++ctx->request_seq`（`__ubus_start_request`，`libubus-req.c:53-76`），`request_seq` 是 `uint16_t`（`libubus.h:174`），**会回绕**；0 一般不用于请求（HELLO 用 0）。
- 匹配规则：收到 `UBUS_MSG_DATA` / `UBUS_MSG_STATUS` 时，按 **(seq, peer)** 查 pending 表（`ubus_find_request`，`libubus-req.c:约 419-440`）：`seq` 必须相等；非 notify 请求还要求 `peer` 等于当初 `start_request` 时填的 `peer`（即目标对象 id）；notify 请求则按 `peer` 查订阅者 id 列表。查不到的响应直接丢弃（`ubus_process_req_msg`，`libubus-req.c:488-518`）。
- 同步等待：`ubus_complete_request`（`libubus-req.c:158-200`）循环 `poll` 直到收到 STATUS 或超时（`UBUS_STATUS_TIMEOUT`）；Node 实现里这对应“发请求 → 把 `{resolve, reject, data[]}` 按 seq 登记 → 收到 STATUS 后结算”的 Promise 模型。
- 作为服务端：收到 `UBUS_MSG_INVOKE` 时，`ubus_request_data` 里带 `seq`（原样回）、`peer`（调用方客户端 id）、`object`（被调对象 id）；回复必须用同一个 `seq` 发 DATA/STATUS，`peer` 填调用方 id。

## 2.6 订阅、通知与事件（本次最小实现可暂缓，但须知道存在）

- 订阅：`UBUS_MSG_SUBSCRIBE` + 对象 id；通知：对象方发 `UBUS_MSG_NOTIFY`，ubusd 转给全部订阅者；退订/对象消失时服务端发 `UBUS_MSG_UNSUBSCRIBE`。
- 事件总线：`ubus_send_event`（`libubus.c:约 282-300`）是对系统对象 1（`UBUS_SYSTEM_OBJECT_EVENT`）的 `send` 方法调用，参数 `UBUS_ATTR_DATA` 内是 `{id: 事件名, data: TABLE}`。
- 底版 wifiroam **没有用到订阅/事件**：它只做本地调用、发布对象、通道 defer/request（§2.11）。Node 最小实现可以先不做 SUBSCRIBE/NOTIFY，但解析器收到这类消息时不能崩溃——按未知类型跳过即可（见 §2.10 清单）。

## 2.7 直连通道（channel）：`open_channel` 的协议实质

ucode 侧入口：`open_channel(fd, cb, disconnect_cb[, timeout])`（`jow-/ucode/lib/ubus.c:3903-3937` 的 `uc_ubus_channel_connect`，导出表第 3979 行）。它调 `ubus_channel_connect`（`libubus.c:346-377`）：

- 不连 ubusd、不做 HELLO 握手，直接把已建立的 fd（底版是连向对端 AP 的 TCP socket，见 §2.11）设为 `O_NONBLOCK` + `FD_CLOEXEC`；
- `ctx->local_id = UBUS_CLIENT_ID_CHANNEL`（= 1，`ubusmsg.h:22`）；
- 收到的 `UBUS_MSG_INVOKE` 交给 `request_handler`（即 ucode 传的 `rx_cb`），回调用同一 `seq`、DATA/STATUS 作答。

通道上的调用（ucode 文档，`lib/ubus.c:1506-1560` `channel#request`、`1738-1800` `channel#defer`）：

- 与 `call()`/`defer()` 相同，唯一区别是 **对象 id 固定为 0**（“Similar to call() but uses object ID 0 for channel-based communication”）；
- `channel.request({method, data, return})`：同步等响应；`return:"ignore"` 表示 fire-and-forget（底版用法，`wifiroamd.uc:8`）；
- `channel.defer({method, data, data_cb, cb})`：异步，`cb(status, data)` 在完成时调，`data_cb` 收中间 DATA。

Node 实现的通道模式要点：

1. 同一套帧格式（§2.2），同一条 TCP 流上双向都是 ubus 消息；
2. 不等 HELLO、不发 HELLO，连接建立即可收发；
3. 请求的 `peer` 一律填 0，响应按 `seq` 匹配（`peer` 也为 0）；
4. 对端发来的 `UBUS_MSG_INVOKE`（`peer=0`）就是对端的方法调用，须按底版的 `sap_rx`/`srv_rx` 语义分发，回复 DATA（可无）+ STATUS；
5. 断开即丢弃全部 pending 请求（按 `CONNECTION_FAILED` 结算），并按底版行为触发重连逻辑。

## 2.8 blobmsg 编解码

### 2.8.1 `blob_attr`：所有属性的通用头（`libubox/blob.h:46-55`）

```c
struct blob_attr {
	uint32_t id_len;   /* 大端 */
	char data[];
} __packed;
```

`id_len`（大端 uint32）位域（`blob.h:46-50`）：

| 位 | 含义 |
|---|---|
| 31（`0x80000000`，`BLOB_ATTR_EXTENDED`） | extended 标志：置位表示本属性带名字段（即 blobmsg 字段） |
| 30–24（`0x7f000000`，`BLOB_ATTR_ID_MASK`） | 类型 id（7 位） |
| 23–0（`0x00ffffff`，`BLOB_ATTR_LEN_MASK`） | 总长度，含自身 4 字节头，最大 16 MiB-1 |

长度换算（`blob.h:97-123`，均为内联函数）：

- `blob_len = (id_len & LEN_MASK) - 4`（payload 长度）
- `blob_raw_len = blob_len + 4`
- `blob_pad_len = raw_len` 按 4 字节上对齐（`BLOB_ATTR_ALIGN = 4`）

**对齐规则**：每个属性在父容器里占 `blob_pad_len` 字节，不足 4 字节倍数的尾部补 0。解析时必须用 `blob_pad_len` 步进，不能用 `raw_len`，否则下一个属性头会对不上。空 TABLE/ARRAY 的 payload 长度为 0（只有 4 字节头）。

### 2.8.2 blobmsg 字段：名字段与类型（`libubox/blobmsg.h:22-44`）

```c
enum blobmsg_type {
	BLOBMSG_TYPE_UNSPEC,   /* 0 */
	BLOBMSG_TYPE_ARRAY,    /* 1 */
	BLOBMSG_TYPE_TABLE,    /* 2 */
	BLOBMSG_TYPE_STRING,   /* 3 */
	BLOBMSG_TYPE_INT64,    /* 4 */
	BLOBMSG_TYPE_INT32,    /* 5 */
	BLOBMSG_TYPE_INT16,    /* 6 */
	BLOBMSG_TYPE_INT8,     /* 7 */
	BLOBMSG_TYPE_BOOL = BLOBMSG_TYPE_INT8,  /* 8 = 7，别名 */
	BLOBMSG_TYPE_DOUBLE,   /* 8（__BLOBMSG_TYPE_LAST 后的 LAST 值为 8）*/
	...
};
```

注意编号细节：`BOOL` 是 `INT8` 的别名（同值 7）；`DOUBLE` 的值是 8（`__BLOBMSG_TYPE_LAST`=9，`BLOBMSG_TYPE_LAST`=8）。写编码器时按此表填 id，不要自己编。

名字段（`blobmsg.h:38-41`）：

```c
struct blobmsg_hdr {
	uint16_t namelen;  /* 大端，不含结尾 NUL */
	uint8_t name[];    /* 名字 + '\0' */
} __packed;
```

编码（`blobmsg_add_field`，`libubox/blobmsg.c:244-265`）：`namelen = strlen(name)`（BE16），名字后写一个 `'\0'`，整个“头 + 名字 + NUL”再垫到 4 字节（`blobmsg_hdrlen(namelen) = BLOBMSG_PADDING(2 + namelen + 1)`，`blobmsg.h:48-51`，`BLOBMSG_ALIGN=2` 即按 4 对齐）。payload 从垫齐后的位置开始。外层消息属性（`UBUS_ATTR_*`）没有名字段，`extended` 位为 0；内层 blobmsg 字段一律置 `extended` 位。

### 2.8.3 各类型 payload 编码

| 类型 | payload | 说明 |
|---|---|---|
| STRING | UTF-8 + 结尾 `'\0'` | 长度含 NUL（`blobmsg_add_string` 用 `strlen+1`，`blobmsg.h:237`） |
| INT8 / BOOL | 1 字节 | BOOL：0=false，非 0=true；JSON 映射里 boolean 按 u8 编（`blobmsg_json.c:62-64`） |
| INT16 | 2 字节大端 | |
| INT32 | 4 字节大端 | |
| INT64 | 8 字节大端 | |
| DOUBLE | 8 字节大端 IEEE-754 | 与 INT64 同长，靠类型 id 区分；`blobmsg_add_double`（`blobmsg.h:204`） |
| ARRAY | 一串子 `blob_attr` | 元素按顺序排列；JSON 映射按顺序读（`blobmsg_format_json_list(..., array=true)`） |
| TABLE | 一串子 `blob_attr` | 元素各有名字；JSON 映射按名读（`array=false`） |
| UNSPEC | 0 字节 | 空值标记（见 §2.8.4） |

数值一律大端：解码 INT16/32/64 要 `be16/32/64_to_cpu`（`blobmsg_json.c:265-274` 的格式化代码就是这么读的）；DOUBLE 用 `blobmsg_get_double`（同文件）。

### 2.8.4 空值与缺失字段

- **空值（null）**：JSON → blobmsg 时，`null` 编成 `BLOBMSG_TYPE_UNSPEC`、payload 长度 0 的字段（`blobmsg_json.c:77-78`）；反向 `UNSPEC` 格式化为 `null`（同文件 `:259-261`）。即 null 是“字段存在、值为空”，不是字段缺失。
- **缺失字段**：属性根本不出现在父容器里。解析时按“查表未命中”处理（libubus 用 `ubus_parse_msg` 返回的 `attrbuf[]`，缺失项为 NULL；`libubus-obj.c` 的回调里 `if (!attrbuf[UBUS_ATTR_OBJID]) return` 就是这种处理）。**Node 实现不要把缺失读成 `null`/`0`/`""`**；调用方按“字段不存在”走缺省逻辑（底版大量用 `??` 做这件事，如 `local_clients` 的 `ci.connected_time ?? null`）。
- **JSON 编码的整数收窄**：JSON → blobmsg 时，整数在 INT32 范围内编 INT32，否则编 INT64（`blobmsg_json.c:65-73`）；布尔编 INT8；浮点编 DOUBLE。Node 编码器照此规则即可与 ucode 的 `blobmsg_add_json` 互通。

## 2.9 blobmsg ↔ JSON 映射（`libubox/blobmsg_json.c`）

| JSON | → blobmsg（`blobmsg_add_json_element`，`:43-83`） | blobmsg → JSON（`blobmsg_format_json`，`:259-300`） |
|---|---|---|
| object | TABLE | TABLE → `{...}` |
| array | ARRAY | ARRAY → `[...]` |
| string | STRING | STRING → 带转义的 `"..."` |
| boolean | INT8（u8，0/1） | BOOL → `true`/`false` |
| integer（int64 拟合 INT32） | INT32，否则 INT64 | INT16/32/64 → 十进制数 |
| double | DOUBLE | DOUBLE → `%.17g` |
| null | UNSPEC（0 长度） | UNSPEC → `null` |

ucode 的 ubus 模块全程走这套映射：`call`/`defer` 的参数与返回值都是 JSON 对象，经 `blobmsg_add_json` 编码、经 `blobmsg_format_json` 解码（`jow-/ucode/lib/ubus.c` 顶端注释第 84–85 行：“All data is transferred in JSON format via blobmsg”）。Node 实现只要按 §2.8 编出同样的字节，就能与 ucode 对端互通；调试时可用 `ubus call` / `ubus listen` 做对照。

## 2.10 ucode 的 ubus 模块语义（Node 重写要对齐的行为）

来源：`jow-/ucode/lib/ubus.c`（108,079 字节，master）。模块导出（文件末尾 `global_fns`，第 3977–3980 行）：`error`、`connect`、`open_channel`、`guard`。

| ucode 用法 | 语义 | Node 对应 |
|---|---|---|
| `connect([socket][, timeout])` | 连本地 ubusd（`uc_ubus_connect`，第 980 行；socket 缺省为默认路径，见 §2.4；timeout 未传时缺省 30，`if (c->timeout < 0) c->timeout = 30`） | `UbusClient.connect(path?)`，Promise 化 |
| `conn.call(obj, method[, data])` | 同步调用：发 INVOKE，等 DATA+STATUS，返回数据；失败抛错/返回 null（依 `error`/`guard`） | `await client.invoke(objId, method, data)` |
| `conn.defer(obj, method, data, cb[, data_cb])` | 异步调用：立即返回 deferred 资源，`cb(rc, result)` 在完成时调；`data_cb` 收中间 DATA | `client.invoke(...)` 本身就是 Promise；`data_cb` 对应 DATA 流回调 |
| `conn.publish(path, {methods...})` | 注册对象：`ADD_OBJECT` + 方法表；每个方法带 `call(req)` 与 `args` 签名 | `client.addObject(path, methods)`；收到 INVOKE 时分发并回 DATA+STATUS |
| `conn.list([pattern])` / `conn.call` 前的解析 | LOOKUP，返回对象路径/签名数组 | `client.lookup(pattern?)` |
| `conn.listener(pattern, cb)` / `conn.send(id, data)` | 事件监听与发送（系统对象 1 的 `send`） | 最小实现可暂缓（底版不用） |
| `conn.subscriber(path, {...})` | 订阅对象通知 | 最小实现可暂缓（底版不用） |
| `open_channel(fd, rx_cb, disconnect_cb[, timeout])` | 直连通道（§2.7）；`rx_cb(req)` 单参数收对端调用，`req` 带 `reply()` | `Channel` 类：`onRequest` + `request()`/`defer()` |
| `channel.request({method, data, return})` | 通道同步调用，对象 id 固定 0；`return:"ignore"` 为 fire-and-forget | `channel.invoke(method, data, {noReply:true})` |
| `channel.defer({method, data, data_cb, cb})` | 通道异步调用，`cb(status, data)` | 同上 Promise 化 |
| `channel.disconnect()` / `conn.disconnect()` | 关闭连接，丢弃 pending | `close()`，pending 按失败结算 |

特别注意 `conn.call` 是**同步阻塞**的（ucode 在 uloop 里跑 `ubus_complete_request` 的 poll 循环，`libubus-req.c:158-200`）；Node 里没有阻塞调用，一律改 Promise + 超时。底版 `detect_self` 等在 `main` 里直接 `ubusc.call(...)` 取值，重写时这些点要改成 `await`。

## 2.11 底版 wifiroam 实际用到的 ubus 调用（对照表）

| 位置（`wifiroamd.uc` 行号） | 用法 | 协议含义 |
|---|---|---|
| `:12` | `import * as libubus from "ubus"` | ucode ubus 模块 |
| `:144` | `let ubusc`（连接对象） | 本地 ubusd 连接 |
| `:889` | `ubusc.call("network.interface.lan", "status")` | LOOKUP `network.interface.lan` 取 id → INVOKE `status`；取 `device`/`l3_device`/`ipv4-address` |
| `:925`、`:1793` | `ubusc.call("network.wireless", "status")` | 同上，取 STA 口状态 |
| `:1804` | `ubusc.call("hostapd." + ifname, "get_clients")` | 对象名动态拼出（`hostapd.<ifname>`），取 `connected_time` 等 |
| `:2677` | `link.chan = libubus.open_channel(sock, sap_rx, sap_disconnect)` | SAP 侧：TCP 连 CAP 成功后建通道，`sap_rx` 收调用 |
| `:2913` | `conn.chan = libubus.open_channel(...)` | CAP 侧：`srv_accept` 接受 TCP 后建通道 |
| `:8`、`:2917` | `channel.request({method, data, return:"ignore"})` | 通道 fire-and-forget（如回执） |
| `:389`、`:851`、`:2525`、`:2954` 等 | `chan.defer({method, data, data_cb, cb})` | 通道异步调用：`push_aliases`、`set_offload`、`auth` 等 |
| `:3138` 起 | `api_obj` 发布 | 本地 `wifiroam` 对象：方法含 `status`、`build_topology` 等（`call: function(req)`） |
| `:2027`、`:2661`、`:2740` | `chan.disconnect()` | 通道关闭即清 `authed`、触发重连 |

结论：Node 重写必须实现两类 ubus 客户端——**本地客户端**（Unix socket：LOOKUP + INVOKE + ADD_OBJECT 发布 `wifiroam`）与**通道客户端**（裸 TCP：INVOKE peer=0 双向 + 请求分发）。两者共用同一帧编解码与 blobmsg 编解码，只差连接建立与 `peer` 填法。

## 2.12 最小实现的检查清单（Node.js 自测，通过才算协议对）

按顺序做，前一项不过不做下一项。测试不需要路由器：本地可跑 `ubusd`（OpenWrt 固件自带）或用 Node 自己写一个最小对端按同一帧格式回包。

### A. blobmsg 编解码（纯函数，无网络）

1. 编一段已知 JSON（如 `{"ssid":"wifiroam-bh","rssi":-62,"enabled":true,"x":null,"list":[1,2],"nested":{"a":"b"}}`），与 `ubus` 命令行/`jshn` 或 C 写的小工具输出的字节逐字节比对（或至少用 Node 解自己编的码再与原 JSON 深相等，且手工核对第一条属性的头 4 字节：extended 位 + 类型 + 长度）。
2. 解一段真实 blobmsg 字节：用路由器上 `ubus call network.interface.lan status` 的回包抓字节（或 `ubusd` 的 monitor 输出），Node 解出与 `ubus` 命令行一致的 JSON。
3. 边界：空 TABLE（`{}`）、空 ARRAY（`[]`）、空字符串（`""`，含 NUL 共 1 字节 payload）、`INT32_MIN`/`INT32_MAX` 边界值、超过 INT32 的整数（应走 INT64）、DOUBLE `0.1`（`%.17g` 往返）、名字长度使头部垫到 4 字节边界与不垫的两种情况、嵌套三层 TABLE/ARRAY。
4. 恶意输入：截断的 blob（长度字段大于实际字节）必须报错不崩溃；`version != 0` 的头必须拒绝；超过 1 MiB 的外层长度必须拒绝。

### B. 帧解析（流式）

5. 把一条消息拆成 1 字节、3 字节、12 字节、半包等多种切法喂给解析器，都应还原出同一条消息；两条消息粘在一个包里应拆出两条。
6. 先喂 12 字节头（`version=0` + 外层长度），再喂余下字节：解析器应在长度未齐时不产出消息，齐了才产出。

### C. 本地 ubus 握手与调用（需一台跑 `ubusd` 的 OpenWrt 机器或本地 `ubusd`）

7. 连 `/var/run/ubus/ubus.sock`，收到第一条消息：`type==0 (HELLO)`、`seq==0`、`peer>1`；把 `peer` 记为 `local_id`。
8. 发 `LOOKUP`（`OBJPATH="network.interface.lan"`，`peer=0`），收到至少一条 DATA（含 `OBJID`/`OBJPATH`/`OBJTYPE`）+ 一条 STATUS（`STATUS==0`）。
9. 发 `INVOKE`（`OBJID`=上一步的 id，`METHOD="status"`，`DATA` 为空 TABLE），收到 DATA（含 `interface` 等字段）+ STATUS `0`；与 `ubus call network.interface.lan status` 的输出逐字段比对。
10. 并发：同时发 5 个 INVOKE（不同 seq），响应乱序到达时仍按 (seq, peer) 各归其主；一个请求超时（目标对象不存在，应得 STATUS `4 NOT_FOUND` 或 `3 METHOD_NOT_FOUND`）不影响其他请求。

### D. 对象发布（服务端角色）

11. 发 `ADD_OBJECT`（`OBJPATH="test.jscheck"` + SIGNATURE），收到 DATA 里的 `OBJID` 非 0；随后 `ubus list` 能看到该对象；`ubus call test.jscheck <方法>` 能调通 Node 的处理函数并收到正确 DATA+STATUS。
12. 发 `REMOVE_OBJECT` 后 `ubus list` 不再有该对象。

### E. 通道模式（两台 Node 或一台 Node + 底版 ucode 对照）

13. 两个 Node 进程用 TCP 直连建通道：A `request`/`defer` 发 INVOKE（`peer=0`），B 的 `onRequest` 收到并回 DATA+STATUS；A 按 `seq` 收到正确结果；双向都通。
14. 与底版 ucode 对照：Node 通道连底版 `wifiroamd.uc` 跑起来的 AP（或反过来），`auth` 方法能走通，`push_aliases` 这类 defer 调用能被对方解析；抓包核对首条消息不是 HELLO。
15. 断线：对端关闭 TCP 后，pending 的请求按失败结算（不挂起），`disconnect` 回调恰好触发一次；重连后 `seq` 从新连接的计数继续（不要求从 0 开始，但不能与旧连接的 pending 混淆）。

### F. 回归护栏

16. 上述测试固定跑在 **Node 22.23.4** 二进制上（不是沙箱 v24），且代码里 grep 不到 §1.5 的禁用 API（`Promise.try`、`RegExp.escape`、`Float16Array`、`Error.isError`、`Atomics.pause`、`URLPattern`、`using` 声明）。

## 2.13 未核实与注意事项

- `ubus`/`libubox`/`ucode` 行号引自 2026-11-15 拉取的 master；三仓库 master 会继续演进，写代码时以 `ubusmsg.h`、`blob.h`、`blobmsg.h` 三个头文件为准，行号只作定位用。
- fd 传递：`ubus_send_msg` 可随消息传一个 fd（`SCM_RIGHTS`，`libubus-io.c:60-123` 的 `writev_retry`）；wifiroam 没用到。Node 实现发送时一律不带 fd；接收时若收到附带 fd，须读走并 `close` 掉（libubus 的做法：无 handler 的 fd 在 `ubus_process_req_msg` 末尾 `close(fd)`），不能泄漏也不能当成数据。
- `seq` 回绕：`request_seq` 是 uint16，高频调用下会回绕到 0；pending 表按 (seq, peer) 匹配时须保证同一时刻没有两个未完成请求共享同一 seq（发请求前先清掉已完成的旧项即可，libubus 就是这么做的——`list_del_init`）。
- `UBUS_MSG_MONITOR`（11）与监控对象（`UBUS_SYSTEM_OBJECT_MONITOR`=3）是调试用的，本次不需要。
- 本调研未在真机上抓包验证；§2.12 的 C/E 两组测试就是用来在真机上闭环的，未跑通之前不要宣称协议实现完成。
