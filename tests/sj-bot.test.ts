import test from 'node:test';
import assert from 'node:assert/strict';
import {
  botDeclare, botFollow, botKou, botLead, isSureMax, suggest, unseenCards,
  type SjSuggestView,
} from '../shared/sj/bot.ts';
import { applySjCommand, sjCtx, timeoutKou, type SjRoomState } from '../shared/sj/engine.ts';
import { groupOf, sumPoints } from '../shared/sj/cards.ts';
import { allSingles, parseShape } from '../shared/sj/units.ts';
import { SJ_DECL_TIER, validateFollow } from '../shared/sj/rules.ts';
import { CTX_S5, h, ids, makeSjRoom, mulberry32, runDeclaring, runToPlaying } from './sj-helpers.ts';

function dealt(seed = 1) {
  const room = makeSjRoom('sj_510k');
  const o = { rng: mulberry32(seed), now: 1_700_000_000_000 };
  applySjCommand(room, room.hostId, { type: 'start' }, o);
  return { room, o };
}

/** 直接摆一个亮主局面：手牌随便换，只有 declare 会读它 */
function withHand(room: SjRoomState, seat: number, spec: string) {
  room.players[seat].hand = h(spec);
  return room.players[seat];
}

/* ------------------------------------------------------------------- 亮主 */

test('亮主：该花色够 7 张就亮单张，不够就不亮', () => {
  const { room } = dealt();
  const p = withHand(room, 0, 'H5a H6a H7a H8a H9a HTa HJa');
  assert.deepEqual(botDeclare(room, p), ['H5a'], '含级牌与王共 7 张，够了');

  const q = withHand(room, 1, 'H5a H6a H7a H8a H9a HTa');
  assert.equal(botDeclare(room, q), null, '只有 6 张，不亮');

  const r = withHand(room, 2, 'H6a H7a H8a H9a HTa HJa HQa HKa');
  assert.equal(botDeclare(room, r), null, '没有级牌，亮不了');
});

test('亮主：有对级牌且该色够 8 张就亮对', () => {
  const { room } = dealt();
  const p = withHand(room, 0, 'H5a H5b H6a H7a H8a H9a HTa HJa');
  assert.deepEqual(botDeclare(room, p), ['H5a', 'H5b']);

  const q = withHand(room, 1, 'H5a H5b H6a H7a H8a H9a HTa');
  assert.deepEqual(botDeclare(room, q), ['H5a'], '只有 7 张，退回亮单张');
});

test('亮主：对王且主牌够 9 张才反无主', () => {
  const { room } = dealt();
  const p = withHand(room, 0, 'JBa JBb JSa JSb S5a S5b H5a H5b C5a');
  const decl = botDeclare(room, p);
  assert.deepEqual(decl, ['JBa', 'JBb'], '主牌 9 张，用大王对反无主');

  const q = withHand(room, 1, 'JBa JBb S2a S3a S4a S6a S7a');
  assert.equal(botDeclare(room, q), null, '主牌太少，对王也不反');
});

test('亮主：绝不为反而反，只有换成自己的花色主更多时才反', () => {
  const { room, o } = dealt();
  const declarer = withHand(room, 1, 'H5a H6a H7a H8a H9a HTa HJa');
  applySjCommand(room, declarer.id, { type: 'declare', cardIds: ['H5a'] }, o);
  assert.equal(room.trump.suit, 'H');

  // 黑桃 9 张 > 红桃主下的 2 张 → 反
  const eager = withHand(room, 0, 'S5a S5b S2a S3a S4a S6a S7a S8a S9a');
  assert.deepEqual(botDeclare(room, eager), ['S5a', 'S5b']);

  // 同一手牌再加 8 张红桃：跟着红桃打反而更好，就不反了
  const calm = withHand(room, 2, 'S5a S5b S2a S3a S4a S6a S7a S8a S9a H2a H3a H4a H6a H7a H8a H9a HTa');
  assert.equal(botDeclare(room, calm), null);
});

test('亮主：自己已经亮了单张，补第二张就是加固', () => {
  const { room, o } = dealt();
  const p = withHand(room, 0, 'H5a H5b H6a H7a H8a H9a HTa HJa');
  applySjCommand(room, p.id, { type: 'declare', cardIds: ['H5a'] }, o);
  assert.deepEqual(botDeclare(room, p), ['H5a', 'H5b'], '同花色第二张级牌，把单张抬成红桃的对子档');
  applySjCommand(room, p.id, { type: 'declare', cardIds: ['H5a', 'H5b'] }, o);
  assert.equal(room.trump.strength, SJ_DECL_TIER.H);
  assert.equal(botDeclare(room, p), null, '已经是自己的主了，没得再亮');
});

/* ------------------------------------------------------------------- 扣底 */

