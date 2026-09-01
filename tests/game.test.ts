import test from 'node:test';
import assert from 'node:assert/strict';
import { compareCost, compareHands, createHumanPlayer, createInitialRoom, evaluateHand, startRound, applyCommand, type Card } from '../lib/game.ts';

const c = (rank: number, suit: Card['suit']): Card => ({ rank, suit });

test('hand ranking: straight flush beats flush, flush beats straight', () => {
  assert.equal(compareHands([c(10,'H'),c(11,'H'),c(12,'H')],[c(14,'S'),c(9,'S'),c(4,'S')]), 1);
  assert.equal(compareHands([c(14,'S'),c(9,'S'),c(4,'S')],[c(10,'H'),c(11,'D'),c(12,'C')]), 1);
});

test('A23 is the lowest straight', () => {
  const a23 = evaluateHand([c(14,'S'),c(2,'D'),c(3,'C')]);
  const qka = evaluateHand([c(12,'S'),c(13,'D'),c(14,'C')]);
  assert.equal(a23.name, '顺子'); assert.deepEqual(a23.tiebreak, [3]); assert.equal(qka.tiebreak[0], 14);
  assert.equal(compareHands([c(14,'S'),c(2,'D'),c(3,'C')],[c(2,'S'),c(3,'D'),c(4,'C')]), -1);
});

test('special 235 beats trips but loses to ordinary high card', () => {
  const sp = [c(2,'S'),c(3,'H'),c(5,'D')];
  const aaa = [c(14,'S'),c(14,'H'),c(14,'D')];
  const high = [c(14,'S'),c(9,'H'),c(7,'D')];
  assert.equal(compareHands(sp, aaa, true), 1);
  assert.equal(compareHands(sp, high, true), -1);
});

test('round start deals unique cards, takes antes, and chooses a turn', () => {
  const p1 = createHumanPlayer('甲', 0, 'x'); const p2 = createHumanPlayer('乙', 1, 'y');
  p1.ready = p2.ready = true; const room = createInitialRoom('123456', p1); room.players.push(p2);
  startRound(room, p1.id);
  assert.equal(room.phase, 'playing'); assert.equal(room.pot, 200); assert.equal(room.players[0].chips, 9900); assert.equal(room.players[1].chips, 9900);
  const cards = room.players.flatMap((p) => p.hand.map((x) => `${x.rank}${x.suit}`)); assert.equal(new Set(cards).size, 6); assert.notEqual(room.turnSeat, null);
});

test('seen player pays double and folding heads-up awards the pot', () => {
  const p1 = createHumanPlayer('甲', 0, 'x'); const p2 = createHumanPlayer('乙', 1, 'y'); p1.ready = p2.ready = true;
  const room = createInitialRoom('123456', p1); room.players.push(p2); startRound(room, p1.id);
  const actor = room.players.find((p) => p.seat === room.turnSeat)!; const other = room.players.find((p) => p.id !== actor.id)!;
  applyCommand(room, actor.id, { type: 'look' }); const before = actor.chips; applyCommand(room, actor.id, { type: 'call' }); assert.equal(before - actor.chips, 200);
  assert.equal(room.turnSeat, other.seat); const winnerBefore = actor.chips; applyCommand(room, other.id, { type: 'fold' });
  assert.equal(room.phase, 'round_end'); assert.equal(room.result?.winnerId, actor.id); assert.ok(actor.chips > winnerBefore);
});

test('compare costs twice the current call and is available immediately heads-up', () => {
  const p1 = createHumanPlayer('甲', 0, 'x'); const p2 = createHumanPlayer('乙', 1, 'y'); p1.ready = p2.ready = true;
  const room = createInitialRoom('123456', p1); room.players.push(p2); startRound(room, p1.id);
  const actor = room.players.find((p) => p.seat === room.turnSeat)!;
  const target = room.players.find((p) => p.id !== actor.id)!;
  actor.hand = [c(13,'S'),c(13,'H'),c(13,'D')]; target.hand = [c(14,'S'),c(14,'H'),c(14,'D')];
  const before = actor.chips; const price = compareCost(room, actor);

  applyCommand(room, actor.id, { type: 'compare', targetId: target.id });

  assert.equal(before - actor.chips, price);
  assert.equal(price, 200);
  assert.equal(room.phase, 'round_end');
});

test('all-in contributes the remaining stack and forces every active player to showdown', () => {
  const p1 = createHumanPlayer('甲', 0, 'x'); const p2 = createHumanPlayer('乙', 1, 'y'); const p3 = createHumanPlayer('丙', 2, 'z');
  p1.ready = p2.ready = p3.ready = true;
  const room = createInitialRoom('123456', p1); room.players.push(p2, p3); startRound(room, p1.id);
  const actor = room.players.find((p) => p.seat === room.turnSeat)!;
  const opponents = room.players.filter((p) => p.id !== actor.id);
  actor.hand = [c(9,'S'),c(7,'H'),c(4,'D')];
  opponents[0].hand = [c(14,'S'),c(14,'H'),c(14,'D')];
  opponents[1].hand = [c(13,'S'),c(13,'H'),c(12,'D')];
  actor.chips = 50; const potBefore = room.pot; const winnerBefore = opponents[0].chips;

  applyCommand(room, actor.id, { type: 'all_in' });

  assert.equal(room.phase, 'round_end');
  assert.equal(room.result?.winnerId, opponents[0].id);
  assert.equal(room.result?.reason, '梭哈封顶，全员开牌');
  assert.equal(opponents[0].chips, winnerBefore + potBefore + 50);
  assert.equal(room.players.filter((p) => p.status === 'active').length, 1);
});

test('all-in cannot be used as a voluntary early showdown while a full call is affordable', () => {
  const p1 = createHumanPlayer('甲', 0, 'x'); const p2 = createHumanPlayer('乙', 1, 'y'); p1.ready = p2.ready = true;
  const room = createInitialRoom('123456', p1); room.players.push(p2); startRound(room, p1.id);
  const actor = room.players.find((p) => p.seat === room.turnSeat)!;
  assert.throws(() => applyCommand(room, actor.id, { type: 'all_in' }), /只有积分不足或刚好跟完时才能梭哈/);
});

test('host leaving mid-round transfers ownership to a remaining human', () => {
  const host = createHumanPlayer('房主', 0, 'x');
  const guest = createHumanPlayer('好友', 2, 'y');
  host.ready = guest.ready = true;
  const room = createInitialRoom('123456', host);
  room.players.push({
    id: 'bot_1', name: '电脑', seat: 1, chips: 10_000, ready: true,
    status: 'waiting', looked: false, hand: [], isBot: true,
  });
  room.players.push(guest);
  startRound(room, host.id);

  applyCommand(room, host.id, { type: 'leave' });

  assert.equal(room.hostId, guest.id);
  assert.equal(host.pendingLeave, true);
});

test('host leaving the lobby never transfers ownership to a bot when a human remains', () => {
  const host = createHumanPlayer('房主', 0, 'x');
  const guest = createHumanPlayer('好友', 2, 'y');
  const room = createInitialRoom('123456', host);
  room.players.push({
    id: 'bot_1', name: '电脑', seat: 1, chips: 10_000, ready: true,
    status: 'waiting', looked: false, hand: [], isBot: true,
  });
  room.players.push(guest);

  applyCommand(room, host.id, { type: 'leave' });

  assert.equal(room.hostId, guest.id);
  assert.equal(room.players.some((p) => p.id === host.id), false);
});
