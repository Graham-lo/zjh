/**
 * 多游戏房间框架（DESIGN 2.1 / 1.11）。
 *
 * 上半部分是"有哪些游戏、各自长什么样"的常量，首页、协议、内核都引用同一份定义；
 * 下半部分是**按 kind 派发的引擎注册表**：Hub 不再直接 import 炸金花内核，
 * 而是拿到一个 `GameEngine` 再调用。炸金花包一层适配器，行为零变化。
 *
 * 注册表**惰性构建**（`engine()` 第一次被调用时才建）。原因是这个模块和
 * `sj/engine.ts` 互相 import：sj 内核要 `SJ_VARIANTS` / `ladderOf`，注册表要
 * sj 内核的函数。函数声明会被提升，惰性构建保证读到 `SJ_COMMAND_TYPES`
 * 这类 `const` 时两个模块都已经求值完毕，不会踩到 TDZ。
 */

import {
  applyCommand, botDecision, claimHostIfVacant, cleanAvatar, cleanName, COMMAND_TYPES,
  createHumanPlayer, createInitialRoom, currentPlayer, GameError, migrateRoom, sanitizeRoom,
  timeoutCurrentPlayer, transferHost,
  type GameCommand, type RoomState,
} from './game.ts';
import type { AnyGameCommand, AnyPublicRoom, GameEvent } from './protocol.ts';
import {
  applySjCommand, createSjPlayer, createSjRoom, deriveSjEvents, migrateSjRoom, sanitizeSjRoom,
  SJ_COMMAND_TYPES, SJ_SEATS, sjCurrentPlayer, sjLog, timeoutKou, timeoutTurn, transferSjHost,
  type SjCommand, type SjEngineOpts, type SjRoomState,
} from './sj/engine.ts';
import { botDeclare, botKou, botPlay } from './sj/bot.ts';

export type SjKind = 'sj_510k' | 'sj_2a';
export type GameKind = 'zjh' | SjKind;

/**
 * 升级的两个变体：区别只有级牌阶梯一个数组。
 * 「打通关」用户原话是"从 1 打到 K"，按标准 2→A 阶梯理解（DESIGN 产品决定 2）。
 */
export const SJ_VARIANTS = {
  sj_510k: { label: '五十K', ladder: [5, 10, 13], tagline: '打 5、打 10、打 K，三级定胜负' },
  sj_2a: { label: '打通关', ladder: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14], tagline: '从 2 一路打到 A' },
} as const;

export const SJ_KINDS: SjKind[] = ['sj_510k', 'sj_2a'];
export const GAME_KINDS: GameKind[] = ['zjh', 'sj_510k', 'sj_2a'];

export function isSjKind(kind: string): kind is SjKind {
  return kind === 'sj_510k' || kind === 'sj_2a';
}

export function isGameKind(kind: string): kind is GameKind {
  return kind === 'zjh' || isSjKind(kind);
}

export interface GameMeta {
  label: string;
  tagline: string;
  minPlayers: number;
  maxPlayers: number;
  /** 用几副牌。首页桌卡上的小标 */
  decks: number;
}

export const GAME_META: Record<GameKind, GameMeta> = {
  zjh: { label: '炸金花', tagline: '豹子 顺金 金花，闷牌半价看牌双倍', minPlayers: 2, maxPlayers: 6, decks: 1 },
  sj_510k: { label: '升级 · 五十K', tagline: SJ_VARIANTS.sj_510k.tagline, minPlayers: 4, maxPlayers: 4, decks: 2 },
  sj_2a: { label: '升级 · 打通关', tagline: SJ_VARIANTS.sj_2a.tagline, minPlayers: 4, maxPlayers: 4, decks: 2 },
};

/** 变体的级牌阶梯。两队新建房间时都从阶梯第一级起（DESIGN 1.3） */
export function ladderOf(kind: SjKind): number[] {
  return [...SJ_VARIANTS[kind].ladder];
}

/* ================================================================ 引擎注册表 */

export type AnyRoomState = RoomState | SjRoomState;

/** 房间状态是不是升级。运行时判据只有 kind 一个，客户端服务端共用 */
export function isSjRoom(state: { kind: string }): state is SjRoomState {
  return isSjKind(state.kind);
}

/** Hub 建号时准备好的通用玩家信息，具体怎么落座交给引擎 */
export interface SeatSeed {
  name: string;
  avatar: string;
  tokenHash: string;
  agent: boolean;
  accountId: string;
  /** 炸金花要带上账户里的积分与战绩；升级用不到，传 0 即可 */
  chips: number;
  granted: number;
  wins: number;
}

