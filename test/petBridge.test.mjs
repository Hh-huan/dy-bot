import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createBridgeServer } from '../bridge/server.mjs';

function baseUrl(info) {
  return `http://${info.host}:${info.port}`;
}

test('桥接：事件接收、指令投递与状态查询', async () => {
  const bridge = createBridgeServer({ port: 0 });
  const info = await bridge.start();
  const base = baseUrl(info);
  try {
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.eventClients, 0);

    const eventResponse = await fetch(`${base}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'event', event: { type: 'chat', content: '你好' } }),
    });
    const eventData = await eventResponse.json();
    assert.equal(eventData.ok, true);
    assert.equal(eventData.delivered, 0);

    const commandResponse = await fetch(`${base}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'toggle_auto_reply' }),
    });
    const commandData = await commandResponse.json();
    assert.equal(commandData.ok, true);
    assert.equal(commandData.delivered, 0);
    assert.match(commandData.hint, /未连接/);

    const status = await (await fetch(`${base}/status`)).json();
    assert.ok(status.lastEventAt > 0);
    assert.ok(status.lastCommandAt > 0);
  } finally {
    await bridge.stop();
  }
});

test('桥接：缺少 kind / action 时返回 400', async () => {
  const bridge = createBridgeServer({ port: 0 });
  const info = await bridge.start();
  const base = baseUrl(info);
  try {
    const noKind = await fetch(`${base}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(noKind.status, 400);

    const noAction = await fetch(`${base}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(noAction.status, 400);
  } finally {
    await bridge.stop();
  }
});

test('桥接：SSE 能把桌宠指令实时推给扩展', async () => {
  const bridge = createBridgeServer({ port: 0 });
  const info = await bridge.start();
  const base = baseUrl(info);
  const controller = new AbortController();
  try {
    const stream = await fetch(`${base}/commands`, { signal: controller.signal });
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();

    await fetch(`${base}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reply', text: '桌宠测试' }),
    });

    let text = '';
    const deadline = Date.now() + 3000;
    while (!text.includes('桌宠测试') && Date.now() < deadline) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ value: null, done: false }), 300)),
      ]);
      if (value) text += decoder.decode(value, { stream: true });
      if (done) break;
    }
    assert.match(text, /"action":"reply"/);
    assert.match(text, /桌宠测试/);
  } finally {
    controller.abort();
    await bridge.stop();
  }
});

test('桥接：按 hint 端口发现 DSH 桌宠地址', async () => {
  // 模拟一个 DSH：只有 /dsh-pet-7340/config 返回宠物配置
  const fakeDsh = http.createServer((req, res) => {
    if (req.url === '/dsh-pet-7340/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ main: { whisperPrompt: '你好' } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => fakeDsh.listen(0, '127.0.0.1', resolve));
  const dshPort = fakeDsh.address().port;

  const bridge = createBridgeServer({ port: 0 });
  const info = await bridge.start();
  try {
    const data = await (
      await fetch(`${baseUrl(info)}/api/dsh-pet/discover?hint=${encodeURIComponent(`http://127.0.0.1:${dshPort}`)}`)
    ).json();
    assert.equal(data.ok, true);
    assert.equal(data.baseUrl, `http://127.0.0.1:${dshPort}`);
    assert.equal(data.port, dshPort);
  } finally {
    await bridge.stop();
    await new Promise((resolve) => fakeDsh.close(resolve));
  }
});
