import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applySjCommand, closeDeclaring, createSjPlayer, createSjRoom, dealSjHand, deriveSjEvents,
  finishDealing, migrateSjRoom, sanitizeSjRoom, startNextHand, timeoutKou, timeoutTurn,
  type SjRoomState,
} from '../shared/sj/engine.ts';
import { sumPoints } from '../shared/sj/cards.ts';
import { GameError } from '../shared/game.ts';
import { ladderOf } from '../shared/games.ts';
import { h, ids, makeSjRoom, mulberry32, playHand, playOutTricks, runDeclaring } from './sj-helpers.ts';

const opts = (seed = 1) => ({ rng: mulberry32(seed), now: 1_700_000_000_000 });

function started(seed = 1, kind: 'sj_510k' | 'sj_2a' = 'sj_510k') {
  const room = makeSjRoom(kind);
  const o = opts(seed);
  applySjCommand(room, room.hostId, { type: 'start' }, o);
  return { room, o };
}

/** 除了规范要求公开的明牌，别人手里的牌一张都不能出现在视图里 */
function assertNoHandLeak(room: SjRoomState) {
  for (const viewer of room.players) {
    const view = sanitizeSjRoom(room, viewer.id);
    const json = JSON.stringify(view);
    assert.ok(!json.includes('tokenHash'), '视图里不该有登录凭证');
    // 亮主的牌明牌摆在座位前、翻底那张全场看过 —— 这两类是规范要求公开的
    const shownByDesign = new Set<string>([
      ...room.trump.cardIds,
      ...room.players.flatMap((p) => p.declaredIds),
      ...(room.flipped ? [room.flipped.id] : []),
    ]);
    for (const other of room.players) {
      if (other.id === viewer.id) continue;
      const seen = view.players.find((p) => p.id === other.id)!;
      assert.deepEqual(seen.hand, [], `${viewer.name} 不该看到 ${other.name} 的手牌`);
      assert.equal(seen.handCount, other.hand.length, '张数是公开的');
      for (const card of other.hand) {
        if (shownByDesign.has(card.id)) continue;
        assert.ok(!json.includes(`"${card.id}"`), `${other.name} 的 ${card.id} 泄露给了 ${viewer.name}`);
      }
    }
  }
}

/** 把某张牌换到底牌第一张，同时保持全场 108 张不重不漏 —— 翻底定主的用例要用 */
function forceBottomFirst(room: SjRoomState, id: string) {
  const inBottom = room.bottom.findIndex((c) => c.id === id);
  if (inBottom >= 0) {
    [room.bottom[0], room.bottom[inBottom]] = [room.bottom[inBottom], room.bottom[0]];
    return;
  }
  for (const p of room.players) {
    const i = p.hand.findIndex((c) => c.id === id);
    if (i >= 0) {
      [p.hand[i], room.bottom[0]] = [room.bottom[0], p.hand[i]];
      return;
    }
  }
  throw new Error(`牌堆里找不到 ${id}`);
}

/* ------------------------------------------------------------------- 建房 */

test('建房：四座、两队同级、房主坐庄', () => {
  const room = makeSjRoom('sj_510k');
  assert.equal(room.players.length, 4);
  assert.deepEqual(room.players.map((p) => p.seat), [0, 1, 2, 3]);
  assert.deepEqual(room.levels, [5, 5]);
  assert.equal(room.phase, 'lobby');
  assert.equal(room.kind, 'sj_510k');
  assert.equal(makeSjRoom('sj_2a').levels[0], 2, '打通关从 2 起');
});

test('大厅里能换座换队友', () => {
  const room = makeSjRoom();
  const [me, other] = room.players;
  applySjCommand(room, me.id, { type: 'seat', seat: 1 });
  assert.equal(me.seat, 1);
  assert.equal(other.seat, 0, '原来坐那儿的人被换到我的位置');
  assert.throws(() => applySjCommand(room, me.id, { type: 'seat', seat: 9 }), GameError);
});

