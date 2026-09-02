/**
 * 升级（两副牌 · 四人）的房间状态机。
 *
 * 和炸金花内核同样的约定：纯函数、与运行时无关、状态是唯一真相、事件只驱动表演。
 * 服务端把它当状态机用，测试直接跑它，客户端复用它的类型与 sanitize 出来的视图。
 * 通用的玩家字段、GameError、id/昵称清洗直接从 shared/game.ts 复用，不另起一套。
 *
 * 规范出处：docs/shengji/DESIGN.md 第 1.3–1.9 节（规则）与第 2.3 / 2.4 节（协议与状态）。
 */

import {
  AVATARS, EMOTES, GameError, cleanAvatar, cleanName, createHumanPlayer, randomId,
  type LogEntry, type PlayerState,
} from '../game.ts';
import { SJ_VARIANTS, type SjKind, ladderOf } from '../games.ts';
import {
  RANK_BIG_JOKER, cardFromId, cardsLabel, createSjDeck, groupOf, levelLabel, pointCards, shuffleSj,
  sortSjHand, sumPoints, trumpLabel,
  type SjCard, type SjCtx, type SjGroup, type SjRng, type SjTrumpSuit,
} from './cards.ts';
import { cardsInGroup, parseShape, type SjShape } from './units.ts';
import {
  SJ_DECL_TIER, checkOverride, declStrength, digMultiplierForLead, isMatchWon, isTrumping, levelUp,
  nextDealerSeat, outcomeFor, shapeLabel, trickPoints, trickWinner, validateFollow, validateLead,
  validateThrow,
  type SjOutcome,
} from './rules.ts';
import { botKou, botPlay } from './bot.ts';

/* ------------------------------------------------------------------ 类型 */

export type SjPhase =
  | 'lobby' | 'dealing' | 'declaring' | 'kou' | 'chao' | 'playing' | 'hand_end' | 'match_end';

/** 从炸金花的 PlayerState 里挑出与玩法无关的通用字段，两个游戏共用同一套语义 */
type SjPlayerBase = Pick<
  PlayerState,
  'id' | 'name' | 'avatar' | 'seat' | 'ready' | 'online' | 'isBot' | 'isAgent'
  | 'accountId' | 'tokenHash' | 'pendingLeave' | 'emote' | 'lastAction'
>;

export interface SjPlayer extends SjPlayerBase {
  hand: SjCard[];
  /** 亮在座位前的明牌 id。亮主的牌明牌放到扣底结束（DESIGN 1.4），之后收回暗牌 */
  declaredIds: string[];
}

export interface SjSettings {
  /** 单步出牌时限（秒） */
  turnSeconds: number;
  /** 扣底时限（秒） */
  kouSeconds: number;
  /** 每个人回答「抄不抄底」的时限（秒）。问三家一轮，所以给得比扣底短得多 */
  chaoSeconds: number;
  autoContinue: boolean;
}

export interface SjTrumpState {
  suit: SjTrumpSuit | null;
  /** 本局级牌点数 = 庄家所在队的级别（DESIGN 1.2） */
  level: number;
  declarerId: string | null;
  /**
   * 反主级别，七档（DESIGN 1.4）：0 翻底定主 / 1 单张级牌（任意花色，彼此相等）/
   * 2–5 一对级牌（♦♣♥♠ 依次变强）/ 6 一对小王 / 7 一对大王。
   * 档位表在 `rules.ts` 的 `SJ_DECL_TIER`，这里不重复魔法数字。
   */
  strength: number;
  /** 亮出的牌 id，只在扣底结束前有值 */
  cardIds: string[];
}

export interface SjTrickPlay {
  seat: number;
  cardIds: string[];
}

export interface SjTrickRecord {
  trickNo: number;
  leaderSeat: number;
  plays: SjTrickPlay[];
  winnerSeat: number;
  points: number;
}

export interface SjThrowFailRecord {
  playerId: string;
  forcedIds: string[];
  /** 归给闲家的分（庄家阵营甩砸 → +10，闲家甩砸 → −10） */
  penalty: number;
}

export interface SjHandResult {
  handNo: number;
  dealerSeat: number;
  defenderPoints: number;
  /** 两队从圈里赢到的**原始**分，不含罚分与抠底。守恒校验用它 */
  trickPoints: [number, number];
  bottomPoints: number;
  penaltyPoints: number;
  dig?: { base: number; multiplier: number; total: number };
  outcome: SjOutcome;
  nextDealerSeat: number;
  levelsAfter: [number, number];
  /** 局末公开的底牌 */
  bottom: SjCard[];
}

export interface SjRoomState {
  kind: SjKind;
  id: string;
  code: string;
  hostId: string;
  createdAt: number;
  log: LogEntry[];
  actionSeq: number;
  settings: SjSettings;
  players: SjPlayer[];
  phase: SjPhase;
  /** 两队级别（阶梯里的点数），team = seat % 2 */
  levels: [number, number];
  handNo: number;
  dealerSeat: number;
  trump: SjTrumpState;
  /** 本局点过「不亮」的人 */
  passed: string[];
  dealStartedAt: number | null;
  declareEndsAt: number | null;
  turnDeadline: number | null;
  /**
   * 当前该扣底的人（DESIGN 1.4b）。进 `kou` 时设置：庄家，或者刚抄成底的那个人。
   * 抄底之后扣底的**不一定是庄家**，所以扣底的一切判断都看它，不看 `dealerSeat`。
   */
  kouSeat: number;
  /** 抄底询问里当前被问到的座位；不在 `chao` 阶段就是 null */
  chaoSeat: number | null;
  /** 这一轮询问里有人抄成过。决定问完一圈之后是再开一轮还是开打（DESIGN 1.4b） */
  chaoDirty: boolean;
  /** 底牌。扣底期间在扣底者手里（这里为空），扣完是他扣下的 8 张 */
  bottom: SjCard[];
  bottomRevealed: boolean;
  /**
   * 翻底定主翻出来的那张牌（DESIGN 1.4）。全场可见过，所以是公开信息；
   * 扣底结束就清掉，免得它继续指向庄家手里的一张牌。
   */
  flipped: SjCard | null;
  trickNo: number;
  leaderSeat: number;
  turnSeat: number | null;
  trick: SjTrickPlay[];
  lastTrick: SjTrickRecord | null;
  /** 闲家得分（含罚分与抠底），也就是升级表的输入 */
  defenderPoints: number;
  /** 两队从圈里赢到的原始分，`trickPoints[0] + trickPoints[1] + 底牌分 = 200` 恒成立 */
  handTrickPoints: [number, number];
  /** 甩牌罚分累计（正数=判给闲家） */
  penaltyPoints: number;
  capturedPointCards: SjCard[];
  /** 本局已经打出的所有牌 id，按顺序。公开信息，机器人和「记牌」都靠它 */
  playedIds: string[];
  /**
   * 公开确认的缺门，按座位保存。只有某人跟牌时实际打出了别组牌才记入，
   * 不会根据服务端暗牌偷推；客户端、真人和电脑看到的是同一份记牌信息。
   */
  voidGroups: SjGroup[][];
  /** 最近一次甩牌失败，客户端拿它播红戳记；下一次出牌清空 */
  lastThrowFail: SjThrowFailRecord | null;
  result?: SjHandResult;
  matchWinner?: 0 | 1;
}

