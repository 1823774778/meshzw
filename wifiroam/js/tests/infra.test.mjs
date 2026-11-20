// infra.test.mjs -- node:test suite for the wifiroam-js infra modules.
// Maps to research-node-ubus.md §2.12 checklist:
//   A. blobmsg encode/decode (pure functions)
//   B. frame parsing (stream splits / coalescing)
//   C. local ubus handshake + calls (fake ubusd on a unix socket)
//   D. object publish (ADD_OBJECT / REMOVE_OBJECT + inbound dispatch)
//   E. direct channel mode (two Node ends over TCP, no HELLO)
//   F. regression guard: no Node-22.23.4-banned APIs in lib/
// Plus: util pure functions, uci/shell with mocked runners, store.js
// JSON persistence. No real ubusd, no router, no network beyond
// localhost is required.
//
// Run: node --test tests/infra.test.mjs   (from ~/workspace/wifiroam-js)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  BLOBMSG_TYPE,
  decode,
  decodeAttrValue,
  encode,
  encodeAttr,
  encodeField,
  parseAttrs,
} from '../lib/blobmsg.js';
import {
  UBUS_ATTR,
  UBUS_MSG,
  UBUS_NO_REPLY,
  UBUS_STATUS,
  UbusChannel,
  UbusClient,
  UbusError,
  UbusFrameParser,
  encodeFrame,
} from '../lib/ubus.js';
import {
  asList,
  devnorm,
  fieldAfter,
  hhmmMinutes,
  ipv4Cidr,
  log,
  macIsRandom,
  maccolon,
  macnorm,
  maskPrefix,
  nowMinutes,
  pick,
  rand,
  randhex,
  setLogWriter,
  sha256,
  srand,
  toInt,
} from '../lib/util.js';
import {
  PROC,
  cmdOutput,
  resetCommandRunner,
  runProcess,
  runShellAsync,
  setCommandRunner,
  shellCommands,
} from '../lib/shell.js';
import { UciClient, parseShow } from '../lib/uci.js';
import {
  defaultAliases,
  defaultAppStats,
  loadAliases,
  loadAppStats,
  loadDevices,
  loadSchema,
  saveAliases,
  saveAppStats,
  saveDevices,
  saveSchema,
  writeJsonAtomic,
} from '../lib/store.js';

// ------------------------------------------------------------ helpers
const sAttr = (id, s) => ({
  id,
  payload: Buffer.concat([Buffer.from(String(s), 'utf8'), Buffer.from([0])]),
});
const i32Attr = (id, v) => {
  const p = Buffer.alloc(4);
  p.writeInt32BE(v, 0);
  return { id, payload: p };
};
const dAttr = (obj) => ({ id: UBUS_ATTR.DATA, payload: encode(obj) });

