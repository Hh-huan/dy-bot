import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeMessage, ProtoError, Reader, toBytes } from '../extension/app/core/protobuf.js';
import { fieldBytes, fieldDouble, fieldMessage, fieldString, fieldVarint, concat } from './encode.mjs';

const schema = {
  1: { name: 'id', type: 'uint64' },
  2: { name: 'name', type: 'string' },
  3: { name: 'tags', type: 'string', repeated: true },
  4: { name: 'child', type: 'message', schema: { 1: { name: 'score', type: 'int32' } } },
  5: { name: 'active', type: 'bool' },
  6: { name: 'ratio', type: 'double' },
};

test('解码标量、字符串、重复字段与嵌套消息', () => {
  const bytes = concat(
    fieldVarint(1, 1234567890123n),
    fieldString(2, '小明'),
    fieldString(3, 'a'),
    fieldString(3, 'b'),
    fieldMessage(4, fieldVarint(1, -5)),
    fieldVarint(5, 1),
    fieldDouble(6, 1.5),
  );
  const value = decodeMessage(bytes, schema);
  assert.equal(value.id, 1234567890123n);
  assert.equal(value.name, '小明');
  assert.deepEqual(value.tags, ['a', 'b']);
  assert.deepEqual(value.child, { score: -5 });
  assert.equal(value.active, true);
  assert.equal(value.ratio, 1.5);
});

test('未知字段与未知 wire type 被安全跳过', () => {
  const unknown = concat(
    fieldVarint(99, 7),
    fieldString(98, 'ignored'),
    fieldBytes(97, new Uint8Array([1, 2, 3])),
  );
  const bytes = concat(unknown, fieldString(2, 'ok'));
  const value = decodeMessage(bytes, schema);
  assert.equal(value.name, 'ok');
});

test('wire type 不匹配时按未知字段跳过', () => {
  const bytes = concat(fieldString(1, 'not-a-number'), fieldString(2, 'still-ok'));
  const value = decodeMessage(bytes, schema);
  assert.equal(value.name, 'still-ok');
  assert.equal(value.id, undefined);
});

test('非法长度不会无限读取', () => {
  const bytes = new Uint8Array([0x0a, 0x7f, 0x01, 0x02]);
  assert.throws(() => new Reader(bytes).readBytes(), ProtoError);
});

test('toBytes 接受多种输入类型', () => {
  assert.equal(toBytes(new Uint8Array([1, 2])).length, 2);
  assert.equal(toBytes(new Uint8Array([3, 4]).buffer).length, 2);
});
