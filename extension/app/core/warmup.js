/** 暖场：直播间没人说话 / 人少时，决定什么时候说、说什么兜底。 */

export const WARMUP_LINES = [
  '欢迎刚进来的朋友，点点关注不迷路～',
  '直播间现在有点安静，大家想聊点什么，评论区告诉我呀',
  '新进来的宝宝扣个 1，让我看到你～',
  '人少也有人少的快乐，来陪主播聊两句吧',
  '有问题直接打在公屏上，我看到就回你～',
  '今天想听我聊点什么？评论区点单～',
  'token来，token来！',
];

// 暖场说到这句话时，桌面宠物同步播放「token汇聚」动画
export const TOKEN_WARMUP_RE = /token\s*来/i;

export function isTokenWarmup(text) {
  return TOKEN_WARMUP_RE.test(String(text || ''));
}

export const WARMUP_VIEWER_LINES = [
  '{name}，欢迎来到直播间，今天想聊点什么呀？',
  '{name}，刚看到你啦，来陪主播聊两句吧～',
  '{name}，晚上好呀，点点关注不迷路～',
  '{name}，在的话扣个 1，让我看到你～',
];

const FOLLOW_WORD_RE = /关注/g;
const THANKS_LEAD_RE = /^(?:谢谢|感谢|多谢|谢啦|蟹蟹|爱你|么么)/;

/** 这句话是否在劝观众点关注（「谢谢关注」这类纯感谢不算）。 */
export function isFollowAsk(text) {
  const value = String(text || '').trim();
  const hits = value.match(FOLLOW_WORD_RE);
  if (!hits) return false;
  if (hits.length === 1 && THANKS_LEAD_RE.test(value)) return false;
  return true;
}

/** 已关注观众的文案兜底：删掉劝关注的分句，剩下的照常使用；删完只剩昵称等零碎内容时返回空串。 */
export function stripFollowAsk(text) {
  const raw = String(text || '').trim();
  if (!raw || !isFollowAsk(raw)) return raw;
  const clauses = raw.match(/[^，,。！？；;!?\n]+[，,。！？；;!?\n]*/g) || [];
  const kept = clauses
    .filter((part) => !isFollowAsk(part))
    .join('')
    .replace(/^[，,。！？；;!?\s]+/, '')
    .replace(/[，,；;。]+$/, '')
    .trim();
  // 只剩「@昵称」这类零碎内容时不返回，交给调用方换一条完整文案
  const substantial = kept.replace(/[^\p{L}\p{N}]/gu, '');
  return Array.from(substantial).length >= 4 ? kept : '';
}

// 在线观众名单视为有效的时间；超过后改用「最近有没有互动」兜底
export const AUDIENCE_FRESH_MS = 3 * 60 * 1000;
// 有在线名单时，名单外的人只有刚互动过 60 秒内才认为还在
export const PRESENCE_RECENT_MS = 60 * 1000;
// 完全没有在线名单时，只跟最近 90 秒内有过互动的人打招呼
export const PRESENCE_FALLBACK_MS = 90 * 1000;

/**
 * 判断观众现在是否还在直播间。
 * @param {object} viewer 单场记忆里的观众（含 id/name/lastSeen）
 * @param {Map<string, number>} audience 抖音在线观众名单（id / 昵称 -> 更新时间）
 * @param {number} audienceAt 名单最近一次更新的时间
 * @param {number} now 当前时间
 * @returns {boolean}
 */
export function isViewerPresent(viewer, audience, audienceAt, now = Date.now()) {
  if (!viewer) return false;
  const lastSeen = Number(viewer.lastSeen || 0);
  const fresh = Number(audienceAt) > 0 && now - Number(audienceAt) <= AUDIENCE_FRESH_MS;
  if (fresh && audience && audience.size) {
    const id = String(viewer.id || '');
    const name = String(viewer.name || '');
    if ((id && audience.has(id)) || (name && audience.has(name))) return true;
    // 名单里没有，但刚刚还在互动，按在场处理
    return Boolean(lastSeen) && now - lastSeen <= PRESENCE_RECENT_MS;
  }
  if (!lastSeen || now - lastSeen > 10 * 60 * 1000) return false;
  return now - lastSeen <= PRESENCE_FALLBACK_MS;
}

