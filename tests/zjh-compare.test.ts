/**
 * 比牌这件事的人味验收（设计文档 §4.6 / §6.4，2026-09-04 P2.1 新增）。
 *
 * 起因是真人牌局的留痕对照（`docs/zjh/baseline-2026-09.md` 的 P2.1 一节）：
 * 机器人拿到大牌的第一反应是**开牌**，真人的第一反应是**加价**。
 * 自对弈量到的「大牌早比」（牌力 ≥ 0.8 且第 1–2 轮就比牌，占全部比牌）
 * 在修之前是 19.0%，§6.4 要的是 < 5%。
 *
 * 这个文件量的是**分布**，不是某一次决策：
 *   · 自对弈口径的三条（大牌早比、单调性、弱牌不开牌）与 `scripts/zjh-review.ts`
 *     的统计口径逐字一致 —— 那边读的是线上库，这边跑的是自对弈，
 *     两边算的必须是同一个数，不然线上回来的数字没法和这里对账。
 *   · 场景口径的一条（单挑第 2 轮拿豹子）用 `tests/zjh-helpers.ts` 的场景台，
 *     固定局面跑 200 个种子。
 *
 * 种子固定：发牌走的是 `crypto.getRandomValues`，不定种子的话同一条断言
 * 会在边界上时过时不过。数字仍然是跑出来的，只是可复现。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCommand, botAction, createHumanPlayer, createInitialRoom, currentPlayer,
  handPercentile, type RoomState,
} from '../shared/game.ts';
import { warmUpRange } from '../shared/zjh/bot/range.ts';
import { FLUSH_LO, HANDS, PAIR_LO, SF_LO, STRAIGHT_LO, ev, sample, scene, share } from './zjh-helpers.ts';
import { withSeededRandom } from './zjh-arena.ts';

warmUpRange();

const SELF_PLAY_SEED = 20260903;
/*
 * 2000 → 5000（集成第 3 步）。**断言一个字没动，动的是样本量。**
 * 分位常数对回 `categoryBands('standard')` 之后，P2.1-2 的「最强档」从旧发牌的
 * 手写 0.83 变成顺金档下沿 0.960 —— 那是全部牌的前 4%，2000 手时五个人数档里
 * 顺金以上分别只有 48/103/91/62/15 步，一格都够不着 `compareRate` 的 120 行下限，
 * 于是「只有 0 个人数档够样本」。5000 手让 3、4、5 人档都过线（约 258/228/155）。
 */
const HANDS_N = 5000;

interface Step {
  action: string;
  roundNo: number;
  looked: boolean;
  /** 和留痕一样：闷着的人没有牌力（`ownStrength` 对闷牌返回 undefined） */
  strength: number | null;
  activeCount: number;
}

/**
 * 八人名册桌：六个座位从 §4.7.3 的八个名字里抽。§6.4 说得很清楚，
 * 这一节量的是**产品里真实的那一桌**，不是竞技场的匿名座位。
 */
function rosterTable(): RoomState {
  const host = createHumanPlayer('甲', '🐯', 0, 'h0');
  const room = createInitialRoom('123456', host);
  for (const p of room.players) p.ready = true;
  for (let i = 0; i < 5; i++) applyCommand(room, host.id, { type: 'add_bot' });
  room.players[0].isBot = true;
  return room;
}

/** 跑一段自对弈，只记这个文件要的那几个字段。 */
function selfPlay(hands: number): Step[] {
  return withSeededRandom(SELF_PLAY_SEED, () => {
    const out: Step[] = [];
    let room = rosterTable();
    for (let h = 0; h < hands; h++) {
      // 六个人打上百手总会有人先破产，剩两三个人的桌子统计出来的是残局不是牌局
      if (h && h % 50 === 0) room = rosterTable();
      applyCommand(room, room.hostId, { type: 'start' });
      let guard = 0;
      while (room.phase === 'playing' && guard++ < 400) {
        const cur = currentPlayer(room);
        if (!cur) break;
        out.push({
          roundNo: room.roundNo,
          looked: cur.looked,
          strength: cur.looked ? handPercentile(cur.hand, room.settings.dealMode) : null,
          activeCount: room.players.filter((p) => p.status === 'active').length,
          action: '',
        });
        const { cmd } = botAction(room, cur);
        out[out.length - 1].action = cmd.type;
        try { applyCommand(room, cur.id, cmd); } catch { applyCommand(room, cur.id, { type: 'fold' }); }
      }
      applyCommand(room, room.hostId, { type: 'new_round' });
    }
    return out;
  });
}

