import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canSendNow,
  createState,
  noteSentText,
  normalizeRule,
  planReplies,
  pruneState,
  reserveSend,
  ruleMatches,
} from '../extension/app/core/rules.js';
import { mergeSettings } from '../extension/app/core/store.js';
import { renderTemplate } from '../extension/app/core/template.js';

const NOW = 1_700_000_000_000;

function settings(patch = {}) {
  return mergeSettings({
    replyCooldownMs: 0,
    maxRepliesPerMin: 100,
    maxRepliesPerUserPerMin: 100,
    maxRulesPerEvent: 1,
    ...patch,
  });
}

function chatEvent(patch = {}) {
  return {
    id: 'WebcastChatMessage:1',
    type: 'chat',
    ts: NOW,
    content: '主播这个多少钱',
    user: { id: 'u1', nickname: '小明' },
    ...patch,
  };
}

function keywordRule(patch = {}) {
  return normalizeRule({
    id: 'r-keyword',
    name: '关键词',
    enabled: true,
    scope: 'chat',
    matchMode: 'contains',
    patterns: ['多少钱'],
    replies: ['{nickname} 点击小黄车看价格~'],
    cooldownSec: 0,
    maxPerMin: 100,
    ...patch,
  });
}

test('模板支持变量与随机选项', () => {
  assert.equal(renderTemplate('欢迎 {nickname}！', { nickname: '小明' }), '欢迎 小明！');
  assert.equal(renderTemplate('{{你好|哈喽}} {nickname}', { nickname: 'A' }, () => 0), '你好 A');
  assert.equal(renderTemplate('{{你好|哈喽}} {nickname}', { nickname: 'A' }, () => 0.99), '哈喽 A');
  assert.equal(renderTemplate('未知 {missing}', {}), '未知 {missing}');
});

test('关键词命中并渲染回复', () => {
  const state = createState();
  const { plans } = planReplies({
    event: chatEvent(),
    rules: [keywordRule()],
    state,
    settings: settings(),
    nowMs: NOW,
  });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].text, '小明 点击小黄车看价格~');
  assert.equal(plans[0].ruleId, 'r-keyword');
});

test('规则回复里的 {nickname} 遇到不良昵称替换为中性称呼', () => {
  const state = createState();
  const { plans } = planReplies({
    event: chatEvent({ user: { id: 'u9', nickname: '傻逼' } }),
    rules: [keywordRule()],
    state,
    settings: settings(),
    nowMs: NOW,
  });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].text, '朋友 点击小黄车看价格~');
  assert.ok(!plans[0].text.includes('傻逼'));
});

test('未命中关键词不回复', () => {
  const state = createState();
  const { plans } = planReplies({
    event: chatEvent({ content: '主播好漂亮' }),
    rules: [keywordRule()],
    state,
    settings: settings(),
    nowMs: NOW,
  });
  assert.equal(plans.length, 0);
});

test('规则冷却阻止短时间重复回复', () => {
  const state = createState();
  const rule = keywordRule({ cooldownSec: 10 });
  const first = planReplies({ event: chatEvent(), rules: [rule], state, settings: settings(), nowMs: NOW });
  assert.equal(first.plans.length, 1);

  const second = planReplies({ event: chatEvent(), rules: [rule], state, settings: settings(), nowMs: NOW + 1000 });
  assert.equal(second.plans.length, 0);
  assert.equal(second.skipped[0].reason, '规则冷却中');

  const third = planReplies({ event: chatEvent(), rules: [rule], state, settings: settings(), nowMs: NOW + 11000 });
  assert.equal(third.plans.length, 1);
});

test('每人一次的限制生效', () => {
  const state = createState();
  const rule = keywordRule({ perUserOnce: true, cooldownSec: 0 });
  assert.equal(planReplies({ event: chatEvent(), rules: [rule], state, settings: settings(), nowMs: NOW }).plans.length, 1);
  assert.equal(
    planReplies({ event: chatEvent({ id: 'x2' }), rules: [rule], state, settings: settings(), nowMs: NOW + 120000 })
      .plans.length,
    0,
  );
  assert.equal(
    planReplies({
      event: chatEvent({ id: 'x3', user: { id: 'u2', nickname: '小红' } }),
      rules: [rule],
      state,
      settings: settings(),
      nowMs: NOW,
    }).plans.length,
    1,
  );
});

