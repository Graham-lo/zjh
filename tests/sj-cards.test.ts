import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cardFromId, cardId, cardOrder, createSjDeck, groupOf, isAdjacent, isSameCard, pointsOf,
  shuffleSj, sortSjHand, sumPoints, type SjCtx,
} from '../shared/sj/cards.ts';
import { CTX_NT5, CTX_S5, h, ids, mulberry32, one } from './sj-helpers.ts';

/* ------------------------------------------------------------------- 牌堆 */

test('两副牌 108 张，id 唯一，往返可还原', () => {
  const deck = createSjDeck();
  assert.equal(deck.length, 108);
  assert.equal(new Set(deck.map((c) => c.id)).size, 108);
  assert.equal(deck.filter((c) => c.suit === 'J').length, 4);
  assert.equal(deck.filter((c) => c.suit === 'S').length, 26);
  for (const c of deck) assert.deepEqual(cardFromId(c.id), { id: c.id, suit: c.suit, rank: c.rank });
  assert.equal(cardId('S', 5, 'a'), 'S5a');
  assert.equal(cardId('J', 16, 'a'), 'JBa');
  assert.equal(cardId('J', 15, 'b'), 'JSb');
  assert.equal(cardId('S', 10, 'a'), 'STa');
});

test('全场 200 分：5 是 5 分，10 与 K 各 10 分，其余不带分', () => {
  assert.equal(sumPoints(createSjDeck()), 200);
  assert.equal(pointsOf(one('S5a')), 5);
  assert.equal(pointsOf(one('STa')), 10);
  assert.equal(pointsOf(one('SKa')), 10);
  assert.equal(pointsOf(one('SAa')), 0);
  assert.equal(pointsOf(one('JBa')), 0);
});

test('洗牌不增不减，注入随机源后可复现', () => {
  const deck = createSjDeck();
  const a = shuffleSj(deck, mulberry32(7));
  const b = shuffleSj(deck, mulberry32(7));
  assert.deepEqual(ids(a), ids(b));
  assert.deepEqual(ids(a).slice().sort(), ids(deck).slice().sort());
  assert.notDeepEqual(ids(a), ids(deck));
  // 不注入时走 crypto，两次结果几乎不可能相同
  assert.notDeepEqual(ids(shuffleSj(deck)), ids(shuffleSj(deck)));
});

/* ------------------------------------------------------------------- 花色组 */

test('王和四色级牌都归主牌组，其余各归本门', () => {
  for (const id of ['JBa', 'JSa', 'S5a', 'H5a', 'C5a', 'D5a', 'SAa', 'S2a']) {
    assert.equal(groupOf(one(id), CTX_S5), 'T', `${id} 应该是主牌`);
  }
  assert.equal(groupOf(one('HAa'), CTX_S5), 'H');
  assert.equal(groupOf(one('DTa'), CTX_S5), 'D');
});

test('无主时只有王和级牌是主牌，四门普通牌各自成组', () => {
  for (const id of ['JBa', 'JSa', 'S5a', 'H5a', 'C5a', 'D5a']) {
    assert.equal(groupOf(one(id), CTX_NT5), 'T');
  }
  assert.equal(groupOf(one('SAa'), CTX_NT5), 'S');
});

/* ------------------------------------------------------------------- 顺序 */

test('有主时主牌顺序：大王 > 小王 > 主级 > 副级 > 主花色 A > K > … > 2', () => {
  const chain = ['JBa', 'JSa', 'S5a', 'H5a', 'SAa', 'SKa', 'SQa', 'S6a', 'S4a', 'S2a'];
  for (let i = 0; i + 1 < chain.length; i++) {
    assert.ok(
      cardOrder(one(chain[i]), CTX_S5) > cardOrder(one(chain[i + 1]), CTX_S5),
      `${chain[i]} 应该大过 ${chain[i + 1]}`,
    );
  }
});

test('三色副级牌互相相等', () => {
  const o = (id: string) => cardOrder(one(id), CTX_S5);
  assert.equal(o('H5a'), o('C5a'));
  assert.equal(o('C5a'), o('D5a'));
  assert.ok(o('S5a') > o('H5a'), '主级牌大过副级牌');
});

test('副牌顺序跳过级牌点数：打 5 时 4 与 6 相邻，打 10 时 9 与 J 相邻', () => {
  const gap = (a: string, b: string, ctx: SjCtx) => cardOrder(one(b), ctx) - cardOrder(one(a), ctx);
  assert.equal(gap('H4a', 'H6a', CTX_S5), 1);
  const ctx10: SjCtx = { trump: 'S', level: 10 };
  assert.equal(gap('H9a', 'HJa', ctx10), 1);
  assert.equal(gap('H8a', 'H9a', ctx10), 1);
});

test('无主时主牌只有 大王 > 小王 > 级牌（四色相等）', () => {
  const o = (id: string) => cardOrder(one(id), CTX_NT5);
  assert.ok(o('JBa') > o('JSa'));
  assert.ok(o('JSa') > o('S5a'));
  assert.equal(o('S5a'), o('H5a'));
  assert.equal(o('S5a'), o('D5a'));
});

/* ------------------------------------------------------------------- 相邻 */

test('主牌里 T色A → 副级 → 主级 → 小王 → 大王 依次相邻', () => {
  const chain = ['SAa', 'H5a', 'S5a', 'JSa', 'JBa'];
  for (let i = 0; i + 1 < chain.length; i++) {
    assert.ok(isAdjacent(one(chain[i]), one(chain[i + 1]), CTX_S5), `${chain[i]} 与 ${chain[i + 1]} 应相邻`);
  }
  assert.ok(!isAdjacent(one('SKa'), one('H5a'), CTX_S5), '隔着 A 就不相邻了');
});

test('三色副级牌相等但不相邻，连不成拖拉机', () => {
  assert.ok(!isAdjacent(one('H5a'), one('C5a'), CTX_S5));
  assert.ok(!isAdjacent(one('C5a'), one('D5a'), CTX_S5));
});

test('无主时 级牌 → 小王 → 大王 相邻', () => {
  assert.ok(isAdjacent(one('S5a'), one('JSa'), CTX_NT5));
  assert.ok(isAdjacent(one('JSa'), one('JBa'), CTX_NT5));
  assert.ok(!isAdjacent(one('S5a'), one('JBa'), CTX_NT5));
});

test('跨组永远不相邻', () => {
  assert.ok(!isAdjacent(one('HAa'), one('SAa'), CTX_S5), '红桃 A 和主花色 A 不同组');
  assert.ok(isAdjacent(one('HKa'), one('HAa'), CTX_S5));
});

test('对子看的是"完全相同的牌"，不是"一样大"', () => {
  assert.ok(isSameCard(one('S5a'), one('S5b')));
  assert.ok(!isSameCard(one('H5a'), one('C5a')), '两张副级牌一样大，但不是一对');
  assert.equal(cardOrder(one('H5a'), CTX_S5), cardOrder(one('C5a'), CTX_S5));
});

/* ------------------------------------------------------------------- 排序 */

test('手牌排序：主牌在左，随后 ♠♥♣♦，组内从大到小，相同的牌挨在一起', () => {
  const hand = h('D2a HKa JSa H5a SAa C7a S5b S5a HAa JBa');
  const sorted = sortSjHand(hand, CTX_S5);
  assert.deepEqual(ids(sorted), ['JBa', 'JSa', 'S5a', 'S5b', 'H5a', 'SAa', 'HAa', 'HKa', 'C7a', 'D2a']);
  // 排序不吃牌也不变牌
  assert.deepEqual(ids(sorted).slice().sort(), ids(hand).slice().sort());
});
