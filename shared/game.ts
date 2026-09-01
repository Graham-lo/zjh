/**
 * 炸金花游戏内核。
 *
 * 这个文件刻意保持与运行时无关：只用 Node / 浏览器 / Workers 都有的全局
 * (crypto.getRandomValues、structuredClone)，不 import 任何服务端模块。
 * 服务器把它当纯函数状态机用，测试直接跑它，客户端复用它的类型和赔率计算。
 */

export type Suit = 'S' | 'H' | 'C' | 'D';
export type Phase = 'lobby' | 'playing' | 'round_end';
export type PlayerStatus = 'waiting' | 'active' | 'folded';

export interface Card {
  suit: Suit;
  rank: number;
}

export interface GameSettings {
  maxPlayers: number;
  startingChips: number;
  ante: number;
  betOptions: number[];
  /** 不同花的 235 克豹子 */
  special235: boolean;
  /** 封顶轮数：到达后强制全员开牌。保证每一局一定会结束。 */
  maxRounds: number;
  /** 从第几轮开始每轮自动升一档底注，0 表示关闭 */
  escalateFrom: number;
  /** 单步行动时限（秒），超时自动弃牌 */
  turnSeconds: number;
  /** 本局结束后自动开下一局（所有在线玩家仍处于准备状态时） */
  autoContinue: boolean;
  /** 第几轮起才允许主动梭哈（跟不起时的被动梭哈不受此限） */
  allInFromRound: number;
}

export interface PlayerState {
  id: string;
  name: string;
  /** 头像 emoji，朋友局里用来一眼认人 */
  avatar: string;
  seat: number;
  chips: number;
  ready: boolean;
  status: PlayerStatus;
  looked: boolean;
  /**
   * 输赢已经在牌面上定过，结算时对全场公开。
   *
   * 和 `folded` 的区别是「怎么出局的」：主动弃牌的人是自己选择退出，牌不该被人看；
   * 被比牌比下去、被封顶/梭哈开牌比下去的人是被牌面淘汰的，那手牌已经摆上过桌面，
   * 全场有权知道谁是被什么牌打掉的。比牌的胜方同样置位 —— 只亮输家不亮赢家，
   * 别人只会看到有人被比掉却不知道被什么牌比掉，那是更难受的半截信息。
   */
  bared: boolean;
  hand: Card[];
  isBot: boolean;
  /** 跨房间跨会话的账户 id。换个房间还是同一个人，积分接着上次 */
  accountId?: string;
  /** 这一桌坐下以来的净变化，输赢一目了然 */
  net: number;
  /** 累计补分，从战绩里扣掉才是真实输赢 */
  granted: number;
  /** 由外部 AI（MCP 客户端）驱动的真人席位。牌桌上会明示，避免有人挂 AI 代打别人不知道 */
  isAgent?: boolean;
  online: boolean;
  /** 本局已投入，用于座位上的筹码显示 */
  bet: number;
  wins: number;
  tokenHash?: string;
  pendingLeave?: boolean;
  lastAction?: string;
  /** 最近一次表情，客户端用来播浮动动画 */
  emote?: { id: string; at: number };
}

export interface LogEntry {
  seq: number;
  at: number;
  text: string;
}

export interface ChatEntry {
  seq: number;
  at: number;
  playerId: string;
  name: string;
  avatar: string;
  text: string;
}

export interface RoundResult {
  winnerId: string;
  winnerName: string;
  potWon: number;
  reason: string;
  /** 本局每个人的净盈亏：赢家 = 底池 - 自己投入，其他人 = -自己投入 */
  deltas: { id: string; name: string; avatar: string; delta: number; bet: number; net: number }[];
  /** 输赢在牌面上定过的人都会亮牌（摊牌方、比牌双方）；只有主动弃牌的人不亮 */
  revealed: string[];
  hands: Record<string, Card[]>;
}

export interface RoomState {
  id: string;
  code: string;
  hostId: string;
  phase: Phase;
  settings: GameSettings;
  players: PlayerState[];
  dealerSeat: number;
  turnSeat: number | null;
  /** 当前行动的截止时间戳，客户端据此画倒计时环 */
  turnDeadline: number | null;
  pot: number;
  betUnit: number;
  turnCount: number;
  /** 当前是第几轮（从 1 开始） */
  roundNo: number;
  /** 本局第一个行动的座位，用来判断轮次是否走满一圈 */
  firstActorSeat: number;
  compareUnlockAt: number;
  handNo: number;
  actionSeq: number;
  log: LogEntry[];
  chat: ChatEntry[];
  createdAt: number;
  /**
   * 定向可见：seen[观看者id] = 他有权看到底牌的玩家 id 列表。
   * 比牌是两个人之间的事 —— 双方互相看到对方的牌，没参与的人什么都看不到，
   * 这和真实牌桌一致。全桌公开的摊牌走 result.revealed，两者互不干扰。
   */
  seen?: Record<string, string[]>;
  /** 有人梭哈后等待其他玩家表态；只有接受的人才会进入开牌 */
  allIn?: PendingAllIn;
  result?: RoundResult;
}

/** 一次梭哈的表态过程 */
export interface PendingAllIn {
  initiatorId: string;
  initiatorName: string;
  /** 每家要出的金额，等于发起时场上最短的一家 */
  amount: number;
  /** 还没表态的玩家 id，按行动顺序 */
  pending: string[];
  /** 已经接受（含发起人）的玩家 id */
  accepted: string[];
}

export const DEFAULT_SETTINGS: GameSettings = {
  maxPlayers: 6,
  startingChips: 50_000,
  ante: 100,
  // 第一个是开局的底注档，其余是可选的加注档
  betOptions: [100, 1000, 3000, 5000],
  special235: true,
  maxRounds: 8,
  escalateFrom: 3,
  turnSeconds: 30,
  autoContinue: true,
  allInFromRound: 3,
};

export const AVATARS = ['🐯', '🦊', '🐼', '🐵', '🐸', '🦁', '🐺', '🐷', '🐨', '🦉', '🐲', '🦄'];
export const EMOTES = ['👍', '😂', '😱', '🤔', '🔥', '💰', '🙏', '😭'];

