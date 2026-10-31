/** 气泡流玩法咨询：观众问「头像为什么弹来弹去」「怎么上气泡流」这类问题。 */

const BUBBLE_FLOW_WORD = '(?:气泡流|气泡)';
const MOTION_RE = /(?:弹来弹去|飘来飘去|飞来飞去|转来转去|跳来跳去|弹|飘|飞|转|跳|晃)/;
const ASK_WORD = '(?:怎么|怎么样|怎样|如何|咋|是什么|是啥|什么意思|啥意思|怎么弄|怎么搞|咋弄|咋搞|要|需要|送|用|能|可以|行|有用|有什么用)';

const FLOW_ASK_RE = new RegExp(
  [
    // 气泡流 / 气泡 + 疑问
    `${BUBBLE_FLOW_WORD}${ASK_WORD}`,
    // 怎么 / 想 / 能 + 上气泡流
    `(?:怎么|怎么样|怎样|如何|咋|想|想要|要|能|能不能|可以|可不可以)(?:才能|才|可以|能)?(?:上|进|加|弄|搞|玩)(?:个|一个)?${BUBBLE_FLOW_WORD}`,
    // 上 / 进 + 气泡流 + 疑问
    `(?:上|进|加)(?:个|一个)?${BUBBLE_FLOW_WORD}(?:吗|么|嘛|怎么|咋|要|需要|能|可以)`,
  ].join('|'),
);

/** 判断一条弹幕是不是在问气泡流头像（为什么弹来弹去 / 怎么上气泡流）。 */
export function isBubbleGuideQuestion(content) {
  // 先去掉开头的 @昵称，再压缩空白，避免 @昵称 把后面的正文一起吞掉
  let text = String(content || '').replace(/^(?:@[^\s@]+[\s:：,，]+)+/, '');
  text = text.replace(/\s+/g, '');
  if (!text || text.length > 40) return false;
  // 甩飞指令走专门的甩飞流程，不在气泡流咨询里接管
  if (/(?:甩飞|扔飞|丢飞)/.test(text)) return false;
  if (FLOW_ASK_RE.test(text)) return true;
  // 「他们的头像弹来弹去」「为什么头像飞来飞去」：头像/别人 + 动态词
  if (/(?:头像|别人|他们)/.test(text) && MOTION_RE.test(text)) return true;
  // 只发「弹来弹去」这类描述，也当成在问气泡流
  return /(?:弹来弹去|飘来飘去|飞来飞去|转来转去|跳来跳去)/.test(text);
}
