import type { GameCommand, PublicRoom } from './game.ts';
import type { GameKind } from './games.ts';
import type { SjCommand, SjEvent, SjPublicRoom } from './sj/engine.ts';

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
  /** 升级的局数与胜局（DESIGN 2.1 多游戏框架） */
  sjHands: number;
  sjWins: number;
}

/**
 * 任意一种房间的公开视图。房间靠 `kind` 自我描述，
 * 客户端拿到之后先分流再解读（DESIGN 2.3）。
 */
export type AnyPublicRoom = PublicRoom | SjPublicRoom;

/** 任意一种游戏的玩家指令。服务端按房间的 kind 交给对应引擎校验 */
export type AnyGameCommand = GameCommand | SjCommand;

export type ClientMsg =
  // kind 缺省 'zjh'：老客户端发来的 create 仍然是炸金花（DESIGN 2.3 / 2.6）
  | ({ t: 'create'; kind?: GameKind } & ClientHello)
  | ({ t: 'join'; code: string } & ClientHello)
  | { t: 'resume'; code: string; playerId: string; token: string }
  | { t: 'cmd'; cmd: AnyGameCommand }
  | { t: 'ping'; at: number };

/** 炸金花的瞬时事件。客户端拿它播动画和音效，状态本身仍以 room 为准。 */
export type ZjhEvent =
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
  | { k: 'emote'; playerId: string; id: string; target?: string }
  | { k: 'turn'; playerId: string }
  | { k: 'presence'; playerId: string; online: boolean };

/**
 * 一次状态变更伴随的瞬时事件。两种游戏的事件并成一个联合类型，
 * 客户端用 `switch (ev.k)` 分流；不认识的事件走 default 忽略（DESIGN 2.6）。
 */
export type GameEvent = ZjhEvent | SjEvent;

export type ServerMsg =
  /**
   * `build` 是服务端当前那份前端产物的指纹。客户端记住第一次握手拿到的值，
   * 之后任何一次重连（上线重启必然触发一次）拿到不一样的值，就说明自己这个页面旧了。
   */
  | { t: 'welcome'; code: string; playerId: string; token: string; room: AnyPublicRoom; account?: AccountInfo; build?: string }
  | { t: 'room'; room: AnyPublicRoom; events: GameEvent[] }
  | { t: 'error'; msg: string; fatal?: boolean }
  | { t: 'pong'; at: number; now: number };
