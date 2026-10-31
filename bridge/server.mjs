/**
 * 抖音直播 ↔ 桌宠 本地桥接服务（零依赖）。
 *
 * 扩展把弹幕 / 礼物 / AI 回复 POST 到 /event，桌宠通过 /events 的 SSE 实时接收；
 * 桌宠把动作或回复指令 POST 到 /command，扩展通过 /commands 的 SSE 接收。
 *
 * 只监听 127.0.0.1，不对外网开放。
 *
 * 启动：node bridge/server.mjs
 * 参考桌宠：http://127.0.0.1:8787/pet
 */
import http from 'node:http';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSongManager } from './song.mjs';
import { createMemoryStore } from './memory.mjs';
import { createUserLedger } from './userLedger.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PET_DIR = path.resolve(HERE, '../examples/pet');
const BOARD_DIR = path.resolve(HERE, '../examples/board');
const memory = createMemoryStore({ file: path.resolve(HERE, 'memory.json') });
// 观众行为留证台账：append-only 哈希链，用户否认访问时可调取时间线证据
const userLedger = createUserLedger({ file: path.resolve(HERE, 'user-ledger.jsonl') });
// 插件「运行记录」实时落盘，便于排查线上问题（扩展侧只存在内存里，刷新即清）
const APP_LOG_FILE = path.resolve(HERE, 'app.log');
const APP_LOG_MAX = 5 * 1024 * 1024;
const MAX_BODY = 1024 * 1024;
export const BRIDGE_VERSION = '1.16.83';
// 演示页名单的有效期：预览页每 5s 续期一次，关闭后 15s 内失效，不影响真实直播
const DEMO_ROSTER_TTL_MS = 15000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('payload too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function openStream(req, res, clients) {
  res.writeHead(200, {
    ...CORS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  clients.add(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 15000);

  const cleanup = () => {
    clearInterval(heartbeat);
    clients.delete(res);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
}

function sendEvent(res, payload) {
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    /* client gone */
  }
}

/* ---------------- DSH 桌宠端口发现 ---------------- */
// DSH 每次启动都会换一个随机本地端口，写死在扩展里的地址迟早失效。
// 这里扫描本机正在监听的端口，逐个探测 dsh-pet 插件的固定路由，找到就返回。
const DSH_PET_CONFIG_ROUTE = '/dsh-pet-7340/config';
let dshPetBaseUrlCache = '';

function listListeningPorts() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }
        const ports = new Set();
        for (const line of String(stdout).split(/\r?\n/)) {
          const match = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING/i);
          if (match) ports.add(Number(match[1]));
        }
        resolve([...ports]);
      });
      return;
    }
    execFile('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n'], { timeout: 5000 }, (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }
      const ports = new Set();
      for (const line of String(stdout).split(/\r?\n/)) {
        const match = line.match(/:(\d+)\s+\(LISTEN\)/);
        if (match) ports.add(Number(match[1]));
      }
      resolve([...ports]);
    });
  });
}

async function probeDshPetPort(port, timeoutMs = 1200) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${DSH_PET_CONFIG_ROUTE}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return '';
    const data = await response.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) return '';
    // 配置结构是「宠物 id -> 宠物配置」，至少要有一个对象值才算命中
    const pets = Object.values(data).filter((item) => item && typeof item === 'object' && !Array.isArray(item));
    return pets.length ? `http://127.0.0.1:${port}` : '';
  } catch {
    return '';
  }
}

function portFromHint(hint) {
  const text = String(hint || '').trim();
  if (!text) return 0;
  const match = text.match(/^(\d{1,5})$/) || text.match(/:(\d{1,5})\/?\s*$/);
  const port = Number(match && match[1]);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
}

export async function discoverDshPetBaseUrl(options = {}) {
  const exclude = new Set((options.excludePorts || []).map(Number));
  const cachedPort = portFromHint(dshPetBaseUrlCache);
  if (cachedPort && !exclude.has(cachedPort)) {
    const found = await probeDshPetPort(cachedPort, 1000);
    if (found) return found;
    dshPetBaseUrlCache = '';
  }
  const hintPort = portFromHint(options.hint);
  if (hintPort && (await probeDshPetPort(hintPort, 1500))) {
    dshPetBaseUrlCache = `http://127.0.0.1:${hintPort}`;
    return dshPetBaseUrlCache;
  }
  const ports = (await listListeningPorts())
    .filter((port) => port >= 1024 && !exclude.has(port) && port !== hintPort && port !== cachedPort)
    .sort((a, b) => a - b);
  if (!ports.length) return '';
  // 并发探测，命中任何一个就返回（DSH 可能同时监听多个网卡）
  const results = await Promise.all(ports.map((port) => probeDshPetPort(port)));
  const hit = results.find(Boolean);
  if (!hit) return '';
  dshPetBaseUrlCache = hit;
  return hit;
}

