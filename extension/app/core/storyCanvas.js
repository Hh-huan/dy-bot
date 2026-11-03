// 剧场画板：把 AI 生成的手绘 SVG 清洗成只含安全图形的白名单结构，
// 并提供 AI 失败时的兜底画面。纯字符串处理，便于单元测试。
const ALLOWED_TAGS = new Set(['g', 'path', 'line', 'circle', 'ellipse', 'rect', 'polyline', 'polygon']);
const BLOCKED_TAGS = [
  'script', 'style', 'foreignObject', 'iframe', 'image', 'img', 'defs', 'use',
  'text', 'tspan', 'animate', 'animateTransform', 'set', 'a', 'filter', 'mask',
  'pattern', 'clipPath', 'marker',
];
const ALLOWED_ATTRS = new Set([
  'd', 'x', 'y', 'cx', 'cy', 'r', 'rx', 'ry', 'x1', 'y1', 'x2', 'y2', 'points',
  'width', 'height', 'fill', 'stroke', 'stroke-width', 'stroke-linecap',
  'stroke-linejoin', 'opacity', 'fill-opacity', 'stroke-opacity', 'transform',
]);
// 画面走绘本插画风后细节明显变多：元素上限放宽到 90，长度上限放宽到 40000，
// 避免 AI 画到一半的装饰、角色和道具被静默丢弃，画面重新变回简陋
const MAX_ELEMENTS = 90;
const MAX_LENGTH = 40000;

function stripBlock(html, tag) {
  return html
    .replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '')
    .replace(new RegExp(`<${tag}\\b[^>]*\\/>`, 'gi'), '');
}

