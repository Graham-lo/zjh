/**
 * 老王 —— 闷牌王（演员）。设计文档 §4.7.3 第 6 行。
 *
 * 原话（逐句拆到下面每一个字段上）：
 *   打法要点：「靠闷牌和表演吃饭。细记牌、1 轮前瞻、读用时且自己会演；
 *              闷跟到高档、单挑闷压看、常闷比；大牌装犹豫、小牌秒跟；诈唬频率最高」
 *   破绽：    「闷太久，被看牌后反加时常常已经投了很多，会被榨；
 *              被抓两次后一段时间不敢演（可读）」
 *   情绪与表演：「记仇强（被比掉的人下局必找）；表情 😱🤔 用来演」
 *
 * 字段 → 原话的对应：
 *   look.blindLove 0.88 / appetite 0.50   ← 「靠闷牌吃饭」：闷牌本身的乐趣压过对信息的胃口
 *   look.tierWeight 0.20 / costWeight 0.34 ← 「闷跟到高档」：单价升档、这一口开始肉疼，
 *                                            都几乎推不动他去看牌（常人是 0.70 / 0.85）
 *   look.pressureWeight 0.10 / allInWeight 0.10 ← 同上，别人开火、别人梭哈也吓不出他这一眼
 *   lines.闷压 1.60                        ← 「单挑闷压看」
 *   lines.闷比 1.30                        ← 「常闷比」（这个数与 §6.4 的拉扯见下方集成第 3 步注）
 *   lines.偷池 1.50                        ← 「诈唬频率最高」
 *   lines.弃 0.66                          ← 破绽「闷太久…会被榨」：他很不情愿把投进去的钱扔掉
 *   cognition.rangeFidelity 2              ← 「细记牌」
 *   cognition.lookahead 1                  ← 「1 轮前瞻」
 *   cognition.readsTiming true             ← 「读用时」（本期无消费方，见 docs/zjh/personas.md 待集成）
 *   cognition.s1Prototypes.blind 1.22      ← 「靠闷牌吃饭」：闷着的时候他对自己那手牌的幻想最重
 *   biases.sunkCost 0.62                   ← 破绽「已经投了很多」
 *   compare.blind 0.95                     ← 「常闷比」的另一半（闷着敢开比）
 *   compare.milk 0.88                      ← 「大牌装犹豫」「闷跟到高档」「靠闷牌和表演吃饭」：
 *                                             逮着优势第一反应是**留人再演两口**，不是开牌落袋
 *                                             （常人 0.55；八张卡里最高）
 *   compare.grudge 0.85 / emotion.grudge 0.90 / traits.decay.revenge 0.09 ← 「记仇强（下局必找）」
 *   allIn.bluff 0.22 / tempo.theatre 0.88  ← 「诈唬频率最高」「自己会演」
 *   allIn.blindAccept 0.82                 ← 「闷跟到高档」延伸到梭哈那一端
 *   emotes 😱🤔                             ← 「表情 😱🤔 用来演」
 *
 * 没有出现在原话里的数字（下面逐个写了理由）由本期选定：
 *   λ 只要是「往常人的反方向拉」的项，都尽量只动一项，不引入任何新的系数或门槛。
 */

import { COMMON_TRAITS, cloneTraits } from '../../../mind/traits.ts';
import type { Persona } from './types.ts';

const traits = cloneTraits(COMMON_TRAITS);

