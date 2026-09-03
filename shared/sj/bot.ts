/**
 * 升级的机器人 —— 同时也是**超时代打**和**「提示」按钮**的来源（DESIGN 1.10）。
 *
 * 这个文件本身已经不再包含策略：策略全在 `shared/sj/brain/*`（设计见
 * `docs/shengji/BRAIN-DESIGN.md`）。这里只做三件事：
 *
 * 1. 把引擎状态 / 客户端公开视图翻译成 `BrainView`（记牌器）；
 * 2. 保持既有导出不变，让 `games.ts`、客户端和测试不用改；
 * 3. **兜底**：策略再怎么改，交出去的一定得是合法的一手 —— 超时代打不能把牌局卡死。
 *
 * 关于"不许偷看"：翻译层只读公开字段，`state.bottom` 只在 `me.seat === state.kouSeat`
 * 时传进去（那 8 张是他自己扣的）。除此之外没有任何一条路径能看到别人的手牌。
 *
 * 这个文件**不 import engine.ts 的任何值**（只 import 类型，编译后会被擦掉），
 * 所以 engine → bot 的调用不会形成运行时循环依赖。同理不 import `games.ts`。
 */

import {
  cardFromId, groupOf, sumPoints,
  type SjCard, type SjCtx, type SjGroup, type SjRng, type SjTrumpSuit,
} from './cards.ts';
import { cardsInGroup, maxOrder, parseShape, runsOf, type SjShape, type SjUnit } from './units.ts';
import { validateFollow, type SjDeclState } from './rules.ts';
import type { SjPlayer, SjPublicPlayer, SjPublicRoom, SjRoomState } from './engine.ts';

import { buildView, unseenCards as brainUnseen, type BrainInput, type BrainView } from './brain/view.ts';
import { composeFollow, composeTrumpBeat } from './brain/candidates.ts';
import { rankLeadPlays } from './brain/lead.ts';
import { rankFollowPlays } from './brain/follow.ts';
import { chooseBottom, closerConfidence, findCloser } from './brain/kou.ts';
import {
  decideChao, decideDeclare, planDealingDeclare, strengthFor,
} from './brain/declare.ts';
import type { SjScored } from './brain/evaluate.ts';

export { composeFollow, composeTrumpBeat };
export type { BrainView };

/**
 * **大脑读得到的房间**：`SjRoomState`（服务端）和 `SjPublicRoom`（客户端）都满足。
 *
 * 这里逐条列出的就是记牌器全部的输入 —— 没有 `player.hand` 这一项，
 * 所以「客户端能不能算」和「大脑该不该看」是同一个答案：公开视图里有的，它才读得到。
 * `bottom` 是唯一的例外，而 `brainFromState` 只在 `me.seat === kouSeat` 时才把它传下去，
 * 公开视图里那 8 张也恰好只有扣底者本人看得见（`sanitizeSjRoom`）。
 */
export interface SjBrainState {
  kind: string;
  trump: { suit: SjTrumpSuit | null; level: number };
  trick: { seat: number; cardIds: string[] }[];
  playedIds: string[];
  trickNo: number;
  voidGroups: readonly (readonly SjGroup[])[];
  noPairs: readonly (readonly SjGroup[])[];
  dealerSeat: number;
  kouSeat: number;
  defenderPoints: number;
  handTrickPoints: readonly [number, number];
  lastTrick: { leaderSeat: number; plays: { seat: number; cardIds: string[] }[] } | null;
  levels: readonly [number, number];
  /** 只读 `seat` 和 `declaredIds`（亮出来的明牌）—— 别人的 `hand` 一次都不碰 */
  players: readonly { seat: number; declaredIds: readonly string[] }[];
  bottom: readonly SjCard[];
}

/** 大脑眼里的"我"：`SjPlayer` 和 `SjPublicPlayer` 都满足 */
export interface SjBrainMe {
  seat: number;
  hand: SjCard[];
  declaredIds?: readonly string[];
}

