// ubus.js -- minimal ubus protocol client (pure JS, no `ubus` CLI).
// Target: Node 22.23.4, core modules only, zero npm dependencies.
// Protocol source: openwrt/ubus libubus-io.c / libubus-req.c /
// libubus-obj.c / ubusd_proto.c and research-node-ubus.md §2.
//
// Frame: 8-byte ubus_msghdr (version=0, type, seq BE16, peer BE32)
//   + one outer blob_attr (id 0, unnamed) whose length field (low 24
//   bits, header included) gives the whole message length. There is NO
//   separate length prefix. One message is at most UBUS_MAX_MSGLEN
//   (1048576) bytes of blob. The stream is byte-oriented: frames are
//   reassembled from arbitrary chunk splits and coalesced writes.
//
// Two modes share this file:
//   * UbusClient -- local ubusd over /var/run/ubus/ubus.sock. The server
//     sends HELLO first; local_id comes from HELLO's hdr.peer (must be
//     > 1); the client never sends HELLO. Requests are matched by the
//     (seq, peer) pair; one call gets 0..n DATA messages + one STATUS.
//   * UbusChannel -- peer-to-peer over a bare TCP socket (the wifiroam
//     CAP<->SAP channel). No HELLO, local_id is fixed 1, request peer
//     is always 0, ADD_OBJECT/LOOKUP are not supported (the server side
//     rejects them with INVALID_ARGUMENT, mirroring libubus).
//
// seq is a client-incremented uint16 starting at 1 (0 is reserved for
// HELLO) and wraps; a pending entry is removed when it settles, so a
// wrapped seq never collides with a live request.

import net from 'node:net';
import { EventEmitter } from 'node:events';
import { BLOBMSG_TYPE, decode, encode, encodeAttr, encodeField, parseAttrs } from './blobmsg.js';

export const UBUS_SOCKET_PATH = '/var/run/ubus/ubus.sock';
export const UBUS_MAX_MSGLEN = 1048576;
export const UBUS_CLIENT_ID_CHANNEL = 1;

export const UBUS_MSG = Object.freeze({
  HELLO: 0,
  STATUS: 1,
  DATA: 2,
  PING: 3,
  LOOKUP: 4,
  INVOKE: 5,
  ADD_OBJECT: 6,
  REMOVE_OBJECT: 7,
  SUBSCRIBE: 8,
  UNSUBSCRIBE: 9,
  NOTIFY: 10,
  MONITOR: 11,
});

export const UBUS_ATTR = Object.freeze({
  UNSPEC: 0,
  STATUS: 1,
  OBJPATH: 2,
  OBJID: 3,
  METHOD: 4,
  OBJTYPE: 5,
  SIGNATURE: 6,
  DATA: 7,
  TARGET: 8,
  ACTIVE: 9,
  NO_REPLY: 10,
  SUBSCRIBERS: 11,
  USER: 12,
  GROUP: 13,
});

export const UBUS_STATUS = Object.freeze({
  OK: 0,
  INVALID_COMMAND: 1,
  INVALID_ARGUMENT: 2,
  METHOD_NOT_FOUND: 3,
  NOT_FOUND: 4,
  NO_DATA: 5,
  PERMISSION_DENIED: 6,
  TIMEOUT: 7,
  NOT_SUPPORTED: 8,
  UNKNOWN_ERROR: 9,
  CONNECTION_FAILED: 10,
  NO_MEMORY: 11,
  PARSE_ERROR: 12,
  SYSTEM_ERROR: 13,
});