test('人不满四个开不了局', () => {
  const host = createSjPlayer('甲', '🐯', 0, 't0');
  const room = createSjRoom('sj_510k', '123456', host);
  host.ready = true;
  assert.throws(() => applySjCommand(room, host.id, { type: 'start' }), /四个座位/);
});

/* ------------------------------------------------------------------- 发牌 */

test('发牌：每人 25 张、底牌 8 张、108 张不重不漏', () => {
  const { room } = started();
  assert.equal(room.phase, 'dealing');
  assert.equal(room.trump.level, 5, '首局级牌是庄家队的级别');
  assert.equal(room.bottom.length, 8);
  for (const p of room.players) assert.equal(p.hand.length, 25);
  const all = [...room.players.flatMap((p) => p.hand), ...room.bottom];
  assert.equal(all.length, 108);
  assert.equal(new Set(ids(all)).size, 108);
  assert.equal(sumPoints(all), 200, '全场 200 分');
  assert.ok(room.dealStartedAt, '客户端靠它对齐发牌动画');
});

/* ------------------------------------------------------------------- 亮主 */

test('亮主：单张 → 加固 → 对王反成无主，强度必须严格递增', () => {
  const { room, o } = started();
  const [p0, p1, p2, p3] = room.players;
  p0.hand = h('S5a S5b H5a H5b');
  p1.hand = h('C5a C5b');
  p2.hand = h('JSa JSb');
  p3.hand = h('JBa JBb');

  // 亮主窗口从发牌第一张起就开放，还在 dealing 也能亮
  applySjCommand(room, p0.id, { type: 'declare', cardIds: ['S5a'] }, o);
  assert.equal(room.trump.suit, 'S');
  assert.equal(room.trump.strength, 1);
  assert.equal(room.trump.declarerId, p0.id);
  assert.deepEqual(p0.declaredIds, ['S5a'], '亮出的牌明牌摆在座位前');

  finishDealing(room, o);
  assert.equal(room.phase, 'declaring');

  // 同花色的第二张级牌 = 加固，强度 1 → 2
  applySjCommand(room, p0.id, { type: 'declare', cardIds: ['S5b'] }, o);
  assert.equal(room.trump.strength, 2);
  assert.deepEqual(room.trump.cardIds.slice().sort(), ['S5a', 'S5b']);

  // 别人再想反必须出王
  assert.throws(() => applySjCommand(room, p1.id, { type: 'declare', cardIds: ['C5a', 'C5b'] }, o), /更强/);
  applySjCommand(room, p2.id, { type: 'declare', cardIds: ['JSa', 'JSb'] }, o);
  assert.equal(room.trump.suit, 'NT');
  assert.equal(room.trump.strength, 3);
  assert.deepEqual(p0.declaredIds, [], '被反掉的明牌收回去');

  applySjCommand(room, p3.id, { type: 'declare', cardIds: ['JBa', 'JBb'] }, o);
  assert.equal(room.trump.strength, 4);
  assert.throws(() => applySjCommand(room, p2.id, { type: 'declare', cardIds: ['JSa', 'JSb'] }, o), /更强/);
});

test('不能用别的花色反自己，但可以用对王把自己反成无主', () => {
  const { room, o } = started();
  const [p0] = room.players;
  p0.hand = h('S5a H5a H5b JBa JBb');
  applySjCommand(room, p0.id, { type: 'declare', cardIds: ['S5a'] }, o);
  assert.throws(() => applySjCommand(room, p0.id, { type: 'declare', cardIds: ['H5a', 'H5b'] }, o), /别的花色/);
  applySjCommand(room, p0.id, { type: 'declare', cardIds: ['JBa', 'JBb'] }, o);
  assert.equal(room.trump.suit, 'NT');
});

