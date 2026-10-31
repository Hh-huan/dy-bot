/**
 * 桌宠自动点歌：触发判定、正向祝福歌曲库解析与持久化合并、歌曲挑选。
 *
 * 触发条件：点歌队列为空、当前正在播放每日推荐音乐、直播间有在线观众。
 * 点歌人固定为「大肥鱼」，发送格式固定为「大肥鱼点给@xxx」。
 */

import { findSensitiveSongWord } from './sensitiveSong.js';

export const AUTO_SONG_LIBRARY_KEY = 'dy.autoSongLibrary.v1';
export const AUTO_SONG_LIBRARY_MAX = 200;
export const AUTO_SONG_INTERVAL_MS = 60 * 1000;
export const AUTO_SONG_SOURCE_PREFIX = '大肥鱼点给@';
export const AUTO_SONG_VOICE_TEXT = '大肥鱼点了一首歌送给你';

// 只接受正向祝福 / 喜庆 / 积极主题；负面、悲伤、恐怖类直接过滤
const NEGATIVE_SONG_RE =
  /(悲伤|伤心|失恋|分手|离别|离歌|哀乐|葬礼|诀别|永别|绝望|自杀|死亡|去世|恐怖|惊悚|灵异|鬼故事|鬼新娘|厉鬼|怨灵|血腥|凶杀|诅咒|丧气|颓废|苦情|心碎|流泪)/i;

/** 判断歌曲是否属于正向祝福/喜庆/积极主题。 */
export function isPositiveSong(song) {
  const title = String((song && song.title) || '').trim();
  const artist = String((song && song.artist) || '').trim();
  if (!title) return false;
  const text = `${title} ${artist}`;
  if (NEGATIVE_SONG_RE.test(text)) return false;
  return !findSensitiveSongWord(text);
}

function cleanTitle(value) {
  return String(value || '')
    .replace(/^\s*(?:[-*•]+|\d+[.、)])\s*/, '')
    .replace(/《|》|「|」|【|】|["']/g, '')
    .replace(/[\s,，。.!！?？~～;；、]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

function cleanArtist(value) {
  return String(value || '')
    .replace(/《|》|「|」|【|】|["']/g, '')
    .replace(/^\s*[-–—]\s*/, '')
    .replace(/[\s,，。.!！?？~～;；、]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

/**
 * 把大模型 / 存档中的一条歌曲数据规范成 {title, artist}。
 * 支持字符串「歌名 - 歌手」「歌名（歌手）」和对象 {title, artist}。
 * @returns {{title:string, artist:string}|null}
 */
export function normalizeAutoSong(raw) {
  let title = '';
  let artist = '';
  if (typeof raw === 'string') {
    let text = String(raw || '').replace(/^\s*(?:[-*•]+|\d+[.、)])\s*/, '').trim();
    const bracket = text.match(/^(.+?)[（(]([^（）()]{1,40})[）)]\s*$/);
    if (bracket) {
      title = cleanTitle(bracket[1]);
      artist = cleanArtist(bracket[2]);
    } else {
      const dash = text.match(/^(.+?)\s*[-–—]\s*(.+)$/);
      if (dash) {
        title = cleanTitle(dash[1]);
        artist = cleanArtist(dash[2]);
      } else {
        title = cleanTitle(text);
      }
    }
  } else if (raw && typeof raw === 'object') {
    title = cleanTitle(raw.title || raw.name || raw.song || '');
    artist = cleanArtist(raw.artist || raw.singer || raw.artists || '');
  }
  if (!title) return null;
  const song = { title, artist };
  return isPositiveSong(song) ? song : null;
}

function firstJsonArray(text) {
  const raw = String(text || '');
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 解析大模型返回的歌曲列表。优先解析 JSON 数组，失败时按行解析。
 * @returns {Array<{title:string, artist:string}>}
 */
export function parseAutoSongList(text) {
  const raw = String(text || '');
  let items = [];
  const data = firstJsonArray(raw);
  if (Array.isArray(data)) {
    items = data;
  } else if (data && Array.isArray(data.songs)) {
    items = data.songs;
  }
  if (!items.length) {
    items = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 30);
  }
  const seen = new Set();
  const list = [];
  for (const item of items) {
    const song = normalizeAutoSong(item);
    if (!song) continue;
    const key = `${song.title.toLowerCase()}|${song.artist.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(song);
  }
  return list;
}

/**
 * 合并歌曲库：去重、保留最近 max 首。
 * @param {Array} existing 已持久化的歌曲
 * @param {Array} incoming 新增歌曲
 * @param {number} max
 */
export function mergeAutoSongLibrary(existing, incoming, max = AUTO_SONG_LIBRARY_MAX) {
  const all = [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])];
  const seen = new Set();
  const list = [];
  for (const item of all) {
    const song = normalizeAutoSong(item);
    if (!song) continue;
    const key = `${song.title.toLowerCase()}|${song.artist.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(song);
  }
  return list.slice(-Math.max(1, Number(max) || AUTO_SONG_LIBRARY_MAX));
}

function titleKey(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[《》「」【】（）()\s]/g, '');
}

/**
 * 从歌曲库随机挑一首，跳过排除列表里的歌（如正在播放的推荐曲）。
 * @returns {{title:string, artist:string}|null}
 */
export function pickAutoSongFromLibrary(library, random = Math.random, exclude = []) {
  const excluded = new Set((Array.isArray(exclude) ? exclude : []).map(titleKey).filter(Boolean));
  const pool = (Array.isArray(library) ? library : [])
    .map(normalizeAutoSong)
    .filter(Boolean)
    .filter((song) => !excluded.has(titleKey(song.title)));
  if (!pool.length) return null;
  const index = Math.min(pool.length - 1, Math.floor(Math.max(0, Number(random()) || 0) * pool.length));
  return pool[index];
}

/**
 * 判断是否该触发桌宠自动点歌。
 * @param {object} options
 * @returns {boolean}
 */
export function autoSongTrigger(options = {}) {
  const {
    queueLength = 0,
    current = null,
    audienceCount = 0,
    now = Date.now(),
    lastAt = 0,
    minIntervalMs = AUTO_SONG_INTERVAL_MS,
  } = options;
  if (Number(queueLength) > 0) return false;
  if (!current || current.recommend !== true) return false;
  if (Number(audienceCount) <= 0) return false;
  if (Number(now) - Number(lastAt) < Number(minIntervalMs)) return false;
  return true;
}

/** 生成点歌人展示文案：大肥鱼点给@xxx */
export function buildAutoSongSender(name) {
  const nickname = String(name || '').replace(/@/g, '').trim();
  if (!nickname) return AUTO_SONG_SOURCE_PREFIX;
  return `${AUTO_SONG_SOURCE_PREFIX}${nickname}`;
}

/** 观众说「帮我点首歌」后的公屏回复：@xxx，送你一首xxx，每天都要开开心心哦！ */
export function buildPetSongReply(name, title) {
  const nickname = String(name || '观众').replace(/@/g, '').trim() || '观众';
  const song = String(title || '').trim() || '好听的歌';
  return `@${nickname}，送你一首《${song}》，每天都要开开心心哦！`;
}
