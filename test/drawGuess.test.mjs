import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DRAW_HINT_REMAIN_SEC,
  DRAW_MAX_ROUNDS,
  DRAW_NEXT_DELAY_MS,
  DRAW_WORDS,
  beginDrawGame,
  createDrawState,
  drawBlankText,
  drawGuessSnapshot,
  drawScoreboard,
  expireDrawRound,
  finishDrawGame,
  hydrateDrawScores,
  isDrawGuessCandidate,
  isDrawHintCommand,
  isDrawSkipCommand,
  isDrawStartCommand,
  isDrawStopCommand,
  pickDrawDeck,
  recordDrawGuess,
  revealDrawHint,
  revealDrawStroke,
  shouldRevealDrawHint,
  skipDrawRound,
  startDrawRound,
} from '../extension/app/core/drawGuess.js';

test('题库结构完整且 id / 词面不重复', () => {
  assert.ok(DRAW_WORDS.length >= 12);
  const ids = new Set();
  const words = new Set();
  for (const word of DRAW_WORDS) {
    assert.ok(word.id && !ids.has(word.id), `重复 id: ${word.id}`);
    assert.ok(word.word && !words.has(word.word), `重复词面: ${word.word}`);
    assert.ok(word.category && word.hint, `缺少分类或提示: ${word.id}`);
    assert.ok(Array.isArray(word.strokes) && word.strokes.length >= 3, `笔画太少: ${word.id}`);
    for (const stroke of word.strokes) {
      const kind = stroke.kind || 'path';
      assert.ok(['path', 'circle', 'ellipse', 'line'].includes(kind), `未知笔画类型: ${kind}`);
      if (kind === 'path') assert.ok(String(stroke.d || '').trim(), `空路径: ${word.id}`);
    }
    ids.add(word.id);
    words.add(word.word);
  }
});

test('题库包含成语俗语难题，每局以难题为主', () => {
  const hard = DRAW_WORDS.filter((word) => word.difficulty === 'hard');
  assert.ok(hard.length >= 10, '成语 / 俗语题至少 10 个');
  for (const word of hard) {
    assert.ok(['成语', '俗语'].includes(word.category), `难题分类不对: ${word.id}`);
    assert.equal(word.word.length, 4, `难题应为四字: ${word.word}`);
    assert.ok(!word.hint.includes(word.word), `提示不能直接含谜底: ${word.word}`);
  }
  const deck = pickDrawDeck({ count: 5, random: () => 0.5 });
  assert.equal(deck.length, 5);
  assert.equal(deck.filter((word) => word.difficulty === 'hard').length, 3);
  assert.ok(deck.some((word) => word.difficulty !== 'hard'), '保留简单题给新观众');
});

test('抽题尽量避开最近出过的题', () => {
  const deck = pickDrawDeck({ count: 3, exclude: ['cat', 'fish', 'apple'], random: () => 0.3 });
  assert.equal(deck.length, 3);
  assert.ok(deck.every((word) => !['cat', 'fish', 'apple'].includes(word.id)));
  const ids = deck.map((word) => word.id);
  assert.equal(new Set(ids).size, ids.length);
  // 题库不够排除时仍然能凑满
  const exhausted = pickDrawDeck({ count: 3, exclude: DRAW_WORDS.map((word) => word.id), random: () => 0.5 });
  assert.equal(exhausted.length, 3);
});

test('口令识别', () => {
  assert.equal(isDrawStartCommand('你画我猜'), true);
  assert.equal(isDrawStartCommand('@大肥鱼 开始画画吧！'), true);
  assert.equal(isDrawStartCommand('画画'), true);
  assert.equal(isDrawStartCommand('点歌 晴天'), false);
  assert.equal(isDrawStopCommand('结束你画我猜'), true);
  assert.equal(isDrawStopCommand('不画了'), true);
  assert.equal(isDrawStopCommand('别画了老公'), false);
  assert.equal(isDrawHintCommand('提示'), true);
  assert.equal(isDrawHintCommand('给点提示'), true);
  assert.equal(isDrawHintCommand('提示一下猫'), false);
  assert.equal(isDrawSkipCommand('下一题'), true);
  assert.equal(isDrawSkipCommand('换一题'), true);
  assert.equal(isDrawSkipCommand('跳过这题'), true);
});

