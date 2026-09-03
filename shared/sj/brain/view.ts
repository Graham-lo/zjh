/**
 * **记牌器与局面视图**（BRAIN-DESIGN §2）。
 *
 * 把全场看得见的东西算成一个会打牌的人脑子里的那几件事：
 * 我是庄家方还是闲家方、闲家还差多少分上台、还剩几圈、
 * **每门场外还剩哪些牌 / 几张 / 多少分 / 还能凑出什么对子拖拉机 / 可能在谁手里**、
 * 底里大概埋了多少分、这一圈现在谁在赢、我是第几家、我后面还有谁要出。
 *
 * 首出、跟牌、扣底、亮主全部读这一份视图 —— 一个脑子，一处改两边一起变。
 *
 * **不许偷看**：输入只有自己的手牌和 `BrainInput` 里那些全场都看得见的字段。
 * `bottom` 是唯一的例外，只有扣底的人本人（`me.seat === state.kouSeat`）才允许传进来 ——
 * 那 8 张是他自己扣下去的，不是别人的暗牌。扣底者算 `unseen` 时把底剔掉，
 * 于是他的"场外"就精确等于另外三家的手牌。
 */

import {
  cardOrder, createSjDeck, pointsOf, sumPoints,
  type SjCard, type SjCtx, type SjGroup, type SjTrumpSuit,
} from '../cards.ts';
import {
  cardsInGroup, maxOrder, parseShape, primaryUnit, runsOf,
  type SjRun, type SjShape, type SjUnit,
} from '../units.ts';
import { trickWinner } from '../rules.ts';

export const ALL_GROUPS: SjGroup[] = ['T', 'S', 'H', 'C', 'D'];
export const SIDE_GROUPS: SjGroup[] = ['S', 'H', 'C', 'D'];

/** 闲家上台线（`outcomeFor` 的分界）与升级表的全部门槛 */
export const DEFENDER_TARGET = 80;
export const THRESHOLDS = [0, 5, 40, 80, 120, 160, 200];
/** 底牌张数 */
export const BOTTOM_SIZE = 8;

/** 建视图要的公开信息。除 `bottom` 外没有一项是别人的暗牌 */
export interface BrainInput {
  trump: { suit: SjTrumpSuit | null; level: number; declarerId?: string | null };
  /** 本局已打出的所有牌 id */
  playedIds: string[];
  /** 本圈已经出过的牌（含首出），按出牌顺序 */
  trick?: { seat: number; cards: SjCard[] }[];
  mySeat: number;
  trickNo: number;
  /** 各座位公开确认过的缺门 */
  voidGroups?: readonly (readonly SjGroup[])[];
  /** 各座位公开确认过的「这门没有对子了」（跟牌结构暴露，BRAIN-DESIGN §3） */
  noPairs?: readonly (readonly SjGroup[])[];
  /** 各座位亮出过的明牌花色（亮主/反主/抄底历史：那门他一定长） */
  declaredSuits?: readonly (SjGroup | null)[];
  dealerSeat?: number | null;
  kouSeat?: number | null;
  defenderPoints?: number;
  /** 两队从圈里抓到的分，按 `seat % 2` 索引 */
  handTrickPoints?: readonly [number, number];
  /** 上一圈的完整记录 —— 判"对家想要哪门"（回牌）用 */
  lastTrick?: { leaderSeat: number; plays: { seat: number; cards: SjCard[] }[] } | null;
  /** 两队级别与阶梯顶（通关局判定）。缺省就当不是通关局 */
  levels?: readonly [number, number];
  topLevel?: number;
  /** 我自己扣的底 —— **只有 `me.seat === kouSeat` 时才准传** */
  bottom?: readonly SjCard[];
}

/** 一门牌的记牌器 */
export interface BrainGroup {
  group: SjGroup;
  /** 我手里这门有哪些 */
  mine: SjCard[];
  minePoints: number;
  /** 场外这门还有哪些（含底；扣底者已把底剔除） */
  unseen: SjCard[];
  unseenCount: number;
  unseenPoints: number;
  /** 场外这门最大的 order；一张不剩是 -1 */
  unseenTop: number;
  /** 场外这门还能凑出的对子 / 连对 —— 判对子和拖拉机的绝张要用它 */
  unseenRuns: SjRun[];
  /** 还可能持有这门的其他座位（未公开缺门的） */
  holders: number[];
  /** 这门被首出过几次（探路 / 回牌用；只统计上一圈与本圈） */
  ledTimes: number;
  /** 首出过这门的座位 */
  ledBy: number[];
  /** 这个单位对场外来说是不是绝张 */
  sureMax(unit: SjUnit): boolean;
}