test('扣底：造缺门，不扣主牌、不扣分牌、不拆对子', () => {
  const { room } = dealt();
  room.trump = { suit: 'S', level: 5, declarerId: null, strength: 0, cardIds: [] };
  const dealer = room.players[0];
  dealer.hand = h(
    // 13 张主牌（黑桃全套 + 主级牌）
    'S2a S3a S4a S5a S6a S7a S8a S9a STa SJa SQa SKa SAa ' +
    // 8 张分牌，成对，不该扣
    'HTa HTb HKa HKb CTa CTb CKa CKb ' +
    // 12 张非分牌散张：梅花 1 张、红桃 2 张最该扣（造缺门），方块 9 张次之
    'C2a H2a H3a D2a D3a D4a D6a D7a D8a D9a DJa DQa',
  );
  assert.equal(dealer.hand.length, 33);

  const buried = botKou(room, dealer);
  assert.equal(buried.length, 8);
  const cards = buried.map((id) => dealer.hand.find((c) => c.id === id)!);
  assert.equal(sumPoints(cards), 0, '不扣分牌');
  assert.equal(cards.filter((c) => groupOf(c, sjCtx(room)) === 'T').length, 0, '不扣主牌');
  for (const id of ['C2a', 'H2a', 'H3a']) {
    assert.ok(buried.includes(id), `${id} 是最短花色的散张，应该先扣掉造缺门`);
  }
});

test('扣底在真实牌局里总能给出恰好 8 张', () => {
  for (let seed = 1; seed <= 8; seed++) {
    const { room, o } = dealt(seed);
    runDeclaring(room, o);
    timeoutKou(room, o);
    assert.equal(room.bottom.length, 8, `seed=${seed}`);
    assert.equal(room.players[room.dealerSeat].hand.length, 25);
  }
});

/* ------------------------------------------------------------------- 首出 */

test('首出：手里有绝张就先打出去', () => {
  const hand = h('JBa D2a D3a');
  assert.deepEqual(ids(botLead(hand, CTX_S5, [])), ['JBa'], '大王没人压得住');
});

test('绝张判定：别人手里还有更大的就不算绝张', () => {
  const hand = h('HKa HKb');
  const unseen = unseenCards(hand, []);
  const pair = { kind: 'pair' as const, span: 1, top: 10, cards: hand };
  assert.equal(isSureMax(pair, 'H', unseen, CTX_S5), false, '红桃 A 还没出现');
  // 把两张红桃 A 都算成已打出，K 对就成了绝张
  assert.equal(isSureMax(pair, 'H', unseenCards(hand, ['HAa', 'HAb']), CTX_S5), true);
});

test('首出：没有绝张时从最长的副牌花色出一张不带分的小牌', () => {
  const hand = h('S2a D2a D3a D4a D6a DTa H9a');
  const lead = botLead(hand, CTX_S5, []);
  assert.equal(lead.length, 1);
  assert.equal(groupOf(lead[0], CTX_S5), 'D', '方块最长');
  assert.equal(lead[0].id, 'D2a', '出最小、不带分的那张');
});

test('首出：主牌够多时先抽主', () => {
  const hand = h('S2a S3a S4a S6a S7a S8a S9a STa SJa D9a DTa');
  const lead = botLead(hand, CTX_S5, []);
  assert.equal(groupOf(lead[0], CTX_S5), 'T', '9 张主牌，先抽主');
});

test('首出：公开信息证明多张副牌都是最大时，会把安全甩牌作为整手候选', () => {
  const view: SjSuggestView = {
    trump: { suit: 'S', level: 5 }, trick: [], playedIds: ['HAb'], mySeat: 0, trickNo: 8,
  };
  const out = suggest(view, h('HAa HKa D2a'));
  assert.deepEqual(ids(out[0]), ['HAa', 'HKa'], '两张都已是该门最大，应优先一次甩掉');
});

test('首出：三家都已公开缺门时，整门副牌会进入甩牌候选', () => {
  const view: SjSuggestView = {
    trump: { suit: 'S', level: 5 }, trick: [], playedIds: [], mySeat: 0, trickNo: 18,
    voidGroups: [[], ['H'], ['H'], ['H']],
  };
  const out = suggest(view, h('H2a H7a HKa D2a'));
  assert.ok(out.some((cards) => ids(cards).sort().join(' ') === 'H2a H7a HKa'));
});

/* ------------------------------------------------------------------- 提示 */

test('提示：首出时给若干候选，绝张排在最前面', () => {
  const view = { trump: { suit: 'S' as const, level: 5 }, trick: [], playedIds: [], mySeat: 0, trickNo: 1 };
  const hand = h('JBa D2a D3a D4a H9a');
  const out = suggest(view, hand);
  assert.ok(out.length > 1, '提示要能循环给出多个候选');
  assert.deepEqual(ids(out[0]), ['JBa']);
  for (const cards of out) assert.ok(cards.length >= 1);
});