/**
 * 编译期护栏：**公开视图必须永远喂得饱大脑**。
 * 哪天 `sanitizeSjRoom` 藏起了某个字段，这里先红，而不是等「帮我扣」悄悄退化成纯手牌打分。
 */
type Assert<T extends true> = T;
type _PublicRoomFeedsBrain = Assert<SjPublicRoom extends SjBrainState ? true : false>;
type _PublicPlayerFeedsBrain = Assert<SjPublicPlayer extends SjBrainMe ? true : false>;
type _RoomStateFeedsBrain = Assert<SjRoomState extends SjBrainState ? true : false>;
type _PlayerFeedsBrain = Assert<SjPlayer extends SjBrainMe ? true : false>;

/** 提示按钮和 CLI 只需要这些公开字段，`SjPublicRoom` 天然满足 */
export interface SjSuggestView {
  trump: { suit: SjTrumpSuit | null; level: number };
  trick: { seat: number; cardIds: string[] }[];
  playedIds: string[];
  /** 我的座位。判断现在领先的是不是**对家**（座位号同奇偶为一队）要用它 */
  mySeat: number;
  /** 第几圈。判断是否已进入后半程（该抢就抢）要用它 */
  trickNo: number;
  /** 各座位已经在桌面上公开暴露的缺门；不是服务端暗牌信息 */
  voidGroups?: readonly (readonly SjGroup[])[];

  /* --- 以下都是可选的公开字段：给了，机器人的账才算得准（BRAIN-DESIGN §2） --- */
  /** 各座位公开暴露的「这门没有对子了」 */
  noPairs?: readonly (readonly SjGroup[])[];
  dealerSeat?: number | null;
  kouSeat?: number | null;
  /** 闲家已入账的分（含罚分） */
  defenderPoints?: number;
  /** 两队从圈里赢到的原始分，按 `seat % 2` 索引 */
  handTrickPoints?: readonly [number, number];
  /** 上一圈的完整记录（判"对家想要哪门"） */
  lastTrick?: { leaderSeat: number; plays: { seat: number; cardIds: string[] }[] } | null;
  /** 两队级别与阶梯顶（通关局判定） */
  levels?: readonly [number, number];
  topLevel?: number;
  /** 各座位亮出的明牌 id（亮主/反主/抄底历史） */
  declaredIds?: readonly (readonly string[])[];
  /** **只有扣底者本人**能传：他自己扣下去的 8 张 */
  bottom?: readonly string[];
}

const ctxOf = (v: { trump: { suit: SjTrumpSuit | null; level: number } }): SjCtx => ({
  trump: v.trump.suit,
  level: v.trump.level,
});

/** `sj_510k` 打到 K 封顶、`sj_2a` 打到 A 封顶 —— 内联推导，避免 games → bot → games 的运行时循环 */
const topLevelOf = (kind: string): number => (kind === 'sj_2a' ? 14 : 13);

function declaredSuitsFrom(
  declaredIds: readonly (readonly string[])[] | undefined, ctx: SjCtx,
): (SjGroup | null)[] {
  return Array.from({ length: 4 }, (_, seat) => {
    const ids = declaredIds?.[seat];
    if (!ids?.length) return null;
    // 亮的是哪一门要按**当前主**换算：亮 ♠ 而主就是 ♠ 时，那门在记牌器里叫 'T'
    return groupOf(cardFromId(ids[0]), ctx);
  });
}

/* --------------------------------------------------- 公开视图 → 记牌器 */