export interface SjEngineOpts {
  /** 注入随机源（洗牌、机器人抖动）。不传就用 crypto —— 真实牌局永远走 crypto */
  rng?: SjRng;
  /** 注入当前时间，让测试里的定时判断可复现 */
  now?: number;
}

/* ------------------------------------------------------------------ 事件 */

/** 一次状态变更伴随的瞬时事件（DESIGN 2.3）。状态永远以 room 为准，事件只驱动表演 */
export type SjEvent =
  | { k: 'sj_deal'; handNo: number; dealerSeat: number }
  | { k: 'sj_declare'; playerId: string; trump: SjTrumpSuit; strength: number; cardIds: string[]; reinforce: boolean }
  | { k: 'sj_flip'; card: SjCard; trump: SjTrumpSuit }
  | { k: 'sj_chao'; playerId: string; trump: SjTrumpSuit; strength: number; cardIds: string[] }
  | { k: 'sj_kou_done'; playerId: string }
  | { k: 'sj_play'; playerId: string; cardIds: string[]; unit: 'single' | 'pair' | 'tractor' | 'throw'; trumped: boolean }
  | { k: 'sj_throw_fail'; playerId: string; forcedIds: string[]; penalty: number }
  | { k: 'sj_trick'; winnerId: string; points: number; toDefenders: boolean; trickNo: number }
  | { k: 'sj_dig'; winnerId: string; base: number; multiplier: number; total: number }
  | { k: 'sj_hand_end'; defenderPoints: number; outcome: SjOutcome }
  | { k: 'sj_match_end'; winnerTeam: 0 | 1 }
  | { k: 'sj_turn'; playerId: string }
  | { k: 'sj_emote'; playerId: string; id: string };

/* --------------------------------------------------------------- 常量 */

export const SJ_DEFAULT_SETTINGS: SjSettings = {
  turnSeconds: 30, kouSeconds: 45, chaoSeconds: 12, autoContinue: true,
};

/** 发牌动画 25 张 × 45ms + 余量（DESIGN 2.5） */
export const SJ_DEAL_MS = 4600;
export const SJ_DECLARE_MS = 3000;
/** 每出现一次新的有效亮主/反主，窗口延长这么久 */
export const SJ_DECLARE_EXTEND_MS = 2000;
export const SJ_HAND_END_MS = 9000;

export const SJ_SEATS = 4;
const BOT_NAMES = ['阿凯', '老陈', '小北', '阿杰'];
const BOT_AVATARS = ['🤖', '👾', '🎩', '🕶️'];

/* --------------------------------------------------------------- 小工具 */

const now_ = (opts?: SjEngineOpts) => opts?.now ?? Date.now();

/**
 * 日志的追加。炸金花的 `pushLog` 签名吃的是 `RoomState`，
 * 而任务要求 game.ts 除了 `kind` 之外不动，所以这里写两个同形状的小函数，
 * 语义（seq 单调、上限截断）与炸金花完全一致。
 */
export function sjLog(state: SjRoomState, text: string, at?: number) {
  state.actionSeq += 1;
  state.log.push({ seq: state.actionSeq, at: at ?? Date.now(), text });
  if (state.log.length > 80) state.log.splice(0, state.log.length - 80);
}

export function teamOf(seat: number): 0 | 1 {
  return (seat % 2) as 0 | 1;
}

export function sjCtx(state: SjRoomState): SjCtx {
  return { trump: state.trump.suit, level: state.trump.level };
}

export function sjPlayerById(state: SjRoomState, id: string): SjPlayer {
  const p = state.players.find((x) => x.id === id);
  if (!p) throw new GameError('玩家不存在', 404);
  return p;
}

export function sjPlayerAtSeat(state: SjRoomState, seat: number): SjPlayer {
  const p = state.players.find((x) => x.seat === seat);
  if (!p) throw new GameError('座位上没有人');
  return p;
}

export function sjCurrentPlayer(state: SjRoomState): SjPlayer | null {
  if (state.turnSeat == null) return null;
  return state.players.find((x) => x.seat === state.turnSeat) ?? null;
}

export function dealerTeam(state: SjRoomState): 0 | 1 {
  return teamOf(state.dealerSeat);
}

/** 本圈的首出结构；还没人出牌就是 null */
export function currentLead(state: SjRoomState): SjShape | null {
  if (!state.trick.length) return null;
  return parseShape(state.trick[0].cardIds.map(cardFromId), sjCtx(state));
}

function requireHost(state: SjRoomState, actorId: string) {
  if (state.hostId !== actorId) throw new GameError('只有房主可以执行此操作', 403);
}

/** 按 id 从手牌里取牌，顺便把「不是你的牌 / 报了重复 id」挡在门外 */
function takeFromHand(player: SjPlayer, cardIds: string[]): SjCard[] {
  const seen = new Set<string>();
  const out: SjCard[] = [];
  for (const id of cardIds) {
    if (seen.has(id)) throw new GameError('同一张牌不能出两次');
    seen.add(id);
    const card = player.hand.find((c) => c.id === id);
    if (!card) throw new GameError('这张牌不在你手里');
    out.push(card);
  }
  return out;
}

function removeFromHand(player: SjPlayer, cards: SjCard[]) {
  const ids = new Set(cards.map((c) => c.id));
  player.hand = player.hand.filter((c) => !ids.has(c.id));
}

function sortAllHands(state: SjRoomState) {
  const ctx = sjCtx(state);
  for (const p of state.players) p.hand = sortSjHand(p.hand, ctx);
}

/* --------------------------------------------------------------- 建房 */

export function createSjPlayer(
  name: string, avatar: string, seat: number, tokenHash: string, isAgent = false,
): SjPlayer {
  // 复用炸金花的建号逻辑（randomId / cleanName / cleanAvatar），再裁到升级要的字段
  const base = createHumanPlayer(name, avatar, seat, tokenHash, isAgent);
  return {
    id: base.id, name: base.name, avatar: base.avatar, seat, ready: false, online: true,
    isBot: false, isAgent, tokenHash, hand: [], declaredIds: [],
  };
}

export function createSjRoom(kind: SjKind, code: string, host: SjPlayer): SjRoomState {
  const ladder = ladderOf(kind);
  return {
    kind,
    id: randomId('room'),
    code,
    hostId: host.id,
    createdAt: Date.now(),
    log: [],
    actionSeq: 0,
    settings: { ...SJ_DEFAULT_SETTINGS },
    players: [host],
    phase: 'lobby',
    levels: [ladder[0], ladder[0]],
    handNo: 0,
    dealerSeat: host.seat,
    trump: { suit: null, level: ladder[0], declarerId: null, strength: 0, cardIds: [] },
    passed: [],
    dealStartedAt: null,
    declareEndsAt: null,
    turnDeadline: null,
    kouSeat: host.seat,
    chaoSeat: null,
    chaoDirty: false,
    bottom: [],
    bottomRevealed: false,
    flipped: null,
    trickNo: 0,
    leaderSeat: 0,
    turnSeat: null,
    trick: [],
    lastTrick: null,
    defenderPoints: 0,
    handTrickPoints: [0, 0],
    penaltyPoints: 0,
    capturedPointCards: [],
    playedIds: [],
    voidGroups: Array.from({ length: SJ_SEATS }, () => []),
    lastThrowFail: null,
  };
}

/* --------------------------------------------------------------- 发牌 */

