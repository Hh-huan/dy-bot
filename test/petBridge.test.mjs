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

test('桥接：DSH 桌宠动画清单与素材代理', async () => {
  const fakeDsh = http.createServer((req, res) => {
    if (req.url === '/dsh-pet-7340/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        main: {
          name: '蓝毛小女仆',
          animations: {
            idle: ['待机呼吸休闲'],
            clicks: ['点击回应-开心跃动', '吃白饭'],
            categories: [{ actions: ['吃白饭', '撸猫'] }],
          },
        },
      }));
      return;
    }
    const thumb = decodeURIComponent(String(req.url || ''));
    if (thumb.startsWith('/dsh-pet-7340/thumb/main/')) {
      res.writeHead(200, { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes' });
      res.end(Buffer.from('FAKE-WEBM'));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => fakeDsh.listen(0, '127.0.0.1', resolve));
  const dshPort = fakeDsh.address().port;
  const hint = `http://127.0.0.1:${dshPort}`;

  const bridge = createBridgeServer({ port: 0 });
  const info = await bridge.start();
  const base = baseUrl(info);
  try {
    const manifest = await (
      await fetch(`${base}/api/dsh-pet/manifest?hint=${encodeURIComponent(hint)}`)
    ).json();
    assert.equal(manifest.ok, true);
    assert.equal(manifest.petId, 'main');
    assert.equal(manifest.name, '蓝毛小女仆');
    assert.deepEqual(manifest.idle, ['待机呼吸休闲']);
    assert.deepEqual(manifest.clicks, ['点击回应-开心跃动', '吃白饭']);
    assert.deepEqual(manifest.actions, ['吃白饭', '撸猫']);

    const assetResponse = await fetch(
      `${base}/api/dsh-pet/asset?name=${encodeURIComponent('待机呼吸休闲.webm')}&hint=${encodeURIComponent(hint)}`,
    );
    assert.equal(assetResponse.status, 200);
    assert.equal(assetResponse.headers.get('content-type'), 'video/webm');
    assert.equal(await assetResponse.text(), 'FAKE-WEBM');

    const badResponse = await fetch(
      `${base}/api/dsh-pet/asset?name=${encodeURIComponent('../evil.webm')}&hint=${encodeURIComponent(hint)}`,
    );
    assert.equal(badResponse.status, 400);
  } finally {
    await bridge.stop();
    await new Promise((resolve) => fakeDsh.close(resolve));
  }
});

test('桥接：桌宠语音上传、广播与取回', async () => {
  const bridge = createBridgeServer({ port: 0 });
  const info = await bridge.start();
  const base = baseUrl(info);
  const controller = new AbortController();
  try {
    const stream = await fetch(`${base}/events`, { signal: controller.signal });
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();

    const upload = await fetch(`${base}/api/pet-voice?text=${encodeURIComponent('你好呀')}&duration=6000`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/mpeg' },
      body: Buffer.from('FAKE-MP3'),
    });
    const uploaded = await upload.json();
    assert.equal(uploaded.ok, true);
    assert.match(uploaded.id, /^voice-/);

    let text = '';
    const deadline = Date.now() + 3000;
    while (!text.includes('pet_voice') && Date.now() < deadline) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ value: null, done: false }), 300)),
      ]);
      if (value) text += decoder.decode(value, { stream: true });
      if (done) break;
    }
    assert.match(text, /"kind":"pet_voice"/);
    assert.match(text, /你好呀/);

    const audio = await fetch(`${base}/api/pet-voice/${uploaded.id}`);
    assert.equal(audio.status, 200);
    assert.equal(audio.headers.get('content-type'), 'audio/mpeg');
    assert.equal(await audio.text(), 'FAKE-MP3');

    const bad = await fetch(`${base}/api/pet-voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'not audio',
    });
    assert.equal(bad.status, 400);
  } finally {
    controller.abort();
    await bridge.stop();
  }
});

test('桥接：外部拾音器电平中转与 /pickup 页面', async () => {
  const bridge = createBridgeServer({ port: 0 });
  const info = await bridge.start();
  const base = baseUrl(info);
  try {
    const before = await (await fetch(`${base}/api/pickup/state`)).json();
    assert.equal(before.active, false);

    const levels = Array.from({ length: 32 }, (_, index) => (index === 5 ? 2 : 0.25));
    const post = await fetch(`${base}/api/pickup/levels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ levels }),
    });
    assert.equal(post.status, 200);

    const after = await (await fetch(`${base}/api/pickup/state`)).json();
    assert.equal(after.ok, true);
    assert.equal(after.active, true);
    assert.equal(after.levels.length, 32);
    // 越界值会被夹到 0~1
    assert.equal(after.levels[5], 1);

    const bad = await fetch(`${base}/api/pickup/levels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ levels: [] }),
    });
    assert.equal(bad.status, 400);

    const redirect = await fetch(`${base}/pickup`, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), '/board/pickup.html');
    const page = await fetch(`${base}/board/pickup.html`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') || '', /text\/html/);
  } finally {
    await bridge.stop();
  }
});
