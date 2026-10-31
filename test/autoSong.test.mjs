import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTO_SONG_INTERVAL_MS,
  AUTO_SONG_LIBRARY_MAX,
  AUTO_SONG_SOURCE_PREFIX,
  AUTO_SONG_VOICE_TEXT,
  autoSongTrigger,
  buildAutoSongSender,
  buildPetSongReply,
  isPositiveSong,
  mergeAutoSongLibrary,
  normalizeAutoSong,
  parseAutoSongList,
  pickAutoSongFromLibrary,
} from '../extension/app/core/autoSong.js';
import { suggestPositiveSongs } from '../extension/app/core/ai.js';
import { isPetSongHelp } from '../extension/app/core/songIntent.js';

test('歌曲规范化：支持对象和字符串，过滤负面与敏感歌曲', () => {
  assert.deepEqual(normalizeAutoSong({ title: '好运来', artist: '祖海' }), {
    title: '好运来',
    artist: '祖海',
  });
  assert.deepEqual(normalizeAutoSong('1. 《恭喜发财》 - 刘德华'), {
    title: '恭喜发财',
    artist: '刘德华',
  });
  assert.deepEqual(normalizeAutoSong('小幸运（田馥甄）'), {
    title: '小幸运',
    artist: '田馥甄',
  });
  assert.equal(normalizeAutoSong('分手快乐 - 梁静茹'), null);
  assert.equal(normalizeAutoSong('国歌'), null);
  assert.equal(normalizeAutoSong(''), null);
  assert.equal(isPositiveSong({ title: '今天你要嫁给我' }), true);
  assert.equal(isPositiveSong({ title: '伤心太平洋' }), false);
});

test('解析大模型歌曲列表：JSON 优先，多余文字忽略，去重并过滤负面歌曲', () => {
  const json = '好的，推荐如下：\n[{"title":"恭喜发财","artist":"刘德华"},{"title":"好运来","artist":"祖海"},{"title":"伤心太平洋","artist":"任贤齐"},{"title":"恭喜发财","artist":"刘德华"}]';
  assert.deepEqual(parseAutoSongList(json), [
    { title: '恭喜发财', artist: '刘德华' },
    { title: '好运来', artist: '祖海' },
  ]);

  const lines = '1. 恭喜发财 - 刘德华\n2. 好运来（祖海）\n3. 分手快乐 - 梁静茹';
  assert.deepEqual(parseAutoSongList(lines), [
    { title: '恭喜发财', artist: '刘德华' },
    { title: '好运来', artist: '祖海' },
  ]);
});

test('歌曲库合并去重并保留最近歌曲', () => {
  const merged = mergeAutoSongLibrary(
    [{ title: '好运来', artist: '祖海' }],
    [{ title: '恭喜发财', artist: '刘德华' }, { title: '好运来', artist: '祖海' }],
    10,
  );
  assert.deepEqual(merged, [
    { title: '好运来', artist: '祖海' },
    { title: '恭喜发财', artist: '刘德华' },
  ]);
  const capped = mergeAutoSongLibrary([], [
    { title: 'A' },
    { title: 'B' },
    { title: 'C' },
  ], 2);
  assert.deepEqual(capped, [{ title: 'B', artist: '' }, { title: 'C', artist: '' }]);
  assert.equal(mergeAutoSongLibrary([], [], AUTO_SONG_LIBRARY_MAX).length, 0);
});

test('歌曲库随机挑选会跳过正在播放或已排队的歌', () => {
  const library = [
    { title: '好运来', artist: '祖海' },
    { title: '恭喜发财', artist: '刘德华' },
  ];
  assert.deepEqual(pickAutoSongFromLibrary(library, () => 0, ['好运来']), {
    title: '恭喜发财',
    artist: '刘德华',
  });
  assert.equal(pickAutoSongFromLibrary(library, () => 0, ['好运来', '恭喜发财']), null);
  assert.deepEqual(pickAutoSongFromLibrary(library, () => 0.99), {
    title: '恭喜发财',
    artist: '刘德华',
  });
});

