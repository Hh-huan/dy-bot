/**
 * 你画我猜：桌宠在背景板逐笔画出内置矢量简笔画，观众发弹幕猜答案。
 * 只做纯逻辑（题库、状态流转、口令解析、猜词匹配、计分），不碰浏览器 API，便于单元测试。
 */

export const DRAW_ROUND_SEC = 60;
/** 每一笔之间的揭晓间隔 */
export const DRAW_STROKE_MS = 650;
/** 猜词阶段剩这么多秒时自动给出提示 */
export const DRAW_HINT_REMAIN_SEC = 25;
/** 一题结束（猜中 / 超时 / 跳过）后，多久进入下一题 */
export const DRAW_NEXT_DELAY_MS = 5000;
export const DRAW_MAX_ROUNDS = 5;
export const DRAW_MIN_ROUND_SEC = 30;
export const DRAW_MAX_ROUND_SEC = 120;
export const DRAW_MIN_ROUNDS = 3;
export const DRAW_MAX_ROUNDS_LIMIT = 10;

// 简笔画统一使用 1000 × 620 画布，墨线 + 奶油色纸面，跟背景板其它卡片风格一致
const INK = '#17324f';

/**
 * 内置题库：每一笔都是一个独立的 SVG 图形，按顺序揭晓形成「正在画」的过程。
 * kind 支持 path / circle / ellipse / line；path 用 d，其余用对应几何属性。
 */
