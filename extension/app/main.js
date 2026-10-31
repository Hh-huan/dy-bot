/** 侧边栏主逻辑：连接页面、解码弹幕、渲染、自动回复队列。 */
import { decodeFrame, roomIdFromUrl } from './core/douyin.js';
import {
  canSendNow,
  createDefaultRules,
  createState,
  isEligible,
  normalizeRules,
  noteSentText,
  planReplies,
  pruneState,
  reserveSend,
} from './core/rules.js';
import { classifySongIntent, classifySongSafety, generateAiReply, generateWarmupReply, isSensitiveCredentialQuery, judgeSongViolation, shouldRiffNickname, suggestPositiveSongs, summarizeLiveSession, summarizeViewerMemory } from './core/ai.js';
import { AUTO_SONG_INTERVAL_MS, AUTO_SONG_LIBRARY_KEY, AUTO_SONG_LIBRARY_MAX, AUTO_SONG_VOICE_TEXT, autoSongTrigger, buildAutoSongSender, buildPetSongReply, mergeAutoSongLibrary, pickAutoSongFromLibrary } from './core/autoSong.js';
import { DshPetClient, discoverDshPetBaseUrl } from './core/dshPet.js';
import { speakMiniMax, stopMiniMaxTts, unlockTtsAudio } from './core/minimaxTts.js';
import { PetBridge } from './core/petBridge.js';
import { addTokenRecord, normalizeTokenRecord, tokenDateKey } from './core/tokenUsage.js';
import { isTokenBackKeyword, matchPetCombo, parsePetActionCommand, petActionPool, petActionSpeech, petComboSpeech, petIdleSpeech, resolvePetAction, resolvePetComboSteps, TOKEN_BACK_REPLY } from './core/petActions.js';
import { AUDIENCE_FRESH_MS, isFollowAsk, isTokenWarmup, isViewerPresent, pickWarmupLine, pickWarmupPresetInfo, stripFollowAsk, warmupTrigger } from './core/warmup.js';
import { isCutSongQuestion, isPetSongHelp, isQueueJumpQuestion, parseSongQuery, parseCutSongIntent, parseVolumeIntent } from './core/songIntent.js';
import { SENSITIVE_SONG_MESSAGE, findSensitiveSongWord } from './core/sensitiveSong.js';
import { isGiftNoticeText } from './core/giftNotice.js';
import { isUnsafeNickname, safeNickname, sanitizeEventNickname } from './core/nicknameSafety.js';
import { formatNowText, isTimeQuestion } from './core/timeIntent.js';
import { formatBalanceReply, isBalanceQuestion } from './core/balanceIntent.js';
import { isBubbleGuideQuestion } from './core/bubbleIntent.js';
import { SEGMENT_LIMITS, isCasualChat, splitReplySegments } from './core/segmentReply.js';
import { matchBubbleTarget, matchSelfBubble, parseThrowIntent } from './core/throwIntent.js';
import { pickThrowLine } from './core/throwLines.js';
import {
  SPEECH_PRIORITY,
  insertByPriority,
  normalizeSpeechPriority,
  shouldInterrupt,
} from './core/speechPriority.js';
import { buildCrossViewerDigest, buildViewerDigest, buildViewerHistoryEntry, fallbackCrossReply, fallbackMemoryReply, fitMemoryReply, hasViewerMemory, isMemoryQuestion, recordViewerEvent, recordViewerSong, userFollowedAnchor } from './core/viewerMemory.js';
import { filterVisitLedger, formatApologyReply, formatChainBrokenReply, formatEvidenceReply, formatEvidenceTimeline, formatPendingReply, formatUnavailableReply, isVisitDispute, ledgerActionFromEvent } from './core/evidence.js';
import {
  loadRules,
  loadSettings,
  mergeSettings,
  saveRules,
  saveSettings,
  STORAGE_KEYS,
} from './core/store.js';
import {
  b64ToBytes,
  clamp,
  downloadText,
  fmtClock,
  fmtNumber,
  normalizeRoomUrl,
  parseRoomInput,
  roomKeyFromUrl,
  toCsv,
  todayStamp,
  uid,
} from './core/util.js';
import { $, $$, el, toast } from './ui/dom.js';
import { initRulesView } from './ui/rulesView.js';
import { initSettingsView } from './ui/settingsView.js';

const TYPE_LABELS = {
  chat: '评论',
  gift: '礼物',
  member: '进场',
  follow: '关注',
  like: '点赞',
  share: '分享',
  system: '系统',
};

const LIKE_FLUSH_MS = 4000;
const LIKE_THANKS_MS = 10000;
const TOKEN_STORAGE_KEY = 'dy.tokens.v1';
const VIEWER_HISTORY_KEY = 'dy.viewerHistory.v1';
const MAX_KNOWN_VIEWERS = 300;

const state = {
  settings: mergeSettings({}),
  rules: createDefaultRules(),
  ruleState: createState(),
  feedEvents: [],
  logs: [],
  recentReplies: [],
  stats: { online: 0, cumulative: 0, received: 0, replied: 0, likes: 0, tokens: 0, rice: 0 },
  page: { tabId: null, url: '', title: '', roomId: '', hasInput: false, lastSeen: 0 },
  lastFrameAt: 0,
  lastForeignAt: 0,
  foreignPageUrl: '',
  replyQueue: [],
  sending: false,
  aiBusy: false,
  lastAiErrorAt: 0,
  lastAiConfigErrorAt: 0,
  lastTtsErrorAt: 0,
  lastBalanceErrorAt: 0,
  pet: { enabled: false, connected: false, error: '', url: '' },
  dsh: { enabled: false, ok: false, error: '', pets: [], petId: '' },
  lastChatAt: Date.now(),
  lastWarmupAt: 0,
  warmupTimes: [],
  recentWarmups: [],
  viewers: new Map(),
  knownViewers: new Map(),
  crossViewers: { byKey: new Map(), byName: new Map() },
  // 抖音在线观众名单（id / 昵称 -> 最近一次出现在名单里的时间）
  audience: new Map(),
  audienceAt: 0,
  memoryPending: new Set(),
  disputePending: new Set(),
  lastWarmupViewer: '',
  lastWarmupCheck: 0,
  warmupBusy: false,
  priorityPasses: new Map(),
  priorityGiftAt: new Map(),
  replyMarks: new Map(),
  replyPending: new Map(),
  filter: 'all',
  seenIds: new Set(),
  eventTimes: [],
  likeAccum: { count: 0, total: 0, lastShown: 0, lastUser: null },
  aiMemory: [],
  memoryLoadedAt: 0,
  startedAt: Date.now(),
  // 桌宠自动点歌：大模型获取的正向祝福歌曲持久化在这个歌曲库
  autoSongLibrary: [],
  autoSongBusy: false,
  lastAutoSongAt: 0,
  lastAutoSongReceiver: '',
  // 点歌队列大模型审核锁：保证同一时间只有一轮审核在执行
  songAuditRunning: false,
};

let rulesView = null;
let settingsView = null;
let decodeChain = Promise.resolve();
let decodeErrors = 0;
let isLeader = false;
let petBridge = null;
let petStatusTimer = 0;
let lastPetStatusAt = 0;
let dshPet = null;
let dshMenuTimer = 0;
let dshChatTimer = 0;
let drainTimer = 0;
let idleAnimTimer = 0;
let lastIdleAnimName = '';
let lastDshActionAt = 0;
let lastDshActionName = '';
// 用户动作玩法动画的保护窗口：期间所有自动触发的动画让路（只留气泡+语音），玩法完整播完
let dshActionBusyUntil = 0;
const dshActionPlaying = () => Date.now() < dshActionBusyUntil;
// 组合动作（连招）的后续步骤计时器，新指令到来时清掉，避免旧连招继续串台
let dshComboTimers = [];
let lastDshBubbleAt = 0;
let lastDshMemberAt = 0;
let lastDshLikeAt = 0;
let tokenSaveTimer = 0;
let tokenDate = '';
let totalTokens = 0;
let lastDshAiAt = 0;
let lastDshChatAt = 0;
let dshErrorAt = 0;
// DSH 端口自动发现：连接失败时隔一段时间问一次本地桥接
let dshDiscoverAt = 0;
let dshDiscoverRunning = false;
const DSH_DISCOVER_INTERVAL_MS = 30000;

const LEADER_LOCK = 'dy-live-companion-reply-leader';

const ctx = {
  getSettings: () => state.settings,
  getRules: () => state.rules,
  applySettings,
  saveRules: saveRulesAndRender,
  log,
  toast,
  exportConfig,
  importConfig,
  resetAll,
  getPetState: () => ({ ...state.pet }),
  testPetBridge,
  openPetPage,
  getDshPetState: () => ({ ...state.dsh }),
  testDshPet,
  listDshPets,
  testTts,
  warmupNow,
  testBoard,
  clearGiftStats,
  testSong,
  getSongState,
};

/* ---------------- 单实例锁 ---------------- */

function setLeader(value) {
  const banner = $('#leaderBanner');
  if (banner) banner.hidden = value;
  if (isLeader === value) return;
  isLeader = value;
  if (value && state.settings.board && state.settings.board.enabled) {
    setTimeout(() => postBoard({ kind: 'board_refresh' }), 100);
  }
  if (!value) {
    failQueuedReplyMarks();
    state.replyQueue.length = 0;
    updateHint();
  }
}

/**
 * 侧边栏和独立标签页可能同时打开；用 Web Locks 保证只有一个实例真正发送，
 * 避免同一条弹幕被回复两次。
 */
function tryBecomeLeader() {
  if (typeof navigator === 'undefined' || !navigator.locks) {
    setLeader(true);
    return;
  }
  navigator.locks
    .request(LEADER_LOCK, { mode: 'exclusive', ifAvailable: true }, (lock) => {
      if (!lock) {
        setLeader(false);
        return undefined;
      }
      setLeader(true);
      return new Promise(() => {});
    })
    .catch(() => setLeader(true));
}

/* ---------------- 设置 / 配置 ---------------- */

async function applySettings(patch) {
  const previousRoom = roomKeyFromUrl(state.settings.myRoomUrl);
  const previousPet = JSON.stringify(state.settings.petBridge || {});
  const previousDshPet = dshConnectionKey(state.settings);
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'myRoomUrl')) {
    const normalized = parseRoomInput(patch.myRoomUrl);
    patch = { ...patch, myRoomUrl: normalized || String(patch.myRoomUrl || '').trim() };
  }
  state.settings = mergeSettings({ ...state.settings, ...patch });
  await saveSettings(state.settings);
  syncSettingsUI();

  const nextRoom = roomKeyFromUrl(state.settings.myRoomUrl);
  if (previousRoom !== nextRoom) {
    resetRoomRuntime();
    loadViewerHistory().catch(() => {});
  }
  if (previousPet !== JSON.stringify(state.settings.petBridge || {})) setupPetBridge();
  if (previousDshPet !== dshConnectionKey()) setupDshPet();
  schedulePetStatus();
}

function clearRuntimeCache() {
  state.ruleState = createState();
  state.feedEvents = [];
  state.logs = [];
  state.recentReplies = [];
  state.stats = { online: 0, cumulative: 0, received: 0, replied: 0, likes: 0, tokens: 0, rice: 0 };
  giftComboState.clear();
  state.replyQueue.length = 0;
  state.recentWarmups = [];
  state.warmupTimes = [];
  state.lastWarmupAt = 0;
  state.lastWarmupCheck = 0;
  state.viewers.clear();
  state.memoryPending.clear();
  speechQueue.length = 0;
  speechGeneration += 1;
  speechBusy = false;
  speechProtected = false;
  state.priorityPasses.clear();
  state.priorityGiftAt.clear();
  state.replyMarks.clear();
  state.replyPending.clear();
  state.seenIds.clear();
  state.eventTimes = [];
  state.likeAccum = { count: 0, total: 0, lastShown: 0, lastUser: null };
  state.tokenDate = tokenDateKey();
  totalTokens = 0;
  state.startedAt = Date.now();
  chrome.storage.local.remove(TOKEN_STORAGE_KEY).catch(() => {});
  renderFeed();
  updateStatsUI();
  const logList = $('#logList');
  if (logList) logList.textContent = '';
}
async function startBridgeService() {
  try {
    const response = await fetch('http://127.0.0.1:8786/start', {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    });
    const result = await response.json();
    return { ok: Boolean(result.ok && result.bridge), ...result };
  } catch (error) {
    return { ok: false, error: error.message || '服务控制器未运行' };
  }
}

async function stopBridgeService() {
  try {
    const response = await fetch('http://127.0.0.1:8786/stop', {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    });
    const result = await response.json();
    if (result.ok) return { ok: true };
  } catch {
    /* 控制器未运行时直接请求桥接关闭 */
  }
  try {
    await fetch(`${boardUrl()}/api/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message || '桥接未连接' };
  }
}

async function setServiceEnabled(enabled) {
  const settings = state.settings;
  if (enabled) {
    const start = await startBridgeService();
    const snapshot = settings.serviceSnapshot || {};
    await applySettings({
      serviceEnabled: true,
      replyEnabled: Boolean(snapshot.replyEnabled),
      songRequest: {
        ...settings.songRequest,
        enabled: Boolean(snapshot.songRequest),
      },
      board: { ...settings.board, enabled: Boolean(snapshot.board) },
      dshPet: { ...settings.dshPet, enabled: Boolean(snapshot.dshPet) },
      warmup: { ...settings.warmup, enabled: Boolean(snapshot.warmup) },
    });
    toast(
      start.ok
        ? '服务已开启，按上次状态恢复功能'
        : `功能已恢复，但桥接启动失败：${start.error || '请检查 tools\\start-bridge.ps1'}`,
      start.ok ? 'ok' : 'warn',
    );
    return;
  }

  const snapshot = {
    replyEnabled: Boolean(settings.replyEnabled),
    songRequest: Boolean(settings.songRequest.enabled),
    board: Boolean(settings.board.enabled),
    dshPet: Boolean(settings.dshPet.enabled),
    warmup: Boolean(settings.warmup.enabled),
  };
  try {
    await fetch(`${boardUrl()}/api/cache/clear`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* 桥接不在线时仍清扩展缓存 */
  }
  clearRuntimeCache();
  await applySettings({
    serviceEnabled: false,
    serviceSnapshot: snapshot,
    replyEnabled: false,
    songRequest: { ...settings.songRequest, enabled: false },
    board: { ...settings.board, enabled: false },
    dshPet: { ...settings.dshPet, enabled: false },
    warmup: { ...settings.warmup, enabled: false },
    petBridge: { ...settings.petBridge, enabled: false },
  });
  stopMiniMaxTts();
  const stopped = await stopBridgeService();
  toast(
    stopped.ok
      ? '服务已全部关闭（含桥接），功能状态已缓存'
      : `功能已关闭，但桥接未响应：${stopped.error || '请手动结束 node bridge/server.mjs'}`,
    stopped.ok ? 'warn' : 'error',
  );
}

function resetRoomRuntime() {
  state.replyQueue.length = 0;
  state.page = { tabId: null, url: '', title: '', roomId: '', hasInput: false, lastSeen: 0 };
  state.lastFrameAt = 0;
  state.lastForeignAt = 0;
  state.foreignPageUrl = '';
  clearReplyMarks();
  state.feedEvents = [];
  state.seenIds.clear();
  state.likeAccum = { count: 0, total: 0, lastShown: 0 };
  state.stats.online = 0;
  state.stats.cumulative = 0;
  state.lastChatAt = Date.now();
  state.lastWarmupAt = 0;
  state.warmupTimes = [];
  state.recentWarmups = [];
  renderFeed();
  updateStatsUI();
  detectPage();
}

function syncSettingsUI() {
  const serviceToggle = $('#serviceToggle');
  if (serviceToggle) serviceToggle.checked = state.settings.serviceEnabled !== false;
  const replyToggle = $('#replyToggle');
  if (replyToggle) {
    replyToggle.checked = Boolean(state.settings.replyEnabled);
    replyToggle.disabled = state.settings.serviceEnabled === false;
  }
  const autoscroll = $('#autoscrollToggle');
  if (autoscroll) autoscroll.checked = Boolean(state.settings.ui.autoscroll);
  if (!state.settings.replyEnabled) {
    failQueuedReplyMarks();
    state.replyQueue.length = 0;
  }
  updateHostSetup();
  updateHint();
  if (!state.settings.dshPet.tts) stopMiniMaxTts();
  schedulePetStatus();
  scheduleDshMenu();
}

function myRoomKey() {
  return roomKeyFromUrl(state.settings.myRoomUrl);
}

/* ---------------- 桌宠联动 ---------------- */

function setupPetBridge() {
  const cfg = state.settings.petBridge || {};
  const url = PetBridge.normalize(cfg.url);
  state.pet = { enabled: Boolean(cfg.enabled), connected: false, error: '', url };

  if (petBridge) {
    petBridge.disconnect();
    petBridge = null;
  }

  if (!cfg.enabled) {
    refreshPetUI();
    return;
  }

  petBridge = new PetBridge({
    url,
    onCommand: handlePetCommand,
    onStateChange: (info) => {
      state.pet = { ...state.pet, ...info };
      refreshPetUI();
      if (info.connected) postPetStatus(true);
    },
  });
  petBridge.connect();
  refreshPetUI();
}

function refreshPetUI() {
  try {
    window.dispatchEvent(new CustomEvent('dy-pet-state', { detail: { ...state.pet } }));
  } catch {
    /* ignore */
  }
}

async function testPetBridge(urlOverride) {
  const url = PetBridge.normalize(urlOverride || (state.settings.petBridge || {}).url);
  if (!url) return { ok: false, error: '未配置桥接地址' };
  const probe = new PetBridge({ url });
  return probe.health();
}

function openPetPage(urlOverride) {
  const url = PetBridge.normalize(urlOverride || (state.settings.petBridge || {}).url);
  if (!url) {
    toast('请先填写桥接地址', 'warn');
    return;
  }
  chrome.tabs.create({ url: `${url}/pet` });
}

function roomInfo() {
  return {
    title: state.page.title || '',
    url: state.settings.myRoomUrl || '',
    roomId: state.page.roomId || '',
    online: state.stats.online || 0,
  };
}

function boardUrl() {
  return String(state.settings.board.bridgeUrl || 'http://127.0.0.1:8787').replace(/\/+$/, '');
}

async function postBoard(payload) {
  try {
    await fetch(`${boardUrl()}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ at: Date.now(), ...payload }),
    });
  } catch {
    /* 背景板/桥接未启动时忽略 */
  }
}

function postPet(payload) {
  if (state.settings.serviceEnabled === false) return;
  if (!isLeader) return;
  const body = { at: Date.now(), ...payload };
  if (petBridge && state.settings.petBridge.enabled) {
    Promise.resolve(petBridge.post(body)).catch(() => {});
  }
  // 背景板和桌宠桥接是两条独立的展示链路：开了桌宠也不能饿死背景板
  if (state.settings.board.enabled) postBoard(body);
}

/* ---------------- 观众访问留证（争议处理） ---------------- */

function postLedger(payload) {
  return fetch(`${boardUrl()}/api/ledger/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomId: state.page.roomId || '', ...payload }),
    signal: AbortSignal.timeout(3000),
  })
    .then((response) => response.ok)
    .catch(() => false);
}

/** 每条进房 / 发言 / 送礼 / 点赞 / 关注都写入 append-only 留证台账。 */
function recordVisitLedger(event) {
  if (!isLeader || state.settings.serviceEnabled === false) return;
  // 争议弹幕本身不算访问行为：否则「我没来过」会被这句话自己当成来过的证据
  if (event && event.type === 'chat' && isVisitDispute(event.content)) return;
  const entry = ledgerActionFromEvent(event);
  if (!entry) return;
  const user = (event && event.user) || {};
  const id = String(user.id || '').trim();
  const name = String(user.nickname || '').trim();
  if (!id && !name) return;
  postLedger({ key: id || name, id, name, action: entry.action, detail: entry.detail, at: Date.now() });
}

/** 记录争议核查 / 误判 / 记忆声明等审计动作，不计入访问行为统计。 */
function recordLedgerAudit(user, action, detail) {
  if (!isLeader) return Promise.resolve(false);
  const id = String((user && user.id) || '').trim();
  const name = String((user && user.nickname) || '').trim();
  if (!id && !name) return Promise.resolve(false);
  return postLedger({ key: id || name, id, name, action, detail, at: Date.now() });
}

/** 调取留证台账：优先按抖音用户 id 精确查询，没有 id 时才退回昵称。 */
async function fetchLedger(user) {
  if (state.settings.serviceEnabled === false) return null;
  const id = String((user && user.id) || '').trim();
  const nickname = String((user && user.nickname) || '').trim();
  const needle = id || nickname;
  if (!needle) return { ok: true, total: 0, entries: [] };
  try {
    const response = await fetch(`${boardUrl()}/api/ledger?user=${encodeURIComponent(needle)}&limit=200`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

async function clearGiftStats() {
  try {
    const response = await fetch(`${boardUrl()}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'gift_reset', at: Date.now() }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message || '桥接未连接' };
  }
}

/* ---------------- 大肥鱼跨直播记忆 ---------------- */

