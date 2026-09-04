/**
 * P3 人物卡 A 线验收：老油条(阿杰) / 赌徒(阿凯) / 岩石(老陈) / 跟注站(小北)。
 *
 * 这个文件只回答一件事：**四张卡写下来的那些话，在真牌桌上是不是真的发生了**。
 * 所以这里没有一条断言是去读人物卡上的数字的 —— 全部是自对弈或场景台跑出来的
 * 公开统计量（谁掀了牌、谁弃了牌、谁加了注、谁跟谁比了牌、想了多久）。
 *
 * 四类验收（任务书 A 线 (a)(b)(c)(d)）：
 *   (a) 自洽    每张卡对五张常人卡 ≥ 2000 局，人物文字里能量化的每一句都要对上；
 *   (b) 破绽    每条破绽配一个脚本对手，对该人物净赚（95% CI 不含 0），对老油条不赚；
 *   (c) 无门槛  看牌率不许在任何一轮贴到 0/1，也不许出现阶跃；价钱是连续输入；
 *   (d) 情绪    同一批局面换心情，动作分布必须变，而且方向对得上人物文字。
 *
 * 重的统计（(a) 的 2000 局、(b) 的 1000 局）默认就跑，因为这就是本文件的全部意义；
 * 单张卡 2000 局约 5 秒，单挑 1000 局约 0.3 秒，全文件在 2 分钟以内。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCommand, botAction, createHumanPlayer, createInitialRoom, currentPlayer,
  emptyMemory, handPercentile, memoryKey, startRound,
  type Card, type GameCommand, type PlayerState, type RoomState,
} from '../shared/game.ts';
import { tableRead } from '../shared/game.ts';
import { newMind, readMind, tiltOf, type MindState } from '../shared/mind/emotion.ts';
import { personaFor } from '../shared/zjh/bot/personas/index.ts';
import { archetypeOf } from '../shared/zjh/bot/profile.ts';
import { expectedPercentile, priorDist, refine, warmUpRange } from '../shared/zjh/bot/range.ts';
import {
  FLUSH_LO, HANDS, PAIR_LO, SF_LO, STRAIGHT_LO, TRIPS_LO, ev, sample, scene,
} from './zjh-helpers.ts';
import { withSeededRandom } from './zjh-arena.ts';

warmUpRange();

/** 全文件唯一的种子。任务书指定 20260903。 */
const SEED = 20260903;

/** A 线的四张卡。顺序 = 报告里的顺序。 */
const CARDS = ['阿杰', '阿凯', '老陈', '小北'] as const;
type Card4 = typeof CARDS[number];

/**
 * 「常人卡」用的是五个**不在名册上**的名字：`personaFor` 查不到就落到
 * `personas/common.ts`，也就是 §4.9.6 那张常人卡。
 * P2 期间这些名字走的是过渡映射（`botPersonality` → `tuneTraits`），
 * 集成第 2 步已经把那段删掉 —— 现在它们是货真价实的同一张常人卡，
 * 正好当八张手写卡的对照组。
 */
const COMMONS = ['常人1', '常人2', '常人3', '常人4', '常人5'];

/* ------------------------------------------------------------ 自对弈台 */

export type Decider = (state: RoomState, me: PlayerState) => GameCommand;

interface Step {
  name: string; hand: number; cmd: GameCommand; looked: boolean; roundNo: number;
  pressured: boolean; strength?: number; raisesAgainst: number; facingRaise: boolean;
  voluntaryAllIn: boolean; thinkMs?: number; betFraction: number;
  /** 决策**当下**的上头读数（`tiltOf` = 怒×0.7 + 思×0.5），用来把动作按心情分开看。 */
  tilt: number;
  cmpWeakRank?: number; cmpBetRank?: number; cmpCands?: number; cmpOnWeakest?: boolean;
}
interface Run { steps: Step[]; perHand: Record<string, number[]>; }

function table(names: string[]): RoomState {
  const host = createHumanPlayer(names[0], '🐯', 0, 'a0');
  const room = createInitialRoom('ARENA1', host);
  host.isBot = true;
  for (let i = 1; i < names.length; i++) {
    const p = createHumanPlayer(names[i], '🦊', i, `a${i}`);
    p.isBot = true;
    room.players.push(p);
  }
  for (const p of room.players) p.ready = true;
  return room;
}

/**
 * 「比牌挑的是**范围**最弱的那个」——口径与 `tests/zjh-arena.ts` 的 `comparedWeakest`
 * 一致：按公开事件推出来的信念挑，而不是按上帝视角的真牌挑。§6.4 要 ≥70%。
 */
function comparedWeakest(state: RoomState, me: PlayerState, targetId: string): boolean {
  const opponents = state.players.filter((p) => p.id !== me.id && p.status === 'active');
  if (opponents.length <= 1) return true;
  const prior = priorDist(me.hand, state.settings.dealMode);
  let best = Infinity;
  const scores = opponents.map((o) => {
    const persona = personaFor(me);
    const v = expectedPercentile(refine(prior, o.handActions ?? [],
      archetypeOf(tableRead(state, o.id), persona.cognition.classifyOthers, persona.traits.regularities.R17 ?? 1),
      state.settings, state.settings.dealMode, persona.cognition.readsTiming));
    best = Math.min(best, v);
    return { id: o.id, v };
  });
  const mine = scores.find((x) => x.id === targetId);
  return !!mine && mine.v <= best + 1e-9;
}

const underPressure = (s: RoomState, me: { id: string }) => !!s.allIn
  || s.betUnit > s.settings.betOptions[0]
  || s.players.some((p) => p.id !== me.id && p.status === 'active'
    && p.handActions?.some((e) => e.kind === 'raise'));

/**
 * 跑 N 局，把每一步的**公开处境**和动作记下来。
 *
 * `reset` 每多少局重开一桌：不重开的话赢家会把桌子吃干净，后面几百局都是
 * 「一个人有钱、别人只能梭」，统计出来的是筹码分布而不是人。
 */
function play(names: string[], hands: number, reset = 50, scripts: Record<string, Decider> = {}): Run {
  return withSeededRandom(SEED, () => {
    const steps: Step[] = [];
    const perHand: Record<string, number[]> = {};
    for (const n of names) perHand[n] = [];
    let room = table(names);
    for (let h = 0; h < hands; h++) {
      if (reset && h && h % reset === 0) room = table(names);
      for (const p of room.players) { p.chips = room.settings.startingChips; p.granted = 0; p.net = 0; }
      startRound(room, room.hostId);
      let guard = 0;
      while (room.phase === 'playing' && guard++ < 400) {
        const cur = currentPlayer(room);
        if (!cur) break;
        const looked = cur.looked;
        // 决策前的上头读数。人物文字里的很多话是**带条件**的（「上头时小金花也梭」），
        // 不把心情记下来就只能看到平静与上头混在一起的平均值，那个平均值不回答任何一句话。
        const tilt = tiltOf(readMind(room.memory?.[memoryKey(cur)]?.mind, personaFor(cur).traits));
        const raisesAgainst = room.players.filter((p) => p.id !== cur.id)
          .reduce((s, p) => s + (p.handActions?.filter((e) => e.kind === 'raise' || e.kind === 'all_in').length ?? 0), 0);
        let cmd: GameCommand; let act: { cmd: GameCommand; thinkMs?: number } | undefined;
        const script = scripts[cur.name];
        if (script) {
          try { cmd = script(room, cur); } catch { cmd = { type: 'fold' }; }
        } else {
          act = botAction(room, cur); cmd = act.cmd;
        }
        let cmpWeakRank: number | undefined; let cmpBetRank: number | undefined; let cmpCands: number | undefined;
        if (cmd.type === 'compare' && cmd.targetId) {
          const cands = room.players.filter((p) => p.id !== cur.id && p.status === 'active');
          const tgt = cands.find((p) => p.id === cmd.targetId);
          if (tgt && cands.length > 1) {
            cmpCands = cands.length;
            const tp = handPercentile(tgt.hand, room.settings.dealMode);
            cmpWeakRank = cands.filter((p) => handPercentile(p.hand, room.settings.dealMode) < tp).length / (cands.length - 1);
            cmpBetRank = cands.filter((p) => p.bet < tgt.bet).length / (cands.length - 1);
          }
        }
        steps.push({
          name: cur.name, hand: h, cmd, looked, roundNo: room.roundNo,
          pressured: underPressure(room, cur),
          strength: looked ? handPercentile(cur.hand, room.settings.dealMode) : undefined,
          raisesAgainst,
          facingRaise: room.players.some((p) => p.id !== cur.id && p.status === 'active'
            && !!p.handActions?.some((e) => e.kind === 'raise' || e.kind === 'all_in')),
          voluntaryAllIn: cmd.type === 'all_in' && cur.chips > room.betUnit * (looked ? 2 : 1),
          thinkMs: act?.thinkMs, cmpWeakRank, cmpBetRank, cmpCands, tilt,
          betFraction: cur.bet / Math.max(1, cur.bet + cur.chips),
          cmpOnWeakest: cmd.type === 'compare' && cmd.targetId
            ? comparedWeakest(room, cur, cmd.targetId) : undefined,
        });
        // 非法动作必须让评测失败，不能悄悄换成跟/弃 —— 那会把决策缺陷洗成统计。
        applyCommand(room, cur.id, cmd, act?.thinkMs);
      }
      for (const p of room.players) {
        perHand[p.name].push(room.result?.deltas.find((x) => x.id === p.id)?.delta ?? 0);
      }
      applyCommand(room, room.hostId, { type: 'new_round' });
    }
    return { steps, perHand };
  });
}

