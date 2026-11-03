/**
 * 互动剧场：弹幕投票驱动的 AI 剧情。
 * 只做纯逻辑（状态流转、投票解析、AI 提示词、返回解析），不碰浏览器 API，便于单元测试。
 */

export const STORY_VOTE_SEC = 30;
export const STORY_WHEEL_SEC = 4;
/** 每场剧情的幕数范围：4～6 幕之间随机，避免每场都一个长度 */
export const STORY_MIN_NODES = 4;
export const STORY_MAX_NODES = 6;
/** 每一幕的剧情走向数量与编号：A / B / C / D */
export const STORY_CHOICES = ['A', 'B', 'C', 'D'];

/** 随机决定本场演几幕（含首尾）：4～6 幕 */
export function resolveStoryActs(random = Math.random) {
  const roll = Number(random());
  const safeRoll = Number.isFinite(roll) ? Math.min(0.999999, Math.max(0, roll)) : 0;
  const span = STORY_MAX_NODES - STORY_MIN_NODES + 1;
  return STORY_MIN_NODES + Math.floor(safeRoll * span);
}

/** 题材池：每场随机挑一个，省掉「演什么」这一轮 AI 调用；一半是不含鲸鱼娘的通用故事 */
export const STORY_TOPICS = [
  '深海鲸鱼岛的海底宝藏',
  '大肥鱼误闯人类便利店',
  '月光下的鲸鱼音乐会',
  '肥鱼的厨艺大赛',
  '会说话的西瓜成精了',
  '台风夜的直播间突然停电',
  '小猫咪的深夜快递站',
  '小镇面包店的神秘顾客',
  '一只想学飞的纸飞机',
  '鲸鱼娘的第一次上学',
];

/** 主播指定了剧场主题就用它，否则从题材池随机挑一个 */
export function resolveStoryTopic(topic, random = Math.random) {
  const custom = String(topic || '').trim().slice(0, 30);
  if (custom) return custom;
  const index = Math.floor(random() * STORY_TOPICS.length);
  return STORY_TOPICS[Math.min(STORY_TOPICS.length - 1, Math.max(0, index))];
}

/**
 * 弹幕点播口令「剧场xxxx」：剧场后可带空格、冒号、顿号等分隔符，主题 1~20 字。
 * 返回主题文本；不是点播口令时返回空串。
 */
export function parseStoryCommand(content, maxTopic = 20) {
  const text = String(content || '').trim();
  if (!text || text.length > maxTopic + 6) return '';
  const match = /^剧场\s*[：:、，,\-—]?\s*([^\r\n]{1,20})$/.exec(text);
  if (!match) return '';
  const topic = match[1].trim().slice(0, maxTopic);
  return topic.length >= 1 ? topic : '';
}

/**
 * 弹幕收场口令：观众发「结束剧场 / 结束当前剧情 / 剧场结束」即可提前收场。
 * 只认整句，避免正常聊天里带「结束」两个字就被误判。
 */
export function isStoryStopCommand(content) {
  const text = String(content || '')
    .trim()
    .replace(/^@\S+[\s,，:：]+/, '')
    .replace(/[！!。．.～~？?]+$/, '')
    .trim();
  if (!text || text.length > 12) return false;
  return /^(?:(?:结束|关闭|收场)(?:当前|这场|本场)?(?:剧场|剧情|故事)|(?:剧场|剧情|故事)(?:结束|收场)吧?)$/.test(text);
}

// 投票只认极短口令：单字母 / 单数字 / 选X / X选项，避免误吞正常弹幕
const CHOICE_A_RE = /^[选拣挑]?\s*[AaＡ](?:选项|号)?$/;
const CHOICE_B_RE = /^[选拣挑]?\s*[BbＢ](?:选项|号)?$/;
const CHOICE_C_RE = /^[选拣挑]?\s*[CcＣ](?:选项|号)?$/;
const CHOICE_D_RE = /^[选拣挑]?\s*[DdＤ](?:选项|号)?$/;
const CHOICE_1_RE = /^[选拣挑]?\s*[1１](?:选项|号)?$/;
const CHOICE_2_RE = /^[选拣挑]?\s*[2２](?:选项|号)?$/;
const CHOICE_3_RE = /^[选拣挑]?\s*[3３](?:选项|号)?$/;
const CHOICE_4_RE = /^[选拣挑]?\s*[4４](?:选项|号)?$/;