export function brainFromSuggestView(view: SjSuggestView, hand: SjCard[]): BrainView {
  const ctx = ctxOf(view);
  const input: BrainInput = {
    trump: view.trump,
    playedIds: view.playedIds,
    trick: view.trick.map((p) => ({ seat: p.seat, cards: p.cardIds.map(cardFromId) })),
    mySeat: view.mySeat,
    trickNo: view.trickNo,
    voidGroups: view.voidGroups,
    noPairs: view.noPairs,
    declaredSuits: declaredSuitsFrom(view.declaredIds, ctx),
    dealerSeat: view.dealerSeat ?? null,
    kouSeat: view.kouSeat ?? null,
    defenderPoints: view.defenderPoints ?? 0,
    handTrickPoints: view.handTrickPoints,
    lastTrick: view.lastTrick
      ? {
        leaderSeat: view.lastTrick.leaderSeat,
        plays: view.lastTrick.plays.map((p) => ({ seat: p.seat, cards: p.cardIds.map(cardFromId) })),
      }
      : null,
    levels: view.levels,
    topLevel: view.topLevel,
    bottom: view.kouSeat != null && view.kouSeat === view.mySeat && view.bottom
      ? view.bottom.map(cardFromId)
      : undefined,
  };
  return buildView(input, hand);
}

/**
 * 引擎状态 / 客户端公开视图 → 记牌器。**底牌只在我就是扣底者时才传进去**。
 *
 * 服务端传 `SjRoomState`、客户端传 `SjPublicRoom`，两边算出来的 `BrainView` 逐字节相同 ——
 * 因为下面读到的每一个字段在公开视图里都原样存在（`tests/sj-bot.test.ts` 有一致性测试）。
 */
export function brainFromState(state: SjBrainState, me: SjBrainMe): BrainView {
  return brainFromSuggestView({
    trump: state.trump,
    trick: state.trick.map((p) => ({ seat: p.seat, cardIds: p.cardIds })),
    playedIds: state.playedIds,
    mySeat: me.seat,
    trickNo: state.trickNo,
    voidGroups: state.voidGroups,
    noPairs: state.noPairs,
    dealerSeat: state.dealerSeat,
    kouSeat: state.kouSeat,
    defenderPoints: state.defenderPoints,
    handTrickPoints: state.handTrickPoints,
    lastTrick: state.lastTrick
      ? { leaderSeat: state.lastTrick.leaderSeat, plays: state.lastTrick.plays }
      : null,
    levels: state.levels,
    topLevel: topLevelOf(state.kind),
    declaredIds: state.players
      .slice()
      .sort((a, b) => a.seat - b.seat)
      .map((p) => p.declaredIds),
    bottom: me.seat === state.kouSeat ? state.bottom.map((c) => c.id) : undefined,
  }, me.hand);
}

/* --------------------------------------------------------------- 亮主 */

const declStateOf = (state: SjRoomState): SjDeclState => ({
  suit: state.trump.suit,
  strength: state.trump.strength,
  declarerId: state.trump.declarerId,
});

const declarerSeatOf = (state: SjRoomState): number | null =>
  state.players.find((p) => p.id === state.trump.declarerId)?.seat ?? null;

/**
 * 亮主（BRAIN-DESIGN §5.1）。**在发牌途中也会被调用** —— 那时 `me.hand` 是整手，
 * 但决策只准看已到手的前缀，所以发牌阶段一律走 `planSjDealingDeclare`。
 */
export function botDeclare(state: SjRoomState, me: SjPlayer): string[] | null {
  if (state.phase !== 'dealing' && state.phase !== 'declaring') return null;
  if (state.phase === 'dealing') {
    const plan = planSjDealingDeclare(state, me);
    return plan ? plan.cardIds : null;
  }
  const d = decideDeclare({
    hand: me.hand,
    level: state.trump.level,
    trump: declStateOf(state),
    myId: me.id,
    mySeat: me.seat,
    dealerSeat: state.dealerSeat,
    handNo: state.handNo,
    declarerSeat: declarerSeatOf(state),
    dealt: me.hand.length,
    total: me.hand.length,
    phase: 'declaring',
  });
  return d.action === 'declare' && d.option ? d.option.cards.map((c) => c.id) : null;
}

