/**
 * 可以在 Node 里跑的房间客户端。
 *
 * 命令行版和 MCP 版共用这一份 —— 它们连的是**同一台服务器、同一批房间**，
 * 和浏览器玩家坐同一张桌子。协议、鉴权、可见性规则完全一致：
 * 服务端下发的永远是 sanitizeRoom() 的结果，命令行客户端看不到任何别人的暗牌。
 *
 * 依赖为零：Node 22 起内置了全局 WebSocket。
 */
import type { GameCommand, PublicPlayer, PublicRoom } from './game.ts';
import { allInCost, callCost, canAllInNow, canCompareNow, compareCost, evaluateHand, handPercentile } from './game.ts';
import type { AccountInfo, ClientMsg, GameEvent, ServerMsg } from './protocol.ts';

export interface Auth {
  code: string;
  playerId: string;
  token: string;
}

export interface Target {
  /** ws(s):// 端点 */
  ws: string;
  /** http(s):// 站点根，用来拼邀请链接 */
  origin: string;
  /** 邀请链接里带的房间号，可能没有 */
  code: string;
}

/**
 * 把用户能拿到的任何形式的入口解析成连接目标。
 * 直接支持粘贴邀请链接 —— 那才是朋友之间实际传递的东西。
 */
export function parseTarget(input: string): Target {
  let raw = input.trim();
  if (!/^[a-z]+:\/\//i.test(raw)) raw = `https://${raw}`;
  const url = new URL(raw);
  const code = (url.searchParams.get('room') ?? '').replace(/\D/g, '').slice(0, 6);
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  const httpProto = secure ? 'https:' : 'http:';
  const wsProto = secure ? 'wss:' : 'ws:';
  return {
    ws: `${wsProto}//${url.host}/ws`,
    origin: `${httpProto}//${url.host}`,
    code,
  };
}

export type Status = 'connecting' | 'online' | 'offline' | 'closed';

export interface ClientEvents {
  room?(room: PublicRoom, events: GameEvent[]): void;
  status?(status: Status): void;
  error?(msg: string, fatal: boolean): void;
  latency?(ms: number): void;
}

export class RoomClient {
  readonly target: Target;
  room: PublicRoom | null = null;
  auth: Auth | null = null;
  /** 跨房间的账户凭证，存下来下次带上就还是同一个自己 */
  account: AccountInfo | null = null;
  status: Status = 'connecting';
  latency = 0;

  private ws: WebSocket | null = null;
  private events: ClientEvents;
  private queue: ClientMsg[] = [];
  private retry = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private waiters: { test: (r: PublicRoom) => boolean; resolve: (r: PublicRoom) => void }[] = [];
  private pendingError: ((e: Error) => void) | null = null;

  constructor(target: Target | string, events: ClientEvents = {}) {
    this.target = typeof target === 'string' ? parseTarget(target) : target;
    this.events = events;
  }

  /* ------------------------------------------------------------ 连接 */

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const open = () => {
        this.setStatus(this.retry === 0 ? 'connecting' : 'offline');
        const ws = new WebSocket(this.target.ws);
        this.ws = ws;

        ws.addEventListener('open', () => {
          this.retry = 0;
          this.setStatus('online');
          if (this.auth) this.send({ t: 'resume', ...this.auth });
          for (const msg of this.queue.splice(0)) this.send(msg);
          this.pingTimer = setInterval(() => this.send({ t: 'ping', at: Date.now() }), 8000);
          resolve();
        });

        ws.addEventListener('message', (ev) => this.handle(String((ev as MessageEvent).data)));

        ws.addEventListener('close', () => {
          if (this.pingTimer) clearInterval(this.pingTimer);
          this.pingTimer = null;
          if (this.status === 'closed') return;
          this.setStatus('offline');
          const delay = Math.min(400 * 2 ** this.retry, 6000);
          this.retry++;
          if (this.retry === 1 && !this.auth) return reject(new Error('连不上服务器'));
          this.timers.push(setTimeout(open, delay));
        });

        ws.addEventListener('error', () => {
          try {
            ws.close();
          } catch {
            /* 已经关了 */
          }
        });
      };
      open();
    });
  }

  close() {
    this.setStatus('closed');
    for (const t of this.timers) clearTimeout(t);
    if (this.pingTimer) clearInterval(this.pingTimer);
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  private setStatus(s: Status) {
    if (this.status === s) return;
    this.status = s;
    this.events.status?.(s);
  }

  private handle(raw: string) {
    let msg: ServerMsg;
    try {
      msg = JSON.parse(raw) as ServerMsg;
    } catch {
      return;
    }
    switch (msg.t) {
      case 'welcome':
        this.auth = { code: msg.code, playerId: msg.playerId, token: msg.token };
        if (msg.account) this.account = msg.account;
        // 命令行 / MCP 只做炸金花：升级是四人两队 + 25 张手牌的图形化玩法，
        // 终端里排不下也点不动。碰到升级房间明确退出，而不是拿炸金花的字段去读它。
        if (msg.room.kind !== 'zjh') return this.rejectKind();
        this.apply(msg.room, []);
        return;
      case 'room':
        if (msg.room.kind !== 'zjh') return this.rejectKind();
        this.apply(msg.room, msg.events);
        return;
      case 'error': {
        this.events.error?.(msg.msg, !!msg.fatal);
        const reject = this.pendingError;
        this.pendingError = null;
        reject?.(new Error(msg.msg));
        return;
      }
      case 'pong':
        this.latency = Date.now() - msg.at;
        this.events.latency?.(this.latency);
        return;
    }
  }

  private rejectKind() {
    const msg = '升级房间暂只支持网页版，请用浏览器打开这个房号';
    this.events.error?.(msg, true);
    const reject = this.pendingError;
    this.pendingError = null;
    reject?.(new Error(msg));
  }

  private apply(room: PublicRoom, events: GameEvent[]) {
    this.room = room;
    this.events.room?.(room, events);
    for (const w of this.waiters.splice(0).filter((w) => {
      if (!w.test(room)) return true;
      w.resolve(room);
      return false;
    })) {
      this.waiters.push(w);
    }
  }

  send(msg: ClientMsg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
    else if (msg.t !== 'ping') this.queue.push(msg);
  }

  cmd(cmd: GameCommand) {
    this.send({ t: 'cmd', cmd });
  }

  /* ------------------------------------------------------- 入座与等待 */

  private seat(msg: ClientMsg): Promise<PublicRoom> {
    return new Promise((resolve, reject) => {
      this.pendingError = reject;
      const timer = setTimeout(() => reject(new Error('服务器没有响应')), 15000);
      this.waiters.push({
        test: (r) => !!r.viewerId,
        resolve: (r) => {
          clearTimeout(timer);
          this.pendingError = null;
          resolve(r);
        },
      });
      this.send(msg);
    });
  }

  createRoom(name: string, avatar: string, agent = false, acc?: { id: string; token: string } | null) {
    return this.seat({ t: 'create', name, avatar, agent, accountId: acc?.id, accountToken: acc?.token });
  }

  joinRoom(code: string, name: string, avatar: string, agent = false, acc?: { id: string; token: string } | null) {
    return this.seat({ t: 'join', code, name, avatar, agent, accountId: acc?.id, accountToken: acc?.token });
  }

  resumeSeat(auth: Auth) {
    this.auth = auth;
    return this.seat({ t: 'resume', ...auth });
  }

  /** 等到房间状态满足某个条件（例如「轮到我了」）。超时返回当前状态而不是抛错。 */
  waitUntil(test: (room: PublicRoom) => boolean, timeoutMs = 25000): Promise<PublicRoom | null> {
    if (this.room && test(this.room)) return Promise.resolve(this.room);
    return new Promise((resolve) => {
      const entry = {
        test,
        resolve: (r: PublicRoom) => {
          clearTimeout(timer);
          resolve(r);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== entry);
        resolve(null);
      }, timeoutMs);
      this.waiters.push(entry);
    });
  }

  get me(): PublicPlayer | null {
    return this.room?.players.find((p) => p.id === this.room!.viewerId) ?? null;
  }

  get myTurn(): boolean {
    const me = this.me;
    return !!this.room && !!me && this.room.phase === 'playing' && this.room.turnSeat === me.seat && me.status === 'active';
  }
}