/**
 * 发一局牌（DESIGN 1.4 dealing）：从庄家开始顺时针每人 25 张，剩 8 张是底牌。
 *
 * 亮主窗口从**发牌第一张起**就开放，所以这里直接进 `dealing`，
 * 服务端不去限制「这张牌动画里发到没有」—— 那是客户端自己的事。
 */
export function dealSjHand(state: SjRoomState, opts?: SjEngineOpts) {
  if (state.players.length !== SJ_SEATS) throw new GameError('升级必须四个人');
  const level = state.levels[dealerTeam(state)];
  const deck = shuffleSj(createSjDeck(), opts?.rng);

  state.handNo += 1;
  state.phase = 'dealing';
  state.trump = { suit: null, level, declarerId: null, strength: 0, cardIds: [] };
  state.passed = [];
  state.dealStartedAt = now_(opts);
  state.declareEndsAt = null;
  state.turnDeadline = null;
  state.kouSeat = state.dealerSeat;
  state.chaoSeat = null;
  state.chaoDirty = false;
  state.bottom = deck.slice(100);
  state.bottomRevealed = false;
  state.flipped = null;
  state.trickNo = 0;
  state.leaderSeat = state.dealerSeat;
  state.turnSeat = null;
  state.trick = [];
  state.lastTrick = null;
  state.defenderPoints = 0;
  state.handTrickPoints = [0, 0];
  state.penaltyPoints = 0;
  state.capturedPointCards = [];
  state.playedIds = [];
  state.voidGroups = Array.from({ length: SJ_SEATS }, () => []);
  state.lastThrowFail = null;
  state.result = undefined;

  for (const p of state.players) {
    p.hand = [];
    p.declaredIds = [];
    p.lastAction = undefined;
  }
  for (let i = 0; i < 100; i++) {
    sjPlayerAtSeat(state, (state.dealerSeat + i) % SJ_SEATS).hand.push(deck[i]);
  }
  sortAllHands(state);
  sjLog(state, `第 ${state.handNo} 局开始，打 ${levelLabel(level)}`, now_(opts));
}

/** 发牌动画播完 → 开亮主窗口（DESIGN 2.5） */
export function finishDealing(state: SjRoomState, opts?: SjEngineOpts) {
  if (state.phase !== 'dealing') return;
  state.phase = 'declaring';
  state.declareEndsAt = now_(opts) + SJ_DECLARE_MS;
}

/* --------------------------------------------------------------- 亮主 */

interface Declaration {
  trump: SjTrumpSuit;
  strength: number;
  cards: SjCard[];
}

const DECL_FORM_ERROR = '亮主只能是：单张级牌、一对同花色级牌、一对小王、一对大王';

/**
 * 把一组牌读成一次亮主。读不出来就是不合法的亮主形式（DESIGN 1.4 declaring）。
 * 强度一律走 `rules.ts` 的 `declStrength`，这里不写档位数字。
 */
export function readDeclaration(cards: SjCard[], level: number): Declaration | null {
  if (cards.length === 1) {
    const c = cards[0];
    if (c.suit !== 'J' && c.rank === level) return { trump: c.suit, strength: declStrength('single'), cards };
    return null;
  }
  if (cards.length !== 2) return null;
  const [a, b] = cards;
  if (a.suit === 'J' && b.suit === 'J' && a.rank === b.rank) {
    // 一对小王 / 一对大王都定无主，只是档位不同
    const kind = a.rank === RANK_BIG_JOKER ? 'joker_b' : 'joker_s';
    return { trump: 'NT', strength: declStrength(kind), cards };
  }
  if (a.suit !== 'J' && a.suit === b.suit && a.rank === level && b.rank === level) {
    return { trump: a.suit, strength: declStrength('pair', a.suit), cards };
  }
  return null;
}

/**
 * 把「亮成了」这件事落到状态上：旧亮主者的明牌收回，新的明牌摆到座位前。
 * 亮主、反主、抄底三条路径共用，免得三处各写一遍还各漏一点。
 */
function applyDeclaration(state: SjRoomState, actor: SjPlayer, decl: Declaration) {
  const t = state.trump;
  const previous = t.declarerId && t.declarerId !== actor.id ? state.players.find((p) => p.id === t.declarerId) : null;
  if (previous) previous.declaredIds = [];
  state.trump = {
    suit: decl.trump, level: t.level, declarerId: actor.id, strength: decl.strength,
    cardIds: decl.cards.map((c) => c.id),
  };
  actor.declaredIds = state.trump.cardIds;
}

function doDeclare(state: SjRoomState, actor: SjPlayer, cardIds: string[], opts?: SjEngineOpts) {
  if (state.phase !== 'dealing' && state.phase !== 'declaring') throw new GameError('现在不能亮主');
  let cards = takeFromHand(actor, cardIds);
  const level = state.trump.level;
  const t = state.trump;
  const isCurrentDeclarer = t.declarerId === actor.id;

  // 加固：当前亮主者补出**同花色**的第二张级牌，把单张（1）抬到该花色的对子档（DESIGN 1.4）。
  // 只报新的那一张也算，前端少一次拼装。
  if (isCurrentDeclarer && t.strength === 1 && cards.length === 1) {
    const c = cards[0];
    if (c.suit !== 'J' && c.rank === level && c.suit === t.suit) {
      cards = [...t.cardIds.map((id) => actor.hand.find((h) => h.id === id)).filter((x): x is SjCard => !!x), c];
    }
  }

  const decl = readDeclaration(cards, level);
  if (!decl) throw new GameError(DECL_FORM_ERROR);
  const check = checkOverride(decl, t, actor.id, 'declare');
  if (!check.ok) throw new GameError(check.reason);
  // 加固就是「自己把自己的单张抬成同花色的一对」，判完才好认
  const reinforce = isCurrentDeclarer && t.strength === 1 && decl.trump === t.suit && decl.cards.length === 2;

  applyDeclaration(state, actor, decl);
  actor.lastAction = reinforce ? '加固' : '亮主';
  state.passed = state.passed.filter((id) => id !== actor.id);
  // 每出现一次新的有效亮主/反主，窗口延长 2s（DESIGN 1.4）
  if (state.phase === 'declaring') {
    state.declareEndsAt = Math.max(state.declareEndsAt ?? 0, now_(opts) + SJ_DECLARE_EXTEND_MS);
  }
  sortAllHands(state);
  sjLog(state, `${actor.name} ${reinforce ? '加固' : '亮'}${trumpLabel(decl.trump)}（${cardsLabel(decl.cards)}）`, now_(opts));
}

function doPass(state: SjRoomState, actor: SjPlayer, opts?: SjEngineOpts) {
  if (state.phase !== 'dealing' && state.phase !== 'declaring') throw new GameError('现在不用表态');
  if (state.trump.declarerId === actor.id) throw new GameError('你已经亮主了');
  if (!state.passed.includes(actor.id)) state.passed.push(actor.id);
  actor.lastAction = '不亮';
  // 四个人都点了「不亮」就立即结束窗口，不用干等（DESIGN 1.4）
  if (state.passed.length >= SJ_SEATS) closeDeclaring(state, opts);
}

/**
 * 亮主窗口结束（DESIGN 1.4）。
 *
 * 无人亮主 → 翻底牌第一张定主，是王则无主。
 * 首局的庄家 = 窗口结束时亮主有效的那个人；无人亮主则房主坐庄。
 * 后续局的庄家早就由 1.8 的轮转定死，亮主只决定主花色。
 */
