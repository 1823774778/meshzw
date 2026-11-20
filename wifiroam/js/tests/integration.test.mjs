// integration.test.mjs -- 模拟集成测试：守护进程完整启动流程。
//
// 真实 5 个业务模块 + 真实 lib/ubus.js 客户端，对接一个按 lib/ubus.js
// 协议实现的假 ubusd（unix socket，会转发 INVOKE 到守护进程发布的
// wifiroam 对象），uci/shell 走内存 mock，UDP 发包走 mock dgram，
// TCP 对端走真实 loopback。
//
// 沙箱限制（见 README）：沙箱禁 UDP 发送（send 报 EPERM），因此这里
// 的 UDP 发包被 mock dgram 记下后直接跳过、不真正发送；接收路径用
// discovery.udpRx 直接喂包覆盖。TCP loopback（127.0.0.1:50608）
// 与 unix socket 在沙箱里可用。
//
// 覆盖：加载配置 → 注册 ubus 对象（31 个方法）→ 发现 hello（未配置
// 设备进 discovered）→ ubus pair（配对发起）→ TCP 对端 auth +
// report_status（配对接受）→ ubus topology/status 查询 → ubus
// set_roam 触发漫游配置应用。全程不抛错、不崩、不挂起。
//
// Run: node --test tests/integration.test.mjs (from ~/workspace/wifiroam-js)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { createDaemon } from '../daemon/core.mjs';
import {
  UBUS_ATTR,
  UBUS_MSG,
  UBUS_STATUS,
  UbusChannel,
  UbusClient,
  UbusFrameParser,
  encodeFrame,
} from '../lib/ubus.js';
import { decode, encode as encodeBlob } from '../lib/blobmsg.js';
import { sha256 } from '../lib/util.js';

const i32Attr = (id, v) => {
  const payload = Buffer.alloc(4);
  payload.writeInt32BE(v | 0, 0);
  return { id, payload };
};
const sAttr = (id, s) => ({ id, payload: Buffer.from(s + '\0', 'utf8') });
const dAttr = (obj) => ({ id: UBUS_ATTR.DATA, payload: encodeBlob(obj) });

function waitFor(fn, { timeout = 5000, interval = 10 } = {}) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let ok = false;
      try { ok = fn(); } catch (_e) { /* keep waiting */ }
      if (ok) resolve(true);
      else if (Date.now() - start > timeout) reject(new Error('waitFor timed out'));
      else setTimeout(tick, interval);
    };
    tick();
  });
}

// ------------------------------------------------------------ fake UCI
class FakeUci {
  constructor(seed = {}) {
    this.pkgs = {};
    for (const [pkg, secs] of Object.entries(seed)) {
      this.pkgs[pkg] = {};
      for (const [sid, sec] of Object.entries(secs)) {
        this.pkgs[pkg][sid] = { '.name': sid, ...sec };
      }
    }
    this.commits = [];
  }

  load() { return true; }

  _sec(pkg, sid) { return this.pkgs[pkg]?.[sid] ?? null; }

  get(pkg, section, option) {
    const sec = this._sec(pkg, section);
    if (!sec) return null;
    if (option === undefined) return sec;
    const v = sec[option];
    return v === undefined ? null : v;
  }

  getList(pkg, section, option) {
    const v = this.get(pkg, section, option);
    if (Array.isArray(v)) return v;
    if (typeof v === 'string' && v !== '') return [v];
    return [];
  }

  set(pkg, section, option, value) {
    if (value === undefined) {
      this.pkgs[pkg] ??= {};
      this.pkgs[pkg][section] = { '.name': section, '.type': option };
      return true;
    }
    const sec = this._sec(pkg, section);
    if (!sec) return false;
    sec[option] = Array.isArray(value) ? [...value] : value;
    return true;
  }

  add(pkg, type, name) {
    this.pkgs[pkg] ??= {};
    const sid = name ?? `cfg${Math.floor(Math.random() * 0xffffffff).toString(16)}`;
    this.pkgs[pkg][sid] = { '.name': sid, '.type': type };
    return sid;
  }

