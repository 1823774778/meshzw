// daemon-discovery.test.mjs -- node:test suite for daemon/discovery.mjs.
// Covers: hello 构造与 thash、join/auth 校验、push 消息字段、TTL 过期处理,
// plus SAP tick/report、leave、pair 握手、setup 失败 fail-fast。
// ubus/uci/shell/dgram/net 一律 mock: 通道用 FakeChannel, UDP/TCP 用
// FakeUdpSocket/FakeServer, UCI 用 plain 对象; 不碰真实网络与路由器。
// 跨模块回调 (wifi/guest/policy/clients/core) 用记录调用的 stub 注入。
//
// Run: node --test tests/daemon-discovery.test.mjs  (from ~/workspace/wifiroam-js)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createDiscovery, UDP_PORT, TCP_PORT, MAGIC } from '../daemon/discovery.mjs';
import { macnorm, sha256 } from '../lib/util.js';

const flush = () => new Promise((r) => setImmediate(r));
const flush2 = async () => { await flush(); await flush(); };
const nowS = () => Math.floor(Date.now() / 1000);

// ------------------------------------------------------------ fakes
class FakeChannel extends EventEmitter {
  constructor() {
    super();
    this.defers = [];   // { method, data, opts, resolve, reject }
    this.requests = []; // { method, data, opts }
    this.closed = false;
    this.handler = null;
    this.socket = null; // sapConnect 会取 chan.socket, mock 下为 null
  }

  setRequestHandler(fn) { this.handler = fn; }
  onRequest(fn) { this.setRequestHandler(fn); }

  request(method, data, opts = {}) {
    this.requests.push({ method, data, opts });
    return Promise.resolve({ status: 0, data: null, dataList: [] });
  }

  defer(method, data, opts = {}) {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    this.defers.push({ method, data, opts, resolve, reject, promise });
    return promise;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  disconnect() { this.close(); }

  // 测试用: 模拟对端发来一条 INVOKE, 返回 handler 经 req.reply 发出的回执。
  // req 形状与 lib/ubus.js 一致: { method, data, reply }。
  async deliver(method, data) {
    const replies = [];
    const req = { method, data, reply: (d) => replies.push(d) };
    const ret = this.handler ? await this.handler(req) : undefined;
    return { ret, replies };
  }

  // 测试用: 让第 i 条 defer 收到 DATA 回执 (触发 onData) 后完成。
  answerDefer(i, data, status = 0) {
    const rec = this.defers[i];
    assert.ok(rec, `defer #${i} should exist`);
    if (typeof rec.opts?.onData === 'function') rec.opts.onData(data);
    rec.resolve({ status, data, dataList: data === undefined ? [] : [data] });
  }

  failDefer(i, err = new Error('mock defer failed')) {
    const rec = this.defers[i];
    assert.ok(rec, `defer #${i} should exist`);
    rec.reject(err);
  }
}

class FakeUdpSocket extends EventEmitter {
  constructor() {
    super();
    this.sent = []; // { buf, port, address }
    this.broadcast = false;
    this.bound = false;
    this.closed = false;
  }

  bind(port, host, cb) {
    this.bound = true;
    this.bindArgs = { port, host };
    if (typeof cb === 'function') cb();
  }

  setBroadcast(v) { this.broadcast = v; }
  send(buf, port, address) {
    this.sent.push({ buf: Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)), port, address });
  }

  close() { this.closed = true; }
}

class FakeServer extends EventEmitter {
  constructor() {
    super();
    this.listened = false;
    this.closed = false;
  }

  listen(port, host, backlog, cb) {
    this.listened = true;
    this.listenArgs = { port, host, backlog };
    if (typeof cb === 'function') cb();
  }

  close() { this.closed = true; }
}

// 可控定时器: 回调只在测试手动触发时跑, 不用等真实 300ms / 8000ms。
function makeTimers() {
  const list = [];
  return {
    list,
    setTimeout: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      list.push(t);
      return t;
    },
    clearTimeout: (t) => { if (t) t.cleared = true; },
    fireAll() {
      for (const t of list.splice(0)) if (!t.cleared) t.fn();
    },
  };
}

// ------------------------------------------------------------ fixtures
function makeState(over = {}) {
  const s = {
    cfg: { enabled: true, role: 'cap', token: 'tok123', cap_ip: '', name: 'CAP1', ...(over.cfg ?? {}) },
    self: {
      mac: 'AA:BB:CC:DD:EE:01', ip: '192.168.1.1', name: 'CAP1',
      model: 'TestAP', hostname: 'cap1', nonce: 'abcdef0123456789',
      ...(over.self ?? {}),
    },
    bcast: '192.168.1.255',
    peers: {},
    discovered: {},
    cap_learned: null,
    link: null,
    roster: null,
    cap_nr: [],
    net_names: {},
    aliases: { ver: 7, map: {}, groups: {}, redirect: {}, isolated: {}, pin: {} },
    last_apply: null,
    last_backhaul: null,
    last_wifi: null,
    last_guest: null,
    roam_ver_applied: 3,
    backhaul_ver_applied: 2,
    prev_clients: null,
    events: [],
  };
  for (const [k, v] of Object.entries(over)) {
    if (k !== 'cfg' && k !== 'self') s[k] = v;
  }
  return s;
}

function makeHarness(S, extra = {}) {
  const calls = [];
  const logs = [];
  const exits = [];
  const udpSock = new FakeUdpSocket();
  const tcpServer = new FakeServer();
  const channels = []; // channelFromSocket 建出的服务端通道
  const timers = extra.timers ?? makeTimers();
  const uciValues = extra.uciValues ?? {};

  const callbacks = {
    pushEvent: (type, mac, info, name) => {
      calls.push(['pushEvent', type, mac, info, name]);
      S.events.push({ ts: nowS(), type, mac, name, info });
    },
    saveConfig: () => calls.push(['saveConfig']),
    reconfigure: () => calls.push(['reconfigure']),
    currentRoamCfg: () => ({
      enabled: true, ssids: ['MyWiFi'], r_fast: true, ft_mode: 'simple',
      ft_over_ds: true, k_neighbor: true, k_beacon: true,
      v_bss_transition: true, rssi_profile: 'balanced', rssi_threshold: -70,
      config_ver: 5,
    }),
    currentBackhaulCfg: () => ({
      enabled: true, ssid: 'wifiroam-bh', key: 'k', device: '', config_ver: 4,
    }),
    guestCfg: () => ({
      enabled: false, ssid: 'Guest', key: '', bandwidth: 0, schedule: false,
      start: '08:00', end: '23:00', allow_lan: false, ver: 2,
    }),
    roamSig: (r) => sha256([
      r.enabled ? 1 : 0, (r.ssids ?? []).join(','), r.r_fast ? 1 : 0,
      r.ft_mode ?? 'simple', r.ft_over_ds ? 1 : 0, r.k_neighbor ? 1 : 0,
      r.k_beacon ? 1 : 0, r.v_bss_transition ? 1 : 0,
      r.rssi_profile ?? 'balanced', r.rssi_threshold ?? -70,
    ].join('|')),
    selfInfo: () => ({ mac: S.self.mac, ip: S.self.ip, name: S.self.name }),
    localClients: () => ({}),
    diffEvents: (...a) => calls.push(['diffEvents', ...a]),
    ownerEvents: (...a) => calls.push(['ownerEvents', ...a]),
    clientNames: () => ({ aabbccddeeff: { hostname: 'phone', ip: '192.168.1.50' } }),
    apOverview: () => ({ aps: [{ mac: 'aabbccddee01', name: 'CAP1' }] }),
    bssPublic: () => [{ bssid: 'aabbccddee01', ssid: 'MyWiFi' }],
    memberList: () => [{ mac: 'AA:BB:CC:DD:EE:02', name: 'SAP1' }],
    appliedKvr: () => ({ MyWiFi: { k: 1, v: 1, r: 1 } }),
    applyRoamLocal: (roam, members) => {
      calls.push(['applyRoamLocal', roam, members]);
      return { ok: true, ver: roam?.config_ver ?? 0 };
    },
    applyBackhaulLocal: (bh, role) => {
      calls.push(['applyBackhaulLocal', bh, role]);
      return { ok: true, ver: bh?.config_ver ?? 0 };
    },
    applyWifiLocal: (ssids) => {
      calls.push(['applyWifiLocal', ssids]);
      return { ok: true };
    },
    roamRenameSsids: (pairs) => calls.push(['roamRenameSsids', pairs]),
    wifiSummary: () => ({
      ifaces: [
        { band: '2g', ssid: 'Old2G' },
        { band: '5g', ssid: 'Old5G' },
      ],
    }),
    guestSaveLocal: (g) => {
      calls.push(['guestSaveLocal', g]);
      return extra.guestSaveLocalResult ?? true;
    },
    applyGuestLocal: (cfg) => {
      calls.push(['applyGuestLocal', cfg]);
      return { ok: true };
    },
    offloadApply: (on) => {
      calls.push(['offloadApply', on]);
      return true;
    },
    aliasApply: (...a) => {
      calls.push(['aliasApply', ...a]);
      return extra.aliasApplyResult ?? true;
    },
    pinApply: (...a) => {
      calls.push(['pinApply', ...a]);
      return extra.pinApplyResult ?? { ok: true, mac: 'aabbccddeeff', ap: '' };
    },
    aliasSave: () => calls.push(['aliasSave']),
    deviceReindex: () => calls.push(['deviceReindex']),
    findClient: (...a) => {
      calls.push(['findClient', ...a]);
      return extra.findClientResult ?? null;
    },
    buildTopology: () => ({ nodes: [], self: 'aabbccddee01', role: S.cfg.role, now: 1 }),
    ...(extra.callbacks ?? {}),
  };

  const uci = {
    get: (pkg, section, option) => {
      const key = `${pkg}|${section}|${option}`;
      if (key in uciValues) return uciValues[key];
      return null;
    },
  };

  const ctx = {
    S,
    uci,
    util: { log: (msg) => logs.push(msg) },
    ...callbacks,
    dgram: { createSocket: () => udpSock },
    net: { createServer: () => tcpServer },
    channelConnect: extra.channelConnect ?? (async () => {
      const ch = new FakeChannel();
      channels.push(ch);
      return ch;
    }),
    channelFromSocket: (socket) => {
      const ch = new FakeChannel();
      ch.socket = socket;
      channels.push(ch);
      return ch;
    },
    timers,
    exit: (code) => exits.push(code),
    ...(extra.ctx ?? {}),
  };
  const disc = createDiscovery(ctx);
  return { disc, ctx, calls, logs, exits, udpSock, tcpServer, channels, timers, S };
}