const BOT_NAMES = ['阿凯', '老陈', '小北', '阿杰', '小林', '老王'];
const BOT_AVATARS = ['🤖', '👾', '🎩', '🕶️', '🎯', '🃏'];

export class GameError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/* ------------------------------------------------------------------ 随机 */

export function randomId(prefix = 'p'): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** 无模偏的 [0, maxExclusive) */
function randomIndex(maxExclusive: number): number {
  const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
  const arr = new Uint32Array(1);
  do crypto.getRandomValues(arr);
  while (arr[0] >= limit);
  return arr[0] % maxExclusive;
}

export function createDeck(): Card[] {
  const suits: Suit[] = ['S', 'H', 'C', 'D'];
  const deck: Card[] = [];
  for (const suit of suits) for (let rank = 2; rank <= 14; rank++) deck.push({ suit, rank });
  return deck;
}

export function shuffleDeck(deck: Card[]): Card[] {
  const a = deck.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ------------------------------------------------------------ 牌型与比较 */

export interface HandEval {
  category: number;
  name: string;
  tiebreak: number[];
  special235: boolean;
}

function straightHigh(ranks: number[]): number | null {
  const u = [...new Set(ranks)].sort((a, b) => a - b);
  if (u.length !== 3) return null;
  if (u[0] === 2 && u[1] === 3 && u[2] === 14) return 3; // A23 是最小顺子
  return u[1] === u[0] + 1 && u[2] === u[1] + 1 ? u[2] : null;
}

export function evaluateHand(cards: Card[]): HandEval {
  if (cards.length !== 3) throw new GameError('手牌必须是 3 张');
  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);
  const flush = cards.every((c) => c.suit === cards[0].suit);
  const sh = straightHigh(ranks);
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const special235 = [...ranks].sort((a, b) => a - b).join(',') === '2,3,5' && !flush;
  if (entries[0][1] === 3) return { category: 6, name: '豹子', tiebreak: [entries[0][0]], special235 };
  if (flush && sh) return { category: 5, name: '顺金', tiebreak: [sh], special235 };
  if (flush) return { category: 4, name: '金花', tiebreak: ranks, special235 };
  if (sh) return { category: 3, name: '顺子', tiebreak: [sh], special235 };
  if (entries[0][1] === 2) {
    const pair = entries[0][0];
    const kicker = entries.find((e) => e[1] === 1)![0];
    return { category: 2, name: '对子', tiebreak: [pair, kicker], special235 };
  }
  return { category: 1, name: special235 ? '特殊235' : '散牌', tiebreak: ranks, special235 };
}

