/**
 * 抖音直播弹幕协议解码。
 *
 * 数据来源：直播间页面自身的 WebSocket（webcast/im/push/v2），
 * 外层是 PushFrame，payload 通常是 gzip 后的 Response，Response 里是若干 Message。
 *
 * 字段编号来自公开的 webcast 协议（与主流开源弹幕工具一致），
 * 这里只声明我们需要的字段；抖音新增字段会被自动跳过。
 */
import { decodeMessage, toBytes, isGzip, gunzip } from './protobuf.js';

const str = (name, repeated = false) => ({ name, type: 'string', repeated });
const bytes = (name) => ({ name, type: 'bytes' });
const u64 = (name) => ({ name, type: 'uint64' });
const u32 = (name) => ({ name, type: 'uint32' });
const i64 = (name) => ({ name, type: 'int64' });
const bool = (name) => ({ name, type: 'bool' });
const msg = (name, schema, repeated = false) => ({ name, type: 'message', schema, repeated });

const Image = {
  1: str('urlList', true),
  2: str('uri'),
};

const Text = {
  1: str('key'),
  2: str('defaultPattern'),
};

const PayGrade = {
  1: u64('totalDiamondCount'),
  3: str('name'),
  4: msg('icon', Image),
  6: u64('level'),
};

const FansClubData = {
  1: str('clubName'),
  2: u32('level'),
  3: u32('userFansClubStatus'),
};

const FansClub = {
  1: msg('data', FansClubData),
};

// 用户与主播的关注关系：followStatus > 0 表示已关注
const FollowInfo = {
  1: u64('followingCount'),
  2: u64('followerCount'),
  3: u64('followStatus'),
  4: u64('pushStatus'),
};

const User = {
  1: u64('id'),
  2: u64('shortId'),
  3: str('nickname'),
  4: u32('gender'),
  5: str('signature'),
  6: u64('level'),
  7: u64('birthday'),
  8: str('telephone'),
  9: msg('avatarThumb', Image),
  10: msg('avatarMedium', Image),
  11: msg('avatarLarge', Image),
  12: bool('verified'),
  13: u64('experience'),
  14: str('city'),
  22: msg('followInfo', FollowInfo),
  23: msg('payGrade', PayGrade),
  24: msg('fansClub', FansClub),
};

const Common = {
  1: str('method'),
  2: u64('msgId'),
  3: u64('roomId'),
  4: u64('createTime'),
  5: u32('monitor'),
  6: bool('isShowMsg'),
  7: str('describe'),
  9: u64('foldType'),
  10: u64('anchorFoldType'),
  11: u64('priorityScore'),
  12: str('logId'),
  13: str('msgProcessFilterK'),
  14: str('msgProcessFilterV'),
  15: str('fromId'),
};

const PublicAreaCommon = {
  1: msg('userLabel', Image),
  2: u64('userConsumeInRoom'),
};

const ChatMessage = {
  1: msg('common', Common),
  2: msg('user', User),
  3: str('content'),
  4: bool('visibleToSender'),
  6: str('fullScreenTextColor'),
  9: msg('publicAreaCommon', PublicAreaCommon),
  11: u64('agreeMsgId'),
  12: u32('priorityLevel'),
  15: u64('eventTime'),
  16: bool('sendReview'),
};

const EmojiChatMessage = {
  1: msg('common', Common),
  2: msg('user', User),
  3: u64('emojiId'),
  4: msg('emojiContent', Text),
  5: str('defaultContent'),
  6: msg('backgroundImage', Image),
};

const GiftStruct = {
  1: msg('image', Image),
  2: str('describe'),
  3: bool('notify'),
  4: u64('duration'),
  5: u64('id'),
  12: u64('diamondCount'),
  16: str('name'),
};

const GiftMessage = {
  1: msg('common', Common),
  2: u64('giftId'),
  3: u64('fanTicketCount'),
  4: u64('groupId'),
  5: u64('repeatCount'),
  6: u64('comboCount'),
  7: msg('user', User),
  8: msg('toUser', User),
  9: u32('repeatEnd'),
  10: u32('textEffect'),
  11: u64('groupCount'),
  12: msg('gift', GiftStruct),
  13: str('logId'),
};

