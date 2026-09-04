/**
 * 通用人性底层 · 情绪与评价（设计文档 §4.9.1 / §4.10.1）。
 *
 * **这个文件里不允许出现任何领域词汇。** 没有牌、没有底池、没有轮次、没有单价；
 * 只有「相对参照点的收益」「事前概率与结果的偏差」「归因」「可控性」「唤醒度」
 * 这些任何领域都成立的量（§4.10.3）。炸金花把牌局折算成这些量，股票可以把
 * 一笔持仓的浮亏折算成同样的量 —— 两边共用同一套人。
 *
 * 三件事：
 *  1. 一件事发生了，人先**评价**它（appraisal 五维）；
 *  2. 评价经过**同一张通用映射表**变成情绪 `E_t` 与驱力 `D_t` 的增量；
 *  3. `E_t, D_t` 经过**表达通道**变成决策里的连续调制量。
 *
 * 个人差异全部由 `traits.ts` 的 `Traits` 承担：基线、敏感度、衰减、表达增益、
 * 规律系数。同一段代码换一张特征表就是另一个人。
 */

import type { Traits } from './traits.ts';

export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** 七情。 */
export interface Emotions {
  joy: number; anger: number; worry: number; rumination: number;
  sorrow: number; fear: number; surprise: number;
}

/** 驱力。`revenge` 指向具体的人，按对手键单独存在 `MindState.revenge`。 */
export interface Drives {
  greed: number; pride: number; safety: number; curiosity: number; boredom: number;
}

/**
 * 表达通道：情绪 → 决策的连续调制量（§4.9.1「表达通道」）。
 * 全部是**加权项**，不是开关，也不是门槛。
 */
export interface ChannelGains {
  /** 进攻性：主动施压、把赌注推大 */
  aggression: number;
  /** 退出门槛：正数 = 更难放弃 */
  quitThreshold: number;
  /** 推迟获取信息（保持不确定的偏好） */
  delayInfo: number;
  /** 提前获取信息 */
  seekInfo: number;
  /** 用时的位移：正数 = 想得更久 */
  tempo: number;
  /** 参与面：边缘机会打不打 */
  looseness: number;
  /** 贪：想吃大的 */
  greed: number;
  /** 求安：保本 */
  safety: number;
  /** 炫耀 / 公开自己的判断 */
  showoff: number;
  /** 更轻地跟进（懊悔之后的补偿） */
  callLighter: number;
}

export const EMOTION_KEYS = [
  'joy', 'anger', 'worry', 'rumination', 'sorrow', 'fear', 'surprise',
] as const satisfies readonly (keyof Emotions)[];

export const DRIVE_KEYS = [
  'greed', 'pride', 'safety', 'curiosity', 'boredom',
] as const satisfies readonly (keyof Drives)[];

/* --------------------------------------------------------------- 状态 */

/**
 * 一个人当下的心理状态：`E_t`、`D_t`，加上跨局才有意义的那几个量
 * （参照点、连续输赢、意志力预算、社会性计数）。领域负责把它存下来。
 */
