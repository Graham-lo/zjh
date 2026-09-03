/**
 * 机器人大脑的场景测试（BRAIN-DESIGN §9 的全表）。
 *
 * 命名规则：**每个用例名以 §9 的编号开头**，编号后面写"人会怎么打"。
 * 改了评估函数就跑整张表 —— 这里的每一条都是一句"真人常识"，
 * 跪了就说明大脑在那个局面上退回成机器了。
 *
 * 另有三类硬约束的用例放在文件末尾：**防偷看**（四类决策 + 发牌前缀）、
 * **确定性**、**合法性兜底**。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  botChao, botDeclare, botFollow, botKou, botLead, botPlay, botThinkMs,
  brainFromState, brainFromSuggestView, isSureMax,
  planSjDealingDeclare, rankFollows, rankLeads, suggest, unseenCards,
  type SjSuggestView,
} from '../shared/sj/bot.ts';
import {
  applySjCommand, closeDeclaring, finishDealing, sanitizeSjRoom, sjCtx, timeoutKou,
  type SjPlayer, type SjRoomState,
} from '../shared/sj/engine.ts';
import { cardFromId, groupOf, sumPoints, type SjCard, type SjGroup } from '../shared/sj/cards.ts';
import { allSingles, parseShape } from '../shared/sj/units.ts';
import { SJ_DECL_TIER, validateFollow } from '../shared/sj/rules.ts';
import { buildView } from '../shared/sj/brain/view.ts';
import type { SjScored } from '../shared/sj/brain/evaluate.ts';
import { pBeat, pTrump } from '../shared/sj/brain/infer.ts';
import { decideChao, fishingBait } from '../shared/sj/brain/declare.ts';
import { drawTrumpValue } from '../shared/sj/brain/lead.ts';
import { chooseBottom, closerConfidence, digValue, findCloser } from '../shared/sj/brain/kou.ts';
import {
  CTX_S5, h, ids, makeSjRoom, mulberry32, playHand, runDeclaring, runToPlaying,
} from './sj-helpers.ts';

/** 一个抄底局面：当前主 `suit` 由 `declarerSeat` 亮的（`strength` 档），我坐 0 */
function chao(spec: string, o: {
  suit: 'S' | 'H' | 'C' | 'D' | 'NT'; strength: number; declarerSeat: number;
  dealerSeat?: number; level?: number;
}) {
  return decideChao({
    hand: h(spec),
    level: o.level ?? 5,
    trump: { suit: o.suit, strength: o.strength, declarerId: 'p' + o.declarerSeat },
    myId: 'p0',
    mySeat: 0,
    dealerSeat: o.dealerSeat ?? o.declarerSeat,
    declarerSeat: o.declarerSeat,
    closerConfidence: 0,
  });
}

/** 扣底：返回埋下去的 8 张 id */
function bury(spec: string, o: Partial<Parameters<typeof chooseBottom>[1]> = {}): string[] {
  return ids(chooseBottom(h(spec), {
    ctx: CTX_S5, trump: 'S', declaredIds: [], defenderSide: false, ...o,
  }));
}

function dealt(seed = 1) {
  const room = makeSjRoom('sj_510k');
  const o = { rng: mulberry32(seed), now: 1_700_000_000_000 };
  applySjCommand(room, room.hostId, { type: 'start' }, o);
  return { room, o };
}

/** 直接摆一个亮主局面：手牌随便换，只有 declare 会读它 */
function withHand(room: SjRoomState, seat: number, spec: string): SjPlayer {
  room.players[seat].hand = h(spec);
  return room.players[seat];
}

/** 摆一个亮主窗口（发完牌的 3/8 秒里）的局面 */
function withHandDeclaring(room: SjRoomState, seat: number, spec: string): SjPlayer {
  room.phase = 'declaring';
  return withHand(room, seat, spec);
}

/** 摆一个"发牌到第 n 张"的前缀：`dealOrder` 就是到手的次序 */
function withDealOrder(room: SjRoomState, seat: number, spec: string): SjPlayer {
  const cards = h(spec);
  room.players[seat].hand = cards;
  room.dealOrder[seat] = cards.map((c) => c.id);
  return room.players[seat];
}

/** 第二局起的局面：庄家在 `dealerSeat`，`seat` 是不是闲家由座位奇偶决定 */
function handTwo(seed = 1, dealerSeat = 1) {
  const { room, o } = dealt(seed);
  room.handNo = 2;
  room.dealerSeat = dealerSeat;
  return { room, o };
}

/* --------------------------------------------------------- 公开视图夹具 */

const EMPTY4: SjGroup[][] = [[], [], [], []];

/** 一个默认的公开视图：主黑桃打 5、庄家坐 0、我坐 0，其余按参数覆盖 */
function V(o: Partial<SjSuggestView> = {}): SjSuggestView {
  return {
    trump: { suit: 'S', level: 5 },
    trick: [],
    playedIds: [],
    mySeat: 0,
    trickNo: 1,
    voidGroups: EMPTY4.map((x) => x.slice()),
    noPairs: EMPTY4.map((x) => x.slice()),
    dealerSeat: 0,
    kouSeat: 0,
    defenderPoints: 0,
    handTrickPoints: [0, 0],
    lastTrick: null,
    levels: [5, 5],
    topLevel: 13,
    declaredIds: [[], [], [], []],
    ...o,
  };
}

/** 首出：返回机器人选的牌 id */
function lead(hand: string, o: Partial<SjSuggestView> = {}): string[] {
  return ids(botLead(V(o), h(hand)));
}

/** 跟牌：`o.trick` 必须已经有首出 */
function follow(hand: string, o: Partial<SjSuggestView>): string[] {
  const view = V(o);
  const shape = parseShape(view.trick[0].cardIds.map(cardFromId), { trump: view.trump.suit, level: view.trump.level })!;
  return ids(botFollow(view, h(hand), shape));
}

/** 候选表里某一手的名次（找不到返回 -1）。用来断言"宁可 A 也不要 B" */
function rankOf(scored: { cards: SjCard[] }[], spec: string): number {
  const want = h(spec).map((c) => c.id).sort().join(',');
  return scored.findIndex((s) => s.cards.map((c) => c.id).sort().join(',') === want);
}

const evOf = (scored: { cards: SjCard[]; ev: number }[], spec: string): number => {
  const i = rankOf(scored, spec);
  return i < 0 ? Number.NEGATIVE_INFINITY : scored[i].ev;
};

/* ====================================================== 9.A 亮主 / 反主 / 加固 */

test('A1 发牌到第 8 张、♠ 只有 3 张含级牌 → 不亮，继续等牌', () => {
  const { room } = dealt();
  const p = withDealOrder(room, 0, 'S5a S2a S3a H2a H3a C2a C3a D2a');
  assert.equal(planSjDealingDeclare(room, p), null, '3 张主远不够门槛');
});

test('A2 发到第 15 张时 ♥ 凑够 7 张含级牌 → 当场亮 ♥（第一局抢庄要 8 张，所以第一局不亮）', () => {
  const prefix = 'H2a H3a H4a H6a H7a H8a S2a S3a S4a S6a C2a C3a C4a C6a H5a';

  const two = handTwo(1, 0);                    // 第二局、我在庄家方 → 门槛 7
  const p = withDealOrder(two.room, 0, prefix);
  const plan = planSjDealingDeclare(two.room, p);
  assert.ok(plan, '7 张红桃含级牌，第二局庄家方达标');
  assert.deepEqual(plan.cardIds, ['H5a']);
  assert.equal(plan.index, 14, '第 15 张（级牌）到手那一刻才亮');

  const one = dealt();                          // 第一局亮主 = 抢庄，门槛 +1
  assert.equal(planSjDealingDeclare(one.room, withDealOrder(one.room, 0, prefix)), null);
});

test('A3 已亮 ♥ 单张，又摸到第二张 ♥ 级牌 → 加固成对', () => {
  const { room, o } = dealt();
  const p = withHandDeclaring(room, 0, 'H5a H2a H3a H4a H6a H7a H8a H9a');
  applySjCommand(room, p.id, { type: 'declare', cardIds: ['H5a'] }, o);
  assert.equal(room.trump.strength, 1);
  p.hand.push(...h('H5b'));
  assert.deepEqual(botDeclare(room, p), ['H5a', 'H5b'], '同花色第二张级牌一律加固');
});

test('A4 对家已亮 ♦，我有 ♠ 对级牌 + 8 张 ♠ → 不反对家', () => {
  const { room, o } = dealt();
  const mate = withHand(room, 2, 'D5a D2a D3a D4a D6a D7a D8a D9a');
  applySjCommand(room, mate.id, { type: 'declare', cardIds: ['D5a'] }, o);
  const me = withHandDeclaring(room, 0, 'S5a S5b S2a S3a S4a S6a S7a S8a');
  assert.equal(botDeclare(room, me), null, '主还是我方的，反对家只会白白暴露级牌');
});

test('A5 对手亮 ♦ 单张、我 ♣ 对级牌且 ♣ 有 9 张 → 反 ♣', () => {
  const { room, o } = dealt();
  const foe = withHand(room, 1, 'D5a D2a D3a D4a D6a D7a D8a D9a');
  applySjCommand(room, foe.id, { type: 'declare', cardIds: ['D5a'] }, o);
  const me = withHandDeclaring(room, 0, 'C5a C5b C2a C3a C4a C6a C7a C8a C9a');
  assert.deepEqual(botDeclare(room, me), ['C5a', 'C5b'], '对子档反得掉单张档');
});

test('A6 对手亮 ♠ 对级牌、我只有 ♦ 对 → 档位反不上去，不动', () => {
  const { room, o } = dealt();
  const foe = withHand(room, 1, 'S5a S5b S2a S3a S4a S6a S7a S8a S9a');
  applySjCommand(room, foe.id, { type: 'declare', cardIds: ['S5a', 'S5b'] }, o);
  const me = withHandDeclaring(room, 0, 'D5a D5b D2a D3a D4a D6a D7a D8a D9a');
  assert.equal(botDeclare(room, me), null, '♦ 对（2 档）低于 ♠ 对（5 档），规则上就反不掉');
});

test('A7 对王 + 王与级牌 9 张、副牌 A 多 → 反成无主；王和级牌太少就不用对王', () => {
  const two = handTwo(1, 0);                    // 第二局、我在庄家方 → 对王门槛 9
  const p = withHandDeclaring(two.room, 0,
    'JBa JBb JSa JSb H5a C5a D5a S5a S5b HAa HAb CAa CAb DAa');
  assert.deepEqual(botDeclare(two.room, p), ['JBa', 'JBb'], '各门都不长，无主把王和 A 全兑现');

  const { room } = dealt();
  const q = withHandDeclaring(room, 1, 'JBa JBb S2a S3a S4a S6a S7a');
  assert.equal(botDeclare(room, q), null, '王 + 级牌只有 2 张，对王也不亮');
});

test('A8 第二局起我是闲家方，7 张 ♥ 含单级牌 → 不亮；9 张才亮', () => {
  const seven = 'H5a H2a H3a H4a H6a H7a H8a C2a C3a D2a D3a S2a S3a';
  const nine = 'H5a H2a H3a H4a H6a H7a H8a H9a HTa C2a C3a D2a D3a';
  const a = handTwo(1, 1);                              // 庄家坐 1 → 座位 0 是闲家方
  assert.equal(botDeclare(a.room, withHandDeclaring(a.room, 0, seven)), null, '闲家亮主 = 替庄家队选主');
  const b = handTwo(1, 1);
  assert.deepEqual(botDeclare(b.room, withHandDeclaring(b.room, 0, nine)), ['H5a'], '9 张就够长，值得选主');
});