const MemberMessage = {
  1: msg('common', Common),
  2: msg('user', User),
  3: u64('memberCount'),
  4: msg('operator', User),
  5: bool('isSetToAdmin'),
  6: bool('isTopUser'),
  7: u64('rankScore'),
  8: u64('topUserNo'),
  9: u64('enterType'),
  10: u64('actionType'),
  11: str('actionDescription'),
  12: u64('userId'),
  14: str('popStr'),
};

const LikeMessage = {
  1: msg('common', Common),
  2: u64('count'),
  3: u64('total'),
  4: u64('color'),
  5: msg('user', User),
};

const SocialMessage = {
  1: msg('common', Common),
  2: msg('user', User),
  3: u64('shareType'),
  4: u64('action'),
  5: u64('shareTarget'),
  6: u64('followCount'),
};

const RoomUserSeqContributor = {
  1: u64('score'),
  2: msg('user', User),
  3: u64('rank'),
  4: u64('delta'),
  5: bool('isHidden'),
  6: str('scoreDescription'),
};

const RoomUserSeqMessage = {
  1: msg('common', Common),
  2: msg('ranks', RoomUserSeqContributor, true),
  3: i64('total'),
  4: str('popStr'),
  6: i64('popularity'),
  7: i64('totalUser'),
};

const RoomStatsMessage = {
  1: msg('common', Common),
  2: str('displayShort'),
  3: str('displayMiddle'),
  4: str('displayLong'),
  5: u64('displayValue'),
  6: u64('displayVersion'),
  7: bool('incremental'),
  8: bool('isHidden'),
  9: u64('total'),
  10: u64('displayType'),
};

const ControlMessage = {
  1: msg('common', Common),
  2: u32('status'),
};

const Headers = {
  1: str('key'),
  2: str('value'),
};

const PushFrame = {
  1: u64('seqId'),
  2: u64('logId'),
  3: u64('service'),
  4: str('method'),
  5: msg('headers', Headers, true),
  6: str('payloadEncoding'),
  7: str('payloadType'),
  8: bytes('payload'),
};

const Message = {
  1: str('method'),
  2: bytes('payload'),
  3: u64('msgId'),
  4: u32('msgType'),
  5: u64('offset'),
  6: bool('needWrds'),
};

const Response = {
  1: msg('messages', Message, true),
  2: str('cursor'),
  3: u64('fetchInterval'),
  4: u64('now'),
  5: str('internalExt'),
  6: u64('fetchType'),
  8: u64('heartbeatDuration'),
  9: bool('needAck'),
  10: str('pushServer'),
  11: str('liveCursor'),
  12: bool('historyNoMore'),
};

