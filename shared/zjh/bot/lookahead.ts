/**
 * 前瞻与 EV（设计文档 §4.5）—— **系统 2 的工具**（§4.9.7）。
 *
 * 这里算的是「账」：跟这一口、加到某一档、对某个人比牌、梭哈，各自值多少。
 * 但它只有在系统 2 真的介入的时候才会被调用；系统 1 的冲动一步都不走这里。
 * 这正是设计文档要的形状 —— 人不是每一步都算账的，累了、上头了、
 * 局面太熟了就直接凭感觉。
 *
 * 所有 EV 都按**底池归一化**（除以 `max(1, pot)`），这样「±5% 的性格噪声」
 * 有确定的量纲，不同规模的池子之间也可以比。
 */

import {
  allInCost, callCost, compareCost, handPercentile,
  type DealMode, type PlayerState, type RoomState,
} from '../../game.ts';
import { unitTier } from './events.ts';
import {
  pWin, pWinBlind, pWinShowdown, priorDist, tightenForAccept, type RangeDist,
} from './range.ts';

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/**
 * 这一桌的发牌档。桶边界与牌力分位都随它走（`shared/game.ts` 的 `categoryBands`），
 * 所以凡是要把「分位」和「范围分布」放在一起算的地方都得从 `input.state` 取一次，
 * 而不是用默认档。EV 全程只读 `state`，`botAction` 的签名和信息边界都不动。
 */
const dealModeOf = (input: EvInput): DealMode => input.state.settings.dealMode;

/** 前瞻要用到的一切。由 `situation.ts` 组装，这里只做算术。 */
export interface EvInput {
  state: RoomState;
  bot: PlayerState;
  /** 还在局的对手（公开视图，没有暗牌） */
  opponents: { id: string; chips: number; bet: number; looked: boolean }[];
  /** 与 `opponents` 一一对应的范围分布 */
  dists: RangeDist[];
  /** 每个对手在**当前价位**上「本来就会不会继续」的概率 */
  foldProb: number[];
  /**
   * 我把单价抬到 `unit` 的话，每个对手会跑的概率（与 `opponents` 一一对应）。
   *
   * 弃牌率是**价格的函数**，不是一个人身上的常数：同一个人，闷着面对一千块和
   * 看过牌面对十万，是两回事（S11）。所以这里传的是一条曲线，不是一排数。
   */
  foldAt: (unit: number) => number[];
  /** 每个对手「会接梭哈」的概率 */
  acceptProb: number[];
  /** 已知牌扣除之后的公共先验（闷牌时代表我自己） */
  prior: RangeDist;
  /** 我的牌力分位；闷着的时候是 undefined */
  strength?: number;
  /** 前瞻深度（人物卡的 `cognition.lookahead`） */
  depth: 0 | 1 | 2;
  /** 概率权重函数（R26），系统 2 用主观概率算账 */
  weight: (p: number) => number;
}

/** 这一轮就见分晓的比例，剩下的进入下一轮。前瞻的收敛项。 */
const SHOWDOWN_SHARE = 0.5;

/** 下一个可加的档位；已经到顶就翻倍（和引擎的自动升档同口径）。 */
function nextUnit(state: RoomState, unit: number): number {
  const higher = state.settings.betOptions.filter((u) => u > unit);
  return higher.length ? higher[0] : unit * 2;
}

/**
 * 这一轮打完之后，桌上的单价会是多少（引擎的自动升档表，`shared/game.ts`）。
 *
 * 复刻的是 `state.settings` 里那两条：`escalateFrom` 起每两轮升一档，
 * 以及不封顶时第 6 轮起的兜底加压。没轮到升档就返回当前单价 —— 这一点很要紧，
 * 「下一轮的价」不能想当然地按最贵那一档算：本局的 `betOptions` 第二档是 20 倍跳，
 * 拿它去问「他们会不会被吓走」，第 1 轮的答案会变成「多半会」，那是假的。
 */
function unitAhead(state: RoomState): number {
  const { escalateFrom, maxRounds } = state.settings;
  const onSchedule = escalateFrom > 0
    && state.roundNo >= escalateFrom
    && (state.roundNo - escalateFrom) % 2 === 0;
  const forced = maxRounds <= 0 && !onSchedule && state.roundNo >= 6;
  return onSchedule || forced ? nextUnit(state, state.betUnit) : state.betUnit;
}

