import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SPEECH_PRIORITY,
  insertByPriority,
  normalizeSpeechPriority,
  shouldInterrupt,
} from '../extension/app/core/speechPriority.js';

test('语音优先级：默认闲聊，非法值收敛到 1~5', () => {
  assert.equal(normalizeSpeechPriority(undefined), SPEECH_PRIORITY.chat);
  assert.equal(normalizeSpeechPriority('3'), SPEECH_PRIORITY.song);
  assert.equal(normalizeSpeechPriority(0), SPEECH_PRIORITY.gift);
  assert.equal(normalizeSpeechPriority(99), SPEECH_PRIORITY.welcome);
});

test('语音队列：按送礼 > 记忆 > 点歌结果 > 闲聊 > 欢迎排序，同级先来后到', () => {
  const queue = [];
  insertByPriority(queue, { text: '欢迎', priority: SPEECH_PRIORITY.welcome });
  insertByPriority(queue, { text: '闲聊', priority: SPEECH_PRIORITY.chat });
  insertByPriority(queue, { text: '点歌', priority: SPEECH_PRIORITY.song });
  insertByPriority(queue, { text: '记忆', priority: SPEECH_PRIORITY.memory });
  insertByPriority(queue, { text: '送礼1', priority: SPEECH_PRIORITY.gift });
  insertByPriority(queue, { text: '送礼2', priority: SPEECH_PRIORITY.gift });
  assert.deepEqual(
    queue.map((item) => item.text),
    ['送礼1', '送礼2', '记忆', '点歌', '闲聊', '欢迎'],
  );
});

test('语音队列：超过上限时丢弃最低优先级的队尾', () => {
  const queue = [];
  insertByPriority(queue, { text: '欢迎', priority: SPEECH_PRIORITY.welcome }, 3);
  insertByPriority(queue, { text: '闲聊', priority: SPEECH_PRIORITY.chat }, 3);
  insertByPriority(queue, { text: '点歌', priority: SPEECH_PRIORITY.song }, 3);
  insertByPriority(queue, { text: '送礼', priority: SPEECH_PRIORITY.gift }, 3);
  assert.deepEqual(
    queue.map((item) => item.text),
    ['送礼', '点歌', '闲聊'],
  );
});

test('语音打断：高优先级可打断低优先级，记忆和送礼播放中不被打断', () => {
  assert.equal(shouldInterrupt(SPEECH_PRIORITY.gift, SPEECH_PRIORITY.chat, false), true);
  assert.equal(shouldInterrupt(SPEECH_PRIORITY.song, SPEECH_PRIORITY.welcome, false), true);
  assert.equal(shouldInterrupt(SPEECH_PRIORITY.memory, SPEECH_PRIORITY.gift, false), false);
  assert.equal(shouldInterrupt(SPEECH_PRIORITY.gift, SPEECH_PRIORITY.memory, true), false);
  assert.equal(shouldInterrupt(SPEECH_PRIORITY.welcome, SPEECH_PRIORITY.chat, false), false);
});
