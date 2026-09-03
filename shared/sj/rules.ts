/**
 * 升级的规则判定：亮主/反主/抄底的级别、首出、跟牌、甩牌、定圈、抠底、升级表、庄家轮转。
 *
 * 除了甩牌校验（要看别人的手牌，只能在服务端跑），其余全部只用**自己的手牌和公开信息**，
 * 客户端拿同一份代码就能把「出牌」按钮点亮或者灰掉并说明原因（DESIGN 1.6 末段）。
 * 客户端和服务端各写一份判定，迟早会出现「显示能出、点了报错」，所以这里一份到底。
 *
 * 规范出处：docs/shengji/DESIGN.md 第 1.4 / 1.4b / 1.5–1.8 节。
 */

import { SJ_VARIANTS, type SjKind } from '../games.ts';
import {
  SJ_SUITS, SUIT_NAME, cardOrder, groupOf, sumPoints,
  type SjCard, type SjCtx, type SjGroup, type SjPlainSuit, type SjTrumpSuit,
} from './cards.ts';
import {
  cardsInGroup, parseShape, primaryUnit, runsOf, unitPriority,
  type SjRun, type SjShape, type SjUnit,
} from './units.ts';

export type SjCheck = { ok: true } | { ok: false; reason: string };

const OK: SjCheck = { ok: true };
const fail = (reason: string): SjCheck => ({ ok: false, reason });

export function groupLabel(group: SjGroup): string {
  return group === 'T' ? '主牌' : SUIT_NAME[group];
}

/* --------------------------------------------------- 反主级别（DESIGN 1.4） */

/** 一次亮法的形式。单张与一对级牌都要带花色，对王不带 */
export type SjDeclKind = 'single' | 'pair' | 'joker_s' | 'joker_b';

/**
 * 反主级别表（DESIGN 1.4）：**对级牌的花色大小 方块 < 梅花 < 红桃 < 黑桃 < 对小王 < 对大王**。
 *
 * 之所以是一张表而不是散在各处的魔法数字：这七档同时被服务端的
 * `readDeclaration`、机器人的候选枚举、客户端的亮主/抄底按钮读，
 * 三处只要有一处对不上，就会出现「按钮点得亮、服务端不收」。
 *
 * `NT` 这一格永远查不到 —— 无主只能由对王亮出来，走的是 `joker_s`/`joker_b` 两格；
 * 给它一个 0 只是为了让这张表在类型上是全的。
 */
export const SJ_DECL_TIER: Record<SjTrumpSuit | 'joker_s' | 'joker_b', number> = {
  NT: 0,
  D: 2,
  C: 3,
  H: 4,
  S: 5,
  joker_s: 6,
  joker_b: 7,
};

/**
 * 一次亮法的强度档位。
 *
 * **单张之间不分花色**，一律是 1：QQ 的「抢亮」是先亮者得，官方只对「对子」列了花色序，
 * 所以 ♠5 单张反不掉 ♦5 单张。将来若要让单张也分花色，只需要改这一处。
 */
export function declStrength(kind: SjDeclKind, suit: SjPlainSuit | null = null): number {
  if (kind === 'joker_s' || kind === 'joker_b') return SJ_DECL_TIER[kind];
  if (kind === 'single') return 1;
  return suit ? SJ_DECL_TIER[suit] : 0;
}

/** 当前主的公开状态。亮主窗口与抄底询问共用同一套判据，所以只取这三个字段 */
export interface SjDeclState {
  suit: SjTrumpSuit | null;
  strength: number;
  declarerId: string | null;
}

export interface SjDeclOption {
  kind: SjDeclKind;
  /** 亮成之后的主 */
  trump: SjTrumpSuit;
  strength: number;
  cards: SjCard[];
}

/**
 * 手里**做得到**的全部亮法，按档位升序（DESIGN 1.4）。
 *
 * 只看手牌，不看当前的主 —— 「够不够强」由 `checkOverride` 单独判。
 * 客户端的亮主条/抄底条和机器人共用这一份枚举，不各写各的。
 */
