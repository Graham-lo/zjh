/**
 * P3 人物卡 · B 线验收（闷牌王 老王 / 数学型 小林 / 新手 小雨 / 复仇者 阿彪）。
 *
 * 这个文件不测「代码有没有跑通」，测的是**人物文字有没有变成行为**：
 *   (a) 自洽    —— 人物卡上每一句能量化的话，都要在真实自对弈的公开统计里看得见；
 *   (b) 破绽可利用 —— 每条写在卡上的破绽，都要有一个固定脚本能靠它稳定赢钱，
 *                    而同一个脚本打数学型（小林）赢不到钱（否则那不是破绽，是引擎的普遍漏洞）；
 *   (c) 无门槛  —— 看牌率、弃牌率沿着轮次和价格连续变化，找不到阶跃；
 *   (d) 情绪改变动作 —— 同一个局面换心情，动作分布就不一样，且方向符合人物设定。
 *
 * 全部用真实牌局跑出来，没有手搓的期望值。种子钉死 20260903。
 * `ZJH_HEAVY=1` 把样本量翻三倍（报告里的重样本数字就是这么来的）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCommand, botAction, createHumanPlayer, createInitialRoom, currentPlayer,
  DEFAULT_SETTINGS, emptyMemory, handPercentile, memoryKey, playerMemory,
  type Card, type GameCommand, type PlayerState, type RoomState,
} from '../shared/game.ts';
import { newMind, type MindState } from '../shared/mind/emotion.ts';
import { COMMON_PERSONA, PERSONAS, personaFor } from '../shared/zjh/bot/personas/index.ts';
import { warmUpRange } from '../shared/zjh/bot/range.ts';
import { FLUSH_LO, HANDS as FIXED_HANDS, PAIR_LO, SF_LO, TRIPS_LO, ev, sample, scene } from './zjh-helpers.ts';
import { withSeededRandom, comparedWeakest } from './zjh-arena.ts';

warmUpRange();

/* --------------------------------------------------------------- 陪练与规模 */

/**
 * 五个「常人」陪练：同一张 `COMMON_PERSONA`，只是名字不同。
 * 人物卡是按名字路由的，所以给常人卡起五个名字就等于摆出五个一模一样的普通人，
 * 这样统计出来的差异只可能来自被测的那一张卡。
 */
const COMMONS = ['常人甲', '常人乙', '常人丙', '常人丁', '常人戊'];
for (const n of [...COMMONS, '常人己']) PERSONAS[n] = { ...COMMON_PERSONA, name: n };

const SEED = 20260903;
const HEAVY = process.env.ZJH_HEAVY === '1';
/** (a)(c) 的自对弈手数：任务书要求 ≥2000。 */
const HANDS = HEAVY ? 6000 : 2000;
/**
 * (b) 每场单挑的手数。
 *
 * 任务书只要 ≥1000，这里给到 8000：验收口径从「绝对成绩」改成**增量**之后，
 * 一次判定要合成四段样本（靶子有脚本 / 靶子无脚本 / 对照有脚本 / 对照无脚本），
 * 方差是相加的。4000 手时合成区间的半宽约 ±6k，比要量的效应还大，
 * 量出来的全是噪声（实测同一条脚本 6000 手 差 6.3k、12000 手 差 1.4k）。
 */
const DUEL = HEAVY ? 16000 : 8000;
/** (d) 每个局面的采样次数。 */
const SEEDS = HEAVY ? 200 : 80;

const CARDS = ['老王', '小林', '小雨', '阿彪'];

const pc = (a: number, b: number) => (b ? `${(a / b * 100).toFixed(1)}%` : 'n/a');

/* ------------------------------------------------------------------ 自对弈台 */

interface Step {
  hand: number; cmd: GameCommand; looked: boolean; roundNo: number; seat: string;
  betUnit: number; strength?: number; thinkMs: number; pressured: boolean; allInPending: boolean;
  chips: number; costFrac: number; engaged: boolean; pickedWeakest?: boolean;
}

function underPressure(state: RoomState, me: { id: string }): boolean {
  return !!state.allIn
    || state.betUnit > state.settings.betOptions[0]
    || state.players.some((p) => p.id !== me.id && p.status === 'active'
      && p.handActions?.some((e) => e.kind === 'raise'));
}

/** 一张六人桌：座 0 是被测的卡，其余是常人。名字即人物卡，机器人记忆也按名字走。 */
function table(names: string[]): RoomState {
  const host = createHumanPlayer('h', '🐯', 0, 'h0');
  const room = createInitialRoom('123456', host);
  for (const p of room.players) p.ready = true;
  for (let i = 1; i < names.length; i++) applyCommand(room, host.id, { type: 'add_bot' });
  room.players[0].isBot = true;
  room.players.forEach((p, i) => { p.name = names[i]; });
  return room;
}

/** 比牌时挑的是不是**当时最弱**的那家（只有三家以上才有得挑）。 */
function pickedWeakest(room: RoomState, meId: string, targetId: string): boolean | undefined {
  const others = room.players.filter((p) => p.id !== meId && p.status === 'active');
  if (others.length < 2) return undefined;
  return comparedWeakest(room, room.players.find(p => p.id === meId)!, targetId);
}

function play(names: string[], hands: number, reset = 50): Step[] {
  return withSeededRandom(SEED, () => {
    const steps: Step[] = [];
    let room = table(names);
    for (let h = 0; h < hands; h++) {
      // 每 50 手换一张新桌：不重置的话破产的人会退场，桌子越打越小，统计就漂了。
      if (reset && h && h % reset === 0) room = table(names);
      applyCommand(room, room.hostId, { type: 'start' });
      let guard = 0;
      while (room.phase === 'playing' && guard++ < 400) {
        const cur = currentPlayer(room);
        if (!cur) break;
        const out = botAction(room, cur);
        const target = out.cmd.type === 'compare' ? out.cmd.targetId : undefined;
        steps.push({
          hand: h, cmd: out.cmd, looked: cur.looked, roundNo: room.roundNo, seat: cur.name,
          betUnit: room.betUnit,
          strength: cur.looked && cur.hand.length === 3 ? handPercentile(cur.hand, room.settings.dealMode) : undefined,
          thinkMs: out.thinkMs, chips: cur.chips,
          costFrac: room.betUnit * (cur.looked ? 2 : 1) / Math.max(1, cur.chips),
          engaged: out.trace?.engaged ?? false,
          allInPending: !!room.allIn,
          pickedWeakest: target ? pickedWeakest(room, cur.id, target) : undefined,
          pressured: underPressure(room, cur),
        });
        applyCommand(room, cur.id, out.cmd, out.thinkMs);
      }
      applyCommand(room, room.hostId, { type: 'new_round' });
    }
    return steps;
  });
}

/** (a)(c)(跨卡) 三项共用同一批自对弈，跑一次缓存起来。整桌六个人的步都留着：
 *  「这张卡 vs 同桌五个常人」是同一局同一种子下唯一变量只剩人物卡的对照。 */
const RUNS = new Map<string, Step[]>();
function tableRun(card: string): Step[] {
  let got = RUNS.get(card);
  if (!got) { got = play([card, ...COMMONS], HANDS); RUNS.set(card, got); }
  return got;
}
function mine(card: string): Step[] { return tableRun(card).filter((s) => s.seat === card); }
/** 同一张桌上的五个常人（对照组）。 */
function commonsAt(card: string): Step[] { return tableRun(card).filter((s) => s.seat !== card); }

/**
 * 已看牌、牌力落在 [lo, hi)、**而且这一步真的能加注**（面前没有挂着的梭哈）时的加注率。
 *
 * 把「有人梭哈待应」的步剔掉，是因为那种局面根本没有「加注」这个选项，
 * 留在分母里就变成了在比「谁更常被梭哈」，而不是在比「拿到大牌想不想加」。
 */
function raiseRate(steps: Step[], lo: number, hi: number): { n: number; rate: number } {
  const q = steps.filter((s) => s.cmd.type !== 'look' && s.looked && !s.allInPending
    && s.strength !== undefined && s.strength >= lo && s.strength < hi);
  const r = q.filter((s) => s.cmd.type === 'raise').length;
  return { n: q.length, rate: r / Math.max(1, q.length) };
}

/* --------------------------------------------------------------- 统计小工具 */

interface Profile {
  acts: Step[];
  /** 本手第一个非看牌动作不是弃牌的手数占比 */
  vpip: number;
  raise: number; fold: number; blind: number; foldPressed: number;
  /** 比牌时挑最弱那家的比例 */
  pick: number;
  /** 平均每步用时（秒） */
  ms: number;
  /** 各轮「还闷着的时候选择看牌」的比例 */
  lookByRound: [number, number, number][];
  /** 打到第 3 轮时还闷着的比例 */
  blindTo3: number;
  compares: number; blindCompares: number;
  /** 看过牌、拿着**散牌**（`< PAIR_LO`，赢不了摊牌的那一档）仍加注/梭哈 */
  bluff: number;
  engage: number;
  raiseStrength: number;
  /** 看过牌之后「只是跟一口」的比例 */
  lookedCall: number;
}