test('A9 发牌只剩 4 张、达标却还没人亮 → 立即亮，不再等', () => {
  const { room } = dealt();
  // 25 张里前 20 张就已经达标（9 张 ♥ 含对级牌），但"虚晃一枪"会让它先等
  const spec = 'H2a H3a H4a H6a H7a H8a H9a HTa HJa H5a H5b'
    + ' S2a S3a S4a S6a S7a S8a S9a C2a C3a D2a D3a D4a D6a D7a';
  const p = withDealOrder(room, 0, spec);
  const plan = planSjDealingDeclare(room, p);
  assert.ok(plan, '再等下去就没人亮了，最后 5 张里必须自己亮');
  assert.ok(plan.index >= 19, `等到了发牌末尾才亮（第 ${plan.index + 1} 张）`);
  assert.deepEqual(plan.cardIds, ['H5a', 'H5b']);
});

test('A10 发完无人亮 → 8 秒安静窗口结束后默认无主，且没有抄底阶段', () => {
  const { room, o } = dealt();
  for (const p of room.players) p.hand = h('C2a C3a C4a C6a C7a');   // 谁都没有级牌
  finishDealing(room, o);
  assert.equal(room.declareEndsAt, o.now + 8000, '无人亮主时窗口是 8 秒');
  for (const p of room.players) assert.equal(botDeclare(room, p), null);
  closeDeclaring(room, o);
  assert.equal(room.trump.suit, 'NT', '默认无主');
  assert.equal(room.trump.declarerId, null);
  assert.equal(room.phase, 'kou', '直接扣底，跳过抄底');
});

test('A11 ♠ 对级牌 + 9 张 ♠ 远超门槛 → 发牌途中先不亮（等着反或等着抄），安静窗口里才兜底亮', () => {
  const { room } = handTwo(1, 0);               // 第二局庄家方：对子档门槛 8，9 张就是"远超"
  const spec = 'S2a S3a S4a S6a S7a S8a S9a S5a S5b H2a H3a H4a H6a H7a H8a'
    + ' H9a C2a C3a C4a C6a C7a C8a D2a D3a D4a';
  const plan = planSjDealingDeclare(room, withDealOrder(room, 0, spec));
  assert.ok(plan && plan.index >= 19, '牌力远超门槛，一路按着不亮，拖到发牌收尾才兜底');
  room.phase = 'declaring';
  const me = withHand(room, 0, spec);
  assert.deepEqual(botDeclare(room, me), ['S5a', 'S5b'], '安静窗口里再不亮就默认无主了');
});

test('A12 A11 的牌，对手抢先亮了 ♦ 单张 → 用 ♠ 对反掉（主还是我的，还多知道他 ♦ 长）', () => {
  const { room, o } = dealt();
  const foe = withHand(room, 1, 'D5a D2a D3a D4a D6a D7a D8a D9a');
  applySjCommand(room, foe.id, { type: 'declare', cardIds: ['D5a'] }, o);
  const me = withHandDeclaring(room, 0, 'S5a S5b S2a S3a S4a S6a S7a S8a S9a');
  assert.deepEqual(botDeclare(room, me), ['S5a', 'S5b']);
});

test('A13 对手亮了 ♦ 对、扣完底轮到我 → 抄底（换主 + 底牌到我手里）', () => {
  const { room, o } = dealt();
  const foe = withHand(room, 1, 'D5a D5b D2a D3a D4a D6a D7a D8a D9a');
  applySjCommand(room, foe.id, { type: 'declare', cardIds: ['D5a', 'D5b'] }, o);
  closeDeclaring(room, o);
  timeoutKou(room, o);
  assert.equal(room.phase, 'chao');
  const me = withHand(room, 0, 'S5a S5b S2a S3a S4a S6a S7a S8a S9a STa');
  room.chaoSeat = 0;
  assert.deepEqual(botChao(room, me), ['S5a', 'S5b'], '♠ 对（5 档）抄得掉 ♦ 对（2 档）');
});

test('A14 第二局闲家方：8 张 ♥ 含单级牌不亮，10 张含对级牌才亮', () => {
  const a = handTwo(1, 1);
  assert.equal(
    botDeclare(a.room, withHandDeclaring(a.room, 0, 'H5a H2a H3a H4a H6a H7a H8a H9a C2a D2a')),
    null,
  );
  const b = handTwo(1, 1);
  assert.deepEqual(
    botDeclare(b.room, withHandDeclaring(b.room, 0, 'H5a H5b H2a H3a H4a H6a H7a H8a H9a HTa C2a')),
    ['H5a', 'H5b'],
  );
});

test('A15 只有单张级牌（1 档）→ 达标就亮，不等（等不到反别人的机会）', () => {
  const { room } = dealt();
  const spec = 'H2a H3a H4a H6a H7a H8a H9a HTa S2a S3a S4a H5a'
    + ' C2a C3a C4a C6a C7a D2a D3a D4a D6a D7a D8a S6a S7a';
  const plan = planSjDealingDeclare(room, withDealOrder(room, 0, spec));
  assert.ok(plan, '9 张 ♥ 含单级牌，第一局门槛 8 张，达标');
  assert.equal(plan.index, 11, '第 12 张（级牌）一到手就亮，不留到最后');
  assert.deepEqual(plan.cardIds, ['H5a']);
});

test('A16 手里 ♦ 对 + 对大王、场外还可能有 ♠ 级牌对子 → 先亮 ♦ 对钓鱼，留对大王收网', () => {
  // 四张王 + ♥♣♦ 三色级牌对 → 场外最高只可能到 ♠ 对（5 档），我用对大王（7 档）一定收得回来
  const spec = 'JBa JBb JSa JSb H5a H5b C5a C5b D5a D5b D2a D3a D4a D6a D7a';
  assert.ok(fishingBait(h(spec), 5, 1), '这一手满足钓鱼的三个前提');

  const { room } = dealt();
  const p = withDealOrder(room, 0, spec);
  const plan = planSjDealingDeclare(room, p);
  assert.deepEqual(plan && plan.cardIds, ['D5a', 'D5b'], '亮最低可用档当钓饵，不是一上来就掀对大王');
  room.phase = 'declaring';
  assert.deepEqual(botDeclare(room, p), ['D5a', 'D5b'], '安静窗口里同样是先下饵');
});

test('A17 ♦ 对 + ♠ 对，但对小王/对大王都可能在别人手里 → 不钓，直接亮最强的 ♠ 对', () => {
  const { room } = dealt();
  const spec = 'D5a D5b S5a S5b S2a S3a S4a S6a S7a S8a S9a D2a D3a';
  assert.equal(fishingBait(h(spec), 5, 1), null, '我的最高档只有 5，收不回 6/7 档的抄底');
  assert.deepEqual(botDeclare(room, withHandDeclaring(room, 0, spec)), ['S5a', 'S5b']);
});

test('A18 有 ♦ 对与对大王，但无主本身不达标（收不了网）→ 不钓，按普通账亮', () => {
  const { room } = dealt();
  // 王 + 级牌只有 4 张 → strength(无主) 不过关，对大王收网这条路走不通
  const spec = 'D5a D5b JBa JBb D2a D3a D4a D6a D7a D8a D9a DTa DJa';
  assert.equal(fishingBait(h(spec), 5, 1), null, '用对大王收网必然落到无主，无主不达标就不能钓');
  assert.deepEqual(botDeclare(room, withHandDeclaring(room, 0, spec)), ['D5a', 'D5b']);
});

test('A19 我持 ♣ 对可抄，但 ♣ 只有 5 张、当前主 ♥ 我有 7 张 → 不抄（新主更短、差值不到 2）', () => {
  const { room, o } = dealt();
  const foe = withHand(room, 1, 'H5a H2a H3a H4a H6a H7a H8a H9a');
  applySjCommand(room, foe.id, { type: 'declare', cardIds: ['H5a'] }, o);
  closeDeclaring(room, o);
  timeoutKou(room, o);
  const me = withHand(room, 0, 'C5a C5b C2a C3a C4a H2a H3a H4a H6a H7a H8a HTa');
  room.chaoSeat = 0;
  assert.equal(botChao(room, me), null, '抄过去主反而变少');
});

/* =============================================================== 9.B 抄底 */

test('B1 庄家方对家扣完，我 ♠ 对级牌 + 9 张 ♠、当前主 ♥ 我只有 3 张 → 抄', () => {
  const d = chao('S5a S5b S2a S3a S4a S6a S7a S8a S9a H2a H3a H4a', {
    suit: 'H', strength: 1, declarerSeat: 2,
  });
  assert.ok(d, '换成我 9 张的 ♠ 明显更强');
  assert.deepEqual(ids(d.option.cards), ['S5a', 'S5b']);
});

test('B2 庄家方，当前主是对家亮的、我这门只多 1 张 → 不抄（边际 < 2）', () => {
  const d = chao('S5a S5b S2a S3a S4a S6a H2a H3a H4a H6a H7a', {
    suit: 'H', strength: 6, declarerSeat: 2,
  });
  assert.equal(d, null, '6 张 ♠ 换 5 张 ♥，牌力差不到 2，抄了白搭一次明牌');
});

test('B3 闲家方，对王 + 王级牌 9 张、副牌 3 个 A → 抄成无主，扣底时埋 K/10', () => {
  const d = chao('JBa JBb JSa JSb H5a C5a S5a D5a D5b SAa SAb SKa SKb CAa CAb CKa CKb', {
    suit: 'H', strength: 1, declarerSeat: 1, dealerSeat: 1,
  });
  assert.ok(d, '闲家方抄成无主，底牌落到我手里');
  assert.deepEqual(ids(d.option.cards), ['JBa', 'JBb']);
  // 抄成底之后我方最后一圈有把握 → 扣底时主动把 K/10 埋进去（C6 的另一面）
  const buried = bury('HAa HAb HKa HKb HTa HTb CAa CAb CKa CKb CTa CTb'
    + ' D2a D3a D4a D6a D7a D8a D9a DTa DJa DQa DKa DAa'
    + ' S2a S3a S4a S6a S7a S8a S9a STa SJa',
  { defenderSide: true, closerConfidence: 0.9 });
  assert.ok(buried.filter((id) => id[1] === 'K' || id[1] === 'T').length >= 4, '故意埋 K/10 等着抠底');
});

test('B4 闲家方，♦ 对级牌 ♦ 8 张但没有主绝张 → 不抄（明牌暴露 + 底分埋不安全）', () => {
  const d = chao('D5a D5b D2a D3a D4a D6a D7a D8a H2a H3a H4a', {
    suit: 'H', strength: 1, declarerSeat: 1, dealerSeat: 1,
  });
  assert.equal(d, null, '闲家方抄底的门槛更高：≥9 张才值得');
});

test('B5 我就是当前亮主者被轮询 → 只有对王反无主且达标才做，否则不抄', () => {
  const strong = decideChao({
    hand: h('JBa JBb JSa JSb H5a C5a S5a D5a D5b SAa SAb SKa SKb CAa CAb CKa CKb'),
    level: 5,
    trump: { suit: 'S', strength: 5, declarerId: 'p0' },
    myId: 'p0', mySeat: 0, dealerSeat: 0, declarerSeat: 0,
  });
  assert.deepEqual(strong && ids(strong.option.cards), ['JBa', 'JBb'], '自反无主');

  const weak = decideChao({
    hand: h('JBa JBb S5a S5b S2a S3a S4a S6a S7a S8a'),
    level: 5,
    trump: { suit: 'S', strength: 5, declarerId: 'p0' },
    myId: 'p0', mySeat: 0, dealerSeat: 0, declarerSeat: 0,
  });
  assert.equal(weak, null, '王和级牌不够 9 张，自己反自己没意义');
});

