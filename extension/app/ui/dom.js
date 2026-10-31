/** 极小 DOM 辅助函数，避免引入框架。 */

export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'className') node.className = value;
    else if (key === 'textContent') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  if (!node) return;
  node.textContent = '';
}

let toastTimer = 0;
export function toast(message, kind = 'info') {
  const node = document.getElementById('toast');
  if (!node) return;
  node.hidden = false;
  node.textContent = message;
  node.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.className = 'toast';
    node.hidden = true;
  }, 2800);
}

/**
 * 页面内确认框（侧边栏里原生 confirm 不一定可用）。
 * @returns {Promise<boolean>}
 */
export function confirmAction(message) {
  return new Promise((resolve) => {
    const dialog = document.getElementById('confirmDialog');
    const text = document.getElementById('confirmText');
    const ok = document.getElementById('confirmOk');
    const cancel = document.getElementById('confirmCancel');
    if (!dialog || !text || !ok || !cancel || typeof dialog.showModal !== 'function') {
      resolve(true);
      return;
    }

    text.textContent = message;
    const cleanup = () => {
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      dialog.removeEventListener('cancel', onCancelEvent);
    };
    const close = (value) => {
      cleanup();
      dialog.close();
      resolve(value);
    };
    const onOk = () => close(true);
    const onCancel = () => close(false);
    const onCancelEvent = (event) => {
      event.preventDefault();
      close(false);
    };

    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    dialog.addEventListener('cancel', onCancelEvent);
    dialog.showModal();
  });
}
