import { learnedLikelihood } from './learned.ts';
/**
 * 记牌器 / 范围模型（设计文档 §4.3）。
 *
 * 旧机器人只有「对手压力」没有「对手范围」：对手连加两次，代码做的只是把
 * 「我需要多少胜率」抬高几个点，而不是把他手里可能是什么牌收紧到金花以上。
 * 于是拿一手 Q 高金花面对连加两手的紧手，模型还认为自己有五成胜率。
 *
 * 这里把每个对手表示成**牌力分位上的一条分布**（40 个桶），先验来自本桌的发牌
 * 分布，每看到一个公开动作就对分布做一次逐桶乘法再归一化。全是纯函数：输入是
 * 从 `RoomState` 重放出来的事件流，所以可复测，也不需要在房间状态里存分布。
 *
 * ## 为什么它能无痛替掉旧的胜率公式
 *
 * 桶的先验质量 = 桶的分位宽度，于是**没有任何信息时** `pWin(x, 先验) ≡ x`
 * ——正好是 `handPercentile`。再把多家合并写成加权几何平均（最危险的一家权重 1、
 * 其余 0.5），`pWinAll` 在无信息时就退化成旧的 `winEquity = p^(1+0.5(n-1))`，
 * `pWinShowdown` 退化成 `showdownEquity = p^n`，`pWinBlind` 退化成
 * `blindEquity = 1/(1+effectiveField)`。既有的门槛、性格参数和测试全部照旧成立，
 * 而一旦对手真的做了动作，数就自己变了。
 *
 * 本文件对 game.ts 的引用**全部是惰性的**（都在函数体里、首次使用才求值），
 * 因为 game.ts → bot/index.ts → decide.ts → range.ts 是一个 ESM 循环。
 */

import {
  categoryBands, createDeck, handPercentile,
  type Card, type DealMode, type GameSettings,
} from '../../game.ts';
import { unitTier, type HandEvent } from './events.ts';
import { timingLikelihood } from './tempo.ts';

/* --------------------------------------------------------------- 桶 */

export const BUCKET_COUNT = 40;

/**
 * 桶按**档位**分别算：桶边界对齐那一档的带，两档的第 i 个桶落在不同的分位区间上。
 *
 * 但**桶序号在两档之间是可以混用的**：每一档的桶数分配都是同一张
 * `BUCKETS_PER_CATEGORY`，所以第 i 个桶在两档里都是「这一桌上从弱到强排第 i 段」，
 * 是一个**相对牌力名次**而不是绝对分位。跨局档案（`reads` / `MemoryBucket`）
 * 以桶序号存，因此换档之后旧统计仍然可用 —— 代价是它把「party 桌上的金花」和
 * 「standard 桌上的金花」当成了同一个名次段，而两边的绝对分位差着 0.2 以上。
 * 这是一个**刻意接受的近似**（设计文档 §4.3）：宁可让跨局的「他是紧还是松」延续下去，
 * 也不要为一个只影响先验起点的差别把档案切成两份、每换一次档就把人重新当生人。
 */
const DEFAULT_MODE: DealMode = 'standard';

/**
 * 每个牌型分几个桶。合计 10+5+7+10+4+4 = 40，边界对齐 `CATEGORY_BANDS`。
 *
 * 分配的依据是**分辨率要花在决策发生的地方**，不是按带宽平摊：
 * - 散牌带最宽（0.60）但一手散牌打不打得下去几乎只看「多散」，10 桶（每桶 0.06 分位）
 *   够把 A 高和 7 高分开，再细也不会改变任何一个动作；
 * - 对子带 0.14，5 桶（每桶 0.028）能分开小对子和 A 对，这正是「跟还是弃」的分水岭；
 * - 顺子 / 金花 / 顺金 / 豹子是加价、比牌、梭哈真正发生的区间，带虽然窄
 *   （0.10 / 0.12 / 0.018 / 0.022）却要吃掉 25 个桶：金花 10 桶（每桶 0.012）
 *   把 A 高金花和 9 高金花分成不同的桶，顺子 7 桶，顺金和豹子各 4 桶
 *   （13 个大小档位压到 4 桶，足够表达「他敢不敢接比牌」这一档差别）。
 *
 * 上一版发牌 92% 是大牌，所以桶几乎全压在顺子以上（2+1+12+15+5+5）；现在大牌只剩 26%，
 * 散牌和对子重新成为桌上最常见的牌，再给它们 3 个桶就等于让机器人**看不见大多数对手**。
 *
 * 娱乐增强档共用这张分配表：那一档散牌只剩 35%、金花有 24%，按带宽摊会把 10 个桶
 * 挪给金花，但「决策发生在哪儿」并没有换地方 —— 一手散牌在 party 桌上照样只看「多散」。
 */