export function closeDeclaring(state: SjRoomState, opts?: SjEngineOpts) {
  if (state.phase !== 'dealing' && state.phase !== 'declaring') return;

  if (!state.trump.suit) {
    const first = state.bottom[0];
    const suit: SjTrumpSuit = first.suit === 'J' ? 'NT' : first.suit;
    state.trump = { ...state.trump, suit, declarerId: null, strength: 0, cardIds: [] };
    state.flipped = first;
    sjLog(state, `无人亮主，翻底定主：${trumpLabel(suit)}`, now_(opts));
  } else if (state.handNo === 1 && state.trump.declarerId) {
    // 首局庄家由亮主决定。两队级别此刻相同，所以换庄不会改变本局级牌
    const declarer = sjPlayerById(state, state.trump.declarerId);
    state.dealerSeat = declarer.seat;
    sjLog(state, `${declarer.name} 亮主，本局坐庄`, now_(opts));
  }

  enterKou(state, state.dealerSeat, opts);
  state.declareEndsAt = null;
}

/* --------------------------------------------------------------- 扣底 */

/**
 * 把 8 张底牌交给 `seat` 并开始扣底（DESIGN 1.4 / 1.4b）。
 *
 * 底牌进他的 33 张手牌里，`state.bottom` 先清空 —— 同一张牌绝不同时存两份，
 * 否则 sanitize 那边一不小心就会把它顺出去。庄家开局扣底和抄底者重新扣底走的是同一条路。
 */
function enterKou(state: SjRoomState, seat: number, opts?: SjEngineOpts) {
  const player = sjPlayerAtSeat(state, seat);
  player.hand = player.hand.concat(state.bottom);
  state.bottom = [];
  state.phase = 'kou';
  state.kouSeat = seat;
  state.chaoSeat = null;
  state.turnSeat = seat;
  state.turnDeadline = now_(opts) + state.settings.kouSeconds * 1000;
  sortAllHands(state);
  sjLog(state, `${player.name} 拿到底牌，开始扣底`, now_(opts));
}

function doKou(state: SjRoomState, actor: SjPlayer, cardIds: string[], opts?: SjEngineOpts) {
  if (state.phase !== 'kou') throw new GameError('现在不是扣底阶段');
  if (actor.seat !== state.kouSeat) {
    // 抄底之后扣底的不是庄家，报错话术得跟着当前局面走，别让人对着「只有庄家」发懵
    throw new GameError(state.kouSeat === state.dealerSeat ? '只有庄家能扣底' : '只有抄底的人能扣底');
  }
  if (cardIds.length !== 8) throw new GameError('必须扣 8 张牌');
  const cards = takeFromHand(actor, cardIds);
  removeFromHand(actor, cards);
  state.bottom = cards;

  /*
   * 扣下去的牌里如果有自己亮出来的那张明牌，就得把它从桌面上摘掉。
   * `trump.cardIds` / `declaredIds` 是**公开**的，而底牌是扣着的 ——
   * 留着那个 id 等于把底牌里的一张告诉全场（DESIGN 2.4 的泄密边界）。
   * 抄底之后这条路会天天走到：抄底者永远既是亮主的人、又是扣底的人。
   */
  const buried = new Set(cards.map((c) => c.id));
  if (actor.declaredIds.some((id) => buried.has(id))) {
    actor.declaredIds = actor.declaredIds.filter((id) => !buried.has(id));
    state.trump = { ...state.trump, cardIds: state.trump.cardIds.filter((id) => !buried.has(id)) };
  }

  // 庄家第一次扣完 → 开第一轮询问；抄底者扣完 → 接着问本轮剩下的人（DESIGN 1.4b）
  if (state.chaoDirty) advanceChao(state, actor.seat, opts);
  else startChaoRound(state, opts);
}

/** 扣底超时 → 机器人策略代扣（DESIGN 1.4 / 2.5）。代扣的是 `kouSeat`，不一定是庄家 */
export function timeoutKou(state: SjRoomState, opts?: SjEngineOpts) {
  if (state.phase !== 'kou') return;
  const player = sjPlayerAtSeat(state, state.kouSeat);
  const cardIds = botKou(state, player, opts?.rng);
  sjLog(state, `${player.name} 由电脑代扣底牌`, now_(opts));
  doKou(state, player, cardIds, opts);
}

/* --------------------------------------------------------------- 抄底 */

/**
 * 顺时针的下一个**不是庄家**的座位。
 *
 * 庄家刚扣完底，本轮不再问他 —— 他已经拿过一次底牌了（DESIGN 1.4b）。
 * 首局里抄底者会变成庄家，于是「跳过庄家」自动等价于「跳过刚扣完底的人」。
 */
function nextChaoSeat(state: SjRoomState, from: number): number {
  for (let i = 1; i <= SJ_SEATS; i++) {
    const seat = (from + i) % SJ_SEATS;
    if (seat !== state.dealerSeat) return seat;
  }
  return (from + 1) % SJ_SEATS; // 到不了：四个座位里只有一个庄家
}

/** 开一轮抄底询问：固定从庄家下家问起（DESIGN 1.4b） */
function startChaoRound(state: SjRoomState, opts?: SjEngineOpts) {
  const seat = (state.dealerSeat + 1) % SJ_SEATS;
  state.phase = 'chao';
  state.chaoDirty = false;
  state.chaoSeat = seat;
  state.turnSeat = seat;
  state.turnDeadline = now_(opts) + state.settings.chaoSeconds * 1000;
}

/**
 * 问完一个人之后往下走（DESIGN 1.4b）。
 *
 * 一轮就是「庄家下家 → 顺时针三家」，问回起点就算一轮问完：
 * 这一轮有人抄成过就再开一轮，一个人都没抄才开打。
 * 每抄成一次强度都严格变大、上限是 7，所以一定收敛，不会一直问下去。
 */
function advanceChao(state: SjRoomState, from: number, opts?: SjEngineOpts) {
  const next = nextChaoSeat(state, from);
  if (next === (state.dealerSeat + 1) % SJ_SEATS) {
    if (state.chaoDirty) return startChaoRound(state, opts);
    return enterPlaying(state, opts);
  }
  state.phase = 'chao';
  state.chaoSeat = next;
  state.turnSeat = next;
  state.turnDeadline = now_(opts) + state.settings.chaoSeconds * 1000;
}

/**
 * 抄底（DESIGN 1.4b）：亮出比当前主更强的一手，**视同反主**，
 * 然后把 8 张底牌拿回来重新扣。抄底不限次数。
 */
function doChao(state: SjRoomState, actor: SjPlayer, cardIds: string[], opts?: SjEngineOpts) {
  if (state.phase !== 'chao') throw new GameError('现在不是抄底阶段');
  if (actor.seat !== state.chaoSeat) throw new GameError('还没轮到你抄底');
  const cards = takeFromHand(actor, cardIds);
  const decl = readDeclaration(cards, state.trump.level);
  if (!decl) throw new GameError(DECL_FORM_ERROR);
  const check = checkOverride(decl, state.trump, actor.id, 'chao');
  if (!check.ok) throw new GameError(check.reason);

  applyDeclaration(state, actor, decl);
  actor.lastAction = '抄底';
  // 首局的庄家就是「亮主有效的那个人」（DESIGN 1.4），抄底视同反主，所以首局抄底者坐庄。
  // 这时两队级别还相同，换庄不会改变本局级牌。第二局起庄家按 1.8 轮转，抄底不换庄。
  if (state.handNo === 1) state.dealerSeat = actor.seat;
  state.chaoDirty = true;
  sjLog(
    state,
    `${actor.name} 抄底，亮 ${cardsLabel(decl.cards)}，主变${trumpLabel(decl.trump)}`,
    now_(opts),
  );
  enterKou(state, actor.seat, opts);
}