export interface BrainView {
  ctx: SjCtx;
  me: number;
  partner: number;
  opps: [number, number];
  /** 庄家座位未知时按"闲家方"处理（`iAmDealerTeam` 为 false，`teamKnown` 为 false） */
  dealerSeat: number | null;
  teamKnown: boolean;
  iAmDealerTeam: boolean;
  iAmKou: boolean;
  /** 庄家方处于阶梯顶：守住这一局就赢下整场 */
  matchPoint: boolean;
  hand: SjCard[];
  handSize: number;
  trickNo: number;
  /** 保守估计还剩几圈 */
  tricksLeft: number;
  /** 尾局：剩 ≤ 3 圈 */
  endgame: boolean;
  /** 出 `count` 张就是最后一圈 */
  isLastTrick(count: number): boolean;

  /* ---- 分数账本 */
  defenderPoints: number;
  myTeamTrickPoints: number;
  foeTeamTrickPoints: number;
  pointsOnTable: number;
  /** 场外（他人手里 + 底）还有多少分 */
  unseenPoints: number;
  unseenPointCards: { five: number; ten: number; king: number };
  bottomPointsExact: number | null;
  bottomPointsExpected: number;
  need: { defendersTo80: number; dealerCanStillGive: number };

  /* ---- 每门的记牌器 */
  groups: Record<SjGroup, BrainGroup>;
  trumps: {
    mine: number;
    unseen: number;
    /** 场外的主平摊到每个可能持主的座位上有几张 */
    perHolder: number;
    oppsMayHold: boolean;
    partnerMayHold: boolean;
    /** 场外比我最大的主还大的主 */
    topUnseen: SjCard[];
  };

  /* ---- 本圈 */
  trick: {
    lead: SjShape | null;
    leadCards: SjCard[];
    plays: { seat: number; cards: SjCard[] }[];
    leaderSeat: number | null;
    bestSeat: number | null;
    bestIsPartner: boolean;
    /** 我是本圈第几家（0 = 首出） */
    position: 0 | 1 | 2 | 3;
    /** 我出完之后还要出牌的座位 */
    toAct: number[];
  };

  /** 各座位亮过的花色（他那门长，别在那门送分；对家那门则值得回牌） */
  declaredSuits: (SjGroup | null)[];
  isVoid(seat: number, group: SjGroup): boolean;
  /** 已公开「这门没有对子」——对他而言我方的对子就是绝张（§3 / M2 / M5） */
  noPairIn(seat: number, group: SjGroup): boolean;
  /** 场外某一张该门的牌落在 `seat` 手里的概率（0–1；底牌也占份额） */
  holderOdds(seat: number, group: SjGroup): number;
  /** 推测 `seat` 手里还有几张这门 —— 「场外只剩 3 张、对手 A 已缺门 → 那 3 张在对家或对手 B」 */
  estHolding(seat: number, group: SjGroup): number;
}

/** 场上还没露面的牌（别人手里 + 底牌）。不含任何私密信息 */
export function unseenCards(hand: SjCard[], playedIds: string[], bottom?: readonly SjCard[]): SjCard[] {
  const known = new Set<string>(playedIds);
  for (const c of hand) known.add(c.id);
  if (bottom) for (const c of bottom) known.add(c.id);
  return createSjDeck().filter((c) => !known.has(c.id));
}

