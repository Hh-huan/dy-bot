import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStore } from '../bridge/memory.mjs';
import {
  buildCrossViewerDigest,
  buildReunionLine,
  buildViewerDigest,
  buildViewerHistoryEntry,
  fallbackCrossReply,
  fallbackMemoryReply,
  fitMemoryReply,
  hasViewerMemory,
  isMemoryQuestion,
  parseViewerNote,
  recordViewerEvent,
  recordViewerSong,
  userFollowedAnchor,
} from '../extension/app/core/viewerMemory.js';

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dy-memory-'));
  const file = join(dir, 'memory.json');
  const store = createMemoryStore({ file });
  return { store, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('memory: 空文件返回空列表', async () => {
  const { store, cleanup } = tempStore();
  try {
    const data = await store.list();
    assert.equal(data.ok, true);
    assert.deepEqual(data.memories, []);
  } finally {
    cleanup();
  }
});

test('memory: 追加并落盘，可重新载入', async () => {
  const { store, file, cleanup } = tempStore();
  try {
    const added = await store.add({ text: '本场观众很活跃，点了三首周杰伦。', kind: 'live' });
    assert.equal(added.ok, true);
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(raw.memories.length, 1);
    assert.equal(raw.memories[0].text, '本场观众很活跃，点了三首周杰伦。');

    const listed = await store.list();
    assert.equal(listed.memories.length, 1);
    assert.equal(listed.memories[0].kind, 'live');
  } finally {
    cleanup();
  }
});

test('memory: 空文本拒绝，超长截断', async () => {
  const { store, cleanup } = tempStore();
  try {
    assert.equal((await store.add({ text: '   ' })).ok, false);
    const long = await store.add({ text: '啊'.repeat(300) });
    assert.equal(long.ok, true);
    const listed = await store.list();
    assert.ok(listed.memories[0].text.length <= 160);
  } finally {
    cleanup();
  }
});

test('memory: 超过上限时淘汰最旧记录', async () => {
  const { store, cleanup } = tempStore();
  try {
    for (let i = 0; i < 45; i += 1) {
      await store.add({ text: `第 ${i} 场直播记忆` });
    }
    const listed = await store.list(40);
    assert.equal(listed.memories.length, 40);
    assert.equal(listed.memories[0].text, '第 5 场直播记忆');
    assert.equal(listed.memories[39].text, '第 44 场直播记忆');
  } finally {
    cleanup();
  }
});

test('memory: list(limit) 只返回最近 N 条', async () => {
  const { store, cleanup } = tempStore();
  try {
    for (let i = 0; i < 8; i += 1) {
      await store.add({ text: `记忆 ${i}` });
    }
    const listed = await store.list(3);
    assert.equal(listed.memories.length, 3);
    assert.equal(listed.memories[0].text, '记忆 5');
    assert.equal(listed.memories[2].text, '记忆 7');
  } finally {
    cleanup();
  }
});

test('单场记忆：发言最多 20 条，点歌和送礼都能记录', () => {
  const record = { key: 'u1', name: '小明', id: 'u1', chats: [], gifts: [], songs: [] };
  for (let i = 0; i < 25; i += 1) {
    recordViewerEvent(record, { type: 'chat', content: `第 ${i} 句话`, user: { id: 'u1', nickname: '小明' } }, 1000 + i);
  }
  recordViewerEvent(record, { type: 'gift', gift: { name: '小心心', count: 3 }, user: { id: 'u1', nickname: '小明' } }, 2000);
  recordViewerSong(record, { title: '晴天', artist: '周杰伦' }, 3000);

  assert.equal(record.chats.length, 20);
  assert.equal(record.chats[0], '第 5 句话');
  assert.equal(record.chats[19], '第 24 句话');
  assert.equal(record.gifts[0].name, '小心心');
  assert.equal(record.gifts[0].count, 3);
  assert.equal(record.songs[0].title, '晴天');

  const digest = buildViewerDigest(record);
  assert.match(digest, /昵称：小明/);
  assert.match(digest, /晴天/);
  assert.match(digest, /小心心×3/);
});

test('单场记忆：能识别“还记得我吗”类提问，且不误判普通弹幕', () => {
  for (const input of ['还记得我吗', '记得我吗', '记不记得我', '认识我吗', '知道我是谁吗', '我是谁', '对我有印象吗', '你有印象吗']) {
    assert.equal(isMemoryQuestion(input), true, input);
  }
  for (const input of ['今天天气不错', '这首歌真好听', '点歌 晴天', '有印象的歌词', '记得按时吃饭', '点歌 我是谁', '想听 我是谁', '播放 我是谁']) {
    assert.equal(isMemoryQuestion(input), false, input);
  }
});

test('单场记忆：关注和点赞也会加入观众记忆列表', () => {
  const follow = { key: 'u2', name: '小红', chats: [], gifts: [], songs: [] };
  recordViewerEvent(follow, { type: 'follow', user: { id: 'u2', nickname: '小红' } }, 5000);
  assert.ok(follow.followedAt);
  assert.equal(hasViewerMemory(follow), true);
  assert.match(buildViewerDigest(follow), /已关注/);
  const followReply = fallbackMemoryReply(follow, '小红');
  assert.ok(Array.from(followReply).length >= 20 && Array.from(followReply).length <= 50, followReply);

  const like = { key: 'u3', name: '小刚', chats: [], gifts: [], songs: [] };
  recordViewerEvent(like, { type: 'like', user: { id: 'u3', nickname: '小刚' }, like: { count: 7 } }, 6000);
  assert.equal(like.likes, 7);
  assert.equal(hasViewerMemory(like), true);
  assert.match(buildViewerDigest(like), /点赞 7 个/);

  const empty = { key: 'u4', name: '路人', chats: [], gifts: [], songs: [] };
  assert.equal(hasViewerMemory(empty), false);
  assert.equal(hasViewerMemory(null), false);
});

test('单场记忆：进场消息里的「关注了主播」也算已关注', () => {
  const record = { key: 'u5', name: '小美', chats: [], gifts: [], songs: [] };
  recordViewerEvent(
    record,
    { type: 'member', user: { id: 'u5', nickname: '小美' }, member: { actionDescription: '关注了主播' } },
    7000,
  );
  assert.equal(record.followedAt, 7000);
  assert.equal(hasViewerMemory(record), true);
  assert.match(buildViewerDigest(record), /已关注/);
  assert.ok(buildViewerHistoryEntry(record).actions.includes('关注'));
});

test('单场记忆：抖音用户数据里的关注关系直接记为已关注', () => {
  const record = { key: 'u6', name: '老粉', chats: [], gifts: [], songs: [] };
  recordViewerEvent(
    record,
    { type: 'chat', content: '主播好呀', user: { id: 'u6', nickname: '老粉', followStatus: 1 } },
    8000,
  );
  assert.equal(record.followedAt, 8000);
  assert.equal(hasViewerMemory(record), true);
  assert.match(buildViewerDigest(record), /已关注/);
});

test('单场记忆：粉丝团成员按已关注处理', () => {
  assert.equal(userFollowedAnchor({ id: 'u7', fansClub: { name: '铁粉团', level: 3 } }), true);
  assert.equal(userFollowedAnchor({ id: 'u8', followStatus: 1 }), true);
  assert.equal(userFollowedAnchor({ id: 'u9', followStatus: 0 }), false);
  assert.equal(userFollowedAnchor({ id: 'u10', fansClub: null }), false);
  assert.equal(userFollowedAnchor(null), false);

  const record = { key: 'u7', name: '团粉', chats: [], gifts: [], songs: [] };
  recordViewerEvent(
    record,
    { type: 'like', user: { id: 'u7', nickname: '团粉', fansClub: { name: '铁粉团', level: 3 } }, like: { count: 1 } },
    9000,
  );
  assert.equal(record.followedAt, 9000);
});

test('跨直播记忆：单场总结会带上重要观众的简单信息', async () => {
  const { store, file, cleanup } = tempStore();
  try {
    const added = await store.add({
      text: '本场很热闹',
      viewers: [
        { key: 'u1', name: '小明', id: 'u1', actions: ['发言', '送礼'], note: '送过小心心' },
        { key: 'u2', name: '小红', id: '', actions: [], note: '' },
      ],
    });
    assert.equal(added.ok, true);
    const listed = await store.list();
    assert.equal(listed.memories[0].viewers.length, 2);
    assert.equal(listed.memories[0].viewers[0].name, '小明');
    assert.deepEqual(listed.memories[0].viewers[0].actions, ['发言', '送礼']);
    assert.equal(listed.memories[0].viewers[1].key, 'u2');

    // 重新载入后观众信息仍在
    const reloaded = await createMemoryStore({ file }).list();
    assert.equal(reloaded.memories[0].viewers[0].note, '送过小心心');
  } finally {
    cleanup();
  }
});

test('跨直播记忆：同一场直播重复存档只更新最后一条', async () => {
  const { store, file, cleanup } = tempStore();
  try {
    await store.add({
      text: '第一份总结',
      sessionKey: 'room:1',
      viewers: [
        { key: 'u1', name: '小明', actions: ['发言'], note: '送过小心心' },
        { key: 'u2', name: '小红', actions: ['发言'] },
      ],
    });
    const second = await store.add({
      text: '第二份总结',
      sessionKey: 'room:1',
      viewers: [
        { key: 'u1', name: '小明', actions: ['点歌'] },
        { key: 'u3', name: '小刚', actions: ['送礼'] },
      ],
    });
    assert.equal(second.merged, true);

    const listed = await store.list();
    assert.equal(listed.memories.length, 1);
    assert.equal(listed.memories[0].text, '第二份总结');
    assert.deepEqual(listed.memories[0].viewers.map((item) => item.name), ['小明', '小刚', '小红']);
    const xiaoming = listed.memories[0].viewers.find((item) => item.name === '小明');
    assert.deepEqual(xiaoming.actions, ['点歌', '发言']);
    assert.equal(xiaoming.note, '送过小心心');

    // 换一场直播才会新增记录
    await store.add({ text: '另一场', sessionKey: 'room:2' });
    assert.equal((await store.list()).memories.length, 2);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).memories.length, 2);
  } finally {
    cleanup();
  }
});