// 服务端通道: 建一条已认证的 CAP 侧连接, 返回 { conn 通道, peerMn }。
async function makeAuthedServerPeer(h, { mn = 'aabbccddeeff', mac = 'AA:BB:CC:DD:EE:FF' } = {}) {
  await h.disc.setupTcp();
  const sock = new EventEmitter();
  sock.destroy = () => {};
  h.tcpServer.emit('connection', sock);
  const chan = h.channels[h.channels.length - 1];
  assert.ok(chan, 'srvAccept should create a channel');
  // hello 已发出 (fire-and-forget)。
  assert.equal(chan.requests[0].method, 'hello');
  assert.equal(chan.requests[0].opts.noReply, true);
  // auth 握手: digest = sha256(token + ":" + conn.nonce)。
  const nonce = chan.requests[0].data.nonce;
  assert.equal(typeof nonce, 'string');
  assert.equal(nonce.length, 16);
  const digest = sha256(`${h.S.cfg.token}:${nonce}`);
  const { replies } = await chan.deliver('auth', {
    mac, name: 'SAP1', digest,
    alias_ver: 7, roam_ver: 5, roam_sig: h.ctx.roamSig(h.ctx.currentRoamCfg()),
    backhaul_ver: 4, guest_ver: 2,
  });
  assert.equal(replies[0].ok, true);
  assert.equal(h.S.peers[mn].authed, true);
  return { chan, mn, mac };
}

// SAP 出向通道: 让 S.link 进入已认证态, 返回 FakeChannel。
async function makeAuthedSapLink(h, { token = 'tok123' } = {}) {
  h.S.cfg.role = 'sap';
  h.S.cfg.token = token;
  const linkChan = new FakeChannel();
  h.ctx.channelConnect = async () => linkChan;
  const disc2 = createDiscovery({ ...h.ctx, channelConnect: async () => linkChan });
  // 注意: h.disc 与 disc2 共享同一 S; 用 disc2 的 sapConnect 建链。
  disc2.sapConnect('192.168.1.1');
  await flush2();
  assert.equal(h.S.link?.chan, linkChan);
  const { replies } = await linkChan.deliver('hello', {
    mac: 'AA:BB:CC:DD:EE:01', role: 'cap', nonce: 'server-nonce-1234',
  });
  assert.equal(replies.length, 0, 'hello 分支不直接 reply, 而是 defer auth');
  assert.equal(linkChan.defers.length, 1);
  assert.equal(linkChan.defers[0].method, 'auth');
  const expectedDigest = sha256(`${token}:server-nonce-1234`);
  assert.equal(linkChan.defers[0].data.digest, expectedDigest);
  linkChan.answerDefer(0, {
    ok: true, names: { aabbccddeeff: { hostname: 'phone', ip: '192.168.1.50' } },
    roster: { aps: [] },
  });
  await flush2();
  assert.equal(h.S.link.authed, true);
  return { disc: disc2, linkChan };
}

// ------------------------------------------------------------ hello / UDP
test('sendHello: 字段齐全, thash 为 sha256("wifiroam:"+token) 前 16 字符', async () => {
  const h = makeHarness(makeState());
  await h.disc.setupUdp();
  assert.equal(h.udpSock.bindArgs.port, UDP_PORT);
  assert.equal(h.udpSock.bindArgs.host, '0.0.0.0');
  assert.equal(h.udpSock.broadcast, true);
  h.disc.sendHello();
  assert.equal(h.udpSock.sent.length, 1);
  const sent = h.udpSock.sent[0];
  assert.equal(sent.port, UDP_PORT);
  assert.equal(sent.address, '192.168.1.255');
  const obj = JSON.parse(sent.buf.toString('utf8'));
  assert.equal(obj.magic, MAGIC);
  assert.equal(obj.ver, 1);
  assert.equal(obj.role, 'cap');
  assert.equal(obj.mac, 'AA:BB:CC:DD:EE:01');
  assert.equal(obj.ip, '192.168.1.1');
  assert.equal(obj.name, 'CAP1');
  assert.equal(obj.model, 'TestAP');
  assert.equal(obj.nonce, 'abcdef0123456789');
  assert.equal(obj.thash, sha256('wifiroam:tok123').slice(0, 16));
  assert.equal(obj.alias_ver, 7);
  assert.equal(typeof obj.ts, 'number');
});

test('sendHello: token 变化则 thash 变化; 未建 UDP 时静默不发', () => {
  const h = makeHarness(makeState());
  h.disc.sendHello(); // 未 setupUdp: udpSocket 为 null, 不抛、不发
  assert.equal(h.udpSock.sent.length, 0);
  h.S.cfg.token = 'other-token';
  h.disc.udpSend({ magic: MAGIC, ver: 1, thash: sha256('wifiroam:other-token').slice(0, 16) });
  assert.equal(h.udpSock.sent.length, 0, 'udpSend 同样要求先建 socket');
});

