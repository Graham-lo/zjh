/**
 * 小雨 —— 新手（乱打的）。设计文档 §4.7.3 第 7 行。
 *
 * 名字是本期新起的（文档只写了原型「新手（乱打的）」，没有给名字）：
 * 两个字、和出厂名册（阿凯/老陈/小北/阿杰/小林/老王）以及测试台的「甲」都不撞，
 * 「小雨」听上去年轻、怯生生，正好是这张卡的样子。
 *
 * 原话（逐句拆到下面每一个字段上）：
 *   打法要点：「刚学会规则。无记牌、0 轮前瞻；轮到就看牌；怕大注：升到 5 万档以上多半弃，
 *              除非拿到金花以上；对子就觉得不错（真实炸金花直觉，在这一桌是错的）；
 *              比牌随机挑人；有时闷跟到底不知道为什么」
 *   破绽：    「牌越差想越久；大注一吓就走；拿大牌会忍不住秒加」
 *   情绪与表演：「输了会 😭，赢了会 🔥；上头中等」
 *
 * 字段 → 原话的对应：
 *   cognition.rangeFidelity 0              ← 「无记牌」（只用公共先验，不读任何人的事件流）
 *   cognition.lookahead 0                  ← 「0 轮前瞻」
 *   cognition.classifyOthers 'none'        ← 「刚学会规则」
 *   look.appetite 1.85 / blindLove 0.14    ← 「轮到就看牌」
 *   look.tierWeight 1.35 / costWeight 1.30 ← 「怕大注」：单价一升、这一口一贵，他就更想先看看
 *   lines.弃 1.50 + traits.regularities.R11 2.4 + biases.lossAversion 0.55
 *                                          ← 「升到 5 万档以上多半弃，除非拿到金花以上」
 *                                             （连续项：不是 `if (unit >= 50000)`，是「越贵越怕」
 *                                               的斜坡，验收按统计量量：5 万档以上、金花以下弃牌率 > 70%）
 *   cognition.s1Prototypes.medium 1.25     ← 「对子就觉得不错」（原型槽位现在按牌型取，
 *                                             medium 槽装的就是对子+顺子，见下面的注释）
 *   compare.softness 0.05                  ← 「比牌随机挑人」
 *   compare.milk 0.30                      ← 「刚学会规则」「0 轮前瞻」「怕大注」：
 *                                             「留着他下一轮再榨两口」是一笔要往前看一轮的账，
 *                                             他既算不出来也不想要（池子大了他更怕），
 *                                             拿到觉得不错的牌第一反应就是现在摊出去（常人 0.55）
 *   lines.跟到底看 2.20 / 闷压 0.14        ← 「有时闷跟到底不知道为什么」
 *   traits.regularities.R16 2 / R4 1.5 / sensitivity.expectancy 1.6 / 疲劳更早
 *                                          ← 设计文档 §4.9.6 给新手的偏斜，逐字照抄
 *   emotes 😭🔥                             ← 「输了会 😭，赢了会 🔥」
 *   emotion.tiltTrigger 0.10 / tiltGain 0.85 ← 「上头中等」（= 常人那一档，不加不减）
 *   tempo.dive 4600 / tempo.leak 1.00      ← 破绽「牌越差想越久」（本期无消费方，见待集成）
 */

import { COMMON_TRAITS, cloneTraits } from '../../../mind/traits.ts';
import type { Persona } from './types.ts';

const traits = cloneTraits(COMMON_TRAITS);

// —— 设计文档 §4.9.6 给「新手」的偏斜，原样照抄 ——
traits.regularities.R16 = 2;      // 未查看持有的幻想 ×2
traits.regularities.R4 = 1.5;     // 沉没成本 ×1.5
traits.sensitivity.expectancy = 1.6;
// 「疲劳更早」：意志力池子小、消耗快、回得慢 —— 一晚上打到后面他就只剩系统 1。
traits.cognition.willpowerMax = 3;
traits.cognition.willpowerCost = 0.80;
traits.cognition.willpowerRecover = 0.50;

// —— §4.7.3 那一行里、§4.9.6 没有覆盖到的部分 ——
// 「大注一吓就走」：面对大注的怯（R11）是这条破绽在通用层的落点。
traits.regularities.R11 = 2.4;
// 「刚学会规则」：不爱动脑、自控差。系统 2 很少介入，介入了也算不深（lookahead 0）。
traits.cognition.needForCognition = 0.18;
traits.cognition.selfControl = 0.28;
traits.cognition.probWeightAlpha = 0.48;  // 概率扭曲最重：小概率当大事，大概率不当回事
traits.cognition.narrowFraming = 0.95;    // 眼里只有这一局
// 怕：恐惧退得慢（decay 0.35），但底噪不高。
// 「刚学会规则」的人平时并不紧张 —— 他是**被价格吓到**才怕，不是坐下来就怕。
// 底噪压到 0.10：留出余量，价格一跳他的恐惧才有地方涨（否则平静时就已经吓到顶，
// 「一吓就走」在行为上反而看不出变化）。
traits.baseline.fear = 0.10;
traits.baseline.worry = 0.10;
traits.decay.fear = 0.35;
traits.drives.safety = 0.48;
traits.drives.curiosity = 0.55;  // 「轮到就看牌」的另一半：他就是想看
traits.drives.greed = 0.34;
// 怕的时候他缩得比谁都厉害（这一条直接支撑 (d) 里「怕 → 弃牌率上升」的方向性断言）。
traits.expression.fear = {
  ...traits.expression.fear, aggression: -0.85, quitThreshold: -1.20, seekInfo: 0.70,
};
// 「上头中等」：tilt 不动，用常人那一档。
traits.tempo = { baseMs: 340, deliberateMs: 4600, jitter: 0.45 };