test('亮主形式非法时报错', () => {
  const { room, o } = started();
  const p0 = room.players[0];
  p0.hand = h('S6a S6b JSa JBa');
  assert.throws(() => applySjCommand(room, p0.id, { type: 'declare', cardIds: ['S6a'] }, o), /亮主只能是/);
  assert.throws(() => applySjCommand(room, p0.id, { type: 'declare', cardIds: ['S6a', 'S6b'] }, o), /亮主只能是/);
  assert.throws(() => applySjCommand(room, p0.id, { type: 'declare', cardIds: ['JSa', 'JBa'] }, o), /亮主只能是/);
  assert.throws(() => applySjCommand(room, p0.id, { type: 'declare', cardIds: ['H5a'] }, o), /不在你手里/);
});

test('四个人都不亮就立刻翻底定主，房主坐庄', () => {
  const { room, o } = started();
  finishDealing(room, o);
  forceBottomFirst(room, 'HAa');
  for (const p of room.players) applySjCommand(room, p.id, { type: 'pass' }, o);
  assert.equal(room.phase, 'kou', '四个人都不亮，窗口立即结束');
  assert.equal(room.trump.suit, 'H');
  assert.equal(room.trump.declarerId, null);
  assert.equal(room.flipped?.id, 'HAa', '翻出来那张全场可见');
  assert.equal(room.dealerSeat, 0, '无人亮主则房主坐庄');
});

test('翻到王就是无主', () => {
  const { room, o } = started();
  finishDealing(room, o);
  forceBottomFirst(room, 'JBa');
  closeDeclaring(room, o);
  assert.equal(room.trump.suit, 'NT');
});

test('首局庄家由亮主决定', () => {
  const { room, o } = started();
  const p2 = room.players[2];
  p2.hand = h('D5a');
  applySjCommand(room, p2.id, { type: 'declare', cardIds: ['D5a'] }, o);
  closeDeclaring(room, o);
  assert.equal(room.dealerSeat, 2);
  assert.equal(room.players[2].hand.length, 9, '庄家拿到 8 张底牌');
});

/* ------------------------------------------------------------------- 扣底 */

test('扣底：只有庄家能扣、必须恰好 8 张，扣完立刻首出', () => {
  const { room, o } = started();
  runDeclaring(room, o);
  assert.equal(room.phase, 'kou');
  const dealer = room.players[room.dealerSeat];
  const other = room.players.find((p) => p.seat !== room.dealerSeat)!;
  assert.equal(dealer.hand.length, 33);
  assert.equal(room.bottom.length, 0, '扣底期间底牌在庄家手里，不另存一份');

  assert.throws(() => applySjCommand(room, other.id, { type: 'kou', cardIds: ids(dealer.hand.slice(0, 8)) }, o), /只有庄家/);
  assert.throws(() => applySjCommand(room, dealer.id, { type: 'kou', cardIds: ids(dealer.hand.slice(0, 7)) }, o), /8 张/);

  applySjCommand(room, dealer.id, { type: 'kou', cardIds: ids(dealer.hand.slice(0, 8)) }, o);
  assert.equal(room.phase, 'playing');
  assert.equal(dealer.hand.length, 25);
  assert.equal(room.bottom.length, 8);
  assert.equal(room.turnSeat, room.dealerSeat, '庄家首出');
  assert.deepEqual(room.trump.cardIds, [], '扣底结束，亮主的明牌收回暗牌');
});

test('扣底超时由机器人代扣', () => {
  const { room, o } = started(3);
  runDeclaring(room, o);
  timeoutKou(room, o);
  assert.equal(room.phase, 'playing');
  assert.equal(room.bottom.length, 8);
  assert.equal(room.players[room.dealerSeat].hand.length, 25);
});

/* ------------------------------------------------------------------- 出牌 */

test('完整一局：发牌 → 亮主 → 扣底 → 打完 → 结算', () => {
  const { room, o } = started(11);
  playHand(room, o);
  assert.equal(room.phase, 'hand_end');
  const r = room.result!;
  for (const p of room.players) assert.equal(p.hand.length, 0, '手牌要打完');
  assert.equal(r.trickPoints[0] + r.trickPoints[1] + r.bottomPoints, 200, '分数守恒');
  assert.ok(room.trickNo - 1 <= 25 && room.trickNo - 1 >= 1, '圈数在 1–25 之间');
  assert.equal(room.bottomRevealed, true, '局末公开底牌');
  assert.ok(r.outcome.label.length > 0);
  assert.ok(r.nextDealerSeat >= 0 && r.nextDealerSeat < 4);
});

