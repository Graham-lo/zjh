import { addPublicStats, classifyPublic, type PublicStats } from './learned.ts';
/**
 * 跨局记忆与对手归类（设计文档 §4.7.5 / §4.7.6）。
 *
 * 旧版的 `state.reads` 有两个毛病：键是**房内 id**（换个房间这个人就重新是陌生人），
 * 统计也不分条件（「他在底注档上加过」和「他在 10 万档上加过」混在一格里）。
 * 这里把记忆挪出房间状态、按账户/机器人名字长期累计，并按
 * `{闷或看} × {单价档位} × {是否三人以上}` 分桶。
 *
 * 记的东西**全部是桌面上人人都能看到的**：他做过的动作、他亮过的牌。暗牌永远不进来。
 * 这一份数据不下发给客户端（`sanitizeRoom` 会剥掉），真人自己看桌子就好。
 */

import type { PlayerState, TableRead } from '../../game.ts';
import type { MindState } from '../../mind/emotion.ts';
import type { FeelCursor } from './feel.ts';
import { COMMON, type Archetype } from './range.ts';

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/** 一个条件格子里的计数。 */
export interface MemoryBucket {
  call: number;
  raise: number;
  compare: number;
  allIn: number;
  fold: number;
  pressureFaced: number;
  foldsToPressure: number;
  /** 在这个条件下动过手、并且最后亮了牌的次数与牌力之和 */
  showdowns: number;
  showdownStrength: number;
}

/** 一个人的长期档案。key 见 `memoryKey`。 */
export interface BotMemory {
  key: string;
  publicStats?: PublicStats;
  recent?: { at: number; read: TableRead }[];
  handStart?: TableRead;
  hands: number;
  played: number;
  aggressive: number;
  passive: number;
  pressureFaced: number;
  foldsToPressure: number;
  showdowns: number;
  showdownStrength: number;
  bluffsCaught: number;
  /** 面对别人的梭哈需要表态的次数 / 其中接下来的次数（§4.6 的发起端统计） */
  allInFaced?: number;
  allInTaken?: number;
  /** 条件分桶，键见 `bucketKey` */
  buckets: Record<string, MemoryBucket>;
  /** 被谁比掉/梭掉的记账，键是对方的长期记忆键（`memoryKey`） */
  grudge: Record<string, number>;
  /**
   * 跨局的心理状态（`shared/mind/` 的 `MindState`）：七情、驱力、报复心、
   * 连输连赢、意志力预算、参照点。旧快照里没有这一块，读的时候用 `readMind` 兜底。
   */
  mind?: MindState;
  /** 上一手他**事前觉得**自己能赢的概率，结算时用来算「意外」（bad beat 的入口） */
  felt?: number;
  /** 本局的公开事件已经感受到哪儿了（`feel.ts` 的游标，§4.9.1 的事件通道） */
  feelAt?: FeelCursor;
  updatedAt: number;
}

export function emptyBucket(): MemoryBucket {
  return {
    call: 0, raise: 0, compare: 0, allIn: 0, fold: 0,
    pressureFaced: 0, foldsToPressure: 0, showdowns: 0, showdownStrength: 0,
  };
}

export function emptyMemory(key: string): BotMemory {
  return {
    key,
    hands: 0, played: 0, aggressive: 0, passive: 0,
    pressureFaced: 0, foldsToPressure: 0, showdowns: 0, showdownStrength: 0, bluffsCaught: 0,
    allInFaced: 0, allInTaken: 0,
    buckets: {}, grudge: {}, updatedAt: 0,
  };
}

/**
 * 记忆的键。
 *
 * 真人按账户 —— 换个房间、隔天再来还是那个人，朋友局里「老张一晚上只打三把」
 * 本来就是隔天也记得的事。机器人按名字 —— 同名机器人跨房间是同一个人（§4.7.1）。
 * 都没有的（临时席位、测试里的裸 PlayerState）退回房内 id，只在本房间有效。
 */
export function memoryKey(p: Pick<PlayerState, 'id' | 'name' | 'isBot' | 'accountId'>): string {
  if (p.isBot) return `bot:${p.name}`;
  if (p.accountId) return `acc:${p.accountId}`;
  return `local:${p.id}`;
}

/** 条件格子的键：闷/看 × 单价档位 × 人多人少。 */
export function bucketKey(looked: boolean, tier: number, multiway: boolean): string {
  return `${looked ? 'L' : 'B'}${tier}${multiway ? 'M' : 'H'}`;
}

export function editBucket(mem: BotMemory, key: string): MemoryBucket {
  mem.buckets[key] ??= emptyBucket();
  return mem.buckets[key];
}

