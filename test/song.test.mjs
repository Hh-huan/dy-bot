import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createSongManager, qqQueryAlternatives } from '../bridge/song.mjs';
import { parseSongQuery, parseCutSongIntent, parseVolumeIntent, isQueueJumpQuestion, isCutSongQuestion } from '../extension/app/core/songIntent.js';

function makeManager(clock, config = {}, options = {}) {
  const played = [];
  const events = [];
  const manager = createSongManager({
    now: () => clock.value,
    ...options,
    config: {
      autoPlay: true,
      perUserCooldownSec: 0,
      maxQueue: 3,
      ...config,
    },
    searchImpl: async (query) => ({
      source: 'qq',
      id: `id-${query}`,
      title: query,
      artist: '测试歌手',
      album: '',
      duration: 180000,
      cover: '',
      webUrl: '',
    }),
    playImpl: async (song) => {
      played.push(song);
    },
    emit: (payload) => events.push(payload),
  });
  return { manager, played, events };
}

test('点歌第一首立即播放，后续进入队列', async () => {
  const clock = { value: 1_000_000 };
  const { manager, played } = makeManager(clock);
  try {
    const first = await manager.request({ query: '晴天', user: '小明' });
    assert.equal(first.ok, true);
    assert.equal(first.position, 0);
    assert.equal(manager.snapshot().current.title, '晴天');
    assert.equal(played.length, 1);

    clock.value += 1000;
    const second = await manager.request({ query: '稻香', user: '阿伟' });
    assert.equal(second.ok, true);
    assert.equal(second.position, 1);
    assert.equal(manager.snapshot().queue.length, 1);
    assert.equal(manager.snapshot().current.title, '晴天');
  } finally {
    manager.dispose();
  }
});

test('重复歌曲仍会拦截，冷却和队列上限已取消', async () => {
  const clock = { value: 2_000_000 };
  const { manager } = makeManager(clock, { maxQueue: 1 });
  try {
    await manager.request({ query: '晴天', user: '小明' });
    clock.value += 1000;
    await manager.request({ query: '稻香', user: '阿伟' });
    assert.equal((await manager.request({ query: '晴天', user: '小红' })).ok, false);
    assert.equal((await manager.request({ query: '七里香', user: '小刚' })).ok, true);

    clock.value += 1000;
    const again = await manager.request({ query: '夜曲', user: '小明' });
    assert.equal(again.ok, true);
    assert.equal(manager.snapshot().queue.length, 3);
  } finally {
    manager.dispose();
  }
});

test('下一首会从队列播放', async () => {
  const clock = { value: 3_000_000 };
  const { manager, played } = makeManager(clock);
  try {
    await manager.request({ query: '晴天', user: '小明' });
    clock.value += 1000;
    await manager.request({ query: '稻香', user: '阿伟' });
    const skipped = await manager.skip();
    assert.equal(skipped.ok, true);
    assert.equal(manager.snapshot().current.title, '稻香');
    assert.equal(played.length, 2);
    assert.equal(played[1].title, '稻香');
  } finally {
    manager.dispose();
  }
});

test('清空队列不会停止当前歌曲', async () => {
  const clock = { value: 4_000_000 };
  const { manager } = makeManager(clock);
  try {
    await manager.request({ query: '晴天', user: '小明' });
    clock.value += 1000;
    await manager.request({ query: '稻香', user: '阿伟' });
    manager.clearQueue();
    assert.equal(manager.snapshot().queue.length, 0);
    assert.equal(manager.snapshot().current.title, '晴天');
  } finally {
    manager.dispose();
  }
});

test('测试点歌会立即切歌，并把原歌曲放回队列', async () => {
  const clock = { value: 8_000_000 };
  const { manager, played } = makeManager(clock);
  try {
    await manager.request({ query: '晴天', user: '小明', userKey: 'u1', cooldownSec: 0 });
    clock.value += 1000;
    const test = await manager.request({
      query: '稻香',
      user: '主播测试',
      userKey: 'test',
      cooldownSec: 0,
      forcePlay: true,
    });
    assert.equal(test.ok, true);
    assert.equal(test.position, 0);
    assert.equal(manager.snapshot().current.title, '稻香');
    assert.equal(manager.snapshot().queue[0].title, '晴天');
    assert.equal(played.length, 2);
  } finally {
    manager.dispose();
  }
});

test('同一用户再次点歌会提示小心心插队并保留点歌人', async () => {
  const clock = { value: 7_000_000 };
  const { manager } = makeManager(clock);
  try {
    await manager.request({ query: '晴天', user: '小明', userKey: 'user-1', cooldownSec: 0 });
    clock.value += 1000;
    const second = await manager.request({
      query: '稻香',
      user: '小明',
      userKey: 'user-1',
      cooldownSec: 0,
    });
    assert.equal(second.ok, true);
    assert.equal(second.sameUserCount, 1);
    assert.match(second.hint, /小心心/);
    assert.equal(second.song.requestedBy, '小明');
    assert.equal(second.song.requesterKey, 'user-1');
    assert.equal(manager.snapshot().queue[0].requestedBy, '小明');

    clock.value += 1000;
    const other = await manager.request({
      query: '七里香',
      user: '小明',
      userKey: 'user-2',
      cooldownSec: 0,
    });
    assert.equal(other.sameUserCount, 0);
  } finally {
    manager.dispose();
  }
});