function doPassChao(state: SjRoomState, actor: SjPlayer, opts?: SjEngineOpts) {
  if (state.phase !== 'chao') throw new GameError('现在不是抄底阶段');
  if (actor.seat !== state.chaoSeat) throw new GameError('还没轮到你');
  actor.lastAction = '不抄';
  advanceChao(state, actor.seat, opts);
}

/** 抄底询问超时 / 掉线 → 自动「不抄」（DESIGN 1.4b） */
export function timeoutChao(state: SjRoomState, opts?: SjEngineOpts) {
  if (state.phase !== 'chao' || state.chaoSeat == null) return;
  doPassChao(state, sjPlayerAtSeat(state, state.chaoSeat), opts);
}

function enterPlaying(state: SjRoomState, opts?: SjEngineOpts) {
  state.phase = 'playing';
  state.trickNo = 1;
  state.leaderSeat = state.dealerSeat;
  state.turnSeat = state.dealerSeat;
  state.chaoSeat = null;
  state.chaoDirty = false;
  state.trick = [];
  state.turnDeadline = now_(opts) + state.settings.turnSeconds * 1000;
  // 亮主/抄底的明牌摆到抄底问完为止（DESIGN 1.4 / 1.4b）。这也是安全边界：
  // 再往后 trump.cardIds 就会指向某个人手里的暗牌，留着等于持续泄密。
  for (const p of state.players) p.declaredIds = [];
  state.trump = { ...state.trump, cardIds: [] };
  state.flipped = null;
  sortAllHands(state);
  sjLog(state, `${sjPlayerAtSeat(state, state.dealerSeat).name} 首出`, now_(opts));
}

/* --------------------------------------------------------------- 出牌 */

function doPlay(state: SjRoomState, actor: SjPlayer, cardIds: string[], opts?: SjEngineOpts) {
  if (state.phase !== 'playing') throw new GameError('现在不能出牌');
  if (actor.seat !== state.turnSeat) throw new GameError('还没轮到你');
  const ctx = sjCtx(state);
  const cards = takeFromHand(actor, cardIds);
  if (!cards.length) throw new GameError('至少要出一张牌');

  let played = cards;
  let failure: SjThrowFailRecord | null = null;
  const lead = currentLead(state);

  if (!lead) {
    const check = validateLead(cards, ctx);
    if (!check.ok) throw new GameError(check.reason);
    const shape = parseShape(cards, ctx)!;
    if (shape.isThrow) {
      // 甩牌要拿全部手牌判定，只有服务端做得到（DESIGN 1.5）
      const others = state.players.filter((p) => p.seat !== actor.seat).map((p) => p.hand);
      const bad = validateThrow(shape, others, ctx);
      if (bad) {
        played = bad.forced.cards;
        // 闲家失败 → 闲家 −10；庄家阵营失败 → 闲家 +10
        const penalty = teamOf(actor.seat) === dealerTeam(state) ? 10 : -10;
        failure = { playerId: actor.id, forcedIds: played.map((c) => c.id), penalty };
      }
    }
  } else {
    const check = validateFollow(actor.hand, lead, cards, ctx);
    if (!check.ok) throw new GameError(check.reason);
    // 只有实际垫了别组牌，桌上所有人才确定他已把首出花色跟光；这是公开记牌，不是读暗牌。
    if (cardsInGroup(cards, lead.group, ctx).length < lead.count) {
      const voids = state.voidGroups[actor.seat] ?? (state.voidGroups[actor.seat] = []);
      if (!voids.includes(lead.group)) voids.push(lead.group);
    }
  }

  removeFromHand(actor, played);
  state.trick.push({ seat: actor.seat, cardIds: played.map((c) => c.id) });
  for (const c of played) state.playedIds.push(c.id);
  // 跟不上的时候是跨组垫牌，解析不出牌型 —— 那就只报张数
  const playedShape = parseShape(played, ctx);
  actor.lastAction = playedShape ? shapeLabel(playedShape) : `垫 ${played.length} 张`;

  state.lastThrowFail = failure;
  if (failure) {
    state.penaltyPoints += failure.penalty;
    state.defenderPoints += failure.penalty;
    sjLog(state, `${actor.name} 甩牌失败，罚 10 分`, now_(opts));
  }

  if (state.trick.length === SJ_SEATS) settleTrick(state, opts);
  else {
    state.turnSeat = (actor.seat + 1) % SJ_SEATS;
    state.turnDeadline = now_(opts) + state.settings.turnSeconds * 1000;
  }
}

function settleTrick(state: SjRoomState, opts?: SjEngineOpts) {
  const ctx = sjCtx(state);
  const plays = state.trick.map((p) => ({ seat: p.seat, cards: p.cardIds.map(cardFromId) }));
  const winner = trickWinner(plays, ctx);
  const points = trickPoints(plays);
  const team = teamOf(winner.seat);

  state.handTrickPoints[team] += points;
  if (team !== dealerTeam(state)) {
    state.defenderPoints += points;
    for (const p of plays) state.capturedPointCards.push(...pointCards(p.cards));
  }
  state.lastTrick = {
    trickNo: state.trickNo,
    leaderSeat: state.leaderSeat,
    plays: state.trick.map((p) => ({ seat: p.seat, cardIds: [...p.cardIds] })),
    winnerSeat: winner.seat,
    points,
  };
  sjLog(
    state,
    `第 ${state.trickNo} 圈：${sjPlayerAtSeat(state, winner.seat).name} 收 ${points} 分`,
    now_(opts),
  );

  state.trick = [];
  state.leaderSeat = winner.seat;
  state.turnSeat = winner.seat;
  state.trickNo += 1;
  state.turnDeadline = now_(opts) + state.settings.turnSeconds * 1000;

  // 手牌打完就结算。一圈消耗的张数取决于牌型（单张 1 张、对子 2 张、拖拉机更多），
  // 所以一局的圈数是 1–25 之间的变量，不是固定 25 圈。
  if (state.players.every((p) => p.hand.length === 0)) finishHand(state, opts);
}

/** 出牌超时 → 机器人策略代出一手**合法**牌。没有弃牌概念（DESIGN 1.4 playing） */
export function timeoutTurn(state: SjRoomState, opts?: SjEngineOpts) {
  if (state.phase !== 'playing') return;
  const player = sjCurrentPlayer(state);
  if (!player) return;
  doPlay(state, player, botPlay(state, player, opts?.rng), opts);
}

/* --------------------------------------------------------------- 结算 */