export interface MindState {
  e: Emotions;
  d: Drives;
  /** 报复心，按对手的稳定键存 */
  revenge: Record<string, number>;
  /** 同一个对手**连续**把我逼退了几次（社会性重复交互，R14） */
  pressedBy: Record<string, number>;
  /**
   * 我装出来的东西被当场拆穿过几次（R8「诈唬被抓」的计数版）。
   *
   * R8 本来只有一次性的情绪反应（尴尬、收紧几手），没有留下**记忆** ——
   * 于是「被抓两次之后一段时间不敢演」这条人设无处可挂。这个数每局向 0 衰减，
   * 消费方是领域侧的表演强度与诈唬线权重（`tempo.ts` / `plan.ts`）。
   */
  caught: number;
  /**
   * 被**这个人**唬退过几次（R9「被诈成功后知道了」，按对手的稳定键存）。
   *
   * 触发是「我退出之后，公开的结果让我看见他其实是虚的」。
   */
  bluffedBy: Record<string, number>;
  lossStreak: number;
  winStreak: number;
  /** 连续放弃的次数（R13 无聊） */
  idleStreak: number;
  /** 本场做过多少次决策局（R20 疲劳） */
  episodes: number;
  /** 意志力预算（R30 自我损耗） */
  willpower: number;
  /** 参照点：本场起始与峰值（R1 损失厌恶 / R27 框架） */
  refBalance: number;
  peakBalance: number;
  /** 上一局的规模（R23 锚定） */
  lastScale: number;
  /**
   * 「我就知道」的累积（R31 事后诸葛）。摊牌结果印证了事前判断就涨一点，
   * 每局向 0 衰减。**它的量纲就是 `needForCognition`**：`engageProbability`
   * 直接把它从思考倾向里减掉 —— 越觉得自己看得准，越懒得停下来算。
   */
  hindsight: number;
  /**
   * 对某个对手的长期印象（R32 峰终定律），按稳定键存。
   * `peak` = 跟他打过的所有局里**最强烈**的那一次的带符号强度（−1 最痛、+1 最爽），
   * `last` = 最后一次。长期印象读的是这两个数（`impressionOf`），
   * **不是**平均值 —— 人对一个人的记忆本来就由最极端的一次和最近一次主导。
   */
  impression: Record<string, { peak: number; last: number }>;
  /** 系统 2 的介入统计，给分析与测试用 */
  s2Calls: number;
  s2Chances: number;
}

export function zeroEmotions(): Emotions {
  return { joy: 0, anger: 0, worry: 0, rumination: 0, sorrow: 0, fear: 0, surprise: 0 };
}

export function newMind(t?: Traits): MindState {
  return {
    e: t ? { ...t.baseline } : zeroEmotions(),
    d: t ? { ...t.drives } : { greed: 0, pride: 0, safety: 0, curiosity: 0, boredom: 0 },
    revenge: {}, pressedBy: {}, caught: 0, bluffedBy: {},
    lossStreak: 0, winStreak: 0, idleStreak: 0, episodes: 0,
    willpower: t?.cognition.willpowerMax ?? 6,
    refBalance: 0, peakBalance: 0, lastScale: 0,
    hindsight: 0, impression: {},
    s2Calls: 0, s2Chances: 0,
  };
}

/** 读状态并补齐缺失字段 —— 旧的持久化快照里没有这一层。 */
export function readMind(raw: unknown, t?: Traits): MindState {
  const base = newMind(t);
  if (!raw || typeof raw !== 'object') return base;
  const s = raw as Partial<MindState>;
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  // 旧快照里可能存着按老上限（报复 3、驱力 2）写下的存量 —— 读进来一律按
  // 现在唯一的那套钳位收一遍，不然新代码会拿到一个它自己永远产不出的数。
  const e = { ...base.e };
  for (const k of EMOTION_KEYS) e[k] = clampEmotion(num(s.e?.[k], base.e[k]));
  const d = { ...base.d };
  for (const k of DRIVE_KEYS) d[k] = clampDrive(num(s.d?.[k], base.d[k]));
  const revenge: Record<string, number> = {};
  for (const [k, v] of Object.entries(s.revenge ?? {})) {
    if (typeof v === 'number' && Number.isFinite(v)) revenge[k] = clampRevenge(v);
  }
  return {
    e, d,
    revenge,
    pressedBy: { ...(s.pressedBy ?? {}) },
    caught: Math.max(0, num(s.caught, 0)),
    bluffedBy: { ...(s.bluffedBy ?? {}) },
    lossStreak: num(s.lossStreak, 0),
    winStreak: num(s.winStreak, 0),
    idleStreak: num(s.idleStreak, 0),
    episodes: num(s.episodes, 0),
    willpower: num(s.willpower, base.willpower),
    refBalance: num(s.refBalance, 0),
    peakBalance: num(s.peakBalance, 0),
    lastScale: num(s.lastScale, 0),
    hindsight: clamp01(num(s.hindsight, 0)),
    impression: Object.fromEntries(
      Object.entries(s.impression ?? {})
        .filter(([, v]) => v && typeof v === 'object')
        .map(([k, v]) => [k, {
          peak: clamp(num((v as { peak?: number }).peak, 0), -1, 1),
          last: clamp(num((v as { last?: number }).last, 0), -1, 1),
        }]),
    ),
    s2Calls: num(s.s2Calls, 0),
    s2Chances: num(s.s2Chances, 0),
  };
}

