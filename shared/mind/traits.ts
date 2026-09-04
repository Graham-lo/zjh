/**
 * 通用人性底层 · 个人特征表（设计文档 §4.9.2 / §4.9.6 / §4.10.1）。
 *
 * `Traits` 是**一个人**的全部个体差异：情绪基线、对五个评价维度的敏感度、
 * 各维度的衰减、同样的情绪落到哪个通道多少、上头/宽裕的阈值、
 * 三十三条规律各自有多重，以及认知那一套（爱不爱动脑、自控、意志力、
 * 概率权重、框架宽窄）。
 *
 * 它**不含任何领域词汇**：换到股市，同一张表描述的还是同一个人。
 * 领域侧的习惯（炸金花的看牌习惯、线路、比牌口味）留在领域包里。
 * 新增一个人只需要写一张 `Traits` + 领域习惯，`shared/mind/` 零改动（§4.10.4-3）。
 */

import type { ChannelGains, Drives, Emotions } from './emotion.ts';
import type { Regularity } from './regularities.ts';

export interface Traits {
  /** 情绪基线：不发生任何事的时候这个人停在哪 */
  baseline: Emotions;
  /** 驱力基线 */
  drives: Drives;
  /** 对五个评价维度的敏感度，乘在通用映射表的输出上 */
  sensitivity: {
    valence: number; magnitude: number; expectancy: number;
    agency: number; controllability: number;
  };
  /** 每局结束向基线的衰减比例（越大消得越快） */
  decay: Emotions & { revenge: number; boredom: number };
  /** 表达增益：同样的情绪落到哪个通道多少 */
  expression: Partial<Record<keyof Emotions | 'boredom', Partial<ChannelGains>>>;
  /** 上头：怒+思 超过 trigger 视为上头，recover 局回落 */
  tilt: { trigger: number; gain: number; recover: number };
  /** 宽裕：喜 超过 trigger 视为宽裕 */
  ease: { trigger: number; gain: number };
  /**
   * 记仇强度（R14 的个人系数）。`mind.revenge` / `mind.pressedBy` 记的是
   * **发生了什么**（同一件事对谁都记同样多），`grudgeGain` 记的是
   * **这个人会不会把它当回事**：同样被压一次，常人第二天就忘了，
   * 复仇型的人会一直盯着那个人。
   *
   * 之所以要单独一个系数而不是复用 `sensitivity.agency`：agency 影响的是
   * 「这件事有多大程度是被人干的」这个评价本身，会连带改情绪；
   * 记仇强度只改**已经成型的恨意落到行为通道上的倍率**，两者在同一个人身上
   * 可以完全不同（有人不觉得被针对，但一旦认定就记很久）。
   *
   * 常人 1.0。1 以下是「不记仇」，2 以上是「记仇的人」。
   */
  grudgeGain: number;
  /** R1..R33 的系数，常人全为 1 */
  regularities: Partial<Record<Regularity, number>>;
  /** 认知（§4.9.7 的双系统参数） */
  cognition: {
    /** 爱不爱动脑子：系统 2 介入概率的基线 */
    needForCognition: number;
    /** 自控：算出来的结论要比直觉好多少才推翻得了冲动。越高越容易推翻 */
    selfControl: number;
    /**
     * 意志力预算与每**局**回复量（R30）。单位是自定的：一次系统 2 介入扣
     * `willpowerCost`，一局结束回 `willpowerRecover`，封顶 `willpowerMax`。
     * 常人的取值让「一手牌打了很多轮之后开始懒得算」，而不是「打两手就再也不算了」。
     */
    willpowerMax: number;
    willpowerRecover: number;
    /** 系统 2 每介入一次消耗多少 */
    willpowerCost: number;
    /** Prelec 概率权重的 α（R26），常人 0.65 */
    probWeightAlpha: number;
    /** 狭窄框架（R33）：只看这一局，不做整场的风险预算 */
    narrowFraming: number;
  };
  /** 节奏（领域无关的毫秒基线，领域可以再缩放） */
  tempo: {
    /** 系统 1 出手的基线用时 */
    baseMs: number;
    /** 系统 2 介入一次最多再加多久 */
    deliberateMs: number;
    /** 抖动幅度 0..1 */
    jitter: number;
  };
}

/**
 * 常人的天性参数（设计文档 §4.9.6 的默认值，逐字照抄；
 * `cognition`/`tempo` 按 §4.9.7 的常人取值补齐）。八张卡在这个基础上偏斜。
 */
export const COMMON_TRAITS: Traits = {
  baseline: { joy: .1, anger: 0, worry: .1, rumination: 0, sorrow: 0, fear: .1, surprise: 0 },
  drives: { greed: .3, pride: .3, safety: .4, curiosity: .3, boredom: 0 },
  sensitivity: { valence: 1, magnitude: 1, expectancy: 1, agency: 1, controllability: 1 },
  decay: {
    joy: .35, anger: .25, worry: .3, rumination: .3, sorrow: .3, fear: .5, surprise: .7,
    revenge: .15, boredom: .0,
  },
  expression: {
    anger: { aggression: +.5, quitThreshold: +.4, delayInfo: +.3, tempo: -.3 },
    fear: { aggression: -.4, quitThreshold: -.5, seekInfo: +.4, tempo: -.2 },
    joy: { looseness: +.3, greed: +.3, showoff: +.3 },
    sorrow: { looseness: -.3, safety: +.4, tempo: +.2 },
    worry: { looseness: -.2, seekInfo: +.3 },
    rumination: { callLighter: +.3, tempo: +.4 },
    boredom: { looseness: +.4, delayInfo: +.3 },
  },
  tilt: { trigger: .55, gain: 1.0, recover: 3 },
  ease: { trigger: .45, gain: 1.0 },
  grudgeGain: 1.0,
  regularities: {},   // 常人全为 1（`reg()` 的缺省）
  cognition: {
    needForCognition: 0.5,
    selfControl: 0.5,
    willpowerMax: 6,
    willpowerRecover: 1.0,
    willpowerCost: 0.5,
    probWeightAlpha: 0.65,
    narrowFraming: 0.7,
  },
  tempo: { baseMs: 380, deliberateMs: 3200, jitter: 0.35 },
};

/** 深拷贝一张特征表，给「在常人基础上偏斜」用。 */
export function cloneTraits(t: Traits): Traits {
  return {
    baseline: { ...t.baseline },
    drives: { ...t.drives },
    sensitivity: { ...t.sensitivity },
    decay: { ...t.decay },
    expression: Object.fromEntries(
      Object.entries(t.expression).map(([k, v]) => [k, { ...v }]),
    ) as Traits['expression'],
    tilt: { ...t.tilt },
    ease: { ...t.ease },
    grudgeGain: t.grudgeGain,
    regularities: { ...t.regularities },
    cognition: { ...t.cognition },
    tempo: { ...t.tempo },
  };
}
