/** 命令行版的画面渲染。只用 ANSI 转义，不依赖任何终端库。 */
import type { Card, PublicRoom } from '../shared/game.ts';
import { cardText, legalActions } from '../shared/client.ts';
import { evaluateHand, handPercentile } from '../shared/game.ts';
import type { AccountInfo } from '../shared/protocol.ts';

const E = '\u001B'; // ESC，写成转义避免源码里出现裸控制字符
export const C = {
  reset: `${E}[0m`,
  dim: `${E}[2m`,
  bold: `${E}[1m`,
  gold: `${E}[38;5;179m`,
  green: `${E}[38;5;71m`,
  red: `${E}[38;5;174m`,
  blue: `${E}[38;5;110m`,
  purple: `${E}[38;5;140m`,
  white: `${E}[38;5;255m`,
  clear: `${E}[2J${E}[H`,
  hideCursor: `${E}[?25l`,
  showCursor: `${E}[?25h`,
};

export const fmt = (n: number) => n.toLocaleString('zh-CN');

/** 结算动画的时间轴：第 i 行在什么时候出现、数字滚到几成 */
const ROW_DELAY = 160;
const ROW_START = 420;
const COUNT_MS = 500;
const easeOut = (k: number) => 1 - (1 - k) ** 3;

function countAt(value: number, settleT: number | null, delay: number): number {
  if (settleT == null) return value;
  const k = Math.max(0, Math.min(1, (settleT - delay) / COUNT_MS));
  return Math.round(value * easeOut(k));
}
const shownAt = (settleT: number | null, delay: number) => settleT == null || settleT >= delay;

const ANSI = new RegExp(`${E}\\[[0-9;]*m`, 'g');