export function buildView(input: BrainInput, hand: SjCard[]): BrainView {
  const ctx: SjCtx = { trump: input.trump.suit, level: input.trump.level };
  const me = input.mySeat;
  const partner = (me + 2) % 4;
  const opps: [number, number] = [(me + 1) % 4, (me + 3) % 4];
  const others = [partner, ...opps];

  const iAmKou = input.kouSeat != null && input.kouSeat === me && !!input.bottom;
  const unseen = unseenCards(hand, input.playedIds, iAmKou ? input.bottom : undefined);
  const isVoid = (seat: number, g: SjGroup) => input.voidGroups?.[seat]?.includes(g) ?? false;
  const noPairIn = (seat: number, g: SjGroup) =>
    isVoid(seat, g) || (input.noPairs?.[seat]?.includes(g) ?? false);

  // 场外的牌按"没缺这门的人 + 还盖着的底"分份额。各家手牌张数逐圈相等，用我的张数近似。
  const bottomHidden = iAmKou ? 0 : BOTTOM_SIZE;
  const seatSlots = Math.max(1, hand.length);
  const holdersOf = (g: SjGroup) => others.filter((s) => !isVoid(s, g));
  const holderOdds = (seat: number, g: SjGroup) => {
    if (seat === me || isVoid(seat, g)) return 0;
    const denom = holdersOf(g).length * seatSlots + bottomHidden;
    return denom > 0 ? Math.min(1, seatSlots / denom) : 0;
  };

  // 只看得见上一圈和本圈的首出（引擎不保存整局的逐圈记录）——「对家想要哪门」够用了
  const ledTimes: Record<string, number> = {};
  const ledBy: Record<string, number[]> = {};
  const noteLead = (plays?: { seat: number; cards: SjCard[] }[]) => {
    if (!plays?.length || !plays[0].cards.length) return;
    const g = parseShape(plays[0].cards, ctx)?.group;
    if (!g) return;
    ledTimes[g] = (ledTimes[g] ?? 0) + 1;
    (ledBy[g] ??= []).push(plays[0].seat);
  };
  noteLead(input.lastTrick?.plays);
  noteLead(input.trick);

  const groups = {} as Record<SjGroup, BrainGroup>;
  let unseenPoints = 0;
  const unseenPointCards = { five: 0, ten: 0, king: 0 };
  for (const g of ALL_GROUPS) {
    const gu = cardsInGroup(unseen, g, ctx);
    const gm = cardsInGroup(hand, g, ctx);
    const gp = sumPoints(gu);
    unseenPoints += gp;
    for (const c of gu) {
      if (c.rank === 5) unseenPointCards.five++;
      else if (c.rank === 10) unseenPointCards.ten++;
      else if (c.rank === 13) unseenPointCards.king++;
    }
    const runs = runsOf(gu, ctx);
    groups[g] = {
      group: g,
      mine: gm,
      minePoints: sumPoints(gm),
      unseen: gu,
      unseenCount: gu.length,
      unseenPoints: gp,
      unseenTop: gu.length ? maxOrder(gu, ctx) : -1,
      unseenRuns: runs,
      holders: holdersOf(g),
      ledTimes: ledTimes[g] ?? 0,
      ledBy: ledBy[g] ?? [],
      sureMax: (unit: SjUnit) => {
        if (unit.kind === 'single') return (gu.length ? maxOrder(gu, ctx) : -1) <= unit.top;
        if (unit.kind === 'pair') return runs.every((r) => r.top <= unit.top);
        return runs.every((r) => r.len < unit.span || r.top <= unit.top);
      },
    };
  }

  const myTrumps = groups.T.mine;
  const myTrumpTop = myTrumps.length ? maxOrder(myTrumps, ctx) : -1;
  const trumpHolders = others.filter((s) => !isVoid(s, 'T'));

  const plays = input.trick ?? [];
  const leadCards = plays.length ? plays[0].cards : [];
  const lead = leadCards.length ? parseShape(leadCards, ctx) : null;
  const winner = plays.length ? trickWinner(plays, ctx) : null;
  const toAct: number[] = [];
  for (let i = 1; i <= 3 - plays.length; i++) toAct.push((me + i) % 4);

  const dealerSeat = input.dealerSeat ?? null;
  const iAmDealerTeam = dealerSeat != null && dealerSeat % 2 === me % 2;
  const defenderPoints = input.defenderPoints ?? 0;

  const bottomPointsExact = input.bottom ? sumPoints([...input.bottom]) : null;
  const bottomPointsExpected = bottomPointsExact ?? (
    unseen.length <= BOTTOM_SIZE
      ? unseenPoints                                        // 场外只剩底，人人都算得准
      : (unseenPoints * BOTTOM_SIZE) / unseen.length
  );

  // 前面每圈平均用掉几张，把手牌张数折成"还剩几圈"
  const tricksDone = Math.max(0, input.trickNo - 1);
  const avg = tricksDone > 0 ? Math.max(1, input.playedIds.length / 4 / tricksDone) : 1;
  const tricksLeft = Math.max(1, Math.ceil(hand.length / avg));

  const topLevel = input.topLevel ?? null;
  const dealerTeamLevel = dealerSeat != null && input.levels
    ? input.levels[dealerSeat % 2] : null;

  return {
    ctx,
    me,
    partner,
    opps,
    dealerSeat,
    teamKnown: dealerSeat != null,
    iAmDealerTeam,
    iAmKou,
    matchPoint: topLevel != null && dealerTeamLevel != null && dealerTeamLevel >= topLevel,
    hand,
    handSize: hand.length,
    trickNo: input.trickNo,
    tricksLeft,
    endgame: tricksLeft <= 3,
    isLastTrick: (count: number) => hand.length <= count,

    defenderPoints,
    myTeamTrickPoints: input.handTrickPoints?.[me % 2] ?? 0,
    foeTeamTrickPoints: input.handTrickPoints?.[(me + 1) % 2] ?? 0,
    pointsOnTable: plays.reduce((s, p) => s + sumPoints(p.cards), 0),
    unseenPoints,
    unseenPointCards,
    bottomPointsExact,
    bottomPointsExpected,
    need: {
      defendersTo80: Math.max(0, DEFENDER_TARGET - defenderPoints),
      dealerCanStillGive: Math.max(0, DEFENDER_TARGET - 1 - defenderPoints),
    },

    groups,
    trumps: {
      mine: myTrumps.length,
      unseen: groups.T.unseenCount,
      perHolder: trumpHolders.length ? groups.T.unseenCount / trumpHolders.length : 0,
      oppsMayHold: opps.some((s) => !isVoid(s, 'T')),
      partnerMayHold: !isVoid(partner, 'T'),
      topUnseen: groups.T.unseen.filter((c) => cardOrder(c, ctx) > myTrumpTop),
    },

    trick: {
      lead,
      leadCards,
      plays,
      leaderSeat: plays.length ? plays[0].seat : null,
      bestSeat: winner ? winner.seat : null,
      bestIsPartner: !!winner && winner.seat === partner,
      position: plays.length as 0 | 1 | 2 | 3,
      toAct,
    },

    declaredSuits: Array.from({ length: 4 }, (_, i) => input.declaredSuits?.[i] ?? null),
    isVoid,
    noPairIn,
    holderOdds,
    estHolding: (seat, g) => groups[g].unseenCount * holderOdds(seat, g),
  };
}

