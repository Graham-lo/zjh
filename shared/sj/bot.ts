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
  SJ_SUITS, cardFromId, cardOrder, createSjDeck, groupOf, pointsOf, sumPoints,
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
  /** 我的座位。判断现在领先的是不是**对家**（座位号同奇偶为一队）要用它 */
  mySeat: number;
  /** 第几圈。判断是否已进入后半程（该抢就抢）要用它 */
  trickNo: number;
  /** 各座位已经在桌面上公开暴露的缺门；不是服务端暗牌信息 */
  voidGroups?: readonly (readonly SjGroup[])[];
}

interface SjAwareness {
  mySeat: number;
  voidGroups?: readonly (readonly SjGroup[])[];
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

const knownVoid = (awareness: SjAwareness | undefined, seat: number, group: SjGroup) =>
  awareness?.voidGroups?.[seat]?.includes(group) ?? false;

const otherSeats = (seat: number) => [1, 2, 3].map((d) => (seat + d) % 4);

function opponentVoidCount(awareness: SjAwareness | undefined, group: SjGroup): number {
  if (!awareness) return 0;
  return otherSeats(awareness.mySeat)
    .filter((seat) => seat % 2 !== awareness.mySeat % 2 && knownVoid(awareness, seat, group)).length;
}

function partnerIsVoid(awareness: SjAwareness | undefined, group: SjGroup): boolean {
  return !!awareness && knownVoid(awareness, (awareness.mySeat + 2) % 4, group);
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
 * 缺门时用主牌**毙**：这里先组一手与首出完全同构的保守解；规则层还允许
 * “对子/拖拉机比首出更多”的覆盖式毙牌，但不必为了毙牌主动多拆结构。
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
 * 从每门牌的非重叠结构中组出“公开信息已经能证明甩得成”的候选。
 *
 * - 三家都已公开缺门：这门剩余牌不会再被同花色管上，可以整门甩；
 * - 否则只合并逐个能由已出牌证明为最大的单位。
 *
 * 这里只判断甩牌能否成立，不把“成立”等同于“一定收圈”——已缺门的对手仍可能用主牌毙。
 */
function safeThrowCandidates(
  hand: SjCard[], ctx: SjCtx, unseen: SjCard[], awareness?: SjAwareness,
): { group: SjGroup; cards: SjCard[]; opponentVoids: number; partnerVoid: boolean }[] {
  const out: { group: SjGroup; cards: SjCard[]; opponentVoids: number; partnerVoid: boolean }[] = [];
  for (const group of ALL_GROUPS) {
    const groupCards = cardsInGroup(hand, group, ctx);
    const shape = parseShape(groupCards, ctx);
    if (!shape?.isThrow) continue;
    const everyoneElseVoid = !!awareness && otherSeats(awareness.mySeat).every((seat) => knownVoid(awareness, seat, group));
    const units = everyoneElseVoid
      ? shape.units
      : shape.units.filter((unit) => isSureMax(unit, group, unseen, ctx));
    if (units.length < 2) continue;
    const cards = units.flatMap((unit) => unit.cards);
    if (!parseShape(cards, ctx)?.isThrow) continue;
    out.push({
      group,
      cards,
      opponentVoids: opponentVoidCount(awareness, group),
      partnerVoid: partnerIsVoid(awareness, group),
    });
  }
  return out;
}

/**
 * 首出候选，**从好到差**排好序（DESIGN 1.10）。
 *
 * 机器人取第 0 个、「提示」按这个顺序循环 —— 两边共用同一份判断，
 * 不会出现"机器人会打、提示瞎给"的分叉。档次：
 *
 * 0. **绝张**：没人压得过，先把稳收的收掉；拖拉机 > 对子 > 单张，同级取大。
 * 1. **抽主**（主牌 ≥ 9 张时）：先小对再小单张，把别人的主榨干，
 *    后面的副牌小牌才立得住。
 * 2. **探路牌**：最长副牌花色里最小的一张不带分的牌，输了也不心疼。
 * 3. 其余的一切：重结构优先、同级从小到大。
 *
 * 注意 2 挡在 3 前面，所以"没绝张时不会建议先甩一条压不住的拖拉机"。
 */
export function rankLeads(
  hand: SjCard[], ctx: SjCtx, playedIds: string[], rng?: SjRng, awareness?: SjAwareness,
): SjCard[][] {
  const unseen = unseenCards(hand, playedIds);
  const cands = leadCandidates(hand, ctx);
  if (!cands.length) return [];

  const drawTrump = cardsInGroup(hand, 'T', ctx).length >= 9;

  // 探路牌：最长的副牌花色（并列时用 rng 打散）里最小的一张；全是主牌就退回整手最小的
  const sideGroups = (SJ_SUITS as SjPlainSuit[])
    .map((s) => ({
      group: s as SjGroup,
      cards: cardsInGroup(hand, s, ctx),
      opponentVoids: opponentVoidCount(awareness, s),
      partnerVoid: partnerIsVoid(awareness, s),
    }))
    .filter((g) => g.cards.length > 0);
  let probePool = hand;
  if (sideGroups.length) {
    // 长门优先；对家已缺门是配合机会；对手已缺门则很容易被毙，主动避开。
    const score = (g: typeof sideGroups[number]) => g.cards.length * 4 + (g.partnerVoid ? 2 : 0) - g.opponentVoids * 6;
    const most = Math.max(...sideGroups.map(score));
    const tied = sideGroups.filter((g) => score(g) === most);
    probePool = tied[rng ? Math.min(tied.length - 1, Math.floor(rng() * tied.length)) : 0].cards;
  }
  const probeId = pickFillers(probePool, 1, ctx, 'low')[0]?.id ?? null;

  const ranked = cands.map((c) => {
      const sure = isSureMax(c.unit, c.group, unseen, ctx);
      const opponentVoids = opponentVoidCount(awareness, c.group);
      // 副牌即便是该门最大，对手已缺门时也可能被主牌毙，不再冒充“稳赢”。
      const tier = sure && (c.group === 'T' || opponentVoids === 0) ? 0
        : drawTrump && c.group === 'T' && c.unit.kind !== 'tractor' ? 1
        : c.unit.kind === 'single' && c.unit.cards[0].id === probeId ? 2
        : 3;
      return {
        cards: c.unit.cards,
        tier,
        team: (partnerIsVoid(awareness, c.group) ? -1 : 0) + opponentVoids * 2,
        prio: -unitPriority(c.unit),
        // 绝张同级取大（反正没人压得过，先把大的兑现），其余同级取小（别浪费）
        top: sure ? -c.unit.top : c.unit.top,
      };
    });

  for (const thrown of safeThrowCandidates(hand, ctx, unseen, awareness)) {
    ranked.push({
      cards: thrown.cards,
      // 没有已知缺门对手时，能一次清掉的安全甩牌优先于拆开逐手走。
      tier: thrown.opponentVoids ? 2 : 0,
      team: (thrown.partnerVoid ? -1 : 0) + thrown.opponentVoids * 2,
      prio: -100 - thrown.cards.length,
      top: -maxOrder(thrown.cards, ctx),
    });
  }

  return ranked
    .sort((a, b) => a.tier - b.tier || a.team - b.team || a.prio - b.prio || a.top - b.top)
    .map((s) => s.cards);
}

/**
 * 首出（DESIGN 1.10）：先打自己手里的绝张；否则主牌够多时先"抽主"；
 * 再否则从最长的副牌花色出一张不带分的小牌。就是 `rankLeads` 的头一项。
 */
export function botLead(
  hand: SjCard[], ctx: SjCtx, playedIds: string[], rng?: SjRng, awareness?: SjAwareness,
): SjCard[] {
  return rankLeads(hand, ctx, playedIds, rng, awareness)[0] ?? [];
}

/* --------------------------------------------------------------- 跟牌 */

/**
 * 跟牌候选，**按真实收益从好到差**排好序（DESIGN 1.10）。
 *
 * 机器人取第 0 个、「提示」按这个顺序循环 —— 这就是"同一个脑子"的所在：
 * 排序只写这一份，改了两边一起变，不会再各聪明各的。
 *
 * 先看清这一圈的三件事：桌上有多少分、现在谁最大、那个人是不是我对家，
 * 再分档：
 *
 * - **自己是末家且对家已经赢定** → 垫分给他（分越多越靠前），其次垫最小的牌。
 *   盖过对家排到最后：那一分照样是自家的，但白白烧掉一张大牌，还把对家的位置抢了。
 * - **对家只是暂时领先、后面还有对手** → 不送分，先保住分牌，避免被后手截走。
 * - **对手领先、且这一圈值得抢**（桌上有分，或已到后半程，后面的牌越来越硬）
 *   → **最小能赢的那一手**排第一，拿下就好，别把大牌浪费掉。
 * - **压不过 / 这一圈不值得抢** → 垫最没用的：先不带分（别给对手送分），再最小。
 *   对手甩了张压不过的大牌时走的就是这一档 —— 绝不会把自己的大牌排在前面。
 */
export function rankFollows(
  hand: SjCard[], lead: SjShape, ctx: SjCtx,
  played: { seat: number; cards: SjCard[] }[], mySeat: number, trickNo: number,
): SjCard[][] {
  const pointsOnTable = played.reduce((s, p) => s + sumPoints(p.cards), 0);
  const leaderWins = trickWinner(played, ctx);
  const partnerWinning = (leaderWins.seat % 2) === (mySeat % 2);
  const lastToAct = played.length === 3;

  const pool: SjCard[][] = [];
  const seen = new Set<string>();
  const push = (cards: SjCard[] | null) => {
    if (!cards || cards.length !== lead.count) return;
    if (!validateFollow(hand, lead, cards, ctx).ok) return;
    const key = cards.map((c) => c.id).sort().join(',');
    if (seen.has(key)) return;
    seen.add(key);
    pool.push(cards);
  };
  const inLead = cardsInGroup(hand, lead.group, ctx);
  if (inLead.length === 0) {
    push(composeTrumpBeat(hand, lead, ctx, 'low'));
    push(composeTrumpBeat(hand, lead, ctx, 'high'));
  }
  push(composeFollow(hand, lead, ctx, 'low'));
  push(composeFollow(hand, lead, ctx, 'high'));
  push(composeFollow(hand, lead, ctx, 'points'));
  // 三种 compose 只给得出「最小 / 最大 / 带分」那几手。要真的挑出**最小能赢的**，
  // 就得把所有合法的一手都摆上来 —— 单张和对子这两种（占绝大多数圈）能直接枚举完。
  if (lead.count === 1) for (const c of (inLead.length ? inLead : hand)) push([c]);
  else if (lead.count === 2 && lead.pairs === 1) {
    for (const u of allPairs(hand, lead.group, ctx)) push(u.cards);
    if (!inLead.length) for (const u of allPairs(hand, 'T', ctx)) push(u.cards);
  } else if (lead.units.length === 1 && lead.units[0].kind === 'tractor') {
    const span = lead.units[0].span;
    if (inLead.length >= lead.count) {
      for (const u of allTractors(hand, lead.group, ctx).filter((u) => u.span === span)) push(u.cards);
    } else if (!inLead.length) {
      for (const u of allTractors(hand, 'T', ctx).filter((u) => u.span === span)) push(u.cards);
    }
  }

  const wins = (cards: SjCard[]) =>
    trickWinner([...played, { seat: mySeat, cards }], ctx).seat === mySeat;

  /** 档次 + 档内的两级排序键，全都是"越小越靠前" */
  const score = (cards: SjCard[]): [number, number, number] => {
    const w = wins(cards);
    const pts = sumPoints(cards);
    if (partnerWinning && lastToAct) {
      // 我是末家时胜负已经锁定：分越多越先垫给对家；盖过对家的排最后。
      return w ? [2, handWeight(cards, ctx), 0] : [0, -pts, discardWeight(cards, ctx)];
    }
    if (partnerWinning) {
      // 后面还有人没出，不能把“对家暂时领先”误判成稳赢，更不能提前把分喂上桌。
      return w ? [2, handWeight(cards, ctx), 0] : [1, discardWeight(cards, ctx), 0];
    }
    // 候选本身带分也会让这一圈变得值得抢；旧实现只看桌面已有分，会把自己的 K 垫给对手。
    const worthWinning = pointsOnTable + pts > 0 || trickNo >= 13;
    if (worthWinning && w) return [0, handWeight(cards, ctx), discardWeight(cards, ctx)];
    return [1, discardWeight(cards, ctx), 0];
  };

  return pool
    .map((cards) => ({ cards, key: score(cards) }))
    .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2])
    .map((s) => s.cards);
}

