import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allInCost, applyCommand, botDecision, canAllInNow, canAutoStart, canCompareNow, claimHostIfVacant, compareCost,
  compareHands, createHumanPlayer, createInitialRoom, currentPlayer, evaluateHand,
  handPercentile, migrateRoom, sanitizeRoom, startRound, timeoutCurrentPlayer, transferHost,
  type Card, type RoomState,
} from '../shared/game.ts';

const c = (rank: number, suit: Card['suit']): Card => ({ rank, suit });

function makeRoom(humans: number, bots = 0): RoomState {
  const host = createHumanPlayer('甲', '🐯', 0, 'h0');
  const room = createInitialRoom('123456', host);
  for (let i = 1; i < humans; i++) {
    room.players.push(createHumanPlayer(`玩家${i}`, '🦊', i, `h${i}`));
  }
  for (const p of room.players) p.ready = true;
  for (let i = 0; i < bots; i++) applyCommand(room, host.id, { type: 'add_bot' });
  return room;
}

/* ------------------------------------------------------------- 牌型 */

test('牌型大小：同花顺 > 同花 > 顺子', () => {
  assert.equal(compareHands([c(10, 'H'), c(11, 'H'), c(12, 'H')], [c(14, 'S'), c(9, 'S'), c(4, 'S')]), 1);
  assert.equal(compareHands([c(14, 'S'), c(9, 'S'), c(4, 'S')], [c(10, 'H'), c(11, 'D'), c(12, 'C')]), 1);
});

test('A23 是最小顺子', () => {
  const a23 = evaluateHand([c(14, 'S'), c(2, 'D'), c(3, 'C')]);
  assert.equal(a23.name, '顺子');
  assert.deepEqual(a23.tiebreak, [3]);
  assert.equal(compareHands([c(14, 'S'), c(2, 'D'), c(3, 'C')], [c(2, 'S'), c(3, 'D'), c(4, 'C')]), -1);
});

test('235 克豹子，但输给普通单张', () => {
  const sp = [c(2, 'S'), c(3, 'H'), c(5, 'D')];
  assert.equal(compareHands(sp, [c(14, 'S'), c(14, 'H'), c(14, 'D')], true), 1);
  assert.equal(compareHands(sp, [c(14, 'S'), c(9, 'H'), c(7, 'D')], true), -1);
});

test('牌力分位单调：豹子 > 同花 > 对子 > 单张', () => {
  const p = (h: Card[]) => handPercentile(h);
  assert.ok(p([c(14, 'S'), c(14, 'H'), c(14, 'D')]) > p([c(9, 'S'), c(5, 'S'), c(2, 'S')]));
  assert.ok(p([c(9, 'S'), c(5, 'S'), c(2, 'S')]) > p([c(9, 'S'), c(9, 'H'), c(2, 'D')]));
  assert.ok(p([c(9, 'S'), c(9, 'H'), c(2, 'D')]) > p([c(9, 'S'), c(5, 'H'), c(2, 'D')]));
  assert.equal(evaluateHand([c(9, 'S'), c(5, 'S'), c(2, 'S')]).name, '金花');
  assert.equal(evaluateHand([c(4, 'S'), c(3, 'S'), c(2, 'S')]).name, '顺金');
  assert.equal(evaluateHand([c(9, 'S'), c(5, 'H'), c(2, 'D')]).name, '散牌');
  assert.ok(p([c(14, 'S'), c(14, 'H'), c(14, 'D')]) <= 1 && p([c(5, 'S'), c(3, 'H'), c(2, 'D')]) >= 0);
});

/* ------------------------------------------------------------- 开局 */

test('开局发唯一的牌、收底注、定出首家', () => {
  const room = makeRoom(2);
  startRound(room, room.hostId);
  assert.equal(room.phase, 'playing');
  assert.equal(room.pot, room.settings.ante * 2);
  // 从配置推导，改数值时不用回来改测试
  assert.equal(room.players[0].chips, room.settings.startingChips - room.settings.ante);
  const cards = room.players.flatMap((p) => p.hand.map((x) => `${x.rank}${x.suit}`));
  assert.equal(new Set(cards).size, 6);
  assert.notEqual(room.turnSeat, null);
  assert.equal(room.roundNo, 1);
});

