/**
 * 通用人性底层 · 双系统决策核（设计文档 §4.9.7 / §4.10.2）。
 *
 * 每一个动作都先由**系统 1** 给出直觉冲动；**系统 2** 只在有能力、有必要、
 * 有余力的时候介入；介入之后也不一定赢 —— 只有当它算出来的结论比冲动好过
 * `selfControl` 决定的那道坎，才推翻冲动，否则人会「合理化」自己的冲动。
 *
 * 这就是「决策的形状」：`decide()` 是唯一入口，谁都别想在别处塞一句
 * `if (某个量 >= 常数) return 某个动作` —— 那种短路在这套结构里没有位置。
 */

import {
  type Channels, type Drives, type Emotions, type MindState,
  arousalOf, clamp, clamp01, cloneMind, easeOf, emotionChannels, fatigueOf, tiltOf,
} from './emotion.ts';
import type { DomainAdapter, Impulse, Scored } from './adapter.ts';
import { type Regularity, reg } from './regularities.ts';
import type { Traits } from './traits.ts';

/** 决策留下的痕迹：这一步是直觉还是深思、被哪条规律推了、当时情绪是什么。 */
export interface DecisionTrace<A> {
  system: 's1' | 's2';
  /** 系统 2 的介入概率 */
  p2: number;
  engaged: boolean;
  /** 系统 2 介入了，并且真的推翻了冲动 */
  overridden: boolean;
  impulse: { key: string; confidence: number; feltStrength: number; feltThreat: number };
  deliberate?: {
    key: string; score: number; difficulty: number;
    /** true = 这个最优解是**离线对照**算出来的，当事人并没有真的算（不扣意志力、不影响动作） */
    probed?: boolean;
  };
  /** 系统 2 认为最优的那个比冲动好多少 */
  gap: number;
  /** 推翻冲动需要好多少（由 selfControl 决定） */
  need: number;
  /**
   * 最终动作偏离系统 2 最优解了吗 —— §4.9.4 的「偏离率」就是数这个。
   *
   * `undefined` = **这一步没有对照**：他没开系统 2，也没人替他离线算一次，
   * 所以「偏没偏」根本不知道。以前这里在没开系统 2 时直接写 `true`，
   * 于是「偏离率」只是 `1 − 介入率` 的同义反复。要量真实偏离率就打开
   * `setDeliberateProbe(true)`，让每一步都有一个系统 2 的最优解做对照。
   */
  deviated?: boolean;
  emotions: Emotions;
  drives: Drives;
  tilt: number;
  ease: number;
  arousal: number;
  fatigue: number;
  willpower: number;
  fired: Regularity[];
  action: A;
}