test('udpRx: unconfigured 设备进 discovered, 不进 peers, 不校验 token', () => {
  const h = makeHarness(makeState());
  h.disc.udpRx(JSON.stringify({
    magic: MAGIC, ver: 1, role: 'unconfigured', mac: 'AA:BB:CC:DD:EE:99',
    ip: '192.168.1.99', name: 'NewAP', model: 'X1', nonce: 'nonce-xyz',
  }), { address: '192.168.1.99' });
  const d = h.S.discovered[macnorm('AA:BB:CC:DD:EE:99')];
  assert.ok(d);
  assert.equal(d.mac, 'AA:BB:CC:DD:EE:99');
  assert.equal(d.ip, '192.168.1.99');
  assert.equal(d.name, 'NewAP');
  assert.equal(d.model, 'X1');
  assert.equal(d.nonce, 'nonce-xyz');
  assert.equal(typeof d.last_seen, 'number');
  assert.equal(Object.keys(h.S.peers).length, 0);
});

test('udpRx: unconfigured 设备无 ip 时用发送方地址兜底', () => {
  const h = makeHarness(makeState());
  h.disc.udpRx(JSON.stringify({
    magic: MAGIC, role: 'unconfigured', mac: 'aa:bb:cc:dd:ee:98', nonce: 'n1',
  }), { address: '192.168.1.98' });
  assert.equal(h.S.discovered[macnorm('AA:BB:CC:DD:EE:98')].ip, '192.168.1.98');
});

test('udpRx: 同 token 的 cap/sap 进 peers; cap 的 ip 学为 cap_learned', () => {
  const h = makeHarness(makeState());
  const thash = sha256('wifiroam:tok123').slice(0, 16);
  h.disc.udpRx(JSON.stringify({
    magic: MAGIC, role: 'cap', mac: 'AA:BB:CC:DD:EE:02', ip: '192.168.1.2',
    name: 'CAP2', model: 'M', nonce: 'n', thash,
  }), { address: '192.168.1.2' });
  const p = h.S.peers[macnorm('AA:BB:CC:DD:EE:02')];
  assert.ok(p);
  assert.equal(p.clients, null, '首轮未收 report, clients 保持 null');
  assert.equal(p.mac, 'AA:BB:CC:DD:EE:02');
  assert.equal(p.role, 'cap');
  assert.equal(h.S.cap_learned, '192.168.1.2');
  // sap 的 hello 不改 cap_learned
  h.disc.udpRx(JSON.stringify({
    magic: MAGIC, role: 'sap', mac: 'AA:BB:CC:DD:EE:03', ip: '192.168.1.3',
    name: 'SAP', model: 'M', nonce: 'n', thash,
  }), { address: '192.168.1.3' });
  assert.equal(h.S.peers[macnorm('AA:BB:CC:DD:EE:03')].role, 'sap');
  assert.equal(h.S.cap_learned, '192.168.1.2');
});

test('udpRx: 丢弃项 -- 错 magic、错 thash、本机 token 为空、本机 MAC、坏 JSON、非对象', () => {
  const h = makeHarness(makeState());
  const good = {
    magic: MAGIC, role: 'cap', mac: 'AA:BB:CC:DD:EE:02', ip: '192.168.1.2',
    name: 'CAP2', thash: sha256('wifiroam:tok123').slice(0, 16),
  };
  const cases = [
    JSON.stringify({ ...good, magic: 'OTHER' }),
    JSON.stringify({ ...good, thash: '0000000000000000' }),
    JSON.stringify({ ...good, mac: 'AA:BB:CC:DD:EE:01' }), // 本机 MAC
    JSON.stringify({ ...good, mac: 'ZZ:ZZ' }), // macnorm 长度非 12
    '{not json',
    JSON.stringify(['array', 'not', 'object']),
    JSON.stringify('just a string'),
  ];
  for (const c of cases) h.disc.udpRx(c, { address: '192.168.1.2' });
  assert.equal(Object.keys(h.S.peers).length, 0);
  // 本机 token 为空时, 即使 thash 对得上 "wifiroam:" 也照样丢弃 (foreign net 分支)。
  h.S.cfg.token = '';
  h.disc.udpRx(JSON.stringify({ ...good, thash: sha256('wifiroam:').slice(0, 16) }),
    { address: '192.168.1.2' });
  assert.equal(Object.keys(h.S.peers).length, 0);
});

test('setupUdp: bind 失败时 log 并 exit(1)', () => {
  const h = makeHarness(makeState());
  const failingSock = new FakeUdpSocket();
  failingSock.bind = (_port, _host, _cb) => {
    failingSock.emit('error', new Error('EADDRINUSE'));
  };
  const disc = createDiscovery({
    ...h.ctx, dgram: { createSocket: () => failingSock },
  });
  disc.setupUdp();
  assert.deepEqual(h.exits, [1]);
  assert.match(h.logs.join('\n'), /udp bind failed/);
});

test('expireTick: 超 PEER_TTL 的 peer 发 ap_offline 事件、断通道、删除; 未过期保留', () => {
  const h = makeHarness(makeState());
  const chan = new FakeChannel();
  h.S.peers.aabbccddeeff = {
    mac: 'AA:BB:CC:DD:EE:FF', name: 'SAP1', last_seen: nowS() - 31, chan,
    clients: {},
  };
  h.S.peers.aabbccddeeee = {
    mac: 'AA:BB:CC:DD:EE:EE', name: 'SAP2', last_seen: nowS() - 10, chan: null,
    clients: {},
  };
  h.disc.expireTick();
  assert.equal(h.S.peers.aabbccddeeff, undefined);
  assert.equal(chan.closed, true);
  assert.ok(h.S.peers.aabbccddeeee, '10 秒未过期, 保留');
  assert.deepEqual(
    h.calls.filter((c) => c[0] === 'pushEvent'),
    [['pushEvent', 'ap_offline', 'AA:BB:CC:DD:EE:FF', 'SAP1', undefined]],
  );
});

test('expireTick: discovered 超 DISCOVER_TTL(180s) 删除, 未过期保留; 边界 30s 不删', async () => {
  const h = makeHarness(makeState());
  h.S.discovered.aabbccddeeff = { mac: 'AA:BB:CC:DD:EE:FF', last_seen: nowS() - 181 };
  h.S.discovered.aabbccddeeee = { mac: 'AA:BB:CC:DD:EE:EE', last_seen: nowS() - 179 };
  h.S.peers.aabbccddeeed = { last_seen: nowS() - 30, chan: null };
  h.disc.expireTick();
  assert.equal(h.S.discovered.aabbccddeeff, undefined);
  assert.ok(h.S.discovered.aabbccddeeee);
  assert.ok(h.S.peers.aabbccddeeed, '正好 30 秒不算超时 (原版用 > 比较)');
});

// ------------------------------------------------------------ TCP 服务端
test('setupTcp: listen 50608/0.0.0.0 backlog 8; 新连接先发 hello(noReply)', async () => {
  const h = makeHarness(makeState());
  await h.disc.setupTcp();
  assert.deepEqual(h.tcpServer.listenArgs, { port: TCP_PORT, host: '0.0.0.0', backlog: 8 });
  const sock = new EventEmitter();
  sock.destroy = () => {};
  h.tcpServer.emit('connection', sock);
  const chan = h.channels[0];
  assert.ok(chan);
  assert.equal(chan.requests.length, 1);
  assert.equal(chan.requests[0].method, 'hello');
  assert.equal(chan.requests[0].data.mac, 'AA:BB:CC:DD:EE:01');
  assert.equal(chan.requests[0].data.role, 'cap');
  assert.equal(chan.requests[0].data.nonce.length, 16);
  assert.match(chan.requests[0].data.nonce, /^[0-9a-f]{16}$/);
  assert.equal(chan.requests[0].opts.noReply, true);
});

test('setupTcp: listen 失败时 log 并 exit(1)', async () => {
  const h = makeHarness(makeState());
  const failingServer = new FakeServer();
  failingServer.listen = (_p, _host, _b, _cb) => {
    failingServer.emit('error', new Error('EADDRINUSE'));
  };
  const disc = createDiscovery({
    ...h.ctx, net: { createServer: () => failingServer },
  });
  disc.setupTcp();
  assert.deepEqual(h.exits, [1]);
  assert.match(h.logs.join('\n'), /tcp bind\/listen failed/);
});

