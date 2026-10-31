import test from 'node:test';
import assert from 'node:assert/strict';

import { SEGMENT_LIMITS, isCasualChat, splitReplySegments } from '../extension/app/core/segmentReply.js';
import { generateAiReply } from '../extension/app/core/ai.js';
import { mergeSettings } from '../extension/app/core/store.js';

const charLength = (text) => Array.from(String(text || '')).length;
const stripPunctuation = (text) =>
  String(text || '').replace(/[，,、：:；;。！？!?…\s"'“”‘’]/g, '');

function assertWithinLimits(segments, original) {
  assert.ok(Array.isArray(segments));
  assert.ok(segments.length <= SEGMENT_LIMITS.maxSegments);
  const total = segments.reduce((sum, segment) => sum + charLength(segment), 0);
  assert.ok(total <= SEGMENT_LIMITS.maxTotalChars, `总字数 ${total} 超过 90`);
  for (const segment of segments) {
    assert.ok(charLength(segment) <= SEGMENT_LIMITS.maxSegmentChars, `单条超过 30 字：${segment}`);
    assert.ok(segment.trim().length > 0, '不应出现空消息');
  }
  // 每条消息都必须是原回复中按顺序连续截取的内容，不能乱序或凭空拼接
  const source = stripPunctuation(original);
  let cursor = 0;
  for (const segment of segments) {
    const part = stripPunctuation(segment);
    if (!part) continue;
    const index = source.indexOf(part, cursor);
    assert.ok(index >= 0, `分段内容不是原文连续片段：${segment}`);
    cursor = index + part.length;
  }
}

test('闲聊识别：日常闲聊触发分段', () => {
  const casual = [
    '你好呀',
    '今天天气真好',
    '你今天开心吗',
    '吃了吗',
    '晚上好',
    '你叫什么名字',
    '你多大了',
    '在干嘛呢',
    '你今天真好看',
    '你声音真好听',
    '你唱歌真好听',
    '我会一直关注你',
    '时间过得真快',
    'I love you',
    'how are you today',
  ];
  for (const content of casual) {
    assert.equal(isCasualChat(content), true, content);
  }
});

test('闲聊识别：功能、指令、任务型消息不触发分段', () => {
  const functional = [
    '帮我查一下代码',
    '这个bug怎么解决',
    '你能帮我修一下这个报错吗',
    '点歌 晴天',
    '播放 晴天',
    '切歌',
    '现在几点',
    '今天几号',
    '你还记得我吗',
    '音量调到50%',
    '今天白饭多少',
    '帮我写个脚本',
    '配置怎么改',
    '报错了怎么办',
    '推荐一首歌',
    '甩飞糖糖',
    '插队要送什么',
    '怎么点歌',
    '跳舞口令是什么',
    'online viewers 现在多少',
    'please fix this bug',
  ];
  for (const content of functional) {
    assert.equal(isCasualChat(content), false, content);
  }
});

test('分段：正常情况下按句号等自然停顿拆成多条消息', () => {
  const original = '你好呀！今天过得怎么样？我刚吃了白饭，好开心。';
  const segments = splitReplySegments(original);
  assert.equal(segments.length, 3);
  assert.deepEqual(segments, ['你好呀！', '今天过得怎么样？', '我刚吃了白饭，好开心。']);
  assertWithinLimits(segments, original);
});

test('分段：单句过长时按逗号停顿拆分，不截断句子内部', () => {
  const original =
    '我今天看到好多可爱的观众来直播间陪我聊天，大家还一起点了喜欢的歌，真的特别开心。';
  const segments = splitReplySegments(original);
  assert.equal(segments.length, 3);
  assert.deepEqual(segments, [
    '我今天看到好多可爱的观众来直播间陪我聊天',
    '大家还一起点了喜欢的歌',
    '真的特别开心。',
  ]);
  assertWithinLimits(segments, original);
});

test('分段：单句较长且含逗号停顿时也会拆成多条', () => {
  const original = '你说什么我听不懂，但是感觉你很厉害，可以再说一遍吗？';
  const segments = splitReplySegments(original);
  assert.equal(segments.length, 3);
  assert.deepEqual(segments, ['你说什么我听不懂', '但是感觉你很厉害', '可以再说一遍吗？']);
  assertWithinLimits(segments, original);
});

test('分段：消息数量最多 3 条', () => {
  const original =
    '第一条消息在这里。第二条消息也在这里。第三条消息继续在这里。第四条消息还在这里。第五条消息最后在这里。';
  const segments = splitReplySegments(original);
  assert.ok(segments.length <= 3);
  assertWithinLimits(segments, original);
});

test('分段：总字数超过 90 时自动收敛到上限', () => {
  const original = Array.from({ length: 6 }, () => '这是一段二十个字左右的闲聊内容用于测试总长度限制').join('');
  assert.ok(charLength(original) > 90);
  const segments = splitReplySegments(original);
  assert.ok(segments.length <= 3);
  assertWithinLimits(segments, original);
});

test('分段：短回复和单段回复保持原意', () => {
  assert.deepEqual(splitReplySegments('你好呀'), ['你好呀']);
  assert.deepEqual(splitReplySegments('在的，我一直都在呢。'), ['在的，我一直都在呢。']);
  assert.deepEqual(splitReplySegments(''), []);
  assert.deepEqual(splitReplySegments('   '), []);
});

test('分段：换行也是自然停顿点', () => {
  const original = '第一句\n第二句\n第三句\n第四句';
  const segments = splitReplySegments(original);
  assert.ok(segments.length <= 3);
  assertWithinLimits(segments, original);
});

test('分段：极端无标点长句也不超过单条 30 字上限', () => {
  const original = '甲'.repeat(75);
  const segments = splitReplySegments(original);
  assert.ok(segments.length <= 3);
  assertWithinLimits(segments, original);
});

const originalFetch = globalThis.fetch;

function aiSettings() {
  return mergeSettings({
    ai: {
      enabled: true,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKey: 'sk-test',
      fallbackEnabled: false,
    },
  }).ai;
}

test('闲聊分段：AI 请求带上分段提示并限制总字数 90', async () => {
  let captured = null;
  const longReply = '这是一条很长的闲聊回复。'.repeat(10);
  globalThis.fetch = async (url, options) => {
    captured = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: longReply } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const result = await generateAiReply({
      ai: aiSettings(),
      event: { type: 'chat', content: '今天天气真好', user: { nickname: '小明' } },
      maxChars: SEGMENT_LIMITS.maxTotalChars,
      casual: true,
    });
    assert.match(captured.messages[0].content, /2～3 个自然停顿的短句/);
    assert.match(captured.messages[0].content, /不超过 90 字/);
    assert.equal(charLength(result.text), 90);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('非闲聊场景保持单条完整回复的提示词', async () => {
  let captured = null;
  globalThis.fetch = async (url, options) => {
    captured = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '好的' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    await generateAiReply({
      ai: aiSettings(),
      event: { type: 'chat', content: '帮我查一下代码', user: { nickname: '小明' } },
      maxChars: 60,
    });
    assert.doesNotMatch(captured.messages[0].content, /2～3 个自然停顿的短句/);
    assert.match(captured.messages[0].content, /一句话/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
