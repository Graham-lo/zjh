/**
 * S1–S20 场景台（设计文档 §3 / §6.3）。
 *
 * 每一条都构造一个固定局面，跑 200 个不同的 `actionSeq` 种子，断言动作分布落在区间内。
 * 单个决策是带随机的，一条断言只有在**分布**上才说得清楚 —— 「他有时候会诈唬」
 * 不是任何一次单独的决策能证明的事。
 *
 * 这一期（P1 信息模型）只开 S6/S7/S8/S9/S10/S20：它们全都只依赖范围模型。
 * 其余 14 条要等 P2 的线路/前瞻和 P3 的人格目录，先留 `todo` 占位 ——
 * **不写假的通过**，todo 是诚实的「还没做」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCommand, createHumanPlayer, createInitialRoom, emptyMemory, handPercentile, memoryKey,
  type GameCommand,
} from '../shared/game.ts';
import { bucketKey, editBucket } from '../shared/zjh/bot/profile.ts';
import { expectedPercentile, priorDist, pWin, refine, tightenForAccept, warmUpRange } from '../shared/zjh/bot/range.ts';
import { COMMON } from '../shared/zjh/bot/range.ts';
import { HANDS, c, ev, onLine, sample, sampleOffTurn, sampleWithPlan, scene, share, tally } from './zjh-helpers.ts';
import { zjhOffTurnDelay } from '../shared/games.ts';
import { newMind, readMind, type MindState } from '../shared/mind/emotion.ts';
import { PERSONAS, personaFor } from '../shared/zjh/bot/personas/index.ts';
import { emoteFor } from '../shared/zjh/bot/tempo.ts';
import { buildSituation } from '../shared/zjh/bot/situation.ts';
import { zjhAdapter } from '../shared/zjh/bot/adapter.ts';
import { evCall, evCompare } from '../shared/zjh/bot/lookahead.ts';


warmUpRange();

/* ------------------------------------------------------ 分位基准（自检） */

test('场景台的手牌分位落在预期档位上', () => {
  // 带 = 发牌分布的累计（2026-09-04 回调后：散牌 [0,.60]、对子 [.60,.74]、顺子 [.74,.84]、
  // 金花 [.84,.96]、顺金 [.96,.978]、豹子 [.978,1]），所以牌型档位的绝对分位全体上移。
  assert.ok(handPercentile(HANDS.trash) < 0.25, '散牌 2/4/7 在散牌带的下段');
  assert.ok(handPercentile(HANDS.smallStraight) > 0.74 && handPercentile(HANDS.smallStraight) < 0.78, '小顺子在顺子档下沿');
  assert.ok(handPercentile(HANDS.midFlush) > 0.84 && handPercentile(HANDS.midFlush) < 0.96, '中等金花');
  assert.ok(handPercentile(HANDS.aFlush) > 0.94 && handPercentile(HANDS.aFlush) < 0.96, 'A 高金花在金花档上沿');
  assert.ok(handPercentile(HANDS.trips) > 0.978, '豹子');

  // 同分位替身：它们在新带里的分位，等于旧带里被替下来那一手的分位（误差 < 0.01）
  const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
  assert.ok(near(handPercentile(HANDS.smallJunk), 0.133), '5 高散牌 ≈ 旧「小顺子」0.133');
  assert.ok(near(handPercentile(HANDS.midJunk), 0.291), '10 高散牌 ≈ 旧「中等顺子」0.291');
  assert.ok(near(handPercentile(HANDS.smallPair), 0.619), '一对 3 ≈ 旧「J 高金花」0.619');
  assert.ok(near(handPercentile(HANDS.midPair), 0.668), '一对 7 ≈ 旧「K 高金花」0.668');
  assert.ok(near(handPercentile(HANDS.kingPair), 0.735), '一对 K ≈ 旧「A 高金花」0.735');
});

/* --------------------------------------------------------------- P1 场景 */

test('S6 挑软柿子：A 连加两次、B 闷跟到刚看牌，要比就比 B', () => {
  const { room, bot, by } = scene({
    // 一对 K 带 10 —— 0.736，回调前「A 高金花」在这张桌子上的位置（下一条 S6 附是同一张桌子）
    me: { name: '我', hand: HANDS.kingPair, looked: true, bet: 40_000 },
    others: [
      // A：看了牌连加两手 —— 这串动作在似然表里是最硬的一种
      { name: 'A', looked: true, bet: 60_000, events: [ev('raise', true, 20_000), ev('raise', true, 50_000, 2)] },
      // B：一路闷跟，刚看完牌也只肯平跟
      { name: 'B', looked: true, bet: 30_000, events: [ev('call', false, 1_000), ev('call', false, 20_000, 2), ev('call', true, 50_000, 3)] },
    ],
    pot: 130_000,
    betUnit: 50_000,
    roundNo: 4,
    position: 'late',
  });

  /*
   * 这一条测的是**挑谁**，不是**比不比**。
   *
   * 原来的写法先要求 200 个种子里至少比 20 次，再看这些比牌有多少挑了 B。
   * P2 把比牌的价钱改对之后（§4.6：比牌是「多付一口的钱换掉一个对手」，
   * 而且赢了还得从剩下的人手里守住池子），这个局面的账是这样的：
   * 跟一口 10 万、开一次牌 20 万，锅里只有 13 万，A 还是一手连加两次的牌 ——
   * 系统 2 算出来跟注 −3.1 万、开牌 −10.2 万，于是它一次也不开。
   * 这不是「挑软柿子」坏了，是这个价位上开牌本来就不划算（竞技场里比牌照常发生）。
   * 所以断言落在**系统 1 的冲动排序**上：想开牌的时候，他想开的是 B 不是 A。
   */
  const mind = readMind(undefined, personaFor(bot).traits);
  let softer = 0;
  for (let seq = 0; seq < 200; seq++) {
    room.actionSeq = seq;
    const persona = personaFor(bot);
    const sit = buildSituation(room, bot, persona, mind);
    const ad = zjhAdapter(sit);
    const scores = ad.intuition(ad.coarse(sit, mind), mind, persona.traits).scores;
    const scoreOf = (name: string) => {
      const id = by(name).id;
      const hit = scores.find((x) => x.action.targetId === id);
      return hit ? hit.score : Number.NEGATIVE_INFINITY;
    };
    if (scoreOf('B') > scoreOf('A')) softer++;
  }
  assert.ok(softer / 200 >= 0.9, `只有 ${(softer / 2).toFixed(0)}% 的种子里「开 B」比「开 A」更有吸引力`);
});

