/**
 * 弹幕动作指令：把「跳舞 / 挥挥手 / 动作 转圈」匹配到 dsh-pet 自带的动画名。
 * 动画列表来自 /config 的 animations.clicks / idle / turn / categories[].actions。
 */

const PREFIX = /^[\/／]?(?:动作|做一个|做个|来一个|来个|给我|我要|表演|整一个|来段|能不能|能|可以|会不会|会|你能|您可以|你会|你可以|请|快|帮我|想看|想看你)[\s:：,，]*(.+)$/;
const ACTION_START = /^[\/／]?(?:跳|唱|比|转|挥|招|变|放|撸|摸|伸|照|换|刷|摇|敲|蹲|鞠躬|行|吓|抓|拆|吹|踢|下|荡|堆|装|收|讨|穿|赏|插|动|吃|喝|写|做|来|整|扭|摆|蹦|晃|滚|翻|亲|抱|握|拍|指|戳|跪|趴|打)[\s:：,，]*(.+)$/;
const ADDRESS = /^(?:主播|小助手|助手|桌宠|宝宝|姐姐|哥哥|家人们|大家|鲸鱼娘|大肥鱼|肥鱼|小鱼|鱼|你|您)[\s:：,，]*/;
const TRAILING = /(?:好不好|行不行|可以吗|好吗|行吗|一下吧|一下|一次|看看|谢谢|拜托|吧|呀|啊|哦|嘛|呢|吗|么|哈|哟|啦)+$/;

const DIRECT = new Set([
  '跳舞', '跳个舞', '跳支舞', '跳一段舞', '来段舞', '舞蹈', '女仆舞', '宅舞', '摇摆舞', '舞狮',
  '挥挥手', '挥手', '招手', '打个招呼', '打招呼', '比个心', '比心', '转个圈', '转圈',
  '生气', '害羞', '笑一个', '卖个萌', '伸懒腰', '睡觉', '睡吧', '打哈欠', '哈欠', '小憩',
  '写代码', '敲代码', '写福字', '照镜子', '换装', '刷牙', '摇扇子', '敲桌子', '蹲下',
  '吃白饭', '吃饭', '吃零食', '吃西瓜', '吃火锅', '涮火锅', '火锅', '吃冰淇淋', '冰激凌', '雪糕',
  '吃大闸蟹', '大闸蟹', '吃糖葫芦', '糖葫芦', '吃月饼', '月饼', '吃粽子', '粽子', '吃年糕', '年糕',
  '吃青团', '青团', '吃汤圆', '汤圆', '吃饺子', '饺子', '吃早餐', '吃午餐', '吃晚餐', '吃夜宵', '喝奶茶',
  '变魔术', '魔术', '变鸽子', '扑克魔术', '抽陀螺', '吹笛子', '小提琴', '唱歌', '哼歌',
  '吹气球', '放风筝', '拆礼物', '撸猫', '摸猫', '骑木马', '三球抛接', '抛球', '踢毽子',
  '下五子棋', '下棋', '荡秋千', '放烟花', '堆雪人', '装点圣诞树', '放孔明灯', '放河灯',
  '收红包', '红包', '讨糖', '舞狮', '穿针乞巧', '赏月', '插茱萸', '玩魔方', '玩水枪', '玩游戏',
  '玩玩具车', '吹泡泡', '动物环绕', '凭空生花', '变花', '抓头顶', '蓝鲸', '鲸鱼',
  '吓一跳', '偷吃零食', '摸鱼', '摆烂',
  'token来', 'token回', 'token回去', 'token回来', 'token还我', 'token归还', 'token回收',
  '回token', '还token', '回收token', '拿回token', 'token拿回来', '把token还回来', '把token还我',
  '鞠躬', '行礼', '中秋', '端午', '圣诞', '元宵', '清明', '重阳', '腊八', '七夕', '万圣',
  '春节', '新年', '过年', '生日',
]);

