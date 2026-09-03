/**
 * 「被迫补齐」：用户点了某几张牌之后，规则上**非带不可**的那些牌。
 *
 * 这里存在的理由只有一条：选牌是用户的事，智能扩展不是。
 * 界面上单击一张牌永远只动那一张 —— 除非跟牌规则根本不允许它单独出现，
 * 那时候补齐不是"替他做决定"，而是把一条他躲不开的约束提前摆出来。
 * 判据因此定死成一个不留余地的定义：
 *
 *   **所有包含 `must` 的合法出法的交集**，减去 `must` 本身。
 *
 * 交集里的每一张牌，都满足「只要这手牌里有 must，就一定也有它」。
 * 只要还剩两种打法在这张牌上分歧，交集就把它剔掉 —— 于是"规则不强迫的一张也不加"
 * 是这个定义的直接推论，而不是另外贴上去的启发式。
 *
 * 合法性一律回调 `rules.ts` 的 `validateFollow`，绝不在这里重写跟牌规则；
 * 组合枚举带 `cap`，宁可不补也不让客户端在选牌时卡住（DESIGN 3.4）。
 */

import { groupOf, type SjCard, type SjCtx } from './cards.ts';
import { validateFollow } from './rules.ts';
import { cardsInGroup, type SjShape } from './units.ts';

/** 默认最多做多少次跟牌校验。超过就放弃补齐 —— 每次选牌都要重算，不能卡顿 */
export const COMPLETE_CAP = 4000;

/** 枚举的收尾状态：`truncated` 表示撞上 cap 提前放弃，结果不完整、不可用来求交集 */
interface Sweep {
  /** 实际做了多少次 validateFollow */
  checks: number;
  /** 撞上 cap 提前放弃 */
  truncated: boolean;
  /** 访问者主动喊停（结果已经够用，不算放弃） */
  stopped: boolean;
  /** 至少找到过一手合法出法 */
  found: boolean;
}

const sameIds = (a: readonly SjCard[]) => new Set(a.map((c) => c.id));

/**
 * 枚举所有「包含 must 的合法跟牌」，每找到一手就交给 `visit`；
 * `visit` 返回 false 表示不用再找了。
 *
 * 关键是**先把候选池收窄再枚举**，不是对整手牌做 C(25, n)：
 * `validateFollow` 的第一条就是"有 G 必跟 G"，于是只有两种局面 ——
 *
 * - 该门牌不够 n 张：该门**全部**必出，剩下的槽位从非该门的牌里挑；
 * - 该门牌够 n 张：整手都必须来自该门，池子就是该门牌。
 *
 * 池子收窄之后剩下的组合数才是现实的量级，cap 只是最后那道保险。
 */
function eachLegalFollow(
  hand: SjCard[],
  must: SjCard[],
  lead: SjShape,
  ctx: SjCtx,
  cap: number,
  visit: (play: SjCard[]) => boolean,
): Sweep {
  const out: Sweep = { checks: 0, truncated: false, stopped: false, found: false };
  const handIds = sameIds(hand);
  if (must.some((c) => !handIds.has(c.id))) return out;

  const n = lead.count;
  if (must.length > n || hand.length < n) return out;

  const mustIds = sameIds(must);
  const handG = cardsInGroup(hand, lead.group, ctx);

  let fixed: SjCard[];
  let pool: SjCard[];
  if (handG.length < n) {
    // 有 G 必跟 G：该门的牌一张都留不住，其余槽位随便垫
    const inG = sameIds(handG);
    fixed = handG.concat(must.filter((c) => !inG.has(c.id)));
    pool = hand.filter((c) => !inG.has(c.id) && !mustIds.has(c.id));
  } else {
    // 该门够数：整手必须来自该门，must 里但凡有一张不是该门的就无解
    if (must.some((c) => groupOf(c, ctx) !== lead.group)) return out;
    fixed = must.slice();
    pool = handG.filter((c) => !mustIds.has(c.id));
  }
  const need = n - fixed.length;
  if (need < 0 || need > pool.length) return out;

  const picked: SjCard[] = [];
  const rec = (start: number): boolean => {
    if (picked.length === need) {
      if (out.checks >= cap) {
        out.truncated = true;
        return false;
      }
      out.checks += 1;
      const play = fixed.concat(picked);
      if (!validateFollow(hand, lead, play, ctx).ok) return true;
      out.found = true;
      if (visit(play)) return true;
      out.stopped = true;
      return false;
    }
    // 剩下的牌不够填满槽位就没必要往下走
    if (pool.length - start < need - picked.length) return true;
    for (let i = start; i < pool.length; i++) {
      picked.push(pool[i]);
      const go = rec(i + 1);
      picked.pop();
      if (!go) return false;
    }
    return true;
  };
  rec(0);
  return out;
}

