/**
 * 场景台的构造器（`tests/zjh-scenarios.test.ts` 与 `tests/zjh-mind.test.ts` 共用）。
 *
 * 一个「场景」= 一个钉死的局面：谁在什么位置、拿了什么、本局讲过什么故事、
 * 跨局给人的印象是什么。构造完之后用 `sample()` 跑 N 个 `actionSeq` 种子，
 * 看的是**分布**而不是某一次的决策 —— 「他有时候会诈唬」不是一次决策能证明的事。
 */

import {
  botAction, botDecision, botOffTurn, createHumanPlayer, createInitialRoom, emptyMemory, memoryKey,
  type Card, type GameCommand, type PlayerState, type RoomState,
} from '../shared/game.ts';
import type { Line } from '../shared/zjh/bot/personas/types.ts';
import type { HandEvent } from '../shared/zjh/bot/events.ts';
import { categoryBands } from '../shared/game.ts';

export const c = (rank: number, suit: Card['suit']): Card => ({ rank, suit });

/** 常用手牌，按分位从弱到强。 */
export const HANDS = {
  /** 散牌 2/4/7，分位 ~0.02 */
  trash: [c(2, 'S'), c(4, 'H'), c(7, 'D')],
  /** 小顺子 3-4-5，分位落在顺子档下沿 */
  smallStraight: [c(3, 'S'), c(4, 'H'), c(5, 'D')],
  /** 大顺子 9-10-J，分位落在顺子档上沿 */
  bigStraight: [c(9, 'S'), c(10, 'H'), c(11, 'D')],
  /** 中等金花 J 高 */
  midFlush: [c(11, 'H'), c(8, 'H'), c(5, 'H')],
  /** K 高金花 */
  kFlush: [c(13, 'H'), c(9, 'H'), c(4, 'H')],
  /** A 高金花（金花档最上沿） */
  aFlush: [c(14, 'H'), c(13, 'H'), c(11, 'H')],
  /** 顺金 */
  straightFlush: [c(9, 'C'), c(10, 'C'), c(11, 'C')],
  /** 豹子 */
  trips: [c(14, 'S'), c(14, 'H'), c(14, 'D')],

  /*
   * 下面五手是 2026-09-04 发牌分布回调（四类大牌 92% → 26%）之后补的**同分位替身**。
   *
   * 场景台里绝大多数断言说的不是「他手里是不是金花」，而是「他手里这一手在这张桌子上
   * 排第几」——「中等牌面对紧手的连加要弃」「弱牌在后位可以偷池」。牌型带宽一改，
   * 同样的牌就换了位置：J 高金花从 62 分位跳到 92 分位，小顺子从 13 跳到 76。
   * 拿着新的 92 分位去断言「要弃」是错的，那一手现在真的很强。
   *
   * 所以按**旧带里的分位**给每个角色配一手新牌，误差都在 0.005 以内：
   *   旧「中等顺子」0.291 → 10 高散牌 0.291
   *   旧「小顺子」  0.133 → 5 高散牌 0.127
   *   旧「J 高金花」0.619 → 一对 3 带 10  0.619
   *   旧「K 高金花」0.668 → 一对 7 带 Q   0.667
   *   旧「A 高金花」0.735 → 一对 K 带 10  0.736
   */

  /** 5/4/2 散牌，分位 0.127 —— 旧带里「小顺子」的位置（弱牌） */
  smallJunk: [c(5, 'S'), c(4, 'H'), c(2, 'D')],
  /** 10/3/2 散牌，分位 0.291 —— 旧带里「中等顺子」的位置（中下牌） */
  midJunk: [c(10, 'S'), c(3, 'H'), c(2, 'D')],
  /** 一对 3 带 10，分位 0.619 —— 旧带里「J 高金花」的位置（中等牌） */
  smallPair: [c(3, 'S'), c(3, 'H'), c(10, 'D')],
  /** 一对 7 带 Q，分位 0.667 —— 旧带里「K 高金花」的位置（中上牌） */
  midPair: [c(7, 'S'), c(7, 'H'), c(12, 'D')],
  /** 一对 K 带 10，分位 0.736 —— 旧带里「A 高金花」的位置（强牌，但不是顶牌） */
  kingPair: [c(13, 'S'), c(13, 'H'), c(10, 'D')],
} satisfies Record<string, Card[]>;

/* --------------------------------------------------------------- 构造器 */

export interface SeatSpec {
  name: string;
  hand?: Card[];
  looked?: boolean;
  bet?: number;
  chips?: number;
  /** 本局做过什么（事件流）。写法见 `ev` */
  events?: HandEvent[];
  /** 跨局印象：写进长期档案，决定他在似然表里被当成什么人 */
  profile?: 'tight' | 'maniac' | 'unknown';
  /** 跨局的「面对梭哈接了几次」（§4.6 发起端要的那个统计） */
  accept?: { faced: number; taken: number };
}

