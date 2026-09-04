/**
 * `shared/mind/` 的验收（设计文档 §4.10.4，外加 §4.9.4 里领域无关的那几条）。
 *
 * 这个文件里**一张牌都没有**。它证明的是同一套「人」可以离开牌桌：
 * 一个极简的交易领域，用同一个 `decide()`、同一张常人特征表跑起来，
 * 并且复现出损失厌恶、连输连赢、被打疼后上头、系统 2 疲劳这些人味。
 * 牌桌那边的验收在 `tests/zjh-mind.test.ts`。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  type Appraisal, type Channels, type CoarseFeatures, type Deliberation,
  type DomainAdapter, type Facts, type Impulse, type MindState, type Regularity,
  type Scored, type Traits,
  COMMON_TRAITS, REGULARITIES, appraisalToDeltas, baseChannels, clamp01, cloneTraits, decide,
  engageProbability, impressionOf,
  feel, framingBias, newMind, outcomeAppraisal, probWeight, referencePoint,
  setDeliberateProbe, settle,
  situationalChannels, standingOf,
} from '../shared/mind/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIND_DIR = join(HERE, '..', 'shared', 'mind');

/* ------------------------------------------------------ 1. 依赖检查 */

test('§4.10.4-1 import 图：shared/mind/ 不依赖 game.ts / zjh / server', () => {
  const files = readdirSync(MIND_DIR).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length >= 6, `shared/mind/ 只有 ${files.length} 个文件，包没搬全`);
  const offenders: string[] = [];
  for (const f of files) {
    const src = readFileSync(join(MIND_DIR, f), 'utf8');
    // `import ... from '<spec>'`、`export ... from '<spec>'`、`import('<spec>')` 全算
    const specs = [...src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const spec of specs) {
      const bad = /(^|\/)game\.ts$|(^|\/)zjh(\/|$)|(^|\/)sj(\/|$)|(^|\/)server(\/|$)|(^|\/)client(\/|$)/
        .test(spec);
      // 只允许包内相对引用与 node: 内置
      const inPackage = spec.startsWith('./') && !spec.includes('/', 2);
      if (bad || !(inPackage || spec.startsWith('node:'))) offenders.push(`${f} → ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], `shared/mind/ 出现了领域依赖：\n${offenders.join('\n')}`);
});

test('§4.10.3 领域词汇不进通用包（注释除外）', () => {
  // 注释里可以写「不许出现底池」，代码里不行 —— 所以先把注释剥掉再查。
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const banned = ['底池', '单价', '金花', '闷牌', '看牌', '比牌', '梭哈', '轮次', '牌'];
  const hits: string[] = [];
  for (const f of readdirSync(MIND_DIR).filter((x) => x.endsWith('.ts'))) {
    const code = strip(readFileSync(join(MIND_DIR, f), 'utf8'));
    for (const w of banned) if (code.includes(w)) hits.push(`${f}: ${w}`);
  }
  assert.deepEqual(hits, [], `通用包的代码里出现了牌桌词汇：\n${hits.join('\n')}`);
});

test('§4.9.1 改情绪只有一条路：`nudge` / 三个钳位函数之外没有人动存量', () => {
  const strip = (x: string) => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  // `mind.e.anger = …` / `mind.d.safety += …` / `mind.revenge[x] = …` 这一类直接赋值
  const write = /\bmind\.(e|d|revenge)(?:\.\w+|\[[^\]]*\])\s*(?:\+|-|\*|\/)?=[^=]/g;
  const clamps = ['clampEmotion', 'clampDrive', 'clampRevenge'];
  const bad: string[] = [];
  for (const f of readdirSync(MIND_DIR).filter((x) => x.endsWith('.ts'))) {
    // 写入口本身就住在 emotion.ts 里
    if (f === 'emotion.ts') continue;
    for (const line of strip(readFileSync(join(MIND_DIR, f), 'utf8')).split('\n')) {
      if (!write.test(line)) continue;
      write.lastIndex = 0;
      // 唯一放行的写法：值是**水平**不是增量，但钳位仍然走那三个函数之一
      if (clamps.some((c) => line.includes(c))) continue;
      bad.push(`${f}: ${line.trim()}`);
    }
  }
  assert.deepEqual(
    bad, [],
    `这些地方绕过 nudge() 直接改了情绪存量：\n${bad.join('\n')}`,
  );

  // 钳位函数各只有一处定义，边界写死在这里 —— 改边界必须同时改这条测试和文档
  const emotion = readFileSync(join(MIND_DIR, 'emotion.ts'), 'utf8');
  for (const [fn, lo, hi] of [['clampEmotion', '-1', '1'], ['clampDrive', '0', '1'], ['clampRevenge', '0', '1.5']]) {
    const hits = emotion.match(new RegExp(`export const ${fn} = `, 'g')) ?? [];
    assert.equal(hits.length, 1, `${fn} 不是只定义了一次`);
    assert.ok(
      emotion.includes(`export const ${fn} = (v: number) => clamp(v, ${lo}, ${hi});`),
      `${fn} 的边界不是 ${lo}..${hi}`,
    );
  }
});

/* ------------------------------------------- 2. 第二个领域：玩具交易适配器 */

/** 一步只有三种选择：进场加仓 / 观望 / 离场。跟牌一点关系都没有。 */
type Move = 'enter' | 'wait' | 'exit';

interface Tick {
  /** 这笔机会看起来有多好 0..1 */
  edge: number;
  /** 逆势/对手方看起来有多强 0..1 */
  pressure: number;
  /** 现在的资产 */
  balance: number;
  /** 这一笔已经投进去多少（占资产） */
  committed: number;
  /** 这一步还要冒多少（占资产） */
  atRisk: number;
  /** 相对同场其他人的资源位阶 −1..1 */
  rank: number;
  /** 这个品种有多熟 0..1 */
  familiarity: number;
  /** 现在正压着我的那一方（做市商、对手盘…），社会性规律用 */
  counterpartKey?: string;
}

/** 交易领域的事件：一笔平仓。 */
interface Close {
  gain: number; balance: number; expected: number;
  by?: string; exposed: boolean; withdrew: boolean; scale: number;
}

const MOVES: Move[] = ['enter', 'wait', 'exit'];

/**
 * 「场面很安静」的那四项（R12 / R19 的输入）。
 * 单独测某一条规律时把它们按住，免得别的规律跟着一起动。
 */
const QUIET = {
  counterpartDisplay: 0, ownCertainty: 1, ambientHeat: 0, ambientRunaway: 0,
} as const;

function toyChannels(ctx: Tick, mind: MindState, t: Traits): Channels {
  return situationalChannels(baseChannels(mind, t), mind, t, {
    committed: ctx.committed,
    atRisk: ctx.atRisk,
    balance: ctx.balance,
    rank: ctx.rank,
    unknownHeldFor: 0,
    scaleVsLast: 1,
    counterpartKey: ctx.counterpartKey,
    // 玩具领域里这四项也折得出来：对手把姿态做得多足、我自己有多拿得准、
    // 场面多热、有没有人在碾 —— 通用层不知道它们是牌桌还是盘口。
    counterpartDisplay: clamp01(ctx.pressure),
    ownCertainty: clamp01(ctx.edge),
    ambientHeat: clamp01(ctx.pressure * 0.8),
    ambientRunaway: 0,
  }).channels;
}

/**
 * 玩具交易适配器。系统 1 = 「这机会看着行不行 + 我现在什么脾气」；
 * 系统 2 = 概率加权之后真算一笔期望。两边用同一批 key。
 */
function toyAdapter(): DomainAdapter<Tick, Move, Close> {
  return {
    appraise(ev, self): Appraisal {
      const ref = Math.max(1, referencePoint(self, ev.balance));
      return {
        valence: Math.sign(ev.gain),
        magnitude: Math.min(1, Math.abs(ev.gain) / ref),
        expectancy: Math.abs((ev.gain > 0 ? 1 : 0) - ev.expected),
        agency: ev.withdrew ? 'self' : ev.by ? 'other' : 'luck',
        controllability: ev.withdrew ? 0.8 : ev.exposed ? 0.2 : 0.5,
        by: ev.by,
      };
    },
    coarse(ctx, self): CoarseFeatures {
      return {
        selfTier: ctx.edge,
        threatTier: ctx.pressure,
        stakeTier: Math.min(1, ctx.atRisk / 0.2),
        familiarity: ctx.familiarity,
        standing: standingOf(self, ctx.balance),
        counterpartKey: ctx.counterpartKey,
        tags: { committed: ctx.committed },
      };
    },
    intuition(f, mind, t): Impulse<Move> {
      const ch = toyChannels(
        {
          edge: f.selfTier, pressure: f.threatTier, balance: 1,
          committed: f.tags?.committed ?? 0, atRisk: f.stakeTier * 0.2,
          rank: 0, familiarity: f.familiarity, counterpartKey: f.counterpartKey,
        },
        mind, t,
      );
      const scores: Scored<Move>[] = MOVES.map((m) => {
        let s = 0;
        if (m === 'enter') {
          s = -0.55 + f.selfTier * 1.60 - f.threatTier * 0.50 - f.stakeTier * 0.50
            + ch.aggression * 1.00 + ch.looseness * 1.00 + ch.risk * 1.00 + ch.greed * 0.40;
        } else if (m === 'wait') {
          s = 0.10 - ch.looseness * 0.40 + ch.safety * 0.30 + ch.curiosity * 0.20;
        } else {
          s = 0.05 + f.threatTier * 0.60 - f.selfTier * 0.80 + f.stakeTier * 0.50
            - ch.quitThreshold * 1.20 + ch.safety * 0.30;
        }
        return { action: m, key: m, score: s };
      });
      const sorted = [...scores].sort((a, b) => b.score - a.score);
      const gap = sorted[0].score - sorted[1].score;
      return {
        action: sorted[0].action, key: sorted[0].key,
        confidence: Math.max(0, Math.min(1, 0.20 + gap * 2.0)),
        feltStrength: f.selfTier, feltThreat: f.threatTier,
        scores,
      };
    },
    deliberate(ctx, mind, t): Deliberation<Move> {
      const ch = toyChannels(ctx, mind, t);
      const p = probWeight(ctx.edge * (1 - ctx.pressure * 0.4), t.cognition.probWeightAlpha);
      const frame = framingBias(standingOf(mind, ctx.balance), t);
      const scores: Scored<Move>[] = [
        { action: 'enter', key: 'enter', score: p * 2 - 1 - ctx.atRisk + frame + ch.aggression * 0.10 },
        { action: 'wait', key: 'wait', score: 0 },
        { action: 'exit', key: 'exit', score: -ch.quitThreshold * 0.30 },
      ];
      const sorted = [...scores].sort((a, b) => b.score - a.score);
      return {
        best: sorted[0].action, bestKey: sorted[0].key, scores,
        difficulty: Math.max(0, Math.min(1, 1 - Math.abs(sorted[0].score - sorted[1].score) / 0.2)),
      };
    },
    stakes(ctx) {
      return {
        stakes: Math.min(1, ctx.atRisk / 0.2),
        timePressure: 0.2,
        familiarity: ctx.familiarity,
      };
    },
  };
}

/** 一个只由字符串做种的伪随机源：同一个种子永远同一条流。 */
function rngOf(seed: string) {
  return (purpose: string) => {
    let h = 2166136261;
    const s = `${seed}|${purpose}`;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 1_000_003) / 1_000_003;
  };
}

/**
 * 用同一批局面样本跑一遍，返回各动作的占比。
 *
 * 每个样本都从**同一份心情**出发（不把上一步的结果喂回去）：这样比出来的是
 * 「同一个局面下这个人现在什么心情」，不是「谁的手气顺序好」。
 */
function moveMix(
  mind: MindState, t: Traits, n = 1500, tag = 'mix', balance = mind.refBalance || 1000,
): Record<Move, number> {
  const count: Record<Move, number> = { enter: 0, wait: 0, exit: 0 };
  const adapter = toyAdapter();
  for (let i = 0; i < n; i++) {
    const r = rngOf(`${tag}:${i}`);
    const ctx: Tick = {
      edge: r('edge'), pressure: r('pressure') * 0.6, balance,
      committed: r('committed') * 0.3, atRisk: 0.02 + r('risk') * 0.15,
      rank: 0, familiarity: 0.5, counterpartKey: 'mm',
    };
    count[decide(adapter, ctx, mind, t, r).action] += 1;
  }
  return { enter: count.enter / n, wait: count.wait / n, exit: count.exit / n };
}

test('§4.10.4-2 玩具交易适配器：同一个 decide、同一张常人卡，跑得通', () => {
  const mind = newMind(COMMON_TRAITS);
  mind.refBalance = 1000; mind.peakBalance = 1000;
  const d = decide(toyAdapter(), {
    edge: 0.7, pressure: 0.2, balance: 1000, committed: 0.05,
    atRisk: 0.04, rank: 0, familiarity: 0.5,
  }, mind, COMMON_TRAITS, rngOf('smoke'));
  assert.ok(MOVES.includes(d.action), `返回了不认识的动作 ${d.action}`);
  assert.ok(d.thinkMs >= 160, `用时 ${d.thinkMs}ms 不合理`);
  assert.ok(['s1', 's2'].includes(d.trace.system));
  assert.equal(d.trace.impulse.feltStrength, 0.7);
  // decide 不能就地改调用方的状态
  assert.notEqual(d.mind, mind);
});

test('§4.9.1 事件不直接改情绪：走 appraise → 通用映射表 → 情绪增量这一条通道', () => {
  const adapter = toyAdapter();
  // 一笔亮着的仓被「老张」逆势打掉：坏、大、意外（事前觉得七成五会赢）、别人干的
  const ev: Close = {
    gain: -40_000, balance: 160_000, expected: 0.75,
    by: '老张', exposed: true, withdrew: false, scale: 60_000,
  };

  // 两个人：皮薄的（什么都放大）和皮厚的（什么都打折）。**只有 sensitivity 不同。**
  const thin = cloneTraits(COMMON_TRAITS);
  thin.sensitivity = { valence: 1.4, magnitude: 1.4, expectancy: 1.4, agency: 1.4, controllability: 1.4 };
  const thick = cloneTraits(COMMON_TRAITS);
  thick.sensitivity = { valence: 0.4, magnitude: 0.4, expectancy: 0.4, agency: 0.4, controllability: 0.4 };

  const mThin = newMind(thin);
  const mThick = newMind(thick);
  for (const m of [mThin, mThick]) { m.refBalance = 200_000; m.peakBalance = 200_000; }

  const aThin = feel(adapter, ev, mThin, thin);
  const aThick = feel(adapter, ev, mThick, thick);

  // ① 同一件事在两个人眼里是**同一份评价** —— 评价是事实层，不是性格层
  assert.deepEqual(aThin, aThick, '同一个事件被评成了两份不同的评价');

  // ② 同一份评价落到两个人身上，情绪增量必须不同
  assert.ok(
    mThin.e.anger > mThick.e.anger * 1.5,
    `皮薄的怒 ${mThin.e.anger.toFixed(3)} 没有明显高过皮厚的 ${mThick.e.anger.toFixed(3)}`,
  );
  assert.ok(
    mThin.e.rumination > mThick.e.rumination * 1.5,
    `皮薄的思 ${mThin.e.rumination.toFixed(3)} 没有明显高过皮厚的 ${mThick.e.rumination.toFixed(3)}`,
  );
  assert.ok(
    (mThin.revenge['老张'] ?? 0) > (mThick.revenge['老张'] ?? 0) * 1.5,
    '同一次被打疼，两个人记的仇一样多',
  );

  // ③ 起点是一样的（基线相同），所以差别只可能来自映射表读到的 sensitivity
  assert.deepEqual(
    { e: newMind(thin).e, d: newMind(thin).d },
    { e: newMind(thick).e, d: newMind(thick).d },
    '两张卡的情绪基线本来就不同，这条对比不成立',
  );

  // ④ 映射表是通用层的：把同一份评价手写出来（不经过任何领域），
  //    得到的增量与走适配器那条路完全一致 —— 表里没有一个字认识「交易」或「牌」。
  const bare = appraisalToDeltas(aThin, thin);
  const again = newMind(thin);
  again.refBalance = 200_000; again.peakBalance = 200_000;
  feel({ appraise: () => aThin }, ev, again, thin);
  for (const k of Object.keys(bare.e) as (keyof typeof again.e)[]) {
    assert.ok(
      Math.abs((again.e[k] ?? 0) - (newMind(thin).e[k] + (bare.e[k] ?? 0))) < 1e-9,
      `${k} 这一维没有按通用映射表落下去`,
    );
  }
});

test('§4.9.1 结算走的是同一张表：settle 的情绪 = outcomeAppraisal 经过映射表', () => {
  const t = COMMON_TRAITS;
  const o = {
    gain: -30_000, balance: 170_000, expected: 0.7, by: '老张',
    exposed: true, withdrew: false, scale: 50_000,
  };

  // 真的走 settle
  const a = newMind(t);
  a.refBalance = 200_000; a.peakBalance = 200_000;
  settle(a, t, { ...o });

  // 手工重放：衰减 → 同一张表 → 跨局规律。只对比「表」这一段能不能对上：
  // 把评价单独喂给一个只做映射的假适配器，怒的增量必须和 settle 里那一份一致。
  const b = newMind(t);
  b.refBalance = 200_000; b.peakBalance = 200_000;
  const appraisal = outcomeAppraisal({ ...o }, b);
  const deltas = appraisalToDeltas(appraisal, t);
  const c = newMind(t);
  c.refBalance = 200_000; c.peakBalance = 200_000;
  feel({ appraise: () => appraisal }, o, c, t);
  for (const k of Object.keys(deltas.e) as (keyof typeof c.e)[]) {
    assert.ok(
      Math.abs(c.e[k] - (newMind(t).e[k] + (deltas.e[k] ?? 0))) < 1e-9,
      `${k}：结算用的评价没有走通用映射表`,
    );
  }
  // settle 在表之外还叠了 R7/R18/R1，所以只能要求「同号且更大」，不能要求相等
  assert.ok(a.e.anger > 0 && a.e.anger >= c.e.anger - 1e-9, 'settle 的怒比映射表给的还小，说明它走了别的路');
});

test('R1 损失厌恶：落后于参照点之后更难离场（同一批局面）', () => {
  const t = COMMON_TRAITS;
  const flat = newMind(t); flat.refBalance = 1000; flat.peakBalance = 1000;
  const behind = newMind(t); behind.refBalance = 1000; behind.peakBalance = 1000;

  const ch0 = situationalChannels(baseChannels(flat, t), flat, t, {
    committed: 0, atRisk: 0.05, balance: 1000, rank: 0, unknownHeldFor: 0, scaleVsLast: 1,
    ...QUIET,
  });
  const ch1 = situationalChannels(baseChannels(behind, t), behind, t, {
    committed: 0, atRisk: 0.05, balance: 350, rank: 0, unknownHeldFor: 0, scaleVsLast: 1,
    ...QUIET,
  });
  assert.ok(ch1.fired.includes('R1'), '落后于参照点却没触发 R1');
  assert.ok(!ch0.fired.includes('R1'), '站在参照点上不该触发 R1');
  assert.ok(ch1.channels.quitThreshold > ch0.channels.quitThreshold, '落后了反而更容易放手');
  assert.ok(ch1.channels.risk > ch0.channels.risk, '落后了反而更不敢冒险');

  // 行为上：同一批机会、同一个人，只把「现在输着」这一件事改掉 —— 离场率必须下来（追）
  const a = moveMix(flat, t, 1200, 'r1a', 1000);
  const mixBehind = moveMix(behind, t, 1200, 'r1a', 350);
  assert.ok(
    mixBehind.exit < a.exit - 0.02,
    `落后时离场率 ${(mixBehind.exit * 100).toFixed(1)}% 没有明显低于持平时的 ${(a.exit * 100).toFixed(1)}%`,
  );

  // 关掉这条规律，这个人就没有这个毛病 —— 证明系数表真的在管事
  const numb = cloneTraits(t); numb.regularities.R1 = 0;
  const ch2 = situationalChannels(baseChannels(behind, numb), behind, numb, {
    committed: 0, atRisk: 0.05, balance: 350, rank: 0, unknownHeldFor: 0, scaleVsLast: 1,
    ...QUIET,
  });
  assert.ok(Math.abs(ch2.channels.quitThreshold - ch0.channels.quitThreshold) < 1e-9,
    'R1 = 0 的人还是被损失厌恶推了一把');
});

test('R5/R6 连输连赢：三连败之后更松，三连胜之后更凶', () => {
  const t = COMMON_TRAITS;
  const calm = newMind(t); calm.refBalance = 1000; calm.peakBalance = 1000;
  const losing = newMind(t); losing.refBalance = 1000; losing.peakBalance = 1000;
  const winning = newMind(t); winning.refBalance = 1000; winning.peakBalance = 1000;

  let bal = 1000;
  for (let i = 0; i < 4; i++) {
    bal -= 40;
    const tr = settle(losing, t, {
      gain: -40, balance: bal, expected: 0.5, exposed: true, withdrew: false, scale: 40,
    });
    if (i >= 2) assert.ok(tr.fired.includes('R5'), `第 ${i + 1} 连败没有记进 R5`);
  }
  bal = 1000;
  for (let i = 0; i < 4; i++) {
    bal += 40;
    const tr = settle(winning, t, {
      gain: 40, balance: bal, expected: 0.5, exposed: true, withdrew: false, scale: 40,
    });
    if (i >= 2) assert.ok(tr.fired.includes('R6'), `第 ${i + 1} 连胜没有记进 R6`);
  }
  assert.equal(losing.lossStreak, 4);
  assert.equal(winning.winStreak, 4);

  const base = moveMix(calm, t, 1500, 'streak');
  const hot = moveMix(winning, t, 1500, 'streak');
  const tiltish = moveMix(losing, t, 1500, 'streak');
  assert.ok(hot.enter > base.enter + 0.01,
    `连胜后进场率 ${(hot.enter * 100).toFixed(1)}% 没有高于平常 ${(base.enter * 100).toFixed(1)}%`);
  assert.ok(tiltish.enter > base.enter + 0.01,
    `连败后进场率 ${(tiltish.enter * 100).toFixed(1)}% 没有高于平常 ${(base.enter * 100).toFixed(1)}%`);
});

test('R7 被具体的人逆势打疼：怒 / 思 / 报复一起上来，几局之后消下去', () => {
  const t = COMMON_TRAITS;
  const m = newMind(t); m.refBalance = 1000; m.peakBalance = 1000;
  const quiet = newMind(t); quiet.refBalance = 1000; quiet.peakBalance = 1000;

  // 同样大小的一笔亏：一笔是自己主动止损，一笔是被「对手盘 X」在自己笃定会赢时打掉
  settle(quiet, t, {
    gain: -300, balance: 700, expected: 0.2, exposed: false, withdrew: true, scale: 300,
  });
  const bad = settle(m, t, {
    gain: -300, balance: 700, expected: 0.85, exposed: true, withdrew: false, by: 'X', scale: 300,
  });
  assert.ok(bad.fired.includes('R7'), '笃定会赢却被人当场打掉，没有触发 R7');
  assert.ok(m.e.anger > quiet.e.anger + 0.2, `怒只有 ${m.e.anger.toFixed(3)}，没被 bad beat 顶起来`);
  assert.ok(m.e.rumination > quiet.e.rumination, '被打疼之后没有反刍');
  assert.ok((m.revenge.X ?? 0) > 0.2, `对 X 的记仇只有 ${(m.revenge.X ?? 0).toFixed(3)}`);
  assert.ok(bad.surprise > 0.8, `意外程度 ${bad.surprise.toFixed(2)} 不够 —— 事前 0.85 却输了`);

  const peak = m.e.anger;
  const peakGrudge = m.revenge.X ?? 0;
  for (let i = 0; i < 6; i++) {
    settle(m, t, { gain: 0, balance: 700, expected: 0.4, exposed: false, withdrew: true, scale: 10 });
  }
  const grudge = m.revenge.X ?? 0;
  assert.ok(m.e.anger < peak * 0.5, `六局之后怒还有 ${m.e.anger.toFixed(3)}，衰减没生效`);
  // 记仇比情绪消得慢得多（`decay.revenge` 只有 0.15）—— 但必须真的在消
  assert.ok(grudge < peakGrudge * 0.6, `记仇从 ${peakGrudge.toFixed(3)} 只掉到 ${grudge.toFixed(3)}`);
  assert.ok(grudge > 0, '记仇一局就清零了，太干净了');
});

test('R30 自我损耗：意志力用完之后系统 2 就不开了', () => {
  const t = COMMON_TRAITS;
  const adapter = toyAdapter();
  let mind = newMind(t); mind.refBalance = 1000; mind.peakBalance = 1000;
  const engaged: boolean[] = [];
  for (let i = 0; i < 120; i++) {
    const r = rngOf(`burn:${i}`);
    const ctx: Tick = {
      edge: 0.35 + r('edge') * 0.3, pressure: 0.3, balance: 1000,
      committed: 0.1, atRisk: 0.12, rank: 0, familiarity: 0.4, counterpartKey: 'mm',
    };
    const d = decide(adapter, ctx, mind, t, r);
    engaged.push(d.trace.engaged);
    mind = d.mind;   // 不结算 = 意志力不回血
  }
  const first = engaged.slice(0, 30).filter(Boolean).length / 30;
  const last = engaged.slice(-30).filter(Boolean).length / 30;
  assert.ok(first > 0.1, `一开始就只有 ${(first * 100).toFixed(0)}% 开系统 2，测不出损耗`);
  assert.ok(last < first, `后 30 步介入率 ${(last * 100).toFixed(0)}% 没有低于前 30 步 ${(first * 100).toFixed(0)}%`);
  assert.equal(mind.willpower, 0, `意志力还剩 ${mind.willpower}，没被烧干`);

  // 烧干之后结算几局，意志力会回来
  for (let i = 0; i < 4; i++) {
    settle(mind, t, { gain: 5, balance: 1005, expected: 0.5, exposed: false, withdrew: true, scale: 5 });
  }
  assert.ok(mind.willpower >= t.cognition.willpowerRecover * 3, '休息了几局意志力也没回来');
});

/* ---------------------------------------- §4.9.4 双系统（领域无关的那几条） */

test('§4.9.4 上头的人更少开系统 2、更常偏离最优解', () => {
  const t = COMMON_TRAITS;
  const calm = newMind(t); calm.refBalance = 1000; calm.peakBalance = 1000;
  const tilted = newMind(t); tilted.refBalance = 1000; tilted.peakBalance = 1000;
  tilted.e.anger = 0.9; tilted.e.rumination = 0.6; tilted.e.surprise = 0.5;

  const run = (mind: MindState) => {
    const adapter = toyAdapter();
    let s2 = 0, dev = 0, agree = 0;
    const n = 1200;
    for (let i = 0; i < n; i++) {
      const r = rngOf(`dual:${i}`);
      const ctx: Tick = {
        edge: r('edge'), pressure: r('pressure') * 0.6, balance: 1000,
        committed: r('committed') * 0.3, atRisk: 0.02 + r('risk') * 0.15,
        rank: 0, familiarity: 0.5, counterpartKey: 'mm',
      };
      const d = decide(adapter, ctx, mind, t, r);
      if (d.trace.engaged) s2++;
      // 「偏离最优解」= 最终动作 ≠ 系统 2 算出来的最好那个。
      // 离线对照开着，没开系统 2 的那些步也有对照，所以 deviated 不会缺
      assert.notEqual(d.trace.deviated, undefined, '离线对照开着却没有 deviated');
      if (d.trace.deviated) dev++;
      if (!d.trace.engaged && !d.trace.deviated) agree++;
    }
    return { s2: s2 / n, dev: dev / n, agree: agree / n };
  };
  setDeliberateProbe(true);
  let a: ReturnType<typeof run>, b: ReturnType<typeof run>;
  try { a = run(calm); b = run(tilted); } finally { setDeliberateProbe(false); }
  // 纯直觉走对了的步必须存在 —— 否则「偏离」又变回「1 − 介入率」
  assert.ok(a.agree > 0.05 && b.agree > 0.05,
    `没开系统 2 却跟最优解一致的步只有 平静 ${(a.agree * 100).toFixed(1)}% / 上头 ${(b.agree * 100).toFixed(1)}%`);
  assert.ok(b.s2 < a.s2 - 0.05,
    `上头时系统 2 介入率 ${(b.s2 * 100).toFixed(1)}%，平静时 ${(a.s2 * 100).toFixed(1)}% —— 差得不够`);
  assert.ok(b.dev > a.dev,
    `上头时偏离率 ${(b.dev * 100).toFixed(1)}% 没有高于平静时 ${(a.dev * 100).toFixed(1)}%`);
});

test('§4.9.4 needForCognition 高的人偏离最优解更少', () => {
  const thinker = cloneTraits(COMMON_TRAITS);
  thinker.cognition.needForCognition = 0.95;
  thinker.cognition.selfControl = 0.9;
  const gut = cloneTraits(COMMON_TRAITS);
  gut.cognition.needForCognition = 0.05;
  gut.cognition.selfControl = 0.2;

  const run = (t: Traits) => {
    const adapter = toyAdapter();
    let mind = newMind(t); mind.refBalance = 1000; mind.peakBalance = 1000;
    let dev = 0;
    const n = 400;
    for (let i = 0; i < n; i++) {
      const r = rngOf(`nfc:${i}`);
      const ctx: Tick = {
        edge: r('edge'), pressure: r('pressure') * 0.6, balance: 1000,
        committed: r('committed') * 0.3, atRisk: 0.02 + r('risk') * 0.15,
        rank: 0, familiarity: 0.5, counterpartKey: 'mm',
      };
      const d = decide(adapter, ctx, mind, t, r);
      assert.notEqual(d.trace.deviated, undefined, '离线对照开着却没有 deviated');
      if (d.trace.deviated) dev++;
      mind = d.mind;
      // 每一步都当作一小局结算，意志力回血，免得只测出「谁先烧干」
      settle(mind, t, { gain: 0, balance: 1000, expected: 0.5, exposed: false, withdrew: false, scale: 10 });
    }
    return dev / n;
  };
  setDeliberateProbe(true);
  let smart: number, rash: number;
  try { smart = run(thinker); rash = run(gut); } finally { setDeliberateProbe(false); }
  assert.ok(smart < rash - 0.05,
    `爱动脑的人偏离率 ${(smart * 100).toFixed(1)}%，凭感觉的人 ${(rash * 100).toFixed(1)}% —— 没拉开`);
});

test('§4.9.4 用时与系统 2 介入正相关', () => {
  const t = COMMON_TRAITS;
  const adapter = toyAdapter();
  let mind = newMind(t); mind.refBalance = 1000; mind.peakBalance = 1000;
  const s1: number[] = [], s2: number[] = [];
  for (let i = 0; i < 600; i++) {
    const r = rngOf(`ms:${i}`);
    const ctx: Tick = {
      edge: r('edge'), pressure: r('pressure') * 0.6, balance: 1000,
      committed: 0.1, atRisk: 0.02 + r('risk') * 0.15, rank: 0, familiarity: 0.5,
    };
    const d = decide(adapter, ctx, mind, t, r);
    (d.trace.engaged ? s2 : s1).push(d.thinkMs);
    settle(mind, t, { gain: 0, balance: 1000, expected: 0.5, exposed: false, withdrew: false, scale: 10 });
  }
  assert.ok(s1.length > 20 && s2.length > 20, `样本不够：s1=${s1.length} s2=${s2.length}`);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.ok(mean(s2) > mean(s1) * 1.2,
    `深思平均 ${mean(s2).toFixed(0)}ms 没有明显长于直觉 ${mean(s1).toFixed(0)}ms`);
});

/* ------------------------------------- 3. 特征表独立 / 4. 可分析 */

test('§4.10.4-3 新增一个人只写一张 Traits，shared/mind/ 零改动', () => {
  // 「岩石」：怕就跑、不追、不上头。全部由特征表表达，通用包一行都不用改。
  const rock = cloneTraits(COMMON_TRAITS);
  rock.baseline.fear = 0.35;
  rock.baseline.joy = 0.02;
  rock.expression.anger = { aggression: +0.1, quitThreshold: -0.2, tempo: -0.1 };
  rock.expression.fear = { aggression: -0.9, quitThreshold: -1.0, seekInfo: +0.6, tempo: -0.2 };
  rock.regularities = { R1: 0.2, R4: 0.2, R5: 0, R6: 0.3, R13: 0, R21: 0.2 };
  rock.cognition.needForCognition = 0.8;

  const mindA = newMind(COMMON_TRAITS); mindA.refBalance = 1000; mindA.peakBalance = 1000;
  const mindB = newMind(rock); mindB.refBalance = 1000; mindB.peakBalance = 1000;
  const a = moveMix(mindA, COMMON_TRAITS, 1500, 'person');
  const b = moveMix(mindB, rock, 1500, 'person');
  const spread = Math.abs(a.enter - b.enter) + Math.abs(a.wait - b.wait) + Math.abs(a.exit - b.exit);
  assert.ok(spread > 0.10, `两个人的动作分布只差 ${(spread * 100).toFixed(1)}%，等于同一个人`);
  assert.ok(b.enter < a.enter, `岩石的进场率 ${(b.enter * 100).toFixed(1)}% 没有低于常人`);
});

test('§4.10.4-4 trace 能回答「直觉还是深思、被哪条规律推了、当时什么情绪」', () => {
  const t = COMMON_TRAITS;
  const adapter = toyAdapter();
  const mind = newMind(t); mind.refBalance = 1000; mind.peakBalance = 1000;
  settle(mind, t, {
    gain: -300, balance: 700, expected: 0.85, exposed: true, withdrew: false, by: 'X', scale: 300,
  });
  const ctx: Tick = {
    edge: 0.55, pressure: 0.4, balance: 700, committed: 0.25,
    atRisk: 0.12, rank: -0.4, familiarity: 0.5, counterpartKey: 'X',
  };
  const { trace } = decide(adapter, ctx, mind, t, rngOf('trace'), []);
  assert.ok(trace.system === 's1' || trace.system === 's2');
  assert.equal(typeof trace.p2, 'number');
  assert.ok(trace.impulse.key.length > 0);
  assert.ok(trace.fired.length === 0 || trace.fired.every((r) => /^R\d+$/.test(r)));
  assert.ok(trace.emotions.anger > 0, 'trace 没带上「当时的情绪」');
  assert.ok(trace.tilt > 0, 'trace 没带上上头程度');
  assert.ok(typeof trace.willpower === 'number');
  assert.equal(trace.action, trace.system === 's2' && trace.overridden
    ? trace.deliberate?.key : trace.action);

  // 临场规律要能从 situationalChannels 里点名报出来
  const { fired } = situationalChannels(baseChannels(mind, t), mind, t, {
    committed: 0.25, atRisk: 0.12, balance: 700, rank: -0.4,
    unknownHeldFor: 0, scaleVsLast: 1, counterpartKey: 'X', ...QUIET,
  });
  for (const r of ['R1', 'R4', 'R15']) {
    assert.ok(fired.includes(r as never), `这个局面本该触发 ${r}，实际只有 ${fired.join('/')}`);
  }
  // R11「面对大注的怯」在上头的人身上会被怒压住 —— 这是设计里的耦合，不是漏接。
  // 同一个局面换一份平静的心情，它就必须出现。
  const cool = newMind(t); cool.refBalance = 1000; cool.peakBalance = 1000;
  const coolFired = situationalChannels(baseChannels(cool, t), cool, t, {
    committed: 0.25, atRisk: 0.12, balance: 700, rank: -0.4,
    unknownHeldFor: 0, scaleVsLast: 1, counterpartKey: 'X', ...QUIET,
  }).fired;
  assert.ok(coolFired.includes('R11'), `平静时面对 12% 身家的一步也没触发 R11：${coolFired.join('/')}`);
  assert.ok(!fired.includes('R11'), '上头的人居然还在怕大注 —— 怒压恐的耦合没生效');
});

test('§4.10.4-4 给一段事件流能重放出同一条情绪轨迹', () => {
  const t = COMMON_TRAITS;
  const stream: Close[] = [
    { gain: -50, balance: 950, expected: 0.6, exposed: true, withdrew: false, by: 'X', scale: 50 },
    { gain: -80, balance: 870, expected: 0.8, exposed: true, withdrew: false, by: 'X', scale: 80 },
    { gain: 120, balance: 990, expected: 0.55, exposed: true, withdrew: false, scale: 120 },
    { gain: 0, balance: 990, expected: 0.3, exposed: false, withdrew: true, scale: 10 },
  ];
  const replay = () => {
    const m = newMind(t); m.refBalance = 1000; m.peakBalance = 1000;
    return stream.map((o) => { settle(m, t, o); return [m.e.anger, m.e.joy, m.e.fear] as const; });
  };
  const a = replay();
  const b = replay();
  assert.deepEqual(a, b, '同一段事件流重放出了不同的情绪轨迹');
  assert.ok(a[1][0] > a[0][0], '第二次被同一个人打掉，怒没有继续上升');
  assert.ok(a[2][1] > a[1][1], '赢了一笔，喜没有上来');
});

test('R26 概率权重：常人高估小概率、低估中等概率', () => {
  const a = COMMON_TRAITS.cognition.probWeightAlpha;
  assert.ok(probWeight(0.02, a) > 0.02 * 1.5, '小概率没有被高估');
  assert.ok(probWeight(0.5, a) < 0.5, '中等概率没有被低估');
  assert.ok(probWeight(0.5, 1) > 0.49 && probWeight(0.5, 1) < 0.51, 'α = 1 应该是恒等');
});

test('R27 框架效应：落后时「继续」更值钱，领先时更想守住', () => {
  const behind = framingBias(-0.8, COMMON_TRAITS);
  const ahead = framingBias(0.8, COMMON_TRAITS);
  assert.ok(behind > 0 && ahead < 0, `追回 ${behind.toFixed(3)} / 守住 ${ahead.toFixed(3)} 方向反了`);
});

test('p2 公式：赌注越大越想算，唤醒越高越不想算', () => {
  const t = COMMON_TRAITS;
  const m = newMind(t);
  const low = engageProbability(m, t, { stakes: 0.05, timePressure: 0.2, familiarity: 0.5, confidence: 0.5 });
  const high = engageProbability(m, t, { stakes: 0.95, timePressure: 0.2, familiarity: 0.5, confidence: 0.5 });
  assert.ok(high > low + 0.1, `赌注从小到大，介入率 ${low.toFixed(3)} → ${high.toFixed(3)}`);

  const hot = newMind(t); hot.e.anger = 0.9; hot.e.surprise = 0.6; hot.e.joy = 0.3;
  const hotP = engageProbability(hot, t, { stakes: 0.95, timePressure: 0.2, familiarity: 0.5, confidence: 0.5 });
  assert.ok(hotP < high - 0.05, `上头之后介入率 ${hotP.toFixed(3)} 没有低于平静的 ${high.toFixed(3)}`);

  const tired = newMind(t); tired.willpower = 0.2;
  const tiredP = engageProbability(tired, t, { stakes: 0.95, timePressure: 0.2, familiarity: 0.5, confidence: 0.5 });
  assert.ok(tiredP < high - 0.05, `意志力见底后介入率 ${tiredP.toFixed(3)} 没有下来`);
});

/* ------------------------------------------------- 5. 规律表说的话必须是真的 */

/** 递归读一棵目录下所有 .ts 的源码（原样，注释也留着）。 */
function sourcesUnder(dir: string): string {
  let out = '';
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out += sourcesUnder(p);
    else if (e.name.endsWith('.ts')) out += readFileSync(p, 'utf8') + '\n';
  }
  return out;
}

test('§4.10 规律表：wired 说接了的就真的有人消费，说没接的要有理由', () => {
  // 表自己、以及那条把 id 全列一遍的联合类型，都不算数
  const text = sourcesUnder(join(HERE, '..', 'shared'))
    .replace(/export const REGULARITIES[\s\S]*?\n};/, '')
    .replace(/export type Regularity[\s\S]*?;/, '');
  // 真的在跑的代码 = 去掉注释之后剩下的部分
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  const missing: string[] = [];
  const ghosts: string[] = [];
  for (const info of Object.values(REGULARITIES)) {
    // 「接了」= 源码里指名道姓地提到它（`reg(t, 'Rxx')`，或者在实现的地方写明这是哪一条）；
    // 「在跑」= 去掉注释之后还在。说没接的，去掉注释之后不能有人消费它。
    const named = new RegExp(`\\b${info.id}\\b`).test(text);
    const live = new RegExp(`'${info.id}'`).test(code);
    if (info.wired && !named) missing.push(info.id);
    if (!info.wired) {
      if (live) ghosts.push(info.id);
      assert.ok(
        info.where === 'n/a' || info.where === 'deferred',
        `${info.id} 没接线，where 却是 ${info.where}`,
      );
      assert.ok(
        (info.why ?? '').length > 20,
        `${info.id} 没接线又没写清楚为什么 —— 「以后再说」不算理由`,
      );
    }
  }
  assert.deepEqual(missing, [], `表里写着接了，源码里却找不到它接在哪：${missing.join(' ')}`);
  assert.deepEqual(ghosts, [], `表里写着没接，代码里却在用：${ghosts.join(' ')}`);
});

test('§4.10 这一期新接的六条：R3 / R12 / R19 / R22 / R31 / R32 各自真的推得动', () => {
  const t = COMMON_TRAITS;
  const off = (r: Regularity) => { const c = cloneTraits(t); c.regularities[r] = 0; return c; };
  const base: Facts = {
    committed: 0, atRisk: 0.05, balance: 1000, rank: 0, unknownHeldFor: 0, scaleVsLast: 1,
    ...QUIET,
  };
  const fresh = () => { const m = newMind(t); m.refBalance = 1000; m.peakBalance = 1000; return m; };
  const run = (m: MindState, tr: Traits, f: Partial<Facts> = {}) =>
    situationalChannels(baseChannels(m, tr), m, tr, { ...base, ...f });

  // R3 收官效应：场次快打完了、人还落后 —— 更敢押
  const late = fresh(); late.episodes = 60;
  const r3on = run(late, t, { balance: 350 });
  const r3off = run(late, off('R3'), { balance: 350 });
  assert.ok(r3on.fired.includes('R3'), 'R3 没触发');
  assert.ok(r3on.channels.risk > r3off.channels.risk + 0.05, 'R3 关掉前后风险偏好一样');
  assert.ok(r3on.channels.safety < r3off.channels.safety, 'R3 没有把「求稳」压下去');

  // R12 花钱买信息：对面整局在演、我自己不上不下
  const itchy = run(fresh(), t, { counterpartDisplay: 1, ownCertainty: 0.5 });
  const numbCuriosity = run(fresh(), off('R12'), { counterpartDisplay: 1, ownCertainty: 0.5 });
  assert.ok(itchy.fired.includes('R12'), 'R12 没触发');
  assert.ok(itchy.channels.curiosity > numbCuriosity.channels.curiosity + 0.05, 'R12 没推动好奇');
  // 「不上不下」才痒：把握满格的时候这条规律不该动
  const sure = run(fresh(), t, { counterpartDisplay: 1, ownCertainty: 1 });
  assert.ok(!sure.fired.includes('R12'), '心里有数的时候还在花钱买信息');

  // R19 情绪传染：场面热 → 松；有人一路碾过来 → 缩
  const hot = run(fresh(), t, { ambientHeat: 1 });
  const hotOff = run(fresh(), off('R19'), { ambientHeat: 1 });
  assert.ok(hot.fired.includes('R19'), 'R19 没触发');
  assert.ok(hot.channels.looseness > hotOff.channels.looseness + 0.05, '场面热了却没变松');
  const runaway = run(fresh(), t, { ambientRunaway: 1 });
  assert.ok(runaway.channels.looseness < hotOff.channels.looseness, '有人碾过来反而更松');
  assert.ok(runaway.channels.safety > hotOff.channels.safety, '有人碾过来却没变谨慎');

  // R22 情绪修复：悲/忧高的时候紧打、早收口
  const blue = fresh(); blue.e.sorrow = 1; blue.e.worry = 0.8;
  const blueOn = run(blue, t);
  const blueOff = run(blue, off('R22'));
  assert.ok(blueOn.fired.includes('R22'), 'R22 没触发');
  assert.ok(blueOn.channels.looseness < blueOff.channels.looseness - 0.02, '悲/忧高却没有收紧');
  assert.ok(blueOn.channels.seekInfo > blueOff.channels.seekInfo + 0.01, '没有「早点了结不确定」');
  // 起坡线：小亏一点谁都有点忧，那还不叫「想要一个小而稳的赢」
  const mild = fresh(); mild.e.worry = 0.3;
  assert.ok(!run(mild, t).fired.includes('R22'), '只是有点忧就触发了情绪修复');

  // R31 事后诸葛：结算里长出来，再在系统 2 的介入率上生效
  const knew = fresh();
  const trace = settle(knew, t, {
    gain: 40, balance: 1040, expected: 0.7, exposed: true, withdrew: false, scale: 50,
  });
  assert.ok(trace.fired.includes('R31'), '结果跟事前想的一样，却没记成「我就知道」');
  assert.ok(knew.hindsight > 0, 'hindsight 没涨');
  const probe = { stakes: 0.9, timePressure: 0.2, familiarity: 0.5, confidence: 0.5 };
  const cocky = fresh(); cocky.hindsight = 1;
  assert.ok(
    engageProbability(cocky, t, probe) < engageProbability(fresh(), t, probe) - 0.05,
    '「我就知道」没有让人更懒得算',
  );
  const numbHind = fresh(); numbHind.hindsight = 1;
  assert.ok(
    Math.abs(engageProbability(numbHind, off('R31'), probe) - engageProbability(fresh(), off('R31'), probe)) < 1e-9,
    'R31 = 0 的人也被事后诸葛推了',
  );

  // R32 峰终定律：在同一个人手上吃过的最狠一刀会留着
  const hurt = fresh();
  settle(hurt, t, {
    gain: -600, balance: 400, expected: 0.8, by: 'X', exposed: true, withdrew: false, scale: 600,
  });
  settle(hurt, t, {
    gain: -5, balance: 395, expected: 0.5, by: 'X', exposed: true, withdrew: false, scale: 10,
  });
  assert.ok(impressionOf(hurt, 'X') < -0.1, `对 X 的印象只有 ${impressionOf(hurt, 'X').toFixed(3)}`);
  // 对照组要用「同一个人、同一段记忆，只把这条规律关掉」——
  // 换个对手当对照是不成立的：X 身上还挂着 R7 结下的报复心，那是另一条规律。
  const vsX = run(hurt, t, { counterpartKey: 'X', balance: 400 });
  const vsXoff = run(hurt, off('R32'), { counterpartKey: 'X', balance: 400 });
  assert.ok(vsX.fired.includes('R32'), 'R32 没触发');
  assert.ok(
    vsX.channels.quitThreshold < vsXoff.channels.quitThreshold - 0.02,
    `在打疼过自己的人面前没有更容易退：${vsX.channels.quitThreshold.toFixed(3)} vs ${vsXoff.channels.quitThreshold.toFixed(3)}`,
  );
  assert.ok(vsX.channels.safety > vsXoff.channels.safety, '印象很痛却没有更求稳');
});