export interface EngineOpts extends SjEngineOpts {}

/** 一次机器人（或掉线代打）的决定 */
export interface BotMove {
  actorId: string;
  cmd: AnyGameCommand;
  /** 思考时长（毫秒），让机器人别像机器一样瞬发 */
  delay: number;
}

/**
 * 一种游戏对 Hub 暴露的全部能力（DESIGN 2.1）。
 * 定时器的编排留在 Hub 里 —— 两种游戏的节拍表差别太大（DESIGN 2.5），
 * 硬凑成一个接口只会让炸金花那条已经调好的路变形。
 */
export interface GameEngine {
  kind: GameKind;
  meta: GameMeta;
  /** 这个引擎认得的指令名，Hub 用它挡掉乱发的消息 */
  commandTypes(): ReadonlySet<string>;
  create(code: string, seed: SeatSeed): { state: AnyRoomState; playerId: string };
  /** 入座；满员、重复账户之类的拒绝由引擎抛 GameError */
  join(state: AnyRoomState, seed: SeatSeed): string;
  apply(state: AnyRoomState, actorId: string, cmd: AnyGameCommand, opts?: EngineOpts): void;
  sanitize(state: AnyRoomState, viewerId: string): AnyPublicRoom;
  migrate(state: AnyRoomState): AnyRoomState;
  /** 从变更前后两份状态推出这一步该播什么（DESIGN 2.3） */
  deriveEvents(before: AnyRoomState, after: AnyRoomState, actorId: string, cmd: AnyGameCommand | null): GameEvent[];
  /** 现在该不该由机器人替谁行动 */
  bot(state: AnyRoomState, opts?: EngineOpts): BotMove | null;
  /** 当前这一步超时：返回是否真的改变了状态 */
  timeout(state: AnyRoomState, opts?: EngineOpts): boolean;
  transferHost(state: AnyRoomState, departingId?: string): void;
}

const asZ = (s: AnyRoomState) => s as RoomState;
const asS = (s: AnyRoomState) => s as SjRoomState;

/** 机器人"思考"时长。看牌是个小动作，给短一点，避免节奏拖沓。 */
function zjhBotDelay(cmd: GameCommand): number {
  const base = cmd.type === 'look' ? 320 : 620;
  return base + Math.floor(Math.random() * (cmd.type === 'look' ? 260 : 900));
}

/**
 * 炸金花的事件派生。原先写在 `server/rooms.ts` 里、吃的是一份手写快照，
 * 这里改成吃「变更前的完整状态」——多游戏框架下两个引擎必须是同一个签名。
 * 读到的字段和判断逐条照搬，行为零变化。
 */
function deriveZjhEvents(
  before: RoomState, state: RoomState, actorId: string, cmd: GameCommand | null,
): GameEvent[] {
  const events: GameEvent[] = [];
  if (cmd) {
    const spent = state.pot - before.pot;
    if (spent > 0 && (cmd.type === 'call' || cmd.type === 'raise' || cmd.type === 'all_in' || cmd.type === 'compare')) {
      // 表态阶段的「跟注」其实是接梭哈，播报要不一样
      const kind = cmd.type === 'call' && before.allIn ? 'accept' : cmd.type;
      // 比牌额外带上对手和输家：客户端要靠它演「金蓝对撞」那一下。
      // 输家一定是这两个人里刚被判成 folded 的那个（比牌是即时结算的）。
      const extra =
        cmd.type === 'compare'
          ? {
              targetId: cmd.targetId,
              loserId: state.players.find((p) => p.id === actorId)?.status === 'folded' ? actorId : cmd.targetId,
            }
          : {};
      events.push({ k: 'bet', playerId: actorId, amount: spent, kind, ...extra });
    }
    if (cmd.type === 'look') events.push({ k: 'look', playerId: actorId });
    if (cmd.type === 'fold') events.push({ k: 'fold', playerId: actorId });
    if (cmd.type === 'emote') events.push({ k: 'emote', playerId: actorId, id: cmd.id });
  }
  const lastChat = state.chat.at(-1);
  if (lastChat && lastChat.seq > (before.chat.at(-1)?.seq ?? 0)) events.push({ k: 'chat', seq: lastChat.seq });

  if (state.phase === 'playing' && (before.phase !== 'playing' || state.handNo !== before.handNo)) {
    events.push({
      k: 'deal', handNo: state.handNo,
      seats: state.players.filter((p) => p.status === 'active').map((p) => p.seat),
    });
  }
  if (state.phase === 'round_end' && before.phase !== 'round_end' && state.result) {
    if (state.result.revealed.length > 1) events.push({ k: 'showdown', winnerId: state.result.winnerId });
    events.push({ k: 'win', playerId: state.result.winnerId, amount: state.result.potWon });
  }
  if (state.phase === 'playing' && state.turnSeat !== before.turnSeat) {
    const cur = currentPlayer(state);
    if (cur) events.push({ k: 'turn', playerId: cur.id });
  }
  return events;
}

