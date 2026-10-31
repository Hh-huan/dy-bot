/** Token 用量按上海日期分日统计。 */

export function tokenDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(date);
}

function safeNumber(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

export function normalizeTokenRecord(raw, today = tokenDateKey()) {
  if (typeof raw === 'number') {
    const n = safeNumber(raw);
    return { date: today, tokens: n, total: n };
  }
  if (!raw || typeof raw !== 'object') return { date: today, tokens: 0, total: 0 };
  const tokens = safeNumber(raw.tokens);
  const total = Math.max(safeNumber(raw.total), tokens);
  if (raw.date !== today) return { date: today, tokens: 0, total };
  return { date: today, tokens, total };
}

export function addTokenRecord(record, amount, today = tokenDateKey()) {
  const base = normalizeTokenRecord(record, today);
  const add = safeNumber(amount);
  return { date: today, tokens: base.tokens + add, total: base.total + add };
}
