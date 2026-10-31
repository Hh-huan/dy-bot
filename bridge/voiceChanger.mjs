/** 实时变声 sidecar 的启动、健康检查与请求转发。 */

import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VC_DIR = path.resolve(HERE, '../voice-changer');
const PYTHON = path.join(VC_DIR, '.venv', 'Scripts', 'python.exe');
const BASE_URL = 'http://127.0.0.1:8790';

let child = null;
let starting = null;

async function call(pathname, options = {}) {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options.timeout || 5000),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { ok: response.ok, raw: text };
  }
  return { status: response.status, data };
}

async function healthy() {
  try {
    const result = await call('/health', { timeout: 1200 });
    return result.status === 200;
  } catch {
    return false;
  }
}

function startProcess() {
  if (!existsSync(PYTHON)) {
    return Promise.reject(new Error(
      '变声器环境未安装：请先运行 voice-changer/setup.ps1',
    ));
  }
  mkdirSync(VC_DIR, { recursive: true });
  const logFd = openSync(path.join(VC_DIR, 'service.log'), 'a');
  child = spawn(PYTHON, ['server.py', '--host', '127.0.0.1', '--port', '8790'], {
    cwd: VC_DIR,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
  });
  closeSync(logFd);
  child.on('exit', () => {
    child = null;
  });

  return new Promise((resolve, reject) => {
    let attempts = 0;
    const timer = setInterval(async () => {
      attempts += 1;
      if (await healthy()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (attempts >= 60) {
        clearInterval(timer);
        reject(new Error('变声服务启动超时，请查看 voice-changer/service.log'));
      }
    }, 500);
  });
}

async function ensureService() {
  if (await healthy()) return;
  if (!starting) {
    starting = startProcess().finally(() => {
      starting = null;
    });
  }
  return starting;
}

export function createVoiceChanger() {
  return {
    async handle(pathname, method, body) {
      await ensureService();
      const hasBody = method !== 'GET' && method !== 'HEAD'
        && body && Object.keys(body).length > 0;
      const options = { method, body: hasBody ? body : null, timeout: 30000 };
      return call(pathname, options);
    },
    async shutdown() {
      if (child) {
        child.kill();
        child = null;
      }
    },
  };
}
