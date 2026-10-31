import test from 'node:test';
import assert from 'node:assert/strict';
import { findSensitiveSongWord, isSensitiveSongText } from '../extension/app/core/sensitiveSong.js';

test('敏感点歌：政治、国歌、红歌类关键词命中', () => {
  const blocked = [
    '国歌',
    '义勇军进行曲',
    '东方红',
    '没有共产党就没有新中国',
    '学习雷锋好榜样',
    '歌唱祖国',
    '我爱你中国',
    '我和我的祖国',
    '红旗飘飘',
    '北京的金山上',
    '保卫黄河',
    '国际歌',
    '红歌',
    '天安门',
    '习近平',
    '毛泽东',
    '文化大革命',
    '台独',
    '中华民国',
    'Lost Rivers',
    'lost rivers',
    'Lost River',
    '黑色星期五',
    // 阴间 / 惊悚类 BGM 黑名单
    'The Grotto',
    'the grotto（恐怖版）',
    'Pendulum',
    'Shiver',
    'Lata',
    'Temptation',
    'The Harbinger',
    'The Unseen',
    '楚人美',
    '误入迷失森林',
    '鬼新娘',
    '囍（葛东琪）',
    '嫁衣（幸福大街）',
    '百鬼雾林',
    '索命梵音',
    '血色蔓延',
    '拷問',
    '拘束',
    'The Riddle',
    '天堂岛之歌',
    'Hide and Seek',
    'Gloomy Sunday',
    '安娜的橱窗',
    '万物起舞',
    '木偶戏',
    '怨みの鈴音',
    '第十三双眼睛',
    '忏魂曲',
    '笼中鸟',
    '失魄引',
    'Claustrophobia',
    // 阴间 / 阴谋惊悚类补充
    'Dark Side',
    'Lost Woods',
    "The Devil's Trinity",
    'Aftermath',
    'Hollow',
    'Ethereal Horror',
    'Nocturne in Black',
    'The Silent Land',
    '暗林低语',
    '寂夜诡声',
    // 低俗 / 恶俗 / 土嗨类
    '小鸡小鸡',
    '骚麦',
    '土味喊麦',
    '社会摇恶俗DJ',
    '土嗨舞曲',
    '擦边慢摇',
    '呻吟采样背景音乐',
    // 庄重曲目 / 敏感违规类
    '中国人民解放军军歌',
    '反华配乐',
    '美化军国主义曲目',
    '邪教宣传曲',
    '巫蛊祭祀音乐',
  ];
  for (const text of blocked) {
    assert.equal(isSensitiveSongText(text), true, `${text} 应被拒绝`);
    assert.equal(findSensitiveSongWord(text).length > 0, true, `${text} 应返回命中词`);
  }
});

test('敏感点歌：普通歌曲与带红字的歌名不误伤', () => {
  const allowed = [
    '晴天',
    '红玫瑰',
    '红色高跟鞋',
    '红旗',
    '平凡之路',
    '告白气球',
    '小幸运',
    '我和春天有个约会',
    '中国话',
    '夜曲',
    '星期五',
    '黑色毛衣',
    'Shivers',
    'Temptations',
    'Lataful',
    'Hollows',
    'Aftermaths',
    '海阔天空',
    '稻香',
    '',
  ];
  for (const text of allowed) {
    assert.equal(isSensitiveSongText(text), false, `${text} 不应被拒绝`);
  }
});

test('敏感点歌：带空格、大小写也能识别', () => {
  assert.equal(isSensitiveSongText('义 勇 军 进 行 曲'), true);
  assert.equal(isSensitiveSongText(' 国歌 '), true);
});