// ------------------------------------------------------------ join / auth
test('srvRx join: nonce 正确 + token 非空 -> 落盘 sap、回 ok、300ms 后 reconfigure', async () => {
  const h = makeHarness(makeState({ cfg: { role: 'unconfigured', token: '', cap_ip: '' } }));
  await h.disc.setupTcp();
  const sock = new EventEmitter();
  sock.destroy = () => {};
  h.tcpServer.emit('connection', sock);
  const chan = h.channels[0];
  const { replies } = await chan.deliver('join', {
    token: 'cap-token-abc', cap_ip: '192.168.1.1', nonce_echo: 'abcdef0123456789',
  });
  assert.deepEqual(replies, [{ ok: true }]);
  assert.equal(h.S.cfg.role, 'sap');
  assert.equal(h.S.cfg.token, 'cap-token-abc');
  assert.equal(h.S.cfg.cap_ip, '192.168.1.1');
  assert.ok(h.calls.some((c) => c[0] === 'saveConfig'));
  assert.deepEqual(
    h.calls.filter((c) => c[0] === 'pushEvent'),
    [['pushEvent', 'paired', '', '192.168.1.1', undefined]],
  );
  assert.equal(h.calls.filter((c) => c[0] === 'reconfigure').length, 0, '300ms 未到不跑');
  h.timers.fireAll();
  assert.equal(h.calls.filter((c) => c[0] === 'reconfigure').length, 1);
});

test('srvRx join: nonce 错误 -> bad_nonce, 不落盘; token 为空 -> bad_nonce', async () => {
  const h = makeHarness(makeState({ cfg: { role: 'unconfigured', token: '', cap_ip: '' } }));
  await h.disc.setupTcp();
  const sock = new EventEmitter();
  sock.destroy = () => {};
  h.tcpServer.emit('connection', sock);
  const chan = h.channels[0];
  let r = await chan.deliver('join', { token: 't', cap_ip: '192.168.1.1', nonce_echo: 'wrongnonce000000' });
  assert.deepEqual(r.replies, [{ ok: false, error: 'bad_nonce' }]);
  r = await chan.deliver('join', { token: '', cap_ip: '192.168.1.1', nonce_echo: 'abcdef0123456789' });
  assert.deepEqual(r.replies, [{ ok: false, error: 'bad_nonce' }]);
  assert.equal(h.S.cfg.role, 'unconfigured');
  assert.equal(h.S.cfg.token, '');
  assert.equal(h.calls.filter((c) => c[0] === 'saveConfig').length, 0);
  assert.equal(h.timers.list.length, 0, '失败不设 300ms 定时器');
});

test('srvRx join: 本机不是 unconfigured 时直接丢弃 (无回执)', async () => {
  const h = makeHarness(makeState()); // role cap
  await h.disc.setupTcp();
  const sock = new EventEmitter();
  sock.destroy = () => {};
  h.tcpServer.emit('connection', sock);
  const chan = h.channels[0];
  const { replies } = await chan.deliver('join', {
    token: 't', cap_ip: '192.168.1.1', nonce_echo: 'abcdef0123456789',
  });
  assert.deepEqual(replies, []);
  assert.equal(h.S.cfg.role, 'cap');
});

test('srvRx auth: digest 正确 -> 认证通过, 回执含版本/names/roster, 版本落后触发补发', async () => {
  const h = makeHarness(makeState());
  await h.disc.setupTcp();
  const sock = new EventEmitter();
  sock.destroy = () => {};
  h.tcpServer.emit('connection', sock);
  const chan = h.channels[0];
  const nonce = chan.requests[0].data.nonce;
  const { replies } = await chan.deliver('auth', {
    mac: 'AA:BB:CC:DD:EE:FF', name: 'SAP1',
    digest: sha256(`tok123:${nonce}`),
    alias_ver: 3, roam_ver: 4, roam_sig: 'stale-sig',
    backhaul_ver: 1, guest_ver: 1,
  });
  assert.equal(replies.length, 1);
  const rep = replies[0];
  assert.equal(rep.ok, true);
  assert.equal(rep.role, 'cap');
  assert.equal(rep.alias_ver, 7);
  assert.equal(rep.roam_ver, 5);
  assert.equal(rep.backhaul_ver, 4);
  assert.deepEqual(rep.names, { aabbccddeeff: { hostname: 'phone', ip: '192.168.1.50' } });
  assert.deepEqual(rep.roster, { aps: [{ mac: 'aabbccddee01', name: 'CAP1' }] });
  const p = h.S.peers.aabbccddeeff;
  assert.equal(p.authed, true);
  assert.equal(p.chan, chan);
  assert.equal(p.mac, 'AA:BB:CC:DD:EE:FF');
  assert.equal(p.name, 'SAP1');
  assert.ok(h.calls.some((c) => c[0] === 'pushEvent' && c[1] === 'ap_online'));
  // 补发: alias_ver 落后 -> push_aliases; roam ver 落后 -> push_roam_config;
  // backhaul 启用且落后 -> push_backhaul_config; guest 落后 -> push_guest_config;
  // CAP 恒 push_offload。
  const methods = chan.defers.map((d) => d.method);
  assert.deepEqual(methods, [
    'push_aliases', 'push_roam_config', 'push_backhaul_config',
    'push_guest_config', 'push_offload',
  ]);
  assert.deepEqual(chan.defers[1].data, {
    roam: h.ctx.currentRoamCfg(),
    members: [{ mac: 'AA:BB:CC:DD:EE:02', name: 'SAP1' }],
  });
  assert.deepEqual(chan.defers[2].data, { backhaul: h.ctx.currentBackhaulCfg() });
  assert.deepEqual(chan.defers[3].data, { guest: h.ctx.guestCfg() });
  assert.deepEqual(chan.defers[4].data, { enabled: false },
    'push_offload 的 enabled 现读 firewall, mock UCI 无值 -> false');
});

test('srvRx auth: 版本一致时不补发 roam/backhaul/guest, 只补 alias 与 offload', async () => {
  const h = makeHarness(makeState());
  await h.disc.setupTcp();
  const sock = new EventEmitter();
  sock.destroy = () => {};
  h.tcpServer.emit('connection', sock);
  const chan = h.channels[0];
  const nonce = chan.requests[0].data.nonce;
  await chan.deliver('auth', {
    mac: 'AA:BB:CC:DD:EE:FF', name: 'SAP1',
    digest: sha256(`tok123:${nonce}`),
    alias_ver: 3, roam_ver: 5, roam_sig: h.ctx.roamSig(h.ctx.currentRoamCfg()),
    backhaul_ver: 4, guest_ver: 2,
  });
  assert.deepEqual(chan.defers.map((d) => d.method), ['push_aliases', 'push_offload']);
});

test('srvRx auth: digest 错误 -> {ok:false,error:"auth"} 并断开连接; token 为空同理', async () => {
  const h = makeHarness(makeState());
  await h.disc.setupTcp();
  const sock = new EventEmitter();
  sock.destroy = () => {};
  h.tcpServer.emit('connection', sock);
  const chan = h.channels[0];
  const nonce = chan.requests[0].data.nonce;
  let r = await chan.deliver('auth', { mac: 'AA:BB:CC:DD:EE:FF', digest: 'bad-digest' });
  assert.deepEqual(r.replies, [{ ok: false, error: 'auth' }]);
  assert.equal(chan.closed, true, '认证失败即 conn_close');
  assert.equal(h.S.peers.aabbccddeeff, undefined);

  // token 为空: 换一条新连接, digest 按空 token 算也照样拒绝。
  h.S.cfg.token = '';
  const sock2 = new EventEmitter();
  sock2.destroy = () => {};
  h.tcpServer.emit('connection', sock2);
  const chan2 = h.channels[1];
  const nonce2 = chan2.requests[0].data.nonce;
  r = await chan2.deliver('auth', { mac: 'AA:BB:CC:DD:EE:FF', digest: sha256(`:${nonce2}`) });
  assert.deepEqual(r.replies, [{ ok: false, error: 'auth' }]);
});

