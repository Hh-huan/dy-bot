import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const html = readFileSync(path.join(EXT, 'app/app.html'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const jsFiles = walk(path.join(EXT, 'app')).filter((file) => file.endsWith('.js'));

test('manifest 引用的文件都存在', () => {
  const files = [
    manifest.background.service_worker,
    manifest.side_panel.default_path,
    ...Object.values(manifest.icons || {}),
    ...manifest.content_scripts.flatMap((script) => script.js || []),
  ];
  for (const file of files) {
    assert.ok(file, 'manifest 中有空文件路径');
    assert.ok(existsSync(path.join(EXT, file)), `缺少文件：${file}`);
  }
});

test('HTML 中的 id 不重复', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const seen = new Set();
  for (const id of ids) {
    assert.ok(!seen.has(id), `重复的 id：${id}`);
    seen.add(id);
  }
});

test('JS 里通过 #id 引用的元素都存在于 HTML', () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const missing = new Set();
  for (const file of jsFiles) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\$\(\s*['"]#([\w-]+)['"]/g)) {
      if (!ids.has(match[1])) missing.add(`${path.basename(file)} → #${match[1]}`);
    }
  }
  assert.deepEqual([...missing], [], `HTML 中找不到这些 id：\n${[...missing].join('\n')}`);
});

test('JS 的相对 import 路径都有效', () => {
  const missing = [];
  for (const file of jsFiles) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(file), match[1]);
      if (!existsSync(target)) missing.push(`${path.relative(ROOT, file)} → ${match[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('HTML 引用的脚本与样式存在', () => {
  for (const match of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
    assert.ok(existsSync(path.join(EXT, 'app', match[1])), `缺少脚本：${match[1]}`);
  }
  for (const match of html.matchAll(/<link[^>]+href="([^"]+)"/g)) {
    assert.ok(existsSync(path.join(EXT, 'app', match[1])), `缺少样式：${match[1]}`);
  }
});

test('content script 使用 MAIN world 注入钩子', () => {
  const inject = manifest.content_scripts.find((script) => (script.js || []).includes('content/inject.js'));
  assert.ok(inject);
  assert.equal(inject.world, 'MAIN');
  assert.equal(inject.run_at, 'document_start');
  const bridge = manifest.content_scripts.find((script) => (script.js || []).includes('content/bridge.js'));
  assert.ok(bridge);
  assert.equal(bridge.world || 'ISOLATED', 'ISOLATED');
});
