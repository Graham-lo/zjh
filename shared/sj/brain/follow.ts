/**
 * **跟牌**（BRAIN-DESIGN §6.2）。
 *
 * 位置（第几家）不进 if，而是进 `pTeamWin`：
 * 第二家时后面还有两个人没出，`pTeamWin` 自然低，"二家小"就长出来了；
 * 第四家时 `pTeamWin` 只会是 0 或 1，"赢就赢最小、输就垫最小"也自然成立。
 */

import { type SjShape } from '../units.ts';
import { type BrainView } from './view.ts';
import { followCandidates } from './candidates.ts';
import { evaluateCandidate, makeEvalCtx, tieBreak, type SjScored } from './evaluate.ts';

export function rankFollowPlays(v: BrainView, lead: SjShape): SjScored[] {
  const ec = makeEvalCtx(v);
  const scored = followCandidates(v, lead).map((c) => evaluateCandidate(ec, c));
  scored.sort((a, b) => (Math.abs(a.ev - b.ev) < 0.05 ? tieBreak(a, b, v) : b.ev - a.ev));
  return scored;
}