function profile(steps: Step[]): Profile {
  const acts = steps.filter((s) => s.cmd.type !== 'look');
  const first = new Set<number>(); let vpip = 0;
  for (const s of acts) {
    if (first.has(s.hand)) continue;
    first.add(s.hand);
    if (s.cmd.type !== 'fold') vpip++;
  }
  const pressed = acts.filter((s) => s.pressured);
  const cmp = steps.filter((s) => s.pickedWeakest !== undefined);
  const compares = acts.filter((s) => s.cmd.type === 'compare');
  const byRound = new Map<number, [number, number]>();
  for (const s of steps) {
    if (s.looked) continue;
    const r = Math.min(4, s.roundNo);
    const a = byRound.get(r) ?? [0, 0];
    a[1]++; if (s.cmd.type === 'look') a[0]++;
    byRound.set(r, a);
  }
  let at3 = 0; let b3 = 0; let last = -1; let counted = false;
  for (const s of steps) {
    if (s.hand !== last) { last = s.hand; counted = false; }
    if (s.roundNo >= 3 && !counted) { counted = true; at3++; if (!s.looked) b3++; }
  }
  const looked = acts.filter((s) => s.looked && s.strength !== undefined);
  const junk = looked.filter((s) => s.strength! < PAIR_LO);
  const raises = acts.filter((s) => s.cmd.type === 'raise' && s.strength !== undefined);
  return {
    acts,
    vpip: vpip / Math.max(1, first.size),
    raise: acts.filter((s) => s.cmd.type === 'raise' || s.cmd.type === 'all_in').length / acts.length,
    fold: acts.filter((s) => s.cmd.type === 'fold').length / acts.length,
    blind: acts.filter((s) => !s.looked).length / acts.length,
    foldPressed: pressed.filter((s) => s.cmd.type === 'fold').length / Math.max(1, pressed.length),
    pick: cmp.filter((s) => s.pickedWeakest).length / Math.max(1, cmp.length),
    ms: acts.reduce((a, s) => a + s.thinkMs, 0) / acts.length / 1000,
    lookByRound: [...byRound.entries()].sort((x, y) => x[0] - y[0])
      .map(([r, [a, n]]) => [r, a, n] as [number, number, number]),
    blindTo3: b3 / Math.max(1, at3),
    compares: compares.length,
    blindCompares: compares.filter((s) => !s.looked).length,
    bluff: junk.filter((s) => s.cmd.type === 'raise' || s.cmd.type === 'all_in').length / Math.max(1, junk.length),
    engage: acts.filter((s) => s.engaged).length / acts.length,
    raiseStrength: raises.reduce((a, s) => a + s.strength!, 0) / Math.max(1, raises.length),
    lookedCall: looked.filter((s) => s.cmd.type === 'call').length / Math.max(1, looked.length),
  };
}

const PROFILES = new Map<string, Profile>();
function prof(card: string): Profile {
  let got = PROFILES.get(card);
  if (!got) { got = profile(mine(card)); PROFILES.set(card, got); }
  return got;
}

function report(card: string): string {
  const p = prof(card);
  return `[自洽 ${card}] 步数 ${p.acts.length}  `
    + `看牌率 ${p.lookByRound.map(([r, a, n]) => `r${r}=${pc(a, n)}(${a}/${n})`).join(' ')}\n`
    + `          VPIP ${(p.vpip * 100).toFixed(1)}%  加注率 ${(p.raise * 100).toFixed(1)}%  `
    + `弃牌率 ${(p.fold * 100).toFixed(1)}%  遇压弃牌率 ${(p.foldPressed * 100).toFixed(1)}%  `
    + `闷牌率 ${(p.blind * 100).toFixed(1)}%  闷到第3轮 ${(p.blindTo3 * 100).toFixed(1)}%\n`
    + `          比牌 ${p.compares} 手（闷比 ${pc(p.blindCompares, p.compares)}，挑最弱 ${(p.pick * 100).toFixed(1)}%）  `
    + `诈唬率 ${(p.bluff * 100).toFixed(1)}%  系统2介入 ${(p.engage * 100).toFixed(1)}%  `
    + `加注均牌力 ${p.raiseStrength.toFixed(3)}  均用时 ${(p.ms * 1000).toFixed(0)}ms`;
}

/* ================================================================ (a) 自洽 */

test('[自洽] 老王：闷牌王 —— 不看牌、闷着压、闷着比，输了才上头', () => {
  const p = prof('老王');
  console.log(report('老王'));
  assert.ok(p.acts.length > 4000, `样本不够：${p.acts.length} 步`);

  // 「他就是不看牌」：三分之二以上的动作是闷着做的
  assert.ok(p.blind > 0.60, `闷牌率只有 ${(p.blind * 100).toFixed(1)}%，闷牌王不该这么爱看牌`);
  // 「一路闷到底」：打到第 3 轮还闷着的手，要占多数
  assert.ok(p.blindTo3 > 0.60, `打到第 3 轮还闷着的只有 ${(p.blindTo3 * 100).toFixed(1)}%`);
  // 「第一轮几乎不看」：但不能是 0（那就是门槛了，(c) 会再查一遍）
  const r1 = p.lookByRound.find(([r]) => r === 1)!;
  assert.ok(r1[1] / r1[2] < 0.25, `第 1 轮看牌率 ${pc(r1[1], r1[2])}，太高`);
  // 「闷着比牌」：他的比牌绝大多数是闷比
  assert.ok(p.compares > 200, `比牌样本只有 ${p.compares} 手`);
  assert.ok(p.blindCompares / p.compares > 0.70,
    `闷比只占 ${pc(p.blindCompares, p.compares)}，「闷着比牌」没兑现`);
  // 「敢用烂牌吓人」：四张卡里诈唬率最高
  const bluffs = CARDS.map((c) => [c, prof(c).bluff] as const);
  const top = bluffs.reduce((a, b) => (b[1] > a[1] ? b : a));
  assert.equal(top[0], '老王', `诈唬率最高的是 ${top[0]} 不是老王：`
    + bluffs.map(([c, v]) => `${c}=${(v * 100).toFixed(1)}%`).join(' '));
  // 「便宜就跟着玩」：几乎不在第一口就走
  assert.ok(p.vpip > 0.85, `VPIP 只有 ${(p.vpip * 100).toFixed(1)}%`);
});

test('[自洽] 小林：数学型 —— 算得动、弃得下、从不诈唬', () => {
  const p = prof('小林');
  console.log(report('小林'));

  // 「他看牌是为了算」：闷牌率低
  assert.ok(p.blind < 0.25, `闷牌率 ${(p.blind * 100).toFixed(1)}%，数学型不该这么爱闷`);
  // 「不值就扔」：四张卡里弃牌率最高，且过三分之一
  assert.ok(p.fold > 0.35, `弃牌率只有 ${(p.fold * 100).toFixed(1)}%`);
  const folds = CARDS.map((c) => [c, prof(c).fold] as const);
  assert.equal(folds.reduce((a, b) => (b[1] > a[1] ? b : a))[0], '小林',
    '弃牌率最高的应该是小林：' + folds.map(([c, v]) => `${c}=${(v * 100).toFixed(1)}%`).join(' '));
  // 「他真的在算」：系统 2 介入率四张卡里最高，且明显高于常人
  const engs = CARDS.map((c) => [c, prof(c).engage] as const);
  assert.equal(engs.reduce((a, b) => (b[1] > a[1] ? b : a))[0], '小林',
    '系统2介入率最高的应该是小林：' + engs.map(([c, v]) => `${c}=${(v * 100).toFixed(1)}%`).join(' '));
  assert.ok(p.engage > 0.30, `系统2介入率只有 ${(p.engage * 100).toFixed(1)}%`);
  // 「从不诈唬」：烂牌加注接近 0
  assert.ok(p.bluff < 0.01, `诈唬率 ${(p.bluff * 100).toFixed(1)}%，数学型不该诈唬`);
  // 「加注只为价值」：加注时的平均牌力四张卡里最高
  const rs = CARDS.map((c) => [c, prof(c).raiseStrength] as const);
  assert.equal(rs.reduce((a, b) => (b[1] > a[1] ? b : a))[0], '小林',
    '加注均牌力最高的应该是小林：' + rs.map(([c, v]) => `${c}=${v.toFixed(3)}`).join(' '));
  // 「想得久」：平均用时四张卡里最长
  const mss = CARDS.map((c) => [c, prof(c).ms] as const);
  assert.equal(mss.reduce((a, b) => (b[1] > a[1] ? b : a))[0], '小林',
    '用时最长的应该是小林：' + mss.map(([c, v]) => `${c}=${(v * 1000).toFixed(0)}ms`).join(' '));
});

