# wifiroam-js 基础设施接口（INTERFACE.md）

> **状态：已冻结。** 下面的函数名、签名、返回值与错误行为定下来就不要再改；
> 业务模块（discovery / clients / wifi / guest / policy / core）原样 import。
> 目标运行环境：Node.js **22.23.4**（见 `research-node-ubus.md` §1.5 禁用清单；
> 沙箱默认是 Node v24，只用于开发测试，不可作为验收标准）。
> 全部模块只用 Node 核心模块，**零 npm 依赖**；入口包见 `package.json`
>（`"type": "module"`，ESM import）。
>
> 约定：`null` = “字段存在但值为空”（blobmsg UNSPEC）或“查无此项”
>（uci get / store load）；缺失字段 = 属性根本不存在，调用方按 `??`
> 走缺省逻辑，模块不替调用方补默认值。

---

## 1. `lib/blobmsg.js` — blobmsg / blob_attr 编解码

协议：libubox `blob.h` / `blobmsg.h` / `blobmsg_json.c`。属性头 4 字节大端
（最高位 extended、次 7 位类型 id、低 24 位长度，含头）；每个属性占
pad4 后的长度；名字段 `namelen(BE16) + 名字 + NUL` 再垫到 4 字节；数值大端。

| 导出 | 签名 | 返回值 / 错误行为 |
|---|---|---|
| `BLOBMSG_TYPE` | 冻结对象 | `{ UNSPEC:0, ARRAY:1, TABLE:2, STRING:3, INT64:4, INT32:5, INT16:6, INT8:7, BOOL:7, DOUBLE:8 }`。注意 BOOL 与 INT8 同值 7。 |
| `encode(obj)` | `(obj: object) => Buffer` | JS 对象编成 TABLE 内容（各命名字段拼接，无 TABLE 自身头）。`undefined` 属性跳过（= 缺失字段）；`null` → 零长度 UNSPEC；布尔 → INT8；整数在 INT32 内 → INT32，否则 INT64；浮点 → DOUBLE；`BigInt` → INT64。非普通对象抛 `TypeError`；`NaN`/`Infinity`、超 INT64 的 BigInt、超 24 位长度的字段抛 `RangeError`。 |
| `decode(buf)` | `(buf: Buffer) => object` | TABLE 内容解成普通对象。空 Buffer → `{}`。截断、长度字段超界、未知类型 id、无名属性混入 TABLE 时抛 `Error`。INT64 在安全整数内回 `number`，超出回 `BigInt`；类型 7 解成 `boolean`（JSON 映射约定，见下）。 |
| `encodeField(name, value)` | `(name: string \| null, value: any) => Buffer` | 一个完整属性（含头、名字段、填充）。`name === null` 用于数组元素（名字段全零）。 |
| `encodeAttr(id, payload, opts?)` | `(id: number, payload: Buffer, { extended?: boolean }) => Buffer` | 一个无名原始 `blob_attr`（ubus 消息外层/内层属性用；`id` 为 `UBUS_ATTR_*`）。超 24 位长度抛 `RangeError`。 |
| `parseAttrs(buf, start?, end?)` | `(buf: Buffer, start?: number, end?: number) => Array<record>` | 逐条解析属性序列。record = `{ id, extended, name, type, payload: Buffer, rawLen, padLen, value }`；`value` 对命名字段是解码后的 JS 值，对无名属性是原始 `payload` Buffer。截断/越界抛 `Error`。 |
| `decodeAttrValue(rec)` | `(rec) => any` | 按 `rec.type` 解一个已解析属性的 payload（UNSPEC→`null`，ARRAY/TABLE 递归，STRING 去尾 NUL，INT64 按安全范围回 `number`/`BigInt`，类型 7 → `boolean`）。未知类型抛 `Error`。 |

**BOOL/INT8 说明**：编码 JS 布尔得 id 7，解码 id 7 得布尔——与
`blobmsg_json.c` 的 JSON 映射一致（JSON 整数永不编成 INT8，所以往返
无歧义；原始 INT8 整数 0/1 往返后会变成布尔，这是协议层面的等价约定）。

---

## 2. `lib/ubus.js` — 最小 ubus 协议客户端

