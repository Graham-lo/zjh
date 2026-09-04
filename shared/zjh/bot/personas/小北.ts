/**
 * 小北 —— **跟注站（看戏的）**「花钱看结果」（设计文档 §4.7.3 第四行）。
 *
 * 逐字对应表（原话没提到的字段一律照抄常人卡）：
 *
 * | §4.7.3 / §4.7.2 原话 | 落到哪几个字段 |
 * |---|---|
 * | 无记牌 | `cognition.rangeFidelity 0`、`classifyOthers 'none'` |
 * | 0 轮前瞻 | `cognition.lookahead 0` |
 * | 闷跟到升档 | `look.blindLove 1.12`、`look.tierWeight 1.60`、`look.roundWeight 0.40`（掀牌看的是**档位**不是轮次）、`allIn.blindAccept 0.70`、`R16 1.5` |
 * | 看牌后只要不是散牌就跟到摊牌 | `lines.跟到底看 2.20 / commit 0.95`、`lines.弃 0.30`、`s1Prototypes.medium 1.30 / weak 1.25` |
 * | 花钱看结果 → 他不心疼这口钱 | `drives.boredom 0.90`、`drives.safety 0.05`、`baseline.joy 0.30`、`expression.joy.looseness 0.90 / seekInfo 0.25`（另有 `traits.ease {trigger .15, gain 1.4}`，待接线） |
 * | 很少加 | `lines.价值加压 0.10`、`lines.闷压 0.05`、`s1Prototypes.monster/strong` 压平 |
 * | 很少比 | `compare.heads 0.90 / multi 0.95`、`lines.闷比 0.02`、`lines.收口 0.10` |
 * | 0 轮前瞻 + 花钱看结果（他不盘算下一轮，也不主动收割） | `compare.milk 0.40`（常人 0.55）：略偏「看到结果」，但比岩石/数学型那种主动落袋高 |
 * | 不梭哈 | `allIn.initiate 0.005`、`allIn.valueFloor 0.99` |
 * | 花钱看结果 | `look.costWeight 0.30`、`drives.curiosity 1.00`、`lines.便宜看戏 1.60` |
 * | 偷不动 | 破绽 1（弃牌线权重 0.30） |
 * | 任何价值加注他都付 | 破绽 1（`R11 0.2`、`foldEquityWeight 0.05`） |
 * | 他的跟注不带信息 | 破绽 2 |
 * | 情绪平 | `emotion.*` 全线压平、`traits.sensitivity` 0.45、各项 `decay` 加快 |
 * | 用时短 | `tempo.base 240 / dive 600`、`traits.tempo` |
 * | 表情😂🤔 | `emotes.favourites ['😂','🤔']`（原话逐字） |
 *
 * **「很少加、很少比、不梭哈」不是三条门槛。** 这三件事分别由线路权重
 * （价值加压 0.10、收口 0.10、闷比 0.02）、比牌门槛（0.90 / 0.95）和
 * `allIn.initiate 0.02` 这些**连续项**压下去；候选动作一个都没少，
 * 他每一步仍然在全部候选之间按分数采样，只是加注/比牌/梭哈这三支常年排不进第一。
 * 验收按效果量（§6.5：给出加注率 / 比牌率 / 梭哈率的数）。
 */

import { COMMON_TRAITS, cloneTraits, type Traits } from '../../../mind/traits.ts';
import { COMMON_PERSONA } from './common.ts';
import type { Persona } from './types.ts';

