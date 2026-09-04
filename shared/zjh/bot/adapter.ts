import { socialValue } from './profile.ts';
/**
 * 炸金花领域适配器（设计文档 §4.10.2）。
 *
 * `shared/mind/` 那一层只认「人」：情绪、驱力、规律、系统 1/系统 2。它不知道什么是
 * 闷牌、什么是金花。两边的翻译全在这个文件里：
 *
 *  - `appraise`：牌局事件 → 通用评价（好坏、大小、意外、归因、可控）
 *  - `coarse`  ：局面 → 粗特征（我这东西好不好、对面凶不凶、这一步多大、多熟、赢着还是输着）
 *  - `intuition`：系统 1 的原型匹配 —— **不算账**，只有印象和习惯，代价约等于 0
 *  - `deliberate`：系统 2 的工具 —— 范围模型 + 前瞻 + EV，主观概率经过 Prelec 加权
 *  - `stakes` ：这一步的赌注 / 时间压力 / 熟悉度，喂给 p2 公式
 *
 * 关键的一点：**两个系统给同一批候选动作打分，用同一批 key**。系统 2 要不要推翻
 * 冲动，比的是它自己算出来的分差（§4.9.7），所以两套分不需要同量纲。
 */

import type { Appraisal, MindState } from '../../mind/emotion.ts';
import { arousalOf, magnitudeOf, referencePoint } from '../../mind/emotion.ts';
import type {
  CoarseFeatures, Deliberation, DomainAdapter, Impulse, Scored,
} from '../../mind/adapter.ts';
import { softPick } from '../../mind/dual.ts';
import { lineBias, planAllows, PLAN_GAIN, PLAN_VETO } from './plan.ts';
import type { Traits } from '../../mind/traits.ts';
import {
  evAcceptAllIn, evAllIn, evCall, evCompare, evRaise, foldAll, lookValue, noCallChance,
} from './lookahead.ts';
import { categoryBands, type DealMode } from '../../game.ts';
import { kindsOf } from './events.ts';
import { pWin } from './range.ts';
import { clamp01, type Candidate, type ZjhSituation } from './situation.ts';
import { theatreNow } from './tempo.ts';

/**
 * 适配器认识的牌局事件 —— **全是局中事件**（§4.9.1）。
 *
 * 一局结束不在这里：通用层已经有领域无关的 `Outcome`（`shared/mind/regularities.ts`），
 * 结算走 `settle()` / `outcomeAppraisal()`，和这里汇进同一张映射表。
 * 事件自带量纲（`balance` 是这件事发生时我手上有多少），因为评价发生在事件那一刻，
 * 不是在我下一次行动的时刻。
 */
export type ZjhEvent =
  /** 有人加档/梭哈压过来了。`looked` = 他做这个动作时看过牌没有（闷牌加注是便宜的表演） */
  | { kind: 'pressed'; by: string; size: number; balance: number; looked: boolean; allIn: boolean }
  /** 我自己掀开牌看到的东西。`strength` 是这手牌的分位 0..1 */
  | { kind: 'peeked'; strength: number; balance: number; roundNo: number }
  /** 有人跟我开了牌。我还在桌上就说明这一比我赢了；输的那一头在结算里 */
  | { kind: 'compared'; by: string; won: boolean; size: number; balance: number }
  /** 有人扔牌走了，锅还在，人少了一个 */
  | { kind: 'quit'; by: string; size: number; balance: number; pot: number }
  /** 别人之间开了牌，我在旁边看着：桌上被打掉一个人，跟我没关系但很响 */
  | { kind: 'watched'; by: string; size: number; balance: number; pot: number };

/* --------------------------------------------------------------- 系统 1 */

/**
 * 原型匹配（§4.9.7）：牌力落在哪一档，那一档在**感觉上**值多少。
 * 人不会说「我这手在 78.3 分位」，人说的是「这牌不错」。
 */
/**
 * R28 替代：系统 1 不回答「我这手牌的胜率是多少」（难），它回答「这手牌看着顺不顺眼」
 * （易）—— 原型匹配出来的印象，代价约等于 0。系统 2 才去算真的那个问题。
 */
function feltStrengthOf(sit: ZjhSituation): number {
  const proto = sit.persona.cognition.s1Prototypes;
  if (sit.strength === undefined) {
    // 闷着：没看过的牌总是比看过的好看一点（R16 禀赋/幻想，通道层的 delayInfo 就是它）
    return clamp01(0.5 * proto.blind + sit.channels.delayInfo * 0.30);
  }
  const s = sit.strength;
  return clamp01(s * protoGainOf(proto, s, sit.state.settings.dealMode));
}

/**
 * 原型槽位按**牌型**取，不按写死的分位取（硬要求 1 / 硬要求 10）。
 *
 * §4.9.7 写的系统 1 输入是「手牌档位（闷/散/对子/顺子/金花/顺金/豹子）」——
 * 人说的是「我这是个对子」，不是「我这手在 0.63 分位」。原来这里写的是
 * `s >= 0.97 / 0.85 / 0.5` 三条固定分位线，那三个数字是在**旧发牌档**
 * （散牌 [0,.05]、对子 [.05,.08]、顺子 [.08,.37]、金花 [.37,.75]）下选的，
 * 当时 `weak`（s<0.5）刚好盖住「散牌+对子+顺子+半个金花」。
 * 硬要求 1 把分位带对回 `categoryBands('standard')`（散牌 [0,.60]、对子 [.60,.74]…）
 * 之后，同样三条线落到了完全不同的牌型上：`weak` 只剩下**半个散牌**，
 * 于是小雨卡上写着「对子就觉得不错」的 `weak 1.45` 实际抬的是散牌，
 * 而且会抬出 `散牌 0.59×1.45 = 0.855 > 顺子 0.80×1.06 = 0.848` 这种**倒挂**。
 *
 * 现在槽位这样对：
 *   - `monster` ← 顺金 + 豹子（§4.9.7 表格原话「豹子顺金在感觉上更大一点」）
 *   - `strong`  ← 金花
 *   - `medium`  ← 对子 + 顺子
 *   - `weak`    ← 散牌
 * 边界全部从 `categoryBands(mode)` 取，换发牌档自动跟着走，档内单调、跨档不倒挂
 * （只要卡上 weak ≤ medium ≤ strong 这一段不写反）。
 */
function protoGainOf(
  proto: { monster: number; strong: number; medium: number; weak: number },
  s: number,
  mode: DealMode,
): number {
  const b = categoryBands(mode);
  if (s >= b[5][0]) return proto.monster;   // 顺金 / 豹子
  if (s >= b[4][0]) return proto.strong;    // 金花
  if (s >= b[2][0]) return proto.medium;    // 对子 / 顺子
  return proto.weak;                        // 散牌
}

/**
 * 觉得对面有多强：最凶的那一个说了算，其余的摊薄，**再乘上今天的心情**。
 *
 * 「对面有多强」不是一个客观读数 —— 范围模型算出来的那串数字是客观的，
 * 但人看到它的时候会加上自己的滤镜（§4.9.1 评价 → 情绪 → 通道）：
 * 怕的时候满桌子都像拿着豹子，上头的时候谁都像在诈唬。
 * 这一层比任何单独的动作系数都重要 —— 它同时改掉弃、跟、加、比、接梭哈**全部**的尺子。
 */
function feltThreatOf(sit: ZjhSituation): number {
  if (!sit.threats.length) return 0;
  const top = Math.max(...sit.threats);
  const mean = sit.threats.reduce((a, b) => a + b, 0) / sit.threats.length;
  const ch = sit.channels;
  const lens = 1 + ch.safety * 0.55 - ch.tilt * 0.30 - ch.ease * 0.12;
  return clamp01((top * 0.7 + mean * 0.3) * lens);
}

/**
 * 「想看一眼」这个念头有多重 —— 纯习惯，不含信息价值。
 *
 * 每一项都是**连续的推力**：桌上在开火、这一口开始肉疼、打了几轮了、单价升档了、
 * 有人梭哈了。`blindLove` 是往回拉的那一股。系统 1 和系统 2 都用它，
 * 差别在于系统 2 还会加上 `lookValue()` 真算出来的那笔账。
 */
