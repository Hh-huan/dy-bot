/**
 * 「甩飞 XXX」互动指令：识别甩飞/扔飞/丢飞/抛飞等同类说法，
 * 解析目标观众（昵称模糊匹配 / @昵称），并支持在气泡流名单里做确定性匹配。
 */

// 动作词库：甩 / 扔 / 丢 / 抛 + 飞 / 出去 / 走（允许中间夹「了」，如「丢了出去」）
const VERB = '(?:甩|扔|丢|抛)\\s*(?:了)?\\s*(?:飞|出去|走)';
// 抛起 / 丢起 / 高高抛起 / 丢了起来 这类向上抛的说法
const LIFT = '(?:高高\\s*)?(?:抛|丢|甩|扔)\\s*(?:了)?\\s*(?:起来|起)';
const SUFFIX = '(?:吧|呀|啊|哦|呗|嘛|啦|哈|了)*';
const PREFIX_POLITE = /^(?:请|快|帮我|给我|可不可以|能不能|麻烦你|麻烦)+/;
// 「你/主播 把…」这类称呼只在后面紧跟动作词时去掉，避免误删目标昵称
const PREFIX_ADDRESS = /^(?:你|您|主播|桌宠|鲸鱼娘|大肥鱼|肥鱼)[\s,，:：]*(?=(?:把|将|甩|扔|丢|抛))/;
// 「把 / 将 XXX 甩飞」与「甩飞 XXX」两种语序
const PATTERN_OBJECT_FIRST = new RegExp(`^(?:把|将)\\s*(.+?)\\s*${VERB}\\s*(?:掉|了)?\\s*(?:一下)?\\s*${SUFFIX}$`);
const PATTERN_VERB_FIRST = new RegExp(`^${VERB}\\s*(?:掉|了)?\\s*(?:一下)?\\s*(.+?)\\s*(?:一下)?\\s*${SUFFIX}$`);
// 「甩 XXX 出去 / 扔 XXX 走」：动作词拆开写的语序
const PATTERN_SPLIT_VERB = new RegExp(`^(?:甩|扔|丢|抛)\\s*(.+?)\\s*(?:出去|走)\\s*(?:一下)?\\s*${SUFFIX}$`);
// 向上抛的两种语序：「把 XXX 高高抛起」「高高抛起 XXX」
const PATTERN_LIFT_OBJECT = new RegExp(`^(?:把|将)\\s*(.+?)\\s*${LIFT}\\s*(?:掉|了)?\\s*(?:一下)?\\s*${SUFFIX}$`);
const PATTERN_LIFT_FIRST = new RegExp(`^${LIFT}\\s*(?:掉|了)?\\s*(?:一下)?\\s*(.+?)\\s*(?:一下)?\\s*${SUFFIX}$`);
// 只匹配到语气词/补语时不当作用户目标
const STOP_TARGETS = new Set(['一下', '出去', '走', '飞', '掉', '了', '吧', '呀', '啊', '哦', '呗', '嘛', '啦', '哈', '一个', '起来', '来', '高']);
// 「甩飞我自己 / 把我丢出去」这类指向发指令者自己的说法
const SELF_TARGETS = new Set(['我', '我自己', '自己', '俺', '本人']);
// 常见物品短语：嘴瓢说「扔飞盘 / 丢飞镖 / 甩飞吻」时不当成甩飞用户的指令
const OBJECT_WORDS = ['飞盘', '飞机', '纸飞机', '飞镖', '飞刀', '飞吻', '飞饼', '皮球', '沙包', '手绢', '石头', '垃圾', '球', '锅'];
function isObjectPhrase(source, normalized) {
  return OBJECT_WORDS.some((word) => source.includes(word) && word.includes(normalized));
}

const QUESTION_RE = /[?？]|怎么|如何|咋样|为什么|为啥|什么是|啥是|什么意思|规则|玩法|是谁/;
const NEGATION_RE = /不要|别|不准|不许|不可以|不能|禁止|不想/;

/**
 * 目标标识标准化：去掉 @、全角 @、空格、表情与标点等特殊字符，
 * 只保留中文、字母、数字、下划线，用于模糊匹配。
 */
export function normalizeBubbleTarget(raw) {
  return String(raw || '')
    .replace(/[@＠]/g, '')
    .replace(/[\s\u3000]+/g, '')
    // 昵称里常见的装饰用汉字/符号也按特殊字符处理
    .replace(/[丶丨灬丿乀乁卩卪ヽヾ]/g, '')
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9_]/g, '')
    .toLowerCase();
}

