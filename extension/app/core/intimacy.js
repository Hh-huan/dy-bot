/**
 * 观众亲密度：按抖音 ID 分人累计，跨场次保留。
 * 发言 / 点赞 / 送白饭 / 点歌 / 关注都会涨，每日首次到场额外加分，
 * 连续到场两天起当天积分 ×1.2。等级用于称呼、送礼感谢口吻和背景板等级标识。
 */

// 经验门槛与称号：送礼 1 碗白饭 = 1 分，普通观众连续来几天能到 3~4 级
export const INTIMACY_LEVELS = [
  { level: 1, points: 0, title: '路人', color: '#9fc6ea' },
  { level: 2, points: 10, title: '眼熟', color: '#8bb8ec' },
  { level: 3, points: 25, title: '常客', color: '#7cc4ff' },
  { level: 4, points: 50, title: '饭搭子', color: '#63b3ff' },
  { level: 5, points: 90, title: '老饭友', color: '#52a4f7' },
  { level: 6, points: 150, title: '喂饭官', color: '#3f95ee' },
  { level: 7, points: 240, title: '专属饲养员', color: '#ffc531' },
  { level: 8, points: 380, title: '鲸鱼娘心腹', color: '#ffb62a' },
  { level: 9, points: 600, title: '鲸鱼娘家人', color: '#ffa31f' },
  { level: 10, points: 1000, title: '命定饭票', color: '#ff8f1a' },
];

export const INTIMACY_MAX_POINTS = INTIMACY_LEVELS[INTIMACY_LEVELS.length - 1].points;
export const INTIMACY_DAY_BONUS = 3;
export const INTIMACY_STREAK_BOOST = 1.2;
// 聊天/点赞防刷：同一观众每分钟最多计入这么多分
const CHAT_POINTS_PER_MIN = 6;
const LIKE_POINTS_PER_MIN = 10;
const FOLLOW_POINTS = 10;
const SONG_POINTS = 5;

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const SPOKEN_LEVELS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