function lexCompare(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

export function compareHands(a: Card[], b: Card[], special235 = true): number {
  const ea = evaluateHand(a);
  const eb = evaluateHand(b);
  if (special235 && ea.special235 && eb.category === 6) return 1;
  if (special235 && eb.special235 && ea.category === 6) return -1;
  if (ea.category !== eb.category) return Math.sign(ea.category - eb.category);
  return lexCompare(ea.tiebreak, eb.tiebreak);
}

/**
 * 估算一手牌能打败随机一手牌的比例（0–1）。
 *
 * 用 52 选 3 的真实牌型频率做分段，再按同类型内的大小在段内线性插值。
 * 机器人靠它算胜率，客户端靠它显示"牌力"。
 */
const CATEGORY_BANDS: Record<number, [number, number]> = {
  1: [0.0, 0.7439], // 单张
  2: [0.7439, 0.9133], // 对子
  3: [0.9133, 0.9459], // 顺子
  4: [0.9459, 0.9955], // 同花
  5: [0.9955, 0.9977], // 同花顺
  6: [0.9977, 1.0], // 豹子
};

export function handPercentile(hand: Card[]): number {
  const e = evaluateHand(hand);
  const [lo, hi] = CATEGORY_BANDS[e.category];
  // 段内位置：把 tiebreak 归一化到 0–1
  let pos: number;
  switch (e.category) {
    case 6:
    case 5:
    case 3:
      pos = (e.tiebreak[0] - 3) / 11;
      break;
    case 2:
      pos = (e.tiebreak[0] - 2) / 12 + (e.tiebreak[1] - 2) / 12 / 13;
      break;
    default:
      pos = (e.tiebreak[0] - 2) / 12 * 0.7 + (e.tiebreak[1] - 2) / 12 * 0.22 + (e.tiebreak[2] - 2) / 12 * 0.08;
  }
  pos = Math.min(1, Math.max(0, pos));
  return lo + (hi - lo) * pos;
}

/* --------------------------------------------------------------- 房间工具 */

export function cleanName(name: string): string {
  const v = (name ?? '').trim().replace(/\s+/g, ' ');
  if (!v || [...v].length > 10) throw new GameError('昵称需要 1–10 个字符');
  return v;
}

export function cleanAvatar(avatar: string): string {
  return AVATARS.includes(avatar) ? avatar : AVATARS[0];
}

export function createHumanPlayer(
  name: string,
  avatar: string,
  seat: number,
  tokenHash: string,
  isAgent = false,
): PlayerState {
  return {
    id: randomId('p'),
    name: cleanName(name),
    avatar: cleanAvatar(avatar),
    seat,
    chips: DEFAULT_SETTINGS.startingChips,
    ready: false,
    status: 'waiting',
    looked: false,
    bared: false,
    hand: [],
    isBot: false,
    net: 0,
    granted: 0,
    isAgent,
    online: true,
    bet: 0,
    wins: 0,
    tokenHash,
  };
}

export function createInitialRoom(code: string, host: PlayerState): RoomState {
  return {
    id: randomId('room'),
    code,
    hostId: host.id,
    phase: 'lobby',
    settings: structuredClone(DEFAULT_SETTINGS),
    players: [host],
    dealerSeat: -1,
    turnSeat: null,
    turnDeadline: null,
    pot: 0,
    betUnit: DEFAULT_SETTINGS.betOptions[0],
    turnCount: 0,
    roundNo: 0,
    firstActorSeat: 0,
    compareUnlockAt: 2,
    handNo: 0,
    actionSeq: 0,
    log: [],
    chat: [],
    createdAt: Date.now(),
  };
}

/**
 * 把旧快照补齐成当前版本的形状。
 *
 * 房间状态是整个 JSON 存盘的，所以一个上线后新增的字段（比如 allInFromRound）
 * 在老房间里就是 undefined —— 界面会显示「第 undefined 轮起」，
 * 而 `roundNo >= undefined` 恒为 false，那些房间里永远梭不了哈。
 * 每次从快照恢复都过一遍这里，以后再加设置项也不会重演。
 */
export function migrateRoom(state: RoomState): RoomState {
  state.settings = { ...DEFAULT_SETTINGS, ...(state.settings ?? {}) };
  state.log ??= [];
  state.chat ??= [];
  state.roundNo ??= 0;
  state.seen ??= {};
  state.firstActorSeat ??= 0;
  state.turnDeadline ??= null;
  state.actionSeq ??= 0;
  state.createdAt ??= Date.now();
  for (const p of state.players ?? []) {
    p.avatar ||= AVATARS[0];
    p.bet ??= 0;
    p.wins ??= 0;
    p.net ??= 0;
    p.granted ??= 0;
    p.bared ??= false;
    p.online ??= false;
  }
  return state;
}

/** 让 viewer 从此看得到 subject 的底牌（本局有效） */
function markSeen(state: RoomState, viewerId: string, subjectId: string) {
  state.seen ??= {};
  const list = (state.seen[viewerId] ??= []);
  if (!list.includes(subjectId)) list.push(subjectId);
}

export function activePlayers(state: RoomState): PlayerState[] {
  return state.players.filter((p) => p.status === 'active');
}

function seatedPlayers(state: RoomState): PlayerState[] {
  return state.players.filter((p) => !p.pendingLeave);
}

function nextOccupiedSeat(state: RoomState, fromSeat: number, onlyActive = false): number | null {
  const list = state.players.filter((p) => !p.pendingLeave && (!onlyActive || p.status === 'active'));
  if (!list.length) return null;
  for (let offset = 1; offset <= state.settings.maxPlayers; offset++) {
    const seat = (fromSeat + offset + state.settings.maxPlayers) % state.settings.maxPlayers;
    if (list.some((p) => p.seat === seat)) return seat;
  }
  return list[0].seat;
}

export function pushLog(state: RoomState, text: string) {
  state.actionSeq += 1;
  state.log.push({ seq: state.actionSeq, at: Date.now(), text });
  if (state.log.length > 80) state.log.splice(0, state.log.length - 80);
}

export function pushChat(state: RoomState, player: PlayerState, text: string) {
  const body = text.trim().slice(0, 80);
  if (!body) return;
  state.actionSeq += 1;
  state.chat.push({ seq: state.actionSeq, at: Date.now(), playerId: player.id, name: player.name, avatar: player.avatar, text: body });
  if (state.chat.length > 60) state.chat.splice(0, state.chat.length - 60);
}

export function playerById(state: RoomState, id: string): PlayerState {
  const p = state.players.find((x) => x.id === id);
  if (!p) throw new GameError('玩家不存在', 404);
  return p;
}

export function currentPlayer(state: RoomState): PlayerState | null {
  return state.players.find((x) => x.seat === state.turnSeat && x.status === 'active') ?? null;
}

function requireHost(state: RoomState, actorId: string) {
  if (state.hostId !== actorId) throw new GameError('只有房主可以执行此操作', 403);
}

/**
 * 房主离开或长时间掉线时移交房主。
 *
 * 只会交给真人：交给电脑玩家的话，一旦关掉自动续局，整桌就再也没人能开下一局了。
 * 没有真人可交时把房主置空，等下一个进来或重连的真人接手。
 */
export function transferHost(state: RoomState, departingId?: string) {
  if (departingId && state.hostId !== departingId) return;
  const humans = state.players.filter((p) => p.id !== departingId && !p.pendingLeave && !p.isBot);
  const next = humans.find((p) => p.online) ?? humans[0];
  if (next) {
    if (next.id === state.hostId) return;
    state.hostId = next.id;
    pushLog(state, `${next.name} 成为新房主`);
  } else {
    state.hostId = '';
  }
}

/** 房主空缺或落在电脑玩家身上时，让这个真人接手 */
export function claimHostIfVacant(state: RoomState, playerId: string): boolean {
  const current = state.players.find((p) => p.id === state.hostId);
  if (current && !current.isBot) return false;
  const player = state.players.find((p) => p.id === playerId);
  if (!player || player.isBot) return false;
  state.hostId = playerId;
  pushLog(state, `${player.name} 成为新房主`);
  return true;
}

function requireTurn(state: RoomState, actorId: string): PlayerState {
  if (state.phase !== 'playing') throw new GameError('当前不在游戏中');
  const p = currentPlayer(state);
  if (!p) throw new GameError('当前行动玩家状态异常');
  if (p.id !== actorId) throw new GameError('还没轮到你');
  return p;
}

// 下面三个是客户端也要用的赔率计算。参数写成最小结构，
// 这样服务端的 RoomState 和客户端拿到的 PublicRoom 可以共用同一份实现，
// 不会出现"按钮显示能跟、点下去服务端说钱不够"这种对不上的情况。
export function callCost(state: { betUnit: number }, player: { looked: boolean }): number {
  return state.betUnit * (player.looked ? 2 : 1);
}

export function compareCost(state: { betUnit: number }, player: { looked: boolean }): number {
  return callCost(state, player) * 2;
}

/**
 * 梭哈的金额：**场上还在局的人里积分最少的那一家**。
 *
 * 用最短的一家封顶，是为了让所有人都跟得起 —— 梭哈会把全部在局玩家按同一金额
 * 拉进底池然后开牌，如果金额高过某人的身家，那个人就成了被迫破产，不公平。
 */
export function allInCost(state: { players: { status: PlayerStatus; chips: number }[] }): number {
  const stacks = state.players.filter((p) => p.status === 'active').map((p) => p.chips);
  return stacks.length ? Math.max(0, Math.min(...stacks)) : 0;
}

/**
 * 梭哈什么时候可用。两个条件满足其一即可：
 *  1. 牌局已经打过设定的轮数（默认第 3 轮起），前面的下注博弈已经走完；
 *  2. 场上有人已经跟不起了 —— 这时候梭哈本来就是自然的收场方式，
 *     没必要逼那个人干等到第 3 轮。
 */
export function canAllInNow(state: {
  roundNo: number;
  betUnit: number;
  players: { status: PlayerStatus; chips: number; looked: boolean }[];
  settings: { allInFromRound: number };
}): boolean {
  if (state.roundNo >= (state.settings.allInFromRound ?? 3)) return true;
  return state.players.some(
    (p) => p.status === 'active' && p.chips <= state.betUnit * (p.looked ? 2 : 1),
  );
}

export function canCompareNow(state: {
  players: { status: PlayerStatus }[];
  turnCount: number;
  compareUnlockAt: number;
}): boolean {
  const active = state.players.filter((p) => p.status === 'active').length;
  return active === 2 || state.turnCount >= state.compareUnlockAt;
}

function pay(state: RoomState, p: PlayerState, amount: number) {
  if (amount <= 0 || p.chips < amount) throw new GameError('积分不足，当前只能弃牌或梭哈');
  p.chips -= amount;
  p.bet += amount;
  state.pot += amount;
}

function touchDeadline(state: RoomState) {
  state.turnDeadline = state.phase === 'playing' && state.turnSeat != null
    ? Date.now() + state.settings.turnSeconds * 1000
    : null;
}

/* ----------------------------------------------------------------- 结算 */

function finishRound(state: RoomState, winner: PlayerState, reason: string, revealed: PlayerState[]) {
  const won = state.pot;
  winner.chips += won;
  winner.wins += 1;
  // 先把每个人这一局的盈亏结出来：投入是 bet，赢家再把底池收回去
  const deltas = state.players
    .filter((p) => p.bet > 0)
    .map((p) => {
      const delta = (p.id === winner.id ? won : 0) - p.bet;
      p.net += delta;
      return { id: p.id, name: p.name, avatar: p.avatar, delta, bet: p.bet, net: p.net };
    })
    .sort((a, b) => b.delta - a.delta);
  state.pot = 0;
  state.turnSeat = null;
  state.turnDeadline = null;
  state.phase = 'round_end';
  // 摊牌名单 = 这一下终局摊出来的人 ∪ 本局所有「牌面上定过输赢」的人。
  // 后半截是关键：中途被比牌比下去的人已经是 folded，等牌局绕到别的路径结束时
  // 谁也不会再把他放进 revealed，他那手已经亮给对手看过的牌就永远消失了。
  const revealIds = [...new Set([...revealed, ...state.players.filter((p) => p.bared)].map((p) => p.id))];
  state.result = {
    winnerId: winner.id,
    winnerName: winner.name,
    potWon: won,
    reason,
    deltas,
    revealed: revealIds,
    hands: Object.fromEntries(
      state.players.filter((p) => revealIds.includes(p.id) && p.hand.length === 3).map((p) => [p.id, p.hand.map((c) => ({ ...c }))]),
    ),
  };
  pushLog(state, `${winner.name} 赢得 ${won.toLocaleString('zh-CN')} 积分`);
}

/**
 * 只剩一个人时收锅。
 *
 * 这里不额外指定摊牌名单 —— 大家都弃了、赢家不战而胜的局，赢家没有义务把牌给人看。
 * 如果这一锅是被一次比牌收掉的，比牌双方早已在 doCompare 里被标成 `bared`，
 * finishRound 会自己把他们并进摊牌名单，不需要在这里再传一次。
 */
function maybeFinish(state: RoomState, reason = '其他玩家均已弃牌'): boolean {
  const active = activePlayers(state);
  if (active.length !== 1) return false;
  finishRound(state, active[0], reason, []);
  return true;
}

/** 封顶/梭哈触发的全员开牌 */
function forceShowdown(state: RoomState, initiator: PlayerState, reason: string) {
  const active = activePlayers(state).sort((a, b) => {
    const M = state.settings.maxPlayers;
    return ((a.seat - initiator.seat + M) % M) - ((b.seat - initiator.seat + M) % M);
  });
  if (!active.length) throw new GameError('没有可参与开牌的玩家');
  // 依次强制比牌；完全同牌时后手胜，与普通比牌"主动方负"的口径一致。
  let winner = active[0];
  for (const target of active.slice(1)) {
    if (compareHands(winner.hand, target.hand, state.settings.special235) <= 0) winner = target;
  }
  for (const p of active) {
    // 开牌是把牌摆到桌面上定胜负，赢的输的都不是自己退出的，结算时一律公开
    p.bared = true;
    if (p.id !== winner.id) {
      p.status = 'folded';
      p.lastAction = `开牌负于 ${winner.name}`;
    }
  }
  finishRound(state, winner, reason, active);
}

function advanceTurn(state: RoomState, fromSeat: number) {
  if (maybeFinish(state)) return;
  const next = nextOccupiedSeat(state, fromSeat, true);
  if (next == null) throw new GameError('无法找到下一位玩家');

  const M = state.settings.maxPlayers;
  const dist = (s: number) => (s - state.firstActorSeat + M) % M;
  const wrapped = dist(next) <= dist(fromSeat);

  state.turnSeat = next;
  state.turnCount += 1;

  if (wrapped) {
    state.roundNo += 1;
    // 封顶轮数到了就强制开牌 —— 这是本局一定会结束的硬保证。
    if (state.roundNo > state.settings.maxRounds) {
      const anchor = currentPlayer(state) ?? activePlayers(state)[0];
      forceShowdown(state, anchor, `已打满 ${state.settings.maxRounds} 轮，封顶开牌`);
      return;
    }
    // 自动升档：让牌局有节奏地收紧，也避免小注互相跟到天亮。
    const { escalateFrom, betOptions } = state.settings;
    // 每两轮升一档：既保证牌局收敛，又不会一手就把人打穿
    if (escalateFrom > 0 && state.roundNo >= escalateFrom && (state.roundNo - escalateFrom) % 2 === 0) {
      const idx = betOptions.indexOf(state.betUnit);
      const raised = idx >= 0 ? betOptions[idx + 1] : undefined;
      if (raised) {
        state.betUnit = raised;
        pushLog(state, `第 ${state.roundNo} 轮，底注自动升至 ${raised}`);
      }
    }
  }
  touchDeadline(state);
}

/* --------------------------------------------------------------- 开局 */

export function startRound(state: RoomState, actorId: string | null) {
  // actorId 为 null 表示服务器自动开局（自动续局），跳过房主校验。
  if (actorId !== null) requireHost(state, actorId);
  if (state.phase !== 'lobby') throw new GameError('只有准备阶段可以开始');

  // 只有"已准备且在线"的真人和电脑玩家入局；掉线的人留座位、等下一局。
  const seated = seatedPlayers(state);
  const entrants = seated.filter((p) => p.isBot || (p.ready && p.online));
  if (entrants.length < 2) throw new GameError('至少需要 2 名已准备的玩家');

  // 交完底注后必须还剩得下钱，否则玩家会卡在"只能弃牌"的死角。
  for (const p of entrants) {
    if (p.chips <= state.settings.ante) {
      const add = state.settings.startingChips - p.chips;
      p.chips += add;
      p.granted += add;
      pushLog(state, `${p.name} 积分不足，自动补充 ${add.toLocaleString('zh-CN')}`);
    }
  }

  const deck = shuffleDeck(createDeck());
  let cursor = 0;
  state.handNo += 1;
  state.phase = 'playing';
  state.pot = 0;
  state.betUnit = state.settings.betOptions[0];
  state.turnCount = 0;
  state.roundNo = 1;
  state.compareUnlockAt = Math.max(2, entrants.length);
  state.result = undefined;
  state.allIn = undefined;
  state.seen = {};

  for (const p of seated) {
    p.looked = false;
    p.bared = false;
    p.bet = 0;
    p.hand = [];
    p.lastAction = undefined;
    p.status = 'waiting';
  }
  for (const p of entrants) {
    p.status = 'active';
    p.hand = [deck[cursor++], deck[cursor++], deck[cursor++]];
    p.chips -= state.settings.ante;
    p.bet = state.settings.ante;
    state.pot += state.settings.ante;
  }

  // 庄位和首家都只在本局入局的人里轮转
  state.dealerSeat = nextOccupiedSeat(state, state.dealerSeat, true) ?? entrants[0].seat;
  const first = nextOccupiedSeat(state, state.dealerSeat, true)!;
  state.turnSeat = first;
  state.firstActorSeat = first;
  touchDeadline(state);
  pushLog(state, `第 ${state.handNo} 局开始，${entrants.length} 人入局，每人底注 ${state.settings.ante}`);
}

/** 是否满足自动开下一局的条件 */
export function canAutoStart(state: RoomState): boolean {
  if (state.phase !== 'lobby' || !state.settings.autoContinue) return false;
  const seated = seatedPlayers(state);
  const humans = seated.filter((p) => !p.isBot);
  // 一个真人都不在就别让电脑自己打下去，白烧 CPU
  if (!humans.some((p) => p.online)) return false;
  if (humans.some((p) => p.online && !p.ready)) return false;
  return seated.filter((p) => p.isBot || (p.ready && p.online)).length >= 2;
}

/* --------------------------------------------------------------- 动作 */

function doLook(state: RoomState, actorId: string) {
  if (state.phase !== 'playing') throw new GameError('当前不在游戏中');
  const p = playerById(state, actorId);
  // 看牌不是一个"回合动作"：任何时候都能看自己的牌，代价是之后下注翻倍。
  if (p.status !== 'active') throw new GameError('你不在本局中');
  if (p.looked) throw new GameError('你已经看过牌');
  p.looked = true;
  p.lastAction = '看牌';
  pushLog(state, `${p.name} 看牌`);
}

function doCall(state: RoomState, actorId: string) {
  const p = requireTurn(state, actorId);
  if (state.allIn) {
    // 表态阶段：跟注就是「接梭哈」，金额是固定的那一份
    const amount = state.allIn.amount;
    pay(state, p, amount);
    p.lastAction = `接梭哈 ${amount}`;
    pushLog(state, `${p.name} 接下 ${state.allIn.initiatorName} 的梭哈`);
    state.allIn.accepted.push(p.id);
    state.allIn.pending = state.allIn.pending.filter((id) => id !== p.id);
    advanceAllIn(state);
    return;
  }
  const cost = callCost(state, p);
  pay(state, p, cost);
  p.lastAction = `跟 ${cost}`;
  pushLog(state, `${p.name} 跟注 ${cost}`);
  if (p.chips === 0) {
    forceShowdown(state, p, '积分打空，封顶开牌');
    return;
  }
  advanceTurn(state, p.seat);
}

function doRaise(state: RoomState, actorId: string, newUnit: number) {
  const p = requireTurn(state, actorId);
  if (state.allIn) throw new GameError('有人梭哈了，只能选择接或者弃牌');
  if (!state.settings.betOptions.includes(newUnit) || newUnit <= state.betUnit) throw new GameError('加注档位无效');
  const cost = newUnit * (p.looked ? 2 : 1);
  if (p.chips <= cost) throw new GameError('积分不足以加注，请选择梭哈或弃牌');
  pay(state, p, cost);
  state.betUnit = newUnit;
  p.lastAction = `加到 ${newUnit}`;
  pushLog(state, `${p.name} 加注，底注档位升至 ${newUnit}`);
  advanceTurn(state, p.seat);
}

function doAllIn(state: RoomState, actorId: string) {
  const p = requireTurn(state, actorId);
  if (state.allIn) throw new GameError('已经有人梭哈了');
  const active = activePlayers(state);
  if (active.length < 2) throw new GameError('没有可以开牌的对手');
  if (p.chips <= 0) throw new GameError('没有可梭哈的积分');

  // 跟不起的人任何时候都能梭哈脱身；主动梭哈则要等牌局打开几轮，
  // 否则一上来就有人掀桌，前两轮的下注博弈就没意义了。
  const forced = p.chips <= callCost(state, p);
  if (!forced && !canAllInNow(state)) {
    throw new GameError(`第 ${state.settings.allInFromRound} 轮起才能主动梭哈`);
  }

  const amount = allInCost(state);
  if (amount <= 0) throw new GameError('没有可梭哈的积分');

  // 发起人先把钱押上，然后按行动顺序问其他人接不接。
  // 金额取的是场上最短的一家，所以每个人都掏得起 —— 但掏不掏是他自己的选择。
  pay(state, p, amount);
  p.lastAction = `梭哈 ${amount}`;
  const M = state.settings.maxPlayers;
  const order = active
    .filter((q) => q.id !== p.id)
    .sort((a, b) => ((a.seat - p.seat + M) % M) - ((b.seat - p.seat + M) % M));
  state.allIn = {
    initiatorId: p.id,
    initiatorName: p.name,
    amount,
    pending: order.map((q) => q.id),
    accepted: [p.id],
  };
  pushLog(state, `${p.name} 梭哈 ${amount}，等其他人表态`);
  advanceAllIn(state);
}

/**
 * 推进梭哈表态：问下一个人，或者在所有人都表完态后收场。
 * 每个人只能接或弃，两种都是终态，所以这个过程一定会结束。
 */
function advanceAllIn(state: RoomState) {
  const pendingAllIn = state.allIn;
  if (!pendingAllIn) return;
  const stillIn = (id: string) => state.players.find((x) => x.id === id)?.status === 'active';
  pendingAllIn.pending = pendingAllIn.pending.filter(stillIn);
  pendingAllIn.accepted = pendingAllIn.accepted.filter(stillIn);

  if (pendingAllIn.pending.length) {
    const next = playerById(state, pendingAllIn.pending[0]);
    state.turnSeat = next.seat;
    touchDeadline(state);
    return;
  }

  const initiator = state.players.find((x) => x.id === pendingAllIn.initiatorId);
  state.allIn = undefined;
  if (!initiator) return;
  // 有人接就开牌比大小；一个都没人接，发起人直接收锅且不亮牌
  if (pendingAllIn.accepted.length >= 2) {
    forceShowdown(state, initiator, '梭哈开牌');
  } else {
    finishRound(state, initiator, '无人接梭哈', []);
  }
}

/**
 * 弃牌。
 *
 * 和看牌一样不占用行动权：牌太烂想马上退出，不必等轮到自己 ——
 * 干等着还得盯着别人慢慢想，是最没必要的一种等待。
 * 只有当弃牌的正好是当前行动者时，才需要把行动权交出去。
 */
function doFold(state: RoomState, actorId: string, note = '弃牌') {
  if (state.phase !== 'playing') throw new GameError('当前不在游戏中');
  const p = playerById(state, actorId);
  if (p.status !== 'active') throw new GameError('你不在本局中');
  const wasTurn = state.turnSeat === p.seat;
  p.status = 'folded';
  p.lastAction = state.allIn && p.id !== state.allIn.initiatorId ? '不接梭哈' : note;
  pushLog(state, `${p.name} ${p.lastAction}`);
  if (maybeFinish(state)) {
    state.allIn = undefined;
    return;
  }
  if (state.allIn) {
    advanceAllIn(state);
    return;
  }
  if (wasTurn) advanceTurn(state, p.seat);
}

function doCompare(state: RoomState, actorId: string, targetId: string) {
  const p = requireTurn(state, actorId);
  if (state.allIn) throw new GameError('有人梭哈了，只能选择接或者弃牌');
  if (!canCompareNow(state)) throw new GameError('至少完成一轮行动后才能比牌');
  const target = playerById(state, targetId);
  if (target.id === p.id || target.status !== 'active') throw new GameError('比牌对象无效');
  const cost = compareCost(state, p);
  pay(state, p, cost);
  // 比牌 = 两个人把牌亮给对方看。双方互相可见，其他人看不到。
  markSeen(state, p.id, target.id);
  markSeen(state, target.id, p.id);
  const result = compareHands(p.hand, target.hand, state.settings.special235);
  const loser = result > 0 ? target : p;
  const winner = result > 0 ? p : target;
  loser.status = 'folded';
  loser.lastAction = `比牌负于 ${winner.name}`;
  winner.lastAction = `比牌胜 ${loser.name}`;
  // 比过牌的两个人都是「牌面上定过输赢」的，本局无论最后怎么结束都要摊给全场。
  // 局还没结束的中途，双方的牌仍然只有当事人互相看得到（走 seen），
  // 旁观者要等到结算才看得见 —— 那才是真实牌桌上的规矩。
  winner.bared = true;
  loser.bared = true;
  pushLog(state, `${p.name} 与 ${target.name} 比牌，${loser.name} 出局`);
  if (maybeFinish(state, '比牌决出胜负')) return;
  if (p.status === 'active' && p.chips === 0) {
    forceShowdown(state, p, '比牌后积分打空，封顶开牌');
    return;
  }
  advanceTurn(state, p.seat);
}

export type GameCommand =
  | { type: 'ready'; ready: boolean }
  | { type: 'rename'; name: string; avatar: string }
  | { type: 'start' }
  | { type: 'look' }
  | { type: 'call' }
  | { type: 'all_in' }
  | { type: 'raise'; unit: number }
  | { type: 'fold' }
  | { type: 'compare'; targetId: string }
  | { type: 'add_bot' }
  | { type: 'remove_player'; targetId: string }
  | { type: 'top_up' }
  | { type: 'new_round' }
  | { type: 'settings'; turnSeconds?: number; allInFromRound?: number; maxRounds?: number; autoContinue?: boolean }
  | { type: 'chat'; text: string }
  | { type: 'emote'; id: string }
  | { type: 'leave' };

export const COMMAND_TYPES = new Set<GameCommand['type']>([
  'ready', 'rename', 'start', 'look', 'call', 'all_in', 'raise', 'fold', 'compare',
  'add_bot', 'remove_player', 'top_up', 'new_round', 'chat', 'emote', 'leave', 'settings',
]);

export function applyCommand(state: RoomState, actorId: string, command: GameCommand): void {
  const actor = playerById(state, actorId);
  switch (command.type) {
    case 'ready': {
      if (state.phase !== 'lobby') throw new GameError('只能在准备阶段切换准备状态');
      if (actor.isBot) throw new GameError('机器人无需准备');
      actor.ready = command.ready;
      pushLog(state, `${actor.name}${command.ready ? ' 已准备' : ' 取消准备'}`);
      return;
    }
    case 'rename': {
      if (state.phase === 'playing') throw new GameError('牌局进行中不能改名');
      const name = cleanName(command.name);
      if (state.players.some((p) => p.id !== actor.id && p.name === name)) throw new GameError('这个昵称已经有人用了');
      const before = actor.name;
      actor.name = name;
      actor.avatar = cleanAvatar(command.avatar);
      if (before !== name) pushLog(state, `${before} 改名为 ${name}`);
      return;
    }
    case 'start': return startRound(state, actorId);
    case 'look': return doLook(state, actorId);
    case 'call': return doCall(state, actorId);
    case 'all_in': return doAllIn(state, actorId);
    case 'raise': return doRaise(state, actorId, command.unit);
    case 'fold': return doFold(state, actorId);
    case 'compare': return doCompare(state, actorId, command.targetId);
    case 'settings': {
      requireHost(state, actorId);
      if (state.phase === 'playing') throw new GameError('牌局进行中不能改房规');
      const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));
      const changed: string[] = [];
      // AI 玩家一轮要想好几秒，行动时限得能调大
      if (typeof command.turnSeconds === 'number') {
        state.settings.turnSeconds = clamp(command.turnSeconds, 10, 180);
        changed.push(`行动时限 ${state.settings.turnSeconds} 秒`);
      }
      if (typeof command.allInFromRound === 'number') {
        state.settings.allInFromRound = clamp(command.allInFromRound, 1, 8);
        changed.push(`第 ${state.settings.allInFromRound} 轮起可梭哈`);
      }
      if (typeof command.maxRounds === 'number') {
        state.settings.maxRounds = clamp(command.maxRounds, 2, 20);
        changed.push(`${state.settings.maxRounds} 轮封顶`);
      }
      if (typeof command.autoContinue === 'boolean') {
        state.settings.autoContinue = command.autoContinue;
        changed.push(command.autoContinue ? '自动续局开' : '自动续局关');
      }
      if (changed.length) pushLog(state, `房规调整：${changed.join('、')}`);
      return;
    }
    case 'chat': {
      pushChat(state, actor, command.text);
      return;
    }
    case 'emote': {
      if (!EMOTES.includes(command.id)) throw new GameError('无效的表情');
      actor.emote = { id: command.id, at: Date.now() };
      return;
    }
    case 'add_bot': {
      requireHost(state, actorId);
      if (state.phase !== 'lobby') throw new GameError('只能在准备阶段添加电脑玩家');
      if (state.players.length >= state.settings.maxPlayers) throw new GameError('房间已满');
      const used = new Set(state.players.map((p) => p.seat));
      let seat = 0;
      while (used.has(seat)) seat++;
      const idx = BOT_NAMES.findIndex((n) => !state.players.some((p) => p.name === n));
      const name = idx >= 0 ? BOT_NAMES[idx] : `电脑${seat + 1}`;
      state.players.push({
        id: randomId('bot'), name, avatar: BOT_AVATARS[idx >= 0 ? idx : 0], seat,
        chips: state.settings.startingChips, ready: true, status: 'waiting', looked: false, bared: false,
        hand: [], isBot: true, online: true, bet: 0, wins: 0, net: 0, granted: 0,
      });
      pushLog(state, `${name}（电脑）加入房间`);
      return;
    }
    case 'remove_player': {
      requireHost(state, actorId);
      if (command.targetId === actorId) throw new GameError('房主不能移除自己，请使用退出房间');
      const t = playerById(state, command.targetId);
      if (state.phase === 'playing') {
        if (t.isBot) throw new GameError('电脑玩家不会掉线');
        t.pendingLeave = true;
        if (t.status === 'active') {
          const wasTurn = state.turnSeat === t.seat;
          t.status = 'folded';
          t.lastAction = '掉线代弃';
          pushLog(state, `房主替掉线的 ${t.name} 弃牌`);
          if (!maybeFinish(state) && wasTurn) advanceTurn(state, t.seat);
        }
        return;
      }
      state.players = state.players.filter((p) => p.id !== t.id);
      pushLog(state, `${t.name} 已离开房间`);
      return;
    }
    case 'top_up': {
      if (state.phase === 'playing' && actor.status === 'active') throw new GameError('本局进行中不能补充积分');
      const add = Math.max(0, state.settings.startingChips - actor.chips);
      actor.chips += add;
      actor.granted += add;
      pushLog(state, `${actor.name} 补充了 ${add.toLocaleString('zh-CN')} 积分`);
      return;
    }
    case 'new_round': {
      requireHost(state, actorId);
      if (state.phase !== 'round_end') throw new GameError('本局尚未结束');
      resetToLobby(state);
      return;
    }
    case 'leave': {
      transferHost(state, actor.id);
      if (state.phase === 'playing' && actor.status === 'active') {
        actor.pendingLeave = true;
        const wasTurn = state.turnSeat === actor.seat;
        actor.status = 'folded';
        pushLog(state, `${actor.name} 退出并弃牌`);
        if (!maybeFinish(state) && wasTurn) advanceTurn(state, actor.seat);
      } else {
        state.players = state.players.filter((p) => p.id !== actor.id);
        pushLog(state, `${actor.name} 离开房间`);
      }
      return;
    }
    default: {
      const never: never = command;
      throw new GameError(`未知操作 ${JSON.stringify(never)}`);
    }
  }
}

