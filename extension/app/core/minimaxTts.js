/** MiniMax TTS：把 AI 回复合成成语音在主播电脑上播放。 */

export const TTS_VOICES = [
  { id: 'Chinese (Mandarin)_Cute_Spirit', label: '幼小可爱 · Cute Spirit（推荐）' },
  { id: 'Chinese (Mandarin)_Sweet_Lady', label: '甜美少女 · Sweet Lady' },
  { id: 'Chinese (Mandarin)_Warm_Girl', label: '温柔女孩 · Warm Girl' },
  { id: 'Chinese (Mandarin)_Soft_Girl', label: '软萌女孩 · Soft Girl' },
  { id: 'Chinese (Mandarin)_BashfulGirl', label: '害羞少女 · Bashful Girl' },
  { id: 'Chinese (Mandarin)_Crisp_Girl', label: '清脆少女 · Crisp Girl' },
  { id: 'Chinese (Mandarin)_Pure-hearted_Boy', label: '纯真少年 · Pure-hearted Boy' },
  { id: 'Cantonese_CuteGirl', label: '粤语可爱女孩 · Cute Girl' },
];

export const DEFAULT_TTS_VOICE = 'Chinese (Mandarin)_Cute_Spirit';

let currentRequest = null;
let currentAudio = null;
let currentUrl = '';
let currentSource = null;
let currentDone = null;
let audioContext = null;

/** 当前语音播放结束时调用（供上层的语音队列等待播放完成）。 */
function settleCurrentDone() {
  const done = currentDone;
  currentDone = null;
  if (done) done();
}

export function unlockTtsAudio() {
  try {
    if (typeof AudioContext === 'undefined' && typeof webkitAudioContext === 'undefined') return;
    if (!audioContext) {
      const Ctor = typeof AudioContext !== 'undefined' ? AudioContext : webkitAudioContext;
      audioContext = new Ctor();
    }
    if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
  } catch {
    /* 浏览器不支持 Web Audio 时使用 HTMLAudio 兜底 */
  }
}

function getAudioContext() {
  unlockTtsAudio();
  return audioContext;
}

function trimSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** TTS Key 留空时，自动复用 AI 备用服务（MiniMax）的 Key。 */
export function resolveTtsKey(settings) {
  const tts = (settings && settings.tts) || {};
  const ai = (settings && settings.ai) || {};
  const fallbackKey = (ai.fallback && ai.fallback.apiKey) || '';
  const primaryKey = String(ai.provider || '').startsWith('minimax') ? ai.apiKey : '';
  return String(tts.apiKey || fallbackKey || primaryKey || '').trim();
}

export function ttsConfig(settings) {
  const tts = (settings && settings.tts) || {};
  return {
    baseUrl: trimSlash(tts.baseUrl || 'https://api.minimax.cn/v1'),
    model: tts.model || 'speech-2.8-hd',
    voiceId: tts.voiceId || DEFAULT_TTS_VOICE,
    speed: clampNumber(tts.speed, 0.5, 2, 1),
    vol: clampNumber(tts.vol, 0.1, 10, 1),
    pitch: Math.round(clampNumber(tts.pitch, -12, 12, 2)),
    emotion: tts.emotion || 'happy',
  };
}

