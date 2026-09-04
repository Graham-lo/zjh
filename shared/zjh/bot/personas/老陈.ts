/**
 * 老陈 —— **岩石（老实人）**「只用真牌说话」（设计文档 §4.7.3 第三行）。
 *
 * 逐字对应表（原话没提到的字段一律照抄常人卡）：
 *
 * | §4.7.3 / §4.7.2 / §4.9.6 原话 | 落到哪几个字段 |
 * |---|---|
 * | 粗记牌 | `cognition.rangeFidelity 1`、`classifyOthers 'coarse'` |
 * | 1 轮前瞻 | `cognition.lookahead 1`（与常人同） |
 * | 只在顺金以上加注 | `s1Prototypes.weak 0.40 / medium 0.55`、`lines.价值加压` **删掉**、`lines.养池 1.10`、`lines.偷池` 删掉 |
 * | 只用真牌说话（要知道自己是不是真牌，就得看牌；但闷着跟一口便宜的不算「说话」） | `look.appetite 1.00`、`look.blindLove 0.90`、`look.roundWeight 0.50` |
 * | 豹子才梭哈 | `allIn.valueFloor 0.97`、`allIn.initiate 0.12` |
 * | 面对加注金花以下必弃 | `lines.弃 1.70`、`look.pressureWeight 0.45`、`allIn.accept −0.25` |
 * | 比牌只在确信时 | `compare.heads 0.80 / multi 0.88` |
 * | 比牌只在确信时（确信了就兑现）+ 只用真牌说话 / 不会演 | `compare.milk 0.20`（常人 0.55）：他不做「留着再榨两口」这种多轮的局 |
 * | 只用真牌说话 | `allIn.bluff 0`、`tempo.theatre 0.02` |
 * | §4.7.2 原话「老实人：无偷池 / 闷压」 | `lines.偷池` 缺省（= 他不会这条线）、`lines.闷压 0.02` |
 * | 加注 = 亮牌，人人可躲 | 破绽 1 |
 * | 容易被偷池 | 破绽 2 |
 * | 不上头 | `emotion.tiltTrigger 0.30 / tiltGain 0.15`、`traits.tilt {trigger .85, gain .2}` |
 * | 不记仇 | `emotion.grudge 0.05`、`compare.grudge 0.05`、`traits.decay.revenge 0.6`、`R14 0.2` |
 * | 用时随牌力单调（牌好想得久，破绽） | `tempo.leak 0.85`（**P2 无消费方，见报告「待集成」**） |
 * | 表情🙏为主 | `emotes.favourites ['🙏']` |
 * | §4.9.6 举例：R11 ×0.5、R13 ×0.2 | `traits.regularities` 两条逐字 |
 * | §4.9.6 举例：anger→foldThreshold −.2（越气越紧） | `traits.expression.anger.quitThreshold −0.2` 逐字 |
 *
 * **「只在顺金以上加注」不是门槛。** 卡里没有任何 `if (分位 ≥ 0.97) 才加注`：
 * 加注分 = `(felt − need − 人数压力) × WORTH_GAIN − 价钱 × 0.60 + 进攻性 …`，
 * 这张卡把弱牌和中等牌在**感觉上**压到 0.40 / 0.55 倍（`s1Prototypes`），
 * 并且**根本不走「价值加压」那条线**（代码里那条线的 `lineFit` 是
 * `bell(eq, 0.675, 0.13)` —— 中等胜率的加压，正是岩石不做的那件事），
 * 又把 `drives.safety` 拉到 0.75、`aggression` 那条表达通道压平，
 * 于是 `felt − need` 在顺金以下几乎不可能为正 —— 加注仍然是连续评分采样出来的，
 * 只是这条曲线在顺金以下贴着地面。验收按效果量（§6.5：顺金以下加注 < 5%）。
 */

import { COMMON_TRAITS, cloneTraits, type Traits } from '../../../mind/traits.ts';
import { COMMON_PERSONA } from './common.ts';
import type { Persona } from './types.ts';