test('跨直播记忆：观众摘要与兜底回答', () => {
  const record = {
    key: 'u1',
    name: '小明',
    id: 'u1',
    chats: ['你好'],
    gifts: [{ name: '小心心', count: 2 }],
    songs: [{ title: '晴天', artist: '周杰伦' }],
    followedAt: 0,
    likes: 3,
  };
  const entry = buildViewerHistoryEntry(record);
  assert.deepEqual(entry.actions, ['发言', '送礼', '点歌', '点赞']);
  assert.match(entry.note, /点过《晴天》/);
  assert.match(entry.note, /送过小心心/);

  const digest = buildCrossViewerDigest({ ...entry, at: 123 });
  assert.match(digest, /小明/);
  assert.match(digest, /点过《晴天》/);

  const reply = fallbackCrossReply(entry, '小明');
  assert.match(reply, /晴天/);
  assert.ok(Array.from(reply).length >= 20 && Array.from(reply).length <= 50, reply);
});

test('跨直播记忆：存档带上点歌 / 送礼 / 点赞明细', () => {
  const record = {
    key: 'u1',
    name: '小明',
    id: 'u1',
    chats: ['今天好开心'],
    gifts: [
      { name: '小心心', count: 2 },
      { name: '小心心', count: 1 },
      { name: '大啤酒', count: 1 },
    ],
    songs: [
      { title: '晴天', artist: '周杰伦' },
      { title: '七里香', artist: '周杰伦' },
    ],
    followedAt: 0,
    likes: 12,
    lastSeen: 123,
  };
  const entry = buildViewerHistoryEntry(record);
  assert.deepEqual(entry.songs.map((song) => song.title), ['晴天', '七里香']);
  assert.deepEqual(entry.gifts, [
    { name: '小心心', count: 3 },
    { name: '大啤酒', count: 1 },
  ]);
  assert.equal(entry.likes, 12);
  assert.equal(entry.lastChat, '今天好开心');
  assert.equal(entry.lastSeen, 123);
});

