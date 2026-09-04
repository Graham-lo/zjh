/**
 * 公开事件流 —— 机器人能看到的全部「发生过什么」。
 *
 * 只有一个来源：`PlayerState.handActions`。它记的是**本局**每个人做过的动作，
 * 以及做那个动作**当时**的处境（闷着还是看过牌、单价多少、第几轮、什么时候）。
 *
 * 为什么要带处境：闷牌加注是炸金花里最便宜的一记表演，看牌之后的加注才是真话。
 * 旧版只记一个 `'raise'` 字符串，两者同权，于是机器人读到的故事全是假的（设计文档 M2）。
 *
 * 本文件**不 import game.ts 的任何值**（只 import 类型，编译后被擦掉），
 * 所以不会和 game.ts 形成运行时循环依赖。
 */

import type { GameSettings, PlayerState } from '../../game.ts';

/** 会被记进事件流的动作。`look` 不占行动权也不进事件流，见 `noteAction`。 */
export type HandActionKind = 'look' | 'call' | 'raise' | 'compare' | 'all_in' | 'fold';

/** 一个公开动作。字段全部来自桌面上人人都看得见的东西，不含任何暗牌信息。 */
export interface HandEvent {
  kind: HandActionKind;
  /** 做这个动作时他看过牌没有 */
  looked: boolean;
  /** 做这个动作时的跟注单价（不是他实付的钱） */
  unit: number;
  /** 第几轮 */
  roundNo: number;
  /** 发生时刻 */
  at: number;
  /**
   * 他在这一步上花掉的毫秒数（设计文档 §4.8 / S17）。
   *
   * 真人取 `Date.now() - (turnDeadline - turnSeconds*1000)`，机器人直接落它的
   * `thinkMs` —— 后者不是为了省事：服务端是按 `thinkMs` 排延迟再执行的，
   * 所以对机器人来说这两个数本来就是同一个数；而自对弈/竞技场不排延迟，
   * 按墙钟算出来会全是 0，那条信号就假了。
   *
   * 旧快照里没有这一位，所以是可选的；`spentFraction` 读不到就当没有用时信号。
   */
  msSpent?: number;
}

/**
 * 单价落在第几档。
 *
 * 用于跨局记忆的条件分桶：「他在底注档上加过多少次」和「他在 10 万档上加过多少次」
 * 是两个完全不同的统计量，混在一起等于没统计。档位用完之后的翻倍价一律算最高档。
 */
export function unitTier(unit: number, settings: Pick<GameSettings, 'betOptions'>): number {
  const opts = settings.betOptions;
  for (let i = opts.length - 1; i >= 0; i--) if (unit >= opts[i]) return i;
  return 0;
}

/** 本局这个人的事件流。 */
export function eventsOf(p: Pick<PlayerState, 'handActions'>): HandEvent[] {
  return p.handActions ?? [];
}

/** 只要动作名的旧口径（`storyHeat` 读的是这个）。 */
export function kindsOf(p: Pick<PlayerState, 'handActions'>): string[] {
  return (p.handActions ?? []).map((e) => e.kind);
}

/**
 * 旧快照迁移：`handActions` 曾经是 `string[]`。
 *
 * 老房间里读到字符串数组不能直接崩，也不能直接丢 —— 那一局正打到一半。
 * 补法：`looked` 一律按 false（保守，闷牌动作的信息量最低，不会凭空给对手加戏），
 * `unit` 用快照里当时的单价，实在没有就用底注档。
 */
export function normalizeHandActions(raw: unknown, unit: number, roundNo: number): HandEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: HandEvent[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      out.push({ kind: item as HandActionKind, looked: false, unit, roundNo, at: 0 });
    } else if (item && typeof item === 'object' && typeof (item as HandEvent).kind === 'string') {
      const e = item as Partial<HandEvent>;
      out.push({
        kind: e.kind as HandActionKind,
        looked: e.looked === true,
        unit: typeof e.unit === 'number' && e.unit > 0 ? e.unit : unit,
        roundNo: typeof e.roundNo === 'number' ? e.roundNo : roundNo,
        at: typeof e.at === 'number' ? e.at : 0,
        ...(typeof e.msSpent === 'number' ? { msSpent: e.msSpent } : {}),
      });
    }
  }
  return out;
}
