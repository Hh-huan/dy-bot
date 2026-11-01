/**
 * OBS 虚拟摄像头自愈：桥接启动时通过 obs-websocket 检查并自动开启虚拟摄像头。
 *
 * OBS 关闭或重启后虚拟摄像头默认是关的，直播伴侣的「摄像头 → OBS Virtual Camera」就会黑屏，
 * 这里在桥接启动时补一次，省得每次手动去点「启动虚拟摄像机」。
 *
 * 配置（可选）：bridge/obs.json，不存在时用下面的默认值。
 *   { "enabled": true, "port": 4455, "password": "", "attempts": 3, "retryDelayMs": 5000 }
 * 也支持环境变量 OBS_WS_PORT / OBS_WS_PASSWORD 覆盖。
 *
 * 密码填 OBS 里「工具 → WebSocket 服务器设置」显示的那串；没开鉴权就留空。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(HERE, 'obs.json');

const DEFAULTS = {
  enabled: true,
  host: '127.0.0.1',
  port: 4455,
  password: '',
  attempts: 3,
  retryDelayMs: 5000,
  timeoutMs: 6000,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readConfig() {
  const config = { ...DEFAULTS };
  if (existsSync(CONFIG_FILE)) {
    try {
      const file = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
      for (const key of Object.keys(DEFAULTS)) {
        if (file && file[key] !== undefined) config[key] = file[key];
      }
    } catch {
      /* 配置写错就退回默认值，不影响桥接启动 */
    }
  }
  if (process.env.OBS_WS_PORT) config.port = Number(process.env.OBS_WS_PORT) || config.port;
  if (process.env.OBS_WS_PASSWORD) config.password = process.env.OBS_WS_PASSWORD;
  config.port = Number(config.port) || DEFAULTS.port;
  config.attempts = Math.max(1, Number(config.attempts) || DEFAULTS.attempts);
  return config;
}

/** 单次连接：认证 → 查状态 → 未开启就 StartVirtualCam → 复查。 */
function startOnce(config) {
  return new Promise((resolve) => {
    const pending = new Map();
    let seq = 0;
    let settled = false;
    let timer = null;
    const ws = new WebSocket(`ws://${config.host}:${config.port}`);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    timer = setTimeout(() => finish({ ok: false, error: '连接 OBS 超时' }), config.timeoutMs);

    const call = (requestType, requestData = {}) =>
      new Promise((res, rej) => {
        const requestId = `obs-${++seq}`;
        pending.set(requestId, { res, rej });
        ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
      });

    const run = async () => {
      const status = await call('GetVirtualCamStatus');
      if (status.data && status.data.outputActive) {
        finish({ ok: true, started: false, active: true });
        return;
      }
      const start = await call('StartVirtualCam');
      if (!start.result) {
        finish({ ok: false, error: start.comment || 'OBS 拒绝启动虚拟摄像头' });
        return;
      }
      // 输出启动后状态有短暂延迟，等一下再复查
      await sleep(800);
      const after = await call('GetVirtualCamStatus');
      finish({ ok: true, started: true, active: Boolean(after.data && after.data.outputActive) });
    };

    ws.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.op === 0) {
        const auth = message.d && message.d.authentication;
        const identify = { rpcVersion: 1, eventSubscriptions: 0 };
        if (auth) {
          const secret = crypto.createHash('sha256').update(config.password + auth.salt).digest('base64');
          identify.authentication = crypto.createHash('sha256').update(secret + auth.challenge).digest('base64');
        }
        ws.send(JSON.stringify({ op: 1, d: identify }));
        return;
      }
      if (message.op === 2) {
        run().catch((error) => finish({ ok: false, error: error.message || String(error) }));
        return;
      }
      if (message.op === 7) {
        const item = pending.get(message.d.requestId);
        if (!item) return;
        pending.delete(message.d.requestId);
        item.res({ result: message.d.requestStatus.result, comment: message.d.requestStatus.comment, data: message.d.responseData });
      }
    };

    ws.onerror = () => finish({ ok: false, error: 'OBS 未运行或 obs-websocket 未开启' });
    ws.onclose = () => finish({ ok: false, error: 'OBS 连接已关闭' });
  });
}

/** 检查并按需开启 OBS 虚拟摄像头；失败不抛出，只返回结果。 */
export async function ensureVirtualCamera({ log = () => {} } = {}) {
  const config = readConfig();
  if (!config.enabled) return { ok: false, skipped: 'disabled' };
  if (typeof WebSocket !== 'function') {
    return { ok: false, error: '当前 Node 版本没有内置 WebSocket（需 22 以上）' };
  }
  let lastError = '';
  for (let attempt = 1; attempt <= config.attempts; attempt += 1) {
    const result = await startOnce(config);
    if (result.ok && result.active) {
      log(result.started ? '已自动开启 OBS 虚拟摄像头' : 'OBS 虚拟摄像头已在运行');
      return result;
    }
    lastError = result.error || 'OBS 虚拟摄像头未能开启';
    if (attempt < config.attempts) await sleep(config.retryDelayMs);
  }
  if (!config.password) {
    lastError += '；如果 OBS 开了 WebSocket 鉴权，把密码填到 bridge/obs.json 或环境变量 OBS_WS_PASSWORD';
  }
  log(`OBS 虚拟摄像头未开启：${lastError}`);
  return { ok: false, error: lastError };
}