function lookHabit(sit: ZjhSituation): number {
  const h = sit.persona.look;
  const ch = sit.channels;
  /**
   * 「牌打到这个份上了」——**一件事**，五种说法。
   *
   * 轮次、单价档位、这一口占身家多少、桌上有多凶、有没有人梭哈，说的全是同一件事：
   * 时间过去了，价钱上来了。以前它们各自独立地线性往上加，于是打到第三轮时
   * 光「轮次」一项就有 1.44、加上升档那一档 0.70（`tier` 还是个 0..3 的序号，
   * 直接乘权重，量纲都不对），合起来 2.1 —— `tanh` 之后紧贴 1.0，
   * 而 `softPick` 的温度只有 0.04：形式上是连续量，行为上就是一条
   * `roundNo >= 3 return look`（竞技场量到 r3 看牌率 99.9%）。
   *
   * 现在这一族**先合起来再饱和**，而且合之前每一项都先换成同一个量纲：
   *
   *  - 轮次是**双曲**的：`1 - 1/roundNo`。第 1→2 轮是「牌局真的开始了」，
   *    第 4→5 轮只是「还在打」—— 人对「又过了一轮」的感知本来就越来越钝；
   *  - 档位换成「升到头了没有」的比例（`tier / 2`，与 `plan.ts` 同一把尺子），
   *    不再是序号；
   *  - 合起来之后走 `LOOK_WEAR * log1p(x / LOOK_KNEE)`：`LOOK_KNEE` 是
   *    「多小的磨损才算得上一回事」，`LOOK_WEAR` 是这一族的斜率。
   *
   * 两层凹性叠起来，才让「第 2 轮大多数人已经看了」和「闷着的那一小撮
   * 到第 3、4 轮还闷着」同时成立 —— 这两条是 §6.4「闷到第 3 轮 15–35%」
   * 和「各轮看牌率严格落在 (5%, 95%) 内且平滑爬升」的联立解。
   */
  const wear = LOOK_WEAR * Math.log1p((
    Math.log1p(sit.state.roundNo - 1) * h.roundWeight
      + clamp01(sit.tier / 2) * h.tierWeight
      + sit.costFraction * h.costWeight
      + sit.pressure * h.pressureWeight
      + (sit.state.allIn ? h.allInWeight : 0)
  ) / LOOK_KNEE);
  const raw = h.appetite * 0.55
    - h.blindLove * 1.20 * Math.exp(-BLIND_FADE * (sit.state.roundNo - 1))
    + wear
    + ch.seekInfo * 0.55
    - ch.delayInfo * 1.30
    + ch.curiosity * 0.30;
  /**
   * 再压一次，这一次是给情绪通道留的余地（`seekInfo`/`delayInfo` 不在 `wear` 里，
   * 它们是「今天想不想知道」，不是「打到第几轮了」）。
   * `tanh` 保住每一项的方向和排序，只是不让任何单独一项把整张评分表压平。
   */
  return Math.tanh(raw / LOOK_SPAN) * LOOK_SPAN;
}

/** 「想看一眼」这股劲的上限（见 `lookHabit`）。它要和线路、账面价值在同一个量级上。 */
const LOOK_SPAN = 1.0;

/**
 * 「时间和价钱」这一族（轮次 + 升档 + 这一口多贵 + 桌面多凶 + 有没有人梭哈）的斜率。
 *
 * 整族先合成一个无量纲的「磨损」`x`，再走 `LOOK_WEAR * log1p(x / LOOK_KNEE)`：
 * 这一族**必须继续爬**（打得越久越想看清楚），但必须**越爬越慢**，
 * 而且到第三、四轮时的量级要跟线路对看牌的意见（闷压 −0.33、闷比 −0.18、
 * 便宜看戏 −0.07，见 `plan.ts` 的 `lineBias`）**同量级**：
 *
 *  - 线性叠加（旧版）时它在第三轮已经是 2.1，`tanh` 之后紧贴上限 1.0，
 *    而 `softPick` 的温度只有 0.04 —— 行为上就是一条 `roundNo >= 3 return look`；
 *  - 一刀切的 `tanh` 饱和则让第三轮之后再也不涨，看牌率反而随轮次往下掉。
 *
 * 两个系数照着两条验收联立解出来（1500 局自对弈）：各轮看牌率
 * r1 30% → r2 81% → r3 83% → r4 86%，平滑爬升且每一轮严格落在 (5%, 95%) 内；
 * 同时 §6.4 的「闷到第 3 轮 15–35%」（实测 24%）与「闷比占比牌 5–15%」（实测 12%）成立。
 */
const LOOK_WEAR = 0.62;

/**
 * 「多小的磨损才算得上一回事」：`wear` 那条对数曲线的拐点（见 `lookHabit`）。
 *
 * 它决定的是**曲线的凹度**：`K` 越小，第 1→2 轮那一下越响、后面越平 ——
 * 「大多数人第二轮就看了」和「闷着的那一小撮到第 4 轮还闷着」这两件事，
 * 靠的正是这一个数。
 */
const LOOK_KNEE = 0.44;
/**
 * 「闷着的乐趣」每过一轮掉多少（指数）。
 *
 * `blindLove` 是一个人身上**最稳**的那股反力 —— 也正因为稳，它会制造幸存者偏差：
 * 打到第 4 轮还闷着的人，恰恰是 `blindLove` 最高的那几个，于是「这一轮还闷着的人
 * 里有多少会看牌」这条**条件**概率会随轮次往下掉，看牌率画出来是先爬后落。
 *
 * 可人不是这样的：「我还没看」这件事本身撑不了太久 —— 掩护的乐趣会被磨掉，
 * 越到后面越撑不住。所以这股反力**自己**要随轮次衰减。它同时也是上面那条
 * 幸存者偏差的解药：选出来的人反力更强，但反力本身在缩水，两边正好抵住，
 * r3、r4 的看牌率才继续往上走而不是掉头（实测 r3 88.3% → r4 88.6%）。
 */
const BLIND_FADE = 0.24;

/**
 * 池子「熟」到什么程度：跟开局那点底注比，现在这一锅涨了多少倍（对数感知，R26 的同一套尺度）。
 * 刚开局的池子不值得为它把牌力亮出来 —— 人会先养池，这就是养池那股力。
 */
function potMaturity(sit: ZjhSituation): number {
  const seed = Math.max(1, sit.state.settings.ante * sit.state.players.length);
  return clamp01(Math.log(Math.max(1, sit.state.pot) / seed) / Math.log(60));
}

function grudgeOf(sit: ZjhSituation, mind: MindState, id: string): number {
  return socialValue(mind.revenge, sit.state.players, id) * sit.persona.compare.grudge;
}

function stakeOf(sit: ZjhSituation, c: Candidate): number {
  return clamp01(c.cost / Math.max(1, sit.bot.chips));
}

/**
 * 线路这一把往哪个方向推（§4.4）。
 *
 * 「坚持」不是禁令：`commit` 只决定这股推力有多大，任何候选都还在桌上。
 * 一条偷池线在被反加之后照样可以弃 —— 只是要比没有线路的时候更别扭一点，
 * 这正是「它刚才还在吹」这件事应该留下的代价。
 */
/**
 * 闷着开牌这股劲有多真。
 *
 * 人物卡的 `compare.blind` 给的是相对高低，这个系数把它整体校到 §6.4 的
 * 「闷比占比牌 5–15%」上。在 `WORTH_GAIN` 这把新尺子下重新标定（1500 局常人卡
 * 自对弈）：0.85 → 7.4%，1.00 → 10.1%，1.20 → 15.9%。取正中间那一档。
 */
const BLIND_COMPARE = 0.20;

/**
 * 「反正要走，走之前看一眼」这股劲有多大（见 `applyPlan`）。
 * 它只在「此刻最想做的是弃牌、而且我还闷着」时出现，别的时候一分不加。
 */
const FOLD_PEEK = 0.25;

/**
 * 「其实我也想走」这件事的温度：弃牌比最好那个动作差多少，`FOLD_PEEK` 就折成 1/e。
 *
 * 见 `applyPlan`。取的就是 `softPick` 自己的温度（0.06 上下）：弃牌一旦落后到
 * **连 `softPick` 都不会再选它**的程度，「反正要走」这个前提本身就不成立了，
 * 这份便宜跟着没有，而不是到某个整数分差上啪地断掉。
 *
 * 再大就不是「其实我也想走」了 —— 实测 0.60 时 S19「六人桌第一轮几乎全员闷跟」
 * 的看牌率从 16% 涨到 28%（把「顺手看一眼」发给了根本没想走的人），
 * 0.10 时 §6.2 单挑桌对疯子的遇压弃从 23.2% 抬到 25.1%，越过了「对岩石的一半」。
 */
const PEEK_SPAN = 0.05;

/**
 * 「看一眼」相对「不看就干的那件事」被压到这个分差以内时，一切照旧（斜率 1）。
 *
 * 见 `applyPlan`。0.30 是 `softPick` 温度的五倍 —— 到这儿看牌率已经是千分之几，
 * 局面该说的话早说完了；再往下的差别只有量纲上的意义，没有行为上的意义。
 */
const LOOK_GAP_KNEE = 0.30;

/**
 * 过了 `LOOK_GAP_KNEE` 之后，压强每翻一个 `LOOK_TAIL` 的量级只再多压 `LOOK_TAIL` 分。
 *
 * 见 `applyPlan`。它定的是「压到底之后还能有多低」：0.03 时压到 −1.0 也只到
 * −0.40（看牌率千分之一上下），压到 −3.0 也只到 −0.44 —— 永远不是零。
 */
const LOOK_TAIL = 0.03;

/**
 * 「这一口比公平份额贵多少」换算成弃牌分的斜率（见 `fold` 分支）。
 *
 * 量纲：`overpay` 是**池子比例**（0..1），乘上它就是弃牌那一项的分。
 * 打到两万档、锅里三万、还剩四个人时 `overpay` ≈ 0.15，这一项 ≈ 0.9 ——
 * 和「牌力差一档」（`(need - felt) * 1.60`）同量级，正是它该有的分量。
 */
const FOLD_SLOPE = 7.0;