function waitFor(fn, { timeout = 2000, interval = 10 } = {}) {
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

// ================================================================= A. blobmsg
test('A1: roundtrip of the research example JSON', () => {
  const obj = {
    ssid: 'wifiroam-bh',
    rssi: -62,
    enabled: true,
    x: null,
    list: [1, 2],
    nested: { a: 'b' },
  };
  assert.deepEqual(decode(encode(obj)), obj);
});

test('A1: first attribute header bytes are extended + type + length', () => {
  // Field "ssid" = "wifiroam-bh": name header pad4(2+4+1) = 8,
  // payload 11 chars + NUL = 12, raw length 4+8+12 = 24.
  // Header word: 0x80000000 | (3 << 24) | 24 = 0x83000018.
  const buf = encodeField('ssid', 'wifiroam-bh');
  assert.equal(buf.readUInt32BE(0), 0x83000018);
  assert.equal(buf.readUInt16BE(4), 4); // namelen
  assert.equal(buf.subarray(6, 10).toString('utf8'), 'ssid');
  assert.equal(buf[10], 0); // name NUL
});

test('A3: empty table / empty array / empty string / int boundaries / double', () => {
  assert.equal(encode({}).length, 0);
  assert.deepEqual(decode(encode({})), {});
  assert.deepEqual(decode(encode({ a: [] })), { a: [] });
  assert.deepEqual(decode(encode({ a: '' })), { a: '' });
  assert.deepEqual(decode(encode({ a: 2147483647, b: -2147483648 })), { a: 2147483647, b: -2147483648 });
  // Outside INT32 -> INT64.
  assert.deepEqual(decode(encode({ a: 1099511627776 })), { a: 1099511627776 });
  assert.deepEqual(decode(encode({ a: -1099511627776 })), { a: -1099511627776 });
  const dbl = decode(encode({ a: 0.1 }));
  assert.ok(Math.abs(dbl.a - 0.1) < 1e-15);
  // INT64 beyond the safe-integer range comes back as a BigInt.
  const big = decode(encode({ a: 9007199254740993n }));
  assert.equal(big.a, 9007199254740993n);
});

test('A3: name lengths straddle the 4-byte name-header boundary', () => {
  // nameHeaderLen = pad4(2 + namelen + 1)
  const cases = [[1, 4], [2, 8], [5, 8], [6, 12], [13, 16]];
  for (const [namelen, headerLen] of cases) {
    const name = 'n'.repeat(namelen);
    const buf = encodeField(name, 'x'); // STRING payload "x\0" = 2 bytes
    const total = (4 + headerLen + 2 + 3) & ~3; // whole attribute padded to 4
    assert.equal(buf.length, total, `namelen ${namelen}`);
    assert.equal(decode(buf)[name], 'x');
  }
});

test('A3: three levels of nesting, table in array in table', () => {
  const obj = { l1: { l2: { l3: [1, { x: 'y' }, null, true] } } };
  assert.deepEqual(decode(encode(obj)), obj);
});

test('A: null is a present UNSPEC field; a missing field stays missing', () => {
  const withNull = decode(encode({ a: null, b: 1 }));
  assert.ok('a' in withNull);
  assert.equal(withNull.a, null);
  assert.equal(parseAttrs(encode({ a: null }))[0].type, BLOBMSG_TYPE.UNSPEC);
  assert.equal(parseAttrs(encode({ a: null }))[0].payload.length, 0);
  const without = decode(encode({ b: 1 }));
  assert.ok(!('a' in without));
});

test('A: boolean encodes as INT8 (type 7) and decodes as boolean', () => {
  assert.equal(parseAttrs(encode({ on: true }))[0].type, 7);
  assert.deepEqual(decode(encode({ on: true, off: false })), { on: true, off: false });
});

test('A4: truncated blob throws instead of crashing', () => {
  const buf = encode({ ssid: 'wifiroam-bh', rssi: -62 });
  assert.throws(() => decode(buf.subarray(0, buf.length - 3)), /truncated/);
  assert.throws(() => decode(buf.subarray(0, 2)), /truncated/);
  // Length field larger than the available bytes.
  const bad = Buffer.from(buf);
  bad.writeUInt32BE(0x8300ffff, 0);
  assert.throws(() => decode(bad), /truncated/);
  // Unknown blobmsg type id (15) in the first header.
  const badType = Buffer.from(encodeField('a', 'b'));
  badType.writeUInt32BE((0x8f000000 | (badType.readUInt32BE(0) & 0x00ffffff)) >>> 0, 0);
  assert.throws(() => decode(badType), /unknown blobmsg type/);
});

test('A: decodeAttrValue handles INT16 and empty STRING payloads', () => {
  const rec = { type: BLOBMSG_TYPE.INT16, payload: Buffer.from([0xff, 0xfe]) };
  assert.equal(decodeAttrValue(rec), -2);
  assert.equal(decodeAttrValue({ type: BLOBMSG_TYPE.STRING, payload: Buffer.alloc(0) }), '');
});

// ================================================================= B. frames
test('B5: 1-byte, 3-byte, 12-byte and half splits all reassemble', () => {
  const frame = encodeFrame(UBUS_MSG.INVOKE, 7, 5, [
    i32Attr(UBUS_ATTR.OBJID, 5),
    sAttr(UBUS_ATTR.METHOD, 'status'),
    dAttr({}),
  ]);
  for (const chunkSize of [1, 3, 12, Math.floor(frame.length / 2)]) {
    const parser = new UbusFrameParser();
    const got = [];
    for (let i = 0; i < frame.length; i += chunkSize) {
      got.push(...parser.push(frame.subarray(i, i + chunkSize)));
    }
    assert.equal(got.length, 1);
    assert.equal(got[0].type, UBUS_MSG.INVOKE);
    assert.equal(got[0].seq, 7);
    assert.equal(got[0].peer, 5);
    assert.equal(got[0].attrs.length, 3);
  }
});

test('B5/B6: coalesced messages split apart; incomplete header yields nothing', () => {
  const f1 = encodeFrame(UBUS_MSG.DATA, 1, 5, [dAttr({ a: 1 })]);
  const f2 = encodeFrame(UBUS_MSG.STATUS, 1, 5, [i32Attr(UBUS_ATTR.STATUS, 0)]);
  const parser = new UbusFrameParser();
  assert.deepEqual(parser.push(Buffer.concat([f1, f2])).map((m) => m.type), [UBUS_MSG.DATA, UBUS_MSG.STATUS]);
  const p2 = new UbusFrameParser();
  assert.deepEqual(p2.push(f1.subarray(0, 12)), []); // header only: no message yet
  const rest = p2.push(f1.subarray(12));
  assert.equal(rest.length, 1);
  assert.equal(rest[0].type, UBUS_MSG.DATA);
});

test('B4: bad version and over-limit outer length are rejected', () => {
  const frame = encodeFrame(UBUS_MSG.DATA, 1, 0, [dAttr({})]);
  const badVersion = Buffer.from(frame);
  badVersion[0] = 1;
  assert.throws(() => new UbusFrameParser().push(badVersion), /version/);
  const badLen = Buffer.from(frame);
  badLen.writeUInt32BE(0x00200000, 8); // outer length 2 MiB > 1 MiB
  assert.throws(() => new UbusFrameParser().push(badLen), /exceeds UBUS_MAX_MSGLEN/);
  // Inner attribute length overrunning the frame.
  const badInner = Buffer.from(frame);
  badInner.writeUInt32BE(0x0000ffff, 12); // first inner attr claims 64 KiB
  assert.throws(() => new UbusFrameParser().push(badInner), /truncated/);
});

// ------------------------------------------------------- fake ubusd (C/D)
// AF_UNIX 在部分环境（如受限的 Windows 主机）被禁止，ubus 那组用例需要真实
// unix socket，因此先探测能力，不可用就跳过而不是伪装通过。
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
const skipNoUnix = (t) => t.skip('AF_UNIX socket unavailable in this environment');
function startFakeUbusd() {
  const dir = mkdtempSync(join(os.tmpdir(), 'fake-ubusd-'));
  const sockPath = join(dir, 'ubus.sock');
  const received = []; // every frame received from the client
  const sockets = new Set();
  let mode = 'normal'; // or 'silent' (never answer INVOKE, for timeout tests)
  const server = net.createServer((socket) => {
    sockets.add(socket);
    const parser = new UbusFrameParser();
    socket.write(encodeFrame(UBUS_MSG.HELLO, 0, 0x1234, []));
    socket.on('data', (chunk) => {
      let messages = [];
      try {
        messages = parser.push(chunk);
      } catch (_e) {
        socket.destroy();
        return;
      }
      for (const msg of messages) {
        received.push(msg);
        handle(socket, msg);
      }
    });
    socket.on('close', () => sockets.delete(socket));
  });
  function send(socket, type, seq, peer, attrs) {
    socket.write(encodeFrame(type, seq, peer, attrs));
  }
  function handle(socket, msg) {
    const byId = new Map(msg.attrs.map((a) => [a.id, a]));
    const objid = byId.has(UBUS_ATTR.OBJID) ? byId.get(UBUS_ATTR.OBJID).payload.readInt32BE(0) : 0;
    if (msg.type === UBUS_MSG.LOOKUP) {
      const pathAttr = byId.get(UBUS_ATTR.OBJPATH);
      const path = pathAttr
        ? pathAttr.payload.subarray(0, pathAttr.payload.length - 1).toString('utf8')
        : null;
      if (path === 'network.interface.lan') {
        send(socket, UBUS_MSG.DATA, msg.seq, 0, [
          i32Attr(UBUS_ATTR.OBJID, 5),
          sAttr(UBUS_ATTR.OBJPATH, 'network.interface.lan'),
          i32Attr(UBUS_ATTR.OBJTYPE, 0),
        ]);
        send(socket, UBUS_MSG.STATUS, msg.seq, 0, [i32Attr(UBUS_ATTR.STATUS, 0)]);
      } else {
        send(socket, UBUS_MSG.STATUS, msg.seq, 0, [i32Attr(UBUS_ATTR.STATUS, UBUS_STATUS.NOT_FOUND)]);
      }
      return;
    }
    if (msg.type === UBUS_MSG.ADD_OBJECT) {
      send(socket, UBUS_MSG.DATA, msg.seq, 0, [i32Attr(UBUS_ATTR.OBJID, 42), i32Attr(UBUS_ATTR.OBJTYPE, 0)]);
      send(socket, UBUS_MSG.STATUS, msg.seq, 0, [i32Attr(UBUS_ATTR.STATUS, 0)]);
      return;
    }
    if (msg.type === UBUS_MSG.REMOVE_OBJECT) {
      send(socket, UBUS_MSG.STATUS, msg.seq, 0, [i32Attr(UBUS_ATTR.STATUS, 0)]);
      return;
    }
    if (msg.type === UBUS_MSG.INVOKE) {
      if (mode === 'silent') return;
      const method = byId.has(UBUS_ATTR.METHOD)
        ? byId.get(UBUS_ATTR.METHOD).payload.subarray(0, byId.get(UBUS_ATTR.METHOD).payload.length - 1).toString('utf8')
        : '';
      const data = byId.has(UBUS_ATTR.DATA) ? decode(byId.get(UBUS_ATTR.DATA).payload) : {};
      if (objid === 5 && method === 'status') {
        send(socket, UBUS_MSG.DATA, msg.seq, 5, [i32Attr(UBUS_ATTR.OBJID, 5), dAttr({ interface: 'lan', up: true })]);
        send(socket, UBUS_MSG.STATUS, msg.seq, 5, [i32Attr(UBUS_ATTR.OBJID, 5), i32Attr(UBUS_ATTR.STATUS, 0)]);
      } else if (objid === 5 && method === 'echo') {
        // Deliberately answer out of order: higher n answers first.
        const delay = Math.max(0, (6 - (data.n ?? 1)) * 10);
        setTimeout(() => {
          if (socket.destroyed) return;
          send(socket, UBUS_MSG.DATA, msg.seq, 5, [i32Attr(UBUS_ATTR.OBJID, 5), dAttr({ n: data.n })]);
          send(socket, UBUS_MSG.STATUS, msg.seq, 5, [i32Attr(UBUS_ATTR.OBJID, 5), i32Attr(UBUS_ATTR.STATUS, 0)]);
        }, delay);
      } else {
        send(socket, UBUS_MSG.STATUS, msg.seq, objid, [
          i32Attr(UBUS_ATTR.OBJID, objid),
          i32Attr(UBUS_ATTR.STATUS, UBUS_STATUS.NOT_FOUND),
        ]);
      }
      return;
    }
    // Other message types: ignore (server side has no subscriptions).
  }
  return {
    dir,
    sockPath,
    received,
    sockets,
    setMode(m) { mode = m; },
    listen: () => new Promise((resolve) => server.listen(sockPath, resolve)),
    close: () => new Promise((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => { rmSync(dir, { recursive: true, force: true }); resolve(); });
    }),
    // Send a server-initiated INVOKE to the connected client (for D).
    sendInvokeToClient(method, data, seq = 77) {
      for (const socket of sockets) {
        socket.write(encodeFrame(UBUS_MSG.INVOKE, seq, 0x1234, [
          i32Attr(UBUS_ATTR.OBJID, 42),
          sAttr(UBUS_ATTR.METHOD, method),
          dAttr(data),
        ]));
      }
    },
    destroySockets() { for (const s of sockets) s.destroy(); },
  };
}

