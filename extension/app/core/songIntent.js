/** 点歌意图解析：支持比固定前缀更宽泛的说法。 */

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const UNIT = '(?:一首歌|一首|首歌|首|个|一下)';
const LEAD = '(?:我)?(?:(?:想要|想|要|能不能|可不可以|可以|能|帮我|给我|麻烦你?|求)[\\s,，:：]*)?';
const CHAT_ONLY = /^(?:你|您)?(?:说|讲|聊|唱)[说讲聊唱]?(?:天|话|歌|两句|一句|一下)?$/;

/**
 * 解析一条弹幕的点歌意图。
 * 支持：点歌 / 点一首 / 点首 / 点个 / 想听 / 来一首 / 放首 / 播首 / 播放 / 唱首 / 求一首，
 * 以及「主播」「我想」「可以」「帮我」等前缀。
 * @param {string} content 弹幕内容
 * @param {string} prefix 设置里的点歌前缀
 * @returns {string|null} null 表示不是点歌；空字符串表示有点歌意图但没带歌名
 */
export function parseSongQuery(content, prefix = '点歌') {
  let text = String(content || '').trim();
  if (!text) return null;
  // 去掉开头的 @昵称
  text = text.replace(/^(?:@[^\s@]+[\s:：,，]*)+/, '').trim();
  // 去掉开头的主播称呼
  text = text.replace(/^(?:主播|老师|大肥鱼|鲸鱼娘|肥鱼|宝宝|姐姐|妹妹)[\s,，:：]*/i, '').trim();
  if (!text) return null;

  const custom = String(prefix || '').trim() || '点歌';
  const triggers = [
    escapeRegExp(custom),
    '点(?:歌|一首歌|一首|首歌|首|个|一下)',
    `(?:好)?(?:想|要)听${UNIT}?`,
    `来${UNIT}`,
    `放${UNIT}`,
    `播放${UNIT}?`,
    `播${UNIT}`,
    `唱${UNIT}`,
    `整${UNIT}`,
    `求${UNIT}`,
  ];
  const match = text.match(
    new RegExp(`^${LEAD}(?:${triggers.join('|')})\\s*[:：,，、]?\\s*([\\s\\S]*)$`, 'i'),
  );
  if (!match) return null;

  const query = match[1]
    .trim()
    .replace(/^(?:你|您|主播|大肥鱼|鲸鱼娘|肥鱼)?\s*(?:唱|放|播)(?:一)?(?:首|下)?\s*/i, '')
    .replace(/[\s,，。.!！?？~～]+$/g, '')
    .replace(/(?:可以吗|行吗|好吗|好不好|谢谢|拜托|吧|呀|啊|哦|噢|呢|哈|嘛|吗)+$/g, '')
    .trim();
  // “想听你说话/聊聊天”这类是闲聊，不算点歌
  if (CHAT_ONLY.test(query)) return null;
  // “我要听歌 / 听会儿歌”没带具体歌名，按有点歌意图但没歌名处理
  if (/^(?:歌|首歌|音乐|曲子|会儿|会|一会儿|会儿歌|一会儿歌)$/.test(query)) return '';
  // “播放器卡了 / 播放列表”不是点歌
  if (/^(?:器|列表|暂停|继续|功能|视频|电影|广告)/.test(query)) return null;
  return query;
}

const PET_HELP_TAIL =
  '(?:吧|呀|啊|哦|噢|呗|嘛|呢|了|吗|么|谢谢|拜托|求求你|求求你了|好吗|行吗|行不行|可以吗|好不好|可不可以)*';
const PET_HELP_RE = new RegExp(
  `^(?:你|您)?(?:请|麻烦你?|能不能|可不可以|可以|能|求你|求求你了?)?(?:能|可以)?(?:帮我|给我|替我|为我|帮忙|帮|给)点(?:一首歌|一首|首歌|首|个歌|歌)${PET_HELP_TAIL}$`,
  'i',
);

