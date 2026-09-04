/**
 * 线路（设计文档 §4.4）。
 *
 * 线路是**这一局**的打法承诺 —— 它让「它刚才还在吹」这件事有下文：
 * 偷池被跟之后，下一步不是重新掷一次骰子，而是明确地弃，或者（真拿到货时）继续。
 * 没有线路的机器人每一步都是独立同分布的，桌上看起来就是「一会儿凶一会儿怂」。
 *
 * 三件事按设计文档办：
 *
 * 1. **只在三个信息点重选**：① 首次轮到自己 ② 看牌之后 ③ 面对加注/梭哈/人数降到 ≤2。
 *    `planPointOf()` 把这三件事数成一个整数，它只读**公开状态**，
 *    所以同一手牌里两次调用一定得到同一条线路，不需要把线路存进档案。
 * 2. **进入条件、偏好权重、退出条件全部由人物卡给出**：`lineFit()` 给出「这个局面
 *    有多像这条线」，人物卡的 `weight` 决定他爱不爱走这条线 —— 老实人的
 *    「偷池」权重是 0，他这辈子都不会偷池；退出条件不用单独写，
 *    信息点一到就重算，被反加自然会换线（S16）。
 * 3. **线路不下命令，只施加倾向**：`lineBias()` 返回 −1..1，乘上人物卡的 `commit`
 *    加进系统 1 和系统 2 的打分里。没有任何一条线会 `return` 一个动作 ——
 *    坚持得多紧是连续量，不是门槛。
 */

import type { PlayerState, RoomState } from '../../game.ts';
import { unitTier } from './events.ts';
import { LINES, type Line } from './personas/types.ts';
import { tiltFactor } from './personas/index.ts';
import { evCall } from './lookahead.ts';
import { theatreDamp } from './tempo.ts';
import { pWin, pWinAll } from './range.ts';
import { planRoll } from './random.ts';
import type { ZjhSituation } from './situation.ts';

/** 选线路的时候线路本身还没选出来，所以这里看到的是不含 `plan` 的局面。 */
type Scene = Omit<ZjhSituation, 'plan'>;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** 钟形：离中心越远越不像，没有边界，也就没有门槛。 */
function bell(x: number, center: number, width: number): number {
  const z = (x - center) / width;
  return Math.exp(-z * z);
}

/** 升档之后偷池的保本线让多少（§4.4「升档后放宽」）：升到顶档让掉三分之一。 */
const STEAL_RELIEF = 0.35;

/**
 * 单挑时「养池」还剩多少余地（§4.4 养池的进入条件，2026-09-04 P2.1）。
 *
 * 一对一也能榨 —— 对面跟得起、又不肯走的时候，「留着他慢慢来」是真人拿到大牌
 * 的第一反应。旧版把人数写成 `(人数−2)/3`，单挑归零，等于在设计上宣布
 * 「单挑拿豹子没有别的打算，只能开牌」。这个数是那条底：单挑仍有 0.35 的余地，
 * 满桌长到 1.0。取 0.35 是让单挑的养池 fit（豹子约 0.35）压得住同一局面下
 * 被 F1 改成钟形之后的收口 fit（约 0.18），又不至于盖过多人桌上养池本该更强这件事。
 */
const MILK_HEADS = 0.35;

/** 越过某个位置之后平滑地起来（logistic），用来代替 `>=` 。 */
function ramp(x: number, center: number, width: number): number {
  return 1 / (1 + Math.exp(-(x - center) / width));
}

/**
 * 「够得着我」的满刻度（2026-09-04 P2.1 返修）。
 *
 * `outgunned()` 把「他的范围能打过我的概率」折成 0..1 的连续刻度：
 * 掷硬币（对方有一半的牌能打掉我）就算完全够得着，往上不再加分；
 * 概率越低越淡，我这手谁都打不过的时候正好是 0。
 * 取 0.5 是因为它是「这手牌到底谁大」这个问题真正没有答案的那一点 ——
 * 再往上并不会让人更想摊牌，只会让人想跑。
 */
const CLOSE_REACH = 0.50;

/** 他的范围够不够得着我（1 = 完全够得着，0 = 我这手他打不动）。 */
function outgunned(myWinRate: number): number {
  return clamp01((1 - myWinRate) / CLOSE_REACH);
}

/**
 * 现在是第几个信息点。
 *
 * 只数设计文档列的那三件事，而且只读公开状态：看没看牌、单价升了几档、
 * 有没有人梭哈、还剩几个人。同一手牌里这四样不变，线路就不变 ——
 * 「线路一致性」这条验收就是靠这个成立的。
 */
