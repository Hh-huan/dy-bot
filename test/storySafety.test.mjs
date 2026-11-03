import test from 'node:test';
import assert from 'node:assert/strict';

import { findUnsafeStoryWord, isUnsafeStoryText, unsafeStoryNode } from '../extension/app/core/storySafety.js';
import { STORY_TOPICS } from '../extension/app/core/storyTheater.js';

test('违规主题会被拦截', () => {
  assert.equal(findUnsafeStoryWord('色情小剧场'), '色情');
  assert.equal(findUnsafeStoryWord('血腥杀人现场'), '血腥');
  assert.equal(findUnsafeStoryWord('赌场风云'), '赌场');
  assert.equal(findUnsafeStoryWord('法轮功的故事'), '法轮功');
  assert.equal(findUnsafeStoryWord('加微信领福利'), '加微信');
  assert.equal(findUnsafeStoryWord('国歌大合唱'), '国歌');
  assert.equal(findUnsafeStoryWord('六四事件'), '六四');
});

test('正常剧场主题不会被误杀', () => {
  assert.equal(findUnsafeStoryWord('大肥鱼失去尾巴'), '');
  assert.equal(findUnsafeStoryWord('海底宝藏'), '');
  assert.equal(findUnsafeStoryWord('鲸鱼娘的第一次上学'), '');
  assert.equal(findUnsafeStoryWord('月光下的鲸鱼音乐会'), '');
  for (const topic of STORY_TOPICS) {
    assert.equal(findUnsafeStoryWord(topic), '', `内置题材不应命中违规词：${topic}`);
  }
});

test('AI 生成的旁白、选项和结局都会被检查', () => {
  assert.equal(
    unsafeStoryNode({ scene: '海底', narration: '鲸鱼娘发现一具尸体，吓得说不出话。', a: '报警', b: '逃跑' }),
    '尸体',
  );
  assert.equal(
    unsafeStoryNode({ scene: '海底宝箱', narration: '鲸鱼娘捡到一个会发光的宝箱。', a: '打开宝箱', b: '先喊朋友' }),
    '',
  );
  assert.equal(isUnsafeStoryText('结局里出现了站外引流的二维码'), true);
  assert.equal(isUnsafeStoryText('鲸鱼娘和大家道了声晚安，故事圆满结束。'), false);
});