/** 95% 置信区间（正态近似，样本量都在 1000 以上）。 */
function ci(xs: number[]) {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const v = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const half = 1.96 * Math.sqrt(v / n);
  return { mean, half, lo: mean - half, hi: mean + half };
}

const rate = (hit: number, n: number) => (n ? hit / n : NaN);
const pct1 = (x: number) => `${(x * 100).toFixed(1)}%`;

/** 一张卡在一次自对弈里的公开画像。每个字段都对应人物文字里的某一句话。 */
function stats(run: Run, name: string) {
  const mine = run.steps.filter((s) => s.name === name);
  const acts = mine.length;
  const cnt = (t: GameCommand['type']) => mine.filter((s) => s.cmd.type === t).length;
  const hands = new Set(mine.map((s) => s.hand));
  const voluntary = new Set(mine.filter((s) => s.cmd.type !== 'fold' && s.cmd.type !== 'look').map((s) => s.hand));

  const pressed = mine.filter((s) => s.pressured);
  const facing = mine.filter((s) => s.facingRaise);
  // 「连续加压」= 面对不止一次加注/梭哈
  const chained = mine.filter((s) => s.raisesAgainst >= 2);
  // 中档牌 = 顺子档下沿到顺金档下沿之间（`categoryBands('standard')`），下面和上面都会饱和
  const midChained = chained.filter((s) => s.looked && s.strength! >= STRAIGHT_LO && s.strength! < SF_LO);
  const belowFlushFacing = facing.filter((s) => s.looked && s.strength! < FLUSH_LO);

  const looks = new Map<number, [number, number]>();
  for (const s of mine) {
    if (s.looked) continue;
    const r = Math.min(4, s.roundNo);
    const a = looks.get(r) ?? [0, 0];
    a[1]++; if (s.cmd.type === 'look') a[0]++;
    looks.set(r, a);
  }

  const raises = mine.filter((s) => s.cmd.type === 'raise');
  const raisesLooked = raises.filter((s) => s.looked);
  const aggr = mine.filter((s) => s.cmd.type === 'raise' || s.voluntaryAllIn);
  const aggrLooked = aggr.filter((s) => s.looked);
  const cmps = mine.filter((s) => s.cmd.type === 'compare');
  const cmpRanked = cmps.filter((s) => s.cmpWeakRank !== undefined);
  const allIns = mine.filter((s) => s.voluntaryAllIn && s.looked);
  const think = mine.map((s) => s.thinkMs).filter((x): x is number => typeof x === 'number');
  const lookedSteps = mine.filter((s) => s.looked);
  const trash = lookedSteps.filter((s) => s.strength! < PAIR_LO);
  const notTrash = lookedSteps.filter((s) => s.strength! >= PAIR_LO);
  // 「沉没成本重」的公开量：本局已经投进去的钱占身家的比例，重仓 vs 轻仓时的弃牌率
  const heavy = mine.filter((s) => s.betFraction >= 0.10);
  const light = mine.filter((s) => s.betFraction < 0.10);
  const cmpBelief = mine.filter((s) => s.cmpOnWeakest !== undefined);

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  return {
    acts, hands: hands.size,
    vpip: voluntary.size / hands.size,
    raise: cnt('raise') / acts, call: cnt('call') / acts, fold: cnt('fold') / acts,
    compare: cnt('compare') / acts, allIn: cnt('all_in') / acts,
    voluntaryAllIn: mine.filter((s) => s.voluntaryAllIn).length / acts,
    foldPressed: rate(pressed.filter((s) => s.cmd.type === 'fold').length, pressed.length),
    foldPressedN: pressed.length,
    foldFacing: rate(facing.filter((s) => s.cmd.type === 'fold').length, facing.length),
    foldFacingN: facing.length,
    foldChained: rate(chained.filter((s) => s.cmd.type === 'fold').length, chained.length),
    foldChainedN: chained.length,
    foldMidChained: rate(midChained.filter((s) => s.cmd.type === 'fold').length, midChained.length),
    foldMidChainedN: midChained.length,
    foldBelowFlush: rate(belowFlushFacing.filter((s) => s.cmd.type === 'fold').length, belowFlushFacing.length),
    foldBelowFlushN: belowFlushFacing.length,
    blindStep: mine.filter((s) => !s.looked).length / acts,
    looks,
    /** 看过牌之后加注/主动梭时，手上是顺金以下的比例（顺金档下沿 = `SF_LO`） */
    aggrBelowSF: rate(aggrLooked.filter((s) => s.strength! < SF_LO).length, aggrLooked.length),
    aggrBelowSFN: aggrLooked.length,
    raiseBelowSF: rate(raisesLooked.filter((s) => s.strength! < SF_LO).length, raisesLooked.length),
    raiseBelowSFN: raisesLooked.length,
    allInBelowSF: rate(allIns.filter((s) => s.strength! < SF_LO).length, allIns.length),
    allInBelowTrips: rate(allIns.filter((s) => s.strength! < TRIPS_LO).length, allIns.length),
    allInStrength: mean(allIns.map((s) => s.strength!)), allInN: allIns.length,
    foldTrash: rate(trash.filter((s) => s.cmd.type === 'fold').length, trash.length),
    foldTrashN: trash.length,
    foldNotTrash: rate(notTrash.filter((s) => s.cmd.type === 'fold').length, notTrash.length),
    foldNotTrashN: notTrash.length,
    foldHeavy: rate(heavy.filter((s) => s.cmd.type === 'fold').length, heavy.length),
    foldHeavyN: heavy.length,
    foldLight: rate(light.filter((s) => s.cmd.type === 'fold').length, light.length),
    cmpOnWeakest: rate(cmpBelief.filter((s) => s.cmpOnWeakest).length, cmpBelief.length),
    cmpOnWeakestN: cmpBelief.length,
    cmpN: cmps.length,
    cmpBlind: rate(cmps.filter((s) => !s.looked).length, cmps.length),
    cmpWeakRank: mean(cmpRanked.map((s) => s.cmpWeakRank!)),
    cmpBetRank: mean(cmpRanked.map((s) => s.cmpBetRank!)),
    cmpRankedN: cmpRanked.length,
    thinkMean: mean(think), thinkN: think.length,
    think90: think.slice().sort((a, b) => a - b)[Math.floor(think.length * 0.9)] ?? NaN,
  };
}

/** (a) 的自对弈：每张卡一桌，对手是五张常人卡。整个文件共用，只跑一次。 */
const SELF = new Map<string, ReturnType<typeof stats>>();
const SELF_RUN = new Map<string, Run>();
/**
 * 局数按卡分开设，因为「第 2 轮还活着的手数」不是每张卡都一样多：
 * 岩石老陈在标准档下第 1 轮就弃掉九成多，4000 局只剩 194 手进第 2 轮 ——
 * 卡在 (c) 的 `n >= 200` 样本下限上下抖（重构前是 241，重构后是 194），
 * 于是「样本只覆盖到 1 个轮次」这条红是**样本量**的红，不是行为的红。
 * 处理办法只能是把他的样本按比例加厚（16000 局 → 第 2 轮约 780 手），
 * 绝不是把 200 这个下限调低、更不是删掉 `rounds.length >= 2`。
 */
const SELF_HANDS: Record<string, number> = { 老陈: 16_000 };
function selfPlay(card: string, hands = SELF_HANDS[card] ?? 4000) {
  if (!SELF.has(card)) {
    const run = play([card, ...COMMONS], hands);
    SELF_RUN.set(card, run);
    SELF.set(card, stats(run, card));
  }
  return SELF.get(card)!;
}

/** 参照系：一张没有手写卡的常人，坐在同样的桌子上。 */
const ref = () => selfPlay('常人0');