export function resetToLobby(state: RoomState) {
  state.players = state.players.filter((p) => !p.pendingLeave);
  for (const p of state.players) {
    // 打空的人直接补满：这是纯娱乐积分，没必要让谁干坐着
    if (p.chips <= state.settings.ante) {
      const add = state.settings.startingChips - p.chips;
      p.chips += add;
      p.granted += add;
      pushLog(state, `${p.name} 积分不足，自动补充 ${add.toLocaleString('zh-CN')}`);
    }
    p.status = 'waiting';
    p.looked = false;
    p.bared = false;
    p.hand = [];
    p.bet = 0;
    p.ready = p.isBot ? true : p.ready;
    p.lastAction = undefined;
  }
  state.phase = 'lobby';
  state.result = undefined;
  state.allIn = undefined;
  state.seen = {};
  state.turnSeat = null;
  state.turnDeadline = null;
  state.pot = 0;
  state.roundNo = 0;
  state.betUnit = state.settings.betOptions[0];
  if (!state.players.some((p) => p.id === state.hostId)) transferHost(state);
  pushLog(state, '返回准备阶段');
}

/** 超时自动弃牌。回合玩家不在时静默返回，交给调用方重算定时器。 */
export function timeoutCurrentPlayer(state: RoomState): boolean {
  if (state.phase !== 'playing') return false;
  const p = currentPlayer(state);
  if (!p) return false;
  doFold(state, p.id, '超时自动弃牌');
  return true;
}

