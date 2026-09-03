/**
 * **唯一的评估函数**（BRAIN-DESIGN §4.3）。
 *
 * 首出、跟牌、甩牌、最后一圈全部走这一条式子：
 *
 * ```
 * EV = sign × [ (2·pTeamWin − 1)·trickPts + pTeamWin·tempo
 *               − trumpSpend − winnerSpend − structureBreak
 *               + voidGain + probeValue − giftRisk − throwRisk + digPlan ] × m
 * ```
 *
 * 方括号里是**对我方的好处**（量纲：分），`sign` 把它翻译成"闲家得分的变化"
 * （闲家方 +1、庄家方 −1），`m` 是这一分现在值多少（§4.1）。
 *
 * 于是「80 分前后目标反转」「通关局更保守」「空分局拼大光」这些都是 m 与 sign 算出来的，
 * 没有任何一句 `if (defenderPoints > 80)`。
 *
 * 一个符号上的约定：文档里的 EV 是**闲家得分的变化**，闲家方要它大、庄家方要它小。
 * 排序时统一取大更省心，所以 `SjScored.ev` 存的是 `bracket × m`（我方的好处，
 * 两边都是越大越好），文档口径那个带符号的值放在 `parts.evDefenderDelta` 里。
 * 两者只差一个 `sign`，`m` 与 `sign` 对 80 分反转的作用完全不受影响。
 */

import { groupOf, pointsOf, sumPoints, type SjCard } from '../cards.ts';
import { maxOrder, parseShape } from '../units.ts';
import { digMultiplierForLead } from '../rules.ts';
import { type BrainView } from './view.ts';
import { pBeat, pTeamWin as inferTeamWin, secureWin } from './infer.ts';
import {
  giftRisk, marginalValue, probeValue, sideSign, structureBreak, tempoValue,
  trumpSpend, voidGain, winnerSpend,
} from './value.ts';
import { digPlan, findCloser, type SjCloser } from './kou.ts';
import type { SjCandidate } from './candidates.ts';

export interface SjScored {
  cards: SjCard[];
  ev: number;
  why: string[];
  tag: string;
  parts: Record<string, number>;
}

/** 一局里不变的部分，先算一次，别在每个候选里重复算 */
export interface EvalCtx {
  v: BrainView;
  m: number;
  sign: number;
  closer: SjCloser | null;
  tempo: number;
  /** 对手在我之后出牌的最后一位是不是对手（我出的分很可能被截，M12） */
  foeActsLast: boolean;
}

export function makeEvalCtx(v: BrainView): EvalCtx {
  const closer = findCloser(v);
  const toAct = v.trick.toAct;
  const last = toAct.length ? toAct[toAct.length - 1] : null;
  return {
    v,
    m: marginalValue(v),
    sign: sideSign(v),
    closer,
    tempo: tempoValue(v, !!closer),
    foeActsLast: last != null && last % 2 !== v.me % 2,
  };
}

