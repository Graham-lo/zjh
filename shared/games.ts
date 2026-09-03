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
  applyCommand, botAction, claimHostIfVacant, cleanAvatar, cleanName, COMMAND_TYPES,
  evictBotForHuman,
  createHumanPlayer, createInitialRoom, currentPlayer, GameError, migrateRoom, sanitizeRoom,
  timeoutCurrentPlayer, transferHost,
  type GameCommand, type RoomState,
} from './game.ts';
import type { AnyGameCommand, AnyPublicRoom, GameEvent } from './protocol.ts';
import {
  applySjCommand, createSjPlayer, createSjRoom, deriveSjEvents, migrateSjRoom, sanitizeSjRoom,
  SJ_COMMAND_TYPES, SJ_DEAL_CARD_MS, SJ_SEATS, sjCurrentPlayer, sjLog, timeoutChao, timeoutKou,
  timeoutTurn, transferSjHost,
  type SjCommand, type SjEngineOpts, type SjPhase, type SjRoomState,
} from './sj/engine.ts';
import { botChao, botDeclare, botKou, botPlay, botThinkMs, planSjDealingDeclare } from './sj/bot.ts';

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
/**
 * 思考时长现在由引擎给：它知道这一步有多难、这台电脑是什么性格、有没有在上头。
 * 这里只加一点点抖动，免得同一个局面每次都是分毫不差的同一个数。
 */
function zjhBotDelay(thinkMs: number): number {
  return Math.max(220, Math.round(thinkMs * (0.9 + Math.random() * 0.2)));
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
      // 同一个账户不该在一张桌子上占两个座位（这一条要排在让座前面，
      // 否则重复点链接会白白赶走一台电脑）
      if (s.players.some((p) => p.accountId === seed.accountId)) {
        throw new GameError('你已经在这个房间里了，直接用原来的窗口继续', 409);
      }
      // 坐满了先看看是不是坐满了「人」：有电脑就让电脑腾位置，
      // 六个座位全是真人才谈得上房间已满。
      let vacated: number | null = null;
      if (s.players.length >= s.settings.maxPlayers) {
        vacated = evictBotForHuman(s);
        if (vacated === null) throw new GameError('房间已满');
      }
      const used = new Set(s.players.map((p) => p.seat));
      let seat = vacated ?? 0;
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
      let thinkMs: number;
      try {
        ({ cmd, thinkMs } = botAction(s, cur));
      } catch {
        cmd = { type: 'fold' };
        thinkMs = 500;
      }
      return { actorId: cur.id, cmd, delay: zjhBotDelay(thinkMs) };
    },
    timeout: (state) => timeoutCurrentPlayer(asZ(state)),
    transferHost: (state, departingId) => transferHost(asZ(state), departingId),
  };
}

/* --------------------------------------------------------------- 升级适配器 */

/** 看到牌到反应过来要亮，200–600ms（BRAIN-DESIGN §7） */
const SJ_REACT_MIN_MS = 200;
const SJ_REACT_MAX_MS = 400;

/** 表态类动作（亮主 / 不亮 / 抄底）的思考时长 */
function sjSayDelay(s: SjRoomState, rng?: () => number): number {
  const r = rng ? rng() : Math.random();
  const cap = Math.max(600, s.settings.turnSeconds * 1000 / 2 - 200);
  return Math.min(cap, Math.round(600 + r * 900));
}

