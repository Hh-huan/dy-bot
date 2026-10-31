import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';

import { decodeFrame, roomIdFromUrl } from '../extension/app/core/douyin.js';
import { concat, fieldMessage, fieldString, fieldVarint } from './encode.mjs';

const ROOM = 7234567890123456789n;
const TS = 1700000000;

function common(method, msgId) {
  return concat(
    fieldString(1, method),
    fieldVarint(2, msgId),
    fieldVarint(3, ROOM),
    fieldVarint(4, TS),
  );
}

function user({ id = '42', nickname = '小明', level = 12, followStatus = 0, fansClub = null } = {}) {
  const follow = followStatus ? fieldMessage(22, fieldVarint(3, followStatus)) : null;
  const club = fansClub
    ? fieldMessage(
        24,
        fieldMessage(
          1,
          concat(
            fieldString(1, fansClub.name || '铁粉团'),
            fieldVarint(2, fansClub.level || 1),
            fieldVarint(3, fansClub.status || 1),
          ),
        ),
      )
    : null;
  return concat(
    fieldVarint(1, id),
    fieldVarint(6, level),
    fieldString(3, nickname),
    fieldMessage(9, fieldString(1, 'https://example.com/avatar.jpg')),
    follow,
    club,
  );
}

function chatMessage({ msgId = 100, content = '主播这个多少钱', from = {} } = {}) {
  const body = concat(
    fieldMessage(1, common('WebcastChatMessage', msgId)),
    fieldMessage(2, user(from)),
    fieldString(3, content),
  );
  return concat(fieldString(1, 'WebcastChatMessage'), fieldMessage(2, body), fieldVarint(3, msgId));
}

function giftMessage({ msgId = 200, count = 3, repeatEnd = 1, giftName = '小心心', imageUrl = '' } = {}) {
  const gift = concat(
    imageUrl ? fieldMessage(1, fieldString(1, imageUrl)) : new Uint8Array(),
    fieldString(16, giftName),
    fieldVarint(12, 10),
  );
  const body = concat(
    fieldMessage(1, common('WebcastGiftMessage', msgId)),
    fieldVarint(2, 8100),
    fieldVarint(5, count),
    fieldVarint(6, count),
    fieldMessage(7, user({ id: '77', nickname: '土豪' })),
    fieldVarint(9, repeatEnd),
    fieldMessage(12, gift),
  );
  return concat(fieldString(1, 'WebcastGiftMessage'), fieldMessage(2, body), fieldVarint(3, msgId));
}

function memberMessage() {
  return concat(
    fieldString(1, 'WebcastMemberMessage'),
    fieldMessage(
      2,
      concat(
        fieldMessage(1, common('WebcastMemberMessage', 300)),
        fieldMessage(2, user({ id: '88', nickname: '新观众' })),
        fieldVarint(3, 321),
        fieldString(11, '进入了直播间'),
      ),
    ),
    fieldVarint(3, 300),
  );
}

function likeMessage() {
  return concat(
    fieldString(1, 'WebcastLikeMessage'),
    fieldMessage(
      2,
      concat(
        fieldMessage(1, common('WebcastLikeMessage', 400)),
        fieldVarint(2, 5),
        fieldVarint(3, 999),
        fieldMessage(5, user({ id: '99', nickname: '点赞狂魔' })),
      ),
    ),
    fieldVarint(3, 400),
  );
}

function socialMessage() {
  return concat(
    fieldString(1, 'WebcastSocialMessage'),
    fieldMessage(
      2,
      concat(
        fieldMessage(1, common('WebcastSocialMessage', 500)),
        fieldMessage(2, user({ id: '66', nickname: '新粉丝' })),
        fieldVarint(4, 1),
      ),
    ),
    fieldVarint(3, 500),
  );
}

function roomSeqMessage() {
  const rank = concat(
    fieldVarint(1, 999),
    fieldMessage(2, user({ id: '77', nickname: '在线观众' })),
    fieldVarint(3, 1),
  );
  return concat(
    fieldString(1, 'WebcastRoomUserSeqMessage'),
    fieldMessage(
      2,
      concat(
        fieldMessage(1, common('WebcastRoomUserSeqMessage', 600)),
        fieldMessage(2, rank),
        fieldVarint(3, 1234),
        fieldVarint(7, 56789),
      ),
    ),
    fieldVarint(3, 600),
  );
}

function controlMessage(status) {
  return concat(
    fieldString(1, 'WebcastControlMessage'),
    fieldMessage(
      2,
      concat(fieldMessage(1, common('WebcastControlMessage', 700)), fieldVarint(2, status)),
    ),
    fieldVarint(3, 700),
  );
}

function pushFrame(messages, { compress = true } = {}) {
  const response = concat(...messages.map((message) => fieldMessage(1, message)));
  const payload = compress ? new Uint8Array(gzipSync(Buffer.from(response))) : response;
  const headers = concat(fieldString(1, 'compress_type'), fieldString(2, compress ? 'gzip' : 'none'));
  return concat(
    fieldString(4, 'PushFrame'),
    fieldMessage(5, headers),
    fieldString(7, 'msg'),
    fieldMessage(8, payload),
  );
}

