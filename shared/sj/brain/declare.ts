/**
 * **亮主 / 反主 / 加固 / 抄底**（BRAIN-DESIGN §5.1 / §5.2）。
 *
 * 亮主不是"达标就喊"，是一笔收益账，三选一：**现在亮 / 等着反别人 / 虚晃一枪等抄底**。
 * 而且它发生在**发牌过程中** —— 每来一张牌重算一次，只准看已经到手的那几张。
 *
 * 无人亮主的收尾（用户新规则）：发完再给 8 秒，仍无人亮就默认无主并跳过抄底。
 * 所以"等着抄"的人必须在那 8 秒里自己亮 —— `phase === 'declaring'` 时不再等待。
 */

import {
  RANK_BIG_JOKER, RANK_SMALL_JOKER, SJ_SUITS,
  type SjCard, type SjCtx, type SjGroup, type SjPlainSuit, type SjTrumpSuit,
} from '../cards.ts';
import { allPairs, allTractors, cardsInGroup, runsOf } from '../units.ts';
import {
  SJ_DECL_TIER, declarationOptions, legalDeclarations,
  type SjDeclOption, type SjDeclState,
} from '../rules.ts';

export interface DeclareInput {
  /** 已经到手的牌（发牌途中就是前缀） */
  hand: SjCard[];
  level: number;
  trump: SjDeclState;
  myId: string;
  mySeat: number;
  dealerSeat: number;
  handNo: number;
  /** 当前亮主者是不是我的对家 */
  declarerSeat: number | null;
  /** 已发到第几张（1-based）与总张数 */
  dealt: number;
  total: number;
  phase: 'dealing' | 'declaring' | 'chao';
}

export interface DeclareDecision {
  action: 'declare' | 'wait';
  option: SjDeclOption | null;
  why: string[];
}

const ctxFor = (trump: SjTrumpSuit, level: number): SjCtx => ({
  trump: trump === 'NT' ? null : trump,
  level,
});

/** 若以 `trump` 为主，我手里有几张主 */
export function trumpCountFor(hand: SjCard[], level: number, trump: SjTrumpSuit): number {
  return cardsInGroup(hand, 'T', ctxFor(trump, level)).length;
}

/**
 * 牌力（§5.1）。数值本身没有绝对意义，只用来互相比较（反主 / 抄底的差值门槛）。
 */
export function strengthFor(hand: SjCard[], level: number, trump: SjTrumpSuit): number {
  const ctx = ctxFor(trump, level);
  const trumps = cardsInGroup(hand, 'T', ctx);
  let s = trumps.length;
  for (const c of trumps) {
    if (c.suit === 'J' && c.rank === RANK_BIG_JOKER) s += 1.5;
    else if (c.suit === 'J' && c.rank === RANK_SMALL_JOKER) s += 1.2;
    else if (c.rank === level) s += c.suit === trump ? 1.2 : 0.8;
  }
  s += allPairs(hand, 'T', ctx).length * 1;
  s += allTractors(hand, 'T', ctx).filter((u) => u.span >= 2).length * 2;

  for (const suit of SJ_SUITS) {
    const g = suit as SjGroup;
    const side = cardsInGroup(hand, g, ctx);
    if (!side.length) continue;
    const aces = side.filter((c) => c.rank === 14);
    s += aces.length * 0.5;
    if (aces.length >= 2) s += 0.5;
    if (trump === 'NT') {
      s += side.filter((c) => c.rank === 13).length * 0.4;
      s += runsOf(side, ctx).reduce((a, r) => a + r.len, 0) * 0.4;
    }
    if (side.length <= 2) s += 0.3;                     // 短门是好事：扣底能造缺门
    s -= side.filter((c) => c.rank !== 14).length === side.length && side.length === 1 ? 0.2 : 0;
    if (side.length > 2) s -= side.filter((c) => c.rank !== 14).length * 0.02;
  }
  return s;
}

