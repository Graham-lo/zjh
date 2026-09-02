/**
 * 升级的机器人 —— 同时也是**超时代打**和**「提示」按钮**的来源（DESIGN 1.10）。
 *
 * 目标是"像个会打的朋友"，不追求强：能认出自己手里的绝张、会造缺门、
 * 该毙的时候毙、对家稳赢时会给分。策略本身是确定性的，`rng` 只用来打散
 * 完全等价的选择，不传就完全可复现 —— 模糊测试要能靠种子重放。
 *
 * 这个文件**不 import engine.ts 的任何值**（只 import 类型，编译后会被擦掉），
 * 所以 engine → bot 的调用不会形成运行时循环依赖。
 */

import {
  SJ_SUITS, cardFromId, cardOrder, createSjDeck, groupOf, pointsOf,
  type SjCard, type SjCtx, type SjGroup, type SjPlainSuit, type SjRng, type SjTrumpSuit,
} from './cards.ts';
import {
  allPairs, allSingles, allTractors, cardsInGroup, maxOrder, parseShape, runsOf, unitPriority,
  type SjShape, type SjUnit,
} from './units.ts';
import { followRequirement, trickWinner, validateFollow } from './rules.ts';
import type { SjPlayer, SjRoomState } from './engine.ts';

/** 提示按钮和 CLI 只需要这些公开字段，`SjPublicRoom` 天然满足 */
export interface SjSuggestView {
  trump: { suit: SjTrumpSuit | null; level: number };
  trick: { seat: number; cardIds: string[] }[];
  playedIds: string[];
}

type Prefer = 'low' | 'high' | 'points';

const ctxOf = (v: { trump: { suit: SjTrumpSuit | null; level: number } }): SjCtx => ({
  trump: v.trump.suit,
  level: v.trump.level,
});

const ALL_GROUPS: SjGroup[] = ['T', 'S', 'H', 'C', 'D'];

function without(pool: SjCard[], used: SjCard[]): SjCard[] {
  const ids = new Set(used.map((c) => c.id));
  return pool.filter((c) => !ids.has(c.id));
}

/* --------------------------------------------------------------- 亮主 */

/**
 * 亮主（DESIGN 1.10）：有级牌且该花色（含级牌与王）≥ 7 张就亮单张；
 * 有对级牌且该色 ≥ 8 张亮对；对王且主牌总数 ≥ 9 时反无主。
 *
 * **绝不为反而反**：别人已经亮了，只有换成我的花色后我的主更多时才反 ——
 * 这一条只用自己的手牌就能判，不需要偷看别人。
 *
 * 返回要亮的牌 id；不亮返回 null。
 */
export function botDeclare(state: SjRoomState, me: SjPlayer): string[] | null {
  if (state.phase !== 'dealing' && state.phase !== 'declaring') return null;
  const level = state.trump.level;
  const cur = state.trump;
  const hand = me.hand;
  const trumpCountFor = (t: SjTrumpSuit) => hand.filter((c) => groupOf(c, { trump: t, level })=== 'T').length;

  const options: { cards: SjCard[]; strength: number; trump: SjTrumpSuit }[] = [];
  for (const suit of SJ_SUITS) {
    const levels = hand.filter((c) => c.suit === suit && c.rank === level);
    if (levels.length >= 2) options.push({ cards: levels.slice(0, 2), strength: 2, trump: suit });
    if (levels.length >= 1) options.push({ cards: [levels[0]], strength: 1, trump: suit });
  }
  for (const [rank, strength] of [[15, 3], [16, 4]] as const) {
    const jokers = hand.filter((c) => c.suit === 'J' && c.rank === rank);
    if (jokers.length >= 2) options.push({ cards: jokers.slice(0, 2), strength, trump: 'NT' });
  }

  const strongEnough = (o: { trump: SjTrumpSuit; strength: number }) => {
    const n = trumpCountFor(o.trump);
    if (o.trump === 'NT') return n >= 9;
    return o.strength >= 2 ? n >= 8 : n >= 7;
  };

  let usable = options.filter((o) => o.strength > cur.strength && strongEnough(o));
  if (cur.declarerId === me.id) {
    // 不能用别的花色反自己；同花色的第二张级牌是「加固」，对王可以把自己反成无主
    usable = usable.filter((o) => o.trump === cur.suit || o.trump === 'NT');
  } else if (cur.suit) {
    const curCount = trumpCountFor(cur.suit);
    usable = usable.filter((o) => trumpCountFor(o.trump) > curCount);
  }
  if (!usable.length) return null;

  usable.sort((a, b) => b.strength - a.strength || trumpCountFor(b.trump) - trumpCountFor(a.trump));
  return usable[0].cards.map((c) => c.id);
}

