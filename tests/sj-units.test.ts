import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allPairs, allSingles, allTractors, parseShape, primaryUnit, runsOf, shapeEquals,
} from '../shared/sj/units.ts';
import { cardOrder } from '../shared/sj/cards.ts';
import { CTX_NT5, CTX_S5, h, ids, one } from './sj-helpers.ts';

const shape = (spec: string, ctx = CTX_S5) => parseShape(h(spec), ctx);

/* ------------------------------------------------------------------ 基本牌型 */

test('单张与对子', () => {
  const single = shape('HAa')!;
  assert.equal(single.units.length, 1);
  assert.equal(single.units[0].kind, 'single');
  assert.equal(single.isThrow, false);

  const pair = shape('HAa HAb')!;
  assert.equal(pair.units[0].kind, 'pair');
  assert.equal(pair.pairs, 1);
  assert.equal(pair.singles, 0);
});

test('一样大但不是同一张牌，凑不成对子', () => {
  const s = shape('H5a C5a')!;
  assert.equal(s.group, 'T', '两张副级牌都是主牌');
  assert.equal(s.pairs, 0);
  assert.equal(s.singles, 2);
  assert.equal(s.isThrow, true, '两个单张一起出就是甩牌');
});

test('拖拉机：点数相邻的两对', () => {
  const s = shape('H7a H7b H8a H8b')!;
  assert.deepEqual(s.tractors, [2]);
  assert.equal(s.units.length, 1);
  assert.equal(s.units[0].span, 2);
  assert.equal(s.units[0].top, cardOrder(one('H8a'), CTX_S5));
});

test('拖拉机跳过级牌点数：打 5 时 44 与 66 是连对', () => {
  const s = shape('H4a H4b H6a H6b')!;
  assert.deepEqual(s.tractors, [2]);
});

test('主牌里 A 对 + 副级对、主级对 + 小王对都是拖拉机', () => {
  assert.deepEqual(shape('SAa SAb H5a H5b')!.tractors, [2]);
  assert.deepEqual(shape('S5a S5b JSa JSb')!.tractors, [2]);
  assert.deepEqual(shape('JSa JSb JBa JBb')!.tractors, [2]);
  // 一条长链：A对 → 副级对 → 主级对 → 小王对 → 大王对
  assert.deepEqual(shape('SAa SAb H5a H5b S5a S5b JSa JSb JBa JBb')!.tractors, [5]);
});

test('三色副级牌各自成对但连不起来', () => {
  const s = shape('H5a H5b C5a C5b')!;
  assert.deepEqual(s.tractors, []);
  assert.equal(s.pairs, 2);
  assert.equal(s.isThrow, true);
});

test('同一档上多出来的对子只能单独成对，不会虚增拖拉机长度', () => {
  // 副级牌 H5/C5/D5 同档，主级 S5 高一档：最多连出 2 连对，其余两对落单
  const s = shape('H5a H5b C5a C5b D5a D5b S5a S5b')!;
  assert.deepEqual(s.tractors, [2]);
  assert.equal(s.pairs, 2);
});

test('无主时 级牌对 → 小王对 → 大王对 连成拖拉机', () => {
  assert.deepEqual(shape('S5a S5b JSa JSb', CTX_NT5)!.tractors, [2]);
  assert.deepEqual(shape('D5a D5b JSa JSb JBa JBb', CTX_NT5)!.tractors, [3]);
  assert.deepEqual(shape('S5a S5b H5a H5b', CTX_NT5)!.tractors, [], '两色级牌相等，不相邻');
});

/* -------------------------------------------------------------------- 甩牌 */

test('甩牌拆成多个单位，并按 拖拉机 > 对子 > 单张 排序', () => {
  const s = shape('H7a H7b H8a H8b HKa HKb H2a')!;
  assert.deepEqual(s.tractors, [2]);
  assert.equal(s.pairs, 1);
  assert.equal(s.singles, 1);
  assert.equal(s.count, 7);
  assert.equal(s.isThrow, true);
  assert.deepEqual(s.units.map((u) => u.kind), ['tractor', 'pair', 'single']);
  assert.equal(primaryUnit(s).kind, 'tractor');
});

test('甩牌的主单位取优先级最高、同级里最大的那个', () => {
  const s = shape('HKa HKb H2a H2b')!; // 两个不相邻的对子
  assert.equal(primaryUnit(s).top, cardOrder(one('HKa'), CTX_S5));
});

test('跨花色组的一手牌不是牌型', () => {
  assert.equal(shape('HAa DAa'), null);
  assert.equal(shape('HAa S5a'), null, '副级牌是主牌，和红桃不同组');
  assert.equal(shape(''), null);
});

/* ------------------------------------------------------------------ 结构相等 */

test('结构相等只看拖拉机长度列表、对子数、单张数', () => {
  assert.ok(shapeEquals(shape('H7a H7b H8a H8b')!, shape('D9a D9b DTa DTb')!));
  assert.ok(!shapeEquals(shape('H7a H7b H8a H8b')!, shape('H7a H7b HKa HKb')!), '拖拉机不等于两个对子');
  assert.ok(!shapeEquals(shape('HAa')!, shape('HAa HAb')!));
  assert.ok(shapeEquals(shape('HAa HKa')!, shape('D2a D7a')!), '两个单张的甩牌结构相同');
});

/* -------------------------------------------------------------------- 枚举 */

test('从手牌里枚举某组的对子、拖拉机与单张', () => {
  const hand = h('H7a H7b H8a H8b H9a HKa D2a S5a');
  assert.deepEqual(ids(allPairs(hand, 'H', CTX_S5).flatMap((u) => u.cards)), ['H7a', 'H7b', 'H8a', 'H8b']);
  const tractors = allTractors(hand, 'H', CTX_S5);
  assert.equal(tractors.length, 1);
  assert.equal(tractors[0].span, 2);
  assert.equal(allSingles(hand, 'H', CTX_S5).length, 6, '红桃每一张都能当单张出');
  assert.equal(allSingles(hand, 'T', CTX_S5).length, 1, '主牌只有那张副级 5');
});

test('长链要能拆出每一段子链，跟牌时才配得上短拖拉机', () => {
  const hand = h('H7a H7b H8a H8b H9a H9b');
  const spans = allTractors(hand, 'H', CTX_S5).map((u) => u.span).sort();
  assert.deepEqual(spans, [2, 2, 3], '三连对里含两条二连对和一条三连对');
});

test('连对链的长度与最高档', () => {
  const runs = runsOf(h('H7a H7b H8a H8b HKa HKb'), CTX_S5);
  assert.deepEqual(runs.map((r) => r.len).sort(), [1, 2]);
  assert.equal(Math.max(...runs.map((r) => r.top)), cardOrder(one('HKa'), CTX_S5));
});