test('普通点歌只排队，不切当前歌曲', async () => {
  const clock = { value: 5_000_000 };
  const { manager, played } = makeManager(clock);
  try {
    await manager.request({ query: '晴天', user: '小明' });
    clock.value += 10_000;
    const result = await manager.request({ query: '稻香', user: '阿伟' });
    assert.equal(result.ok, true);
    assert.equal(result.priority, false);
    assert.equal(manager.snapshot().current.title, '晴天');
    assert.equal(manager.snapshot().queue[0].title, '稻香');
    assert.equal(played.length, 1);
  } finally {
    manager.dispose();
  }
});

test('切歌必须是当前队列里的用户，且要满 90 秒', async () => {
  const clock = { value: 6_000_000 };
  const { manager, played } = makeManager(clock, { queueCutSec: 90 });
  try {
    await manager.request({ query: '晴天', user: '小明', userKey: 'u1', cooldownSec: 0 });
    clock.value += 1000;
    await manager.request({ query: '稻香', user: '阿伟', userKey: 'u2', cooldownSec: 0 });

    const stranger = await manager.cut({ user: '路人', userKey: 'u3' });
    assert.equal(stranger.ok, false);
    assert.equal(stranger.reason, 'need_request');

    // 当前歌是小明的：虽然不在队列里，也符合切歌条件，但还没满 90 秒
    const currentOwner = await manager.cut({ user: '小明', userKey: 'u1' });
    assert.equal(currentOwner.ok, false);
    assert.equal(currentOwner.reason, 'too_early');
    assert.equal(currentOwner.waitSec, 89);

    clock.value += 88_000;
    const early = await manager.cut({ user: '阿伟', userKey: 'u2' });
    assert.equal(early.ok, false);
    assert.equal(early.reason, 'too_early');
    assert.equal(early.waitSec, 1);
    assert.equal(manager.snapshot().current.title, '晴天');
    assert.equal(played.length, 1);

    clock.value += 2_000;
    const success = await manager.cut({ user: '阿伟', userKey: 'u2' });
    assert.equal(success.ok, true);
    assert.equal(success.song.title, '稻香');
    assert.equal(manager.snapshot().current.title, '稻香');
    assert.equal(played.length, 2);
  } finally {
    manager.dispose();
  }
});

test('队列为空时切歌失败，即使当前歌是自己点的', async () => {
  const clock = { value: 6_500_000 };
  const { manager } = makeManager(clock, { queueCutSec: 90, dailyRecommend: true });
  try {
    await manager.request({ query: '晴天', user: '小明', userKey: 'u1', cooldownSec: 0 });
    clock.value += 91_000;
    const empty = await manager.cut({ user: '小明', userKey: 'u1' });
    assert.equal(empty.ok, false);
    assert.equal(empty.reason, 'empty');
    assert.equal(manager.snapshot().current.title, '晴天');
  } finally {
    manager.dispose();
  }
});

test('当前歌的点歌人满 90 秒后也能切歌', async () => {
  const clock = { value: 11_000_000 };
  const { manager, played } = makeManager(clock, { queueCutSec: 90 });
  try {
    await manager.request({ query: '晴天', user: '小明', userKey: 'u1', cooldownSec: 0 });
    clock.value += 1000;
    await manager.request({ query: '稻香', user: '阿伟', userKey: 'u2', cooldownSec: 0 });
    clock.value += 90_000;
    const cut = await manager.cut({ user: '小明', userKey: 'u1' });
    assert.equal(cut.ok, true);
    assert.equal(cut.song.title, '稻香');
    assert.equal(manager.snapshot().current.title, '稻香');
    assert.equal(played.length, 2);
  } finally {
    manager.dispose();
  }
});

test('当前歌超过 90 秒，新点歌进来也不会自动切', async () => {
  const clock = { value: 7_000_000 };
  const { manager, played } = makeManager(clock, { queueCutSec: 90 });
  try {
    await manager.request({ query: '晴天', user: '小明', userKey: 'u1', cooldownSec: 0 });
    clock.value += 120_000;
    await manager.request({ query: '稻香', user: '阿伟', userKey: 'u2', cooldownSec: 0 });
    assert.equal(manager.snapshot().current.title, '晴天');
    assert.equal(manager.snapshot().queue[0].title, '稻香');
    assert.equal(played.length, 1);
  } finally {
    manager.dispose();
  }
});

test('插队只排到队列前面，不会提前切当前歌曲', async () => {
  const clock = { value: 6_800_000 };
  const { manager, played } = makeManager(clock);
  try {
    await manager.request({ query: '晴天', user: '小明' });
    clock.value += 10_000;
    const priority = await manager.request({ query: '稻香', user: '阿伟', priority: true });
    assert.equal(priority.ok, true);
    assert.equal(priority.switchInSec, 0);
    assert.equal(manager.snapshot().current.title, '晴天');
    assert.equal(manager.snapshot().queue[0].title, '稻香');
    assert.equal(played.length, 1);
  } finally {
    manager.dispose();
  }
});