// ================================================================= C. local ubus
test('C7: HELLO first, local_id from hdr.peer', async (t) => {
  if (!AF_UNIX_OK) return skipNoUnix(t);
  const fake = startFakeUbusd();
  await fake.listen();
  t.after(() => fake.close());
  const client = await UbusClient.connect(fake.sockPath);
  t.after(() => client.close());
  assert.equal(client.localId, 0x1234);
  assert.equal(client.connected, true);
});

test('C8/C9: LOOKUP then INVOKE, DATA + STATUS, values match', async (t) => {
  if (!AF_UNIX_OK) return skipNoUnix(t);
  const fake = startFakeUbusd();
  await fake.listen();
  t.after(() => fake.close());
  const client = await UbusClient.connect(fake.sockPath);
  t.after(() => client.close());
  const found = await client.lookup('network.interface.lan');
  assert.deepEqual(found, [{ id: 5, path: 'network.interface.lan', type: 0, signature: null }]);
  const res = await client.invoke(5, 'status', {});
  assert.equal(res.status, 0);
  assert.deepEqual(res.data, { interface: 'lan', up: true });
  assert.equal(res.dataList.length, 1);
  // call() does lookup + invoke and returns just the data.
  const data = await client.call('network.interface.lan', 'status', {});
  assert.deepEqual(data, { interface: 'lan', up: true });
});