test('B6 抄成 ♠ 之后扣底：优先把上一个亮主者的 ♦ 门扣光（造缺门毙他的长门）', () => {
  const dia = 'D3a D4a D6a D7a D8a D9a DJa DQa';           // 不算小，正常不会优先埋
  const hand = 'S5a S2a S3a S4a S6a S7a S8a S9a'
    + ' ' + dia
    + ' H2a H3a H4a H6a H7a H8a H9a HJa HQa'
    + ' C2a C3a C4a C6a C7a C8a C9a CJa';
  const withRival = bury(hand, { rivalLongSuit: 'D' });
  const without = bury(hand);
  assert.deepEqual(withRival.slice().sort(), dia.split(' ').sort(), '♦ 八张全埋，直接造缺门');
  assert.notDeepEqual(withRival.slice().sort(), without.slice().sort(), '不知道对手 ♦ 长时不会这么扣');
});

test('B7 无人亮主默认无主的局 → 没有抄底阶段，botChao 一次都不会被调用', () => {
  const { room, o } = dealt();
  for (const p of room.players) p.hand = h('C2a C3a C4a C6a C7a');   // 谁都亮不了
  finishDealing(room, o);
  closeDeclaring(room, o);                      // 8 秒窗口里没人亮
  assert.equal(room.trump.suit, 'NT', '默认无主');
  assert.equal(room.trump.declarerId, null);
  assert.equal(room.phase, 'kou', '直接进扣底，跳过抄底');
  assert.equal(botChao(room, room.players[room.kouSeat!]), null, 'phase 不是 chao，botChao 只返回 null');
  timeoutKou(room, o);
  assert.equal(room.phase, 'playing', '扣完直接开打，中间没有 chao');
});

test('B7 无主局的扣底按无主打分：副牌 A/K 的权重更高，宁可埋别的也不埋 A', () => {
  const hand = 'H2a H3a H4a H6a H7a H8a H9a HJa HQa'
    + ' C2a C3a C4a C6a C7a C8a C9a CJa CQa'
    + ' D2a D3a D4a D6a D7a D8a D9a DJa DQa'
    + ' S2a S3a SAa SAb DAa CAa';
  const nt = ids(chooseBottom(h(hand), {
    ctx: { trump: 'NT', level: 5 }, trump: 'NT', declaredIds: [], defenderSide: false,
  }));
  assert.ok(!nt.some((id) => id[1] === 'A'), '无主局里每个 A 都是一圈，一张都不埋');
});

/* =============================================================== 9.C 扣底 */

// 33 张：♦ 只有 2 张、♣ 只有 3 张、♥ 12 张、♠（主）16 张
const C_HAND = 'D2a D3a'
  + ' C2a C3a C4a'
  + ' H2a H3a H4a H6a H7a H8a H9a HTa HJa HQa HKa HAa'
  + ' S5a S2a S2b S3a S3b S4a S4b S6a S7a S8a S9a STa SJa SQa SKa SAa';

test('C1 ♦ 2 张 / ♣ 3 张 / 其余长 → 扣光 ♦ 和 ♣ 造两个缺门，剩下补最长副门的最小不带分牌', () => {
  const b = bury(C_HAND);
  assert.equal(b.length, 8);
  for (const id of ['D2a', 'D3a', 'C2a', 'C3a', 'C4a']) {
    assert.ok(b.includes(id), `${id} 该埋：埋光了就是一个缺门`);
  }
  const rest = b.filter((id) => !id.startsWith('D') && !id.startsWith('C'));
  assert.deepEqual(rest, ['H2a', 'H3a', 'H4a'], '补的三张来自最长的 ♥，且是最小的不带分牌');
});

test('C3 不扣主：底里一张主都没有', () => {
  const b = bury(C_HAND);
  assert.ok(!b.some((id) => id.startsWith('S')), '主牌是本钱，一张都不埋');
});

test('C3 主 ≥ 15 张、副牌全是硬货 → 才允许把最小的两张主埋掉', () => {
  const hand = 'S5a S5b S2a S2b S3a S3b S4a S4b S6a S6b S7a S7b S8a S8b S9a S9b STa STb SJa SJb SQa'
    + ' HAa HAb HKa HKb HTa HTb CAa CAb CKa CKb CTa CTb';
  const b = bury(hand);
  const trumps = b.filter((id) => id.startsWith('S'));
  assert.equal(trumps.length, 2, '只让埋最小的两张主');
  assert.deepEqual(trumps.sort(), ['S2a', 'S2b'], '埋的是最小的那两张');
});

test('C2 10/K 必须留，实在不够扣才埋 5', () => {
  const hand = 'H5a H5b H2a H3a'          // ♥ 的 5 是副级牌 → 归主组，用 ♦♣ 的 5 试
    + ' D5a D5b DTa DKa D2a D3a D4a D6a'
    + ' C5a C5b CTa CKa C2a C3a C4a C6a'
    + ' S5a S2a S3a S4a S6a S7a S8a S9a STa SJa SQa SKa SAa';
  const b = bury(hand);
  const pts = b.filter((id) => ['5', 'T', 'K'].includes(id[1]) && !id.startsWith('S') && !id.startsWith('H'));
  assert.ok(!pts.some((id) => id[1] === 'T' || id[1] === 'K'), '10 和 K 是 10 分，先埋别的');
  const small = b.filter((id) => !['5', 'T', 'K'].includes(id[1]));
  assert.ok(small.length >= 6, '优先埋不带分的小牌');
});

test('C4 不拆对子和拖拉机，副牌 A 也不埋', () => {
  const hand = 'S5a S2a S3a S4a S6a S7a S8a'
    + ' H2a H2b H3a H3b HAa HAb H6a H7a H8a H9a'
    + ' C2a C2b C3a C3b CAa C6a C7a C8a'
    + ' D2a D3a D4a D6a D7a D8a D9a DAa';
  const b = bury(hand);
  assert.ok(!b.some((id) => id[1] === 'A'), '副牌 A 是稳赢的一圈，不埋');
  for (const pair of [['H2a', 'H2b'], ['H3a', 'H3b'], ['C2a', 'C2b'], ['C3a', 'C3b']]) {
    assert.ok(!pair.some((id) => b.includes(id)), `拆 ${pair[0]} 的对子等于自断结构`);
  }
});

test('C5 亮出去的明牌不埋（埋了等于把底告诉全场）', () => {
  const hand = 'S5a S5b S2a S3a S4a'
    + ' H2a H3a H4a H6a H7a H8a H9a HTa'
    + ' C2a C3a C4a C6a C7a C8a C9a CTa'
    + ' D2a D3a D4a D6a D7a D8a D9a DTa DJa DQa DKa DAa D5a';
  const b = bury(hand, { declaredIds: ['S5a', 'S5b'] });
  assert.ok(!b.includes('S5a') && !b.includes('S5b'), '明牌留在手里');
});

test('C6 闲家方抄成底 + 有主绝张 → 主动把 K / 10 埋进底里（抠底本钱）', () => {
  const hand = 'S5a S5b S2a S3a S4a S6a S7a'
    + ' H2a H3a HTa HKa H6a H7a H8a H9a'
    + ' C2a C3a CTa CKa C6a C7a C8a C9a'
    + ' D2a D3a DTa DKa D6a D7a D8a D9a D4a';
  const greedy = bury(hand, { defenderSide: true, closerConfidence: 0.9 });
  const plain = bury(hand, { defenderSide: true, closerConfidence: 0.2 });
  const bigIn = (b: string[]) => b.filter((id) => id[1] === 'T' || id[1] === 'K').length;
  assert.ok(bigIn(greedy) >= 4, '有把握抠底 → 底里堆分');
  assert.equal(bigIn(plain), 0, '没把握就别送 —— 底分最后是庄家的');
});

test('C7 扣完底 → bottomPointsExact 立刻入账，closer 计划同时成立', () => {
  const { room, o } = dealt();
  runToPlaying(room, o);
  const kou = room.players[room.kouSeat!];
  const mine = buildView({
    trump: { suit: room.trump.suit, level: room.trump.level },
    playedIds: [], mySeat: kou.seat, trickNo: 1,
    kouSeat: room.kouSeat, dealerSeat: room.dealerSeat,
    bottom: room.bottom,
  }, kou.hand);
  assert.equal(mine.bottomPointsExact, sumPoints(room.bottom), '扣底的人自己知道底里几分');
  assert.equal(mine.iAmKou, true);

  const other = buildView({
    trump: { suit: room.trump.suit, level: room.trump.level },
    playedIds: [], mySeat: (kou.seat + 1) % 4, trickNo: 1,
    kouSeat: room.kouSeat, dealerSeat: room.dealerSeat,
  }, room.players[(kou.seat + 1) % 4].hand);
  assert.equal(other.bottomPointsExact, null, '别人只有期望值');
  assert.ok(other.bottomPointsExpected > 0);
});

/* =============================================================== 9.D 首出 */

/** 一手牌里除了这几张之外的整副牌都当成"已经打过"，用来把场面压到只剩几圈 */
function allPlayedExcept(specs: string): string[] {
  const keep = new Set(h(specs).map((c) => c.id));
  return unseenCards([], []).map((c) => c.id).filter((id) => !keep.has(id));
}

test('D1 ♥A 对是绝张、对手没缺 ♥ → 出对 A 收分', () => {
  assert.deepEqual(lead('HAa HAb H2a C2a D2a S2a'), ['HAa', 'HAb'], '绝张对子先兑现');
});

test('D2 ♥A 对绝张，但两个对手都公开缺 ♥ → 不出（送到对手主上），改抽主/探别门', () => {
  const out = lead('HAa HAb S6a S7a C2a D2a', {
    voidGroups: [[], ['H'], [], ['H']],
  });
  assert.notDeepEqual(out, ['HAa', 'HAb'], '两个对手都缺 ♥，对 A 出去就是喂主');
});

test('D3 对家公开缺 ♥、对手没缺、我有 ♥K → 出 ♥K 喂对家毙', () => {
  const out = lead('HKa H2a C2a C3a D2a D3a S9a', {
    voidGroups: [[], [], ['H'], []],
  });
  assert.deepEqual(out, ['HKa'], '对家缺 ♥ 有主 → 这 10 分是送给自己人的');
});

// D4/D5 共用一个局面：中局，我三门副牌都握着绝张（♥A 对、♣A、♦A），主还剩几张在场外。
// 唯一的差别是两个对手是否已经公开缺主。
const D4_HAND = 'SAa SQa SJa HAa HAb CAa DAa';
const D4_PLAYED = allPlayedExcept(
  'SAa SQa SJa HAa HAb CAa DAa S8a S7a S6a H5a HTa HKa H3a C3a C4a C6a C7a D3a D4a D6a D7a'
  + ' S5a S5b H2a H2b C2a C2b D2a',
);

test('D4 我方主多、副牌有绝张、对手可能有主 → 先出顶张主抽主', () => {
  const scored = rankLeads(V({ playedIds: D4_PLAYED, trickNo: 15 }), h(D4_HAND));
  const top = scored[0];
  assert.equal(groupOf(top.cards[0], CTX_S5), 'T', '三门副牌都有绝张 → 先把对手的主榨干');
  assert.ok(top.parts.drawValue > 0, '这一手的分数里必须真的含抽主价值，而不是碰巧');
  assert.ok(top.why.some((w) => w.includes('抽主')), 'why 要说得出为什么');
});

test('D5 两个对手都公开缺主 → 停止抽主，改兑现副牌绝张', () => {
  const scored = rankLeads(
    V({ playedIds: D4_PLAYED, trickNo: 15, voidGroups: [[], ['T'], [], ['T']] }),
    h(D4_HAND),
  );
  assert.ok(
    scored.every((sc) => !sc.parts.drawValue),
    '对手没主了，抽主价值必须整体归零 —— 再抽只会把对家的主一起抽干',
  );
  assert.notEqual(groupOf(scored[0].cards[0], CTX_S5), 'T', '改成兑现副牌绝张');
  assert.ok(scored[0].parts.secureWin > 0.9, '兑现的是稳赢的那张');
});

