import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createViolationStore } from '../bridge/violationStore.mjs';

test('违规记录与拉黑写盘，并能在新实例重新加载', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dy-violation-'));
  const filePath = path.join(dir, 'violations.json');
  const clock = { value: 1_000_000 };
  try {
    const store = createViolationStore({ path: filePath, now: () => clock.value });
    store.load();
    const record = store.addViolation({
      title: ' 晴天 ',
      artist: ' 周杰伦 ',
      reason: '测试违规',
      allowPlay: false,
      requester: '小明',
      requesterKey: 'u1',
    });
    assert.equal(record.title, '晴天');
    assert.equal(record.artist, '周杰伦');
    assert.equal(record.allowPlay, false);
    assert.equal(record.createdAt, clock.value);
    assert.equal(record.requester, '小明');
    assert.equal(record.requesterKey, 'u1');
    assert.ok(record.id);

    store.blockUser({ userKey: 'u1', nickname: '小明', reason: '测试违规' });
    store.persist();

    const saved = JSON.parse(readFileSync(filePath, 'utf8'));
    assert.equal(saved.version, 1);
    assert.equal(saved.violations.length, 1);
    assert.deepEqual(Object.keys(saved.violations[0]).sort(), [
      'allowPlay',
      'artist',
      'createdAt',
      'id',
      'reason',
      'requester',
      'requesterKey',
      'title',
    ]);
    assert.equal(saved.blockedUsers.length, 1);

    const reloaded = createViolationStore({ path: filePath, now: () => clock.value });
    reloaded.load();
    assert.equal(reloaded.listViolations().length, 1);
    assert.equal(reloaded.findExact('晴天', '周杰伦').id, record.id);
    assert.equal(reloaded.isBlocked('u1'), true);
    assert.equal(reloaded.isBlocked('u2'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findExact 按歌名+歌手完全匹配（忽略大小写与空白）', () => {
  const store = createViolationStore({});
  store.load();
  store.addViolation({ title: 'Hello World', artist: 'Adele', reason: 'x', allowPlay: false });
  store.addViolation({ title: '无名', reason: 'y', allowPlay: true });

  assert.ok(store.findExact(' hello   world ', 'ADELE'));
  assert.equal(store.findExact('Hello', 'Adele'), null);
  assert.equal(store.findExact('Hello World', 'Adele B'), null);
  // 歌手缺失时，只有记录歌手也为空才匹配
  assert.ok(store.findExact('无名', ''));
  assert.equal(store.findExact('无名', '某人'), null);
});

test('重复拉黑同一用户只保留最新一条', () => {
  const clock = { value: 2_000_000 };
  const store = createViolationStore({ now: () => clock.value });
  store.load();
  store.blockUser({ userKey: 'u1', nickname: '小明', reason: '第一次' });
  clock.value += 1000;
  store.blockUser({ userKey: 'u1', nickname: '小明', reason: '第二次' });
  const snapshot = store.snapshot();
  assert.equal(snapshot.blockedUsers.length, 1);
  assert.equal(snapshot.blockedUsers[0].reason, '第二次');
  assert.equal(snapshot.blockedUsers[0].blockedAt, clock.value);
  assert.equal(store.isBlocked(''), false);
});

test('restore 可以回滚内存状态，path 为空时 persist 不报错', () => {
  const store = createViolationStore({});
  store.load();
  const snapshot = store.snapshot();
  store.addViolation({ title: '临时', reason: 'x', allowPlay: false });
  store.blockUser({ userKey: 'u1' });
  assert.equal(store.listViolations().length, 1);
  store.restore(snapshot);
  assert.equal(store.listViolations().length, 0);
  assert.equal(store.isBlocked('u1'), false);
  assert.deepEqual(store.persist(), { ok: true, skipped: true });
});