test('C10: concurrent invokes with out-of-order responses match by (seq, peer)', async (t) => {
  if (!AF_UNIX_OK) return skipNoUnix(t);
  const fake = startFakeUbusd();
  await fake.listen();
  t.after(() => fake.close());
  const client = await UbusClient.connect(fake.sockPath);
  t.after(() => client.close());
  const results = await Promise.all(
    [1, 2, 3, 4, 5].map((n) => client.invoke(5, 'echo', { n }, { timeout: 5000 })),
  );
  assert.deepEqual(results.map((r) => r.data.n), [1, 2, 3, 4, 5]);
});

test('C10: NOT_FOUND status resolves on invoke, throws on call, others unaffected', async (t) => {
  if (!AF_UNIX_OK) return skipNoUnix(t);
  const fake = startFakeUbusd();
  await fake.listen();
  t.after(() => fake.close());
  const client = await UbusClient.connect(fake.sockPath);
  t.after(() => client.close());
  const res = await client.invoke(99, 'nope', {});
  assert.equal(res.status, UBUS_STATUS.NOT_FOUND);
  assert.equal(res.data, null);
  await assert.rejects(
    client.call('network.interface.lan', 'missing_method', {}),
    (e) => e instanceof UbusError && e.status === UBUS_STATUS.NOT_FOUND,
  );
  // The client still works afterwards.
  assert.deepEqual(await client.call('network.interface.lan', 'status', {}), { interface: 'lan', up: true });
});

test('C: request timeout rejects with UbusError status TIMEOUT', async (t) => {
  if (!AF_UNIX_OK) return skipNoUnix(t);
  const fake = startFakeUbusd();
  fake.setMode('silent');
  await fake.listen();
  t.after(() => fake.close());
  const client = await UbusClient.connect(fake.sockPath);
  t.after(() => client.close());
  await assert.rejects(
    client.invoke(5, 'status', {}, { timeout: 100 }),
    (e) => e instanceof UbusError && e.status === UBUS_STATUS.TIMEOUT,
  );
});

test('C/E15: disconnect settles pending requests and emits close exactly once', async (t) => {
  if (!AF_UNIX_OK) return skipNoUnix(t);
  const fake = startFakeUbusd();
  fake.setMode('silent');
  await fake.listen();
  t.after(() => fake.close());
  const client = await UbusClient.connect(fake.sockPath);
  let closes = 0;
  client.on('close', () => { closes++; });
  const pending = assert.rejects(
    client.invoke(5, 'status', {}, { timeout: 10000 }),
    (e) => e instanceof UbusError && e.status === UBUS_STATUS.CONNECTION_FAILED,
  );
  setTimeout(() => fake.destroySockets(), 50);
  await pending;
  await waitFor(() => closes === 1);
  assert.equal(closes, 1);
  assert.equal(client.connected, false);
  client.close();
  assert.equal(closes, 1); // second close() is a no-op
});

// ================================================================= D. publish
test('D11: ADD_OBJECT returns an id; inbound INVOKE dispatches to the handler', async (t) => {
  if (!AF_UNIX_OK) return skipNoUnix(t);
  const fake = startFakeUbusd();
  await fake.listen();
  t.after(() => fake.close());
  const client = await UbusClient.connect(fake.sockPath);
  t.after(() => client.close());
  const added = await client.addObject('wifiroam', {
    ping: { handler: (req) => ({ pong: req.data.n }), args: { n: 'int' } },
  });
  assert.equal(added.id, 42);
  // The SIGNATURE sent for ADD_OBJECT describes ping(n: int32 = 5).
  const addMsg = fake.received.find((m) => m.type === UBUS_MSG.ADD_OBJECT);
  assert.ok(addMsg);
  const sigAttr = addMsg.attrs.find((a) => a.id === UBUS_ATTR.SIGNATURE);
  assert.ok(sigAttr);
  assert.deepEqual(decode(sigAttr.payload), { ping: { n: 5 } });

  fake.sendInvokeToClient('ping', { n: 1 }, 77);
  await waitFor(() => {
    const datas = fake.received.filter((m) => m.type === UBUS_MSG.DATA && m.seq === 77);
    return datas.length === 1 && decode(datas[0].attrs.find((a) => a.id === UBUS_ATTR.DATA).payload).pong === 1;
  });
  const statuses = fake.received.filter((m) => m.type === UBUS_MSG.STATUS && m.seq === 77);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].attrs.find((a) => a.id === UBUS_ATTR.STATUS).payload.readInt32BE(0), 0);
  // Unknown method on the published object -> NOT_FOUND status, no DATA.
  fake.sendInvokeToClient('nope', {}, 78);
  await waitFor(() => fake.received.some((m) => m.type === UBUS_MSG.STATUS && m.seq === 78));
  assert.equal(fake.received.filter((m) => m.type === UBUS_MSG.DATA && m.seq === 78).length, 0);
});

test('D12: REMOVE_OBJECT by path resolves status 0', async (t) => {
  if (!AF_UNIX_OK) return skipNoUnix(t);
  const fake = startFakeUbusd();
  await fake.listen();
  t.after(() => fake.close());
  const client = await UbusClient.connect(fake.sockPath);
  t.after(() => client.close());
  await client.addObject('wifiroam', { ping: () => ({}) });
  assert.equal(await client.removeObject('wifiroam'), 0);
  assert.equal(await client.removeObject('wifiroam'), UBUS_STATUS.NOT_FOUND); // already gone
});