/** 入场门槛（§5.1）：单张亮要 7 张、对子亮 8 张、对王 9 张；第一局抢庄再 +1 */
export function entryOk(hand: SjCard[], level: number, opt: SjDeclOption, handNo: number): boolean {
  const need = (opt.kind === 'single' ? 7 : opt.kind === 'pair' ? 8 : 9) + (handNo === 1 ? 1 : 0);
  return trumpCountFor(hand, level, opt.trump) >= need;
}

/** 场外**别人**可能拿得出的最高档（我手里每持一张，那一档的对子就不可能在别人手里） */
export function maxOutsideTier(hand: SjCard[], level: number): number {
  let best = 1;                                          // 单张级牌谁都可能有
  for (const suit of SJ_SUITS) {
    if (!hand.some((c) => c.suit === suit && c.rank === level)) best = Math.max(best, SJ_DECL_TIER[suit]);
  }
  if (!hand.some((c) => c.suit === 'J' && c.rank === RANK_SMALL_JOKER)) best = Math.max(best, SJ_DECL_TIER.joker_s);
  if (!hand.some((c) => c.suit === 'J' && c.rank === RANK_BIG_JOKER)) best = Math.max(best, SJ_DECL_TIER.joker_b);
  return best;
}

/**
 * **钓鱼亮主**（§5.1，用户口述）：持多档时先亮最低可用档钓别人抄底，再用最高档反抄。
 * 返回钓饵；三个前提有一个不满足就返回 null。
 */
export function fishingBait(hand: SjCard[], level: number, handNo: number): SjDeclOption | null {
  const opts = declarationOptions(hand, level).filter((o) => o.strength >= 2);
  if (opts.length < 2) return null;
  const top = opts[opts.length - 1];
  const outside = maxOutsideTier(hand, level);
  if (top.strength < outside) return null;                       // 前提一：我收得了网
  if (outside < 2) return null;                                  // 前提三：得有人可能上钩
  // 用对大王收网只能落到无主，那就得无主本身也过关
  if (top.trump === 'NT' && !entryOk(hand, level, top, handNo)) return null;
  for (const bait of opts) {
    if (bait === top) break;
    if (bait.trump === 'NT') continue;
    if (entryOk(hand, level, bait, handNo)) return bait;         // 前提二：钓饵本身能打
  }
  return null;
}

/**
 * 发牌中 / 亮主窗口里的三选一。返回 `wait` 表示这一刻不表态（等下一张牌或等别人先动）。
 */