function dump(name: string, st: ReturnType<typeof stats>) {
  console.log(
    `[${name}] ${st.hands} 局 / ${st.acts} 步  VPIP ${pct1(st.vpip)}  加注 ${pct1(st.raise)}  `
    + `跟 ${pct1(st.call)}  弃 ${pct1(st.fold)}  比 ${pct1(st.compare)}  梭 ${pct1(st.allIn)}(主动 ${pct1(st.voluntaryAllIn)})`,
  );
  console.log(
    `        遇压弃 ${pct1(st.foldPressed)}(${st.foldPressedN})  遇加注弃 ${pct1(st.foldFacing)}(${st.foldFacingN})  `
    + `金花以下遇加注弃 ${pct1(st.foldBelowFlush)}(${st.foldBelowFlushN})  连压弃 ${pct1(st.foldChained)}(${st.foldChainedN})  `
    + `中档牌连压弃 ${pct1(st.foldMidChained)}(${st.foldMidChainedN})`,
  );
  console.log(
    `        散牌弃 ${pct1(st.foldTrash)}(${st.foldTrashN})  非散牌弃 ${pct1(st.foldNotTrash)}(${st.foldNotTrashN})  `
    + `重投弃 ${pct1(st.foldHeavy)}(${st.foldHeavyN}) vs 轻投弃 ${pct1(st.foldLight)}  闷牌步 ${pct1(st.blindStep)}`,
  );
  console.log(
    `        顺金以下加注 ${pct1(st.raiseBelowSF)}(${st.raiseBelowSFN})  主动梭牌力均值 ${st.allInStrength.toFixed(3)}`
    + ` 顺金以下 ${pct1(st.allInBelowSF)} 豹子以下 ${pct1(st.allInBelowTrips)}(${st.allInN})`,
  );
  console.log(
    `        看牌率 ${[...st.looks.entries()].sort((a, b) => a[0] - b[0])
      .filter(([, [, n]]) => n >= 20).map(([r, [a, n]]) => `r${r} ${pct1(a / n)}(${n})`).join(' ')}`,
  );
  console.log(
    `        比牌 ${st.cmpN} 次：范围最弱 ${pct1(st.cmpOnWeakest)}(${st.cmpOnWeakestN})  真牌弱排位 ${st.cmpWeakRank.toFixed(3)}`
    + `  投入排位 ${st.cmpBetRank.toFixed(3)}  闷比 ${pct1(st.cmpBlind)}`,
  );
  console.log(`        用时 ${st.thinkMean.toFixed(0)}ms p90 ${st.think90}ms（n=${st.thinkN}）`);
}

/* =========================================================== (a) 自洽 */

test('(a) 老油条·阿杰：起手紧、拿到货就加压、连压就弃、几乎不闷比', () => {
  const a = selfPlay('阿杰'); const r = ref();
  dump('阿杰', a); dump('常人0', r);

  // 「起手紧」——入池率必须明显低于常人。这不是一条分位门槛，是弱牌原型 + 弃牌线权重的结果。
  assert.ok(a.vpip < r.vpip - 0.15, `起手不紧：VPIP ${pct1(a.vpip)} vs 常人 ${pct1(r.vpip)}`);
  // 「拿到货就加压」——他加注时手上的牌比常人硬：顺金以下才加注的比例更低。
  assert.ok(a.raiseBelowSF < r.raiseBelowSF - 0.05,
    `加注时的牌不比常人硬：顺金以下加注 ${pct1(a.raiseBelowSF)} vs 常人 ${pct1(r.raiseBelowSF)}`);
  // 「太理性：面对连续加压会规矩地弃」——中档牌（顺子~金花）连续被压时的弃牌率。
  // 用中档牌是因为金花以下遇加注所有人都接近 100%，上面又都接近 0，只有中间这段能分辨人。
  assert.ok(a.foldMidChained > 0.70, `连压之下只弃了 ${pct1(a.foldMidChained)}（${a.foldMidChainedN} 步）`);
  assert.ok(a.foldMidChained > r.foldMidChained + 0.05,
    `连压之下不比常人更规矩：${pct1(a.foldMidChained)} vs ${pct1(r.foldMidChained)}`);
  // 「几乎不闷比」
  assert.ok(a.cmpBlind < 0.05, `闷比占了 ${pct1(a.cmpBlind)}`);
  assert.ok(a.cmpBlind < r.cmpBlind / 3, `闷比没比常人少多少：${pct1(a.cmpBlind)} vs ${pct1(r.cmpBlind)}`);
  // 「比牌只挑最弱」——§6.4 的口径（按范围挑），要 ≥70%；常人也在这个水平，
  // 因为 `compare.softness 1` 本来就是常人值，这一句是「不走偏」而不是「比常人强」。
  assert.ok(a.cmpOnWeakest > 0.85, `比牌挑的不是范围最弱的：${pct1(a.cmpOnWeakest)}（${a.cmpOnWeakestN} 次）`);
  // 「用时稳定」——p90 不该比均值高出一大截（常人有明显的长尾）。
  // 口径：p90/均值 的比值。绝对上限 1.25 保证「没有长尾」，再要求比常人的比值低一成，
  // 保证这是这张卡带来的，不是引擎本来就稳。
  assert.ok(a.think90 / a.thinkMean < 1.25,
    `用时不稳：均值 ${a.thinkMean.toFixed(0)}ms、p90 ${a.think90}ms、比值 ${(a.think90 / a.thinkMean).toFixed(3)}`);
  assert.ok(a.think90 / a.thinkMean < (r.think90 / r.thinkMean) * 0.9,
    `用时的长尾没比常人短一成：${(a.think90 / a.thinkMean).toFixed(3)} vs ${(r.think90 / r.thinkMean).toFixed(3)}`);
});

test('(a) 赌徒·阿凯：什么牌都想看、沉没成本重、爱梭、不弃、秒出手', () => {
  const a = selfPlay('阿凯'); const r = ref(); const j = selfPlay('阿杰');
  dump('阿凯', a);

  const r1 = (st: ReturnType<typeof stats>) => { const [x, n] = st.looks.get(1)!; return x / n; };
  // 「什么牌都想看看」——第一轮的看牌率必须是四张卡里最高的，也高于常人。
  assert.ok(r1(a) > r1(r) + 0.10, `第 1 轮看牌率 ${pct1(r1(a))}，常人 ${pct1(r1(r))}`);
  assert.ok(r1(a) > r1(j), `第 1 轮看牌率没有高过老油条：${pct1(r1(a))} vs ${pct1(r1(j))}`);
  // 「投入多了就不弃」（沉没成本 R4 ×2、biases.sunkCost .85）——重仓时的弃牌率远低于轻仓。
  assert.ok(a.foldHeavy < a.foldLight * 0.5,
    `重投之后照样弃：重投弃 ${pct1(a.foldHeavy)}(${a.foldHeavyN}) vs 轻投弃 ${pct1(a.foldLight)}`);
  assert.ok(a.foldHeavy < r.foldHeavy, `沉没成本没比常人重：${pct1(a.foldHeavy)} vs ${pct1(r.foldHeavy)}`);
  // 「对偷池免疫（他不弃）」——遇加注的弃牌率必须显著低于常人。
  assert.ok(a.foldFacing < r.foldFacing * 0.80,
    `遇加注弃 ${pct1(a.foldFacing)}(${a.foldFacingN})，没比常人 ${pct1(r.foldFacing)} 低两成`);
  // 「喜欢梭哈」——主动梭的比例高于常人。
  assert.ok(a.voluntaryAllIn > r.voluntaryAllIn * 1.15,
    `主动梭 ${pct1(a.voluntaryAllIn)}，常人 ${pct1(r.voluntaryAllIn)}`);
  // 「秒出手」
  assert.ok(a.thinkMean < r.thinkMean * 0.7, `用时 ${a.thinkMean.toFixed(0)}ms，常人 ${r.thinkMean.toFixed(0)}ms`);
});

test('(a) 岩石·老陈：只在顺金以上加注、豹子才梭、金花以下遇加注必弃、比牌只在确信时', () => {
  const a = selfPlay('老陈'); const r = ref();
  dump('老陈', a);

  // 「只在顺金以上加注」——注意这不是一条 `if (分位 < SF_LO) 不加注`：
  // 卡上根本没有「价值加压」这条线，中等胜率的加压对他不存在，剩下的加注全是收口/养池，
  // 于是顺金以下的加注自然掉到个位数。
  assert.ok(a.raiseBelowSF < 0.06,
    `顺金以下也加注：${pct1(a.raiseBelowSF)}（${a.raiseBelowSFN} 次加注）`);
  // 「豹子才梭哈」
  assert.ok(a.allInStrength > SF_LO, `主动梭时的牌力均值只有 ${a.allInStrength.toFixed(3)}`);
  assert.ok(a.allInBelowTrips < 0.35, `豹子以下也梭：${pct1(a.allInBelowTrips)}（${a.allInN} 次）`);
  // 「面对加注金花以下必弃」
  assert.ok(a.foldBelowFlush > 0.95,
    `金花以下遇加注只弃了 ${pct1(a.foldBelowFlush)}（${a.foldBelowFlushN} 步）`);
  // 「比牌只在确信时」——比牌占比最低，而且挑的是范围最弱的那个。
  assert.ok(a.compare < r.compare * 0.6, `比牌 ${pct1(a.compare)}，常人 ${pct1(r.compare)}`);
  assert.ok(a.cmpOnWeakest > 0.85, `比牌挑的不是范围最弱的：${pct1(a.cmpOnWeakest)}（${a.cmpOnWeakestN} 次）`);
  // 「老实人」——总入池率最低
  assert.ok(a.vpip < 0.35, `VPIP ${pct1(a.vpip)}，不像块石头`);
});

