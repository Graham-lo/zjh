import { socialValue } from './profile.ts';
/**
 * 决策留痕的取样层（设计文档 §4.11.1）。
 *
 * 这一层只做一件事：把「这一步他面对的是什么局面」压成一行**可落库、可比较**的记录。
 * 它不参与决策 —— 机器人怎么打、真人怎么点，跟这个文件一个字的关系都没有。
 *
 * 两条路进来，出来的是同一套字段：
 *
 *   机器人 ──`decide.ts` 已经算好的 `sit` + `adapter.coarse()` ──▶ TraceFeatures
 *   真人   ──`traceHuman()` 现场按**同一个** `coarse()` 打一遍 ──▶ TraceFeatures
 *
 * 「同一套特征」是 §4.11.2 (b) 那张「机器人 vs 真人动作分布差异」表能成立的前提：
 * 两边的桶必须是同一个函数切出来的，否则排出来的差异是特征口径的差异，不是打法的差异。
 *
 * ## 两条红线
 *
 * 1. **真人的牌面不进这一层。** `traceHuman()` 返回的 `strength` 永远是 undefined，
 *    `selfTier` 永远不写。留痕库跟牌桌在同一个进程、同一个磁盘上，真人的牌力一旦
 *    实时落库，这张表就成了一条偷看通道（§4.11.2「牌面信息在亮牌前不记入真人行」）。
 *    亮过的牌在结算时由 `server/trace.ts` 回填，那时候它已经是公开信息了。
 * 2. **信息边界照抄 `bot/index.ts`。** 这里不用它导出的那个函数是为了不把
 *    `index.ts → decide.ts → trace.ts` 绕成一个环；等价性由 `zjh-trace.test.ts`
 *    的「篡改对手暗牌不改变特征」用例守着。
 */

import {
  handPercentile,
  type DealMode,
  type Card, type GameCommand, type PlayerState, type RoomState,
} from '../../game.ts';
import type { CoarseFeatures } from '../../mind/adapter.ts';
import type { DecisionTrace } from '../../mind/dual.ts';
import { readMind, type Drives, type Emotions, type MindState } from '../../mind/emotion.ts';
import { zjhAdapter } from './adapter.ts';
import { unitTier } from './events.ts';
import { COMMON_PERSONA } from './personas/index.ts';
import { archetypeOf, credibility, memoryKey } from './profile.ts';
import { buildSituation, storyHeat, type Candidate, type ZjhSituation } from './situation.ts';

/**
 * 一步动作的**粗特征**（§4.9.7 的那张清单：手牌档 / 故事 / 单价档 / 池感 / 人数 / 位置）。
 *
 * 前五项直接来自通用层的 `CoarseFeatures`（`adapter.coarse()` 的返回值），
 * 后面几项是牌桌侧的客观量 —— 它们不经过人物卡和情绪的滤镜，所以是
 * 机器人和真人唯一能公平对齐的坐标。分析时用客观量分桶、用主观量解释差异。
 */
export interface TraceFeatures {
  /** 主观：他**觉得**自己的牌有多好（经过人物卡原型表和情绪；真人侧不写） */
  selfTier?: number;
  /** 主观：他觉得对面有多凶 */
  threatTier: number;
  /** 这一步要掏的钱占身家 */
  stakeTier: number;
  /** 这个局面对他有多熟（R29） */
  familiarity: number;
  /** 相对参照点的站位 −1..1（赢着还是输着） */
  standing: number;
  /** 客观：真实牌力分位。真人侧留空，结算亮牌后回填 */
  strength?: number;
  /** 客观：桌上这一局讲到哪一步了（最凶的那条动作串） */
  story: number;
  /** 客观：当前单价档位 */
  unitTier: number;
  /** 客观：池子熟到什么程度（对数感知，0..1） */
  potMaturity: number;
  /** 客观：还活着几个人 */
  activeCount: number;
  /** 客观：位置 0..1 */
  position: number;
  /** 客观：闷着没看牌 */
  blind: boolean;
  /** 客观：跟一口占身家的比例 */
  costFraction: number;
  /** 客观 */
  pot: number;
  roundNo: number;
  /** 现在压着他的那个人（房内 id） */
  counterpartKey?: string;
}

