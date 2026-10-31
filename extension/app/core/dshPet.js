/**
 * 直接对接 DSH 里安装的 dsh-pet 插件（无需本地桥接）。
 *
 * dsh-pet 暴露了一组本机 HTTP 路由（当前 DSH 端口 + /dsh-pet-7340）：
 *   GET  /config                 全部宠物配置（用来拿 pet id / 名字）
 *   POST /broadcast?pet&surface  往桌宠气泡写一段外部文本
 *   POST /anim?pet&surface       点播一个动画
 *   POST /menu/item              注册第三方右键菜单
 *   GET  /menu/events?owner&wait 长轮询菜单点击
 *
 * 所有请求只发往 127.0.0.1，不上传任何数据。
 */

const ROUTE = '/dsh-pet-7340';
export const DSH_PET_OWNER = 'dy-live-companion';

function trimSlash(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * DSH 每次启动都换随机端口，扩展里存的地址会失效。
 * 连接失败时问本地桥接：它会扫描本机监听端口并返回当前 dsh-pet 地址。
 */
export async function discoverDshPetBaseUrl(bridgeUrl, options = {}) {
  const base = trimSlash(bridgeUrl || 'http://127.0.0.1:8787');
  const hint = trimSlash(options.hint || '');
  const query = hint ? `?hint=${encodeURIComponent(hint)}` : '';
  const response = await fetch(`${base}/api/dsh-pet/discover${query}`, {
    signal: AbortSignal.timeout(options.timeoutMs || 8000),
  });
  if (!response.ok) throw new Error(`DSH 端口发现接口 HTTP ${response.status}`);
  const data = await response.json();
  return data && data.ok && data.baseUrl ? trimSlash(String(data.baseUrl)) : '';
}

export class DshPetClient {
  constructor(options = {}) {
    this.baseUrl = trimSlash(options.baseUrl || 'http://127.0.0.1:64864');
    this.petId = String(options.petId || 'main');
    this.surface = options.surface === 'web' || options.surface === 'both' ? options.surface : 'desktop';
    this.getMenuLabels = options.getMenuLabels || (() => []);
    this.onMenu = options.onMenu || (() => {});
    this.onStatus = options.onStatus || (() => {});
    this.running = false;
    this.abort = null;
    this.animations = {};
  }

  get api() {
    return `${this.baseUrl}${ROUTE}`;
  }

  setConfig({ baseUrl, petId, surface }) {
    if (baseUrl) this.baseUrl = trimSlash(baseUrl);
    if (petId) this.petId = String(petId);
    if (surface) this.surface = surface;
  }

  async request(path, options = {}) {
    const timeoutMs = options.timeoutMs || 8000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = this.abort ? AnySignal([this.abort.signal, controller.signal]) : controller.signal;
    try {
      const response = await fetch(`${this.api}${path}`, {
        method: options.method || 'GET',
        headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal,
      });
      const text = await response.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { raw: text };
      }
      if (!response.ok) throw new Error(`DSH 桌宠接口 HTTP ${response.status}`);
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  async listPets() {
    const data = await this.request('/config');
    const entries = Object.entries(data || {});
    const own = (data && (data[this.petId] || data.main)) || (entries[0] && entries[0][1]) || {};
    this.animations = (own && own.animations) || {};
    return entries
      .map(([id, pet]) => ({ id, name: (pet && (pet.name || id)) || id }))
      .filter((item) => item.id);
  }

  async broadcast(text, options = {}) {
    const pet = options.petId || this.petId;
    const query = new URLSearchParams({ pet, surface: this.surface });
    const data = await this.request(`/broadcast?${query}`, {
      method: 'POST',
      body: {
        text: String(text || ''),
        duration: Math.max(1000, Math.min(60000, Number(options.duration) || 8000)),
        anim: options.anim !== false,
      },
    });
    if (!data.ok) throw new Error(data.message || data.reason || '桌宠拒绝了这个气泡');
    return data;
  }

  async anim(name, options = {}) {
    const pet = options.petId || this.petId;
    const query = new URLSearchParams({ pet, surface: this.surface });
    const data = await this.request(`/anim?${query}`, {
      method: 'POST',
      body: { name: String(name || '') },
    });
    if (!data.ok) throw new Error(data.message || data.reason || '动画播放失败');
    return data;
  }

  async registerMenu(labels) {
    const list = (Array.isArray(labels) ? labels : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .slice(0, 20);
    if (!list.length) return null;
    const data = await this.request('/menu/item', {
      method: 'POST',
      body: { owner: DSH_PET_OWNER, labels: list },
    });
    if (!data.ok) throw new Error(data.message || data.reason || '菜单注册失败');
    return data;
  }

  async clearMenu() {
    try {
      await this.request(`/menu/item?owner=${encodeURIComponent(DSH_PET_OWNER)}`, { method: 'DELETE' });
    } catch {
      /* DSH 不在时忽略 */
    }
  }

  async pollMenu(waitMs = 9000) {
    const query = new URLSearchParams({ owner: DSH_PET_OWNER, wait: String(waitMs) });
    return this.request(`/menu/events?${query}`, { timeoutMs: waitMs + 6000 });
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.loop();
  }

  stop(options = {}) {
    this.running = false;
    if (this.abort) {
      try {
        this.abort.abort();
      } catch {
        /* ignore */
      }
      this.abort = null;
    }
    if (options.clearMenu !== false) this.clearMenu();
  }

  async loop() {
    let registerFailures = 0;
    while (this.running) {
      try {
        const data = await this.pollMenu(9000);
        if (!this.running) break;
        if (!data || data.ok !== true) {
          // DSH 重启后菜单注册表会丢，重新注册
          if (data && data.reason === 'unknown-owner') {
            await this.registerMenu(this.getMenuLabels());
            continue;
          }
          throw new Error((data && (data.message || data.reason)) || '菜单长轮询失败');
        }
        registerFailures = 0;
        this.onStatus({ ok: true });
        const events = data.events || {};
        for (const [label, petId] of Object.entries(events)) {
          if (!petId) continue;
          try {
            await this.onMenu(label, petId);
          } catch {
            /* 单个菜单动作失败不影响轮询 */
          }
        }
      } catch (error) {
        if (!this.running) break;
        registerFailures += 1;
        this.onStatus({ ok: false, error: error.message });
        await sleep(registerFailures > 3 ? 8000 : 3000);
      }
    }
  }
}

/** 合并两个 AbortSignal（Node 20+ / Chrome 116+ 可用）。 */
function AnySignal(signals) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return AbortSignal.any(signals);
  }
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller.signal;
}