export function decideDeclare(input: DeclareInput): DeclareDecision {
  const { hand, level, trump, handNo } = input;
  const why: string[] = [];
  const legal = legalDeclarations(hand, level, trump, input.myId, 'declare');
  if (!legal.length) return { action: 'wait', option: null, why: ['手里没有能亮的牌'] };

  const iAmDeclarer = trump.declarerId === input.myId;
  const partnerIsDeclarer = input.declarerSeat != null
    && input.declarerSeat % 2 === input.mySeat % 2 && !iAmDeclarer;
  const lastChance = input.phase !== 'dealing' || input.dealt >= input.total - 5;

  /* --- 加固：一律加固（免费提高档位，还告诉对家我这门长） */
  if (iAmDeclarer && trump.strength === 1) {
    const reinforce = legal.find((o) => o.kind === 'pair' && o.trump === trump.suit);
    if (reinforce) return { action: 'declare', option: reinforce, why: ['加固：同花色第二张级牌'] };
  }

  /* --- 已经有人亮了：只反对手，不反对家 */
  if (trump.suit && !iAmDeclarer) {
    if (partnerIsDeclarer) {
      const nt = legal.find((o) => o.trump === 'NT');
      const cur = trump.suit ? strengthFor(hand, level, trump.suit) : 0;
      if (nt && entryOk(hand, level, nt, handNo) && strengthFor(hand, level, 'NT') - cur >= 4) {
        return { action: 'declare', option: nt, why: ['对家亮的，但我对王无主明显更强'] };
      }
      return { action: 'wait', option: null, why: ['对家亮的主，不反对家'] };
    }
    const cur = trump.suit === 'NT' ? strengthFor(hand, level, 'NT') : strengthFor(hand, level, trump.suit);
    const curCount = trump.suit === 'NT' ? 0 : trumpCountFor(hand, level, trump.suit);
    let best: { opt: SjDeclOption; gain: number } | null = null;
    for (const o of legal) {
      if (!entryOk(hand, level, o, handNo)) continue;
      const gain = strengthFor(hand, level, o.trump) - cur;
      if (!best || gain > best.gain) best = { opt: o, gain };
    }
    if (!best) return { action: 'wait', option: null, why: ['反不动，等'] };
    const bar = curCount <= 3 && best.opt.kind !== 'single' ? 1 : 3;
    if (best.gain >= bar) {
      return { action: 'declare', option: best.opt, why: [`反主：牌力差 ${best.gain.toFixed(1)} ≥ ${bar}`] };
    }
    return { action: 'wait', option: null, why: ['反主收益不够'] };
  }

  /* --- 还没人亮 */
  const usable = legal.filter((o) => entryOk(hand, level, o, handNo));
  if (!usable.length) return { action: 'wait', option: null, why: ['还不达标，继续等牌'] };

  // 第二局起我是闲家方：亮主等于替庄家队选主，只有这门极长才值得
  const iAmDefender = handNo > 1 && input.dealerSeat % 2 !== input.mySeat % 2;
  const strong = usable.filter((o) => o.trump === 'NT'
    ? trumpCountFor(hand, level, 'NT') >= 9
    : trumpCountFor(hand, level, o.trump) >= 9);
  const pool = iAmDefender ? strong : usable;
  if (!pool.length) {
    return { action: 'wait', option: null, why: ['第二局起闲家方不替庄家队选主，主不够长就不亮'] };
  }

  // 同一门花色的单张档和对子档 strength 一样 —— 这时当然取高档（对子反不掉，还多一分威慑）
  const best = pool.reduce((a, b) => {
    const sa = strengthFor(hand, level, a.trump);
    const sb = strengthFor(hand, level, b.trump);
    return sb > sa || (sb === sa && b.strength > a.strength) ? b : a;
  });

  // 发牌前段不亮单张（等对子）
  if (!lastChance && best.kind === 'single' && input.dealt < 12) {
    return { action: 'wait', option: null, why: ['才发到第 ' + input.dealt + ' 张，先等等有没有对子'] };
  }

  // 钓鱼：先亮最低可用档，等别人抄，再用最高档反抄。
  // 发牌途中和 8 秒安静窗口里都成立 —— 窗口里手牌已经发全，收网的把握反而算得更准。
  const bait = fishingBait(hand, level, handNo);
  if (bait && bait !== best) {
    return { action: 'declare', option: bait, why: ['钓鱼：先亮低档，等人抄底再用高档反抄'] };
  }

  if (!lastChance) {
    // 虚晃一枪：牌力远超门槛且有对子档 → 等着反 / 等着抄底
    const bestCount = best.trump === 'NT'
      ? trumpCountFor(hand, level, 'NT')
      : trumpCountFor(hand, level, best.trump);
    const need = (best.kind === 'single' ? 7 : best.kind === 'pair' ? 8 : 9) + (handNo === 1 ? 1 : 0);
    if (best.strength >= 2 && bestCount >= need + 1) {
      return { action: 'wait', option: null, why: ['牌力远超门槛且档位够高，等着反别人或等着抄底'] };
    }
    // 我手里就握着场外到不了的最高档（对王）→ 不急着表态：谁亮我都反得掉、抄得回来
    const myTop = legal.reduce((a, o) => Math.max(a, o.strength), 0);
    if (myTop >= 6 && myTop >= maxOutsideTier(hand, level)) {
      return { action: 'wait', option: null, why: ['手里握着最高档，先看别人怎么亮'] };
    }
  }

  return {
    action: 'declare',
    option: best,
    why: [lastChance ? '快发完了还没人亮，立即亮' : '达标就亮（只有单张档，等不到反别人的机会）'],
  };
}