const toNum = (value, fallback = 0) => {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'bigint') {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const toId = (value) => (value === null || value === undefined ? '' : String(value));
const firstText = (...values) => values.find((v) => v !== undefined && v !== null && v !== '') ?? '';
const imageUrl = (image) => (image && Array.isArray(image.urlList) ? image.urlList.find(Boolean) || '' : '');

// 部分礼物消息不带 name/describe，只给数字 ID；补常见礼物名，避免显示成「礼物 ×1」
const GIFT_NAME_BY_ID = {
  164: "抖音",
  165: "棒棒糖",
  168: "撩一下",
  436: "Thuglife",
  444: "做我的猫",
  458: "宇宙之心",
  463: "小心心",
  511: "抖音1号",
  575: "为你打Call",
  679: "一直陪伴你",
  685: "粉丝团灯牌",
  739: "樱花雨",
  775: "流星雨",
  781: "比心",
  782: "钞票枪",
  789: "嘉年华",
  805: "直升机",
  812: "如意锦囊",
  855: "人气票",
  860: "为你点亮",
  861: "糖果大炮",
  865: "人气券",
  867: "爱的发射",
  875: "动次打次",
  880: "Disco",
  887: "1314个小心心",
  915: "520个小心心",
  918: "66个小心心",
  2001: "玫瑰",
  2002: "大啤酒",
  2006: "鲜花",
  2110: "小皇冠",
  2114: "礼花筒",
  2193: "爱的守护",
  2479: "玫瑰999",
  2481: "99啤酒",
  2484: "玫瑰520",
  3084: "闪耀VIP",
  3085: "黄金徽章",
  3113: "娶你回家",
  3117: "太南了",
  3118: "太南了66个特效",
  3200: "爱的纸鹤",
  3207: "爱的转圈圈",
  3234: "甜蜜送达",
  3236: "炸鸡桶",
  3242: "入团卡",
  3246: "粉丝团灯牌",
  3249: "糖果飞船",
  16081: "天鹅羽翼",
  3262: "人气卡",
  3274: "世界公告卡",
  3364: "神级操作",
  3381: "热门助力卡",
  3382: "浪漫花火",
  3394: "绚烂花海",
  3401: "星梦城堡",
  3447: "亲吻",
  3474: "生日蛋糕",
  3475: "周年蛋糕",
  3476: "你最瞩目",
  3477: "派对之星",
  3478: "生日派对",
  3479: "周年派对",
  3481: "你最好看",
  3483: "真的爱你",
  3525: "为歌而赞",
  3544: "游艇派对",
  3557: "欢呼号角",
  3558: "一起摇摆",
  3559: "惊喜时刻",
  3568: "粉丝团灯牌",
  3591: "为你打气",
  3594: "点赞",
  3597: "加油鸭",
  3620: "送你花花",
  3621: "爱你哟",
  3622: "好运星",
  3623: "幸运星",
  3638: "保时捷",
  3649: "热歌战队",
  3653: "太空探探",
  3656: "应援手环",
  3657: "爱的点亮",
  3658: "呱唧呱唧",
  3659: "新歌战队",
  3661: "浪漫花火",
  3662: "撒花",
  3676: "幸福小岛",
  3680: "落日花火",
  3681: "告白花火",
  3682: "梦幻花火",
  3683: "春意花火",
  3729: "私人飞机",
  3756: "求带走",
  3773: "热气球",
  3774: "热门助力卡",
  3775: "浪漫马车",
  3776: "梦幻城堡",
  3778: "喵喵舞台",
  3780: "比心兔兔",
  3789: "梦幻花",
  3792: "海底寻梦",
  3812: "游戏机",
  3817: "人气TOP3",
  3820: "浪漫列车",
  3834: "人气TOP2",
  3835: "人气TOP1",
  3836: "掌上明珠",
  3838: "番茄",
  3845: "播一个",
  3860: "深海明珠",
  3861: "挚爱明珠",
  3862: "旭日明珠",
  3863: "酷盖Thuglife",
  3864: "爱心Thuglife",
  3865: "暖阳Thuglife",
  3870: "碧空飞机",
  3871: "告白飞机",
  3872: "神秘飞机",
  3876: "爱心礼花筒",
  3877: "欢乐礼花筒",
  3878: "奇幻礼花筒",
  3893: "娶你回家",
  3897: "爱的守护",
  3908: "璀璨花海",
  3910: "快开播",
  3917: "复古老爷车",
  3920: "奇幻八音盒",
  3992: "人气票",
  4036: "摩天大厦",
  4041: "心动连线 ",
  4042: "甜蜜记忆",
  4043: "心心相依  ",
  4045: "心动聚焦 ",
  4046: "爱的声音 ",
  4049: "梦幻花海 ",
  4053: "袋鼠摇摇",
  4079: "单车恋人",
  4162: "欢呼号角",
  4163: "一起摇摆",
  4164: "惊喜时刻",
  4177: "天空之诚",
  4203: "浪漫泡泡",
  4204: "童趣秋千",
  4205: "霓虹派对",
  4206: "金秋郊游",
  4207: "闪耀城堡",
  4208: "秘境巡游",
  4215: "真爱誓约",
  4217: "心动丘比特",
  4224: "评论狂欢卡",
  4246: "薰衣草庄园",
  4247: "月下瀑布",
  4316: "舞鞋",
  4317: "动听",
  4318: "深情对唱",
  4319: "一起跳舞",
  4320: "当代歌王",
  4321: "当代舞王",
  4334: "荧幕守候",
  4335: "星海穿越",
  4336: "花海亭风",
  4339: "天鹅之梦",
  4350: "天下无双",
  4353: "保时捷",
  4354: "纸短情长",
  4396: "浪漫之城",
  4442: "叫好",
  4451: "说的对",
  4452: "百赞主打歌",
  4457: "为爱启航",
  4480: "花开烂漫",
  4484: "叫好",
  4489: "奏响人生",
  4500: "爱你鸭",
  4502: "心随你动",
  4512: "许愿星",
  4513: "寻梦风铃",
  4514: "许愿瓶",
  4515: "星愿项链",
  4520: "戏票",
  4521: "锵锵锵",
  4527: "锵锵锵",
  4528: "戏票",
  4532: "星光瓶",
  4533: "小纸条",
  4557: "头号神枪手",
  4568: "桃运滚滚",
  4570: "花落长亭",
  4571: "璧上飞仙",
  4572: "情定三生",
  4587: "奇幻小屋",
  4588: "灿烂之城",
  4634: "海上生明月",
  4637: "月伴星辰",
  4639: "日出相伴",
  4640: "浪漫营地",
  4641: "星星点灯",
  4642: "心随你动",
  4644: "万象烟花",
  4657: "平底锅",
  4658: "请吃鸡",
  4659: "苟住",
  4661: "动感光波",
  4678: "环球旅行车",
  4679: "环球旅行车",
  4680: "环球旅行车",
  4681: "环球旅行车",
  4682: "环球旅行车",
  4683: "环球旅行车",
  4684: "环球旅行车",
  4685: "环球旅行车",
  4704: "环球旅行车",
  4714: "梦回西海岸",
  4715: "颠倒城市",
  4718: "海洋之心",
  4722: "掌上萌猪",
  4723: "浪漫恋人",
  4724: "复古飞机",
  4725: "云霄大厦",
  5006: "吉他",
  5007: "黑胶唱片",
  5014: "游戏手柄",
  5023: "爱心发射",
  5027: "飞花传情",
  5028: "浪漫空投",
  5042: "动感光波",
  5084: "心动了",
  5085: "邂逅流星雨",
  5093: "吹泡泡",
  5100: "人间精灵",
  5133: "唱歌烟花",
  5134: "跳舞烟花",
  5135: "乐器烟花",
  5136: "小小鲁班",
  5137: "追更",
  5138: "+1",
  5139: "爱",
  5142: "城市麦霸",
  5163: "璀璨舞台",
  5174: "星际抖音1号",
  5176: "神级操作",
  5177: "悬浮高跟鞋",
  5183: "星之王座",
  5195: "嗨聊花花",
  5210: "嗨聊花花",
  5212: "心随你动",
  5213: "粒子花",
  5222: "人间精灵",
  5223: "足球",
  5224: "丘比特之箭",
  5225: "传送门",
  5234: "笑折叠了",
  5235: "一路长虹",
  5247: "1.5倍加成卡",
  5248: "原唱认证卡",
  5255: "海底世界",
  5256: "魔法星愿",
  5258: "花间蜜语",
  5296: "我们赢了",
  5298: "好球",
  5299: "冲呀",
  5300: "666",
  5301: "防守大师",
  5302: "Goal！",
  5303: "胜利金靴",
  5304: "精彩绝杀",
  5331: "戏楼",
  5338: "容我sa娇",
  5348: "为我歌唱",
  5355: "开球",
  5356: "仙女棒",
  5357: "甜甜圈",
  5358: "恶魔炸弹",
  5359: "能力药丸",
  5360: "能量电池",
  5361: "神秘空投",
  5362: "超级空投",
  5363: "超能喷射",
  5364: "魔法镜",
  5371: "为你而歌",
  5373: "华丽舞鞋",
  5374: "音为有你",
  5375: "乐谱",
  5376: "好戏",
  5382: "蝶恋花",
  5383: "鱼你相伴",
  5398: "十里桃花",
  5399: "古往今来",
  5400: "昆仑神宫",
  5404: "ONE礼挑一",
  5405: "搓碟王",
  5406: "拉拉队长",
  5407: "守护天使",
  5408: "冒险家",
  5409: "王牌粉丝",
  5410: "大魔术师",
  5411: "1号船长",
  5447: "好球",
  5459: "福泽秘境",
  5464: "飞雪喷雾",
  5465: "烟花棒",
  5483: "KONO洗发水",
  5491: "小熊软糖",
  5494: "多喝热水",
  5503: "黄桃罐头",
  5505: "时空穿梭",
  5509: "新春直播季",
  5510: "兔个彩头",
  5511: "架子鼓",
  5512: "华彩种子",
  5513: "电吉他",
  5515: "一箭倾心",
  5516: "一吻定情",
  5518: "开往春天",
  5522: "陪你的季节",
  5523: "戏楼",
  5524: "多喝热水",
  5526: "直播五周年",
  5527: "与你星尘",
  5530: "兔来运转",
  5531: "幸福列车",
  5532: "鲤鱼跃龙门",
  5533: "聚宝盆",
  5534: "众安是福",
  5535: "悦鲜活",
  5538: "1.2倍加成卡",
  5539: "1.5倍加成卡",
  5545: "简醇好礼",
  5555: "告白惊喜",
  5556: "真爱永恒",
  5557: "捏捏小脸",
  5559: "夏洛特烦恼",
  5560: "开心麻花",
  5563: "荧光棒",
  5564: "闪耀星辰",
  5572: "告白惊喜",
  5574: "飞鹤奶粉",
  5575: "有机奶粉",
  5577: "2月你好",
  5583: "凤凰来仪",
  5592: "浪漫嘉年华",
  5595: "1.2倍加成卡",
  5596: "玫瑰之约",
  5597: "银河之光",
  5598: "时尚代言",
  5601: "1.3倍加成卡",
  5606: "金色抖音1号",
  5618: "旋风归来",
  5619: "星际狂飙",
  5624: "花繁蝶欢",
  5626: "缤纷礼赞",
  5627: "长安逸达",
  5633: "真爱玫瑰",
  5634: "炽热漂移",
  5650: "捧捧脸蛋",
  5652: "新途岳",
  5662: "1.2倍加成卡",
  5664: "花海泛舟",
  5665: "星际玫瑰",
  5666: "奇幻花潮",
  5667: "1.2倍加成卡",
  5668: "1.5倍加成卡",
  5669: "2.0倍加成卡",
  5671: "小熊猫抱抱",
  5673: "奇幻花潮",
  5679: "2倍加成卡",
  5680: "Pico",
  5690: "新裤子乐队CD",
  5691: "向日葵",
  5692: "偷偷告白",
  5693: "为你表白",
  5694: "星夜秋千",
  5695: "星空旅行",
  5696: "浪漫寻蜜",
  5697: "+5里程加加卡",
  5698: "+1里程加加卡",
  5699: "+2里程加加卡",
  5701: "冰蓝玫瑰",
  5705: "宝象传说",
  5706: "云中鲸",
  5712: "胡桃夹子",
  5738: "小鹿乱撞",
  5739: "1.5倍加成卡",
  5740: "1.2倍加成卡",
  5750: "春日泛舟",
  5753: "天空之镜",
  5755: "捷达SUV",
  5766: "为你举牌",
  5767: "玫瑰公爵",
  5774: "阳光",
  5775: "小太阳",
  5776: "小太阳派对",
  5791: "璀璨舞台",
  5792: "璀璨皇冠",
  5793: "slay全场",
  5794: "璀璨奖杯",
  5795: "豪华火箭",
  5796: "追光时刻",
  5800: "心愿信鸽",
  5801: "璀璨喷泉",
  5802: "CD",
  5803: "小汤圆",
  5804: "小薄荷",
  5805: "荧光棒",
  5807: "Nice",
  5808: "一鼓作气",
  5830: "欢迎首播",
  5831: "一束花开",
  5833: "金火箭",
  5835: "人气宝箱",
  5839: "玫瑰公爵",
  5841: "金火箭",
  5848: "捏捏喵脸",
  5849: "猜猜我是谁",
  5850: "太空喵喵",
  5851: "挖掘惊喜",
  5852: "蝶 · 连理枝",
  5853: "蝶 · 书中情",
  5854: "蝶 · 比翼鸟",
  5855: "蝶 · 寄相思",
  5856: "蝶 · 书中情",
  5862: "笔记本",
  5863: " 书包",
  5864: "行李箱",
  5865: " 学士帽",
  5866: "1.2倍加成卡",
  5867: "1.3倍加成卡",
  5879: "哈哈哈",
  5881: "乐谱",
  5882: "2倍加成卡",
  5885: "深海奇缘",
  5886: "传承印记",
  5887: "拉轰摩托",
  5902: "花灯",
  5903: "鹊桥告白",
  5904: "加冕王冠",
  5905: "星河相望",
  5906: "为你打call",
  5907: "鹊桥相会",
  5908: "鹊桥相会",
  5909: "闪耀舞台",
  5910: "闪耀之路",
  5911: "碰拳",
  5920: "荣誉之匙",
  5921: "欢乐源泉",
  5922: "云上巡礼",
  5923: "造梦工厂",
  5924: "荣誉流星",
  5929: "云中秘境",
  5932: "1.2倍加成卡",
  5933: "夏日乐园",
  5934: "滨海假日",
  5937: "鹊之恋",
  5938: "海誓山盟",
  5950: "两两鸳鸯",
  5951: "牛郎织女妆",
  5952: "云中秘境",
  5955: "金色飞机",
  5956: "金色嘉年华",
  5958: "旗开得胜",
  5959: "登峰造极",
  5960: "中国必胜",
  5961: "为国争光",
  5962: "健儿加油鸭",
  5963: "火力全开",
  5964: "球进啦",
  5965: "防守大师",
  5966: "绿荫旋风",
  5967: "灌篮高手",
  5968: "控球主将",
  5969: "绝世好球",
  5970: "最佳选手",
  5971: "超强丹砂",
  5972: "带飞全场",
  6008: "抖音飞艇",
  6014: "相思豆",
  6024: "豪华邮轮",
  6028: "玫瑰小熊",
  6029: "甜蜜冲刺",
  6031: "假笑",
  6038: "蝶 · 化蝶飞",
  6039: "蝶 · 续前缘",
  6041: "燃起来了",
  6042: "做我的猫",
  6043: "爱的抱抱",
  6059: "泳池派对",
  6060: "欢庆乐章",
  6064: "捶捶肩膀",
  6065: "芭比帽",
  6066: "丘比特之箭",
  6067: "生日眼镜",
  6068: "兔耳朵",
  6069: "我保护你",
  6070: "小红帽",
  6071: "展开说说",
  6075: "小鸡跳跳",
  6076: "懒懒猫",
  6086: "躲猫猫",
  6088: "为你演奏",
  6089: "小恶魔",
  6090: "勇立潮头",
  6091: "超能",
  6092: "助你夺冠",
  6096: "鼓掌",
  6097: "辣条",
  6098: "快乐水",
  6103: "仙侣奇缘",
  6104: "假笑",
  6105: "兔耳朵",
  21051: "万圣快乐"
};

function toTimestamp(createTime) {
  const n = toNum(createTime);
  if (!n) return Date.now();
  if (n > 1e12) return n;
  if (n > 1e9) return n * 1000;
  return Date.now();
}

/** 把「1.2万」「3亿」这类展示文本转成数字。 */
function parseCountText(text) {
  const match = String(text || '').match(/([\d.]+)\s*(万|亿)?/);
  if (!match) return 0;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return 0;
  const unit = match[2] === '万' ? 10000 : match[2] === '亿' ? 100000000 : 1;
  return Math.round(base * unit);
}

function normalizeUser(raw) {
  if (!raw) return null;
  const nickname = firstText(raw.nickname, '');
  if (!nickname && !raw.id) return null;
  const club = raw.fansClub && raw.fansClub.data;
  return {
    id: toId(raw.id),
    nickname: nickname || '观众',
    avatar: firstText(imageUrl(raw.avatarThumb), imageUrl(raw.avatarMedium), imageUrl(raw.avatarLarge)),
    level: toNum(raw.level),
    gender: toNum(raw.gender),
    verified: Boolean(raw.verified),
    payLevel: toNum(raw.payGrade && raw.payGrade.level),
    // 抖音随用户下发的关注关系：0 = 未关注主播，1 = 已关注，2 = 互关
    followStatus: toNum(raw.followInfo && raw.followInfo.followStatus),
    fansClub: club && club.clubName
      ? { name: String(club.clubName), level: toNum(club.level), status: toNum(club.userFansClubStatus) }
      : null,
  };
}

let fallbackSeq = 0;

function base(method, common) {
  const msgId = toId(common && common.msgId);
  if (!msgId) fallbackSeq += 1;
  return {
    id: msgId ? `${method}:${msgId}` : `${method}:anon:${fallbackSeq}`,
    method,
    ts: toTimestamp(common && common.createTime),
    roomId: toId(common && common.roomId),
  };
}

function decodeChat(data, method) {
  const event = base(method, data.common);
  return {
    ...event,
    type: 'chat',
    user: normalizeUser(data.user),
    content: String(data.content || '').trim(),
  };
}

function decodeEmojiChat(data, method) {
  const event = base(method, data.common);
  const content = firstText(data.emojiContent && data.emojiContent.defaultPattern, data.defaultContent, '[表情]');
  return {
    ...event,
    type: 'chat',
    emoji: true,
    user: normalizeUser(data.user),
    content,
  };
}

function decodeGift(data, method) {
  const event = base(method, data.common);
  const gift = data.gift || {};
  const count = toNum(data.repeatCount) || toNum(data.comboCount) || toNum(data.groupCount) || 1;
  const completed = Boolean(toNum(data.repeatEnd));
  const giftId = toId(firstText(data.giftId, gift.id));
  const rawName = firstText(gift.name, gift.describe, '');
  const mappedName = GIFT_NAME_BY_ID[giftId];
  const name = (rawName && rawName !== '礼物' ? rawName : '') || mappedName || rawName || '礼物';
  const imageList = gift.image && Array.isArray(gift.image.urlList) ? gift.image.urlList : [];
  return {
    ...event,
    type: 'gift',
    user: normalizeUser(data.user),
    gift: {
      id: giftId,
      name: String(name),
      count,
      completed,
      image: String(imageList.find((url) => url) || ''),
      diamondCount: toNum(gift.diamondCount),
      toUser: normalizeUser(data.toUser),
    },
    // 连击未结束时先不回复，避免刷屏；等最后一击再谢
    canReply: completed || count <= 1,
  };
}

function decodeMember(data, method) {
  const event = base(method, data.common);
  return {
    ...event,
    type: 'member',
    user: normalizeUser(data.user),
    member: {
      count: toNum(data.memberCount),
      actionDescription: String(data.actionDescription || ''),
    },
  };
}

function decodeLike(data, method) {
  const event = base(method, data.common);
  return {
    ...event,
    type: 'like',
    user: normalizeUser(data.user),
    like: {
      count: toNum(data.count),
      total: toNum(data.total),
    },
  };
}

function decodeSocial(data, method) {
  const event = base(method, data.common);
  const action = toNum(data.action);
  const followCount = toNum(data.followCount);
  return {
    ...event,
    type: action === 1 || followCount > 0 ? 'follow' : 'share',
    user: normalizeUser(data.user),
    social: { action, followCount },
  };
}

function decodeRoomUserSeq(data, method) {
  const event = base(method, data.common);
  const ranks = Array.isArray(data.ranks) ? data.ranks : [];
  const viewers = ranks
    .map((item) => {
      const user = normalizeUser(item && item.user);
      if (!user) return null;
      return { ...user, rank: toNum(item.rank), score: toNum(item.score) };
    })
    .filter(Boolean);
  return {
    ...event,
    type: 'stats',
    stats: {
      online: Math.max(0, toNum(data.total)),
      cumulative: Math.max(0, toNum(data.totalUser)),
    },
    // 当前在线观众名单（抖音 WebcastRoomUserSeqMessage.ranks），用于只跟在场观众打招呼
    viewers,
  };
}

function decodeRoomStats(data, method) {
  const event = base(method, data.common);
  const text = String(data.displayLong || data.displayMiddle || data.displayShort || '');
  return {
    ...event,
    type: 'stats',
    stats: {
      online: Math.max(0, toNum(data.total)) || parseCountText(text),
      cumulative: 0,
      text,
    },
  };
}

function decodeControl(data, method) {
  const event = base(method, data.common);
  return {
    ...event,
    type: 'control',
    control: { status: toNum(data.status) },
  };
}

const SCHEMAS = {
  WebcastChatMessage: ChatMessage,
  WebcastEmojiChatMessage: EmojiChatMessage,
  WebcastGiftMessage: GiftMessage,
  WebcastMemberMessage: MemberMessage,
  WebcastLikeMessage: LikeMessage,
  WebcastSocialMessage: SocialMessage,
  WebcastRoomUserSeqMessage: RoomUserSeqMessage,
  WebcastRoomStatsMessage: RoomStatsMessage,
  WebcastControlMessage: ControlMessage,
};

const DECODERS = {
  WebcastChatMessage: decodeChat,
  WebcastEmojiChatMessage: decodeEmojiChat,
  WebcastGiftMessage: decodeGift,
  WebcastMemberMessage: decodeMember,
  WebcastLikeMessage: decodeLike,
  WebcastSocialMessage: decodeSocial,
  WebcastRoomUserSeqMessage: decodeRoomUserSeq,
  WebcastRoomStatsMessage: decodeRoomStats,
  WebcastControlMessage: decodeControl,
};

/** 从 WebSocket / 页面 URL 中提取 room_id（如果存在）。 */
export function roomIdFromUrl(url) {
  if (typeof url !== 'string') return '';
  const match = url.match(/[?&]room_id=(\d+)/);
  return match ? match[1] : '';
}

/**
 * 解码一帧服务端推送。
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {Promise<{events:object[], unknown:string[], headers:Record<string,string>, payloadType:string, cursor:string, needAck:boolean, internalExt:string}>}
 */
export async function decodeFrame(input) {
  const data = toBytes(input);
  const frame = decodeMessage(data, PushFrame);
  const headers = {};
  for (const header of frame.headers || []) {
    if (header && header.key) headers[String(header.key)] = header.value;
  }

  const result = {
    events: [],
    unknown: [],
    headers,
    payloadType: frame.payloadType || '',
    cursor: '',
    needAck: false,
    internalExt: '',
  };

  let payload = frame.payload || new Uint8Array(0);
  if (!payload.length) return result;
  if (isGzip(payload)) payload = await gunzip(payload);

  let response;
  try {
    response = decodeMessage(payload, Response);
  } catch {
    return result;
  }
  result.cursor = response.cursor || '';
  result.needAck = Boolean(response.needAck);
  result.internalExt = response.internalExt || '';

  for (const message of response.messages || []) {
    const method = String(message.method || '');
    const schema = SCHEMAS[method];
    const decoder = DECODERS[method];
    if (!method) continue;
    if (!schema || !decoder || !message.payload) {
      result.unknown.push(method);
      continue;
    }
    try {
      let body = message.payload;
      if (isGzip(body)) body = await gunzip(body);
      const event = decoder(decodeMessage(body, schema), method);
      if (event) result.events.push(event);
    } catch {
      result.unknown.push(method);
    }
  }

  return result;
}

export const MESSAGE_TYPES = ['chat', 'gift', 'member', 'follow', 'like', 'stats', 'control', 'share'];
