/**
 * 通用人性底层 · 规律库 R1–R33（设计文档 §4.9.5 / §4.9.8）。
 *
 * 每条规律 = 触发 → 评价 → 情绪/驱力变化 → 表达通道。
 * **全部用领域无关量表述**（§4.10.3）：相对参照点的对数收益/亏损、事前概率与
 * 结果的偏差、归因、可控性、唤醒度、疲劳、连续输赢计数、意志力预算、
 * 同一对手的重复交互计数。这里出现「轮次 / 底池 / 单价 / 金花」就是写错了。
 *
 * 落地分三处：
 *  - 跨局的（R1/R5/R6/R7/R8/R10/R13/R18/R23…）在 `settle()` 里；
 *  - 临场的（R1/R2/R4/R5/R6/R11/R13/R14/R15/R16/R23）在 `situationalChannels()` 里；
 *  - 系统内部的（R20/R21/R26/R27/R29/R30/R33）在 `dual.ts` 与领域的系统 2 工具里。
 *
 * `REGULARITIES` 表标了每一条这一期是否真的接线了；没接的系数接口仍然在，
 * 人物特征表可以照配，加代码消费即可。
 */

import {
  type Appraisal, type Channels, type MindState, applyAppraisal, clamp, clamp01,
  clampChannels, couple, fatigueOf, impressionOf, magnitudeOf, noteImpression,
  nudge, referencePoint, relax,
} from './emotion.ts';
import type { Traits } from './traits.ts';

export type Regularity =
  | 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7' | 'R8' | 'R9' | 'R10' | 'R11'
  | 'R12' | 'R13' | 'R14' | 'R15' | 'R16' | 'R17' | 'R18' | 'R19' | 'R20' | 'R21'
  | 'R22' | 'R23' | 'R24' | 'R25' | 'R26' | 'R27' | 'R28' | 'R29' | 'R30' | 'R31'
  | 'R32' | 'R33';

export interface RegularityInfo {
  id: Regularity;
  /** 规律名 */
  name: string;
  /** 这一期是不是真的有代码在消费它 */
  wired: boolean;
  /** 在哪里生效 */
  where: 'settle' | 'channels' | 'dual' | 'domain' | 'deferred' | 'n/a';
  /**
   * `wired: false` 时**必须**写清楚为什么没接（不是「以后再说」）。
   * 只有两种理由算数：这个领域里根本没有这条规律的触发事件（`n/a`），
   * 或者它落在后续阶段的范围里、并且在设计文档里也标了那个阶段（`deferred`）。
   */
  why?: string;
}