/** 上海时区的日期串（YYYY-MM-DD），跨天签到按这个算。 */
export function shanghaiDayKey(ts = Date.now()) {
  const value = Number(ts) || 0;
  return new Date(value + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

function dayGap(fromKey, toKey) {
  const from = Date.parse(`${fromKey}T00:00:00Z`);
  const to = Date.parse(`${toKey}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return Infinity;
  return Math.round((to - from) / 86400000);
}

/** 把存档里的亲密度字段规整成固定结构，旧数据缺失时按 0 分处理。 */
export function normalizeIntimacy(value) {
  const saved = value && typeof value === 'object' ? value : {};
  const points = Math.max(0, Math.round(Number(saved.points) || 0));
  return {
    points,
    level: levelForPoints(points).level,
    dayKey: String(saved.dayKey || ''),
    streak: Math.max(0, Math.round(Number(saved.streak) || 0)),
    lastVisitAt: Math.max(0, Number(saved.lastVisitAt) || 0),
    multiplier: Number(saved.multiplier) >= INTIMACY_STREAK_BOOST ? INTIMACY_STREAK_BOOST : 1,
    // 关注分只给一次，重复的 follow 事件不能刷分
    followed: Boolean(saved.followed),
    windows: saved.windows && typeof saved.windows === 'object' ? saved.windows : {},
  };
}

/** 积分对应的等级信息，附带距下一级的进度，背景板进度条用得上。 */
export function levelForPoints(points) {
  const value = Math.max(0, Number(points) || 0);
  let current = INTIMACY_LEVELS[0];
  let next = null;
  for (let index = 0; index < INTIMACY_LEVELS.length; index += 1) {
    const item = INTIMACY_LEVELS[index];
    if (value >= item.points) {
      current = item;
      next = INTIMACY_LEVELS[index + 1] || null;
    }
  }
  const span = next ? next.points - current.points : 0;
  const done = next ? value - current.points : 0;
  return {
    ...current,
    next: next ? next.level : 0,
    toNext: next ? Math.max(0, next.points - value) : 0,
    progress: span > 0 ? Math.min(1, Math.max(0, done / span)) : 1,
  };
}

/** 背景板用的等级标识；没有记录时返回 null。 */
export function intimacyBadge(record) {
  if (!record || !record.intimacy || !Number(record.intimacy.points)) return null;
  const info = levelForPoints(record.intimacy.points);
  return { level: info.level, title: info.title, color: info.color, points: Math.round(record.intimacy.points) };
}

/** 中文等级，TTS 直接读「五级」比读「Lv.5」自然。 */
export function intimacySpokenLevel(level) {
  const index = Math.min(SPOKEN_LEVELS.length - 1, Math.max(0, Math.round(Number(level) || 1) - 1));
  return `${SPOKEN_LEVELS[index]}级`;
}

/** 老观众进场时的亲近话术（5 级起才加，避免所有人都一样长）。 */
export function intimacyWelcomeTail(record) {
  const badge = intimacyBadge(record);
  if (!badge || badge.level < 5) return '';
  return `你现在是${intimacySpokenLevel(badge.level)}${badge.title}啦～`;
}

/** 送礼感谢的尾巴：高亲密度用户被点名「又喂饭」，比普通感谢更有专属感。 */
export function intimacyGiftTail(record) {
  const badge = intimacyBadge(record);
  if (!badge || badge.level < 5) return '';
  return `${intimacySpokenLevel(badge.level)}${badge.title}又来喂饭啦～`;
}

/**
 * 按事件类型换算本次应该加多少分。
 * giftRice 是本次连击的真实差额（白饭碗数），重复的结束帧差额为 0 不会白涨分。
 */
export function intimacyAwardForEvent(event, giftRice = 0) {
  if (!event || !event.type) return null;
  if (event.type === 'chat') return { source: 'chat', amount: 1 };
  if (event.type === 'like') {
    const count = Math.max(1, Number(event.like && event.like.count) || 1);
    return { source: 'like', amount: Math.min(5, count) };
  }
  if (event.type === 'gift') return { source: 'gift', amount: Math.max(0, Number(giftRice) || 0) };
  if (event.type === 'follow') return { source: 'follow', amount: FOLLOW_POINTS };
  return null;
}

export function intimacyAwardForSong() {
  return { source: 'song', amount: SONG_POINTS };
}

// 每分钟窗口：只保留当前分钟内的计分，跨分钟自动清零
function capPerMinute(data, source, amount, now) {
  if (source !== 'chat' && source !== 'like') return amount;
  const limit = source === 'chat' ? CHAT_POINTS_PER_MIN : LIKE_POINTS_PER_MIN;
  const minute = Math.floor(now / 60000);
  const window = data.windows[source] && Number(data.windows[source].at) === minute
    ? data.windows[source]
    : { at: minute, points: 0 };
  const allowed = Math.max(0, limit - (Number(window.points) || 0));
  const used = Math.min(amount, allowed);
  window.points = (Number(window.points) || 0) + used;
  data.windows[source] = window;
  return used;
}

/**
 * 记一次亲密度：负责跨天签到、连续到场倍率、防刷窗口和等级变化。
 * 返回 { gained, points, level, title, levelUp }，调用方据此决定是否播报升级。
 */
export function applyIntimacyAward(record, source, amount, now = Date.now()) {
  if (!record || !source) return null;
  const nowMs = Number(now) || Date.now();
  const data = normalizeIntimacy(record.intimacy);
  const today = shanghaiDayKey(nowMs);

  let bonus = 0;
  if (data.dayKey !== today) {
    // 昨天来过 → 连续天数 +1；断签或首次记录 → 从 1 重新计
    data.streak = data.dayKey && dayGap(data.dayKey, today) === 1 ? data.streak + 1 : 1;
    data.dayKey = today;
    data.multiplier = data.streak >= 2 ? INTIMACY_STREAK_BOOST : 1;
    data.lastVisitAt = nowMs;
    bonus = INTIMACY_DAY_BONUS;
  }

  // 关注只加一次：抖音会重复下发关注事件
  if (source === 'follow') {
    if (data.followed) {
      record.intimacy = data;
      const info = levelForPoints(data.points);
      return { gained: 0, points: data.points, level: info.level, title: info.title, color: info.color, levelUp: false };
    }
    data.followed = true;
  }

  const raw = Math.max(0, Math.round(Number(amount) || 0));
  const capped = capPerMinute(data, source, raw, nowMs);
  const gained = Math.round((capped + bonus) * data.multiplier);
  const before = levelForPoints(data.points);
  data.points += gained;
  const after = levelForPoints(data.points);
  data.level = after.level;
  record.intimacy = data;
  return {
    gained,
    points: data.points,
    level: after.level,
    title: after.title,
    color: after.color,
    levelUp: after.level > before.level,
    bonus,
  };
}

/** 升级播报文案：@观众 + 新等级称号，语气跟桌宠一致。 */
export function levelUpLine(nickname, award) {
  const name = String(nickname || '').trim() || '观众';
  if (!award || !award.levelUp) return '';
  return `@${name} 亲密度升到${intimacySpokenLevel(award.level)}·${award.title}啦！`;
}