const STEPS = selfPlay(HANDS_N);
const pct = (a: number, b: number) => (b ? a / b * 100 : 0);
/** 一格里的比牌率。`null` = 这一格样本太小，不下结论。 */
function compareRate(rows: Step[]): number | null {
  return rows.length >= 120 ? pct(rows.filter((s) => s.action === 'compare').length, rows.length) : null;
}

test('P2.1-1 大牌早比：顺金以上又在第 1–2 轮就开牌的，占全部比牌的一小部分', () => {
  // 口径抄 `scripts/zjh-review.ts` 的 `foldInto`：
  // 分子 = `action === 'compare' && roundNo <= 2 && strength >= 顺金档下沿`，分母 = 全部比牌。
  // 「大牌」是**牌型线**（顺金以上，与 §6.4 / bots.test.ts 同口径），档线从
  // `categoryBands('standard')` 取；旧写法的 0.8 是 92% 发牌时代的手写分位，
  // 在标准档里落进顺子档，量到的根本不是大牌。
  const compares = STEPS.filter((s) => s.action === 'compare');
  const big = compares.filter((s) => s.roundNo <= 2 && (s.strength ?? 0) >= SF_LO);
  const rate = pct(big.length, compares.length);
  assert.ok(compares.length >= 300, `比牌样本太小（${compares.length}），这条断言说明不了什么`);
  /*
   * 线就是 §6.4 的 5%，没有「暂定线」这回事：设计文档上的数字是门槛，
   * 断言只照抄它。历程是 19.0%（修前）→ 7.9%（P2.1 第一版，因为没到 5% 被退回）
   * → 4.09%（2026-09-04 返修，这条测试自己那 2000 手上是 23/563）。
   * 最后那一截靠的是给收口那三条地面理由各加一道「顶我的人够不够得着我」的
   * 连续折扣（§4.6「比牌价值的形状」），不是放宽断言、也不是加「大牌禁止比牌」
   * 这类硬规则 —— 整条脑子里没有一个 `if (牌力 ≥ x)`。
   */
  assert.ok(rate < 5, `大牌早比 ${rate.toFixed(1)}%（${big.length}/${compares.length}），修前是 19.0%`);
});

test('P2.1-2 比牌率不随牌力单调上升：最强的一档不该比中等档高出一倍', () => {
  /*
   * 「牌越好越要开牌」是机器味最重的一条：真人拿到豹子想的是怎么多收两口，
   * 拿到中等牌才急着把牌摊了了事。所以这条量的不是某一格的绝对值，
   * 而是**形状** —— 最强档（顺金以上）的比牌率不该比中等档（金花档）高一倍以上。
   * 按第 2 轮、分人数档各算：不同人数下比牌的道理完全不同（单挑是收口，
   * 满桌是赢家诅咒），混在一起看不出形状。
   */
  const round2 = STEPS.filter((s) => s.roundNo === 2 && s.looked);
  let checked = 0;
  for (let n = 2; n <= 6; n++) {
    const at = round2.filter((s) => s.activeCount === n);
    const big = compareRate(at.filter((s) => (s.strength ?? 0) >= SF_LO));
    const mid = compareRate(at.filter((s) => (s.strength ?? 0) >= FLUSH_LO && (s.strength ?? 0) < SF_LO));
    if (big === null || mid === null) continue;   // 样本不足的人数档不下结论
    checked++;
    // + 0.5 个点的绝对余量：两边都接近 0 的时候，比值本身没有意义
    assert.ok(big <= mid * 2.0 + 0.5,
      `${n} 人档第 2 轮：顺金以上 ${big.toFixed(1)}% vs 金花档 ${mid.toFixed(1)}%，形状还是「牌越好越开牌」`);
  }
  assert.ok(checked >= 3, `只有 ${checked} 个人数档够样本，这条断言没量到东西`);
  const big = compareRate(round2.filter((s) => (s.strength ?? 0) >= SF_LO))!;
  const mid = compareRate(round2.filter((s) => (s.strength ?? 0) >= FLUSH_LO && (s.strength ?? 0) < SF_LO))!;
  assert.ok(big <= mid * 2.0 + 0.5, `合计：顺金以上 ${big.toFixed(1)}% vs 金花档 ${mid.toFixed(1)}%`);
});

