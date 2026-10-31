import test from 'node:test';
import assert from 'node:assert/strict';
import { isGiftNoticeText } from '../extension/app/core/giftNotice.js';

test('送礼提示文本：送出礼物 + 数量要识别出来', () => {
  const notices = [
    '送出小心心 x1',
    '送出 白饭 ×6',
    '送出 @直播间某人 x1',
    '送出@张三x10',
    '送出了跑车 x2',
    '送出 嘉年华 1个',
    '送出礼物*3',
    '@浮烟 送出 小心心 x1',
  ];
  for (const text of notices) {
    assert.equal(isGiftNoticeText(text), true, `${text} 应识别为送礼提示`);
  }
});

test('送礼提示文本：普通聊天、点歌、没有数量的送出都不误判', () => {
  const normal = [
    '送出这首歌给你',
    '我要送出礼物',
    '送出一首歌',
    '送出一个小心心',
    '点歌 晴天',
    '送你一朵小红花',
    '送出 x1',
    '',
  ];
  for (const text of normal) {
    assert.equal(isGiftNoticeText(text), false, `${text} 不应识别为送礼提示`);
  }
});