test('全局每分钟上限与每用户上限', () => {
  const state = createState();
  const rule = keywordRule({ cooldownSec: 0, maxPerMin: 100 });
  const limit = settings({ maxRepliesPerMin: 1 });
  assert.equal(planReplies({ event: chatEvent(), rules: [rule], state, settings: limit, nowMs: NOW }).plans.length, 1);
  const second = planReplies({
    event: chatEvent({ id: 'x2', user: { id: 'u2', nickname: 'B' } }),
    rules: [rule],
    state,
    settings: limit,
    nowMs: NOW + 1000,
  });
  assert.equal(second.plans.length, 0);
  assert.match(second.skipped[0].reason, /每分钟/);

  const state2 = createState();
  const perUser = settings({ maxRepliesPerUserPerMin: 1 });
  assert.equal(planReplies({ event: chatEvent(), rules: [rule], state: state2, settings: perUser, nowMs: NOW }).plans.length, 1);
  const again = planReplies({
    event: chatEvent({ id: 'x3' }),
    rules: [rule],
    state: state2,
    settings: perUser,
    nowMs: NOW + 2000,
  });
  assert.equal(again.plans.length, 0);
  assert.match(again.skipped[0].reason, /该用户/);
});

test('礼物规则支持礼物名与最低数量过滤', () => {
  const rule = normalizeRule({
    id: 'r-gift',
    name: '礼物',
    scope: 'gift',
    matchMode: 'any',
    replies: ['谢谢 {nickname} 的{gift}'],
    giftNames: ['小心心'],
    minGiftCount: 2,
    cooldownSec: 0,
    maxPerMin: 100,
  });
  const giftEvent = (patch = {}) => ({
    id: 'g1',
    type: 'gift',
    ts: NOW,
    user: { id: 'u1', nickname: '土豪' },
    gift: { name: '小心心', count: 2 },
    canReply: true,
    ...patch,
  });

  assert.equal(ruleMatches(rule, giftEvent()), true);
  assert.equal(ruleMatches(rule, giftEvent({ gift: { name: '小心心', count: 1 } })), false);
  assert.equal(ruleMatches(rule, giftEvent({ gift: { name: '大火箭', count: 5 } })), false);
  assert.equal(ruleMatches(rule, giftEvent({ canReply: false })), false);

  const state = createState();
  const { plans } = planReplies({ event: giftEvent(), rules: [rule], state, settings: settings(), nowMs: NOW });
  assert.equal(plans[0].text, '谢谢 土豪 的小心心');
});

test('进场欢迎与关注答谢规则', () => {
  const welcome = normalizeRule({
    id: 'r-welcome',
    name: '欢迎',
    scope: 'member',
    matchMode: 'any',
    replies: ['欢迎 {nickname}'],
    cooldownSec: 0,
  });
  const follow = normalizeRule({
    id: 'r-follow',
    name: '关注',
    scope: 'follow',
    matchMode: 'any',
    replies: ['感谢关注 {nickname}'],
    cooldownSec: 0,
  });
  const state = createState();
  const enter = planReplies({
    event: { id: 'm1', type: 'member', ts: NOW, user: { id: 'u9', nickname: '新观众' }, member: { actionDescription: '进入了直播间' } },
    rules: [welcome, follow],
    state,
    settings: settings(),
    nowMs: NOW,
  });
  assert.equal(enter.plans.length, 1);
  assert.equal(enter.plans[0].text, '欢迎 新观众');

  const state2 = createState();
  const followed = planReplies({
    event: { id: 'f1', type: 'follow', ts: NOW, user: { id: 'u8', nickname: '粉丝' }, social: { action: 1, followCount: 1 } },
    rules: [follow],
    state: state2,
    settings: settings(),
    nowMs: NOW,
  });
  assert.equal(followed.plans[0].text, '感谢关注 粉丝');
});

test('进场的 actionDescription 含“关注”时也能触发关注规则', () => {
  const follow = normalizeRule({
    id: 'r-follow2',
    name: '关注',
    scope: 'follow',
    matchMode: 'any',
    replies: ['谢谢关注'],
    cooldownSec: 0,
  });
  const event = {
    id: 'm2',
    type: 'member',
    ts: NOW,
    user: { id: 'u7', nickname: 'X' },
    member: { actionDescription: '关注了主播' },
  };
  assert.equal(ruleMatches(follow, event), true);
});