export const REGULARITIES: Record<Regularity, RegularityInfo> = {
  R1: { id: 'R1', name: '损失厌恶', wired: true, where: 'channels' },
  R2: { id: 'R2', name: '赢家的钱效应', wired: true, where: 'channels' },
  R3: { id: 'R3', name: '收官效应', wired: true, where: 'channels' },
  R4: { id: 'R4', name: '沉没成本', wired: true, where: 'channels' },
  R5: { id: 'R5', name: '赌徒谬误', wired: true, where: 'channels' },
  R6: { id: 'R6', name: '热手', wired: true, where: 'channels' },
  R7: { id: 'R7', name: 'bad beat 上头', wired: true, where: 'settle' },
  R8: {
    id: 'R8', name: '诈唬被抓', wired: true, where: 'dual',
    // 结算时记一次「被拆穿」（`mind.caught`，封顶 3、每局 ×0.90），
    // 之后每一步再把它读成收敛（参与面 −0.15、进攻性 −0.15、求安 +0.12）。
    // 缺了后半截就只有一阵尴尬、没有「一段时间不敢演」（`personas.md`「待集成」#3）。
    why: '被抓的记忆要跨手存在，收敛才有长度；只在 settle 里点一下等于没有后效。',
  },
  R9: {
    id: 'R9', name: '被诈成功后知道了', wired: true, where: 'settle',
    // P2 把它登记成 wired:false，理由是「本领域没有『主动亮牌』这个动作」。
    // 那条理由只对**主动**那两个字成立：把我逼退的那个人照样会被别人比牌、
    // 或者一路走到摊牌，结算就把他那手牌公开了 —— 我看见的东西一模一样。
    // P3 按「公开结果」接线（`settleMinds` 判触发，`Outcome.bluffedOut` 传进来），
    // 后效在 `situationalChannels` 里按对手分别生效，就是原话的「仅对该人」。
    why: '按公开的结算结果接线，而不是按「对手主动炫耀」——'
      + '后者本领域确实没有，前者本领域每一局都在产生。',
  },
  R10: { id: 'R10', name: '放弃了本可获胜的懊悔', wired: true, where: 'settle' },
  R11: { id: 'R11', name: '面对大注的怯', wired: true, where: 'channels' },
  R12: { id: 'R12', name: '花钱买信息', wired: true, where: 'channels' },
  R13: { id: 'R13', name: '无聊 / 求刺激', wired: true, where: 'channels' },
  R14: { id: 'R14', name: '面子：同一个人压两次', wired: true, where: 'channels' },
  R15: { id: 'R15', name: '资源位阶', wired: true, where: 'channels' },
  R16: { id: 'R16', name: '未查看持有的幻想', wired: true, where: 'channels' },
  R17: { id: 'R17', name: '近因偏差', wired: true, where: 'domain' },
  R18: { id: 'R18', name: '归因偏差', wired: true, where: 'settle' },
  R19: { id: 'R19', name: '情绪传染', wired: true, where: 'channels' },
  R20: { id: 'R20', name: '疲劳', wired: true, where: 'dual' },
  R21: { id: 'R21', name: '唤醒 → 冒险', wired: true, where: 'channels' },
  R22: { id: 'R22', name: '情绪修复', wired: true, where: 'channels' },
  R23: { id: 'R23', name: '锚定', wired: true, where: 'channels' },
  // R24 落在领域的读人似然里：给人贴上原型标签之后，他的每一个动作在范围模型里
  // 都乘上这个标签的 `slope`（`shared/zjh/bot/range.ts` 的 `likelihoodFor`）。
  R24: { id: 'R24', name: '确认偏差', wired: true, where: 'domain' },
  R25: { id: 'R25', name: '社会性展示', wired: true, where: 'domain' },
  R26: { id: 'R26', name: '概率权重扭曲', wired: true, where: 'dual' },
  R27: { id: 'R27', name: '框架效应', wired: true, where: 'dual' },
  R28: { id: 'R28', name: '替代', wired: true, where: 'domain' },
  R29: { id: 'R29', name: '认知放松', wired: true, where: 'dual' },
  R30: { id: 'R30', name: '自我损耗', wired: true, where: 'dual' },
  R31: { id: 'R31', name: '事后诸葛', wired: true, where: 'dual' },
  R32: { id: 'R32', name: '峰终定律', wired: true, where: 'channels' },
  R33: { id: 'R33', name: '狭窄框架', wired: true, where: 'dual' },
};

/**
 * 量纲约定 —— 钳位只有一处，在 `emotion.ts`：情绪存量 `clampEmotion` −1..1、
 * 驱力存量 `clampDrive` 0..1、对具体某个人的报复心 `clampRevenge` 0..1.5。
 * 本文件里的规律**一律通过 `nudge()` 改存量**，不自己写钳位，也不直接赋值 `mind.e`。
 *
 * 「消气要花时间」这件事由**衰减速率**（`relax` 读 `traits.decay`）负责，不再靠
 * 「让存量顶到 2」来实现：怒/思的 decay 小，所以一次 bad beat 顶到上限之后
 * 要好几局才落回基线；惊的 decay 大，一局就没了。
 * 报复心多留半格（1.5）是因为它是跨局的账，不是脸上的表情。
 */

