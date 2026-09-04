/**
 * 用时模型（设计文档 §4.8 的 `tempo.ts`：「用时模型（含读对手用时）+ 表情触发」）。
 *
 * 这个文件回答两个问题，两个都是**领域知识**，所以不在 `shared/mind/` 里：
 *
 *   1. 「他这一步该按多久」—— 通用决策核只知道这一步难不难、他唤醒到什么程度，
 *      牌桌上还有三件事它不知道：看牌几乎不用想、演技（装犹豫 / 秒跟装弱）、
 *      以及**用时会不会随牌力漏出来**（§4.7.4 的 `tempo.leak` / `tempo.tell`）。
 *   2. 「对手用了多久，这说明什么」—— S17，只有 `cognition.readsTiming` 的人读得到。
 *
 * P2 交付时这两件事都是断的：`tempo.leak` 在 `shared/` 里一个消费方都没有，
 * `tempo.theatre` 有消费方但**触发条件是随机数**（`rng('theatre:'+cmd.type)`），
 * 也就是「随机装犹豫、随机秒跟」——和手上的牌力没有任何关系，
 * 于是「大牌装犹豫、小牌秒跟」这条人设在数据上完全量不出来
 * （老王均用时 528ms，牌力档间无差）。见 `docs/zjh/personas.md`「待集成」#1 #4 #7 #8。
 */

import type { GameCommand, GameSettings, RoomState } from '../../game.ts';
import { categoryBands } from '../../game.ts';
import type { HandEvent } from './events.ts';
import type { Persona, TempoTell } from './personas/types.ts';

/** 引擎地板：比这更快就不像人在按了。 */
const FLOOR_MS = 240;

/**
 * `leak = 1` 时，用时在牌力两端之间摆动的幅度（相对倍数）。
 *
 * 定这个数的是 §4.7.3 那三条破绽自带的验收线里最紧的一条：新手要求
 * 「s≤0.30 比 s≥0.70 慢 ≥200ms」。她的基础节奏只有 340ms，而快的那一头
 * 会被引擎的 240ms 地板削平 —— 于是差值几乎全靠慢的那一头往上抬，
 * 0.55 实测只到 163ms，0.75 到 218ms（3000 手自对弈，见报告）。
 * 取 0.75。数学型那条只要 ≥120ms，同一个数下有 400ms 以上的余量。
 */
const LEAK_SPAN = 0.75;

/**
 * 演技的档线。直接取 `docs/zjh/personas.md`「待集成」#1 里那条验收口径：
 * `mean(s≥0.75) − mean(s≤0.35) ≥ 150ms`，所以触发线就设在 0.75 / 0.35，
 * 免得「量的档」和「演的档」是两套数。
 */
const THEATRE_HIGH = 0.75;
const THEATRE_LOW = 0.35;

/**
 * 演技强度到倍数的映射。`theatre = 1` 时是 ×1.9 / ×0.35 ——
 * 就是 P2 那两个随机分支用的倍数，只是触发条件从掷骰子换成了牌力，
 * 并且强度按 `theatre` 线性缩放（不演的人 `theatre≈0`，倍数退回 1）。
 */
const THEATRE_SLOW = 0.90;
const THEATRE_FAST = 0.65;

/**
 * 牌力 → 用时倍数里的那个 [-1, 1] 形状项。
 *
 * `+1` = 这一档他想得最久，`-1` = 想得最快。三条曲线分别对应
 * §4.7.3 里三张卡的原话，见 `TempoPolicy.tell`。
 */
/**
 * 「最近演砸过几次」之后还剩多少表演欲。
 *
 * `personas.md`「待集成」#3 的建议原文是「供 `tempo.theatre` 按 `1 − caught*k` 缩放」。
 * 这里做成一个共用函数，因为**两个地方都得用同一个数**：
 *   - `shapeThinkTime()` 的「大牌装犹豫、小牌秒跟」（用时那一半）；
 *   - `adapter.ts` 偷池打分里的 `bluff` 项（动作那一半）——
 *     `bluff` 本来就乘着 `tempo.theatre`，「爱演的人才去试」。
 * 只削用时不削动作，那叫「嘴上说不敢演」；老王卡上写的是「被抓两次后一段时间不敢演」。
 * `caught` 封顶 3、每局 ×0.90，所以「一段时间」是它自己走完的，不用另设窗口。
 */
