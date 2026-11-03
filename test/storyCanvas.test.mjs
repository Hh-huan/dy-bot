import test from 'node:test';
import assert from 'node:assert/strict';

import { fallbackStoryDrawing, sanitizeStorySvg } from '../extension/app/core/storyCanvas.js';

test('清洗 SVG：保留白名单图形，移除脚本、文字和外链', () => {
  const raw = [
    '```svg',
    '<svg viewBox="0 0 100 100" onload="alert(1)">',
    '<script>alert(1)</script>',
    '<text x="10" y="20">标题</text>',
    '<image href="https://evil.example/a.png" />',
    '<path d="M10 10 L90 90" stroke="#17324f" stroke-width="6" onclick="alert(1)" />',
    '<circle cx="50" cy="50" r="20" fill="#cfe6fb" />',
    '<rect x="100" y="100" width="80" height="60" fill="#ffe9b8" />',
    '</svg>',
    '```',
  ].join('\n');
  const svg = sanitizeStorySvg(raw);
  assert.ok(svg.startsWith('<svg '));
  assert.ok(svg.includes('viewBox="0 0 1000 620"'));
  assert.ok(svg.includes('<path'));
  assert.ok(svg.includes('<circle'));
  assert.ok(svg.includes('<rect'));
  assert.equal(svg.includes('script'), false);
  assert.equal(svg.includes('标题'), false);
  assert.equal(svg.includes('evil'), false);
  assert.equal(svg.includes('onclick'), false);
  assert.equal(svg.includes('onload'), false);
});

test('兼容被截断或没有闭合标签的 SVG', () => {
  const raw = '<svg viewBox="0 0 1000 620"><path d="M100 100 C300 80 500 120 800 100" stroke="#17324f" /><circle cx="300" cy="300" r="40" fill="#ffd6de" /><rect x="500" y="400" width="120" height="80" fill="#d9f2df" />';
  const svg = sanitizeStorySvg(raw);
  assert.ok(svg.endsWith('</svg>'));
  assert.ok(svg.includes('<path'));
  assert.ok(svg.includes('<circle'));
  assert.ok(svg.includes('<rect'));
  // 只有描边、没写 fill 的线条补 fill="none"，避免默认填成黑色
  assert.ok(/<path[^>]*fill="none"/.test(svg));
});

test('没有有效图形或不是 SVG 时返回空字符串', () => {
  assert.equal(sanitizeStorySvg(''), '');
  assert.equal(sanitizeStorySvg('今天画一条鱼'), '');
  assert.equal(sanitizeStorySvg('<svg><text>只有文字</text></svg>'), '');
  assert.equal(sanitizeStorySvg('<svg><script>alert(1)</script></svg>'), '');
});

test('画面细节超过 60 个时不会被清洗器丢弃', () => {
  // 绘本插画动辄 44～64 个元素，旧上限 60 会把后半幅画的角色和装饰静默砍掉
  const shapes = Array.from({ length: 72 }, (_, i) => {
    const x = 40 + (i % 12) * 76;
    const y = 60 + Math.floor(i / 12) * 84;
    return `<circle cx="${x}" cy="${y}" r="18" fill="#ffd6de" stroke="#17324f" stroke-width="4" />`;
  }).join('');
  const svg = sanitizeStorySvg(`<svg viewBox="0 0 1000 620">${shapes}</svg>`);
  assert.equal((svg.match(/<circle/g) || []).length, 72);
});

test('兜底画面是细节完整的绘本场景', () => {
  const svg = fallbackStoryDrawing({ scene: '海底宝箱', narration: '主角在海底发现一个宝箱' });
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('<circle'));
  assert.ok(svg.includes('<path'));
  // 至少要像一页完整插画：天空、远景、地面、主角、伙伴、道具和装饰都在
  const shapes = (svg.match(/<(?:path|circle|ellipse|rect|line|polyline|polygon)\b/g) || []).length;
  assert.ok(shapes >= 45, `兜底画面图形数量偏少：${shapes}`);
  assert.ok(svg.includes('fill="#dceeff"'));
  assert.ok(sanitizeStorySvg(svg).length > 0);
});