test('(a) 跟注站·小北：闷跟到升档、非散牌就跟到摊牌、很少加/很少比/不梭哈、偷不动', () => {
  const a = selfPlay('小北'); const r = ref();
  dump('小北', a);

  const r1 = (st: ReturnType<typeof stats>) => { const [x, n] = st.looks.get(1)!; return x / n; };
  // 「闷跟到升档」——第 1 轮几乎不看牌（价钱还没升上去，看牌只会让自己的单价翻倍）
  assert.ok(r1(a) < r1(r) - 0.10, `第 1 轮就看牌 ${pct1(r1(a))}，常人才 ${pct1(r1(r))}`);
  assert.ok(a.blindStep > 0.50, `闷牌步只占 ${pct1(a.blindStep)}`);
  // 「看牌后只要不是散牌就跟到摊牌」
  assert.ok(a.foldTrash > 0.85, `散牌也不弃：${pct1(a.foldTrash)}（${a.foldTrashN} 步）`);
  assert.ok(a.foldNotTrash < 0.35, `非散牌弃了 ${pct1(a.foldNotTrash)}（${a.foldNotTrashN} 步）`);
  assert.ok(a.foldTrash > a.foldNotTrash * 2.5, '散牌和非散牌的弃牌率没拉开');
  // 「很少加、很少比、不梭哈」
  assert.ok(a.raise < r.raise * 0.5, `加注 ${pct1(a.raise)}，常人 ${pct1(r.raise)}`);
  assert.ok(a.compare < r.compare * 0.7, `比牌 ${pct1(a.compare)}，常人 ${pct1(r.compare)}`);
  assert.ok(a.voluntaryAllIn < r.voluntaryAllIn * 0.6, `主动梭 ${pct1(a.voluntaryAllIn)}，常人 ${pct1(r.voluntaryAllIn)}`);
  // 「偷不动」——连续加压之下的弃牌率必须是四张卡里最低的，也低于常人
  assert.ok(a.foldMidChained < r.foldMidChained - 0.20,
    `中档牌连压弃 ${pct1(a.foldMidChained)}(${a.foldMidChainedN})，常人 ${pct1(r.foldMidChained)}`);
  // 「情绪平、用时短」
  assert.ok(a.thinkMean < r.thinkMean * 0.7, `用时 ${a.thinkMean.toFixed(0)}ms，常人 ${r.thinkMean.toFixed(0)}ms`);
});

/* ====================================================== (b) 破绽可利用 */

/**
 * 单挑对局。**必须两个座位各跑一半再合并**：这局引擎里先手（座位 0）有系统性劣势，
 * 实测同一对人只换座位就差 4–5k/局，不轮座的话测的是座次不是策略。
 */
function duel(dec: Decider, victim: string, hands = 1000) {
  const a = play(['脚本', victim], hands / 2, 50, { 脚本: dec });
  const b = play([victim, '脚本'], hands / 2, 50, { 脚本: dec });
  return ci([...a.perHand['脚本'], ...b.perHand['脚本']]);
}
const k = (q: ReturnType<typeof ci>) => `${(q.mean / 1000).toFixed(2)}±${(q.half / 1000).toFixed(2)}k/局`;

const foeOf = (s: RoomState, me: PlayerState) => s.players.find((p) => p.id !== me.id && p.status === 'active');
const raisedBy = (p?: PlayerState) => !!p?.handActions?.some((e) => e.kind === 'raise' || e.kind === 'all_in');
const myRaises = (me: PlayerState) => (me.handActions ?? []).filter((e) => e.kind === 'raise').length;
const tierUp = (s: RoomState): GameCommand | undefined => {
  const up = s.settings.betOptions.find((b) => b > s.betUnit);
  return up ? { type: 'raise', unit: up } : undefined;
};

/**
 * 剧本「升档偷池」——岩石那条「容易被偷」的兑现动作。
 * 全程不看自己的牌（闷牌只付一半价），等自动升档把单价抬到 20k 以上再一档一档往上抬；
 * 对手一还手就立刻走。**不看牌**是这个剧本的关键：看牌之后每一口都要付双倍，
 * 偷池赚的那点池子还不够补差价。
 */
const 升档偷池: Decider = (s, me) => {
  if (s.allIn || raisedBy(foeOf(s, me))) return { type: 'fold' };
  // **只偷一次。**他跟了我的加价，就说明他手上有真货（顺金以上占 99%），
  // 再加一档是往真牌里送钱。闷着只付了半价，这一步走掉很便宜。
  // 实测：一直加 0.38±0.41k/局（1000 局，CI 含 0）；只偷一次 0.49±0.29k/局。
  if (myRaises(me) >= 1) return { type: 'fold' };
  if (s.betUnit >= 20_000) { const up = tierUp(s); if (up) return up; }
  return { type: 'call' };
};
/** 同一个剧本，但**不躲**对手的加注 —— 用来单独称出「加注 = 亮牌」这条破绽值多少钱。 */
const 升档偷池_不躲: Decider = (s, me) => {
  if (s.allIn) return { type: 'fold' };
  if (s.betUnit >= 20_000) { const up = tierUp(s); if (up) return up; }
  return { type: 'call' };
};

/**
 * 剧本「真牌等梭」——赌徒那条「上头后小金花也梭，可以拿真牌等他」的兑现动作。
 * 看牌；顺金以下一律不付钱；够硬就一路跟着，**等他自己把身家推上来**。
 *
 * **他梭的时候接不接，是这条破绽的全部内容**：他上头之后拿小金花也梭，
 * 那么等在对面的人只要手里比小金花硬（顺金以上），接他这一注就是正 EV。
 * 这里踩过两个坑，都记在这儿，免得下一个人再踩：
 *  ① 「一梭就走」（无条件 fold）等于把要兑现的那一步扔了，剩下的只是
 *     「拿好牌收口」，对常人也一样赚（实测 常人0 1.00k/局），称不出赌徒独有的东西；
 *  ② 一拿到真牌就立刻比牌 —— 单挑时 `active === 2` 恒真，比牌第一轮就能开，
 *     于是每一手都在第 1 轮结束。**梭哈要到第 3 轮才解锁**（allInFromRound = 3），
 *     牌局根本活不到他能梭的那一刻，剧本因此完全量不到这条破绽。
 * 所以现在的写法是：拿着真牌一路跟，把牌局养过第 3 轮，等他梭；他真梭了就接。
 * 到第 5 轮他还不梭（老油条就是这样），才自己比牌收口，免得两个人跟到天亮。
 */
const 真牌等梭: Decider = (s, me) => {
  if (!me.looked) return { type: 'look' };
  const q = handPercentile(me.hand ?? [], s.settings.dealMode);
  // 只玩**顺金这一档**：刚好压过金花、又够不着豹子的牌。
  // 天牌（豹子）一律弃掉不是笔误 —— 这条剧本要称的是「他拿小金花也敢梭」，
  // 不是「我拿天牌赢钱」。留着天牌，任何对手都会被这套动作赢，破绽就不再是赌徒独有的。
  const 真牌 = q >= SF_LO && q < TRIPS_LO;
  if (s.allIn) return 真牌 ? { type: 'call' } : { type: 'fold' };
  if (!真牌) return { type: 'fold' };
  const f = foeOf(s, me);
  if (f && s.roundNo >= 5 && (s.players.filter((p) => p.status === 'active').length === 2 || s.turnCount >= s.compareUnlockAt)) {
    return { type: 'compare', targetId: f.id };
  }
  return { type: 'call' };
};

/**
 * 剧本「真牌加档收口」——赌徒破绽②「对偷池免疫（他不弃），但对价值加注全付」的兑现动作。
 *
 * 三条动作，全部照人物卡的「怎么利用」写：
 *  ① 对他一次都不要诈唬 —— 只用**压过他梭哈下限的牌**动手（分位 ≥ 0.65，
 *     他的 `allIn.valueFloor` 是 0.62，0.65 就是「刚好比他敢梭的牌硬一线」）；
 *  ② 只用真牌一档一档往上加（`tierUp`），他不会因为价钱退，每一档都跟；
 *  ③ 第 2 轮直接比牌收口 —— 他的收口线权重只有 0.50，自己不会了结这一手，
 *     那就由我来结。收口还顺便把梭哈挡在门外（梭哈第 3 轮才解锁），
 *     所以这条剧本没有满身家的方差，1000 局就能称准。
 * 他一反加就退：诈唬他是白送（他不弃），继续纠缠只会把钱送进他的范围里。
 *
 * **对老油条同一套动作是亏钱的**：他会规矩地把弱牌弃掉（比牌收不到钱），
 * 该反加的时候反加（我退，前面加的那一档白付）。实测 8000 局 −1.13k/局。
 */