/** 把长期档案压成旧的 `TableRead` 形状。既有代码（含 v2 快照）读的都是这个。 */
export function toTableRead(mem: BotMemory | undefined): TableRead {
  return {
    ...(mem?.publicStats ? { publicStats: mem.publicStats } : {}),
    ...(mem?.recent ? { recent: mem.recent.slice(-3).map(x => x.read) } : {}),
    hands: mem?.hands ?? 0,
    played: mem?.played ?? 0,
    aggressive: mem?.aggressive ?? 0,
    passive: mem?.passive ?? 0,
    pressureFaced: mem?.pressureFaced ?? 0,
    foldsToPressure: mem?.foldsToPressure ?? 0,
    showdowns: mem?.showdowns ?? 0,
    showdownStrength: mem?.showdownStrength ?? 0,
    bluffsCaught: mem?.bluffsCaught ?? 0,
    allInFaced: mem?.allInFaced ?? 0,
    allInTaken: mem?.allInTaken ?? 0,
  };
}

/** 旧快照里的 `state.reads[id]` 一次性并进长期档案（迁移用，不覆盖已有的累计）。 */
export function mergeLegacyRead(mem: BotMemory, read: Partial<TableRead>): BotMemory {
  mem.hands += read.hands ?? 0;
  mem.played += read.played ?? 0;
  mem.aggressive += read.aggressive ?? 0;
  mem.passive += read.passive ?? 0;
  mem.pressureFaced += read.pressureFaced ?? 0;
  mem.foldsToPressure += read.foldsToPressure ?? 0;
  mem.showdowns += read.showdowns ?? 0;
  mem.showdownStrength += read.showdownStrength ?? 0;
  mem.bluffsCaught += read.bluffsCaught ?? 0;
  mem.allInFaced = (mem.allInFaced ?? 0) + (read.allInFaced ?? 0);
  mem.allInTaken = (mem.allInTaken ?? 0) + (read.allInTaken ?? 0);
  return mem;
}

/**
 * 这个人的凶悍值多少钱（设计文档 §4.3「可信度」）。
 *
 * 同一个加注，从一整晚只打过三把牌的紧手嘴里说出来，和从每手都加的疯子嘴里说出来，
 * 完全不是一回事。样本不够时按常人算，不瞎猜。
 *
 * **只用三个信号，而且都是「他自己交出来的证据」**：
 *
 * | 信号 | 含义 | 系数 | 实测区分度（脚本对手 400 局） |
 * |---|---|---|---|
 * | `摊牌均强 − 0.62` | 他愿意亮的牌有多硬 | ×1.9 | 岩石 .827 / 疯子 .598 / 常人 .76–.79 |
 * | `遇压弃牌率 − 0.35` | 他会不会退 —— 从不退的人范围没被筛过 | ×0.55 | 岩石 .618 / 疯子 .236 / 跟注站 .091 |
 * | `抓到诈唬 / 摊牌次数` | 他吹过多少次牛被当场揭穿 | ×1.1（减） | 岩石 .026 / 疯子 .265 / 跟注站 .220 |
 *
 * 老版本用的是 `aggressive / (aggressive + passive)`（「加注占全部动作的比例」）。
 * 那一项**根本分不开人**：实测岩石 .243、疯子 .290、常人 .284 —— 因为疯子加到顶档
 * 之后只能跟，跟的次数把比例拉平了；而弃牌压根不进这个分母。用它算出来的可信度是
 * 疯子 0.68 / 岩石 0.99 / 跟注站 0.84，于是「面对疯子的加注」和「面对岩石的加注」
 * 得到的威胁值几乎一样（§6.2 实测弱牌遇压弃牌率 疯子 84.4% vs 岩石 76.2%，
 * 方向还是反的）。上面这三项换掉它之后是 疯子 0.22 / 岩石 1.00 / 跟注站 0.21。
 *
 * 样本门槛：摊牌 < 2 次按 0.62 的常态基准；被压 < 4 次按 0.35；摊牌 < 4 次不谈抓诈唬。
 * 「没见过他退」和「他从不退」是两回事，样本不够时不许当证据用。
 */
export const CRED_BASE = 0.62;
export const CRED_SHOWDOWN = 1.9;
export const CRED_FOLD = 0.55;
export const CRED_CAUGHT = 1.1;

