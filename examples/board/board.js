const $ = (selector) => document.querySelector(selector);
const feed = $('#feed');
const queueList = $('#queue');
const params = new URLSearchParams(location.search);
// 外部拾音器（/pickup 页面）上报的电平：OBS 浏览器源无法授权共享音频，只能走桥接中转
const pickupRemote = { at: 0, levels: [] };

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
  // 白饭养成：本场送礼累计决定大肥鱼的形态，-1 表示还没渲染过
  growthStage: -1,
  growthCelebrated: false,
};

// 统计持久化：插件更新触发 board_reload 整页刷新后，弹幕/回复/礼物等
// 累计统计从 localStorage 恢复；seenEvents 一并恢复，避免重放事件重复计数
const STATS_KEY = 'board:stats:v1';
const GIFT_STATS_VERSION = 4;
// 房间养成（不分人）：本场累计白饭推着大肥鱼长大，满级触发一次全屏大招
const GROWTH_STAGES = [
  { name: '小鱼', min: 0 },
  { name: '肥鱼', min: 40 },
  { name: '大肥鱼', min: 150 },
  { name: '鲸鱼娘', min: 400 },
];
const GROWTH_KEY = 'board:growth:v1';
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
          // 亲密度等级由插件随礼物事件下发，存档保留，刷新后榜单标识不丢
          level: Math.max(0, Number(value.level) || 0),
          levelTitle: String(value.levelTitle || ''),
          levelColor: String(value.levelColor || ''),
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
  // 清空本场统计等于重新开一场养成：满级大招下一次还能再触发
  state.growthStage = 0;
  state.growthCelebrated = false;
  if (!state.demo) {
    try {
      localStorage.removeItem(GROWTH_KEY);
    } catch {
      /* 存储不可用时只影响重播判断 */
    }
  }
  // 礼物统计清零后，付费气泡同步清空，免费气泡由定时任务重新补充
  if (bubbleQueue) bubbleQueue.clear('gift-reset').catch(() => {});
  $('#giftTotal').textContent = '0';
  renderGifts();
  updateMetrics();
  saveStats();
}
if (params.get('demo') === '1') state.demo = true;

const petSlot = ['center', 'left', 'right', 'none'].includes(params.get('pet'))
  ? params.get('pet')
  : 'center';
document.body.classList.add(`pet-${petSlot}`);
document.body.dataset.petSlot = petSlot;
if (params.get('petDebug') === '1') document.body.classList.add('pet-debug');

// 背景板里的桌宠直接播放 DSH 里那只桌宠的透明动画，不再嵌自建宠物页
const petVideo = document.getElementById('petVideo');
const petNote = document.getElementById('petNote');
const petSay = document.getElementById('petSay');
const petSayText = document.getElementById('petSayText');
const petVoiceAudio = document.getElementById('petVoiceAudio');
const petStage = {
  idle: '',
  clicks: [],
  actions: [],
  idleTimer: 0,
  reactionAt: 0,
  sayTimer: 0,
  talkAt: 0,
};

function playPetAnimation(name, { loop = false } = {}) {
  if (!petVideo || !name) return;
  if (petVideo.dataset.anim === name && petVideo.readyState >= 2) {
    petVideo.loop = loop;
    petVideo.currentTime = 0;
    const replay = petVideo.play();
    if (replay && replay.catch) replay.catch(() => {});
    return;
  }
  petVideo.loop = loop;
  petVideo.dataset.anim = name;
  const fileName = /\.(webm|mov)$/i.test(name) ? name : `${name}.webm`;
  petVideo.src = `/api/dsh-pet/asset?name=${encodeURIComponent(fileName)}`;
  const playing = petVideo.play();
  if (playing && playing.catch) playing.catch(() => {});
}

function playPetIdle() {
  clearTimeout(petStage.idleTimer);
  if (!petStage.idle) return;
  playPetAnimation(petStage.idle, { loop: true });
  schedulePetIdleAction();
}

function schedulePetIdleAction() {
  clearTimeout(petStage.idleTimer);
  if (!petStage.actions.length) return;
  petStage.idleTimer = setTimeout(() => {
    if (document.hidden) {
      schedulePetIdleAction();
      return;
    }
    const name = petStage.actions[Math.floor(Math.random() * petStage.actions.length)];
    playPetAnimation(name);
  }, 16000 + Math.random() * 14000);
}

// 礼物 / 关注时插一段互动动作；连击和刷屏用 6 秒节流压住
function petReact(kind) {
  if (!petVideo || !petStage.idle) return;
  const now = Date.now();
  if (now - petStage.reactionAt < 6000) return;
  const preferred = kind === 'gift'
    ? ['吃白饭', '点击回应-开心跃动', '点击回应-元气挥手']
    : ['点击回应-元气挥手', '点击回应-开心跃动'];
  const name = preferred.find((item) => petStage.clicks.includes(item) || petStage.actions.includes(item))
    || petStage.clicks[0]
    || petStage.actions[0];
  if (!name) return;
  petStage.reactionAt = now;
  playPetAnimation(name);
}

/* ---------- 桌宠气泡与语音：扩展把投喂给 DSH 的话同步到舞台 ---------- */

/** 气泡停留时间至少覆盖字数（约 200ms/字），最长 30 秒；语音念完前不会先消失。 */
function showPetSay(text, durationMs = 0) {
  if (petSlot === 'none') return;
  const content = String(text || '').trim();
  if (!petSay || !petSayText || !content) return;
  petSayText.textContent = content;
  petSay.hidden = false;
  clearTimeout(petStage.sayTimer);
  const ms = Math.min(30000, Math.max(4000, Number(durationMs) || 0, content.length * 200));
  petStage.sayTimer = setTimeout(() => {
    petSay.hidden = true;
  }, ms);
}

