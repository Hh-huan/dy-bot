/** 语音优先级：1 送礼感谢 > 2 记忆回复 > 3 点歌结果 > 4 闲聊 > 5 进场欢迎。 */

export const SPEECH_PRIORITY = {
  gift: 1,
  memory: 2,
  song: 3,
  chat: 4,
  welcome: 5,
};

export const SPEECH_QUEUE_MAX = 20;

export function normalizeSpeechPriority(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return SPEECH_PRIORITY.chat;
  return Math.min(SPEECH_PRIORITY.welcome, Math.max(SPEECH_PRIORITY.gift, Math.round(n)));
}

/** 高优先级可以打断低优先级；记忆语音和送礼语音播放中不打断。 */
export function shouldInterrupt(priority, currentPriority, currentProtected) {
  if (currentProtected) return false;
  return priority < currentPriority;
}

/** 按优先级插入，同级保持先来后到；超出上限时丢弃队尾（最低优先级/最旧）。 */
export function insertByPriority(queue, item, maxSize = SPEECH_QUEUE_MAX) {
  const index = queue.findIndex((queued) => queued.priority > item.priority);
  if (index < 0) queue.push(item);
  else queue.splice(index, 0, item);
  while (queue.length > maxSize) queue.pop();
  return queue;
}
