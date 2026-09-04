/**
 * 牌桌这一侧的人性验收（设计文档 §4.9.4 / §6.4）。
 *
 * `tests/mind.test.ts` 证明的是「这套人可以离开牌桌」；这个文件证明的是
 * 「这套人坐在牌桌上像不像人」：情绪真的改变打法、系统 2 会累、闷牌与看牌
 * 是人物卡和局面吵出来的结果而不是一条 `roundNo >= 2`。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCommand, botAction, createHumanPlayer, createInitialRoom, currentPlayer,
  emptyMemory, memoryKey, type Card, type GameCommand, type RoomState,
  type PlayerState,
} from '../shared/game.ts';
import { newMind, type Emotions, type MindState } from '../shared/mind/emotion.ts';
import { setDeliberateProbe } from '../shared/mind/dual.ts';
import { onPlan } from '../shared/zjh/bot/plan.ts';
import { personaFor } from '../shared/zjh/bot/personas/index.ts';
import type { Line } from '../shared/zjh/bot/personas/types.ts';
import { warmUpRange } from '../shared/zjh/bot/range.ts';
import { HANDS, ev, sample, scene } from './zjh-helpers.ts';
import { runArena, withSeededRandom } from './zjh-arena.ts';
import { botActionV2 } from './fixtures/zjh-bot-v2.ts';

warmUpRange();

/* ------------------------------------------------------------ 自对弈台 */

/**
 * **八人名册桌**：六个座位从 §4.7.3 的八个名字里抽（`add_bot` 保证不重名）。
 * §6.4 的人味区间在这张桌上判 —— 上线之后玩家坐进去看到的就是这一桌。
 */
function rosterTable(): RoomState {
  const host = createHumanPlayer('甲', '🐯', 0, 'h0');
  const room = createInitialRoom('123456', host);
  for (const p of room.players) p.ready = true;
  for (let i = 0; i < 5; i++) applyCommand(room, host.id, { type: 'add_bot' });
  room.players[0].isBot = true;   // 六个座位全给机器人
  return room;
}

/**
 * **常人卡桌**：六个座位都用**不在名册上**的名字，`personaFor` 一律落到
 * `personas/common.ts`（§4.9.6 的常人卡）。
 *
 * 这张桌是集成时补的（补充二第 2 条）。在此之前名为「常人卡自对弈」的测试
 * 其实坐的是 `BOT_NAMES` 那六个名字 —— P2 时它们没有手写卡，走过渡映射，
 * 勉强算「常人」；八张卡合桌之后那六个名字全是具体的人，那个名字就名不副实了。
 * 拆成两族之后：常人卡族量「引擎本身像不像人」，名册族量「这一桌像不像人」。
 */
function commonTable(): RoomState {
  const host = createHumanPlayer('常人1', '🐯', 0, 'h0');
  const room = createInitialRoom('123456', host);
  host.isBot = true;
  for (let i = 2; i <= 6; i++) {
    room.players.push({
      id: `c${i}`, name: `常人${i}`, avatar: '🤖', seat: i - 1,
      chips: room.settings.startingChips, ready: true, status: 'waiting',
      looked: false, bared: false, hand: [], isBot: true, online: true,
      bet: 0, wins: 0, net: 0, granted: 0,
    });
  }
  for (const p of room.players) p.ready = true;
  return room;
}

interface Step {
  hand: number;
  cmd: GameCommand;
  looked: boolean;
  roundNo: number;
  seat: string;
  engaged: boolean;
  /** 偏离系统 2 最优解了吗；`undefined` = 这一步没有对照（没开离线对照开关） */
  deviated?: boolean;
  thinkMs: number;
  /** 这一步他走的是哪条线路（§4.4） */
  line?: Line;
  /** 决策那一刻的七情（§4.9.1 的事件通道有没有在动，看这个） */
  emotions?: Emotions;
  /** 这一步之前他刚感受到的局中事件 */
  felt?: string[];
  /** 这一步是不是顶着压力做的（口径与竞技场的 `underPressure` 一致） */
  pressured: boolean;
}

/**
 * 跑一段自对弈，把每一步都记下来。
 *
 * `reset` 是每多少手换一张新桌 —— 六个人打上百手总会有人先破产，
 * 剩下两三个人的桌子统计出来的是残局，不是牌局。
 */
/**
 * 这一族验收量的是**分布**（各轮看牌率、闷比占比、系统 2 介入率），
 * 而发牌走的是 `crypto.getRandomValues` —— 不定种子的话同一条断言
 * 会在边界上时过时不过（实测「后 20 手偏离率」在 25.6%–30.6% 之间跳，
 * 断言要的是「比前 20 手高 5 个点」，正好压在抖动里）。
 * 所以整段自对弈固定种子：数字仍然是跑出来的，只是可复现。
 */
const SELF_PLAY_SEED = 20260903;

/** 这一步他是不是顶着压力在做决定（和 `tests/zjh-arena.ts` 的 `underPressure` 同一口径）。 */
function underPressure(state: RoomState, me: { id: string }): boolean {
  return !!state.allIn
    || state.betUnit > state.settings.betOptions[0]
    || state.players.some((p) => p.id !== me.id && p.status === 'active'
      && p.handActions?.some((e) => e.kind === 'raise'));
}

/** 换一套大脑跑同一段自对弈（`botActionV2` 是改造前的快照，§6.4 的「现在的基线」）。 */
type Brain = (state: RoomState, bot: PlayerState) => { cmd: GameCommand; thinkMs: number };

function selfPlay(
  hands: number, reset = 50, watch?: (room: RoomState, hand: number) => void, brain?: Brain,
  table: () => RoomState = rosterTable,
): Step[] {
  return withSeededRandom(SELF_PLAY_SEED, () => selfPlayRaw(hands, reset, watch, brain, table));
}