test('D13: handler returning UBUS_NO_REPLY sends no DATA and no STATUS (silent drop)', async (t) => {
  if (!AF_UNIX_OK) return skipNoUnix(t);
  const fake = startFakeUbusd();
  await fake.listen();
  t.after(() => fake.close());
  const client = await UbusClient.connect(fake.sockPath);
  t.after(() => client.close());
  await client.addObject('wifiroam', {
    ping: () => ({ pong: true }),
    silent: () => UBUS_NO_REPLY,
  });
  // Silent method: no reply frame at all within 300ms.
  fake.sendInvokeToClient('silent', {}, 81);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(fake.received.filter((m) => (m.type === UBUS_MSG.DATA || m.type === UBUS_MSG.STATUS) && m.seq === 81).length, 0);
  // The object is still alive: a normal method answers afterwards.
  fake.sendInvokeToClient('ping', {}, 82);
  await waitFor(() => fake.received.some((m) => m.type === UBUS_MSG.STATUS && m.seq === 82));
  assert.equal(fake.received.filter((m) => m.type === UBUS_MSG.DATA && m.seq === 82).length, 1);
});

// ================================================================= E. channel
test('E13: two Node ends over TCP, no HELLO, local_id 1, peer 0, both directions', async (t) => {
  let firstByteType = null;
  let helloSeen = false;
  let serverChannel = null;
  const serverSockets = new Set();
  const server = net.createServer((socket) => {
    serverSockets.add(socket);
    socket.on('close', () => serverSockets.delete(socket));
    serverChannel = UbusChannel.fromSocket(socket);
    socket.once('data', (chunk) => { firstByteType = chunk[1]; });
    serverChannel.setRequestHandler(async (req) => {
      if (req.method === 'hello') return { ok: true, role: 'cap' };
      if (req.method === 'auth') return { ok: true, alias_ver: 3 };
      return { ok: false, error: 'unknown_method' };
    });
    serverChannel.on('hello', () => { helloSeen = true; });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    for (const s of serverSockets) s.destroy();
    server.close(resolve);
  }));
  const port = server.address().port;

  const client = await UbusChannel.connect('127.0.0.1', port);
  t.after(() => client.close());
  assert.equal(client.localId, 1);
  client.setRequestHandler(async (req) => {
    if (req.method === 'push_aliases') return { ok: true, ver: req.data.ver };
    return { ok: false };
  });

  const hello = await client.request('hello', { mac: 'aabbccddeeff', role: 'sap', nonce: '0123456789abcdef' });
  assert.equal(hello.status, 0);
  assert.deepEqual(hello.data, { ok: true, role: 'cap' });
  const auth = await client.defer('auth', { mac: 'aabbccddeeff', digest: 'x' });
  assert.equal(auth.data.alias_ver, 3);

  // Server-initiated call to the client (reverse direction).
  await waitFor(() => serverChannel !== null);
  const push = await serverChannel.request('push_aliases', { ver: 9 });
  assert.equal(push.status, 0);
  assert.deepEqual(push.data, { ok: true, ver: 9 });

  // No HELLO was ever exchanged: first byte on the wire is INVOKE (5).
  assert.equal(firstByteType, UBUS_MSG.INVOKE);
  assert.equal(helloSeen, false);
});