test('出牌要守跟牌规则，不合法时给出原因', () => {
  const { room, o } = started(5);
  runDeclaring(room, o);
  timeoutKou(room, o);
  const dealer = room.players[room.dealerSeat];
  const next = room.players[(room.dealerSeat + 1) % 4];
  assert.throws(() => applySjCommand(room, next.id, { type: 'play', cardIds: [next.hand[0].id] }, o), /还没轮到你/);
  assert.throws(() => applySjCommand(room, dealer.id, { type: 'play', cardIds: [] }, o), /至少要出一张/);
  assert.throws(
    () => applySjCommand(room, dealer.id, { type: 'play', cardIds: [dealer.hand[0].id, dealer.hand[0].id] }, o),
    /不能出两次/,
  );
});

test('甩牌失败：只留最小的单位，闲家甩砸倒扣 10 分', () => {
  const { room, o } = started(2);
  runDeclaring(room, o);
  timeoutKou(room, o);
  // 手工摆一个局面：庄家在 0 座，1 座（闲家）首出一手压不住的甩牌
  room.dealerSeat = 0;
  room.trump = { suit: 'S', level: 5, declarerId: null, strength: 0, cardIds: [] };
  room.leaderSeat = 1;
  room.turnSeat = 1;
  room.trick = [];
  room.trickNo = 1;
  room.defenderPoints = 0;
  room.players[0].hand = h('HAb H3a H4a');
  room.players[1].hand = h('HAa HKa H2a');
  room.players[2].hand = h('H6a H7a H8a');
  room.players[3].hand = h('H9a HTa HJa');

  applySjCommand(room, room.players[1].id, { type: 'play', cardIds: ['HAa', 'HKa'] }, o);
  assert.deepEqual(room.trick[0].cardIds, ['HKa'], '只能出最小的那个单位');
  assert.deepEqual(ids(room.players[1].hand).sort(), ['H2a', 'HAa'], '其余退回手里');
  assert.equal(room.defenderPoints, -10, '闲家甩砸，闲家 −10');
  assert.equal(room.lastThrowFail?.penalty, -10);
});

test('甩牌失败：庄家阵营甩砸，10 分判给闲家', () => {
  const { room, o } = started(2);
  runDeclaring(room, o);
  timeoutKou(room, o);
  room.dealerSeat = 0;
  room.trump = { suit: 'S', level: 5, declarerId: null, strength: 0, cardIds: [] };
  room.leaderSeat = 0;
  room.turnSeat = 0;
  room.trick = [];
  room.trickNo = 1;
  room.defenderPoints = 0;
  room.players[0].hand = h('HAa HKa H2a');
  room.players[1].hand = h('HAb H3a H4a');
  room.players[2].hand = h('H6a H7a H8a');
  room.players[3].hand = h('H9a HTa HJa');
  applySjCommand(room, room.players[0].id, { type: 'play', cardIds: ['HAa', 'HKa'] }, o);
  assert.equal(room.defenderPoints, 10);
});

test('甩牌成功时整手都算数', () => {
  const { room, o } = started(2);
  runDeclaring(room, o);
  timeoutKou(room, o);
  room.dealerSeat = 0;
  room.trump = { suit: 'S', level: 5, declarerId: null, strength: 0, cardIds: [] };
  room.leaderSeat = 0;
  room.turnSeat = 0;
  room.trick = [];
  room.trickNo = 1;
  room.players[0].hand = h('HAa HKa');
  room.players[1].hand = h('H2a H3a');
  room.players[2].hand = h('H4a H6a');
  room.players[3].hand = h('H7a H8a');
  applySjCommand(room, room.players[0].id, { type: 'play', cardIds: ['HAa', 'HKa'] }, o);
  assert.deepEqual(room.trick[0].cardIds, ['HAa', 'HKa']);
  assert.equal(room.lastThrowFail, null);
});

