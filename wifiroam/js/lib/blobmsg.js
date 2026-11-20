// blobmsg.js -- blobmsg / blob_attr encode & decode.
// Target: Node 22.23.4, core modules only, zero npm dependencies.
// Protocol source: libubox blob.h / blobmsg.h / blobmsg_json.c
// (see research-node-ubus.md §2.8).
//
// Wire format (all big-endian):
//   blob_attr header, 4 bytes BE uint32:
//     bit 31        : extended flag (1 = blobmsg field, carries a name)
//     bits 30..24  : type id (7 bits)
//     bits 23..0   : total length including this 4-byte header
//   Every attribute occupies blob_pad_len bytes (raw length rounded up
//   to a multiple of 4, zero padded).
//   Named (blobmsg) field, after the 4-byte header:
//     namelen BE16 (byte length of the name, NOT counting the NUL)
//     name bytes + one NUL byte
//     the whole "2 + namelen + 1" name header padded up to a multiple of 4
//     then the payload.
//   Unnamed (ubus message) attributes have extended = 0 and no name header;
//   their id field is a UBUS_ATTR_* value and the payload is interpreted
//   by the attribute id, not by a blobmsg type.
//
// JSON mapping (blobmsg_json.c):
//   object  -> TABLE    array   -> ARRAY     string  -> STRING
//   boolean -> INT8 (0/1)       integer in INT32 range -> INT32
//   integer outside INT32     -> INT64       float   -> DOUBLE
//   null    -> UNSPEC, zero-length payload
//   (missing field = attribute absent; never synthesised as null/0/"".)
//
// NOTE: BOOL is an alias of INT8 (same id 7). Encoding a JS boolean
// produces id 7; decoding id 7 yields a JS boolean, matching the JSON
// mapping (JSON integers are never encoded as INT8 by this module).

export const BLOBMSG_TYPE = Object.freeze({
  UNSPEC: 0,
  ARRAY: 1,
  TABLE: 2,
  STRING: 3,
  INT64: 4,
  INT32: 5,
  INT16: 6,
  INT8: 7,
  BOOL: 7,
  DOUBLE: 8,
});

const EXTENDED_BIT = 0x80000000;
const ID_MASK = 0x7f000000;
const LEN_MASK = 0x00ffffff;
const MAX_ATTR_LEN = 0x00ffffff; // 24-bit length field, header included

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const INT64_MIN = -9223372036854775808n;
const INT64_MAX = 9223372036854775807n;

function pad4(n) {
  return (n + 3) & ~3;
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// Encode one JS value as { type, payload } (no attribute header, no name).
function encodeValue(value) {
  if (value === null || value === undefined) {
    return { type: BLOBMSG_TYPE.UNSPEC, payload: Buffer.alloc(0) };
  }
  if (typeof value === 'boolean') {
    return { type: BLOBMSG_TYPE.INT8, payload: Buffer.from([value ? 1 : 0]) };
  }
  if (typeof value === 'string') {
    return { type: BLOBMSG_TYPE.STRING, payload: Buffer.concat([Buffer.from(value, 'utf8'), Buffer.from([0])]) };
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new RangeError('blobmsg: cannot encode NaN or Infinity');
    }
    if (Number.isInteger(value)) {
      if (value >= INT32_MIN && value <= INT32_MAX) {
        const payload = Buffer.alloc(4);
        payload.writeInt32BE(value, 0);
        return { type: BLOBMSG_TYPE.INT32, payload };
      }
      if (!Number.isSafeInteger(value)) {
        throw new RangeError(`blobmsg: integer ${value} is outside the safe-integer range, use a BigInt`);
      }
      const payload = Buffer.alloc(8);
      payload.writeBigInt64BE(BigInt(value), 0);
      return { type: BLOBMSG_TYPE.INT64, payload };
    }
    const payload = Buffer.alloc(8);
    payload.writeDoubleBE(value, 0);
    return { type: BLOBMSG_TYPE.DOUBLE, payload };
  }
  if (typeof value === 'bigint') {
    if (value < INT64_MIN || value > INT64_MAX) {
      throw new RangeError(`blobmsg: BigInt ${value} is outside the INT64 range`);
    }
    const payload = Buffer.alloc(8);
    payload.writeBigInt64BE(value, 0);
    return { type: BLOBMSG_TYPE.INT64, payload };
  }
  if (Array.isArray(value)) {
    const parts = value.map((el) => encodeField(null, el));
    return { type: BLOBMSG_TYPE.ARRAY, payload: Buffer.concat(parts) };
  }
  if (isPlainObject(value)) {
    return { type: BLOBMSG_TYPE.TABLE, payload: encode(value) };
  }
  throw new TypeError(`blobmsg: no encoding for value of type ${typeof value}`);
}