export function declarationOptions(hand: SjCard[], level: number): SjDeclOption[] {
  const out: SjDeclOption[] = [];
  for (const suit of SJ_SUITS) {
    const levels = hand.filter((c) => c.suit === suit && c.rank === level);
    if (levels.length >= 1) {
      out.push({ kind: 'single', trump: suit, strength: declStrength('single'), cards: [levels[0]] });
    }
    if (levels.length >= 2) {
      out.push({ kind: 'pair', trump: suit, strength: declStrength('pair', suit), cards: levels.slice(0, 2) });
    }
  }
  for (const [rank, kind] of [[15, 'joker_s'], [16, 'joker_b']] as const) {
    const jokers = hand.filter((c) => c.suit === 'J' && c.rank === rank);
    if (jokers.length >= 2) {
      out.push({ kind, trump: 'NT', strength: declStrength(kind), cards: jokers.slice(0, 2) });
    }
  }
  return out.sort((a, b) => a.strength - b.strength);
}

/**
 * 这一手亮法能不能盖过当前的主（DESIGN 1.4 / 1.4b）。
 *
 * 两个场合共用：
 * - `declare`（亮主窗口）：当前亮主者可以用**同花色**的第二张级牌加固；
 * - `chao`（抄底询问）：加固没有意义 —— 那等于自己把刚扣下去的底牌再拿一次，
 *   也就是俗话说的「不能自反」。两个场合都允许用对王把自己的主反成无主。
 *
 * 服务端的 `doDeclare` / `doChao` 与客户端的按钮列表都走这一条，
 * 所以「按钮点得亮」和「服务端收得下」永远是同一件事。
 */
export function checkOverride(
  decl: { trump: SjTrumpSuit; strength: number },
  trump: SjDeclState,
  actorId: string,
  mode: 'declare' | 'chao',
): SjCheck {
  if (decl.strength <= trump.strength) {
    return fail(mode === 'chao' ? '抄底必须比当前的亮主更强' : '反主必须比当前的亮主更强');
  }
  if (trump.declarerId !== actorId) return OK;
  if (decl.trump === 'NT') return OK;
  if (mode === 'declare' && decl.trump === trump.suit) return OK;
  return fail(mode === 'chao' ? '不能自己抄自己的主，只能用对王反成无主' : '不能用别的花色反自己的主');
}

/** 我现在**真的可以亮**的那些亮法。亮主条、抄底条、机器人都取这一份 */
export function legalDeclarations(
  hand: SjCard[], level: number, trump: SjDeclState, actorId: string, mode: 'declare' | 'chao',
): SjDeclOption[] {
  return declarationOptions(hand, level).filter((o) => checkOverride(o, trump, actorId, mode).ok);
}

/* --------------------------------------------------------------- 首出 */

/**
 * 首出合法性：一手牌必须来自同一个花色组（DESIGN 1.5）。
 * 甩牌还要过 `validateThrow`，但那要别人的手牌，只有服务端做得到。
 */
export function validateLead(cards: SjCard[], ctx: SjCtx): SjCheck {
  if (!cards.length) return fail('至少要出一张牌');
  return parseShape(cards, ctx) ? OK : fail('一手牌必须来自同一个花色组');
}

/* --------------------------------------------------------------- 跟牌 */

/** 跟牌时手牌**被迫**摆出来的结构：几条拖拉机、几个对子 */
export interface SjFollowRequirement {
  /** 必须出的拖拉机连对数，降序 */
  tractors: number[];
  /** 必须出的对子数（含没配上的拖拉机降级来的槽位） */
  pairs: number;
}

/** 在若干条连对链里找最合身的一条（长度 ≥ need 且最短），返回下标 */
function bestFit(lens: number[], need: number): number {
  let idx = -1;
  for (let i = 0; i < lens.length; i++) {
    if (lens[i] < need) continue;
    if (idx < 0 || lens[i] < lens[idx]) idx = i;
  }
  return idx;
}

/**
 * 算出跟牌者**至少**要摆出多少结构（DESIGN 1.6 第 2 条）。
 *
 * 按长到短给每条拖拉机找一条够长的链（长链可以拆，所以"≥"就够）；配不上的那条
 * 降级成 n 个对子槽位，和首出本身的对子槽位合并，能用对子填多少就必须填多少。
 * 剩下的槽位随便用单张。
 *
 * 复杂度是 O(链数 × 拖拉机数)，链数最多十几条 —— validateFollow 会在客户端
 * 每次选牌时被调用，不能写成枚举组合的指数级算法。
 */
