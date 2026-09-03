/**
 * **分值 → 效用**（BRAIN-DESIGN §4）。
 *
 * 这一层只干两件事：
 *
 * 1. **边际价值 m 与阵营符号 sign**（§4.1）——「现在这一分值多少」。
 *    升级的账不是线性的：闲家 75 分时的 5 分能翻一档，105 分时的 5 分几乎白拿。
 *    所以 EV 的量纲是"期望闲家分变化"，最后统一乘 m；庄家方乘 −1。
 *    **80 分反转、通关局加权全部从 m/sign 里长出来**，没有任何"过 80 就随便打"的硬编码。
 * 2. 把各种**代价**折算成同一个量纲（§4.2）：花主、花绝张、拆结构、垫牌造缺门、送分风险……
 */

import { cardOrder, groupOf, pointsOf, sumPoints, type SjCard, type SjGroup } from '../cards.ts';
import { cardsInGroup, maxOrder, runsOf } from '../units.ts';
import { THRESHOLDS, type BrainView } from './view.ts';

/** 闲家对剩余分的估计占比：主牌控制越强，能收到的分越多 */
export function defenderShare(v: BrainView): number {
  const mine = v.trumps.mine;
  const partnerEst = v.trumps.partnerMayHold ? v.trumps.perHolder : 0;
  const oppsEst = v.opps.reduce((s, o) => s + (v.isVoid(o, 'T') ? 0 : v.trumps.perHolder), 0);
  const edge = (mine + partnerEst - oppsEst) / 3 * 0.05;
  const myShare = Math.min(0.8, Math.max(0.2, 0.5 + edge));
  return v.iAmDealerTeam ? 1 - myShare : myShare;
}

/** 预计最终的闲家得分 */
export function projectedScore(v: BrainView): number {
  const remaining = v.pointsOnTable + v.unseenPoints + sumPoints(v.hand);
  return v.defenderPoints + remaining * defenderShare(v);
}

/**
 * 已经越过的门槛按 1.6 倍距离算。
 *
 * BRAIN-DESIGN §4.1 写的是「到最近门槛的距离」，但那样 s=85 和 s=115 会得到一模一样的 m，
 * 而 §9.J5 要求 s=115 更值得拼——闲家分只增不减，**没拿到的门槛**才是要奔的目标，
 * 已经过掉的那道只剩"别掉回去"的保值意义，权重理应低一档。拉长已过门槛的距离就够了，
 * 不用再加一堆分支。
 */
const PASSED_STRETCH = 1.6;

/** 边际价值 m = 1 + 2·exp(−(d/12)²)，d 是到最近门槛的距离；通关局的 80 那道门槛再 ×1.5 */
export function marginalValue(v: BrainView): number {
  const s = projectedScore(v);
  let best = Infinity;
  let nearest = 0;
  for (const t of THRESHOLDS) {
    const d = s >= t ? (s - t) * PASSED_STRETCH : t - s;
    if (d < best) { best = d; nearest = t; }
  }
  const m = 1 + 2 * Math.exp(-((best / 12) ** 2));
  return v.matchPoint && nearest === 80 ? m * 1.5 : m;
}

/** 闲家方 +1、庄家方 −1 */
export function sideSign(v: BrainView): number {
  return v.iAmDealerTeam ? -1 : 1;
}

/* --------------------------------------------------------------- 各项代价 */

/** 赢下这一圈之后由我首出的价值：手里有几手"安全的首出" */
export function tempoValue(v: BrainView, hasCloser: boolean): number {
  let safe = 0;
  for (const g of ['S', 'H', 'C', 'D'] as SjGroup[]) {
    const gi = v.groups[g];
    if (!gi.mine.length) continue;
    // 绝张能兑现，或对家缺这门（可以喂毙）
    if (gi.sureMax({ kind: 'single', span: 1, top: maxOrder(gi.mine, v.ctx), cards: [] })) safe++;
    else if (v.isVoid(v.partner, g) && !v.opps.every((o) => v.isVoid(o, g))) safe++;
  }
  let t = Math.min(4, safe * 1.5);
  if (v.endgame && hasCloser) t += 2;
  return t;
}