/**
 * 我在这个价位上的胜率（主观加权后的）。
 *
 * 两件事必须一起做，否则账是错的：
 *
 * 1. **要赢就得赢过所有还在的人**（`showdown` 口径）。「场面口径」把第二个以后的
 *    对手只算一半权重，那是估「我能不能不摊牌就拿下」用的；一旦池子按「大家都跟」
 *    算大了，再用打过折的胜率去乘它，就是拿虚高的赢面去乘虚高的池子。
 * 2. **没走的人是被筛过的**（选择偏差，和 §4.6 接梭哈那一段是同一条道理）：
 *    加了一档还留在桌上的人，手里的东西平均比他的原始范围硬。他越容易被吓走，
 *    他这次没被吓走就越说明问题 —— 所以收紧的力度正是他的「留下概率」。
 */
function equityOf(input: EvInput, unit: number): number {
  const { strength, dists, prior, weight } = input;
  const mode = dealModeOf(input);
  const field = dists.length
    ? dists.map((d, i) => tightenForAccept(d, clamp01(1 - scaredAt(input, unit, i)), mode))
    : [prior];
  const raw = strength === undefined
    ? pWinBlind(field, prior, 'showdown')
    : pWinShowdown(strength, field, mode);
  return clamp01(weight(raw));
}

/**
 * 我这一口下去，他会不会走。
 *
 * **没有加档就没有压力**：别人已经在这个价上了，我平跟一口不会把任何人赶走 ——
 * 所以 `up = 0` 时弃权概率是 0，不是他的弃牌率。旧版把「他面对加压会跑」
 * 直接算进平跟，等于让机器人相信「我跟一口对面就会认输」，
 * 于是烂牌面对紧手的连续加注反而算出正期望（S7 就是这么破的）。
 *
 * 加了档，弃牌率就按**那一档的价钱**重新问一次（`foldAt`）——「跳得越高走的人越多」
 * 不再是一条乘在旧数上的饱和曲线，而是价格先验 + 条件统计自己算出来的（S11）。
 * 上限在 `foldProbOf` 里封在 0.9：加到再高也永远走不干净，
 * 否则模型会得出「加满 = 一定没人跟 = 只赢底池」这种反常结论。
 */
function scaredAt(input: EvInput, unit: number, i: number): number {
  const up = unitTier(unit, input.state.settings) - unitTier(input.state.betUnit, input.state.settings);
  if (up <= 0) return 0;
  return input.foldAt(unit)[i] ?? 0;
}

/**
 * 在某个价位上，全场都被吓走的概率；档位越高越容易吓走人。
 *
 * 系统 1 也用它 —— 那边用的不是「算出来的赔率」，而是同一个印象：
 * 「我要是把这一口顶上去，这桌人跑不跑得掉」。所以导出。
 */
export function foldAll(input: EvInput, unit: number): number {
  const { foldProb } = input;
  if (!foldProb.length) return 1;
  return foldProb.reduce((acc, _f, i) => acc * scaredAt(input, unit, i), 1);
}

/**
 * 这个价位上预计还有几个人跟进来。
 *
 * `scared()` 回答的是「**我这一口**会不会把他吓走」，所以平跟（`up = 0`）时它是 0 ——
 * 那对「我能不能不摊牌就赢下底池」是对的。但拿它去估**池子会涨多少**就错得离谱：
 * 等于认定「我跟一口，全场都会陪我再投一口」，池子被系统性放大 `n` 倍，
 * 于是任何跟注都算得划算 —— 机器人被这条式子直接打成跟注站。
 * 池子这边要用的是他**本来就会不会继续**（`f` 是他的弃牌率），
 * 加压之后再取两者中更容易走的那一个。
 */
function expectedCallers(input: EvInput, unit: number): number {
  return input.foldProb.reduce((sum, f, i) => sum + (1 - Math.max(f, scaredAt(input, unit, i))), 0);
}

