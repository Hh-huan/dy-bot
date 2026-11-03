import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TTS_VOICE,
  DEFAULT_VOICE_DESIGN,
  VOICE_DESIGN_MODEL,
  detectSpeechLang,
  hexToBytes,
  isVoiceDesign,
  mimoModel,
  resolveTtsKey,
  synthesizeMiMo,
  synthesizeMinimax,
  ttsConfig,
} from '../extension/app/core/minimaxTts.js';
import { mergeSettings } from '../extension/app/core/store.js';

const originalFetch = globalThis.fetch;

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function settings(patch = {}) {
  return mergeSettings({
    ai: {
      enabled: true,
      fallback: { apiKey: 'mm-fallback-key' },
    },
    tts: {
      baseUrl: 'https://api.minimax.cn/v1',
      model: 'speech-2.8-hd',
      voiceId: DEFAULT_TTS_VOICE,
      speed: 1,
      pitch: 2,
      apiKey: '',
      ...patch,
    },
  });
}

test('TTS Key 留空时复用 MiniMax 备用 Key', () => {
  assert.equal(resolveTtsKey(settings()), 'mm-fallback-key');
  assert.equal(resolveTtsKey(settings({ apiKey: 'tts-only-key' })), 'tts-only-key');
  assert.equal(resolveTtsKey(mergeSettings({ ai: { fallback: { apiKey: '' } } })), '');
});

