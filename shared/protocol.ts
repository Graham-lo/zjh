import type { GameCommand, PublicRoom } from './game.ts';

export interface ClientHello {
  name: string;
  avatar: string;
  /** 由 AI 驱动的席位。牌桌上会明示，不允许静默代打 */
  agent?: boolean;
  /** 账户凭证。带上就沿用同一个账户（积分和战绩接着上次），不带则开新账户 */
  accountId?: string;
  accountToken?: string;
}

/** 服务端回执的账户信息，客户端要存下来下次带上 */
export interface AccountInfo {
  id: string;
  token: string;
  chips: number;
  granted: number;
  hands: number;
  wins: number;
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
  | {
      k: 'bet';
      playerId: string;
      amount: number;
      kind: 'call' | 'raise' | 'all_in' | 'compare' | 'accept';
      /**
       * 比牌专用的附加信息（只在 kind === 'compare' 时出现）。
       *
       * 客户端的比牌对决全屏动画需要知道「谁和谁比」「谁输了」才能把追光打对、
       * 让败者的牌碎掉。这些都是比牌当场全桌都会从日志里看到的公开事实，
       * 不含任何暗牌，所以放进事件里不泄密。字段是后加的，老客户端忽略即可。
       */
      targetId?: string;
      loserId?: string;
    }
  | { k: 'look'; playerId: string }
  | { k: 'fold'; playerId: string }
  | { k: 'showdown'; winnerId: string }
  | { k: 'win'; playerId: string; amount: number }
  | { k: 'emote'; playerId: string; id: string }
  | { k: 'chat'; seq: number }
  | { k: 'turn'; playerId: string }
  | { k: 'presence'; playerId: string; online: boolean };

export type ServerMsg =
  | { t: 'welcome'; code: string; playerId: string; token: string; room: PublicRoom; account?: AccountInfo }
  | { t: 'room'; room: PublicRoom; events: GameEvent[] }
  | { t: 'error'; msg: string; fatal?: boolean }
  | { t: 'pong'; at: number; now: number };