export function evaluateCandidate(ec: EvalCtx, cand: SjCandidate): SjScored {
  const v = ec.v;
  const cards = cand.cards;
  const why = cand.why.slice();
  let pWin = inferTeamWin(v, cards);
  const sure = secureWin(v, cards);

  /* --- 甩牌失败的概率先算：它会把「我方赢面」整个推翻 */
  const shape = v.trick.position === 0 ? parseShape(cards, v.ctx) : null;
  let pFail = 0;
  if (shape?.isThrow) {
    const gi = v.groups[shape.group];
    const allVoid = [v.partner, ...v.opps].every((s) => v.isVoid(s, shape.group));
    let pOk = 1;
    for (const u of shape.units) {
      if (gi.sureMax(u)) continue;
      const one = {
        ...shape,
        isThrow: false,
        units: [u],
        pairs: u.kind === 'pair' ? 1 : 0,
        tractors: u.kind === 'tractor' ? [u.span] : [],
        singles: u.kind === 'single' ? 1 : 0,
        count: u.cards.length,
      };
      for (const s of [v.partner, ...v.opps]) pOk *= 1 - pBeat(v, s, one, u.top);
    }
    pFail = allVoid ? 0 : 1 - pOk;
    // 甩牌被管 = 整圈归对方。`pBeat` 是按单个单位算的，多单位的甩牌
    // 在 `pTeamWin` 眼里反而"没人盖得动"（没有同型单位），必须在这里纠回来。
    pWin = Math.min(pWin, 1 - pFail);
  }

  /* --- 这一圈的分 */
  let trickPts = v.pointsOnTable + sumPoints(cards);
  if (pWin > 0.85 && v.trick.toAct.includes(v.partner)) {
    // 我方稳赢、对家还没出 → 他会把分垫过来
    trickPts += Math.min(10, v.unseenPoints / 6);
  }
  // 最后一圈：底分按首出牌型翻倍，直接进这一圈的账（§6.3 / §0.2）
  const isLast = v.isLastTrick(v.trick.position === 0 ? cards.length : v.trick.leadCards.length);
  let digMult = 0;
  if (isLast) {
    digMult = v.trick.position === 0
      ? digMultiplierForLead(cards, v.ctx)
      : digMultiplierForLead(v.trick.leadCards, v.ctx);
    const bottomPts = v.bottomPointsExact ?? v.bottomPointsExpected;
    trickPts += bottomPts * digMult;
    if (bottomPts > 0) why.push(`最后一圈：底 ${Math.round(bottomPts)} 分 ×${digMult}`);
  }

  /* --- 各项代价 */
  const topPlan = ec.closer && ec.closer.unit.kind === 'single'
    ? Math.max(3, Math.abs(digPlan(v, ec.closer.unit.cards, ec.closer)))
    : 0;
  const tSpend = trumpSpend(v, cards, topPlan);
  // 绝张就是用来收圈的：这一手稳赢时，"花掉绝张"的代价大部分不成立
  // （只剩"本可以等这门装满分再收"的那一点机会成本）。
  const wSpend = winnerSpend(v, cards) * (1 - 0.7 * pWin);
  const sBreak = structureBreak(v, cards);
  const vGain = v.trick.position === 0 ? 0 : voidGain(v, cards);
  const pVal = v.trick.position === 0 ? probeValue(v, cards) : 0;
  const gift = giftRisk(cards, pWin) * (ec.foeActsLast ? 1.5 : 1);

  // 甩失败要赔 10 分，还得把最小的那手交出去 —— 桌上的分也一起飞了。
  // 所以风险 = (10 + 这一圈的分) × P(有人管得上其中任一单位)。
  let throwRisk = pFail > 0 ? (10 + trickPts) * pFail : 0;
  // 闲家方低分时罚分能把 s 打到负数，风险加倍（M8）
  if (throwRisk > 0 && !v.iAmDealerTeam && v.defenderPoints <= 10) throwRisk *= 2;

  const dig = digPlan(v, cards, ec.closer);
  if (dig < -0.5) why.push('留着主牌绝张锁最后一圈');
  if (dig > 0.5) why.push('用绝张抠底');

  const bracket =
    (2 * pWin - 1) * trickPts
    + pWin * ec.tempo
    - tSpend - wSpend - sBreak
    + vGain + pVal
    - gift - throwRisk
    + dig;

  if (pWin > 0.85 && sumPoints(cards) > 0 && v.trick.position > 0) why.push('我方稳赢，把分给出去');
  if (pWin < 0.3 && sumPoints(cards) === 0) why.push('赢不了，不送分');

  return {
    cards,
    ev: bracket * ec.m,
    why,
    tag: cand.tag,
    parts: {
      pTeamWin: pWin, secureWin: sure, trickPts, tempo: ec.tempo, trumpSpend: tSpend,
      winnerSpend: wSpend, structureBreak: sBreak, voidGain: vGain, probeValue: pVal,
      giftRisk: gift, throwRisk, digPlan: dig, m: ec.m, sign: ec.sign, digMult,
      matchPoint: v.matchPoint ? 1 : 0,
      evDefenderDelta: ec.sign * bracket * ec.m,
    },
  };
}

/** 同分时人的习惯：牌小者先、不带分者先、不动主者先、不拆结构者先 */
export function tieBreak(a: SjScored, b: SjScored, v: BrainView): number {
  const trumps = (s: SjScored) => s.cards.filter((c) => groupOf(c, v.ctx) === 'T').length;
  const pts = (s: SjScored) => s.cards.reduce((x, c) => x + pointsOf(c), 0);
  return pts(a) - pts(b)
    || trumps(a) - trumps(b)
    || a.parts.structureBreak - b.parts.structureBreak
    || maxOrder(a.cards, v.ctx) - maxOrder(b.cards, v.ctx)
    || (a.cards.map((c) => c.id).sort().join() < b.cards.map((c) => c.id).sort().join() ? -1 : 1);
}

/** 把候选评估并排好序（EV 高的在前） */
export function rankCandidates(v: BrainView, cands: SjCandidate[]): SjScored[] {
  const ec = makeEvalCtx(v);
  const scored = cands.map((c) => evaluateCandidate(ec, c));
  // EV 相差不到 0.05 视为同分，交给人的习惯次序
  scored.sort((a, b) => (Math.abs(a.ev - b.ev) < 0.05 ? tieBreak(a, b, v) : b.ev - a.ev));
  return scored;
}