export function planPointOf(state: RoomState, bot: PlayerState, activeCount: number): number {
  return (bot.looked ? 1 : 0)
    + unitTier(state.betUnit, state.settings)
    + (state.allIn ? 1 : 0)
    + (activeCount <= 2 ? 1 : 0);
}

/** 看牌之后的真实胜率；闷着的时候用「一手中间牌」的胜率当感觉。 */
function equityOf(sit: Scene): number {
  const mine = sit.strength ?? 0.5;
  return sit.dists.length ? clamp01(pWinAll(mine, sit.dists, sit.state.settings.dealMode)) : 1;
}

/**
 * 这个局面有多像某一条线（0..1，纯局面，不含人物卡的偏好）。
 *
 * 设计文档 §4.4 那张表里的每一条「进入条件」都在这儿，
 * 但每一条都写成连续量：`pWinAll ≥ 0.80` 变成一条以 0.80 起步的 logistic，
 * `成本 < 1% 筹码` 变成一条随成本掉下去的曲线。
 */
export function lineFit(sit: Scene, line: Line): number {
  const blind = sit.bot.looked ? 0 : 1;
  const looked = 1 - blind;
  const eq = equityOf(sit);
  // 我这手牌的**绝对**分位（闷着的时候当「一手中间牌」看，和 `equityOf` 同一口径）。
  const mine = sit.strength ?? 0.5;
  const heads = clamp01((3 - sit.activeCount) / 1.5);          // 人越少越接近 1
  const crowd = clamp01((sit.activeCount - 2) / 3);            // 人越多越接近 1
  const cheap = 1 - ramp(sit.costFraction, 0.012, 0.006);      // 这一口疼不疼
  const lookedOpp = sit.opponents.length
    ? sit.opponents.filter((o) => o.looked).length / sit.opponents.length
    : 0;
  const escalated = clamp01(sit.tier / 2);
  const canCompare = sit.candidates.some((c) => c.targetId !== undefined) ? 1 : 0;
  // 最软的那个目标有多软（闷比要挑「摊牌档位低」的人）
  const softest = sit.threats.length ? 1 - Math.min(...sit.threats) : 0.5;

  switch (line) {
    case '便宜看戏':
      // 「便宜看戏」是价钱说了算，不是闷不闷说了算：看过牌、牌也不怎么样，
      // 但这一口只要一千块，人照样会跟着看看下一张脸色。闷着更典型（不用暴露信息），
      // 所以看过牌的权重打个折，但不能是 0 —— 否则这类局面只剩「弃」可选，
      // 人却在跟，线路一致性就是被这个缺口漏掉的。
      // 看戏会看腻：轮次越往后，「反正便宜、先跟着」这条线自己就淡了。
      return (blind + looked * 0.55) * cheap * (1 - escalated)
        * (1 - 0.55 * clamp01((sit.state.roundNo - 1) / 3));
    case '闷压':
      return blind * Math.max(heads, 1 - crowd) * (0.35 + lookedOpp * 0.65);
    case '闷比':
      /**
       * 闷着开牌是「闷跟到后来，与其继续一口口掏钱，不如半价把它摊了」（S2）。
       * 所以它**不是**开局就能打算的事：第一轮就闷着去开牌不叫线路，那叫乱来。
       * 轮次在这里是连续输入，不是「第三轮才准闷比」的门槛。
       */
      return blind * canCompare * softest * (0.4 + escalated * 0.6)
        * ramp(sit.state.roundNo, 2.7, 0.7);
    case '养池':
      /**
       * 「养池」问的是「这一手还能从别人身上榨出多少」，而榨得出榨不出，
       * 靠的是**还有人跟得起**，不是**人多**。旧版写的是 `crowd = (人数−2)/3`，
       * 在单挑时恒等于 0 —— 于是一手豹子单挑时，「留着他慢慢来」这条线
       * 根本不在候选里，桌上只剩「收口」可走，牌越大越急着开牌（P2.1 的主因之一）。
       *
       * 人数当然还是有分量的：五个人陪着掏钱当然比一个人能榨得多。所以它从
       * 「单挑归零」改成「单挑留底」——`MILK_HEADS` 是那条底，剩下的按人数长上去。
       * 这仍然是一条连续项，不是「人数 ≥ 3」的门槛（§4.4 的进入条件同步改成连续）。
       */
      return looked * ramp(eq, 0.80, 0.06) * (MILK_HEADS + (1 - MILK_HEADS) * crowd);
    case '价值加压':
      /**
       * 「牌好到该主动收钱」这件事**只会越来越像**（2026-09-04 P2.1 F8）。
       *
       * 旧写法是一条中心在 0.675 的钟形，右边照样掉下去：`bell(1, 0.675, 0.13) = 0.002`。
       * 也就是说**最该加价的那手牌，反而进不了「价值加压」这条线**。
       * 量出来的后果很直接：单挑第 2 轮拿豹子的人 83% 抽到「养池」（那条线 98% 平跟）、
       * 只有 1% 抽到「价值加压」，而同一个局面拿中等金花的人 65% 抽到「价值加压」，
       * 加注率 66% —— 「拿大牌不加价、中等牌反而在加价」这条倒挂，
       * 根子在这里，不在评分层。
       *
       * 钟形本身要留着：它说的是「中上等牌**特别**适合加价收钱」（再好一点的牌
       * 还得跟养池、收口抢人）。所以只把右尾托住 —— 取钟形和一条上升 ramp 的较大者，
       * 牌力越高，「值得主动加价」这个念头至少不会比中等牌更弱。
       */
      return looked * Math.max(bell(eq, 0.675, 0.13), ramp(eq, 0.72, 0.08));
    case '偷池': {
      /**
       * 文档 §4.4：**看牌后 pWinAll < 0.35 且 fold-equity ≥ 阈值（升档后放宽）**。
       *
       * 阈值不是拍脑袋的常数，是这一口的**保本成功率**。但保本线不是
       * `c / (P + c)`：那条式子假设「被跟就等于把 c 全赔进去」，而半诈唬被跟之后
       * 手上还有 `eq` 的胜率去分那个变大了的池子（§4.4 写的「被跟则下一信息点转弃」
       * 也让损失止在这一口）。所以真正的保本线是把这一份残值先扣掉：
       *
       *   need = (c − eq × P被跟) / (P + c − eq × P被跟)
       *
       * 这条替掉了旧版那个「占身家超过 3.5% 就不偷」的隐形门槛 —— 偷得起偷不起，
       * 本来就该由「这一口相对池子多大、被跟之后还剩多少胜率」来说，而不是相对身家。
       *
       * 「升档后放宽」也在这儿：价钱升上去之后人更容易被吓走，同一个成功率更值得赌，
       * 于是保本线往下让 `STEAL_RELIEF`。
       */
      const raise = sit.candidates.filter((c) => c.unit !== undefined);
      if (!raise.length) return 0;                       // 加不动价就没什么可偷的
      const cost = Math.min(...raise.map((c) => c.cost));
      // 被跟就按**一个人**跟算：跟的人再多，这一口本来也不该偷。
      const potIfCalled = sit.pot + cost + cost / 2;
      const residual = eq * potIfCalled;
      const breakEven = clamp01((cost - residual) / Math.max(1, sit.pot + cost - residual));
      const need = breakEven * (1 - STEAL_RELIEF * escalated);
      return looked * (1 - ramp(eq, 0.35, 0.07)) * ramp(sit.steal - need, 0, 0.08) * sit.position
        * sit.steal / (sit.steal + 0.05);
    }
    case '跟到底看':
      /**
       * 文档 §4.4 那一行的进入条件是「看牌后 pWinAll 0.35–0.55 **且前瞻 EV ≥ 0**」，
       * 退出条件是「前瞻 EV < 0」—— EV 这一半以前根本没写进代码，
       * 这条线只看牌力就进得来。进来之后表里的 `fold: −0.55` 又把人按在池子里，
       * 于是一手「胜率四成半、可是这个价钱算下来是亏的」的牌会被一路跟到摊牌：
       * 竞技场里新脑每一个**最终还是放弃**的池子要比对照组多付五万
       * （165k vs 114k，而两边放弃的局数一样多 83%），大头就在这条线上。
       *
       * 补上的这一项是连续的（`ramp` 在 0 附近过渡，宽 0.06 个池子），
       * 不是一条 `if (ev < 0) return 0` 的门槛：账面刚好持平的时候，
       * 「跟到底看看」仍然是一个人会有的打算，只是没那么强了。
       */
      return looked * bell(eq, 0.45, 0.10) * ramp(evCall(sit.ev), 0, 0.06);
    case '收口': {
      // 「收口」是打算把这一手了结掉。了结的手段（比牌 / 梭哈）现在压根不在桌上时，
      // 这条线就没什么可打算的 —— 这不是决策门槛，是「计划得有可行的落点」。
      const closable = sit.candidates.some((c) => c.key.startsWith('compare') || c.key === 'all_in');
      // 想收口得有收口的底气：要么牌够好，要么已经投进去太多、这一手非了结不可。
      // 「已经投进去多少」才是底池承诺，不是「这一口要多少」——
      // 一口大注只是贵，贵不等于我这一手已经没法走了。
      const committed = sit.bot.bet / Math.max(1, sit.bot.bet + sit.bot.chips);
      /**
       * 想收口的三个理由，取最强的那一个（2026-09-04 P2.1 改）。
       *
       * 旧版第一项写的是 `ramp(eq, 0.46, 0.12)` —— 一条**随胜率单调上升**的曲线，
       * 于是「牌越大越想把这一手了结掉」这句话就直接写在了代码里：豹子 `eq = 1.0`
       * 拿满分 1.0，收口 fit 0.56，而单挑时 `planAllows` 又把跟/加从候选里删掉，
       * 结果是一手豹子单挑第 2 轮有 55% 的概率直接开牌、只有 7% 会加价。
       * 真人是反过来的：拿到怪物牌想的是「怎么把他留在池子里」。
       *
       * 现在三项各说各的事，而且都不是牌力的单调函数：
       *
       *  - `bell(eq, 0.58, 0.16)`：**中上牌**才想了结 —— 「我大概是好的，但经不起
       *    再打两轮」正是收口这条线的原意。极强牌在这条钟形曲线的右尾上自己淡下去
       *    （豹子约 0.02），极弱牌在左尾（散牌约 0.02），两头都不靠牌力去收口；
       *  - `ramp(committed, 0.18, 0.06)`：**投进去太多**，这一手非了结不可；
       *  - `ramp(threat, 0.62, 0.10)`：**被顶了** —— 不是「我牌大」，是「他不肯走，那就摊了」。
       *
       * 三项都是连续量，没有任何一条是 `if (牌力 ≥ x)`。
       *
       * **但三项都还要再过一关：「顶我的这个人够不够得着我」（2026-09-04 P2.1 返修）。**
       * 上面那个写法只问「台面凶不凶、我掏了多少」，不问「凶的那个人打不打得动我」。
       * `opponentThreat` 按定义是**故事的热度**（`storyHeat × credibility`），跟他手里
       * 有什么牌无关：一个真人手里攥着豹子被人猛顶，第一反应是反加、是再榨一口，
       * 绝不是把牌摊了 ——「被顶」之所以是收手的理由，前提是顶我的这个人
       * **有可能把我打掉**。第一版 P2.1 剩下的那 7.9%「大牌早比」全部走的是这条线，
       * 其中过半是这一项放的行。
       *
       *   威胁项 = max_i  ramp(威胁_i, 0.62, 0.10) × outgunned(pWin(我, 他的范围_i))
       *   投入项 =        ramp(committed, 0.18, 0.06) × outgunned(eq)
       *   中上牌 =        bell(eq, 0.58, 0.16)       × (1 − ramp(我的分位, 0.83, 0.08))
       *
       * 三条各有各的道理：
       *  - **威胁按人算** —— 是谁在顶我、那个人打不打得过我，本来就是同一个人的两件事，
       *    `threats[i]` 和 `dists[i]` 是同序的，逐个折完再取最大；
       *  - **投入是对全场的**，所以用 `eq`（`pWinAll`）：钱已经在锅里，如果桌上没有一个人
       *    的范围够得着我，那不是「非了结不可」，那是**非榨到底不可**；
       *  - **中上牌那一项按绝对分位淡出**。`eq` 是**相对**量：桌面一凶，所有人的范围
       *    都收紧，我手里一手绝对意义上的大牌，`eq` 反而滑回 0.58 附近，钟形项于是
       *    满格地喊「中上牌，该了结了」—— 这不是它的本意。`1 − ramp(mine, 0.83, 0.08)`
       *    把它限制回真正的中上牌身上（0.83 就是 §6.4 单调性上限用的豹子档边界）。
       *    注意方向：牌越大这一项越接近 0，所以它**不是**第二条「牌越大越该开牌」的通道
       *    （§4.6 明令那条路只留给 `beat`），正相反。
       *
       * 全是乘性的连续量，没有一个 `if (eq ≥ x)` 或 `if (牌力 ≥ x)`。
       * 对「中等牌被顶」的局面（`eq ≈ 0.5`、`mine ≈ 0.6`）三个折扣都接近 1，收口原样保留
       * （S15 照常通过）；闷着的人按「一手中间牌」算（`pWin ≈ 0.5`、`mine = 0.5`）同样满格 ——
       * 闷着被顶就摊了，不受这次改动影响。
       */
      const gb = bell(eq, 0.58, 0.16) * (1 - ramp(mine, 0.83, 0.08));
      const gc = ramp(committed, 0.18, 0.06) * outgunned(eq);
      let gt = 0;
      for (let i = 0; i < sit.threats.length; i++) {
        const reach = sit.dists[i] ? outgunned(pWin(mine, sit.dists[i], sit.state.settings.dealMode)) : 1;
        gt = Math.max(gt, ramp(sit.threats[i], 0.62, 0.10) * reach);
      }
      const ground = Math.max(gb, gc, gt);
      return 0.85 * (closable ? 1 : 0.12) * ground
        * Math.max(heads, ramp(sit.tier, 1.9, 0.35)) * (0.35 + looked * 0.65);
    }
    case '弃':
      // 「其余」：牌不行、这一口又疼。永远有一点点底噪 —— 人任何时候都可能想走。
      // 便宜的时候人不会「打算弃牌」，他会跟着看看 ——「便宜看戏」那条线接住这种局面。
      // 还没看牌的人很少会「打算走人」—— 他连自己是什么都还不知道，
      // 手上这一口又只要半价；真要走，也是看过之后才决定的（这条不是门槛，是权重）。
      return (0.02 + (1 - ramp(eq, 0.34, 0.10)) * (0.04 + ramp(sit.costFraction, 0.05, 0.03) * 0.68))
        * (0.08 + looked * 0.92);
  }
}