  delete(pkg, section, option) {
    const sec = this._sec(pkg, section);
    if (!sec) return false;
    if (option === undefined) { delete this.pkgs[pkg][section]; return true; }
    delete sec[option];
    return true;
  }

  commit(pkg) { this.commits.push(pkg); return true; }

  foreach(pkg, type, cb) {
    let n = 0;
    for (const sec of Object.values(this.pkgs[pkg] ?? {})) {
      if (sec['.type'] !== type) continue;
      n++;
      cb(sec);
    }
    return n;
  }
}

// ------------------------------------------------------------ mock dgram
// 真实 UDP 发包在沙箱里报 EPERM，因此只记录、不发送。
function makeMockDgram() {
  const sent = [];
  const socket = {
    handlers: {},
    on(ev, fn) { (this.handlers[ev] ??= []).push(fn); return this; },
    bind(_port, _host, cb) { setTimeout(() => cb?.(), 0); return this; },
    setBroadcast() { return this; },
    send(buf, port, host) { sent.push({ buf: Buffer.from(buf), port, host }); },
    close() {},
  };
  return { sent, socket, createSocket: () => socket };
}

// ------------------------------------------------------------ fake ubusd
// 会转发：caller 对 wifiroam 对象（id 42）的 INVOKE 转给守护进程连接，
// 守护进程的 DATA/STATUS 回包再按 (seq, OBJID) 转回 caller。
function startFakeUbusd() {
  const dir = mkdtempSync(join(os.tmpdir(), 'wifiroam-int-ubusd-'));
  const sockPath = join(dir, 'ubus.sock');
  const received = [];
  const sockets = new Map(); // clientId -> socket
  let nextId = 0x1234;
  let wifiroamId = 0;
  let ownerSocket = null;
  const server = net.createServer((socket) => {
    const clientId = nextId++;
    sockets.set(clientId, socket);
    const parser = new UbusFrameParser();
    socket.write(encodeFrame(UBUS_MSG.HELLO, 0, clientId, []));
    socket.on('data', (chunk) => {
      let messages = [];
      try {
        messages = parser.push(chunk);
      } catch (_e) {
        socket.destroy();
        return;
      }
      for (const msg of messages) {
        received.push({ from: clientId, ...msg });
        handle(clientId, socket, msg);
      }
    });
    socket.on('close', () => {
      sockets.delete(clientId);
      if (ownerSocket === socket) ownerSocket = null;
    });
  });

  function send(socket, type, seq, peer, attrs) {
    socket.write(encodeFrame(type, seq, peer, attrs));
  }
  function lookupReply(socket, msg, objid, path) {
    send(socket, UBUS_MSG.DATA, msg.seq, 0, [
      i32Attr(UBUS_ATTR.OBJID, objid),
      sAttr(UBUS_ATTR.OBJPATH, path),
      i32Attr(UBUS_ATTR.OBJTYPE, 0),
    ]);
    send(socket, UBUS_MSG.STATUS, msg.seq, 0, [i32Attr(UBUS_ATTR.STATUS, 0)]);
  }
  function statusReply(socket, msg, peer, code) {
    send(socket, UBUS_MSG.STATUS, msg.seq, peer, [i32Attr(UBUS_ATTR.STATUS, code)]);
  }
  function dataReply(socket, msg, peer, objid, data) {
    send(socket, UBUS_MSG.DATA, msg.seq, peer, [i32Attr(UBUS_ATTR.OBJID, objid), dAttr(data)]);
    send(socket, UBUS_MSG.STATUS, msg.seq, peer, [i32Attr(UBUS_ATTR.OBJID, objid), i32Attr(UBUS_ATTR.STATUS, 0)]);
  }

  function handle(clientId, socket, msg) {
    const byId = new Map(msg.attrs.map((a) => [a.id, a]));
    const objid = byId.has(UBUS_ATTR.OBJID) ? byId.get(UBUS_ATTR.OBJID).payload.readInt32BE(0) : 0;
    if (msg.type === UBUS_MSG.LOOKUP) {
      const pathAttr = byId.get(UBUS_ATTR.OBJPATH);
      const path = pathAttr
        ? pathAttr.payload.subarray(0, pathAttr.payload.length - 1).toString('utf8')
        : null;
      if (path === 'network.interface.lan') return lookupReply(socket, msg, 5, path);
      if (path === 'network.wireless') return lookupReply(socket, msg, 6, path);
      if (path === 'wifiroam' && wifiroamId) return lookupReply(socket, msg, wifiroamId, path);
      return statusReply(socket, msg, 0, UBUS_STATUS.NOT_FOUND);
    }
    if (msg.type === UBUS_MSG.ADD_OBJECT) {
      wifiroamId = 42;
      ownerSocket = socket;
      // 与 infra 假 ubusd 同形：DATA 只带 OBJID/OBJTYPE 属性（不带
      // DATA 属性），lib 的 addObject 从解码结果读 objid。
      send(socket, UBUS_MSG.DATA, msg.seq, 0, [i32Attr(UBUS_ATTR.OBJID, 42), i32Attr(UBUS_ATTR.OBJTYPE, 0)]);
      send(socket, UBUS_MSG.STATUS, msg.seq, 0, [i32Attr(UBUS_ATTR.STATUS, 0)]);
      return;
    }
    if (msg.type === UBUS_MSG.REMOVE_OBJECT) {
      return statusReply(socket, msg, 0, 0);
    }
    if (msg.type === UBUS_MSG.INVOKE) {
      const method = byId.has(UBUS_ATTR.METHOD)
        ? byId.get(UBUS_ATTR.METHOD).payload.subarray(0, byId.get(UBUS_ATTR.METHOD).payload.length - 1).toString('utf8')
        : '';
      if (objid === 5 && method === 'status') {
        return dataReply(socket, msg, 5, 5, {
          interface: 'lan', up: true, device: 'br-lan',
          'ipv4-address': [{ address: '192.168.12.1', mask: 24 }],
        });
      }
      if (objid === 6 && method === 'status') return dataReply(socket, msg, 6, 6, {});
      if (objid === 42 && ownerSocket) {
        // 转给守护进程：peer 改为 caller 的 client id，守护进程照此回包。
        ownerSocket.write(encodeFrame(UBUS_MSG.INVOKE, msg.seq, clientId, msg.attrs));
        return;
      }
      return statusReply(socket, msg, objid, UBUS_STATUS.NOT_FOUND);
    }
    if (msg.type === UBUS_MSG.DATA || msg.type === UBUS_MSG.STATUS) {
      // 守护进程的回包：peer 是 caller client id，OBJID 属性给出对象 id。
      const dest = sockets.get(msg.peer);
      if (!dest) return;
      const oid = byId.has(UBUS_ATTR.OBJID) ? byId.get(UBUS_ATTR.OBJID).payload.readInt32BE(0) : 0;
      dest.write(encodeFrame(msg.type, msg.seq, oid, msg.attrs));
      return;
    }
    // 其他类型忽略。
  }

  return {
    dir,
    sockPath,
    received,
    listen: () => new Promise((resolve) => server.listen(sockPath, resolve)),
    close: () => new Promise((resolve) => {
      for (const s of sockets.values()) s.destroy();
      server.close(() => { rmSync(dir, { recursive: true, force: true }); resolve(); });
    }),
  };
}

