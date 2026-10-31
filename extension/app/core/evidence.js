/**
 * 观众访问争议留证：识别「我没来过 / 你记错了」这类否认，
 * 并把留证台账的时间线整理成可核对、可公屏展示的证据文案。
 *
 * 判定只看留证台账：有记录就展示完整时间线，没有记录就致歉并记录误判，
 * 不做任何主观推断。
 */

export const VISIT_ACTIONS = ['enter', 'chat', 'gift', 'like', 'follow', 'share', 'song'];

const ACTION_LABELS = {
  enter: '进入直播间',
  chat: '发言',
  gift: '送礼',
  like: '点赞',
  follow: '关注主播',
  share: '分享直播间',
  song: '点歌',
};

// 否认进过直播间（我没来过你直播间 / 我从来没去过你的直播间 / 我没进过你这儿）
const DENY_VISIT_RE =
  /(?:我|人家)(?:根本|绝对|真的|压根|从来|从来也)?(?:没|没有|从未|未曾)(?:来|进|去|到)(?:过)?(?:你|你的|这个|该|这)?(?:的)?(?:直播间|房间|直播|这儿|这里)/;
// 更短的口语否认（我没来过你这 / 没进过你这儿）
const DENY_VISIT_SHORT_RE = /(?:我|人家)(?:根本|绝对|真的|压根|从来|从来也)?(?:没|没有|从未|未曾)(?:来|进)(?:过)(?:你|你这|这儿|这里)/;
// 否认具体互动（我没点过歌 / 我没送过礼物 / 我没给你点过赞）
const DENY_ACTION_RE =
  /(?:我|人家)(?:根本|绝对|真的|压根|从来|从来也)?(?:没|没有|从未|未曾)(?:(?:给|帮)(?:你|主播|鲸鱼娘)?)?(?:点|送|刷|赞|关注|发)(?:过)?(?:歌|礼物|礼|赞|心|言|弹幕|你)/;
// 反问式否认（我什么时候来过你直播间）
const WHEN_VISIT_RE =
  /(?:我|人家)(?:什么|啥|哪|几)(?:时候|会儿|时)?(?:来|进|去)(?:过)(?:你|你的|这|这个)?(?:的)?(?:直播间|房间|直播|这儿|这里)?/;
// 直接质疑记忆判断（你记错了 / 你是不是记错人 / 你乱说）；单纯说「我记错了」不算
const ACCUSE_RE =
  /(?:你|主播|鲸鱼娘|大肥鱼|桌宠)(?:是不是|又)?(?:记错|记混|认错人|瞎说|乱说|胡说|造谣|编的|骗人)|记错了吧|记混了吧/;
// 点歌、切歌等明确指令优先走原流程，不按争议处理
const COMMAND_RE = /(?:点歌|想听|来一首|唱一首|放一首|播一首|播放|切歌|音量|插队)/;

/** 判断弹幕是否在否认访问记录（争议处理入口）。 */
export function isVisitDispute(content) {
  const text = String(content || '').replace(/\s+/g, '');
  if (!text) return false;
  if (Array.from(text).length > 60) return false;
  if (COMMAND_RE.test(text)) return false;
  return (
    DENY_VISIT_RE.test(text) ||
    DENY_VISIT_SHORT_RE.test(text) ||
    DENY_ACTION_RE.test(text) ||
    WHEN_VISIT_RE.test(text) ||
    ACCUSE_RE.test(text)
  );
}

function trimText(value, limit) {
  return Array.from(String(value || '').replace(/\s+/g, ' ').trim()).slice(0, limit).join('');
}

/** 把直播事件映射成留证动作；不认识的类型返回 null。 */
export function ledgerActionFromEvent(event) {
  if (!event) return null;
  const action = {
    member: 'enter',
    chat: 'chat',
    gift: 'gift',
    like: 'like',
    follow: 'follow',
    share: 'share',
  }[event.type];
  if (!action) return null;
  if (action === 'enter') {
    return { action, detail: trimText((event.member && event.member.actionDescription) || '进入了直播间', 40) };
  }
  if (action === 'chat') {
    const text = trimText(event.content, 80);
    return text ? { action, detail: text } : null;
  }
  if (action === 'gift') {
    const gift = event.gift || {};
    const name = trimText(gift.name || gift.giftName || event.giftName || '礼物', 20) || '礼物';
    const count = Math.max(1, Number(gift.count ?? event.count) || 1);
    return { action, detail: `${name}×${count}` };
  }
  if (action === 'like') {
    const count = Math.max(1, Number(event.like && event.like.count) || 1);
    return { action, detail: `点赞 ×${count}` };
  }
  if (action === 'share') return { action, detail: '分享了直播间' };
  return { action, detail: '关注了主播' };
}