/**
 * 情绪怎么改「今天想走哪条线」（§4.9）。
 *
 * 这不是在动作上加分，而是更前面一层：上头的人**打算**去偷这一把，
 * 宽裕的人**打算**便宜看场戏。同一张人物卡、同一个局面，心情不同，
 * 挑出来的线路分布就不同 —— 情绪必须能改计划，不能只改临场的手抖。
 * 权重是乘性的，且永远为正：情绪能让一条线更像他今天想干的事，
 * 但不会替他把某条线彻底关掉（关掉是人物卡 `weight: 0` 的事）。
 */
function moodWeight(sit: Scene, line: Line): number {
  const ch = sit.channels;
  const push = (v: number) => Math.max(0.15, 1 + v);
  switch (line) {
    case '便宜看戏':
      return push(ch.ease * 0.35 + ch.looseness * 0.20 - ch.seekInfo * 0.35 - ch.tilt * 0.25);
    case '闷压':
      return push(ch.aggression * 0.30 + ch.delayInfo * 0.25 + ch.tilt * 0.30 - ch.seekInfo * 0.45);
    case '闷比':
      return push(ch.showoff * 0.30 + ch.delayInfo * 0.20 + ch.tilt * 0.25 - ch.safety * 0.30);
    case '养池':
      return push(ch.greed * 0.55 + ch.ease * 0.25 - ch.arousal * 0.30);
    case '价值加压':
      return push(ch.aggression * 0.50 + ch.greed * 0.30 - ch.safety * 0.25);
    case '偷池':
      /*
       * 「被抓两次之后一段时间不敢演」（老王卡；personas.md 待集成 #3）。
       *
       * 偷池**就是**「演」那条线，所以「不敢演」要在两个地方同时体现：
       * `adapter.ts` 里那一项削的是「这一步敢不敢吓人」，这里削的是
       * 「今天还想不想走这条线」。两处共用 `theatreDamp()` 这一个系数
       * （第三处是 `tempo.ts` 里装犹豫的用时），`caught` 每局 ×0.90
       * 自己走完「一段时间」，不需要另写恢复逻辑。
       *
       * 实测（`p3int-caught3.ts` 老王 8000 手、标准档、种子 20260903，
       * 按**决策当时**的 `mind.caught` 分桶）：烂牌步里走偷池的比例
       * caught<0.2 时 3.3%（8/240），caught 一上来就掉到 0.4%–1.0%
       * —— 「降到基线一半以下」在这条线上是成立的；定场景里同一机制
       * 把老王的烂牌施压率从 4.0% 压到 0.1%。
       *
       * 但**整桌口径的「烂牌加注率」不会跟着腰斩**，这一点要说清楚：
       * 老王的烂牌加注 149/199 来自「收口」而不是偷池（同一份统计），
       * 而收口时的烂牌加注是他卡上写明的破绽 ——「闷太久，被看牌后
       * 反加时常常已经投了很多」，`committed` 顶起来的非了结不可，
       * 不是演。按被抓次数去削那一类加注等于把破绽也一起修掉，
       * 所以这里**没有**把 `theatreDamp` 加到收口上。
       *
       * 卡上不演的人（`theatre` 低）本来就很少走这条线，这一乘对他们几乎没有影响。
       */
      return push(ch.aggression * 0.55 + ch.risk * 0.45 + ch.tilt * 0.40 - ch.safety * 0.35)
        * theatreDamp(sit.mind.caught);
    case '跟到底看':
      return push(ch.curiosity * 0.50 + ch.callLighter * 0.45 + ch.quitThreshold * 0.35 - ch.safety * 0.55);
    case '收口':
      return push(ch.showoff * 0.30 + ch.arousal * 0.25 - ch.greed * 0.20 - ch.safety * 0.30);
    case '弃':
      /**
       * `- ch.tilt * 0.40` 这一项说的是「上头的人不肯认输」，也就是**反刍**：
       * 输了那一口在脑子里翻来覆去，于是「今天打算弃」这个念头怎么也起不来。
       *
       * 以前这个 0.40 是无条件的（A 线返修报告里点名的那一处）：`ch.tilt` 是个
       * 不带人物色彩的读数，于是岩石一旦被打疼，也和赌徒一样按 0.40 的斜率
       * 变得不肯弃牌 —— 而 §4.7.2 岩石那一行写的是「不上头、不记仇」，
       * 他的原话里根本没有「越气越不肯走」这件事。
       *
       * 现在乘上这个人自己的反刍系数（`tiltFactor`，源头是卡上的
       * `emotion.tiltGain`，常人归一为 1）：岩石 0.18、跟注站 0.12、数学型 0.18
       * ——「接近 0」，被打疼也照样该弃就弃；赌徒 1.76、复仇者 1.24 ——
       * 上头之后是真的走不掉。常人 1.00，行为一个数不变。
       */
      return push(ch.safety * 1.00 - ch.aggression * 0.45 - ch.delayInfo * 0.40
        - ch.quitThreshold * 0.60 - ch.tilt * 0.40 * tiltFactor(sit.persona)
        - ch.looseness * 0.25 - ch.ease * 0.45);
  }
}

