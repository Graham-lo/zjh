import { emptyPublicStats, observePublic, type PublicStats } from './zjh/bot/learned.ts';
import { socialKey } from './zjh/bot/profile.ts';
/**
 * 炸金花游戏内核。
 *
 * 这个文件刻意保持与运行时无关：只用 Node / 浏览器 / Workers 都有的全局
 * (crypto.getRandomValues、structuredClone)，不 import 任何服务端模块。
 * 服务器把它当纯函数状态机用，测试直接跑它，客户端复用它的类型和赔率计算。
 */

import {
  normalizeHandActions, unitTier, type HandActionKind, type HandEvent,
} from './zjh/bot/events.ts';
import {
  bucketKey, editBucket, emptyMemory, memoryKey, mergeLegacyRead, toTableRead,
  type BotMemory, type MemoryBucket,
} from './zjh/bot/profile.ts';
import { botAction, botDecision, botOffTurn, personaFor } from './zjh/bot/index.ts';
import { tiltFactor } from './zjh/bot/personas/index.ts';
import { emotionChannels, readMind, type MindState } from './mind/emotion.ts';
import { emoteFor } from './zjh/bot/tempo.ts';
import { settle } from './mind/regularities.ts';

/**
 * 机器人大脑住在 `shared/zjh/bot/`（设计文档 §4.1）。这里只做转发，
 * 让 `shared/game.ts` 回到「纯状态机 + 记账」的本分。
 */
export { botAction, botDecision, botOffTurn };
export type { BotAction } from './zjh/bot/index.ts';
export type { HandEvent } from './zjh/bot/events.ts';
export { memoryKey, mergeMemory, emptyMemory, toTableRead } from './zjh/bot/profile.ts';
export type { BotMemory } from './zjh/bot/profile.ts';

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
  /**
   * 封顶轮数：到达后强制全员开牌。**0 = 不封顶**，一直打到分出胜负为止。
   *
   * 不封顶不等于会打不完：底注升到最高档之后每轮翻倍（见 advanceTurn），
   * 筹码是有限的，所以每个人在有限几轮内一定会被逼到「全押跟或者弃牌」。
   * 收敛靠的是经济压力，不是一刀切的轮数。
   */
  maxRounds: number;
  /** 从第几轮开始每轮自动升一档底注，0 表示关闭 */
  escalateFrom: number;
  /** 单步行动时限（秒），超时自动弃牌 */
  turnSeconds: number;
  /** 本局结束后自动开下一局（所有在线玩家仍处于准备状态时） */
  autoContinue: boolean;
  /** 第几轮起才允许梭哈。**没有例外**：钱不够跟注的人不能梭哈，只能全押跟 / 全押比牌 / 弃牌 */
  allInFromRound: number;
  /**
   * 发牌档位（房主可调，**下一局生效**）。
   *
   * 它不只是发牌：牌力分位、机器人的范围先验和桶边界全部跟着这一档走
   * （`categoryBands` / `range.ts`），所以一桌只能有一档，中途也不在一局里换。
   */
  dealMode: DealMode;
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
  /**
   * 本局是**谁**把他打下去的（`docs/zjh/personas.md`「待集成」#14）。
   *
   * 只有牌面上真的把人淘汰掉的那两条路会写它：开比牌赢了他的人、他接下的那一手
   * 梭哈的发起人。自己主动弃牌不写 —— 那是自己走的，不是被谁打下去的。
   *
   * 为什么不能拿「这一手的赢家」代替：比牌把他打下去的那个人，后面可能又输给了
   * 第三个人；实测「把他比掉的人 == 赢家」只有 62.5%，也就是三分之一的仇记错了人。
   * 这个字段随 `RoundResult.knockedOutBy` 带出结算，`settleMinds` 按它归因。
   */
  knockedOutBy?: string;
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
  /** 本局已投入（累计出资），用于座位上的筹码显示，也是边池分层的依据 */
  bet: number;
  /**
   * 已经把筹码推光，本局不能再出资了。
   *
   * 「跟不起就只能弃牌」是最伤人的一种设计：手里还有钱、牌也还在，却因为台面单价
   * 涨过了身家而被剥夺继续打的权利。真实牌桌上没有这条规矩 —— 钱不够就把剩下的
   * 全推出去（「全押跟」），动作还是那个动作，只是金额封到自己的全部身家，
   * 之后不再被要求出资、轮到他自动跳过，但人还在局里等结算。
   *
   * 结算时靠 `bet`（累计出资）分层做边池：他只能赢下自己出资覆盖到的那几层，
   * 押得比他多的人在更高的层里另分胜负。
   */
  allIn?: boolean;
  wins: number;
  tokenHash?: string;
  pendingLeave?: boolean;
  lastAction?: string;
  /**
   * 本局到目前为止的**事件流**。
   *
   * 只有 lastAction 是看不懂牌的：连加两手和「加一手之后缩回去只跟」是完全相反的两个故事，
   * 但最后一个动作都是「跟」。机器人要读故事，就得看整串 —— 而且要连当时的处境一起看：
   * 闷牌加注和看牌加注是两句完全不同的话（见 `HandEvent`）。全是公开动作，不含暗牌信息。
   */
  handActions?: HandEvent[];
  /**
   * 上头程度，−1 到 1，只有电脑玩家有。
   *
   * 正数是输了大钱之后想追回来（放宽起手、加注变凶、诈唬变多），
   * 负数是刚被抓或者刚赢了一大笔之后想守住（收紧、少冒险）。
   * 每局按 0.72 衰减，大概三局回到常态 —— 真人的情绪也差不多是这个尺度。
   */
  tilt?: number;
  /** 最近一次表情，客户端用来播浮动动画 */
  /**
   * `target` = 这个表情是**冲着谁**做的（`docs/zjh/personas.md`「待集成」#10）。
   * 复仇者阿彪卡上写的是「表情针对仇人 😂」，没有落点字段这句话就落不了地。
   * 可选：真人发的表情没有落点，UI 也不读它，只有机器人和统计用得上。
   */
  emote?: { id: string; at: number; target?: string };
  /** 这一局已经发过几个表情（`EmotePolicy.cap` 的计数，每局清零） */
  emoted?: number;
}

/**
 * 一个玩家的**公开**打法笔记，跨局累积。
 *
 * 每一项都只来自桌面上人人都能看到的东西：他做过的动作，以及摊牌时亮出来的牌。
 * 暗牌永远不进这里 —— 这和真人坐在桌边记牌是同一回事，不是开天眼。
 */
export interface TableRead {
  publicStats?: PublicStats;
  recent?: TableRead[];
  /** 参与过的局数 */
  hands: number;
  /** 其中没有在第一时间弃牌、真的投钱打下去的局数 → 起手范围松紧 */
  played: number;
  /** 加注 / 梭哈 / 比牌的次数 → 攻击性 */
  aggressive: number;
  /** 跟注次数 → 被动程度 */
  passive: number;
  /** 面对加注或梭哈的次数 */
  pressureFaced: number;
  /** 其中选择弃牌的次数 → 吓不吓得走 */
  foldsToPressure: number;
  /** 亮过牌的次数 */
  showdowns: number;
  /** 亮牌时的牌力之和，除以 showdowns 就是「他敢摊出来的牌一般有多硬」 */
  showdownStrength: number;
  /** 亮牌时牌力很差、也就是被抓到在吹的次数 */
  bluffsCaught: number;
  /**
   * 面对**别人发起的梭哈**、需要表态的次数，以及其中真的接下来的次数（设计文档 §4.6）。
   * 「他吓不吓得走」和「他敢不敢接梭哈」不是一回事：一口 5 万的加注跑掉的人，
   * 面对推光身家反而可能上头就接。发起端要用的是这一栏，不是 `foldsToPressure`。
   * 老快照里没有这两项，读的时候一律 `?? 0`。
   */
  allInFaced?: number;
  allInTaken?: number;
}

export interface LogEntry {
  seq: number;
  at: number;
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
  /**
   * 被淘汰的人 → 把他打下去的那个人（比牌赢他的人 / 他接下的那手梭哈的发起人）。
   * 没有条目的人就是「输给了赢家」或自己弃的牌，归因回落到 `winnerId`。
   */
  knockedOutBy: Record<string, string>;
}

export interface RoomState {
  /** 房间类型。多游戏框架靠它派发引擎（DESIGN 2.1）；炸金花永远是 'zjh' */
  kind: 'zjh';
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
  createdAt: number;
  /** 全服筹码基线的一次性迁移版本，防止每次重启重复补发。 */
  chipGrantVersion: number;
  /** 底注/加注档位的一次性迁移版本。 */
  economyVersion: number;
  /**
   * 定向可见：seen[观看者id] = 他有权看到底牌的玩家 id 列表。
   * 比牌是两个人之间的事 —— 双方互相看到对方的牌，没参与的人什么都看不到，
   * 这和真实牌桌一致。全桌公开的摊牌走 result.revealed，两者互不干扰。
   */
  seen?: Record<string, string[]>;
  /** 有人梭哈后等待其他玩家表态；只有接受的人才会进入开牌 */
  allIn?: PendingAllIn;
  result?: RoundResult;
  /**
   * 下一件事会自动发生的时刻（毫秒时间戳）。
   *
   * 结算阶段是「什么时候自动回到准备」，准备阶段是「什么时候自动开下一局」。
   * 有了它客户端才能把「稍后自动开始」写成一个真的在跳的秒数 —— 光写「稍后」，
   * 不是房主的人坐在结算面板前面只会觉得卡住了，除了退出房间没别的可点。
   */
  nextAt?: number;
  /**
   * @deprecated 旧版的房内笔记，key 是**房内 id**，换个房间这个人就重新是陌生人。
   * 已被 `memory` 取代；只在 `migrateRoom` 里被一次性并进长期档案，之后就删掉。
   */
  reads?: Record<string, TableRead>;
  /**
   * 跨局累积的长期档案，key 见 `memoryKey`（真人按账户、机器人按名字）。
   *
   * 只喂给电脑玩家，既不下发给客户端（`sanitizeRoom` 剥掉），也不跟着房间快照
   * 一起存（`store.save` 剥掉）—— 它有自己的表，生命周期比房间长。
   * 内容全部来自公开信息，见 TableRead / BotMemory。
   */
  memory?: Record<string, BotMemory>;
}

