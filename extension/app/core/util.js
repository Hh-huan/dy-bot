/** 通用小工具（无 DOM 依赖的放这里，UI 里也能用）。 */

export function fmtClock(ts) {
  const date = new Date(ts || Date.now());
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

export function fmtNumber(value) {
  const n = Number(value) || 0;
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return String(n);
}

export function splitLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function debounce(fn, wait = 300) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export function b64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToB64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function downloadText(filename, text, mime = 'application/json;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function escapeCsv(value) {
  const text = String(value ?? '');
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(rows, columns) {
  const head = columns.map((col) => escapeCsv(col.label)).join(',');
  const body = rows.map((row) => columns.map((col) => escapeCsv(col.get(row))).join(','));
  return [head, ...body].join('\r\n');
}

export function todayStamp() {
  const date = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(
    date.getMinutes(),
  )}`;
}

export function uid(prefix = 'id') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 从抖音直播间链接里取房间号（web_rid）。
 * 支持 https://live.douyin.com/123456789 以及带 query 的链接；
 * 不是抖音直播间地址时返回空字符串。
 */
export function roomKeyFromUrl(raw) {
  if (!raw) return '';
  try {
    const url = new URL(String(raw));
    const host = url.hostname.toLowerCase();
    const isDouyin = host === 'douyin.com' || host.endsWith('.douyin.com');
    if (!isDouyin) return '';
    if (host !== 'live.douyin.com' && !/live/i.test(url.pathname)) return '';
    const match = url.pathname.match(/\/(\d{5,})(?:\/|$)/);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

/** 把用户输入整理成标准的直播间链接。 */
export function normalizeRoomUrl(raw) {
  let text = String(raw || '').trim();
  if (/^\d{5,}$/.test(text)) return `https://live.douyin.com/${text}`;
  if (/^(?:[\w-]+\.)?douyin\.com\//i.test(text)) text = `https://${text}`;
  const key = roomKeyFromUrl(text);
  return key ? `https://live.douyin.com/${key}` : '';
}

/** 允许在设置里直接粘贴链接或只输入房间号。 */
export function parseRoomInput(raw) {
  return normalizeRoomUrl(raw);
}
