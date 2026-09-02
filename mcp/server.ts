#!/usr/bin/env node
/**
 * 好友炸金花 · MCP 服务。
 *
 * 让一个 AI 以**普通玩家**的身份坐上牌桌，和网页版、命令行版的朋友同桌。
 * 它走的是同一个 WebSocket 协议、同一批房间，服务端零改动。
 *
 * 公平性是这套东西的前提，两条硬约束：
 *  1. 它拿到的永远是服务端 sanitizeRoom() 的结果 —— 和任何一个浏览器玩家
 *     看到的完全一样，别人的暗牌根本不会离开服务器进程。这里**没有**、
 *     也不该有任何能看到隐藏信息的工具。
 *  2. 入座时声明 agent=true，牌桌上会显示「AI」标记。不允许静默代打。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AVATARS, EMOTES, type GameCommand } from '../shared/game.ts';
import { legalActions, parseTarget, RoomClient, tableView, type Auth, type Target } from '../shared/client.ts';

/* --------------------------------------------------------------- 存档 */

const STORE = join(homedir(), '.zjh-mcp');
const authFile = (t: Target, code: string) => join(STORE, `${t.ws.replace(/[^a-z0-9]/gi, '_')}-${code}.json`);

function loadAuth(t: Target, code: string): Auth | null {
  try {
    const v = JSON.parse(readFileSync(authFile(t, code), 'utf8')) as Auth;
    return v.playerId && v.token ? { ...v, code } : null;
  } catch {
    return null;
  }
}
function saveAuth(t: Target, a: Auth) {
  try {
    mkdirSync(STORE, { recursive: true });
    writeFileSync(authFile(t, a.code), JSON.stringify(a), { mode: 0o600 });
  } catch {
    /* 存不下就当一次性会话 */
  }
}

// 账户和房间无关：AI 换房间、隔天再来还是同一个自己，积分接着上次
const accountFile = () => join(STORE, 'account.json');
function loadAccount(): { id: string; token: string } | null {
  try {
    const v = JSON.parse(readFileSync(accountFile(), 'utf8')) as { id: string; token: string };
    return v.id && v.token ? v : null;
  } catch {
    return null;
  }
}
function saveAccount(a: { id: string; token: string }) {
  try {
    mkdirSync(STORE, { recursive: true });
    writeFileSync(accountFile(), JSON.stringify(a), { mode: 0o600 });
  } catch {
    /* ignore */
  }
}

/* --------------------------------------------------------------- 会话 */

let client: RoomClient | null = null;
let target: Target | null = null;
/** 上一次交给模型看过的日志条数，用来只回增量 */
let seenLog = 0;

function need(): RoomClient {
  if (!client?.room) throw new Error('还没入座。先用 zjh_join 加入一张牌桌。');
  return client;
}

function ok(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}
function fail(msg: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }, null, 2) }], isError: true };
}

/** 每次返回给模型的都是这一份：牌桌 + 现在能做什么 + 上次之后发生了什么 */
function snapshot(extra: Record<string, unknown> = {}) {
  const c = need();
  const view = tableView(c.room!);
  const fresh = c.room!.log.slice(seenLog);
  seenLog = c.room!.log.length;
  const acc = c.account;
  return {
    ...view,
    // 跨房间的账户战绩：净战绩 = 当前积分 - 累计发放
    account: acc ? { chips: acc.chips, granted: acc.granted, lifetime_net: acc.chips - acc.granted, wins: acc.wins } : null,
    since_last_call: fresh.map((l) => l.text),
    ...extra,
  };
}

async function act(cmd: GameCommand, label: string) {
  const c = need();
  const before = c.room!.actionSeq;
  c.cmd(cmd);
  // 等服务端把结果推回来，模型拿到的就是执行后的牌桌
  await c.waitUntil((r) => r.actionSeq !== before, 6000);
  return ok(snapshot({ did: label }));
}

/* --------------------------------------------------------------- 工具 */

const server = new McpServer({ name: 'zjh', version: '1.0.0' });