/* ------------------------------------------------------------- 机器人 AI */

/**
 * 给一个机器人算出下一步。纯函数，不改状态 —— 服务器拿到结果后带延迟执行，
 * 这样电脑玩家看起来像在思考，而不是在人类点完的瞬间全部行动完毕。
 */
export function botDecision(state: RoomState, bot: PlayerState): GameCommand {
  const active = activePlayers(state);
  const opponents = Math.max(1, active.length - 1);

  // 有人梭哈时只有两条路：接或者弃。先看牌，再按赔率决定。
  if (state.allIn) {
    if (!bot.looked) return { type: 'look' };
    const price = state.allIn.amount;
    if (bot.chips < price) return { type: 'fold' };
    const chance = Math.pow(handPercentile(bot.hand), Math.max(1, state.allIn.accepted.length));
    return chance > price / (state.pot + price) * 0.9 ? { type: 'call' } : { type: 'fold' };
  }

  // 先决定要不要看牌：闷牌便宜，但第二轮开始必须看。
  if (!bot.looked && (state.roundNo >= 2 || Math.random() < 0.55)) return { type: 'look' };

  const cost = callCost(state, bot);
  // 没看牌时按平均牌力估；看了牌就用真实分位。
  const pct = bot.looked ? handPercentile(bot.hand) : 0.5;
  // 赢下所有对手的粗略概率
  const equity = Math.pow(pct, opponents);
  const potOdds = cost / (state.pot + cost);
  // 每个机器人每局有一点固定的"性格"，同一局里表现一致
  const mood = pseudoRandom(`${bot.id}:${state.handNo}`);
  const bluff = (mood - 0.5) * 0.12;

  if (bot.chips <= cost) {
    // 跟不起了：牌好就梭（被动梭哈不受轮次限制），牌烂就弃。
    return equity + bluff > 0.28 ? { type: 'all_in' } : { type: 'fold' };
  }

  // 亏赔率太多就弃牌。闷牌阶段成本低，容忍度高一些。
  const foldLine = bot.looked ? potOdds * 0.75 : potOdds * 0.35;
  if (equity + bluff < foldLine && Math.random() < 0.85) return { type: 'fold' };

  // 抓到大牌时偶尔直接梭哈，把所有人拖下水
  if (canAllInNow(state) && bot.looked && equity > 0.9 && Math.random() < 0.25) {
    return { type: 'all_in' };
  }

  // 牌很好且开放比牌时，主动开火。
  if (
    canCompareNow(state) && active.length > 1 && bot.looked &&
    bot.chips > compareCost(state, bot) && equity > 0.72 && Math.random() < 0.4
  ) {
    const targets = active.filter((p) => p.id !== bot.id);
    if (targets.length) {
      const target = targets[Math.floor(Math.random() * targets.length)];
      return { type: 'compare', targetId: target.id };
    }
  }

  // 加注：牌好时价值加注，偶尔闷牌诈一手。
  const idx = state.settings.betOptions.indexOf(state.betUnit);
  const nextUnit = idx >= 0 ? state.settings.betOptions[idx + 1] : undefined;
  if (nextUnit && bot.chips > nextUnit * (bot.looked ? 2 : 1) * 1.5) {
    const wantValue = bot.looked && equity > 0.62 && Math.random() < 0.45;
    const wantBluff = !bot.looked && Math.random() < 0.1;
    if (wantValue || wantBluff) return { type: 'raise', unit: nextUnit };
  }

  return { type: 'call' };
}