export interface SceneSpec {
  /** 座位 0 永远是被测的机器人 */
  me: SeatSpec;
  others: SeatSpec[];
  pot: number;
  betUnit?: number;
  roundNo?: number;
  turnCount?: number;
  /** 让机器人排在最后一位（后位）还是第一位 */
  position?: 'early' | 'late';
  compareUnlockAt?: number;
  allIn?: { initiator: string; accepted: string[]; base: number };
  /** 机器人比牌时看到过谁的底牌（S20） */
  seen?: string[];
}

/** 一个公开事件。`u` 是当时的单价档。 */
export function ev(kind: HandEvent['kind'], looked: boolean, unit: number, roundNo = 1): HandEvent {
  return { kind, looked, unit, roundNo, at: 0 };
}

/**
 * 跨局印象。
 *
 * `tight` = 打得少、亮牌都很硬 → 可信度高，他的加注就是亮牌；
 * `maniac` = 一晚上都在开火、被抓过两次 → 可信度低，他的梭哈什么都不是。
 */
export function profileFor(key: string, kind: NonNullable<SeatSpec['profile']>) {
  const mem = emptyMemory(key);
  if (kind === 'tight') {
    Object.assign(mem, {
      hands: 40, played: 8, aggressive: 6, passive: 10,
      pressureFaced: 20, foldsToPressure: 16, showdowns: 6, showdownStrength: 6 * 0.86, bluffsCaught: 0,
    });
  } else if (kind === 'maniac') {
    Object.assign(mem, {
      hands: 40, played: 36, aggressive: 60, passive: 12,
      pressureFaced: 24, foldsToPressure: 3, showdowns: 12, showdownStrength: 12 * 0.34, bluffsCaught: 4,
    });
  }
  return mem;
}

export function scene(spec: SceneSpec): { room: RoomState; bot: PlayerState; by: (name: string) => PlayerState } {
  const seats = [spec.me, ...spec.others];
  const host = createHumanPlayer(seats[0].name, '🐯', 0, 's0');
  const room = createInitialRoom('SCENE1', host);
  host.isBot = true;
  for (let i = 1; i < seats.length; i++) {
    room.players.push(createHumanPlayer(seats[i].name, '🦊', i, `s${i}`));
  }
  // `createHumanPlayer` 的 id 是随机的，而机器人的掷骰子以 id 做种 ——
  // 不钉死的话同一个场景每跑一次进程就换一条随机流，200 个种子的分布也跟着飘。
  // 场景台要的是**同一个人在同一个局面**，所以这里把 id 固定成座次。
  for (const [i, p] of room.players.entries()) p.id = `s${i}`;
  room.hostId = host.id;
  room.phase = 'playing';
  room.handNo = 7;
  room.roundNo = spec.roundNo ?? 1;
  room.turnCount = spec.turnCount ?? seats.length;
  room.pot = spec.pot;
  room.betUnit = spec.betUnit ?? room.settings.betOptions[0];
  room.compareUnlockAt = spec.compareUnlockAt ?? 0;
  room.memory = {};

  for (const [i, s] of seats.entries()) {
    const p = room.players[i];
    p.status = 'active';
    p.hand = s.hand ?? [];
    p.looked = s.looked ?? false;
    p.bet = s.bet ?? room.settings.ante;
    p.chips = s.chips ?? room.settings.startingChips;
    p.handActions = s.events ?? [];
    if (s.profile && s.profile !== 'unknown') room.memory[memoryKey(p)] = profileFor(memoryKey(p), s.profile);
    if (s.accept) {
      const mem = room.memory[memoryKey(p)] ?? (room.memory[memoryKey(p)] = emptyMemory(memoryKey(p)));
      mem.hands = Math.max(mem.hands, s.accept.faced);
      mem.allInFaced = s.accept.faced;
      mem.allInTaken = s.accept.taken;
    }
  }

  const bot = room.players[0];
  room.turnSeat = bot.seat;
  // 位置只看座次（M5 修好之后）：把 firstActorSeat 放在自己身上就是首家，放在下一家就是末家。
  room.firstActorSeat = spec.position === 'late'
    ? (bot.seat + 1) % room.settings.maxPlayers
    : bot.seat;

  if (spec.allIn) {
    const initiator = room.players.find((p) => p.name === spec.allIn!.initiator)!;
    const accepted = [initiator.id, ...spec.allIn.accepted.map((n) => room.players.find((p) => p.name === n)!.id)];
    room.allIn = {
      initiatorId: initiator.id,
      initiatorName: initiator.name,
      base: spec.allIn.base,
      amount: spec.allIn.base * (initiator.looked ? 2 : 1),
      pending: room.players.filter((p) => p.id !== initiator.id && p.status === 'active').map((p) => p.id),
      accepted,
    };
  }
  if (spec.seen?.length) {
    room.seen = { [bot.id]: spec.seen.map((n) => room.players.find((p) => p.name === n)!.id) };
  }
  return { room, bot, by: (name) => room.players.find((p) => p.name === name)! };
}