/**
 * 发牌途中的亮主计划：**第几张牌到手时亮、亮什么**。
 *
 * 只读 `state.dealOrder[me.seat]` 的前缀，所以把还没发到的牌重洗，
 * 结果一定一样（防偷看测试就是这么验的）。
 */
export function planSjDealingDeclare(
  state: SjRoomState, me: SjPlayer,
): { cardIds: string[]; index: number; why: string[] } | null {
  const order = (state.dealOrder?.[me.seat] ?? []).map(cardFromId);
  if (!order.length) return null;
  const plan = planDealingDeclare(order, {
    level: state.trump.level,
    trump: declStateOf(state),
    myId: me.id,
    mySeat: me.seat,
    dealerSeat: state.dealerSeat,
    handNo: state.handNo,
    declarerSeat: declarerSeatOf(state),
    total: order.length,
  });
  return plan ? { cardIds: plan.option.cards.map((c) => c.id), index: plan.index, why: plan.why } : null;
}

/** 抄底（BRAIN-DESIGN §5.2）。返回要亮的牌 id；不抄返回 null */
export function botChao(state: SjRoomState, me: SjPlayer): string[] | null {
  if (state.phase !== 'chao') return null;
  const v = brainFromState(state, me);
  const d = decideChao({
    hand: me.hand,
    level: state.trump.level,
    trump: declStateOf(state),
    myId: me.id,
    mySeat: me.seat,
    dealerSeat: state.dealerSeat,
    declarerSeat: declarerSeatOf(state),
    closerConfidence: closerConfidence(v, findCloser(v)),
  });
  return d ? d.option.cards.map((c) => c.id) : null;
}

/* --------------------------------------------------------------- 扣底 */

/**
 * 扣底（BRAIN-DESIGN §5.3）：33 选 8 的打分尺子。
 * 闲家方抄成底、且最后一圈有把握时，会**故意把 K/10 埋进底里**等着抠 ×4/×8。
 */
export function botKou(state: SjBrainState, dealer: SjBrainMe, _rng?: SjRng): string[] {
  const ctx = ctxOf(state);
  // 服务端传引擎状态、客户端的「帮我扣」传 `SjPublicRoom` —— 两边算出来一模一样，
  // 因为记牌器读的每一项都是公开信息（别人的 `hand` 在公开视图里是空数组，本来也不该读）。
  // 只有连 `players` 都拿不到的退化调用（老测试、CLI 片段）才落到纯手牌打分上。
  if (!state.players?.length) {
    return suggestBottom(dealer.hand, state.trump, dealer.declaredIds ?? []);
  }
  const v = brainFromState(state, dealer);
  const closer = findCloser(v);
  // 上一个亮主者的花色：他那门长，扣光造缺门就能毙他（§5.1 / B6）
  let rivalLongSuit: SjGroup | null = null;
  for (const p of state.players) {
    if (p.seat === dealer.seat || !p.declaredIds.length) continue;
    const c = cardFromId(p.declaredIds[0]);
    if (c.suit === 'J') continue;
    const g = c.suit as SjGroup;
    if (g !== state.trump.suit) rivalLongSuit = g;
  }
  const unseenIn: Partial<Record<SjGroup, number>> = {};
  for (const g of ['S', 'H', 'C', 'D'] as SjGroup[]) unseenIn[g] = v.groups[g].unseenCount;

  return chooseBottom(dealer.hand, {
    ctx,
    trump: state.trump.suit,
    declaredIds: dealer.declaredIds ?? [],
    defenderSide: state.dealerSeat % 2 !== dealer.seat % 2,
    rivalLongSuit,
    closerConfidence: closerConfidence(v, closer),
    unseenIn,
  }).map((c) => c.id);
}

