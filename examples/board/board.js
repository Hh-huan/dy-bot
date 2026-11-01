const $ = (selector) => document.querySelector(selector);
const feed = $('#feed');
const queueList = $('#queue');
const params = new URLSearchParams(location.search);

const state = {
  online: 0,
  watch: 0,
  watchRaw: 0,
  watchBase: 0,
  likes: 0,
  likesRaw: 0,
  likesBase: 0,
  tokens: 0,
  tokenDate: '',
  // 今日新增关注：按上海日期跨天清零
  followToday: 0,
  followDate: '',
  lastGift: '',
  chat: 0,
  reply: 0,
  gift: 0,
  giftTypes: new Map(),
  giftUsers: new Map(),
  giftNames: new Map(),
  giftImages: new Map(),
  // 送礼头像飘屏：同屏最多 N 个（插件设置里可调，默认 10）
  maxBubbles: 10,
  // 在线用户池：最近在直播间出现过的人，供气泡队列定时补充免费气泡
  viewerPool: new Map(),
  lastSongKey: '',
  recentHost: [],
  maxFeed: 10,
  seenEvents: new Set(),
  giftResetApplied: 0,
  giftRepairs: new Set(),
  songSig: '',
  queueSig: '',
  eventSource: null,
  sseOpen: false,
  demo: false,
};

// 统计持久化：插件更新触发 board_reload 整页刷新后，弹幕/回复/礼物等
// 累计统计从 localStorage 恢复；seenEvents 一并恢复，避免重放事件重复计数
const STATS_KEY = 'board:stats:v1';
const GIFT_STATS_VERSION = 4;
// 连击去重：同一用户同一礼物只按累计最大值补差额，结束帧漏了也不丢统计
const giftCombos = GiftCombo.createComboTracker();

// 旧连击逻辑把「结束帧重复上一帧累计值」当成新一轮（×5 连击中 → ×5），
// 每段带中间帧的连击都多算了一份最终数量。逐条礼物事件没有全量留存，
// 这里按留证台账重算出的真实件数做一次性扣减（不清空历史），只扣多算的部分。
// 每条修正带 id，应用后写入 giftRepairs 存档，之后加载不会重复扣。
const GIFT_STATS_REPAIRS = [
  {
    id: 'combo-end-2026-10-31',
    giftTypes: { 大啤酒: 5, 小心心: 6 },
    users: [
      // 牛马：大啤酒 10 → 5
      { name: '牛马', count: 5, rice: 5 },
      // 天选♛：小心心 10 → 5
      { name: '天选♛', count: 5, rice: 5 },
      // 此生不灭夜：小心心 4 → 3
      { name: '此生不灭夜', count: 1, rice: 1 },
    ],
  },
];

/** 扣掉旧连击逻辑多算的份额：giftTypes 按礼物名扣，giftUsers 按昵称扣；每条只执行一次。 */
function applyGiftRepairs() {
  let changed = false;
  for (const fix of GIFT_STATS_REPAIRS) {
    if (!fix || !fix.id || state.giftRepairs.has(fix.id)) continue;
    for (const [name, amount] of Object.entries(fix.giftTypes || {})) {
      const current = Math.max(0, Number(state.giftTypes.get(name)) || 0);
      const next = Math.max(0, current - Math.max(0, Number(amount) || 0));
      if (next) state.giftTypes.set(name, next);
      else state.giftTypes.delete(name);
      if (next !== current) changed = true;
    }
    for (const target of fix.users || []) {
      // 同名观众可能有多个，只扣累计最多的那一个
      let bestKey = '';
      let bestCount = -1;
      for (const [key, person] of state.giftUsers) {
        if (!person || person.name !== target.name) continue;
        const count = Math.max(0, Number(person.count) || 0);
        if (count > bestCount) {
          bestCount = count;
          bestKey = key;
        }
      }
      if (!bestKey) continue;
      const person = state.giftUsers.get(bestKey);
      const count = Math.max(0, (Number(person.count) || 0) - Math.max(0, Number(target.count) || 0));
      const rice = Math.max(0, (Number(person.rice) || 0) - Math.max(0, Number(target.rice) || 0));
      if (!count) {
        state.giftUsers.delete(bestKey);
      } else {
        person.count = count;
        person.rice = Math.min(rice, count);
      }
      changed = true;
    }
    state.giftRepairs.add(fix.id);
    changed = true;
  }
  return changed;
}

function saveStats() {
  if (state.demo) return;
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify({
      chat: state.chat,
      reply: state.reply,
      giftTypes: [...state.giftTypes],
      giftUsers: [...state.giftUsers],
      giftImages: [...state.giftImages],
      maxBubbles: state.maxBubbles,
      giftStatsVersion: GIFT_STATS_VERSION,
      lastGift: state.lastGift,
      watch: state.watch,
      watchRaw: state.watchRaw,
      watchBase: state.watchBase,
      likes: state.likes,
      likesRaw: state.likesRaw,
      likesBase: state.likesBase,
      tokens: state.tokens,
      tokenDate: state.tokenDate,
      followToday: state.followToday,
      followDate: state.followDate,
      giftResetApplied: state.giftResetApplied,
      giftRepairs: [...state.giftRepairs],
      seen: [...state.seenEvents].slice(-300),
      giftCombos: giftCombos.snapshot(),
    }));
  } catch {
    /* 存储不可用时忽略 */
  }
}

function loadStats() {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return;
    state.chat = Math.max(0, Number(data.chat) || 0);
    state.reply = Math.max(0, Number(data.reply) || 0);
    if (Number(data.giftStatsVersion) < 2) {
      // 旧版本把连击首帧和结束帧都算了一次；历史汇总无法还原逐条事件，
      // 按双倍近似修正。v2 起已按结束帧统计，不能再次折半。
      const corrected = new Map();
      if (Array.isArray(data.giftTypes)) {
        for (const [name, count] of data.giftTypes) {
          const n = Math.max(1, Math.round((Number(count) || 0) / 2));
          if (name) corrected.set(name, n);
        }
      }
      state.giftTypes = corrected;
      state.lastGift = String(data.lastGift || '');
    } else {
      if (Array.isArray(data.giftTypes)) {
        state.giftTypes = new Map(data.giftTypes.filter(([name, count]) => name && count > 0));
      }
      state.lastGift = String(data.lastGift || '');
    }
    if (Array.isArray(data.giftUsers)) {
      for (const item of data.giftUsers) {
        if (!Array.isArray(item) || item.length < 2) continue;
        const key = String(item[0] || '');
        const value = item[1];
        if (!key || !value) continue;
        const count = Math.max(0, Number(value.count) || 0);
        if (!count) continue;
        state.giftUsers.set(key, {
          name: String(value.name || '观众'),
          avatar: String(value.avatar || ''),
          count,
          // 白饭累计：气泡流准入（累计白饭达到阈值的前 N 位）唯一依据；
          // 旧版本统计只有 count 没有 rice，按 count 回填，避免老观众被挡在气泡流外
          rice: Math.max(0, Number(value.rice) || count),
        });
      }
    }
    // 读取已应用过的礼物修正记录，再执行一次性扣减；saveStats() 会把新记录写回
    if (Array.isArray(data.giftRepairs)) {
      for (const id of data.giftRepairs) state.giftRepairs.add(String(id));
    }
    applyGiftRepairs();
    if (data.maxBubbles != null) {
      state.maxBubbles = Math.round(Math.min(30, Math.max(0, Number(data.maxBubbles) || 0)));
    }
    // 累计观看/点赞支持“清空本场统计”：保存原始累计值和清零基线，
    // 展示值 = 原始值 - 基线，清空后下一帧 status 不会立刻把数字顶回去
    state.watchRaw = Math.max(state.watchRaw, Number(data.watch) || 0, Number(data.watchRaw) || 0);
    state.watchBase = Math.max(0, Number(data.watchBase) || 0);
    state.watch = Math.max(0, state.watchRaw - state.watchBase);
    state.likesRaw = Math.max(state.likesRaw, Number(data.likes) || 0, Number(data.likesRaw) || 0);
    state.likesBase = Math.max(0, Number(data.likesBase) || 0);
    state.likes = Math.max(0, state.likesRaw - state.likesBase);
    state.tokenDate = String(data.tokenDate || '');
    state.giftResetApplied = Number(data.giftResetApplied) || 0;
    // 跨天清零由 applyStatusData 的 tokenDate 校验处理，这里直接恢复
    state.tokens = Math.max(state.tokens, Number(data.tokens) || 0);
    state.followToday = Math.max(0, Number(data.followToday) || 0);
    state.followDate = String(data.followDate || '');
    // 存档不是今天的关注统计时从零开始，避免跨天累加
    if (state.followDate !== shanghaiDateKey()) {
      state.followDate = shanghaiDateKey();
      state.followToday = 0;
    }
    if (Array.isArray(data.seen)) {
      for (const id of data.seen) state.seenEvents.add(String(id));
    }
    if (Array.isArray(data.giftImages)) {
      for (const [name, url] of data.giftImages) {
        if (name && /^https?:\/\//i.test(String(url || ''))) state.giftImages.set(String(name), String(url));
      }
    }
    if (Array.isArray(data.giftCombos)) giftCombos.restore(data.giftCombos);
    $('#statChat').textContent = String(state.chat);
    $('#statReply').textContent = String(state.reply);
    renderGifts();
    updateMetrics();
    saveStats();
  } catch {
    /* 数据损坏时忽略，从零开始 */
  }
}

if (params.get('transparent') === '1') document.body.classList.add('transparent');

// 清空礼物统计（幂等）：SSE 直达与 2 秒兜底轮询都会触发，
// 用 giftResetApplied 记录已应用的时间戳，避免同一指令重复执行或旧指令重放
function applyGiftReset(at) {
  const stamp = Number(at) || Date.now();
  if (stamp <= state.giftResetApplied) return;
  state.giftResetApplied = stamp;
  state.giftTypes.clear();
  state.giftUsers.clear();
  state.lastGift = '';
  state.gift = 0;
  giftCombos.clear();
  // 礼物统计清零后，付费气泡同步清空，免费气泡由定时任务重新补充
  if (bubbleQueue) bubbleQueue.clear('gift-reset').catch(() => {});
  $('#giftTotal').textContent = '0';
  renderGifts();
  updateMetrics();
  saveStats();
}
if (params.get('layout') === 'vertical' || params.get('vertical') === '1') {
  document.body.classList.add('layout-vertical');
  state.maxFeed = 4;
}
if (params.get('demo') === '1') state.demo = true;

const petSlot = ['center', 'left', 'right', 'none'].includes(params.get('pet'))
  ? params.get('pet')
  : 'center';
document.body.classList.add(`pet-${petSlot}`);
document.body.dataset.petSlot = petSlot;
if (params.get('petDebug') === '1') document.body.classList.add('pet-debug');

const roomTitle = params.get('title');
if (roomTitle) $('#roomTitle').textContent = roomTitle;

function timeLabel(ts = Date.now()) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function initial(name) {
  return String(name || '观').trim().slice(0, 1) || '观';
}

function makeAvatar(name, avatarUrl) {
  const el = document.createElement('div');
  el.className = 'avatar';
  if (avatarUrl) {
    const img = document.createElement('img');
    img.src = avatarUrl;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => {
      img.remove();
      el.textContent = initial(name);
    });
    el.append(img);
  } else {
    el.textContent = initial(name);
  }
  return el;
}

function addFeed({ type = 'chat', name = '观众', text = '', avatar = '', ts = Date.now(), badge = '', eventId = '' }) {
  const item = document.createElement('article');
  item.className = `feed-item ${type}`;
  item.dataset.eventId = eventId ? String(eventId) : '';

  item.append(makeAvatar(name, avatar));

  const body = document.createElement('div');
  body.className = 'feed-body';

  const meta = document.createElement('div');
  meta.className = 'feed-meta';

  const nameEl = document.createElement('span');
  nameEl.className = 'feed-name';
  nameEl.textContent = name;
  meta.append(nameEl);

  if (badge) {
    const badgeEl = document.createElement('span');
    badgeEl.className = 'feed-badge';
    badgeEl.textContent = badge;
    meta.append(badgeEl);
  }

  const time = document.createElement('span');
  time.className = 'feed-time';
  time.textContent = timeLabel(ts);
  meta.append(time);

  const textEl = document.createElement('div');
  textEl.className = 'feed-text';
  textEl.textContent = text;

  body.append(meta, textEl);
  item.append(body);
  feed.append(item);

  while (feed.children.length > state.maxFeed) feed.firstElementChild.remove();
  feed.scrollTop = feed.scrollHeight;
}

function addHost(text, provider = '') {
  const clean = String(text || '').trim();
  if (!clean) return;
  if (state.recentHost.includes(clean)) return;
  state.recentHost.push(clean);
  while (state.recentHost.length > 20) state.recentHost.shift();
  state.reply += 1;
  $('#statReply').textContent = String(state.reply);
  saveStats();
  addFeed({ type: 'host', name: '主播', text: clean, badge: provider || 'AI', ts: Date.now() });
}

