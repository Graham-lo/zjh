/**
 * 通用人性底层 · 领域适配器接口（设计文档 §4.10.2）。
 *
 * 通用包只认这几个领域无关的类型。要把这套「人」接到一个新领域上，
 * 实现一个 `DomainAdapter` 就够了：把领域事件折算成通用评价、把局面压成粗特征、
 * 给出系统 1 的原型匹配和系统 2 的算账工具、说清楚这一步的赌注和时间压力。
 * 炸金花的实现在 `shared/zjh/bot/adapter.ts`，测试里还有一个玩具交易适配器。
 */

import { type Appraisal, type MindState, applyAppraisal } from './emotion.ts';
import type { Traits } from './traits.ts';

/** 一个候选动作的打分。`key` 用来跨系统 1/系统 2 对齐同一个动作。 */
export interface Scored<A> {
  action: A;
  key: string;
  score: number;
}

/**
 * 系统 1 的输入：局面被压成的**粗粒度**特征（§4.9.7）。
 * 注意这里没有精确概率 —— 系统 1 看的是档位和印象，不是小数点后两位。
 */
export interface CoarseFeatures {
  /** 我手上的东西看起来有多好 0..1 */
  selfTier: number;
  /** 对面 / 环境看起来有多强 0..1 */
  threatTier: number;
  /** 这一步的赌注占资产 0..1 */
  stakeTier: number;
  /** 这个局面有多熟 0..1（R29 认知放松） */
  familiarity: number;
  /** 相对参照点的站位 −1..1 */
  standing: number;
  /** 现在面对的那个人（稳定键），社会性规律用 */
  counterpartKey?: string;
  /** 领域自己的补充标签，通用包不解释它们 */
  tags?: Record<string, number>;
}

/** 系统 1 的输出：一个冲动，外加「感觉」。 */
export interface Impulse<A> {
  action: A;
  key: string;
  /** 这个冲动有多笃定 0..1 */
  confidence: number;
  /** 觉得自己的东西有多好 0..1（受 R16 幻想、R6 热手影响） */
  feltStrength: number;
  /** 觉得对面有多强 0..1（受 R24 确认偏差、R17 近因影响） */
  feltThreat: number;
  /** 全部候选的直觉打分，系统 2 要按同一批 key 做对比 */
  scores: Scored<A>[];
}

/** 系统 2 的输出：算过账之后的排序。 */
export interface Deliberation<A> {
  best: A;
  bestKey: string;
  scores: Scored<A>[];
  /** 这一步有多难算 0..1，决定用时 */
  difficulty: number;
}

export interface DomainAdapter<Situation, Action, Event> {
  /**
   * 把领域事件翻译成通用评价：好坏、相对参照点的大小、意外程度、归因、可控性。
   *
   * 只吃事件和当事人，**不吃局面**：评价发生在「那件事发生的那一刻」，而
   * `Situation` 是「我下一次要行动时的局面」—— 拿后者当前者的上下文等于用未来
   * 解释过去，也会逼着调用方在还没轮到自己的时刻去构造一个完整的局面对象。
   * 所以事件自己要带齐量纲（多大一笔、当时我有多少）。
   */
  appraise(ev: Event, self: MindState): Appraisal;
  /** 系统 1 的输入：把局面压成粗粒度特征，供原型匹配 */
  coarse(ctx: Situation, self: MindState): CoarseFeatures;
  /** 系统 1 的原型表：粗特征 → 冲动 + 感觉 */
  intuition(f: CoarseFeatures, mind: MindState, traits: Traits): Impulse<Action>;
  /** 系统 2 的工具：给定局面算各候选动作的（主观）价值 */
  deliberate(ctx: Situation, mind: MindState, traits: Traits): Deliberation<Action>;
  /** 领域里「赌注多大」「时间多紧」「多熟悉」的度量，供 p2 公式 */
  stakes(ctx: Situation, self: MindState): { stakes: number; timePressure: number; familiarity: number };
}

/* --------------------------------------------------- 事件 → 情绪的唯一通道 */

/**
 * **领域事件进情绪，只有这一条路**（§4.9.1）。
 *
 * 事件不直接改情绪：先由领域适配器按五个维度打分，再由通用映射表
 * （`appraisalToDeltas`）转成情绪/驱力增量，最后经唯一的写入口 `nudge` 落进状态。
 * 结算走的是 `regularities.ts` 的 `settle()` / `outcomeAppraisal()`，
 * 汇进的是**同一张表、同一个写入口**。
 *
 * 返回那份评价，方便调用方把「这一步他到底感受到了什么」写进 trace 或测试。
 */
export function feel<Situation, Action, Event>(
  adapter: Pick<DomainAdapter<Situation, Action, Event>, 'appraise'>,
  ev: Event, mind: MindState, t: Traits, gain = 1,
): Appraisal {
  const a = adapter.appraise(ev, mind);
  applyAppraisal(mind, t, a, gain);
  return a;
}