test('只有已准备且在线的人入局，掉线的人留座位等下一局', () => {
  const room = makeRoom(3);
  room.players[2].online = false;
  startRound(room, room.hostId);
  assert.equal(room.players[2].status, 'waiting');
  assert.equal(room.players[2].hand.length, 0);
  assert.equal(room.pot, 200);
});

test('底注会把人交空时自动补分，不会留下只能弃牌的死角', () => {
  const room = makeRoom(2);
  room.players[0].chips = room.settings.ante; // 交完底注就会归零
  startRound(room, room.hostId);
  assert.ok(room.players[0].chips > 0, '开局后不该有人是 0 分还在场上');
});

/* ------------------------------------------------------------- 下注 */

test('看牌后跟注翻倍；单挑时对手弃牌直接收锅', () => {
  const room = makeRoom(2);
  startRound(room, room.hostId);
  const actor = currentPlayer(room)!;
  const other = room.players.find((p) => p.id !== actor.id)!;
  applyCommand(room, actor.id, { type: 'look' });
  const before = actor.chips;
  applyCommand(room, actor.id, { type: 'call' });
  assert.equal(before - actor.chips, 200);
  assert.equal(room.turnSeat, other.seat);
  applyCommand(room, other.id, { type: 'fold' });
  assert.equal(room.phase, 'round_end');
  assert.equal(room.result?.winnerId, actor.id);
});

test('比牌花两倍跟注额，单挑时立即开放', () => {
  const room = makeRoom(2);
  startRound(room, room.hostId);
  const actor = currentPlayer(room)!;
  const target = room.players.find((p) => p.id !== actor.id)!;
  actor.hand = [c(13, 'S'), c(13, 'H'), c(13, 'D')];
  target.hand = [c(14, 'S'), c(14, 'H'), c(14, 'D')];
  const before = actor.chips;
  const price = compareCost(room, actor);
  applyCommand(room, actor.id, { type: 'compare', targetId: target.id });
  assert.equal(before - actor.chips, price);
  assert.equal(price, 200);
  assert.equal(room.phase, 'round_end');
  assert.equal(room.result?.winnerId, target.id);
});

test('短码梭哈时金额就是他自己的身家，接的人按同一金额入池', () => {
  const room = makeRoom(3);
  startRound(room, room.hostId);
  const actor = currentPlayer(room)!;
  const others = room.players.filter((p) => p.id !== actor.id);
  actor.hand = [c(9, 'S'), c(7, 'H'), c(4, 'D')];
  others[0].hand = [c(14, 'S'), c(14, 'H'), c(14, 'D')];
  others[1].hand = [c(13, 'S'), c(13, 'H'), c(12, 'D')];
  actor.chips = 50; // 跟不起，被动梭哈，第一轮也允许
  const pot = room.pot;

  applyCommand(room, actor.id, { type: 'all_in' });
  assert.equal(room.allIn?.amount, 50, '金额取场上最短的一家，也就是他自己');
  assert.equal(actor.chips, 0);

  for (const id of room.allIn!.pending.slice()) applyCommand(room, id, { type: 'call' });

  assert.equal(room.phase, 'round_end');
  assert.equal(room.result?.winnerId, others[0].id);
  assert.equal(room.result?.potWon, pot + 50 * 3, '三家各出 50');
  assert.equal(room.result?.revealed.length, 3);
});

test('梭哈金额由场上最短的一家决定，接的人都掏得起', () => {
  const room = makeRoom(3);
  startRound(room, room.hostId);
  room.roundNo = room.settings.allInFromRound;
  const actor = currentPlayer(room)!;
  const others = room.players.filter((p) => p.id !== actor.id);
  // 人为造出一个短码：金额应该跟着他走，而不是跟着梭哈的人
  others[0].chips = 1500;
  assert.equal(allInCost(room), 1500);

  const potBefore = room.pot;
  const stacksBefore = new Map(room.players.map((p) => [p.id, p.chips]));

  applyCommand(room, actor.id, { type: 'all_in' });
  for (const id of room.allIn!.pending.slice()) applyCommand(room, id, { type: 'call' });

  assert.equal(room.phase, 'round_end');
  assert.equal(room.result?.potWon, potBefore + 1500 * 3);
  const potWon = room.result!.potWon;
  for (const p of room.players) {
    const paid = stacksBefore.get(p.id)! - 1500;
    const want: number = p.id === room.result!.winnerId ? paid + potWon : paid;
    assert.equal(p.chips, want, `${p.name} 的积分不对`);
    assert.ok(p.chips >= 0, '不该有人被打成负数');
  }
});