const EMOTION_MAP = {
  开心: 'happy',
  高兴: 'happy',
  欢乐: 'happy',
  难过: 'sad',
  悲伤: 'sad',
  委屈: 'sad',
  激动: 'excited',
  兴奋: 'excited',
  惊讶: 'surprised',
  吃惊: 'surprised',
  害羞: 'shy',
  不好意思: 'shy',
  生气: 'angry',
  愤怒: 'angry',
};

const EMOTIONS = ['happy', 'sad', 'excited', 'surprised', 'shy', 'angry', 'neutral'];

/** 解析弹幕里的投票口令：A / B / C / D / 1~4 / 选A / A选项；不是投票返回 null */
export function parseVoteChoice(content) {
  // 先剥掉开头的「@鲸鱼娘 」称呼，观众常带着昵称投一票
  const text = String(content || '')
    .trim()
    .replace(/^@\S+[\s,，:：]+/, '')
    .replace(/@/g, '')
    .replace(/\s+/g, '');
  if (!text || text.length > 6) return null;
  if (CHOICE_A_RE.test(text) || CHOICE_1_RE.test(text)) return 'A';
  if (CHOICE_B_RE.test(text) || CHOICE_2_RE.test(text)) return 'B';
  if (CHOICE_C_RE.test(text) || CHOICE_3_RE.test(text)) return 'C';
  if (CHOICE_D_RE.test(text) || CHOICE_4_RE.test(text)) return 'D';
  return null;
}

export function createStoryState() {
  return {
    active: false,
    topic: '',
    step: 0,
    maxSteps: STORY_MIN_NODES,
    phase: 'idle', // idle | narrating | voting | wheel | ending | closed
    node: null,
    nodeId: '',
    votes: new Map(),
    lastChoice: '',
    wheelChoice: '',
    wheelEndsAt: 0,
    startedAt: 0,
    voteEndsAt: 0,
    history: [],
    // 剧本设定（剧名/主角/世界/目标），由第一幕生成，后续每一幕和结局都沿用
    bible: null,
  };
}

/** 初始化一场新剧情：清空票数、重置进度，并随机决定本场演 4～6 幕 */
export function beginStory(story, topic, now = Date.now(), random = Math.random) {
  const next = story || createStoryState();
  next.active = true;
  next.topic = String(topic || '').trim();
  next.bible = null;
  next.step = 0;
  next.maxSteps = resolveStoryActs(random);
  next.phase = 'narrating';
  next.node = null;
  next.nodeId = '';
  next.votes = new Map();
  next.lastChoice = '';
  next.wheelChoice = '';
  next.wheelEndsAt = 0;
  next.startedAt = now;
  next.voteEndsAt = 0;
  next.history = [];
  return next;
}

/** 进入某个节点的投票阶段；sameNode 为 true 时不重复清空已有票数 */
export function openVoting(story, node, { now = Date.now(), seconds = STORY_VOTE_SEC, sameNode = false } = {}) {
  story.phase = 'voting';
  story.node = node || story.node;
  if (!sameNode) story.votes = new Map();
  story.voteEndsAt = now + Math.max(3, Number(seconds) || STORY_VOTE_SEC) * 1000;
  return story;
}

export function closeStory(story) {
  if (!story) return story;
  story.phase = 'closed';
  story.active = false;
  story.voteEndsAt = 0;
  story.wheelChoice = '';
  story.wheelEndsAt = 0;
  return story;
}

/**
 * 记一票：同一观众（按抖音 id 优先，其次昵称）只有第一票算数。
 * @returns {{ok:boolean, choice?:string, total?:number, reason?:string, duplicate?:boolean}}
 */
export function recordVote(story, choice, userKey) {
  if (!story || story.phase !== 'voting') return { ok: false, reason: '现在不是投票时间' };
  if (!choice) return { ok: false, reason: '不是有效选项' };
  const key = String(userKey || '').trim();
  if (!key) return { ok: false, reason: '认不出这位观众' };
  if (story.votes.has(key)) return { ok: false, reason: '这一轮已经投过啦', duplicate: true };
  story.votes.set(key, choice);
  return { ok: true, choice, total: story.votes.size };
}

