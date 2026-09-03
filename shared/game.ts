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
  /**
   * 封顶轮数：到达后强制全员开牌。**0 = 不封顶**，一直打到分出胜负为止。
   *
   * 不封顶不等于会打不完：底注升到最高档之后每轮翻倍（见 advanceTurn），
   * 筹码是有限的，所以每个人在有限几轮内一定会被逼到「梭哈或者弃牌」。
   * 收敛靠的是经济压力，不是一刀切的轮数。
   */
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
  /**
   * 本局到目前为止的动作序列（'look' | 'call' | 'raise' | 'compare' | 'all_in'）。
   *
   * 只有 lastAction 是看不懂牌的：连加两手和「加一手之后缩回去只跟」是完全相反的两个故事，
   * 但最后一个动作都是「跟」。机器人要读故事，就得看整串。全是公开动作，不含任何暗牌信息。
   */
  handActions?: string[];
  /**
   * 上头程度，−1 到 1，只有电脑玩家有。
   *
   * 正数是输了大钱之后想追回来（放宽起手、加注变凶、诈唬变多），
   * 负数是刚被抓或者刚赢了一大笔之后想守住（收紧、少冒险）。
   * 每局按 0.72 衰减，大概三局回到常态 —— 真人的情绪也差不多是这个尺度。
   */
  tilt?: number;
  /** 最近一次表情，客户端用来播浮动动画 */
  emote?: { id: string; at: number };
}

/**
 * 一个玩家的**公开**打法笔记，跨局累积。
 *
 * 每一项都只来自桌面上人人都能看到的东西：他做过的动作，以及摊牌时亮出来的牌。
 * 暗牌永远不进这里 —— 这和真人坐在桌边记牌是同一回事，不是开天眼。
 */
export interface TableRead {
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
   * 跨局累积的打法笔记，key 是玩家 id。
   *
   * 只喂给电脑玩家，不下发给客户端（真人自己看桌子就好，不需要一份统计表）。
   * 内容全部来自公开信息，见 TableRead。
   */
  reads?: Record<string, TableRead>;
}