// 无回执哨兵：方法 handler 返回（或 resolve 为）此值时，本端对该 INVOKE
// 不发任何回包——既不发 DATA 也不发 STATUS，对端 defer 挂起直至超时。
// 用途是复刻原版对未认证/未知方法请求的静默丢弃（见 INTERFACE.md §8
// 与 README 未等价项）。与 NO_REPLY 请求不同：NO_REPLY 是调用方声明
// “不要回执”；哨兵是被调方决定“不回执”。注意：handler 一旦调过
// req.reply() 再返回哨兵，已发出的 DATA 无法收回，只是不再补 STATUS，
// 因此哨兵只应在未调 reply() 时返回。未知方法且无 handler 时仍按原有
// 行为回 METHOD_NOT_FOUND / NOT_FOUND（见 _handleInvoke），不静默丢弃。
export const UBUS_NO_REPLY = Symbol('ubus.noReply');

export class UbusError extends Error {
  constructor(status, message) {
    super(message ?? `ubus error ${status}`);
    this.name = 'UbusError';
    this.status = status;
  }
}

// ---------------------------------------------------------- frame codec
// Build one frame: header + outer blob_attr (id 0) wrapping `attrs`
// (each { id, payload: Buffer }). Throws RangeError when the blob
// exceeds UBUS_MAX_MSGLEN.
export function encodeFrame(type, seq, peer, attrs) {
  const inner = Buffer.concat(attrs.map((a) => encodeAttr(a.id, a.payload)));
  const outer = encodeAttr(0, inner);
  if (outer.length > UBUS_MAX_MSGLEN) {
    throw new RangeError(`ubus: message exceeds UBUS_MAX_MSGLEN (${UBUS_MAX_MSGLEN})`);
  }
  const hdr = Buffer.alloc(8);
  hdr[0] = 0;
  hdr[1] = type & 0xff;
  hdr.writeUInt16BE(seq & 0xffff, 2);
  hdr.writeUInt32BE(peer >>> 0, 4);
  return Buffer.concat([hdr, outer]);
}

// Stream reassembler: push() accepts arbitrary chunks and returns the
// list of complete messages parsed from the stream so far. A message is
// produced only once all its bytes have arrived; several messages in
// one chunk are split apart. Throws Error on a bad version, a short
// outer length, a truncated attribute, or an over-limit message -- the
// stream cannot be resynchronised after that (libubus-io.c), so the
// caller must close the connection.
export class UbusFrameParser {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const messages = [];
    for (;;) {
      if (this.buf.length < 12) break;
      const version = this.buf[0];
      if (version !== 0) {
        throw new Error(`ubus: unsupported message version ${version}`);
      }
      const outerLen = this.buf.readUInt32BE(8) & 0x00ffffff;
      if (outerLen < 4) {
        throw new Error(`ubus: outer attribute length ${outerLen} is smaller than its header`);
      }
      if (outerLen > UBUS_MAX_MSGLEN) {
        throw new Error(`ubus: message exceeds UBUS_MAX_MSGLEN (${UBUS_MAX_MSGLEN})`);
      }
      const total = 8 + outerLen;
      if (this.buf.length < total) break;
      const frame = this.buf.subarray(0, total);
      messages.push({
        type: frame[1],
        seq: frame.readUInt16BE(2),
        peer: frame.readUInt32BE(4),
        attrs: parseAttrs(frame, 12, total),
      });
      this.buf = this.buf.subarray(total);
    }
    return messages;
  }
}

// -------------------------------------------------------- attribute help
const strAttr = (id, s) => ({
  id,
  payload: Buffer.concat([Buffer.from(String(s), 'utf8'), Buffer.from([0])]),
});

const int32Attr = (id, v) => {
  const payload = Buffer.alloc(4);
  payload.writeInt32BE(v | 0, 0);
  return { id, payload };
};

const int8Attr = (id, v) => ({ id, payload: Buffer.from([v & 0xff]) });

const dataAttr = (obj) => ({ id: UBUS_ATTR.DATA, payload: encode(obj ?? {}) });
const objIdAttr = (id) => int32Attr(UBUS_ATTR.OBJID, id);
const statusAttr = (code) => int32Attr(UBUS_ATTR.STATUS, code);

function attrString(rec) {
  const p = rec.payload;
  if (p.length === 0) return '';
  return (p[p.length - 1] === 0 ? p.subarray(0, p.length - 1) : p).toString('utf8');
}