export function cloneMind(m: MindState): MindState {
  return {
    e: { ...m.e }, d: { ...m.d },
    revenge: { ...m.revenge }, pressedBy: { ...m.pressedBy },
    caught: m.caught, bluffedBy: { ...m.bluffedBy },
    lossStreak: m.lossStreak, winStreak: m.winStreak, idleStreak: m.idleStreak,
    episodes: m.episodes, willpower: m.willpower,
    refBalance: m.refBalance, peakBalance: m.peakBalance, lastScale: m.lastScale,
    hindsight: m.hindsight,
    impression: Object.fromEntries(
      Object.entries(m.impression).map(([k, v]) => [k, { ...v }]),
    ),
    s2Calls: m.s2Calls, s2Chances: m.s2Chances,
  };
}

/* ----------------------------------------------------------- 评价与映射 */

/** 一个事件的五维评价（§4.9.1）。领域适配器的 `appraise` 产出这个。 */
export interface Appraisal {
  /** 好坏 −1..1 */
  valence: number;
  /** 相对参照点的大小 0..1（对数尺度） */
  magnitude: number;
  /** 意外程度 0..1（事前概率与结果的偏差） */
  expectancy: number;
  /** 归因：自己 / 某个对手 / 运气 */
  agency: 'self' | 'other' | 'luck';
  /** 可控性 0..1 */
  controllability: number;
  /** 归因到人时，那个人的稳定键 */
  by?: string;
}

/** 钱是按对数感知的，不是线性。相对参照点折算成 0..1 的「大小感觉」。 */
export function magnitudeOf(amount: number, reference: number): number {
  const ref = Math.max(1, reference);
  return clamp01(Math.log1p(Math.max(0, amount) / ref * 4) / Math.log1p(4));
}

/**
 * 通用映射表：一份评价 → 情绪与驱力的增量。
 *
 * 所有人共用这一张表；个人差别只来自 `sensitivity`。
 * 「大 × 坏 × 意外 × 别人造成 → 怒↑ 思↑ 报复↑」对谁都成立，
 * 区别只在同一件事在谁心里更大。
 */
export function appraisalToDeltas(
  a: Appraisal, t: Traits,
): { e: Partial<Emotions>; d: Partial<Drives>; revenge: number } {
  const s = t.sensitivity;
  const m = clamp01(a.magnitude) * s.magnitude;
  const x = clamp01(a.expectancy) * s.expectancy;
  const good = Math.max(0, a.valence) * s.valence;
  const bad = Math.max(0, -a.valence) * s.valence;
  const byOther = a.agency === 'other' ? s.agency : 0;
  const bySelf = a.agency === 'self' ? s.agency : 0;
  const byLuck = a.agency === 'luck' ? s.agency : 0;
  const helpless = (1 - clamp01(a.controllability)) * s.controllability;

  const e: Partial<Emotions> = {};
  const d: Partial<Drives> = {};
  const add = (k: keyof Emotions, v: number) => { e[k] = (e[k] ?? 0) + v; };
  const addD = (k: keyof Drives, v: number) => { d[k] = (d[k] ?? 0) + v; };

  // 坏事：被人弄疼 → 怒 + 思 + 报复；运气不好 → 悲 + 忧；自己判断错 → 思 + 忧
  add('anger', bad * m * (0.45 + 0.55 * x) * byOther);
  add('rumination', bad * m * (0.30 + 0.50 * x) * (byOther + bySelf * 1.2));
  add('sorrow', bad * m * (0.35 + 0.40 * helpless) * (byLuck + byOther * 0.4));
  add('worry', bad * m * (0.30 + 0.35 * helpless));
  add('fear', bad * m * 0.20 * helpless);
  addD('safety', bad * m * 0.25);

  // 好事：喜 + 贪，恐下降
  add('joy', good * m * (0.85 + 0.30 * x));
  add('fear', -good * m * 0.35);
  add('sorrow', -good * m * 0.30);
  addD('greed', good * m * 0.45);
  addD('pride', good * m * 0.25 * (bySelf + byOther * 0.5));

  // 意外本身就是一种情绪
  add('surprise', x * (0.55 + 0.45 * m));
  addD('curiosity', x * 0.25);

  const revenge = bad * m * (0.40 + 0.60 * x) * byOther;
  return { e, d, revenge };
}

