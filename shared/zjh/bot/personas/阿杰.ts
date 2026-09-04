/**
 * 阿杰 —— **老油条（紧凶）**「打了二十年的老手」（设计文档 §4.7.3 第一行）。
 *
 * 这张卡上的每一个数都来自 §4.7.3 那一行的原话，逐条对应关系写在下面；
 * **原话没有提到的字段一律照抄常人卡**（`COMMON_PERSONA` / `COMMON_TRAITS`），
 * 不凭想象加偏斜 —— 人物卡写的是「这个人是怎么个人」，不是调参。
 *
 * | §4.7.3 原话 | 落到哪几个字段 |
 * |---|---|
 * | 细记牌 | `cognition.rangeFidelity 2`、`classifyOthers 'fine'` |
 * | 2 轮前瞻 | `cognition.lookahead 2` |
 * | 读用时 | `cognition.readsTiming true` |
 * | 起手紧 | `s1Prototypes.weak/medium` 压低 + `lines.弃 1.75`（弱牌感觉更弱、更愿意扔）、`look.appetite 1.05`（要扔得先看清） |
 * | 拿到货就加压 | `lines.价值加压 1.35`、`s1Prototypes.strong/monster` 不打折 |
 * | 比牌只挑最弱 | `compare.softness 1`（= 完全按 pWin 挑，常人值即此意） |
 * | 升档偷池挑软桌 | `lines.偷池 0.60`、`allIn.foldEquityWeight 0.95`（「挑软桌」= 看对面会不会跑） |
 * | 单挑收口快 | `lines.收口 1.45 / commit 0.70`、`compare.heads 0.46` |
 * | 单挑收口快 + 太理性（逮着优势先兑现，不指望下一轮）/ 升档偷池挑软桌（软桌值得留着） | `compare.milk 0.50`（常人 0.55 —— 只比常人低一点：前一句往兑现拉，后一句往留人拉） |
 * | 太理性：面对连续加压会规矩地弃 / 不为看结果花钱 | `lines.弃 1.75`、`lines.跟到底看 0.72`、`traits.regularities.R4 0.5`、`R33 0.3`（`lines.便宜看戏` 保持常人的 0.10 —— 这一句已经由前三项承担，没有再压的理由） |
 * | 能被反复偷 | 破绽 1（利用脚本见 `leaks`） |
 * | 几乎不闷比 | `lines.闷比 0.01`（「几乎不」= 极小但不是零）、`compare.blind 0.05` |
 * | 读用时 / 2 轮前瞻（掀牌的理由是信息值不值，不是「打到第几轮了」） | `look.roundWeight 0.85`（低于常人）、`look.blindLove 1.15`（闷牌半价这笔账他算得清） |
 * | 闷牌王能压他 | 破绽 2 |
 * | 几乎不上头 | `emotion.tiltTrigger 0.20 / tiltGain 0.35`、`traits.tilt {trigger .72, gain .35}` |
 * | 被抓一次后两局只用真牌 | `traits.regularities.R8 2.0`（R8 = 诈唬被抓 → 收紧） |
 * | 用时稳定 | `tempo.noise 0.03`、`tempo.leak 0`（用时不泄露牌力） |
 * | 偶尔演 | `tempo.theatre 0.18` |
 * | 表情极少 | `emotes.rate 0.05 / cap 1`；偏好 👍 取自 §4.7.2「老油条：几乎不做，偶尔👍」 |
 *
 * 这张卡里**没有任何门槛**：「起手紧」不是「分位 < x 就弃」，是原型表把弱牌
 * 感觉得更弱 + 弃牌线权重更高，最后仍然由连续评分和采样决定；
 * 「单挑收口快」也不是「人数 == 2 就比牌」，是收口线的权重和单挑比牌门槛。
 */

import { COMMON_TRAITS, cloneTraits, type Traits } from '../../../mind/traits.ts';
import { COMMON_PERSONA } from './common.ts';
import type { Persona } from './types.ts';