/** 这个人身上这条规律有多重。缺省 1 = 常人；0 = 他没有这条毛病。 */
export function reg(t: Traits, r: Regularity): number {
  const v = t.regularities?.[r];
  return typeof v === 'number' ? v : 1;
}

/* --------------------------------------------------------- 一局的结算 */

/**
 * 一个决策局结束之后交给情绪层的事实。**领域无关**：
 * 炸金花的一手牌、一笔平仓的交易、一次谈判，折算出来都是这些字段。
 */
export interface Outcome {
  /** 净收益（正 = 赚），领域单位 */
  gain: number;
  /** 结算后的资产 */
  balance: number;
  /** 事前自己认为的成功概率 0..1 —— 系统 1 的 `feltStrength` 落下来的那个数 */
  expected: number;
  /** 归因到的对手（稳定键）。没有具体对手就留空 */
  by?: string;
  /** 我的判断被公开检验了（不是自己主动退出的） */
  exposed: boolean;
  /** 我主动退出了 */
  withdrew: boolean;
  /** 退出之后证明本来能赢（R10 懊悔） */
  regretted?: boolean;
  /** 我主动冒进并被当场证伪（R8 诈唬被抓） */
  overreached?: boolean;
  /**
   * 我退出之后，公开的结果让我看见**逼我退出的那个人其实是虚的**（R9）。
   * 归因对象是 `by`。
   */
  bluffedOut?: boolean;
  /** 被同一个对手用压力逼退（R14 面子的计数） */
  pressuredOut?: boolean;
  /** 这一局的规模，用于 R23 锚定 */
  scale: number;
}

/** 结算时哪几条规律真的推了一把，`trace` 与测试读它。 */
export interface SettleTrace {
  fired: Regularity[];
  surprise: number;
  magnitude: number;
}

/**
 * 一局的结果 → 五维评价（§4.9.1）。
 *
 * 「一局结束」在通用层已经有 `Outcome` 这个领域无关的类型了，不需要再让领域
 * 适配器把它翻译一遍 —— 那样同一件事就有两套评价代码（`settle` 里一套、
 * 适配器的 `hand_end` 分支一套），两边一漂移谁也说不清情绪是按哪一套动的。
 * 所以：**局中**事件走 `DomainAdapter.appraise`（领域才知道「被加档」是什么），
 * **结算**走这一个函数；两条都汇进同一张映射表 `appraisalToDeltas`。
 */
export function outcomeAppraisal(o: Outcome, mind: MindState): Appraisal {
  const won = o.gain > 0;
  return {
    valence: won ? 1 : o.gain < 0 ? -1 : 0,
    magnitude: magnitudeOf(Math.abs(o.gain), mind.refBalance || o.balance),
    // 意外 = 事前觉得自己会赢多少 vs 实际赢没赢
    expectancy: clamp01(Math.abs((won ? 1 : 0) - clamp01(o.expected))),
    agency: o.by ? 'other' : o.withdrew ? 'self' : 'luck',
    // 自己退出的是可控的；被公开检验后输掉的是不可控的
    controllability: o.withdrew ? 0.8 : o.exposed ? 0.2 : 0.5,
    by: o.by,
  };
}

/**
 * 一个决策局结束的情绪结算：先向基线衰减，再把这一局的评价加进去，
 * 最后跑一遍跨局规律。
 */