const BUCKETS_PER_CATEGORY: Record<number, number> = { 1: 10, 2: 5, 3: 7, 4: 10, 5: 4, 6: 4 };

export interface Bucket {
  category: number;
  lo: number;
  hi: number;
  /** 桶中点的分位，似然表按它算乘子 */
  mid: number;
}

const bucketCache = new Map<DealMode, Bucket[]>();

export function buckets(mode: DealMode = DEFAULT_MODE): Bucket[] {
  const hit = bucketCache.get(mode);
  if (hit) return hit;
  const bands = categoryBands(mode);
  const out: Bucket[] = [];
  for (const category of [1, 2, 3, 4, 5, 6]) {
    const [lo, hi] = bands[category];
    const n = BUCKETS_PER_CATEGORY[category];
    for (let k = 0; k < n; k++) {
      const a = lo + ((hi - lo) * k) / n;
      const b = lo + ((hi - lo) * (k + 1)) / n;
      out.push({ category, lo: a, hi: b, mid: (a + b) / 2 });
    }
  }
  bucketCache.set(mode, out);
  return out;
}

/** 一条范围：40 个桶上的概率质量，和为 1。 */
export type RangeDist = number[];

export function bucketOf(percentile: number, mode: DealMode = DEFAULT_MODE): number {
  const list = buckets(mode);
  const p = Math.max(0, Math.min(0.999999, percentile));
  for (let i = 0; i < list.length; i++) if (p < list[i].hi) return i;
  return list.length - 1;
}

/**
 * 亲眼见过的那手牌：分布塌成一个点。
 *
 * 比过牌之后对手是什么已经不是「范围」而是**事实**，再拿先验去猜他，
 * 就是设计文档 S20 说的「比完牌还假装不知道对面是什么」。
 */
export function pointDist(percentile: number, mode: DealMode = DEFAULT_MODE): RangeDist {
  const out = new Array(BUCKET_COUNT).fill(0);
  out[bucketOf(percentile, mode)] = 1;
  return out;
}

/* ------------------------------------------------------- 已知牌的扣除（S20） */

interface IndexedHand { a: number; b: number; c: number; bucket: number }

interface HandIndex { hands: IndexedHand[]; totals: number[] }

const indexCache = new Map<DealMode, HandIndex>();

const cardIndex = (card: Card) => ({ S: 0, H: 1, C: 2, D: 3 }[card.suit] ?? 0) * 13 + (card.rank - 2);

/**
 * 52 选 3 的全表，每手牌落在哪个桶。首次使用时算一次（两万两千手，几十毫秒），
 * 之后扣牌只是一遍线性扫描。
 *
 * 按档位分表：两档的桶数分配相同，所以同一手牌在两档里**大概率落在同一个桶**，
 * 但那是「大概率」不是保证（浮点边界），而这张表是先验的分母 —— 与其推理不如各建一张。
 */
function handIndex(mode: DealMode = DEFAULT_MODE): HandIndex {
  const hit = indexCache.get(mode);
  if (hit) return hit;
  const deck = createDeck();
  const hands: IndexedHand[] = [];
  const totals = new Array(BUCKET_COUNT).fill(0);
  for (let a = 0; a < deck.length - 2; a++) {
    for (let b = a + 1; b < deck.length - 1; b++) {
      for (let c = b + 1; c < deck.length; c++) {
        const bucket = bucketOf(handPercentile([deck[a], deck[b], deck[c]], mode), mode);
        hands.push({ a, b, c, bucket });
        totals[bucket] += 1;
      }
    }
  }
  const out = { hands, totals };
  indexCache.set(mode, out);
  return out;
}