/**
 * 跑 N 个种子，统计动作分布。
 *
 * 每个种子当成**另一局**（`handNo` 也跟着变，不只是 `actionSeq`）：
 * §4.4 的线路种子是 `${bot.id}:${handNo}:${planPoint}`，故意不含 `actionSeq`，
 * 只变 `actionSeq` 的话 200 个样本抽到的是同一条线，量出来的是那条线的天花板，
 * 不是「同一个局面下这个人会怎么打」的分布。
 */
export function sample(room: RoomState, bot: PlayerState, seeds = 200): GameCommand[] {
  const out: GameCommand[] = [];
  for (let seq = 0; seq < seeds; seq++) {
    const copy = structuredClone(room); copy.actionSeq = seq; copy.handNo = (room.handNo ?? 0) + seq;
    out.push(botDecision(copy, copy.players.find(p => p.id === bot.id)!));
  }
  return out;
}

/**
 * 跑 N 个种子，连**这一局他打算走哪条线**一起记下来（§4.4）。
 *
 * 有些场景问的不是「他会干什么」，而是「打算这么干的人，会不会真的这么干」——
 * S1 的「闷压」、S15 的「收口」都是这种：线路是开局定的，同一个局面里
 * 抽到别的线路的那些手当然会打成别的样子，把它们混进同一个比例里就什么也测不出来。
 */
export function sampleWithPlan(
  room: RoomState, bot: PlayerState, seeds = 200,
): { cmd: GameCommand; line: Line }[] {
  const out: { cmd: GameCommand; line: Line }[] = [];
  for (let seq = 0; seq < seeds; seq++) {
    const copy = structuredClone(room); copy.actionSeq = seq; copy.handNo = (room.handNo ?? 0) + seq;
    const act = botAction(copy, copy.players.find(p => p.id === bot.id)!);
    out.push({ cmd: act.cmd, line: act.plan!.line });
  }
  return out;
}

/** 只挑走某一条线路的那些手。 */
export const onLine = (rows: { cmd: GameCommand; line: Line }[], line: Line) =>
  rows.filter((r) => r.line === line).map((r) => r.cmd);

export const share = (cmds: (GameCommand | null)[], pred: (c: GameCommand | null) => boolean) =>
  cmds.filter(pred).length / Math.max(1, cmds.length);

/**
 * 跑 N 个种子，统计**非回合**动作（§4.6）。
 * 行动权先交给下一家 —— 测的正是「还没轮到他」的那一刻他会不会先动手。
 * `null` = 按兵不动。
 */
export function sampleOffTurn(room: RoomState, bot: PlayerState, seeds = 200): (GameCommand | null)[] {
  const away = room.players.find((p) => p.id !== bot.id && p.status === 'active')!;
  const turn = room.turnSeat;
  const hand0 = room.handNo ?? 0;
  room.turnSeat = away.seat;
  const out: (GameCommand | null)[] = [];
  for (let seq = 0; seq < seeds; seq++) {
    room.actionSeq = seq; room.handNo = hand0 + seq;   // 同 `sample`：每个种子是另一局
    out.push(botOffTurn(room, bot)?.cmd ?? null);
  }
  room.turnSeat = turn; room.handNo = hand0;
  return out;
}

export const tally = (cmds: (GameCommand | null)[]) => {
  const out: Record<string, number> = {};
  for (const c of cmds) out[c?.type ?? '按兵不动'] = (out[c?.type ?? '按兵不动'] ?? 0) + 1;
  return out;
};

/* ------------------------------------------------------------ 牌型分位带 */

/**
 * 标准档的牌型分位带（`shared/game.ts` 的 `categoryBands('standard')`）。
 *
 * 2026-09-04 集成时补：两条人物卡线都是在**旧发牌**（四类大牌 92%）上量的，
 * 那一版的带是 散牌[0,.05] 对子[.05,.08] 顺子[.08,.37] 金花[.37,.75] 顺金[.75,.87] 豹子[.87,1]，
 * 于是测试里写满了 `strength < 0.37`（金花以下）、`>= 0.75`（顺金以上）这样的字面量。
 * 发牌回调之后同样的数字指的是完全不同的牌：0.37 在标准档里是**散牌**。
 *
 * 所以这里把「牌型线」一次性从 `categoryBands` 取出来，测试里只写名字不写数字：
 * 以后再改发牌分布，带子自己跟着走，断言的**语义**不变。
 * 只取标准档 —— §6.4 与八张卡的 (a)–(d) 都只在标准档判（设计文档 §6.4 末尾）。
 */
export const BANDS = categoryBands('standard');

/** 对子档下沿 = 散牌上沿（0.60）。「散牌」= 分位 < 这条线。 */
export const PAIR_LO = BANDS[2][0];
/** 顺子档下沿 = 对子上沿（0.74）。 */
export const STRAIGHT_LO = BANDS[3][0];
/** 金花档下沿 = 顺子上沿（0.84）。「金花以下」= 分位 < 这条线。 */
export const FLUSH_LO = BANDS[4][0];
/** 顺金档下沿 = 金花上沿（0.96）。「顺金以上」= 分位 ≥ 这条线。 */
export const SF_LO = BANDS[5][0];
/** 豹子档下沿（0.978）。 */
export const TRIPS_LO = BANDS[6][0];