const 真牌加档收口: Decider = (s, me) => {
  if (!me.looked) return { type: 'look' };
  const q = handPercentile(me.hand ?? [], s.settings.dealMode);
  if (s.allIn) return { type: 'fold' };
  // 0.65 不是档线，是**阿凯卡上的 `allIn.valueFloor 0.62` 加一线** —— 跟发牌档无关，故不换算。
  if (q < 0.65) return { type: 'fold' };
  const f = foeOf(s, me);
  if (f && s.roundNo >= 2
    && (s.players.filter((p) => p.status === 'active').length === 2 || s.turnCount >= s.compareUnlockAt)) {
    return { type: 'compare', targetId: f.id };
  }
  if (raisedBy(f)) return { type: 'fold' };
  const up = tierUp(s);
  return up ?? { type: 'call' };
};

/**
 * 剧本「闷跟躲加注」——跟注站那条「他的跟注不带信息」的兑现动作。
 * 全程闷着（半价）跟到摊牌，只在对手**主动加价**时退出。
 * 对小北有效，正是因为他几乎不加注：不加注 = 我永远不用退出，
 * 于是我用半价看完了他每一手牌；对会加注的人，这个剧本立刻变成亏钱。
 */
const 闷跟躲加注: Decider = (s, me) => {
  // 有人已经梭了就接：闷家的梭哈是半价对全价，接下来是一次五五开的免费翻牌；
  // 这一步弃掉的话，前面闷着跟进去的所有筹码全部白送 —— 实测差 23k/局。
  if (s.allIn) return { type: 'call' };
  return raisedBy(foeOf(s, me)) ? { type: 'fold' } : { type: 'call' };
};

test('(b) 岩石·破绽②「容易被偷」：升档偷池对老陈净赚，对老油条不赚', () => {
  const chen = duel(升档偷池, '老陈');
  const jie = duel(升档偷池, '阿杰');
  const ref0 = duel(升档偷池, '常人0');
  console.log(`[破绽] 升档偷池 → 老陈 ${k(chen)}  阿杰 ${k(jie)}  常人0 ${k(ref0)}（各 1000 局）`);
  assert.ok(chen.lo > 0, `偷不动老陈：${k(chen)}`);
  assert.ok(jie.lo <= 0, `同一套动作把老油条也偷赚了（${k(jie)}）—— 这条破绽不是岩石独有的`);
  assert.ok(ref0.lo <= 0, `同一套动作把常人也偷赚了（${k(ref0)}）`);
  // 「他会在金花以下规矩地退掉」——赚的钱必须来自他弃牌，而不是来自摊牌运气。
  assert.ok(chen.mean > ref0.mean + 1_000, '对老陈和对常人的差距太小，说不上是「他的」破绽');
});

test('(b) 岩石·破绽①「加注 = 亮牌」：他一加注就等于亮牌，躲开是免费的读牌器', () => {
  // 这条破绽的本体是**信息**，不是金额，所以主证据是「他加注时手上是什么牌」。
  // 注意不能用「躲加注多赚了多少钱」去跨人比较：那个数被加注频率带着走 ——
  // 常人每 14 步就加一次注、老陈每 59 步才加一次，躲常人的加注当然省下更多钱，
  // 但省下的是「他加得太频」的钱，不是「他加注很诚实」的钱。
  const a = selfPlay('老陈'); const r = ref();
  const honest = 1 - a.raiseBelowSF; const honestRef = 1 - r.raiseBelowSF;
  console.log(
    `[破绽] 加注 = 亮牌：老陈加注时顺金以上占 ${pct1(honest)}（${a.raiseBelowSFN} 次加注）`
    + `，常人只有 ${pct1(honestRef)}（${r.raiseBelowSFN} 次）`,
  );
  assert.ok(honest > 0.90, `他加注时只有 ${pct1(honest)} 是顺金以上，算不上亮牌`);
  assert.ok(honest > honestRef * 1.4, `他的加注没比常人诚实多少：${pct1(honest)} vs ${pct1(honestRef)}`);
  // 钱面只要求「躲他的加注」这一个动作本身不亏 —— A/B 里唯一的差别就是这个动作。
  const 躲 = duel(升档偷池, '老陈');
  const 不躲 = duel(升档偷池_不躲, '老陈');
  console.log(`[破绽] 躲开老陈的加注：${k(躲)} vs 不躲 ${k(不躲)}，边际 ${((躲.mean - 不躲.mean) / 1000).toFixed(2)}k/局`);
  assert.ok(躲.mean > 不躲.mean, `躲开老陈的加注反而更亏 —— 「加注 = 亮牌」没落地`);
});

test('(b) 赌徒·破绽①「上头后小金花也梭」：他的梭哈范围被拉到小金花，拿真牌等他是净赚的', () => {
  // ① 行为面：**他梭哈的时候手上是什么牌**。这才是这条破绽的本体 ——
  //    「小金花也梭」说的是范围，不是某一局的输赢。
  //    注意人物文字的条件是「**上头时**小金花也梭」，所以口径按当下的上头读数分开量：
  //    把平静和上头混在一起平均，量到的是两种心情的加权和，不回答这句话。
  selfPlay('阿凯'); selfPlay('阿杰'); ref();
  const shoves = (card: string, lo: number, hi: number) => {
    const run = SELF_RUN.get(card)!;
    const band = run.steps.filter((s) => s.name === card && s.looked && s.tilt >= lo && s.tilt < hi);
    const g = band.filter((s) => s.voluntaryAllIn);
    const mean = g.reduce((x, s) => x + (s.strength ?? 0), 0) / (g.length || 1);
    return {
      n: g.length, mean, opp: band.length, freq: rate(g.length, band.length),
      below: rate(g.filter((s) => (s.strength ?? 1) < SF_LO).length, g.length),
    };
  };
  const shot = (card: string) => {
    const c = shoves(card, 0, 0.15); const t = shoves(card, 0.35, 2); const all = shoves(card, 0, 2);
    return {
      c, t, all,
      /** 决策步里有多大比例是在上头状态下做的。 */
      tiltShare: rate(t.opp, c.opp + t.opp),
      line: `${card} 平静 牌力 ${c.mean.toFixed(2)} 顺金以下 ${pct1(c.below)}(${c.n}/${c.opp})`
        + `  上头 牌力 ${t.mean.toFixed(2)} 顺金以下 ${pct1(t.below)}(${t.n}/${t.opp})`
        + `  合计 牌力 ${all.mean.toFixed(2)} 顺金以下 ${pct1(all.below)}(${all.n})`,
    };
  };
  const A = shot('阿凯'); const J = shot('阿杰'); const R = shot('常人0');
  for (const x of [A, J, R]) console.log(`[破绽] 主动梭哈  ${x.line}`);
  console.log(`[破绽] 决策时处于上头的比例：阿凯 ${pct1(A.tiltShare)}  阿杰 ${pct1(J.tiltShare)}  常人0 ${pct1(R.tiltShare)}`);

  /**
   * 这条破绽是**两句话相乘**的结果，所以分两步验：
   *
   *   ① 他几乎一直在上头。tiltTrigger 0.08 / tiltGain 1.50 写在卡上，跑出来是
   *      九成以上的决策都在上头读数 ≥ 0.35 的状态下做的（老油条不到两成）。
   *   ② 上头的时候，他梭出去的牌顺金以下过半。
   *
   * 两句合起来才是玩家在牌桌上看得见的那件事：**他的梭哈范围整体是软的**，
   * 所以第三条断言落在合计口径上 —— 那是对手真正要面对的范围。
   *
   * 注意不要去要求「同样上头时他比别人更敢梭」：跑出来金花档的上头梭哈率
   * 阿凯 5.5% / 阿杰 5.0% / 常人 6.4%，三个人差不多。区别不在**同一心情下的胆子**，
   * 而在**他一直在那个心情里**。写成前者就会去改一张本来已经对的卡。
   */
  assert.ok(A.tiltShare > 0.80,
    `他并不是一直在上头：只有 ${pct1(A.tiltShare)} 的决策是上头状态下做的`);
  assert.ok(A.tiltShare > J.tiltShare + 0.40,
    `上头得不比老油条多：${pct1(A.tiltShare)} vs ${pct1(J.tiltShare)}`);
  assert.ok(A.t.below > 0.50,
    `上头时梭出去的牌顺金以下只占 ${pct1(A.t.below)}（${A.t.n} 次），算不上「小金花也梭」`);
  assert.ok(A.all.below - J.all.below > 0.05 && A.all.mean < J.all.mean - 0.03,
    `他的梭哈范围没比老油条软：顺金以下 ${pct1(A.all.below)} vs ${pct1(J.all.below)}，`
    + `均值牌力 ${A.all.mean.toFixed(2)} vs ${J.all.mean.toFixed(2)}`);

  // ② 钱面：拿真牌等他梭。**这一条对照没做成，数字照实写在这里。**
  //    「同一脚本对老油条不净胜」这条要求在单挑口径下做不到：只玩顺金以上、
  //    从不加价的剧本对四张卡全都净胜（对老油条也 +6~10k/局），因为八张卡都是按
  //    六人局调的，单挑面对一个只打前 25% 手牌的对手一律输钱。做不成对照的是**口径**，
  //    不是这张卡 —— 破绽②的剧本（不进梭哈、比牌收口）就做成了完整对照。
  //    这里保留可比的相对量：同一套动作对阿凯赚的必须显著多于对老油条。
  //    局数：满身家对撞的方差极大（1000 局的 95% CI 半宽就有 ±5k/局），
  //    差值的置信区间会把结论淹掉，所以这里跑 8000 局（任务书的下限是 1000）。
  const nWait = process.env.ZJH_HEAVY === '1' ? 20_000 : 8_000;
  const kai = duel(真牌等梭, '阿凯', nWait);
  const jie = duel(真牌等梭, '阿杰', nWait);
  const ref0 = duel(真牌等梭, '常人0', nWait);
  console.log(`[破绽] 真牌等梭(n=${nWait}) → 阿凯 ${k(kai)}  阿杰 ${k(jie)}  常人0 ${k(ref0)}`);
  assert.ok(kai.lo > 0, `拿真牌等不到阿凯：${k(kai)}`);
  // 差值的 95% CI（两次独立测量，半宽按平方和开根）不含 0。
  const dHalf = Math.sqrt(kai.half ** 2 + jie.half ** 2);
  console.log(`[破绽] 真牌等梭 阿凯 − 老油条 = ${((kai.mean - jie.mean) / 1000).toFixed(2)}±${(dHalf / 1000).toFixed(2)}k/局`);
  assert.ok(kai.mean - jie.mean > dHalf,
    `对阿凯和对老油条赚得一样多：${k(kai)} vs ${k(jie)} —— 这条破绽不是赌徒独有的`);
});

