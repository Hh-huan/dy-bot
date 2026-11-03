import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STORY_CHOICES,
  STORY_MAX_NODES,
  STORY_MIN_NODES,
  STORY_TOPICS,
  STORY_VOTE_SEC,
  STORY_WHEEL_SEC,
  beginStory,
  closeStory,
  createStoryState,
  historyLine,
  isStoryStopCommand,
  normalizeEmotion,
  openVoting,
  parseStoryNode,
  parseVoteChoice,
  pushHistory,
  recordVote,
  parseStoryCommand,
  resolveStoryActs,
  resolveStoryTopic,
  resolveWinner,
  storyNodeUserPrompt,
  storyOptionText,
  tallyVotes,
} from '../extension/app/core/storyTheater.js';

const NODE = {
  scene: '海底',
  narration: '鲸鱼娘发现了一个宝箱。',
  a: '打开宝箱',
  b: '先回家',
  c: '绕开走人',
  d: '搬回去研究',
  emotion: 'surprised',
};

test('投票口令覆盖 A/B/C/D/1~4 及常见变体', () => {
  assert.equal(parseVoteChoice('A'), 'A');
  assert.equal(parseVoteChoice('a'), 'A');
  assert.equal(parseVoteChoice('Ａ'), 'A');
  assert.equal(parseVoteChoice('选A'), 'A');
  assert.equal(parseVoteChoice('选 A'), 'A');
  assert.equal(parseVoteChoice('A选项'), 'A');
  assert.equal(parseVoteChoice('1'), 'A');
  assert.equal(parseVoteChoice('①'), null);
  assert.equal(parseVoteChoice('B'), 'B');
  assert.equal(parseVoteChoice('b'), 'B');
  assert.equal(parseVoteChoice('选B'), 'B');
  assert.equal(parseVoteChoice('2'), 'B');
  assert.equal(parseVoteChoice('C'), 'C');
  assert.equal(parseVoteChoice('c'), 'C');
  assert.equal(parseVoteChoice('选C'), 'C');
  assert.equal(parseVoteChoice('3'), 'C');
  assert.equal(parseVoteChoice('D'), 'D');
  assert.equal(parseVoteChoice('d'), 'D');
  assert.equal(parseVoteChoice('选D'), 'D');
  assert.equal(parseVoteChoice('4'), 'D');
  assert.equal(parseVoteChoice('@鲸鱼娘 A'), 'A');
});

test('正常弹幕不会被当成投票', () => {
  assert.equal(parseVoteChoice(''), null);
  assert.equal(parseVoteChoice('点歌 A'), null);
  assert.equal(parseVoteChoice('大家晚上好'), null);
  assert.equal(parseVoteChoice('A 和 B 都不错'), null);
  assert.equal(parseVoteChoice('我想选A因为宝箱听起来更好'), null);
  assert.equal(parseVoteChoice('开门'), null);
});

test('同一观众只算一票，不同观众可以分别投票', () => {
  const story = beginStory(createStoryState(), '深海探险', 1000);
  openVoting(story, NODE, { now: 1000, seconds: 15 });
  assert.equal(recordVote(story, 'A', 'u1').ok, true);
  assert.equal(recordVote(story, 'B', 'u1').ok, false);
  assert.equal(recordVote(story, 'B', 'u1').duplicate, true);
  assert.equal(recordVote(story, 'B', 'u2').ok, true);
  recordVote(story, 'C', 'u3');
  recordVote(story, 'D', 'u4');
  assert.deepEqual(tallyVotes(story), { a: 1, b: 1, c: 1, d: 1, total: 4 });
});

test('非投票阶段不收票', () => {
  const story = beginStory(createStoryState(), '深海探险');
  assert.equal(recordVote(story, 'A', 'u1').ok, false);
  assert.equal(story.phase, 'narrating');
});