/* ------------------------------------------------------------- 炸金花适配器 */

function zjhEngine(): GameEngine {
  return {
    kind: 'zjh',
    meta: GAME_META.zjh,
    commandTypes: () => COMMAND_TYPES as ReadonlySet<string>,
    create(code, seed) {
      const host = createHumanPlayer(seed.name, seed.avatar, 0, seed.tokenHash, seed.agent);
      host.accountId = seed.accountId;
      host.chips = seed.chips;
      host.granted = seed.granted;
      host.wins = seed.wins;
      return { state: createInitialRoom(code, host), playerId: host.id };
    },
    join(state, seed) {
      const s = asZ(state);
      if (s.players.length >= s.settings.maxPlayers) throw new GameError('房间已满');
      // 同一个账户不该在一张桌子上占两个座位
      if (s.players.some((p) => p.accountId === seed.accountId)) {
        throw new GameError('你已经在这个房间里了，直接用原来的窗口继续', 409);
      }
      const used = new Set(s.players.map((p) => p.seat));
      let seat = 0;
      while (used.has(seat)) seat++;
      let finalName = cleanName(seed.name);
      if (s.players.some((p) => p.name === finalName)) finalName = `${finalName}·${seat + 1}`;
      const player = createHumanPlayer(finalName, cleanAvatar(seed.avatar), seat, seed.tokenHash, seed.agent);
      player.accountId = seed.accountId;
      player.chips = seed.chips;
      player.granted = seed.granted;
      player.wins = seed.wins;
      s.players.push(player);
      claimHostIfVacant(s, player.id);
      const suffix = s.phase === 'playing' ? '，等待下一局' : '';
      // 直接落日志而不是走命令，避免把"加入"塞进游戏状态机
      s.actionSeq += 1;
      s.log.push({ seq: s.actionSeq, at: Date.now(), text: `${player.name} 加入房间${suffix}` });
      return player.id;
    },
    apply: (state, actorId, cmd) => applyCommand(asZ(state), actorId, cmd as GameCommand),
    sanitize: (state, viewerId) => sanitizeRoom(asZ(state), viewerId),
    migrate: (state) => migrateRoom(asZ(state)),
    deriveEvents: (before, after, actorId, cmd) =>
      deriveZjhEvents(asZ(before), asZ(after), actorId, cmd as GameCommand | null),
    bot(state) {
      const s = asZ(state);
      if (s.phase !== 'playing') return null;
      const cur = currentPlayer(s);
      if (!cur?.isBot) return null;
      let cmd: GameCommand;
      try {
        cmd = botDecision(s, cur);
      } catch {
        cmd = { type: 'fold' };
      }
      return { actorId: cur.id, cmd, delay: zjhBotDelay(cmd) };
    },
    timeout: (state) => timeoutCurrentPlayer(asZ(state)),
    transferHost: (state, departingId) => transferHost(asZ(state), departingId),
  };
}

/* --------------------------------------------------------------- 升级适配器 */

const SJ_BOT_MIN_MS = 500;
const SJ_BOT_MAX_MS = 1100;

/** 机器人思考 500–1100ms（DESIGN 2.5） */
function sjBotDelay(): number {
  return SJ_BOT_MIN_MS + Math.floor(Math.random() * (SJ_BOT_MAX_MS - SJ_BOT_MIN_MS));
}

/** 该由电脑替他行动的人：真的电脑，或者掉线的真人（DESIGN 1.9，不等待） */
function sjNeedsBot(p: { isBot: boolean; online: boolean }): boolean {
  return p.isBot || !p.online;
}

