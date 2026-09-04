/**
 * 炸金花机器人竞技场（设计文档 §6.1）。
 *
 * 这不是测试文件（`npm test` 只跑 `tests/*.test.ts`），是一个**工具模块**：
 * 让若干套「大脑」坐同一张桌子自对弈几千局，把「像不像人在打牌」变成一组可比的数。
 *
 * 三件事保证结果可信：
 *  - **换座**：每局把大脑按座位轮换一格，位置优势不会算到某一套大脑头上；
 *  - **同一副牌**：发牌走同一个种子化随机源，同一个 seed 跑两次结果完全一样；
 *  - **每局回满筹码**：净胜靠 `result.deltas` 累计，不让某一套大脑因为先破产而少打牌。
 *
 * 用法见 `docs/zjh/baseline-2026-09.md`。
 */

import {
  applyCommand, botAction, callCost, canAllInNow, canCompareNow, compareCost, createHumanPlayer,
  categoryBands, createInitialRoom, currentPlayer, handPercentile, startRound, tableRead, type DealMode,
  type GameCommand, type PlayerState, type RoomState,
} from '../shared/game.ts';
import { botActionV2 } from './fixtures/zjh-bot-v2.ts';
import { archetypeOf } from '../shared/zjh/bot/profile.ts';
import { expectedPercentile, priorDist, refine } from '../shared/zjh/bot/range.ts';
import { personaFor } from '../shared/zjh/bot/personas/index.ts';

/* --------------------------------------------------------------- 随机源 */

/** mulberry32：小、快、够均匀，重点是同一个 seed 一定复现同一串牌。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 发牌和洗牌都走 `crypto.getRandomValues`，这是内核唯一的随机入口。
 * 竞技场期间把它换成种子化的版本，跑完原样还回去。
 */
export function withSeededRandom<T>(seed: number, run: () => T): T {
  const rand = mulberry32(seed);
  const original = crypto.getRandomValues.bind(crypto);
  // eslint 不管这里：这是测试工具，替换全局随机源是它存在的理由。
  (crypto as { getRandomValues: typeof crypto.getRandomValues }).getRandomValues = (<
    A extends ArrayBufferView | null,
  >(array: A): A => {
    if (!array) return array;
    const view = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    for (let i = 0; i < view.length; i++) view[i] = Math.floor(rand() * 256);
    return array;
  }) as typeof crypto.getRandomValues;
  try {
    return run();
  } finally {
    (crypto as { getRandomValues: typeof crypto.getRandomValues }).getRandomValues = original;
  }
}

/* --------------------------------------------------------------- 大脑 */

/** 一个座位上坐的是谁。`v3` 是当前大脑，`v2` 是改造前的快照，其余是脚本对手。 */
export type Brain = 'v3' | 'v2' | 'maniac' | 'rock' | 'station' | 'actor';

export const BRAIN_LABELS: Record<Brain, string> = {
  v3: '新大脑', v2: 'V2 快照', maniac: '疯子', rock: '岩石', station: '跟注站', actor: '演员',
};

/** 一步决策：竞技场只关心动作，节奏（thinkMs）这一期不参与评分。 */
type Decider = (state: RoomState, me: PlayerState) => GameCommand;

/** 加注：能升到的最低一档。脚本对手不需要复杂的下注尺寸。 */
function raiseUp(state: RoomState, me: PlayerState): GameCommand | null {
  const mult = me.looked ? 2 : 1;
  const unit = state.settings.betOptions.find((u) => u > state.betUnit && me.chips > u * mult);
  return unit ? { type: 'raise', unit } : null;
}

function anyOpponent(state: RoomState, me: PlayerState): PlayerState | undefined {
  return state.players.find((p) => p.id !== me.id && p.status === 'active');
}

/**
 * 脚本对手（设计文档 P0）。它们不是「弱一点的机器人」，是**四种确定的毛病**：
 * 拿来量新大脑会不会被某一类打法系统性地吃掉。
 */
