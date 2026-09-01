import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allInCost, applyCommand, botDecision, canAutoStart, canCompareNow, claimHostIfVacant, compareCost,
  compareHands, createHumanPlayer, createInitialRoom, currentPlayer, evaluateHand,
  handPercentile, sanitizeRoom, startRound, transferHost,
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
  assert.equal(room.pot, 200);
  assert.equal(room.players[0].chips, 9900);
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

test('梭哈把剩余积分全投入并强制所有人开牌', () => {
  const room = makeRoom(3);
  startRound(room, room.hostId);
  const actor = currentPlayer(room)!;
  const others = room.players.filter((p) => p.id !== actor.id);
  actor.hand = [c(9, 'S'), c(7, 'H'), c(4, 'D')];
  others[0].hand = [c(14, 'S'), c(14, 'H'), c(14, 'D')];
  others[1].hand = [c(13, 'S'), c(13, 'H'), c(12, 'D')];
  actor.chips = 50;
  const pot = room.pot;
  applyCommand(room, actor.id, { type: 'all_in' });
  assert.equal(room.phase, 'round_end');
  assert.equal(room.result?.winnerId, others[0].id);
  assert.equal(room.result?.potWon, pot + 50);
  assert.equal(room.result?.revealed.length, 3);
});

test('梭哈是可以主动选的战术，成本跟着底池走', () => {
  const room = makeRoom(3);
  startRound(room, room.hostId);
  const actor = currentPlayer(room)!;
  // 底池 300、比牌价 200 → 取较大者，且不超过自己的积分
  const price = allInCost(room, actor);
  assert.equal(price, 300);
  const before = actor.chips;
  const potBefore = room.pot;

  applyCommand(room, actor.id, { type: 'all_in' });

  assert.equal(room.phase, 'round_end');
  assert.equal(room.result?.revealed.length, 3, '梭哈要逼所有人开牌');
  // 只往池子里加一个底池的量，而不是清空整个身家
  assert.equal(room.result?.potWon, potBefore + price);
  // 赢了就把整池收回，输了只赔这一份 —— 风险和回报是对称的
  const won = room.result!.winnerId === actor.id;
  assert.equal(actor.chips, won ? before - price + room.result!.potWon : before - price);
});

test('底池很小时梭哈也不会比比牌还便宜', () => {
  const room = makeRoom(2);
  startRound(room, room.hostId);
  const actor = currentPlayer(room)!;
  room.pot = 50; // 人为制造一个极小底池
  assert.equal(allInCost(room, actor), compareCost(room, actor));
});

test('积分不足时梭哈自然退化成把剩下的全推出去', () => {
  const room = makeRoom(2);
  startRound(room, room.hostId);
  const actor = currentPlayer(room)!;
  actor.chips = 37;
  assert.equal(allInCost(room, actor), 37);
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