test('版本后缀会生成基础歌名搜索词', () => {
  const rain = qqQueryAlternatives('雨爱 司凤版');
  assert.ok(rain.includes('雨爱'));
  const live = qqQueryAlternatives('晴天 (Live)');
  assert.ok(live.includes('晴天'));
  assert.deepEqual(qqQueryAlternatives('周杰伦 晴天'), []);
});
test('点歌先进免费区，送礼后按规则移动到插队区', async () => {
  const clock = { value: 9_000_000 };
  const { manager } = makeManager(clock, { maxQueue: 5 });
  try {
    await manager.request({ query: '晴天', user: '主播', userKey: 'host', cooldownSec: 0 });
    clock.value += 1000;
    const first = await manager.request({
      query: '稻香',
      user: '甲',
      userKey: 'u1',
      cooldownSec: 0,
    });
    const second = await manager.request({
      query: '七里香',
      user: '乙',
      userKey: 'u2',
      cooldownSec: 0,
    });
    const normal = await manager.request({
      query: '夜曲',
      user: '丙',
      userKey: 'u3',
      cooldownSec: 0,
    });
    assert.deepEqual(manager.snapshot().queue.map((song) => song.title), ['稻香', '七里香', '夜曲']);
    assert.equal(first.position, 1);
    assert.equal(second.position, 2);
    assert.equal(normal.position, 3);
    assert.equal(manager.snapshot().queue.every((song) => !song.priority), true);

    let moved = manager.prioritizeUserQueue({ user: '甲', userKey: 'u1' });
    assert.equal(moved.moved, 1);
    assert.equal(moved.zone, 'free');
    assert.deepEqual(manager.snapshot().queue.map((song) => song.title), ['稻香', '七里香', '夜曲']);

    moved = manager.prioritizeUserQueue({ user: '乙', userKey: 'u2' });
    assert.equal(moved.zone, 'free');
    assert.deepEqual(manager.snapshot().queue.map((song) => song.title), ['稻香', '七里香', '夜曲']);
    assert.equal(manager.snapshot().queue[1].priority, true);

    moved = manager.prioritizeUserQueue({ user: '乙', userKey: 'u2' });
    assert.equal(moved.zone, 'priority');
    assert.deepEqual(manager.snapshot().queue.map((song) => song.title), ['七里香', '稻香', '夜曲']);
    assert.equal(manager.snapshot().current.title, '晴天');
  } finally {
    manager.dispose();
  }
});
test('当前没在播但队列里有自己的点歌时，切歌会直接开播', async () => {
  const clock = { value: 6_600_000 };
  const { manager, played } = makeManager(clock, { autoPlay: false, queueCutSec: 90 });
  try {
    await manager.request({ query: '稻香', user: '阿伟', userKey: 'u2', cooldownSec: 0 });
    assert.equal(manager.snapshot().current, null);
    assert.equal(manager.snapshot().queue.length, 1);

    const cut = await manager.cut({ user: '阿伟', userKey: 'u2' });
    assert.equal(cut.ok, true);
    assert.equal(cut.reason, 'cut');
    assert.equal(manager.snapshot().current.title, '稻香');
    assert.equal(manager.snapshot().queue.length, 0);
    assert.equal(played.length, 1);
  } finally {
    manager.dispose();
  }
});

test('当前没在播且队列里没有自己的点歌时，切歌提示先点歌', async () => {
  const clock = { value: 6_700_000 };
  const { manager, played } = makeManager(clock, { autoPlay: false });
  try {
    await manager.request({ query: '稻香', user: '阿伟', userKey: 'u2', cooldownSec: 0 });
    const cut = await manager.cut({ user: '路人', userKey: 'u3' });
    assert.equal(cut.ok, false);
    assert.equal(cut.reason, 'need_request');
    assert.equal(manager.snapshot().current, null);
    assert.equal(played.length, 0);
  } finally {
    manager.dispose();
  }
});