test('触发判定：队列为空、正在播放推荐音乐、有在线观众且过了冷却', () => {
  const base = {
    queueLength: 0,
    current: { title: '每日推荐曲', recommend: true },
    audienceCount: 3,
    now: 10_000_000,
    lastAt: 0,
    minIntervalMs: AUTO_SONG_INTERVAL_MS,
  };
  assert.equal(autoSongTrigger(base), true);
  assert.equal(autoSongTrigger({ ...base, queueLength: 1 }), false);
  assert.equal(autoSongTrigger({ ...base, current: { title: '观众点的歌', recommend: false } }), false);
  assert.equal(autoSongTrigger({ ...base, current: null }), false);
  assert.equal(autoSongTrigger({ ...base, audienceCount: 0 }), false);
  assert.equal(
    autoSongTrigger({ ...base, lastAt: base.now - AUTO_SONG_INTERVAL_MS + 1000 }),
    false,
  );
});

test('点歌人固定为大肥鱼点给@xxx，语音文案固定', () => {
  assert.equal(buildAutoSongSender('小明'), `${AUTO_SONG_SOURCE_PREFIX}小明`);
  assert.equal(buildAutoSongSender('@小明'), `${AUTO_SONG_SOURCE_PREFIX}小明`);
  assert.equal(AUTO_SONG_VOICE_TEXT, '大肥鱼点了一首歌送给你');
});

test('「帮我点首歌」识别为桌宠帮点歌，带歌名的仍走普通点歌', () => {
  for (const text of [
    '帮我点首歌',
    '帮我点歌',
    '帮我点首',
    '帮我点个歌',
    '给我点一首歌',
    '替我点一首歌',
    '大肥鱼帮我点首歌',
    '桌宠帮我点歌',
    '@小明 帮我点首歌',
    '能不能帮我点首歌',
    '你可以帮我点首歌吗？',
    '麻烦帮我点首歌吧谢谢',
    '帮我点首歌行不行',
  ]) {
    assert.equal(isPetSongHelp(text), true, text);
  }
  for (const text of [
    '帮我点首歌 晴天',
    '帮我点首歌《晴天》',
    '帮我点个外卖',
    '帮我点歌台',
    '点歌',
    '点歌 晴天',
    '点一首歌',
    '帮我点一首歌送给她',
  ]) {
    assert.equal(isPetSongHelp(text), false, text);
  }
});

test('帮点歌公屏回复固定带 @ 和祝福语', () => {
  assert.equal(
    buildPetSongReply('小明', '好运来'),
    '@小明，送你一首《好运来》，每天都要开开心心哦！',
  );
  assert.equal(
    buildPetSongReply('@小明', '恭喜发财'),
    '@小明，送你一首《恭喜发财》，每天都要开开心心哦！',
  );
});

test('大模型歌曲推荐只取正向祝福歌曲并解析出列表', async () => {
  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, options) => {
    captured = { url, body: JSON.parse(options.body) };
    return new Response(
      JSON.stringify({
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content:
                '[{"title":"恭喜发财","artist":"刘德华"},{"title":"好运来","artist":"祖海"},{"title":"伤心太平洋","artist":"任贤齐"}]',
            },
          },
        ],
        usage: { total_tokens: 88 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
  try {
    const result = await suggestPositiveSongs({
      ai: {
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        apiKey: 'sk-test',
        maxTokens: 300,
        temperature: 0.8,
      },
      count: 5,
      exclude: ['晴天'],
    });
    assert.equal(result.songs.length, 2);
    assert.deepEqual(result.songs[0], { title: '恭喜发财', artist: '刘德华' });
    assert.equal(result.tokens, 88);
    assert.match(captured.body.messages[0].content, /正向祝福/);
    assert.match(captured.body.messages[0].content, /JSON 数组/);
    assert.match(captured.body.messages[1].content, /晴天/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('未配置 AI 时歌曲推荐安全跳过', async () => {
  const result = await suggestPositiveSongs({ ai: { apiKey: '' } });
  assert.equal(result.skipped, true);
  assert.deepEqual(result.songs, []);
});
