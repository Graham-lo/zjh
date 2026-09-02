import test from 'node:test';
import assert from 'node:assert/strict';
import { botDeclare, botKou, botLead, isSureMax, suggest, unseenCards } from '../shared/sj/bot.ts';
import { applySjCommand, sjCtx, timeoutKou, type SjRoomState } from '../shared/sj/engine.ts';
import { groupOf, sumPoints } from '../shared/sj/cards.ts';
import { allSingles, parseShape } from '../shared/sj/units.ts';
import { validateFollow } from '../shared/sj/rules.ts';
import { CTX_S5, h, ids, makeSjRoom, mulberry32, runDeclaring } from './sj-helpers.ts';

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
  assert.deepEqual(botDeclare(room, p), ['H5a', 'H5b'], '同花色第二张级牌，强度 1 → 2');
  applySjCommand(room, p.id, { type: 'declare', cardIds: ['H5a', 'H5b'] }, o);
  assert.equal(room.trump.strength, 2);
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

/* ------------------------------------------------------------------- 提示 */

test('提示：首出时给若干候选，绝张排在最前面', () => {
  const view = { trump: { suit: 'S' as const, level: 5 }, trick: [], playedIds: [] };
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
  };
  const hand = h('S6a S6b D3a D4a');
  const out = suggest(view, hand);
  assert.ok(out.some((cards) => ids(cards).join(' ') === 'S6a S6b'), '主牌对子能毙，应该被提示');
});

/* --------------------------------------------------------------- 确定性 */

test('不注入随机源时策略完全确定：同样的局面给同样的答案', () => {
  const { room, o } = dealt(21);
  runDeclaring(room, o);
  timeoutKou(room, o);
  const me = room.players[room.turnSeat!];
  const hand = me.hand;
  assert.deepEqual(ids(botLead(hand, sjCtx(room), room.playedIds)), ids(botLead(hand, sjCtx(room), room.playedIds)));
  assert.deepEqual(allSingles(hand, 'T', sjCtx(room)).length, allSingles(hand, 'T', sjCtx(room)).length);
});