/** 花掉主牌的未来代价。`topPlanValue` 是顶张主在抠底计划里的价值 */
export function trumpSpend(v: BrainView, cards: SjCard[], topPlanValue: number): number {
  let cost = 0;
  const myTop = v.groups.T.mine.length ? maxOrder(v.groups.T.mine, v.ctx) : -1;
  for (const c of cards) {
    if (groupOf(c, v.ctx) !== 'T') continue;
    cost += cardOrder(c, v.ctx) === myTop && myTop >= 0
      ? (topPlanValue > 0 ? topPlanValue : 3)
      : 1.5;
  }
  return cost;
}

/** 花掉副牌绝张的代价：这门场外还有多少分要靠它来收 */
export function winnerSpend(v: BrainView, cards: SjCard[]): number {
  let cost = 0;
  for (const g of ['S', 'H', 'C', 'D'] as SjGroup[]) {
    const gi = v.groups[g];
    const used = cardsInGroup(cards, g, v.ctx);
    if (!used.length) continue;
    const top = maxOrder(used, v.ctx);
    if (gi.unseenTop > top) continue;                       // 本来就不是绝张，不算"花掉"
    cost += Math.max(2, gi.unseenPoints / (gi.holders.length + 1));
  }
  return cost;
}

/** 拆对子 1、拆拖拉机 3（拖拉机是抠底倍数的本钱） */
export function structureBreak(v: BrainView, cards: SjCard[]): number {
  let cost = 0;
  const ids = new Set(cards.map((c) => c.id));
  for (const g of ['T', 'S', 'H', 'C', 'D'] as SjGroup[]) {
    const mine = v.groups[g].mine;
    const used = cardsInGroup(cards, g, v.ctx);
    if (!used.length) continue;
    const before = runsOf(mine, v.ctx);
    const after = runsOf(mine.filter((c) => !ids.has(c.id)), v.ctx);
    const usedRuns = runsOf(used, v.ctx);
    const pairsBefore = before.reduce((a, r) => a + r.len, 0);
    const pairsAfter = after.reduce((a, r) => a + r.len, 0);
    const pairsPlayed = usedRuns.reduce((a, r) => a + r.len, 0);
    const broken = Math.max(0, pairsBefore - pairsAfter - pairsPlayed);
    cost += broken * 1;
    const longBefore = before.reduce((a, r) => Math.max(a, r.len), 0);
    const longAfter = after.reduce((a, r) => Math.max(a, r.len), 0);
    const longPlayed = usedRuns.reduce((a, r) => Math.max(a, r.len), 0);
    if (longBefore >= 2 && longAfter < longBefore && longPlayed < longBefore) cost += 3;
  }
  return cost;
}

/** 垫牌造缺门：垫完这门剩 0 张 +2、剩 1 张 +1（前提我还有主可以毙） */
export function voidGain(v: BrainView, cards: SjCard[]): number {
  if (v.trumps.mine === 0) return 0;
  let gain = 0;
  for (const g of ['S', 'H', 'C', 'D'] as SjGroup[]) {
    const used = cardsInGroup(cards, g, v.ctx);
    if (!used.length) continue;
    const left = v.groups[g].mine.length - used.length;
    if (left === 0) gain += 2;
    else if (left === 1) gain += 1;
  }
  return gain;
}

/** 探路：长门的小单张，输了不心疼 */
export function probeValue(v: BrainView, cards: SjCard[]): number {
  if (cards.length !== 1) return 0;
  const c = cards[0];
  const g = groupOf(c, v.ctx);
  if (g === 'T' || pointsOf(c) > 0) return 0;
  const gi = v.groups[g];
  if (gi.unseenTop <= cardOrder(c, v.ctx)) return 0;         // 绝张就不叫探路了
  // 探路优先从**短门**出：输了不心疼，赢了白赚，剩下的还能造缺门去毙（D6 / D7）
  let val = 0.5 + (v.trumps.mine >= 2 ? 0.15 : 0.05) * Math.max(0, 4 - gi.mine.length);
  // 对家亮过 / 被反掉的花色是他长的门，优先探；对手亮过的门躲开
  if (v.declaredSuits[v.partner] === g) val += 0.6;
  if (v.opps.some((o) => v.declaredSuits[o] === g)) val -= 0.8;
  if (gi.ledTimes > 0 && !v.isVoid(v.partner, g)) val += 0.4;  // 回对家想要的门
  return val;
}

/** 带分出去而我方不稳赢 */
export function giftRisk(cards: SjCard[], pTeamWin: number): number {
  return sumPoints(cards) * (1 - pTeamWin);
}

export { sumPoints, pointsOf };
