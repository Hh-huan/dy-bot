import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TTS_VOICE,
  detectSpeechLang,
  hexToBytes,
  resolveTtsKey,
  synthesizeMinimax,
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
