import test from 'node:test';
import assert from 'node:assert/strict';

import { addTokenRecord, normalizeTokenRecord, tokenDateKey } from '../extension/app/core/tokenUsage.js';

test('Token 按上海日期保存，跨日只重置当日', () => {
  const today = '2026-10-27';
  const record = normalizeTokenRecord({ date: today, tokens: 120, total: 900 }, today);
  assert.deepEqual(record, { date: today, tokens: 120, total: 900 });

  const nextDay = normalizeTokenRecord(record, '2026-10-28');
  assert.deepEqual(nextDay, { date: '2026-10-28', tokens: 0, total: 900 });

  const added = addTokenRecord(nextDay, 30, '2026-10-28');
  assert.deepEqual(added, { date: '2026-10-28', tokens: 30, total: 930 });
});

test('旧版数字 Token 记录可以迁移', () => {
  const today = '2026-10-27';
  assert.deepEqual(normalizeTokenRecord(88, today), { date: today, tokens: 88, total: 88 });
});

test('上海日期键格式稳定', () => {
  assert.match(tokenDateKey(new Date('2026-10-27T12:00:00Z')), /^\d{4}-\d{2}-\d{2}$/);
});
