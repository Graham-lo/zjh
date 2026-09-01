import type { GameCommand, PublicRoom } from './game.ts';

export interface ClientHello {
  name: string;
  avatar: string;
  /** 由 AI 驱动的席位。牌桌上会明示，不允许静默代打 */
  agent?: boolean;
}

export type ClientMsg =
  | ({ t: 'create' } & ClientHello)
  | ({ t: 'join'; code: string } & ClientHello)
  | { t: 'resume'; code: string; playerId: string; token: string }
  | { t: 'cmd'; cmd: GameCommand }
  | { t: 'ping'; at: number };

/** 一次状态变更伴随的瞬时事件，客户端拿它播动画和音效。状态本身仍以 room 为准。 */
export type GameEvent =
  | { k: 'deal'; handNo: number; seats: number[] }
  | { k: 'bet'; playerId: string; amount: number; kind: 'call' | 'raise' | 'all_in' | 'compare' | 'accept' }
  | { k: 'look'; playerId: string }
  | { k: 'fold'; playerId: string }
  | { k: 'showdown'; winnerId: string }
  | { k: 'win'; playerId: string; amount: number }
  | { k: 'emote'; playerId: string; id: string }
  | { k: 'chat'; seq: number }
  | { k: 'turn'; playerId: string }
  | { k: 'presence'; playerId: string; online: boolean };

export type ServerMsg =
  | { t: 'welcome'; code: string; playerId: string; token: string; room: PublicRoom }
  | { t: 'room'; room: PublicRoom; events: GameEvent[] }
  | { t: 'error'; msg: string; fatal?: boolean }
  | { t: 'pong'; at: number; now: number };
