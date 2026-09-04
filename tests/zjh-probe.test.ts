/**
 * §6.2 适应性探针。
 *
 * 场景台（`zjh-scenarios.test.ts`）问的是「这个局面他怎么打」；这里问的是
 * **「跟不同的人打，他会不会变」** —— 一个只会按牌力出牌的机器人，
 * 面对疯子和面对岩石会打得一模一样，这四张表就全是同一行数字。
 *
 * 四种脚本对手各 300 局，**前 100 局只打不算**（`warmup`）：机器人对同一张桌子
 * 是有记忆的，前几十局它还在建对手档案，那一段既不算它的水平也不算它的适应。
 *
 * **两张桌子**：六人桌（三台新脑 vs 三台脚本）量「面对某一类人的加注该不该退」，
 * 单挑桌量「同样一口价、同样只有一个对手时，谁的加注更值钱」。
 * 分两张桌子不是为了凑数字，是因为**桌上人数本身就会改弃牌率**：三个疯子从不弃牌，
 * 一局到底桌上都是四个人，「要同时打赢三个随机范围」本身就要 0.7 分位以上的牌；
 * 三个岩石则很快跑得只剩一个。六人桌上把这两家的弃牌率直接相比，比的是桌子大小，
 * 不是适应能力（实测见下面 `疯子` 那条的注释）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { runArena, NO_AGGRESSOR, type Brain, type BrainStats } from './zjh-arena.ts';
import { HANDS as SAMPLE_HANDS, ev, sample, scene } from './zjh-helpers.ts';
import { warmUpRange } from '../shared/zjh/bot/range.ts';

warmUpRange();

const HANDS = 300;
const WARMUP = 100;
/** 三个种子取合并样本：单个 300 局的桌子上「弱牌顶压力」只有两三百步，一两个百分点全是噪声。 */
const SEEDS = [70001, 70002, 70003];

/** 把同一配置在几个种子上的统计合并成一份（比例按样本量加权，计数直接相加）。 */
function merge(parts: BrainStats[]): BrainStats {
  const out = { ...parts[0] };
  const sum = (pick: (s: BrainStats) => number) => parts.reduce((a, s) => a + pick(s), 0);
  out.hands = sum((s) => s.hands);
  out.net = sum((s) => s.net);
  out.bluffRaises = sum((s) => s.bluffRaises);
  out.allInAccepted = sum((s) => s.allInAccepted);
  out.weakPressureFaced = sum((s) => s.weakPressureFaced);
  out.foldToPressureWeak = sum((s) => s.foldToPressureWeak * s.weakPressureFaced)
    / Math.max(1, out.weakPressureFaced);
  out.foldToPressure = sum((s) => s.foldToPressure * s.hands) / Math.max(1, out.hands);
  out.raiseRate = sum((s) => s.raiseRate * s.hands) / Math.max(1, out.hands);
  out.weakPressurePrice = sum((s) => s.weakPressurePrice * s.weakPressureFaced)
    / Math.max(1, out.weakPressureFaced);
  out.byRaiser = {};
  for (const part of parts) {
    for (const [who, v] of Object.entries(part.byRaiser)) {
      const slot = out.byRaiser[who] ??= { faced: 0, folds: 0, price: 0 };
      slot.faced += v.faced; slot.folds += v.folds; slot.price += v.price;
    }
  }
  return out;
}

/** `seats` 台新脑对同样多台脚本对手，返回新脑那一份统计（几个种子合并）。 */
function versus(opponent: Brain, seats: 1 | 3): BrainStats {
  const brains: Brain[] = seats === 1 ? ['v3', opponent] : ['v3', 'v3', 'v3', opponent, opponent, opponent];
  return merge(SEEDS.map((seed) => {
    const res = runArena({ brains, hands: HANDS, warmup: WARMUP, seed });
    return res.stats.find((s) => s.brain === 'v3')!;
  }));
}

const maniac = versus('maniac', 3);
const rock = versus('rock', 3);
const station = versus('station', 3);
const soloManiac = versus('maniac', 1);
const soloRock = versus('rock', 1);