/**
 * 甩牌失败的核心承诺：**最小的那个单位一定被打出去了**，不是"整把退回、什么都没出"。
 * 客户端只演了一段"退回手里"的动效，很容易让人以为这一手没出成 —— 用例把这条钉死。
 */
test('甩牌失败：混合牌型也只留最小的那个单位（对子 < 拖拉机）', () => {
  const { room, o } = started(3);
  runDeclaring(room, o);
  timeoutKou(room, o);
  room.dealerSeat = 0;
  room.trump = { suit: 'S', level: 5, declarerId: null, strength: 0, cardIds: [] };
  room.leaderSeat = 1;
  room.turnSeat = 1;
  room.trick = [];
  room.trickNo = 1;
  room.defenderPoints = 0;
  // 1 座（闲家）甩「9-10 两连对 + KK」：连对没人压得住，但 KK 被 0 座的 AA 压住
  room.players[0].hand = h('HAa HAb H3a H4a H6a H7a');
  room.players[1].hand = h('H9a H9b HTa HTb HKa HKb');
  room.players[2].hand = h('H2a H2b H8a HJa HQa D2a');
  room.players[3].hand = h('C2a C3a C4a D3a D4a D6a');

  applySjCommand(room, room.players[1].id, { type: 'play', cardIds: ['H9a', 'H9b', 'HTa', 'HTb', 'HKa', 'HKb'] }, o);

  assert.deepEqual(room.trick[0].cardIds, ['HKa', 'HKb'], '拖拉机 > 对子，最小的单位是那一对 K');
  assert.deepEqual(ids(room.players[1].hand).sort(), ['H9a', 'H9b', 'HTa', 'HTb'], '连对退回手里');
  assert.equal(room.players[1].hand.length + room.trick[0].cardIds.length, 6, '牌不会凭空少');
  assert.equal(room.defenderPoints, -10, '闲家甩砸，闲家 −10');
  assert.deepEqual(room.lastThrowFail?.forcedIds, ['HKa', 'HKb'], '事件要带上被强制打出的那一手');
});

test('甩牌失败：单张的优先级最低，对子压不住时也先被留下的是单张', () => {
  const { room, o } = started(3);
  runDeclaring(room, o);
  timeoutKou(room, o);
  room.dealerSeat = 0;
  room.trump = { suit: 'S', level: 5, declarerId: null, strength: 0, cardIds: [] };
  room.leaderSeat = 1;
  room.turnSeat = 1;
  room.trick = [];
  room.trickNo = 1;
  room.defenderPoints = 0;
  room.players[0].hand = h('HAa HAb H3a');
  room.players[1].hand = h('HKa HKb H2a');
  room.players[2].hand = h('H6a H7a H8a');
  room.players[3].hand = h('H9a HTa HJa');

  applySjCommand(room, room.players[1].id, { type: 'play', cardIds: ['HKa', 'HKb', 'H2a'] }, o);

  assert.deepEqual(room.trick[0].cardIds, ['H2a'], '对子 > 单张，最小的单位是那张 2');
  assert.deepEqual(ids(room.players[1].hand).sort(), ['HKa', 'HKb'], '对子退回手里');

  // 事件层面也要说得清：客户端靠 forcedIds 算「哪几张飞回来了」并写进提示文案
  const evs = deriveSjEvents(
    { ...room, trick: [], lastThrowFail: null, players: room.players.map((p) => ({ ...p, hand: [...p.hand, ...(p.seat === 1 ? h('H2a') : [])] })) } as never,
    room,
    room.players[1].id,
    { type: 'play', cardIds: ['HKa', 'HKb', 'H2a'] },
  );
  const fail = evs.find((e) => e.k === 'sj_throw_fail');
  assert.ok(fail, '要发出 sj_throw_fail 事件');
  assert.deepEqual(fail.forcedIds, ['H2a']);
});

