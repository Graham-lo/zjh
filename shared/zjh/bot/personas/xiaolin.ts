/**
 * 小林 —— 数学型（算账的）。设计文档 §4.7.3 第 4 行。
 *
 * 原话（逐句拆到下面每一个字段上）：
 *   打法要点：「每一口都算赔率。细记牌、2 轮前瞻、按条件归类别人；
 *              严格按 EV 跟/弃/加；加注档位按目标底池选；梭哈按 fold-equity 决定要不要梭」
 *   破绽：    「太可预测：他的加注档位就是他的牌力区间；
 *              不会演，用时 = 计算难度，读得出他在边缘」
 *   情绪与表演：「不上头；表情几乎没有；被诈唬成功后会记下这个人并收紧对他的范围」
 *
 * 字段 → 原话的对应：
 *   cognition.rangeFidelity 2                     ← 「细记牌」
 *   cognition.lookahead 2                         ← 「2 轮前瞻」
 *   cognition.classifyOthers 'fine'               ← 「按条件归类别人」
 *   cognition.s1Prototypes 全 1.00                ← 「每一口都算赔率」：他的直觉不加滤镜，
 *                                                    看到的牌力就是牌力（常人是 1.06/0.98/0.96/1.05）
 *   tempo.noise 0.015                             ← 「严格按 EV 跟/弃/加」：性格噪声压到最小，
 *                                                    评分最高的那一个几乎一定被选中
 *   traits.cognition.probWeightAlpha 0.95         ← 同上，概率权重几乎不扭曲（常人 0.65）
 *   traits.cognition.needForCognition 0.95        ← 「每一口都算」：系统 2 介入率最高
 *   allIn.foldEquityWeight 1.00                   ← 「梭哈按 fold-equity 决定要不要梭」
 *   allIn.valueFloor 0.86 / allIn.bluff 0.02      ← 「加注档位就是他的牌力区间」的另一面
 *   lines.偷池 0.42 / lines.闷压 0.10 / 闷比 0.02 ← 「不会演」
 *   compare.milk 0.25                             ← 「严格按 EV 跟/弃/加」+「不会演」：
 *                                                    优势确定就落袋，不为「下一轮还能榨多少」
 *                                                    这笔要靠演才能兑现的钱多担一轮方差（常人 0.55）
 *   tempo.theatre 0.02                            ← 「不会演」
 *   tempo.leak 0.95 / traits.tempo.jitter 0.12    ← 「用时 = 计算难度，读得出他在边缘」：
 *                                                    用时几乎没有随机成分，全部来自难度
 *   traits.tempo.deliberateMs 4200                ← 同上，边缘局面他真的会想很久
 *   emotion.tiltTrigger 0.30 / tiltGain 0.15      ← 「不上头」
 *   emotes.rate 0.02                              ← 「表情几乎没有」
 *   emotion.grudge 0.30 / compare.grudge 0.15     ← 「被诈唬成功后会记下这个人」——
 *                                                    记，但用在读牌上，不是用来找人比牌
 */

import { COMMON_TRAITS, cloneTraits } from '../../../mind/traits.ts';
import type { Persona } from './types.ts';

const traits = cloneTraits(COMMON_TRAITS);

