import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../examples/board/giftCombo.js', import.meta.url), 'utf8');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const { createComboTracker } = sandbox.GiftCombo;

test('礼物连击：中间帧只补差额，结束帧不重复计算', () => {
  let now = 1000;
  const tracker = createComboTracker({ now: () => now });
  const user = { id: 'u1' };
  assert.equal(tracker.delta(user, 'g1', '小心心', 1, false), 1);
  now += 1000;
  assert.equal(tracker.delta(user, 'g1', '小心心', 4, false), 3);
  now += 1000;
  assert.equal(tracker.delta(user, 'g1', '小心心', 10, true), 6);
  assert.equal(tracker.delta({ id: 'u2' }, 'g2', '玫瑰', 1, true), 1);
});

test('礼物连击：结束帧丢失时，后续帧仍然补上数量', () => {
  let now = 1000;
  const tracker = createComboTracker({ now: () => now });
  const user = { id: 'u1' };
  assert.equal(tracker.delta(user, 'g1', '小心心', 1, false), 1);
  now += 1000;
  assert.equal(tracker.delta(user, 'g1', '小心心', 2, false), 1);
  // 没有结束帧，用户又发起一轮新连击
  now += 1000;
  assert.equal(tracker.delta(user, 'g1', '小心心', 1, false), 1);
});

test('礼物连击：结束帧重复累计值时不重复计数（大啤酒 1→3→4→5→5）', () => {
  let now = 1000;
  const tracker = createComboTracker({ now: () => now });
  const user = { id: 'u1' };
  const frames = [
    [1, false],
    [3, false],
    [4, false],
    [5, false],
    [5, true],
  ];
  let total = 0;
  for (const [count, completed] of frames) {
    now += 1000;
    total += tracker.delta(user, 'g1', '大啤酒', count, completed);
  }
  // 实际送出 5 瓶：连击帧是累计值，结束帧不是新的一轮
  assert.equal(total, 5);
});

test('礼物连击：不同用户互不影响，过期后重新计数', () => {
  let now = 1000;
  const tracker = createComboTracker({ now: () => now, ttlMs: 5000 });
  assert.equal(tracker.delta({ id: 'u1' }, 'g1', '小心心', 5, false), 5);
  assert.equal(tracker.delta({ id: 'u2' }, 'g1', '小心心', 5, false), 5);
  now += 6000;
  assert.equal(tracker.delta({ id: 'u1' }, 'g1', '小心心', 5, false), 5);
});

test('礼物连击：快照恢复后刷新页面不会重复计数', () => {
  let now = 1000;
  const first = createComboTracker({ now: () => now });
  assert.equal(first.delta({ id: 'u1' }, 'g1', '小心心', 3, false), 3);
  const saved = first.snapshot();

  const second = createComboTracker({ now: () => now });
  second.restore(saved);
  assert.equal(second.delta({ id: 'u1' }, 'g1', '小心心', 4, false), 1);

  second.clear();
  assert.equal(second.delta({ id: 'u1' }, 'g1', '小心心', 2, false), 2);
});