function selfPlayRaw(
  hands: number, reset: number, watch?: (room: RoomState, hand: number) => void, brain?: Brain,
  table: () => RoomState = rosterTable,
): Step[] {
  const steps: Step[] = [];
  let room = table();
  for (let h = 0; h < hands; h++) {
    if (reset && h && h % reset === 0) room = table();
    applyCommand(room, room.hostId, { type: 'start' });
    let guard = 0;
    while (room.phase === 'playing' && guard++ < 400) {
      const cur = currentPlayer(room);
      if (!cur) break;
      const looked = cur.looked;
      const roundNo = room.roundNo;
      const pressured = underPressure(room, cur);
      const out = (brain ?? botAction)(room, cur) as ReturnType<typeof botAction>;
      const { cmd, thinkMs, trace, plan, felt } = out;
      steps.push({
        hand: h, cmd, looked, roundNo, seat: cur.name, line: plan?.line, pressured,
        engaged: trace?.engaged ?? false, deviated: trace?.deviated, thinkMs,
        emotions: trace?.emotions, felt: felt?.map((e) => e.kind),
      });
      applyCommand(room, cur.id, cmd);
    }
    watch?.(room, h);
    applyCommand(room, room.hostId, { type: 'new_round' });
  }
  return steps;
}

const pct = (a: number, b: number) => (b ? a / b : NaN);

/* --------------------------------------------------- §6.4 人味区间 */

/**
 * 「闷到第 3 轮」与「闷比占比牌」这两条 §6.4 指标的口径，两族共用。
 *
 * · 闷到第 3 轮 = 进到第 3 轮还在场的人里有多少还没看牌（每手每人只数一次）。
 * · 闷比占比牌 = 全部比牌里，比的时候还闷着的那部分。
 */
function blindShape(steps: Step[]) {
  const counted = new Set<string>();
  let at3 = 0, blindAt3 = 0, compares = 0, blindCompares = 0;
  let lastHand = -1;
  for (const s of steps) {
    if (s.hand !== lastHand) { counted.clear(); lastHand = s.hand; }
    if (s.roundNo >= 3 && !counted.has(s.seat)) {
      counted.add(s.seat);
      at3++;
      if (!s.looked) blindAt3++;
    }
    if (s.cmd.type === 'compare') { compares++; if (!s.looked) blindCompares++; }
  }
  return { at3, blindAt3, compares, blindCompares,
    blindShare: pct(blindAt3, at3), blindCompareShare: pct(blindCompares, compares) };
}

/*
 * 这一条以前叫「常人卡自对弈」，坐的却是 `BOT_NAMES` 那六个名字。八张手写卡合桌之后
 * 那六个名字全是具体的人，名字就名不副实了，于是拆成两族（集成任务书补充二第 2 条）：
 * **名册族按 §6.4 判带**（下面这条），常人卡族只报数（再下面那条）。带子本身一个字没改。
 *
 * 已知红（集成第 3 步查清，留给主线程裁决，见集成报告）：**闷比占比牌**这一条判不过。
 * 它在集成起点 3df3c35 上就是红的（37.7%），八张卡合桌把老王从「六座必坐」稀释成
 * 「八抽六」之后降到 28.5%，仍在 15% 的上沿之外。原因不在参数而在设计数字本身：
 * 老王的卡写着「常闷比」，实测他一个人 575 次比牌里 484 次是闷着比的，占全桌 2204 次
 * 比牌的 22.0% —— 另外七个人一次闷比都不出，全桌也已经超过 15%。按补充一第 3 条
 * 允许动的三个旋钮（`blindLove` / 闷比权重 / `compare.blind`）全扫过了：只有权重推得动
 * 这个数，而推到能进带的 0.15 会把 `[自洽] 老王`「比牌绝大多数是闷比」打红（80.2%→50.9%）。
 * 详细曲线记在 `shared/zjh/bot/personas/laowang.ts` 的 `lines.闷比` 处。
 * 这里**不放松断言、不改带子**，原样报红。
 */
test('§6.4 八人名册桌自对弈：闷到第 3 轮 15–35%、闷比占比牌 5–15%', () => {
  const r = blindShape(selfPlay(3000));
  console.log(
    `[§6.4·名册] 闷到第3轮 ${(r.blindShare * 100).toFixed(1)}% (${r.blindAt3}/${r.at3})`
    + `  闷比 ${(r.blindCompareShare * 100).toFixed(1)}% (${r.blindCompares}/${r.compares})`,
  );
  assert.ok(r.at3 > 2000 && r.compares > 500, `样本不够：至第3轮 ${r.at3} 次、比牌 ${r.compares} 次`);
  assert.ok(
    r.blindShare >= 0.15 && r.blindShare <= 0.35,
    `闷到第 3 轮 ${(r.blindShare * 100).toFixed(1)}%，设计文档 §6.4 要 15–35%`,
  );
  assert.ok(
    r.blindCompareShare >= 0.05 && r.blindCompareShare <= 0.15,
    `闷比占比牌 ${(r.blindCompareShare * 100).toFixed(1)}%，设计文档 §6.4 要 5–15%`,
  );
});

/**
 * 常人卡族：六个座位都是常人卡（不走名册）。
 *
 * §6.4 的带子是**给上线那一桌**定的（人物卡各有各的脾气，闷牌王把闷比拉高、
 * 跟注站把它压低，带子量的是这锅汤的味道），所以这一族**不判带**，只报数存档 ——
 * 它回答的是另一个问题：把人物卡全部抽掉之后，引擎自己还闷不闷得住。
 * 断言只留「两头都不是 0/1」这条与人物卡无关的下限：常人也该有人闷到第 3 轮，
 * 也该偶尔闷着比一次，否则闷牌这条路径根本没被走到。
 */