// 「不上头」：整条情绪链条压平 —— 触发点抬高、增益压低、气消得快。
traits.tilt = { trigger: 0.80, gain: 0.20, recover: 2 };
// 「不上头」说的是怒，不是喜：赢多了他也会松，只是要赢到**确实**宽裕才松（trigger 0.60，
// 常人 0.45），而且松得有限（gain 0.70，常人 1.0）。压成 0 就不是冷静的人，是一块石头。
traits.ease = { trigger: 0.60, gain: 0.85 };
traits.baseline = { joy: 0.05, anger: 0, worry: 0.05, rumination: 0, sorrow: 0, fear: 0.04, surprise: 0 };
traits.decay.anger = 0.60;
traits.decay.rumination = 0.60;
traits.decay.worry = 0.55;
// 「被诈唬成功后会记下这个人」：记得住（衰减比常人慢一点点），但比复仇者快得多。
traits.decay.revenge = 0.30;
// 气起来也只是稍微紧一点，绝不会更冲 —— 「严格按 EV」在情绪表达上的样子。
traits.expression.anger = { ...traits.expression.anger, aggression: 0.05, quitThreshold: 0.05 };
// 「怕」对他不是不敢下注，而是**把这笔账重新算一遍**：先花钱买信息（看牌），
// 算不过就扔。所以恐惧这一路他比常人更明显地走向「买信息 + 弃牌」，而不是走向僵住。
traits.expression.fear = { aggression: -0.55, quitThreshold: -0.85, seekInfo: 0.65, tempo: -0.2 };
// 「宽裕」他会松手，但绝不会因此想表演给谁看 —— 炫耀那一路压到接近 0。
traits.expression.joy = { looseness: 0.50, greed: 0.55, showoff: 0.05 };
// 「每一口都算赔率」在通用层就是：几乎不受这些认知偏差摆布。
traits.regularities.R1 = 0.6;    // 损失厌恶
traits.regularities.R4 = 0.15;   // 沉没成本 —— 他从不为已经投进去的钱付钱
traits.regularities.R5 = 0.10;   // 赌徒谬误
traits.regularities.R6 = 0.40;   // 热手
traits.regularities.R11 = 0.50;  // 面对大注的怯：大注对他只是一个数字
traits.regularities.R13 = 0.30;  // 无聊求刺激
traits.regularities.R16 = 0.30;  // 对暗牌的幻想：他知道那只是一个先验分布
traits.regularities.R23 = 0.30;  // 锚定
traits.regularities.R18 = 0.40;  // 归因偏差：他复盘的是牌不是运气
/*
 * R9 取**负**：常人被诈成功之后对那个人跟得更轻（§4.9.4 R9「下次对他跟得更轻」），
 * 他反过来 —— §4.7 数学型那一行写的是「被诈唬成功后会记下这个人并**收紧**对他的范围」。
 * 他不是被唬毛了，是把这个人重新归了一类：这人敢无牌开火，那我在他面前的边缘牌
 * 就更不值钱。负系数就是「同一条规律在这个人身上反着走」，和 R8 那行
 * 「天性偏向可反转为『加倍演』」是同一个装置。
 */
traits.regularities.R9 = -1.6;
traits.sensitivity.magnitude = 0.70;
traits.sensitivity.expectancy = 0.80;
traits.drives = { greed: 0.22, pride: 0.20, safety: 0.42, curiosity: 0.45, boredom: 0 };
traits.cognition = {
  needForCognition: 0.95,   // 「每一口都算」
  selfControl: 0.90,
  willpowerMax: 9,          // 算一整晚也不塌（R30 自我损耗的容量）
  willpowerRecover: 1.4,
  willpowerCost: 0.30,
  probWeightAlpha: 0.95,    // 「严格按 EV」：Prelec 权重几乎是恒等
  narrowFraming: 0.25,      // 他看的是长期，不是这一局
};
// 「用时 = 计算难度」：抖动 0.12（常人 0.35），难度那一项 4200ms（常人 3200）——
// 于是他的用时几乎是难度的单调函数，别人真的读得出他在边缘。
traits.tempo = { baseMs: 640, deliberateMs: 4200, jitter: 0.12 };