/** 说话时随机播一个小动作；比气泡节流更松，避免一句话内反复打断待机。 */
function petTalkAction() {
  if (!petStage.clicks.length || Date.now() - petStage.talkAt < 5000) return;
  petStage.talkAt = Date.now();
  const name = petStage.clicks[Math.floor(Math.random() * petStage.clicks.length)];
  playPetAnimation(name);
}

/** 播放扩展推过来的 MiniMax 音频；同一句只播一次，新语音直接接管旧语音。 */
let petVoicePending = null;

// 气泡和说唱动作都等语音到达后再起：pet_say 先缓存，pet_voice 到了才同一帧播气泡+动作。
// 语音关闭/合成失败时 1 秒后兜底，避免气泡一直不出现。
let petSayPending = null;
let petSayFallback = 0;

function queuePetSay(payload) {
  const text = String(payload.text || '').trim();
  if (!text) return;
  petSayPending = { text, duration: Number(payload.duration) || 0, anim: Boolean(payload.anim) };
  clearTimeout(petSayFallback);
  petSayFallback = setTimeout(() => {
    const pending = petSayPending;
    petSayPending = null;
    if (!pending) return;
    showPetSay(pending.text, pending.duration);
    if (pending.anim) petTalkAction();
  }, 1000);
}

function syncPetSayVoice(payload) {
  clearTimeout(petSayFallback);
  const pending = petSayPending;
  petSayPending = null;
  // 以语音文本为准，保证气泡内容和正在念的内容一致
  const text = String(payload.text || (pending && pending.text) || '').trim();
  if (text) showPetSay(text, Number(payload.duration) || (pending && pending.duration) || 0);
  // 语音真正出声时才切动作，声音和动作不再早半拍
  if (!pending || pending.anim) petTalkAction();
}

function playPetVoice(payload) {
  syncPetSayVoice(payload);
  // 默认不播：扩展已在本机念一遍，OBS 桌面音频就能收进去；背景板再播一遍会叠成重音。
  // 只有显式 ?petVoice=1 才让背景板出声（适合 OBS 没采桌面音频的情况）。
  if (!petVoiceAudio || petSlot === 'none' || params.get('petVoice') !== '1') return;
  const id = String(payload.id || '');
  if (!id) return;
  if (petVoiceAudio.dataset.id === id) return;
  petVoiceAudio.dataset.id = id;
  petVoiceAudio.src = `/api/pet-voice/${encodeURIComponent(id)}`;
  const playing = petVoiceAudio.play();
  if (playing && playing.catch) {
    playing.catch((error) => {
      // 浏览器自动播放策略拦截：记住这句话，等首次点击后再补播
      if (error && error.name === 'NotAllowedError') petVoicePending = payload;
    });
  }
}

if (petVideo) {
  petVideo.addEventListener('ended', playPetIdle);
  petVideo.addEventListener('error', () => {
    if (petVideo.dataset.anim && petVideo.dataset.anim !== petStage.idle) {
      setTimeout(playPetIdle, 1200);
      return;
    }
    if (!state.demo) petNote.hidden = false;
  });
}

async function initDshPetStage() {
  if (!petVideo || petSlot === 'none') return;
  try {
    const response = await fetch('/api/dsh-pet/manifest', { cache: 'no-store' });
    const data = await response.json();
    if (!data || !data.ok || !Array.isArray(data.idle) || !data.idle.length) throw new Error('no dsh pet');
    petStage.idle = String(data.idle[0]);
    petStage.clicks = Array.isArray(data.clicks) ? data.clicks.map(String) : [];
    petStage.actions = Array.isArray(data.actions) ? data.actions.map(String) : [];
    petNote.hidden = true;
    playPetIdle();
  } catch {
    if (!state.demo) petNote.hidden = false;
  }
}

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
  renderGrowth();
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
      level: Math.max(0, Number(item.level) || 0),
      levelTitle: String(item.levelTitle || ''),
      levelColor: String(item.levelColor || ''),
    }));
}

/** 本场累计白饭（碗），与礼物统计同一份差额口径。 */
function growthRiceTotal() {
  let total = 0;
  for (const item of state.giftUsers.values()) {
    total += Math.max(0, Number(item && item.rice) || 0);
  }
  return total;
}

/** 当前白饭总数对应的养成阶段。 */
function growthStageFor(rice) {
  let index = 0;
  for (let i = 0; i < GROWTH_STAGES.length; i += 1) {
    if (rice >= GROWTH_STAGES[i].min) index = i;
  }
  return { index, name: GROWTH_STAGES[index].name, min: GROWTH_STAGES[index].min };
}

/**
 * 养成进度：桌宠头顶常驻显示「小鱼 → 肥鱼 12/40 碗」。
 * 跨过阶段时弹一条系统消息；到鲸鱼娘形态触发一次全屏大招（本地记过就不再重复）。
 */