/** 一次梭哈的表态过程 */
export interface PendingAllIn {
  initiatorId: string;
  initiatorName: string;
  /**
   * 梭哈的**闷牌单价**，发起时定死。每家实际要掏 `base * (looked ? 2 : 1)` ——
   * 和跟注、加注、比牌一样的 1:2 定价，闷牌半价、看牌双倍。
   */
  base: number;
  /**
   * **发起人自己押上的金额**（= base × 他当时的倍率），只用于播报展示
   * 「XX 梭哈了 890」。**不要拿它当成每家要付的数** —— 闷牌的人付一半，
   * 看牌的人付两倍，各家的价要用 base 现算。
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

/* --------------------------------------------------------- 娱乐增强发牌 */

/**
 * 每手牌的目标牌型（千分比）。四类大牌占 92%；散牌和对子保留在 8% 的长尾，
 * 避免完全失去牌型落差。顺金与豹子合计 25%，让强牌碰撞明显增多。
 */
export const ZJH_HAND_DISTRIBUTION_PER_MILLE = {
  flush: 380,
  straight: 290,
  trips: 130,
  straightFlush: 120,
  highCard: 50,
  pair: 30,
} as const;

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

/** 公开成纯函数，让概率边界能被测试锁定。 */
export function dealCategoryForRoll(roll: number): DealCategory {
  if (!Number.isInteger(roll) || roll < 0 || roll >= 1000) throw new GameError('发牌随机数越界');
  let edge = ZJH_HAND_DISTRIBUTION_PER_MILLE.flush;
  if (roll < edge) return 4;
  edge += ZJH_HAND_DISTRIBUTION_PER_MILLE.straight;
  if (roll < edge) return 3;
  edge += ZJH_HAND_DISTRIBUTION_PER_MILLE.trips;
  if (roll < edge) return 6;
  edge += ZJH_HAND_DISTRIBUTION_PER_MILLE.straightFlush;
  if (roll < edge) return 5;
  edge += ZJH_HAND_DISTRIBUTION_PER_MILLE.highCard;
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
export function dealWeightedHands(handCount: number, pick: IndexPicker = randomIndex): Card[][] {
  if (!Number.isInteger(handCount) || handCount < 1 || handCount > 6) throw new GameError('发牌人数不合法');
  const plans = Array.from({ length: handCount }, () => dealCategoryForRoll(pick(1000)));
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
 * 估算一手牌能打败随机一手牌的比例（0–1）。
 *
 * 用娱乐增强后的牌型频率做分段，再按同类型内的大小在段内线性插值。
 * 机器人靠它算胜率，客户端靠它显示"牌力"；散牌与对子只占低频长尾。
 */
const CATEGORY_BANDS: Record<number, [number, number]> = {
  1: [0.0, 0.05], // 散牌 5%
  2: [0.05, 0.08], // 对子 3%
  3: [0.08, 0.37], // 顺子 29%
  4: [0.37, 0.75], // 金花 38%
  5: [0.75, 0.87], // 顺金 12%
  6: [0.87, 1.0], // 豹子 13%
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
  state.settings = { ...DEFAULT_SETTINGS, ...(state.settings ?? {}) };
  // 初始/重置筹码与下注档位是全服经济规则，不是房主可调整的房规；旧房间恢复后也必须升级。
  state.settings.startingChips = DEFAULT_SETTINGS.startingChips;
  state.settings.ante = DEFAULT_SETTINGS.ante;
  state.settings.betOptions = [...DEFAULT_SETTINGS.betOptions];
  // 旧存档里存着 8 轮封顶。封顶与否是玩法规则不是房主偏好，恢复时统一到当前默认（不封顶）。
  state.settings.maxRounds = DEFAULT_SETTINGS.maxRounds;
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
    p.handActions ??= [];
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
  if (state.allIn) state.allIn.base ??= state.allIn.amount;
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

/* ------------------------------------------------------- 打法笔记（全部是公开信息） */

const EMPTY_READ: TableRead = {
  hands: 0, played: 0, aggressive: 0, passive: 0,
  pressureFaced: 0, foldsToPressure: 0, showdowns: 0, showdownStrength: 0, bluffsCaught: 0,
};

export function tableRead(state: RoomState, playerId: string): TableRead {
  return { ...EMPTY_READ, ...state.reads?.[playerId] };
}

function editRead(state: RoomState, playerId: string): TableRead {
  state.reads ??= {};
  state.reads[playerId] ??= { ...EMPTY_READ };
  return state.reads[playerId];
}

/**
 * 记下一个动作。**必须在动作真正生效之前调用** —— 「他是在面对加注的情况下弃的牌」
 * 这个信息，等牌局状态改完就找不回来了。
 */
function noteAction(state: RoomState, actor: PlayerState, kind: string) {
  if (state.phase !== 'playing' || actor.status !== 'active') return;
  const read = editRead(state, actor.id);
  // 「有人加注过或者有人梭哈」= 他这一步是顶着压力做的
  const underPressure = !!state.allIn
    || state.betUnit > state.settings.betOptions[0]
    || state.players.some((p) => p.id !== actor.id && p.status === 'active' && p.handActions?.includes('raise'));

  if (kind !== 'look') {
    actor.handActions = [...(actor.handActions ?? []), kind];
    if (underPressure) read.pressureFaced += 1;
  }
  if (kind === 'raise' || kind === 'all_in' || kind === 'compare') read.aggressive += 1;
  else if (kind === 'call') read.passive += 1;
  else if (kind === 'fold' && underPressure) read.foldsToPressure += 1;
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
    const read = editRead(state, p.id);
    read.hands += 1;
    // 「下过场」= 底注之外还投过钱，或者至少看了牌打下去
    if (p.bet > state.settings.ante || (p.handActions?.length ?? 0) > 0) read.played += 1;
    if (result.revealed.includes(p.id) && result.hands[p.id]?.length === 3) {
      const strength = handPercentile(result.hands[p.id]);
      read.showdowns += 1;
      read.showdownStrength += strength;
      // 亮出来的牌很烂却一路打到摊牌 —— 这个人是敢吹的
      if (strength < 0.42 && read.aggressive > 0) read.bluffsCaught += 1;
    }
  }
  noteTilt(state, result);
}

/**
 * 情绪结账。真人输一大笔之后会想追回来，而且越是刚才「牌不差还是输了」越上头；
 * 刚赢一大笔的人会稍微放开一点打，但远不如输钱的反应强烈。
 * 有耐心的人格上头得轻，这样六台电脑的情绪曲线不会整齐划一。
 */
function noteTilt(state: RoomState, result: RoundResult) {
  for (const p of state.players) {
    if (!p.isBot) continue;
    // 先衰减：情绪撑不过三四局
    let tilt = (p.tilt ?? 0) * 0.72;
    const delta = result.deltas.find((d) => d.id === p.id)?.delta ?? 0;
    const stake = Math.max(1, p.chips + Math.abs(delta));
    const share = Math.abs(delta) / stake;
    const temper = 1 - botPersonality(p).patience;
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
 * 梭哈的**闷牌单价**：在保证每个还在局的人都掏得起自己那一份的前提下，
 * 能取到的最大闷牌价。每家实付 `base * (looked ? 2 : 1)`。
 *
 * 用最短的一家封顶，是为了让所有人都跟得起 —— 梭哈会把全部在局玩家拉进底池然后开牌，
 * 如果金额高过某人的身家，那个人就成了被迫破产，不公平。
 * 但「跟得起」要按各自的倍率算：看牌的人一份要掏两倍，所以他能撑住的闷牌价只有 chips/2。
 * 拿 floor(chips / 倍率) 取最小，才是真正人人掏得起的那条线。
 */
export function allInBase(state: { players: { status: PlayerStatus; chips: number; looked: boolean }[] }): number {
  const caps = state.players
    .filter((p) => p.status === 'active')
    .map((p) => Math.floor(p.chips / (p.looked ? 2 : 1)));
  return caps.length ? Math.max(0, Math.min(...caps)) : 0;
}

/**
 * 某个玩家梭哈要掏多少 —— 闷牌一份、看牌两份，和 callCost/compareCost 同一套比例。
 * 梭哈过去是全场同价，那是这套定价里唯一的例外，现在补上了。
 */
export function allInCost(
  state: { players: { status: PlayerStatus; chips: number; looked: boolean }[] },
  player: { looked: boolean },
): number {
  return allInBase(state) * (player.looked ? 2 : 1);
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
  };
  noteRoundResult(state);
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
         * 几轮就会被顶到「跟不起」，那时 canAllInNow 放行、决策层只剩梭哈或弃牌，
         * 牌局必然收口。不用数轮数，让钱去逼出胜负。
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

  const hands = dealWeightedHands(entrants.length);
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
    const amount = Math.min(price, p.chips);
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

  const base = allInBase(state);
  if (base <= 0) throw new GameError('没有可梭哈的积分');
  const amount = base * (p.looked ? 2 : 1);

  // 发起人先按自己的倍率把钱押上，然后按行动顺序问其他人接不接。
  // base 是按各家倍率封顶算出来的，所以每个人都掏得起自己那一份 —— 但掏不掏是他自己的选择。
  pay(state, p, amount);
  p.lastAction = `梭哈 ${amount}`;
  const M = state.settings.maxPlayers;
  const order = active
    .filter((q) => q.id !== p.id)
    .sort((a, b) => ((a.seat - p.seat + M) % M) - ((b.seat - p.seat + M) % M));
  state.allIn = {
    initiatorId: p.id,
    initiatorName: p.name,
    base,
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
  | { type: 'emote'; id: string }
  | { type: 'leave' };

export const COMMAND_TYPES = new Set<GameCommand['type']>([
  'ready', 'rename', 'start', 'look', 'call', 'all_in', 'raise', 'fold', 'compare',
  'add_bot', 'remove_player', 'top_up', 'new_round', 'emote', 'leave', 'settings',
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
    case 'look': noteAction(state, actor, 'look'); return doLook(state, actorId);
    case 'call': noteAction(state, actor, 'call'); return doCall(state, actorId);
    case 'all_in': noteAction(state, actor, 'all_in'); return doAllIn(state, actorId);
    case 'raise': noteAction(state, actor, 'raise'); return doRaise(state, actorId, command.unit);
    case 'fold': noteAction(state, actor, 'fold'); return doFold(state, actorId);
    case 'compare': noteAction(state, actor, 'compare'); return doCompare(state, actorId, command.targetId);
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
      if (changed.length) pushLog(state, `房规调整：${changed.join('、')}`);
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
      // 每桌从六种人格里随机抽不重复的角色；最多五个机器人，所以狡诈型等风格不会总被固定顺序挤掉。
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

/* ------------------------------------------------------------- 机器人 AI */

export interface BotPersonality {
  /** 主动加注、比牌和价值梭哈的倾向 */
  aggression: number;
  /** 在边缘赔率下继续游戏的宽松程度 */
  looseness: number;
  /** 合适局面下诈唬的频率 */
  bluffRate: number;
  /** 愿意为了获取信息而看牌、避开高波动的程度 */
  patience: number;
  /** 愿意用有效筹码承受波动的程度 */
  riskTolerance: number;
  /** 强牌慢打、弱牌代表强牌的混合程度 */
  deception: number;
  /** 根据桌况偏离基础性格的幅度 */
  adaptability: number;
}

const BOT_PERSONALITIES: Record<string, BotPersonality> = {
  阿凯: { aggression: 0.78, looseness: 0.58, bluffRate: 0.10, patience: 0.38, riskTolerance: 0.72, deception: 0.42, adaptability: 0.66 },
  老陈: { aggression: 0.36, looseness: 0.34, bluffRate: 0.03, patience: 0.86, riskTolerance: 0.32, deception: 0.35, adaptability: 0.48 },
  小北: { aggression: 0.58, looseness: 0.72, bluffRate: 0.09, patience: 0.50, riskTolerance: 0.58, deception: 0.55, adaptability: 0.72 },
  阿杰: { aggression: 0.72, looseness: 0.46, bluffRate: 0.07, patience: 0.44, riskTolerance: 0.75, deception: 0.46, adaptability: 0.62 },
  小林: { aggression: 0.48, looseness: 0.40, bluffRate: 0.04, patience: 0.78, riskTolerance: 0.44, deception: 0.38, adaptability: 0.82 },
  老王: { aggression: 0.64, looseness: 0.56, bluffRate: 0.16, patience: 0.58, riskTolerance: 0.64, deception: 0.88, adaptability: 0.86 },
};

/**
 * 性格跟着机器人身份走，不会每一步随机换人格。预置机器人各有明显风格，
 * 额外创建的机器人则从 id 稳定派生一套均衡参数。
 */
export function botPersonality(bot: Pick<PlayerState, 'id' | 'name'>): BotPersonality {
  const preset = BOT_PERSONALITIES[bot.name];
  if (preset) return { ...preset };
  const trait = (name: string) => pseudoRandom(`${bot.id}:personality:${name}`);
  return {
    aggression: 0.35 + trait('aggression') * 0.45,
    looseness: 0.30 + trait('looseness') * 0.45,
    bluffRate: 0.03 + trait('bluff') * 0.13,
    patience: 0.35 + trait('patience') * 0.50,
    riskTolerance: 0.30 + trait('risk') * 0.48,
    deception: 0.30 + trait('deception') * 0.58,
    adaptability: 0.40 + trait('adaptability') * 0.48,
  };
}

interface BotOpponentView {
  id: string;
  seat: number;
  chips: number;
  looked: boolean;
  bet: number;
  wins: number;
  lastAction?: string;
  /** 本局的完整动作序列 */
  actions: string[];
  /** 跨局累积的公开笔记 */
  read: TableRead;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/** 这里只提取公开字段，刻意没有 hand；后面的决策代码拿不到对手暗牌。 */
function botOpponentViews(state: RoomState, bot: PlayerState): BotOpponentView[] {
  return state.players
    .filter((p) => p.id !== bot.id && p.status === 'active')
    .map((p) => ({
      id: p.id,
      seat: p.seat,
      chips: p.chips,
      looked: p.looked,
      bet: p.bet,
      wins: p.wins,
      lastAction: p.lastAction,
      actions: [...(p.handActions ?? [])],
      read: tableRead(state, p.id),
    }));
}

/**
 * 这一局他讲了个什么故事。
 *
 * 只看最后一个动作是读不懂牌的：「连加两手」和「加了一手之后缩回去只跟」
 * 是完全相反的两个意思，可最后一个动作都是「跟」。人读牌读的是整串动作，
 * 尤其是**节奏的变化** —— 突然发力和突然刹车，都是信息。
 */
function storyHeat(actions: string[]): number {
  if (!actions.length) return 0.08;
  const count = (kind: string) => actions.filter((a) => a === kind).length;
  const raises = count('raise');
  const calls = count('call');
  const last = actions[actions.length - 1];

  if (count('all_in')) return 0.95;
  // 连续发力：加了不止一次，几乎不可能是空气
  if (raises >= 2) return 0.88;
  if (raises === 1) {
    // 加完之后又只跟 —— 踩了刹车，这是变弱的信号，比一直没动过还可疑
    const braked = actions.indexOf('raise') < actions.lastIndexOf('call');
    return braked ? 0.44 : 0.70;
  }
  // 比过牌还站着，说明他手上真有东西 —— 这是被牌面证明过的强度
  if (count('compare')) return 0.66;
  if (calls >= 3) return 0.40;
  if (calls === 2) return 0.32;
  if (calls === 1) return 0.24;
  return last === 'look' ? 0.15 : 0.10;
}

/**
 * 这个人的凶悍值多少钱。
 *
 * 同一个加注，从一整晚只打过三把牌的紧手嘴里说出来，和从每手都加的疯子嘴里说出来，
 * 完全不是一回事。真人靠的就是这个 —— 记住谁老实、谁爱吹，然后据此打折或者加价。
 * 样本不够时按常人算，不瞎猜。
 */
function credibility(read: TableRead): number {
  if (read.hands < 3) return 1;
  const acts = read.aggressive + read.passive;
  const aggressionRate = acts >= 6 ? read.aggressive / acts : 0.35;
  // 他愿意亮出来的牌一般有多硬。0.6 是这套牌型分布下的常态基准。
  const showdownStrength = read.showdowns >= 2 ? read.showdownStrength / read.showdowns : 0.6;
  const caught = Math.min(0.25, read.bluffsCaught * 0.09);
  return clamp01(1.15 - aggressionRate * 0.75 + (showdownStrength - 0.6) * 0.5 - caught);
}

/** 一个对手当下有多可怕：他讲的故事 × 他这个人的可信度。 */
function opponentThreat(view: BotOpponentView): number {
  return clamp01(storyHeat(view.actions) * credibility(view.read));
}

/**
 * 偷池成功率：一加注就把所有人吓走的概率。
 *
 * 人不是随机诈唬的，是**挑人**诈唬 —— 桌上都是一加就跑的人才值得去偷，
 * 有一个说什么都要跟的站在那里，这个池子就偷不动。所以要连乘，不是取平均。
 */
function foldEquity(opponents: BotOpponentView[]): number {
  if (!opponents.length) return 1;
  return opponents.reduce((product, o) => {
    const r = o.read;
    // 还没看够这个人的时候按常人算 0.5：炸金花绝大多数手牌是散牌，面对加注
    // 跑掉本来就是多数派。之前这里写 0.42，两家对手一乘只剩 0.17，刚好卡在
    // 诈唬门槛下面 —— 实测九百多次加注里只有一次诈唬，等于这套牌桌上没人吹牛。
    const folds = r.pressureFaced >= 3 ? clamp01(r.foldsToPressure / r.pressureFaced) : 0.5;
    return product * clamp01(0.12 + folds * 0.82);
  }, 1);
}

function tablePressure(state: RoomState, opponents: BotOpponentView[]): number {
  if (!opponents.length) return 0;
  const actionPressure = opponents.reduce((sum, p) => sum + opponentThreat(p), 0) / opponents.length;
  const commitment = opponents.reduce(
    (sum, p) => sum + Math.min(1, p.bet / Math.max(state.settings.ante, state.pot)),
    0,
  ) / opponents.length;
  const looked = opponents.filter((p) => p.looked).length / opponents.length;
  /**
   * 底注被抬到了什么价位，本身就是桌上最响的一个信号。
   *
   * 只统计「谁做过什么动作」会漏掉这一层：一手牌从开局底注打到几十倍，
   * 哪怕这一轮大家都只是平跟，场面也早就不是开局那个场面了。
   * 翻到十六倍算满档（log2 除以 4），再往上就是同一个「已经在开火」的量级。
   */
  const escalation = clamp01(
    Math.log2(Math.max(1, state.betUnit) / Math.max(1, state.settings.betOptions[0])) / 4,
  );
  return clamp01(actionPressure * 0.46 + commitment * 0.22 + looked * 0.12 + escalation * 0.20);
}

/** 每个公开局面上的随机量是确定的：可复测，也不会因为改了对手暗牌而改变。 */
function botRoll(state: RoomState, bot: PlayerState, purpose: string): number {
  return pseudoRandom(`${bot.id}:${state.handNo}:${state.roundNo}:${state.turnCount}:${state.actionSeq}:${purpose}`);
}

/**
 * 基础性格只是长期倾向，临场会切换档位：高压/短码收紧，后位单挑或大筹码领先时施压，
 * 后段则减少试探。adaptability 决定偏离基础人格能有多远。
 */
function adaptPersonality(
  base: BotPersonality,
  state: RoomState,
  bot: PlayerState,
  opponents: BotOpponentView[],
  pressure: number,
  position: number,
  costFraction: number,
): BotPersonality {
  const p = { ...base };
  const shift = base.adaptability;
  const averageOpponentStack = opponents.length
    ? opponents.reduce((sum, opponent) => sum + opponent.chips, 0) / opponents.length
    : bot.chips;

  if (pressure >= 0.58 || costFraction >= 0.12) {
    // 防守档：对手持续施压或一口价已伤到身家时，连激进型也会收紧范围。
    p.aggression -= 0.18 * shift;
    p.looseness -= 0.22 * shift;
    p.bluffRate *= 1 - 0.72 * shift;
    p.riskTolerance -= 0.16 * shift;
    p.patience += 0.12 * shift;
  } else if (opponents.length <= 2 && position >= 0.5 && pressure < 0.34) {
    // 偷池档：人少、后位、没人表现强势时，稳健型也会扩大施压与诈唬频率。
    p.aggression += 0.16 * shift;
    p.looseness += 0.10 * shift;
    p.bluffRate *= 1 + 0.85 * shift;
    p.riskTolerance += 0.08 * shift;
  }

  if (bot.chips >= averageOpponentStack * 1.35 && state.pot <= bot.chips * 0.45) {
    // 大筹码档：利用覆盖优势，但仍受底池赔率约束，不做无脑碾压。
    p.aggression += 0.12 * shift;
    p.bluffRate *= 1 + 0.35 * shift;
    p.riskTolerance += 0.06 * shift;
  }

  if (state.roundNo >= 4) {
    // 收口档：后段减少试探和慢吞吞的边缘跟注，更明确地做价值或退出。
    p.aggression += 0.08 * shift;
    p.looseness -= 0.08 * shift;
    p.patience -= 0.10 * shift;
  }

  /**
   * 情绪档。
   *
   * 输了一大笔之后想追回来 —— 起手放宽、加注变凶、诈唬变多、耐心变差，
   * 这是真人牌桌上最普遍也最贵的一个漏洞，电脑玩家有它才像人。
   * 赢麻了的人则是另一种松：敢下注，但不会去追不该追的注。
   * 情绪不受 adaptability 约束：上头本来就是绕过理性的东西。
   */
  const tilt = bot.tilt ?? 0;
  if (tilt > 0.02) {
    p.aggression += 0.24 * tilt;
    p.looseness += 0.30 * tilt;
    p.bluffRate *= 1 + 1.1 * tilt;
    p.patience -= 0.22 * tilt;
    p.riskTolerance += 0.20 * tilt;
  } else if (tilt < -0.02) {
    // 缩着打：刚被抓到吹牛之后，人会有一阵子只用真牌说话。
    p.aggression += 0.18 * tilt;
    p.bluffRate *= Math.max(0, 1 + 1.3 * tilt);
    p.looseness += 0.16 * tilt;
  }

  return {
    ...p,
    aggression: clamp01(p.aggression),
    looseness: clamp01(p.looseness),
    bluffRate: clamp01(p.bluffRate),
    patience: clamp01(p.patience),
    riskTolerance: clamp01(p.riskTolerance),
  };
}

/**
 * 真正会陪你走到开牌的人数。
 *
 * 炸金花绝大多数底池是靠别人弃牌收掉的，六个人坐着不等于六个人跟你比大小。
 * 按在座人数直接做指数，会把胜率压到荒谬的低位（中等金花在六人桌上只剩 5%），
 * 于是所有机器人第一轮集体弃牌 —— 这就是「电脑一直弃牌、每局都打不起来」的来源。
 * 这里按「第一家一定要过，后面每多一家只有约一半真会跟到底」折算。
 */
function effectiveField(opponentCount: number): number {
  return 1 + Math.max(0, opponentCount - 1) * 0.5;
}

/** 下注阶段的胜率：牌力是「打赢一家」的概率，按有效对手数放大。 */
function winEquity(singleOpponentPercentile: number, opponentCount: number): number {
  return Math.pow(clamp01(singleOpponentPercentile), effectiveField(opponentCount));
}

/** 摊牌已成定局（梭哈接受之后）时，所有人都真的要比，不能再打折。 */
function showdownEquity(singleOpponentPercentile: number, opponentCount: number): number {
  return Math.pow(clamp01(singleOpponentPercentile), Math.max(1, opponentCount));
}

/**
 * 闷牌时的先验胜率。
 *
 * **不能拿 0.5 当牌力再去做指数**：0.5^5 只有 3%，低于任何底池赔率，闷着的机器人
 * 必然弃牌，而闷牌恰恰是最便宜的一档价 —— 这是弃牌率失控的另一半原因。
 * 一手完全未知的牌拿下底池的概率就是「这一桌里最好的那家是我」= 1/(有效家数)。
 */
function blindEquity(opponentCount: number): number {
  return 1 / (1 + effectiveField(opponentCount));
}

/** 比牌只按公开投入、动作强度和座次挑目标，不使用目标的 hand。 */
function compareTarget(
  state: RoomState,
  bot: PlayerState,
  opponents: BotOpponentView[],
): BotOpponentView | undefined {
  const M = state.settings.maxPlayers;
  return [...opponents].sort((a, b) => {
    const score = (p: BotOpponentView) =>
      opponentThreat(p) * 2
      + p.bet / Math.max(1, state.pot)
      + (p.looked ? 0.18 : 0)
      + Math.min(0.12, p.wins * 0.005);
    const byThreat = score(b) - score(a);
    if (Math.abs(byThreat) > 1e-9) return byThreat;
    return ((a.seat - bot.seat + M) % M) - ((b.seat - bot.seat + M) % M);
  })[0];
}

/** 一步决策：动作本身，加上「他该想多久」。 */
export interface BotAction {
  cmd: GameCommand;
  /** 服务器按这个毫秒数排延迟再执行 */
  thinkMs: number;
}

/**
 * 该想多久。
 *
 * 真人的用时不是随机的，是跟着**这一步有多难**走的，而且用时本身就是一种信息：
 *  - 早就想好的动作秒出 —— 看牌、闷牌跟个底注，手比脑子快；
 *  - 常规决策一秒上下；
 *  - 真正接近的边缘局面会「下潜」，盯着底池算三四秒，这是最像人的一处；
 *  - 上头的人出手更快 —— 情绪本来就是绕过思考的；
 *  - 还有人会演：拿着大牌故意拖一拖装犹豫，或者反过来秒跟装作无所谓。
 *    这一层由 deception 决定，所以同一个局面在不同电脑手里节奏不一样。
 *
 * 上限压在行动时限的一半，绝不能把真人晾到超时。
 */
function thinkTime(
  state: RoomState,
  bot: PlayerState,
  cmd: GameCommand,
  hardness: number,
  personality: BotPersonality,
): number {
  const cap = Math.max(700, state.settings.turnSeconds * 1000 / 2 - 200);
  const jitter = botRoll(state, bot, `think:${cmd.type}`);
  if (cmd.type === 'look') return Math.round(260 + jitter * 260);

  // 难度 0 → 秒出；难度 1 → 下潜。指数让中间地带不至于全都拖成三秒。
  let ms = 380 + Math.pow(clamp01(hardness), 1.35) * 3200;

  const theatre = botRoll(state, bot, `theatre:${cmd.type}`);
  if (theatre < personality.deception * 0.28) ms *= 1.9;            // 装犹豫
  else if (theatre > 1 - personality.deception * 0.18) ms *= 0.35;  // 秒跟装弱

  const tilt = bot.tilt ?? 0;
  if (tilt > 0.2) ms *= 1 - Math.min(0.45, tilt * 0.5);             // 上头就不想了

  return Math.round(Math.min(cap, Math.max(240, ms * (0.80 + jitter * 0.45))));
}

/** 边缘程度：离「跟或弃」的分界线越近，人想得越久。0.14 之内算真正难受的区间。 */
function hardnessFromMargin(margin: number): number {
  return clamp01(1 - Math.abs(margin) / 0.14);
}

/**
 * 给一个机器人算出下一步。纯函数，不改状态 —— 服务器拿到结果后带延迟执行，
 * 这样电脑玩家看起来像在思考，而不是在人类点完的瞬间全部行动完毕。
 *
 * 信息边界在进入决策层前就强制执行：对手 hand 永远清空，机器人没看牌时自己的
 * hand 也清空。以后即使有人误写了读取暗牌的策略，拿到的也只会是空数组。
 */
export function botDecision(state: RoomState, bot: PlayerState): GameCommand {
  return botAction(state, bot).cmd;
}

/** 和 botDecision 同一套判断，额外给出该「想」多久。信息边界在这里统一执行。 */
export function botAction(state: RoomState, bot: PlayerState): BotAction {
  const players = state.players.map((p) => ({
    ...p,
    hand: p.id === bot.id && bot.looked ? p.hand : [],
  }));
  const visibleState: RoomState = {
    ...state,
    players,
    // 机器人只会在 playing 阶段行动；显式清掉可能含历史摊牌的结果与定向可见表。
    result: undefined,
    seen: {},
  };
  const visibleBot = players.find((p) => p.id === bot.id);
  if (!visibleBot) throw new GameError('机器人不在当前房间');
  return decideBot(visibleState, visibleBot);
}

function decideBot(state: RoomState, bot: PlayerState): BotAction {
  const opponents = botOpponentViews(state, bot);
  const opponentCount = Math.max(1, opponents.length);
  const basePersonality = botPersonality(bot);
  const pressure = tablePressure(state, opponents);
  const cost = callCost(state, bot);
  const costFraction = cost / Math.max(1, bot.chips);
  const effectiveStack = Math.max(1, Math.min(bot.chips, ...opponents.map((p) => p.chips)));
  const stackToPot = effectiveStack / Math.max(1, state.pot);
  const activeCount = opponents.length + 1;
  const position = activeCount <= 2 ? 1 : (state.turnCount % activeCount) / (activeCount - 1);
  const personality = adaptPersonality(
    basePersonality, state, bot, opponents, pressure, position, costFraction,
  );
  const act = (cmd: GameCommand, hardness: number): BotAction =>
    ({ cmd, thinkMs: thinkTime(state, bot, cmd, hardness, personality) });

  // 有人梭哈时只有两条路：接或者弃。先看牌，再按赔率决定。
  if (state.allIn) {
    if (!bot.looked) return act({ type: 'look' }, 0);
    // 上一步已经保证看过牌了，所以这里的价一定是双倍那一档 —— 别拿发起人的实付当自己的价。
    // 刚才那一下看牌可能把价顶过了身家，接受时服务端会夹到全部筹码，赔率也按这个实付算。
    if (bot.chips <= 0) return act({ type: 'fold' }, 0);
    const price = Math.min(state.allIn.base * 2, bot.chips);
    const showdownOpponents = Math.max(1, state.allIn.accepted.filter((id) => id !== bot.id).length);
    const strength = handPercentile(bot.hand);
    const equity = showdownEquity(strength, showdownOpponents);
    const potOdds = price / Math.max(1, state.pot + price);
    const riskTax = (1 - personality.riskTolerance) * 0.055 + pressure * 0.035;
    const temperament = (personality.looseness - 0.5) * 0.045;
    // 接一个全场开牌的注是整局最重的一步，越接近临界越该想久一点。
    const margin = equity + temperament - (potOdds + riskTax);
    // 底线难度 0.3：哪怕账算得很清楚，这一下也不该秒答。
    const hardness = Math.max(0.3, hardnessFromMargin(margin));
    return act(margin >= 0 ? { type: 'call' } : { type: 'fold' }, hardness);
  }

  // 闷牌便宜且能隐藏信息，但注码、对手压力或轮次升高时，理性的玩家会先看牌再决定。
  if (!bot.looked) {
    const informationNeed = clamp01(
      0.18 + personality.patience * 0.48 + pressure * 0.34 + costFraction * 2.2 + (state.roundNo - 1) * 0.25,
    );
    if (state.roundNo >= 2 || costFraction >= 0.045 || botRoll(state, bot, 'look') < informationNeed) {
      return act({ type: 'look' }, 0);
    }
  }

  // 看了牌用真实分位；闷着的时候只有先验，不能假装自己拿了一手正中间的牌。
  const strength = bot.looked ? handPercentile(bot.hand) : 0.5;
  const equity = bot.looked ? winEquity(strength, opponentCount) : blindEquity(opponentCount);
  const potOdds = cost / Math.max(1, state.pot + cost);
  /**
   * 要多少胜率才值得跟。
   *
   * looseness 这一项**必须给足权重**，否则每台电脑都被赔率算式压成同一个人：
   * 实测六台不同人格的机器人打五百局，攻击性、遇压弃牌率、摊牌牌力三项全部
   * 一模一样，桌上根本分不出谁是谁。真人牌桌最明显的差别就是松紧 —— 有人什么
   * 牌都想看看，有人一晚上只打三把 —— 所以这里按 ±0.08 的幅度拉开，
   * 大到足以盖过边缘局面的胜率差，又不至于让人拿着烂牌去追大注。
   */
  const requiredEquity = clamp01(
    potOdds
      + pressure * 0.075
      + costFraction * (1 - personality.riskTolerance) * 0.10
      - 0.025
      - (personality.looseness - 0.5) * 0.16
      - position * 0.022,
  );
  // 诈唬要**挑人**，不是掷骰子：桌上站着一个说什么都要跟的人，这个池子就偷不动。
  // 反过来，一桌都是一加就跑的人，连老实型也会开始伸手 —— 真人就是这么打的。
  const steal = foldEquity(opponents);
  /**
   * 闷牌加注 —— 炸金花里最常见、也最便宜的一记虚张声势。
   *
   * 闷着只付一半价，位置又好、场上还没人发力的时候，真人几乎人人都会来这么一手：
   * 它赌的**不是当场把所有人吓跑**，而是「没人知道我手里是什么」这件事本身值钱，
   * 顺带把自己塑造成一上来就打的人，后面拿真牌才有人跟。
   * 所以这一档不受偷池概率约束，只要便宜、有位置、场面没炸就行。
   */
  const blindRaise = !bot.looked
    && position >= 0.4
    && pressure < 0.34
    && costFraction < 0.05
    && botRoll(state, bot, 'blind-raise')
      < personality.bluffRate * 1.6 + personality.deception * 0.10;
  /** 看了牌还拿烂牌去加注，那就是真的在偷池子，得先确认这一桌偷得动。 */
  const stealBluff = bot.looked
    && position >= 0.5
    && pressure < 0.34
    && stackToPot >= 3
    /**
     * 只看「偷得动的概率」，不再另外写一条人数上限。
     *
     * steal 本身就是所有对手一起弃牌的概率，人越多它自己就掉得越快
     * （常人一家 0.53，两家 0.28，三家 0.15，四家 0.08），拿它当唯一的闸门，
     * 「人多不偷、人少常偷」是算出来的结果而不是硬写的规则。
     * 门槛取 0.14：底池通常有单注的好几倍，一成半的成功率就已经回本，
     * 何况偷不成手里还有牌。之前那条 opponentCount <= 2 才是真正的死结 ——
     * 六人桌上几乎凑不齐这个条件，实测上千次加注一次诈唬都没有。
     */
    && steal >= 0.14
    && strength < 0.40
    && botRoll(state, bot, 'bluff-raise') < personality.bluffRate * (0.5 + steal * 1.4);
  const plannedBluff = blindRaise || stealBluff;

  if (bot.chips <= cost) {
    // 跟不起了：用真实梭哈价重算底池赔率，不能只因已经投过钱就追注。
    const shove = allInCost(state, bot);
    const shoveOdds = shove / Math.max(1, state.pot + shove);
    const edge = equity + (personality.looseness - 0.5) * 0.05 - (1 - personality.riskTolerance) * 0.035;
    const margin = edge - shoveOdds;
    return act(margin >= 0 ? { type: 'all_in' } : { type: 'fold' }, Math.max(0.25, hardnessFromMargin(margin)));
  }

  // 牌力、赔率、位置和压力共同决定弃牌；性格只影响边缘局面，不会让弱牌无脑追高注。
  const decisionNoise = (botRoll(state, bot, 'continue') - 0.5) * 0.035;
  // 这个差值就是整局最有信息量的一个数：贴着零的时候，人会真的坐在那里算。
  const callMargin = equity + decisionNoise - requiredEquity;
  const marginHardness = hardnessFromMargin(callMargin);
  if (callMargin < 0 && !plannedBluff) return act({ type: 'fold' }, marginHardness);

  // 有虚有实：强牌在前位或已有对手施压时，偶尔只跟一手设陷阱。
  // 这个模式不对外显示，否则“陷阱”本身就失去意义；下一轮会重新按新局面判断。
  //
  // 原来这里还要求 pressure >= 0.16。开局没人动作时 pressure 只有 0.09，
  // 门槛永远够不到，等于整个慢打模式在最该用它的前两轮是死代码。
  const slowPlay = bot.looked
    && strength >= 0.84
    && stackToPot >= 1.35
    && botRoll(state, bot, 'slow-play')
      < personality.deception * (0.22 + pressure * 0.34 + (1 - position) * 0.10);

  /**
   * 强牌什么时候才该兑现。
   *
   * 比牌是把强牌**立刻变现**：只赢到眼下这点底池，还等于把自己的牌力公开。
   * 人不会拿着豹子在第一个能比牌的回合就点开 —— 那是把一手好牌卖成白菜价。
   * 老代码只要 canCompareNow 一放行就出手，于是绝大多数大牌都在比牌刚解锁的
   * 那一回合开牌，桌上看到的就是「电脑一拿豹子就秒开」。
   *
   * 现在要三件事同时成立才动手：
   *  1. **再等一圈**。解锁之后还得让所有人再走一轮，给底池长起来的时间；
   *  2. **底池值得动手** —— 至少是这一刀成本的 8 倍，否则赢下来也不够本；
   *  3. 或者局面本身已经不需要养池了：只剩一个对手、打到后段、对面在猛攻。
   */
  // 用开局人数当一圈的长度：拿 activeCount 会随着别人弃牌一起缩水，
  // 「再等一圈」就变成了「再等两三手」，大牌照样在解锁那一轮就开出去。
  const patientTurn = state.turnCount >= state.compareUnlockAt * 2;
  const potWorthTaking = state.pot >= compareCost(state, bot) * 8;
  const readyToCashOut = opponentCount === 1
    || state.roundNo >= 4
    || pressure >= 0.55
    || (patientTurn && potWorthTaking);

  // 越强的牌越沉得住气，而且这份耐心跟着人格走 —— 老实型早点收网，
  // 狡诈型能一直忍到后段，这样同一手豹子在不同电脑手里打出来不是一个样子。
  // 人多的时候，第 3 轮之前拿着这一档的牌一律不比 —— 这是硬下限，
  // 之后才交给人格去决定还能再忍多久。对面真打起来了（pressure 高）另说。
  // 门槛压到 0.75 —— 那正好是顺金那一档的下沿。写 0.86 只盖得住豹子，
  // 顺金（0.75~0.87）整档漏在外面，实测三千局里还有 4.5% 的大牌在前两轮就开牌，
  // 而在牌桌上顺金和豹子一样是要养池的牌，没人拿着它急着变现。
  const holdingBackMonster = strength >= 0.75
    && opponentCount >= 2
    // 只有对面已经打到梭哈那个量级才值得放弃养池直接开牌；普通的一次加注，
    // 手里有豹子的人该做的是反加，不是把牌亮出来收下这点池子。
    && pressure < 0.72
    && (
      state.roundNo < 3
      || (state.roundNo < 5 && botRoll(state, bot, 'monster-patience') < 0.45 + personality.deception * 0.40)
    );

  // 极强牌在低 SPR 或后段主动收口；极少数老练型机器人会在单挑低压力局面诈唬梭哈。
  if (!slowPlay && canAllInNow(state) && bot.looked) {
    const shove = allInCost(state, bot);
    const shoveOdds = shove / Math.max(1, state.pot + shove);
    const valueShove = strength >= 0.88
      && equity >= shoveOdds + 0.08
      && (stackToPot <= 2.6 || state.roundNo >= 5)
      && botRoll(state, bot, 'value-shove') < 0.22 + personality.aggression * 0.45;
    const bluffShove = opponentCount === 1
      && strength < 0.42
      && pressure < 0.28
      && stackToPot >= 3
      // 单挑梭哈诈唬是最贵的一招，只有对面确实吓得走才做
      && steal >= 0.45
      && botRoll(state, bot, 'bluff-shove') < personality.bluffRate * 0.22;
    // 价值梭哈是想好的，诈唬梭哈是硬着头皮上的 —— 后者该慢一点。
    if (valueShove || bluffShove) return act({ type: 'all_in' }, bluffShove && !valueShove ? 0.8 : 0.45);
  }

  // 牌很好且开放比牌时，优先挑战公开表现最有威胁、投入最多的人。
  if (
    !slowPlay && !holdingBackMonster && readyToCashOut &&
    canCompareNow(state) && opponents.length > 0 && bot.looked &&
    bot.chips > compareCost(state, bot) &&
    strength >= (opponentCount === 1 ? 0.62 : 0.74) &&
    equity >= compareCost(state, bot) / Math.max(1, state.pot + compareCost(state, bot)) + 0.07 &&
    botRoll(state, bot, 'compare') < 0.18 + personality.aggression * 0.42
  ) {
    const target = compareTarget(state, bot, opponents);
    // 挑谁比牌是要在几个人之间权衡的，这一步本来就慢
    if (target) return act({ type: 'compare', targetId: target.id }, 0.55);
  }

  // 价值加注会按牌力、底池和有效筹码选择 2万/5万/10万，而不是永远只点下一档。
  const multiplier = bot.looked ? 2 : 1;
  const affordable = state.settings.betOptions.filter(
    (unit) => unit > state.betUnit && bot.chips > unit * multiplier,
  );
  if (affordable.length) {
    const valueEdge = equity - requiredEquity;
    // 强牌被「先别比牌」拦下来之后必须有出口，否则它只会平跟，池永远养不大。
    // 手多硬才值得加注，这条线**跟着性格走**：凶的人拿一副顺子就敢加，
    // 稳的人非金花不动手。写死一个 0.66 的话，六台电脑的加注频率会齐刷刷
    // 落在同一档，桌上就看不出谁凶谁稳了。
    const raiseFloor = 0.78 - personality.aggression * 0.20;
    const wantValue = !slowPlay && bot.looked
      && strength >= raiseFloor
      && valueEdge >= -0.015
      && botRoll(state, bot, 'value-raise')
        < 0.18 + personality.aggression * 0.55 + Math.max(0, valueEdge) + (holdingBackMonster ? 0.30 : 0);
    const bluffSpot = plannedBluff;

    if (wantValue || bluffSpot) {
      if (bluffSpot && !wantValue) return act({ type: 'raise', unit: affordable[0] }, 0.7);
      const stackFraction = strength >= 0.95 ? 0.46 : strength >= 0.87 ? 0.29 : strength >= 0.74 ? 0.18 : 0.11;
      const targetCost = Math.min(
        bot.chips * 0.66,
        Math.max(state.pot * (0.70 + personality.aggression * 0.75), effectiveStack * stackFraction),
      );
      const sized = affordable.filter((unit) => unit * multiplier <= targetCost);
      const unit = sized.length ? sized[sized.length - 1] : affordable[0];
      // 加多少是个选择题，但方向是笃定的
      return act({ type: 'raise', unit }, 0.4);
    }
  }

  // 闷着跟个底注是不用想的；看过牌之后的边缘跟注才是要掂量的那一种。
  return act({ type: 'call' }, bot.looked ? marginHardness * 0.8 : 0.05);
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

  // seen 是服务端的记账，没必要下发（它能透露谁和谁比过牌）；
  // reads 是喂给电脑玩家的打法统计，真人自己看桌子就好，不必多下发一份表。
  const { seen: _seen, reads: _reads, ...rest } = state;
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