export const XIAOLIN: Persona = {
  name: '小林',

  // 「每一口都算赔率」：信息是有价的，而看牌是这张桌上最便宜的信息。
  look: {
    appetite: 0.80,        // 常人 0.90 —— 看牌的价值他是**真算**出来的（lookahead 2），
                           //             不需要额外的胃口去顶
    blindLove: 0.52,       // 常人 0.50 —— 闷牌的「便宜」在他眼里已经折进 EV 了，不额外加减
    pressureWeight: 0.30,
    costWeight: 1.05,
    // 常人 1.50 → 0.10：轮次是**习惯**那一层的推力，而习惯正是他没有的东西。
    // 「每一口都算赔率」意味着「又打了一轮」本身不构成看牌的理由 ——
    // 该看的第 1 轮就算出来看了，还闷着的那些局面是算下来闷着更好的局面，
    // 多走一轮并不改变那笔账。
    roundWeight: 0.10,
    tierWeight: 0.95,
    allInWeight: 0.55,     // 有人梭哈 = 这一眼最值钱的时刻
  },

  lines: {
    便宜看戏: { weight: 0.12, commit: 0.30 },  // 便宜也要算得过才玩
    闷压: { weight: 0.10, commit: 0.40 },      // 「不会演」
    闷比: { weight: 0.02, commit: 0.30 },      // 「不会演」
    养池: { weight: 1.10, commit: 0.62 },      // 「加注档位按目标底池选」
    价值加压: { weight: 1.35, commit: 0.52 },  // 同上：他的加注都是价值
    偷池: { weight: 0.42, commit: 0.85 },      // 算得过才偷；算过的偷池他认得极死
    跟到底看: { weight: 0.65, commit: 0.34 },
    收口: { weight: 1.20, commit: 0.66 },
    弃: { weight: 2.05, commit: 0.62 },        // 「严格按 EV 跟/弃/加」：算不过就走，不留恋
  },

  cognition: {
    rangeFidelity: 2,        // 「细记牌」
    lookahead: 2,            // 「2 轮前瞻」
    readsTiming: false,      // 他读的是频率和赔率，不是别人的表情
    classifyOthers: 'fine',  // 「按条件归类别人」
    s1Prototypes: { monster: 1.00, strong: 1.00, medium: 1.00, weak: 1.00, blind: 1.00 },
  },

  biases: { sunkCost: 0.08, gamblersFallacy: 0.02, lossAversion: 0.12, overconfidence: 0.02 },

  compare: {
    heads: 0.58,
    multi: 0.70,
    blind: 0.20,   // 「不会演」：闷着开比是演出来的动作
    grudge: 0.15,  // 「记下这个人」用在范围上，不用在挑谁比牌上
    softness: 1,
    // 「严格按 EV 跟/弃/加」：确定的优势就该兑现；「再榨两口」那笔钱要靠演、靠对手
    // 下一轮继续犯错才拿得到，而他自己「不会演」（theatre 0.02、bluff 0.02），
    // 拿不到这笔钱就不该把它计进账里。所以明显低于常人 0.55。
    milk: 0.25,
  },

  allIn: {
    initiate: 0.40,
    valueFloor: 0.86,        // 「他的加注档位就是他的牌力区间」
    bluff: 0.02,             // 「不会演」
    accept: 0,
    blindAccept: 0.15,
    foldEquityWeight: 1.00,  // 「梭哈按 fold-equity 决定要不要梭」
  },

  emotion: { tiltTrigger: 0.30, tiltGain: 0.15, decay: 0.55, ease: 0.10, grudge: 0.30 },

  traits,

  tempo: {
    base: 640,    // 「每一口都算赔率」：他连最便宜的一口都要先算一遍
    dive: 4200,   // 「用时 = 计算难度」
    theatre: 0.02,
    noise: 0.015, // 「严格按 EV」
    leak: 0.95,   // 破绽：他的用时几乎等于他的难度
    tell: 'edge-slow',  // 「用时 = 计算难度，读得出他在边缘」：两极快、中间慢
    snapRaise: 0,       // 「不会演」，也不会因为牌好就手快
  },

  emotes: { rate: 0.02, favourites: ['🤔'], cap: 1 },

  leaks: [
    '加注档位就是他的牌力区间 —— **信息层成立，钱上不成立**：他选的档位与手上牌力的'
    + '相关系数 r=0.288，同桌常人只有 0.164（四张卡里只有他的档位真的跟着牌力走：'
    + '老王 −0.101、小雨 0.035、阿彪 −0.065）。但这条读数换不成钱：顶档（10 万）均牌力 0.731、'
    + '低档只有 0.652–0.668，只差 0.06 分位，任何「跟着这个读数弃边缘牌」的脚本都是**负增量**'
    + '（顶档才折 0.85 → −3.7k；不分档折 0.85 → −5.3k，8000 手）。'
    + '要让它变成钱需要核心改动（档位与牌力的幅度至少差 0.15 分位），见 personas.md「待集成」#6。',
    '太可预测：诈唬 0.02、性格噪声 0.015、偷池线只有 0.42，他加注就是有牌，'
    + '他弃牌就是真的没牌（实测诈唬率 0.2%、弃牌率 40.5%）。利用方式：他不开火的池子随便偷 —— '
    + '但**同一条偷池脚本打常人赢得一样多**（靶子增量 +4.7k vs 对照 +5.8k），'
    + '所以这是引擎的通用性质，不是他一个人的破绽。数学型在当前引擎里的破绽是**被动**的：'
    + '弃得太多本身就是漏洞，不需要脚本去打。',
    '不会演，用时 = 计算难度（tempo.leak 0.95、traits.tempo.jitter 0.12、deliberateMs 4200）：'
    + '他想得越久说明他越在边缘。利用方式：他长考之后加压，他弃牌的概率最高。'
    + '**本期 tempo.leak 在 shared/ 里没有任何消费方**（见 personas.md「待集成」#4），'
    + '所以这条破绽的验收脚本连打都打不了。',
  ],
};
