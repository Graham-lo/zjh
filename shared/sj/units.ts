/**
 * 把一组牌解析成升级的牌型结构：单张 / 对子 / 拖拉机 / 甩牌（DESIGN 1.5）。
 *
 * 这里只做「这堆牌长什么样」，不判断合不合法 —— 合法性在 rules.ts。
 * 拆出来是因为跟牌校验、定圈、甩牌校验、机器人枚举候选都要用同一套结构，
 * 各写一份必然会在拖拉机的边界上打架。
 */

import { cardOrder, groupOf, isSameCard, type SjCard, type SjCtx, type SjGroup } from './cards.ts';

export type SjUnitKind = 'single' | 'pair' | 'tractor';

export interface SjUnit {
  kind: SjUnitKind;
  /** 连对数：拖拉机是 ≥2，单张和对子都是 1 */
  span: number;
  /** 最高牌在链上的位置（cardOrder），比大小只看它 */
  top: number;
  cards: SjCard[];
}

export interface SjShape {
  group: SjGroup;
  /** 已排好优先级：拖拉机（长→短）→ 对子 → 单张 */
  units: SjUnit[];
  count: number;
  /** 各条拖拉机的连对数，降序 */
  tractors: number[];
  /** 独立对子数（不含拖拉机里的） */
  pairs: number;
  singles: number;
  /** 多于一个单位就是甩牌（DESIGN 1.5） */
  isThrow: boolean;
}

/** 一个花色组里，由对子连成的一条「连对链」 */
export interface SjRun {
  /** 连对数 */
  len: number;
  /** 链上最高的那一档 */
  top: number;
  /** 从低到高的每一对 */
  pairs: SjCard[][];
}

/**
 * 单位的比较优先级：**最长拖拉机 > 对子 > 单张**（DESIGN 1.7）。
 * 甩牌比大小时取优先级最高的那个单位，所以这个次序既是排序键也是"主单位"的定义。
 */
export function unitPriority(u: SjUnit): number {
  // span 已经区分了拖拉机；对子和单张 span 都是 1，再用 kind 分开
  return u.span * 2 + (u.kind === 'single' ? 0 : 1);
}

/** 甩牌里用来比大小的那个单位：优先级最高的，同优先级取最大的一张 */
export function primaryUnit(shape: SjShape): SjUnit {
  let best = shape.units[0];
  for (const u of shape.units) {
    const d = unitPriority(u) - unitPriority(best);
    if (d > 0 || (d === 0 && u.top > best.top)) best = u;
  }
  return best;
}

/* --------------------------------------------------------------- 连对链 */

/**
 * 把一堆**同组**的牌里的对子连成链。
 *
 * 关键在「同一档位上可能有多个对子」：三色副级牌都在 ORDER_OFF_LEVEL 那一档，
 * 它们互相**相等而不相邻**，所以一条链在每一档只能吃一个对子，多出来的那些
 * 各自成为长度 1 的链（也就是普通对子）。这正是规范里
 * 「三张不同花色的副级牌互相相等，不相邻，不能连成拖拉机」的直接后果。
 */
export function runsOf(cards: SjCard[], ctx: SjCtx): SjRun[] {
  // 先按「完全相同的牌」分桶，两张一对
  const buckets = new Map<string, SjCard[]>();
  for (const c of cards) {
    const key = `${c.suit}${c.rank}`;
    const list = buckets.get(key);
    if (list) list.push(c);
    else buckets.set(key, [c]);
  }
  /** order → 这一档上的所有对子 */
  const byOrder = new Map<number, SjCard[][]>();
  for (const list of buckets.values()) {
    for (let i = 0; i + 1 < list.length; i += 2) {
      const order = cardOrder(list[i], ctx);
      const slot = byOrder.get(order);
      if (slot) slot.push([list[i], list[i + 1]]);
      else byOrder.set(order, [[list[i], list[i + 1]]]);
    }
  }

  const orders = [...byOrder.keys()].sort((a, b) => a - b);
  const runs: SjRun[] = [];
  let current: SjRun | null = null;
  let prev = Number.NaN;
  for (const order of orders) {
    const slot = byOrder.get(order)!;
    // 每档只有一个对子能续在链上；同档的其余对子只能单独成对
    if (current && order === prev + 1) {
      current.len += 1;
      current.top = order;
      current.pairs.push(slot[0]);
    } else {
      current = { len: 1, top: order, pairs: [slot[0]] };
      runs.push(current);
    }
    for (const extra of slot.slice(1)) runs.push({ len: 1, top: order, pairs: [extra] });
    prev = order;
  }
  return runs;
}