server.tool(
  'zjh_join',
  '加入一张炸金花牌桌。可以直接粘朋友分享的邀请链接。入座后会以 AI 身份出现在牌桌上（其他玩家看得到 AI 标记）。',
  {
    url: z.string().describe('邀请链接（如 https://host:8443/?room=123456）或服务器地址'),
    code: z.string().optional().describe('6 位房间号；邀请链接里已经带了就不用填'),
    name: z.string().optional().describe('昵称，1–10 字'),
    avatar: z.string().optional().describe(`头像 emoji，可选：${AVATARS.join(' ')}`),
    create: z.boolean().optional().describe('true 表示新开一桌而不是加入'),
  },
  async ({ url, code, name, avatar, create }) => {
    try {
      client?.close();
      target = parseTarget(url);
      const roomCode = (code ?? target.code ?? '').replace(/\D/g, '').slice(0, 6);
      client = new RoomClient(target);
      await client.connect();

      const nick = (name ?? `AI${100 + Math.floor(Math.random() * 900)}`).slice(0, 10);
      const face = avatar && AVATARS.includes(avatar) ? avatar : AVATARS[Math.floor(Math.random() * AVATARS.length)];
      const saved = roomCode ? loadAuth(target, roomCode) : null;
      const acc = loadAccount();

      if (saved) {
        await client.resumeSeat(saved).catch(async () => {
          client!.auth = null;
          await client!.joinRoom(roomCode, nick, face, true, acc);
        });
      } else if (create || !roomCode) {
        await client.createRoom(nick, face, true, acc);
      } else {
        await client.joinRoom(roomCode, nick, face, true, acc);
      }
      if (client.auth) saveAuth(target, client.auth);
      if (client.account) saveAccount({ id: client.account.id, token: client.account.token });
      seenLog = 0;
      return ok({
        joined: true,
        invite: `${target.origin}/?room=${client.room!.code}`,
        ...snapshot(),
      });
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.tool('zjh_table', '看当前牌桌。返回你这个座位能看到的一切，以及此刻你可以做的操作和各自的代价。', {}, async () => {
  try {
    return ok(snapshot());
  } catch (e) {
    return fail((e as Error).message);
  }
});

server.tool(
  'zjh_wait',
  '等到轮到你行动、或者本局结束。牌桌是回合制的，用这个代替反复轮询 zjh_table。',
  { seconds: z.number().optional().describe('最长等待秒数，默认 25') },
  async ({ seconds }) => {
    try {
      const c = need();
      const r = await c.waitUntil(
        (room) => {
          const me = room.players.find((p) => p.id === room.viewerId);
          if (!me) return true;
          if (room.phase !== 'playing') return true;
          return room.turnSeat === me.seat && me.status === 'active';
        },
        Math.max(1, Math.min(seconds ?? 25, 120)) * 1000,
      );
      return ok(snapshot({ timed_out: r === null }));
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.tool(
  'zjh_act',
  '在牌局中行动。look 看牌和 fold 弃牌任何时候都能做；其余要轮到你。有人梭哈时只有 accept 和 fold 两个选择。',
  {
    action: z.enum(['look', 'call', 'accept', 'raise', 'fold', 'all_in', 'compare']),
    unit: z.number().optional().describe('raise 时的加注档位，取 legalActions 里给的 unit'),
    target_seat: z.number().optional().describe('compare 时对手的座位号'),
  },
  async ({ action, unit, target_seat }) => {
    try {
      const c = need();
      switch (action) {
        case 'look':
          return await act({ type: 'look' }, '看牌');
        case 'fold':
          return await act({ type: 'fold' }, '弃牌');
        case 'call':
        case 'accept':
          return await act({ type: 'call' }, action === 'accept' ? '接受梭哈' : '跟注');
        case 'all_in':
          return await act({ type: 'all_in' }, '梭哈');
        case 'raise': {
          const tiers = legalActions(c.room!).filter((a) => a.action === 'raise');
          const pick = unit ?? tiers[0]?.unit;
          if (!pick) return fail('现在不能加注');
          return await act({ type: 'raise', unit: pick }, `加注到 ${pick}`);
        }
        case 'compare': {
          const t = c.room!.players.find((p) => p.seat === target_seat && p.status === 'active');
          if (!t) return fail('比牌对象无效，看 legalActions 里的 targetName/座位号');
          return await act({ type: 'compare', targetId: t.id }, `和 ${t.name} 比牌`);
        }
      }
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.tool(
  'zjh_lobby',
  '牌局之外的操作：准备、开始、加电脑玩家、开下一局、补充积分、调房规、移除玩家。房主专属的操作由服务端校验。',
  {
    action: z.enum(['ready', 'unready', 'start', 'add_bot', 'new_round', 'top_up', 'settings', 'kick']),
    target_seat: z.number().optional().describe('kick 时的座位号'),
    turn_seconds: z.number().optional().describe('settings：每步行动时限，AI 桌建议 60–90'),
    max_rounds: z.number().optional().describe('settings：封顶轮数'),
    all_in_from_round: z.number().optional().describe('settings：第几轮起可主动梭哈'),
    auto_continue: z.boolean().optional().describe('settings：本局结束后自动开下一局'),
  },
  async ({ action, target_seat, turn_seconds, max_rounds, all_in_from_round, auto_continue }) => {
    try {
      const c = need();
      switch (action) {
        case 'ready':
          return await act({ type: 'ready', ready: true }, '准备');
        case 'unready':
          return await act({ type: 'ready', ready: false }, '取消准备');
        case 'start':
          return await act({ type: 'start' }, '开始本局');
        case 'add_bot':
          return await act({ type: 'add_bot' }, '添加电脑玩家');
        case 'new_round':
          return await act({ type: 'new_round' }, '返回准备阶段');
        case 'top_up':
          return await act({ type: 'top_up' }, '补充积分');
        case 'kick': {
          const t = c.room!.players.find((p) => p.seat === target_seat);
          if (!t) return fail('没有这个座位');
          return await act({ type: 'remove_player', targetId: t.id }, `移除 ${t.name}`);
        }
        case 'settings':
          return await act(
            {
              type: 'settings',
              turnSeconds: turn_seconds,
              maxRounds: max_rounds,
              allInFromRound: all_in_from_round,
              autoContinue: auto_continue,
            },
            '调整房规',
          );
      }
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.tool(
  'zjh_emote',
  '在牌桌上发一个表情。朋友局的乐趣有一半在这儿，别只顾着算牌。',
  {
    emote: z.string().describe(`表情，可选：${EMOTES.join(' ')}`),
  },
  async ({ emote }) => {
    try {
      if (!EMOTES.includes(emote)) return fail(`没有这个表情，可选：${EMOTES.join(' ')}`);
      return await act({ type: 'emote', id: emote }, `发表情 ${emote}`);
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.tool('zjh_leave', '主动退出房间并断开连接。任何时候都可以走；牌局进行中会先弃牌再离座。', {}, async () => {
  try {
    client?.cmd({ type: 'leave' });
    await new Promise((r) => setTimeout(r, 200));
    client?.close();
    client = null;
    return ok({ left: true });
  } catch (e) {
    return fail((e as Error).message);
  }
});

/* --------------------------------------------------------------- 启动 */

const transport = new StdioServerTransport();
await server.connect(transport);