export function followRequirement(handG: SjCard[], lead: SjShape, ctx: SjCtx): SjFollowRequirement {
  const lens = runsOf(handG, ctx).map((r) => r.len);
  const tractors: number[] = [];
  let pairDemand = lead.pairs;
  for (const need of lead.tractors) {
    const idx = bestFit(lens, need);
    if (idx >= 0) {
      lens[idx] -= need;
      tractors.push(need);
    } else {
      // 手里凑不出这么长的连对，这条拖拉机就退化成 need 个对子槽位
      pairDemand += need;
    }
  }
  const pairsLeft = lens.reduce((a, b) => a + b, 0);
  return { tractors, pairs: Math.min(pairDemand, pairsLeft) };
}

/** 这手牌能不能满足给定的结构要求 */
function meetsRequirement(playG: SjCard[], req: SjFollowRequirement, ctx: SjCtx): SjCheck {
  const lens = runsOf(playG, ctx).map((r) => r.len);
  for (const need of req.tractors) {
    const idx = bestFit(lens, need);
    if (idx < 0) return fail(`手里有 ${need} 连对，必须跟出 ${need} 连对`);
    lens[idx] -= need;
  }
  const pairsLeft = lens.reduce((a, b) => a + b, 0);
  if (pairsLeft < req.pairs) return fail(`手里还有对子，必须出 ${req.pairs} 个对子`);
  return OK;
}

/**
 * 跟牌合法性（DESIGN 1.6）。
 *
 * `hand` 是**出牌前**的完整手牌（含这次要出的牌）。返回不合法时带一句给玩家看的原因，
 * 客户端直接把它显示在出牌按钮下方。
 */
export function validateFollow(hand: SjCard[], lead: SjShape, play: SjCard[], ctx: SjCtx): SjCheck {
  const n = lead.count;
  if (play.length !== n) return fail(`要出 ${n} 张牌`);

  const label = groupLabel(lead.group);
  const handG = cardsInGroup(hand, lead.group, ctx);
  const playIds = new Set(play.map((c) => c.id));
  const playG = cardsInGroup(play, lead.group, ctx);

  // 1. 有 G 必跟 G
  if (handG.length < n) {
    // 不足时 G 全出、其余任意（也就是"垫牌"或"毙"）
    const missing = handG.find((c) => !playIds.has(c.id));
    if (missing) return fail(`手里的${label}不够 ${n} 张，剩下的${label}必须全部打出`);
    return OK;
  }
  if (playG.length !== n) return fail(`手里的${label}够 ${n} 张，必须全出${label}`);

  // 2. 出 G 时结构尽量匹配
  return meetsRequirement(playG, followRequirement(handG, lead, ctx), ctx);
}

/* --------------------------------------------------------------- 甩牌 */

export interface SjThrowFail {
  /** 被打回来、只能出这一个单位 */
  forced: SjUnit;
  reason: string;
}

/** 一家在某个花色组里能拿出的最强单位，用来判甩牌 */
interface GroupPower {
  maxSingle: number;
  maxPair: number;
  runs: SjRun[];
}

function powerOf(hand: SjCard[], group: SjGroup, ctx: SjCtx): GroupPower {
  const cards = cardsInGroup(hand, group, ctx);
  let maxSingle = -1;
  for (const c of cards) maxSingle = Math.max(maxSingle, cardOrder(c, ctx));
  const runs = runsOf(cards, ctx);
  let maxPair = -1;
  for (const r of runs) maxPair = Math.max(maxPair, r.top);
  return { maxSingle, maxPair, runs };
}

/**
 * 甩牌校验（DESIGN 1.5）：其他三家不能用同类单位**严格管上**甩牌中的任何单位。
 *
 * 需要全部手牌，所以只有服务端能判 —— 客户端出牌时无从预判，由服务端裁决后回
 * `sj_throw_fail` 事件。失败时按 QQ 的牌型优先规则，在能被管上的类别里强制出最小单位，
 * 其余退回手中；相同点数只算顶住，不能管上先出的牌。
 */