/** 当时桌上每个对手的样子：贴的标签 + 记的仇（§4.11.1「当时对手标签与 grudge」）。 */
export interface TraceOpponent {
  id: string;
  key: string;
  name: string;
  /** `archetypeOf` 给的原型名与斜率 */
  archetype: string;
  slope: number;
  credibility: number;
  /** 这一局他讲的故事有多凶 */
  story: number;
  /** 范围模型算出来的威胁 */
  threat: number;
  /** 心理状态里对他记的仇 */
  grudge: number;
}

/** 一次机器人决策的完整留痕 = `zjh_decisions` 的一行。 */
export interface BotTrace {
  memoryKey: string;
  persona: string;
  /** 这一桌的发牌档：牌力分位与桶都随它走，跨档的样本不能直接混着统计 */
  dealMode: DealMode;
  features: TraceFeatures;
  opponents: TraceOpponent[];
  /** 这一局他走的哪条线路（§4.4） */
  plan?: string;
  planCommit?: number;
  /** 通用决策核留下的那条痕（系统 1 冲动 / 系统 2 是否介入 / 触发的规律 / 情绪） */
  decision: DecisionTrace<Candidate>;
  thinkMs: number;
  /** 非回合动作（§4.6）走的是另一条路，分析时要分得开 */
  offTurn: boolean;
}

/** 一次真人动作的留痕 = `zjh_human_actions` 的一行（不含任何牌面信息）。 */
export interface HumanTrace {
  memoryKey: string;
  accountId?: string;
  /** 这一桌的发牌档，口径同 `BotTrace` */
  dealMode: DealMode;
  features: TraceFeatures;
  opponents: TraceOpponent[];
  looked: boolean;
}

/** 落库时用的动作三元组。比 `GameCommand` 扁，SQL 好查。 */
export interface TraceAction {
  type: string;
  unit?: number;
  targetId?: string;
}

export function traceAction(cmd: GameCommand): TraceAction {
  return {
    type: cmd.type,
    unit: cmd.type === 'raise' ? cmd.unit : undefined,
    targetId: cmd.type === 'compare' ? cmd.targetId : undefined,
  };
}

/**
 * 池子「熟」到什么程度：跟开局那点底注比涨了多少倍（对数感知）。
 * 和 `adapter.ts` 里那份是同一个尺度 —— 那一份是决策用的，这一份是分析用的，
 * 各自独立，改一边不影响另一边的行为。
 */
function potMaturityOf(state: RoomState, players: number): number {
  const seed = Math.max(1, state.settings.ante * Math.max(1, players));
  const v = Math.log(Math.max(1, state.pot) / seed) / Math.log(60);
  return Math.max(0, Math.min(1, v));
}

/** 把一个局面 + 通用粗特征压成一行。`self` 决定要不要写他自己的牌力。 */
function featuresOf(sit: ZjhSituation, coarse: CoarseFeatures, self: boolean): TraceFeatures {
  const state = sit.state;
  return {
    selfTier: self ? coarse.selfTier : undefined,
    threatTier: coarse.threatTier,
    stakeTier: coarse.stakeTier,
    familiarity: coarse.familiarity,
    standing: coarse.standing,
    strength: self ? sit.strength : undefined,
    story: sit.opponents.length
      ? Math.max(...sit.opponents.map((o) => storyHeat(o.actions)))
      : 0,
    unitTier: unitTier(state.betUnit, state.settings),
    potMaturity: potMaturityOf(state, state.players.length),
    activeCount: sit.activeCount,
    position: sit.position,
    blind: !sit.bot.looked,
    costFraction: sit.costFraction,
    pot: state.pot,
    roundNo: state.roundNo,
    counterpartKey: coarse.counterpartKey,
  };
}

function opponentsOf(state: RoomState, sit: ZjhSituation, mind: MindState): TraceOpponent[] {
  return sit.opponents.map((o, i) => {
    const arch = archetypeOf(o.read, sit.persona.cognition.classifyOthers, sit.persona.traits.regularities.R17 ?? 1);
    const seat = state.players.find((p) => p.id === o.id);
    return {
      id: o.id,
      key: seat ? memoryKey(seat) : o.id,
      name: seat?.name ?? o.id,
      archetype: arch.learned ?? arch.name,
      slope: arch.slope,
      credibility: credibility(o.read),
      story: storyHeat(o.actions),
      threat: sit.threats[i] ?? 0,
      grudge: socialValue(mind.revenge, state.players, o.id),
    };
  });
}

/**
 * 机器人这一步的留痕。
 *
 * `sit` 和 `mind` 是 `decide.ts` **已经算好的那一份** —— 留痕不重算局面：
 * 重算一遍不但把每步决策的成本翻倍，还会因为 `rng` 又抽了一次而记下另一个局面，
 * 那就不是这一步的痕迹了。
 */