export function theatreDamp(caught: number): number {
  return 1 - Math.min(1, caught / 2) * 0.80;
}

export function theatreNow(theatre: number, caught: number): number {
  return theatre * theatreDamp(caught);
}

export function tellCurve(tell: TempoTell, s: number): number {
  switch (tell) {
    case 'strong-slow': return 2 * s - 1;              // 牌好想得久
    case 'weak-slow': return 1 - 2 * s;                // 牌越差想越久
    case 'edge-slow': return 1 - 2 * Math.abs(2 * s - 1); // 边缘慢、两极快
    default: return 0;
  }
}

/**
 * 把通用决策核给出的用时修成「牌桌上的用时」。
 *
 * 顺序是有讲究的：先漏（`tell`，他控制不了的那一半），再演（`theatre`，
 * 他故意做出来的那一半），最后才是「秒加」这种动作联动。
 * 三项都只在**他看过牌**的时候生效 —— 闷着的人不知道自己拿了什么，
 * 既漏不出牌力，也没法按牌力演。这是 P2 版本最大的一处失真：
 * 那时候连闷牌的人都会「装犹豫」。
 */
export function shapeThinkTime(
  state: RoomState,
  sit: {
    persona: Persona;
    strength?: number;
    bot: { looked: boolean };
    /** 只用到「演戏被抓过几次」这一项（R8 的后效，见下面 `shy`） */
    mind: { caught: number };
    rng: (purpose: string) => number;
  },
  cmd: GameCommand,
  base: number,
): number {
  const cap = Math.max(700, state.settings.turnSeconds * 1000 / 2 - 200);
  const jitter = sit.rng(`think:${cmd.type}`);
  if (cmd.type === 'look') return Math.round(260 + jitter * 260);

  let ms = base;
  const tempo = sit.persona.tempo;
  const s = sit.bot.looked ? sit.strength : undefined;

  if (s !== undefined) {
    // ① 破绽：用时随牌力（#4 #7，以及岩石的「牌好想得久」）
    ms *= 1 + tempo.leak * LEAK_SPAN * tellCurve(tempo.tell, s);

    /*
     * ② 演技：大牌装犹豫、小牌秒跟（#1）。
     *
     * 强度要先被「最近演砸过几次」削一刀（`personas.md`「待集成」#3 的建议原文：
     * 「供 `tempo.theatre` 按 `1 − caught*k` 缩放」）。被当场比穿两次之后他会
     * 老实一段时间 —— 表演本身也停掉，不然嘴上说不敢演、用时上还在演。
     * `caught` 每局 ×0.90 衰减，所以「一段时间」是自己走完的，不用另设窗口。
     */
    const theatre = theatreNow(tempo.theatre, sit.mind.caught);
    if (s >= THEATRE_HIGH) ms *= 1 + theatre * THEATRE_SLOW;
    else if (s <= THEATRE_LOW) ms *= 1 - theatre * THEATRE_FAST;

    // ③ 「拿大牌忍不住秒加」（#8）：只在他自己开火、且金花以上时触发。
    //    档线从 `categoryBands` 取，不写死分位（硬要求 1）。
    const flushLo = categoryBands(state.settings.dealMode)[4][0];
    if (tempo.snapRaise > 0 && (cmd.type === 'raise' || cmd.type === 'all_in') && s >= flushLo) {
      ms = Math.min(ms, FLOOR_MS + (1 - tempo.snapRaise) * 600);
    }
  }

  return Math.round(Math.min(cap, Math.max(FLOOR_MS, ms)));
}

/* ------------------------------------------------------------ 表情触发（S18） */

/**
 * S18 那一行的三个触发点，逐字照抄：「我赢下 40 万的池 / 被梭哈掀掉 / 看到有人梭哈」。
 * 表情在 P2 是纯配置（人物卡上填了 `emotes`，`shared/` 里一个消费方都没有），
 * 这张表就是 §6.3 S18 说的「事件→表情触发表，概率随性格」。
 */
export type EmoteTrigger = 'won-big' | 'busted' | 'saw-allin';

/** 触发点 → 那张脸（S18 原话 🔥 / 😭 / 😱）。 */
const EMOTE_FACE: Record<EmoteTrigger, string> = {
  'won-big': '🔥',
  busted: '😭',
  'saw-allin': '😱',
};