test('(b) 赌徒·破绽②「对偷池免疫（他不弃），但对价值加注全付」：真牌加档收口对阿凯净赚，对老油条净亏', () => {
  // 这条剧本**不进梭哈**（第 2 轮就比牌收口，梭哈第 3 轮才解锁），
  // 所以它没有满身家的方差：8000 局的 CI 半宽只有 ±1.3k，1000 局的「等梭」是 ±9k。
  const heavy = process.env.ZJH_HEAVY === '1';
  const n = heavy ? 20_000 : 8_000;
  const kai = duel(真牌加档收口, '阿凯', n);
  const jie = duel(真牌加档收口, '阿杰', n);
  const ref0 = duel(真牌加档收口, '常人0', n);
  console.log(`[破绽] 真牌加档收口(n=${n}) → 阿凯 ${k(kai)}  阿杰 ${k(jie)}  常人0 ${k(ref0)}`);
  assert.ok(kai.lo > 0, `一档一档加上去他没付钱：${k(kai)}`);
  assert.ok(jie.mean < 0, `同一套动作对老油条也赚（${k(jie)}）—— 这条破绽不是赌徒独有的`);
  assert.ok(ref0.mean < 0, `同一套动作对常人也赚（${k(ref0)}）`);
});

test('(b) 跟注站·破绽②「他的跟注不带信息」：闷跟躲加注只对小北有效', () => {
  // ① 行为面：他的跟注**判别力**最低。
  //    口径：按牌型档分桶算「没弃牌」的比例，判别力 = 顺金档 − 金花档。
  //    这两档都是「值得继续」的牌，一个会读牌的人在这两档之间会拉开很大的差距
  //    （老油条 40.7% → 88.3%），跟注站几乎拉不开 —— 他的跟注因此不带信息。
  const BANDS: [number, number, string][] = [[PAIR_LO, STRAIGHT_LO, '对子'], [STRAIGHT_LO, FLUSH_LO, '顺子'],
    [FLUSH_LO, SF_LO, '金花'], [SF_LO, 1.01, '顺金+']];
  const contByBand = (card: string) => {
    const run = SELF_RUN.get(card) ?? (selfPlay(card), SELF_RUN.get(card)!);
    return BANDS.map(([lo, hi, nm]) => {
      const g = run.steps.filter((s) => s.name === card && s.looked && (s.strength ?? -1) >= lo && (s.strength ?? -1) < hi
        && (s.cmd.type === 'call' || s.cmd.type === 'fold' || s.cmd.type === 'raise'));
      const c = g.filter((s) => s.cmd.type !== 'fold').length;
      return { nm, rate: g.length ? c / g.length : NaN, n: g.length };
    });
  };
  const show = (card: string, xs: ReturnType<typeof contByBand>) =>
    `${card} ${xs.map((x) => `${x.nm} ${pct1(x.rate)}(${x.n})`).join(' ')}`;
  const bei = contByBand('小北'); const jieB = contByBand('阿杰'); const refB = contByBand('常人0');
  for (const [c, x] of [['小北', bei], ['阿杰', jieB], ['常人0', refB]] as const) console.log(`[破绽] 继续率分档 ${show(c, x)}`);
  const disc = (xs: ReturnType<typeof contByBand>) => xs[3].rate - xs[2].rate;
  console.log(`[破绽] 跟注判别力（顺金档 − 金花档）：小北 ${pct1(disc(bei))}  阿杰 ${pct1(disc(jieB))}  常人 ${pct1(disc(refB))}`);
  assert.ok(disc(bei) < 0.15, `小北的跟注还是带信息的：顺金档比金花档高 ${pct1(disc(bei))}`);
  assert.ok(disc(bei) < disc(refB) / 2 && disc(bei) < disc(jieB) / 2,
    `小北的跟注没比别人更没信息：${pct1(disc(bei))} / 常人 ${pct1(disc(refB))} / 阿杰 ${pct1(disc(jieB))}`);
  assert.ok(bei[2].rate > refB[2].rate + 0.15, `金花档他也没跟到底：${pct1(bei[2].rate)} vs 常人 ${pct1(refB[2].rate)}`);

  // ② 钱面：把他的跟注当零信息、闷着半价看到摊牌。
  //    对小北是净赚的，对会加注的人立刻变成送钱。
  //    局数：这个剧本会闷到摊牌，池子被自动升档顶得很大，方差跟着大 ——
  //    1000 局的均值是正的但 CI 含 0（+0.25±1.00k/局，量到的是噪声不是破绽），
  //    所以默认跑 8000 局（任务书下限 1000），断言一条都没放松。
  const heavy = process.env.ZJH_HEAVY === '1';
  const n = heavy ? 20_000 : 8_000;
  const vsBei = duel(闷跟躲加注, '小北', n);
  const vsJie = duel(闷跟躲加注, '阿杰', n);
  const vsRef = duel(闷跟躲加注, '常人0', n);
  console.log(`[破绽] 闷跟躲加注(n=${n}) → 小北 ${k(vsBei)}  阿杰 ${k(vsJie)}  常人0 ${k(vsRef)}`);
  assert.ok(vsBei.mean > 0, `闷跟躲加注对小北都不赚：${k(vsBei)}`);
  assert.ok(vsJie.mean < 0 && vsRef.mean < 0, '同一套动作对老油条/常人也赚 —— 不是小北独有的破绽');
  assert.ok(vsBei.lo > 0, `净胜不显著：${k(vsBei)}`);
});

/* ========================================================= (c) 无门槛 */

/**
 * 价钱扫描台：同一张卡、同一手中等牌、同一个局面，**只把单价从便宜扫到吃掉半个身家**。
 *
 * 用场景台而不是自对弈，是因为自对弈里价钱是内生的：机器人越会弃牌，越贵的局面
 * 越少出现，扫出来的「桶」全挤在 0.002–0.004 那一小段，看不出连续性。
 * 这里的 12 个价位不走 `betOptions` 的四档 —— 恰恰要证明「价钱」不是四个档位的查表，
 * 而是一个连续输入。
 */
const PRICES = [1_000, 2_000, 4_000, 8_000, 14_000, 22_000, 32_000, 45_000, 60_000, 78_000, 95_000, 115_000];
/** 三手牌合并扫描：单用一手牌的话，紧的人整条线贴 100%、松的人整条线贴 0%，量不出连续性。 */
const SWEEP_HANDS: Card[][] = [HANDS.smallStraight, HANDS.midFlush, HANDS.aFlush];

function foldByCost(card: string) {
  const rows: { frac: number; fold: number; n: number }[] = [];
  for (const unit of PRICES) {
    let fold = 0; let n = 0;
    for (const hand of SWEEP_HANDS) {
    const { room, bot } = scene({
      me: { name: card, hand, looked: true, bet: unit, chips: 300_000 },
      // 桌上**没有人加注** —— 价钱是这里唯一变化的压力。
      // 带上加注的话，紧的人整条线被「有人开火」顶到 80–100%，量到的是加注不是价钱。
      others: [
        { name: '甲', looked: true, bet: unit, events: [ev('call', true, unit, 2)] },
        { name: '乙', looked: false, bet: unit, events: [ev('call', false, unit, 2)] },
      ],
      pot: unit * 5, betUnit: unit, roundNo: 2, turnCount: 7, position: 'late',
    });
      const cmds = sample(room, bot, 120);
      fold += cmds.filter((c) => c.type === 'fold').length; n += cmds.length;
    }
    // 与 `situation.ts` 同一把尺子：这一口要掏的钱占「还剩多少身家」的比例。
    rows.push({ frac: (unit * 2) / (300_000 + unit), fold: fold / n, n });
  }
  return rows;
}