const SCRIPTED: Record<Exclude<Brain, 'v3' | 'v2'>, Decider> = {
  // 疯子：什么牌都加，从不弃牌，梭哈一律接。
  maniac: (state, me) => {
    if (state.allIn) return me.looked ? { type: 'call' } : { type: 'look' };
    if (!me.looked) return { type: 'look' };
    /*
     * 规则对齐（梭哈改成全押之后）：`allInCost` 现在恒等于自己的身家，原来那条
     * `chips <= allInCost` 会永远成立，疯子就变成了「解锁后每一步都梭哈」。
     * 疯子的人设是「加不动就跟」，所以这里换成引擎的真门槛：梭哈已解锁、
     * 并且钱确实够跟注（短码没有梭哈）才推，否则照旧加注/跟注。
     */
    const up = raiseUp(state, me);
    if (!up && canAllInNow(state) && me.chips > callCost(state, me)) return { type: 'all_in' };
    return up ?? { type: 'call' };
  },
  // 岩石：只打前 25% 的牌，其余一概不跟；有牌就一路加到底。
  rock: (state, me) => {
    if (!me.looked) return { type: 'look' };
    // 「前 25% 的牌」是**这张桌子上**的前 25%，所以分位按本桌档位取：
    // 娱乐增强桌上 0.75 分位已经是顺子中段，标准桌上还是对子头。
    const strength = handPercentile(me.hand, state.settings.dealMode);
    if (state.allIn) return strength >= 0.90 ? { type: 'call' } : { type: 'fold' };
    if (strength < 0.75) return state.betUnit > state.settings.betOptions[0] ? { type: 'fold' } : { type: 'call' };
    const target = anyOpponent(state, me);
    if (strength >= 0.95 && canCompareNow(state) && target && me.chips > compareCost(state, me)) {
      return { type: 'compare', targetId: target.id };
    }
    return raiseUp(state, me) ?? { type: 'call' };
  },
  // 跟注站：永远跟，从不加、从不弃；看牌拖到第二轮。
  station: (state, me) => {
    if (state.allIn) return me.looked ? { type: 'call' } : { type: 'look' };
    if (!me.looked && state.roundNo >= 2) return { type: 'look' };
    return { type: 'call' };
  },
  // 演员：反着来 —— 弱牌演强、强牌装弱，专门污染读牌。
  actor: (state, me) => {
    if (state.allIn) return me.looked ? { type: 'call' } : { type: 'look' };
    if (!me.looked) return { type: 'look' };
    const strength = handPercentile(me.hand, state.settings.dealMode);
    if (strength < 0.45) return raiseUp(state, me) ?? { type: 'call' };
    return { type: 'call' };
  },
};

function deciderFor(brain: Brain): Decider {
  if (brain === 'v3') return (s, me) => botAction(s, me).cmd;
  if (brain === 'v2') return (s, me) => botActionV2(s, me).cmd;
  return SCRIPTED[brain];
}

/* --------------------------------------------------------------- 指标 */