/** 跟牌：`rankFollows` 的头一项。兜底是"最小的一手"，永远给得出一手合法的牌 */
export function botFollow(
  hand: SjCard[], lead: SjShape, ctx: SjCtx,
  played: { seat: number; cards: SjCard[] }[], mySeat: number, trickNo: number,
): SjCard[] {
  return rankFollows(hand, lead, ctx, played, mySeat, trickNo)[0]
    ?? composeFollow(hand, lead, ctx, 'low');
}

/** 一手牌的"重量"，用来在能赢的候选里挑最省的那一手 */
function handWeight(cards: SjCard[], ctx: SjCtx): number {
  return cards.reduce((s, c) => s + cardOrder(c, ctx), 0);
}

/**
 * 垫出去有多可惜：**拆主 > 送分 > 大牌**，和 `pickFillers('low')` 用的是同一把尺子。
 * 压不过的时候按它从小到大排，第一条就是"最没用的那一手"。
 * 注意 `cardOrder` 只在组内可比，所以主牌那 10000 的罚分不能省 —— 主牌的 2 和副牌的 2
 * 编号一样，光看 order 会把主牌当成小牌垫掉。
 */
function discardWeight(cards: SjCard[], ctx: SjCtx): number {
  return cards.reduce((s, c) => s
    + (groupOf(c, ctx) === 'T' ? 10_000 : 0)
    + (pointsOf(c) > 0 ? 1_000 : 0)
    + cardOrder(c, ctx), 0);
}

/* --------------------------------------------------------------- 出牌入口 */

/** 机器人（或超时代打）该出什么。返回一定通过 `validateFollow` 的牌 id */
export function botPlay(state: SjRoomState, me: SjPlayer, rng?: SjRng): string[] {
  const ctx = ctxOf(state);
  if (!state.trick.length) {
    return botLead(me.hand, ctx, state.playedIds, rng, {
      mySeat: me.seat,
      voidGroups: state.voidGroups,
    }).map((c) => c.id);
  }

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
 *
 * **排序完全交给 `rankLeads` / `rankFollows`** —— 也就是机器人自己在用的那套判断，
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
    for (const cards of rankLeads(hand, ctx, view.playedIds, undefined, view)) add(cards);
    return out;
  }

  const played = view.trick.map((p) => ({ seat: p.seat, cards: p.cardIds.map(cardFromId) }));
  const lead = parseShape(played[0].cards, ctx);
  if (!lead) return out;
  for (const cards of rankFollows(hand, lead, ctx, played, view.mySeat, view.trickNo)) add(cards);
  return out;
}
