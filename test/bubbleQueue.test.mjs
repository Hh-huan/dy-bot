import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FREE_TAG,
  createBubbleQueue,
  startBubbleQueueScheduler,
} from '../examples/board/bubbleQueue.js';

function makeQueue(clock, options = {}) {
  const logs = [];
  const queue = createBubbleQueue({
    now: () => clock.value,
    random: () => 0,
    logger: (entry) => logs.push(entry),
    ...options,
  });
  return { queue, logs };
}

const POOL = [
  { key: 'u1', name: '小明' },
  { key: 'u2', name: '小红' },
  { key: 'u3', name: '小刚' },
];

test('队列低于阈值时随机补充 1 个 free 气泡', async () => {
  const clock = { value: 1000 };
  const { queue, logs } = makeQueue(clock);
  const result = await queue.fill({ threshold: 5, pool: POOL });
  assert.equal(result.added, true);
  assert.equal(result.size, 1);
  assert.equal(result.entry.tag, FREE_TAG);
  assert.equal(queue.size(), 1);
  assert.equal(queue.snapshot()[0].key, 'u1');
  assert.ok(logs.some((item) => item.message.includes('定时补充免费气泡')));
});

test('免费气泡入队时通过 onChange 同步通知外部（供页面提示甩飞玩法）', async () => {
  const clock = { value: 1000 };
  const events = [];
  const { queue } = makeQueue(clock, { onChange: (event, result) => events.push({ event, result }) });
  await queue.fill({ threshold: 2, pool: POOL });
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'fill');
  assert.equal(events[0].result.added, true);
  assert.equal(events[0].result.entry.tag, FREE_TAG);
  assert.equal(events[0].result.entry.name, '小明');
});

test('队列达到阈值时不再补充', async () => {
  const clock = { value: 1000 };
  const { queue } = makeQueue(clock);
  await queue.fill({ threshold: 1, pool: POOL });
  const again = await queue.fill({ threshold: 1, pool: POOL });
  assert.equal(again.added, false);
  assert.equal(again.reason, 'full');
  assert.equal(queue.size(), 1);
});

test('队列达到阈值时，用在场且不在队列的观众替换已离场的 free 气泡', async () => {
  const clock = { value: 1000 };
  const { queue, logs } = makeQueue(clock);
  for (const user of POOL) {
    await queue.fill({ threshold: 10, pool: [user] });
    clock.value += 1000;
  }
  assert.equal(queue.size(), 3);

  // u2 已离场；新观众 n1 在场且不在队列中
  const result = await queue.fill({
    threshold: 3,
    pool: [POOL[0], POOL[2], { key: 'n1', name: '新观众' }],
  });
  assert.equal(result.added, true);
  assert.equal(result.reason, 'replaced-stale');
  assert.equal(result.size, 3);
  assert.equal(result.entry.key, 'n1');
  assert.equal(result.entry.tag, FREE_TAG);
  assert.equal(result.entry.replacedKey, 'u2');
  const snapshot = queue.snapshot();
  assert.deepEqual(snapshot.map((item) => item.key), ['u1', 'n1', 'u3']);
  assert.equal(snapshot[1].tag, FREE_TAG);
  assert.ok(logs.some((item) => item.message.includes('替换已离场的免费气泡')));
});

test('队列满且 free 气泡都还在场时不替换', async () => {
  const clock = { value: 1000 };
  const { queue } = makeQueue(clock);
  for (const user of POOL) {
    await queue.fill({ threshold: 10, pool: [user] });
    clock.value += 1000;
  }
  const result = await queue.fill({
    threshold: 3,
    pool: [...POOL, { key: 'n1', name: '新观众' }],
  });
  assert.equal(result.added, false);
  assert.equal(result.reason, 'full');
  assert.deepEqual(queue.snapshot().map((item) => item.key), ['u1', 'u2', 'u3']);
});