// 该环境可能禁止 AF_UNIX，先探测；不可用则跳过而不是让套件变红。
const AF_UNIX_OK = await (async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'afunix-'));
  const sock = join(dir, 'probe.sock');
  const ok = await new Promise((res) => {
    const srv = net.createServer();
    srv.once('error', () => res(false));
    srv.listen(sock, () => srv.close(() => res(true)));
  });
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
  return ok;
})();
// ------------------------------------------------------------ the test
test('integration: full daemon startup + hello + pair + topology + set_roam', { timeout: 30000 }, async (t) => {
  if (!AF_UNIX_OK) return t.skip('AF_UNIX socket unavailable in this environment');
  const fake = startFakeUbusd();
  await fake.listen();
  const dgram = makeMockDgram();
  const exits = [];
  const uci = new FakeUci({
    wifiroam: {
      core: { '.type': 'globals', enabled: '1', role: 'cap', token: 'tok123', cap_ip: '', name: 'CAP' },
      roam: { '.type': 'roam', enabled: '0', ft_mode: 'simple', ft_over_ds: '1', k_neighbor: '1', k_beacon: '1', v_bss_transition: '1', rssi_profile: 'balanced', rssi_threshold: '-70', config_ver: '1', ssids: [] },
      backhaul: { '.type': 'backhaul', enabled: '0', ssid: 'wifiroam-bh', key: '', device: '', config_ver: '0' },
      guest: { '.type': 'guest', enabled: '0', ssid: 'Guest', key: '', bandwidth: '0', schedule: '0', start: '08:00', end: '23:00', allow_lan: '0', config_ver: '0' },
      appctl: { '.type': 'appctl', enabled: '0' },
      alias_sync: { '.type': 'alias_sync', ver: '0' },
    },
  });

  const daemon = await createDaemon({
    uci,
    ubusPath: fake.sockPath,
    ubusConnect: (path) => UbusClient.connect(path),
    exitFn: (code) => { exits.push(code); },
    extraCtx: { dgram },
  });
  t.after(async () => {
    try { daemon.stop(); } catch (_e) { /* ignore */ }
    await fake.close();
  });

  // ---- 1. 完整启动：配置、ubus 对象、UDP/TCP 监听、hello ----
  assert.equal(await daemon.start(), true);
  assert.deepEqual(exits, [], 'daemon must not fail-fast during startup');
  assert.equal(daemon.S.cfg.role, 'cap');
  assert.equal(daemon.S.cfg.token, 'tok123');
  assert.equal(daemon.S.self.ip, '192.168.12.1');
  assert.match(daemon.S.self.mac, /^[0-9A-F:]{17}$/);

  const addMsg = fake.received.find((m) => m.type === UBUS_MSG.ADD_OBJECT);
  assert.ok(addMsg, 'daemon published its ubus object');
  const sigAttr = addMsg.attrs.find((a) => a.id === UBUS_ATTR.SIGNATURE);
  assert.ok(sigAttr, 'ADD_OBJECT carries a SIGNATURE');
  const methods = Object.keys(decode(sigAttr.payload));
  assert.equal(methods.length, 31, 'wifiroam object exposes 31 methods');
  assert.equal(Object.keys(daemon.apiObject).length, 31);
  assert.ok(dgram.sent.length >= 1, 'sendHello ran at startup (mocked, not really sent)');
  const hello = JSON.parse(dgram.sent[0].buf.toString('utf8'));
  assert.equal(hello.magic, 'WIFIROAM1');
  assert.equal(hello.role, 'cap');

  // ---- 2. ubus 调用方：status / topology 走真实转发 ----
  const caller = await UbusClient.connect(fake.sockPath);
  t.after(() => caller.close());
  const status = await caller.call('wifiroam', 'status', {});
  assert.equal(status.version, 5);
  assert.equal(status.role, 'cap');
  const topo0 = await caller.call('wifiroam', 'topology', {});
  assert.equal(topo0.role, 'cap');
  assert.ok(Array.isArray(topo0.nodes));
  assert.ok(topo0.nodes.some((n) => n.id === daemon.S.self.mac.replace(/:/g, '').toLowerCase()));

  // ---- 3. 发现 hello：未配置设备进 discovered；pair 发起 ----
  daemon.modules.discovery.udpRx(Buffer.from(JSON.stringify({
    magic: 'WIFIROAM1', ver: 1, role: 'unconfigured',
    mac: 'AA:BB:CC:DD:EE:04', ip: '127.0.0.1', name: 'NEW-AP',
    model: 'Test', nonce: 'pairnonce123456',
  })), { address: '127.0.0.1' });
  assert.ok(daemon.S.discovered.aabbccddee04, 'unconfigured hello lands in discovered');
  const pairBad = await caller.call('wifiroam', 'pair', { mac: 'AA:BB:CC:DD:EE:99' });
  assert.deepEqual(pairBad, { ok: false, error: 'not_found' });
  const pair = await caller.call('wifiroam', 'pair', { mac: 'AA:BB:CC:DD:EE:04' });
  assert.deepEqual(pair, { ok: true, ip: '127.0.0.1' });
  // 对端是本机 CAP（join 被忽略、只回 STATUS OK），配对通道自行断开，
  // onPaired 不触发，discovered 里的设备仍在。
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(daemon.S.discovered.aabbccddee04, 'pair handshake without DATA ok leaves discovered');

  // ---- 4. TCP 对端：模拟一台 SAP 连上 50608，完成 auth + report_status ----
  const peerMac = 'aabbccdde e03'.replace(' ', '');
  const peerRequests = [];
  let helloNonce = null;
  const peerSock = net.connect(50608, '127.0.0.1');
  const peerChan = UbusChannel.fromSocket(peerSock);
  peerChan.setRequestHandler(async (req) => {
    peerRequests.push(req.method);
    if (req.method === 'hello') {
      helloNonce = req.data?.nonce ?? null;
      return undefined; // server sent it noReply: no answer expected
    }
    return {}; // push_roam_config / push_offload / ... 一律回空 DATA
  });
  t.after(() => { try { peerChan.close(); } catch (_e) { /* ignore */ } });
  await waitFor(() => helloNonce !== null, { timeout: 5000 });
  const auth = await peerChan.request('auth', {
    mac: 'AA:BB:CC:DD:EE:03', role: 'sap', name: 'SAP-TEST',
    digest: sha256(`tok123:${helloNonce}`),
    alias_ver: 0, roam_ver: 0, backhaul_ver: 0, guest_ver: 0,
  });
  assert.equal(auth.status, 0);
  assert.equal(auth.data.ok, true);
  assert.equal(daemon.S.peers[peerMac]?.authed, true);
  assert.ok(peerRequests.includes('push_roam_config'), 'CAP pushes roam config to a lagging SAP');
  assert.ok(peerRequests.includes('push_offload'), 'CAP pushes offload to a lagging SAP');

  const report = await peerChan.request('report_status', {
    info: { name: 'SAP-TEST', role: 'sap', ip: '192.168.12.3', wifi: [] },
    clients: {},
  });
  assert.equal(report.status, 0);
  assert.equal(report.data.ok, true);
  assert.deepEqual(daemon.S.peers[peerMac]?.clients, {});

  const topo1 = await caller.call('wifiroam', 'topology', {});
  assert.ok(topo1.nodes.some((n) => n.id === peerMac), 'peer shows up in topology after report_status');

  // ---- 5. 漫游配置应用：ubus set_roam ----
  const roam = await caller.call('wifiroam', 'set_roam', {
    enabled: true, ssids: ['HomeWiFi'], r_fast: true, ft_mode: 'simple',
    ft_over_ds: true, k_neighbor: true, k_beacon: true, v_bss_transition: true,
    rssi_profile: 'balanced', rssi_threshold: 0,
  });
  assert.equal(roam.ok, true);
  assert.equal(roam.ver, 2);
  assert.equal(daemon.S.last_apply.ver, 2);
  assert.deepEqual(uci.get('wifiroam', 'roam', 'ssids'), ['HomeWiFi']);
  assert.equal(uci.get('wifiroam', 'roam', 'config_ver'), '2');

  // ---- 6. 收尾：停守护进程，不挂起 ----
  daemon.stop();
  assert.equal(daemon.started, false);
  assert.deepEqual(exits, []);
});
