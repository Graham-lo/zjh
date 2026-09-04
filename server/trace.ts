/**
 * 决策留痕的落库层（设计文档 §4.11）。
 *
 * 三条写入路径，一条铁律：**留痕绝不能影响牌局**（§4.11.3）。
 *
 *   机器人行动  → `bot()`     ← `rooms.ts` 执行机器人动作处
 *   真人行动    → `human()`   ← `rooms.ts` 的指令入口，动作**生效前**取样
 *   一局结算    → `hand()`    ← round_end，跟打法档案同一个防重闸门
 *
 * 铁律怎么落实：
 *
 * 1. 取样（`shared/zjh/bot/trace.ts`）和入队都包在 try/catch 里，失败只 `console.error`；
 * 2. 入队是纯内存操作，真正的 SQL 写在下一个 tick 成批跑，牌桌那一步早就返回了；
 * 3. 批量写整个包在 try/catch 里，写挂了就把这一批丢掉，不重试、不抛出去。
 *
 * 测试里可以开 `sync: true` 让写入回到调用栈上 —— 那是**故意**把最危险的形态
 * 摆出来：即使 SQL 在牌桌的调用栈里抛错，牌局也必须照常打完（`zjh-trace.test.ts`）。
 */

import type { GameCommand, PlayerState, RoomState } from '../shared/game.ts';
import type { Drives, Emotions } from '../shared/mind/emotion.ts';
import {
  emotionDelta, driveDelta, revealedStrength, traceAction, traceHuman,
  type BotTrace,
} from '../shared/zjh/bot/trace.ts';
import { memoryKey } from '../shared/zjh/bot/profile.ts';
import type { DecisionRow, HandOutcomeRow, HumanActionRow, Store } from './store.ts';

/** 保留 30 天（§4.11.2）。 */
export const TRACE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RETENTION_TICK_MS = 24 * 60 * 60 * 1000;

export interface TraceOptions {
  /** 落库回到调用栈上（只给测试用；生产永远是异步的） */
  sync?: boolean;
  /** 超期归档的落脚目录 */
  archiveDir?: string;
  retentionMs?: number;
}

/** 什么都不做的提交函数：取样失败时返回它，调用方不需要判空。 */
const NOOP = () => {};

export class TraceRecorder {
  private store: Store;
  private sync: boolean;
  private archiveDir: string | null;
  private retentionMs: number;
  private decisions: DecisionRow[] = [];
  private humans: HumanActionRow[] = [];
  /** 结算行与它要回填的牌力，跟决策/动作走同一条批处理队列（顺序见 `drain`） */
  private outcomes: { row: HandOutcomeRow; backfill: Record<string, number> }[] = [];
  private timer: NodeJS.Timeout | null = null;
  private daily: NodeJS.Timeout | null = null;
  /**
   * 每局每人在**结算之前**最后一次决策时的情绪，用来算「结算触发的增量」。
   * 键是 `房间:局号:记忆键`，一局写完就清掉。
   */
  private beforeSettle = new Map<string, { e: Emotions; d: Drives }>();

  constructor(store: Store, opts: TraceOptions = {}) {
    this.store = store;
    this.sync = opts.sync ?? false;
    this.archiveDir = opts.archiveDir ?? null;
    this.retentionMs = opts.retentionMs ?? TRACE_RETENTION_MS;
  }

  /* ------------------------------------------------------------ 机器人 */