/** 按权重抽一条（权重 0 的线路概率为 0 —— 老实人真的不会偷池）。 */
function weightedPick(weights: { line: Line; w: number }[], roll: number): Line {
  const sum = weights.reduce((a, b) => a + b.w, 0);
  if (sum <= 0) return '弃';
  let r = clamp01(roll) * sum;
  for (const x of weights) {
    r -= x.w;
    if (r <= 0) return x.line;
  }
  return weights[weights.length - 1].line;
}

export interface Plan {
  line: Line;
  /** 第几个信息点选的 —— 同一手里它不变，线路就不变 */
  point: number;
  /** 坚持得多紧（人物卡的 `commit`），0..1 */
  commit: number;
  /** 各条线路当时的分，写进 trace 好回答「他为什么走这条」 */
  fit: Partial<Record<Line, number>>;
}

/**
 * 选一条线。种子 = `${bot.id}:${handNo}:${planPoint}`（设计文档 §4.4），
 * 由 `sit.rng` 提供 —— 它本来就是按 `bot.id:handNo:...` 做种的。
 */
export function choosePlan(sit: Scene): Plan {
  const point = planPointOf(sit.state, sit.bot, sit.activeCount);
  const fit: Partial<Record<Line, number>> = {};
  const weights: { line: Line; w: number }[] = [];
  for (const line of LINES) {
    const policy = sit.persona.lines[line];
    const f = lineFit(sit, line);
    fit[line] = f;
    weights.push({ line, w: f * (policy?.weight ?? 0) * moodWeight(sit, line) });
  }
  /**
   * 种子必须是 `${bot.id}:${handNo}:${planPoint}`（§4.4）—— **不含** `turnCount`/`actionSeq`。
   * `sit.rng` 是每一步决策的骰子，同一个信息点上连掷两次会掷出两条不同的线，
   * 那就回到了「每一步独立掷骰子」的老毛病（M3）。`planRoll` 只由这三样做种。
   */
  const line = weightedPick(weights, planRoll(sit.state, sit.bot, String(point)));
  return { line, point, commit: sit.persona.lines[line]?.commit ?? 0.3, fit };
}

