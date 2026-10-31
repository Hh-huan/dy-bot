/**
 * 违规歌曲 / 拉黑用户存储（纯 ESM、零依赖）。
 *
 * - 违规记录：歌曲被大模型或主播判定违规后留档，下次点歌前置校验直接拒绝。
 * - 拉黑用户：点过违规歌曲的用户被拉黑，后续点歌 / 切歌 / 插队请求都不再处理。
 * - 写盘使用「临时文件 + rename」的原子写入；写盘失败会抛错，便于调用方回滚。
 * - path 为空时纯内存可用（测试场景）。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SONG_FIELDS = ['id', 'title', 'artist', 'reason', 'allowPlay', 'createdAt', 'requester', 'requesterKey'];

/** 歌名/歌手归一化：trim → toLowerCase → 去掉全部空白，用于「完全匹配」。 */
export function normalizeExactSongText(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

/** 歌名 + 歌手完全匹配：歌手缺失时仅当另一方歌手也为空才算匹配。 */
export function sameSongExact(aTitle, aArtist, bTitle, bArtist) {
  return (
    normalizeExactSongText(aTitle) === normalizeExactSongText(bTitle) &&
    normalizeExactSongText(aArtist) === normalizeExactSongText(bArtist)
  );
}

function cloneRecord(record) {
  return { ...record };
}

function createRecordId(now) {
  return `vio-${now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @param {object} options
 * @param {string} [options.path] 持久化文件路径，为空时仅在内存中工作
 * @param {() => number} [options.now] 时间源，便于测试
 */
export function createViolationStore(options = {}) {
  const filePath = String(options.path || '');
  const now = options.now || (() => Date.now());
  let violations = [];
  let blockedUsers = [];

  function sanitizeViolation(record) {
    if (!record || typeof record !== 'object') return null;
    const title = String(record.title || '').trim();
    if (!title) return null;
    return {
      id: String(record.id || createRecordId(now)),
      title,
      artist: String(record.artist || '').trim(),
      reason: String(record.reason || ''),
      allowPlay: Boolean(record.allowPlay),
      createdAt: Number(record.createdAt) || now(),
      requester: String(record.requester || ''),
      requesterKey: String(record.requesterKey || ''),
    };
  }

  function sanitizeBlocked(record) {
    if (!record || typeof record !== 'object') return null;
    const userKey = String(record.userKey || '').trim();
    if (!userKey) return null;
    return {
      userKey,
      nickname: String(record.nickname || ''),
      reason: String(record.reason || ''),
      blockedAt: Number(record.blockedAt) || now(),
    };
  }

  /** 读取持久化文件；文件不存在或格式异常时按空数据启动。 */
  function load() {
    if (!filePath) return snapshot();
    try {
      const saved = JSON.parse(readFileSync(filePath, 'utf8'));
      violations = Array.isArray(saved.violations)
        ? saved.violations.map(sanitizeViolation).filter(Boolean)
        : [];
      blockedUsers = Array.isArray(saved.blockedUsers)
        ? saved.blockedUsers.map(sanitizeBlocked).filter(Boolean)
        : [];
    } catch {
      violations = [];
      blockedUsers = [];
    }
    return snapshot();
  }

  function listViolations() {
    return violations.map(cloneRecord);
  }

  /** 查找「歌名 + 歌手」完全匹配的违规记录。 */
  function findExact(title, artist) {
    return (
      violations.find((item) => sameSongExact(item.title, item.artist, title, artist)) || null
    );
  }

  /** 写入一条违规记录（不自动落盘，由调用方统一提交）。 */
  function addViolation(record) {
    const clean = sanitizeViolation(record);
    if (!clean) throw new Error('违规记录缺少歌名');
    violations.push(clean);
    return cloneRecord(clean);
  }

  /** 拉黑用户；同一 userKey 只保留最新一条。 */
  function blockUser({ userKey, nickname, reason } = {}) {
    const key = String(userKey || '').trim();
    if (!key) return null;
    const record = {
      userKey: key,
      nickname: String(nickname || ''),
      reason: String(reason || ''),
      blockedAt: now(),
    };
    blockedUsers = blockedUsers.filter((item) => item.userKey !== key);
    blockedUsers.push(record);
    return { ...record };
  }

  function isBlocked(userKey) {
    const key = String(userKey || '').trim();
    if (!key) return false;
    return blockedUsers.some((item) => item.userKey === key);
  }

  function snapshot() {
    return {
      version: 1,
      updatedAt: now(),
      violations: violations.map(cloneRecord),
      blockedUsers: blockedUsers.map(cloneRecord),
    };
  }

  /** 用快照覆盖内存（不落盘），供失败回滚使用。 */
  function restore(snapshotData) {
    const saved = snapshotData || {};
    violations = Array.isArray(saved.violations)
      ? saved.violations.map(sanitizeViolation).filter(Boolean)
      : [];
    blockedUsers = Array.isArray(saved.blockedUsers)
      ? saved.blockedUsers.map(sanitizeBlocked).filter(Boolean)
      : [];
  }

  /** 原子写盘；失败直接抛出，让调用方回滚。 */
  function persist() {
    if (!filePath) return { ok: true, skipped: true };
    const payload = {
      version: 1,
      updatedAt: now(),
      violations: violations.map(cloneRecord),
      blockedUsers: blockedUsers.map(cloneRecord),
    };
    mkdirSync(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.tmp`;
    writeFileSync(temp, JSON.stringify(payload), 'utf8');
    renameSync(temp, filePath);
    return { ok: true, path: filePath };
  }

  return {
    load,
    listViolations,
    findExact,
    addViolation,
    blockUser,
    isBlocked,
    snapshot,
    restore,
    persist,
  };
}

export const VIOLATION_RECORD_FIELDS = SONG_FIELDS;