/** 扣底要挑 8 张，慢一点才像在想（BRAIN-DESIGN §7：3–6s） */
function sjKouDelay(s: SjRoomState, rng?: () => number): number {
  const r = rng ? rng() : Math.random();
  const cap = Math.max(600, s.settings.turnSeconds * 1000 / 2 - 200);
  return Math.min(cap, Math.round(3000 + r * 3000));
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
      if (s.players.some((p) => p.accountId === seed.accountId)) {
        throw new GameError('你已经在这个房间里了，直接用原来的窗口继续', 409);
      }
      /**
       * 和炸金花一样：坐满了先看看坐满的是不是真人，有电脑就让电脑腾位置。
       *
       * 但升级只有四个座位、还分对家，牌一发下去把一家换成新人这局就没法打了，
       * 所以牌局进行中只说实话 ——「本局结束后才有位置」，而不是含糊的「房间已满」。
       */
      let vacated: number | null = null;
      if (s.players.length >= SJ_SEATS) {
        const bot = s.players.filter((p) => p.isBot).sort((a, b) => a.seat - b.seat)[0];
        if (!bot) throw new GameError('房间已满');
        const between: SjPhase[] = ['lobby', 'hand_end', 'match_end'];
        if (!between.includes(s.phase)) throw new GameError('本局进行中，等这一局打完就有位置');
        vacated = bot.seat;
        s.players = s.players.filter((p) => p.id !== bot.id);
        sjLog(s, `${bot.name} 离开房间，把位置让给新玩家`);
      }
      const used = new Set(s.players.map((p) => p.seat));
      let seat = vacated ?? 0;
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
      if (s.phase === 'dealing') {
        // 真人是**边发边亮**的：牌一张一张进手，某一张让手里够档了就拍下去。
        // 所以电脑也只看已经到手的前缀来决定，并把 delay 排到"那张牌到手 + 反应时间"
        // （BRAIN-DESIGN §5.1）。谁的那一刻最早谁先亮，和真人抢亮是一回事。
        if (s.dealStartedAt == null) return null;
        let best: BotMove | null = null;
        let bestAt = Infinity;
        for (const p of s.players) {
          if (!sjNeedsBot(p)) continue;
          if (s.trump.declarerId === p.id) continue;
          const plan = planSjDealingDeclare(s, p);
          if (!plan) continue;
          const r = opts?.rng ? opts.rng() : Math.random();
          const at = s.dealStartedAt + (plan.index + 1) * SJ_DEAL_CARD_MS
            + SJ_REACT_MIN_MS + Math.round(r * SJ_REACT_MAX_MS);
          if (at < bestAt) {
            bestAt = at;
            best = { actorId: p.id, cmd: { type: 'declare', cardIds: plan.cardIds }, delay: 0 };
          }
        }
        // 已经过点了就立刻出手（例如刚重连回来），但不早于牌到手的那一刻
        if (best) best.delay = Math.max(0, bestAt - (opts?.now ?? Date.now()));
        return best;
      }
      if (s.phase === 'declaring') {
        // 发完牌还有个安静窗口：这时"等着反 / 等着抄"的人得自己兜底亮了（§5.1）。
        for (const p of s.players) {
          if (!sjNeedsBot(p)) continue;
          if (s.trump.declarerId === p.id || s.passed.includes(p.id)) continue;
          const cardIds = botDeclare(s, p);
          return {
            actorId: p.id,
            cmd: cardIds ? { type: 'declare', cardIds } : { type: 'pass' },
            delay: sjSayDelay(s, opts?.rng),
          };
        }
        return null;
      }
      if (s.phase === 'kou') {
        // 抄底之后扣底的不一定是庄家（DESIGN 1.4b），一律看 kouSeat
        const burier = s.players.find((p) => p.seat === s.kouSeat);
        if (!burier || !sjNeedsBot(burier)) return null;
        return { actorId: burier.id, cmd: { type: 'kou', cardIds: botKou(s, burier, opts?.rng) }, delay: sjKouDelay(s, opts?.rng) };
      }
      if (s.phase === 'chao') {
        // 被问到的人是电脑或掉线的真人就替他答；抄不起就「不抄」，别让一轮询问卡住
        const asked = s.players.find((p) => p.seat === s.chaoSeat);
        if (!asked || !sjNeedsBot(asked)) return null;
        const cardIds = botChao(s, asked);
        return {
          actorId: asked.id,
          cmd: cardIds ? { type: 'chao', cardIds } : { type: 'pass_chao' },
          delay: sjSayDelay(s, opts?.rng),
        };
      }
      if (s.phase === 'playing') {
        const cur = sjCurrentPlayer(s);
        if (!cur || !sjNeedsBot(cur)) return null;
        return { actorId: cur.id, cmd: { type: 'play', cardIds: botPlay(s, cur, opts?.rng) }, delay: botThinkMs(s, cur, opts?.rng) };
      }
      return null;
    },
    timeout(state, opts) {
      const s = asS(state);
      if (s.phase === 'kou') {
        timeoutKou(s, opts);
        return true;
      }
      if (s.phase === 'chao') {
        timeoutChao(s, opts);
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
