import test from 'node:test';
import assert from 'node:assert/strict';

import { THROW_LINE_COUNT, pickThrowLine } from '../extension/app/core/throwLines.js';

test('甩飞文案：每个模板都带上目标观众昵称', () => {
  const lines = new Set();
  for (let i = 0; i < THROW_LINE_COUNT; i += 1) {
    const text = pickThrowLine('糖糖', () => i / THROW_LINE_COUNT);
    assert.ok(text.includes('糖糖'), text);
    lines.add(text);
  }
  assert.equal(lines.size, THROW_LINE_COUNT);
  assert.ok(THROW_LINE_COUNT >= 6);
});

test('甩飞文案：随机值边界不会越界，昵称缺失时有兜底称呼', () => {
  assert.ok(pickThrowLine('糖糖', () => 0).includes('糖糖'));
  assert.ok(pickThrowLine('糖糖', () => 1).includes('糖糖'));
  assert.ok(pickThrowLine('', () => 0.5).includes('该观众'));
  assert.ok(pickThrowLine(null, () => Number.NaN).includes('该观众'));
});

test('甩飞文案：随机结果会轮换出不同风格', () => {
  const texts = new Set([
    pickThrowLine('小鹿', () => 0.05),
    pickThrowLine('小鹿', () => 0.45),
    pickThrowLine('小鹿', () => 0.85),
  ]);
  assert.equal(texts.size, 3);
});
