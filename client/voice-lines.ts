/**
 * 两个游戏的台词表。**纯数据，不碰 window** —— sound.ts 一 import 就会 new 出
 * AudioContext 那一套，node 里跑不起来，台词表却是要能被测试钉住的
 * （比如「两张表不许有同名 key」这条）。
 *
 * 语音包脚本 scripts/voice-pack.mjs 也是直接读这个文件。
 */
/** 一句台词。key 同时是语音包里的音频文件名 */
export interface VoiceLine {
  text: string;
  rate?: number;
  pitch?: number;
  volume?: number;
}

/**
 * 炸金花的台词。**这张表和升级那张是分开的，不许互相借用** ——
 * 两个游戏的牌桌语言完全不一样，共用一张表的结果就是升级听起来像在打炸金花
 * （最早升级借的就是这里的「该你啦」）。类型上也拆成两个 key 联合，
 * 想在升级的牌桌上播 `call` 是编译不过的。
 *
 * rate / pitch 只在退回浏览器 TTS 时生效 —— 梭哈和豹子是牌桌上最上头的两下，
 * 语速和音高都往上推，别念得像在报站。用语音包时情绪由录音本身决定。
 */
export const ZJH_VOICE_LINES = {
  call: { text: '跟注' },
  raise: { text: '加注', rate: 1.25, pitch: 1.1 },
  allin: { text: '梭哈！全下！', rate: 1.45, pitch: 1.45, volume: 1 },
  accept: { text: '接！', rate: 1.4, pitch: 1.3, volume: 1 },
  compare: { text: '比牌', rate: 1.2, pitch: 1.1 },
  fold: { text: '弃牌', rate: 1.05, pitch: 0.95 },
  baozi: { text: '豹子！', rate: 1.4, pitch: 1.45, volume: 1 },
  shunjin: { text: '顺金！', rate: 1.35, pitch: 1.35, volume: 1 },
  jinhua: { text: '金花', rate: 1.2, pitch: 1.15 },
  shunzi: { text: '顺子', rate: 1.15, pitch: 1.05 },
  duizi: { text: '对子' },
  sanpai: { text: '散牌', rate: 1.0, pitch: 0.95 },
} satisfies Record<string, VoiceLine>;

/**
 * 升级的台词（DESIGN 3.6）。整套按升级自己的牌桌语言写，一句都不从炸金花挪。
 *
 * 覆盖面参照腾讯棋牌的惯例（欢乐斗地主是每次出牌报牌型 + 跟不上报「要不起」+
 * 叫牌阶段表态 + 结算）：叫牌阶段全程有声，**首出**报牌型，跟牌只在毙 / 盖毙 /
 * 垫分这三种有信息量的时刻出声 —— 一局 25 圈 100 手牌，每手都报会吵得关掉。
 *
 * 组合播报：`voice.play('sj_fanzhu', 'sj_trump_h')` 念成「反主！红桃主」，
 * 所以花色和事件各自是一句短的，不为每个组合单独录一句。
 */
export const SJ_VOICE_LINES = {
  /* 叫牌 */
  sj_trump_s: { text: '黑桃主', rate: 1.2, pitch: 1.05 },
  sj_trump_h: { text: '红桃主', rate: 1.2, pitch: 1.05 },
  sj_trump_c: { text: '梅花主', rate: 1.2, pitch: 1.05 },
  sj_trump_d: { text: '方块主', rate: 1.2, pitch: 1.05 },
  sj_trump_pair: { text: '一对', rate: 1.25, pitch: 1.15 },
  sj_reinforce: { text: '加固', rate: 1.1 },
  sj_fanzhu: { text: '反主！', rate: 1.4, pitch: 1.3, volume: 1 },
  sj_nt: { text: '无主！', rate: 1.4, pitch: 1.35, volume: 1 },
  sj_flip: { text: '翻底定主', rate: 1.05 },
  sj_chao: { text: '抄底！', rate: 1.45, pitch: 1.4, volume: 1 },
  sj_kou: { text: '扣底', rate: 1.05 },
  /* 出牌 */
  sj_pair: { text: '对子', rate: 1.15 },
  sj_tractor: { text: '拖拉机！', rate: 1.3, pitch: 1.2 },
  sj_shuai: { text: '甩牌！', rate: 1.35, pitch: 1.25, volume: 1 },
  sj_shuai_fail: { text: '甩不掉', rate: 1.0, pitch: 0.9 },
  sj_diao: { text: '吊主', rate: 1.2, pitch: 1.05 },
  sj_bi: { text: '毙了', rate: 1.4, pitch: 1.3, volume: 1 },
  sj_gaibi: { text: '盖毙！', rate: 1.45, pitch: 1.4, volume: 1 },
  sj_dian: { text: '垫牌', rate: 1.05, pitch: 0.95 },
  /* 收圈 */
  sj_fen: { text: '有分！', rate: 1.3, pitch: 1.2 },
  sj_last: { text: '最后一圈！', rate: 1.3, pitch: 1.2 },
  /* 结算 */
  sj_dig: { text: '抠底！', rate: 1.45, pitch: 1.4, volume: 1 },
  sj_dig2: { text: '双抠！', rate: 1.45, pitch: 1.45, volume: 1 },
  sj_levelup: { text: '升级！', rate: 1.3, pitch: 1.2 },
  sj_daguang: { text: '大光！', rate: 1.4, pitch: 1.4, volume: 1 },
  sj_xiaoguang: { text: '小光！', rate: 1.35, pitch: 1.3, volume: 1 },
  sj_shangtai: { text: '上台！', rate: 1.35, pitch: 1.3, volume: 1 },
  sj_shouzhu: { text: '守住了', rate: 1.1 },
  sj_tongguan: { text: '通关！', rate: 1.45, pitch: 1.45, volume: 1 },
} satisfies Record<string, VoiceLine>;

export type ZjhVoiceKey = keyof typeof ZJH_VOICE_LINES;
export type SjVoiceKey = keyof typeof SJ_VOICE_LINES;
export type VoiceKey = ZjhVoiceKey | SjVoiceKey;

/** 播放与语音包只认这一张合并表；写台词请写到上面两张里去 */
export const VOICE_LINES: Record<VoiceKey, VoiceLine> = { ...ZJH_VOICE_LINES, ...SJ_VOICE_LINES };

/** 牌型名 → 语音 key（炸金花） */
export const HAND_VOICE: Record<string, ZjhVoiceKey> = {
  豹子: 'baozi',
  顺金: 'shunjin',
  金花: 'jinhua',
  顺子: 'shunzi',
  对子: 'duizi',
  散牌: 'sanpai',
  特殊235: 'sanpai',
};