/**
 * 这一步跟线路有多合（−1..1）。
 *
 * 正数 = 这就是这条线该干的事；负数 = 走这条线的人现在不该干这个。
 * 它只作为一项加进打分，不否决任何候选 —— 线路是承诺，不是禁令。
 */
/**
 * 线路的执着程度：0 是完全没主意，越大越「我这局就是来干这个的」。
 *
 * 这个数曾经取到 4.0，那是**错的**：动作分本身只有 ±1 的量级，4.0 的推力
 * 等于让线路直接下命令 —— 竞技场里能看到拿着豹子照样按「弃」线弃掉，
 * 拿着散牌照样按「跟到底看」跟到底。线路是承诺，不是禁令（§4.4），
 * 所以它必须跟动作分同一个量级，只在两个动作差不多的时候说了算。
 *
 * 取值是照着三条互相拉扯的验收调的 ——「线路一致性 ≥90%」要它大，
 * §6.4 的人味区间、「情绪进得了决策」和竞技场净胜要它小。
 */
export const PLAN_GAIN = 2.4;

/**
 * 线路对「它不想干的那些动作」的推力折扣。
 *
 * 不对称是有意的：人是「这局我想去偷这一把」，不是「这局我禁止自己跟注」。
 * 正向拉力给满，反向只给三分之一多一点。
 */
