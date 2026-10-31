/**
 * 示例 Webhook 接收器（零依赖）。
 *
 * 用法：
 *   node examples/webhook-receiver.mjs
 * 然后在扩展「设置 → 事件转发」里填写 http://127.0.0.1:8788/events
 *
 * 收到的事件会追加写入 examples/events.jsonl，并在终端打印评论。
 */
import http from 'node:http';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 8788);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(ROOT, 'events.jsonl');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    reply(res, 200, { ok: true, service: 'dy-live-companion-webhook' });
    return;
  }

  if (req.method !== 'POST' || req.url !== '/events') {
    reply(res, 404, { ok: false, error: 'not found' });
    return;
  }

  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024 * 1024) throw new Error('payload too large');
      chunks.push(chunk);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    await mkdir(ROOT, { recursive: true });
    await appendFile(LOG_FILE, `${JSON.stringify(payload)}\n`, 'utf8');

    if (payload.kind === 'event' && payload.event) {
      const { type, user, content, gift } = payload.event;
      if (type === 'chat') {
        console.log(`[评论] ${user?.nickname ?? '匿名'}：${content}`);
      } else if (type === 'gift') {
        console.log(`[礼物] ${user?.nickname ?? '匿名'} 送出 ${gift?.name} ×${gift?.count}`);
      } else {
        console.log(`[事件] ${type}`);
      }
    } else if (payload.kind === 'reply') {
      console.log(`[回复] ${payload.reply?.text}`);
    }

    reply(res, 200, { ok: true });
  } catch (error) {
    reply(res, 400, { ok: false, error: error.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Webhook 接收器已启动：http://127.0.0.1:${PORT}/events`);
  console.log(`事件会追加写入 ${LOG_FILE}`);
});