export interface BrainStats {
  brain: Brain;
  label: string;
  /** 参与的局数 */
  hands: number;
  /** 净胜负（分） */
  net: number;
  /** 每局净胜负的样本方差，用来算置信区间 */
  netSamples: number[];
  /** 底注之外主动投过钱的局数占比 */
  vpip: number;
  /** 加注占全部动作的比例 */
  raiseRate: number;
  /** 顶着压力时选择弃牌的比例 */
  foldToPressure: number;
  /**
   * 只看**弱牌**（看过牌、分位 < 0.72，即垫底那 72%）顶着压力时的弃牌比例。
   * §6.2 用它区分「对岩石的加注」和「对疯子的加注」—— 同样是被加，
   * 前者该退，后者不该，一个混在一起的 `foldToPressure` 说不清这件事。
   */
  foldToPressureWeak: number;
  weakPressureFaced: number;
  /**
   * 弱牌顶压力那些步上，**他被要求付的价钱**（`口价 / (池子 + 口价)`）的均值。
   * §6.2 比「对疯子」和「对岩石」的弃牌率时，这一项是必须控住的混杂因素：
   * 三个疯子从不弃牌，池子里永远三个人、价钱一路顶到最高档；三个岩石很快只剩一个。
   * 同一个弃牌率背后可以是完全不同的一口价。
   */
  weakPressurePrice: number;
  /**
   * **把压力归因到具体对手**之后的同一件事：`byRaiser[b]` 只统计
   * 「这一局的攻击（加注 / 梭哈）全部来自大脑 `b`」的那些步。
   *
   * §6.2 岩石那一行的原话是「**面对它的加注**，金花以下弃牌率 > 85%」，
   * 上面的 `foldToPressureWeak` 量不出这句话：`underPressure()` 把
   * 「第 3 轮起单价自动升档」也算成压力（那一步桌上根本没有人加注），
   * 六人桌上还会把另外两台 v3 的加注算到脚本对手头上。
   * 实测把三者拆开：来自岩石的加注 90.5%、来自另一台 v3 的 61.7%、
   * 「只是升档」的 45.8%，混在一起是 79.2% —— 混合值随桌上 v3 的台数变，
   * 跟「他把岩石的加注当不当真」没有关系。
   */
  byRaiser: Record<string, { faced: number; folds: number; price: number }>;
  /** 拿着弱牌（分位 < 0.35）主动加价的次数 —— §6.2 口径下的「偷池」 */
  bluffRaises: number;
  /** 一路闷到第 3 轮的局数占比（§6.4 期望 15%–35%） */
  blindToRound3: number;
  /** 比牌次数，以及其中闷着比的次数（§6.4 期望闷比占 5%–15%） */
  compares: number;
  blindCompares: number;
  /** 比牌目标是「范围最弱的那个」的次数（§6.4 期望 ≥ 70%） */
  compareOnWeakest: number;
  /** 梭哈：自己发起 / 接别人的 */
  allInInitiated: number;
  allInAccepted: number;
  /** 摊牌时亮出来的平均牌力 */
  showdowns: number;
  showdownStrength: number;
  /** 每一步的决策耗时之和（毫秒），用来看延迟 */
  decisionMs: number;
  decisions: number;
}

export interface ArenaResult {
  hands: number;
  seed: number;
  /** 每局收官时还站着几个人（全桌平均） */
  survivors: number;
  stats: BrainStats[];
  /**
   * 位置效应的体检表：按**相对首家的位置**（0 = 首家，n−1 = 最后说话）
   * 分别累计的净胜与人次。位置本身是有价值的，所以这几个数不该是 0；
   * 要看的是每套大脑在各个位置上的**人次是不是均等** —— 不均等，
   * 净胜里就混着位置红利，这时候比大脑没有意义（§6.1）。
   */
  byPosition: { net: number[]; hands: number[]; perBrain: Record<string, number[]> };
  /** 打完之后的房间：跨局记忆（`state.reads`）都在里面，探针用它核对对手档案。 */
  room: RoomState;
}

function emptyStats(brain: Brain): BrainStats {
  return {
    brain, label: BRAIN_LABELS[brain], hands: 0, net: 0, netSamples: [],
    vpip: 0, raiseRate: 0, foldToPressure: 0, foldToPressureWeak: 0, weakPressureFaced: 0,
    weakPressurePrice: 0, byRaiser: {},
    bluffRaises: 0, blindToRound3: 0,
    compares: 0, blindCompares: 0, compareOnWeakest: 0,
    allInInitiated: 0, allInAccepted: 0, showdowns: 0, showdownStrength: 0,
    decisionMs: 0, decisions: 0,
  };
}

/** 计数用的中间量（比例最后再除）。 */
interface Counters {
  vpipHands: number; actions: number; raises: number;
  pressureFaced: number; pressureFolds: number; blindRound3: number;
  weakPressureFaced: number; weakPressureFolds: number; weakPressurePrice: number; bluffRaises: number;
  byRaiser: Record<string, { faced: number; folds: number; price: number }>;
}

/**
 * 「金花以下」—— §6.2 「岩石加注时该退掉」的那一档，逐字取自设计文档
 * §6.2 表里岩石那一行：「面对**它的**加注，金花以下弃牌率 > 85%」。
 *
 * 2026-09-04 之前这里写死 0.72，并把它解释成一条**分位线**（垫底那 72%）。
 * 那个解释在同一版发牌里自洽，跨版本却不自洽：0.72 在旧发牌（大牌 92%）里
 * 落在金花档顶上，在新发牌（大牌 26%）里掉进对子档 —— 同一个断言换了口径。
 * 集成时按硬要求 1 全部对回**牌型线**：档线一律从 `categoryBands(mode)` 取，
 * 断言说「金花以下」，代码就取金花档的下沿。
 */
