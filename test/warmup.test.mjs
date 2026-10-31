import test from 'node:test';
import assert from 'node:assert/strict';

import { isFollowAsk, isTokenWarmup, isViewerPresent, pickWarmupLine, pickWarmupPreset, pickWarmupPresetInfo, stripFollowAsk, WARMUP_LINES, WARMUP_VIEWER_LINES, warmupTrigger } from '../extension/app/core/warmup.js';

const NOW = 1_800_000_000_000;

function config(patch = {}) {
  return {
    enabled: true,
    idleSec: 120,
    lowViewerThreshold: 10,
    lowViewerSec: 45,
    minIntervalSec: 180,
    maxPerHour: 10,
    ...patch,
  };
}

test('暖场未启用时不触发', () => {
  const result = warmupTrigger({
    config: config({ enabled: false }),
    now: NOW,
    lastChatAt: NOW - 600000,
  });
  assert.equal(result, null);
});

test('未达到无人说话时长不触发', () => {
  const result = warmupTrigger({
    config: config(),
    online: 100,
    now: NOW,
    lastChatAt: NOW - 50000,
  });
  assert.equal(result, null);
});

test('无人说话超时触发', () => {
  const result = warmupTrigger({
    config: config(),
    online: 100,
    now: NOW,
    lastChatAt: NOW - 130000,
    lastWarmupAt: NOW - 1000000,
  });
  assert.ok(result);
  assert.equal(result.reason, 'idle');
  assert.equal(result.idleSec, 130);
});

test('人少时更早触发', () => {
  const result = warmupTrigger({
    config: config(),
    online: 3,
    now: NOW,
    lastChatAt: NOW - 50000,
    lastWarmupAt: NOW - 1000000,
  });
  assert.ok(result);
  assert.equal(result.reason, 'low-viewers');
  assert.equal(result.requiredSec, 45);
});

test('最短间隔与每小时上限会阻止暖场', () => {
  const tooSoon = warmupTrigger({
    config: config(),
    online: 3,
    now: NOW,
    lastChatAt: NOW - 200000,
    lastWarmupAt: NOW - 10000,
  });
  assert.equal(tooSoon, null);

  const tooMany = warmupTrigger({
    config: config({ maxPerHour: 2 }),
    online: 3,
    now: NOW,
    lastChatAt: NOW - 200000,
    lastWarmupAt: NOW - 200000,
    warmupTimes: [NOW - 1000, NOW - 2000],
  });
  assert.equal(tooMany, null);
});

test('兜底文案不会连续重复', () => {
  const first = pickWarmupLine([], () => 0);
  assert.equal(first, WARMUP_LINES[0]);
  const next = pickWarmupLine([first], () => 0);
  assert.notEqual(next, first);
  const allRecent = pickWarmupLine(WARMUP_LINES, () => 0);
  assert.ok(WARMUP_LINES.includes(allRecent));
});

test('暖场可以带随机观众昵称（@昵称格式）', () => {
  const line = pickWarmupLine([], () => 0, '小明');
  assert.equal(line, WARMUP_VIEWER_LINES[0].replace('{name}', '@小明'));
  assert.match(line, /@小明/);
});

test('预设暖场语支持昵称并避开刚用过的', () => {
  const presets = ['欢迎{name}来到直播间', '大家晚上好呀'];
  assert.equal(pickWarmupPreset(presets, [], () => 0, '小明'), '欢迎@小明来到直播间');
  const second = pickWarmupPreset(presets, ['欢迎@小明来到直播间'], () => 0, '小明');
  assert.equal(second, '大家晚上好呀');
  assert.equal(
    pickWarmupPreset(presets, ['欢迎@小明来到直播间', '大家晚上好呀'], () => 0, '小明'),
    '',
  );
});

test('预设没有 {name} 时不强行加观众名', () => {
  const plain = pickWarmupPresetInfo(['大家晚上好呀'], [], () => 0, '小明');
  assert.equal(plain.hasName, false);
  assert.equal(plain.text, '大家晚上好呀');
  const named = pickWarmupPresetInfo(['欢迎{name}来到直播间'], [], () => 0, '小明');
  assert.equal(named.hasName, true);
  assert.equal(named.text, '欢迎@小明来到直播间');
});

test('已经关注的观众不会再被劝关注', () => {
  const line = pickWarmupLine([], () => 0, '小明', true);
  assert.ok(!line.includes('关注'), line);

  const presets = ['欢迎{name}来到直播间，点点关注不迷路', '晚上好呀{name}，来聊聊天'];
  const preset = pickWarmupPresetInfo(presets, [], () => 0, '小明', true);
  assert.ok(!preset.text.includes('关注'), preset.text);
  assert.match(preset.text, /@小明/);
});

test('已关注观众的文案会剔除劝关注分句', () => {
  assert.equal(isFollowAsk('晚上好呀，点点关注不迷路～'), true);
  assert.equal(isFollowAsk('顺手点个关注呗'), true);
  assert.equal(isFollowAsk('谢谢你的关注！'), false);
  assert.equal(isFollowAsk('感谢大家的关注'), false);
  assert.equal(isFollowAsk('今天想聊点什么呀'), false);
  assert.equal(
    stripFollowAsk('pentaa 来啦，顺手点个关注，扣个1陪鱼聊两句呗'),
    'pentaa 来啦，扣个1陪鱼聊两句呗',
  );
  assert.equal(stripFollowAsk('顺手点个关注'), '');
  assert.equal(stripFollowAsk('@云镜，关注鲸鱼娘好不好！'), '');
  assert.equal(stripFollowAsk('谢谢老板的关注，今天想听什么歌'), '谢谢老板的关注，今天想听什么歌');
  assert.equal(
    stripFollowAsk('谢谢关注，没点关注的记得点点关注，陪你唠两句'),
    '谢谢关注，陪你唠两句',
  );
});

test('暖场说到 token来 时触发 token 汇聚动画', () => {
  assert.equal(isTokenWarmup('token来，token来！'), true);
  assert.equal(isTokenWarmup('TOKEN 来！'), true);
  assert.equal(isTokenWarmup('@小明，token来啦'), true);
  assert.equal(isTokenWarmup('大家晚上好呀'), false);
  assert.equal(isTokenWarmup(''), false);
  assert.ok(WARMUP_LINES.includes('token来，token来！'));
});

test('只和还在直播间的观众打招呼', () => {
  const audience = new Map([
    ['u1', NOW],
    ['在场观众', NOW],
  ]);
  const base = { id: 'u1', name: '在场观众', lastSeen: NOW - 5 * 60 * 1000 };
  // 在在线名单里，5 分钟没说话也算在场
  assert.equal(isViewerPresent(base, audience, NOW, NOW), true);
  // 不在名单里、5 分钟没互动：已经离开，不再打招呼
  assert.equal(isViewerPresent({ ...base, id: 'u2', name: '离开的人' }, audience, NOW, NOW), false);
  // 不在名单里，但 30 秒内刚互动过，按在场处理
  assert.equal(isViewerPresent({ ...base, id: 'u3', name: '刚说话的人', lastSeen: NOW - 30 * 1000 }, audience, NOW, NOW), true);
  // 名单过期后改用最近互动兜底：90 秒内算在场
  assert.equal(isViewerPresent({ ...base, id: 'u4', name: '路人', lastSeen: NOW - 60 * 1000 }, new Map(), 0, NOW), true);
  assert.equal(isViewerPresent({ ...base, id: 'u5', name: '走远的人', lastSeen: NOW - 5 * 60 * 1000 }, new Map(), 0, NOW), false);
});