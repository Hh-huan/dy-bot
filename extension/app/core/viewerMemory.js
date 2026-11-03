/** 单场直播的观众记忆：点歌、发言（最多 20 条）、送礼，用于回答“还记得我吗”。 */
import { intimacySpokenLevel, levelForPoints } from './intimacy.js';

export const MEMORY_MIN_CHARS = 20;
export const MEMORY_MAX_CHARS = 50;

const MAX_CHATS = 20;
const MAX_GIFTS = 20;
const MAX_SONGS = 10;
// 跨直播记忆只留最近几次具体行为，用于进场时的「老朋友重逢」彩蛋
const MAX_DETAIL_SONGS = 3;
const MAX_DETAIL_GIFTS = 3;
export const REUNION_MAX_CHARS = 72;

const MEMORY_QUESTION_RE =
  /(?:还)?记(?:不)?得(?:我|人家)|记不记得(?:我|人家)|认识(?:我|人家)|知道(?:我|人家)是谁|(?:我|人家)是谁|对(?:我|人家)有印象|你(?:对我|对人家)?有印象/;

// 点歌/切歌/音量类指令里可能带“我是谁”等字样，不能被当成记忆提问
const NON_MEMORY_COMMAND_RE = /点歌|想听|来一首|唱一首|放一首|播一首|播放|切歌|音量/;

/** 判断弹幕是否在问“还记得我吗”这类问题。 */
export function isMemoryQuestion(content) {
  const text = String(content || '').replace(/\s+/g, '');
  if (!text || text.length > 40) return false;
  if (NON_MEMORY_COMMAND_RE.test(text)) return false;
  return MEMORY_QUESTION_RE.test(text);
}

/** 至少要有一条点歌 / 发言 / 送礼 / 关注 / 点赞 / 亲密度，才算有这个观众的记录。 */
export function hasViewerMemory(record) {
  if (!record) return false;
  return Boolean(
    (record.chats && record.chats.length) ||
      (record.gifts && record.gifts.length) ||
      (record.songs && record.songs.length) ||
      Number(record.followedAt) ||
      Number(record.likes) ||
      // 亲密度只给互动过的观众累计，进场签到也要能跨场次保留
      Number(record.intimacy && record.intimacy.points),
  );
}

function trimText(value, limit) {
  return Array.from(String(value || '').replace(/\s+/g, ' ').trim()).slice(0, limit).join('');
}

/** 抖音随用户下发的关注关系：followStatus > 0（1 已关注 / 2 互关）或已加入粉丝团，都说明关注了主播。 */
export function userFollowedAnchor(user) {
  if (!user) return false;
  if (Number(user.followStatus) > 0) return true;
  const club = user.fansClub;
  return Boolean(club && club.name && Number(club.level) > 0);
}

/** 把一条观众事件写入本场记忆（发言 / 送礼）。 */
export function recordViewerEvent(record, event, now = Date.now()) {
  if (!record || !event) return record;
  const user = event.user || {};
  record.name = String(user.nickname || record.name || '').trim();
  record.id = String(user.id || record.id || '');
  record.key = String(record.key || user.id || user.nickname || '');
  record.firstSeen = Number(record.firstSeen) || now;
  record.lastSeen = now;
  if (!Array.isArray(record.chats)) record.chats = [];
  if (!Array.isArray(record.gifts)) record.gifts = [];
  if (!Array.isArray(record.songs)) record.songs = [];
  record.followedAt = Number(record.followedAt) || 0;
  record.likedAt = Number(record.likedAt) || 0;
  record.likes = Number(record.likes) || 0;
  // 抖音下发的用户数据里带关注关系时直接记为已关注，不再依赖 follow 事件
  if (!record.followedAt && userFollowedAnchor(user)) record.followedAt = now;

  if (event.type === 'chat' && event.content) {
    const text = trimText(event.content, 80);
    if (text) {
      record.chats.push(text);
      while (record.chats.length > MAX_CHATS) record.chats.shift();
    }
  } else if (event.type === 'gift') {
    const gift = event.gift || {};
    // 连击中间帧的 count 是累计值：只在结束帧按最终数量记一次，避免重复统计
    if (gift.completed === false) return record;
    const name = trimText(gift.name || gift.giftName || event.giftName || '礼物', 20) || '礼物';
    const count = Math.max(1, Number(gift.count ?? event.count) || 1);
    record.gifts.push({ name, count, at: now });
    while (record.gifts.length > MAX_GIFTS) record.gifts.shift();
  } else if (event.type === 'follow') {
    record.followedAt = now;
  } else if (event.type === 'member') {
    // 抖音也可能把关注动作放在进场消息的 actionDescription 里（如「关注了主播」）
    const description = String((event.member && event.member.actionDescription) || '');
    if (/关注/.test(description)) record.followedAt = now;
  } else if (event.type === 'like') {
    const count = Math.max(1, Number(event.like && event.like.count) || 1);
    record.likes += count;
    record.likedAt = now;
  }
  return record;
}