/**
 * 这一件事值不值得做个表情。
 *
 * `weight` 是 0..1 的「这一下有多大」——S18 的例子是「赢下 **40 万** 的池」，
 * 也就是**大**才有反应。调用方用的是和 `magnitudeOf` 同一把尺子
 * （这一下相当于身家的多少），所以这里不写死 40 万这个绝对数。
 *
 * 概率 = 卡上的 `rate` × 这一下的大小。于是同一件事，
 * 赌徒（`rate 0.95`）几乎每次都有反应，老油条（0.05）一年做一次表情。
 * 脸从卡上的偏好表里挑：S18 那张脸在他的偏好里就用那张，不在就退回他最常用的
 * ——「表情🙏为主」的人被梭掀掉也是 🙏，这正是人物卡想要的效果。
 */
export function emoteFor(
  persona: Persona,
  trigger: EmoteTrigger,
  weight: number,
  rng: (purpose: string) => number,
  showoff = 0,
): string | null {
  const e = persona.emotes;
  if (!(e.rate > 0) || !e.favourites.length) return null;
  const p = Math.min(1, e.rate * Math.min(1, Math.max(0, weight)) * (1 + Math.max(0, showoff) * (persona.traits.regularities.R25 ?? 1)));
  if (rng(`emote:${trigger}`) >= p) return null;
  const face = EMOTE_FACE[trigger];
  return e.favourites.includes(face) ? face : e.favourites[0];
}

/* ------------------------------------------------------------ 读对手的用时 */

/**
 * 这个动作用掉了时限的百分之多少（0–1）；没有记录到用时就返回 null。
 *
 * 服务端在 `noteAction` 里按设计文档 §4.8 的公式落 `msSpent`
 * （`Date.now() - (turnDeadline - turnSeconds*1000)`，机器人则直接落它的 `thinkMs`）。
 * 归一化成比例而不是直接用毫秒，是因为 S17 的原话是「30 秒时限里用了 25 秒」——
 * 说的是**占时限的比例**，同一个 8 秒在 10 秒局和 60 秒局里根本不是一回事。
 */
export function spentFraction(ev: HandEvent, settings: Pick<GameSettings, 'turnSeconds'>): number | null {
  const total = settings.turnSeconds * 1000;
  if (!(total > 0)) return null;
  const ms = ev.msSpent;
  if (typeof ms !== 'number' || !(ms > 0)) return null;
  return Math.min(1, ms / total);
}

/** 「长考」与「秒出手」的两条线，取自 S17 的原话（用了时限的 60%）。 */
export const LONG_THINK = 0.60;
export const SNAP = 0.12;

/**
 * 用时这一条弱信号对范围的乘子（设计文档 §4.3「用时进似然」）。
 *
 * 只有两条，都直接来自 §4.3 那一行：
 *
 * > 用时（S17）：超过时限 60% 才跟 → 乘一个偏弱的向量；秒加 → 偏两极（强或演）。
 *
 * 返回 `null` = 这个动作没有用时信号，调用方原样跳过。
 * 强度刻意压得比动作本身的似然低一个量级（斜率 0.5 / 0.35 对比动作的 1.9–3.0）：
 * 真人也只把用时当弱信号，读重了会把一个网卡顿读成一手散牌。
 */
export function timingLikelihood(
  ev: HandEvent,
  settings: Pick<GameSettings, 'turnSeconds'>,
): ((mid: number) => number) | null {
  if (!ev.looked) return null;  // 闷着的人的用时和他手里是什么无关（同 §6.4 的闷牌似然）
  const f = spentFraction(ev, settings);
  if (f === null) return null;
  if (ev.kind === 'call' && f >= LONG_THINK) {
    // 长考之后**只是跟**：他在犹豫，多半是边缘牌 —— 往弱的一头偏。
    const w = Math.min(1, (f - LONG_THINK) / (1 - LONG_THINK));
    return (mid: number) => Math.max(0.05, 1 + 0.50 * w * (0.5 - mid) * 2);
  }
  if ((ev.kind === 'raise' || ev.kind === 'all_in') && f <= SNAP) {
    // 秒加：要么真强要么在演 —— 两极都抬，中间压下去。
    return (mid: number) => Math.max(0.05, 1 + 0.35 * (Math.abs(mid - 0.5) * 2 - 0.5) * 2);
  }
  return null;
}