export function settle(mind: MindState, t: Traits, o: Outcome): SettleTrace {
  const fired: Regularity[] = [];
  const before = o.balance - o.gain;
  if (!mind.refBalance) mind.refBalance = before || o.balance || 1;
  mind.peakBalance = Math.max(mind.peakBalance, before, o.balance);

  relax(mind, t);

  const won = o.gain > 0;
  const a = outcomeAppraisal(o, mind);
  const magnitude = a.magnitude;
  const surprise = a.expectancy;
  // 结算情绪走的是和局中事件**同一张表**（`appraisalToDeltas`）、
  // 同一个写入口（`nudge`）。这里没有第二条改情绪的路径。
  applyAppraisal(mind, t, a);

  // R7 bad beat：我把判断亮出来了、事前觉得自己该赢、还是被具体的某个人吃掉
  if (!won && o.exposed && o.expected >= 0.5 && o.by) {
    const g = reg(t, 'R7') * t.tilt.gain;
    const bite = 0.6 * g * clamp01(0.35 + magnitude);
    nudge(mind, { e: { anger: bite, rumination: 0.35 * g }, revenge: 0.5 * g, by: o.by });
    fired.push('R7');
  }
  // R8 冒进被证伪：常人收紧几局
  if (o.overreached) {
    const g = reg(t, 'R8');
    nudge(mind, { e: { worry: 0.30 * g, anger: -0.15 * g }, d: { safety: 0.25 * g } });
    // 「被拆穿」还要留下记忆，不能只是一阵尴尬：`caught` 封顶 3，
    // 再被抓也不会更不敢 —— 人的收敛是有底的，不然打久了就再也不演了。
    mind.caught = Math.min(3, mind.caught + g);
    fired.push('R8');
  }
  /*
   * R9 被诈成功后知道了。
   *
   * 设计文档原本把触发写成「弃牌后对手**主动**亮诈唬牌」，本领域里没有「主动亮牌」
   * 这个动作，所以 P2 把它登记成 `wired: false`。但事件本身是有的，只是来路不同：
   * 我退出之后，他被别人比了牌、或者一路走到摊牌，结算把他那手牌**公开**了 ——
   * 我照样看见「原来他是虚的」，情绪与后效和原话完全一样。所以这里按公开结果接，
   * 触发条件写在领域侧（`settleMinds`），通用层只认「我被唬退了、唬我的是谁」。
   */
  if (o.bluffedOut && o.by) {
    const g = reg(t, 'R9');
    mind.bluffedBy[o.by] = Math.min(3, (mind.bluffedBy[o.by] ?? 0) + g);
    nudge(mind, { e: { anger: 0.20 * g }, d: { curiosity: 0.15 * g }, revenge: 0.15 * g, by: o.by });
    fired.push('R9');
  }
  // R10 懊悔：退出后发现本来能赢
  if (o.regretted) {
    nudge(mind, { e: { rumination: 0.30 * reg(t, 'R10') } });
    fired.push('R10');
  }

  // 连续输赢计数（R5 / R6 在通道层消费）
  if (won) { mind.winStreak += 1; mind.lossStreak = 0; }
  else if (o.gain < 0) { mind.lossStreak += 1; mind.winStreak = 0; }
  if (mind.lossStreak >= 3) fired.push('R5');
  if (mind.winStreak >= 3) fired.push('R6');

  // R13 无聊：连续放弃
  mind.idleStreak = o.withdrew ? mind.idleStreak + 1 : 0;
  const bored = clamp01(Math.max(0, mind.idleStreak - 2) * 0.05 * 2) * reg(t, 'R13');
  // 无聊是一个**水平**（由 `idleStreak` 完全决定），但写入口只有 `nudge()` 一个 ——
  // 所以这里把「设成这个水平」写成增量：目标 − 当前值。结果和直接赋值逐位相同，
  // 区别只在于全包里改存量的路径仍然只有一条（§4.10.2）。
  nudge(mind, { d: { boredom: bored - mind.d.boredom } });
  if (bored > 0.05) fired.push('R13');

  // R14 面子：被同一个人**连续**逼退
  if (o.pressuredOut && o.by) mind.pressedBy[o.by] = (mind.pressedBy[o.by] ?? 0) + 1;
  else if (o.by) mind.pressedBy[o.by] = 0;

  // R18 归因偏差：赢 = 我行（自信↑），输 = 运气不好（怒↑ 但不学习）
  const gR18 = reg(t, 'R18');
  if (won) nudge(mind, { d: { pride: 0.10 * magnitude * gR18 * 0.6 } });
  else if (o.gain < 0) nudge(mind, { e: { anger: 0.06 * magnitude * gR18 * 0.3 } });
  fired.push('R18');

  // R1 损失厌恶：低于参照点 → 忧
  const ref = referencePoint(mind, o.balance);
  const behind = clamp01((ref - o.balance) / Math.max(1, ref));
  if (behind > 0) {
    nudge(mind, { e: { worry: behind * 0.35 * reg(t, 'R1') } });
    fired.push('R1');
  }

  // R31 事后诸葛：判断被公开检验过、而且结果**跟事前想的一样**（意外度低），
  // 人就会记成「我就知道」，下一次更信直觉。注意这里不管输赢：
  // 「我早说了这把不行」和「我早说了这把稳」都一样让人更懒得算。
  if (o.exposed && surprise < 0.35) {
    mind.hindsight = clamp01(mind.hindsight + 0.05 * reg(t, 'R31'));
    fired.push('R31');
  }

  // R32 峰终定律：跟这个对手的这一次交手，按带符号强度记进长期印象。
  // 记的是「峰」和「终」，不是平均 —— `noteImpression` 只在更极端时换掉峰值。
  if (o.by) {
    noteImpression(mind, o.by, clamp((won ? 1 : -1) * magnitude, -1, 1) * reg(t, 'R32'));
    fired.push('R32');
  }

  couple(mind);

  // R30 自我损耗：意志力每局回一点
  mind.episodes += 1;
  mind.lastScale = o.scale;
  mind.willpower = Math.min(
    t.cognition.willpowerMax,
    mind.willpower + t.cognition.willpowerRecover,
  );
  return { fired, surprise, magnitude };
}