const LIVE_SESSION_KEY = 'dy.liveSession.v1';
const LIVE_SESSION_TTL = 12 * 60 * 60 * 1000;
// 开播时间按 5 分钟取整：多个面板页面同时开播时也会算出同一个场次标识
const LIVE_SESSION_STEP = 5 * 60 * 1000;

/**
 * 本场直播的标识：房间号 + 开播时间戳。
 * 存在 chrome.storage.local 里，多个面板页面共享同一份，避免各存一条。
 */
async function liveSessionKey({ create = false } = {}) {
  const room = myRoomKey();
  if (!room) return '';
  const now = Date.now();
  let saved = null;
  try {
    const data = await chrome.storage.local.get(LIVE_SESSION_KEY);
    saved = data && data[LIVE_SESSION_KEY];
  } catch {
    saved = null;
  }
  if (saved && saved.room === room && now - Number(saved.startedAt) < LIVE_SESSION_TTL) {
    return `${room}:${saved.startedAt}`;
  }
  if (!create) return '';
  const startedAt = Math.floor(now / LIVE_SESSION_STEP) * LIVE_SESSION_STEP;
  try {
    await chrome.storage.local.set({ [LIVE_SESSION_KEY]: { room, startedAt } });
  } catch {
    /* 存储不可用时仍用本地标识，至少不会同页面重复 */
  }
  return `${room}:${startedAt}`;
}

async function clearLiveSession() {
  try {
    await chrome.storage.local.remove(LIVE_SESSION_KEY);
  } catch {
    /* 忽略 */
  }
}

// 开播时从桥接拉取历史记忆（每 4 小时至多一次，同一场直播不重复拉）
async function loadAiMemory() {
  if (state.settings.serviceEnabled === false) return;
  const now = Date.now();
  if (now - state.memoryLoadedAt < 4 * 60 * 60 * 1000) return;
  state.memoryLoadedAt = now;
  try {
    const response = await fetch(`${boardUrl()}/api/memory`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return;
    const data = await response.json();
    if (Array.isArray(data.memories)) {
      state.aiMemory = data.memories;
      buildCrossViewerIndex(data.memories);
      log('info', `已载入大肥鱼记忆 ${data.memories.length} 条，识别出 ${state.crossViewers.byKey.size} 位重要观众`);
    }
  } catch {
    /* 桥接未连接时静默 */
  }
}

/** 把跨直播记忆里的观众信息建成索引，最近的记忆优先。 */
function buildCrossViewerIndex(memories) {
  const byKey = new Map();
  const byName = new Map();
  for (const memory of [...(memories || [])].reverse()) {
    for (const item of (memory && memory.viewers) || []) {
      if (!item || (!item.key && !item.name)) continue;
      const key = String(item.key || item.name);
      if (byKey.has(key)) continue;
      const viewer = { ...item, key, at: Number(memory.at) || 0 };
      byKey.set(key, viewer);
      const name = String(item.name || '').trim();
      if (name && !byName.has(name)) byName.set(name, viewer);
    }
  }
  state.crossViewers = { byKey, byName };
}

/** 单场记忆没命中时，用跨直播记忆识别这位观众。 */
function findCrossViewer(user) {
  if (!user) return null;
  const id = String(user.id || '');
  if (id && state.crossViewers.byKey.has(id)) return state.crossViewers.byKey.get(id);
  const name = String(user.nickname || '').trim();
  if (name && state.crossViewers.byName.has(name)) return state.crossViewers.byName.get(name);
  return null;
}

/** 这位观众是否已经关注过：先查本场，再查本地观众历史和跨直播记忆。 */
function viewerHasFollowed(event) {
  const user = event && event.user;
  if (!user) return false;
  const key = String(user.id || user.nickname || '');
  const record = state.viewers.get(key);
  if (record && Number(record.followedAt)) return true;
  const known = state.knownViewers.get(key) || state.knownViewers.get(String(user.nickname || ''));
  if (known && Number(known.followedAt)) return true;
  const cross = findCrossViewer(user);
  return Boolean(cross && Array.isArray(cross.actions) && cross.actions.includes('关注'));
}

/** 暖场用：单场观众对象是否已关注（本场 → 本地历史 → 跨直播记忆）。 */
function viewerRecordHasFollowed(viewer) {
  if (!viewer) return false;
  if (Number(viewer.followedAt)) return true;
  const id = String(viewer.id || '');
  const name = String(viewer.name || '');
  for (const key of [String(viewer.key || ''), id, name].filter(Boolean)) {
    const record = state.viewers.get(key);
    if (record && Number(record.followedAt)) return true;
    const known = state.knownViewers.get(key);
    if (known && Number(known.followedAt)) return true;
  }
  const cross = findCrossViewer({ id, nickname: name });
  return Boolean(cross && Array.isArray(cross.actions) && cross.actions.includes('关注'));
}

let savingMemory = false;
// 下播 / 定期存档：把本场数据交给 AI 总结成一句话，写入 bridge/memory.json
// final=true 表示本场结束，存档后清掉场次标识，下一场重新计
async function saveLiveMemory({ final = false } = {}) {
  const sessionKey = await liveSessionKey({ create: true });
  let locked = false;
  try {
    if (!sessionKey || state.settings.serviceEnabled === false || savingMemory) return;
    const ai = state.settings.ai;
    if (!ai || !ai.enabled || !ai.apiKey) return;
    savingMemory = true;
    locked = true;
    const recent = state.feedEvents
      .filter((item) => item.type === 'chat' && item.content)
      .slice(-6)
      .map((item) => `${safeNickname(item.user && item.user.nickname, '观众')}：${item.content}`);
    const digest = [
      `弹幕 ${state.stats.received} 条`,
      `回复 ${state.stats.replied} 条`,
      `白饭 +${state.stats.rice}`,
      `点赞 ${state.stats.likes}`,
      recent.length ? `最近弹幕：${recent.join('；')}` : '',
    ]
      .filter(Boolean)
      .join('，');
    const result = await summarizeLiveSession({ ai, digest });
    addTokenUsage(result.tokens);
    // 记下本场发言 / 送礼 / 点歌过的重要观众，方便以后直播认出他们
    const viewers = [...state.viewers.values()]
      .filter((record) => hasViewerMemory(record))
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
      .slice(0, 60)
      .map((record) => buildViewerHistoryEntry(record))
      .filter(Boolean);
    await fetch(`${boardUrl()}/api/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: result.text, kind: 'live', viewers, sessionKey }),
      signal: AbortSignal.timeout(5000),
    });
    log('info', `本场直播记忆已存档：${result.text}（重要观众 ${viewers.length} 位）`);
  } catch (error) {
    log('warn', `直播记忆存档失败：${(error && error.message) || error}`);
  } finally {
    if (locked) savingMemory = false;
    if (final) await clearLiveSession();
  }
}
async function testBoard() {
  try {
    const response = await fetch(`${boardUrl()}/status`, {
      signal: AbortSignal.timeout(5000),
    });
    const data = await response.json();
    return { ok: response.ok && data.ok, data };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/** 读取 DeepSeek 账户余额；没有可用配置时返回 null。 */
async function fetchApiBalance() {
  const ai = state.settings.ai;
  if (!ai || !ai.apiKey || !String(ai.baseUrl || '').includes('deepseek')) return null;
  const response = await fetch('https://api.deepseek.com/user/balance', {
    headers: { Authorization: `Bearer ${ai.apiKey}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  const info = (data.balance_infos || [])[0];
  if (!info) throw new Error('接口没有返回余额');
  const symbol = info.currency === 'CNY' ? '¥' : info.currency === 'USD' ? '$' : '';
  const amount = Number(info.total_balance || 0).toFixed(2);
  const unit = info.currency === 'CNY' ? '元' : info.currency === 'USD' ? '美元' : '';
  return {
    display: `${symbol}${amount}`,
    spoken: `${amount}${unit}`,
    currency: info.currency || '',
    available: Boolean(data.is_available),
  };
}

async function refreshApiBalance() {
  try {
    const info = await fetchApiBalance();
    if (!info) return;
    postPet({
      kind: 'balance',
      data: { text: info.display, currency: info.currency, available: info.available },
    });
  } catch (error) {
    if (Date.now() - state.lastBalanceErrorAt > 60000) {
      state.lastBalanceErrorAt = Date.now();
      log('warn', `API 额度查询失败：${error.message}`);
    }
  }
}

async function handleBalanceQuestion(event) {
  const nickname = (event.user && event.user.nickname) || '观众';
  let balance = null;
  try {
    balance = await fetchApiBalance();
  } catch (error) {
    if (Date.now() - state.lastBalanceErrorAt > 60000) {
      state.lastBalanceErrorAt = Date.now();
      log('warn', `余额查询失败：${error.message}`);
    }
  }
  const text = balance ? formatBalanceReply(balance.spoken) : '当前token余额暂时查不到，稍后再问我吧';
  enqueueReply(
    {
      ruleId: 'viewer-balance',
      ruleName: '余额查询',
      text,
      userId: songUserKey(event.user),
      eventId: event.id,
      scope: 'chat',
      ts: Date.now(),
    },
    state.page.tabId,
    { force: true },
  );
  drainQueue();
  if (state.settings.dshPet && state.settings.dshPet.enabled) {
    dshBroadcast(text, { force: true, duration: 6000 });
  }
  speakDsh(text, { priority: SPEECH_PRIORITY.chat });
  toast(text, balance ? 'ok' : 'warn');
  log(balance ? 'info' : 'warn', `余额查询：${nickname} → ${text}`);
}

// 背景板 / 桌宠弹幕区展示的昵称也脱敏，避免不良昵称出现在直播画面上
function postPetEvent(event) {
  postPet({ kind: 'event', room: roomInfo(), event: sanitizeEventNickname(event) });
}

function ensureTokenDay() {
  const today = tokenDateKey();
  if (tokenDate === today) return false;
  tokenDate = today;
  state.stats.tokens = 0;
  return true;
}

function saveTokenUsage() {
  if (tokenSaveTimer) clearTimeout(tokenSaveTimer);
  tokenSaveTimer = setTimeout(() => {
    tokenSaveTimer = 0;
    chrome.storage.local
      .set({
        [TOKEN_STORAGE_KEY]: {
          date: tokenDate || tokenDateKey(),
          tokens: state.stats.tokens || 0,
          total: totalTokens || 0,
        },
      })
      .catch(() => {});
  }, 500);
}

function addTokenUsage(value) {
  const tokens = Math.max(0, Math.round(Number(value) || 0));
  if (!tokens) return;
  ensureTokenDay();
  const record = addTokenRecord(
    { date: tokenDate, tokens: state.stats.tokens, total: totalTokens },
    tokens,
    tokenDate,
  );
  tokenDate = record.date;
  state.stats.tokens = record.tokens;
  totalTokens = record.total;
  updateStatsUI();
  schedulePetStatus();
  saveTokenUsage();
}

async function loadTokenUsage() {
  try {
    const data = await chrome.storage.local.get(TOKEN_STORAGE_KEY);
    const record = normalizeTokenRecord(data && data[TOKEN_STORAGE_KEY]);
    tokenDate = record.date;
    state.stats.tokens = record.tokens;
    totalTokens = record.total;
    updateStatsUI();
  } catch {
    tokenDate = tokenDateKey();
  }
}

function petStatusPayload() {
  ensureTokenDay();
  return {
    enabled: Boolean(state.settings.petBridge.enabled),
    bridgeConnected: state.pet.connected,
    leader: isLeader,
    roomBound: Boolean(myRoomKey()),
    roomTitle: state.page.title || '',
    autoReply: Boolean(state.settings.replyEnabled),
    dryRun: Boolean(state.settings.dryRun),
    aiEnabled: Boolean(state.settings.ai.enabled),
    aiMode: state.settings.ai.mode,
    online: state.stats.online || 0,
    cumulative: state.stats.cumulative || 0,
    received: state.stats.received || 0,
    replied: state.stats.replied || 0,
    likes: state.stats.likes || 0,
    tokens: state.stats.tokens || 0,
    tokenDate: tokenDate || tokenDateKey(),
    // 背景板送礼头像飘屏数量（0 表示关闭）
    avatarBubbles: Math.round(
      Math.min(30, Math.max(0, Number(state.settings.board && state.settings.board.avatarBubbles) || 0)),
    ),
  };
}

function postPetStatus(force = false) {
  if (!force && Date.now() - lastPetStatusAt < 5000) return;
  lastPetStatusAt = Date.now();
  postPet({ kind: 'status', room: roomInfo(), data: petStatusPayload() });
}

function schedulePetStatus() {
  if (petStatusTimer) return;
  petStatusTimer = setTimeout(() => {
    petStatusTimer = 0;
    postPetStatus(true);
  }, 400);
}

async function handlePetCommand(command) {
  if (!isLeader) return;
  switch (command.action) {
    case 'reply':
      await sendPetReply(command.text);
      break;
    case 'toggle_auto_reply':
      await applySettings({
        replyEnabled:
          typeof command.enabled === 'boolean' ? command.enabled : !state.settings.replyEnabled,
      });
      postPetStatus(true);
      break;
    case 'toggle_dry_run':
      await applySettings({
        dryRun: typeof command.enabled === 'boolean' ? command.enabled : !state.settings.dryRun,
      });
      postPetStatus(true);
      break;
    case 'set_ai':
      await applySettings({
        ai: { ...state.settings.ai, enabled: Boolean(command.enabled) },
      });
      postPetStatus(true);
      break;
    case 'status':
    case 'ping':
      postPetStatus(true);
      break;
    default:
      log('warn', `未知的桌宠指令：${command.action}`);
  }
}

async function sendPetReply(rawText) {
  const text = String(rawText || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!text) {
    postPet({ kind: 'notice', level: 'warn', text: '桌宠想发送空内容，已忽略' });
    return;
  }
  if (!myRoomKey()) {
    toast('请先绑定你的直播间，桌宠才能代发弹幕', 'warn');
    postPet({ kind: 'notice', level: 'warn', text: '请先在扩展里绑定我的直播间' });
    return;
  }
  const limit = Math.max(1, Number(state.settings.maxQueue) || 20);
  if (state.replyQueue.length >= limit) {
    log('warn', '回复队列已满，桌宠指令被丢弃');
    postPet({ kind: 'notice', level: 'warn', text: '回复队列已满，请稍后再试' });
    return;
  }
  enqueueReply(
    {
      ruleId: 'pet',
      ruleName: '桌宠',
      text,
      userId: 'pet',
      eventId: `pet-${Date.now()}`,
      scope: 'chat',
      ts: Date.now(),
    },
    state.page.tabId,
    { force: true },
  );
  drainQueue();
}

function isMyRoomPage(url) {
  const key = myRoomKey();
  return Boolean(key) && roomKeyFromUrl(url) === key;
}

function ownNickname() {
  const configured = String(state.settings.myNickname || '').trim();
  if (configured) return configured;
  // 没填「我的昵称」时，从直播间标题「XXX的抖音直播间」兜底识别主播
  const match = String(state.page.title || '').match(/^(.{1,40}?)的抖音直播间/);
  return match ? match[1].trim() : '';
}

function isOwnEvent(event) {
  const user = event && event.user;
  if (!user) return false;
  const ownId = String(state.settings.myUserId || '').trim();
  if (ownId && String(user.id || '') === ownId) return true;
  const ownName = ownNickname().toLowerCase();
  if (!ownName) return false;
  return String(user.nickname || '').trim().toLowerCase() === ownName;
}

function updateHostSetup() {
  const setup = $('#hostSetup');
  if (!setup) return;
  const bound = Boolean(myRoomKey());
  setup.hidden = bound;

  const input = $('#myRoomInput');
  if (input && !bound && !input.value) input.value = state.settings.myRoomUrl || '';

  const manual = $('#manualInput');
  if (manual) manual.placeholder = '手动回复一条弹幕…';

  if (bound) {
    const hint = $('#hostSetupHint');
    if (hint) hint.textContent = '';
  }
}

async function bindMyRoom(rawUrl) {
  const normalized = parseRoomInput(rawUrl);
  const hint = $('#hostSetupHint');
  if (!normalized) {
    if (hint) hint.textContent = '链接无效：请粘贴 https://live.douyin.com/房间号，或直接输入房间号。';
    return false;
  }
  await applySettings({ myRoomUrl: normalized });
  const input = $('#myRoomInput');
  if (input) input.value = normalized;
  if (hint) hint.textContent = '';
  toast('已绑定我的直播间', 'ok');
  return true;
}

async function bindCurrentRoom() {
  const hint = $('#hostSetupHint');
  try {
    const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    let url = active[0] ? active[0].url : '';
    if (!roomKeyFromUrl(url)) {
      const liveTabs = await chrome.tabs.query({ url: 'https://live.douyin.com/*' });
      if (liveTabs.length === 1) url = liveTabs[0].url;
    }
    if (!roomKeyFromUrl(url)) {
      if (hint) hint.textContent = '当前标签页不是抖音直播间，请先打开你自己的直播间。';
      toast('当前标签页不是抖音直播间', 'error');
      return;
    }
    await bindMyRoom(url);
  } catch {
    if (hint) hint.textContent = '读取当前标签页失败，请手动粘贴直播间链接。';
  }
}

async function openMyRoom() {
  const key = myRoomKey();
  if (!key) {
    toast('请先绑定你的直播间', 'warn');
    const input = $('#myRoomInput');
    if (input) input.focus();
    return;
  }
  const url = normalizeRoomUrl(state.settings.myRoomUrl);
  try {
    const tabs = await chrome.tabs.query({ url: 'https://live.douyin.com/*' });
    const existing = tabs.find((tab) => roomKeyFromUrl(tab.url) === key);
    if (existing) {
      await chrome.tabs.update(existing.id, { active: true });
    } else {
      await chrome.tabs.create({ url });
    }
  } catch {
    chrome.tabs.create({ url });
  }
}

async function saveRulesAndRender(next) {
  state.rules = normalizeRules(next);
  await saveRules(state.rules);
  if (rulesView) rulesView.render();
}

function exportConfig() {
  const settings = { ...state.settings, ai: { ...state.settings.ai, apiKey: '' } };
  const payload = {
    app: 'dy-live-companion',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings,
    rules: state.rules,
  };
  downloadText(`dy-config-${todayStamp()}.json`, JSON.stringify(payload, null, 2));
  log('info', '配置已导出（不含 API Key）');
  toast('配置已导出（不含 API Key）', 'ok');
}

async function importConfig(data) {
  if (!data || typeof data !== 'object') throw new Error('文件格式不正确');
  if (!data.settings && !Array.isArray(data.rules)) throw new Error('文件里没有 settings 或 rules');
  const previousRoom = roomKeyFromUrl(state.settings.myRoomUrl);
  const currentKey = state.settings.ai.apiKey;
  if (data.settings) {
    state.settings = mergeSettings(data.settings);
    if (!state.settings.ai.apiKey && currentKey) state.settings.ai.apiKey = currentKey;
  }
  if (Array.isArray(data.rules)) state.rules = normalizeRules(data.rules);
  await Promise.all([saveSettings(state.settings), saveRules(state.rules)]);
  syncSettingsUI();
  if (previousRoom !== roomKeyFromUrl(state.settings.myRoomUrl)) resetRoomRuntime();
  setupPetBridge();
  setupDshPet();
  if (settingsView) settingsView.render();
  if (rulesView) rulesView.render();
  log('info', '配置已导入');
}

async function resetAll() {
  state.settings = mergeSettings({});
  state.rules = createDefaultRules();
  await Promise.all([saveSettings(state.settings), saveRules(state.rules)]);
  syncSettingsUI();
  resetRoomRuntime();
  setupPetBridge();
  setupDshPet();
  if (settingsView) settingsView.render();
  if (rulesView) rulesView.render();
}

/* ---------------- 页面连接 ---------------- */

function onRuntimeMessage(message, sender) {
  if (!message || typeof message.type !== 'string') return;
  if (message.type === 'dy-frame') onFrame(message, sender);
  else if (message.type === 'dy-page') onPageInfo(message, sender);
}

function onFrame(message, sender) {
  if (!myRoomKey()) return;
  const pageUrl = message.pageUrl || '';
  if (!isMyRoomPage(pageUrl)) {
    state.lastForeignAt = Date.now();
    state.foreignPageUrl = pageUrl;
    updateConn();
    return;
  }
  state.lastForeignAt = 0;

  const tabId = sender && sender.tab ? sender.tab.id : state.page.tabId;
  const now = Date.now();
  if (tabId) state.page.tabId = tabId;
  state.page.url = pageUrl || state.page.url;
  state.page.title = message.title || state.page.title;
  state.page.roomId = roomIdFromUrl(message.socketUrl) || state.page.roomId;
  state.page.lastSeen = now;
  state.lastFrameAt = now;
  updateHint();

  let bytes;
  try {
    bytes = b64ToBytes(message.b64 || '');
  } catch {
    return;
  }

  decodeChain = decodeChain
    .then(async () => {
      const result = await decodeFrame(bytes);
      for (const event of result.events) handleEvent(event);
    })
    .catch((error) => {
      decodeErrors += 1;
      if (decodeErrors < 5 || decodeErrors % 25 === 0) {
        log('error', `弹幕解码失败：${error && error.message ? error.message : error}`);
      }
    });
}

function onPageInfo(message, sender) {
  if (!myRoomKey() || !isMyRoomPage(message.pageUrl || '')) return;
  const tabId = sender && sender.tab ? sender.tab.id : null;
  if (tabId) state.page.tabId = tabId;
  state.page.url = message.pageUrl || state.page.url;
  state.page.title = message.title || state.page.title;
  state.page.hasInput = Boolean(message.hasInput);
  state.page.lastSeen = Date.now();
  updateConn();
}

function friendlyTabError(error) {
  const message = String((error && error.message) || error || '');
  if (/Receiving end does not exist|Could not establish connection|message port closed/i.test(message)) {
    return '页面脚本未就绪，请刷新直播间页面后重试';
  }
  return message || '页面通信失败';
}

function sendToTab(tabId, message, timeoutMs = 6500) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('页面响应超时，请刷新直播间页面'));
    }, timeoutMs);

    chrome.tabs.sendMessage(tabId, message).then(
      (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(response);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(friendlyTabError(error)));
      },
    );
  });
}