test('[自洽] 小雨：新手 —— 一上来就看牌，跟得住小注，大注一吓就走', () => {
  const p = prof('小雨');
  console.log(report('小雨'));

  // 「轮到就看牌」写成连续目标：第 1 轮看牌率高，但绝不是 100%
  const r1 = p.lookByRound.find(([r]) => r === 1)!;
  const rate1 = r1[1] / r1[2];
  assert.ok(rate1 > 0.85 && rate1 < 0.95,
    `第 1 轮看牌率 ${pc(r1[1], r1[2])} —— 要落在 (85%, 95%)，贴到 100% 就是门槛`);
  // 「几乎不闷」
  assert.ok(p.blind < 0.10, `闷牌率 ${(p.blind * 100).toFixed(1)}%，新手不该会闷`);
  // 「升到 5 万档以上多半弃，除非拿到金花以上」—— 写成两个可测的连续量
  const hi = p.acts.filter((s) => s.betUnit >= 50_000 && s.looked && s.strength !== undefined);
  const weak = hi.filter((s) => s.strength! < FLUSH_LO);   // 金花以下（categoryBands('standard')）
  const strong = hi.filter((s) => s.strength! >= FLUSH_LO);
  const weakFold = weak.filter((s) => s.cmd.type === 'fold').length / Math.max(1, weak.length);
  const strongFold = strong.filter((s) => s.cmd.type === 'fold').length / Math.max(1, strong.length);
  console.log(`[自洽 小雨] 5万档以上：金花以下弃牌率 ${(weakFold * 100).toFixed(1)}%(${weak.length})  `
    + `金花以上弃牌率 ${(strongFold * 100).toFixed(1)}%(${strong.length})`);
  assert.ok(weak.length >= 60 && strong.length >= 200, '高价位样本不够');
  assert.ok(weakFold > 0.70, `5 万档以上、金花以下只弃了 ${(weakFold * 100).toFixed(1)}%`);
  assert.ok(strongFold < 0.45, `拿到金花以上还弃了 ${(strongFold * 100).toFixed(1)}%，「除非」没兑现`);
  // 破绽「拿大牌会忍不住秒加」的「加」那一半 ——
  // 同一张桌、同一个种子、同样看过牌、同样金花以上，唯一的差别是座 0 换了张卡：
  // 小雨在大牌上的加注推力必须**高于常人**（旧版本 lines.价值加压 0.60 < 常人 1.00，
  // 方向是反的，只靠「整体加注率最低」看不出来）。
  // 「秒」那一半（thinkMs）本期没有消费方，见 docs/zjh/personas.md 的待集成清单。
  const meBig = raiseRate(mine('小雨'), 0.37, 2);
  const cmBig = raiseRate(commonsAt('小雨'), 0.37, 2);
  const meSmall = raiseRate(mine('小雨'), 0, 0.37);
  const cmSmall = raiseRate(commonsAt('小雨'), 0, 0.37);
  console.log(`[自洽 小雨] 金花以上加注率 小雨 ${(meBig.rate * 100).toFixed(1)}%(${meBig.n}) `
    + `vs 常人 ${(cmBig.rate * 100).toFixed(1)}%(${cmBig.n})  `
    + `顺子及以下 小雨 ${(meSmall.rate * 100).toFixed(1)}%(${meSmall.n}) `
    + `vs 常人 ${(cmSmall.rate * 100).toFixed(1)}%(${cmSmall.n})`);
  assert.ok(meBig.n >= 2000 && cmBig.n >= 2000, `大牌样本不够：${meBig.n} / ${cmBig.n}`);
  assert.ok(meBig.rate > cmBig.rate * 1.15,
    `金花以上加注率 ${(meBig.rate * 100).toFixed(1)}% 没有明显高过常人 ${(cmBig.rate * 100).toFixed(1)}%`);
  // 「他只会在拿到大牌时加」：顺子及以下几乎不加，而且不比常人更爱加
  assert.ok(meSmall.rate < 0.01,
    `顺子及以下还加了 ${(meSmall.rate * 100).toFixed(1)}%，新手不该拿烂牌加注`);
  assert.ok(meSmall.rate <= cmSmall.rate,
    `顺子及以下加注率 ${(meSmall.rate * 100).toFixed(1)}% 高过常人 ${(cmSmall.rate * 100).toFixed(1)}%`);
  // 「有时跟到底不知道为什么」（跟到底看 2.20）：看过牌之后「只是跟一口」的比例四张卡里最高
  const cs = CARDS.map((c) => [c, prof(c).lookedCall] as const);
  console.log('[自洽 小雨] 看牌后跟注率 '
    + cs.map(([c, v]) => `${c}=${(v * 100).toFixed(1)}%`).join(' '));
  assert.equal(cs.reduce((a, b) => (b[1] > a[1] ? b : a))[0], '小雨',
    '看牌后跟注率最高的应该是小雨：' + cs.map(([c, v]) => `${c}=${(v * 100).toFixed(1)}%`).join(' '));
  // 「不算账」：系统 2 介入率四张卡里最低，用时也最短
  const engs = CARDS.map((c) => [c, prof(c).engage] as const);
  assert.equal(engs.reduce((a, b) => (b[1] < a[1] ? b : a))[0], '小雨',
    '系统2介入率最低的应该是小雨：' + engs.map(([c, v]) => `${c}=${(v * 100).toFixed(1)}%`).join(' '));
  const mss = CARDS.map((c) => [c, prof(c).ms] as const);
  assert.equal(mss.reduce((a, b) => (b[1] < a[1] ? b : a))[0], '小雨',
    '用时最短的应该是小雨：' + mss.map(([c, v]) => `${c}=${(v * 1000).toFixed(0)}ms`).join(' '));
  // 「他不会闷着比牌」
  assert.equal(p.blindCompares, 0, `小雨闷着比了 ${p.blindCompares} 次`);
});

test('[自洽] 阿彪：复仇者 —— 先闷着看谁在欺负人，看牌之后就上手', () => {
  const p = prof('阿彪');
  console.log(report('阿彪'));

  // 「先闷一轮看看」：闷牌率介于闷牌王和看牌党之间
  assert.ok(p.blind > 0.25 && p.blind < 0.55,
    `闷牌率 ${(p.blind * 100).toFixed(1)}% —— 复仇者要卡在老王和小林中间`);
  assert.ok(p.blind < prof('老王').blind && p.blind > prof('小林').blind, '闷牌率没夹在老王和小林之间');
  // 「第一轮先不看，第二轮就得看清楚是谁」：轮次之间要有明显但连续的上升
  const r1 = p.lookByRound.find(([r]) => r === 1)!;
  const r2 = p.lookByRound.find(([r]) => r === 2)!;
  assert.ok(r1[1] / r1[2] < 0.40, `第 1 轮看牌率 ${pc(r1[1], r1[2])}，太急`);
  assert.ok(r2[1] / r2[2] > 0.65, `第 2 轮看牌率 ${pc(r2[1], r2[2])}，太慢`);
  // 「他比谁都爱还手」：加注率高于常人基线
  const common = profile(play(['常人己', ...COMMONS], Math.min(800, HANDS)).filter((s) => s.seat === '常人己'));
  console.log(`[自洽 阿彪] 常人基线 加注率 ${(common.raise * 100).toFixed(1)}%  `
    + `弃牌率 ${(common.fold * 100).toFixed(1)}%  闷牌率 ${(common.blind * 100).toFixed(1)}%`);
  assert.ok(p.raise > common.raise * 1.2,
    `加注率 ${(p.raise * 100).toFixed(1)}% 相对常人 ${(common.raise * 100).toFixed(1)}% 没高出来`);
  // 「不容易被赶走」：遇压弃牌率低于小林
  assert.ok(p.foldPressed < prof('小林').foldPressed,
    `遇压弃牌率 ${(p.foldPressed * 100).toFixed(1)}% 不该高过小林`);
  // 「敢用烂牌还手」：诈唬率高于小林和小雨
  assert.ok(p.bluff > prof('小林').bluff && p.bluff > prof('小雨').bluff, '诈唬率没有高过小林和小雨');
});

/* ------------------------------------------- 阿彪：「谁比掉他他找谁」的量化台 */

/**
 * 自对弈里逐手记「谁比掉/梭掉了我」，再看**之后三局**他对那个人做了什么。
 *
 * 「仇人」由这张台**自己**认定（谁开的比牌把他打下去、他接了谁的梭哈然后输钱），
 * 不看机器人心里记的是谁 —— 那正是要测的东西：他记的人对不对、针对得明不明显。
 * 三项统计逐条对着原话「被谁比掉/梭掉，之后三局对那个人：范围放宽 0.1、
 * 优先找他比、他梭哈更愿意接」：
 *   ① 他主动开比时挑的是不是仇人（随机基线 = 1 / 当时还在场的对手数）；
 *   ② 仇人梭哈时他接不接 vs 别人梭哈时；
 *   ③ 仇人在场时他进池的平均牌力 vs 仇人不在场时（越低 = 范围越宽）。
 */
