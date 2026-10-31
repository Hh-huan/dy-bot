import test from 'node:test';
import assert from 'node:assert/strict';
import { isUnsafeNickname, safeNickname, sanitizeEventNickname } from '../extension/app/core/nicknameSafety.js';

test('不良昵称：脏话、色情、违法、政治敏感要识别出来', () => {
  const unsafe = [
    '傻逼',
    '你是傻B',
    '操你妈',
    '草你全家',
    '贱货',
    '婊子',
    '约炮加我',
    '色情主播',
    '弱智儿童',
    '死全家',
    '吸毒的',
    '网赌上岸',
    '习近平',
    '台独分子',
    '法轮功',
  ];
  for (const name of unsafe) {
    assert.equal(isUnsafeNickname(name), true, `${name} 应判定为不良昵称`);
  }
});

test('玩梗昵称：普通玩笑和自称不拦截', () => {
  const safe = [
    '你爹',
    '吴彦祖',
    '大肥鱼的老公',
    '妈妈的乖宝',
    '大麻烦',
    '鲸鱼娘的小狗',
    '阿强',
    '小鱼干爱好者',
    '爱吃白饭',
    'AAA建材王哥',
    '',
  ];
  for (const name of safe) {
    assert.equal(isUnsafeNickname(name), false, `${name} 不应判定为不良昵称`);
  }
});

test('safeNickname：不良昵称替换成中性称呼，正常昵称原样返回', () => {
  assert.equal(safeNickname('傻逼', '这位朋友'), '这位朋友');
  assert.equal(safeNickname('   ', '观众'), '观众');
  assert.equal(safeNickname('你爹'), '你爹');
  assert.equal(safeNickname('大肥鱼的老公', '观众'), '大肥鱼的老公');
});

test('sanitizeEventNickname：背景板/桌宠事件流不展示不良昵称，原事件不被修改', () => {
  const unsafe = { id: 'e1', type: 'chat', content: '你好', user: { id: 'u1', nickname: '操你妈' } };
  const safe = sanitizeEventNickname(unsafe);
  assert.equal(safe.user.nickname, '观众');
  assert.equal(safe.content, '你好');
  assert.equal(safe.user.id, 'u1');
  assert.equal(unsafe.user.nickname, '操你妈');

  const meme = { type: 'chat', user: { nickname: '你爹' } };
  assert.equal(sanitizeEventNickname(meme).user.nickname, '你爹');
  assert.equal(sanitizeEventNickname(null), null);
});