/**
 * 这个价位上预计还会有多少钱进池 —— 按**每个人自己**要付的价算，不是按我的价。
 *
 * 旧写法 `m × c` 拿我的这一口（含我的看牌倍率）当所有人的投入：我看过牌、他闷着，
 * 他那一口就被算成了两倍；他筹码不够一口了，也照样按整口记。池子被系统性算大，
 * 「跟一口」就显得比实际划算。这里逐人取 `min(剩余筹码, 单价 × 他的倍率)`。
 */
function expectedInflow(input: EvInput, unit: number): number {
  return input.foldProb.reduce((sum, f, i) => {
    const o = input.opponents[i];
    const stay = 1 - Math.max(f, scaredAt(input, unit, i));
    return sum + stay * Math.min(Math.max(0, o?.chips ?? 0), unit * (o?.looked ? 2 : 1));
  }, 0);
}

/**
 * 继续打下去值多少（净值，相对于「现在弃牌 = 0」）。
 *
 * `-c + f×P + (1−f)×[ 一半这轮摊牌，一半再打一轮 ]`：
 * 付出这一口 `c`；有 `f` 的概率全场被吓走，直接赢下 `P`；否则池子被跟到 `Pn`，
 * 要么当场摊牌拿 `eq×Pn`，要么进下一轮 —— 下一轮我**还有弃权**，所以那一支取 `max(0, …)`。
 * 「下一轮还能退出」这个选择权正是前瞻的价值所在：没有它，机器人会把每一次跟注
 * 都当成一路跟到底。
 */
function continueValue(input: EvInput, pot: number, unit: number, depth: number): number {
  const mult = input.bot.looked ? 2 : 1;
  const c = unit * mult;
  const eq = equityOf(input, unit);
  /**
   * 「一个人都不剩」这一支要按**他们真正要面对的那个价**来问（2026-09-04 P2.1）。
   *
   * `scaredAt` 在 `up <= 0` 时返回 0 是对的 —— 我平跟一口不会把任何人赶走。
   * 但由此得到的 `foldAll(input, betUnit) ≡ 0` 被当成了「留下来的人一个都不会走」，
   * 于是「我跟着打下去、他们陆陆续续走光、池子归我」这一支在账上压根不存在，
   * 「留人」那条路的价值被系统性地低估 —— 这正是 §4.6 的比牌账里
   * 「赢了他之后还能从剩下的人手里榨多少」算不出来的另一半。
   *
   * 要问的是**下一轮他们要面对的那个价**。它不是我随口抬的，是引擎的升档表
   * （`shared/game.ts` 的 `escalateFrom` / `maxRounds`）定死的：本局设置里
   * 第 3 轮起每两轮升一档，之前的轮次价钱不动。所以只有「这一轮打完真的会升档」
   * 的时候才拿升一档的价去问；不会升档的轮次答案就是「没人会走」，那也是实话 ——
   * 开局一千块的价钱本来就吓不跑任何人（S19）。已经在加价的那一支保持原样
   * （那时候 `unit` 本身就是他们要面对的价）。
   */
  const f = foldAll(input, Math.max(unit, unitAhead(input.state)));
  const pn = pot + c + expectedInflow(input, unit);
  const showdown = eq * pn;
  // 全场都弃：底池连同自己刚投进去的这一口都归自己 —— 所以是 pot + c，不是 pot。
  if (depth <= 0) return -c + f * (pot + c) + (1 - f) * showdown;
  const nu = nextUnit(input.state, unit);
  let later = Math.max(0, continueValue(input, pn, nu, depth - 1));
  // 闷着的人下一轮**还可以看**：这一支不进账，闷牌就永远算不过看牌（见 `lookValue`）。
  if (!input.bot.looked) later = Math.max(later, deferredLook(input, pn, nu, depth - 1));
  return -c + f * (pot + c) + (1 - f) * (SHOWDOWN_SHARE * showdown + (1 - SHOWDOWN_SHARE) * later);
}

/** 前瞻里代表「我这手牌可能是什么」的五个分位。 */
const LOOK_QUANTILES = [0.1, 0.3, 0.5, 0.7, 0.9];

