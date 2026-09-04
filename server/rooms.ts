import type { WebSocket } from 'ws';
import {
  AUTO_START_MS, botOffTurn, canAutoStart, CHIP_GRANT_VERSION, currentPlayer, DEFAULT_SETTINGS, GameError, memoryKey,
  mergeMemory, randomId, resetToLobby,
  ROUND_END_MS, startRound,
  ZJH_ECONOMY_VERSION,
  type GameCommand, type PlayerState, type RoomState,
} from '../shared/game.ts';
import {
  engine, engineFor, isSjRoom, zjhOffTurnDelay, GAME_KINDS, isGameKind,
  type AnyRoomState, type BotMove, type GameKind,
} from '../shared/games.ts';
import {
  closeDeclaring, finishDealing, SJ_DEAL_MS, SJ_HAND_END_MS, startNextHand, teamOf,
  type SjCommand, type SjRoomState,
} from '../shared/sj/engine.ts';
import type { AccountInfo, AnyGameCommand, GameEvent, ServerMsg } from '../shared/protocol.ts';
import { getBuildId } from './build.ts';
import { Store, type Account } from './store.ts';
import { TraceRecorder } from './trace.ts';

const ROOM_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 快照保留 3 天
const IDLE_DROP_MS = 30 * 60 * 1000; // 无人连接 30 分钟后从内存卸载
// 结算展示时长。前 ~3.2s 是牌桌上的开牌亮相（翻牌 → 牌型徽章 → 赢家金环金币），
// 之后才升起结算面板 —— 两拍都要看得完，所以这里给的是两段之和。
const MAX_ROOMS = 400;

const NOOP_COMMIT = () => {};

export interface Conn {
  ws: WebSocket;
  ip: string;
  code: string | null;
  playerId: string | null;
}

interface Room {
  state: AnyRoomState;
  conns: Set<Conn>;
  timer: NodeJS.Timeout | null;
  saveTimer: NodeJS.Timeout | null;
  touchedAt: number;
  /** 升级：已经把哪一局的战绩写回账户了，避免重复计数 */
  creditedHand: number;
  /** 炸金花：已经把哪一局的打法档案落库了，避免重复写 */
  memoryHand: number;
  /** 炸金花：已经把哪一局的结算留痕落库了，避免重复写（§4.11） */
  traceHand: number;
  /**
   * 上一次**牌局状态**变化的时刻，用来量真人「从看到局面到按下去」的真实耗时
   * （§4.11.1）。只有走过引擎的动作会刷它，见 `markChange`。
   */
  changedAt: number;
  /** 炸金花：已经从长期表里补过水的档案键 */
  memoryLoaded: Set<string>;
  /**
   * 炸金花：非回合动作的定时器，一个机器人一个（§4.6）。
   * 刻意**不**放进 `timer`：那一个是「牌桌的节拍」，`arm()` 每次都会把它清掉重排；
   * 这些是各人自己在旁边的反应，谁也不该因为别人行动了就被打断。
   */
  offTimers: Map<string, NodeJS.Timeout>;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function newToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return bytesToBase64Url(b);
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return bytesToBase64Url(new Uint8Array(digest));
}

function randomRoomCode(): string {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return String(100000 + (b[0] % 900000));
}

/** 变更前的完整状态。事件派生要的是「之前长什么样」，克隆一份最省心 */
function snapshot(state: AnyRoomState): AnyRoomState {
  return structuredClone(state);
}

/**
 * 牌桌指纹：只取「局面」相关的字段。
 *
 * 用来判断一条指令到底有没有动牌桌（§4.11.1 的用时起点，见 `Hub.markChange`）。
 * 刻意**不**收进来的：昵称、头像、在线状态、表情、`log` / `actionSeq`。
 * 这些都会广播出去，但一个正在想牌的人看到的牌桌一点没变 —— 对面边想边发表情
 * 是牌桌上最常见的事，让它去冲用时的时钟，会系统性地把反应时间压短。
 *
 * 用指纹而不是「哪些指令不算数」的名单：以后加了新指令，它改没改牌桌是自己算出来的，
 * 不需要有人记得回来改名单。
 */
function tableFingerprint(state: RoomState): string {
  return JSON.stringify([
    state.phase, state.handNo, state.roundNo, state.turnSeat, state.turnCount,
    state.dealerSeat, state.firstActorSeat, state.pot, state.betUnit,
    state.turnDeadline, state.compareUnlockAt, state.hostId, state.settings,
    state.allIn ?? null, state.nextAt ?? null,
    // 结算只取「谁赢、赢多少、谁亮了牌」—— 牌面不进指纹
    state.result ? [state.result.winnerId, state.result.potWon, state.result.revealed] : null,
    state.seen ?? null,
    state.players.map((p) => [
      p.id, p.seat, p.status, p.chips, p.bet, p.looked, p.bared, p.ready,
      p.lastAction ?? null, p.pendingLeave ?? false, p.handActions?.length ?? 0,
    ]),
  ]);
}

