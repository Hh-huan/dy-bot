"""本地实时变声服务：HTTP 控制 Seed-VC 流式推理与音频设备路由。"""

from __future__ import annotations

import argparse
import json
import os
import threading
import traceback
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

BASE_DIR = Path(__file__).resolve().parent
os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')
os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')
os.chdir(BASE_DIR)

import numpy as np
import sounddevice as sd
import torch

CONFIG_PATH = BASE_DIR / 'config.json'
DEFAULT_REFERENCE = 'reference/pet-voice.wav'
STATE_LOCK = threading.RLock()
LOG_LINES = deque(maxlen=200)

PANEL_HTML = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>实时变声器</title>
<style>
  body{margin:0;padding:24px;font:14px/1.6 "Microsoft YaHei",system-ui,sans-serif;
       background:#14161a;color:#e6e8eb;display:flex;justify-content:center}
  main{width:420px}
  h1{font-size:18px;margin:0 0 4px}
  .sub{color:#8a919c;font-size:12px;margin-bottom:18px}
  .card{background:#1c1f24;border:1px solid #2a2e35;border-radius:10px;padding:16px;margin-bottom:14px}
  .row{display:flex;gap:12px}
  .row>*{flex:1;min-width:0}
  label{display:block;font-size:12px;color:#98a0ab;margin-bottom:4px}
  select,input[type=number]{width:100%;padding:7px;border-radius:6px;border:1px solid #333a43;
         background:#121418;color:#e6e8eb}
  .stat{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px dashed #2a2e35}
  .stat:last-child{border:0}
  .stat b{font-weight:600}
  .ok{color:#4ade80}.bad{color:#f87171}.warn{color:#fbbf24}
  button{flex:1;padding:9px;border:0;border-radius:7px;font-size:13px;cursor:pointer;color:#fff}
  #start{background:#2563eb}#stop{background:#4b5563}
  button:disabled{opacity:.45;cursor:default}
  #msg{font-size:12px;min-height:18px;margin-top:10px;color:#98a0ab}
</style></head><body><main>
  <h1>实时变声器</h1>
  <div class="sub">Seed-VC 本地推理 · 输出到虚拟声卡</div>
  <div class="card">
    <div class="row">
      <div><label>输入设备</label><select id="in"></select></div>
      <div><label>输出设备</label><select id="out"></select></div>
    </div>
  </div>
  <div class="card">
    <div class="row">
      <div><label>参考起点（秒）</label><input id="offset" type="number" min="0" max="16" step="0.5"></div>
      <div><label>扩散步数</label><input id="steps" type="number" min="4" max="25" step="1"></div>
    </div>
    <div class="stat"><span>柔化音色（补低频、削齿音）</span><input id="eq" type="checkbox"></div>
    <button id="applyTone" style="width:100%;margin-top:12px;background:#7c3aed">应用音色 · 重建模型约 30 秒</button>
  </div>
  <div class="card">
    <div class="stat"><span>状态</span><b id="state">-</b></div>
    <div class="stat"><span>延迟</span><b id="latency">-</b></div>
    <div class="stat"><span>推理耗时</span><b id="infer">-</b></div>
    <div class="stat"><span>虚拟声卡</span><b id="cable">-</b></div>
  </div>
  <div class="row">
    <button id="start">启动</button><button id="stop">停止</button>
  </div>
  <div id="msg"></div>
</main>
<script>
const $ = (s) => document.querySelector(s);
let filled = false;
function fill(devices, config) {
  // 同一设备在 MME/DirectSound/WASAPI/WDM-KS 下会重复出现，只保留 WASAPI，延迟和稳定性最好
  const best = (list) => {
    const wasapi = list.filter((d) => /WASAPI/i.test(d.hostapi));
    return wasapi.length ? wasapi : list;
  };
  const pick = (sel, list, chosen) => {
    const items = best(list);
    sel.innerHTML = items.map((d) =>
      `<option value="${d.index}">${d.name}</option>`).join('');
    if (chosen != null && items.some((d) => d.index === chosen)) {
      sel.value = String(chosen);
    }
  };
  pick($('#in'), devices.inputs, config.inputDevice);
  pick($('#out'), devices.outputs, config.outputDevice);
  $('#offset').value = config.promptOffset ?? 0;
  $('#steps').value = config.diffusionSteps ?? 8;
  $('#eq').checked = config.softEq !== false;
  filled = true;
}
async function loadDevices(config) {
  const result = await fetch('/devices').then((r) => r.json());
  fill(result, config);
}
async function poll() {
  try {
    const s = await fetch('/status').then((r) => r.json());
    const st = s.stats || {};
    const map = { idle: '已停止', loading: '加载中…', running: '运行中', error: '出错' };
    $('#state').textContent = map[s.state] || s.state;
    $('#state').className = s.state === 'running' ? 'ok' : s.state === 'error' ? 'bad' : 'warn';
    $('#latency').textContent = st.latencyMs ? `${st.latencyMs} ms` : '-';
    $('#infer').textContent = st.inferMs ? `${st.inferMs} ms` : '-';
    const cable = s.virtualCableInstalled;
    $('#cable').textContent = cable == null ? '-' : cable ? '已安装' : '未安装';
    $('#cable').className = cable ? 'ok' : 'bad';
    if (!filled && s.config) await loadDevices(s.config);
    $('#start').disabled = s.state === 'running' || s.state === 'loading';
    $('#stop').disabled = s.state === 'idle';
    $('#msg').textContent = s.state === 'error' ? (s.message || '') : '';
  } catch (e) {
    $('#state').textContent = '服务未连接';
    $('#state').className = 'bad';
  }
}
async function post(path, body) {
  const r = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await r.json();
  $('#msg').textContent = data.error || '';
  poll();
}
$('#start').onclick = () => post('/start', {
  inputDevice: Number($('#in').value), outputDevice: Number($('#out').value),
});
$('#applyTone').onclick = async () => {
  $('#msg').textContent = '正在应用音色，模型重建约 30 秒…';
  await post('/config', {
    promptOffset: Number($('#offset').value) || 0,
    diffusionSteps: Number($('#steps').value) || 8,
    softEq: $('#eq').checked,
  });
  await post('/start', {
    inputDevice: Number($('#in').value), outputDevice: Number($('#out').value),
  });
};
$('#stop').onclick = () => post('/stop');
poll();
setInterval(poll, 1500);
</script></body></html>"""


def log(message: str) -> None:
    line = str(message)
    LOG_LINES.append(line)
    print(line, flush=True)


def load_config() -> dict:
    if CONFIG_PATH.exists():
        try:
            return json.loads(CONFIG_PATH.read_text('utf-8'))
        except Exception:
            pass
    return {}


def save_config(config: dict) -> None:
    CONFIG_PATH.write_text(
        json.dumps(config, ensure_ascii=False, indent=2), encoding='utf-8',
    )


def resolve_reference(value: str | None) -> str:
    value = (value or DEFAULT_REFERENCE).strip()
    path = Path(value)
    if not path.is_absolute():
        path = BASE_DIR / path
    if not path.exists() and path.name:
        fallback = BASE_DIR / 'reference' / path.name
        if fallback.exists():
            path = fallback
    return str(path.resolve())


def query_devices() -> dict:
    devices = sd.query_devices()
    hostapis = sd.query_hostapis()
    default_in, default_out = sd.default.device
    inputs, outputs = [], []
    for index, item in enumerate(devices):
        host = hostapis[item['hostapi']]['name'] if item.get('hostapi') is not None else ''
        entry = {
            'index': index,
            'name': item['name'],
            'hostapi': host,
            'channels': int(item['max_input_channels'] if 'max_input_channels' in item else 0),
            'defaultSamplerate': int(item['default_samplerate']),
        }
        if item['max_input_channels'] > 0:
            entry['default'] = index == default_in
            entry['virtual'] = ('CABLE Output' in item['name']
                                or 'VoiceMeeter Output' in item['name'])
            inputs.append({**entry, 'channels': int(item['max_input_channels'])})
        if item['max_output_channels'] > 0:
            entry['default'] = index == default_out
            entry['virtual'] = ('CABLE Input' in item['name']
                                or 'VoiceMeeter Input' in item['name'])
            outputs.append({**entry, 'channels': int(item['max_output_channels'])})

    def pick_virtual(entries):
        # WASAPI 与其他 Host API 交叉时可能听不到声音，优先用它
        wasapi = next((d['index'] for d in entries if d['virtual'] and 'WASAPI' in d['hostapi']), None)
        if wasapi is not None:
            return wasapi
        return next((d['index'] for d in entries if d['virtual']), None)

    cable_in = pick_virtual(inputs)
    cable_out = pick_virtual(outputs)
    return {
        'inputs': inputs,
        'outputs': outputs,
        'default': {'input': default_in, 'output': default_out},
        'virtualCable': {
            'installed': cable_in is not None and cable_out is not None,
            'inputIndex': cable_in,
            'outputIndex': cable_out,
        },
    }


def choose_samplerate(input_index: int, output_index: int, output_channels: int,
                      preferred: int | None) -> int:
    candidates = []
    for value in (preferred, 48000, 44100,
                  int(sd.query_devices(output_index)['default_samplerate'])):
        if value and int(value) not in candidates:
            candidates.append(int(value))
    last_error = None
    for rate in candidates:
        try:
            sd.check_input_settings(
                device=input_index, channels=1, samplerate=rate, dtype='float32',
            )
            sd.check_output_settings(
                device=output_index, channels=output_channels, samplerate=rate,
                dtype='float32',
            )
            return rate
        except Exception as exc:
            last_error = exc
    raise RuntimeError(f'输入/输出设备无法共用采样率 {candidates}: {last_error}')


def find_device_by_name(name: str | None, want_input: bool) -> int | None:
    if not name:
        return None
    for index, item in enumerate(sd.query_devices()):
        if item['name'] != name:
            continue
        if want_input and item['max_input_channels'] < 1:
            continue
        if not want_input and item['max_output_channels'] < 1:
            continue
        return index
    return None


def normalize_config(raw: dict) -> dict:
    devices = query_devices()
    input_index = find_device_by_name(raw.get('inputName'), True)
    if input_index is None:
        input_index = raw.get('inputDevice')
    if input_index is None:
        input_index = devices['default']['input']
    output_index = find_device_by_name(raw.get('outputName'), False)
    if output_index is None:
        output_index = raw.get('outputDevice')
    if output_index is None:
        output_index = devices['virtualCable']['outputIndex']
    if output_index is None:
        output_index = devices['default']['output']
    input_index = int(input_index)
    output_index = int(output_index)

    input_info = sd.query_devices(input_index)
    output_info = sd.query_devices(output_index)
    if input_info['max_input_channels'] < 1:
        raise ValueError(f'设备 {input_index} 不是输入设备')
    if output_info['max_output_channels'] < 1:
        raise ValueError(f'设备 {output_index} 不是输出设备')

    def clamp(value, low, high, fallback):
        try:
            return max(low, min(high, type(fallback)(value)))
        except Exception:
            return fallback

    return {
        'inputDevice': input_index,
        'outputDevice': output_index,
        'outputChannels': min(2, int(output_info['max_output_channels'])),
        'sampleRate': raw.get('sampleRate') or None,
        'referencePath': resolve_reference(raw.get('referencePath')),
        'blockTime': clamp(raw.get('blockTime', 0.25), 0.15, 0.5, 0.25),
        'crossfadeTime': clamp(raw.get('crossfadeTime', 0.04), 0.02, 0.1, 0.04),
        'diffusionSteps': clamp(raw.get('diffusionSteps', 8), 4, 25, 8),
        'cfgRate': clamp(raw.get('cfgRate', 0.7), 0.0, 1.0, 0.7),
        'maxPromptLength': clamp(raw.get('maxPromptLength', 3.0), 1.0, 10.0, 3.0),
        'promptOffset': clamp(raw.get('promptOffset', 0.0), 0.0, 20.0, 0.0),
        'extraTimeRight': clamp(raw.get('extraTimeRight', 0.04), 0.02, 0.2, 0.04),
        'vadThreshold': clamp(raw.get('vadThreshold', -48), -70, -20, -48),
        'vadHoldMs': int(clamp(raw.get('vadHoldMs', 300), 100, 2000, 300)),
        'fp16': bool(raw.get('fp16', True)),
        'softEq': bool(raw.get('softEq', True)),
    }


STATE = {
    'state': 'idle',
    'message': '',
    'error': None,
    'config': load_config(),
    'engine': None,
    'engineKey': None,
    'stream': None,
    'stopRequested': False,
    'startedAt': None,
}


def engine_key(config: dict, sample_rate: int) -> tuple:
    return (
        config['referencePath'], config['diffusionSteps'], config['cfgRate'],
        config['maxPromptLength'], config['fp16'], sample_rate,
        config['blockTime'], config['crossfadeTime'], config['extraTimeRight'],
        config['softEq'], config['promptOffset'],
    )


def stop_stream(message: str = '已停止') -> None:
    with STATE_LOCK:
        STATE['stopRequested'] = True
        event = STATE.get('workerStop')
        if event is not None:
            event.set()
        streams = STATE.get('streams') or []
        STATE['streams'] = None
        for stream in streams:
            try:
                stream.abort()
            except Exception:
                pass
            try:
                stream.close()
            except Exception:
                pass
        STATE['state'] = 'idle'
        STATE['message'] = message


def init_com() -> None:
    """工作线程内初始化 COM(MTA)，否则 WASAPI 音频流启动会报 PaErrorCode -9999。"""
    if os.name != 'nt':
        return
    try:
        import ctypes
        ctypes.windll.ole32.CoInitializeEx(None, 0)
    except Exception:
        pass


def load_and_run(config: dict) -> None:
    try:
        init_com()
        output_channels = int(config['outputChannels'])
        sample_rate = choose_samplerate(
            config['inputDevice'], config['outputDevice'], output_channels,
            config['sampleRate'],
        )
        key = engine_key(config, sample_rate)
        engine = STATE.get('engine')
        if engine is not None and STATE.get('engineKey') != key:
            engine = None
            STATE['engine'] = None
        if engine is None:
            log(f'加载 Seed-VC 模型，参考音频：{config["referencePath"]}')
            from engine import StreamingVoiceChanger
            engine = StreamingVoiceChanger(
                config['referencePath'],
                sample_rate=sample_rate,
                block_time=config['blockTime'],
                crossfade_time=config['crossfadeTime'],
                extra_time_right=config['extraTimeRight'],
                diffusion_steps=config['diffusionSteps'],
                inference_cfg_rate=config['cfgRate'],
                max_prompt_length=config['maxPromptLength'],
                prompt_offset=config.get('promptOffset', 0.0),
                fp16=config['fp16'],
                vad_threshold=config['vadThreshold'],
                vad_hold_ms=config.get('vadHoldMs', 300),
                soft_eq=config.get('softEq', True),
            )
            engine.warmup()
            STATE['engine'] = engine
            STATE['engineKey'] = key
        else:
            engine.reset()

        if STATE.get('stopRequested'):
            return

        block = engine.block_frame
        # 音频流按 20ms 小周期跑，推理仍按 block 聚合。
        # WASAPI 的缓冲延迟跟 stream 周期成正比，周期越小端到端延迟越低
        zc = engine.zc
        audio_block = max(zc, min(block, int(round(0.02 * sample_rate / zc)) * zc))
        STATE['audioBlockMs'] = round(audio_block * 1000.0 / sample_rate)
        STATE['queueMs'] = round(block * 1500.0 / sample_rate)
        pending = np.zeros(0, dtype=np.float32)
        carry = np.zeros(0, dtype=np.float32)
        primed = False
        ring = deque()
        ring_lock = threading.Lock()
        input_lock = threading.Lock()
        stop_event = threading.Event()
        STATE['workerStop'] = stop_event
        STATE['underruns'] = 0

        def input_callback(indata, frames, time_info, status):
            nonlocal pending
            if status:
                log(f'录音状态：{status}')
            # 回调里只做入队，推理交给独立线程，避免阻塞 WASAPI 录音线程
            with input_lock:
                pending = np.concatenate([pending, indata[:, 0]])
                if pending.shape[0] > block * 2:
                    pending = pending[-block * 2:]

        def worker() -> None:
            nonlocal pending
            while not stop_event.is_set():
                data = None
                with input_lock:
                    if pending.shape[0] >= block:
                        data = pending[:block].copy()
                        pending = pending[block:]
                if data is None:
                    stop_event.wait(0.005)
                    continue
                try:
                    converted = engine.process_block(data)
                except Exception:
                    log(traceback.format_exc())
                    continue
                # 静音块（全零）也照常入队：停顿/说话切换时队列不断流，
                # 播放端无需重新预热，消除句间「断一下再出声」的感觉
                # 拆成两半投放：粒度减半后起播库存只需 1.5 块，延迟更省
                half = converted.shape[0] // 2
                with ring_lock:
                    ring.append(converted[:half])
                    ring.append(converted[half:])
                    while len(ring) > 8:
                        ring.popleft()

        def output_callback(outdata, frames, time_info, status):
            nonlocal carry, primed
            if status:
                log(f'播放状态：{status}')
            with ring_lock:
                while carry.shape[0] < frames and ring:
                    carry = np.concatenate([carry, ring.popleft()])
                available = carry.shape[0] + sum(x.shape[0] for x in ring)
                # 攒够 1.5 块起播（半块投放粒度）；库存稳定后推理抖动全被吸收
                if not primed and available >= block + (block >> 1):
                    primed = True
            if carry.shape[0] >= frames:
                outdata[:] = carry[:frames, None]
                carry = carry[frames:]
                return
            if not primed:
                # 起播前的预热期：输出静音，不算断音
                outdata[:] = 0
                return
            # 已起播仍断粮 = 真断音（只有 GPU 长时间停顿才会发生）
            STATE['underruns'] += 1
            primed = False
            carry = np.concatenate(
                [carry, np.zeros(frames - carry.shape[0], dtype=np.float32)],
            )
            outdata[:] = carry[:frames, None]
            carry = carry[frames:]

        worker_thread = threading.Thread(target=worker, daemon=True)
        worker_thread.start()

        def clock_keeper() -> None:
            """块间/句间空隙跑微小矩阵乘，避免 GPU 掉频后重新爬频
            （掉频期间推理实测慢 2 倍以上，是断续的主要来源）。"""
            if engine.device == 'cpu':
                return
            try:
                a = torch.randn(2048, 2048, device=engine.device, dtype=torch.float16)
                out = torch.empty_like(a)
                while not stop_event.is_set():
                    torch.mm(a, a, out=out)
                    stop_event.wait(0.01)
            except Exception:
                pass

        keeper_thread = threading.Thread(target=clock_keeper, daemon=True)
        keeper_thread.start()

        in_stream = sd.InputStream(
            device=config['inputDevice'],
            samplerate=sample_rate,
            blocksize=audio_block,
            latency='low',
            channels=1,
            dtype='float32',
            callback=input_callback,
        )
        out_stream = sd.OutputStream(
            device=config['outputDevice'],
            samplerate=sample_rate,
            blocksize=audio_block,
            latency='low',
            channels=output_channels,
            dtype='float32',
            callback=output_callback,
        )
        STATE['streams'] = [out_stream, in_stream]
        if STATE.get('stopRequested'):
            return
        out_stream.start()
        in_stream.start()

        def latency_of(stream, index):
            value = stream.latency
            if isinstance(value, (tuple, list)):
                value = value[index]
            return float(value)

        STATE['streamLatencyMs'] = round(
            (latency_of(in_stream, 0) + latency_of(out_stream, 1)) * 1000.0,
        )
        if STATE.get('stopRequested'):
            stop_stream('已停止')
            return
        with STATE_LOCK:
            STATE['state'] = 'running'
            STATE['message'] = '实时变声运行中'
            STATE['error'] = None
            STATE['stopRequested'] = False
        log(f'变声已启动：输入 {config["inputDevice"]} → 输出 {config["outputDevice"]}，'
            f'{sample_rate} Hz，推理块 {engine.block_frame} samples，'
            f'音频流块 {audio_block} samples')
    except Exception as exc:
        event = STATE.get('workerStop')
        if event is not None:
            event.set()
        # 启动阶段的异常可能发生在音频流已 start 之后，这里要顺手关掉，避免设备被占住
        for stream in (STATE.get('streams') or []):
            try:
                stream.abort()
            except Exception:
                pass
            try:
                stream.close()
            except Exception:
                pass
        STATE['streams'] = None
        with STATE_LOCK:
            STATE['state'] = 'error'
            STATE['message'] = f'{type(exc).__name__}: {exc}'
            STATE['error'] = traceback.format_exc()
            STATE['stopRequested'] = False
        log(traceback.format_exc())


def status_payload() -> dict:
    with STATE_LOCK:
        engine = STATE.get('engine')
        state = STATE['state']
        payload = {
            'ok': state != 'error',
            'state': state,
            'running': state == 'running',
            'loading': state == 'loading',
            'message': STATE['message'],
            'error': STATE['error'],
            'config': STATE.get('config') or {},
            'virtualCableInstalled': None,
            'underruns': STATE.get('underruns', 0),
            'audioBlockMs': STATE.get('audioBlockMs', 0),
            'streamLatencyMs': STATE.get('streamLatencyMs', 0),
            'log': list(LOG_LINES)[-20:],
        }
        if engine is not None:
            stats = engine.stats()
            # 端到端估算 = 凑块 + 右延 + 推理 + 播放库存(1.5块) + 音频流缓冲
            stats['latencyMs'] = round(
                stats['latencyMs'] + STATE.get('queueMs', 0)
                + (STATE.get('streamLatencyMs') or 0),
            )
            payload['stats'] = stats
        try:
            devices = query_devices()
            payload['virtualCableInstalled'] = devices['virtualCable']['installed']
        except Exception:
            pass
        return payload


class Handler(BaseHTTPRequestHandler):
    server_version = 'dy-bot-voice-changer/1.0'

    def log_message(self, fmt, *args):
        pass

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')

    def _json(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> dict:
        length = int(self.headers.get('Content-Length') or 0)
        if length <= 0:
            return {}
        if length > 1024 * 1024:
            raise ValueError('请求体过大')
        return json.loads(self.rfile.read(length).decode('utf-8') or '{}')

    def _html(self, status: int, body: str):
        data = body.encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path.rstrip('/') or '/'
        try:
            if path == '/health':
                self._json(200, {'ok': True, 'service': 'dy-bot-voice-changer'})
            elif path in ('/', '/panel'):
                self._html(200, PANEL_HTML)
            elif path == '/devices':
                self._json(200, {'ok': True, **query_devices()})
            elif path == '/status':
                self._json(200, status_payload())
            elif path == '/config':
                self._json(200, {'ok': True, 'config': load_config()})
            elif path == '/log':
                self._json(200, {'ok': True, 'log': list(LOG_LINES)})
            else:
                self._json(200, {
                    'service': 'dy-bot-voice-changer',
                    'endpoints': ['/health', '/devices', '/status', '/config',
                                  '/log', 'POST /start', 'POST /stop'],
                })
        except Exception as exc:
            self._json(500, {'ok': False, 'error': f'{type(exc).__name__}: {exc}'})

    def do_POST(self):
        path = urlparse(self.path).path.rstrip('/') or '/'
        try:
            body = self._read_body()
            if path == '/start':
                with STATE_LOCK:
                    if STATE['state'] in ('loading', 'running'):
                        stop_stream('重新启动')
                    STATE['state'] = 'loading'
                    STATE['message'] = '正在加载模型…'
                    STATE['error'] = None
                    STATE['stopRequested'] = False
                config = normalize_config({**load_config(), **body})
                save_config(config)
                with STATE_LOCK:
                    STATE['config'] = config
                log('收到启动请求，准备加载音频设备与模型')
                threading.Thread(
                    target=load_and_run, args=(config,), daemon=True,
                ).start()
                self._json(202, {'ok': True, 'state': 'loading', 'config': config})
            elif path == '/stop':
                stop_stream()
                self._json(200, {'ok': True, 'state': 'idle'})
            elif path == '/config':
                config = {**load_config(), **body}
                save_config(config)
                self._json(200, {'ok': True, 'config': config})
            else:
                self._json(404, {'ok': False, 'error': 'not found'})
        except Exception as exc:
            log(traceback.format_exc())
            self._json(400, {'ok': False, 'error': f'{type(exc).__name__}: {exc}'})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8790)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    log(f'实时变声服务已启动：http://{args.host}:{args.port}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop_stream()
        server.server_close()


if __name__ == '__main__':
    main()
