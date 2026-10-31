/**
 * 自动回复规则引擎（纯函数，无 chrome / DOM 依赖，便于单测）。
 *
 * 事件 → 匹配规则 → 模板渲染 → 限流检查 → 产出待发送回复。
 * 限流状态保存在内存 state 中，刷新页面即重置。
 */
import { renderTemplate } from './template.js';
import { safeNickname } from './nicknameSafety.js';

export const SCOPES = [
  { value: 'chat', label: '评论 / 弹幕', hint: '观众发言命中关键词时回复' },
  { value: 'gift', label: '礼物', hint: '收到礼物时答谢（可限定礼物名）' },
  { value: 'member', label: '进场', hint: '有人进入直播间时欢迎' },
  { value: 'follow', label: '关注', hint: '有人关注主播时答谢' },
  { value: 'like', label: '点赞', hint: '点赞达到数量时答谢' },
  { value: 'any', label: '任意事件', hint: '命中关键词的任意事件（慎用）' },
];

export const MATCH_MODES = [
  { value: 'contains', label: '包含关键词' },
  { value: 'exact', label: '完全等于' },
  { value: 'prefix', label: '以关键词开头' },
  { value: 'regex', label: '正则表达式' },
  { value: 'any', label: '不限制（全部匹配）' },
];

export const REPLY_MODES = [
  { value: 'random', label: '随机选一条' },
  { value: 'sequence', label: '按顺序轮换' },
];

export const RULE_DEFAULTS = {
  enabled: true,
  scope: 'chat',
  matchMode: 'contains',
  ignoreCase: true,
  patterns: [],
  replies: [],
  replyMode: 'random',
  cooldownSec: 8,
  perUserOnce: false,
  maxPerMin: 6,
  giftNames: [],
  minGiftCount: 0,
  minLikeCount: 1,
  note: '',
};