test('D6 我方主少、对手主多 → 不抽主，出最短副门的小单张探路', () => {
  const out = lead('S2a HKa HQa HJa HTa H9a H8a C3a D4a D5a D6a D7a', { trickNo: 2 });
  assert.notEqual(groupOf(cardFromId(out[0]), CTX_S5), 'T', '就一张主，抽主是给对手送节奏');
  assert.deepEqual(out, ['C3a'], '出最短那门的最小牌探路');
});

test('D7 没好牌 → 出最短副门最小不带分单张：不出 10/K 探路，也不拆对子', () => {
  const out = lead('HTa HKa C2a C2b D3a D4a D6a D7a D8a S9a');
  assert.deepEqual(out, ['D3a'], '10 和 K 是分，对子是结构，探路只能用最小的散牌');
});

test('D8 对家上一圈首出过 ♣ 且没缺 → 回 ♣', () => {
  const out = lead('C4a C9a H3a H4a D3a D4a S9a', {
    trickNo: 3,
    lastTrick: {
      leaderSeat: 2,
      plays: [
        { seat: 2, cardIds: ['CAa'] }, { seat: 3, cardIds: ['C2a'] },
        { seat: 0, cardIds: ['C3a'] }, { seat: 1, cardIds: ['C5a'] },
      ],
    },
  });
  assert.equal(groupOf(cardFromId(out[0]), CTX_S5), 'C', '对家点了 ♣，那门是他要的');
});

test('D9 对 A + 单 A 全是绝张 → 甩；其中一张不是绝张 → 拆开出，不甩', () => {
  // ♥ 全场只剩我手里这三张（同牌先出者大，所以 ♥K 也是绝张）→ 甩得成
  const sure = lead('HAa HAb HKa', {
    playedIds: allPlayedExcept('HAa HAb HKa S2a S3a S4a C2a C3a D2a D3a'), trickNo: 12,
  });
  assert.equal(sure.length, 3, '三张全是绝张 → 一次甩掉');

  // 换成 ♥Q，而 ♥K 还在场外 → 单张不再是绝张
  const risky = lead('HAa HAb HQa', {
    playedIds: allPlayedExcept('HAa HAb HQa HKa S2a S3a S4a C2a C3a D2a D3a'), trickNo: 12,
  });
  assert.equal(risky.length, 2, '有一张管不住就别甩，−10 分不值');
  assert.deepEqual(risky, ['HAa', 'HAb'], '拆开出：先兑现稳赢的对 A');
});

test('D10 剩 3 圈、我持主对子绝张（closer）、底里有分 → 不动 closer', () => {
  const played = allPlayedExcept('SAa SAb H2a C2a D2a S2a S3a H3a C3a D3a S4a S5a');
  const out = lead('SAa SAb H2a', { playedIds: played, trickNo: 23, kouSeat: 1, dealerSeat: 1 });
  assert.deepEqual(out, ['H2a'], '主对绝张是最后一圈抠底的本钱，中途不能花掉');
});

test('D11 最后一圈、闲家方、有能赢的主拖拉机 → 出拖拉机（×8）', () => {
  // 最后一圈：我手里 4 张 = 一副主 2 连对；场外 20 张（三家各 4 + 底 8），底里有分
  const played = allPlayedExcept(
    'SAa SAb SKa SKb H2a H3a H4a H6a C2a C3a C4a C6a D2a D3a D4a D6a H5a HTa C5a CTa',
  );
  const scored = rankLeads(
    V({ playedIds: played, trickNo: 25, mySeat: 0, dealerSeat: 1, kouSeat: 1 }),
    h('SAa SAb SKa SKb'),
  );
  assert.equal(scored[0].cards.length, 4, '最后一圈用拖拉机收，底分 ×8');
  assert.equal(scored[0].parts.digMult, 8, '两连对 → 2^(1+2) = ×8');
  assert.ok(scored[0].ev > scored[1].ev, '×8 抠底把拖拉机拉开到第一');
});

test('D12 最后一圈、庄家方、赢不了 → 出单张止损（×2），赢得了才出大牌型', () => {
  // 最后一圈：我方是庄家，手里两张小 ♥，场外主全是对子（谁毙都毙得成对）
  // 两个对手都公开缺 ♥，场外的牌全是主 —— 这一圈我怎么打都是他们的
  const played = allPlayedExcept(
    'H2a H2b SAa SAb SKa SKb SQa SQb C3a C3b C4a C4b D3a D3b',
  );
  const scored = rankLeads(
    V({
      playedIds: played, trickNo: 25, mySeat: 0, dealerSeat: 0, kouSeat: 0,
      voidGroups: [[], ['H'], [], ['H']],
    }),
    h('H2a H2b'),
  );
  assert.equal(scored[0].cards.length, 1, '赢不了就别把倍数做大，×2 止损');
  const pair = scored.find((sc) => sc.cards.length === 2)!;
  assert.equal(pair.parts.digMult, 4, '出对子 = 对手抠底 ×4');
  assert.ok(pair.ev < scored[0].ev, '倍数是替对手做大的，赢不了就压回 ×2');
});

test('D13 庄家本人知道底里 0 分 → 尾局不必留主护底', () => {
  const { room, o } = dealt();
  runToPlaying(room, o);
  const kou = room.players[room.kouSeat!];
  const v = buildView({
    trump: { suit: room.trump.suit, level: room.trump.level },
    playedIds: [], mySeat: kou.seat, trickNo: 1,
    kouSeat: room.kouSeat, dealerSeat: room.dealerSeat, bottom: room.bottom,
  }, kou.hand);
  assert.equal(v.bottomPointsExact, sumPoints(room.bottom));
  const closer = findCloser(v);
  if (v.bottomPointsExact === 0) {
    assert.equal(digValue(v, closer), 0, '底里 0 分 → closer 一文不值，随便花');
  } else {
    assert.ok(digValue(v, closer) >= 0);
  }
});

test('D14 通关局庄家方（守住就赢下整场）→ 门槛边际翻倍，比平时更保守', () => {
  // 闲家 70 分、场外还剩 10 分 → 预估终局分正好压在 80 线上
  const hand = 'SAa SKa SQa H2a H3a C2a D2a';
  const played = allPlayedExcept(
    'SAa SKa SQa H2a H3a C2a D2a S2a S3a S4a S6a S7a S8a S9a H4a H6a C3a C4a D3a D4a HTa',
  );
  const base = { playedIds: played, topLevel: 13, defenderPoints: 70, trickNo: 19 };
  const normal = rankLeads(V({ ...base, levels: [5, 5] }), h(hand));
  const match = rankLeads(V({ ...base, levels: [13, 5] }), h(hand));
  assert.ok(!normal[0].parts.matchPoint, '平时不是通关局');
  assert.ok(match[0].parts.matchPoint, '庄家方已打到最高级 → 这一局守住就赢下整场');
  assert.ok(
    Math.abs(match[0].parts.m - normal[0].parts.m * 1.5) < 1e-6,
    '通关局压在 80 线上 → 边际价值 ×1.5，每一分都比平时重',
  );
  assert.ok(Math.abs(match[0].ev) > Math.abs(normal[0].ev), '同一手牌，通关局的得失都被放大');
});

/* ============================================================ 9.E 跟牌 · 第二家 */

/** 跟牌候选表（带 parts / why），首出方在 `o.trick[0]` */
function rankF(hand: string, o: Partial<SjSuggestView>): SjScored[] {
  const view = V(o);
  const shape = parseShape(
    view.trick[0].cardIds.map(cardFromId), { trump: view.trump.suit, level: view.trump.level },
  )!;
  return rankFollows(view, h(hand), shape);
}

test('E1 首出小单张无分、我有 A → 跟小（二家小）', () => {
  const out = follow('HAa H3a H4a C2a D2a', {
    trick: [{ seat: 3, cardIds: ['H6a'] }], mySeat: 0, trickNo: 5,
  });
  assert.deepEqual(out, ['H3a'], '二家小：对家坐末家，A 留着自己当首出用');
});

test('E2 首出 10、我有稳赢的 A → 截', () => {
  // ♥ 的大牌都走完了，对家又公开缺 ♥ 和主 —— 指望不上他，这 10 分只能我自己收
  const out = follow('HAa HAb H3a C2a D2a', {
    trick: [{ seat: 3, cardIds: ['HTa'] }], mySeat: 0, trickNo: 12,
    playedIds: allPlayedExcept('HAa HAb H3a HTa C2a D2a S2a S3a S4a C3a D3a H4a'),
    voidGroups: [[], [], ['H', 'T'], []],
  });
  assert.deepEqual(out, ['HAa'], '对家救不了 → 二家也要截，10 分不能白丢');
});

test('E3 首出无分、我缺门 → 不毙，垫最短门最小', () => {
  const scored = rankF('SAa S3a C2a C3a C4a D2a', {
    trick: [{ seat: 3, cardIds: ['H6a'] }], mySeat: 0, trickNo: 5,
  });
  assert.deepEqual(ids(scored[0].cards), ['D2a'], '一张不带分的圈不值得动主，垫最短门（♦ 只有 1 张）');
  assert.ok(scored[0].parts.voidGain > 0, '垫掉短门是在造缺门，这个价值要进账');
});

test('E4 首出 K、我缺门有主 → 最小能毙', () => {
  // 对家公开缺主（救不了），场外只剩两张比我小的主 → 小主毙得住
  const out = follow('SAa S3a S4a C2a C3a', {
    trick: [{ seat: 3, cardIds: ['HKa'] }], mySeat: 0, trickNo: 14,
    playedIds: allPlayedExcept('SAa S3a S4a C2a C3a HKa H3a H4a D2a D3a C4a C5a S2a S2b'),
    voidGroups: [[], [], ['T'], []],
  });
  assert.deepEqual(out, ['S3a'], '毙就毙，但用最小够用的那张，大主留着');
});

test('E5 首出对子带分、我有对 A 绝张 → 出对 A', () => {
  const out = follow('HAa HAb H3a C2a D2a', {
    trick: [{ seat: 3, cardIds: ['HTa', 'HTb'] }], mySeat: 0, trickNo: 12,
    playedIds: allPlayedExcept('HAa HAb H3a HTa HTb C2a D2a S2a S3a H4a H5a'),
  });
  assert.deepEqual(out, ['HAa', 'HAb'], '对 A 是绝张，20 分的对子直接收下');
});

/* ============================================================ 9.F 跟牌 · 第三家 */

test('F1 对家出 A 稳赢、我有 10 → 垫 10', () => {
  const out = follow('HTa H3a C2a D2a', {
    trick: [{ seat: 2, cardIds: ['HAa'] }, { seat: 3, cardIds: ['H4a'] }], mySeat: 0, trickNo: 12,
    playedIds: allPlayedExcept('HAa HTa H3a H4a C2a D2a S2a S3a S4a HKa H5a'),
  });
  assert.deepEqual(out, ['HTa'], '对家的 A 稳收 → 把 10 分垫给自己人');
});

test('F2 对家出 K 但场外还有 A 且第四家未缺门 → 不垫分，跟最小', () => {
  const out = follow('HTa H3a C2a D2a', {
    trick: [{ seat: 2, cardIds: ['HKa'] }, { seat: 3, cardIds: ['H4a'] }], mySeat: 0, trickNo: 5,
  });
  assert.deepEqual(out, ['H3a'], '♥A 还在场外，垫 10 等于给对手送 20 分');
});

test('F3 对家出 Q 顶不住、我有 A、桌上有分 → 盖自家（对家不稳我能稳）', () => {
  // 对家的 ♥Q 被对手的 ♥K 盖了，桌上 10 分 —— 我这张 A 是同门绝张，必须接管
  const scored = rankF('HAa H3a C2a', {
    trick: [{ seat: 2, cardIds: ['HQa'] }, { seat: 3, cardIds: ['HKa'] }], mySeat: 0, trickNo: 22,
    playedIds: allPlayedExcept(
      'HAa HQa HKa H3a C2a H4a H6a H7a C3a C4a C6a C7a D2a D3a D4a D6a S2a S3a S4a S6a',
    ),
  });
  assert.deepEqual(ids(scored[0].cards), ['HAa'], '对家的 Q 已经被盖 → 我用 A 接管，10 分收回来');
  assert.ok(scored[0].parts.secureWin >= 0.8, '接管的前提是这一张同门无敌（只剩被毙的可能）');
});