test('srvRx: 未认证的其他方法直接丢弃 (无回执)', async () => {
  const h = makeHarness(makeState());
  await h.disc.setupTcp();
  const sock = new EventEmitter();
  sock.destroy = () => {};
  h.tcpServer.emit('connection', sock);
  const chan = h.channels[0];
  const { replies } = await chan.deliver('report_status', { clients: {} });
  assert.deepEqual(replies, []);
});

// ------------------------------------------------------------ 已认证分发
test('srvRx report_status: 首轮不产事件, 次轮 diff; 回执含 nr; 版本落后补发', async () => {
  const h = makeHarness(makeState());
  const { chan, mn } = await makeAuthedServerPeer(h);
  // 首轮: prev clients 为 null, 不调 diffEvents。
  let r = await chan.deliver('report_status', {
    info: { name: 'SAP1' }, clients: { aabbccddeeff: { type: 'wifi' } },
    alias_ver: 7, roam_ver: 5, roam_sig: h.ctx.roamSig(h.ctx.currentRoamCfg()),
    backhaul_ver: 4, guest_ver: 2, kvr: null,
  });
  assert.equal(r.replies[0].ok, true);
  assert.equal(r.replies[0].alias_ver, 7);
  assert.equal(r.replies[0].roam_ver, 5);
  assert.equal(r.replies[0].backhaul_ver, 4);
  assert.deepEqual(r.replies[0].nr, [{ bssid: 'aabbccddee01', ssid: 'MyWiFi' }]);
  assert.equal(h.calls.filter((c) => c[0] === 'diffEvents').length, 0);
  assert.ok(h.calls.some((c) => c[0] === 'ownerEvents'));
  assert.equal(h.S.peers[mn].clients.aabbccddeeff.type, 'wifi');
  // 次轮: prev 非 null, 调 diffEvents; roam_sig 变化 -> 补发 push_roam_config。
  const before = chan.defers.length;
  r = await chan.deliver('report_status', {
    info: { name: 'SAP1' }, clients: { aabbccddeeee: { type: 'wifi' } },
    alias_ver: 7, roam_ver: 5, roam_sig: 'changed-sig',
    backhaul_ver: 4, guest_ver: 2, kvr: null,
  });
  assert.equal(h.calls.filter((c) => c[0] === 'diffEvents').length, 1);
  assert.equal(chan.defers.length, before + 1);
  assert.equal(chan.defers[chan.defers.length - 1].method, 'push_roam_config');
});

test('srvRx report_event: 透传进事件缓冲, 默认类型 peer_event', async () => {
  const h = makeHarness(makeState());
  const { chan } = await makeAuthedServerPeer(h);
  let r = await chan.deliver('report_event', {
    etype: 'roam_move', mac: 'AA:BB:CC:DD:EE:FF', info: 'x', name: 'phone',
  });
  assert.deepEqual(r.replies, [{ ok: true }]);
  assert.ok(h.calls.some((c) => c[0] === 'pushEvent' && c[1] === 'roam_move'));
  r = await chan.deliver('report_event', { mac: 'AA:BB:CC:DD:EE:FF' });
  assert.deepEqual(r.replies, [{ ok: true }]);
  assert.ok(h.calls.some((c) => c[0] === 'pushEvent' && c[1] === 'peer_event'));
});

test('srvRx set_offload: 非 CAP 拒; CAP 执行后广播回全部已认证 peer', async () => {
  const h = makeHarness(makeState());
  const { chan } = await makeAuthedServerPeer(h);
  // 再挂一个已认证 peer。
  const chan2 = new FakeChannel();
  h.S.peers.aabbccddeeee = { authed: true, chan: chan2, name: 'SAP2' };
  const r = await chan.deliver('set_offload', { enabled: true });
  assert.deepEqual(r.replies, [{ ok: true, enabled: true }]);
  assert.ok(h.calls.some((c) => c[0] === 'offloadApply' && c[1] === true));
  assert.equal(chan2.defers.length, 1);
  assert.equal(chan2.defers[0].method, 'push_offload');
  // 非 CAP 时拒绝且不执行。
  h.S.cfg.role = 'sap';
  const r2 = await chan.deliver('set_offload', { enabled: false });
  assert.deepEqual(r2.replies, [{ ok: false, error: 'not_cap' }]);
});

test('srvRx alias_update / pin_update: CAP 本地应用后广播, 回 ver; 失败回 ok:false', async () => {
  const h = makeHarness(makeState());
  const { chan } = await makeAuthedServerPeer(h);
  const chan2 = new FakeChannel();
  h.S.peers.aabbccddeeee = { authed: true, chan: chan2, name: 'SAP2' };
  let r = await chan.deliver('alias_update', { mac: 'AA:BB:CC:DD:EE:FF', name: 'phone', icon: null, note: '' });
  assert.deepEqual(r.replies, [{ ok: true, ver: 7 }]);
  assert.ok(h.calls.some((c) => c[0] === 'aliasApply'));
  assert.equal(chan2.defers.length, 1, 'aliasBroadcast 向另一已认证 peer 推 aliases');
  assert.equal(chan2.defers[0].method, 'push_aliases');
  r = await chan.deliver('pin_update', { mac: 'AA:BB:CC:DD:EE:FF', ap: 'aabbccddee01' });
  assert.deepEqual(r.replies, [{ ok: true, ver: 7 }]);
  assert.ok(h.calls.some((c) => c[0] === 'pinApply'));
  // aliasApply 失败 -> ok:false, 不广播。
  const h2 = makeHarness(makeState(), { aliasApplyResult: false });
  const p2 = await makeAuthedServerPeer(h2);
  const r2 = await p2.chan.deliver('alias_update', { mac: 'AA:BB:CC:DD:EE:FF', name: 'x' });
  assert.deepEqual(r2.replies, [{ ok: false }]);
  // pinApply 失败 -> 带 error。
  const h3 = makeHarness(makeState(), { pinApplyResult: { ok: false, error: 'invalid_ap' } });
  const p3 = await makeAuthedServerPeer(h3);
  const r3 = await p3.chan.deliver('pin_update', { mac: 'AA:BB:CC:DD:EE:FF', ap: 'bad' });
  assert.deepEqual(r3.replies, [{ ok: false, error: 'invalid_ap' }]);
});

test('srvRx get_topology / get_client_detail / 未知方法', async () => {
  const h = makeHarness(makeState());
  const { chan } = await makeAuthedServerPeer(h);
  let r = await chan.deliver('get_topology', {});
  assert.deepEqual(r.replies, [{ nodes: [], self: 'aabbccddee01', role: 'cap', now: 1 }]);
  r = await chan.deliver('get_client_detail', { mac: 'AA:BB:CC:DD:EE:FF' });
  assert.deepEqual(r.replies, [{ ok: false }]);
  const h2 = makeHarness(makeState(), {
    findClientResult: { node: { id: 'aabbccddeeff' }, ap: 'CAP1' },
  });
  const p2 = await makeAuthedServerPeer(h2);
  r = await p2.chan.deliver('get_client_detail', { mac: 'AA:BB:CC:DD:EE:FF' });
  assert.deepEqual(r.replies, [{ ok: true, client: { id: 'aabbccddeeff' }, ap: 'CAP1' }]);
  r = await chan.deliver('no_such_method', {});
  assert.deepEqual(r.replies, [{ ok: false, error: 'unknown_method' }]);
});

