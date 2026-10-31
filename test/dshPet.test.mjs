import test from 'node:test';
import assert from 'node:assert/strict';

import { DshPetClient, DSH_PET_OWNER, discoverDshPetBaseUrl } from '../extension/app/core/dshPet.js';

const originalFetch = globalThis.fetch;

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function client() {
  return new DshPetClient({
    baseUrl: 'http://127.0.0.1:64864',
    petId: 'main',
    surface: 'desktop',
  });
}

test('DSH 桌宠：读取宠物列表', async () => {
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/dsh-pet-7340\/config$/);
    return jsonResponse({ main: { name: '蓝毛小女仆' }, second: {} });
  };
  try {
    const pets = await client().listPets();
    assert.deepEqual(pets, [
      { id: 'main', name: '蓝毛小女仆' },
      { id: 'second', name: 'second' },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('DSH 桌宠：广播气泡的 URL 与 body 正确', async () => {
  let captured = null;
  globalThis.fetch = async (url, options) => {
    captured = { url: new URL(String(url)), options };
    return jsonResponse({ ok: true });
  };
  try {
    await client().broadcast('你好', { duration: 5000, anim: false });
    assert.equal(captured.url.pathname, '/dsh-pet-7340/broadcast');
    assert.equal(captured.url.searchParams.get('pet'), 'main');
    assert.equal(captured.url.searchParams.get('surface'), 'desktop');
    const body = JSON.parse(captured.options.body);
    assert.equal(body.text, '你好');
    assert.equal(body.duration, 5000);
    assert.equal(body.anim, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('DSH 桌宠：注册右键菜单', async () => {
  let captured = null;
  globalThis.fetch = async (url, options) => {
    captured = { url, body: JSON.parse(options.body) };
    return jsonResponse({ ok: true });
  };
  try {
    await client().registerMenu(['自动回复：开', '测试气泡']);
    assert.equal(captured.body.owner, DSH_PET_OWNER);
    assert.deepEqual(captured.body.labels, ['自动回复：开', '测试气泡']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('DSH 桌宠：通过本地桥接发现当前端口', async () => {
  let captured = '';
  globalThis.fetch = async (url) => {
    captured = String(url);
    return jsonResponse({ ok: true, baseUrl: 'http://127.0.0.1:54628/' });
  };
  try {
    const baseUrl = await discoverDshPetBaseUrl('http://127.0.0.1:8787/', {
      hint: 'http://127.0.0.1:64864',
    });
    assert.equal(baseUrl, 'http://127.0.0.1:54628');
    const parsed = new URL(captured);
    assert.equal(parsed.pathname, '/api/dsh-pet/discover');
    assert.equal(parsed.searchParams.get('hint'), 'http://127.0.0.1:64864');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('DSH 桌宠：桥接没找到端口时返回空串', async () => {
  globalThis.fetch = async () => jsonResponse({ ok: false, error: '未找到 DSH 桌宠接口' });
  try {
    assert.equal(await discoverDshPetBaseUrl('http://127.0.0.1:8787'), '');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('DSH 桌宠：业务失败信息会抛出', async () => {
  globalThis.fetch = async () =>
    jsonResponse({ ok: false, reason: 'unknown-pet', message: '没有这只宠物' });
  try {
    await assert.rejects(client().broadcast('你好'), /没有这只宠物/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