function markReply(eventId, status) {
  const id = String(eventId || '');
  if (!id) return;
  for (const item of feed.children) {
    if (item.dataset.eventId !== id) continue;
    item.classList.remove('replying', 'replied', 'failed');
    let badge = item.querySelector('.reply-state');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'reply-state';
      const meta = item.querySelector('.feed-meta');
      if (!meta) continue;
      meta.append(badge);
    }
    if (status) {
      item.classList.add(status);
      badge.className = `reply-state ${status}`;
      badge.textContent = status === 'replying' ? '正在回复…' : status === 'replied' ? '已回复' : '回复失败';
    } else {
      badge.remove();
    }
    if (status === 'replying') item.scrollIntoView({ block: 'nearest' });
  }
}

function updateOnline(value) {
  const n = Math.max(0, Number(value) || 0);
  state.online = n;
  $('#online').textContent = `${n.toLocaleString('zh-CN')} 人在线`;
  $('#statOnline').textContent = n.toLocaleString('zh-CN');
}

function compactNumber(value) {
  const n = Math.max(0, Number(value) || 0);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}m`;
  if (n >= 10_000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return n.toLocaleString('zh-CN');
}

function updateMetrics() {
  $('#statWatch').textContent = compactNumber(state.watch);
  $('#statLike').textContent = compactNumber(state.likes);
  $('#statFollow').textContent = String(state.followToday);
  $('#statLastGift').textContent = state.lastGift || '—';
  syncRiceMarquee();
}

/* ---------- 今日消耗白饭：沿屏幕四周环绕，顶部会被气泡撞落；掉落后按文字朝向换向 ---------- */
const RICE_MARQUEE_PAD = 26; // 距屏幕边缘的边距（px），容纳标题级字号的一半字高
const RICE_MARQUEE_SPEED = 170; // 行进速度（px/s）
const RICE_MARQUEE_RADIUS = 26; // 四角圆角半径：拐角平滑转向
const RICE_MARQUEE_HIT_PAD = 6; // 碰撞判定外扩（px），贴住文字光晕就算命中
const RICE_MARQUEE_GRAVITY = 900; // 被撞落后垂直下落的加速度（px/s²）

// 整段文字按字符拆开、同一条路径行进：拐角处每个字跟着弧线转向，
// 不会像整段刚体那样在拐角处戳出屏幕；只有所有字都在顶部直边上才参与碰撞。
const marqueeState = {
  started: false,
  mode: 'border', // border：绕边框行进；falling：被撞落后垂直下落
  dir: 1, // 1：逆时针（顶部右→左）；-1：顺时针（顶部左→右）；撞落后按文字朝向换向
  chars: [],
  label: '',
  path: '',
  geo: null,
  progress: 0,
  fall: null,
};

// 上海日期键，用于关注统计跨天清零
function shanghaiDateKey(ts = Date.now()) {
  return new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// 统计单位为 1：今日 tokens 直接等量当作白饭碗数，原始数字不缩写
function riceMarqueeLabel() {
  return `今日消耗白饭${Math.max(0, Math.round(Number(state.tokens) || 0))} 碗`;
}

function marqueeGeometry() {
  const p = RICE_MARQUEE_PAD;
  const right = Math.max(p + 1, window.innerWidth - p);
  const bottom = Math.max(p + 1, window.innerHeight - p);
  const r = Math.min(RICE_MARQUEE_RADIUS, (right - p) / 2, (bottom - p) / 2);
  const a = Math.max(0, right - p - 2 * r); // 顶部/底部直边长度
  const c = Math.max(0, bottom - p - 2 * r); // 左右直边长度
  const arc = (Math.PI * r) / 2; // 单个圆角弧长
  return { p, right, bottom, r, a, c, arc, length: 2 * a + 2 * c + 4 * arc };
}

// 圆角矩形路径：上（右→左）→左→下（左→右）→右（下→上），逆时针；
// 拐角用二次曲线平滑转向
function riceMarqueePath(geo) {
  const { p, right, bottom, r } = geo;
  return (
    `path("M ${right - r} ${p} L ${p + r} ${p} Q ${p} ${p} ${p} ${p + r} ` +
    `L ${p} ${bottom - r} Q ${p} ${bottom} ${p + r} ${bottom} ` +
    `L ${right - r} ${bottom} Q ${right} ${bottom} ${right} ${bottom - r} ` +
    `L ${right} ${p + r} Q ${right} ${p} ${right - r} ${p} Z")`
  );
}

// 建立/重建整段文字：按字符拆开，每个字独立沿同一路径行进。
// 拆字后跨拐角时每个字跟着弧线转向，整段文字始终贴住边框、不会越出屏幕。
function layoutRiceMarquee() {
  const box = $('#riceMarquee');
  if (!box) return;
  const geo = marqueeGeometry();
  const path = riceMarqueePath(geo);
  const label = riceMarqueeLabel();
  if (
    marqueeState.started &&
    marqueeState.label === label &&
    marqueeState.geo &&
    marqueeState.geo.right === geo.right &&
    marqueeState.geo.bottom === geo.bottom
  ) {
    return;
  }
  // 首次布置时把整段文字摆到顶部直边靠右的位置，向左出发；
  // 之后单位 / 窗口变化时保留当前进度，不跳位
  const keepProgress = marqueeState.started ? marqueeState.progress : -1;
  box.replaceChildren();
  const chars = [];
  let advance = 0;
  for (const char of Array.from(label)) {
    const el = document.createElement('span');
    el.textContent = char;
    el.style.offsetPath = path;
    el.style.offsetDistance = '0%';
    box.append(el);
    const w = Math.max(1, el.offsetWidth);
    const h = Math.max(1, el.offsetHeight);
    chars.push({ el, w, h, advance, d: 0, x: 0, top: 0 });
    advance += w;
  }
  marqueeState.started = true;
  marqueeState.mode = 'border';
  marqueeState.fall = null;
  marqueeState.chars = chars;
  marqueeState.label = label;
  marqueeState.geo = geo;
  marqueeState.path = path;
  marqueeState.progress = keepProgress >= 0 ? keepProgress % 1 : Math.min(geo.a, advance) / geo.length;
  positionRiceMarquee();
  console.info('[board] 白饭跑马灯已布置', {
    chars: chars.length,
    length: Math.round(geo.length),
    progress: Math.round(marqueeState.progress * 100),
  });
}

// 白饭碗数 / 窗口尺寸变化时刷新；下落过程中不打断物理，落到底部再刷新
function syncRiceMarquee() {
  if (marqueeState.mode === 'falling') return;
  layoutRiceMarquee();
}

// 按“整圈进度 + 每个字的累计宽度”把每个字摆到边框对应位置（anchor 是字中心）。
// 逆时针时路径距离越大越靠前，字头（第 0 个字）取最大距离、后面的字往回排；
// 顺时针时反过来，字头取最小距离、后面的字沿路径继续往前排。
function positionRiceMarquee() {
  const { chars, geo, progress, dir } = marqueeState;
  if (!geo || !geo.length) return;
  const base = progress * geo.length;
  const sign = dir < 0 ? 1 : -1;
  for (const ch of chars) {
    const raw = base + sign * ch.advance;
    ch.d = ((raw % geo.length) + geo.length) % geo.length;
    ch.el.style.offsetDistance = `${((ch.d / geo.length) * 100).toFixed(3)}%`;
  }
}

// 每帧推进：border 模式沿边框匀速绕行（逆时针/顺时针由 dir 决定）；falling 模式只做垂直下落
function updateRiceMarquee(dt) {
  if (!marqueeState.started) return;
  if (marqueeState.mode === 'falling') {
    updateRiceMarqueeFall(dt);
    return;
  }
  const geo = marqueeState.geo;
  if (!geo || !geo.length) return;
  const dir = marqueeState.dir < 0 ? -1 : 1;
  const next = marqueeState.progress + (dir * RICE_MARQUEE_SPEED * dt) / geo.length;
  marqueeState.progress = ((next % 1) + 1) % 1;
  positionRiceMarquee();
}

// 被撞落后沿重力方向垂直下落：整段文字作为刚体一起落
function updateRiceMarqueeFall(dt) {
  const fall = marqueeState.fall;
  const geo = marqueeState.geo;
  if (!fall || !geo) return;
  fall.vy = Math.min(1800, fall.vy + RICE_MARQUEE_GRAVITY * dt);
  fall.offset += fall.vy * dt;
  // 从顶部边框落到下边框的距离；文字中心落到下边框即算触底
  const drop = window.innerHeight - RICE_MARQUEE_PAD - geo.p;
  const offset = Math.min(drop, fall.offset);
  for (const ch of marqueeState.chars) {
    ch.el.style.transform = `translate3d(${ch.x.toFixed(2)}px, ${(ch.top + offset).toFixed(2)}px, 0)`;
  }
  if (fall.offset >= drop) resumeRiceMarquee();
}

// 落到底部后立即恢复环绕：文字保持掉落时的左右排版，按「碗 → 今」的方向继续行进。
// 从顶部掉下来时文字是正立的（若碗在右、今在左，碗→今 对下边框来说是顺时针），
// 恢复后就顺时针（下边框向左、左边缘向上）走，落底瞬间不会横向翻转。
function resumeRiceMarquee() {
  const geo = marqueeState.geo;
  const chars = marqueeState.chars;
  if (!geo || !chars.length) return;
  const { p, right, r, a, c, arc } = geo;
  const startBottom = a + arc + c + arc;
  const first = chars[0];
  // 字头（第 0 个字）的落点就是下边框上的起点，其余字按原排版跟在它身后
  const headX = Math.min(right - r, Math.max(p + r, first.x + first.w / 2));
  const headD = startBottom + (headX - (p + r));
  // 掉落后换向：碗→今 指向哪边就朝哪边继续行进，文字排版保持不变
  marqueeState.dir = marqueeState.dir > 0 ? -1 : 1;
  marqueeState.mode = 'border';
  marqueeState.fall = null;
  marqueeState.progress = (((headD / geo.length) % 1) + 1) % 1;
  for (const ch of chars) {
    ch.el.style.transform = '';
    ch.el.style.offsetPath = marqueeState.path;
  }
  // 下落约 1 秒，白饭碗数可能已经变了：落底后按新数字重排再继续绕行
  if (marqueeState.label !== riceMarqueeLabel()) layoutRiceMarquee();
  else positionRiceMarquee();
  // 下落期间如果窗口尺寸变了，落底后按新路径重排，避免继续走旧的边框
  syncRiceMarquee();
  console.info('[board] 白饭跑马灯落到底部，按文字朝向继续行进', {
    dir: marqueeState.dir > 0 ? '逆时针' : '顺时针',
    headX: Math.round(headX),
  });
}

// 整段文字完全落在顶部直边上才算“到顶”：跨圆角/侧边时都不参与碰撞
function marqueeAllOnTop() {
  const geo = marqueeState.geo;
  if (!geo || !marqueeState.chars.length) return null;
  for (const ch of marqueeState.chars) {
    if (ch.d + ch.w / 2 > geo.a) return null; // 字头左缘越过顶部左端，已进入左上圆角
    if (ch.d - ch.w / 2 < 0) return null; // 字尾右缘还没完全离开右上圆角
  }
  return geo;
}

// 顶部文字矩形（顶部直边上没有旋转）：文字中心在路径上，左边缘要减半个字宽
function marqueeTopRects(geo) {
  return marqueeState.chars.map((ch) => ({
    left: geo.right - geo.r - ch.d - ch.w / 2 - RICE_MARQUEE_HIT_PAD,
    top: geo.p - ch.h / 2 - RICE_MARQUEE_HIT_PAD,
    width: ch.w + RICE_MARQUEE_HIT_PAD * 2,
    height: ch.h + RICE_MARQUEE_HIT_PAD * 2,
  }));
}

// 被气泡撞落：文字在当前位置冻结，整段垂直下坠；文字保持顶部时的正立朝向，
// 不跟随切线旋转，避免掉落瞬间出现 180° 垂直翻转。气泡沿法线正常反弹
function knockRiceMarquee(bubble, rect) {
  const geo = marqueeState.geo;
  marqueeState.mode = 'falling';
  marqueeState.fall = { vy: 160, offset: 0 };
  for (const ch of marqueeState.chars) {
    // offset-anchor 是文字中心：换算成 left 时减半个字宽
    ch.x = geo.right - geo.r - ch.d - ch.w / 2;
    ch.top = geo.p - ch.h / 2;
    ch.el.style.offsetPath = 'none';
    ch.el.style.offsetDistance = '0%';
    // 显式保持正立：offset-path 置空后不能再让 offset-rotate 改变字的朝向
    ch.el.style.offsetRotate = '0deg';
    ch.el.style.transform = `translate3d(${ch.x.toFixed(2)}px, ${ch.top.toFixed(2)}px, 0)`;
  }
  // 圆与矩形：先推出重叠，再沿法线反射速度（入射角等于反射角）
  const cx = Math.max(rect.left, Math.min(bubble.x, rect.left + rect.width));
  const cy = Math.max(rect.top, Math.min(bubble.y, rect.top + rect.height));
  let nx = bubble.x - cx;
  let ny = bubble.y - cy;
  let dist = Math.hypot(nx, ny);
  if (dist < 0.01) {
    nx = 0;
    ny = 1;
    dist = 1;
  }
  nx /= dist;
  ny /= dist;
  const push = Math.max(0, bubble.r - dist) + 3;
  bubble.x += nx * push;
  bubble.y += ny * push;
  const vn = bubble.vx * nx + bubble.vy * ny;
  if (vn < 0) {
    bubble.vx -= 2 * vn * nx;
    bubble.vy -= 2 * vn * ny;
  }
  // 文字在气泡上方：碰撞后气泡向下弹开，确保反弹效果可见
  bubble.vy = Math.max(bubble.vy, 80);
  applyBubbleTransform(bubble);
  applyBubbleRotation(bubble);
  console.info('[board] 白饭跑马灯被顶部气泡撞落', {
    text: marqueeState.label,
    bubble: bubble.key,
  });
}