// 「记仇强（被比掉的人下局必找）」：bad beat 的咬合加倍，记仇几乎不掉。
// 0.09 的衰减 ≈ 记恨 40 局左右（复仇者是 0.05，他才是这一条的原型，老王稍轻一档）。
traits.regularities.R7 = 1.6;
traits.decay.revenge = 0.09;
// 「靠闷牌吃饭」：未查看持有的幻想（R16）加倍 —— 这是「闷得住」在通用层的那一半，
// 领域这一半是 look.blindLove。两边指的是同一件事，所以同向。
traits.regularities.R16 = 1.9;
// 破绽「已经投了很多」：沉没成本（R4）显著高于常人，和 biases.sunkCost 同向。
traits.regularities.R4 = 1.7;
// 「闷跟到高档」：面对大注的怯（R11）压到常人的一半 —— 大注吓不动他。
traits.regularities.R11 = 0.5;
// 演员不怕，怕的人演不了。
traits.baseline.fear = 0.05;
traits.drives.pride = 0.45;
traits.drives.safety = 0.28;
// 会演的人自控好、也愿意动脑（他要一直盯着别人怎么读他）。
traits.cognition.selfControl = 0.66;
traits.cognition.needForCognition = 0.58;
traits.cognition.narrowFraming = 0.50;
// 用时抖动大 = 演：他的用时本来就不该有规律。
traits.tempo.jitter = 0.55;
// 上头轻、退得慢（他把情绪当资源用）。
traits.tilt = { trigger: 0.60, gain: 0.75, recover: 4 };

