/**
 * **扣底与抠底计划**（BRAIN-DESIGN §5.3 / §6.3）。
 *
 * 两件事在一个文件里，因为它们是同一笔账：底里埋了多少分，
 * 决定了最后一圈值多少（`digValue = 底分 × 倍数`），
 * 而"最后一圈我方能不能赢"又决定了扣底时该不该往底里埋分。
 *
 * `closer` = 我手里**对场外是绝张的主牌单位**里倍数最高的那个（拖拉机 > 对子 > 单张）。
 * 它是整个尾局的锚：任何动用 closer 成员的候选都会被 `digPlan` 打成负分，
 * "尾局留大主"因此是算出来的，不是写死的。
 */

import {
  cardOrder, groupOf, pointsOf, sumPoints,
  type SjCard, type SjCtx, type SjGroup, type SjTrumpSuit,
} from '../cards.ts';
import { allPairs, allSingles, allTractors, cardsInGroup, maxOrder, runsOf, type SjUnit } from '../units.ts';
import { digMultiplier } from '../rules.ts';
import { BOTTOM_SIZE, type BrainView } from './view.ts';

export interface SjCloser {
  unit: SjUnit;
  /** 用它首出最后一圈能拿到的倍数 */
  multiplier: number;
  /** 是不是"抽干主之后才成立"的准 closer */
  tentative: boolean;
}

/** 我手里倍数最高的主牌绝张单位；没有就看"准 closer"（§6.3） */
export function findCloser(v: BrainView): SjCloser | null {
  const t = v.groups.T;
  if (!t.mine.length) return null;
  const cands: SjUnit[] = [
    ...allTractors(v.hand, 'T', v.ctx),
    ...allPairs(v.hand, 'T', v.ctx),
    ...allSingles(v.hand, 'T', v.ctx),
  ];
  let best: SjCloser | null = null;
  for (const u of cands) {
    if (!t.sureMax(u)) continue;
    const mult = digMultiplier(1 + (u.kind === 'tractor' ? u.span : u.kind === 'pair' ? 1 : 0));
    if (!best || mult > best.multiplier || (mult === best.multiplier && u.top > best.unit.top)) {
      best = { unit: u, multiplier: mult, tentative: false };
    }
  }
  if (best) return best;
  // 准 closer：场外比我大的主已经不多，抽一轮主就成
  const oppTrumps = v.opps.reduce((s, o) => s + (v.isVoid(o, 'T') ? 0 : v.trumps.perHolder), 0);
  if (v.trumps.topUnseen.length > 0 && v.trumps.topUnseen.length <= oppTrumps / 3) {
    const pool = [...allPairs(v.hand, 'T', v.ctx), ...allSingles(v.hand, 'T', v.ctx)];
    const top = pool[pool.length - 1];
    if (top) {
      return {
        unit: top,
        multiplier: digMultiplier(1 + (top.kind === 'pair' ? 1 : 0)),
        tentative: true,
      };
    }
  }
  return null;
}

/** 底牌这一笔账值多少分（`bottomPts × closer 的倍数`） */
export function digValue(v: BrainView, closer: SjCloser | null): number {
  if (!closer) return 0;
  const pts = v.bottomPointsExact ?? v.bottomPointsExpected;
  return pts * closer.multiplier * (closer.tentative ? 0.6 : 1);
}

/** 最后一圈还能靠 closer 赢的把握 */
export function closerConfidence(v: BrainView, closer: SjCloser | null): number {
  if (!closer) return 0;
  if (closer.tentative) return 0.5;
  const oppsHaveTrump = v.opps.some((o) => !v.isVoid(o, 'T'));
  return oppsHaveTrump ? 0.8 : 0.95;
}

/**
 * 这个候选对最后一圈的影响（§6.3）。量纲和 EV 的其它项一致：**对我方的好处**。
 * 动用 closer 成员 → 负；最后一圈用 closer 首出 → 正（那正是它的用途）。
 */
