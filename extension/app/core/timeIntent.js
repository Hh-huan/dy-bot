/** 报时：识别「现在几点 / 今天几号 / 现在什么时间」这类提问。 */

const TIME_PATTERNS = [
  '(?:现在|当前|这会儿|今天|今日)?(?:是)?几点(?:了|钟|几分)?',
  '几点了',
  '几点钟了',
  '报个?时',
  '(?:现在|当前|今天|今日)?(?:是)?几月几[号日]',
  '(?:今天|今日|现在)?(?:是)?几号',
  '(?:今天|今日)?(?:是)?多少号',
  '(?:今天|今日)?(?:是)?(?:星期几|周几)',
  '(?:现在|当前)(?:是)?(?:什么|啥)?时间(?:了)?',
  '(?:现在|当前)(?:是)?(?:什么|啥)?日期',
  '(?:现在|当前)(?:是)?(?:什么|啥)时候(?:了)?',
  '(?:现在|当前)(?:是)?(?:什么|啥)(?:日子|日期)',
].join('|');

const TIME_QUESTION_RE = new RegExp(TIME_PATTERNS);

// 问的是安排而不是当前时间，例如「几点开播」「什么时候轮到我」
const SCHEDULE_RE = /开播|下播|直播|唱|点歌|切歌|轮到我|开始|结束|睡|下班|上班|回来|抽奖/;

/** 判断弹幕是不是在问当前时间/日期。 */
export function isTimeQuestion(content) {
  const text = String(content || '').replace(/\s+/g, '');
  if (!text || text.length > 30) return false;
  if (SCHEDULE_RE.test(text)) return false;
  return TIME_QUESTION_RE.test(text);
}

/** 拼成适合朗读的当前时间，例如「10月29日 星期四 21点05分」。 */
export function formatNowText(date = new Date()) {
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const minutes = date.getMinutes();
  const mm = minutes < 10 ? `0${minutes}` : String(minutes);
  return `${date.getMonth() + 1}月${date.getDate()}日 星期${weekdays[date.getDay()]} ${date.getHours()}点${mm}分`;
}