  /**
   * 机器人的一次决策。`record` 是 `decide()` 一路透出来的那一份 ——
   * 这里不重算局面，重算出来的不是他刚才面对的那个局面。
   */
  bot(state: RoomState, record: BotTrace | undefined, cmd: GameCommand) {
    if (!record) return;
    try {
      const t = record.decision;
      const row: DecisionRow = {
        at: Date.now(),
        room: state.code,
        handNo: state.handNo,
        roundNo: record.features.roundNo,
        memoryKey: record.memoryKey,
        persona: record.persona,
        dealMode: record.dealMode,
        offTurn: record.offTurn,
        features: record.features,
        opponents: record.opponents,
        plan: record.plan,
        planCommit: record.planCommit,
        emotions: t.emotions,
        drives: t.drives,
        tilt: t.tilt,
        ease: t.ease,
        arousal: t.arousal,
        fatigue: t.fatigue,
        willpower: t.willpower,
        impulseKey: t.impulse.key,
        confidence: t.impulse.confidence,
        feltStrength: t.impulse.feltStrength,
        feltThreat: t.impulse.feltThreat,
        p2: t.p2,
        engaged: t.engaged,
        deliberateKey: t.deliberate?.key,
        deliberateScore: t.deliberate?.score,
        difficulty: t.deliberate?.difficulty,
        overridden: t.overridden,
        deviated: t.deviated,
        gap: t.gap,
        need: t.need,
        fired: [...t.fired],
        action: traceAction(cmd),
        thinkMs: record.thinkMs,
      };
      this.beforeSettle.set(
        `${state.code}:${state.handNo}:${record.memoryKey}`,
        { e: { ...t.emotions }, d: { ...t.drives } },
      );
      this.decisions.push(row);
      this.schedule();
    } catch (e) {
      console.error('[trace] 机器人决策入队失败', e);
    }
  }

  /* -------------------------------------------------------------- 真人 */

  /**
   * 真人的一次动作。**必须在 `applyCommand` 生效之前**调用：状态一改，
   * 「他是顶着一次加注按的弃牌」就找不回来了。
   *
   * 返回一个提交函数 —— 动作真的做成了才调用它。指令被引擎拒掉（不该他动、
   * 跟不起、比牌没解锁）的时候什么都不会落库。
   */
  human(state: RoomState, player: PlayerState, cmd: GameCommand, elapsedMs: number): () => void {
    if (state.phase !== 'playing' || player.isBot) return NOOP;
    if (!TABLE_ACTIONS.has(cmd.type)) return NOOP;
    let row: HumanActionRow;
    try {
      const h = traceHuman(state, player);
      row = {
        at: Date.now(),
        room: state.code,
        handNo: state.handNo,
        roundNo: state.roundNo,
        accountId: h.accountId,
        memoryKey: h.memoryKey,
        dealMode: h.dealMode,
        features: h.features,
        opponents: h.opponents,
        action: traceAction(cmd),
        elapsedMs: Math.max(0, Math.round(elapsedMs)),
        looked: h.looked,
      };
    } catch (e) {
      console.error('[trace] 真人动作取样失败', e);
      return NOOP;
    }
    return () => {
      try {
        this.humans.push(row);
        this.schedule();
      } catch (e) {
        console.error('[trace] 真人动作入队失败', e);
      }
    };
  }

  /* -------------------------------------------------------------- 结算 */

  /**
   * 一局的结算（§4.11.1 的 `zjh_hand_outcomes`）。
   *
   * 顺手做两件只有这一刻才做得了的事：
   * 一是把亮过牌的真人那一局的牌力回填进 `zjh_human_actions`（这时候它已经公开了）；
   * 二是记下结算这一下把每个人的情绪推动了多少 —— 拿结算后的 `mind` 减去
   * 他本局最后一次决策时的 `mind`。`settle` 已经在动情绪了，所以这个增量现在
   * 就有值（被梭掀掉的人 anger / rumination 会明显往上走）；`adapter.appraise`
   * 那条更细的评价路径还没接线，接上之后这里不用改一行代码，值只会更准。
   *
   * 行的计算是同步的（`state` 下一拍就变了，晚一步就取不到了），**写库不是** ——
   * 它和决策/动作进同一条 200ms 的批处理队列，绝不在 broadcast 的调用栈上跑 SQL。
   */
  hand(state: RoomState) {
    const result = state.result;
    if (!result) return;
    try {
      const strengths = revealedStrength(result.hands, result.revealed, state.settings.dealMode);
      const revealed = new Set(result.revealed ?? []);
      const byId = new Map(state.players.map((p) => [p.id, p]));
      const deltas = new Map(result.deltas.map((d) => [d.id, d]));

      const players: HandOutcomeRow['players'] = state.players.map((p) => {
        const d = deltas.get(p.id);
        return {
          id: p.id,
          key: memoryKey(p),
          name: p.name,
          isBot: !!p.isBot,
          bet: d?.bet ?? 0,
          net: d?.net ?? 0,
          delta: d?.delta ?? 0,
          revealed: revealed.has(p.id),
          strength: strengths[p.id],
        };
      });

      const emotion: HandOutcomeRow['emotionDelta'] = {};
      for (const p of state.players) {
        const key = memoryKey(p);
        const mind = state.memory?.[key]?.mind;
        if (!mind) continue;
        const before = this.beforeSettle.get(`${state.code}:${state.handNo}:${key}`);
        emotion[key] = { e: emotionDelta(before?.e, mind.e), d: driveDelta(before?.d, mind.d) };
      }

      const winner = byId.get(result.winnerId);
      const row: HandOutcomeRow = {
        at: Date.now(),
        room: state.code,
        handNo: state.handNo,
        winnerId: result.winnerId,
        winnerKey: winner ? memoryKey(winner) : result.winnerId,
        winnerName: result.winnerName,
        pot: result.potWon,
        reason: result.reason,
        dealMode: state.settings.dealMode,
        players,
        emotionDelta: emotion,
      };

      // 真人的牌力只在亮过牌之后才补，且只补他自己那几行
      const backfill: Record<string, number> = {};
      for (const p of players) {
        if (p.isBot || p.strength === undefined) continue;
        backfill[p.key] = p.strength;
      }

      this.forget(state.code, state.handNo);
      this.outcomes.push({ row, backfill });
      this.schedule();
    } catch (e) {
      console.error('[trace] 结算留痕失败', e);
    }
  }