test('进场重逢：说出上次点歌和送过的礼物', () => {
  const viewer = {
    songs: [{ title: '晴天' }],
    gifts: [{ name: '小心心', count: 3 }],
    likes: 12,
    actions: ['关注'],
  };
  const line = buildReunionLine({ viewer, nickname: '小明' });
  assert.equal(line, '@小明，你又来看鲸鱼娘啦！上次你点了《晴天》，还送了3个小心心，我记得你哦！');
});

test('进场重逢：旧版记忆从 note 解析点歌 / 送礼 / 点赞', () => {
  const note = '点过《月半小夜曲》、送过小心心';
  assert.deepEqual(parseViewerNote(note), { song: '月半小夜曲', gift: '小心心', likes: 0, followed: false });
  const line = buildReunionLine({ viewer: { name: '小明', note }, nickname: '小明' });
  assert.match(line, /上次你点了《月半小夜曲》，还送了小心心/);

  const likesLine = buildReunionLine({ viewer: { note: '点过94个赞' }, nickname: '小明' });
  assert.match(likesLine, /上次你给我点了94个赞/);
});

test('进场重逢：只有关注 / 没有记录时退回通用欢迎语', () => {
  const followed = buildReunionLine({ viewer: { actions: ['关注'] }, nickname: '小美' });
  assert.match(followed, /上次你关注了我/);

  const none = buildReunionLine({ viewer: null, nickname: '新朋友' });
  assert.equal(none, '@新朋友，你又来看鲸鱼娘啦！我记得你哦！');

  const noViewer = buildReunionLine({ nickname: '老王' });
  assert.equal(noViewer, '@老王，你又来看鲸鱼娘啦！我记得你哦！');
});

