/**
 * 桌宠联动客户端：通过本地桥接（bridge/server.mjs）接收桌宠指令。
 * 弹幕 / AI 回复的推送在 main.js 里通过 post() 完成。
 */
export class PetBridge {
  constructor({ url, onCommand, onStateChange }) {
    this.base = PetBridge.normalize(url);
    this.onCommand = onCommand;
    this.onStateChange = onStateChange;
    this.source = null;
    this.enabled = false;
    this.connected = false;
    this.lastError = '';
  }

  static normalize(raw) {
    return String(raw || '').trim().replace(/\/+$/, '');
  }

  setUrl(raw) {
    const next = PetBridge.normalize(raw);
    if (next === this.base) return false;
    this.base = next;
    if (this.enabled) this.open();
    return true;
  }

  connect() {
    this.enabled = true;
    this.open();
  }

  disconnect() {
    this.enabled = false;
    this.closeSource();
    this.setState(false, '');
  }

  closeSource() {
    if (this.source) {
      try {
        this.source.close();
      } catch {
        /* ignore */
      }
      this.source = null;
    }
  }

  open() {
    this.closeSource();
    if (!this.enabled) return;
    if (!this.base) {
      this.setState(false, '未配置桥接地址');
      return;
    }

    try {
      const source = new EventSource(`${this.base}/commands`);
      this.source = source;

      source.onopen = () => this.setState(true, '');
      source.onmessage = (event) => {
        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }
        if (payload && typeof payload.action === 'string') {
          Promise.resolve(this.onCommand && this.onCommand(payload)).catch(() => {});
        }
      };
      source.onerror = () => {
        this.setState(false, '无法连接桌宠桥接，请确认已运行 node bridge/server.mjs');
      };
    } catch (error) {
      this.setState(false, error && error.message ? error.message : 'EventSource 创建失败');
    }
  }

  setState(connected, error) {
    if (this.connected === connected && this.lastError === error) return;
    this.connected = connected;
    this.lastError = error || '';
    if (this.onStateChange) {
      this.onStateChange({ connected: this.connected, error: this.lastError, enabled: this.enabled, url: this.base });
    }
  }

  async post(payload, timeoutMs = 4000) {
    if (!this.enabled || !this.base) return { ok: false, error: '桌宠联动未启用' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.base}/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      return { ok: response.ok, ...data };
    } catch (error) {
      return { ok: false, error: error && error.name === 'AbortError' ? '桥接请求超时' : error.message };
    } finally {
      clearTimeout(timer);
    }
  }

  async health(timeoutMs = 3000) {
    if (!this.base) return { ok: false, error: '未配置桥接地址' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.base}/health`, { signal: controller.signal });
      const data = await response.json();
      return { ok: response.ok, ...data };
    } catch (error) {
      return { ok: false, error: error && error.name === 'AbortError' ? '连接超时' : error.message };
    } finally {
      clearTimeout(timer);
    }
  }
}
