import { socialKey, socialValue } from './profile.ts';
/**
 * 把一个牌桌局面压成「决策核看得懂的东西」（设计文档 §4.10.2 的 `Situation`）。
 *
 * 这一层是适配器的一半：它只做**翻译**，不做判断。所有的候选动作由**引擎的合法性**
 * 生成（跟不起就没有 call、没解锁就没有 compare），不含任何「第几轮才准怎样」的
 * 决策门槛 —— 那些东西在新模型里全部变成了评分里的连续项。
 */

import {
  allInCost, callCost, canAllInNow, canCompareNow, compareCost, handPercentile,
  tableBuckets, tableRead,
  type Card, type GameCommand, type GameSettings, type PlayerState, type RoomState, type TableRead,
} from '../../game.ts';
import type { Channels, MindState } from '../../mind/emotion.ts';
import { situationalChannels, type Facts, type Regularity } from '../../mind/regularities.ts';
import { baseChannels } from '../../mind/dual.ts';
import type { Traits } from '../../mind/traits.ts';
import { kindsOf, unitTier, type HandEvent } from './events.ts';
import { archetypeOf, bucketKey, credibility, type MemoryBucket } from './profile.ts';
import type { EvInput } from './lookahead.ts';
import { commonPrior, ownStrength } from './lookahead.ts';
import type { Persona } from './personas/types.ts';
import { probWeight } from '../../mind/dual.ts';
import { pointDist, refine, type RangeDist } from './range.ts';
import { botRoll } from './random.ts';
import { choosePlan, type Plan } from './plan.ts';

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export interface BotOpponentView {
  id: string;
  seat: number;
  chips: number;
  looked: boolean;
  bet: number;
  wins: number;
  lastAction?: string;
  actions: string[];
  events: HandEvent[];
  read: TableRead;
  /** 按「闷/看 × 单价档 × 人多人少」分好的条件计数（§4.7.5），`foldProbOf` 要用 */
  buckets: Record<string, MemoryBucket>;
  /** 比过牌亲眼见过的那一手（S20）。没见过就是 undefined —— 不是空数组。 */
  knownHand?: Card[];
}

/** 一个候选动作。`key` 是系统 1 和系统 2 对齐用的稳定标识。 */
export interface Candidate {
  key: string;
  cmd: GameCommand;
  unit?: number;
  targetId?: string;
  /** 这一步要掏多少钱 */
  cost: number;
}

export interface ZjhSituation {
  state: RoomState;
  bot: PlayerState;
  persona: Persona;
  traits: Traits;
  /**
   * 决策**当时**那份心境（已经消化过本轮事件）。
   *
   * P2 只把它折成 `channels` 就丢掉了，于是「记忆里那几个具体的人」——
   * 被谁诈唬过、演戏被抓过几次 —— 在决策层就查不到了。
   * 通道是连续量，回答不了「是不是这个人」，所以原件也要带着走。
   */
  mind: MindState;
  opponents: BotOpponentView[];
  dists: RangeDist[];
  candidates: Candidate[];
  /** 看过牌才有的真实分位 */
  strength?: number;
  pot: number;
  cost: number;
  costFraction: number;
  effectiveStack: number;
  stackToPot: number;
  position: number;
  pressure: number;
  steal: number;
  threats: number[];
  activeCount: number;
  tier: number;
  ev: EvInput;
  channels: Channels;
  fired: Regularity[];
  facts: Facts;
  /** 这一局的打法承诺（§4.4）。同一手牌里的同一个信息点上它是同一条。 */
  plan: Plan;
  /** 接梭哈时的价（`state.allIn` 存在才有意义） */
  acceptPrice: number;
  /** 接梭哈时要面对的范围（发起人 + 已接的人） */
  showdownDists: RangeDist[];
  rng: (purpose: string) => number;
}