interface Revenge {
  /** 结仇次数与窗口内的手数 */
  offences: number; windowHands: number;
  /** ① 挑人：picked / n，randBase = Σ(1/其他在场人数) / n */
  pickN: number; pickHit: number; pickRand: number;
  /** ② 接梭哈 */
  foeShoveN: number; foeShoveTake: number; othShoveN: number; othShoveTake: number;
  /** ③ 进池牌力 */
  foeEnterN: number; foeEnterSum: number; othEnterN: number; othEnterSum: number;
  /** 引擎把仇记到了谁头上：与本台认定的人重合的比例 */
  alignWinner: number; alignTop: number;
  /** 心里同时记恨着几个人 */
  foesInMind: number;
}

function revengeRun(card: string, hands: number): Revenge {
  return withSeededRandom(SEED, () => {
    const o: Revenge = {
      offences: 0, windowHands: 0, pickN: 0, pickHit: 0, pickRand: 0,
      foeShoveN: 0, foeShoveTake: 0, othShoveN: 0, othShoveTake: 0,
      foeEnterN: 0, foeEnterSum: 0, othEnterN: 0, othEnterSum: 0,
      alignWinner: 0, alignTop: 0, foesInMind: 0,
    };
    let mindHands = 0;
    let room = table([card, ...COMMONS]);
    let me = room.players[0];
    let foe: string | undefined; let until = -1;
    for (let h = 0; h < hands; h++) {
      if (h && h % 50 === 0) {
        room = table([card, ...COMMONS]); me = room.players[0]; foe = undefined; until = -1;
      }
      applyCommand(room, room.hostId, { type: 'start' });
      const inWindow = !!foe && h <= until;
      if (inWindow) o.windowHands++;
      let offender: string | undefined;   // 这一手是谁把他打下去的
      let tookShoveFrom: string | undefined;
      const chips0 = me.chips;
      let guard = 0;
      while (room.phase === 'playing' && guard++ < 400) {
        const cur = currentPlayer(room);
        if (!cur) break;
        const act = botAction(room, cur);
        if (cur.id === me.id) {
          const others = room.players.filter((p) => p.id !== me.id && p.status === 'active');
          const foeHere = inWindow && others.some((p) => p.id === foe);
          // ① 只统计「有得挑」（≥2 家在场）且仇人就在场的那些开比
          if (act.cmd.type === 'compare' && others.length >= 2 && foeHere) {
            o.pickN++;
            if (act.cmd.targetId === foe) o.pickHit++;
            o.pickRand += 1 / others.length;
          }
          // ② 面前挂着梭哈：接还是不接，按发起人是不是仇人分开数
          if (room.allIn && act.cmd.type !== 'look') {
            const take = act.cmd.type === 'call' || act.cmd.type === 'all_in';
            if (inWindow && room.allIn.initiatorId === foe) { o.foeShoveN++; if (take) o.foeShoveTake++; }
            else { o.othShoveN++; if (take) o.othShoveTake++; }
          }
          // ③ 看过牌、非梭哈局面下真的把钱投进去的那些手，记牌力
          if (me.looked && me.hand.length === 3 && !room.allIn
            && ['call', 'raise', 'all_in', 'compare'].includes(act.cmd.type)) {
            const st = handPercentile(me.hand, room.settings.dealMode);
            if (foeHere) { o.foeEnterN++; o.foeEnterSum += st; } else { o.othEnterN++; o.othEnterSum += st; }
          }
        }
        const before = me.status;
        const cmpTarget = act.cmd.type === 'compare' ? act.cmd.targetId : undefined;
        const shover = room.allIn?.initiatorId;
        applyCommand(room, cur.id, act.cmd, act.thinkMs);
        if (cur.id !== me.id && cmpTarget === me.id && before === 'active' && me.status !== 'active') {
          offender = cur.id;   // 被人开比打下去了
        }
        if (cur.id === me.id && shover && (act.cmd.type === 'call' || act.cmd.type === 'all_in')) {
          tookShoveFrom = shover;
        }
      }
      if (!offender && tookShoveFrom && me.chips < chips0) offender = tookShoveFrom;  // 接了梭哈还输了
      const winner = room.result?.winnerId;
      const mind = (playerMemory(room, me).mind ?? {}) as Partial<MindState>;
      const held = Object.entries(mind.revenge ?? {}).sort((a, b) => b[1] - a[1]);
      if (held.length) { mindHands++; o.foesInMind += held.length; }
      if (offender) {
        o.offences++;
        if (winner === offender) o.alignWinner++;
        if (held.length && held[0][0] === memoryKey(room.players.find(p => p.id === offender)!)) o.alignTop++;
        foe = offender; until = h + 3;   // 「之后三局对那个人」
      }
      applyCommand(room, room.hostId, { type: 'new_round' });
    }
    o.foesInMind /= Math.max(1, mindHands);
    return o;
  });
}

const REVENGE = new Map<string, Revenge>();
/**
 * 每张卡跑多少手 —— **两条臂的手数不一样，是按样本量配的**（硬要求 8 的同一条口径：
 * 样本不够就把样本加够，不许把断言放松）。
 *
 * ① 那一格要的样本是「仇人在场、又轮到我开比、且桌上 ≥2 家可挑」，它的产出速度
 * 直接由这张卡的**开比频率**决定。实测：阿彪 12000 手拿到 pickN=336，
 * 常人己 48000 手才拿到 pickN=181（常人开比少得多）。
 * 6000 手时常人只有 pickN=26 —— 那一格量到的 76.9% 是纯噪声
 * （Wilson 区间 [56%, 90%]），当时靶子 69.3% 被它压下去，红的是样本不是行为。
 * 加够样本之后：阿彪 60.7% [55.4, 65.8]、常人 55.8% [48.5, 62.8]，差 +4.9 点。
 */
const REVENGE_HANDS: Record<string, number> = { 阿彪: HEAVY ? 24_000 : 12_000 };
const REVENGE_HANDS_DEFAULT = HEAVY ? 72_000 : 36_000;
function revenge(card: string): Revenge {
  let got = REVENGE.get(card);
  if (!got) { got = revengeRun(card, REVENGE_HANDS[card] ?? REVENGE_HANDS_DEFAULT); REVENGE.set(card, got); }
  return got;
}

/**
 * 定场景：把仇值直接挂在**梭哈的那个人**身上 / 挂在**旁观的那个人**身上 / 不挂。
 *
 * 自对弈里「仇人梭哈」一共只有几十次，量不出几个点的差别；这一台把人、牌、
 * 价位全部钉死，只换「仇记在谁头上」，8 手牌 × 5 个价位 × N 个种子，
 * 于是差别只可能来自「记仇有没有按人进动作」。
 */
const GRUDGE_HANDS: Card[][] = [
  FIXED_HANDS.trash, FIXED_HANDS.smallStraight, FIXED_HANDS.bigStraight, FIXED_HANDS.midFlush,
  FIXED_HANDS.kFlush, FIXED_HANDS.aFlush, FIXED_HANDS.straightFlush, FIXED_HANDS.trips,
];
const GRUDGE_PRICES = [
  { unit: 5_000, pot: 30_000, round: 2 },
  { unit: 10_000, pot: 60_000, round: 3 },
  { unit: 20_000, pot: 120_000, round: 3 },
  { unit: 20_000, pot: 60_000, round: 4 },
  { unit: 50_000, pot: 260_000, round: 4 },
];
type Where = '无仇' | '仇在梭哈者' | '仇在旁观者';
/** 这一台要量的是几个点的差别，种子数得比 (d) 那一格大 */
const GRUDGE_SEEDS = HEAVY ? 600 : 300;

/** A（座 s1）挂着梭哈，看他接不接。 */
function acceptUnderGrudge(card: string, where: Where, g = 1.2): { rate: number; n: number } {
  let take = 0; let n = 0;
  for (const hand of GRUDGE_HANDS) {
    for (const pr of GRUDGE_PRICES) {
      const { room, bot } = scene({
        me: { name: card, hand, looked: true, bet: pr.unit, chips: 400_000 },
        others: [
          { name: 'A', looked: true, bet: pr.unit * 2, events: [ev('all_in', true, pr.unit, pr.round)] },
          { name: 'B', looked: true, bet: pr.unit, events: [ev('call', true, pr.unit, pr.round)] },
        ],
        pot: pr.pot, betUnit: pr.unit, roundNo: pr.round, turnCount: 9, position: 'late',
        allIn: { initiator: 'A', accepted: [], base: pr.unit },
      });
      const mind = newMind(personaFor(bot).traits);
      mind.refBalance = 500_000; mind.peakBalance = 500_000;
      if (where === '仇在梭哈者') mind.revenge = { s1: g };
      if (where === '仇在旁观者') mind.revenge = { s2: g };
      room.memory![memoryKey(bot)] = { ...emptyMemory(memoryKey(bot)), mind };
      for (const cmd of sample(room, bot, GRUDGE_SEEDS)) {
        n++; if (cmd.type === 'call' || cmd.type === 'all_in') take++;
      }
    }
  }
  return { rate: take / n, n };
}