export function tallyVotes(story) {
  const result = { a: 0, b: 0, c: 0, d: 0, total: 0 };
  if (!story || !story.votes) return result;
  for (const choice of story.votes.values()) {
    const key = String(choice || '').trim().toUpperCase();
    if (!STORY_CHOICES.includes(key)) continue;
    result[key.toLowerCase()] += 1;
  }
  result.total = result.a + result.b + result.c + result.d;
  return result;
}

/** 结算：票多者胜；平票（含零票）在并列领先的走向里随机，避免剧情卡死在某一条分支 */
export function resolveWinner(story, random = Math.random) {
  const tally = tallyVotes(story);
  const max = Math.max(tally.a, tally.b, tally.c, tally.d);
  const leaders = STORY_CHOICES.filter((choice) => tally[choice.toLowerCase()] === max);
  const roll = Number(random());
  const safeRoll = Number.isFinite(roll) ? Math.min(0.999999, Math.max(0, roll)) : 0;
  const choice = leaders[Math.min(leaders.length - 1, Math.floor(safeRoll * leaders.length))] || 'A';
  return { choice, tied: leaders.length > 1 || tally.total === 0, ...tally };
}

/** 取某一幕某个走向的文案：choice 为 A/B/C/D，节点字段对应 a/b/c/d */
export function storyOptionText(node, choice) {
  const key = String(choice || '').trim().toUpperCase();
  if (!STORY_CHOICES.includes(key)) return '';
  return String((node && node[key.toLowerCase()]) || '');
}

/** 把上一节点的选择压进历史，供下一节点续写 */
export function pushHistory(story, node, choice) {
  if (!story) return;
  const pressed = String(choice || '').trim().toUpperCase();
  const pickedChoice = STORY_CHOICES.includes(pressed) ? pressed : 'A';
  story.history.push({
    scene: (node && node.scene) || '',
    narration: (node && node.narration) || '',
    choice: pickedChoice,
    picked: storyOptionText(node, pickedChoice).slice(0, 40),
  });
  // 最多存 6 幕（最长剧情），结局回顾才能照顾到整场故事的每一次选择
  while (story.history.length > STORY_MAX_NODES) story.history.shift();
  return story;
}

/** 历史压缩成一行，控制提示词长度 */
export function historyLine(history) {
  const all = Array.isArray(history) ? history : [];
  const items = all.slice(-4);
  if (!items.length) return '（还没有剧情，这是开场）';
  const offset = all.length - items.length;
  return items
    .map((item, index) => `第${offset + index + 1}幕「${item.scene || '场景'}」：观众选了${item.choice}（${item.picked || '无'}）`)
    .join('；');
}

export function normalizeEmotion(value) {
  const key = String(value || '').trim();
  if (!key) return 'neutral';
  const lower = key.toLowerCase();
  if (EMOTIONS.includes(lower)) return lower;
  return EMOTION_MAP[key] || 'neutral';
}

/**
 * 解析 AI 返回的剧情节点 JSON。容忍 markdown 代码块和前后说明文字。
 * 每一幕必须有四条走向（a/b/c/d，也接受 options 数组），缺任何一条都视为无效节点。
 * @returns {{scene:string, narration:string, a:string, b:string, c:string, d:string, emotion:string}|null}
 */