/**
 * 「先闷这一口，下一口再看」值多少。
 *
 * 少了这一支，前瞻就是拿「看完之后一路明着打」去比「一辈子闷着打」——
 * 那当然怎么算都该现在就看，`lookValue` 于是把**整手牌**的信息价值
 * 全记在「现在这一眼」头上，闷压（S1）在账本里根本没有出现的机会。
 *
 * 真正该问的是「现在看，还是先闷这一口、下一口再看」：后者信息一分不少，
 * 只是晚一轮到手，中间这一口还只掏半价。两支都在账上，看牌才回到它真实的价钱。
 */
function deferredLook(input: EvInput, pot: number, unit: number, depth: number): number {
  const looked = { ...input.bot, looked: true } as PlayerState;
  let sum = 0;
  for (const q of LOOK_QUANTILES) {
    // 看完之后我还可以退出，所以每一个分位都取 max(0, …)
    sum += Math.max(0, continueValue({ ...input, bot: looked, strength: q }, pot, unit, depth));
  }
  return sum / LOOK_QUANTILES.length;
}

/** 跟这一口值多少（归一化）。 */
export function evCall(input: EvInput): number {
  const pot = Math.max(1, input.state.pot);
  return continueValue(input, input.state.pot, input.state.betUnit, input.depth) / pot;
}

/** 加到某一档值多少（归一化）。档位越高，`foldAll` 越大 —— 偷池的价值自动出现在这里。 */
export function evRaise(input: EvInput, unit: number): number {
  const pot = Math.max(1, input.state.pot);
  return continueValue(input, input.state.pot, unit, input.depth) / pot;
}

/** 把某一家从局面里摘掉（比牌赢了之后的桌子）。所有与对手并行的数组一起摘。 */
function withoutOpponent(input: EvInput, index: number): EvInput {
  const drop = <T,>(xs: T[]) => xs.filter((_, i) => i !== index);
  return {
    ...input,
    opponents: drop(input.opponents),
    dists: drop(input.dists),
    foldProb: drop(input.foldProb),
    acceptProb: drop(input.acceptProb),
    foldAt: (unit: number) => drop(input.foldAt(unit)),
  };
}

/**
 * 对某个人比牌值多少（设计文档 §4.6 / §4.5 前瞻）。
 *
 * 比牌是**一对一**、只有发起人出钱的定向动作：赢了他出局，池子还在这儿，牌局继续。
 * 所以这一刀买的不是「当场把池子端走」，而是**赢了之后那张桌子**：
 * 人少了一个、池子还多了我这一刀，而且下一个信息点我**仍然可以退出**。
 *
 * 旧的写法把赢了之后的一切压成一次摊牌 —— `pi × restEq × (池 + 这一刀)`，
 * 也就是「赢了他还得当场赢过剩下所有人，否则一分不剩」。那等于假设我赢了他之后
 * 会闭着眼一路跟到底：既没有「剩下的人也可能弃」，也没有「下一轮发现不对我还能扔」。
 * 于是三人以上的桌子上比牌的账永远是负的（S6 附就是这么被压成 0 次的），
 * 而竞技场里真人真机都在比牌。
 *
 * 现在赢了之后那一支走 `continueValue`，和跟注/加注同一套账：池子记成
 * `pot + cost`（这一刀已经进锅），对手表摘掉输掉的那一家，外面再包一层
 * `max(0, …)` —— 那就是「还能弃」的实现价值。只剩一个人时不必前瞻，
 * 赢了当场结束，池子连同这一刀归我。
 */
export function evCompare(input: EvInput, index: number): number {
  const { state, bot, dists, strength, prior, weight } = input;
  const pot = Math.max(1, state.pot);
  const cost = compareCost(state, bot);
  const mine = strength ?? 0.5;
  const pi = clamp01(weight(pWin(mine, dists[index] ?? prior, dealModeOf(input))));
  // 这一刀是掏进锅里的，赢了他之后锅里就是这么多。
  const won = state.pot + cost;
  const rest = input.opponents.filter((_, i) => i !== index);
  /**
   * 赢了之后那张桌子**不该同时被扣一层前瞻深度**（2026-09-04 P2.1）。
   *
   * 比牌清掉一个人之后桌面是**变简单**了，不是变远了：还是同一轮、同一个价位，
   * 只是少了一个对手。旧版传的是 `depth − 1`，而常人卡 `cognition.lookahead = 1`，
   * `depth − 1 = 0` 直接把 `continueValue` 截在「这一轮就摊牌」那一支上，
   * 于是对一手必胜的牌 `pi = 1`、`after ≈ won`，`evCompare` **恒等于 1.0**
   * （实测 0.9999）——「赢了他之后还能从剩下的人手里榨多少」永远算不出来，
   * 系统 2 也就永远给不出「留人更值」这个量。
   */
  const after = rest.length
    ? Math.max(0, continueValue(withoutOpponent(input, index), won, state.betUnit, input.depth))
    : won;
  return (pi * after - cost) / pot;
}

