/**
 * 点歌队列 + 本机播放器适配（QQ 音乐 / 网易云 / 酷狗）。
 *
 * - QQ 音乐：调用 QQMusic.exe /playbysongid <songid>（Windows 客户端自带入口）
 * - 网易云：优先 orpheus://song/<id>，没装客户端则打开网页播放页
 * - 酷狗：优先 kugou:// 协议，没装客户端则打开网页播放页
 * - 暂停/继续/下一首：Windows 媒体键（对当前系统媒体会话生效）
 *
 * 只在本机运行，不下载/不绕过版权限制；VIP/地区限制由各播放器自己处理。
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SENSITIVE_SONG_MESSAGE, findSensitiveSongWord } from '../extension/app/core/sensitiveSong.js';
import { createViolationStore, sameSongExact } from './violationStore.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEDIA_SCRIPT = path.join(HERE, 'media-keys.ps1');
const VOLUME_SCRIPT = path.resolve(HERE, '../tools/qq-volume.ps1');
const VOLUME_MIN = 20;
const VOLUME_MAX = 70;
const VOLUME_STEP = 10;

const HORROR_SONG_RE = /(恐怖|惊悚|灵异|鬼故事|鬼新娘|鬼片|鬼魂|鬼怪|鬼娃|冥婚|红嫁衣|厉鬼|恶鬼|怨灵|丧尸|僵尸|冥界|地狱|诅咒|招魂|驱魔|凶杀|血腥|自杀|午夜凶铃|咒怨|笔仙|碟仙|红衣小女孩|惊魂|阴间)/i;
const DEFAULTS = {
  provider: 'qq',
  player: 'app',
  neteaseCookie: '',
  perUserCooldownSec: 0,
  autoPlay: true,
  minPlaySec: 60,
  queueCutSec: 90,
  maxQueue: 1000,
  dailyRecommend: true,
  qqExe: '',
  neteaseExe: '',
  kugouExe: '',
  playCommand: '',
};

function stripTags(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(value) {
  return stripTags(value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function fetchJson(url, headers = {}, timeoutMs = 9000) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      ...headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`搜索接口 HTTP ${response.status}`);
  return response.json();
}

async function fetchJsonPost(url, body, headers = {}, timeoutMs = 9000) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`推荐接口 HTTP ${response.status}`);
  return response.json();
}

function findFile(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    if (existsSync(candidate)) return candidate;
  }
  return '';
}

export function findQQMusic() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  return findFile([
    path.join(pf86, 'Tencent', 'QQMusic', 'QQMusic.exe'),
    path.join(pf, 'Tencent', 'QQMusic', 'QQMusic.exe'),
    path.join(local, 'Tencent', 'QQMusic', 'QQMusic.exe'),
    'D:\\Program Files (x86)\\Tencent\\QQMusic\\QQMusic.exe',
    'D:\\Program Files\\Tencent\\QQMusic\\QQMusic.exe',
    'E:\\Program Files (x86)\\Tencent\\QQMusic\\QQMusic.exe',
    'F:\\Program Files (x86)\\Tencent\\QQMusic\\QQMusic.exe',
  ]);
}

export function findNeteaseMusic() {
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  return findFile([
    path.join(pf86, 'Netease', 'CloudMusic', 'cloudmusic.exe'),
    path.join(local, 'Netease', 'CloudMusic', 'cloudmusic.exe'),
    'D:\\Program Files (x86)\\Netease\\CloudMusic\\cloudmusic.exe',
    'D:\\Program Files\\Netease\\CloudMusic\\cloudmusic.exe',
    'C:\\Program Files (x86)\\Netease\\CloudMusic\\cloudmusic.exe',
  ]);
}

export function findKugou() {
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  return findFile([
    path.join(pf86, 'Kugou', 'KuGou.exe'),
    path.join(pf86, 'Kugou', 'KGMusic', 'KuGou.exe'),
    path.join(local, 'Kugou', 'KuGou.exe'),
    'D:\\Program Files (x86)\\Kugou\\KuGou.exe',
    'D:\\Program Files\\Kugou\\KuGou.exe',
  ]);
}

function normalizeQQText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[（）()\[\]【】\s]/g, '');
}

/** 歌曲去重：优先比对来源 ID，QQ 不同搜索结果 ID 不同时再按「歌名+歌手」比对。 */
function sameSongEntry(a, b) {
  if (!a || !b) return false;
  if (a.source === b.source && a.id && b.id && String(a.id) === String(b.id)) return true;
  const titleA = normalizeQQText(a.title);
  const titleB = normalizeQQText(b.title);
  if (!titleA || titleA !== titleB) return false;
  const artistA = normalizeQQText(a.artist);
  const artistB = normalizeQQText(b.artist);
  if (!artistA || !artistB) return true;
  return artistA === artistB || artistA.includes(artistB) || artistB.includes(artistA);
}

/** 从「雨爱 司凤版 / 雨爱（司风版）」里提取版本词，优先匹配翻唱版本。 */
function qqVersionTokens(query) {
  const text = String(query || '');
  const tokens = [];
  for (const match of text.matchAll(/[\u4e00-\u9fa5A-Za-z0-9]{1,10}版/g)) tokens.push(match[0]);
  for (const match of text.matchAll(/[（(]([^）)]{1,20})[）)]/g)) tokens.push(match[1]);
  return [...new Set(tokens.map((item) => item.trim()).filter(Boolean))];
}