/**
 * S6 附：上一条把「比不比」让给了这一条。
 *
 * 之前这里是个 todo，理由写的是「得先给比牌补上『赢了之后还能弃』的实现价值」——
 * 那确实是 P2 前瞻（§4.5 第 144 行把「比牌/梭哈选项」划在 `lookahead.ts` 里）漏掉的一块。
 * 现在补上了：赢了他之后不是当场把池子端走，而是**接着打那张少了一个人的桌子**，
 * 池子里还多了我这一刀，下一个信息点我仍然可以退出（`max(0, continueValue)`）。
 *
 * 补完之后这个价位的账还是负的 —— 那不是模型的毛病，是价钱：锅里 13 万，
 * 跟一口 10 万，开一次牌要 20 万。所以这一条从「todo」变成一条**带数字的断言**：
 * 开牌的账负得比跟注还多，200 个种子里一次都没开；而同一张桌子把单价降到 2 万，
 * 开牌就出现了 —— 零是价格压出来的，不是这条路根本不通。
 *
 * 顺带钉住新公式的一个直接后果：旧写法是 `pWin_i × P(赢过其余所有人)`，
 * 这个乘积对每个目标**恒等**（都等于「赢过全场」的概率），所以系统 2 的账
 * 根本分不出该开谁 —— §4.6 第 80 行要的「按『我赢他的概率 × 清掉他的价值』选」
 * 在旧公式里是算不出来的。现在两个目标的账必须不一样。
 */
test('S6 附：这个价位上他确实不开牌 —— 开牌的账是负的', () => {
  const table = (betUnit: number) => {
    const { room, bot, by } = scene({
      // 一对 K 带 10 —— 0.736，回调前「A 高金花」的位置
      me: { name: '我', hand: HANDS.kingPair, looked: true, bet: 40_000 },
      others: [
        { name: 'A', looked: true, bet: 60_000, events: [ev('raise', true, 20_000), ev('raise', true, 50_000, 2)] },
        { name: 'B', looked: true, bet: 30_000, events: [ev('call', false, 1_000), ev('call', false, 20_000, 2), ev('call', true, 50_000, 3)] },
      ],
      pot: 130_000,
      betUnit,
      roundNo: 4,
      position: 'late',
    });
    const mind = readMind(undefined, personaFor(bot).traits);
    room.actionSeq = 0;
    const evIn = buildSituation(room, bot, personaFor(bot), mind).ev;
    const at = (name: string) => evCompare(evIn, evIn.opponents.findIndex((o) => o.id === by(name).id));
    const cmds = sample(room, bot);
    return { call: evCall(evIn), a: at('A'), b: at('B'), compares: share(cmds, (c) => c?.type === 'compare') };
  };

  const dear = table(50_000);
  console.log(
    `[S6 附] 单价 5 万：跟 ${dear.call.toFixed(3)}  开 A ${dear.a.toFixed(3)}  开 B ${dear.b.toFixed(3)}`
    + `  实际开牌 ${(dear.compares * 100).toFixed(1)}%`,
  );
  assert.ok(dear.a < 0 && dear.b < 0, `开牌的账不是负的：A ${dear.a.toFixed(3)} / B ${dear.b.toFixed(3)}`);
  assert.ok(
    Math.max(dear.a, dear.b) < dear.call,
    `开牌 ${Math.max(dear.a, dear.b).toFixed(3)} 没有输给跟注 ${dear.call.toFixed(3)}，那他就该开牌了`,
  );
  assert.ok(dear.compares <= 0.02, `这个价位上还有 ${(dear.compares * 100).toFixed(1)}% 在开牌`);
  assert.ok(
    Math.abs(dear.a - dear.b) > 0.05,
    `两个目标的账几乎一样（A ${dear.a.toFixed(3)} / B ${dear.b.toFixed(3)}）—— 前瞻没有分出「清掉谁」的价值`,
  );

  // 同一张桌子、同一手牌，只把单价降下来：账跟着价钱一路抬上去，开牌就出现了。
  const cheap = table(20_000);
  console.log(
    `[S6 附] 单价 2 万：跟 ${cheap.call.toFixed(3)}  开 A ${cheap.a.toFixed(3)}  开 B ${cheap.b.toFixed(3)}`
    + `  实际开牌 ${(cheap.compares * 100).toFixed(1)}%`,
  );
  assert.ok(cheap.a > dear.a && cheap.b > dear.b, '降价之后开牌的账没有变好 —— 那这个零就不是价格压出来的');
  assert.ok(cheap.compares > 0, '降到两万一刀还是一次都不开 —— 比牌这条路是死的');
});

test('S7 躲强：紧手看牌后连加两次，中下牌直接弃', () => {
  const { room, bot } = scene({
    // 10 高散牌 —— 新带里的 0.291，正是回调前「中等顺子」在这张桌子上的位置
    me: { name: '我', hand: HANDS.midJunk, looked: true, bet: 20_000 },
    others: [
      { name: 'A', looked: true, bet: 70_000, profile: 'tight', events: [ev('raise', true, 20_000), ev('raise', true, 50_000, 2)] },
    ],
    pot: 90_000,
    betUnit: 50_000,
    roundNo: 3,
    position: 'early',
  });
  const folds = share(sample(room, bot), (c) => c?.type === 'fold');
  assert.ok(folds >= 0.95, `面对紧手的两次加注还有 ${((1 - folds) * 100).toFixed(0)}% 在继续`);
});

test('S8 看谁梭的：老实人梭哈，中上牌要弃', () => {
  const { room, bot } = scene({
    // 一对 7 带 Q —— 新带里的 0.667，回调前「K 高金花」的位置
    me: { name: '我', hand: HANDS.midPair, looked: true, bet: 20_000 },
    others: [
      {
        name: '老实人', looked: true, bet: 120_000, chips: 0, profile: 'tight',
        events: [ev('call', true, 20_000), ev('all_in', true, 50_000, 3)],
      },
    ],
    pot: 160_000,
    betUnit: 50_000,
    roundNo: 3,
    allIn: { initiator: '老实人', accepted: [], base: 60_000 },
  });
  const folds = share(sample(room, bot), (c) => c?.type === 'fold');
  assert.ok(folds >= 0.95, `老实人梭哈还有 ${((1 - folds) * 100).toFixed(0)}% 在接`);
});

test('S9 疯子梭哈：同样的价格、更差的牌，反而要接', () => {
  const { room, bot } = scene({
    // 一对 3 带 10 —— 0.619，比 S8 那手 0.667 更差；两条只差在「梭的是谁」
    me: { name: '我', hand: HANDS.smallPair, looked: true, bet: 20_000 },
    others: [
      {
        name: '疯子', looked: true, bet: 120_000, chips: 0, profile: 'maniac',
        events: [ev('raise', true, 20_000), ev('all_in', true, 50_000, 3)],
      },
    ],
    pot: 160_000,
    betUnit: 50_000,
    roundNo: 3,
    allIn: { initiator: '疯子', accepted: [], base: 60_000 },
  });
  const calls = share(sample(room, bot), (c) => c?.type === 'call');
  assert.ok(calls >= 0.95, `疯子梭哈只接了 ${(calls * 100).toFixed(0)}%`);
});