test('猜词候选过滤：点歌等口令不被当成猜词', () => {
  assert.equal(isDrawGuessCandidate('小猫'), true);
  assert.equal(isDrawGuessCandidate('是猫咪吗'), true);
  assert.equal(isDrawGuessCandidate('点歌 晴天'), false);
  assert.equal(isDrawGuessCandidate('甩飞 @某人'), false);
  assert.equal(isDrawGuessCandidate('这是一段特别特别长的普通聊天内容不应该被猜词吞掉'), false);
});

test('猜词解析剥掉口语外壳', () => {
  const check = (input, expected) => {
    const parsed = recordInput(input);
    assert.equal(parsed, expected, input);
  };
  check('小猫', '小猫');
  check('是猫咪吗', '猫咪');
  check('我猜是小鱼', '小鱼');
  check('答案是爱心！', '爱心');
  check('是不是苹果呀', '苹果');
  check('@大肥鱼 鲸鱼', '鲸鱼');
  check('今天天气真好呀', '今天天气真好');
  check('', '');
});

function recordInput(input) {
  // parseDrawGuess 不直接导出时用的兜底：通过 recordDrawGuess 的候选判断间接校验
  const state = createDrawState();
  state.active = true;
  state.phase = 'guessing';
  state.word = { word: '不存在的词', aliases: [] };
  const result = recordDrawGuess(state, { key: 'u1', name: '小明', content: input, now: 1000 });
  if (result.status === 'ignored') return '';
  return state.guesses[state.guesses.length - 1]?.text || '';
}

test('一局完整流程：逐笔揭晓 → 猜中 → 下一题', () => {
  const now = 1000;
  const state = createDrawState();
  state.scores.set('old', { key: 'old', name: '老观众', score: 5, wins: 2 });
  beginDrawGame(state, { deck: [DRAW_WORDS[0], DRAW_WORDS[1]], now, roundSec: 60, maxRounds: 2 });
  assert.equal(state.active, true);
  assert.equal(state.maxRounds, 2);

  assert.equal(startDrawRound(state, now), DRAW_WORDS[0]);
  assert.equal(state.phase, 'drawing');
  assert.equal(state.revealed, 0);
  assert.equal(state.guessEndsAt, 0);
  assert.equal(state.scores.size, 1, '开局不应清空每日积分榜');

  let snapshot = drawGuessSnapshot(state, now);
  assert.equal(snapshot.blank, '＿ ＿');
  assert.equal(snapshot.strokes.length, 0);
  assert.equal(snapshot.answer, '');

  const total = state.word.strokes.length;
  for (let index = 0; index < total - 1; index += 1) {
    assert.equal(revealDrawStroke(state, now), 'drawing');
  }
  assert.equal(state.revealed, total - 1);
  assert.equal(revealDrawStroke(state, now), 'guessing');
  assert.equal(state.guessEndsAt, now + 60000);

  snapshot = drawGuessSnapshot(state, now);
  assert.equal(snapshot.strokes.length, total);
  assert.equal(snapshot.answer, '');
  assert.equal(snapshot.phase, 'guessing');

  const miss = recordDrawGuess(state, { key: 'u2', name: '小红', content: '小狗', now });
  assert.equal(miss.status, 'miss');
  assert.equal(state.guesses.length, 1);

  const hit = recordDrawGuess(state, { key: 'u1', name: '小明', content: '是猫咪吗', now: now + 10000 });
  assert.equal(hit.status, 'hit');
  assert.equal(hit.word, '小猫');
  assert.ok(hit.score >= 10);
  assert.equal(state.phase, 'won');
  assert.equal(state.nextAt, now + 10000 + DRAW_NEXT_DELAY_MS);
  assert.deepEqual(state.winner, { key: 'u1', name: '小明', score: hit.score });
  const score = state.scores.get('u1');
  assert.equal(score.score, hit.score);
  assert.equal(score.wins, 1);

  snapshot = drawGuessSnapshot(state, now + 10000);
  assert.equal(snapshot.answer, '小猫');
  assert.equal(snapshot.blank, '小 猫');
  assert.equal(snapshot.winner.name, '小明');
  assert.equal(snapshot.scores[0].name, '小明');

  // 重复答对不会重复加分
  const duplicate = recordDrawGuess(state, { key: 'u2', name: '小红', content: '小猫', now: now + 12000 });
  assert.equal(duplicate.status, 'closed');

  assert.equal(startDrawRound(state, now + 15000), DRAW_WORDS[1]);
  assert.equal(state.round, 2);
  assert.equal(state.guesses.length, 0);
});

