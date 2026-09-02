import test from 'node:test';
import assert from 'node:assert/strict';
import { parseShape } from '../shared/sj/units.ts';
import {
  digMultiplier, digMultiplierForLead, followRequirement, isMatchWon, isTopLevel, levelUp,
  nextDealerSeat, outcomeFor, trickPoints, trickWinner, validateFollow, validateLead, validateThrow,
} from '../shared/sj/rules.ts';
import { ladderOf } from '../shared/games.ts';
import type { SjCtx } from '../shared/sj/cards.ts';
import { CTX_NT5, CTX_S5, h } from './sj-helpers.ts';

const shape = (spec: string, ctx: SjCtx = CTX_S5) => parseShape(h(spec), ctx)!;

/* ------------------------------------------------------------------- 首出 */

test('首出必须来自同一个花色组', () => {
  assert.ok(validateLead(h('HAa HKa'), CTX_S5).ok);
  assert.ok(validateLead(h('SAa H5a JBa'), CTX_S5).ok, '主花色、副级牌、王都是主牌组');
  assert.ok(!validateLead(h('HAa DAa'), CTX_S5).ok);
  assert.ok(!validateLead([], CTX_S5).ok);
});

/* ------------------------------------------------------------------- 跟牌 */

interface FollowCase {
  name: string;
  hand: string;
  lead: string;
  play: string;
  ok: boolean;
  ctx?: SjCtx;
}

