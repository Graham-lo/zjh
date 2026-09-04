/**
 * 机器人大脑的对外入口（设计文档 §4.1 / §4.2）。
 *
 * **信息边界只在这里执行一次**：进了 `decideBot` 之后，代码物理上就拿不到
 * 它没资格看的牌 —— 这比"约定不去读"可靠得多，`game.test.ts` 的防偷看用例
 * 也是照着这条边界写的。
 */

import { GameError, type GameCommand, type PlayerState, type RoomState } from '../../game.ts';
import { decideBot, decideOffTurn, type BotAction } from './decide.ts';

export { personaFor, type BotAction } from './decide.ts';

export function botDecision(state: RoomState, bot: PlayerState): GameCommand {
  return botAction(state, bot).cmd;
}

/** 和 botDecision 同一套判断，额外给出该「想」多久。信息边界在这里统一执行。 */
export function botAction(state: RoomState, bot: PlayerState): BotAction {
  const { visibleState, visibleBot } = throughHisEyes(state, bot);
  return decideBot(visibleState, visibleBot);
}

/**
 * 把牌桌裁成「他有资格看到的样子」。
 *
 * 机器人有权看到的牌只有两种：自己看过的牌，以及**比牌时亲眼看过**的那个对手
 * （`seen[bot.id]`）。后者是这一期新放开的：比完牌还假装不知道对面是什么，
 * 是旧模型最不像人的一处（设计文档 S20）。除此之外一律清空。
 */
function throughHisEyes(state: RoomState, bot: PlayerState) {
  const entitled = new Set(state.seen?.[bot.id] ?? []);
  const players = state.players.map((p) => ({
    ...p,
    hand: (p.id === bot.id ? bot.looked : entitled.has(p.id)) ? p.hand : [],
  }));
  const visibleState: RoomState = {
    ...state,
    players,
    // 机器人只会在 playing 阶段行动；显式清掉可能含历史摊牌的结果。
    result: undefined,
    // 只留自己那一条：别人和别人比过什么牌，与他无关。
    seen: entitled.size ? { [bot.id]: [...entitled] } : {},
  };
  const visibleBot = players.find((p) => p.id === bot.id);
  if (!visibleBot) throw new GameError('机器人不在当前房间');
  return { visibleState, visibleBot };
}

/**
 * 非回合动作（§4.6）：别人加档或梭哈之后，服务端对每个还在局里的机器人问一次
 * 「你要不要现在就看/就弃」。返回 null 表示按兵不动。信息边界和 `botAction` 完全一样。
 */
export function botOffTurn(state: RoomState, bot: PlayerState): BotAction | null {
  if (state.phase !== 'playing' || bot.status !== 'active') return null;
  const { visibleState, visibleBot } = throughHisEyes(state, bot);
  return decideOffTurn(visibleState, visibleBot);
}