/* --------------------------------------------------- 情绪存量的唯一写入口 */

/**
 * 存量的钳位 —— **每个量只有这一个钳位函数，全包引用它**。
 *
 * 以前 `regularities.ts` 里同一个量在不同地方钳到不同的上限（报复钳到 3、
 * 安全感/骄傲/无聊钳到 2、别处钳到 1），于是「这个量最大能有多大」这个问题
 * 没有答案，读代码的人也没法判断某条规律是不是把某个量顶爆了。现在只有这里说了算。
 *
 * 量纲：情绪存量 −1..1，驱力存量 0..1，对具体某个人的报复心 0..1.5
 * （报复比别的驱力多留半格：「还没消气」是一个比「他现在有多凶」更长的量，
 * 消气要花几局，所以它的上限高于表达层能表达的范围）。
 * **表达**层的钳位不在这里，在 `clampChannels`（同一个文件，同一条规矩：
 * 一个量只有一个钳位函数，全包都引它）。
 */
export const clampEmotion = (v: number) => clamp(v, -1, 1);
export const clampDrive = (v: number) => clamp(v, 0, 1);
export const clampRevenge = (v: number) => clamp(v, 0, 1.5);

/** 一次情绪增量。`revenge` 要配 `by` 才落得下去。 */
export interface MindDelta {
  e?: Partial<Emotions>;
  d?: Partial<Drives>;
  revenge?: number;
  by?: string;
}

/**
 * **改情绪只有这一个函数。** 通用映射表（`applyAppraisal`）和跨局规律
 * （`regularities.ts` 里的 R7/R8/…）都从这里走，没有第二条路径直接写 `mind.e`。
 */
export function nudge(mind: MindState, delta: MindDelta, gain = 1): void {
  if (delta.e) {
    for (const k of EMOTION_KEYS) {
      const v = delta.e[k];
      if (v) mind.e[k] = clampEmotion(mind.e[k] + v * gain);
    }
  }
  if (delta.d) {
    for (const k of DRIVE_KEYS) {
      const v = delta.d[k];
      if (v) mind.d[k] = clampDrive(mind.d[k] + v * gain);
    }
  }
  if (delta.revenge && delta.by) {
    mind.revenge[delta.by] = clampRevenge((mind.revenge[delta.by] ?? 0) + delta.revenge * gain);
  }
}

/** 把一份评价落进状态里：通用映射表 → `nudge`。 */
export function applyAppraisal(mind: MindState, t: Traits, a: Appraisal, gain = 1): void {
  const { e, d, revenge } = appraisalToDeltas(a, t);
  nudge(mind, { e, d, revenge, by: a.by }, gain);
}

/** 每一局结束向基线衰减 —— 各维度速率不同：怒/思慢，惊快（§4.9.1 动力学）。 */
export function relax(mind: MindState, t: Traits): void {
  for (const k of EMOTION_KEYS) {
    mind.e[k] += (t.baseline[k] - mind.e[k]) * clamp01(t.decay[k]);
  }
  for (const k of DRIVE_KEYS) {
    const rate = k === 'boredom' ? clamp01(t.decay.boredom) : 0.3;
    mind.d[k] += (t.drives[k] - mind.d[k]) * rate;
  }
  for (const [k, v] of Object.entries(mind.revenge)) {
    const next = v * (1 - clamp01(t.decay.revenge));
    if (next < 0.02) delete mind.revenge[k]; else mind.revenge[k] = next;
  }
  // 「我就知道」跟情绪一样会淡：不淡的话打满一场之后谁都不再算账了（R31）。
  mind.hindsight = clamp01(mind.hindsight * 0.85);
  /*
   * 「被拆穿」的记忆也会淡，但比情绪慢得多：R8 的原话是「常人收紧 2–3 手」，
   * 而 §4.7.3 闷牌王那一行写的是「被抓两次后**一段时间**不敢演」——
   * 一次性的情绪波动做不出「一段时间」。0.90 的半衰期约 7 手：
   * 被抓一次收敛得快，连着被抓两次才压得住，之后自己恢复。
   */
  mind.caught = mind.caught > 0.02 ? mind.caught * 0.90 : 0;
  // 「他唬过我」淡得更慢：R9 的作用域是「对该人」，跨局的人物印象本来就比情绪耐久。
  for (const [k, v] of Object.entries(mind.bluffedBy)) {
    const next = v * 0.94;
    if (next < 0.05) delete mind.bluffedBy[k]; else mind.bluffedBy[k] = next;
  }
}

