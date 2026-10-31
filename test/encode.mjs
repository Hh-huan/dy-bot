/** 测试用的最小 protobuf 编码器（只覆盖测试需要的 wire type）。 */

const encoder = new TextEncoder();

export function concat(...chunks) {
  const arrays = chunks.filter(Boolean).map((chunk) => (chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)));
  const total = arrays.reduce((sum, item) => sum + item.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const item of arrays) {
    out.set(item, offset);
    offset += item.length;
  }
  return out;
}

export function varint(value) {
  let v = BigInt(value);
  if (v < 0n) v = BigInt.asUintN(64, v);
  const bytes = [];
  while (v >= 0x80n) {
    bytes.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  bytes.push(Number(v));
  return new Uint8Array(bytes);
}

export function tag(field, wire) {
  return varint((BigInt(field) << 3n) | BigInt(wire));
}

export function fieldVarint(field, value) {
  return concat(tag(field, 0), varint(value));
}

export function fieldBytes(field, bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return concat(tag(field, 2), varint(data.length), data);
}

export function fieldString(field, text) {
  return fieldBytes(field, encoder.encode(text));
}

export function fieldMessage(field, bytes) {
  return fieldBytes(field, bytes);
}

export function fieldDouble(field, value) {
  const buffer = new Uint8Array(8);
  new DataView(buffer.buffer).setFloat64(0, value, true);
  return concat(tag(field, 1), buffer);
}