/** 一次梭哈的表态过程 */
export interface PendingAllIn {
  initiatorId: string;
  initiatorName: string;
  /**
   * 梭哈的**闷牌单价**，发起时定死，之后**永远不变**。每家实际要掏
   * `base * (looked ? 2 : 1)` —— 和跟注、加注、比牌一样的 1:2 定价，
   * 闷牌半价、看牌双倍。
   *
   * 主流玩法里梭哈就是发起人推光自己，所以 `base = ceil(amount / 他的倍率)`：
   * 闷牌的人一份就是全部身家，看牌的人一份是身家的一半（他要掏两份）。
   * 别人接不接得起是别人的事 —— 掏不动就按 `pay` 夹到全部筹码，边池分层结算。
   */
  base: number;
  /**
   * **发起人押上的金额，也就是他的全部筹码**。用于播报「XX 梭哈了 890」。
   * **不要拿它当成每家要付的数** —— 别人按自己的倍率算，闷牌一份、看牌两份。
   */
  amount: number;
  /** 还没表态的玩家 id，按行动顺序 */
  pending: string[];
  /** 已经接受（含发起人）的玩家 id */
  accepted: string[];
}

export const DEFAULT_SETTINGS: GameSettings = {
  maxPlayers: 6,
  startingChips: 500_000,
  ante: 1_000,
  // 第一个是开局的底注档，其余是可选的加注档
  betOptions: [1_000, 20_000, 50_000, 100_000],
  special235: true,
  // 不封顶：牌就该打到真的分出胜负，而不是数到第 8 轮被系统掀桌子
  maxRounds: 0,
  escalateFrom: 3,
  turnSeconds: 30,
  autoContinue: true,
  allInFromRound: 3,
  // 默认标准档：娱乐增强是房主主动打开的一个「今晚图热闹」的开关，不是默认体验
  dealMode: 'standard',
};

/** 版本每提升一次，旧房间/旧账户会在保持净战绩不变的前提下补到当前筹码基线。 */
export const CHIP_GRANT_VERSION = 1;
export const ZJH_ECONOMY_VERSION = 1;

/** 结算面板停留多久之后自动回到准备阶段。服务端计时，客户端拿来显示倒计时。 */
export const ROUND_END_MS = 10_500;
/** 回到准备阶段之后，满足自动续局条件时再等多久开下一局。 */
export const AUTO_START_MS = 2_500;

export const AVATARS = ['🐯', '🦊', '🐼', '🐵', '🐸', '🦁', '🐺', '🐷', '🐨', '🦉', '🐲', '🦄'];
export const EMOTES = ['👍', '😂', '😱', '🤔', '🔥', '💰', '🙏', '😭'];

/**
 * 事件流的时刻戳。
 *
 * 事件的先后是**读牌的全部依据**（`feel.ts` 把各家的 `handActions` 按 `at` 归并成一条流，
 * 游标按条数往前走）。真人打牌两个动作之间隔着秒，`Date.now()` 够用；但机器人自对弈
 * 一毫秒里能走完一整轮，同一毫秒里的动作按 `at` 排就变成了「按 `state.players`
 * 的数组顺序排」—— 而一轮的实际发言顺序是从首家开始轮转的，两者不一致。
 * 于是同一个种子跑两遍，归并出来的事件流不一样，读牌结果也不一样
 * （实测 §6.2 探针「对岩石的弱牌弃牌率」在 83.8%–87.5% 之间漂）。
 *
 * 这里保证时刻戳在进程内**严格递增**：拿到的还是毫秒时刻（语义没变、不需要迁移、
 * 旧快照照读），但同一毫秒里的多个动作会被摊成 +1ms，先后顺序就是真实动作顺序。
 */
let lastEventAt = 0;
export function eventTime(): number {
  lastEventAt = Math.max(Date.now(), lastEventAt + 1);
  return lastEventAt;
}

/**
 * 一桌能坐的电脑就是 §4.7.3 名册上这八个人，顺序即 `PERSONAS` 的顺序。
 * 名字就是身份：这里加名字必须同时有一张手写卡（`shared/zjh/bot/personas/`），
 * 否则 `personaFor` 会把他退回常人卡 —— 那是个没人认得出来的人。
 */
export const BOT_NAMES = ['阿凯', '老陈', '小北', '阿杰', '小林', '老王', '小雨', '阿彪'];
const BOT_AVATARS = ['🤖', '👾', '🎩', '🕶️', '🎯', '🃏', '🌧️', '🐯'];

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

/* --------------------------------------------------------- 娱乐增强发牌 */

/**
 * 发牌档位。房主选，整桌共用，**下一局生效**。
 *
 * - `standard`（默认）：四类大牌合计 26%，散牌重新是桌面的底色；
 * - `party`（娱乐增强）：四类大牌合计 54%，为「就想热闹」的朋友局准备。
 */
export type DealMode = 'standard' | 'party';

export interface HandDistribution {
  flush: number;
  straight: number;
  trips: number;
  straightFlush: number;
  highCard: number;
  pair: number;
}

/**
 * 两档发牌的目标牌型（千分比）。
 *
 * 真实 52 选 3 的频率是：散牌 744、对子 169、顺子 33、金花 50、顺金 2.2、豹子 2.4
 * （四类大牌合计 8.8%）。最早那一版为了「热闹」把四类大牌拉到 92%，结果是桌上人手一副
 * 金花以上，大牌不再是事件、比牌没有落差，玩家反馈体验超标。
 *
 * **standard**：四类大牌合计压到 **26%**，仍然远高于真实的 8.8%（顺子放大 3 倍、
 * 金花 2.4 倍、顺金 8 倍、豹子 9 倍，六人桌上平均每 5 局能见到一次顺金或豹子），
 * 但散牌重新成为桌面的底色。散牌与对子按**真实比例** 744:169 摊在剩下的 74% 上
 * （600:140），这样「对子就不错」这类真实炸金花的直觉在低端仍然成立。
 *
 * **party**：四类大牌合计 **54%**，六人桌上几乎每两局就要撞一次金花以上的对撞。
 * 它不是「standard 的放大版」而是另一种玩法：加价和比牌的频率整体抬起来，
 * 顺子和金花才是常态，散牌 35% 只够做背景。给「今晚就图个刺激」的房间用。
 *
 * 改这两张表**不需要**同步改别处：每档的带由它自己算出来（`categoryBands`），
 * `shared/zjh/bot/range.ts` 的桶边界又对齐那一档的带。
 * 唯一要人工复核的是桶数分配 `BUCKETS_PER_CATEGORY`（带宽变了，分辨率要重排）。
 */
export const ZJH_DEAL_PROFILES: Record<DealMode, HandDistribution> = {
  standard: {
    flush: 120,
    straight: 100,
    trips: 22,
    straightFlush: 18,
    highCard: 600,
    pair: 140,
  },
  party: {
    flush: 240,
    straight: 200,
    trips: 55,
    straightFlush: 45,
    highCard: 350,
    pair: 110,
  },
};

/** 标准档那份分布的旧名字。外部引用（以及只认默认档的旧调用）继续指向它。 */
export const ZJH_HAND_DISTRIBUTION_PER_MILLE = ZJH_DEAL_PROFILES.standard;

/** 取值不合法一律退回标准档 —— 发牌这件事不允许因为一个脏字段就崩掉。 */
export function dealProfile(mode: DealMode = 'standard'): HandDistribution {
  return ZJH_DEAL_PROFILES[mode] ?? ZJH_DEAL_PROFILES.standard;
}

export const DEAL_MODES: DealMode[] = ['standard', 'party'];
export const DEAL_MODE_LABEL: Record<DealMode, string> = { standard: '标准', party: '娱乐增强' };
export const isDealMode = (v: unknown): v is DealMode => v === 'standard' || v === 'party';

type DealCategory = 1 | 2 | 3 | 4 | 5 | 6;
type IndexPicker = (maxExclusive: number) => number;
interface CatalogHand { cards: Card[]; keys: [string, string, string] }

const cardKey = (card: Card) => `${card.suit}${card.rank}`;
let cachedHandCatalog: Record<DealCategory, CatalogHand[]> | null = null;

/**
 * 52 选 3 只有 22,100 种，首次使用时算一次，之后每局只筛剩余牌，避免阻塞 Node 主循环。
 *
 * 目录**刻意不排序**：同牌型内部要等概率抽取，没有任何一步需要"谁更大"这个顺序。
 * （排序本身要跑二十多万次 evaluateHand，是首局那几百毫秒卡顿的来源。）
 */
function handCatalog(): Record<DealCategory, CatalogHand[]> {
  if (cachedHandCatalog) return cachedHandCatalog;
  const deck = createDeck();
  const catalog = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] } as Record<DealCategory, CatalogHand[]>;
  for (let a = 0; a < deck.length - 2; a++) {
    for (let b = a + 1; b < deck.length - 1; b++) {
      for (let c = b + 1; c < deck.length; c++) {
        const cards = [deck[a], deck[b], deck[c]];
        const category = evaluateHand(cards).category as DealCategory;
        catalog[category].push({
          cards,
          keys: [cardKey(cards[0]), cardKey(cards[1]), cardKey(cards[2])],
        });
      }
    }
  }
  cachedHandCatalog = catalog;
  return catalog;
}