// ------------------------------------------------------------ push 族
test('pushRoamTo: 未认证/无通道回 false; 已认证发 push_roam_config, 回执更新 last_apply', async () => {
  const h = makeHarness(makeState());
  h.S.last_apply = {
    ts: 1, ver: 5,
    results: [
      { ap: 'AA:BB:CC:DD:EE:FF', name: 'SAP1', ok: null, error: 'pending' },
      { ap: 'aabbccddeeee', name: 'SAP2', ok: null, error: 'pending' },
    ],
  };
  const { chan, mn } = await makeAuthedServerPeer(h);
  assert.equal(h.disc.pushRoamTo('aabbccddeeee'), false, '无 peer 回 false');
  assert.equal(h.disc.pushRoamTo(mn), true);
  const d = chan.defers[chan.defers.length - 1];
  assert.equal(d.method, 'push_roam_config');
  assert.deepEqual(Object.keys(d.data), ['roam', 'members']);
  // 回执: 按冒号 MAC 匹配结果项。
  chan.answerDefer(chan.defers.length - 1, { ok: true, ver: 5, kvr: { MyWiFi: { k: 1 } } });
  await flush();
  assert.equal(h.S.last_apply.results[0].ok, true);
  assert.equal(h.S.last_apply.results[0].ver, 5);
  assert.equal(h.S.last_apply.results[0].error, null);
  assert.deepEqual(h.S.last_apply.results[0].kvr, { MyWiFi: { k: 1 } });
  assert.equal(h.S.last_apply.results[1].ok, null, '另一 AP 不受影响');
  assert.equal(h.S.peers[mn].roam_pushing, false);
});

test('pushRoamTo: 推送在途不重复发; 失败/超时标记 timeout', async () => {
  const h = makeHarness(makeState());
  h.S.last_apply = { ts: 1, ver: 5, results: [{ ap: 'AA:BB:CC:DD:EE:FF', ok: null }] };
  const { chan, mn } = await makeAuthedServerPeer(h);
  const base = chan.defers.length;
  assert.equal(h.disc.pushRoamTo(mn), true);
  assert.equal(h.disc.pushRoamTo(mn), true, '在途返回 true 但不重复发');
  assert.equal(chan.defers.length, base + 1);
  chan.failDefer(chan.defers.length - 1);
  await flush2();
  assert.equal(h.S.last_apply.results[0].ok, false);
  assert.equal(h.S.last_apply.results[0].error, 'timeout');
  assert.equal(h.S.peers[mn].roam_pushing, false);
  // 失败后可再次推送。
  assert.equal(h.disc.pushRoamTo(mn), true);
  assert.equal(chan.defers.length, base + 2);
});

test('pushBackhaulTo / pushWifiTo / pushGuestTo: data 字段与回执更新', async () => {
  const h = makeHarness(makeState());
  h.S.last_backhaul = { ts: 1, ver: 4, results: [{ ap: 'AA:BB:CC:DD:EE:FF', ok: null }] };
  h.S.last_wifi = { ts: 1, results: [{ ap: 'AA:BB:CC:DD:EE:FF', ok: null }] };
  h.S.last_guest = { ts: 1, results: [{ ap: 'AA:BB:CC:DD:EE:FF', ok: null }] };
  const { chan, mn } = await makeAuthedServerPeer(h);
  assert.equal(h.disc.pushBackhaulTo(mn), true);
  let d = chan.defers[chan.defers.length - 1];
  assert.equal(d.method, 'push_backhaul_config');
  assert.deepEqual(d.data, { backhaul: h.ctx.currentBackhaulCfg() });
  chan.answerDefer(chan.defers.length - 1, { ok: true, ver: 4, error: null });
  await flush();
  assert.equal(h.S.last_backhaul.results[0].ok, true);
  assert.equal(h.disc.pushWifiTo(mn, [{ band: '5g', ssid: 'New5G', key: '12345678' }]), true);
  d = chan.defers[chan.defers.length - 1];
  assert.equal(d.method, 'push_wifi_config');
  assert.deepEqual(d.data, { ssids: [{ band: '5g', ssid: 'New5G', key: '12345678' }] });
  chan.answerDefer(chan.defers.length - 1, { ok: true, error: null });
  await flush();
  assert.equal(h.S.last_wifi.results[0].ok, true);
  assert.equal(h.disc.pushGuestTo(mn, h.ctx.guestCfg()), true);
  d = chan.defers[chan.defers.length - 1];
  assert.equal(d.method, 'push_guest_config');
  assert.deepEqual(d.data, { guest: h.ctx.guestCfg() });
  chan.answerDefer(chan.defers.length - 1, { ok: false, error: 'invalid' });
  await flush();
  assert.equal(h.S.last_guest.results[0].ok, false);
  assert.equal(h.S.last_guest.results[0].error, 'invalid');
});

test('pushAliasesTo / pushOffloadTo: 未认证不发; offload 开关现读 UCI', async () => {
  const h = makeHarness(makeState(), {
    uciValues: { 'firewall|@defaults[0]|flow_offloading': '1' },
  });
  const { chan, mn } = await makeAuthedServerPeer(h);
  h.disc.pushAliasesTo(mn);
  let d = chan.defers[chan.defers.length - 1];
  assert.equal(d.method, 'push_aliases');
  assert.deepEqual(d.data, { aliases: h.S.aliases });
  h.disc.pushOffloadTo(mn);
  d = chan.defers[chan.defers.length - 1];
  assert.equal(d.method, 'push_offload');
  assert.deepEqual(d.data, { enabled: true });
  // 未认证 peer: 两个 push 都静默跳过。
  h.S.peers.aabbccddeeee = { authed: false, chan: new FakeChannel() };
  const before = chan.defers.length;
  h.disc.pushAliasesTo('aabbccddeeee');
  h.disc.pushOffloadTo('aabbccddeeee');
  h.disc.pushRoamTo('aabbccddeeee');
  assert.equal(chan.defers.length, before);
});

test('push 族同步抛错 -> peerLinkDead: peer 置 offline、断 conn', async () => {
  const h = makeHarness(makeState());
  const { chan, mn } = await makeAuthedServerPeer(h);
  const conn = h.S.peers[mn].conn;
  assert.ok(conn);
  chan.defer = () => { throw new Error('write failed'); };
  assert.equal(h.disc.pushRoamTo(mn), false);
  assert.equal(h.S.peers[mn].authed, false);
  assert.equal(h.S.peers[mn].chan, null);
  assert.equal(h.S.peers[mn].conn, null);
  assert.match(h.logs.join('\n'), /push_roam_config to aabbccddeeff failed/);
});

test('aliasBroadcast: 仅 CAP、仅已认证 peer; 写失败断开该 peer', async () => {
  const h = makeHarness(makeState());
  const { chan } = await makeAuthedServerPeer(h);
  const chan2 = new FakeChannel();
  h.S.peers.aabbccddeeee = { authed: true, chan: chan2, name: 'SAP2' };
  h.S.peers.aabbccddeeed = { authed: false, chan: new FakeChannel(), name: 'SAP3' };
  h.disc.aliasBroadcast();
  assert.equal(chan.defers.filter((d) => d.method === 'push_aliases').length, 1);
  assert.equal(chan2.defers.length, 1);
  assert.deepEqual(chan2.defers[0].data, { aliases: h.S.aliases });
  // 非 CAP 不广播。
  h.S.cfg.role = 'sap';
  const before = chan.defers.length + chan2.defers.length;
  h.disc.aliasBroadcast();
  assert.equal(chan.defers.length + chan2.defers.length, before);
  // 写失败断开。
  h.S.cfg.role = 'cap';
  chan2.defer = () => { throw new Error('write failed'); };
  const conn2 = { _closed: false };
  h.S.peers.aabbccddeeee.conn = conn2;
  h.disc.aliasBroadcast();
  assert.equal(h.S.peers.aabbccddeeee.authed, false);
  assert.equal(h.S.peers.aabbccddeeee.chan, null);
});

// ------------------------------------------------------------ SAP 侧
test('sapConnect/sapTick: 非 sap 不动; sap 无链路时按 cap_ip 连接, 否则用 cap_learned', async () => {
  const h = makeHarness(makeState());
  h.disc.sapTick();
  assert.equal(h.S.link, null, 'role=cap 时 sapTick 不动');
  h.S.cfg.role = 'sap';
  h.S.cfg.cap_ip = '192.168.1.1';
  h.disc.sapTick();
  await flush2();
  assert.ok(h.S.link, '按 cfg.cap_ip 连接');
  assert.equal(h.S.link.authed, false);
  assert.equal(h.S.link.chan, h.channels[0]);
  // 已认证且 last_pong 新鲜 -> 不重连。
  h.S.link.authed = true;
  h.S.link.last_pong = nowS();
  const linkBefore = h.S.link;
  h.disc.sapTick();
  assert.equal(h.S.link, linkBefore);
  // last_pong 超 45 秒 -> 断开重连 (走 cap_learned, 因 cap_ip 被清空)。
  h.S.cfg.cap_ip = '';
  h.S.cap_learned = '192.168.1.9';
  h.S.link.last_pong = nowS() - 46;
  h.disc.sapTick();
  await flush2();
  assert.notEqual(h.S.link, linkBefore);
  assert.equal(h.S.link.authed, false);
  assert.match(h.logs.join('\n'), /CAP link timeout, reconnecting/);
});

