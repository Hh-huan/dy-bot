/**
 * 直播间气泡队列管理
 *
 * - 免费气泡：定时任务在队列数量低于阈值时，从在线用户池随机补 1 个，tag 固定为 'free'
 * - 队列已满（达到阈值）时：只要队列里还有已离场的 free 气泡，就用「当前在场且不在队列中」
 *   的观众原位替换它，让气泡始终对应直播间当前观众
 * - 付费气泡：新送礼用户入队时，替换队列里最早进入的 free 气泡；没有 free 时按原逻辑追加
 * - 免费气泡用户送礼：先摘掉其 free 标签，再走付费气泡处理（不会重复生成气泡）
 * - 所有变更通过互斥锁串行化并落盘，避免重复添加 / 替换错位 / 统计不一致
 */

export const FREE_TAG = 'free';

const AVATAR_MAX_LEN = 3000;

/** 极简异步互斥锁：同一队列的所有写操作串行执行 */
export function createAsyncMutex() {
  let tail = Promise.resolve();
  return {
    run(task) {
      const result = tail.then(() => task());
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

function normalizeKey(value) {
  return String(value || '').trim();
}

function normalizeUser(user) {
  if (!user) return null;
  const key = normalizeKey(user.key || user.id || user.nickname || user.name);
  const name = String(user.name || user.nickname || '').trim();
  if (!key || !name) return null;
  return { key, name, avatar: String(user.avatar || '').slice(0, AVATAR_MAX_LEN) };
}

export function createBubbleQueue(options = {}) {
  const now = options.now || Date.now;
  const random = options.random || Math.random;
  const logger = options.logger || (() => {});
  const persist = options.persist || null;
  const restore = options.restore || null;
  const onChange = options.onChange || null;
  const mutex = options.mutex || createAsyncMutex();

  let entries = [];
  let seq = 0;

  function log(level, message, detail) {
    try {
      logger({ level, message, detail: detail || null, at: now() });
    } catch {
      /* 日志不能影响主流程 */
    }
  }

  function clone(entry) {
    const copy = {
      key: entry.key,
      name: entry.name,
      avatar: entry.avatar,
      enteredAt: entry.enteredAt,
      seq: entry.seq,
    };
    if (entry.tag === FREE_TAG) copy.tag = FREE_TAG;
    if (entry.paidAt) copy.paidAt = entry.paidAt;
    if (entry.replacedKey) copy.replacedKey = entry.replacedKey;
    return copy;
  }

  function save() {
    if (!persist) return;
    try {
      persist({ version: 1, savedAt: now(), seq, entries: entries.map(clone) });
    } catch (error) {
      log('warn', '气泡队列存档失败', { error: String((error && error.message) || error) });
    }
  }

  // 启动即恢复上一次的队列（页面异常刷新/重启后衔接原有气泡）
  function bootstrap() {
    if (!restore) return;
    try {
      const payload = restore();
      if (!payload || !Array.isArray(payload.entries)) return;
      const seen = new Set();
      for (const raw of payload.entries) {
        const user = normalizeUser(raw);
        if (!user || seen.has(user.key)) continue;
        seen.add(user.key);
        const item = {
          ...user,
          tag: raw.tag === FREE_TAG ? FREE_TAG : undefined,
          enteredAt: Number(raw.enteredAt) || now(),
          seq: Number(raw.seq) || 0,
        };
        if (!item.tag) delete item.tag;
        if (raw.paidAt) item.paidAt = Number(raw.paidAt) || item.enteredAt;
        entries.push(item);
        seq = Math.max(seq, item.seq);
      }
      log('info', '气泡队列已从本地存档恢复', { restored: entries.length });
    } catch (error) {
      log('warn', '气泡队列存档读取失败，按空队列启动', {
        error: String((error && error.message) || error),
      });
    }
  }

  bootstrap();

  function size() {
    return entries.length;
  }

  function snapshot() {
    return entries.map(clone);
  }

  function has(key) {
    const target = normalizeKey(key);
    return Boolean(target) && entries.some((entry) => entry.key === target);
  }

  // 入队时间正序：最早进入的 free 气泡排在前面
  function oldestFreeIndex() {
    let index = -1;
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      if (entry.tag !== FREE_TAG) continue;
      if (index < 0) {
        index = i;
        continue;
      }
      const best = entries[index];
      if (entry.enteredAt < best.enteredAt || (entry.enteredAt === best.enteredAt && entry.seq < best.seq)) {
        index = i;
      }
    }
    return index;
  }

  // 最早进入、且已经不在直播间的 free 气泡（入队时间正序，同值比 seq）
  function oldestStaleFreeIndex(liveKeys) {
    let index = -1;
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      if (entry.tag !== FREE_TAG || liveKeys.has(entry.key)) continue;
      if (index < 0) {
        index = i;
        continue;
      }
      const best = entries[index];
      if (entry.enteredAt < best.enteredAt || (entry.enteredAt === best.enteredAt && entry.seq < best.seq)) {
        index = i;
      }
    }
    return index;
  }

  // 队列已满：用在场且不在队列中的观众，替换最早离场的 free 气泡（原位替换，数量不变）
  function replaceStaleFree(candidates, liveKeys, target) {
    const staleIndex = oldestStaleFreeIndex(liveKeys);
    if (staleIndex < 0) {
      log('info', '气泡队列已达阈值，无需补充', { size: entries.length, threshold: target });
      return { added: false, reason: 'full', size: entries.length };
    }
    if (!candidates.length) {
      log('warn', '队列已满且存在离场免费气泡，但在场观众都已入队，本轮不替换', {
        size: entries.length,
        threshold: target,
        poolSize: liveKeys.size,
      });
      return { added: false, reason: 'no-candidate', size: entries.length };
    }
    const old = entries[staleIndex];
    const pick = candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))];
    const entry = { ...pick, tag: FREE_TAG, enteredAt: now(), seq: (seq += 1), replacedKey: old.key };
    entries[staleIndex] = entry;
    save();
    log('info', '队列已满，用在场的免费观众替换已离场的免费气泡', {
      threshold: target,
      size: entries.length,
      from: { key: old.key, name: old.name },
      to: { key: entry.key, name: entry.name },
    });
    return { added: true, reason: 'replaced-stale', size: entries.length, entry: clone(entry) };
  }

  function fillOne(threshold, pool) {
    const target = Math.max(0, Math.round(Number(threshold) || 0));
    if (target <= 0) {
      log('warn', '气泡数量阈值未配置，跳过补充');
      return { added: false, reason: 'no-threshold', size: entries.length };
    }
    // 在线池同时用于两件事：挑补充候选、判断 free 气泡是否已经离场
    const candidates = [];
    const liveKeys = new Set();
    const seen = new Set();
    for (const raw of Array.isArray(pool) ? pool : []) {
      const user = normalizeUser(raw);
      if (!user) continue;
      liveKeys.add(user.key);
      if (seen.has(user.key) || has(user.key)) continue;
      seen.add(user.key);
      candidates.push(user);
    }
    if (entries.length >= target) return replaceStaleFree(candidates, liveKeys, target);
    if (!candidates.length) {
      log('warn', '在线用户池没有可补充的候选', {
        size: entries.length,
        threshold: target,
        poolSize: liveKeys.size,
      });
      return { added: false, reason: 'no-candidate', size: entries.length };
    }
    const pick = candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))];
    const entry = { ...pick, tag: FREE_TAG, enteredAt: now(), seq: (seq += 1) };
    entries.push(entry);
    save();
    log('info', '定时补充免费气泡', {
      threshold: target,
      size: entries.length,
      key: entry.key,
      name: entry.name,
    });
    return { added: true, reason: 'filled', size: entries.length, entry: clone(entry) };
  }

  function promotePaid(user) {
    const target = normalizeUser(user);
    if (!target) return { changed: 'invalid', entry: null };
    const existing = entries.find((entry) => entry.key === target.key);
    if (existing) {
      // 额外规则：带 free 标识的用户主动送礼，先摘掉 free 标签，再按付费气泡处理
      if (existing.tag === FREE_TAG) {
        delete existing.tag;
        existing.paidAt = now();
        save();
        log('info', '免费气泡用户送礼，已移除 free 标签', {
          key: existing.key,
          name: existing.name,
          size: entries.length,
        });
        return { changed: 'untagged', entry: clone(existing) };
      }
      return { changed: 'exists', entry: clone(existing) };
    }
    const freeIndex = oldestFreeIndex();
    if (freeIndex >= 0) {
      const old = entries[freeIndex];
      const entry = {
        key: target.key,
        name: target.name,
        avatar: target.avatar || old.avatar || '',
        enteredAt: now(),
        seq: (seq += 1),
        paidAt: now(),
        replacedKey: old.key,
      };
      entries[freeIndex] = entry;
      save();
      log('info', '付费气泡替换最早的免费气泡', {
        from: { key: old.key, name: old.name, enteredAt: old.enteredAt },
        to: { key: entry.key, name: entry.name },
        size: entries.length,
      });
      return { changed: 'replaced', entry: clone(entry) };
    }
    const entry = {
      key: target.key,
      name: target.name,
      avatar: target.avatar,
      enteredAt: now(),
      seq: (seq += 1),
      paidAt: now(),
    };
    entries.push(entry);
    save();
    log('info', '队列无免费气泡，付费气泡按原逻辑追加', {
      key: entry.key,
      name: entry.name,
      size: entries.length,
    });
    return { changed: 'appended', entry: clone(entry) };
  }

  async function onGift(user) {
    const result = await mutex.run(() => promotePaid(user));
    if (onChange) {
      try {
        onChange('gift', result);
      } catch {
        /* 渲染回调异常不影响队列 */
      }
    }
    return result;
  }

  async function fill(options = {}) {
    const result = await mutex.run(() => fillOne(options.threshold, options.pool));
    if (onChange) {
      try {
        onChange('fill', result);
      } catch {
        /* 渲染回调异常不影响队列 */
      }
    }
    return result;
  }

  async function clear(reason = 'reset') {
    const removed = await mutex.run(() => {
      const count = entries.length;
      entries = [];
      save();
      log('info', '清空气泡队列', { removed: count, reason });
      return count;
    });
    if (onChange) {
      try {
        onChange('clear', { removed });
      } catch {
        /* 渲染回调异常不影响队列 */
      }
    }
    return removed;
  }

  return { size, snapshot, has, onGift, fill, clear };
}