function sjEngine(kind: SjKind): GameEngine {
  return {
    kind,
    meta: GAME_META[kind],
    commandTypes: () => SJ_COMMAND_TYPES as ReadonlySet<string>,
    create(code, seed) {
      const host = createSjPlayer(seed.name, seed.avatar, 0, seed.tokenHash, seed.agent);
      host.accountId = seed.accountId;
      return { state: createSjRoom(kind, code, host), playerId: host.id };
    },
    join(state, seed) {
      const s = asS(state);
      if (s.players.length >= SJ_SEATS) throw new GameError('房间已满');
      if (s.players.some((p) => p.accountId === seed.accountId)) {
        throw new GameError('你已经在这个房间里了，直接用原来的窗口继续', 409);
      }
      const used = new Set(s.players.map((p) => p.seat));
      let seat = 0;
      while (used.has(seat)) seat++;
      let finalName = cleanName(seed.name);
      if (s.players.some((p) => p.name === finalName)) finalName = `${finalName}·${seat + 1}`;
      const player = createSjPlayer(finalName, cleanAvatar(seed.avatar), seat, seed.tokenHash, seed.agent);
      player.accountId = seed.accountId;
      s.players.push(player);
      // 全场只剩电脑时房主会空出来，谁进来谁接手
      const host = s.players.find((p) => p.id === s.hostId);
      if (!host || host.isBot) s.hostId = player.id;
      const suffix = s.phase === 'lobby' ? '' : '，等待下一局';
      sjLog(s, `${player.name} 加入房间${suffix}`);
      return player.id;
    },
    apply: (state, actorId, cmd, opts) => applySjCommand(asS(state), actorId, cmd as SjCommand, opts),
    sanitize: (state, viewerId) => sanitizeSjRoom(asS(state), viewerId),
    migrate: (state) => migrateSjRoom(asS(state)),
    deriveEvents: (before, after, actorId, cmd) =>
      deriveSjEvents(asS(before), asS(after), actorId, cmd as SjCommand | null),
    bot(state, opts) {
      const s = asS(state);
      if (s.phase === 'declaring') {
        // 亮主窗口里每个还没表态的电脑各自决定一次：亮得起就亮，否则「不亮」。
        // 只在 declaring 里动 —— dealing 阶段客户端还在播发牌动画，
        // 这时候抢着亮主，牌都还没飞到手上（DESIGN 1.4 / 3.5）。
        for (const p of s.players) {
          if (!sjNeedsBot(p)) continue;
          if (s.trump.declarerId === p.id || s.passed.includes(p.id)) continue;
          const cardIds = botDeclare(s, p);
          return {
            actorId: p.id,
            cmd: cardIds ? { type: 'declare', cardIds } : { type: 'pass' },
            delay: sjBotDelay(),
          };
        }
        return null;
      }
      if (s.phase === 'kou') {
        const dealer = s.players.find((p) => p.seat === s.dealerSeat);
        if (!dealer || !sjNeedsBot(dealer)) return null;
        return { actorId: dealer.id, cmd: { type: 'kou', cardIds: botKou(s, dealer, opts?.rng) }, delay: sjBotDelay() };
      }
      if (s.phase === 'playing') {
        const cur = sjCurrentPlayer(s);
        if (!cur || !sjNeedsBot(cur)) return null;
        return { actorId: cur.id, cmd: { type: 'play', cardIds: botPlay(s, cur, opts?.rng) }, delay: sjBotDelay() };
      }
      return null;
    },
    timeout(state, opts) {
      const s = asS(state);
      if (s.phase === 'kou') {
        timeoutKou(s, opts);
        return true;
      }
      if (s.phase === 'playing') {
        timeoutTurn(s, opts);
        return true;
      }
      return false;
    },
    transferHost: (state, departingId) => transferSjHost(asS(state), departingId),
  };
}

let registry: Record<GameKind, GameEngine> | null = null;

function buildRegistry(): Record<GameKind, GameEngine> {
  return { zjh: zjhEngine(), sj_510k: sjEngine('sj_510k'), sj_2a: sjEngine('sj_2a') };
}

/** 按 kind 取引擎。惰性建表，见文件头关于循环 import 的说明 */
export function engine(kind: GameKind): GameEngine {
  registry ??= buildRegistry();
  const found = registry[kind];
  if (!found) throw new GameError(`未知的游戏类型 ${kind}`, 400);
  return found;
}

/** 房间状态用哪个引擎。老快照没有 kind → 炸金花（DESIGN 2.6） */
export function engineFor(state: { kind?: string }): GameEngine {
  const kind = state.kind && isGameKind(state.kind) ? state.kind : 'zjh';
  return engine(kind);
}