export class Hub {
  private rooms = new Map<string, Room>();

  private store: Store;

  /** 决策留痕（§4.11）。旁路，写挂了也不影响牌局。 */
  readonly trace: TraceRecorder;

  constructor(store: Store, trace?: TraceRecorder) {
    this.store = store;
    this.trace = trace ?? new TraceRecorder(store);
    let restored = 0;
    let chipMigrated = 0;
    let economyMigrated = 0;
    for (const raw of store.loadAll(ROOM_TTL_MS)) {
      const needsChipMigration = !isSjRoom(raw)
        && ((raw as RoomState).chipGrantVersion ?? 0) < CHIP_GRANT_VERSION;
      const needsEconomyMigration = !isSjRoom(raw)
        && ((raw as RoomState).economyVersion ?? 0) < ZJH_ECONOMY_VERSION;
      // 老快照可能缺新加的字段，先补齐再用；没有 kind 的一律是炸金花（DESIGN 2.6）
      const state = engineFor(raw).migrate(raw);
      // 重启后没有任何人是连着的；牌局停在原地等人回来。
      for (const p of state.players) if (!p.isBot) p.online = false;
      state.turnDeadline = null;
      this.rooms.set(state.code, {
        state, conns: new Set(), timer: null, saveTimer: null,
        touchedAt: Date.now(),
        // 重启前如果已经打完一局，账户那一笔早就写过了，别再记一次
        creditedHand: isSjRoom(state) ? (state.result?.handNo ?? 0) : 0,
        // 重启前那一局的档案早就落过库了，别再写一次
        memoryHand: isSjRoom(state) ? 0 : ((state as RoomState).handNo ?? 0),
        // 重启前那一局的留痕同理：队列早就跟着进程没了，别写半局
        traceHand: isSjRoom(state) ? 0 : ((state as RoomState).handNo ?? 0),
        memoryLoaded: new Set(),
        changedAt: Date.now(),
        offTimers: new Map(),
      });
      // 迁移后立即落盘，旧房间无需等待玩家重新进入或下一次操作。
      if (needsChipMigration || needsEconomyMigration) {
        store.save(state);
      }
      if (needsChipMigration) chipMigrated++;
      if (needsEconomyMigration) economyMigrated++;
      restored++;
    }
    if (restored) console.log(`[hub] 从快照恢复了 ${restored} 个房间`);
    if (chipMigrated) console.log(`[hub] 已升级 ${chipMigrated} 个旧炸金花房间的筹码基线`);
    if (economyMigrated) console.log(`[hub] 已升级 ${economyMigrated} 个旧炸金花房间的下注档位`);
    setInterval(() => this.sweep(), 60_000).unref();
  }

  /* --------------------------------------------------------------- 账户 */

  /** 旧账户只补一次到当前基线，chips/granted 同增，净战绩不变。 */
  private migrateAccountChips(account: Account): boolean {
    if ((account.chipGrantVersion ?? 0) >= CHIP_GRANT_VERSION) return false;
    const add = Math.max(0, DEFAULT_SETTINGS.startingChips - account.chips);
    account.chips += add;
    account.granted += add;
    account.chipGrantVersion = CHIP_GRANT_VERSION;
    return true;
  }

  /**
   * 认领或新建账户。带着有效凭证来就沿用同一个账户 ——
   * 换个房间、隔天再来都还是同一个自己，积分接着上次，而不是每次都是新人。
   */
  private async resolveAccount(id?: string, token?: string, name?: string, avatar?: string) {
    if (id && token) {
      const acc = this.store.getAccount(id);
      if (acc && (await hashToken(token)) === acc.tokenHash) {
        if (name) acc.name = name;
        if (avatar) acc.avatar = avatar;
        if (this.migrateAccountChips(acc)) this.store.saveAccount(acc);
        return { account: acc, token };
      }
    }
    const fresh = newToken();
    const account: Account = {
      id: randomId('acc'),
      tokenHash: await hashToken(fresh),
      name: name ?? '牌友',
      avatar: avatar ?? '🐯',
      chips: DEFAULT_SETTINGS.startingChips,
      granted: DEFAULT_SETTINGS.startingChips,
      hands: 0,
      wins: 0,
      sjHands: 0,
      sjWins: 0,
      chipGrantVersion: CHIP_GRANT_VERSION,
    };
    this.store.createAccount(account);
    return { account, token: fresh };
  }

