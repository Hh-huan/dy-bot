// 昵称玩梗是直播间的常态，桌宠可以接梗；但脏话、色情、政治敏感等不良昵称
// 不能出现在欢迎语、语音和公屏里，避免被平台风控。
const UNSAFE_NICKNAME_PATTERNS = [
  /傻[逼屄比bB]/,
  /煞[笔比bB]/,
  /沙比/,
  /[操草艹曹]你(妈|马|全家|祖宗|奶奶)/,
  /日你(妈|先人|仙人|全家)/,
  /你妈(逼|屄|死了|的[逼屄])/,
  /妈的[逼屄bB]/,
  /狗(日|操|草)的/,
  /贱(人|货|逼|婢)/,
  /婊子|妓女|嫖娼|卖淫|约炮|裸聊|色情|黄片|淫(秽|荡|贱|魔|乱)/,
  /智障|弱智|脑残|杂种|野种|畜生|狗杂种|王八蛋/,
  /吃屎|去死吧|死全家|全家死光|你全家/,
  /冰毒|海洛因|摇头丸|吸毒|贩毒/,
  /赌博|博彩|六合彩|时时彩|网赌/,
  /习近平|毛泽东|共产党|国民党|台独|港独|藏独|疆独|法轮功|六四|天安门|文化大革命|文革|中华民国/,
];

/**
 * 判断昵称是否含不良内容（脏话、色情、政治敏感、毒品赌博等）。
 * 普通玩梗昵称（你爹、吴彦祖、大肥鱼的老公等）不算。
 * @param {string} name
 * @returns {boolean}
 */
export function isUnsafeNickname(name) {
  const text = String(name || '').replace(/\s+/g, '');
  if (!text) return false;
  return UNSAFE_NICKNAME_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * 输出用的安全昵称：不良昵称一律替换成中性称呼，避免被朗读或公屏展示。
 * @param {string} name
 * @param {string} fallback 不良/空昵称时的替代称呼
 * @returns {string}
 */
export function safeNickname(name, fallback = '观众') {
  const text = String(name || '').trim();
  if (!text || isUnsafeNickname(text)) return fallback;
  return text;
}

/**
 * 背景板 / 桌宠事件流用的安全副本：不良昵称替换成中性称呼，其余字段保持不变。
 * @param {object} event
 * @param {string} fallback
 * @returns {object}
 */
export function sanitizeEventNickname(event, fallback = '观众') {
  if (!event || !event.user || !isUnsafeNickname(event.user.nickname)) return event;
  return { ...event, user: { ...event.user, nickname: fallback } };
}