/* --------------------------------------------------------------- 扣底 */

/**
 * 扣底（DESIGN 1.10）：优先扣副牌里张数最少的花色的非分牌单张（造缺门），
 * 其次扣其他副牌小单张；不扣主牌、对子、分牌，除非没得扣。
 *
 * 实现成一把打分尺子而不是一串 if：33 选 8 的边角情况太多（手里全是分牌、
 * 全是主牌），排序取前 8 永远能给出 8 张，不会卡住。
 */
export function botKou(state: SjRoomState, dealer: SjPlayer, _rng?: SjRng): string[] {
  const ctx = ctxOf(state);
  const hand = dealer.hand;
  const suitCount = new Map<SjGroup, number>();
  for (const c of hand) {
    const g = groupOf(c, ctx);
    suitCount.set(g, (suitCount.get(g) ?? 0) + 1);
  }
  const paired = new Set<string>();
  for (const g of ALL_GROUPS) {
    for (const run of runsOf(cardsInGroup(hand, g, ctx), ctx)) {
      for (const pair of run.pairs) for (const c of pair) paired.add(c.id);
    }
  }

  const score = (c: SjCard) => {
    const g = groupOf(c, ctx);
    let s = cardOrder(c, ctx);
    if (g === 'T') s += 10_000; // 主牌绝不轻易扣
    if (pointsOf(c) > 0) s += 2_000; // 分牌扣了等于送分
    if (paired.has(c.id)) s += 500; // 拆对子不划算
    else s += (suitCount.get(g) ?? 0) * 20; // 花色越短越先扣，造缺门
    return s;
  };
  return hand.slice().sort((a, b) => score(a) - score(b) || (a.id < b.id ? -1 : 1)).slice(0, 8).map((c) => c.id);
}

/* ------------------------------------------------------- 组一手合法的牌 */

/** 按偏好挑 k 张"随便填"的牌 */
function pickFillers(pool: SjCard[], k: number, ctx: SjCtx, prefer: Prefer): SjCard[] {
  const key = (c: SjCard) => {
    const order = cardOrder(c, ctx);
    const trump = groupOf(c, ctx) === 'T' ? 1 : 0;
    if (prefer === 'high') return -order;
    // 垫分：优先把分牌送出去（对家稳赢时用）
    if (prefer === 'points') return pointsOf(c) > 0 ? -pointsOf(c) * 100 + order : 1_000 + order;
    // 默认垫最小、不带分、不拆主
    return trump * 10_000 + (pointsOf(c) > 0 ? 1_000 : 0) + order;
  };
  return pool.slice().sort((a, b) => key(a) - key(b) || (a.id < b.id ? -1 : 1)).slice(0, k);
}

function pickUnit(list: SjUnit[], prefer: Prefer): SjUnit | null {
  if (!list.length) return null;
  // allTractors / allPairs 都按 top 升序返回
  return prefer === 'high' ? list[list.length - 1] : list[0];
}

/**
 * 按 DESIGN 1.6 组出一手**合法**的跟牌。
 *
 * 直接照着 `followRequirement` 算出来的最低要求填：先补必须出的拖拉机，
 * 再补必须出的对子，剩下的槽位随便填 —— 构造出来的牌天然满足校验，
 * 不需要枚举组合再筛。
 */
export function composeFollow(hand: SjCard[], lead: SjShape, ctx: SjCtx, prefer: Prefer): SjCard[] {
  const n = lead.count;
  let pool = cardsInGroup(hand, lead.group, ctx);
  const chosen: SjCard[] = [];

  if (pool.length < n) {
    // 有 G 必跟 G，不足时 G 全出、其余任意
    chosen.push(...pool);
    const rest = hand.filter((c) => groupOf(c, ctx) !== lead.group);
    chosen.push(...pickFillers(rest, n - pool.length, ctx, prefer));
    return chosen;
  }

  const req = followRequirement(pool, lead, ctx);
  for (const span of req.tractors) {
    const unit = pickUnit(allTractors(pool, lead.group, ctx).filter((u) => u.span === span), prefer);
    if (!unit) break;
    chosen.push(...unit.cards);
    pool = without(pool, unit.cards);
  }
  for (let i = 0; i < req.pairs; i++) {
    const unit = pickUnit(allPairs(pool, lead.group, ctx), prefer);
    if (!unit) break;
    chosen.push(...unit.cards);
    pool = without(pool, unit.cards);
  }
  chosen.push(...pickFillers(pool, n - chosen.length, ctx, prefer));
  return chosen;
}

