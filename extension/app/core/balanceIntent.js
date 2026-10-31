/** 余额查询：识别「剩余token数量 / 还剩多少token」这类提问。 */

const CUE_RE = /(?:多少|几|还剩|剩余|还有|剩下|剩|余额|余量|数量|remaining|left|much|many)/i;
const TOKEN_RE = /token/i;
const BALANCE_ONLY_RE = /(?:余额|余量)/;
const BALANCE_ONLY_CUE_RE = /(?:多少|几|还剩|剩余|还有)/;
// 这些是直播互动指令，不当作余额查询
const EXCLUDE_RE = /点歌|切歌|播放|唱歌|开播|下播/i;

/** 判断弹幕是不是在问 token 余额。 */
export function isBalanceQuestion(content) {
  const text = String(content || '').replace(/\s+/g, '');
  if (!text || text.length > 30) return false;
  if (EXCLUDE_RE.test(text)) return false;
  if (TOKEN_RE.test(text)) return CUE_RE.test(text);
  return BALANCE_ONLY_RE.test(text) && BALANCE_ONLY_CUE_RE.test(text);
}

export const BALANCE_CHEER = '余额多多，token多多！';

/** 固定回复：先报余额，再补激励话术，不加其他内容。 */
export function formatBalanceReply(balanceText) {
  return `当前token余额为${balanceText}，${BALANCE_CHEER}`;
}