/** DESIGN 5.1 要求跟牌合法性 ≥ 30 个用例 */
const FOLLOW_CASES: FollowCase[] = [
  // ---- 1. 有 G 必跟 G
  { name: '有红桃就得跟红桃', hand: 'H7a H8a D2a', lead: 'HAa', play: 'H7a', ok: true },
  { name: '有红桃却垫方块', hand: 'H7a H8a D2a', lead: 'HAa', play: 'D2a', ok: false },
  { name: '缺门可以垫', hand: 'D2a D3a', lead: 'HAa', play: 'D2a', ok: true },
  { name: '缺门可以毙', hand: 'S6a D2a', lead: 'HAa', play: 'S6a', ok: true },
  { name: '张数必须一致（多出一张）', hand: 'H7a H8a', lead: 'HAa', play: 'H7a H8a', ok: false },
  { name: '张数必须一致（少一张）', hand: 'H7a H8a', lead: 'HAa HAb', play: 'H7a', ok: false },
  { name: '红桃恰好够就必须全出', hand: 'H7a H8a D2a D3a', lead: 'HAa HKa', play: 'H7a H8a', ok: true },
  { name: '红桃够却掺方块', hand: 'H7a H8a D2a D3a', lead: 'HAa HKa', play: 'H7a D2a', ok: false },

  // ---- 2a. 有对必出对
  { name: '有对子必须出对子', hand: 'H7a H7b H8a', lead: 'HAa HAb', play: 'H7a H7b', ok: true },
  { name: '有对子却拆开', hand: 'H7a H7b H8a', lead: 'HAa HAb', play: 'H7a H8a', ok: false },
  { name: '没有对子就随便出两张', hand: 'H7a H8a HKa', lead: 'HAa HAb', play: 'H7a H8a', ok: true },
  { name: '红桃不足时全出红桃再垫', hand: 'H7a D2a D3a', lead: 'HAa HAb', play: 'H7a D2a', ok: true },
  { name: '红桃不足却把红桃留着', hand: 'H7a D2a D3a', lead: 'HAa HAb', play: 'D2a D3a', ok: false },
  { name: '缺门用主牌对子毙', hand: 'S6a S6b D2a', lead: 'HAa HAb', play: 'S6a S6b', ok: true },
  { name: '缺门垫两张杂牌', hand: 'D2a C3a', lead: 'HAa HAb', play: 'D2a C3a', ok: true },

  // ---- 2b. 拖拉机优先
  { name: '有拖拉机必须跟拖拉机', hand: 'H9a H9b HTa HTb H2a', lead: 'H7a H7b H8a H8b', play: 'H9a H9b HTa HTb', ok: true },
  { name: '有拖拉机却只出一个对子', hand: 'H9a H9b HTa HTb H2a', lead: 'H7a H7b H8a H8b', play: 'H9a H9b HTa H2a', ok: false },
  { name: '没有拖拉机就退化成两个对子', hand: 'H7a H7b HKa HKb H2a', lead: 'H9a H9b HTa HTb', play: 'H7a H7b HKa HKb', ok: true },
  { name: '有两个对子却只出一个', hand: 'H7a H7b HKa HKb H2a', lead: 'H9a H9b HTa HTb', play: 'H7a H7b HKa H2a', ok: false },
  { name: '只有一个对子时出一个就够', hand: 'H7a H7b H2a H3a H4a', lead: 'H9a H9b HTa HTb', play: 'H7a H7b H2a H3a', ok: true },
  { name: '只有一个对子却把它拆了', hand: 'H7a H7b H2a H3a H4a', lead: 'H9a H9b HTa HTb', play: 'H2a H3a H4a H7a', ok: false },
  { name: '长链要拆出同长度的拖拉机', hand: 'H7a H7b H8a H8b H9a H9b', lead: 'HKa HKb HAa HAb', play: 'H7a H7b H8a H8b', ok: true },
  { name: '长链拆成两个不相邻的对子不行', hand: 'H7a H7b H8a H8b H9a H9b', lead: 'HKa HKb HAa HAb', play: 'H7a H7b H9a H9b', ok: false },
  { name: '三连对要跟三连对', hand: 'H6a H6b H7a H7b H8a H8b H9a H9b', lead: 'HTa HTb HJa HJb HQa HQb', play: 'H6a H6b H7a H7b H8a H8b', ok: true },
  { name: '三连对跟成两连对加一对不行', hand: 'H6a H6b H7a H7b H8a H8b H9a H9b', lead: 'HTa HTb HJa HJb HQa HQb', play: 'H6a H6b H7a H7b H9a H9b', ok: false },
  { name: '红桃不足四张时拖拉机也不强求', hand: 'H7a H7b H9a D2a', lead: 'HTa HTb HJa HJb', play: 'H7a H7b H9a D2a', ok: true },

  // ---- 3. 主牌组
  { name: '首出主牌时有主必跟主', hand: 'S6a S7a H2a', lead: 'SAa', play: 'S6a', ok: true },
  { name: '首出主牌却垫副牌', hand: 'S6a S7a H2a', lead: 'SAa', play: 'H2a', ok: false },
  { name: '副级牌算主牌，必须跟', hand: 'H5a D2a', lead: 'SAa', play: 'H5a', ok: true },
  { name: '手里只有副级牌时不能垫别的', hand: 'H5a D2a', lead: 'SAa', play: 'D2a', ok: false },
  { name: '王也算主牌', hand: 'JSa D2a', lead: 'SAa', play: 'D2a', ok: false },
  { name: '主牌缺门才能垫', hand: 'D2a C3a', lead: 'SAa', play: 'D2a', ok: true },

  // ---- 4. 甩牌的跟法
  { name: '跟甩牌：两个单张槽随便填', hand: 'H7a H8a D2a', lead: 'HAa HKa', play: 'H7a H8a', ok: true },
  { name: '跟甩牌：对子填单张槽也行', hand: 'H7a H7b D2a', lead: 'HAa HKa', play: 'H7a H7b', ok: true },
  { name: '跟"对子+单张"要出对子', hand: 'H7a H7b H8a H9a', lead: 'HKa HKb H2a', play: 'H7a H7b H8a', ok: true },
  { name: '跟"对子+单张"拆了对子不行', hand: 'H7a H7b H8a H9a', lead: 'HKa HKb H2a', play: 'H7a H8a H9a', ok: false },
  { name: '缺门时整条主拖拉机毙', hand: 'S6a S6b S7a S7b', lead: 'H7a H7b H8a H8b', play: 'S6a S6b S7a S7b', ok: true },
  { name: '缺门时乱垫四张也合法', hand: 'D2a D3a C4a C6a', lead: 'H7a H7b H8a H8b', play: 'D2a D3a C4a C6a', ok: true },

  // ---- 5. 无主局面
  { name: '无主：级牌是主，有主必跟', hand: 'H5a D2a', lead: 'S5a', play: 'H5a', ok: true, ctx: CTX_NT5 },
  { name: '无主：有级牌却垫方块', hand: 'H5a D2a', lead: 'S5a', play: 'D2a', ok: false, ctx: CTX_NT5 },
  { name: '无主：黑桃 A 是副牌，跟黑桃', hand: 'SAa S2a D2a', lead: 'SKa', play: 'SAa', ok: true, ctx: CTX_NT5 },
];

