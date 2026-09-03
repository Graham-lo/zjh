/**
 * 「被迫补齐」的判据（`shared/sj/complete.ts`）。
 *
 * 这条判据是选牌交互的地基：单击一张牌只动这一张，唯一的例外是**规则根本不允许
 * 它单独出现**。判据定死成「所有包含 must 的合法出法的交集，减去 must 本身」，
 * 所以这里每条用例问的都是同一个问题 —— 除了用户点的那张，还有哪张是他躲不开的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPLETE_CAP, forcedCompletion, legalFollowsContaining } from '../shared/sj/complete.ts';
import { parseShape } from '../shared/sj/units.ts';
import { validateFollow } from '../shared/sj/rules.ts';
import { CTX_S5, h } from './sj-helpers.ts';

/** `forced('H7a H7b HKa', 'H7a', 'H8a H8b')` → 点 H7a 之后被补上的牌 id */
function forced(handSpec: string, mustSpec: string, leadSpec: string | null): string[] | null {
  const hand = h(handSpec);
  const lead = leadSpec ? parseShape(h(leadSpec), CTX_S5) : null;
  if (leadSpec) assert.ok(lead, `首出 ${leadSpec} 解析不出牌型，用例本身写错了`);
  const must = mustSpec ? h(mustSpec) : [];
  const out = forcedCompletion(hand, must, lead, CTX_S5);
  return out && out.map((c) => c.id).sort();
}

/* ------------------------------------------------- 规则强迫时才补 */

test('首出对子、我该门只有一个对子：点对子里的一张，另一张被补上', () => {
  // 有对必出对 —— 想把 H7a 单独打出去在规则上根本不存在，补齐不是替他做决定
  assert.deepEqual(forced('H7a H7b H9a HKa D2a', 'H7a', 'H8a H8b'), ['H7b']);
});

test('首出对子、我该门只有一个对子：点单张 → 补不出合法的一手，返回 null', () => {
  // H9a 进不了任何一手合法跟牌（那一对必须整对出），交集无从谈起。
  // 调用方据此只加用户点的那一张，出牌按钮下方照常显示不合法的原因。
  assert.equal(forced('H7a H7b H9a HKa D2a', 'H9a', 'H8a H8b'), null);
});

test('首出对子、我该门有两个对子：点任一张只补它的另一半，不会扩到第二对', () => {
  // 唯一判据就是交集（SPEC A.3 已按这条裁定改正）：两种合法出法是 {77} 和 {99}，
  // 但一旦点了 H7a，包含 H7a 的就只剩 {H7a,H7b} 一种 —— H7b 躲不开，所以补上。
  // 关键是**没有**扩成整手智能选牌：第二对一张都没碰，补上的这张也能单击放下。
  assert.deepEqual(forced('H7a H7b H9a H9b D2a', 'H7a', 'H8a H8b'), ['H7b']);
});

test('首出 3 张、我该门只剩 2 张：补上另一张该门牌，第三张垫什么不管', () => {
  // 有 G 必跟 G：两张红桃一张都留不住；第三张垫哪个是用户的事，交集里不会有它
  assert.deepEqual(forced('H7a H9a S6a S8a D2a', 'H7a', 'HAa HKa HQa'), ['H9a']);
});

test('首出单张、我该门无牌：点任意牌都不补', () => {
  assert.deepEqual(forced('S6a S8a D2a D3a', 'S6a', 'HAa'), []);
});

test('首出对子、我该门无牌：点任意牌都不补（垫两张随便垫）', () => {
  assert.deepEqual(forced('S6a S8a D2a D3a', 'S6a', 'HAa HAb'), []);
});

test('首出二连对、我有三连对：只补它的另一半，绝不扩成整条拖拉机', () => {
  // 拆法不唯一：{77,88} 和 {88,99} 都合法。但两种拆法都带着 H8b，交集因此是 {H8a,H8b}
  // （SPEC A.3 已按交集裁定改正这条例子）。效果正是铁律要的：**不会**把整条三连对
  // 扫进来，只留下躲不开的那一张。点 HAa 那种整条被迫的情形才会补齐 AAKK。
  assert.deepEqual(forced('H7a H7b H8a H8b H9a H9b HKa', 'H8a', 'HTa HTb HJa HJb'), ['H8b']);
});