/**
 * 只提取公开字段。**唯一的例外**是 `knownHand`：比过牌亲眼见过的那一手 ——
 * 信息边界（`bot/index.ts`）已经把没资格看的牌清成空数组了，
 * 所以这里能读到的一定是他有权知道的（设计文档 S20）。
 */
export function botOpponentViews(state: RoomState, bot: PlayerState): BotOpponentView[] {
  const seen = new Set(state.seen?.[bot.id] ?? []);
  return state.players
    .filter((p) => p.id !== bot.id && p.status === 'active')
    .map((p) => ({
      id: p.id, seat: p.seat, chips: p.chips, looked: p.looked, bet: p.bet, wins: p.wins,
      lastAction: p.lastAction,
      actions: kindsOf(p),
      events: [...(p.handActions ?? [])],
      read: tableRead(state, p.id),
      buckets: tableBuckets(state, p.id),
      knownHand: seen.has(p.id) && p.hand?.length === 3 ? [...p.hand] : undefined,
    }));
}

/** 这一局他讲了个什么故事（不看最后一个动作，看整串动作的节奏变化）。 */
export function storyHeat(actions: string[]): number {
  if (!actions.length) return 0.08;
  const count = (kind: string) => actions.filter((a) => a === kind).length;
  const raises = count('raise');
  const calls = count('call');
  const last = actions[actions.length - 1];
  if (count('all_in')) return 0.95;
  if (raises >= 2) return 0.88;
  if (raises === 1) {
    const braked = actions.indexOf('raise') < actions.lastIndexOf('call');
    return braked ? 0.44 : 0.70;
  }
  if (count('compare')) return 0.66;
  if (calls >= 3) return 0.40;
  if (calls === 2) return 0.32;
  if (calls === 1) return 0.24;
  return last === 'look' ? 0.15 : 0.10;
}

export function opponentThreat(view: BotOpponentView): number {
  return clamp01(storyHeat(view.actions) * credibility(view.read));
}

/** 一口价钱摆在谁面前：他要付多少、池子多大、桌上人多不多（§4.7.5 的条件维度）。 */
export interface PriceContext {
  /** 他要面对的**单价**（我打算把价钱抬到这一档；不加档就是当前单价） */
  unit: number;
  /** 他要面对这一口时池子有多大 */
  pot: number;
  /** 桌上还有三个人以上吗 */
  multiway: boolean;
  settings: GameSettings;
}

/** 这一档价钱摆在当前局面里长什么样。 */
export function priceAt(state: RoomState, unit: number, extra = 0): PriceContext {
  return {
    unit,
    pot: Math.max(1, state.pot + extra),
    multiway: state.players.filter((p) => p.status === 'active').length >= 3,
    settings: state.settings,
  };
}

/**
 * 他面对**这一口价钱**会跑的概率（设计文档 S11 的 fold-equity）。
 *
 * 三层，从最泛到最具体，一层层往里收缩（Beta 收缩，先验各当 4 手）：
 *
 * 1. **价格先验**（`pricePrior`）：这一口对他有多疼。
 * 2. **跨局印象**：他平时抗不抗压（`pressureFaced / foldsToPressure`）。
 * 3. **条件统计**：他在**同一个格子**里（闷/看 × 这一档单价 × 人多人少）
 *    面对过几次压力、跑了几次 —— 事件流真数出来的那一份。
 *
 * 最后叠**本局他讲的故事**：连加两次的人底子再紧也不会说走就走（S7）。
 * 结果封顶 0.9：加到再高也永远走不干净，否则模型会得出「加满 = 一定没人跟」。
 */
export function foldProbOf(view: BotOpponentView, price: PriceContext): number {
  const prior = pricePrior(view, price);

  const r = view.read;
  const person = (r.foldsToPressure + prior * PRIOR_HANDS) / (r.pressureFaced + PRIOR_HANDS);

  const b = view.buckets[bucketKey(view.looked, unitTier(price.unit, price.settings), price.multiway)];
  const faced = b?.pressureFaced ?? 0;
  const folds = Math.min(faced, b?.foldsToPressure ?? 0);
  const rate = (folds + person * PRIOR_HANDS) / (faced + PRIOR_HANDS);

  return clamp01(Math.min(0.90, rate) * (1 - commitHeat(view.actions) * 0.85));
}