/** 「不上头、不记仇、越气越紧」在通用特征表上的样子。 */
function traits(): Traits {
  const t = cloneTraits(COMMON_TRAITS);
  // 老实人：求安，不贪，不争面子。
  t.drives = { ...t.drives, greed: 0.15, safety: 0.75, pride: 0.20, curiosity: 0.20 };
  t.baseline = { ...t.baseline, worry: 0.15, joy: 0.05 };
  // 不上头：门槛高、增益小；不记仇：报复心消得比常人快四倍。
  t.tilt = { trigger: 0.85, gain: 0.20, recover: 2 };
  t.decay.revenge = 0.60;
  t.decay.anger = 0.40;
  // §4.9.6 逐字：anger→foldThreshold −.2（越气越紧）。
  // 另一半（怒不变成进攻）是同一句话的推论：一个「越气越紧」的人，
  // 怒不可能同时把他推向进攻，所以 aggression 从常人的 +.5 压到 +0.10。
  t.expression.anger = { ...t.expression.anger, quitThreshold: -0.20, aggression: 0.10 };
  t.regularities = {
    ...t.regularities,
    R11: 0.5,   // §4.9.6 逐字
    R13: 0.2,   // §4.9.6 逐字
    R4: 0.5,    // 只用真牌说话：投进去的钱不会替他说话
    R5: 0.3,    // 不上头，也不信「该轮到我了」
    R6: 0.4,
    R7: 0.3,    // 不上头
    R14: 0.2,   // 不记仇
    R16: 0.3,   // 只用真牌说话 —— 对没看过的牌没有幻想
    R32: 0.3,   // 不记仇：对某个人的痛感不会一直留着
  };
  t.cognition = {
    ...t.cognition,
    needForCognition: 0.45, selfControl: 0.80, willpowerMax: 7,
    willpowerRecover: 1.1, willpowerCost: 0.45,
    probWeightAlpha: 0.70, narrowFraming: COMMON_TRAITS.cognition.narrowFraming,
  };
  t.tempo = { baseMs: 420, deliberateMs: 4200, jitter: 0.30 };
  return t;
}

