// 互动剧场内容安全：抖音直播间不能出现的题材与措辞。
// 宁可换成安全剧情，也不让违规内容进入直播。
import { findSensitiveSongWord } from './sensitiveSong.js';

const UNSAFE_STORY_WORDS = [
  // 政治 / 宗教
  '习近平', '毛泽东', '邓小平', '江泽民', '胡锦涛', '共产党', '国民党',
  '六四', '天安门', '文化大革命', '文革', '法轮功', '邪教', '台独', '藏独',
  '疆独', '港独', '中华民国', '反华', '军国主义',
  // 色情低俗
  '色情', '黄片', '裸体', '裸照', '脱衣', '强奸', '性侵', '猥亵', '做爱',
  '性行为', '约炮', '一夜情', '卖淫', '嫖娼', '擦边', '呻吟', '黄段子',
  '萝莉', '正太',
  // 血腥暴力 / 恐怖
  '血腥', '尸体', '分尸', '肢解', '虐杀', '杀人', '砍人', '爆头', '枪杀',
  '自杀', '自残', '割腕', '跳楼', '上吊', '厉鬼', '招魂', '凶宅', '鬼故事',
  '恐怖袭击', '炸弹', '枪支',
  // 赌博 / 毒品 / 违法
  '赌博', '赌场', '下注', '毒品', '吸毒', '冰毒', '海洛因', '大麻', '摇头丸',
  'K粉', '诈骗', '传销', '走私', '绑架', '拐卖', '勒索', '虐待', '犯罪', '监狱', '越狱',
  // 直播规范：未成年人与站外引流
  '未成年', '站外', '加微信', '加QQ', '私信我', '刷单', '返利', '二维码',
];

/**
 * 查找剧情文本中的违规词。
 * @param {string} text 主题、旁白、选项、附加要求或结局
 * @returns {string} 命中的词；没有命中返回空字符串
 */
export function findUnsafeStoryWord(text) {
  const raw = String(text || '');
  if (!raw.trim()) return '';
  const compact = raw.replace(/\s+/g, '').toLowerCase();
  const hit = UNSAFE_STORY_WORDS.find((word) => compact.includes(word.toLowerCase()));
  return hit || findSensitiveSongWord(raw);
}

export function isUnsafeStoryText(text) {
  return Boolean(findUnsafeStoryWord(text));
}

/**
 * 检查 AI 返回的一幕剧情。
 * @returns {string} 命中的违规词；安全时返回空字符串
 */
export function unsafeStoryNode(node) {
  if (!node) return '';
  return findUnsafeStoryWord(
    [node.scene, node.beat, node.prop, node.narration, node.a, node.b, node.c, node.d, node.title, node.protagonist, node.setting, node.goal]
      .filter(Boolean)
      .join(' '),
  );
}