export function parseStoryNode(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let data;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const narration = String(data.narration || data.line || '')
    .replace(/^["“'「]+|["”'」]+$/g, '')
    .trim()
    .slice(0, 180);
  const clip = (value, max) =>
    String(value || '')
      .replace(/^["“'「]+|["”'」]+$/g, '')
      .trim()
      .slice(0, max);
  const rawOptions = Array.isArray(data.options)
    ? data.options
    : [data.a || data.choiceA, data.b || data.choiceB, data.c || data.choiceC, data.d || data.choiceD];
  const options = rawOptions.slice(0, STORY_CHOICES.length).map((value) => clip(value, 30));
  if (!narration || options.length < STORY_CHOICES.length || options.some((item) => !item)) return null;
  const [a, b, c, d] = options;
  return {
    scene: clip(data.scene, 24),
    narration,
    a,
    b,
    c,
    d,
    emotion: normalizeEmotion(data.emotion),
    // 以下为丰富剧情用的可选字段：本幕作用、关键道具，以及第一幕埋下的整体设定
    beat: clip(data.beat, 12),
    prop: clip(data.prop, 18),
    title: clip(data.title, 20),
    protagonist: clip(data.protagonist, 24),
    setting: clip(data.setting, 28),
    goal: clip(data.goal, 40),
  };
}

/**
 * 剧情节点提示词的用户内容。
 * @returns {string}
 */
export function storyNodeUserPrompt(options = {}) {
  const {
    topic = '',
    step = 1,
    maxSteps = STORY_MAX_NODES,
    history = [],
    lastChoice = '',
    nickname = '',
    votes = { a: 0, b: 0, total: 0 },
    prompt = '',
    bible = null,
  } = options;
  const opening = step <= 1;
  const bibleLine = bible && (bible.title || bible.protagonist || bible.setting)
    ? `剧本设定（全场必须保持一致）：${[
        bible.title ? `剧名《${bible.title}》` : '',
        bible.protagonist ? `主角：${bible.protagonist}` : '',
        bible.setting ? `世界与地点：${bible.setting}` : '',
        bible.goal ? `主角目标：${bible.goal}` : '',
      ]
        .filter(Boolean)
        .join('；')}`
    : '';
  return [
    `本场故事主题：${String(topic || '深海鲸鱼岛').slice(0, 40)}`,
    `进度：第 ${step} / ${maxSteps} 幕${opening ? '（这是开场）' : ''}`,
    bibleLine,
    `前情：${historyLine(history)}`,
    !opening && lastChoice
      ? `上一幕观众投票结果：选择 ${lastChoice}，请先写清这个选择带来的具体后果，再推进新剧情，不要推翻观众的选择。`
      : '',
    votes && votes.total
      ? `这一幕有 ${votes.total} 位观众投票（A ${votes.a} 票 / B ${votes.b} 票 / C ${votes.c} 票 / D ${votes.d} 票）。`
      : '',
    nickname ? `这一幕可以把观众「${nickname}」自然写进剧情里，但最多提一次，不要每次都用。` : '',
    prompt ? `主播对剧情的额外要求（优先级最高，必须遵守，不要复述要求本身）：${String(prompt).slice(0, 200)}` : '',
    '这一幕要写成完整的小节：先承接上一幕的后果，再出现新的阻碍或发现，最后用一个具体画面收住。',
    '四个选项要是方向明显不同的具体行动（例如冒险、稳妥、求助、另辟蹊径），并暗示各自不同的代价；不要写「继续前进」「再看看」这类空选项。',
    '关键道具和配角要在整场故事里反复出现，形成前后呼应。',
    step >= maxSteps
      ? '这是最后一幕，请给出一个收尾或反转，让故事完整落幕。'
      : '这一幕请在结尾留一个悬念，让观众想投下一轮。',
    opening
      ? '格式固定：{"title":"剧名","protagonist":"主角身份","setting":"世界与地点","goal":"主角想要什么","scene":"场景名","beat":"起","prop":"关键道具","narration":"旁白台词","a":"选项A","b":"选项B","c":"选项C","d":"选项D","emotion":"happy"}'
      : '格式固定：{"scene":"场景名","beat":"承/转/合","prop":"关键道具","narration":"旁白台词","a":"选项A","b":"选项B","c":"选项C","d":"选项D","emotion":"happy"}',
    '直接输出 JSON，不要解释。',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 背景板 / 日志用的简短摘要 */
export function storyDigest(story) {
  if (!story) return '';
  const parts = [`主题「${story.topic || '未命名'}」`, `进度 ${story.step}/${story.maxSteps}`];
  if (story.phase === 'voting') parts.push('投票中');
  if (story.phase === 'ending') parts.push('大结局');
  if (story.phase === 'closed') parts.push('已结束');
  if (story.lastChoice) parts.push(`上一轮选 ${story.lastChoice}`);
  return parts.join('，');
}