test('跟不起的时候任何轮次都能梭哈脱身', () => {
  const room = makeRoom(3);
  startRound(room, room.hostId);
  assert.equal(room.roundNo, 1, '第一轮，主动梭哈本来是禁止的');
  const actor = currentPlayer(room)!;
  actor.chips = 50; // 跟注要 100，跟不起
  applyCommand(room, actor.id, { type: 'all_in' });
  assert.ok(room.allIn, '被动梭哈也要走表态');
  for (const id of room.allIn!.pending.slice()) applyCommand(room, id, { type: 'fold' });
  assert.equal(room.phase, 'round_end');
  assert.equal(room.result?.winnerId, actor.id);
});

test('梭哈要别人接受才比牌：接的人开牌，不接的人出局', () => {
  const room = makeRoom(3);
  startRound(room, room.hostId);
  room.roundNo = room.settings.allInFromRound;
  const actor = currentPlayer(room)!;
  const others = room.players.filter((p) => p.id !== actor.id);
  const potBefore = room.pot;

  applyCommand(room, actor.id, { type: 'all_in' });

  // 还没开牌，进入表态
  assert.equal(room.phase, 'playing', '梭哈不该立刻结束本局');
  assert.ok(room.allIn, '应该进入表态状态');
  assert.equal(room.allIn!.accepted.length, 1, '一开始只有发起人');
  assert.equal(room.allIn!.pending.length, 2);
  const amount = room.allIn!.amount;
  assert.equal(room.pot, potBefore + amount, '只有发起人先掏钱');

  // 第一个人接
  const first = currentPlayer(room)!;
  assert.ok(others.some((p) => p.id === first.id), '应该轮到别人表态');
  applyCommand(room, first.id, { type: 'call' });
  assert.equal(room.phase, 'playing');
  assert.equal(room.pot, potBefore + amount * 2);

  // 第二个人不接
  const second = currentPlayer(room)!;
  applyCommand(room, second.id, { type: 'fold' });

  assert.equal(room.phase, 'round_end');
  assert.equal(room.allIn, undefined);
  assert.equal(room.result?.revealed.length, 2, '只有接受的两家开牌');
  assert.ok(!room.result!.revealed.includes(second.id), '不接的人不该被亮牌');
  assert.equal(room.result?.potWon, potBefore + amount * 2);
});

test('梭哈没人接就直接收锅，而且不亮牌', () => {
  const room = makeRoom(3);
  startRound(room, room.hostId);
  room.roundNo = room.settings.allInFromRound;
  const actor = currentPlayer(room)!;
  applyCommand(room, actor.id, { type: 'all_in' });
  const rest = room.allIn!.pending.slice();
  for (const id of rest) applyCommand(room, id, { type: 'fold' });

  assert.equal(room.phase, 'round_end');
  assert.equal(room.result?.winnerId, actor.id);
  assert.deepEqual(room.result?.revealed, [], '没人接就没有摊牌，不该亮牌');
});

test('表态阶段只能接或弃，不能加注也不能比牌', () => {
  const room = makeRoom(3);
  startRound(room, room.hostId);
  room.roundNo = room.settings.allInFromRound;
  const actor = currentPlayer(room)!;
  applyCommand(room, actor.id, { type: 'all_in' });
  const responder = currentPlayer(room)!;
  const other = room.players.find((p) => p.status === 'active' && p.id !== responder.id)!;
  assert.throws(() => applyCommand(room, responder.id, { type: 'raise', unit: 500 }), /只能选择接或者弃牌/);
  assert.throws(() => applyCommand(room, responder.id, { type: 'compare', targetId: other.id }), /只能选择接或者弃牌/);
  assert.throws(() => applyCommand(room, responder.id, { type: 'all_in' }), /已经有人梭哈了/);
});

test('表态阶段超时按不接处理，牌局仍然会结束', () => {
  const room = makeRoom(3);
  startRound(room, room.hostId);
  room.roundNo = room.settings.allInFromRound;
  applyCommand(room, currentPlayer(room)!.id, { type: 'all_in' });
  let guard = 0;
  while (room.phase === 'playing') {
    assert.ok(guard++ < 10, '表态过程必须收敛');
    timeoutCurrentPlayer(room);
  }
  assert.equal(room.phase, 'round_end');
});

