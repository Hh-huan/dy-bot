import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  INTIMACY_LEVELS,
  INTIMACY_MAX_POINTS,
  applyIntimacyAward,
  intimacyAwardForEvent,
  intimacyAwardForSong,
  intimacyBadge,
  intimacyGiftTail,
  intimacySpokenLevel,
  intimacyWelcomeTail,
  levelForPoints,
  levelUpLine,
  normalizeIntimacy,
  shanghaiDayKey,
} from '../extension/app/core/intimacy.js';

// 固定时间点，避免测试受运行时间影响：UTC 12:00 = 上海 20:00
const DAY1 = Date.UTC(2026, 10, 1, 12, 0, 0);
const DAY1_LATER = DAY1 + 10 * 60 * 1000;
const DAY2 = Date.UTC(2026, 10, 2, 12, 0, 0);
const DAY5 = Date.UTC(2026, 10, 5, 12, 0, 0);

function viewer(points = 0, dayKey = '', streak = 0) {
  return { name: '小明', intimacy: { points, dayKey, streak } };
}

test('intimacy: 等级门槛与称号', () => {
  assert.equal(levelForPoints(0).level, 1);
  assert.equal(levelForPoints(0).title, '路人');
  assert.equal(levelForPoints(9).level, 1);
  assert.equal(levelForPoints(10).level, 2);
  assert.equal(levelForPoints(25).level, 3);
  assert.equal(levelForPoints(90).level, 5);
  assert.equal(levelForPoints(INTIMACY_MAX_POINTS).level, 10);
  assert.equal(levelForPoints(99999).level, 10);
  // 距下一级的进度：0 → 10 分，5 分时是一半
  const half = levelForPoints(5);
  assert.equal(half.next, 2);
  assert.equal(half.toNext, 5);
  assert.equal(half.progress, 0.5);
  // 满级没有下一级
  assert.equal(levelForPoints(INTIMACY_MAX_POINTS).next, 0);
  assert.equal(levelForPoints(INTIMACY_MAX_POINTS).progress, 1);
  assert.equal(INTIMACY_LEVELS.length, 10);
});

test('intimacy: 上海时区日期串', () => {
  assert.equal(shanghaiDayKey(DAY1), '2026-11-01');
  // 上海 23:59 = UTC 15:59 仍是同一天
  assert.equal(shanghaiDayKey(Date.UTC(2026, 10, 1, 15, 59, 0)), '2026-11-01');
  // UTC 16:00 之后才算上海的第二天
  assert.equal(shanghaiDayKey(Date.UTC(2026, 10, 1, 16, 0, 0)), '2026-11-02');
});

test('intimacy: 首次计分带签到分', () => {
  const record = viewer();
  const result = applyIntimacyAward(record, 'gift', 5, DAY1);
  assert.equal(result.gained, 8); // 5 + 签到 3
  assert.equal(result.points, 8);
  assert.equal(result.level, 1);
  assert.equal(result.bonus, 3);
  assert.equal(record.intimacy.dayKey, '2026-11-01');
  assert.equal(record.intimacy.streak, 1);
  assert.equal(record.intimacy.multiplier, 1);
});

test('intimacy: 同一天不重复给签到分', () => {
  const record = viewer();
  applyIntimacyAward(record, 'gift', 5, DAY1);
  const second = applyIntimacyAward(record, 'chat', 1, DAY1_LATER);
  assert.equal(second.gained, 1);
  assert.equal(second.points, 9);
  assert.equal(second.bonus, 0);
});

test('intimacy: 连续到场第二天起 1.2 倍', () => {
  const record = viewer(8, '2026-10-31', 1);
  const result = applyIntimacyAward(record, 'chat', 1, DAY1);
  // (1 + 签到 3) × 1.2 = 4.8 → 5
  assert.equal(result.gained, 5);
  assert.equal(record.intimacy.multiplier, 1.2);
  assert.equal(record.intimacy.streak, 2);
});

test('intimacy: 断签后连续天数从 1 重新计', () => {
  const record = viewer(8, '2026-10-29', 4);
  applyIntimacyAward(record, 'chat', 1, DAY1);
  assert.equal(record.intimacy.streak, 1);
  assert.equal(record.intimacy.multiplier, 1);
});

test('intimacy: 弹幕每分钟最多计 6 分', () => {
  const record = viewer();
  let total = 0;
  for (let i = 0; i < 8; i += 1) {
    const result = applyIntimacyAward(record, 'chat', 1, DAY1 + i * 1000);
    if (i < 6) assert.equal(result.gained > 0, true);
    else assert.equal(result.gained, 0);
    total += result.gained;
  }
  // 首次 1 + 签到 3，之后 5 次各 1 → 9 分
  assert.equal(total, 9);
  assert.equal(record.intimacy.points, 9);
  // 跨到下一分钟后额度恢复
  const nextMinute = applyIntimacyAward(record, 'chat', 1, DAY1 + 61000);
  assert.equal(nextMinute.gained, 1);
});