const weakTop = (mode: DealMode) => categoryBands(mode)[4][0];
/**
 * 「散牌」—— 这一档往下的牌再主动抬价，抬的就不是牌力，是别人的弃牌率。
 * 取散牌档的上沿（= 对子档下沿）：散牌是唯一一档「摊牌基本赢不了」的牌，
 * 拿对子加价是价值，不是偷池。旧值 0.35 是 92% 发牌时代手写的分位，同样按牌型线对回。
 */
const bluffTop = (mode: DealMode) => categoryBands(mode)[2][0];

/** 这一步他是不是顶着压力在做决定 —— 和 `noteAction` 的口径一致。 */
/**
 * 这一局的攻击（加注 / 梭哈）全都来自哪个大脑。
 *
 * - 返回大脑名：只有这一个大脑攻击过 —— §6.2 要的「面对**它的**加注」。
 * - 返回 `NO_AGGRESSOR`：**桌上根本没有人加注**，那一步的「压力」只是第 3 轮起
 *   单价自动升档。这一档单独留着有用：它是「加注」这件事的对照组。
 * - 返回 `null`：攻击来自两个不同的大脑，归因不清，两边都不算。
 */
export const NO_AGGRESSOR = '-';

function soleAggressor(
  state: RoomState, me: PlayerState, brainOf: (p: PlayerState) => Brain,
): string | null {
  let who: string | null = null;
  for (const p of state.players) {
    if (p.id === me.id) continue;
    if (!p.handActions?.some((e) => e.kind === 'raise' || e.kind === 'all_in')) continue;
    const b = brainOf(p);
    if (who !== null && who !== b) return null;
    who = b;
  }
  return who ?? NO_AGGRESSOR;
}

function underPressure(state: RoomState, me: PlayerState): boolean {
  return !!state.allIn
    || state.betUnit > state.settings.betOptions[0]
    || state.players.some((p) => p.id !== me.id && p.status === 'active'
      && p.handActions?.some((e) => e.kind === 'raise'));
}

/**
 * 他挑的是不是范围最弱的那个（§6.4）。
 *
 * 用的是**旁观者的**范围模型：同一批事件流、同一张似然表，但不看任何人的暗牌。
 * 「最弱」= 期望分位最低。并列时算他对。
 */
export function comparedWeakest(state: RoomState, me: PlayerState, targetId: string): boolean {
  const opponents = state.players.filter((p) => p.id !== me.id && p.status === 'active');
  if (opponents.length <= 1) return true;
  // 这里是 v2 挑比牌目标用的老范围模型，同样得按这一桌的发牌档取桶。
  const mode = state.settings.dealMode;
  const prior = priorDist(me.hand, mode);
  let best = Infinity;
  const scores = opponents.map((o) => {
    const v = expectedPercentile(
      refine(prior, o.handActions ?? [], archetypeOf(tableRead(state, o.id),
        personaFor(me).cognition.classifyOthers, personaFor(me).traits.regularities.R17 ?? 1),
        state.settings, mode, personaFor(me).cognition.readsTiming),
      mode,
    );
    best = Math.min(best, v);
    return { id: o.id, v };
  });
  const mine = scores.find((s) => s.id === targetId);
  return !!mine && mine.v <= best + 1e-9;
}

/* --------------------------------------------------------------- 主循环 */

export interface ArenaOptions {
  /** 每个座位坐哪套大脑。长度即人数（2–6）。 */
  brains: Brain[];
  hands: number;
  seed?: number;
  /** 每局把大脑往后挪一个座位（默认开）。关掉只用于调试。 */
  rotate?: boolean;
  /** 单步决策上限，防跑飞 */
  stepLimit?: number;
  /**
   * 前 N 局照打但**不计入统计**（§6.2 的「第 100 局之后」）。
   *
   * 机器人对同一张桌子是有记忆的：前几十局它还在建对手档案，
   * 那段时间的数字既不是「它打得怎么样」也不是「它适应得怎么样」。
   */
  warmup?: number;
  /**
   * 发牌档（默认标准档）。牌力分位与范围桶都随它走，所以两档的数字不能混着比 ——
   * 同一手金花在标准档排 0.84–0.96，在娱乐增强档只排 0.66–0.90。
   */
  dealMode?: DealMode;
}