test('老快照缺字段时会被补齐，不会出现 undefined 轮', () => {
  const room = makeRoom(2);
  // 模拟一个在 allInFromRound 上线之前存下来的房间
  delete (room.settings as Partial<typeof room.settings>).allInFromRound;
  delete (room.settings as Partial<typeof room.settings>).maxRounds;
  migrateRoom(room);
  assert.equal(room.settings.allInFromRound, 3);
  assert.equal(room.settings.maxRounds, 8);
  assert.equal(typeof room.settings.allInFromRound, 'number');
});

test('场上有人跟不起时，梭哈提前开放', () => {
  const room = makeRoom(3);
  startRound(room, room.hostId);
  assert.equal(room.roundNo, 1);
  assert.equal(canAllInNow(room), false, '第一轮且人人有钱时不该开放');

  // 让一个人跟不起，梭哈就该提前可用
  room.players.find((p) => p.status === 'active')!.chips = 50;
  assert.equal(canAllInNow(room), true);
});

test('前两轮不能主动梭哈', () => {
  const room = makeRoom(3);
  startRound(room, room.hostId);
  assert.equal(room.roundNo, 1);
  assert.equal(canAllInNow(room), false);
  const actor = currentPlayer(room)!;
  assert.throws(() => applyCommand(room, actor.id, { type: 'all_in' }), /轮起才能主动梭哈/);

  room.roundNo = 2;
  assert.equal(canAllInNow(room), false);

  room.roundNo = 3;
  assert.equal(canAllInNow(room), true);
});

test('梭哈金额取的是在局玩家，已弃牌的短码不算数', () => {
  const room = makeRoom(3);
  startRound(room, room.hostId);
  const folded = room.players.find((p) => p.seat !== room.turnSeat)!;
  folded.chips = 10;
  applyCommand(room, folded.id, { type: 'fold' });
  assert.equal(
    allInCost(room),
    room.settings.startingChips - room.settings.ante,
    '弃了牌的人不该再压低梭哈金额',
  );
});

test('还没轮到自己也能弃牌，且不会打乱行动顺序', () => {
  const room = makeRoom(3);
  startRound(room, room.hostId);
  const actor = currentPlayer(room)!;
  const waiting = room.players.find((p) => p.id !== actor.id && p.status === 'active')!;

  applyCommand(room, waiting.id, { type: 'fold' });

  assert.equal(waiting.status, 'folded');
  assert.equal(room.turnSeat, actor.seat, '别人弃牌不该把行动权抢走');
  assert.equal(room.phase, 'playing');
});

test('轮到自己弃牌时才交出行动权', () => {
  const room = makeRoom(3);
  startRound(room, room.hostId);
  const actor = currentPlayer(room)!;
  applyCommand(room, actor.id, { type: 'fold' });
  assert.notEqual(room.turnSeat, actor.seat);
  assert.equal(room.phase, 'playing');
});

test('提前弃牌把人数弃到只剩一个也能正常收锅', () => {
  const room = makeRoom(3);
  startRound(room, room.hostId);
  const actor = currentPlayer(room)!;
  const others = room.players.filter((p) => p.id !== actor.id);
  applyCommand(room, others[0].id, { type: 'fold' });
  applyCommand(room, others[1].id, { type: 'fold' });
  assert.equal(room.phase, 'round_end');
  assert.equal(room.result?.winnerId, actor.id);
});

test('已经弃牌的人不能再弃一次', () => {
  const room = makeRoom(3);
  startRound(room, room.hostId);
  const p = room.players.find((x) => x.status === 'active' && x.seat !== room.turnSeat)!;
  applyCommand(room, p.id, { type: 'fold' });
  assert.throws(() => applyCommand(room, p.id, { type: 'fold' }), /不在本局/);
});

test('看牌不占用行动权，什么时候都能看自己的牌', () => {
  const room = makeRoom(3);
  startRound(room, room.hostId);
  const actor = currentPlayer(room)!;
  const waiting = room.players.find((p) => p.id !== actor.id && p.status === 'active')!;
  applyCommand(room, waiting.id, { type: 'look' });
  assert.equal(waiting.looked, true);
  assert.equal(room.turnSeat, actor.seat, '别人看牌不该改变行动顺序');
});