/**
 * **客户端「帮我扣」的窄接口**：只吃手牌和主，不需要整个房间状态。
 *
 * `botKou` 读记牌器（对手的长门、closer 把握、各门场外张数），那些只有服务端算得出。
 * 客户端手上只有自己的手牌和公开的主花色，所以这里退化成"纯手牌打分"：
 * 不拆对子、不埋主、不埋 A、优先埋短门 —— 该守的规矩全在，只是少了针对性。
 * 永远返回 8 张，永远不抛异常。
 */
export function suggestBottom(
  hand: SjCard[],
  trump: { suit: SjTrumpSuit | null; level: number },
  declaredIds: readonly string[] = [],
): string[] {
  return chooseBottom(hand, {
    ctx: { trump: trump.suit, level: trump.level },
    trump: trump.suit,
    declaredIds,
    defenderSide: false,
  }).map((c) => c.id);
}

/* --------------------------------------------------------------- 记牌 */

/** 场上还没露面的牌（别人手里 + 底牌）。所有人算出来的都一样，不含任何私密信息 */
export function unseenCards(hand: SjCard[], playedIds: string[]): SjCard[] {
  return brainUnseen(hand, playedIds);
}

/**
 * 这个单位是不是该组当前的**绝张**（没人压得过）。
 * 相等归先出者赢（DESIGN 1.7），所以"没人比我大"就够，不需要严格更大。
 */
export function isSureMax(unit: SjUnit, group: SjGroup, unseen: SjCard[], ctx: SjCtx): boolean {
  const pool = cardsInGroup(unseen, group, ctx);
  if (unit.kind === 'single') return maxOrder(pool, ctx) <= unit.top;
  const runs = runsOf(pool, ctx);
  if (unit.kind === 'pair') return runs.every((r) => r.top <= unit.top);
  return runs.every((r) => r.len < unit.span || r.top <= unit.top);
}

/* --------------------------------------------------------------- 出牌 */

/** 首出候选，从好到差（带 `why`，测试和提示面板都读它） */
export function rankLeads(view: SjSuggestView, hand: SjCard[]): SjScored[] {
  return rankLeadPlays(brainFromSuggestView(view, hand));
}

/** 跟牌候选，从好到差 */
export function rankFollows(view: SjSuggestView, hand: SjCard[], lead: SjShape): SjScored[] {
  return rankFollowPlays(brainFromSuggestView(view, hand), lead);
}

export function botLead(view: SjSuggestView, hand: SjCard[]): SjCard[] {
  const best = rankLeads(view, hand)[0];
  return best ? best.cards : hand.slice(0, 1);
}

export function botFollow(view: SjSuggestView, hand: SjCard[], lead: SjShape): SjCard[] {
  const ctx = ctxOf(view);
  const best = rankFollows(view, hand, lead)[0];
  if (best && validateFollow(hand, lead, best.cards, ctx).ok) return best.cards;
  return composeFollow(hand, lead, ctx, 'low');
}

/** 机器人（或超时代打）该出什么。返回一定通过 `validateFollow` 的牌 id */
export function botPlay(state: SjRoomState, me: SjPlayer, _rng?: SjRng): string[] {
  const ctx = ctxOf(state);
  const view = suggestViewOf(state, me);
  if (!state.trick.length) return botLead(view, me.hand).map((c) => c.id);

  const lead = parseShape(state.trick[0].cardIds.map(cardFromId), ctx);
  if (!lead) return me.hand.slice(0, 1).map((c) => c.id);
  const cards = botFollow(view, me.hand, lead);
  if (validateFollow(me.hand, lead, cards, ctx).ok) return cards.map((c) => c.id);
  return composeFollow(me.hand, lead, ctx, 'low').map((c) => c.id);
}