function sanitizeAttrs(attrText) {
  const out = [];
  const re = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match = re.exec(attrText);
  while (match) {
    const name = match[1].toLowerCase();
    const value = String(match[2] ?? match[3] ?? '').trim();
    const lower = value.toLowerCase();
    const safeValue = /^[#\w\s.,()%+\-]*$/u.test(value)
      && !lower.includes('url(')
      && !lower.includes('javascript:')
      && !lower.includes('data:')
      && !lower.includes('http')
      && !value.includes('<')
      && !value.includes('>');
    if (ALLOWED_ATTRS.has(name) && safeValue) out.push(`${name}="${value}"`);
    match = re.exec(attrText);
  }
  return out.length ? ` ${out.join(' ')}` : '';
}

/**
 * 清洗 AI 返回的 SVG：只保留白名单图形和属性，去掉文字、脚本、外链与特效。
 * @param {string} raw AI 原始输出（可能带 markdown 代码块）
 * @returns {string} 可直接注入页面的 SVG；无法修复时返回空字符串
 */
export function sanitizeStorySvg(raw) {
  let text = String(raw || '').replace(/```[a-zA-Z]*|```/g, '').trim();
  if (!text) return '';
  const closed = text.match(/<svg[^>]*>([\s\S]*?)<\/svg>/i);
  if (closed) {
    text = closed[1];
  } else {
    const open = text.search(/<svg[^>]*>/i);
    if (open < 0) return '';
    text = text.slice(open).replace(/^<svg[^>]*>/i, '').replace(/<\/svg>[\s\S]*$/i, '');
  }
  for (const tag of BLOCKED_TAGS) text = stripBlock(text, tag);
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  let count = 0;
  let body = text.replace(/<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g, (full, tag, attrs, self) => {
    const name = tag.toLowerCase();
    if (!ALLOWED_TAGS.has(name)) return '';
    count += 1;
    if (count > MAX_ELEMENTS) return '';
    const clean = sanitizeAttrs(attrs);
    // 没写 fill 的图形默认会被 SVG 填成黑色，统一补 fill="none"，保持线稿观感
    const extra = /\bfill=/.test(clean) ? '' : ' fill="none"';
    return `<${name}${clean}${extra}${self ? ' /' : ''}>`;
  });
  // 去掉白名单外的闭合标签与所有裸文本（AI 常顺手写标题或解释）
  body = body.replace(/<\/[a-zA-Z][\w:-]*>/g, (tag) => {
    const name = tag.slice(2, -1).toLowerCase();
    return ALLOWED_TAGS.has(name) ? tag : '';
  });
  body = body.replace(/>([^<]*)</g, '><');
  // 去掉开头 / 结尾的裸文本，中间文本已在上一步清掉
  body = body.replace(/^[^<]+/, '').replace(/[^>]+$/, '');
  if (count < 3 || body.length > MAX_LENGTH) return '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 620" preserveAspectRatio="xMidYMid meet">${body}</svg>`;
}

/**
 * AI 失败时的兜底画面：一页完整的绘本插画（天空 / 远景 / 地面 / 主角 /
 * 伙伴 / 关键道具 / 花草与角花），保证画板既不空白，也不会显得简陋。
 */
export function fallbackStoryDrawing(node = {}) {
  const text = `${node.scene || ''}${node.narration || ''}`;
  const sea = /海|鲸|鱼|浪|船|岛|水/.test(text);
  const night = /夜|星|月|梦|睡/.test(text);
  const forest = /森|林|树|草|花|山|原/.test(text);
  const sky = night ? '#dfe6ff' : sea ? '#dceeff' : '#eaf4ff';
  const far = night ? '#c9d8f5' : sea ? '#cfe6fb' : '#e2d9f7';
  const mid = night ? '#a9b8e0' : sea ? '#a9d3f2' : forest ? '#c7e8b6' : '#d9f2df';
  const ground = sea ? '#ffe9b8' : night ? '#e2d9f7' : forest ? '#d9f2df' : '#ffe9b8';
  const accent = sea ? '#ffd6de' : '#ffd0a6';
  const sun = night
    ? `<circle cx="790" cy="132" r="46" fill="#fff6e2" stroke="#17324f" stroke-width="5" />
    <circle cx="790" cy="132" r="64" fill="none" stroke="#fff6e2" stroke-width="7" opacity="0.55" />`
    : `<circle cx="790" cy="132" r="54" fill="#ffe9b8" stroke="#17324f" stroke-width="5" />
    <circle cx="790" cy="132" r="72" fill="none" stroke="#ffe9b8" stroke-width="7" opacity="0.55" />`;
  const stars = night
    ? `<circle cx="180" cy="96" r="5" fill="#fff6e2" stroke="#17324f" stroke-width="2" />
    <circle cx="392" cy="120" r="4" fill="#fff6e2" stroke="#17324f" stroke-width="2" />
    <circle cx="640" cy="86" r="5" fill="#fff6e2" stroke="#17324f" stroke-width="2" />
    <circle cx="900" cy="248" r="4" fill="#fff6e2" stroke="#17324f" stroke-width="2" />`
    : '';
  // 海面用波浪，其它场景用第二层丘陵
  const middle = sea
    ? `<path d="M24 402 C170 380 320 398 470 396 C640 394 800 374 976 394 L976 602 L24 602 Z" fill="${mid}" stroke="#17324f" stroke-width="5" />
    <path d="M70 446 C170 434 250 446 330 442" fill="none" stroke="#ffffff" stroke-width="6" stroke-linecap="round" opacity="0.8" />
    <path d="M520 470 C620 456 700 468 790 462" fill="none" stroke="#ffffff" stroke-width="6" stroke-linecap="round" opacity="0.7" />`
    : `<path d="M24 412 C150 372 260 398 360 420 C470 444 560 396 660 404 C760 412 880 394 976 410 L976 602 L24 602 Z" fill="${mid}" stroke="#17324f" stroke-width="5" />`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 620" preserveAspectRatio="xMidYMid meet">
    <rect x="24" y="18" width="952" height="584" rx="28" fill="${sky}" stroke="#17324f" stroke-width="5" />
    <path d="M24 352 C120 298 214 306 304 344 C392 380 470 336 552 330 C650 322 738 352 818 338 C888 326 934 338 976 350 L976 602 L24 602 Z" fill="${far}" stroke="#17324f" stroke-width="4" />
    ${middle}
    <path d="M24 486 C160 466 300 480 440 482 C600 486 760 468 976 484 L976 602 L24 602 Z" fill="${ground}" stroke="#17324f" stroke-width="5" />
    ${sun}
    ${stars}
    <path d="M198 132 C204 112 230 106 246 120 C254 104 280 108 286 128 C306 128 312 148 296 152 L206 152 C188 150 188 136 198 132 Z" fill="#ffffff" stroke="#17324f" stroke-width="4" />
    <path d="M470 104 C476 88 496 84 508 96 C514 82 538 86 544 102 C560 102 566 118 554 122 L478 122 C464 120 462 108 470 104 Z" fill="#ffffff" stroke="#17324f" stroke-width="4" />
    <path d="M866 232 C870 220 886 216 896 224 C902 214 918 218 920 230 C932 230 936 242 926 244 L874 244 C862 242 860 234 866 232 Z" fill="#ffffff" stroke="#17324f" stroke-width="3" />
    <path d="M414 188 C426 176 440 176 450 186" fill="none" stroke="#17324f" stroke-width="4" stroke-linecap="round" />
    <path d="M462 214 C472 204 484 204 492 212" fill="none" stroke="#17324f" stroke-width="3.5" stroke-linecap="round" />
    <rect x="104" y="330" width="30" height="170" rx="8" fill="#e6c9a8" stroke="#17324f" stroke-width="5" />
    <circle cx="119" cy="306" r="62" fill="#c7e8b6" stroke="#17324f" stroke-width="5" />
    <circle cx="74" cy="346" r="44" fill="#c7e8b6" stroke="#17324f" stroke-width="5" />
    <circle cx="160" cy="350" r="40" fill="#c7e8b6" stroke="#17324f" stroke-width="5" />
    <rect x="826" y="398" width="104" height="88" fill="#ffe9b8" stroke="#17324f" stroke-width="5" />
    <path d="M812 400 L878 356 L944 400 Z" fill="#ffd0a6" stroke="#17324f" stroke-width="5" />
    <rect x="848" y="418" width="28" height="28" fill="#dceeff" stroke="#17324f" stroke-width="4" />
    <rect x="894" y="442" width="24" height="44" fill="#e6c9a8" stroke="#17324f" stroke-width="4" />
    <ellipse cx="522" cy="556" rx="66" ry="14" fill="#17324f" opacity="0.16" />
    <path d="M484 476 C484 436 500 416 520 416 C540 416 558 436 558 476 L566 516 C540 526 500 526 474 516 Z" fill="${accent}" stroke="#17324f" stroke-width="5" />
    <circle cx="520" cy="372" r="37" fill="#fff6e2" stroke="#17324f" stroke-width="5" />
    <path d="M484 366 C488 334 512 324 534 328 C554 332 562 352 558 372 C542 352 500 350 484 366 Z" fill="#17324f" stroke="#17324f" stroke-width="3" />
    <circle cx="508" cy="372" r="4" fill="#17324f" />
    <circle cx="534" cy="372" r="4" fill="#17324f" />
    <path d="M508 390 C516 398 528 398 536 390" fill="none" stroke="#17324f" stroke-width="3.5" stroke-linecap="round" />
    <path d="M492 418 C512 410 532 412 552 422 L548 436 C528 428 508 428 494 434 Z" fill="#a9d3f2" stroke="#17324f" stroke-width="4" />
    <path d="M484 444 C462 458 448 474 442 496" fill="none" stroke="#17324f" stroke-width="5" stroke-linecap="round" />
    <path d="M558 444 C582 458 596 474 600 496" fill="none" stroke="#17324f" stroke-width="5" stroke-linecap="round" />
    <path d="M504 514 C498 528 494 540 492 552" fill="none" stroke="#17324f" stroke-width="5" stroke-linecap="round" />
    <path d="M538 514 C544 528 548 540 550 552" fill="none" stroke="#17324f" stroke-width="5" stroke-linecap="round" />
    <ellipse cx="700" cy="500" rx="56" ry="44" fill="#c7e8b6" stroke="#17324f" stroke-width="5" />
    <circle cx="700" cy="448" r="38" fill="#d9f2df" stroke="#17324f" stroke-width="5" />
    <path d="M674 424 L664 386 L696 408 Z" fill="#c7e8b6" stroke="#17324f" stroke-width="4" />
    <path d="M726 424 L738 386 L706 408 Z" fill="#c7e8b6" stroke="#17324f" stroke-width="4" />
    <circle cx="688" cy="446" r="4" fill="#17324f" />
    <circle cx="712" cy="446" r="4" fill="#17324f" />
    <path d="M700 458 C706 464 712 462 716 456" fill="none" stroke="#17324f" stroke-width="3.5" stroke-linecap="round" />
    <path d="M754 496 C786 482 800 504 780 524 C770 534 756 532 748 522" fill="none" stroke="#17324f" stroke-width="5" stroke-linecap="round" />
    <circle cx="404" cy="512" r="62" fill="#ffffff" opacity="0.55" />
    <rect x="362" y="516" width="92" height="52" rx="6" fill="#ffe9b8" stroke="#17324f" stroke-width="5" />
    <path d="M362 516 C362 498 380 486 408 486 C436 486 454 498 454 516 Z" fill="${accent}" stroke="#17324f" stroke-width="5" />
    <circle cx="408" cy="540" r="8" fill="#17324f" />
    <path d="M386 488 L378 470" fill="none" stroke="#ffe9b8" stroke-width="5" stroke-linecap="round" />
    <path d="M430 486 L438 468" fill="none" stroke="#ffe9b8" stroke-width="5" stroke-linecap="round" />
    <path d="M54 578 C84 552 112 566 132 582" fill="none" stroke="#17324f" stroke-width="5" stroke-linecap="round" />
    <path d="M876 572 C908 546 936 560 958 576" fill="none" stroke="#17324f" stroke-width="5" stroke-linecap="round" />
    <path d="M256 574 C254 558 256 550 258 542" fill="none" stroke="#17324f" stroke-width="4" stroke-linecap="round" />
    <circle cx="258" cy="536" r="10" fill="#ffd6de" stroke="#17324f" stroke-width="4" />
    <circle cx="258" cy="536" r="3" fill="#ffe9b8" />
    <path d="M604 586 C606 570 606 562 608 554" fill="none" stroke="#17324f" stroke-width="4" stroke-linecap="round" />
    <circle cx="608" cy="548" r="10" fill="#ffd0a6" stroke="#17324f" stroke-width="4" />
    <circle cx="608" cy="548" r="3" fill="#ffe9b8" />
    <ellipse cx="826" cy="566" rx="30" ry="14" fill="#dceeff" stroke="#17324f" stroke-width="3" />
    <path d="M596 322 L596 348 M583 335 L609 335" fill="none" stroke="#ffe9b8" stroke-width="4" stroke-linecap="round" />
    <path d="M320 268 L320 288 M310 278 L330 278" fill="none" stroke="#ffd6de" stroke-width="3.5" stroke-linecap="round" />
    <path d="M888 570 C908 554 920 572 938 560 C950 552 958 562 968 554" fill="none" stroke="#17324f" stroke-width="4" stroke-linecap="round" opacity="0.5" />
    <path d="M44 44 L92 44 M44 44 L44 92" fill="none" stroke="#17324f" stroke-width="4" stroke-linecap="round" opacity="0.5" />
    <path d="M956 574 L908 574 M956 574 L956 526" fill="none" stroke="#17324f" stroke-width="4" stroke-linecap="round" opacity="0.5" />
  </svg>`;
}