协议：openwrt/ubus（`libubus-io.c` / `libubus-req.c` / `libubus-obj.c`）。
帧 = 8 字节 `ubus_msghdr`（`version=0`、`type`、`seq` BE16、`peer` BE32）
+ 一个外层 `blob_attr`（id 0），其长度字段给出整条消息长度；无独立
长度前缀；单条上限 `UBUS_MAX_MSGLEN = 1048576`。

| 导出 | 签名 | 返回值 / 错误行为 |
|---|---|---|
| `UBUS_SOCKET_PATH` | 常量 | `'/var/run/ubus/ubus.sock'` |
| `UBUS_MAX_MSGLEN` | 常量 | `1048576` |
| `UBUS_CLIENT_ID_CHANNEL` | 常量 | `1` |
| `UBUS_MSG` | 冻结对象 | `{ HELLO:0, STATUS:1, DATA:2, PING:3, LOOKUP:4, INVOKE:5, ADD_OBJECT:6, REMOVE_OBJECT:7, SUBSCRIBE:8, UNSUBSCRIBE:9, NOTIFY:10, MONITOR:11 }` |
| `UBUS_ATTR` | 冻结对象 | `{ UNSPEC:0, STATUS:1, OBJPATH:2, OBJID:3, METHOD:4, OBJTYPE:5, SIGNATURE:6, DATA:7, TARGET:8, ACTIVE:9, NO_REPLY:10, SUBSCRIBERS:11, USER:12, GROUP:13 }` |
| `UBUS_STATUS` | 冻结对象 | `{ OK:0, INVALID_COMMAND:1, INVALID_ARGUMENT:2, METHOD_NOT_FOUND:3, NOT_FOUND:4, NO_DATA:5, PERMISSION_DENIED:6, TIMEOUT:7, NOT_SUPPORTED:8, UNKNOWN_ERROR:9, CONNECTION_FAILED:10, NO_MEMORY:11, PARSE_ERROR:12, SYSTEM_ERROR:13 }` |
| `UbusError` | `class extends Error` | `.status` 为 ubus 状态码；`.code` 在超时为 `'UBUS_TIMEOUT'`、断线为 `'UBUS_CONNECTION_FAILED'`。 |
| `UBUS_NO_REPLY` | 哨兵 Symbol | 方法 handler 返回（或 resolve 为）此值时，本端对该 INVOKE 不发任何回包（既不发 DATA 也不发 STATUS），对端挂起直至超时——复刻原版对未认证/未知方法请求的静默丢弃。仅限 handler 返回值；已调过 `req.reply()` 时不要再返回它。未知方法且无 handler 时仍回 `METHOD_NOT_FOUND` / `NOT_FOUND`，不静默丢弃；handler 也发不出 `STATUS 2/4`，见 §8。 |
| `encodeFrame(type, seq, peer, attrs)` | `(type, seq, peer, [{id, payload}]) => Buffer` | 一条完整帧。超 1 MiB 抛 `RangeError`。 |
| `UbusFrameParser` | `class`，`push(chunk: Buffer) => Array<{type, seq, peer, attrs}>` | 流式重组：半包不产出、粘包拆开。`version != 0`、外层长度 < 4、超 1 MiB、属性截断时抛 `Error`（流不可重同步，调用方须关闭连接）。 |
| `UbusClient.connect(path?, opts?)` | `static async (path = UBUS_SOCKET_PATH, { timeout = 30000 }) => UbusClient` | 连 ubusd，等服务端先发 HELLO，从 `hdr.peer` 取 `local_id`（须 > 1，否则关闭并抛 `UbusError`）。连不上 / HELLO 超时 / `local_id <= 1` 时抛错。 |
| `client.localId` | 属性 | 服务端分配的客户端 id（HELLO 之前为 0）。 |
| `client.connected` | 属性 | socket 未关闭且未销毁时为 `true`。 |
| `client.lookup(path?, opts?)` | `async (path?: string, { timeout? }) => [{ id, path, type, signature }]` | `path` 省略/`null` 列全部对象。非 OK 状态抛 `UbusError`。`signature` 为 `{ method: { arg: typeCode } }` 或 `null`。 |
| `client.lookupId(path, opts?)` | `async => number \| null` | 首个匹配对象的 id；无匹配回 `null`（`lookup` 抛错时直接抛）。 |
| `client.invoke(objectId, method, data?, opts?)` | `async (id, method, data, { timeout?, onData?, noReply? }) => { status, data, dataList }` | INVOKE。`data` 为首条 DATA 的解码对象（无 DATA 时 `null`），`dataList` 为全部 DATA。非 OK 状态**不抛**（只超时/断线抛 `UbusError`）；`onData(data)` 收每条中间 DATA；`noReply: true` 时只发不收，立即 resolve `{ status: 0, data: null, dataList: [] }`。 |
| `client.call(objectPath, method, data?, opts?)` | `async => any` | LOOKUP（结果缓存）+ INVOKE；resolve 首条 DATA 对象（无 DATA 时 `null`）。对象不存在、非 OK 状态、超时、断线时抛 `UbusError`（与 ucode `conn.call()` 语义一致）。 |
| `client.addObject(path, methods, opts?)` | `async (path, methods, { timeout?, signature? }) => { id, type }` | 发布对象。`methods` 为 `{ name: handlerFn }` 或 `{ name: { handler, args: { arg: 'string'\|'int'\|'int64'\|'bool'\|'double'\|'table'\|'array' } } }`；`opts.signature` 可显式给 `{ method: { arg: 类型名或数值码 } }`。无 id 回来时抛 `UbusError(NO_DATA)`；被拒时抛对应状态码。发布后收到的 INVOKE 按对象 id + 方法名分发给 handler。 |
| `client.removeObject(idOrPath, opts?)` | `async => number` | 注销对象，resolve ubus 状态码（0 成功；未知 path 不发请求，直接回 `NOT_FOUND`）。 |
| `client.notify(objectId, data?)` | `(id, data) => void` | fire-and-forget `NOTIFY`（无响应）。连接已关闭时抛 `UbusError(CONNECTION_FAILED)`。 |
| `client.close()` | `() => void` | 关闭连接；全部 pending 请求以 `CONNECTION_FAILED` 结算；`'close'` 事件只发一次。 |
| `client.on('hello' \| 'close' \| 'error' \| 'message', ...)` | EventEmitter | `'hello'`：收到 HELLO；`'close'`：传输关闭（恰好一次）；`'error'`：协议/解析/分发错误；`'message'`：未订阅类消息（SUBSCRIBE/UNSUBSCRIBE/NOTIFY/MONITOR 等，wifiroam 不用，仅透出）。 |
| `UbusChannel.connect(host, port, opts?)` | `static async (host, port, { timeout = 30000 }) => UbusChannel` | 裸 TCP 直连（不经 ubusd）：**不发、不等 HELLO**；`localId` 固定 `1`；请求 `peer` 一律 `0`。TCP 连不上/超时抛错。 |
| `UbusChannel.fromSocket(socket, opts?)` | `static (socket, opts?) => UbusChannel` | 包一个已建立的 socket（服务端 accept 侧）。 |
| `channel.localId` | 属性 | 恒为 `1`。 |
| `channel.setRequestHandler(fn)` / `channel.onRequest(fn)` | `(fn) => void` | 设入站方法分发回调。`fn(req)`，`req = { method, data, peer, seq, objectId, reply(data) }`；返回值（或其 Promise）作 DATA 回执后跟 STATUS OK；返回 `undefined` 只回 STATUS；抛错回 STATUS `UNKNOWN_ERROR`；未知方法（无 handler）回 `METHOD_NOT_FOUND`。非函数抛 `TypeError`。 |
| `channel.request(method, data?, opts?)` | `(method, data, { timeout?, onData?, noReply? }) => Promise<{ status, data, dataList }>` | 通道 INVOKE（peer 固定 0）。`noReply: true` 为 fire-and-forget（ucode `return:"ignore"`）。 |
| `channel.defer(method, data?, opts?)` | 同 `request` | 与 `request` 完全等价；`opts.onData` 对应 ucode defer 的 `data_cb`。 |
| `channel.close()` | 同 `UbusClient.close()` | 同上。 |