/**
 * 让首次决策不背上建表的几十毫秒（延迟测试和竞技场开跑前调一次）。
 * 不带参数就把两档都热一遍 —— 调用方通常还不知道自己会坐上哪一档的桌子。
 */
export function warmUpRange(mode?: DealMode): void {
  if (mode) handIndex(mode);
  else for (const m of ['standard', 'party'] as DealMode[]) handIndex(m);
}

let cachedPriorKey: string | null = null;
let cachedPrior: RangeDist | null = null;

/**
 * 先验分布，并按已知牌重加权。
 *
 * 发牌是**先掷牌型、再在剩余牌里等概率取一手**（`dealWeightedHands`），所以牌型
 * 之间的比例（散牌 60%、对子 14%、金花 12% …）不受扣牌影响，扣牌只改变**同一牌型内部**的
 * 分布 —— 这正是 S20 要的：比牌看到对手是 K 高金花之后，别人的金花要大过我
 * 就只剩 A 高那几种。所以这里按牌型分别归一化，不跨牌型搬质量。
 */
export function priorDist(known: Card[] = [], mode: DealMode = DEFAULT_MODE): RangeDist {
  const marks = new Array(52).fill(false);
  const keys: number[] = [];
  for (const card of known) {
    const idx = cardIndex(card);
    if (idx >= 0 && idx < 52 && !marks[idx]) { marks[idx] = true; keys.push(idx); }
  }
  const key = `${mode}|${keys.sort((x, y) => x - y).join(',')}`;
  if (cachedPriorKey === key && cachedPrior) return cachedPrior.slice();

  const list = buckets(mode);
  const dist = list.map((b) => b.hi - b.lo);
  if (keys.length) {
    const { hands: index, totals } = handIndex(mode);
    const avail = new Array(BUCKET_COUNT).fill(0);
    for (const h of index) {
      if (marks[h.a] || marks[h.b] || marks[h.c]) continue;
      avail[h.bucket] += 1;
    }
    for (let i = 0; i < dist.length; i++) {
      // 相对折扣：没扣掉任何牌时比值恒为 1，先验退回「桶宽 = 质量」的平表
      dist[i] *= totals[i] > 0 ? avail[i] / totals[i] : 1;
    }
    // 牌型之间的比例保持不变
    for (const category of [1, 2, 3, 4, 5, 6]) {
      const idxs = list.map((b, i) => (b.category === category ? i : -1)).filter((i) => i >= 0);
      const mass = idxs.reduce((s, i) => s + (list[i].hi - list[i].lo), 0);
      const now = idxs.reduce((s, i) => s + dist[i], 0);
      if (now > 0) for (const i of idxs) dist[i] = (dist[i] / now) * mass;
      else for (const i of idxs) dist[i] = (list[i].hi - list[i].lo);
    }
  }
  const out = normalize(dist, mode);
  cachedPriorKey = key;
  cachedPrior = out;
  return out.slice();
}

function normalize(dist: RangeDist, mode: DealMode = DEFAULT_MODE): RangeDist {
  let sum = 0;
  for (const v of dist) sum += v;
  if (!(sum > 0)) return buckets(mode).map((b) => b.hi - b.lo);
  return dist.map((v) => v / sum);
}

/* ------------------------------------------------------------- 似然表 */

/**
 * 对手原型。这一期只有一张「常人」似然表，原型对它做一个**整体形变**：
 * `slope` 越大表示这个人的动作越可信 —— 岩石加注就是亮牌，疯子加注什么都不是。
 * 具体取值由 `profile.ts` 从跨局公开统计算出来，样本不足一律 `COMMON`。
 */
export interface Archetype {
  name: string;
  /** 似然斜率的缩放，0.5（谁都不信）–1.5（说什么信什么） */
  slope: number;
  learned?: string;
}