test('§6.2 探针：三种脚本对手都打得赢', () => {
  for (const [name, st] of [['疯子', maniac], ['岩石', rock], ['跟注站', station]] as const) {
    const per = st.net / Math.max(1, st.hands);
    assert.ok(per > 0, `对${name}每局净胜 ${per.toFixed(0)}，没赢`);
  }
});

test('§6.2 探针：岩石的加注要当真 —— 面对它的加注，金花以下弃牌率 > 85%', () => {
  /*
   * 岩石只用顺金以上加。他一加价，我手上金花以下的牌就是必退的
   * —— 文档 §6.2 岩石那一行的原话是「**面对它的加注**，金花以下弃牌率 > 85%」。
   *
   * 量的时候必须**把压力归因到它头上**（`byRaiser`），不能用桌面平均的
   * `foldToPressureWeak`：后者把「第 3 轮起单价自动升档」（那一步桌上没有人加注）
   * 和「另外两台 v3 的加注」也算进来，六人桌上量到的是三种压力的混合。
   * 同一批 900 局拆开是 —— 岩石的加注 90.5%、另一台 v3 的加注 61.7%、
   * 只是升档 45.7%，混合值 79.2%。混合值随桌上 v3 的台数变，
   * 跟「他把岩石的加注当不当真」没有关系。
   *
   * 这条以前只写到 `>= 0.55`，实测 76.2%。差的不是门槛，是**可信度算得不对**：
   * 老 `credibility` 的主项是「加注占动作数的比例」，岩石 .243、疯子 .290 —— 分不开人。
   * 换成「摊牌均强 / 遇压弃牌率 / 抓到诈唬」三项之后，岩石的原型斜率 0.99 → 1.50。
   */
  const a = rock.byRaiser['rock'];
  assert.ok(a && a.faced >= 300, `面对岩石加注的弱牌样本只有 ${a?.faced ?? 0} 步`);
  const r = a.folds / a.faced;
  assert.ok(r > 0.85, `面对岩石的加注，金花以下只弃掉 ${(r * 100).toFixed(1)}%（n=${a.faced}）`);
});

test('§6.2 探针：加注和「单价自动升档」不是一回事', () => {
  /*
   * 同一张桌子、同一个指标，只按「这一局是谁在攻击」拆开：
   *
   * | 压力来自 | 金花以下弃牌率 | 样本 | 那一口的均价 |
   * |---|---|---|---|
   * | 岩石的加注 | 96.6% | 471 | 0.423 |
   * | 另一台 v3 的加注 | 78.2% | 133 | 0.467 |
   * | **没有人加注**（只是第 3 轮起升档） | 52.7% | 93 | **0.577** |
   *
   * 最后一行的价钱**最贵**，弃得却最少 —— 所以这三档分开的不是价目表，
   * 是「谁在推我」。一个只按牌力和价钱出牌的机器人，这三行会是同一个数。
   *
   * 跟注站那张桌子上「谁在推我」这一栏只有两档（它永远只跟，从不加注）：
   * 另一台 v3 的加注 38.0%（n=371）、没有人加注 45.9%（n=780）。
   *
   * **最后一条按关系写，不按常数写**（2026-09-04 发牌回调之后重定的口径）：
   * 原来这里钉的是「跟注站桌上没人加注时弃牌率 ≤ 0.40」，0.40 是在 92% 大牌的发牌上
   * 校准出来的 —— 那时候「金花以下」是只占 37% 的顺子群，现在同一个名字装的是占 84%
   * 的散牌群，人口换了，这个绝对数就没有意义了。真正要钉住的从来不是那个数，是
   * **「谁在推我」这件事本身**：同样是「没有人加注、只是价钱在涨」，坐在一桌从不弃牌的
   * 跟注站中间，要比坐在一桌只用顺金以上加注的岩石中间更敢留下来。所以写成两张桌子
   * 同一口径的**相对关系**，发牌档怎么调都不会把它调坏。
   */
  const raised = rock.byRaiser['rock'];
  const quiet = rock.byRaiser[NO_AGGRESSOR];
  assert.ok(raised && quiet && quiet.faced >= 80, '两档的样本都要够');
  const rr = raised.folds / raised.faced;
  const rq = quiet.folds / quiet.faced;
  assert.ok(rr > rq * 1.5, `有人加注 ${(rr * 100).toFixed(1)}% vs 只是升档 ${(rq * 100).toFixed(1)}% —— 分不开`);
  assert.ok(rq < 0.60, `没有人加注也弃掉 ${(rq * 100).toFixed(1)}%`);
  const sq = station.byRaiser[NO_AGGRESSOR];
  assert.ok(sq && sq.faced >= 300, '跟注站桌上的样本太少');
  const sqRate = sq.folds / sq.faced;
  assert.ok(
    sqRate < rq,
    `同样是「没有人加注」，跟注站桌上弃 ${(sqRate * 100).toFixed(1)}%，`
      + `岩石桌上弃 ${(rq * 100).toFixed(1)}% —— 一桌从不弃牌的人反而把他吓得更狠`,
  );
  assert.ok(!station.byRaiser['station'], '跟注站从不加注，不该有归到它头上的样本');
});