test('提示：跟牌时给出的每一个候选都合法', () => {
  const view = {
    trump: { suit: 'S' as const, level: 5 },
    trick: [{ seat: 0, cardIds: ['HAa', 'HAb'] }],
    playedIds: ['HAa', 'HAb'],
    mySeat: 1,
    trickNo: 1,
  };
  const hand = h('H7a H7b H8a H9a S2a D3a');
  const lead = parseShape(h('HAa HAb'), CTX_S5)!;
  const out = suggest(view, hand);
  assert.ok(out.length >= 1);
  for (const cards of out) {
    assert.ok(validateFollow(hand, lead, cards, CTX_S5).ok, `提示了不合法的一手：${ids(cards).join(' ')}`);
  }
  // 有对子必出对子，所以每个候选都得是那一对
  for (const cards of out) assert.deepEqual(ids(cards).sort(), ['H7a', 'H7b']);
});

test('提示：缺门时会把"毙"作为候选给出来', () => {
  const view = {
    trump: { suit: 'S' as const, level: 5 },
    trick: [{ seat: 0, cardIds: ['HAa', 'HAb'] }],
    playedIds: ['HAa', 'HAb'],
    mySeat: 1,
    trickNo: 1,
  };
  const hand = h('S6a S6b D3a D4a');
  const out = suggest(view, hand);
  assert.ok(out.some((cards) => ids(cards).join(' ') === 'S6a S6b'), '主牌对子能毙，应该被提示');
});

/* ------------------------------------------------- 提示的收益排序（跟牌） */

/**
 * 座位 0/2 一队、1/3 一队。下面的用例统一坐 1 号或 2 号，
 * 这样 0 号首出既能当"对手"（我坐 1）也能当"对家"（我坐 2）。
 */
const follow = (
  trick: { seat: number; cardIds: string[] }[], mySeat: number, trickNo = 1,
): SjSuggestView => ({
  trump: { suit: 'S', level: 5 },
  trick,
  playedIds: trick.flatMap((p) => p.cardIds),
  mySeat,
  trickNo,
});

test('提示：对手打出压不过的大牌时，第一条是小牌 —— 绝不把自己的大牌甩出去', () => {
  // 0 号（对手）领出 ♥K，桌上已经有 10 分。我手里没有 ♥A、也不能毙（有 ♥ 必跟 ♥），
  // 压不过就该垫最没用的：♥3。旧实现固定「先给大牌」，会建议把 ♥Q 送掉。
  const out = suggest(follow([{ seat: 0, cardIds: ['HKa'] }], 1), h('H3a H7a HQa'));
  assert.deepEqual(ids(out[0]), ['H3a'], '压不过就出最小的');
  assert.deepEqual(ids(out[out.length - 1]), ['HQa'], '最大的那张排到最后');

  // 没分的一圈同理：不值得为它烧牌
  const noPoints = suggest(follow([{ seat: 0, cardIds: ['HAa'] }], 1), h('H3a H7a HKa'));
  assert.deepEqual(ids(noPoints[0]), ['H3a']);
  assert.deepEqual(ids(noPoints[noPoints.length - 1]), ['HKa'], '♥K 带 10 分，送给对手最亏');
});

test('提示：能赢又值得抢时，第一条是"最小能赢"而不是最大的那张', () => {
  // 0 号领出 ♥10（10 分），我有 ♥Q 和 ♥A 都能赢 —— 用 ♥Q 就够了，♥A 留着
  const out = suggest(follow([{ seat: 0, cardIds: ['HTa'] }], 1), h('H3a H7a HQa HAa'));
  assert.deepEqual(ids(out[0]), ['HQa'], '最小能赢的那一张');
  assert.deepEqual(ids(out[1]), ['HAa'], '其余能赢的排后面');

  // 一圈没分、又还在前半程，就不值得为它花牌
  const idle = suggest(follow([{ seat: 0, cardIds: ['H8a'] }], 1), h('H3a H7a HQa HAa'));
  assert.deepEqual(ids(idle[0]), ['H3a'], '没分就别抢，出最小的');
  // 打到后半程（第 13 圈起）牌越来越硬，能拿就拿
  const late = suggest(follow([{ seat: 0, cardIds: ['H8a'] }], 1, 13), h('H3a H7a HQa HAa'));
  assert.deepEqual(ids(late[0]), ['HQa'], '后半程该抢了，还是用最小能赢的');
});