function renderGrowth() {
  const rice = growthRiceTotal();
  const stage = growthStageFor(rice);
  const next = GROWTH_STAGES[stage.index + 1] || null;
  const textEl = $('#growthText');
  const fillEl = $('#growthFill');
  if (textEl) {
    const label = next
      ? `${stage.name} ${Math.round(rice)}/${next.min} 碗`
      : `${stage.name} 满级 ${Math.round(rice)} 碗`;
    if (textEl.textContent !== label) textEl.textContent = label;
    textEl.classList.toggle('full', !next);
  }
  if (fillEl) {
    const span = next ? Math.max(1, next.min - stage.min) : 1;
    const percent = next ? Math.min(100, Math.max(0, ((rice - stage.min) / span) * 100)) : 100;
    fillEl.style.width = `${percent.toFixed(1)}%`;
  }

  if (state.growthStage < 0) {
    // 首次渲染只记录当前位置，刷新页面不补播历史阶段
    state.growthStage = stage.index;
  } else if (stage.index > state.growthStage) {
    state.growthStage = stage.index;
    addFeed({
      type: 'system',
      name: '养成',
      badge: '成长',
      text: `大肥鱼长大啦！现在是「${stage.name}」形态`,
      ts: Date.now(),
    });
  }
  if (!next) playGrowthCelebrate(rice);
}

/** 满级大招每场只放一次，用 localStorage 记住，刷新后不会重播。 */
function playGrowthCelebrate(rice) {
  if (state.growthCelebrated) return;
  state.growthCelebrated = true;
  // 预览页不写真实存档，免得演示数据把真直播的满级大招标记掉
  if (!state.demo) {
    try {
      localStorage.setItem(GROWTH_KEY, '1');
    } catch {
      /* 存储不可用时只影响重播判断 */
    }
  }
  const box = $('#growthCelebrate');
  if (!box) return;
  const num = $('#growthCelebrateRice');
  if (num) num.textContent = Math.round(rice).toLocaleString('zh-CN');
  box.classList.remove('show');
  void box.offsetWidth; // 强制重排，连续触发时动画能从头上播
  box.classList.add('show');
  setTimeout(() => box.classList.remove('show'), 5800);
}

function loadGrowth() {
  try {
    state.growthCelebrated = localStorage.getItem(GROWTH_KEY) === '1';
  } catch {
    state.growthCelebrated = false;
  }
}

