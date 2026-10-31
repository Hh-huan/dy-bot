import test from 'node:test';
import assert from 'node:assert/strict';

import {
  displayBubbleTarget,
  matchBubbleTarget,
  matchSelfBubble,
  normalizeBubbleTarget,
  parseThrowIntent,
} from '../extension/app/core/throwIntent.js';

test('甩飞：识别「甩飞/扔飞/丢飞/抛飞」等同类说法', () => {
  const cases = [
    ['甩飞糖糖', '糖糖'],
    ['扔飞小鹿', '小鹿'],
    ['丢飞糖糖', '糖糖'],
    ['抛飞小鹿', '小鹿'],
    ['甩糖糖出去', '糖糖'],
    ['扔小鹿出去吧', '小鹿'],
    ['丢糖糖走', '糖糖'],
  ];
  for (const [input, target] of cases) {
    const intent = parseThrowIntent(input);
    assert.ok(intent, input);
    assert.equal(intent.target, target, input);
  }
});

test('甩飞：支持「把/将」前置语序与礼貌前缀', () => {
  const cases = [
    ['把糖糖甩飞', '糖糖'],
    ['把糖糖甩飞吧', '糖糖'],
    ['将小鹿扔出去', '小鹿'],
    ['把糖糖抛飞了', '糖糖'],
    ['请甩飞糖糖', '糖糖'],
    ['快帮我扔飞小鹿', '小鹿'],
    ['麻烦你把糖糖丢飞一下', '糖糖'],
  ];
  for (const [input, target] of cases) {
    const intent = parseThrowIntent(input);
    assert.ok(intent, input);
    assert.equal(intent.target, target, input);
  }
});

test('甩飞：@ 与全角 ＠ 格式标准化', () => {
  assert.equal(parseThrowIntent('甩飞@糖糖').target, '糖糖');
  assert.equal(parseThrowIntent('甩飞 ＠小鹿').target, '小鹿');
  assert.equal(parseThrowIntent('把@糖 糖 甩飞').target, '糖糖');
  assert.equal(parseThrowIntent('甩飞@糖糖！').target, '糖糖');
  assert.equal(parseThrowIntent('甩飞@糖糖🍬').normalized, '糖糖');
  assert.equal(parseThrowIntent('甩飞 糖糖 一下').target, '糖糖');
});

test('甩飞：问句、否定、无目标、无关语句不误识别', () => {
  const cases = [
    '',
    '   ',
    '甩飞',
    '甩飞吧',
    '甩飞了一下',
    '不要甩飞糖糖',
    '别把糖糖甩飞',
    '怎么甩飞人',
    '甩飞是什么玩法',
    '甩飞规则是什么',
    '糖糖被甩飞了',
    '主播今天好漂亮',
    '点歌 晴天',
    '播放 甩飞',
    '甩飞是谁',
    '把糖糖甩飞了吗',
    '扔飞盘',
    '丢飞镖',
    '甩飞吻',
    '把飞盘甩飞',
    '将纸飞机扔出去',
    '把锅甩飞',
  ];
  for (const input of cases) {
    assert.equal(parseThrowIntent(input), null, input);
  }
});

test('甩飞：超长弹幕不解析，避免误吞正常聊天', () => {
  const long = `甩飞${'糖'.repeat(40)}`;
  assert.equal(parseThrowIntent(long), null);
});

test('甩飞：目标标准化只保留中英文数字下划线', () => {
  assert.equal(normalizeBubbleTarget('@糖糖 丶Nice!!'), '糖糖nice');
  assert.equal(normalizeBubbleTarget('＠小 鹿_01'), '小鹿_01');
  assert.equal(normalizeBubbleTarget('🍬🍬'), '');
  assert.equal(displayBubbleTarget('@糖 糖'), '糖糖');
  assert.equal(displayBubbleTarget('＠小鹿'), '小鹿');
});

test('甩飞：气泡流匹配优先级为 完全一致 > 前缀 > 包含', () => {
  const bubbles = [
    { key: 'u1', name: '糖糖糖', rice: 50 },
    { key: 'u2', name: '糖糖', rice: 1 },
    { key: 'u3', name: '小糖', rice: 9 },
  ];
  // 完全一致优先级最高，白饭更多的前缀命中不会抢走精确匹配
  assert.equal(matchBubbleTarget('糖糖', bubbles).key, 'u2');
  // 「糖」对「糖糖」「糖糖糖」都是前缀命中，同级按白饭数降序
  assert.equal(matchBubbleTarget('糖', bubbles).key, 'u1');
  assert.equal(matchBubbleTarget('小糖糖', bubbles), null);
  assert.equal(matchBubbleTarget('小', bubbles).key, 'u3');
});

