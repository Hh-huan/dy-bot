/** 设置与规则的持久化（chrome.storage.local；在 Node 测试里自动降级为内存）。 */
import { createDefaultRules, normalizeRules } from './rules.js';

export const STORAGE_KEYS = {
  settings: 'dy.settings.v1',
  rules: 'dy.rules.v1',
};

export const SETTINGS_DEFAULTS = {
  myRoomUrl: '',
  myNickname: '',
  myUserId: '',
  serviceEnabled: true,
  serviceSnapshot: null,
  replyEnabled: false,
  dryRun: true,
  autoResumeLive: true,
  replyCooldownMs: 3000,
  maxRepliesPerMin: 12,
  maxRepliesPerUserPerMin: 3,
  maxReplyChars: 60,
  maxQueue: 20,
  maxRulesPerEvent: 1,
  blockSelfEcho: true,
  blockedKeywords: [],
  blockedUsers: [],
  forwardEvents: false,
  webhookUrl: '',
  ai: {
    enabled: false,
    mode: 'always',
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKey: '',
    systemPrompt:
      '你是直播间主播的贴心助手，用口语化中文简短回复观众，30字以内。不要承诺价格、不引导私下交易、不提及自己是AI。',
    temperature: 0.8,
    maxTokens: 300,
    cooldownSec: 5,
    fallbackEnabled: true,
    fallback: {
      provider: 'minimax',
      baseUrl: 'https://api.minimax.cn/v1',
      model: 'MiniMax-M3',
      apiKey: '',
    },
  },
  petBridge: {
    enabled: false,
    url: 'http://127.0.0.1:8787',
  },
  dshPet: {
    enabled: false,
    baseUrl: 'http://127.0.0.1:64864',
    petId: 'main',
    surface: 'desktop',
    tts: false,
    chatBubble: true,
    chatBubbleIntervalSec: 20,
    menu: true,
    idleAnimEnabled: true,
    idleAnimMinSec: 20,
    idleAnimMaxSec: 40,
    actionCommands: true,
    likeThanks: true,
  },
  tts: {
    baseUrl: 'https://api.minimax.cn/v1',
    model: 'speech-2.8-hd',
    voiceId: 'Chinese (Mandarin)_Cute_Spirit',
    speed: 1,
    pitch: 2,
    emotion: 'happy',
    apiKey: '',
    fallbackBrowser: false,
  },
  warmup: {
    enabled: false,
    idleSec: 90,
    lowViewerThreshold: 10,
    lowViewerSec: 45,
    minIntervalSec: 150,
    maxPerHour: 12,
    sendToChat: true,
    bubble: true,
    speak: true,
    greetViewer: true,
    presets: [],
    presetChance: 30,
    prompt: '',
  },
  board: {
    enabled: false,
    bridgeUrl: 'http://127.0.0.1:8787',
    petSlot: 'center',
    avatarBubbles: 10,
  },
  songRequest: {
    enabled: false,
    bridgeUrl: 'http://127.0.0.1:8787',
    prefix: '点歌',
    provider: 'qq',
    cooldownSec: 0,
    minPlaySec: 60,
    queueCutSec: 90,
    dailyRecommend: true,
    horrorFilter: true,
    priorityGifts: '小心心',
    priorityPassSec: 600,
    reply: true,
  },
  ui: {
    feedLimit: 300,
    autoscroll: true,
  },
};

export function mergeSettings(input) {
  const saved = input && typeof input === 'object' ? input : {};
  const savedAi = saved.ai && typeof saved.ai === 'object' ? saved.ai : {};
  const ai = { ...SETTINGS_DEFAULTS.ai, ...savedAi };
  ai.fallback = { ...SETTINGS_DEFAULTS.ai.fallback, ...(savedAi.fallback || {}) };
  if (!Number.isFinite(Number(ai.maxTokens)) || Number(ai.maxTokens) < 120) ai.maxTokens = 300;

  return {
    ...SETTINGS_DEFAULTS,
    ...saved,
    myRoomUrl: String(saved.myRoomUrl || '').trim(),
    myNickname: String(saved.myNickname || '').trim(),
    myUserId: String(saved.myUserId || '').trim(),
    ai,
    // 参考桌宠桥接与事件转发已从设置页移除，统一停用，避免旧存档继续推送
    forwardEvents: false,
    petBridge: { ...SETTINGS_DEFAULTS.petBridge, ...(saved.petBridge || {}), enabled: false },
    dshPet: { ...SETTINGS_DEFAULTS.dshPet, ...(saved.dshPet || {}) },
    tts: { ...SETTINGS_DEFAULTS.tts, ...(saved.tts || {}) },
    warmup: { ...SETTINGS_DEFAULTS.warmup, ...(saved.warmup || {}) },
    board: {
      ...SETTINGS_DEFAULTS.board,
      ...(saved.board || {}),
      // 礼物头像飘屏数量：0~30，缺省或非法值回到默认 10
      avatarBubbles: Math.round(
        Math.min(
          30,
          Math.max(
            0,
            Number(
              saved.board && saved.board.avatarBubbles != null
                ? saved.board.avatarBubbles
                : SETTINGS_DEFAULTS.board.avatarBubbles,
            ) || 0,
          ),
        ),
      ),
    },
    songRequest: {
      ...SETTINGS_DEFAULTS.songRequest,
      ...(saved.songRequest || {}),
      // 只走 QQ 音乐：旧存档里的 netease / kugou / local 一律迁移回 qq
      provider: 'qq',
      cooldownSec: 0,
      // 旧设置页曾把插队礼物固定写成 *，这里统一迁移回内置的小心心
      priorityGifts:
        !saved.songRequest ||
        !saved.songRequest.priorityGifts ||
        saved.songRequest.priorityGifts === '*'
          ? '小心心'
          : String(saved.songRequest.priorityGifts),
    },
    ui: { ...SETTINGS_DEFAULTS.ui, ...(saved.ui || {}) },
    blockedKeywords: Array.isArray(saved.blockedKeywords)
      ? saved.blockedKeywords.map((item) => String(item)).filter(Boolean)
      : [],
    blockedUsers: Array.isArray(saved.blockedUsers)
      ? saved.blockedUsers.map((item) => String(item)).filter(Boolean)
      : [],
  };
}

function area() {
  return globalThis.chrome && chrome.storage && chrome.storage.local ? chrome.storage.local : null;
}

export async function loadSettings() {
  const storage = area();
  if (!storage) return mergeSettings({});
  const data = await storage.get(STORAGE_KEYS.settings);
  return mergeSettings(data ? data[STORAGE_KEYS.settings] : null);
}

export async function saveSettings(settings) {
  const storage = area();
  if (!storage) return;
  await storage.set({ [STORAGE_KEYS.settings]: settings });
}

export async function loadRules() {
  const storage = area();
  if (!storage) return createDefaultRules();
  const data = await storage.get(STORAGE_KEYS.rules);
  const saved = data ? data[STORAGE_KEYS.rules] : null;
  return Array.isArray(saved) ? normalizeRules(saved) : createDefaultRules();
}

export async function saveRules(rules) {
  const storage = area();
  if (!storage) return;
  await storage.set({ [STORAGE_KEYS.rules]: normalizeRules(rules) });
}

export async function clearStorage() {
  const storage = area();
  if (!storage) return;
  await storage.remove([STORAGE_KEYS.settings, STORAGE_KEYS.rules]);
}