async function detectPage() {
  try {
    const key = myRoomKey();
    if (!key) {
      state.page = { tabId: null, url: '', title: '', roomId: '', hasInput: false, lastSeen: 0 };
      state.lastFrameAt = 0;
      updateConn();
      updateHint();
      return;
    }

    const tabs = await chrome.tabs.query({ url: 'https://live.douyin.com/*' });
    const target = tabs.find((tab) => roomKeyFromUrl(tab.url) === key) || null;

    if (!target) {
      state.page = { tabId: null, url: '', title: '', roomId: '', hasInput: false, lastSeen: 0 };
      state.lastFrameAt = 0;
      updateConn();
      updateHint();
      return;
    }

    state.page.tabId = target.id;
    state.page.url = target.url || '';
    state.page.title = target.title || '';
    try {
      const pong = await sendToTab(target.id, { type: 'dy-ping' }, 1500);
      if (pong && pong.ok) {
        state.page.title = pong.title || state.page.title;
        state.page.hasInput = Boolean(pong.hasInput);
      }
    } catch {
      /* 页面还没注入或正在加载 */
    }
    updateConn();
    updateHint();
  } catch {
    /* ignore */
  }
}

async function resolveTabId() {
  const key = myRoomKey();
  if (key) {
    if (state.page.tabId) {
      try {
        const tab = await chrome.tabs.get(state.page.tabId);
        if (tab && roomKeyFromUrl(tab.url) === key) return tab.id;
      } catch {
        /* tab closed */
      }
    }
    try {
      const tabs = await chrome.tabs.query({ url: 'https://live.douyin.com/*' });
      const match = tabs.find((tab) => roomKeyFromUrl(tab.url) === key);
      return match ? match.id : null;
    } catch {
      return null;
    }
  }

  if (state.page.tabId) {
    try {
      const tab = await chrome.tabs.get(state.page.tabId);
      if (tab && /^https:\/\/live\.douyin\.com\//.test(tab.url || '')) return tab.id;
    } catch {
      /* tab closed */
    }
  }
  try {
    const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active[0] && /^https:\/\/live\.douyin\.com\//.test(active[0].url || '')) return active[0].id;
    const tabs = await chrome.tabs.query({ url: 'https://live.douyin.com/*' });
    return tabs[0] ? tabs[0].id : null;
  } catch {
    return null;
  }
}

/* ---------------- 事件处理 ---------------- */

// 礼物连击帧的 count 是累计值（1→3→4→5…）：统计只补差额，
// 否则一次连击会被加成十几份白饭，AI 报出的累计白饭也会跟着虚高。
const GIFT_COMBO_TTL_MS = 5 * 60 * 1000;
const giftComboState = new Map();

function giftComboDelta(event, now) {
  const gift = event.gift || {};
  const user = event.user || {};
  const total = Math.max(1, Number(gift.count ?? event.count) || 1);
  const key = `${String(user.id || user.nickname || 'anon')}|${String(gift.id || gift.name || '礼物')}`;
  for (const [entryKey, entry] of giftComboState) {
    if (now - entry.at > GIFT_COMBO_TTL_MS) giftComboState.delete(entryKey);
  }
  const prev = giftComboState.get(key);
  let diff = total;
  if (prev) {
    // 累计值在增长：只补差额
    if (total > prev.count) diff = total - prev.count;
    // 结束帧会重复上一帧的累计值（如 ×5 连击中 → ×5），不能整段再计一次
    else if (total === prev.count) diff = 0;
    // total < prev.count：上一轮结束帧丢失后又开了一轮，整帧计入
  }
  // 结束帧（或缺少连击标记的单次礼物）统计后清掉，下一轮从 1 重新算
  if (gift.completed !== false) giftComboState.delete(key);
  else giftComboState.set(key, { count: total, at: now });
  return Math.max(0, diff);
}

function handleEvent(event) {
  if (!event || !event.type) return;
  const now = Date.now();

  if (event.id) {
    if (state.seenIds.has(event.id)) return;
    state.seenIds.add(event.id);
    if (state.seenIds.size > 3000) state.seenIds.clear();
  }

  if (event.type === 'stats') {
    const stats = event.stats || {};
    if (stats.online > 0) state.stats.online = stats.online;
    if (stats.cumulative > 0) state.stats.cumulative = Math.max(state.stats.cumulative, stats.cumulative);
    if (Array.isArray(event.viewers)) {
      const at = Date.now();
      state.audienceAt = at;
      state.audience.clear();
      for (const viewer of event.viewers) {
        if (!viewer) continue;
        const id = String(viewer.id || '');
        const name = String(viewer.nickname || '').trim();
        if (id) state.audience.set(id, at);
        if (name) state.audience.set(name, at);
      }
    }
    updateStatsUI();
    postPetEvent(event);
    schedulePetStatus();
    return;
  }

  if (event.type === 'control') {
    const status = event.control ? event.control.status : 0;
    appendSystem(status === 3 ? '直播已结束' : `直播状态变化（status=${status}）`);
    forwardEvent(event);
    postPetEvent(event);
    if (status === 3) {
      failQueuedReplyMarks();
      state.replyQueue.length = 0;
      log('warn', '检测到直播结束，已清空待发送队列');
      saveLiveMemory({ final: true });
      if (state.settings.replyEnabled) {
        applySettings({ replyEnabled: false });
        toast('直播已结束，自动回复已关闭', 'warn');
      }
    } else if (status) {
      loadAiMemory();
      liveSessionKey({ create: true }).catch(() => {});
    }
    schedulePetStatus();
    return;
  }

  state.stats.received += 1;
  state.eventTimes.push(now);
  if (state.eventTimes.length > 1200) state.eventTimes.splice(0, 200);
  if (isOwnEvent(event)) {
    scheduleStats();
    schedulePetStatus();
    return;
  }
  // 抖音会把送礼提示混进弹幕文本（「送出 小心心 x1」「送出 @某人 x1」），
  // 不是观众发言：不计入聊天、不点歌、不回帖，礼物本身由 gift 事件处理
  if (event.type === 'chat' && isGiftNoticeText(event.content)) return;
  if (event.type === 'chat' && event.content) state.lastChatAt = now;
  rememberViewer(event);
  recordVisitLedger(event);
  if (event.type === 'gift') {
    state.stats.rice += giftComboDelta(event, now);
  }

  if (event.type === 'like') {
    if (isOwnEvent(event)) return;
    const likeCount = Number(event.like && event.like.count) || 0;
    const likeTotal = Number(event.like && event.like.total) || 0;
    state.stats.likes = likeTotal > 0
      ? Math.max(state.stats.likes, likeTotal)
      : state.stats.likes + likeCount;
    state.likeAccum.count += likeCount;
    state.likeAccum.total = Math.max(state.likeAccum.total, likeTotal);
    state.likeAccum.lastUser = event.user || state.likeAccum.lastUser;
    if (now - state.likeAccum.lastShown >= LIKE_FLUSH_MS) {
      const likeEvent = {
        id: uid('like'),
        type: 'like',
        ts: now,
        user: state.likeAccum.lastUser,
        like: { count: state.likeAccum.count, total: state.likeAccum.total },
      };
      appendFeedItem(likeEvent);
      postPetEvent(likeEvent);
      handleDshLikeThanks(likeEvent);
      state.likeAccum = { count: 0, total: 0, lastShown: now, lastUser: null };
    }
  } else {
    appendFeedItem(event);
    postPetEvent(event);
  }

  scheduleStats();
  schedulePetStatus();
  if (event.type === 'chat' && event.content) state.lastChatAt = now;
  handleDshEvent(event);
  forwardEvent(event);
  if (event.type === 'gift') handleSongGift(event).catch(() => {});
  if (event.type === 'chat' && isCutSongQuestion(event.content)) {
    if (handleCutSongQuestion(event)) return;
  }
  if (event.type === 'chat' && isCutSongCommand(event)) {
    handleCutSongCommand(event).catch(() => {});
    return;
  }
  if (event.type === 'chat' && isVolumeCommand(event)) {
    handleVolumeCommand(event).catch(() => {});
    return;
  }
  // 否认访问记录先于记忆问答：「我没来过」要走留证核查，不能被当成普通记忆问题
  if (event.type === 'chat' && isVisitDispute(event.content)) {
    handleVisitDispute(event).catch(() => {});
    return;
  }
  if (event.type === 'chat' && isMemoryQuestion(event.content)) {
    handleViewerMemory(event).catch(() => {});
    return;
  }
  if (event.type === 'chat' && isBalanceQuestion(event.content)) {
    handleBalanceQuestion(event).catch(() => {});
    return;
  }
  if (event.type === 'chat' && isTimeQuestion(event.content)) {
    handleTimeQuestion(event);
    return;
  }
  // 甩飞必须先于桌宠动作解析：否则「甩飞糖糖」会被当成动作口令随机播放
  if (event.type === 'chat' && throwCommandReady(event)) {
    handleThrowBubble(event).catch(() => {});
    return;
  }
  // 观众问「头像为什么弹来弹去 / 怎么上气泡流」时，说明金光=喂过白饭，并提示送小心心或等系统自动拾取
  if (event.type === 'chat' && isBubbleGuideQuestion(event.content)) {
    handleBubbleGuideQuestion(event);
    return;
  }
  if (event.type === 'chat' && isQueueJumpQuestion(event.content)) {
    if (handleQueueJumpQuestion(event)) return;
  }
  // 没带歌名的「帮我点首歌」交给桌宠自动挑一首，不能走普通点歌的「要带歌名」分支
  if (event.type === 'chat' && isPetSongHelpCommand(event)) {
    handlePetSongHelp(event).catch(() => {});
    return;
  }
  if (event.type === 'chat' && isSongCommand(event)) {
    const ruleQuery = parseSongQuery(event.content, songPrefix());
    // 规则提取出的歌名太泛（如“你的歌”“唱歌”），交给大模型确认是不是真点歌
    if (ruleQuery && isVagueSongQuery(ruleQuery) && shouldAskAiForSongIntent(event)) {
      handleChatViaAi(event);
      return;
    }
    handleSongCommand(event).catch(() => {});
    return;
  }
  if (event.type === 'chat' && handleDshActionCommand(event)) return;
  if (shouldAskAiForSongIntent(event)) {
    handleChatViaAi(event);
    return;
  }
  maybeAutoReply(event);
}

let statsFrame = 0;
function scheduleStats() {
  if (statsFrame) return;
  const run = () => {
    statsFrame = 0;
    updateStatsUI();
  };
  statsFrame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : setTimeout(run, 100);
}

function appendSystem(text) {
  appendFeedItem({ id: uid('system'), type: 'system', ts: Date.now(), content: text });
}

function matchesFilter(event) {
  return state.filter === 'all' || event.type === state.filter;
}

function describeEvent(event) {
  switch (event.type) {
    case 'chat':
      return event.content || '（空消息）';
    case 'gift': {
      const gift = event.gift || {};
      const suffix = gift.completed === false && gift.count > 1 ? '（连击中）' : '';
      return `送出 ${gift.name || '礼物'} ×${gift.count || 1}${suffix}`;
    }
    case 'member':
      return (event.member && event.member.actionDescription) || '进入了直播间';
    case 'follow':
      return '关注了主播';
    case 'like':
      return `点赞 +${(event.like && event.like.count) || 0}`;
    case 'share':
      return '分享了直播间';
    case 'system':
      return event.content || '';
    default:
      return event.method || '事件';
  }
}

function createFeedItem(event) {
  const user = event.user || null;
  const item = el('li', { className: `feed-item type-${event.type}` });

  const avatar = el('div', { className: 'avatar' });
  const initial = user && user.nickname ? Array.from(user.nickname)[0] : (TYPE_LABELS[event.type] || '·')[0];
  avatar.textContent = initial;
  if (user && user.avatar) {
    const img = el('img', { src: user.avatar, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.remove());
    avatar.append(img);
  }

  const meta = el('div', { className: 'meta' });
  if (user) {
    meta.append(el('span', { className: 'uname', textContent: user.nickname, title: user.nickname }));
    if (user.level) meta.append(el('span', { className: 'lv', textContent: `Lv.${user.level}` }));
    if (user.fansClub && user.fansClub.name) {
      meta.append(el('span', { className: 'fans', textContent: user.fansClub.name }));
    }
  }
  meta.append(el('span', { className: 'badge', textContent: TYPE_LABELS[event.type] || event.type }));
  meta.append(el('span', { className: 'time', textContent: fmtClock(event.ts) }));

  const text = el('div', {
    className: `text${event.emoji ? ' emoji' : ''}`,
    textContent: describeEvent(event),
  });

  item.dataset.eventId = event.id == null ? '' : String(event.id);
  item.append(avatar, el('div', { className: 'body' }, [meta, text]));
  if (item.dataset.eventId) applyReplyMark(item, state.replyMarks.get(item.dataset.eventId));
  return item;
}

const REPLY_STATUS_LABELS = {
  replying: '正在回复…',
  replied: '已回复',
  failed: '回复失败',
};

function applyReplyMark(item, mark) {
  if (!item) return;
  item.classList.remove('is-replying', 'is-replied', 'is-reply-failed');
  let badge = item.querySelector('.reply-state');
  if (!mark) {
    if (badge) badge.remove();
    return;
  }
  if (!badge) {
    badge = el('span', { className: 'reply-state' });
    const meta = item.querySelector('.meta');
    if (!meta) return;
    meta.append(badge);
  }
  badge.className = `reply-state ${mark.status}`;
  badge.textContent = REPLY_STATUS_LABELS[mark.status] || '';
  item.classList.add(`is-${mark.status}`);
}

function refreshReplyMark(eventId) {
  const id = String(eventId || '');
  if (!id) return;
  const mark = state.replyMarks.get(id);
  $$('.feed-item').forEach((item) => {
    if (item.dataset.eventId === id) applyReplyMark(item, mark);
  });
}

function markReplyStart(eventId, meta = {}) {
  const id = String(eventId || '');
  if (!id) return false;
  const pending = (state.replyPending.get(id) || 0) + 1;
  state.replyPending.set(id, pending);
  const previous = state.replyMarks.get(id);
  if (previous && previous.timer) clearTimeout(previous.timer);
  state.replyMarks.set(id, { status: 'replying', ruleName: meta.ruleName || '', timer: 0 });
  refreshReplyMark(id);
  postPet({
    kind: 'reply_start',
    room: roomInfo(),
    eventId: id,
    ruleName: meta.ruleName || '',
    user: meta.user || null,
  });
  return true;
}

function markReplyDone(eventId, ok = true) {
  const id = String(eventId || '');
  if (!id) return;
  const pending = state.replyPending.get(id) || 0;
  if (pending > 1) {
    state.replyPending.set(id, pending - 1);
    return;
  }
  state.replyPending.delete(id);
  const mark = { status: ok ? 'replied' : 'failed', timer: 0 };
  state.replyMarks.set(id, mark);
  refreshReplyMark(id);
  mark.timer = setTimeout(() => {
    if (state.replyMarks.get(id) === mark) {
      state.replyMarks.delete(id);
      refreshReplyMark(id);
    }
  }, 8000);
  if (!ok) postPet({ kind: 'reply_failed', room: roomInfo(), eventId: id });
}

function clearReplyMarks() {
  for (const mark of state.replyMarks.values()) {
    if (mark && mark.timer) clearTimeout(mark.timer);
  }
  state.replyMarks.clear();
  state.replyPending.clear();
}

function failQueuedReplyMarks() {
  for (const job of state.replyQueue) {
    if (job.eventId) markReplyDone(job.eventId, false);
  }
}

function updateFeedEmpty() {
  const list = $('#feed');
  const box = $('#feedEmpty');
  if (!list || !box) return;
  const hasVisible = list.children.length > 0;
  box.hidden = hasVisible;
  if (!hasVisible) {
    const first = box.querySelector('p');
    if (first) {
      first.textContent = state.feedEvents.some(matchesFilter) ? '该分类暂时没有消息' : '还没有收到弹幕';
    }
  }
}

function appendFeedItem(event) {
  state.feedEvents.push(event);
  while (state.feedEvents.length > 800) state.feedEvents.shift();

  if (!matchesFilter(event)) {
    updateFeedEmpty();
    return;
  }

  const list = $('#feed');
  if (!list) return;
  list.append(createFeedItem(event));

  const limit = Math.round(clamp(state.settings.ui.feedLimit || 300, 50, 800));
  while (list.children.length > limit) list.firstElementChild.remove();

  updateFeedEmpty();
  if ($('#autoscrollToggle') && $('#autoscrollToggle').checked) {
    list.scrollTop = list.scrollHeight;
  }
}

function renderFeed() {
  const list = $('#feed');
  if (!list) return;
  list.textContent = '';
  const limit = Math.round(clamp(state.settings.ui.feedLimit || 300, 50, 800));
  const items = state.feedEvents.filter(matchesFilter).slice(-limit);
  const fragment = document.createDocumentFragment();
  for (const event of items) fragment.append(createFeedItem(event));
  list.append(fragment);
  updateFeedEmpty();
  if ($('#autoscrollToggle') && $('#autoscrollToggle').checked) {
    list.scrollTop = list.scrollHeight;
  }
}

/* ---------------- 点歌 ---------------- */

function songPrefix() {
  return String(state.settings.songRequest.prefix || '点歌').trim() || '点歌';
}

function isSongCommand(event) {
  if (state.settings.serviceEnabled === false) return false;
  if (!state.settings.songRequest.enabled) return false;
  if (!event || event.type !== 'chat') return false;
  return parseSongQuery(event.content, songPrefix()) !== null;
}

// 「帮我点首歌」：让桌宠自己挑一首，必须有歌名之外的独立判定，避免和普通点歌抢
function isPetSongHelpCommand(event) {
  if (state.settings.serviceEnabled === false) return false;
  if (!state.settings.songRequest.enabled) return false;
  if (!event || event.type !== 'chat') return false;
  return isPetSongHelp(event.content);
}

function isCutSongCommand(event) {
  if (state.settings.serviceEnabled === false) return false;
  if (!state.settings.songRequest.enabled) return false;
  if (!event || event.type !== 'chat') return false;
  return parseCutSongIntent(event.content);
}

// 规则没命中、但明显在聊歌的弹幕，才交给大模型兜底判定
const SONG_TALK_RE =
  /(点歌|点一首|点首|切歌|切一首|切首|换歌|换一首|换首|下一首|下一首歌|下一曲|跳过|想听|来一首|来首|放首|放一首|放一下|播首|播一首|唱首|唱一首|唱个歌|唱歌|求一首|歌曲|这首歌|听歌|歌单|点播|歌名)/;

function shouldAskAiForSongIntent(event) {
  if (state.settings.serviceEnabled === false) return false;
  if (!state.settings.songRequest.enabled) return false;
  if (!event || event.type !== 'chat') return false;
  const ai = state.settings.ai;
  if (!ai || !ai.enabled || !ai.apiKey) return false;
  const content = String(event.content || '').trim();
  if (!content || content.length > 80) return false;
  return SONG_TALK_RE.test(content);
}

async function resolveSongIntentWithAi(event) {
  const content = String(event.content || '').trim();
  const nickname = (event.user && event.user.nickname) || '观众';
  try {
    const result = await classifySongIntent({ ai: state.settings.ai, content, timeoutMs: 8000 });
    if (result.tokens) addTokenUsage(result.tokens);
    if (result.skipped) return false;
    log(
      'info',
      `AI 点歌判定 ${nickname}：${content} → ${JSON.stringify({
        intent: result.intent,
        query: result.query,
        confidence: result.confidence,
      })}`,
    );
    if (result.confidence < 0.7) return false;
    if (result.intent === 'point' && result.query) {
      await handleSongCommand(event, result.query);
      return true;
    }
    if (result.intent === 'cut') {
      await handleCutSongCommand(event);
      return true;
    }
    return false;
  } catch (error) {
    log('warn', `AI 点歌判定失败：${error.message}`);
    return false;
  }
}

function handleChatViaAi(event) {
  resolveSongIntentWithAi(event)
    .then((handled) => {
      if (!handled) maybeAutoReply(event);
    })
    .catch(() => maybeAutoReply(event));
}

const VAGUE_SONG_QUERY =
  /^(?:歌|首歌|唱歌|唱歌歌|音乐|曲子|点歌|一首|一下|随便|都行|你定|你看着办|你的歌|你的声音|你说话|你聊天|你唱|你唱歌)$/;

function isVagueSongQuery(query) {
  return VAGUE_SONG_QUERY.test(String(query || '').trim());
}

function isVolumeCommand(event) {
  if (state.settings.serviceEnabled === false) return false;
  if (!state.settings.songRequest.enabled) return false;
  if (!event || event.type !== 'chat') return false;
  return parseVolumeIntent(event.content) !== null;
}

async function handleVolumeCommand(event) {
  const intent = parseVolumeIntent(event.content);
  if (!intent) return;
  const nickname = (event.user && event.user.nickname) || '观众';
  try {
    const response = await fetch(`${songRequestUrl()}/api/song/volume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(intent),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (result.ok) {
      const text = `${safeNickname(nickname)}，音乐音量已调到 ${result.volume}%（范围 ${result.min}%~${result.max}%）`;
      replySong(text);
      speakDsh(text, { priority: SPEECH_PRIORITY.song });
      toast(text, 'ok');
      log('info', `音量：${nickname} ${JSON.stringify(intent)} → ${result.volume}%`);
    } else {
      const text = `音量调节失败：${result.error || '未知错误'}`;
      replySong(text);
      speakDsh(text, { priority: SPEECH_PRIORITY.song });
      toast(text, 'warn');
      log('warn', text);
    }
  } catch {
    const text = '音量服务未连接，请稍后再试';
    speakDsh(text, { priority: SPEECH_PRIORITY.song });
    toast(text, 'warn');
    log('warn', text);
  }
}

function handleTimeQuestion(event) {
  const nickname = (event.user && event.user.nickname) || '观众';
  const text = `${safeNickname(nickname)}，现在是${formatNowText()}`;
  enqueueReply(
    {
      ruleId: 'viewer-time',
      ruleName: '报时',
      text,
      userId: songUserKey(event.user),
      eventId: event.id,
      scope: 'chat',
      ts: Date.now(),
    },
    state.page.tabId,
    { force: true },
  );
  drainQueue();
  if (state.settings.dshPet && state.settings.dshPet.enabled) {
    dshBroadcast(text, { force: true, duration: 6000 });
  }
  speakDsh(text, { priority: SPEECH_PRIORITY.chat });
  toast(text, 'ok');
  log('info', `报时：${nickname}`);
}

/* ---------------- 甩飞互动：把气泡流里的观众甩出去 ---------------- */
const THROW_PICKUP_MS = 520; // 气泡飞到桌宠手心并完成绑定
const THROW_ANIM_MS = 1100; // 桌宠甩出动作的播放周期，播完立刻甩气泡
const THROW_FLIGHT_MS = 460; // 甩向送礼榜、飞行中放大
const THROW_SLIDE_MS = 620; // 撞屏后沿屏幕滑到底部、缩回原尺寸
// 同一时间只允许一段甩飞，避免连续指令叠在一起
let throwBusyUntil = 0;

// 送礼感谢 / 记忆回复播放中（受保护语音）时先等语音通道空出来，
// 保证甩飞动作与口播同一帧开始；普通闲聊语音会被 gift 优先级直接打断
function waitForSpeechSlot(timeoutMs = 6000) {
  if (!speechBusy || !speechProtected) return Promise.resolve();
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (!speechBusy || !speechProtected || Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        resolve();
      }
    }, 90);
  });
}

function throwCommandReady(event) {
  const cfg = state.settings.dshPet || {};
  if (!isLeader || !dshPet || !cfg.enabled) return false;
  if (!event || event.type !== 'chat' || isOwnEvent(event)) return false;
  return Boolean(parseThrowIntent(event.content));
}

// 气泡流名单由背景板按「累计白饭 ≥ 阈值的前 N 位」实时下发到桥接
async function fetchBoardBubbles() {
  const read = async () => {
    const response = await fetch(`${boardUrl()}/api/board/state`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return Array.isArray(data.bubbles) ? data.bubbles : [];
  };
  let bubbles = [];
  let reachable = true;
  // 桥接刚重启（请求失败）或背景板名单还在防抖（返回空）时多等一会儿再判定
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      bubbles = await read();
      reachable = true;
    } catch {
      bubbles = [];
      reachable = false;
    }
    if (bubbles.length) return bubbles;
    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, reachable ? 300 : 700));
    }
  }
  return bubbles;
}

function resolveThrowAnimation() {
  const pool = petActionPool(dshPet.animations);
  return (
    pool.find((name) => /甩|抛|扔|丢|投/.test(name)) ||
    resolvePetAction('抛球', dshPet.animations) ||
    ''
  );
}

async function handleThrowBubble(event) {
  const intent = parseThrowIntent(event.content);
  if (!intent) return;
  if (Date.now() - lastDshActionAt < 1200) return;
  if (Date.now() < throwBusyUntil) return;
  lastDshActionAt = Date.now();
  throwBusyUntil = Date.now() + THROW_PICKUP_MS + THROW_ANIM_MS + 2200;

  const nickname = safeNickname((event.user && event.user.nickname) || '观众');
  const wanted = intent.self ? nickname : safeNickname(intent.target, '该用户');
  const bubbles = await fetchBoardBubbles();
  // 「甩飞我自己」先按发指令用户的 id 精确查，查不到再退回昵称匹配
  const hit = intent.self
    ? matchSelfBubble(event.user, bubbles)
    : matchBubbleTarget(intent.target, bubbles);

  // 目标不在气泡流：语音与界面文字提示同时触发（文字先落，语音随后播放）
  if (!hit) {
    const text = `${wanted}没在气泡流中`;
    speakDsh(text, { priority: SPEECH_PRIORITY.chat });
    appendSystem(text);
    postBoard({ kind: 'bubble_throw', data: { miss: true, key: '', name: wanted } });
    toast(text, 'warn');
    log('warn', `甩飞：${nickname}「${intent.self ? '我自己' : intent.target}」不在气泡流（user=${String((event.user && event.user.id) || '空')}，当前 ${bubbles.length} 个气泡：${bubbles.slice(0, 5).map((item) => `${item.key}:${item.name}`).join(',') || '无'}）`);
    return;
  }

  const name = safeNickname(hit.name || wanted, '该观众');
  const text = pickThrowLine(name);
  const animation = resolveThrowAnimation();
  // 受保护语音播放中先等通道空出来，避免口播排到后面导致音画脱节
  await waitForSpeechSlot();
  throwBusyUntil = Date.now() + THROW_PICKUP_MS + THROW_ANIM_MS + 2200;
  // 占用动作保护窗口，避免暖场/空闲动画打断整段甩飞
  dshActionBusyUntil = Date.now() + THROW_PICKUP_MS + THROW_ANIM_MS + 1800;
  postBoard({
    kind: 'bubble_throw',
    data: {
      key: hit.key,
      name,
      pickupMs: THROW_PICKUP_MS,
      holdMs: THROW_ANIM_MS,
      flightMs: THROW_FLIGHT_MS,
      slideMs: THROW_SLIDE_MS,
    },
  });
  // 拾取完成后触发甩出动作；动作与语音同一帧派发，保证音画同步起点一致
  setTimeout(() => {
    if (!isLeader || !dshPet || !state.settings.dshPet.enabled) return;
    if (animation) dshAnim(animation, null, { force: true });
    dshBroadcast(text, { force: true, anim: false, duration: 6000 });
    // 用送礼级优先级：可打断闲聊/点歌/欢迎语音，确保口播与动作同一帧起播
    speakDsh(text, { priority: SPEECH_PRIORITY.gift });
  }, THROW_PICKUP_MS);
  appendSystem(`${nickname} 把 ${name} 甩飞了`);
  toast(`甩飞 ${name}`, 'ok');
  log(
    'info',
    `甩飞：${nickname}「${intent.target}」→ ${name}(${hit.key})，动作 ${animation || '未匹配'}，白饭 ${hit.rice || 0}`,
  );
}

function queueJumpGiftName() {
  const raw = String((state.settings.songRequest && state.settings.songRequest.priorityGifts) || '小心心');
  const name = raw
    .split(/[,，、/\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)[0];
  return name || '小心心';
}

// 观众问「怎么插队」时提示送插队礼物；点歌未开启就不接管，交给普通聊天
function handleQueueJumpQuestion(event) {
  if (!state.settings.songRequest || !state.settings.songRequest.enabled) return false;
  const nickname = (event.user && event.user.nickname) || '观众';
  const text = `${safeNickname(nickname)}，送一个${queueJumpGiftName()}就能插队，点的歌会排到队列前面哦`;
  enqueueReply(
    {
      ruleId: 'queue-jump',
      ruleName: '插队提示',
      text,
      userId: songUserKey(event.user),
      eventId: event.id,
      scope: 'chat',
      ts: Date.now(),
    },
    state.page.tabId,
    { force: true },
  );
  drainQueue();
  if (state.settings.dshPet && state.settings.dshPet.enabled) {
    dshBroadcast(text, { force: true, duration: 6000 });
  }
  speakDsh(text, { priority: SPEECH_PRIORITY.chat });
  toast(text, 'ok');
  log('info', `插队咨询：${nickname}`);
  return true;
}

// 观众问「切歌到某某」「切到第几首」时，说明切歌与插队的规则；点歌未开启就不接管
function handleCutSongQuestion(event) {
  if (!state.settings.songRequest || !state.settings.songRequest.enabled) return false;
  const nickname = (event.user && event.user.nickname) || '观众';
  const sec = Math.round(Number(state.settings.songRequest.queueCutSec) || 90);
  const text = `${safeNickname(nickname)}，切歌指令只有切歌两个字，条件是歌得是你点的、当前歌曲播满${sec}秒；不能指定切到第几首，想往前排就送一个${queueJumpGiftName()}插队`;
  enqueueReply(
    {
      ruleId: 'cut-song-help',
      ruleName: '切歌说明',
      text,
      userId: songUserKey(event.user),
      eventId: event.id,
      scope: 'chat',
      ts: Date.now(),
    },
    state.page.tabId,
    { force: true },
  );
  drainQueue();
  if (state.settings.dshPet && state.settings.dshPet.enabled) {
    dshBroadcast(text, { force: true, duration: 8000 });
  }
  speakDsh(text, { priority: SPEECH_PRIORITY.chat });
  toast(text, 'ok');
  log('info', `切歌咨询：${nickname}`);
  return true;
}

// 观众问「头像为什么弹来弹去 / 怎么上气泡流」时，说明金光=喂过白饭，并提示送小心心或等系统自动拾取
function handleBubbleGuideQuestion(event) {
  const nickname = (event.user && event.user.nickname) || '观众';
  const text = `${safeNickname(nickname)}，闪金光的头像是给鲸鱼娘喂过白饭的；送个小心心也算喂白饭，就能上气泡流啦，或者等系统自动拾取随机观众也可以哦`;
  enqueueReply(
    {
      ruleId: 'bubble-guide',
      ruleName: '气泡流提示',
      text,
      userId: songUserKey(event.user),
      eventId: event.id,
      scope: 'chat',
      ts: Date.now(),
    },
    state.page.tabId,
    { force: true },
  );
  drainQueue();
  if (state.settings.dshPet && state.settings.dshPet.enabled) {
    dshBroadcast(text, { force: true, duration: 7000 });
  }
  speakDsh(text, { priority: SPEECH_PRIORITY.chat });
  toast(text, 'ok');
  log('info', `气泡流咨询：${nickname}`);
  return true;
}

async function handleCutSongCommand(event) {
  const nickname = safeNickname((event.user && event.user.nickname) || '观众');
  const userKey = songUserKey(event.user);
  try {
    const response = await fetch(`${songRequestUrl()}/api/song/cut`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: nickname, userKey }),
      signal: AbortSignal.timeout(12000),
    });
    const result = await response.json();
    // 已被拉黑的用户：切歌请求静默忽略，不提示不回复
    if (result.blacklisted) return;
    if (result.ok) {
      const song = result.song;
      const text = song
        ? `切歌成功，下一首：${song.title} - ${song.artist}`
        : '切歌成功';
      dshBroadcast(text, { force: true, anim: true, duration: 8000 });
      dshAnim('点击回应-开心跃动');
      speakDsh(text, { priority: SPEECH_PRIORITY.song });
      toast(text, 'ok');
      log('info', `切歌：${nickname} → ${song ? `${song.title} - ${song.artist}` : '下一首'}`);
      return;
    }
    let text;
    if (result.reason === 'need_request') {
      text = '你当前不在点歌队列里，先发送「点歌 歌名」才能切歌';
    } else if (result.reason === 'too_early') {
      text = `当前歌曲还没满一分半，还需 ${Number(result.waitSec) || 0} 秒才能切歌`;
    } else if (result.reason === 'empty') {
      text = '队列里没有下一首，先点歌吧';
    } else if (result.reason === 'paused') {
      text = '当前歌曲暂停中，先恢复播放再切歌';
    } else if (result.reason === 'idle') {
      text = '当前没有播放中的歌曲';
    } else {
      text = `切歌失败：${result.error || '未知错误'}`;
    }
    dshBroadcast(text, { force: true, anim: true, duration: 7000 });
    speakDsh(text, { priority: SPEECH_PRIORITY.song });
    toast(text, 'warn');
    log('warn', `切歌失败：${nickname} - ${text}`);
  } catch {
    const text = '切歌服务未连接，请稍后再试';
    speakDsh(text, { priority: SPEECH_PRIORITY.song });
    toast(text, 'warn');
    log('warn', text);
  }
}

function songRequestUrl() {
  return String(state.settings.songRequest.bridgeUrl || 'http://127.0.0.1:8787').replace(/\/+$/, '');
}

function songUserKey(user) {
  return String((user && (user.id || user.nickname)) || 'anonymous');
}

async function handleSongGift(event) {
  if (state.settings.serviceEnabled === false) return;
  const cfg = state.settings.songRequest;
  if (!cfg.enabled) return;
  if (isOwnEvent(event)) return;
  const gift = event.gift || {};
  const giftName = String(gift.name || event.giftName || '礼物').trim();
  const key = songUserKey(event.user);
  const nickname = safeNickname((event.user && event.user.nickname) || '观众');
  const now = Date.now();
  // 同一用户连击只处理一次，避免一次礼物连击把歌连续上移好几格
  const lastAt = state.priorityGiftAt.get(key) || 0;
  if (now - lastAt < 2000) return;
  state.priorityGiftAt.set(key, now);

  try {
    const response = await fetch(`${songRequestUrl()}/api/song/prioritize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: nickname, userKey: key }),
      signal: AbortSignal.timeout(5000),
    });
    const result = await response.json();
    // 已被拉黑的用户：插队请求静默忽略，不提示不回复
    if (result.blacklisted) return;
    if (result.ok && Number(result.moved) > 0) {
      const text =
        result.zone === 'priority'
          ? `${nickname} 的《${result.title}》上移一位`
          : `${nickname} 的《${result.title}》已插队到第 ${Number(result.position) + 1} 位`;
      toast(text, 'info');
      log('info', `${nickname} 送 ${giftName}，${text}`);
      return;
    }
    if (result.reason === 'already_top') {
      toast(`${nickname} 的歌已经在插队区最前面`, 'info');
      return;
    }
    if (result.reason === 'no_queue_song') {
      toast(`${nickname} 先点歌，再送礼物才能插队`, 'warn');
      return;
    }
    toast(`插队失败：${result.error || '队列里没有可移动的歌曲'}`, 'warn');
  } catch {
    toast('插队服务未连接，请稍后再试', 'warn');
  }
}