/**
 * 缺门时用主牌**毙**：结构必须和首出完全一致才算数（DESIGN 1.7），
 * 配不出同样的结构就返回 null —— 那就只能垫牌。
 */
export function composeTrumpBeat(hand: SjCard[], lead: SjShape, ctx: SjCtx, prefer: Prefer): SjCard[] | null {
  if (lead.group === 'T') return null;
  let pool = cardsInGroup(hand, 'T', ctx);
  if (pool.length < lead.count) return null;
  const chosen: SjCard[] = [];
  for (const span of lead.tractors) {
    const unit = pickUnit(allTractors(pool, 'T', ctx).filter((u) => u.span === span), prefer);
    if (!unit) return null;
    chosen.push(...unit.cards);
    pool = without(pool, unit.cards);
  }
  for (let i = 0; i < lead.pairs; i++) {
    const unit = pickUnit(allPairs(pool, 'T', ctx), prefer);
    if (!unit) return null;
    chosen.push(...unit.cards);
    pool = without(pool, unit.cards);
  }
  const fillers = pickFillers(pool, lead.singles, ctx, prefer);
  if (fillers.length < lead.singles) return null;
  chosen.push(...fillers);
  return chosen.length === lead.count ? chosen : null;
}

/* --------------------------------------------------------------- 首出 */