test('F4 对家出 A、我有 A（第二副）→ 不盖，跟最小', () => {
  const out = follow('HAb H3a C2a D2a', {
    trick: [{ seat: 2, cardIds: ['HAa'] }, { seat: 3, cardIds: ['H4a'] }], mySeat: 0, trickNo: 5,
  });
  assert.deepEqual(out, ['H3a'], '同牌先出者大，第二张 A 盖不过自家的 A，纯属浪费');
});

test('F5 对家毙了在赢且稳、我也缺门 → 垫分', () => {
  const out = follow('CKa C3a D2a', {
    trick: [{ seat: 2, cardIds: ['SAa'] }, { seat: 3, cardIds: ['H4a'] }], mySeat: 0, trickNo: 14,
    playedIds: allPlayedExcept('SAa CKa C3a D2a H4a H6a H7a C4a C6a D3a D4a'),
  });
  assert.deepEqual(out, ['CKa'], '对家用主毙住了 → 把 10 分垫进自家的圈');
});

test('F6 对家没赢、我不能赢 → 跟最小不带分', () => {
  const out = follow('HTa H3a H4a C2a', {
    trick: [{ seat: 2, cardIds: ['H6a'] }, { seat: 3, cardIds: ['HAa'] }], mySeat: 0, trickNo: 5,
  });
  assert.deepEqual(out, ['H3a'], '这一圈是对手的，一分都别加进去');
});

test('F7 对甩牌：对家赢 → 结构里填分；对手赢 → 填最小', () => {
  const played = allPlayedExcept(
    'HAa HAb H6a HTa HKa H3a H4a H7a C2a C3a D2a D3a S2a S3a S4a S6a',
  );
  const mine = 'HTa HKa H3a H4a H7a C2a';
  const win = follow(mine, {
    trick: [{ seat: 2, cardIds: ['HAa', 'HAb', 'H6a'] }], mySeat: 0, trickNo: 14, playedIds: played,
  });
  assert.ok(win.includes('HKa') && win.includes('HTa'), '对家甩的是绝张 → 三张里把分全填进去');
  const lose = follow(mine, {
    trick: [{ seat: 3, cardIds: ['HAa', 'HAb', 'H6a'] }], mySeat: 0, trickNo: 14, playedIds: played,
  });
  assert.deepEqual(lose.slice().sort(), ['H3a', 'H4a', 'H7a'], '对手甩的 → 三张全出不带分的');
});

/* ============================================================ 9.G 跟牌 · 第四家 */

test('G1 末家能赢 → 最小能赢；不能赢 → 最小不带分', () => {
  const played = allPlayedExcept('HAa HKa HTa H3a H4a H7a H6a C2a C3a D2a D3a S2a S3a');
  const canWin = follow('HAa HTa H3a', {
    trick: [{ seat: 1, cardIds: ['H4a'] }, { seat: 2, cardIds: ['H7a'] }, { seat: 3, cardIds: ['H6a'] }],
    mySeat: 0, trickNo: 14, playedIds: played,
  });
  assert.deepEqual(canWin, ['HTa'], '末家赢就够了，用最小能赢的那张（♥10 已经压得住 ♥6）');
  const cannot = follow('HTa H3a', {
    trick: [{ seat: 1, cardIds: ['H4a'] }, { seat: 2, cardIds: ['H7a'] }, { seat: 3, cardIds: ['HAa'] }],
    mySeat: 0, trickNo: 14, playedIds: played,
  });
  assert.deepEqual(cannot, ['H3a'], '赢不了就跟最小不带分的');
});

test('G2 对家在赢 → 末家垫最多的分', () => {
  const out = follow('CKa CTa C3a', {
    trick: [{ seat: 1, cardIds: ['H4a'] }, { seat: 2, cardIds: ['SAa'] }, { seat: 3, cardIds: ['H7a'] }],
    mySeat: 0, trickNo: 14,
    playedIds: allPlayedExcept('SAa CKa CTa C3a H4a H6a H7a H8a C4a C6a D2a D3a'),
  });
  assert.deepEqual(out, ['CTa'], '对家稳收 → 垫 10 分；同样 10 分先给牌力小的 10，K 留着还能收圈');
});

test('G3 对手毙了、桌上 25 分我盖；桌上 0 分不盖', () => {
  const played = allPlayedExcept('SAa S3a S4a HKa HTa H5a H3a H4a C2a C3a D2a D3a S2a S2b');
  const rich = follow('SAa S3a C2a', {
    trick: [{ seat: 1, cardIds: ['HKa'] }, { seat: 2, cardIds: ['HTa'] }, { seat: 3, cardIds: ['S4a'] }],
    mySeat: 0, trickNo: 14, playedIds: played,
  });
  assert.deepEqual(rich, ['SAa'], '桌上 20 分被对手毙走 → 必须盖回来');
  const poor = follow('SAa S3a C2a', {
    trick: [{ seat: 1, cardIds: ['H3a'] }, { seat: 2, cardIds: ['H5a'] }, { seat: 3, cardIds: ['S4a'] }],
    mySeat: 0, trickNo: 14, playedIds: played,
  });
  assert.notDeepEqual(poor, ['SAa'], '一分没有的圈，不值得把大主砸进去');
});

test('G4 盖只能动 closer、桌上 10 分、底里 20 分 → 不盖', () => {
  const played = allPlayedExcept('SAa SAb C2a C3a HKa H3a H4a H5a D2a D3a D4a S3a S4a');
  const out = follow('SAa SAb C2a', {
    trick: [{ seat: 1, cardIds: ['HKa'] }, { seat: 2, cardIds: ['H3a'] }, { seat: 3, cardIds: ['S3a'] }],
    mySeat: 0, trickNo: 22, playedIds: played, dealerSeat: 1, kouSeat: 1,
  });
  assert.equal(out.length, 1);
  assert.notEqual(out[0], 'SAa', '这对主 A 是最后一圈抠底的本钱，10 分不值得拆');
});

/* ================================================================ 9.H 主牌圈 */

test('H1 对手出大王抽主、我有小主和对 K 主 → 跟最小单主，不拆对', () => {
  const out = follow('S3a SKa SKb C2a D2a', {
    trick: [{ seat: 3, cardIds: ['JBa'] }], mySeat: 0, trickNo: 6,
  });
  assert.deepEqual(out, ['S3a'], '大王管不住，扔最小的单主，主 K 对留着');
});

test('H2 对手抽主、我持 closer 且有别的主 → closer 不跟出去', () => {
  // 场外的主只剩比我小的 → 主 A 对就是锁最后一圈的 closer
  const played = allPlayedExcept('SAa SAb S3a S4a C2a D2a S2a S2b H3a H4a C3a C4a');
  const out = follow('SAa SAb S3a S4a C2a', {
    trick: [{ seat: 3, cardIds: ['S2a'] }], mySeat: 0, trickNo: 20,
    playedIds: played, dealerSeat: 1, kouSeat: 1,
  });
  assert.deepEqual(out, ['S3a'], 'closer 是抠底的本钱，抽主的时候绝不跟出去');
});

test('H3 对家出顶张主、我有主 10 → 垫主 10', () => {
  const played = allPlayedExcept('JBa STa S3a S4a C2a D2a S6a S7a H3a H4a');
  const out = follow('STa S3a S4a C2a D2a', {
    trick: [{ seat: 2, cardIds: ['JBa'] }, { seat: 3, cardIds: ['S6a'] }],
    mySeat: 0, trickNo: 14, playedIds: played,
  });
  assert.deepEqual(out, ['STa'], '对家的大王稳收 → 把主 10 的 10 分垫给自家');
});

test('H4 对家出小主探主、我有次大主、对手可能更大 → 接管', () => {
  // 对家出小主探路，被对手用更大的小主盖了；主里只剩 ♠A 比我的 ♠K 大
  const played = allPlayedExcept(
    'SKa S3a HAa CAa DAa SAa S6a S9a S2a H3a H4a C3a C4a D3a D4a H6a C6a D6a S7a S8a',
  );
  const out = follow('SKa S3a HAa CAa DAa', {
    trick: [{ seat: 2, cardIds: ['S6a'] }, { seat: 3, cardIds: ['S9a'] }],
    mySeat: 0, trickNo: 12, playedIds: played,
  });
  assert.deepEqual(out, ['SKa'], '对家只是探路，我接管才能继续抽主兑现三门绝张');
});

test('H5 对手出主对子抽主，我缺主 → 垫最短副门（不是分）', () => {
  const out = follow('HKa H3a H4a C2a D2a D3a D4a', {
    trick: [{ seat: 3, cardIds: ['SAa', 'SAb'] }], mySeat: 0, trickNo: 8,
    voidGroups: [['T'], [], [], []],
  });
  assert.equal(out.length, 2, '对子要跟两张');
  assert.ok(!out.includes('HKa'), '对手抽主的圈一分不给');
  assert.ok(out.includes('C2a'), '先垫最短的 ♣（只有 1 张）');
});

/* ========================================================== 9.I 记牌与推断 */

test('I1 ♥ 场外只剩 2 张且都比我的 Q 小 → Q 是绝张', () => {
  const played = allPlayedExcept('HQa H3a H4a S2a C2a D2a');
  const view = V({ playedIds: played, trickNo: 18 });
  const v = brainFromSuggestView(view, h('HQa S2a C2a D2a'));
  assert.deepEqual(ids(v.groups.H.unseen), ['H3a', 'H4a'], '记牌器要数得出 ♥ 场外只剩这两张');
  assert.ok(v.groups.H.sureMax(parseShape(h('HQa'), CTX_S5)!.units[0]), '记牌器自己也判得出绝张');
  assert.ok(isSureMax(
    parseShape(h('HQa'), CTX_S5)!.units[0], 'H', v.groups.H.unseen, CTX_S5,
  ), '比它大的全走完了 → ♥Q 就是绝张');
});

test('I2 对手甩过 ♣ 三个单位 → 该门对手长且大，我方不在 ♣ 送分', () => {
  const played = allPlayedExcept('CKa C3a HAa H3a D2a D3a CAa CAb CQa C4a C6a S2a S3a');
  const base = {
    playedIds: played, trickNo: 16,
    lastTrick: { leaderSeat: 1, plays: [{ seat: 1, cardIds: ['CAa', 'CAb', 'CQa'] }] },
  };
  const scored = rankLeads(V(base), h('CKa C3a HAa H3a D2a'));
  assert.notEqual(scored[0].cards[0].id, 'CKa', '对手在 ♣ 上甩得动 → 那门的 K 出去就是白送 10 分');
});

test('I3 对家亮过 ♦ 后被反掉 → 对家 ♦ 长，探路/回牌优先 ♦', () => {
  const scored = rankLeads(
    V({ trickNo: 4, declaredIds: [[], [], ['D7a'], []] }),
    h('SAa H3a H4a C3a C4a D3a D4a'),
  );
  const d = scored.findIndex((sc) => sc.cards[0].suit === 'D');
  const c = scored.findIndex((sc) => sc.cards[0].suit === 'C');
  assert.ok(d >= 0 && d < c, '对家亮过 ♦ → 他那门长，回 ♦ 让他做主');
});

test('I4 对手垫过 ♣ → 记缺门；此后 ♣ 首出对该对手 pTrump 用 P(缺)=1', () => {
  const view = V({ trickNo: 10, voidGroups: [[], ['C'], [], []] });
  const v = brainFromSuggestView(view, h('CKa C3a S3a H3a D3a'));
  assert.equal(v.isVoid(1, 'C'), true, '垫过的门就是缺门，记牌器要记住');
  assert.equal(v.estHolding(1, 'C'), 0, '缺门的人手里一张 ♣ 都没有');
  const leadC = parseShape(h('CKa'), CTX_S5)!;
  assert.ok(pTrump(v, 1, leadC) > pTrump(v, 2, leadC), '他缺 ♣ → 他毙的概率必须高过没缺门的对家');
});