export const COMMON: Archetype = { name: 'common', slope: 1 };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** 线性似然：以 `m0` 为中性点，`k` 是斜率。k>0 表示这个动作偏向强牌。 */
const linear = (k: number, m0: number) => (mid: number) => clamp(1 + k * (mid - m0), 0.03, 4);

/** 驼峰似然：中段抬高、两端压低 —— 「看了牌只肯平跟」就是这个形状。 */
const hump = (center: number, width: number, gain: number) => (mid: number) =>
  clamp(1 + gain * (Math.exp(-(((mid - center) / width) ** 2)) - 0.45), 0.05, 4);

/**
 * 「熬得越晚，同一个动作越有信息量」的**满格涨幅**：耗到很后面的轮次，似然斜率
 * 最多再放大 15%（还要乘 `arch.slope`，见 `likelihoodFor`）。量纲是倍率上的增量。
 */
const LATE_GAIN = 0.15;
/**
 * 上面那条涨幅的**时间常数**，量纲是轮：第 `1 + LATE_SPAN` 轮吃到约 63% 的涨幅，
 * 再往后逐渐饱和。取 2 是为了让 2→3→4 轮之间都还在明显地长，而不是一步到顶。
 */
const LATE_SPAN = 2;

/**
 * `L[archetype][kind][looked][phase]` 的实现。
 *
 * 闷牌那一档几乎是平的 —— 闷着只付一半价，什么牌都能闷着跟，动作本身不带信息；
 * 闷加略偏松（真人闷加多半是在演，不是真拿到了货）。看牌之后的动作才有信息量，
 * 并且随着**单价档位**和**轮次**递增：第 5 轮在 10 万档上加注，和第 1 轮在底注上
 * 加注不是一回事。
 */
function likelihoodFor(
  ev: HandEvent,
  settings: Pick<GameSettings, 'betOptions'>,
  arch: Archetype,
): (mid: number) => number {
  /**
   * R24 确认偏差就在这一行的 `arch.slope` 上：**标签一贴上去，后面每一条证据都按
   * 这个标签的斜率读**。设计文档 §4.9.5 把它写成「符合标签的证据 ×1.5、不符的 ×0.6」，
   * 这里实现成同一件事的连续版：`slope = 0.15 + 2.05·可信度²`（`profile.ts`），
   * 贴成「老实人」的斜率越过 1，他的加注被读得更硬；贴成「疯子」的斜率掉到 0.2 上下，
   * 同样一手梭哈几乎不动范围。两档常数换成一条曲线，是因为标签本身是从可信度
   * 连续算出来的，硬切成两档会在边界上出现「多打一手牌就换了个人」。
   *
   * 「越晚、档位越高，这个动作信息量越大」只对**可信的人**成立。
   * 一个说什么都不算数的人，把注加得再大、拖得再晚，也还是不算数 ——
   * 所以放大倍数本身也要乘上 `slope`，否则疯子的大额梭哈会被放大成强信号（S9）。
   *
   * 轮次那一头同样不许硬切：`late` 原本写成「第 3 轮起 ×1.15」，那就是上面刚
   * 批评过的两档常数 —— 边界上「多打一手牌就换了个人」。现在它是一条**饱和曲线**：
   * 每往后一轮多长一点，涨幅越来越小，`LATE_SPAN` 轮之后基本吃满 `LATE_GAIN`。
   * 它和下面的 `esc`（按**单价档位**放大）量的不是同一件事：`esc` 说的是「这一口有多贵」，
   * `late` 说的是「他已经为这手牌付了多少轮」—— 本局设置里升档是自动的（`escalateFrom`），
   * 但一个人可以在同一档上耗很多轮，两者并不互相蕴含，所以都留着。
   */
  const late = 1 + LATE_GAIN * (1 - Math.exp(-Math.max(0, ev.roundNo - 1) / LATE_SPAN)) * arch.slope;
  const scale = arch.slope * late;
  /**
   * 闷牌那一档是**完全平的**，而且这不是近似 —— 他自己都没看过牌，
   * 他的动作和他手里是什么在概率上就是独立的。闷加、闷比、闷梭全都一样：
   * 那是关于**这个人**的信息，不是关于**这手牌**的信息。
   * （所以设计文档 §6.4 才要求「闷牌加注几乎不动范围」。）
   */
  if (!ev.looked) return () => 1;
  const esc = 1 + 0.22 * unitTier(ev.unit, settings) * arch.slope;
  switch (ev.kind) {
    case 'call': return hump(0.46, 0.28, 0.85 * scale);
    case 'raise': return linear(1.90 * scale * esc, 0.5);
    case 'compare': return linear(1.50 * scale * esc, 0.5);
    case 'all_in': return linear(3.00 * scale * esc, 0.55);
    default: return () => 1;
  }
}