function replySong(text) {
  if (!state.settings.songRequest.reply) return;
  const limit = Math.max(1, Number(state.settings.maxQueue) || 20);
  if (state.replyQueue.length >= limit) return;
  enqueueReply(
    {
      ruleId: 'song',
      ruleName: '点歌',
      text: String(text).slice(0, 120),
      userId: 'song',
      eventId: `song-${Date.now()}`,
      scope: 'chat',
      ts: Date.now(),
    },
    state.page.tabId,
    { force: true },
  );
  drainQueue();
}

function notifySongError(text) {
  const message = String(text || '').trim();
  if (!message) return;
  log('warn', message);
  toast(message, 'warn');
  speakDsh(message, { priority: SPEECH_PRIORITY.song });
}

const HORROR_SONG_RE = /(恐怖|惊悚|灵异|鬼故事|鬼新娘|鬼片|鬼魂|鬼怪|鬼娃|冥婚|红嫁衣|厉鬼|恶鬼|怨灵|丧尸|僵尸|冥界|地狱|诅咒|招魂|驱魔|凶杀|血腥|自杀|午夜凶铃|咒怨|笔仙|碟仙|红衣小女孩|惊魂|阴间)/i;

async function checkSongSafety(query) {
  const text = String(query || '');
  // 政治 / 国歌 / 红歌类内容一律拒绝，不受恐怖过滤开关影响
  if (findSensitiveSongWord(text)) {
    return { ok: false, message: SENSITIVE_SONG_MESSAGE };
  }
  const cfg = state.settings.songRequest || {};
  if (cfg.horrorFilter === false) return { ok: true };
  if (HORROR_SONG_RE.test(text)) {
    return { ok: false, message: '这首歌不适合直播间，换一首吧' };
  }
  const ai = state.settings.ai;
  if (!ai || !ai.enabled || !ai.apiKey) return { ok: true };
  try {
    const result = await classifySongSafety({ ai, query });
    addTokenUsage(result.tokens);
    if (result.horror) {
      return { ok: false, message: '这首歌不适合直播间，换一首吧' };
    }
  } catch (error) {
    log('warn', `点歌审核暂时不可用，按关键词放行：${error.message}`);
  }
  return { ok: true };
}
// 不良昵称观众的「我是谁」回答：不提昵称、不复述其发言，只按行为给一句中性记忆
function safeMemoryLine(record) {
  const songs = Array.isArray(record && record.songs) ? record.songs.length : 0;
  const gifts = Array.isArray(record && record.gifts) ? record.gifts.length : 0;
  const chats = Array.isArray(record && record.chats) ? record.chats.length : 0;
  if (songs && gifts) return '记得你呀，你点过歌也送过礼物，是直播间的老朋友啦';
  if (songs) return '记得你呀，你点过歌，我一直在等你再来听呢';
  if (gifts) return '记得你呀，你送过礼物支持鲸鱼娘，是直播间老朋友啦';
  if (chats) return '记得你呀，你常来陪鲸鱼娘聊天，是直播间的老朋友啦';
  // 没有真实记录时不能宣称来过，按首次见面回答
  return '第一次见你呀，不过我现在记住你啦，以后常来直播间玩哦';
}

async function handleViewerMemory(event) {
  if (!event || event.type !== 'chat') return;
  if (isOwnEvent(event)) return;
  const user = event.user || {};
  const nickname = String(user.nickname || '观众');
  const unsafeName = isUnsafeNickname(nickname);
  if ((state.settings.blockedUsers || []).some((item) => String(item) === nickname || String(item) === String(user.id || ''))) {
    return;
  }
  const key = String(user.id || nickname);
  if (state.memoryPending.has(key)) return;
  state.memoryPending.add(key);
  try {
    const record = state.viewers.get(key);
    const question = String(event.content || '').trim();
    const digestRecord = record
      ? { ...record, chats: (record.chats || []).filter((text) => String(text).trim() !== question) }
      : null;
    // 检索顺序：先单场记忆，单场没命中再查跨直播记忆
    const singleHit = hasViewerMemory(digestRecord);
    const cachedCross = singleHit ? null : findCrossViewer(user);
    const cachedMemory = Boolean(!singleHit && (cachedCross || state.knownViewers.has(key)));
    // 优化检测规则：跨场缓存只当线索，必须与留证台账核对后才允许说「我记得你来过」
    let ledgerVisit = null;
    let ledgerChecked = false;
    if (cachedMemory) {
      const ledger = await fetchLedger(user);
      ledgerChecked = Boolean(ledger);
      if (ledger) ledgerVisit = filterVisitLedger(ledger);
    }
    // 台账可达且确无访问记录时，不再依据缓存宣称来过，按首次见面回答
    const ledgerBacked = !cachedMemory || (ledgerChecked && ledgerVisit.total > 0);
    const crossViewer = ledgerBacked ? cachedCross : null;

    let text = '';
    const ai = state.settings.ai || {};
    // 昵称不适宜的观众：不调大模型、不引用其发言，避免把不良内容读出来
    if (unsafeName) {
      text = safeMemoryLine(ledgerBacked ? digestRecord : null);
    } else {
      // 排除提问本身后仍有记录，才让大模型总结，避免第一次来也硬编细节
      if ((singleHit || crossViewer) && ai.enabled && ai.apiKey) {
        try {
          const result = await summarizeViewerMemory({
            ai,
            digest: singleHit ? buildViewerDigest(digestRecord) : buildCrossViewerDigest(crossViewer),
            timeoutMs: 12000,
          });
          if (result.tokens) addTokenUsage(result.tokens);
          text = result.text || '';
        } catch (error) {
          log('warn', `记忆回答 AI 失败，使用本地兜底：${error.message}`);
        }
      }
      text = fitMemoryReply(text, nickname);
      if (!text) {
        if (singleHit) {
          text = fallbackMemoryReply(digestRecord, nickname);
        } else if (crossViewer) {
          text = fallbackCrossReply(crossViewer, nickname);
        } else if (ledgerBacked && state.knownViewers.has(key)) {
          // 本场没记录但留证台账确认以前来过，才能说“记得你”
          text = fitMemoryReply(`${nickname}，我记得你来过直播间呀，欢迎再来看鲸鱼娘，常来玩哦～`, nickname);
        } else {
          text = fallbackMemoryReply(null, nickname);
        }
      }
    }
    if (!text) return;
    // 依赖跨场缓存做出的记忆判断写入台账，争议时可追溯当时的判断依据
    if (cachedMemory && ledgerBacked && ledgerVisit && ledgerVisit.total > 0) {
      recordLedgerAudit(user, 'claim', `记忆声明：依据留证台账 ${ledgerVisit.total} 条访问记录`);
    }
    deliverViewerReply(event, text, 'viewer-memory', '记忆回答');
    log('info', `记忆回答：${safeNickname(nickname)} → ${text}`);
  } finally {
    state.memoryPending.delete(key);
  }
}