test('抠底：闲家赢最后一圈，底牌分按 2^张数 翻倍', () => {
  const { room, o } = started(4);
  runDeclaring(room, o);
  timeoutKou(room, o);
  room.dealerSeat = 0;
  room.trump = { suit: 'S', level: 5, declarerId: null, strength: 0, cardIds: [] };
  room.bottom = h('SKa SKb STa D2a D3a D4a D6a D7a'); // 30 分
  room.bottomRevealed = false;
  room.leaderSeat = 0;
  room.turnSeat = 0;
  room.trick = [];
  room.trickNo = 25;
  room.defenderPoints = 0;
  room.handTrickPoints = [0, 0];
  room.players[0].hand = h('H2a');
  room.players[1].hand = h('HAa');
  room.players[2].hand = h('H3a');
  room.players[3].hand = h('H4a');
  for (const p of room.players) applySjCommand(room, p.id, { type: 'play', cardIds: [p.hand[0].id] }, o);

  assert.equal(room.phase, 'hand_end');
  assert.deepEqual(room.result!.dig, { base: 30, multiplier: 2, total: 60 }, '单张抠底 ×2');
  assert.equal(room.result!.defenderPoints, 60);
  assert.equal(room.bottomRevealed, true);
});

test('庄家守住时底牌不翻倍，抠底也不发生', () => {
  const { room, o } = started(4);
  runDeclaring(room, o);
  timeoutKou(room, o);
  room.dealerSeat = 0;
  room.trump = { suit: 'S', level: 5, declarerId: null, strength: 0, cardIds: [] };
  room.bottom = h('SKa SKb STa D2a D3a D4a D6a D7a');
  room.leaderSeat = 0;
  room.turnSeat = 0;
  room.trick = [];
  room.trickNo = 25;
  room.defenderPoints = 0;
  room.handTrickPoints = [0, 0];
  room.players[0].hand = h('HAa');
  room.players[1].hand = h('H2a');
  room.players[2].hand = h('H3a');
  room.players[3].hand = h('H4a');
  for (const p of room.players) applySjCommand(room, p.id, { type: 'play', cardIds: [p.hand[0].id] }, o);
  assert.equal(room.result!.dig, undefined);
  assert.equal(room.result!.outcome.label, '大光', '闲家一分没拿');
  assert.deepEqual(room.levels, [13, 5], '庄家队从 5 直接升 3 级，夹在 K');
});

test('出牌超时由机器人代打一手合法牌，没有弃牌这回事', () => {
  const { room, o } = started(6);
  runDeclaring(room, o);
  timeoutKou(room, o);
  const before = room.players.map((p) => p.hand.length);
  timeoutTurn(room, o);
  const after = room.players.map((p) => p.hand.length);
  assert.notDeepEqual(before, after, '超时也得出牌');
  assert.equal(room.trick.length, 1);
});

/* --------------------------------------------------------------- 局与比赛 */

test('庄家轮转与下一局：守住换对家，被打下换下家', () => {
  const { room, o } = started(12);
  playHand(room, o);
  const r = room.result!;
  const expected = (room.dealerSeat + (r.outcome.defendersWin ? 1 : 2)) % 4;
  assert.equal(r.nextDealerSeat, expected);
  startNextHand(room, o);
  assert.equal(room.dealerSeat, expected);
  assert.equal(room.phase, 'dealing');
  assert.equal(room.handNo, 2);
  assert.equal(room.trump.level, room.levels[room.dealerSeat % 2], '级牌跟着庄家队走');
});