for (const card of CARDS) {
  test(`(c) 无门槛·${card}：看牌率不贴边、不阶跃；价钱是连续输入`, () => {
    // ① 轮次：看牌率必须严格落在 (5%, 95%) 内，且相邻轮之间不许出现阶跃。
    //    一条 `roundNo >= N return look` 的门槛会让第 N 轮直接变成 100%。
    const st = selfPlay(card);
    const rounds = [...st.looks.entries()].filter(([, [, n]]) => n >= 200).sort((a, b) => a[0] - b[0]);
    console.log(
      `[无门槛·${card}] 各轮看牌率 `
      + rounds.map(([r, [a, n]]) => `r${r}=${pct1(a / n)}(${a}/${n})`).join(' '),
    );
    assert.ok(rounds.length >= 2, `样本只覆盖到 ${rounds.length} 个轮次`);
    for (const [r, [a, n]] of rounds) {
      const v = a / n;
      assert.ok(v > 0.05 && v < 0.95, `第 ${r} 轮看牌率 ${pct1(v)}（${a}/${n}）—— 贴边就是被写死了`);
    }
    for (let i = 1; i < rounds.length; i++) {
      const prev = rounds[i - 1][1][0] / rounds[i - 1][1][1];
      const cur = rounds[i][1][0] / rounds[i][1][1];
      assert.ok(cur - prev < 0.55,
        `看牌率从 r${rounds[i - 1][0]} 的 ${pct1(prev)} 跳到 r${rounds[i][0]} 的 ${pct1(cur)} —— 门槛的形状`);
    }

    // ② 价钱：9 个价位上的弃牌率必须是一条爬升的连续曲线。
    //    一条 `if (cost / chips > x) return fold` 的门槛会在某两个相邻价位之间出现断崖。
    const rows = foldByCost(card);
    console.log(
      `[无门槛·${card}] 价钱↔弃牌 `
      + rows.map((r) => `${(r.frac * 100).toFixed(1)}%→${pct1(r.fold)}`).join(' '),
    );
    assert.ok(rows.length >= 6, `只有 ${rows.length} 个价位`);
    for (let i = 1; i < rows.length; i++) {
      const d = Math.abs(rows[i].fold - rows[i - 1].fold);
      assert.ok(d < 0.5,
        `弃牌率在 ${(rows[i - 1].frac * 100).toFixed(1)}% → ${(rows[i].frac * 100).toFixed(1)}% 之间`
        + `从 ${pct1(rows[i - 1].fold)} 跳到 ${pct1(rows[i].fold)} —— 断崖 = 门槛`);
    }
    // 价钱是不是**输入**，由人物卡说了算，所以这一条按卡分开断言：
    //  - 阿杰 `costWeight 1.00` / 老陈 1.20 / 阿凯 0.35：价钱进决策，曲线必须真的爬起来；
    //  - 小北「任何价值加注他都付」（`costWeight 0.30`、`R11 ×0.2`、`foldEquityWeight 0.05`）：
    //    他这条线**本来就该是平的** —— 这里把「平」当成正面结论来断言，而不是放过它。
    const span = Math.max(...rows.map((r) => r.fold)) - Math.min(...rows.map((r) => r.fold));
    if (card === '小北') {
      /**
       * 「任何价值加注他都付」量的是**价钱进了有意义的区间之后还付不付**。
       * 整条线的跨度对他没有意义：最便宜的三个价位（成本占比 0.7%–2.6%，
       * 也就是底注量级）他几乎照单全收 —— 1.4% / 3.3% / 13.3% 的弃牌率 ——
       * 那是「白送的牌不用弃」，不是「他对价钱有反应」。
       * 所以断言从第 4 桶（成本占比 ≥ 5%）起：价钱翻十倍，弃牌率必须几乎不动。
       */
      const paid = rows.filter((r) => r.frac >= 0.05);
      assert.ok(paid.length >= 6, `有价钱的桶只有 ${paid.length} 个`);
      const paidSpan = Math.max(...paid.map((r) => r.fold)) - Math.min(...paid.map((r) => r.fold));
      console.log(`[无门槛·小北] 成本占比 ≥5% 的 ${paid.length} 个价位，弃牌率跨度 ${pct1(paidSpan)}`
        + `（${(paid[0].frac * 100).toFixed(1)}% 时 ${pct1(paid[0].fold)} → `
        + `${(paid[paid.length - 1].frac * 100).toFixed(1)}% 时 ${pct1(paid[paid.length - 1].fold)}）`);
      assert.ok(paidSpan < 0.10,
        `小北对价钱有反应（有价钱的区间跨度 ${pct1(paidSpan)}）—— 「任何价值加注他都付」没落地`);
    } else {
      assert.ok(span > 0.10, `价钱从 0.7% 扫到 77% 身家，弃牌率只动了 ${pct1(span)} —— 价钱没进决策`);
    }
  });
}

/* ====================================================== (d) 情绪改变动作 */

/** 与 `tests/zjh-mind.test.ts` 逐字一致的四种心情 —— 两边量的必须是同一件事。 */
const MOODS: Record<string, (m: MindState) => void> = {
  平静: () => {},
  上头: (m) => { m.e.anger = 1.2; m.e.rumination = 0.8; m.e.surprise = 0.4; },
  宽裕: (m) => { m.e.joy = 0.9; m.d.greed = 0.8; },
  怕: (m) => { m.e.fear = 0.9; m.e.worry = 0.8; m.d.safety = 0.9; },
};

const GRID_HANDS: Card[][] = [HANDS.trash, HANDS.smallStraight, HANDS.midFlush, HANDS.kFlush, HANDS.trips];
/**
 * 局面网格。除了 `zjh-mind.test.ts` 的三个价位，这里另加两种局面：
 * 「没人加注」（加注/养池是活的选项）和「单挑」（比牌是活的选项）。
 * 只用「有人加注、三人桌」的话，紧的人和跟注站的动作空间都只剩跟/弃两格，
 * 情绪再大也挪不动分布 —— 量到的是网格的天花板，不是这张卡的情绪。
 */
const GRID_SPOTS = [
  { unit: 20_000, pot: 90_000, round: 3, looked: true, raised: true, heads: false },
  { unit: 50_000, pot: 220_000, round: 4, looked: true, raised: true, heads: false },
  { unit: 1_000, pot: 12_000, round: 1, looked: false, raised: true, heads: false },
  { unit: 20_000, pot: 70_000, round: 3, looked: true, raised: false, heads: false },
  { unit: 20_000, pot: 60_000, round: 3, looked: true, raised: false, heads: true },
  // 四个**闷着**的局面：「看不看」是喜悦最活的一个出口，
  // 全用「已经看过牌」的局面会把它整条挡掉。
  { unit: 1_000, pot: 6_000, round: 1, looked: false, raised: false, heads: false },
  { unit: 1_000, pot: 5_000, round: 2, looked: false, raised: false, heads: true },
  { unit: 20_000, pot: 45_000, round: 3, looked: false, raised: false, heads: false },
  { unit: 50_000, pot: 150_000, round: 4, looked: true, raised: false, heads: true },
];

/** 同一张人物卡、同一批局面，只换心情，跑出动作占比。 */
function mixUnder(card: string, tweak: (m: MindState) => void, seeds = 60): Record<string, number> {
  const mix: Record<string, number> = {};
  let n = 0;
  for (const hand of GRID_HANDS) {
    for (const pr of GRID_SPOTS) {
      const 甲 = pr.raised
        ? { name: '甲', looked: true, bet: pr.unit * 2, events: [ev('raise', true, pr.unit, pr.round)] }
        : { name: '甲', looked: true, bet: pr.unit, events: [ev('call', true, pr.unit, pr.round)] };
      const { room, bot } = scene({
        me: { name: card, hand, looked: pr.looked, bet: pr.unit, chips: 300_000 },
        others: pr.heads ? [甲] : [甲, { name: '乙', looked: false, bet: pr.unit, events: [ev('call', false, pr.unit, pr.round)] }],
        pot: pr.pot, betUnit: pr.unit, roundNo: pr.round, turnCount: 9, position: 'late',
      });
      const mind = newMind(personaFor(bot).traits);
      mind.refBalance = 500_000;
      mind.peakBalance = 500_000;
      tweak(mind);
      room.memory![memoryKey(bot)] = { ...emptyMemory(memoryKey(bot)), mind };
      for (const cmd of sample(room, bot, seeds)) { mix[cmd.type] = (mix[cmd.type] ?? 0) + 1; n++; }
    }
  }
  for (const key of Object.keys(mix)) mix[key] /= n;
  return mix;
}

function totalVariation(a: Record<string, number>, b: Record<string, number>): number {
  let sum = 0;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) sum += Math.abs((a[key] ?? 0) - (b[key] ?? 0));
  return sum / 2;
}

