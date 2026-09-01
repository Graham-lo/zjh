import type { GameCommand, PublicRoom } from '../shared/game.ts';
import type { ClientMsg, GameEvent, ServerMsg } from '../shared/protocol.ts';

export type NetStatus = 'connecting' | 'online' | 'offline';

export interface Auth {
  code: string;
  playerId: string;
  token: string;
}

export interface NetHandlers {
  onStatus(status: NetStatus): void;
  onWelcome(auth: Auth, room: PublicRoom): void;
  onRoom(room: PublicRoom, events: GameEvent[]): void;
  onError(msg: string, fatal: boolean): void;
  onLatency(ms: number): void;
}

/**
 * 一条长连接搞定全部同步。
 *
 * 断线后自动退避重连，重连成功会用保存的 token 无感恢复座位 ——
 * 手机锁屏、切后台、地铁里断网回来都不会把人踢出牌桌。
 */
export class Net {
  private ws: WebSocket | null = null;
  private retry = 0;
  private queue: ClientMsg[] = [];
  private pingTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private closed = false;
  /** 重连后用来恢复身份 */
  resume: Auth | null = null;

  private h: NetHandlers;

  constructor(handlers: NetHandlers) {
    this.h = handlers;
  }

  start() {
    this.closed = false;
    this.open();
    // 从后台切回来时立刻探活，不等退避计时器
    document.addEventListener('visibilitychange', this.wake);
    window.addEventListener('online', this.wake);
  }

  stop() {
    this.closed = true;
    document.removeEventListener('visibilitychange', this.wake);
    window.removeEventListener('online', this.wake);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  private wake = () => {
    if (document.hidden) return;
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.open();
  };

  private open() {
    if (this.closed) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.h.onStatus(this.retry === 0 ? 'connecting' : 'offline');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.h.onStatus('online');
      if (this.resume) ws.send(JSON.stringify({ t: 'resume', ...this.resume } satisfies ClientMsg));
      for (const msg of this.queue.splice(0)) ws.send(JSON.stringify(msg));
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.send({ t: 'ping', at: Date.now() }), 5000);
      this.send({ t: 'ping', at: Date.now() });
    };

    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data as string) as ServerMsg;
      } catch {
        return;
      }
      switch (msg.t) {
        case 'welcome':
          this.resume = { code: msg.code, playerId: msg.playerId, token: msg.token };
          return this.h.onWelcome(this.resume, msg.room);
        case 'room':
          return this.h.onRoom(msg.room, msg.events);
        case 'error':
          if (msg.fatal) this.resume = null;
          return this.h.onError(msg.msg, !!msg.fatal);
        case 'pong':
          return this.h.onLatency(Date.now() - msg.at);
      }
    };

    ws.onclose = () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (this.closed) return;
      this.h.onStatus('offline');
      const delay = Math.min(300 * 2 ** this.retry, 5000) + Math.random() * 200;
      this.retry++;
      this.reconnectTimer = window.setTimeout(() => this.open(), delay);
    };

    ws.onerror = () => ws.close();
  }

  send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    else if (msg.t !== 'ping') this.queue.push(msg);
  }

  cmd(cmd: GameCommand) {
    this.send({ t: 'cmd', cmd });
  }
}