/** 精确到秒的数据记录时间：MM-DD HH:mm:ss。 */
export function formatEvidenceStamp(ts) {
  const value = Number(ts);
  if (!Number.isFinite(value) || value <= 0) return '时间未知';
  const date = new Date(value);
  const pad = (input) => String(input).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 只保留真正的访问行为（排除 claim / misjudge / dispute 等审计记录）。 */
export function filterVisitLedger(ledger) {
  if (!ledger || typeof ledger !== 'object') {
    return { total: 0, firstSeen: 0, lastSeen: 0, counts: {}, entries: [] };
  }
  const entries = (Array.isArray(ledger.entries) ? ledger.entries : [])
    .filter((entry) => entry && VISIT_ACTIONS.includes(String(entry.action)))
    .map((entry) => ({
      ts: Number(entry.ts) || 0,
      action: String(entry.action),
      detail: String(entry.detail || ''),
      seq: Number(entry.seq) || 0,
    }));
  const counts = {};
  for (const entry of entries) counts[entry.action] = (counts[entry.action] || 0) + 1;
  return {
    // 台账里的 total 统计的是全量访问行为，entries 可能被 limit 截断
    total: Math.max(Number(ledger.total) || 0, entries.length),
    firstSeen: Number(ledger.firstSeen) || (entries.length ? entries[0].ts : 0),
    lastSeen: Number(ledger.lastSeen) || (entries.length ? entries[entries.length - 1].ts : 0),
    counts: ledger.counts && typeof ledger.counts === 'object' ? { ...ledger.counts } : counts,
    entries,
  };
}

function describeEntry(entry, options = {}) {
  const detail = String(entry.detail || '').trim();
  switch (String(entry.action)) {
    case 'enter':
      return '进入直播间';
    case 'chat':
      return options.redactChat
        ? '发言（内容已按安全规则脱敏）'
        : `发言「${Array.from(detail).slice(0, 30).join('')}」`;
    case 'gift':
      return `送礼 ${detail || '礼物'}`;
    case 'like':
      return detail || '点赞';
    case 'follow':
      return '关注主播';
    case 'share':
      return '分享了直播间';
    case 'song': {
      const [title, artist] = detail.split(' - ');
      return `点歌${title ? `《${title}》` : ''}${artist ? ` - ${artist}` : ''}`;
    }
    default:
      return `${ACTION_LABELS[String(entry.action)] || entry.action}${detail ? ` ${detail}` : ''}`;
  }
}

/** 公屏证据摘要：精确进入时间 + 互动动作统计 + 总条数 + 哈希链状态（≤100 字）。 */
export function formatEvidenceReply(ledger, nickname = '观众', options = {}) {
  const total = Number(ledger && ledger.total) || 0;
  if (total <= 0) return '';
  const name = trimText(nickname, 12) || '观众';
  const entries = Array.isArray(ledger.entries) ? ledger.entries : [];
  const enter = entries.find((entry) => entry && String(entry.action) === 'enter');
  const firstAt =
    Number(enter && enter.ts) || Number(ledger.firstSeen) || Number(entries[0] && entries[0].ts) || 0;
  const counts = ledger.counts && typeof ledger.counts === 'object' ? ledger.counts : {};
  const actions = [
    ['chat', '发言'],
    ['gift', '送礼'],
    ['like', '点赞'],
    ['follow', '关注'],
    ['share', '分享'],
    ['song', '点歌'],
  ]
    .filter(([key]) => Number(counts[key]) > 0)
    .map(([key, label]) => `${label}${Number(counts[key])}次`);
  const seq = Number(enter && enter.seq) || 0;
  const ref = seq ? `（记录#${seq}）` : '';
  const parts = [`进入直播间 ${formatEvidenceStamp(firstAt)}`];
  if (actions.length) parts.push(actions.join('、'));
  const chain = options.verified === false ? '哈希链异常，待人工复核' : '哈希链校验通过';
  const text = `${name}，留证台账${ref}：${parts.join('；')}；共${total}条，${chain}，以系统记录为准。`;
  return Array.from(text).slice(0, Math.max(40, Number(options.maxChars) || 100)).join('');
}

/** 完整时间线（写入运行记录 / 面板日志，逐条含编号、秒级时间和行为内容）。 */
export function formatEvidenceTimeline(ledger, nickname = '观众', options = {}) {
  const total = Number(ledger && ledger.total) || 0;
  if (total <= 0) return '';
  const name = trimText(nickname, 20) || '观众';
  const chain = options.verified === false ? '校验异常，需人工复核' : '校验通过';
  const entries = (Array.isArray(ledger.entries) ? ledger.entries : []).filter(
    (entry) => entry && VISIT_ACTIONS.includes(String(entry.action)),
  );
  const lines = [`留证链核查「${name}」共 ${total} 条行为记录，哈希链${chain}：`];
  for (const entry of entries) {
    lines.push(`#${Number(entry.seq) || 0} ${formatEvidenceStamp(entry.ts)} ${describeEntry(entry, options)}`);
  }
  return lines.join('\n');
}

/** 核查确无访问记录时的正式致歉。 */
export function formatApologyReply(nickname = '观众') {
  const name = trimText(nickname, 12) || '观众';
  return `${name}，非常抱歉，刚才我的记忆判断有误，系统留证台账中确实没有你的访问记录。已记录误判原因并修正检测规则，感谢你的指正。`;
}

/** 桥接不可达、无法调取台账时的中性回复。 */
export function formatUnavailableReply(nickname = '观众') {
  const name = trimText(nickname, 12) || '观众';
  return `${name}，抱歉，留证记录暂时查询不到，我先如实记录你的反馈，核实后再答复，不做主观判断。`;
}

/** 台账暂时没有记录、但本场仍有实时互动时的待核实回复（不能直接判为误判）。 */
export function formatPendingReply(nickname = '观众') {
  const name = trimText(nickname, 12) || '观众';
  return `${name}，留证台账暂未查到你的记录，但本场运行记录里有互动信息，我已记录待核实，暂不做判定。`;
}

/** 台账哈希链校验失败时的中性回复：证据不可信就不做判定。 */
export function formatChainBrokenReply(nickname = '观众') {
  const name = trimText(nickname, 12) || '观众';
  return `${name}，抱歉，留证数据校验异常，暂不能作为判定依据，我已转人工复核，核实后答复你，不做主观判断。`;
}
