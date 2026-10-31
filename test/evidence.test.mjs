import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  filterVisitLedger,
  formatApologyReply,
  formatChainBrokenReply,
  formatEvidenceReply,
  formatEvidenceStamp,
  formatEvidenceTimeline,
  formatPendingReply,
  formatUnavailableReply,
  isVisitDispute,
  ledgerActionFromEvent,
} from '../extension/app/core/evidence.js';

const TS = new Date(2026, 9, 30, 15, 22, 41).getTime();

function sampleLedger(overrides = {}) {
  return {
    ok: true,
    total: 6,
    firstSeen: TS,
    lastSeen: TS + 3600000,
    counts: { enter: 2, chat: 1, like: 3, gift: 1, song: 1 },
    entries: [
      { seq: 1, ts: TS, action: 'enter', detail: '进入了直播间' },
      { seq: 2, ts: TS + 120000, action: 'chat', detail: '你好呀' },
      { seq: 3, ts: TS + 240000, action: 'like', detail: '点赞 ×5' },
      { seq: 4, ts: TS + 600000, action: 'gift', detail: '小心心×2' },
      { seq: 5, ts: TS + 1800000, action: 'song', detail: '晴天 - 周杰伦' },
      { seq: 9, ts: TS + 3000000, action: 'claim', detail: '记忆声明' },
    ],
    verified: true,
    ...overrides,
  };
}

test('访问争议：能识别否认访问/否认互动的弹幕', () => {
  for (const input of [
    '我没来过你直播间',
    '我没进过你直播间',
    '我从来没去过你的直播间',
    '我没有来过你直播间',
    '我压根没进过你的房间',
    '我没有来过你这',
    '我根本没来过这儿',
    '我没点过歌',
    '我没送过礼物',
    '我没给你点过赞',
    '我什么时候来过你直播间',
    '我啥时候进过你的直播间',
    '你记错了，我根本没来过',
    '你乱说',
    '你是不是记错人了',
  ]) {
    assert.equal(isVisitDispute(input), true, input);
  }
});

test('访问争议：普通提问和点歌指令不误判', () => {
  for (const input of [
    '今天天气不错',
    '记得我吗',
    '我昨天来过吗',
    '帮我点歌晴天',
    '想听雨爱',
    '我要听雨爱司风版',
    '切歌',
    '音量小一点',
    '主播唱歌真好听',
    '我什么时候去直播间等你',
    '我记错了，昨天点的是晴天',
  ]) {
    assert.equal(isVisitDispute(input), false, input);
  }
  assert.equal(isVisitDispute(''), false);
  assert.equal(isVisitDispute('我没来过'.padEnd(80, '啊')), false);
});

test('访问争议：留证台账事件映射', () => {
  assert.deepEqual(ledgerActionFromEvent({ type: 'member', member: { actionDescription: '进入了直播间' } }), {
    action: 'enter',
    detail: '进入了直播间',
  });
  assert.deepEqual(ledgerActionFromEvent({ type: 'chat', content: '  你好  世界 ' }), {
    action: 'chat',
    detail: '你好 世界',
  });
  assert.equal(ledgerActionFromEvent({ type: 'chat', content: '   ' }), null);
  assert.deepEqual(ledgerActionFromEvent({ type: 'gift', gift: { name: '小心心', count: 3 } }), {
    action: 'gift',
    detail: '小心心×3',
  });
  assert.deepEqual(ledgerActionFromEvent({ type: 'like', like: { count: 5 } }), {
    action: 'like',
    detail: '点赞 ×5',
  });
  assert.deepEqual(ledgerActionFromEvent({ type: 'follow' }), { action: 'follow', detail: '关注了主播' });
  assert.deepEqual(ledgerActionFromEvent({ type: 'share' }), { action: 'share', detail: '分享了直播间' });
  assert.equal(ledgerActionFromEvent({ type: 'stats' }), null);
  assert.equal(ledgerActionFromEvent(null), null);
});