/* ------------------------------------------------------- 临场的规律 */

/** 临场规律要用到的量。**全部领域无关**，由适配器折算。 */
export interface Facts {
  /** 本局已投入占资产的比例（R4 沉没成本） */
  committed: number;
  /** 这一步要付出的占资产比例（R11 面对大注的怯） */
  atRisk: number;
  /** 现在的资产 */
  balance: number;
  /** 相对对手的资源位阶 −1（最短）..1（最大） */
  rank: number;
  /** 「还没去查看的持有」持续了多久，归一化 0..1（R16 禀赋效应） */
  unknownHeldFor: number;
  /** 本局规模相对上一局（R23 锚定），1 = 一样大 */
  scaleVsLast: number;
  /** 现在正在压我的那个对手的稳定键（R14 面子 / R32 印象） */
  counterpartKey?: string;
  /**
   * 我现在最记恨、而且**人就在场**的那个对手（R14 报复 / R9 被诈）。
   *
   * 和 `counterpartKey` 分开是必须的：压我的人和我恨的人经常不是同一个。
   * 领域侧原来只有「现在压我的那个人」这一个键，恨意于是常常算到了不相干的人头上，
   * 「对仇人放宽 0.1 分位」实测只放宽 0.009（`docs/zjh/personas.md`「待集成」#13）。
   * 而 R12「他整局都在演」、R32「他给我的印象」问的确实是**压我的那个人**，
   * 所以不能反过来把 `counterpartKey` 指向仇人，只能另开一个键。
   *
   * 领域侧负责判断「在场」；不在场的仇人不该影响这一手怎么打。
   */
  grudgeKey?: string;
  /**
   * 对手在这一局里把姿态做得多足（R12 好奇）：**持续施压 + 不肯交底**的程度，
   * 0..1。领域折算 —— 牌桌上是「不看就加、连着加」，交易里是「一路加仓不平」。
   */
  counterpartDisplay: number;
  /**
   * 我对自己这一手的把握（R12），0..1。**0.5 最难受**：好牌坏牌都不痒，
   * 只有不上不下的时候才会想花钱看个究竟。
   */
  ownCertainty: number;
  /**
   * 场面的热度（R19 情绪传染），0..1：周围人把赌注推到多大、多敢梭。
   * 它不是「我」的情绪，是**别人**的情绪在我身上的落点。
   */
  ambientHeat: number;
  /**
   * 场上有没有人在一路碾过来（R19 的后半句），0..1。
   * 有人连赢的时候，其余人不是变松而是变谨慎 —— 跟 `ambientHeat` 方向相反。
   */
  ambientRunaway: number;
}