/** 小的确定性哈希 → [0,1)，用来给机器人一个稳定的"手气性格" */
function pseudoRandom(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/* --------------------------------------------------------------- 视图 */

export type PublicPlayer = Omit<PlayerState, 'tokenHash' | 'hand'> & { hand: Card[]; hasHand: boolean };
export type PublicRoom = Omit<RoomState, 'players'> & { players: PublicPlayer[]; viewerId: string };

/** 生成给某个玩家看的房间视图：别人的暗牌永远不出现在响应里。 */
export function sanitizeRoom(state: RoomState, viewerId: string): PublicRoom {
  const publicIds = new Set(state.result?.revealed ?? []);
  // 只有这个观看者有权看到的人（比牌对手），别人拿不到
  const privateIds = new Set(state.seen?.[viewerId] ?? []);
  const visible = (id: string) => publicIds.has(id) || privateIds.has(id);

  // 结算面板同样按观看者裁剪：比牌双方能看到彼此，旁观者只看到公开摊牌的部分
  let result = state.result;
  if (result) {
    const shown = state.players.filter((p) => p.hand.length === 3 && visible(p.id)).map((p) => p.id);
    result = {
      ...result,
      revealed: shown,
      hands: Object.fromEntries(
        state.players.filter((p) => shown.includes(p.id)).map((p) => [p.id, p.hand.map((c) => ({ ...c }))]),
      ),
    };
  }

  // seen 是服务端的记账，没必要下发（它能透露谁和谁比过牌）
  const { seen: _seen, ...rest } = state;
  return {
    ...rest,
    result,
    viewerId,
    players: state.players.map((p) => {
      const { tokenHash: _t, hand, ...safe } = p;
      // 自己的牌：看过了当然能看；被比掉出局的人也能看 —— 真实牌桌上比牌那一下
      // 你本来就会把牌翻开，没道理闷着被比掉之后连自己那手是什么都不知道。
      //
      // 但**还在局里**的人即使比赢过也不给看：闷牌的代价就是看不见，换来的是半价下注。
      // 比赢了就白拿一手信息、还继续按半价跟，等于绕开了看牌翻倍那道门槛。
      // 这只放开「自己看自己」；旁观者仍然只走 publicIds/privateIds，中途不会提前泄露。
      const beatenOut = p.bared && p.status === 'folded';
      const show = (p.id === viewerId && (p.looked || beatenOut)) || visible(p.id);
      return { ...safe, hand: show ? hand.map((c) => ({ ...c })) : [], hasHand: hand.length === 3 };
    }),
  };
}
