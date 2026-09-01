/** 命令行版的画面渲染。只用 ANSI 转义，不依赖任何终端库。 */
import type { Card, PublicRoom } from '../shared/game.ts';
import { cardText, legalActions } from '../shared/client.ts';
import { evaluateHand, handPercentile } from '../shared/game.ts';
import type { AccountInfo } from '../shared/protocol.ts';

const E = '\u001B'; // ESC，写成转义避免源码里出现裸控制字符

/**
 * 颜色和帧动画共用同一个开关。
 *
 * 输出被重定向到管道（`zjh … | tee`、CI、被别的程序读）时，转义序列只会变成垃圾字符；
 * 逐帧重绘在那种场合更是纯噪音 —— 一帧一屏地刷进日志里谁也看不了。
 * 所以 NO_COLOR 或非 TTY 时两者一起关掉，降级成「整帧纯文本」输出。
 */
export const TTY = process.stdout.isTTY === true;
export const COLOR = TTY && !process.env.NO_COLOR;
export const ANIM = COLOR;

/** 统一帧长：所有动画都按它推进，快慢只体现在「几帧」上，不各自定时器各自跑 */
export const FRAME = 80;

/** 牌桌的内容宽度，横线、梭哈横幅、对决行都按它对齐 */
const WIDTH = 74;

const sgr = (code: string) => (COLOR ? `${E}[${code}m` : '');
export const C = {
  reset: sgr('0'),
  dim: sgr('2'),
  bold: sgr('1'),
  /** 反显。梭哈砸下来和比牌合拢那一帧全靠它出重量 */
  invert: sgr('7'),
  gold: sgr('38;5;179'),
  green: sgr('38;5;71'),
  red: sgr('38;5;174'),
  blue: sgr('38;5;110'),
  purple: sgr('38;5;140'),
  white: sgr('38;5;255'),
  clear: TTY ? `${E}[2J${E}[H` : '',
  hideCursor: TTY ? `${E}[?25l` : '',
  showCursor: TTY ? `${E}[?25h` : '',
};

export const fmt = (n: number) => n.toLocaleString('zh-CN');

/* ------------------------------------------------------------ 宽度与裁剪 */

const ANSI = new RegExp(`${E}\\[[0-9;]*m`, 'g');
// 拆成「一段颜色码」或「一个码位」，裁剪时颜色码不占宽度也不能被切断
const TOKEN = new RegExp(`${E}\\[[0-9;]*m|.`, 'gu');

const CJK = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/;
// 头像和表情都在这一段里，终端按两格画；变体选择符本身不占位
const EMOJI = /[\u{1F000}-\u{1FAFF}]/u;

function charWidth(ch: string): number {
  if (ch === '\uFE0F' || ch === '\u200D') return 0;
  return CJK.test(ch) || EMOJI.test(ch) ? 2 : 1;
}