export function hexToBytes(hex) {
  const text = String(hex || '').trim();
  if (!text || text.length % 2 !== 0 || /[^0-9a-f]/i.test(text)) {
    throw new Error('TTS 返回的音频不是合法的 hex');
  }
  const bytes = new Uint8Array(text.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * 只做请求，不播放，方便测试 / 复用。
 * @returns {Promise<{audio:Uint8Array, mime:string, extra:object}>}
 */
export async function synthesizeMinimax(text, settings, options = {}) {
  const content = String(text || '').trim();
  if (!content) throw new Error('TTS 文本为空');
  const key = resolveTtsKey(settings);
  if (!key) throw new Error('未配置 MiniMax TTS API Key');

  const cfg = ttsConfig(settings);
  const controller = new AbortController();
  const outer = options.signal;
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener('abort', () => controller.abort(), { once: true });
  }
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 20000);

  try {
    const response = await fetch(`${cfg.baseUrl}/t2a_v2`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        text: content.slice(0, 1000),
        stream: false,
        language_boost: 'auto',
        output_format: 'hex',
        voice_setting: {
          voice_id: cfg.voiceId,
          speed: cfg.speed,
          vol: cfg.vol,
          pitch: cfg.pitch,
          emotion: cfg.emotion,
        },
        audio_setting: {
          sample_rate: 32000,
          bitrate: 128000,
          format: 'mp3',
          channel: 1,
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`MiniMax TTS HTTP ${response.status}${detail ? `：${detail.slice(0, 160)}` : ''}`);
    }

    const data = await response.json();
    const code = data && data.base_resp ? Number(data.base_resp.status_code) : 0;
    if (code !== 0) {
      throw new Error(`MiniMax TTS 错误 ${code}：${(data.base_resp && data.base_resp.status_msg) || '未知错误'}`);
    }
    const audio = hexToBytes(data && data.data ? data.data.audio : '');
    if (!audio.length) throw new Error('MiniMax TTS 返回空音频');
    return {
      audio,
      mime: 'audio/mpeg',
      extra: (data && data.extra_info) || {},
    };
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('MiniMax TTS 请求超时或被取消');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function stopMiniMaxTts() {
  if (currentRequest) {
    try {
      currentRequest.abort();
    } catch {
      /* ignore */
    }
    currentRequest = null;
  }
  if (currentSource) {
    try {
      currentSource.stop();
    } catch {
      /* ignore */
    }
    try {
      currentSource.disconnect();
    } catch {
      /* ignore */
    }
    currentSource = null;
  }
  if (currentAudio) {
    try {
      currentAudio.pause();
    } catch {
      /* ignore */
    }
    currentAudio = null;
  }
  if (currentUrl) {
    try {
      URL.revokeObjectURL(currentUrl);
    } catch {
      /* ignore */
    }
    currentUrl = '';
  }
  try {
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  } catch {
    /* ignore */
  }
  settleCurrentDone();
}

/** 按文字脚本选择浏览器兜底 TTS 的语言，支持中日韩英混说 */
export function detectSpeechLang(text) {
  const value = String(text || '');
  if (/[\u3040-\u30ff]/.test(value)) return 'ja-JP';
  if (/[\uac00-\ud7af]/.test(value)) return 'ko-KR';
  if (/[\u4e00-\u9fff]/.test(value)) return 'zh-CN';
  return 'en-US';
}

/** 浏览器自带 TTS，作为 MiniMax 失败/被自动播放策略拦截时的兜底。 */
export function speakBrowser(text, onEnded) {
  try {
    if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') {
      return false;
    }
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(String(text || '').slice(0, 120));
    utterance.lang = detectSpeechLang(text);
    utterance.rate = 1.05;
    utterance.pitch = 1.15;
    utterance.onend = () => {
      if (onEnded) onEnded();
    };
    utterance.onerror = () => {
      if (onEnded) onEnded();
    };
    speechSynthesis.speak(utterance);
    return true;
  } catch {
    return false;
  }
}

async function playWithWebAudio(audio, volume, onEnded) {
  const ctx = getAudioContext();
  if (!ctx) return false;
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  if (ctx.state !== 'running') {
    throw new Error('浏览器拦截了自动播放，请先在扩展页面点一下');
  }
  const data = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength);
  const buffer = await ctx.decodeAudioData(data);
  const source = ctx.createBufferSource();
  const gain = ctx.createGain();
  gain.gain.value = clampNumber(volume, 0, 1, 1);
  source.buffer = buffer;
  source.connect(gain);
  gain.connect(ctx.destination);
  source.addEventListener('ended', () => {
    if (currentSource === source) currentSource = null;
    try {
      source.disconnect();
      gain.disconnect();
    } catch {
      /* ignore */
    }
    if (onEnded) onEnded();
  });
  currentSource = source;
  source.start();
  return true;
}

async function playWithAudioElement(audio, mime, volume, onEnded) {
  if (typeof Audio === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
    throw new Error('当前环境不支持音频播放');
  }
  const blob = new Blob([audio], { type: mime });
  const url = URL.createObjectURL(blob);
  currentUrl = url;
  const player = new Audio(url);
  player.volume = clampNumber(volume, 0, 1, 1);
  currentAudio = player;
  player.addEventListener('ended', () => {
    if (currentAudio === player) {
      currentAudio = null;
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
      if (currentUrl === url) currentUrl = '';
    }
    if (onEnded) onEnded();
  });
  player.addEventListener('error', () => {
    if (onEnded) onEnded();
  });
  try {
    await player.play();
  } catch (error) {
    throw new Error(`音频被浏览器拦截（${error.message}）`);
  }
}

/**
 * 合成并播放。默认只使用 MiniMax 音频；只有显式 fallbackToBrowser 才回退机械音。
 * 返回的 done Promise 在播放结束或被停止时 resolve，供上层语音队列排序。
 * @returns {Promise<{ok:boolean, provider:'minimax'|'browser', mode?:string, error?:string, done?:Promise<void>}>}
 */
export async function speakMiniMax(text, settings, options = {}) {
  const content = String(text || '').trim();
  if (!content) return { ok: false, provider: 'minimax', error: '文本为空' };
  stopMiniMaxTts();

  let settled = false;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const finish = () => {
    if (settled) return;
    settled = true;
    resolveDone();
  };
  currentDone = finish;

  const controller = new AbortController();
  currentRequest = controller;
  try {
    const { audio, mime } = await synthesizeMinimax(content, settings, {
      signal: controller.signal,
      timeoutMs: options.timeoutMs,
    });
    if (controller.signal.aborted) throw new Error('TTS 已取消');

    let webError = null;
    try {
      if (await playWithWebAudio(audio, options.volume, finish)) {
        if (currentRequest === controller) currentRequest = null;
        return { ok: true, provider: 'minimax', mode: 'webaudio', done };
      }
    } catch (error) {
      webError = error;
    }

    try {
      await playWithAudioElement(audio, mime, options.volume, finish);
      if (currentRequest === controller) currentRequest = null;
      return { ok: true, provider: 'minimax', mode: 'audio', done };
    } catch (error) {
      const detail = webError ? `${webError.message}；${error.message}` : error.message;
      throw new Error(`MiniMax 音频播放失败：${detail}`);
    }
  } catch (error) {
    if (currentRequest === controller) currentRequest = null;
    if (options.fallbackToBrowser === true) {
      const ok = speakBrowser(content, finish);
      return { ok, provider: 'browser', error: error.message, done };
    }
    finish();
    throw error;
  }
}