/** 展示用目标名：去掉 @ 与空白，保留昵称原有字符（表情等） */
export function displayBubbleTarget(raw) {
  return String(raw || '')
    .replace(/[@＠]/g, '')
    .replace(/[丶丨灬丿乀乁卩卪ヽヾ]/g, '')
    .replace(/[\s\u3000]+/g, '')
    .trim();
}

/**
 * 解析甩飞指令。返回 { target } 或 null；
 * target 为展示用昵称（已去掉 @ 与空格），normalized 为匹配用规范串。
 */
export function parseThrowIntent(content) {
  const source = String(content || '').trim();
  if (!source) return null;
  if (Array.from(source).length > 40) return null;
  if (NEGATION_RE.test(source)) return null;
  if (QUESTION_RE.test(source)) return null;

  let text = source
    .replace(/[！!。]+$/g, '')
    .replace(PREFIX_POLITE, '')
    .trim();
  text = text.replace(PREFIX_ADDRESS, '').trim();
  if (!text) return null;

  let rawTarget = '';
  const objectFirst = text.match(PATTERN_OBJECT_FIRST);
  if (objectFirst) {
    rawTarget = objectFirst[1];
  } else {
    const verbFirst = text.match(PATTERN_VERB_FIRST);
    if (verbFirst) rawTarget = verbFirst[1];
    else {
      const splitVerb = text.match(PATTERN_SPLIT_VERB);
      if (splitVerb) rawTarget = splitVerb[1];
      else {
        const liftObject = text.match(PATTERN_LIFT_OBJECT);
        if (liftObject) rawTarget = liftObject[1];
        else {
          const liftFirst = text.match(PATTERN_LIFT_FIRST);
          if (liftFirst) rawTarget = liftFirst[1];
        }
      }
    }
  }
  if (!rawTarget) return null;

  // 去掉可能残留的「把 / 将」以及首尾标点
  rawTarget = rawTarget
    .replace(/^(?:把|将)\s*/, '')
    .replace(/^[\s:：,，、]+|[\s:：,，、]+$/g, '');
  const target = displayBubbleTarget(rawTarget);
  const normalized = normalizeBubbleTarget(rawTarget);
  if (!normalized) return null;
  if (STOP_TARGETS.has(normalized)) return null;
  if (isObjectPhrase(source, normalized)) return null;
  if (Array.from(normalized).length > 30) return null;
  // self: 指向发指令的人自己，由调用方用当前用户去气泡流里查
  const self = SELF_TARGETS.has(normalized);
  return { target, normalized, self, raw: source };
}

/**
 * 「甩飞我自己」：先用发指令用户的 id 精确匹配气泡 key；
 * 部分弹幕消息不带用户 id 或 id 与礼物记录不一致时，退回昵称匹配。
 */
export function matchSelfBubble(user, bubbles) {
  const userId = String((user && user.id) || '');
  const list = Array.isArray(bubbles) ? bubbles : [];
  if (userId) {
    const byId = list.find((item) => item && String(item.key) === userId);
    if (byId) return byId;
  }
  const nickname = String((user && user.nickname) || '');
  return nickname ? matchBubbleTarget(nickname, list) : null;
}

/**
 * 在气泡流名单里匹配目标用户。
 * 优先级：完全一致 > 前缀匹配 > 包含匹配；
 * 同层级多人命中时按白饭数量降序、名字更短者优先，保证结果确定。
 * bubbles 元素格式：{ key, name, avatar?, rice? }
 */
export function matchBubbleTarget(target, bubbles) {
  const query = normalizeBubbleTarget(target);
  if (!query) return null;
  const items = (Array.isArray(bubbles) ? bubbles : [])
    .filter((item) => item && item.name && item.key != null)
    .map((item) => ({
      ...item,
      normalized: normalizeBubbleTarget(item.name),
      rice: Math.max(0, Number(item.rice) || 0),
    }))
    .filter((item) => item.normalized);

  const tiers = [
    (item) => item.normalized === query,
    (item) => item.normalized.startsWith(query),
    (item) => item.normalized.includes(query),
  ];
  for (const hit of tiers) {
    const matches = items.filter(hit);
    if (!matches.length) continue;
    matches.sort(
      (a, b) =>
        b.rice - a.rice ||
        a.normalized.length - b.normalized.length ||
        a.normalized.localeCompare(b.normalized),
    );
    return matches[0];
  }
  return null;
}
