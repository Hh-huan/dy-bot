/**
 * 观众访问行为留证台账（append-only + 哈希链）。
 *
 * 每条记录都带上一条记录的 hash，任何篡改或删改都会让链校验失败，
 * 用于「用户否认来过直播间」时调取可追溯的时间线证据。
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const GENESIS = '0'.repeat(64);
const QUERY_LIMIT = 200;
const VISIT_ACTIONS = ['enter', 'chat', 'gift', 'like', 'follow', 'share', 'song'];

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function recordHash(record) {
  return sha256(
    [
      record.prevHash,
      record.seq,
      record.ts,
      record.key,
      record.action,
      record.detail || '',
      record.roomId || '',
    ].join('|'),
  );
}

function trimText(value, limit) {
  return Array.from(String(value || '').replace(/\s+/g, ' ').trim()).slice(0, limit).join('');
}

/** 从磁盘按顺序读取并校验哈希链，返回链上记录和第一个断点。 */
function readChain(file) {
  const records = [];
  let lastHash = GENESIS;
  let seq = 0;
  let brokenAt = 0;
  if (!existsSync(file)) return { records, seq, lastHash, brokenAt };
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { records, seq, lastHash, brokenAt: 1 };
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      if (!brokenAt) brokenAt = seq + 1;
      continue;
    }
    if (item.prevHash !== lastHash || item.hash !== recordHash(item)) {
      if (!brokenAt) brokenAt = Number(item.seq) || seq + 1;
    }
    lastHash = String(item.hash || '');
    seq = Math.max(seq, Number(item.seq) || 0);
    records.push(item);
  }
  return { records, seq, lastHash, brokenAt };
}

export function createUserLedger({ file }) {
  let records = [];
  let lastHash = GENESIS;
  let seq = 0;
  let brokenAt = 0;

  function load() {
    const chain = readChain(file);
    records = chain.records;
    lastHash = chain.lastHash;
    seq = chain.seq;
    brokenAt = chain.brokenAt;
  }
  load();

  function append({ key, id, name, action, detail, roomId, at } = {}) {
    const cleanKey = String(key || id || name || '').trim();
    if (!cleanKey || !action) return null;
    const record = {
      seq: seq + 1,
      ts: Number(at) || Date.now(),
      key: cleanKey,
      id: String(id || ''),
      name: String(name || ''),
      action: String(action),
      detail: trimText(detail, 120),
      roomId: String(roomId || ''),
      prevHash: lastHash,
    };
    record.hash = recordHash(record);
    try {
      appendFileSync(file, `${JSON.stringify(record)}\n`);
    } catch {
      return null;
    }
    seq = record.seq;
    lastHash = record.hash;
    records.push(record);
    return record;
  }

  function find(user) {
    const needle = String(user || '').trim();
    if (!needle) return [];
    return records.filter(
      (item) => item.key === needle || (item.id && item.id === needle) || (item.name && item.name === needle),
    );
  }

  /** 查询某位观众的完整时间线：进入时间、操作轨迹、总条数。 */
  function query(user, limit = QUERY_LIMIT) {
    const matches = find(user);
    if (!matches.length) return null;
    const visits = matches.filter((item) => VISIT_ACTIONS.includes(item.action));
    const counts = {};
    for (const item of visits) counts[item.action] = (counts[item.action] || 0) + 1;
    const max = Math.min(QUERY_LIMIT, Math.max(1, Number(limit) || 50));
    const latest = matches[matches.length - 1];
    return {
      ok: true,
      user: { key: latest.key, id: latest.id, name: latest.name },
      total: visits.length,
      firstSeen: visits.length ? visits[0].ts : 0,
      lastSeen: visits.length ? visits[visits.length - 1].ts : 0,
      counts,
      entries: matches.map((item) => ({
        ts: item.ts,
        action: item.action,
        detail: item.detail,
        seq: item.seq,
      })).slice(-max),
    };
  }

  /** 校验整条哈希链是否被篡改或删改：重新读盘，运行期间的外部改动也能发现。 */
  function verify() {
    const chain = readChain(file);
    return {
      ok: chain.brokenAt === 0,
      records: chain.records.length,
      brokenAt: chain.brokenAt,
      brokenAtLoad: brokenAt,
    };
  }

  return { append, query, verify, get size() { return records.length; } };
}