test('首出（lead 为 null）永远不补：单张总是合法的，规则从不强迫', () => {
  assert.deepEqual(forced('H7a H7b H8a H8b', 'H7a', null), []);
});

test('整手都被迫时，空 must 也能算出完整的一手（自动预选就靠这个）', () => {
  assert.deepEqual(forced('H7a H7b HKa D2a', '', 'H8a H8b'), ['H7a', 'H7b']);
});

test('must 不在手牌里 / 比该跟的张数还多：不硬撑，返回 null', () => {
  assert.equal(forced('H7a H7b HKa', 'H9a', 'H8a H8b'), null);
  assert.equal(forced('H7a H7b HKa', 'H7a H7b HKa', 'H8a H8b'), null);
});

/* ------------------------------------------------- 合法出法枚举 */

test('legalFollowsContaining 给出的每一手都真的合法，而且都含 must', () => {
  const hand = h('H7a H9a HTa HJa HKa S6a D2a');
  const lead = parseShape(h('HAa HKb HQa'), CTX_S5)!;
  const list = legalFollowsContaining(hand, h('H7a'), lead, CTX_S5);
  assert.ok(list.length > 1, '这个局面本来就有多种垫法，枚举不该只剩一种');
  for (const play of list) {
    assert.equal(play.length, 3);
    assert.ok(play.some((c) => c.id === 'H7a'), '枚举出的一手竟然不含 must');
    assert.ok(validateFollow(hand, lead, play, CTX_S5).ok, `${play.map((c) => c.id)} 不合法`);
  }
});

test('legalFollowsContaining 按牌面去重：♥7a ♥7b 换个顺序不是另一种打法', () => {
  const hand = h('H7a H7b H8a H8b HKa');
  const lead = parseShape(h('HAa HAb'), CTX_S5)!;
  const list = legalFollowsContaining(hand, [], lead, CTX_S5);
  // 合法的只有 {77} 和 {88} 两对
  assert.equal(list.length, 2);
});

test('首出时 legalFollowsContaining 返回空：没有"必须跟"这回事', () => {
  assert.deepEqual(legalFollowsContaining(h('H7a H7b'), [], null, CTX_S5), []);
});

/* ------------------------------------------------- cap：宁可不补，不可卡顿 */

// `npm test` 是多文件并行跑的，整机满载时同一段代码会慢上四五倍，
// 所以墙钟只当"有没有跑飞"的粗筛（无 cap 的全枚举是 C(20,8)=125970 手，量级差着几十倍），
// cap 真的在数校验次数由下一条用例证明。
test('cap 生效：该门 20 张、首出甩 8 张，撞上 cap 就放弃补齐', () => {
  const hand = h('H2a H2b H3a H3b H4a H4b H6a H6b H7a H7b H8a H8b H9a H9b HTa HTb HJa HJb HQa HQb S6a S7a');
  const lead = parseShape(h('HAa HAb HKa HKb HQa H9a H8a H7a'), CTX_S5)!;
  assert.equal(lead.count, 8);

  const t0 = performance.now();
  const out = forcedCompletion(hand, [], lead, CTX_S5);
  const ms = performance.now() - t0;
  // 撞上 cap 就放弃补齐 —— 什么都不补永远是安全的默认
  assert.deepEqual(out, []);
  assert.ok(ms < 500, `补齐花了 ${ms.toFixed(1)}ms，选牌会卡`);
});

test('cap 是真的在数校验次数：把它调到 1 就立刻放弃', () => {
  // 同一个局面在默认 cap 下补得出 H7b，cap=1 时枚举不完，只能返回 []
  const hand = h('H7a H7b H9a HKa D2a');
  const lead = parseShape(h('H8a H8b'), CTX_S5)!;
  assert.deepEqual(forcedCompletion(hand, h('H7a'), lead, CTX_S5, COMPLETE_CAP)!.map((c) => c.id), ['H7b']);
  assert.deepEqual(forcedCompletion(hand, h('H7a'), lead, CTX_S5, 1), []);
});
