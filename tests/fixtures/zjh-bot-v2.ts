/**
 * 炸金花机器人 V2 快照（2026-09-03 改造前的那一版）。
 *
 * 这是**对照组**，不是活代码：`shared/game.ts` 里的 `decideBot` 及其全部依赖
 * 原样搬过来，逻辑一字未改，只调了 import 路径和一处 `handActions` 的类型适配
 * （事件流从 `string[]` 变成了结构化事件，这里把它映回动作名，保证行为完全等价）。
 *
 * 用途：`tests/zjh-arena.ts` 的永久 A/B 基准。新大脑改到什么程度，都要能在竞技场里
 * 打赢这一版才算有进步。
 *
 * **不要在这里修 bug、不要跟着新大脑同步改动。** 它一旦被改，历史数字就不可比了。
 */

import {
  GameError, allInCost, callCost, canAllInNow, canCompareNow, compareCost, handPercentile, tableRead,
  type GameCommand, type PlayerState, type RoomState, type TableRead,
} from '../../shared/game.ts';

/** V2 的对外入口：和当年的 `botAction` 同样的信息边界（对手 hand 一律清空）。 */
export function botActionV2(state: RoomState, bot: PlayerState): BotAction {
  const players = state.players.map((p) => ({
    ...p,
    hand: p.id === bot.id && bot.looked ? p.hand : [],
  }));
  const visibleState: RoomState = { ...state, players, result: undefined, seen: {} };
  const visibleBot = players.find((p) => p.id === bot.id);
  if (!visibleBot) throw new GameError('机器人不在当前房间');
  return decideBot(visibleState, visibleBot);
}

export function botDecisionV2(state: RoomState, bot: PlayerState): GameCommand {
  return botActionV2(state, bot).cmd;
}

export interface BotPersonality {
  /** 主动加注、比牌和价值梭哈的倾向 */
  aggression: number;
  /** 在边缘赔率下继续游戏的宽松程度 */
  looseness: number;
  /** 合适局面下诈唬的频率 */
  bluffRate: number;
  /** 愿意为了获取信息而看牌、避开高波动的程度 */
  patience: number;
  /** 愿意用有效筹码承受波动的程度 */
  riskTolerance: number;
  /** 强牌慢打、弱牌代表强牌的混合程度 */
  deception: number;
  /** 根据桌况偏离基础性格的幅度 */
  adaptability: number;
}

const BOT_PERSONALITIES: Record<string, BotPersonality> = {
  阿凯: { aggression: 0.78, looseness: 0.58, bluffRate: 0.10, patience: 0.38, riskTolerance: 0.72, deception: 0.42, adaptability: 0.66 },
  老陈: { aggression: 0.36, looseness: 0.34, bluffRate: 0.03, patience: 0.86, riskTolerance: 0.32, deception: 0.35, adaptability: 0.48 },
  小北: { aggression: 0.58, looseness: 0.72, bluffRate: 0.09, patience: 0.50, riskTolerance: 0.58, deception: 0.55, adaptability: 0.72 },
  阿杰: { aggression: 0.72, looseness: 0.46, bluffRate: 0.07, patience: 0.44, riskTolerance: 0.75, deception: 0.46, adaptability: 0.62 },
  小林: { aggression: 0.48, looseness: 0.40, bluffRate: 0.04, patience: 0.78, riskTolerance: 0.44, deception: 0.38, adaptability: 0.82 },
  老王: { aggression: 0.64, looseness: 0.56, bluffRate: 0.16, patience: 0.58, riskTolerance: 0.64, deception: 0.88, adaptability: 0.86 },
};

/**
 * 性格跟着机器人身份走，不会每一步随机换人格。预置机器人各有明显风格，
 * 额外创建的机器人则从 id 稳定派生一套均衡参数。
 */
export function botPersonality(bot: Pick<PlayerState, 'id' | 'name'>): BotPersonality {
  const preset = BOT_PERSONALITIES[bot.name];
  if (preset) return { ...preset };
  const trait = (name: string) => pseudoRandom(`${bot.id}:personality:${name}`);
  return {
    aggression: 0.35 + trait('aggression') * 0.45,
    looseness: 0.30 + trait('looseness') * 0.45,
    bluffRate: 0.03 + trait('bluff') * 0.13,
    patience: 0.35 + trait('patience') * 0.50,
    riskTolerance: 0.30 + trait('risk') * 0.48,
    deception: 0.30 + trait('deception') * 0.58,
    adaptability: 0.40 + trait('adaptability') * 0.48,
  };
}

