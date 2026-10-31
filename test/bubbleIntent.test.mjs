import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBubbleGuideQuestion } from '../extension/app/core/bubbleIntent.js';

test('识别「头像为什么弹来弹去」这类气泡流提问', () => {
  assert.equal(isBubbleGuideQuestion('为什么他们的头像弹来弹去的'), true);
  assert.equal(isBubbleGuideQuestion('头像弹来弹去'), true);
  assert.equal(isBubbleGuideQuestion('别人头像飞来飞去好酷'), true);
  assert.equal(isBubbleGuideQuestion('@小明 头像弹来弹去'), true);
});

test('识别「怎么上气泡流」这类咨询', () => {
  assert.equal(isBubbleGuideQuestion('怎么上气泡流'), true);
  assert.equal(isBubbleGuideQuestion('我也想上气泡流'), true);
  assert.equal(isBubbleGuideQuestion('送什么能上气泡流'), true);
  assert.equal(isBubbleGuideQuestion('气泡流怎么进'), true);
  assert.equal(isBubbleGuideQuestion('气泡是什么'), true);
});

test('普通聊天和甩飞指令不会被当成气泡流咨询', () => {
  assert.equal(isBubbleGuideQuestion('头像真好看'), false);
  assert.equal(isBubbleGuideQuestion('甩飞我自己'), false);
  assert.equal(isBubbleGuideQuestion('这气泡水真好喝'), false);
  assert.equal(isBubbleGuideQuestion('刚刚谁在弹幕里说话'), false);
  assert.equal(isBubbleGuideQuestion(''), false);
});

test('过长的弹幕不当成气泡流咨询', () => {
  assert.equal(isBubbleGuideQuestion(`${'为什么他们的头像弹来弹去'.repeat(5)}`), false);
});