/** 记忆类回复统一出口：语音 + 桌宠气泡 + 公屏回复 + 事件流。 */
function deliverViewerReply(event, text, ruleId, ruleName) {
  if (!text) return;
  const user = (event && event.user) || {};
  const userId = String(user.id || user.nickname || '');
  // 语音优先且不被后续语音覆盖，期间其他语音自动排队
  speakProtected(text);
  if (state.settings.dshPet && state.settings.dshPet.enabled) {
    dshBroadcast(text, { force: true, anim: true, duration: 8000 });
  }
  enqueueReply(
    {
      ruleId,
      ruleName,
      text,
      userId,
      eventId: event.id,
      scope: 'chat',
      ts: Date.now(),
    },
    state.page.tabId,
    { mark: false, force: true },
  );
  drainQueue();
  postPet({
    kind: 'ai_reply',
    room: roomInfo(),
    eventId: event.id || '',
    text,
    provider: ruleName,
    ruleName,
    dryRun: Boolean(state.settings.dryRun),
    user: event.user || null,
  });
  toast(text, 'info');
}

/** 误判原因只写系统能核实的事实：命中了哪些缓存，台账确实没有访问记录。 */
function misjudgeReason(user, key) {
  const sources = [];
  if (state.viewers.has(key)) sources.push('单场观众缓存');
  if (state.knownViewers.has(key)) sources.push('本地观众历史');
  if (findCrossViewer(user)) sources.push('跨场记忆');
  const origin = sources.length ? `来源：${sources.join('+')}` : '来源：记忆问答缺少台账依据';
  return `误判原因：${origin}命中，但留证台账无该用户访问记录（按用户 id/昵称精确匹配）`;
}

/**
 * 访问争议处理：用户否认访问记录时，先调取证链再判定。
 * 有记录 → 展示进入时间 + 行为轨迹；无记录 → 正式致歉并记录误判；
 * 桥接不可达 / 哈希链异常 → 只做中性说明，不做主观判定。
 */
async function handleVisitDispute(event) {
  if (!event || event.type !== 'chat' || isOwnEvent(event)) return;
  const user = event.user || {};
  const nickname = String(user.nickname || '观众');
  const key = String(user.id || nickname);
  if ((state.settings.blockedUsers || []).some((item) => String(item) === nickname || String(item) === String(user.id || ''))) {
    return;
  }
  if (state.disputePending.has(key)) return;
  state.disputePending.add(key);
  try {
    const displayName = safeNickname(nickname, '观众');
    const redactChat = isUnsafeNickname(nickname);
    // 用户的否认原话写进审计记录，争议全过程可追溯
    const statement = String(event.content || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const ledger = await fetchLedger(user);
    if (!ledger) {
      deliverViewerReply(event, formatUnavailableReply(displayName), 'viewer-evidence', '访问留证');
      log('warn', `访问争议核查：桥接不可达，无法调取 ${displayName} 的留证台账`);
      return;
    }
    if (ledger.verified === false) {
      // 证据链被篡改/删改时不提供证据、不判定，转人工复核
      await recordLedgerAudit(user, 'dispute', `留证链校验异常，已停止自动判定｜原话「${statement}」`);
      deliverViewerReply(event, formatChainBrokenReply(displayName), 'viewer-evidence', '访问留证');
      log('error', `访问争议核查：${displayName} 的留证链校验异常，已停止自动判定`);
      return;
    }
    const visit = filterVisitLedger(ledger);
    if (visit.total > 0) {
      await recordLedgerAudit(user, 'dispute', `争议核查：留证台账有 ${visit.total} 条访问记录｜原话「${statement}」`);
      deliverViewerReply(
        event,
        formatEvidenceReply(ledger, displayName, { maxChars: 100 }),
        'viewer-evidence',
        '访问留证',
      );
      log(
        'info',
        `访问争议核查：${displayName} 有 ${visit.total} 条留证记录，已展示证据链`,
        formatEvidenceTimeline(ledger, displayName, { verified: ledger.verified !== false, redactChat }),
      );
      return;
    }
    // 台账暂时没有记录、但本场运行记录里确实有互动（例如桥接短暂掉线没写进台账）：
    // 只能记录待核实，不能直接判成误判；判断时排除这次否认弹幕本身
    const question = String(event.content || '').trim();
    const record = state.viewers.get(key);
    const localDigest = record
      ? { ...record, chats: (record.chats || []).filter((text) => String(text).trim() !== question) }
      : null;
    if (hasViewerMemory(localDigest)) {
      await recordLedgerAudit(user, 'dispute', `台账无记录，本场运行记录存在互动，已记录待核实｜原话「${statement}」`);
      deliverViewerReply(event, formatPendingReply(displayName), 'viewer-evidence', '访问留证');
      log('warn', `访问争议核查：${displayName} 台账无记录，本场运行记录存在互动，暂不判定误判`);
      return;
    }
    // 台账确无访问记录：正式致歉 + 误判留痕
    const reason = misjudgeReason(user, key);
    await recordLedgerAudit(user, 'misjudge', `${reason}｜原话「${statement}」`);
    // 优化检测规则：清掉被证伪的「来过」缓存并摘掉这次否认弹幕，避免同类误判重复
    state.knownViewers.delete(key);
    state.crossViewers.byKey.delete(key);
    const rawName = String(user.nickname || '').trim();
    if (rawName) state.crossViewers.byName.delete(rawName);
    if (record) {
      const cleaned = { ...record, chats: (record.chats || []).filter((text) => String(text).trim() !== question) };
      if (hasViewerMemory(cleaned)) state.viewers.set(key, cleaned);
      else state.viewers.delete(key);
    }
    scheduleViewerHistorySave();
    deliverViewerReply(event, formatApologyReply(displayName), 'viewer-evidence', '访问留证');
    log('warn', `访问争议核查：${displayName} 无访问记录，已致歉并记录误判`, `${reason}｜原话「${statement}」`);
  } finally {
    state.disputePending.delete(key);
  }
}

async function handleSongCommand(event, presetQuery) {
  const content = String(event.content || '').trim();
  const query = String(presetQuery || parseSongQuery(content, songPrefix()) || '')
    .trim()
    .slice(0, 100);
  const nickname = safeNickname((event.user && event.user.nickname) || '观众');
  if (!query) {
    notifySongError('点歌要带上歌名哦，例如：点歌 晴天 / 想听 晴天');
    return;
  }
  const safety = await checkSongSafety(query);
  if (!safety.ok) {
    notifySongError(safety.message || '这首歌不适合直播间，换一首吧');
    return;
  }

  const userKey = songUserKey(event.user);

  try {
    const response = await fetch(`${songRequestUrl()}/api/song/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        user: nickname,
        userKey,
        provider: 'qq',
        cooldownSec: 0,
        minPlaySec: state.settings.songRequest.minPlaySec,
        queueCutSec: state.settings.songRequest.queueCutSec,
        dailyRecommend: state.settings.songRequest.dailyRecommend !== false,
        priority: false,
      }),
      signal: AbortSignal.timeout(25000),
    });
    const result = await response.json();
    if (result.ok) {
      const record = state.viewers.get(userKey);
      if (record) recordViewerSong(record, result.song);
      // 点歌成功也写入留证台账：否认点过歌时可核对
      recordLedgerAudit(
        event.user,
        'song',
        `${result.song.title}${result.song.artist ? ` - ${result.song.artist}` : ''}`,
      );
      const position = Number(result.position) || 0;
      const note = result.note ? `（${result.note}）` : '';
      // 存档回复必须让观众看到：资源已确认、点歌动作已自动启动
      const confirmed = `《${result.song.title}》${result.song.artist ? ` - ${result.song.artist}` : ''} 已确认有可正常点播的资源`;
      if (result.priority) {
        const place = position > 0 ? `已加入插队队列第 ${position} 位` : '即将开始播放';
        const text = `${nickname}，${confirmed}，点歌动作已启动，${place}${note}`;
        replySong(text);
        speakDsh(text, { priority: SPEECH_PRIORITY.song });
        log('info', `插队点歌：${nickname} → ${result.song.title} - ${result.song.artist}`);
      } else {
        const place = position > 0 ? `已加入点歌队列第 ${position} 位` : '即将开始播放';
        const hint = Number(result.sameUserCount) > 0 ? '；同一用户再点可送小心心插队' : '';
        const text = `${nickname}，${confirmed}，点歌动作已启动，${place}${note}${hint}`;
        replySong(text);
        speakDsh(text, { priority: SPEECH_PRIORITY.song });
        log('info', `点歌：${nickname} → ${result.song.title} - ${result.song.artist}`);
      }
    } else if (result.blacklisted && !result.violation) {
      // 已被拉黑：记录后静默返回，永久不再响应后续点歌请求
      log('warn', `点歌被拒：${nickname} 已被拉黑，请求不再处理`);
      return;
    } else if (result.violation) {
      notifySongError(result.error || '这首歌已被列为违规曲目，换一首吧');
      return;
    } else if (result.alreadyQueued) {
      const song = result.song || {};
      const label = `${song.title || query}${song.artist ? ` - ${song.artist}` : ''}`;
      const who = result.requestedBy ? `，点歌人：${safeNickname(result.requestedBy)}` : '';
      const place =
        result.duplicateState === 'current'
          ? '这首歌正在播放中'
          : `这首歌已在点歌队列${result.position ? `第 ${result.position} 位` : '里'}`;
      const text = `${nickname}，《${label}》已确认有可正常点播的资源，点歌动作此前已启动，${place}${who}`;
      replySong(text);
      speakDsh(text, { priority: SPEECH_PRIORITY.song });
      toast(text, 'info');
      log('info', `重复点歌：${nickname} → ${label}`);
    } else {
      notifySongError(`点歌失败：${result.error || '未知错误'}`);
    }
  } catch {
    notifySongError('点歌服务正在启动，请稍后再试');
    log('warn', '点歌服务未连接：已尝试本地自动启动，请确认计划任务或 bridge/server.mjs');
  }
}

async function testSong(query) {
  const text = String(query || '').trim();
  if (!text) return { ok: false, error: '请输入歌名' };
  try {
    const response = await fetch(`${songRequestUrl()}/api/song/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: text,
        user: '主播测试',
        userKey: '主播测试',
        provider: 'qq',
        cooldownSec: 0,
        minPlaySec: state.settings.songRequest.minPlaySec,
        queueCutSec: state.settings.songRequest.queueCutSec,
        dailyRecommend: state.settings.songRequest.dailyRecommend !== false,
        priority: false,
        forcePlay: true,
      }),
      signal: AbortSignal.timeout(25000),
    });
    return await response.json();
  } catch (error) {
    return { ok: false, error: `点歌服务未启动：${error.message}` };
  }
}

async function getSongState() {
  try {
    const response = await fetch(`${songRequestUrl()}/api/song/state`, {
      signal: AbortSignal.timeout(5000),
    });
    return await response.json();
  } catch {
    return null;
  }
}

/* ---------------- 点歌队列大模型审核 ---------------- */

// 每 30 秒审核一轮队列：命中违规就移除歌曲并拉黑点歌人；失败绝不误删
async function auditSongQueue() {
  if (!isLeader) return;
  const ai = state.settings.ai;
  if (!ai || !ai.enabled || !ai.apiKey) return;
  if (state.songAuditRunning) return;
  state.songAuditRunning = true;
  const startedAt = Date.now();
  try {
    const songState = await getSongState();
    const queue = songState && Array.isArray(songState.queue) ? songState.queue : [];
    const total = queue.length;
    if (!total) return;
    log('info', `[song-audit] ${JSON.stringify({ phase: 'start', startedAt, total })}`);
    const results = [];
    let tokenTotal = 0;
    // 已连带清理过的点歌人：后续同名用户的队列歌曲已不在队列里，跳过不再审核
    const clearedUserKeys = new Set();
    for (const item of queue) {
      if (!isLeader) break;
      const title = String((item && item.title) || '');
      const artist = String((item && item.artist) || '');
      const requesterKey = String((item && item.requesterKey) || '');
      if (!title) continue;
      if (requesterKey && clearedUserKeys.has(requesterKey)) continue;
      let verdict;
      try {
        verdict = await judgeSongViolation({ ai, title, artist, timeoutMs: 8000, attempts: 2 });
      } catch (error) {
        results.push({ title, artist, violation: false, reason: '', allowPlay: true, error: String(error && error.message || error) });
        log('warn', `[song-audit] 单首审核失败：${title} - ${artist}：${error && error.message ? error.message : error}`);
        continue;
      }
      if (verdict.tokens) {
        addTokenUsage(verdict.tokens);
        tokenTotal += Number(verdict.tokens) || 0;
      }
      const record = {
        title,
        artist,
        violation: verdict.violation === true,
        reason: verdict.reason || '',
        allowPlay: verdict.allowPlay === true,
      };
      results.push(record);
      if (verdict.violation === true && verdict.allowPlay !== true) {
        try {
          const response = await fetch(`${songRequestUrl()}/api/song/moderate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              requestId: (item && item.requestId) || '',
              title,
              artist,
              reason: verdict.reason || '',
              allowPlay: verdict.allowPlay,
              requesterKey: (item && item.requesterKey) || '',
              requester: (item && item.requestedBy) || '',
            }),
            signal: AbortSignal.timeout(8000),
          });
          const outcome = await response.json();
          record.removedIndex = outcome.removedIndex;
          record.removedOtherSongs = Array.isArray(outcome.removedOtherSongs) ? outcome.removedOtherSongs : [];
          record.removedCount = outcome.removedCount || 1;
          record.queueLength = outcome.queueLength;
          record.blocked = Boolean(outcome.blocked);
          record.recordId = outcome.recordId || '';
          if (outcome.ok) {
            if (record.blocked && requesterKey) clearedUserKeys.add(requesterKey);
            log(
              'info',
              `[song-audit] 已移除违规歌曲：${title} - ${artist}，原因 ${verdict.reason || '无'}，连带清理同用户点歌 ${record.removedOtherSongs.length} 首，记录 ${record.recordId}，队列剩余 ${record.queueLength}，拉黑=${record.blocked}`,
            );
          } else {
            log('warn', `[song-audit] 违规歌曲移除失败：${title} - ${artist}：${outcome.error || '未知错误'}`);
          }
        } catch (error) {
          record.error = String(error && error.message || error);
          log('warn', `[song-audit] 违规歌曲移除请求失败：${title} - ${artist}：${record.error}`);
        }
      }
    }
    log(
      'info',
      `[song-audit] ${JSON.stringify({
        phase: 'end',
        startedAt,
        finishedAt: Date.now(),
        total,
        tokens: tokenTotal,
        results,
      })}`,
    );
  } catch (error) {
    log('warn', `[song-audit] 审核中断：${error && error.message ? error.message : error}`);
  } finally {
    state.songAuditRunning = false;
  }
}

/* ---------------- 桌宠自动点歌 ---------------- */

async function loadAutoSongLibrary() {
  try {
    const data = await chrome.storage.local.get(AUTO_SONG_LIBRARY_KEY);
    state.autoSongLibrary = mergeAutoSongLibrary(
      [],
      data && data[AUTO_SONG_LIBRARY_KEY],
      AUTO_SONG_LIBRARY_MAX,
    );
  } catch {
    state.autoSongLibrary = [];
  }
}

function saveAutoSongLibrary() {
  try {
    chrome.storage.local
      .set({ [AUTO_SONG_LIBRARY_KEY]: state.autoSongLibrary })
      .catch(() => {});
  } catch {
    /* 存储不可用时只保留内存里的歌曲库 */
  }
}

// 当前在直播间的观众昵称：优先用在抖音在线名单里且在线的观众
function autoSongAudienceNames(now = Date.now()) {
  if (!state.audienceAt || now - state.audienceAt > AUDIENCE_FRESH_MS) return [];
  const ownNames = new Set(
    [state.settings.myNickname, state.settings.myUserId, '大肥鱼', '鲸鱼娘', '肥鱼']
      .map((name) => String(name || '').trim())
      .filter(Boolean),
  );
  const names = new Set();
  for (const viewer of state.viewers.values()) {
    const name = String((viewer && viewer.name) || '').replace(/@/g, '').trim();
    if (!name || ownNames.has(name) || isUnsafeNickname(name)) continue;
    if (!isViewerPresent(viewer, state.audience, state.audienceAt, now)) continue;
    names.add(name);
  }
  // 在线名单里还没互动过的观众只有昵称可用，纯数字的当作抖音 ID 跳过
  for (const key of state.audience.keys()) {
    const name = String(key || '').replace(/@/g, '').trim();
    if (!name || name.length > 30 || /^\d+$/.test(name)) continue;
    if (ownNames.has(name) || isUnsafeNickname(name)) continue;
    names.add(name);
  }
  return [...names];
}

function pickAutoSongReceiver(names) {
  const pool = names.filter((name) => name !== state.lastAutoSongReceiver);
  const list = pool.length ? pool : names;
  const name = list[Math.floor(Math.random() * list.length)] || '';
  state.lastAutoSongReceiver = name;
  return name;
}

function autoSongExcludes(songState) {
  return [
    songState && songState.current && songState.current.title,
    ...((songState && songState.queue) || []).map((song) => song && song.title),
  ]
    .map((title) => String(title || '').trim())
    .filter(Boolean);
}

// 调大模型获取正向祝福歌曲；拿到的歌曲全部存进持久化歌曲库，再随机选一首
async function pickAutoSongByAi(songState) {
  let suggestion = null;
  try {
    suggestion = await suggestPositiveSongs({
      ai: state.settings.ai,
      count: 5,
      exclude: autoSongExcludes(songState),
      timeoutMs: 15000,
    });
    if (suggestion.tokens) addTokenUsage(suggestion.tokens);
  } catch (error) {
    log('warn', `自动点歌：大模型获取歌曲失败，改用歌曲库：${error.message}`);
  }
  const songs = (suggestion && suggestion.songs) || [];
  if (!songs.length) return null;
  state.autoSongLibrary = mergeAutoSongLibrary(state.autoSongLibrary, songs, AUTO_SONG_LIBRARY_MAX);
  saveAutoSongLibrary();
  return pickAutoSongFromLibrary(songs, Math.random, autoSongExcludes(songState));
}

// 桌宠选歌：随机整数对 2 取余，0 调大模型，1 优先从持久化歌曲库挑
async function pickAutoSong(songState) {
  const excludes = autoSongExcludes(songState);
  const remainder = Math.floor(Math.random() * 2);
  let picked = null;
  if (remainder === 1) {
    picked = pickAutoSongFromLibrary(state.autoSongLibrary, Math.random, excludes);
  }
  if (!picked) picked = await pickAutoSongByAi(songState);
  if (!picked) picked = pickAutoSongFromLibrary(state.autoSongLibrary, Math.random, excludes);
  return picked;
}

// 提交点歌并校验是否真的进入播放队列
async function submitAutoSong(picked, sender, userKey = 'auto-song') {
  const cfg = state.settings.songRequest || {};
  const query = `${picked.title}${picked.artist ? ` ${picked.artist}` : ''}`;
  const response = await fetch(`${songRequestUrl()}/api/song/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      user: sender,
      userKey,
      provider: 'qq',
      cooldownSec: 0,
      minPlaySec: cfg.minPlaySec,
      queueCutSec: cfg.queueCutSec,
      dailyRecommend: cfg.dailyRecommend !== false,
      priority: false,
    }),
    signal: AbortSignal.timeout(25000),
  });
  const result = await response.json();
  if (!result.ok) return { ok: false, result, error: result.error || '未知错误' };

  const confirmed = await getSongState();
  const songTitle = String((result.song && result.song.title) || picked.title);
  if (!confirmed) {
    log('warn', '桌宠点歌：队列二次校验失败，按点歌接口成功结果继续通知');
    return { ok: true, result, songTitle };
  }
  const queued = Boolean(
    (confirmed.current && confirmed.current.title === songTitle) ||
      (Array.isArray(confirmed.queue) &&
        confirmed.queue.some((item) => item && item.title === songTitle)),
  );
  if (!queued) return { ok: false, result, error: '队列校验未通过' };
  return { ok: true, result, songTitle };
}

// 观众说「帮我点首歌」：桌宠按同一套选歌逻辑挑一首送给该观众
async function handlePetSongHelp(event) {
  const cfg = state.settings.songRequest || {};
  if (!cfg.enabled) return;
  if (state.settings.serviceEnabled === false) return;
  const user = event.user || {};
  const nickname = String(safeNickname(user.nickname, '观众') || '观众')
    .replace(/@/g, '')
    .trim() || '观众';
  const userKey = songUserKey(user);
  const sender = buildAutoSongSender(nickname);
  try {
    const songState = await getSongState();
    const picked = await pickAutoSong({
      current: (songState && songState.current) || null,
      queue: Array.isArray(songState && songState.queue) ? songState.queue : [],
    });
    if (!picked) {
      replySong(`@${nickname}，这次没点上歌，稍后再试试哦`);
      log('warn', `桌宠帮点歌：大模型和歌曲库都没有可用歌曲（@${nickname}）`);
      return;
    }
    const outcome = await submitAutoSong(picked, sender, userKey);
    if (!outcome.ok) {
      replySong(`@${nickname}，这首歌暂时没点上，稍后再试试哦`);
      log('warn', `桌宠帮点歌失败：@${nickname} → ${picked.title}：${outcome.error}`);
      return;
    }
    const song = (outcome.result && outcome.result.song) || picked;
    const record = state.viewers.get(userKey);
    if (record) recordViewerSong(record, song);
    replySong(buildPetSongReply(nickname, song.title));
    speakDsh(AUTO_SONG_VOICE_TEXT, { priority: SPEECH_PRIORITY.song });
    log('info', `桌宠帮点歌：@${nickname} → 《${song.title}》${song.artist || ''}`);
  } catch (error) {
    replySong(`@${nickname}，点歌服务正在启动，稍后再试试哦`);
    log('warn', `桌宠帮点歌：请求失败 ${error.message}`);
  }
}

async function maybeAutoSong() {
  const cfg = state.settings.songRequest || {};
  if (!cfg.enabled) return;
  if (!isLeader || !myRoomKey() || !state.page.tabId) return;
  if (Date.now() - state.lastFrameAt > 45000) return;
  if (state.autoSongBusy) return;
  const now = Date.now();
  if (now - state.lastAutoSongAt < AUTO_SONG_INTERVAL_MS) return;

  const audienceNames = autoSongAudienceNames(now);
  if (!audienceNames.length) return;

  const songState = await getSongState();
  if (!songState || songState.ok === false) return;
  if (
    !autoSongTrigger({
      queueLength: Array.isArray(songState.queue) ? songState.queue.length : 0,
      current: songState.current,
      audienceCount: audienceNames.length,
      now,
      lastAt: state.lastAutoSongAt,
      minIntervalMs: AUTO_SONG_INTERVAL_MS,
    })
  ) {
    return;
  }

  state.autoSongBusy = true;
  const receiver = pickAutoSongReceiver(audienceNames);
  const sender = buildAutoSongSender(receiver);
  try {
    const picked = await pickAutoSong(songState);
    if (!picked) {
      state.lastAutoSongAt = Date.now();
      log('warn', '自动点歌：歌曲库为空且大模型没有返回可用歌曲，本次跳过');
      return;
    }
    const outcome = await submitAutoSong(picked, sender);
    state.lastAutoSongAt = Date.now();
    if (!outcome.ok) {
      log('warn', `自动点歌失败：${sender} → ${picked.title}：${outcome.error}`);
      return;
    }

    const result = outcome.result;
    const record = [...state.viewers.values()].find((viewer) => viewer && viewer.name === receiver);
    if (record) recordViewerSong(record, result.song);
    // 公屏发送格式固定为「大肥鱼点给@xxx」，语音单独通知接收用户
    replySong(sender);
    speakDsh(AUTO_SONG_VOICE_TEXT, { priority: SPEECH_PRIORITY.song });
    log(
      'info',
      `自动点歌：${sender} → 《${(result.song && result.song.title) || picked.title}》${(result.song && result.song.artist) || picked.artist || ''}`,
    );
  } catch (error) {
    state.lastAutoSongAt = Date.now();
    log('warn', `自动点歌：请求失败 ${error.message}`);
  } finally {
    state.autoSongBusy = false;
  }
}

/* ---------------- 自动回复 ---------------- */

function maybeAutoReply(event) {
  const settings = state.settings;
  if (!isLeader) return;
  if (!myRoomKey()) return;
  if (!isMyRoomPage(state.page.url)) return;
  if (!settings.replyEnabled) return;
  if (event.type !== 'chat') return;
  if (!event.content) return;

  const nowMs = Date.now();
  // 进房时抖音会补发历史弹幕，避免对几分钟前的消息自动回复
  if (event.ts && nowMs - event.ts > 20000) return;
  if (!isEligible(event, settings, state.ruleState, nowMs)) return;

  const ai = settings.ai;
  if (ai.enabled && ai.mode === 'always' && event.type === 'chat') {
    // AI 优先模式：评论全部交给 AI，规则仍然处理礼物 / 进场 / 关注 / 点赞
    maybeAiReply(event);
    return;
  }

  const { plans } = planReplies({
    event,
    rules: state.rules,
    state: state.ruleState,
    settings,
    nowMs,
    context: {
      online: state.stats.online ? fmtNumber(state.stats.online) : '',
      cumulative: state.stats.cumulative ? fmtNumber(state.stats.cumulative) : '',
    },
  });

  for (const plan of plans) enqueueReply(plan, state.page.tabId);
  if (plans.length) drainQueue();
  if (!plans.length && ai.enabled && ai.mode === 'fallback') maybeAiReply(event);
}

function enqueueReply(plan, tabId = null, options = {}) {
  const limit = Math.max(1, Number(state.settings.maxQueue) || 20);
  if (state.replyQueue.length >= limit) {
    log('warn', `回复队列已满（${limit} 条），丢弃：${plan.text}`);
    return false;
  }
  state.replyQueue.push({
    ...plan,
    tabId: tabId || null,
    force: Boolean(options.force),
    queuedAt: Date.now(),
  });
  if (
    options.mark !== false &&
    plan.eventId &&
    state.feedEvents.some((event) => String(event.id) === String(plan.eventId))
  ) {
    markReplyStart(plan.eventId, { ruleName: plan.ruleName });
  }
  if (!state.sending) scheduleDrain(0);
  return true;
}

function scheduleDrain(delayMs) {
  if (drainTimer) return;
  drainTimer = setTimeout(() => {
    drainTimer = 0;
    drainQueue();
  }, Math.max(0, Number(delayMs) || 0));
}

async function drainQueue() {
  if (!isLeader || state.sending || !state.replyQueue.length) return;
  const next = state.replyQueue[0];
  if (!state.settings.replyEnabled && !next.force) {
    for (const job of state.replyQueue) {
      if (job.eventId) markReplyDone(job.eventId, false);
    }
    state.replyQueue.length = 0;
    return;
  }

  const job = state.replyQueue.shift();
  state.sending = true;
  try {
    let tabId = job.tabId || null;
    if (tabId && myRoomKey()) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (!tab || roomKeyFromUrl(tab.url) !== myRoomKey()) tabId = null;
      } catch {
        tabId = null;
      }
    }
    if (!tabId) tabId = await resolveTabId();
    if (!tabId) throw new Error('未找到你的直播间页面，请先打开「我的直播」');
    const dryRun = Boolean(state.settings.dryRun);
    const result = await sendToTab(tabId, { type: 'dy-reply', text: job.text, dryRun });

    if (result && result.ok) {
      noteSentText(state.ruleState, job.text);
      state.stats.replied += 1;
      state.recentReplies.push(job.text);
      while (state.recentReplies.length > 10) state.recentReplies.shift();

      const prefix = dryRun ? '[演练] ' : '';
      log('sent', `${prefix}${job.ruleName ? `「${job.ruleName}」` : ''}${job.text}`, result.warning || '');
      if (result.warning) log('warn', result.warning);
      forwardReply(job, result);
      postPet({
        kind: 'reply_sent',
        room: roomInfo(),
        eventId: job.eventId || '',
        text: job.text,
        ruleName: job.ruleName || '',
        dryRun,
        method: result.method || '',
        warning: result.warning || '',
      });
      if (job.eventId) markReplyDone(job.eventId, true);
      schedulePetStatus();
      updateStatsUI();
    } else {
      log('error', `发送失败：${(result && result.error) || '页面未响应'}`);
      if (job.eventId) markReplyDone(job.eventId, false);
    }
  } catch (error) {
    log('error', `发送失败：${error.message}`);
    if (job.eventId) markReplyDone(job.eventId, false);
  } finally {
    state.sending = false;
    if (state.replyQueue.length) {
      const interval = Math.max(600, Number(state.settings.replyCooldownMs) || 0);
      scheduleDrain(interval);
    }
  }
}