/**
 * 判断一条弹幕是不是让桌宠帮忙点一首歌（不指定歌名）。
 * 支持：帮我点首歌 / 给我点一首歌 / 大肥鱼帮我点首歌 / 桌宠帮我点歌 等。
 * 带具体歌名的（如「帮我点首歌 晴天」）不算，仍走普通点歌。
 * @param {string} content 弹幕内容
 * @returns {boolean}
 */
export function isPetSongHelp(content) {
  let text = String(content || '').trim();
  if (!text) return false;
  text = text.replace(/^(?:@[^\s@]+[\s:：,，]*)+/, '');
  text = text.replace(/^(?:主播|老师|大肥鱼|鲸鱼娘|肥鱼|鱼|桌宠|宝宝|姐姐|妹妹)[\s,，:：]*/i, '');
  text = text.replace(/[\s,，。.!！?？~～、:：]/g, '');
  if (!text || text.length > 30) return false;
  return PET_HELP_RE.test(text);
}

const CUT_BODY = [
  '(?:这首|这首歌|这歌)(?:歌)?(?:不好听|不行|太难听|不喜欢|听腻了|听够了|不要了?|不听了?|不想听了?)(?:切歌|换歌|换一首|下一首|跳过|切了)?',
  '(?:不要|不想|不听)(?:听)?(?:这首|这首歌)(?:歌|了)?',
  '(?:这首|这首歌)切(?:了|掉)?',
  '切歌',
  '切掉(?:这首|这首歌|它)?',
  '切了',
  '切下一首',
  '切首(?:歌)?',
  '切一首(?:歌)?',
  '切首歌',
  '切一下',
  '切个',
  '换歌',
  '换下一首',
  '换首(?:歌)?',
  '换一首(?:歌)?',
  '换首歌',
  '换一个(?:歌)?',
  '下一首歌?',
  '下一曲',
  '跳过(?:这首|这首歌)?',
].join('|');

const CUT_LEAD =
  '(?:把)?(?:我)?(?:(?:想要|想|要|能不能|可不可以|可以|能|帮我|给我|麻烦你?|求求了?|求你了?)[\\s,，:：]*)?(?:直接|赶紧|快点|快|速度|马上)?';
const CUT_TAIL = '(?:吧|呀|啊|哦|呢|哈|嘛|吗|谢谢|拜托|求求了|快点儿?|好吗|行吗|可以吗|了)?';

/**
 * 判断一条弹幕是不是切歌指令。
 * 支持：切歌 / 切一首 / 切掉这首 / 换一首 / 下一首 / 跳过 / 这首不好听 等说法。
 * @param {string} content 弹幕内容
 * @returns {boolean}
 */
export function parseCutSongIntent(content) {
  let text = String(content || '').trim();
  if (!text) return false;
  text = text.replace(/^(?:@[^\s@]+[\s:：,，]*)+/, '');
  text = text.replace(/^(?:主播|老师|大肥鱼|鲸鱼娘|肥鱼|宝宝|姐姐|妹妹)[\s,，:：]*/i, '');
  text = text.replace(/(?:主播|大肥鱼|鲸鱼娘|肥鱼)$/i, '');
  text = text.replace(/[\s,，。.!！?？~～、:：]/g, '');
  if (!text) return false;
  return new RegExp(`^${CUT_LEAD}(?:${CUT_BODY})${CUT_TAIL}$`, 'i').test(text);
}

const CN_VALUE = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 中文数字转 0~100 的数值，只处理直播里常见的「十 / 十五 / 三十 / 一百」。 */
function chineseToNumber(word) {
  if (!word) return null;
  if (word === '十') return 10;
  if (word === '一百') return 100;
  if (/^[零一二两三四五六七八九]$/.test(word)) return CN_VALUE[word];
  const ten = word.match(/^([一二两三四五六七八九])?十([一二两三四五六七八九])?$/);
  if (ten) return (ten[1] ? CN_VALUE[ten[1]] : 1) * 10 + (ten[2] ? CN_VALUE[ten[2]] : 0);
  const hundred = word.match(/^([一二两三四五六七八九])百$/);
  if (hundred) return CN_VALUE[hundred[1]] * 100;
  return null;
}