/** 公开成纯函数，让两档的概率边界都能被测试锁定。 */
export function dealCategoryForRoll(roll: number, mode: DealMode = 'standard'): DealCategory {
  if (!Number.isInteger(roll) || roll < 0 || roll >= 1000) throw new GameError('发牌随机数越界');
  const dist = dealProfile(mode);
  let edge = dist.flush;
  if (roll < edge) return 4;
  edge += dist.straight;
  if (roll < edge) return 3;
  edge += dist.trips;
  if (roll < edge) return 6;
  edge += dist.straightFlush;
  if (roll < edge) return 5;
  edge += dist.highCard;
  if (roll < edge) return 1;
  return 2;
}

/**
 * 从剩余牌里等概率地拿走一手指定牌型。
 *
 * **同一牌型内部必须均匀**。娱乐性由 dealCategoryForRoll 那一层的牌型频率负责，
 * 这一层再往大牌偏就会毁掉牌局：几个人的金花全是 A 高、豹子全是 AAA/KKK，
 * 比牌在翻牌之前就基本定死了，"大小接近"的手感正是这么来的。
 * 现在 234 的顺金、222 的豹子和 AKQ 一样有机会出现。
 */
function takeWeightedHand(deck: Card[], category: DealCategory, pick: IndexPicker): Card[] | null {
  const available = new Set(deck.map(cardKey));
  const candidates = handCatalog()[category].filter((hand) => hand.keys.every((key) => available.has(key)));
  if (!candidates.length) return null;
  const chosen = candidates[pick(candidates.length)];
  const chosenKeys = new Set(chosen.keys);
  for (let i = deck.length - 1; i >= 0; i--) if (chosenKeys.has(cardKey(deck[i]))) deck.splice(i, 1);
  return chosen.cards.map((card) => ({ ...card }));
}

/**
 * 给整桌按目标分布发牌。每个座位先独立抽牌型，再随机处理座位顺序，真人、机器人、
 * 庄家和座位号完全同权。极端冲突下若目标牌型已组不出来，才依次尝试其他牌型。
 */
