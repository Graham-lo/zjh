#!/usr/bin/env node
/**
 * 好友炸金花 · 命令行版。
 *
 * 和网页版连的是**同一台服务器、同一批房间** —— 朋友把邀请链接发给你，
 * 你在终端里就能和他们坐同一张桌子。功能与网页版对齐：
 * 准备、加电脑、看牌、随时弃牌、跟注、分档加注、梭哈与表态、比牌、
 * 补分、表情、改名、房规、牌桌记录、断线重连恢复座位。
 *
 * 依赖为零：Node 22 起内置全局 WebSocket。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AVATARS, callCost, EMOTES, type GameCommand, type PublicRoom } from '../shared/game.ts';
import { legalActions, parseTarget, RoomClient, type Auth } from '../shared/client.ts';
import type { GameEvent } from '../shared/protocol.ts';
import { ANIM, C, DUEL_TTL, fmt, FRAME, newFx, renderRoom, Screen, TTY, type Fx } from './render.ts';

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
/** 在房间里改完名字也写回本机，下次开 cli 直接就是新名字，不用每次带 --name */
function saveIdent(v: { name: string; avatar: string }) {
  try {
    mkdirSync(STORE, { recursive: true });
    writeFileSync(identFile, JSON.stringify(v));
  } catch {
    /* 存不下就只对这一次会话生效，不值得打断牌局 */
  }
}
const ident = loadIdent();
const name = flag('name') ?? ident.name;
const avatar = flag('avatar') ?? ident.avatar;

/* --------------------------------------------------------------- 画面 */

type Mode = 'play' | 'cmd' | 'compare' | 'emote' | 'profile';
let mode: Mode = 'play';
let buffer = '';
/** 改名换头像时的草稿：名字借用 buffer，头像单独存一个下标 */
let avatarIdx = 0;
/**
 * 危险动作的「再按一次」暂存。
 *
 * 梭哈和退出都是一按下去就没法反悔的事，而它们在键盘上又正好挨着常用键
 * （a 梭哈紧贴 s 看牌，q 退出就压在 a 上面）。第一次按只是把动作举起来，
 * 第二次按同一个键才真的落下；按别的键或者过几秒钟自动放下。
 */
let armed: '' | 'all_in' | 'quit' = '';
let armedTimer: ReturnType<typeof setTimeout> | null = null;
function arm(what: 'all_in' | 'quit', hint: string): void {
  armed = what;
  if (armedTimer) clearTimeout(armedTimer);
  armedTimer = setTimeout(() => {
    armed = '';
    draw();
  }, 4000);
  say(hint, 4000);
}
function disarm() {
  armed = '';
  if (armedTimer) clearTimeout(armedTimer);
  armedTimer = null;
}
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
  // 挂机的定时器挂在这条事件路径上：房间一变就重新上弦，一个回合只上一次
  armAuto();
  draw();
}

let wasOffline = true;