  private accountInfo(a: Account, token: string): AccountInfo {
    return {
      id: a.id, token, chips: a.chips, granted: a.granted, hands: a.hands, wins: a.wins,
      sjHands: a.sjHands, sjWins: a.sjWins,
    };
  }

  /** 把牌桌上的积分和战绩写回账户。跟着房间快照一起防抖落盘。 */
  private syncAccounts(room: Room) {
    const s = room.state;
    if (isSjRoom(s)) {
      // 升级没有积分，只把昵称头像同步回去；局数与胜局在 hand_end 记（creditSj）
      for (const p of s.players) {
        if (!p.accountId || p.isBot) continue;
        const acc = this.store.getAccount(p.accountId);
        if (!acc) continue;
        acc.name = p.name;
        acc.avatar = p.avatar;
        this.migrateAccountChips(acc);
        this.store.saveAccount(acc);
      }
      return;
    }
    for (const p of (s as RoomState).players) {
      if (!p.accountId || p.isBot) continue;
      const acc = this.store.getAccount(p.accountId);
      if (!acc) continue;
      acc.chips = p.chips;
      acc.granted = p.granted;
      acc.name = p.name;
      acc.avatar = p.avatar;
      acc.wins = p.wins;
      acc.chipGrantVersion = CHIP_GRANT_VERSION;
      this.store.saveAccount(acc);
    }
  }

  /**
   * 升级的战绩写回（DESIGN 2.5 末句）。一局结束记一次：
   * 每个真人 `sj_hands + 1`，赢的那一队 `sj_wins + 1`。
   * 用 `creditedHand` 挡住重复 —— hand_end 会广播很多次，但只应该记一笔。
   */
  private creditSj(room: Room) {
    const s = room.state;
    if (!isSjRoom(s)) return;
    const r = s.result;
    if (!r || (s.phase !== 'hand_end' && s.phase !== 'match_end')) return;
    if (room.creditedHand >= r.handNo) return;
    room.creditedHand = r.handNo;
    const dealerTeam = teamOf(r.dealerSeat);
    const winnerTeam = r.outcome.defendersWin ? ((1 - dealerTeam) as 0 | 1) : dealerTeam;
    for (const p of s.players) {
      if (!p.accountId || p.isBot) continue;
      const acc = this.store.getAccount(p.accountId);
      if (!acc) continue;
      acc.sjHands += 1;
      if (teamOf(p.seat) === winnerTeam) acc.sjWins += 1;
      this.migrateAccountChips(acc);
      this.store.saveAccount(acc);
    }
  }

  /**
   * 炸金花的长期打法档案：从库里补水。
   *
   * 「老张一晚上只打三把」这件事隔天还该记得，所以档案按人（账户 / 机器人名字）存，
   * 不跟房间快照一起走。房间里已经有的（旧快照迁移出来的 reads）和库里的两边都留。
   */
  private hydrateZjhMemory(room: Room) {
    const s = room.state;
    if (isSjRoom(s)) return;
    const state = s as RoomState;
    for (const p of state.players) {
      const key = memoryKey(p);
      if (room.memoryLoaded.has(key)) continue;
      room.memoryLoaded.add(key);
      let stored: ReturnType<Store['loadMemory']> = null;
      try {
        stored = this.store.loadMemory(key);
      } catch (e) {
        console.error('[hub] 打法档案读取失败', e);
      }
      if (!stored) continue;
      state.memory ??= {};
      const pending = state.memory[key];
      state.memory[key] = pending ? mergeMemory(stored, pending) : stored;
    }
  }

  /** 一局打完把档案写回长期表。用 `memoryHand` 挡重复 —— round_end 会广播很多次。 */
  private creditZjhMemory(room: Room) {
    const s = room.state;
    if (isSjRoom(s)) return;
    const state = s as RoomState;
    if (state.phase !== 'round_end' || !state.result) return;
    if (room.memoryHand >= state.handNo) return;
    room.memoryHand = state.handNo;
    for (const p of state.players) {
      const mem = state.memory?.[memoryKey(p)];
      if (!mem) continue;
      try {
        this.store.saveMemory(mem);
      } catch (e) {
        console.error('[hub] 打法档案写入失败', e);
      }
    }
  }

  /**
   * 一局打完把结算留痕落库（§4.11.1 的 `zjh_hand_outcomes`）。
   * 跟 `creditZjhMemory` 一样靠局号挡重复，但用自己的闸门 —— 留痕坏了不该拖累档案，
   * 档案的闸门改了也不该悄悄改留痕的行为。
   */
  private traceZjhHand(room: Room) {
    const s = room.state;
    if (isSjRoom(s)) return;
    const state = s as RoomState;
    if (state.phase !== 'round_end' || !state.result) return;
    if (room.traceHand >= state.handNo) return;
    room.traceHand = state.handNo;
    this.trace.hand(state);
  }