test('P2.1-3 顺子及以下第 2 轮基本不开牌', () => {
  // 弱牌开牌是纯粹的送钱：这一档的比牌率必须贴着 0。
  const round2 = STEPS.filter((s) => s.roundNo === 2 && s.looked);
  const bands: [string, (v: number) => boolean][] = [
    ['顺子档', (v) => v >= STRAIGHT_LO && v < FLUSH_LO],
    ['对子档', (v) => v >= PAIR_LO && v < STRAIGHT_LO],
    ['散牌档', (v) => v < PAIR_LO],
  ];
  for (const [name, inBand] of bands) {
    const at = round2.filter((s) => inBand(s.strength ?? -1));
    const rate = compareRate(at);
    if (rate === null) continue;
    assert.ok(rate <= 1, `${name} 第 2 轮比牌 ${rate.toFixed(1)}%（${at.length} 次决策），弱牌不该开牌`);
  }
});

test('P2.1-4 单挑第 2 轮拿豹子：先想着加价，不是先想着开牌', () => {
  /*
   * 这是 P2.1 的靶心那一格：单挑、第 2 轮、价钱还停在开局那一档。
   * 修之前这个局面里 83% 抽到「养池」（那条线 98% 平跟）、只有 1% 抽到「价值加压」，
   * 因为「价值加压」的线路匹配度是一条中心在 0.675 的钟形，到豹子那一头
   * 落到 0.002 —— 最该加价的那手牌进不了加价那条线（见 `plan.ts` 的 `lineFit`）。
   */
  const build = (hand: typeof HANDS.trips) => scene({
    me: { name: '我', hand, looked: true, bet: 2_500, chips: 400_000 },
    others: [{
      name: 'A', looked: true, bet: 2_500, chips: 400_000, events: [ev('call', true, 1_000, 1)],
    }],
    pot: 9_000, betUnit: 1_000, roundNo: 2, turnCount: 4, position: 'early', compareUnlockAt: 2,
  });
  const rate = (hand: typeof HANDS.trips, type: string) => {
    const { room, bot } = build(hand);
    return share(sample(room, bot), (c) => c?.type === type);
  };
  const trips = build(HANDS.trips);
  const cmds = sample(trips.room, trips.bot);
  const push = share(cmds, (c) => c?.type === 'raise' || c?.type === 'call');
  const cmp = share(cmds, (c) => c?.type === 'compare');
  assert.ok(push >= 0.45, `拿豹子只有 ${(push * 100).toFixed(0)}% 在继续打这手牌`);
  assert.ok(cmp <= 0.35, `拿豹子有 ${(cmp * 100).toFixed(0)}% 直接开牌 —— 又回到「见了大牌就想摊」`);
  // 形状：最强的那档加价要**比中等牌更积极**，不是更消极
  const tripsRaise = share(cmds, (c) => c?.type === 'raise');
  for (const [name, hand] of [['K 高金花', HANDS.kFlush], ['中等金花', HANDS.midFlush]] as const) {
    const mid = rate(hand, 'raise');
    assert.ok(tripsRaise > mid,
      `豹子加注 ${(tripsRaise * 100).toFixed(0)}% ≤ ${name} 加注 ${(mid * 100).toFixed(0)}%：大牌反而不敢加价`);
  }
});
