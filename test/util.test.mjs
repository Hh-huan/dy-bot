import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeRoomUrl, parseRoomInput, roomKeyFromUrl } from '../extension/app/core/util.js';

test('从直播间链接提取房间号', () => {
  assert.equal(roomKeyFromUrl('https://live.douyin.com/123456789'), '123456789');
  assert.equal(roomKeyFromUrl('https://live.douyin.com/123456789/?from=web'), '123456789');
  assert.equal(roomKeyFromUrl('https://www.douyin.com/root/live/123456789'), '123456789');
  assert.equal(roomKeyFromUrl('https://live.douyin.com/'), '');
  assert.equal(roomKeyFromUrl('https://www.douyin.com/video/7300000000000000000'), '');
  assert.equal(roomKeyFromUrl('https://example.com/live/123456789'), '');
  assert.equal(roomKeyFromUrl(''), '');
});

test('把链接或房间号统一成标准直播间地址', () => {
  assert.equal(normalizeRoomUrl('123456789'), 'https://live.douyin.com/123456789');
  assert.equal(normalizeRoomUrl('live.douyin.com/123456789'), 'https://live.douyin.com/123456789');
  assert.equal(
    normalizeRoomUrl('https://live.douyin.com/123456789?anchor_id=1'),
    'https://live.douyin.com/123456789',
  );
  assert.equal(normalizeRoomUrl('https://www.douyin.com/video/7300000000000000000'), '');
  assert.equal(parseRoomInput(' 987654321 '), 'https://live.douyin.com/987654321');
});