test('intimacy: 点赞单次最多 5 分、每分钟最多 10 分', () => {
  const record = viewer();
  // 单次封顶 5 分由 intimacyAwardForEvent 完成，这里传的是换算后的分值
  const first = applyIntimacyAward(record, 'like', 5, DAY1);
  assert.equal(first.gained, 8); // 5 + 签到 3
  const second = applyIntimacyAward(record, 'like', 5, DAY1 + 5000);
  assert.equal(second.gained, 5);
  const third = applyIntimacyAward(record, 'like', 5, DAY1 + 9000);
  assert.equal(third.gained, 0);
  // 跨到下一分钟后额度恢复
  const nextMinute = applyIntimacyAward(record, 'like', 5, DAY1 + 61000);
  assert.equal(nextMinute.gained, 5);
});

test('intimacy: 关注分只给一次', () => {
  const record = viewer();
  const first = applyIntimacyAward(record, 'follow', 10, DAY1);
  assert.equal(first.gained, 13); // 10 + 签到 3
  const again = applyIntimacyAward(record, 'follow', 10, DAY2);
  assert.equal(again.gained, 0);
  assert.equal(again.levelUp, false);
});

test('intimacy: 送礼差额为 0 不涨分', () => {
  const record = viewer(5, '2026-11-01', 1);
  const result = applyIntimacyAward(record, 'gift', 0, DAY1_LATER);
  assert.equal(result.gained, 0);
  assert.equal(record.intimacy.points, 5);
});

test('intimacy: 跨等级时标记 levelUp 并带上颜色', () => {
  const record = viewer(8, '2026-11-01', 1);
  const chat = applyIntimacyAward(record, 'chat', 1, DAY1_LATER);
  assert.equal(chat.level, 1);
  const gift = applyIntimacyAward(record, 'gift', 1, DAY1 + 5 * 60 * 1000);
  assert.equal(gift.points, 10);
  assert.equal(gift.level, 2);
  assert.equal(gift.title, '眼熟');
  assert.equal(gift.levelUp, true);
  assert.ok(String(gift.color).startsWith('#'));
});

test('intimacy: 升级播报与专属话术', () => {
  assert.equal(levelUpLine('小明', { levelUp: true, level: 2, title: '眼熟' }), '@小明 亲密度升到二级·眼熟啦！');
  assert.equal(levelUpLine('小明', { levelUp: false, level: 2, title: '眼熟' }), '');
  assert.equal(intimacySpokenLevel(5), '五级');
  assert.equal(intimacySpokenLevel(10), '十级');

  const low = viewer(20);
  assert.equal(intimacyWelcomeTail(low), '');
  assert.equal(intimacyGiftTail(low), '');
  const high = viewer(90);
  assert.equal(intimacyWelcomeTail(high), '你现在是五级老饭友啦～');
  assert.equal(intimacyGiftTail(high), '五级老饭友又来喂饭啦～');
});

test('intimacy: 事件换算与防刷口径', () => {
  assert.deepEqual(intimacyAwardForEvent({ type: 'chat' }), { source: 'chat', amount: 1 });
  assert.deepEqual(intimacyAwardForEvent({ type: 'like', like: { count: 9 } }), { source: 'like', amount: 5 });
  assert.deepEqual(intimacyAwardForEvent({ type: 'like', like: { count: 1 } }), { source: 'like', amount: 1 });
  assert.deepEqual(intimacyAwardForEvent({ type: 'gift' }, 3), { source: 'gift', amount: 3 });
  assert.deepEqual(intimacyAwardForEvent({ type: 'follow' }), { source: 'follow', amount: 10 });
  assert.equal(intimacyAwardForEvent({ type: 'member' }), null);
  assert.equal(intimacyAwardForEvent(null), null);
  assert.deepEqual(intimacyAwardForSong(), { source: 'song', amount: 5 });
});

test('intimacy: 等级标识与旧数据兼容', () => {
  assert.equal(intimacyBadge(null), null);
  assert.equal(intimacyBadge({ intimacy: { points: 0 } }), null);
  const badge = intimacyBadge(viewer(150));
  assert.equal(badge.level, 6);
  assert.equal(badge.title, '喂饭官');
  assert.equal(badge.points, 150);

  // 旧存档没有字段时不报错，按 0 分处理
  const empty = normalizeIntimacy(undefined);
  assert.equal(empty.points, 0);
  assert.equal(empty.level, 1);
  assert.equal(empty.streak, 0);
  assert.equal(normalizeIntimacy({ points: '120' }).points, 120);
  assert.equal(normalizeIntimacy({ points: -5 }).points, 0);
});