const SYNONYMS = [
  // 吃的（具体在前，泛化的「吃」放最后）
  { keys: ['西瓜', '吃瓜'], terms: ['西瓜'] },
  { keys: ['火锅', '涮锅'], terms: ['火锅'] },
  { keys: ['冰淇淋', '冰激凌', '雪糕'], terms: ['冰淇淋'] },
  { keys: ['大闸蟹', '螃蟹', '蟹'], terms: ['大闸蟹'] },
  { keys: ['糖葫芦'], terms: ['糖葫芦'] },
  { keys: ['月饼', '中秋'], terms: ['月饼'] },
  { keys: ['粽子', '端午'], terms: ['粽子'] },
  { keys: ['年糕'], terms: ['年糕'] },
  { keys: ['青团', '清明'], terms: ['青团'] },
  { keys: ['腊八'], terms: ['腊八粥'] },
  { keys: ['重阳'], terms: ['重阳糕', '茱萸'] },
  { keys: ['汤圆', '元宵'], terms: ['汤圆', '河灯'] },
  { keys: ['饺子', '冬至'], terms: ['饺子'] },
  { keys: ['春节', '新年', '过年'], terms: ['红包', '福字', '饺子'] },
  { keys: ['生日'], terms: ['长寿面'] },
  { keys: ['早餐'], terms: ['早餐'] },
  { keys: ['午餐'], terms: ['午餐'] },
  { keys: ['晚餐', '夜宵'], terms: ['晚餐'] },
  { keys: ['零食', '下午茶'], terms: ['零食'] },
  { keys: ['奶茶', '喝茶'], terms: ['吃'] },
  { keys: ['吃', '饿', '饭'], terms: ['吃'] },
  // 玩 / 表演
  { keys: ['魔术', '魔法'], terms: ['魔术'] },
  { keys: ['鸽子'], terms: ['鸽子'] },
  { keys: ['扑克', '纸牌'], terms: ['扑克'] },
  { keys: ['陀螺'], terms: ['陀螺'] },
  { keys: ['笛子', '吹笛'], terms: ['笛子'] },
  { keys: ['小提琴'], terms: ['小提琴'] },
  { keys: ['唱歌', '哼歌'], terms: ['哼歌'] },
  { keys: ['气球'], terms: ['气球'] },
  { keys: ['风筝'], terms: ['风筝'] },
  { keys: ['礼物'], terms: ['礼物'] },
  { keys: ['撸猫', '猫'], terms: ['撸猫'] },
  { keys: ['木马'], terms: ['木马'] },
  { keys: ['抛球', '三球'], terms: ['抛接'] },
  { keys: ['毽子'], terms: ['毽子'] },
  { keys: ['五子棋', '下棋'], terms: ['五子棋'] },
  { keys: ['秋千'], terms: ['秋千'] },
  { keys: ['烟花'], terms: ['烟花'] },
  { keys: ['雪人'], terms: ['雪人'] },
  { keys: ['圣诞'], terms: ['圣诞树'] },
  { keys: ['孔明灯'], terms: ['孔明灯'] },
  { keys: ['河灯'], terms: ['河灯'] },
  { keys: ['红包'], terms: ['红包'] },
  { keys: ['福字'], terms: ['福字'] },
  { keys: ['舞狮'], terms: ['舞狮'] },
  { keys: ['南瓜', '万圣'], terms: ['南瓜'] },
  { keys: ['茱萸'], terms: ['茱萸'] },
  { keys: ['穿针', '乞巧', '七夕'], terms: ['穿针'] },
  { keys: ['魔方'], terms: ['魔方'] },
  { keys: ['玩具车', '汽车'], terms: ['玩具汽车'] },
  { keys: ['水枪'], terms: ['水枪'] },
  { keys: ['游戏'], terms: ['游戏'] },
  { keys: ['泡泡'], terms: ['泡泡'] },
  { keys: ['动物'], terms: ['动物'] },
  { keys: ['蜜蜂', '蝴蝶'], terms: ['蜜蜂'] },
  { keys: ['抓', '头顶'], terms: ['跳跃'] },
  { keys: ['蓝鲸', '鲸鱼'], terms: ['鲸鱼'] },
  { keys: ['镜子'], terms: ['镜子'] },
  { keys: ['换装', 'cos'], terms: ['换装'] },
  { keys: ['刷牙'], terms: ['刷牙'] },
  { keys: ['摇扇', '扇子'], terms: ['扇'] },
  { keys: ['敲桌', '敲击'], terms: ['敲击'] },
  { keys: ['蹲下', '下蹲'], terms: ['下蹲'] },
  { keys: ['吓一跳'], terms: ['吓一跳'] },
  { keys: ['打瞌睡', '瞌睡'], terms: ['打瞌睡'] },
  { keys: ['偷吃'], terms: ['偷吃'] },
  { keys: ['摸鱼', '摆烂', '累了'], terms: ['小憩'] },
  // 常规动作
  { keys: ['挥手', '招手', '打招呼', '你好', '嗨'], terms: ['挥手'] },
  { keys: ['跳舞', '舞蹈', '舞'], terms: ['舞'] },
  { keys: ['比心', '爱心'], terms: ['比心', '爱心', '生花'] },
  { keys: ['生气', '气死', '哼'], terms: ['生气'] },
  { keys: ['害羞', '脸红', '羞'], terms: ['害羞'] },
  { keys: ['笑', '开心', '高兴'], terms: ['笑', '开心'] },
  { keys: ['哭', '难过', '委屈'], terms: ['哭', '委屈'] },
  { keys: ['转圈', '旋转', '转个圈'], terms: ['旋转'] },
  { keys: ['睡觉', '睡', '困', '休息', '躺'], terms: ['小憩', '待机', '哈欠'] },
  { keys: ['伸懒腰', '懒腰'], terms: ['伸懒腰'] },
  { keys: ['写代码', '敲代码', '代码'], terms: ['写代码'] },
  { keys: ['女仆', '礼仪', '鞠躬', '行礼'], terms: ['女仆'] },
  { keys: ['加油', '棒'], terms: ['开心', '跃动'] },
  { keys: ['跳舞', '舞蹈', '舞', '跳个舞', '跳支舞', '跳一下', '跳一段', '蹦迪', '科目三'], terms: ['舞', '跳舞'] },
  { keys: ['挥手', '招手', '挥个手', '挥一下', '打个招呼', '打招呼', '你好', '嗨', '拜拜', '再见'], terms: ['挥手'] },
  { keys: ['比心', '比个心', '爱心', '笔芯'], terms: ['比心', '爱心', '生花'] },
  { keys: ['转圈', '转个圈', '转一圈', '转一下', '旋转'], terms: ['旋转', '转圈'] },
  { keys: ['唱歌', '唱首歌', '唱一个', '来首歌', '哼歌', '唱', '歌'], terms: ['哼歌', '唱'] },
  { keys: ['跳一下', '跳一段', '科目三'], terms: ['舞', '跳舞'] },
  { keys: ['跳一个', '跳一个舞', '跳一支舞', '跳个'], terms: ['舞', '跳舞'] },
  { keys: ['扭一下', '扭一扭', '扭', '扭一个'], terms: ['舞', '旋转', '摇摆'] },
  { keys: ['转一下', '转一圈', '转个圈', '转一个圈'], terms: ['旋转', '转圈'] },
  { keys: ['挥一下', '挥个手', '挥一挥手'], terms: ['挥手'] },
  { keys: ['比一个心', '比一下心'], terms: ['比心'] },
  { keys: ['唱一首', '唱一首歌'], terms: ['哼歌', '唱'] },
  { keys: ['圈'], terms: ['旋转'] },
  { keys: ['手'], terms: ['挥手'] },
  { keys: ['心'], terms: ['比心', '爱心'] },
  { keys: ['打个招呼', '打一个招呼', '招呼'], terms: ['挥手'] },
  { keys: ['睡', '睡觉', '睡个觉', '困', '休息', '躺', '眯', '打盹', '晚安'], terms: ['小憩', '待机', '哈欠'] },
  { keys: ['魔术', '魔法', '变魔术', '变个魔术', '变戏法'], terms: ['魔术'] },
  { keys: ['代码', '写代码', '写个代码', '编程', '写程序'], terms: ['写代码'] },
  { keys: ['鞠躬', '行个礼', '行礼', '女仆', '礼仪'], terms: ['女仆', '鞠躬'] },
  { keys: ['卖萌', '撒娇', '萌'], terms: ['害羞', '笑', '开心'] },
  { keys: ['动一下', '动动', '活跃一下'], terms: ['跃动', '舞', '开心'] },
  { keys: ['token来', '来token', '收token', '收币', '金币', '硬币', '托肯', '币来', 'token回', '回token', 'token回来', 'token回去', 'token还我', 'token归还', 'token回收', '还token', '回收token', '拿回token', 'token拿回来'], terms: ['token来'] },
];

