/* 礼物连击去重：累计 repeatCount 只补差额，结束帧丢失也不会漏统计。 */
(function (root) {
  const DEFAULT_TTL_MS = 5 * 60 * 1000;

  function createComboTracker(options) {
    const opts = options || {};
    const ttlMs = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : DEFAULT_TTL_MS;
    const now = typeof opts.now === 'function' ? opts.now : Date.now;
    const combos = new Map();

    function prune(ts) {
      for (const [key, entry] of combos) {
        if (ts - entry.at > ttlMs) combos.delete(key);
      }
      return ts;
    }

    /**
     * 返回这一帧应统计的数量差额。
     * @param {{id?:string,nickname?:string}} user
     * @param {string} giftId
     * @param {string} giftName
     * @param {number} count 本帧的累计数量（repeatCount）
     * @param {boolean} completed 是否连击结束帧
     */
    function delta(user, giftId, giftName, count, completed) {
      const ts = prune(now());
      const total = Math.max(1, Number(count) || 1);
      const who = String((user && (user.id || user.nickname)) || 'anon');
      const key = `${who}|${String(giftId || giftName || '礼物')}`;
      const prev = combos.get(key);
      let diff = total;
      if (prev) {
        // 累计值在增长：只补差额
        if (total > prev.count) diff = total - prev.count;
        // 结束帧会重复上一帧的累计值（如 ×5 连击中 → ×5），不能整段再计一次
        else if (total === prev.count) diff = 0;
        // total < prev.count：上一轮结束帧丢失后又开了一轮，整帧计入
      }
      if (completed) combos.delete(key);
      else combos.set(key, { count: total, at: ts });
      return Math.max(0, diff);
    }

    function snapshot() {
      return [...combos];
    }

    function restore(entries) {
      if (!Array.isArray(entries)) return;
      const ts = now();
      for (const [key, entry] of entries) {
        const at = Number(entry && entry.at) || 0;
        if (!key || !at || ts - at > ttlMs) continue;
        combos.set(String(key), { count: Math.max(1, Number(entry.count) || 1), at });
      }
    }

    function clear() {
      combos.clear();
    }

    return { delta, snapshot, restore, clear };
  }

  root.GiftCombo = { createComboTracker, DEFAULT_TTL_MS };
})(typeof globalThis !== 'undefined' ? globalThis : window);