/**
 * 他的故事里**掏过额外的钱**的那一部分 —— 「他不会说走就走」的成分。
 *
 * `storyHeat` 量的是「他这局有多投入」，平跟三口也有 0.40；但拿它来打折弃牌率是反的：
 * 一路平跟的人恰恰是最容易被一记加价赶走的那种（S11 要偷的就是他）。
 * 真正说明「加了他也不走」的只有加注、梭哈、比牌 —— 掏过池子要求之外的钱。
 * 所以把平跟那一段（0.40 以下）整段减掉，只留上面那一截。
 */
function commitHeat(actions: string[]): number {
  return clamp01((storyHeat(actions) - 0.40) / 0.60);
}

/**
 * 价格先验：一个**还不认识的人**面对这一口会跑的概率，三股力叠出来。
 *
 * 1. **池底赔率** `cost / (pot + cost)` —— 一个不偏不倚的人被这一口打走的频率
 *    正是这个数（防守频率的补数）。它自己就说明了「加得越凶跑得越多」，
 *    也说明了为什么往一个已经很大的池子里加价吓不走人。
 * 2. **身家压迫** —— 同样的赔率，掏的是三成身家还是半成，人不一样。
 * 3. **升档冲击** —— 这一口比他**这一局到此为止一共投进去的**贵多少倍。
 *    闷着的人一路半价平跟，升一档就是十几二十倍的跳，`log2` 之后落在 4×–32× 这一段，
 *    这正是 S11 要的「升档后弃牌率显著上升」；而在一个已经打到十万档的池子里
 *    再加一档只是两三倍，冲击自然就小。参照物取「他投进去的钱」而不是轮次或档位，
 *    是因为那是事件流里真有的数，不是又一条按单价划的门槛。
 *
 * 闷/看不需要特判：闷着只付半价，`cost` 已经把它算进去了。
 */
function pricePrior(view: BotOpponentView, price: PriceContext): number {
  const cost = price.unit * (view.looked ? 2 : 1);
  const odds = cost / Math.max(1, price.pot + cost);
  const strain = ramp(cost / Math.max(1, view.chips), 0.30, 0.14);
  const invested = Math.max(price.settings.ante, view.bet);
  const shock = ramp(Math.log2(cost / invested), 2.2, 1.1);
  return clamp01(0.05 + PRICE_ODDS * odds + PRICE_STRAIN * strain + PRICE_SHOCK * shock);
}

/** 池底赔率、身家压迫、升档冲击在价格先验里各占多少（三条加起来 = 先验的量程）。 */
const PRICE_ODDS = 0.50;
const PRICE_STRAIN = 0.20;
const PRICE_SHOCK = 0.35;

/** 收缩用的先验份量：见过一次不算数，见过十次就基本按他自己的数来。 */
const PRIOR_HANDS = 4;

/** 平滑地越过某个位置（logistic）—— 这一层里所有的「贵不贵」都用它，没有门槛。 */
function ramp(x: number, center: number, width: number): number {
  return 1 / (1 + Math.exp(-(x - center) / width));
}

/**
 * 我把价钱抬到 `unit` 的话，全场一起跑掉的概率（S11 的偷池成功率）。
 *
 * 人越多乘得越小（偷池随人数下降），单价越高每个人的弃牌率越高（升档后显著上升）——
 * 这两条设计文档里的话在这条式子里是同一个乘积的两个方向。
 */
export function stealEquity(views: BotOpponentView[], price: PriceContext): number {
  if (!views.length) return 1;
  return views.reduce((acc, v) => acc * foldProbOf(v, price), 1);
}

