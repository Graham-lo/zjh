#!/usr/bin/env node
/**
 * 好友炸金花 · 命令行版。
 *
 * 和网页版连的是**同一台服务器、同一批房间** —— 朋友把邀请链接发给你，
 * 你在终端里就能和他们坐同一张桌子。功能与网页版对齐：
 * 准备、加电脑、看牌、随时弃牌、跟注、分档加注、梭哈与表态、比牌、
 * 补分、聊天、表情、改名、房规、牌桌记录、断线重连恢复座位。
 *
 * 依赖为零：Node 22 起内置全局 WebSocket。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AVATARS, EMOTES, type GameCommand, type PublicRoom } from '../shared/game.ts';
import { legalActions, parseTarget, RoomClient, type Auth } from '../shared/client.ts';
import type { GameEvent } from '../shared/protocol.ts';
import { ANIM, C, DUEL_TTL, FRAME, newFx, renderRoom, Screen, TTY, type Fx } from './render.ts';

const KEY = { ctrlC: '\u0003', esc: '\u001B', backspace: '\u007F' };

/* ------------------------------------------------------------ 参数与存档 */

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(`--${name}`);
const flagValues = new Set(argv.filter((a, i) => i > 0 && argv[i - 1].startsWith('--')));
const entry = argv.find((a) => !a.startsWith('--') && !flagValues.has(a)) ?? flag('url');

if (!entry || has('help')) {
  console.log(`
${C.bold}好友炸金花 · 命令行版${C.reset}

  zjh <邀请链接或服务器地址> [选项]

  zjh "https://example.com:8443/?room=123456"    直接加入朋友分享的房间
  zjh example.com:8443 --create                  自己开一桌
  zjh example.com:8443 --code 123456             手动输入房间号加入

${C.bold}选项${C.reset}
  --name <昵称>      默认沿用本机保存的昵称
  --avatar <emoji>   ${AVATARS.join(' ')}
  --code <房间号>    6 位房间号
  --create           创建新房间
  --fresh            忽略本地存档，以新身份入座
`);
  process.exit(entry ? 0 : 1);
}

const target = parseTarget(entry);
const code = (flag('code') ?? target.code ?? '').replace(/\D/g, '').slice(0, 6);
const wantCreate = has('create') || !code;

const STORE = join(homedir(), '.zjh');
const slug = target.ws.replace(/[^a-z0-9]/gi, '_');
const authFile = (c: string) => join(STORE, `${slug}-${c}.json`);

function loadAuth(c: string): Auth | null {
  try {
    const v = JSON.parse(readFileSync(authFile(c), 'utf8')) as Auth;
    return v.playerId && v.token ? { ...v, code: c } : null;
  } catch {
    return null;
  }
}
function saveAuth(a: Auth) {
  try {
    mkdirSync(STORE, { recursive: true });
    writeFileSync(authFile(a.code), JSON.stringify(a), { mode: 0o600 });
  } catch {
    /* 存不下就当一次性会话，不影响这一局 */
  }
}

// 账户和房间无关：换房间、隔天再来还是同一个自己，积分接着上次
const accountFile = join(STORE, 'account.json');
function loadAccount(): { id: string; token: string } | null {
  try {
    const v = JSON.parse(readFileSync(accountFile, 'utf8')) as { id: string; token: string };
    return v.id && v.token ? v : null;
  } catch {
    return null;
  }
}
function saveAccount(a: { id: string; token: string }) {
  try {
    mkdirSync(STORE, { recursive: true });
    writeFileSync(accountFile, JSON.stringify(a), { mode: 0o600 });
  } catch {
    /* ignore */
  }
}

const identFile = join(STORE, 'identity.json');
function loadIdent(): { name: string; avatar: string } {
  try {
    return JSON.parse(readFileSync(identFile, 'utf8')) as { name: string; avatar: string };
  } catch {
    const v = {
      name: `牌友${1000 + Math.floor(Math.random() * 9000)}`,
      avatar: AVATARS[Math.floor(Math.random() * AVATARS.length)],
    };
    try {
      mkdirSync(STORE, { recursive: true });
      writeFileSync(identFile, JSON.stringify(v));
    } catch {
      /* ignore */
    }
    return v;
  }
}
const ident = loadIdent();
const name = flag('name') ?? ident.name;
const avatar = flag('avatar') ?? ident.avatar;

/* --------------------------------------------------------------- 画面 */

type Mode = 'play' | 'chat' | 'cmd' | 'compare' | 'emote';
let mode: Mode = 'play';
let buffer = '';
let notice = '';
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

function say(msg: string, ms = 4000) {
  notice = msg;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice = '';
    draw();
  }, ms);
  draw();
}