export function credibility(read: TableRead, recency = 1): number {
  if (read.hands < 3) return 1;
  // R17: lifetime totals already include the last three hands once. Add them once more
  // for the specified 2x impression weight. Missing public observations contribute nothing.
  if (recency > 0 && read.recent?.length) {
    const weighted = { ...read, recent: undefined };
    for (const recent of read.recent) {
      for (const k of ['showdowns', 'showdownStrength', 'pressureFaced', 'foldsToPressure', 'bluffsCaught'] as const) {
        weighted[k] += recent[k] * recency;
      }
    }
    return credibility(weighted, 0);
  }
  const strength = read.showdowns >= 2 ? read.showdownStrength / read.showdowns : CRED_BASE;
  const fold = read.pressureFaced >= 4 ? read.foldsToPressure / read.pressureFaced : 0.35;
  const caught = read.showdowns >= 4 ? read.bluffsCaught / read.showdowns : 0;
  return clamp01(CRED_BASE + (strength - CRED_BASE) * CRED_SHOWDOWN
    + (fold - 0.35) * CRED_FOLD - caught * CRED_CAUGHT);
}

/**
 * 把一个人归到似然表的原型上。
 *
 * 这一期只有一张「常人」表，原型对它做整体形变：`slope` 大 = 他的动作可信
 * （岩石加注就是亮牌），小 = 他的动作不值钱（疯子加注什么都不是）。
 * 样本不足一律按常人，不凭三手牌就给人贴标签。
 */
export function archetypeOf(read: TableRead, classification: 'none' | 'coarse' | 'fine' = 'coarse', recency = 1): Archetype {
  if (classification === 'none') return COMMON;
  if (read.hands < 3) return COMMON;
  const cred = credibility(read, recency);
  const classified = classification === 'fine' && read.hands >= 20 ? classifyPublic(read.publicStats) : undefined;
  const name = cred >= 0.80 ? 'tight' : cred <= 0.45 ? 'loose' : 'common';
  /**
   * 平方是有意的：可信度是**乘在每一个动作上**的，线性缩放不够狠。
   * 一晚上梭过四次、被抓两次的人再梭一次，那一下应该几乎不含信息（slope→0.2），
   * 而不是「打个八折的强信号」——「疯子梭哈要接、老实人梭哈要弃」（S8/S9）
   * 是同一个价格上完全相反的两个决定，中间隔的就是这个平方。
   */
  return { name, slope: 0.15 + 2.05 * cred * cred, learned: classified && classified.confidence >= 0.2 ? classified.name : undefined };
}

/**
 * 两份档案合并（长期表里的那份 + 房间里刚攒的那份）。
 *
 * 只在「从库里补水」的那一刻用一次：房间快照里可能已经有迁移出来的旧笔记，
 * 库里也有这个人的长期记录，两边都要留。之后房间里就只有合并后的那一份。
 */
export function mergeMemory(target: BotMemory, source: BotMemory): BotMemory {
  mergeLegacyRead(target, toTableRead(source));
  for (const [key, b] of Object.entries(source.buckets)) {
    const dst = editBucket(target, key);
    dst.call += b.call;
    dst.raise += b.raise;
    dst.compare += b.compare;
    dst.allIn += b.allIn;
    dst.fold += b.fold;
    dst.pressureFaced += b.pressureFaced;
    dst.foldsToPressure += b.foldsToPressure;
    dst.showdowns += b.showdowns;
    dst.showdownStrength += b.showdownStrength;
  }
  for (const [id, v] of Object.entries(source.grudge)) target.grudge[id] = (target.grudge[id] ?? 0) + v;
  // 心理状态取「最近更新的那一份」：它是状态不是计数，两边相加没有意义。
  if (source.mind && source.updatedAt >= target.updatedAt) target.mind = source.mind;
  if (source.publicStats) target.publicStats = target.publicStats
    ? addPublicStats(target.publicStats, source.publicStats) : { ...source.publicStats };
  if (source.recent?.length) target.recent = [...(target.recent ?? []), ...source.recent]
    .sort((a, b) => a.at - b.at).slice(-3);
  target.updatedAt = Math.max(target.updatedAt, source.updatedAt);
  return target;
}

/** Stable social identity; old room-keyed snapshots are read once at the adapter boundary. */
export function socialKey(players: readonly PlayerState[], id: string): string {
  const p = players.find(p => p.id === id);
  return p ? memoryKey(p) : id;
}
export function socialValue(values: Record<string, number>, players: readonly PlayerState[], id: string): number {
  return values[socialKey(players, id)] ?? values[id] ?? 0;
}

/** Upgrade old room-local social keys while the matching seats are still available. */
export function normalizeSocialKeys(mind: MindState, players: readonly PlayerState[]): MindState {
  for (const field of ['revenge', 'pressedBy', 'bluffedBy', 'impression'] as const) {
    const values = mind[field] as Record<string, unknown>;
    for (const p of players) {
      if (!(p.id in values)) continue;
      const key = memoryKey(p);
      values[key] ??= values[p.id];
      if (key !== p.id) delete values[p.id];
    }
  }
  return mind;
}
