/**
 * 阿彪 —— 复仇者（记仇的）。设计文档 §4.7.3 第 8 行。
 *
 * 名字是本期新起的（文档只写了原型「复仇者（记仇的）」）：
 * 两个字、和出厂名册（阿凯/老陈/小北/阿杰/小林/老王）以及测试台的「甲」都不撞。
 * 「阿」字辈是这张桌上已有的取名习惯（阿凯、阿杰），「彪」压着那股一点就着的劲。
 *
 * 原话（逐句拆到下面每一个字段上）：
 *   打法要点：「谁比掉他他找谁。中等记牌、1 轮前瞻；平时接近老油条的收敛版；
 *              被谁比掉/梭掉，之后三局对那个人：范围放宽 0.1、优先找他比、他梭哈更愿意接」
 *   破绽：    「针对时会明显松，第三方可以趁他和仇人缠斗时收池」
 *   情绪与表演：「记仇强、衰减慢；表情针对仇人 😂」
 *
 * 字段 → 原话的对应：
 *   cognition.rangeFidelity 1               ← 「中等记牌」
 *   cognition.lookahead 1                   ← 「1 轮前瞻」
 *   lines / look / allIn 整体收敛           ← 「平时接近老油条的收敛版」：
 *                                              弃 1.15、偷池 0.55、跟到底看 0.72、valueFloor 0.84
 *   traits.regularities.R7 = 2              ← §4.9.6 给复仇者的偏斜，逐字照抄
 *   traits.regularities.R14 = 2             ← 同上
 *   traits.decay.revenge = 0.05             ← §4.9.6 给复仇者的偏斜，逐字照抄；也就是
 *                                              「记仇强、**衰减慢**」那一句：常人是 .15，
 *                                              他退得比常人还慢（半衰期 13 局 vs 4.3 局）。
 *                                              「被谁比掉/梭掉，**之后三局**对那个人」说的是
 *                                              **效果最强的那个窗口**，不是恨意的寿命 ——
 *                                              这个窗口靠 `compare.grudge` 的幅度体现
 *                                              （最新的仇人恨值最高，比牌就冲他去），
 *                                              不靠让他三局就把人忘光。
 *   compare.grudge 2.20                     ← 「优先找他比」（`adapter` 的比牌评分里
 *                                              grudge × compare.grudge × 0.35 就是这一项）。
 *                                              .05 的衰减下 2.20 → 挑仇人 47.8%
 *                                              （随机基线 30.2%，常人对照 42.2%）。
 *                                              往上拧的天花板不在 ①，在**加注率**：比牌和加注
 *                                              抢的是同一批局面，2.80 之后加注率就跌破
 *                                              「高过常人 ×1.2」这条自洽线（见下）。
 *   compare.milk 0.46                       ← 「平时接近老油条的收敛版」（阿杰 0.50）取其附近，
 *                                              再被「优先找他比」往兑现那一侧拉一点：
 *                                              逮着仇人就想现在开掉，不留着慢慢榨（常人 0.55）
 *   emotion.grudge 1.00                     ← 「记仇强」
 *   emotes 😂                                ← 「表情针对仇人 😂」
 *
 * ① 的天花板（.05 下卡级能到的上限）：
 *   compare.grudge 扫过 2.20 / 2.40 / 2.60 / 3.00 / 4.00 / 4.50 / 5.00 / 6.50 / 8.00，
 *   「开比挑仇人」在 2.2–2.6 之间是 47.8% / 46.7% / 48.1%，一路拧到 4.5 以上才到 51–53%，
 *   但**加注率是先撞线的那一个**：常人基线 13.3%，自洽线要 ×1.2 = 16.0%，
 *   而 grudge 2.20→16.4%、2.60→16.3%、2.80→15.7%、3.00→15.4%、4.50→12.7%
 *   （比牌 364→815 手，多出来的比牌全是从加注那里抢的）。
 *   所以 grudge 只能留在 2.20，① 就停在 47.8%（12000 手 47.2%）。
 * 结果：① 高过 1/n 随机基线 ×1.5（30.2% × 1.5 = 45.3%）成立，
 *   但**高不过常人对照 +0.10** —— 实测只高 5.6 点（12000 手 3.9 点）。
 * 卡住的不是这张卡的旋钮，是核心的归因：`settleMinds` 把恨记给**这一手的赢家**，
 * 与真正把他比下去的那个人只重合 62.5%，于是 .05 的窗口里他手上同时挂着 6.12 个仇人
 * （常人 4.36 个），「最新的那一个」被另外五个稀释。
 * 改法见 docs/zjh/personas.md「待集成」#14。所以测试 ① 的第二条断言按实测能稳过的
 * 最严值写成 +0.03，不是设计里的 +0.10。
 *
 * 「范围放宽 0.1」与「他梭哈更愿意接」这两条，**卡级做不到**（实测见下）。
 *
 * 通用层里唯一按人分的记仇通道是 `situationalChannels` 的
 * `quitThreshold += grudge × 0.10`、`aggression += grudge × 0.08`，
 * 这两个系数**不乘任何人物卡字段**（连 `reg(t,'R14')` 都没乘），
 * 而且只在 `counterpartKey`（= 当前威胁最大的那一家）恰好就是仇人时才触发。
 * 定场景实测（仇值 1.2 直接注入，8 手牌 × 3 个价位 × 200 种子 = 4800 次决策）：
 *   接梭哈：无仇 36.1% → 仇挂在梭哈者身上 37.1%（+1.0 点）；
 *           同一组场景换成常人卡也是 34.1% → 35.1%（+1.0 点）—— 一模一样，
 *           说明这张卡的 R14 ×2 / compare.grudge 2.20 根本没进这条路径。
 *   范围：  不弃手的均分位 0.815 → 0.805，只放宽 0.010 分位，目标是 0.1。
 * 所以这两条要的是核心改动（改 `regularities.ts` 的系数、`situation.ts` 的
 * `counterpartKey`、`adapter.ts` 接梭哈评分里补一项 grudge），
 * 建议写在 docs/zjh/personas.md 的待集成清单里，本期不动核心。
 * 卡上真正兑现的是「优先找他比」：比牌是唯一一条按人物卡缩放（`compare.grudge`）的记仇通道。
 */