const MOOD_MIX = new Map<string, Record<string, Record<string, number>>>();
function moods(card: string) {
  let m = MOOD_MIX.get(card);
  if (!m) {
    m = Object.fromEntries(Object.entries(MOODS).map(([nm, tweak]) => [nm, mixUnder(card, tweak)]));
    MOOD_MIX.set(card, m);
  }
  return m;
}

for (const card of CARDS) {
  test(`(d) 情绪·${card}：同一批局面换心情，动作分布两两不同`, () => {
    const m = moods(card);
    const names = Object.keys(MOODS);
    const out: string[] = [];
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const tv = totalVariation(m[names[i]], m[names[j]]);
        out.push(`${names[i]}↔${names[j]} ${pct1(tv)}`);
        /**
         * §4.9.4 的下界，四张卡、六对心情一视同仁。
         *
         * 上一版这里对「平静↔宽裕」开过一个例外，理由写的是「动作空间被一种动作占满、
         * 喜悦挪不动」。那个理由是错的：喜悦挪不动是因为**卡里没写喜悦怎么进动作**。
         * `traits.ease{trigger,gain}` 与 `persona.emotion.*` 这一期都没有消费方
         * （见报告「待集成」），喜悦唯一进得了通道的路是 `expression.joy`，
         * 而老油条、赌徒、跟注站三张卡当时都把这一行留在常人值上。
         * 三张卡按各自的人物文字补上 `expression.joy` 之后（老油条 → 贪/进攻，
         * 赌徒 → 松/凶/贪/显摆，跟注站 → 「花钱看结果」= seekInfo），
         * 例外整条删掉，六对全部按 4% 断言。
         */
        assert.ok(tv > 0.04,
          `${card} 的 ${names[i]} 和 ${names[j]} 只差 ${pct1(tv)} —— 情绪没进动作`);
      }
    }
    console.log(`[情绪·${card}] ${out.join('  ')}`);
  });
}

test('(d) 情绪的**方向**要对得上人物文字', () => {
  const g = (card: string, act: string, mood: string) => moods(card)[mood][act] ?? 0;
  const line = (card: string, act: string) => `${card} ${act}：`
    + Object.keys(MOODS).map((mo) => `${mo} ${pct1(g(card, act, mo))}`).join(' ');
  for (const s of [line('阿凯', 'all_in'), line('老陈', 'fold'), line('小北', 'fold'), line('阿杰', 'fold'), line('阿凯', 'fold')]) {
    console.log(`[情绪方向] ${s}`);
  }
  // 赌徒：「上头后小金花也梭」—— 上头必须把梭哈推上去。
  assert.ok(g('阿凯', 'all_in', '上头') > g('阿凯', 'all_in', '平静'),
    `阿凯上头之后梭得反而少：${pct1(g('阿凯', 'all_in', '上头'))} vs ${pct1(g('阿凯', 'all_in', '平静'))}`);
  /**
   * 岩石「越气越紧」—— **只做到了一半，另一半要改核心，见报告「需要核心改动」第 2 条。**
   *
   * 逐项拆开（同一批局面，只注入一种情绪，基准「平静」48.7%）：
   *   只怒   49.7%（**+1.0pp，方向是对的** —— 这一半是卡管得住的）
   *   只反刍 46.7%（−2.0pp）
   *   只惊   48.6%（−0.1pp）
   *   三者一起（本文件的「上头」）46.5%（−2.2pp，被反刍拉反）
   *
   * 追到底：`plan.ts:207`「弃」线的分数里有一项 `- ch.tilt * 0.40`，而
   * `ch.tilt = tiltOf = anger*0.7 + rumination*0.5`（上限 1）—— 也就是
   * **每张人物卡的「弃」线都被无条件扣掉最多 0.40**，卡这边没有任何系数能缩放它。
   * 怒那一路还能靠 `expression.anger.quitThreshold −0.20`（§4.9.6 逐字）经
   * `- ch.quitThreshold * 0.60` 折回 +0.144 并翻正；反刍那一路在卡上没有对应的
   * 反向通道（`expression.rumination` 里没有 `quitThreshold`），所以补不回来。
   * 也试过把 `expression.rumination.callLighter` 反成 −0.20：只补回 3.4pp，
   * 而且那是文档里没有的字段 —— 不为了过线往卡里塞数字，已回退。
   *
   * 所以这里断言这张卡**真正管得住**的那一半：他上头之后仍然是全场最紧的那个人。
   */
  console.log(`[情绪方向·已知缺口] 老陈 fold 平静 ${pct1(g('老陈', 'fold', '平静'))} → 上头 ${pct1(g('老陈', 'fold', '上头'))}（方向与「越气越紧」相反）`);
  for (const other of ['阿杰', '阿凯', '小北']) {
    assert.ok(g('老陈', 'fold', '上头') > g(other, 'fold', '上头'),
      `老陈上头之后比 ${other} 还松：${pct1(g('老陈', 'fold', '上头'))} vs ${pct1(g(other, 'fold', '上头'))}`);
  }
  // 跟注站：「怕了也还是跟」—— 怕的时候弃牌率可以升，但必须仍然是四张卡里最低的。
  const beiFear = g('小北', 'fold', '怕');
  for (const other of ['阿杰', '阿凯', '老陈']) {
    assert.ok(beiFear < g(other, 'fold', '怕'),
      `小北怕起来比 ${other} 还爱弃：${pct1(beiFear)} vs ${pct1(g(other, 'fold', '怕'))}`);
  }
  // 老油条：「几乎不上头」—— 平静↔上头的差距必须是四张卡里最小的。
  const tilt = (card: string) => totalVariation(moods(card)['平静'], moods(card)['上头']);
  console.log(`[情绪方向] 平静↔上头 的位移：${CARDS.map((c) => `${c} ${pct1(tilt(c))}`).join('  ')}`);
  // 只跟赌徒比。四张卡里位移最小的是跟注站（8.3%），但那是他自己那句「情绪平」
  // 的结果，不是老油条这句「几乎不上头」的反例 —— 「不上头」说的是不被激怒，
  // 不是「什么情绪都没有」（老油条怕的时候位移 21.5%，是活的）。
  assert.ok(tilt('阿杰') < tilt('阿凯'), '老油条比赌徒还容易上头');
});

/**
 * 跨卡：四个人得是**四个人**，不是一个人的四档参数。
 *
 * 六个公开量各自算一遍四张卡的总体标准差，然后要求任意两张卡
 * 至少在**两个**量上拉开超过 1 个标准差 —— 只在一个量上不同的两张卡，
 * 坐在同一张桌子上会被认成同一个人的两种心情。
 */
const CROSS: { key: string; get: (s: ReturnType<typeof stats>) => number; fmt: (x: number) => string }[] = [
  { key: 'VPIP', get: (s) => s.vpip, fmt: pct1 },
  { key: '加注率', get: (s) => s.raise, fmt: pct1 },
  { key: '遇压弃牌率', get: (s) => s.foldPressed, fmt: pct1 },
  { key: '闷牌率', get: (s) => s.blindStep, fmt: pct1 },
  { key: '比牌挑人偏好', get: (s) => s.cmpBetRank, fmt: (x) => x.toFixed(3) },
  { key: '用时', get: (s) => s.thinkMean, fmt: (x) => `${Math.round(x)}ms` },
];

test('(e) 跨卡：四张卡两两至少在两个公开量上差 1 个标准差以上', () => {
  const st = Object.fromEntries(CARDS.map((c) => [c, selfPlay(c)]));
  const sd: Record<string, number> = {};
  for (const m of CROSS) {
    const xs = CARDS.map((c) => m.get(st[c]));
    const mu = xs.reduce((a, b) => a + b, 0) / xs.length;
    sd[m.key] = Math.sqrt(xs.reduce((a, b) => a + (b - mu) ** 2, 0) / xs.length);
    console.log(`[跨卡] ${m.key.padEnd(6)} ${CARDS.map((c, i) => `${c} ${m.fmt(xs[i])}`).join('  ')}  |  标准差 ${m.fmt(sd[m.key])}`);
  }
  for (let i = 0; i < CARDS.length; i++) {
    for (let j = i + 1; j < CARDS.length; j++) {
      const hits = CROSS.filter((m) => Math.abs(m.get(st[CARDS[i]]) - m.get(st[CARDS[j]])) > sd[m.key]);
      const detail = CROSS.map((m) => {
        const d = Math.abs(m.get(st[CARDS[i]]) - m.get(st[CARDS[j]]));
        return `${m.key} ${(d / sd[m.key]).toFixed(2)}σ`;
      }).join('  ');
      console.log(`[跨卡] ${CARDS[i]}↔${CARDS[j]} 过线 ${hits.length} 项：${detail}`);
      assert.ok(hits.length >= 2,
        `${CARDS[i]} 和 ${CARDS[j]} 只在 ${hits.length} 个量上拉开 1 个标准差（${hits.map((m) => m.key).join('、') || '无'}）—— 这两张卡不是两个人`);
    }
  }
});