function toList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function clampNum(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function normalizeRule(rule = {}, index = 0) {
  const merged = { ...RULE_DEFAULTS, ...rule };
  return {
    ...merged,
    id: String(rule.id || `rule-${index}-${Math.random().toString(36).slice(2, 7)}`),
    name: String(rule.name || '未命名规则').trim() || '未命名规则',
    enabled: rule.enabled !== false,
    scope: SCOPES.some((item) => item.value === merged.scope) ? merged.scope : 'chat',
    patterns: toList(merged.patterns),
    replies: toList(merged.replies),
    giftNames: toList(merged.giftNames),
    matchMode: MATCH_MODES.some((item) => item.value === merged.matchMode) ? merged.matchMode : 'contains',
    replyMode: merged.replyMode === 'sequence' ? 'sequence' : 'random',
    ignoreCase: merged.ignoreCase !== false,
    perUserOnce: Boolean(merged.perUserOnce),
    cooldownSec: clampNum(merged.cooldownSec, 0, 3600, 8),
    maxPerMin: clampNum(merged.maxPerMin, 0, 600, 6),
    minGiftCount: clampNum(merged.minGiftCount, 0, 100000, 0),
    minLikeCount: clampNum(merged.minLikeCount, 1, 100000, 1),
    note: String(merged.note || ''),
  };
}

export function normalizeRules(rules) {
  if (!Array.isArray(rules)) return createDefaultRules();
  return rules.map((rule, index) => normalizeRule(rule, index));
}

export function createDefaultRules() {
  return [
    normalizeRule(
      {
        id: 'preset-welcome',
        name: '新人进场欢迎',
        enabled: false,
        scope: 'member',
        matchMode: 'any',
        perUserOnce: true,
        cooldownSec: 10,
        maxPerMin: 8,
        replies: [
          '欢迎 {nickname} 来到直播间，点点关注不迷路~',
          '欢迎 {nickname} 进直播间，喜欢的话留个关注呀~',
        ],
      },
      0,
    ),
    normalizeRule(
      {
        id: 'preset-gift',
        name: '礼物答谢',
        enabled: false,
        scope: 'gift',
        matchMode: 'any',
        cooldownSec: 3,
        maxPerMin: 12,
        replies: ['感谢 {nickname} 送出的{gift}，老板大气！', '谢谢 {nickname} 的{gift}，太给力了！'],
      },
      1,
    ),
    normalizeRule(
      {
        id: 'preset-follow',
        name: '关注答谢',
        enabled: false,
        scope: 'follow',
        matchMode: 'any',
        perUserOnce: true,
        cooldownSec: 5,
        maxPerMin: 10,
        replies: ['谢谢 {nickname} 的关注，爱你哟~'],
      },
      2,
    ),
    normalizeRule(
      {
        id: 'preset-keyword',
        name: '关键词自动回复',
        enabled: false,
        scope: 'chat',
        matchMode: 'contains',
        patterns: ['价格', '多少钱', '怎么买', '链接', '教程'],
        cooldownSec: 15,
        maxPerMin: 6,
        replies: ['{nickname} 点击下方小黄车就能看到哦~', '{nickname} 的问题收到啦，稍等主播讲解~'],
      },
      3,
    ),
  ];
}

function textMatch(rule, text) {
  const source = rule.ignoreCase ? String(text).toLowerCase() : String(text);
  return rule.patterns.some((pattern) => {
    if (rule.matchMode === 'regex') {
      try {
        return new RegExp(pattern, rule.ignoreCase ? 'i' : '').test(text);
      } catch {
        return false;
      }
    }
    const needle = rule.ignoreCase ? pattern.toLowerCase() : pattern;
    switch (rule.matchMode) {
      case 'exact':
        return source === needle;
      case 'prefix':
        return source.startsWith(needle);
      case 'contains':
      default:
        return source.includes(needle);
    }
  });
}

/** 判断一条事件是否命中规则（不含限流判断）。 */
export function ruleMatches(rule, event) {
  if (!rule || rule.enabled === false || !event) return false;
  if (event.canReply === false) return false;

  const scope = rule.scope || 'chat';
  const isFollowMember =
    event.type === 'member' && /关注|follow/i.test(String((event.member && event.member.actionDescription) || ''));

  const scopeOk =
    scope === 'any'
      ? ['chat', 'gift', 'member', 'follow', 'like'].includes(event.type)
      : event.type === scope || (scope === 'follow' && isFollowMember);
  if (!scopeOk) return false;

  if (event.type === 'gift') {
    const giftName = String((event.gift && event.gift.name) || '');
    if (rule.giftNames.length) {
      const hit = rule.giftNames.some((name) =>
        rule.ignoreCase ? giftName.toLowerCase().includes(name.toLowerCase()) : giftName.includes(name),
      );
      if (!hit) return false;
    }
    if (rule.minGiftCount > 0 && Number(event.gift && event.gift.count) < rule.minGiftCount) return false;
    return true;
  }

  if (event.type === 'like') {
    return Number((event.like && event.like.count) || 0) >= rule.minLikeCount;
  }

  if (event.type === 'member' || event.type === 'follow') {
    if (!rule.patterns.length || rule.matchMode === 'any') return true;
    const description = String((event.member && event.member.actionDescription) || '');
    return textMatch(rule, description);
  }

  if (!rule.patterns.length) return false;
  if (rule.matchMode === 'any') return true;
  return textMatch(rule, event.content || '');
}

export function createState() {
  return {
    globalTimes: [],
    lastSendAt: 0,
    ruleTimes: new Map(),
    ruleUser: new Map(),
    userTimes: new Map(),
    once: new Set(),
    sequence: new Map(),
    echoes: [],
    totalReplies: 0,
  };
}

function pruneTimes(times, nowMs, windowMs = 60000) {
  let cut = 0;
  while (cut < times.length && nowMs - times[cut] > windowMs) cut += 1;
  if (cut) times.splice(0, cut);
  return times;
}

export function pruneState(state, nowMs = Date.now()) {
  pruneTimes(state.globalTimes, nowMs);
  for (const [key, times] of state.userTimes) {
    pruneTimes(times, nowMs);
    if (!times.length) state.userTimes.delete(key);
  }
  for (const [key, times] of state.ruleTimes) {
    pruneTimes(times, nowMs);
    if (!times.length) state.ruleTimes.delete(key);
  }
  state.echoes = state.echoes.filter((item) => nowMs - item.ts < 60000);
  while (state.echoes.length > 40) state.echoes.shift();
}

function isBlockedUser(event, settings) {
  const list = Array.isArray(settings.blockedUsers) ? settings.blockedUsers : [];
  if (!list.length) return false;
  const user = event.user || {};
  const nickname = String(user.nickname || '').trim().toLowerCase();
  const id = String(user.id || '');
  return list.some((entry) => {
    const value = String(entry || '').trim().toLowerCase();
    if (!value) return false;
    return value === nickname || value === id;
  });
}

export function isBlockedContent(event, settings) {
  const list = Array.isArray(settings.blockedKeywords) ? settings.blockedKeywords : [];
  if (!list.length) return false;
  const content = String(event.content || '').toLowerCase();
  if (!content) return false;
  return list.some((entry) => entry && content.includes(String(entry).toLowerCase()));
}

export function isEcho(event, state, nowMs = Date.now()) {
  const content = String(event.content || '').trim();
  if (!content) return false;
  return state.echoes.some((item) => item.text === content && nowMs - item.ts < 20000);
}

function isSelfUser(event, settings) {
  const user = event.user || {};
  const selfId = String(settings.myUserId || '').trim();
  if (selfId && String(user.id || '') === selfId) return true;
  const selfName = String(settings.myNickname || '').trim().toLowerCase();
  if (selfName && String(user.nickname || '').trim().toLowerCase() === selfName) return true;
  return false;
}

/** 非限流的通用过滤：屏蔽词 / 屏蔽用户 / 自己 / 自己回复的回显。 */
export function isEligible(event, settings, state, nowMs = Date.now()) {
  if (!event || !event.type) return false;
  if (isSelfUser(event, settings)) return false;
  if (isBlockedUser(event, settings)) return false;
  if (isBlockedContent(event, settings)) return false;
  if (settings.blockSelfEcho !== false && isEcho(event, state, nowMs)) return false;
  return true;
}

function checkLimit(state, settings, { rule, userId, nowMs }) {
  pruneState(state, nowMs);

  const minInterval = Number(settings.replyCooldownMs) || 0;
  if (minInterval > 0 && nowMs - state.lastSendAt < minInterval) {
    return '全局发送间隔未到';
  }

  const maxPerMin = Number(settings.maxRepliesPerMin) || 0;
  if (maxPerMin > 0 && state.globalTimes.length >= maxPerMin) {
    return '达到全局每分钟回复上限';
  }

  const perUserPerMin = Number(settings.maxRepliesPerUserPerMin) || 0;
  if (perUserPerMin > 0) {
    const times = state.userTimes.get(userId) || [];
    pruneTimes(times, nowMs);
    if (times.length >= perUserPerMin) return '该用户每分钟回复已达上限';
  }

  if (rule) {
    if (rule.perUserOnce) {
      const key = `${rule.id}:${userId}`;
      if (state.once.has(key)) return '该用户已回复过此规则';
    }
    if (rule.cooldownSec > 0) {
      const key = `${rule.id}:${userId}`;
      const last = state.ruleUser.get(key) || 0;
      if (nowMs - last < rule.cooldownSec * 1000) return '规则冷却中';
    }
    if (rule.maxPerMin > 0) {
      const times = state.ruleTimes.get(rule.id) || [];
      pruneTimes(times, nowMs);
      if (times.length >= rule.maxPerMin) return '该规则每分钟上限';
    }
  }

  return null;
}

function reserve(state, settings, { rule, userId, nowMs }) {
  state.globalTimes.push(nowMs);
  state.lastSendAt = nowMs;
  state.totalReplies += 1;

  if (!state.userTimes.has(userId)) state.userTimes.set(userId, []);
  state.userTimes.get(userId).push(nowMs);

  if (rule) {
    if (!state.ruleTimes.has(rule.id)) state.ruleTimes.set(rule.id, []);
    state.ruleTimes.get(rule.id).push(nowMs);
    state.ruleUser.set(`${rule.id}:${userId}`, nowMs);
    if (rule.perUserOnce) state.once.add(`${rule.id}:${userId}`);
  }
}

/** 供 AI 回复等外部路径使用的限流检查。 */
export function canSendNow(state, settings, options = {}) {
  const nowMs = options.nowMs || Date.now();
  return checkLimit(state, settings, {
    rule: options.rule || null,
    userId: String(options.userId || 'anonymous'),
    nowMs,
  });
}

export function reserveSend(state, settings, options = {}) {
  reserve(state, settings, {
    rule: options.rule || null,
    userId: String(options.userId || 'anonymous'),
    nowMs: options.nowMs || Date.now(),
  });
}

export function noteSentText(state, text, nowMs = Date.now()) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return;
  state.echoes.push({ text: trimmed, ts: nowMs });
  while (state.echoes.length > 40) state.echoes.shift();
}