test('票数多的走向胜出，平票在并列领先的走向里随机且标记 tied', () => {
  const story = beginStory(createStoryState(), '深海探险');
  openVoting(story, NODE);
  recordVote(story, 'A', 'u1');
  recordVote(story, 'A', 'u2');
  recordVote(story, 'B', 'u3');
  recordVote(story, 'C', 'u4');
  const winner = resolveWinner(story);
  assert.equal(winner.choice, 'A');
  assert.equal(winner.tied, false);
  assert.equal(winner.a, 2);
  assert.equal(winner.b, 1);
  assert.equal(winner.c, 1);

  // A 与 C 并列领先：随机只在并列的两条走向里选，不会落到票少的 B / D
  const tiedStory = beginStory(createStoryState(), '深海探险');
  openVoting(tiedStory, NODE);
  recordVote(tiedStory, 'A', 'u1');
  recordVote(tiedStory, 'A', 'u2');
  recordVote(tiedStory, 'B', 'u3');
  recordVote(tiedStory, 'C', 'u4');
  recordVote(tiedStory, 'C', 'u5');
  assert.equal(resolveWinner(tiedStory, () => 0).choice, 'A');
  assert.equal(resolveWinner(tiedStory, () => 0.9).choice, 'C');
  assert.equal(resolveWinner(tiedStory, () => 0.9).tied, true);

  // 零票时四条走向都在并列里，随机可以落到任意一条
  const empty = beginStory(createStoryState(), '深海探险');
  openVoting(empty, NODE);
  assert.equal(resolveWinner(empty, () => 0.1).choice, 'A');
  assert.equal(resolveWinner(empty, () => 0.9).choice, 'D');
  assert.equal(resolveWinner(empty, () => 0.9).tied, true);
});

test('剧情走向文案可按选择取出，未知选择返回空串', () => {
  assert.equal(storyOptionText(NODE, 'A'), '打开宝箱');
  assert.equal(storyOptionText(NODE, 'd'), '搬回去研究');
  assert.equal(storyOptionText(NODE, 'E'), '');
  assert.equal(storyOptionText(null, 'A'), '');
});

test('剧情历史记录观众选择并限制长度', () => {
  const story = beginStory(createStoryState(), '深海探险');
  const picks = ['A', 'B', 'C', 'D'];
  for (let i = 0; i < 12; i += 1) {
    pushHistory(story, { scene: `第${i}幕`, a: '左', b: '右', c: '前', d: '后' }, picks[i % picks.length]);
  }
  // 最长 6 幕，历史最多保留 6 条
  assert.equal(story.history.length, STORY_MAX_NODES);
  assert.equal(story.history[story.history.length - 1].choice, 'D');
  assert.equal(story.history[story.history.length - 1].picked, '后');
  assert.match(historyLine(story.history), /观众选了/);
});

test('空历史也有可用提示', () => {
  assert.match(historyLine([]), /开场/);
  assert.match(historyLine(null), /开场/);
});

test('解析 AI 返回的剧情 JSON，容忍多余文字和代码块', () => {
  const text = '好的，这是这一幕：\n```json\n{"scene":"海底宝箱","narration":"鲸鱼娘发现宝箱","a":"打开它","b":"绕过去","c":"喊朋友来","d":"搬回洞里","emotion":"excited"}\n```';
  const node = parseStoryNode(text);
  assert.equal(node.scene, '海底宝箱');
  assert.equal(node.narration, '鲸鱼娘发现宝箱');
  assert.equal(node.a, '打开它');
  assert.equal(node.b, '绕过去');
  assert.equal(node.c, '喊朋友来');
  assert.equal(node.d, '搬回洞里');
  assert.equal(node.emotion, 'excited');
});

test('四条走向也接受 options 数组写法', () => {
  const node = parseStoryNode('{"narration":"鲸鱼娘发现宝箱","options":["打开它","绕过去","喊朋友来","搬回洞里"]}');
  assert.equal(node.a, '打开它');
  assert.equal(node.b, '绕过去');
  assert.equal(node.c, '喊朋友来');
  assert.equal(node.d, '搬回洞里');
});