**通用规则**：`seq` 为客户端自增 uint16，从 1 开始（0 留给 HELLO），
回绕时跳过 0；响应按 `(seq, peer)` 二元组匹配 pending；一次调用的正常
响应是 0..n 条 DATA + 一条 STATUS；无主的 DATA/STATUS 直接丢弃；
PING 到来时自动回空 DATA；默认超时 30 秒（ucode `connect` 缺省值）；
断线时全部 pending 以 `CONNECTION_FAILED` 结算，`'close'` 恰好发一次。
**不支持**：`SUBSCRIBE` / `UNSUBSCRIBE`（订阅与事件总线，wifiroam 不用；
收到的这类消息只透出 `'message'` 事件，不崩溃）、通道上的
`ADD_OBJECT` / `LOOKUP`（libubus 同样拒绝；本模块不提供该入口）。

**方法 handler 的 `req.reply(data)`**：可提前发一条 DATA（随后仍会发
STATUS）；只调一次有效，重复调用忽略；`NO_REPLY` 请求下 `reply` 与
返回值均不发送。

---

## 3. `lib/uci.js` — UCI 读写（`uci` 命令行到底）

全部操作走 `uci` 二进制 argv，**不直接读 `/etc/config/*`**。
`UciClient` 构造可注 `opts.runner: (argv) => { code, stdout }`（默认跑
真实 `uci`）；默认单例 `uci` 绑定真实二进制。