test('§6.4 常人卡自对弈：抽掉人物卡之后，闷牌这条路仍然走得通', () => {
  const r = blindShape(selfPlay(3000, 50, undefined, undefined, commonTable));
  console.log(
    `[§6.4·常人] 闷到第3轮 ${(r.blindShare * 100).toFixed(1)}% (${r.blindAt3}/${r.at3})`
    + `  闷比 ${(r.blindCompareShare * 100).toFixed(1)}% (${r.blindCompares}/${r.compares})`,
  );
  assert.ok(r.at3 > 2000 && r.compares > 500, `样本不够：至第3轮 ${r.at3} 次、比牌 ${r.compares} 次`);
  assert.ok(r.blindShare > 0 && r.blindShare < 1, `常人桌闷到第 3 轮 ${(r.blindShare * 100).toFixed(1)}%`);
  assert.ok(
    r.blindCompareShare > 0 && r.blindCompareShare < 1,
    `常人桌闷比占比牌 ${(r.blindCompareShare * 100).toFixed(1)}%`,
  );
});

/**
 * §6.4 第三条：比牌目标是「范围最弱者」的比例 ≥ 70%。
 *
 * 「最弱」按**旁观者的**范围模型算（同一批事件流、同一张似然表，不看任何人的暗牌），
 * 由竞技场的 `comparedWeakest` 判定 —— 也就是说这条断言问的是
 * 「他挑人的时候，用没用上自己那套读牌」，不是「他有没有挑中真的最弱的那手牌」。
 */
test('§6.4 六台新脑自对弈：比牌挑的是范围最弱的那个 ≥ 70%', () => {
  /*
   * 局数从 800 提到 1100（2026-09-04 P2.1）：**断言一个字没动**，动的是样本量。
   * P2.1 之后比牌本身变少了（这正是这一期要的：`大牌早比` 20.9% → 7.9%），
   * 800 局只剩 193 次比牌，卡在下面那条 `>= 200` 的样本量护栏上。
   * 比例本身是 83.9%，离 70% 的线远得很 —— 缺的是次数不是水平。
   *
   * 2026-09-04 发牌回调（四类大牌 92% → 26%）之后再提到 1400，理由同上：桌上大牌少了，
   * 「值得开一次牌」的局面也跟着少，1100 局只剩 176 次比牌，比例是 86.4% ——
   * 还是那句话，**断言一个字没动**，动的是样本量。
   */
  const res = runArena({ brains: ['v3', 'v3', 'v3', 'v3', 'v3', 'v3'], hands: 1400, warmup: 50 });
  const v3 = res.stats.find((s) => s.brain === 'v3')!;
  const share = v3.compareOnWeakest / Math.max(1, v3.compares);
  console.log(`[§6.4] 挑最软 ${(share * 100).toFixed(1)}% (${v3.compareOnWeakest}/${v3.compares})`);
  assert.ok(v3.compares >= 200, `比牌样本不够：${v3.compares} 次`);
  assert.ok(share >= 0.70, `挑最软 ${(share * 100).toFixed(1)}%，设计文档 §6.4 要 ≥ 70%`);
});

/* --------------------------------------------- §6.4 六个人分不分得开 */

interface Four { vpip: number; raise: number; foldPressed: number; blind: number }

/**
 * 每个座位的四维画像（VPIP、加注率、遇压弃牌率、闷牌率），口径与竞技场一致：
 * VPIP = 这一局第一次轮到他时没有直接弃牌的局数占比；加注率 = (加注+梭哈)/全部动作；
 * 遇压弃牌率 = 顶着压力的那些步里弃牌的比例；闷牌率 = 决策时还没看牌的步数占比。
 */
function fourDims(steps: Step[]): Map<string, Four> {
  const c = new Map<string, {
    hands: Set<number>; vpip: number; acts: number; raises: number;
    pressed: number; pressedFolds: number; blind: number; first: Set<number>;
  }>();
  for (const s of steps) {
    const slot = c.get(s.seat) ?? {
      hands: new Set<number>(), vpip: 0, acts: 0, raises: 0,
      pressed: 0, pressedFolds: 0, blind: 0, first: new Set<number>(),
    };
    c.set(s.seat, slot);
    slot.hands.add(s.hand);
    if (!slot.first.has(s.hand)) { slot.first.add(s.hand); if (s.cmd.type !== 'fold') slot.vpip++; }
    if (s.cmd.type === 'look') continue;          // 看牌不占行动权，不进动作分母
    slot.acts++;
    if (s.cmd.type === 'raise' || s.cmd.type === 'all_in') slot.raises++;
    if (!s.looked) slot.blind++;
    if (s.pressured) { slot.pressed++; if (s.cmd.type === 'fold') slot.pressedFolds++; }
  }
  const out = new Map<string, Four>();
  for (const [seat, v] of c) {
    out.set(seat, {
      vpip: v.vpip / Math.max(1, v.hands.size),
      raise: v.raises / Math.max(1, v.acts),
      foldPressed: v.pressedFolds / Math.max(1, v.pressed),
      blind: v.blind / Math.max(1, v.acts),
    });
  }
  return out;
}

/** 六个人两两之间在四维上的平均欧氏距离。 */
function spread(dims: Map<string, Four>): number {
  const list = [...dims.values()];
  let sum = 0, pairs = 0;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      sum += Math.hypot(a.vpip - b.vpip, a.raise - b.raise, a.foldPressed - b.foldPressed, a.blind - b.blind);
      pairs++;
    }
  }
  return pairs ? sum / pairs : 0;
}