/** 这一手牌的主单位是不是绝张（跨组的垫牌不算） */
export function isSureMaxPlay(cards: SjCard[], v: BrainView): boolean {
  const shape = parseShape(cards, v.ctx);
  if (!shape) return false;
  return v.groups[shape.group].sureMax(primaryUnit(shape));
}

/**
 * 从 `pool` 里**能覆盖首出结构**的最强单位有多大；凑不出来返回 -1。
 * 只取最长那条拖拉机 / 最大那个对子做近似 —— 这里问的是"还有没有人可能盖过我"，
 * 宁可高估威胁，也不能低估到把送分当成稳赢。
 */
export function coverTop(pool: SjCard[], lead: SjShape, ctx: SjCtx): number {
  if (pool.length < lead.count) return -1;
  if (lead.tractors.length) {
    const need = lead.tractors[0];
    let best = -1;
    for (const r of runsOf(pool, ctx)) if (r.len >= need) best = Math.max(best, r.top);
    return best;
  }
  if (lead.pairs > 0) {
    const runs = runsOf(pool, ctx);
    if (runs.reduce((s, r) => s + r.len, 0) < lead.pairs) return -1;
    let best = -1;
    for (const r of runs) best = Math.max(best, r.top);
    return best;
  }
  return maxOrder(pool, ctx);
}

/** 场外能盖住 `aboveTop` 的**结构**有几个（单张数张、对子数对、拖拉机数条） */
export function countCovers(pool: SjCard[], lead: SjShape, ctx: SjCtx, aboveTop: number): number {
  if (pool.length < lead.count) return 0;
  const runs = runsOf(pool, ctx);
  if (lead.tractors.length) {
    const need = lead.tractors[0];
    let n = 0;
    for (const r of runs) {
      if (r.len < need) continue;
      for (let k = 0; k <= r.len - need; k++) if (r.top - k > aboveTop) n++;
    }
    return n;
  }
  if (lead.pairs > 0) {
    let n = 0;
    for (const r of runs) for (let k = 0; k < r.len; k++) if (r.top - k > aboveTop) n++;
    return n;
  }
  let n = 0;
  for (const c of pool) if (cardOrder(c, ctx) > aboveTop) n++;
  return n;
}

export { pointsOf, sumPoints };