/** 取「音量调到五十」里的中文数字音量；没有明确的调音量动作不匹配，避免误伤「小一点」「第一」等说法。 */
function chineseVolumeValue(text) {
  const hasSetVerb = /(?:调到|调成|调整到|设置为|设为|改成|改到|开到|放到|拨到|打到)/.test(text) || /%|％/.test(text);
  if (!hasSetVerb) return null;
  const percentWord = text.match(/百分之([零一二两三四五六七八九十百]+)/);
  if (percentWord) {
    const value = chineseToNumber(percentWord[1]);
    if (value !== null) return value;
  }
  for (const match of text.matchAll(/[零一二两三四五六七八九十百]+/g)) {
    const before = text[match.index - 1] || '';
    const after = text[match.index + match[0].length] || '';
    if (/[第初点]/.test(before) || /[半倍点下些分秒时个次遍之]/.test(after)) continue;
    const value = chineseToNumber(match[0]);
    if (value !== null) return value;
  }
  return null;
}

/**
 * 识别音乐音量指令。
 * 支持：音量调到40 / 声音30% / 音量调到五十 / 声音大点 / 小点声 / 音量拉满 / 音量调到最小 / 音量加10 等。
 * @returns {{action:'set'|'up'|'down'|'max'|'min', volume?:number, step?:number}|null}
 */
export function parseVolumeIntent(content) {
  let text = String(content || '').trim();
  if (!text) return null;
  text = text.replace(/^(?:@[^\s@]+[\s:：,，]*)+/, '');
  text = text.replace(/[\s,，。.!！?？~～、:：]/g, '');
  if (!text) return null;

  if (/(?:最大(?:声|音量)?|音量(?:开到|调到|调成|拉到)?最大|声音(?:开到|调到|调成)?最大|拉满|满格)/.test(text)) {
    return { action: 'max' };
  }
  if (/(?:最小(?:声|音量)?|音量(?:开到|调到|调成|拉到)?最小|声音(?:开到|调到|调成)?最小)/.test(text)) {
    return { action: 'min' };
  }

  const relative = text.match(/(?:音量|声音|音乐)?(?:加|减|调高|调低)(?:音量|声音)?(\d{1,2})/);
  if (relative) {
    return { action: /减|调低/.test(relative[0]) ? 'down' : 'up', step: Number(relative[1]) };
  }

  const hasContext =
    /(?:音量|声音|音乐)/.test(text) ||
    /(?:调到|调成|调整到|设置为|设为|改成|改到|开到|放到)/.test(text) ||
    /%|％/.test(text);
  const numeric = text.match(/(\d{1,3})(?:%|％)?/);
  if (numeric && hasContext) return { action: 'set', volume: Number(numeric[1]) };
  const chineseVolume = chineseVolumeValue(text);
  if (chineseVolume !== null) return { action: 'set', volume: chineseVolume };

  const hasMusicWord = /(?:音量|声音|音乐|歌|曲)/.test(text);
  if (!hasMusicWord && !/(?:大声|小声|小点声|大点声|响一点|轻一点)/.test(text)) return null;

  if (
    /(?:大|高|响)(?:一点|一些|点|些|声)|调大|开大|加大|调高|开高|升高|增加|提高(?:音量|声音)|加(?:点)?(?:音量|声音)|(?:太|好|有点)小|音量(?:再)?大|声音(?:再)?大|大声|往上调|调上去/.test(
      text,
    )
  ) {
    return { action: 'up' };
  }
  if (
    /(?:小|低|轻)(?:一点|一些|点|些|声)|调小|关小|减小|调低|关低|降低|减少|降下来|往下调|调下去|降低(?:音量|声音)|减(?:点)?(?:音量|声音)|(?:太|好|有点)大|吵|音量(?:再)?小|声音(?:再)?小|小声|轻一点/.test(
      text,
    )
  ) {
    return { action: 'down' };
  }
  return null;
}