/**
 * §6.4 第四条：六台机器人两两之间在（VPIP、加注率、遇压弃牌率、闷牌率）四维上的
 * 距离 > **现在的基线**。「现在的基线」= 改造前那一版大脑（`tests/fixtures/zjh-bot-v2.ts`
 * 的冻结快照）坐同样六个座位、打同一副牌跑出来的同一个数。
 *
 * 两边共用同一个种子和同一张性格表，所以这一条量的确实是「新大脑让这六个人更像六个人」，
 * 而不是「新大脑碰上了另一副牌」。
 */
test('§6.4 六台机器人两两四维距离 > V2 基线', () => {
  const v3 = spread(fourDims(selfPlay(600)));
  const v2 = spread(fourDims(selfPlay(600, 50, undefined, botActionV2)));
  console.log(`[§6.4] 四维平均两两距离：新脑 ${v3.toFixed(4)}，V2 基线 ${v2.toFixed(4)}`);
  assert.ok(v3 > v2, `六个人的四维距离 ${v3.toFixed(4)} 没有超过 V2 基线 ${v2.toFixed(4)}`);
});

/* --------------------------------------------------- §4.4 线路一致性 */

test('§4.4 线路是承诺：同一手里的动作与当时那条线一致的比例 ≥90%', () => {
  const steps = selfPlay(1200);
  // 看牌不算 —— 看牌本身就是 §4.4 的一个信息点，看完就会重挑线路，
  // 它既不背叛旧线路也不属于新线路。
  const acts = steps.filter((s) => s.line && s.cmd.type !== 'look');
  const per = new Map<Line, { on: number; tot: number }>();
  let on = 0;
  for (const s of acts) {
    const ok = onPlan(s.line!, s.cmd.type);
    if (ok) on++;
    const st = per.get(s.line!) ?? { on: 0, tot: 0 };
    st.tot++;
    if (ok) st.on++;
    per.set(s.line!, st);
  }
  const share = pct(on, acts.length);
  console.log(
    `[§4.4 线路] 一致性 ${(share * 100).toFixed(1)}% (${on}/${acts.length})  `
    + [...per.entries()].sort((a, b) => b[1].tot - a[1].tot)
      .map(([k, v]) => `${k} ${(v.on / v.tot * 100).toFixed(0)}%/${v.tot}`).join(' '),
  );
  assert.ok(acts.length > 5000, `样本不够：${acts.length} 步`);
  // 九条线路都得真的被人走过 —— 全场只走一条线的「一致性 100%」不算数
  assert.ok(per.size >= 8, `只出现过 ${per.size} 条线路`);
  assert.ok(share >= 0.90, `线路一致性只有 ${(share * 100).toFixed(1)}%，验收要 ≥90%`);
});

/* ------------------------------------------- §4.9.4 情绪改变打法 */

/** 一批钉死的局面：五种牌力 × 三种价位。四种心情看到的是**同一批**局面。 */
const GRID_HANDS: Card[][] = [
  HANDS.trash, HANDS.smallStraight, HANDS.midFlush, HANDS.kFlush, HANDS.trips,
];
const GRID_PRICES = [
  { unit: 20_000, pot: 90_000, round: 3, looked: true },
  { unit: 50_000, pot: 220_000, round: 4, looked: true },
  { unit: 1_000, pot: 12_000, round: 1, looked: false },
];

const MOODS: Record<string, (m: MindState) => void> = {
  平静: () => {},
  上头: (m) => { m.e.anger = 1.2; m.e.rumination = 0.8; m.e.surprise = 0.4; },
  宽裕: (m) => { m.e.joy = 0.9; m.d.greed = 0.8; },
  怕: (m) => { m.e.fear = 0.9; m.e.worry = 0.8; m.d.safety = 0.9; },
};

/** 同一张人物卡、同一批局面，只换心情，跑出动作占比。 */
function mixUnder(
  tweak: (m: MindState) => void, seeds = 80, only?: (pr: typeof GRID_PRICES[number]) => boolean,
): Record<string, number> {
  const mix: Record<string, number> = {};
  let n = 0;
  for (const hand of GRID_HANDS) {
    for (const pr of GRID_PRICES) {
      if (only && !only(pr)) continue;
      const { room, bot } = scene({
        me: { name: '我', hand, looked: pr.looked, bet: pr.unit, chips: 300_000 },
        others: [
          { name: 'A', looked: true, bet: pr.unit * 2, events: [ev('raise', true, pr.unit, pr.round)] },
          { name: 'B', looked: false, bet: pr.unit, events: [ev('call', false, pr.unit, pr.round)] },
        ],
        pot: pr.pot, betUnit: pr.unit, roundNo: pr.round, turnCount: 9, position: 'late',
      });
      const mind = newMind(personaFor(bot).traits);
      mind.refBalance = 500_000;
      mind.peakBalance = 500_000;
      tweak(mind);
      room.memory![memoryKey(bot)] = { ...emptyMemory(memoryKey(bot)), mind };
      for (const cmd of sample(room, bot, seeds)) {
        mix[cmd.type] = (mix[cmd.type] ?? 0) + 1;
        n++;
      }
    }
  }
  for (const k of Object.keys(mix)) mix[k] /= n;
  return mix;
}

/** 两个动作分布的总变差：0 = 一模一样，1 = 毫无重叠。 */
function totalVariation(a: Record<string, number>, b: Record<string, number>): number {
  let sum = 0;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) sum += Math.abs((a[k] ?? 0) - (b[k] ?? 0));
  return sum / 2;
}