function attrInt32(rec) {
  return rec.payload.length >= 4 ? rec.payload.readInt32BE(0) : 0;
}

function attrInt8(rec) {
  return rec.payload.length > 0 ? rec.payload[0] : 0;
}

// The DATA payload of an INVOKE reply is a blobmsg TABLE (named fields).
// A DATA message without a DATA attribute (e.g. a LOOKUP reply) carries
// its fields as message-level attributes instead; those are mapped to
// { objid, objpath, objtype, signature, status }.
function messageData(msg) {
  const byId = new Map();
  for (const a of msg.attrs) if (!byId.has(a.id)) byId.set(a.id, a);
  const dataAttrRec = byId.get(UBUS_ATTR.DATA);
  if (dataAttrRec) return decode(dataAttrRec.payload);
  const out = {};
  const objid = byId.get(UBUS_ATTR.OBJID);
  if (objid) out.objid = attrInt32(objid);
  const objpath = byId.get(UBUS_ATTR.OBJPATH);
  if (objpath) out.objpath = attrString(objpath);
  const objtype = byId.get(UBUS_ATTR.OBJTYPE);
  if (objtype) out.objtype = attrInt32(objtype);
  const sig = byId.get(UBUS_ATTR.SIGNATURE);
  if (sig) out.signature = parseSignature(sig.payload);
  const status = byId.get(UBUS_ATTR.STATUS);
  if (status) out.status = attrInt32(status);
  return out;
}

// SIGNATURE payload: one TABLE per method (named by method), each
// holding INT32 fields named by argument with the blobmsg type code.
function parseSignature(payload) {
  const sig = {};
  if (!payload || payload.length === 0) return sig;
  for (const methodAttr of parseAttrs(payload)) {
    const args = {};
    if (methodAttr.type === BLOBMSG_TYPE.TABLE) {
      for (const arg of parseAttrs(methodAttr.payload)) args[arg.name] = arg.value;
    }
    sig[methodAttr.name] = args;
  }
  return sig;
}

const SIGNATURE_TYPE_CODES = Object.freeze({
  string: BLOBMSG_TYPE.STRING,
  int: BLOBMSG_TYPE.INT32,
  int32: BLOBMSG_TYPE.INT32,
  int64: BLOBMSG_TYPE.INT64,
  int16: BLOBMSG_TYPE.INT16,
  int8: BLOBMSG_TYPE.INT8,
  bool: BLOBMSG_TYPE.BOOL,
  double: BLOBMSG_TYPE.DOUBLE,
  table: BLOBMSG_TYPE.TABLE,
  array: BLOBMSG_TYPE.ARRAY,
});

// Build a SIGNATURE payload from a methods table:
//   { name: fn }                                   -> empty arg table
//   { name: { handler: fn, args: { a: 'string' } } } -> typed arg table
// An explicit signature object ({ method: { arg: typeNameOrCode } })
// may be passed instead; it wins over the derived one.
function buildSignature(methods, explicit) {
  const src = explicit ?? {};
  const fields = [];
  for (const [name, def] of Object.entries(methods)) {
    let args = {};
    if (explicit && Object.prototype.hasOwnProperty.call(explicit, name)) {
      args = explicit[name] ?? {};
    } else if (def && typeof def === 'object' && def.args) {
      args = def.args;
    }
    const argObj = {};
    for (const [argName, argType] of Object.entries(args)) {
      if (typeof argType === 'number') argObj[argName] = argType;
      else if (typeof argType === 'string' && argType in SIGNATURE_TYPE_CODES) argObj[argName] = SIGNATURE_TYPE_CODES[argType];
      else throw new TypeError(`ubus: unknown signature type ${JSON.stringify(argType)} for ${name}.${argName}`);
    }
    fields.push(encodeField(name, argObj));
  }
  return Buffer.concat(fields);
}