test('§6.2 探针：疯子的加注不值钱 —— 同一张单挑桌上，遇压弃牌率不到对岩石的一半', () => {
  /*
   * 文档 §6.2 疯子那一行：「遇压弃牌率 < 对岩石时的一半」。**要在单挑桌上量**，
   * 六人桌上量的是桌子大小不是适应能力：
   *
   * | 桌子 | 对疯子遇压弃 | 对岩石遇压弃 | 比值 | 对疯子那口的均价 | 对岩石那口的均价 |
   * |---|---|---|---|---|---|
   * | 六人（3v3） | 37.8% | 51.8% | 0.73 | 0.321 | 0.435 |
   * | 单挑（1v1） | 23.2% | 49.8% | **0.47** | 0.434 | 0.478 |
   *
   * 三个疯子从不弃牌，所以一局到底桌上都是四个人，「要同时打赢三个随机范围」
   * 本身就要 0.7 分位以上的牌 —— 六人桌上那 37.8% 里有一大半是**算对了**，
   * 不是被吓住了；三个岩石则很快跑得只剩一个，同一个指标两边根本不同价
   * （均价 0.321 vs 0.435）。单挑桌把人数和价钱都控住，剩下的差别才是「他会不会看人」。
   * 文档那一行已经补上「单挑桌」的口径，理由同此。
   */
  const m = soloManiac.foldToPressure;
  const r = soloRock.foldToPressure;
  assert.ok(m < r / 2, `单挑桌上对疯子遇压弃 ${(m * 100).toFixed(1)}%，对岩石 ${(r * 100).toFixed(1)}% —— 没到一半`);
  // 价钱得可比，不然比的是价目表：两边的「弱牌顶压力那口」均价差不得超过 20%。
  const pm = soloManiac.weakPressurePrice;
  const pr = soloRock.weakPressurePrice;
  assert.ok(Math.abs(pm - pr) / pr < 0.20, `两边的均价差太多（疯子 ${pm.toFixed(3)} / 岩石 ${pr.toFixed(3)}）`);
});

test('§6.2 探针：接疯子的梭哈，不接岩石的', () => {
  /*
   * 文档 §6.2 疯子那一行的后半句：「接它梭哈的次数 > 接岩石的 4 倍」。
   * 跟同一行的前半句一样在**单挑桌**上量：900 局里接疯子的梭哈 17 次、
   * 接岩石的 0 次。六人桌上这两个计数不可比 —— 三个疯子每局都在梭，
   * 三个岩石一晚上才梭几次，比的是「被梭了多少回」而不是「接不接」
   * （六人桌实测 248 vs 72）。
   */
  assert.ok(soloManiac.allInAccepted >= 10, `接疯子的梭哈只有 ${soloManiac.allInAccepted} 次，样本太少`);
  assert.ok(
    soloManiac.allInAccepted > soloRock.allInAccepted * 4,
    `接疯子的梭哈 ${soloManiac.allInAccepted} 次、接岩石的 ${soloRock.allInAccepted} 次 —— 门槛没分开`,
  );
});

