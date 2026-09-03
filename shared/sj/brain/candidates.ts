/**
 * **候选生成**（BRAIN-DESIGN §6.1 / §6.2 的"候选"部分）。
 *
 * 只负责把"我这一手**可以**怎么出"列全、去重、贴上结构标签；
 * 好不好由 `evaluate.ts` 打分。生成和评估分开，是为了让"漏了一种打法"和
 * "评估评歪了"这两类毛病能分别定位。
 */

import {
  cardOrder, groupOf, pointsOf,
  type SjCard, type SjCtx, type SjGroup,
} from '../cards.ts';
import {
  allPairs, allSingles, allTractors, cardsInGroup, maxOrder, parseShape, runsOf,
  type SjShape, type SjUnit,
} from '../units.ts';
import { followRequirement } from '../rules.ts';
import { ALL_GROUPS, SIDE_GROUPS, type BrainView } from './view.ts';

export type Prefer = 'low' | 'high' | 'points';

/** 一个候选：出哪些牌 + 它是怎么来的（`why` 会一路带到提示面板和测试断言里） */
export interface SjCandidate {
  cards: SjCard[];
  tag: string;
  why: string[];
}

export function without(pool: SjCard[], used: SjCard[]): SjCard[] {
  const ids = new Set(used.map((c) => c.id));
  return pool.filter((c) => !ids.has(c.id));
}

/** 按偏好挑 k 张"随便填"的牌 */
export function pickFillers(pool: SjCard[], k: number, ctx: SjCtx, prefer: Prefer): SjCard[] {
  const key = (c: SjCard) => {
    const order = cardOrder(c, ctx);
    const trump = groupOf(c, ctx) === 'T' ? 1 : 0;
    if (prefer === 'high') return -order;
    if (prefer === 'points') return pointsOf(c) > 0 ? -pointsOf(c) * 100 + order : 1_000 + order;
    return trump * 10_000 + (pointsOf(c) > 0 ? 1_000 : 0) + order;
  };
  return pool.slice().sort((a, b) => key(a) - key(b) || (a.id < b.id ? -1 : 1)).slice(0, k);
}

export function pickUnit(list: SjUnit[], prefer: Prefer): SjUnit | null {
  if (!list.length) return null;
  return prefer === 'high' ? list[list.length - 1] : list[0];
}

