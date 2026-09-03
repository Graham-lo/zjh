#!/usr/bin/env node
/**
 * 升级机器人的**强度基准**（BRAIN-DESIGN §8 / SPEC B.3）。
 *
 * 做两件事：
 *   1. 自对弈：固定种子跑 N 局，统计闲家平均得分、抠底次数与番数、甩牌失败次数、
 *      每步决策耗时（p50 / p99）。
 *   2. A/B：新脑子 vs 旧脑子（`tests/fixtures/bot-v1.ts` 的冻结快照），
 *      两个方向各跑 N/2 局 —— 新脑子坐 0/2 打一遍，坐 1/3 再打一遍。
 *      只交换座位不换牌，同一副牌两边各打一次，运气因素基本抵消。
 *
 * 用法：
 *   node scripts/sj-bench.mjs            # 默认 300 局自对弈 + 每方向 200 局 A/B
 *   node scripts/sj-bench.mjs 60 40      # 自对弈 60 局、A/B 每方向 40 局（快速回归）
 *
 * 「胜」的判定是**这一局谁达成了自己的目标**：闲家上台（≥80）算闲家赢，否则庄家赢。
 * 用它而不是"升了几级"，因为一局定胜负的粒度更细，200 局的方差才压得住。
 */

import {
  applySjCommand, closeDeclaring, createSjPlayer, createSjRoom, finishDealing,
  sjPlayerAtSeat, startNextHand,
} from '../shared/sj/engine.ts';
import * as brainNew from '../shared/sj/bot.ts';
import * as brainOld from '../tests/fixtures/bot-v1.ts';

export const NEW_BRAIN = { name: 'new', ...brainNew };
export const OLD_BRAIN = { name: 'v1', ...brainOld };

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOW = 1_700_000_000_000;

function freshRoom() {
  const host = createSjPlayer('甲', '🐯', 0, 'token-0');
  const room = createSjRoom('sj_510k', '123456', host);
  host.ready = true;
  for (let i = 0; i < 3; i++) applySjCommand(room, host.id, { type: 'add_bot' });
  return room;
}

/**
 * 打完**一局**（room 已经在 dealing）。`brains[seat]` 决定那个座位用哪个脑子。
 * 计时器只量**决策函数本身**，不含引擎的合法性校验 —— 20ms 的预算是给"想"的。
 */