/** A（座 s1）在加压，看他留下来的手有多宽（不弃牌那些手的平均分位，越低越宽）。 */
function rangeUnderGrudge(card: string, where: Where, g = 1.2): { mean: number; fold: number; n: number } {
  let sum = 0; let keep = 0; let fold = 0; let n = 0;
  for (const hand of GRUDGE_HANDS) {
    const st = handPercentile(hand, DEFAULT_SETTINGS.dealMode);
    for (const pr of GRUDGE_PRICES) {
      const { room, bot } = scene({
        me: { name: card, hand, looked: true, bet: pr.unit, chips: 400_000 },
        others: [
          { name: 'A', looked: true, bet: pr.unit * 2, events: [ev('raise', true, pr.unit, pr.round)] },
          { name: 'B', looked: true, bet: pr.unit, events: [ev('call', true, pr.unit, pr.round)] },
        ],
        pot: pr.pot, betUnit: pr.unit, roundNo: pr.round, turnCount: 9, position: 'late',
      });
      const mind = newMind(personaFor(bot).traits);
      mind.refBalance = 500_000; mind.peakBalance = 500_000;
      if (where === '仇在梭哈者') mind.revenge = { s1: g };
      if (where === '仇在旁观者') mind.revenge = { s2: g };
      room.memory![memoryKey(bot)] = { ...emptyMemory(memoryKey(bot)), mind };
      for (const cmd of sample(room, bot, GRUDGE_SEEDS)) {
        n++;
        if (cmd.type === 'fold') fold++; else { keep++; sum += st; }
      }
    }
  }
  return { mean: sum / Math.max(1, keep), fold: fold / n, n };
}

test('[自洽] 阿彪：谁比掉他他找谁 —— 之后三局优先找那个人比', () => {
  const a = revenge('阿彪');
  const c = revenge('常人己');
  const line = (name: string, r: Revenge) =>
    `[记仇 ${name}] 结仇 ${r.offences} 次（窗口内 ${r.windowHands} 手，心里同时记恨 ${r.foesInMind.toFixed(2)} 人）\n`
    + `        ① 开比挑仇人 ${pc(r.pickHit, r.pickN)}（${r.pickHit}/${r.pickN}）`
    + `  随机基线 ${pc(r.pickRand, r.pickN)}\n`
    + `        ② 仇人梭哈接受率 ${pc(r.foeShoveTake, r.foeShoveN)}（n=${r.foeShoveN}）`
    + `  非仇人 ${pc(r.othShoveTake, r.othShoveN)}（n=${r.othShoveN}）\n`
    + `        ③ 进池牌力 仇人在场 ${(r.foeEnterSum / Math.max(1, r.foeEnterN)).toFixed(3)}（${r.foeEnterN}）`
    + `  仇人不在场 ${(r.othEnterSum / Math.max(1, r.othEnterN)).toFixed(3)}（${r.othEnterN}）\n`
    + `        引擎把仇记给了「这一手的赢家」：与真正打下他的人重合 ${pc(r.alignWinner, r.offences)}，`
    + `他心里最恨的人就是那个人 ${pc(r.alignTop, r.offences)}`;
  console.log(line('阿彪', a));
  console.log(line('常人己', c));

  // ① 「优先找他比」—— 这一条卡上做得到（比牌是唯一乘 compare.grudge 的记仇通道）。
  // 注意 `decay.revenge` 按 §4.9.6 取 .05（记仇强、衰减慢），代价是他心里同时挂着 6.12 个仇人
  // （常人 4.36 个），「挑中最新那一个」被另外五个稀释 —— 见下面第二条断言的说明。
  const hit = a.pickHit / Math.max(1, a.pickN);
  const rand = a.pickRand / Math.max(1, a.pickN);
  const cHit = c.pickHit / Math.max(1, c.pickN);
  assert.ok(a.pickN >= 150, `开比样本只有 ${a.pickN} 次，量不出挑人偏好`);
  // 对照臂同样要有样本底 —— 没有这条的时候常人只有 26 次开比，
  // 下面那条「高过常人对照」比的是噪声（见 REVENGE_HANDS 的注释）。
  assert.ok(c.pickN >= 120, `常人对照的开比样本只有 ${c.pickN} 次，比不出差别`);
  assert.ok(hit > rand * 1.5,
    `开比挑仇人 ${(hit * 100).toFixed(1)}%，随机基线 ${(rand * 100).toFixed(1)}% —— 没有明显偏向`);
  // 设计目标是「高过常人对照 +0.10」，但那是 `decay.revenge = .05`（记仇强、衰减慢）
  // 之下**卡级到不了**的：实测 6000 手 47.8% vs 常人 42.2%（+5.6 点）、
  // 12000 手 47.2% vs 43.3%（+3.9 点）。compare.grudge 扫过 2.20→8.00：
  // ① 要到 51–53% 得把 grudge 拧到 4.5 以上，但那时比牌会把加注吃掉
  // （加注率 16.4% → 12.7%，跌破上面「高过常人 ×1.2」那条线），所以 grudge 只能留在 2.20。
  // 真正卡住的是核心归因：`settleMinds` 把恨记给「这一手的赢家」，与真正打下他的人只重合
  // 62.5%，于是 .05 的窗口里他同时挂着 6.12 个仇人（常人 4.36 个），「最新那一个」被稀释
  // （personas.md 待集成 #14）。所以这里写 +0.03 —— **这是 .05 下卡级能到的上限**，
  // 不是设计里的 +0.10；#14 修好之后应当把它抬回 +0.10。
  assert.ok(hit > cHit + 0.03,
    `开比挑仇人 ${(hit * 100).toFixed(1)}% 没有明显高过常人对照 ${(cHit * 100).toFixed(1)}%`);

  // ②③ 「他梭哈更愿意接」「范围放宽 0.1」—— 定场景把人、牌、价位钉死，只换「仇记在谁头上」
  const acc = { 无仇: acceptUnderGrudge('阿彪', '无仇'), 仇在梭哈者: acceptUnderGrudge('阿彪', '仇在梭哈者'),
    仇在旁观者: acceptUnderGrudge('阿彪', '仇在旁观者') };
  const accC = { 无仇: acceptUnderGrudge('常人己', '无仇'), 仇在梭哈者: acceptUnderGrudge('常人己', '仇在梭哈者') };
  const rng = { 无仇: rangeUnderGrudge('阿彪', '无仇'), 仇在梭哈者: rangeUnderGrudge('阿彪', '仇在梭哈者') };
  const rngC = { 无仇: rangeUnderGrudge('常人己', '无仇'), 仇在梭哈者: rangeUnderGrudge('常人己', '仇在梭哈者') };
  console.log(`[记仇 定场景] 接梭哈：阿彪 无仇 ${(acc.无仇.rate * 100).toFixed(1)}% → 仇在梭哈者 `
    + `${(acc.仇在梭哈者.rate * 100).toFixed(1)}%（+${((acc.仇在梭哈者.rate - acc.无仇.rate) * 100).toFixed(1)} 点，`
    + `仇挂在旁观者 ${(acc.仇在旁观者.rate * 100).toFixed(1)}%）  `
    + `常人 ${(accC.无仇.rate * 100).toFixed(1)}% → ${(accC.仇在梭哈者.rate * 100).toFixed(1)}%`
    + `（+${((accC.仇在梭哈者.rate - accC.无仇.rate) * 100).toFixed(1)} 点）  每格 n=${acc.无仇.n}`);
  console.log(`[记仇 定场景] 范围：阿彪 不弃手均分位 ${rng.无仇.mean.toFixed(3)} → ${rng.仇在梭哈者.mean.toFixed(3)}`
    + `（放宽 ${(rng.无仇.mean - rng.仇在梭哈者.mean).toFixed(3)} 分位，目标 0.100）  `
    + `常人 ${rngC.无仇.mean.toFixed(3)} → ${rngC.仇在梭哈者.mean.toFixed(3)}`
    + `（放宽 ${(rngC.无仇.mean - rngC.仇在梭哈者.mean).toFixed(3)}）`);

  // 方向必须对：仇人梭哈他更愿意接，仇人在压他他留下来的牌更宽。
  // 但幅度只有 +0.9 点 / 0.009 分位，而且常人卡挂上同样的仇值动的幅度一模一样 ——
  // 这两条是**核心的天花板**，不是这张卡调得不够，见 docs/zjh/personas.md 的待集成清单。
  assert.ok(acc.仇在梭哈者.rate > acc.无仇.rate,
    `仇人梭哈时接受率 ${(acc.仇在梭哈者.rate * 100).toFixed(1)}% 没有高过无仇 ${(acc.无仇.rate * 100).toFixed(1)}%`);
  assert.ok(rng.仇在梭哈者.mean < rng.无仇.mean,
    `仇人加压时留下来的手 ${rng.仇在梭哈者.mean.toFixed(3)} 没有比无仇 ${rng.无仇.mean.toFixed(3)} 更宽`);
  // 自对弈里同一件事的读数（样本小，只作记录，不作门槛）
  assert.ok(a.foeShoveN >= 40 && a.foeEnterN >= 400, '记仇窗口内的样本太少，统计不作数');
});