export function dealWeightedHands(
  handCount: number,
  pick: IndexPicker = randomIndex,
  mode: DealMode = 'standard',
): Card[][] {
  if (!Number.isInteger(handCount) || handCount < 1 || handCount > 6) throw new GameError('发牌人数不合法');
  const plans = Array.from({ length: handCount }, () => dealCategoryForRoll(pick(1000), mode));
  const order = Array.from({ length: handCount }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = pick(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }

  const deck = createDeck();
  const hands: Card[][] = Array.from({ length: handCount }, () => []);
  for (const index of order) {
    const plan = plans[index];
    const fallbacks = [plan, 4, 3, 6, 5, 2, 1].filter((v, i, a) => a.indexOf(v) === i) as DealCategory[];
    let hand: Card[] | null = null;
    for (const category of fallbacks) {
      hand = takeWeightedHand(deck, category, pick);
      if (hand) break;
    }
    if (!hand) throw new GameError('剩余牌无法组成合法手牌');
    hands[index] = hand;
  }
  return hands;
}

/**
 * 一档发牌下的牌力分段（估算一手牌能打败随机一手牌的比例）。
 *
 * **带宽 = 该牌型在这一档的发牌概率，累计而成**，所以这张表不手写：它直接由
 * `ZJH_DEAL_PROFILES[mode]` 按牌型 1→6 累加得到。手抄两份的代价是
 * 调完发牌分布忘了改带，机器人的先验（`range.ts` 的桶质量 = 带宽）就会和真实
 * 发牌对不上，而这种错不会有任何一条测试自己报出来。
 *
 * 标准档：1 散牌 [0, .60]、2 对子 [.60, .74]、3 顺子 [.74, .84]、
 * 4 金花 [.84, .96]、5 顺金 [.96, .978]、6 豹子 [.978, 1]。
 * 娱乐增强档：[0, .35]、[.35, .46]、[.46, .66]、[.66, .90]、[.90, .945]、[.945, 1]。
 *
 * **一桌只有一档**：分位是「打赢这桌上随机一手牌」的比例，混着两档算出来的数
 * 谁也不代表。所以房间内的每一次调用都要把 `state.settings.dealMode` 带上。
 */
const bandCache = new Map<DealMode, Record<number, [number, number]>>();

export function categoryBands(mode: DealMode = 'standard'): Record<number, [number, number]> {
  const key: DealMode = isDealMode(mode) ? mode : 'standard';
  const hit = bandCache.get(key);
  if (hit) return hit;
  const dist = dealProfile(key);
  const perMille: Record<number, number> = {
    1: dist.highCard,
    2: dist.pair,
    3: dist.straight,
    4: dist.flush,
    5: dist.straightFlush,
    6: dist.trips,
  };
  const out: Record<number, [number, number]> = {};
  let cum = 0;
  for (const category of [1, 2, 3, 4, 5, 6]) {
    const lo = cum / 1000;
    cum += perMille[category];
    out[category] = [lo, cum / 1000];
  }
  out[6][1] = 1; // 收尾钉死在 1，别让浮点把最强的一手牌算成 0.9999
  bandCache.set(key, out);
  return out;
}

/**
 * 标准档的带。**只给「只知道默认档」的旧调用兼容用**；房间里的调用一律走
 * `categoryBands(state.settings.dealMode)`。
 */
export const CATEGORY_BANDS: Record<number, [number, number]> = categoryBands('standard');

export function handPercentile(hand: Card[], mode: DealMode = 'standard'): number {
  const e = evaluateHand(hand);
  const [lo, hi] = categoryBands(mode)[e.category];
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
    // 坐下就是准备好了。开一桌 / 进一桌之后还要再点一次「准备」纯粹是多一步，
    // 不想打的人按一下取消即可 —— 把默认值放在多数人想要的那一边。
    ready: true,
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
    kind: 'zjh',
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
    createdAt: Date.now(),
    chipGrantVersion: CHIP_GRANT_VERSION,
    economyVersion: ZJH_ECONOMY_VERSION,
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
  // 老快照是多游戏框架之前存的，没有 kind —— 那时候只有炸金花一种房间（DESIGN 2.6）
  state.kind ??= 'zjh';
  // 房主字段缺失过一版；空串是「暂时没有房主」的合法取值，下一个真人进来/回来就接手
  state.hostId ??= '';
  state.settings = { ...DEFAULT_SETTINGS, ...(state.settings ?? {}) };
  // 初始/重置筹码与下注档位是全服经济规则，不是房主可调整的房规；旧房间恢复后也必须升级。
  state.settings.startingChips = DEFAULT_SETTINGS.startingChips;
  state.settings.ante = DEFAULT_SETTINGS.ante;
  state.settings.betOptions = [...DEFAULT_SETTINGS.betOptions];
  // 旧存档里存着 8 轮封顶。封顶与否是玩法规则不是房主偏好，恢复时统一到当前默认（不封顶）。
  state.settings.maxRounds = DEFAULT_SETTINGS.maxRounds;
  // 发牌档位是房主偏好，恢复时保留；但**上线前的旧快照没有这个字段**，
  // 而 undefined 会让 categoryBands 退回默认档、机器人的桶却按房间里的值走 ——
  // 与其让两边偷偷对不上，不如在这里一次性钉死成 standard（脏值同理）。
  if (!isDealMode(state.settings.dealMode)) state.settings.dealMode = DEFAULT_SETTINGS.dealMode;
  state.economyVersion = ZJH_ECONOMY_VERSION;
  // 进行中的旧牌局不在半路改变当前单价；大厅和结算阶段直接显示新底注，下一局自然按新档位开。
  if (state.phase !== 'playing') state.betUnit = DEFAULT_SETTINGS.betOptions[0];
  state.log ??= [];
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
    /*
     * `allIn` 是「全押跟」上线之后才有的字段，老快照里一律缺失。
     * 保守地按现场推断：还在局里（active）却一分钱都没有的人，就是已经推光了的人 ——
     * 老版本里这种状态只在梭哈表态被夹到全部筹码时出现过。其余一律 false。
     * 缺了这个默认值，老房间恢复后会被当成「还能出资」，一路要到他头上然后卡死。
     */
    p.allIn ??= p.status === 'active' && (p.chips ?? 0) <= 0;
    // 旧快照里 handActions 是 string[]。老房间可能正打到一半，不能崩也不能丢：
    // 一律按闷牌补 looked=false（信息量最低的保守解释），单价用快照里当时的价。
    p.handActions = normalizeHandActions(p.handActions, state.betUnit, state.roundNo);
    // 旧存档里可能带着「激进 / 狡诈」这类风格标签。电脑玩家的打法应该靠观察
    // 摸出来，写在名字后面等于开局就把底牌交了 —— 恢复时一并清掉。
    delete (p as { botStyle?: string }).botStyle;
  }
  if ((state.chipGrantVersion ?? 0) < CHIP_GRANT_VERSION) {
    for (const p of state.players ?? []) {
      const add = Math.max(0, DEFAULT_SETTINGS.startingChips - p.chips);
      p.chips += add;
      p.granted += add;
    }
    state.chipGrantVersion = CHIP_GRANT_VERSION;
  }
  // base 是「闷牌半价」上线后才有的字段。老快照里存的 amount 就是当时人人同价的那个数，
  // 拿它当基准恢复出来，正在表态的那一局还能按老规则打完，不会中途报价崩掉。
  /*
   * 老快照可能多带一个 `paid` 字段（「表态期间弃牌后重算单价」那一版的账本）。
   * 单价重算这套房规已经废掉了，那个字段现在没有任何意义 —— 不读、不删、不迁移，
   * 直接无视：正在表态的老房间照着 `base` 就能把这一手打完。
   */
  if (state.allIn) state.allIn.base ??= state.allIn.amount;
  // 旧快照的房内笔记（key 是房内 id）一次性并进长期档案，然后就没有 reads 这回事了。
  if (state.reads) {
    for (const p of state.players ?? []) {
      const legacy = state.reads[p.id];
      if (legacy) mergeLegacyRead(playerMemory(state, p), legacy);
    }
    delete state.reads;
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
  /*
   * 只交给**在线**的真人，而且是入座最早的那个（players 就是入座顺序）。
   *
   * 以前这里有一句 `?? humans[0]` 的兜底，会把房主交给一个同样离线的人 ——
   * 那等于把整桌交给一个不在的人：开下一局、加电脑、改房规全要房主点，
   * 于是房间卡死，只能等那个人自己回来。没有在线真人时宁可空着，
   * 谁先回来谁接手（`claimHostIfVacant`），也不要挂在离线的人名下。
   */
  const next = state.players.find((p) => p.id !== departingId && !p.pendingLeave && !p.isBot && p.online);
  if (next) {
    if (next.id === state.hostId) return;
    state.hostId = next.id;
    pushLog(state, `房主已转给 ${next.name}`);
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

/* ------------------------------------------------------- 打法笔记（全部是公开信息） */

/** 长期档案的读写入口。档案挂在 state.memory 上，但按人（不是按座位）索引。 */
export function playerMemory(state: RoomState, player: PlayerState): BotMemory {
  state.memory ??= {};
  const key = memoryKey(player);
  state.memory[key] ??= emptyMemory(key);
  return state.memory[key];
}

/** 旧口径的聚合视图。既有代码（含 v2 快照、`credibility`）读的都是这个形状。 */
export function tableRead(state: RoomState, playerId: string): TableRead {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return toTableRead(undefined);
  return toTableRead(state.memory?.[memoryKey(player)]);
}

/**
 * 条件分桶的原始计数。`foldProbOf` 要的是「他**在这个条件下**跑不跑」，
 * 聚合视图（`tableRead`）把条件都拌在一起了，答不了这个问题。
 */
export function tableBuckets(state: RoomState, playerId: string): Record<string, MemoryBucket> {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return {};
  return state.memory?.[memoryKey(player)]?.buckets ?? {};
}

/** 这一步落在哪个条件格子里：闷/看 × 单价档位 × 是否三人以上。 */
function conditionKey(state: RoomState, actor: PlayerState): string {
  const multiway = state.players.filter((p) => p.status === 'active').length >= 3;
  return bucketKey(actor.looked, unitTier(state.betUnit, state.settings), multiway);
}

/**
 * 记下一个动作。**必须在动作真正生效之前调用** —— 「他是在面对加注的情况下弃的牌」
 * 这个信息，等牌局状态改完就找不回来了。
 */
/**
 * `spentMs`：他在这一步上花掉的毫秒数（设计文档 §4.8，S17 读用时的唯一来源）。
 * 机器人由调度层把 `BotAction.thinkMs` 原样传进来 —— 服务端本来就是按它排延迟的，
 * 而自对弈不排延迟，按墙钟算会全是 0。真人不传，按 `turnDeadline` 回推。
 */
function noteAction(state: RoomState, actor: PlayerState, kind: HandActionKind, spentMs?: number) {
  if (state.phase !== 'playing' || actor.status !== 'active') return;
  const read = playerMemory(state, actor);
  read.handStart ??= { ...toTableRead(read), recent: undefined, publicStats: undefined };
  const bucket = editBucket(read, conditionKey(state, actor));
  // 「有人加注过或者有人梭哈」= 他这一步是顶着压力做的
  const underPressure = !!state.allIn
    || state.betUnit > state.settings.betOptions[0]
    || state.players.some((p) => p.id !== actor.id && p.status === 'active'
      && p.handActions?.some((e) => e.kind === 'raise'));

  if (kind !== 'look') {
    // 事件流记的是**做这个动作当时**的处境，之后再怎么升档都不改写历史。
    const turnMs = state.settings.turnSeconds * 1000;
    const byClock = state.turnDeadline != null ? Date.now() - (state.turnDeadline - turnMs) : 0;
    const spent = Math.max(0, Math.min(turnMs, spentMs ?? byClock));
    actor.handActions = [...(actor.handActions ?? []), {
      kind, looked: actor.looked, unit: state.betUnit, roundNo: state.roundNo, at: eventTime(),
      msSpent: spent,
    }];
    read.publicStats ??= emptyPublicStats();
    observePublic(read.publicStats, actor.handActions.at(-1)!);
    if (underPressure) { read.pressureFaced += 1; bucket.pressureFaced += 1; }
  }
  // 面对别人挑起来的梭哈，他到底接不接 —— 发起端唯一能用的跨局统计（§4.6）。
  // 必须在这里记：`doCall` / `doFold` 一执行，`state.allIn` 就可能被清掉了。
  if (state.allIn && actor.id !== state.allIn.initiatorId && (kind === 'call' || kind === 'fold')) {
    read.allInFaced = (read.allInFaced ?? 0) + 1;
    if (kind === 'call') read.allInTaken = (read.allInTaken ?? 0) + 1;
  }
  if (kind === 'raise' || kind === 'all_in' || kind === 'compare') read.aggressive += 1;
  else if (kind === 'call') read.passive += 1;
  else if (kind === 'fold' && underPressure) { read.foldsToPressure += 1; bucket.foldsToPressure += 1; }

  if (kind === 'call') bucket.call += 1;
  else if (kind === 'raise') bucket.raise += 1;
  else if (kind === 'compare') bucket.compare += 1;
  else if (kind === 'all_in') bucket.allIn += 1;
  else if (kind === 'fold') bucket.fold += 1;
  read.updatedAt = Date.now();
}

/**
 * 一局结束时结账：谁真的下场打了、谁亮了什么牌、谁被打疼了。
 * 亮牌名单用的是 result.revealed —— 那是全场都看得到的，跟机器人的信息边界不冲突。
 */
function noteRoundResult(state: RoomState) {
  const result = state.result;
  if (!result) return;
  for (const p of state.players) {
    if (p.bet <= 0) continue;
    const read = playerMemory(state, p);
    read.hands += 1;
    // 「下过场」= 底注之外还投过钱，或者至少看了牌打下去
    if (p.bet > state.settings.ante || (p.handActions?.length ?? 0) > 0) read.played += 1;
    if (result.revealed.includes(p.id) && result.hands[p.id]?.length === 3) {
      const strength = handPercentile(result.hands[p.id], state.settings.dealMode);
      read.showdowns += 1;
      read.showdownStrength += strength;
      // 牌力也要落回条件格子：「他在 10 万档上加注时亮出来的牌一般多硬」才是有用的统计。
      const multiway = state.players.filter((x) => x.bet > 0).length >= 3;
      const seenBuckets = new Set(
        (p.handActions ?? []).map((e) => bucketKey(e.looked, unitTier(e.unit, state.settings), multiway)),
      );
      for (const key of seenBuckets) {
        const bucket = editBucket(read, key);
        bucket.showdowns += 1;
        bucket.showdownStrength += strength;
      }
      // 亮出来的牌很烂却一路打到摊牌 —— 这个人是敢吹的
      if (strength < 0.42 && p.handActions?.some(e => e.kind === 'raise' || e.kind === 'all_in')) read.bluffsCaught += 1;
    }
    const recent = toTableRead(undefined);
    for (const k of ['hands', 'played', 'aggressive', 'passive', 'pressureFaced', 'foldsToPressure', 'showdowns', 'showdownStrength', 'bluffsCaught'] as const) {
      recent[k] = read[k] - (read.handStart?.[k] ?? (k === 'hands' ? read[k] - 1 : read[k]));
    }
    read.recent = [...(read.recent ?? []), { at: Date.now(), read: recent }].slice(-3);
    delete read.handStart;
    read.updatedAt = Date.now();
  }
  noteTilt(state, result);
  settleMinds(state, result);
}

/**
 * 每局结束时给每台机器人**结一次心理的账**（设计文档 §4.9.1 / §4.9.5）。
 *
 * 这一步是情绪唯一的入口：赢了多少、亮没亮牌、事前觉得自己该不该赢、是谁把我吃掉的，
 * 折成一条通用评价交给 `shared/mind/` 的 `settle()`，由它去衰减、耦合、点规律
 * （R1 损失厌恶、R5/R6 连输连赢、R7 bad beat、R8 冒进被抓、R10 懊悔、R13 无聊、
 * R14 面子、R18 归因、R30 意志力回复）。这里**不做任何情绪计算**，只做翻译。
 *
 * 旧的 `p.tilt` 一行没动：它是 `tests/fixtures/zjh-bot-v2.ts` 那个冻结对照组读的东西，
 * 动了它竞技场就没有基准了。新脑不读 `p.tilt`。
 */
function settleMinds(state: RoomState, result: RoundResult) {
  const totalPot = result.deltas.reduce((sum, d) => sum + d.bet, 0);
  for (const p of state.players) {
    if (!p.isBot) continue;
    if (p.bet <= 0 && p.status !== 'folded') continue;
    const mem = playerMemory(state, p);
    const traits = personaFor(p).traits;
    const delta = result.deltas.find((d) => d.id === p.id)?.delta ?? 0;
    const won = result.winnerId === p.id;
    const exposed = result.revealed.includes(p.id);
    const withdrew = p.status === 'folded';
    const felt = mem.felt ?? 0.5;
    /*
     * 归因对象（`personas.md`「待集成」#14）。原来一律记给「这一手的赢家」，
     * 但把他比掉/梭掉的那个人后面可能又输给了第三个人 —— 实测两者只重合 62.5%，
     * 也就是三分之一的仇记错了人，「谁比掉他他找谁」这句人设就落不了地。
     * 现在优先用结算带出来的 `knockedOutBy`（比牌赢他的人 / 他接下那手梭哈的发起人），
     * 只有主动弃牌、以及封顶开牌这种「不是被谁打下去」的局面才回落到赢家。
     */
    const by = won ? undefined : (result.knockedOutBy[p.id] ?? result.winnerId);
    const winnerHand = result.hands[result.winnerId];
    // 归因对象最后亮出来的牌（他可能不是赢家，比如比掉我之后自己又输了）
    const byHand = by ? result.hands[by] : undefined;
    const myHand = result.hands[p.id];
    // `settle` 原地改 mind 并返回一条痕迹，所以先取出来再写回去
    const mind = readMind(mem.mind, traits);
    settle(mind, traits, {
      gain: delta,
      balance: p.chips,
      expected: felt,
      by: by ? socialKey(state.players, by) : undefined,
      exposed,
      withdrew,
      // 退出之后才发现本来能赢（R10 懊悔）—— 只有牌都亮出来时才知道
      regretted: withdrew && !!myHand && !!winnerHand && myHand.length === 3 && winnerHand.length === 3
        && compareHands(myHand, winnerHand) > 0,
      /*
       * 诈唬被抓（R8，§4.9.8 原话「自己诈唬被比牌/跟注揭穿」）。
       *
       * 原来这里写的是 `exposed && delta < 0 && felt >= 0.6`，条件是
       * 「我**觉得自己很强**、亮了牌、还是输了」—— 那是 R7 bad beat 的定义
       * （R7 分支就在 `regularities.ts` 隔壁，用的正是 `expected >= 0.5`），
       * 不是 R8。真正的诈唬是**拿着烂牌施压**，`felt` 恰恰很低，
       * 于是 R8 在诈唬这条路上一次都点不着：老王卡上「被抓两次后一段时间不敢演」
       * 永远没有输入（personas.md 待集成 #3）。
       *
       * 现在按原话三件事同时成立才算：我这一手**主动施过压**（加注/梭哈）、
       * 牌**摊到了桌面上**、而且那手牌本来就不够格（落在 `categoryBands` 的散牌档）。
       * 「被比牌揭穿」和「被跟注揭穿」的区别在对手那一侧，这里只看我自己诈没诈。
       */
      overreached: exposed && delta < 0
        && !!p.handActions?.some((e) => e.kind === 'raise' || e.kind === 'all_in')
        && !!myHand && myHand.length === 3
        && handPercentile(myHand, state.settings.dealMode)
          < categoryBands(state.settings.dealMode)[2][0],
      // 被同一个人用压力逼退（R14 面子的计数）
      pressuredOut: withdrew && !won,
      /*
       * 被诈成功、而且**事后知道了**（R9）。撤了、对方最后把牌摆上了桌面、
       * 那手牌还是散牌 —— 这三件事同时成立才叫「被诈了还看见了」。
       * 没摊牌就不知道：真实牌桌上不战而胜的人没有义务亮牌，情绪上也就不该有反应。
       */
      bluffedOut: withdrew && !won && !!byHand && byHand.length === 3
        && handPercentile(byHand, state.settings.dealMode) < categoryBands(state.settings.dealMode)[1][1],
      scale: totalPot,
    });
    mem.mind = mind;
    mem.updatedAt = Date.now();

    /*
     * 表情（§6.3 S18：「我赢下 40 万的池 / 被梭哈掀掉 / 看到有人梭哈」→ 🔥 / 😭 / 😱）。
     *
     * 放在这里而不是服务端循环里，是因为「这一局我是赢是输、输了多少」只有结算
     * 这一刻知道得最全；而且这一段每局每人恰好跑一次，不需要另设去重。
     * 「看到有人梭哈 😱」是局中的事，走非回合那条路（`decideOffTurn`）。
     *
     * 三件事都由人物卡说了算，服务端不做任何裁量：
     *   - 发不发：`emotes.rate` × 这一下有多大（`emoteFor`）；
     *   - 发哪张：`emotes.favourites`；
     *   - 发几个：`emotes.cap`（`p.emoted` 每局清零）。
     *
     * `target` 落在**把我打下去的那个人**头上（`knockedOutBy`，见上面的 `by`），
     * 赢家则落在他心里最恨的那个人头上 —— 阿彪卡上的「表情针对仇人 😂」
     * （`docs/zjh/personas.md`「待集成」#10）就是靠这两条落地的。
     */
    if ((p.emoted ?? 0) < personaFor(p).emotes.cap) {
      const stake = Math.max(1, p.chips + Math.abs(delta));
      const face = won
        ? emoteFor(personaFor(p), 'won-big', totalPot / stake, () => Math.random(), emotionChannels(mind, traits).showoff)
        : (withdrew ? null
          : emoteFor(personaFor(p), 'busted', Math.abs(delta) / stake, () => Math.random(), emotionChannels(mind, traits).showoff));
      if (face) {
        const target = won ? topRevenge(state, mind, p.id) : by;
        p.emote = { id: face, at: Date.now(), target };
        p.emoted = (p.emoted ?? 0) + 1;
      }
    }
  }
}

/** 他心里最恨、而且**人还在这张桌上**的那个（表情的落点，`personas.md` 待集成 #10）。 */
function topRevenge(state: RoomState, mind: MindState, selfId: string): string | undefined {
  let best: string | undefined; let top = 0;
  for (const p of state.players) {
    if (p.id === selfId) continue;
    const g = mind.revenge[memoryKey(p)] ?? mind.revenge[p.id] ?? 0;
    if (g > top) { top = g; best = p.id; }
  }
  return top > 0.05 ? best : undefined;
}

/**
 * 情绪结账。真人输一大笔之后会想追回来，而且越是刚才「牌不差还是输了」越上头；
 * 刚赢一大笔的人会稍微放开一点打，但远不如输钱的反应强烈。
 * 卡上 `tiltGain` 小的人上头得轻，这样一桌电脑的情绪曲线不会整齐划一。
 */
function noteTilt(state: RoomState, result: RoundResult) {
  for (const p of state.players) {
    if (!p.isBot) continue;
    // 先衰减：情绪撑不过三四局
    let tilt = (p.tilt ?? 0) * 0.72;
    const delta = result.deltas.find((d) => d.id === p.id)?.delta ?? 0;
    const stake = Math.max(1, p.chips + Math.abs(delta));
    const share = Math.abs(delta) / stake;
    // 「这个人上头得多重」写在他的人物卡上（§4.9.6 `emotion.tiltGain`：
    // 跟注站 0.10、岩石 0.15、常人 0.85、赌徒 1.50）。P2 这一行读的是过渡表的
    // `1 - patience`，常人档大约落在 0.40；这里按常人卡归一，量纲原样不动，
    // 只是把「谁上头得重」的裁量权从已删掉的 7 维表交还给卡。
    const temper = 0.40 * tiltFactor(personaFor(p));
    if (delta < 0 && share >= 0.12) {
      // 亮过牌还输了，比默默弃牌难受得多 —— 那是「我牌不差居然还输」
      const stung = result.revealed.includes(p.id) ? 1.6 : 1;
      tilt += Math.min(0.75, share * 1.6) * temper * stung;
    } else if (delta > 0 && share >= 0.25) {
      tilt += 0.14 * temper;
    }
    p.tilt = Math.max(-1, Math.min(1, tilt));
  }
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
 * 梭哈的**闷牌单价**，由**发起人自己的身家**定 —— 主流玩法：梭哈 = 全押。
 *
 * 发起人把全部筹码推出去，`base` 是把这笔钱换算回闷牌口径的结果：闷牌的人
 * 一份就是全部身家；看牌的人一份要掏两份，所以他的闷牌单价是身家的一半。
 * 用 `ceil` 而不是 `floor`：身家是奇数时向上取整，`base × 2` 才盖得住他的全部筹码，
 * 发起人真的推光（`pay` 会夹到 chips，不会多扣）。
 *
 * **不再按「桌上最短的一家」封顶**。那套房规下，台面 10 万、甲 100 万 / 乙 1 万时
 * 甲跟注要 10 万、梭哈却只付 1 万还能逼全桌表态 —— 梭哈比跟注便宜，
 * 荒唐到没法用补丁救。别人接不接得起是别人的事：掏不动就全押接，边池分层。
 */
export function allInBase(
  _state: unknown,
  player: { looked: boolean; chips: number },
): number {
  return Math.ceil(player.chips / (player.looked ? 2 : 1));
}

/**
 * 发起人梭哈要掏多少 —— **他的全部筹码**，一分不留。
 *
 * 参数必须是**发起人**：这个函数回答的是「我梭哈要押多少」，不是「我接梭哈要付多少」。
 * 接受价永远读 `state.allIn.base × 自己的倍率`（见 doCall / legalActions）。
 */
export function allInCost(
  _state: unknown,
  player: { looked: boolean; chips: number },
): number {
  return player.chips;
}

/**
 * 梭哈什么时候可用：**只看轮次** —— 牌局打过设定的轮数（默认第 3 轮起），
 * 前面的下注博弈已经走完，才允许有人掀桌。
 *
 * 以前还有第二条「场上有人跟不起就提前解锁」。那是为了给跟不起的人一条出路，
 * 可他现在本来就有出路：跟注 / 比牌都会被 `pay` 夹到全部筹码打出去（「全押跟」）。
 * 为了一个人的出路把**全桌**的梭哈提前放开，是拿房规换便利 —— 删掉。
 */
export function canAllInNow(state: { roundNo: number; settings: { allInFromRound: number } }): boolean {
  return state.roundNo >= (state.settings.allInFromRound ?? 3);
}

export function canCompareNow(state: {
  players: { status: PlayerStatus }[];
  turnCount: number;
  compareUnlockAt: number;
}): boolean {
  const active = state.players.filter((p) => p.status === 'active').length;
  return active === 2 || state.turnCount >= state.compareUnlockAt;
}

/**
 * 出资。**钱不够就把剩下的全推出去**（「全押跟」），返回实际掏了多少。
 *
 * 以前这里直接抛「积分不足，当前只能弃牌或梭哈」，于是台面单价一涨过某人的身家，
 * 他手上还有钱、牌也还在，却只剩弃牌一个按钮 —— 这正是真人报上来的那个「逻辑混乱」。
 * 现在动作类型不变（还是跟注 / 比牌 / 接梭哈），只是金额封顶到他的全部筹码，
 * 推光之后标记 `allIn`，往后轮到他自动跳过，结算按边池分层。
 */
function pay(state: RoomState, p: PlayerState, amount: number): number {
  const paid = Math.max(0, Math.min(amount, p.chips));
  p.chips -= paid;
  p.bet += paid;
  state.pot += paid;
  if (p.chips <= 0) p.allIn = true;
  return paid;
}

/** 出资文案：短付的那一口要明写成「全押」，别让人以为自己按错了 */
function payLabel(verb: string, paid: number, asked: number): string {
  return paid < asked ? `全押${verb} ${paid}` : `${verb} ${paid}`;
}

/**
 * 下一个**还能出资**的行动者。已经推光的人自动跳过：他不能再掏钱，
 * 停在他头上只会让全桌等一个注定超时弃牌的人。
 */
function nextActorSeat(state: RoomState, fromSeat: number): number | null {
  const M = state.settings.maxPlayers;
  for (let offset = 1; offset <= M; offset++) {
    const seat = (fromSeat + offset + M) % M;
    const p = state.players.find((x) => x.seat === seat && !x.pendingLeave && x.status === 'active');
    if (p && p.chips > 0) return seat;
  }
  return null;
}

/**
 * 还有没有下注可打？没弃牌的人里除了至多一人之外都推光了，就没有了 ——
 * 剩下那一个人再往里扔钱也没人陪，直接摊牌，不要让谁干等。
 */
function noMoreBetting(state: RoomState): boolean {
  const active = activePlayers(state);
  if (active.length < 2) return false;
  return active.filter((p) => p.chips > 0).length <= 1;
}

/** 摊牌的顺序锚点：优先当前行动者，其次场上第一个还在局的人 */
function showdownAnchor(state: RoomState): PlayerState | null {
  return currentPlayer(state) ?? activePlayers(state)[0] ?? null;
}

function touchDeadline(state: RoomState) {
  state.turnDeadline = state.phase === 'playing' && state.turnSeat != null
    ? Date.now() + state.settings.turnSeconds * 1000
    : null;
}

/* ----------------------------------------------------------------- 结算 */

/**
 * 按**边池**把底池分掉，返回每个人分到多少。
 *
 * 分层的依据是每个人本局的累计出资 `bet`：从低到高切成若干层，
 * 每一层的钱 =（层厚 × 对这一层有出资的人数），只在「对该层有出资**且**还没弃牌」
 * 的人里比牌。于是一个只押得起 100 的人，赢也只赢得到 100 那一层，
 * 押到 700 的两家在更高的层里自己分胜负 —— 短筹码不会白拿别人的钱，
 * 也不会因为跟不起就把已经押进去的钱全送人。
 *
 * `ranking` 是还在局里的人**按牌力从大到小**排好的名次；弃牌和被比掉的人不在里面，
 * 所以他们自动不参与任何一层（任务书：比牌淘汰的人不参与后续任何层）。
 */
function splitSidePots(state: RoomState, ranking: PlayerState[]): Map<string, number> {
  const gains = new Map<string, number>();
  const add = (id: string, n: number) => gains.set(id, (gains.get(id) ?? 0) + n);
  const lines = [...new Set(state.players.filter((p) => p.bet > 0).map((p) => p.bet))].sort((a, b) => a - b);
  let floorLine = 0;
  let orphan = 0;
  for (const line of lines) {
    const thickness = line - floorLine;
    const layer = thickness * state.players.filter((p) => p.bet >= line).length;
    // ranking 已按牌力排好，第一个够得着这一层的人就是这一层的赢家
    const taker = ranking.find((p) => p.bet >= line);
    if (taker) add(taker.id, layer);
    // 这一层只有已经弃牌的人出过资（比如全场都弃、赢家押得最少）。
    // 炸金花里弃掉的钱本来就归赢家，保持现状：并进牌面赢家那一份。
    else orphan += layer;
    floorLine = line;
  }
  if (orphan > 0 && ranking.length) add(ranking[0].id, orphan);
  return gains;
}

/**
 * 收锅。`ranking` 是还在局里的人按牌力从大到小排好的名次，第一个是牌面赢家。
 * 底池按边池分层发放，所以名次靠后的人也可能拿到他自己那几层。
 */
function finishRound(state: RoomState, ranking: PlayerState[], reason: string, revealed: PlayerState[]) {
  const winner = ranking[0];
  const gains = splitSidePots(state, ranking);
  const won = gains.get(winner.id) ?? 0;
  for (const [id, amount] of gains) {
    const p = state.players.find((x) => x.id === id);
    if (p) p.chips += amount;
  }
  winner.wins += 1;
  // 先把每个人这一局的盈亏结出来：投入是 bet，各自再把分到的池子收回去
  const deltas = state.players
    .filter((p) => p.bet > 0 || (gains.get(p.id) ?? 0) > 0)
    .map((p) => {
      const delta = (gains.get(p.id) ?? 0) - p.bet;
      p.net += delta;
      return { id: p.id, name: p.name, avatar: p.avatar, delta, bet: p.bet, net: p.net };
    })
    .sort((a, b) => b.delta - a.delta);
  state.pot = 0;
  state.turnSeat = null;
  state.turnDeadline = null;
  state.phase = 'round_end';
  state.nextAt = Date.now() + ROUND_END_MS;
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
    knockedOutBy: Object.fromEntries(
      state.players
        .filter((p) => p.id !== winner.id && p.knockedOutBy && p.knockedOutBy !== p.id)
        .map((p) => [p.id, p.knockedOutBy as string]),
    ),
  };
  noteRoundResult(state);
  pushLog(state, `${winner.name} 赢得 ${won.toLocaleString('zh-CN')} 积分`);
  // 边池：牌面赢家押得少、够不着高层时，那几层归名次靠后的人。不写出来没人看得懂账。
  for (const [id, amount] of gains) {
    if (id === winner.id || amount <= 0) continue;
    const p = state.players.find((x) => x.id === id);
    if (p) pushLog(state, `${p.name} 赢得边池 ${amount.toLocaleString('zh-CN')} 积分`);
  }
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
  finishRound(state, [active[0]], reason, []);
  return true;
}

/**
 * 封顶/梭哈触发的全员开牌。
 *
 * `byInitiator` = 这一下开牌是**发起人把大家逼上桌面**的（梭哈），不是规则到点了
 * （封顶、没人出得起钱）。只有前者才谈得上「被谁打下去」，见 `knockedOutBy`。
 */
function forceShowdown(state: RoomState, initiator: PlayerState, reason: string, byInitiator = false) {
  const active = activePlayers(state).sort((a, b) => {
    const M = state.settings.maxPlayers;
    return ((a.seat - initiator.seat + M) % M) - ((b.seat - initiator.seat + M) % M);
  });
  if (!active.length) throw new GameError('没有可参与开牌的玩家');
  /*
   * 排出完整名次，而不是只挑一个赢家 —— 有边池之后，第二名、第三名也可能各自
   * 拿走一层。比较口径和以前一样：完全同牌时后手胜（和普通比牌「主动方负」一致），
   * 所以 a 不严格大于 b 时就把 a 排在后面。
   */
  const ranking: PlayerState[] = [];
  const pool = [...active];
  while (pool.length) {
    let best = 0;
    for (let i = 1; i < pool.length; i++) {
      if (compareHands(pool[best].hand, pool[i].hand, state.settings.special235) <= 0) best = i;
    }
    ranking.push(pool.splice(best, 1)[0]);
  }
  const winner = ranking[0];
  /*
   * 「被梭掉」的归因（`personas.md`「待集成」#14）：梭哈开牌里还留在场上的人，
   * 要么是发起人自己，要么是**接了他这一梭**的人。所以输家记的是那个把他逼上桌面
   * 的人，而不是最后收池的人 —— 这两者常常不是一个人（发起人自己也可能输）。
   * 封顶开牌（没有 `state.allIn`）不是被谁打下去的，留空回落到赢家。
   */
  const shover = byInitiator ? initiator.id : undefined;
  for (const p of active) {
    // 开牌是把牌摆到桌面上定胜负，赢的输的都不是自己退出的，结算时一律公开
    p.bared = true;
    if (p.id !== winner.id) {
      p.lastAction = `开牌负于 ${winner.name}`;
      if (shover && shover !== p.id) p.knockedOutBy ??= shover;
    }
  }
  // 名次先定下来再改状态：结算要按名次分边池，提前把输家标成 folded 会让他们退出所有层
  finishRound(state, ranking, reason, active);
  for (const p of active) if (p.id !== winner.id) p.status = 'folded';
}

function advanceTurn(state: RoomState, fromSeat: number) {
  if (maybeFinish(state)) return;
  // 没人还能出资了就别再往下轮：剩下那一个人再加注也没人陪，直接开牌。
  // 梭哈表态期间不走这条捷径 —— 「接不接」是当事人自己的选择（任务书：梭哈现有规则不改），
  // 推光了的人由 advanceAllIn 自动算作留下，那边会收场。
  if (!state.allIn && noMoreBetting(state)) {
    const anchor = showdownAnchor(state);
    if (anchor) {
      forceShowdown(state, anchor, '已无人能继续出资，直接开牌');
      return;
    }
  }
  const next = nextActorSeat(state, fromSeat);
  if (next == null) throw new GameError('无法找到下一位玩家');

  const M = state.settings.maxPlayers;
  const dist = (s: number) => (s - state.firstActorSeat + M) % M;
  const wrapped = dist(next) <= dist(fromSeat);

  state.turnSeat = next;
  state.turnCount += 1;

  if (wrapped) {
    state.roundNo += 1;
    // 房间显式设了封顶轮数才强制开牌；默认 0 = 不封顶，打到分出胜负为止。
    if (state.settings.maxRounds > 0 && state.roundNo > state.settings.maxRounds) {
      const anchor = currentPlayer(state) ?? activePlayers(state)[0];
      forceShowdown(state, anchor, `已打满 ${state.settings.maxRounds} 轮，封顶开牌`);
      return;
    }
    // 自动升档：让牌局有节奏地收紧，也避免小注互相跟到天亮。
    const { escalateFrom, betOptions } = state.settings;
    // 每两轮升一档：既保证牌局收敛，又不会一手就把人打穿
    const onSchedule = escalateFrom > 0
      && state.roundNo >= escalateFrom
      && (state.roundNo - escalateFrom) % 2 === 0;
    /**
     * 兜底加压线。
     *
     * 不封顶之后，「本局一定会结束」全靠钱去逼 —— 可房间是能把自动升档关掉的
     * （escalateFrom = 0）。两个都关掉，一桌人只要一直平跟，理论上可以打到天亮。
     * 所以不封顶时从第 6 轮起强制每轮加压，这条线不受房规影响。
     */
    const forced = state.settings.maxRounds <= 0 && !onSchedule && state.roundNo >= 6;
    if (onSchedule || forced) {
      const idx = betOptions.indexOf(state.betUnit);
      const raised = idx >= 0 ? betOptions[idx + 1] : undefined;
      if (raised) {
        state.betUnit = raised;
        pushLog(state, `第 ${state.roundNo} 轮，底注自动升至 ${raised}`);
      } else {
        /**
         * 档位已经用完，但牌局还没结束 —— 这里就是「不封顶」的收敛保证。
         *
         * 每两轮把单价翻一倍。筹码是有限的，翻倍是几何增长，所以任何人最多再撑
         * 几轮就会被顶到「跟不起」，那一口跟出去就是全押（`pay` 夹到全部筹码），
         * 人一个个推光，牌局必然收口。不用数轮数，让钱去逼出胜负。
         */
        state.betUnit *= 2;
        pushLog(state, `第 ${state.roundNo} 轮，底注翻倍至 ${state.betUnit.toLocaleString('zh-CN')}`);
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

  const hands = dealWeightedHands(entrants.length, undefined, state.settings.dealMode);
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
    p.knockedOutBy = undefined;
    p.emoted = 0;
    p.allIn = false;
    p.bet = 0;
    p.hand = [];
    p.lastAction = undefined;
    // 动作史是**本局**的故事，开新局必须清空；跨局的部分留在 state.reads 里。
    p.handActions = [];
    p.status = 'waiting';
  }
  for (const [i, p] of entrants.entries()) {
    p.status = 'active';
    p.hand = hands[i];
    p.chips -= state.settings.ante;
    p.bet = state.settings.ante;
    state.pot += state.settings.ante;
  }

  // 庄位和首家都只在本局入局的人里轮转
  state.dealerSeat = nextOccupiedSeat(state, state.dealerSeat, true) ?? entrants[0].seat;
  const first = nextOccupiedSeat(state, state.dealerSeat, true)!;
  state.turnSeat = first;
  state.firstActorSeat = first;
  state.nextAt = undefined;
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
    // 表态阶段：跟注就是「接梭哈」，价钱按自己的倍率算 —— 闷牌半价，看牌双倍。
    const price = state.allIn.base * (p.looked ? 2 : 1);
    // 看牌不占行动权，所以闷牌的人可以在表态阶段先看牌再决定，倍率当场从 1 跳到 2，
    // 有可能超过他的身家（base 是按他闷牌时算出来的）。这时把实付夹到他的全部筹码：
    // 「看牌把自己的价翻倍了」就该推光筹码，这本来就是 all-in 的本义，
    // 比给他一个点下去只会报错的按钮好。
    const paid = pay(state, p, price);
    p.lastAction = payLabel('接梭哈', paid, price);
    pushLog(state, `${p.name} ${paid < price ? '全押' : ''}接下 ${state.allIn.initiatorName} 的梭哈`);
    state.allIn.accepted.push(p.id);
    state.allIn.pending = state.allIn.pending.filter((id) => id !== p.id);
    advanceAllIn(state);
    return;
  }
  const cost = callCost(state, p);
  if (p.chips <= 0) throw new GameError('你已经全押，本局不需要再出资');
  const paid = pay(state, p, cost);
  p.lastAction = payLabel('跟', paid, cost);
  pushLog(state, `${p.name} ${paid < cost ? `全押跟 ${paid}` : `跟注 ${paid}`}`);
  // 打空的人不再收锅：他还在局里等结算，牌局交给还有钱的人继续打。
  // 真的没人能出资了，advanceTurn 里的 noMoreBetting 会直接开牌。
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

/**
 * 梭哈 = **全押**。发起人把自己全部筹码推出去，不看别人有多少钱。
 *
 * 一条硬规则托着这件事：**梭哈永远不该比跟注便宜**。所以钱不够跟注的人
 * 根本没有梭哈 —— 他的出路是全押跟、全押比牌或者弃牌（`pay` 会夹到全部筹码，
 * 结算走边池），而不是用一个比跟注还小的数把全桌拖进表态。
 */
function doAllIn(state: RoomState, actorId: string) {
  const p = requireTurn(state, actorId);
  if (state.allIn) throw new GameError('已经有人梭哈了');
  const active = activePlayers(state);
  if (active.length < 2) throw new GameError('没有可以开牌的对手');
  if (p.chips <= 0) throw new GameError('没有可梭哈的积分');
  if (p.chips <= callCost(state, p)) {
    throw new GameError('筹码不够跟注，只能全押跟、全押比牌或弃牌');
  }
  if (!canAllInNow(state)) {
    throw new GameError(`第 ${state.settings.allInFromRound} 轮起才能主动梭哈`);
  }

  // 全部身家押上；base 是把它换算回闷牌口径的单价，之后不再变。
  const amount = p.chips;
  const base = allInBase(state, p);
  const paid = pay(state, p, amount);
  p.lastAction = `梭哈 ${paid}`;
  const M = state.settings.maxPlayers;
  const order = active
    .filter((q) => q.id !== p.id)
    .sort((a, b) => ((a.seat - p.seat + M) % M) - ((b.seat - p.seat + M) % M));
  state.allIn = {
    initiatorId: p.id,
    initiatorName: p.name,
    base,
    amount: paid,
    pending: order.map((q) => q.id),
    accepted: [p.id],
  };
  pushLog(state, `${p.name} 梭哈 ${paid}，等其他人表态`);
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
  /*
   * 已经推光的人不用（也没法）再表态：他一分钱都掏不出来，问他「接不接」只有
   * 「弃牌」一个可点，等于因为没钱把他赶出一局他本来有权留下的牌。
   * 直接算作留在局里等结算 —— 他能争到的只有自己出资覆盖的那几层边池。
   */
  for (const id of [...pendingAllIn.pending]) {
    const q = state.players.find((x) => x.id === id);
    if (!q || q.chips > 0) continue;
    pendingAllIn.pending = pendingAllIn.pending.filter((x) => x !== id);
    if (!pendingAllIn.accepted.includes(id)) pendingAllIn.accepted.push(id);
  }

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
    // 梭哈开牌：`state.allIn` 上面刚被清掉，所以「是谁把他们逼上桌面的」
    // 必须显式传进去，不能在 forceShowdown 里回头去读它（读到的永远是 undefined）。
    forceShowdown(state, initiator, '梭哈开牌', true);
  } else {
    finishRound(state, [initiator], '无人接梭哈', []);
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
    /*
     * 少一个人**不影响单价**。梭哈价是发起人的全部身家，从头到尾就是那个数 ——
     * 谁走谁留都改不了他押了多少。以前这里会按剩下的人重算（`rebaseAllIn`），
     * 那是「按最短一家封顶」那套房规的补丁，房规废了，补丁也一并拆掉。
     */
    advanceAllIn(state);
    return;
  }
  /*
   * 弃牌的人不一定是当前行动者（弃牌不占行动权）。他一走，桌上可能就只剩
   * 一个还有钱的人和若干已经全押的人 —— 这时候没有下注可打了，得当场开牌，
   * 不能等到「轮到谁」才发现，否则牌局停在一个永远不会到来的回合上。
   */
  if (noMoreBetting(state)) {
    const anchor = showdownAnchor(state);
    if (anchor) {
      forceShowdown(state, anchor, '已无人能继续出资，直接开牌');
      return;
    }
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
  if (p.chips <= 0) throw new GameError('你已经全押，本局不需要再出资');
  const paid = pay(state, p, cost);
  // 比牌 = 两个人把牌亮给对方看。双方互相可见，其他人看不到。
  markSeen(state, p.id, target.id);
  markSeen(state, target.id, p.id);
  const result = compareHands(p.hand, target.hand, state.settings.special235);
  const loser = result > 0 ? target : p;
  const winner = result > 0 ? p : target;
  loser.status = 'folded';
  loser.lastAction = `比牌负于 ${winner.name}`;
  winner.lastAction = `比牌胜 ${loser.name}`;
  if (paid < cost) p.lastAction = `全押比牌 ${paid}`;
  // 比过牌的两个人都是「牌面上定过输赢」的，本局无论最后怎么结束都要摊给全场。
  // 局还没结束的中途，双方的牌仍然只有当事人互相看得到（走 seen），
  // 旁观者要等到结算才看得见 —— 那才是真实牌桌上的规矩。
  winner.bared = true;
  loser.bared = true;
  // 「谁比掉他他找谁」：把「是这个人把我打下去的」记在输家身上，随结算带给情绪层。
  loser.knockedOutBy = winner.id;
  pushLog(state, `${p.name} ${paid < cost ? `全押 ${paid} ` : ''}与 ${target.name} 比牌，${loser.name} 出局`);
  if (maybeFinish(state, '比牌决出胜负')) return;
  // 比牌费把自己掏空了也不立刻收锅：人还在局里，交给 advanceTurn 判断还有没有下注可打
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
  | {
      type: 'settings';
      turnSeconds?: number;
      allInFromRound?: number;
      maxRounds?: number;
      autoContinue?: boolean;
      dealMode?: DealMode;
    }
  | { type: 'emote'; id: string; target?: string }
  | { type: 'leave' };

export const COMMAND_TYPES = new Set<GameCommand['type']>([
  'ready', 'rename', 'start', 'look', 'call', 'all_in', 'raise', 'fold', 'compare',
  'add_bot', 'remove_player', 'top_up', 'new_round', 'emote', 'leave', 'settings',
]);

export function applyCommand(
  state: RoomState,
  actorId: string,
  command: GameCommand,
  /** 这一步他想了多久（毫秒）。机器人传 `BotAction.thinkMs`；真人省略，按时限回推。 */
  spentMs?: number,
): void {
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
      // 名字和头像纯粹是「我想让别人怎么称呼我」，不是牌桌状态，任何时候都能改。
      // 之前卡在准备阶段才让改：随手起的「牌友3271」打了两把想换个名字，
      // 得等一整局打完，凭空多出来一道没人受益的门槛。
      const name = cleanName(command.name);
      if (state.players.some((p) => p.id !== actor.id && p.name === name)) throw new GameError('这个昵称已经有人用了');
      const before = actor.name;
      actor.name = name;
      actor.avatar = cleanAvatar(command.avatar);
      if (before !== name) pushLog(state, `${before} 改名为 ${name}`);
      return;
    }
    case 'start': return startRound(state, actorId);
    // 笔记要在动作生效**之前**记：一旦状态改完，「他是顶着一次加注弃的牌」就找不回来了。
    case 'look': noteAction(state, actor, 'look', spentMs); return doLook(state, actorId);
    case 'call': noteAction(state, actor, 'call', spentMs); return doCall(state, actorId);
    case 'all_in': noteAction(state, actor, 'all_in', spentMs); return doAllIn(state, actorId);
    case 'raise': noteAction(state, actor, 'raise', spentMs); return doRaise(state, actorId, command.unit);
    case 'fold': noteAction(state, actor, 'fold', spentMs); return doFold(state, actorId);
    case 'compare': noteAction(state, actor, 'compare', spentMs); return doCompare(state, actorId, command.targetId);
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
        // 0 = 不封顶
        state.settings.maxRounds = command.maxRounds <= 0 ? 0 : clamp(command.maxRounds, 2, 20);
        changed.push(state.settings.maxRounds ? `${state.settings.maxRounds} 轮封顶` : '不封顶');
      }
      if (typeof command.autoContinue === 'boolean') {
        state.settings.autoContinue = command.autoContinue;
        changed.push(command.autoContinue ? '自动续局开' : '自动续局关');
      }
      /**
       * 发牌档位。三个入口（网页 / 命令行 / MCP）共用这一段：取值在这里校验，
       * 切换的日志也在这里写，谁改的都会在房间日志里留下同一句话。
       *
       * 上面那道 `phase === 'playing'` 的闸门已经保证了「下一局生效」：
       * 正在打的这一局不会有人的手牌被换掉。
       */
      if (command.dealMode !== undefined) {
        if (!isDealMode(command.dealMode)) throw new GameError('发牌档位只能是 standard 或 party');
        if (command.dealMode !== state.settings.dealMode) {
          state.settings.dealMode = command.dealMode;
          pushLog(state, `已切换到${DEAL_MODE_LABEL[command.dealMode]}发牌，下一局生效`);
        }
      }
      if (changed.length) pushLog(state, `房规调整：${changed.join('、')}`);
      return;
    }
    case 'emote': {
      if (!EMOTES.includes(command.id)) throw new GameError('无效的表情');
      if (command.target && !state.players.some(p => p.id === command.target && p.id !== actorId)) {
        throw new GameError('表情对象不在牌桌上');
      }
      actor.emote = { id: command.id, at: Date.now(), target: command.target };
      actor.emoted = (actor.emoted ?? 0) + 1;
      return;
    }
    case 'add_bot': {
      requireHost(state, actorId);
      if (state.phase !== 'lobby') throw new GameError('只能在准备阶段添加电脑玩家');
      if (state.players.length >= state.settings.maxPlayers) throw new GameError('房间已满');
      const used = new Set(state.players.map((p) => p.seat));
      let seat = 0;
      while (used.has(seat)) seat++;
      // 每桌从名册的八个人里随机抽不重复的角色；一桌最多五个机器人，
      // 名字多于座位，所以排在后面的人（小雨、阿彪）不会被固定顺序挤掉。
      const available = BOT_NAMES
        .map((name, index) => ({ name, index }))
        .filter(({ name }) => !state.players.some((p) => p.name === name));
      const chosen = available.length ? available[randomIndex(available.length)] : null;
      const name = chosen?.name ?? `电脑${seat + 1}`;
      const id = randomId('bot');
      state.players.push({
        id, name, avatar: BOT_AVATARS[chosen?.index ?? 0], seat,
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

/**
 * 真人来了，让一台电脑把位置腾出来。
 *
 * 房间坐满不等于没位置：房主拉了几台电脑陪打，把房号发给朋友，朋友点进来
 * 看到「房间已满」是说不通的 —— 桌上明明有五个不是人的。只有六个座位全是
 * 真人的时候，「已满」才是真的满。
 *
 * 赶谁走是有讲究的：先挑**已经不在这手牌里**的电脑（弃了牌或者输光了的），
 * 拿走它不影响任何人正在打的这个池子；同一档里再挑筹码最少的，
 * 让桌上的钱尽量留在还在打的人手里。实在只剩还在牌里的电脑，
 * 就按掉线代弃的老规矩替它弃掉再请出去 —— 它已经投进池子的钱留在池子里，
 * 对还在打的人来说和这台电脑自己认输是一回事。
 *
 * @returns 空出来的座位号；房间里一台电脑都没有时返回 null。
 */
export function evictBotForHuman(state: RoomState): number | null {
  const bots = state.players.filter((p) => p.isBot);
  if (!bots.length) return null;
  const inThisHand = (p: PlayerState) => (state.phase === 'playing' && p.status === 'active' ? 1 : 0);
  const victim = bots.slice().sort(
    (a, b) => inThisHand(a) - inThisHand(b) || a.chips - b.chips || a.seat - b.seat,
  )[0];

  if (state.phase === 'playing' && victim.status === 'active') {
    const wasTurn = state.turnSeat === victim.seat;
    victim.status = 'folded';
    victim.lastAction = '让座弃牌';
    pushLog(state, `${victim.name} 让座给新来的玩家，本局弃牌`);
    // 顺序不能反：先让这手牌把「少了一家」消化掉，再把人从名单里拿走。
    if (!maybeFinish(state) && wasTurn) advanceTurn(state, victim.seat);
  }

  const seat = victim.seat;
  state.players = state.players.filter((p) => p.id !== victim.id);
  pushLog(state, `${victim.name} 离开房间，把位置让给新玩家`);
  if (state.hostId === victim.id) claimHostIfVacant(state, state.players[0]?.id ?? '');
  return seat;
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
    p.knockedOutBy = undefined;
    p.emoted = 0;
    p.hand = [];
    p.bet = 0;
    // 上一局打完继续留在座位上的人默认还在局 —— 每一局都要重新点准备是最烦的一步。
    p.ready = true;
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
  // 够条件就接着自动开下一局，倒计时同样让客户端看得见
  state.nextAt = canAutoStart(state) ? Date.now() + AUTO_START_MS : undefined;
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

/* --------------------------------------------------------------- 视图 */

export type PublicPlayer = Omit<PlayerState, 'tokenHash' | 'hand'> & { hand: Card[]; hasHand: boolean };
export type PublicRoom = Omit<RoomState, 'players'> & { players: PublicPlayer[]; viewerId: string };

/** 生成给某个玩家看的房间视图：别人的暗牌永远不出现在响应里。 */
export function sanitizeRoom(state: RoomState, viewerId: string): PublicRoom {
  const publicIds = new Set(state.result?.revealed ?? []);
  // 只有这个观看者有权看到的人（比牌对手），别人拿不到
  const privateIds = new Set(state.seen?.[viewerId] ?? []);
  const visible = (id: string) => publicIds.has(id) || privateIds.has(id);

  /*
   * 结算面板同样按观看者裁剪：比牌双方能看到彼此，旁观者只看到公开摊牌的部分。
   * 唯一的加法是**自己那一张**：一局无论怎么结束（别人全弃、比牌、梭哈、摊牌、平局），
   * 闷着打完的人都该知道自己刚才拿的是什么 —— 那是他自己的牌，从来不是别人的信息。
   * 只加进这一份给他本人的视图里，`state.result.revealed` 一个字都不改，
   * 所以别人的载荷里既看不到他的牌，也不会因此多看到任何人的牌。
   */
  let result = state.result;
  if (result) {
    const mine = (id: string) => id === viewerId;
    const shown = state.players
      .filter((p) => p.hand.length === 3 && (visible(p.id) || mine(p.id)))
      .map((p) => p.id);
    result = {
      ...result,
      revealed: shown,
      hands: Object.fromEntries(
        state.players.filter((p) => shown.includes(p.id)).map((p) => [p.id, p.hand.map((c) => ({ ...c }))]),
      ),
    };
  }

  // seen 是服务端的记账，没必要下发（它能透露谁和谁比过牌）；
  // reads / memory 是喂给电脑玩家的打法统计，真人自己看桌子就好，不必多下发一份表。
  const { seen: _seen, reads: _reads, memory: _memory, ...rest } = state;
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
      // 局已经结束了，闷牌那道门槛（看不见换半价）也就到期了：把自己那手交还给他
      const settled = state.phase === 'round_end';
      const show = (p.id === viewerId && (p.looked || beatenOut || settled)) || visible(p.id);
      return { ...safe, hand: show ? hand.map((c) => ({ ...c })) : [], hasHand: hand.length === 3 };
    }),
  };
}