test('通关：顶级的队坐庄守住一局就赢下整场，再来一场会重置级别', () => {
  const { room, o } = started(9);
  runDeclaring(room, o);
  timeoutKou(room, o);
  // 手工摆最后一圈：0/2 队已经在顶级 K 上坐庄，这一局闲家一分没拿
  room.levels = [13, 5];
  room.dealerSeat = 0;
  room.trump = { suit: 'S', level: 13, declarerId: null, strength: 0, cardIds: [] };
  room.bottom = h('D2a D3a D4a D6a D7a D8a D9a DJa');
  room.leaderSeat = 0;
  room.turnSeat = 0;
  room.trick = [];
  room.trickNo = 25;
  room.defenderPoints = 0;
  room.handTrickPoints = [0, 0];
  room.players[0].hand = h('HAa');
  room.players[1].hand = h('H2a');
  room.players[2].hand = h('H3a');
  room.players[3].hand = h('H4a');
  for (const p of room.players) applySjCommand(room, p.id, { type: 'play', cardIds: [p.hand[0].id] }, o);

  assert.equal(room.phase, 'match_end');
  assert.equal(room.matchWinner, 0);
  assert.deepEqual(room.levels, [13, 5], '已经在顶级，升级夹住不动');

  applySjCommand(room, room.hostId, { type: 'new_match' }, o);
  assert.deepEqual(room.levels, [5, 5]);
  assert.equal(room.phase, 'lobby');
  assert.equal(room.matchWinner, undefined);
  assert.equal(room.handNo, 0, '庄家重新由亮主决定');
});

/* ------------------------------------------------------------------ 断线 */

test('局中离开：座位由电脑接管到本场结束，人数不变', () => {
  const { room, o } = started(8);
  runDeclaring(room, o);
  timeoutKou(room, o);
  const victim = room.players.find((p) => !p.isBot && p.seat !== room.dealerSeat) ?? room.players[1];
  applySjCommand(room, victim.id, { type: 'leave' }, o);
  assert.equal(room.players.length, 4, '四人局不能中途少人');
  assert.equal(victim.isBot, true);
  assert.equal(victim.pendingLeave, true);
  playOutTricks(room, o);
  assert.equal(room.phase, 'hand_end');
});

test('大厅里离开会空出座位，房主移交给还在的真人', () => {
  const room = makeSjRoom();
  const second = createSjPlayer('乙', '🦊', 4, 't1');
  second.seat = 1;
  room.players[1] = second; // 把 1 号座换成真人
  applySjCommand(room, room.hostId, { type: 'leave' });
  assert.equal(room.players.length, 3);
  assert.equal(room.hostId, second.id, '房主不会落到电脑头上');
});

/* --------------------------------------------------------------- sanitize */

test('sanitize：别人的手牌、未公开的底牌一律看不到', () => {
  const { room, o } = started(13);
  assertNoHandLeak(room);
  runDeclaring(room, o);
  assertNoHandLeak(room);

  const dealer = room.players[room.dealerSeat];
  const other = room.players.find((p) => p.seat !== room.dealerSeat)!;
  assert.equal(sanitizeSjRoom(room, dealer.id).players[room.dealerSeat].hand.length, 33, '庄家看得到自己的 33 张');
  assert.equal(sanitizeSjRoom(room, other.id).bottom.length, 0);

  timeoutKou(room, o);
  assert.equal(sanitizeSjRoom(room, dealer.id).bottom.length, 0, '扣完底牌，谁都看不到');
  assert.equal(sanitizeSjRoom(room, other.id).bottom.length, 0);
  assert.equal(sanitizeSjRoom(room, other.id).bottomCount, 8, '张数是公开的');
  assertNoHandLeak(room);

  playOutTricks(room, o);
  for (const viewer of room.players) {
    assert.equal(sanitizeSjRoom(room, viewer.id).bottom.length, 8, '局末底牌对所有人公开');
    assert.equal(sanitizeSjRoom(room, viewer.id).result!.bottom.length, 8);
  }
});