test('队列满时存在离场 free、但在场观众都已入队，则跳过替换', async () => {
  const clock = { value: 1000 };
  const { queue } = makeQueue(clock);
  for (const user of POOL) {
    await queue.fill({ threshold: 10, pool: [user] });
    clock.value += 1000;
  }
  const result = await queue.fill({ threshold: 3, pool: [POOL[0], POOL[2]] });
  assert.equal(result.added, false);
  assert.equal(result.reason, 'no-candidate');
  assert.deepEqual(queue.snapshot().map((item) => item.key), ['u1', 'u2', 'u3']);
});

test('队列满且没有 free 气泡时不替换付费用户', async () => {
  const clock = { value: 1000 };
  const { queue } = makeQueue(clock);
  for (const user of POOL) {
    await queue.onGift(user);
    clock.value += 1000;
  }
  const result = await queue.fill({ threshold: 3, pool: [{ key: 'n1', name: '新观众' }] });
  assert.equal(result.added, false);
  assert.equal(result.reason, 'full');
  assert.equal(queue.size(), 3);
  assert.ok(queue.snapshot().every((item) => item.tag === undefined));
});

test('阈值为 0 或在线池没有候选时不补充', async () => {
  const clock = { value: 1000 };
  const { queue } = makeQueue(clock);
  assert.equal((await queue.fill({ threshold: 0, pool: POOL })).reason, 'no-threshold');

  await queue.fill({ threshold: 10, pool: [POOL[0]] });
  const none = await queue.fill({ threshold: 10, pool: [POOL[0]] });
  assert.equal(none.added, false);
  assert.equal(none.reason, 'no-candidate');
  assert.equal(queue.size(), 1);
});

test('付费用户替换最早进入的 free 气泡', async () => {
  const clock = { value: 1000 };
  const { queue } = makeQueue(clock);
  for (const user of POOL) {
    await queue.fill({ threshold: 10, pool: [user] });
    clock.value += 1000;
  }
  assert.equal(queue.size(), 3);

  const result = await queue.onGift({ key: 'paid-1', name: '大款' });
  assert.equal(result.changed, 'replaced');
  assert.equal(result.entry.replacedKey, 'u1');
  assert.equal(result.entry.tag, undefined);

  const snapshot = queue.snapshot();
  assert.equal(snapshot.length, 3);
  assert.equal(snapshot[0].key, 'paid-1');
  assert.equal(snapshot[0].tag, undefined);
  assert.equal(snapshot[1].tag, FREE_TAG);
  assert.equal(snapshot[2].tag, FREE_TAG);
});

test('队列没有 free 气泡时，付费气泡按原逻辑追加', async () => {
  const clock = { value: 1000 };
  const { queue } = makeQueue(clock);
  const result = await queue.onGift({ key: 'paid-1', name: '大款' });
  assert.equal(result.changed, 'appended');
  assert.equal(result.entry.tag, undefined);
  assert.equal(queue.size(), 1);
});

test('free 用户主动送礼先摘掉 free 标签，再按付费处理', async () => {
  const clock = { value: 1000 };
  const { queue, logs } = makeQueue(clock);
  await queue.fill({ threshold: 5, pool: [POOL[0]] });
  const result = await queue.onGift({ key: 'u1', name: '小明' });
  assert.equal(result.changed, 'untagged');
  assert.equal(queue.size(), 1);
  const snapshot = queue.snapshot();
  assert.equal(snapshot[0].tag, undefined);
  assert.ok(snapshot[0].paidAt);
  assert.ok(logs.some((item) => item.message.includes('移除 free 标签')));

  // 再次送礼不会重复生成气泡
  const again = await queue.onGift({ key: 'u1', name: '小明' });
  assert.equal(again.changed, 'exists');
  assert.equal(queue.size(), 1);
});