test('跟牌合法性（DESIGN 1.6）', () => {
  assert.ok(FOLLOW_CASES.length >= 30, `跟牌用例要 ≥ 30 个，现在 ${FOLLOW_CASES.length} 个`);
  for (const c of FOLLOW_CASES) {
    const ctx = c.ctx ?? CTX_S5;
    const r = validateFollow(h(c.hand), shape(c.lead, ctx), h(c.play), ctx);
    assert.equal(r.ok, c.ok, `${c.name}：期望 ${c.ok ? '合法' : '不合法'}，实际 ${r.ok ? '合法' : `不合法（${r.reason}）`}`);
    if (!r.ok) assert.ok(r.reason.length > 0, `${c.name}：不合法时要给出原因`);
  }
});

test('结构要求会随手牌降级：配不上的拖拉机变成对子槽位', () => {
  const lead = shape('HTa HTb HJa HJb');
  assert.deepEqual(followRequirement(h('H9a H9b HKa HKb'), lead, CTX_S5), { tractors: [], pairs: 2 });
  assert.deepEqual(followRequirement(h('H9a H9b HTa HTb'), lead, CTX_S5), { tractors: [2], pairs: 0 });
  assert.deepEqual(followRequirement(h('H9a H9b H2a H3a'), lead, CTX_S5), { tractors: [], pairs: 1 });
  assert.deepEqual(followRequirement(h('H9a H8a H2a H3a'), lead, CTX_S5), { tractors: [], pairs: 0 });
});

/* ------------------------------------------------------------------- 甩牌 */

test('甩牌成功：每个单位都压得住其他三家', () => {
  const s = shape('HAa HKa');
  assert.equal(validateThrow(s, [h('H2a H3a'), h('H4a'), h('D2a')], CTX_S5), null);
});

test('甩牌：同大的牌管不上，严格更大才会打回', () => {
  const s = shape('HAa HKa HKb');
  assert.equal(validateThrow(s, [h('HAb'), h('H4a'), h('D2a')], CTX_S5), null);
});

test('甩牌失败：对子被别人的大对子压住', () => {
  const s = shape('H7a H7b H2a');
  const bad = validateThrow(s, [h('HKa HKb'), h('D2a'), h('D3a')], CTX_S5);
  assert.ok(bad);
  assert.deepEqual(bad.forced.cards.map((c) => c.id), ['H7a', 'H7b'], '只有对子被管上，就强制出该对子');
});

test('甩牌失败：n 连对被别人更长的连对压住', () => {
  const s = shape('H7a H7b H8a H8b HAa');
  const bad = validateThrow(s, [h('H9a H9b HTa HTb HJa HJb'), h('D2a'), h('D3a')], CTX_S5);
  assert.ok(bad);
  assert.equal(bad.forced.kind, 'tractor');
  // 别人的连对更短、单张也更小，就压不住这一甩
  assert.equal(validateThrow(shape('HAa HAb HKa HKb HQa'), [h('H9a H9b'), h('H8a'), h('D2a')], CTX_S5), null);
});