// Encode one named (or, for array elements, unnamed) blobmsg field,
// including its 4-byte attribute header, name header and padding.
export function encodeField(name, value) {
  const { type, payload } = encodeValue(value);
  const nameBuf = name === null || name === undefined ? Buffer.alloc(0) : Buffer.from(String(name), 'utf8');
  // Name header: namelen BE16 + name + NUL, padded to a multiple of 4.
  const nameHeaderLen = pad4(2 + nameBuf.length + 1);
  const rawLen = 4 + nameHeaderLen + payload.length;
  if (rawLen > MAX_ATTR_LEN) {
    throw new RangeError('blobmsg: attribute exceeds the 24-bit length field');
  }
  const out = Buffer.alloc(pad4(rawLen));
  // >>> 0: the word has bit 31 set, which is a negative int32 in JS;
  // writeUInt32BE needs the unsigned value.
  out.writeUInt32BE((EXTENDED_BIT | (type << 24) | rawLen) >>> 0, 0);
  out.writeUInt16BE(nameBuf.length, 4);
  nameBuf.copy(out, 6);
  // Byte at 6 + nameBuf.length is the NUL terminator; the buffer was
  // zero-filled, so the NUL and the padding are already 0.
  payload.copy(out, 4 + nameHeaderLen);
  return out;
}

// Encode a raw (unnamed) blob_attr: id is a UBUS_ATTR_* value (or 0 for
// the outer message wrapper); extended is always 0; no name header.
// Used by ubus.js for message framing; not a blobmsg field.
export function encodeAttr(id, payload, { extended = false } = {}) {
  const rawLen = 4 + payload.length;
  if (rawLen > MAX_ATTR_LEN) {
    throw new RangeError('blobmsg: attribute exceeds the 24-bit length field');
  }
  const out = Buffer.alloc(pad4(rawLen));
  out.writeUInt32BE(((extended ? EXTENDED_BIT : 0) | ((id & 0x7f) << 24) | rawLen) >>> 0, 0);
  payload.copy(out, 4);
  return out;
}

// Encode a JS object as the *contents* of a TABLE: the concatenation of
// its named fields. There is no TABLE header of its own; this is exactly
// what goes into a UBUS_ATTR_DATA payload or a nested TABLE payload.
// `undefined`-valued properties are skipped (missing field, not null).
// Throws TypeError for non-plain-object input.
export function encode(obj) {
  if (!isPlainObject(obj)) {
    throw new TypeError('blobmsg.encode: expected a plain object');
  }
  const parts = [];
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (v === undefined) continue;
    parts.push(encodeField(key, v));
  }
  return Buffer.concat(parts);
}

