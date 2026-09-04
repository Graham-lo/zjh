/**
 * 确定性随机。
 *
 * 机器人身上所有的「掷骰子」都从这里来，种子只由**公开局面**拼成：
 * 同一个局面永远掷出同一个数，所以决策可复测，也不会因为改了对手的暗牌就变。
 * `game.test.ts` 的防偷看用例就是靠这一条成立的。
 */

import type { PlayerState, RoomState } from '../../game.ts';

/** 小的确定性哈希 → [0,1)。 */
export function pseudoRandom(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** 一步决策上的随机量。 */
export function botRoll(
  state: Pick<RoomState, 'handNo' | 'roundNo' | 'turnCount' | 'actionSeq'>,
  bot: Pick<PlayerState, 'id'>,
  purpose: string,
): number {
  return pseudoRandom(
    `${bot.id}:${state.handNo}:${state.roundNo}:${state.turnCount}:${state.actionSeq}:${purpose}`,
  );
}

/**
 * 一手牌之内**稳定**的随机量（设计文档 §4.4 的线路种子）。
 *
 * 不含 `turnCount`/`actionSeq`：同一手牌、同一个信息点，选出来的线路必须是同一条，
 * 否则就回到了「每一步独立掷骰子」的老毛病（M3）——上一步在吹，下一步自己就跑了。
 */
export function planRoll(
  state: Pick<RoomState, 'handNo'>,
  bot: Pick<PlayerState, 'id'>,
  planPoint: string,
  purpose = 'line',
): number {
  return pseudoRandom(`${bot.id}:${state.handNo}:${planPoint}:${purpose}`);
}
