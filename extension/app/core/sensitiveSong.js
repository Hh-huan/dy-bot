// 点歌内容审核：政治、国歌、红歌等容易被封直播间的关键词，命中直接拒绝
const SENSITIVE_SONG_WORDS = [
  // 国歌 / 红歌 / 主旋律
  '国歌',
  '义勇军进行曲',
  '国际歌',
  '东方红',
  '红太阳',
  '大海航行靠舵手',
  '没有共产党就没有新中国',
  '社会主义好',
  '歌唱祖国',
  '我和我的祖国',
  '我爱你中国',
  '红旗飘飘',
  '我的祖国',
  '英雄赞歌',
  '血染的风采',
  '春天的故事',
  '走进新时代',
  '在希望的田野上',
  '学习雷锋好榜样',
  '我爱北京天安门',
  '北京的金山上',
  '南泥湾',
  '保卫黄河',
  '黄河大合唱',
  '团结就是力量',
  '五星红旗',
  '红歌',
  // 政治敏感
  '毛泽东',
  '习近平',
  '邓小平',
  '江泽民',
  '胡锦涛',
  '共产党',
  '国民党',
  '天安门',
  '文化大革命',
  '文革',
  '六四',
  '法轮功',
  '台独',
  '藏独',
  '疆独',
  '港独',
  '中华民国',
  // 恐怖 / 猎奇类（易引起不适或违规）
  'lostriver', // Lost Rivers（嘶吼实验噪音曲）
  'lost river', // Lost River（同上，带空格写法）
  'lost rivers', // Lost Rivers（同上，复数写法）
  '黑色星期五',
  // 阴间 / 压抑 / 惊悚类 BGM（来源：夜间听歌避雷清单，含 Audiomachine 压抑款、中式恐怖、日系惊悚、网红阴间 BGM）
  'The Grotto',
  'Pendulum',
  'Shiver',
  'Lata',
  'Temptation',
  'The Harbinger',
  'The Unseen',
  '楚人美',
  '误入迷失森林',
  '鬼新娘',
  '囍',
  '嫁衣',
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
  // 低俗 / 恶俗 / 土嗨类（关键词命中即拒，含改版与采样）
  '小鸡小鸡',
  '骚麦',
  '喊麦',
  '社会摇',
  '土嗨',
  '擦边',
  '呻吟',
  // 庄重曲目 / 敏感违规类
  '中国人民解放军军歌',
  '解放军军歌',
  '反华',
  '军国主义',
  '邪教',
  '巫蛊',
];

/**
 * 查找命中的敏感词。
 * @param {string} text 歌名、歌手或搜索词
 * @returns {string} 命中的词，没有命中返回空字符串
 */
export function findSensitiveSongWord(text) {
  const raw = String(text || '');
  if (!raw.trim()) return '';
  const compact = raw.replace(/\s+/g, '').toLowerCase();
  return (
    SENSITIVE_SONG_WORDS.find((word) => {
      // 英文歌名按整词匹配，避免 Shiver 误伤 Shivers 这类正常歌曲
      if (/^[\x20-\x7e]+$/.test(word)) {
        const pattern = word
          .toLowerCase()
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          .replace(/\s+/g, '\\s+');
        return new RegExp(`\\b${pattern}\\b`, 'i').test(raw);
      }
      // 中文 / 日文歌名忽略空格和大小写直接包含匹配
      return compact.includes(word.replace(/\s+/g, '').toLowerCase());
    }) || ''
  );
}

/** @param {string} text */
export function isSensitiveSongText(text) {
  return Boolean(findSensitiveSongWord(text));
}

export const SENSITIVE_SONG_MESSAGE = '这首歌涉及敏感内容，直播间不能点播，换一首吧';