/** 场上还没露面的牌（别人手里 + 底牌）。所有人算出来的都一样，不含任何私密信息 */
export function unseenCards(hand: SjCard[], playedIds: string[]): SjCard[] {
  const known = new Set<string>(playedIds);
  for (const c of hand) known.add(c.id);
  return createSjDeck().filter((c) => !known.has(c.id));
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

function leadCandidates(hand: SjCard[], ctx: SjCtx): { group: SjGroup; unit: SjUnit }[] {
  const out: { group: SjGroup; unit: SjUnit }[] = [];
  for (const group of ALL_GROUPS) {
    const cards = cardsInGroup(hand, group, ctx);
    if (!cards.length) continue;
    for (const u of allTractors(hand, group, ctx)) out.push({ group, unit: u });
    for (const u of allPairs(hand, group, ctx)) out.push({ group, unit: u });
    for (const u of allSingles(hand, group, ctx)) out.push({ group, unit: u });
  }
  return out;
}

/**
 * 首出（DESIGN 1.10）：先打自己手里的绝张；否则主牌够多时先"抽主"；
 * 再否则从最长的副牌花色出一张不带分的小牌。
 */
export function botLead(hand: SjCard[], ctx: SjCtx, playedIds: string[], rng?: SjRng): SjCard[] {
  const unseen = unseenCards(hand, playedIds);
  const cands = leadCandidates(hand, ctx);

  const sure = cands.filter((c) => isSureMax(c.unit, c.group, unseen, ctx));
  if (sure.length) {
    // 绝张里挑最"重"的一手：拖拉机 > 对子 > 单张，同级取大
    sure.sort((a, b) => unitPriority(b.unit) - unitPriority(a.unit) || b.unit.top - a.unit.top);
    return sure[0].unit.cards;
  }

  const trumps = cardsInGroup(hand, 'T', ctx);
  if (trumps.length >= 9) {
    // 主牌多就先抽主：把别人的主榨干，后面的副牌小牌才立得住
    const pair = pickUnit(allPairs(hand, 'T', ctx), 'low');
    if (pair) return pair.cards;
    const single = pickUnit(allSingles(hand, 'T', ctx), 'low');
    if (single) return single.cards;
  }

  const sideGroups = (SJ_SUITS as SjPlainSuit[])
    .map((s) => ({ group: s as SjGroup, cards: cardsInGroup(hand, s, ctx) }))
    .filter((g) => g.cards.length > 0);
  if (sideGroups.length) {
    const most = Math.max(...sideGroups.map((g) => g.cards.length));
    const tied = sideGroups.filter((g) => g.cards.length === most);
    const pick = tied[rng ? Math.min(tied.length - 1, Math.floor(rng() * tied.length)) : 0];
    return pickFillers(pick.cards, 1, ctx, 'low');
  }
  return pickFillers(hand, 1, ctx, 'low');
}

/* --------------------------------------------------------------- 跟牌 */

/**
 * 跟牌（DESIGN 1.10）：能赢且这轮有分或轮次靠后 → 用最小能赢的牌；
 * 对家已稳赢 → 垫分给他；否则出最小、不带分的牌。
 */
export function botFollow(
  hand: SjCard[], lead: SjShape, ctx: SjCtx,
  played: { seat: number; cards: SjCard[] }[], mySeat: number, trickNo: number,
): SjCard[] {
  const pointsOnTable = played.reduce((s, p) => s + p.cards.reduce((a, c) => a + pointsOf(c), 0), 0);
  const leaderWins = trickWinner(played, ctx);
  const partnerWinning = (leaderWins.seat % 2) === (mySeat % 2);

  const candidates: SjCard[][] = [];
  const push = (cards: SjCard[] | null) => {
    if (cards && cards.length === lead.count) candidates.push(cards);
  };
  const voidInLead = cardsInGroup(hand, lead.group, ctx).length === 0;
  const low = composeFollow(hand, lead, ctx, 'low');
  const high = composeFollow(hand, lead, ctx, 'high');
  const givePoints = composeFollow(hand, lead, ctx, 'points');
  if (voidInLead) {
    push(composeTrumpBeat(hand, lead, ctx, 'low'));
    push(composeTrumpBeat(hand, lead, ctx, 'high'));
  }
  push(low);
  push(high);

  const wins = (cards: SjCard[]) =>
    trickWinner([...played, { seat: mySeat, cards }], ctx).seat === mySeat;

  // 值得抢：这一圈有分，或者已经打到后半程（后面的牌越来越硬，能拿就拿）
  const worthWinning = pointsOnTable > 0 || trickNo >= 13;
  if (worthWinning && !partnerWinning) {
    const winners = candidates.filter(wins);
    if (winners.length) {
      // 最小能赢的那一手：拿下就好，别把大牌浪费掉
      winners.sort((a, b) => handWeight(a, ctx) - handWeight(b, ctx));
      return winners[0];
    }
  }
  if (partnerWinning) return givePoints;
  return low;
}

/** 一手牌的"重量"，用来在能赢的候选里挑最省的那一手 */
function handWeight(cards: SjCard[], ctx: SjCtx): number {
  return cards.reduce((s, c) => s + cardOrder(c, ctx), 0);
}

/* --------------------------------------------------------------- 出牌入口 */

/** 机器人（或超时代打）该出什么。返回一定通过 `validateFollow` 的牌 id */
export function botPlay(state: SjRoomState, me: SjPlayer, rng?: SjRng): string[] {
  const ctx = ctxOf(state);
  if (!state.trick.length) return botLead(me.hand, ctx, state.playedIds, rng).map((c) => c.id);

  const played = state.trick.map((p) => ({ seat: p.seat, cards: p.cardIds.map(cardFromId) }));
  const lead = parseShape(played[0].cards, ctx);
  if (!lead) return me.hand.slice(0, 1).map((c) => c.id);
  const cards = botFollow(me.hand, lead, ctx, played, me.seat, state.trickNo);
  // 兜底：策略再怎么改，交出去的一定得是合法的一手 —— 超时代打不能把牌局卡死
  if (validateFollow(me.hand, lead, cards, ctx).ok) return cards.map((c) => c.id);
  return composeFollow(me.hand, lead, ctx, 'low').map((c) => c.id);
}

/* --------------------------------------------------------------- 提示 */

/**
 * 「提示」按钮与命令行的候选出法（DESIGN 1.10 末条 / 3.4）。
 * 只用自己的手牌与公开信息，所以客户端可以直接调。
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
    const unseen = unseenCards(hand, view.playedIds);
    const cands = leadCandidates(hand, ctx);
    // 绝张排前面，其余按"重量"从轻到重，和人的直觉一致
    cands.sort((a, b) => {
      const sa = isSureMax(a.unit, a.group, unseen, ctx) ? 0 : 1;
      const sb = isSureMax(b.unit, b.group, unseen, ctx) ? 0 : 1;
      return sa - sb || unitPriority(b.unit) - unitPriority(a.unit) || a.unit.top - b.unit.top;
    });
    for (const c of cands) add(c.unit.cards);
    return out;
  }

  const played = view.trick.map((p) => ({ seat: p.seat, cards: p.cardIds.map(cardFromId) }));
  const lead = parseShape(played[0].cards, ctx);
  if (!lead) return out;
  if (cardsInGroup(hand, lead.group, ctx).length === 0) {
    add(composeTrumpBeat(hand, lead, ctx, 'low'));
    add(composeTrumpBeat(hand, lead, ctx, 'high'));
  }
  add(composeFollow(hand, lead, ctx, 'high'));
  add(composeFollow(hand, lead, ctx, 'low'));
  add(composeFollow(hand, lead, ctx, 'points'));
  return out.filter((cards) => validateFollow(hand, lead, cards, ctx).ok).slice(0, limit);
}
