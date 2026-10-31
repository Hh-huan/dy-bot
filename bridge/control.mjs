import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SERVER = path.join(HERE, 'server.mjs');
const LOCK = path.join(HERE, 'service-off.lock');
const CONTROL_PORT = 8786;
const BRIDGE_PORT = 8787;

let child = null;
let blocked = existsSync(LOCK);
let starting = false;

function log(message) {
  try {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    writeFileSync(path.join(HERE, 'control.log'), line, { flag: 'a' });
  } catch {
    /* ignore */
  }
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(700);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

async function startBridge() {
  if (blocked || starting) return;
  if (await portOpen(BRIDGE_PORT)) return;
  starting = true;
  try {
    try { unlinkSync(LOCK); } catch { /* no lock */ }
    const out = path.join(HERE, 'autostart.out.log');
    const err = path.join(HERE, 'autostart.err.log');
    child = spawn(process.execPath, [SERVER], {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.on('exit', () => {
      child = null;
    });
    log(`bridge started pid=${child.pid}`);
    void out;
    void err;
  } finally {
    starting = false;
  }
}

function stopBridge(reason = 'manual') {
  blocked = true;
  try { writeFileSync(LOCK, new Date().toISOString(), 'utf8'); } catch { /* ignore */ }
  log(`stopping bridge: ${reason}`);
  if (child && !child.killed) {
    try { child.kill(); } catch { /* ignore */ }
  }
  fetch(`http://127.0.0.1:${BRIDGE_PORT}/api/shutdown`, {
    method: 'POST',
    signal: AbortSignal.timeout(1200),
  }).catch(() => {});
  setTimeout(() => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-NetTCPConnection -LocalPort ${BRIDGE_PORT} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`,
      ],
      { windowsHide: true },
      () => {},
    );
  }, 700);
  return { ok: true, blocked: true };
}

async function startService() {
  blocked = false;
  try { unlinkSync(LOCK); } catch { /* no lock */ }
  await startBridge();
  await new Promise((resolve) => setTimeout(resolve, 900));
  return { ok: true, blocked: false, bridge: await portOpen(BRIDGE_PORT) };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(res, status, body) {
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/status') {
    json(res, 200, {
      ok: true,
      blocked,
      bridge: await portOpen(BRIDGE_PORT),
      pid: child ? child.pid : null,
      version: 1,
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/start') {
    json(res, 200, await startService());
    return;
  }
  if (req.method === 'POST' && url.pathname === '/stop') {
    json(res, 200, stopBridge('api'));
    return;
  }
  json(res, 404, { ok: false, error: 'not found' });
});

server.listen(CONTROL_PORT, '127.0.0.1', () => {
  log(`controller listening ${CONTROL_PORT}, blocked=${blocked}`);
  if (!blocked) startBridge();
});

setInterval(() => {
  if (!blocked && !child && !starting) startBridge();
}, 5000);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (child) {
      try { child.kill(); } catch { /* ignore */ }
    }
    process.exit(0);
  });
}