/** 一局打完：抠底 → 升级表 → 庄家轮转 → 通关判定（DESIGN 1.8） */
export function finishHand(state: SjRoomState, opts?: SjEngineOpts) {
  const dTeam = dealerTeam(state);
  const defTeam = (1 - dTeam) as 0 | 1;
  const bottomPoints = sumPoints(state.bottom);
  state.bottomRevealed = true;

  let dig: SjHandResult['dig'];
  const last = state.lastTrick;
  if (last && teamOf(last.winnerSeat) !== dTeam) {
    // QQ 口径按末圈首出的牌型定番：散牌甩仍单抠，含对双抠，拖拉机按其张数翻番。
    const leadCards = last.plays[0]?.cardIds.map(cardFromId) ?? [];
    const multiplier = digMultiplierForLead(leadCards, sjCtx(state));
    const total = bottomPoints * multiplier;
    dig = { base: bottomPoints, multiplier, total };
    state.defenderPoints += total;
    state.capturedPointCards.push(...pointCards(state.bottom));
    sjLog(state, `闲家抠底：${bottomPoints} × ${multiplier} = ${total} 分`, now_(opts));
  }

  const outcome = outcomeFor(state.defenderPoints);
  const ladder = ladderOf(state.kind);
  const levelBefore = state.levels[dTeam];
  const levelsAfter: [number, number] = [state.levels[0], state.levels[1]];
  const upTeam = outcome.defendersWin ? defTeam : dTeam;
  levelsAfter[upTeam] = levelUp(ladder, state.levels[upTeam], outcome.up);

  const won = isMatchWon(state.kind, levelBefore, outcome);
  state.result = {
    handNo: state.handNo,
    dealerSeat: state.dealerSeat,
    defenderPoints: state.defenderPoints,
    trickPoints: [state.handTrickPoints[0], state.handTrickPoints[1]],
    bottomPoints,
    penaltyPoints: state.penaltyPoints,
    dig,
    outcome,
    nextDealerSeat: nextDealerSeat(state.dealerSeat, outcome.defendersWin),
    levelsAfter,
    bottom: state.bottom.map((c) => ({ ...c })),
  };
  state.levels = levelsAfter;
  state.turnSeat = null;
  state.trick = [];
  state.phase = won ? 'match_end' : 'hand_end';
  state.turnDeadline = won ? null : now_(opts) + SJ_HAND_END_MS;
  if (won) state.matchWinner = dTeam;

  sjLog(state, `闲家 ${state.defenderPoints} 分，${outcome.label}`, now_(opts));
  if (won) sjLog(state, `${dTeam === 0 ? '0/2' : '1/3'} 队通关，赢下整场比赛`, now_(opts));
}

/** 开下一局：庄家按 1.8 轮转，级别已经在 finishHand 里升好 */
export function startNextHand(state: SjRoomState, opts?: SjEngineOpts) {
  if (state.phase !== 'hand_end') throw new GameError('本局还没结束');
  state.dealerSeat = state.result?.nextDealerSeat ?? state.dealerSeat;
  dealSjHand(state, opts);
}

/* --------------------------------------------------------------- 指令 */

export type SjCommand =
  | { type: 'ready'; ready: boolean }
  | { type: 'rename'; name: string; avatar: string }
  | { type: 'seat'; seat: number }
  | { type: 'start' }
  | { type: 'add_bot' }
  | { type: 'remove_player'; targetId: string }
  | { type: 'declare'; cardIds: string[] }
  | { type: 'pass' }
  | { type: 'kou'; cardIds: string[] }
  | { type: 'chao'; cardIds: string[] }
  | { type: 'pass_chao' }
  | { type: 'play'; cardIds: string[] }
  | { type: 'new_hand' }
  | { type: 'new_match' }
  | {
    type: 'settings';
    turnSeconds?: number; kouSeconds?: number; chaoSeconds?: number; autoContinue?: boolean;
  }
  | { type: 'emote'; id: string }
  | { type: 'leave' };

export const SJ_COMMAND_TYPES = new Set<SjCommand['type']>([
  'ready', 'rename', 'seat', 'start', 'add_bot', 'remove_player', 'declare', 'pass',
  'kou', 'chao', 'pass_chao', 'play', 'new_hand', 'new_match', 'settings', 'emote', 'leave',
]);

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));

export function applySjCommand(
  state: SjRoomState, actorId: string, command: SjCommand, opts?: SjEngineOpts,
): void {
  const actor = sjPlayerById(state, actorId);
  switch (command.type) {
    case 'ready': {
      if (state.phase !== 'lobby') throw new GameError('只能在准备阶段切换准备状态');
      if (actor.isBot) throw new GameError('机器人无需准备');
      actor.ready = command.ready;
      sjLog(state, `${actor.name}${command.ready ? ' 已准备' : ' 取消准备'}`, now_(opts));
      return;
    }
    case 'rename': {
      if (state.phase !== 'lobby' && state.phase !== 'hand_end' && state.phase !== 'match_end') {
        throw new GameError('牌局进行中不能改名');
      }
      const name = cleanName(command.name);
      if (state.players.some((p) => p.id !== actor.id && p.name === name)) throw new GameError('这个昵称已经有人用了');
      const before = actor.name;
      actor.name = name;
      actor.avatar = cleanAvatar(command.avatar);
      if (before !== name) sjLog(state, `${before} 改名为 ${name}`, now_(opts));
      return;
    }
    case 'seat': {
      // 大厅里换座是为了组队：0/2 一队、1/3 一队（DESIGN 1.3）
      if (state.phase !== 'lobby') throw new GameError('只能在准备阶段换座');
      const seat = command.seat;
      if (!Number.isInteger(seat) || seat < 0 || seat >= SJ_SEATS) throw new GameError('座位号不对');
      if (actor.seat === seat) return;
      const occupant = state.players.find((p) => p.seat === seat);
      if (occupant) occupant.seat = actor.seat;
      actor.seat = seat;
      sjLog(state, `${actor.name} 换到 ${seat + 1} 号座`, now_(opts));
      return;
    }
    case 'start': {
      requireHost(state, actorId);
      if (state.phase !== 'lobby') throw new GameError('只有准备阶段可以开始');
      if (state.players.length !== SJ_SEATS) throw new GameError('四个座位坐满才能开局');
      if (state.players.some((p) => !p.isBot && (!p.ready || !p.online))) throw new GameError('还有人没准备好');
      state.dealerSeat = actor.seat;
      state.handNo = 0;
      dealSjHand(state, opts);
      return;
    }
    case 'add_bot': {
      requireHost(state, actorId);
      if (state.phase !== 'lobby') throw new GameError('只能在准备阶段添加电脑玩家');
      if (state.players.length >= SJ_SEATS) throw new GameError('房间已满');
      const used = new Set(state.players.map((p) => p.seat));
      let seat = 0;
      while (used.has(seat)) seat++;
      const idx = BOT_NAMES.findIndex((n) => !state.players.some((p) => p.name === n));
      const name = idx >= 0 ? BOT_NAMES[idx] : `电脑${seat + 1}`;
      state.players.push({
        id: randomId('bot'), name, avatar: BOT_AVATARS[idx >= 0 ? idx : 0], seat,
        ready: true, online: true, isBot: true, hand: [], declaredIds: [],
      });
      sjLog(state, `${name}（电脑）加入房间`, now_(opts));
      return;
    }
    case 'remove_player': {
      requireHost(state, actorId);
      if (command.targetId === actorId) throw new GameError('房主不能移除自己，请使用退出房间');
      const t = sjPlayerById(state, command.targetId);
      leaveSeat(state, t, opts);
      return;
    }
    case 'declare': return doDeclare(state, actor, command.cardIds, opts);
    case 'pass': return doPass(state, actor, opts);
    case 'kou': return doKou(state, actor, command.cardIds, opts);
    case 'chao': return doChao(state, actor, command.cardIds, opts);
    case 'pass_chao': return doPassChao(state, actor, opts);
    case 'play': return doPlay(state, actor, command.cardIds, opts);
    case 'new_hand': {
      requireHost(state, actorId);
      startNextHand(state, opts);
      return;
    }
    case 'new_match': {
      requireHost(state, actorId);
      if (state.phase !== 'match_end') throw new GameError('比赛还没结束');
      const ladder = ladderOf(state.kind);
      state.levels = [ladder[0], ladder[0]];
      state.matchWinner = undefined;
      state.result = undefined;
      state.handNo = 0;
      state.phase = 'lobby';
      state.turnSeat = null;
      state.turnDeadline = null;
      state.kouSeat = state.dealerSeat;
      state.chaoSeat = null;
      state.chaoDirty = false;
      state.trump = { suit: null, level: ladder[0], declarerId: null, strength: 0, cardIds: [] };
      for (const p of state.players) {
        p.hand = [];
        p.declaredIds = [];
        p.lastAction = undefined;
      }
      sjLog(state, '再来一场：级别重置，庄家由亮主重新决定', now_(opts));
      return;
    }
    case 'settings': {
      requireHost(state, actorId);
      if (state.phase !== 'lobby' && state.phase !== 'hand_end') throw new GameError('牌局进行中不能改房规');
      const changed: string[] = [];
      if (typeof command.turnSeconds === 'number') {
        state.settings.turnSeconds = clamp(command.turnSeconds, 10, 180);
        changed.push(`出牌时限 ${state.settings.turnSeconds} 秒`);
      }
      if (typeof command.kouSeconds === 'number') {
        state.settings.kouSeconds = clamp(command.kouSeconds, 15, 180);
        changed.push(`扣底时限 ${state.settings.kouSeconds} 秒`);
      }
      if (typeof command.chaoSeconds === 'number') {
        // 一轮要问三家，所以上限压得比扣底低得多 —— 抄底是个「要不要」的快问快答
        state.settings.chaoSeconds = clamp(command.chaoSeconds, 5, 60);
        changed.push(`抄底时限 ${state.settings.chaoSeconds} 秒`);
      }
      if (typeof command.autoContinue === 'boolean') {
        state.settings.autoContinue = command.autoContinue;
        changed.push(command.autoContinue ? '自动续局开' : '自动续局关');
      }
      if (changed.length) sjLog(state, `房规调整：${changed.join('、')}`, now_(opts));
      return;
    }
    case 'emote': {
      if (!EMOTES.includes(command.id)) throw new GameError('无效的表情');
      actor.emote = { id: command.id, at: now_(opts) };
      return;
    }
    case 'leave': {
      transferSjHost(state, actor.id, opts);
      leaveSeat(state, actor, opts);
      return;
    }
    default: {
      const never: never = command;
      throw new GameError(`未知操作 ${JSON.stringify(never)}`);
    }
  }
}