test('并发补充与付费入队串行执行，不会重复或替换错位', async () => {
  const clock = { value: 1000 };
  const { queue } = makeQueue(clock);
  const pool = [POOL[0], POOL[1]];
  await Promise.all([
    queue.fill({ threshold: 10, pool }),
    queue.fill({ threshold: 10, pool }),
    queue.onGift({ key: 'p1', name: '付费甲' }),
    queue.onGift({ key: 'p2', name: '付费乙' }),
  ]);
  const snapshot = queue.snapshot();
  const keys = snapshot.map((item) => item.key);
  assert.equal(keys.length, 2);
  assert.equal(new Set(keys).size, 2);
  assert.deepEqual(keys.sort(), ['p1', 'p2']);
  assert.equal(snapshot.some((item) => item.tag === FREE_TAG), false);
});

test('队列变更会落盘，重启后按原顺序恢复', async () => {
  const clock = { value: 1000 };
  let saved = null;
  const first = createBubbleQueue({
    now: () => clock.value,
    random: () => 0,
    logger: () => {},
    persist: (payload) => {
      saved = payload;
    },
  });
  await first.fill({ threshold: 5, pool: [POOL[0]] });
  clock.value += 1000;
  await first.fill({ threshold: 5, pool: [POOL[1]] });
  clock.value += 1000;
  assert.equal(saved.entries.length, 2);

  await first.onGift({ key: 'p1', name: '付费' });
  assert.equal(saved.entries.length, 2);
  assert.equal(saved.entries[0].key, 'p1');
  assert.equal(saved.entries[1].tag, FREE_TAG);

  const second = createBubbleQueue({
    now: () => clock.value,
    restore: () => saved,
    logger: () => {},
  });
  assert.equal(second.size(), 2);
  assert.equal(second.snapshot()[0].key, 'p1');
  assert.equal(second.snapshot()[0].tag, undefined);
  assert.equal(second.snapshot()[1].tag, FREE_TAG);
});

test('清空队列会移除全部气泡并写日志', async () => {
  const clock = { value: 1000 };
  const { queue, logs } = makeQueue(clock);
  await queue.fill({ threshold: 5, pool: POOL });
  await queue.onGift({ key: 'p1', name: '付费' });
  const removed = await queue.clear('gift-reset');
  assert.equal(removed, 1);
  assert.equal(queue.size(), 0);
  assert.ok(logs.some((item) => item.message.includes('清空气泡队列')));
});

test('定时任务每 60 秒注册一次并可按需停止', async () => {
  const clock = { value: 1000 };
  const { queue, logs } = makeQueue(clock);
  const scheduled = [];
  const cleared = [];
  const scheduler = startBubbleQueueScheduler({
    queue,
    intervalMs: 60000,
    threshold: () => 5,
    pool: () => [POOL[0]],
    logger: (entry) => logs.push(entry),
    setIntervalImpl: (fn, ms) => {
      scheduled.push({ fn, ms });
      return scheduled.length;
    },
    clearIntervalImpl: (id) => cleared.push(id),
  });

  assert.equal(scheduler.intervalMs, 60000);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, 60000);
  assert.ok(logs.some((item) => item.message.includes('定时任务已注册')));

  await scheduler.runOnce();
  assert.equal(queue.size(), 1);
  assert.equal(queue.snapshot()[0].tag, FREE_TAG);

  scheduler.stop();
  assert.deepEqual(cleared, [1]);
  assert.ok(logs.some((item) => item.message.includes('定时任务已停止')));
});

test('单轮检查异常会被捕获，定时器继续有效', async () => {
  const logs = [];
  const scheduled = [];
  const scheduler = startBubbleQueueScheduler({
    queue: { fill: async () => { throw new Error('boom'); } },
    intervalMs: 60000,
    threshold: () => 5,
    pool: () => [],
    logger: (entry) => logs.push(entry),
    setIntervalImpl: (fn, ms) => {
      scheduled.push({ fn, ms });
      return scheduled.length;
    },
    clearIntervalImpl: () => {},
  });
  await scheduler.runOnce();
  assert.ok(logs.some((item) => item.level === 'warn' && item.message.includes('失败')));
  scheduler.stop();
});