// ------------------------------------------------------- shared transport
class UbusConnection extends EventEmitter {
  constructor(socket, { localId = 0, defaultTimeout = 30000, isChannel = false } = {}) {
    super();
    this.socket = socket;
    this.localId = localId;
    this.defaultTimeout = defaultTimeout;
    this.isChannel = isChannel;
    this._parser = new UbusFrameParser();
    this._pending = new Map(); // "seq:peer" -> { resolve, reject, dataList, onData, timer }
    this._seq = 0;
    this._closed = false;
    this._closeEmitted = false;
    this._objects = new Map(); // objId -> { path, methods }
    this._objectsByPath = new Map(); // path -> objId
    this._requestHandler = null; // channel mode: single inbound handler
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', () => { /* 'close' follows; see _onSocketClose */ });
    socket.on('close', () => this._onSocketClose());
  }

  get connected() {
    return !this._closed && !this.socket.destroyed;
  }

  _emitError(err) {
    if (this.listenerCount('error') > 0) this.emit('error', err);
  }

  _nextSeq() {
    this._seq = (this._seq + 1) & 0xffff;
    if (this._seq === 0) this._seq = 1; // 0 is reserved for HELLO
    return this._seq;
  }

  _pendingKey(seq, peer) {
    return `${seq}:${peer >>> 0}`;
  }

  _send(type, seq, peer, attrs) {
    if (this._closed) {
      throw new UbusError(UBUS_STATUS.CONNECTION_FAILED, 'ubus: connection closed');
    }
    this.socket.write(encodeFrame(type, seq, peer, attrs));
  }

  _trySend(type, seq, peer, attrs) {
    try {
      this._send(type, seq, peer, attrs);
      return true;
    } catch (_e) {
      return false;
    }
  }

