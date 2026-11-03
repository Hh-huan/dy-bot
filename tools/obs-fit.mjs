#!/usr/bin/env node
/**
 * OBS 一键校正：把画布和场景里的浏览器源都拉到横屏满画布。
 *
 * 背景：OBS 画布全局只有一个方向。手动点过「适配屏幕」、拖动源、或切过画布之后，
 * 变换很容易乱掉，出现黑边 / 裁切。本工具按横屏画布（默认 1920×1080）把每个场景里
 * 第一个启用的源等比放大到刚好覆盖画布并居中，不拉伸、不留黑边。
 *
 * 用法：
 *   node tools/obs-fit.mjs                    # 画布不是 1920×1080 就先切过去，再校正场景
 *   node tools/obs-fit.mjs --canvas 2560x1440 # 指定其它 16:9 横屏画布
 *
 * 连接参数：默认 127.0.0.1:4455、密码留空，可用环境变量 OBS_WS_PORT / OBS_WS_PASSWORD
 * 或 bridge/obs.json（{ "port": 4455, "password": "..." }）覆盖。
 */
import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CANVAS = { width: 1920, height: 1080 };

function readConfig() {
  const config = { port: 4455, password: '' };
  const file = path.resolve(HERE, '../bridge/obs.json');
  if (existsSync(file)) {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      if (data && data.port) config.port = Number(data.port);
      if (data && data.password) config.password = data.password;
    } catch {
      /* 配置坏了就用默认值 */
    }
  }
  if (process.env.OBS_WS_PORT) config.port = Number(process.env.OBS_WS_PORT) || config.port;
  if (process.env.OBS_WS_PASSWORD) config.password = process.env.OBS_WS_PASSWORD;
  return config;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function connect(config) {
  const pending = new Map();
  let seq = 0;
  const ws = new WebSocket(`ws://127.0.0.1:${config.port}`);

  const call = (requestType, requestData = {}) =>
    new Promise((resolve, reject) => {
      const requestId = `fit-${++seq}`;
      pending.set(requestId, { resolve, reject, requestType });
      ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
    });

  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.op === 0) {
      const auth = message.d.authentication;
      const identify = { rpcVersion: 1, eventSubscriptions: 0 };
      if (auth) {
        const secret = crypto.createHash('sha256').update(config.password + auth.salt).digest('base64');
        identify.authentication = crypto.createHash('sha256').update(secret + auth.challenge).digest('base64');
      }
      ws.send(JSON.stringify({ op: 1, d: identify }));
      return;
    }
    if (message.op === 2) {
      ws.__ready = true;
      return;
    }
    if (message.op === 7) {
      const item = pending.get(message.d.requestId);
      if (!item) return;
      pending.delete(message.d.requestId);
      const { result, comment } = message.d.requestStatus;
      if (result) item.resolve(message.d.responseData || {});
      else item.reject(new Error(`${item.requestType} 失败：${comment || result}`));
    }
  };

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => {
      const timer = setTimeout(() => reject(new Error('OBS 认证超时')), 6000);
      const check = setInterval(() => {
        if (ws.__ready) {
          clearTimeout(timer);
          clearInterval(check);
          resolve();
        }
      }, 100);
      setTimeout(() => clearInterval(check), 7000);
    });
    ws.addEventListener('error', () => reject(new Error('连不上 OBS：请确认 OBS 已打开且 WebSocket 服务器已启用')));
  });

  return { ws, call, ready, close: () => ws.close() };
}

/** 等比放大到刚好覆盖画布并居中：不拉伸、不留黑边。 */
function coverTransform(source, canvas) {
  const scale = Math.max(canvas.width / source.width, canvas.height / source.height);
  return {
    positionX: Math.round((canvas.width - source.width * scale) / 2),
    positionY: Math.round((canvas.height - source.height * scale) / 2),
    scaleX: scale,
    scaleY: scale,
  };
}

async function fitScene(call, sceneName, canvas) {
  const { sceneItems } = await call('GetSceneItemList', { sceneName });
  const enabled = sceneItems.filter((item) => item.sceneItemEnabled);
  const item = enabled.find((entry) => entry.inputKind === 'browser_source') || enabled[0];
  if (!item) {
    console.log(`跳过场景「${sceneName}」：没有启用的源`);
    return;
  }
  const source = {
    width: item.sceneItemTransform.sourceWidth,
    height: item.sceneItemTransform.sourceHeight,
  };
  const transform = coverTransform(source, canvas);
  await call('SetSceneItemTransform', { sceneName, sceneItemId: item.sceneItemId, sceneItemTransform: transform });
  console.log(
    `场景「${sceneName}」源「${item.sourceName}」→ 位置 (${transform.positionX}, ${transform.positionY})，` +
      `缩放 ${transform.scaleX.toFixed(4)}，输出 ${Math.round(source.width * transform.scaleX)}×${Math.round(source.height * transform.scaleX)}`,
  );
}

/** 切画布：推流 / 录制运行时拒绝；虚拟摄像头自动停了再启。 */
async function setCanvas(call, canvas) {
  const stream = await call('GetStreamStatus');
  if (stream.outputActive) throw new Error('OBS 正在推流，不能切画布；请先停止推流。');
  const record = await call('GetRecordStatus');
  if (record.outputActive) throw new Error('OBS 正在录制，不能切画布；请先停止录制。');
  const vcam = await call('GetVirtualCamStatus');
  const wasActive = Boolean(vcam.outputActive);
  if (wasActive) {
    await call('StopVirtualCam');
    await sleep(600);
  }
  try {
    await call('SetVideoSettings', {
      baseWidth: canvas.width,
      baseHeight: canvas.height,
      outputWidth: canvas.width,
      outputHeight: canvas.height,
      fpsNumerator: 30,
      fpsDenominator: 1,
    });
  } finally {
    if (wasActive) {
      await sleep(800);
      await call('StartVirtualCam');
      console.log('虚拟摄像头已重新开启。');
    }
  }
  console.log(`画布已切换为 ${canvas.width}x${canvas.height}。`);
}

async function main() {
  const args = process.argv.slice(2);
  const canvas = { ...DEFAULT_CANVAS };
  const index = args.indexOf('--canvas');
  if (index !== -1 && args[index + 1]) {
    const match = args[index + 1].match(/^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/i);
    if (!match) throw new Error(`--canvas 参数格式应为 宽x高，例如 1920x1080，收到：${args[index + 1]}`);
    canvas.width = Number(match[1]);
    canvas.height = Number(match[2]);
    if (canvas.height > canvas.width) throw new Error('只支持横屏画布（宽 > 高），竖屏布局已移除。');
  }

  const obs = connect(readConfig());
  try {
    await obs.ready;
    const current = await obs.call('GetVideoSettings');
    if (current.baseWidth !== canvas.width || current.baseHeight !== canvas.height) {
      await setCanvas(obs.call, canvas);
    } else {
      console.log(`画布已是 ${canvas.width}x${canvas.height}。`);
    }
    const { scenes } = await obs.call('GetSceneList');
    for (const scene of scenes) {
      await fitScene(obs.call, scene.sceneName, canvas);
    }
    console.log('校正完成。');
  } finally {
    obs.close();
  }
}

main().catch((error) => {
  console.error(`[obs-fit] ${error.message}`);
  process.exit(1);
});