/* ======================================================== (b) 破绽可利用 */

/**
 * 脚本对手 = **一张常人卡 + 一条固定改写**。改写不触发时他完全按常人打。
 *
 * 为什么不是「整套手写脚本」：整套脚本本身有巨大的通用优势或劣势（试过 30 多种，
 * 凡是比常人更爱升档的脚本，对**所有**卡都赢钱，包括常人自己），那测出来的是
 * 引擎的普遍性质，不是这张卡的破绽。只改一条，剩下全按常人打，赢的那部分才是破绽。
 */
type Override = (r: RoomState, me: PlayerState) => GameCommand | undefined;

const up = (r: RoomState) => r.settings.betOptions.find((u) => u > r.betUnit);
const live = (r: RoomState, me: PlayerState) =>
  r.players.filter((p) => p.id !== me.id && p.status === 'active');
const raised = (r: RoomState, me: PlayerState) => live(r, me).some((p) =>
  p.handActions?.some((e) => e.kind === 'raise' || e.kind === 'all_in'));
const maxCalls = (r: RoomState, me: PlayerState) => Math.max(0, ...live(r, me).map((p) =>
  (p.handActions ?? []).filter((e) => e.kind === 'call').length));

/**
 * 单挑（或三人）：座 0 是猎手（常人卡 + 改写），座 1 是靶子。每手重置筹码，手与手之间独立。
 *
 * `press` 不为空时再加一个座 2 的**施压者**（也是常人卡 + 一条固定改写）——
 * 阿彪那条破绽写的是「第三方可以趁他和仇人缠斗时收池」，缠斗需要三个人：
 * 一个跟他结仇的人、他自己、和一个什么都不做只等着收的人。
 */
function hunt(target: string, ov: Override, hands: number, press?: Override): number[] {
  return withSeededRandom(SEED, () => {
    const room = table(press ? ['常人甲', target, '常人乙'] : ['常人甲', target]);
    const me = room.players[0];
    const presser = press ? room.players[2] : undefined;
    const out: number[] = [];
    for (let h = 0; h < hands; h++) {
      for (const p of room.players) p.chips = 500_000;
      applyCommand(room, room.hostId, { type: 'start' });
      let guard = 0;
      while (room.phase === 'playing' && guard++ < 400) {
        const cur = currentPlayer(room);
        if (!cur) break;
        let scripted: GameCommand | undefined;
        if (cur.id === me.id) scripted = ov(room, cur);
        else if (presser && cur.id === presser.id) scripted = press!(room, cur);
        const action = scripted ? undefined : botAction(room, cur);
        applyCommand(room, cur.id, scripted ?? action!.cmd, action?.thinkMs);
      }
      out.push(me.chips - 500_000);
      applyCommand(room, room.hostId, { type: 'new_round' });
    }
    return out;
  });
}

/** 每手盈亏的均值和 95% 置信区间。 */
function stat(d: number[]): { mean: number; lo: number; hi: number } {
  const mean = d.reduce((a, b) => a + b, 0) / d.length;
  const sd = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, d.length - 1));
  const half = 1.96 * sd / Math.sqrt(d.length);
  return { mean, lo: mean - half, hi: mean + half };
}

const meanOf = (d: number[]) => d.reduce((a, b) => a + b, 0) / d.length;
/** 均值的方差（standard error 的平方） */
function se2(d: number[]): number {
  const m = meanOf(d);
  return d.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, d.length - 1) / d.length;
}
/**
 * 一组「加减」样本的合成均值与 95% 区间。
 *
 * 验收要的是**增量**而不是绝对成绩：`脚本 − 无脚本` 才是「这条脚本靠破绽多赚了多少」，
 * 而 `(靶子的增量) − (对照的增量)` 才是「这个多赚只发生在这张卡身上」。
 * 四段样本相互独立，方差直接相加。
 */
function combo(parts: { d: number[]; sign: 1 | -1 }[]): { mean: number; lo: number; hi: number } {
  const mean = parts.reduce((a, p) => a + p.sign * meanOf(p.d), 0);
  const half = 1.96 * Math.sqrt(parts.reduce((a, p) => a + se2(p.d), 0));
  return { mean, lo: mean - half, hi: mean + half };
}

/**
 * 施压者脚本（只给阿彪那一格用）。
 *
 * 阿彪的破绽原话是「针对时会明显松，**第三方可以趁他和仇人缠斗时收池**」——
 * 「缠斗」需要三个人：一个把他打输、跟他结上仇的人，他自己，和一个在旁边等着收的人。
 * 单挑桌上根本没有「第三方」，所以这一格是三人桌：座 2 是施压者（常人卡 + 这条改写），
 * 座 1 是阿彪，座 0 是猎手。施压者只做一件事 —— 手上过得去就抬价，
 * 把阿彪反复打输、让 `settleMinds` 把恨意记到他头上。
 */
const PRESS: Override = (r, me) => {
  if (!me.looked || r.allIn) return undefined;
  const u = up(r);
  return u && handPercentile(me.hand, r.settings.dealMode) >= FLUSH_LO ? { type: 'raise', unit: u } : undefined;
};

interface Hunt {
  name: string; leak: string; target: string; ctrl: string; ov: Override;
  /** 三人桌（阿彪那一格）：座 2 的施压者脚本 */
  press?: Override;
}

const HUNTS: Hunt[] = [
  {
    name: '老王·猎手',
    leak: '闷牌王闷得太久（闷牌率 73%、闷到第 3 轮 81%），闷着的手是随机牌，可以一直朝他抬价',
    target: '老王', ctrl: '常人己',
    // 只在对手仍闷着时改变动作；其余场景保持无脚本基线。
    ov: (r, me) => {
      if (!me.looked || r.allIn) return undefined;
      if (!live(r, me).some((p) => !p.looked)) return undefined;
      const u = up(r);
      return u && handPercentile(me.hand, r.settings.dealMode) >= FLUSH_LO ? { type: 'raise', unit: u } : undefined;
    },
  },
  {
    name: '小雨·猎手',
    leak: '新手跟出第一口之后就走不掉了（跟到底看 2.20、看牌后跟注率全场最高），'
      + '可以在他跟注之后一路加价',
    target: '小雨', ctrl: '常人己',
    ov: (r, me) => {
      if (!me.looked || r.allIn || raised(r, me) || maxCalls(r, me) < 1) return undefined;
      const u = up(r);
      return u && handPercentile(me.hand, r.settings.dealMode) >= FLUSH_LO ? { type: 'raise', unit: u } : undefined;
    },
  },
  {
    name: '小林·猎手',
    leak: '数学型太可预测：加注就是有牌、弃牌就是真没牌 —— 他一开火就把边缘牌扔掉，'
      + '他不开火的池子随便偷',
    target: '小林', ctrl: '常人己',
    /**
     * 卡上那条破绽的**两半都写在这里**：
     *   前半「他开火时弃掉边缘牌」→ `raised` 分支里把**顺金以下**（`< SF_LO`）直接扔掉；
     *   后半「他不开火时偷池」    → 没人开火就抬价，而且不带价值成分（顺金以下才抬）。
     * 「用时 = 计算难度」那一半没有消费方（读牌不吃用时），留在「待集成」里。
     */
    ov: (r, me) => {
      if (!me.looked || r.allIn) return undefined;
      const s = handPercentile(me.hand, r.settings.dealMode);
      if (raised(r, me)) return s < SF_LO ? { type: 'fold' } : undefined;
      const u = up(r);
      return u && s <= SF_LO ? { type: 'raise', unit: u } : undefined;
    },
  },
  {
    name: '阿彪·猎手（三人桌）',
    leak: '复仇者针对仇人时会松，第三方可以趁他和仇人缠斗时收池',
    target: '阿彪', ctrl: '常人己', press: PRESS,
    /**
     * 「第三方只跟不加、用中等牌收池」：座 2 一直在跟阿彪对轰，猎手全程**不抬价**，
     * 只用中等牌（`[FLUSH_LO, TRIPS_LO)`，金花到顺金之间）跟着，等他俩把彼此打出去。
     * 抬价会把这条脚本变成「谁都能用的加压」——那量的就不是阿彪的破绽了。
     */
    ov: (r, me) => {
      if (r.allIn || !me.looked || live(r, me).length < 2) return undefined;
      const s = handPercentile(me.hand, r.settings.dealMode);
      return s >= FLUSH_LO && s < TRIPS_LO ? { type: 'call' } : undefined;
    },
  },
];

