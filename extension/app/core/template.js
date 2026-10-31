/** 回复模板渲染：{{A|B}} 随机取一个，{nickname} 等占位符替换。 */

export function renderTemplate(template, context = {}, random = Math.random) {
  let text = String(template ?? '');

  text = text.replace(/\{\{([^{}]*)\}\}/g, (_, group) => {
    const options = group
      .split('|')
      .map((item) => item.trim())
      .filter(Boolean);
    if (!options.length) return '';
    const index = Math.min(options.length - 1, Math.floor(random() * options.length));
    return options[index];
  });

  text = text.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (match, key) => {
    const value = context[key];
    if (value === undefined || value === null || value === '') return match;
    return String(value);
  });

  return text.replace(/[ \t]+/g, ' ').trim();
}

/** 列出模板里用到的变量名，便于 UI 提示。 */
export function extractVariables(template) {
  const keys = new Set();
  String(template ?? '').replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_, key) => {
    keys.add(key);
    return '';
  });
  return [...keys];
}

export const TEMPLATE_VARIABLES = [
  { key: 'nickname', desc: '观众昵称' },
  { key: 'content', desc: '观众原话' },
  { key: 'gift', desc: '礼物名称' },
  { key: 'count', desc: '礼物/点赞数量' },
  { key: 'level', desc: '用户等级' },
  { key: 'fansClub', desc: '粉丝团名称' },
  { key: 'online', desc: '在线人数' },
  { key: 'cumulative', desc: '累计观看' },
  { key: 'time', desc: '当前时间' },
];