/** 去掉颜色码后的显示宽度，中文按两格算，否则表格会歪 */
function width(s: string): number {
  let w = 0;
  for (const ch of s.replace(ANSI, '')) w += charWidth(ch);
  return w;
}
function pad(s: string, n: number): string {
  const gap = n - width(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}
function padLeft(s: string, n: number): string {
  const gap = n - width(s);
  return gap > 0 ? ' '.repeat(gap) + s : s;
}
function center(s: string, n: number): string {
  const gap = n - width(s);
  if (gap <= 0) return s;
  return ' '.repeat(Math.floor(gap / 2)) + s + ' '.repeat(gap - Math.floor(gap / 2));
}

/** 按显示宽度裁剪。终端窄的时候必须裁，否则一行折成两行，行号就全错位了 */
function clip(s: string, cols: number): string {
  if (width(s) <= cols) return s;
  let out = '';
  let w = 0;
  let colored = false;
  for (const m of s.matchAll(TOKEN)) {
    const t = m[0];
    if (t.startsWith(E)) {
      out += t;
      colored = true;
      continue;
    }
    const cw = charWidth(t);
    if (w + cw > cols) break;
    out += t;
    w += cw;
  }
  return colored ? out + C.reset : out;
}
/** 裁到正好 n 格再补齐，牌面这种要严格对齐的地方用 */
const fixed = (s: string, n: number) => pad(clip(s, n), n);

/**
 * 整行压暗。行内已有的 reset 会顺手把 dim 也清掉，
 * 所以每个 reset 后面都得把 dim 补回去，断线那一行才会整条暗下去。
 */
function dimLine(s: string): string {
  if (!COLOR) return s;
  return `${C.dim}${s.split(C.reset).join(`${C.reset}${C.dim}`)}${C.reset}`;
}

/* -------------------------------------------------------------- 差分重绘 */

/**
 * 按行 diff 的屏幕。
 *
 * 动画一秒钟要画十几帧，如果每帧都 `ESC[2J` 清屏再整屏重写，终端会在
 * 「空屏」和「新内容」之间反复横跳 —— 那就是闪屏。这里只把**变化的行**
 * 定位过去重写（ESC[row;1H + ESC[K），没变的行一个字节都不发；
 * 整屏 clear 只留给尺寸变化和进出房间这种「旧行号全部作废」的场合。
 */
export class Screen {
  private prev: string[] = [];
  private cols = 0;
  private rows = 0;

  /** 让下一次 paint 走整屏重画。进出房间时调用 */
  invalidate() {
    this.prev = [];
    this.cols = 0;
    this.rows = 0;
  }

  paint(lines: string[]) {
    if (!COLOR) {
      // 降级模式：整帧文本一次吐完，不做逐行定位。
      // 管道里 C.clear 是空串，出来就是干净的纯文本；NO_COLOR 的真终端里
      // 它是一次清屏，画面仍然是「替换」而不是无限往下滚。
      process.stdout.write(`${C.clear}${lines.join('\n')}\n`);
      return;
    }
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    let out = '';
    if (cols !== this.cols || rows !== this.rows) {
      out += C.clear;
      this.prev = [];
      this.cols = cols;
      this.rows = rows;
    }
    const view = this.fit(lines, cols, rows);
    const n = Math.max(view.length, this.prev.length);
    for (let i = 0; i < n; i++) {
      const next = view[i] ?? '';
      if (next === this.prev[i]) continue;
      out += `${E}[${i + 1};1H${E}[K${next}`;
    }
    this.prev = view;
    if (out) process.stdout.write(out);
  }

  /** 退出时把光标放到内容下面，别让 shell 提示符压在牌桌中间 */
  end() {
    if (!TTY) return;
    // 降级模式没有逐行记账，光标本来就在末尾，直接把光标放回来即可
    const home = COLOR ? `${E}[${this.prev.length + 1};1H` : '';
    process.stdout.write(`${home}${C.showCursor}\n`);
  }

  /**
   * 绝对行定位的前提是终端不滚动，所以超高就得砍。
   * 砍中间不砍尾巴 —— 最后一行是按键提示，比日志重要。
   */
  private fit(lines: string[], cols: number, rows: number): string[] {
    const clipped = lines.map((l) => clip(l, cols));
    if (clipped.length <= rows) return clipped;
    return [...clipped.slice(0, rows - 1), clipped[clipped.length - 1]];
  }
}

/* ------------------------------------------------------------ 动画的时间轴 */

export interface Duelist {
  avatar: string;
  name: string;
  won: boolean;
}

/**
 * 一帧里所有动画共享的时间信息。
 *
 * 这里只放**起点时间戳**，不放动画进度 —— 进度永远由 `now - 起点` 现算，
 * 所以掉帧、卡顿、终端被挂起都不会让动画错位。起点全部由服务器推来的
 * 事件写入（见 cli/main.ts），渲染这边不自己编状态。
 */
export interface Fx {
  /** 本帧的时间戳；一帧内所有动画共用，避免同一帧里各算各的 */
  now: number;
  /** 帧动画总开关。关掉时所有动画直接呈现终态 */
  anim: boolean;
  /** 进房间的时刻，标题打字机按它展开 */
  enter: number;
  /** 本局发牌开始 */
  deal: number | null;
  /** 本局结算开始 */
  settle: number | null;
  /** 自己看牌的时刻，牌面按它逐张展开 */
  look: number | null;
  /** 梭哈横幅 */
  allIn: { at: number; amount: number } | null;
  /** 比牌对决行 */
  duel: { at: number; a: Duelist; b: Duelist } | null;
  /** 最近一次重连成功的时刻，绿点多闪一帧 */
  online: number | null;
}

export function newFx(now = Date.now()): Fx {
  return { now, anim: ANIM, enter: now, deal: null, settle: null, look: null, allIn: null, duel: null, online: null };
}

/**
 * 距离某个动画起点过了多久。
 * 没有起点、或者动画被关掉时返回 Infinity —— 后面所有 `t >= 阈值` 的判断
 * 就会自然落到终态，不用在每处再写一遍「如果不做动画则…」。
 */
function since(fx: Fx, at: number | null): number {
  return !fx.anim || at == null ? Infinity : fx.now - at;
}
/** 以 ms 为周期闪烁；不做动画时恒定点亮，信息不会丢 */
function blink(fx: Fx, period: number): boolean {
  return !fx.anim || Math.floor(fx.now / period) % 2 === 0;
}

/* --------------------------------------------------------------- 结算时间轴 */

const ROW_DELAY = 200; // 摊牌逐行阶梯
const ROW_START = 420;
const COUNT_MS = 500;
const SPARK_MS = 200; // 赢家两侧 ✦/✧ 交替的半周期
const easeOut = (k: number) => 1 - (1 - k) ** 3;

function countAt(value: number, t: number, delay: number): number {
  const k = Math.max(0, Math.min(1, (t - delay) / COUNT_MS));
  return Math.round(value * easeOut(k));
}
const shownAt = (t: number, delay: number) => t >= delay;

/* ------------------------------------------------------------------ 牌面 */

const SUIT: Record<string, string> = { S: '♠', H: '♥', C: '♣', D: '♦' };
const RANK: Record<number, string> = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const isRed = (c: Card) => c.suit === 'H' || c.suit === 'D';

const CARD_W = 7; // 牌面全宽
const SLOT = CARD_W + 1; // 牌与牌之间空一列
const GROW_W = [3, 5, 7]; // 看牌时窄→全宽的三帧

/** 单张牌的五行。cards 里没有这张就画牌背。 */
function cardBox(c: Card | undefined, w: number): string[] {
  const inner = w - 2;
  const top = `╭${'─'.repeat(inner)}╮`;
  const bot = `╰${'─'.repeat(inner)}╯`;
  if (!c) {
    const fill = `│${'▒'.repeat(inner)}│`;
    return [top, fill, fill, fill, bot].map((s) => `${C.blue}${s}${C.reset}`);
  }
  const color = isRed(c) ? C.red : C.white;
  const r = RANK[c.rank] ?? String(c.rank);
  const s = SUIT[c.suit] ?? c.suit;
  // 窄帧里没有空间留缩进，宽到 5 格才把点数往里让一格
  const lead = inner >= 5 ? ' ' : '';
  return [
    top,
    `│${fixed(`${lead}${r}`, inner)}│`,
    `│${center(clip(s, inner), inner)}│`,
    `│${padLeft(clip(`${r}${lead}`, inner), inner)}│`,
    bot,
  ].map((x) => `${color}${x}${C.reset}`);
}

/**
 * 把手牌画成真正的牌面。看牌这一下是牌桌上最有仪式感的动作，
 * 在终端里也不该只是打印三个字符。
 *
 * slide[i] 第 i 张牌离最终位置还差多少列（发牌时自右滑入），负数表示还没发到；
 * grow[i]  第 i 张牌的展开帧：负数 = 还是牌背，0–2 = 窄→全宽，>=3 = 已经全开。
 */
export function cardArt(
  cards: Card[],
  opts: { count?: number; slide?: number[]; grow?: number[] } = {},
): string[] {
  const rows = ['', '', '', '', ''];
  const cols = [0, 0, 0, 0, 0];
  const n = cards.length ? cards.length : (opts.count ?? 3);
  for (let i = 0; i < n; i++) {
    const slide = opts.slide ? opts.slide[i] : 0;
    if (slide < 0) continue; // 还没发到这一张，位置先空着
    const g = opts.grow ? opts.grow[i] : 3;
    const w = g < 0 || g >= 3 ? CARD_W : GROW_W[g];
    const box = cardBox(g < 0 ? undefined : cards[i], w);
    // 窄帧在自己的格子里居中展开，看起来是「从中间撑开」而不是往右长
    const at = i * SLOT + slide + Math.floor((CARD_W - w) / 2);
    for (let j = 0; j < 5; j++) {
      rows[j] += ' '.repeat(Math.max(0, at - cols[j])) + box[j];
      cols[j] = at + w;
    }
  }
  // 五行等宽，否则差分重绘时右边会留上一帧的残影
  const full = n * SLOT;
  return rows.map((r) => pad(r, full));
}

const DEAL_STEP = 90; // 自己三张牌之间的间隔
const DEAL_MS = 60; // 每滑一帧
const LOOK_STEP = 90; // 看牌时三张牌之间的间隔
const LOOK_MS = 70; // 每展开一帧
const LOOK_DONE = 2 * LOOK_STEP + 3 * LOOK_MS; // 三张都开完

/** 发牌：自右侧偏移 4 → 2 → 0 列滑到位 */
function dealSlides(t: number): number[] {
  return [0, 1, 2].map((i) => {
    const ct = t - i * DEAL_STEP;
    if (ct < 0) return -1;
    const f = Math.floor(ct / DEAL_MS);
    return f >= 2 ? 0 : (2 - f) * 2;
  });
}
/** 看牌：牌背 → 窄 → 中 → 全宽 */
function lookStages(t: number): number[] {
  return [0, 1, 2].map((i) => {
    const ct = t - i * LOOK_STEP;
    return ct < 0 ? -1 : Math.min(3, Math.floor(ct / LOOK_MS));
  });
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

/* ------------------------------------------------------------- 单条动效 */

const TITLE = '♠ 好友炸金花';

/** 进房间时标题一列一列长出来，比「唰」地整屏出现有分量 */
function titleText(fx: Fx): { text: string; done: boolean } {
  const t = since(fx, fx.enter);
  const full = width(TITLE);
  if (t === Infinity) return { text: TITLE, done: true };
  const cols = Math.min(full, 1 + Math.floor(t / FRAME));
  return { text: clip(TITLE, cols), done: cols >= full };
}

/** 底池热度：越大火苗越高，三档。用底注做标尺，换房规也不会一直烧到顶 */
function potFlame(pot: number, ante: number): string {
  const unit = Math.max(1, ante);
  const tier = pot >= unit * 15 ? 3 : pot >= unit * 6 ? 2 : 1;
  const col = tier === 3 ? C.red : tier === 2 ? C.gold : C.dim;
  return `${col}${pad('▁▂▃'.slice(0, tier), 3)}${C.reset}`;
}

const BAR = 18; // 常驻进度条格数
const HOT_SECONDS = 8; // 最后 8 秒进入红色警戒

function turnBar(left: number | null, total: number, hot: boolean): string {
  if (left == null) return '';
  const cells = Math.max(0, Math.min(BAR, Math.round((left / Math.max(1, total)) * BAR)));
  return `${hot ? C.red : C.gold}${'█'.repeat(cells)}${C.reset}${C.dim}${'░'.repeat(BAR - cells)}${C.reset}`;
}

// 冲击波：▓ 由密到疏地往外散，三帧之后落定成一条稀疏的边
const SHOCK = ['▓', '▓ ', '▓   ', '▓     '];
const BANNER_MS = 120; // 横幅每帧
function shockRow(frame: number): string {
  const unit = SHOCK[Math.min(frame, SHOCK.length - 1)];
  const body = fixed(unit.repeat(Math.ceil(WIDTH / unit.length)), WIDTH);
  return `${frame >= 3 ? C.dim : ''}${C.gold}${body}${C.reset}`;
}

/**
 * 梭哈横幅。全宽三行砸进牌桌上方：反显闪两帧，边缘冲击波三帧扩散，
 * 之后常驻 —— 这一下是整局最重的动作，值得占三行。
 */
function allInBanner(fx: Fx, amount: number, at: number): string[] {
  const t = since(fx, at);
  const frame = t === Infinity ? 3 : Math.floor(t / BANNER_MS);
  const body = center(`▓▓ ⚡ 梭 哈 ${fmt(amount)} ⚡ ▓▓`, WIDTH);
  const mid = frame < 2 ? `${C.invert}${C.bold}${body}${C.reset}` : `${C.bold}${C.gold}${body}${C.reset}`;
  return [shockRow(frame), mid, shockRow(frame)];
}

const DUEL_MS = 100; // 滑入每帧
const DUEL_HOLD = 300; // 合拢后定帧多久才分出胜负
export const DUEL_TTL = 4200; // 对决行在牌桌上留多久

/**
 * 比牌对决行：两个名字从行两端滑向中央合拢，合拢那一帧整行反显，
 * 定帧之后胜者亮金、败者压暗并追加「✂ 出局」。
 */
function duelLine(fx: Fx, d: NonNullable<Fx['duel']>): string {
  const t = since(fx, d.at);
  const frame = t === Infinity ? 4 : Math.floor(t / DUEL_MS);
  const settled = t >= 4 * DUEL_MS + DUEL_HOLD;
  const flash = frame === 3 && !settled;

  const tag = (p: Duelist) => `${p.avatar} ${p.name}${settled && !p.won ? ' ✂ 出局' : ''}`;
  const L = tag(d.a);
  const R = tag(d.b);
  const wl = width(L);
  const wr = width(R);
  const lxF = Math.max(0, Math.floor((WIDTH - (wl + 3 + wr)) / 2));
  const cx = lxF + wl; // ⚔ 的位置固定在中央，只有名字在动
  const rxF = cx + 3;
  const k = Math.min(1, frame / 3);
  const lx = Math.round(lxF * k);
  const rx0 = Math.max(rxF, WIDTH - wr);
  const rx = Math.round(rx0 + (rxF - rx0) * k);

  const style = (p: Duelist, s: string) => {
    if (flash) return s;
    if (!settled) return `${C.bold}${C.white}${s}${C.reset}`;
    return p.won ? `${C.bold}${C.gold}${s}${C.reset}` : `${C.dim}${s}${C.reset}`;
  };
  const line =
    ' '.repeat(lx) +
    style(d.a, L) +
    ' '.repeat(Math.max(0, cx - lx - wl)) +
    (flash ? ' ⚔ ' : `${C.red} ⚔ ${C.reset}`) +
    ' '.repeat(Math.max(0, rx - cx - 3)) +
    style(d.b, R);
  return flash ? `${C.invert}${pad(line, WIDTH)}${C.reset}` : line;
}

/* ---------------------------------------------------------------- 主渲染 */

export interface RenderInput {
  room: PublicRoom;
  latency: number;
  status: string;
  origin: string;
  account?: AccountInfo | null;
  fx: Fx;
  /** 自动跟注（挂机）开着没有。开着的时候画面上必须一直看得见，别让人忘了 */
  auto?: boolean;
}

/** 渲染成一行一个元素的数组，交给 Screen 做按行 diff */
export function renderRoom(input: RenderInput): string[] {
  const { room, latency, status, origin, account, fx, auto = false } = input;
  const me = room.players.find((p) => p.id === room.viewerId);
  const L: string[] = [];
  const line = (s = '') => L.push(s);
  const rule = () => line(`${C.dim}${'─'.repeat(WIDTH)}${C.reset}`);

  const dealT = since(fx, fx.deal);
  const settleT = since(fx, fx.settle);
  const online = status === 'online';

  /* 顶栏：标题打字机 + 连接状态 + 净战绩 */
  const title = titleText(fx);
  // 重连成功那一下绿点多亮一帧，人才会注意到「回来了」
  const pop = online && since(fx, fx.online) < FRAME * 2;
  const net = online ? `${pop ? C.bold : ''}${C.green}●${C.reset} ${latency}ms` : `${C.red}●${C.reset} ${status}`;
  // 用牌桌上的实时数据算，账户快照只是入座那一刻的
  const lifetime = me ? me.chips - me.granted : account ? account.chips - account.granted : null;
  const acc =
    lifetime == null
      ? ''
      : `   ${lifetime >= 0 ? C.green : C.red}净战绩 ${lifetime >= 0 ? '+' : ''}${fmt(lifetime)}${C.reset}`;
  const head = title.done
    ? `${C.bold}${C.gold}${title.text}${C.reset}  房间 ${C.bold}${room.code}${C.reset}   ${net}${acc}`
    : `${C.bold}${C.gold}${title.text}${C.reset}`;
  // 断线时整行压暗，一眼看出「这画面是旧的」
  line(online ? head : dimLine(head));
  line(`${C.dim}邀请链接 ${origin}/?room=${room.code}${C.reset}`);
  line();

  const phase = room.phase === 'lobby' ? '准备中' : room.phase === 'playing' ? '进行中' : '本局结束';
  const meta =
    room.phase === 'playing'
      ? `底池 ${C.gold}${C.bold}${fmt(room.pot)}${C.reset} ${potFlame(room.pot, room.settings.ante)}` +
        `  底注 ${fmt(room.betUnit)}   第 ${room.handNo} 局 · 第 ${room.roundNo}/${room.settings.maxRounds} 轮`
      : `${room.players.length}/${room.settings.maxPlayers} 人   底注 ${fmt(room.settings.ante)}   ${room.settings.maxRounds} 轮封顶   行动限时 ${room.settings.turnSeconds}s`;
  line(`${C.bold}${phase}${C.reset}   ${meta}`);

  // 梭哈横幅落在牌桌正上方，压着整张桌子
  if (fx.allIn) for (const b of allInBanner(fx, fx.allIn.amount, fx.allIn.at)) line(b);

  rule();

  const seated = [...room.players].sort((a, b) => a.seat - b.seat);
  for (const [idx, p] of seated.entries()) {
    const dealt = dealT > 140 + idx * 130;
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
  if (fx.duel) {
    line(duelLine(fx, fx.duel));
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
      // 胜者压轴：其他人先翻，赢家最后一个亮相
      const ordered = [
        ...deltas.filter((d) => d.id !== room.result!.winnerId),
        ...deltas.filter((d) => d.id === room.result!.winnerId),
      ];
      ordered.forEach((d, i) => {
        const at = ROW_START + i * ROW_DELAY;
        if (!shownAt(settleT, at)) return;
        const isMe = d.id === room.viewerId;
        const won = d.id === room.result!.winnerId;
        const col = (n: number) => (n >= 0 ? C.green : C.red);
        const hand = room.result!.hands[d.id];
        const type = hand?.length === 3 ? ` ${C.gold}${evaluateHand(hand).name}${C.reset}` : '';
        // 赢家两侧 ✦/✧ 交替闪三轮，然后定在 ✦
        const rounds = Math.floor((settleT - at) / SPARK_MS);
        const spark = won ? (rounds >= 6 || !fx.anim ? ['✦', '✦'] : rounds % 2 === 0 ? ['✦', '✧'] : ['✧', '✦']) : ['', ''];
        const who = won ? `${spark[0]} ${d.avatar} ${d.name} ${spark[1]}` : `${d.avatar} ${d.name}`;
        line(
          `  ${isMe ? C.bold : ''}${won ? C.gold : ''}${pad(who, 16)}${C.reset}` +
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
    const myDealT = dealT - (140 + myIdx * 130);
    const revealed = me.hand.length === 3;
    const lookT = since(fx, fx.look);
    // 发牌没轮到自己时 slide 全是 -1，五行是空的 —— 布局高度不变，牌是「滑进来」的
    const slide = myDealT < 3 * DEAL_STEP + 2 * DEAL_MS ? dealSlides(myDealT) : undefined;
    const grow = revealed && lookT < LOOK_DONE ? lookStages(lookT) : undefined;
    for (const row of cardArt(revealed ? me.hand : [], { slide, grow })) line(`  ${row}`);
    if (myDealT < 0) {
      line(`  ${C.dim}发牌中…${C.reset}`);
    } else if (revealed) {
      if (lookT >= LOOK_DONE) {
        const e = evaluateHand(me.hand);
        const pct = Math.round(handPercentile(me.hand) * 100);
        // 牌型行淡入：先暗一帧再正常
        const fade = lookT < LOOK_DONE + FRAME ? C.dim : `${C.bold}${C.gold}`;
        // 金花及以上（category >= 4）值得两侧点两下星
        const strong = e.category >= 4 || e.special235;
        const sparkOn = lookT >= LOOK_DONE + 5 * FRAME || blink(fx, FRAME * 2);
        const mark = strong && sparkOn ? '✦' : strong ? ' ' : '';
        const name = strong ? `${mark} ${e.name} ${mark}` : e.name;
        line(`  ${fade}${name}${C.reset}   ${C.dim}牌力超过 ${pct}% 的随机牌${C.reset}`);
      } else {
        line();
      }
    } else {
      line(`  ${C.dim}按 ${C.gold}k${C.reset}${C.dim} 看牌（看牌后下注翻倍）${C.reset}`);
    }
    line();
  }

  const turnP = room.players.find((p) => p.seat === room.turnSeat);
  if (room.phase === 'playing' && turnP) {
    const left = room.turnDeadline ? Math.max(0, Math.round((room.turnDeadline - fx.now) / 1000)) : null;
    const hot = left != null && left <= HOT_SECONDS;
    // 最后 8 秒行首挂 ⚠ 按 1s 周期闪，进度条和「轮到你」一起变红
    const warn = hot ? (blink(fx, 500) ? `${C.red}⚠${C.reset} ` : '  ') : '';
    const bar = turnBar(left, room.settings.turnSeconds, hot);
    const mineTurn = turnP.id === room.viewerId;
    const label = mineTurn
      ? `${C.bold}${hot ? C.red : C.gold}▶ 轮到你${C.reset}`
      : `${C.dim}等待 ${turnP.name} 行动…${C.reset}`;
    // 挂机的时候在行动行尾挂一条 dim 的尾巴：牌自己在打，人得随时看得见是谁在动手
    const auton = auto ? `  ${C.dim}· 挂机中${C.reset}` : '';
    line(`${warn}${label}   ${left != null ? `${hot ? C.red : ''}还剩 ${left}s${C.reset} ` : ''}${bar}${auton}`);
    line();
  }

  // 牌局日志和聊天：命令行里这是唯一的「氛围」来源，别省
  const logs = room.log.slice(-7);
  const chats = room.chat.slice(-4);
  if (logs.length || chats.length) {
    line(`${C.dim}── 牌桌记录 ${'─'.repeat(WIDTH - 12)}${C.reset}`);
    for (const l of logs) line(`  ${C.dim}·${C.reset} ${l.text}`);
    for (const c of chats) line(`  ${C.blue}${c.avatar} ${c.name}${C.reset}：${c.text}`);
    line();
  }

  line(hintLine(room, auto));
  return L;
}

function hintLine(room: PublicRoom, auto: boolean): string {
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
  // 开着的时候不是一个普通提示了，是一个「你现在没在自己打牌」的状态灯，所以整条加粗点亮
  parts.push(auto ? `${C.bold}${C.gold}[g]● 自动跟注中${C.reset}` : k('g', '自动跟注'));
  parts.push(k('t', '聊天'), k('e', '表情'), k(':', '命令'), k('?', '帮助'));
  return parts.join('  ');
}