test('S10 多人梭哈：强牌也要弃 —— 要同时赢过两家，其中一家还是紧手', () => {
  const { room, bot } = scene({
    // 一对 K 带 10 —— 0.736，回调前「A 高金花」的位置
    me: { name: '我', hand: HANDS.kingPair, looked: true, bet: 20_000 },
    others: [
      {
        name: '发起人', looked: true, bet: 120_000, chips: 0, profile: 'unknown',
        events: [ev('raise', true, 20_000), ev('all_in', true, 50_000, 3)],
      },
      {
        name: '紧手', looked: true, bet: 120_000, chips: 0, profile: 'tight',
        events: [ev('call', true, 20_000), ev('call', true, 50_000, 3)],
      },
      { name: '路人', looked: false, bet: 10_000, events: [ev('call', false, 20_000)] },
    ],
    pot: 280_000,
    betUnit: 50_000,
    roundNo: 3,
    allIn: { initiator: '发起人', accepted: ['紧手'], base: 60_000 },
  });
  const folds = share(sample(room, bot), (c) => c?.type === 'fold');
  assert.ok(folds >= 0.95, `两家已接还有 ${((1 - folds) * 100).toFixed(0)}% 在跟`);
});

test('S20 排除法：比牌看到的那手牌会进牌堆约束，改变对其余人的判断', () => {
  // 我 A 高红桃金花；B 已经被我比掉，我看到他是黑桃大金花。
  const bHand = [c(13, 'S'), c(12, 'S'), c(9, 'S')];
  const build = (revealB: boolean) => scene({
    me: { name: '我', hand: HANDS.aFlush, looked: true, bet: 20_000 },
    others: [
      { name: 'A', looked: true, bet: 40_000, events: [ev('raise', true, 20_000, 2)] },
      { name: 'B', hand: bHand, looked: true, bet: 40_000, events: [ev('call', true, 20_000, 2)] },
    ],
    pot: 100_000,
    betUnit: 20_000,
    roundNo: 3,
    position: 'late',
    seen: revealB ? ['B'] : [],
  });

  // ① 信息边界：看得到的那手牌真的进得来，看不到的一张都进不来。
  const hidden = build(false);
  const shown = build(true);
  assert.deepEqual(hidden.by('B').hand, bHand, '构造本身没问题');

  // ② 扣牌之后，对手还能拿到「大过我」的金花的概率必须下降 ——
  //    黑桃 K/Q/9 已经在桌上了，剩下的大金花只可能是 A 打头。
  const mine = handPercentile(HANDS.aFlush);
  const before = pWin(mine, priorDist(HANDS.aFlush));
  const after = pWin(mine, priorDist([...HANDS.aFlush, ...bHand]));
  assert.ok(after > before, `扣掉已见的三张之后胜率应该上升：${before.toFixed(4)} → ${after.toFixed(4)}`);

  // ③ 而且这件事要真的传到决策里去：同一个局面，见过和没见过的动作分布必须不同。
  const a = sample(hidden.room, hidden.bot).map((c) => JSON.stringify(c)).join('|');
  const b = sample(shown.room, shown.bot).map((c) => JSON.stringify(c)).join('|');
  assert.notEqual(a, b, '看到过的牌没有影响任何一步决策 —— 信息没接进来');
});

/* ------------------------------------------------------- §4.6 梭哈两端 */

test('§4.6 接梭哈的范围：越是「从来不接」的人，接了就越硬', () => {
  const prior = priorDist([]);
  const never = expectedPercentile(tightenForAccept(prior, 0.05));
  const often = expectedPercentile(tightenForAccept(prior, 0.95));
  const base = expectedPercentile(prior);
  assert.ok(never - base > 0.18, `一晚上没接过的人接了这一次，范围必须明显收紧（${base.toFixed(3)} → ${never.toFixed(3)}）`);
  assert.ok(Math.abs(often - base) < 0.05, `来者不拒的人接了什么也说明不了（${base.toFixed(3)} → ${often.toFixed(3)}）`);
  assert.ok(never > often, '「接的门槛」必须是单调的');
});

test('§4.6 发起端：不往一桌一吓就跑的人脸上梭 —— 豹子要的是被跟，不是把人吓走', () => {
  const { room, bot } = scene({
    me: { name: '我', hand: HANDS.trips, looked: true, bet: 50_000, chips: 300_000 },
    others: [
      // 两个「面对压力就跑」的人（跨局印象 tight：20 次压力弃了 16 次）
      { name: 'A', looked: true, bet: 50_000, chips: 300_000, profile: 'tight', events: [ev('call', true, 20_000), ev('call', true, 50_000, 2)] },
      { name: 'B', looked: true, bet: 50_000, chips: 300_000, profile: 'tight', events: [ev('call', true, 20_000), ev('call', true, 50_000, 2)] },
    ],
    pot: 200_000,
    betUnit: 50_000,
    roundNo: 3,
    position: 'late',
    compareUnlockAt: 999,
  });
  const cmds = sample(room, bot);
  const shove = share(cmds, (c) => c?.type === 'all_in');
  const press = share(cmds, (c) => c?.type === 'raise' || c?.type === 'call');
  assert.ok(shove <= 0.05, `一手豹子往一吓就跑的桌上梭了 ${(shove * 100).toFixed(0)}% —— 这是把钱吓跑`);
  assert.ok(press >= 0.75, `不梭不等于不打：继续加压/跟注只有 ${(press * 100).toFixed(0)}%`);
});

test('§4.6 发起端：同一手豹子，桌上换成来者不拒的人，打法要跟着变', () => {
  const build = (profile: 'tight' | 'maniac') => scene({
    me: { name: '我', hand: HANDS.trips, looked: true, bet: 50_000, chips: 300_000 },
    others: [
      { name: 'A', looked: true, bet: 50_000, chips: 300_000, profile, events: [ev('call', true, 20_000), ev('call', true, 50_000, 2)] },
      { name: 'B', looked: true, bet: 50_000, chips: 300_000, profile, events: [ev('call', true, 20_000), ev('call', true, 50_000, 2)] },
    ],
    pot: 200_000,
    betUnit: 50_000,
    roundNo: 3,
    position: 'late',
    compareUnlockAt: 999,
  });
  const scared = build('tight');
  const loose = build('maniac');
  const raiseScared = share(sample(scared.room, scared.bot), (c) => c?.type === 'raise');
  const raiseLoose = share(sample(loose.room, loose.bot), (c) => c?.type === 'raise');
  assert.ok(
    raiseLoose > raiseScared + 0.20,
    `对手换了一批人，加注率却几乎没动：${(raiseScared * 100).toFixed(0)}% → ${(raiseLoose * 100).toFixed(0)}%`,
  );
});