  // Send a request and settle on its STATUS: resolves
  // { status, data, dataList } where data is the first DATA payload
  // (null when the method returned none) and dataList holds every DATA
  // payload in arrival order. Rejects with UbusError on timeout or
  // when the connection drops.
  _request(type, peer, attrs, opts = {}) {
    if (this._closed) {
      return Promise.reject(new UbusError(UBUS_STATUS.CONNECTION_FAILED, 'ubus: connection closed'));
    }
    const seq = this._nextSeq();
    const key = this._pendingKey(seq, peer);
    const timeoutMs = opts.timeout ?? this.defaultTimeout;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this._pending.delete(key);
          const err = new UbusError(UBUS_STATUS.TIMEOUT, `ubus: request timed out (seq=${seq})`);
          err.code = 'UBUS_TIMEOUT';
          reject(err);
        }, timeoutMs)
        : null;
      if (timer && typeof timer.unref === 'function') timer.unref();
      this._pending.set(key, { resolve, reject, dataList: [], onData: opts.onData, timer });
      try {
        this._send(type, seq, peer, attrs);
      } catch (e) {
        if (timer) clearTimeout(timer);
        this._pending.delete(key);
        reject(e);
      }
    });
  }

  _failPending(err) {
    for (const entry of this._pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
    this._pending.clear();
  }

  _onSocketClose() {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this._closed = true;
    const err = new UbusError(UBUS_STATUS.CONNECTION_FAILED, 'ubus: connection closed');
    err.code = 'UBUS_CONNECTION_FAILED';
    this._failPending(err);
    this.emit('close');
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    const alreadyDestroyed = this.socket.destroyed;
    try { this.socket.destroy(); } catch (_e) { /* ignore */ }
    if (alreadyDestroyed) this._onSocketClose();
  }

  _onData(chunk) {
    let messages;
    try {
      messages = this._parser.push(chunk);
    } catch (e) {
      this._emitError(e);
      this.close();
      return;
    }
    for (const msg of messages) {
      try {
        this._dispatch(msg);
      } catch (e) {
        this._emitError(e);
      }
    }
  }

  _dispatch(msg) {
    switch (msg.type) {
      case UBUS_MSG.HELLO: {
        if (!this.isChannel) {
          if (msg.peer <= UBUS_CLIENT_ID_CHANNEL) {
            this._emitError(new UbusError(
              UBUS_STATUS.CONNECTION_FAILED,
              `ubus: HELLO gave invalid local_id ${msg.peer}`,
            ));
            this.close();
            return;
          }
          this.localId = msg.peer;
        }
        this.emit('hello', msg);
        return;
      }
      case UBUS_MSG.DATA: {
        const entry = this._pending.get(this._pendingKey(msg.seq, msg.peer));
        if (!entry) return; // stray DATA for an unknown request: drop
        const data = messageData(msg);
        entry.dataList.push(data);
        if (typeof entry.onData === 'function') {
          try { entry.onData(data); } catch (e) { this._emitError(e); }
        }
        return;
      }
      case UBUS_MSG.STATUS: {
        const entry = this._pending.get(this._pendingKey(msg.seq, msg.peer));
        if (!entry) return; // stray STATUS: drop
        this._pending.delete(this._pendingKey(msg.seq, msg.peer));
        if (entry.timer) clearTimeout(entry.timer);
        let status = UBUS_STATUS.OK;
        for (const a of msg.attrs) {
          if (a.id === UBUS_ATTR.STATUS) status = attrInt32(a);
        }
        entry.resolve({ status, data: entry.dataList[0] ?? null, dataList: entry.dataList });
        return;
      }
      case UBUS_MSG.INVOKE: {
        this._handleInvoke(msg).catch((e) => this._emitError(e));
        return;
      }
      case UBUS_MSG.PING: {
        // Server ping: answer with DATA, same seq/peer (ubusd_send_pong).
        this._trySend(UBUS_MSG.DATA, msg.seq, msg.peer, []);
        return;
      }
      default:
        // SUBSCRIBE / UNSUBSCRIBE / NOTIFY / MONITOR / LOOKUP /
        // ADD_OBJECT / REMOVE_OBJECT arriving unexpectedly, and anything
        // unknown: wifiroam does not use subscriptions or events, so
        // these are surfaced for observability and otherwise ignored.
        this.emit('message', msg);
        return;
    }
  }

  // Inbound INVOKE: channel mode goes to the single request handler;
  // local mode dispatches by published object id + method name.
  // The handler receives req = { method, data, peer, seq, objectId,
  // reply(data) }; its return value (or Promise of it) becomes the
  // DATA reply, followed by STATUS OK. Returning undefined (or using
  // req.reply() only) sends no DATA, just STATUS. Returning
  // UBUS_NO_REPLY sends nothing at all (silent drop, caller times out).
  // A throw becomes STATUS UNKNOWN_ERROR. NO_REPLY requests get no
  // answer at all.
  async _handleInvoke(msg) {
    const byId = new Map();
    for (const a of msg.attrs) if (!byId.has(a.id)) byId.set(a.id, a);
    const objId = byId.has(UBUS_ATTR.OBJID) ? attrInt32(byId.get(UBUS_ATTR.OBJID)) : 0;
    const method = byId.has(UBUS_ATTR.METHOD) ? attrString(byId.get(UBUS_ATTR.METHOD)) : '';
    let data = {};
    if (byId.has(UBUS_ATTR.DATA)) {
      try {
        data = decode(byId.get(UBUS_ATTR.DATA).payload);
      } catch (e) {
        this._trySend(UBUS_MSG.STATUS, msg.seq, msg.peer, [objIdAttr(objId), statusAttr(UBUS_STATUS.PARSE_ERROR)]);
        return;
      }
    }
    const noReply = byId.has(UBUS_ATTR.NO_REPLY) ? attrInt8(byId.get(UBUS_ATTR.NO_REPLY)) !== 0 : false;
    const caller = msg.peer;

    let handler = null;
    if (this.isChannel) {
      handler = this._requestHandler;
    } else {
      const obj = this._objects.get(objId);
      handler = obj ? obj.methods[method] : undefined;
    }
    if (typeof handler !== 'function') {
      if (!noReply) {
        this._trySend(UBUS_MSG.STATUS, msg.seq, caller, [
          objIdAttr(objId),
          statusAttr(this.isChannel ? UBUS_STATUS.METHOD_NOT_FOUND : UBUS_STATUS.NOT_FOUND),
        ]);
      }
      return;
    }

    let replied = false;
    const req = {
      method,
      data,
      peer: caller,
      seq: msg.seq,
      objectId: objId,
      reply: (replyData) => {
        if (replied || noReply) return;
        replied = true;
        this._trySend(UBUS_MSG.DATA, msg.seq, caller, [objIdAttr(objId), dataAttr(replyData ?? {})]);
      },
    };
    let result;
    try {
      result = await handler(req);
    } catch (_e) {
      if (!noReply) {
        this._trySend(UBUS_MSG.STATUS, msg.seq, caller, [objIdAttr(objId), statusAttr(UBUS_STATUS.UNKNOWN_ERROR)]);
      }
      return;
    }
    if (noReply) return;
    if (result === UBUS_NO_REPLY) return; // 静默丢弃：不发 DATA，不发 STATUS
    if (result !== undefined && !replied) {
      this._trySend(UBUS_MSG.DATA, msg.seq, caller, [objIdAttr(objId), dataAttr(result)]);
    }
    this._trySend(UBUS_MSG.STATUS, msg.seq, caller, [objIdAttr(objId), statusAttr(UBUS_STATUS.OK)]);
  }

  // Wait for the first HELLO (local-client connect). Rejects on
  // timeout, on socket close, or on a socket error.
  _waitHello(timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new UbusError(UBUS_STATUS.TIMEOUT, 'ubus: timed out waiting for HELLO'));
      }, timeoutMs > 0 ? timeoutMs : 30000);
      if (typeof timer.unref === 'function') timer.unref();
      const cleanup = () => {
        clearTimeout(timer);
        this.off('hello', onHello);
        this.off('close', onClose);
        this.off('error', onError);
      };
      const onHello = (msg) => { cleanup(); resolve(msg); };
      const onClose = () => {
        cleanup();
        reject(new UbusError(UBUS_STATUS.CONNECTION_FAILED, 'ubus: connection closed before HELLO'));
      };
      const onError = (err) => { cleanup(); reject(err); };
      this.once('hello', onHello);
      this.once('close', onClose);
      this.once('error', onError);
    });
  }
}