/** 引擎状态 → 公开视图（机器人自己也走这条路，和客户端看到的完全一样） */
export function suggestViewOf(state: SjRoomState, me: SjPlayer): SjSuggestView {
  return {
    trump: state.trump,
    trick: state.trick.map((p) => ({ seat: p.seat, cardIds: p.cardIds })),
    playedIds: state.playedIds,
    mySeat: me.seat,
    trickNo: state.trickNo,
    voidGroups: state.voidGroups,
    noPairs: state.noPairs,
    dealerSeat: state.dealerSeat,
    kouSeat: state.kouSeat,
    defenderPoints: state.defenderPoints,
    handTrickPoints: state.handTrickPoints,
    lastTrick: state.lastTrick
      ? { leaderSeat: state.lastTrick.leaderSeat, plays: state.lastTrick.plays }
      : null,
    levels: state.levels,
    topLevel: topLevelOf(state.kind),
    declaredIds: state.players.slice().sort((a, b) => a.seat - b.seat).map((p) => p.declaredIds),
    bottom: me.seat === state.kouSeat ? state.bottom.map((c) => c.id) : undefined,
  };
}

/* --------------------------------------------------------------- 提示 */

/**
 * 「提示」按钮与命令行的候选出法（DESIGN 1.10 末条 / 3.4）。
 * 只用自己的手牌与公开信息，所以客户端可以直接调。
 *
 * **排序完全交给 brain** —— 也就是机器人自己在用的那套判断，
 * 所以第一条建议就是"会打的人会走的那一步"，而不是固定的"先出大牌"。
 * 去重后长度为 1 就意味着这一手别无选择，客户端据此替玩家预选。
 */
export function suggest(view: SjSuggestView, hand: SjCard[], limit = 5): SjCard[][] {
  const ctx = ctxOf(view);
  const out: SjCard[][] = [];
  const seen = new Set<string>();
  const add = (cards: SjCard[] | null) => {
    if (!cards || !cards.length || out.length >= limit) return;
    const key = cards.map((c) => c.id).sort().join(',');
    if (seen.has(key)) return;
    seen.add(key);
    out.push(cards);
  };

  if (!view.trick.length) {
    for (const s of rankLeads(view, hand)) add(s.cards);
    return out;
  }
  const lead = parseShape(view.trick[0].cardIds.map(cardFromId), ctx);
  if (!lead) return out;
  for (const s of rankFollows(view, hand, lead)) add(s.cards);
  return out;
}

/* --------------------------------------------------------------- 节奏 */

/**
 * 机器人"想"多久（BRAIN-DESIGN §7 / M17）。
 *
 * 唯一合法解 500–900ms；多候选且 EV 差距明显 900–1500ms；前两名接近 1500–2400ms；
 * 最后一圈或动到 closer 再 +500ms。上限恒小于 `turnSeconds` 的一半，
 * 所以再怎么抖也不会把自己抖到超时代打。
 */
export function botThinkMs(state: SjRoomState, me: SjPlayer, rng?: SjRng): number {
  const r = rng ? rng() : Math.random();
  let base = 500;
  let span = 400;
  try {
    const ctx = ctxOf(state);
    const view = suggestViewOf(state, me);
    const lead = state.trick.length
      ? parseShape(state.trick[0].cardIds.map(cardFromId), ctx)
      : null;
    const ranked = lead ? rankFollows(view, me.hand, lead) : rankLeads(view, me.hand);
    if (ranked.length >= 2) {
      const gap = Math.abs(ranked[0].ev - ranked[1].ev);
      if (gap < 3) { base = 1500; span = 900; } else { base = 900; span = 600; }
    }
    const v = brainFromState(state, me);
    if (v.isLastTrick(lead ? lead.count : (ranked[0]?.cards.length ?? 1))
      || (ranked[0]?.parts.digPlan ?? 0) !== 0) base += 500;
  } catch {
    // 想不明白就按最短的来 —— 延时算错不该拖垮出牌
  }
  const cap = Math.max(600, state.settings.turnSeconds * 1000 / 2 - 200);
  return Math.min(cap, Math.round(base + r * span));
}

export { sumPoints, strengthFor };