/** 「情绪平 + 花钱看结果 + 用时短」在通用特征表上的样子。 */
function traits(): Traits {
  const t = cloneTraits(COMMON_TRAITS);
  // 花钱看结果：好奇是他唯一强的驱力；不贪、不争、也不特别求安（求安的人会弃牌）。
  // 「看戏的 / 花钱看结果」：好奇拉满，求安压到底 —— 求安的人会站起来走，
  // 他不会。`boredom` 是「闲不住」那一股：它同时进 `looseness`（直接 ×0.30，
  // 再经 `expression.boredom` ×0.40）和 `delayInfo`，正好是「闷着跟、别催我看牌」。
  t.drives = { ...t.drives, curiosity: 1.00, greed: 0.15, pride: 0.10, safety: 0.05, boredom: 0.90 };
  /**
   * 「情绪平」不等于「没有情绪」：每一件事都不放大（`sensitivity` 全线 0.45）、
   * 当局就消（`decay` 全线 0.60），但**底色是乐呵的** —— 人物文字给他的表情是
   * 😂🤔，他是来看戏的，不是来算账的。所以基线喜悦不压到零而是 0.30。
   *
   * 这个数不是随手定的，它同时被两句人物文字夹住：
   *   下界 —— (d) 情绪验收要求「宽裕」这一档跟别的心情分得开。喜悦是本卡唯一
   *   还活着的情绪出口（怒被 `tilt.gain 0.15` 掐掉、怕被 `expression.fear` 掐掉），
   *   基线太低时「平静」和「宽裕」这两档就是同一张脸，量到 0 位移。
   *   上界 —— 「闷跟到升档」。喜悦经 `expression.joy.seekInfo` 变成「早点翻牌」，
   *   基线一高就常年提前掀牌，那句话当场失效。
   * 0.30 落在两者之间：实测各轮看牌率 r1 13.9% → r2 30.2% → r3 80.7%，
   * 拐点仍在自动升档的第 3 轮上（原话），而「平静↔宽裕」的位移是 4.3%（下界 4%）。
   */
  t.baseline = { joy: 0.30, anger: 0, worry: 0.05, rumination: 0, sorrow: 0, fear: 0.05, surprise: 0 };
  /**
   * 喜悦的出口只剩一条 —— 「更想看」。人物文字把另外三条都堵死了：
   * 「很少加」不许它变成加注、「很少比」不许它变成比牌、「不梭哈」不许它变成梭，
   * 而「跟」他平常就已经跟满了（宽裕再松也松不出新动作）。剩下和人设对得上的
   * 只有那句「花钱看结果」：手气顺的时候他更舍得早点花这笔钱把牌翻开。
   * `seekInfo 0.25` 是配着上面那条 0.30 基线定的：平时只折出 0.075 的提前量
   * （「闷跟到升档」照旧，见上面的三轮看牌率），真顺起来（喜 0.9）才折出 0.225，
   * 也就是「顺的时候他更舍得早点把牌翻开看结果」。松弛仍是 0.90（常人 .3）。
   */
  t.expression.joy = { ...t.expression.joy, looseness: 0.90, seekInfo: 0.25 };
  /**
   * 「偷不动」（§4.7.3 破绽第一句）在通用表上就是这一条：常人卡的
   * `expression.fear.quitThreshold` 是 −0.50 —— 怕起来更容易弃牌，
   * 这正是「被偷池偷走」的那条路径。他身上不许有这条路径：怕归怕，
   * 手还是会把筹码推出去（「花钱看结果」），所以只留 −0.10 的残余
   * （不清零：他不是没有恐惧，只是恐惧不通向弃牌）。
   * 实测（四种心情 × 9 个钉死局面 × 60 个种子）：−0.50 时他在「怕」下的
   * 弃牌率 33.0%，比赌徒阿凯（29.5%）还高，跟「偷不动」正好相反；
   * −0.10 之后是 23.2%，四张卡里最低（阿杰 35.2% / 阿凯 26.6% / 老陈 41.6%）。
   */
  t.expression.fear = { aggression: -0.60, quitThreshold: -0.10, seekInfo: 0.20, tempo: -0.2, showoff: -0.40 };
  /**
   * `seekInfo` 同样要压：常人怕起来 +0.40、忧 +0.30，合起来是「先花钱买个信息」。
   * 他买的不是信息，是**结果**（「花钱看结果」）—— 这两件事在这张卡上必须分开，
   * 否则一怕就掀牌、掀开发现是散牌就弃，「偷不动」当场反过来。
   * 实测：常人那套增益下他在「怕」里弃牌率 32.6%，比赌徒（28.4%）还高；
   * 压到 `fear.seekInfo 0.20` / `worry.seekInfo 0.15` 之后落回四张卡里最低的
   * 一档（23.2%，见 (d) 测试打印的数）。
   */
  t.expression.worry = { looseness: -0.10, seekInfo: 0.15 };
  t.sensitivity = { valence: 0.45, magnitude: 0.45, expectancy: 0.45, agency: 0.45, controllability: 0.45 };
  t.decay = { ...t.decay, joy: 0.60, anger: 0.60, worry: 0.60, rumination: 0.60, sorrow: 0.60, revenge: 0.60 };
  t.tilt = { trigger: 0.90, gain: 0.15, recover: 1 };
  /**
   * 他不把筹码当回事：一点点顺风就够他松下来。
   * **注意**：`ease.trigger` / `ease.gain` 这一期还没有消费方（`shared/mind/`
   * 里只有 `tilt.gain` 被 R7 读走），所以「偷不动 / 任何价值加注他都付」
   * 真正的落点是上面的 `drives.safety 0.05` + `baseline.joy 0.30`
   * + `expression.joy.looseness 0.90` 这一串；这两个数按人物写在这里，
   * 等接线，见报告的「待集成」清单。
   */
  t.ease = { trigger: 0.15, gain: 1.40 };
  t.regularities = {
    ...t.regularities,
    R11: 0.2,   // 任何价值加注他都付 —— 大注吓不动他
    R16: 1.5,   // 闷跟到升档：闷着的那手牌在他心里越闷越好
    R1: 0.5,    // 情绪平：输赢相对参照点的痛感淡
    R7: 0.2,    // 情绪平：bad beat 也不上头
    R8: 0.2,    // 他没有诈唬可被抓
    R13: 0.2,   // 他从不连续弃牌，手痒无从谈起
    R14: 0.2,   // 情绪平：不争面子
    R22: 0.2,   // 情绪平：也谈不上「想要一个小而稳的赢」
  };
  // 无记牌、0 轮前瞻 = 他几乎不开系统 2；用时短是同一件事的外观。
  t.cognition = {
    ...t.cognition,
    needForCognition: 0.05, selfControl: 0.30, willpowerMax: 3,
    willpowerRecover: 0.6, willpowerCost: 0.80,
    probWeightAlpha: 0.55, narrowFraming: 0.95,
  };
  t.tempo = { baseMs: 240, deliberateMs: 700, jitter: 0.25 };
  return t;
}