// ------------------------------------------------------------ local client
export class UbusClient extends UbusConnection {
  constructor(socket, opts = {}) {
    super(socket, { ...opts, localId: 0, isChannel: false });
    this._lookupCache = new Map(); // object path -> object id
  }

  // Connect to ubusd (default /var/run/ubus/ubus.sock) and wait for the
  // server-sent HELLO. Resolves with the connected client; rejects when
  // the socket cannot be opened, HELLO never arrives, or the assigned
  // local_id is <= 1.
  static async connect(path = UBUS_SOCKET_PATH, { timeout = 30000 } = {}) {
    const socket = net.createConnection(path);
    const client = new UbusClient(socket, { defaultTimeout: timeout });
    try {
      await client._waitHello(timeout);
    } catch (e) {
      client.close();
      throw e;
    }
    return client;
  }

  // LOOKUP: path omitted (null) lists all objects. Returns
  // [{ id, path, type, signature }] (signature is null when absent).
  // Throws UbusError on a non-OK status.
  async lookup(path, opts = {}) {
    const attrs = path === undefined || path === null ? [] : [strAttr(UBUS_ATTR.OBJPATH, path)];
    const { status, dataList } = await this._request(UBUS_MSG.LOOKUP, 0, attrs, opts);
    if (status !== UBUS_STATUS.OK) {
      throw new UbusError(status, `ubus lookup failed (status=${status})`);
    }
    return dataList.map((d) => ({
      id: d.objid ?? 0,
      path: d.objpath ?? '',
      type: d.objtype ?? 0,
      signature: d.signature ?? null,
    }));
  }