/**
 * 他会接梭哈的概率（设计文档 §4.6 的发起端）。
 *
 * 第一来源是**跨局真的数出来的**：他面对过几次梭哈、接了几次。这和「他面对加注跑不跑」
 * 不是一回事 —— 一口 5 万就跑的人，面对推光身家反而可能上头就接。
 * 样本不够的时候按 `foldProbOf` 推一个先验，用 Beta 收缩（先验当 4 手）平滑过渡：
 * 见过一次不算数，见过十次就基本按他自己的数来。
 *
 * 本局他已经讲的故事再叠一层：连加两次挑起来的人更可能接自己的这一口。
 */
export function acceptProbOf(view: BotOpponentView, price: PriceContext): number {
  const r = view.read;
  const faced = Math.max(0, r.allInFaced ?? 0);
  const taken = Math.max(0, Math.min(faced, r.allInTaken ?? 0));
  const prior = clamp01(0.12 + (1 - foldProbOf(view, price)) * 0.62);
  const n0 = 4;
  const rate = (taken + prior * n0) / (faced + n0);
  return clamp01(rate + storyHeat(view.actions) * 0.25 * (1 - rate));
}

export function tablePressure(state: RoomState, opponents: BotOpponentView[]): number {
  if (!opponents.length) return 0;
  const actionPressure = opponents.reduce((s, p) => s + opponentThreat(p), 0) / opponents.length;
  const commitment = opponents.reduce(
    (s, p) => s + Math.min(1, p.bet / Math.max(state.settings.ante, state.pot)), 0,
  ) / opponents.length;
  const looked = opponents.filter((p) => p.looked).length / opponents.length;
  const escalation = clamp01(
    Math.log2(Math.max(1, state.betUnit) / Math.max(1, state.settings.betOptions[0])) / 4,
  );
  return clamp01(actionPressure * 0.46 + commitment * 0.22 + looked * 0.12 + escalation * 0.20);
}

/** 按 `firstActorSeat` 顺时针数，我在还在局的人里排第几（0 = 首家，1 = 最后一家）。 */
export function seatPosition(state: RoomState, bot: PlayerState, activeCount: number): number {
  if (activeCount <= 2) return 1;
  const M = Math.max(1, state.settings.maxPlayers);
  const order = state.players
    .filter((p) => p.status === 'active')
    .map((p) => ({ id: p.id, d: (p.seat - state.firstActorSeat + M) % M }))
    .sort((a, b) => a.d - b.d);
  const idx = order.findIndex((p) => p.id === bot.id);
  if (idx < 0) return 1;
  return clamp01(idx / Math.max(1, order.length - 1));
}

/**
 * 候选动作 = **引擎允许的全部动作**，一条不多一条不少。
 *
 * 这是「拆掉所有硬门槛」最要紧的一步：以前是一串 `if (轮次 >= 2) return look`，
 * 现在 look / fold / call / 每一档 raise / 对每个人 compare / all_in 一起进候选池，
 * 由人物卡 × 局面 × 情绪打分决出。留在这里的判断全是**规则**（跟不起、没解锁、
 * 梭哈期间只能接或弃），不是决策。
 */