/**
 * 离座（DESIGN 1.9）。
 *
 * 局中离开不能真的把人抬走 —— 升级是四人固定制，少一个人整局就废了。
 * 所以局中只把座位交给电脑接管到本场结束；大厅里离开才真正空出座位。
 */
function leaveSeat(state: SjRoomState, player: SjPlayer, opts?: SjEngineOpts) {
  if (state.phase === 'lobby') {
    state.players = state.players.filter((p) => p.id !== player.id);
    sjLog(state, `${player.name} 离开房间`, now_(opts));
    if (!state.players.some((p) => p.id === state.hostId)) transferSjHost(state, undefined, opts);
    return;
  }
  player.pendingLeave = true;
  player.isBot = true;
  player.online = false;
  sjLog(state, `${player.name} 离开，座位由电脑接管到本场结束`, now_(opts));
}

/** 房主移交：只交给真人，沿用炸金花的规矩（DESIGN 1.9） */
export function transferSjHost(state: SjRoomState, departingId?: string, opts?: SjEngineOpts) {
  if (departingId && state.hostId !== departingId) return;
  const humans = state.players.filter((p) => p.id !== departingId && !p.isBot && !p.pendingLeave);
  const next = humans.find((p) => p.online) ?? humans[0];
  if (next) {
    if (next.id === state.hostId) return;
    state.hostId = next.id;
    sjLog(state, `${next.name} 成为新房主`, now_(opts));
  } else {
    state.hostId = '';
  }
}

/* --------------------------------------------------------------- 视图 */

export type SjPublicPlayer = Omit<SjPlayer, 'tokenHash' | 'hand'> & { hand: SjCard[]; handCount: number };
export type SjPublicRoom = Omit<SjRoomState, 'players' | 'bottom'> & {
  players: SjPublicPlayer[];
  bottom: SjCard[];
  bottomCount: number;
  viewerId: string;
};

/**
 * 给某个玩家看的房间视图（DESIGN 2.4）。
 *
 * 别人的手牌只给张数；底牌只在扣底阶段给**正在扣底的那个人**、`bottomRevealed` 之后给所有人。
 * 抄底询问阶段谁都看不到底牌 —— 那时候它是扣着的，看得到就等于让人照着底牌决定抄不抄。
 * 已经打出的牌、亮主/抄底的明牌、翻底那张、分牌堆是公开信息 —— 前三者本来就摆在桌面上，
 * 而且 id 自带牌面，客户端不需要额外的下发通道。
 */
export function sanitizeSjRoom(state: SjRoomState, viewerId: string): SjPublicRoom {
  const isKouSeat = state.players.find((p) => p.id === viewerId)?.seat === state.kouSeat;
  const showBottom = state.bottomRevealed || (state.phase === 'kou' && isKouSeat);
  return {
    ...state,
    viewerId,
    bottom: showBottom ? state.bottom.map((c) => ({ ...c })) : [],
    bottomCount: state.bottom.length,
    result: state.result
      ? { ...state.result, bottom: state.bottomRevealed ? state.result.bottom.map((c) => ({ ...c })) : [] }
      : undefined,
    players: state.players.map((p) => {
      const { tokenHash: _t, hand, ...safe } = p;
      return { ...safe, hand: p.id === viewerId ? hand.map((c) => ({ ...c })) : [], handCount: hand.length };
    }),
  };
}

/**
 * 把旧快照补齐成当前形状。房间是整个 JSON 存盘的，加过字段的老房间会带着
 * undefined 复活 —— 炸金花在 `migrateRoom` 上吃过这个亏，这里从第一天就补上。
 */