export interface Decision<A> {
  action: A;
  thinkMs: number;
  mind: MindState;
  trace: DecisionTrace<A>;
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/* ------------------------------------------- 离线对照：真实偏离率的度量开关 */

let probing = false;

/**
 * 打开/关闭**离线对照**（§4.9.4 的偏离率）。
 *
 * 打开之后，没有开系统 2 的决策也会额外算一次 `adapter.deliberate()` 当对照：
 * **不扣意志力、不改心境、不影响动作与用时**，只把「系统 2 本来会选什么」
 * 写进 `trace.deliberate`（带 `probed: true`）并据此填 `trace.deviated`。
 *
 * 线上默认关 —— `deliberate()` 是这套模型里最贵的一步，为了统计让每个人每一步
 * 都白算一遍不值当。测试和复盘脚本打开它来量真实偏离率。
 */
export function setDeliberateProbe(on: boolean): void { probing = on; }

/** 离线对照现在开着吗 */
export function deliberateProbe(): boolean { return probing; }

/**
 * Prelec 概率权重函数（R26）：`π(p) = exp(−(−ln p)^α)`。
 * 常人 α = 0.65 —— 高估小概率、低估中等概率。这是「差牌接梭哈」的来源，
 * 也是「放弃中等胜率的价值动作」的来源。
 */
export function probWeight(p: number, alpha: number): number {
  const q = Math.min(1 - 1e-6, Math.max(1e-6, p));
  return Math.exp(-Math.pow(-Math.log(q), alpha));
}

/**
 * 框架效应（R27）：同一个「继续投入」的动作，在低于参照点时被框成「追回」，
 * 高于参照点时被框成「守住」。返回加到「继续」类动作价值上的位移。
 */
export function framingBias(standing: number, t: Traits): number {
  return -clamp(standing, -1, 1) * 0.08 * reg(t, 'R27');
}

/**
 * 从直觉打分里**采样**出一个冲动（不是取最大值）。
 *
 * 人不是每次都做同一件事。同一个人、同一个局面，今天跟、明天弃、偶尔顶一手 ——
 * 这不是噪声，这是混合策略：他自己也说不清为什么这一把想诈一下。
 * 取 argmax 的模型永远是同一个动作，那不是人，那是查表。
 *
 * 温度 `temperature` 就是「这个人有多不一致」：越高越随性，越低越像机器。
 * 情绪唤醒和陌生的局面都会把它抬起来 —— 上头的人和第一次坐这张桌的人都更飘。
 * 领域侧算好温度传进来，通用层只负责按 softmax 抽一个。
 */
export function softPick<A>(
  scores: Scored<A>[], rng: (purpose: string) => number, temperature: number, purpose = 's1',
): Scored<A> {
  const live = scores.filter((s) => Number.isFinite(s.score));
  if (!live.length) return scores[0];
  const tau = Math.max(1e-3, temperature);
  let top = -Infinity;
  for (const s of live) if (s.score > top) top = s.score;
  const w = live.map((s) => Math.exp((s.score - top) / tau));
  const sum = w.reduce((a, b) => a + b, 0);
  let r = clamp01(rng(purpose)) * sum;
  for (let i = 0; i < live.length; i++) {
    r -= w[i];
    if (r <= 0) return live[i];
  }
  return live[live.length - 1];
}

/** 找一个 key 在打分表里的分。找不到按最低分算。 */
function scoreOf<A>(scores: Scored<A>[], key: string): number {
  const hit = scores.find((s) => s.key === key);
  if (hit) return hit.score;
  return scores.length ? Math.min(...scores.map((s) => s.score)) : 0;
}

/** 系统 1 的通道（只依赖情绪，不依赖领域）。领域自己会再叠临场规律。 */
export function baseChannels(mind: MindState, t: Traits): Channels {
  return emotionChannels(mind, t);
}

/**
 * 系统 2 的介入概率（§4.9.7 的 p2 公式）。
 *
 * `p2 = σ( needForCognition + 赌注 + (1 − 笃定) − 唤醒 − 疲劳 − 时间压力 − 熟悉 )`
 * 赌注大、直觉不笃定 → 更可能停下来算；情绪唤醒高、累了、时间紧、局面太熟 →
 * 直接听系统 1。意志力见底（R30）时再打一次折。
 */
export function engageProbability(
  mind: MindState, t: Traits,
  input: { stakes: number; timePressure: number; familiarity: number; confidence: number },
): number {
  const arousal = arousalOf(mind);
  const fatigue = fatigueOf(mind) * reg(t, 'R20');
  const z = -0.60
    // R31 事后诸葛：「我就知道」直接从思考倾向里扣 —— 越觉得自己看得准，
    // 越懒得停下来算。`hindsight` 的量纲就是 `needForCognition`（每次印证 +0.05）。
    + (t.cognition.needForCognition - clamp01(mind.hindsight) * reg(t, 'R31')) * 1.60
    + clamp01(input.stakes) * 1.40
    + (1 - clamp01(input.confidence)) * 1.20
    - arousal * 1.80
    - fatigue * 0.80
    - clamp01(input.timePressure) * 1.00
    - (clamp01(input.familiarity) - 0.5) * 0.60 * reg(t, 'R29');
  const depletion = clamp01(1 - mind.willpower / Math.max(1, t.cognition.willpowerMax));
  return clamp01(sigmoid(z) * (1 - 0.6 * depletion * reg(t, 'R30')));
}

/**
 * 唯一入口（§4.10.2）。
 *
 * `rng(purpose)` 由领域提供，必须只由**公开状态**做种：这样同一个局面永远走出
 * 同一条路，决策可复测，也不会因为改了别人的暗牌而改变。
 */
export function decide<S, A, E>(
  adapter: DomainAdapter<S, A, E>,
  ctx: S,
  mindIn: MindState,
  traits: Traits,
  rng: (purpose: string) => number = () => 0.5,
  fired: Regularity[] = [],
): Decision<A> {
  const mind = cloneMind(mindIn);
  const features = adapter.coarse(ctx, mind);
  const impulse: Impulse<A> = adapter.intuition(features, mind, traits);
  const st = adapter.stakes(ctx, mind);

  const p2 = engageProbability(mind, traits, { ...st, confidence: impulse.confidence });
  mind.s2Chances += 1;
  const engaged = rng('system2') < p2 && mind.willpower > 0;

  let action = impulse.action;
  let key = impulse.key;
  let overridden = false;
  let gap = 0;
  let deliberateInfo: DecisionTrace<A>['deliberate'];
  let difficulty = 0;
  let deviated: boolean | undefined;

  // 推翻冲动需要「好多少」：自控越高，这道坎越低（§4.9.7）
  const need = 0.02 + (1 - clamp01(traits.cognition.selfControl)) * 0.25;

  if (engaged) {
    mind.s2Calls += 1;
    mind.willpower = Math.max(0, mind.willpower - traits.cognition.willpowerCost);
    const d = adapter.deliberate(ctx, mind, traits);
    difficulty = clamp01(d.difficulty);
    gap = scoreOf(d.scores, d.bestKey) - scoreOf(d.scores, impulse.key);
    deliberateInfo = { key: d.bestKey, score: scoreOf(d.scores, d.bestKey), difficulty };
    if (gap > need) {
      action = d.best;
      key = d.bestKey;
      overridden = true;
    }
    // 系统 2 开过账还是走了冲动 = 合理化（R18 归因、确认偏差在这里起作用）
    deviated = key !== d.bestKey;
    fired.push('R30');
  } else if (probing) {
    // 他没算，我们替他离线算一次当对照：用决策前那份心境的**副本**，
    // 不扣意志力、不改 mind、不进入 action / thinkMs —— 只为知道「偏没偏」。
    const probe = adapter.deliberate(ctx, cloneMind(mind), traits);
    gap = scoreOf(probe.scores, probe.bestKey) - scoreOf(probe.scores, impulse.key);
    deliberateInfo = {
      key: probe.bestKey, score: scoreOf(probe.scores, probe.bestKey),
      difficulty: clamp01(probe.difficulty), probed: true,
    };
    deviated = key !== probe.bestKey;
  }
  // 没开系统 2 又没有对照 → deviated 留 undefined：不知道就是不知道，不许默认算偏离。

  const arousal = arousalOf(mind);
  const tempoBias = baseChannels(mind, traits).tempo;
  const jitter = rng('tempo');
  let thinkMs = traits.tempo.baseMs * (0.75 + jitter * traits.tempo.jitter);
  if (engaged) {
    thinkMs += traits.tempo.deliberateMs * Math.pow(difficulty, 1.35)
      * (1 - arousal * 0.40) * (1 + tempoBias * 0.5);
  }
  thinkMs = Math.max(160, thinkMs);

  const trace: DecisionTrace<A> = {
    system: engaged ? 's2' : 's1',
    p2, engaged, overridden,
    impulse: {
      key: impulse.key, confidence: impulse.confidence,
      feltStrength: impulse.feltStrength, feltThreat: impulse.feltThreat,
    },
    deliberate: deliberateInfo,
    gap, need, deviated,
    emotions: { ...mind.e },
    drives: { ...mind.d },
    tilt: tiltOf(mind), ease: easeOf(mind), arousal, fatigue: fatigueOf(mind),
    willpower: mind.willpower,
    fired: [...fired],
    action,
  };
  return { action, thinkMs: Math.round(thinkMs), mind, trace };
}
