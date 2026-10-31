import test from 'node:test';
import assert from 'node:assert/strict';

import { formatNowText, isTimeQuestion } from '../extension/app/core/timeIntent.js';

test('报时：能识别几点、几号、什么时间类提问', () => {
  const cases = [
    '现在几点',
    '几点了',
    '现在几点了',
    '今天几号',
    '现在几月几号',
    '今天星期几',
    '周几啊',
    '现在什么时间',
    '现在什么时候',
    '报时',
    '现在日期是啥',
  ];
  for (const input of cases) {
    assert.equal(isTimeQuestion(input), true, input);
  }
});

test('报时：问安排或普通弹幕不会误触发', () => {
  const cases = [
    '几点开播',
    '什么时候轮到我',
    '今天几号开播',
    '现在几点睡',
    '这首歌时间好长',
    '点歌 晴天',
    '播放 晴天',
    '今天天气不错',
  ];
  for (const input of cases) {
    assert.equal(isTimeQuestion(input), false, input);
  }
});

test('报时：输出适合朗读的时间格式', () => {
  assert.equal(formatNowText(new Date(2026, 9, 29, 21, 5)), '10月29日 星期四 21点05分');
  assert.equal(formatNowText(new Date(2026, 0, 1, 8, 0)), '1月1日 星期四 8点00分');
});