/**
 * 组合动作：把桌宠已有的动画按顺序串成一套小连招，不用新增素材。
 * steps 直接写动画原名，运行时用 resolvePetAction 解析，缺哪个就跳过哪个。
 */
export const PET_COMBOS = [
  {
    id: 'thanks',
    label: '谢礼三连',
    keys: ['谢礼三连', '感谢三连', '谢谢三连', '谢礼物', '感谢礼物'],
    speech: '{name}的礼物收到啦！鲸鱼娘给你行礼、献花，再放个烟花庆祝一下～',
    stepMs: 5000,
    steps: ['女仆屈膝礼仪', '凭空生花', '放烟花'],
  },
  {
    id: 'whale',
    label: '梦幻鲸鱼',
    keys: ['梦幻鲸鱼', '鲸鱼秀', '鲸鱼三连', '大鲸鱼出场', '看鲸鱼'],
    speech: '{name}想看鲸鱼？蓝鲸现世，泡泡满天飞，头顶还开花了～',
    stepMs: 5500,
    steps: ['蓝鲸现世', '鲸鱼吐泡泡特效', '蝴蝶蜜蜂环绕头顶开花'],
  },
  {
    id: 'rage',
    label: '暴走三连',
    keys: ['暴走三连', '气急败坏', '暴走', '炸毛三连', '急眼了'],
    speech: '{name}让我暴走？先敲桌子，再气急败坏，最后开心跃动收场！',
    stepMs: 4500,
    steps: ['原地敲击桌面互动', '玩游戏气急败坏', '点击回应-开心跃动'],
  },
  {
    id: 'cute',
    label: '撒娇三连',
    keys: ['撒娇三连', '卖萌三连', '害羞三连', '撒娇', '卖个萌'],
    speech: '{name}要看撒娇？那我害羞一下、咯咯笑，再送你一朵花～',
    stepMs: 4500,
    steps: ['点击回应-害羞惊讶', '点击回应-挠痒咯咯笑', '凭空生花'],
  },
  {
    id: 'work',
    label: '打工三连',
    keys: ['打工三连', '营业三连', '搬砖三连', '上工三连', '打工'],
    speech: '{name}要看打工？写代码、打哈欠、再来一碗白饭，这就是打工人！',
    stepMs: 5000,
    steps: ['写代码', '哈欠连天', '吃白饭'],
  },
  {
    id: 'newyear',
    label: '拜年三连',
    keys: ['拜年三连', '拜年', '舞狮拜年', '过年三连'],
    speech: '{name}新年好呀！收红包、写福字、舞狮头，鲸鱼娘祝你新年顺遂～',
    stepMs: 5000,
    steps: ['收红包', '写福字', '舞狮头'],
  },
];

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[（）()\[\]【】\s,，。.!！?？~～]/g, '');
}