export function traceBot(
  sit: ZjhSituation, mind: MindState, decision: DecisionTrace<Candidate>, thinkMs: number, offTurn: boolean,
): BotTrace {
  const coarse = zjhAdapter(sit).coarse(sit, mind);
  return {
    memoryKey: memoryKey(sit.bot),
    persona: sit.persona.name,
    dealMode: sit.state.settings.dealMode,
    features: featuresOf(sit, coarse, true),
    opponents: opponentsOf(sit.state, sit, mind),
    plan: sit.plan.line,
    planCommit: sit.plan.commit,
    decision,
    thinkMs,
    offTurn,
  };
}

/**
 * 真人这一步的留痕：**同一个 `coarse()`**，只是牌面那一栏空着。
 *
 * 真人没有人物卡也没有情绪状态，所以这里一律用「常人」那张卡和一份干净的心理状态：
 * 出来的 `threatTier` 是「一个普通人坐在这个位置会觉得对面多凶」，
 * 是一把固定的尺子，不同真人之间、真人与机器人之间才比得了。
 *
 * 必须在动作**生效之前**调用 —— 状态一改，「他是顶着一次加注按的弃牌」就找不回来了。
 */
export function traceHuman(state: RoomState, player: PlayerState): HumanTrace {
  const view = throughTheirEyes(state, player);
  const mind = readMind(undefined, COMMON_PERSONA.traits);
  const sit = buildSituation(view.state, view.player, COMMON_PERSONA, mind);
  const coarse = zjhAdapter(sit).coarse(sit, mind);
  return {
    memoryKey: memoryKey(player),
    accountId: player.accountId,
    dealMode: state.settings.dealMode,
    features: featuresOf(sit, coarse, false),
    opponents: opponentsOf(state, sit, mind),
    looked: player.looked,
  };
}

/**
 * 结算时才算得出来的东西：亮过牌的人牌力是多少（§4.11.1「亮牌牌力」）。
 * 没亮的牌一律不算 —— 弃掉的牌到死都没人看过，留痕也不该看。
 */
export function revealedStrength(
  hands: Record<string, Card[]> | undefined,
  revealed: string[] | undefined,
  mode: DealMode = 'standard',
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!hands || !revealed) return out;
  for (const id of revealed) {
    const cards = hands[id];
    // 分位按这一桌的发牌档算，落库的 `deal_mode` 说明这一行该拿哪张表读。
    if (cards?.length === 3) out[id] = handPercentile(cards, mode);
  }
  return out;
}

/** 情绪 / 驱力向量的差（结算触发的增量，§4.11.1）。 */
export function emotionDelta(before: Emotions | undefined, after: Emotions): Partial<Emotions> {
  if (!before) return {};
  const out: Partial<Emotions> = {};
  for (const k of Object.keys(after) as (keyof Emotions)[]) {
    const d = after[k] - before[k];
    if (Math.abs(d) > 1e-6) out[k] = Number(d.toFixed(4));
  }
  return out;
}

export function driveDelta(before: Drives | undefined, after: Drives): Partial<Drives> {
  if (!before) return {};
  const out: Partial<Drives> = {};
  for (const k of Object.keys(after) as (keyof Drives)[]) {
    const d = after[k] - before[k];
    if (Math.abs(d) > 1e-6) out[k] = Number(d.toFixed(4));
  }
  return out;
}

/**
 * 信息边界（和 `bot/index.ts` 的 `throughHisEyes` 等价）。
 *
 * 取样层拿到的是服务端的**完整**状态，里面有所有人的暗牌。打特征之前先把
 * 没资格看的牌清空：这样即使 `range.ts` 哪天改成会去读 `p.hand`，
 * 真人的留痕也不会因此变成一条偷看通道。
 */
function throughTheirEyes(state: RoomState, me: PlayerState) {
  const entitled = new Set(state.seen?.[me.id] ?? []);
  const players = state.players.map((p) => ({
    ...p,
    hand: (p.id === me.id ? me.looked : entitled.has(p.id)) ? p.hand : [],
  }));
  const visible: RoomState = {
    ...state,
    players,
    result: undefined,
    seen: entitled.size ? { [me.id]: [...entitled] } : {},
  };
  const self = players.find((p) => p.id === me.id);
  if (!self) throw new Error('留痕：这个人不在房间里');
  return { state: visible, player: self };
}