/* --------------------------------------------------------- 结束保证 */

test('打满封顶轮数一定会强制开牌结束本局', () => {
  const room = makeRoom(3);
  room.settings.escalateFrom = 0; // 关掉自动升档，逼出纯"一直跟注"的最坏情况
  startRound(room, room.hostId);
  let steps = 0;
  while (room.phase === 'playing') {
    const cur = currentPlayer(room)!;
    applyCommand(room, cur.id, { type: 'call' });
    assert.ok(++steps < 200, '一直跟注也必须收敛');
  }
  assert.equal(room.phase, 'round_end');
  assert.ok(room.roundNo <= room.settings.maxRounds + 1);
});

/* ----------------------------------------------------------- 房主 */

test('房主中途退出会把房主移交给还在的真人', () => {
  const room = makeRoom(3, 1);
  const host = room.players[0];
  startRound(room, host.id);
  applyCommand(room, host.id, { type: 'leave' });
  assert.notEqual(room.hostId, host.id);
  const newHost = room.players.find((p) => p.id === room.hostId)!;
  assert.equal(newHost.isBot, false);
});

test('房主在准备阶段退出也不会把房主给电脑', () => {
  const room = makeRoom(2, 1);
  const host = room.players[0];
  applyCommand(room, host.id, { type: 'leave' });
  const newHost = room.players.find((p) => p.id === room.hostId)!;
  assert.equal(newHost.isBot, false);
});

test('房主永远不会落到电脑玩家头上', () => {
  const room = makeRoom(1, 3);
  const host = room.players[0];
  transferHost(room, host.id);
  assert.equal(room.hostId, '', '只剩电脑时房主应该空出来，而不是交给电脑');

  // 下一个进来的真人接手
  const human = createHumanPlayer('乙', '🦊', 4, 'h4');
  room.players.push(human);
  assert.equal(claimHostIfVacant(room, human.id), true);
  assert.equal(room.hostId, human.id);
});

test('真人全部离线时电脑不会自己开局打下去', () => {
  const room = makeRoom(1, 3);
  room.players[0].ready = true;
  assert.equal(canAutoStart(room), true);
  room.players[0].online = false;
  assert.equal(canAutoStart(room), false, '没有在线真人时不该自动开局');
});

/* ----------------------------------------------------------- 结算 */

test('结算给出每个人的盈亏，且总和为零', () => {
  const room = makeRoom(3);
  startRound(room, room.hostId);
  const actor = currentPlayer(room)!;
  applyCommand(room, actor.id, { type: 'call' });
  const second = currentPlayer(room)!;
  applyCommand(room, second.id, { type: 'fold' });
  const third = currentPlayer(room)!;
  applyCommand(room, third.id, { type: 'fold' });

  assert.equal(room.phase, 'round_end');
  const deltas = room.result!.deltas;
  assert.equal(deltas.length, 3, '三家都交了底注，都该出现在结算里');
  // 钱只是在桌上换手，不会凭空多也不会凭空少
  assert.equal(deltas.reduce((sum, d) => sum + d.delta, 0), 0);
  const winner = deltas.find((d) => d.id === room.result!.winnerId)!;
  assert.ok(winner.delta > 0, '赢家应该是正的');
  for (const d of deltas) if (d.id !== winner.id) assert.ok(d.delta < 0, `${d.name} 应该是负的`);
});

test('结算里的投入含底注', () => {
  const room = makeRoom(3);
  startRound(room, room.hostId);
  const actor = currentPlayer(room)!;
  const ante = room.settings.ante;
  // 开局只交了底注，还没有任何下注动作
  assert.equal(actor.bet, ante, '底注一开始就算进投入');

  applyCommand(room, actor.id, { type: 'call' });
  const callCost = room.settings.betOptions[0];
  assert.equal(actor.bet, ante + callCost, '跟注要加在底注之上');

  const rest = room.players.filter((p) => p.id !== actor.id && p.status === 'active');
  for (const p of rest) applyCommand(room, p.id, { type: 'fold' });

  const mine = room.result!.deltas.find((d) => d.id === actor.id)!;
  assert.equal(mine.bet, ante + callCost, '结算里的投入必须含底注');
  const folded = room.result!.deltas.find((d) => d.id !== actor.id)!;
  assert.equal(folded.bet, ante, '只交了底注就弃牌的人，投入就是底注');
  assert.equal(folded.delta, -ante, '他的亏损正好是那份底注');
});