test('甩牌失败：单张和对子都能被管时，按 QQ 牌型优先强制出对子', () => {
  const bad = validateThrow(
    shape('H7a H7b H2a'),
    [h('HKa HKb H3a'), h('D2a'), h('D3a')],
    CTX_S5,
  );
  assert.ok(bad);
  assert.equal(bad.forced.kind, 'pair');
  assert.deepEqual(bad.forced.cards.map((c) => c.id), ['H7a', 'H7b']);
});

test('甩牌失败：单张、对子和拖拉机都能被管时，按 QQ 牌型优先强制出拖拉机', () => {
  const bad = validateThrow(
    shape('H7a H7b H8a H8b H2a'),
    [h('H9a H9b HTa HTb H3a'), h('D2a'), h('D3a')],
    CTX_S5,
  );
  assert.ok(bad);
  assert.equal(bad.forced.kind, 'tractor');
  assert.equal(bad.forced.span, 2);
});

/* ------------------------------------------------------------------- 定圈 */

interface TrickCase {
  name: string;
  plays: string[];
  winner: number;
  ctx?: SjCtx;
}

/** DESIGN 5.1 要求定圈 ≥ 20 个用例。plays[i] 是 i 号座位出的牌，plays[0] 是首出 */
const TRICK_CASES: TrickCase[] = [
  { name: '同花色单张比点数', plays: ['H7a', 'H9a', 'H3a', 'H2a'], winner: 1 },
  { name: '垫别的花色不参与比大小', plays: ['H7a', 'DAa', 'H3a', 'H2a'], winner: 0 },
  { name: '主牌毙副牌', plays: ['H7a', 'S6a', 'H3a', 'H2a'], winner: 1 },
  { name: '两家都毙，大的赢', plays: ['H7a', 'S6a', 'S9a', 'H2a'], winner: 2 },
  { name: '两副同牌相等，先出者赢', plays: ['HAa', 'HAb', 'H3a', 'H2a'], winner: 0 },
  { name: '三色副级牌相等，先出者赢', plays: ['H5a', 'C5a', 'S2a', 'S3a'], winner: 0 },
  { name: '主级牌大过副级牌', plays: ['H5a', 'S5a', 'S2a', 'S3a'], winner: 1 },
  { name: '副级牌大过主花色 A', plays: ['SAa', 'H5a', 'S2a', 'S3a'], winner: 1 },
  { name: '小王大过主级牌', plays: ['S5a', 'JSa', 'S2a', 'S3a'], winner: 1 },
  { name: '大王最大', plays: ['S2a', 'JSa', 'JBa', 'S3a'], winner: 2 },
  { name: '首出是主时副牌不参与', plays: ['S6a', 'HAa', 'DAa', 'CAa'], winner: 0 },
  { name: '首出是主时更大的主赢', plays: ['S6a', 'S9a', 'H5a', 'S2a'], winner: 2 },
  { name: '一样大的毙，先毙的赢', plays: ['H7a', 'S6a', 'S6b', 'H2a'], winner: 1 },
  { name: '对子毙对子', plays: ['H7a H7b', 'S6a S6b', 'H3a H4a', 'H2a HKa'], winner: 1 },
  { name: '两张主牌凑不成对子就不算毙', plays: ['H7a H7b', 'S6a S8a', 'HKa HKb', 'H2a H4a'], winner: 2 },
  { name: '大对子赢小对子', plays: ['H7a H7b', 'H3a H3b', 'HKa HKb', 'H2a H4a'], winner: 2 },
  { name: '拖拉机毙拖拉机', plays: ['H7a H7b H8a H8b', 'S2a S2b S3a S3b', 'H9a H9b HTa HTb', 'HJa HJb HQa HQb'], winner: 1 },
  { name: '两个对子不等于拖拉机', plays: ['H7a H7b H8a H8b', 'HKa HKb H2a H2b', 'H3a H3b H4a H6a', 'H9a HTa HJa HQa'], winner: 0 },
  { name: '更大的拖拉机赢', plays: ['H7a H7b H8a H8b', 'H9a H9b HTa HTb', 'H2a H2b H3a H3b', 'HJa HQa HKa HAa'], winner: 1 },
  { name: '甩牌比最高优先单位：大对子赢', plays: ['HKa HKb H2a', 'HAa HAb H3a', 'H4a H4b H6a', 'H7a H8a H9a'], winner: 1 },
  { name: '甩牌里拖拉机说了算', plays: ['H7a H7b H8a H8b HKa', 'H9a H9b HTa HTb H2a', 'H3a H3b H4a H4b HAa', 'H6a HJa HQa CAa DAa'], winner: 1 },
  { name: '甩牌结构不一致的跟法不参与', plays: ['HKa HKb H2a', 'HAa HAb HQa HJa', 'H4a H6a H7a', 'H8a H9a HTa'], winner: 0 },
  { name: '散牌甩可被主牌对子带单毙', plays: ['HAa HKa HQa', 'S9a S9b S2a', 'H3a H4a H6a', 'H7a H8a HJa'], winner: 1 },
  { name: '盖毙先比最大牌型：拖拉机大过对子', plays: ['HAa HKa HQa HJa', 'S9a S9b S2a S3a', 'S6a S6b S7a S7b', 'H2a H3a H4a H6a'], winner: 2 },
  { name: '分牌只是分，不影响谁赢', plays: ['H7a', 'HKa', 'HTa', 'H5b'], winner: 1, ctx: { trump: 'S', level: 2 } },
  { name: '无主时级牌毙副牌', plays: ['SAa', 'D5a', 'S2a', 'S3a'], winner: 1, ctx: CTX_NT5 },
  { name: '无主时小王大过级牌', plays: ['S5a', 'JSa', 'S2a', 'S3a'], winner: 1, ctx: CTX_NT5 },
];

