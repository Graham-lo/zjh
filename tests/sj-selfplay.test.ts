/**
 * 自对弈强度基准的**断言版**（SPEC B.3 / BRAIN-DESIGN §8）。
 *
 * `scripts/sj-bench.mjs` 是给人看的（跑 300 局、打印细账），这里是给 CI 看的：
 * 局数压到能在几秒内跑完，只守住四条底线 ——
 *   1. 新脑子对上冻结的 v1 旧脑子，**两个方向都 ≥60%**（换座位再打一遍，运气抵消）；
 *   2. 每步决策 p99 < 20ms；
 *   3. 自对弈的闲家平均得分落在合理区间（太高说明庄家不会守，太低说明闲家不会抢）；
 *   4. 甩牌被罚是**算过账的少数派**：候选里会提存疑的甩牌（`throwRisk` 决定要不要），
 *      但赔 10 分的次数必须罕见 —— 频繁被罚就说明风险项估歪了。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// @ts-expect-error 基准脚本是 .mjs，没有类型声明；这里只当黑盒调
import { ab, selfPlay } from '../scripts/sj-bench.mjs';

const AB_HANDS = 200;
const SELF_HANDS = 120;

test('强度基准：新脑子对 v1 旧脑子，两个方向胜率都 ≥60%', () => {
  const res = ab(AB_HANDS) as {
    even: { rate: number; wins: number; hands: number };
    odd: { rate: number; wins: number; hands: number };
  };
  const pct = (r: number) => `${(r * 100).toFixed(1)}%`;
  assert.ok(
    res.even.rate >= 0.6,
    `新脑子坐 0/2 只赢了 ${res.even.wins}/${res.even.hands} = ${pct(res.even.rate)}`,
  );
  assert.ok(
    res.odd.rate >= 0.6,
    `新脑子坐 1/3 只赢了 ${res.odd.wins}/${res.odd.hands} = ${pct(res.odd.rate)}`,
  );
});

test('强度基准：自对弈的闲家平均得分在合理区间，甩牌被罚是罕见事件', () => {
  const sp = selfPlay(SELF_HANDS) as {
    avgDefenderPoints: number; throwFails: number; p99: number; decisions: number; digs: number;
  };
  assert.ok(
    sp.avgDefenderPoints > 45 && sp.avgDefenderPoints < 115,
    `闲家平均 ${sp.avgDefenderPoints.toFixed(1)} 分，两边强度不对等`,
  );
  assert.ok(
    sp.throwFails <= SELF_HANDS * 0.05,
    `${SELF_HANDS} 局里甩失败 ${sp.throwFails} 次 —— throwRisk 明显估低了`,
  );
  assert.ok(sp.digs > 0, '几十局里一次抠底都没有，尾局多半没在争最后一圈');
});

test('性能：每步决策 p99 < 20ms', () => {
  const sp = selfPlay(SELF_HANDS) as { p99: number; max: number; decisions: number };
  assert.ok(sp.decisions > 1000, '样本太少，p99 不作数');
  assert.ok(sp.p99 < 20, `p99 = ${sp.p99.toFixed(2)}ms`);
});
