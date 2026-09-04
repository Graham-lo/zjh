/**
 * 阿凯 —— **赌徒（松凶 / 上头王）**「来找刺激的」（设计文档 §4.7.3 第二行）。
 *
 * 逐字对应表（原话没提到的字段一律照抄常人卡）：
 *
 * | §4.7.3 / §4.9.6 原话 | 落到哪几个字段 |
 * |---|---|
 * | 粗记牌 | `cognition.rangeFidelity 1`、`classifyOthers 'coarse'` |
 * | 0–1 轮前瞻 | `cognition.lookahead 0`（取下界，与「秒出手」同一件事） |
 * | 什么牌都想看看 | `look.appetite 1.30`、`look.blindLove 0.45`（四张卡里最低）、`look.roundWeight 0.90`、`s1Prototypes` 整体上浮 |
 * | 沉没成本重，投入多了就不弃 | `biases.sunkCost 0.85`、`traits.regularities.R4 2.0`、`lines.跟到底看 1.60`、`lines.弃 0.30` |
 * | 喜欢梭哈 | `allIn.initiate 0.85`、`look.allInWeight 0.55` |
 * | 喜欢比投入最多的人 | `compare.softness 0`（§4.7.2 原话「挑投入最多的（想一口吃大的）」） |
 * | 想一口吃大的 + 投入多了就不弃 | `compare.milk 0.80`（常人 0.55）：池子不够大他不肯收手 —— 优势在手第一反应是留人做大，不是开牌落袋 |
 * | 连输后起手全开 | `traits.regularities.R5 2.0`（§4.9.6 点名）、`lines.养池/价值加压` 上浮 |
 * | 上头后小金花也梭 | `allIn.valueFloor 0.62`、`traits.tilt.gain 1.6`、`probWeightAlpha 0.50` |
 * | 对偷池免疫（他不弃） | `lines.弃 0.30`、`allIn.accept 0.35` |
 * | 但对价值加注全付 | `allIn.foldEquityWeight 0.15`、`R11 0.3`（不怕大注）—— 破绽 2 |
 * | 输 8% 触发上头 | `emotion.tiltTrigger 0.08`（原文的数，逐字） |
 * | ×0.85 衰减 | `emotion.decay 0.85`（原文的数，逐字） |
 * | 大赢后更疯 | `emotion.ease 0.75`、`traits.ease {trigger .3, gain 1.5}` |
 * | 秒出手 | `tempo.base 200 / dive 800`、`needForCognition 0.15` |
 * | 表情最多 | `emotes.rate 0.95 / cap 4`；🔥😭 取自 §4.7.2「赌徒：赢就🔥输就😭」 |
 * | §4.9.6 举例：R1 ×1.5、R3 ×2、R5 ×2 | `traits.regularities` 三条逐字 |
 * | §4.9.6 举例：anger→aggression +.9 | `traits.expression.anger.aggression 0.9` 逐字 |
 * | §4.9.6 举例：fear 衰减 .8 | `traits.decay.fear 0.8` 逐字（常人 .5 → 怕消得更快） |
 *
 * 「投入多了就不弃」在这里**不是**一条 `if (投入 ≥ x) 不弃`：R4 在通用层是
 * `quitThreshold += 投入占比 × 0.35 × 系数` 的连续量，这张卡把系数写成 2.0，
 * 于是「越投越难退」这条曲线整体抬高一倍，仍然是曲线。
 */

import { COMMON_TRAITS, cloneTraits, type Traits } from '../../../mind/traits.ts';
import { COMMON_PERSONA } from './common.ts';
import type { Persona } from './types.ts';

