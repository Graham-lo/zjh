/**
 * 一步决策（设计文档 §4.1 / §4.9.7 / §4.10）。
 *
 * 这个文件现在很薄，因为「怎么想」已经不在这里了：
 *
 *   局面 ──`situation.ts`──▶ ZjhSituation ──`adapter.ts`──▶ 通用适配器
 *                                                    │
 *                        `shared/mind/dual.ts` 的 decide() ◀┘
 *                                   │
 *                     系统 1 冲动 → p2 决定要不要开系统 2 → 差距超过自控才推翻
 *                                   │
 *                                   ▼
 *                          一个候选动作 + 用时 + trace
 *
 * **这里一条固定门槛都没有。** 旧版那些 `if (state.roundNo >= 2) return look`、
 * `if (callMargin < 0) return fold`、`strength >= 0.88 才价值梭哈` 全部拆掉了：
 * 轮次、单价、成本占比、压力、人数现在只是评分里的连续输入，
 * 同一段代码换一张人物卡、换一种情绪，出来的就是另一个人在打牌。
 *
 * 留在候选生成里的判断（`situation.ts` 的 `candidatesOf`）全是**引擎规则**——
 * 跟不起、比牌没解锁、梭哈期间只能接或弃 —— 不是决策门槛。
 */

import { GameError, type GameCommand, type PlayerState, type RoomState } from '../../game.ts';
import { decide as dualDecide, type DecisionTrace } from '../../mind/dual.ts';
import { readMind } from '../../mind/emotion.ts';
import { zjhAdapter, type ZjhEvent } from './adapter.ts';
import { feelHand } from './feel.ts';
import { memoryKey, normalizeSocialKeys } from './profile.ts';
import { personaFor } from './personas/index.ts';
import { buildSituation, type Candidate } from './situation.ts';
import { emoteFor, shapeThinkTime } from './tempo.ts';
import { traceBot, type BotTrace } from './trace.ts';
import type { Plan } from './plan.ts';

export { personaFor } from './personas/index.ts';

/** 一步决策：动作本身，加上「他该想多久」，再加上一条可分析的痕迹。 */
export interface BotAction {
  cmd: GameCommand;
  /** 服务器按这个毫秒数排延迟再执行 */
  thinkMs: number;
  /** 直觉还是深思、被哪条规律推了、当时什么情绪（§4.10.4） */
  trace?: DecisionTrace<Candidate>;
  /** 这一局他走的是哪条线路（§4.4），以及在第几个信息点定下的 */
  plan?: Plan;
  /** 这一步之前他刚感受到的局中事件（§4.9.1）。复盘/测试拿它对情绪轨迹 */
  felt?: ZjhEvent[];
  /**
   * 落库用的完整留痕（§4.11.1）：粗特征、当时对手的标签与 grudge、人物卡名。
   * `trace` 是通用决策核的产物，这一条是**牌桌侧**的那一半 —— 服务端把两边
   * 合起来写进 `zjh_decisions`。纯旁路：决策本身一个字都不看它。
   */
  record?: BotTrace;
}

export function decideBot(state: RoomState, bot: PlayerState): BotAction {
  return run(state, bot, true);
}

/**
 * 非回合动作（设计文档 §4.6 / S3 / S4）。
 *
 * 看牌和弃牌在引擎里都**不占行动权** —— 真人也是这么打的：别人加到十万，
 * 我手里一把散牌，不会盯着屏幕干等到轮到自己再点弃牌，我当场就退了；
 * 想看牌的人同理，不会等。所以这里问的不是「他现在该干什么」，
 * 而是「他此刻心里想干的那件事，是不是一件不用等的事」：
 *
 *   把他当作轮到自己那样完整想一遍 → 想弃 / 想看 → 现在就做
 *                                  → 想跟 / 想加 / 想比 → 那得等轮到他
 *
 * 这样非回合动作和回合动作出自**同一个脑子**，不需要第二套规则，
 * 也就不会出现「非回合时是另一个人」的割裂。返回 null = 按兵不动。
 *
 * 这条路径不写回情绪：他只是在旁边看着，真正的一步在轮到他的时候才算数
 * （否则同一手牌的情绪会被反复记两遍，R7 的「意外」也会被冲掉）。
 */