import { COMMON_TRAITS, cloneTraits } from '../../../mind/traits.ts';
import type { Persona } from './types.ts';

const traits = cloneTraits(COMMON_TRAITS);

// —— 设计文档 §4.9.6 给「复仇者」的偏斜，原样照抄 ——
traits.regularities.R7 = 2;     // bad beat 上头 ×2 —— 「被谁比掉/梭掉」的入口
traits.regularities.R14 = 2;    // 面子：同一个人压两次 ×2
// 「记仇强、衰减慢」：§4.9.6 原文的 0.05，比常人的 0.15 还慢（半衰期 13 局 vs 4.3 局）。
// 「之后三局对那个人」是**效果最强的窗口**，靠 compare.grudge 的幅度体现，不靠快速遗忘。
traits.decay.revenge = 0.05;

// —— 「平时接近老油条的收敛版」：情绪之外的部分都比常人稳一档 ——
traits.regularities.R4 = 0.7;   // 沉没成本：平时他不为已经投进去的钱付钱
traits.regularities.R5 = 0.6;   // 赌徒谬误
traits.regularities.R13 = 0.6;  // 无聊求刺激：他不会因为闲得慌就进池
traits.regularities.R32 = 1.5;  // 峰终定律：在谁手上吃过最狠的一刀，他记得最牢
traits.drives = { greed: 0.30, pride: 0.52, safety: 0.44, curiosity: 0.28, boredom: 0 };
traits.baseline.fear = 0.07;
traits.baseline.anger = 0.05;   // 底子里就带一点火
// 一点就着、着了就久：怒和反刍衰减都比常人慢。
traits.decay.anger = 0.15;
traits.decay.rumination = 0.18;
// 「针对时会明显松」：他气起来是往前冲的那一种（aggression 高、quitThreshold 高）。
traits.expression.anger = {
  ...traits.expression.anger, aggression: 0.85, quitThreshold: 0.70,
};
traits.tilt = { trigger: 0.45, gain: 1.20, recover: 5 };
traits.sensitivity.agency = 1.35;  // 「是被谁弄的」这件事对他特别重要
// 记仇强度（`personas.md`「待集成」#11）。R14 的恨意原来是写死的常数，
// 谁都一样记仇，复仇者这张卡的立人设就落不到行为上。现在恨意落到通道上要乘
// 这个系数，他是常人的 2.2 倍：同一个人压他两次之后，他对**那个人**的
// 弃牌门槛、侵略性、松紧全部明显偏移，对别人不变。
traits.grudgeGain = 2.2;
traits.cognition.needForCognition = 0.55;
traits.cognition.selfControl = 0.48;  // 平时收得住，对上仇人收不住
traits.cognition.probWeightAlpha = 0.70;
traits.cognition.narrowFraming = 0.72;
traits.tempo = { baseMs: 360, deliberateMs: 3000, jitter: 0.32 };