async function maybeAiReply(event) {
  if (state.settings.serviceEnabled === false) return;
  const ai = state.settings.ai;
  if (!isLeader || !ai || !ai.enabled || state.aiBusy) return;
  if (event.type !== 'chat' || !event.content) return;
  if (state.replyQueue.length >= Math.max(1, Number(state.settings.maxQueue) || 20)) return;

  if (!ai.apiKey) {
    if (Date.now() - state.lastAiConfigErrorAt > 60000) {
      state.lastAiConfigErrorAt = Date.now();
      log('error', 'AI 已启用但未配置 API Key，请在「设置 → AI 智能回复」里填写');
    }
    return;
  }
  if (isSensitiveCredentialQuery(event.content)) {
    const text = '这个不能告诉你哦～';
    dshBroadcast(text, { force: true, anim: true, duration: 6000 });
    speakDsh(text, { priority: SPEECH_PRIORITY.chat });
    log('warn', `拦截敏感询问：${(event.user && event.user.nickname) || '观众'}`);
    return;
  }

  const tabId = state.page.tabId;
  const nowMs = Date.now();
  if (!isEligible(event, state.settings, state.ruleState, nowMs)) return;

  const aiRule = { id: 'ai-reply', cooldownSec: Math.max(1, Number(ai.cooldownSec) || 5) };
  const userId = (event.user && (event.user.id || event.user.nickname)) || 'anonymous';
  const reason = canSendNow(state.ruleState, state.settings, { rule: aiRule, userId, nowMs });
  if (reason) return;

  state.aiBusy = true;
  reserveSend(state.ruleState, state.settings, { rule: aiRule, userId, nowMs });
  let queued = false;
  markReplyStart(event.id, { ruleName: 'AI' });
  try {
    const history = state.feedEvents
      .filter((item) => item.id !== event.id && item.type === 'chat' && item.content)
      .slice(-5)
      .map((item) => ({
        role: 'user',
        content: `${safeNickname(item.user && item.user.nickname, '观众')}：${item.content}`,
      }));
    const lastReply = state.recentReplies[state.recentReplies.length - 1];
    if (lastReply) history.push({ role: 'assistant', content: lastReply });

    // 只有纯闲聊才分段回复；任务、指令、功能类请求保持单条完整回复
    const casualChat = isCasualChat(event.content);
    const newcomer = Boolean(event.viewerNew);
    // 昵称接梗按概率强触发：新人更容易接梗，避免欢迎语千篇一律
    const riff = casualChat && shouldRiffNickname({ newcomer }, Math.random);
    const viewerFollowed = viewerHasFollowed(event);
    const result = await generateAiReply({
      ai,
      event,
      history,
      maxChars: casualChat ? SEGMENT_LIMITS.maxTotalChars : state.settings.maxReplyChars,
      casual: casualChat,
      context: {
        online: state.stats.online,
        rice: state.stats.rice,
        tokens: state.stats.tokens,
        likes: state.stats.likes,
        cumulative: state.stats.cumulative,
        memory: state.aiMemory,
        followed: viewerFollowed,
        newcomer: casualChat && newcomer,
        riff,
      },
    });

    if (result.usedFallback) {
      log('info', `AI 主服务不可用，已切换到 ${result.provider}`);
    }
    addTokenUsage(result.tokens);

    lastDshAiAt = Date.now();
    clearTimeout(dshChatTimer);
    dshChatTimer = 0;

    // 已关注观众：大模型仍可能无视提示劝关注，这里强制剔除这类分句
    let replyText = viewerFollowed ? stripFollowAsk(result.text) : result.text;
    if (!replyText) replyText = viewerFollowed ? '谢谢你的支持，陪你多聊几句呀～' : result.text;
    const segments = casualChat ? splitReplySegments(replyText) : [];
    const replies = segments.length ? segments : [replyText];
    if (replies.length > 1) {
      log('info', `AI 闲聊分段回复 ${replies.length} 条：${replies.join(' / ')}`);
    }
    const segmentGapMs = Math.max(900, Number(state.settings.replyCooldownMs) || 0);

    replies.forEach((text, index) => {
      const isFirst = index === 0;
      const deliver = () => {
        if (!isLeader) return;
        dshBroadcast(text, { force: true, anim: true, duration: 10000 });
        speakDsh(text, { priority: SPEECH_PRIORITY.chat });
        postPet({
          kind: 'ai_reply',
          room: roomInfo(),
          eventId: isFirst ? event.id || '' : '',
          text,
          provider: result.provider,
          ruleName: `AI · ${result.provider}`,
          dryRun: Boolean(state.settings.dryRun),
          user: event.user || null,
          segment: replies.length > 1 ? `${index + 1}/${replies.length}` : '',
        });
      };
      if (isFirst) deliver();
      else setTimeout(deliver, index * segmentGapMs);

      const queuedOk = enqueueReply(
        {
          ruleId: 'ai-reply',
          ruleName: `AI · ${result.provider}`,
          text,
          userId,
          eventId: isFirst ? event.id : '',
          scope: 'chat',
          ts: Date.now(),
        },
        tabId,
        { mark: false },
      );
      if (queuedOk) queued = true;
    });
    drainQueue();
  } catch (error) {
    if (Date.now() - state.lastAiErrorAt > 15000) {
      state.lastAiErrorAt = Date.now();
      log('error', `AI 回复失败：${error.message}`);
    }
  } finally {
    if (!queued) markReplyDone(event.id, false);
    state.aiBusy = false;
  }
}

/* ---------------- DSH 桌宠（dsh-pet 插件） ---------------- */

function dshConnectionKey(settings = state.settings) {
  const cfg = settings.dshPet || {};
  return JSON.stringify({
    enabled: Boolean(cfg.enabled),
    baseUrl: cfg.baseUrl || '',
    petId: cfg.petId || '',
    surface: cfg.surface || '',
    menu: cfg.menu !== false,
    idleAnimEnabled: cfg.idleAnimEnabled !== false,
    idleAnimMinSec: Number(cfg.idleAnimMinSec) || 20,
    idleAnimMaxSec: Number(cfg.idleAnimMaxSec) || 40,
  });
}

function dshMenuLabels() {
  const settings = state.settings;
  return [
    `自动回复：${settings.replyEnabled ? '开' : '关'}`,
    `演练模式：${settings.dryRun ? '开' : '关'}`,
    `AI 回复：${settings.ai.enabled ? '开' : '关'}`,
    `弹幕播报：${settings.dshPet.chatBubble ? '开' : '关'}`,
    `暖场：${settings.warmup.enabled ? '开' : '关'}`,
    `语音：${settings.dshPet.tts ? '开' : '关'}`,
    '测试气泡',
  ];
}

function refreshDshUI() {
  try {
    window.dispatchEvent(new CustomEvent('dy-dsh-pet-state', { detail: { ...state.dsh } }));
  } catch {
    /* ignore */
  }
}

/**
 * DSH 重启后本地端口会换，旧地址必然 Failed to fetch。
 * 失败时问一次本地桥接：找到新端口就回写设置，连接会自动按新地址重建。
 */
async function discoverDshPetPort(error) {
  const cfg = state.settings.dshPet || {};
  if (!cfg.enabled || dshDiscoverRunning) return;
  if (Date.now() - dshDiscoverAt < DSH_DISCOVER_INTERVAL_MS) return;
  dshDiscoverAt = Date.now();
  dshDiscoverRunning = true;
  try {
    const found = await discoverDshPetBaseUrl(boardUrl(), { hint: cfg.baseUrl || '' });
    const current = String(cfg.baseUrl || '').trim().replace(/\/+$/, '');
    if (!found || found === current) return;
    log('info', `DSH 桌宠端口变了，已自动切换到 ${found}（原地址 ${current || '未设置'}，失败原因：${error}）`);
    await applySettings({ dshPet: { ...state.settings.dshPet, baseUrl: found } });
  } catch {
    /* 本地桥接没运行或没找到 DSH：保持现状，等下次失败再试 */
  } finally {
    dshDiscoverRunning = false;
  }
}

function setupDshPet() {
  const cfg = state.settings.dshPet || {};
  if (dshPet) {
    // 切换配置时不要清空菜单，否则旧客户端的 DELETE 可能把新客户端的注册删掉
    dshPet.stop({ clearMenu: !cfg.enabled });
    dshPet = null;
  }
  clearTimeout(dshChatTimer);
  dshChatTimer = 0;
  clearIdleAnim();
  state.dsh = {
    enabled: Boolean(cfg.enabled),
    ok: false,
    error: '',
    pets: [],
    petId: cfg.petId || 'main',
  };

  if (!cfg.enabled) {
    stopMiniMaxTts();
    refreshDshUI();
    return;
  }

  dshPet = new DshPetClient({
    baseUrl: cfg.baseUrl,
    petId: cfg.petId,
    surface: cfg.surface,
    getMenuLabels: dshMenuLabels,
    onMenu: handleDshMenu,
    onStatus: (info) => {
      if (info.ok) {
        state.dsh.ok = true;
        state.dsh.error = '';
      } else {
        state.dsh.ok = false;
        state.dsh.error = info.error || '连接失败';
        if (Date.now() - dshErrorAt > 15000) {
          dshErrorAt = Date.now();
          log('warn', `DSH 桌宠连接失败：${state.dsh.error}`);
        }
        discoverDshPetPort(state.dsh.error);
      }
      refreshDshUI();
    },
  });

  if (cfg.menu) dshPet.start();

  dshPet
    .listPets()
    .then((pets) => {
      state.dsh.pets = pets;
      if (pets.length && !pets.some((pet) => pet.id === dshPet.petId)) {
        dshPet.petId = pets[0].id;
        state.dsh.petId = pets[0].id;
      }
      state.dsh.ok = true;
      state.dsh.error = '';
      refreshDshUI();
      updateDshMenu();
      scheduleIdleAnim();
    })
    .catch((error) => {
      state.dsh.ok = false;
      state.dsh.error = error.message;
      refreshDshUI();
      if (Date.now() - dshErrorAt > 15000) {
        dshErrorAt = Date.now();
        log('warn', `DSH 桌宠连接失败：${error.message}`);
      }
      discoverDshPetPort(error.message);
    });

  refreshDshUI();
}

function updateDshMenu() {
  if (!dshPet || !state.settings.dshPet.enabled || !state.settings.dshPet.menu) return;
  dshPet
    .registerMenu(dshMenuLabels())
    .then(() => {
      state.dsh.ok = true;
      state.dsh.error = '';
      refreshDshUI();
    })
    .catch((error) => {
      state.dsh.ok = false;
      state.dsh.error = error.message;
      refreshDshUI();
    });
}

function scheduleDshMenu() {
  if (dshMenuTimer) return;
  dshMenuTimer = setTimeout(() => {
    dshMenuTimer = 0;
    updateDshMenu();
  }, 300);
}

async function handleDshMenu(label, petId) {
  if (!isLeader) return;
  const text = String(label || '');
  let message = '';
  if (text.startsWith('自动回复')) {
    const enabled = !state.settings.replyEnabled;
    await applySettings({ replyEnabled: enabled });
    message = `自动回复已${enabled ? '开启' : '关闭'}`;
  } else if (text.startsWith('演练模式')) {
    const enabled = !state.settings.dryRun;
    await applySettings({ dryRun: enabled });
    message = enabled ? '演练模式已开启' : '演练模式已关闭，会真实发送';
  } else if (text.startsWith('AI 回复')) {
    const enabled = !state.settings.ai.enabled;
    await applySettings({ ai: { ...state.settings.ai, enabled } });
    message = `AI 回复已${enabled ? '开启' : '关闭'}`;
  } else if (text.startsWith('弹幕播报')) {
    const enabled = !state.settings.dshPet.chatBubble;
    await applySettings({ dshPet: { ...state.settings.dshPet, chatBubble: enabled } });
    message = `弹幕播报已${enabled ? '开启' : '关闭'}`;
  } else if (text.startsWith('暖场')) {
    const enabled = !state.settings.warmup.enabled;
    await applySettings({ warmup: { ...state.settings.warmup, enabled } });
    message = `自动暖场已${enabled ? '开启' : '关闭'}`;
  } else if (text.startsWith('语音')) {
    const enabled = !state.settings.dshPet.tts;
    await applySettings({ dshPet: { ...state.settings.dshPet, tts: enabled } });
    message = `语音朗读已${enabled ? '开启' : '关闭'}`;
  } else if (text === '测试气泡') {
    await dshBroadcast('桌宠联动正常，弹幕、礼物和 AI 回复都会出现在这里～', {
      force: true,
      anim: true,
      duration: 8000,
      petId,
    });
    message = '测试气泡已发送';
  }
  if (message) {
    await dshBroadcast(message, { force: true, anim: false, duration: 4000, petId });
    scheduleDshMenu();
  }
}