const JUMP_WORD = '(?:插队|插个队|插一下队|插个位|插位|加塞)';
const JUMP_QUESTION_RE = new RegExp(
  [
    // 怎么 / 如何 + 插队
    `(?:怎么|怎么样|怎样|如何|咋样|咋)(?:才能|才可以|可以|能|才|样|弄|搞)?${JUMP_WORD}`,
    // 插队 + 疑问 / 条件
    `${JUMP_WORD}(?:怎么|咋|怎么样|如何|是什么|是啥|什么意思|啥意思|怎么弄|怎么搞|咋弄|咋搞|要|需要|送|用|能|可以|行|有用|有啥|有什么用)`,
    // 能 / 可以 / 想要 + 插队
    `(?:能|能不能|可以|可不可以|想|想要|要)${JUMP_WORD}(?:吗|么|嘛|不|呢)?`,
    // 什么是插队
    `(?:什么|啥)(?:是|叫)${JUMP_WORD}`,
    // 插队 + 吗
    `${JUMP_WORD}(?:吗|么|嘛)`,
  ].join('|'),
);

/**
 * 判断一条弹幕是不是在询问插队规则（如「怎么插队」「想插队要送什么」）。
 * @param {string} content 弹幕内容
 * @returns {boolean}
 */
export function isQueueJumpQuestion(content) {
  let text = String(content || '').replace(/\s+/g, '');
  if (!text) return false;
  text = text.replace(/^(?:@[^\s@]+[\s:：,，]*)+/, '');
  if (!text || text.length > 30) return false;
  // 点歌语句里的「插队」可能是歌名，不当成咨询
  if (/^(?:点歌|点一首|点首歌|点首|点个|想听|来一首|来首|播放|放一首|放首|唱一首|唱首|求一首)/.test(text)) {
    return false;
  }
  // 「不要插队 / 别插队」是在制止别人，不是咨询
  if (/(?:不要|不想|不用|不需要|别|禁止|不准|不许|莫)(?:再)?(?:插队|插个队)/.test(text)) return false;
  // 只发「插队」两个字，也视为在问怎么插队
  if (/^(?:插队|插个队|插一下队)[!！。.~～]*$/.test(text)) return true;
  return JUMP_QUESTION_RE.test(text);
}

/**
 * 判断一条弹幕是不是在询问切歌规则（而不是真的发切歌指令）。
 * 切歌指令只认「切歌」两个字；「切歌到某某」「切到第 3 首」这类都算咨询。
 * @param {string} content 弹幕内容
 * @returns {boolean}
 */
export function isCutSongQuestion(content) {
  let text = String(content || '').replace(/\s+/g, '');
  if (!text) return false;
  text = text.replace(/^(?:@[^\s@]+[\s:：,，]*)+/, '');
  if (!text || text.length > 30) return false;
  // 能执行的切歌指令（含既有可执行说法）不算咨询，避免抢走指令
  if (parseCutSongIntent(text)) return false;
  // 「切到副歌」是聊歌曲本身，不是问切歌
  if (/副歌/.test(text)) return false;

  // 切歌到 xxx / 切到（第 3 首 / 某人的歌）
  if (/切歌(?:到|至|去|成|为)/.test(text)) return true;
  if (/切(?:到|至|去)(?:第[一二三四五六七八九十0-9xX]+(?:首|个|支)|[^。！？!?]{1,10}(?:歌|曲|首))/.test(text)) return true;
  // 怎么切歌 / 切歌规则 / 什么是切歌
  if (/(?:怎么|如何|咋|怎样)(?:才能|才可以|可以|能|样)?(?:切歌|切到|换歌)/.test(text)) return true;
  if (/(?:切歌|换歌)(?:有什么|有啥|有哪些)?(?:规则|条件|要求|逻辑|注意事项)/.test(text)) return true;
  if (/(?:切歌|换歌)(?:怎么|咋|是什么意思|啥意思|什么意思|是什么)/.test(text)) return true;
  if (/(?:什么|啥)(?:是|叫)切歌/.test(text)) return true;
  return false;
}