test('§4.9.4 同一局面、同一人物卡，四种情绪下的动作分布两两不同', () => {
  const mixes = Object.fromEntries(
    Object.entries(MOODS).map(([name, tweak]) => [name, mixUnder(tweak)]),
  );
  const names = Object.keys(MOODS);
  const lines: string[] = [];
  const pairs: [string, string, number][] = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const tv = totalVariation(mixes[names[i]], mixes[names[j]]);
      lines.push(`${names[i]}↔${names[j]} ${(tv * 100).toFixed(1)}%`);
      pairs.push([names[i], names[j], tv]);
    }
  }
  // 先把数字打出来再断言 —— 断言一炸，后面的 console.log 就再也执行不到了，
  // 而这几行正是调这套系数时唯一能看的东西。
  console.log(`[§4.9.4 情绪] ${lines.join('  ')}`);
  console.log(`[§4.9.4 情绪·弃牌率] ${
    names.map((n) => `${n} ${((mixes[n].fold ?? 0) * 100).toFixed(1)}%`).join('  ')}`);
  console.log(`[§4.9.4 情绪·看牌率] ${
    names.map((n) => `${n} ${((mixes[n].look ?? 0) * 100).toFixed(1)}%`).join('  ')}`);
  for (const [a, b, tv] of pairs) {
    assert.ok(tv > 0.04, `${a} 和 ${b} 的动作分布只差 ${(tv * 100).toFixed(1)}% —— 情绪没进决策`);
  }

  // 方向也必须对得上，不然「不同」可能只是噪声换了个地方
  const calm = mixes.平静, tilt = mixes.上头, ease = mixes.宽裕, fear = mixes.怕;
  assert.ok((tilt.fold ?? 0) < (calm.fold ?? 0), '上头之后反而更容易弃牌');
  assert.ok((tilt.raise ?? 0) > (calm.raise ?? 0), '上头之后反而更不敢加注');
  // 恐的两个通道（§4.9.6 常人卡：`foldThreshold −.5` 与 `lookEarlier +.4`）都要看见：
  // 怕的人一边更容易放手，一边更急着买信息。闷着的局面里「先看一眼」会把
  // 一部分弃牌吸走，所以「更容易弃」这条要在**已经看过牌**的局面里数 ——
  // 那里没有第三条路可走。
  assert.ok((fear.look ?? 0) > (calm.look ?? 0) * 1.3, '怕了反而不急着看牌（lookEarlier 没生效）');
  const calmLooked = mixUnder(MOODS.平静, 80, (pr) => pr.looked);
  const fearLooked = mixUnder(MOODS.怕, 80, (pr) => pr.looked);
  console.log(
    `[§4.9.4 情绪·看过牌之后的弃牌率] 平静 ${((calmLooked.fold ?? 0) * 100).toFixed(1)}%`
    + `  怕 ${((fearLooked.fold ?? 0) * 100).toFixed(1)}%`,
  );
  assert.ok((fearLooked.fold ?? 0) > (calmLooked.fold ?? 0), '怕了反而更不容易弃牌');
  assert.ok(
    (fear.call ?? 0) + (fear.raise ?? 0) < (calm.call ?? 0) + (calm.raise ?? 0),
    '怕了反而更愿意往里投钱',
  );
  assert.ok((fear.look ?? 0) > (calm.look ?? 0), '怕了反而更不想看清楚自己是什么');
  assert.ok((ease.compare ?? 0) > (calm.compare ?? 0), '宽裕的时候反而更不愿意开牌');
});

/**
 * 上一条把「上头」钉在 anger = 1.2 上，闷牌那一行的看牌率打出来是 0.0% ——
 * 一次都没看牌，而同一批局面平静时是 37.5%。一个情绪极值把某个动作压到 0，
 * 行为上就是一道「上头的人绝不看牌」的门槛，和 §4.5 说的
 * 「所有硬门槛都要拆掉」是同一件事 —— 情绪只许改**大小**，不许改**有没有**。
 *
 * 所以这里沿着 anger 走一条曲线：同一批闷牌局面（r1、一千块、池 12000），
 * anger 取 0 / 0.3 / 0.6 / 0.9 / 1.2 五档，看牌率必须
 *  - 相邻两档之间不出现断崖（差 < 0.55），
 *  - 最高档仍然严格大于 0（也小于 1）——「更不想看」不等于「绝不看」。
 *
 * 返工前后（§4.9.4）：35.25% / 14.75% / 1.00% / 0.25% / **0.00%**
 * → 35.25% / 14.50% / 1.00% / 1.25% / **1.25%**。两处结构性的零见
 * `adapter.ts` 的 `applyPlan`（`PEEK_SPAN` 与 `LOOK_GAP_KNEE`/`LOOK_TAIL`）。
 */
test('§4.9.4 上头不是开关：看牌率沿 anger 连续下降，最高档也不到 0', () => {
  const blindOnly = (pr: typeof GRID_PRICES[number]) => !pr.looked;
  const tiers = [0, 0.3, 0.6, 0.9, 1.2];
  /*
   * 每档 5 手牌 × 400 次采样 = 2000 步。样本量是**最高档那一格**定的：
   * 上头的人看牌本来就少（这条验收要的是「少」而不是「没有」），
   * 按 80 次采样量，一个千分之三的真实频率有七成的机会读成 0.0% ——
   * 那样这条断言量的是采样次数，不是机器人。
   */
  const SEEDS = 400;
  const rates = tiers.map((a) => {
    const mix = mixUnder((m) => {
      m.e.anger = a;
      m.e.rumination = 0.8 * (a / 1.2);
      m.e.surprise = 0.4 * (a / 1.2);
    }, SEEDS, blindOnly);
    return mix.look ?? 0;
  });
  const per = GRID_HANDS.length * SEEDS;
  console.log(`[§4.9.4 上头·看牌率] ${
    tiers.map((a, i) => `anger=${a.toFixed(1)} ${(rates[i] * 100).toFixed(2)}%(${
      Math.round(rates[i] * per)}/${per})`).join('  ')}`);
  for (let i = 0; i + 1 < rates.length; i++) {
    const step = Math.abs(rates[i + 1] - rates[i]);
    assert.ok(
      step < 0.55,
      `anger ${tiers[i]} → ${tiers[i + 1]} 之间看牌率跳了 ${(step * 100).toFixed(1)} 个点`
      + `（${(rates[i] * 100).toFixed(1)}% → ${(rates[i + 1] * 100).toFixed(1)}%）—— 这是一道门槛`,
    );
  }
  const top = rates[rates.length - 1];
  assert.ok(top > 0, `anger 拉满之后看牌率是 ${(top * 100).toFixed(1)}%：上头的人被写成了「绝不看牌」`);
  assert.ok(top < 1, `anger 拉满之后看牌率是 ${(top * 100).toFixed(1)}%：反过来也是门槛`);
});