test('字段别名和中文情绪都能识别', () => {
  const node = parseStoryNode('{"scene":"沙滩","line":"鲸鱼娘在晒太阳","choiceA":"下海","choiceB":"睡觉","choiceC":"堆沙堡","choiceD":"捡贝壳","emotion":"害羞"}');
  assert.equal(node.narration, '鲸鱼娘在晒太阳');
  assert.equal(node.a, '下海');
  assert.equal(node.b, '睡觉');
  assert.equal(node.c, '堆沙堡');
  assert.equal(node.d, '捡贝壳');
  assert.equal(node.emotion, 'shy');
});

test('缺关键字段或非法 JSON 返回 null，交给外层重试', () => {
  assert.equal(parseStoryNode(''), null);
  assert.equal(parseStoryNode('我觉得这个故事很好'), null);
  // 缺 narration / 四条走向缺任何一条都是致命问题：观众无法投票或看不懂
  assert.equal(parseStoryNode('{"scene":"海底","narration":"发现宝箱"}'), null);
  assert.equal(parseStoryNode('{"scene":"海底","a":"打开","b":"离开"}'), null);
  assert.equal(
    parseStoryNode('{"narration":"发现宝箱","a":"打开","b":"离开","c":"绕开"}'),
    null,
  );
  // scene 只用于展示，缺失时按空场景继续演
  const noScene = parseStoryNode('{"narration":"发现宝箱","a":"打开","b":"离开","c":"绕开","d":"搬走"}');
  assert.equal(noScene.scene, '');
  assert.equal(noScene.narration, '发现宝箱');
});

test('情绪归一化：未知值落到 neutral', () => {
  assert.equal(normalizeEmotion('HAPPY'), 'happy');
  assert.equal(normalizeEmotion('激动'), 'excited');
  assert.equal(normalizeEmotion('random'), 'neutral');
  assert.equal(normalizeEmotion(''), 'neutral');
});

test('提示词包含主题、进度、前情和四条走向的票数', () => {
  const prompt = storyNodeUserPrompt({
    topic: '深海探险',
    step: 3,
    maxSteps: 4,
    history: [{ scene: '宝箱', choice: 'A', picked: '打开宝箱' }],
    lastChoice: 'A',
    votes: { a: 2, b: 1, c: 1, d: 0, total: 4 },
  });
  assert.match(prompt, /深海探险/);
  assert.match(prompt, /第 3 \/ 4 幕/);
  assert.match(prompt, /打开宝箱/);
  assert.match(prompt, /A 2 票/);
  assert.match(prompt, /C 1 票/);
  assert.match(prompt, /D 0 票/);
  assert.match(prompt, /四个选项/);
  assert.match(prompt, /"d":"选项D"/);
  assert.match(prompt, /留一个悬念/);
  // 最后一幕要收尾，不再留悬念
  const last = storyNodeUserPrompt({ topic: '深海探险', step: 6, maxSteps: 6 });
  assert.match(last, /第 6 \/ 6 幕/);
  assert.match(last, /最后一幕/);
});

test('幕数在 4～6 幕之间随机，beginStory 按随机值定下', () => {
  assert.equal(resolveStoryActs(() => 0), STORY_MIN_NODES);
  assert.equal(resolveStoryActs(() => 0.999999), STORY_MAX_NODES);
  assert.equal(resolveStoryActs(() => 0.5), 5);
  for (const roll of [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1, Number.NaN]) {
    const acts = resolveStoryActs(() => roll);
    assert.ok(acts >= STORY_MIN_NODES && acts <= STORY_MAX_NODES);
    assert.equal(Number.isInteger(acts), true);
  }
  const story = createStoryState();
  beginStory(story, '深海探险', 1000, () => 0);
  assert.equal(story.maxSteps, STORY_MIN_NODES);
  beginStory(story, '深海探险', 1000, () => 0.999999);
  assert.equal(story.maxSteps, STORY_MAX_NODES);
});