| 导出 | 签名 | 返回值 / 错误行为 |
|---|---|---|
| `UciClient` | `class`，`new UciClient({ runner? })` | 见下。 |
| `uci` | 默认单例 | `new UciClient()`（真实 `uci` 二进制）。业务模块直接 `import { uci }`。 |
| `createUciClient(opts?)` | `(opts?) => UciClient` | 同构造器。 |
| `parseShow(output)` | `(output: string) => [{ '.name', '.type', ...options }]` | 解析 `uci show <pkg>` 输出。section 头 `pkg.sid=类型`；list 选项为多个单引号 token（或重复行）时合成数组；单 token 为字符串。 |
| `client.load(pkg)` | `(pkg) => true` | 无操作（CLI 每次现读，无缓存可刷）。为与 ucode `cursor.load()` 的调用点对齐而保留，恒回 `true`。 |
| `client.get(pkg, section)` | `(pkg, section) => object \| null` | section 对象 `{ '.name': sid, '.type': 类型, ...options }`；不存在回 `null`。 |
| `client.get(pkg, section, option)` | `(pkg, section, option) => string \| string[] \| null` | 标量回字符串；list 选项回字符串数组；缺失回 `null`。 |
| `client.getList(pkg, section, option)` | `(pkg, section, option) => string[]` | 恒回数组（缺失/空 → `[]`；标量包一层）。对应原版 `as_list(get(...))` 的用法。 |
| `client.set(pkg, section, type)` | `(pkg, section, type) => boolean` | 三参数式：建一个指定类型、指定名的 section（`uci set pkg.section=type`）。 |
| `client.set(pkg, section, option, value)` | `(pkg, section, option, value: string \| string[]) => boolean` | 写选项。字符串 → `uci set pkg.section.option=value`；数组 → 先 `delete` 该选项再逐项 `add_list`（空数组 = 只删）；与 ucode `cursor.set(pkg, s, o, [..])` 等价。失败（命令非零退出，如 section 不存在）回 `false`。 |
| `client.add(pkg, type, name?)` | `(pkg, type, name?) => string \| null` | `uci add pkg type [name]`；成功回新 section id（如 `cfg0a1b2c3`），失败回 `null`。 |
| `client.delete(pkg, section, option?)` | `(pkg, section, option?) => boolean` | 删 section 或删某选项。成功 `true`，失败 `false`。 |
| `client.commit(pkg)` | `(pkg) => boolean` | `uci commit pkg`；成功 `true`，失败 `false`。 |
| `client.foreach(pkg, type, cb)` | `(pkg, type, cb) => number` | 对每条该类型 section 调 `cb(section)`（section 含 `.name` / `.type`）；返回访问条数。包不存在或命令失败时访问 0 条。 |

**错误行为**：缺失的包/section/option 一律回 `null`/`[]`/`false`（不抛）；
只有缺必填参数时抛 `TypeError`。**已知与 ucode cursor 的一点差异**：
CLI 要求 section 已存在才能 `set` 其选项，因此 `set()` 在 section
不存在时回 `false`，调用方须先 `add()`（或用三参数式建 section）。
原版代码里每个 `set()` 目标要么在默认配置中已存在，要么刚由
`add()`/三参数式创建，所以按原版调用顺序搬运时不受影响（见 §8）。

---

## 4. `lib/shell.js` — 外部命令封装