// 与气泡流逐个判定：圆与文字矩形相交即视为碰撞
function checkRiceMarqueeCollisions() {
  if (marqueeState.mode !== 'border' || !bubbleState.items.size) return;
  const geo = marqueeAllOnTop();
  if (!geo) return;
  const rects = marqueeTopRects(geo);
  for (const bubble of bubbleState.items.values()) {
    if (bubble.script) continue;
    for (const rect of rects) {
      const cx = Math.max(rect.left, Math.min(bubble.x, rect.left + rect.width));
      const cy = Math.max(rect.top, Math.min(bubble.y, rect.top + rect.height));
      const dx = bubble.x - cx;
      const dy = bubble.y - cy;
      if (dx * dx + dy * dy > bubble.r * bubble.r) continue;
      knockRiceMarquee(bubble, rect);
      return;
    }
  }
}

// 今日关注 +1（按上海日期跨天归零）
function bumpFollowToday(ts = Date.now()) {
  const day = shanghaiDateKey(ts);
  if (day !== state.followDate) {
    state.followDate = day;
    state.followToday = 0;
  }
  state.followToday += 1;
  $('#statFollow').textContent = String(state.followToday);
  saveStats();
}

// 清空本场统计：只重置累计数据，在线人数和今日 Tokens 保持实时/按日口径
function clearBoardStats() {
  state.watchBase = state.watchRaw;
  state.likesBase = state.likesRaw;
  state.watch = 0;
  state.likes = 0;
  state.chat = 0;
  state.reply = 0;
  state.lastGift = '';
  $('#statChat').textContent = '0';
  $('#statReply').textContent = '0';
  updateMetrics();
  saveStats();
}

function applyStatusData(data) {
  if (!data) return;
  if (data.online != null) updateOnline(data.online);
  // 插件设置里调整的「送礼头像飘屏数量」由 status 下发，0 表示关闭
  if (data.avatarBubbles != null) {
    const next = Math.round(Math.min(30, Math.max(0, Number(data.avatarBubbles) || 0)));
    if (next !== state.maxBubbles) {
      state.maxBubbles = next;
      syncBubbles();
    }
  }
  if (data.cumulative != null) {
    state.watchRaw = Math.max(state.watchRaw, Number(data.cumulative) || 0);
    state.watch = Math.max(0, state.watchRaw - state.watchBase);
  }
  if (data.likes != null) {
    state.likesRaw = Math.max(state.likesRaw, Number(data.likes) || 0);
    state.likes = Math.max(0, state.likesRaw - state.likesBase);
  }
  if (data.tokenDate && data.tokenDate !== state.tokenDate) {
    state.tokenDate = data.tokenDate;
    state.tokens = 0;
  }
  if (data.tokens != null) state.tokens = Math.max(0, Number(data.tokens) || 0);
  updateMetrics();
  saveStats();
}

function resolveGiftName(rawName, rawId) {
  const name = String(rawName || '').trim();
  const idMatch = name.match(/^礼物#(\d+)$/);
  const id = String(rawId || (idMatch ? idMatch[1] : '')).trim();
  if (name && name !== '礼物' && !idMatch) return name;
  if (id && state.giftNames.has(id)) return state.giftNames.get(id);
  if (id) return `礼物#${id}`;
  return name || '礼物';
}

async function loadGiftNames() {
  try {
    const response = await fetch('/board/gifts.json', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    state.giftNames = new Map(
      Object.entries(data || {}).map(([id, name]) => [String(id), String(name)]),
    );
    normalizeGiftHistory();
  } catch {
    /* 礼物名表加载失败时保留 礼物#ID */
  }
}

function normalizeGiftHistory() {
  const merged = new Map();
  for (const [name, count] of state.giftTypes) {
    const normalized = resolveGiftName(name, '');
    merged.set(normalized, (merged.get(normalized) || 0) + (Number(count) || 0));
  }
  state.giftTypes = merged;
  const lastMatch = String(state.lastGift || '').match(/^礼物#(\d+)(.*)$/);
  if (lastMatch) {
    const resolved = resolveGiftName(`礼物#${lastMatch[1]}`, lastMatch[1]);
    state.lastGift = `${resolved}${lastMatch[2]}`;
  }
  renderGifts();
  updateMetrics();
  saveStats();
}

function emojiForGift(name) {
  if (/心/.test(name)) return '💗';
  if (/玫瑰|花/.test(name)) return '🌹';
  if (/入团/.test(name)) return '🎫';
  if (/糖|棒棒糖/.test(name)) return '🍭';
  if (/嘉年华/.test(name)) return '🎡';
  if (/火箭/.test(name)) return '🚀';
  if (/跑车/.test(name)) return '🏎️';
  if (/抖音1号|一号/.test(name)) return '🏆';
  return '🎁';
}

function giftIcon(name) {
  const image = state.giftImages.get(name);
  if (image) return { image, alt: name, text: emojiForGift(name) };
  if (String(name).includes('白饭')) return { image: '/board/rice.png', alt: '白饭', text: '🍚' };
  return { text: emojiForGift(name) };
}

function createGiftStat(key, label) {
  const stat = document.createElement('span');
  stat.className = 'gift-stat';
  stat.dataset.statKey = key;
  const iconWrap = document.createElement('span');
  iconWrap.className = 'gift-stat-icon';
  const labelEl = document.createElement('span');
  labelEl.className = 'gift-stat-name';
  labelEl.textContent = label;
  const num = document.createElement('strong');
  num.className = 'gift-stat-count';
  stat.append(iconWrap, labelEl, num);
  return stat;
}

/** 只在图片/图标变化时重绘图标，避免连击更新时图片反复重载闪烁 */
function paintGiftIcon(iconWrap, name) {
  const icon = giftIcon(name);
  const signature = icon.image ? `img:${icon.image}` : `text:${icon.text}`;
  if (iconWrap.dataset.icon === signature) return;
  iconWrap.dataset.icon = signature;
  iconWrap.textContent = '';
  if (icon.image) {
    const img = document.createElement('img');
    img.src = icon.image;
    img.alt = icon.alt || name;
    // 抖音图片地址失效时退回本地图标，避免出现空白框
    img.addEventListener('error', () => {
      iconWrap.dataset.icon = `text:${icon.text || '🎁'}`;
      iconWrap.textContent = icon.text || '🎁';
    }, { once: true });
    iconWrap.append(img);
  } else {
    iconWrap.textContent = icon.text;
  }
}

/** 礼物明细：按礼物名称汇总（原有的「收到礼物」统计） */
function giftEntries() {
  return [...state.giftTypes.entries()]
    .filter(([name, count]) => name && count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ key: `gift:${name}`, label: name, count }));
}

/** 送礼人员榜：按送礼数量排序取前 10，独立展示在另一个框里 */
function giftersEntries() {
  return [...state.giftUsers.entries()]
    .filter(([key, item]) => key && item && item.name && item.count > 0)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10)
    .map(([key, item]) => ({
      key,
      name: item.name,
      avatar: item.avatar,
      count: item.count,
    }));
}

function createGifter(key) {
  const row = document.createElement('span');
  row.className = 'gifter';
  row.dataset.statKey = key;
  const rank = document.createElement('em');
  rank.className = 'gifter-rank';
  const avatar = document.createElement('span');
  avatar.className = 'gifter-avatar';
  const name = document.createElement('span');
  name.className = 'gifter-name';
  const count = document.createElement('strong');
  count.className = 'gifter-count';
  row.append(rank, avatar, name, count);
  return row;
}

/** 头像加载失败或没有头像时回退为昵称首字，避免空白/破图 */
function paintAvatarIcon(iconWrap, avatar, name) {
  const src = String(avatar || '');
  const signature = src ? `img:${src}` : `char:${initial(name)}`;
  if (iconWrap.dataset.icon === signature) return;
  iconWrap.dataset.icon = signature;
  iconWrap.textContent = '';
  if (!src) {
    iconWrap.textContent = initial(name);
    return;
  }
  const img = document.createElement('img');
  img.src = src;
  img.alt = name;
  img.referrerPolicy = 'no-referrer';
  img.addEventListener('error', () => {
    iconWrap.dataset.icon = `char:${initial(name)}`;
    iconWrap.textContent = initial(name);
  }, { once: true });
  iconWrap.append(img);
}

function renderGifters() {
  const list = $('#giftersList');
  if (!list) return;
  const entries = giftersEntries();
  const countEl = $('#giftersCount');
  if (countEl) countEl.textContent = `${entries.length} 人`;

  const existing = new Map();
  for (const node of list.querySelectorAll('.gifter')) existing.set(node.dataset.statKey, node);
  const previous = existing.size;
  const empty = list.querySelector('.gifters-empty');
  if (!entries.length) {
    for (const node of existing.values()) node.remove();
    if (empty) {
      empty.textContent = '还没有人送礼物';
    } else {
      const hint = document.createElement('span');
      hint.className = 'gifters-empty';
      hint.textContent = '还没有人送礼物';
      list.append(hint);
    }
    return;
  }
  if (empty) empty.remove();

  entries.forEach((item, index) => {
    const row = existing.get(item.key) || createGifter(item.key);
    existing.delete(item.key);
    const rank = row.querySelector('.gifter-rank');
    const rankText = String(index + 1);
    if (rank.textContent !== rankText) rank.textContent = rankText;
    rank.classList.toggle('hot', index < 3);
    paintAvatarIcon(row.querySelector('.gifter-avatar'), item.avatar, item.name);
    const nameEl = row.querySelector('.gifter-name');
    if (nameEl.textContent !== item.name) nameEl.textContent = item.name;
    const num = row.querySelector('.gifter-count');
    const text = item.count.toLocaleString('zh-CN');
    if (num.textContent !== text) num.textContent = text;
    // 按数量排序重新插入，节点复用不闪
    list.append(row);
  });
  for (const node of existing.values()) node.remove();

  // 新进榜用户滚到最右，首次载入不动，避免刷新后停在最右端
  if (previous > 0 && entries.length > previous && list.scrollWidth > list.clientWidth + 2) {
    list.scrollLeft = list.scrollWidth;
  }
}

function renderGifts() {
  const list = $('#giftList');
  const previousTypes = list.querySelectorAll('.gift-stat').length;
  const entries = giftEntries();
  const total = [...state.giftTypes.values()].reduce((sum, count) => sum + count, 0);
  state.gift = total;
  $('#giftTotal').textContent = total.toLocaleString('zh-CN');

  const existing = new Map();
  for (const node of list.querySelectorAll('.gift-stat')) {
    existing.set(node.dataset.statKey, node);
  }
  const empty = list.querySelector('.gift-empty');
  if (!entries.length) {
    for (const node of existing.values()) node.remove();
    if (!empty) {
      const hint = document.createElement('span');
      hint.className = 'gift-empty';
      hint.textContent = '还没有收到礼物';
      list.append(hint);
    } else {
      empty.textContent = '还没有收到礼物';
    }
    renderGifters();
    syncBubbles();
    return;
  }
  if (empty) empty.remove();

  for (const item of entries) {
    const stat = existing.get(item.key) || createGiftStat(item.key, item.label);
    existing.delete(item.key);
    paintGiftIcon(stat.querySelector('.gift-stat-icon'), item.label);
    const nameEl = stat.querySelector('.gift-stat-name');
    if (nameEl.textContent !== item.label) nameEl.textContent = item.label;
    const num = stat.querySelector('.gift-stat-count');
    const text = item.count.toLocaleString('zh-CN');
    if (num.textContent !== text) num.textContent = text;
    // 按数量排序重新插入，节点复用不闪
    list.append(stat);
  }
  for (const node of existing.values()) node.remove();

  // 新礼物类型按数量排在末尾，滚到最右让观众第一时间看到；
  // 首次载入（previousTypes 为 0）不要跳，避免刷新后停在最右端
  if (previousTypes > 0 && entries.length > previousTypes && list.scrollWidth > list.clientWidth + 2) {
    list.scrollLeft = list.scrollWidth;
  }
  // 礼物明细、送礼人员榜、头像飘屏共用一次更新
  renderGifters();
  syncBubbles();
}

/* ---------- 送礼头像飘屏 ----------
 * 气泡流准入：累计赠送白饭达到阈值的前 N 位用户（插件设置可调，默认 10）；
 * 气泡从画布中心随机方向匀速直线漂浮，碰到上下左右边界按反射规则反弹，永不停歇；
 * 气泡带随机自转速度，气泡之间按等质量弹性碰撞规则互相弹开。
 */
const bubbleState = {
  items: new Map(), // userKey -> bubble
  lastTs: performance.now(),
  boostAt: 0, // 下一次随机加速的时间点
};

// 气泡下方用户名标签预留的高度（px），底部边界反弹时留出来避免被裁切
const NAME_RESERVE = 26;

// 每 10 秒随机挑一位在场观众的气泡，把速度平滑拉到当前的 10 倍（有最高限速）
const BOOST_INTERVAL_MS = 10000;
const BOOST_FACTOR = 10;
const BOOST_MAX_SPEED = 1200; // px/s
const BOOST_RAMP_MS = 1200; // 加速曲线时长，避免速度瞬间跳变