test('sanitize：亮主的明牌是规范要求公开的，其余暗牌一张都不给', () => {
  const { room, o } = started(14);
  const p0 = room.players[0];
  p0.hand = [...h('S5a'), ...p0.hand.filter((c) => c.id !== 'S5a')];
  applySjCommand(room, p0.id, { type: 'declare', cardIds: ['S5a'] }, o);
  const view = sanitizeSjRoom(room, room.players[1].id);
  assert.deepEqual(view.players[0].declaredIds, ['S5a'], '亮主的牌摆在座位前，全场看得见');
  assert.deepEqual(view.players[0].hand, [], '其余的牌一张不给');
  assertNoHandLeak(room);
});

/* --------------------------------------------------------------- migrate */

test('老快照缺字段会被补齐，不会带着 undefined 复活', () => {
  const partial = {
    kind: 'sj_510k', id: 'r1', code: '123456', hostId: 'p1',
    players: [{ id: 'p1', name: '甲', avatar: '', seat: 0, isBot: false }],
    phase: 'lobby',
  } as unknown as SjRoomState;
  const room = migrateSjRoom(partial);
  assert.deepEqual(room.levels, [ladderOf('sj_510k')[0], ladderOf('sj_510k')[0]]);
  assert.deepEqual(room.settings, { turnSeconds: 30, kouSeconds: 45, autoContinue: true });
  assert.deepEqual(room.trick, []);
  assert.deepEqual(room.playedIds, []);
  assert.equal(room.lastThrowFail, null);
  assert.equal(room.bottomRevealed, false);
  assert.deepEqual(room.players[0].hand, []);
  assert.deepEqual(room.players[0].declaredIds, []);
  assert.ok(room.players[0].avatar.length > 0);
  for (const v of Object.values(room)) assert.notEqual(v, undefined);
});

/* ---------------------------------------------------------------- 事件 */

test('事件从前后两份状态里派生出来，够客户端演一遍', () => {
  const room = makeSjRoom();
  const o = opts(15);
  let before = structuredClone(room);
  applySjCommand(room, room.hostId, { type: 'start' }, o);
  let events = deriveSjEvents(before, room, room.hostId, { type: 'start' });
  assert.deepEqual(events.filter((e) => e.k === 'sj_deal').length, 1);

  before = structuredClone(room);
  finishDealing(room, o);
  closeDeclaring(room, o); // 没人亮主 → 翻底定主
  events = deriveSjEvents(before, room, '', null);
  assert.equal(events.filter((e) => e.k === 'sj_flip').length, 1, '翻底定主要有事件');

  before = structuredClone(room);
  timeoutKou(room, o);
  events = deriveSjEvents(before, room, room.players[room.dealerSeat].id, null);
  assert.equal(events.filter((e) => e.k === 'sj_kou_done').length, 1);

  const dealer = room.players[room.dealerSeat];
  before = structuredClone(room);
  const cardIds = [dealer.hand[dealer.hand.length - 1].id];
  applySjCommand(room, dealer.id, { type: 'play', cardIds }, o);
  events = deriveSjEvents(before, room, dealer.id, { type: 'play', cardIds });
  const play = events.find((e) => e.k === 'sj_play');
  assert.ok(play && play.k === 'sj_play' && play.cardIds.length === 1);
  assert.ok(events.some((e) => e.k === 'sj_turn'));

  // 打到局末，应当有定圈、结算事件
  before = structuredClone(room);
  playOutTricks(room, o);
  events = deriveSjEvents(before, room, '', null);
  assert.ok(events.some((e) => e.k === 'sj_hand_end'), '结算要有事件');
});

test('聊天与表情也会派生事件', () => {
  const room = makeSjRoom();
  const before = structuredClone(room);
  applySjCommand(room, room.hostId, { type: 'chat', text: '开一把' });
  applySjCommand(room, room.hostId, { type: 'emote', id: '👍' });
  const events = deriveSjEvents(before, room, room.hostId, { type: 'emote', id: '👍' });
  assert.ok(events.some((e) => e.k === 'sj_chat'));
  assert.ok(events.some((e) => e.k === 'sj_emote'));
  assert.throws(() => applySjCommand(room, room.hostId, { type: 'emote', id: '💩' }), /无效的表情/);
});