命令字面值与参数一律取自 spec §7（`shellCommands` / `PROC`），含
`2>/dev/null` / `>/dev/null 2>&1` 的静默语义；不做转义、不改拼接方式
（spec §9.23）。

| 导出 | 签名 | 返回值 / 错误行为 |
|---|---|---|
| `cmdOutput(cmd, opts?)` | `(cmd: string, { timeout?: number }) => string` | 同步经 `/bin/sh -c` 执行（= ucode `cmd_output` 的 `fs.popen`），回全部 stdout。**退出码不读取**；stderr 丢弃；popen 失败/超时/空命令一律回 `""`，不抛。 |
| `runShellAsync(cmd, opts?)` | `async (cmd, { timeout?: number }) => Promise<{ code, stdout, stderr }>` | 异步 shell 形。`code` 为退出码；信号杀死/超时/起不来时为 `null`。 |
| `runProcess(path, args?, opts?)` | `async (path, args = [], { timeout?, onExit? }) => Promise<number \| null>` | 异步 argv 形（= `uloop.process(path, [args], null, cb)`，无 shell）。resolve 退出码（即原回调收到的 `res`）；起不来/信号杀死/超时时 resolve `null`。`opts.onExit(code)` 与 resolve 同值回调。 |
| `shellCommands` | 冻结对象，函数 → 字面命令串 | §7.3 全部命令的原样构造器，见源码注释。例：`dpiPid()` → `'pidof wifiroam-dpi 2>/dev/null'`；`nftApplyFile(f)` → `` `nft -f ${f} 2>/dev/null` ``；`nslookupWarm(h)`；`wifiReloadDelayed()`；`wpadApk()` / `wpadOpkg()`；`tcClassAdd(dev, classid, kbit)`；`ipNeighDev(dev)`；`iwStationDump(ifname)` 等。 |
| `PROC` | 冻结对象，`[path, args]` 对 | §7.4 的异步进程调用点（供 `runProcess(...PROC.wifiReload)` 使用）：`dnsmasqReload`、`firewallReload`、`networkReload`、`wifiReload`。 |
| `setCommandRunner(fn)` / `resetCommandRunner()` | 测试钩子 | 替换/恢复 `cmdOutput` 的同步执行器。**业务代码禁用**，仅单测用。 |

---

## 5. `lib/util.js` — 纯函数（按 spec §2 从原版原样搬运）

除 `log`（写 stdout）与 `nowMinutes()`（无参时调 `date +%H:%M`）外均为
纯函数；除 xorshift32 的 `rngState` 外无状态。ucode `int()` 的语义由
`toInt` 承接（字符串取前导符号+数字，无数字时为 0）。

| 导出 | 签名 | 语义（与原版逐字一致处） |
|---|---|---|
| `log(msg)` | `(msg: string) => void` | 写 stdout：`` `wifiroam: ${msg}\n` ``（procd 收集）。 |
| `setLogWriter(fn)` | 测试钩子 | 改 log 的输出目标；业务代码禁用。 |
| `macnorm(m)` | `(m) => string` | 去全部非十六进制字符并小写；`null` → `''`。 |
| `maccolon(mn)` | `(mn) => string` | 12 位 MAC → 大写冒号形；非 12 位原样返回。 |
| `devnorm(v)` | `(v) => string` | `g<12hex>` 组 ID 原样保留，否则 `macnorm`。 |
| `isGroupId(v)` | `(v) => boolean` | 是否匹配 `/^g[0-9a-f]{12}$/`。 |
| `macIsRandom(mn)` | `(mn) => boolean` | 首字节第二十六进制位为 2/6/a/e 时为真。 |
| `srand(seed)` / `rand()` / `randhex(n)` | `() => …` | xorshift32：`srand` 取 `int(seed)&0x7fffffff`，0 时用 `0x9e3779b9`；`rand()` 回 `rng_state & 0x7fffffff`；`randhex(n)` 每字符 `rand()%16` 的一位十六进制。 |
| `toInt(v)` | `(v) => number` | ucode `int()`：数字截断；字符串取前导数字（无则 0）；布尔 → 0/1；其余 → 0。 |
| `fieldAfter(words, key)` | `(words: string[], key) => string \| null` | 词数组中 `key` 的后一词；找不到或已是末词回 `null`。 |
| `nowSeconds()` | `() => number` | ucode `time()`：秒级 epoch。 |
| `hhmmMinutes(s)` | `(s) => number \| null` | `"HH:MM"` → 分钟数；格式非法（非两段、h>23、m>59）回 `null`。 |
| `nowMinutes(dateOutput?)` | `(dateOutput?: string) => number` | 传参时解析该串；无参时跑 `date +%H:%M` 再解析，解析失败回 `0`。 |
| `localDayString(d?)` | `(d = new Date()) => string` | 本地时区 `"YYYY-MM-DD"`（与 `appctl_roll_day` 的 `localtime` 格式一致）。 |
| `maskPrefix(m)` | `(m) => number` | 无 `.` → `int(m ?? "24")`；点分掩码 → 计数前导 1，遇首个 0 即回。 |
| `ipv4Cidr(ipmask, mask)` | `(ipmask, mask) => string` | 原样搬运，**含倒序拼接 `o[3],o[2],o[1],o[0]`，不得“纠正”为正序**（spec §9.14）。机制上唯一差别：`1 << host` 用 `2 ** host` 实现（JS 的 `1<<31` 为负数，数值结果与 ucode 64 位整数一致）。 |
| `pick(v)` | `(v) => any` | 数组取首项，否则原样（`guest_lan_info` 的局部 `pick`）。 |
| `asList(v)` | `(v) => any[]` | 数组原样；非空字符串包一层；其余 → `[]`（`appctl_dnsmasq_sync` 的局部 `as_list`）。 |
| `sha256(s)` | `(s) => string` | `node:crypto` 的 `sha256` 小写 hex，与原版 `digest.sha256` 一致。 |

