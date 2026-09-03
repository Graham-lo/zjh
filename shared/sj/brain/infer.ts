/**
 * **持牌推断**（BRAIN-DESIGN §3）。
 *
 * 不做精确概率分布，用"人脑级"近似：便宜、方向正确，每步远低于 20ms。
 *
 * - `pBeat`：某家能不能用**同门更大的结构**盖过我这一手。
 * - `pTrump`：某家会不会把这一圈**毙掉**（先缺门、再有足够结构的主）。
 * - `secureWin`：我出这一手之后，后面每个对手都盖不动 —— 垫分这种要绝对把握的动作看它。
 * - `pTeamWin`：把对家也算进来，我方收下这一圈的概率。
 *
 * 全部只读 `BrainView`（公开信息），天然满足防偷看。
 * **同牌先出者大**：一切"更大"都取严格更大，所以我出 A 时场外另一张 A 盖不过我。
 */

import { cardOrder, type SjCard, type SjGroup } from '../cards.ts';
import { maxOrder, parseShape, type SjShape } from '../units.ts';
import { trickWinner } from '../rules.ts';
import { countCovers, coverTop, type BrainView } from './view.ts';

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** 估 `seat` 手里这门还剩几张 */
export function estCount(v: BrainView, seat: number, g: SjGroup): number {
  if (v.isVoid(seat, g)) return 0;
  const holders = v.groups[g].holders.length;
  return holders > 0 ? v.groups[g].unseenCount / holders : 0;
}

/** `seat` 缺这门的概率（§3：公开缺门 = 1，否则按估计张数分档） */
export function pVoid(v: BrainView, seat: number, g: SjGroup): number {
  if (v.isVoid(seat, g)) return 1;
  if (v.groups[g].unseenCount === 0) return 1;
  const n = estCount(v, seat, g);
  if (n < 1) return 0.6;
  if (n <= 2) return 0.2;
  return 0.05;
}

/**
 * `seat` 用同门牌盖过 `top` 的概率。
 *
 * k = 场外这门里能盖过 `top` 的**同类单位**数。每个单位独立地落在某一家手上，
 * 单张落在 `seat` 手里的概率是 `holderOdds`（底牌也占份额），对子要两张都落在他手上，
 * 拖拉机要整串都落在他手上 —— 所以
 * `P(至少有一个单位在他手里) = 1 − (1 − q^单位张数)^k`。
 *
 * 早先这里写的是 `k / holders`：场外还剩三个能盖的对子时它就直接给 1.0，
 * 于是机器人会觉得"对家一定救得回来"而不敢自己收圈。单位越大越难凑齐，这一点必须算进去。
 */
export function pBeat(v: BrainView, seat: number, lead: SjShape, top: number): number {
  const g = lead.group;
  if (v.isVoid(seat, g)) return 0;
  const needsPair = lead.pairs > 0 || lead.tractors.length > 0;
  if (needsPair && v.noPairIn(seat, g)) return 0;           // 他这门已经没有对子了（§3 / M2）
  const k = countCovers(v.groups[g].unseen, lead, v.ctx, top);
  if (k <= 0) return 0;
  const size = lead.tractors.length
    ? 2 * Math.max(...lead.tractors)
    : lead.pairs > 0 ? 2 : 1;
  const q = v.holderOdds(seat, g) || 1 / (v.groups[g].holders.length || 1);
  const per = clamp01(q ** size);
  return clamp01(1 - (1 - per) ** k);
}

/** `seat` 把这一圈毙掉的概率 = P(缺这门) × P(手里有足够结构的主) */
export function pTrump(v: BrainView, seat: number, lead: SjShape): number {
  if (lead.group === 'T') return 0;
  const pv = pVoid(v, seat, lead.group);
  if (pv <= 0) return 0;
  if (v.isVoid(seat, 'T')) return 0;
  const n = v.trumps.perHolder;
  let pt: number;
  if (lead.tractors.length) pt = n >= 2 ? 0.5 * 0.3 : 0;
  else if (lead.pairs > 0) pt = n >= 2 ? 0.5 : 0;
  else pt = n >= 1 ? 1 : n;
  return clamp01(pv * pt);
}

