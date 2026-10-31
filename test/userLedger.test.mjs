import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUserLedger } from '../bridge/userLedger.mjs';

function tempLedger() {
  const dir = mkdtempSync(join(tmpdir(), 'dy-ledger-'));
  const file = join(dir, 'user-ledger.jsonl');
  return { ledger: createUserLedger({ file }), file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('留证台账：追加记录、按用户查询时间线', () => {
  const { ledger, file, cleanup } = tempLedger();
  try {
    const first = ledger.append({ key: 'u1', id: 'u1', name: '小明', action: 'enter', detail: '进入直播间', at: 1000 });
    assert.equal(first.seq, 1);
    assert.match(first.hash, /^[0-9a-f]{64}$/);

    ledger.append({ key: 'u1', id: 'u1', name: '小明', action: 'chat', detail: '你好', at: 2000 });
    ledger.append({ key: 'u1', id: 'u1', name: '小明', action: 'misjudge', detail: '误判记录', at: 3000 });
    ledger.append({ key: 'u2', name: '小红', action: 'enter', at: 4000 });

    const query = ledger.query('u1');
    assert.equal(query.total, 2, '审计记录不计入访问行为统计');
    assert.equal(query.firstSeen, 1000);
    assert.equal(query.lastSeen, 2000);
    assert.deepEqual(query.counts, { enter: 1, chat: 1 });
    assert.ok(query.entries.some((entry) => entry.action === 'misjudge'));
    assert.equal(query.user.name, '小明');
    assert.equal(ledger.query('小红').total, 1);
    assert.equal(ledger.query('u2').total, 1);
    assert.equal(ledger.query('不存在的人'), null);
    assert.equal(ledger.query(''), null);

    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 4);
  } finally {
    cleanup();
  }
});

test('留证台账：哈希链校验通过，重新载入后可继续追加', () => {
  const { ledger, file, cleanup } = tempLedger();
  try {
    for (let i = 0; i < 5; i += 1) {
      ledger.append({ key: 'u1', id: 'u1', name: '小明', action: 'chat', detail: `第${i}句`, at: 1000 + i });
    }
    assert.equal(ledger.verify().ok, true);
    assert.equal(ledger.size, 5);

    const reloaded = createUserLedger({ file });
    assert.equal(reloaded.verify().ok, true);
    assert.equal(reloaded.size, 5);
    const next = reloaded.append({ key: 'u1', action: 'like', detail: '点赞 ×2', at: 2000 });
    assert.equal(next.seq, 6);
    assert.equal(reloaded.size, 6);
    assert.equal(reloaded.verify().ok, true);
  } finally {
    cleanup();
  }
});

test('留证台账：内容被篡改后校验失败', () => {
  const { ledger, file, cleanup } = tempLedger();
  try {
    for (let i = 0; i < 5; i += 1) {
      ledger.append({ key: 'u1', id: 'u1', name: '小明', action: 'chat', detail: `第${i}句`, at: 1000 + i });
    }
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    const item = JSON.parse(lines[2]);
    item.detail = '被篡改的内容';
    lines[2] = JSON.stringify(item);
    writeFileSync(file, `${lines.join('\n')}\n`);

    // 运行期间文件被外部改动：同一个实例重新读盘也能发现
    assert.equal(ledger.verify().ok, false);
    const check = createUserLedger({ file }).verify();
    assert.equal(check.ok, false);
    assert.equal(check.brokenAt, 3);
  } finally {
    cleanup();
  }
});

test('留证台账：删除中间记录后校验失败', () => {
  const { ledger, file, cleanup } = tempLedger();
  try {
    for (let i = 0; i < 5; i += 1) {
      ledger.append({ key: 'u1', id: 'u1', name: '小明', action: 'chat', detail: `第${i}句`, at: 1000 + i });
    }
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    lines.splice(2, 1);
    writeFileSync(file, `${lines.join('\n')}\n`);

    const check = createUserLedger({ file }).verify();
    assert.equal(check.ok, false);
    assert.equal(check.brokenAt, 4);
  } finally {
    cleanup();
  }
});

test('留证台账：缺少用户或动作的记录被拒绝', () => {
  const { ledger, cleanup } = tempLedger();
  try {
    assert.equal(ledger.append({ action: 'enter' }), null);
    assert.equal(ledger.append({ key: 'u1' }), null);
    assert.equal(ledger.append({ key: 'u1', action: 'enter', detail: '   ' }).detail, '');
  } finally {
    cleanup();
  }
});