/**
 * 发牌途中的亮主计划：从第 1 张开始逐张重算，返回**第一次**决定亮主的那一刻。
 *
 * 关键是"第 k 张时的决策只用前 k 张" —— 所以把未发的牌重洗，结果一定一样。
 */
export function planDealingDeclare(
  order: SjCard[], input: Omit<DeclareInput, 'hand' | 'dealt' | 'phase'>,
): { option: SjDeclOption; index: number; why: string[] } | null {
  for (let k = 1; k <= order.length; k++) {
    const d = decideDeclare({
      ...input, hand: order.slice(0, k), dealt: k, phase: 'dealing',
    });
    if (d.action === 'declare' && d.option) return { option: d.option, index: k - 1, why: d.why };
  }
  return null;
}

/* --------------------------------------------------------------- 抄底 */

export interface ChaoInput {
  hand: SjCard[];
  level: number;
  trump: SjDeclState;
  myId: string;
  mySeat: number;
  dealerSeat: number;
  /** 当前亮主者的座位（判断"对手亮的"） */
  declarerSeat: number | null;
  /** 我方持有的主牌绝张（用于闲家方埋分的把握）；没有就 0 */
  closerConfidence?: number;
}

export function decideChao(input: ChaoInput): { option: SjDeclOption; why: string[] } | null {
  const { hand, level, trump } = input;
  const legal = legalDeclarations(hand, level, trump, input.myId, 'chao');
  if (!legal.length) return null;
  const iAmDeclarer = trump.declarerId === input.myId;
  const iAmDealerTeam = input.mySeat % 2 === input.dealerSeat % 2;
  const curSuit = trump.suit;
  const cur = curSuit ? strengthFor(hand, level, curSuit) : 0;
  const curCount = curSuit && curSuit !== 'NT' ? trumpCountFor(hand, level, curSuit) : 0;
  const rivalDeclared = input.declarerSeat != null && input.declarerSeat % 2 !== input.mySeat % 2;

  let best: { opt: SjDeclOption; gain: number; count: number; str: number } | null = null;
  for (const o of legal) {
    const str = strengthFor(hand, level, o.trump);
    const count = o.trump === 'NT' ? trumpCountFor(hand, level, 'NT') : trumpCountFor(hand, level, o.trump);
    const gain = str - cur;
    // 牌力一样就取高档（对大王 > 对小王）—— 反正都是无主，高档没人抄得回来
    if (!best || gain > best.gain || (gain === best.gain && o.strength > best.opt.strength)) {
      best = { opt: o, gain, count, str };
    }
  }
  if (!best) return null;

  // 当前亮主者本人：只能用对王反成无主，且要够强
  if (iAmDeclarer) {
    if (best.opt.trump !== 'NT' || best.count < 9) return null;
    return { option: best.opt, why: ['自反无主：王和级牌够多'] };
  }

  // 新主比我手里的旧主还短，差值不到 2 就不抄（无主不受限，§5.1）
  if (best.opt.trump !== 'NT' && best.count < curCount && best.gain < 2) return null;

  if (iAmDealerTeam) {
    if (best.gain >= 2 || (rivalDeclared && best.count >= 8)) {
      return { option: best.opt, why: ['庄家方抄底：换成我更好的花色，还能重扣一次底'] };
    }
    return null;
  }
  // 闲家方：底牌落到闲家手里，最后一圈自己抠
  const bar = best.opt.trump === 'NT' ? 8 : 9;
  if (best.count >= bar && best.gain >= 2) {
    return { option: best.opt, why: ['闲家方抄底：底牌到我手里，最后一圈自己抠'] };
  }
  return null;
}