function qqQueryTerms(query) {
  const text = String(query || '');
  const withoutBrackets = text.replace(/[（(【\[].*?[）)】\]]/g, ' ');
  const latin = normalizeQQText(
    (withoutBrackets.match(/[A-Za-z][A-Za-z0-9'&.,!? ]*/g) || []).join(' '),
  );
  const cjk = [...new Set(
    (withoutBrackets.match(/[\u4e00-\u9fa5]{2,}/g) || []).filter((token) => token !== '版'),
  )];
  return { latin, cjk, versions: qqVersionTokens(text) };
}

function extractLatinTitle(query) {
  const text = String(query || '').replace(/[（(【\[].*?[）)】\]]/g, ' ');
  return (text.match(/[A-Za-z][A-Za-z0-9'&.,!? -]{1,}/g) || []).join(' ').trim();
}

function pickQQResult(list, query) {
  if (!Array.isArray(list) || !list.length) return null;
  const terms = qqQueryTerms(query);
  const latinOnly = /[A-Za-z]/.test(query) && !/[\u4e00-\u9fa5]/.test(query);
  if (latinOnly && !terms.versions.length) {
    // 纯英文点歌：保留 QQ 第一条英文结果；第一条是中文翻唱时选第一条英文标题+英文歌手
    const isEnglish = (song) => {
      const name = String(song.songname || '');
      const artist = (song.singer || []).map((item) => item.name).join(' ');
      return /[A-Za-z]/.test(name) && /[A-Za-z]/.test(artist);
    };
    if (isEnglish(list[0])) return list[0];
    return list.find(isEnglish) || list[0];
  }

  // 混合查询（英文歌名 + 中文歌手/版本）时，不要把“歌手的其他歌”当成目标
  const titleTerms = [
    terms.latin,
    ...terms.cjk.flatMap((token) => [normalizeQQText(token), normalizeQQText(token.replace(/版$/, ''))]),
  ].filter((term) => term.length >= 2);
  let pool = list;
  if (titleTerms.length) {
    const matched = list.filter((song) =>
      titleTerms.some((term) => normalizeQQText(song.songname).includes(term)),
    );
    if (matched.length) pool = matched;
  }

  const scored = pool.map((song, index) => {
    const name = normalizeQQText(song.songname);
    const artist = (song.singer || []).map((item) => item.name).join(' ');
    const artistText = normalizeQQText(artist);
    let score = 0;

    if (titleTerms.some((term) => name === term)) score += 4;
    if (terms.latin.length >= 2 && name.includes(terms.latin)) score += 6;
    for (const token of terms.cjk) {
      if (token.endsWith('版') && token.length > 1) {
        const base = token.slice(0, -1);
        if (name.includes(normalizeQQText(token))) score += 3;
        if (artistText.includes(normalizeQQText(base))) score += 5;
        else if (name.includes(normalizeQQText(base))) score += 2;
      } else {
        if (artistText.includes(normalizeQQText(token))) score += 4;
        if (name.includes(normalizeQQText(token))) score += 2;
      }
    }
    for (const version of terms.versions) {
      if (name.includes(normalizeQQText(version))) score += 3;
    }
    return { song, index, score };
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored[0].song;
}

function qqArtistNote(query, song) {
  if (!song) return '';
  const terms = qqQueryTerms(query);
  if (!terms.cjk.length) return '';
  const name = normalizeQQText(song.songname);
  const artist = normalizeQQText((song.singer || []).map((item) => item.name).join(' '));
  const missing = terms.cjk
    .map((token) => token.replace(/版$/, ''))
    .filter(
      (base) =>
        base &&
        !name.includes(normalizeQQText(base)) &&
        !artist.includes(normalizeQQText(base)) &&
        !name.includes(normalizeQQText(`${base}版`)),
    );
  return missing.length ? `没找到「${missing[0]}版」，已选 ${song.songname}` : '';
}

async function searchQQFull(query) {
  const url =
    'https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?format=json&p=1&n=20&w=' +
    encodeURIComponent(query);
  const data = await fetchJson(url, { Referer: 'https://y.qq.com/' });
  const list = data && data.data && data.data.song && data.data.song.list;
  return Array.isArray(list) ? list : [];
}

export async function searchQQ(query) {
  const text = String(query || '').trim().replace(/\s+/g, ' ');
  if (!text) throw new Error('搜索内容为空');
  const cached = qqSearchCache.get(text);
  if (cached && cached.expiresAt > Date.now()) return { ...cached.song };

  let primaryError = null;
  if (Date.now() >= qqPrimaryDownUntil) {
    try {
      const lists = [await searchQQFull(text)];
      const latinTitle = extractLatinTitle(text);
      if (latinTitle && /[\u4e00-\u9fa5]/.test(text) && normalizeQQText(latinTitle) !== normalizeQQText(text)) {
        try {
          lists.push(await searchQQFull(latinTitle));
        } catch {
          /* 标题单独搜索失败时仍用原查询结果 */
        }
      }
      const seen = new Set();
      const list = lists.flat().filter((item) => {
        const key = String(item.songid || item.songmid || '');
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const song = pickQQResult(list, text);
      if (!song) throw new Error('QQ 音乐没有搜到这首歌');
      const result = {
        source: 'qq',
        id: String(song.songid),
        songmid: song.songmid || '',
        title: decodeEntities(song.songname),
        artist: (song.singer || []).map((item) => item.name).filter(Boolean).join(' / ') || '未知歌手',
        album: decodeEntities(song.albumname),
        duration: Math.max(0, Number(song.interval) || 0) * 1000,
        cover: song.albummid
          ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${song.albummid}.jpg`
          : '',
        webUrl: song.songmid ? `https://y.qq.com/n/ryqq/songDetail/${song.songmid}` : 'https://y.qq.com/',
      };
      const artistNote = qqArtistNote(text, song);
      if (artistNote) result.searchNote = artistNote;
      rememberQQSearch(text, result);
      return result;
    } catch (error) {
      primaryError = error;
      // 搜索接口偶尔 500，5 分钟内直接用 smartbox，避免每次测试都先报错
      qqPrimaryDownUntil = Date.now() + 5 * 60 * 1000;
    }
  }

  try {
    const alternatives = [text, ...qqQueryAlternatives(text)];
    let lastError = null;
    for (const candidate of alternatives) {
      try {
        const smart = await searchQQSmart(candidate);
        const result = await enrichQQSmart(smart);
        if (candidate !== text) {
          result.searchNote = `没找到「${text}」，已按「${candidate}」搜索`;
        }
        rememberQQSearch(text, result);
        return result;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('QQ 音乐没有搜到这首歌');
  } catch (error) {
    const prefix = primaryError ? `QQ 搜索接口失败：${primaryError.message}；` : '';
    throw new Error(`${prefix}QQ 智能搜索失败：${error.message}`);
  }
}

/** 去掉「司凤版 / 女声版 / (Live)」这类版本后缀，用基础歌名再搜一次。 */
export function qqQueryAlternatives(query) {
  const text = String(query || '').trim();
  if (!text) return [];
  const result = new Set();
  const noBrackets = text
    .replace(/[（(【\[].*?[）)】\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (noBrackets && noBrackets !== text) result.add(noBrackets);
  const noVersion = text
    .replace(/\s*[\u4e00-\u9fa5A-Za-z0-9]{1,10}版\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (noVersion && noVersion !== text) result.add(noVersion);
  for (const base of [...result]) {
    const stripped = base
      .replace(/\s*[\u4e00-\u9fa5A-Za-z0-9]{1,10}版\s*$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (stripped) result.add(stripped);
  }
  const cleaned = text
    .replace(/(翻唱|cover|live|现场|伴奏|纯音乐|钢琴|dj|remix|女声|男声|完整|高音质|无损|片段)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned && cleaned !== text) result.add(cleaned);
  return [...result].filter((item) => item.length > 0);
}

const qqSearchCache = new Map();
let qqPrimaryDownUntil = 0;

function rememberQQSearch(query, song) {
  qqSearchCache.set(query, { song, expiresAt: Date.now() + 10 * 60 * 1000 });
  while (qqSearchCache.size > 50) qqSearchCache.delete(qqSearchCache.keys().next().value);
}

async function searchQQSmart(query) {
  const url =
    'https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?key=' +
    encodeURIComponent(query) +
    '&format=json';
  const data = await fetchJson(url, { Referer: 'https://y.qq.com/' });
  const song = data && data.data && data.data.song && data.data.song.itemlist && data.data.song.itemlist[0];
  if (!song) throw new Error('QQ 音乐没有搜到这首歌');
  return {
    source: 'qq',
    id: String(song.id || song.docid || ''),
    songmid: song.mid || '',
    title: decodeEntities(song.name),
    artist: decodeEntities(song.singer) || '未知歌手',
    album: '',
    duration: 0,
    cover: '',
    webUrl: song.mid ? `https://y.qq.com/n/ryqq/songDetail/${song.mid}` : 'https://y.qq.com/',
  };
}

async function enrichQQSmart(smart) {
  if (!smart.songmid) return smart;
  try {
    const url =
      'https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?songmid=' +
      encodeURIComponent(smart.songmid) +
      '&format=json';
    const data = await fetchJson(url, { Referer: 'https://y.qq.com/' });
    const track = data && data.data && data.data[0];
    if (!track) return smart;
    return {
      ...smart,
      id: String(track.id || smart.id),
      songmid: track.mid || smart.songmid,
      title: decodeEntities(track.name || smart.title),
      artist:
        (track.singer || []).map((item) => item.name).filter(Boolean).join(' / ') ||
        smart.artist,
      album: decodeEntities((track.album && track.album.name) || ''),
      duration: Math.max(0, Number(track.interval) || 0) * 1000,
      cover: track.album && track.album.mid
        ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${track.album.mid}.jpg`
        : '',
      webUrl: `https://y.qq.com/n/ryqq/songDetail/${track.mid || smart.songmid}`,
    };
  } catch {
    return smart;
  }
}

export async function searchNetease(query) {
  const url =
    'https://music.163.com/api/search/get/web?csrf_token=&s=' +
    encodeURIComponent(query) +
    '&type=1&offset=0&total=true&limit=8';
  const data = await fetchJson(url, { Referer: 'https://music.163.com/' });
  const song = data && data.result && data.result.songs && data.result.songs[0];
  if (!song) throw new Error('网易云没有搜到这首歌');
  return {
    source: 'netease',
    id: String(song.id),
    title: decodeEntities(song.name),
    artist: (song.artists || song.ar || []).map((item) => item.name).filter(Boolean).join(' / ') || '未知歌手',
    album: decodeEntities((song.album && song.album.name) || ''),
    duration: Math.max(0, Number(song.duration) || 0),
    cover: (song.album && (song.album.picUrl || song.album.blurPicUrl)) || '',
    webUrl: `https://music.163.com/#/song?id=${song.id}`,
  };
}

export async function searchKugou(query) {
  const url =
    'https://songsearch.kugou.com/song_search_v2?keyword=' +
    encodeURIComponent(query) +
    '&page=1&pagesize=8';
  const data = await fetchJson(url, { Referer: 'https://www.kugou.com/' });
  const song = data && data.data && data.data.lists && data.data.lists[0];
  if (!song) throw new Error('酷狗没有搜到这首歌');
  return {
    source: 'kugou',
    id: String(song.SongID || song.MixSongID || song.Audioid || ''),
    hash: song.FileHash || '',
    title: decodeEntities(song.SongName),
    artist: decodeEntities(song.SingerName) || '未知歌手',
    album: decodeEntities(song.AlbumName),
    duration: Math.max(0, Number(song.Duration) || 0) * 1000,
    cover: String(song.Image || '').replace('{size}', '400'),
    webUrl: song.FileHash ? `https://www.kugou.com/song/#hash=${song.FileHash}` : 'https://www.kugou.com/',
  };
}

function searchByProvider(query, provider) {
  if (provider === 'netease') return searchNetease(query);
  if (provider === 'kugou') return searchKugou(query);
  return searchQQ(query);
}

/**
 * 网易云直链解析：本地播放模式的核心。
 * QQ 音乐 2026 客户端的 /playbysongid 已不按 songid 精确播放（实测乱放歌单），
 * 因此默认不再调任何第三方客户端，由背景板内嵌 audio 直接播放直链。
 * 免登录直链已被 VIP 封锁（实测热门歌全部 null），必须带用户自己的网易云 Cookie。
 */
async function resolveNeteaseUrl(songId, br = 320000, cookie = '') {
  const url =
    'https://music.163.com/api/song/enhance/player/url?id=' +
    encodeURIComponent(songId) +
    `&br=${br}&csrf_token=`;
  const headers = { Referer: 'https://music.163.com/' };
  if (cookie) {
    headers.Cookie = cookie.includes('MUSIC_U=') ? cookie : `MUSIC_U=${cookie}`;
  }
  try {
    const data = await fetchJson(url, headers);
    const info = data && data.data && data.data[0];
    return (info && info.url && String(info.url)) || '';
  } catch {
    return '';
  }
}

function runDetached(command, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
    child.once('error', reject);
  });
}

function openExternal(target) {
  return runDetached('cmd.exe', ['/c', 'start', '', target]).catch(() => {});
}

/**
 * 读取系统媒体会话（SMTC）里指定程序的当前播放信息。
 * 用于切歌后核对客户端是否真的播到了目标歌曲。
 */
function smtcQuery(appPattern) {
  const script = path.join(HERE, '..', 'tools', 'smtc.ps1');
  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', 'query', '-Json'],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    );
    let out = '';
    const timer = setTimeout(() => child.kill(), 8000);
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.once('close', () => {
      clearTimeout(timer);
      try {
        // 脚本以 base64 输出 UTF-8 JSON，避免 PowerShell 管道代码页把中文弄乱
        const text = Buffer.from(out.trim(), 'base64').toString('utf8').replace(/^\uFEFF/, '');
        const list = JSON.parse(text || '[]');
        const hit = (Array.isArray(list) ? list : []).find((item) =>
          new RegExp(appPattern, 'i').test(String(item.app || '')));
        resolve(hit || null);
      } catch {
        resolve(null);
      }
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

let qqHandoffChain = Promise.resolve();

/**
 * 歌名/歌手归一化：去掉空格、括号、标点，忽略大小写。
 * 客户端展示的标题常带 (Live)/(深情版) 等后缀，用包含关系匹配。
 */
function normalizeSongText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[（）()【】[\]《》<>·・\-—_、,，.。!！?？"'“”‘’]/g, '');
}

function songMatches(info, title, artist) {
  if (!info) return false;
  const actualTitle = normalizeSongText(info.title);
  const expectTitle = normalizeSongText(title);
  if (!actualTitle || !expectTitle) return false;
  if (!(actualTitle.includes(expectTitle) || expectTitle.includes(actualTitle))) return false;
  const actualArtist = normalizeSongText(info.artist);
  const expectArtist = normalizeSongText(artist);
  if (!expectArtist || !actualArtist) return true;
  return expectArtist
    .split('/')
    .filter(Boolean)
    .some((part) => actualArtist.includes(part) || part.includes(actualArtist));
}

/** 轮询系统媒体会话，直到 QQ 音乐真的在放目标歌曲 */
async function waitQQPlaying(title, artist, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await smtcQuery('QQMusic');
    if (songMatches(info, title, artist)) return info;
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  return null;
}

/**
 * QQ 音乐客户端只适合单实例交接：串行调用，并等待 launcher 退出。
 * 不 kill 客户端，也不无限等待；5 秒还没退出就认为命令已交给主进程。
 */
function handoffQQ(exe, songId) {
  const run = () =>
    new Promise((resolve, reject) => {
      let settled = false;
      const child = spawn(
        exe,
        ['/playbysongid', `cmd_count==1&&id_0==${songId}&&songtype_0==0`],
        { detached: true, stdio: 'ignore', windowsHide: true },
      );
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.unref();
        resolve();
      }, 5000);
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });

  const next = qqHandoffChain.then(run, run);
  qqHandoffChain = next.catch(() => {});
  return next;
}

function protocolRegistered(name) {
  try {
    execFileSync('reg', ['query', `HKCR\\${name}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function pressMediaKey(action) {
  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', MEDIA_SCRIPT, action],
      { stdio: 'ignore', windowsHide: true },
    );
    child.on('exit', () => resolve());
    child.on('error', () => resolve());
  });
}

/** 通过 Windows 音频会话读取/设置 QQ 音乐的应用音量。 */
function runQQVolume(args) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', VOLUME_SCRIPT, ...args],
      { timeout: 8000, windowsHide: true },
      (error, stdout) => {
        const value = String(stdout || '').trim();
        if (value === 'NO_SESSION') {
          reject(new Error('QQ 音乐没有在播放，无法调节音量'));
          return;
        }
        if (error) {
          reject(new Error(value || error.message));
          return;
        }
        const volume = Number(value);
        if (!Number.isFinite(volume)) {
          reject(new Error('读取 QQ 音乐音量失败'));
          return;
        }
        resolve(Math.round(volume));
      },
    );
  });
}

/** 解析外部传入的音量值，兼容数字与「50%」这类字符串；无法解析时返回 null。 */
function parseVolumeValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value ?? '').trim();
  const match = text.match(/(\d+(?:\.\d+)?)(?:%|％)?/);
  return match ? Number(match[1]) : null;
}

function clampVolume(value) {
  const number = parseVolumeValue(value);
  if (number === null) return null;
  return Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, Math.round(number)));
}

function formatSong(song) {
  return `${song.title} - ${song.artist}`;
}

let dailyRecommendCache = { date: '', songs: [] };

async function fetchQQNewSongs() {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  if (dailyRecommendCache.date === date && dailyRecommendCache.songs.length) {
    return dailyRecommendCache.songs;
  }
  const response = await fetchJsonPost(
    'https://u.y.qq.com/cgi-bin/musicu.fcg?format=json',
    {
      comm: {
        ct: 24,
        cv: 4747474,
        platform: 'yqq.json',
        uin: '0',
        format: 'json',
        inCharset: 'utf-8',
        outCharset: 'utf-8',
        notice: 0,
        need_new_code: 1,
      },
      req_0: {
        module: 'newsong.NewSongServer',
        method: 'get_new_song_info',
        param: { type: 5 },
      },
    },
    { Referer: 'https://y.qq.com/' },
  );
  const list = response && response.req_0 && response.req_0.data && response.req_0.data.songlist;
  const songs = (Array.isArray(list) ? list : [])
    .map((song) => {
      const id = String(song.id || '');
      if (!/^\d+$/.test(id)) return null;
      return {
        source: 'qq',
        id,
        songmid: song.mid || '',
        title: decodeEntities(song.name || song.title),
        artist: (song.singer || []).map((item) => item.name).filter(Boolean).join(' / ') || '未知歌手',
        album: decodeEntities((song.album && song.album.name) || ''),
        duration: Math.max(0, Number(song.interval) || 0) * 1000,
        cover: song.album && song.album.mid
          ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${song.album.mid}.jpg`
          : '',
        webUrl: song.mid ? `https://y.qq.com/n/ryqq/songDetail/${song.mid}` : 'https://y.qq.com/',
        recommend: true,
        requestedBy: '每日推荐',
      };
    })
    .filter(Boolean);
  if (songs.length) dailyRecommendCache = { date, songs };
  return songs;
}

export function createSongManager(options = {}) {
  const emit = options.emit || (() => {});
  const now = options.now || (() => Date.now());
  const searchImpl = options.searchImpl || searchByProvider;
  const playImpl = options.playImpl || null;
  const urlImpl = options.urlImpl || ((id, br) => resolveNeteaseUrl(id, br, config.neteaseCookie));
  const recommendImpl = options.recommendImpl || fetchQQNewSongs;
  const config = { ...DEFAULTS, ...(options.config || {}) };

  const state = {
    queue: [],
    current: null,
    history: [],
    paused: false,
    timer: null,
    cutTimer: null,
    queueCutTimer: null,
    startupTimer: null,
    externalTimer: null,
    externalNow: null,
    externalMismatch: 0,
    externalPolling: false,
    recommendPool: [],
    recommendIndex: 0,
    startedAt: 0,
    elapsed: 0,
    cooldowns: new Map(),
    lastError: '',
  };

  function available() {
    return {
      qq: Boolean(config.qqExe || findQQMusic()),
      netease: Boolean(config.neteaseExe || findNeteaseMusic()),
      kugou: Boolean(config.kugouExe || findKugou()),
    };
  }

  const persistPath = String(options.persistPath || '');
  const violationPath = String(options.violationPath || '');
  let persistTimer = 0;

  // 违规歌曲 / 拉黑用户存储：启动即加载，供点歌前置校验使用
  const violationStore = createViolationStore({ path: violationPath, now });
  violationStore.load();

  /** 真正写队列存档；失败会抛错，供 moderateSong 回滚。 */
  function writeStateFile() {
    if (!persistPath) return;
    const payload = {
      version: 1,
      savedAt: now(),
      queue: state.queue,
      current: state.current,
      paused: state.paused,
      elapsed: currentElapsed(),
    };
    mkdirSync(path.dirname(persistPath), { recursive: true });
    const temp = `${persistPath}.tmp`;
    writeFileSync(temp, JSON.stringify(payload), 'utf8');
    renameSync(temp, persistPath);
  }

  function persistState() {
    if (!persistPath) return;
    try {
      writeStateFile();
    } catch {
      /* 队列持久化失败不影响播放 */
    }
  }

  function schedulePersist() {
    if (!persistPath) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = 0;
      persistState();
    }, 250);
  }

  function restorePersistedState() {
    if (!persistPath) return;
    try {
      const saved = JSON.parse(readFileSync(persistPath, 'utf8'));
      if (Array.isArray(saved.queue)) {
        state.queue = saved.queue.filter(
          (item) =>
            item &&
            !violationStore.findExact(item.title, item.artist) &&
            !HORROR_SONG_RE.test(`${item.title || ''} ${item.artist || ''}`) &&
            !findSensitiveSongWord(`${item.title || ''} ${item.artist || ''}`),
        );
      }
      if (
        saved.current &&
        typeof saved.current === 'object' &&
        !HORROR_SONG_RE.test(`${saved.current.title || ''} ${saved.current.artist || ''}`) &&
        !findSensitiveSongWord(`${saved.current.title || ''} ${saved.current.artist || ''}`)
      ) {
        state.current = saved.current;
        state.paused = Boolean(saved.paused);
        const elapsed =
          Number(saved.elapsed) +
          (state.paused ? 0 : Math.max(0, now() - Number(saved.savedAt || now())));
        state.elapsed = Math.max(0, elapsed);
        state.startedAt = now();
        if (!state.paused) {
          const total = Number(state.current.duration) || 240000;
          scheduleNext(Math.max(5000, total - state.elapsed));
        }
      }
    } catch {
      /* 首次启动没有存档 */
    }
  }

  function chooseProvider() {
    // 只走 QQ 音乐：忽略扩展或旧配置里的 netease / kugou / local
    return 'qq';
  }

  function snapshot() {
    const elapsed = currentElapsed();
    return {
      ok: true,
      provider: chooseProvider(),
      available: available(),
      current: state.current,
      queue: state.queue,
      paused: state.paused,
      elapsed,
      external: state.externalNow,
      minPlaySec: Math.round(minPlayMs() / 1000),
      queueCutSec: Math.round(queueCutMs() / 1000),
      dailyRecommend: config.dailyRecommend !== false,
      lastError: state.lastError,
      moderation: {
        violations: violationStore.listViolations().length,
        blockedUsers: violationStore.snapshot().blockedUsers.length,
      },
    };
  }

  function minPlayMs() {
    return Math.max(0, Number(config.minPlaySec) || 0) * 1000;
  }

  const EXTERNAL_APPS = [
    { process: 'QQMusic', label: 'QQ 音乐', suffix: 'QQ音乐' },
    { process: 'cloudmusic', label: '网易云音乐', suffix: '网易云音乐' },
    { process: 'KuGou', label: '酷狗音乐', suffix: '酷狗音乐' },
    { process: 'Spotify', label: 'Spotify', suffix: 'Spotify' },
  ];

  function parseExternalTitle(processName, rawTitle) {
    const app = EXTERNAL_APPS.find((item) => item.process === processName) || {
      label: processName || '系统播放器',
      suffix: '',
    };
    let text = String(rawTitle || '').trim();
    if (!text) return null;
    for (const suffix of [app.suffix, app.label, 'QQ音乐', '网易云音乐', '酷狗音乐']) {
      if (suffix && text.endsWith(` - ${suffix}`)) text = text.slice(0, -(suffix.length + 3)).trim();
      if (suffix && text === suffix) return null;
    }
    if (!text || text === processName) return null;
    const parts = text.split(/\s+-\s+/);
    const title = parts[0] ? parts[0].trim() : '';
    if (!title) return null;
    return {
      source: 'external',
      title,
      artist: parts.slice(1).join(' / ').trim() || '未知歌手',
      app: app.label,
      updatedAt: now(),
    };
  }

  function pollExternalMedia() {
    if (state.externalPolling) return;
    state.externalPolling = true;
    const script =
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8; foreach($n in 'QQMusic','cloudmusic','KuGou','Spotify'){ $p=Get-Process $n -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -First 1; if($p){ Write-Output ($p.ProcessName + '|' + $p.MainWindowTitle); break } }";
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 5000 },
      (error, stdout) => {
        state.externalPolling = false;
        if (error) return;
        const line = String(stdout || '').trim().split(/\r?\n/).pop() || '';
        const splitAt = line.indexOf('|');
        const next =
          splitAt > 0 ? parseExternalTitle(line.slice(0, splitAt), line.slice(splitAt + 1)) : null;
        const previous = state.externalNow;
        if (!next) {
          state.externalNow = null;
          state.externalMismatch = 0;
          return;
        }
        if (
          !previous ||
          previous.title !== next.title ||
          previous.artist !== next.artist ||
          previous.app !== next.app
        ) {
          state.externalNow = next;
        }
        // 当前曲可能已经播完、被手动切走，或者 QQ 自己跳到了下一首：
        // 连续两轮对不上就把记录清掉，背景板直接显示 QQ 的实际播放
        if (currentPlaybackMismatch()) {
          state.externalMismatch = (Number(state.externalMismatch) || 0) + 1;
          if (state.externalMismatch >= 2) dropStaleCurrent();
        } else {
          state.externalMismatch = 0;
        }
      },
    );
  }

  function startExternalMediaWatch() {
    pollExternalMedia();
    state.externalTimer = setInterval(pollExternalMedia, 4000);
    if (state.externalTimer.unref) state.externalTimer.unref();
  }

  function currentElapsed() {
    if (!state.current) return 0;
    if (state.paused) return state.elapsed;
    return state.elapsed + Math.max(0, now() - state.startedAt);
  }

  /**
   * 记录里的当前曲是否已经和 QQ 实际播放对不上。
   * 只比对 QQ 来源的歌曲；本地播放（背景板 <audio>）不参与，
   * 刚开播 6 秒内也跳过，避免 QQ 窗口标题还没刷新时误判。
   */
  function currentPlaybackMismatch() {
    const current = state.current;
    const external = state.externalNow;
    if (!current || !external) return false;
    if (current.playMode === 'local' || current.source !== 'qq') return false;
    if (!/qq/i.test(String(external.app || ''))) return false;
    if (currentElapsed() < 6000) return false;
    return !songMatches(external, current.title, current.artist);
  }

  /** 清掉已经没在播的当前曲，并让队列尽快接上，展示以 QQ 实际播放为准 */
  function dropStaleCurrent() {
    if (!state.current) return false;
    state.current = null;
    state.paused = false;
    state.elapsed = 0;
    state.externalMismatch = 0;
    state.lastError = '';
    publish('external_sync');
    if (state.queue.length) scheduleNext(5000);
    return true;
  }

  function publish(kind = 'update') {
    schedulePersist();
    emit({ kind: 'song', action: kind, at: now(), data: snapshot() });
  }

  function clearTimer() {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  function clearCutTimer() {
    if (state.cutTimer) {
      clearTimeout(state.cutTimer);
      state.cutTimer = null;
    }
  }

  function clearQueueCutTimer() {
    if (state.queueCutTimer) {
      clearTimeout(state.queueCutTimer);
      state.queueCutTimer = null;
    }
  }

  function clearTimers() {
    clearTimer();
    clearCutTimer();
    clearQueueCutTimer();
  }

  function queueCutMs() {
    const seconds = Math.max(10, Number(config.queueCutSec) || 90);
    return Math.max(minPlayMs(), seconds * 1000);
  }

  function scheduleQueueCut() {
    // 不再自动切歌：当前歌曲只有播完、主播手动下一首，或观众切歌才会结束。
    clearQueueCutTimer();
  }

  async function takeRecommendation() {
    if (config.dailyRecommend === false) return null;
    if (!state.recommendPool.length || state.recommendIndex >= state.recommendPool.length) {
      try {
        state.recommendPool = await recommendImpl();
      } catch {
        state.recommendPool = [];
      }
      state.recommendIndex = 0;
    }
    if (!state.recommendPool.length) return null;
    let song = state.recommendPool[state.recommendIndex++];
    if (state.current && song.id === state.current.id && state.recommendIndex < state.recommendPool.length) {
      song = state.recommendPool[state.recommendIndex++];
    }
    return {
      ...song,
      requestId: `rec-${now()}-${Math.random().toString(36).slice(2, 6)}`,
      requestedBy: '每日推荐',
      requesterKey: 'daily',
      requestedAt: now(),
      priority: false,
      recommend: true,
    };
  }

  function scheduleNext(remaining) {
    clearTimer();
    const wait = Math.max(5000, Number(remaining) || 0);
    state.timer = setTimeout(() => {
      state.timer = null;
      playNext('auto').catch(() => {});
    }, wait + 1200);
  }

  function schedulePriorityCut() {
    // 插队只改变队列顺序，不再提前切当前歌曲。
    clearCutTimer();
  }

  async function dispatch(song) {
    if (playImpl) {
      await playImpl(song);
      return { mode: 'injected' };
    }
    if (config.playCommand) {
      const command = config.playCommand
        .replaceAll('{id}', song.id || '')
        .replaceAll('{hash}', song.hash || '')
        .replaceAll('{songmid}', song.songmid || '')
        .replaceAll('{title}', song.title || '')
        .replaceAll('{artist}', song.artist || '')
        .replaceAll('{query}', song.title || '')
        .replaceAll('{url}', song.webUrl || '');
      await runDetached('cmd.exe', ['/c', command]);
      return { mode: 'custom' };
    }
    // 本地播放：网易云直链交给背景板 <audio>，不依赖任何第三方客户端
    if (config.player === 'local') {
      if (song.source === 'netease') {
        let url = await urlImpl(song.id, 320000);
        if (!url) url = await urlImpl(song.id, 128000);
        if (!url) throw new Error('这首受版权限制无法自动播放，试试点别的歌');
        song.playUrl = url;
        return { mode: 'local' };
      }
      // 本地模式只有网易云直链可靠；其他来源一律回网易云按歌名重搜
      const alt = await searchImpl(song.title || '', 'netease').catch(() => null);
      if (alt && alt.source === 'netease') {
        let url = await urlImpl(alt.id, 320000);
        if (!url) url = await urlImpl(alt.id, 128000);
        if (url) {
          song.playUrl = url;
          song.localMatched = `${alt.title} - ${alt.artist}`;
          return { mode: 'local' };
        }
      }
      throw new Error('没拿到可播放的音频直链，试试点别的歌');
    }
    if (song.source === 'qq') {
      const exe = config.qqExe || findQQMusic();
      if (exe) {
        const songId = String(song.id || '').trim();
        if (!/^\d+$/.test(songId)) throw new Error('QQ 音乐歌曲 ID 不是数字，无法调用客户端');
        await handoffQQ(exe, songId);
        if (await waitQQPlaying(song.title, song.artist, 10000)) return { mode: 'app' };
        throw new Error('QQ 音乐没有切到这首歌，请检查客户端状态');
      }
    }
    if (song.source === 'netease') {
      const exe = config.neteaseExe || findNeteaseMusic();
      if (exe && protocolRegistered('orpheus')) {
        await openExternal(`orpheus://song/${song.id}`);
        return { mode: 'app' };
      }
    }
    if (song.source === 'kugou') {
      const exe = config.kugouExe || findKugou();
      if (exe && (protocolRegistered('kugou') || protocolRegistered('kugoumusic')) && song.hash) {
        await openExternal(`kugou://play?hash=${encodeURIComponent(song.hash)}`);
        return { mode: 'app' };
      }
    }
    await openExternal(song.webUrl || 'https://y.qq.com/');
    return { mode: 'web' };
  }

  async function playNext(reason = 'manual', force = false) {
    clearTimers();
    if (state.current && !force && currentElapsed() < minPlayMs()) {
      const wait = minPlayMs() - currentElapsed();
      scheduleNext(wait);
      return { ok: false, error: '当前歌曲还没满 1 分钟', waitSec: Math.ceil(wait / 1000) };
    }
    const previous = state.current;
    let picked = state.queue.shift();
    if (!picked && state.current && config.dailyRecommend !== false) {
      picked = await takeRecommendation();
    }
    if (!picked) {
      state.current = null;
      state.paused = false;
      state.elapsed = 0;
      publish('idle');
      return { ok: true, done: true };
    }
    state.current = picked;
    state.paused = false;
    state.elapsed = 0;
    state.startedAt = now();
    try {
      const result = await dispatch(picked);
      state.current.playMode = result.mode;
      state.lastError = '';
    } catch (error) {
      state.lastError = error.message;
      // 切歌失败时客户端通常还在放上一首：回滚展示，避免背景板显示没在播的歌
      state.current = previous || null;
      if (previous) {
        state.queue = state.queue.filter(
          (item) => !item || item.requestId !== previous.requestId,
        );
      }
      // 交接失败不要把点歌直接弄丢：前两次失败先塞回队头重试，第三次才跳过
      picked.attempts = (Number(picked.attempts) || 0) + 1;
      if (picked.attempts < 3 && !state.queue.some((item) => item && item.requestId === picked.requestId)) {
        state.queue.unshift(picked);
      }
      // 播放失败（版权限制/没拿到直链/客户端没切过去）：5 秒后尝试下一首，避免整段静音
      scheduleNext(5000);
      schedulePriorityCut();
      scheduleQueueCut();
      publish('play_failed');
      return { ok: false, error: error.message };
    }
    scheduleNext(Math.max(minPlayMs(), picked.duration || 240000));
    schedulePriorityCut();
    scheduleQueueCut();
    publish(
      reason === 'auto'
        ? 'next'
        : reason === 'priority'
          ? 'priority'
          : picked.recommend
            ? 'recommend'
            : 'play',
    );
    return { ok: true, song: picked };
  }

  async function request({
    query,
    user = '观众',
    userKey,
    provider = '',
    neteaseCookie,
    cooldownSec,
    minPlaySec,
    queueCutSec,
    dailyRecommend,
    priority = false,
    forcePlay = false,
  } = {}) {
    const text = String(query || '').trim().slice(0, 100);
    if (!text) return { ok: false, error: '点歌内容为空' };
    // 政治 / 国歌 / 红歌等敏感内容直接拒绝，避免直播间被封
    if (findSensitiveSongWord(text)) {
      return { ok: false, error: SENSITIVE_SONG_MESSAGE, sensitive: true };
    }
    if (typeof neteaseCookie === 'string') {
      config.neteaseCookie = neteaseCookie.trim().slice(0, 4000);
    }
    if (minPlaySec != null) {
      config.minPlaySec = Math.max(10, Math.min(600, Number(minPlaySec) || 60));
    }
    if (queueCutSec != null) {
      config.queueCutSec = Math.max(10, Math.min(600, Number(queueCutSec) || 90));
    }
    if (typeof dailyRecommend === 'boolean') config.dailyRecommend = dailyRecommend;
    const selected = chooseProvider(provider);
    const displayName = String(user || '观众');
    const key = String(userKey || displayName);
    // 被拉黑的用户（点过违规歌曲）：后续点歌请求直接拒绝，不再搜索 / 入队
    if (violationStore.isBlocked(key)) {
      return {
        ok: false,
        blacklisted: true,
        error: '该用户已被拉黑，点歌请求不再处理',
      };
    }
    const sameUserCount = [state.current, ...state.queue].filter(
      (item) => item && String(item.requesterKey || item.requestedBy || '') === key,
    ).length;
    void cooldownSec;

    let song;
    try {
      song = await searchImpl(text, selected);
    } catch (error) {
      return { ok: false, error: error.message || '搜索失败' };
    }
    // 搜索词可能很宽泛，命中结果的歌名/歌手也要再核对一次
    if (song && findSensitiveSongWord(`${song.title || ''} ${song.artist || ''}`)) {
      return { ok: false, error: SENSITIVE_SONG_MESSAGE, sensitive: true };
    }
    // 前置校验：命中历史违规曲目，直接把点歌人拉黑并拒绝
    if (song && violationStore.findExact(song.title, song.artist)) {
      try {
        violationStore.blockUser({ userKey: key, nickname: displayName, reason: '点播已标记违规的歌曲' });
        violationStore.persist();
      } catch {
        /* 落盘失败仍拒绝点歌，不影响拉黑的内存状态 */
      }
      return {
        ok: false,
        violation: true,
        blacklisted: true,
        error: '这首歌已被列为违规曲目，点歌请求已拒绝',
      };
    }

    // 点歌前先对账：记录里的“正在播放”可能已经结束或被手动切走，
    // 不清掉的话会把没在播的歌说成“正在播放中”
    if (currentPlaybackMismatch()) dropStaleCurrent();

    const duplicate = [state.current, ...state.queue].find(
      (item) => item && sameSongEntry(item, song) && (item === state.current || !item.recommend),
    );
    if (duplicate) {
      return {
        ok: false,
        error: state.current === duplicate ? '这首歌正在播放' : '这首歌已经在队列里了',
        alreadyQueued: true,
        duplicateState: state.current === duplicate ? 'current' : 'queue',
        position: state.current === duplicate ? 0 : state.queue.indexOf(duplicate) + 1,
        song: duplicate,
        requestedBy: duplicate.requestedBy || '',
      };
    }

    const entry = {
      ...song,
      requestId: `song-${now()}-${Math.random().toString(36).slice(2, 6)}`,
      requestedBy: displayName,
      requesterKey: key,
      requestedAt: now(),
      priority: false,
    };

    // 所有新点歌先进入免费区；送礼后再由 prioritizeUserQueue 移动
    state.queue.push(entry);
    void priority;
    state.cooldowns.set(key, now());

    if (forcePlay) {
      state.queue = state.queue.filter((item) => item.requestId !== entry.requestId);
      if (state.current) state.queue.unshift(state.current);
      state.queue.unshift(entry);
      const played = await playNext('test', true);
      if (played && played.ok === false) {
        return { ok: false, error: played.error || '播放失败', song: entry };
      }
    } else if (!state.current && config.autoPlay !== false) {
      // 就算 QQ 音乐正在放它自己的歌单，也要把观众点的歌接上，不能一直播系统歌曲
      const played = await playNext('request');
      if (played && played.ok === false) {
        return { ok: false, error: played.error || '播放失败', song: entry };
      }
    } else {
      // 当前歌曲不主动切：新请求只排队，等当前歌播完或观众发切歌指令。
      publish('queued');
    }

    const isCurrent = state.current && state.current.requestId === entry.requestId;
    return {
      ok: true,
      song: entry,
      label: formatSong(entry),
      priority: entry.priority,
      note: entry.searchNote || '',
      sameUserCount,
      hint: sameUserCount > 0 && !entry.priority ? '同一用户再点可送小心心插队' : '',
      position: isCurrent
        ? 0
        : state.queue.findIndex((item) => item.requestId === entry.requestId) + 1,
      queueLength: state.queue.length,
      switchInSec: 0,
    };
  }

  async function cut({ user = '观众', userKey } = {}) {
    const key = String(userKey || user || '');
    // 被拉黑用户不再处理切歌请求
    if (violationStore.isBlocked(key)) {
      return { ok: false, reason: 'blacklisted', blacklisted: true, error: '该用户已被拉黑，切歌请求不再处理' };
    }
    // 切歌条件：自己的歌正在播放，或队列里有自己待播放的点歌
    const ownsCurrent = Boolean(
      state.current &&
        !state.current.recommend &&
        String(state.current.requesterKey || state.current.requestedBy || '') === key,
    );
    const ownsQueuedRequest = state.queue.some(
      (item) =>
        item &&
        !item.recommend &&
        String(item.requesterKey || item.requestedBy || '') === key,
    );
    if (!state.current) {
      if (!state.queue.length) {
        return { ok: false, reason: 'idle', error: '当前没有播放中的歌曲' };
      }
      if (!ownsQueuedRequest) {
        return {
          ok: false,
          reason: 'need_request',
          error: '你当前没有正在播放或排队中的点歌，先发送「点歌 歌名」才能切歌',
        };
      }
      // 系统播放器在放别的歌、我们的队列还没开播：直接把自己的点歌接上
      const started = await playNext('cut', true);
      return {
        ok: Boolean(started.ok),
        reason: started.ok ? 'cut' : 'failed',
        error: started.ok ? '' : started.error || '切歌失败',
        song: started.song || null,
        previous: null,
        cutBy: String(user || ''),
      };
    }
    if (state.paused) {
      return { ok: false, reason: 'paused', error: '当前歌曲是暂停状态' };
    }
    if (!ownsCurrent && !ownsQueuedRequest) {
      return {
        ok: false,
        reason: 'need_request',
        error: '你当前没有正在播放或排队中的点歌，先发送「点歌 歌名」才能切歌',
      };
    }
    const waitSec = Math.max(0, Math.ceil((queueCutMs() - currentElapsed()) / 1000));
    if (waitSec > 0) {
      return {
        ok: false,
        reason: 'too_early',
        waitSec,
        error: `当前歌曲还没满 ${Math.round(queueCutMs() / 1000)} 秒，还需 ${waitSec} 秒`,
      };
    }
    if (!state.queue.length) {
      return { ok: false, reason: 'empty', error: '队列里没有下一首，先点歌吧' };
    }
    const previous = state.current;
    const result = await playNext('cut', true);
    return {
      ok: Boolean(result.ok),
      reason: result.ok ? 'cut' : 'failed',
      song: result.song || null,
      previous,
      cutBy: String(user || ''),
    };
  }

  function prioritizeUserQueue({ user = '观众', userKey } = {}) {
    const key = String(userKey || user || '');
    // 被拉黑用户不再处理插队请求
    if (violationStore.isBlocked(key)) {
      return { ok: false, reason: 'blacklisted', blacklisted: true, error: '该用户已被拉黑，插队请求不再处理' };
    }
    const index = state.queue.findIndex(
      (item) =>
        item &&
        !item.recommend &&
        String(item.requesterKey || item.requestedBy || '') === key,
    );
    if (index < 0) return { ok: true, moved: 0, reason: 'no_queue_song' };
    const target = state.queue[index];
    if (target.priority) {
      if (index === 0) {
        return { ok: true, moved: 0, reason: 'already_top', title: target.title };
      }
      // 已在插队区：和最上面那首互换，只前进一位
      [state.queue[index - 1], state.queue[index]] = [
        state.queue[index],
        state.queue[index - 1],
      ];
      publish('priority');
      return {
        ok: true,
        moved: 1,
        zone: 'priority',
        title: target.title,
        position: index,
        queueLength: state.queue.length,
      };
    }
    // 在免费区：移动到插队区最后一位
    const rest = state.queue.filter((_, itemIndex) => itemIndex !== index);
    target.priority = true;
    const firstFree = rest.findIndex((item) => !item.priority);
    const insertAt = firstFree < 0 ? rest.length : firstFree;
    rest.splice(insertAt, 0, target);
    state.queue = rest;
    publish('priority');
    return {
      ok: true,
      moved: 1,
      zone: 'free',
      title: target.title,
      position: insertAt,
      queueLength: state.queue.length,
    };
  }
  /**
   * 违规歌曲处置：写入违规记录 + 拉黑点歌人 + 从队列移除。
   * 队列与违规文件任一步写盘失败，就恢复队列和 store 快照并重新落盘后返回失败。
   */
  async function moderateSong({
    requestId,
    title,
    artist,
    reason,
    allowPlay,
    requesterKey,
    requester,
  } = {}) {
    const rid = String(requestId || '');
    let index = -1;
    if (rid) {
      index = state.queue.findIndex((item) => item && String(item.requestId || '') === rid);
    }
    // 按 requestId 没找到时，再用「歌名 + 歌手」完全匹配
    if (index < 0) {
      const wantTitle = String(title || '');
      const wantArtist = String(artist || '');
      index = state.queue.findIndex(
        (item) => item && sameSongExact(item.title, item.artist, wantTitle, wantArtist),
      );
    }
    if (index < 0) return { ok: false, error: '队列里没有找到这首歌，可能已经播完或被移除' };

    const target = state.queue[index];
    const songTitle = String(target.title || title || '');
    const songArtist = String(target.artist || artist || '');
    const userKey = String(target.requesterKey || requesterKey || '');
    const nickname = String(target.requestedBy || requester || '');
    // 自动点歌（requesterKey 为 auto-song）或没有用户标识时跳过拉黑
    const shouldBlock = Boolean(userKey) && userKey !== 'auto-song';

    const queueSnapshot = [...state.queue];
    const storeSnapshot = violationStore.snapshot();
    let recordId = '';
    let removedOtherSongs = [];
    try {
      const record = violationStore.addViolation({
        title: songTitle,
        artist: songArtist,
        reason: String(reason || ''),
        allowPlay: Boolean(allowPlay),
        requester: nickname,
        requesterKey: userKey,
      });
      recordId = record.id;
      if (shouldBlock) {
        violationStore.blockUser({ userKey, nickname, reason: String(reason || '') });
      }
      violationStore.persist();
      // 违规歌曲移除时，同一点歌人的其他点歌一并清理（只移出队列，不写入违规名单）
      const nextQueue = [];
      state.queue.forEach((item, i) => {
        if (i === index) return;
        const itemKey = String((item && item.requesterKey) || '');
        if (shouldBlock && itemKey === userKey) {
          removedOtherSongs.push({
            title: String((item && item.title) || ''),
            artist: String((item && item.artist) || ''),
            removedIndex: i,
          });
          return;
        }
        nextQueue.push(item);
      });
      state.queue = nextQueue;
      // 队列写盘失败同样触发回滚，保证内存与磁盘一致
      writeStateFile();
    } catch (error) {
      state.queue = queueSnapshot;
      removedOtherSongs = [];
      violationStore.restore(storeSnapshot);
      try {
        writeStateFile();
      } catch {
        /* 回滚时队列写盘失败也只能忽略，避免掩盖原始错误 */
      }
      try {
        violationStore.persist();
      } catch {
        /* 回滚时违规文件写盘失败同样忽略 */
      }
      return { ok: false, error: `违规歌曲处置写盘失败，已回滚：${error.message}` };
    }

    publish('purge');
    return {
      ok: true,
      removedIndex: index,
      removedSong: { title: songTitle, artist: songArtist },
      removedOtherSongs,
      removedCount: 1 + removedOtherSongs.length,
      recordId,
      blocked: shouldBlock,
      queueLength: state.queue.length,
    };
  }

  /** 违规歌曲 / 拉黑用户的当前快照，供查询接口使用。 */
  function violationSnapshot() {
    return violationStore.snapshot();
  }

  function clearAllCache() {
    clearTimers();
    state.queue = [];
    state.current = null;
    state.paused = false;
    state.elapsed = 0;
    state.startedAt = 0;
    state.history = [];
    try {
      if (persistPath) unlinkSync(persistPath);
    } catch {
      /* 没有存档 */
    }
    return { ok: true };
  }
  function purgeHorror() {
    const before = state.queue.length;
    state.queue = state.queue.filter(
      (item) => !HORROR_SONG_RE.test(`${item.title || ''} ${item.artist || ''}`),
    );
    const removedQueue = before - state.queue.length;
    const removedCurrent =
      Boolean(state.current) &&
      HORROR_SONG_RE.test(`${state.current.title || ''} ${state.current.artist || ''}`);
    if (removedCurrent) {
      clearTimers();
      state.current = null;
      state.paused = false;
      state.elapsed = 0;
    }
    if (removedQueue || removedCurrent) publish('purge');
    return { ok: true, removedQueue, removedCurrent, queueLength: state.queue.length };
  }
  async function pause() {
    if (!state.current) {
      await pressMediaKey('playpause');
      return { ok: true, external: true };
    }
    // 本地播放由背景板 audio 暂停/恢复，不需要媒体键
    if (state.current.playMode !== 'local') await pressMediaKey('playpause');
    if (state.paused) {
      state.paused = false;
      state.startedAt = now();
      scheduleNext(Math.max(minPlayMs(), (state.current.duration || 0) - state.elapsed));
      schedulePriorityCut();
      scheduleQueueCut();
    } else {
      state.paused = true;
      state.elapsed += now() - state.startedAt;
      clearTimers();
    }
    publish('pause');
    return { ok: true, paused: state.paused };
  }

  async function skip() {
    clearTimers();
    if (state.current || state.queue.length) {
      return playNext('skip', true);
    }
    await pressMediaKey('next');
    state.current = null;
    state.paused = false;
    state.elapsed = 0;
    publish('skip');
    return { ok: true, done: true };
  }

  function clearQueue() {
    state.queue = [];
    clearCutTimer();
    clearQueueCutTimer();
    publish('clear');
    return { ok: true };
  }

  function configure(patch = {}) {
    for (const key of Object.keys(DEFAULTS)) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) config[key] = patch[key];
    }
    publish('config');
    return snapshot();
  }

  /** 调节 QQ 音乐应用音量，范围固定 20%~70%，超出范围按边界值生效。 */
  async function setVolume(payload = {}) {
    const action = String(payload.action || 'set').toLowerCase();
    try {
      let current = null;
      let target;
      if (action === 'max') target = VOLUME_MAX;
      else if (action === 'min') target = VOLUME_MIN;
      else if (action === 'up' || action === 'down') {
        current = await runQQVolume(['-Action', 'get']);
        const step = Math.max(1, Math.abs(Math.round(parseVolumeValue(payload.step) ?? VOLUME_STEP)));
        target = action === 'up' ? current + step : current - step;
      } else if (action === 'set') {
        target = parseVolumeValue(payload.value ?? payload.volume);
        if (target === null) {
          return {
            ok: false,
            error: `请给出 ${VOLUME_MIN}~${VOLUME_MAX} 之间的音量数值`,
            min: VOLUME_MIN,
            max: VOLUME_MAX,
          };
        }
        // 指定音量不依赖当前音量，读不到也不影响设置
        try {
          current = await runQQVolume(['-Action', 'get']);
        } catch {
          current = null;
        }
      } else {
        return { ok: false, error: '不支持的音量操作', min: VOLUME_MIN, max: VOLUME_MAX };
      }
      const requested = Math.round(target);
      const volume = clampVolume(requested);
      if (volume === null) return { ok: false, error: '音量值不正确', min: VOLUME_MIN, max: VOLUME_MAX };
      const actual = await runQQVolume(['-Action', 'set', '-Volume', String(volume)]);
      return {
        ok: true,
        volume: actual,
        requested,
        clamped: volume !== requested,
        previous: current,
        min: VOLUME_MIN,
        max: VOLUME_MAX,
      };
    } catch (error) {
      return { ok: false, error: error.message, min: VOLUME_MIN, max: VOLUME_MAX };
    }
  }

  function dispose() {
    clearTimers();
    if (state.startupTimer) {
      clearTimeout(state.startupTimer);
      state.startupTimer = null;
    }
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = 0;
    }
    persistState();
    if (state.externalTimer) clearInterval(state.externalTimer);
  }

  restorePersistedState();
  if (options.externalWatch) startExternalMediaWatch();
  // 启动时队列里还有点歌但当前没在播（比如客户端在放自己的歌单）：直接让队列接管播放
  if (!state.current && state.queue.length && config.autoPlay !== false) {
    state.startupTimer = setTimeout(() => {
      state.startupTimer = null;
      if (!state.current && state.queue.length && config.autoPlay !== false) {
        playNext('auto').catch(() => {});
      }
    }, 2500);
    if (state.startupTimer.unref) state.startupTimer.unref();
  }

  return {
    request,
    cut,
    purgeHorror,
    clearAllCache,
    prioritizeUserQueue,
    moderateSong,
    violationSnapshot,
    skip,
    pause,
    clearQueue,
    configure,
    setVolume,
    snapshot,
    dispose,
    config,
  };
}

export const SONG_PROVIDERS = ['auto', 'qq', 'netease', 'kugou'];