export const LAOWANG: Persona = {
  name: '老王',

  look: {
    appetite: 0.62,        // 常人 0.90 → 他不靠看牌活着
    blindLove: 0.88,       // 常人 0.50 → 「靠闷牌吃饭」
    pressureWeight: 0.10,  // 常人 0.26
    costWeight: 0.34,      // 常人 0.85 → 「闷跟到高档」
    roundWeight: 0.95,     // 常人 1.50 → 轮次也推不快他（但不是 0：他终究会看）
    tierWeight: 0.20,      // 常人 0.70 → 「闷跟到高档」的主力项
    allInWeight: 0.10,     // 常人 0.30
  },

  lines: {
    便宜看戏: { weight: 0.34, commit: 0.34 },  // 闷着本来就便宜，看戏对他是常态
    闷压: { weight: 1.60, commit: 0.66 },      // 「单挑闷压看」
    // 「常闷比」。这个数字量的不是「他多常闷着比牌」，而是「他有多常**主动去找**
    // 一次闷比」：`plan.ts` 拿它乘贴合度做加权抽签，1.30 让闷比成了他仅次于
    // 闷压(1.60)、偷池(1.50)的第三条主线。
    //
    // 集成第 3 步（2026-09-04）实测过把它降下来能不能救 §6.4「闷比占比牌 5–15%」
    // ——**不能**，所以这里原样保留 1.30，理由记在这儿免得下一个人再扫一遍：
    //   · 八人名册桌 3000 手、标准档、seed 20260903，全桌闷比占比牌：
    //     weight 1.30→28.5%  0.40→19.6%  0.20→14.8%  0.15→13.0%  0.10→13.1%  0.05→10.6%
    //   · `compare.blind` 在表层几乎不动这个数（0.95/0.82/0.70 → 13.0/12.6/13.5%，
    //     都在噪声里）；`look.blindLove` 0.88→0.70/0.60 同样不动（28.7%/28.8%）。
    //     原因见 `adapter.ts`：闷着的人 `beat = compare.blind × 0.20 ≈ 0.19`，
    //     而门槛 `CMP_BLIND = 0.20`，两者本来就贴着零，真正掀翻它的是线路加成。
    //   · 但降到能进带的 0.15 会把他自己的卡打红：`[自洽] 老王` 要「比牌绝大多数
    //     是闷比」（>70%），实测从 80.2% 掉到 50.9%。
    //   · 算术上也走不通：他一个人 575 次比牌里 484 次闷比，占全桌 2204 次比牌的
    //     22.0% —— 就算另外七个人一次闷比都不出，全桌也已经超过 15% 的上沿。
    // 结论：这是**设计数字之间的冲突**（§4.7.3「常闷比」 vs §6.4 的 5–15%），
    // 不是这张卡的参数没调好，留给主线程裁决。详见集成报告。
    闷比: { weight: 1.30, commit: 0.60 },      // 「常闷比」
    养池: { weight: 0.55, commit: 0.52 },      // 他更愿意直接压，不爱慢慢养
    价值加压: { weight: 0.85, commit: 0.44 },
    偷池: { weight: 1.50, commit: 0.80 },      // 「诈唬频率最高」
    跟到底看: { weight: 0.58, commit: 0.30 },
    收口: { weight: 0.85, commit: 0.55 },
    弃: { weight: 0.66, commit: 0.50 },        // 破绽：他弃得比谁都不情愿
  },

  cognition: {
    rangeFidelity: 2,          // 「细记牌」
    lookahead: 1,              // 「1 轮前瞻」
    readsTiming: true,         // 「读用时」
    classifyOthers: 'fine',    // 会演的人首先得会读，「细记牌」的同一件事
    // 「靠闷牌吃饭」：闷着时对暗牌的幻想最重（blind 1.22）；
    // 看过之后他对牌力的估计基本准 —— 他的优势在读人不在自欺。
    s1Prototypes: { monster: 1.08, strong: 1.02, medium: 0.99, weak: 0.94, blind: 1.22 },
  },

  biases: {
    sunkCost: 0.62,        // 破绽「已经投了很多」
    gamblersFallacy: 0.14,
    lossAversion: 0.18,    // 敢演的人对损失钝一点
    overconfidence: 0.30,  // 「诈唬频率最高」的心理底座
  },

  compare: {
    heads: 0.46,   // 常人 0.55 → 单挑他更愿意开比（「单挑闷压看」的收尾）
    multi: 0.62,
    blind: 0.95,   // 「常闷比」
    grudge: 0.85,  // 「被比掉的人下局必找」
    softness: 1,
    // 「大牌装犹豫」= 慢打：拿到大牌先不摊，留着人再演两口 —— 这就是 milk 的定义那一端。
    // 「闷跟到高档」也是同一个人：他的钱是靠把局面拖长、把对手拖进高档赚的。
    // 八张卡里最高（常人 0.55）。注意它与 `blind 0.95`（常闷比）方向相反：
    // 闷比是「我看不见牌、按闷牌的账开一手」，milk 管的是「我明明打得过、要不要现在开」。
    milk: 0.88,
  },

  allIn: {
    initiate: 0.50,
    valueFloor: 0.72,        // 他的价值梭哈不必等到顶牌 —— 反正一半是在演
    bluff: 0.22,             // 「诈唬频率最高」（常人 0.05）
    accept: 0.05,
    blindAccept: 0.82,       // 「闷跟到高档」
    foldEquityWeight: 0.85,  // 会演的人最懂「对面会不会跑」
  },

  emotion: { tiltTrigger: 0.14, tiltGain: 0.70, decay: 0.80, ease: 0.35, grudge: 0.90 },

  traits,

  tempo: {
    base: 420,
    dive: 3400,
    theatre: 0.88,  // 「大牌装犹豫、小牌秒跟」的强度旋钮
    noise: 0.055,
    leak: 0.05,     // 他自己几乎不从用时里漏牌力（这正是「会演」的定义）
    // 方向和 theatre 同向：他「大牌装犹豫」，长考在他身上就是大牌。
    // 强度只有 0.05 —— 他身上真正可读的那条线是 theatre 0.88，不是这里。
    tell: 'strong-slow',
    snapRaise: 0,   // 「小牌秒跟」由 theatre 那一半负责，不能在这里再算一遍
  },

  emotes: { rate: 0.62, favourites: ['😱', '🤔'], cap: 3 },

  leaks: [
    '闷太久：闷牌线权重高（闷压 1.60）、弃牌线权重低（0.66）、沉没成本重（R4 ×1.7、'
    + 'biases.sunkCost 0.62），所以他常常闷着跟到第 3–4 轮，锅里已经很厚。'
    + '利用方式：前两轮只跟不加把他养住，等单价升档后连续加压 —— '
    + '他会用一手没看过的烂牌付掉最贵的那几口。',
    '诈唬频率最高（偷池 1.50、allIn.bluff 0.22、tempo.theatre 0.88），而且本期他没有'
    + '「被抓两次就收手」的收敛路径（见待集成）。利用方式：对他的加注一路便宜地跟到底，'
    + '不弃牌就能把他的偷池全部收掉；同一套跟注对不诈唬的人（数学型 bluff 0.02）只会亏钱。',
  ],
};