test('sapConnect: 建连失败时链路被清理 (不断言崩溃)', async () => {
  const h = makeHarness(makeState({ cfg: { role: 'sap', cap_ip: '192.168.1.1' } }));
  const disc = createDiscovery({
    ...h.ctx,
    channelConnect: async () => { throw new Error('ECONNREFUSED'); },
  });
  disc.sapConnect('192.168.1.1');
  await flush2();
  assert.equal(h.S.link, null);
});

test('sapRx hello: 发起 auth, digest=sha256(token:nonce); 成功后置 authed 并立即 report', async () => {
  const h = makeHarness(makeState());
  const { disc, linkChan } = await makeAuthedSapLink(h);
  // auth 成功后 sapReport 已发 report_status。
  assert.equal(linkChan.defers.length, 2);
  assert.equal(linkChan.defers[1].method, 'report_status');
  const rep = linkChan.defers[1].data;
  assert.equal(rep.alias_ver, 7);
  assert.equal(rep.roam_ver, 3);
  assert.equal(rep.backhaul_ver, 2);
  assert.equal(rep.guest_ver, 2);
  assert.equal(rep.roam_sig, h.ctx.roamSig(h.ctx.currentRoamCfg()));
  assert.ok('info' in rep && 'clients' in rep && 'kvr' in rep);
  // 回执刷新 last_pong / net_names / roster / cap_nr。
  const before = h.S.link.last_pong;
  linkChan.answerDefer(1, {
    names: { aabbccddeeff: { hostname: 'phone', ip: '192.168.1.50' } },
    roster: { aps: [{ mac: 'aabbccddee01' }] },
    nr: [{ bssid: 'aabbccddee01' }],
  });
  await flush();
  assert.ok(h.S.link.last_pong >= before);
  assert.deepEqual(h.S.net_names, { aabbccddeeff: { hostname: 'phone', ip: '192.168.1.50' } });
  assert.deepEqual(h.S.roster, { aps: [{ mac: 'aabbccddee01' }] });
  assert.deepEqual(h.S.cap_nr, [{ bssid: 'aabbccddee01' }]);
  assert.ok(h.S.peers[macnorm('AA:BB:CC:DD:EE:01')].authed, 'CAP peer 置 authed');
  assert.ok(h.calls.some((c) => c[0] === 'pushEvent' && c[1] === 'cap_connected'));
  void disc;
});

test('sapRx hello: auth 被拒 (ok:false) -> 断开通道', async () => {
  const h = makeHarness(makeState());
  h.S.cfg.role = 'sap';
  const linkChan = new FakeChannel();
  const disc = createDiscovery({ ...h.ctx, channelConnect: async () => linkChan });
  disc.sapConnect('192.168.1.1');
  await flush2();
  await linkChan.deliver('hello', { mac: 'AA:BB:CC:DD:EE:01', role: 'cap', nonce: 'n1' });
  assert.equal(linkChan.defers[0].method, 'auth');
  linkChan.answerDefer(0, { ok: false, error: 'auth' });
  await flush2();
  assert.equal(linkChan.closed, true);
  assert.match(h.logs.join('\n'), /CAP auth rejected/);
});

test('sapRx hello: 未认证时非 hello 方法直接丢弃', async () => {
  const h = makeHarness(makeState());
  h.S.cfg.role = 'sap';
  const linkChan = new FakeChannel();
  const disc = createDiscovery({ ...h.ctx, channelConnect: async () => linkChan });
  disc.sapConnect('192.168.1.1');
  await flush2();
  const { replies } = await linkChan.deliver('push_roam_config', { roam: {}, members: [] });
  assert.deepEqual(replies, []);
  assert.equal(linkChan.defers.length, 0);
});

test('sapRx push_aliases: 仅 ver 更大时接受并落盘', async () => {
  const h = makeHarness(makeState());
  const { linkChan } = await makeAuthedSapLink(h);
  let r = await linkChan.deliver('push_aliases', {
    aliases: { ver: 9, map: { aabbccddeeff: { name: 'phone' } }, groups: {}, redirect: {}, isolated: {}, pin: {} },
  });
  assert.deepEqual(r.replies, [{ ok: true, ver: 9 }]);
  assert.equal(h.S.aliases.ver, 9);
  assert.ok(h.calls.some((c) => c[0] === 'deviceReindex'));
  assert.ok(h.calls.some((c) => c[0] === 'aliasSave'));
  const saves = h.calls.filter((c) => c[0] === 'aliasSave').length;
  r = await linkChan.deliver('push_aliases', {
    aliases: { ver: 5, map: {}, groups: {}, redirect: {}, isolated: {}, pin: {} },
  });
  assert.deepEqual(r.replies, [{ ok: true, ver: 9 }]);
  assert.equal(h.calls.filter((c) => c[0] === 'aliasSave').length, saves, '旧 ver 不落盘');
});

test('sapRx push_roam_config: 调 applyRoamLocal, 回 ok/ver/kvr', async () => {
  const h = makeHarness(makeState());
  const { linkChan } = await makeAuthedSapLink(h);
  const roam = { enabled: true, ssids: ['MyWiFi'], config_ver: 6 };
  const r = await linkChan.deliver('push_roam_config', { roam, members: [{ mac: 'x', name: 'y' }] });
  assert.deepEqual(r.replies, [{ ok: true, ver: 6, kvr: { MyWiFi: { k: 1, v: 1, r: 1 } } }]);
  assert.ok(h.calls.some((c) => c[0] === 'applyRoamLocal' && c[1] === roam));
});

test('sapRx push_backhaul_config / push_offload / get_topology / get_client_detail', async () => {
  const h = makeHarness(makeState());
  const { linkChan } = await makeAuthedSapLink(h);
  let r = await linkChan.deliver('push_backhaul_config', { backhaul: { enabled: true, config_ver: 9 } });
  assert.deepEqual(r.replies, [{ ok: true, ver: 9, error: undefined }]);
  assert.ok(h.calls.some((c) => c[0] === 'applyBackhaulLocal' && c[2] === 'sap'));
  r = await linkChan.deliver('push_offload', { enabled: true });
  assert.deepEqual(r.replies, [{ ok: true, enabled: true }]);
  assert.ok(h.calls.some((c) => c[0] === 'offloadApply' && c[1] === true));
  r = await linkChan.deliver('get_topology', {});
  assert.deepEqual(r.replies, [{ nodes: [], self: 'aabbccddee01', role: 'sap', now: 1 }]);
  r = await linkChan.deliver('get_client_detail', { mac: 'AA:BB:CC:DD:EE:FF' });
  assert.deepEqual(r.replies, [{ ok: false }]);
  r = await linkChan.deliver('unknown_push', {});
  assert.deepEqual(r.replies, [], '已认证未知方法静默丢弃 (无 default 分支)');
});