/* ------------------------------------------------- §4.9.4 双系统 */

test('§4.9.4 一场 80 手打下来：系统 2 越来越懒，偏离最优解越来越多', () => {
  // 一整场不换桌 —— 疲劳（R20）与意志力（R30）本来就是「一场打下来」的量。
  // 打开离线对照：每一步都替他算一次系统 2 的最优解（不扣意志力、不影响动作），
  // 这样「偏离率」量的是「动作 ≠ 最优解」，而不是 1 − 介入率的同义反复。
  setDeliberateProbe(true);
  let steps: Step[];
  try { steps = selfPlay(80, 0); } finally { setDeliberateProbe(false); }
  const seg = (lo: number, hi: number) => steps.filter((s) => s.hand >= lo && s.hand < hi);
  const first = seg(0, 20), last = seg(60, 80);
  assert.ok(first.length > 100 && last.length > 100, `样本不够：${first.length} / ${last.length}`);
  assert.ok(steps.every((s) => s.deviated !== undefined),
    `有 ${steps.filter((s) => s.deviated === undefined).length} 步没有系统 2 对照，偏离率无从谈起`);
  const eng = (xs: Step[]) => pct(xs.filter((s) => s.engaged).length, xs.length);
  const dev = (xs: Step[]) => pct(xs.filter((s) => s.deviated).length, xs.length);
  // 对照组：只在真的开了系统 2 的那些步上数偏离 —— 它应该明显低于总体，
  // 否则说明「偏离」还是在跟着介入率走
  const s2Dev = pct(steps.filter((s) => s.engaged && s.deviated).length,
    steps.filter((s) => s.engaged).length);
  const s1Dev = pct(steps.filter((s) => !s.engaged && s.deviated).length,
    steps.filter((s) => !s.engaged).length);
  console.log(
    `[§4.9.4 双系统] 前20手 介入 ${(eng(first) * 100).toFixed(1)}% 偏离 ${(dev(first) * 100).toFixed(1)}%`
    + `  后20手 介入 ${(eng(last) * 100).toFixed(1)}% 偏离 ${(dev(last) * 100).toFixed(1)}%`
    + `  |  开了系统2的步偏离 ${(s2Dev * 100).toFixed(1)}%  纯直觉的步偏离 ${(s1Dev * 100).toFixed(1)}%`,
  );
  assert.ok(eng(last) < eng(first) - 0.05,
    `后 20 手的系统 2 介入率 ${(eng(last) * 100).toFixed(1)}% 没有明显低于前 20 手 ${(eng(first) * 100).toFixed(1)}%`);
  assert.ok(dev(last) > dev(first) + 0.05,
    `后 20 手的偏离率 ${(dev(last) * 100).toFixed(1)}% 没有明显高于前 20 手 ${(dev(first) * 100).toFixed(1)}%`);
  // 真实偏离率不能退化成 1 − 介入率：那样的话纯直觉步会 100% 偏离
  assert.ok(s1Dev < 0.95,
    `纯直觉的步偏离率 ${(s1Dev * 100).toFixed(1)}% —— 这是「没开系统 2 就算偏离」的同义反复`);
  assert.ok(s2Dev < s1Dev,
    `开了系统 2 的步偏离率 ${(s2Dev * 100).toFixed(1)}% 没有低于纯直觉的 ${(s1Dev * 100).toFixed(1)}%`);
});

test('§4.9.4 用时是系统 2 介入的痕迹', () => {
  // 看牌是本能，用时被 `shapeThinkTime` 单独压成 260–520ms，不参与这条统计
  const steps = selfPlay(120).filter((s) => s.cmd.type !== 'look');
  const s1 = steps.filter((s) => !s.engaged).map((s) => s.thinkMs);
  const s2 = steps.filter((s) => s.engaged).map((s) => s.thinkMs);
  assert.ok(s1.length > 200 && s2.length > 200, `样本不够：s1=${s1.length} s2=${s2.length}`);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  console.log(`[§4.9.4 用时] 直觉 ${mean(s1).toFixed(0)}ms  深思 ${mean(s2).toFixed(0)}ms`);
  assert.ok(mean(s2) > mean(s1) * 1.15,
    `深思平均 ${mean(s2).toFixed(0)}ms 没有明显长于直觉 ${mean(s1).toFixed(0)}ms`);
});

/* ------------------------------------------------ §4.9.4 情绪轨迹 */