async function dshBroadcast(text, options = {}) {
  if (!isLeader || !dshPet || !state.settings.dshPet.enabled) return;
  const content = String(text || '').trim();
  if (!content) return;
  if (!options.force && Date.now() - lastDshBubbleAt < 900) return;
  lastDshBubbleAt = Date.now();
  try {
    await dshPet.broadcast(content, {
      petId: options.petId,
      duration: options.duration,
      // 动作玩法播放中，附带动画的气泡一律改纯气泡，避免打断
      anim: options.anim ? !dshActionPlaying() : false,
    });
  } catch (error) {
    if (Date.now() - dshErrorAt > 15000) {
      dshErrorAt = Date.now();
      log('warn', `桌宠气泡发送失败：${error.message}`);
    }
  }
}

function dshAnim(name, petId, opts = {}) {
  if (!isLeader || !dshPet || !state.settings.dshPet.enabled || !name) return;
  // 观众点播的动作玩法播放中，其他自动动画不再打断（玩法自身用 force 豁免）
  if (!opts.force && dshActionPlaying()) return;
  dshPet.anim(name, { petId }).catch(() => {});
}

function clearDshCombo() {
  if (!dshComboTimers.length) return;
  for (const timer of dshComboTimers) clearTimeout(timer);
  dshComboTimers = [];
}

// 组合动作：按 stepMs 依次播放解析出的动画，整段期间占住动作保护窗口
function playPetCombo(combo, steps, nickname) {
  clearDshCombo();
  const stepMs = Math.max(2500, Math.min(8000, Number(combo.stepMs) || 5000));
  dshActionBusyUntil = Date.now() + (steps.length - 1) * stepMs + 3000;
  dshAnim(steps[0], null, { force: true });
  steps.slice(1).forEach((name, index) => {
    dshComboTimers.push(
      setTimeout(() => {
        if (!isLeader || !dshPet || !state.settings.dshPet.enabled) return;
        dshAnim(name, null, { force: true });
      }, (index + 1) * stepMs),
    );
  });
  speakDsh(petComboSpeech(combo, nickname), { priority: SPEECH_PRIORITY.chat });
  log('info', `组合动作：${nickname || '观众'}「${combo.label}」→ ${steps.join(' → ')}`);
}

function clearIdleAnim() {
  if (idleAnimTimer) {
    clearTimeout(idleAnimTimer);
    idleAnimTimer = 0;
  }
}

function idleAnimationPool() {
  const animations = (dshPet && dshPet.animations) || {};
  const names = [];
  for (const key of ['clicks', 'idle', 'turn']) {
    if (Array.isArray(animations[key])) names.push(...animations[key]);
  }
  for (const category of animations.categories || []) {
    if (Array.isArray(category.actions)) names.push(...category.actions);
  }
  return [...new Set(names.filter((name) => typeof name === 'string' && name.trim()))].filter(
    (name) => !/待机呼吸/.test(name),
  );
}

function canIdleAnim() {
  const cfg = state.settings.dshPet || {};
  if (!isLeader || !dshPet || !cfg.enabled || !cfg.idleAnimEnabled) return false;
  if (state.aiBusy || state.sending || state.warmupBusy || state.replyQueue.length) return false;
  if (dshChatTimer) return false;
  const now = Date.now();
  if (now - lastDshAiAt < 8000) return false;
  if (now - lastDshBubbleAt < 8000) return false;
  return true;
}

function scheduleIdleAnim() {
  clearIdleAnim();
  const cfg = state.settings.dshPet || {};
  if (!dshPet || !cfg.enabled || !cfg.idleAnimEnabled) return;
  const min = Math.max(5, Math.min(600, Number(cfg.idleAnimMinSec) || 20));
  const max = Math.max(min, Math.min(900, Number(cfg.idleAnimMaxSec) || 40));
  const delay = (min + Math.random() * (max - min)) * 1000;
  idleAnimTimer = setTimeout(() => {
    idleAnimTimer = 0;
    if (canIdleAnim()) {
      const pool = idleAnimationPool();
      if (pool.length) {
        const candidates = pool.length > 1 ? pool.filter((name) => name !== lastIdleAnimName) : pool;
        const name = candidates[Math.floor(Math.random() * candidates.length)];
        lastIdleAnimName = name;
        dshAnim(name);
        speakDsh(petIdleSpeech(name), { priority: SPEECH_PRIORITY.welcome });
      }
    }
    scheduleIdleAnim();
  }, delay);
}

/* ---------------- 语音队列：按优先级排队，播放中的语音不被打断 ---------------- */
// 优先级从高到低：1 送礼感谢 > 2 记忆回复 > 3 点歌结果 > 4 闲聊 > 5 进场欢迎/暖场
const speechQueue = [];
let speechBusy = false;
let speechCurrentPriority = 0;
let speechProtected = false;
let speechGeneration = 0;

function queueSpeech(text, options = {}) {
  const content = String(text || '').replace(/@/g, '').slice(0, 120);
  if (!content) return;
  const priority = normalizeSpeechPriority(options.priority);
  const item = { text: content, priority, protected: priority === SPEECH_PRIORITY.memory };
  if (!speechBusy) {
    runSpeech(item);
    return;
  }
  // 送礼、记忆、点歌结果可以打断闲聊/欢迎；记忆和送礼播放中不被覆盖
  if (shouldInterrupt(priority, speechCurrentPriority, speechProtected)) {
    interruptSpeech();
    runSpeech(item);
    return;
  }
  insertByPriority(speechQueue, item);
}

function interruptSpeech() {
  speechGeneration += 1; // 让被打断那条的结束回调失效，避免它继续推进队列
  speechBusy = false;
  speechCurrentPriority = 0;
  speechProtected = false;
  stopMiniMaxTts();
}

function runSpeech(item) {
  const generation = ++speechGeneration;
  speechBusy = true;
  speechCurrentPriority = item.priority;
  speechProtected = Boolean(item.protected);
  const finish = () => {
    if (generation !== speechGeneration) return;
    speechBusy = false;
    speechCurrentPriority = 0;
    speechProtected = false;
    const next = speechQueue.shift();
    if (next) runSpeech(next);
  };
  speakMiniMax(item.text, state.settings, {
    fallbackToBrowser: Boolean(state.settings.tts.fallbackBrowser),
  })
    .then((result) => {
      if (generation !== speechGeneration) return;
      if (result && result.provider === 'browser') {
        log('warn', 'MiniMax 语音失败，已回退浏览器机械音；请检查 TTS 设置');
      }
      if (result && result.done) result.done.then(finish, finish);
      else finish();
    })
    .catch((error) => {
      if (generation !== speechGeneration) return;
      if (Date.now() - state.lastTtsErrorAt > 15000) {
        state.lastTtsErrorAt = Date.now();
        log('warn', `MiniMax 语音失败：${error.message}`);
      }
      finish();
    });
}

function speakDsh(text, options = {}) {
  if (!isLeader || !state.settings.dshPet.enabled || !state.settings.dshPet.tts) return;
  // 语音不念 @：直接删除 @ 符号（昵称含中文，不能用 \w 匹配）
  queueSpeech(text, options);
}

function speakProtected(text) {
  speakDsh(text, { priority: SPEECH_PRIORITY.memory });
}

async function testTts(ttsOverride) {
  const settings = ttsOverride
    ? mergeSettings({ ...state.settings, tts: { ...state.settings.tts, ...ttsOverride } })
    : state.settings;
  try {
    const result = await speakMiniMax(
      '主人你好呀，我是你的桌宠小女仆，今天也要一起开开心心直播哦～',
      settings,
      { fallbackToBrowser: false },
    );
    return { ok: true, provider: result.provider, mode: result.mode || '' };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function handleDshActionCommand(event) {
  const cfg = state.settings.dshPet || {};
  if (!isLeader || !dshPet || !cfg.enabled || cfg.actionCommands === false) return false;
  if (!event || event.type !== 'chat' || isOwnEvent(event)) return false;
  const keyword = parsePetActionCommand(event.content);
  if (!keyword) return false;
  if (Date.now() - lastDshActionAt < 1200) return true;
  lastDshActionAt = Date.now();

  const nickname = safeNickname((event.user && event.user.nickname) || '观众');
  // 组合动作优先：一套连招按步骤依次播完，期间占住动作保护窗口
  const combo = matchPetCombo(keyword);
  if (combo) {
    const steps = resolvePetComboSteps(combo, dshPet.animations);
    if (!steps.length) return false;
    playPetCombo(combo, steps, nickname);
    return true;
  }
  clearDshCombo();

  const pool = petActionPool(dshPet.animations);
  if (!pool.length) return false;
  let name = resolvePetAction(keyword, dshPet.animations);
  const matched = Boolean(name);
  if (!name) {
    const candidates = pool.length > 1 ? pool.filter((item) => item !== lastDshActionName) : pool;
    name = candidates[Math.floor(Math.random() * candidates.length)];
  }
  // 「token回」类口令固定执行 token来 动画，并回「token来！token来！」
  const tokenBack = isTokenBackKeyword(keyword);
  if (tokenBack) name = resolvePetAction('token来', dshPet.animations) || name;
  lastDshActionName = name;
  dshAnim(name, null, { force: true });
  dshActionBusyUntil = Date.now() + 15000; // 玩法动画播放期间（约 15 秒）其他动画让路
  const text = tokenBack ? TOKEN_BACK_REPLY : petActionSpeech(keyword, name, nickname);
  if (tokenBack) dshBroadcast(text, { force: true, anim: false, duration: 6000 });
  speakDsh(text, { priority: SPEECH_PRIORITY.chat });
  log('info', `动作指令：${nickname}「${keyword}」→ ${name}${matched ? '' : '（未精确匹配，随机播放）'}${tokenBack ? '（token回）' : ''}`);
  return true;
}

function handleDshLikeThanks(event) {
  if (state.settings.serviceEnabled === false) return;
  const cfg = state.settings.dshPet || {};
  if (!isLeader || !dshPet || !cfg.enabled || cfg.likeThanks === false) return;
  if (isOwnEvent(event)) return;
  const count = Number(event.like && event.like.count) || 0;
  if (count <= 0) return;
  if (Date.now() - lastDshLikeAt < LIKE_THANKS_MS) return;
  lastDshLikeAt = Date.now();
  const nickname = (event.user && event.user.nickname) || '';
  const total = Number(event.like && event.like.total) || 0;
  const who = safeNickname(nickname, '');
  const text = who
    ? `谢谢 @${who} 的点赞${count > 1 ? ` ×${count}` : ''}！${total ? `已经 ${fmtNumber(total)} 赞啦～` : ''}`
    : `谢谢这位朋友的点赞${count > 1 ? ` ×${count}` : ''}！${total ? `已经 ${fmtNumber(total)} 赞啦～` : ''}`;
  dshBroadcast(text, { force: true, anim: true, duration: 6000 });
  dshAnim('点击回应-开心跃动');
  speakDsh(text, { priority: SPEECH_PRIORITY.gift });
  log('info', `点赞感谢：${who || '这位朋友'} +${count}${total ? `（总 ${total}）` : ''}`);
}

function handleDshEvent(event) {
  if (state.settings.serviceEnabled === false) return;
  const cfg = state.settings.dshPet || {};
  if (!isLeader || !cfg.enabled || !dshPet) return;

  if (event.type === 'chat') {
    if (!cfg.chatBubble || !event.content) return;
    const interval = Math.max(0, Number(cfg.chatBubbleIntervalSec) || 0) * 1000;
    if (interval > 0 && Date.now() - lastDshChatAt < interval) return;
    if (dshChatTimer) return;
    dshChatTimer = setTimeout(() => {
      dshChatTimer = 0;
      if (!state.settings.dshPet.enabled) return;
      if (Date.now() - lastDshAiAt < 4000) return; // AI 马上会回复，不抢气泡
      if (Date.now() - lastDshBubbleAt < 4000) return; // 刚发过礼物/关注气泡，不覆盖
      lastDshChatAt = Date.now();
      const nickname = (event.user && event.user.nickname) || '观众';
      dshBroadcast(`${safeNickname(nickname, '这位朋友')}：${event.content}`, {
        duration: 6000,
        anim: false,
      });
    }, 2200);
    return;
  }

  if (event.type === 'gift') {
    if (event.canReply === false) return;
    const nickname = (event.user && event.user.nickname) || '观众';
    const count = Number(event.gift && event.gift.count) || 1;
    const display = safeNickname(nickname, '');
    const text = display
      ? `谢谢 @${display} 的白饭${count > 1 ? ` ×${count}` : ''}！`
      : `谢谢这位朋友的白饭${count > 1 ? ` ×${count}` : ''}！`;
    dshBroadcast(text, {
      force: true,
      anim: true,
      duration: 8000,
    });
    // 收到礼物 → 表演吃白饭：优先精确含「白饭」的动画，其次按吃类解析，最后回退开心跃动
    const pool = petActionPool(dshPet.animations);
    dshAnim(
      pool.find((name) => name.includes('白饭')) ||
        resolvePetAction('吃白饭', dshPet.animations) ||
        '点击回应-开心跃动'
    );
    speakDsh(text, { priority: SPEECH_PRIORITY.gift });
    return;
  }

  if (event.type === 'follow') {
    const nickname = (event.user && event.user.nickname) || '你';
    const display = safeNickname(nickname, '');
    const text = display ? `谢谢 @${display} 的关注！` : '谢谢这位朋友的关注！';
    dshBroadcast(text, { force: true, anim: true, duration: 8000 });
    dshAnim('点击回应-元气挥手');
    speakDsh(text, { priority: SPEECH_PRIORITY.gift });
    return;
  }

  if (event.type === 'member') {
    if (Date.now() - lastDshMemberAt < 8000) return;
    const nickname = (event.user && event.user.nickname) || '新朋友';
    // 不良昵称（脏话/色情/政治敏感等）：不欢迎、不朗读，普通玩梗昵称不受影响
    if (isUnsafeNickname(nickname)) {
      log('info', '进场欢迎已跳过：昵称含不良内容');
      return;
    }
    lastDshMemberAt = Date.now();
    const userKey = String((event.user && (event.user.id || event.user.nickname)) || nickname);
    // 检索顺序：单场有记录 → 本地记住的观众 → 跨直播记忆里的重要观众
    const returning =
      hasViewerMemory(state.viewers.get(userKey)) ||
      state.knownViewers.has(userKey) ||
      Boolean(findCrossViewer(event.user));
    const text = returning
      ? `@${nickname}，你又来看鲸鱼娘啦！我记得你哦！`
      : `@${nickname} 欢迎来到直播间～`;
    dshBroadcast(text, { anim: true, duration: 6000 });
    dshAnim('点击回应-元气挥手');
    speakDsh(text, { priority: SPEECH_PRIORITY.welcome });
  }
}

async function testDshPet(options = {}) {
  const cfg = { ...(state.settings.dshPet || {}), ...options };
  const client = new DshPetClient({
    baseUrl: cfg.baseUrl,
    petId: cfg.petId,
    surface: cfg.surface,
  });
  try {
    const pets = await client.listPets();
    const petId = pets.some((pet) => pet.id === cfg.petId) ? cfg.petId : pets[0] && pets[0].id;
    if (!petId) throw new Error('没有可用的桌宠');
    await client.broadcast('直播助手已连接，桌宠联动测试成功', {
      petId,
      duration: 8000,
      anim: true,
    });
    return { ok: true, pets, petId };
  } catch (error) {
    return { ok: false, pets: [], error: error.message };
  }
}

async function listDshPets(baseUrl) {
  const cfg = state.settings.dshPet || {};
  const client = new DshPetClient({ baseUrl: baseUrl || cfg.baseUrl, petId: cfg.petId });
  try {
    const pets = await client.listPets();
    return { ok: true, pets };
  } catch (error) {
    return { ok: false, pets: [], error: error.message };
  }
}

/* ---------------- 暖场 ---------------- */

let viewerHistoryTimer = 0;

/** 跨直播记住有记录的观众，用于进场时的「你又来看鲸鱼娘啦」。 */
function roomScopeKey() {
  return myRoomKey() || 'default';
}

async function loadViewerHistory() {
  try {
    const stored = await chrome.storage.local.get(VIEWER_HISTORY_KEY);
    const all = (stored && stored[VIEWER_HISTORY_KEY]) || {};
    const room = all[roomScopeKey()] || {};
    state.knownViewers.clear();
    for (const item of Array.isArray(room.users) ? room.users : []) {
      if (!item || !item.key) continue;
      state.knownViewers.set(String(item.key), {
        name: String(item.name || ''),
        lastSeen: Number(item.lastSeen) || 0,
        followedAt: Number(item.followedAt) || 0,
      });
    }
  } catch {
    /* 读取失败不影响直播 */
  }
}

function scheduleViewerHistorySave() {
  if (viewerHistoryTimer) clearTimeout(viewerHistoryTimer);
  viewerHistoryTimer = setTimeout(() => {
    viewerHistoryTimer = 0;
    saveViewerHistory();
  }, 1500);
}

function saveViewerHistory() {
  const room = roomScopeKey();
  const merged = new Map();
  for (const [key, item] of state.knownViewers) {
    merged.set(key, {
      key,
      name: (item && item.name) || '',
      lastSeen: Number(item && item.lastSeen) || 0,
      followedAt: Number(item && item.followedAt) || 0,
    });
  }
  for (const [key, record] of state.viewers) {
    if (!hasViewerMemory(record)) continue;
    const prev = merged.get(key) || {};
    merged.set(key, {
      key,
      name: record.name || prev.name || '',
      lastSeen: record.lastSeen || prev.lastSeen || Date.now(),
      followedAt: Number(record.followedAt) || Number(prev.followedAt) || 0,
    });
  }
  const users = [...merged.values()]
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, MAX_KNOWN_VIEWERS);
  chrome.storage.local
    .get(VIEWER_HISTORY_KEY)
    .then((stored) => {
      const all = (stored && stored[VIEWER_HISTORY_KEY]) || {};
      all[room] = { users, updatedAt: Date.now() };
      return chrome.storage.local.set({ [VIEWER_HISTORY_KEY]: all });
    })
    .catch(() => {});
}

function rememberViewer(event) {
  if (!event || !['chat', 'member', 'gift', 'follow', 'like'].includes(event.type)) return;
  if (isOwnEvent(event)) return;
  const user = event.user || {};
  const name = String(user.nickname || '').trim();
  if (!name) return;
  if (state.settings.myNickname && name.toLowerCase() === String(state.settings.myNickname).toLowerCase()) {
    return;
  }
  if (state.settings.myUserId && String(user.id || '') === String(state.settings.myUserId)) return;
  if ((state.settings.blockedUsers || []).some((item) => String(item) === name || String(item) === String(user.id || ''))) {
    return;
  }
  const key = String(user.id || name);
  const now = Date.now();
  // 本场、本地历史、跨直播记忆都没有记录 → 第一次出现在直播间，AI 回复里更容易触发昵称接梗欢迎
  event.viewerNew = !state.viewers.has(key) && !state.knownViewers.has(key) && !findCrossViewer(user);
  const record = state.viewers.get(key) || {
    key,
    name,
    id: String(user.id || ''),
    firstSeen: now,
    lastSeen: now,
    chats: [],
    gifts: [],
    songs: [],
    followedAt: 0,
    likes: 0,
    likedAt: 0,
  };
  record.name = name;
  record.lastSeen = now;
  // 抖音用户数据自带关注关系时，第一次识别就记一笔，方便核对是谁被判定为已关注
  const followedByPayload = !Number(record.followedAt) && userFollowedAnchor(user);
  recordViewerEvent(record, event, now);
  if (followedByPayload) log('info', `识别到已关注观众：${safeNickname(name, '观众')}（来源：抖音用户数据）`);
  // 只记录有发言/送礼/点歌/关注/点赞的观众；单纯进场不进入单场记忆
  if (!hasViewerMemory(record)) return;
  // 扩展重载后单场记忆会清空，关注状态从本地观众历史里恢复
  const known = state.knownViewers.get(key);
  if (!record.followedAt && known && Number(known.followedAt)) record.followedAt = Number(known.followedAt);
  state.viewers.set(key, record);
  state.knownViewers.set(key, {
    name,
    lastSeen: now,
    followedAt: Number(record.followedAt) || Number(known && known.followedAt) || 0,
  });
  scheduleViewerHistorySave();
  while (state.viewers.size > 100) state.viewers.delete(state.viewers.keys().next().value);
}

function pickWarmupViewer() {
  const now = Date.now();
  // 只跟当前还在直播间的人打招呼：优先用抖音在线观众名单，名单不可用时看最近互动
  const list = [...state.viewers.values()].filter(
    (viewer) => !isUnsafeNickname(viewer.name) && isViewerPresent(viewer, state.audience, state.audienceAt, now),
  );
  if (!list.length) return null;
  let candidates = list.filter((viewer) => viewer.name !== state.lastWarmupViewer);
  if (!candidates.length) candidates = list;
  const viewer = candidates[Math.floor(Math.random() * candidates.length)];
  state.lastWarmupViewer = viewer.name;
  return viewer;
}

function maybeWarmup(now) {
  if (state.settings.serviceEnabled === false) return;
  if (now - state.lastWarmupCheck < 5000) return;
  state.lastWarmupCheck = now;

  const cfg = state.settings.warmup;
  if (!cfg || !cfg.enabled) return;
  if (!state.settings.replyEnabled) return;
  if (!isLeader || !myRoomKey() || !state.page.tabId) return;
  if (now - state.lastFrameAt > 45000) return;
  if (state.warmupBusy || state.sending || state.aiBusy || state.replyQueue.length) return;

  const trigger = warmupTrigger({
    config: cfg,
    online: state.stats.online,
    now,
    lastChatAt: state.lastChatAt,
    lastWarmupAt: state.lastWarmupAt,
    warmupTimes: state.warmupTimes,
  });
  if (!trigger) return;
  triggerWarmup(false, trigger).catch(() => {});
}

async function warmupNow() {
  return triggerWarmup(true, { reason: 'manual' });
}

async function triggerWarmup(manual, trigger = {}) {
  if (state.settings.serviceEnabled === false) return { ok: false, error: '服务总开关已关闭' };
  if (state.warmupBusy) return { ok: false, error: '正在生成暖场内容' };
  if (!myRoomKey()) return { ok: false, error: '请先绑定我的直播间' };

  const cfg = state.settings.warmup;
  if (!manual && (!cfg || !cfg.enabled)) return { ok: false, error: '未启用自动暖场' };

  state.warmupBusy = true;
  try {
    const viewer = cfg.greetViewer === false ? null : pickWarmupViewer();
    const viewerName = viewer ? viewer.name : '';
    const viewerFollowed = viewerRecordHasFollowed(viewer);
    const preset = pickWarmupPresetInfo(cfg.presets, state.recentWarmups, Math.random, viewerName, viewerFollowed);
    const presetText = preset.text;
    const presetChance = Math.max(
      0,
      Math.min(100, Number.isFinite(Number(cfg.presetChance)) ? Number(cfg.presetChance) : 30),
    );
    let allowViewerPrefix = true;
    let text = presetText && Math.random() * 100 < presetChance ? presetText : '';
    if (text) allowViewerPrefix = false;
    if (!text && state.settings.ai.enabled) {
      const recentChats = state.feedEvents
        .filter((event) => event.type === 'chat' && event.content)
        .slice(-5)
        .map((event) => `${safeNickname(event.user && event.user.nickname, '观众')}：${event.content}`);
      try {
        const result = await generateWarmupReply({
          ai: state.settings.ai,
          context: {
            online: state.stats.online,
            idleSec: Math.round((Date.now() - state.lastChatAt) / 1000),
            recentChats,
            recentWarmups: state.recentWarmups,
            roomTitle: state.page.title,
            viewer: viewerName,
            viewerFollowed,
            prompt: cfg.prompt,
          },
          maxChars: 80,
        });
        text = result.text;
        // 大模型可能无视提示继续劝关注：已关注的观众强制剔除这类分句
        if (viewerFollowed) text = stripFollowAsk(text);
        addTokenUsage(result.tokens);
      } catch (error) {
        log('warn', `AI 暖场失败，改用预设 / 内置文案：${error.message}`);
      }
    }
    if (!text && presetText) {
      text = presetText;
      allowViewerPrefix = false;
    }
    if (!text) text = pickWarmupLine(state.recentWarmups, Math.random, viewerName, viewerFollowed);
    // 最终兜底：已关注观众收到的暖场文案里不能再有任何引导关注
    if (viewerFollowed && isFollowAsk(text)) {
      text = stripFollowAsk(text);
      if (!text) text = pickWarmupLine([], Math.random, '', true);
    }
    if (viewerName && allowViewerPrefix && !text.includes(viewerName)) text = `${viewerName}，${text}`;
    text = Array.from(String(text).replace(/\s+/g, ' ').trim()).slice(0, 80).join('');
    if (!text) return { ok: false, error: '暖场文案为空' };

    const now = Date.now();
    state.lastWarmupAt = now;
    state.warmupTimes.push(now);
    state.warmupTimes = state.warmupTimes.filter((ts) => now - ts < 3600000);
    state.recentWarmups.push(text);
    while (state.recentWarmups.length > 10) state.recentWarmups.shift();

    // 暖场说到「token来」时，桌宠同步播放 token 汇聚动画，气泡不再附带随机动画
    const tokenMoment = isTokenWarmup(text);
    if (cfg.bubble && state.settings.dshPet.enabled) {
      dshBroadcast(text, { force: true, anim: !tokenMoment, duration: 10000 });
    }
    if (tokenMoment && state.settings.dshPet.enabled) {
      dshAnim('token来', null, { force: true });
      dshActionBusyUntil = Date.now() + 11000;
    }
    postPet({ kind: 'ai_reply', room: roomInfo(), text, provider: '暖场' });
    if (cfg.speak) queueSpeech(text, { priority: SPEECH_PRIORITY.welcome });
    if (cfg.sendToChat) sendWarmupChat(text);

    const reasonText = trigger.reason === 'low-viewers' ? '（人少）' : manual ? '（手动）' : '';
    log('info', `暖场${reasonText}${viewerName ? `（观众：${viewerName}）` : ''}：${text}`);
    return { ok: true, text };
  } finally {
    state.warmupBusy = false;
  }
}

function sendWarmupChat(text) {
  const limit = Math.max(1, Number(state.settings.maxQueue) || 20);
  if (state.replyQueue.length >= limit) {
    log('warn', '回复队列已满，暖场消息未发送');
    return;
  }
  enqueueReply(
    {
      ruleId: 'warmup',
      ruleName: '暖场',
      text,
      userId: 'warmup',
      eventId: `warmup-${Date.now()}`,
      scope: 'chat',
      ts: Date.now(),
    },
    state.page.tabId,
    { force: true },
  );
  drainQueue();
}

/* ---------------- 事件转发 ---------------- */

function webhookUrl() {
  const url = String(state.settings.webhookUrl || '').trim();
  if (!state.settings.forwardEvents || !/^https?:\/\//i.test(url)) return '';
  return url;
}

function postWebhook(payload) {
  const url = webhookUrl();
  if (!url) return;
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => {});
}

function forwardEvent(event) {
  postWebhook({
    source: 'dy-live-companion',
    kind: 'event',
    at: Date.now(),
    room: { roomId: state.page.roomId, title: state.page.title, url: state.page.url },
    event,
  });
}

function forwardReply(job, result) {
  postWebhook({
    source: 'dy-live-companion',
    kind: 'reply',
    at: Date.now(),
    room: { roomId: state.page.roomId, title: state.page.title, url: state.page.url },
    reply: {
      text: job.text,
      ruleId: job.ruleId,
      ruleName: job.ruleName,
      dryRun: Boolean(state.settings.dryRun),
      method: result && result.method,
    },
  });
}

/* ---------------- 界面 ---------------- */

function switchTab(name) {
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === name));
  $$('.view').forEach((view) => view.classList.toggle('active', view.dataset.view === name));
  if (name === 'rules' && rulesView) rulesView.render();
  if (name === 'settings' && settingsView) settingsView.render();
  if (name === 'live') renderFeed();
}