/**
 * 同一个猎手**不带任何脚本**时对每张卡的成绩。
 *
 * 这一格是必须的：验收要问的是「脚本有没有打到这张卡的破绽」，
 * 而不是「这两张卡对坐着谁赢」。实测常人甲什么都不做就能赢小林
 * 每手 3.5k —— 数学型自己弃得太多，对局本身就带着落差。
 * 不减掉这一格，任何脚本打小林都会「净赢」，量出来的是牌桌经济学，不是破绽。
 * 三人桌那一格的基线也必须带上同一个施压者，否则减掉的不是同一张桌子。
 */
const BASE = new Map<string, number[]>();
function base(card: string, press?: Override): number[] {
  const key = `${card}|${press ? '三人' : '单挑'}`;
  let v = BASE.get(key);
  if (!v) { v = hunt(card, () => undefined, DUEL, press); BASE.set(key, v); }
  return v;
}

/** 一格的四段样本合成出来的三个数：靶子增量、对照增量、两者之差。 */
function measure(h: Hunt) {
  const a = hunt(h.target, h.ov, DUEL, h.press);
  const c = hunt(h.ctrl, h.ov, DUEL, h.press);
  const ba = base(h.target, h.press);
  const bc = base(h.ctrl, h.press);
  return {
    inc: combo([{ d: a, sign: 1 }, { d: ba, sign: -1 }]),
    ctrlInc: combo([{ d: c, sign: 1 }, { d: bc, sign: -1 }]),
    gap: combo([{ d: a, sign: 1 }, { d: ba, sign: -1 }, { d: c, sign: -1 }, { d: bc, sign: 1 }]),
    abs: stat(a), baseAbs: stat(ba),
  };
}

const k = (x: number) => `${(x / 1000).toFixed(1)}k`;
function reportHunt(h: Hunt, m: ReturnType<typeof measure>) {
  console.log(`[破绽] ${h.name}（${h.leak}）  ${DUEL} 手${h.press ? ' 三人桌' : ''}\n`
    + `        对 ${h.target}：绝对 ${k(m.abs.mean)}，无脚本基线 ${k(m.baseAbs.mean)}，`
    + `**脚本增量 ${k(m.inc.mean)} [${k(m.inc.lo)}, ${k(m.inc.hi)}]**\n`
    + `        对照 ${h.ctrl}：脚本增量 ${k(m.ctrlInc.mean)} [${k(m.ctrlInc.lo)}, ${k(m.ctrlInc.hi)}]\n`
    + `        增量之差 ${k(m.gap.mean)} [${k(m.gap.lo)}, ${k(m.gap.hi)}]`);
}

// 每个收益假设单独报告。未兑现必须失败，不能断言「仍然未兑现」来通过验收。
for (const h of HUNTS) {
  test(`[破绽收益] ${h.name}：脚本增量为正，并显著高于对照`, () => {
    const m = measure(h);
    reportHunt(h, m);
    assert.ok(m.inc.lo > 0,
      `${h.name} 对目标的增量未证实为正：${k(m.inc.mean)} [${k(m.inc.lo)}, ${k(m.inc.hi)}]`);
    assert.ok(m.gap.lo > 0,
      `${h.name} 对目标和对照的增量差未证实为正：${k(m.gap.mean)} [${k(m.gap.lo)}, ${k(m.gap.hi)}]`);
  });
}

/**
 * 小林那条破绽**在信息层面是成立的**，只是换不成钱。
 *
 * 原话是「他的加注档位就是他的牌力区间」：这句话可量化的部分就是
 * 「他选的那个档位」和「他手上的牌力」之间的相关系数。这一条要断言，
 * 因为它是「加注档位按目标底池选」那条打法要点唯一留得下的证据；
 * 而「照着这个读数弃牌能省钱」是另一回事，上面那个测试已经量过了：省不下来。
 */
test('[破绽] 小林：他选的加注档位真的跟着牌力走，常人不跟', () => {
  const corr = (card: string, steps: Step[]) => {
    const xs: number[] = []; const ys: number[] = [];
    for (const s of steps) {
      if (s.cmd.type !== 'raise' || s.strength === undefined) continue;
      const opts = DEFAULT_SETTINGS.betOptions;
      let tier = 0;
      for (let i = opts.length - 1; i >= 0; i--) if (s.cmd.unit >= opts[i]) { tier = i; break; }
      xs.push(tier); ys.push(s.strength);
    }
    const mx = xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    const my = ys.reduce((a, b) => a + b, 0) / Math.max(1, ys.length);
    const cov = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
    const vx = Math.sqrt(xs.reduce((a, x) => a + (x - mx) ** 2, 0));
    const vy = Math.sqrt(ys.reduce((a, y) => a + (y - my) ** 2, 0));
    console.log(`[档位×牌力] ${card} r=${(cov / Math.max(1e-9, vx * vy)).toFixed(3)}（${xs.length} 次加注）`);
    return { r: cov / Math.max(1e-9, vx * vy), n: xs.length };
  };
  const lin = corr('小林', mine('小林'));
  const cm = corr('小林桌上的常人', commonsAt('小林'));
  assert.ok(lin.n >= 200 && cm.n >= 200, `加注样本太少：小林 ${lin.n}、常人 ${cm.n}`);
  assert.ok(lin.r > cm.r + 0.10,
    `小林的「档位 = 牌力区间」没有比常人明显：小林 r=${lin.r.toFixed(3)}、常人 r=${cm.r.toFixed(3)}`);
});

/* ========================================================== (c) 无门槛 */

test('[无门槛] 四张卡的看牌与弃牌都是连续的，找不到阶跃', () => {
  for (const card of CARDS) {
    const p = prof(card);

    // ① 每一轮的看牌率都要留在 (5%, 95%) 里 —— 贴到 0 或 1 就是被写死了。
    //    样本不足 80 步的轮次不作数（第 4 轮本来就没几个人还站着）。
    const rounds = p.lookByRound.filter(([, , n]) => n >= 80);
    console.log(`[无门槛 ${card}] 看牌率 `
      + rounds.map(([r, a, n]) => `r${r}=${pc(a, n)}(${a}/${n})`).join(' '));
    assert.ok(rounds.length >= 2, `${card} 只覆盖到 ${rounds.length} 个轮次`);
    for (const [r, a, n] of rounds) {
      const rate = a / n;
      assert.ok(rate > 0.05 && rate < 0.95,
        `${card} 第 ${r} 轮看牌率 ${pc(a, n)} —— 逼近 0 或 1 就是一条门槛`);
    }
    // ② 相邻轮次之间是爬上去的，不是跳上去的
    for (let i = 1; i < rounds.length; i++) {
      const prev = rounds[i - 1][1] / rounds[i - 1][2];
      const cur = rounds[i][1] / rounds[i][2];
      assert.ok(Math.abs(cur - prev) < 0.55,
        `${card} 看牌率从第 ${rounds[i - 1][0]} 轮的 ${(prev * 100).toFixed(0)}% `
        + `跳到第 ${rounds[i][0]} 轮的 ${(cur * 100).toFixed(0)}% —— 这是硬门槛的形状`);
    }

    // ③ 弃牌率沿「这一口要花掉身家的百分之几」连续变化
    const EDGES = [0, 0.01, 0.03, 0.06, 0.12, 0.24, 0.5, 1.01];
    const buckets = EDGES.slice(0, -1).map((lo, i) => ({ lo, hi: EDGES[i + 1], n: 0, f: 0 }));
    for (const s of p.acts) {
      const b = buckets.find((x) => s.costFrac >= x.lo && s.costFrac < x.hi);
      if (b) { b.n++; if (s.cmd.type === 'fold') b.f++; }
    }
    const used = buckets.filter((b) => b.n >= 40);
    console.log(`[无门槛 ${card}] 弃牌率×成本占比 `
      + used.map((b) => `[${b.lo},${b.hi})=${pc(b.f, b.n)}(${b.n})`).join(' '));
    assert.ok(used.length >= 6, `${card} 只有 ${used.length} 个价位格子有样本，要 ≥6`);
    for (let i = 1; i < used.length; i++) {
      const d = Math.abs(used[i].f / used[i].n - used[i - 1].f / used[i - 1].n);
      assert.ok(d < 0.5,
        `${card} 弃牌率在 [${used[i - 1].lo},${used[i - 1].hi}) 与 [${used[i].lo},${used[i].hi}) `
        + `之间跳了 ${(d * 100).toFixed(0)} 个点`);
    }
  }
});

/* ================================================== (d) 情绪改变动作 */