test('§4.6 接梭哈用的是跨局统计：这个人接过几次，是从牌局里记下来的', () => {
  const room = createInitialRoom('AI0001', createHumanPlayer('甲', '🐯', 0, 'h0'));
  room.players.push(createHumanPlayer('乙', '🦊', 1, 'h1'));
  room.players.push(createHumanPlayer('丙', '🐻', 2, 'h2'));
  for (const p of room.players) { p.ready = true; p.chips = 100_000; }
  applyCommand(room, room.hostId, { type: 'start' });
  room.roundNo = 3;
  room.turnSeat = room.players[0].seat;
  applyCommand(room, room.players[0].id, { type: 'all_in' });
  // 被梭的两家：一个接、一个弃
  applyCommand(room, room.players[1].id, { type: 'call' });
  applyCommand(room, room.players[2].id, { type: 'fold' });

  const read = (i: number) => room.memory?.[memoryKey(room.players[i])];
  assert.equal(read(1)?.allInFaced, 1, '接梭哈的人要记一次「面对过」');
  assert.equal(read(1)?.allInTaken, 1, '……而且这一次是接了');
  assert.equal(read(2)?.allInFaced, 1, '弃掉的人同样面对过');
  assert.equal(read(2)?.allInTaken ?? 0, 0, '弃掉不算接');
});

/* ------------------------------------------------- 范围模型自身的自检 */

test('两次看牌加注会显著收紧范围，闷牌加注几乎不动', () => {
  const prior = priorDist([]);
  const settings = createInitialRoom('X', createHumanPlayer('x', '🐯', 0, 'x')).settings;
  const lookedRaises = refine(prior, [ev('raise', true, 20_000), ev('raise', true, 50_000, 2)], COMMON, settings);
  const blindRaises = refine(prior, [ev('raise', false, 20_000), ev('raise', false, 50_000, 2)], COMMON, settings);
  const base = expectedPercentile(prior);
  assert.ok(expectedPercentile(lookedRaises) - base > 0.10, '看牌连加两次必须明显收紧');
  assert.ok(Math.abs(expectedPercentile(blindRaises) - base) < 0.05, '闷牌加注几乎不含信息');
});

/* ----------------------------------------------------- 还没做的场景 */

test('S1 闷压看：单挑闷牌面对已看牌的平跟，应该继续闷加', () => {
  const { room, bot } = scene({
    // 我闷着，一口一千；对方已经看了牌，只肯平跟 —— 他每口要掏我的两倍
    me: { name: '我', hand: HANDS.midFlush, looked: false, bet: 1_000, chips: 400_000 },
    others: [{ name: 'A', looked: true, bet: 3_000, chips: 400_000, events: [ev('call', true, 1_000, 1)] }],
    pot: 4_000,
    betUnit: 1_000,
    roundNo: 1,
    turnCount: 2,
    position: 'late',
    compareUnlockAt: 2,
  });

  /*
   * 这里必须**按线路**看，不能把 200 手混在一起算比例。
   *
   * 「闷压」是开局就定下的打法（§4.4）；同一个局面里抽到「收口」「便宜看戏」的那些手
   * 本来就该打成别的样子。混在一起问「他闷加了几成」，问的是「这张人物卡有多爱闷压」，
   * 不是这一条要测的东西 —— 这一条测的是：**打算闷压的人，会不会真的闷压**。
   */
  const rows = sampleWithPlan(room, bot);
  const press = onLine(rows, '闷压');
  assert.ok(press.length >= 40, `200 手里只有 ${press.length} 手走闷压，样本太少`);
  const raise = share(press, (c) => c?.type === 'raise');
  assert.ok(raise >= 0.6, `打算闷压却只有 ${(raise * 100).toFixed(0)}% 真的闷着加价`);
  assert.equal(share(press, (c) => c?.type === 'fold'), 0, '一千的价钱不该有人退');
  // 线路一致性：闷压这条线上不许出现「跟一口了事」
  assert.ok(share(press, (c) => c?.type === 'call') <= 0.05, '闷压线上平跟等于没在压');
});
test('S2 闷比：闷跟三轮后直接闷着比牌', () => {
  const U = 20_000;
  // 看过牌、一路只肯平跟到第三轮的对手 —— 「对方看牌后长考才跟」（§5 S2）在 P2
  // 只能用行动本身表示（用时信号是 P3 的 S17）：看了牌还只肯平跟就是软。
  const caller = (name: string) => ({
    name, looked: true, bet: 6 * U, chips: 400_000,
    events: [ev('call', true, 2_000, 1), ev('call', true, 2 * U, 2), ev('call', true, 2 * U, 3)],
  });
  const { room, bot } = scene({
    // 闷着跟到第三轮：底注 + 三口闷跟，单价升到两万，我这一口还是半价一万，
    // 而继续跟下去每一轮都要再掏一万 —— 「与其一口口掏，不如半价把它摊了」（§4.4 闷比）。
    me: {
      name: '我', hand: HANDS.midFlush, looked: false, bet: 3 * U, chips: 400_000,
      events: [ev('call', false, 1_000, 1), ev('call', false, U, 2), ev('call', false, U, 3)],
    },
    // 五个人还在桌上：人多的时候「闷加一档把他顶走」（闷压）这条线本身就不成立
    // （`lineFit` 里 `闷压` 要的是单挑或 ≤2 人），闷比才是闷着打的人剩下的出路。
    others: [caller('A'), caller('B'), caller('C'), caller('D')],
    pot: 3 * U + 4 * 6 * U,
    betUnit: U,
    roundNo: 3,
    turnCount: 20,
    position: 'late',
    compareUnlockAt: 2,
  });

  // 和 S1 一样按线路看：这一条问的是「打算闷比的人，会不会真的闷着把牌摊了」。
  const rows = sampleWithPlan(room, bot);
  const cmp = onLine(rows, '闷比');
  assert.ok(cmp.length >= 30, `200 手里只有 ${cmp.length} 手走闷比，样本太少`);
  const compare = share(cmp, (c) => c?.type === 'compare');
  assert.ok(compare >= 0.6, `打算闷比却只有 ${(compare * 100).toFixed(0)}% 真的闷着开牌`);
  // 闷比的关键是**没有先看牌**：先看一眼再比就不叫闷比了，那是另一条线
  // （§4.4 的退出条件栏里，闷比那一行写的是「—」，见 `planDropsLook`）。
  assert.equal(share(cmp, (c) => c?.type === 'look'), 0, '闷比线上先看牌等于这条线没成立');
  // 而且这一桌整体上真的会出现「闷着开牌」，不是只有个别种子撞上
  assert.ok(share(rows.map((r) => r.cmd), (c) => c?.type === 'compare') >= 0.10,
    '200 手里几乎没有闷着开牌的');
});
test('S3 秒弃：还没轮到自己就弃掉散牌', () => {
  const { room, bot } = scene({
    me: { name: '我', hand: HANDS.trash, looked: true, bet: 21_000, chips: 400_000 },
    others: [
      { name: 'A', looked: true, bet: 121_000, chips: 400_000, events: [ev('raise', true, 100_000, 2)] },
      { name: 'B', looked: false, bet: 21_000, chips: 400_000 },
    ],
    pot: 260_000,
    betUnit: 100_000,
    roundNo: 2,
    position: 'early',
  });
  const cmds = sampleOffTurn(room, bot);
  const quit = share(cmds, (c) => c?.type === 'fold');
  assert.ok(quit >= 0.8, `别人加到十万，手里一把散牌，却只有 ${(quit * 100).toFixed(0)}% 当场就退`);
});

