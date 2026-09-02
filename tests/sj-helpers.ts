/** 升级测试的公共夹具。文件名不带 .test.ts，不会被 node --test 当成用例文件 */

import { cardFromId, type SjCard, type SjCtx } from '../shared/sj/cards.ts';
import { botDeclare } from '../shared/sj/bot.ts';
import type { SjKind } from '../shared/games.ts';
import {
  applySjCommand, closeDeclaring, createSjPlayer, createSjRoom, finishDealing,
  timeoutKou, timeoutTurn, type SjEngineOpts, type SjRoomState,
} from '../shared/sj/engine.ts';

/** `h('S5a S5b')` → 两张黑桃 5。id 自带牌面，写用例时一眼能读出是哪张牌 */
export function h(spec: string): SjCard[] {
  return spec.trim().split(/\s+/).filter(Boolean).map(cardFromId);
}

export function one(id: string): SjCard {
  return cardFromId(id);
}

export function ids(cards: SjCard[]): string[] {
  return cards.map((c) => c.id);
}

/** 常用局面：主黑桃、打 5。S5=主级牌、H5/C5/D5=副级牌、SA 是主花色最大的普通牌 */
export const CTX_S5: SjCtx = { trump: 'S', level: 5 };
export const CTX_NT5: SjCtx = { trump: 'NT', level: 5 };

/** 可复现的伪随机源（mulberry32）。模糊测试失败时靠种子重放 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 一个房主 + 三台电脑，四座坐满的房间 */
export function makeSjRoom(kind: SjKind = 'sj_510k'): SjRoomState {
  const host = createSjPlayer('甲', '🐯', 0, 'token-0');
  const room = createSjRoom(kind, '123456', host);
  host.ready = true;
  for (let i = 0; i < 3; i++) applySjCommand(room, host.id, { type: 'add_bot' });
  return room;
}

/** 走完亮主窗口：每个人按机器人策略决定亮还是不亮，然后关窗 */
export function runDeclaring(room: SjRoomState, opts: SjEngineOpts) {
  finishDealing(room, opts);
  for (const p of room.players) {
    const cardIds = botDeclare(room, p);
    if (cardIds) applySjCommand(room, p.id, { type: 'declare', cardIds }, opts);
  }
  closeDeclaring(room, opts);
}

/** 从 playing 一路打到 hand_end，全部由机器人策略代打 */
export function playOutTricks(room: SjRoomState, opts: SjEngineOpts) {
  let guard = 0;
  while (room.phase === 'playing') {
    if (guard++ > 400) throw new Error('出牌没有收敛');
    timeoutTurn(room, opts);
  }
}

/** 发牌 → 亮主 → 扣底 → 打完一局 */
export function playHand(room: SjRoomState, opts: SjEngineOpts) {
  runDeclaring(room, opts);
  timeoutKou(room, opts);
  playOutTricks(room, opts);
}