/**
 * 包含 `must` 的全部合法跟牌（`must ⊆ hand`）。
 *
 * 只在 `lead` 存在时有意义 —— 首出没有"必须跟"这回事，返回 `[]`。
 * 两副牌里同一张牌有两份，`♥7a ♥7b` 换个顺序不是另一种打法，所以按**牌面**去重。
 * 撞上 cap 就返回已经找到的那部分（`补齐` 按钮拿去做候选够用了）。
 */
export function legalFollowsContaining(
  hand: SjCard[],
  must: SjCard[],
  lead: SjShape | null,
  ctx: SjCtx,
  cap = COMPLETE_CAP,
): SjCard[][] {
  if (!lead) return [];
  const out: SjCard[][] = [];
  const seen = new Set<string>();
  eachLegalFollow(hand, must, lead, ctx, cap, (play) => {
    const key = play.map((c) => `${c.suit}${c.rank}`).sort().join(',');
    if (!seen.has(key)) {
      seen.add(key);
      out.push(play.slice());
    }
    return true;
  });
  return out;
}

/**
 * 被迫补齐：所有包含 `must` 的合法出法的**交集**，减去 `must` 本身。
 *
 * - 没有任何合法超集 → `null`（调用方据此只加用户点的那一张，并照常显示不合法的原因）；
 * - 交集不比 `must` 多 → `[]`（规则不强迫，什么都不补）；
 * - 首出（`lead` 为 null）→ 永远 `[]`：单张总是合法的，规则从不强迫。
 *
 * 枚举超过 `cap` 次校验就放弃（返回 `[]`）：宁可不补，不可卡顿。
 * 交集一旦缩到 `must` 本身就提前收工 —— 它只会越缩越小，再枚举也不会有别的结果，
 * 这一条让「该门二十张、首出甩八张」这种最坏局面也在几十次校验里结束。
 */
export function forcedCompletion(
  hand: SjCard[],
  must: SjCard[],
  lead: SjShape | null,
  ctx: SjCtx,
  cap = COMPLETE_CAP,
): SjCard[] | null {
  if (!lead) return [];
  const mustIds = sameIds(must);
  const byId = new Map(hand.map((c) => [c.id, c] as const));
  // 交集放在数组里只装 0 或 1 个元素：闭包里赋值的 let 在闭包外拿不到窄化，用不了
  const inter: string[][] = [];

  const sweep = eachLegalFollow(hand, must, lead, ctx, cap, (play) => {
    const ids = sameIds(play);
    const prev = inter.pop();
    const next = prev ? prev.filter((id) => ids.has(id)) : play.map((c) => c.id);
    inter.push(next);
    // 交集已经等于 must（合法出法必含 must，所以长度只会 ≥ must.length）
    return next.length > mustIds.size;
  });

  if (sweep.truncated) return [];
  const found = inter[0];
  if (!sweep.found || !found) return null;
  return found.filter((id) => !mustIds.has(id)).map((id) => byId.get(id)!);
}