export const 老陈: Persona = {
  name: '老陈',

  look: {
    appetite: 1.00,        // 只用真牌说话：得先知道自己是不是真牌
    /**
     * 闷着跟一口最便宜的不叫「说话」——「只用真牌说话」管的是**下注**，
     * 不是掀不掀牌。绝对值高于常人卡的 0.50 是标定：常人卡那个数是过渡映射的
     * 基数（`index.ts` 另加 `deception × 0.26`），手写卡没有那一层。
     *
     * 上限卡在 0.90（一版写过 1.15）：再高他就开始**闷着弃牌** ——
     * 而闷着扔掉一手还没看过的牌，比闷着跟一口更不像「只用真牌说话」，
     * 他自己那句「有人加注，先看清再谈弃不弃」讲的就是这件事。
     * 实测（`tests/bots.test.ts` 的 §6.4 形状带，1000 局六人桌）：
     * 1.15 时他一个人贡献 409 次闷弃、全桌闷弃占弃牌 15.5%（验收上限 12%）；
     * 0.90 时降到 189 次、全桌 10.4%。他的看牌曲线同时变成 r1 64.2% → r2 88.4%。
     */
    blindLove: 0.90,
    pressureWeight: 0.45,  // 面对加注金花以下必弃 —— 有人加注，先看清再谈弃不弃
    costWeight: 1.20,      // 老实人：这一口越贵越要看清
    /**
     * 让他掀牌的是「有人开火了 / 这一口开始贵了」（`pressureWeight` 0.45、
     * `costWeight` 1.20），不是「又过了一轮」—— 所以轮次这一族只有常人的三分之一。
     * 实测 r1 64.2% → r2 88.4%，相邻轮跳变 24.2%（验收上限 55%）。
     */
    roundWeight: 0.50,
    tierWeight: COMMON_PERSONA.look.tierWeight,     // 原话未涉及 → 常人
    allInWeight: 0.45,     // 有人梭哈时先看牌 —— 他不会闷着接
  },

  lines: {
    // 「便宜看戏」＝花小钱留在场上看下一张脸色。常人卡给 0.10，他给 0.02：
    // 这条线的 `lineFit`（plan.ts:190）只看情绪（`ease`/`looseness`/`seekInfo`/`tilt`），
    // **不看牌力也不看价钱** —— 一个不上头、不记仇、心态最平的人反而最容易被它选中。
    // 于是常人权重下他一局里有 420 步落在这条线上，其中 238 步是弃牌（一致性只有 43%）：
    // 线路说「留下来看戏」，人物说「金花以下必弃」，两句话互相打脸。
    // 「只用真牌说话」的人本来就不买票看戏，把票价压到 0.02，这些局面回到「弃」线上，
    // 弃牌就成了照着线路打。实测（1200 局自对弈）：他在这条线上的步数 420 → 96，
    // 全桌线路一致性 88.8% → 见下方 `跟到底看` 的合并实测。
    便宜看戏: { weight: 0.005, commit: 0.30 },
    闷压: { weight: 0.02, commit: 0.42 },       // §4.7.2 原话「老实人：无…闷压」
    闷比: { weight: 0.01, commit: 0.30 },       // 比牌只在确信时，闷着谈不上确信
    // 拿到真货之后唯一的加价出口。这条线的 `lineFit` 是 `ramp(eq, 0.80, 0.06)`：
    // 胜率高到不像话才成立 —— 「只在顺金以上加注」正是这条曲线的形状。
    养池: { weight: 1.10, commit: 0.52 },
    // 「价值加压」缺省 = 他不会这条线。代码里那条线是 `bell(eq, 0.675, 0.13)`，
    // 也就是**中等胜率**的加压（一手金花、一手大对子就开始收钱）——
    // 「只在顺金以上加注」说的就是他不做这件事。实测：删掉这条线之后，
    // 顺金以下的加注占全部加注从 28.1% 掉到 0%（800 局 39 次加注）。
    // 偷池：§4.7.2 原话「老实人：无偷池」。缺省 = 他不会这条线。
    // 「跟到底看」＝看完牌就一路跟到摊牌。他只在**已经看到真牌**的时候才愿意这样，
    // 而真牌那一档归「养池」管，所以这条线对他只是残余：0.92（常人）→ 0.45。
    // 同上，常人权重下他在这条线上 107 步里有 60 步是弃牌（43%）。
    // 两处合并实测（1200 局自对弈，全桌）：线路一致性 88.8% → 90.9%，
    // 「便宜看戏」这条线的全桌一致性 85% → 89%。
    跟到底看: { weight: 0.35, commit: 0.30 },
    收口: { weight: 0.72, commit: 0.58 },       // 比牌只在确信时（0.90 → 0.72：见下）
    弃: { weight: 1.70, commit: 0.50 },         // 面对加注金花以下必弃
  },

  cognition: {
    rangeFidelity: 1,          // 粗记牌
    lookahead: 1,              // 1 轮前瞻
    readsTiming: false,        // 原话未涉及 → 常人
    classifyOthers: 'coarse',  // 粗记牌
    /**
     * 只用真牌说话：顺金/豹子在感觉上还大一点（1.10 / 1.02），
     * 金花以下则被狠狠打折（medium 0.55、weak 0.40）—— 他手里的中等牌
     * 在自己心里根本不算牌。闷着也没有幻想（blind 0.85）。
     *
     * 槽位改成按牌型取之后（`adapter.ts` 的 `protoGainOf()`）这张表的落点变了：
     * `weak` = 散牌、`medium` = 对子+顺子、`strong` = 金花、`monster` = 顺金+豹子。
     * 试过把 `strong` 一起打折（0.85 / 0.70）来兑现「只在顺金以上加注」，
     * 实测（`p3int-step4-chen-sweep.log`，各 3000 手）**几乎量不出差别**：
     * 金花的投钱率 93.9% → 90.4% → 87.8%，金花上的加注占比恒在 17% 左右，
     * 「顺金以下加注」只从 76.5% 挪到 69.8%（目标 < 6%）；
     * 代价却是第 2 轮的看牌样本掉到 200 以下，(c) 无门槛那一格直接没数据。
     * 结论：他加注太多是**线权重**的事（`lines` 里的收口/养池会在金花上开火），
     * 不是原型表的事 —— 所以这里照抄卡上原文的 1.02，不做无效偏移。
     */
    s1Prototypes: { monster: 1.10, strong: 1.02, medium: 0.55, weak: 0.40, blind: 0.85 },
  },

  /** 老实人身上几乎没有偏差；损失厌恶偏高（他怕输，所以金花以下就走）。 */
  biases: { sunkCost: 0.10, gamblersFallacy: 0.03, lossAversion: 0.45, overconfidence: 0.02 },

  compare: {
    heads: 0.80,   // 比牌只在确信时
    multi: 0.88,   // 同上，多人时更保守
    blind: 0.05,   // 闷着谈不上确信
    grudge: 0.05,  // 不记仇
    softness: 1,   // 原话未涉及 → 常人（完全按 pWin 挑）
    // 「比牌只在确信时」的另一半：确信了就兑现。「留着他再榨两口」是要演、要铺
    // 下一轮的局，而这张卡的立身之本是「只用真牌说话」（bluff 0、theatre 0.02）——
    // 他压根不做多轮的局。所以门槛虽高（很少比），一旦过了门槛就不会再犹豫。
    milk: 0.20,
  },

  allIn: {
    initiate: 0.12,          // 豹子才梭哈
    valueFloor: 0.97,        // 豹子才梭哈（评分的中心，不是门槛）
    bluff: 0,                // 只用真牌说话
    accept: -0.25,           // 面对加注金花以下必弃 —— 接梭哈同理
    blindAccept: 0.10,       // 闷着接梭哈不是他的打法
    foldEquityWeight: 0.20,  // 他不问别人跑不跑，只看自己的牌 —— 破绽 1 的另一半
  },

  /** 不上头、不记仇。 */
  emotion: { tiltTrigger: 0.30, tiltGain: 0.15, decay: 0.50, ease: 0.15, grudge: 0.05 },

  traits: traits(),

  tempo: {
    base: 420,     // 原话未涉及具体值；随「牌好想得久」一并抬高，见 leak
    dive: 4200,    // 用时随牌力单调：好牌真的会多想
    theatre: 0.02, // 只用真牌说话 = 不演
    noise: 0.04,   // 同一局面他基本给同一个答案
    leak: 0.85,    // 用时随牌力单调（牌好想得久，破绽）
    tell: 'strong-slow',  // 方向：牌越好越慢
    snapRaise: 0,         // 「只用真牌说话」的人不会为了掩饰而抢手
  },

  emotes: { rate: 0.30, favourites: ['🙏'], cap: 2 },

  leaks: [
    '加注 = 亮牌，人人可躲。怎么利用：他主动加价（或发起梭哈）的那一局，'
    + '除非自己是顺金以上，否则立刻弃 —— 他的偷池线根本不存在、bluff = 0，'
    + '加注背后没有别的解释；把这一条当成免费的读牌器，能省下他赢的每一个大池。',
    '容易被偷池。怎么利用：只要这一局他没有加注过，就每一轮往上抬一档、'
    + '不必看自己的牌 —— 弃牌线权重 1.70、金花以下的感觉被压到 0.40–0.55，'
    + '他会在金花以下规矩地退掉，池子直接收走。',
    '用时随牌力单调（牌好想得久）。怎么利用：他长考之后跟进 = 他有货，'
    + '这时候不要再加价；他秒跟 = 中等牌以下，可以继续抬。'
    + '（`tempo.leak` 在 P2 尚无消费方，见报告「待集成」。）',
  ],
};