  /* ---------------------------------------------------------- 队列与保留 */

  /** 把还挂着的行立刻写完。上线重启前和测试里用。 */
  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.run(() => this.drain());
  }

  /**
   * 保留策略（§4.11.2）：启动时跑一次，之后每天一次。
   * 没配归档目录就什么都不做 —— 没地方放的时候宁可不删。
   */
  startRetention(dir: string | null = this.archiveDir) {
    this.archiveDir = dir;
    if (!dir) return;
    this.sweepRetention();
    this.daily = setInterval(() => this.sweepRetention(), RETENTION_TICK_MS);
    this.daily.unref?.();
  }

  private sweepRetention() {
    const dir = this.archiveDir;
    if (!dir) return;
    try {
      const res = this.store.archiveTrace(dir, this.retentionMs);
      if (res.archived) console.log(`[trace] 归档 ${res.archived} 条超期留痕到 ${res.file}，已删除 ${res.deleted} 行`);
    } catch (e) {
      console.error('[trace] 留痕归档失败', e);
    }
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    if (this.daily) clearInterval(this.daily);
    this.timer = this.daily = null;
  }

  private schedule() {
    if (this.sync) return this.run(() => this.drain());
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.run(() => this.drain());
    }, 200);
    this.timer.unref?.();
  }

  /** 唯一的出口：无论怎么炸，都只留一条日志。 */
  private run(work: () => void) {
    try {
      work();
    } catch (e) {
      console.error('[trace] 留痕写库失败', e);
    }
  }

  /**
   * 一批写完。顺序是**有意的**：先决策/动作，再结算行，最后回填 ——
   * 回填要改的正是这一批刚写进去的真人动作行，反过来就找不到行了。
   */
  private drain() {
    const decisions = this.decisions;
    const humans = this.humans;
    const outcomes = this.outcomes;
    // 先清空再写：写挂了这一批就丢掉，不会在下一次重试时再挂一遍
    this.decisions = [];
    this.humans = [];
    this.outcomes = [];
    this.store.insertDecisions(decisions);
    this.store.insertHumanActions(humans);
    for (const o of outcomes) {
      this.store.insertHandOutcome(o.row);
      this.store.backfillHumanStrength(o.row.room, o.row.handNo, o.backfill);
    }
  }

  private forget(room: string, handNo: number) {
    const prefix = `${room}:${handNo}:`;
    for (const k of this.beforeSettle.keys()) if (k.startsWith(prefix)) this.beforeSettle.delete(k);
  }
}

/** 会进 `zjh_human_actions` 的那几个动作：牌桌上真的做了一件事的那几个。 */
const TABLE_ACTIONS = new Set<GameCommand['type']>(['look', 'call', 'all_in', 'raise', 'fold', 'compare']);