/** 把一串公开事件作用到先验上。事件里的 `look`/`fold` 不带牌力信息。 */
export function refine(
  prior: RangeDist,
  events: HandEvent[],
  arch: Archetype,
  settings: Pick<GameSettings, 'betOptions' | 'turnSeconds'>,
  mode: DealMode = DEFAULT_MODE,
  /**
   * 读不读对手的用时（S17，人物卡的 `cognition.readsTiming`）。
   * 默认 false —— 大多数人不看别人按得多快，这条信号只属于老油条和闷牌王。
   */
  readsTiming = false,
): RangeDist {
  if (!events.length) return prior.slice();
  const list = buckets(mode);
  let dist = prior.slice();
  for (const ev of events) {
    if (ev.kind === 'look' || ev.kind === 'fold') continue;
    const mult = likelihoodFor(ev, settings, arch);
    const learned = learnedLikelihood(arch.learned, mode, ev, settings);
    for (let i = 0; i < dist.length; i++) dist[i] *= learned ? Math.pow(learned[i], arch.slope) : mult(list[i].mid);
    // 用时是**同一个动作**的第二条弱信号，所以和动作似然乘在同一步里、
    // 再一起归一：拆成两轮归一等于把它当成两个独立事件，会把一条弱信号读成两条。
    const timing = readsTiming ? timingLikelihood(ev, settings) : null;
    if (timing) for (let i = 0; i < dist.length; i++) dist[i] *= timing(list[i].mid);
    dist = normalize(dist, mode);
  }
  return dist;
}

/**
 * 「他接了这个梭哈」之后，他的范围收成什么样（设计文档 §4.6 的发起端）。
 *
 * 发起梭哈的时候不能拿他**没接之前**的范围去算摊牌 —— 那是选择性偏差：
 * 真正跟你比大小的从来不是他的全部牌，而是**他愿意押上全部身家的那一部分**。
 * 一个平时十次里只接一次的人一旦接了，他手里那手牌就硬得多；
 * 一个说什么都接的人接了，几乎什么都没说。所以收紧的力度由他的接注率决定：
 * `acceptProb` 越低，这一下越是亮牌。
 *
 * 形状沿用似然表的线性乘子（以 0.5 为中性点），只是斜率来自跨局的接注率而不是动作类型。
 */
export function tightenForAccept(
  dist: RangeDist,
  acceptProb: number,
  mode: DealMode = DEFAULT_MODE,
): RangeDist {
  const list = buckets(mode);
  const k = 3.2 * (1 - clamp(acceptProb, 0, 1));
  if (k <= 0.02) return dist.slice();
  const out = dist.map((v, i) => v * clamp(1 + k * (list[i].mid - 0.5), 0.03, 4));
  return normalize(out, mode);
}

/* --------------------------------------------------------------- 输出 */

/**
 * 我这手牌打赢这条范围的概率 = 他落在我下面的质量。
 *
 * 同桶内按线性插值而不是「一律算半个桶」：只有这样，先验平表下
 * `pWin(x, 先验) ≡ x`，整套旧门槛才不需要重新标定。
 */