export function runArena(opts: ArenaOptions): ArenaResult {
  const { brains, hands, seed = 20260903, rotate = true, stepLimit = 600, warmup = 0, dealMode = 'standard' } = opts;
  if (brains.length < 2 || brains.length > 6) throw new Error('竞技场只支持 2–6 人桌');

  return withSeededRandom(seed, () => {
    // 全员机器人：座位固定，每局只换「谁在这个座位上思考」。
    const host = createHumanPlayer('座位1', '🐯', 0, 'a0');
    const room = createInitialRoom('ARENA1', host);
    host.isBot = true;
    for (let i = 1; i < brains.length; i++) {
      const p = createHumanPlayer(`座位${i + 1}`, '🦊', i, `a${i}`);
      p.isBot = true;
      room.players.push(p);
    }
    for (const p of room.players) p.ready = true;
    room.settings.dealMode = dealMode;

    const stats = new Map<Brain, BrainStats>();
    const counters = new Map<Brain, Counters>();
    for (const b of brains) {
      if (!stats.has(b)) {
        stats.set(b, emptyStats(b));
        counters.set(b, {
          vpipHands: 0, actions: 0, raises: 0, pressureFaced: 0, pressureFolds: 0, blindRound3: 0,
          weakPressureFaced: 0, weakPressureFolds: 0, weakPressurePrice: 0, bluffRaises: 0,
          byRaiser: {},
        });
      }
    }
    const deciders = new Map<Brain, Decider>(brains.map((b) => [b, deciderFor(b)]));

    let survivorsSum = 0;
    let handsPlayed = 0;
    const seats = room.players.length;
    const posNet = new Array<number>(seats).fill(0);
    const posHands = new Array<number>(seats).fill(0);
    const posPerBrain: Record<string, number[]> = {};
    for (const b of brains) posPerBrain[b] ??= new Array<number>(seats).fill(0);

    for (let hand = 0; hand < hands; hand++) {
      const count = hand >= warmup;
      // 每局回满筹码：净胜靠 deltas 累计，谁也不会因为先破产而少打牌。
      for (const p of room.players) {
        p.chips = room.settings.startingChips;
        p.granted = 0;
        p.net = 0;
      }
      /**
       * 换座：**每 n 局挪一格**，不是每局挪一格。
       *
       * 引擎的庄位本来就每局往后挪一格（`startRound` 里的 `dealerSeat`），
       * 所以「每局把大脑也挪一格」等于两个同步的轮换叠在一起：大脑 j 相对
       * 首家的位置是 `(j − f0 − 2h) mod n`，而 `2h mod 6` 只取 {0,2,4} ——
       * 每套大脑一辈子只坐得到 6 个相对位置里的 3 个，而且 v3 占的那三个
       * 与 v2 占的那三个不是同一批。这就是「两种座位顺序都是前三个赢」
       * 的来源（实测两个方向差 ±3.5k/局，比真实差距还大）。
       *
       * 改成整块轮换之后，庄位在一块之内跑满一圈，块与块之间大脑再挪一格：
       * 每 n 局每套大脑都完整地坐过全部 n 个相对位置。
       */
      const offset = rotate ? Math.floor(hand / brains.length) % brains.length : 0;
      const seatBrain = room.players.map((p) => brains[(p.seat + offset) % brains.length]);
      const brainOf = (p: PlayerState) => seatBrain[room.players.findIndex((x) => x.id === p.id)];

      startRound(room, room.hostId);
      // 位置是这一局真正的座次：从首家数起第几个说话
      const firstActor = room.firstActorSeat;

      const blindAtRound3 = new Set<string>();
      let field = room.players.filter((p) => p.status === 'active').length;
      let guard = 0;
      while (room.phase === 'playing' && guard++ < stepLimit) {
        const cur = currentPlayer(room);
        if (!cur) break;
        field = room.players.filter((p) => p.status === 'active').length;
        const brain = brainOf(cur);
        const st = stats.get(brain)!;
        const ct = counters.get(brain)!;
        if (room.roundNo >= 3 && !cur.looked) blindAtRound3.add(`${brain}:${cur.id}`);

        const pressured = underPressure(room, cur);
        const wasAllIn = !!room.allIn;
        const t0 = performance.now();
        let cmd: GameCommand;
        let thinkMs: number | undefined;
        try {
          if (brain === 'v3') {
            const act = botAction(room, cur);
            cmd = act.cmd; thinkMs = act.thinkMs;
          } else cmd = deciders.get(brain)!(room, cur);
        } catch (err) {
          if (brain === 'v3') throw err;
          cmd = { type: 'fold' };
        }
        st.decisionMs += performance.now() - t0;
        st.decisions += 1;

        if (count && cmd.type !== 'look') {
          ct.actions += 1;
          if (pressured) ct.pressureFaced += 1;
          if (cmd.type === 'raise') ct.raises += 1;
          if (cmd.type === 'fold' && pressured) ct.pressureFolds += 1;
          // 只有看过牌的人才谈得上「拿着弱牌还跟」—— 闷着的人不知道自己弱
          if (cur.looked) {
            const strength = handPercentile(cur.hand, dealMode);
            if (pressured && strength < weakTop(dealMode)) {
              ct.weakPressureFaced += 1;
              if (cmd.type === 'fold') ct.weakPressureFolds += 1;
              const price = callCost(room, cur);
              ct.weakPressurePrice += price / Math.max(1, room.pot + price);
              const from = soleAggressor(room, cur, brainOf);
              if (from !== null) {
                const slot = ct.byRaiser[from] ??= { faced: 0, folds: 0, price: 0 };
                slot.faced += 1;
                if (cmd.type === 'fold') slot.folds += 1;
                slot.price += price / Math.max(1, room.pot + price);
              }
            }
            if (cmd.type === 'raise' && strength < bluffTop(dealMode)) ct.bluffRaises += 1;
          }
          if (cmd.type === 'compare') {
            st.compares += 1;
            if (!cur.looked) st.blindCompares += 1;
            if (comparedWeakest(room, cur, cmd.targetId)) st.compareOnWeakest += 1;
          }
          if (cmd.type === 'all_in') st.allInInitiated += 1;
          if (cmd.type === 'call' && wasAllIn) st.allInAccepted += 1;
        }

        try {
          applyCommand(room, cur.id, cmd, thinkMs);
        } catch (err) {
          // 新脑给出的非法动作是缺陷，必须让评测失败；旧基线（V2 夹具）才允许兜底。
          if (brain === 'v3') throw err;
          try { applyCommand(room, cur.id, { type: 'call' }); } catch { applyCommand(room, cur.id, { type: 'fold' }); }
        }
      }

      const result = room.result;
      for (const p of room.players) {
        if (!count) continue;
        const brain = brainOf(p);
        const rel = (p.seat - firstActor + seats) % seats;
        posNet[rel] += result?.deltas.find((d) => d.id === p.id)?.delta ?? 0;
        posHands[rel] += 1;
        posPerBrain[brain][rel] += 1;
        const st = stats.get(brain)!;
        const ct = counters.get(brain)!;
        st.hands += 1;
        const delta = result?.deltas.find((d) => d.id === p.id)?.delta ?? 0;
        st.net += delta;
        st.netSamples.push(delta);
        if (p.bet > room.settings.ante) ct.vpipHands += 1;
        if (blindAtRound3.has(`${brain}:${p.id}`)) ct.blindRound3 += 1;
        if (result?.revealed.includes(p.id) && result.hands[p.id]?.length === 3) {
          st.showdowns += 1;
          st.showdownStrength += handPercentile(result.hands[p.id], dealMode);
        }
      }
      if (count) {
        survivorsSum += field;
        handsPlayed += 1;
      }
      applyCommand(room, room.hostId, { type: 'new_round' });
    }

    for (const [brain, st] of stats) {
      const ct = counters.get(brain)!;
      st.vpip = ct.vpipHands / Math.max(1, st.hands);
      st.raiseRate = ct.raises / Math.max(1, ct.actions);
      st.foldToPressure = ct.pressureFolds / Math.max(1, ct.pressureFaced);
      st.foldToPressureWeak = ct.weakPressureFolds / Math.max(1, ct.weakPressureFaced);
      st.weakPressurePrice = ct.weakPressurePrice / Math.max(1, ct.weakPressureFaced);
      st.weakPressureFaced = ct.weakPressureFaced;
      st.byRaiser = ct.byRaiser;
      st.bluffRaises = ct.bluffRaises;
      st.blindToRound3 = ct.blindRound3 / Math.max(1, st.hands);
    }

    return {
      hands: handsPlayed,
      seed,
      survivors: survivorsSum / Math.max(1, handsPlayed),
      stats: [...stats.values()],
      byPosition: { net: posNet, hands: posHands, perBrain: posPerBrain },
      room,
    };
  });
}