function playHandIn(room, o, brains, stats) {
  const timed = (fn) => {
    const t0 = performance.now();
    const out = fn();
    stats?.times.push(performance.now() - t0);
    return out;
  };

  // --- 亮主。发牌途中的亮主也在这里体现：谁的计划触发得早谁先说
  finishDealing(room, o);
  const plans = room.players
    .map((p) => {
      const brain = brains[p.seat];
      const plan = brain.planSjDealingDeclare
        ? timed(() => brain.planSjDealingDeclare(room, p))
        : null;
      return plan ? { p, index: plan.index, cardIds: plan.cardIds } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.index - b.index);
  for (const { p, cardIds } of plans) {
    try { applySjCommand(room, p.id, { type: 'declare', cardIds }, o); } catch { /* 被抢先了 */ }
  }
  // 安静窗口里的兜底表态（旧脑子只有这一条路）
  for (const p of room.players) {
    if (room.trump.declarerId === p.id) continue;
    const cardIds = timed(() => brains[p.seat].botDeclare(room, p));
    if (cardIds) {
      try { applySjCommand(room, p.id, { type: 'declare', cardIds }, o); } catch { /* 忽略 */ }
    }
  }
  closeDeclaring(room, o);

  // --- 扣底 / 抄底
  let guard = 0;
  while (room.phase === 'kou' || room.phase === 'chao') {
    if (guard++ > 80) throw new Error('扣底/抄底没有收敛');
    if (room.phase === 'kou') {
      const burier = sjPlayerAtSeat(room, room.kouSeat);
      const cardIds = timed(() => brains[burier.seat].botKou(room, burier, o.rng));
      applySjCommand(room, burier.id, { type: 'kou', cardIds }, o);
      continue;
    }
    const asked = sjPlayerAtSeat(room, room.chaoSeat);
    const cardIds = timed(() => brains[asked.seat].botChao(room, asked));
    if (cardIds) {
      try {
        applySjCommand(room, asked.id, { type: 'chao', cardIds }, o);
        continue;
      } catch { /* 抄不成就当没抄 */ }
    }
    applySjCommand(room, asked.id, { type: 'pass_chao' }, o);
  }

  // --- 出牌
  guard = 0;
  while (room.phase === 'playing') {
    if (guard++ > 400) throw new Error('出牌没有收敛');
    const cur = sjPlayerAtSeat(room, room.turnSeat);
    const cardIds = timed(() => brains[cur.seat].botPlay(room, cur, o.rng));
    applySjCommand(room, cur.id, { type: 'play', cardIds }, o);
  }

  const res = room.result;
  const dealerTeam = room.dealerSeat % 2;
  return {
    defenderPoints: res ? res.defenderPoints : room.defenderPoints,
    dealerTeam,
    defenderTeam: 1 - dealerTeam,
    defendersUp: res ? res.defenderPoints >= 80 : room.defenderPoints >= 80,
    dig: res?.dig ?? null,
    throwFails: room.log.filter((l) => l.text.includes('甩牌失败')).length,
    trump: room.trump.suit,
    declared: !!room.trump.declarerId,
    handNo: room.handNo,
    kouByDefender: room.kouSeat % 2 !== dealerTeam,
    strength: room.trump.strength,
  };
}

/**
 * 一"盘"= 连着打 `hands` 局。**必须打不止一局**：首局的庄家是亮主者定的，
 * 于是抄底者永远变成庄家，「闲家抄成底、故意埋分等抠」这条路第一局根本走不到；
 * 第二局起才有真正的庄闲之分（§5.1 的 ≥9 张才亮、§5.3 的闲家埋分都在那之后）。
 */
export function playMatch(seed, brains, stats, hands = 3) {
  const room = freshRoom();
  const o = { rng: mulberry32(seed), now: NOW };
  applySjCommand(room, room.hostId, { type: 'start' }, o);
  const out = [];
  for (let i = 0; i < hands; i++) {
    out.push(playHandIn(room, o, brains, stats));
    if (room.phase !== 'hand_end' || room.matchWinner != null) break;
    startNextHand(room, o);
  }
  return out;
}

/** 单局（给只关心一局的调用方用） */
export function playOneHand(seed, brains, stats) {
  return playMatch(seed, brains, stats, 1)[0];
}

/** 自对弈：两边同一个脑子，只看这个脑子把牌打成什么样 */
export function selfPlay(hands, brain = NEW_BRAIN, seed0 = 1000, perMatch = 3) {
  const stats = { times: [] };
  let defPoints = 0; let defUp = 0; let digs = 0; let digMult = 0; let digPts = 0;
  let throwFails = 0; let ntHands = 0; let defenderKou = 0; let played = 0;
  const brains = [brain, brain, brain, brain];
  for (let i = 0; played < hands; i++) {
    for (const r of playMatch(seed0 + i, brains, stats, perMatch)) {
      if (played >= hands) break;
      played++;
      defPoints += r.defenderPoints;
      if (r.defendersUp) defUp++;
      if (r.dig) { digs++; digMult += r.dig.multiplier; digPts += r.dig.total; }
      if (r.kouByDefender) defenderKou++;
      throwFails += r.throwFails;
      if (!r.declared) ntHands++;
    }
  }
  hands = played;
  stats.times.sort((a, b) => a - b);
  const q = (p) => stats.times[Math.min(stats.times.length - 1, Math.floor(stats.times.length * p))] ?? 0;
  return {
    hands,
    avgDefenderPoints: defPoints / hands,
    defenderUpRate: defUp / hands,
    digs,
    avgDigMultiplier: digs ? digMult / digs : 0,
    avgDigPoints: digs ? digPts / digs : 0,
    throwFails,
    noDeclareHands: ntHands,
    defenderKou,
    decisions: stats.times.length,
    p50: q(0.5),
    p99: q(0.99),
    max: stats.times[stats.times.length - 1] ?? 0,
  };
}

/**
 * A/B 一个方向：`a` 坐 `seats`，`b` 坐另外两席。
 * 返回 a 方的胜率 —— 「胜」= 这一局站在自己那一边的目标达成了。
 */
export function abDirection(hands, a, b, seats, seed0, perMatch = 3) {
  const brains = [0, 1, 2, 3].map((s) => (seats.includes(s) ? a : b));
  const aTeam = seats[0] % 2;
  let wins = 0; let aDefPts = 0; let aAsDefender = 0; let played = 0;
  for (let i = 0; played < hands; i++) {
    for (const r of playMatch(seed0 + i, brains, null, perMatch)) {
      if (played >= hands) break;
      played++;
      const aIsDefender = aTeam === r.defenderTeam;
      if (aIsDefender) {
        aAsDefender++;
        aDefPts += r.defenderPoints;
        if (r.defendersUp) wins++;
      } else if (!r.defendersUp) wins++;
    }
  }
  return {
    hands: played, wins, rate: wins / played, aAsDefender,
    avgDefenderPointsWhenA: aAsDefender ? aDefPts / aAsDefender : 0,
  };
}

export function ab(hands, a = NEW_BRAIN, b = OLD_BRAIN, seed0 = 5000) {
  return {
    even: abDirection(hands, a, b, [0, 2], seed0),
    odd: abDirection(hands, a, b, [1, 3], seed0),
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const selfHands = Number(process.argv[2] ?? 300);
  const abHands = Number(process.argv[3] ?? 200);
  const fmt = (x, n = 2) => x.toFixed(n);

  const t0 = performance.now();
  const sp = selfPlay(selfHands);
  console.log(`== 自对弈（新脑子 × 4），${sp.hands} 局 ==`);
  console.log(`闲家平均得分   ${fmt(sp.avgDefenderPoints, 1)} / 200`);
  console.log(`闲家上台率     ${fmt(sp.defenderUpRate * 100, 1)}%`);
  console.log(`抠底           ${sp.digs} 次，平均 ×${fmt(sp.avgDigMultiplier, 2)}，平均进账 ${fmt(sp.avgDigPoints, 1)} 分`);
  console.log(`甩牌失败       ${sp.throwFails} 次`);
  console.log(`闲家抄成底     ${sp.defenderKou} 局`);
  console.log(`无人亮主的局   ${sp.noDeclareHands}`);
  console.log(`决策耗时       n=${sp.decisions}  p50=${fmt(sp.p50, 3)}ms  p99=${fmt(sp.p99, 3)}ms  max=${fmt(sp.max, 3)}ms`);

  const res = ab(abHands);
  console.log(`\n== A/B：新脑子 vs v1 旧脑子，每方向 ${abHands} 局 ==`);
  console.log(`新脑子坐 0/2   胜 ${res.even.wins}/${res.even.hands} = ${fmt(res.even.rate * 100, 1)}%`);
  console.log(`新脑子坐 1/3   胜 ${res.odd.wins}/${res.odd.hands} = ${fmt(res.odd.rate * 100, 1)}%`);
  console.log(`\n耗时 ${fmt((performance.now() - t0) / 1000, 1)}s`);

  const bad = [];
  if (res.even.rate < 0.6) bad.push(`坐 0/2 只有 ${fmt(res.even.rate * 100, 1)}%`);
  if (res.odd.rate < 0.6) bad.push(`坐 1/3 只有 ${fmt(res.odd.rate * 100, 1)}%`);
  if (sp.p99 >= 20) bad.push(`p99 ${fmt(sp.p99, 2)}ms ≥ 20ms`);
  if (bad.length) {
    console.log(`\n未达标：${bad.join('；')}`);
    process.exitCode = 1;
  } else {
    console.log('\n全部达标（两方向 ≥60%、p99 < 20ms）');
  }
}