export function pWin(myPercentile: number, dist: RangeDist, mode: DealMode = DEFAULT_MODE): number {
  const list = buckets(mode);
  const b = bucketOf(myPercentile, mode);
  let below = 0;
  for (let i = 0; i < b; i++) below += dist[i];
  const width = list[b].hi - list[b].lo;
  const frac = width > 0 ? clamp((myPercentile - list[b].lo) / width, 0, 1) : 0.5;
  return clamp(below + dist[b] * frac, 0, 1);
}

/**
 * 多家合并。
 *
 * `'field'`：下注阶段。炸金花绝大多数底池是靠别人弃牌收掉的，六个人坐着不等于
 * 六个人跟你比大小 —— 最危险的那一家一定要过（权重 1），后面每多一家按半个算。
 * 无信息时正好等于旧的 `winEquity`。
 * `'showdown'`：摊牌已成定局，每家都真的要比，不能打折。
 */
export function combine(pWins: number[], mode: 'field' | 'showdown' = 'field'): number {
  if (!pWins.length) return 1;
  const sorted = [...pWins].sort((a, b) => a - b);
  let out = 1;
  for (let i = 0; i < sorted.length; i++) {
    const w = mode === 'showdown' ? 1 : i === 0 ? 1 : 0.5;
    out *= Math.pow(clamp(sorted[i], 0, 1), w);
  }
  return clamp(out, 0, 1);
}

export function pWinAll(myPercentile: number, dists: RangeDist[], mode: DealMode = DEFAULT_MODE): number {
  return combine(dists.map((d) => pWin(myPercentile, d, mode)), 'field');
}

export function pWinShowdown(myPercentile: number, dists: RangeDist[], mode: DealMode = DEFAULT_MODE): number {
  return combine(dists.map((d) => pWin(myPercentile, d, mode)), 'showdown');
}

/** 我（按某条分布）打赢他的概率，两条分布逐桶积分。两边都是平表时正好 0.5。 */
export function pWinBetween(mine: RangeDist, theirs: RangeDist): number {
  let acc = 0;
  let below = 0;
  for (let i = 0; i < theirs.length; i++) {
    acc += mine[i] * (below + theirs[i] * 0.5);
    below += theirs[i];
  }
  return clamp(acc, 0, 1);
}

/**
 * 闷牌时的胜率。
 *
 * **不能拿 0.5 当牌力再做指数**：0.5^2.5 只有 18%，低于任何底池赔率，闷着的机器人
 * 必然弃牌。一手完全未知的牌拿下底池的概率是「这一桌里最好的那家是我」，写成赔率
 * 形式就是 `1/(1+Σ 权重×他的赔率)`。无信息时每家赔率都是 1，结果正好回到旧的
 * `1/(1+effectiveField(n))`；对手一旦表现出强度，赔率变大，闷牌的价值自己就掉下来。
 */
export function pWinBlind(dists: RangeDist[], mine: RangeDist, mode: 'field' | 'showdown' = 'field'): number {
  if (!dists.length) return 1;
  const odds = dists
    .map((d) => {
      const q = clamp(pWinBetween(mine, d), 1e-6, 1 - 1e-6);
      return (1 - q) / q;
    })
    .sort((a, b) => b - a);
  let sum = 0;
  for (let i = 0; i < odds.length; i++) sum += (mode === 'showdown' || i === 0 ? 1 : 0.5) * odds[i];
  return clamp(1 / (1 + sum), 0, 1);
}

/** 他大概在哪一档：中位数所在的桶。给比牌目标选择和梭哈判断用。 */
export function showdownBucket(dist: RangeDist): number {
  let acc = 0;
  for (let i = 0; i < dist.length; i++) {
    acc += dist[i];
    if (acc >= 0.5) return i;
  }
  return dist.length - 1;
}

/** 这条范围的期望分位，做日志和断言时比桶号直观。 */
export function expectedPercentile(dist: RangeDist, mode: DealMode = DEFAULT_MODE): number {
  const list = buckets(mode);
  let acc = 0;
  for (let i = 0; i < dist.length; i++) acc += dist[i] * list[i].mid;
  return acc;
}