test('S3 附：好牌不会跟着一起退 —— 非回合动作不是「一惊就跑」', () => {
  const { room, bot } = scene({
    me: { name: '我', hand: HANDS.trips, looked: true, bet: 21_000, chips: 400_000 },
    others: [
      { name: 'A', looked: true, bet: 121_000, chips: 400_000, events: [ev('raise', true, 100_000, 2)] },
      { name: 'B', looked: false, bet: 21_000, chips: 400_000 },
    ],
    pot: 260_000,
    betUnit: 100_000,
    roundNo: 2,
    position: 'early',
  });
  const cmds = sampleOffTurn(room, bot);
  assert.ok(share(cmds, (c) => c?.type === 'fold') <= 0.05, '一手豹子居然抢在轮到自己之前弃掉了');
  // 想跟、想加、想比都得等轮到自己 —— 非回合只放行「不占行动权」的那两件事
  assert.ok(share(cmds, (c) => c === null) >= 0.9, '好牌在非回合应该按兵不动');
  assert.ok(cmds.every((c) => c === null || c?.type === 'look' || c?.type === 'fold'), '非回合动作只能是看牌或弃牌');
});

test('S4 先看再说：前面有人加档时先看牌，不等轮到自己', () => {
  for (const unit of [20_000, 50_000, 100_000]) {
    const { room, bot } = scene({
      me: { name: '我', looked: false, bet: 1_000, chips: 400_000 },
      others: [
        { name: 'A', looked: true, bet: unit * 2 + 1_000, chips: 400_000, events: [ev('raise', true, unit, 2)] },
        { name: 'B', looked: false, bet: 1_000, chips: 400_000 },
      ],
      pot: 60_000 + unit * 2,
      betUnit: unit,
      roundNo: 2,
      position: 'early',
    });
    const look = share(sampleOffTurn(room, bot), (c) => c?.type === 'look');
    assert.ok(look >= 0.8, `升到 ${unit / 10_000} 万档，却只有 ${(look * 100).toFixed(0)}% 会先把牌看了`);
  }
});

test('S3/S4 的延迟：注意到 + 伸手，落在 300–900ms 里', () => {
  const lo = zjhOffTurnDelay(() => 0);
  const hi = zjhOffTurnDelay(() => 1 - 1e-9);
  assert.equal(lo, 300, '再快也是人，不是抢答器');
  assert.ok(hi < 900 && hi >= 890, `最慢 ${hi}ms —— 超过 1 秒就不像是「对刚才那一下的反应」了`);
});
test('S5 养池反加：前位豹子面对后位加注应该反加而不是比牌', () => {
  const { room, bot } = scene({
    // 我一手豹子在前位，后位 A 刚加到五万，B 还闷着 —— 池子里还有第三个人可以榨
    me: { name: '我', hand: HANDS.trips, looked: true, bet: 41_000, chips: 400_000, events: [ev('call', true, 20_000, 1)] },
    others: [
      { name: 'A', looked: true, bet: 101_000, chips: 400_000, events: [ev('raise', true, 50_000, 2)] },
      { name: 'B', looked: false, bet: 21_000, chips: 400_000 },
    ],
    pot: 180_000,
    betUnit: 50_000,
    roundNo: 2,
    turnCount: 5,
    position: 'early',
    compareUnlockAt: 2,
  });
  const cmds = sample(room, bot);
  const raise = share(cmds, (c) => c?.type === 'raise');
  assert.ok(raise >= 0.7, `一手豹子面对反加，却只有 ${(raise * 100).toFixed(0)}% 继续加价`);
  // 现在比掉，等于把 B 那一份从池子里赶走 —— 手上是最硬的牌，急什么
  assert.ok(share(cmds, (c) => c?.type === 'compare') <= 0.15, '豹子这么早就去比牌，池子还没养起来');
  assert.ok(share(cmds, (c) => c?.type === 'fold') <= 0.02, '豹子弃牌');
});
/**
 * S11 的局面：第 3 轮刚升档（单价 2 万），前面全部平跟、多数人闷着，我后位看牌拿小顺子。
 * `n` = 还有几个对手，`record` = 他们的长期档案里有没有「在这一档闷着被加价就跑」的记录。
 */
function s11(n: number, opts: { unit?: number; record?: boolean } = {}) {
  const unit = opts.unit ?? 20_000;
  const others = Array.from({ length: n }, (_, i) => ({
    name: `P${i}`, looked: false, bet: 3_000, chips: 400_000,
    // 前两轮各闷跟一口一千 —— 「全部平跟」
    events: [ev('call', false, 1_000, 1), ev('call', false, 1_000, 2)],
  }));
  const built = scene({
    me: {
      // 5 高散牌 —— 0.127，回调前「小顺子」在这张桌子上的位置：偷池要的就是这种牌
      name: '我', hand: HANDS.smallJunk, looked: true, bet: 3_000, chips: 400_000,
      events: [ev('call', false, 1_000, 1), ev('call', false, 1_000, 2)],
    },
    others, pot: 40_000, betUnit: unit, roundNo: 3, turnCount: n + 1,
    position: 'late', compareUnlockAt: 2,
  });
  if (opts.record) {
    for (const p of built.room.players.slice(1)) {
      const key = memoryKey(p);
      const memory = built.room.memory ?? (built.room.memory = {});
      const mem = memory[key] ?? (memory[key] = emptyMemory(key));
      mem.hands = 30;
      // 「闷着 × 五万档 × 人多」这一格里：面对过 12 次加价，跑了 9 次。
      // 五万档 = 我打算加上去的那一档 —— 弃牌率要按**他要面对的价钱**去查，不是按现价。
      const b = editBucket(mem, bucketKey(false, 2, n >= 2));
      b.pressureFaced = 12;
      b.foldsToPressure = 9;
    }
  }
  return built;
}

const stealOf = (room: ReturnType<typeof s11>['room'], bot: ReturnType<typeof s11>['bot']) =>
  buildSituation(room, bot, personaFor(bot), readMind(undefined, personaFor(bot).traits)).steal;

