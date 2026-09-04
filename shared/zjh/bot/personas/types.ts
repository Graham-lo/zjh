import type { Traits } from '../../../mind/traits.ts';

/**
 * 人物卡的接口（设计文档 §4.7.4 + §4.10.1）。
 *
 * 人物卡 = **通用特征表**（`traits`，`shared/mind/` 里那一层「人」）
 *        + **牌桌习惯**（看牌习惯、线路、比牌口味、梭哈口味、破绽）。
 * 前者换个领域照样成立，后者只有炸金花认识。
 *
 * 这里定的是**人**，不是参数：每一个字段回答的都是「这个人在牌桌上是怎么个人」——
 * 他爱不爱闷牌、他会走哪几条线、他算不算账、他上头得快不快、他挑谁比牌。
 * 决策代码（`decide.ts`）本身**一条固定门槛都没有**：所有的「要不要看牌 / 弃不弃 /
 * 加不加」都是「人物卡 × 当时局面 × 当时情绪」连续评分之后采样出来的，
 * 同一段代码换一张卡、换一种情绪就是另一个人在打牌。
 *
 * 顶层的十一个字段与设计文档 §4.7.4 逐字对应，P3 只需要在 `personas/` 下再加卡片，
 * 不需要动 `decide.ts`。子结构（LookHabit / LinePolicy / …）文档没有规定内容，
 * 由这一期定义。
 */

/** 线路全集（设计文档 §4.4）。 */
export type Line =
  | '便宜看戏' | '闷压' | '闷比' | '养池' | '价值加压' | '偷池' | '跟到底看' | '收口' | '弃';

export const LINES: readonly Line[] = [
  '便宜看戏', '闷压', '闷比', '养池', '价值加压', '偷池', '跟到底看', '收口', '弃',
] as const;

/**
 * 看牌与闷牌的习惯。
 *
 * 全部是**连续的推力**，没有一条是门槛：轮次、单价档位、成本占比、桌面压力
 * 各自往「想看一眼」这个念头上加一点分，`blindLove` 往反方向拉。
 * 最后和「看这一眼值多少钱」（信息价值，`lookahead` 真的算出来的）加在一起，
 * 再和别的动作一起竞争。所以「第 2 轮必看牌」这种事在新模型里不可能发生。
 */
export interface LookHabit {
  /** 对信息的胃口：越大越想早点看牌 */
  appetite: number;
  /** 闷牌本身的乐趣 —— 闷着只掏一半价，这一项是「便宜」在他心里的分量 */
  blindLove: number;
  /** 桌面压力的推力 */
  pressureWeight: number;
  /** 这一口占身家比例的推力 */
  costWeight: number;
  /** 轮次的推力（每多打一轮加多少） */
  roundWeight: number;
  /** 单价档位的推力（每升一档加多少） */
  tierWeight: number;
  /** 有人梭哈时的额外推力。闷着接梭哈是合法线路，所以这一项远小于 1 */
  allInWeight: number;
}

/** 一条线路对这个人来说值多少。缺省（`undefined`）= 这个人不会走这条线。 */
export interface LinePolicy {
  /** 选线权重：同时进得去的线路之间按权重竞争 */
  weight: number;
  /** 认线程度：选了之后，偏离这条线的动作要扣多少分。越大越像「说到做到」 */
  commit?: number;
}

/** 比牌习惯（设计文档 §4.6 的价值函数由这里配权重）。 */
export interface ComparePolicy {
  /** 单挑时「这个目标值不值得清」的门槛 */
  heads: number;
  /** 多人时的同一门槛 */
  multi: number;
  /** 闷着比牌的意愿 */
  blind: number;
  /** 记仇在目标价值里的权重（§4.6 的 0.4×grudge 由它缩放） */
  grudge: number;
  /** 挑软柿子的程度：1 = 完全按 pWin 挑，0 = 谁投得多挑谁 */
  softness: number;
  /**
   * 「做大」还是「见好就收」（§4.7「他拿到大牌之后想干什么」那一栏）。
   *
   * 0 = 逮着优势就想立刻兑现，把人开掉、把这一手了结；
   * 1 = 逮着优势第一反应是「留着他，看能不能再榨两口」。
   *
   * 它是**把人留在池子里的机会成本**在这个人身上的权重（乘 `CMP_MILK` 落地）：
   * 越大的人，越舍不得把一个跑不掉的对手现在开掉。所以它只在「我确实占优、
   * 而且对面还跟得下去」的时候起作用 —— 打不过的时候没有什么可榨的，
   * 对面本来就要跑的时候也没有（那时候真人的直觉正是「他要跑，那现在就开了他」）。
   */
  milk: number;
}