const client = new RoomClient(target, {
  room: (_room, events) => onRoomUpdate(events),
  status: (s) => {
    // 断线重连回来那一下，顶栏的绿点多亮一帧，人才注意得到「回来了」
    if (s === 'online' && wasOffline) fx.online = Date.now();
    // 断过线就把挂机关掉：断线期间桌上发生了什么无从得知，
    // 回来第一件事不该是替人下注 —— 简单、安全优先
    if (s !== 'online' && auto) autoOff(`${C.dim}断线了，自动跟注已关闭${C.reset}`);
    wasOffline = s !== 'online';
    draw();
  },
  // 服务端上线了新版本。网页端会自己挑个不打断牌局的时机刷新，
  // 终端里的进程做不到 —— 硬重启会把这一手牌的画面全部抹掉，所以只提示，
  // 什么时候重开由人自己决定。牌局在服务端，重开之后照样回到原座位。
  outdated: () => say(`${C.gold}服务端已更新到新版本${C.reset}${C.dim}　这一局打完退出重开 cli 就能用上新功能，座位不会丢${C.reset}`, 12000),
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
    auto,
  });
  if (mode === 'cmd') lines.push('', `${C.gold}:${C.reset}${buffer}${C.dim}_${C.reset}`);
  else if (mode === 'compare') {
    lines.push(
      '',
      `${C.gold}和谁比牌？${C.reset} ${compareTargets()
        .map((p, i) => `[${i + 1}] ${p.avatar}${p.name}`)
        .join('   ')}   [esc]取消`,
    );
  } else if (mode === 'emote') {
    lines.push('', `${C.gold}发个表情${C.reset} ${EMOTES.map((e, i) => `[${i + 1}]${e}`).join(' ')}   [esc]取消`);
  } else if (mode === 'profile') {
    const picks = AVATARS.map((a, i) => (i === avatarIdx ? `${C.gold}[${a}]${C.reset}` : `${C.dim} ${a} ${C.reset}`)).join('');
    lines.push(
      '',
      `${C.gold}改名 · 换头像${C.reset}  ${picks}  ${C.dim}[tab/←→]换头像${C.reset}`,
      `${C.gold}昵称${C.reset} ${buffer}${C.dim}_${C.reset}   ${C.dim}[enter]保存  [esc]取消${C.reset}`,
    );
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

/* ----------------------------------------------------------- 自动跟注（挂机） */

/**
 * 挂机跟注。语义和网页版（client/components/ActionBar.tsx）完全一致：
 * 轮到自己就跟，跟不起就梭哈脱身，一分没有就弃牌 —— 「钱没了自动梭哈比牌」。
 *
 * 有人梭哈时**自动关掉、把决定交还给人**：接不接一个全场开牌的注，
 * 不该由一个开关替你决定。开关本身跨局保持，直到手动关或者被上面这条关掉。
 */
const AUTO_DELAY = 450; // 留一下手感：让人看清是挂机在动手，而不是画面自己跳了
let auto = false;
/** 已经为哪个回合排过队。同一回合房间会更新很多次（别人发表情、倒计时），只能触发一次 */
let autoFired = '';
let autoTimer: ReturnType<typeof setTimeout> | null = null;

function autoOff(msg?: string) {
  auto = false;
  autoFired = '';
  if (autoTimer) clearTimeout(autoTimer);
  autoTimer = null;
  if (msg) say(msg);
}

/**
 * 在**事件驱动的路径上**给下一次自动行动上弦（收到房间更新时调用一次），
 * 决策不放在 80ms 的渲染循环里 —— 渲染只负责画，不负责替人下注。
 */
function armAuto() {
  const r = client.room;
  if (!auto || !r) return;
  if (r.allIn) return autoOff(`${C.gold}有人梭哈了，自动跟注已关闭 —— 这一手你自己定${C.reset}`);
  if (!client.myTurn) return;
  const token = `${r.handNo}:${r.turnCount}`;
  if (autoFired === token) return;
  autoFired = token;
  if (autoTimer) clearTimeout(autoTimer);
  autoTimer = setTimeout(autoAct, AUTO_DELAY);
}

/** 真正动手的那一下。450ms 里桌面可能已经变了，所以所有条件在这里重新查一遍 */
function autoAct() {
  autoTimer = null;
  const r = client.room;
  const m = client.me;
  if (!auto || !r || !m || r.allIn || !client.myTurn) return;
  const cost = callCost(r, m); // 和服务端同源，不会「显示能跟、发过去说钱不够」
  if (m.chips > cost) {
    send({ type: 'call' });
    say(`${C.dim}自动跟注 ${fmt(cost)}${C.reset}`, 2500);
  } else if (m.chips > 0) {
    send({ type: 'all_in' });
    say(`${C.dim}跟不起了，自动梭哈${C.reset}`, 2500);
  } else {
    send({ type: 'fold' });
    say(`${C.dim}没分了，自动弃牌${C.reset}`, 2500);
  }
}

function toggleAuto() {
  if (auto) return autoOff(`${C.dim}自动跟注已关闭${C.reset}`);
  auto = true;
  autoFired = '';
  say(`${C.gold}● 自动跟注中${C.reset}${C.dim}　跟不起会梭哈；有人梭哈会自动交还给你${C.reset}`);
  armAuto(); // 可能正好就轮到自己，别等到下一个事件
}

const HELP = [
  `${C.bold}一个键就够${C.reset}`,
  `  ${C.gold}空格${C.reset} / ${C.gold}回车${C.reset} 当前场合的主操作${C.dim}（准备阶段＝准备/开始，牌局中＝跟注/接受梭哈，结算＝下一局）${C.reset}`,
  `${C.bold}左手（单手也能打完整局）${C.reset}`,
  `  ${C.gold}a${C.reset} 梭哈${C.dim}（连按两次）${C.reset}   ${C.gold}s${C.reset} 看牌   ${C.gold}d${C.reset} 跟注/接受   ${C.gold}f${C.reset} 弃牌${C.dim}（随时可弃）${C.reset}   ${C.gold}v${C.reset} 比牌   ${C.gold}g${C.reset} 自动跟注   ${C.gold}1-4${C.reset} 加注档位`,
  `${C.bold}右手（同一套动作的镜像，位置一一对应）${C.reset}`,
  `  ${C.gold};${C.reset} 梭哈${C.dim}（连按两次）${C.reset}   ${C.gold}k${C.reset} 看牌   ${C.gold}j${C.reset} 跟注/接受   ${C.gold}l${C.reset} 弃牌   ${C.gold}7-0${C.reset} 加注档位`,
  `${C.bold}有人梭哈时${C.reset}`,
  `  ${C.gold}y${C.reset} 接受    ${C.gold}n${C.reset} 弃牌出局    ${C.gold}s${C.reset}/${C.gold}k${C.reset} 先看牌${C.dim}（看完接的价翻倍，闷着接是半价）${C.reset}`,
  `${C.bold}牌局之外${C.reset}`,
  `  ${C.gold}r${C.reset} 准备    ${C.gold}b${C.reset} 加电脑    ${C.gold}n${C.reset} 下一局    ${C.gold}m${C.reset} 补分    ${C.gold}o${C.reset} 房规    ${C.gold}i${C.reset} 邀请链接`,
  `  ${C.gold}p${C.reset} 改名换头像${C.dim}（什么时候都能改）${C.reset}    ${C.gold}e${C.reset} 表情    ${C.gold}:${C.reset} 命令    ${C.gold}?${C.reset} 帮助    ${C.gold}q${C.reset} 退出${C.dim}（连按两次；牌局中退出＝自动弃牌离场）${C.reset}`,
  `  ${C.gold}g${C.reset} 自动跟注（挂机）：轮到自己就跟，跟不起自动梭哈，没分了弃牌；${C.dim}有人梭哈会自动关掉交还给你${C.reset}`,
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

/**
 * 键位布局。改版的出发点是「手不用在键盘上跑来跑去」：
 *
 * - **最常按的那一下给最大的键。** 一局牌里绝大多数决定其实是「跟」和「继续」，
 *   所以空格/回车固定是当前场合的主操作 —— 准备阶段是准备/开局，牌局中是跟注
 *   （有人梭哈时就是接），结算是下一局。不认字也知道往下按空格。
 * - **左右手各有一套完整键位，位置一一对应。** 左手落在 asdf 上（a 梭哈 s 看牌
 *   d 跟注 f 弃牌），右手落在 ;lkj 上（; 梭哈 k 看牌 j 跟注 l 弃牌）——
 *   同一根手指在两只手上做同一件事。一只手端着杯子也能把一局打完。
 * - **加注档位同样成对**：左手 1-4，右手 7-0（7 是第一档，0 是第四档）。
 * - **不可挽回的动作要连按两次。** 梭哈（a / ;）和退出（q）都是一下就没法反悔的，
 *   而 q 正好压在 a 上面、a 又紧挨着 s —— 手滑一次代价太大，所以第一次按只是举起来。
 * - **旧键位全部保留**：k 看牌、c 跟注、f 弃牌、a 梭哈、v 比牌，习惯了的人不用重学。
 */
function handleKey(key: string) {
  const r = client.room;
  if (!r) return;
  const acts = legalActions(r);
  const can = (a: string) => acts.some((x) => x.action === a);
  // 举起来的动作只认举起它的那个键，按到别的键就等于改主意了
  const wasArmed = armed;
  const confirmKeys = wasArmed === 'quit' ? ['q'] : ['a', ';'];
  if (wasArmed && !confirmKeys.includes(key)) disarm();

  switch (key) {
    case 'q':
      if (wasArmed === 'quit') {
        disarm();
        return quit();
      }
      return arm(
        'quit',
        r.phase === 'playing' && me().status === 'active'
          ? `${C.red}再按一次 q 退出${C.reset}${C.dim}　牌局中退出＝自动弃牌离场${C.reset}`
          : `${C.gold}再按一次 q 退出${C.reset}`,
      );
    case ':':
      mode = 'cmd';
      buffer = '';
      return draw();
    case 'e':
      mode = 'emote';
      return draw();
    case 'p': {
      // 改名换头像不挑时候：名字是自己怎么被称呼，不是牌桌状态
      mode = 'profile';
      buffer = me().name;
      avatarIdx = Math.max(0, AVATARS.indexOf(me().avatar));
      return draw();
    }
    case 'i':
      return say(`${C.gold}邀请链接${C.reset} ${target.origin}/?room=${r.code}`, 8000);
    case '?':
      return say(HELP, 14000);
    case 'g':
      // 提示行只在 playing 里显示，但按键任何阶段都认：牌局间隙先挂上，开局就自己打
      return toggleAuto();
  }

  // 空格和回车是同一个键：当前这一屏最该按的那一下
  const primary = key === ' ' || key === '\r' || key === '\n';

  if (r.phase === 'lobby') {
    const host = r.hostId === me().id;
    if (primary) {
      // 房主人齐了就开局，其余情况一律是「准备 / 取消准备」
      if (host && r.players.filter((p) => p.isBot || p.ready).length === r.players.length && r.players.length >= 2) {
        return send({ type: 'start' });
      }
      return send({ type: 'ready', ready: !me().ready });
    }
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
    if (key === 'n' || primary) return send({ type: 'new_round' });
    if (key === 'm') return send({ type: 'top_up' });
    return;
  }

  // 梭哈表态用一对专用键：y=接、n=弃。跟注/弃牌那一套键照旧可用，但在「跟注」和
  // 「接受梭哈」之间复用同一个键，正是这一刻最容易按错的地方。
  if (r.allIn) {
    if (key === 'y') {
      if (can('accept')) return send({ type: 'call' });
      return say(`${C.dim}你已经表过态了${C.reset}`);
    }
    if (key === 'n') {
      if (can('fold')) return send({ type: 'fold' });
      return say(`${C.dim}你已经不在这局里了${C.reset}`);
    }
  }
  if ((key === 'k' || key === 's') && can('look')) return send({ type: 'look' });
  if ((key === 'f' || key === 'l') && can('fold')) return send({ type: 'fold' });
  if (key === 'c' || key === 'd' || key === 'j' || primary) {
    if (can('accept') || can('call')) return send({ type: 'call' });
    if (primary) return; // 空格是万能键，按在没得跟的时候安静就好，不用报错
    return say(`${C.dim}现在跟不了${C.reset}`);
  }
  if (key === 'a' || key === ';') {
    if (!can('all_in')) return say(`${C.dim}现在不能梭哈${C.reset}`);
    if (wasArmed === 'all_in') {
      disarm();
      return send({ type: 'all_in' });
    }
    const cost = acts.find((x) => x.action === 'all_in')?.cost ?? 0;
    return arm('all_in', `${C.bold}${C.gold}再按一次梭哈 ${fmt(cost)}${C.reset}`);
  }
  if (key === 'v') {
    if (!can('compare')) return say(`${C.dim}现在不能比牌${C.reset}`);
    mode = 'compare';
    return draw();
  }
  // 加注档位：左手 1-4，右手 7-0（右手那一排在键盘上是反着数的，7 才是第一档）
  const tiers = raiseTiers();
  const left = /^[1-9]$/.test(key) ? tiers[Number(key) - 1] : undefined;
  const right = '7890'.includes(key) ? tiers['7890'.indexOf(key)] : undefined;
  const tier = left ?? right;
  if (tier) return send({ type: 'raise', unit: tier.unit! });
}

function runCommand(input: string) {
  const parts = input.trim().split(/\s+/);
  const head = parts[0];
  const rest = parts.slice(1);
  const arg = rest.join(' ');
  switch (head) {
    case 'name': {
      if (!arg) return say('用法 :name 新昵称');
      const nick = arg.slice(0, 10);
      saveIdent({ name: nick, avatar: me().avatar });
      return send({ type: 'rename', name: nick, avatar: me().avatar });
    }
    case 'avatar':
      if (!AVATARS.includes(arg)) return say(`可选头像：${AVATARS.join(' ')}`);
      saveIdent({ name: me().name, avatar: arg });
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
  if (mode === 'profile') {
    // tab 和左右方向键都能换头像 —— 方向键在有些终端里是三个字节的转义序列
    if (s === '\t' || s === '\u001B[C') {
      avatarIdx = (avatarIdx + 1) % AVATARS.length;
      return draw();
    }
    if (s === '\u001B[D') {
      avatarIdx = (avatarIdx - 1 + AVATARS.length) % AVATARS.length;
      return draw();
    }
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
    if (was === 'cmd' && text.trim()) runCommand(text);
    if (was === 'profile') {
      const nick = text.trim().slice(0, 10) || me().name;
      send({ type: 'rename', name: nick, avatar: AVATARS[avatarIdx] });
      saveIdent({ name: nick, avatar: AVATARS[avatarIdx] });
    }
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
