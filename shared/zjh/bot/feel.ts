/**
 * 局中事件 → 情绪（设计文档 §4.9.1 / §4.10.2）。
 *
 * 情绪不能只在结算的时候跳一下。真人的一手牌里情绪是**一路在动**的：
 * 被人加到十万那一下心里就沉了一截，掀开自己的牌看到一手散牌又沉一截，
 * 旁边两个人开牌打掉一个，会「哦豁」一声然后重新估这一桌。
 * 到结算才算情绪，等于机器人整局都是同一张脸。
 *
 * 这个文件只干一件事：**把桌面上公开发生过的事，翻成 `ZjhEvent`**。
 * 翻完就交给通用层唯一的那条通道 `feel()`：
 *
 *     公开动作 ──这里──▶ ZjhEvent ──`DomainAdapter.appraise`──▶ 五维评价
 *                                  ──`appraisalToDeltas`──▶ 情绪/驱力增量
 *                                  ──`nudge`──▶ MindState
 *
 * 信息边界：读的全是 `PlayerState.handActions`（人人看得见的动作 + 当时的处境）、
 * `state.seen[我]`（谁跟我开过牌 —— 按定义我有权看见）、以及**我自己的**底牌。
 * 一张别人的暗牌都没读。
 *
 * 消化到哪儿了记在 `BotMemory.feelAt` 上：同一手牌里同一件事只感受一次，
 * 非回合的旁观决策（`decideOffTurn`）不推进这个游标，也不写回情绪。
 */

import type { PlayerState, RoomState } from '../../game.ts';
import { feel } from '../../mind/adapter.ts';
import type { MindState } from '../../mind/emotion.ts';
import type { Traits } from '../../mind/traits.ts';
import { zjhAppraise, type ZjhEvent } from './adapter.ts';
import { eventsOf, type HandEvent } from './events.ts';
import { ownStrength } from './lookahead.ts';
import { memoryKey, type BotMemory } from './profile.ts';

/** 只需要 `appraise` 的那一半适配器：翻译事件不需要局面（见 `DomainAdapter.appraise`）。 */
const feeler = { appraise: zjhAppraise };

/** 本局的公开事件消化到哪儿了。 */
export interface FeelCursor {
  /** 第几局（`state.handNo`）—— 换局就重置 */
  hand: number;
  /** 已经消化掉的**对手**公开动作条数 */
  acts: number;
  /** 已经消化掉的「谁跟我开过牌」条数 */
  seen: number;
  /** 自己那一眼看过了没有 */
  peeked: boolean;
}

function freshCursor(hand: number): FeelCursor {
  return { hand, acts: 0, seen: 0, peeked: false };
}

/**
 * 把「上次决策之后桌上发生的事」翻成事件流。**纯函数，不改任何状态。**
 * 返回新游标，由调用方决定要不要落盘。
 */
export function handEvents(
  state: RoomState, bot: PlayerState, prev?: FeelCursor,
): { events: ZjhEvent[]; cursor: FeelCursor } {
  const hand = state.handNo ?? 0;
  const cursor: FeelCursor = prev && prev.hand === hand ? { ...prev } : freshCursor(hand);
  const events: ZjhEvent[] = [];
  const balance = bot.chips;
  const pot = Math.max(1, state.pot);

  // 谁跟我开过牌 —— 双向记账，所以我发起的和别人找上我的都在里面
  const seenIds = state.seen?.[bot.id] ?? [];

  // ① 对手的公开动作，按发生时刻排成一条流
  const stream: { e: HandEvent; by: PlayerState }[] = [];
  for (const p of state.players) {
    if (p.id === bot.id) continue;
    for (const e of eventsOf(p)) stream.push({ e, by: p });
  }
  stream.sort((a, b) => a.e.at - b.e.at);

  for (const { e, by } of stream.slice(cursor.acts)) {
    const who = memoryKey(by);
    if (e.kind === 'raise' || e.kind === 'all_in') {
      // 「这一口对我来说多贵」：闷着的人价钱减半，所以同一次加档对不同的人不一样疼
      const price = e.unit * (bot.looked ? 2 : 1);
      const size = e.kind === 'all_in'
        ? Math.min(balance, state.allIn ? state.allIn.base * (bot.looked ? 2 : 1) : balance)
        : price;
      events.push({
        kind: 'pressed', by: who, size, balance,
        looked: e.looked, allIn: e.kind === 'all_in',
      });
    } else if (e.kind === 'fold') {
      events.push({ kind: 'quit', by: who, size: by.bet, balance, pot });
    } else if (e.kind === 'compare') {
      // 跟我开的那一比走 ② 那条路（`state.seen` 是唯一说得准「对手是不是我」的地方）。
      // 同一局里先跟我比过、后来又跟别人比的人会被这一条误判成「跟我比」——
      // 比过牌的人只剩两个还站着，这种局面已经在收官了，这点误差不值得为它多存一份账。
      if (!seenIds.includes(by.id)) {
        events.push({ kind: 'watched', by: who, size: by.bet, balance, pot });
      }
    }
  }
  cursor.acts = stream.length;

  // ② 有人跟我开了牌。我还能坐在这儿想事情，就说明这一比我赢了；
  //    输的那一头当场出局，走的是结算（`settle`）。
  for (const id of seenIds.slice(cursor.seen)) {
    const other = state.players.find((p) => p.id === id);
    events.push({
      kind: 'compared', by: other ? memoryKey(other) : id, won: true,
      size: other?.bet ?? pot, balance,
    });
  }
  cursor.seen = seenIds.length;

  // ③ 我自己掀开了牌
  if (bot.looked && !cursor.peeked) {
    cursor.peeked = true;
    events.push({
      kind: 'peeked', strength: ownStrength(bot, state.settings.dealMode) ?? 0.5,
      balance, roundNo: state.roundNo,
    });
  }

  return { events, cursor };
}

/**
 * 把这些事真的「感受」一遍：逐条走通用通道，落进 `mind`。
 *
 * 返回感受过的事件，调用方（测试、复盘脚本）可以拿它对着情绪轨迹看。
 */
export function feelHand(
  state: RoomState, bot: PlayerState, mind: MindState, t: Traits, mem?: BotMemory,
): ZjhEvent[] {
  if (!mem) return [];
  const { events, cursor } = handEvents(state, bot, mem.feelAt);
  for (const ev of events) feel(feeler, ev, mind, t);
  mem.feelAt = cursor;
  return events;
}