test('I5 最后一圈 → bottomPointsExpected = 场外剩余分（精确）', () => {
  const played = allPlayedExcept('SAa SKa CKa CTa H3a H4a D3a D4a S3a S4a C3a D2a');
  const v = brainFromSuggestView(V({ playedIds: played, trickNo: 25 }), h('SAa SKa CKa CTa'));
  assert.equal(v.bottomPointsExact, null, '我不是扣底的人，看不到底');
  assert.equal(v.bottomPointsExpected, v.unseenPoints, '场外只剩底 → 期望值就是精确值');
});

/* ========================================================== 9.J 分数与门槛 */

/** 某个局面的边际价值 m（EV 的最后一个乘数） */
function mOf(o: Partial<SjSuggestView>, hand: string): number {
  return rankLeads(V(o), h(hand))[0].parts.m;
}

/**
 * 9.J 用的公共局面：场外一张分牌都不剩，于是 `projectedScore` 就等于 `defenderPoints`，
 * 门槛距离能被测试精确控制（否则场外那 60 分的期望会把 s 推出去二三十分）。
 */
const J_HAND = 'SAa S3a HAa H3a C3a D3a';
const J_PLAYED = allPlayedExcept(
  'SAa S3a HAa H3a C3a D3a H4a H6a H7a H8a C4a C6a C7a C8a D4a D6a D7a D8a S6a S7a',
);

test('J1 闲家 75 分、中盘、桌上 5 分 → 边际价值高，值得用主截', () => {
  const near = mOf({ playedIds: J_PLAYED, defenderPoints: 75, trickNo: 14 }, J_HAND);
  const far = mOf({ playedIds: J_PLAYED, defenderPoints: 60, trickNo: 14 }, J_HAND);
  assert.ok(near > far, '闲家踩在 80 线上 → 每一分的边际价值都比远离门槛时高');
  assert.ok(near > 2, '这种局面的 m 必须显著大于 1，才会推着机器人去截');
});

test('J2 闲家 100 分、剩 2 圈、底 0 分 → 门槛已过，不冒险动 closer', () => {
  const played = allPlayedExcept(
    'SAa SAb C2a C3a S2a S3a H3a H4a D3a D4a C4a C6a H6a H7a C7a C8a D6a D7a S6a S7a',
  );
  const view = V({
    playedIds: played, defenderPoints: 100, trickNo: 24, mySeat: 0, dealerSeat: 1, kouSeat: 1,
  });
  const scored = rankLeads(view, h('SAa SAb C2a C3a'));
  assert.ok(
    scored[0].parts.m < 1.3,
    '80 已经过了、120 还差 20 分 → 边际价值必须掉下来，机器人才不会继续搏命',
  );
  assert.equal(
    scored.find((sc) => sc.cards.some((c) => c.id === 'SAa'))!.parts.digPlan + 0, 0,
    '底 0 分 → 抠底一分不进，closer 的价值只剩"别乱动"，不该再给它加码',
  );
  assert.ok(!scored[0].cards.some((c) => c.id === 'SAa'), '门槛已经过了，没必要拿最后一圈冒险');
});

test('J3 庄家方、闲家 35 分、剩 3 圈 → 守 40（小光），带分候选 giftRisk 全额', () => {
  const played = allPlayedExcept('HKa H3a C2a D2a HAa H4a H6a C3a C4a D3a D4a S2a S3a');
  const scored = rankF('HKa H3a C2a D2a', {
    trick: [{ seat: 1, cardIds: ['HAa'] }, { seat: 2, cardIds: ['H4a'] }, { seat: 3, cardIds: ['H6a'] }],
    mySeat: 0, trickNo: 23, dealerSeat: 0, kouSeat: 0, defenderPoints: 35, playedIds: played,
  });
  const give = scored.find((sc) => sc.cards[0].id === 'HKa')!;
  assert.ok(give.parts.giftRisk > 0, '对手在赢的圈里垫 K = 直接把闲家推过 40');
  assert.deepEqual(ids(scored[0].cards), ['H3a'], '守小光：这 10 分死也不能给');
});

test('J4 闲家方 s=0、剩 1 圈、底 15 分、对子抠底可到 60 → 拼抠底', () => {
  const played = allPlayedExcept('SAa SAb H3a H4a C3a C4a D3a D4a HKa HTa CKa CTa DKa DTa S2a S3a S4a S6a D6a D7a');
  const scored = rankLeads(
    V({ playedIds: played, defenderPoints: 0, trickNo: 25, mySeat: 0, dealerSeat: 1, kouSeat: 1 }),
    h('SAa SAb'),
  );
  assert.equal(scored[0].cards.length, 2, '最后一圈用主对抠底，×4');
  assert.equal(scored[0].parts.digMult, 4, '一对 → 2^(1+1) = ×4');
  assert.ok(scored[0].parts.digPlan > 0, 'closer 兑现，这一手就是它存在的意义');
});

test('J5 闲家方 s=85 → 目标 120；s=115 时下一档只差 5 分，更值得拼', () => {
  const at85 = mOf({ playedIds: J_PLAYED, defenderPoints: 85, trickNo: 14, dealerSeat: 1 }, J_HAND);
  const at115 = mOf({ playedIds: J_PLAYED, defenderPoints: 115, trickNo: 14, dealerSeat: 1 }, J_HAND);
  assert.ok(at85 > 1.5, 's=85 仍在 80 这道门槛边上（掉回去就白打），不能当成平局面');
  assert.ok(at115 > at85, '离 120 只有 5 分 → 没拿到的门槛比已经过掉的更值得拼');
});

test('J6 庄家方 s=0、中盘 → 空分局，带分的圈都要争', () => {
  const blank = mOf({ playedIds: J_PLAYED, defenderPoints: 0, trickNo: 14, dealerSeat: 0 }, J_HAND);
  const mid = mOf({ playedIds: J_PLAYED, defenderPoints: 60, trickNo: 14, dealerSeat: 0 }, J_HAND);
  assert.ok(blank > 1, '0 分线本身就是门槛（大光 +3 级），不是"随便打"');
  assert.ok(blank !== mid, '门槛距离不同，m 必须跟着变，不能是常数');
});

test('J7 庄家方 s=90 → 守 120：留主保底，别让抠底把 s 推过去', () => {
  const played = allPlayedExcept(
    'SAa SAb C2a C3a S2a S3a H3a H4a D3a D4a C4a C6a HTa HKa CKa CTa DKa DTa S6a S7a',
  );
  const scored = rankLeads(
    V({ playedIds: played, defenderPoints: 90, trickNo: 24, mySeat: 0, dealerSeat: 0, kouSeat: 0 }),
    h('SAa SAb C2a C3a'),
  );
  const closerPlay = scored.find((sc) => sc.cards.some((c) => c.id === 'SAa'))!;
  assert.ok(closerPlay.parts.digPlan < 0, '主对是最后一圈的保险，现在花掉等于把底送给闲家');
  assert.ok(!scored[0].cards.some((c) => c.id === 'SAa'), '守 120：主留着');
});

/* ========================================================== 9.K 甩牌与惩罚 */

test('K1 对 A + 单 K、场外这门全走完 → 甩', () => {
  const out = lead('HAa HAb HKa C2a D2a', {
    playedIds: allPlayedExcept('HAa HAb HKa C2a D2a S2a S3a S4a C3a D3a H3a H4a H6a H7a'),
    trickNo: 14,
  });
  assert.equal(out.length, 3, '每个单位都是绝张 → 一次甩掉，30 分落袋');
});

test('K2 对 K + 单 K 但场外有 A → 不甩（−10 且被迫出小）', () => {
  const scored = rankLeads(
    V({
      playedIds: allPlayedExcept('HKa HKb HQa C2a D2a HAa H3a H4a S2a S3a S4a C3a D3a'),
      trickNo: 14,
    }),
    h('HKa HKb HQa C2a D2a'),
  );
  const throwPlay = scored.find((sc) => sc.cards.length === 3);
  if (throwPlay) {
    assert.ok(throwPlay.parts.throwRisk > 0, '♥A 还在场外 → 甩的风险必须记在账上');
    assert.ok(throwPlay.ev < scored[0].ev, '风险摊完之后甩牌不该排第一');
  }
  assert.ok(scored[0].cards.length < 3, '不甩');
});

test('K3 三家公开缺 ♣ → ♣ 里任何组合都可甩（被毙也只是被毙一次）', () => {
  const scored = rankLeads(
    V({
      playedIds: allPlayedExcept('CKa CKb CQa C2a D2a CAa CAb C3a C4a S2a S3a H3a H4a'),
      trickNo: 14, voidGroups: [[], ['C'], ['C'], ['C']],
    }),
    h('CKa CKb CQa C2a D2a'),
  );
  const throwPlay = scored.find((sc) => sc.cards.length >= 3 && sc.cards.every((c) => c.suit === 'C'));
  assert.ok(throwPlay, '三家都缺 ♣ → 甩牌候选必须生成得出来');
  assert.equal(throwPlay!.parts.throwRisk, 0, '没人跟得出 ♣，甩不可能失败');
});

test('K4 最后一圈可证明的拖拉机 + 单张甩牌 → 甩（倍数按最长拖拉机）', () => {
  const played = allPlayedExcept(
    'SAa SAb SKa SKb SQa H3a H4a C3a C4a D3a D4a HKa HTa CKa CTa DKa DTa H6a C6a D6a',
  );
  const scored = rankLeads(
    V({ playedIds: played, trickNo: 25, mySeat: 0, dealerSeat: 1, kouSeat: 1 }),
    h('SAa SAb SKa SKb SQa'),
  );
  assert.equal(scored[0].cards.length, 5, '主全是绝张 → 五张一起甩');
  assert.equal(scored[0].parts.digMult, 8, '倍数只按最长拖拉机（两连对）算 → ×8，不是 ×32');
});

/* ================================================================ 9.L 尾局 */

test('L1 剩 2 圈、我方要拿最后一圈首出 → 倒数第二圈用次大牌拿首出', () => {
  // 手上只剩 2 张 = 真的只剩两圈；`tricksLeft` 是按每圈 1 张的节奏推出来的
  const played = allPlayedExcept('SAa HKa H3a H4a H6a HTa C3a C4a C6a CTa D3a D4a D6a DKa S2a S3a');
  const scored = rankLeads(
    V({ playedIds: played, trickNo: 24, mySeat: 0, dealerSeat: 1, kouSeat: 1 }),
    h('SAa HKa'),
  );
  assert.ok(
    scored[0].why.some((w) => w.includes('首出权')),
    '尾局的算盘：先赢下这一圈，最后一圈的首出权才在我方手上',
  );
  assert.ok(!scored[0].cards.some((c) => c.id === 'SAa'), '主牌绝张是 closer，倒数第二圈不能动');
});

test('L4 对手已缺主、我方任何主都是 closer → 最后一圈出最多对的主牌型', () => {
  const played = allPlayedExcept(
    'S3a S3b S4a S4b H3a H4a C3a C4a D3a D4a HKa HTa CKa CTa DKa DTa H6a C6a D6a S6a',
  );
  const scored = rankLeads(
    V({
      playedIds: played, trickNo: 25, mySeat: 0, dealerSeat: 1, kouSeat: 1,
      voidGroups: [[], ['T'], [], ['T']],
    }),
    h('S3a S3b S4a S4b'),
  );
  assert.equal(scored[0].cards.length, 4, '对手毙不动 → 四张连对一起出');
  assert.equal(scored[0].parts.digMult, 8, '两连对 ×8，抠底本钱一次用足');
});