function boostRandomBubble(now) {
  if (!bubbleState.boostAt) bubbleState.boostAt = now + BOOST_INTERVAL_MS;
  if (now < bubbleState.boostAt) return;
  bubbleState.boostAt = now + BOOST_INTERVAL_MS;
  // 拖拽中/甩飞中的气泡由用户或脚本控制，不参与随机加速
  const pool = [...bubbleState.items.values()].filter((bubble) => !bubble.script && !bubble.drag);
  if (!pool.length) return;
  const target = pool[Math.floor(Math.random() * pool.length)];
  const speed = Math.hypot(target.vx, target.vy);
  const want = Math.min(speed * BOOST_FACTOR, BOOST_MAX_SPEED);
  if (want <= speed + 0.5) return;
  if (speed > 0.5) {
    target.boost = { from: speed, to: want, startedAt: now, duration: BOOST_RAMP_MS };
  } else {
    // 几乎静止的气泡：先给随机方向，再按曲线拉起速度
    const angle = Math.random() * Math.PI * 2;
    target.vx = Math.cos(angle);
    target.vy = Math.sin(angle);
    target.boost = { from: 1, to: want, startedAt: now, duration: BOOST_RAMP_MS };
  }
}

// 按 smoothstep 曲线把速度平滑拉到目标值，避免瞬间跳变
function applyBubbleBoost(bubble, now) {
  const boost = bubble.boost;
  if (!boost) return false;
  const t = Math.min(1, Math.max(0, (now - boost.startedAt) / boost.duration));
  const eased = t * t * (3 - 2 * t);
  const want = boost.from + (boost.to - boost.from) * eased;
  const speed = Math.hypot(bubble.vx, bubble.vy);
  if (speed > 0.1) {
    const factor = want / speed;
    bubble.vx *= factor;
    bubble.vy *= factor;
  } else {
    bubble.vx = want;
    bubble.vy = 0;
  }
  if (t >= 1) bubble.boost = null;
  return true;
}

// 气泡流白饭门槛：累计赠送 1 份白饭即可进入候选（未达标的用户不会出现在气泡流）
const RICE_BUBBLE_MIN = 1;

function bubbleRoster(limit) {
  return [...state.giftUsers.entries()]
    .filter(([key, item]) => key && item && (Number(item.rice) || 0) >= RICE_BUBBLE_MIN)
    .sort(
      (a, b) =>
        (Number(b[1].rice) || 0) - (Number(a[1].rice) || 0) ||
        (Number(b[1].count) || 0) - (Number(a[1].count) || 0) ||
        String(a[1].name || '').localeCompare(String(b[1].name || ''), 'zh-CN'),
    )
    .slice(0, Math.max(0, Math.round(limit)))
    .map(([key, item]) => ({
      key,
      name: String(item.name || '观众'),
      avatar: String(item.avatar || ''),
      rice: Number(item.rice) || 0,
    }));
}

function createBubble(item, position) {
  const container = $('#avatarBubbles');
  if (!container) return null;
  const W = window.innerWidth;
  const H = window.innerHeight;
  // 每个气泡有独立的大小和碰撞半径
  const base = Math.min(96, Math.max(44, Math.round(Math.min(W, H) * 0.078)));
  const size = Math.round(base * (0.86 + Math.random() * 0.28));
  const r = size / 2;
  const start = position || {
    x: W / 2 + (Math.random() - 0.5) * 60,
    y: H / 2 + (Math.random() - 0.5) * 60,
  };
  const x = Math.min(Math.max(r, start.x), Math.max(r, W - r));
  const y = Math.min(Math.max(r, start.y), Math.max(r, H - r));
  const angle = Math.random() * Math.PI * 2;
  const speed = 60 + Math.random() * 55; // 匀速：速度大小固定，方向随机
  // 自转：方向随机、速度适中，头像会绕圆心持续旋转
  const spin = (25 + Math.random() * 50) * (Math.random() < 0.5 ? -1 : 1);

  const el = document.createElement('div');
  el.className = 'bubble';
  // 付费用户（无 free 标签）的头像边框用蓝色，免费用户保持白色
  if (item.tag !== 'free') el.classList.add('is-paid');
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  el.style.transform = `translate3d(${(x - r).toFixed(2)}px, ${(y - r).toFixed(2)}px, 0)`;

  const core = document.createElement('span');
  core.className = 'bubble-core is-spawning';
  core.style.fontSize = `${Math.round(size * 0.42)}px`;
  const fallback = () => {
    core.textContent = initial(item.name);
    core.classList.add('fallback');
  };
  if (item.avatar) {
    const img = document.createElement('img');
    img.src = item.avatar;
    img.alt = item.name;
    img.referrerPolicy = 'no-referrer';
    img.draggable = false; // 避免拖拽气泡时触发浏览器原生图片拖动
    img.addEventListener('error', fallback, { once: true });
    core.append(img);
  } else {
    fallback();
  }
  const nameEl = document.createElement('span');
  nameEl.className = 'bubble-name';
  nameEl.textContent = item.name;
  nameEl.style.fontSize = `${Math.max(10, Math.round(size * 0.17))}px`;
  nameEl.style.maxWidth = `${Math.round(size * 1.7)}px`;
  const rotor = document.createElement('div');
  rotor.className = 'bubble-rotor';
  rotor.append(core, nameEl);
  // 用户名是气泡的绑定子实体：相对位置固定，随气泡位移和自转同步变换，自身不旋转、不参与碰撞
  el.append(rotor);
  container.append(el);
  setTimeout(() => core.classList.remove('is-spawning'), 320);

  const bubble = {
    key: item.key,
    name: String(item.name || '观众'),
    el,
    core,
    rotor,
    nameEl,
    r,
    x,
    y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    // 预设巡航速度：甩出后的速度会衰减回这个值，不再继续变慢
    baseSpeed: speed,
    rot: Math.random() * 360,
    spin,
    // 甩飞脚本动画期间的额外缩放/挤压；script 非空时由脚本独占控制
    scale: 1,
    squash: 0,
    script: null,
    drag: null,
    boost: null, // 随机加速的曲线状态（from/to/startedAt/duration）
  };
  bindBubbleDrag(bubble);
  return bubble;
}

/* ---------- 手动拖拽 + 向量释放 ----------
 * 按住气泡可拖到任意位置；松手时根据最后 120ms 的指针轨迹算释放速度向量，
 * 拖动期间气泡视为不可推动的挡板，其他气泡撞上来会被弹开。
 */
const MAX_THROW_SPEED = 1500; // 松手速度上限（px/s），避免甩得太猛
const DRAG_SAMPLE_MS = 120;

// 统一写 transform：物理漂浮只有位移，甩飞脚本会额外叠加缩放/挤压
function applyBubbleTransform(bubble) {
  const scale = Number(bubble.scale) || 1;
  const squash = Number(bubble.squash) || 0;
  let shape = '';
  if (scale !== 1 || squash !== 0) {
    const sx = scale * (1 + squash * 0.18);
    const sy = scale * (1 - squash * 0.22);
    shape = ` scale(${sx.toFixed(3)}, ${sy.toFixed(3)})`;
  }
  bubble.el.style.transform = `translate3d(${(bubble.x - bubble.r).toFixed(2)}px, ${(bubble.y - bubble.r).toFixed(2)}px, 0)${shape}`;
}

// 气泡自转：用户名作为气泡的子实体一起转，相对位置固定，自身不做任何独立旋转
function applyBubbleRotation(bubble) {
  const target = bubble.rotor || bubble.core;
  target.style.transform = `rotate(${bubble.rot.toFixed(1)}deg)`;
}

function placeBubble(bubble, x, y) {
  const maxY = Math.max(bubble.r, window.innerHeight - bubble.r - NAME_RESERVE);
  const minY = Math.min(bubble.r + NAME_RESERVE, maxY);
  bubble.x = Math.min(Math.max(bubble.r, x), Math.max(bubble.r, window.innerWidth - bubble.r));
  bubble.y = Math.min(Math.max(minY, y), maxY);
  applyBubbleTransform(bubble);
}

function bindBubbleDrag(bubble) {
  const el = bubble.el;

  function stopDrag(event) {
    const drag = bubble.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    bubble.drag = null;
    el.classList.remove('is-dragging');
    // 只取松手前 120ms 内的轨迹；抓住不动再松手不会把气泡甩出去
    const now = performance.now();
    const fresh = drag.samples.filter((sample) => now - sample.t <= DRAG_SAMPLE_MS);
    let vx = 0;
    let vy = 0;
    if (fresh.length >= 2) {
      const first = fresh[0];
      const last = fresh[fresh.length - 1];
      const dt = Math.max(0.016, (last.t - first.t) / 1000);
      vx = (last.x - first.x) / dt;
      vy = (last.y - first.y) / dt;
    }
    const speed = Math.hypot(vx, vy);
    if (speed > MAX_THROW_SPEED) {
      vx = (vx / speed) * MAX_THROW_SPEED;
      vy = (vy / speed) * MAX_THROW_SPEED;
    }
    bubble.vx = vx;
    bubble.vy = vy;
  }

  el.addEventListener('pointerdown', (event) => {
    if (bubble.script) return; // 正在被甩飞的气泡不接受拖拽，避免两套动画打架
    if (event.button != null && event.button !== 0) return;
    event.preventDefault();
    const rect = el.getBoundingClientRect();
    bubble.drag = {
      pointerId: event.pointerId,
      // 记录抓取点相对圆心的偏移，拖动时圆心跟手不跳
      offsetX: event.clientX - (rect.left + rect.width / 2),
      offsetY: event.clientY - (rect.top + rect.height / 2),
      samples: [{ x: event.clientX, y: event.clientY, t: performance.now() }],
    };
    bubble.vx = 0;
    bubble.vy = 0;
    el.classList.add('is-dragging');
    try {
      el.setPointerCapture(event.pointerId);
    } catch {
      /* 旧内核或合成事件不支持指针捕获时忽略 */
    }
  });

  el.addEventListener('pointermove', (event) => {
    const drag = bubble.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    placeBubble(bubble, event.clientX - drag.offsetX, event.clientY - drag.offsetY);
    const now = performance.now();
    drag.samples.push({ x: event.clientX, y: event.clientY, t: now });
    while (drag.samples.length > 2 && now - drag.samples[0].t > DRAG_SAMPLE_MS) drag.samples.shift();
  });

  el.addEventListener('pointerup', stopDrag);
  el.addEventListener('pointercancel', stopDrag);
}

function burstBubble(bubble) {
  bubble.core.classList.remove('is-spawning');
  bubble.core.classList.add('is-bursting');
  const el = bubble.el;
  // 破裂动画结束后再移除节点，位置已被新气泡立即接管，不会出现空档
  setTimeout(() => el.remove(), 360);
}

function syncBubbles() {
  const desired = desiredBubbleItems();
  const keep = new Set(desired.map((item) => item.key));
  const freed = [];

  // 只对比用户集合，不关心排名顺序：不在新榜单里的气泡逐个破裂
  for (const [key, bubble] of bubbleState.items) {
    if (keep.has(key)) continue;
    // 正在甩飞的气泡不中途破裂，脚本结束后再对齐榜单
    if (bubble.script) continue;
    bubbleState.items.delete(key);
    freed.push({ x: bubble.x, y: bubble.y });
    burstBubble(bubble);
  }

  // 新进入榜单的用户优先在刚破裂的位置生成；没有空位时从画布中心开始
  for (const item of desired) {
    const existing = bubbleState.items.get(item.key);
    if (existing) {
      // 同一个用户从免费转付费（送礼后摘掉 free 标签）时，同步切换边框样式
      existing.el.classList.toggle('is-paid', item.tag !== 'free');
      continue;
    }
    const bubble = createBubble(item, freed.shift());
    if (bubble) bubbleState.items.set(item.key, bubble);
  }

  // 把最新气泡流名单同步给桥接，插件「甩飞 XXX」只从这份名单里匹配
  scheduleRosterPublish();
}

// 名单发布做 250ms 防抖：连击礼物每帧都会刷新统计，避免刷屏
let rosterTimer = 0;
function scheduleRosterPublish() {
  // 演示页也发布名单（带 demo 标记），桥接只在真实名单为空时用它兜底，
  // 方便在 ?demo=1 预览页直接测试「甩飞 糖糖」
  if (rosterTimer) return;
  rosterTimer = setTimeout(() => {
    rosterTimer = 0;
    publishBubbleRoster();
  }, 250);
}

async function publishBubbleRoster() {
  try {
    await fetch('/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'bubble_roster',
        at: Date.now(),
        data: {
          bubbles: desiredBubbleItems(),
          threshold: RICE_BUBBLE_MIN,
          max: state.maxBubbles,
          demo: state.demo,
          // 诊断用：本轮统计里有多少人、多少人达到白饭门槛
          users: state.giftUsers.size,
          riceUsers: [...state.giftUsers.values()].filter(
            (item) => (Number(item.rice) || 0) >= RICE_BUBBLE_MIN,
          ).length,
          // 诊断用：礼物件数明细与送礼人白饭，便于核对总数是否失真
          giftTypes: [...state.giftTypes],
          gifters: bubbleRoster(Math.max(10, state.maxBubbles)),
        },
      }),
    });
  } catch {
    /* 桥接未启动时忽略，下一轮统计更新会重试 */
  }
}