/* --------------------------------------------------------------- 统计 */

/** 每局净胜的均值与 95% 置信区间半径（正态近似，样本几千局足够）。 */
export function netInterval(st: BrainStats): { mean: number; half: number; lo: number; hi: number } {
  const n = st.netSamples.length;
  if (n < 2) return { mean: 0, half: Infinity, lo: -Infinity, hi: Infinity };
  const mean = st.netSamples.reduce((a, b) => a + b, 0) / n;
  const variance = st.netSamples.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const half = 1.96 * Math.sqrt(variance / n);
  return { mean, half, lo: mean - half, hi: mean + half };
}

/** 一行一套大脑的文本报表，直接贴进 baseline 文档。 */
export function formatArena(res: ArenaResult): string {
  const rows = res.stats.map((st) => {
    const ci = netInterval(st);
    const showdown = st.showdowns ? st.showdownStrength / st.showdowns : 0;
    const weakest = st.compares ? st.compareOnWeakest / st.compares : 0;
    return [
      st.label,
      String(st.hands),
      st.net.toLocaleString('zh-CN'),
      `${ci.mean.toFixed(0)} ± ${ci.half.toFixed(0)}`,
      `${(st.vpip * 100).toFixed(1)}%`,
      `${(st.raiseRate * 100).toFixed(1)}%`,
      `${(st.foldToPressure * 100).toFixed(1)}%`,
      `${(st.blindToRound3 * 100).toFixed(1)}%`,
      `${st.compares}/${st.blindCompares}`,
      `${(weakest * 100).toFixed(1)}%`,
      `${st.allInInitiated}/${st.allInAccepted}`,
      showdown.toFixed(3),
      `${(st.decisionMs / Math.max(1, st.decisions)).toFixed(3)}ms`,
    ].join(' | ');
  });
  const head = ['大脑', '局数', '净胜', '每局净胜 95%CI', 'VPIP', '加注率', '压力弃牌率',
    '闷到第3轮', '比牌/闷比', '挑最软', '梭哈发起/接', '摊牌均强', '单步耗时'];
  const pos = res.byPosition;
  const posLine = `位置净胜（0=首家）：${pos.net.map((n, i) => `${i}:${(n / Math.max(1, pos.hands[i])).toFixed(0)}`).join('  ')}`;
  const share = Object.entries(pos.perBrain)
    .map(([b, h]) => `${BRAIN_LABELS[b as Brain]} ${h.map((x) => ((x / Math.max(1, h.reduce((a, c) => a + c, 0))) * 100).toFixed(1) + '%').join('/')}`)
    .join('   ');
  return [
    `局数 ${res.hands}，种子 ${res.seed}，平均收官人数 ${res.survivors.toFixed(2)}`,
    posLine,
    `各位置人次占比：${share}`,
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r} |`),
  ].join('\n');
}

/** 直接跑：`node tests/zjh-arena.ts <局数> <种子> <座位大脑，逗号分隔> [standard|party]` */
if (process.argv[1]?.endsWith('zjh-arena.ts')) {
  const hands = Number(process.argv[2] ?? 2000);
  const seed = Number(process.argv[3] ?? 20260903);
  const brains = (process.argv[4] ?? 'v3,v3,v3,v2,v2,v2').split(',') as Brain[];
  const dealMode = (process.argv[5] ?? 'standard') as DealMode;
  console.log(`发牌档：${dealMode}`);
  console.log(formatArena(runArena({ brains, hands, seed, dealMode })));
}