/* --------------------------------------------------- R32 峰终定律的印象 */

/**
 * 把这一次跟某个对手的交手记进长期印象（R32 峰终定律）。
 *
 * `v` 是带符号的强度（−1 最痛、+1 最爽），领域折算。**只有更极端的一次会换掉
 * `peak`**，平均值一概不存 —— 这条规律说的就是「人记住的是最极端的一次和最后一次」。
 */
export function noteImpression(mind: MindState, key: string, v: number): void {
  const x = clamp(v, -1, 1);
  const slot = mind.impression[key] ??= { peak: 0, last: 0 };
  if (Math.abs(x) > Math.abs(slot.peak)) slot.peak = x;
  slot.last = x;
}

/** 对某个对手的长期印象：峰 0.5 + 终 0.3（§4.9.8 R32 的常人强度）。 */
export function impressionOf(mind: MindState, key: string | undefined): number {
  if (!key) return 0;
  const slot = mind.impression[key];
  return slot ? clamp(slot.peak * 0.5 + slot.last * 0.3, -1, 1) : 0;
}

/** 维度耦合：怒压恐、悲抬忧、喜抬贪（§4.9.1 动力学）。 */
export function couple(mind: MindState): void {
  mind.e.fear = clampEmotion(mind.e.fear - Math.max(0, mind.e.anger) * 0.35);
  mind.e.worry = clampEmotion(mind.e.worry + Math.max(0, mind.e.sorrow) * 0.30);
  mind.d.greed = clampDrive(mind.d.greed + Math.max(0, mind.e.joy) * 0.20);
}

/* --------------------------------------------------------------- 派生量 */

/** 上头 = 怒 + 思。 */
export function tiltOf(m: MindState): number {
  return clamp(Math.max(0, m.e.anger) * 0.7 + Math.max(0, m.e.rumination) * 0.5, 0, 1);
}
/** 宽裕 = 喜。 */
export function easeOf(m: MindState): number {
  return clamp(Math.max(0, m.e.joy), 0, 1);
}
/** 唤醒度：情绪总强度，无论喜怒（R21）。 */
export function arousalOf(m: MindState): number {
  return clamp01((
    Math.abs(m.e.anger) + Math.abs(m.e.joy) + Math.abs(m.e.fear)
    + Math.abs(m.e.sorrow) + Math.abs(m.e.surprise) * 0.6 + Math.abs(m.e.worry) * 0.6
  ) / 3);
}
/** 参照点 = 起始 0.6 + 峰值 0.4（R1）。 */
export function referencePoint(m: MindState, fallback: number): number {
  const start = m.refBalance || fallback;
  const peak = m.peakBalance || fallback;
  return start * 0.6 + peak * 0.4;
}
/** 相对参照点的站位 −1（输惨了）..1（大幅领先）。 */
export function standingOf(m: MindState, balance: number): number {
  const ref = referencePoint(m, balance);
  return clamp((balance - ref) / Math.max(1, ref), -1, 1);
}