/**
 * 把临场规律加到通道上。
 *
 * 每一条都是**连续量**：`atRisk` 越大越怕，不是「≥15% 就怕」；
 * `committed` 越多越难退出，不是「投了一半就不能退」。
 * 这正是用户要的「没有写死的门槛」的实现位置。
 */
export function situationalChannels(
  base: Channels, mind: MindState, t: Traits, f: Facts,
): { channels: Channels; fired: Regularity[] } {
  const ch = { ...base };
  const fired: Regularity[] = [];

  // R1 / R2：相对参照点的站位
  const ref = referencePoint(mind, f.balance);
  const behind = clamp01((ref - f.balance) / Math.max(1, ref));
  const ahead = clamp01((f.balance - ref) / Math.max(1, ref));
  if (behind > 0.01) {
    ch.risk += behind * 0.15 * reg(t, 'R1');
    ch.quitThreshold += behind * 0.10 * reg(t, 'R1');
    fired.push('R1');
  }
  if (ahead > 0.01) {
    ch.looseness += ahead * 0.10 * reg(t, 'R2');
    ch.delayInfo += ahead * 0.12 * reg(t, 'R2');
    fired.push('R2');
  }

  // R4 沉没成本
  const sunk = clamp01(f.committed) * 0.35 * reg(t, 'R4');
  if (sunk > 0.005) { ch.quitThreshold += sunk; fired.push('R4'); }

  // R5 赌徒谬误 / R6 热手
  const gambler = Math.min(0.25, Math.max(0, mind.lossStreak - 2) * 0.08) * reg(t, 'R5');
  if (gambler > 0) {
    ch.looseness += gambler;
    ch.delayInfo += gambler * 0.6;
    fired.push('R5');
  }
  const hot = Math.min(0.25, Math.max(0, mind.winStreak - 2) * 0.08) * reg(t, 'R6');
  if (hot > 0) { ch.aggression += hot; ch.risk += hot * 0.5; fired.push('R6'); }

  // R11 面对大注的怯 —— 与「代价/资产」成比例，怒会压住恐
  const scare = clamp01(f.atRisk / 0.15) * 0.4 * reg(t, 'R11');
  const scareNet = Math.max(0, scare - ch.tilt * 0.35);
  if (scareNet > 0.005) {
    ch.quitThreshold -= scareNet * 0.5;
    ch.aggression -= scareNet * 0.4;
    ch.delayInfo -= scareNet * 0.4;   // 怕了就想先看清楚
    ch.tempo -= scareNet * 0.2;       // 越怕越快
    fired.push('R11');
  }

  /*
   * R8 的**后效**（§4.9.4 R8 那一行的「通道」列：参与面、诈唬率，幅度 −0.15）。
   *
   * P2 只把 R8 接在 `settle()` 上：被拆穿的当场情绪动一下，下一手就什么也不剩，
   * 于是「被抓两次后一段时间不敢演」（§4.7「闷牌王」的破绽原话）没有任何着落 ——
   * 实测老王的诈唬率恒定 3.8%，被抓与否毫无后效。
   * 现在 `mind.caught` 是一个会衰减的计数（`settle` 里加、`relax` 里 ×0.90），
   * 这里把它读成「这几手他不敢造次」：参与面收、气焰收、求安抬。
   * 两次封顶（`/2` 之后夹在 1）—— 再多抓也不会更缩，人的收敛有底。
   */
  if (mind.caught > 0.05) {
    const shy = Math.min(1, mind.caught / 2) * reg(t, 'R8');
    ch.looseness -= shy * 0.15;
    ch.aggression -= shy * 0.15;
    ch.safety += shy * 0.12;
    fired.push('R8');
  }

  // R13 无聊：手痒
  const itch = clamp01(Math.max(0, mind.idleStreak - 4) * 0.05) * reg(t, 'R13');
  if (itch > 0) { ch.looseness += itch; fired.push('R13'); }

  // R14 面子：同一个人连续压我两次，第三次不退的概率明显上升
  if (f.counterpartKey) {
    const pressed = mind.pressedBy[f.counterpartKey] ?? 0;
    if (pressed >= 2) { ch.quitThreshold += 0.18 * reg(t, 'R14'); fired.push('R14'); }
  }
  // R14 报复 + R9 被诈：落点是**我恨的那个人**，不是现在压我的那个人
  if (f.grudgeKey) {
    const grudge = mind.revenge[f.grudgeKey] ?? 0;
    if (grudge > 0.02) {
      /**
       * 「恨意要经过人物卡」（`docs/zjh/personas.md`「待集成」#11）。
       *
       * 这两个系数原本是写死的常数，于是**任何**人物卡都拿不到比常人更强的记仇：
       * B 线定场景实测，同一段恨意注入打在复仇者身上和打在常人身上都是 +0.9 个点。
       * 一张以「记仇」为招牌的卡在这条分支上完全使不上劲。
       * 现在整条分支乘 `t.grudgeGain`（常人 1.0），复仇者的卡把它拉到 2 以上。
       *
       * 还补了一项 `looseness`：原话是「对那个人**范围放宽 0.1**」，
       * 而这条分支里原来没有任何东西直接放宽入池范围 —— `quitThreshold` 只管
       * 「已经进池之后弃不弃」，`aggression` 只管「凶不凶」，
       * 「更愿意跟他玩这一手」始终没人负责，所以 ③ 才只放宽了 0.009。
       */
      const gg = t.grudgeGain * reg(t, 'R14');
      ch.quitThreshold += grudge * 0.10 * gg;
      ch.aggression += grudge * 0.08 * gg;
      ch.looseness += grudge * 0.12 * gg;
      fired.push('R14');
    }
  }
  /*
   * R9「被诈成功后知道了」的后效（§4.9.4 R9 那一行逐字：通道「对该人的弃牌门槛」、
   * 幅度 +0.12、**仅对该人**）。落点是**现在压着我的那个人**：这条规律问的是
   * 「面前这个人上次唬过我，这一口我还退不退」，人不在我面前就无从谈起。
   *
   * `reg(t,'R9')` 允许取负 —— 和 R8 那行「天性偏向可反转为『加倍演』」同一个装置。
   * 数学型（§4.7「被诈唬成功后会记下这个人并收紧对他的范围」）就是负的那一侧：
   * 常人被唬过之后跟得更轻，他反而对这个人更严。
   */
  if (f.counterpartKey) {
    const bluffed = mind.bluffedBy[f.counterpartKey] ?? 0;
    if (bluffed > 0.05) {
      ch.quitThreshold += Math.min(1, bluffed) * 0.12 * reg(t, 'R9');
      fired.push('R9');
    }
  }

  // R15 资源位阶：怕大户，短码豁出去
  const rankUp = Math.max(0, f.rank);
  const rankDown = Math.max(0, -f.rank);
  if (rankUp > 0.02 || rankDown > 0.02) {
    ch.quitThreshold -= rankUp * 0.10 * reg(t, 'R15');
    ch.risk += rankDown * 0.10 * reg(t, 'R15');
    fired.push('R15');
  }

  // R16 未查看持有的幻想：越久越觉得自己手上的东西好，也就越不想去看
  const fantasy = clamp01(f.unknownHeldFor) * 0.09 * reg(t, 'R16');
  if (fantasy > 0) { ch.delayInfo += fantasy; fired.push('R16'); }

  // R23 锚定：上一局是个大的，这一局的小的「不值得打」
  const anchor = clamp(1 - f.scaleVsLast, -1, 1) * 0.05 * reg(t, 'R23');
  if (Math.abs(anchor) > 0.002) { ch.quitThreshold -= anchor; fired.push('R23'); }

  // R3 收官效应：这一场快打完了、人还落后 —— 「再不追就没机会了」。
  // 「快打完了」用的是通用的场次进度（`fatigueOf` = 本场已打的决策局 / 60），
  // 领域不必再传一个「还剩几手」进来。落后越多、越接近收官，越敢押。
  const closing = fatigueOf(mind) * behind * 0.20 * reg(t, 'R3');
  if (closing > 0.005) {
    ch.risk += closing;
    ch.aggression += closing * 0.5;   // 通道：风险偏好 + 梭哈发起
    ch.safety -= closing * 0.4;
    fired.push('R3');
  }

  // R12 花钱买信息：对面整局都在做戏，而我自己不上不下 —— 想看看他到底是什么。
  // 两头都是连续量：他演得越足越痒，我越接近「说不准」（把握 0.5）越痒。
  const itchy = clamp01(f.counterpartDisplay)
    * (1 - Math.abs(clamp01(f.ownCertainty) - 0.5) * 2) * 0.10 * reg(t, 'R12');
  if (itchy > 0.005) {
    ch.curiosity += itchy;
    ch.seekInfo += itchy * 0.5;
    fired.push('R12');
  }

  // R19 情绪传染：场面热 → 全桌变松、也更舍不得先交底；
  // 但有人在一路碾过来的时候，人反而缩起来（同一条规律的两头）。
  const heat = clamp01(f.ambientHeat) * reg(t, 'R19');
  const runaway = clamp01(f.ambientRunaway) * reg(t, 'R19');
  if (heat > 0.01 || runaway > 0.01) {
    ch.looseness += heat * 0.08 - runaway * 0.08;
    ch.delayInfo += heat * 0.06;
    ch.safety += runaway * 0.06;
    fired.push('R19');
  }

  // R22 情绪修复：悲/忧压着的时候，人想要的不是翻本，是**一个小而稳的赢** ——
  // 少碰边缘机会（参与面 −0.12），但一旦手上有货就早点收口（+0.10）。
  /*
   * 触发写的是「悲/忧**高**」，不是「悲/忧 > 0」。所以这里从 0.35 起坡（连续的斜坡，
   * 不是门槛）：小亏几笔谁都有点忧，那不叫「想要一个小而稳的赢」，
   * 那还是 R5 的追。两条规律方向相反，靠的就是这条起坡线分开 ——
   * 不分的话，连输之后 R22 会把 R5 的松整个抵掉（实测进场率 36.1% vs 36.0%）。
   */
  const lowMood = Math.max(0, mind.e.sorrow) * 0.6 + Math.max(0, mind.e.worry) * 0.4;
  const blue = clamp01((lowMood - 0.35) / 0.65) * reg(t, 'R22');
  if (blue > 0.01) {
    ch.looseness -= blue * 0.12;
    ch.safety += blue * 0.10;
    ch.greed -= blue * 0.08;
    ch.seekInfo += blue * 0.10;   // 「收口快」= 早点把不确定性了结掉
    fired.push('R22');
  }

  // R32 峰终定律：对现在压我的这个人的长期印象（峰 0.5 + 终 0.3）。
  // 在他手上吃过最狠的那一刀会一直留着 —— 印象越痛，越容易在他面前退。
  const imp = impressionOf(mind, f.counterpartKey) * reg(t, 'R32');
  if (Math.abs(imp) > 0.01) {
    ch.quitThreshold += imp * 0.12;
    ch.safety -= imp * 0.08;
    fired.push('R32');
  }

  // R21 唤醒 → 冒险
  ch.risk += ch.arousal * 0.10 * reg(t, 'R21');
  ch.tempo -= ch.arousal * 0.15 * reg(t, 'R21');
  // 临场规律也是加法，加完同样要过唯一的那一道钳位（`clampChannels`，见 emotion.ts）
  return { channels: clampChannels(ch), fired };
}