test('§6.2 探针：对疯子不抬价，让他自己往里扔', () => {
  /*
   * 疯子从不弃牌，所以对他抬价买不到任何弃牌率 —— 加注在他身上只剩「把好牌的钱做大」
   * 这一个用途，频率自然掉下来；对岩石和跟注站则不然。
   */
  assert.ok(maniac.raiseRate <= 0.06, `对疯子还在 ${(maniac.raiseRate * 100).toFixed(1)}% 的动作里抬价`);
  assert.ok(rock.raiseRate > maniac.raiseRate * 1.8, '对岩石和对疯子的加注率应该分得开');
  assert.ok(station.raiseRate > maniac.raiseRate * 1.8, '对跟注站和对疯子的加注率应该分得开');
});

test('§6.2 探针：对疯子和跟注站都不偷池 —— 那里没有弃牌率可买', () => {
  /*
   * 设计文档这一行原来写的是「对跟注站的偷池次数 < 对疯子的 1/3」。**这条是文档写错了**，
   * 已在同一次提交里改掉，理由：偷池的收益 = 对手的弃牌率，疯子和跟注站的弃牌率
   * 都是 0，两家都不该偷，谁比谁少 1/3 没有含义。实测（900 局计入样本）
   * 对疯子 4 次、对跟注站 17 次、对岩石 10 次 —— 都是「几乎不偷」的量级。
   * 真正有含义的是**它们各自该换成什么**：对跟注站换成价值加注（加注率 8.3% vs 对疯子 3.6%）。
   */
  assert.ok(maniac.bluffRaises <= 10, `对疯子还偷了 ${maniac.bluffRaises} 次池`);
  assert.ok(station.bluffRaises <= 25, `对跟注站还偷了 ${station.bluffRaises} 次池 —— 他从不弃牌`);
});

test('§6.2 探针：演员 —— 对它长考后跟的比牌率上升（S17）', () => {
  /*
   * 设计 §6.2 演员那一行的原话：「对它长考后跟的比牌率上升」。S17：对方在时限里
   * 用了 25 秒才跟 → 当他弱。读用时的人（阿杰 `readsTiming`）看见这一条，
   * 对他的范围下压，开牌的意愿就该比对方秒跟时高。量的是**比牌率**，
   * 加价试探只作参考打印 —— 不拿另一个指标替换文档里写的那个。
   */
  const counts = (msSpent: number) => {
    let raises = 0, folds = 0, compares = 0, total = 0;
    for (const hand of [SAMPLE_HANDS.midJunk, SAMPLE_HANDS.smallPair, SAMPLE_HANDS.midPair, SAMPLE_HANDS.kingPair, SAMPLE_HANDS.midFlush]) {
      for (const unit of [20_000, 50_000]) {
        const { room, bot } = scene({
          me: { name: '阿杰', hand, looked: true, bet: unit },
          others: [{ name: '演员', looked: true, bet: unit,
            events: [{ ...ev('call', true, unit, 4), msSpent }] }],
          betUnit: unit, pot: unit * 5, roundNo: 4, position: 'late',
        });
        for (const cmd of sample(room, bot, 400)) {
          total++;
          raises += +(cmd.type === 'raise'); folds += +(cmd.type === 'fold'); compares += +(cmd.type === 'compare');
        }
      }
    }
    return { raises, folds, compares, total };
  };
  const fast = counts(200), slow = counts(25_000);
  console.log('[演员] 秒跟', fast, '长考后跟', slow);
  assert.equal(fast.total, 4000);
  assert.ok(slow.compares > fast.compares,
    `对长考后跟的人，比牌率没有上升：长考 ${slow.compares}/${slow.total} vs 秒跟 ${fast.compares}/${fast.total}`);
  assert.ok(slow.folds <= fast.folds, '长考是弱信号，不该让他更害怕');
});