/** 「上头王 + 沉没成本重 + 秒出手」在通用特征表上的样子。 */
function traits(): Traits {
  const t = cloneTraits(COMMON_TRAITS);
  // 来找刺激的：贪大、不求安、坐不住。
  t.drives = { ...t.drives, greed: 0.75, safety: 0.15, curiosity: 0.70, boredom: 0.30 };
  t.baseline = { ...t.baseline, joy: 0.20, fear: 0.05 };
  // §4.9.6 逐字：fear 衰减 .8（常人 .5）—— 怕来得快也去得快。
  t.decay.fear = 0.80;
  t.decay.anger = 0.15;        // 上头王：气留得久（常人 .25）
  t.decay.rumination = 0.18;
  t.sensitivity = { ...t.sensitivity, valence: 1.4, magnitude: 1.4 };  // 什么都放大
  // §4.9.6 逐字：anger→aggression +.9（常人 +.5）；怒也让他更不肯退。
  t.expression.anger = { ...t.expression.anger, aggression: 0.90, quitThreshold: 0.70 };
  /**
   * 「输 8% 触发上头、×0.85 衰减」这一句在通用层是三个数：
   * `sensitivity.magnitude 1.4`（输一成身家在他心里就是输了一大笔）、
   * `tilt.trigger 0.35`（常人 .55 —— 同样的怒火他更早算「上头」）、
   * `decay.anger 0.15`（常人 .25 —— 每局只消掉 15%，对应原话的慢衰减）。
   * 原话那个 8% 不能直接写进 `tilt.trigger`：`tilt.trigger` 量的是
   * 「怒 + 思」这个读数（traits.ts:32），不是筹码的百分比。
   * 注意 `tilt.trigger` / `tilt.recover` / `ease.*` 这一期还没有消费方
   * （只有 `tilt.gain` 在 R7 里用），见报告的「待集成」清单。
   */
  t.tilt = { trigger: 0.35, gain: 1.6, recover: 5 };
  t.ease = { trigger: 0.30, gain: 1.5 };               // 大赢后更疯（阈值/回落，待接线）
  /**
   * 「大赢后更疯」真正能落到动作上的那一半，按 §4.9.2「各表达通道的增益」写在这里：
   * `ease.{trigger,gain}` 这一期没有消费方，喜悦唯一进得了通道的路是 `expression.joy`。
   * 赌徒的喜悦跟他的怒是同一个方向 —— 更松（打更多手）、更凶（加更多注）、
   * 更贪（追更大的池）、更爱亮相（人物文字：表情最多 🔥😭😂）：
   * 松弛 .90、进攻 .70、贪 .60、显摆 .60，全部高于常人的 .3。
   */
  t.expression.joy = { looseness: 0.90, greed: 0.60, showoff: 0.60, aggression: 0.70 };
  t.regularities = {
    ...t.regularities,
    R1: 1.5,    // §4.9.6 逐字
    R3: 2.0,    // §4.9.6 逐字
    R5: 2.0,    // §4.9.6 逐字（= 连输后起手全开）
    R4: 2.0,    // 沉没成本重
    R6: 1.6,    // 大赢后更疯
    R7: 1.6,    // 上头王
    R11: 0.3,   // 不怕大注：对价值加注全付
    R21: 1.5,   // 来找刺激的：唤醒直接变成冒险
  };
  // 秒出手 = 不爱动脑、自控差、意志力薄；α 低 = 高估小概率（小金花也梭的来源）。
  t.cognition = {
    ...t.cognition,
    needForCognition: 0.15, selfControl: 0.15, willpowerMax: 4,
    willpowerRecover: 0.8, willpowerCost: 0.80,
    probWeightAlpha: 0.50, narrowFraming: 0.95,
  };
  t.tempo = { baseMs: 200, deliberateMs: 900, jitter: 0.45 };
  return t;
}