/** 记录一次成功的点歌。 */
export function recordViewerSong(record, song, now = Date.now()) {
  if (!record || !song || !song.title) return record;
  if (!Array.isArray(record.songs)) record.songs = [];
  record.songs.push({
    title: trimText(song.title, 40),
    artist: trimText(song.artist, 30),
    at: now,
  });
  while (record.songs.length > MAX_SONGS) record.songs.shift();
  return record;
}

/** 生成给大模型看的观众记录摘要，控制在 600 字以内。 */
export function buildViewerDigest(record) {
  if (!record) return '无记录';
  const name = record.name || '观众';
  const chats = (record.chats || []).slice(-8).map((text) => `「${trimText(text, 40)}」`);
  const songs = (record.songs || []).slice(-5).map((song) => {
    const artist = song.artist ? ` - ${song.artist}` : '';
    return `《${song.title}》${artist}`;
  });
  const gifts = (record.gifts || []).slice(-5).map((gift) => `${gift.name}×${gift.count}`);
  const extras = [];
  if (Number(record.followedAt)) extras.push('已关注');
  if (Number(record.likes)) extras.push(`点赞 ${record.likes} 个`);
  const digest = [
    `昵称：${name}`,
    `本场发言：${chats.length ? chats.join(' / ') : '无'}`,
    `点歌：${songs.length ? songs.join('、') : '无'}`,
    `送礼：${gifts.length ? gifts.join('、') : '无'}`,
    extras.length ? `互动：${extras.join('、')}` : '',
  ]
    .filter(Boolean)
    .join('；');
  return Array.from(digest).slice(0, 600).join('');
}

