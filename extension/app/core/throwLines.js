/** 甩飞口播文案库：多种风格随机轮换，保证每句都带上被甩观众的名字。 */

const TEMPLATES = [
  (name) => `鲸鱼娘抓起${name}，一把甩飞出去！`,
  (name) => `高高抛起${name}，直接送上天！`,
  (name) => `鲸鱼娘丢起${name}，嗖地一下飞远了！`,
  (name) => `把${name}丢了出去，走你——！`,
  (name) => `抛起${name}，空中转体三周半！`,
  (name) => `${name}被高高抛起，落点未知！`,
  (name) => `鲸鱼娘顺手把${name}甩了出去！`,
  (name) => `丢起${name}，一路飞到天花板！`,
];

export const THROW_LINE_COUNT = TEMPLATES.length;

/** 随机挑一句甩飞口播；random 可注入，便于测试。 */
export function pickThrowLine(name, random = Math.random) {
  const who = String(name || '').trim() || '该观众';
  const roll = Number(random());
  const safeRoll = Number.isFinite(roll) ? Math.min(0.999999, Math.max(0, roll)) : 0;
  const index = Math.floor(safeRoll * TEMPLATES.length);
  return TEMPLATES[index](who);
}