export const PLAN_VETO = 0.55;

/**
 * 线路对某个动作的推力（−1..1）。
 *
 * `attempted` 说的是「这条线该干的那件事，这一局我已经干过了没有」——
 * 只有「偷池」在乎它：**打算去偷的人，第一步不会先弃牌**。
 * 偷不到就走是这条线的退出方式，但那是**顶过一手之后**的事；
 * 顶都没顶就把牌扔了，等于这一局根本没打算偷。
 */
export function lineBias(line: Line, key: string, attempted = true): number {
  const kind = key.startsWith('raise') ? 'raise'
    : key.startsWith('compare') ? 'compare'
    : key;
  const table: Record<Line, Partial<Record<string, number>>> = {
    // 「便宜看戏」的退出条件是**升档 → 看牌重选**（§4.4），不是弃牌 ——
    // 这条线上的人就是打算花这点小钱留在场上看下一张脸色的。旧版 fold −0.15
    // 几乎不拦，于是开局一千块的局面里它自己贡献了六成弃牌（S19）。
    // 拦力对齐同样「不靠弃牌退出」的「跟到底看」（−0.55）。
    便宜看戏: { call: +1.0, look: -0.18, raise: -0.60, compare: -0.80, all_in: -1.0, fold: -0.55 },
    闷压: { raise: +1.0, look: -0.60, call: +0.10, compare: -0.35, all_in: -0.30, fold: -0.40 },
    闷比: { compare: +0.85, look: -0.45, call: +0.05, raise: -0.45, all_in: -0.40, fold: -0.30 },
    // 「跟**或**反加，不比牌」（§4.4）—— 两个动作在这条线上是并列的，
    // 哪个更值钱交给 EV 说。旧版 call +0.85 / raise +0.30 那 0.55 的落差
    // 等于把「养池」写成了「只准慢打」，一手豹子面对反加会被这条落差按住不许再加（S5）。
    养池: { call: +0.80, raise: +0.70, compare: -0.90, all_in: -0.35, fold: -0.70 },
    价值加压: { raise: +1.0, call: +0.20, compare: -0.30, all_in: +0.10, fold: -0.85 },
    // 偷不到就走 —— 弃牌是「偷池」的退出方式，不是背叛这条线（§4.4）；
    // 但那是顶过一手之后的事，顶之前的弃牌是把计划本身扔了。
    偷池: { raise: +1.0, call: -0.45, compare: -0.50, all_in: +0.15, fold: attempted ? +0.05 : -0.50 },
    跟到底看: { call: +1.0, raise: -0.30, compare: -0.40, all_in: -0.45, fold: -0.55 },
    收口: { compare: +0.70, all_in: +0.50, fold: +0.20, call: -0.70, raise: -0.35 },
    弃: { fold: +1.0, call: -0.70, raise: -0.90, compare: -0.90, all_in: -1.0 },
  };
  return table[line][kind] ?? 0;
}