test('sapRx push_wifi_config: 非法 SSID/key 拒收; 合法按频段改名并应用', async () => {
  const h = makeHarness(makeState());
  const { linkChan } = await makeAuthedSapLink(h);
  let r = await linkChan.deliver('push_wifi_config', {
    ssids: [{ band: '5g', ssid: '', key: '' }],
  });
  assert.deepEqual(r.replies, [{ ok: false, error: 'ssid_invalid' }]);
  assert.equal(h.calls.filter((c) => c[0] === 'applyWifiLocal').length, 0);
  r = await linkChan.deliver('push_wifi_config', {
    ssids: [{ band: '5g', ssid: 'New5G', key: 'short' }],
  });
  assert.deepEqual(r.replies, [{ ok: false, error: 'ssid_invalid' }]);
  r = await linkChan.deliver('push_wifi_config', {
    ssids: [
      { band: '2g', ssid: 'New2G', key: '12345678' },
      { band: '5g', ssid: 'New5G', key: '' },
    ],
  });
  assert.deepEqual(r.replies, [{ ok: true, error: undefined }]);
  const rename = h.calls.find((c) => c[0] === 'roamRenameSsids');
  assert.deepEqual(rename[1], [
    { old: 'Old2G', new: 'New2G' },
    { old: 'Old5G', new: 'New5G' },
  ]);
  const applied = h.calls.find((c) => c[0] === 'applyWifiLocal');
  assert.deepEqual(applied[1], [
    { band: '2g', ssid: 'New2G', key: '12345678' },
    { band: '5g', ssid: 'New5G', key: '' },
  ]);
});

test('sapRx push_guest_config: guestSaveLocal 失败回 invalid; 成功则应用', async () => {
  const h = makeHarness(makeState());
  const { linkChan } = await makeAuthedSapLink(h);
  let r = await linkChan.deliver('push_guest_config', { guest: { enabled: true, ssid: 'Guest' } });
  assert.deepEqual(r.replies, [{ ok: true, error: undefined }]);
  assert.ok(h.calls.some((c) => c[0] === 'applyGuestLocal'));
  const h2 = makeHarness(makeState(), { guestSaveLocalResult: false });
  const p2 = await makeAuthedSapLink(h2);
  r = await p2.linkChan.deliver('push_guest_config', { guest: { enabled: true, ssid: 'Guest' } });
  assert.deepEqual(r.replies, [{ ok: false, error: 'invalid' }]);
  assert.equal(h2.calls.filter((c) => c[0] === 'applyGuestLocal').length, 0);
});

test('sapRx leave: 回 ok、发 unpaired 事件, 300ms 后清漫游并回 unconfigured', async () => {
  const h = makeHarness(makeState());
  const { linkChan } = await makeAuthedSapLink(h);
  const r = await linkChan.deliver('leave', {});
  assert.deepEqual(r.replies, [{ ok: true }]);
  assert.ok(h.calls.some((c) => c[0] === 'pushEvent' && c[1] === 'unpaired'));
  assert.equal(h.S.cfg.role, 'sap', '300ms 未到不切角色');
  h.timers.fireAll();
  const apply = h.calls.find((c) => c[0] === 'applyRoamLocal');
  assert.deepEqual(apply[1], { enabled: false, ssids: [], config_ver: 0 });
  assert.equal(h.S.cfg.role, 'unconfigured');
  assert.equal(h.S.cfg.token, '');
  assert.equal(h.S.cfg.cap_ip, '');
  assert.ok(h.calls.some((c) => c[0] === 'saveConfig'));
  assert.ok(h.calls.some((c) => c[0] === 'reconfigure'));
});

test('sapReport: 未认证/非 sap 不发; 失败断开', async () => {
  const h = makeHarness(makeState());
  const { disc, linkChan } = await makeAuthedSapLink(h);
  // 已认证时 sapReport 再发一次 report_status。
  const n = linkChan.defers.length;
  await disc.sapReport();
  assert.equal(linkChan.defers.length, n + 1);
  assert.equal(linkChan.defers[n].method, 'report_status');
  linkChan.failDefer(n);
  await flush2();
  assert.equal(h.S.link, null, 'report 失败断开重连');
  assert.match(h.logs.join('\n'), /CAP link report failed/);
  // 未认证不发。
  const h2 = makeHarness(makeState());
  h2.S.cfg.role = 'sap';
  h2.S.link = { authed: false, chan: new FakeChannel() };
  await h2.disc.sapReport();
  assert.equal(h2.S.link.chan.defers.length, 0);
});

test('sapDisconnect: 幂等, 清 CAP peer 的 authed', async () => {
  const h = makeHarness(makeState());
  const { linkChan } = await makeAuthedSapLink(h);
  h.disc.sapDisconnect();
  assert.equal(h.S.link, null);
  assert.equal(h.S.peers[macnorm('AA:BB:CC:DD:EE:01')].authed, false);
  assert.equal(linkChan.closed, true);
  h.disc.sapDisconnect(); // 第二次无操作、不抛
});

// ------------------------------------------------------------ pair / unpair
test('startPairing: 收到 hello 后 defer join, 成功回调 onPaired 并断开', async () => {
  const h = makeHarness(makeState());
  const paired = [];
  const pairChan = new FakeChannel();
  const disc = createDiscovery({
    ...h.ctx, channelConnect: async () => pairChan,
  });
  const handle = disc.startPairing({
    ip: '192.168.1.99', token: 'tok123', capIp: '192.168.1.1',
    nonceEcho: 'device-nonce-1', onPaired: () => paired.push(true),
  });
  assert.ok(handle);
  assert.equal(handle.done, false);
  await flush2();
  await pairChan.deliver('hello', { mac: 'AA:BB:CC:DD:EE:99', role: 'unconfigured', nonce: 'srv-nonce' });
  assert.equal(pairChan.defers.length, 1);
  assert.equal(pairChan.defers[0].method, 'join');
  assert.deepEqual(pairChan.defers[0].data, {
    token: 'tok123', cap_ip: '192.168.1.1', nonce_echo: 'device-nonce-1',
  });
  pairChan.answerDefer(0, { ok: true });
  await flush();
  assert.deepEqual(paired, [true]);
  assert.equal(handle.done, true);
  assert.equal(pairChan.closed, true, 'data_cb 后断开通道');
});

test('startPairing: 8000ms 兜底定时器在未完成时断开通道', async () => {
  const h = makeHarness(makeState());
  const pairChan = new FakeChannel();
  const disc = createDiscovery({
    ...h.ctx, channelConnect: async () => pairChan,
  });
  disc.startPairing({
    ip: '192.168.1.99', token: 'tok123', capIp: '192.168.1.1',
    nonceEcho: 'device-nonce-1', onPaired: () => {},
  });
  await flush2();
  assert.equal(h.timers.list.length, 1);
  assert.equal(h.timers.list[0].ms, 8000);
  assert.equal(pairChan.closed, false);
  h.timers.fireAll();
  assert.equal(pairChan.closed, true);
});

test('sendLeave: 已认证发 leave 回 true; 未认证回 false 不发', async () => {
  const h = makeHarness(makeState());
  const { chan, mn } = await makeAuthedServerPeer(h);
  assert.equal(h.disc.sendLeave(mn), true);
  assert.equal(chan.defers[chan.defers.length - 1].method, 'leave');
  assert.deepEqual(chan.defers[chan.defers.length - 1].data, {});
  h.S.peers.aabbccddeeee = { authed: false, chan: new FakeChannel() };
  assert.equal(h.disc.sendLeave('aabbccddeeee'), false);
  assert.equal(h.disc.sendLeave('aabbccddeeed'), false, '无 peer 回 false');
});

// ------------------------------------------------------------ 工厂校验
test('createDiscovery: 缺 S / 缺 uci / 缺回调时抛 TypeError 并点名', async () => {
  assert.throws(() => createDiscovery({}), /ctx\.S/);
  const S = makeState();
  assert.throws(() => createDiscovery({ S }), /ctx\.uci/);
  const ctx = { S, uci: { get: () => null } };
  assert.throws(() => createDiscovery(ctx), /ctx\.pushEvent/);
  const full = makeHarness(S).ctx;
  assert.doesNotThrow(() => createDiscovery(full));
});

test('stop: 关闭 UDP 与 TCP 监听', async () => {
  const h = makeHarness(makeState());
  await h.disc.setupUdp();
  await h.disc.setupTcp();
  h.disc.stop();
  assert.equal(h.udpSock.closed, true);
  assert.equal(h.tcpServer.closed, true);
  h.disc.stop(); // 再次调用不抛
});