test('§4.9.4 情绪轨迹：一场 80 手里机器人的怒/喜/恐真的在动，而且会消下去', () => {
  // 逐人记，最后挑坐得最久的那个看曲线 —— 打光筹码的人会离桌，
  // 事先钦定一个座位会让这条测试随调参抖动。
  const tracks = new Map<string, { anger: number; joy: number; fear: number }[]>();
  selfPlay(80, 0, (room) => {
    for (const p of room.players) {
      if (!p.isBot) continue;
      const m = room.memory?.[memoryKey(p)]?.mind;
      if (!m) continue;
      if (!tracks.has(p.name)) tracks.set(p.name, []);
      tracks.get(p.name)!.push({ anger: m.e.anger, joy: m.e.joy, fear: m.e.fear });
    }
  });
  let watchName = '';
  let track: { anger: number; joy: number; fear: number }[] = [];
  for (const [name, t] of tracks) if (t.length > track.length) { watchName = name; track = t; }
  assert.ok(track.length >= 40, `只记到 ${track.length} 手的情绪`);
  const spread = (k: 'anger' | 'joy' | 'fear') => {
    const xs = track.map((t) => t[k]);
    return Math.max(...xs) - Math.min(...xs);
  };
  console.log(
    `[§4.9.4 轨迹] ${watchName} 怒 ${spread('anger').toFixed(2)}`
    + ` 喜 ${spread('joy').toFixed(2)} 恐 ${spread('fear').toFixed(2)}`,
  );
  assert.ok(spread('anger') > 0.15, `怒的振幅只有 ${spread('anger').toFixed(3)} —— 情绪是死的`);
  assert.ok(spread('joy') > 0.15, `喜的振幅只有 ${spread('joy').toFixed(3)}`);

  // 峰值之后必须回落 —— 情绪要会消，不然一晚上都在上头
  const angers = track.map((t) => t.anger);
  const peak = angers.indexOf(Math.max(...angers));
  const after = angers.slice(peak + 1);
  assert.ok(
    after.length < 5 || Math.min(...after) < angers[peak] - 0.1,
    `怒冲到 ${angers[peak].toFixed(2)} 之后再也没消下去`,
  );
});

test('§4.9.1 一局之内情绪就在动：局中事件走 appraise 通道，不是到结算才跳一下', () => {
  const steps = selfPlay(400, 50);

  // 按「哪一局 + 哪个人」分组，只看在同一手牌里做过 ≥2 次决策的人
  const runs = new Map<string, typeof steps>();
  for (const st of steps) {
    const k = `${st.hand}#${st.seat}`;
    if (!runs.has(k)) runs.set(k, []);
    runs.get(k)!.push(st);
  }

  const KEYS: (keyof Emotions)[] = ['joy', 'anger', 'worry', 'rumination', 'sorrow', 'fear', 'surprise'];
  const drift = (a: Emotions, b: Emotions) => KEYS.reduce((m, k) => Math.max(m, Math.abs(a[k] - b[k])), 0);

  let multi = 0;
  let moved = 0;
  const kinds = new Map<string, number>();
  let sample: typeof steps = [];
  for (const run of runs.values()) {
    const rows = run.filter((r) => r.emotions);
    for (const r of rows) for (const k of r.felt ?? []) kinds.set(k, (kinds.get(k) ?? 0) + 1);
    if (rows.length < 2) continue;
    multi++;
    let max = 0;
    for (let i = 1; i < rows.length; i++) max = Math.max(max, drift(rows[i - 1].emotions!, rows[i].emotions!));
    if (max > 0.005) moved++;
    if (rows.length >= 4 && max > 0.05 && !sample.length) sample = rows;
  }

  assert.ok(multi >= 200, `只有 ${multi} 个「同一手牌里做过多次决策」的样本，统计不了`);
  const rate = moved / multi;
  console.log(
    `[§4.9.1 局中情绪] 同一手牌里情绪动过的比例 ${(rate * 100).toFixed(1)}% (${moved}/${multi})`
    + `  事件 ${[...kinds].map(([k, n]) => `${k}=${n}`).join(' ')}`,
  );
  if (sample.length) {
    const line = sample.map((r, i) => {
      const e = r.emotions!;
      return `#${i}${r.felt?.length ? `[${r.felt.join(',')}]` : ''}`
        + ` 喜${e.joy.toFixed(2)} 怒${e.anger.toFixed(2)} 忧${e.worry.toFixed(2)}`
        + ` 思${e.rumination.toFixed(2)} 悲${e.sorrow.toFixed(2)} 恐${e.fear.toFixed(2)} 惊${e.surprise.toFixed(2)}`;
    }).join('\n            ');
    console.log(`[§4.9.1 一局之内] ${sample[0].seat} 第 ${sample[0].hand} 手：\n            ${line}`);
  }

  assert.ok(
    rate > 0.90,
    `只有 ${(rate * 100).toFixed(1)}% 的牌局里情绪在中途动过 —— 局中事件没有进情绪`,
  );
  // 四类局中事件都要真的出现过，否则「接线了」只是接了个空
  for (const k of ['pressed', 'peeked', 'quit']) {
    assert.ok((kinds.get(k) ?? 0) > 0, `一局都没产生过 ${k} 事件`);
  }
});

/* --------------------------------------- 硬门槛的行为学反证（用户追加项） */