export function validateThrow(shape: SjShape, otherHands: SjCard[][], ctx: SjCtx): SjThrowFail | null {
  const powers = otherHands.map((h) => powerOf(h, shape.group, ctx));
  const beatable: SjUnit[] = [];
  for (const unit of shape.units) {
    for (const p of powers) {
      if (unit.kind === 'single') {
        if (p.maxSingle > unit.top) {
          beatable.push(unit);
          break;
        }
      } else if (unit.kind === 'pair') {
        if (p.maxPair > unit.top) {
          beatable.push(unit);
          break;
        }
      } else {
        // n 连对要压过别人所有 ≥n 连对，比较用最高牌
        for (const r of p.runs) {
          if (r.len >= unit.span && r.top > unit.top) {
            beatable.push(unit);
            break;
          }
        }
        if (beatable.includes(unit)) break;
      }
    }
  }
  if (!beatable.length) return null;

  /*
   * QQ/传统网络升级的“甩错强制出小”不是在整手牌里一概找最小：
   * 先找确实能被别人管上的牌型；若多种牌型都被管，优先强制出大牌型
   * （拖拉机 > 对子 > 单张），再在该牌型中出最小的一组。
   */
  const priority = Math.max(...beatable.map(unitPriority));
  const forced = beatable
    .filter((u) => unitPriority(u) === priority)
    .sort((a, b) => a.top - b.top)[0];
  return { forced, reason: `甩出的${unitLabel(forced)}能被别人管上` };
}

/**
 * candidate 是否足以覆盖首出结构。
 *
 * “覆盖”而非“完全相等”是 QQ 升级盖毙的关键：首出若是若干散牌，主牌里的对子
 * 当然可以毙；首出含对子/拖拉机时，毙牌里的相应结构只许更多，不能更少。
 */
export function shapeCovers(candidate: SjShape, lead: SjShape): boolean {
  if (candidate.count !== lead.count) return false;
  const lens = candidate.tractors.concat(Array(candidate.pairs).fill(1));
  for (const need of lead.tractors) {
    const idx = bestFit(lens, need);
    if (idx < 0) return false;
    lens[idx] -= need;
  }
  return lens.reduce((sum, n) => sum + n, 0) >= lead.pairs;
}

export function unitLabel(unit: SjUnit): string {
  if (unit.kind === 'single') return '单张';
  if (unit.kind === 'pair') return '对子';
  return `${unit.span} 连对`;
}

export function shapeLabel(shape: SjShape): string {
  if (shape.isThrow) return `甩牌 ${shape.count} 张`;
  return unitLabel(shape.units[0]);
}

/* --------------------------------------------------------------- 定圈 */

export interface SjTrickPlayInput {
  seat: number;
  cards: SjCard[];
}

/**
 * 谁赢这一圈（DESIGN 1.7）。`plays[0]` 必须是首出。
 *
 * 能参与比大小的条件很硬：**结构覆盖首出要求**，且要么全是首出那一组，
 * 要么（首出不是主时）全是主牌来毙。其余的跟法只是垫牌，再大也不参与。
 * 相等时先出者赢 —— 三色副级牌互相相等、两副同牌也相等，这一条是它们的归宿。
 */
export function trickWinner(plays: SjTrickPlayInput[], ctx: SjCtx): { seat: number; index: number } {
  const lead = parseShape(plays[0].cards, ctx);
  if (!lead) throw new Error('首出必须是同一个花色组的牌');
  let bestIndex = 0;
  let bestTrump = 0;
  let bestUnit = primaryUnit(lead);
  for (let i = 1; i < plays.length; i++) {
    const shape = parseShape(plays[i].cards, ctx);
    if (!shape || !shapeCovers(shape, lead)) continue;
    const isTrump = shape.group === 'T' && lead.group !== 'T';
    if (shape.group !== lead.group && !isTrump) continue;
    const unit = primaryUnit(shape);
    const trump = isTrump ? 1 : 0;
    const unitCmp = unitPriority(unit) - unitPriority(bestUnit);
    // 先比主/副，再比最大牌型（拖拉机 > 对子 > 单张），最后比该牌型的最大牌。
    // 全都相等才留给先出者。
    if (
      trump > bestTrump ||
      (trump === bestTrump && (unitCmp > 0 || (unitCmp === 0 && unit.top > bestUnit.top)))
    ) {
      bestIndex = i;
      bestTrump = trump;
      bestUnit = unit;
    }
  }
  return { seat: plays[bestIndex].seat, index: bestIndex };
}

/** 一圈牌里的分数 */
export function trickPoints(plays: SjTrickPlayInput[]): number {
  return plays.reduce((sum, p) => sum + sumPoints(p.cards), 0);
}

/** 这手牌是不是在毙（首出不是主，自己全是主且结构覆盖首出要求） */
export function isTrumping(lead: SjShape, cards: SjCard[], ctx: SjCtx): boolean {
  if (lead.group === 'T') return false;
  const shape = parseShape(cards, ctx);
  return !!shape && shape.group === 'T' && shapeCovers(shape, lead);
}

/* --------------------------------------------------------------- 抠底 */