/** 送礼总人数：榜单只展示前 10，标题上的人数要按全部送礼人统计 */
function giftersTotal() {
  let total = 0;
  for (const item of state.giftUsers.values()) {
    if (item && item.name && (Number(item.count) || 0) > 0) total += 1;
  }
  return total;
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
  const level = document.createElement('em');
  level.className = 'gifter-level';
  level.hidden = true;
  const count = document.createElement('strong');
  count.className = 'gifter-count';
  row.append(rank, avatar, name, level, count);
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
  const total = giftersTotal();
  const countEl = $('#giftersCount');
  // 榜单只展示前 10，人数按全部送礼人统计，不能按展示条数
  if (countEl) countEl.textContent = `${total} 人`;

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
    // 亲密度 3 级起才显示 Lv 标识，1-2 级人数多，挂上去反而刷屏
    const levelEl = row.querySelector('.gifter-level');
    if (levelEl) {
      const show = item.level >= 3;
      levelEl.hidden = !show;
      if (show) {
        const levelText = `Lv.${item.level}`;
        if (levelEl.textContent !== levelText) levelEl.textContent = levelText;
        levelEl.style.color = item.levelColor || '';
        levelEl.title = item.levelTitle || '';
      }
    }
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
const BUBBLE_QUEUE_VERSION = '1.16.138';
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
    if (petVoicePending && petVoiceAudio) {
      const payload = petVoicePending;
      petVoicePending = null;
      delete petVoiceAudio.dataset.id;
      playPetVoice(payload);
    }
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

/* ---------------- 互动剧场：旁白 + 四条分支 + 实时票数 ---------------- */
const STORY_CHOICES = ['A', 'B', 'C', 'D'];
let storyCountdownTimer = 0;
let storyCountdownEnd = 0;
let storyCountdownTotal = 0;
let storyWheelKey = '';
let storyCurrentStep = 0;
let storyMaxSteps = 4;
let storyCanvasStep = 0;
let storyCanvasEnding = false;
let storyCanvasAnims = [];

function hideStoryWheel() {
  const wheel = $('#storyWheel');
  if (wheel) wheel.hidden = true;
  storyWheelKey = '';
}

function applyStoryWheel(data) {
  const wheel = $('#storyWheel');
  if (!wheel) return;
  wheel.hidden = false;
  const pointer = $('#storyWheelPointer');
  const tip = $('#storyWheelTip');
  const pressed = String(data.wheelChoice || '').trim().toUpperCase();
  const choice = STORY_CHOICES.includes(pressed) ? pressed : 'A';
  const end = Number(data.wheelEndsAt) || Date.now() + 3400;
  const key = `${Number(data.step) || 0}:${choice}:${end}`;
  const leftMs = Math.max(1500, end - Date.now());
  if (tip) tip.textContent = '平票！轮盘决定剧情…';
  if (!pointer || key === storyWheelKey) return;
  storyWheelKey = key;
  // 四等分轮盘：A/B/C/D 从正上方开始顺时针各占 90°，指针落到对应扇区中心
  const index = Math.max(0, STORY_CHOICES.indexOf(choice));
  const target = index * 90 + 45;
  pointer.style.transition = 'none';
  pointer.style.transform = 'rotate(0deg)';
  void pointer.offsetWidth;
  pointer.style.transition = `transform ${leftMs}ms cubic-bezier(.12,.72,.16,1)`;
  pointer.style.transform = `rotate(${1080 + target}deg)`;
  setTimeout(() => {
    if (!wheel.hidden && tip) tip.textContent = `轮盘停在 ${choice}，剧情继续！`;
  }, leftMs + 120);
}

/* ---------------- 剧场画板：演出期间临时替换点歌队列 ---------------- */
function cancelStoryCanvasAnims() {
  for (const anim of storyCanvasAnims) {
    try {
      anim.cancel();
    } catch {
      /* 已经结束的动画取消时报错可忽略 */
    }
  }
  storyCanvasAnims = [];
}

/** 画板底部的场景/道具说明：留白时整行隐藏，不占画面高度 */
function setStoryCanvasCaption(text) {
  const el = $('#canvasCaption');
  if (!el) return;
  const value = String(text || '').trim();
  el.textContent = value;
  el.hidden = !value;
}

/** 你画我猜画板单独占用点歌队列的位置；和剧场画板不同屏。 */
function setDrawBoardMode(active) {
  const drawCard = $('#drawCard');
  const canvasCard = $('#storyCanvasCard');
  const queueCard = $('#queueCard');
  if (drawCard) drawCard.hidden = !active;
  if (active && canvasCard) canvasCard.hidden = true;
  if (queueCard) queueCard.hidden = active || Boolean(canvasCard && !canvasCard.hidden);
}

function setStoryCanvasMode(active) {
  const canvasCard = $('#storyCanvasCard');
  const drawCard = $('#drawCard');
  const queueCard = $('#queueCard');
  if (canvasCard) canvasCard.hidden = !active;
  if (active && drawCard) drawCard.hidden = true;
  if (queueCard) queueCard.hidden = active || Boolean(drawCard && !drawCard.hidden);
  if (active) return;
  cancelStoryCanvasAnims();
  storyCanvasStep = 0;
  storyCanvasEnding = false;
  setStoryCanvasCaption('');
  const svg = $('#storyCanvasSvg');
  if (svg) {
    // SVG 元素没有 HTMLElement 的 hidden 属性，必须走 attribute 才会被 CSS 隐藏
    svg.setAttribute('hidden', '');
    svg.innerHTML = '';
  }
  const empty = $('#storyCanvasEmpty');
  if (empty) {
    empty.hidden = false;
    empty.textContent = '正在作画…';
  }
}

function showStoryCanvasPending(step, maxSteps, label = '', caption = '') {
  storyCanvasStep = step;
  cancelStoryCanvasAnims();
  const svg = $('#storyCanvasSvg');
  if (svg) {
    svg.setAttribute('hidden', '');
    svg.innerHTML = '';
  }
  const empty = $('#storyCanvasEmpty');
  if (empty) {
    empty.hidden = false;
    empty.textContent = label ? `正在画${label}…` : '正在作画…';
  }
  const badge = $('#canvasStep');
  if (badge) badge.textContent = label || `${step} / ${maxSteps}`;
  setStoryCanvasCaption(caption);
}

function animateStoryCanvas(svgEl) {
  const shapes = [...svgEl.querySelectorAll('path,line,circle,ellipse,rect,polyline,polygon')];
  if (!shapes.length) return;
  // 每笔之间的间隔按元素数量自适应：绘本画面元素更多，整幅画控制在 3.6 秒左右画完
  const gap = Math.max(38, Math.min(100, Math.floor(3600 / shapes.length)));
  let delay = 0;
  for (const shape of shapes) {
    const stroke = shape.getAttribute('stroke');
    const fill = shape.getAttribute('fill');
    const hasStroke = Boolean(stroke && stroke !== 'none' && stroke !== 'transparent');
    const hasFill = Boolean(fill && fill !== 'none' && fill !== 'transparent');
    let length = 0;
    if (hasStroke) {
      try {
        length = shape.getTotalLength();
      } catch {
        length = 0;
      }
    }
    if (hasStroke && length > 0) {
      shape.style.strokeDasharray = `${length}`;
      shape.style.strokeDashoffset = `${length}`;
      storyCanvasAnims.push(shape.animate(
        [{ strokeDashoffset: `${length}` }, { strokeDashoffset: '0' }],
        {
          duration: Math.max(160, Math.min(460, length * 0.8)),
          delay,
          easing: 'ease-in-out',
          fill: 'forwards',
        },
      ));
    }
    if (hasFill) {
      shape.style.opacity = '0';
      storyCanvasAnims.push(shape.animate(
        [{ opacity: 0 }, { opacity: 1 }],
        { duration: 260, delay: delay + 80, easing: 'ease-out', fill: 'forwards' },
      ));
    }
    delay += gap;
  }
}

function drawStoryCanvas(svgText, step, caption = '') {
  const svg = $('#storyCanvasSvg');
  if (!svg) return;
  storyCanvasStep = step;
  cancelStoryCanvasAnims();
  setStoryCanvasCaption(caption);
  // 只把 <svg> 内部的图形塞进画板（外层 svg 自带 viewBox），
  // 嵌套一整个 <svg> 时子 svg 的宽高在 flex 容器里可能算不出来，画面会变成空白
  const body = /<svg[^>]*>([\s\S]*?)<\/svg>/i.exec(svgText);
  svg.innerHTML = body ? body[1] : svgText;
  svg.removeAttribute('hidden');
  const empty = $('#storyCanvasEmpty');
  if (empty) empty.hidden = true;
  // 清掉上一幅画残留的描边动画状态
  for (const shape of svg.querySelectorAll('path,line,circle,ellipse,rect,polyline,polygon')) {
    shape.style.strokeDasharray = '';
    shape.style.strokeDashoffset = '';
    shape.style.opacity = '';
  }
  animateStoryCanvas(svg);
}

function applyStoryCanvas(data = {}) {
  if (!data.active) {
    setStoryCanvasMode(false);
    return;
  }
  const card = $('#storyCanvasCard');
  if (!card) return;
  card.hidden = false;
  const step = Number(data.step) || 0;
  // 迟到或重放中的旧幕画面不能覆盖当前幕
  if (step !== storyCurrentStep) return;
  const ending = Boolean(data.ending);
  // 大结局要重新作画：即使还是最后一幕的步数，也必须先清空上一幕画面
  if (data.pending) {
    if (ending || storyCanvasStep !== step) {
      storyCanvasEnding = ending;
      showStoryCanvasPending(step, storyMaxSteps, ending ? '大结局' : '', data.caption || '');
    } else {
      // applyStory 已经切到本幕的空白画板，这里只补右上角进度以外的场景说明
      setStoryCanvasCaption(data.caption || '');
    }
    return;
  }
  if (!data.svg) return;
  // 结局画面就位后，旧幕的迟到画面不得覆盖它
  if (storyCanvasEnding && !ending) return;
  storyCanvasEnding = ending;
  drawStoryCanvas(data.svg, step, data.caption || '');
  if (ending) {
    const badge = $('#canvasStep');
    if (badge) badge.textContent = '大结局';
  }
}

function startStoryCountdown(endsAt) {
  const end = Number(endsAt) || 0;
  if (storyCountdownTimer) {
    clearInterval(storyCountdownTimer);
    storyCountdownTimer = 0;
  }
  const el = $('#storyCountdown');
  if (!el) return;
  if (!end) {
    el.textContent = '';
    storyCountdownEnd = 0;
    storyCountdownTotal = 0;
    const bar = $('#storyTimerBar');
    if (bar) bar.style.width = '0%';
    const timer = $('#storyTimer');
    if (timer) timer.classList.remove('urgent');
    return;
  }
  // 同一轮投票会反复推送（每张票刷新一次），总时长只在换轮时重置，进度条才不会跳回满格
  if (end !== storyCountdownEnd) {
    storyCountdownEnd = end;
    storyCountdownTotal = Math.max(1000, end - Date.now());
  }
  const tick = () => {
    const leftMs = storyCountdownEnd - Date.now();
    const left = Math.max(0, Math.round(leftMs / 1000));
    el.textContent = left > 0 ? `倒计时 ${left}s` : '开奖中…';
    const bar = $('#storyTimerBar');
    if (bar) {
      const ratio = storyCountdownTotal > 0
        ? Math.min(1, Math.max(0, leftMs / storyCountdownTotal))
        : 0;
      bar.style.width = `${(ratio * 100).toFixed(2)}%`;
    }
    const timer = $('#storyTimer');
    if (timer) timer.classList.toggle('urgent', left > 0 && left <= 5);
    if (left <= 0 && storyCountdownTimer) {
      clearInterval(storyCountdownTimer);
      storyCountdownTimer = 0;
    }
  };
  tick();
  storyCountdownTimer = setInterval(tick, 1000);
}

function applyStory(data = {}) {
  const card = $('#storyCard');
  if (!card) return;
  const column = card.closest('.left-column');
  const node = data.node || null;
  // 剧场期间给 body 挂状态，结束后自动恢复
  const live = Boolean(data.active && node);
  document.body.classList.toggle('story-live', live);
  if (!live) {
    card.hidden = true;
    card.classList.remove('story-ending');
    if (column) column.classList.remove('story-active');
    storyCurrentStep = 0;
    setStoryCanvasMode(false);
    $('#storyOptions').hidden = false;
    $('#storyTimer').hidden = false;
    hideStoryWheel();
    startStoryCountdown(0);
    return;
  }
  card.hidden = false;
  // 演出期间把点歌队列临时换成剧场画板，点歌数据与逻辑保持原样
  storyCurrentStep = Number(data.step) || 0;
  storyMaxSteps = Number(data.maxSteps) || 4;
  setStoryCanvasMode(true);
  // 大结局必须重画：即使步数没变，也先清空上一幕，等结局画面推送过来
  if (storyCanvasStep !== storyCurrentStep) {
    showStoryCanvasPending(storyCurrentStep, storyMaxSteps);
  } else if (data.phase === 'ending' && !storyCanvasEnding) {
    showStoryCanvasPending(storyCurrentStep, storyMaxSteps, '大结局');
  }
  // 剧情进行中把左下角整块让给剧场：隐藏玩法指南，剧情卡撑满剩余空间
  if (column) column.classList.add('story-active');
  $('#storyScene').textContent = [node.scene || data.topic, node.beat].filter(Boolean).join(' · ');
  $('#storyStep').textContent = `${Number(data.step) || 0} / ${Number(data.maxSteps) || 4}`;
  $('#storyLine').textContent = node.narration || '';

  const votes = data.votes || {};
  const counts = STORY_CHOICES.map((choice) => Number(votes[choice.toLowerCase()]) || 0);
  const total = Number(votes.total) || counts.reduce((sum, count) => sum + count, 0);
  // 票数条按四条走向里的最大值归一，零票时都为空
  const max = Math.max(...counts, 1);
  const top = Math.max(...counts);
  STORY_CHOICES.forEach((choice, index) => {
    const key = choice.toLowerCase();
    const textEl = $(`#storyText${choice}`);
    if (textEl) textEl.textContent = node[key] || '';
    const countEl = $(`#storyVotes${choice}`);
    if (countEl) countEl.textContent = `${counts[index]} 票`;
    const meterEl = $(`#storyMeter${choice}`);
    if (meterEl) meterEl.style.width = `${Math.round((counts[index] / max) * 100)}%`;
    const optionEl = $(`#storyOption${choice}`);
    if (optionEl) optionEl.classList.toggle('leading', counts[index] > 0 && counts[index] === top);
  });

  const wheelPhase = data.phase === 'wheel';
  const voting = data.phase === 'voting';
  const endingPhase = data.phase === 'ending';
  // 大结局台词更长，给剧情卡放宽行数
  card.classList.toggle('story-ending', endingPhase);
  $('#storyOptions').hidden = wheelPhase || endingPhase;
  $('#storyTimer').hidden = wheelPhase || endingPhase;
  if (wheelPhase) {
    applyStoryWheel(data);
  } else {
    hideStoryWheel();
  }
  $('#storyHint').textContent = endingPhase
    ? '大结局 · 故事完整落幕'
    : wheelPhase
      ? '平票！轮盘决定剧情'
      : voting
        ? total > 0
          ? `已收到 ${total} 票，发 A / B / C / D 继续投票 · 发「结束剧场」可收场`
          : '发送 A / B / C / D 投票 · 发「结束剧场」可收场'
        : data.title || data.topic
          ? `正在上演「${data.title || data.topic}」`
          : '正在上演';
  startStoryCountdown(voting ? Number(data.voteEndsAt) || 0 : 0);
  if (wheelPhase) {
    const countdown = $('#storyCountdown');
    if (countdown) countdown.textContent = '轮盘转动中…';
  } else if (endingPhase) {
    const countdown = $('#storyCountdown');
    if (countdown) countdown.textContent = '大结局';
  }
}

/* ---------------- 你画我猜：逐笔作画 + 弹幕猜词 ---------------- */

const DRAW_SVG_NS = 'http://www.w3.org/2000/svg';
let drawRoundKey = '';
let drawStrokeCount = 0;
let drawCountdownTimer = 0;
let drawCountdownEndAt = 0;
let drawCountdownMode = '';
let drawCountdownTotal = 5000;

function createDrawStroke(stroke = {}) {
  const kind = stroke.kind || 'path';
  let node = null;
  if (kind === 'circle') {
    node = document.createElementNS(DRAW_SVG_NS, 'circle');
    node.setAttribute('cx', String(Number(stroke.cx) || 0));
    node.setAttribute('cy', String(Number(stroke.cy) || 0));
    node.setAttribute('r', String(Number(stroke.r) || 0));
  } else if (kind === 'ellipse') {
    node = document.createElementNS(DRAW_SVG_NS, 'ellipse');
    node.setAttribute('cx', String(Number(stroke.cx) || 0));
    node.setAttribute('cy', String(Number(stroke.cy) || 0));
    node.setAttribute('rx', String(Number(stroke.rx) || 0));
    node.setAttribute('ry', String(Number(stroke.ry) || 0));
  } else if (kind === 'line') {
    node = document.createElementNS(DRAW_SVG_NS, 'line');
    node.setAttribute('x1', String(Number(stroke.x1) || 0));
    node.setAttribute('y1', String(Number(stroke.y1) || 0));
    node.setAttribute('x2', String(Number(stroke.x2) || 0));
    node.setAttribute('y2', String(Number(stroke.y2) || 0));
  } else {
    if (!stroke.d) return null;
    node = document.createElementNS(DRAW_SVG_NS, 'path');
    node.setAttribute('d', String(stroke.d));
  }
  node.setAttribute('fill', String(stroke.fill || 'none'));
  node.setAttribute('stroke', stroke.stroke === 'none' ? 'none' : String(stroke.stroke || '#17324f'));
  node.setAttribute('stroke-width', String(Number(stroke.width) || 6));
  node.setAttribute('stroke-linecap', 'round');
  node.setAttribute('stroke-linejoin', 'round');
  if (stroke.opacity != null) node.setAttribute('opacity', String(Number(stroke.opacity)));
  if (stroke.transform) node.setAttribute('transform', String(stroke.transform));
  return node;
}

/** 新揭晓的一笔：描边从零画出来，填充色随后淡入，形成「笔一笔画」的观感 */
function animateDrawStroke(shape, stroke = {}) {
  if (!shape) return;
  const fill = String(stroke.fill || 'none').toLowerCase();
  const strokeColor = String(stroke.stroke === undefined ? '#17324f' : stroke.stroke).toLowerCase();
  const finalOpacity = stroke.opacity != null ? Number(stroke.opacity) : 1;
  if (fill !== 'none' && fill) {
    shape.style.opacity = '0';
    shape.animate(
      [{ opacity: 0 }, { opacity: finalOpacity }],
      { duration: 480, easing: 'ease-out', fill: 'forwards' },
    );
  } else {
    shape.style.opacity = String(finalOpacity);
  }
  if (strokeColor !== 'none' && typeof shape.getTotalLength === 'function') {
    try {
      const length = shape.getTotalLength();
      if (length > 0 && Number.isFinite(length)) {
        shape.style.strokeDasharray = `${length}`;
        shape.style.strokeDashoffset = `${length}`;
        shape.animate(
          [{ strokeDashoffset: `${length}` }, { strokeDashoffset: '0' }],
          { duration: 420, easing: 'ease-out', fill: 'forwards' },
        );
        setTimeout(() => {
          shape.style.strokeDasharray = '';
          shape.style.strokeDashoffset = '';
        }, 460);
      }
    } catch {
      /* 某些浏览器对非路径元素取长度会抛错，忽略即可 */
    }
  }
}

function renderDrawGuesses(guesses = []) {
  const list = $('#drawGuesses');
  if (!list) return;
  list.innerHTML = '';
  for (const guess of guesses.slice(-6)) {
    const item = document.createElement('li');
    if (guess.hit) item.className = 'hit';
    const name = document.createElement('b');
    name.textContent = String(guess.name || '观众');
    const text = document.createElement('span');
    text.textContent = String(guess.text || '');
    item.append(name, text);
    list.appendChild(item);
  }
}

function renderDrawScores(scores = []) {
  const box = $('#drawScores');
  if (!box) return;
  box.innerHTML = '';
  if (!scores.length) {
    const empty = document.createElement('span');
    empty.textContent = '本场还没有人得分';
    box.appendChild(empty);
    return;
  }
  for (const item of scores.slice(0, 5)) {
    const chip = document.createElement('span');
    const name = document.createElement('em');
    name.style.fontStyle = 'normal';
    name.textContent = String(item.name || '观众');
    const score = document.createElement('b');
    score.textContent = `${Number(item.score) || 0}分`;
    chip.append(name, score);
    box.appendChild(chip);
  }
}

function stopDrawCountdown(text = '') {
  if (drawCountdownTimer) {
    clearInterval(drawCountdownTimer);
    drawCountdownTimer = 0;
  }
  drawCountdownEndAt = 0;
  drawCountdownMode = '';
  const label = $('#drawCountdown');
  if (label) label.textContent = text;
  const bar = $('#drawTimerBar');
  if (bar) bar.style.width = '0%';
  const timer = $('#drawTimer');
  if (timer) timer.classList.remove('urgent');
}

function startDrawCountdown(endsAt, mode, totalMs) {
  const end = Number(endsAt) || 0;
  if (!end) {
    stopDrawCountdown();
    return;
  }
  // 同一轮会因猜词/计分反复推送，结束时间不变时不重置，进度条不会跳回满格
  if (end === drawCountdownEndAt && mode === drawCountdownMode) return;
  drawCountdownEndAt = end;
  drawCountdownMode = mode;
  drawCountdownTotal = mode === 'guess'
    ? Math.max(1000, Number(totalMs) || 60000)
    : Math.max(1000, end - Date.now());
  if (drawCountdownTimer) clearInterval(drawCountdownTimer);
  const label = $('#drawCountdown');
  const bar = $('#drawTimerBar');
  const timer = $('#drawTimer');
  const tick = () => {
    const leftMs = drawCountdownEndAt - Date.now();
    const left = Math.max(0, Math.ceil(leftMs / 1000));
    if (label) {
      label.textContent = mode === 'guess'
        ? (left > 0 ? `剩余 ${left} 秒` : '开奖中…')
        : (left > 0 ? `下一题 ${left} 秒` : '准备下一题…');
    }
    if (bar) {
      const ratio = Math.min(1, Math.max(0, leftMs / drawCountdownTotal));
      bar.style.width = `${(ratio * 100).toFixed(1)}%`;
    }
    if (timer) timer.classList.toggle('urgent', mode === 'guess' && leftMs <= 10000);
  };
  tick();
  drawCountdownTimer = setInterval(tick, 1000);
}

function applyDrawGuess(data = {}) {
  const card = $('#drawCard');
  if (!card) return;
  const live = Boolean(data.active && data.phase !== 'closed');
  setDrawBoardMode(live);
  if (!live) {
    drawRoundKey = '';
    drawStrokeCount = 0;
    const svg = $('#drawSvg');
    if (svg) svg.innerHTML = '';
    stopDrawCountdown();
    return;
  }

  $('#drawCategory').textContent = data.category ? `题材 · ${data.category}` : '简笔画';
  $('#drawRound').textContent = `第 ${Number(data.round) || 1} / ${Number(data.maxRounds) || 1} 题`;

  const word = $('#drawWord');
  if (word) {
    word.textContent = data.answer || data.blank || '';
    word.classList.toggle('won', Boolean(data.answer));
  }

  const hint = $('#drawHint');
  if (hint) {
    if (data.hint) {
      hint.textContent = `提示：${data.hint}`;
      hint.className = 'draw-hint-text';
    } else if (data.phase === 'drawing') {
      hint.textContent = '桌宠正在作画，画完才能猜…';
      hint.className = 'draw-hint-text';
    } else if (data.phase === 'won') {
      hint.textContent = data.winner ? `「${data.winner.name}」+${Number(data.winner.score) || 0} 分` : '已猜中';
      hint.className = 'draw-hint-text';
    } else if (data.phase === 'revealed') {
      hint.textContent = '这题先公布答案，下一题马上来';
      hint.className = 'draw-hint-text';
    } else {
      hint.textContent = data.hintAvailable ? '实在猜不到就发「提示」' : '';
      hint.className = 'draw-hint-text';
    }
  }

  const answer = $('#drawAnswer');
  if (answer) {
    answer.hidden = !data.answer;
    if (data.answer) answer.textContent = `答案 · ${data.answer}`;
  }

  const key = `${data.gameId || ''}:${Number(data.round) || 0}:${data.wordId || ''}`;
  if (key !== drawRoundKey) {
    drawRoundKey = key;
    drawStrokeCount = 0;
    const svg = $('#drawSvg');
    if (svg) svg.innerHTML = '';
  }
  const svg = $('#drawSvg');
  const strokes = Array.isArray(data.strokes) ? data.strokes : [];
  const empty = $('#drawEmpty');
  if (svg && strokes.length) {
    svg.removeAttribute('hidden');
    if (empty) empty.hidden = true;
    for (let index = drawStrokeCount; index < strokes.length; index += 1) {
      const shape = createDrawStroke(strokes[index]);
      if (!shape) continue;
      svg.appendChild(shape);
      animateDrawStroke(shape, strokes[index]);
    }
    drawStrokeCount = Math.max(drawStrokeCount, strokes.length);
  } else if (svg) {
    svg.setAttribute('hidden', '');
    if (empty) {
      empty.hidden = false;
      empty.textContent = data.phase === 'drawing' ? '桌宠正在铺画纸…' : '等桌宠落笔…';
    }
  }

  renderDrawGuesses(Array.isArray(data.guesses) ? data.guesses : []);
  renderDrawScores(Array.isArray(data.scores) ? data.scores : []);

  if (data.phase === 'guessing' && data.guessEndsAt) {
    startDrawCountdown(data.guessEndsAt, 'guess', (Number(data.roundSec) || 60) * 1000);
  } else if ((data.phase === 'won' || data.phase === 'revealed') && data.nextAt) {
    startDrawCountdown(data.nextAt, 'next', 5000);
  } else if (data.phase === 'drawing') {
    stopDrawCountdown('作画中…');
  } else {
    stopDrawCountdown();
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
    applyDrawGuess({ active: false });
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
  if (payload.kind === 'story') {
    applyStory(payload.data || {});
    return;
  }
  if (payload.kind === 'story_canvas') {
    applyStoryCanvas(payload.data || {});
    return;
  }
  if (payload.kind === 'draw_guess') {
    applyDrawGuess(payload.data || {});
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

  if (payload.kind === 'intimacy_up') {
    // 插件播报观众亲密度升级：弹幕区提示一次，同时把送礼榜里同名用户的等级同步过来
    const data = payload.data || {};
    const name = String(data.name || '').trim();
    const level = Math.max(0, Number(data.level) || 0);
    if (name && level) {
      addFeed({
        type: 'system',
        name,
        badge: `Lv.${level}`,
        text: `亲密度升级 · ${String(data.title || '')}`,
        ts: Date.now(),
      });
      for (const person of state.giftUsers.values()) {
        if (person && person.name === name) {
          person.level = level;
          person.levelTitle = String(data.title || '');
          person.levelColor = String(data.color || '');
        }
      }
      renderGifters();
      saveStats();
    }
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

  // 桌宠气泡：插件把投喂给 DSH 的同一句话同步过来；断线重放不重复弹
  if (payload.kind === 'pet_say') {
    if (payload.replay) return;
    queuePetSay(payload);
    return;
  }

  // 桌宠语音：音频已由插件推进桥接，这里取对应 id 播放，并对齐气泡与动作
  if (payload.kind === 'pet_voice') {
    if (payload.replay) return;
    playPetVoice(payload);
    return;
  }

  // 外部拾音器电平：只更新缓存，拾音器模块自己按新鲜度取用
  if (payload.kind === 'pickup') {
    const levels = payload.data && payload.data.levels;
    if (Array.isArray(levels)) {
      pickupRemote.levels = levels;
      pickupRemote.at = Number(payload.at) || Date.now();
    }
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
      // 亲密度等级跟礼物一起带过来（插件已脱敏后的展示名），榜单上直接显示
      const badge = event.intimacy;
      if (badge && Number(badge.level)) {
        person.level = Math.max(0, Number(badge.level) || 0);
        person.levelTitle = String(badge.title || '');
        person.levelColor = String(badge.color || '');
      }
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
    petReact('gift');
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
    petReact('follow');
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
    // 进场人数多时会把弹幕聊天刷屏：只记录观众，不往聊天面板写进场条目
    rememberViewer(event.user, event.ts || Date.now());
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
  // 演示数据带上亲密度等级，预览页能直接看到送礼榜的 Lv 标识
  state.giftUsers = new Map([
    ['demo-u1', { name: '小鹿', avatar: '', count: 3, rice: 3, level: 5, levelTitle: '老饭友', levelColor: '#52a4f7' }],
    ['demo-u2', { name: '糖糖', avatar: '', count: 6, rice: 6, level: 7, levelTitle: '专属饲养员', levelColor: '#ffc531' }],
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
// 背景板桌宠：连上 DSH 后播放它那只桌宠的待机动画
initDshPetStage();
refreshSong();
refreshBalance();
loadGrowth();
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
  // 外部拾音器（普通浏览器里的 /pickup 页面）是否正在推电平；OBS 里只能靠这个
  let remoteLabelOn = false;
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
    // 本页采集优先；没有授权时改用外部拾音器推来的电平（1.5 秒没更新即视为断开）
    const remoteLive = pickupRemote.levels.length > 0 && Date.now() - pickupRemote.at < 1500;
    if (!stream && remoteLive !== remoteLabelOn) {
      remoteLabelOn = remoteLive;
      if (remoteLive) setState('系统音频 LIVE（外部拾音）', 'on');
      else setState('共享系统音频');
    }
    const gap = Math.max(2 * dpr, width * 0.004);
    const barWidth = Math.max(1, (width - gap * (BAR_COUNT - 1)) / BAR_COUNT);
    const baseline = height - 1;
    const live = Boolean(analyser) || remoteLive;

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
      } else if (remoteLive) {
        level = Math.min(1, Math.max(0, Number(pickupRemote.levels[i]) || 0));
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
      setState('OBS 无法授权 · 浏览器打开 /pickup 拾音', 'error');
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
        error && error.name === 'NotAllowedError'
          ? '已取消共享 · 点击重试'
          : '拾音失败 · 浏览器打开 /pickup',
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

  // 向桥接要一次外部拾音电平，之后靠 SSE 实时推送；轮询只作断线兜底
  async function refreshRemote() {
    try {
      const response = await fetch('/api/pickup/state', { cache: 'no-store' });
      const data = await response.json();
      if (data && data.ok && Array.isArray(data.levels) && data.levels.length) {
        pickupRemote.levels = data.levels;
        pickupRemote.at = Number(data.at) || 0;
      }
    } catch {
      /* 桥接没启动时保持本地拾音 */
    }
  }
  refreshRemote();
  setInterval(refreshRemote, 3000);

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