/** 闲聊分段回复：仅对纯闲聊把 AI 的一条完整回复拆成最多 3 条语义完整的短消息。 */

export const SEGMENT_LIMITS = {
  maxSegments: 3,
  maxSegmentChars: 30,
  maxTotalChars: 90,
};

const STRONG_BREAK_CHARS = '。！？!?；;….';
const WEAK_BREAK_CHARS = '，,、：:';
const ALL_BREAK_CHARS = STRONG_BREAK_CHARS + WEAK_BREAK_CHARS;
const CONJUNCTIONS = [
  '但是',
  '不过',
  '而且',
  '然后',
  '所以',
  '因为',
  '如果',
  '要是',
  '其实',
  '还有',
  '就是',
  '可是',
  '只是',
  '另外',
  '不然',
  '或者',
  '而是',
  '虽然',
  '尽管',
  '因此',
  '于是',
  '总之',
  '反正',
  '既然',
  '哪怕',
  '为了',
];
const PARTICLES = '的了着呢吧啊嘛呀哦';

// 任务型 / 功能性请求：出现这些特征时不走分段回复
const FUNCTIONAL_RULES = [
  // 代码、技术、配置类
  /(?:代码|脚本|程序|源码|函数|接口|数据库|服务器|文件|目录|路径|变量|报错|错误|异常|崩溃|闪退|卡顿|日志|调试|排查|修复|部署|配置|设置|参数|插件|扩展|浏览器|终端|命令行|文档|表格|密钥|权限|账号|密码|登录|注册|下载|上传|安装|卸载|重启|刷新|清空|重置|修改|调整|转换|格式|网址|链接)/i,
  // 直播间功能 / 数据 / 指令
  /(?:点歌|切歌|点一首|来一首|放一首|放首歌|放个歌|来首歌|点播|播放|放音乐|来点音乐|插队|甩飞|音量|报时|几点|几号|星期几|什么时间|什么时候|哪天|开播|下播|播多久|播到几点|直播多久|还记得|记得我|余额|回复|关注一下|点点关注|点个关注|关注我|已关注|没关注|礼物榜|送礼榜|排行榜|榜单|在线人数|观看人数|直播数据|玩法|口令|白饭多少|白饭统计|白饭数据|token来|token消耗|token用了|token统计|唱首歌|唱个歌|唱一下歌|唱一首|跳个舞|跳支舞|来个动作|做个动作|推荐(?:一首|个|一下|些)?(?:歌|音乐|礼物|游戏|电影|书))/i,
  // 明确的求助 / 操作指令
  /(?:帮我|帮忙|请帮|请你|麻烦你?|替我|给我查|给我搜|给我找|给我写|给我做|给我画|给我生成|给我统计|给我算|给我翻译|给我整理|给我总结|给我分析|给我改|给我调|给我设置|给我配置|给我装|给我下载|给我上传|给我打开|给我关闭|给我讲个笑话|给我说个笑话|教我|能不能帮|可以帮|会不会写|会不会做|会不会画|会不会查|会不会搜|会不会统计|会不会计算|会不会翻译|会不会整理|会不会总结|会不会分析|会不会配置|会不会安装|会不会下载)/,
  // 怎么操作 / 如何解决
  /(?:怎么|如何|咋|怎样)(?:解决|处理|设置|配置|修改|改|弄|做|操作|申请|下载|安装|注册|登录|用|玩|查|看|点歌|切歌|插队|甩飞|关注|点赞|打开|关闭|调|连接|绑定|部署|升级|更新|恢复|备份|办)/,
  // 故障 / 问题解决
  /(?:报错|出错|错误|异常|崩溃|闪退|没反应|不生效|打不开|不能用|有问题|出问题|失败了|不工作|卡住|卡死|连不上|掉线|断线|黑屏|白屏|怎么解决|怎么办)/,
  // 英文技术词与请求句式
  /\b(?:bug|bugs|code|coding|script|scripts|api|json|sql|http|https|git|npm|docker|python|javascript|typescript|java|node|linux|nginx|mysql|redis|server|database|config|configuration|settings?|parameter|plugin|extension|browser|terminal|command|file|files|folder|path|password|account|login|download|upload|install|uninstall|deploy|debug|error|exception|crash|fix|refactor|optimize|compile|build|commit|merge|push|pull)\b/i,
  /\b(?:help me|help us|can you|could you|would you|please|how (?:do|does|can|could|should|to)|what(?:'s| is) the|where (?:is|are)|explain|translate|summarize|calculate|generate|create|write|make|find|search|check|recommend)\b/i,
  /\b(?:how many|online viewers?|viewer count|gift (?:rank|ranking|stats)|token (?:usage|count|stats)|live stats)\b/i,
];

/** 判断是否属于纯闲聊：任务型、指令型、功能型消息一律返回 false。 */
export function isCasualChat(content) {
  const text = String(content || '')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .trim();
  if (!text) return false;
  // 纯表情 / 纯符号不算可回复的闲聊
  if (!/[A-Za-z0-9\u00c0-\u024f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/.test(text)) {
    return false;
  }
  return !FUNCTIONAL_RULES.some((rule) => rule.test(text));
}

function charLength(text) {
  return Array.from(String(text || '')).length;
}

function cleanText(text) {
  return String(text || '')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .replace(/^["“「'『]+|["”」'』]+$/g, '')
    .trim();
}

/** 按指定标点切成句/短语，标点保留在前一段末尾。 */
function tokenize(text, breakChars) {
  const units = [];
  let buffer = '';
  for (const char of Array.from(text)) {
    if (char === '\n') {
      if (buffer.trim()) units.push(buffer.trim());
      buffer = '';
      continue;
    }
    buffer += char;
    if (breakChars.includes(char)) {
      if (buffer.trim()) units.push(buffer.trim());
      buffer = '';
    }
  }
  if (buffer.trim()) units.push(buffer.trim());
  return units;
}

function lastIndexOfAny(chars, targets, limit) {
  for (let index = Math.min(limit, chars.length - 1); index > 0; index -= 1) {
    if (targets.includes(chars[index])) return index;
  }
  return -1;
}

function lastConjunctionIndex(chars, limit) {
  for (let index = Math.min(limit, chars.length - 2); index > 0; index -= 1) {
    const pair = chars[index] + chars[index + 1];
    if (CONJUNCTIONS.includes(pair)) return index;
  }
  return -1;
}

function lastParticleIndex(chars, limit) {
  for (let index = Math.min(limit, chars.length - 2); index > 0; index -= 1) {
    if (PARTICLES.includes(chars[index])) return index + 1;
  }
  return -1;
}

/**
 * 超长且没有任何停顿标点时，按最接近自然停顿的位置拆开：
 * 弱标点 > 空格 > 关联词 > 语气词 > 兜底切断。
 * 兜底切断只用于模型输出完全无停顿的极端情况，正常有标点的回复不会走到这一步。
 */
function breakLongClause(text, limit) {
  const pieces = [];
  let rest = String(text || '');
  while (charLength(rest) > limit) {
    const chars = Array.from(rest);
    let cut = lastIndexOfAny(chars, WEAK_BREAK_CHARS, limit);
    if (cut > 0) {
      pieces.push(chars.slice(0, cut + 1).join(''));
      rest = chars.slice(cut + 1).join('');
      continue;
    }
    cut = lastIndexOfAny(chars, ' ', limit);
    if (cut > 0) {
      pieces.push(chars.slice(0, cut).join(''));
      rest = chars.slice(cut + 1).join('');
      continue;
    }
    cut = lastConjunctionIndex(chars, limit);
    if (cut > 0) {
      pieces.push(chars.slice(0, cut).join(''));
      rest = chars.slice(cut).join('');
      continue;
    }
    cut = lastParticleIndex(chars, limit);
    if (cut > 0 && cut < chars.length) {
      pieces.push(chars.slice(0, cut).join(''));
      rest = chars.slice(cut).join('');
      continue;
    }
    pieces.push(chars.slice(0, limit).join(''));
    rest = chars.slice(limit).join('');
  }
  pieces.push(rest);
  return pieces.filter((piece) => piece.trim());
}

/** 把超长句按逗号等自然停顿拆成不超过 limit 的小段。 */
function splitOversize(unit, limit) {
  if (charLength(unit) <= limit) return [unit];
  const clauses = tokenize(unit, WEAK_BREAK_CHARS);
  if (clauses.length <= 1) return breakLongClause(unit, limit);
  const pieces = [];
  for (const clause of clauses) {
    if (charLength(clause) <= limit) pieces.push(clause);
    else pieces.push(...breakLongClause(clause, limit));
  }
  return pieces.filter((piece) => piece.trim());
}

/** 合并两个语义单元；英文之间补空格，中文直接相连。 */
function joinUnits(left, right) {
  if (!left) return right;
  if (!right) return left;
  const lastChar = Array.from(left).slice(-1)[0] || '';
  const firstChar = Array.from(right)[0] || '';
  if (/[A-Za-z0-9]/.test(firstChar) && /[.!?,;:]/.test(lastChar)) return `${left} ${right}`;
  if (/[A-Za-z0-9]/.test(lastChar) && /[A-Za-z0-9]/.test(firstChar)) return `${left} ${right}`;
  return `${left}${right}`;
}

/**
 * 按顺序合并成最多 maxSegments 段，尽量均匀分配长度，
 * 保证每段不超过 maxChars、总量不超过 maxTotal。
 */
function packUnits(units, maxChars, maxTotal, maxSegments) {
  const totalLength = units.reduce((sum, unit) => sum + charLength(unit), 0);
  const target = Math.max(
    1,
    Math.min(maxChars, Math.ceil(Math.min(totalLength, maxTotal) / Math.max(1, maxSegments))),
  );
  const segments = [];
  let current = '';
  let total = 0;
  for (const unit of units) {
    const length = charLength(unit);
    if (total + length > maxTotal) break;
    if (!current) {
      current = unit;
      total += length;
      continue;
    }
    const merged = joinUnits(current, unit);
    if (charLength(merged) > maxChars || charLength(current) >= target) {
      segments.push(current);
      current = unit;
      total += length;
    } else {
      total += charLength(merged) - charLength(current);
      current = merged;
    }
  }
  if (current) segments.push(current);
  return segments;
}

function polishSegment(segment) {
  return String(segment || '')
    .replace(/^[\s，,、：:；;。.!！?？…]+/, '')
    .replace(/[\s，,、：:；;]+$/, '')
    .trim();
}

/**
 * 把一条完整闲聊回复按自然语义停顿拆分。
 * 返回最多 3 条、每条最多 30 字、总字数最多 90 字的消息，顺序与原回复一致。
 */
export function splitReplySegments(text, options = {}) {
  const maxSegments = Math.max(1, Math.min(3, Number(options.maxSegments) || SEGMENT_LIMITS.maxSegments));
  const maxSegmentChars = Math.max(
    10,
    Math.min(30, Number(options.maxSegmentChars) || SEGMENT_LIMITS.maxSegmentChars),
  );
  const maxTotalChars = Math.max(
    maxSegmentChars,
    Math.min(90, Number(options.maxTotalChars) || SEGMENT_LIMITS.maxTotalChars),
  );

  const cleaned = cleanText(text);
  if (!cleaned) return [];

  // 先按句号 / 问号 / 感叹号等强停顿切成完整句子，超长句再按逗号拆分
  const sentenceUnits = tokenize(cleaned, STRONG_BREAK_CHARS)
    .flatMap((unit) => splitOversize(unit, maxSegmentChars))
    .filter((unit) => unit.trim());

  let segments = sentenceUnits;
  // 整条回复只有一句话、但句子较长且句内有自然停顿时，也按逗号停顿拆成多条
  if (segments.length === 1 && charLength(cleaned) > 20) {
    const clauseUnits = tokenize(cleaned, WEAK_BREAK_CHARS)
      .flatMap((unit) => splitOversize(unit, maxSegmentChars))
      .filter((unit) => unit.trim());
    if (clauseUnits.length >= 2) {
      segments = clauseUnits.length <= maxSegments
        ? clauseUnits
        : packUnits(clauseUnits, maxSegmentChars, maxTotalChars, maxSegments);
    }
  }
  if (segments.length > maxSegments) {
    segments = packUnits(segments, maxSegmentChars, maxTotalChars, maxSegments);
  }

  // 句子粒度仍然超过 3 条时，降到逗号级短语重新组合，尽量保留全部内容
  if (segments.length > maxSegments) {
    let clauseUnits = tokenize(cleaned, ALL_BREAK_CHARS)
      .flatMap((unit) => splitOversize(unit, maxSegmentChars))
      .filter((unit) => unit.trim());
    segments = packUnits(clauseUnits, maxSegmentChars, maxTotalChars, maxSegments);
    while (segments.length > maxSegments && clauseUnits.length > 0) {
      clauseUnits = clauseUnits.slice(0, -1);
      segments = packUnits(clauseUnits, maxSegmentChars, maxTotalChars, maxSegments);
    }
  }

  segments = segments
    .map(polishSegment)
    .filter((segment) => segment && charLength(segment) <= maxSegmentChars)
    .slice(0, maxSegments);

  let total = segments.reduce((sum, segment) => sum + charLength(segment), 0);
  while (segments.length && total > maxTotalChars) {
    total -= charLength(segments.pop());
  }
  return segments;
}