/**
 * 「牌力差一档」值多少分 —— **跟与弃共用**的那一个斜率（见 `intuition`）。
 *
 * 它是这张评分表的主刻度：`felt − need` 是分位差（0..1 的量纲），乘上它就得到
 * 「够不够格继续」的分。取 2.4 是让它和价钱那一头同量级 —— 三轮两万档、
 * 锅里三万、四个人时 `reluctance` ≈ 0.9，正好对应「牌力差 0.37 个分位」，
 * 也就是「一手中等牌顶不住这个价钱」，而 `softPick` 的温度只有 0.04，
 * 所以这两头的比值必须是**对的**，不能靠一边加常数把另一边压住。
 */
const WORTH_GAIN = 2.4;

/**
 * 好牌加价能多收多少（见 `intuition` 的 `raise` 分支的 `value`）。
 *
 * 它和 `bluff * 1.90` 是同一件事的两头：一个赌对面跑，一个赌对面不跑。
 * 取 1.6 是让「明显够格（超线 0.3 个分位）、四个人还在、一半人会跟」
 * 这种典型的价值加注拿到 +0.24 分 —— 刚好压过「多付一口」的 `price * 0.60`，
 * 不至于让好牌永远只会平跟，也不至于让中等牌无差别地乱抬价。
 */
const VALUE_GAIN = 1.6;

/**
 * 抬价那一头的「赢家诅咒」修正：每多一桌人，这道坎再抬高多少
 * （和 `CMP_CROWD` 同一个道理：人越多，我是最好的那个的概率越低）。
 * 量纲是牌力分位 —— 满桌（`crowd = 1`）时要比「够看」那条线再高 0.45 个分位才值得抬价。
 */
const RAISE_CROWD = 0.45;

/**
 * 「贵多少才算贵」的宽度（softplus 的温度，量纲同样是池子比例）。
 *
 * 它决定「刚好持平」附近这条曲线有多软：0.06 意味着比公平份额贵 6% 池子
 * 就已经明显开始想走，而便宜 6% 时这一项只剩三成。取小了就退化成
 * `max(0, ·)` 那种拐死的硬弯，取大了则连白送的价钱都会有人想弃。
 */
const FOLD_FAIR = 0.06;

/**
 * 开牌要的是**优势**，不是「不输」（§4.4 收口 / §4.6）。
 *
 * 范围模型对还留在桌上的人估得偏乐观 —— 手上没货的人已经弃掉了，剩下的比
 * 模型的均值更硬；我又偏偏挑「看起来最软」的那个去比，挑中的往往正是被低估
 * 的那个（赢家的诅咒）。它是一条连续的减项，不是 `if (beat >= x)` 的门槛。
 *
 * 2026-09-04 P2.1 从 0.28 降到 0.02：赢家诅咒这件事**本来就该按人数算**，
 * 满桌挑最软的那个才容易挑到被低估的人，单挑时根本没得挑 —— 这份惩罚现在
 * 几乎整个由 `crowd × CMP_CROWD` 承担（满桌仍是 0.32，和旧的 0.28 同量级），
 * 单挑那头只剩一点点。旧值把单挑也罚 0.28，压的是「该不该开牌」这个总量，
 * 于是压出了「只有豹子才开得起牌」的分布 —— 正是 P2.1 要修的那个病。
 * 现在总量交给 `CMP_MILK`（按「还能榨多少」压），分布交给这里（按人数压）。
 */
const CMP_EDGE = 0.02;
/**
 * 闷着开牌时那道坎**自己是一个数**，不是看牌那道坎的倍数（2026-09-04 P2.1 改）。
 *
 * 两头的理由没变：闷比只掏一半价钱、赔率本来就宽，所以**不吃人数惩罚**；
 * 可闷着的人手上那点 `felt` 是幻想（R16）不是牌力，赢家诅咒在他这头更重，
 * 所以它比单挑时看牌方那道坎高。净效果仍是「单挑闷比比看牌后开牌容易，
 * 满桌闷比比看牌后开牌难」—— 满桌 `CMP_EDGE + CMP_CROWD` vs 闷着 `CMP_BLIND`。
 *
 * 之所以从倍数改成绝对值：闷着的人对谁都是 `beat ≈ blindPush`（`pWin(0.5, ·) ≈ 0.5`），
 * 他这道坎和 `BLIND_COMPARE` 是**同一个自由度的两端**。写成 `CMP_EDGE × CMP_BLIND`
 * 的时候，看牌那头一调低，闷比这头的坎跟着塌，`BLIND_COMPARE` 再怎么降都拉不回来
 * （实测 `CMP_EDGE = 0.02` 时把 `BLIND_COMPARE` 从 0.20 压到 0.06，
 * 闷比占比牌纹丝不动地停在 21%–23%，§6.4 要 5–15%）。拆开之后两件事各调各的。
 */
const CMP_BLIND = 0.20;
/** 每多一桌人，那道坎再抬高多少（`crowd` 是 0..1 的人数量）。 */
const CMP_CROWD = 0.30;
/**
 * 「把他开掉就再也榨不到他了」这笔机会成本的斜率（2026-09-04 P2.1 新增）。
 *
 * 量纲：`max(0, beat) × stay × left × milk` 是 0..1 的「这一手还能榨多少」，
 * 乘它就是比牌分上的扣减。三个因子各管一件事：
 *   · `max(0, beat)` —— 打不过的时候没有什么可榨的（弱牌恒 0，这一项不碰诈唬比牌）；
 *   · `stay` —— 对面本来就要跑的时候也没有（真人这时的直觉正是「他要跑，那现在开了他」）；
 *   · `left` —— 越到后面轮次，能再榨的次数越少，机会成本自然褪掉，
 *     所以第 4 轮之后这一项归零，收口该收还是收。
 *
 * 取 6.40 是量出来的，不是推出来的（2026-09-04 P2.1 返修时按现在这份代码重扫了一遍：
 * 出厂名册六人桌自对弈 2000 手、种子 20260903，口径同 `scripts/zjh-review.ts`）：
 *
 * | `CMP_MILK` | 大牌早比（§6.4 要 < 5%） | 闷比占比牌（要 5–15%） | 比牌总数 |
 * |---|---|---|---|
 * | 1.60（原方案值） | 6.13% ✗ | 15.08% ✗ | 995 |
 * | 3.20 | 4.60% | 13.30% | 782 |
 * | 4.80 | 5.23% ✗ | 9.54% | 650 |
 * | **6.40** | **4.09%** | **7.99%** | 563 |
 * | 8.00 | 5.19% ✗ | 5.19% | 443 |
 * | 9.20 | 4.69% | 5.21% | 384 |
 *
 * 比牌总量随它单调下滑，但「大牌早比」不是单调的 —— 榨得越狠，被劝住的既有大牌也有
 * 中上牌，两条曲线此消彼长，于是这一栏在带内外来回穿。6.40 是唯一一格两项都留出余量的：
 * 再小一档（4.80）大牌早比越线，再大一档（8.00）也越线且闷比贴着 5% 的下沿。
 * 注：本行以前写的是「取 4.80」，而常数早已是 6.40，且引的是被撤销的
 * 「豹子第 2 轮 20–30%」那套派生目标 —— 2026-09-04 一并改掉。
 *
 * 它和 `CMP_EDGE` 是两件不同的事：`CMP_EDGE` 说的是「优势不够别开」，
 * 这一项说的是「优势够，正因为够，更该留着他」。
 */
const CMP_MILK = 6.40;
/** 发起梭哈那一头的同一道坎：接的人都是打得过我的（§4.6）。 */
const ALLIN_EDGE = 0.10;

function planPush(sit: ZjhSituation, key: string): number {
  // 梭哈摆到脸上的时候线路让位：接不接梭哈是 §4.6 的两端算法说了算，
  // 「我这局本来打算偷池」不该变成「所以我接这个梭哈」。
  if (sit.state.allIn) return 0;
  // 「这条线该干的那件事，我这局干过了没有」—— 只有偷池在乎（见 `lineBias`）。
  const attempted = kindsOf(sit.bot).some((k) => k === 'raise' || k === 'all_in');
  const b = lineBias(sit.plan.line, key, attempted);
  // 不对称：线路对「我这局想干的那件事」是强拉力，对别的动作只是轻推。
  // 人是「这局我想偷这一把」，不是「这局我禁止自己跟注」。
  return (b >= 0 ? b : b * PLAN_VETO) * PLAN_GAIN * sit.plan.commit;
}

/**
 * 把线路叠到候选分上。
 *
 * 看牌单独处理，而且要分成两件不相干的事：
 *
 * 1. **锚**。看牌回答的是「我要不要先知道自己是什么，再决定干什么」，
 *    所以它的分只能相对「不看的话我这会儿会去做的那件事」来衡量 ——
 *    锚取其余候选叠完线路之后的最高分（它们要在同一杆秤上被 `softPick` 比较，
 *    锚在推力之前会系统性地把看牌压下去）。
 * 2. **线路自己对看牌的意见**。闷着打的那三条线（便宜看戏 / 闷压 / 闷比）
 *    表里全都明确写着「别看」—— 那正是它们之所以是闷牌线路的原因，
 *    这一项要真的加进去，不能像以前那样被跳过。
 *
 * 这样「闷着便宜」和「看清楚再打」是同一杆秤上的两头，
 * 而不是一条 `roundNo >= 2` 的门槛。
 */
