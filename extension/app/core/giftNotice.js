// 抖音聊天区会把送礼提示当成一条文本消息推送，形如：
//   送出 小心心 x1
//   送出 @直播间某人 x1
//   送出了跑车 ×2
// 这类文本不是观众在聊天，不能当成闲聊/点歌/指令处理，礼物本身由 gift 事件负责。
const GIFT_NOTICE_RE =
  /^(?:@[^\s@]+[\s:：,，]*)?送(?:出|出了|赠)\s*@?\S[^。！？!?\n]{0,26}?(?:[x×*]\s*\d+|\d+\s*(?:个|连击))\s*$/i;

/**
 * 判断一条弹幕文本是不是送礼提示。
 * @param {string} content 弹幕内容
 * @returns {boolean}
 */
export function isGiftNoticeText(content) {
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 40) return false;
  return GIFT_NOTICE_RE.test(text);
}