---

## 6. `lib/store.js` — JSON 文件持久化

路径常量：`ALIAS_DIR = '/etc/wifiroam'`，`ALIAS_PATH`、
`DEVICES_PATH`、 `APPSTATS_PATH`、 `APPCTL_SCHEMA_PATH`（均为
`/etc/wifiroam/*`）。读失败（不存在、不可读、JSON 非法）一律回默认值，
不抛；写为原子写（同目录临时文件 + rename），失败回 `false`，不抛。
（原版为 `fs.writefile` 直接写，原子写是本任务要求的唯一改动。）

| 导出 | 签名 | 形状 / 行为 |
|---|---|---|
| `readJsonFile(path, fallback, accept?)` | `(path, fallback, accept?) => any` | 读并 `JSON.parse`；失败或 `accept(data) === false` 时回 `fallback`。 |
| `writeJsonAtomic(path, value)` | `(path, value) => boolean` | 原子写 JSON（`JSON.stringify`，无缩进，与原版 `%.J` 的紧凑形式一致）。 |
| `writeTextAtomic(path, text)` | `(path, text) => boolean` | 原子写纯文本（`nft_schema` 用）。 |
| `defaultAliases()` | `() => { ver: 0, map: {}, groups: {}, redirect: {}, isolated: {}, pin: {} }` | aliases.json 的空态。 |
| `loadAliases(path?)` | `(path = ALIAS_PATH) => object` | 缺字段补 `{}`；`ver` 非数字时为 0。对应原版 `alias_load()`。 |
| `saveAliases(path, aliases)` | `(path, aliases) => boolean` | 全量写回。**不做** UCI `alias_sync.ver` 的同步——那是调用方的事（原版 `alias_save()` 含此步，见 §8）。 |
| `defaultAppStats()` | `() => { day: '', stats: {}, online: {}, ndata: {} }` | appstats.json 的空态。 |
| `loadAppStats(path?)` | `(path = APPSTATS_PATH) => object` | 恢复 `stats/day/online/ndata`，各缺省 `{}`（`day` 缺省 `''`）。对应原版 `appstats_load()`。 |
| `saveAppStats(path, data)` | `(path, data) => boolean` | 写 `{ ver: 1, day, stats, online, ndata }`（`ver: 1` 为原版写盘字面量）。 |
| `loadDevices(path?)` | `(path = DEVICES_PATH) => object` | 组 ID → `{ mac, ip, hostname, first_seen, last_online, last_offline, online, ap, conn }`；非对象条目跳过；**每条 `online` 强制 `false`**（原版 `devlist_load()`：重启后不伪造在线态）。 |
| `saveDevices(path, devices)` | `(path, devices) => boolean` | 全量写回。 |
| `loadSchema(path?)` | `(path = APPCTL_SCHEMA_PATH) => string \| null` | 读 nft_schema 原文；文件不存在回 `null`（原版以此判定“不一致，需重建”）。 |
| `saveSchema(path, schema)` | `(path, schema) => boolean` | 原子写 schema 原文。 |

