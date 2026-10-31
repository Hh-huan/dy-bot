/**
 * 大肥鱼（AI 助理）跨直播记忆存储。
 *
 * 每场直播结束时由扩展把 AI 总结的一句话追加进来，落盘 memory.json；
 * 下次开播时扩展拉取最近记忆，注入 AI 回复的 system 上下文。
 */

import { readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';

const MAX_MEMORIES = 40;
const MAX_TEXT = 160;
const MAX_VIEWERS = 60;

/** 只保留简单的观众信息：谁、做过什么、留个印象，避免记忆文件膨胀。 */
function sanitizeViewers(viewers) {
  if (!Array.isArray(viewers)) return [];
  return viewers
    .slice(0, MAX_VIEWERS)
    .map((item) => ({
      key: String((item && item.key) || '').slice(0, 40),
      name: String((item && item.name) || '').slice(0, 24),
      id: String((item && item.id) || '').slice(0, 40),
      actions: Array.isArray(item && item.actions)
        ? item.actions.map((action) => String(action || '').slice(0, 6)).slice(0, 6)
        : [],
      note: String((item && item.note) || '').slice(0, 60),
    }))
    .filter((item) => item.key || item.name);
}

/** 同一场直播的多次存档合并观众：保留最新顺序，动作取并集，印象取更完整的那条。 */
function mergeViewers(prev, next) {
  const merged = new Map();
  for (const item of next) {
    merged.set(item.key || item.name, { ...item, actions: [...item.actions] });
  }
  for (const item of prev) {
    const key = item.key || item.name;
    if (!key) continue;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, { ...item, actions: [...item.actions] });
      continue;
    }
    merged.set(key, {
      ...current,
      actions: [...new Set([...current.actions, ...item.actions])],
      note: String(item.note || '').length > String(current.note || '').length ? item.note : current.note,
    });
  }
  return [...merged.values()];
}

export function createMemoryStore({ file }) {
  let cache = null;

  async function load() {
    if (cache) return cache;
    try {
      const data = JSON.parse(await readFile(file, 'utf8'));
      cache = {
        version: Number(data.version) || 1,
        memories: Array.isArray(data.memories) ? data.memories : [],
      };
    } catch {
      cache = { version: 1, memories: [] };
    }
    return cache;
  }

  function persist() {
    try {
      writeFileSync(file, `${JSON.stringify(cache, null, 2)}\n`);
    } catch {
      /* 磁盘不可用时静默，内存中仍保留本场记忆 */
    }
  }

  /** 最近记忆（默认 10 条），供开播时注入 AI 上下文 */
  async function list(limit = 10) {
    const data = await load();
    const n = Math.max(1, Math.min(MAX_MEMORIES, Number(limit) || 10));
    return {
      ok: true,
      version: data.version,
      memories: data.memories.slice(-n),
    };
  }

  /**
   * 追加一条记忆：{ text, kind, viewers, sessionKey }，kind ∈ live | manual。
   * 同一场直播（sessionKey 相同）重复存档时更新最后一条，不再新增重复记录。
   */
  async function add({ text, kind, viewers, sessionKey } = {}) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    if (!clean) return { ok: false, error: 'text is required' };
    const data = await load();
    const at = Date.now();
    const key = String(sessionKey || '').slice(0, 80);
    const entry = {
      at,
      kind: String(kind || 'live'),
      text: clean,
      viewers: sanitizeViewers(viewers),
    };
    if (key) entry.sessionKey = key;
    const last = data.memories[data.memories.length - 1];
    const merged = Boolean(key && last && last.sessionKey === key);
    if (merged) {
      last.at = at;
      last.kind = entry.kind;
      last.text = clean;
      last.viewers = mergeViewers(last.viewers || [], entry.viewers);
    } else {
      data.memories.push(entry);
      while (data.memories.length > MAX_MEMORIES) data.memories.shift();
    }
    data.updatedAt = at;
    persist();
    return { ok: true, at, count: data.memories.length, merged };
  }

  return { list, add };
}