/** 去掉颜色码后的显示宽度，中文按两格算，否则表格会歪 */
function width(s: string): number {
  let w = 0;
  for (const ch of s.replace(ANSI, '')) {
    w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1;
  }
  return w;
}
function pad(s: string, n: number): string {
  const gap = n - width(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}

const SUIT: Record<string, string> = { S: '♠', H: '♥', C: '♣', D: '♦' };
const RANK: Record<number, string> = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const isRed = (c: Card) => c.suit === 'H' || c.suit === 'D';

/**
 * 把手牌画成真正的牌面。看牌这一下是牌桌上最有仪式感的动作，
 * 在终端里也不该只是打印三个字符。
 */
export function cardArt(cards: Card[], count = 3): string[] {
  const rows = ['', '', '', '', ''];
  const n = cards.length ? cards.length : count;
  for (let i = 0; i < n; i++) {
    const c = cards[i];
    if (!c) {
      rows[0] += `${C.blue}┌─────┐${C.reset} `;
      rows[1] += `${C.blue}│▒▒▒▒▒│${C.reset} `;
      rows[2] += `${C.blue}│▒▒▒▒▒│${C.reset} `;
      rows[3] += `${C.blue}│▒▒▒▒▒│${C.reset} `;
      rows[4] += `${C.blue}└─────┘${C.reset} `;
      continue;
    }
    const color = isRed(c) ? C.red : C.white;
    const r = RANK[c.rank] ?? String(c.rank);
    const s = SUIT[c.suit] ?? c.suit;
    rows[0] += `${color}┌─────┐${C.reset} `;
    rows[1] += `${color}│${pad(r, 2)}   │${C.reset} `;
    rows[2] += `${color}│  ${s}  │${C.reset} `;
    rows[3] += `${color}│   ${pad(r, 2)}│${C.reset} `;
    rows[4] += `${color}└─────┘${C.reset} `;
  }
  return rows;
}

function seatCards(p: PublicRoom['players'][number], dealt = true): string {
  // 发牌动画期间，还没轮到这个座位就先空着
  if (!dealt) return `${C.dim}· · ·${C.reset}`;
  if (p.status === 'waiting') return `${C.dim}等待下局${C.reset}`;
  if (p.hand.length === 3) {
    const cards = p.hand.map((c) => `${isRed(c) ? C.red : C.white}${cardText(c)}${C.reset}`).join(' ');
    return `${cards} ${C.gold}${evaluateHand(p.hand).name}${C.reset}`;
  }
  if (p.status === 'folded') return `${C.dim}已弃牌${C.reset}`;
  if (p.hasHand) return `${C.blue}▨ ▨ ▨${C.reset}`;
  return '';
}

export function renderRoom(
  room: PublicRoom,
  latency: number,
  status: string,
  origin: string,
  account?: AccountInfo | null,
  /** 距离本局结算开始过了多少毫秒；null 表示不做动画 */
  settleT: number | null = null,
  /** 距离本局开牌过了多少毫秒；null 表示不做发牌动画 */
  dealT: number | null = null,
): string {
  const me = room.players.find((p) => p.id === room.viewerId);
  const L: string[] = [];
  const line = (s = '') => L.push(s);
  const rule = () => line(`${C.dim}${'─'.repeat(74)}${C.reset}`);

  const net = status === 'online' ? `${C.green}●${C.reset} ${latency}ms` : `${C.red}●${C.reset} ${status}`;
  const acc = account
    ? (() => {
        const v = account.chips - account.granted;
        return `   ${v >= 0 ? C.green : C.red}净战绩 ${v >= 0 ? '+' : ''}${fmt(v)}${C.reset}`;
      })()
    : '';
  line(`${C.bold}${C.gold}好友炸金花${C.reset}  房间 ${C.bold}${room.code}${C.reset}   ${net}${acc}`);
  line(`${C.dim}邀请链接 ${origin}/?room=${room.code}${C.reset}`);
  line();

  const phase = room.phase === 'lobby' ? '准备中' : room.phase === 'playing' ? '进行中' : '本局结束';
  const meta =
    room.phase === 'playing'
      ? `底池 ${C.gold}${C.bold}${fmt(room.pot)}${C.reset}   底注 ${fmt(room.betUnit)}   第 ${room.handNo} 局 · 第 ${room.roundNo}/${room.settings.maxRounds} 轮`
      : `${room.players.length}/${room.settings.maxPlayers} 人   底注 ${fmt(room.settings.ante)}   ${room.settings.maxRounds} 轮封顶   行动限时 ${room.settings.turnSeconds}s`;
  line(`${C.bold}${phase}${C.reset}   ${meta}`);
  rule();

  const seated = [...room.players].sort((a, b) => a.seat - b.seat);
  for (const [idx, p] of seated.entries()) {
    const dealt = dealT == null || dealT > 140 + idx * 130;
    const isMe = p.id === room.viewerId;
    const turn = room.phase === 'playing' && room.turnSeat === p.seat;
    const marks = [
      room.hostId === p.id ? `${C.gold}房主${C.reset}` : '',
      p.isBot ? `${C.blue}电脑${C.reset}` : '',
      p.isAgent ? `${C.purple}AI${C.reset}` : '',
      !p.online && !p.isBot ? `${C.red}离线${C.reset}` : '',
      room.phase === 'lobby' && !p.isBot ? (p.ready ? `${C.green}已准备${C.reset}` : `${C.dim}未准备${C.reset}`) : '',
    ]
      .filter(Boolean)
      .join(' ');
    const cursor = turn ? `${C.gold}▶${C.reset}` : ' ';
    const nm = isMe ? `${C.bold}${C.white}${p.name}${C.reset}` : p.name;
    const bet = p.bet > 0 ? `${C.gold}+${fmt(p.bet)}${C.reset}` : '';
    line(
      `${cursor} ${C.dim}${p.seat}${C.reset} ${p.avatar} ${pad(nm, 12)} ${pad(fmt(p.chips), 8)} ${pad(bet, 8)} ` +
        `${pad(seatCards(p, dealt), 26)} ${marks}${p.lastAction ? ` ${C.dim}${p.lastAction}${C.reset}` : ''}`,
    );
  }
  rule();

  if (room.allIn) {
    line(
      `${C.bold}${C.gold}⚡ ${room.allIn.initiatorName} 梭哈 ${fmt(room.allIn.amount)}${C.reset}` +
        `   已接 ${room.allIn.accepted.length} 家，还有 ${room.allIn.pending.length} 家未表态`,
    );
    line();
  }
  if (room.phase === 'round_end' && room.result) {
    line(
      `${C.bold}${C.gold}本局赢家 ${room.result.winnerName}   +${fmt(room.result.potWon)}${C.reset}   ${C.dim}${room.result.reason}${C.reset}`,
    );
    // 自己的盈亏单独一行，最显眼；数字是滚出来的，不是拍出来的
    const deltas = room.result.deltas ?? [];
    const sign = (n: number) => `${n >= 0 ? '+' : ''}${fmt(n)}`;
    const mine = deltas.find((d) => d.id === room.viewerId);
    if (mine && shownAt(settleT, 120)) {
      const col = mine.delta >= 0 ? C.green : C.red;
      line(
        `  ${C.bold}你本局 ${col}${sign(countAt(mine.delta, settleT, 120))}${C.reset}` +
          `   ${C.dim}投入 ${fmt(mine.bet)}（含底注 ${fmt(room.settings.ante)}）` +
          ` · 本桌累计 ${sign(countAt(mine.net, settleT, 220))}${C.reset}`,
      );
    }
    if (deltas.length && shownAt(settleT, ROW_START - 60)) {
      line(`  ${C.dim}${pad('玩家', 16)}${pad('投入', 10)}${pad('本局', 12)}本桌累计${C.reset}`);
      deltas.forEach((d, i) => {
        const at = ROW_START + i * ROW_DELAY;
        if (!shownAt(settleT, at)) return;
        const isMe = d.id === room.viewerId;
        const won = d.id === room.result!.winnerId;
        const col = (n: number) => (n >= 0 ? C.green : C.red);
        const hand = room.result!.hands[d.id];
        const type = hand?.length === 3 ? ` ${C.gold}${evaluateHand(hand).name}${C.reset}` : '';
        line(
          `  ${isMe ? C.bold : ''}${won ? C.gold : ''}${pad(`${d.avatar} ${d.name}`, 16)}${C.reset}` +
            `${pad(fmt(d.bet), 10)}` +
            `${col(d.delta)}${pad(sign(countAt(d.delta, settleT, at)), 12)}${C.reset}` +
            `${col(d.net)}${sign(countAt(d.net, settleT, at + 100))}${C.reset}${type}`,
        );
      });
    }
    line();
  }

  // 自己的牌：看过就画出牌面，没看就是三张背面
  if (me && me.status === 'active' && (me.hand.length === 3 || me.hasHand)) {
    const myIdx = seated.findIndex((p) => p.id === me.id);
    if (dealT != null && dealT <= 140 + myIdx * 130) {
      line(`  ${C.dim}发牌中…${C.reset}`);
      line();
    } else {
    const revealed = me.hand.length === 3;
    for (const row of cardArt(revealed ? me.hand : [])) line(`  ${row}`);
    if (revealed) {
      const e = evaluateHand(me.hand);
      const pct = Math.round(handPercentile(me.hand) * 100);
      line(`  ${C.bold}${C.gold}${e.name}${C.reset}   ${C.dim}牌力超过 ${pct}% 的随机牌${C.reset}`);
    } else {
      line(`  ${C.dim}按 ${C.gold}k${C.reset}${C.dim} 看牌（看牌后下注翻倍）${C.reset}`);
    }
    line();
    }
  }

  const turnP = room.players.find((p) => p.seat === room.turnSeat);
  if (room.phase === 'playing' && turnP) {
    const left = room.turnDeadline ? Math.max(0, Math.round((room.turnDeadline - Date.now()) / 1000)) : null;
    line(
      turnP.id === room.viewerId
        ? `${C.bold}${C.gold}▶ 轮到你${C.reset}${left != null ? `   还剩 ${left}s` : ''}`
        : `${C.dim}等待 ${turnP.name} 行动…${left != null ? `   ${left}s` : ''}${C.reset}`,
    );
    line();
  }

  // 牌局日志和聊天：命令行里这是唯一的「氛围」来源，别省
  const logs = room.log.slice(-7);
  const chats = room.chat.slice(-4);
  if (logs.length || chats.length) {
    line(`${C.dim}── 牌桌记录 ${'─'.repeat(58)}${C.reset}`);
    for (const l of logs) line(`  ${C.dim}·${C.reset} ${l.text}`);
    for (const c of chats) line(`  ${C.blue}${c.avatar} ${c.name}${C.reset}：${c.text}`);
    line();
  }

  line(hintLine(room));
  return L.join('\n');
}

function hintLine(room: PublicRoom): string {
  const me = room.players.find((p) => p.id === room.viewerId);
  if (!me) return '';
  const k = (key: string, label: string) => `${C.gold}[${key}]${C.reset}${label}`;
  if (room.phase === 'lobby') {
    const host = room.hostId === me.id;
    return [
      k('r', me.ready ? '取消准备' : '准备'),
      host ? k('s', '开始') : '',
      host ? k('b', '加电脑') : '',
      host ? k('o', '房规') : '',
      k('m', '补分'),
      k('i', '邀请'),
      k('t', '聊天'),
      k(':', '命令'),
      k('q', '退出'),
    ]
      .filter(Boolean)
      .join('  ');
  }
  if (room.phase === 'round_end') {
    const host = room.hostId === me.id;
    return [
      host ? k('n', '下一局') : `${C.dim}等待下一局${C.reset}`,
      k('t', '聊天'),
      k('e', '表情'),
      k(':', '命令'),
      k('q', '退出'),
    ].join('  ');
  }
  const acts = legalActions(room);
  const parts: string[] = [];
  for (const a of acts) {
    if (a.action === 'look') parts.push(k('k', '看牌'));
    if (a.action === 'fold') parts.push(k('f', '弃牌'));
    if (a.action === 'call') parts.push(k('c', `跟注 ${fmt(a.cost!)}`));
    if (a.action === 'accept') parts.push(k('c', `接受梭哈 ${fmt(a.cost!)}`));
    if (a.action === 'all_in') parts.push(k('a', `梭哈 ${fmt(a.cost!)}`));
  }
  const raises = acts.filter((a) => a.action === 'raise');
  if (raises.length) parts.push(k(`1-${raises.length}`, `加注 ${raises.map((r) => fmt(r.unit!)).join('/')}`));
  if (acts.some((a) => a.action === 'compare')) parts.push(k('v', '比牌'));
  parts.push(k('t', '聊天'), k('e', '表情'), k(':', '命令'), k('?', '帮助'));
  return parts.join('  ');
}