export function createBridgeServer(options = {}) {
  const host = options.host || '127.0.0.1';
  const port = options.port ?? 8787;
  const eventClients = new Set();
  const commandClients = new Set();
  const history = [];
  const commandHistory = [];
  let lastEventAt = 0;
  let lastCommandAt = 0;
  let sequence = 0;
  let lastBalance = null;
  let lastStatus = null;
  // 气泡流名单：由背景板按「累计白饭 ≥ 阈值」实时下发，插件据此匹配「甩飞 XXX」目标
  // 演示页（?demo=1）单独存放，只在真实名单为空时兜底，避免预览数据顶掉直播数据
  let lastBubbles = null;
  let lastDemoBubbles = null;
  let lastGiftResetAt = 0;

  function broadcastEvent(input) {
    sequence += 1;
    const payload = {
      ...input,
      id: input.id || `evt-${Date.now()}-${sequence}`,
      at: Number(input.at) || Date.now(),
    };
    if (payload.kind === 'balance') lastBalance = payload.data || null;
    if (payload.kind === 'status') lastStatus = payload.data || null;
    // 气泡流名单只做状态存储，不进入事件流：名单会频繁刷新，广播会淹没弹幕事件
    if (payload.kind === 'bubble_roster') {
      const data = payload.data || null;
      // 演示名单带时间戳，关闭预览页后很快过期，避免真实直播误匹配到演示用户
      if (data && data.demo) lastDemoBubbles = { ...data, at: payload.at };
      else lastBubbles = data;
      lastEventAt = payload.at;
      return payload;
    }
    // 礼物清空走持久化时间戳：SSE 断线时背景板靠 2 秒兜底轮询也能收到清空动作
    if (payload.kind === 'gift_reset') lastGiftResetAt = payload.at;
    lastEventAt = payload.at;
    // reload 不进 replay，否则重连时会反复触发整页刷新导致白屏
    if (payload.kind !== 'board_reload') {
      history.push(payload);
      while (history.length > 60) history.shift();
    }
    for (const client of eventClients) sendEvent(client, payload);
    return payload;
  }

  const song = createSongManager({
    emit: (payload) => broadcastEvent(payload),
    externalWatch: true,
    persistPath: path.join(HERE, 'song-state.json'),
    violationPath: path.join(HERE, 'song-violations.json'),
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = decodeURIComponent(url.pathname);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }

    if (req.method === 'GET' && (pathname === '/' || pathname === '/pet' || pathname === '/pet/')) {
      res.writeHead(302, { Location: '/pet/pet.html', ...CORS });
      res.end();
      return;
    }

    if (req.method === 'GET' && (pathname === '/board' || pathname === '/board/')) {
      // 保留查询参数：demo/transparent/pet/layout 等都需要透传到真实页面
      res.writeHead(302, { Location: `/board/board.html${url.search}`, ...CORS });
      res.end();
      return;
    }

    if (req.method === 'GET' && (pathname === '/board/vertical' || pathname === '/vertical')) {
      res.writeHead(302, { Location: '/board/board.html?layout=vertical&pet=center', ...CORS });
      res.end();
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/board/')) {
      const name = path.basename(pathname);
      if (!['board.html', 'board.css', 'board.js', 'bubbleQueue.js', 'giftCombo.js', 'rice.png', 'pet-cd.jpg', 'pet-cd-label.jpg', 'gifts.json'].includes(name)) {
        json(res, 404, { ok: false, error: 'not found' });
        return;
      }
      try {
        const file = await readFile(path.join(BOARD_DIR, name));
        res.writeHead(200, {
          ...CORS,
          'Content-Type': MIME[path.extname(name)] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
        });
        res.end(file);
      } catch {
        json(res, 404, { ok: false, error: 'board not found' });
      }
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/pet/')) {
      const name = path.basename(pathname);
      if (!['pet.html', 'pet.css', 'pet.js'].includes(name)) {
        json(res, 404, { ok: false, error: 'not found' });
        return;
      }
      try {
        const file = await readFile(path.join(PET_DIR, name));
        res.writeHead(200, {
          ...CORS,
          'Content-Type': MIME[path.extname(name)] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
        });
        res.end(file);
      } catch {
        json(res, 404, { ok: false, error: 'pet file missing' });
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/health') {
      json(res, 200, {
        ok: true,
        service: 'dy-live-companion-pet-bridge',
        eventClients: eventClients.size,
        commandClients: commandClients.size,
        lastEventAt,
        lastCommandAt,
      });
      return;
    }

    // DSH 桌宠当前端口：扩展连接失败时来这里自动换地址
    if (req.method === 'GET' && pathname === '/api/dsh-pet/discover') {
      try {
        const found = await discoverDshPetBaseUrl({
          hint: url.searchParams.get('hint') || '',
          excludePorts: [port],
        });
        if (found) json(res, 200, { ok: true, baseUrl: found, port: portFromHint(found) });
        else json(res, 200, { ok: false, error: '未找到 DSH 桌宠接口（DSH 可能没有启动）' });
      } catch (error) {
        json(res, 500, { ok: false, error: error.message });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/cache/clear') {
      history.length = 0;
      lastStatus = null;
      lastBalance = null;
      lastEventAt = 0;
      song.clearAllCache();
      broadcastEvent({ kind: 'cache_clear', at: Date.now() });
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && pathname === '/api/shutdown') {
      try {
        writeFileSync(path.join(HERE, 'service-off.lock'), new Date().toISOString(), 'utf8');
      } catch {
        /* ignore */
      }
      json(res, 200, { ok: true, stopping: true });
      setTimeout(() => {
        try { server.close(); } catch { /* ignore */ }
        process.exit(0);
      }, 120);
      return;
    }
    if (req.method === 'GET' && pathname === '/status') {
      json(res, 200, {
        ok: true,
        version: BRIDGE_VERSION,
        songProtocol: 2,
        eventClients: eventClients.size,
        commandClients: commandClients.size,
        lastEventAt,
        lastCommandAt,
        recentEvents: history.slice(-5).map((item) => ({ id: item.id, kind: item.kind, at: item.at })),
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/events') {
      openStream(req, res, eventClients);
      const replay = Number(url.searchParams.get('replay') || 0);
      if (replay > 0) {
        for (const item of history.slice(-Math.min(replay, 30))) {
          sendEvent(res, { ...item, replay: true });
        }
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/commands') {
      openStream(req, res, commandClients);
      return;
    }

    if (req.method === 'POST' && pathname === '/event') {
      let body;
      try {
        body = await readJson(req);
      } catch (error) {
        json(res, 400, { ok: false, error: error.message });
        return;
      }
      if (!body || typeof body !== 'object' || !body.kind) {
        json(res, 400, { ok: false, error: 'kind is required' });
        return;
      }
      const payload = broadcastEvent(body);
      json(res, 200, { ok: true, delivered: eventClients.size, id: payload.id });
      return;
    }

    if (req.method === 'POST' && pathname === '/command') {
      let body;
      try {
        body = await readJson(req);
      } catch (error) {
        json(res, 400, { ok: false, error: error.message });
        return;
      }
      if (!body || typeof body.action !== 'string' || !body.action) {
        json(res, 400, { ok: false, error: 'action is required' });
        return;
      }
      sequence += 1;
      const payload = {
        id: `cmd-${Date.now()}-${sequence}`,
        at: Date.now(),
        ...body,
      };
      lastCommandAt = payload.at;
      commandHistory.push(payload);
      while (commandHistory.length > 40) commandHistory.shift();

      for (const client of commandClients) sendEvent(client, payload);
      json(res, 200, {
        ok: true,
        delivered: commandClients.size,
        id: payload.id,
        hint: commandClients.size ? '' : '直播助手未连接：请打开扩展侧边栏并启用桌宠联动',
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/board/state') {
      // 气泡流名单（仅含累计白饭达到阈值的前 N 位）：甩飞指令的用户匹配只认这份列表
      const realBubbles = Array.isArray(lastBubbles && lastBubbles.bubbles) ? lastBubbles.bubbles : [];
      const demoFresh = Boolean(
        lastDemoBubbles && Date.now() - (Number(lastDemoBubbles.at) || 0) <= DEMO_ROSTER_TTL_MS,
      );
      const demoBubbles = demoFresh && Array.isArray(lastDemoBubbles.bubbles)
        ? lastDemoBubbles.bubbles
        : [];
      // 真实背景板还没有人送礼时，用演示页名单兜底，保证预览页可以演练甩飞
      const useDemo = !realBubbles.length && demoBubbles.length > 0;
      const source = useDemo ? lastDemoBubbles : lastBubbles;
      json(res, 200, {
        ok: true,
        version: BRIDGE_VERSION,
        at: Date.now(),
        recentEvents: history.slice(-30),
        giftResetAt: lastGiftResetAt,
        song: song.snapshot(),
        balance: lastBalance,
        status: lastStatus,
        bubbles: useDemo ? demoBubbles : realBubbles,
        bubbleThreshold: Number(source && source.threshold) || 0,
        bubbleMax: Number(source && source.max) || 0,
        bubbleSource: useDemo ? 'demo' : 'real',
        // 诊断：背景板本轮统计人数与达到白饭门槛的人数
        bubbleUsers: Number(source && source.users) || 0,
        bubbleRiceUsers: Number(source && source.riceUsers) || 0,
        // 诊断：背景板礼物件数明细与送礼人白饭，用于核对统计是否失真
        giftTypes: (source && source.giftTypes) || [],
        gifters: (source && source.gifters) || [],
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/song/state') {
      json(res, 200, { ...song.snapshot(), bridgeVersion: BRIDGE_VERSION });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/balance') {
      json(res, 200, { ok: true, data: lastBalance });
      return;
    }

    // 插件运行记录：实时追加到 bridge/app.log，供排查问题
    if (req.method === 'POST' && pathname === '/api/log') {
      let body;
      try {
        body = await readJson(req);
      } catch {
        json(res, 400, { ok: false });
        return;
      }
      const entry = (body && body.entry) || body || {};
      const stamp = entry.ts ? new Date(Number(entry.ts)).toISOString() : new Date().toISOString();
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const detail = clean(entry.detail);
      const line = `${stamp} [${clean(entry.kind) || 'info'}] ${clean(entry.text)}${detail ? ` | ${detail}` : ''}\n`;
      try {
        appendFileSync(APP_LOG_FILE, line, 'utf8');
        if (statSync(APP_LOG_FILE).size > APP_LOG_MAX) {
          // 超过上限时保留后半段，避免无限增长
          const text = readFileSync(APP_LOG_FILE, 'utf8');
          writeFileSync(APP_LOG_FILE, text.slice(-Math.floor(APP_LOG_MAX / 2)), 'utf8');
        }
      } catch {
        /* 写盘失败不影响插件主流程 */
      }
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && pathname === '/api/log') {
      const limit = Math.min(
        2000,
        Math.max(1, Number(new URL(req.url, 'http://x').searchParams.get('limit')) || 300),
      );
      let lines = [];
      try {
        lines = readFileSync(APP_LOG_FILE, 'utf8').split('\n').filter(Boolean).slice(-limit);
      } catch {
        /* 还没有日志文件 */
      }
      json(res, 200, { ok: true, lines });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/memory') {
      json(res, 200, await memory.list(new URL(req.url, 'http://x').searchParams.get('limit')));
      return;
    }

    if (req.method === 'POST' && pathname === '/api/memory') {
      let body;
      try {
        body = await readJson(req);
      } catch (error) {
        json(res, 400, { ok: false, error: error.message });
        return;
      }
      const result = await memory.add(body);
      json(res, result.ok ? 200 : 400, result);
      return;
    }

    // 观众行为留证：按 id / 昵称查询完整时间线，并附带哈希链校验结果
    if (req.method === 'GET' && pathname === '/api/ledger') {
      const params = new URL(req.url, 'http://x').searchParams;
      const result = userLedger.query(params.get('user'), params.get('limit'));
      json(res, 200, {
        ...(result || { ok: true, total: 0, user: null, entries: [] }),
        verified: userLedger.verify().ok,
      });
      return;
    }

    // 台账哈希链校验：返回是否被篡改 / 删改
    if (req.method === 'GET' && pathname === '/api/ledger/verify') {
      json(res, 200, userLedger.verify());
      return;
    }

    // 追加自定义留证动作（点歌、记忆声明、误判记录等）
    if (req.method === 'POST' && pathname === '/api/ledger/event') {
      let body;
      try {
        body = await readJson(req);
      } catch (error) {
        json(res, 400, { ok: false, error: error.message });
        return;
      }
      const record = userLedger.append(body);
      json(res, record ? 200 : 400, record ? { ok: true, seq: record.seq, hash: record.hash } : { ok: false, error: 'user and action are required' });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/song/request') {
      let body;
      try {
        body = await readJson(req);
      } catch (error) {
        json(res, 400, { ok: false, error: error.message });
        return;
      }
      const result = await song.request({
        query: body.query,
        user: body.user,
        userKey: body.userKey,
        provider: body.provider,
        cooldownSec: body.cooldownSec,
        minPlaySec: body.minPlaySec,
        queueCutSec: body.queueCutSec,
        dailyRecommend: body.dailyRecommend,
        priority: body.priority,
        forcePlay: body.forcePlay,
      });
      json(res, result.ok ? 200 : 400, result);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/song/cut') {
      let body;
      try {
        body = await readJson(req);
      } catch (error) {
        json(res, 400, { ok: false, error: error.message });
        return;
      }
      json(res, 200, await song.cut({ user: body.user, userKey: body.userKey }));
      return;
    }

    if (req.method === 'POST' && pathname === '/api/song/prioritize') {
      let body;
      try {
        body = await readJson(req);
      } catch (error) {
        json(res, 400, { ok: false, error: error.message });
        return;
      }
      json(res, 200, song.prioritizeUserQueue({ user: body.user, userKey: body.userKey }));
      return;
    }
    if (req.method === 'POST' && pathname === '/api/song/moderate') {
      let body;
      try {
        body = await readJson(req);
      } catch (error) {
        json(res, 400, { ok: false, error: error.message });
        return;
      }
      const result = await song.moderateSong(body || {});
      json(res, result.ok ? 200 : 400, result);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/song/purge') {
      json(res, 200, song.purgeHorror());
      return;
    }
    if (req.method === 'POST' && pathname === '/api/song/skip') {
      json(res, 200, await song.skip());
      return;
    }

    if (req.method === 'POST' && pathname === '/api/song/pause') {
      json(res, 200, await song.pause());
      return;
    }

    if (req.method === 'POST' && pathname === '/api/song/volume') {
      let body;
      try {
        body = await readJson(req);
      } catch (error) {
        json(res, 400, { ok: false, error: error.message });
        return;
      }
      const result = await song.setVolume(body);
      json(res, result.ok ? 200 : 400, result);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/song/clear') {
      json(res, 200, song.clearQueue());
      return;
    }

    if (req.method === 'POST' && pathname === '/api/song/config') {
      let body;
      try {
        body = await readJson(req);
      } catch (error) {
        json(res, 400, { ok: false, error: error.message });
        return;
      }
      json(res, 200, song.configure(body));
      return;
    }

    json(res, 404, { ok: false, error: 'not found' });
  });

  return {
    server,
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      const address = server.address();
      return { host, port: typeof address === 'object' && address ? address.port : port };
    },
    async stop() {
      song.dispose();
      for (const client of [...eventClients, ...commandClients]) {
        try {
          client.end();
        } catch {
          /* ignore */
        }
      }
      eventClients.clear();
      commandClients.clear();
      await new Promise((resolve) => server.close(resolve));
    },
    getStats() {
      return {
        eventClients: eventClients.size,
        commandClients: commandClients.size,
        lastEventAt,
        lastCommandAt,
        song: song.snapshot(),
      };
    },
  };
}

/* 作为脚本直接运行 */
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const bridge = createBridgeServer({ port: Number(process.env.PET_BRIDGE_PORT || 8787) });
  let info;
  try {
    info = await bridge.start();
  } catch (error) {
    if (error && error.code === 'EADDRINUSE') {
      console.error('端口 8787 已被占用：很可能旧的 bridge/server.mjs 还在运行。');
      console.error('请先结束旧的 Node 桥接进程，再重新执行 npm run bridge。');
      process.exit(1);
    }
    throw error;
  }
  console.log(`桌宠桥接已启动：http://${info.host}:${info.port}（v${BRIDGE_VERSION}）`);
  console.log(`参考桌宠：http://${info.host}:${info.port}/pet`);
  console.log(`直播背景板：http://${info.host}:${info.port}/board`);
  console.log('只监听本机，关闭此窗口即停止。');
  const shutdown = async () => {
    await bridge.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

