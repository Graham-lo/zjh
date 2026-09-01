export type Suit = 'S' | 'H' | 'C' | 'D';
export type Phase = 'lobby' | 'playing' | 'round_end';
export type PlayerStatus = 'waiting' | 'active' | 'folded';

export interface Card { suit: Suit; rank: number }

export interface GameSettings {
  maxPlayers: number;
  startingChips: number;
  ante: number;
  betOptions: number[];
  special235: boolean;
}

export interface PlayerState {
  id: string;
  name: string;
  seat: number;
  chips: number;
  ready: boolean;
  status: PlayerStatus;
  looked: boolean;
  hand: Card[];
  isBot: boolean;
  tokenHash?: string;
  pendingLeave?: boolean;
  lastAction?: string;
}

export interface LogEntry { seq: number; at: number; text: string }
export interface RoundResult {
  winnerId: string;
  winnerName: string;
  potWon: number;
  reason: string;
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
  pot: number;
  betUnit: number;
  turnCount: number;
  compareUnlockAt: number;
  handNo: number;
  actionSeq: number;
  log: LogEntry[];
  result?: RoundResult;
}

export const DEFAULT_SETTINGS: GameSettings = {
  maxPlayers: 6,
  startingChips: 10_000,
  ante: 100,
  betOptions: [100, 200, 500, 1000, 2000],
  special235: true,
};

export class GameError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

const BOT_NAMES = ['阿凯', '老陈', '小北', 'Tony', '小林', 'Ace'];

export function randomId(prefix = 'p'): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function createInitialRoom(code: string, host: PlayerState): RoomState {
  return {
    id: randomId('room'), code, hostId: host.id, phase: 'lobby',
    settings: structuredClone(DEFAULT_SETTINGS), players: [host], dealerSeat: -1,
    turnSeat: null, pot: 0, betUnit: DEFAULT_SETTINGS.betOptions[0], turnCount: 0,
    compareUnlockAt: 2, handNo: 0, actionSeq: 0, log: [],
  };
}

export function createHumanPlayer(name: string, seat: number, tokenHash: string): PlayerState {
  return { id: randomId('p'), name: cleanName(name), seat, chips: DEFAULT_SETTINGS.startingChips,
    ready: false, status: 'waiting', looked: false, hand: [], isBot: false, tokenHash };
}

export function cleanName(name: string): string {
  const v = name.trim().replace(/\s+/g, ' ');
  if (!v || v.length > 12) throw new GameError('昵称需要 1–12 个字符');
  return v;
}

export function createDeck(): Card[] {
  const suits: Suit[] = ['S', 'H', 'C', 'D'];
  const deck: Card[] = [];
  for (const suit of suits) for (let rank = 2; rank <= 14; rank++) deck.push({ suit, rank });
  return deck;
}

function randomIndex(maxExclusive: number): number {
  const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
  const arr = new Uint32Array(1);
  do crypto.getRandomValues(arr); while (arr[0] >= limit);
  return arr[0] % maxExclusive;
}

export function shuffleDeck(deck: Card[]): Card[] {
  const a = deck.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1); [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export interface HandEval { category: number; name: string; tiebreak: number[]; special235: boolean }

function straightHigh(ranks: number[]): number | null {
  const u = [...new Set(ranks)].sort((a, b) => a - b);
  if (u.length !== 3) return null;
  if (u[0] === 2 && u[1] === 3 && u[2] === 14) return 3;
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
  if (flush && sh) return { category: 5, name: '同花顺', tiebreak: [sh], special235 };
  if (flush) return { category: 4, name: '同花', tiebreak: ranks, special235 };
  if (sh) return { category: 3, name: '顺子', tiebreak: [sh], special235 };
  if (entries[0][1] === 2) {
    const pair = entries[0][0]; const kicker = entries.find((e) => e[1] === 1)![0];
    return { category: 2, name: '对子', tiebreak: [pair, kicker], special235 };
  }
  return { category: 1, name: special235 ? '特殊235' : '单张', tiebreak: ranks, special235 };
}

function lexCompare(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return Math.sign(d);
  }
  return 0;
}

