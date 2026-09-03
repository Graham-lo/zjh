/**
 * **首出**（BRAIN-DESIGN §6.1）。
 *
 * 生成候选 → 用同一条 EV 打分 → 排序。这里只加两件 EV 式子里没有的东西：
 * **抽主的价值**（`drawValue`，它是"以后能兑现多少绝张"的折现）和
 * **尾局的一步展望**（保住 closer、争最后一圈的首出权）。
 */

import { groupOf, type SjCard } from '../cards.ts';
import { type BrainView } from './view.ts';
import { leadCandidates } from './candidates.ts';
import { evaluateCandidate, makeEvalCtx, tieBreak, type SjScored } from './evaluate.ts';
import { digValue, findCloser } from './kou.ts';
import { estTrumps } from './infer.ts';
import { maxOrder, parseShape } from '../units.ts';

/**
 * 抽主值多少（§6.1.3 / M6 / M7）。
 *
 * 抽主本身不收分，它的价值全在"抽干之后我的副牌绝张才立得住"。
 * 所以两个对手都已公开缺主时它就是 0；我方主不比对手多时也不抽 ——
 * 那只会把对家的主一起抽干。
 */
export function drawTrumpValue(v: BrainView): number {
  if (!v.trumps.oppsMayHold) return 0;                       // D5：两个对手都缺主，停止抽主
  const mine = v.trumps.mine;
  const partnerEst = v.trumps.partnerMayHold ? v.trumps.perHolder : 0;
  const oppEst = v.opps.reduce((s, o) => s + estTrumps(v, o), 0);
  if (mine + partnerEst <= oppEst) return 0;                 // D6：我方主不占优，不抽

  // 闲家方一般不抽主（庄家拿了底，主通常更多）；除非我方主明显多（M7）
  if (!v.iAmDealerTeam && mine < 10 && v.declaredSuits[v.partner] == null) return 0;

  let cashable = 0;
  for (const g of ['S', 'H', 'C', 'D'] as const) {
    const gi = v.groups[g];
    if (!gi.mine.length) continue;
    if (gi.unseenTop <= maxOrder(gi.mine, v.ctx)) cashable++;
  }
  let val = 1.5 * cashable;
  // 庄家方守底：底里有分就更要把对手的主抽干（M6）
  if (v.iAmDealerTeam && (v.bottomPointsExact ?? 0) > 0) val += 3;
  // 对手可能握着 closer → 抽主就是拆他的抠底
  const closer = findCloser(v);
  if (v.trumps.topUnseen.length > 0 && v.trumps.oppsMayHold) {
    val += digValue(v, closer) * 0.3 * 0.1;
  }
  return val;
}

/**
 * 场外最大的主大概率在谁手里（L2 / L3）。
 *
 * 只认公开信息：谁已经公开缺主、谁亮过主（亮主的人那门一定长）。
 * 剩下的情况一律返回 null —— 尾局这一步展望宁可不做，也不能靠猜别人的暗牌。
 */
export function topTrumpSeat(v: BrainView): number | null {
  if (!v.trumps.topUnseen.length) return null;
  const live = [v.partner, ...v.opps].filter((s) => !v.isVoid(s, 'T'));
  if (live.length === 0) return null;
  if (live.length === 1) return live[0];
  const declarers = live.filter((s) => v.declaredSuits[s] === 'T');
  return declarers.length === 1 ? declarers[0] : null;
}

/** 首出候选，从好到差 */
export function rankLeadPlays(v: BrainView): SjScored[] {
  const ec = makeEvalCtx(v);
  const draw = drawTrumpValue(v);
  const scored = leadCandidates(v).map((cand) => {
    const s = evaluateCandidate(ec, cand);
    const isTrump = cand.cards.every((c: SjCard) => groupOf(c, v.ctx) === 'T');
    if (isTrump && draw > 0 && !v.isLastTrick(cand.cards.length)) {
      s.ev += draw * ec.m;
      s.parts.drawValue = draw;
      s.why.push('抽主，把对手的主榨干');
    }
    if (v.endgame && !v.isLastTrick(cand.cards.length)) {
      const holder = topTrumpSeat(v);
      // 我这一手是不是"场外没人盖得过" —— 是的话首出权还在我手上，谈不上让给对家
      const shape = parseShape(cand.cards, v.ctx);
      const iKeepLead = !shape || shape.units.every((u) => v.groups[shape.group].sureMax(u));
      if (holder === v.partner && s.parts.pTeamWin > 0.6 && !iKeepLead) {
        // L2：closer 在对家手里 → 这一圈让他赢，最后一圈的首出权和倍数都归他
        s.ev += 2.5 * ec.m;
        s.why.push('把首出权让给持 closer 的对家');
      } else if (holder != null && holder !== v.partner && isTrump) {
        // L3：closer 在对手手里 → 出主逼他现在就花掉，最后一圈他就没本钱了
        s.ev += 2.5 * ec.m;
        s.why.push('出主逼对手提前花掉他的绝张主');
      } else if (s.parts.pTeamWin > 0.6 && s.parts.digPlan >= 0) {
        // L1：赢下这一圈才能保住最后一圈的首出权
        s.ev += 2 * ec.m;
        s.why.push('拿下这一圈，把最后一圈的首出权留在我方');
      }
    }
    return s;
  });
  scored.sort((a, b) => (Math.abs(a.ev - b.ev) < 0.05 ? tieBreak(a, b, v) : b.ev - a.ev));
  return scored;
}