/* --------------------------------------------------------- 视图与合法动作 */

export interface LegalAction {
  action: string;
  label: string;
  /** 这一步要花多少积分 */
  cost?: number;
  unit?: number;
  targetId?: string;
  targetName?: string;
}

/**
 * 当前轮到我时可以做什么，以及各要花多少。
 * 全部用 shared/game.ts 里那几个函数算 —— 和服务端是同一份实现，
 * 不会出现「客户端说能跟，服务端说钱不够」。
 */
export function legalActions(room: PublicRoom): LegalAction[] {
  const me = room.players.find((p) => p.id === room.viewerId);
  if (!me || room.phase !== 'playing' || me.status !== 'active') return [];
  const out: LegalAction[] = [];
  const myTurn = room.turnSeat === me.seat;

  if (!me.looked) out.push({ action: 'look', label: '看牌（之后下注翻倍）' });
  out.push({ action: 'fold', label: myTurn ? '弃牌' : '弃牌（不必等到自己的回合）' });
  if (!myTurn) return out;

  if (room.allIn) {
    // 接梭哈的价按**自己**的倍率算：闷牌半价、看牌双倍。
    // 上面的看牌是自由动作，点完这个数就会翻倍 —— 翻过头就夹到自己的全部筹码。
    const price = Math.min(room.allIn.base * (me.looked ? 2 : 1), me.chips);
    out.push({ action: 'accept', label: me.looked ? '接受梭哈' : '接受梭哈（闷牌半价）', cost: price });
    return out;
  }

  const cost = callCost(room, me);
  if (me.chips > cost) out.push({ action: 'call', label: '跟注', cost });
  for (const unit of room.settings.betOptions.filter((x) => x > room.betUnit)) {
    const c = unit * (me.looked ? 2 : 1);
    if (me.chips > c) out.push({ action: 'raise', label: `加注到 ${unit}`, unit, cost: c });
  }
  if (me.chips > 0 && (canAllInNow(room) || me.chips <= cost)) {
    const active = room.players.filter((p) => p.status === 'active');
    if (active.length > 1) {
      out.push({ action: 'all_in', label: '梭哈（其他人可以接或弃）', cost: allInCost(room, me) });
    }
  }
  if (canCompareNow(room)) {
    const price = compareCost(room, me);
    if (me.chips >= price) {
      for (const t of room.players.filter((p) => p.status === 'active' && p.id !== me.id)) {
        out.push({ action: 'compare', label: `和 ${t.name} 比牌`, cost: price, targetId: t.id, targetName: t.name });
      }
    }
  }
  return out;
}