export function digPlan(v: BrainView, cards: SjCard[], closer: SjCloser | null): number {
  if (!closer) return 0;
  const ids = new Set(closer.unit.cards.map((c) => c.id));
  const usesCloser = cards.some((c) => ids.has(c.id));
  if (!usesCloser) return 0;
  if (v.isLastTrick(cards.length) && v.trick.position === 0) {
    return digValue(v, closer);                    // 就是这一手，兑现
  }
  return -digValue(v, closer) * closerConfidence(v, closer);
}

/* ------------------------------------------------------------------ 扣底 */

export interface KouInput {
  ctx: SjCtx;
  trump: SjTrumpSuit | null;
  /** 我亮出的明牌 id（扣进底里等于把底告诉全场） */
  declaredIds: readonly string[];
  /** 我是不是闲家方（闲家方抄成底之后可以故意埋分） */
  defenderSide: boolean;
  /** 上一个亮主者的花色 —— 抄底之后优先扣光它，造缺门毙他的长门（§5.1 / B6） */
  rivalLongSuit?: SjGroup | null;
  /** 我方最后一圈的把握（闲家方埋分的前提 ≥ 0.8） */
  closerConfidence?: number;
  /** 场外这门还剩几张（判准绝张）。缺省用整副牌推 */
  unseenIn?: Partial<Record<SjGroup, number>>;
}

/**
 * 33 选 8（§5.3）：给每张牌打分，扣分数最低的 8 张。
 *
 * 写成一把尺子而不是一串 if —— 33 选 8 的边角情况太多（全是分牌、全是主牌），
 * 排序取前 8 永远给得出 8 张，不会卡住。
 */
export function scoreForBury(card: SjCard, hand: SjCard[], input: KouInput): number {
  const ctx = input.ctx;
  const g = groupOf(card, ctx);
  const groupCards = cardsInGroup(hand, g, ctx);
  const n = groupCards.length;
  const nt = input.trump === 'NT';

  const paired = new Set<string>();
  const tractored = new Set<string>();
  for (const run of runsOf(groupCards, ctx)) {
    for (const pair of run.pairs) for (const c of pair) paired.add(c.id);
    if (run.len >= 2) for (const pair of run.pairs) for (const c of pair) tractored.add(c.id);
  }

  let s = cardOrder(card, ctx) * 0.5;

  if (g === 'T') {
    // 主 ≥ 15 张时，最小的两张主允许扣
    const trumps = groupCards.slice().sort((a, b) => cardOrder(a, ctx) - cardOrder(b, ctx));
    const isSmallestTwo = trumps.slice(0, 2).some((c) => c.id === card.id);
    return s + (groupCards.length >= 15 && isSmallestTwo ? 600 : 10_000);
  }

  const pts = pointsOf(card);
  const buryPoints = input.defenderSide && (input.closerConfidence ?? 0) >= 0.8;
  if (pts === 10) s += buryPoints ? -800 : 3_000;
  else if (pts === 5) s += buryPoints ? -400 : 1_500;

  if (tractored.has(card.id)) s += 900;
  else if (paired.has(card.id)) s += 500;

  if (card.rank === 14) s += nt ? 800 : 400;
  else if (card.rank === 13 && nt) s += 200;
  const unseenIn = input.unseenIn?.[g];
  if (unseenIn != null && unseenIn <= 3 && card.rank >= 12) s += 300;

  if (n <= 2) s -= 300;
  else if (n === 3 && !groupCards.some((c) => c.rank === 14) && !groupCards.some((c) => paired.has(c.id))) s -= 120;
  s += n * 20;

  if (input.rivalLongSuit && g === input.rivalLongSuit) s -= 250;
  if (input.declaredIds.includes(card.id)) s += 800;
  return s;
}

/** 扣底：返回要埋的 8 张 */
export function chooseBottom(hand: SjCard[], input: KouInput): SjCard[] {
  return hand.slice()
    .sort((a, b) => scoreForBury(a, hand, input) - scoreForBury(b, hand, input)
      || (a.id < b.id ? -1 : 1))
    .slice(0, BOTTOM_SIZE);
}

export { sumPoints, maxOrder };