export function candidatesOf(state: RoomState, bot: PlayerState, opponents: BotOpponentView[]): Candidate[] {
  const out: Candidate[] = [];
  const mult = bot.looked ? 2 : 1;

  if (state.allIn) {
    // 引擎规则：梭哈期间 doRaise / doAllIn / doCompare 一律抛错，只剩接、弃、看
    if (!bot.looked) out.push({ key: 'look', cmd: { type: 'look' }, cost: 0 });
    if (bot.chips > 0) {
      out.push({
        key: 'call', cmd: { type: 'call' },
        cost: Math.min(state.allIn.base * mult, bot.chips),
      });
    }
    out.push({ key: 'fold', cmd: { type: 'fold' }, cost: 0 });
    return out;
  }

  if (!bot.looked) out.push({ key: 'look', cmd: { type: 'look' }, cost: 0 });
  out.push({ key: 'fold', cmd: { type: 'fold' }, cost: 0 });

  const cost = callCost(state, bot);
  /*
   * 钱不够照样能跟 —— 引擎那边（`shared/game.ts` 的 `pay`）会把这一口夹到全部筹码
   * 打出去（「全押跟」）。以前这里写的是 `bot.chips > cost`，于是台面单价一涨过
   * 电脑的身家，候选里就只剩弃牌和梭哈，电脑变成「跟不起就掀桌或者认输」。
   * 这条是**引擎规则的镜像**，不是打法判断：可行性放开，要不要跟仍然由后面的
   * 评分决定。cost 夹到身家，`stakeOf` 算出来就是 1.0 —— 这一口确实是全部身家。
   */
  if (bot.chips > 0) out.push({ key: 'call', cmd: { type: 'call' }, cost: Math.min(cost, bot.chips) });

  for (const unit of state.settings.betOptions) {
    if (unit <= state.betUnit) continue;
    if (bot.chips <= unit * mult) continue;
    out.push({ key: `raise:${unit}`, cmd: { type: 'raise', unit }, unit, cost: unit * mult });
  }

  // 比牌同理：比牌费掏不全也能发起，掏光为止（引擎侧同一条规则）
  if (canCompareNow(state) && bot.chips > 0) {
    const price = Math.min(compareCost(state, bot), bot.chips);
    for (const o of opponents) {
      out.push({
        key: `compare:${o.id}`, cmd: { type: 'compare', targetId: o.id },
        targetId: o.id, cost: price,
      });
    }
  }

  /*
   * 梭哈 = 全押，成本就是自己的全部筹码。
   *
   * 这里去掉了原来那条 `forced`（跟不起时无视轮次也能梭哈）：引擎已经改成
   * **梭哈永远不比跟注便宜**，`chips <= callCost` 的人调 doAllIn 直接抛错。
   * 候选池是引擎规则的镜像，所以这条门槛必须逐字跟上，否则电脑会不停地
   * 挑一个必然被拒的动作。短码的出路在上面：全押跟、全押比牌、弃牌，一条不少。
   */
  if (bot.chips > cost && opponents.length >= 1 && canAllInNow(state)) {
    out.push({ key: 'all_in', cmd: { type: 'all_in' }, cost: allInCost(state, bot) });
  }
  return out;
}