export const 阿凯: Persona = {
  name: '阿凯',

  look: {
    appetite: 1.30,        // 什么牌都想看看
    /**
     * 闷着看不到刺激 —— 四张卡里他掀牌最早（实测第 1 轮 58%，另外三张 39/30/14%）。
     * 绝对值高于常人卡的 0.50 只是标定问题：常人卡那个数是**过渡映射的基数**
     * （`index.ts` 还会加 `deception × 0.26`），手写卡没有那一层。
     */
    blindLove: 0.45,
    pressureWeight: 0.10,  // 别人开火不会让他多想（秒出手）
    costWeight: 0.35,      // 价钱不是他的输入（对价值加注全付）
    // 秒出手：他不会因为「打到第几轮了」才想起来看牌，想看当场就看。
    roundWeight: 0.90,
    tierWeight: COMMON_PERSONA.look.tierWeight,     // 原话未涉及 → 常人
    allInWeight: 0.55,     // 喜欢梭哈：桌上有人梭，他先看清自己再冲
  },

  lines: {
    便宜看戏: { weight: 0.03, commit: 0.30 },   // 「来找刺激的」：看戏这条线最没刺激
    闷压: { weight: 0.25, commit: 0.42 },       // 什么牌都想看看 → 闷着的线走得少
    闷比: { weight: 0.02, commit: 0.30 },       // 同上
    养池: { weight: 1.10, commit: 0.52 },       // 连输后起手全开
    价值加压: { weight: 1.25, commit: 0.40 },   // 松凶
    偷池: { weight: 0.80, commit: 0.80 },       // 松凶：拿弱牌也抬价
    跟到底看: { weight: 1.60, commit: 0.75 },   // 投入多了就不弃：这条线一旦定下他就不改主意
    收口: { weight: 0.50, commit: 0.58 },       // 来找刺激的人不主动了结一手牌
    弃: { weight: 0.30, commit: 0.50 },         // 对偷池免疫（他不弃）：全卡最低的一条线
  },

  cognition: {
    rangeFidelity: 1,          // 粗记牌
    lookahead: 0,              // 0–1 轮前瞻，取下界：秒出手的人不算第二轮
    readsTiming: false,        // 原话未涉及 → 常人
    classifyOthers: 'coarse',  // 粗记牌
    /**
     * 「什么牌都想看看」「上头后小金花也梭」：他对**每一档**牌的感觉都比实际大一点，
     * 中等牌尤其（medium 1.12 —— 小金花在他眼里就是货）。这是「小金花也梭」的
     * 连续来源，不是「分位 ≥ x 就梭」。
     */
    s1Prototypes: { monster: 1.15, strong: 1.15, medium: 1.12, weak: 1.08, blind: 1.15 },
  },

  /** 沉没成本重是原话点名的；另外三条按「来找刺激的」一并抬高。 */
  biases: { sunkCost: 0.85, gamblersFallacy: 0.55, lossAversion: 0.15, overconfidence: 0.45 },

  compare: {
    heads: COMMON_PERSONA.compare.heads,   // 原话未涉及 → 常人
    multi: COMMON_PERSONA.compare.multi,   // 原话未涉及 → 常人
    blind: COMMON_PERSONA.compare.blind,   // 原话未涉及 → 常人
    grudge: COMMON_PERSONA.compare.grudge, // 原话未涉及 → 常人
    softness: 0,   // 喜欢比投入最多的人（§4.7.2：0 = 谁投得多挑谁）
    // 「想一口吃大的」（§4.7.2 原话）+「沉没成本重，投入多了就不弃」：
    // 他要的是**大**的那一口，池子还没做大就把人开掉不是他的爽点；
    // 加上他自己「什么牌都想看看」，也从不担心多留一轮会翻车。明显高于常人 0.55。
    milk: 0.80,
  },

  allIn: {
    initiate: 0.85,        // 喜欢梭哈
    valueFloor: 0.62,      // 上头后小金花也梭（评分的中心，不是门槛）
    bluff: 0.20,           // 松凶
    accept: 0.35,          // 他不弃
    blindAccept: 0.60,     // 同上，闷着也接
    foldEquityWeight: 0.15, // 从不问「对面会不会跑」—— 破绽 2 的另一半
  },

  /** 输 8% 触发上头、×0.85 衰减、大赢后更疯（原话三句都是数）。 */
  emotion: { tiltTrigger: 0.08, tiltGain: 1.50, decay: 0.85, ease: 0.75, grudge: 0.55 },

  traits: traits(),

  tempo: {
    base: 200,    // 秒出手
    dive: 800,    // 秒出手：边缘局面也不下潜
    theatre: 0.10, // 他不演 —— 情绪都在表情上，不在用时上
    noise: 0.09,   // 松凶 + 秒出手：同一局面他自己也不稳定
    leak: 0,       // 用时和牌力无关（他根本不想）
    tell: 'none',  // 同上：秒出手是一条平线
    snapRaise: 0,  // 他所有动作都快，不需要额外的「秒加」项（那会变成双重计数）
  },

  emotes: { rate: 0.95, favourites: ['🔥', '😭', '😂'], cap: 4 },

  leaks: [
    '上头后小金花也梭，可以拿真牌等他。怎么利用：不要抢在他前面加价 —— '
    + 'tiltTrigger 0.08 加 decay 0.85，他自己就会一直待在上头里（实测 94% 的决策'
    + '是在上头状态下做的，老油条只有 19%），你不需要去点火。'
    + '他上头时梭出去的牌 58.7% 在顺金以下（合计 57.3%，老油条 45.7%），'
    + '所以：手上有顺金以上就接、没有就退，接他的人只要范围比小金花硬就是净赚。'
    + '这条软范围来自 valueFloor 0.62 和 α=0.50，不是某个轮次的开关 —— '
    + '同样上头时他单手牌的梭哈率跟别人差不多（金花档 5.5% vs 常人 6.4%），'
    + '差别在于他一直在那个心情里。',
    '对偷池免疫（他不弃），但对价值加注全付。怎么利用：对他一次都不要诈唬（偷不动，白送），'
    + '换成只用真牌一档一档往上加 —— 弃牌线权重 0.30、R4 ×2、foldEquityWeight 0.15，'
    + '他既不会因为价钱退，也不会怀疑你为什么敢加，每一档都跟。'
    + '加到第 2 轮就比牌收口，别把牌带进梭哈：梭哈第 3 轮才解锁，一进梭哈'
    + '你就是在跟一个 accept 0.35 的人对满身家，赚来的边际会被方差吃掉。'
    + '他反加你就退 —— 他的加注确实带牌力，只是他不会因为你的加注而退。',
  ],
};