function applyPlan(
  scores: Scored<Candidate>[], sit: ZjhSituation, scale: number, purpose: string, lookValue: number,
): void {
  const noise = sit.persona.tempo.noise;
  const jitter = (key: string) => (sit.rng(`${purpose}:${key}`) - 0.5) * 2 * noise;
  // 第一层：线路划定候选（§4.5）。见 `planAllows`。
  const keys = scores.map((x) => x.key);
  for (let i = scores.length - 1; i >= 0; i--) {
    if (!planAllows(sit.plan.line, scores[i].key, keys, sit.activeCount, sit.tier)) scores.splice(i, 1);
  }
  if (!scores.length) throw new Error('线路把候选删空了');
  let top = Number.NEGATIVE_INFINITY;
  for (const x of scores) {
    if (x.key === 'look') continue;
    x.score += planPush(sit, x.key) * scale + jitter(x.key);
    if (x.score > top) top = x.score;
  }
  const look = scores.find((x) => x.key === 'look');
  if (!look) return;
  /**
   * 「反正要走，走之前看一眼」。
   *
   * 看牌本身不花钱 —— 贵的是**以后**的注；而一旦弃掉，这一眼就永远看不到了。
   * 所以当此刻最想做的事正好是弃牌时，「先看一眼再扔」几乎是白捡的：
   * 没有下一口要付，翻倍这个代价根本不会发生。
   * 闷着就把牌扔了的人因此很少 —— 少到 `tests/bots.test.ts` 拿它当形状回归。
   *
   * 但「此刻最想做的事**正好**是弃牌」写成 `topKey === 'fold'` 就是一个开关：
   * 弃牌只要掉到第二名，这一份就整个消失。人不是这样的 ——「差一点就想走了」
   * 的人，看一眼的念头只是淡一点，不是没有。所以按**弃牌离最好那个动作有多远**
   * 连续地折：弃牌正好第一名时整份拿到，落后 `PEEK_SPAN` 折成 1/e，
   * 再落后自己趋近于 0，中间没有那一下台阶。这和 `softPick` 是同一杆秤
   * （分差除以一个温度），只是这里的温度问的是「多大的分差才算得上
   * 『其实我也想走』」。
   */
  const foldScore = scores.find((x) => x.key === 'fold')?.score;
  const peek = !sit.bot.looked && foldScore !== undefined && Number.isFinite(top)
    ? FOLD_PEEK * Math.exp(-Math.max(0, top - foldScore) / PEEK_SPAN)
    : 0;
  /**
   * 情绪和线路可以把「看一眼」压得很低，但压不到**不可能**。
   *
   * 这三项（局面上想不想看、走之前顺手看一眼、线路对看牌的意见）加起来，
   * 就是看牌相对「不看的话我这会儿会去做的那件事」的分差；`softPick` 的温度
   * 只有 0.06 上下，分差每多 0.14 概率掉一个数量级。于是怒气拉满时的 −0.65
   * 在行为上和 `if (上头) 不看牌` 没有区别（§4.9.4 实测 0/2000）。
   *
   * 所以往下压的那一头**过 `LOOK_GAP_KNEE` 之后改成对数**：
   *
   *  - `LOOK_GAP_KNEE` 以内一点不动（斜率就是 1），普通局面、岩石的加注、
   *    贵得离谱的一口，该压多少压多少 —— §6.2 探针量的正是这一段；
   *  - 过了这条线，每再压一个 `LOOK_TAIL` 的量级只再往下走 `LOOK_TAIL` 分。
   *    压到 −1.5 的那些步依然远在可见区之外（看牌率千分之一都不到），
   *    行为上什么都没变；变的只是「已经压到底了还要再压」这一段不再是指数。
   *
   * 两段在拐点处一阶连续（对数那支在 `LOOK_GAP_KNEE` 上的斜率也是 1），
   * 和 `range.ts` 里「越晚越硬」换掉硬两档是同一件事：单调、连续、没有台阶。
   */
  const pull = lookValue + peek + planPush(sit, 'look') * scale;
  const bounded = pull >= -LOOK_GAP_KNEE
    ? pull
    : -(LOOK_GAP_KNEE + LOOK_TAIL * Math.log1p((-pull - LOOK_GAP_KNEE) / LOOK_TAIL));
  look.score = (Number.isFinite(top) ? top : 0) + bounded + jitter('look');
}

/* ------------------------------------------------- 事件 → 通用评价 */

/**
 * 局中事件的五维评价（§4.9.1）。
 *
 * 这是**炸金花唯一知道「被加档是什么意思」的地方**：往下就只剩好坏、大小、
 * 意外、归因、可控性五个数，通用映射表拿这五个数给谁都一样地算情绪，
 * 人与人的差别只来自 `traits.sensitivity`。
 *
 * `magnitude` 一律用 `magnitudeOf`（钱是按对数感知的），
 * 看牌这种不涉及钱的事件用「离预期有多远」当大小 —— 同一个 0..1 的量纲。
 */
export function zjhAppraise(ev: ZjhEvent, self: MindState): Appraisal {
  switch (ev.kind) {
    // 被加档 / 被梭哈：坏事，别人干的，我只能接或退（可控性低）。
    // 闷着加注是便宜的表演，看牌之后压过来才是真话 —— 疼的程度差一截。
    case 'pressed': {
      const ref = Math.max(1, referencePoint(self, ev.balance));
      const bite = magnitudeOf(ev.size, ref);
      const truth = ev.looked ? 1 : 0.55;
      return {
        valence: -bite * 0.75 * truth,
        magnitude: bite,
        // 梭哈比加一档意外得多
        expectancy: ev.allIn ? 0.7 : 0.3 + bite * 0.25,
        agency: 'other',
        controllability: ev.allIn ? 0.25 : 0.45,
        by: ev.by,
      };
    }
    // 掀开自己的牌：好坏完全由牌力说了算，怪不到任何人身上（运气），也控制不了。
    // 闷得越久掀开的那一下越有戏（R16 的幻想被兑现或戳破）。
    case 'peeked': {
      const edge = clamp01(ev.strength) - 0.5;
      const held = clamp01((ev.roundNo - 1) / 4);
      const off = clamp01(Math.abs(edge) * 2);
      return {
        valence: Math.max(-1, Math.min(1, edge * 2)),
        // 打七折：掀开一手好牌是高兴，但还没赢到钱，不该一下就把「喜」顶到底
        magnitude: off * 0.70,
        expectancy: off * (0.55 + 0.45 * held),
        agency: 'luck',
        controllability: 0.1,
      };
    }
    // 有人跟我开了牌。还能走到这里就说明这一比我赢了（输的那一头已经离场，走结算）。
    case 'compared': {
      const ref = Math.max(1, referencePoint(self, ev.balance));
      const size = magnitudeOf(ev.size, ref);
      return {
        valence: ev.won ? 0.7 : -0.85,
        magnitude: size,
        expectancy: 0.5,
        agency: 'other',
        // 开牌是对方发起的，牌面已经定死，我什么都做不了
        controllability: 0.2,
        by: ev.by,
      };
    }
    // 别人之间开了牌：跟我的钱没关系，所以好坏很轻；但一个人当场被打掉是很响的一下，
    // 意外度高 —— 通用表把它主要转成「惊」和好奇，正好是「哦豁」那种反应。
    case 'watched': {
      const share = clamp01(ev.size / Math.max(1, ev.pot));
      return {
        valence: 0.10 + share * 0.20,
        magnitude: share,
        expectancy: 0.45,
        agency: 'other',
        controllability: 0.15,
        by: ev.by,
      };
    }
    // 有人扔牌走了：锅还在、人少了一个，是好事，但不是我干成的（除非我刚压过他，
    // 那也算在他的归因上 —— 通用表对 `agency: 'other'` 的好事只给一半骄傲）。
    default: {
      const share = clamp01(ev.size / Math.max(1, ev.pot));
      return {
        valence: 0.15 + share * 0.35,
        magnitude: magnitudeOf(ev.size, Math.max(1, referencePoint(self, ev.balance))),
        // 六个人的桌子上一局要走掉三四个，谁扔牌都不是新闻 —— 惊很小
        expectancy: 0.10,
        agency: 'other',
        controllability: 0.5,
        by: ev.by,
      };
    }
  }
}

/* --------------------------------------------------------------- 组装 */