/**
 * 表达通道的钳位（§4.9.6）—— **通道这一层唯一的钳位函数**。
 *
 * 存量（情绪、驱力）在 `clampEmotion`/`clampDrive` 那里就已经有界了，可通道不是存量：
 * 它是**很多条**加法的和 —— `emotionChannels` 把七种情绪各自的表达系数叠起来，
 * `situationalChannels` 再往上叠十几条临场规律（R1 输着、R4 沉没成本、R14 被连压……）。
 * 每一条都只加自己那一点，谁也没越界，加完却可以越界：实测 `quitThreshold` 打到第
 * 四、五轮时均值是 **1.07**，而领域适配器给它的系数是 2.20 —— 这一项自己就给弃牌
 * 压了 −2.4 分，而整个牌力信号（`(need − felt) * 1.60`）的幅度只有 ±0.3。
 * 情绪于是不再是「改尺子」，它**替代**了尺子：机器人 83% 的局最后还是弃了，
 * 只是每次都晚两条街才弃（弃牌时已投入 165k，对照组 113k）。
 *
 * 量纲：`ChannelGains` 的十项是**有符号**的推力，各自 −1..1（一个人可以「越气越
 * 难退出」，也可以「越气越紧」，所以负半轴是有意义的，不能用 `clamp01`）；
 * 派生的四项（`tilt`/`ease`/`arousal`/`fatigue`）本来就是 0..1 的读数，
 * 这里一并过一遍，保证「通道的取值范围」这个问题只有一个答案。
 */
export function clampChannels(ch: Channels): Channels {
  for (const k of CHANNEL_GAIN_KEYS) ch[k] = clamp(ch[k], -1, 1);
  ch.risk = clamp(ch.risk, -1, 1);
  ch.curiosity = clamp(ch.curiosity, -1, 1);
  ch.arousal = clamp01(ch.arousal);
  ch.tilt = clamp01(ch.tilt);
  ch.ease = clamp01(ch.ease);
  ch.fatigue = clamp01(ch.fatigue);
  return ch;
}

export const CHANNEL_GAIN_KEYS = [
  'aggression', 'quitThreshold', 'delayInfo', 'seekInfo', 'tempo',
  'looseness', 'greed', 'safety', 'showoff', 'callLighter',
] as const satisfies readonly (keyof ChannelGains)[];

/** 全零通道，给合成用。 */
export function zeroChannels(): Channels {
  return {
    aggression: 0, quitThreshold: 0, delayInfo: 0, seekInfo: 0, tempo: 0,
    looseness: 0, greed: 0, safety: 0, showoff: 0, callLighter: 0,
    risk: 0, curiosity: 0, arousal: 0, tilt: 0, ease: 0, fatigue: 0,
  };
}

export interface Channels extends ChannelGains {
  /** 风险偏好 */
  risk: number;
  /** 好奇：愿意花钱买信息 */
  curiosity: number;
  arousal: number;
  tilt: number;
  ease: number;
  fatigue: number;
}

/** 疲劳（R20）：这一场做过多少次决策。 */
export function fatigueOf(m: MindState): number {
  return clamp01(m.episodes / 60);
}

/**
 * `E_t, D_t` → 通道（§4.9.6 的 `expression` 表在这里生效）。
 *
 * 同样的怒，常人卡配成「+进攻 +难退出」，岩石卡可以配成「−难退出」（越气越紧）——
 * 一行代码都不用改。
 */
export function emotionChannels(m: MindState, t: Traits): Channels {
  const ch = zeroChannels();
  const feed = (level: number, gains: Partial<ChannelGains> | undefined) => {
    if (!gains) return;
    const v = clamp(level, -1, 1);
    for (const k of Object.keys(gains) as (keyof ChannelGains)[]) {
      ch[k] += v * (gains[k] ?? 0);
    }
  };
  for (const k of EMOTION_KEYS) feed(m.e[k], t.expression[k]);
  feed(m.d.boredom, t.expression.boredom);

  // 「提前获取信息」是「推迟」的反面，合成一个净推力
  ch.delayInfo -= ch.seekInfo;
  ch.seekInfo = 0;

  ch.tilt = tiltOf(m);
  ch.ease = easeOf(m);
  ch.arousal = arousalOf(m);
  ch.fatigue = fatigueOf(m);

  // 驱力直接进通道
  ch.greed += m.d.greed * 0.25;
  ch.safety += m.d.safety * 0.25;
  ch.curiosity += m.d.curiosity * 0.5;
  ch.looseness += m.d.boredom * 0.30;
  ch.aggression += m.d.pride * 0.15;
  return clampChannels(ch);
}