/** 梭哈两端的习惯（设计文档 §4.6）。 */
export interface AllInPolicy {
  /** 发起梭哈的意愿 */
  initiate: number;
  /** 价值梭哈想要的牌力（连续项，作为评分的中心而不是门槛） */
  valueFloor: number;
  /** 诈唬梭哈的意愿 */
  bluff: number;
  /** 接梭哈的意愿位移，正数 = 更愿意接 */
  accept: number;
  /** 闷着接梭哈的意愿（按闷牌半价算账） */
  blindAccept: number;
  /** 「对面会不会接」在发起决策里的权重：越大越懂得对一吓就跑的桌子不该梭 */
  foldEquityWeight: number;
}

/** 情绪曲线（设计文档 §4.7.4）。跨局状态存在 `BotMemory.emotion` 里。 */
export interface EmotionCurve {
  /** 输掉身家的多少比例开始上头 */
  tiltTrigger: number;
  /** 上头的强度 */
  tiltGain: number;
  /** 每局的衰减系数（情绪撑几局） */
  decay: number;
  /** 大赢之后「宽裕」的增益 */
  ease: number;
  /** 记仇强度 */
  grudge: number;
}

/** 用时与表演。 */
export interface TempoPolicy {
  /** 基础节奏（毫秒） */
  base: number;
  /** 边缘局面下潜的幅度（毫秒） */
  dive: number;
  /** 演的程度：装犹豫 / 秒跟装弱 */
  theatre: number;
  /** 决策噪声幅度（归一化 EV 单位）。设计文档 §4.5 的「性格噪声 ±5%」 */
  noise: number;
  /** 用时泄露牌力的程度（破绽，P3 用） */
  leak: number;
  /**
   * `leak` 泄露的**方向**。强度写在 `leak` 上，形状写在这里 ——
   * §4.7.3 的人物文字里，三张卡漏的是三种完全不同的形状：
   *
   * - `'strong-slow'` 岩石「用时随牌力单调（牌好想得久）」
   * - `'weak-slow'`   新手「牌越差想越久」
   * - `'edge-slow'`   数学型「用时 = 计算难度，读得出他在边缘」（两极快、中间慢）
   * - `'none'`        原话没提用时破绽的人（跟注站、赌徒、老油条、常人）
   *
   * 一个标量表达不了这三种形状 —— 只有 `leak` 的话，「牌好想得久」和
   * 「牌差想得久」会是同一个数，而「边缘想得久」连符号都没有。
   * 所以形状单开一个字段，`leak` 保持它在 §4.7.4 表里的原义（程度）。
   */
  tell: TempoTell;
  /**
   * 「拿大牌忍不住秒加」（§4.7.3 新手那一行的第三条破绽）。
   *
   * 0 = 没有这个毛病；1 = 金花以上加注时用时压到地板。和 `tell` 是两件事：
   * `tell` 说的是「想多久」随牌力怎么变，这一条只在**他自己开火**的时候触发，
   * 是动作与用时的联动（`docs/zjh/personas.md`「待集成」#8）。
   */
  snapRaise: number;
}

/** `TempoPolicy.tell` 的取值，见那一行的注释。 */
export type TempoTell = 'none' | 'strong-slow' | 'weak-slow' | 'edge-slow';

/** 表情语言（P3 才会真的发表情，这一期只把配置带上）。 */
export interface EmotePolicy {
  rate: number;
  favourites: string[];
  cap: number;
}

/** 一张人物卡。字段与设计文档 §4.7.4 逐条对应。 */
export interface Persona {
  name: string;
  look: LookHabit;
  lines: Partial<Record<Line, LinePolicy>>;
  /**
   * 认知（设计文档 §4.9.7）：这是**系统 2 的工具保真度**，加上系统 1 原型表的偏斜。
   * 「爱不爱动脑、自控、意志力、概率权重、框架宽窄」是领域无关的，在 `traits.cognition`。
   */
  cognition: {
    rangeFidelity: 0 | 1 | 2;
    lookahead: 0 | 1 | 2;
    readsTiming: boolean;
    classifyOthers: 'none' | 'coarse' | 'fine';
    /** 系统 1 原型表的偏斜：把某个牌力档位在**感觉上**放大或缩小 */
    s1Prototypes: { monster: number; strong: number; medium: number; weak: number; blind: number };
  };
  biases: { sunkCost: number; gamblersFallacy: number; lossAversion: number; overconfidence: number };
  compare: ComparePolicy;
  allIn: AllInPolicy;
  emotion: EmotionCurve;
  /** 通用特征表（`shared/mind/traits.ts`）。换个领域照样描述同一个人 */
  traits: Traits;
  tempo: TempoPolicy;
  emotes: EmotePolicy;
  /** 文档化的破绽。P3 的验收（§6.5）按这里逐条写利用脚本 */
  leaks: string[];
}