test('解码 gzip 弹幕帧里的评论、礼物、进场、点赞、关注、在线人数、控制消息', async () => {
  const frame = pushFrame([
    chatMessage(),
    giftMessage(),
    memberMessage(),
    likeMessage(),
    socialMessage(),
    roomSeqMessage(),
    controlMessage(3),
  ]);
  const result = await decodeFrame(frame);

  assert.equal(result.payloadType, 'msg');
  assert.equal(result.headers.compress_type, 'gzip');
  assert.equal(result.events.length, 7);

  const [chat, gift, member, like, follow, stats, control] = result.events;

  assert.equal(chat.type, 'chat');
  assert.equal(chat.content, '主播这个多少钱');
  assert.equal(chat.user.nickname, '小明');
  assert.equal(chat.user.id, '42');
  assert.equal(chat.user.level, 12);
  assert.equal(chat.user.avatar, 'https://example.com/avatar.jpg');
  assert.equal(chat.roomId, String(ROOM));
  assert.equal(chat.ts, TS * 1000);
  assert.equal(chat.id, 'WebcastChatMessage:100');

  assert.equal(gift.type, 'gift');
  assert.equal(gift.gift.name, '小心心');
  assert.equal(gift.gift.count, 3);
  assert.equal(gift.gift.completed, true);
  assert.equal(gift.canReply, true);
  assert.equal(gift.user.nickname, '土豪');

  assert.equal(member.type, 'member');
  assert.equal(member.user.nickname, '新观众');
  assert.equal(member.member.count, 321);
  assert.match(member.member.actionDescription, /进入/);

  assert.equal(like.type, 'like');
  assert.equal(like.like.count, 5);
  assert.equal(like.like.total, 999);

  assert.equal(follow.type, 'follow');
  assert.equal(follow.user.nickname, '新粉丝');

  assert.equal(stats.type, 'stats');
  assert.equal(stats.stats.online, 1234);
  assert.equal(stats.stats.cumulative, 56789);
  assert.equal(stats.viewers.length, 1);
  assert.equal(stats.viewers[0].id, '77');
  assert.equal(stats.viewers[0].nickname, '在线观众');
  assert.equal(stats.viewers[0].rank, 1);

  assert.equal(control.type, 'control');
  assert.equal(control.control.status, 3);
});

test('用户数据里的关注关系与粉丝团会被解析', async () => {
  const frame = pushFrame([
    chatMessage({ msgId: 110, from: { id: '501', nickname: '老粉', followStatus: 1 } }),
    chatMessage({
      msgId: 111,
      from: { id: '502', nickname: '团粉', fansClub: { name: '铁粉团', level: 8, status: 1 } },
    }),
    chatMessage({ msgId: 112, from: { id: '503', nickname: '路人' } }),
  ]);
  const [followed, clubMember, stranger] = (await decodeFrame(frame)).events;

  assert.equal(followed.user.followStatus, 1);
  assert.equal(followed.user.fansClub, null);

  assert.equal(clubMember.user.followStatus, 0);
  assert.equal(clubMember.user.fansClub.name, '铁粉团');
  assert.equal(clubMember.user.fansClub.level, 8);
  assert.equal(clubMember.user.fansClub.status, 1);

  assert.equal(stranger.user.followStatus, 0);
  assert.equal(stranger.user.fansClub, null);
});

test('连击中的礼物暂不回复，连击结束后可回复', async () => {
  const frame = pushFrame([giftMessage({ msgId: 201, count: 5, repeatEnd: 0 })]);
  const result = await decodeFrame(frame);
  assert.equal(result.events[0].gift.completed, false);
  assert.equal(result.events[0].canReply, false);
});

test('礼物解码会带上抖音礼物图片地址', async () => {
  const frame = pushFrame([giftMessage({ imageUrl: 'https://example.com/gift.png' })]);
  const result = await decodeFrame(frame);
  assert.equal(result.events[0].gift.image, 'https://example.com/gift.png');
});

test('未压缩帧同样可以解析', async () => {
  const result = await decodeFrame(pushFrame([chatMessage({ content: '你好' })], { compress: false }));
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].content, '你好');
});

test('空 payload 与损坏消息不会抛出', async () => {
  const empty = await decodeFrame(concat(fieldString(4, 'PushFrame'), fieldString(7, 'msg')));
  assert.deepEqual(empty.events, []);

  const broken = await decodeFrame(concat(fieldString(4, 'PushFrame'), fieldMessage(8, new Uint8Array([1, 2, 3]))));
  assert.deepEqual(broken.events, []);
});

test('未知 method 会被记录而不是报错', async () => {
  const unknown = concat(
    fieldString(1, 'WebcastSomethingNewMessage'),
    fieldMessage(2, fieldString(1, 'x')),
    fieldVarint(3, 1),
  );
  const result = await decodeFrame(pushFrame([unknown]));
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.unknown, ['WebcastSomethingNewMessage']);
});

test('roomIdFromUrl 提取 room_id', () => {
  assert.equal(
    roomIdFromUrl('wss://webcast5-ws-web-lf.douyin.com/webcast/im/push/v2/?app_name=douyin_web&room_id=123456'),
    '123456',
  );
  assert.equal(roomIdFromUrl('wss://example.com/ws'), '');
});