/** 按 DESIGN 1.6 组一手**合法**的跟牌（照 `followRequirement` 的最低要求填） */
export function composeFollow(hand: SjCard[], lead: SjShape, ctx: SjCtx, prefer: Prefer): SjCard[] {
  const n = lead.count;
  let pool = cardsInGroup(hand, lead.group, ctx);
  const chosen: SjCard[] = [];

  if (pool.length < n) {
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

/** 缺门时用主牌**毙**：与首出同构的保守解 */
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

const keyOf = (cards: SjCard[]) => cards.map((c) => c.id).slice().sort().join(',');

class CandSet {
  private seen = new Set<string>();
  readonly list: SjCandidate[] = [];
  add(cards: SjCard[] | null | undefined, tag: string, why: string[]): void {
    if (!cards || !cards.length) return;
    const k = keyOf(cards);
    if (this.seen.has(k)) return;
    this.seen.add(k);
    this.list.push({ cards: cards.slice(), tag, why: why.slice() });
  }
}

/* ------------------------------------------------------------------ 首出 */

/**
 * 首出候选：每门的全部单张 / 对子 / 拖拉机，加上**可证明的**甩牌（§6.4）。
 *
 * 甩牌只提两种：每个单位对场外都是绝张；或三家都已公开缺这门。
 * 存疑的甩牌根本不生成 —— 罚 10 分还被迫出小，值不回来。
 */
export function leadCandidates(v: BrainView): SjCandidate[] {
  const set = new CandSet();
  for (const g of ALL_GROUPS) {
    const mine = v.groups[g].mine;
    if (!mine.length) continue;
    const label = g === 'T' ? '主' : g;
    for (const u of allTractors(v.hand, g, v.ctx)) {
      set.add(u.cards, `lead:tractor:${g}`, [`${label} ${u.span} 连对`]);
    }
    for (const u of allPairs(v.hand, g, v.ctx)) {
      set.add(u.cards, `lead:pair:${g}`, [`${label}对子`]);
    }
    for (const u of allSingles(v.hand, g, v.ctx)) {
      set.add(u.cards, `lead:single:${g}`, [`${label}单张`]);
    }
    // 甩牌
    const shape = parseShape(mine, v.ctx);
    if (shape?.isThrow) {
      const everyoneVoid = [v.partner, ...v.opps].every((s) => v.isVoid(s, g));
      const units = everyoneVoid ? shape.units : shape.units.filter((u) => v.groups[g].sureMax(u));
      if (units.length >= 2) {
        const cards = units.flatMap((u) => u.cards);
        set.add(cards, `lead:throw:${g}`, [
          everyoneVoid ? `三家都缺${label}，整门甩` : `${label}的每个单位都是绝张，甩牌`,
        ]);
      }
      // 存疑的甩牌也放进候选，交给 `throwRisk` 去否决 —— 别在这里写死"不许甩"：
      // 最后一圈底分翻倍的时候，赌一把是真人会做的选择（M8 的双倍风险也才有地方生效）。
      if (!everyoneVoid && shape.units.length >= 2 && shape.units.length !== units.length) {
        set.add(mine, `lead:throw-risky:${g}`, [`${label}整门甩（有被管的风险）`]);
      }
    }
  }
  return set.list;
}

/* ------------------------------------------------------------------ 跟牌 */

/**
 * 跟牌候选（§6.2）：最小 / 最大 / 带分三条基线，缺门时再加毙牌与各种垫法。
 * 全部经过 `composeFollow` / `composeTrumpBeat` 构造，天然通过 `validateFollow`。
 */
export function followCandidates(v: BrainView, lead: SjShape): SjCandidate[] {
  const set = new CandSet();
  const hand = v.hand;
  const ctx = v.ctx;
  const inGroup = cardsInGroup(hand, lead.group, ctx);
  const canFollow = inGroup.length >= lead.count;

  set.add(composeFollow(hand, lead, ctx, 'low'), 'follow:low', ['跟最小']);
  set.add(composeFollow(hand, lead, ctx, 'high'), 'follow:high', ['跟最大']);
  set.add(composeFollow(hand, lead, ctx, 'points'), 'follow:points', ['把分垫出去']);

  if (canFollow) {
    // 同门里能盖过首出的那些取法：最小能赢 / 最大
    const top = lead.units[0]?.top ?? maxOrder(v.trick.leadCards, ctx);
    if (lead.count === 1) {
      for (const u of allSingles(hand, lead.group, ctx)) {
        if (u.top > top) { set.add(u.cards, 'follow:beat', ['同门最小能赢']); break; }
      }
    } else if (lead.pairs === 1 && !lead.tractors.length && lead.singles === 0) {
      for (const u of allPairs(hand, lead.group, ctx)) {
        if (u.top > top) { set.add(u.cards, 'follow:beat', ['对子最小能赢']); break; }
      }
    }
  } else {
    set.add(composeTrumpBeat(hand, lead, ctx, 'low'), 'follow:ruff', ['最小能毙']);
    set.add(composeTrumpBeat(hand, lead, ctx, 'high'), 'follow:ruff:high', ['大主毙']);
    // 垫牌：每门最小不带分 / 最大分牌
    const rest = hand.filter((c) => groupOf(c, ctx) !== lead.group);
    const need = lead.count - inGroup.length;
    for (const g of SIDE_GROUPS) {
      const pool = cardsInGroup(rest, g, ctx);
      if (pool.length < need) continue;
      set.add([...inGroup, ...pickFillers(pool, need, ctx, 'low')], `follow:discard:${g}`,
        [`垫 ${g} 最小`]);
      const pts = pool.filter((c) => pointsOf(c) > 0);
      if (pts.length >= need) {
        set.add([...inGroup, ...pickFillers(pool, need, ctx, 'points')], `follow:gift:${g}`,
          [`把 ${g} 的分垫给对家`]);
      }
    }
  }
  return set.list;
}

export { runsOf, parseShape };