export const XIAOYU: Persona = {
  name: '小雨',

  look: {
    appetite: 1.85,        // 「轮到就看牌」（常人 0.90）
    blindLove: 0.14,       // 常人 0.50 —— 闷牌对他没有任何乐趣，他只是想知道自己拿了什么
    pressureWeight: 0.34,
    costWeight: 1.30,      // 「怕大注」
    roundWeight: 0.35,     // 轮次推力远低于常人：他第一次轮到就看完了，轮次没什么可推的
    tierWeight: 1.35,      // 「怕大注」的主力项
    allInWeight: 0.75,     // 有人梭哈他一定要先看一眼
  },

  lines: {
    便宜看戏: { weight: 1.30, commit: 0.22 },  // 「刚学会规则」：只要便宜他就跟着玩
    闷压: { weight: 0.14, commit: 0.20 },      // 「有时闷跟到底不知道为什么」的一小半
    闷比: { weight: 0.04, commit: 0.20 },
    养池: { weight: 0.45, commit: 0.30 },      // 他不懂养池
    // 「拿大牌会忍不住秒加」：这条线的吸引力压过「跟到底看」（2.20）——
    // 「忍不住」的意思就是**这一下不是选出来的**，所以权重要比常人（1.00）高得多，
    // commit 0.60 让他选了之后真的加下去（0.30 那一档他选了线还会被别的动作带跑）。
    // 只在大牌上发作：他没有偷池（0.10）也不诈唬（allIn.bluff 0.01），
    // 顺子及以下这条线根本进不去，所以加注率的抬升全部落在金花以上。
    价值加压: { weight: 2.80, commit: 0.60 },
    偷池: { weight: 0.10, commit: 0.35 },      // 「刚学会规则」：他不会主动诈唬
    跟到底看: { weight: 2.20, commit: 0.26 },  // 「有时跟到底不知道为什么」
    收口: { weight: 0.25, commit: 0.35 },      // 「刚学会规则」：他不知道什么叫收口
    // 「大注一吓就走」的力气**不放在这里**：弃牌线的权重是「他平时爱不爱弃」，
    // 而原话说的是「升到 5 万档以上多半弃」—— 那是价格的函数，不是习惯的函数。
    // 所以这一项只比常人高一点点，真正的怕由 R11 ×2.4、lossAversion 0.55、
    // look.tierWeight 1.35、allIn.accept −0.16 这几个**跟着价格走**的连续项扛。
    弃: { weight: 0.55, commit: 0.40 },
  },

  cognition: {
    rangeFidelity: 0,        // 「无记牌」
    lookahead: 0,            // 「0 轮前瞻」
    readsTiming: false,      // 「刚学会规则」
    classifyOthers: 'none',  // 「刚学会规则」
    /**
     * 「对子就觉得不错（真实炸金花直觉，在这一桌是错的）」—— personas.md 待集成 #9。
     *
     * 原来这里的保留意见是「原型表按分位分档，对子和散牌同档，只能整档抬」，
     * 那是**旧发牌档**下的事实（对子 [.05,.08) 挨着散牌 [0,.05)，两者都落在 `weak`）。
     * 两件事把它解掉了：
     *   1. 硬要求 1 把分位带对回 `categoryBands('standard')`，对子成了 [.60,.74)、
     *      散牌 [0,.60)，两类在分位上彻底分开；
     *   2. `adapter.ts` 的 `protoGainOf()` 改成按**牌型**取槽位（§4.9.7 原话「手牌档位」），
     *      `medium` 槽现在装的正是「对子 + 顺子」，`weak` 槽只剩散牌。
     * 所以「对子就觉得不错」这句话现在有地方落：1.45 从 `weak` 挪到 `medium`，
     * 并且**下调到 1.25** —— 旧档里 1.45 乘的是 0.05–0.08 的分位，绝对量几乎为零；
     * 新档里对子本身就在 .60–.74，×1.45 会直接顶到 1.0（对子 = 豹子），
     * 那不是「不错」是「疯了」。1.25 让对子的感觉落在 .75–.925，顺子 .925–1.0，
     * 排序不倒挂，也明显高过常人的 0.98。
     *
     * `weak`（现在只剩散牌）回到 1.05：新手对垃圾牌仍有一层薄薄的高估（常人 0.96），
     * 但「什么都跟」那一半本来就写在 `lines` 和 `look` 上，不该靠原型表把散牌抬成好牌
     * —— 旧值 1.45 在新档下会算出 `散牌 .59×1.45 = .855 > 顺子 .80×1.06 = .848` 的倒挂。
     */
    // monster/strong 也抬（1.30 / 1.18，常人 1.06 / 1.00）：「忍不住」的另一半是
    // **他一看到大牌就兴奋**，直觉那一层先把牌看大一档，加压的念头才压得住别的线。
    s1Prototypes: { monster: 1.30, strong: 1.18, medium: 1.25, weak: 1.05, blind: 1.08 },
  },

  biases: {
    sunkCost: 0.42,        // 与 R4 ×1.5 同向
    gamblersFallacy: 0.38, // 「刚学会规则」：他最信「该轮到我了」
    lossAversion: 0.55,    // 「怕大注」
    overconfidence: 0.55,  // 「拿大牌会忍不住加」：手上有牌时他对自己的赢面最不设防
  },

  compare: {
    heads: 0.60,
    multi: 0.72,
    blind: 0.10,
    grudge: 0.20,
    softness: 0.05,  // 「比牌随机挑人」：几乎不按 pWin 挑，谁都可能
    // 「0 轮前瞻」的人算不出「下一轮还能榨多少」，「怕大注」的人也不想把池子做大。
    // 拿到自己觉得不错的牌，第一反应是现在就摊开看结果。低于常人 0.55，
    // 但不到岩石/数学型那种「算清楚了才兑现」的低位 —— 他不是在落袋，是不会等。
    milk: 0.30,
  },

  allIn: {
    initiate: 0.30,
    valueFloor: 0.90,        // 「拿大牌」才梭
    bluff: 0.01,
    accept: -0.16,           // 「大注一吓就走」在梭哈那一端
    blindAccept: 0.20,
    foldEquityWeight: 0.15,  // 「刚学会规则」：他根本不会想「对面会不会跑」
  },

  emotion: { tiltTrigger: 0.10, tiltGain: 0.85, decay: 0.72, ease: 0.45, grudge: 0.20 },

  traits,

  tempo: {
    base: 340,    // 「跟就跟」：不算账的人按得最快（再低就会被引擎 240ms 地板削平，反而不像人）
    dive: 4600,   // 破绽「牌越差想越久」
    theatre: 0.04,
    noise: 0.085, // 「乱打的」：他的动作里随机成分最大
    leak: 1.00,   // 破绽「牌越差想越久」的强度旋钮
    tell: 'weak-slow',  // 方向：牌越差越慢（八张卡里唯一往这个方向漏的）
    snapRaise: 0.85,    // 「拿大牌会忍不住秒加」（§4.7.3 新手第三条破绽）
  },

  emotes: { rate: 0.70, favourites: ['😭', '🔥'], cap: 3 },

  leaks: [
    '大注一吓就走（R11 ×2.4、biases.lossAversion 0.55、tierWeight 1.35、'
    + 'allIn.accept −0.16）：单价一上高档，他手上没有金花以上就基本不跟。'
    + '利用方式：不管自己拿到什么，只要能把单价推到高档就一直加 —— '
    + '他每一次弃牌都把底池留给了你。同一套加压对不怕大注的人（闷牌王 R11 ×0.5）反而是送钱。',
    '跟出第一口就走不掉（lines 跟到底 2.20、看牌后跟注率 56.2%，四张卡最高）：'
    + '他一旦跟过一口就很难放手。利用方式：等他跟过一口，之后凭 s≥0.40 一路加价 —— '
    + '实测这条脚本对他的增量 +7.4k [2.0k, 12.9k]，对常人只有 −0.3k（8000 手，见 personas.md「破绽利用」）。',
    '拿大牌就忍不住加（价值加压 weight 2.80 / commit 0.60、s1Prototypes.monster 1.30、'
    + 'overconfidence 0.55）：金花以上加注率 18.8%（n=2851），同桌常人 15.2%（n=10567）；'
    + '而顺子及以下他几乎不加（0.5%，常人 0.7%）。利用方式：他一加价就等于亮牌 —— '
    + '加注区间比常人**又窄又高**，手上中等牌可以直接放掉，不用付他的价值牌。'
    + '（原话里「秒加」的**秒**这一半本期没兑现：`tempo` 目前不按牌力分档，见 personas.md「待集成」#8。）',
    '比牌随机挑人（compare.softness 0.05）+ 无记牌（rangeFidelity 0）：'
    + '他不知道谁弱，也就不会挑你。利用方式：在他还在场的池子里安心用中等牌跟到摊牌，'
    + '不必担心被针对性地开比。',
  ],
};