test('桥接启动时队列积压会自动开播，不再一直放客户端歌单', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dy-song-'));
  const persistPath = path.join(dir, 'song-state.json');
  const clock = { value: 12_000_000 };
  try {
    const seed = {
      version: 1,
      savedAt: clock.value,
      queue: [
        {
          source: 'qq',
          id: '273032694',
          title: '明天过后',
          artist: '张杰',
          duration: 238000,
          requestId: 'song-seed-1',
          requestedBy: '阿伟',
          requesterKey: 'u2',
          requestedAt: clock.value,
          priority: false,
        },
      ],
      current: null,
      paused: false,
      elapsed: 0,
    };
    writeFileSync(persistPath, JSON.stringify(seed), 'utf8');
    const { manager, played } = makeManager(clock, {}, { persistPath });
    try {
      await new Promise((resolve) => setTimeout(resolve, 3200));
      assert.equal(manager.snapshot().current.title, '明天过后');
      assert.equal(manager.snapshot().queue.length, 0);
      assert.equal(played.length, 1);
    } finally {
      manager.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('桥接重启后点歌队列会从磁盘恢复', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dy-song-'));
  const persistPath = path.join(dir, 'song-state.json');
  const clock = { value: 10_000_000 };
  try {
    const first = makeManager(clock, {}, { persistPath });
    await first.manager.request({ query: '晴天', user: '小明', userKey: 'u1', cooldownSec: 0 });
    clock.value += 1000;
    await first.manager.request({ query: '稻香', user: '阿伟', userKey: 'u2', cooldownSec: 0 });
    first.manager.dispose();

    const second = makeManager(clock, {}, { persistPath });
    const snap = second.manager.snapshot();
    assert.equal(snap.current.title, '晴天');
    assert.equal(snap.queue[0].title, '稻香');
    assert.equal(snap.queue[0].requestedBy, '阿伟');
    second.manager.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('当前是每日推荐时，新点歌先排队，等推荐曲播完再上台', async () => {
  const clock = { value: 11_000_000 };
  const recommendImpl = async () => [
    {
      source: 'qq',
      id: 'rec-1',
      title: '每日推荐曲',
      artist: '系统推荐',
      album: '',
      duration: 180000,
      cover: '',
      webUrl: '',
    },
  ];
  const { manager, played } = makeManager(clock, {}, { recommendImpl });
  try {
    await manager.request({ query: '晴天', user: '小明', userKey: 'u1', cooldownSec: 0 });
    clock.value += 1000;
    await manager.skip();
    assert.equal(manager.snapshot().current.recommend, true);
    assert.equal(manager.snapshot().current.title, '每日推荐曲');

    clock.value += 1000;
    const requested = await manager.request({
      query: '稻香',
      user: '阿伟',
      userKey: 'u2',
      cooldownSec: 0,
    });
    assert.equal(requested.ok, true);
    // 推荐曲是真实接管的播放，点歌不再把它从画面上“切走”，先排队等它播完
    assert.equal(manager.snapshot().current.title, '每日推荐曲');
    assert.equal(manager.snapshot().queue[0].title, '稻香');
    assert.equal(requested.position, 1);

    clock.value += 1000;
    assert.equal((await manager.skip()).ok, true);
    assert.equal(manager.snapshot().current.title, '稻香');
    assert.equal(played.at(-1).title, '稻香');
  } finally {
    manager.dispose();
  }
});
test('清理恐怖类歌曲会同时移除当前曲和队列', async () => {
  const clock = { value: 12_000_000 };
  const { manager } = makeManager(clock);
  try {
    await manager.request({ query: '恐怖童谣', user: '甲', userKey: 'u1', cooldownSec: 0 });
    clock.value += 1000;
    await manager.request({ query: '晴天', user: '乙', userKey: 'u2', cooldownSec: 0 });
    const result = manager.purgeHorror();
    assert.equal(result.removedCurrent, true);
    assert.equal(result.removedQueue, 0);
    assert.equal(manager.snapshot().current, null);
    assert.equal(manager.snapshot().queue[0].title, '晴天');
  } finally {
    manager.dispose();
  }
});
test('恐怖片配乐会被清理，胆小鬼这类普通歌保留', async () => {
  const clock = { value: 12_500_000 };
  const { manager } = makeManager(clock);
  try {
    await manager.request({ query: '午夜凶铃', user: '甲', userKey: 'u1', cooldownSec: 0 });
    clock.value += 1000;
    await manager.request({ query: '胆小鬼', user: '乙', userKey: 'u2', cooldownSec: 0 });
    const result = manager.purgeHorror();
    assert.equal(result.removedCurrent, true);
    assert.equal(manager.snapshot().current, null);
    assert.equal(manager.snapshot().queue[0].title, '胆小鬼');
  } finally {
    manager.dispose();
  }
});
test('已点歌用户送礼物后可把队列里的歌插到最前面', async () => {
  const clock = { value: 13_000_000 };
  const { manager } = makeManager(clock);
  try {
    await manager.request({ query: '晴天', user: '主播', userKey: 'host', cooldownSec: 0 });
    clock.value += 1000;
    await manager.request({ query: '稻香', user: '阿伟', userKey: 'u2', cooldownSec: 0 });
    clock.value += 1000;
    await manager.request({ query: '七里香', user: '小红', userKey: 'u3', cooldownSec: 0 });
    const result = manager.prioritizeUserQueue({ user: '小红', userKey: 'u3' });
    assert.equal(result.moved, 1);
    assert.equal(manager.snapshot().queue[0].title, '七里香');
    assert.equal(manager.snapshot().queue[0].priority, true);
    assert.equal(manager.snapshot().current.title, '晴天');
  } finally {
    manager.dispose();
  }
});

test('本地播放模式：网易云直链下发给背景板', async () => {
  const clock = { value: 1_000_000 };
  const manager = createSongManager({
    now: () => clock.value,
    config: { autoPlay: true, provider: 'netease', player: 'local' },
    searchImpl: async (query) => ({
      source: 'netease',
      id: `163-${query}`,
      title: query,
      artist: '周杰伦',
      album: '',
      duration: 200000,
      cover: '',
      webUrl: '',
    }),
    urlImpl: async () => 'http://127.0.0.1:1/audio.mp3',
    emit: () => {},
  });
  try {
    const result = await manager.request({ query: '晴天', user: '小明' });
    assert.equal(result.ok, true);
    const snap = manager.snapshot();
    assert.equal(snap.current.playUrl, 'http://127.0.0.1:1/audio.mp3');
    assert.equal(snap.current.playMode, 'local');
    assert.equal(snap.current.title, '晴天');
  } finally {
    manager.dispose();
  }
});

test('本地播放模式：版权受限记录错误并排程跳过', async () => {
  const clock = { value: 1_000_000 };
  const manager = createSongManager({
    now: () => clock.value,
    config: { autoPlay: true, provider: 'netease', player: 'local' },
    searchImpl: async (query) => ({
      source: 'netease',
      id: `163-${query}`,
      title: query,
      artist: '',
      album: '',
      duration: 200000,
      cover: '',
      webUrl: '',
    }),
    urlImpl: async () => '',
    emit: () => {},
  });
  try {
    const result = await manager.request({ query: '付费歌', user: '小明' });
    assert.equal(result.ok, false);
    assert.match(result.error, /版权限制/);
    const snap = manager.snapshot();
    assert.match(snap.lastError, /版权限制/);
    assert.equal(snap.current, null);
  } finally {
    manager.dispose();
  }
});

test('本地播放模式：非网易云来源按歌名重搜拿直链', async () => {
  const clock = { value: 1_000_000 };
  const manager = createSongManager({
    now: () => clock.value,
    config: { autoPlay: true, provider: 'qq', player: 'local' },
    searchImpl: async (query, provider) => ({
      source: provider === 'netease' ? 'netease' : 'qq',
      id: provider === 'netease' ? `163-${query}` : `qq-${query}`,
      title: query,
      artist: '',
      album: '',
      duration: 200000,
      cover: '',
      webUrl: '',
    }),
    urlImpl: async () => 'http://127.0.0.1:1/matched.mp3',
    emit: () => {},
  });
  try {
    const result = await manager.request({ query: '晴天', user: '小明' });
    assert.equal(result.ok, true);
    const snap = manager.snapshot();
    assert.equal(snap.current.source, 'qq');
    assert.equal(snap.current.playUrl, 'http://127.0.0.1:1/matched.mp3');
    assert.match(snap.current.localMatched, /晴天/);
  } finally {
    manager.dispose();
  }
});

test('点歌意图识别更宽泛：多种说法都能提取歌名', () => {
  const cases = [
    ['点歌 晴天', '晴天'],
    ['点歌：晴天', '晴天'],
    ['点歌晴天', '晴天'],
    ['点一首晴天', '晴天'],
    ['点首歌 晴天', '晴天'],
    ['点首晴天', '晴天'],
    ['点个晴天', '晴天'],
    ['我想点歌 晴天', '晴天'],
    ['主播 点歌 晴天', '晴天'],
    ['@小明 点歌 晴天 谢谢', '晴天'],
    ['可以点歌 晴天吗', '晴天'],
    ['想听晴天', '晴天'],
    ['我想听晴天', '晴天'],
    ['我要听雨爱司风版', '雨爱司风版'],
    ['好想听晴天', '晴天'],
    ['想听一首晴天', '晴天'],
    ['来一首晴天', '晴天'],
    ['来首晴天', '晴天'],
    ['放首晴天', '晴天'],
    ['播一首晴天', '晴天'],
    ['播放晴天', '晴天'],
    ['播放 晴天', '晴天'],
    ['播放一首晴天', '晴天'],
    ['帮我播放晴天', '晴天'],
    ['放一下晴天', '晴天'],
    ['唱首晴天', '晴天'],
    ['求一首晴天', '晴天'],
    ['能不能来首晴天', '晴天'],
    ['帮我放首晴天', '晴天'],
    ['想听你唱晴天', '晴天'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(parseSongQuery(input), expected, input);
  }
  assert.equal(parseSongQuery('点歌'), '');
  assert.equal(parseSongQuery('想听'), '');
  assert.equal(parseSongQuery('播放'), '');
  assert.equal(parseSongQuery('播放器卡了'), null);
  assert.equal(parseSongQuery('播放列表里没有'), null);
  assert.equal(parseSongQuery('播放暂停一下'), null);
  assert.equal(parseSongQuery('可以放首歌吗'), '');
  assert.equal(parseSongQuery('想听你说说话'), null);
  assert.equal(parseSongQuery('想听你聊天'), null);
  assert.equal(parseSongQuery('我要听你说话'), null);
  assert.equal(parseSongQuery('我要听歌'), '');
  assert.equal(parseSongQuery('来啦'), null);
  assert.equal(parseSongQuery('今天天气不错'), null);
  assert.equal(parseSongQuery('点关注'), null);
  assert.equal(parseSongQuery('点歌 晴天', '想听'), '晴天');
  assert.equal(parseSongQuery('听歌 晴天', '听歌'), '晴天');
});

test('切歌意图识别更宽泛，且不误判点歌', () => {
  const cut = [
    '切歌',
    '切歌吧',
    '主播 切歌',
    '可以切歌吗',
    '帮我换一首',
    '换首歌',
    '换一个',
    '下一首',
    '下一首歌',
    '下一曲',
    '跳过',
    '跳过这首',
    '切掉这首',
    '把这首歌切了',
    '这首不好听 切歌',
    '这首歌不行，换歌吧',
    '不要这首',
    '不想听这首了',
    '赶紧下一首',
    '@小明 切歌 谢谢',
    '能切下一首吗',
    '求求了 切歌',
  ];
  for (const input of cut) assert.equal(parseCutSongIntent(input), true, input);

  const chat = [
    '下一首想听晴天',
    '换一首歌 晴天',
    '我想听晴天',
    '点歌 晴天',
    '今天天气不错',
    '切',
    '过',
    '这首歌真好听',
    '为什么切歌',
  ];
  for (const input of chat) assert.equal(parseCutSongIntent(input), false, input);
});

test('音乐音量指令识别宽泛，且不误判普通弹幕', () => {
  const cases = {
    '音量调到30': { action: 'set', volume: 30 },
    '声音30%': { action: 'set', volume: 30 },
    '音乐调到50': { action: 'set', volume: 50 },
    '调到50': { action: 'set', volume: 50 },
    '音量200': { action: 'set', volume: 200 },
    '音量调到五十': { action: 'set', volume: 50 },
    '声音调到十五': { action: 'set', volume: 15 },
    '音量调到一百': { action: 'set', volume: 100 },
    '音量调到百分之五十': { action: 'set', volume: 50 },
    '音量加10': { action: 'up', step: 10 },
    '音量减5': { action: 'down', step: 5 },
    '声音大点': { action: 'up' },
    '音量调大一点': { action: 'up' },
    '音量往上调': { action: 'up' },
    '调高音量': { action: 'up' },
    '音量增加': { action: 'up' },
    '大声点': { action: 'up' },
    '声音太小了': { action: 'up' },
    '声音小点': { action: 'down' },
    '音量往下调': { action: 'down' },
    '调低音量': { action: 'down' },
    '音量减少': { action: 'down' },
    '小点声': { action: 'down' },
    '音乐关小一点': { action: 'down' },
    '声音太大了': { action: 'down' },
    '最大声': { action: 'max' },
    '音量拉到最大': { action: 'max' },
    '音量拉满': { action: 'max' },
    '最小声': { action: 'min' },
    '音量调到最小': { action: 'min' },
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.deepEqual(parseVolumeIntent(input), expected, input);
  }

  for (const input of [
    '这首歌真好听',
    '点歌 7 rings',
    '今天天气不错',
    '声音真好听',
    '我想听晴天',
    '点歌 七里香',
    '音量调到一半',
    '音量调到十点五',
  ]) {
    assert.equal(parseVolumeIntent(input), null, input);
  }
});

test('不同搜索结果但同一首歌，也能提示正在播放或已在队列', async () => {
  const clock = { value: 10_000_000 };
  const manager = createSongManager({
    now: () => clock.value,
    config: { autoPlay: true, perUserCooldownSec: 0, maxQueue: 10 },
    searchImpl: async (query) => {
      const title = query.includes('稻香') ? '稻香' : '晴天';
      return {
        source: 'qq',
        id: `${title}-${query}`,
        title,
        artist: '周杰伦',
        album: '',
        duration: 180000,
        cover: '',
        webUrl: '',
      };
    },
    playImpl: async () => {},
    emit: () => {},
  });
  try {
    const first = await manager.request({ query: '晴天', user: '小明', userKey: 'u1' });
    assert.equal(first.ok, true);
    clock.value += 5000;
    const playing = await manager.request({ query: '周杰伦 晴天', user: '小红', userKey: 'u2' });
    assert.equal(playing.ok, false);
    assert.equal(playing.alreadyQueued, true);
    assert.equal(playing.duplicateState, 'current');
    assert.equal(playing.requestedBy, '小明');

    clock.value += 1000;
    await manager.request({ query: '稻香', user: '小明', userKey: 'u1' });
    const queued = await manager.request({ query: '稻香 周杰伦', user: '小红', userKey: 'u2' });
    assert.equal(queued.ok, false);
    assert.equal(queued.duplicateState, 'queue');
    assert.equal(queued.position, 1);
    assert.equal(queued.requestedBy, '小明');
  } finally {
    manager.dispose();
  }
});

test('插队咨询：怎么插队、要送什么都能识别', () => {
  const ask = [
    '怎么插队',
    '怎么样才能插队',
    '怎样插队',
    '如何插队',
    '咋插队',
    '插队怎么弄',
    '插队要送什么',
    '插队需要什么礼物',
    '插队是什么意思',
    '什么是插队',
    '我能插队吗',
    '可以插队吗',
    '小心心能插队吗',
    '插个队可以吗',
    '插队',
    '主播 怎么插队呀',
  ];
  for (const text of ask) assert.equal(isQueueJumpQuestion(text), true, `${text} 应识别为插队咨询`);

  const skip = [
    '点歌 插队',
    '点一首插队',
    '插队这首歌真好听',
    '不要插队啦',
    '他插队被我举报了，管理员已经处理完毕',
    '我们排队排了很久，前面那个人一直在插队，真的很烦',
    '切歌',
    '现在几点',
    '',
  ];
  for (const text of skip) assert.equal(isQueueJumpQuestion(text), false, `${text} 不应识别为插队咨询`);
});

test('切歌咨询：切歌到某某、切到第几首都算咨询，真指令不抢', () => {
  const ask = [
    '切歌到晴天',
    '切歌到周杰伦的晴天',
    '切到第3首',
    '切到第x首',
    '切歌到第三首',
    '可以切到第2首吗',
    '切到小明的歌',
    '怎么切歌',
    '如何切歌',
    '切歌规则是什么',
    '切歌有什么要求',
    '什么是切歌',
    '切歌是什么意思',
    '主播 切歌到晴天',
  ];
  for (const text of ask) assert.equal(isCutSongQuestion(text), true, `${text} 应识别为切歌咨询`);

  const command = ['切歌', '切歌吧', '可以切歌吗', '换一首', '下一首', '这首不好听', '切掉这首'];
  for (const text of command) assert.equal(isCutSongQuestion(text), false, `${text} 是切歌指令，不应当成咨询`);

  const skip = ['这首歌切到副歌了', '他刚才切歌了', '点歌 晴天', '现在几点', ''];
  for (const text of skip) assert.equal(isCutSongQuestion(text), false, `${text} 不应识别为切歌咨询`);
});

test('违规歌曲处置：移除后其余歌曲顺序不变，违规与拉黑写入文件', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dy-song-'));
  const persistPath = path.join(dir, 'song-state.json');
  const violationPath = path.join(dir, 'song-violations.json');
  const clock = { value: 14_000_000 };
  try {
    const { manager } = makeManager(clock, { autoPlay: false, maxQueue: 10 }, { persistPath, violationPath });
    try {
      await manager.request({ query: '晴天', user: '小明', userKey: 'u1', cooldownSec: 0 });
      clock.value += 1000;
      await manager.request({ query: '稻香', user: '阿伟', userKey: 'u2', cooldownSec: 0 });
      clock.value += 1000;
      await manager.request({ query: '七里香', user: '小红', userKey: 'u3', cooldownSec: 0 });
      const target = manager.snapshot().queue[1];
      assert.equal(target.title, '稻香');

      const result = await manager.moderateSong({
        requestId: target.requestId,
        reason: '歌词违规',
        allowPlay: false,
      });
      assert.equal(result.ok, true);
      assert.equal(result.removedIndex, 1);
      assert.deepEqual(result.removedSong, { title: '稻香', artist: '测试歌手' });
      assert.equal(result.blocked, true);
      assert.equal(result.queueLength, 2);
      assert.ok(result.recordId);
      // 其余歌曲相对顺序保持不变
      assert.deepEqual(manager.snapshot().queue.map((song) => song.title), ['晴天', '七里香']);

      const saved = JSON.parse(readFileSync(violationPath, 'utf8'));
      assert.equal(saved.version, 1);
      assert.equal(saved.violations.length, 1);
      assert.equal(saved.violations[0].title, '稻香');
      assert.equal(saved.violations[0].artist, '测试歌手');
      assert.equal(saved.violations[0].reason, '歌词违规');
      assert.equal(saved.violations[0].allowPlay, false);
      assert.equal(saved.violations[0].requester, '阿伟');
      assert.equal(saved.violations[0].requesterKey, 'u2');
      assert.equal(saved.blockedUsers.length, 1);
      assert.equal(saved.blockedUsers[0].userKey, 'u2');

      assert.equal(manager.violationSnapshot().violations.length, 1);
      assert.equal(manager.snapshot().moderation.violations, 1);
      assert.equal(manager.snapshot().moderation.blockedUsers, 1);

      const blockedRequest = await manager.request({ query: '夜曲', user: '阿伟', userKey: 'u2' });
      assert.equal(blockedRequest.ok, false);
      assert.equal(blockedRequest.blacklisted, true);
      assert.match(blockedRequest.error, /拉黑/);

      const blockedCut = await manager.cut({ user: '阿伟', userKey: 'u2' });
      assert.equal(blockedCut.blacklisted, true);
      const blockedJump = manager.prioritizeUserQueue({ user: '阿伟', userKey: 'u2' });
      assert.equal(blockedJump.blacklisted, true);
    } finally {
      manager.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('违规歌曲处置会连带清理同用户的其他点歌，且不写入违规名单', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dy-song-'));
  const persistPath = path.join(dir, 'song-state.json');
  const violationPath = path.join(dir, 'song-violations.json');
  const clock = { value: 14_500_000 };
  try {
    const { manager } = makeManager(clock, { autoPlay: false, maxQueue: 10 }, { persistPath, violationPath });
    try {
      await manager.request({ query: '晴天', user: '小明', userKey: 'u1', cooldownSec: 0 });
      clock.value += 1000;
      await manager.request({ query: '稻香', user: '阿伟', userKey: 'u2', cooldownSec: 0 });
      clock.value += 1000;
      await manager.request({ query: '七里香', user: '小明', userKey: 'u1', cooldownSec: 0 });
      clock.value += 1000;
      await manager.request({ query: '夜曲', user: '小红', userKey: 'u3', cooldownSec: 0 });
      const target = manager.snapshot().queue[2];
      assert.equal(target.title, '七里香');

      const result = await manager.moderateSong({
        requestId: target.requestId,
        reason: '测试违规',
        allowPlay: false,
      });
      assert.equal(result.ok, true);
      assert.equal(result.removedIndex, 2);
      assert.deepEqual(result.removedOtherSongs, [{ title: '晴天', artist: '测试歌手', removedIndex: 0 }]);
      assert.equal(result.removedCount, 2);
      // 其他用户的歌曲保持原相对顺序
      assert.deepEqual(manager.snapshot().queue.map((song) => song.title), ['稻香', '夜曲']);
      // 只有违规歌曲写入违规名单，连带清理的歌曲不写入
      assert.equal(manager.violationSnapshot().violations.length, 1);
      assert.equal(manager.violationSnapshot().violations[0].title, '七里香');
      assert.equal(manager.violationSnapshot().blockedUsers.length, 1);
      assert.equal(manager.violationSnapshot().blockedUsers[0].userKey, 'u1');
      const saved = JSON.parse(readFileSync(violationPath, 'utf8'));
      assert.equal(saved.violations.length, 1);
      // 被拉黑用户后续点歌不再处理
      const rejected = await manager.request({ query: '稻香', user: '小明', userKey: 'u1' });
      assert.equal(rejected.ok, false);
      assert.equal(rejected.blacklisted, true);
    } finally {
      manager.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('重启后前置校验拒绝违规歌曲并拉黑新点歌人', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dy-song-'));
  const persistPath = path.join(dir, 'song-state.json');
  const violationPath = path.join(dir, 'song-violations.json');
  const clock = { value: 15_000_000 };
  try {
    const first = makeManager(clock, { autoPlay: false, maxQueue: 10 }, { persistPath, violationPath });
    await first.manager.request({ query: '晴天', user: '小明', userKey: 'u1', cooldownSec: 0 });
    clock.value += 1000;
    await first.manager.request({ query: '稻香', user: '阿伟', userKey: 'u2', cooldownSec: 0 });
    const target = first.manager.snapshot().queue[1];
    const moderated = await first.manager.moderateSong({
      requestId: target.requestId,
      reason: '测试违规',
      allowPlay: false,
    });
    assert.equal(moderated.ok, true);
    first.manager.dispose();

    const second = makeManager(clock, { autoPlay: false, maxQueue: 10 }, { persistPath, violationPath });
    try {
      // 队列恢复时违规歌曲会被过滤掉
      assert.deepEqual(second.manager.snapshot().queue.map((song) => song.title), ['晴天']);

      const rejected = await second.manager.request({ query: '稻香', user: '新人', userKey: 'u4' });
      assert.equal(rejected.ok, false);
      assert.equal(rejected.violation, true);
      assert.equal(rejected.blacklisted, true);
      assert.equal(
        second.manager.violationSnapshot().blockedUsers.some((item) => item.userKey === 'u4'),
        true,
      );

      const ownBlocked = await second.manager.request({ query: '夜曲', user: '阿伟', userKey: 'u2' });
      assert.equal(ownBlocked.ok, false);
      assert.equal(ownBlocked.blacklisted, true);
    } finally {
      second.manager.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('违规文件写盘失败会回滚队列与违规记录', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dy-song-'));
  const blocker = path.join(dir, 'blocker');
  const persistPath = path.join(dir, 'song-state.json');
  const violationPath = path.join(blocker, 'violations.json');
  const clock = { value: 16_000_000 };
  try {
    // blocker 是普通文件，向上创建目录会失败，模拟写盘异常
    writeFileSync(blocker, 'x', 'utf8');
    const { manager } = makeManager(clock, { autoPlay: false, maxQueue: 10 }, { persistPath, violationPath });
    try {
      await manager.request({ query: '晴天', user: '小明', userKey: 'u1', cooldownSec: 0 });
      clock.value += 1000;
      await manager.request({ query: '稻香', user: '阿伟', userKey: 'u2', cooldownSec: 0 });
      const before = manager.snapshot().queue.map((song) => song.title);
      const target = manager.snapshot().queue[0];
      const result = await manager.moderateSong({
        requestId: target.requestId,
        reason: '测试',
        allowPlay: false,
      });
      assert.equal(result.ok, false);
      assert.match(result.error, /回滚/);
      assert.deepEqual(manager.snapshot().queue.map((song) => song.title), before);
      assert.equal(manager.violationSnapshot().violations.length, 0);
      assert.equal(manager.violationSnapshot().blockedUsers.length, 0);
    } finally {
      manager.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('自动点歌（auto-song）处置违规歌曲时不拉黑', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dy-song-'));
  const persistPath = path.join(dir, 'song-state.json');
  const violationPath = path.join(dir, 'song-violations.json');
  const clock = { value: 17_000_000 };
  try {
    const { manager } = makeManager(clock, { autoPlay: false, maxQueue: 10 }, { persistPath, violationPath });
    try {
      await manager.request({ query: '晴天', user: '桌宠', userKey: 'auto-song', cooldownSec: 0 });
      const result = await manager.moderateSong({
        requestId: manager.snapshot().queue[0].requestId,
        reason: '测试违规',
        allowPlay: false,
      });
      assert.equal(result.ok, true);
      assert.equal(result.blocked, false);
      assert.equal(manager.violationSnapshot().blockedUsers.length, 0);
      assert.equal(manager.violationSnapshot().violations.length, 1);
    } finally {
      manager.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