test('MiniMax TTS 请求使用幼小可爱音色与 hex 音频', async () => {
  let captured = null;
  globalThis.fetch = async (url, options) => {
    captured = { url: String(url), options, body: JSON.parse(options.body) };
    return jsonResponse({
      base_resp: { status_code: 0, status_msg: 'success' },
      data: { audio: '494433' },
      extra_info: { audio_length: 1200 },
    });
  };
  try {
    const result = await synthesizeMinimax('你好呀', settings());
    assert.equal(captured.url, 'https://api.minimax.cn/v1/t2a_v2');
    assert.equal(captured.options.headers.Authorization, 'Bearer mm-fallback-key');
    assert.equal(captured.body.model, 'speech-2.8-hd');
    assert.equal(captured.body.language_boost, 'auto');
    assert.equal(captured.body.voice_setting.voice_id, DEFAULT_TTS_VOICE);
    assert.equal(captured.body.voice_setting.pitch, 2);
    assert.equal(captured.body.voice_setting.emotion, 'happy');
    assert.equal(captured.body.audio_setting.format, 'mp3');
    assert.deepEqual([...result.audio], [0x49, 0x44, 0x33]);
    assert.equal(result.mime, 'audio/mpeg');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('浏览器兜底 TTS 按语言自动切换 lang', () => {
  assert.equal(detectSpeechLang('你好呀，今天想听什么歌'), 'zh-CN');
  assert.equal(detectSpeechLang('こんにちは、元気ですか'), 'ja-JP');
  assert.equal(detectSpeechLang('안녕하세요, 반가워요'), 'ko-KR');
  assert.equal(detectSpeechLang('Hello! How are you today?'), 'en-US');
});

test('MiniMax TTS 错误码会抛出', async () => {
  globalThis.fetch = async () =>
    jsonResponse({ base_resp: { status_code: 1002, status_msg: 'rate limited' }, data: null });
  try {
    await assert.rejects(synthesizeMinimax('你好', settings()), /错误 1002/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('非法 hex 音频会报错', () => {
  assert.throws(() => hexToBytes('zz'), /hex/);
  assert.deepEqual([...hexToBytes('494433')], [0x49, 0x44, 0x33]);
});

test('切到 MiMo 时地址、模型与音色自动切换', () => {
  const config = ttsConfig(settings({ provider: 'mimo' }));
  assert.equal(config.provider, 'mimo');
  assert.equal(config.baseUrl, 'https://api.xiaomimimo.com/v1');
  assert.equal(config.model, 'mimo-v2.5-tts');
  assert.equal(config.voiceId, '冰糖');
  assert.equal(ttsConfig(settings()).voiceId, DEFAULT_TTS_VOICE);
});

test('MiMo Key 不会误用 MiniMax 备用 Key', () => {
  assert.equal(resolveTtsKey(settings({ provider: 'mimo' })), '');
  assert.equal(resolveTtsKey(settings({ provider: 'mimo', apiKey: 'mimo-key' })), 'mimo-key');
  assert.equal(resolveTtsKey(settings()), 'mm-fallback-key');
});

test('MiMo TTS 请求使用 api-key 头与 assistant 文本', async () => {
  let captured = null;
  globalThis.fetch = async (url, options) => {
    captured = { url: String(url), headers: options.headers, body: JSON.parse(options.body) };
    return jsonResponse({ choices: [{ message: { audio: { data: 'SUQz' } } }] });
  };
  try {
    const result = await synthesizeMiMo(
      '你好呀',
      settings({ provider: 'mimo', apiKey: 'mimo-key', mimoStyle: '活泼甜美，语速稍快' }),
    );
    assert.equal(captured.url, 'https://api.xiaomimimo.com/v1/chat/completions');
    assert.equal(captured.headers['api-key'], 'mimo-key');
    assert.equal(captured.body.model, 'mimo-v2.5-tts');
    assert.deepEqual(captured.body.audio, { format: 'wav', voice: '冰糖' });
    assert.deepEqual(captured.body.messages.map((item) => item.role), ['user', 'assistant']);
    assert.equal(captured.body.messages[0].content, '活泼甜美，语速稍快');
    assert.equal(captured.body.messages[1].content, '你好呀');
    assert.deepEqual([...result.audio], [0x49, 0x44, 0x33]);
    assert.equal(result.mime, 'audio/wav');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('MiMo 返回错误对象会抛出', async () => {
  globalThis.fetch = async () => jsonResponse({ error: { message: 'invalid api key' } });
  try {
    await assert.rejects(synthesizeMiMo('你好', settings({ provider: 'mimo', apiKey: 'k' })), /invalid api key/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('切到音色设计模型时 voice 参数省略，user 消息作为音色描述', async () => {
  const config = ttsConfig(settings({ provider: 'mimo', mimoModel: VOICE_DESIGN_MODEL }));
  assert.equal(isVoiceDesign(settings({ provider: 'mimo', mimoModel: VOICE_DESIGN_MODEL })), true);
  assert.equal(config.model, VOICE_DESIGN_MODEL);
  assert.equal(config.voiceDesign, true);
  assert.equal(config.voiceId, '');

  let captured = null;
  globalThis.fetch = async (url, options) => {
    captured = { url: String(url), headers: options.headers, body: JSON.parse(options.body) };
    return jsonResponse({ choices: [{ message: { audio: { data: 'SUQz' } } }] });
  };
  try {
    const result = await synthesizeMiMo(
      '你好呀',
      settings({ provider: 'mimo', apiKey: 'mimo-key', mimoModel: VOICE_DESIGN_MODEL, mimoStyle: '低沉磁性男声，语速偏慢' }),
    );
    assert.equal(captured.body.model, VOICE_DESIGN_MODEL);
    // 该模型不支持 audio.voice，只传 format
    assert.deepEqual(captured.body.audio, { format: 'wav' });
    assert.deepEqual(captured.body.messages, [
      { role: 'user', content: '低沉磁性男声，语速偏慢' },
      { role: 'assistant', content: '你好呀' },
    ]);
    assert.deepEqual([...result.audio], [0x49, 0x44, 0x33]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('音色设计模型没填描述时使用默认描述兜底', async () => {
  assert.equal(mimoModel(settings({ provider: 'mimo', mimoModel: 'unknown-model' })), 'mimo-v2.5-tts');
  const config = ttsConfig(settings({ provider: 'mimo', mimoModel: VOICE_DESIGN_MODEL, mimoStyle: '' }));
  assert.equal(config.style, DEFAULT_VOICE_DESIGN);

  let captured = null;
  globalThis.fetch = async (url, options) => {
    captured = { body: JSON.parse(options.body) };
    return jsonResponse({ choices: [{ message: { audio: { data: 'SUQz' } } }] });
  };
  try {
    await synthesizeMiMo('你好', settings({ provider: 'mimo', apiKey: 'k', mimoModel: VOICE_DESIGN_MODEL, mimoStyle: '' }));
    assert.equal(captured.body.messages[0].role, 'user');
    assert.equal(captured.body.messages[0].content, DEFAULT_VOICE_DESIGN);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