test('开演与收尾会重置状态', () => {
  const story = createStoryState();
  story.votes.set('u1', 'A');
  story.phase = 'closed';
  beginStory(story, '深海探险');
  assert.equal(story.active, true);
  assert.equal(story.step, 0);
  assert.equal(story.phase, 'narrating');
  assert.equal(story.votes.size, 0);
  closeStory(story);
  assert.equal(story.active, false);
  assert.equal(story.phase, 'closed');
});

test('默认常量合理：票数窗口、轮盘时长、幕数与走向数量', () => {
  assert.ok(STORY_VOTE_SEC >= 10 && STORY_VOTE_SEC <= 30);
  assert.ok(STORY_WHEEL_SEC >= 3 && STORY_WHEEL_SEC <= 6);
  assert.equal(STORY_MIN_NODES, 4);
  assert.equal(STORY_MAX_NODES, 6);
  assert.equal(STORY_CHOICES.length, 4);
  assert.deepEqual(STORY_CHOICES, ['A', 'B', 'C', 'D']);
  assert.ok(STORY_TOPICS.length >= 4);
});

test('指定剧场主题优先，留空时走随机题材池', () => {
  assert.equal(resolveStoryTopic('大肥鱼失去尾巴'), '大肥鱼失去尾巴');
  assert.equal(resolveStoryTopic('  大肥鱼失去尾巴  '), '大肥鱼失去尾巴');
  assert.equal(resolveStoryTopic('', () => 0), STORY_TOPICS[0]);
  assert.equal(resolveStoryTopic('', () => 0.99), STORY_TOPICS[STORY_TOPICS.length - 1]);
  assert.equal(resolveStoryTopic('x'.repeat(40)).length, 30);
});

test('弹幕点播口令「剧场xxxx」能取出主题', () => {
  assert.equal(parseStoryCommand('剧场大肥鱼失去尾巴'), '大肥鱼失去尾巴');
  assert.equal(parseStoryCommand('剧场 大肥鱼失去尾巴'), '大肥鱼失去尾巴');
  assert.equal(parseStoryCommand('剧场：大肥鱼失去尾巴'), '大肥鱼失去尾巴');
  assert.equal(parseStoryCommand('剧场: 大肥鱼失去尾巴'), '大肥鱼失去尾巴');
  assert.equal(parseStoryCommand(' 剧场大肥鱼失去尾巴 '), '大肥鱼失去尾巴');
  assert.equal(parseStoryCommand('剧场' + '字'.repeat(20)), '字'.repeat(20));
});

test('普通弹幕不会被误判成剧场点播', () => {
  assert.equal(parseStoryCommand('剧场'), '');
  assert.equal(parseStoryCommand('剧场   '), '');
  assert.equal(parseStoryCommand('小剧场大肥鱼'), '');
  assert.equal(parseStoryCommand('今天去剧场看演出'), '');
  assert.equal(parseStoryCommand('剧场大肥鱼\n失去尾巴'), '');
  assert.equal(parseStoryCommand('剧场' + '字'.repeat(21)), '');
  assert.equal(parseStoryCommand(''), '');
});

test('观众发「结束剧场」能识别为收场口令', () => {
  for (const text of ['结束剧场', '结束剧情', '结束当前剧场', '结束当前剧情', '关闭剧场', '剧场结束', '剧场结束吧', '剧情结束', '结束剧场！', '@鲸鱼娘 结束剧场']) {
    assert.equal(isStoryStopCommand(text), true, text);
  }
});

test('普通聊天不会被误判成收场口令', () => {
  for (const text of ['', '结束', '剧场', '结束啦', '剧场真好玩', '这场结束之后再说', '结束剧场然后开新的', '不要结束剧场']) {
    assert.equal(isStoryStopCommand(text), false, text);
  }
});

test('收场口令优先于剧场点播，避免「剧场结束」被当成新主题', () => {
  assert.equal(isStoryStopCommand('剧场结束'), true);
  assert.equal(parseStoryCommand('剧场结束'), '结束');
});