/** 把一条链切成一个单位：len ≥ 2 是拖拉机，否则是对子 */
function runToUnit(run: SjRun): SjUnit {
  const cards = run.pairs.flat();
  return run.len >= 2
    ? { kind: 'tractor', span: run.len, top: run.top, cards }
    : { kind: 'pair', span: 1, top: run.top, cards };
}

/* --------------------------------------------------------------- 结构解析 */

/**
 * 把一手牌解析成结构。**跨花色组返回 null** —— 那不是一个合法牌型，
 * 只可能是跟牌时的垫牌，调用方自己知道怎么处理。
 */
export function parseShape(cards: SjCard[], ctx: SjCtx): SjShape | null {
  if (!cards.length) return null;
  const group = groupOf(cards[0], ctx);
  for (const c of cards) if (groupOf(c, ctx) !== group) return null;

  const runs = runsOf(cards, ctx);
  const usedPairs = new Set<string>();
  for (const run of runs) for (const pair of run.pairs) for (const c of pair) usedPairs.add(c.id);
  const singles: SjUnit[] = cards
    .filter((c) => !usedPairs.has(c.id))
    .map((c) => ({ kind: 'single', span: 1, top: cardOrder(c, ctx), cards: [c] }));

  const units = runs.map(runToUnit).concat(singles);
  units.sort((a, b) => unitPriority(b) - unitPriority(a) || b.top - a.top);

  const tractors = units.filter((u) => u.kind === 'tractor').map((u) => u.span).sort((a, b) => b - a);
  return {
    group,
    units,
    count: cards.length,
    tractors,
    pairs: units.filter((u) => u.kind === 'pair').length,
    singles: singles.length,
    isThrow: units.length > 1,
  };
}

/** 结构是否完全一致（拖拉机长度列表、对子数、单张数都相同）。定圈的前提（DESIGN 1.7） */
export function shapeEquals(a: SjShape, b: SjShape): boolean {
  if (a.count !== b.count || a.pairs !== b.pairs || a.singles !== b.singles) return false;
  if (a.tractors.length !== b.tractors.length) return false;
  return a.tractors.every((n, i) => n === b.tractors[i]);
}

/* ------------------------------------------------- 从手牌里枚举某一组的单位 */

export function cardsInGroup(cards: SjCard[], group: SjGroup, ctx: SjCtx): SjCard[] {
  return cards.filter((c) => groupOf(c, ctx) === group);
}

/** 某一组里所有的对子 */
export function allPairs(hand: SjCard[], group: SjGroup, ctx: SjCtx): SjUnit[] {
  const runs = runsOf(cardsInGroup(hand, group, ctx), ctx);
  const out: SjUnit[] = [];
  for (const run of runs) {
    for (let i = 0; i < run.len; i++) {
      const pair = run.pairs[i];
      out.push({ kind: 'pair', span: 1, top: cardOrder(pair[0], ctx), cards: pair });
    }
  }
  return out.sort((a, b) => a.top - b.top);
}

/**
 * 某一组里所有的拖拉机，**含长链上的每一段子链**。
 *
 * 三连对里既有那条三连，也有两条二连 —— 跟牌时"拆长的去配短的"是规范要求的
 * （DESIGN 1.6 a：同长度或更长拆出），提示按钮也要能给出这些选项。
 * 链长最多十几，段数是 O(len²)，量级完全够用。
 */
export function allTractors(hand: SjCard[], group: SjGroup, ctx: SjCtx): SjUnit[] {
  const out: SjUnit[] = [];
  for (const run of runsOf(cardsInGroup(hand, group, ctx), ctx)) {
    for (let len = 2; len <= run.len; len++) {
      for (let start = 0; start + len <= run.len; start++) {
        const pairs = run.pairs.slice(start, start + len);
        out.push({
          kind: 'tractor',
          span: len,
          top: cardOrder(pairs[len - 1][0], ctx),
          cards: pairs.flat(),
        });
      }
    }
  }
  return out.sort((a, b) => a.span - b.span || a.top - b.top);
}

/** 某一组里所有单张（每张牌本身都能当单张出） */
export function allSingles(hand: SjCard[], group: SjGroup, ctx: SjCtx): SjUnit[] {
  return cardsInGroup(hand, group, ctx)
    .map((c) => ({ kind: 'single' as const, span: 1, top: cardOrder(c, ctx), cards: [c] }))
    .sort((a, b) => a.top - b.top);
}

/** 一组牌里最大的那一档（没有牌时返回 -1） */
export function maxOrder(cards: SjCard[], ctx: SjCtx): number {
  let best = -1;
  for (const c of cards) best = Math.max(best, cardOrder(c, ctx));
  return best;
}
