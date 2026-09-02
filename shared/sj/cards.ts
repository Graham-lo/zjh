/**
 * 升级（两副牌）的牌、花色组、大小顺序、相邻关系与分值。
 *
 * 和 shared/game.ts 一样刻意与运行时无关：只用 Node / 浏览器都有的全局
 * （crypto.getRandomValues、structuredClone），不 import 任何服务端模块。
 * 服务端、客户端、命令行共用这一份顺序表 —— 大小判定只要有两份实现就一定会打架。
 *
 * 规范出处：docs/shengji/DESIGN.md 第 1.1 / 1.2 / 1.5 节。
 */

export type SjSuit = 'S' | 'H' | 'C' | 'D' | 'J';
/** 真花色（王的 'J' 不算） */
export type SjPlainSuit = 'S' | 'H' | 'C' | 'D';
/** 一局的主：某个花色，或者无主 */
export type SjTrumpSuit = SjPlainSuit | 'NT';
/** 花色组：主牌一组，其余每门副牌各一组。一张牌只属于一个组（DESIGN 1.2） */
export type SjGroup = 'T' | SjPlainSuit;

export interface SjCard {
  /** 全局唯一，形如 S5a / S5b / JBa。id 自带花色和点数，所以「已打出的牌」只传 id 就够客户端渲染 */
  id: string;
  suit: SjSuit;
  /** 2–14（J=11 Q=12 K=13 A=14），小王 15，大王 16 */
  rank: number;
}

/**
 * 判定大小/花色组所需的全部上下文：本局的主与级牌点数。
 *
 * `trump` 允许为 null —— 发牌到亮主定下来之前还没有主花色，但**王和级牌无论如何都是主牌**，
 * 这时按无主处理刚好正确，客户端就能在亮主之前先把手牌排好序。
 */
export interface SjCtx {
  trump: SjTrumpSuit | null;
  level: number;
}

/** 可注入的随机源，返回 [0,1)。不传就用 crypto 的无模偏实现 */
export type SjRng = () => number;

export const SJ_SUITS: SjPlainSuit[] = ['S', 'H', 'C', 'D'];
export const SUIT_SYMBOL: Record<SjSuit, string> = { S: '♠', H: '♥', C: '♣', D: '♦', J: '🃏' };
export const SUIT_NAME: Record<SjPlainSuit, string> = { S: '黑桃', H: '红桃', C: '梅花', D: '方块' };

export const RANK_SMALL_JOKER = 15;
export const RANK_BIG_JOKER = 16;

/** 牌面点数 → id 里的单字符。用单字符是为了让 id 恒为 3 字符，好切分也好肉眼读 */
const RANK_CODE: Record<number, string> = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: 'S', 16: 'B',
};
const CODE_RANK: Record<string, number> = Object.fromEntries(
  Object.entries(RANK_CODE).map(([rank, code]) => [code, Number(rank)]),
);

/* --------------------------------------------------------- 主牌组内的档位
 *
 * 主牌组里除了主花色的普通牌，还有四档「跳出点数体系」的牌。给它们排在
 * 普通牌（0–11）之上，一个 number 就同时表达了「谁大」和「谁挨着谁」。
 */
/** 副级牌：其他三色的级牌，三者**相等**（DESIGN 1.2），所以共用一个档位 */
const ORDER_OFF_LEVEL = 12;
/** 主级牌：主花色的级牌 */
const ORDER_MAIN_LEVEL = 13;
const ORDER_SMALL_JOKER = 14;
const ORDER_BIG_JOKER = 15;

/* ------------------------------------------------------------------ 牌与 id */

export function cardId(suit: SjSuit, rank: number, copy: 'a' | 'b'): string {
  return `${suit}${RANK_CODE[rank]}${copy}`;
}

/**
 * 从 id 还原一张牌。
 *
 * 打出去的牌是公开信息，协议里只传 id；客户端靠这个函数把它还原成牌面，
 * 不需要服务端额外下发牌对象，也就不存在「顺手把没打出的牌一起发出去」的泄密面。
 */