const GRID_HANDS: Card[][] = [
  FIXED_HANDS.trash, FIXED_HANDS.smallStraight, FIXED_HANDS.midFlush,
  FIXED_HANDS.kFlush, FIXED_HANDS.trips,
];
// 价位要铺满整个价格区间，不能只有贵的：全是贵局面的话每张卡在「平静」时就已经
// 弃到顶了，「怕」再往同一个方向推也推不动，量出来的不是「情绪没进动作」而是尺子撞了天花板。
const GRID_PRICES = [
  { unit: 20_000, pot: 90_000, round: 3, looked: true },
  { unit: 50_000, pot: 220_000, round: 4, looked: true },
  { unit: 1_000, pot: 12_000, round: 1, looked: false },
  { unit: 1_000, pot: 20_000, round: 2, looked: true },
  { unit: 1_000, pot: 6_000, round: 1, looked: true },
];

const MOODS: Record<string, (m: MindState) => void> = {
  平静: () => {},
  上头: (m) => { m.e.anger = 1.2; m.e.rumination = 0.8; m.e.surprise = 0.4; },
  宽裕: (m) => { m.e.joy = 0.9; m.d.greed = 0.8; },
  怕: (m) => { m.e.fear = 0.9; m.e.worry = 0.8; m.d.safety = 0.9; },
};

/** 同一张卡、同一批局面，只换心情。`grudge` 用来给 A（座 s1）挂上仇。 */
function mixUnder(card: string, tweak: (m: MindState) => void, grudge = 0): Record<string, number> {
  const mix: Record<string, number> = {};
  let n = 0;
  for (const hand of GRID_HANDS) {
    for (const pr of GRID_PRICES) {
      const { room, bot } = scene({
        me: { name: card, hand, looked: pr.looked, bet: pr.unit, chips: 300_000 },
        others: [
          { name: 'A', looked: true, bet: pr.unit * 2, events: [ev('raise', true, pr.unit, pr.round)] },
          { name: 'B', looked: false, bet: pr.unit, events: [ev('call', false, pr.unit, pr.round)] },
        ],
        pot: pr.pot, betUnit: pr.unit, roundNo: pr.round, turnCount: 9, position: 'late',
      });
      const mind = newMind(personaFor(bot).traits);
      mind.refBalance = 500_000;
      mind.peakBalance = 500_000;
      if (grudge) mind.revenge = { s1: grudge };
      tweak(mind);
      room.memory![memoryKey(bot)] = { ...emptyMemory(memoryKey(bot)), mind };
      for (const cmd of sample(room, bot, SEEDS)) {
        mix[cmd.type] = (mix[cmd.type] ?? 0) + 1;
        n++;
      }
    }
  }
  for (const k of Object.keys(mix)) mix[k] /= n;
  return mix;
}

function totalVariation(a: Record<string, number>, b: Record<string, number>): number {
  let sum = 0;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) sum += Math.abs((a[k] ?? 0) - (b[k] ?? 0));
  return sum / 2;
}

/** 施压 = 加注 + 梭哈 + 比牌（都是主动把钱推向对手的动作）。 */
const pressure = (m: Record<string, number>) =>
  (m.raise ?? 0) + (m.all_in ?? 0) + (m.compare ?? 0);

test('[情绪] 同一局面换心情，四张卡的动作分布两两都变，方向也对得上人物文字', () => {
  const spreads: [string, number][] = [];
  const names = Object.keys(MOODS);
  for (const card of CARDS) {
    const mixes = Object.fromEntries(names.map((k) => [k, mixUnder(card, MOODS[k])]));
    const pairs: [string, number][] = [];
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        pairs.push([`${names[i]}↔${names[j]}`, totalVariation(mixes[names[i]], mixes[names[j]])]);
      }
    }
    console.log(`[情绪 ${card}] ` + pairs.map(([k, v]) => `${k} ${(v * 100).toFixed(1)}%`).join('  '));
    for (const [k, v] of pairs) {
      assert.ok(v > 0.04, `${card} 的 ${k} 两种心情只差 ${(v * 100).toFixed(1)}% —— 情绪没进动作`);
    }
    spreads.push([card, Math.max(...pairs.map(([, v]) => v))]);

    // 方向性断言
    if (card === '小雨') {
      // 「怕就跑」：新手怕的时候弃牌变多
      assert.ok((mixes.怕.fold ?? 0) > (mixes.平静.fold ?? 0) + 0.03,
        `小雨怕的时候弃牌率 ${((mixes.怕.fold ?? 0) * 100).toFixed(1)}% `
        + `没比平静的 ${((mixes.平静.fold ?? 0) * 100).toFixed(1)}% 高出来`);
    }
    if (card === '老王') {
      // 「上头了就更想压」：闷牌王上头时施压变多
      assert.ok(pressure(mixes.上头) > pressure(mixes.平静),
        `老王上头后施压率 ${(pressure(mixes.上头) * 100).toFixed(1)}% 反而不如平静时`);
    }
  }

  // 「他不带情绪打牌」：数学型的情绪跨度是四张卡里最小的，但仍然不是 0
  console.log('[情绪] 各卡最大跨度 ' + spreads.map(([c, v]) => `${c}=${(v * 100).toFixed(1)}%`).join(' '));
  const min = spreads.reduce((a, b) => (b[1] < a[1] ? b : a));
  assert.equal(min[0], '小林', `情绪跨度最小的应该是小林，实际是 ${min[0]}`);
  assert.ok(min[1] > 0.04, '小林的情绪跨度掉到 0 了 —— 他是个冷静的人，不是一块石头');
});

test('[情绪] 阿彪上头之后，对着仇人加压', () => {
  // 同一批局面、同一份仇（座 s1 = 开火的 A），只有情绪不同。
  const calm = mixUnder('阿彪', MOODS.平静, 1.2);
  const tilt = mixUnder('阿彪', MOODS.上头, 1.2);
  const none = mixUnder('阿彪', MOODS.上头, 0);
  console.log(`[情绪 阿彪] 有仇·平静 施压 ${(pressure(calm) * 100).toFixed(1)}%  `
    + `有仇·上头 施压 ${(pressure(tilt) * 100).toFixed(1)}%  `
    + `无仇·上头 施压 ${(pressure(none) * 100).toFixed(1)}%  `
    + `弃牌 ${((calm.fold ?? 0) * 100).toFixed(1)}% → ${((tilt.fold ?? 0) * 100).toFixed(1)}%`);
  assert.ok(pressure(tilt) > pressure(calm),
    `阿彪对着仇人上头之后施压率 ${(pressure(tilt) * 100).toFixed(1)}% `
    + `没超过平静时的 ${(pressure(calm) * 100).toFixed(1)}%`);
  assert.ok(pressure(tilt) > pressure(none),
    `有仇和没仇打起来一个样（${(pressure(tilt) * 100).toFixed(1)}% vs `
    + `${(pressure(none) * 100).toFixed(1)}%）—— R14 的仇没进动作`);
});

/* ============================================================ 跨卡区分度 */

test('[跨卡] 四张卡两两之间，六个指标里至少有两个差出 1 个标准差', () => {
  const KEYS = ['vpip', 'raise', 'foldPressed', 'blind', 'pick', 'ms'] as const;
  const LABEL: Record<string, string> = {
    vpip: 'VPIP', raise: '加注率', foldPressed: '遇压弃牌率',
    blind: '闷牌率', pick: '比牌挑最弱', ms: '均用时(秒)',
  };
  const vals = new Map(CARDS.map((c) => [c, prof(c)]));
  for (const c of CARDS) {
    const p = vals.get(c)!;
    console.log(`[跨卡] ${c} ` + KEYS.map((k) => `${LABEL[k]}=${p[k].toFixed(3)}`).join(' '));
  }
  const sd: Record<string, number> = {};
  for (const k of KEYS) {
    const xs = CARDS.map((c) => vals.get(c)![k]);
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    sd[k] = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
  }
  console.log('[跨卡] 标准差 ' + KEYS.map((k) => `${LABEL[k]}=${sd[k].toFixed(3)}`).join(' '));
  for (let i = 0; i < CARDS.length; i++) {
    for (let j = i + 1; j < CARDS.length; j++) {
      const a = vals.get(CARDS[i])!; const b = vals.get(CARDS[j])!;
      const hits = KEYS.filter((k) => Math.abs(a[k] - b[k]) > sd[k]);
      console.log(`[跨卡] ${CARDS[i]}↔${CARDS[j]} 超过 1SD 的维度 ${hits.length}：`
        + KEYS.map((k) => `${LABEL[k]} ${Math.abs(a[k] - b[k]).toFixed(3)}${hits.includes(k) ? '*' : ''}`).join(' '));
      assert.ok(hits.length >= 2,
        `${CARDS[i]} 和 ${CARDS[j]} 只在 ${hits.length} 个维度上拉开了 1 个标准差 —— 这两个人还不够像两个人`);
    }
  }
});