function pickReply(rule, state) {
  const replies = rule.replies.length ? rule.replies : [];
  if (!replies.length) return '';
  if (rule.replyMode === 'sequence') {
    const index = (state.sequence.get(rule.id) || 0) % replies.length;
    state.sequence.set(rule.id, index + 1);
    return replies[index];
  }
  return replies[Math.floor(Math.random() * replies.length)];
}

function buildContext(event, nowMs, extra) {
  const user = event.user || {};
  return {
    nickname: safeNickname(user.nickname, '朋友'),
    userId: user.id || '',
    content: event.content || '',
    gift: (event.gift && event.gift.name) || '',
    count: (event.gift && event.gift.count) || (event.like && event.like.count) || 1,
    level: user.level || '',
    fansClub: (user.fansClub && user.fansClub.name) || '',
    online: extra.online ?? '',
    cumulative: extra.cumulative ?? '',
    time: new Date(nowMs).toLocaleTimeString('zh-CN', { hour12: false }),
    ...extra.context,
  };
}

/**
 * 计算一条事件应该发出的回复。
 * @returns {{plans: Array<{ruleId:string,ruleName:string,text:string,userId:string,eventId:string,scope:string,ts:number}>, skipped: Array<{ruleId:string,reason:string}>}}
 */
export function planReplies({ event, rules, state, settings, nowMs = Date.now(), context = {} }) {
  const plans = [];
  const skipped = [];
  if (!isEligible(event, settings, state, nowMs)) return { plans, skipped };

  const maxRules = Math.max(1, Number(settings.maxRulesPerEvent) || 1);
  const userId = String((event.user && (event.user.id || event.user.nickname)) || 'anonymous');
  const maxChars = Math.max(10, Number(settings.maxReplyChars) || 60);

  for (const rawRule of rules || []) {
    if (plans.length >= maxRules) break;
    const rule = normalizeRule(rawRule);
    if (!ruleMatches(rule, event)) continue;

    const reason = checkLimit(state, settings, { rule, userId, nowMs });
    if (reason) {
      skipped.push({ ruleId: rule.id, reason });
      continue;
    }

    const template = pickReply(rule, state);
    const text = renderTemplate(template, buildContext(event, nowMs, context));
    if (!text) {
      skipped.push({ ruleId: rule.id, reason: '回复内容为空' });
      continue;
    }

    reserve(state, settings, { rule, userId, nowMs });
    plans.push({
      ruleId: rule.id,
      ruleName: rule.name,
      text: Array.from(text).slice(0, maxChars).join(''),
      userId,
      eventId: event.id,
      scope: rule.scope,
      ts: nowMs,
    });
  }

  return { plans, skipped };
}

export function describeRule(rule) {
  const scope = SCOPES.find((item) => item.value === rule.scope);
  const parts = [scope ? scope.label : rule.scope];
  if (rule.scope === 'chat' && rule.patterns.length) {
    const mode = MATCH_MODES.find((item) => item.value === rule.matchMode);
    parts.push(`${mode ? mode.label : ''}：${rule.patterns.slice(0, 3).join(' / ')}${rule.patterns.length > 3 ? '…' : ''}`);
  }
  if (rule.scope === 'gift' && rule.giftNames.length) {
    parts.push(`礼物：${rule.giftNames.slice(0, 2).join(' / ')}`);
  }
  if (rule.cooldownSec > 0) parts.push(`冷却 ${rule.cooldownSec}s`);
  if (rule.perUserOnce) parts.push('每人一次');
  return parts.join(' · ');
}