const screen = new Screen();
/**
 * 动画的时间轴。这里只存**起点时间戳**，进度每帧现算；
 * 而且每个起点都由服务器推来的事件写入 —— 客户端不自己编状态，
 * 所以「谁梭哈了、谁和谁比了牌」永远和服务端一致。
 */
const fx = newFx();

/** 终端响铃。管道里响铃只是一个垃圾字节，非 TTY 就别响 */
const BELL = String.fromCharCode(7);
const bell = () => {
  if (TTY) process.stdout.write(BELL);
};

/**
 * 比牌的双方是谁、谁输了。
 *
 * 优先用事件自带的 targetId / loserId；这两个字段是后加的，
 * 老服务端不下发，所以退回读 lastAction —— 赢家是「比牌胜 X」，输家是「比牌负于 Y」。
 */
function duelFrom(r: PublicRoom, ev: { playerId: string; targetId?: string; loserId?: string }, at: number): Fx['duel'] {
  const byId = (id?: string) => (id ? r.players.find((p) => p.id === id) : undefined);
  const pair = [byId(ev.playerId), byId(ev.targetId)];
  const win =
    ev.loserId && pair[0] && pair[1]
      ? pair.find((p) => p!.id !== ev.loserId)
      : r.players.find((p) => p.lastAction?.startsWith('比牌胜'));
  const lose =
    ev.loserId && pair[0] && pair[1] ? byId(ev.loserId) : r.players.find((p) => p.lastAction?.startsWith('比牌负于'));
  if (!win || !lose) return null;
  // 左右按座位固定：同一桌里谁在左边每次都一样，画面不会乱跳
  const [a, b] = win.seat <= lose.seat ? [win, lose] : [lose, win];
  return {
    at,
    a: { avatar: a.avatar, name: a.name, won: a.id === win.id },
    b: { avatar: b.avatar, name: b.name, won: b.id === win.id },
  };
}

function onRoomUpdate(events: GameEvent[]) {
  const r = client.room;
  if (!r) return;
  const now = Date.now();

  for (const ev of events) {
    switch (ev.k) {
      case 'deal':
        // 新的一局：牌一张张发出来，上一局的横幅和对决行同时退场
        fx.deal = now;
        fx.settle = null;
        fx.look = null;
        fx.allIn = null;
        fx.duel = null;
        break;
      case 'look':
        // 只有自己看牌才有牌面可展开；别人看牌，桌面上仍然是三张背
        if (ev.playerId === r.viewerId) fx.look = now;
        break;
      case 'bet':
        if (ev.kind === 'all_in') {
          fx.allIn = { at: now, amount: ev.amount };
          bell(); // 梭哈这一下值得响一声，人可能正在看别的窗口
        }
        if (ev.kind === 'compare') fx.duel = duelFrom(r, ev, now);
        break;
      case 'turn':
        // 轮到自己：响一声
        if (ev.playerId === r.viewerId) bell();
        break;
      case 'win':
        fx.settle = now;
        fx.deal = null;
        break;
    }
  }
  draw();
}

let wasOffline = true;

const client = new RoomClient(target, {
  room: (_room, events) => onRoomUpdate(events),
  status: (s) => {
    // 断线重连回来那一下，顶栏的绿点多亮一帧，人才注意得到「回来了」
    if (s === 'online' && wasOffline) fx.online = Date.now();
    wasOffline = s !== 'online';
    draw();
  },
  error: (msg, fatal) => {
    say(`${C.red}${msg}${C.reset}`);
    if (fatal) {
      setTimeout(() => {
        cleanup();
        process.exit(1);
      }, 1500);
    }
  },
});

function draw() {
  if (!client.room) return;
  fx.now = Date.now();
  // 对决行留够看一眼的时间就撤，牌桌上不留旧信息
  if (fx.duel && fx.now - fx.duel.at > DUEL_TTL) fx.duel = null;

  const lines = renderRoom({
    room: client.room,
    latency: client.latency,
    status: client.status,
    origin: target.origin,
    account: client.account,
    fx,
  });
  if (mode === 'chat') lines.push('', `${C.gold}说点什么 >${C.reset} ${buffer}${C.dim}_${C.reset}`);
  else if (mode === 'cmd') lines.push('', `${C.gold}:${C.reset}${buffer}${C.dim}_${C.reset}`);
  else if (mode === 'compare') {
    lines.push(
      '',
      `${C.gold}和谁比牌？${C.reset} ${compareTargets()
        .map((p, i) => `[${i + 1}] ${p.avatar}${p.name}`)
        .join('   ')}   [esc]取消`,
    );
  } else if (mode === 'emote') {
    lines.push('', `${C.gold}发个表情${C.reset} ${EMOTES.map((e, i) => `[${i + 1}]${e}`).join(' ')}   [esc]取消`);
  }
  // notice 可能是多行的帮助文本，拆成行交给差分重绘
  if (notice) lines.push('', ...notice.split('\n'));
  screen.paint(lines);
}