---

## 7. 模块依赖图（只允许这些方向）

```
util.js ──► shell.js (仅 nowMinutes 的 date 调用)
store.js ──► (无依赖)
blobmsg.js ──► (无依赖)
uci.js ──► node:child_process (uci 二进制)
shell.js ──► node:child_process
ubus.js ──► blobmsg.js, node:net, node:events
```

业务模块只 import 上面的公开接口；不得 import 各模块的内部函数
（下划线开头者、测试钩子 `setLogWriter` / `setCommandRunner` 除外，
后两者仅单测可用）。

---

## 8. 未等价项（无法等价实现处，写清原因，不悄悄改行为）

1. **真机 ubusd 对测未做**：`UbusClient`/`UbusChannel` 的帧格式、HELLO
   握手、`(seq, peer)` 匹配、对象发布均按 research 文档的源码引用实现，
   并用“假 ubusd / 假对端”在沙箱里对测通过（见 `tests/infra.test.mjs`，
   清单 C/D/E）。但 research §2.13 明确指出“未在真机上抓包验证”；
   与真实 `ubusd` / 真实 ucode 对端的互通（尤其 `SIGNATURE` 的具体
   编码、`DATA` 多条返回、`ubus call` 的逐字段比对）须在路由器上跑
   research §2.12 的 C/D/E 组闭环后才算完成。
2. **`SIGNATURE` 编码为按文档推断**：research 只写“每个方法一个 TABLE，
   内含 `{参数名: 类型码}`”，未给逐字节样例。本模块按此实现（方法名
   TABLE + INT32 类型码字段）；若真机 `ubus call` 对照发现出入，以
   真机为准修正。
3. **uci `set()` 要求 section 已存在**：CLI 行为；ucode cursor 是否
   隐式建 section 未在原版源码中写明。本模块 `set()` 在 section
   不存在时回 `false`（不抛），调用方须先 `add()`。原版所有 `set()`
   目标均已存在或刚被创建，搬运时不受影响。
4. **`get()` 的 list 判定来自 `uci show` 解析**：单 token 回字符串、多
   token/重复行回数组；ucode cursor 同样按 list 与否区分返回类型，
   语义一致，但 CLI 输出的引号转义解析只覆盖常规值（含空格的值用
   单引号包裹；值内含单引号的极端情况不在覆盖内）。
5. **原子写是唯一 deliberate 的行为改动**：原版 `fs.writefile` 直接
   覆盖；本任务要求写临时文件再 rename。读路径与字段形状与原版一致。
6. **`alias_save()` 的 UCI 同步不在 `store.js`**：原版 `alias_save()`
   写完 JSON 还写 UCI `alias_sync.ver`；`saveAliases()` 只写 JSON，
   调用方（业务模块）须随后调 `uci.set('wifiroam','alias_sync','ver',…)` +
   `commit`，否则别名版本号的 UCI 镜像会落后。
7. **`cmdOutput` 的 stderr 丢弃位置**：原版 `fs.popen` 下不带
   `2>/dev/null` 的命令其 stderr 会进 procd 日志；本模块的同步执行器
   一律丢弃 stderr（命令串自身的 `2>/dev/null` 原样保留）。只影响
   日志可见性，不影响返回值。
8. **Node 版本**：沙箱只有 Node v24，测试在 v24 上跑过；代码只用
   Node 22.23.4 已有 API（`tests/infra.test.mjs` 的 F16 用例 grep
   禁用清单：`Promise.try`、`RegExp.escape`、`Float16Array`、
   `Error.isError`、`Atomics.pause`、`URLPattern`、`using` 声明）。
   上机验收仍须用 22.23.4 二进制重跑。
9. **`ipv4_cidr` 的倒序拼接原样保留**（spec §9.14），`1 << host` 改为
   `2 ** host` 只是 JS 32 位位运算的数值等价替换，结果不变。
10. **订阅/事件（SUBSCRIBE/NOTIFY/事件总线）未实现**：wifiroam 不用；
    收到的这类消息只透出 `'message'` 事件，不崩溃。`notify()` 只发
    送，不跟踪订阅者。