// Parse a buffer holding a sequence of blob_attr records (either named
// blobmsg fields or unnamed ubus message attributes) starting at `start`
// and ending before `end`. Returns an array of records:
//   { id, extended, name, type, payload, rawLen, padLen }
// where `payload` is the raw payload Buffer, `name` is null for unnamed
// attributes, and `value` is the decoded JS value for named blobmsg
// fields (for unnamed attributes `value` is the raw payload Buffer).
// Throws Error on truncation, a length field < 4, or a name header that
// overruns its attribute.
export function parseAttrs(buf, start = 0, end = buf.length) {
  if (!Buffer.isBuffer(buf)) {
    throw new TypeError('blobmsg.parseAttrs: expected a Buffer');
  }
  const out = [];
  let off = start;
  while (off < end) {
    if (end - off < 4) {
      throw new Error('blobmsg: truncated attribute header');
    }
    const idLen = buf.readUInt32BE(off);
    const extended = (idLen & EXTENDED_BIT) !== 0;
    const id = (idLen & ID_MASK) >>> 24;
    const rawLen = idLen & LEN_MASK;
    if (rawLen < 4) {
      throw new Error(`blobmsg: attribute length ${rawLen} is smaller than its header`);
    }
    if (off + rawLen > end) {
      throw new Error('blobmsg: truncated attribute (length field exceeds available bytes)');
    }
    const padLen = pad4(rawLen);
    let name = null;
    let payloadStart = off + 4;
    if (extended) {
      if (rawLen < 4 + 2) {
        throw new Error('blobmsg: named attribute is too short for a name header');
      }
      const namelen = buf.readUInt16BE(off + 4);
      const nameHeaderLen = pad4(2 + namelen + 1);
      if (4 + nameHeaderLen > rawLen) {
        throw new Error('blobmsg: name header overruns its attribute');
      }
      name = buf.subarray(off + 6, off + 6 + namelen).toString('utf8');
      payloadStart = off + 4 + nameHeaderLen;
    }
    const payload = buf.subarray(payloadStart, off + rawLen);
    const rec = { id, extended, name, type: id, payload, rawLen, padLen };
    rec.value = extended ? decodeAttrValue(rec) : payload;
    out.push(rec);
    off += padLen;
  }
  return out;
}

// Decode the payload of one parsed (named) attribute record into a JS
// value, by its blobmsg type id. Throws on unknown types or truncated
// numeric payloads.
export function decodeAttrValue(rec) {
  const payload = rec.payload;
  switch (rec.type) {
    case BLOBMSG_TYPE.UNSPEC:
      return null;
    case BLOBMSG_TYPE.ARRAY: {
      const out = [];
      for (const child of parseAttrs(payload)) out.push(child.value);
      return out;
    }
    case BLOBMSG_TYPE.TABLE: {
      const out = {};
      for (const child of parseAttrs(payload)) out[child.name] = child.value;
      return out;
    }
    case BLOBMSG_TYPE.STRING: {
      if (payload.length === 0) return '';
      const end = payload[payload.length - 1] === 0 ? payload.length - 1 : payload.length;
      return payload.subarray(0, end).toString('utf8');
    }
    case BLOBMSG_TYPE.INT64: {
      if (payload.length < 8) throw new Error('blobmsg: truncated INT64 payload');
      const v = payload.readBigInt64BE(0);
      return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(v)
        : v;
    }
    case BLOBMSG_TYPE.INT32: {
      if (payload.length < 4) throw new Error('blobmsg: truncated INT32 payload');
      return payload.readInt32BE(0);
    }
    case BLOBMSG_TYPE.INT16: {
      if (payload.length < 2) throw new Error('blobmsg: truncated INT16 payload');
      return payload.readInt16BE(0);
    }
    case BLOBMSG_TYPE.INT8: // BOOL is the same id; JSON mapping decodes it as boolean.
      return payload.length > 0 ? payload[0] !== 0 : false;
    case BLOBMSG_TYPE.DOUBLE: {
      if (payload.length < 8) throw new Error('blobmsg: truncated DOUBLE payload');
      return payload.readDoubleBE(0);
    }
    default:
      throw new Error(`blobmsg: unknown blobmsg type ${rec.type}`);
  }
}

// Decode a buffer holding the contents of a TABLE (a sequence of named
// fields) into a plain JS object. An empty buffer decodes to {}.
// Throws Error on truncated or malformed input.
export function decode(buf) {
  if (!Buffer.isBuffer(buf)) {
    throw new TypeError('blobmsg.decode: expected a Buffer');
  }
  const out = {};
  for (const rec of parseAttrs(buf)) {
    if (!rec.extended) {
      throw new Error('blobmsg.decode: unnamed attribute inside a table');
    }
    out[rec.name] = rec.value;
  }
  return out;
}