/* ---------- 气泡队列管理（每 60 秒补充 free 气泡，付费气泡优先替换最早的 free） ---------- */
const BUBBLE_QUEUE_KEY = 'board:bubble-queue:v1';
const BUBBLE_QUEUE_VERSION = '1.16.85';
const BUBBLE_QUEUE_INTERVAL_MS = 60000;
const VIEWER_POOL_MAX = 200;
const VIEWER_POOL_TTL_MS = 5 * 60 * 1000;
const FREE_ANNOUNCE_GAP_MS = 8000;

let bubbleQueue = null; // 队列实例（模块加载成功后才可用）
let bubbleScheduler = null; // 定时任务句柄
let bubbleQueueLoadFailed = 0;
let lastFreeAnnounceAt = 0;

// 记录最近在直播间出现过的观众，作为补充免费气泡的在线用户池
function rememberViewer(user, ts = Date.now()) {
  if (!user) return;
  const name = String(user.nickname || user.name || '').trim();
  const key = String(user.id || user.key || name || '').trim();
  if (!key || !name) return;
  const prev = state.viewerPool.get(key);
  state.viewerPool.set(key, {
    key,
    name,
    avatar: String(user.avatar || (prev && prev.avatar) || ''),
    lastSeen: ts,
  });
  if (state.viewerPool.size > VIEWER_POOL_MAX) {
    let oldestKey = '';
    let oldestTs = Infinity;
    for (const [poolKey, item] of state.viewerPool) {
      if (item.lastSeen < oldestTs) {
        oldestTs = item.lastSeen;
        oldestKey = poolKey;
      }
    }
    if (oldestKey) state.viewerPool.delete(oldestKey);
  }
}

// 在线用户池：5 分钟内出现过的人才算“在场”
function viewerPoolCandidates() {
  const cutoff = Date.now() - VIEWER_POOL_TTL_MS;
  return [...state.viewerPool.values()].filter((item) => item.lastSeen >= cutoff);
}

// 当前应该渲染的气泡：队列快照（队列不可用时退回旧的礼物榜口径）
function desiredBubbleItems() {
  if (!bubbleQueue) return bubbleRoster(state.maxBubbles);
  const limit = Math.max(0, Math.round(state.maxBubbles));
  return bubbleQueue
    .snapshot()
    .slice(0, limit)
    .map(({ key, name, avatar, tag }) => ({ key, name, avatar, tag }));
}

function queueLogger({ level, message, detail }) {
  const writer = level === 'warn' ? console.warn : console.info;
  writer('[bubble-queue]', message, detail || {});
}

// 免费气泡上气泡后同步提示该用户：直接发「甩飞我自己」即可体验甩飞玩法。
// 消息区属于直播画面，观众能直接看到；8 秒节流避免连续补充时刷屏。
function announceFreeBubble(entry) {
  if (!entry || !entry.key) return;
  const now = Date.now();
  if (now - lastFreeAnnounceAt < FREE_ANNOUNCE_GAP_MS) return;
  lastFreeAnnounceAt = now;
  addFeed({
    type: 'system',
    name: '上气泡',
    text: `${displaySafeName(entry.name)} 上气泡啦，发送「甩飞我自己」即可体验甩飞玩法`,
    ts: now,
  });
  console.info('[bubble-queue] 已提示免费气泡用户甩飞玩法', { key: entry.key, name: entry.name });
}

// 多实例（多个背景板标签页）互斥：拿不到锁说明别的实例正在检查，本轮跳过
async function withBubbleQueueLock(task) {
  if (!navigator.locks || typeof navigator.locks.request !== 'function') return task();
  return navigator.locks.request('dy-board-bubble-queue', { mode: 'exclusive', ifAvailable: true }, async (lock) => {
    if (!lock) {
      console.info('[bubble-queue] 其他实例正在执行检查，本轮跳过');
      return { skipped: true };
    }
    return task();
  });
}

// 已统计的付费用户补齐进队列（刷新恢复后不会少气泡）
function syncQueueFromGiftUsers() {
  if (!bubbleQueue) return;
  const gifters = [...state.giftUsers.entries()]
    .sort(
      (a, b) =>
        (Number(b[1].rice) || 0) - (Number(a[1].rice) || 0) ||
        (Number(b[1].count) || 0) - (Number(a[1].count) || 0),
    )
    .slice(0, Math.max(1, Math.round(state.maxBubbles)));
  for (const [key, person] of gifters) {
    bubbleQueue.onGift({ key, name: person.name, avatar: person.avatar }).catch(() => {});
  }
}

async function initBubbleQueue() {
  try {
    const mod = await import(`/board/bubbleQueue.js?v=${BUBBLE_QUEUE_VERSION}`);
    const persistence = state.demo
      ? {}
      : {
          persist: (payload) => localStorage.setItem(BUBBLE_QUEUE_KEY, JSON.stringify(payload)),
          restore: () => {
            try {
              return JSON.parse(localStorage.getItem(BUBBLE_QUEUE_KEY) || 'null');
            } catch {
              return null;
            }
          },
        };
    bubbleQueue = mod.createBubbleQueue({
      ...persistence,
      logger: queueLogger,
      onChange: (event, result) => {
        syncBubbles();
        // 定时补充的免费气泡入队后，同帧提示该用户可体验甩飞玩法
        if (event === 'fill' && result && result.added) announceFreeBubble(result.entry);
      },
    });
    // 排障入口：控制台可直接查看/触发队列
    window.dyBubbleQueue = bubbleQueue;
    syncQueueFromGiftUsers();
    // 定时任务：启动即注册，每 60 秒检查一次；单轮异常只记日志，不中断后续轮次
    bubbleScheduler = mod.startBubbleQueueScheduler({
      queue: bubbleQueue,
      intervalMs: BUBBLE_QUEUE_INTERVAL_MS,
      threshold: () => state.maxBubbles,
      pool: () => viewerPoolCandidates(),
      logger: queueLogger,
      wrap: withBubbleQueueLock,
    });
    syncBubbles();
    console.info('[bubble-queue] 气泡队列定时任务已启动', {
      intervalMs: BUBBLE_QUEUE_INTERVAL_MS,
      restored: bubbleQueue.size(),
    });
  } catch (error) {
    bubbleQueueLoadFailed += 1;
    console.warn('[bubble-queue] 队列模块加载失败，将自动重试', error);
    if (bubbleQueueLoadFailed <= 5) setTimeout(initBubbleQueue, 3000);
  }
}

// 气泡互撞：等质量弹性碰撞。重叠先按法线平滑推开（单帧有上限，避免生硬跳变），
// 再沿法线交换速度分量，切向速度保持不变，入射角等于反射角。
const MAX_PUSH_PER_FRAME = 4;