function cleanKeyword(value) {
  let text = String(value || '').trim();
  text = text.replace(ADDRESS, '').replace(/^[个只首段支张]/, '');
  text = text.replace(TRAILING, '');
  return text.replace(/^[\s:：,，]+/, '').trim();
}

export function parsePetActionCommand(content) {
  const text = String(content || '').trim();
  if (!text || Array.from(text).length > 40) return '';
  const withoutAddress = text.replace(ADDRESS, '').trim();
  if (/^(?:做|干|在|说)?(?:什么|啥)/.test(withoutAddress)) return '';
  if (/^(?:吃|喝|玩|看|听|说|买|卖|做|干|在|要|想)(?:什么|啥)/.test(withoutAddress)) return '';
  // 「吃个屁 / 吃你个头 / 别吃了」这类吐槽或拒绝，不能当成点动作
  if (/(?:个屁|个鬼|个毛|你个头|吃屁|屁吃|别吃|不想吃|吃不下|吃什么吃|吃啥吃)/.test(withoutAddress)) return '';
  if (/(?:了|过)(?:吗|么|没|没有)?$/.test(withoutAddress)) return '';
  const prefixed = withoutAddress.match(PREFIX);
  if (prefixed && prefixed[1]) {
    const keyword = cleanKeyword(prefixed[1]) || cleanKeyword(withoutAddress);
    // 「我要听 XX」是点歌，不是桌宠动作口令
    if (/^听/.test(keyword)) return '';
    return keyword;
  }
  const action = withoutAddress.match(ACTION_START);
  if (action && action[1]) {
    return cleanKeyword(withoutAddress) || cleanKeyword(action[1]);
  }
  const direct = cleanKeyword(withoutAddress);
  if (matchPetCombo(direct)) return direct;
  if (DIRECT.has(direct)) return direct;
  return '';
}