export function zjhAdapter(sit: ZjhSituation): DomainAdapter<ZjhSituation, Candidate, ZjhEvent> {
  const noise = sit.persona.tempo.noise;
  const jitter = (key: string, tag: string) => (sit.rng(`${tag}:${key}`) - 0.5) * 2 * noise;

  return {
    /* ------------------------------------------------- 事件 → 通用评价 */
    appraise: zjhAppraise,

    /* ------------------------------------------------------- 粗特征 */
    coarse(ctx, self): CoarseFeatures {
      const ref = Math.max(1, referencePoint(self, ctx.bot.chips));
      const familiarity = ctx.opponents.length
        ? ctx.opponents.reduce((s, o) => s + clamp01(o.read.hands / 25), 0) / ctx.opponents.length
        : 0.5;
      return {
        selfTier: feltStrengthOf(ctx),
        threatTier: feltThreatOf(ctx),
        stakeTier: clamp01(ctx.costFraction / 0.20),
        familiarity,
        standing: Math.max(-1, Math.min(1, (ctx.bot.chips - ref) / ref)),
        counterpartKey: ctx.facts.counterpartKey,
        tags: {
          blind: ctx.bot.looked ? 0 : 1,
          roundNo: ctx.state.roundNo,
          tier: ctx.tier,
          活着的人: ctx.activeCount,
        },
      };
    },

    /* --------------------------------------------------- 系统 1 冲动 */
    intuition(f, mind, _t): Impulse<Candidate> {
      const ch = sit.channels;
      const felt = f.selfTier;
      const threat = f.threatTier;
      const habit = lookHabit(sit);
      /**
       * 人多这件事本身就是压力：六个人里要赢，中等牌根本不够看。
       * 这是系统 1 唯一「算」的东西 —— 不是概率，是「人多牌就得更好」这个印象。
       */
      const crowd = clamp01((sit.activeCount - 2) / 4);
      /**
       * 「这一口相对锅里那些钱贵不贵」。
       *
       * 人不算底池赔率，但人对「花这么点钱去够这么大一锅」是有直觉的。用它，
       * 不用「占我身家多少」：身家五十万的时候两万块只占 4%，可锅里才六千 ——
       * 按身家算，这一口永远都不疼，机器人也就永远舍不得走。
       */
      const priceOf = (c: Candidate) => clamp01(c.cost / Math.max(1, sit.pot + c.cost));
      /**
       * 「我这手东西得多好才够看」。
       *
       * 桌上人越多、对面越凶，这条线就抬得越高 —— 全是连续量，没有任何门槛。
       * 底下每一个动作都拿它当同一把尺子：跟、加、梭都是「我超出这条线多少」，
       * 弃就是「我差这条线多少」。这样「弃牌」才第一次有了跟牌力挂钩的分数；
       * 在这之前弃牌的分跟我手里是什么几乎没关系，机器人从不主动认输，
       * 全靠线路里那条「弃」把它拽走。
       */
      const need = clamp01(0.30 + crowd * 0.26 + threat * 0.75
        /**
         * 情绪进来的地方是**这条线的位置**，不是某个动作的分数（§4.9「情绪改的是尺子」）。
         *
         * 以前不是这样：弃牌那一项上挂着 `− quitThreshold * 2.20`，跟牌上挂着
         * `+ looseness * .30 + quitThreshold * .25 + callLighter * .20`。通道是十几条
         * 加法的和，打到第四轮 `quitThreshold` 的均值是 1.0 上下，于是「想不想走」
         * 这一项自己就给弃牌压了 −2.2 分，而整个牌力信号 `(need − felt) * 1.60`
         * 的幅度只有 ±0.3 —— 牌被情绪淹掉了，弃牌分和手里是什么几乎无关。
         * 竞技场里的表现正是这个形状：83% 的局最终还是弃了（对照组 84%，一样），
         * 但每一局都要多陪两条街，弃牌时已经投进去 165k，对照组只投了 114k。
         * 少赢的那部分全在这里，不在摊牌上。
         *
         * 挪到线上之后，同样这几股劲还是那个方向、还是那个人格差异，
         * 但它们的量纲变成了**牌力**：`looseness` 满格把「够看」的线拉低 0.16 个分位，
         * 相当于「宽的人愿意多打一档牌」，而不是「宽的人永远不弃牌」。
         */
        - ch.looseness * 0.16 - ch.quitThreshold * 0.14 - ch.tilt * 0.10 - ch.callLighter * 0.08
        + ch.safety * 0.12);
      /** 继续打下去要付的那一口有多贵（弃牌自己没有价格，看的是「不弃」的价格）。 */
      const goOnPrice = (() => {
        let best = 1;
        for (const c of sit.candidates) {
          if (c.key === 'fold' || c.key === 'look') continue;
          const p = priceOf(c);
          if (p < best) best = p;
        }
        return best;
      })();
      /**
       * 「这一口比公平份额贵多少」，再乘上「今天想不想继续掏这笔钱」。
       *
       * `activeCount` 个人抢一个池子，一手随机牌能分到的份额就是 `1 / activeCount`；
       * 这一口买下的池子比例是 `goOnPrice`。两者之差才是「这一口划不划算」——
       *
       *  - 开局六个人各押一千，闷着还半价：`goOnPrice` = 1/7 ≈ 0.14，公平份额 1/6 ≈ 0.17。
       *    价钱比份额还便宜，没有人会在这里站起来走（S19「几乎全员闷跟」）；
       *  - 打到两万档、锅里三万、还剩四个人：`goOnPrice` = 0.4，份额 0.25，
       *    贵了 0.15 —— 这才是「五个人是陪跑」说的那件事。
       *
       * 旧版写的是 `FOLD_BASE * (0.35 + crowd) * (FOLD_CHEAP + (1-FOLD_CHEAP) * goOnPrice/0.34)`：
       * 人数和价钱各自独立地加，而且 `FOLD_CHEAP` 给「便宜」留了 40% 的地板 ——
       * 那条地板行为上就是一条按单价短路的门槛（开局一千块的弃牌率 12%）。
       * 现在人数只通过公平份额进来，价钱免费时这一项**真的**是 0。
       *
       * `softplus` 而不是 `max(0, ·)`：贵一点点和刚好持平之间要平滑过渡，
       * 曲线在 0 附近仍然可导，没有拐死的那一下。
       *
       * 乘的这一项是情绪真正咬进决策的地方（§4.9）：上头的人不想走；
       * 刚赢过一大笔、手上宽裕的人对小注无所谓（价钱越便宜越无所谓，S13）；
       * 怕的人反过来，更想抽身。
       *
       * 它是**跟和弃共用**的那一项：弃牌 `+reluctance`，跟牌 `−reluctance`。
       * 接梭哈不算「陪着打下去」，那是一锤子买卖，该不该接全在牌力和对手上，
       * 所以那一头只留一点点。
       */
      const fair = 1 / Math.max(2, sit.activeCount);
      const overpay = FOLD_FAIR * Math.log1p(Math.exp((goOnPrice - fair) / FOLD_FAIR));
      const reluctance = (sit.state.allIn ? 0.20 : FOLD_SLOPE * overpay)
        // 闷着的人只掏一半钱，而且到这一刻为止他对自己这手牌一无所知 ——
        // 「不如走人」这个念头对他本来就轻得多（这也是闷牌弃牌该少的原因）。
        * (sit.bot.looked ? 1 : 0.50)
        * Math.max(0.1, 1
          - ch.tilt * 0.40
          - ch.ease * (1 - goOnPrice) * 0.45
          - ch.looseness * 0.50
          + ch.safety * 0.30);
      /**
       * 接梭哈要问的不是「我比这桌的平均强不强」，而是「我打不打得过**已经上台**
       * 的那几个」—— 而且是**同时**打过，不是打过其中一个（§4.6，S10）。
       *
       * 所以这里对每个已接的人各折一个单挑胜率，再**相乘**。用 `feltThreatOf` 那种
       * 「最凶的那个说了算」的混合读数会系统性地低估多人梭哈：两个人各有六成
       * 打不过我，两个一起就只剩三成六，而混合读数还停在六成 ——
       * 一手 A 高金花于是会去接两家的梭哈（S10 要的正是「这时候也得弃」）。
       */
      const acceptEdge = (() => {
        if (!sit.state.allIn) return 0;
        const committed = new Set(sit.state.allIn.accepted.filter((id) => id !== sit.bot.id));
        committed.add(sit.state.allIn.initiatorId);
        let p = 1;
        let n = 0;
        sit.opponents.forEach((o, i) => {
          if (!committed.has(o.id)) return;
          p *= clamp01(0.5 + (felt - sit.threats[i]) * 0.90);
          n += 1;
        });
        return n ? p : clamp01(0.5 + (felt - threat) * 0.90);
      })();
      const scores: Scored<Candidate>[] = sit.candidates.map((c) => {
        let s = 0;
        const stake = stakeOf(sit, c);
        const price = priceOf(c);
        if (c.key === 'look') {
          // 先占位，等别的动作都打完分再锚（看牌的价值只能相对「不看就干的那件事」来衡量）
          s = Number.NEGATIVE_INFINITY;
        } else if (c.key === 'fold') {
          // 退出没有价格，所以这里看的是**继续**的价格。
          /**
           * 「走人」这件事本身的分量 = **这一口比公平份额贵多少**，再乘上「今天想不想走」。
           *
           * 「牌桌上大多数手牌本来就该扔掉」这句话是对的，但它的理由不是「牌不好」，
           * 而是**价钱**：`activeCount` 个人抢一个池子，一手随机牌能分到的份额就是
           * `1 / activeCount`；而这一口买下的池子比例是 `goOnPrice`。两者之差才是
           * 「这一口划不划算」——
           *
           *  - 开局六个人各押一千，闷着还半价：`goOnPrice` = 1/7 ≈ 0.14，公平份额 1/6 ≈ 0.17。
           *    价钱比份额还便宜，没有人会在这里站起来走（S19「几乎全员闷跟」）；
           *  - 打到两万档、锅里三万、还剩四个人：`goOnPrice` = 0.4，份额 0.25，
           *    贵了 0.15 —— 这才是「五个人是陪跑」说的那件事。
           *
           * 旧版写的是 `FOLD_BASE * (0.35 + crowd) * (FOLD_CHEAP + (1-FOLD_CHEAP) * goOnPrice/0.34)`：
           * 人数和价钱各自独立地加，而且 `FOLD_CHEAP` 给「便宜」留了 40% 的地板 ——
           * 那条地板行为上就是一条按单价短路的门槛（开局一千块的弃牌率 12%）。
           * 现在人数只通过公平份额进来，价钱免费时这一项**真的**是 0。
           *
           * `softplus` 而不是 `max(0, ·)`：贵一点点和刚好持平之间要平滑过渡，
           * 曲线在 0 附近仍然可导，没有拐死的那一下。
           *
           * 乘的这一项是情绪真正咬进决策的地方（§4.9）：上头的人不想走；
           * 刚赢过一大笔、手上宽裕的人对小注无所谓（价钱越便宜越无所谓，S13）；
           * 怕的人反过来，更想抽身。
           *
           * 接梭哈不算「陪着打下去」，那是一锤子买卖，该不该接全在牌力和对手上，
           * 所以那一头只留一点点。
           */
          /**
           * 弃与「继续」是同一杆秤的两头，所以**跟什么比，就镜像什么**：
           * 平常比的是「够不够格陪着打下去」（`felt − need`），
           * 梭哈摆在脸上时比的是「打不打得过已经上台的那几个」（`acceptEdge − 价钱`）——
           * 后者是一锤子买卖，人数、轮次那些还没发生的东西不该进来（§4.6）。
           */
          s = sit.state.allIn
            ? -(acceptEdge - goOnPrice) * 2.60 + reluctance
            : -(felt - need) * WORTH_GAIN + reluctance;
        } else if (c.key === 'call' && sit.state.allIn) {
          /**
           * 接梭哈跟平跟不是一回事：这一口买的是**当场摊牌**。
           *
           * 所以尺子要换 —— 不是「我够不够格继续陪着打下去」（那把尺子里的
           * 人数、轮次全都还没发生），而是**直接对上台面上这几家我强不强**。
           * 这正是 S8/S9 那一对场景要的：同样的价钱、更差的牌，面对疯子该接，
           * 面对老实人该弃 —— 差别全在 `threat` 上，不在牌力上。
           */
          /**
           * 接梭哈只有一个问题：**赔率对不对得上胜率**。
           *
           * 所以这里先把「我比他强多少」折成一个单挑胜率（`edge`），
           * 再直接跟这一口买下的池子比例（`price`）相减 —— 而不是让牌力和价钱
           * 各自加一项、互相打架。旧写法两项系数稍微一动，S8/S9 就一起翻车，
           * 因为它们本来就在同一条线上，只是被拆成了两个独立的推力。
           */
          /*
           * 「他梭哈我更愿意接」（`personas.md`「待集成」#12）。`grudgeOf()` 以前
           * **只**挂在比牌的目标选择上，接梭哈这一口一分恨意都吃不到 —— 于是
           * 「被谁梭掉就找谁」这半句只在比牌那半边兑现，仇人自己把身家推上来的
           * 那一刻反而没有任何区别（实测仇人 79.2% vs 非仇人 75.5%，区间跨 0）。
           * 落点是**这一梭的发起人**，不是恨值最高的那个人：只有他把钱推上来了，
           * 这一口才是「跟他算账」的机会。
           */
          const shover = sit.state.allIn.initiatorId;
          s = (acceptEdge - price) * 2.60 + 0.10 - stake * 0.25
            + ch.looseness * 0.20 + ch.quitThreshold * 0.20
            + sit.persona.allIn.accept * 0.30
            + (sit.bot.looked ? 0 : (sit.persona.allIn.blindAccept - 0.5) * 0.30)
            + grudgeOf(sit, mind, shover) * 0.30;
        } else if (c.key === 'call') {
          /**
           * 跟与弃是**同一杆秤的两头**（§4.9.7）：牌力这一头 `(felt − need)`，
           * 价钱那一头 `reluctance`（「这一口比公平份额贵多少」，见 `fold` 分支）。
           * 两个动作用同一个 `WORTH_GAIN`、同一个 `reluctance`，符号相反 ——
           * 这样「该不该继续」只有一个答案，不会出现两边各自加一堆项、
           * 加着加着两项都为正（既想跟又想弃）的情况。
           * `+ 0.10` 是「都到这儿了」那点惯性，`− stake` 是身家占比的怯场。
           */
          s = (felt - need) * WORTH_GAIN - reluctance + 0.10 - stake * 0.30
            // 慢打：牌好到一定份上，爱演的人反而不动声色 —— 把人留在池子里比现在收钱值。
            + Math.max(0, felt - 0.72) * sit.persona.tempo.theatre * 2.40;
        } else if (c.key.startsWith('raise')) {
          // 一口气从 1000 跳到 10 万是「猛」，不是「加注」：跳档越大越需要牌力和脾气撑着。
          const unit = c.unit ?? sit.state.betUnit;
          const jump = clamp01(
            Math.log(Math.max(1, unit / Math.max(1, sit.state.betUnit))) / Math.log(100),
          );
          /**
           * 偷池的底气：牌不行，但**这一口顶上去**这桌人跑不跑得掉，而且我在后位。
           * 注意用的是这个价位上的吓退概率，不是当前价位的 —— 诈唬靠的就是那一口的份量，
           * 小加注吓不走人。爱演的人（`theatre`）才会去试。
           */
          // `theatreNow` 而不是裸的 `tempo.theatre`：刚被当场比穿过的人不敢再演
          // （personas.md 待集成 #3；同一个系数也削他的用时表演，见 `tempo.ts`）。
          const bluff = foldAll(sit.ev, unit) * sit.position * (1 - felt)
            * theatreNow(sit.persona.tempo.theatre, mind.caught);
          /**
           * 加价的正面理由有**两个**，上面那行只写了其中一个。
           *
           * `bluff` 是「牌不行，靠对面跑」；另一头是「牌好，靠对面**不**跑」——
           * 留下来的每一个人这一轮都得多掏一档，这才是好牌该加价的原因。
           * 以前这一项根本不存在：加价只被算成「多付一口的价钱」，
           * 于是牌越好越只会平跟（竞技场加注率 11.4%，对照组 18.5%；
           * 摊牌均强 0.74 却几乎不主动抬价 —— 一手好牌白拿）。
           *
           * 量纲：`stay` 是这一口顶上去之后**还会跟的人的比例**，
           * `felt − need` 是「我比这条线好多少」（分位），人越多这一刀收得越多。
           */
          const stay = 1 - foldAll(sit.ev, unit);
          /**
           * 抬价那一头的「赢家诅咒」：跟我这一口的人，是牌**更好**的那批
           * （`CMP_EDGE` 对开牌、`ALLIN_EDGE` 对梭哈说的是同一件事，抬价这一头
           * 一直缺着）。所以「我超过这条线」还不够，得**明显**超过才值得抬价 ——
           * 不然抬的是价，收的是别人的好牌（加注率补到 16.9% 时净胜反而从
           * −10029 掉到 −19175，缺的就是这道坎）。
           */
          /**
           * 赢家诅咒只在**大家真的会跟**的时候才成立（2026-09-04 P2.1）。
           *
           * `need` 里已经按 `crowd × 0.26` 收过一次人数了，这里再收一次
           * `crowd × RAISE_CROWD`，人数被罚了两遍：满桌 `crowd = 1` 时
           * `worth = 1.0 − 0.56 − 0.75×threat − 0.45 ≤ −0.01`，**任何牌力**的
           * `worth` 都是负的，「好牌该收钱」那一项 `value` 于是恒等于 0 ——
           * 六人桌上一手豹子从来不会为了收钱抬价。
           *
           * 真正的赢家诅咒是「跟我这一口的都是牌更好的那批」，而一桌人都要跑的时候
           * 根本没有人来跟，也就没有什么诅咒。所以这道坎乘上 `stay`：
           * 会跟的人越多，坎越高（`value` 那一头收得也越多，两头量纲一致）；
           * 一吓就跑的桌子上，抬价不该被人数罚。
           */
          const worth = felt - need - crowd * RAISE_CROWD * stay;
          /**
           * **加价收的钱要跟档位走**（`docs/zjh/personas.md`「待集成」#6）。
           *
           * 上面那段注释写的是「留下来的每一个人这一轮都得多掏一档」，但式子里
           * 一个字都没体现「多掏多少」：`value` 只有「有几个人会留下」（`stay`）
           * 和「我强多少」（`worth`），而 `stay` 是随档位**单调下降**的 ——
           * 于是好牌的价值项在高档上只会更小，牌力反过来把人往低档推。
           * 实测的后果就是「加注档位就是他的牌力区间」这条破绽换不成钱：
           * 数学型顶档（10 万）均牌力 0.731、低档 0.652–0.668，只差 0.06 分位。
           *
           * `jump` 就是「这一口比现价大多少」（对数尺，一口气跳 100 倍 = 1）。
           * 乘上去之后价值加注变成「会跟的人数 × 每个人多掏的钱 × 我的边际」，
           * 三项齐了：好牌敢跳档，坏牌那一头走的是 `worth * stay` 的负分支，
           * 不吃这份放大，所以偷池不会跟着一起往上跳。
           */
          const value = stay * Math.max(0, worth) * clamp01((sit.activeCount - 1) / 3) * VALUE_GAIN
            * (0.60 + jump * 1.40);
          /**
           * 牌不够这一头**只有在有人跟的时候才兑现**：全桌都跑了，我这手小顺子
           * 差多少根本没人罚。所以负的 `worth` 同样乘 `stay`（和 `value` 那一头
           * 一个道理，只是方向相反）—— 这正是「偷池」这条线成立的全部理由，
           * 也是 S11 ④「走上偷池线的手全都加价」的来源：不乘 `stay` 的话，
           * 一条本来就是拿弱牌打的线会被自己的牌力项否掉（实测 200 手里只有 69% 加价）。
           */
          s = (worth >= 0 ? worth : worth * stay) * WORTH_GAIN - price * 0.60 + 0.06 - stake * 0.30
            + ch.aggression * 0.55 + ch.greed * 0.20
            + value
            + bluff * 1.90
            // 敢一口气往上跳，靠的是**看见过**的牌力，或者「这桌人会跑」的判断；
            // 闷着又没有把握的时候，往上跳只能靠脾气。
            - jump * Math.max(
              0,
              1.35 - (sit.strength === undefined ? felt * 0.55 : felt) * 2.10
                - ch.aggression * 0.35 - bluff * 1.60,
            );
        } else if (c.key.startsWith('compare')) {
          const i = sit.opponents.findIndex((o) => o.id === c.targetId);
          const th = i >= 0 ? sit.threats[i] : threat;
          /**
           * 开牌是**点名单挑**，所以尺子换了一把：不是「我够不够全场看」，
           * 而是「我比他强多少」。这是比牌唯一该问的问题。
           *
           * 闷着开牌是把没看过的牌直接推上台面：`compare.blind` 就是「我信不信
           * 这股幻想到敢开牌」，`BLIND_COMPARE` 把它整体校到 §6.4 的「闷比 5–15%」。
           */
          /**
           * 闷着开牌**多出来的那股劲**：不是「我算得过他」，是「与其一口口掏下去，
           * 不如半价把它摊了」（§4.4 闷比）。所以它是一项**加上去的信念**，
           * 不是乘在「我比他强多少」上的系数 —— 乘的话就没法调了：闷着的人
           * 对任何人都是 `pWin(0.5, 他的范围) ≈ 0.5`，`beat ≈ 0`，
           * 乘多少还是 0（实测闷比掉到 2.5%–4.0%，§6.4 要 5–15%）。
           * `BLIND_COMPARE` 把这股劲整体校到 §6.4 的区间。
           */
          const blindPush = sit.bot.looked ? 0 : sit.persona.compare.blind * BLIND_COMPARE;
          /**
           * 闷着开牌不能拿「闷牌幻想」当牌力：R16 那点加成是**打牌**时的底气，
           * 摊到台面上它一分钱都不值。所以这里把幻想剥掉，用「一手中不溜的牌」
           * 当真实预期，敢不敢拿它去开牌，全交给 `conviction`。
           */
          /**
           * 「我比他强多少」要用**范围模型**算，不是用威胁值凑。
           *
           * `sit.threats[i]` 是 `storyHeat × credibility` 的启发式，量的是「他这一局
           * 讲得凶不凶」；文档 §4.4「闷比」那一行和 §6.4「比牌目标是范围最弱者」
           * 说的都是 `showdownBucket` —— 也就是**他的范围**。两把尺子挑出来的人不一样：
           * 用威胁值挑，六台 v3 自对弈的「挑最软」只有 74.8%（§6.4 要 ≥70%，
           * 返工验收要 ≥75%）；换成 `pWin(我的分位, 他的范围)` 之后是下面报表里的数字。
           * 可信度并没有被丢掉 —— 它在 `refine` 的原型斜率里，本来就该在那儿生效一次。
           *
           * 闷着开牌时我不知道自己是什么，就拿一手中不溜的牌（0.5 分位）去排序：
           * 排出来的先后和拿任何一手固定的牌排都一样，`pWin` 对对手范围是单调的。
           */
          /**
           * **挑谁**这件事由 `compare.softness` 在两把尺子之间调（§4.7.4：
           * 1 = 完全按 pWin 挑最软，0 = 谁投得多挑谁）。
           *
           * 这个字段到 P3 交付为止在 `shared/` 里一个消费方都没有，于是 §4.7.2
           * 赌徒那一行的「挑投入最多的（想一口吃大的）」根本没兑现 ——
           * A 线实测他的「投入排位」是 0.367，常人 0.368，两张卡挑人挑得一模一样。
           *
           * 两把尺子都归一到同一个 0..1 的「这个目标值不值得开」，才好按比例掺：
           * 软度那一半是 `pWin(我, 他的范围)`；投入那一半是他本局投入在**还在局的
           * 对手**里的位置（最少 0、最多 1、都一样时 0.5）。掺完的数继续走
           * 原来的 `beat = (edge − 0.5) × 2`，比牌该不该开那道坎一个字没动。
           *
           * 注意它对闷着的人同样有效：闷牌时 `pWin(0.5, ·) ≈ 0.5` 对谁都一样，
           * 挑人这件事本来就退化成掷骰子；掺进投入之后，赌徒闷着也知道
           * 「找那个投得最多的开」。
           */
          const soft = clamp01(sit.persona.compare.softness);
          const bets = sit.opponents.map((o) => o.bet);
          const lo = Math.min(...bets), hi = Math.max(...bets);
          const investEdge = i >= 0 && hi > lo ? (bets[i] - lo) / (hi - lo) : 0.5;
          const softEdge = i >= 0
            ? pWin(sit.strength === undefined ? 0.5 : sit.strength, sit.dists[i], sit.state.settings.dealMode)
            : 0.5 + ((sit.strength === undefined ? 0.5 : felt) - th) / 2;
          const oppEdge = i >= 0 ? soft * softEdge + (1 - soft) * investEdge : softEdge;
          const beat = (oppEdge - 0.5) * 2 + blindPush;
          /**
           * 池子「熟」了没有：打了几轮 + 这一锅涨了多少倍。
           *
           * 它是「值不值得**现在**收网」的权重，**不是**一股无条件把人推去开牌的力。
           * 之前它是加上去的一项，于是打到后面不管手里是什么都想开牌 ——
           * 竞技场里每一次主动比牌平均亏掉二十万，全是被这一项推出去的。
           */
          const ripe = 0.6 * clamp01((sit.state.roundNo - 1) / 4) + 0.4 * potMaturity(sit);
          // 赢了他，池子还得从剩下的人手里守住 —— 人越多，这一刀越不划算（养池）。
          // 「把牌亮出来」这件事本身就有代价：赢了只收下眼前这点池子，
          // 输了白付两倍的价，而且从此桌上所有人都知道我是什么。
          // 所以开牌要有个明确的门槛 —— 不是「不许开」，是「得划算才开」。
          /**
           * 开牌的价钱要跟**平跟**比，不是跟「什么都不做」比。
           *
           * 比牌是「多付一口的钱，换掉一个对手」：不比也得跟，那一口本来就要付。
           * 拿整笔比牌钱去算赔率，等于把跟注的成本重复算了一遍，
           * 于是单价一升档就再也不敢开牌 —— 六人桌上后面几轮压根不会有比牌。
           */
          const extra = clamp01((c.cost - sit.cost) / Math.max(1, sit.pot + c.cost));
          /**
           * 闷着开牌那道坎要浅得多，两个原因都不是「因为它是闷牌」：
           * 一是价钱 —— 闷牌的比牌钱是看牌人的一半，赔率本来就宽；
           * 二是这一步买的不是「我确定打得过他」，而是「与其一口口掏下去，
           * 不如半价把它摊了」（§4.4 闷比）。多留的那点余量是给「挑错人」用的，
           * 闷着的人本来就没在挑，也就没什么诅咒可言。
           */
          // 桌上人越多，「赢家的诅咒」咬得越狠（我挑中的那个最软的，越可能只是
          // 被低估的那个），而且赢了这一刀也只是把人数从四个变成三个 ——
          // 池子还得从剩下的人手里守回来。单挑没有这两件事，坎就低。
          const edge = sit.bot.looked ? CMP_EDGE + crowd * CMP_CROWD : CMP_BLIND;
          /**
           * **把他开掉就再也榨不到他了** —— 比牌真正的代价，以前一分钱没算（P2.1）。
           *
           * 上面那一串问的全是「我打不打得过他」，于是 `beat` 越大分越高，
           * 一手豹子成了「最该开牌的牌」。真人是反过来的：牌越大越舍不得开，
           * 因为开掉就只收下眼前这一锅，而留着他还能一轮一轮地收。
           *
           * 这一项就是那笔机会成本，三个因子各管一件事：
           *
           *  - `max(0, beat)`：**只有真占优才有得榨**。打不过他的时候留他没有价值，
           *    所以 `beat ≤ 0` 时这一项恒等于 0 —— 顺子、对子、散牌的比牌率
           *    一分不受影响（它们本来就 ≈ 0%，改完还得是 0%）；
           *  - `stay`：**他还跑不跑得掉**。对面已经准备走了，留着也榨不到，
           *    惩罚自己就小 —— 这正是「他要跑，那现在就开了他」那句真人直觉。
           *    对面正在顶我（威胁高）时 `stay` 高但 `beat` 被他的范围压低，
           *    两头一乘惩罚同样小，「被顶了就摊牌」也保住了；
           *  - `persona.compare.milk`：**这个人是想做大还是见好就收**（§4.7）。
           *
           * 牌力因此只经 `pWin → beat` 进入比牌这件事一次，而且是**一正一负**
           * 两条路：正的那条说「我赢得了他」，负的这条说「所以更该留着他」。
           * 净效果在极强牌那一头把比牌压下去，中上牌那一头几乎不动。
           */
          const stay = 1 - foldAll(sit.ev, sit.state.betUnit);
          const left = 1 - clamp01((sit.state.roundNo - 1) / 3);
          const milk = Math.max(0, beat) * stay * left * sit.persona.compare.milk * CMP_MILK;
          s = (beat - edge) * WORTH_GAIN * (0.55 + ripe * 0.75) - extra * 1.30 - crowd * 0.45 - 0.20
            - milk
            + ch.aggression * 0.25 + ch.showoff * 0.30 + ch.ease * 0.30
            + (c.targetId ? grudgeOf(sit, mind, c.targetId) * 0.35 : 0);
        } else {
          /**
           * 一梭下去，桌上会跟的只剩下打得过我的那几个 —— 弱的都跑了。
           * 所以「我比这桌的平均要强」不是梭哈的理由，跟开牌是同一件事
           * （`CMP_EDGE` 那段），这里是它在梭哈这一头的对应项。
           */
          s = (felt - need - ALLIN_EDGE) * WORTH_GAIN - price * 0.80 - 0.10 - stake * 0.40
            + ch.risk * 0.60 + ch.aggression * 0.35
            + (sit.persona.allIn.initiate - 0.5) * 0.40
            /**
             * 诈唬梭哈（人物卡 `allIn.bluff`，§4.7.2「诈唬梭哈的意愿」）：牌不够、但这一桌
             * 会跑（`steal` 是按对手范围算出的弃牌率）时，愿意拿身家去吓人的那一口。
             * 只在牌力**低于**他自己的价值线时起作用 —— 有真牌的梭哈走上面的价值项，
             * 不叫诈唬；乘 `steal` 是因为没人会跑的桌子上诈唬梭哈只是送钱，再爱演也不干。
             */
            + sit.persona.allIn.bluff * sit.steal
              * clamp01((sit.persona.allIn.valueFloor - felt) / 0.30) * 2.5;
        }
        return { action: c, key: c.key, score: s };
      });
      // 先按局面把「看不看牌」锚好，再统一叠线路与噪声 ——
      // 否则线路把某个动作顶得越高，看牌的锚就跟着水涨船高，看牌率会被线路的力度带偏。
      applyPlan(scores, sit, 1, 's1', habit);
      const sorted = [...scores].sort((a, b) => b.score - a.score);
      const gap = sorted.length > 1 ? sorted[0].score - sorted[1].score : 0.5;
      const arousal = arousalOf(mind);
      /**
       * 冲动是**抽**出来的，不是排出来的。
       *
       * 两个分差不多的动作，人这一把跟、下一把顶一手，自己也说不清为什么 ——
       * 「狡诈」不是一条 `if (随机数 < bluffRate)`，而是这个人的温度更高：
       * 同样的烂牌，他比老实人更容易冒出「顶他一下试试」的念头。
       * 上头、陌生的桌子都会把温度抬起来（唤醒高的人更飘）。
       */
      const tau = 0.018 + sit.persona.tempo.noise * 0.40
        + arousal * 0.05 + (1 - f.familiarity) * 0.02;
      const pick = softPick(scores, sit.rng, tau, 's1:pick');
      return {
        action: pick.action,
        key: pick.key,
        // 情绪越高越笃定 —— 上头的人不觉得自己在赌
        confidence: clamp01(0.20 + gap * 2.8 + arousal * 0.20 - (1 - f.familiarity) * 0.05),
        feltStrength: felt,
        feltThreat: threat,
        scores,
      };
    },

    /* ------------------------------------------------- 系统 2 算账 */
    deliberate(ctx, mind, _t): Deliberation<Candidate> {
      const ch = ctx.channels;
      const habit = lookHabit(ctx);
      const scores: Scored<Candidate>[] = ctx.candidates.map((c) => {
        let s = 0;
        if (c.key === 'look') {
          s = Number.NEGATIVE_INFINITY;   // 同上，等锚
        } else if (c.key === 'fold') {
          // 弃牌的基准值是 0；「不甘心」（沉没成本、面子、报复）落在 quitThreshold 上
          s = -ch.quitThreshold * 0.30;
        } else if (c.key === 'call') {
          s = ctx.state.allIn
            ? evAcceptAllIn(ctx.ev, ctx.showdownDists, ctx.acceptPrice)
              + ctx.persona.allIn.accept * 0.25
              + (ctx.bot.looked ? 0 : (ctx.persona.allIn.blindAccept - 0.5) * 0.25)
              // 同 s1：接的是**这一梭的发起人**，恨意在算账这一侧也要算进去（#12）
              + grudgeOf(ctx, mind, ctx.state.allIn.initiatorId) * 0.25
            : evCall(ctx.ev);
          s += ch.looseness * 0.10 + ch.quitThreshold * 0.10 + ch.callLighter * 0.08;
        } else if (c.unit !== undefined) {
          s = evRaise(ctx.ev, c.unit)
            + ch.aggression * 0.14 + ch.greed * 0.06 - ch.safety * 0.06;
        } else if (c.targetId !== undefined) {
          const i = ctx.opponents.findIndex((o) => o.id === c.targetId);
          const gate = ctx.opponents.length <= 1 ? ctx.persona.compare.heads : ctx.persona.compare.multi;
          s = evCompare(ctx.ev, Math.max(0, i))
            // 「这个目标值不值得清」在旧版是个硬阈值，这里变成开火的连续代价
            - gate * 0.30
            + grudgeOf(ctx, mind, c.targetId) * 0.25
            + ch.showoff * 0.10;
        } else {
          const felt = ctx.strength ?? 0.5;
          s = evAllIn(ctx.ev)
            + ch.risk * 0.16
            + (ctx.persona.allIn.initiate - 0.5) * 0.25
            + (felt - ctx.persona.allIn.valueFloor) * 0.35
            /**
             * 一桌一吓就跑的人，好牌梭哈是把钱吓跑（§4.6，S8 的反面）。
             *
             * `evAllIn` 把「没人接」算成一份干净的收益 —— 对一手烂牌那确实是全部收益，
             * 对一手怪物那是**损失**：本来还能榨两口，一梭全跑了。一次性的 EV 看不见
             * 这笔机会成本，所以在这里按「牌力 × 这桌人会跑的程度」把它扣回来。
             */
            - Math.max(ctx.steal, noCallChance(ctx.ev))
              * Math.max(0, felt - 0.60) * ctx.persona.allIn.foldEquityWeight * 18.0;
        }
        return { action: c, key: c.key, score: s };
      });
      // 真算：看完之后我能做出更好的选择，这个选择权值多少（`lookValue` 本身就是个差值）
      // 系统 2 也认线路 —— 算完账还是会「我这局就是来偷这一把的」。
      // 但它的量级比系统 1 小：想清楚的人比冲动的人更容易改主意。
      applyPlan(scores, ctx, 0.90, 's2', lookValue(ctx.ev) + habit * 0.55);
      const sorted = [...scores].sort((a, b) => b.score - a.score);
      const margin = sorted.length > 1 ? sorted[0].score - sorted[1].score : 0.5;
      return {
        best: sorted[0].action,
        bestKey: sorted[0].key,
        scores,
        // 越贴近分界线越难 —— 用时就是从这儿来的
        difficulty: clamp01(1 - Math.abs(margin) / 0.14),
      };
    },

    /* ----------------------------------------------------- p2 的输入 */
    stakes(ctx, _self) {
      const familiarity = ctx.opponents.length
        ? ctx.opponents.reduce((s, o) => s + clamp01(o.read.hands / 25), 0) / ctx.opponents.length
        : 0.5;
      return {
        // 这一步押上的比例，加上池子相对身家的分量
        stakes: clamp01(ctx.costFraction / 0.15 * 0.7 + clamp01(ctx.pot / Math.max(1, ctx.bot.chips)) * 0.3),
        // 机器人不受行动时限逼迫（服务器的延迟由我们自己给），只有梭哈那一下算紧
        timePressure: ctx.state.allIn ? 0.25 : 0,
        familiarity,
      };
    },
  };
}