test('定圈（DESIGN 1.7）', () => {
  assert.ok(TRICK_CASES.length >= 20, `定圈用例要 ≥ 20 个，现在 ${TRICK_CASES.length} 个`);
  for (const c of TRICK_CASES) {
    const ctx = c.ctx ?? CTX_S5;
    const plays = c.plays.map((spec, seat) => ({ seat, cards: h(spec) }));
    assert.equal(trickWinner(plays, ctx).seat, c.winner, c.name);
  }
});

test('一圈的分数是四家出牌里所有分牌之和', () => {
  const plays = [
    { seat: 0, cards: h('H7a') }, { seat: 1, cards: h('HKa') },
    { seat: 2, cards: h('HTa') }, { seat: 3, cards: h('H5b') },
  ];
  assert.equal(trickPoints(plays), 25);
});

/* ------------------------------------------------------------------- 抠底 */

test('抠底倍数是 2^n，上限 ×64', () => {
  assert.equal(digMultiplier(1), 2, '单张 ×2');
  assert.equal(digMultiplier(2), 4, '对子 ×4');
  assert.equal(digMultiplier(4), 16, '两连对 ×16');
  assert.equal(digMultiplier(6), 64);
  assert.equal(digMultiplier(8), 64, '再多也封在 ×64');
  assert.equal(digMultiplier(25), 64);
});

test('QQ 甩牌抠底按最大牌型定番，不按甩牌总张数', () => {
  assert.equal(digMultiplierForLead(h('HAa HKa HQa'), CTX_S5), 2, '多张散牌仍是单抠');
  assert.equal(digMultiplierForLead(h('HAa HKa HKb H2a'), CTX_S5), 4, '含对子按双抠');
  assert.equal(digMultiplierForLead(h('H9a H9b HTa HTb HKa'), CTX_S5), 16, '两连对按四张翻 16 倍');
});