export function decideOffTurn(state: RoomState, bot: PlayerState): BotAction | null {
  if (state.phase !== 'playing') return null;
  if (bot.status !== 'active') return null;
  // 正好轮到他，那就不是非回合动作 —— 交给正常的出牌节拍，别抢在前面
  if (!state.allIn && state.turnSeat === bot.seat) return null;
  if (state.allIn?.pending[0] && state.allIn.pending[0] === bot.id) return null;
  const act = run(state, bot, false);
  if (act.cmd.type === 'look' || act.cmd.type === 'fold') return act;
  // 不看也不弃的时候，他至少可以「啊？」一声（S18 的第三个触发点）。
  return sawAllIn(state, bot);
}

/**
 * 「看到有人梭哈 😱」（§6.3 S18）。
 *
 * 走非回合这条路，因为它就是非回合的事：表情不占行动权、不改牌局，
 * 真人也是先倒吸一口气，再决定看不看牌。发不发、发哪张、发几个全由人物卡
 * （`emotes.rate / favourites / cap`）说了算，这里只提供触发点和「有多响」。
 * 排在 look/fold 后面：他要是真打算做点什么，就没工夫做表情。
 */
function sawAllIn(state: RoomState, bot: PlayerState): BotAction | null {
  const all = state.allIn;
  if (!all || all.initiatorId === bot.id) return null;
  const persona = personaFor(bot);
  if ((bot.emoted ?? 0) >= persona.emotes.cap) return null;
  // 「有多响」= 这一梭要掏的钱相当于我身家的多少（和结算那一处同一把尺子）。
  const price = all.base * (bot.looked ? 2 : 1);
  const face = emoteFor(persona, 'saw-allin', price / Math.max(1, bot.chips), () => Math.random());
  if (!face) return null;
  return { cmd: { type: 'emote', id: face, target: all.initiatorId }, thinkMs: 300 };
}

function run(state: RoomState, bot: PlayerState, persist: boolean): BotAction {
  const persona = personaFor(bot);
  const traits = persona.traits;

  // 跨局的心理状态住在长期档案里（按人索引，不按座位）。
  // `botAction` 的信息边界克隆是浅拷贝，`memory` 是同一个对象 —— 写回去是真的写回去了。
  const key = memoryKey(bot);
  const mem = state.memory?.[key];
  const mind0 = normalizeSocialKeys(readMind(mem?.mind, traits), state.players);

  // 先感受，再想事情（§4.9.1）：上次轮到我之后桌上发生的事 —— 被加档、被梭哈、
  // 有人扔牌走、旁边两个人开了牌、我自己掀开了牌 —— 逐条走「事件 → 评价 →
  // 通用映射表 → 情绪」那条唯一通道。所以这一步的局面是**带着刚被顶起来的情绪**
  // 去读的，而不是拿上一局结算时那张脸。
  // 旁观路径（`decideOffTurn`，persist=false）不消化事件也不推进游标：
  // 他还没真的行动，这些事等轮到他的时候一次性感受，免得同一件事记两遍。
  const felt = persist ? feelHand(state, bot, mind0, traits, mem) : [];

  const sit = buildSituation(state, bot, persona, mind0);
  if (!sit.candidates.length) throw new GameError('没有可选的动作');

  const adapter = zjhAdapter(sit);
  const decision = dualDecide(adapter, sit, mind0, traits, sit.rng, [...sit.fired]);

  if (mem && persist) {
    mem.mind = decision.mind;
    // 事前觉得自己能赢多少 —— 结算时用来算「意外」（bad beat 的入口，R7）
    mem.felt = decision.trace.impulse.feltStrength;
    mem.updatedAt = Date.now();
  }

  const cmd = decision.action.cmd;
  const thinkMs = shapeThinkTime(state, sit, cmd, decision.thinkMs);
  // 留痕是旁路：算不出来就没有，绝不能因为它让机器人不出牌（§4.11.3）
  let record: BotTrace | undefined;
  try {
    record = traceBot(sit, mind0, decision.trace, thinkMs, !persist);
  } catch (e) {
    console.error('[trace] 机器人留痕取样失败', e);
  }
  return { cmd, thinkMs, trace: decision.trace, plan: sit.plan, felt, record };
}