/** 这一手打出去之后、我之后的每个**对手**都盖不动的把握 */
export function secureWin(v: BrainView, myCards: SjCard[]): number {
  const shape = parseShape(myCards, v.ctx);
  const lead = v.trick.lead ?? shape;
  if (!lead) return 0.5;
  const iAmTrump = (shape?.group ?? lead.group) === 'T';
  const myTop = maxOrder(myCards, v.ctx);
  let p = 1;
  for (const seat of v.trick.toAct) {
    if (seat % 2 === v.me % 2) continue;                    // 对家不算威胁
    const beat = iAmTrump
      ? pBeat(v, seat, { ...lead, group: 'T' }, myTop)
      : pBeat(v, seat, lead, myTop);
    const ruff = iAmTrump ? 0 : pTrump(v, seat, lead);
    p *= 1 - clamp01(Math.max(beat, ruff));
  }
  return clamp01(p);
}

/** 我出 `myCards` 之后，我方（我或对家）收下这一圈的概率 */
export function pTeamWin(v: BrainView, myCards: SjCard[]): number {
  const shape = parseShape(myCards, v.ctx);
  const lead = v.trick.lead ?? shape;
  if (!lead) return 0.5;

  // 我出完之后，本圈当前最大的一手是谁的
  let bestSeat = v.me;
  if (v.trick.plays.length) {
    const plays = [...v.trick.plays, { seat: v.me, cards: myCards }];
    bestSeat = plays[trickWinner(plays, v.ctx).index].seat;
  }
  const bestIsMine = bestSeat % 2 === v.me % 2;

  if (!bestIsMine) {
    if (!v.trick.toAct.includes(v.partner)) return 0;
    const best = v.trick.plays[trickWinner(v.trick.plays, v.ctx).index];
    const bestTop = maxOrder(best.cards, v.ctx);
    return clamp01(Math.max(pBeat(v, v.partner, lead, bestTop), pTrump(v, v.partner, lead)));
  }

  const myTop = bestSeat === v.me ? maxOrder(myCards, v.ctx) : maxOrder(
    v.trick.plays.find((p) => p.seat === bestSeat)!.cards, v.ctx);
  const iAmTrump = bestSeat === v.me
    ? (shape?.group ?? lead.group) === 'T'
    : parseShape(v.trick.plays.find((p) => p.seat === bestSeat)!.cards, v.ctx)?.group === 'T';
  let p = 1;
  const oppRuff: number[] = [];
  for (const seat of v.trick.toAct) {
    if (seat % 2 === v.me % 2) continue;
    const beat = iAmTrump
      ? pBeat(v, seat, { ...lead, group: 'T' }, myTop)
      : pBeat(v, seat, lead, myTop);
    const ruff = iAmTrump ? 0 : pTrump(v, seat, lead);
    oppRuff.push(ruff);
    p *= 1 - clamp01(Math.max(beat, ruff));
  }

  // 对手盖过去了，对家还能救回来 —— 这就是"喂牌给对家毙"（D3 / M13）。
  // 不算这一项，机器人永远不敢往对家的缺门上送 K，而那是真人最常用的一招。
  // 对家毙一刀能压住所有同门牌，只怕对手也毙；他不毙就只能拼同门大小（三家里最大 ≈ 1/3）。
  if (v.trick.toAct.includes(v.partner)) {
    const rp = iAmTrump ? 0 : pTrump(v, v.partner, lead);
    const bp = pBeat(v, v.partner, iAmTrump ? { ...lead, group: 'T' } : lead, myTop);
    const noOppRuff = oppRuff.reduce((a, x) => a * (1 - x), 1);
    const rescue = clamp01(rp * noOppRuff + (1 - rp) * bp * 0.34);
    p = p + (1 - p) * rescue;
  }
  return clamp01(p);
}

/** 场外还有几张主比我手里最大的主大 —— "主抽干了没有"的直观量 */
export function trumpsAboveMine(v: BrainView): SjCard[] {
  return v.trumps.topUnseen;
}

/** 估某座位手里有几张主 */
export function estTrumps(v: BrainView, seat: number): number {
  return v.isVoid(seat, 'T') ? 0 : v.trumps.perHolder;
}

export { coverTop, cardOrder };