  async lookupId(path, opts = {}) {
    const list = await this.lookup(path, opts);
    return list.length ? list[0].id : null;
  }

  // Raw INVOKE by object id. Resolves { status, data, dataList };
  // never throws for a non-OK status (only for timeout/disconnect).
  // opts: { timeout, onData, noReply } -- noReply sends the request
  // and resolves immediately with { status: 0, data: null, dataList: [] }.
  async invoke(objectId, method, data, opts = {}) {
    const attrs = [objIdAttr(objectId), strAttr(UBUS_ATTR.METHOD, method), dataAttr(data ?? {})];
    if (opts.noReply) {
      attrs.push(int8Attr(UBUS_ATTR.NO_REPLY, 1));
      this._send(UBUS_MSG.INVOKE, this._nextSeq(), objectId, attrs);
      return { status: UBUS_STATUS.OK, data: null, dataList: [] };
    }
    return this._request(UBUS_MSG.INVOKE, objectId, attrs, opts);
  }

  // call(objectPath, method, data, opts): LOOKUP (cached) + INVOKE.
  // Resolves with the first DATA payload (null when the method returns
  // nothing). Throws UbusError on NOT_FOUND, on any non-OK status, on
  // timeout, or on disconnect -- mirroring ucode conn.call().
  async call(objectPath, method, data, opts = {}) {
    let id = this._lookupCache.get(objectPath);
    if (id === undefined) {
      id = await this.lookupId(objectPath, opts);
      if (id === null) {
        throw new UbusError(UBUS_STATUS.NOT_FOUND, `ubus: object not found: ${objectPath}`);
      }
      this._lookupCache.set(objectPath, id);
    }
    const res = await this.invoke(id, method, data, opts);
    if (res.status !== UBUS_STATUS.OK) {
      if (res.status === UBUS_STATUS.NOT_FOUND) this._lookupCache.delete(objectPath);
      throw new UbusError(res.status, `ubus call ${objectPath}.${method} failed (status=${res.status})`);
    }
    return res.data;
  }

  // Publish an object: methods is { name: handlerFn } or
  // { name: { handler: fn, args: { arg: 'string'|'int'|... } } }.
  // opts.signature may give an explicit { method: { arg: type } } map.
  // Resolves { id, type }. Throws UbusError when ubusd refuses.
  async addObject(path, methods, opts = {}) {
    if (!path || typeof path !== 'string') throw new TypeError('ubus.addObject: path is required');
    if (!methods || typeof methods !== 'object') throw new TypeError('ubus.addObject: methods is required');
    const signature = buildSignature(methods, opts.signature);
    const attrs = [strAttr(UBUS_ATTR.OBJPATH, path), { id: UBUS_ATTR.SIGNATURE, payload: signature }];
    const { status, dataList } = await this._request(UBUS_MSG.ADD_OBJECT, 0, attrs, opts);
    if (status !== UBUS_STATUS.OK) {
      throw new UbusError(status, `ubus add_object ${path} failed (status=${status})`);
    }
    const first = dataList[0] ?? {};
    const id = first.objid ?? 0;
    if (!id) {
      throw new UbusError(UBUS_STATUS.NO_DATA, `ubus add_object ${path}: no object id returned`);
    }
    const normMethods = {};
    for (const [name, def] of Object.entries(methods)) {
      normMethods[name] = typeof def === 'function' ? def : def.handler;
    }
    this._objects.set(id, { path, methods: normMethods });
    this._objectsByPath.set(path, id);
    return { id, type: first.objtype ?? 0 };
  }