function resolveBubbleCollisions(bubbles) {
  for (let i = 0; i < bubbles.length; i += 1) {
    const a = bubbles[i];
    for (let j = i + 1; j < bubbles.length; j += 1) {
      const b = bubbles[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let dist = Math.hypot(dx, dy);
      const minDist = a.r + b.r;
      if (dist >= minDist) continue;
      if (dist < 0.001) {
        // 完全重合时没有法线方向，随便挑一个方向推开
        dx = 1;
        dy = 0;
        dist = 1;
      }
      const nx = dx / dist;
      const ny = dy / dist;
      const aFixed = Boolean(a.drag);
      const bFixed = Boolean(b.drag);
      if (aFixed && bFixed) continue;
      const push = Math.min(minDist - dist, MAX_PUSH_PER_FRAME);
      // 被拖住的气泡当挡板：只推动另一个，自己不跟着跑
      if (!aFixed) {
        a.x -= nx * (push / (bFixed ? 1 : 2));
        a.y -= ny * (push / (bFixed ? 1 : 2));
      }
      if (!bFixed) {
        b.x += nx * (push / (aFixed ? 1 : 2));
        b.y += ny * (push / (aFixed ? 1 : 2));
      }
      if (aFixed) {
        // b 撞上不动的 a：沿法线反射 b 的速度
        const vn = b.vx * nx + b.vy * ny;
        if (vn < 0) {
          b.vx -= 2 * vn * nx;
          b.vy -= 2 * vn * ny;
        }
      } else if (bFixed) {
        // a 撞上不动的 b：沿法线反射 a 的速度
        const vn = a.vx * nx + a.vy * ny;
        if (vn > 0) {
          a.vx -= 2 * vn * nx;
          a.vy -= 2 * vn * ny;
        }
      } else {
        // 等质量弹性碰撞：沿法线交换速度分量，切向不变
        const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (vn < 0) {
          a.vx += vn * nx;
          a.vy += vn * ny;
          b.vx -= vn * nx;
          b.vy -= vn * ny;
        }
      }
    }
  }
}

function clampBubbleInside(bubble, W, H) {
  const maxX = Math.max(bubble.r, W - bubble.r);
  // 用户名会绕气泡转到上/下方，上下都留 26px，避免贴边时被画面裁掉
  const maxY = Math.max(bubble.r, H - bubble.r - NAME_RESERVE);
  const minY = Math.min(bubble.r + NAME_RESERVE, maxY);
  // 边界反射：位置贴边并翻转该轴速度，入射角等于反射角
  if (bubble.x <= bubble.r) {
    bubble.x = bubble.r;
    bubble.vx = Math.abs(bubble.vx);
  } else if (bubble.x >= maxX) {
    bubble.x = maxX;
    bubble.vx = -Math.abs(bubble.vx);
  }
  if (bubble.y <= minY) {
    bubble.y = minY;
    bubble.vy = Math.abs(bubble.vy);
  } else if (bubble.y >= maxY) {
    bubble.y = maxY;
    bubble.vy = -Math.abs(bubble.vy);
  }
}

// 定时器驱动而不是 rAF：OBS/非全屏窗口被遮挡时 rAF 会被限流停住
setInterval(() => {
  const now = performance.now();
  const dt = Math.min(0.05, Math.max(0, (now - bubbleState.lastTs) / 1000));
  bubbleState.lastTs = now;
  // 跑马灯的行进/下落与气泡数量无关，没有气泡时也要继续跑
  updateRiceMarquee(dt);
  if (!bubbleState.items.size) {
    // 场上没有气泡时重新计时，等观众气泡出现后再满 30 秒才加速
    bubbleState.boostAt = 0;
    return;
  }
  boostRandomBubble(now);
  const W = window.innerWidth;
  const H = window.innerHeight;
  const bubbles = [...bubbleState.items.values()];
  const free = [];
  for (const bubble of bubbles) {
    // 甩飞脚本期间：位置/缩放完全由脚本控制，跳过物理与碰撞
    if (bubble.script) {
      updateBubbleScript(bubble, now, dt, W, H);
      applyBubbleRotation(bubble);
      continue;
    }
    free.push(bubble);
    // 拖拽中的气泡位置完全由指针控制，跳过物理积分
    if (bubble.drag) continue;
    // 随机加速：按曲线平滑拉高速度，曲线期间暂停 20% 衰减，避免互相拉扯
    const boosting = applyBubbleBoost(bubble, now);
    bubble.x += bubble.vx * dt;
    bubble.y += bubble.vy * dt;
    // 甩出后的速度按每秒 20% 衰减，降到预设巡航速度后保持匀速漂浮
    const speed = Math.hypot(bubble.vx, bubble.vy);
    if (!boosting && speed > bubble.baseSpeed + 0.5) {
      const next = Math.max(bubble.baseSpeed, speed * Math.pow(0.8, dt));
      const factor = next / speed;
      bubble.vx *= factor;
      bubble.vy *= factor;
    }
    bubble.rot = (bubble.rot + bubble.spin * dt) % 360;
  }
  // 脚本中的气泡不参与互撞：它要穿过面板飞向送礼榜，不能被别人顶偏
  resolveBubbleCollisions(free);
  for (const bubble of free) {
    clampBubbleInside(bubble, W, H);
    applyBubbleTransform(bubble);
    // 自转交给 rotor（头像+用户名一起转），出生/破裂动画期间由 CSS 动画临时接管头像 transform
    applyBubbleRotation(bubble);
  }
  // 顶部整段白饭文本与气泡流碰撞：气泡正常反弹，文本被撞落
  checkRiceMarqueeCollisions();
}, 16);

/* ---------- 甩飞：抓到桌宠手里 → 甩向送礼榜 → 撞屏下滑 → 触底反弹 ----------
 * 时序：pickup（拾取绑定）→ hold（等桌宠甩出动作播完）→ flight（放大飞行）
 * → impact（软质球体撞屏压扁）→ slide（沿屏幕滑到底部并缩回原尺寸）
 * → 交回原始气泡物理，以向下速度撞底后按边界反射向上弹起。
 */
const THROW_PICKUP_MS = 520;
const THROW_HOLD_MS = 1100;
const THROW_FLIGHT_MS = 460;
const THROW_SLIDE_MS = 620;
const THROW_IMPACT_MS = 90;

const clamp01 = (value) => Math.min(1, Math.max(0, value));
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInQuad = (t) => t * t;

function bubbleRect(selector) {
  const node = $(selector);
  return node ? node.getBoundingClientRect() : null;
}

function startBubbleThrow(data) {
  const key = data && data.key != null ? String(data.key) : '';
  const bubble = key ? bubbleState.items.get(key) : null;
  const fallbackName = displaySafeName((data && data.name) || '该观众');
  if (!bubble) {
    // 目标不在气泡流：消息区即时提示（语音侧由插件同一时刻触发）
    addFeed({ type: 'system', name: '甩飞', text: `${fallbackName}没在气泡流中`, ts: Date.now() });
    return false;
  }
  if (bubble.script) return false; // 同一条指令重复到达时保持幂等
  const W = window.innerWidth;
  const H = window.innerHeight;
  const stageRect = bubbleRect('#petStage');
  const giftersRect = bubbleRect('.gifters-panel');
  // 桌宠手中：站位框中心偏上；没有桌宠站位时退回屏幕下方中央
  const hand = stageRect
    ? { x: stageRect.left + stageRect.width / 2, y: stageRect.top + stageRect.height * 0.38 }
    : { x: W / 2, y: H - 150 };
  // 甩出目标固定在屏幕上方送礼榜附近
  const impact = giftersRect
    ? {
        x: giftersRect.left + giftersRect.width / 2,
        y: Math.max(24, giftersRect.top + Math.min(28, giftersRect.height * 0.35)),
      }
    : { x: W / 2, y: 64 };
  bubble.drag = null;
  bubble.vx = 0;
  bubble.vy = 0;
  bubble.el.classList.remove('is-dragging');
  bubble.el.classList.add('is-picked');
  bubble.script = {
    start: performance.now(),
    pickupMs: Math.max(220, Math.min(1600, Number(data.pickupMs) || THROW_PICKUP_MS)),
    holdMs: Math.max(300, Math.min(3000, Number(data.holdMs) || THROW_HOLD_MS)),
    flightMs: Math.max(240, Math.min(1200, Number(data.flightMs) || THROW_FLIGHT_MS)),
    slideMs: Math.max(300, Math.min(1600, Number(data.slideMs) || THROW_SLIDE_MS)),
    from: { x: bubble.x, y: bubble.y },
    hand,
    impact,
  };
  return true;
}

function displaySafeName(name) {
  const text = String(name || '').trim();
  return text || '该观众';
}

function updateBubbleScript(bubble, now, dt, W, H) {
  const script = bubble.script;
  const elapsed = now - script.start;
  const pickupEnd = script.pickupMs;
  const holdEnd = pickupEnd + script.holdMs;
  const flightEnd = holdEnd + script.flightMs;
  const impactEnd = flightEnd + THROW_IMPACT_MS;
  const slideEnd = impactEnd + script.slideMs;

  if (elapsed < pickupEnd) {
    script.phase = 'pickup';
    // 拾取：从原位平滑飞到桌宠手中，体积略微收紧
    const k = easeOutCubic(clamp01(elapsed / script.pickupMs));
    bubble.x = script.from.x + (script.hand.x - script.from.x) * k;
    bubble.y =
      script.from.y + (script.hand.y - script.from.y) * k - Math.sin(Math.PI * k) * 34;
    bubble.scale = 1 - 0.14 * k;
    bubble.squash = 0;
    bubble.rot = (bubble.rot + bubble.spin * dt * 0.6) % 360;
  } else if (elapsed < holdEnd) {
    script.phase = 'hold';
    // 绑定在手中：轻微呼吸，等桌宠甩出动作播完
    const k = clamp01((elapsed - pickupEnd) / Math.max(1, script.holdMs));
    bubble.x = script.hand.x;
    bubble.y = script.hand.y + Math.sin(k * Math.PI * 2) * 3;
    bubble.scale = 0.86 + 0.04 * Math.sin(k * Math.PI * 2);
    bubble.squash = 0;
    bubble.rot = (bubble.rot + bubble.spin * dt) % 360;
  } else if (elapsed < flightEnd) {
    script.phase = 'flight';
    // 甩出：抛物线飞向送礼榜，飞行途中逐渐放大
    const k = clamp01((elapsed - holdEnd) / script.flightMs);
    const e = easeOutCubic(k);
    bubble.x = script.hand.x + (script.impact.x - script.hand.x) * e;
    bubble.y =
      script.hand.y +
      (script.impact.y - script.hand.y) * e -
      Math.sin(Math.PI * k) * 88;
    bubble.scale = 0.9 + (2.1 - 0.9) * easeInQuad(k);
    bubble.squash = -0.3 * k; // 负值 = 纵向拉长，像被甩出去
    bubble.rot = (bubble.rot + bubble.spin * dt * 2.4) % 360;
  } else if (elapsed < impactEnd) {
    script.phase = 'impact';
    // 撞屏：软质球体压扁回弹
    const k = clamp01((elapsed - flightEnd) / THROW_IMPACT_MS);
    bubble.x = script.impact.x;
    bubble.y = script.impact.y;
    bubble.scale = 2.1;
    bubble.squash = Math.sin(k * Math.PI);
    bubble.rot = (bubble.rot + bubble.spin * dt) % 360;
  } else if (elapsed < slideEnd) {
    script.phase = 'slide';
    // 沿屏幕表面加速下滑，体积逐渐缩回原始气泡尺寸
    const k = clamp01((elapsed - impactEnd) / script.slideMs);
    bubble.x = script.impact.x;
    bubble.y = script.impact.y + (H - bubble.r - script.impact.y) * easeInQuad(k);
    bubble.scale = 2.1 + (1 - 2.1) * k;
    bubble.squash = 0.4 * (1 - k);
    bubble.rot = (bubble.rot + bubble.spin * dt * 1.6) % 360;
  } else {
    script.phase = 'done';
    // 触底：交还物理引擎，以向下速度撞到底部后由边界反射向上弹起
    bubble.script = null;
    bubble.el.classList.remove('is-picked');
    bubble.scale = 1;
    bubble.squash = 0;
    bubble.x = Math.min(Math.max(bubble.r, script.impact.x), Math.max(bubble.r, W - bubble.r));
    bubble.y = Math.max(bubble.r, H - bubble.r);
    bubble.vx = (Math.random() < 0.5 ? -1 : 1) * (40 + Math.random() * 40);
    bubble.vy = 760;
    bubble.rot = Math.random() * 360;
    applyBubbleTransform(bubble);
    // 脚本期间榜单可能已经变化，落地后重新对齐
    syncBubbles();
    return;
  }
  applyBubbleTransform(bubble);
}

function applyBalance(data) {
  if (!data || !data.text) return;
  $('#apiQuota').textContent = data.text;
}

async function refreshBalance() {
  try {
    const response = await fetch('/api/balance', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    applyBalance(data.data);
  } catch {
    /* bridge 未启动时忽略 */
  }
}

/* ---------- 本地播放：网易云直链由 bridge 下发，audio 直接播放 ---------- */
let lastSongSnapshot = null;
let audioBlocked = false;

function syncAudio(data) {
  const audio = $('#songAudio');
  if (!audio) return;
  const cur = data && data.current;
  const url = cur && cur.playUrl ? String(cur.playUrl) : '';
  if (!url) {
    if (audio.dataset.src) {
      audio.pause();
      audio.removeAttribute('src');
      delete audio.dataset.src;
    }
    return;
  }
  if (audio.dataset.src !== url) {
    audio.dataset.src = url;
    audio.src = url;
    try {
      audio.currentTime = Math.max(0, (Number(data.elapsed) || 0) / 1000 - 0.3);
    } catch {
      /* 元数据未就绪时浏览器会自己处理 */
    }
  }
  if (data.paused) {
    if (!audio.paused) audio.pause();
    return;
  }
  if (audio.paused) {
    // 恢复/继续：与 bridge 计时对齐（暂停、桥接重启都会产生偏差）
    const pos = Math.max(0, (Number(data.elapsed) || 0) / 1000 - 0.3);
    try {
      if (Math.abs(audio.currentTime - pos) > 3) audio.currentTime = pos;
    } catch {
      /* 同上 */
    }
    const playing = audio.play();
    if (playing) playing.catch(() => { audioBlocked = true; });
  }
}

// 浏览器自动播放策略：被拦截后等首次点击页面解锁
document.addEventListener(
  'click',
  () => {
    if (!audioBlocked) return;
    audioBlocked = false;
    syncAudio(lastSongSnapshot);
  },
  true,
);

function applySong(data) {
  if (!data) return;
  lastSongSnapshot = data;
  if (!state.demo) syncAudio(data);
  const current = data.current;
  const external = data.external && data.external.title ? data.external : null;
  const queue = Array.isArray(data.queue) ? data.queue : [];
  const songKey = current ? current.requestId || `${current.source}-${current.id}` : '';
  state.hasSong = Boolean(current || external);

  if (current) {
    $('#songTitle').textContent = current.title || '未知歌曲';
    $('#songArtist').textContent = current.recommend
      ? [current.artist, '每日推荐'].filter(Boolean).join(' · ')
      : [current.artist, current.requestedBy ? `点歌：${current.requestedBy}` : '']
          .filter(Boolean)
          .join(' · ');
    document.querySelector('.eyebrow').textContent = current.recommend
      ? 'NOW PLAYING · 每日推荐'
      : current.priority
        ? 'NOW PLAYING · 插队'
        : 'NOW PLAYING';
    $('#nowCard').classList.toggle('paused', Boolean(data.paused));
    $('#nowCard').classList.remove('external');
    $('#pauseBtn').textContent = data.paused ? '▶' : '⏸';
    const cover = $('#cover');
    if (current.cover) {
      cover.style.backgroundImage = `url("${String(current.cover).replace(/"/g, '')}")`;
      cover.innerHTML = '';
    } else {
      cover.style.backgroundImage = '';
      cover.innerHTML = '<span>♪</span>';
    }
    const duration = Number(current.duration) || 0;
    const elapsed = Number(data.elapsed) || 0;
    const percent = duration > 0 ? Math.min(100, Math.max(0, (elapsed / duration) * 100)) : 0;
    $('#progressBar').style.transform = `scaleX(${(percent / 100).toFixed(4)})`;
  } else if (external) {
    $('#songTitle').textContent = external.title || '未知歌曲';
    $('#songArtist').textContent = [external.artist, external.app ? `系统播放：${external.app}` : '系统播放器']
      .filter(Boolean)
      .join(' · ');
    document.querySelector('.eyebrow').textContent = 'NOW PLAYING · 系统';
    $('#nowCard').classList.remove('paused');
    $('#nowCard').classList.add('external');
    $('#pauseBtn').textContent = '⏸';
    $('#cover').style.backgroundImage = '';
    $('#cover').innerHTML = '<span>♪</span>';
    $('#progressBar').style.transform = 'scaleX(0)';
  } else {
    $('#songTitle').textContent = '还没有点歌';
    $('#songArtist').textContent = '评论区输入「点歌 歌名」';
    document.querySelector('.eyebrow').textContent = 'NOW PLAYING';
    $('#nowCard').classList.remove('external', 'paused');
    $('#cover').style.backgroundImage = '';
    $('#cover').innerHTML = '<span>♪</span>';
    $('#progressBar').style.transform = 'scaleX(0)';
    $('#pauseBtn').textContent = '⏸';
  }

  $('#queueCount').textContent = String(queue.length);
  const queueSignature = JSON.stringify({
    current: songKey,
    external: external ? `${external.title}|${external.artist}|${external.app}` : '',
    queue: queue.map((song) => song.requestId || `${song.source}-${song.id}`),
  });
  if (queueSignature === state.queueSig) return;
  state.queueSig = queueSignature;
  const previousItems = queueList.querySelectorAll('.queue-song').length;
  const previousScroll = queueList.scrollTop;
  queueList.innerHTML = '';
  if (!queue.length) {
    if (external && !current) {
      const item = document.createElement('li');
      item.className = 'queue-external';
      const num = document.createElement('span');
      num.className = 'queue-index';
      num.textContent = '♪';
      const info = document.createElement('div');
      info.className = 'queue-song';
      const title = document.createElement('strong');
      title.textContent = external.title || '未知歌曲';
      const meta = document.createElement('span');
      meta.textContent = [external.artist, external.app].filter(Boolean).join(' · ');
      const hint = document.createElement('span');
      hint.className = 'queue-requester';
      hint.textContent = '当前播放 · 可点歌';
      info.append(title, meta, hint);
      item.append(num, info);
      queueList.append(item);
    } else {
      const empty = document.createElement('li');
      empty.className = 'queue-empty';
      empty.textContent = '队列空空的，来点一首吧';
      queueList.append(empty);
    }
  } else {
    let lastZone = '';
    queue.forEach((song, index) => {
      const zone = song.priority ? 'priority' : 'free';
      if (zone !== lastZone) {
        lastZone = zone;
        const zoneItem = document.createElement('li');
        zoneItem.className = `queue-zone ${zone}`;
        zoneItem.textContent = zone === 'priority' ? '插队点歌区' : '免费点歌区';
        queueList.append(zoneItem);
      }
      const item = document.createElement('li');
      const num = document.createElement('span');
      num.className = 'queue-index';
      num.textContent = String(index + 1);
      const info = document.createElement('div');
      info.className = 'queue-song';
      const title = document.createElement('strong');
      title.textContent = song.title || '未知歌曲';
      const meta = document.createElement('span');
      meta.textContent = song.artist || '未知歌手';
      if (song.priority) {
        const badge = document.createElement('em');
        badge.className = 'queue-badge';
        badge.textContent = '插队';
        meta.append(' ', badge);
      }
      const requester = document.createElement('span');
      requester.className = 'queue-requester';
      requester.textContent = `点歌人：${song.requestedBy || '观众'}`;
      info.append(title, meta, requester);
      item.append(num, info);
      queueList.append(item);
    });
  }

  // 新增点歌滚到最底部让它可见；只是切歌/移除时保留当前滚动位置，避免每次刷新都弹回顶部
  if (queue.length > previousItems && queue.length > 0) {
    queueList.scrollTop = queueList.scrollHeight;
  } else if (previousScroll > 0) {
    queueList.scrollTop = Math.min(previousScroll, queueList.scrollHeight - queueList.clientHeight);
  }

  if (songKey && songKey !== state.lastSongKey) {
    state.lastSongKey = songKey;
    if (current) {
      addFeed({
        type: 'system',
        name: '点歌台',
        text: `${current.priority ? '插队播放' : '正在播放'}：${current.title} - ${current.artist}`,
        ts: Date.now(),
      });
    }
  }
}

function handleEvent(payload) {
  if (!payload || !payload.kind) return;
  if (payload.id) {
    const id = String(payload.id);
    if (state.seenEvents.has(id)) return;
    state.seenEvents.add(id);
    if (state.seenEvents.size > 500) state.seenEvents.delete(state.seenEvents.values().next().value);
  }
  if (payload.kind === 'board_reload') {
    // replay 里可能再次带回同一条 reload；同一次重载只执行一次
    const key = `board-reload:${payload.id || payload.at || '1'}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');
      for (let i = sessionStorage.length - 1; i >= 0; i -= 1) {
        const name = sessionStorage.key(i) || '';
        if (name.startsWith('board-reload:') && name !== key) sessionStorage.removeItem(name);
      }
    } catch {
      /* ignore */
    }
    location.reload();
    return;
  }
  if (payload.kind === 'cache_clear') {
    try { localStorage.removeItem(STATS_KEY); } catch { /* ignore */ }
    state.chat = 0;
    state.reply = 0;
    state.gift = 0;
    state.giftTypes.clear();
    state.lastGift = '';
    state.watch = 0;
    state.watchRaw = 0;
    state.watchBase = 0;
    state.likes = 0;
    state.likesRaw = 0;
    state.likesBase = 0;
    state.tokens = 0;
    state.tokenDate = '';
    state.seenEvents.clear();
    state.recentHost = [];
    state.lastSongKey = '';
    state.songSig = '';
    state.queueSig = '';
    feed.innerHTML = '';
    queueList.innerHTML = '';
    $('#online').textContent = '0 人在线';
    $('#statChat').textContent = '0';
    $('#statReply').textContent = '0';
    $('#giftTotal').textContent = '0';
    $('#queueCount').textContent = '0';
    renderGifts();
    updateMetrics();
    return;
  }
  if (payload.kind === 'gift_reset') {
    applyGiftReset(payload.at);
    return;
  }
  if (payload.kind === 'bubble_throw') {
    // 断线重放不再触发旧指令，避免刷新后重演甩飞
    if (payload.replay) return;
    startBubbleThrow(payload.data || {});
    return;
  }
  if (payload.kind === 'board_refresh') {
    refreshBoardState();
    refreshSong();
    refreshBalance();
    return;
  }
  if (payload.room && payload.room.title) $('#roomTitle').textContent = payload.room.title;

  if (payload.kind === 'song') {
    applySong(payload.data);
    return;
  }

  if (payload.kind === 'balance') {
    applyBalance(payload.data);
    return;
  }

  if (payload.kind === 'status') {
    applyStatusData(payload.data || {});
    return;
  }
  if (payload.kind === 'ai_reply') {
    if (payload.eventId) markReply(payload.eventId, 'replied');
    addHost(payload.text, payload.provider || 'AI');
    return;
  }

  if (payload.kind === 'reply_start') {
    markReply(payload.eventId, 'replying');
    return;
  }

  if (payload.kind === 'reply_failed') {
    markReply(payload.eventId, 'failed');
    return;
  }

  if (payload.kind === 'reply_sent') {
    if (payload.eventId) markReply(payload.eventId, 'replied');
    if (!payload.dryRun) addHost(payload.text, '已发送');
    return;
  }

  if (payload.kind !== 'event' || !payload.event) return;
  const event = payload.event;
  if (payload.room && payload.room.online != null) updateOnline(payload.room.online);

  if (event.type === 'chat') {
    state.chat += 1;
    $('#statChat').textContent = String(state.chat);
    saveStats();
    const user = event.user || {};
    rememberViewer(user, event.ts || Date.now());
    addFeed({
      type: 'chat',
      name: user.nickname || '观众',
      avatar: user.avatar || '',
      text: event.content || '',
      eventId: event.id || '',
      ts: event.ts || Date.now(),
    });
    return;
  }

  if (event.type === 'gift') {
    // 连击帧的 repeatCount 是累计值：每帧只补差额，结束帧丢了也不会漏统计
    const user = event.user || {};
    const count = Math.max(1, Number(event.count || event.giftCount || event.gift?.count || 1));
    const rawGiftName = String(event.gift?.name || event.giftName || '').trim();
    const giftId = String(event.gift?.id || '').trim();
    const giftName = resolveGiftName(rawGiftName, giftId);
    const completed = !(event.gift && event.gift.completed === false);
    const delta = giftCombos.delta(user, giftId, giftName, count, completed);
    if (event.gift?.image) {
      state.giftImages.set(giftName, String(event.gift.image));
      if (state.giftImages.size > 150) {
        state.giftImages.delete(state.giftImages.keys().next().value);
      }
    }
    if (delta > 0) {
      state.giftTypes.set(giftName, (state.giftTypes.get(giftName) || 0) + delta);
      // 按送礼人维度同步累加（与礼物统计使用同一份差额，口径一致）
      const userName = String(user.nickname || '观众').trim() || '观众';
      const userKey = String(user.id || userName);
      rememberViewer(user, event.ts || Date.now());
      const person = state.giftUsers.get(userKey) || { name: userName, avatar: '', count: 0, rice: 0 };
      person.name = userName;
      if (user.avatar) person.avatar = String(user.avatar);
      person.count += delta;
      // 项目里所有礼物都按「白饭」口径统计（与插件 stats.rice 一致），气泡流准入即累计收礼数
      person.rice = (Number(person.rice) || 0) + delta;
      state.giftUsers.set(userKey, person);
      // 付费用户入队：替换最早的 free 气泡；本人原本是 free 则先摘掉 free 标签
      if (bubbleQueue) {
        bubbleQueue
          .onGift({ key: userKey, name: userName, avatar: person.avatar })
          .catch(() => {});
      }
      state.lastGift = `${giftName} ×${count}`;
      renderGifts();
      updateMetrics();
      saveStats();
    }
    if (!completed) return; // 连击中间帧不刷弹幕，等结束帧再上一条
    addFeed({
      type: 'gift',
      name: user.nickname || '观众',
      avatar: user.avatar || '',
      text: `送出 ${giftName} × ${count}`,
      ts: event.ts || Date.now(),
      badge: giftName,
      eventId: event.id || '',
    });
    return;
  }

  if (event.type === 'like') {
    rememberViewer(event.user, event.ts || Date.now());
    const total = Number(event.like && event.like.total) || 0;
    const count = Number(event.like && event.like.count) || 0;
    state.likes = total > 0 ? Math.max(state.likes, total) : state.likes + count;
    updateMetrics();
    return;
  }

  if (event.type === 'follow') {
    const user = event.user || {};
    bumpFollowToday(event.ts || Date.now());
    rememberViewer(user, event.ts || Date.now());
    addFeed({
      type: 'system',
      name: user.nickname || '关注',
      avatar: user.avatar || '',
      badge: '关注',
      text: '关注了直播间',
      ts: event.ts || Date.now(),
    });
    return;
  }

  if (event.type === 'member') {
    const user = event.user || {};
    rememberViewer(user, event.ts || Date.now());
    addFeed({
      type: 'system',
      name: user.nickname || '进场',
      avatar: user.avatar || '',
      badge: '进场',
      text: '来了',
      ts: event.ts || Date.now(),
    });
    return;
  }

  if (event.type === 'stats' && event.online != null) {
    updateOnline(event.online);
  }
}

async function refreshSong() {
  try {
    const response = await fetch('/api/song/state', { cache: 'no-store' });
    if (response.ok) applySong(await response.json());
  } catch {
    /* bridge 未启动时忽略 */
  }
}

async function songAction(action) {
  try {
    await fetch(`/api/song/${action}`, { method: 'POST' });
  } catch {
    /* ignore */
  }
  await refreshSong();
}

$('#pauseBtn').addEventListener('click', () => songAction('pause'));
$('#skipBtn').addEventListener('click', () => songAction('skip'));

function seedDemo() {
  updateOnline(128);
  $('#statusText').innerHTML = '<i class="status-dot"></i>示例数据 · 背景板预览';
  state.chat = 3;
  state.giftTypes = new Map([
    ['白饭', 3],
    ['小心心', 6],
  ]);
  state.giftUsers = new Map([
    ['demo-u1', { name: '小鹿', avatar: '', count: 3, rice: 3 }],
    ['demo-u2', { name: '糖糖', avatar: '', count: 6, rice: 6 }],
  ]);
  // 演示用在线用户池：让免费气泡补充逻辑在预览页也能跑通
  for (const [id, nickname] of [
    ['demo-v1', '小明'],
    ['demo-v2', '阿伟'],
    ['demo-v3', '小雨'],
    ['demo-v4', '阿杰'],
    ['demo-v5', '团子'],
    ['demo-v6', '喵喵'],
  ]) {
    rememberViewer({ id, nickname }, Date.now());
  }
  state.reply = 1;
  state.watch = 128;
  state.likes = 3642;
  state.tokens = 18234;
  state.lastGift = '白饭 ×6';
  $('#statChat').textContent = '3';
  $('#statReply').textContent = '1';
  renderGifts();
  updateMetrics();
  $('#apiQuota').textContent = '¥42.46';
  addFeed({ type: 'chat', name: '小明', text: '主播今天状态不错呀，唱的什么歌？', ts: Date.now() - 180000, eventId: 'demo-chat-1' });
  addHost('谢谢～今天随便聊聊，想听什么歌可以点歌哦', 'DeepSeek');
  addFeed({ type: 'chat', name: '阿伟', text: '点歌 晴天', ts: Date.now() - 120000, eventId: 'demo-chat-2' });
  addFeed({ type: 'gift', name: '小鹿', text: '送出 白饭 × 6', ts: Date.now() - 90000, badge: '白饭', eventId: 'demo-gift-1' });
  addFeed({ type: 'chat', name: '糖糖', text: '晴天！周杰伦的晴天！', ts: Date.now() - 60000, eventId: 'demo-chat-3' });
  markReply('demo-chat-3', 'replying');
  state.lastSongKey = 'demo';
  applySong({
    current: {
      id: '97773',
      title: '晴天',
      artist: '周杰伦',
      requestedBy: '阿伟',
      duration: 269000,
      cover: 'https://y.gtimg.cn/music/photo_new/T002R300x300M000000MkMni19ClKG.jpg',
      requestId: 'demo',
    },
    queue: [
      { title: '稻香', artist: '周杰伦', requestedBy: '糖糖', priority: true },
      { title: '告白气球', artist: '周杰伦', requestedBy: '小鹿' },
    ],
    paused: false,
    elapsed: 42000,
  });
  // 队列模块可能还没加载完，加载完成时会再补一次
  syncQueueFromGiftUsers();
}

function applySongIfChanged(data) {
  if (!data) return;
  const sig = JSON.stringify({
    current: data.current ? data.current.requestId || `${data.current.source}-${data.current.id}` : '',
    queue: (data.queue || []).map((item) => item.requestId || `${item.source}-${item.id}`),
    external: data.external ? `${data.external.title}|${data.external.artist}|${data.external.app}` : '',
    paused: Boolean(data.paused),
  });
  if (sig === state.songSig) return;
  state.songSig = sig;
  applySong(data);
}

function connect() {
  const source = new EventSource('/events?replay=20');
  state.eventSource = source;
  source.addEventListener('open', () => {
    state.sseOpen = true;
    $('#statusText').innerHTML = '<i class="status-dot"></i>已连接直播助手';
    // 桥接重启后内存里的气泡名单会丢，重连时立刻补发一份
    scheduleRosterPublish();
  });
  source.addEventListener('error', () => {
    state.sseOpen = false;
    $('#statusText').innerHTML = '<i class="status-dot off"></i>连接断开，正在重连…';
  });
  source.addEventListener('message', (message) => {
    try {
      handleEvent(JSON.parse(message.data));
    } catch {
      /* ignore malformed */
    }
  });
}

let boardSyncBusy = false;
async function refreshBoardState() {
  if (boardSyncBusy) return;
  boardSyncBusy = true;
  try {
    const response = await fetch('/api/board/state', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    for (const payload of data.recentEvents || []) handleEvent(payload);
    // SSE 断线或清空指令已被挤出事件历史时，靠该时间戳兜底执行清空
    if (Number(data.giftResetAt) > state.giftResetApplied) applyGiftReset(data.giftResetAt);
    applySongIfChanged(data.song);
    if (data.status) applyStatusData(data.status);
    if (data.balance) applyBalance(data.balance);
  } catch {
    /* bridge 未启动时忽略，EventSource 会自动重连 */
  } finally {
    boardSyncBusy = false;
  }
}

function tickClock() {
  $('#clock').textContent = new Date().toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

const statsClearBtn = $('#statsClear');
if (statsClearBtn) {
  if (params.get('demo') === '1') {
    statsClearBtn.hidden = true;
  } else {
    statsClearBtn.addEventListener('click', () => {
      clearBoardStats();
      statsClearBtn.textContent = '已清空';
      setTimeout(() => {
        statsClearBtn.textContent = '清空';
      }, 1400);
    });
  }
}

tickClock();
setInterval(tickClock, 1000);
// 气泡队列定时任务：页面启动即注册，模块加载失败会自动重试
initBubbleQueue();
refreshSong();
refreshBalance();
updateMetrics();
syncRiceMarquee();
window.addEventListener('resize', syncRiceMarquee);
loadGiftNames();
if (params.get('demo') === '1') {
  setTimeout(seedDemo, 300);
  // 演示名单每 5s 续期：桥接侧 15s 过期，关闭预览页后不会再被真实直播误用
  setInterval(() => scheduleRosterPublish(), 5000);
  // 预览页只订阅甩飞指令：方便直接演练玩法，不接收真实礼物流水，避免污染演示数据
  const previewSource = new EventSource('/events?replay=0');
  previewSource.addEventListener('message', (message) => {
    try {
      const payload = JSON.parse(message.data);
      if (payload.kind === 'bubble_throw' && !payload.replay) startBubbleThrow(payload.data || {});
    } catch {
      /* ignore malformed */
    }
  });
} else {
  loadStats();
  connect();
  refreshBoardState();
  setInterval(refreshBoardState, 2000);
  setInterval(refreshSong, 4000);

  // 后台标签恢复时立即补一次，避免浏览器节流后要等下一轮定时器
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    refreshBoardState();
    refreshSong();
    refreshBalance();
    if (!state.eventSource || state.eventSource.readyState === EventSource.CLOSED) connect();
  });

  // 静音音频让 Chromium 把页面当作“正在播放”，降低后台冻结/节流概率。
  // 浏览器要求用户手势后才能启动 AudioContext；点一下页面即可。
  let keepAliveAudio = null;
  const startKeepAlive = () => {
    if (keepAliveAudio) return;
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      ctx.resume().catch(() => {});
      keepAliveAudio = { ctx, osc };
    } catch {
      keepAliveAudio = null;
    }
  };
  document.addEventListener('pointerdown', startKeepAlive, { once: true });
  setTimeout(() => {
    if (!feed.children.length) {
      addFeed({
        type: 'system',
        name: '提示',
        text: '等待弹幕…在扩展里启用「直播背景板」后，这里会实时出现评论和 AI 回复',
      });
    }
  }, 2500);
}

/* ---------- 拾音器：真实麦克风/环境音频谱 ---------- */
(() => {
  const canvas = $('#pickupCanvas');
  const toggle = $('#pickupToggle');
  const stateLabel = $('#pickupState');
  if (!canvas || !toggle || !stateLabel) return;

  const BAR_COUNT = 32;
  const levels = new Array(BAR_COUNT).fill(0);
  let stream = null;
  let audioCtx = null;
  let analyser = null;
  let freqData = null;
  let dpr = 1;
  let raf = 0;
  let ctx2d = null;
  // 渐变按柱高量化缓存，避免每帧为 32 根柱各建一个 CanvasGradient
  const gradientCache = new Map();
  const barHeights = new Array(BAR_COUNT).fill(0);
  let cacheW = 0;
  let cacheH = 0;
  let lastIdleDraw = 0;

  function setState(text, kind = '') {
    stateLabel.textContent = text;
    stateLabel.className = `pickup-state${kind ? ` ${kind}` : ''}`;
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
  }

  function roundBar(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height);
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath();
      ctx.roundRect(x, y, width, height, r);
      ctx.fill();
    } else {
      ctx.fillRect(x, y, width, height);
    }
  }

  function barGradient(left, barHeight, baseline) {
    const step = Math.max(2, 3 * dpr);
    const bucket = Math.max(1, Math.round(barHeight / step));
    const key = `${left ? 'l' : 'r'}${bucket}`;
    let gradient = gradientCache.get(key);
    if (!gradient) {
      gradient = ctx2d.createLinearGradient(0, baseline - bucket * step, 0, baseline);
      gradient.addColorStop(0, left ? 'rgba(43, 125, 233, 0.95)' : 'rgba(96, 165, 250, 0.95)');
      gradient.addColorStop(1, left ? 'rgba(43, 125, 233, 0.2)' : 'rgba(96, 165, 250, 0.2)');
      gradientCache.set(key, gradient);
    }
    return gradient;
  }

  function draw(ts) {
    raf = requestAnimationFrame(draw);
    if (document.hidden) return;
    const width = canvas.width;
    const height = canvas.height;
    if (width < 2 || height < 2) return;
    if (!ctx2d) ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;
    const now = ts || performance.now();
    // 未接入系统音频时只是一点呼吸微动，降到约 20fps，避免常年 60fps 空转重绘
    if (!analyser && now - lastIdleDraw < 48) return;
    lastIdleDraw = now;
    if (cacheW !== width || cacheH !== height) {
      cacheW = width;
      cacheH = height;
      gradientCache.clear();
    }
    const ctx = ctx2d;
    ctx.clearRect(0, 0, width, height);

    if (analyser) {
      analyser.getByteFrequencyData(freqData);
    }
    const gap = Math.max(2 * dpr, width * 0.004);
    const barWidth = Math.max(1, (width - gap * (BAR_COUNT - 1)) / BAR_COUNT);
    const baseline = height - 1;
    const live = Boolean(analyser);

    for (let i = 0; i < BAR_COUNT; i += 1) {
      let level = 0;
      if (analyser) {
        const start = Math.floor(Math.pow(i / BAR_COUNT, 1.65) * freqData.length);
        const end = Math.max(
          start + 1,
          Math.ceil(Math.pow((i + 1) / BAR_COUNT, 1.65) * freqData.length),
        );
        let sum = 0;
        for (let bin = start; bin < end; bin += 1) sum += freqData[bin] || 0;
        level = Math.pow(sum / (end - start) / 255, 0.86);
        level = Math.min(1, level * 1.7);
      } else {
        level = 0.035 + Math.sin(i * 0.7 + Date.now() / 1600) * 0.008;
      }

      levels[i] = level > levels[i] ? level : levels[i] * 0.78 + level * 0.22;
      const barHeight = Math.max(1.5 * dpr, levels[i] * (baseline - 2));
      const x = i * (barWidth + gap);
      const left = i < BAR_COUNT / 2;
      // 外发光改用半透明宽条叠加，替代逐柱 shadowBlur（后者每帧都要做模糊裁切，最耗 CPU）
      if (live) {
        const haloH = barHeight + 6 * dpr;
        const haloW = barWidth + 3.2 * dpr;
        ctx.fillStyle = left ? 'rgba(43, 125, 233, 0.12)' : 'rgba(96, 165, 250, 0.12)';
        roundBar(ctx, x - 1.6 * dpr, baseline - haloH, haloW, haloH, haloW / 2);
      }
      ctx.fillStyle = barGradient(left, barHeight, baseline);
      roundBar(ctx, x, baseline - barHeight, barWidth, barHeight, barWidth / 2);
    }
  }

  async function start() {
    if (stream) {
      stop();
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      setState('浏览器不支持系统音频', 'error');
      return;
    }
    setState('请选择屏幕并勾选分享音频…');
    try {
      const nextStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 5 },
        audio: {
          suppressLocalAudioPlayback: false,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        systemAudio: 'include',
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'exclude',
      });
      const audioTracks = nextStream.getAudioTracks();
      if (!audioTracks.length) {
        nextStream.getTracks().forEach((track) => track.stop());
        setState('请勾选「分享系统音频」后重试', 'error');
        return;
      }
      // 只取系统音频，视频轨不参与分析
      nextStream.getVideoTracks().forEach((track) => track.stop());
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) throw new Error('AudioContext unavailable');
      const nextCtx = new Ctor();
      if (nextCtx.state === 'suspended') await nextCtx.resume();
      const source = nextCtx.createMediaStreamSource(nextStream);
      const nextAnalyser = nextCtx.createAnalyser();
      nextAnalyser.fftSize = 256;
      nextAnalyser.smoothingTimeConstant = 0.82;
      source.connect(nextAnalyser);

      stream = nextStream;
      audioCtx = nextCtx;
      analyser = nextAnalyser;
      freqData = new Uint8Array(nextAnalyser.frequencyBinCount);
      setState('系统音频 LIVE', 'on');
      audioTracks[0].addEventListener('ended', stop);
    } catch (error) {
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
        stream = null;
      }
      if (audioCtx) {
        audioCtx.close().catch(() => {});
        audioCtx = null;
      }
      analyser = null;
      setState(
        error && error.name === 'NotAllowedError' ? '已取消共享 · 点击重试' : '系统音频失败 · 点击重试',
        'error',
      );
    }
  }
  function stop() {
    if (stream) stream.getTracks().forEach((track) => track.stop());
    stream = null;
    if (audioCtx) audioCtx.close().catch(() => {});
    audioCtx = null;
    analyser = null;
    freqData = null;
    setState('共享系统音频');
  }

  toggle.addEventListener('click', start);
  canvas.addEventListener('click', start);
  if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);
  resize();
  draw();


})();
/* ---------- 点歌队列自动滚动 ---------- */
(() => {
  const queue = $('#queue');
  if (!queue) return;
  let holdUntil = 0;
  let last = performance.now();
  let hovering = false;
  let pauseUntil = 0;
  // 1 = 向下滚动，-1 = 向上滚动；滚到边界停留片刻后原路返回，来回往复
  let dir = 1;

  queue.addEventListener('pointerenter', () => {
    hovering = true;
  });
  queue.addEventListener('pointerleave', () => {
    hovering = false;
  });
  queue.addEventListener('wheel', () => {
    pauseUntil = performance.now() + 3000;
  }, { passive: true });
  queue.addEventListener('touchmove', () => {
    pauseUntil = performance.now() + 3000;
  }, { passive: true });

  // 用定时器而不是 requestAnimationFrame：浏览器窗口非全屏或被遮挡时 rAF 会被限流
  function tick() {
    const now = performance.now();
    if (hovering || now < pauseUntil) {
      last = now;
      return;
    }
    const max = queue.scrollHeight - queue.clientHeight;
    if (max <= 2) {
      if (queue.scrollTop !== 0) queue.scrollTop = 0;
      holdUntil = 0;
    } else if (queue.scrollTop >= max - 1) {
      // 到底：停 2.2 秒后往回转，不再闪回开头
      if (!holdUntil) holdUntil = now + 2200;
      else if (now >= holdUntil) {
        dir = -1;
        holdUntil = 0;
        queue.scrollTop = Math.max(0, max - 2);
      }
    } else if (queue.scrollTop <= 1) {
      // 到顶：停 2.2 秒后转回向下
      if (!holdUntil) holdUntil = now + 2200;
      else if (now >= holdUntil) {
        dir = 1;
        holdUntil = 0;
        queue.scrollTop = 2;
      }
    } else {
      holdUntil = 0;
      const dt = Math.min(96, Math.max(0, now - last));
      const next = queue.scrollTop + dir * dt * 0.028;
      queue.scrollTop = Math.max(0, Math.min(max, next));
    }
    last = now;
  }
  setInterval(tick, 32);
})();
/* ---------- 礼物明细 / 送礼人员榜 自动横向滚动 ---------- */
function autoScrollRow(list) {
  if (!list) return;
  let holdUntil = 0;
  let last = performance.now();
  let hovering = false;
  let pauseUntil = 0;

  // 浏览器预览时鼠标悬停或手动滚动先暂停，离开后继续
  list.addEventListener('pointerenter', () => {
    hovering = true;
  });
  list.addEventListener('pointerleave', () => {
    hovering = false;
  });
  // 普通鼠标滚轮在横向列表里也能手动翻看
  list.addEventListener('wheel', (event) => {
    pauseUntil = performance.now() + 3000;
    if (list.scrollWidth <= list.clientWidth + 2) return;
    const delta = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (!delta) return;
    list.scrollLeft += delta;
    event.preventDefault();
  }, { passive: false });
  list.addEventListener('touchmove', () => {
    pauseUntil = performance.now() + 3000;
  }, { passive: true });

  // 用定时器而不是 requestAnimationFrame：浏览器窗口非全屏或被遮挡时 rAF 会被限流，
  // 导致礼物条停住不动
  function tick() {
    const now = performance.now();
    if (hovering || now < pauseUntil) {
      last = now;
      return;
    }
    const max = list.scrollWidth - list.clientWidth;
    if (max <= 2) {
      if (list.scrollLeft !== 0) list.scrollLeft = 0;
      holdUntil = 0;
    } else if (list.scrollLeft >= max - 1) {
      if (!holdUntil) holdUntil = now + 2200;
      else if (now >= holdUntil) {
        list.scrollLeft = 0;
        holdUntil = 0;
      }
    } else {
      holdUntil = 0;
      const dt = Math.min(96, Math.max(0, now - last));
      list.scrollLeft = Math.min(max, list.scrollLeft + dt * 0.024);
    }
    last = now;
  }
  setInterval(tick, 32);
}
autoScrollRow($('#giftList'));
autoScrollRow($('#giftersList'));