/**
 * 「他接了」之后该按什么范围跟他摊牌。
 *
 * 闷着的人接梭哈不含任何信息（他自己都没看过牌），范围一点都不动；
 * 看过牌的人接了，就按他的跨局接注率收紧（`tightenForAccept`）。
 */
function acceptedRange(input: EvInput, i: number): RangeDist {
  const d = input.dists[i] ?? input.prior;
  if (!input.opponents[i]?.looked) return d;
  return tightenForAccept(d, clamp01(input.acceptProb[i] ?? 0.5), dealModeOf(input));
}

/**
 * 发起梭哈值多少（设计文档 §4.6 的发起端）。
 *
 * 对每一种「谁接了」的组合按各自的**跨局接注率**加权：没人接就赢下现在的池子，
 * 有人接就按**接了的那几家收紧之后**的范围摊牌。所以「一桌一吓就跑的人」和
 * 「一桌说什么都要接的人」在这里是两个完全不同的数 —— 面对前者，
 * 好牌梭哈是把钱吓跑，价值反而低；而且愿意接的那少数几次，接的都是硬牌。
 */
/**
 * 「一个人都不会接」的概率（§4.6 发起端）。
 *
 * 它是 `evAllIn` 里「没人接、底池归我」那一支的权重，同时也是**好牌梭哈的坏消息**：
 * 拿一手怪物把全桌吓跑，赢下的只有眼前这点底池，本来能榨的那几口全没了。
 */
export function noCallChance(input: EvInput): number {
  return input.opponents.reduce((p, _o, i) => p * (1 - clamp01(input.acceptProb[i] ?? 0.5)), 1);
}

export function evAllIn(input: EvInput): number {
  const { state, bot, opponents, acceptProb, strength, weight } = input;
  const pot = Math.max(1, state.pot);
  // 梭哈 = 全押，我押的就是全部身家；别人要接的闷牌单价由它换算回来。
  const myCost = allInCost(state, bot);
  const base = myCost / Math.max(1, bot.looked ? 2 : 1);
  const n = opponents.length;
  if (!n) return 0;
  const mine = strength ?? 0.5;

  let ev = -myCost;
  // 人少的时候枚举所有「谁接了」的子集；人多（>4）时退化成「按人数期望」的近似
  if (n <= 4) {
    for (let mask = 0; mask < (1 << n); mask++) {
      let p = 1;
      let extra = 0;
      const accepted: RangeDist[] = [];
      for (let i = 0; i < n; i++) {
        const takes = (mask >> i) & 1;
        p *= takes ? clamp01(acceptProb[i]) : 1 - clamp01(acceptProb[i]);
        if (takes) {
          extra += Math.min(opponents[i].chips, base * (opponents[i].looked ? 2 : 1));
          accepted.push(acceptedRange(input, i));
        }
      }
      if (p <= 1e-6) continue;
      // 没人接：底池连同我刚推进去的这一份都归我 —— 和 `continueValue` 的 `pot + c` 同口径。
      if (!accepted.length) { ev += p * (state.pot + myCost); continue; }
      const eq = clamp01(weight(pWinShowdown(mine, accepted, dealModeOf(input))));
      ev += p * eq * (state.pot + myCost + extra);
    }
  } else {
    const avgAccept = acceptProb.reduce((a, b) => a + b, 0) / n;
    const eq = clamp01(weight(pWinShowdown(mine, opponents.map((_, i) => acceptedRange(input, i)), dealModeOf(input))));
    const extra = opponents.reduce(
      (s, o, i) => s + acceptProb[i] * Math.min(o.chips, base * (o.looked ? 2 : 1)), 0,
    );
    const noneTakes = Math.pow(1 - avgAccept, n);
    ev += noneTakes * (state.pot + myCost) + (1 - noneTakes) * eq * (state.pot + myCost + extra);
  }
  return ev / pot;
}

