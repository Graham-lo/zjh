import type { WebSocket } from 'ws';
import {
  applyCommand, botDecision, canAutoStart, claimHostIfVacant, cleanAvatar, cleanName,
  createHumanPlayer, createInitialRoom, currentPlayer, DEFAULT_SETTINGS, GameError, migrateRoom,
  randomId, resetToLobby, sanitizeRoom, startRound,
  timeoutCurrentPlayer, transferHost, COMMAND_TYPES,
  type GameCommand, type RoomState,
} from '../shared/game.ts';
import type { AccountInfo, GameEvent, ServerMsg } from '../shared/protocol.ts';
import { Store, type Account } from './store.ts';

const ROOM_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 快照保留 3 天
const IDLE_DROP_MS = 30 * 60 * 1000; // 无人连接 30 分钟后从内存卸载
const ROUND_END_MS = 7000; // 结算展示时长
const AUTO_START_MS = 2500; // 自动续局前的缓冲
const HOST_GRACE_MS = 20_000; // 房主掉线多久后移交
const MAX_ROOMS = 400;

export interface Conn {
  ws: WebSocket;
  ip: string;
  code: string | null;
  playerId: string | null;
}

interface Room {
  state: RoomState;
  conns: Set<Conn>;
  timer: NodeJS.Timeout | null;
  hostTimer: NodeJS.Timeout | null;
  saveTimer: NodeJS.Timeout | null;
  touchedAt: number;
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

/** 机器人"思考"时长。看牌是个小动作，给短一点，避免节奏拖沓。 */
function botDelay(cmd: GameCommand): number {
  const base = cmd.type === 'look' ? 320 : 620;
  return base + Math.floor(Math.random() * (cmd.type === 'look' ? 260 : 900));
}

interface Snapshot {
  pot: number;
  phase: string;
  handNo: number;
  turnSeat: number | null;
  chatSeq: number;
  /** 变更前是否处在梭哈表态中 —— 用来把「跟注」区分成「接梭哈」 */
  allIn: boolean;
}

export class Hub {
  private rooms = new Map<string, Room>();

  private store: Store;

  constructor(store: Store) {
    this.store = store;
    let restored = 0;
    for (const raw of store.loadAll(ROOM_TTL_MS)) {
      // 老快照可能缺新加的字段，先补齐再用
      const state = migrateRoom(raw);
      // 重启后没有任何人是连着的；牌局停在原地等人回来。
      for (const p of state.players) if (!p.isBot) p.online = false;
      state.turnDeadline = null;
      this.rooms.set(state.code, { state, conns: new Set(), timer: null, hostTimer: null, saveTimer: null, touchedAt: Date.now() });
      restored++;
    }
    if (restored) console.log(`[hub] 从快照恢复了 ${restored} 个房间`);
    setInterval(() => this.sweep(), 60_000).unref();
  }