  /**
   * 牌局状态真的动了。§4.11.1 里真人的用时是「从上一次**状态变化**到动作」，
   * 所以只有走过引擎的那几条路（真人指令、机器人落子、非回合动作、超时弃牌、
   * 开局 / 新一局）才刷这个时钟。上下线、进房、房主移交同样会广播，但牌桌没变，
   * 一个正在想牌的人不该因为别人掉了个线就被当成「刚看到局面」。
   */
  private markChange(room: Room) {
    room.changedAt = Date.now();
  }

  /**
   * 走过引擎、但不一定动了牌桌的那一条路（`command()`）。表情就是典型：
   * 它是一条正经指令、会广播、也会进快照，可牌桌一张牌都没动。拿指纹比一比，
   * 真变了才刷时钟。升级（sj）不走留痕，这口钟没人读，照旧刷。
   */
  private markIfTableChanged(room: Room, before: AnyRoomState) {
    if (isSjRoom(room.state) || isSjRoom(before)) return this.markChange(room);
    if (tableFingerprint(before as RoomState) !== tableFingerprint(room.state as RoomState)) {
      this.markChange(room);
    }
  }

  /**
   * 真人动作的取样口（§4.11.1）。**在 `eng.apply` 之前**调用，返回的函数在动作
   * 真的生效之后再调 —— 指令被引擎拒掉时什么都不该落库。
   */
  private traceHumanCommand(room: Room, actorId: string, cmd: AnyGameCommand): () => void {
    if (isSjRoom(room.state)) return NOOP_COMMIT;
    const s = room.state as RoomState;
    const me: PlayerState | undefined = s.players.find((p) => p.id === actorId);
    if (!me) return NOOP_COMMIT;
    return this.trace.human(s, me, cmd as GameCommand, Date.now() - room.changedAt);
  }

  /* ------------------------------------------------------------- 生命周期 */