  // Remove a published object by id or path. Resolves with the ubus
  // status code (0 on success). Unknown path -> NOT_FOUND without a request.
  async removeObject(idOrPath, opts = {}) {
    const id = typeof idOrPath === 'string' ? (this._objectsByPath.get(idOrPath) ?? 0) : idOrPath;
    if (!id) return UBUS_STATUS.NOT_FOUND;
    const { status } = await this._request(UBUS_MSG.REMOVE_OBJECT, 0, [objIdAttr(id)], opts);
    if (status === UBUS_STATUS.OK) {
      const obj = this._objects.get(id);
      if (obj) this._objectsByPath.delete(obj.path);
      this._objects.delete(id);
    }
    return status;
  }

  // Fire-and-forget NOTIFY to the subscribers of objectId. No response
  // is expected. (wifiroam does not use subscriptions; SUBSCRIBE is not
  // implemented -- see INTERFACE.md.)
  notify(objectId, data) {
    this._send(UBUS_MSG.NOTIFY, this._nextSeq(), objectId, [objIdAttr(objectId), dataAttr(data ?? {})]);
  }
}

// ---------------------------------------------------------- direct channel
// Peer-to-peer ubus over a bare TCP socket (libubus.open_channel):
// no HELLO handshake, local_id is fixed 1, every request peer is 0,
// ADD_OBJECT/LOOKUP are not available (the far end is not ubusd).
export class UbusChannel extends UbusConnection {
  constructor(socket, opts = {}) {
    super(socket, { ...opts, localId: UBUS_CLIENT_ID_CHANNEL, isChannel: true });
  }

  // Open a channel to host:port. Resolves once the TCP connection is
  // established (no HELLO is exchanged). Rejects on connect failure
  // or timeout.
  static async connect(host, port, { timeout = 30000 } = {}) {
    const socket = net.createConnection({ host, port });
    const channel = new UbusChannel(socket, { defaultTimeout: timeout });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        socket.destroy();
        reject(new UbusError(UBUS_STATUS.TIMEOUT, 'ubus channel: connect timed out'));
      }, timeout > 0 ? timeout : 30000);
      if (typeof timer.unref === 'function') timer.unref();
      const cleanup = () => {
        clearTimeout(timer);
        socket.off('connect', onConnect);
        socket.off('error', onError);
      };
      const onConnect = () => { cleanup(); resolve(); };
      const onError = (err) => { cleanup(); reject(err); };
      socket.once('connect', onConnect);
      socket.once('error', onError);
    });
    return channel;
  }

  // Wrap an already-connected socket (e.g. a server-side accept).
  static fromSocket(socket, opts = {}) {
    return new UbusChannel(socket, opts);
  }

  // Set the inbound method handler: fn(req) where req is
  // { method, data, peer, seq, objectId, reply(data) }. The return
  // value (or its Promise) is sent back as DATA + STATUS OK.
  setRequestHandler(fn) {
    if (typeof fn !== 'function') throw new TypeError('channel.setRequestHandler: handler must be a function');
    this._requestHandler = fn;
  }

  onRequest(fn) {
    this.setRequestHandler(fn);
  }

  // request(method, data, opts): INVOKE with peer 0. Resolves
  // { status, data, dataList }. opts: { timeout, onData, noReply }.
  // noReply is the fire-and-forget form (ucode return:"ignore").
  request(method, data, opts = {}) {
    const attrs = [objIdAttr(0), strAttr(UBUS_ATTR.METHOD, method), dataAttr(data ?? {})];
    if (opts.noReply) {
      attrs.push(int8Attr(UBUS_ATTR.NO_REPLY, 1));
      this._send(UBUS_MSG.INVOKE, this._nextSeq(), 0, attrs);
      return Promise.resolve({ status: UBUS_STATUS.OK, data: null, dataList: [] });
    }
    return this._request(UBUS_MSG.INVOKE, 0, attrs, opts);
  }

  // defer(method, data, opts): same Promise model as request; opts.onData
  // receives intermediate DATA messages (ucode defer's data_cb).
  defer(method, data, opts = {}) {
    return this.request(method, data, opts);
  }
}