/** 保证 AI 回答在 20~50 字之间；过短时补一句自然的收尾。 */
export function fitMemoryReply(text, nickname = '') {
  let value = String(text || '')
    .replace(/^["'「『]+|["'」』]+$/g, '')
    .replace(/\s+/g, '')
    .trim();
  if (!value) return '';
  if (Array.from(value).length < MEMORY_MIN_CHARS) {
    value += '，我可一直记着你呢，常来直播间玩呀';
  }
  value = Array.from(value).slice(0, MEMORY_MAX_CHARS).join('');
  if (nickname && !value.includes(nickname) && Array.from(value).length < MEMORY_MAX_CHARS - 6) {
    value = `${nickname}，${value}`;
    value = Array.from(value).slice(0, MEMORY_MAX_CHARS).join('');
  }
  return value;
}

/** AI 不可用 / 没有记录时的兜底回答，同样满足 20~50 字。 */
export function fallbackMemoryReply(record, nickname = '观众') {
  const name = nickname || record?.name || '观众';
  const song = record && record.songs && record.songs[record.songs.length - 1];
  const gift = record && record.gifts && record.gifts[record.gifts.length - 1];
  const chat = record && record.chats && record.chats[record.chats.length - 1];
  let text;
  if (song) {
    text = `${name}，我记得你点过《${song.title}》呀，谢谢你支持直播间，常来玩哦～`;
  } else if (gift) {
    text = `${name}，我记得你送过${gift.name}，谢谢你呀，我会一直记得你的，常来玩哦～`;
  } else if (record && Number(record.followedAt)) {
    text = `${name}，谢谢你关注我呀，我会一直记得你的，常来直播间玩哦～`;
  } else if (record && Number(record.likes)) {
    text = `${name}，谢谢你给我点了${record.likes}个赞，我记得你哦，常来玩呀～`;
  } else if (chat) {
    text = `${name}，我记得你在直播间说过“${trimText(chat, 10)}”，谢谢你陪我聊天，常来玩哦～`;
  } else {
    text = `${name}，第一次见你呀，不过我现在记住你啦，以后常来直播间玩哦～`;
  }
  return fitMemoryReply(text, name);
}

/** 送礼按礼物名汇总：同名连击数量累加，只留最近几种。 */
function summarizeGifts(gifts) {
  if (!Array.isArray(gifts)) return [];
  const byName = new Map();
  for (const item of gifts) {
    if (!item || !item.name) continue;
    const name = trimText(item.name, 20);
    if (!name) continue;
    byName.set(name, (byName.get(name) || 0) + Math.max(1, Number(item.count) || 1));
  }
  return [...byName.entries()]
    .slice(-MAX_DETAIL_GIFTS)
    .map(([name, count]) => ({ name, count }));
}

/** 单场结束时写入跨直播记忆的观众信息：一句话印象 + 具体行为明细。 */
export function buildViewerHistoryEntry(record) {
  if (!record) return null;
  const actions = [];
  if (record.chats && record.chats.length) actions.push('发言');
  if (record.gifts && record.gifts.length) actions.push('送礼');
  if (record.songs && record.songs.length) actions.push('点歌');
  if (Number(record.followedAt)) actions.push('关注');
  if (Number(record.likes)) actions.push('点赞');
  const noteParts = [];
  const song = record.songs && record.songs[record.songs.length - 1];
  const gift = record.gifts && record.gifts[record.gifts.length - 1];
  if (song) noteParts.push(`点过《${song.title}》`);
  if (gift) noteParts.push(`送过${gift.name}`);
  if (!noteParts.length && Number(record.likes)) noteParts.push(`点过${record.likes}个赞`);
  if (!noteParts.length && Number(record.followedAt)) noteParts.push('关注过鲸鱼娘');
  // 高亲密度观众在跨直播记忆里带上级别，AI 下次直播会更自然地用亲近的口吻招呼
  const intimacyPoints = Math.max(0, Number(record.intimacy && record.intimacy.points) || 0);
  const intimacyInfo = levelForPoints(intimacyPoints);
  if (intimacyInfo.level >= 5) {
    noteParts.unshift(`亲密度${intimacySpokenLevel(intimacyInfo.level)}${intimacyInfo.title}`);
  }
  const songs = (record.songs || [])
    .slice(-MAX_DETAIL_SONGS)
    .map((item) => ({ title: trimText(item.title, 40), artist: trimText(item.artist, 30) }))
    .filter((item) => item.title);
  const lastChat = record.chats && record.chats.length ? trimText(record.chats[record.chats.length - 1], 30) : '';
  return {
    key: String(record.key || record.id || record.name || ''),
    name: String(record.name || ''),
    id: String(record.id || ''),
    actions,
    note: noteParts.join('、').slice(0, 60),
    songs,
    gifts: summarizeGifts(record.gifts),
    likes: Math.max(0, Number(record.likes) || 0),
    lastChat,
    lastSeen: Number(record.lastSeen) || 0,
    intimacyPoints,
    intimacyLevel: intimacyInfo.level,
    intimacyTitle: intimacyInfo.title,
  };
}

/** 跨直播记忆里这位观众的摘要，交给大模型回答「还记得我吗」。 */
export function buildCrossViewerDigest(viewer) {
  if (!viewer) return '无记录';
  const parts = [`昵称：${viewer.name || '观众'}`];
  if (viewer.actions && viewer.actions.length) parts.push(`以前直播互动：${viewer.actions.join('、')}`);
  if (viewer.note) parts.push(`印象：${viewer.note}`);
  return `${parts.join('；')}（来自以前直播的记忆）`;
}

/** 单场没有记录、但跨直播记忆里有时使用，同样满足 20~50 字。 */
export function fallbackCrossReply(viewer, nickname = '观众') {
  if (!viewer) return '';
  const name = nickname || viewer.name || '观众';
  const note = String(viewer.note || '').trim();
  const text = note
    ? `${name}，我记得你呀，之前直播${note}，欢迎再来看鲸鱼娘，常来玩哦～`
    : `${name}，我记得你之前来过直播间呀，欢迎再来看鲸鱼娘，常来玩哦～`;
  return fitMemoryReply(text, name);
}

/** 旧版跨直播记忆只有一句 note，这里把点歌 / 送礼 / 点赞 / 关注解析出来。 */
export function parseViewerNote(note) {
  const text = String(note || '');
  const result = { song: '', gift: '', likes: 0, followed: false };
  const song = text.match(/点过《([^》]{1,40})》/);
  if (song) result.song = song[1].trim();
  const gift = text.match(/送过([^、，,；;（(]{1,20})/);
  if (gift) result.gift = gift[1].trim();
  const likes = text.match(/点过(\d{1,7})个赞/);
  if (likes) result.likes = Number(likes[1]) || 0;
  result.followed = /关注过/.test(text);
  return result;
}

/** 把上次直播的具体行为拼成 1~2 句细节，优先点歌 + 送礼。 */
function reunionSegments(viewer) {
  if (!viewer) return [];
  const legacy = parseViewerNote(viewer.note);
  const songs = Array.isArray(viewer.songs) && viewer.songs.length
    ? viewer.songs
    : legacy.song
      ? [{ title: legacy.song }]
      : [];
  const gifts = Array.isArray(viewer.gifts) && viewer.gifts.length
    ? viewer.gifts
    : legacy.gift
      ? [{ name: legacy.gift, count: 0 }]
      : [];
  const segments = [];
  const song = songs[songs.length - 1];
  if (song && song.title) segments.push(`点了《${trimText(song.title, 18)}》`);
  const gift = gifts[gifts.length - 1];
  if (gift && gift.name) {
    const count = Math.max(0, Number(gift.count) || 0);
    const amount = count > 1 ? `${count}个` : '';
    segments.push(`${segments.length ? '还' : ''}送了${amount}${trimText(gift.name, 12)}`);
  }
  const likes = Math.max(0, Number(viewer.likes) || 0) || legacy.likes;
  if (segments.length < 2 && likes > 0) {
    segments.push(`${segments.length ? '还' : ''}给我点了${likes}个赞`);
  }
  const followed = Boolean(legacy.followed) || (Array.isArray(viewer.actions) && viewer.actions.includes('关注'));
  if (!segments.length && followed) segments.push('关注了我');
  const chat = trimText(viewer.lastChat, 12);
  if (!segments.length && chat) segments.push(`说过「${chat}」`);
  return segments.slice(0, 2);
}

/**
 * 老观众再次进场时的「老朋友重逢」欢迎语：
 * 优先说出上次直播点了什么歌、送了多少礼物，没有明细时退回通用欢迎。
 */
export function buildReunionLine({ viewer, nickname = '观众', maxChars = REUNION_MAX_CHARS } = {}) {
  const name = String(nickname || '').trim() || '观众';
  const head = `@${name}，你又来看鲸鱼娘啦！`;
  const tail = '，我记得你哦！';
  let detail = '';
  for (const segment of reunionSegments(viewer)) {
    const next = detail ? `${detail}，${segment}` : segment;
    if (Array.from(`${head}上次你${next}${tail}`).length > maxChars) break;
    detail = next;
  }
  return detail ? `${head}上次你${detail}${tail}` : `${head}我记得你哦！`;
}