export const DRAW_WORDS = [
  {
    id: 'cat',
    word: '小猫',
    aliases: ['猫', '猫咪', '猫猫', '小猫咪', '喵'],
    category: '动物',
    hint: '会喵喵叫，喜欢追毛线球',
    strokes: [
      { d: 'M 400 300 C 400 216 466 168 540 168 C 614 168 680 216 680 300 C 680 384 614 432 540 432 C 466 432 400 384 400 300 Z', fill: '#ffe9b8' },
      { d: 'M 432 218 L 398 128 L 492 176 Z', fill: '#ffd0a6' },
      { d: 'M 648 218 L 682 128 L 588 176 Z', fill: '#ffd0a6' },
      { kind: 'circle', cx: 498, cy: 286, r: 12, fill: INK },
      { kind: 'circle', cx: 582, cy: 286, r: 12, fill: INK },
      { d: 'M 522 326 L 558 326 L 540 342 Z', fill: '#ffd6de' },
      { d: 'M 540 342 C 540 356 524 362 514 354 M 540 342 C 540 356 556 362 566 354', width: 4 },
      { d: 'M 470 320 L 392 306 M 470 338 L 394 348 M 610 320 L 688 306 M 610 338 L 686 348', width: 4 },
      { d: 'M 472 432 C 470 486 492 536 540 536 C 588 536 610 486 608 432', fill: '#ffe9b8' },
      { d: 'M 608 508 C 688 520 716 468 684 428', width: 6 },
    ],
  },
  {
    id: 'fish',
    word: '小鱼',
    aliases: ['鱼', '鱼儿', '小鱼儿', '大肥鱼'],
    category: '动物',
    hint: '生活在水里，尾巴一摆一摆',
    strokes: [
      { kind: 'ellipse', cx: 500, cy: 320, rx: 168, ry: 104, fill: '#a9d3f2' },
      { d: 'M 668 320 L 786 240 L 786 400 Z', fill: '#7fbde8' },
      { kind: 'circle', cx: 448, cy: 294, r: 11, fill: INK },
      { d: 'M 414 342 C 436 360 462 362 480 352', width: 4 },
      { d: 'M 520 220 C 520 178 562 166 592 190', width: 5 },
      { kind: 'circle', cx: 330, cy: 250, r: 16, fill: '#ffffff', width: 4 },
      { kind: 'circle', cx: 290, cy: 206, r: 9, fill: '#ffffff', width: 3 },
      { kind: 'circle', cx: 262, cy: 176, r: 5, fill: '#ffffff', width: 2 },
    ],
  },
  {
    id: 'apple',
    word: '苹果',
    aliases: ['红苹果', 'apple', '苹果果'],
    category: '水果',
    hint: '红红的，咬一口很脆',
    strokes: [
      { d: 'M 500 214 C 426 166 326 214 326 324 C 326 436 416 504 500 504 C 584 504 674 436 674 324 C 674 214 574 166 500 214 Z', fill: '#ffd6de' },
      { d: 'M 500 214 C 504 176 520 154 548 142', width: 5 },
      { d: 'M 548 142 C 596 116 636 140 642 182 C 598 200 560 186 548 142 Z', fill: '#c7e8b6' },
      { d: 'M 396 274 C 408 250 428 238 452 236', stroke: '#ffffff', width: 6 },
      { kind: 'ellipse', cx: 500, cy: 522, rx: 128, ry: 14, fill: INK, opacity: 0.14, stroke: 'none' },
    ],
  },
  {
    id: 'sun',
    word: '太阳',
    aliases: ['日头', '太阳公公', 'sun'],
    category: '自然',
    hint: '天上发光发热的大火球',
    strokes: [
      { kind: 'circle', cx: 500, cy: 310, r: 124, fill: '#ffe9b8' },
      { d: 'M 500 142 L 500 76 M 500 478 L 500 544 M 332 310 L 266 310 M 668 310 L 734 310 M 380 190 L 332 142 M 620 190 L 668 142 M 380 430 L 332 478 M 620 430 L 668 478', stroke: '#ffd0a6', width: 9 },
      { kind: 'circle', cx: 462, cy: 292, r: 11, fill: INK },
      { kind: 'circle', cx: 538, cy: 292, r: 11, fill: INK },
      { d: 'M 450 350 C 476 378 524 378 550 350', width: 5 },
    ],
  },
  {
    id: 'umbrella',
    word: '雨伞',
    aliases: ['伞', '雨伞伞', '小伞', 'umbrella'],
    category: '物品',
    hint: '下雨天撑在头顶，可以挡雨',
    strokes: [
      { d: 'M 250 334 C 250 214 362 148 500 148 C 638 148 750 214 750 334 Q 712 300 674 334 Q 636 300 598 334 Q 560 300 522 334 Q 484 300 446 334 Q 408 300 370 334 Q 332 300 294 334 Q 268 314 250 334 Z', fill: '#a9d3f2' },
      { d: 'M 500 148 L 500 486 C 500 526 540 536 562 508', width: 7 },
      { d: 'M 300 404 L 270 456 M 380 428 L 352 480 M 660 404 L 632 456 M 728 428 L 700 480', stroke: '#7fbde8', width: 5 },
    ],
  },
  {
    id: 'star',
    word: '星星',
    aliases: ['星', '五角星', '小星星', 'star'],
    category: '自然',
    hint: '夜空里一闪一闪的小亮点',
    strokes: [
      { d: 'M 500 128 L 570 292 L 744 306 L 610 414 L 652 584 L 500 492 L 348 584 L 390 414 L 256 306 L 430 292 Z', fill: '#ffe9b8' },
      { d: 'M 300 180 L 300 236 M 272 208 L 328 208', stroke: '#ffd0a6', width: 6 },
      { d: 'M 720 220 L 720 270 M 695 245 L 745 245', stroke: '#ffd0a6', width: 5 },
    ],
  },
  {
    id: 'heart',
    word: '爱心',
    aliases: ['心', '红心', '心心', 'heart', '爱心心'],
    category: '符号',
    hint: '表达喜欢和爱意的形状',
    strokes: [
      { d: 'M 500 532 C 336 428 256 336 256 252 C 256 180 336 148 398 174 C 452 196 486 238 500 274 C 514 238 548 196 602 174 C 664 148 744 180 744 252 C 744 336 664 428 500 532 Z', fill: '#ffd6de' },
      { d: 'M 350 276 C 358 246 380 226 406 218', stroke: '#ffffff', width: 7 },
      { d: 'M 818 168 L 818 220 M 792 194 L 844 194', stroke: '#ffd0a6', width: 5 },
      { d: 'M 222 380 L 222 416 M 204 398 L 240 398', stroke: '#a9d3f2', width: 4 },
    ],
  },
  {
    id: 'cake',
    word: '蛋糕',
    aliases: ['生日蛋糕', '奶油蛋糕', 'cake', '小蛋糕'],
    category: '食物',
    hint: '过生日的时候会点蜡烛',
    strokes: [
      { kind: 'ellipse', cx: 500, cy: 548, rx: 236, ry: 24, fill: '#dceeff' },
      { d: 'M 336 392 L 336 520 C 336 536 392 544 500 544 C 608 544 664 536 664 520 L 664 392 Z', fill: '#ffe9b8' },
      { d: 'M 336 392 C 366 360 398 360 428 392 C 458 360 490 360 520 392 C 550 360 582 360 612 392 C 636 368 652 370 664 392', stroke: '#ffd6de', width: 9 },
      { d: 'M 500 384 L 500 296', width: 5 },
      { d: 'M 500 296 C 476 276 478 252 500 234 C 522 252 524 276 500 296 Z', fill: '#ffd0a6' },
      { kind: 'circle', cx: 420, cy: 470, r: 10, fill: '#ffd6de' },
      { kind: 'circle', cx: 500, cy: 482, r: 10, fill: '#c7e8b6' },
      { kind: 'circle', cx: 580, cy: 470, r: 10, fill: '#a9d3f2' },
    ],
  },
  {
    id: 'flower',
    word: '花朵',
    aliases: ['花', '小花', '鲜花', 'flower', '花花'],
    category: '植物',
    hint: '有花瓣和花心，长在枝头上',
    strokes: [
      { d: 'M 500 560 C 496 488 500 420 500 366', width: 6 },
      { d: 'M 500 494 C 442 468 396 486 386 526 C 442 542 484 526 500 494 Z', fill: '#c7e8b6' },
      { kind: 'circle', cx: 500, cy: 214, r: 62, fill: '#ffd6de' },
      { kind: 'circle', cx: 386, cy: 290, r: 62, fill: '#ffd6de' },
      { kind: 'circle', cx: 614, cy: 290, r: 62, fill: '#ffd6de' },
      { kind: 'circle', cx: 428, cy: 398, r: 62, fill: '#ffd6de' },
      { kind: 'circle', cx: 572, cy: 398, r: 62, fill: '#ffd6de' },
      { kind: 'circle', cx: 500, cy: 306, r: 58, fill: '#ffe9b8' },
    ],
  },
  {
    id: 'house',
    word: '房子',
    aliases: ['小屋', '房屋', 'house', '屋子'],
    category: '建筑',
    hint: '有屋顶和门，住人的地方',
    strokes: [
      { d: 'M 304 300 L 304 528 L 696 528 L 696 300 Z', fill: '#ffe9b8' },
      { d: 'M 258 316 L 500 148 L 742 316 Z', fill: '#ffd6de' },
      { d: 'M 458 400 L 458 528 L 542 528 L 542 400 Z', fill: '#e6c9a8' },
      { d: 'M 336 352 L 410 352 L 410 424 L 336 424 Z', fill: '#a9d3f2' },
      { d: 'M 373 352 L 373 424 M 336 388 L 410 388', width: 4 },
      { d: 'M 612 214 L 612 126 L 668 126 L 668 258', width: 6 },
    ],
  },
  {
    id: 'moon',
    word: '月亮',
    aliases: ['月', '弯月', 'moon', '月亮弯弯'],
    category: '自然',
    hint: '晚上挂在天空，弯弯的像小船',
    strokes: [
      { d: 'M 596 148 C 446 172 370 286 392 402 C 414 518 532 570 650 528 C 540 486 486 390 498 294 C 508 220 548 174 596 148 Z', fill: '#ffe9b8' },
      { d: 'M 736 186 L 736 240 M 709 213 L 763 213', stroke: '#ffd0a6', width: 5 },
      { d: 'M 292 380 L 292 424 M 270 402 L 314 402', stroke: '#a9d3f2', width: 4 },
      { kind: 'circle', cx: 760, cy: 352, r: 7, fill: '#a9d3f2', stroke: 'none' },
      { kind: 'circle', cx: 320, cy: 200, r: 5, fill: '#a9d3f2', stroke: 'none' },
    ],
  },
  {
    id: 'balloon',
    word: '气球',
    aliases: ['气球球', 'balloon', '氢气球', '小气球'],
    category: '物品',
    hint: '圆圆的，飘在空中，一戳就破',
    strokes: [
      { kind: 'ellipse', cx: 500, cy: 266, rx: 112, ry: 142, fill: '#ffd6de' },
      { d: 'M 500 408 C 548 454 460 500 500 560', width: 5 },
      { d: 'M 474 414 L 500 438 L 526 414 Z', fill: '#ffd6de' },
      { kind: 'ellipse', cx: 458, cy: 212, rx: 28, ry: 46, fill: '#ffffff', opacity: 0.7, stroke: 'none' },
    ],
  },
  {
    id: 'snowman',
    word: '雪人',
    aliases: ['雪娃娃', 'snowman', '堆雪人'],
    category: '冬天',
    hint: '下雪天用雪堆出来的人',
    strokes: [
      { kind: 'circle', cx: 500, cy: 466, r: 96, fill: '#ffffff' },
      { kind: 'circle', cx: 500, cy: 342, r: 70, fill: '#ffffff' },
      { kind: 'circle', cx: 500, cy: 244, r: 52, fill: '#ffffff' },
      { d: 'M 442 206 L 442 154 L 558 154 L 558 206 Z', fill: INK },
      { d: 'M 420 206 L 580 206', width: 6 },
      { kind: 'circle', cx: 480, cy: 236, r: 7, fill: INK },
      { kind: 'circle', cx: 520, cy: 236, r: 7, fill: INK },
      { d: 'M 500 252 L 576 266 L 500 274 Z', fill: '#ffd0a6' },
      { d: 'M 348 340 L 264 300 M 652 340 L 736 300', width: 5 },
      { kind: 'circle', cx: 500, cy: 336, r: 8, fill: INK },
      { kind: 'circle', cx: 500, cy: 380, r: 8, fill: INK },
      { kind: 'circle', cx: 500, cy: 456, r: 9, fill: INK },
    ],
  },
  {
    id: 'car',
    word: '汽车',
    aliases: ['车', '小车', '轿车', 'car', '小汽车'],
    category: '交通',
    hint: '有四个轮子，在马路上跑',
    strokes: [
      { d: 'M 196 424 L 260 312 L 700 312 L 804 424 L 804 500 L 196 500 Z', fill: '#a9d3f2' },
      { d: 'M 344 312 L 408 234 L 638 234 L 700 312 Z', fill: '#dceeff' },
      { d: 'M 330 424 L 330 500 M 470 424 L 470 500 M 570 424 L 570 500', width: 4 },
      { kind: 'circle', cx: 320, cy: 502, r: 46, fill: INK },
      { kind: 'circle', cx: 320, cy: 502, r: 22, fill: '#dceeff', width: 4 },
      { kind: 'circle', cx: 680, cy: 502, r: 46, fill: INK },
      { kind: 'circle', cx: 680, cy: 502, r: 22, fill: '#dceeff', width: 4 },
      { kind: 'circle', cx: 770, cy: 440, r: 12, fill: '#ffe9b8' },
    ],
  },
  {
    id: 'icecream',
    word: '冰淇淋',
    aliases: ['冰激凌', '雪糕', '甜筒', 'icecream', '冰淇凌'],
    category: '食物',
    hint: '甜甜的、凉凉的，拿在手里会化',
    strokes: [
      { d: 'M 406 336 L 594 336 L 500 566 Z', fill: '#e6c9a8' },
      { d: 'M 430 366 L 500 536 M 570 366 L 500 536 M 450 430 L 552 430 M 472 482 L 530 482', width: 4 },
      { kind: 'circle', cx: 500, cy: 292, r: 94, fill: '#ffd6de' },
      { kind: 'circle', cx: 500, cy: 204, r: 62, fill: '#fff6e2' },
      { kind: 'circle', cx: 500, cy: 138, r: 20, fill: '#ffd6de' },
      { d: 'M 500 118 C 510 102 522 98 532 96', width: 4 },
    ],
  },
  {
    id: 'butterfly',
    word: '蝴蝶',
    aliases: ['蝴蝶结', 'butterfly', '花蝴蝶'],
    category: '动物',
    hint: '有两片大翅膀，喜欢在花丛里飞',
    strokes: [
      { kind: 'ellipse', cx: 388, cy: 258, rx: 98, ry: 72, fill: '#ffd6de', transform: 'rotate(-28 388 258)' },
      { kind: 'ellipse', cx: 612, cy: 258, rx: 98, ry: 72, fill: '#ffd6de', transform: 'rotate(28 612 258)' },
      { kind: 'ellipse', cx: 408, cy: 378, rx: 76, ry: 58, fill: '#a9d3f2', transform: 'rotate(24 408 378)' },
      { kind: 'ellipse', cx: 592, cy: 378, rx: 76, ry: 58, fill: '#a9d3f2', transform: 'rotate(-24 592 378)' },
      { kind: 'ellipse', cx: 500, cy: 330, rx: 22, ry: 112, fill: INK, stroke: 'none' },
      { d: 'M 486 220 C 462 178 432 162 404 160 M 514 220 C 538 178 568 162 596 160', width: 4 },
      { kind: 'circle', cx: 398, cy: 158, r: 8, fill: INK },
      { kind: 'circle', cx: 602, cy: 158, r: 8, fill: INK },
    ],
  },
  {
    id: 'whale',
    word: '鲸鱼',
    aliases: ['大鲸鱼', '鲸', 'whale', '鲸鱼娘'],
    category: '动物',
    hint: '海里最大的动物，会从头顶喷水',
    strokes: [
      { d: 'M 216 386 C 236 288 380 232 542 252 C 704 272 786 340 806 386 C 706 456 544 486 382 466 C 300 456 238 424 216 386 Z', fill: '#a9d3f2' },
      { d: 'M 792 386 C 852 336 902 336 906 386 C 910 436 852 436 792 386 Z', fill: '#7fbde8' },
      { d: 'M 252 392 C 340 424 440 430 540 420', stroke: '#ffffff', width: 6 },
      { kind: 'circle', cx: 330, cy: 356, r: 11, fill: INK },
      { d: 'M 358 398 C 382 412 406 410 424 398', width: 4 },
      { d: 'M 470 250 C 462 206 486 180 520 168 M 520 168 C 548 158 574 164 588 178', width: 5 },
      { kind: 'circle', cx: 448, cy: 170, r: 8, fill: '#dceeff', stroke: '#7fbde8', width: 3 },
      { kind: 'circle', cx: 606, cy: 150, r: 6, fill: '#dceeff', stroke: '#7fbde8', width: 3 },
    ],
  },
  {
    id: 'glasses',
    word: '眼镜',
    aliases: ['近视眼镜', '眼镜框', 'glass', '眼镜儿'],
    category: '物品',
    hint: '戴在眼前，两片镜片加一根鼻梁',
    strokes: [
      { kind: 'circle', cx: 372, cy: 312, r: 104, fill: 'none', width: 8 },
      { kind: 'circle', cx: 628, cy: 312, r: 104, fill: 'none', width: 8 },
      { d: 'M 476 312 C 492 292 508 292 524 312', width: 8 },
      { d: 'M 268 300 C 234 290 208 300 190 322 M 732 300 C 766 290 792 300 810 322', width: 7 },
      { d: 'M 316 264 C 338 240 366 230 394 232', stroke: '#ffffff', width: 6 },
    ],
  },
  {
    id: 'rocket',
    word: '火箭',
    aliases: ['小火箭', 'rocket', '飞船'],
    category: '交通',
    hint: '屁股喷火，飞向太空',
    strokes: [
      { d: 'M 500 120 C 570 180 590 280 570 380 L 430 380 C 410 280 430 180 500 120 Z', fill: '#dceeff' },
      { kind: 'circle', cx: 500, cy: 268, r: 30, fill: '#a9d3f2' },
      { d: 'M 430 330 L 372 410 L 430 400 Z', fill: '#ffd6de' },
      { d: 'M 570 330 L 628 410 L 570 400 Z', fill: '#ffd6de' },
      { d: 'M 456 380 L 456 440 L 544 440 L 544 380 Z', fill: '#ffe9b8' },
      { d: 'M 470 460 C 460 500 500 530 500 574 C 500 530 540 500 530 460 Z', fill: '#ffd0a6' },
      { d: 'M 320 460 C 300 490 300 520 320 540 M 680 460 C 700 490 700 520 680 540', stroke: '#a9d3f2', width: 5 },
    ],
  },
  // —— 成语 / 俗语题：画面只给线索，答案要想一层 ——
  {
    id: 'idiom-snake-feet',
    word: '画蛇添足',
    aliases: ['画蛇添足', '多此一举'],
    category: '成语',
    difficulty: 'hard',
    hint: '本来没有脚，偏要再添上四只',
    strokes: [
      { d: 'M 150 420 C 210 340 320 330 400 380 C 470 424 540 440 610 410 C 670 384 700 360 740 372 C 790 386 800 430 760 452 C 715 476 660 452 610 470 C 540 495 470 485 400 470 C 320 452 240 456 190 430 Z', fill: '#c7e8b6' },
      { kind: 'circle', cx: 790, cy: 392, r: 44, fill: '#c7e8b6' },
      { kind: 'circle', cx: 808, cy: 378, r: 9, fill: INK },
      { d: 'M 828 406 L 884 396 L 908 378 M 884 396 L 908 414', width: 5, stroke: '#ff8fa3' },
      { d: 'M 330 452 L 308 514 L 348 520 L 360 464', fill: '#ffd0a6' },
      { d: 'M 470 480 L 448 542 L 488 548 L 500 486', fill: '#ffd0a6' },
      { d: 'M 606 462 L 586 524 L 626 530 L 636 470', fill: '#ffd0a6' },
      { d: 'M 716 436 L 700 498 L 740 502 L 750 444', fill: '#ffd0a6' },
    ],
  },
  {
    id: 'idiom-wait-rabbit',
    word: '守株待兔',
    aliases: ['守株待兔', '守株', '坐等兔子'],
    category: '成语',
    difficulty: 'hard',
    hint: '守在树桩旁，等猎物自己撞上来',
    strokes: [
      { kind: 'ellipse', cx: 260, cy: 330, rx: 105, ry: 36, fill: '#e6c9a8' },
      { d: 'M 170 330 L 190 545 L 330 545 L 350 330 Z', fill: '#e6c9a8' },
      { kind: 'ellipse', cx: 260, cy: 330, rx: 70, ry: 22, fill: 'none', width: 4 },
      { d: 'M 220 380 L 240 500 M 290 380 L 280 500', width: 4, stroke: '#c7a97f' },
      { kind: 'ellipse', cx: 630, cy: 440, rx: 135, ry: 92, fill: '#ffffff' },
      { kind: 'circle', cx: 750, cy: 340, r: 60, fill: '#ffffff' },
      { kind: 'ellipse', cx: 718, cy: 238, rx: 25, ry: 74, fill: '#ffd6de', transform: 'rotate(-12 718 238)' },
      { kind: 'ellipse', cx: 782, cy: 232, rx: 25, ry: 74, fill: '#ffd6de', transform: 'rotate(10 782 232)' },
      { kind: 'circle', cx: 772, cy: 330, r: 9, fill: INK },
      { d: 'M 800 356 L 842 350 L 806 374', width: 4 },
      { d: 'M 540 520 L 540 560 M 700 524 L 700 560', width: 7 },
      { d: 'M 505 420 C 460 410 448 380 466 356', width: 7 },
    ],
  },
  {
    id: 'idiom-well-frog',
    word: '井底之蛙',
    aliases: ['井底之蛙', '井底蛙', '井蛙'],
    category: '成语',
    difficulty: 'hard',
    hint: '坐在井里，只看见巴掌大的天',
    strokes: [
      { d: 'M 320 220 L 350 540 L 650 540 L 680 220 Z', fill: '#dceeff' },
      { d: 'M 320 300 L 680 300 M 330 370 L 670 370 M 340 440 L 660 440 M 345 505 L 655 505', width: 4, stroke: '#a9c4d6' },
      { kind: 'ellipse', cx: 500, cy: 220, rx: 190, ry: 54, fill: '#a9d3f2' },
      { kind: 'ellipse', cx: 500, cy: 228, rx: 146, ry: 34, fill: '#7fbde8' },
      { kind: 'ellipse', cx: 500, cy: 306, rx: 74, ry: 56, fill: '#c7e8b6' },
      { kind: 'circle', cx: 466, cy: 268, r: 20, fill: '#ffffff' },
      { kind: 'circle', cx: 534, cy: 268, r: 20, fill: '#ffffff' },
      { kind: 'circle', cx: 470, cy: 270, r: 8, fill: INK },
      { kind: 'circle', cx: 530, cy: 270, r: 8, fill: INK },
      { d: 'M 470 326 C 490 340 510 340 530 326', width: 4 },
      { d: 'M 440 340 C 420 380 424 412 448 426 M 560 340 C 580 380 576 412 552 426', width: 7 },
    ],
  },
  {
    id: 'idiom-cover-ears',
    word: '掩耳盗铃',
    aliases: ['掩耳盗铃', '掩耳盗钟', '自欺欺人'],
    category: '成语',
    difficulty: 'hard',
    hint: '捂住自己的耳朵，以为别人也听不见',
    strokes: [
      { kind: 'circle', cx: 400, cy: 260, r: 82, fill: '#ffe9b8' },
      { d: 'M 330 340 C 300 416 300 500 322 552 L 478 552 C 500 500 500 416 470 340 Z', fill: '#a9d3f2' },
      { kind: 'circle', cx: 320, cy: 294, r: 30, fill: '#ffe9b8' },
      { d: 'M 360 270 C 318 246 292 262 300 304', width: 10 },
      { kind: 'circle', cx: 480, cy: 294, r: 30, fill: '#ffe9b8' },
      { d: 'M 442 270 C 484 246 510 262 502 304', width: 10 },
      { kind: 'circle', cx: 388, cy: 252, r: 8, fill: INK },
      { d: 'M 424 296 C 444 306 464 306 480 296', width: 4 },
      { d: 'M 630 200 C 650 168 690 168 714 200', width: 8 },
      { d: 'M 630 200 C 610 260 600 330 590 380 L 756 380 C 744 330 734 260 714 200 Z', fill: '#ffe9b8' },
      { kind: 'circle', cx: 672, cy: 392, r: 14, fill: INK },
    ],
  },
  {
    id: 'idiom-lute-cow',
    word: '对牛弹琴',
    aliases: ['对牛弹琴'],
    category: '成语',
    difficulty: 'hard',
    hint: '对着听不懂的听众，白费口舌',
    strokes: [
      { kind: 'ellipse', cx: 320, cy: 330, rx: 132, ry: 108, fill: '#ffffff' },
      { kind: 'ellipse', cx: 320, cy: 402, rx: 82, ry: 56, fill: '#ffd6de' },
      { kind: 'circle', cx: 276, cy: 296, r: 10, fill: INK },
      { kind: 'circle', cx: 364, cy: 296, r: 10, fill: INK },
      { kind: 'circle', cx: 302, cy: 410, r: 7, fill: INK },
      { kind: 'circle', cx: 340, cy: 410, r: 7, fill: INK },
      { d: 'M 242 268 C 208 210 242 182 286 206', width: 8 },
      { d: 'M 398 268 C 432 210 398 182 354 206', width: 8 },
      { kind: 'ellipse', cx: 690, cy: 430, rx: 116, ry: 82, fill: '#e6c9a8' },
      { kind: 'circle', cx: 690, cy: 430, r: 24, fill: '#c7a97f' },
      { d: 'M 690 348 L 758 170', width: 10 },
      { d: 'M 758 170 L 800 260 M 758 170 L 720 260', width: 5 },
      { d: 'M 620 240 C 608 196 636 170 668 182 M 620 240 C 580 232 558 254 560 284', width: 5, stroke: '#7fbde8' },
    ],
  },
  {
    id: 'idiom-fire-oil',
    word: '火上浇油',
    aliases: ['火上浇油', '火上加油', '火上添油'],
    category: '成语',
    difficulty: 'hard',
    hint: '越烧越旺时，又添了一把助燃物',
    strokes: [
      { d: 'M 500 545 C 410 520 370 440 424 356 C 442 400 468 408 478 364 C 486 300 512 262 540 214 C 560 292 622 330 610 404 C 660 380 692 450 648 508 C 616 548 550 558 500 545 Z', fill: '#ffd0a6' },
      { d: 'M 500 530 C 448 508 430 460 462 414 C 476 442 496 440 506 404 C 520 356 534 326 550 300 C 566 348 604 376 596 426 C 622 416 640 456 612 490 C 586 516 540 530 500 530 Z', fill: '#ffd6de' },
      { d: 'M 660 190 L 790 250 L 738 360 L 620 300 Z', fill: '#a9d3f2' },
      { d: 'M 690 222 C 700 170 740 160 770 178', width: 7 },
      { d: 'M 620 300 C 590 330 590 370 606 402', width: 7, stroke: '#ffe9b8' },
      { kind: 'circle', cx: 590, cy: 430, r: 12, fill: '#ffe9b8' },
      { kind: 'circle', cx: 640, cy: 470, r: 9, fill: '#ffe9b8' },
    ],
  },
  {
    id: 'idiom-one-arrow',
    word: '一箭双雕',
    aliases: ['一箭双雕', '一箭双鸟', '一石二鸟'],
    category: '成语',
    difficulty: 'hard',
    hint: '一次出手，同时拿下两个目标',
    strokes: [
      { d: 'M 360 340 C 400 300 460 300 500 340 C 460 360 430 390 410 420 C 390 390 370 360 360 340 Z', fill: '#e6c9a8' },
      { d: 'M 580 250 C 620 210 680 210 720 250 C 680 270 650 300 630 330 C 610 300 590 270 580 250 Z', fill: '#e6c9a8' },
      { d: 'M 120 540 L 880 160', width: 9 },
      { d: 'M 880 160 L 800 172 L 832 208 Z', fill: INK },
      { d: 'M 120 540 L 80 500 M 120 540 L 92 566', width: 7 },
      { kind: 'circle', cx: 436, cy: 326, r: 7, fill: INK },
      { kind: 'circle', cx: 656, cy: 236, r: 7, fill: INK },
    ],
  },
  {
    id: 'idiom-mend-pen',
    word: '亡羊补牢',
    aliases: ['亡羊补牢', '亡羊补圈'],
    category: '成语',
    difficulty: 'hard',
    hint: '东西丢了才修围栏，晚了但还能补救',
    strokes: [
      { d: 'M 150 300 L 540 300 M 150 390 L 540 390', width: 10 },
      { d: 'M 190 250 L 190 500 M 290 250 L 290 500 M 390 250 L 390 500 M 490 250 L 490 500', width: 9 },
      { d: 'M 560 330 L 620 520 M 640 300 L 610 520', width: 8, stroke: '#c7a97f' },
      { kind: 'ellipse', cx: 760, cy: 420, rx: 110, ry: 74, fill: '#ffffff' },
      { kind: 'circle', cx: 830, cy: 350, r: 46, fill: '#ffe9b8' },
      { kind: 'ellipse', cx: 806, cy: 310, rx: 16, ry: 32, fill: '#ffe9b8' },
      { kind: 'circle', cx: 844, cy: 344, r: 7, fill: INK },
      { d: 'M 870 368 L 900 360 L 876 382', width: 4 },
      { d: 'M 700 490 L 700 530 M 800 494 L 800 530', width: 7 },
      { d: 'M 670 420 C 640 400 630 370 646 346', width: 7 },
    ],
  },
  {
    id: 'idiom-boat-sword',
    word: '刻舟求剑',
    aliases: ['刻舟求剑'],
    category: '成语',
    difficulty: 'hard',
    hint: '东西落水，却在船上刻记号',
    strokes: [
      { d: 'M 140 420 C 210 530 790 530 860 420 L 780 396 L 220 396 Z', fill: '#e6c9a8' },
      { d: 'M 220 438 L 780 438', width: 4, stroke: '#c7a97f' },
      { d: 'M 500 396 L 500 170', width: 8 },
      { d: 'M 500 190 L 700 330 L 500 360 Z', fill: '#dceeff' },
      { d: 'M 620 448 L 664 492 M 664 448 L 620 492', width: 7, stroke: '#ff8fa3' },
      { d: 'M 820 150 L 870 300', width: 9 },
      { d: 'M 870 300 C 850 318 830 318 820 300 C 830 286 850 286 870 300 Z', fill: '#dceeff' },
      { d: 'M 800 140 L 840 170', width: 8 },
      { d: 'M 100 540 C 200 516 300 560 400 538 C 500 516 600 560 700 538 C 800 516 880 552 940 538', width: 5, stroke: '#7fbde8' },
    ],
  },
  {
    id: 'idiom-fox-tiger',
    word: '狐假虎威',
    aliases: ['狐假虎威'],
    category: '成语',
    difficulty: 'hard',
    hint: '小个子借大王的威风吓人',
    strokes: [
      { kind: 'ellipse', cx: 380, cy: 380, rx: 180, ry: 125, fill: '#ffd0a6' },
      { kind: 'circle', cx: 620, cy: 310, r: 100, fill: '#ffd0a6' },
      { kind: 'circle', cx: 560, cy: 244, r: 30, fill: '#ffd0a6' },
      { kind: 'circle', cx: 680, cy: 244, r: 30, fill: '#ffd0a6' },
      { d: 'M 540 320 L 570 300 M 560 350 L 530 370 M 660 300 L 636 322 M 680 350 L 706 372', width: 7 },
      { kind: 'circle', cx: 590, cy: 296, r: 9, fill: INK },
      { kind: 'circle', cx: 650, cy: 296, r: 9, fill: INK },
      { kind: 'circle', cx: 620, cy: 338, r: 10, fill: INK },
      { d: 'M 588 360 C 606 374 634 374 652 360', width: 4 },
      { kind: 'ellipse', cx: 770, cy: 470, rx: 80, ry: 54, fill: '#ffb27a' },
      { kind: 'circle', cx: 830, cy: 410, r: 46, fill: '#ffb27a' },
      { d: 'M 806 376 L 790 330 L 830 356 Z M 852 376 L 872 330 L 838 356 Z', fill: '#ffb27a' },
      { kind: 'circle', cx: 846, cy: 404, r: 7, fill: INK },
      { d: 'M 806 486 C 880 450 910 500 870 530 C 850 544 820 528 806 510 Z', fill: '#ffb27a' },
    ],
  },
  {
    id: 'idiom-spear-shield',
    word: '自相矛盾',
    aliases: ['自相矛盾', '矛盾'],
    category: '成语',
    difficulty: 'hard',
    hint: '两样东西互相打脸，说法前后不通',
    strokes: [
      { d: 'M 280 190 L 450 190 L 466 360 C 438 438 380 486 320 512 C 262 476 232 412 226 360 Z', fill: '#a9d3f2' },
      { d: 'M 280 230 L 320 320 L 380 230 M 280 230 L 420 360', width: 4, stroke: '#ffffff' },
      { d: 'M 560 560 L 860 160', width: 10 },
      { d: 'M 860 160 L 786 178 L 818 214 Z', fill: '#dceeff' },
      { kind: 'circle', cx: 560, cy: 560, r: 12, fill: INK },
      { d: 'M 600 470 L 650 480 M 640 440 L 690 450', width: 5, stroke: '#ffd0a6' },
    ],
  },
  {
    id: 'saying-horse-tiger',
    word: '马马虎虎',
    aliases: ['马马虎虎', '马虎'],
    category: '俗语',
    difficulty: 'hard',
    hint: '做事不认真，草草了事',
    strokes: [
      { kind: 'ellipse', cx: 300, cy: 400, rx: 150, ry: 86, fill: '#e6c9a8' },
      { d: 'M 380 340 C 420 270 470 240 510 268 C 530 304 508 344 470 360 L 440 420 Z', fill: '#e6c9a8' },
      { kind: 'circle', cx: 510, cy: 286, r: 40, fill: '#e6c9a8' },
      { d: 'M 482 254 L 472 214 L 500 238 Z M 530 254 L 542 214 L 514 238 Z', fill: '#e6c9a8' },
      { kind: 'circle', cx: 522, cy: 284, r: 7, fill: INK },
      { d: 'M 470 380 L 460 520 M 380 448 L 380 528 M 240 448 L 240 528 M 180 420 C 130 410 120 380 138 356', width: 8 },
      { d: 'M 420 270 C 440 300 460 320 486 330', width: 4 },
      { kind: 'circle', cx: 760, cy: 340, r: 100, fill: '#ffd0a6' },
      { kind: 'circle', cx: 690, cy: 270, r: 30, fill: '#ffd0a6' },
      { kind: 'circle', cx: 830, cy: 270, r: 30, fill: '#ffd0a6' },
      { d: 'M 690 350 L 720 330 M 710 380 L 682 396 M 810 330 L 838 350 M 800 380 L 828 396', width: 7 },
      { kind: 'circle', cx: 720, cy: 320, r: 9, fill: INK },
      { kind: 'circle', cx: 800, cy: 320, r: 9, fill: INK },
      { kind: 'circle', cx: 760, cy: 366, r: 10, fill: INK },
      { d: 'M 720 396 C 738 410 782 410 800 396', width: 4 },
    ],
  },
];