export function migrateSjRoom(state: SjRoomState): SjRoomState {
  const ladder = ladderOf(state.kind ?? 'sj_510k');
  /*
   * 反主级别从 4 档换成 7 档之后，`trump.strength` 的语义变了（DESIGN 1.4）：
   * 旧表 1 单张 / 2 一对级牌（不分花色）/ 3 一对小王 / 4 一对大王；
   * 新表 1 单张 / 2–5 一对级牌（♦♣♥♠）/ 6 一对小王 / 7 一对大王。
   *
   * 判据用 `kouSeat` —— 它和这张新表是同一批加进来的，老快照里一定没有，
   * 所以「没有 kouSeat」就等价于「strength 还是旧语义」。换算只在这里做一次，
   * 运行时不留任何兼容分支。
   */
  const legacyStrength = typeof state.kouSeat !== 'number';
  state.kind ??= 'sj_510k';
  state.settings = { ...SJ_DEFAULT_SETTINGS, ...(state.settings ?? {}) };
  state.log ??= [];
  state.actionSeq ??= 0;
  state.createdAt ??= Date.now();
  state.levels ??= [ladder[0], ladder[0]];
  state.handNo ??= 0;
  state.dealerSeat ??= 0;
  state.trump ??= { suit: null, level: ladder[0], declarerId: null, strength: 0, cardIds: [] };
  state.trump.cardIds ??= [];
  state.trump.strength ??= 0;
  if (legacyStrength) {
    const old = state.trump.strength;
    const suit = state.trump.suit;
    state.trump.strength =
      old === 4 ? SJ_DECL_TIER.joker_b
        : old === 3 ? SJ_DECL_TIER.joker_s
          : old === 2 && suit && suit !== 'NT' ? SJ_DECL_TIER[suit]
            : old; // 0（翻底定主）和 1（单张）两档在新表里没变
  }
  state.passed ??= [];
  state.dealStartedAt ??= null;
  state.declareEndsAt ??= null;
  state.turnDeadline ??= null;
  // 老快照没有抄底这回事：正在扣底的一定是庄家，也不可能停在询问里
  state.kouSeat ??= state.dealerSeat;
  state.chaoSeat ??= null;
  state.chaoDirty ??= false;
  state.bottom ??= [];
  state.bottomRevealed ??= false;
  state.flipped ??= null;
  state.trickNo ??= 0;
  state.leaderSeat ??= 0;
  state.turnSeat ??= null;
  state.trick ??= [];
  state.lastTrick ??= null;
  state.defenderPoints ??= 0;
  state.handTrickPoints ??= [0, 0];
  state.penaltyPoints ??= 0;
  state.capturedPointCards ??= [];
  state.playedIds ??= [];
  if (!Array.isArray(state.voidGroups)) {
    state.voidGroups = Array.from({ length: SJ_SEATS }, () => []);
  } else {
    state.voidGroups = Array.from({ length: SJ_SEATS }, (_, seat) =>
      Array.isArray(state.voidGroups[seat]) ? [...new Set(state.voidGroups[seat])] : []);
  }
  state.lastThrowFail ??= null;
  for (const p of state.players ?? []) {
    p.avatar ||= AVATARS[0];
    p.hand ??= [];
    p.declaredIds ??= [];
    p.ready ??= false;
    p.online ??= false;
    p.isBot ??= false;
  }
  return state;
}

/* --------------------------------------------------------------- 事件派生 */

/**
 * 从「变更前 / 变更后」两份状态里推出这一步该播什么动画（DESIGN 2.3）。
 *
 * 之所以是**派生**而不是在每个动作里手写 push：状态机里任何一条路径改了流程，
 * 事件都会跟着自动对上，不会出现「新加的分支忘了发事件」。
 */
export function deriveSjEvents(
  before: SjRoomState, after: SjRoomState, actorId: string, cmd: SjCommand | null,
): SjEvent[] {
  const events: SjEvent[] = [];
  const nameOf = (seat: number) => after.players.find((p) => p.seat === seat)?.id ?? '';

  if (after.phase === 'dealing' && (before.phase !== 'dealing' || before.handNo !== after.handNo)) {
    events.push({ k: 'sj_deal', handNo: after.handNo, dealerSeat: after.dealerSeat });
  }
  if (
    cmd?.type === 'declare' && after.trump.suit &&
    (before.trump.strength !== after.trump.strength || before.trump.declarerId !== after.trump.declarerId)
  ) {
    events.push({
      k: 'sj_declare', playerId: actorId, trump: after.trump.suit, strength: after.trump.strength,
      cardIds: [...after.trump.cardIds], reinforce: before.trump.declarerId === actorId,
    });
  }
  if (!before.flipped && after.flipped && after.trump.suit) {
    events.push({ k: 'sj_flip', card: after.flipped, trump: after.trump.suit });
  }
  if (cmd?.type === 'chao' && after.trump.suit && before.trump.declarerId !== after.trump.declarerId) {
    events.push({
      k: 'sj_chao', playerId: actorId, trump: after.trump.suit,
      strength: after.trump.strength, cardIds: [...after.trump.cardIds],
    });
  }
  if (before.phase === 'kou' && after.phase !== 'kou') {
    // 扣完底的是 kouSeat 那个人 —— 抄底之后他不一定是庄家
    events.push({ k: 'sj_kou_done', playerId: nameOf(before.kouSeat) });
  }
  if (cmd?.type === 'play') {
    const beforeHand = new Set(before.players.find((p) => p.id === actorId)?.hand.map((c) => c.id) ?? []);
    const afterHand = new Set(after.players.find((p) => p.id === actorId)?.hand.map((c) => c.id) ?? []);
    const playedIds = [...beforeHand].filter((id) => !afterHand.has(id));
    if (playedIds.length) {
      const ctx = sjCtx(after);
      const cards = playedIds.map(cardFromId);
      const shape = parseShape(cards, ctx);
      const lead = before.trick.length ? parseShape(before.trick[0].cardIds.map(cardFromId), ctx) : null;
      const unit = !shape ? 'single' : shape.isThrow ? 'throw' : shape.units[0].kind;
      events.push({
        k: 'sj_play', playerId: actorId, cardIds: playedIds, unit,
        trumped: !!lead && isTrumping(lead, cards, ctx),
      });
    }
    if (after.lastThrowFail && after.lastThrowFail !== before.lastThrowFail) {
      events.push({
        k: 'sj_throw_fail', playerId: after.lastThrowFail.playerId,
        forcedIds: [...after.lastThrowFail.forcedIds], penalty: after.lastThrowFail.penalty,
      });
    }
  }
  if (after.lastTrick && after.lastTrick !== before.lastTrick && after.lastTrick.trickNo !== before.lastTrick?.trickNo) {
    const t = after.lastTrick;
    events.push({
      k: 'sj_trick', winnerId: nameOf(t.winnerSeat), points: t.points,
      // 庄家在一局之内不会变，用变更前的庄位判断阵营最稳
      toDefenders: teamOf(t.winnerSeat) !== teamOf(before.dealerSeat),
      trickNo: t.trickNo,
    });
  }
  if (after.result?.dig && !before.result?.dig && after.lastTrick) {
    events.push({ k: 'sj_dig', winnerId: nameOf(after.lastTrick.winnerSeat), ...after.result.dig });
  }
  if (after.result && after.result !== before.result && before.result?.handNo !== after.result.handNo) {
    events.push({ k: 'sj_hand_end', defenderPoints: after.result.defenderPoints, outcome: after.result.outcome });
  }
  if (after.matchWinner !== undefined && before.matchWinner === undefined) {
    events.push({ k: 'sj_match_end', winnerTeam: after.matchWinner });
  }
  if (cmd?.type === 'emote') events.push({ k: 'sj_emote', playerId: actorId, id: cmd.id });
  if (after.turnSeat != null && after.turnSeat !== before.turnSeat) {
    events.push({ k: 'sj_turn', playerId: nameOf(after.turnSeat) });
  }
  return events;
}

/** 变体的显示名，日志与首页共用 */
export function sjVariantLabel(kind: SjKind): string {
  return SJ_VARIANTS[kind].label;
}

/** 一张牌属于哪个组，给客户端选牌用的转发（省得到处 import cards.ts） */
export const sjGroupOf = groupOf;