/** 组装。这一步是每次决策最贵的地方（范围模型），所以只做一次。 */
export function buildSituation(
  state: RoomState, bot: PlayerState, persona: Persona, mind: MindState,
): ZjhSituation {
  const traits = persona.traits;
  const mode = state.settings.dealMode;
  const opponents = botOpponentViews(state, bot);
  const prior = commonPrior(state);
  const dists = opponents.map((o) => {
    // 见过的牌不用猜：分布塌成一个点，从此对他的胜负是**已知**的。
    // 分位与桶都按这一桌的发牌档算，否则「见过的那手牌」会塌到另一档的位置上。
    if (o.knownHand) return pointDist(handPercentile(o.knownHand, mode), mode);
    if (persona.cognition.rangeFidelity === 0) return prior;
    return refine(prior, o.events, archetypeOf(o.read, persona.cognition.classifyOthers, traits.regularities.R17 ?? 1), state.settings, mode,
      persona.cognition.readsTiming);
  });
  const candidates = candidatesOf(state, bot, opponents);
  const cost = callCost(state, bot);
  const pot = Math.max(1, state.pot);
  // 「这一口占身家的比例」（2026-09-04 P2.1 修）。
  // `callCost` 给的是**名义**价钱：桌面单价乘上还欠的份数，它不管你兜里够不够。
  // 筹码被打短了的时候（引擎那边这一口会自动缩成 allIn），名义价钱可以是身家的几倍，
  // 留痕里量到过最大 400000 —— 这个数会原样流进 `look` 的 `costWeight` 那一项
  // 和 `atRisk`，把「贵不贵」这件事顶到饱和之外。
  // 语义上这就是个 0..1 的比例：把整副身家推进去已经是最贵，再贵没有意义，所以在源头收口。
  const costFraction = clamp01(cost / Math.max(1, bot.chips));
  const effectiveStack = Math.max(1, Math.min(bot.chips, ...opponents.map((p) => p.chips)));
  const activeCount = opponents.length + 1;
  const position = seatPosition(state, bot, activeCount);
  const pressure = tablePressure(state, opponents);
  const threats = opponents.map(opponentThreat);
  // 弃牌率是价格的函数（S11）：现价一份，每一个可加的档位各一份，按需算、算过就存。
  const here = priceAt(state, state.betUnit);
  const foldProb = opponents.map((v) => foldProbOf(v, here));
  const foldCache = new Map<number, number[]>([[state.betUnit, foldProb]]);
  const foldAt = (unit: number): number[] => {
    let hit = foldCache.get(unit);
    if (!hit) {
      // 我要加到这一档，池子里就先多了我这一口 —— 他面对的是那个更大的池子
      hit = opponents.map((v) => foldProbOf(v, priceAt(state, unit, unit * (bot.looked ? 2 : 1))));
      foldCache.set(unit, hit);
    }
    return hit;
  };
  // 「偷池成功率」问的是**我加一档他们跑不跑**，不是「他们在现价上跑不跑」——
  // 现价上没人需要重新表态，那个数恒等于零压力（§S11）。
  const upNext = state.settings.betOptions.find((u) => u > state.betUnit) ?? state.betUnit * 2;
  const steal = stealEquity(opponents, priceAt(state, upNext, upNext * (bot.looked ? 2 : 1)));
  const strength = ownStrength(bot, mode);

  // 现在压着我的那个人：本局最后一个加注/梭哈的人（R14 面子、报复的落点）
  let counterpartKey: string | undefined;
  let heat = 0;
  for (const [i, o] of opponents.entries()) {
    const h = threats[i];
    if (h > heat) { heat = h; counterpartKey = o.id; }
  }

  /*
   * 我最记恨、而且**人就在场**的那个对手（`personas.md`「待集成」#13）。
   *
   * 原来恨意是挂在 `counterpartKey`（现在压着我的那个人）上算的，而压我的人
   * 和我恨的人经常不是同一个 —— 「对仇人放宽 0.1 分位」因此被稀释到 0.009。
   * 现在单独挑：只看还在场的对手里恨值最高的那个，不在场的仇人不影响这一手。
   */
  let grudgeKey: string | undefined;
  let hatred = 0.02;
  for (const o of opponents) {
    const g = socialValue(mind.revenge, state.players, o.id);
    if (g > hatred) { hatred = g; grudgeKey = socialKey(state.players, o.id); }
  }

  const avgOpp = opponents.length
    ? opponents.reduce((s, o) => s + o.chips, 0) / opponents.length
    : bot.chips;
  // R12 「他整局都在演」：连加的次数 + 闷着加的次数。两项都是这一局的公开动作。
  const counterpart = opponents.find((o) => o.id === counterpartKey);
  const heavy = (counterpart?.events ?? []).filter((e) => e.kind === 'raise' || e.kind === 'all_in');
  const counterpartDisplay = clamp01(
    clamp01(heavy.length / 3) * 0.6 + clamp01(heavy.filter((e) => !e.looked).length / 2) * 0.4,
  );
  /**
   * R19 场面热度。设计文档 §4.10 的触发条件写的是「桌上**梭哈/大池**频率高」，
   * 所以这里只数**别人做出来的动作**：有几个人已经梭进去了、池子涨到一个人本金的
   * 多少。**不能**把单价升到第几档算进来 —— `escalateFrom: 3` 让单价从第 3 轮起
   * 自动升档，没有任何人加注也会升；把它当热度，等于每一局第 3 轮之后全桌白得一份
   * 「松」，岩石的加注就是这样被稀释掉的（实测单挑遇压弃 49.8% → 42.8%）。
   * 这和 §6.2 里「加注 ≠ 单价升档」是同一个错误，只是换了个地方。
   */
  const shoves = opponents.filter((o) => o.events.some((e) => e.kind === 'all_in')).length;
  const ambientHeat = clamp01(
    clamp01(shoves / Math.max(1, opponents.length)) * 0.6
    + clamp01(state.pot / Math.max(1, state.settings.startingChips * 0.4)) * 0.4,
  );
  // R19 的后半句：有没有人在一路碾过来 —— 用筹码的领先幅度当观测量。
  const allChips = [bot.chips, ...opponents.map((o) => o.chips)];
  const topChips = Math.max(...allChips);
  const meanChips = allChips.reduce((a, c) => a + c, 0) / allChips.length;
  const ambientRunaway = clamp01((topChips - meanChips) / Math.max(1, topChips));

  const facts: Facts = {
    committed: clamp01(bot.bet / Math.max(1, bot.bet + bot.chips)),
    atRisk: costFraction,
    balance: bot.chips,
    rank: (bot.chips - avgOpp) / Math.max(1, bot.chips + avgOpp),
    unknownHeldFor: bot.looked ? 0 : clamp01((state.roundNo - 1) / 4),
    scaleVsLast: mind.lastScale > 0 ? state.pot / mind.lastScale : 1,
    counterpartKey: counterpartKey ? socialKey(state.players, counterpartKey) : undefined,
    grudgeKey,
    counterpartDisplay,
    // 「把握」用的就是自己这手牌的分位；闷着的人没有把握，落在 0.5 ——
    // 那正是 R12 最痒的地方（不上不下才想花钱看）。
    ownCertainty: strength ?? 0.5,
    ambientHeat,
    ambientRunaway,
  };
  const { channels, fired } = situationalChannels(baseChannels(mind, traits), mind, traits, facts);

  const alpha = traits.cognition.probWeightAlpha;
  const ev: EvInput = {
    state, bot,
    opponents: opponents.map((o) => ({ id: o.id, chips: o.chips, bet: o.bet, looked: o.looked })),
    dists, foldProb, foldAt,
    acceptProb: opponents.map((v) => acceptProbOf(v, here)),
    prior, strength,
    depth: persona.cognition.lookahead,
    weight: (p) => probWeight(p, alpha),
  };

  let acceptPrice = 0;
  let showdownDists: RangeDist[] = [];
  if (state.allIn) {
    acceptPrice = Math.min(state.allIn.base * (bot.looked ? 2 : 1), bot.chips);
    const accepted = new Set(state.allIn.accepted.filter((id) => id !== bot.id));
    accepted.add(state.allIn.initiatorId);
    showdownDists = opponents
      .map((o, i) => (accepted.has(o.id) ? dists[i] : null))
      .filter((d): d is RangeDist => d !== null);
  }

  const scene: Omit<ZjhSituation, 'plan'> = {
    state, bot, persona, traits, mind, opponents, dists, candidates, strength,
    pot, cost, costFraction, effectiveStack,
    stackToPot: effectiveStack / pot,
    position, pressure, steal, threats, activeCount,
    tier: unitTier(state.betUnit, state.settings),
    ev, channels, fired, facts,
    acceptPrice, showdownDists,
    rng: (purpose: string) => botRoll(state, bot, purpose),
  };
  // 线路要读整个局面，所以最后才选；选完这一局就认它（§4.4）。
  return { ...scene, plan: choosePlan(scene) };
}

export { clamp01 };