export function compareHands(a: Card[], b: Card[], special235 = true): number {
  const ea = evaluateHand(a), eb = evaluateHand(b);
  if (special235 && ea.special235 && eb.category === 6) return 1;
  if (special235 && eb.special235 && ea.category === 6) return -1;
  if (ea.category !== eb.category) return Math.sign(ea.category - eb.category);
  return lexCompare(ea.tiebreak, eb.tiebreak);
}

export function activePlayers(state: RoomState): PlayerState[] {
  return state.players.filter((p) => p.status === 'active');
}

function occupiedPlayers(state: RoomState): PlayerState[] {
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

function pushLog(state: RoomState, text: string) {
  state.actionSeq += 1;
  state.log.push({ seq: state.actionSeq, at: Date.now(), text });
  if (state.log.length > 60) state.log.splice(0, state.log.length - 60);
}

function playerById(state: RoomState, id: string): PlayerState {
  const p = state.players.find((x) => x.id === id);
  if (!p) throw new GameError('玩家不存在', 404);
  return p;
}

function currentPlayer(state: RoomState): PlayerState {
  const p = state.players.find((x) => x.seat === state.turnSeat && x.status === 'active');
  if (!p) throw new GameError('当前行动玩家状态异常');
  return p;
}

function requireHost(state: RoomState, actorId: string) {
  if (state.hostId !== actorId) throw new GameError('只有房主可以执行此操作', 403);
}

function transferHost(state: RoomState, departingId: string) {
  if (state.hostId !== departingId) return;
  const candidates = state.players.filter((p) => p.id !== departingId && !p.pendingLeave);
  state.hostId = (candidates.find((p) => !p.isBot) ?? candidates[0])?.id ?? '';
}

function requireTurn(state: RoomState, actorId: string): PlayerState {
  if (state.phase !== 'playing') throw new GameError('当前不在游戏中');
  const p = currentPlayer(state);
  if (p.id !== actorId) throw new GameError('还没轮到你');
  return p;
}

export function callCost(state: RoomState, player: PlayerState): number {
  return state.betUnit * (player.looked ? 2 : 1);
}

export function compareCost(state: RoomState, player: PlayerState): number {
  return callCost(state, player) * 2;
}

export function canCompareNow(state: RoomState): boolean {
  const active = activePlayers(state);
  return active.length === 2 || state.turnCount >= state.compareUnlockAt;
}

function pay(state: RoomState, p: PlayerState, amount: number) {
  if (amount <= 0 || p.chips < amount) throw new GameError('积分不足，当前只能弃牌');
  p.chips -= amount; state.pot += amount;
}

function finishRound(state: RoomState, winner: PlayerState, reason: string): boolean {
  const won = state.pot;
  winner.chips += won; state.pot = 0; state.turnSeat = null; state.phase = 'round_end';
  state.result = {
    winnerId: winner.id, winnerName: winner.name, potWon: won, reason,
    hands: Object.fromEntries(state.players.filter((p) => p.hand.length === 3).map((p) => [p.id, p.hand.map((c) => ({ ...c }))])),
  };
  for (const p of state.players) if (!p.isBot) p.ready = false;
  pushLog(state, `${winner.name} 赢得 ${won.toLocaleString()} 积分`);
  return true;
}

function maybeFinish(state: RoomState, reason = '其他玩家均已淘汰'): boolean {
  const active = activePlayers(state);
  return active.length === 1 ? finishRound(state, active[0], reason) : false;
}

function forceShowdown(state: RoomState, initiator: PlayerState, reason: string) {
  const active = activePlayers(state).sort((a, b) => {
    const da = (a.seat - initiator.seat + state.settings.maxPlayers) % state.settings.maxPlayers;
    const db = (b.seat - initiator.seat + state.settings.maxPlayers) % state.settings.maxPlayers;
    return da - db;
  });
  if (!active.length) throw new GameError('没有可参与开牌的玩家');

  // 依次强制比牌；完全同牌时，当前主动比牌者负，规则与普通比牌一致。
  let winner = active[0];
  for (const target of active.slice(1)) {
    if (compareHands(winner.hand, target.hand, state.settings.special235) <= 0) winner = target;
  }
  for (const p of active) {
    if (p.id !== winner.id) { p.status = 'folded'; p.lastAction = `封顶比牌负于 ${winner.name}`; }
  }
  finishRound(state, winner, reason);
}

function advanceTurn(state: RoomState, fromSeat: number) {
  if (maybeFinish(state)) return;
  const next = nextOccupiedSeat(state, fromSeat, true);
  if (next == null) throw new GameError('无法找到下一位玩家');
  state.turnSeat = next; state.turnCount += 1;
}

export function startRound(state: RoomState, actorId: string) {
  requireHost(state, actorId);
  if (state.phase !== 'lobby') throw new GameError('只有准备阶段可以开始');
  const players = occupiedPlayers(state);
  if (players.length < 2) throw new GameError('至少需要 2 名玩家');
  if (players.some((p) => !p.isBot && !p.ready)) throw new GameError('还有好友没有准备');
  if (players.some((p) => p.chips < state.settings.ante)) throw new GameError('有人积分不足，请先补充积分');

  const deck = shuffleDeck(createDeck()); let cursor = 0;
  state.handNo += 1; state.phase = 'playing'; state.pot = 0; state.betUnit = state.settings.betOptions[0];
  state.turnCount = 0; state.compareUnlockAt = Math.max(2, players.length); state.result = undefined;
  state.dealerSeat = nextOccupiedSeat(state, state.dealerSeat, false) ?? players[0].seat;
  for (const p of players) {
    p.status = 'active'; p.looked = false; p.hand = [deck[cursor++], deck[cursor++], deck[cursor++]];
    p.chips -= state.settings.ante; state.pot += state.settings.ante; p.lastAction = undefined;
  }
  state.turnSeat = nextOccupiedSeat(state, state.dealerSeat, true);
  pushLog(state, `第 ${state.handNo} 局开始，每人底注 ${state.settings.ante}`);
}

function doLook(state: RoomState, actorId: string) {
  const p = requireTurn(state, actorId);
  if (p.looked) throw new GameError('你已经看过牌');
  p.looked = true; p.lastAction = '看牌'; pushLog(state, `${p.name} 看牌`);
}

function doCall(state: RoomState, actorId: string) {
  const p = requireTurn(state, actorId); const cost = callCost(state, p); pay(state, p, cost);
  p.lastAction = `跟 ${cost}`; pushLog(state, `${p.name} 跟注 ${cost}`);
  if (p.chips === 0) { forceShowdown(state, p, '积分封顶，全员开牌'); return; }
  advanceTurn(state, p.seat);
}

function doRaise(state: RoomState, actorId: string, newUnit: number) {
  const p = requireTurn(state, actorId);
  if (!state.settings.betOptions.includes(newUnit) || newUnit <= state.betUnit) throw new GameError('加注档位无效');
  const cost = newUnit * (p.looked ? 2 : 1);
  if (p.chips <= cost) throw new GameError('积分不足以加注，请选择梭哈或弃牌');
  pay(state, p, cost); state.betUnit = newUnit;
  p.lastAction = `加到 ${newUnit}`; pushLog(state, `${p.name} 加注，盲注档位升至 ${newUnit}`); advanceTurn(state, p.seat);
}

function doAllIn(state: RoomState, actorId: string) {
  const p = requireTurn(state, actorId); const required = callCost(state, p);
  if (p.chips <= 0) throw new GameError('没有可梭哈的积分');
  if (p.chips > required) throw new GameError('只有积分不足或刚好跟完时才能梭哈');
  const amount = p.chips; p.chips = 0; state.pot += amount; p.lastAction = `梭哈 ${amount}`;
  pushLog(state, `${p.name} 梭哈 ${amount}，触发封顶全员开牌`);
  forceShowdown(state, p, '梭哈封顶，全员开牌');
}

function doFold(state: RoomState, actorId: string) {
  const p = requireTurn(state, actorId); p.status = 'folded'; p.lastAction = '弃牌'; pushLog(state, `${p.name} 弃牌`);
  if (!maybeFinish(state)) advanceTurn(state, p.seat);
}

function doCompare(state: RoomState, actorId: string, targetId: string) {
  const p = requireTurn(state, actorId);
  if (!canCompareNow(state)) throw new GameError(`至少完成一轮行动后才能比牌`);
  const target = playerById(state, targetId);
  if (target.id === p.id || target.status !== 'active') throw new GameError('比牌对象无效');
  const cost = compareCost(state, p); pay(state, p, cost);
  const result = compareHands(p.hand, target.hand, state.settings.special235);
  if (result > 0) { target.status = 'folded'; target.lastAction = `比牌负于 ${p.name}`; p.lastAction = `比牌胜 ${target.name}`; pushLog(state, `${p.name} 与 ${target.name} 比牌，${target.name} 淘汰`); }
  else { p.status = 'folded'; p.lastAction = `比牌负于 ${target.name}`; target.lastAction = `比牌胜 ${p.name}`; pushLog(state, `${p.name} 与 ${target.name} 比牌，${p.name} 淘汰`); }
  if (maybeFinish(state, '比牌决出胜负')) return;
  if (p.status === 'active' && p.chips === 0) { forceShowdown(state, p, '比牌后积分封顶，全员开牌'); return; }
  advanceTurn(state, p.seat);
}

export type GameCommand =
  | { type: 'ready'; ready: boolean }
  | { type: 'start' }
  | { type: 'look' }
  | { type: 'call' }
  | { type: 'all_in' }
  | { type: 'raise'; unit: number }
  | { type: 'fold' }
  | { type: 'compare'; targetId: string }
  | { type: 'add_bot' }
  | { type: 'remove_player'; targetId: string }
  | { type: 'reset_chips' }
  | { type: 'new_round' }
  | { type: 'leave' };

export function applyCommand(state: RoomState, actorId: string, command: GameCommand) {
  const actor = playerById(state, actorId);
  switch (command.type) {
    case 'ready':
      if (state.phase !== 'lobby') throw new GameError('只能在准备阶段切换准备状态');
      if (actor.isBot) throw new GameError('机器人无需准备'); actor.ready = command.ready;
      pushLog(state, `${actor.name}${command.ready ? ' 已准备' : ' 取消准备'}`); return;
    case 'start': startRound(state, actorId); return;
    case 'look': doLook(state, actorId); return;
    case 'call': doCall(state, actorId); return;
    case 'all_in': doAllIn(state, actorId); return;
    case 'raise': doRaise(state, actorId, command.unit); return;
    case 'fold': doFold(state, actorId); return;
    case 'compare': doCompare(state, actorId, command.targetId); return;
    case 'add_bot': {
      requireHost(state, actorId); if (state.phase !== 'lobby') throw new GameError('只能在准备阶段添加机器人');
      if (state.players.length >= state.settings.maxPlayers) throw new GameError('房间已满');
      const used = new Set(state.players.map((p) => p.seat)); let seat = 0; while (used.has(seat)) seat++;
      const name = BOT_NAMES.find((n) => !state.players.some((p) => p.name === n)) ?? `电脑${seat + 1}`;
      state.players.push({ id: randomId('bot'), name, seat, chips: state.settings.startingChips, ready: true,
        status: 'waiting', looked: false, hand: [], isBot: true });
      pushLog(state, `${name}（电脑）加入房间`); return;
    }
    case 'remove_player': {
      requireHost(state, actorId);
      if (command.targetId === actorId) throw new GameError('房主不能移除自己，请使用退出房间');
      const t = playerById(state, command.targetId);
      if (state.phase === 'playing') {
        if (t.isBot) throw new GameError('电脑玩家不会掉线');
        t.pendingLeave = true;
        if (t.status === 'active') {
          t.status = 'folded'; t.lastAction = '掉线代弃'; pushLog(state, `房主将掉线的 ${t.name} 代为弃牌`);
          if (!maybeFinish(state, '其他玩家均已淘汰') && state.turnSeat === t.seat) advanceTurn(state, t.seat);
        }
        return;
      }
      if (state.phase !== 'lobby') throw new GameError('请先返回准备阶段再移除玩家');
      state.players = state.players.filter((p) => p.id !== t.id); pushLog(state, `${t.name} 已离开房间`); return;
    }
    case 'reset_chips':
      if (state.phase === 'playing') throw new GameError('游戏进行中不能补充积分');
      actor.chips = state.settings.startingChips; pushLog(state, `${actor.name} 将积分补充到 ${actor.chips}`); return;
    case 'new_round': {
      requireHost(state, actorId); if (state.phase !== 'round_end') throw new GameError('本局尚未结束');
      state.players = state.players.filter((p) => !p.pendingLeave);
      for (const p of state.players) { p.status = 'waiting'; p.looked = false; p.hand = []; p.ready = p.isBot; p.lastAction = undefined; }
      state.phase = 'lobby'; state.result = undefined; state.turnSeat = null; state.pot = 0; state.betUnit = state.settings.betOptions[0];
      if (!state.players.some((p) => p.id === state.hostId) && state.players.length) {
        state.hostId = (state.players.find((p) => !p.isBot) ?? state.players[0]).id;
      }
      pushLog(state, '返回准备阶段'); return;
    }
    case 'leave': {
      transferHost(state, actor.id);
      if (state.phase === 'playing' && actor.status === 'active') {
        actor.pendingLeave = true; actor.status = 'folded'; pushLog(state, `${actor.name} 退出并弃牌`);
        if (!maybeFinish(state) && state.turnSeat === actor.seat) advanceTurn(state, actor.seat);
      } else {
        state.players = state.players.filter((p) => p.id !== actor.id); pushLog(state, `${actor.name} 离开房间`);
      }
      return;
    }
  }
}

function handStrength(hand: Card[]): number {
  const e = evaluateHand(hand);
  const top = Math.max(...hand.map((c) => c.rank));
  return Math.min(1, (e.category - 1) / 5 + top / 100);
}

function randomActiveOpponent(state: RoomState, bot: PlayerState): PlayerState | null {
  const targets = activePlayers(state).filter((p) => p.id !== bot.id);
  if (!targets.length) return null;
  return targets[Math.floor(Math.random() * targets.length)];
}

export function runBots(state: RoomState) {
  let guard = 0;
  while (state.phase === 'playing' && guard++ < 18) {
    const bot = state.players.find((p) => p.seat === state.turnSeat && p.status === 'active');
    if (!bot?.isBot) break;
    if (!bot.looked && (state.turnCount >= 1 || Math.random() < 0.65)) {
      bot.looked = true; bot.lastAction = '看牌'; pushLog(state, `${bot.name} 看牌`);
    }
    const seen = bot.looked; const strength = seen ? handStrength(bot.hand) : 0.45;
    const cost = callCost(state, bot); const pressure = cost / Math.max(1, bot.chips);
    const canCompare = canCompareNow(state) && activePlayers(state).length > 1;
    if (bot.chips <= cost) { doAllIn(state, bot.id); continue; }
    if (seen && strength < 0.22 && pressure > 0.04 && Math.random() < 0.75) {
      doFold(state, bot.id); continue;
    }
    if (canCompare && bot.chips >= compareCost(state, bot) && seen && strength > 0.68 && Math.random() < 0.16) {
      const target = randomActiveOpponent(state, bot); if (target) { doCompare(state, bot.id, target.id); continue; }
    }
    const idx = state.settings.betOptions.indexOf(state.betUnit);
    const next = idx >= 0 ? state.settings.betOptions[idx + 1] : undefined;
    if (next && bot.chips > next * (seen ? 2 : 1) && ((seen && strength > 0.62 && Math.random() < 0.38) || (!seen && Math.random() < 0.12))) {
      doRaise(state, bot.id, next); continue;
    }
    doCall(state, bot.id);
  }
}

export function sanitizeRoom(state: RoomState, viewerId: string) {
  const viewer = state.players.find((p) => p.id === viewerId);
  if (!viewer) throw new GameError('你已不在该房间', 403);
  return {
    ...state,
    players: state.players.map((p) => {
      const showHand = state.phase === 'round_end' || (p.id === viewerId && p.looked);
      const { tokenHash: _tokenHash, ...safe } = p;
      return { ...safe, hand: showHand ? p.hand : [] };
    }),
  };
}