export const 小北: Persona = {
  name: '小北',

  look: {
    appetite: 0.55,        // 闷跟到升档：他不急着看
    blindLove: 1.12,       // 同上 —— 闷着只掏一半，正合「花钱看结果」的胃口
    pressureWeight: 0.05,  // 别人加注不会催他看牌（任何价值加注他都付）
    costWeight: 0.30,      // 花钱看结果：价钱不是他的输入
    /**
     * 闷跟到**升档** —— 让他掀牌的是档位（`tierWeight` 1.60），不是轮次。
     * 0.40 是常人 1.50 的四分之一强：这句话要求「又过了一轮」几乎不推他，
     * 否则第 2 轮就被轮次推着掀了牌，「闷跟到升档」就成了「闷跟一轮」。
     * 实测各轮看牌率 r1 13.9% → r2 30.2% → r3 80.7%（自动升档正好发生在第 3 轮），
     * 曲线的拐点落在升档那一轮上，与原话一致；相邻轮最大跳变 50.5%
     * （验收上限 55%）。
     */
    roundWeight: 0.40,
    tierWeight: 1.60,      // 闷跟到**升档**：档位是唯一让他掀牌的推力
    allInWeight: COMMON_PERSONA.look.allInWeight,   // 原话未涉及 → 常人
  },

  lines: {
    便宜看戏: { weight: 1.60, commit: 0.50 },   // 看戏的 —— 这条线就是他的名字
    闷压: { weight: 0.05, commit: 0.42 },       // 很少加
    闷比: { weight: 0.02, commit: 0.30 },       // 很少比
    养池: { weight: 0.35, commit: 0.52 },       // 很少加：做池子也是加价
    价值加压: { weight: 0.10, commit: 0.40 },   // 很少加
    // 偷池：他从不拿弱牌抬价（「很少加」+ 没有诈唬），缺省 = 不会这条线。
    // 「跟到摊牌」= 这条线一旦定下就不改主意，所以 commit 高（0.90）：
    // `lineBias` 给「跟」+1.0、给「弃」−0.55，乘上 commit 才是「跟到底」。
    // 0.95 是四张卡里最高的 commit —— 「跟到摊牌」就是「这条线定了不改」本身，
    // 文档没给数，取上沿。**它不是效果的来源**：实测 0.90 → 0.95 只把金花档继续率
    // 从 79.2% 抬到 79.6%、跟注判别力从 8.1% 压到 8.4%（老油条 47.7% / 常人 34.7%），
    // 真正做出这两句话的是 weight 2.20 和「弃」线 0.30。
    跟到底看: { weight: 2.20, commit: 0.95 },
    收口: { weight: 0.10, commit: 0.58 },       // 很少比
    弃: { weight: 0.30, commit: 0.50 },         // 跟到摊牌 —— 偷不动
  },

  cognition: {
    rangeFidelity: 0,        // 无记牌
    lookahead: 0,            // 0 轮前瞻
    readsTiming: false,      // 无记牌的人也不读用时
    classifyOthers: 'none',  // 无记牌（§4.7.2「谁都当常人」的那一档）
    /**
     * 「看牌后只要不是散牌就跟到摊牌」—— 原型槽位改成按牌型取之后（`adapter.ts`
     * 的 `protoGainOf()`），这句话可以**逐字**落进表里：`medium` 槽装的就是
     * 「对子 + 顺子」，抬到 1.30；`weak` 槽现在只剩散牌，正是他唯一会扔的那一档，
     * 所以压到 0.90（旧值 1.25 是在旧发牌档下写的 —— 那时 `weak` 槽装的是
     * 「散牌 + 对子 + 顺子 + 半个金花」，只能整档抬才盖得住「非散牌」）。
     * 「很少加」= 强牌和豹子在他感觉里也没有大到该加价（1.00 / 0.95）——
     * 对子往上他对牌力的感觉是**平的**，这正是「他的跟注不带信息」的来源。
     * 闷着那手牌越闷越好（blind 1.10，R16 再加一次）。
     */
    s1Prototypes: { monster: 0.95, strong: 1.00, medium: 1.30, weak: 0.90, blind: 1.10 },
  },

  /** 花钱看结果：沉没成本中等偏高（已经付过就想看完），其余都淡。 */
  biases: { sunkCost: 0.45, gamblersFallacy: 0.10, lossAversion: 0.10, overconfidence: 0.05 },

  compare: {
    heads: 0.90,   // 很少比
    multi: 0.95,   // 很少比
    blind: 0.05,   // 很少比，闷着更不比
    grudge: 0.05,  // 情绪平
    softness: 1,   // 原话未涉及 → 常人
    // 「无记牌、0 轮前瞻」：他根本算不出「留着他下一轮还能榨多少」这笔账，
    // 而「花钱看结果」说的是他要的就是结果本身。两句都往低走。
    // 但他也不是主动收割的人（很少比、很少加），所以只落到常人下面一档，
    // 不到岩石（0.20）/ 数学型（0.25）那种「确信就兑现」的位置。
    milk: 0.40,
  },

  allIn: {
    initiate: 0.005,         // 不梭哈（原话是一句没有余地的话，取近乎零）
    valueFloor: 0.99,        // 不梭哈：连价值梭的中心也顶到近乎不可达
    bluff: 0,                // 不梭哈，更不会诈唬梭
    accept: 0.20,            // 花钱看结果：别人梭了，他想看结果
    blindAccept: 0.70,       // 闷跟到升档 —— 闷着接梭哈按半价，正合他的账
    foldEquityWeight: 0.05,  // 他不问别人跑不跑（他自己也基本不加）
  },

  /** 情绪平。 */
  emotion: { tiltTrigger: 0.40, tiltGain: 0.10, decay: 0.55, ease: 0.05, grudge: 0.05 },

  traits: traits(),

  tempo: {
    base: 240,     // 用时短
    dive: 600,     // 用时短：边缘局面也不下潜（他不算账）
    theatre: 0.05, // 不演
    noise: 0.06,   // 原话未涉及；略高于常人，因为他基本不算账
    leak: 0,       // 用时短且平，不泄露牌力
    tell: 'none',  // 「用时短」是均值，不是形状：他的用时和牌力无关
    snapRaise: 0,  // 「很少加」，谈不上秒加
  },

  emotes: { rate: 0.55, favourites: ['😂', '🤔'], cap: 3 },

  leaks: [
    '偷不动，但任何价值加注他都付。怎么利用：对他一次都不要诈唬（弃牌线权重 0.30、'
    + 'R11 ×0.2，抬价只是把钱送进他的池子）；换成只在金花以上一档一档往上加，'
    + '他每一档都会跟到摊牌 —— 同一手真牌从他身上榨到的钱比从任何人身上都多。',
    '他的跟注不带信息。怎么利用：读牌时把他的跟注当零信息（他的 s1 原型表是平的：'
    + '强牌 1.00、中等 1.30，跟注与牌力无关）；多人池里比牌不要挑他 —— '
    + '他跟到摊牌的范围最宽，`pWin` 反而不低，挑他之外的人才是挑最弱。',
  ],
};