test('S11 升档偷池：弃牌率随升档上升、随人数下降，人少时后位真的加一档', () => {
  // ① 升档前后同一批人、同一个池子：这一档的价钱是他们一路在付的二十倍，
  //    「升档后弃牌率」必须真的动（旧版 steal 与单价无关，两边一模一样）。
  const before = s11(3, { unit: 1_000 });
  const after = s11(3);
  const s0 = stealOf(before.room, before.bot);
  const s1 = stealOf(after.room, after.bot);
  assert.ok(s1 > s0 * 1.8, `升档前偷池成功率 ${s0.toFixed(3)}、升档后 ${s1.toFixed(3)} —— 升档没把人吓到`);

  // ② 人越多越偷不动：同一个价钱，成功率是每个人弃牌率的乘积。
  const steals = [1, 2, 3, 5].map((n) => {
    const { room, bot } = s11(n);
    return stealOf(room, bot);
  });
  for (let i = 1; i < steals.length; i++) {
    assert.ok(steals[i] < steals[i - 1], `人数从 ${i} 加到 ${i + 1}，偷池成功率反而没降：${steals}`);
  }
  assert.ok(steals[0] > 0.3, `单挑时偷池成功率只有 ${steals[0].toFixed(3)}，闷牌的人等于没有弃牌率`);

  // ③ 条件统计真的接上了：同一个价钱，档案里「在这一档闷着就跑」的人更好偷。
  const known = s11(3, { record: true });
  assert.ok(
    stealOf(known.room, known.bot) > s1 * 1.25,
    '对手档案里那 12 次「五万档闷着被加价跑了 9 次」没有进入 fold-equity',
  );

  // ④ 动作：人少的时候后位拿弱牌真的会加一档去偷，而且走上这条线的手全都加价
  //    （§4.4「加一档；被跟则下一信息点转弃」）。
  const heads = s11(1);
  const rows = sampleWithPlan(heads.room, heads.bot);
  const steal = onLine(rows, '偷池');
  assert.ok(steal.length >= 20, `200 手里只有 ${steal.length} 手打算偷池`);
  assert.equal(
    share(steal, (c) => c?.type === 'raise'), 1,
    '打算偷池却没加价 —— 这条线的基本动作就是加一档',
  );

  // ⑤ 反过来，五个人还闷着的时候不许偷：那一口要掏十万去偷四万的池子，
  //    保本成功率七成以上，而五个人一起跑的概率不到 5%。这不是模型缺陷，是这一局的价目表
  //    （档位 1 千 → 2 万是 20 倍跳，而闷家只付半价）算出来的结论，见设计文档 §4.4 S11 一行。
  const crowd = sampleWithPlan(s11(5).room, s11(5).bot);
  assert.ok(
    share(crowd.map((r) => r.cmd), (c) => c?.type === 'raise') <= 0.05,
    '五个人还闷着就去偷池 —— 这是在往一个偷不动的池子里扔钱',
  );
});
test('S12 底池承诺：算到摊牌的总账，而不是只算这一口', () => {
  const { room, bot } = scene({
    // 池子四十五万，我已经投了十五万，这一口只要两万 —— 单看这一口的胜率是亏的，
    // 但要跟的是「已经在池子里的那十五万」的下场，不是这两万本身（§4.5 前瞻）。
    me: { name: '我', hand: HANDS.midFlush, looked: true, bet: 150_000, chips: 350_000 },
    others: [
      { name: 'A', looked: true, bet: 150_000, chips: 350_000, events: [ev('call', true, 20_000, 3)] },
      { name: 'B', looked: true, bet: 150_000, chips: 350_000, events: [ev('call', true, 20_000, 3)] },
    ],
    pot: 450_000,
    betUnit: 20_000,
    roundNo: 3,
    turnCount: 9,
    position: 'early',
    compareUnlockAt: 2,
  });
  const cmds = sample(room, bot);
  const quit = share(cmds, (c) => c?.type === 'fold');
  assert.ok(quit <= 0.15, `两万块买四十五万的池子，却有 ${(quit * 100).toFixed(0)}% 在这里退掉`);
  assert.ok(share(cmds, (c) => c?.type === 'raise' || c?.type === 'call') >= 0.8, '这种价钱应该继续把牌打完');
});
test('S13 大赢后的松：赢下大池之后对小注无所谓，但不追大注', () => {
  /*
   * 「宽裕」这一维（`e.joy` + `d.greed`，与 (d) 情绪台和 `zjh-mind.test.ts` 逐字一致）
   * 说的是**赢来的钱花得松**：小注随便看、随便跟，但真要掏一大笔时人是会醒的。
   * 所以这一条要在**两个价位**上同时成立，只测一个价位证明不了「但不追大注」。
   */
  const spot = (unit: number, pot: number, tweak: (m: MindState) => void) => {
    const { room, bot } = scene({
      // 一手中下牌，桌上**没有人加注** —— 「跟不跟」这一格必须是活的，
      // 不然平静时就已经 100% 弃牌，情绪再松也挪不动分布（量到的是天花板）。
      me: { name: '我', hand: HANDS.midJunk, looked: true, bet: unit, chips: 300_000 },
      others: [
        { name: 'A', looked: true, bet: unit, events: [ev('call', true, unit, 3)] },
        { name: 'B', looked: true, bet: unit, events: [ev('call', true, unit, 3)] },
      ],
      pot, betUnit: unit, roundNo: 3, turnCount: 9, position: 'late',
    });
    const mind = newMind(personaFor(bot).traits);
    // 刚赢下一个大池：参照点还停在开局，手上比参照点多得多 —— 这就是「大赢之后」。
    mind.refBalance = 200_000;
    mind.peakBalance = 300_000;
    tweak(mind);
    room.memory![memoryKey(bot)] = { ...emptyMemory(memoryKey(bot)), mind };
    return sample(room, bot);
  };
  const calm = (m: MindState) => { void m; };
  const flush = (m: MindState) => { m.e.joy = 0.9; m.d.greed = 0.8; };

  // 小注（一千一口，占身家 0.3%）：宽裕的人更愿意留在牌里
  const cheapCalm = share(spot(1_000, 12_000, calm), (c2) => c2?.type === 'fold');
  const cheapFlush = share(spot(1_000, 12_000, flush), (c2) => c2?.type === 'fold');
  // 大注（五万一口，占身家 17%）：这时候他该和平静时差不多
  const dearCalm = share(spot(50_000, 220_000, calm), (c2) => c2?.type === 'fold');
  const dearFlush = share(spot(50_000, 220_000, flush), (c2) => c2?.type === 'fold');
  console.log(`[S13] 弃牌率 小注 平静 ${(cheapCalm * 100).toFixed(0)}% → 宽裕 ${(cheapFlush * 100).toFixed(0)}%`
    + `  大注 平静 ${(dearCalm * 100).toFixed(0)}% → 宽裕 ${(dearFlush * 100).toFixed(0)}%`);

  assert.ok(cheapCalm - cheapFlush >= 0.05,
    `小注上宽裕并没有更松：${(cheapCalm * 100).toFixed(0)}% → ${(cheapFlush * 100).toFixed(0)}%`);
  assert.ok(dearCalm - dearFlush < cheapCalm - cheapFlush,
    `大注上放得比小注还开（${(dearCalm - dearFlush).toFixed(3)} ≥ ${(cheapCalm - cheapFlush).toFixed(3)}）—— 那不是宽裕，是上头`);
});
test('S14 复仇比牌：上一局被 A 比掉，这一局优先找 A', () => {
  /*
   * 「被谁比掉就找谁」是**目标选择**，不是「更爱比牌」。所以这一条量的是
   * 在已经决定开比的那些手里，比的是不是 A —— 而且要有一个不带恨意的对照，
   * 否则量到的可能只是「A 恰好在似然表里更软」。
   *
   * A 和 B 的公开动作**完全一样**（同样看牌、同样跟一手、同样的投入），
   * 于是范围模型对两人的读数一致，剩下的差别只可能来自记仇。
   */
  const run = (revenge: Record<string, number>) => {
    // 用阿彪这张卡：「谁比掉他他找谁」写在他卡上，S14 说的就是这个人。
    const { room, bot, by } = scene({
      me: { name: '阿彪', hand: HANDS.aFlush, looked: true, bet: 60_000, chips: 200_000 },
      others: [
        { name: 'A', looked: true, bet: 60_000, events: [ev('call', true, 20_000, 2), ev('call', true, 40_000, 3)] },
        { name: 'B', looked: true, bet: 60_000, events: [ev('call', true, 20_000, 2), ev('call', true, 40_000, 3)] },
      ],
      pot: 260_000, betUnit: 40_000, roundNo: 4, turnCount: 12, position: 'late', compareUnlockAt: 2,
    });
    const mind = newMind(personaFor(bot).traits);
    for (const [name, v] of Object.entries(revenge)) mind.revenge[memoryKey(by(name))] = v;
    room.memory![memoryKey(bot)] = { ...emptyMemory(memoryKey(bot)), mind };
    const cmds = sample(room, bot, 300).filter((c2) => c2.type === 'compare');
    const onA = cmds.filter((c2) => c2.type === 'compare' && c2.targetId === by('A').id).length;
    return { n: cmds.length, onA };
  };

  const plain = run({});
  const hate = run({ A: 1.6 });
  const rateOf = (r: { n: number; onA: number }) => r.onA / Math.max(1, r.n);
  console.log(`[S14] 开比挑 A：没恨意 ${(rateOf(plain) * 100).toFixed(1)}%（${plain.onA}/${plain.n}）`
    + `  被 A 比掉过 ${(rateOf(hate) * 100).toFixed(1)}%（${hate.onA}/${hate.n}）`);

  assert.ok(hate.n >= 30 && plain.n >= 30, `开比的样本太少（${hate.n} / ${plain.n}），比不出落点`);
  assert.ok(rateOf(hate) > rateOf(plain) + 0.10,
    `记恨 A 之后开比并没有更常挑 A：${(rateOf(plain) * 100).toFixed(1)}% → ${(rateOf(hate) * 100).toFixed(1)}%`);
  assert.ok(rateOf(hate) > 0.5, `恨着 A 却只有 ${(rateOf(hate) * 100).toFixed(1)}% 的比牌落在 A 身上`);
});
test('S15 收口：单挑升档两次后不再互跟，只在比/梭/弃里选', () => {
  const { room, bot } = scene({
    // 单挑，价钱已经被抬到十万档，两边各投三十万 —— 再互跟下去只是把钱轮流搬进池子
    me: { name: '我', hand: HANDS.midPair, looked: true, bet: 300_000, chips: 900_000 },
    others: [{
      name: 'A', looked: true, bet: 300_000, chips: 900_000,
      events: [ev('raise', true, 50_000, 3), ev('raise', true, 100_000, 4)],
    }],
    pot: 600_000,
    betUnit: 100_000,
    roundNo: 4,
    turnCount: 10,
    position: 'early',
    compareUnlockAt: 2,
  });
  const cmds = sample(room, bot);
  // 这一条的重点是**没有平跟**：牌局要么在这一手结掉，要么我退出
  assert.equal(share(cmds, (c) => c?.type === 'call'), 0, '升到这个价位还在平跟，就是不肯收口');
  assert.ok(cmds.every((c) => c?.type === 'compare' || c?.type === 'fold' || c?.type === 'all_in'),
    '只能在比 / 梭 / 弃里选');
  const settle = share(cmds, (c) => c?.type === 'compare' || c?.type === 'all_in');
  assert.ok(settle >= 0.15, `一手 K 高金花面对连加，却只有 ${(settle * 100).toFixed(0)}% 敢结掉这手牌`);
});
test('S16 闷加被反加：闷加两次被看牌的人反加，看牌后重选', () => {
  const build = () => scene({
    // 我闷着加了两次，对方看着牌反加到五万档 —— 闷牌的信息价值在这一刻最高
    me: {
      name: '我', hand: HANDS.smallJunk, looked: false, bet: 31_000, chips: 400_000,
      events: [ev('raise', false, 20_000, 1), ev('raise', false, 20_000, 2)],
    },
    others: [{
      name: 'A', looked: true, bet: 101_000, chips: 400_000,
      events: [ev('call', true, 20_000, 1), ev('raise', true, 50_000, 2)],
    }],
    pot: 150_000,
    betUnit: 50_000,
    roundNo: 2,
    turnCount: 5,
    position: 'early',
    compareUnlockAt: 2,
  });

  const opening = build();
  const first = sample(opening.room, opening.bot);
  assert.ok(share(first, (c) => c?.type === 'look') >= 0.9, '被反加到五万还闷着往里扔，就是在赌');

  // 看完之后要**重新选**：手里是 5 高散牌（0.127），五万一口的价钱撑不住
  const { room, bot } = build();
  applyCommand(room, bot.id, { type: 'look' });
  const after = sample(room, bot);
  assert.ok(share(after, (c) => c?.type === 'fold') >= 0.8,
    '看完牌发现是一手弱牌，却还在五万档跟下去 —— 那这一眼就白看了');
});
test('S17 读用时：对方用掉八成时限才跟，当他弱', () => {
  /*
   * 用时是一条**弱**信号，所以这一条不去看动作，直接看范围：同一串公开动作，
   * 只把「他跟这一口花了多久」从秒跟换成用掉八成时限，读出来的范围要更弱。
   *
   * 而且它必须是**人物卡的能力**：老王 `cognition.readsTiming true` 读得到，
   * 小林 false 读不到 —— 这是 §4.3 那一行「用时进似然」的信息边界。
   */
  const range = (card: string, ms: number | undefined) => {
    const events = [{ ...ev('call', true, 20_000, 2), msSpent: ms }];
    const { room, bot, by } = scene({
      me: { name: card, hand: HANDS.midPair, looked: true, bet: 20_000, chips: 300_000 },
      others: [{ name: 'A', looked: true, bet: 20_000, events }],
      pot: 90_000, betUnit: 20_000, roundNo: 3, turnCount: 9, position: 'late',
    });
    const persona = personaFor(bot);
    const mind = readMind(undefined, persona.traits);
    const sit = buildSituation(room, bot, persona, mind);
    const i = room.players.indexOf(by('A')) - 1;
    return expectedPercentile(sit.dists[i]);
  };

  // 房规默认 30 秒时限：24 秒 = 八成，1 秒 = 秒跟。
  const slow = range('老王', 24_000);
  const snap = range('老王', 1_000);
  const blind = range('老王', undefined);
  const deaf = { slow: range('小林', 24_000), snap: range('小林', 1_000) };
  console.log(`[S17] 老王读到的对手范围：长考才跟 ${slow.toFixed(4)}  秒跟 ${snap.toFixed(4)}  没有用时 ${blind.toFixed(4)}`
    + `  ｜ 小林（不读用时）${deaf.slow.toFixed(4)} / ${deaf.snap.toFixed(4)}`);

  assert.ok(slow < snap - 0.005, `长考才跟没有被读弱：${slow.toFixed(4)} vs 秒跟 ${snap.toFixed(4)}`);
  assert.ok(slow < blind, `长考才跟没有比「不知道他用了多久」更弱：${slow.toFixed(4)} vs ${blind.toFixed(4)}`);
  assert.ok(Math.abs(deaf.slow - deaf.snap) < 1e-9,
    `小林 readsTiming=false 却读出了用时差：${deaf.slow.toFixed(4)} vs ${deaf.snap.toFixed(4)}`);
});
test('S18 表情：赢大池 🔥 / 被梭掀掉 😭 / 看到梭哈 😱', () => {
  /*
   * ① 触发表本身：三个触发点各自对上 S18 那一行写的那张脸，
   *    而「发不发」是人物卡的 `emotes.rate` × 这一下有多大 —— 赌徒几乎每次都有反应，
   *    老油条一年做一次，数学型（`rate 0.02`、偏好里没有这三张脸）不会拿 🔥 去表演。
   */
  const roll = (card: string, trigger: 'won-big' | 'busted' | 'saw-allin', weight: number, n = 2000) => {
    let hit = 0;
    const faces = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      const f = emoteFor(PERSONAS[card], trigger, weight, () => (i + 0.5) / n);
      if (f) { hit++; faces.set(f, (faces.get(f) ?? 0) + 1); }
    }
    return { rate: hit / n, top: [...faces.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] };
  };

  assert.equal(roll('阿凯', 'won-big', 1).top, '🔥', '赌徒赢下大池不是 🔥');
  assert.equal(roll('小雨', 'busted', 1).top, '😭', '新手被掀掉不是 😭');
  assert.equal(roll('老王', 'saw-allin', 1).top, '😱', '闷牌王看到梭哈不是 😱');
  // 偏好表说了算：老陈卡上只有 🙏，那他被掀掉也是 🙏（§4.7.2「表情🙏为主」）
  assert.equal(roll('老陈', 'busted', 1).top, '🙏', '老陈的表情没有走他自己的偏好表');

  // 「有多响」是连续量，不是开关：同一张卡，小池子几乎不做表情，大池子才做
  const big = roll('阿凯', 'won-big', 1).rate;
  const small = roll('阿凯', 'won-big', 0.05).rate;
  console.log(`[S18] 阿凯赢池：整副身家 ${(big * 100).toFixed(0)}%  只有 5% 身家 ${(small * 100).toFixed(0)}%`
    + `  ｜ 老油条阿杰整副身家 ${(roll('阿杰', 'won-big', 1).rate * 100).toFixed(0)}%`);
  assert.ok(big > 0.9 && small < 0.1, `表情的概率没有随「这一下有多大」变：${big.toFixed(2)} / ${small.toFixed(2)}`);
  assert.ok(roll('阿杰', 'won-big', 1).rate < 0.10, '老油条「表情极少」没落地');
  assert.equal(roll('小林', 'won-big', 1).rate, 0.02, '数学型的表情率不是卡上的 0.02');

  /*
   * ② 真的发得出来：看到有人梭哈，还没轮到他，他会先「啊？」一声。
   *    走的是非回合那条路（§4.6），表情不占行动权，所以它排在看牌/弃牌后面。
   */
  const { room, bot } = scene({
    me: { name: '老王', hand: HANDS.kingPair, looked: true, bet: 20_000, chips: 60_000 },
    others: [
      { name: 'A', looked: true, bet: 60_000, chips: 0, events: [ev('all_in', true, 30_000, 3)] },
      { name: 'B', looked: true, bet: 20_000, events: [ev('call', true, 20_000, 3)] },
    ],
    pot: 140_000, betUnit: 30_000, roundNo: 3, turnCount: 9, position: 'late',
    allIn: { initiator: 'A', accepted: [], base: 30_000 },
  });
  /*
   * 梭哈的应答队列里把 B 排在前面：`decideOffTurn` 对「下一个就该他表态」的人
   * 一律让路（那不是非回合动作，是他的回合）。这里要测的是**还轮不到他**的那一刻。
   */
  room.allIn!.pending = [room.players[2].id, bot.id];
  const cmds = sampleOffTurn(room, bot, 300);
  const emotes = cmds.filter((c2) => c2?.type === 'emote');
  console.log(`[S18] 看到梭哈的非回合反应：${JSON.stringify(tally(cmds))}`);
  assert.ok(emotes.length > 0, '看到一手梭哈拍在脸上，一声都不吭');
  assert.ok(emotes.every((c2) => c2!.type === 'emote' && c2.id === '😱'), '看到梭哈发的不是 😱');
  assert.ok(emotes.every((c2) => c2!.type === 'emote' && c2.target === room.players[1].id),
    '表情没有落在梭哈的那个人身上（待集成 #10 的落点字段）');
});
test('S19 早期廉价看戏：6 人桌第一轮几乎全员闷跟', () => {
  const { room, bot } = scene({
    me: { name: '我', looked: false, bet: 1_000, chips: 500_000 },
    others: [1, 2, 3, 4, 5].map((i) => ({ name: 'P' + i, looked: false, bet: 1_000, chips: 500_000 })),
    pot: 6_000,
    betUnit: 1_000,
    roundNo: 1,
    turnCount: 3,
    position: 'late',
    compareUnlockAt: 2,
  });
  const rows = sampleWithPlan(room, bot);
  const cmds = rows.map((r) => r.cmd);

  /*
   * 设计文档 §6.4 这一条写的是「6 人桌前两轮几乎全员**闷跟**到升档」，
   * 所以断言的是「闷着跟」这个动作本身，不是「没人退场」这种弱一档的说法。
   */
  assert.ok(share(cmds, (c) => c?.type === 'call') >= 0.6,
    '开局一千块该是闷着跟下去，不是先看牌再说');
  assert.ok(share(cmds, (c) => c?.type === 'fold') <= 0.05,
    '开局一千块的价钱就有人退场，这一轮便宜得不像话');
  assert.equal(share(cmds, (c) => c?.type === 'raise'), 0, '第一轮的一千块不该有人急着抬价');
  const cheap = onLine(rows, '便宜看戏');
  assert.ok(cheap.length >= 40, `200 手里只有 ${cheap.length} 手走便宜看戏`);
  assert.ok(share(cheap, (c) => c?.type === 'fold') <= 0.2, '打算看戏的人却把牌扔了');
});