test('本桌累计跨局叠加，且桌上净变化恒为零', () => {
  const room = makeRoom(2);
  const playHand = () => {
    for (const p of room.players) p.ready = true;
    startRound(room, room.hostId);
    const first = currentPlayer(room)!;
    const other = room.players.find((p) => p.id !== first.id)!;
    applyCommand(room, other.id, { type: 'fold' }); // 对手直接弃牌，first 收底注
    assert.equal(room.phase, 'round_end');
    assert.equal(room.players.reduce((sum, p) => sum + p.net, 0), 0, '钱只是换手，总和必须是零');
    applyCommand(room, room.hostId, { type: 'new_round' });
    return { winner: first, loser: other };
  };

  const h1 = playHand();
  assert.equal(h1.winner.net, 100, '赢家净赚对手那份底注');
  assert.equal(h1.loser.net, -100);

  // 第二局庄位轮转，谁赢由座位决定；无论谁赢，累计都是在第一局基础上叠加
  const netsBefore = new Map(room.players.map((p) => [p.id, p.net]));
  const h2 = playHand();
  assert.equal(h2.winner.net, netsBefore.get(h2.winner.id)! + 100, '赢家在原有累计上再加');
  assert.equal(h2.loser.net, netsBefore.get(h2.loser.id)! - 100, '输家在原有累计上再减');
});

test('补分要记进 granted，否则净战绩会被冲掉', () => {
  const room = makeRoom(2);
  const p = room.players[0];
  p.chips = 1000;
  const before = p.granted;
  applyCommand(room, p.id, { type: 'top_up' });
  assert.equal(p.chips, room.settings.startingChips);
  assert.equal(p.granted - before, room.settings.startingChips - 1000, '补了多少就记多少');
});

test('开局自动补分同样记账', () => {
  const room = makeRoom(2);
  const p = room.players[0];
  p.chips = 50; // 连底注都不够
  const before = p.granted;
  startRound(room, room.hostId);
  assert.ok(p.granted > before, '自动补的分必须记进 granted，否则余额悄悄变了还查不出来');
});

/* ----------------------------------------------------------- 信息安全 */

test('别人的暗牌永远不会出现在下发的房间视图里', () => {
  const room = makeRoom(3);
  startRound(room, room.hostId);
  for (const p of room.players) p.looked = true;
  const view = sanitizeRoom(room, room.players[0].id);
  assert.equal(view.players[0].hand.length, 3, '自己看过牌就该看得到自己的牌');
  assert.equal(view.players[1].hand.length, 0);
  assert.equal(view.players[2].hand.length, 0);
  assert.equal(JSON.stringify(view).includes('tokenHash'), false);
});

test('中途弃牌的人不会在结算时被亮牌', () => {
  const room = makeRoom(3);
  startRound(room, room.hostId);
  const first = currentPlayer(room)!;
  applyCommand(room, first.id, { type: 'fold' });
  const second = currentPlayer(room)!;
  applyCommand(room, second.id, { type: 'fold' });
  assert.equal(room.phase, 'round_end');
  assert.deepEqual(room.result?.revealed, [], '没有摊牌就不该亮任何人的牌');
  const view = sanitizeRoom(room, first.id);
  assert.equal(view.players.filter((p) => p.hand.length === 3).length, 0);
});

/* ----------------------------------------------------------- 机器人 */

test('机器人的决策永远是当前状态下的合法操作', () => {
  for (let trial = 0; trial < 60; trial++) {
    const room = makeRoom(1, 3);
    startRound(room, room.hostId);
    let steps = 0;
    while (room.phase === 'playing' && steps < 400) {
      const cur = currentPlayer(room)!;
      const cmd = cur.isBot ? botDecision(room, cur) : ({ type: 'fold' } as const);
      applyCommand(room, cur.id, cmd); // 不允许抛错：抛错就说明 AI 会给出非法指令
      steps++;
    }
    assert.equal(room.phase, 'round_end');
  }
});

test('比牌解锁条件与客户端算的一致', () => {
  const room = makeRoom(3);
  startRound(room, room.hostId);
  assert.equal(canCompareNow(room), false);
  const view = sanitizeRoom(room, room.players[0].id);
  assert.equal(canCompareNow(view), canCompareNow(room));
});