/** 去掉 @、空白和常见标点，便于口令与猜词比较 */
export function normalizeDrawText(content) {
  return String(content || '')
    .replace(/^@\S+[\s,，:：]+/, '')
    .replace(/@/g, '')
    .replace(/[\s，,。．.！!？?～~：:；;、'"“”‘’（）()【】\[\]]/g, '')
    .trim();
}

const START_RE = /^(?:你画我猜|画我猜|猜画|开始画画|来画画|画一个|我想玩你画我猜|我要玩你画我猜|玩你画我猜|画画|开画)(?:吧|呀|啊|哦|吗)?$/;
const STOP_RE = /^(?:结束你画我猜|结束画画|结束猜画|停止画画|停止你画我猜|关掉画画|不画了|别画了|收工了|收工)$/;
const HINT_RE = /^(?:提示|提示一下|给点提示|来点提示|再提示一下|给个提示|提示提示)$/;
const SKIP_RE = /^(?:下一题|下一道|换一题|换一道|换一个|换题|跳过|跳过这题|跳过这道|这题跳过)$/;
const RESERVED_RE = /^(?:点歌|点一首|来首|想听|切歌|音量|声音|甩手|甩飞|动作|剧场|关注|提示|下一题|下一道|换一题|跳过|结束你画我猜|结束画画|不画了|收工)/;

export function isDrawStartCommand(content) {
  const text = normalizeDrawText(content);
  return Boolean(text) && text.length <= 12 && START_RE.test(text);
}

export function isDrawStopCommand(content) {
  const text = normalizeDrawText(content);
  return Boolean(text) && text.length <= 12 && STOP_RE.test(text);
}

export function isDrawHintCommand(content) {
  const text = normalizeDrawText(content);
  return Boolean(text) && text.length <= 10 && HINT_RE.test(text);
}

export function isDrawSkipCommand(content) {
  const text = normalizeDrawText(content);
  return Boolean(text) && text.length <= 8 && SKIP_RE.test(text);
}

/** 这条弹幕值不值得当作猜词尝试：太长的正常聊天、点歌/动作等口令直接放行 */
export function isDrawGuessCandidate(content) {
  const text = normalizeDrawText(content);
  if (!text || text.length > 12) return false;
  return !RESERVED_RE.test(text);
}

/**
 * 解析猜词内容：剥掉「我猜是 / 是不是 / 答案 / 吗」等口语外壳。
 * 不是短猜词时返回空串。
 */
export function parseDrawGuess(content) {
  let text = normalizeDrawText(content);
  if (!text) return '';
  for (let round = 0; round < 2; round += 1) {
    const next = text.replace(/^(?:我猜是|我猜|猜猜是|猜是|猜猜|答案是|答案|应该是|这是不是|是不是|这是|是)/, '');
    if (next === text) break;
    text = next;
  }
  text = text.replace(/(?:对不对|对不)$/, '');
  text = text.replace(/(?:吗|吧|呢|啊|呀|哦)$/, '');
  if (!text || text.length > 12) return '';
  return text;
}

function lowerText(value) {
  return String(value || '').trim().toLowerCase();
}

/** 是否猜中当前题：支持别名（猫 / 猫咪 / 喵 都算「小猫」） */
export function matchDrawWord(state, content) {
  if (!state || !state.word) return false;
  const candidate = lowerText(content);
  if (!candidate) return false;
  if (candidate === lowerText(state.word.word)) return true;
  return (state.word.aliases || []).some((alias) => lowerText(alias) === candidate);
}

export function createDrawState() {
  return {
    active: false,
    phase: 'idle', // idle | drawing | guessing | won | revealed | closed
    gameId: '',
    round: 0,
    maxRounds: DRAW_MAX_ROUNDS,
    roundSec: DRAW_ROUND_SEC,
    rounds: [],
    word: null,
    revealed: 0,
    hintShown: false,
    startedAt: 0,
    guessEndsAt: 0,
    nextAt: 0,
    winner: null,
    lastResult: '', // win | timeout | skipped
    guesses: [],
    scores: new Map(),
  };
}

/** 按随机顺序抽题；尽量避开最近几场出过的题，题库不够时才允许重复 */
export function pickDrawDeck(options = {}) {
  const {
    count = DRAW_MAX_ROUNDS,
    exclude = [],
    random = Math.random,
    words = DRAW_WORDS,
  } = options;
  const recent = new Set((Array.isArray(exclude) ? exclude : []).map(String));
  const fresh = words.filter((word) => !recent.has(word.id));
  const pool = fresh.length >= count ? fresh : words.slice();
  const shuffle = (items) => {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const roll = Number(random());
      const safeRoll = Number.isFinite(roll) ? Math.min(0.999999, Math.max(0, roll)) : 0;
      const j = Math.floor(safeRoll * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };
  const shuffled = shuffle(pool);
  const take = Math.min(
    Math.max(1, Math.round(Number(count) || DRAW_MAX_ROUNDS)),
    shuffled.length,
  );
  // 成语 / 俗语题占多数但不包场：默认约 60% 难题，其余保留简单题给新观众
  const hard = shuffled.filter((word) => word.difficulty === 'hard');
  const easy = shuffled.filter((word) => word.difficulty !== 'hard');
  const hardTake = hard.length ? Math.min(hard.length, take, Math.max(1, Math.round(take * 0.6))) : 0;
  const chosen = [...hard.slice(0, hardTake), ...easy.slice(0, Math.max(0, take - hardTake))];
  if (chosen.length < take) {
    const used = new Set(chosen);
    for (const word of shuffled) {
      if (chosen.length >= take) break;
      if (used.has(word)) continue;
      chosen.push(word);
      used.add(word);
    }
  }
  return shuffle(chosen);
}

export function beginDrawGame(state, options = {}) {
  const deck = Array.isArray(options.deck) ? options.deck.filter(Boolean) : [];
  const now = Number(options.now) || Date.now();
  const next = state || createDrawState();
  next.active = deck.length > 0;
  next.phase = deck.length ? 'drawing' : 'closed';
  next.gameId = String(options.gameId || `draw-${now}-${Math.random().toString(36).slice(2, 6)}`);
  next.rounds = deck;
  next.maxRounds = Math.max(1, Math.min(Number(options.maxRounds) || deck.length, deck.length));
  next.roundSec = Math.round(
    Math.min(DRAW_MAX_ROUND_SEC, Math.max(DRAW_MIN_ROUND_SEC, Number(options.roundSec) || DRAW_ROUND_SEC)),
  );
  next.round = 0;
  next.word = null;
  next.revealed = 0;
  next.hintShown = false;
  next.startedAt = now;
  next.guessEndsAt = 0;
  next.nextAt = 0;
  next.winner = null;
  next.lastResult = '';
  next.guesses = [];
  return next;
}

/** 进入下一题；题目用完时返回 null，由调用方收场 */
export function startDrawRound(state, now = Date.now()) {
  if (!state || !state.active) return null;
  if (state.round >= state.maxRounds) return null;
  const word = state.rounds[state.round];
  if (!word) {
    state.round = state.maxRounds;
    return null;
  }
  state.round += 1;
  state.word = word;
  state.revealed = 0;
  state.hintShown = false;
  state.phase = 'drawing';
  state.guessEndsAt = 0;
  state.nextAt = 0;
  state.winner = null;
  state.lastResult = '';
  state.guesses = [];
  return word;
}

/** 揭晓下一笔；最后一笔落下时自动进入猜词倒计时 */
export function revealDrawStroke(state, now = Date.now()) {
  if (!state || !state.active || !state.word || state.phase !== 'drawing') return state ? state.phase : 'closed';
  const total = state.word.strokes.length;
  state.revealed = Math.min(total, state.revealed + 1);
  if (state.revealed >= total) {
    state.phase = 'guessing';
    state.guessEndsAt = now + state.roundSec * 1000;
  }
  return state.phase;
}

export function revealDrawHint(state) {
  if (!state || !state.active || !state.word || state.hintShown) return false;
  if (state.phase !== 'drawing' && state.phase !== 'guessing') return false;
  state.hintShown = true;
  return true;
}

/** 猜词阶段剩余时间到提示阈值时，由主循环自动亮出提示 */
export function shouldRevealDrawHint(state, now = Date.now()) {
  if (!state || !state.active || !state.word || state.hintShown) return false;
  if (state.phase !== 'guessing' || !state.guessEndsAt) return false;
  return state.guessEndsAt - now <= DRAW_HINT_REMAIN_SEC * 1000;
}

/** 猜中得分：基础分 + 速度加成；已经看过提示会少一点 */
export function scoreForDrawWin(state, now = Date.now()) {
  if (!state) return 10;
  const totalMs = Math.max(1000, state.roundSec * 1000);
  const remainMs = Math.max(0, Math.min(totalMs, state.guessEndsAt - now));
  const speedBonus = Math.round((remainMs / totalMs) * 5);
  const base = state.hintShown ? 8 : 12;
  return base + speedBonus;
}

/**
 * 记一次猜词。
 * @returns {{status:'hit'|'miss'|'duplicate'|'closed'|'ignored', word?:string, score?:number}}
 */
export function recordDrawGuess(state, options = {}) {
  const content = parseDrawGuess(options.content);
  if (!state || !state.active || !state.word) return { status: 'closed' };
  if (!content) return { status: 'ignored' };
  if (state.phase !== 'guessing') return { status: 'closed' };
  const key = String(options.key || '').trim();
  if (!key) return { status: 'ignored' };
  const name = String(options.name || '观众').trim().slice(0, 20) || '观众';
  const now = Number(options.now) || Date.now();
  if (matchDrawWord(state, content)) {
    if (state.phase === 'won') return { status: 'duplicate' };
    const score = scoreForDrawWin(state, now);
    state.phase = 'won';
    state.nextAt = now + DRAW_NEXT_DELAY_MS;
    state.winner = { key, name, score };
    state.lastResult = 'win';
    state.guesses.push({ key, name, text: content, hit: true, at: now });
    while (state.guesses.length > 6) state.guesses.shift();
    const record = state.scores.get(key) || { key, name, score: 0, wins: 0 };
    record.name = name;
    record.score += score;
    record.wins += 1;
    state.scores.set(key, record);
    return { status: 'hit', word: state.word.word, score };
  }
  const last = state.guesses[state.guesses.length - 1];
  if (!last || last.key !== key || last.text !== content) {
    state.guesses.push({ key, name, text: content, hit: false, at: now });
    while (state.guesses.length > 6) state.guesses.shift();
  }
  return { status: 'miss', word: null };
}

/** 观众发「下一题」跳过当前题（不计分），答案仍然公布 */
export function skipDrawRound(state, now = Date.now()) {
  if (!state || !state.active || !state.word) return '';
  if (state.phase === 'won' || state.phase === 'revealed') return '';
  state.revealed = state.word.strokes.length;
  state.phase = 'revealed';
  state.guessEndsAt = 0;
  state.nextAt = now + DRAW_NEXT_DELAY_MS;
  state.lastResult = 'skipped';
  state.winner = null;
  return state.word.word;
}

/** 猜词超时：亮出答案并进入下一题倒计时 */
export function expireDrawRound(state, now = Date.now()) {
  if (!state || !state.active || !state.word || state.phase !== 'guessing') return '';
  if (now < state.guessEndsAt) return '';
  state.revealed = state.word.strokes.length;
  state.phase = 'revealed';
  state.guessEndsAt = 0;
  state.nextAt = now + DRAW_NEXT_DELAY_MS;
  state.lastResult = 'timeout';
  return state.word.word;
}

export function finishDrawGame(state) {
  if (!state) return state;
  state.active = false;
  state.phase = 'closed';
  state.word = null;
  state.round = 0;
  state.revealed = 0;
  state.hintShown = false;
  state.guessEndsAt = 0;
  state.nextAt = 0;
  state.winner = null;
  state.guesses = [];
  state.lastResult = '';
  return state;
}

/** 从持久化记录恢复每日积分榜 */
export function hydrateDrawScores(state, records) {
  if (!state) return state;
  if (!state.scores) state.scores = new Map();
  const list = Array.isArray(records) ? records : [];
  for (const item of list.slice(0, 100)) {
    if (!item || typeof item !== 'object') continue;
    const key = String(item.key || '').trim();
    if (!key) continue;
    const score = Math.max(0, Math.round(Number(item.score) || 0));
    const wins = Math.max(0, Math.round(Number(item.wins) || 0));
    if (!score && !wins) continue;
    state.scores.set(key, {
      key,
      name: String(item.name || '观众').trim().slice(0, 20) || '观众',
      score,
      wins,
    });
  }
  return state;
}

export function drawScoreboard(state, limit = 5) {
  if (!state || !state.scores) return [];
  return [...state.scores.values()]
    .filter((item) => item && (item.score > 0 || item.wins > 0))
    .sort((a, b) => b.score - a.score || b.wins - a.wins)
    .slice(0, Math.max(1, Math.round(Number(limit) || 5)))
    .map((item) => ({ name: item.name, score: item.score, wins: item.wins }));
}

/** 词面：猜中/超时/跳过时显示完整答案，提示开启时先露出第一个字 */
export function drawBlankText(state) {
  if (!state || !state.word) return '';
  const chars = [...state.word.word];
  if (state.phase === 'won' || state.phase === 'revealed') return chars.join(' ');
  return chars.map((char, index) => (state.hintShown && index === 0 ? char : '＿')).join(' ');
}

/** 推给背景板的数据快照：只包含已经揭晓的笔画，避免提前泄露答案 */
export function drawGuessSnapshot(state, now = Date.now()) {
  if (!state) return { active: false };
  const word = state.word;
  const showAll = state.phase === 'won' || state.phase === 'revealed';
  const strokes = word ? word.strokes.slice(0, showAll ? word.strokes.length : state.revealed) : [];
  return {
    active: Boolean(state.active),
    phase: state.phase,
    gameId: state.gameId,
    round: state.round,
    maxRounds: state.maxRounds,
    wordId: word ? word.id : '',
    category: word ? word.category : '',
    hint: state.hintShown && word ? word.hint : '',
    hintAvailable: Boolean(word && !state.hintShown && (state.phase === 'guessing' || state.phase === 'drawing')),
    blank: drawBlankText(state),
    answer: showAll && word ? word.word : '',
    length: word ? [...word.word].length : 0,
    revealed: strokes.length,
    total: word ? word.strokes.length : 0,
    strokes,
    guessEndsAt: state.guessEndsAt,
    nextAt: state.nextAt,
    roundSec: state.roundSec,
    winner: state.winner ? { name: state.winner.name, score: state.winner.score } : null,
    lastResult: state.lastResult,
    guesses: state.guesses.slice(-6).map((item) => ({
      name: item.name,
      text: item.text,
      hit: Boolean(item.hit),
    })),
    scores: drawScoreboard(state, 5),
    seconds: state.phase === 'guessing'
      ? Math.max(0, Math.round((state.guessEndsAt - now) / 1000))
      : 0,
  };
}