/**
 * 所有帧动画共用这一个心跳。
 * 差分重绘让「和上一帧一模一样的行」一个字节都不写，所以 80ms 常开也不费终端；
 * 关掉动画时退回每秒一次，纯粹为了让行动倒计时走秒。
 */
setInterval(
  () => {
    if (!ANIM && !(mode === 'play' && client.room?.phase === 'playing')) return;
    draw();
  },
  ANIM ? FRAME : 1000,
).unref();

/* --------------------------------------------------------------- 动作 */

const send = (cmd: GameCommand) => client.cmd(cmd);
const room = () => client.room!;
const me = () => client.me!;
const compareTargets = () =>
  client.room ? client.room.players.filter((p) => p.status === 'active' && p.id !== client.room!.viewerId) : [];
const raiseTiers = () => (client.room ? legalActions(client.room).filter((a) => a.action === 'raise') : []);

const HELP = [
  `${C.bold}按键${C.reset}`,
  `  ${C.gold}k${C.reset} 看牌    ${C.gold}c${C.reset} 跟注/接受梭哈    ${C.gold}f${C.reset} 弃牌（随时可弃）    ${C.gold}a${C.reset} 梭哈    ${C.gold}v${C.reset} 比牌    ${C.gold}1-4${C.reset} 加注档位`,
  `  ${C.gold}r${C.reset} 准备    ${C.gold}s${C.reset} 开始    ${C.gold}b${C.reset} 加电脑    ${C.gold}n${C.reset} 下一局    ${C.gold}m${C.reset} 补分    ${C.gold}i${C.reset} 邀请链接`,
  `  ${C.gold}t${C.reset} 聊天    ${C.gold}e${C.reset} 表情    ${C.gold}:${C.reset} 命令    ${C.gold}?${C.reset} 帮助    ${C.gold}q${C.reset} 退出`,
  `${C.bold}命令${C.reset}`,
  `  ${C.gold}:name 昵称${C.reset}   ${C.gold}:avatar 🐯${C.reset}   ${C.gold}:kick 座位号${C.reset}   ${C.gold}:log${C.reset}   ${C.gold}:invite${C.reset}`,
  `  ${C.gold}:set turn=60 rounds=8 allin=3 auto=on${C.reset}   房规（房主）`,
].join('\n');

function quit() {
  send({ type: 'leave' });
  setTimeout(() => {
    cleanup();
    process.exit(0);
  }, 250);
}

function handleKey(key: string) {
  const r = client.room;
  if (!r) return;
  const acts = legalActions(r);
  const can = (a: string) => acts.some((x) => x.action === a);

  switch (key) {
    case 'q':
      return quit();
    case 't':
      mode = 'chat';
      buffer = '';
      return draw();
    case ':':
      mode = 'cmd';
      buffer = '';
      return draw();
    case 'e':
      mode = 'emote';
      return draw();
    case 'i':
      return say(`${C.gold}邀请链接${C.reset} ${target.origin}/?room=${r.code}`, 8000);
    case '?':
      return say(HELP, 10000);
  }

  if (r.phase === 'lobby') {
    if (key === 'r') return send({ type: 'ready', ready: !me().ready });
    if (key === 's') return send({ type: 'start' });
    if (key === 'b') return send({ type: 'add_bot' });
    if (key === 'm') return send({ type: 'top_up' });
    if (key === 'o') {
      mode = 'cmd';
      buffer = 'set turn=60';
      return draw();
    }
    return;
  }
  if (r.phase === 'round_end') {
    if (key === 'n') return send({ type: 'new_round' });
    if (key === 'm') return send({ type: 'top_up' });
    return;
  }

  if (key === 'k' && can('look')) return send({ type: 'look' });
  if (key === 'f' && can('fold')) return send({ type: 'fold' });
  if (key === 'c') {
    if (can('accept') || can('call')) return send({ type: 'call' });
    return say(`${C.dim}现在跟不了${C.reset}`);
  }
  if (key === 'a') {
    if (can('all_in')) return send({ type: 'all_in' });
    return say(`${C.dim}现在不能梭哈${C.reset}`);
  }
  if (key === 'v') {
    if (!can('compare')) return say(`${C.dim}现在不能比牌${C.reset}`);
    mode = 'compare';
    return draw();
  }
  if (/^[1-9]$/.test(key)) {
    const tier = raiseTiers()[Number(key) - 1];
    if (tier) return send({ type: 'raise', unit: tier.unit! });
  }
}

