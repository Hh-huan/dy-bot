/**
 * 极简 protobuf 解码器（wire format 级别）。
 *
 * 只做「读」：抖音下发的弹幕帧是 protobuf 二进制，本文件不认识任何业务字段，
 * 字段表由 douyin.js 提供。不依赖任何第三方库，浏览器 / Node 通用。
 *
 * 支持的 wire type：0 varint、1 fixed64、2 length-delimited、5 fixed32。
 * 遇到未知字段、未知 wire type 会安全跳过，保证抖音新增字段时不会解析失败。
 */

const utf8 = new TextDecoder('utf-8');
const MAX_DEPTH = 16;

export class ProtoError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProtoError';
  }
}

const WIRE_BY_TYPE = {
  message: 2,
  string: 2,
  bytes: 2,
  uint64: 0,
  int64: 0,
  uint32: 0,
  int32: 0,
  bool: 0,
  fixed32: 5,
  fixed64: 1,
  float: 5,
  double: 1,
};

export class Reader {
  constructor(bytes) {
    this.b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.pos = 0;
    this.end = this.b.length;
  }

  get remaining() {
    return this.end - this.pos;
  }

  eof() {
    return this.pos >= this.end;
  }

  readVarint() {
    let result = 0n;
    let shift = 0n;
    while (true) {
      if (this.pos >= this.end) throw new ProtoError('varint truncated');
      const byte = this.b[this.pos++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return BigInt.asUintN(64, result);
      shift += 7n;
      if (shift > 63n) throw new ProtoError('varint too long');
    }
  }

  readTag() {
    const key = this.readVarint();
    return { field: Number(key >> 3n), wire: Number(key & 7n) };
  }

  readBytes() {
    const len = Number(this.readVarint());
    if (!Number.isSafeInteger(len) || len < 0 || this.pos + len > this.end) {
      throw new ProtoError('length-delimited field out of range');
    }
    const out = this.b.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  readString() {
    return utf8.decode(this.readBytes());
  }

  readUint32() {
    return Number(BigInt.asUintN(32, this.readVarint()));
  }

  readInt32() {
    return Number(BigInt.asIntN(32, this.readVarint()));
  }

  readUint64() {
    return this.readVarint();
  }

  readInt64() {
    return BigInt.asIntN(64, this.readVarint());
  }

  readBool() {
    return this.readVarint() !== 0n;
  }

  readFixed32() {
    if (this.pos + 4 > this.end) throw new ProtoError('fixed32 truncated');
    const view = new DataView(this.b.buffer, this.b.byteOffset + this.pos, 4);
    this.pos += 4;
    return view.getUint32(0, true);
  }

  readFixed64() {
    if (this.pos + 8 > this.end) throw new ProtoError('fixed64 truncated');
    const view = new DataView(this.b.buffer, this.b.byteOffset + this.pos, 8);
    this.pos += 8;
    return view.getBigUint64(0, true);
  }

  readFloat() {
    if (this.pos + 4 > this.end) throw new ProtoError('float truncated');
    const view = new DataView(this.b.buffer, this.b.byteOffset + this.pos, 4);
    this.pos += 4;
    return view.getFloat32(0, true);
  }

  readDouble() {
    if (this.pos + 8 > this.end) throw new ProtoError('double truncated');
    const view = new DataView(this.b.buffer, this.b.byteOffset + this.pos, 8);
    this.pos += 8;
    return view.getFloat64(0, true);
  }

  skip(wire) {
    switch (wire) {
      case 0:
        this.readVarint();
        break;
      case 1:
        this.advance(8);
        break;
      case 2: {
        const len = Number(this.readVarint());
        if (!Number.isSafeInteger(len) || len < 0) throw new ProtoError('bad length');
        this.advance(len);
        break;
      }
      case 3: {
        // 已废弃的 group，跳过直到 end-group
        while (!this.eof()) {
          const { wire: w } = this.readTag();
          if (w === 4) return;
          this.skip(w);
        }
        break;
      }
      case 4:
        break;
      case 5:
        this.advance(4);
        break;
      default:
        throw new ProtoError(`unsupported wire type ${wire}`);
    }
  }

  advance(n) {
    if (n < 0 || this.pos + n > this.end) throw new ProtoError('skip out of range');
    this.pos += n;
  }
}

function readValue(reader, type) {
  switch (type) {
    case 'string':
      return reader.readString();
    case 'bytes':
      return reader.readBytes();
    case 'uint64':
      return reader.readUint64();
    case 'int64':
      return reader.readInt64();
    case 'uint32':
      return reader.readUint32();
    case 'int32':
      return reader.readInt32();
    case 'bool':
      return reader.readBool();
    case 'fixed32':
      return reader.readFixed32();
    case 'fixed64':
      return reader.readFixed64();
    case 'float':
      return reader.readFloat();
    case 'double':
      return reader.readDouble();
    default:
      throw new ProtoError(`unknown field type ${type}`);
  }
}

/**
 * 按字段表解码一条消息。
 * @param {Uint8Array|ArrayBuffer} input
 * @param {Record<number, {name:string,type:string,repeated?:boolean,schema?:object}>} schema
 * @param {number} depth
 */
export function decodeMessage(input, schema, depth = 0) {
  if (depth > MAX_DEPTH) throw new ProtoError('max message depth exceeded');
  const reader = new Reader(input);
  const out = {};

  while (!reader.eof()) {
    let tag;
    try {
      tag = reader.readTag();
    } catch (err) {
      if (err instanceof ProtoError) break; // 尾部残缺，保留已解析字段
      throw err;
    }
    const { field, wire } = tag;
    if (wire === 4) break;

    const def = field === 0 ? null : schema[field];
    if (!def) {
      reader.skip(wire);
      continue;
    }
    const expected = WIRE_BY_TYPE[def.type];
    if (expected !== undefined && expected !== wire) {
      reader.skip(wire);
      continue;
    }

    let value;
    if (def.type === 'message') {
      value = decodeMessage(reader.readBytes(), def.schema || {}, depth + 1);
    } else {
      value = readValue(reader, def.type);
    }

    if (def.repeated) {
      if (!Array.isArray(out[def.name])) out[def.name] = [];
      out[def.name].push(value);
    } else {
      out[def.name] = value;
    }
  }

  return out;
}

/** 把 ArrayBuffer / Buffer / Uint8Array 统一成 Uint8Array。 */
export function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('unsupported binary input');
}

export function isGzip(bytes) {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** gzip 解压（浏览器 DecompressionStream / Node 18+ 的 Web Streams 均可用）。 */
export async function gunzip(bytes) {
  if (typeof DecompressionStream !== 'function') throw new Error('当前环境不支持 DecompressionStream');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}