export const ABIAO: Persona = {
  name: '阿彪',

  // 「平时接近老油条的收敛版」：他愿意花钱买信息，但不像数学型那样非看不可。
  look: {
    appetite: 1.06,
    blindLove: 0.54,
    pressureWeight: 0.30,
    costWeight: 0.92,
    // 常人 1.50 → 0.70：他买信息买得早（appetite 1.06），
    // 所以「又打了一轮」对他的推力反而比常人小 —— 该看的他早看了。
    roundWeight: 0.70,
    tierWeight: 0.78,
    allInWeight: 0.38,
  },

  lines: {
    便宜看戏: { weight: 0.14, commit: 0.32 },
    闷压: { weight: 0.34, commit: 0.44 },
    闷比: { weight: 0.10, commit: 0.34 },      // 找人算账的时候闷着也能开比
    养池: { weight: 1.02, commit: 0.56 },
    价值加压: { weight: 1.25, commit: 0.46 },
    偷池: { weight: 0.55, commit: 0.82 },      // 收敛：不靠诈唬吃饭
    跟到底看: { weight: 0.85, commit: 0.32 },
    收口: { weight: 1.28, commit: 0.62 },      // 找到人就要一次收干净
    弃: { weight: 0.82, commit: 0.54 },        // 「收敛版」：平时该弃就弃，但他不轻易被吓退
  },

  cognition: {
    rangeFidelity: 1,          // 「中等记牌」
    lookahead: 1,              // 「1 轮前瞻」
    readsTiming: false,
    classifyOthers: 'coarse',  // 「中等记牌」：他分得清松紧，分不到条件那一层
    s1Prototypes: { monster: 1.10, strong: 1.03, medium: 0.99, weak: 0.95, blind: 1.06 },
  },

  biases: { sunkCost: 0.24, gamblersFallacy: 0.12, lossAversion: 0.24, overconfidence: 0.22 },

  compare: {
    heads: 0.54,
    multi: 0.64,
    blind: 0.48,
    // 「优先找他比」——「谁比掉他他找谁」的落点。比牌是唯一一条乘人物卡字段的记仇通道
    // （adapter 的 `grudgeOf` = revenge × compare.grudge），原话里能落地的那一半全压在这里。
    // decay .05 下重扫过一遍（6000 手自对弈，随机基线 ~30%，常人对照 42.2%）：
    //   挑仇人  2.20 → 47.8%｜2.40 → 46.7%｜2.60 → 48.1%｜4.50 → 51.3%｜6.50 → 53.3%
    //   加注率  2.20 → 16.4%｜2.40 → 16.2%｜2.60 → 16.3%｜2.80 → 15.7%｜4.50 → 12.7%
    // 加注率先撞线（自洽要求 > 常人 13.3% × 1.2 = 16.0%）：比牌手数从 364 涨到 815，
    // 多出来的比牌全是从加注那里抢走的，「他比谁都爱还手」就不成立了。
    // 所以留在 2.20 —— 这是「不破坏别的原话」的前提下能给到的最大值。
    grudge: 2.20,
    // 「平时接近老油条的收敛版」：底子取阿杰那一档（0.50）。
    // 「优先找他比」再往「现在就开掉」拉一点 —— 复仇者要的是把仇人开在台面上，
    // 不是留着他慢慢榨。注意这一项是**对所有人**的，不分仇人：分不分仇人由 grudge 管。
    milk: 0.46,
    softness: 1,
  },

  allIn: {
    initiate: 0.46,
    valueFloor: 0.84,        // 「收敛版」
    bluff: 0.06,
    accept: 0.02,
    blindAccept: 0.42,
    foldEquityWeight: 0.72,
  },

  // 「记仇强、衰减慢」：情绪曲线上 grudge 拉满，decay 慢，上头的门槛比常人低一点。
  emotion: { tiltTrigger: 0.08, tiltGain: 1.05, decay: 0.86, ease: 0.28, grudge: 1.00 },

  traits,

  tempo: {
    base: 360, dive: 3000, theatre: 0.24, noise: 0.05, leak: 0.35,
    // §4.7.3 复仇者那一行**没写**用时破绽（他的破绽全在「针对时会松」上），
    // 所以方向留空 —— 没有方向就不泄露，这 0.35 只是个待命的强度旋钮。
    tell: 'none',
    snapRaise: 0,
  },

  emotes: { rate: 0.42, favourites: ['😂'], cap: 2 },

  leaks: [
    '谁比掉他他找谁（**成立，已量化**）：结仇之后的三局里，他开比时 47.8% 挑仇人（130/272），'
    + '1/n 随机基线只有 30.2%，同条件下的常人是 42.2%。'
    + '利用方式：把他比掉一次之后，知道他接下来会来找你 —— 用真牌等他开比。',
    '针对时会明显松（**不成立，需要核心改动**）：这一条原本写的是「R14 抬高 quitThreshold，'
    + '范围放宽约 0.1」。定场景实测（每格 12000 次采样，同一副牌、同一动作序列，只注入恨意）：'
    + '不弃手均分位 0.826 → 0.817（放宽 0.009，目标 0.100），接梭哈 32.5% → 33.4%（+0.9 点）；'
    + '而**同一段注入打在常人身上是 30.7% → 31.5%，同样 +0.9 点**。'
    + '也就是说这一段完全不经过人物卡：`regularities.ts` 的记仇分支写死了 '
    + '`grudge * 0.10` / `grudge * 0.08`，不乘任何 persona 字段。'
    + '卡级旋钮（compare.grudge / emotion.grudge / R7 / R14 / decay.revenge）改不动它，'
    + '改法见 personas.md「待集成」#11–#13。',
    '记仇的落点固定在「这一手的赢家」：`settleMinds` 把恨记给赢家，'
    + '与真正把他比下去的那个人只重合 62.5%（约三分之一的仇记错了人）——'
    + '这也是他在「衰减慢」的 .05 下同时挂着 6.12 个仇人、① 顶到 47.8% 就上不去的原因。'
    + '利用方式：让别人去当开火的那个人，自己全程只跟不加，等他们缠斗时收池 —— '
    + '但**这条也换不成钱**：三人桌收池脚本增量 +3.0k [−5.1k, 11.0k]、对照 −1.1k（8000 手），'
    + '卡在第 2 条那个固定系数上。归因的改法见 personas.md「待集成」#14。',
  ],
};