/**
 * 线路的第一层作用：**划定候选**（§4.5「线路只限制候选集合，最终在候选里取 EV 最高」）。
 *
 * 九条线里只有两条在 §4.4 的表里被写成一个**封闭的动作集合**，其余七条只是偏好，
 * 交给 `lineBias` 那张推力表（第二层）：
 *
 * - **闷比**：每步的基本动作是「直接比牌」，退出条件栏写的是「—」。看牌是重选线路的
 *   信息点②，先看一眼这一局就不再是闷比了 —— 所以在这条线上看牌不是一个分低的选项，
 *   而是压根不在桌上的选项。（「便宜看戏」写「升档 → 看牌重选」、「闷压」写「对方反加」，
 *   它们都明确给看牌留了出口，所以不在这里。）
 * - **收口（只在单挑且升过两档）**：表里直接写「只在比/梭/弃三者里选（S15）」——
 *   打算把这一手了结掉的人，不会再跟一口把它拖到下一轮。三处收窄：
 *   ① 看牌不在删除之列，它不是「把这一手拖下去」而是 §4.4 的信息点②（看完就重挑线路），
 *      删掉它等于逼着闷牌的人闷着开牌，§6.4 的「闷比占比牌 5–15%」会直接翻三倍；
 *   ② 只在**桌上剩两个人**的时候封闭。§4.4 里 收口 的进入条件是「单挑**或**升档 ≥2 次」，
 *      而 S15 那条场景（这一行自己引的那条）是单挑升档两次；把「升档 ≥2 次」那一半也封闭掉，
 *      就等于一手豹子在三人桌上被升到五万档之后不准再加价，只能开牌或者梭 ——
 *      那正是 §4.6「不往一桌一吓就跑的人脸上梭」和 S5「豹子面对反加要继续养池」
 *      两条验收明确禁止的打法。人多的时候「收口」只是一种偏好，`lineBias` 那张推力表管得住；
 *   ③ 而且要**真的升过两档**（S15 的另一半前提，2026-09-04 P2.1 补回）。
 *      只判人数的话，第 2 轮单挑、价钱还停在开局那一档时跟和加就已经被删光了 ——
 *      S15 描述的那个「已经顶了两轮、该有个了断」的局面根本还没发生，
 *      候选表却已经按它收窄了。这是 P2.1 那条「拿大牌只会开牌不会加价」的候选层来源。
 *
 * 两条都有前提：**手段得在桌上**。比牌没解锁 / 没人可比的时候「闷比」无从执行，
 * 比和梭都不在候选里的时候「收口」也一样，这时候整张表退回第二层，候选一个不删。
 *
 * 这不是 §4.9.3 禁止的那种短路：禁的是「轮次 / 单价 / 成本占比 ≥ 阈值 → 直接返回某个动作」
 * 这类拿局面标量当门槛的写法。这里的前提是「这一局我选了哪条线」，而线路本身是
 * `pickLine` 按 `lineFit × 人物卡权重` 连续抽出来的：同一个局面换个人、换个种子就走别的线，
 * 而且这两条线加起来也只占全部决策步的一成多。
 */
export function planAllows(
  line: Line, key: string, keys: readonly string[], activeCount = 0, tier = 0,
): boolean {
  const kind = key.startsWith('raise') ? 'raise' : key.startsWith('compare') ? 'compare' : key;
  if (line === '闷比') {
    return !(kind === 'look' && keys.some((k) => k.startsWith('compare')));
  }
  if (line === '收口') {
    const closable = keys.some((k) => k.startsWith('compare') || k === 'all_in');
    // ③ 还得**升过两档**。S15 的原文是「单挑**且**升档 ≥2 次时只在比/梭/弃里选」，
    //    旧版只判人数，于是第 2 轮单挑、单价还停在开局那一档（`tier = 0`）时
    //    跟和加就已经被删光了 —— 那正是「拿豹子只会开牌，不会加价」的候选层来源。
    //    这不是牌力门槛：`tier` 是桌上的公开价位，和我手里是什么无关。
    return !(closable && activeCount <= 2 && tier >= 2 && (kind === 'call' || kind === 'raise'));
  }
  return true;
}

/** 这一步算不算「照着线路打」——「线路一致性」这条验收数的就是它。 */
export function onPlan(line: Line, key: string): boolean {
  return lineBias(line, key) >= 0;
}