test('E13: fire-and-forget request (return:"ignore") sends NO_REPLY and resolves at once', async (t) => {
  let sawNoReply = false;
  const serverSockets = new Set();
  const server = net.createServer((socket) => {
    serverSockets.add(socket);
    socket.on('close', () => serverSockets.delete(socket));
    const parser = new UbusFrameParser();
    socket.on('data', (chunk) => {
      for (const msg of parser.push(chunk)) {
        if (msg.attrs.some((a) => a.id === UBUS_ATTR.NO_REPLY)) sawNoReply = true;
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    for (const s of serverSockets) s.destroy();
    server.close(resolve);
  }));
  const client = await UbusChannel.connect('127.0.0.1', server.address().port);
  t.after(() => client.close());
  const res = await client.request('report_event', { etype: 'x' }, { noReply: true });
  assert.equal(res.status, 0);
  await waitFor(() => sawNoReply);
  assert.equal(sawNoReply, true);
});

test('E14: channel handler returning UBUS_NO_REPLY leaves the caller hanging until timeout', async (t) => {
  const serverSockets = new Set();
  let serverChannel = null;
  const server = net.createServer((socket) => {
    serverSockets.add(socket);
    socket.on('close', () => serverSockets.delete(socket));
    serverChannel = UbusChannel.fromSocket(socket);
    serverChannel.setRequestHandler(async (req) => {
      if (req.method === 'silent') return UBUS_NO_REPLY;
      if (req.method === 'ping') return { pong: true };
      return { ok: false };
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    for (const s of serverSockets) s.destroy();
    server.close(resolve);
  }));
  const client = await UbusChannel.connect('127.0.0.1', server.address().port);
  t.after(() => client.close());
  await waitFor(() => serverChannel !== null);
  // Silent method: nothing comes back, the call times out (UBUS_TIMEOUT).
  await assert.rejects(
    client.request('silent', {}, { timeout: 150 }),
    (e) => e instanceof UbusError && e.code === 'UBUS_TIMEOUT',
  );
  // The channel is still usable afterwards.
  const pong = await client.request('ping', {});
  assert.equal(pong.status, 0);
  assert.deepEqual(pong.data, { pong: true });
});

test('E15: channel disconnect settles pending and emits close once', async (t) => {
  const serverSockets = new Set();
  const server = net.createServer((socket) => {
    serverSockets.add(socket);
    socket.on('close', () => serverSockets.delete(socket));
    // Never answer; hold the connection until the test kills it.
    socket.on('data', () => {});
    setTimeout(() => socket.destroy(), 50);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    for (const s of serverSockets) s.destroy();
    server.close(resolve);
  }));
  const client = await UbusChannel.connect('127.0.0.1', server.address().port);
  let closes = 0;
  client.on('close', () => { closes++; });
  await assert.rejects(
    client.request('never', {}, { timeout: 10000 }),
    (e) => e instanceof UbusError && e.status === UBUS_STATUS.CONNECTION_FAILED,
  );
  await waitFor(() => closes === 1);
  assert.equal(closes, 1);
});

// ================================================================= util
test('util: macnorm / maccolon / devnorm / macIsRandom', () => {
  assert.equal(macnorm('AA:BB-CC.dd EE ff'), 'aabbccddeeff');
  assert.equal(macnorm(null), '');
  assert.equal(macnorm(''), '');
  assert.equal(maccolon('aabbccddeeff'), 'AA:BB:CC:DD:EE:FF');
  assert.equal(maccolon('aabbcc'), 'aabbcc'); // not 12 hex: returned as-is
  assert.equal(maccolon(null), null);
  assert.equal(devnorm('g0123456789ab'), 'g0123456789ab');
  assert.equal(devnorm('AA-BB-CC-DD-EE-FF'), 'aabbccddeeff');
  assert.equal(macIsRandom('02aabbccddee'), true);
  assert.equal(macIsRandom('aabbaabbccdd'), true); // second digit 'a'
  assert.equal(macIsRandom('00aabbccddee'), false); // second digit '0'
});

test('util: xorshift32 is deterministic and randhex is hex', () => {
  srand(12345);
  const a = [rand(), rand(), rand(), randhex(16)];
  srand(12345);
  const b = [rand(), rand(), rand(), randhex(16)];
  assert.deepEqual(a, b);
  assert.match(a[3], /^[0-9a-f]{16}$/);
  assert.ok(a.slice(0, 3).every((v) => Number.isInteger(v) && v >= 0 && v <= 0x7fffffff));
  srand(0); // 0 seed is replaced by 0x9e3779b9
  const c = rand();
  srand(0);
  assert.equal(rand(), c);
});

test('util: log writes "wifiroam: <msg>" to the log writer', () => {
  const lines = [];
  setLogWriter((s) => lines.push(s));
  try {
    log('started role=cap');
    assert.deepEqual(lines, ['wifiroam: started role=cap\n']);
  } finally {
    setLogWriter(null);
  }
});

test('util: fieldAfter / hhmmMinutes / nowMinutes / toInt', () => {
  assert.equal(fieldAfter(['a', 'b', 'c'], 'a'), 'b');
  assert.equal(fieldAfter(['a', 'b', 'c'], 'c'), null);
  assert.equal(fieldAfter(['a'], 'z'), null);
  assert.equal(fieldAfter('not-array', 'a'), null);
  assert.equal(hhmmMinutes('08:00'), 480);
  assert.equal(hhmmMinutes('23:59'), 1439);
  assert.equal(hhmmMinutes('00:00'), 0);
  assert.equal(hhmmMinutes('24:00'), null);
  assert.equal(hhmmMinutes('12:60'), null);
  assert.equal(hhmmMinutes('8:5'), 485);
  assert.equal(hhmmMinutes(''), null);
  assert.equal(hhmmMinutes('ab'), null);
  assert.equal(hhmmMinutes('12:30:00'), null);
  assert.equal(nowMinutes('22:30'), 1350);
  assert.equal(nowMinutes(' 07:05 '), 425);
  assert.equal(nowMinutes('bogus'), 0);
  assert.equal(toInt('08'), 8);
  assert.equal(toInt(''), 0);
  assert.equal(toInt('ab'), 0);
  assert.equal(toInt('-3'), -3);
  assert.equal(toInt(3.9), 3);
  assert.equal(toInt(null), 0);
});

test('util: maskPrefix / ipv4Cidr (verbatim, reversed octets kept)', () => {
  assert.equal(maskPrefix('24'), 24);
  assert.equal(maskPrefix(undefined), 24);
  assert.equal(maskPrefix('255.255.255.0'), 24);
  assert.equal(maskPrefix('255.255.0.0'), 16);
  assert.equal(maskPrefix('255.255.255.128'), 25);
  assert.equal(maskPrefix('255.255.255.255'), 32);
  assert.equal(maskPrefix('255.0.255.0'), 8); // stops at the first 0 bit
  assert.equal(ipv4Cidr('192.168.0.1', '255.255.255.0'), '192.168.0.0/24');
  assert.equal(ipv4Cidr('10.0.0.5/24'), '10.0.0.0/24');
  assert.equal(ipv4Cidr('192.168.1.130', '255.255.255.128'), '192.168.1.128/25');
});

test('util: sha256 matches digest.sha256 (hex)', () => {
  assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.match(sha256('wifiroam:token'), /^[0-9a-f]{64}$/);
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('util: pick / asList', () => {
  assert.equal(pick(['192.168.1.1', '10.0.0.1']), '192.168.1.1');
  assert.equal(pick('192.168.1.1'), '192.168.1.1');
  assert.equal(pick(undefined), undefined);
  assert.deepEqual(asList(['a']), ['a']);
  assert.deepEqual(asList('a'), ['a']);
  assert.deepEqual(asList(''), []);
  assert.deepEqual(asList(null), []);
});

// ================================================================= shell
test('shell: cmdOutput returns stdout, "" on runner failure or empty command', () => {
  const seen = [];
  setCommandRunner((cmd) => { seen.push(cmd); return 'out\n'; });
  try {
    assert.equal(cmdOutput('iw dev 2>/dev/null'), 'out\n');
    assert.deepEqual(seen, ['iw dev 2>/dev/null']);
  } finally {
    resetCommandRunner();
  }
  setCommandRunner(() => { throw new Error('boom'); });
  try {
    assert.equal(cmdOutput('anything'), '');
  } finally {
    resetCommandRunner();
  }
  assert.equal(cmdOutput(''), '');
});

test('shell: command literals match spec §7.3 verbatim', () => {
  assert.equal(shellCommands.dpiPid(), 'pidof wifiroam-dpi 2>/dev/null');
  assert.equal(shellCommands.dpiPidCheck('1234'), 'kill -0 1234 2>/dev/null && echo 1');
  assert.equal(shellCommands.dpiKillHup('1234'), 'kill -HUP 1234 2>/dev/null');
  assert.equal(shellCommands.dpiStart(), '/usr/sbin/wifiroam-dpi & echo $! > /tmp/wifiroam-dpi.pid');
  assert.equal(shellCommands.nftApplyFile('/tmp/wifiroam-appctl.nft'), 'nft -f /tmp/wifiroam-appctl.nft 2>/dev/null');
  assert.equal(shellCommands.nftListTableJson('wifiroam'), 'nft -j list table inet wifiroam 2>/dev/null');
  assert.equal(shellCommands.nslookupWarm('www.douyin.com'), 'timeout 3 nslookup www.douyin.com 127.0.0.1 >/dev/null 2>&1');
  assert.equal(shellCommands.iwStationDump('phy0-ap0'), 'iw dev phy0-ap0 station dump 2>/dev/null');
  assert.equal(shellCommands.dateHm(), 'date +%H:%M');
  assert.equal(shellCommands.wifiReloadDelayed(), '( sleep 2; /sbin/wifi reload >/dev/null 2>&1 ) >/dev/null 2>&1 & echo ok');
  assert.equal(shellCommands.wpadApk(), `apk list --installed 2>/dev/null | awk '{print $1}' | grep -E '^wpad' | head -1`);
  assert.equal(shellCommands.wpadOpkg(), `opkg list-installed 2>/dev/null | grep -E '^wpad' | head -1`);
  assert.deepEqual(PROC.wifiReload, ['/sbin/wifi', ['reload']]);
  assert.deepEqual(PROC.dnsmasqReload, ['/etc/init.d/dnsmasq', ['reload']]);
});

test('shell: runProcess resolves the exit code, null on bad path or timeout', async () => {
  assert.equal(await runProcess(process.execPath, ['-e', 'process.exit(3)']), 3);
  assert.equal(await runProcess(process.execPath, ['-e', 'process.exit(0)']), 0);
  assert.equal(await runProcess('/nonexistent/binary-xyz', []), null);
  assert.equal(
    await runProcess(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { timeout: 100 }),
    null,
  );
});

test('shell: runShellAsync collects stdout/stderr and the exit code', async (t) => {
  if (process.platform === 'win32') return t.skip('/bin/sh is not available on win32');
  const ok = await runShellAsync('echo hi');
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout, 'hi\n');
  const fail = await runShellAsync('echo err 1>&2; exit 7');
  assert.equal(fail.code, 7);
  assert.equal(fail.stderr, 'err\n');
});

// ================================================================= uci
const SHOW_FIXTURE = [
  'wifiroam.core=globals',
  "wifiroam.core.enabled='1'",
  "wifiroam.core.role='cap'",
  "wifiroam.core.token=''",
  'wifiroam.roam=roam',
  "wifiroam.roam.enabled='1'",
  "wifiroam.roam.ssids='a-ssid' 'b-ssid'",
  'wifiroam.cfg0a1b2c3=appdev',
  "wifiroam.cfg0a1b2c3.mac='aabbccddeeff'",
  "wifiroam.cfg0a1b2c3.block='wechat' 'douyin'",
  'wifiroam.cfg0a1b2c4=appdev',
  "wifiroam.cfg0a1b2c4.mac='112233445566'",
  '',
].join('\n');

function fakeUciRunner() {
  const seen = [];
  const runner = (argv) => {
    seen.push(argv);
    const [cmd, ...rest] = argv;
    if (cmd === 'show') return { code: 0, stdout: SHOW_FIXTURE };
    if (cmd === 'add') return { code: 0, stdout: 'cfg0a1b2c9\n' };
    if (cmd === 'set' || cmd === 'delete' || cmd === 'add_list' || cmd === 'commit') {
      return { code: 0, stdout: '' };
    }
    return { code: 1, stdout: '' };
  };
  runner.seen = seen;
  return runner;
}

test('uci: parseShow handles sections, scalars and list options', () => {
  const secs = parseShow(SHOW_FIXTURE);
  assert.equal(secs.length, 4);
  assert.equal(secs[0]['.name'], 'core');
  assert.equal(secs[0]['.type'], 'globals');
  assert.equal(secs[0].role, 'cap');
  assert.deepEqual(secs[1].ssids, ['a-ssid', 'b-ssid']);
  assert.deepEqual(secs[2].block, ['wechat', 'douyin']);
});

test('uci: get scalar/list/section, missing -> null, getList always array', () => {
  const client = new UciClient({ runner: fakeUciRunner() });
  assert.equal(client.get('wifiroam', 'core', 'role'), 'cap');
  assert.equal(client.get('wifiroam', 'core', 'missing'), null);
  assert.equal(client.get('wifiroam', 'nosuch', 'role'), null);
  assert.deepEqual(client.get('wifiroam', 'roam', 'ssids'), ['a-ssid', 'b-ssid']);
  assert.deepEqual(client.getList('wifiroam', 'roam', 'ssids'), ['a-ssid', 'b-ssid']);
  assert.deepEqual(client.getList('wifiroam', 'core', 'role'), ['cap']);
  assert.deepEqual(client.getList('wifiroam', 'core', 'missing'), []);
  const sec = client.get('wifiroam', 'core');
  assert.equal(sec['.name'], 'core');
  assert.equal(sec['.type'], 'globals');
  assert.equal(sec.enabled, '1');
});

test('uci: foreach visits only the requested type and returns the count', () => {
  const client = new UciClient({ runner: fakeUciRunner() });
  const macs = [];
  const n = client.foreach('wifiroam', 'appdev', (s) => macs.push(s.mac));
  assert.equal(n, 2);
  assert.deepEqual(macs, ['aabbccddeeff', '112233445566']);
  assert.equal(client.foreach('wifiroam', 'nosuchtype', () => {}), 0);
});

test('uci: set/add/delete/commit argv and failure booleans', () => {
  const runner = fakeUciRunner();
  const client = new UciClient({ runner });
  assert.equal(client.set('wifiroam', 'core', 'role', 'cap'), true);
  assert.deepEqual(runner.seen.at(-1), ['set', 'wifiroam.core.role=cap']);
  // 3-argument form creates a named section of a type.
  assert.equal(client.set('wifiroam', 'schedule', 'schedule'), true);
  assert.deepEqual(runner.seen.at(-1), ['set', 'wifiroam.schedule=schedule']);
  // List value: delete + one add_list per element.
  assert.equal(client.set('wifiroam', 'roam', 'ssids', ['a', 'b']), true);
  assert.deepEqual(runner.seen.slice(-3), [
    ['delete', 'wifiroam.roam.ssids'],
    ['add_list', 'wifiroam.roam.ssids=a'],
    ['add_list', 'wifiroam.roam.ssids=b'],
  ]);
  assert.equal(client.add('wifiroam', 'appdev'), 'cfg0a1b2c9');
  assert.deepEqual(runner.seen.at(-1), ['add', 'wifiroam', 'appdev']);
  assert.equal(client.delete('wifiroam', 'cfg0a1b2c3'), true);
  assert.equal(client.delete('wifiroam', 'cfg0a1b2c3', 'block'), true);
  assert.equal(client.commit('wifiroam'), true);
  assert.equal(client.load('wifiroam'), true);

  const failing = new UciClient({ runner: () => ({ code: 1, stdout: '' }) });
  assert.equal(failing.set('wifiroam', 'core', 'role', 'cap'), false);
  assert.equal(failing.add('wifiroam', 'appdev'), null);
  assert.equal(failing.delete('wifiroam', 'x'), false);
  assert.equal(failing.commit('wifiroam'), false);
  assert.equal(failing.get('wifiroam', 'core', 'role'), null);
  assert.equal(failing.foreach('wifiroam', 'appdev', () => {}), 0);
});

// ================================================================= store
test('store: aliases load defaults, roundtrip, invalid JSON -> defaults, atomic write', (t) => {
  const dir = mkdtempSync(join(os.tmpdir(), 'wifiroam-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'aliases.json');
  assert.deepEqual(loadAliases(path), defaultAliases());
  const aliases = {
    ver: 1700000000,
    map: { aabbccddeeff: { name: 'Phone', icon: null, note: 'x' } },
    groups: { g0123456789ab: { members: { aabbccddeeff: true } } },
    redirect: { g111111111111: 'g0123456789ab' },
    isolated: { aabbccddeeff: true },
    pin: { aabbccddeeff: '001122334455' },
  };
  assert.equal(saveAliases(path, aliases), true);
  assert.deepEqual(loadAliases(path), aliases);
  assert.deepEqual(readdirSync(dir).filter((f) => f.includes('.tmp-')), []);
  writeFileSync(path, '{not json');
  assert.deepEqual(loadAliases(path), defaultAliases());
  writeFileSync(path, '[1,2]');
  assert.deepEqual(loadAliases(path), defaultAliases());
});

test('store: appstats shape (ver:1 on save) and devices force-offline on load', (t) => {
  const dir = mkdtempSync(join(os.tmpdir(), 'wifiroam-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statsPath = join(dir, 'appstats.json');
  assert.deepEqual(loadAppStats(statsPath), defaultAppStats());
  const stats = { day: '2026-11-15', stats: { aa: { wechat: { today: 5 } } }, online: {}, ndata: {} };
  assert.equal(saveAppStats(statsPath, stats), true);
  assert.deepEqual(JSON.parse(readFileSync(statsPath, 'utf8')).ver, 1);
  assert.deepEqual(loadAppStats(statsPath), stats);

  const devPath = join(dir, 'devices.json');
  assert.deepEqual(loadDevices(devPath), {});
  writeFileSync(devPath, JSON.stringify({
    g0123456789ab: { mac: 'aa:bb:cc:dd:ee:ff', online: true, first_seen: 1 },
    bad: 'not-an-object',
  }));
  const loaded = loadDevices(devPath);
  assert.equal(loaded.g0123456789ab.online, false); // forced offline on load
  assert.equal(loaded.g0123456789ab.first_seen, 1);
  assert.ok(!('bad' in loaded));
  assert.equal(saveDevices(devPath, loaded), true);
  assert.equal(writeJsonAtomic(join(dir, 'x.json'), { a: 1 }), true);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'x.json'), 'utf8')), { a: 1 });
});

test('store: nft_schema plain text, missing -> null', (t) => {
  const dir = mkdtempSync(join(os.tmpdir(), 'wifiroam-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'nft_schema');
  assert.equal(loadSchema(path), null);
  assert.equal(saveSchema(path, 'abc123'), true);
  assert.equal(loadSchema(path), 'abc123');
});

// ================================================================= F. guard
test('F16: lib/ contains none of the Node-22.23.4-banned APIs', () => {
  const banned = ['Promise.try', 'RegExp.escape', 'Float16Array', 'Error.isError', 'Atomics.pause', 'URLPattern'];
  const dir = fileURLToPath(new URL('../lib/', import.meta.url));
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.js')) continue;
    const src = readFileSync(join(dir, file), 'utf8');
    for (const token of banned) {
      assert.ok(!src.includes(token), `${file} must not use ${token}`);
    }
    // `using` / `await using` declarations (Symbol.dispose itself is allowed).
    assert.ok(!/^\s*using\s+[A-Za-z_$]/m.test(src), `${file} must not use a 'using' declaration`);
    assert.ok(!/await\s+using\s+[A-Za-z_$]/.test(src), `${file} must not use 'await using'`);
  }
});