const SUITS: Record<string, string> = { S: '♠', H: '♥', C: '♣', D: '♦' };
const RANKS: Record<number, string> = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
export function cardText(c: { suit: string; rank: number }) {
  return `${RANKS[c.rank] ?? c.rank}${SUITS[c.suit] ?? c.suit}`;
}

/** 给机器读的牌桌快照。只包含这个座位本来就能看到的信息。 */
export function tableView(room: PublicRoom) {
  const me = room.players.find((p) => p.id === room.viewerId);
  const turn = room.players.find((p) => p.seat === room.turnSeat);
  const myCards = me?.hand.length === 3 ? me.hand : null;
  return {
    room: room.code,
    phase: room.phase,
    hand: room.handNo,
    round: room.phase === 'playing' ? `${room.roundNo}/${room.settings.maxRounds}` : null,
    pot: room.pot,
    betUnit: room.betUnit,
    me: me
      ? {
          name: me.name,
          seat: me.seat,
          chips: me.chips,
          bet: me.bet,
          status: me.status,
          looked: me.looked,
          cards: myCards ? myCards.map(cardText) : null,
          handType: myCards ? evaluateHand(myCards).name : null,
          strength: myCards ? Number(handPercentile(myCards).toFixed(4)) : null,
          table_net: me.net,
          isHost: room.hostId === me.id,
        }
      : null,
    players: room.players.map((p) => ({
      name: p.name,
      seat: p.seat,
      chips: p.chips,
      bet: p.bet,
      status: p.status,
      looked: p.looked,
      kind: p.isBot ? 'bot' : p.isAgent ? 'ai' : 'human',
      online: p.online,
      lastAction: p.lastAction ?? null,
      table_net: p.net,
      // 只有摊牌时服务端才会下发别人的牌
      cards: p.hand.length === 3 ? p.hand.map(cardText) : null,
    })),
    turn: turn
      ? { who: turn.name, isMe: turn.id === room.viewerId, secondsLeft: room.turnDeadline ? Math.max(0, Math.round((room.turnDeadline - Date.now()) / 1000)) : null }
      : null,
    allIn: room.allIn
      ? {
          by: room.allIn.initiatorName,
          // amount 是发起人自己押上的数，只用来复述「他梭了多少」；
          // 轮到自己要掏多少看 my_cost —— 闷牌半价、看牌双倍，两个数本来就不一样。
          amount: room.allIn.amount,
          my_cost: me ? Math.min(room.allIn.base * (me.looked ? 2 : 1), me.chips) : null,
          waitingOn: room.allIn.pending.length,
          accepted: room.allIn.accepted.length,
        }
      : null,
    // 结算明细：谁投了多少、这局赢输多少、坐下以来累计多少
    result: room.result
      ? {
          winner: room.result.winnerName,
          won: room.result.potWon,
          reason: room.result.reason,
          // 自己的那份单独给一次，模型不用自己去表里找
          my_delta: room.result.deltas?.find((d) => d.id === room.viewerId)?.delta ?? null,
          ante_included: true,
          settlement: (room.result.deltas ?? []).map((d) => ({
            name: d.name,
            bet: d.bet,
            delta: d.delta,
            table_net: d.net,
          })),
        }
      : null,
    legalActions: legalActions(room),
    log: room.log.slice(-10).map((l) => l.text),
  };
}