test('L2 剩 2 圈、对家持 closer → 出对家能赢的牌，把首出权让给他', () => {
  // 两个对手公开缺主 → 场外的顶张主只能在对家手里；我这门又不是绝张 → 他接得走
  const played = allPlayedExcept('HKa H3a HAa HQa HTa H4a S2a S3a SAa C3a C4a CTa D3a D4a DKa D6a');
  const scored = rankLeads(
    V({
      playedIds: played, trickNo: 24, mySeat: 0, dealerSeat: 2, kouSeat: 2,
      declaredIds: [[], [], ['SAa'], []], voidGroups: [[], ['H', 'T'], [], ['H', 'T']],
    }),
    h('HKa H3a'),
  );
  assert.ok(
    scored[0].why.some((w) => w.includes('让给持 closer 的对家')),
    '对家手里握着抠底的本钱，最后一圈该由他首出',
  );
});

test('L3 剩 2 圈、庄家方、对手持 closer → 出主逼他先用掉', () => {
  const played = allPlayedExcept('SKa H3a SAa S2a S3a HAa HQa HTa H4a C3a C4a CTa D3a D4a DKa D6a');
  const scored = rankLeads(
    V({
      playedIds: played, trickNo: 24, mySeat: 0, dealerSeat: 0, kouSeat: 0,
      declaredIds: [[], ['SAa'], [], []], voidGroups: [[], [], ['T'], ['T']],
    }),
    h('SKa H3a'),
  );
  const trumpLead = scored.find((sc) => sc.cards[0].id === 'SKa')!;
  assert.ok(
    trumpLead.why.some((w) => w.includes('逼对手提前花掉')),
    '现在不逼，他的绝张主就留到最后一圈把底翻倍',
  );
});

/* ============================================ 9.M 补充场景（真人常识补完） */

test('M1 同牌先出者大 → 我出 A、场外另一张 A 也盖不过我', () => {
  const v = brainFromSuggestView(
    V({ playedIds: allPlayedExcept('HAa H3a HAb HKa C3a D3a S3a S4a') }),
    h('HAa H3a'),
  );
  const unit = parseShape(h('HAa'), CTX_S5)!.units[0];
  assert.ok(v.groups.H.sureMax(unit), '♥A 还有一张在场外，但相等不算大 —— 我先出就赢');
  const kingUnit = parseShape(h('HKa'), CTX_S5)!.units[0];
  assert.equal(v.groups.H.sureMax(kingUnit), false, '♥K 上面压着 A，当然不是绝张');
});

test('M2 已知某家这门无对 → 我方对子在他面前就是绝张', () => {
  const view = V({
    playedIds: allPlayedExcept('HKa HKb H3a HAa HAb HQa C3a C4a D3a D4a S3a S4a'),
    noPairs: [[], ['H'], [], []],
  });
  const v = brainFromSuggestView(view, h('HKa HKb H3a'));
  const pair = parseShape(h('HKa HKb'), CTX_S5)!;
  assert.equal(pBeat(v, 1, pair, pair.units[0].top), 0, '他这门已经拆光了，再大的单张也盖不过对子');
  assert.ok(pBeat(v, 3, pair, pair.units[0].top) > 0, '没暴露过结构的对手仍然可能有 ♥AA');
});

test('M3 拖拉机首出几乎不可能被同门盖过（只怕主）', () => {
  const view = V({ playedIds: allPlayedExcept('HKa HKb HQa HQb HAa HAb HJa HJb C3a D3a S3a S4a') });
  const v = brainFromSuggestView(view, h('HKa HKb HQa HQb'));
  const tractor = parseShape(h('HKa HKb HQa HQb'), CTX_S5)!;
  const single = parseShape(h('HQa'), CTX_S5)!;
  assert.ok(
    pBeat(v, 1, tractor, tractor.units[0].top) < pBeat(v, 1, single, single.units[0].top),
    '场外要凑齐 AA+JJ 才盖得过 KK+QQ，比单张难得多',
  );
});

test('M4 主抽干、对手全缺这门 → 我这门每张都是赢牌，逐张出让对家垫分', () => {
  // 场外一张主都没有（主全部打完），两个对手又公开缺 ♥
  const played = allPlayedExcept('HKa HQa HJa HAa HTa H9a C3a C4a D3a D4a');
  const view = V({ playedIds: played, trickNo: 20, voidGroups: [[], ['H'], [], ['H']] });
  const scored = rankLeads(view, h('HKa HQa HJa'));
  assert.equal(scored[0].parts.secureWin, 1, '毙不动、也压不过 —— 这一圈铁定是我的');
  assert.ok(scored[0].parts.trickPts > 10, '我方稳赢且对家未出 → 账里要算上他会垫过来的分');
});

test('M5 对手跟过单张暴露"这门无对" → 我方带分的对子可以放心出', () => {
  const played = allPlayedExcept('HKa HKb H3a H4a HAa HAb HQa HJa C3a C4a D3a D4a S3a S4a');
  const scored = rankLeads(
    V({ playedIds: played, noPairs: [[], ['H'], [], ['H']], trickNo: 12 }),
    h('HKa HKb H3a H4a'),
  );
  assert.deepEqual(ids(scored[0].cards), ['HKa', 'HKb'], '两个对手都没 ♥ 对子 → 20 分的对 K 是绝张');
});

test('M6 庄家对家、主够长 → 主动抽主替庄家护底', () => {
  const played = allPlayedExcept(
    'SAa SKa SQa SJa STa S9a S8a S7a HAa CAa DAa H3a C3a D3a H4a C4a D4a S6a S4a S3a',
  );
  // 我坐 2，庄家坐 0 → 我是庄家的对家；三门副牌各有一张绝张等着兑现
  const v = brainFromSuggestView(
    V({ playedIds: played, mySeat: 2, dealerSeat: 0, kouSeat: 0, trickNo: 6 }),
    h('SAa SKa SQa SJa STa S9a S8a S7a HAa CAa DAa'),
  );
  assert.ok(drawTrumpValue(v) > 0, '手里 8 张主 + 三门绝张 → 抽主就是把绝张兑现的前置条件');
});

test('M7 闲家一般不抽主（抽主等于替庄家抽干自己人）', () => {
  const base = 'HAa CAa DAa H3a C3a D3a H4a C4a D4a S6a S4a S3a';
  const short = 'SAa SKa SQa SJa STa S9a S8a S7a';
  const long = short + ' S6a S4a S3a S2a';
  const vShort = brainFromSuggestView(
    V({ playedIds: allPlayedExcept(`${short} ${base}`), mySeat: 0, dealerSeat: 1, kouSeat: 1, trickNo: 6 }),
    h(`${short} HAa CAa DAa`),
  );
  assert.equal(drawTrumpValue(vShort), 0, '闲家手里 8 张主还不够 —— 抽主先抽干的是对家');
  const vLong = brainFromSuggestView(
    V({ playedIds: allPlayedExcept(`${long} ${base}`), mySeat: 0, dealerSeat: 1, kouSeat: 1, trickNo: 6 }),
    h(`${long} HAa CAa DAa`),
  );
  assert.ok(drawTrumpValue(vLong) > 0, '主到了 12 张，多到可以自己抽干 —— 这才轮到闲家抽主');
});

test('M8 闲家低分时罚分能把 s 打到负 → 存疑甩牌的风险加倍', () => {
  const spec = {
    playedIds: allPlayedExcept('HKa HKb HQa C2a D2a HAa H3a H4a S2a S3a S4a C3a D3a'),
    trickNo: 14, dealerSeat: 1, kouSeat: 1,
  };
  const risky = (defenderPoints: number) => {
    const scored = rankLeads(V({ ...spec, defenderPoints }), h('HKa HKb HQa C2a D2a'));
    return scored.find((sc) => sc.cards.length === 3)!.parts.throwRisk;
  };
  assert.ok(risky(5) > risky(60) * 1.9, 's=5 时甩失败会倒扣成负分，风险必须记双份');
});

test('M9 对家稳赢时先垫 10/K、留 5；被迫送分时先送 5', () => {
  const played = allPlayedExcept('CKa C5a C3a HAa HAb H3a H4a HKa HQa D3a D4a S3a S4a');
  // 对家（座 2）用 ♥AA 稳稳赢下这一圈，我 ♥ 已缺 → 垫哪张分牌由我挑
  const give = rankF('CKa C5a C3a', {
    trick: [{ seat: 2, cardIds: ['HAa', 'HAb'] }, { seat: 3, cardIds: ['HKa', 'HQa'] }],
    mySeat: 0, trickNo: 12, playedIds: played, voidGroups: [['H'], [], [], []],
  });
  assert.ok(give[0].cards.some((c) => c.id === 'CKa'), '对家收得住 → 把最贵的 10 分喂过去');

  // 反过来：对手（座 1）赢定了，我被迫垫分 → 只肯给最便宜的 5
  const forced = rankF('CKa C5a', {
    trick: [{ seat: 1, cardIds: ['HAa', 'HAb'] }, { seat: 2, cardIds: ['H3a', 'H4a'] }],
    mySeat: 3, trickNo: 12, playedIds: played, voidGroups: [[], [], [], ['H']],
  });
  assert.ok(forced[0].cards.some((c) => c.id === 'C5a'), '输定的圈，5 分是最便宜的赎金');
});

test('M10 跟单张时不拆对子', () => {
  const out = follow('H3a H4a H4b', {
    trick: [{ seat: 1, cardIds: ['HKa'] }],
    mySeat: 2, trickNo: 8, playedIds: allPlayedExcept('H3a H4a H4b HKa HAa HAb C3a D3a S3a S4a'),
  });
  assert.deepEqual(out, ['H3a'], '拆对子要付 structureBreak 的代价，单张够用就别动它');
});

test('M11 对手甩牌被管之后 → 按"被迫出的最小牌"这个新首出跟，输出仍然合法', () => {
  const view = V({
    // 甩 ♥ 被我方管掉，服务端裁定他只能出最小的 H3a —— 这一圈的首出就是这张
    trick: [{ seat: 1, cardIds: ['H3a'] }],
    mySeat: 2, trickNo: 9,
    playedIds: allPlayedExcept('H3a HKa HQa HAa HAb H4a C3a C4a D3a D4a S3a S4a'),
  });
  const hand = h('HKa HQa C3a');
  const lead = parseShape(h('H3a'), CTX_S5)!;
  const out = botFollow(view, hand, lead);
  assert.equal(validateFollow(hand, lead, out, CTX_S5).ok, true, '被迫改小之后的跟牌照样要合法');
  assert.ok(out.every((c) => c.suit === 'H'), '我还有 ♥，必须跟 ♥');
});

test('M12 我在庄家上家（对手末家出）→ 带分出去的风险按 1.5 倍算', () => {
  const played = allPlayedExcept('CKa C3a HAa H3a H4a H6a HKa HQa D3a D4a S3a S4a');
  const at = (trick: { seat: number; cardIds: string[] }[]) =>
    rankF('CKa C3a', {
      trick, mySeat: 0, trickNo: 12, playedIds: played, dealerSeat: 1, kouSeat: 1,
      voidGroups: [['H'], [], [], []],
    }).find((sc) => sc.cards[0].id === 'CKa')!.parts;
  // 对家坐 2 先出、对手 3 跟过，我坐 0 第三家 → 我后面还剩对手 1，10 分很可能被他截走
  const foeLast = at([{ seat: 2, cardIds: ['H3a'] }, { seat: 3, cardIds: ['H4a'] }]);
  // 对手坐 3 先出，我坐 0 第二家 → 我后面是对手 1 和对家 2，末家是自己人
  const mateLast = at([{ seat: 3, cardIds: ['H3a'] }]);
  const raw = (p: Record<string, number>) => 10 * (1 - p.pTeamWin);
  assert.ok(Math.abs(foeLast.giftRisk - raw(foeLast) * 1.5) < 1e-6, '还有对手在我后面 → 送分的账 ×1.5');
  assert.ok(Math.abs(mateLast.giftRisk - raw(mateLast)) < 1e-6, '我是末家 → 原价，不加权');
});