/** 「太理性 + 几乎不上头 + 被抓一次后两局只用真牌」在通用特征表上的样子。 */
function traits(): Traits {
  const t = cloneTraits(COMMON_TRAITS);
  // 几乎不上头：怒的门槛高、增益小，而且消得快。
  t.tilt = { trigger: 0.72, gain: 0.35, recover: 2 };
  t.decay.anger = 0.50;
  t.decay.rumination = 0.50;
  t.decay.revenge = 0.45;
  // 「太理性」= 怒不怎么变成动作：既不冲，也不硬扛（常人是 +.5 / +.4）。
  t.expression.anger = { ...t.expression.anger, aggression: 0.25, quitThreshold: 0.15 };
  // 「宽裕」（§4.9.2 里那条「同样的喜，有人变成放松、有人变成加码」）：
  // 老油条赢着的时候不会变松、更不会显摆 —— 人物文字给的是「表情极少（👍）」
  // 和「紧凶」，加上 §4.9.8 R33「看的是整场不是这一手」。手气顺 = 本场的余量变大，
  // 他把余量花在**多压一手价值**上，而不是多玩几手烂牌：
  // 松弛 .10（常人 .3，他几乎不松）、显摆 .05（常人 .3，他不亮相）、
  // 贪 .45 与进攻 .45（顺风时更敢压，这是他唯一的表达出口）。
  t.expression.joy = { looseness: 0.10, greed: 0.45, showoff: 0.05, aggression: 0.45 };
  t.regularities = {
    ...t.regularities,
    R4: 0.5,    // 太理性：已经投进去的钱不参与这一口的判断
    R5: 0.3,    // 连输不会让他觉得「该轮到我了」
    R6: 0.4,    // 连赢也不会让他上头
    R13: 0.4,   // 手不痒：二十年了，等得起
    R16: 0.3,   // 太理性：对「还没看的那手牌」不抱幻想（幻想是别人的破绽）
    R8: 2.0,    // 被抓一次后两局只用真牌
    R33: 0.3,   // §4.9.8 R33 原话：「常人只看这一手…老油条相反」
  };
  // 二十年的老手：爱算账、自控强、意志力厚、概率扭曲小、看的是整场不是这一手。
  t.cognition = {
    ...t.cognition,
    needForCognition: 0.90, selfControl: 0.85, willpowerMax: 8,
    willpowerRecover: 1.3, willpowerCost: 0.40,
    probWeightAlpha: 0.85, narrowFraming: 0.25,
  };
  return t;
}