/**
 * 基础抠底指数换算：`2^n`，上限 ×64。
 *
 * 参数是**首出牌型的对数 + 1**（单张 n=1、对子 n=2、两连对 n=3……），
 * 不是牌的张数。实际牌型一律经 `digMultiplierForLead` 判定。
 */
export function digMultiplier(exponent: number): number {
  return Math.min(64, 2 ** Math.max(1, exponent));
}

/**
 * 抠底番数看**首出牌型**，而不是把一把甩牌的总张数塞进 2^n：
 * 单张 ×2、对子 ×4、两连对拖拉机 ×8、三连对 ×16……即 `2^(1 + 最长拖拉机的对数)`，上限 ×64。
 * 纯散牌甩仍是单抠 ×2；含对子按双抠；含拖拉机按**最长那条拖拉机的对数**。
 * 盖毙不改变倍数 —— 倍数只由首出决定。
 */
export function digMultiplierForLead(cards: SjCard[], ctx: SjCtx): number {
  const shape = parseShape(cards, ctx);
  if (!shape) return 2;
  const longestPairs = shape.tractors[0] ?? (shape.pairs > 0 ? 1 : 0);
  return digMultiplier(1 + longestPairs);
}

/* --------------------------------------------------------------- 升级表 */

export interface SjOutcome {
  /** 闲家是否上台（夺庄） */
  defendersWin: boolean;
  /** 赢的那一队升几级 */
  up: number;
  label: string;
}

/**
 * 闲家得分 → 结果（DESIGN 1.8 的表）。
 *
 * 规范的表在 `0 < s < 5` 上有个洞：分牌只有 5/10/K，罚分 ±10、抠底是乘 2 的幂，
 * 所以 s 永远是 5 的倍数，这段区间现实中到不了。为了这个函数是全函数，把它并进
 * 「有分但不足 40」也就是小光那一档 —— 大光的定义是**一分没有**，得了分就不该算大光。
 */
export function outcomeFor(defenderPoints: number): SjOutcome {
  const s = defenderPoints;
  if (s < 0) return { defendersWin: false, up: 4, label: '倒扣' };
  if (s === 0) return { defendersWin: false, up: 3, label: '大光' };
  if (s < 40) return { defendersWin: false, up: 2, label: '小光' };
  if (s < 80) return { defendersWin: false, up: 1, label: '庄家升一级' };
  if (s < 120) return { defendersWin: true, up: 0, label: '闲家上台' };
  if (s < 160) return { defendersWin: true, up: 1, label: '上台 · 升一级' };
  if (s < 200) return { defendersWin: true, up: 2, label: '上台 · 升两级' };
  return { defendersWin: true, up: 3, label: '上台 · 升三级' };
}

/**
 * 庄家轮转（DESIGN 1.8）：守住 → 庄家的**对家**坐庄；被打下 → 庄家的**下家**坐庄。
 * 下家顺时针必是闲家，所以"被打下"总是换到对方阵营。
 */
export function nextDealerSeat(dealerSeat: number, defendersWin: boolean): number {
  return (dealerSeat + (defendersWin ? 1 : 2)) % 4;
}

/** 升级并夹到阶梯顶（DESIGN 1.8：不能越过顶级） */
export function levelUp(ladder: number[], level: number, up: number): number {
  const idx = Math.max(0, ladder.indexOf(level));
  return ladder[Math.min(idx + up, ladder.length - 1)];
}

export function isTopLevel(ladder: number[], level: number): boolean {
  return level === ladder[ladder.length - 1];
}

/**
 * 通关判定（DESIGN 1.8）：**处于顶级的队作为庄家守住一局**就赢下整场比赛。
 * 顶级的队被打下则留在顶级、丢庄，比赛继续。
 *
 * 注意用的是**这一局开打时**的级别，不是结算后的 —— 靠这一局才升到顶级不算通关。
 */
export function isMatchWon(kind: SjKind, levelBefore: number, outcome: SjOutcome): boolean {
  return !outcome.defendersWin && isTopLevel([...SJ_VARIANTS[kind].ladder], levelBefore);
}

/* --------------------------------------------------------------- 小工具 */

/** 这一组牌是不是全在同一个花色组里 */
export function sameGroup(cards: SjCard[], ctx: SjCtx): boolean {
  if (!cards.length) return false;
  const g = groupOf(cards[0], ctx);
  return cards.every((c) => groupOf(c, ctx) === g);
}
