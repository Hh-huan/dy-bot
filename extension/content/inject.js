/**
 * MAIN world 注入脚本：在页面创建 WebSocket 之前替换构造函数，
 * 旁路监听抖音直播的弹幕推送（webcast/im/push/v2），把二进制帧转发给 bridge.js。
 *
 * 注意：只读监听，不修改、不阻塞页面原有消息；页面自身的心跳 / 签名逻辑保持不变。
 */
(() => {
  const MARK = '__dyLiveCompanionHooked__';
  if (window[MARK]) return;
  Object.defineProperty(window, MARK, { value: true, configurable: false });

  const NativeWebSocket = window.WebSocket;
  if (typeof NativeWebSocket !== 'function') return;

  const isDanmakuSocket = (url) => typeof url === 'string' && url.includes('/webcast/im/push/');

  function forward(bytes, url) {
    try {
      const copy = bytes.slice();
      window.postMessage(
        { __dybot: true, kind: 'frame', buffer: copy.buffer, url },
        '*',
        [copy.buffer],
      );
    } catch {
      /* 页面 CSP 或跨域限制时静默失败 */
    }
  }

  function handleData(data, url) {
    if (!data) return;
    if (data instanceof ArrayBuffer) {
      forward(new Uint8Array(data), url);
      return;
    }
    if (ArrayBuffer.isView(data)) {
      forward(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), url);
      return;
    }
    if (typeof Blob === 'function' && data instanceof Blob) {
      data
        .arrayBuffer()
        .then((buffer) => forward(new Uint8Array(buffer), url))
        .catch(() => {});
    }
  }

  function WrappedWebSocket(url, protocols) {
    const socket = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
    if (isDanmakuSocket(String(url))) {
      try {
        socket.addEventListener('message', (event) => handleData(event.data, socket.url || String(url)));
      } catch {
        /* ignore */
      }
    }
    return socket;
  }

  WrappedWebSocket.prototype = NativeWebSocket.prototype;
  for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
    try {
      Object.defineProperty(WrappedWebSocket, key, { value: NativeWebSocket[key] });
    } catch {
      /* ignore */
    }
  }
  try {
    Object.setPrototypeOf(WrappedWebSocket, NativeWebSocket);
  } catch {
    /* ignore */
  }

  window.WebSocket = WrappedWebSocket;
})();