test('M13 对家已缺主 → 我方再没有毙的能力，别指望他救', () => {
  const view = V({
    playedIds: allPlayedExcept('CKa C3a HAa H3a H4a HKa C4a D3a D4a S3a S4a'),
    voidGroups: [[], [], ['T'], []], trickNo: 12,
  });
  const v = brainFromSuggestView(view, h('CKa C3a'));
  const lead = parseShape(h('HAa'), CTX_S5)!;
  assert.equal(pTrump(v, v.partner, lead), 0, '对家没主了，这一圈他毙不了');
  assert.ok(pTrump(v, v.opps[0], lead) > 0, '对手还有主 —— 风险全在他们那边');
});

test('M14 对手已缺主 → 我随便一张主都锁得住最后一圈', () => {
  const played = allPlayedExcept('S3a S4a HKa HTa C3a C4a D3a D4a H3a H4a');
  const v = brainFromSuggestView(
    V({ playedIds: played, trickNo: 24, voidGroups: [[], ['T'], [], ['T']], mySeat: 0, dealerSeat: 1, kouSeat: 1 }),
    h('S3a S4a'),
  );
  const scored = rankLeads(
    V({ playedIds: played, trickNo: 24, voidGroups: [[], ['T'], [], ['T']], mySeat: 0, dealerSeat: 1, kouSeat: 1 }),
    h('S3a S4a'),
  );
  assert.ok(findCloser(v), '对手毙不动 → 手里最小的主也是 closer');
  assert.equal(scored[0].parts.secureWin, 1, '没人管得上，出什么都赢');
});

test('M15 主级牌/王都走完 → 副级牌就是主里的绝张', () => {
  const played = allPlayedExcept('H5a S3a S4a C3a D3a HKa CKa D5a C5a');
  const v = brainFromSuggestView(V({ playedIds: played }), h('H5a S3a'));
  const unit = parseShape(h('H5a'), CTX_S5)!.units[0];
  assert.ok(v.groups.T.sureMax(unit), '主级牌和王都出完了，三色副级牌里先出者最大');
});

test('M16 场外一分不剩、底也没分 → 主牌不再需要留着，随便打', () => {
  const played = allPlayedExcept('SAa SKa H3a H4a C3a C4a D3a D4a S3a S4a');
  const v = brainFromSuggestView(
    V({ playedIds: played, trickNo: 22, mySeat: 0, dealerSeat: 1, kouSeat: 1 }),
    h('SAa SKa'),
  );
  assert.equal(v.unseenPoints, 0, '分已经全部落定');
  assert.equal(digValue(v, findCloser(v)), 0, '底里也没分 → 抠底一分不进，closer 不值钱了');
});

test('M17 想的时间恒小于 turnSeconds 的一半，rng 怎么抖都不会超时', () => {
  const { room, o } = dealt();
  runToPlaying(room, o);
  const me = room.players.find((p) => p.seat === room.turnSeat)!;
  const cap = room.settings.turnSeconds * 1000 / 2;
  let max = 0;
  const rng = mulberry32(7);
  for (let i = 0; i < 300; i++) max = Math.max(max, botThinkMs(room, me, rng));
  assert.ok(max < cap, `延时上限 ${max}ms 必须小于 ${cap}ms`);
  assert.ok(max < 3000, 'p99 也得远在 3 秒以内');
  assert.equal(botThinkMs(room, me, () => 0) >= 500, true, '最短也要像在想');
});

/* ================================================ 防偷看 / 确定性 / 合法性 */

/** 把 `seats` 三家的手牌重洗一遍（牌不变，只换谁拿到哪张）——机器人不该看得见差别 */
function reshuffleOthers(room: SjRoomState, meSeat: number, seed: number): void {
  const others = room.players.filter((p) => p.seat !== meSeat);
  const pool = others.flatMap((p) => p.hand.slice());
  const rng = mulberry32(seed);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  let k = 0;
  for (const p of others) p.hand = pool.slice(k, k += p.hand.length);
}

test('防偷看 · 出牌：把其余三家的手牌重洗，botPlay 逐字节不变', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const { room, o } = dealt(seed);
    runToPlaying(room, o);
    const me = room.players.find((p) => p.seat === room.turnSeat)!;
    const before = botPlay(room, me, mulberry32(seed));
    reshuffleOthers(room, me.seat, seed * 977);
    assert.deepEqual(botPlay(room, me, mulberry32(seed)), before, `种子 ${seed}：出牌偷看了别人的牌`);
  }
});

test('防偷看 · 亮主：重洗未发出的牌，发牌途中的亮主计划不变', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const { room } = dealt(seed);
    room.phase = 'dealing';
    for (const p of room.players) {
      const before = planSjDealingDeclare(room, p);
      // 只重洗"还没到手"的部分：前缀不动，决策就必须不动
      const order = room.dealOrder[p.seat];
      const cut = Math.floor(order.length / 2);
      const tail = order.slice(cut);
      const rng = mulberry32(seed * 31 + p.seat);
      for (let i = tail.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [tail[i], tail[j]] = [tail[j], tail[i]];
      }
      room.dealOrder[p.seat] = [...order.slice(0, cut), ...tail];
      const after = planSjDealingDeclare(room, p);
      if (before && before.index < cut) {
        assert.deepEqual(after, before, `种子 ${seed} 座 ${p.seat}：亮主看到了还没发的牌`);
      }
    }
  }
});

test('防偷看 · 扣底：重洗其余三家的手牌，botKou 不变', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const { room, o } = dealt(seed);
    runDeclaring(room, o);
    if (room.phase !== 'kou' || room.kouSeat == null) continue;
    const me = room.players.find((p) => p.seat === room.kouSeat)!;
    const before = botKou(room, me);
    reshuffleOthers(room, me.seat, seed * 613);
    assert.deepEqual(botKou(room, me), before, `种子 ${seed}：扣底偷看了别人的牌`);
  }
});

test('防偷看 · 抄底：重洗其余三家的手牌，botChao 不变', () => {
  let checked = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const { room, o } = dealt(seed);
    runDeclaring(room, o);
    let guard = 0;
    while (room.phase === 'kou' && guard++ < 5) timeoutKou(room, o);
    if (room.phase !== 'chao' || room.chaoSeat == null) continue;
    const me = room.players.find((p) => p.seat === room.chaoSeat)!;
    const before = botChao(room, me);
    reshuffleOthers(room, me.seat, seed * 409);
    assert.deepEqual(botChao(room, me), before, `种子 ${seed}：抄底偷看了别人的牌`);
    checked++;
  }
  assert.ok(checked > 0, '这一批种子里至少要走到一次抄底询问，否则这条测试是空的');
});

test('防偷看 · 底牌只有扣底的人读得到', () => {
  const { room, o } = dealt(3);
  runToPlaying(room, o);
  const kou = room.kouSeat!;
  for (const p of room.players) {
    const v = brainFromState(room, p);
    if (p.seat === kou) assert.notEqual(v.bottomPointsExact, null, '扣底的人当然知道自己埋了什么');
    else assert.equal(v.bottomPointsExact, null, `座 ${p.seat} 不该看得见底`);
  }
});

test('帮我扣 · 公开视图与完整 state 给出同一份扣底，且别人手牌为空也不抛错', () => {
  // 客户端的「帮我扣」现在直接把 `SjPublicRoom` 递给大脑（`client/sj/KouDi.tsx`）。
  // 它必须和服务端代扣走同一条路 —— 否则 B6「扣光上一个亮主者那门」和
  // C6「闲家抄成底埋 K/10」对真人就是死的。
  let checked = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const { room, o } = dealt(seed);
    runDeclaring(room, o);
    if (room.phase !== 'kou') continue;                // 无人亮主的局直接跳过
    const kou = room.players[room.kouSeat];
    assert.equal(kou.hand.length, 33, '扣底者手里是 25 + 8 = 33 张');

    const view = sanitizeSjRoom(room, kou.id);
    const meInView = view.players.find((p) => p.id === kou.id)!;
    assert.equal(meInView.hand.length, 33, '公开视图里我自己的 33 张都在');
    assert.deepEqual(
      view.players.filter((p) => p.id !== kou.id).map((p) => p.hand.length),
      [0, 0, 0],
      '别人的手牌在公开视图里是空数组 —— 大脑本来就不该读它',
    );

    // 记牌器两边算出来必须完全一致（这才是"客户端算得准"的真正含义）
    const a = brainFromState(room, kou);
    const b = brainFromState(view, meInView);
    for (const k of [
      'me', 'partner', 'dealerSeat', 'teamKnown', 'iAmDealerTeam', 'iAmKou', 'matchPoint',
      'handSize', 'trickNo', 'tricksLeft', 'endgame', 'defenderPoints', 'pointsOnTable',
      'unseenPoints', 'bottomPointsExact', 'bottomPointsExpected',
    ] as const) {
      assert.deepEqual(b[k], a[k], `种子 ${seed}：记牌器字段 ${k} 两边对不上`);
    }
    for (const g of ['T', 'S', 'H', 'C', 'D'] as const) {
      assert.equal(b.groups[g].unseenCount, a.groups[g].unseenCount, `种子 ${seed}：${g} 门场外张数对不上`);
      assert.equal(b.groups[g].unseenPoints, a.groups[g].unseenPoints, `种子 ${seed}：${g} 门场外分数对不上`);
    }
    assert.deepEqual(b.declaredSuits, a.declaredSuits, '谁亮过哪门是公开信息');

    const full = botKou(room, kou, mulberry32(seed));
    let pub: string[] = [];
    assert.doesNotThrow(() => { pub = botKou(view, meInView, mulberry32(seed)); }, '公开视图不能把大脑喂崩');
    assert.deepEqual(pub, full, `种子 ${seed}：「帮我扣」和电脑代扣必须给同一份答案`);
    assert.equal(pub.length, 8);
    checked++;
  }
  assert.ok(checked >= 6, `只验到 ${checked} 个局面，样本太少`);
});

test('确定性：同一个种子、同一个局面，四类决策每次都给同一个答案', () => {
  for (let seed = 1; seed <= 8; seed++) {
    const { room, o } = dealt(seed);
    runToPlaying(room, o);
    const me = room.players.find((p) => p.seat === room.turnSeat)!;
    const first = botPlay(room, me, mulberry32(seed));
    for (let i = 0; i < 5; i++) {
      assert.deepEqual(botPlay(room, me, mulberry32(seed)), first, '同种子必须复现');
    }
    assert.equal(botThinkMs(room, me, mulberry32(seed)), botThinkMs(room, me, mulberry32(seed)));
  }
});

test('合法性兜底：整局机器人对打，每一手都过 validateFollow', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const { room, o } = dealt(seed);
    runToPlaying(room, o);
    const ctx = sjCtx(room);
    let guard = 0;
    while (room.phase === 'playing') {
      if (guard++ > 400) throw new Error('出牌没有收敛');
      const me = room.players.find((p) => p.seat === room.turnSeat)!;
      const before = me.hand.slice();
      const out = botPlay(room, me).map(cardFromId);
      assert.ok(out.length > 0, '任何时候都得出得起牌');
      assert.ok(
        out.every((c) => before.some((x) => x.id === c.id)),
        `种子 ${seed}：机器人打出了手里没有的牌`,
      );
      if (room.trick.length) {
        const lead = parseShape(room.trick[0].cardIds.map(cardFromId), ctx)!;
        assert.equal(
          validateFollow(before, lead, out, ctx).ok, true,
          `种子 ${seed}：跟牌不合法 ${ids(out).join(' ')}`,
        );
      }
      applySjCommand(room, me.id, { type: 'play', cardIds: ids(out) }, o);
    }
  }
});