/**
 * 气泡队列定时任务：每隔 intervalMs 检查一次并补充免费气泡。
 * - 启动即注册，异常只记录日志、定时器保持运行（等价于异常恢复）
 * - 上一轮未结束时本轮跳过，避免并发重入
 * - 可通过 wrap 注入跨实例锁（例如浏览器 Web Locks）
 */
export function startBubbleQueueScheduler(options = {}) {
  const queue = options.queue;
  if (!queue || typeof queue.fill !== 'function') {
    throw new TypeError('startBubbleQueueScheduler 需要合法的 queue');
  }
  const intervalMs = Math.max(1000, Number(options.intervalMs) || 60000);
  const logger = options.logger || (() => {});
  const setIntervalImpl = options.setIntervalImpl || setInterval;
  const clearIntervalImpl = options.clearIntervalImpl || clearInterval;
  const wrap = options.wrap || ((task) => task());
  let busy = false;
  let timer = null;

  function log(level, message, detail) {
    try {
      logger({ level, message, detail: detail || null, at: Date.now() });
    } catch {
      /* ignore */
    }
  }

  async function runOnce() {
    if (busy) {
      log('info', '上一轮气泡检查尚未结束，本轮跳过');
      return { skipped: true };
    }
    busy = true;
    try {
      return await wrap(async () => {
        const threshold =
          typeof options.threshold === 'function' ? options.threshold() : options.threshold;
        const pool = typeof options.pool === 'function' ? options.pool() : options.pool;
        return queue.fill({ threshold, pool });
      });
    } catch (error) {
      log('warn', '定时检查气泡队列失败，本轮跳过', {
        error: String((error && error.message) || error),
      });
      return { error: String((error && error.message) || error) };
    } finally {
      busy = false;
    }
  }

  timer = setIntervalImpl(() => {
    runOnce().catch(() => {});
  }, intervalMs);
  log('info', '气泡队列定时任务已注册', { intervalMs });

  if (options.runImmediately) runOnce().catch(() => {});

  return {
    intervalMs,
    runOnce,
    stop() {
      if (timer) clearIntervalImpl(timer);
      timer = null;
      log('info', '气泡队列定时任务已停止');
    },
  };
}