export function cardFromId(id: string): SjCard {
  const suit = id[0] as SjSuit;
  const rank = CODE_RANK[id[1]];
  return { id, suit, rank };
}

/** 两副牌共 108 张：四门花色 2–A 各两张，加两小王两大王 */
export function createSjDeck(): SjCard[] {
  const deck: SjCard[] = [];
  for (const suit of SJ_SUITS) {
    for (let rank = 2; rank <= 14; rank++) {
      for (const copy of ['a', 'b'] as const) deck.push({ id: cardId(suit, rank, copy), suit, rank });
    }
  }
  for (const rank of [RANK_SMALL_JOKER, RANK_BIG_JOKER]) {
    for (const copy of ['a', 'b'] as const) deck.push({ id: cardId('J', rank, copy), suit: 'J', rank });
  }
  return deck;
}

/** 无模偏的 [0, maxExclusive)，和 shared/game.ts 里的是同一套拒绝采样 */
function cryptoIndex(maxExclusive: number): number {
  const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
  const arr = new Uint32Array(1);
  do crypto.getRandomValues(arr);
  while (arr[0] >= limit);
  return arr[0] % maxExclusive;
}

/**
 * Fisher–Yates 洗牌。
 *
 * 默认走 crypto 的拒绝采样（无模偏）；`rng` 只在测试里注入 ——
 * 模糊测试要能用种子复现，真实牌局则一律用 crypto，不给「牌是可预测的」留任何口子。
 */