test('进场重逢：整句不超过 72 字，不会撑爆气泡', () => {
  const viewer = {
    songs: [{ title: '一首名字特别特别特别长的歌曲名称测试用' }],
    gifts: [{ name: '超级无敌限量纪念版小心心', count: 99 }],
    likes: 12345,
  };
  const line = buildReunionLine({ viewer, nickname: '一二三四五六七八九十一二三四五六七八九十' });
  assert.ok(Array.from(line).length <= 72, line);
  assert.match(line, /又来看鲸鱼娘啦/);
  assert.match(line, /我记得你哦/);
});

test('跨直播记忆：行为明细能落盘，同场次合并不重复累加', async () => {
  const { store, file, cleanup } = tempStore();
  try {
    await store.add({
      text: '第一份总结',
      sessionKey: 'room:1',
      viewers: [
        {
          key: 'u1',
          name: '小明',
          actions: ['送礼'],
          note: '送过小心心',
          songs: [{ title: '晴天', artist: '周杰伦' }],
          gifts: [{ name: '小心心', count: 3 }],
          likes: 5,
          lastChat: '好听',
        },
      ],
    });
    await store.add({
      text: '第二份总结',
      sessionKey: 'room:1',
      viewers: [
        {
          key: 'u1',
          name: '小明',
          actions: ['点歌'],
          songs: [{ title: '七里香' }],
          gifts: [{ name: '小心心', count: 2 }],
        },
      ],
    });
    const listed = await store.list();
    assert.equal(listed.memories.length, 1);
    const viewer = listed.memories[0].viewers[0];
    assert.deepEqual(viewer.songs.map((song) => song.title), ['七里香']);
    assert.deepEqual(viewer.gifts, [{ name: '小心心', count: 2 }]);
    assert.equal(viewer.likes, 5);
    assert.equal(viewer.lastChat, '好听');

    const raw = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(raw.memories[0].viewers[0].lastChat, '好听');
    assert.match(buildReunionLine({ viewer, nickname: '小明' }), /七里香/);
  } finally {
    cleanup();
  }
});

test('单场记忆：AI 回答会约束在 20~50 字，兜底也满足', () => {
  const short = fitMemoryReply('记得你呀', '小明');
  assert.ok(Array.from(short).length >= 20, short);
  assert.ok(Array.from(short).length <= 50, short);

  const long = fitMemoryReply('记得你呀'.repeat(30), '小明');
  assert.ok(Array.from(long).length <= 50, long);

  const record = { name: '小红', chats: [], gifts: [], songs: [{ title: '稻香', artist: '周杰伦' }] };
  const fallback = fallbackMemoryReply(record, '小红');
  assert.match(fallback, /稻香/);
  assert.ok(Array.from(fallback).length >= 20 && Array.from(fallback).length <= 50, fallback);
});