/* ------------------------------------------------------------------- 升级表 */

test('升级表覆盖每一个区间（DESIGN 1.8）', () => {
  const rows: [number, boolean, number, string][] = [
    [-10, false, 4, '倒扣'],
    [0, false, 3, '大光'],
    [5, false, 2, '小光'],
    [35, false, 2, '小光'],
    [40, false, 1, '庄家升一级'],
    [75, false, 1, '庄家升一级'],
    [80, true, 0, '闲家上台'],
    [115, true, 0, '闲家上台'],
    [120, true, 1, '上台 · 升一级'],
    [155, true, 1, '上台 · 升一级'],
    [160, true, 2, '上台 · 升两级'],
    [195, true, 2, '上台 · 升两级'],
    [200, true, 3, '上台 · 升三级'],
    [260, true, 3, '上台 · 升三级'],
  ];
  for (const [s, defendersWin, up, label] of rows) {
    const o = outcomeFor(s);
    assert.equal(o.defendersWin, defendersWin, `${s} 分：闲家是否上台`);
    assert.equal(o.up, up, `${s} 分：升几级`);
    assert.equal(o.label, label, `${s} 分：结果名`);
  }
  // 规范表在 0 < s < 5 上有个洞（现实中到不了），这里并进小光那一档，保证是个全函数
  assert.deepEqual(outcomeFor(3), outcomeFor(5));
});

/* --------------------------------------------------------- 庄家轮转与通关 */

test('庄家轮转：守住给对家，被打下给下家', () => {
  assert.equal(nextDealerSeat(0, false), 2, '守住 → 对家坐庄');
  assert.equal(nextDealerSeat(0, true), 1, '被打下 → 下家坐庄');
  assert.equal(nextDealerSeat(3, false), 1);
  assert.equal(nextDealerSeat(3, true), 0);
  for (let seat = 0; seat < 4; seat++) {
    assert.equal(nextDealerSeat(seat, false) % 2, seat % 2, '守住是自家人接着坐庄');
    assert.notEqual(nextDealerSeat(seat, true) % 2, seat % 2, '被打下一定换阵营');
  }
});

test('升级夹到阶梯顶，不能越过顶级', () => {
  const ladder = ladderOf('sj_510k'); // 5 → 10 → K
  assert.equal(levelUp(ladder, 5, 1), 10);
  assert.equal(levelUp(ladder, 5, 2), 13);
  assert.equal(levelUp(ladder, 5, 4), 13, '升 4 级也只到 K');
  assert.equal(levelUp(ladder, 13, 1), 13);
  assert.equal(levelUp(ladder, 10, 0), 10, '上台不升级时原地不动');
  assert.ok(isTopLevel(ladder, 13));
  assert.ok(!isTopLevel(ladder, 10));
  const full = ladderOf('sj_2a');
  assert.equal(full.length, 13);
  assert.equal(levelUp(full, 2, 3), 5);
  assert.equal(levelUp(full, 13, 3), 14);
});

test('通关：顶级的队坐庄守住才算赢，靠这一局升到顶不算', () => {
  assert.ok(isMatchWon('sj_510k', 13, outcomeFor(0)), '打 K 坐庄大光 → 通关');
  assert.ok(isMatchWon('sj_510k', 13, outcomeFor(75)), '打 K 坐庄守住 → 通关');
  assert.ok(!isMatchWon('sj_510k', 13, outcomeFor(80)), '打 K 被打下 → 留在顶级、丢庄');
  assert.ok(!isMatchWon('sj_510k', 10, outcomeFor(0)), '打 10 大光只是升到 K，还没通关');
  assert.ok(!isMatchWon('sj_2a', 13, outcomeFor(0)), '打通关的顶级是 A，不是 K');
  assert.ok(isMatchWon('sj_2a', 14, outcomeFor(0)));
});