test('提示：只有末家才把“对家领先”当成赢定，之前不会冒险送分', () => {
  // 0 号是我（2 号）的对家，但 3 号对手还没出；此时先保住 K，不能提前把分喂上桌。
  const risky = suggest(follow([{ seat: 0, cardIds: ['HAa'] }, { seat: 1, cardIds: ['H3a'] }], 2),
    h('H4a H7a HKa'));
  assert.deepEqual(ids(risky[0]), ['H4a'], '后面还有对手时不提前送 K');

  // 我坐 0 号末家，2 号对家已经用 A 锁定这一圈，才把 K 垫给他。
  const give = suggest(follow([
    { seat: 1, cardIds: ['H3a'] }, { seat: 2, cardIds: ['HAa'] }, { seat: 3, cardIds: ['H4a'] },
  ], 0), h('H6a H7a HKa'));
  assert.deepEqual(ids(give[0]), ['HKa'], '♥K 带 10 分，垫给对家');

  // 末家时对家当前是 ♥10，我的 ♥K 能盖过他 —— 盖了分照样是自家的，但白烧一张大牌，
  // 所以第一条必须是"不盖过对家"的那手，♥K 排到最后
  const dont = suggest(follow([
    { seat: 1, cardIds: ['H3a'] }, { seat: 2, cardIds: ['HTa'] }, { seat: 3, cardIds: ['H4a'] },
  ], 0), h('H6a HKa'));
  assert.deepEqual(ids(dont[0]), ['H6a'], '不盖对家');
  assert.deepEqual(ids(dont[dont.length - 1]), ['HKa']);
});

test('提示：缺门时该不该毙，看这一圈有没有分', () => {
  // ♥ 缺门。有分 → 用最小的主牌毙下来
  const beat = suggest(follow([{ seat: 0, cardIds: ['HTa'] }], 1), h('S3a S8a D2a DKa'));
  assert.deepEqual(ids(beat[0]), ['S3a'], '最小能毙的主牌');
  // 没分 → 别拆主，垫掉最没用的杂牌
  const idle = suggest(follow([{ seat: 0, cardIds: ['H8a'] }], 1), h('S3a S8a D2a DKa'));
  assert.deepEqual(ids(idle[0]), ['D2a'], '没分不值得拆主，垫最小的杂牌');
  // 垫牌的尺子是「拆主 > 送分 > 大牌」：♦K 送 10 分虽然亏，但还没有拆一张主牌亏
  const at = (id: string) => idle.findIndex((c) => ids(c)[0] === id);
  assert.ok(at('DKa') < at('S3a'), '主牌排在所有杂牌后面');
});

test('提示：对子也按同一把尺子排 —— 最小能赢的那一对在前', () => {
  const win = suggest(follow([{ seat: 0, cardIds: ['HTa', 'HTb'] }], 1),
    h('H3a H3b HJa HJb HAa HAb'));
  assert.deepEqual(ids(win[0]).sort(), ['HJa', 'HJb'], '最小能赢的一对');

  const lose = suggest(follow([{ seat: 0, cardIds: ['HKa', 'HKb'] }], 1),
    h('H3a H3b H7a H7b HQa HQb'));
  assert.deepEqual(ids(lose[0]).sort(), ['H3a', 'H3b'], '压不过就垫最小的一对');
});

test('提示：拖拉机枚举全部同长度候选，选择最小能赢的一条', () => {
  const leadIds = ['H7a', 'H7b', 'H8a', 'H8b'];
  const out = suggest(follow([{ seat: 0, cardIds: leadIds }], 1),
    h('H9a H9b HTa HTb HJa HJb HQa HQb'));
  assert.deepEqual(ids(out[0]).sort(), ['H9a', 'H9b', 'HTa', 'HTb']);
});

test('机器人和提示是同一个脑子：botFollow 就是提示的第一条', () => {
  const view = follow([{ seat: 0, cardIds: ['HTa'] }], 1);
  const hand = h('H3a H7a HQa HAa');
  const lead = parseShape(h('HTa'), CTX_S5)!;
  const played = [{ seat: 0, cards: h('HTa') }];
  assert.deepEqual(
    ids(botFollow(hand, lead, CTX_S5, played, 1, 1)),
    ids(suggest(view, hand)[0]),
  );
});

/* --------------------------------------------------------------- 确定性 */

test('不注入随机源时策略完全确定：同样的局面给同样的答案', () => {
  const { room, o } = dealt(21);
  runToPlaying(room, o);
  const me = room.players[room.turnSeat!];
  const hand = me.hand;
  assert.deepEqual(ids(botLead(hand, sjCtx(room), room.playedIds)), ids(botLead(hand, sjCtx(room), room.playedIds)));
  assert.deepEqual(allSingles(hand, 'T', sjCtx(room)).length, allSingles(hand, 'T', sjCtx(room)).length);
});