/**
 * 接下别人的梭哈值多少（设计文档 §4.6 的接受端）。
 * 只跟**已经接了的人 + 发起人**比，每一家按各自的范围算 —— 不是按人数做指数。
 */
export function evAcceptAllIn(input: EvInput, showdownDists: RangeDist[], price: number): number {
  const { state, strength, prior, weight } = input;
  const pot = Math.max(1, state.pot);
  const mine = strength ?? 0.5;
  const field = showdownDists.length ? showdownDists : [prior];
  const eq = clamp01(weight(pWinShowdown(mine, field, dealModeOf(input))));
  return (eq * (state.pot + price) - price) / pot;
}

/**
 * 「看这一眼」值多少 —— 信息价值（设计文档 §4.5 把 look 当成一个普通候选动作）。
 *
 * 真人看牌不是因为「第 2 轮了」，是因为**看完之后我能做出更好的选择**：
 * 差牌可以立刻扔掉，好牌可以打大。所以这一眼的价值 =
 * 「看过之后按我可能拿到的各种牌力分别取最优动作」的期望，减去「闷着打」的最优值。
 * 代价是从此每一口都变两倍价 —— 这个代价已经含在前一项里（`looked` 的倍率）。
 *
 * 分位取 5 个点做数值积分，够用且便宜（决策耗时中位数要压在 5ms 以内）。
 */
export function lookValue(input: EvInput): number {
  const blind: EvInput = { ...input, strength: undefined };
  /**
   * 「闷着打」这一支同样要取**最优**动作，不能只算平跟。
   *
   * 闷加是一条真线路（§4.4 闷压 / S1）：闷着每一口只要半价，
   * 顶上去逼一个已经看过牌的人用双倍价跟，本来就是闷牌最值钱的地方。
   * 拿「看过之后的最优」去比「闷着平跟」，等于把这条线路从账本里划掉了 ——
   * 于是不管什么局面，这一眼都显得值，闷压就再也活不下来。
   */
  let blindBest = Math.max(0, evCall(blind));
  for (const unit of input.state.settings.betOptions) {
    if (unit <= input.state.betUnit) continue;
    if (input.bot.chips <= unit) continue;   // 闷着加注只掏半价
    const r = evRaise(blind, unit);
    if (r > blindBest) blindBest = r;
  }

  const quantiles = LOOK_QUANTILES;
  const lookedBot = { ...input.bot, looked: true } as PlayerState;
  let sum = 0;
  for (const q of quantiles) {
    const trial: EvInput = { ...input, bot: lookedBot, strength: q, depth: input.depth };
    // 看过之后我可以弃（0）、可以跟，也可以加 —— 取最好的那一个
    let best = 0;
    const call = evCall(trial);
    if (call > best) best = call;
    for (const unit of input.state.settings.betOptions) {
      if (unit <= input.state.betUnit) continue;
      if (lookedBot.chips <= unit * 2) continue;
      const r = evRaise(trial, unit);
      if (r > best) best = r;
    }
    sum += best;
  }
  return sum / quantiles.length - blindBest;
}

/**
 * 我这手牌的真实分位（看过牌才有）。
 *
 * 分位是**按这一桌的发牌档**算的：娱乐增强档里一手金花只排到 0.66–0.90，
 * 在标准档里同一手是 0.84–0.96。传错档等于机器人拿另一桌的牌力表打这一桌。
 */
export function ownStrength(bot: PlayerState, mode: DealMode = 'standard'): number | undefined {
  return bot.looked && bot.hand.length === 3 ? handPercentile(bot.hand, mode) : undefined;
}

/** 公共先验（扣掉所有我看得到的牌）。 */
export function commonPrior(state: RoomState): RangeDist {
  return priorDist(state.players.flatMap((p) => p.hand ?? []), state.settings.dealMode);
}

export { callCost, compareCost, allInCost };