test('提示会掉分并露出首字', () => {
  const now = 1000;
  const state = createDrawState();
  beginDrawGame(state, { deck: [DRAW_WORDS[0]], now, roundSec: 60, maxRounds: 1 });
  startDrawRound(state, now);
  state.phase = 'guessing';
  state.guessEndsAt = now + 60000;
  assert.equal(shouldRevealDrawHint(state, now + 30000), false);
  assert.equal(shouldRevealDrawHint(state, now + 60000 - DRAW_HINT_REMAIN_SEC * 1000), true);
  assert.equal(revealDrawHint(state), true);
  assert.equal(revealDrawHint(state), false);
  assert.equal(drawBlankText(state), '小 ＿');
  assert.equal(drawGuessSnapshot(state, now).hint, state.word.hint);
  const hit = recordDrawGuess(state, { key: 'u1', name: '小明', content: '小猫', now: now + 59000 });
  assert.equal(hit.status, 'hit');
  assert.equal(hit.score, 8, '提示后没有速度加成时只有基础分');
});

test('超时、跳过与收场', () => {
  const now = 1000;
  const state = createDrawState();
  beginDrawGame(state, { deck: [DRAW_WORDS[0], DRAW_WORDS[1]], now, roundSec: 30, maxRounds: 2 });
  startDrawRound(state, now);
  state.phase = 'guessing';
  state.guessEndsAt = now + 30000;
  assert.equal(expireDrawRound(state, now + 1000), '');
  assert.equal(expireDrawRound(state, now + 31000), '小猫');
  assert.equal(state.phase, 'revealed');
  assert.equal(state.lastResult, 'timeout');
  assert.equal(state.nextAt, now + 31000 + DRAW_NEXT_DELAY_MS);
  assert.equal(drawGuessSnapshot(state, now + 31000).answer, '小猫');

  assert.equal(startDrawRound(state, now + 40000), DRAW_WORDS[1]);
  const skipped = skipDrawRound(state, now + 40000);
  assert.equal(skipped, '小鱼');
  assert.equal(state.phase, 'revealed');
  assert.equal(state.lastResult, 'skipped');
  assert.equal(state.winner, null);
  assert.equal(skipDrawRound(state, now + 41000), '');

  finishDrawGame(state);
  assert.equal(state.active, false);
  assert.equal(state.word, null);
  assert.equal(drawGuessSnapshot(state).active, false);
});

test('每日积分榜恢复与排序', () => {
  const state = createDrawState();
  hydrateDrawScores(state, [
    { key: 'a', name: '甲', score: 32, wins: 3 },
    { key: 'b', name: '乙', score: 32, wins: 2 },
    { key: 'c', name: '丙', score: 18, wins: 4 },
    { key: '', name: '空', score: 9 },
    null,
  ]);
  assert.equal(state.scores.size, 3);
  const board = drawScoreboard(state, 3);
  assert.deepEqual(board.map((item) => item.name), ['甲', '乙', '丙']);
  assert.equal(board[0].score, 32);
});

test('默认题数不超过题库上限', () => {
  assert.ok(DRAW_MAX_ROUNDS <= DRAW_WORDS.length);
});