function updateHint() {
  const hint = $('#sendHint');
  if (!hint) return;
  if (!myRoomKey()) {
    hint.className = 'hint warn';
    hint.textContent = '主播模式：请先绑定你的直播间，自动回复暂不发送';
    return;
  }
  if (!state.settings.replyEnabled) {
    hint.className = 'hint';
    hint.textContent = '自动回复已关闭。配置好规则后打开顶部开关。';
  } else if (!state.page.tabId) {
    hint.className = 'hint warn';
    hint.textContent = '自动回复已开启，但还没有打开你的直播间';
  } else if (state.settings.dryRun) {
    hint.className = 'hint warn';
    hint.textContent = '自动回复已开启 · 演练模式：只匹配规则，不会真正发送';
  } else {
    hint.className = 'hint warn-real';
    hint.textContent = '自动回复已开启 · 会真实发送到你的直播间，请注意频率';
  }
}

function updateStatsUI(rate) {
  const online = $('#statOnline');
  const cumulative = $('#statCumulative');
  const received = $('#statReceived');
  const replied = $('#statReplied');
  if (!online) return;

  online.textContent = state.stats.online ? fmtNumber(state.stats.online) : '—';
  cumulative.textContent = state.stats.cumulative ? fmtNumber(state.stats.cumulative) : '—';
  received.textContent = fmtNumber(state.stats.received);
  replied.textContent = fmtNumber(state.stats.replied);

  const perMinute = typeof rate === 'number' ? rate : state.eventTimes.filter((ts) => Date.now() - ts < 60000).length;
  received.title = `最近一分钟 ${perMinute} 条消息`;
}

function updateConn() {
  const dot = $('#connDot');
  const textEl = $('#connText');
  const label = $('#roomLabel');
  if (!dot || !textEl) return;

  const key = myRoomKey();
  if (!key) {
    dot.className = 'dot idle';
    textEl.textContent = '主播模式 · 请先绑定你的直播间';
    label.textContent = '未绑定我的直播间';
    label.title = '';
    return;
  }

  if (!state.page.tabId) {
    const foreign = state.lastForeignAt && Date.now() - state.lastForeignAt < 15000;
    dot.className = foreign ? 'dot stale' : 'dot idle';
    textEl.textContent = foreign ? '当前页面不是你的直播间，已忽略' : '未打开我的直播间，点「我的直播」打开';
    label.textContent = `我的直播间 · ${key}`;
    label.title = state.settings.myRoomUrl;
    return;
  }

  if (state.page.title) {
    label.textContent = state.page.title;
    label.title = state.page.title;
  } else {
    label.textContent = `我的直播间 · ${key}`;
    label.title = state.settings.myRoomUrl;
  }

  const age = Date.now() - state.lastFrameAt;
  if (age < 10000) {
    dot.className = 'dot live';
    textEl.textContent = '已连接 · 我的直播间';
  } else if (age < 45000) {
    dot.className = 'dot stale';
    textEl.textContent = '数据延迟，请切回我的直播间窗口';
  } else {
    dot.className = 'dot idle';
    textEl.textContent = '已打开我的直播间，等待弹幕数据…';
  }
}

function tick() {
  const now = Date.now();
  state.eventTimes = state.eventTimes.filter((ts) => now - ts < 60000);
  pruneState(state.ruleState, now);
  updateStatsUI(state.eventTimes.length);
  updateConn();
  postPetStatus();
  maybeWarmup(now);
}

function log(kind, text, detail = '') {
  const entry = { id: uid('log'), ts: Date.now(), kind, text: String(text), detail: String(detail || '') };
  state.logs.unshift(entry);
  if (state.logs.length > 300) state.logs.pop();
  renderLogEntry(entry);
  reportAppLog(entry);
}

// 运行记录同步到桥接落盘（扩展侧只在内存里，刷新即清空，不方便排查）
function reportAppLog(entry) {
  try {
    if (!isLeader) return;
    fetch(`${boardUrl()}/api/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entry }),
      signal: AbortSignal.timeout(3000),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* 日志上报失败不影响主流程 */
  }
}

function renderLogEntry(entry) {
  const listEl = $('#logList');
  if (!listEl) return;
  const kindLabel = { sent: '发送', error: '错误', warn: '提醒', info: '信息' }[entry.kind] || entry.kind;
  const item = el('li', { className: `log-item ${entry.kind}` }, [
    el('span', { className: 'log-time', textContent: fmtClock(entry.ts) }),
    el('span', { className: 'log-kind', textContent: kindLabel }),
    el('span', { className: 'log-text', textContent: entry.text }),
  ]);
  if (entry.detail) item.append(el('span', { className: 'log-detail', textContent: entry.detail }));
  listEl.prepend(item);
  while (listEl.children.length > 300) listEl.lastElementChild.remove();
  const empty = $('#logsEmpty');
  if (empty) empty.hidden = true;
}

function mapFeedType(type) {
  return TYPE_LABELS[type] || type;
}

function exportFeed() {
  if (!state.feedEvents.length) {
    toast('暂时没有可导出的弹幕', 'warn');
    return;
  }
  const columns = [
    { label: '时间', get: (event) => fmtClock(event.ts) },
    { label: '类型', get: (event) => mapFeedType(event.type) },
    { label: '昵称', get: (event) => (event.user && event.user.nickname) || '' },
    { label: '用户ID', get: (event) => (event.user && event.user.id) || '' },
    { label: '内容', get: (event) => describeEvent(event) },
    { label: '礼物', get: (event) => (event.gift && event.gift.name) || '' },
    { label: '数量', get: (event) => (event.gift && event.gift.count) || (event.like && event.like.count) || '' },
    { label: '房间号', get: (event) => event.roomId || state.page.roomId || '' },
  ];
  downloadText(
    `douyin-feed-${todayStamp()}.csv`,
    `\ufeff${toCsv(state.feedEvents, columns)}`,
    'text/csv;charset=utf-8',
  );
  toast('弹幕已导出为 CSV', 'ok');
}

async function manualSend() {
  const input = $('#manualInput');
  if (!input) return;
  const text = input.value.trim();
  if (!text) {
    input.focus();
    return;
  }
  if (!myRoomKey()) {
    toast('请先绑定你的直播间', 'warn');
    const setupInput = $('#myRoomInput');
    if (setupInput) setupInput.focus();
    return;
  }

  const tabId = await resolveTabId();
  if (!tabId) {
    toast(myRoomKey() ? '未找到你的直播间页面，请先打开「我的直播」' : '没有找到已打开的抖音直播间', 'error');
    return;
  }

  input.disabled = true;
  try {
    const result = await sendToTab(tabId, { type: 'dy-reply', text, dryRun: false });
    if (result && result.ok) {
      reserveSend(state.ruleState, state.settings, { userId: 'manual', nowMs: Date.now() });
      noteSentText(state.ruleState, text);
      state.stats.replied += 1;
      updateStatsUI();
      input.value = '';
      log('sent', `手动发送：${text}`, result.warning || '');
      if (result.warning) log('warn', result.warning);
      toast(result.warning || '已发送', result.warning ? 'warn' : 'ok');
    } else {
      const message = (result && result.error) || '发送失败';
      log('error', `手动发送失败：${message}`);
      toast(message, 'error');
    }
  } catch (error) {
    log('error', `手动发送失败：${error.message}`);
    toast(error.message, 'error');
  } finally {
    input.disabled = false;
  }
}

function wireUI() {
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));

  $$('#filterChips .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.filter = chip.dataset.filter || 'all';
      $$('#filterChips .chip').forEach((item) => item.classList.toggle('active', item === chip));
      renderFeed();
    });
  });

  const autoscroll = $('#autoscrollToggle');
  autoscroll.checked = Boolean(state.settings.ui.autoscroll);
  autoscroll.addEventListener('change', () => {
    state.settings = mergeSettings({
      ...state.settings,
      ui: { ...state.settings.ui, autoscroll: autoscroll.checked },
    });
    saveSettings(state.settings);
  });

  $('#exportFeedBtn').addEventListener('click', exportFeed);
  $('#clearFeedBtn').addEventListener('click', () => {
    clearReplyMarks();
    state.feedEvents = [];
    renderFeed();
    toast('已清空弹幕列表');
  });

  $('#manualSendBtn').addEventListener('click', manualSend);
  $('#manualInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      manualSend();
    }
  });

  $('#bindRoomBtn').addEventListener('click', () => bindMyRoom($('#myRoomInput').value));
  $('#bindCurrentBtn').addEventListener('click', bindCurrentRoom);
  $('#myRoomInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      bindMyRoom(event.target.value);
    }
  });

  $('#replyToggle').addEventListener('change', (event) => {
    const enabled = event.target.checked;
    applySettings({ replyEnabled: enabled });
    toast(enabled ? '自动回复已开启' : '自动回复已关闭', 'ok');
  });

  $('#serviceToggle').addEventListener('change', async (event) => {
    const enabled = event.target.checked;
    try {
      await setServiceEnabled(enabled);
    } catch (error) {
      event.target.checked = !enabled;
      toast(`切换服务失败：${error.message || error}`, 'warn');
    }
  });

  $('#openTabBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('app/app.html') });
  });
  $('#openLiveBtn').addEventListener('click', openMyRoom);
  $('#helpBtn').addEventListener('click', () => {
    const dialog = $('#helpDialog');
    if (dialog && typeof dialog.showModal === 'function') dialog.showModal();
  });

  $('#clearLogsBtn').addEventListener('click', () => {
    state.logs = [];
    const listEl = $('#logList');
    if (listEl) listEl.textContent = '';
    const empty = $('#logsEmpty');
    if (empty) empty.hidden = false;
  });
}

/* ---------------- 启动 ---------------- */

function renderAppVersion() {
  const el = $('#appVersion');
  if (!el) return;
  try {
    const version = chrome.runtime.getManifest().version;
    if (version) el.textContent = `v${version}`;
  } catch {
    /* 本地直接打开页面时没有 chrome.runtime，保留静态版本号 */
  }
}

async function init() {
  renderAppVersion();
  const [settings, rules] = await Promise.all([loadSettings(), loadRules()]);
  state.settings = settings;
  state.rules = rules;
  await loadTokenUsage();
  await loadViewerHistory();
  await loadAiMemory();
  await loadAutoSongLibrary();
  if (state.settings.songRequest.enabled) {
    fetch(`${songRequestUrl()}/api/song/purge`, { method: 'POST' }).catch(() => {});
  }
  setInterval(() => {
    if (ensureTokenDay()) {
      updateStatsUI();
      schedulePetStatus();
    }
  }, 60_000);
  // 直播中每 30 分钟存一份记忆，避免下播前崩溃 / 关机导致本场记忆丢失
  setInterval(() => {
    if (Date.now() - state.lastForeignAt < 10 * 60 * 1000) saveLiveMemory();
  }, 30 * 60 * 1000);

  for (const eventName of ['pointerdown', 'keydown', 'touchstart']) {
    document.addEventListener(eventName, unlockTtsAudio, { passive: true });
  }
  setTimeout(() => refreshApiBalance(), 1800);
  setInterval(() => refreshApiBalance(), 5 * 60 * 1000);

  rulesView = initRulesView(ctx);
  settingsView = initSettingsView(ctx);

  wireUI();
  rulesView.render();
  settingsView.render();
  syncSettingsUI();
  setupPetBridge();
  setupDshPet();
  updateStatsUI();
  updateFeedEmpty();
  updateConn();

  // 重载扩展后让已打开的背景板立即重新拉一次点歌队列/当前播放
  if (isLeader && state.settings.board.enabled) {
    setTimeout(() => postBoard({ kind: 'board_refresh' }), 300);
  }

  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabId === state.page.tabId) {
      state.page = { tabId: null, url: '', title: '', roomId: '', hasInput: false, lastSeen: 0 };
      state.lastFrameAt = 0;
      updateConn();
      updateHint();
    }
  });

  chrome.tabs.onActivated.addListener(() => {
    detectPage();
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId !== state.page.tabId) return;
    if (changeInfo.url) state.page.url = changeInfo.url;
    if (changeInfo.title) state.page.title = changeInfo.title;
    if (myRoomKey() && changeInfo.url && !isMyRoomPage(changeInfo.url)) {
      state.page.tabId = null;
      state.page.url = '';
      state.lastFrameAt = 0;
      detectPage();
    }
    updateConn();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const settingsChange = changes[STORAGE_KEYS.settings];
    if (settingsChange && settingsChange.newValue) {
      const previousPet = JSON.stringify(state.settings.petBridge || {});
      const previousDshPet = dshConnectionKey(state.settings);
      state.settings = mergeSettings(settingsChange.newValue);
      if (previousPet !== JSON.stringify(state.settings.petBridge || {})) setupPetBridge();
      if (previousDshPet !== dshConnectionKey()) setupDshPet();
      syncSettingsUI();
    }
    const rulesChange = changes[STORAGE_KEYS.rules];
    if (rulesChange && rulesChange.newValue) {
      state.rules = normalizeRules(rulesChange.newValue);
      if (rulesView) rulesView.render();
    }
  });

  setInterval(tick, 1000);
  setInterval(drainQueue, 450);
  setInterval(updateConn, 1000);
  setInterval(() => {
    maybeAutoSong().catch(() => {});
  }, 5000);
  // 每 30 秒让大模型审核一遍点歌队列，违规歌曲自动移除并拉黑点歌人
  setInterval(() => {
    auditSongQueue().catch(() => {});
  }, 30_000);
  setInterval(() => {
    if (!isLeader) tryBecomeLeader();
  }, 8000);

  tryBecomeLeader();
  await detectPage();
  log('info', '弹幕助手已就绪，等待直播间数据…');
}

init().catch((error) => {
  console.error(error);
  toast(`初始化失败：${error.message}`, 'error');
});