export function petActionPool(animations) {
  if (!animations || typeof animations !== 'object') return [];
  const names = [];
  for (const key of ['clicks', 'idle', 'turn']) {
    if (Array.isArray(animations[key])) names.push(...animations[key]);
  }
  for (const category of animations.categories || []) {
    if (Array.isArray(category.actions)) names.push(...category.actions);
  }
  return [...new Set(names.filter((name) => typeof name === 'string' && name.trim()))];
}

export function resolvePetAction(keyword, animations) {
  const pool = petActionPool(animations);
  if (!pool.length) return null;
  const query = normalize(cleanKeyword(keyword));
  if (!query) return null;

  const exact = pool.find((name) => normalize(name) === query);
  if (exact) return exact;
  const contains = pool.find((name) => {
    const normalizedName = normalize(name);
    return normalizedName.includes(query) || query.includes(normalizedName);
  });
  if (contains) return contains;

  for (const group of SYNONYMS) {
    if (!group.keys.some((key) => query.includes(normalize(key)))) continue;
    for (const term of group.terms) {
      const hit = pool.find((name) => normalize(name).includes(normalize(term)));
      if (hit) return hit;
    }
  }

  const tokens = query.match(/[\u4e00-\u9fa5A-Za-z0-9]{2,}/g) || [];
  for (const token of tokens) {
    const hit = pool.find((name) => normalize(name).includes(token));
    if (hit) return hit;
  }
  return null;
}

export function petComboSpeech(combo, nickname = '') {
  const who = String(nickname || '').trim() || '大家';
  const template = String((combo && combo.speech) || '');
  const text = template.replace(/\{name\}/g, who);
  return text || `${who}，给你表演个组合动作「${(combo && combo.label) || '连招'}」～`;
}

export function matchPetCombo(keyword) {
  const query = normalize(cleanKeyword(keyword));
  if (!query) return null;
  return PET_COMBOS.find((combo) => (combo.keys || []).some((key) => normalize(key) === query)) || null;
}

export function resolvePetComboSteps(combo, animations) {
  const steps = (combo && Array.isArray(combo.steps)) ? combo.steps : [];
  return [...new Set(steps.map((step) => resolvePetAction(step, animations)).filter(Boolean))];
}

export const TOKEN_BACK_REPLY = 'token来，token来';

/** 「token回 / 回token / token还回来」这类关键词统一执行 token来 动作并回固定台词。 */
export function isTokenBackKeyword(keyword) {
  const text = String(keyword || '');
  return /token/i.test(text) && /(回|还|归|拿)/.test(text);
}

export function petActionSpeech(keyword, animationName, nickname = '') {
  if (isTokenBackKeyword(keyword)) return TOKEN_BACK_REPLY;
  const name = String(animationName || '');
  const who = String(nickname || '').trim();
  const prefix = who ? `好呀，${who}，` : '好呀，';
  const line =
    name.includes('舞') ? '给你跳个舞～' :
    name.includes('挥手') ? '挥挥手，跟你打个招呼～' :
    name.includes('害羞') ? '哎呀，有点害羞～' :
    name.includes('生气') ? '哼，不跟你好了～' :
    name.includes('笑') ? '咯咯，笑一个～' :
    name.includes('旋转') ? '转个圈给你看～' :
    /小憩|待机|哈欠/.test(name) ? '那我眯一会儿～' :
    name.includes('伸懒腰') ? '伸个懒腰，好舒服～' :
    name.includes('吃') ? '那我开动啦～' :
    name.includes('token') ? 'token来啦！快到我嘴里来～' :
    name.includes('写代码') ? '这就写两行代码～' :
    name.includes('女仆') ? '女仆礼仪，请多关照～' :
    name.includes('魔术') ? '给你变个魔术～' :
    name.includes('烟花') ? '给你放个烟花～' :
    /生花|比心/.test(name) ? '给你比个心～' :
    `这就给你表演「${String(keyword || '这个动作')}」～`;
  return `${prefix}${line}`;
}

export function petIdleSpeech(animationName, random = Math.random) {
  const label = String(animationName || '')
    .replace(/^点击回应-/, '')
    .trim();
  if (!label) return '';
  const lines = [
    `给大家表演个${label}～`,
    `看好了，给大家表演个${label}！`,
    `来，给大家表演个${label}～`,
  ];
  return lines[Math.min(lines.length - 1, Math.floor(random() * lines.length))];
}