export function shuffleSj(deck: SjCard[], rng?: SjRng): SjCard[] {
  const a = deck.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng ? Math.floor(rng() * (i + 1)) : cryptoIndex(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ------------------------------------------------------------ 花色组与大小 */

/** 这张牌属于哪个花色组（DESIGN 1.2：王和所有级牌都归主牌组） */
export function groupOf(card: SjCard, ctx: SjCtx): SjGroup {
  if (card.suit === 'J') return 'T';
  if (card.rank === ctx.level) return 'T';
  if (ctx.trump && ctx.trump !== 'NT' && card.suit === ctx.trump) return 'T';
  return card.suit;
}

export function isTrumpCard(card: SjCard, ctx: SjCtx): boolean {
  return groupOf(card, ctx) === 'T';
}

/** 2–A 去掉级牌点数后的升序位置（0–11）。级牌被整个体系跳过，所以打 10 时 9 与 J 相邻 */
function rankIndex(rank: number, level: number): number {
  return rank < level ? rank - 2 : rank - 3;
}

/**
 * 一张牌在**它所属花色组**里的位置。这一个数同时承担两件事：
 *
 * 1. **比大小**：同组内数字大的赢（DESIGN 1.2）。
 * 2. **判相邻**：差 1 就是相邻，能连成拖拉机（DESIGN 1.5）。
 *
 * 之所以能合成一个函数，是因为升级的"大小"本来就是一条链：
 * `T色2 … T色A → 副级牌 → 主级牌 → 小王 → 大王`。把链上的位置编号，
 * 顺序和相邻就都出来了。副级牌三色共用一个编号，于是它们**相等、且互不相邻**，
 * 正好是规范要的那条「三色副级牌不能连成拖拉机」。
 *
 * 跨组的数字没有可比性，比较前必须先确认 `groupOf` 相同。
 */
export function cardOrder(card: SjCard, ctx: SjCtx): number {
  const hasTrumpSuit = !!ctx.trump && ctx.trump !== 'NT';
  if (card.suit === 'J') {
    const big = card.rank === RANK_BIG_JOKER;
    // 无主时主牌组只有 级牌(0) → 小王(1) → 大王(2)，链短了但形状一样（DESIGN 1.2 / 1.5）
    if (!hasTrumpSuit) return big ? 2 : 1;
    return big ? ORDER_BIG_JOKER : ORDER_SMALL_JOKER;
  }
  if (card.rank === ctx.level) {
    if (!hasTrumpSuit) return 0;
    return card.suit === ctx.trump ? ORDER_MAIN_LEVEL : ORDER_OFF_LEVEL;
  }
  return rankIndex(card.rank, ctx.level);
}

/** 两张牌是不是**相邻**（同组且链上差 1）。拖拉机就靠它连起来 */
export function isAdjacent(a: SjCard, b: SjCard, ctx: SjCtx): boolean {
  if (groupOf(a, ctx) !== groupOf(b, ctx)) return false;
  return Math.abs(cardOrder(a, ctx) - cardOrder(b, ctx)) === 1;
}

/** 同组内比大小：>0 表示 a 大，0 表示相等（三色副级牌、两副同牌） */
export function compareInGroup(a: SjCard, b: SjCard, ctx: SjCtx): number {
  return Math.sign(cardOrder(a, ctx) - cardOrder(b, ctx));
}

/** 两张牌是不是"完全相同的牌"——同花色同点数，来自两副。对子的判定标准（DESIGN 1.5） */
export function isSameCard(a: SjCard, b: SjCard): boolean {
  return a.suit === b.suit && a.rank === b.rank;
}

/* ------------------------------------------------------------------ 分值 */

/** 5 = 5 分，10 = 10 分，K = 10 分，全场 200 分（DESIGN 1.1） */
export function pointsOf(card: SjCard): number {
  if (card.suit === 'J') return 0;
  if (card.rank === 5) return 5;
  if (card.rank === 10 || card.rank === 13) return 10;
  return 0;
}

export function sumPoints(cards: SjCard[]): number {
  let total = 0;
  for (const c of cards) total += pointsOf(c);
  return total;
}

export function pointCards(cards: SjCard[]): SjCard[] {
  return cards.filter((c) => pointsOf(c) > 0);
}

/* --------------------------------------------------------------- 排序与展示 */

/** 花色组在手牌里的排列次序：主牌在左，随后 ♠♥♣♦（DESIGN 3.3） */
const GROUP_RANK: Record<SjGroup, number> = { T: 0, S: 1, H: 2, C: 3, D: 4 };

/**
 * 手牌排序：主牌在左，随后 ♠♥♣♦，组内从大到小。
 *
 * 同一档位的牌（三色副级牌、两副同牌）再按花色和 id 排 —— 不是为了大小，
 * 是为了让**完全相同的两张牌永远挨在一起**，玩家一眼就能看出哪里有对子。
 */
export function sortSjHand(cards: SjCard[], ctx: SjCtx): SjCard[] {
  return cards.slice().sort((a, b) => {
    const ga = GROUP_RANK[groupOf(a, ctx)];
    const gb = GROUP_RANK[groupOf(b, ctx)];
    if (ga !== gb) return ga - gb;
    const d = cardOrder(b, ctx) - cardOrder(a, ctx);
    if (d) return d;
    if (a.suit !== b.suit) return SJ_SUITS.indexOf(a.suit as SjPlainSuit) - SJ_SUITS.indexOf(b.suit as SjPlainSuit);
    if (a.rank !== b.rank) return b.rank - a.rank;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function cardLabel(card: SjCard): string {
  if (card.suit === 'J') return card.rank === RANK_BIG_JOKER ? '大王' : '小王';
  const face = card.rank === 10 ? '10' : RANK_CODE[card.rank];
  return `${SUIT_SYMBOL[card.suit]}${face}`;
}

export function cardsLabel(cards: SjCard[]): string {
  return cards.map(cardLabel).join(' ');
}

export function trumpLabel(trump: SjTrumpSuit | null): string {
  if (!trump) return '未定';
  return trump === 'NT' ? '无主' : SUIT_NAME[trump];
}

export function levelLabel(level: number): string {
  return level === 10 ? '10' : RANK_CODE[level];
}
