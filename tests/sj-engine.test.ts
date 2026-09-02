import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applySjCommand, closeDeclaring, createSjPlayer, createSjRoom, dealSjHand, deriveSjEvents,
  finishDealing, migrateSjRoom, sanitizeSjRoom, startNextHand, timeoutKou, timeoutTurn,
  type SjCommand, type SjRoomState,
} from '../shared/sj/engine.ts';
import { sumPoints } from '../shared/sj/cards.ts';
import { GameError } from '../shared/game.ts';
import { ladderOf } from '../shared/games.ts';
import { SJ_DECL_TIER, legalDeclarations } from '../shared/sj/rules.ts';
import {
  h, ids, makeSjRoom, mulberry32, playHand, playOutTricks, runChao, runDeclaring, runToPlaying,
} from './sj-helpers.ts';

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

/**
 * 把某张牌换进指定座位的手里，同时保持全场 108 张不重不漏。
 *
 * 换出去的那张一定不是级牌也不是王 —— 否则会顺手改掉这一局能亮什么，
 * 用例摆的局面就不作数了。
 */
function forceIntoHand(room: SjRoomState, seat: number, id: string) {
  const target = room.players.find((p) => p.seat === seat)!;
  if (target.hand.some((c) => c.id === id)) return;
  const slot = target.hand.findIndex((c) => c.suit !== 'J' && c.rank !== room.trump.level);
  assert.ok(slot >= 0, `${seat} 号座没有可以换出去的闲牌`);
  const inBottom = room.bottom.findIndex((c) => c.id === id);
  if (inBottom >= 0) {
    [room.bottom[inBottom], target.hand[slot]] = [target.hand[slot], room.bottom[inBottom]];
    return;
  }
  for (const p of room.players) {
    const i = p.hand.findIndex((c) => c.id === id);
    if (i >= 0) {
      [p.hand[i], target.hand[slot]] = [target.hand[slot], p.hand[i]];
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

  // 同花色的第二张级牌 = 加固，单张（1）抬到黑桃的对子档（5）
  applySjCommand(room, p0.id, { type: 'declare', cardIds: ['S5b'] }, o);
  assert.equal(room.trump.strength, SJ_DECL_TIER.S);
  assert.deepEqual(room.trump.cardIds.slice().sort(), ['S5a', 'S5b']);

  // 黑桃是花色序里最大的一门，别人再想反必须出王
  assert.throws(() => applySjCommand(room, p1.id, { type: 'declare', cardIds: ['C5a', 'C5b'] }, o), /更强/);
  applySjCommand(room, p2.id, { type: 'declare', cardIds: ['JSa', 'JSb'] }, o);
  assert.equal(room.trump.suit, 'NT');
  assert.equal(room.trump.strength, SJ_DECL_TIER.joker_s);
  assert.deepEqual(p0.declaredIds, [], '被反掉的明牌收回去');

  applySjCommand(room, p3.id, { type: 'declare', cardIds: ['JBa', 'JBb'] }, o);
  assert.equal(room.trump.strength, SJ_DECL_TIER.joker_b);
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

test('扣底：只有庄家能扣、必须恰好 8 张，扣完进抄底询问', () => {
  const { room, o } = started();
  runDeclaring(room, o);
  assert.equal(room.phase, 'kou');
  assert.equal(room.kouSeat, room.dealerSeat, '第一次扣底的是庄家');
  const dealer = room.players[room.dealerSeat];
  const other = room.players.find((p) => p.seat !== room.dealerSeat)!;
  assert.equal(dealer.hand.length, 33);
  assert.equal(room.bottom.length, 0, '扣底期间底牌在庄家手里，不另存一份');

  assert.throws(() => applySjCommand(room, other.id, { type: 'kou', cardIds: ids(dealer.hand.slice(0, 8)) }, o), /只有庄家/);
  assert.throws(() => applySjCommand(room, dealer.id, { type: 'kou', cardIds: ids(dealer.hand.slice(0, 7)) }, o), /8 张/);

  applySjCommand(room, dealer.id, { type: 'kou', cardIds: ids(dealer.hand.slice(0, 8)) }, o);
  assert.equal(room.phase, 'chao', '扣完底先问一轮抄底，不是直接开打');
  assert.equal(room.chaoSeat, (room.dealerSeat + 1) % 4, '从庄家下家问起');
  assert.equal(dealer.hand.length, 25);
  assert.equal(room.bottom.length, 8);

  runChao(room, o);
  assert.equal(room.phase, 'playing');
  assert.equal(room.turnSeat, room.dealerSeat, '庄家首出');
  assert.deepEqual(room.trump.cardIds, [], '抄底问完，亮主的明牌收回暗牌');
});

test('扣底超时由机器人代扣', () => {
  const { room, o } = started(3);
  runDeclaring(room, o);
  timeoutKou(room, o);
  assert.equal(room.phase, 'chao');
  assert.equal(room.bottom.length, 8);
  runChao(room, o);
  assert.equal(room.phase, 'playing');
  assert.equal(room.players[room.dealerSeat].hand.length, 25);
});

test('扣底把自己亮出来的明牌扣了下去，桌面上就不再挂着它', () => {
  const { room, o } = started(7);
  const p0 = room.players[0];
  forceIntoHand(room, 0, 'S5a');
  applySjCommand(room, p0.id, { type: 'declare', cardIds: ['S5a'] }, o);
  closeDeclaring(room, o); // 只让 0 座亮，别让机器人把主反掉
  assert.equal(room.dealerSeat, 0, '首局亮主的人坐庄');
  assert.deepEqual(room.trump.cardIds, ['S5a']);

  // 故意把亮出来的那张一起扣下去
  const bury = ['S5a', ...ids(p0.hand.filter((c) => c.id !== 'S5a').slice(0, 7))];
  applySjCommand(room, p0.id, { type: 'kou', cardIds: bury }, o);
  assert.ok(room.bottom.some((c) => c.id === 'S5a'), '这张牌确实进了底牌');
  assert.deepEqual(room.trump.cardIds, [], '公开的明牌 id 不能再指向底牌里的牌');
  assert.deepEqual(p0.declaredIds, []);
  assertNoHandLeak(room);
});

/* ------------------------------------------------------------------- 抄底 */

/**
 * 手工摆一个「庄家已经扣完底、正在问抄底」的局面。
 * `handNo` 默认给 2 —— 首局换庄的口径另有专门的用例，这里先把庄家钉死好数轮次。
 */
function atChao(seed = 1, handNo = 2) {
  const { room, o } = started(seed);
  runDeclaring(room, o);
  timeoutKou(room, o);
  room.handNo = handNo;
  room.dealerSeat = 0;
  room.kouSeat = 0;
  room.chaoDirty = false;
  room.chaoSeat = 1;
  room.turnSeat = 1;
  room.trump = { suit: 'D', level: 5, declarerId: null, strength: 0, cardIds: [] };
  for (const p of room.players) p.declaredIds = [];
  return { room, o };
}

/**
 * 扣 8 张。手牌是**从大到小**排好的，所以从末尾取就是扣最小的那几张；
 * 亮出来的明牌和用例后面还要用的牌都留着不扣。
 */
function buryEight(room: SjRoomState, o: ReturnType<typeof opts>, keep: string[] = []) {
  const p = room.players[room.kouSeat];
  const spare = new Set([...room.trump.cardIds, ...keep]);
  const pick = ids(p.hand.filter((c) => !spare.has(c.id)).slice(-8));
  assert.equal(pick.length, 8, '手里总该有 8 张不相干的牌可扣');
  applySjCommand(room, p.id, { type: 'kou', cardIds: pick }, o);
}

test('抄底：依次询问 → 有人抄就重新扣底再接着问 → 一轮没人抄才开打', () => {
  const { room, o } = atChao(31);
  const [p0, p1, p2, p3] = room.players;
  forceIntoHand(room, 1, 'H5a');
  for (const id of ['S5a', 'S5b']) forceIntoHand(room, 2, id);
  for (const id of ['JBa', 'JBb']) forceIntoHand(room, 3, id);

  assert.equal(room.phase, 'chao');
  assert.equal(room.chaoSeat, 1, '从庄家下家问起');
  assert.throws(() => applySjCommand(room, p2.id, { type: 'chao', cardIds: ['S5a', 'S5b'] }, o), /还没轮到你/);
  assert.throws(() => applySjCommand(room, p0.id, { type: 'pass_chao' }, o), /还没轮到你/);

  // 1 座抄底：翻底定主是 0 档，单张级牌（1 档）就抄得动
  applySjCommand(room, p1.id, { type: 'chao', cardIds: ['H5a'] }, o);
  assert.equal(room.trump.suit, 'H', '主变成抄底者亮的花色');
  assert.equal(room.trump.declarerId, p1.id, '抄底视同反主');
  assert.deepEqual(p1.declaredIds, ['H5a'], '抄出来的牌明牌摆在座位前');
  assert.equal(room.phase, 'kou');
  assert.equal(room.kouSeat, 1, '抄底者拿走底牌重扣，扣底的不是庄家');
  assert.equal(room.dealerSeat, 0, '第二局起抄底不换庄');
  assert.equal(room.bottom.length, 0, '底牌这会儿在他手里');
  assert.equal(p1.hand.length, 33);
  buryEight(room, o);

  // 扣完接着问本轮剩下的人，不重头再问一遍
  assert.equal(room.phase, 'chao');
  assert.equal(room.chaoSeat, 2, '从抄底者的下家继续本轮');
  assert.equal(room.chaoDirty, true);
  applySjCommand(room, p2.id, { type: 'chao', cardIds: ['S5a', 'S5b'] }, o);
  assert.equal(room.trump.suit, 'S');
  assert.deepEqual(p1.declaredIds, [], '上一个亮主者的明牌收回去');
  buryEight(room, o);
  assert.equal(room.chaoSeat, 3);

  // 3 座这一轮先不抄；一轮问完（回到起点 1 座）且有人抄过 → 再开一轮
  applySjCommand(room, p3.id, { type: 'pass_chao' }, o);
  assert.equal(room.phase, 'chao', '这一轮有人抄过，还要再问一轮');
  assert.equal(room.chaoSeat, 1, '新的一轮又从庄家下家问起');
  assert.equal(room.chaoDirty, false, '开新一轮时把标记清掉');

  // 第二轮：1、2 都抄不动了，3 座掏出对大王
  applySjCommand(room, p1.id, { type: 'pass_chao' }, o);
  assert.throws(() => applySjCommand(room, p2.id, { type: 'chao', cardIds: ['S5a', 'S5b'] }, o), /更强/);
  applySjCommand(room, p2.id, { type: 'pass_chao' }, o);
  applySjCommand(room, p3.id, { type: 'chao', cardIds: ['JBa', 'JBb'] }, o);
  assert.equal(room.trump.suit, 'NT');
  assert.equal(room.trump.strength, SJ_DECL_TIER.joker_b);
  buryEight(room, o);

  // 第三轮：已经封顶，谁都抄不动 → 一轮无人抄，开打
  assert.equal(room.chaoSeat, 1);
  applySjCommand(room, p1.id, { type: 'pass_chao' }, o);
  applySjCommand(room, p2.id, { type: 'pass_chao' }, o);
  applySjCommand(room, p3.id, { type: 'pass_chao' }, o);
  assert.equal(room.phase, 'playing');
  assert.equal(room.turnSeat, room.dealerSeat, '首出还是庄家');
  assert.equal(room.chaoSeat, null);
  assert.deepEqual(room.trump.cardIds, [], '开打前明牌全部收回暗牌');
  for (const p of room.players) assert.deepEqual(p.declaredIds, []);
});

test('抄底：庄家不参与询问 —— 他刚拿过一次底牌', () => {
  const { room, o } = atChao(32);
  const seen: number[] = [];
  let guard = 0;
  while (room.phase === 'chao' && guard++ < 10) {
    seen.push(room.chaoSeat!);
    applySjCommand(room, room.players[room.chaoSeat!].id, { type: 'pass_chao' }, o);
  }
  assert.deepEqual(seen, [1, 2, 3], '一轮就是庄家下家起顺时针三家，庄家不在里面');
  assert.equal(room.phase, 'playing', '一个人都没抄就直接开打');
});

test('抄底：不能自反，但可以用对王把自己反成无主', () => {
  const { room, o } = atChao(33);
  const [, p1] = room.players;
  const mine = ['H5a', 'H5b', 'S5a', 'S5b', 'JBa', 'JBb'];
  for (const id of mine) forceIntoHand(room, 1, id);

  applySjCommand(room, p1.id, { type: 'chao', cardIds: ['H5a', 'H5b'] }, o);
  buryEight(room, o, mine);
  // 转了一圈又问到他：主是他亮的，加固/换花色都不行
  applySjCommand(room, room.players[2].id, { type: 'pass_chao' }, o);
  applySjCommand(room, room.players[3].id, { type: 'pass_chao' }, o);
  assert.equal(room.chaoSeat, 1, '有人抄过，所以又开了一轮');

  assert.throws(() => applySjCommand(room, p1.id, { type: 'chao', cardIds: ['S5a', 'S5b'] }, o), /不能自己抄/);
  applySjCommand(room, p1.id, { type: 'chao', cardIds: ['JBa', 'JBb'] }, o);
  assert.equal(room.trump.suit, 'NT', '对王把自己的主反成无主是允许的');
  assert.equal(room.trump.declarerId, p1.id);
});

test('抄底：首局抄底者坐庄，第二局起只换主不换庄', () => {
  const first = atChao(34, 1);
  for (const id of ['S5a', 'S5b']) forceIntoHand(first.room, 2, id);
  // 首局先问 1 座，让他过，再让 2 座抄
  applySjCommand(first.room, first.room.players[1].id, { type: 'pass_chao' }, first.o);
  applySjCommand(first.room, first.room.players[2].id, { type: 'chao', cardIds: ['S5a', 'S5b'] }, first.o);
  assert.equal(first.room.dealerSeat, 2, '首局的庄家跟着亮主走，抄底视同反主');
  assert.equal(first.room.kouSeat, 2);

  const later = atChao(34, 3);
  for (const id of ['S5a', 'S5b']) forceIntoHand(later.room, 2, id);
  applySjCommand(later.room, later.room.players[1].id, { type: 'pass_chao' }, later.o);
  applySjCommand(later.room, later.room.players[2].id, { type: 'chao', cardIds: ['S5a', 'S5b'] }, later.o);
  assert.equal(later.room.dealerSeat, 0, '第二局起庄家按轮转定死，抄底不换庄');
  assert.equal(later.room.kouSeat, 2, '但底牌归抄底的人重扣');
});

test('抄底之后牌还是 4×25 + 底 8，一张不多一张不少', () => {
  /*
   * 机器人「绝不为反而反」，真实牌局里抄底并不常见 —— 用它跑，多数种子一次都抄不到，
   * 这条不变量就等于没测。所以这里换成**但凡亮得起就抄**的驱动，把抄底链路压满。
   */
  let chaos = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const { room, o } = started(seed);
    runDeclaring(room, o);
    let guard = 0;
    while (room.phase === 'kou' || room.phase === 'chao') {
      assert.ok(guard++ < 80, `seed=${seed}：抄底没有收敛`);
      if (room.phase === 'kou') {
        timeoutKou(room, o);
        continue;
      }
      const asked = room.players[room.chaoSeat!];
      const best = legalDeclarations(asked.hand, room.trump.level, room.trump, asked.id, 'chao').at(-1);
      if (best) chaos += 1;
      applySjCommand(
        room, asked.id,
        best ? { type: 'chao', cardIds: ids(best.cards) } : { type: 'pass_chao' },
        o,
      );
    }
    assert.equal(room.phase, 'playing', `seed=${seed}`);
    for (const p of room.players) assert.equal(p.hand.length, 25, `seed=${seed}：${p.name} 的手牌`);
    assert.equal(room.bottom.length, 8, `seed=${seed}：底牌`);
    const all = [...room.players.flatMap((p) => p.hand), ...room.bottom];
    assert.equal(new Set(ids(all)).size, 108, `seed=${seed}：108 张不重不漏`);
    assert.equal(sumPoints(all), 200, `seed=${seed}：全场还是 200 分`);
  }
  // 30 副牌里实际抄成 17 次（含同一局里连抄好几手），够把这条链路压出来了
  assert.ok(chaos > 10, `抄底只发生了 ${chaos} 次，这个用例没压到该压的路径`);
});

test('抄底的事件够客户端演一遍', () => {
  const { room, o } = atChao(35);
  const p1 = room.players[1];
  for (const id of ['S5a', 'S5b']) forceIntoHand(room, 1, id);
  const before = structuredClone(room);
  const cmd: SjCommand = { type: 'chao', cardIds: ['S5a', 'S5b'] };
  applySjCommand(room, p1.id, cmd, o);
  const events = deriveSjEvents(before, room, p1.id, cmd);
  const chao = events.find((e) => e.k === 'sj_chao');
  assert.ok(chao && chao.k === 'sj_chao', '要发出 sj_chao 事件');
  assert.equal(chao.trump, 'S');
  assert.equal(chao.strength, SJ_DECL_TIER.S);
  assert.deepEqual(chao.cardIds.slice().sort(), ['S5a', 'S5b']);
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
  runToPlaying(room, o);
  const dealer = room.players[room.dealerSeat];
  const next = room.players[(room.dealerSeat + 1) % 4];
  assert.throws(() => applySjCommand(room, next.id, { type: 'play', cardIds: [next.hand[0].id] }, o), /还没轮到你/);
  assert.throws(() => applySjCommand(room, dealer.id, { type: 'play', cardIds: [] }, o), /至少要出一张/);
  assert.throws(
    () => applySjCommand(room, dealer.id, { type: 'play', cardIds: [dealer.hand[0].id, dealer.hand[0].id] }, o),
    /不能出两次/,
  );
});

test('公开缺门只在玩家实际垫出别组牌时记下，并在新局清空', () => {
  const { room, o } = started(5);
  runToPlaying(room, o);
  room.trump = { suit: 'S', level: 5, declarerId: null, strength: 0, cardIds: [] };
  room.leaderSeat = 0;
  room.turnSeat = 0;
  room.trick = [];
  room.players[0].hand = h('H7a H7b D3a');
  room.players[1].hand = h('H2a D2a D4a');
  room.players[2].hand = h('H8a H8b D6a');
  room.players[3].hand = h('H9a H9b D7a');

  applySjCommand(room, room.players[0].id, { type: 'play', cardIds: ['H7a', 'H7b'] }, o);
  applySjCommand(room, room.players[1].id, { type: 'play', cardIds: ['H2a', 'D2a'] }, o);
  assert.deepEqual(room.voidGroups[1], ['H'], '垫牌公开证明 1 号座已缺红桃');
  assert.deepEqual(room.voidGroups[0], [], '首出或正常跟牌不能凭暗牌推断缺门');

  dealSjHand(room, o);
  assert.deepEqual(room.voidGroups, [[], [], [], []]);
});

test('甩牌失败：只强制出能被管上的最小单位，闲家甩砸倒扣 10 分', () => {
  const { room, o } = started(2);
  runToPlaying(room, o);
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
  assert.deepEqual(room.trick[0].cardIds, ['HKa'], '只能出被管上的最小单位');
  assert.deepEqual(ids(room.players[1].hand).sort(), ['H2a', 'HAa'], '其余退回手里');
  assert.equal(room.defenderPoints, -10, '闲家甩砸，闲家 −10');
  assert.equal(room.lastThrowFail?.penalty, -10);
});

test('甩牌失败：庄家阵营甩砸，10 分判给闲家', () => {
  const { room, o } = started(2);
  runToPlaying(room, o);
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
  runToPlaying(room, o);
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
 * 甩牌失败的核心承诺：**被管上的牌型中，最小单位一定被打出去了**，不是"整把退回、什么都没出"。
 * 客户端只演了一段"退回手里"的动效，很容易让人以为这一手没出成 —— 用例把这条钉死。
 */
test('甩牌失败：混合牌型中只有对子被管上，就强制出该对子', () => {
  const { room, o } = started(3);
  runToPlaying(room, o);
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

  assert.deepEqual(room.trick[0].cardIds, ['HKa', 'HKb'], '只有这对 K 能被管上');
  assert.deepEqual(ids(room.players[1].hand).sort(), ['H9a', 'H9b', 'HTa', 'HTb'], '连对退回手里');
  assert.equal(room.players[1].hand.length + room.trick[0].cardIds.length, 6, '牌不会凭空少');
  assert.equal(room.defenderPoints, -10, '闲家甩砸，闲家 −10');
  assert.deepEqual(room.lastThrowFail?.forcedIds, ['HKa', 'HKb'], '事件要带上被强制打出的那一手');
});

test('甩牌失败：只有对子被管上时强制出对子，不能错误地改出无关单张', () => {
  const { room, o } = started(3);
  runToPlaying(room, o);
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

  assert.deepEqual(room.trick[0].cardIds, ['HKa', 'HKb'], 'QQ 口径：被管上的是对子，就强制出对子');
  assert.deepEqual(ids(room.players[1].hand), ['H2a'], '无关单张退回手里');

  // 事件层面也要说得清：客户端靠 forcedIds 算「哪几张飞回来了」并写进提示文案
  const evs = deriveSjEvents(
    { ...room, trick: [], lastThrowFail: null, players: room.players.map((p) => ({ ...p, hand: [...p.hand, ...(p.seat === 1 ? h('HKa HKb') : [])] })) } as never,
    room,
    room.players[1].id,
    { type: 'play', cardIds: ['HKa', 'HKb', 'H2a'] },
  );
  const fail = evs.find((e) => e.k === 'sj_throw_fail');
  assert.ok(fail, '要发出 sj_throw_fail 事件');
  assert.deepEqual(fail.forcedIds, ['HKa', 'HKb']);
});

test('抠底：闲家单张赢最后一圈，底牌分按 ×2 计入', () => {
  const { room, o } = started(4);
  runToPlaying(room, o);
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
  runToPlaying(room, o);
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
  runToPlaying(room, o);
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
  runToPlaying(room, o);
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
  runToPlaying(room, o);
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
  assert.equal(room.phase, 'chao');
  // 抄底询问阶段底牌是扣着的：谁都不该看见，否则等于照着底牌决定抄不抄（DESIGN 1.4b）
  for (const viewer of room.players) {
    assert.equal(sanitizeSjRoom(room, viewer.id).bottom.length, 0, '抄底阶段谁都看不到底牌');
    assert.equal(sanitizeSjRoom(room, viewer.id).bottomCount, 8, '张数是公开的');
  }
  assertNoHandLeak(room);

  runChao(room, o);
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
  assert.deepEqual(room.settings, { turnSeconds: 30, kouSeconds: 45, chaoSeconds: 12, autoContinue: true });
  assert.deepEqual(room.trick, []);
  assert.deepEqual(room.playedIds, []);
  assert.equal(room.lastThrowFail, null);
  assert.equal(room.bottomRevealed, false);
  assert.deepEqual(room.players[0].hand, []);
  assert.deepEqual(room.players[0].declaredIds, []);
  assert.ok(room.players[0].avatar.length > 0);
  assert.equal(room.kouSeat, room.dealerSeat, '老快照里扣底的一定是庄家');
  assert.equal(room.chaoSeat, null);
  assert.equal(room.chaoDirty, false);
  for (const v of Object.values(room)) assert.notEqual(v, undefined);
});

test('老快照的反主级别会从 4 档换算成 7 档，而且只换算一次', () => {
  const snapshot = (trump: Partial<SjRoomState['trump']>, extra: Partial<SjRoomState> = {}) =>
    migrateSjRoom({
      kind: 'sj_510k', id: 'r1', code: '123456', hostId: 'p1', phase: 'kou', dealerSeat: 2,
      players: [{ id: 'p1', name: '甲', avatar: '', seat: 2, isBot: false }],
      trump: { suit: null, level: 5, declarerId: 'p1', strength: 0, cardIds: [], ...trump },
      ...extra,
    } as unknown as SjRoomState);

  // 旧表：1 单张 / 2 一对级牌（不分花色）/ 3 一对小王 / 4 一对大王
  assert.equal(snapshot({ suit: 'D', strength: 2 }).trump.strength, SJ_DECL_TIER.D);
  assert.equal(snapshot({ suit: 'C', strength: 2 }).trump.strength, SJ_DECL_TIER.C);
  assert.equal(snapshot({ suit: 'H', strength: 2 }).trump.strength, SJ_DECL_TIER.H);
  assert.equal(snapshot({ suit: 'S', strength: 2 }).trump.strength, SJ_DECL_TIER.S);
  assert.equal(snapshot({ suit: 'NT', strength: 3 }).trump.strength, SJ_DECL_TIER.joker_s);
  assert.equal(snapshot({ suit: 'NT', strength: 4 }).trump.strength, SJ_DECL_TIER.joker_b);
  assert.equal(snapshot({ suit: 'H', strength: 1 }).trump.strength, 1, '单张这一档没变');
  assert.equal(snapshot({ suit: 'H', strength: 0 }).trump.strength, 0, '翻底定主这一档没变');
  assert.equal(snapshot({ suit: 'S', strength: 2 }).kouSeat, 2, '老快照停在扣底就是庄家在扣');

  // 判据是 kouSeat：新快照已经是 7 档语义，绝不能再换算一次
  const fresh = snapshot({ suit: 'C', strength: SJ_DECL_TIER.C }, { kouSeat: 2 });
  assert.equal(fresh.trump.strength, SJ_DECL_TIER.C, '♣ 的一对不该被当成旧的「一对小王」');
  const freshJoker = snapshot({ suit: 'NT', strength: SJ_DECL_TIER.joker_b }, { kouSeat: 2 });
  assert.equal(freshJoker.trump.strength, SJ_DECL_TIER.joker_b);
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
  events = deriveSjEvents(before, room, room.players[room.kouSeat].id, null);
  assert.equal(events.filter((e) => e.k === 'sj_kou_done').length, 1);

  runChao(room, o); // 抄底问完才轮到出牌；庄家可能在这里换人
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

test('表情也会派生事件', () => {
  const room = makeSjRoom();
  const before = structuredClone(room);
  applySjCommand(room, room.hostId, { type: 'emote', id: '👍' });
  const events = deriveSjEvents(before, room, room.hostId, { type: 'emote', id: '👍' });
  assert.ok(events.some((e) => e.k === 'sj_emote'));
  assert.throws(() => applySjCommand(room, room.hostId, { type: 'emote', id: '💩' }), /无效的表情/);
});