  private sweep() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      if (room.conns.size === 0 && now - room.touchedAt > IDLE_DROP_MS) {
        this.clearTimers(room);
        this.rooms.delete(code);
      }
    }
    const purged = this.store.purge(ROOM_TTL_MS);
    if (purged) console.log(`[hub] 清理了 ${purged} 条过期房间快照`);
  }

  private clearTimers(room: Room) {
    if (room.timer) clearTimeout(room.timer);
    if (room.saveTimer) clearTimeout(room.saveTimer);
    room.timer = room.saveTimer = null;
    this.clearOffTimers(room);
  }

  private clearOffTimers(room: Room) {
    for (const t of room.offTimers.values()) clearTimeout(t);
    room.offTimers.clear();
  }

  /**
   * 把所有还压在防抖定时器里的快照立刻写完。上线重启前必须调用一次，
   * 否则最后那几步操作会随进程一起消失，玩家回来看到的是几秒钟之前的牌桌。
   */
  flush() {
    for (const room of this.rooms.values()) {
      if (!room.saveTimer) continue;
      clearTimeout(room.saveTimer);
      room.saveTimer = null;
      try {
        this.store.save(room.state);
        this.syncAccounts(room);
      } catch (e) {
        console.error('[hub] 关机前的快照写入失败', e);
      }
    }
  }

  private save(room: Room) {
    if (room.saveTimer) return;
    room.saveTimer = setTimeout(() => {
      room.saveTimer = null;
      try {
        this.store.save(room.state);
        this.syncAccounts(room);
      } catch (e) {
        console.error('[hub] 快照写入失败', e);
      }
    }, 250);
    room.saveTimer.unref?.();
  }

  /* ----------------------------------------------------------- 消息与广播 */

  send(conn: Conn, msg: ServerMsg) {
    if (conn.ws.readyState !== conn.ws.OPEN) return;
    conn.ws.send(JSON.stringify(msg));
  }

  private broadcast(room: Room, events: GameEvent[] = []) {
    room.touchedAt = Date.now();
    this.creditSj(room);
    this.hydrateZjhMemory(room);
    this.creditZjhMemory(room);
    this.traceZjhHand(room);
    const eng = engineFor(room.state);
    for (const conn of [...room.conns]) {
      if (!conn.playerId) continue;
      // 被房主移出或自己退出的人，明确告知一次而不是让页面空转
      if (!room.state.players.some((p) => p.id === conn.playerId)) {
        this.send(conn, { t: 'error', msg: '你已不在这个房间了', fatal: true });
        room.conns.delete(conn);
        conn.code = null;
        conn.playerId = null;
        continue;
      }
      // 每个人看到的是自己的视角：别人的暗牌根本不会离开这个进程。
      this.send(conn, { t: 'room', room: eng.sanitize(room.state, conn.playerId), events });
    }
    this.save(room);
  }

  /* -------------------------------------------------------------- 定时器 */

  private later(room: Room, delay: number, run: () => void) {
    room.timer = setTimeout(run, delay);
    room.timer.unref?.();
  }

  /**
   * 每次状态变化后重排定时器。这是整个实时体验的心脏：
   * 机器人带延迟行动、真人有倒计时、结算后自动续局，全在这里收口。
   */
  private arm(room: Room) {
    if (room.timer) clearTimeout(room.timer);
    room.timer = null;
    if (isSjRoom(room.state)) return this.armSj(room);
    const s = room.state as RoomState;

    if (s.phase === 'playing') {
      const move = engine('zjh').bot(s);
      if (move) {
        this.later(room, move.delay, () => this.runZjhBot(room, move));
      } else if (currentPlayer(s)) {
        const wait = Math.max(400, (s.turnDeadline ?? Date.now()) - Date.now());
        this.later(room, wait, () => this.onTurnTimeout(room));
      }
    } else if (s.phase === 'round_end') {
      this.later(room, ROUND_END_MS, () => this.onRoundEnd(room));
    } else if (canAutoStart(s)) {
      this.later(room, AUTO_START_MS, () => this.onAutoStart(room));
    }
  }

  private runZjhBot(room: Room, move: BotMove) {
    const s = room.state as RoomState;
    const cur = currentPlayer(s);
    if (!cur || cur.id !== move.actorId) return this.arm(room);
    const eng = engine('zjh');
    const before = snapshot(s);
    try {
      // 用时进事件流：机器人这一步「想了多久」就是 Hub 给它排的延迟（§4.8 / S17）
      eng.apply(s, move.actorId, move.cmd, { spentMs: move.delay });
    } catch {
      // 决策与状态对不上（比如刚被人比牌出局）就退回弃牌，绝不让牌桌卡住
      try {
        eng.apply(s, move.actorId, { type: 'fold' });
      } catch (e) {
        console.error('[hub] 机器人无法行动', e);
        return this.arm(room);
      }
    }
    this.markChange(room);
    this.trace.bot(s, move.record, move.cmd as GameCommand);
    this.broadcast(room, eng.deriveEvents(before, s, move.actorId, move.cmd));
    this.arm(room);
    this.offTurnHook(room, move.actorId, move.cmd);
  }

  /* -------------------------------------------------- 非回合动作（§4.6 / S3 / S4） */

  /**
   * 有人把赌注抬高之后，桌上其他人不会安静地等到自己那一轮 —— 手里是散牌的当场就退，
   * 想看牌的当场就看。看牌和弃牌在引擎里都不占行动权，所以这两件事真的可以现在做。
   *
   * 触发条件写成**事件的形状**（有人加档、有人梭哈），不是「涨到某个数」：
   * 多大算响、响到什么程度值得反应，是人物卡和当时情绪的事，不是服务端的事。
   */
  private offTurnHook(room: Room, actorId: string, cmd: AnyGameCommand | null) {
    if (isSjRoom(room.state)) return;
    if (!cmd || (cmd.type !== 'raise' && cmd.type !== 'all_in')) return;
    const s = room.state as RoomState;
    if (s.phase !== 'playing') return;
    for (const p of s.players) {
      if (!p.isBot || p.status !== 'active' || p.id === actorId) continue;
      if (room.offTimers.has(p.id)) continue;
      const id = p.id;
      // 各人反应快慢不同，也不该整齐划一地同时动（§4.6：独立的 300–900ms）
      const t = setTimeout(() => {
        room.offTimers.delete(id);
        this.runOffTurn(room, id);
      }, zjhOffTurnDelay());
      t.unref?.();
      room.offTimers.set(id, t);
    }
  }

  private runOffTurn(room: Room, playerId: string) {
    if (isSjRoom(room.state)) return;
    const s = room.state as RoomState;
    if (s.phase !== 'playing') return;
    const me = s.players.find((p) => p.id === playerId);
    // 这几百毫秒里牌桌可能已经变了：局结束了、他被比掉了、或者轮到他自己了
    if (!me || !me.isBot || me.status !== 'active') return;
    let act;
    try {
      act = botOffTurn(s, me);
    } catch (e) {
      return console.error('[hub] 非回合决策失败', e);
    }
    if (!act) return;
    const eng = engine('zjh');
    const before = snapshot(s);
    try {
      eng.apply(s, playerId, act.cmd, { spentMs: act.thinkMs });
    } catch {
      // 抢跑撞上了引擎规则（比如同一瞬间局已经结束）—— 当作没发生，绝不退回弃牌：
      // 非回合动作是「顺手做的事」，做不成就不做，不能因此替他丢掉一手牌。
      return;
    }
    this.markChange(room);
    this.trace.bot(s, act.record, act.cmd);
    this.broadcast(room, eng.deriveEvents(before, s, playerId, act.cmd));
    this.arm(room);
  }

  private onTurnTimeout(room: Room) {
    const s = room.state as RoomState;
    if (s.turnDeadline && Date.now() < s.turnDeadline - 100) return this.arm(room);
    const eng = engine('zjh');
    const cur = currentPlayer(s);
    const before = snapshot(s);
    if (eng.timeout(s)) {
      this.markChange(room);
      this.broadcast(room, cur ? eng.deriveEvents(before, s, cur.id, { type: 'fold' }) : []);
    }
    this.arm(room);
  }

  private onRoundEnd(room: Room) {
    const s = room.state as RoomState;
    if (s.phase !== 'round_end') return this.arm(room);
    const before = snapshot(s);
    resetToLobby(s);
    this.markChange(room);
    this.broadcast(room, engine('zjh').deriveEvents(before, s, '', null));
    this.arm(room);
  }

  private onAutoStart(room: Room) {
    const s = room.state as RoomState;
    if (!canAutoStart(s)) return this.arm(room);
    const before = snapshot(s);
    try {
      startRound(s, null);
    } catch {
      return this.arm(room);
    }
    this.markChange(room);
    this.broadcast(room, engine('zjh').deriveEvents(before, s, '', null));
    this.arm(room);
  }

  /* ------------------------------------------------------ 升级的节拍（2.5） */

  /**
   * 升级的定时表（DESIGN 2.5）：
   * dealing 10.6s（其间随时可亮主）→ declaring 3s / 无人亮时 8s（每次有效亮主 +2s）
   * → kou 45s → chao 每人 12s（有人抄成就回 kou 重扣，扣完接着问）
   * → 出牌 turnSeconds → hand_end 9s；机器人思考时长见 BRAIN-DESIGN §7。
   */
  private armSj(room: Room) {
    const s = room.state as SjRoomState;
    const now = Date.now();
    const eng = engineFor(s);

    if (s.phase === 'dealing') {
      const at = (s.dealStartedAt ?? now) + SJ_DEAL_MS;
      // 电脑也是**边发边亮**的：牌一张一张进手，够档了就当场拍下去（BRAIN-DESIGN §5.1）。
      // 只有那一刻还在发牌窗口里才排；晚于发完就交给 declaring 阶段兜底。
      const move = eng.bot(s);
      if (move && now + move.delay < at) {
        return this.later(room, Math.max(0, move.delay), () => this.runSjBot(room, move));
      }
      return this.later(room, Math.max(60, at - now), () => this.sjStep(room, finishDealing));
    }
    if (s.phase === 'declaring') {
      // 还没表态的电脑先各自决定一次，之后才等窗口自然到点
      const move = eng.bot(s);
      if (move) return this.later(room, move.delay, () => this.runSjBot(room, move));
      const at = s.declareEndsAt ?? now;
      return this.later(room, Math.max(120, at - now), () => this.sjStep(room, closeDeclaring));
    }
    if (s.phase === 'kou' || s.phase === 'chao' || s.phase === 'playing') {
      // 掉线的人也走这条路：轮到他直接由机器人代打，不等倒计时（DESIGN 1.9）
      const move = eng.bot(s);
      if (move) return this.later(room, move.delay, () => this.runSjBot(room, move));
      const at = s.turnDeadline ?? now;
      return this.later(room, Math.max(400, at - now), () => this.onSjTimeout(room));
    }
    if (s.phase === 'hand_end' && s.settings.autoContinue) {
      const at = s.turnDeadline ?? now + SJ_HAND_END_MS;
      return this.later(room, Math.max(200, at - now), () => this.sjStep(room, startNextHand));
    }
  }

  /** 不由玩家指令触发的阶段推进（发牌结束、亮主窗口关闭、自动续局） */
  private sjStep(room: Room, step: (state: SjRoomState) => void) {
    const s = room.state as SjRoomState;
    const before = snapshot(s);
    try {
      step(s);
    } catch (e) {
      console.error('[hub] 升级阶段推进失败', e);
      return this.arm(room);
    }
    this.broadcast(room, engineFor(s).deriveEvents(before, s, '', null));
    this.arm(room);
  }

  private runSjBot(room: Room, move: BotMove) {
    const s = room.state as SjRoomState;
    const eng = engineFor(s);
    const before = snapshot(s);
    try {
      eng.apply(s, move.actorId, move.cmd);
    } catch {
      // 决策和状态对不上时退回一个一定合法的动作，绝不让牌桌卡死
      try {
        // 发牌途中亮失败（比如被别人抢先反了）就退回"等发完"，这里绝不能 pass ——
        // 一 pass 等于替他放弃了整个亮主窗口。也不能只 arm：那会立刻算出同一步再失败一次。
        if (s.phase === 'dealing') {
          const at = (s.dealStartedAt ?? Date.now()) + SJ_DEAL_MS;
          return this.later(room, Math.max(60, at - Date.now()), () => this.sjStep(room, finishDealing));
        }
        if (s.phase === 'declaring') eng.apply(s, move.actorId, { type: 'pass' } satisfies SjCommand);
        else if (s.phase === 'chao') eng.apply(s, move.actorId, { type: 'pass_chao' } satisfies SjCommand);
        else if (eng.timeout(s)) {
          /* 由超时逻辑接管这一步 */
        } else return this.arm(room);
      } catch (e) {
        console.error('[hub] 升级机器人无法行动', e);
        return this.arm(room);
      }
    }
    this.broadcast(room, eng.deriveEvents(before, s, move.actorId, move.cmd));
    this.arm(room);
  }

  private onSjTimeout(room: Room) {
    const s = room.state as SjRoomState;
    if (s.turnDeadline && Date.now() < s.turnDeadline - 100) return this.arm(room);
    const eng = engineFor(s);
    // 扣底看 kouSeat（抄底之后不一定是庄家）、抄底询问看 chaoSeat，其余看 turnSeat
    const seat = s.phase === 'kou' ? s.kouSeat : s.phase === 'chao' ? s.chaoSeat : s.turnSeat;
    const actor = s.players.find((p) => p.seat === seat);
    const before = snapshot(s);
    // 事件派生只看 cmd 的 type（出的是哪几张牌从手牌差里算），所以这里给个空壳就够
    const cmd: SjCommand = s.phase === 'kou'
      ? { type: 'kou', cardIds: [] }
      : s.phase === 'chao' ? { type: 'pass_chao' } : { type: 'play', cardIds: [] };
    try {
      if (!eng.timeout(s)) return this.arm(room);
    } catch (e) {
      console.error('[hub] 升级超时代打失败', e);
      return this.arm(room);
    }
    this.broadcast(room, eng.deriveEvents(before, s, actor?.id ?? '', cmd));
    this.arm(room);
  }

  /* ------------------------------------------------------------ 房间入口 */

  private room(code: string): Room {
    const room = this.rooms.get(code);
    if (!room) throw new GameError('房间不存在或已过期', 404);
    return room;
  }

  async create(
    conn: Conn, kind: GameKind, name: string, avatar: string, agent = false,
    accountId?: string, accountToken?: string,
  ) {
    if (this.rooms.size >= MAX_ROOMS) throw new GameError('服务器房间已满，请稍后再试', 503);
    if (!isGameKind(kind)) throw new GameError('未知的游戏类型');
    const { account, token: accTok } = await this.resolveAccount(accountId, accountToken, name, avatar);
    const token = newToken();
    const hash = await hashToken(token);
    let code = '';
    for (let i = 0; i < 20 && !code; i++) {
      const candidate = randomRoomCode();
      if (!this.rooms.has(candidate)) code = candidate;
    }
    if (!code) throw new GameError('创建房间失败，请重试', 503);

    const eng = engine(kind);
    const { state, playerId } = eng.create(code, {
      name: account.name, avatar: account.avatar, tokenHash: hash, agent,
      accountId: account.id, chips: account.chips, granted: account.granted, wins: account.wins,
    });
    const room: Room = {
      state, conns: new Set(), timer: null, saveTimer: null,
      touchedAt: Date.now(), creditedHand: 0, memoryHand: 0, traceHand: 0, memoryLoaded: new Set(),
      changedAt: Date.now(), offTimers: new Map(),
    };
    this.rooms.set(code, room);
    this.attach(conn, room, playerId);
    this.send(conn, {
      t: 'welcome', code, playerId, token, build: getBuildId(),
      room: eng.sanitize(state, playerId),
      account: this.accountInfo(account, accTok),
    });
    this.broadcast(room);
  }

  async join(conn: Conn, code: string, name: string, avatar: string, agent = false, accountId?: string, accountToken?: string) {
    const room = this.room(code);
    const s = room.state;
    const eng = engineFor(s);
    const { account, token: accTok } = await this.resolveAccount(accountId, accountToken, name, avatar);
    const token = newToken();
    const hash = await hashToken(token);
    const playerId = eng.join(s, {
      name: account.name, avatar: account.avatar, tokenHash: hash, agent,
      accountId: account.id, chips: account.chips, granted: account.granted, wins: account.wins,
    });

    this.attach(conn, room, playerId);
    this.send(conn, {
      t: 'welcome', code, playerId, token, build: getBuildId(),
      room: eng.sanitize(s, playerId),
      account: this.accountInfo(account, accTok),
    });
    this.broadcast(room);
    this.arm(room);
  }

  async resume(conn: Conn, code: string, playerId: string, token: string) {
    const room = this.room(code);
    const eng = engineFor(room.state);
    const player = room.state.players.find((p) => p.id === playerId && !p.isBot);
    if (!player?.tokenHash) throw new GameError('房间里已经没有你的座位了，请重新加入', 401);
    if ((await hashToken(token)) !== player.tokenHash) throw new GameError('登录凭证无效，请重新加入房间', 401);
    player.online = true;
    player.pendingLeave = undefined;
    // 全场只剩电脑时房主会空出来，谁回来谁接手
    const host = room.state.players.find((p) => p.id === room.state.hostId);
    if (!host || host.isBot) room.state.hostId = playerId;
    this.attach(conn, room, playerId);
    this.send(conn, { t: 'welcome', code, playerId, token, build: getBuildId(), room: eng.sanitize(room.state, playerId) });
    this.broadcast(room, [{ k: 'presence', playerId, online: true }]);
    this.arm(room);
  }

  command(conn: Conn, cmd: AnyGameCommand) {
    if (!conn.code || !conn.playerId) throw new GameError('尚未加入房间', 401);
    const room = this.room(conn.code);
    const eng = engineFor(room.state);
    if (!cmd || typeof cmd.type !== 'string' || !eng.commandTypes().has(cmd.type)) throw new GameError('操作无效');
    const actorId = conn.playerId;
    const before = snapshot(room.state);
    const commitTrace = this.traceHumanCommand(room, actorId, cmd);
    eng.apply(room.state, actorId, cmd);
    this.markIfTableChanged(room, before);
    const events = eng.deriveEvents(before, room.state, actorId, cmd);
    commitTrace();

    if (cmd.type === 'leave') {
      const stillSeated = room.state.players.some((p) => p.id === actorId);
      this.detach(conn, !stillSeated);
      conn.code = null;
      conn.playerId = null;
    }
    this.broadcast(room, events);
    this.arm(room);
    this.offTurnHook(room, actorId, cmd);
  }

  /* ---------------------------------------------------------- 连接与在线 */

  private attach(conn: Conn, room: Room, playerId: string) {
    // 同一个人可能在手机和电脑各开一个页面，两边都要收到推送
    conn.code = room.state.code;
    conn.playerId = playerId;
    room.conns.add(conn);
    room.touchedAt = Date.now();
  }

  detach(conn: Conn, silent = false) {
    if (!conn.code) return;
    const room = this.rooms.get(conn.code);
    if (!room) return;
    room.conns.delete(conn);
    const playerId = conn.playerId;
    if (!playerId) return;

    // 同一个玩家还有别的页面开着就不算掉线
    const stillConnected = [...room.conns].some((c) => c.playerId === playerId);
    const player = room.state.players.find((p) => p.id === playerId);
    if (!player || stillConnected) return;

    player.online = false;
    if (!silent) {
      /*
       * 房主掉线**立刻**移交给在线真人（入座最早的那个）。
       *
       * 以前这里挂着 20 秒宽限期：那 20 秒里开下一局、加电脑、改房规、点「继续」
       * 全要房主点，桌上的人只能干等一个已经不在的人。宽限期换来的只是
       * 「原房主几秒内回来还是房主」，代价是整桌卡住 —— 不值。
       * 原房主重连也不会夺回房主（`resume` 只在房主空缺或落在电脑身上时才认领），
       * 免得房主在两个人之间来回跳。
       */
      if (room.state.hostId === playerId) engineFor(room.state).transferHost(room.state, playerId);
    }
    if (!silent) this.broadcast(room, [{ k: 'presence', playerId, online: false }]);
    this.arm(room);
  }

  stats() {
    let players = 0;
    let conns = 0;
    const kinds = Object.fromEntries(GAME_KINDS.map((k) => [k, 0])) as Record<GameKind, number>;
    for (const room of this.rooms.values()) {
      players += room.state.players.filter((p) => !p.isBot).length;
      conns += room.conns.size;
      const kind = room.state.kind as GameKind;
      if (kind in kinds) kinds[kind] += 1;
    }
    return { rooms: this.rooms.size, players, conns, kinds };
  }
}