function runCommand(input: string) {
  const parts = input.trim().split(/\s+/);
  const head = parts[0];
  const rest = parts.slice(1);
  const arg = rest.join(' ');
  switch (head) {
    case 'name':
      if (!arg) return say('用法 :name 新昵称');
      return send({ type: 'rename', name: arg, avatar: me().avatar });
    case 'avatar':
      if (!AVATARS.includes(arg)) return say(`可选头像：${AVATARS.join(' ')}`);
      return send({ type: 'rename', name: me().name, avatar: arg });
    case 'kick': {
      const t = room().players.find((p) => p.seat === Number(arg));
      if (!t) return say('没有这个座位');
      return send({ type: 'remove_player', targetId: t.id });
    }
    case 'set': {
      const cmd: GameCommand = { type: 'settings' };
      for (const kv of rest) {
        const [k, v] = kv.split('=');
        if (k === 'turn') cmd.turnSeconds = Number(v);
        else if (k === 'rounds') cmd.maxRounds = Number(v);
        else if (k === 'allin') cmd.allInFromRound = Number(v);
        else if (k === 'auto') cmd.autoContinue = v === 'on' || v === 'true';
      }
      return send(cmd);
    }
    case 'log':
      return say(
        room()
          .log.slice(-20)
          .map((l) => `  ${C.dim}·${C.reset} ${l.text}`)
          .join('\n'),
        12000,
      );
    case 'invite':
      return say(`${target.origin}/?room=${room().code}`, 8000);
    case 'help':
      return say(HELP, 10000);
    case 'quit':
    case 'q':
      return quit();
    default:
      return say(`未知命令 ${head}，试试 :help`);
  }
}

/* --------------------------------------------------------------- 输入 */

function onData(chunk: Buffer) {
  const s = chunk.toString('utf8');
  if (s === KEY.ctrlC) {
    cleanup();
    process.exit(0);
  }
  if (mode === 'play') {
    for (const ch of s) handleKey(ch);
    return;
  }
  if (s === KEY.esc) {
    mode = 'play';
    buffer = '';
    return draw();
  }
  if (mode === 'compare' || mode === 'emote') {
    const i = Number(s) - 1;
    if (mode === 'compare') {
      const t = compareTargets()[i];
      if (t) send({ type: 'compare', targetId: t.id });
    } else {
      const e = EMOTES[i];
      if (e) send({ type: 'emote', id: e });
    }
    mode = 'play';
    return draw();
  }
  if (s === '\r' || s === '\n') {
    const text = buffer;
    const was = mode;
    mode = 'play';
    buffer = '';
    if (was === 'chat' && text.trim()) send({ type: 'chat', text });
    if (was === 'cmd' && text.trim()) runCommand(text);
    return draw();
  }
  if (s === KEY.backspace || s === '\b') {
    buffer = buffer.slice(0, -1);
    return draw();
  }
  if (s >= ' ') buffer += s;
  draw();
}

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try {
    process.stdin.setRawMode?.(false);
  } catch {
    /* ignore */
  }
  // 差分重绘时光标停在最后写过的那一行，退出前挪到内容下面，
  // 否则 shell 提示符会压在牌桌中间
  screen.end();
  client.close();
}

/* --------------------------------------------------------------- 启动 */

async function main() {
  process.stdout.write(`${C.dim}正在连接 ${target.ws} …${C.reset}\n`);
  await client.connect();

  const saved = has('fresh') || !code ? null : loadAuth(code);
  try {
    const acc = has('fresh') ? null : loadAccount();
    if (saved) await client.resumeSeat(saved);
    else if (wantCreate) await client.createRoom(name, avatar, false, acc);
    else await client.joinRoom(code, name, avatar, false, acc);
  } catch (e) {
    // 存档失效（房间没了 / 被移出）就退回普通加入
    if (saved) {
      client.auth = null;
      await client.joinRoom(code, name, avatar, false, has('fresh') ? null : loadAccount()).catch((err: Error) => {
        console.error(`${C.red}${err.message}${C.reset}`);
        process.exit(1);
      });
    } else {
      console.error(`${C.red}${(e as Error).message}${C.reset}`);
      process.exit(1);
    }
  }
  if (client.auth) saveAuth(client.auth);
  if (client.account) saveAccount({ id: client.account.id, token: client.account.token });

  process.stdout.write(C.hideCursor);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onData);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  // 终端被拖大拖小时行号全部作废，只有这种时候才允许整屏清一次
  process.stdout.on('resize', () => draw());
  // 刚入座：整屏铺一次底，标题从这一刻开始一列列打出来
  screen.invalidate();
  fx.enter = Date.now();
  draw();
  say(`${C.dim}按 ${C.gold}?${C.reset}${C.dim} 看全部按键${C.reset}`);
}

main().catch((e: Error) => {
  cleanup();
  console.error(e.message);
  process.exit(1);
});