test('看牌不是一条 `roundNo >= 2` 的门槛：轮次是连续输入，人物卡说了算', () => {
  // 用真实自对弈，而不是一个手搓的局面 —— 手搓局面容易挑到饱和区，
  // 看到「第 2 轮 100%」会误判成门槛，其实只是那个价位下看牌确实压倒性地对。
  // 样本要够到第 4 轮：第 4 轮还闷着的人本来就少，局数不够就只能对 r1、r2 断言，
  // 而「第 3 轮之后到底还闷不闷得住」恰恰是这条验收要问的那件事。
  // 9000 局是**第 4 轮那一格的样本量**定的：机器人越会弃牌，牌局越早收，
  // 第 4 轮还站着又还闷着的步数就越少（5000 局时只剩 150 步左右，不够下限）。
  const steps = selfPlay(9000);

  // 只统计「当时还闷着」的那些步：这一步他有没有选择看牌。
  const byRound = new Map<number, [number, number]>();
  const byPersona = new Map<string, [number, number]>();
  /** 人物卡 → 轮次 → [看牌步数, 闷着的步数]。辛普森悖论就藏在这张表里。 */
  const byCardRound = new Map<string, Map<number, [number, number]>>();
  let blindSteps = 0;
  for (const s of steps) {
    if (s.looked) continue;
    blindSteps++;
    const r = Math.min(4, s.roundNo);
    const a = byRound.get(r) ?? [0, 0];
    a[1]++; if (s.cmd.type === 'look') a[0]++;
    byRound.set(r, a);
    const b = byPersona.get(s.seat) ?? [0, 0];
    b[1]++; if (s.cmd.type === 'look') b[0]++;
    byPersona.set(s.seat, b);
    const m = byCardRound.get(s.seat) ?? new Map<number, [number, number]>();
    const c = m.get(r) ?? [0, 0];
    c[1]++; if (s.cmd.type === 'look') c[0]++;
    m.set(r, c); byCardRound.set(s.seat, m);
  }

  /*
   * 样本量门槛按**实际到达该轮的比例**定，不再写死 200 步（补充二第 8 条）：
   * 牌桌修复删掉了「跟不起就被逼梭哈」的假路径之后，后段轮次本来就变少，
   * 一个绝对值门槛会把第 4 轮整格筛掉 —— 那正好把这条验收要问的那一格删了。
   * 0.5% 是相对全部闷着的步数说的：9000 局约 8.8 万步闷着的步，第 4 轮约 1800 步（2%），
   * 门槛 0.5% ≈ 440 步，既容得下第 4 轮，也挡得住只剩几十步的第 5 轮残格。
   */
  const ROUND_FLOOR = Math.max(120, Math.round(blindSteps * 0.005));
  const rounds = [...byRound.entries()]
    .filter(([, [, n]]) => n >= ROUND_FLOOR)
    .sort((x, y) => x[0] - y[0]);
  console.log(
    `[无门槛] 闷着的步数 ${blindSteps}，轮次样本下限 ${ROUND_FLOOR}；各轮次看牌率 `
    + rounds.map(([r, [a, n]]) => `r${r}=${(a / n * 100).toFixed(1)}%(${a}/${n})`).join(' '),
  );

  // ① 一条 `roundNo >= 2 return look` 的门槛会让第 2 轮起变成 100%；
  //    一条 `roundNo >= 3 return look` 则让第 3 轮变成 100%。**每一轮**都要检查，
  //    只查 r1、r2 的话，第 3 轮那条隐形门槛正好躲在断言外面。
  assert.ok(rounds.length >= 4, `样本只覆盖到 ${rounds.length} 个轮次（要 r1..r4 都够 ${ROUND_FLOOR} 步）`);
  for (const [r, [a, n]] of rounds) {
    const rate = a / n;
    assert.ok(
      rate > 0.05 && rate < 0.95,
      `第 ${r} 轮的看牌率是 ${(rate * 100).toFixed(1)}%（${a}/${n}）—— 逼近 0 或 1 就是被写死了`,
    );
  }

  /*
   * ② 门槛的指纹是阶跃。轮次往后走，**同一个人**的看牌率是爬上去的，不是跳上去的。
   *
   * 这里必须按人物卡分开判，桌面级的合计会骗人（辛普森悖论）：
   * 越往后走，还闷着的人越挑，剩下的是「闷得住」的那几张卡（老王、小北），
   * 于是桌面合计的看牌率会在第 4 轮掉下来 —— 掉的是**人的构成**，不是任何一个人的习惯。
   * 把八张卡各判各的，桌面级只保留 ①（不贴 0 也不贴 1）这条与构成无关的断言。
   */
  const CARD_FLOOR = Math.max(60, Math.round(blindSteps * 0.0015));
  let judged = 0;
  for (const [card, m] of [...byCardRound.entries()].sort()) {
    const rs = [...m.entries()].filter(([, [, n]]) => n >= CARD_FLOOR).sort((x, y) => x[0] - y[0]);
    console.log(
      `[无门槛·卡] ${card} `
      + rs.map(([r, [a, n]]) => `r${r}=${(a / n * 100).toFixed(1)}%(${a}/${n})`).join(' '),
    );
    if (rs.length < 3) continue;   // 这张卡后段没样本，说明不了阶跃
    judged++;
    for (let i = 1; i < rs.length; i++) {
      const [pr, [pa, pn]] = rs[i - 1];
      const [cr, [ca, cn]] = rs[i];
      const prev = pa / pn, cur = ca / cn;
      assert.ok(
        cur >= prev - 0.10,
        `${card} 到第 ${cr} 轮反而更不想看牌了：r${pr} ${prev.toFixed(2)} → r${cr} ${cur.toFixed(2)}`,
      );
      assert.ok(
        cur - prev < 0.55,
        `${card} 的看牌率从第 ${pr} 轮的 ${(prev * 100).toFixed(0)}% 跳到第 ${cr} 轮的 `
        + `${(cur * 100).toFixed(0)}% —— 这是一条硬门槛的形状`,
      );
    }
  }
  assert.ok(judged >= 4, `只有 ${judged} 张卡的后段样本够判阶跃`);

  // ③ 同一批局面下，不同的人物卡看牌快慢明显不同 —— 门槛对谁都一样，习惯不是。
  const spread = [...byPersona.values()].filter(([, n]) => n >= 300).map(([a, n]) => a / n);
  const gap = Math.max(...spread) - Math.min(...spread);
  console.log(
    '[无门槛] 各人物卡看牌率 '
    + [...byPersona.entries()].filter(([, [, n]]) => n >= 300)
      .map(([k, [a, n]]) => `${k}=${(a / n * 100).toFixed(0)}%`).join(' '),
  );
  assert.ok(spread.length >= 4, '人物卡样本不够');
  assert.ok(gap >= 0.08, `最爱看牌和最不爱看牌的人只差 ${(gap * 100).toFixed(1)}% —— 人物卡没起作用`);
});
