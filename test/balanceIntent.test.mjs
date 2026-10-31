import test from 'node:test';
import assert from 'node:assert/strict';

import { BALANCE_CHEER, formatBalanceReply, isBalanceQuestion } from '../extension/app/core/balanceIntent.js';

test('余额提问多种说法都能识别', () => {
  assert.equal(isBalanceQuestion('剩余token数量'), true);
  assert.equal(isBalanceQuestion('还剩多少token'), true);
  assert.equal(isBalanceQuestion('token还有多少'), true);
  assert.equal(isBalanceQuestion('还有多少token'), true);
  assert.equal(isBalanceQuestion('token余额多少'), true);
  assert.equal(isBalanceQuestion('查一下token余额'), true);
  assert.equal(isBalanceQuestion('我的token还剩多少'), true);
  assert.equal(isBalanceQuestion('余额还有多少'), true);
  assert.equal(isBalanceQuestion('how many tokens left'), true);
});

test('普通弹幕和指令不会被当成余额提问', () => {
  assert.equal(isBalanceQuestion('token来，token来！'), false);
  assert.equal(isBalanceQuestion('点歌 token'), false);
  assert.equal(isBalanceQuestion('大家晚上好'), false);
  assert.equal(isBalanceQuestion('今天天气怎么样'), false);
  assert.equal(isBalanceQuestion('还剩几个白饭'), false);
  assert.equal(isBalanceQuestion(''), false);
  assert.equal(
    isBalanceQuestion('这是一段很长很长很长很长很长很长很长很长很长很长很长的弹幕'),
    false,
  );
});

test('余额回复固定包含余额数值和激励话术', () => {
  assert.equal(BALANCE_CHEER, '余额多多，token多多！');
  assert.equal(formatBalanceReply('12.34元'), '当前token余额为12.34元，余额多多，token多多！');
});
