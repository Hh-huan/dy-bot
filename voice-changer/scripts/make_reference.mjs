/** 用 MiniMax TTS 生成桌宠音色参考音频，供 Seed-VC 零样本变声使用。 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = process.argv[2] || path.join(root, '..', 'private', 'ai-config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const settings = config.settings || {};
const tts = settings.tts || {};
const ai = settings.ai || {};

const key = String(tts.apiKey || (ai.fallback && ai.fallback.apiKey) || '').trim();
if (!key) throw new Error('未找到 MiniMax API Key');

const text = process.argv[3] || [
  '大家好呀，我是鲸鱼娘。',
  '今天也要一起开开心心地直播哦。',
  '不管你是第一次来，还是又回来陪我，我都记得你。',
  '想听我唱歌的话，就把想听的歌名发在弹幕里吧。',
  '我会一直在这里，等你来玩。',
].join('');

const baseUrl = String(tts.baseUrl || 'https://api.minimax.cn/v1').replace(/\/+$/, '');
const response = await fetch(`${baseUrl}/t2a_v2`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
  body: JSON.stringify({
    model: tts.model || 'speech-2.8-hd',
    text,
    stream: false,
    language_boost: 'auto',
    output_format: 'hex',
    voice_setting: {
      voice_id: tts.voiceId || 'Chinese (Mandarin)_Cute_Spirit',
      speed: Number(tts.speed) || 1,
      vol: Number(tts.vol) || 1,
      pitch: Number.isFinite(Number(tts.pitch)) ? Number(tts.pitch) : 2,
      emotion: tts.emotion || 'happy',
    },
    audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'wav', channel: 1 },
  }),
});

if (!response.ok) throw new Error(`MiniMax TTS HTTP ${response.status}: ${await response.text()}`);
const data = await response.json();
const code = data && data.base_resp ? Number(data.base_resp.status_code) : 0;
if (code !== 0) throw new Error(`MiniMax TTS ${code}: ${data.base_resp.status_msg}`);

const hex = String((data.data && data.data.audio) || '').trim();
if (!hex || hex.length % 2) throw new Error('TTS 返回音频为空或格式错误');
const bytes = Buffer.from(hex, 'hex');

const outDir = path.join(root, 'reference');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'pet-voice.wav');
fs.writeFileSync(outFile, bytes);
console.log(outFile);