  /* --------------------------------------------------------------- 账户 */

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
    };
    this.store.createAccount(account);
    return { account, token: fresh };
  }

  private accountInfo(a: Account, token: string): AccountInfo {
    return { id: a.id, token, chips: a.chips, granted: a.granted, hands: a.hands, wins: a.wins };
  }

  /** 把牌桌上的积分和战绩写回账户。跟着房间快照一起防抖落盘。 */
  private syncAccounts(room: Room) {
    for (const p of room.state.players) {
      if (!p.accountId || p.isBot) continue;
      const acc = this.store.getAccount(p.accountId);
      if (!acc) continue;
      acc.chips = p.chips;
      acc.granted = p.granted;
      acc.name = p.name;
      acc.avatar = p.avatar;
      acc.wins = p.wins;
      this.store.saveAccount(acc);
    }
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
    if (room.hostTimer) clearTimeout(room.hostTimer);
    if (room.saveTimer) clearTimeout(room.saveTimer);
    room.timer = room.hostTimer = room.saveTimer = null;
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
      this.send(conn, { t: 'room', room: sanitizeRoom(room.state, conn.playerId), events });
    }
    this.save(room);
  }

  private snapshot(state: RoomState): Snapshot {
    return {
      pot: state.pot,
      phase: state.phase,
      handNo: state.handNo,
      turnSeat: state.turnSeat,
      chatSeq: state.chat.at(-1)?.seq ?? 0,
      allIn: !!state.allIn,
    };
  }

  private deriveEvents(before: Snapshot, state: RoomState, actorId: string, cmd: GameCommand | null): GameEvent[] {
    const events: GameEvent[] = [];
    if (cmd) {
      const spent = state.pot - before.pot;
      if (spent > 0 && (cmd.type === 'call' || cmd.type === 'raise' || cmd.type === 'all_in' || cmd.type === 'compare')) {
        // 表态阶段的「跟注」其实是接梭哈，播报要不一样
        const kind = cmd.type === 'call' && before.allIn ? 'accept' : cmd.type;
        events.push({ k: 'bet', playerId: actorId, amount: spent, kind });
      }
      if (cmd.type === 'look') events.push({ k: 'look', playerId: actorId });
      if (cmd.type === 'fold') events.push({ k: 'fold', playerId: actorId });
      if (cmd.type === 'emote') events.push({ k: 'emote', playerId: actorId, id: cmd.id });
    }
    const lastChat = state.chat.at(-1);
    if (lastChat && lastChat.seq > before.chatSeq) events.push({ k: 'chat', seq: lastChat.seq });

    if (state.phase === 'playing' && (before.phase !== 'playing' || state.handNo !== before.handNo)) {
      events.push({ k: 'deal', handNo: state.handNo, seats: state.players.filter((p) => p.status === 'active').map((p) => p.seat) });
    }
    if (state.phase === 'round_end' && before.phase !== 'round_end' && state.result) {
      if (state.result.revealed.length > 1) events.push({ k: 'showdown', winnerId: state.result.winnerId });
      events.push({ k: 'win', playerId: state.result.winnerId, amount: state.result.potWon });
    }
    if (state.phase === 'playing' && state.turnSeat !== before.turnSeat) {
      const cur = currentPlayer(state);
      if (cur) events.push({ k: 'turn', playerId: cur.id });
    }
    return events;
  }

  /* -------------------------------------------------------------- 定时器 */

  /**
   * 每次状态变化后重排定时器。这是整个实时体验的心脏：
   * 机器人带延迟行动、真人有倒计时、结算后自动续局，全在这里收口。
   */
  private arm(room: Room) {
    if (room.timer) clearTimeout(room.timer);
    room.timer = null;
    const s = room.state;

    if (s.phase === 'playing') {
      const cur = currentPlayer(s);
      if (!cur) return;
      if (cur.isBot) {
        let cmd: GameCommand;
        try {
          cmd = botDecision(s, cur);
        } catch {
          cmd = { type: 'fold' };
        }
        room.timer = setTimeout(() => this.runBot(room, cur.id, cmd), botDelay(cmd));
      } else {
        const wait = Math.max(400, (s.turnDeadline ?? Date.now()) - Date.now());
        room.timer = setTimeout(() => this.onTurnTimeout(room), wait);
      }
    } else if (s.phase === 'round_end') {
      room.timer = setTimeout(() => this.onRoundEnd(room), ROUND_END_MS);
    } else if (canAutoStart(s)) {
      room.timer = setTimeout(() => this.onAutoStart(room), AUTO_START_MS);
    }
    room.timer?.unref?.();
  }

  private runBot(room: Room, botId: string, cmd: GameCommand) {
    const s = room.state;
    const cur = currentPlayer(s);
    if (!cur || cur.id !== botId) return this.arm(room);
    const before = this.snapshot(s);
    try {
      applyCommand(s, botId, cmd);
    } catch {
      // 决策与状态对不上（比如刚被人比牌出局）就退回弃牌，绝不让牌桌卡住
      try {
        applyCommand(s, botId, { type: 'fold' });
      } catch (e) {
        console.error('[hub] 机器人无法行动', e);
        return this.arm(room);
      }
    }
    this.broadcast(room, this.deriveEvents(before, s, botId, cmd));
    this.arm(room);
  }

  private onTurnTimeout(room: Room) {
    const s = room.state;
    if (s.turnDeadline && Date.now() < s.turnDeadline - 100) return this.arm(room);
    const cur = currentPlayer(s);
    const before = this.snapshot(s);
    if (timeoutCurrentPlayer(s)) {
      this.broadcast(room, cur ? this.deriveEvents(before, s, cur.id, { type: 'fold' }) : []);
    }
    this.arm(room);
  }

  private onRoundEnd(room: Room) {
    if (room.state.phase !== 'round_end') return this.arm(room);
    const before = this.snapshot(room.state);
    resetToLobby(room.state);
    this.broadcast(room, this.deriveEvents(before, room.state, '', null));
    this.arm(room);
  }

  private onAutoStart(room: Room) {
    if (!canAutoStart(room.state)) return this.arm(room);
    const before = this.snapshot(room.state);
    try {
      startRound(room.state, null);
    } catch {
      return this.arm(room);
    }
    this.broadcast(room, this.deriveEvents(before, room.state, '', null));
    this.arm(room);
  }

  /* ------------------------------------------------------------ 房间入口 */

  private room(code: string): Room {
    const room = this.rooms.get(code);
    if (!room) throw new GameError('房间不存在或已过期', 404);
    return room;
  }

  async create(conn: Conn, name: string, avatar: string, agent = false, accountId?: string, accountToken?: string) {
    if (this.rooms.size >= MAX_ROOMS) throw new GameError('服务器房间已满，请稍后再试', 503);
    const { account, token: accTok } = await this.resolveAccount(accountId, accountToken, name, avatar);
    const token = newToken();
    const hash = await hashToken(token);
    let code = '';
    for (let i = 0; i < 20 && !code; i++) {
      const candidate = randomRoomCode();
      if (!this.rooms.has(candidate)) code = candidate;
    }
    if (!code) throw new GameError('创建房间失败，请重试', 503);

    const host = createHumanPlayer(account.name, account.avatar, 0, hash, agent);
    host.accountId = account.id;
    host.chips = account.chips;
    host.granted = account.granted;
    host.wins = account.wins;
    const state = createInitialRoom(code, host);
    const room: Room = { state, conns: new Set(), timer: null, hostTimer: null, saveTimer: null, touchedAt: Date.now() };
    this.rooms.set(code, room);
    this.attach(conn, room, host.id);
    this.send(conn, {
      t: 'welcome', code, playerId: host.id, token,
      room: sanitizeRoom(state, host.id),
      account: this.accountInfo(account, accTok),
    });
    this.broadcast(room);
  }

  async join(conn: Conn, code: string, name: string, avatar: string, agent = false, accountId?: string, accountToken?: string) {
    const room = this.room(code);
    const s = room.state;
    if (s.players.length >= s.settings.maxPlayers) throw new GameError('房间已满');
    const { account, token: accTok } = await this.resolveAccount(accountId, accountToken, name, avatar);
    // 同一个账户不该在一张桌子上占两个座位
    if (s.players.some((p) => p.accountId === account.id)) {
      throw new GameError('你已经在这个房间里了，直接用原来的窗口继续', 409);
    }
    const token = newToken();
    const hash = await hashToken(token);
    const used = new Set(s.players.map((p) => p.seat));
    let seat = 0;
    while (used.has(seat)) seat++;

    let finalName = cleanName(account.name);
    if (s.players.some((p) => p.name === finalName)) finalName = `${finalName}·${seat + 1}`;
    const player = createHumanPlayer(finalName, cleanAvatar(account.avatar), seat, hash, agent);
    player.accountId = account.id;
    player.chips = account.chips;
    player.granted = account.granted;
    player.wins = account.wins;
    s.players.push(player);
    claimHostIfVacant(s, player.id);
    const suffix = s.phase === 'playing' ? '，等待下一局' : '';
    // 直接落日志而不是走命令，避免把"加入"塞进游戏状态机
    s.actionSeq += 1;
    s.log.push({ seq: s.actionSeq, at: Date.now(), text: `${player.name} 加入房间${suffix}` });

    this.attach(conn, room, player.id);
    this.send(conn, {
      t: 'welcome', code, playerId: player.id, token,
      room: sanitizeRoom(s, player.id),
      account: this.accountInfo(account, accTok),
    });
    this.broadcast(room);
    this.arm(room);
  }

  async resume(conn: Conn, code: string, playerId: string, token: string) {
    const room = this.room(code);
    const player = room.state.players.find((p) => p.id === playerId && !p.isBot);
    if (!player?.tokenHash) throw new GameError('房间里已经没有你的座位了，请重新加入', 401);
    if ((await hashToken(token)) !== player.tokenHash) throw new GameError('登录凭证无效，请重新加入房间', 401);
    player.online = true;
    player.pendingLeave = undefined;
    // 全场只剩电脑时房主会空出来，谁回来谁接手
    claimHostIfVacant(room.state, playerId);
    this.attach(conn, room, playerId);
    this.send(conn, { t: 'welcome', code, playerId, token, room: sanitizeRoom(room.state, playerId) });
    if (room.hostTimer) {
      clearTimeout(room.hostTimer);
      room.hostTimer = null;
    }
    this.broadcast(room, [{ k: 'presence', playerId, online: true }]);
    this.arm(room);
  }

  command(conn: Conn, cmd: GameCommand) {
    if (!conn.code || !conn.playerId) throw new GameError('尚未加入房间', 401);
    if (!cmd || typeof cmd.type !== 'string' || !COMMAND_TYPES.has(cmd.type)) throw new GameError('操作无效');
    const room = this.room(conn.code);
    const actorId = conn.playerId;
    const before = this.snapshot(room.state);
    applyCommand(room.state, actorId, cmd);
    const events = this.deriveEvents(before, room.state, actorId, cmd);

    if (cmd.type === 'leave') {
      const stillSeated = room.state.players.some((p) => p.id === actorId);
      this.detach(conn, !stillSeated);
      conn.code = null;
      conn.playerId = null;
    }
    this.broadcast(room, events);
    this.arm(room);
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
      this.broadcast(room, [{ k: 'presence', playerId, online: false }]);
      // 房主掉线不再让整桌卡死：宽限一段时间后自动移交给还在线的真人。
      if (room.state.hostId === playerId && !room.hostTimer) {
        room.hostTimer = setTimeout(() => {
          room.hostTimer = null;
          const host = room.state.players.find((p) => p.id === playerId);
          if (!host || host.online) return;
          transferHost(room.state, playerId);
          this.broadcast(room);
          this.arm(room);
        }, HOST_GRACE_MS);
        room.hostTimer.unref?.();
      }
    }
    this.arm(room);
  }

  stats() {
    let players = 0;
    let conns = 0;
    for (const room of this.rooms.values()) {
      players += room.state.players.filter((p) => !p.isBot).length;
      conns += room.conns.size;
    }
    return { rooms: this.rooms.size, players, conns };
  }
}