test('甩飞：同级多人命中按白饭数、名字长度、字典序确定性排序', () => {
  const bubbles = [
    { key: 'u1', name: '小鹿', rice: 3 },
    { key: 'u2', name: '小糖', rice: 7 },
    { key: 'u3', name: '小鹿鹿', rice: 3 },
  ];
  assert.equal(matchBubbleTarget('小', bubbles).key, 'u2');
  const sameRice = [
    { key: 'u3', name: '小鹿鹿', rice: 3 },
    { key: 'u1', name: '小鹿', rice: 3 },
  ];
  assert.equal(matchBubbleTarget('小', sameRice).key, 'u1');
  // 顺序颠倒也必须得到同一个结果
  assert.equal(matchBubbleTarget('小', [...sameRice].reverse()).key, 'u1');
});

test('甩飞：@ 目标在气泡流中按标准化结果匹配', () => {
  const bubbles = [{ key: 'u1', name: '糖糖', rice: 2 }];
  assert.equal(matchBubbleTarget('@糖糖', bubbles).key, 'u1');
  assert.equal(matchBubbleTarget('＠糖 糖', bubbles).key, 'u1');
  assert.equal(matchBubbleTarget('糖糖🍬', bubbles).key, 'u1');
});

test('甩飞：气泡流为空、目标为空、名单缺字段时不命中', () => {
  assert.equal(matchBubbleTarget('糖糖', []), null);
  assert.equal(matchBubbleTarget('', [{ key: 'u1', name: '糖糖', rice: 1 }]), null);
  assert.equal(matchBubbleTarget('@', [{ key: 'u1', name: '糖糖', rice: 1 }]), null);
  assert.equal(matchBubbleTarget('糖糖', [{ name: '糖糖', rice: 1 }]), null);
  assert.equal(matchBubbleTarget('糖糖', [{ key: 'u1', name: '', rice: 1 }]), null);
  assert.equal(matchBubbleTarget('糖糖', null), null);
});

test('甩飞：未满足白饭门槛的名单只能由调用方过滤，匹配阶段只认传入名单', () => {
  // 气泡流准入由背景板按白饭阈值过滤后下发；这里验证匹配不会自己去“捞人”
  const roster = [{ key: 'u1', name: '小鹿', rice: 4 }];
  assert.equal(matchBubbleTarget('糖糖', roster), null);
  assert.equal(matchBubbleTarget('小鹿', roster).rice, 4);
});

test('甩飞：支持「高高抛起/丢起/抛起」与「把 XXX 丢了出去」等扩展说法', () => {
  const cases = [
    ['高高抛起糖糖', '糖糖'],
    ['丢起糖糖', '糖糖'],
    ['抛起小鹿', '小鹿'],
    ['把糖糖丢了出去', '糖糖'],
    ['把糖糖丢出去', '糖糖'],
    ['将小鹿丢了出去吧', '小鹿'],
    ['把糖糖高高抛起', '糖糖'],
    ['把糖糖丢了起来', '糖糖'],
    ['丢出去 糖糖', '糖糖'],
    ['抛 糖糖 出去', '糖糖'],
  ];
  for (const [input, target] of cases) {
    const intent = parseThrowIntent(input);
    assert.ok(intent, input);
    assert.equal(intent.target, target, input);
    assert.equal(intent.self, false, input);
  }
});

test('甩飞：我自己/自己/我 指向发指令者', () => {
  for (const input of ['甩飞我自己', '把我丢出去', '高高抛起我自己', '把我自己扔飞', '甩飞自己', '把我抛起来']) {
    const intent = parseThrowIntent(input);
    assert.ok(intent, input);
    assert.equal(intent.self, true, input);
  }
  // 只是昵称里带「我」不算自己
  assert.equal(parseThrowIntent('甩飞我朋友').self, false);
  assert.equal(parseThrowIntent('甩飞我是一条鱼').self, false);
});

test('甩飞我自己：优先按用户 id 精确命中气泡，id 缺失时退回昵称', () => {
  const roster = [
    { key: '85616818710', name: 'pentaa', rice: 2 },
    { key: '3063656823129192', name: '云镜', rice: 7 },
  ];
  assert.equal(matchSelfBubble({ id: '85616818710', nickname: 'pentaa' }, roster).name, 'pentaa');
  // 弹幕没带 id，按昵称兜底
  assert.equal(matchSelfBubble({ nickname: 'pentaa' }, roster).name, 'pentaa');
  // id 与礼物记录不一致（同昵称不同账号）时也按昵称兜底
  assert.equal(matchSelfBubble({ id: '999', nickname: 'pentaa' }, roster).name, 'pentaa');
  // 既没 id 也不在名单里
  assert.equal(matchSelfBubble({ id: '999', nickname: '路人' }, roster), null);
  assert.equal(matchSelfBubble(null, roster), null);
  assert.equal(matchSelfBubble({ id: '1' }, []), null);
});

test('甩飞：向上抛的物品短语与无目标说法不误识别', () => {
  const cases = ['高高抛起', '丢起', '抛起来', '把锅丢起来', '把飞盘高高抛起', '扔起飞盘', '怎么把我丢出去', '别把我丢出去'];
  for (const input of cases) {
    assert.equal(parseThrowIntent(input), null, input);
  }
});