test('屏蔽词、屏蔽用户与自己回复的回显不会触发回复', () => {
  const state = createState();
  const rule = keywordRule();
  const s = settings({ blockedKeywords: ['广告'], blockedUsers: ['机器人'] });

  const blockedWord = planReplies({
    event: chatEvent({ content: '多少钱 广告' }),
    rules: [rule],
    state,
    settings: s,
    nowMs: NOW,
  });
  assert.equal(blockedWord.plans.length, 0);

  const blockedUser = planReplies({
    event: chatEvent({ user: { id: 'bot', nickname: '机器人' } }),
    rules: [rule],
    state,
    settings: s,
    nowMs: NOW,
  });
  assert.equal(blockedUser.plans.length, 0);

  noteSentText(state, '小明 点击小黄车看价格~', NOW);
  const echo = planReplies({
    event: chatEvent({ content: '小明 点击小黄车看价格~', user: { id: 'me', nickname: '我' } }),
    rules: [keywordRule({ patterns: ['小黄车'] })],
    state,
    settings: s,
    nowMs: NOW + 1000,
  });
  assert.equal(echo.plans.length, 0);
});

test('主播自己的昵称 / 用户 ID 不会触发自动回复', () => {
  const state = createState();
  const rule = keywordRule();
  const s = settings({ myNickname: '主播小美', myUserId: '10086' });

  const byName = planReplies({
    event: chatEvent({ user: { id: 'u100', nickname: '主播小美' } }),
    rules: [rule],
    state,
    settings: s,
    nowMs: NOW,
  });
  assert.equal(byName.plans.length, 0);

  const byId = planReplies({
    event: chatEvent({ id: 'self-2', user: { id: '10086', nickname: '换了个昵称' } }),
    rules: [rule],
    state,
    settings: s,
    nowMs: NOW,
  });
  assert.equal(byId.plans.length, 0);

  const viewer = planReplies({
    event: chatEvent({ id: 'viewer-1', user: { id: 'u200', nickname: '观众甲' } }),
    rules: [rule],
    state,
    settings: s,
    nowMs: NOW,
  });
  assert.equal(viewer.plans.length, 1);
});

test('按顺序轮换回复', () => {
  const state = createState();
  const rule = keywordRule({ replyMode: 'sequence', replies: ['A', 'B'], cooldownSec: 0, maxPerMin: 100 });
  const s = settings();
  const first = planReplies({ event: chatEvent(), rules: [rule], state, settings: s, nowMs: NOW });
  const second = planReplies({ event: chatEvent({ id: 'c2' }), rules: [rule], state, settings: s, nowMs: NOW + 1 });
  assert.equal(first.plans[0].text, 'A');
  assert.equal(second.plans[0].text, 'B');
});

test('回复长度受 maxReplyChars 限制', () => {
  const state = createState();
  const rule = keywordRule({ replies: ['这是一条非常非常非常长的回复内容用于测试截断逻辑'] });
  const { plans } = planReplies({
    event: chatEvent(),
    rules: [rule],
    state,
    settings: settings({ maxReplyChars: 10 }),
    nowMs: NOW,
  });
  assert.equal(Array.from(plans[0].text).length, 10);
});

test('AI 等外部路径可复用限流检查', () => {
  const state = createState();
  const s = settings({ replyCooldownMs: 5000, maxRepliesPerMin: 1 });
  assert.equal(canSendNow(state, s, { userId: 'u1', nowMs: NOW }), null);
  reserveSend(state, s, { userId: 'u1', nowMs: NOW });
  assert.match(canSendNow(state, s, { userId: 'u1', nowMs: NOW + 100 }), /间隔/);
  assert.match(canSendNow(state, s, { userId: 'u2', nowMs: NOW + 6000 }), /每分钟/);
});

test('pruneState 清理过期限流记录', () => {
  const state = createState();
  state.globalTimes = [NOW - 120000, NOW - 1000];
  state.userTimes.set('u1', [NOW - 120000, NOW - 1000]);
  state.echoes = [
    { text: 'old', ts: NOW - 120000 },
    { text: 'new', ts: NOW - 1000 },
  ];
  pruneState(state, NOW);
  assert.deepEqual(state.globalTimes, [NOW - 1000]);
  assert.deepEqual(state.userTimes.get('u1'), [NOW - 1000]);
  assert.deepEqual(state.echoes.map((item) => item.text), ['new']);
});