export function pickWarmupLine(recent = [], random = Math.random, viewer = '', viewerFollowed = false) {
  const name = String(viewer || '').trim();
  let source = name
    ? WARMUP_VIEWER_LINES.map((line) => line.replaceAll('{name}', `@${name}`))
    : WARMUP_LINES;
  // 已经关注过的观众，不再劝他点关注
  if (viewerFollowed) {
    const filtered = source.filter((line) => !line.includes('关注'));
    if (filtered.length) source = filtered;
  }
  const used = new Set((recent || []).map((item) => String(item)));
  const available = source.filter((line) => !used.has(line));
  const pool = available.length ? available : source;
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
}

export function pickWarmupPresetInfo(presets = [], recent = [], random = Math.random, viewer = '', viewerFollowed = false) {
  const list = (Array.isArray(presets) ? presets : String(presets || '').split(/\r?\n/))
    .map((line) => String(line || '').trim())
    .filter(Boolean)
    .slice(0, 30);
  if (!list.length) return { text: '', hasName: false };
  const name = String(viewer || '').trim() || '大家';
  const used = new Set((recent || []).map((item) => String(item)));
  const available = list
    .map((line) => {
      const hasName = /\{name\}|\{昵称\}/.test(line);
      return { hasName, text: line.replaceAll('{name}', `@${name}`).replaceAll('{昵称}', `@${name}`) };
    })
    .filter((item) => !used.has(item.text))
    // 已经关注过的观众，跳过带「关注」的预设文案
    .filter((item) => !viewerFollowed || !item.text.includes('关注'));
  if (!available.length) return { text: '', hasName: false };
  const picked = available[Math.min(available.length - 1, Math.floor(random() * available.length))];
  return picked;
}

export function pickWarmupPreset(presets = [], recent = [], random = Math.random, viewer = '') {
  return pickWarmupPresetInfo(presets, recent, random, viewer).text;
}

/**
 * 判断是否该暖场。返回 null 表示不触发，否则返回触发原因。
 */
export function warmupTrigger(options = {}) {
  const {
    config = {},
    online = 0,
    now = Date.now(),
    lastChatAt = 0,
    lastWarmupAt = 0,
    warmupTimes = [],
  } = options;

  if (!config.enabled) return null;

  const threshold = Math.max(0, Number(config.lowViewerThreshold) || 0);
  const viewers = Math.max(0, Number(online) || 0);
  const lowViewers = threshold > 0 && viewers > 0 && viewers <= threshold;

  const idleRequired = Math.max(10, Number(config.idleSec) || 120);
  const lowRequired = Math.max(10, Number(config.lowViewerSec) || 45);
  const requiredSec = lowViewers ? Math.min(idleRequired, lowRequired) : idleRequired;
  const idleSec = Math.max(0, (now - (Number(lastChatAt) || now)) / 1000);
  if (idleSec < requiredSec) return null;

  const minInterval = Math.max(0, Number(config.minIntervalSec) || 0) * 1000;
  if (minInterval > 0 && now - (Number(lastWarmupAt) || 0) < minInterval) return null;

  const hourAgo = now - 3600000;
  const recentCount = (warmupTimes || []).filter((ts) => Number(ts) > hourAgo).length;
  const maxPerHour = Math.max(1, Number(config.maxPerHour) || 10);
  if (recentCount >= maxPerHour) return null;

  return {
    reason: lowViewers ? 'low-viewers' : 'idle',
    requiredSec,
    idleSec: Math.round(idleSec),
    viewers,
  };
}
