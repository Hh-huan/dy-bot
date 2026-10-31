/**
 * ISOLATED world 内容脚本：
 *  1. 接收 inject.js 转发来的二进制弹幕帧，base64 后发给扩展页面解码；
 *  2. 接收扩展页面的回复指令，在页面上「输入 + 点击发送」；
 *  3. 上报页面地址 / 标题 / 输入框状态。
 *
 * 之所以用「模拟页面输入」而不是直接调接口：这样可以复用页面已登录的 Cookie
 * 和页面自身的签名参数（a_bogus 等），比逆向签名稳定得多。
 */
(() => {
  const ext = globalThis.chrome;
  if (!ext || !ext.runtime) return;

  const INPUT_SELECTORS = [
    'textarea[data-e2e="chat-input"]',
    '[data-e2e="chat-input"] textarea',
    'div[data-e2e="chat-input"][contenteditable="true"]',
    'textarea.webcast-chatroom___textarea',
    '.webcast-chatroom___input-container textarea',
    '.webcast-chatroom___input-container [contenteditable="true"]',
    '[class*="chatroom"] textarea',
    '[class*="chatroom"] [contenteditable="true"]',
    '[class*="ChatRoom"] textarea',
    '[class*="ChatRoom"] [contenteditable="true"]',
    '[class*="input-container"] textarea',
    'textarea[placeholder*="说点什么"]',
    'textarea[placeholder*="发弹幕"]',
    '[contenteditable="true"][data-placeholder*="说点什么"]',
    '[contenteditable="true"][aria-label*="弹幕"]',
  ];

  const SEND_SELECTORS = [
    '[data-e2e="chat-send-button"]',
    '.webcast-chatroom___send-btn',
    '[class*="send-btn"]',
    '[class*="sendBtn"]',
    '[class*="SendButton"]',
    'button[aria-label*="发送"]',
  ];

  const PLACEHOLDER_HINTS = /说点什么|聊点什么|发弹幕|发送弹幕|和大家|公屏/;

  function isVisible(element) {
    if (!element || !(element instanceof Element)) return false;
    if (element.offsetParent === null && getComputedStyle(element).position !== 'fixed') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 4 && rect.height > 4;
  }

  function findInput() {
    for (const selector of INPUT_SELECTORS) {
      let nodes = [];
      try {
        nodes = document.querySelectorAll(selector);
      } catch {
        continue;
      }
      for (const node of nodes) {
        if (isVisible(node)) return node;
      }
    }

    // 兜底：按 placeholder / data-placeholder 特征找可见的输入区域
    const candidates = document.querySelectorAll('textarea, [contenteditable="true"]');
    for (const node of candidates) {
      if (!isVisible(node)) continue;
      const hint =
        node.getAttribute('placeholder') ||
        node.getAttribute('data-placeholder') ||
        node.getAttribute('aria-label') ||
        '';
      if (PLACEHOLDER_HINTS.test(hint)) return node;
    }
    return null;
  }

  function findSendButton(input) {
    const roots = [];
    let node = input ? input.parentElement : null;
    for (let i = 0; i < 6 && node; i += 1) {
      roots.push(node);
      node = node.parentElement;
    }

    for (const selector of SEND_SELECTORS) {
      let nodes = [];
      try {
        nodes = document.querySelectorAll(selector);
      } catch {
        continue;
      }
      for (const candidate of nodes) {
        if (!isVisible(candidate)) continue;
        if (roots.some((root) => root.contains(candidate))) return candidate;
      }
    }

    // 在输入框附近的容器里找文字为「发送」的按钮
    for (const root of roots) {
      const nodes = root.querySelectorAll('button, [role="button"], span, div');
      for (const candidate of nodes) {
        if (candidate === input || candidate.contains(input)) continue;
        if (!isVisible(candidate)) continue;
        const text = (candidate.textContent || '').trim();
        if (text === '发送' || text === '发送弹幕') return candidate;
      }
    }
    return null;
  }

  function readText(input) {
    if (!input) return '';
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') return String(input.value || '');
    return String(input.innerText || input.textContent || '');
  }

  function setNativeValue(element, text) {
    const proto = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(element, text);
    else element.value = text;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setContentEditableValue(element, text) {
    element.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('delete', false);
    document.execCommand('insertText', false, text);

    // 某些编辑器会拦截 execCommand，退化为直接写 textContent
    if (!readText(element).trim()) {
      element.textContent = text;
    }

    element.dispatchEvent(
      new InputEvent('input', { bubbles: true, cancelable: false, inputType: 'insertText', data: text }),
    );
  }

  function pressElement(element) {
    try {
      element.scrollIntoView({ block: 'center', behavior: 'auto' });
    } catch {
      /* ignore */
    }
    const rect = element.getBoundingClientRect();
    const options = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    const fire = (type) => {
      try {
        if (type.startsWith('pointer') && typeof PointerEvent === 'function') {
          element.dispatchEvent(new PointerEvent(type, { ...options, pointerId: 1, isPrimary: true }));
        } else {
          element.dispatchEvent(new MouseEvent(type, options));
        }
      } catch {
        /* ignore */
      }
    };
    fire('pointerdown');
    fire('mousedown');
    fire('pointerup');
    fire('mouseup');
    // 只触发一次 click，避免重复发送
    if (typeof element.click === 'function') {
      try {
        element.click();
      } catch {
        /* ignore */
      }
    } else {
      fire('click');
    }
  }

  function pressEnter(input) {
    const options = {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    };
    input.dispatchEvent(new KeyboardEvent('keydown', options));
    input.dispatchEvent(new KeyboardEvent('keypress', options));
    input.dispatchEvent(new KeyboardEvent('keyup', options));
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function sendReply(text, options = {}) {
    const input = findInput();
    if (!input) {
      return {
        ok: false,
        error: '未找到评论输入框：请确认已打开抖音直播间、已登录，并等待页面加载完成',
      };
    }

    const clean = String(text || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100);
    if (!clean) return { ok: false, error: '回复内容为空' };

    if (options.dryRun) {
      return { ok: true, dryRun: true, method: 'dry-run', hasInput: true };
    }

    try {
      if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') setNativeValue(input, clean);
      else setContentEditableValue(input, clean);
    } catch (error) {
      return { ok: false, error: `写入输入框失败：${error && error.message ? error.message : error}` };
    }

    await sleep(120);
    if (!readText(input).trim()) {
      return { ok: false, error: '写入输入框失败：内容被页面清空（可能未登录或已被禁言）' };
    }

    const button = findSendButton(input);
    let method = 'enter';
    if (button) {
      pressElement(button);
      method = 'click';
    } else {
      pressEnter(input);
    }

    await sleep(250);
    let cleared = readText(input).trim() === '';
    // 只有在没找到发送按钮时才用回车兜底，避免同一条内容被发送两次
    if (!cleared && !button) {
      pressEnter(input);
      await sleep(220);
      cleared = readText(input).trim() === '';
    }

    return {
      ok: true,
      method,
      cleared,
      warning: cleared ? '' : '输入框内容未清空，回复可能没有真正发出，请到直播间确认',
    };
  }

  function toBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function sendToExtension(payload) {
    try {
      const result = ext.runtime.sendMessage(payload);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      /* 扩展被重载时忽略 */
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__dybot !== true || data.kind !== 'frame' || !data.buffer) return;
    try {
      const bytes = new Uint8Array(data.buffer);
      sendToExtension({
        type: 'dy-frame',
        b64: toBase64(bytes),
        socketUrl: data.url || '',
        pageUrl: location.href,
        title: document.title,
      });
    } catch {
      /* ignore */
    }
  });

  function reportPage() {
    sendToExtension({
      type: 'dy-page',
      pageUrl: location.href,
      title: document.title,
      hasInput: Boolean(findInput()),
    });
  }

  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      reportPage();
    }
  }, 1500);

  ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return false;

    if (message.type === 'dy-ping') {
      sendResponse({
        ok: true,
        hasInput: Boolean(findInput()),
        url: location.href,
        title: document.title,
      });
      return false;
    }

    if (message.type === 'dy-reply') {
      sendReply(String(message.text || ''), { dryRun: Boolean(message.dryRun) })
        .then((result) => sendResponse(result))
        .catch((error) =>
          sendResponse({ ok: false, error: String(error && error.message ? error.message : error) }),
        );
      return true;
    }

    return false;
  });
})();