test('访问争议：过滤审计记录，只统计真实访问行为', () => {
  const visit = filterVisitLedger(sampleLedger());
  assert.equal(visit.total, 6);
  assert.equal(visit.entries.length, 5, 'claim 记录不进时间线');
  assert.ok(visit.entries.every((entry) => entry.action !== 'claim'));
  assert.deepEqual(visit.counts, { enter: 2, chat: 1, like: 3, gift: 1, song: 1 });
  assert.equal(filterVisitLedger(null).total, 0);
  assert.equal(filterVisitLedger({ entries: [] }).total, 0);
});

test('访问争议：有记录时生成 ≤100 字的公屏证据摘要', () => {
  const reply = formatEvidenceReply(sampleLedger(), '小明');
  assert.match(reply, /小明/);
  assert.match(reply, /进入直播间/);
  assert.ok(reply.includes(formatEvidenceStamp(TS)), reply);
  assert.match(reply, /发言1次/);
  assert.match(reply, /点赞3次/);
  assert.match(reply, /点歌1次/);
  assert.match(reply, /共6条/);
  assert.match(reply, /哈希链校验通过/);
  assert.match(reply, /记录#1/);
  assert.ok(Array.from(reply).length <= 100, reply);

  assert.match(formatEvidenceReply(sampleLedger(), '小明', { verified: false }), /哈希链异常/);
  assert.equal(formatEvidenceReply(sampleLedger({ total: 0 }), '小明'), '');
  assert.equal(formatEvidenceReply(null, '小明'), '');
});

test('访问争议：完整时间线包含编号、秒级时间和行为内容', () => {
  const timeline = formatEvidenceTimeline(sampleLedger(), '小明');
  assert.match(timeline, /共 6 条行为记录，哈希链校验通过/);
  assert.match(timeline, /#1 .* 进入直播间/);
  assert.match(timeline, /#2 .* 发言「你好呀」/);
  assert.match(timeline, /#3 .* 点赞 ×5/);
  assert.match(timeline, /#4 .* 送礼 小心心×2/);
  assert.match(timeline, /#5 .* 点歌《晴天》 - 周杰伦/);
  assert.equal(timeline.split('\n').length, 6);

  const redacted = formatEvidenceTimeline(sampleLedger(), '小明', { redactChat: true });
  assert.doesNotMatch(redacted, /你好呀/);
  assert.match(redacted, /内容已按安全规则脱敏/);

  assert.match(formatEvidenceTimeline(sampleLedger(), '小明', { verified: false }), /需人工复核/);
});

test('访问争议：无记录时的正式致歉与中性兜底文案', () => {
  assert.match(formatApologyReply('小明'), /非常抱歉/);
  assert.match(formatApologyReply('小明'), /确实没有你的访问记录/);
  assert.match(formatApologyReply('小明'), /误判原因/);
  assert.match(formatApologyReply('小明'), /修正检测规则/);

  assert.match(formatUnavailableReply('小明'), /暂时查询不到/);
  assert.match(formatUnavailableReply('小明'), /不做主观判断/);

  assert.match(formatPendingReply('小明'), /暂未查到/);
  assert.match(formatPendingReply('小明'), /待核实/);
  assert.match(formatPendingReply('小明'), /暂不做判定/);

  assert.match(formatChainBrokenReply('小明'), /校验异常/);
  assert.match(formatChainBrokenReply('小明'), /转人工复核/);

  for (const text of [
    formatApologyReply('小明'),
    formatUnavailableReply('小明'),
    formatPendingReply('小明'),
    formatChainBrokenReply('小明'),
  ]) {
    assert.ok(Array.from(text).length <= 100, text);
  }
});

test('访问争议：时间戳格式固定为 MM-DD HH:mm:ss', () => {
  assert.match(formatEvidenceStamp(TS), /^\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(formatEvidenceStamp(0), '时间未知');
  assert.equal(formatEvidenceStamp(''), '时间未知');
});