interface BotOpponentView {
  id: string;
  seat: number;
  chips: number;
  looked: boolean;
  bet: number;
  wins: number;
  lastAction?: string;
  /** 本局的完整动作序列 */
  actions: string[];
  /** 跨局累积的公开笔记 */
  read: TableRead;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/** 这里只提取公开字段，刻意没有 hand；后面的决策代码拿不到对手暗牌。 */
function botOpponentViews(state: RoomState, bot: PlayerState): BotOpponentView[] {
  return state.players
    .filter((p) => p.id !== bot.id && p.status === 'active')
    .map((p) => ({
      id: p.id,
      seat: p.seat,
      chips: p.chips,
      looked: p.looked,
      bet: p.bet,
      wins: p.wins,
      lastAction: p.lastAction,
      actions: (p.handActions ?? []).map((e) => e.kind),
      read: tableRead(state, p.id),
    }));
}

/**
 * 这一局他讲了个什么故事。
 *
 * 只看最后一个动作是读不懂牌的：「连加两手」和「加了一手之后缩回去只跟」
 * 是完全相反的两个意思，可最后一个动作都是「跟」。人读牌读的是整串动作，
 * 尤其是**节奏的变化** —— 突然发力和突然刹车，都是信息。
 */
function storyHeat(actions: string[]): number {
  if (!actions.length) return 0.08;
  const count = (kind: string) => actions.filter((a) => a === kind).length;
  const raises = count('raise');
  const calls = count('call');
  const last = actions[actions.length - 1];

  if (count('all_in')) return 0.95;
  // 连续发力：加了不止一次，几乎不可能是空气
  if (raises >= 2) return 0.88;
  if (raises === 1) {
    // 加完之后又只跟 —— 踩了刹车，这是变弱的信号，比一直没动过还可疑
    const braked = actions.indexOf('raise') < actions.lastIndexOf('call');
    return braked ? 0.44 : 0.70;
  }
  // 比过牌还站着，说明他手上真有东西 —— 这是被牌面证明过的强度
  if (count('compare')) return 0.66;
  if (calls >= 3) return 0.40;
  if (calls === 2) return 0.32;
  if (calls === 1) return 0.24;
  return last === 'look' ? 0.15 : 0.10;
}

/**
 * 这个人的凶悍值多少钱。
 *
 * 同一个加注，从一整晚只打过三把牌的紧手嘴里说出来，和从每手都加的疯子嘴里说出来，
 * 完全不是一回事。真人靠的就是这个 —— 记住谁老实、谁爱吹，然后据此打折或者加价。
 * 样本不够时按常人算，不瞎猜。
 */
function credibility(read: TableRead): number {
  if (read.hands < 3) return 1;
  const acts = read.aggressive + read.passive;
  const aggressionRate = acts >= 6 ? read.aggressive / acts : 0.35;
  // 他愿意亮出来的牌一般有多硬。0.6 是这套牌型分布下的常态基准。
  const showdownStrength = read.showdowns >= 2 ? read.showdownStrength / read.showdowns : 0.6;
  const caught = Math.min(0.25, read.bluffsCaught * 0.09);
  return clamp01(1.15 - aggressionRate * 0.75 + (showdownStrength - 0.6) * 0.5 - caught);
}

/** 一个对手当下有多可怕：他讲的故事 × 他这个人的可信度。 */
function opponentThreat(view: BotOpponentView): number {
  return clamp01(storyHeat(view.actions) * credibility(view.read));
}

/**
 * 偷池成功率：一加注就把所有人吓走的概率。
 *
 * 人不是随机诈唬的，是**挑人**诈唬 —— 桌上都是一加就跑的人才值得去偷，
 * 有一个说什么都要跟的站在那里，这个池子就偷不动。所以要连乘，不是取平均。
 */
function foldEquity(opponents: BotOpponentView[]): number {
  if (!opponents.length) return 1;
  return opponents.reduce((product, o) => {
    const r = o.read;
    // 还没看够这个人的时候按常人算 0.5：炸金花绝大多数手牌是散牌，面对加注
    // 跑掉本来就是多数派。之前这里写 0.42，两家对手一乘只剩 0.17，刚好卡在
    // 诈唬门槛下面 —— 实测九百多次加注里只有一次诈唬，等于这套牌桌上没人吹牛。
    const folds = r.pressureFaced >= 3 ? clamp01(r.foldsToPressure / r.pressureFaced) : 0.5;
    return product * clamp01(0.12 + folds * 0.82);
  }, 1);
}

function tablePressure(state: RoomState, opponents: BotOpponentView[]): number {
  if (!opponents.length) return 0;
  const actionPressure = opponents.reduce((sum, p) => sum + opponentThreat(p), 0) / opponents.length;
  const commitment = opponents.reduce(
    (sum, p) => sum + Math.min(1, p.bet / Math.max(state.settings.ante, state.pot)),
    0,
  ) / opponents.length;
  const looked = opponents.filter((p) => p.looked).length / opponents.length;
  /**
   * 底注被抬到了什么价位，本身就是桌上最响的一个信号。
   *
   * 只统计「谁做过什么动作」会漏掉这一层：一手牌从开局底注打到几十倍，
   * 哪怕这一轮大家都只是平跟，场面也早就不是开局那个场面了。
   * 翻到十六倍算满档（log2 除以 4），再往上就是同一个「已经在开火」的量级。
   */
  const escalation = clamp01(
    Math.log2(Math.max(1, state.betUnit) / Math.max(1, state.settings.betOptions[0])) / 4,
  );
  return clamp01(actionPressure * 0.46 + commitment * 0.22 + looked * 0.12 + escalation * 0.20);
}

/** 每个公开局面上的随机量是确定的：可复测，也不会因为改了对手暗牌而改变。 */
function botRoll(state: RoomState, bot: PlayerState, purpose: string): number {
  return pseudoRandom(`${bot.id}:${state.handNo}:${state.roundNo}:${state.turnCount}:${state.actionSeq}:${purpose}`);
}

/**
 * 基础性格只是长期倾向，临场会切换档位：高压/短码收紧，后位单挑或大筹码领先时施压，
 * 后段则减少试探。adaptability 决定偏离基础人格能有多远。
 */
function adaptPersonality(
  base: BotPersonality,
  state: RoomState,
  bot: PlayerState,
  opponents: BotOpponentView[],
  pressure: number,
  position: number,
  costFraction: number,
): BotPersonality {
  const p = { ...base };
  const shift = base.adaptability;
  const averageOpponentStack = opponents.length
    ? opponents.reduce((sum, opponent) => sum + opponent.chips, 0) / opponents.length
    : bot.chips;

  if (pressure >= 0.58 || costFraction >= 0.12) {
    // 防守档：对手持续施压或一口价已伤到身家时，连激进型也会收紧范围。
    p.aggression -= 0.18 * shift;
    p.looseness -= 0.22 * shift;
    p.bluffRate *= 1 - 0.72 * shift;
    p.riskTolerance -= 0.16 * shift;
    p.patience += 0.12 * shift;
  } else if (opponents.length <= 2 && position >= 0.5 && pressure < 0.34) {
    // 偷池档：人少、后位、没人表现强势时，稳健型也会扩大施压与诈唬频率。
    p.aggression += 0.16 * shift;
    p.looseness += 0.10 * shift;
    p.bluffRate *= 1 + 0.85 * shift;
    p.riskTolerance += 0.08 * shift;
  }

  if (bot.chips >= averageOpponentStack * 1.35 && state.pot <= bot.chips * 0.45) {
    // 大筹码档：利用覆盖优势，但仍受底池赔率约束，不做无脑碾压。
    p.aggression += 0.12 * shift;
    p.bluffRate *= 1 + 0.35 * shift;
    p.riskTolerance += 0.06 * shift;
  }

  if (state.roundNo >= 4) {
    // 收口档：后段减少试探和慢吞吞的边缘跟注，更明确地做价值或退出。
    p.aggression += 0.08 * shift;
    p.looseness -= 0.08 * shift;
    p.patience -= 0.10 * shift;
  }

  /**
   * 情绪档。
   *
   * 输了一大笔之后想追回来 —— 起手放宽、加注变凶、诈唬变多、耐心变差，
   * 这是真人牌桌上最普遍也最贵的一个漏洞，电脑玩家有它才像人。
   * 赢麻了的人则是另一种松：敢下注，但不会去追不该追的注。
   * 情绪不受 adaptability 约束：上头本来就是绕过理性的东西。
   */
  const tilt = bot.tilt ?? 0;
  if (tilt > 0.02) {
    p.aggression += 0.24 * tilt;
    p.looseness += 0.30 * tilt;
    p.bluffRate *= 1 + 1.1 * tilt;
    p.patience -= 0.22 * tilt;
    p.riskTolerance += 0.20 * tilt;
  } else if (tilt < -0.02) {
    // 缩着打：刚被抓到吹牛之后，人会有一阵子只用真牌说话。
    p.aggression += 0.18 * tilt;
    p.bluffRate *= Math.max(0, 1 + 1.3 * tilt);
    p.looseness += 0.16 * tilt;
  }

  return {
    ...p,
    aggression: clamp01(p.aggression),
    looseness: clamp01(p.looseness),
    bluffRate: clamp01(p.bluffRate),
    patience: clamp01(p.patience),
    riskTolerance: clamp01(p.riskTolerance),
  };
}

/**
 * 真正会陪你走到开牌的人数。
 *
 * 炸金花绝大多数底池是靠别人弃牌收掉的，六个人坐着不等于六个人跟你比大小。
 * 按在座人数直接做指数，会把胜率压到荒谬的低位（中等金花在六人桌上只剩 5%），
 * 于是所有机器人第一轮集体弃牌 —— 这就是「电脑一直弃牌、每局都打不起来」的来源。
 * 这里按「第一家一定要过，后面每多一家只有约一半真会跟到底」折算。
 */
function effectiveField(opponentCount: number): number {
  return 1 + Math.max(0, opponentCount - 1) * 0.5;
}

/** 下注阶段的胜率：牌力是「打赢一家」的概率，按有效对手数放大。 */
function winEquity(singleOpponentPercentile: number, opponentCount: number): number {
  return Math.pow(clamp01(singleOpponentPercentile), effectiveField(opponentCount));
}

/** 摊牌已成定局（梭哈接受之后）时，所有人都真的要比，不能再打折。 */
function showdownEquity(singleOpponentPercentile: number, opponentCount: number): number {
  return Math.pow(clamp01(singleOpponentPercentile), Math.max(1, opponentCount));
}

/**
 * 闷牌时的先验胜率。
 *
 * **不能拿 0.5 当牌力再去做指数**：0.5^5 只有 3%，低于任何底池赔率，闷着的机器人
 * 必然弃牌，而闷牌恰恰是最便宜的一档价 —— 这是弃牌率失控的另一半原因。
 * 一手完全未知的牌拿下底池的概率就是「这一桌里最好的那家是我」= 1/(有效家数)。
 */
function blindEquity(opponentCount: number): number {
  return 1 / (1 + effectiveField(opponentCount));
}

/** 比牌只按公开投入、动作强度和座次挑目标，不使用目标的 hand。 */
function compareTarget(
  state: RoomState,
  bot: PlayerState,
  opponents: BotOpponentView[],
): BotOpponentView | undefined {
  const M = state.settings.maxPlayers;
  return [...opponents].sort((a, b) => {
    const score = (p: BotOpponentView) =>
      opponentThreat(p) * 2
      + p.bet / Math.max(1, state.pot)
      + (p.looked ? 0.18 : 0)
      + Math.min(0.12, p.wins * 0.005);
    const byThreat = score(b) - score(a);
    if (Math.abs(byThreat) > 1e-9) return byThreat;
    return ((a.seat - bot.seat + M) % M) - ((b.seat - bot.seat + M) % M);
  })[0];
}

/** 一步决策：动作本身，加上「他该想多久」。 */
export interface BotAction {
  cmd: GameCommand;
  /** 服务器按这个毫秒数排延迟再执行 */
  thinkMs: number;
}

/**
 * 该想多久。
 *
 * 真人的用时不是随机的，是跟着**这一步有多难**走的，而且用时本身就是一种信息：
 *  - 早就想好的动作秒出 —— 看牌、闷牌跟个底注，手比脑子快；
 *  - 常规决策一秒上下；
 *  - 真正接近的边缘局面会「下潜」，盯着底池算三四秒，这是最像人的一处；
 *  - 上头的人出手更快 —— 情绪本来就是绕过思考的；
 *  - 还有人会演：拿着大牌故意拖一拖装犹豫，或者反过来秒跟装作无所谓。
 *    这一层由 deception 决定，所以同一个局面在不同电脑手里节奏不一样。
 *
 * 上限压在行动时限的一半，绝不能把真人晾到超时。
 */
function thinkTime(
  state: RoomState,
  bot: PlayerState,
  cmd: GameCommand,
  hardness: number,
  personality: BotPersonality,
): number {
  const cap = Math.max(700, state.settings.turnSeconds * 1000 / 2 - 200);
  const jitter = botRoll(state, bot, `think:${cmd.type}`);
  if (cmd.type === 'look') return Math.round(260 + jitter * 260);

  // 难度 0 → 秒出；难度 1 → 下潜。指数让中间地带不至于全都拖成三秒。
  let ms = 380 + Math.pow(clamp01(hardness), 1.35) * 3200;

  const theatre = botRoll(state, bot, `theatre:${cmd.type}`);
  if (theatre < personality.deception * 0.28) ms *= 1.9;            // 装犹豫
  else if (theatre > 1 - personality.deception * 0.18) ms *= 0.35;  // 秒跟装弱

  const tilt = bot.tilt ?? 0;
  if (tilt > 0.2) ms *= 1 - Math.min(0.45, tilt * 0.5);             // 上头就不想了

  return Math.round(Math.min(cap, Math.max(240, ms * (0.80 + jitter * 0.45))));
}

/** 边缘程度：离「跟或弃」的分界线越近，人想得越久。0.14 之内算真正难受的区间。 */
function hardnessFromMargin(margin: number): number {
  return clamp01(1 - Math.abs(margin) / 0.14);
}

function decideBot(state: RoomState, bot: PlayerState): BotAction {
  const opponents = botOpponentViews(state, bot);
  const opponentCount = Math.max(1, opponents.length);
  const basePersonality = botPersonality(bot);
  const pressure = tablePressure(state, opponents);
  const cost = callCost(state, bot);
  const costFraction = cost / Math.max(1, bot.chips);
  const effectiveStack = Math.max(1, Math.min(bot.chips, ...opponents.map((p) => p.chips)));
  const stackToPot = effectiveStack / Math.max(1, state.pot);
  const activeCount = opponents.length + 1;
  const position = activeCount <= 2 ? 1 : (state.turnCount % activeCount) / (activeCount - 1);
  const personality = adaptPersonality(
    basePersonality, state, bot, opponents, pressure, position, costFraction,
  );
  const act = (cmd: GameCommand, hardness: number): BotAction =>
    ({ cmd, thinkMs: thinkTime(state, bot, cmd, hardness, personality) });

  // 有人梭哈时只有两条路：接或者弃。先看牌，再按赔率决定。
  if (state.allIn) {
    if (!bot.looked) return act({ type: 'look' }, 0);
    // 上一步已经保证看过牌了，所以这里的价一定是双倍那一档 —— 别拿发起人的实付当自己的价。
    // 刚才那一下看牌可能把价顶过了身家，接受时服务端会夹到全部筹码，赔率也按这个实付算。
    if (bot.chips <= 0) return act({ type: 'fold' }, 0);
    const price = Math.min(state.allIn.base * 2, bot.chips);
    const showdownOpponents = Math.max(1, state.allIn.accepted.filter((id) => id !== bot.id).length);
    const strength = handPercentile(bot.hand, state.settings.dealMode);
    const equity = showdownEquity(strength, showdownOpponents);
    const potOdds = price / Math.max(1, state.pot + price);
    const riskTax = (1 - personality.riskTolerance) * 0.055 + pressure * 0.035;
    const temperament = (personality.looseness - 0.5) * 0.045;
    // 接一个全场开牌的注是整局最重的一步，越接近临界越该想久一点。
    const margin = equity + temperament - (potOdds + riskTax);
    // 底线难度 0.3：哪怕账算得很清楚，这一下也不该秒答。
    const hardness = Math.max(0.3, hardnessFromMargin(margin));
    return act(margin >= 0 ? { type: 'call' } : { type: 'fold' }, hardness);
  }

  // 闷牌便宜且能隐藏信息，但注码、对手压力或轮次升高时，理性的玩家会先看牌再决定。
  if (!bot.looked) {
    const informationNeed = clamp01(
      0.18 + personality.patience * 0.48 + pressure * 0.34 + costFraction * 2.2 + (state.roundNo - 1) * 0.25,
    );
    if (state.roundNo >= 2 || costFraction >= 0.045 || botRoll(state, bot, 'look') < informationNeed) {
      return act({ type: 'look' }, 0);
    }
  }

  // 看了牌用真实分位；闷着的时候只有先验，不能假装自己拿了一手正中间的牌。
  const strength = bot.looked ? handPercentile(bot.hand, state.settings.dealMode) : 0.5;
  const equity = bot.looked ? winEquity(strength, opponentCount) : blindEquity(opponentCount);
  const potOdds = cost / Math.max(1, state.pot + cost);
  /**
   * 要多少胜率才值得跟。
   *
   * looseness 这一项**必须给足权重**，否则每台电脑都被赔率算式压成同一个人：
   * 实测六台不同人格的机器人打五百局，攻击性、遇压弃牌率、摊牌牌力三项全部
   * 一模一样，桌上根本分不出谁是谁。真人牌桌最明显的差别就是松紧 —— 有人什么
   * 牌都想看看，有人一晚上只打三把 —— 所以这里按 ±0.08 的幅度拉开，
   * 大到足以盖过边缘局面的胜率差，又不至于让人拿着烂牌去追大注。
   */
  const requiredEquity = clamp01(
    potOdds
      + pressure * 0.075
      + costFraction * (1 - personality.riskTolerance) * 0.10
      - 0.025
      - (personality.looseness - 0.5) * 0.16
      - position * 0.022,
  );
  // 诈唬要**挑人**，不是掷骰子：桌上站着一个说什么都要跟的人，这个池子就偷不动。
  // 反过来，一桌都是一加就跑的人，连老实型也会开始伸手 —— 真人就是这么打的。
  const steal = foldEquity(opponents);
  /**
   * 闷牌加注 —— 炸金花里最常见、也最便宜的一记虚张声势。
   *
   * 闷着只付一半价，位置又好、场上还没人发力的时候，真人几乎人人都会来这么一手：
   * 它赌的**不是当场把所有人吓跑**，而是「没人知道我手里是什么」这件事本身值钱，
   * 顺带把自己塑造成一上来就打的人，后面拿真牌才有人跟。
   * 所以这一档不受偷池概率约束，只要便宜、有位置、场面没炸就行。
   */
  const blindRaise = !bot.looked
    && position >= 0.4
    && pressure < 0.34
    && costFraction < 0.05
    && botRoll(state, bot, 'blind-raise')
      < personality.bluffRate * 1.6 + personality.deception * 0.10;
  /** 看了牌还拿烂牌去加注，那就是真的在偷池子，得先确认这一桌偷得动。 */
  const stealBluff = bot.looked
    && position >= 0.5
    && pressure < 0.34
    && stackToPot >= 3
    /**
     * 只看「偷得动的概率」，不再另外写一条人数上限。
     *
     * steal 本身就是所有对手一起弃牌的概率，人越多它自己就掉得越快
     * （常人一家 0.53，两家 0.28，三家 0.15，四家 0.08），拿它当唯一的闸门，
     * 「人多不偷、人少常偷」是算出来的结果而不是硬写的规则。
     * 门槛取 0.14：底池通常有单注的好几倍，一成半的成功率就已经回本，
     * 何况偷不成手里还有牌。之前那条 opponentCount <= 2 才是真正的死结 ——
     * 六人桌上几乎凑不齐这个条件，实测上千次加注一次诈唬都没有。
     */
    && steal >= 0.14
    && strength < 0.40
    && botRoll(state, bot, 'bluff-raise') < personality.bluffRate * (0.5 + steal * 1.4);
  const plannedBluff = blindRaise || stealBluff;

  if (bot.chips <= cost) {
    /*
     * 跟不起了：用**这一口实际要掏的钱**重算底池赔率，不能只因已经投过钱就追注。
     *
     * 规则对齐（梭哈改成全押之后）：短码**没有梭哈** —— 引擎的 doAllIn 会直接拒。
     * 他要打的那一口本来就是「全押跟」：动作是 call，金额被 `pay` 夹到全部筹码，
     * 和原来那个 all_in 掏的钱一模一样，所以赔率算式一个字没动，只换了动作类型。
     */
    const shove = bot.chips;
    const shoveOdds = shove / Math.max(1, state.pot + shove);
    const edge = equity + (personality.looseness - 0.5) * 0.05 - (1 - personality.riskTolerance) * 0.035;
    const margin = edge - shoveOdds;
    return act(margin >= 0 ? { type: 'call' } : { type: 'fold' }, Math.max(0.25, hardnessFromMargin(margin)));
  }

  // 牌力、赔率、位置和压力共同决定弃牌；性格只影响边缘局面，不会让弱牌无脑追高注。
  const decisionNoise = (botRoll(state, bot, 'continue') - 0.5) * 0.035;
  // 这个差值就是整局最有信息量的一个数：贴着零的时候，人会真的坐在那里算。
  const callMargin = equity + decisionNoise - requiredEquity;
  const marginHardness = hardnessFromMargin(callMargin);
  if (callMargin < 0 && !plannedBluff) return act({ type: 'fold' }, marginHardness);

  // 有虚有实：强牌在前位或已有对手施压时，偶尔只跟一手设陷阱。
  // 这个模式不对外显示，否则“陷阱”本身就失去意义；下一轮会重新按新局面判断。
  //
  // 原来这里还要求 pressure >= 0.16。开局没人动作时 pressure 只有 0.09，
  // 门槛永远够不到，等于整个慢打模式在最该用它的前两轮是死代码。
  const slowPlay = bot.looked
    && strength >= 0.84
    && stackToPot >= 1.35
    && botRoll(state, bot, 'slow-play')
      < personality.deception * (0.22 + pressure * 0.34 + (1 - position) * 0.10);

  /**
   * 强牌什么时候才该兑现。
   *
   * 比牌是把强牌**立刻变现**：只赢到眼下这点底池，还等于把自己的牌力公开。
   * 人不会拿着豹子在第一个能比牌的回合就点开 —— 那是把一手好牌卖成白菜价。
   * 老代码只要 canCompareNow 一放行就出手，于是绝大多数大牌都在比牌刚解锁的
   * 那一回合开牌，桌上看到的就是「电脑一拿豹子就秒开」。
   *
   * 现在要三件事同时成立才动手：
   *  1. **再等一圈**。解锁之后还得让所有人再走一轮，给底池长起来的时间；
   *  2. **底池值得动手** —— 至少是这一刀成本的 8 倍，否则赢下来也不够本；
   *  3. 或者局面本身已经不需要养池了：只剩一个对手、打到后段、对面在猛攻。
   */
  // 用开局人数当一圈的长度：拿 activeCount 会随着别人弃牌一起缩水，
  // 「再等一圈」就变成了「再等两三手」，大牌照样在解锁那一轮就开出去。
  const patientTurn = state.turnCount >= state.compareUnlockAt * 2;
  const potWorthTaking = state.pot >= compareCost(state, bot) * 8;
  const readyToCashOut = opponentCount === 1
    || state.roundNo >= 4
    || pressure >= 0.55
    || (patientTurn && potWorthTaking);

  // 越强的牌越沉得住气，而且这份耐心跟着人格走 —— 老实型早点收网，
  // 狡诈型能一直忍到后段，这样同一手豹子在不同电脑手里打出来不是一个样子。
  // 人多的时候，第 3 轮之前拿着这一档的牌一律不比 —— 这是硬下限，
  // 之后才交给人格去决定还能再忍多久。对面真打起来了（pressure 高）另说。
  // 门槛压到 0.75 —— 那正好是顺金那一档的下沿。写 0.86 只盖得住豹子，
  // 顺金（0.75~0.87）整档漏在外面，实测三千局里还有 4.5% 的大牌在前两轮就开牌，
  // 而在牌桌上顺金和豹子一样是要养池的牌，没人拿着它急着变现。
  const holdingBackMonster = strength >= 0.75
    && opponentCount >= 2
    // 只有对面已经打到梭哈那个量级才值得放弃养池直接开牌；普通的一次加注，
    // 手里有豹子的人该做的是反加，不是把牌亮出来收下这点池子。
    && pressure < 0.72
    && (
      state.roundNo < 3
      || (state.roundNo < 5 && botRoll(state, bot, 'monster-patience') < 0.45 + personality.deception * 0.40)
    );

  // 极强牌在低 SPR 或后段主动收口；极少数老练型机器人会在单挑低压力局面诈唬梭哈。
  // 梭哈已解锁、并且钱确实够跟注（短码没有梭哈，见上面那一支）才考虑推
  if (!slowPlay && canAllInNow(state) && bot.looked && bot.chips > cost) {
    const shove = allInCost(state, bot);
    const shoveOdds = shove / Math.max(1, state.pot + shove);
    const valueShove = strength >= 0.88
      && equity >= shoveOdds + 0.08
      && (stackToPot <= 2.6 || state.roundNo >= 5)
      && botRoll(state, bot, 'value-shove') < 0.22 + personality.aggression * 0.45;
    const bluffShove = opponentCount === 1
      && strength < 0.42
      && pressure < 0.28
      && stackToPot >= 3
      // 单挑梭哈诈唬是最贵的一招，只有对面确实吓得走才做
      && steal >= 0.45
      && botRoll(state, bot, 'bluff-shove') < personality.bluffRate * 0.22;
    // 价值梭哈是想好的，诈唬梭哈是硬着头皮上的 —— 后者该慢一点。
    if (valueShove || bluffShove) return act({ type: 'all_in' }, bluffShove && !valueShove ? 0.8 : 0.45);
  }

  // 牌很好且开放比牌时，优先挑战公开表现最有威胁、投入最多的人。
  if (
    !slowPlay && !holdingBackMonster && readyToCashOut &&
    canCompareNow(state) && opponents.length > 0 && bot.looked &&
    bot.chips > compareCost(state, bot) &&
    strength >= (opponentCount === 1 ? 0.62 : 0.74) &&
    equity >= compareCost(state, bot) / Math.max(1, state.pot + compareCost(state, bot)) + 0.07 &&
    botRoll(state, bot, 'compare') < 0.18 + personality.aggression * 0.42
  ) {
    const target = compareTarget(state, bot, opponents);
    // 挑谁比牌是要在几个人之间权衡的，这一步本来就慢
    if (target) return act({ type: 'compare', targetId: target.id }, 0.55);
  }

  // 价值加注会按牌力、底池和有效筹码选择 2万/5万/10万，而不是永远只点下一档。
  const multiplier = bot.looked ? 2 : 1;
  const affordable = state.settings.betOptions.filter(
    (unit) => unit > state.betUnit && bot.chips > unit * multiplier,
  );
  if (affordable.length) {
    const valueEdge = equity - requiredEquity;
    // 强牌被「先别比牌」拦下来之后必须有出口，否则它只会平跟，池永远养不大。
    // 手多硬才值得加注，这条线**跟着性格走**：凶的人拿一副顺子就敢加，
    // 稳的人非金花不动手。写死一个 0.66 的话，六台电脑的加注频率会齐刷刷
    // 落在同一档，桌上就看不出谁凶谁稳了。
    const raiseFloor = 0.78 - personality.aggression * 0.20;
    const wantValue = !slowPlay && bot.looked
      && strength >= raiseFloor
      && valueEdge >= -0.015
      && botRoll(state, bot, 'value-raise')
        < 0.18 + personality.aggression * 0.55 + Math.max(0, valueEdge) + (holdingBackMonster ? 0.30 : 0);
    const bluffSpot = plannedBluff;

    if (wantValue || bluffSpot) {
      if (bluffSpot && !wantValue) return act({ type: 'raise', unit: affordable[0] }, 0.7);
      const stackFraction = strength >= 0.95 ? 0.46 : strength >= 0.87 ? 0.29 : strength >= 0.74 ? 0.18 : 0.11;
      const targetCost = Math.min(
        bot.chips * 0.66,
        Math.max(state.pot * (0.70 + personality.aggression * 0.75), effectiveStack * stackFraction),
      );
      const sized = affordable.filter((unit) => unit * multiplier <= targetCost);
      const unit = sized.length ? sized[sized.length - 1] : affordable[0];
      // 加多少是个选择题，但方向是笃定的
      return act({ type: 'raise', unit }, 0.4);
    }
  }

  // 闷着跟个底注是不用想的；看过牌之后的边缘跟注才是要掂量的那一种。
  return act({ type: 'call' }, bot.looked ? marginHardness * 0.8 : 0.05);
}

/** 小的确定性哈希 → [0,1)，用来给机器人一个稳定的"手气性格" */
function pseudoRandom(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}