export const 阿杰: Persona = {
  name: '阿杰',

  look: {
    appetite: 1.05,          // 起手紧：要把弱牌扔掉，先得看清自己是什么
    /**
     * 「几乎不闷比」说的是**闷着比牌**（`lines.闷比`），不是闷着跟 ——
     * 闷牌只掏一半钱，这笔账二十年的老手算得比谁都清，所以他闷得住。
     * 数值高于常人卡的 0.50：常人卡那个 0.50 是**过渡映射的基数**
     * （`personas/index.ts` 还会给它加 `deception × 0.26`），手写卡没有那一层，
     * 中性点本来就要往上抬（实测：0.50 → 第 1 轮看牌率 85%，逼近 §6.4 的上界）。
     */
    blindLove: 1.15,
    pressureWeight: 0.34,    // 读用时/读局面：有人开火，先把自己的牌看清
    costWeight: 1.00,        // 太理性：这一口越占身家，越要先知道自己是什么
    // 「读用时、2 轮前瞻」：让他掀牌的是**这一眼值不值**，不是「又过了一轮」。
    // 所以轮次这一族的磨损比常人低。
    roundWeight: 0.85,
    tierWeight: COMMON_PERSONA.look.tierWeight,     // 原话未涉及 → 常人
    allInWeight: COMMON_PERSONA.look.allInWeight,   // 原话未涉及 → 常人
  },

  lines: {
    // 「便宜看戏」＝掏一口小钱留在场上看下一张脸色。这条线的 `lineFit`（plan.ts:190）
    // 只看情绪（`ease`/`looseness`/`seekInfo`/`tilt`），**不看牌力也不看价钱**，
    // 所以一个「几乎不上头」的人反而最容易被它选中。可是「太理性：不为了看结果花钱」
    // 这句话（同一句话已经把 `跟到底看` 压到 0.72）说的正是他不买这张票：
    // 常人权重 0.10 下，1200 局自对弈里他有 703 步落在这条线上，其中 162 步是弃或加
    // ——线路说「留下来看戏」，人物说「面对连续加压会规矩地弃」，两句话互相打脸。
    // 压到 0.04 之后这些局面回到「弃」「价值加压」线上，弃牌就成了照着线路打。
    便宜看戏: { weight: 0.10, commit: 0.30 },
    闷压: { weight: 0.18, commit: 0.42 },           // 「几乎不闷比 / 闷牌王能压他」：闷着的线他都不熟
    闷比: { weight: 0.01, commit: 0.30 },           // 「几乎不」= 极小但不是零
    养池: { weight: 1.00, commit: 0.52 },           // 原话未涉及 → 常人
    价值加压: { weight: 1.35, commit: 0.55 },       // 拿到货就加压
    偷池: { weight: 0.60, commit: 0.80 },           // 升档偷池（挑软桌那一半在 foldEquityWeight）
    跟到底看: { weight: 0.72, commit: 0.30 },       // 太理性：不为了看结果花钱
    收口: { weight: 1.45, commit: 0.70 },           // 单挑收口快
    /**
     * 面对连续加压会规矩地弃：四张卡里最高的一条弃牌线。文档没给数，取的是
     * 与人物文字同向的那一侧的上沿。实测 1.30 也能过本文件的全部断言
     * （VPIP 53.4%、连压弃牌率仍达标），1.75 把 VPIP 压到 51.3%，
     * 并把三条「同一脚本对老油条不净胜」的对照各多拉开一点
     * （真牌加档收口 −1.13 vs −0.89、闷跟躲加注 −0.42 vs −0.26 k/局）。
     */
    弃: { weight: 1.75, commit: 0.50 },
  },

  cognition: {
    rangeFidelity: 2,        // 细记牌
    lookahead: 2,            // 2 轮前瞻
    readsTiming: true,       // 读用时
    classifyOthers: 'fine',  // 细记牌的人给别人贴的标签也细
    /**
     * 起手紧 = 弱牌在**感觉上**就更弱（不是「分位 < x 就弃」这条门槛）；
     * 拿到货就加压 = 强牌一分不打折。老手不会因为拿到豹子就飘（monster 1.02，
     * 常人 1.06），闷着也没有幻想（blind 0.98，常人 1.05 —— 他几乎不闷比）。
     */
    s1Prototypes: { monster: 1.02, strong: 1.00, medium: 0.94, weak: 0.86, blind: 0.98 },
  },

  /** 「太理性」的四个偏差都比常人轻；沉没成本最轻（原话点名的就是这一条）。 */
  biases: { sunkCost: 0.10, gamblersFallacy: 0.05, lossAversion: 0.18, overconfidence: 0.06 },

  compare: {
    heads: 0.46,   // 单挑收口快：单挑时清掉一个目标的门槛更低
    multi: COMMON_PERSONA.compare.multi,   // 原话未涉及 → 常人
    blind: 0.05,   // 几乎不闷比
    grudge: 0.15,  // 太理性 + 几乎不上头：比牌挑的是最弱，不是最恨
    softness: 1,   // 比牌只挑最弱 = 完全按 pWin 挑（常人值就是这个意思）
    // 单挑收口快 + 太理性：优势在手先兑现，不为「下一轮还能榨多少」冒险；
    // 但「升档偷池挑软桌」说明他也不是逮谁开谁 —— 软桌上的人留着还有肉。
    // 两句拉反方向，所以只比常人（0.55）低半档。
    milk: 0.50,
  },

  allIn: {
    initiate: COMMON_PERSONA.allIn.initiate,     // 原话未涉及 → 常人
    valueFloor: COMMON_PERSONA.allIn.valueFloor, // 原话未涉及 → 常人
    bluff: COMMON_PERSONA.allIn.bluff,           // 原话未涉及 → 常人
    accept: COMMON_PERSONA.allIn.accept,         // 原话未涉及 → 常人
    blindAccept: 0.10,                           // 几乎不闷：闷着接梭哈不是他的打法
    foldEquityWeight: 0.95,                      // 挑软桌 = 先看这一桌会不会跑
  },

  /** 几乎不上头：门槛翻倍、强度减到四成、三局的账两局就退干净；不记仇。 */
  emotion: { tiltTrigger: 0.20, tiltGain: 0.35, decay: 0.55, ease: 0.20, grudge: 0.15 },

  traits: traits(),

  tempo: {
    base: COMMON_PERSONA.tempo.base,   // 原话未涉及 → 常人
    dive: COMMON_PERSONA.tempo.dive,   // 原话未涉及 → 常人
    theatre: 0.18,                     // 偶尔演
    noise: 0.03,                       // 用时稳定
    leak: 0,                           // 用时稳定 = 不泄露牌力
    tell: 'none',                      // 「用时稳定」
    snapRaise: 0,
  },

  emotes: { rate: 0.05, favourites: ['👍'], cap: 1 },

  leaks: [
    '太理性：面对连续加压会规矩地弃，能被反复偷。怎么利用：不看自己的牌，'
    + '在他还没有表态的每一轮都往上抬一档 —— 他的弃牌线权重最高、沉没成本最轻（R4 ×0.5），'
    + '第二个信息点上他会按账面规矩退出，同一套动作可以对他重复用一整晚。',
    '几乎不闷比，闷牌王能压他。怎么利用：全程闷着加价到升档。他手上没有闷比这条线'
    + '（闷比线缺省、compare.blind 0.05），既不敢闷着跟你比，也读不到你的牌，'
    + '只能看牌后按价钱算账；价钱越高他退得越干脆，压他不需要真牌。',
  ],
};
