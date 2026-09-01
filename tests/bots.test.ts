import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCommand, botDecision, createHumanPlayer, createInitialRoom, currentPlayer,
  type GameCommand, type RoomState,
} from '../shared/game.ts';

/**
 * 回归测试：旧版本里 runBots 有一个 18 步的循环上限，
 * 用完之后如果还轮到机器人，整个房间就永久卡死 —— 真人再也发不出任何有效指令。
 * 模拟显示"真人先弃牌、只剩机器人"时约有 84% 的概率触发。
 *
 * 现在机器人由服务器逐步驱动，且封顶轮数保证每局必然结束，
 * 所以下面这些牌桌无论怎么跑都必须收敛。
 */

function table(humans: number, bots: number): RoomState {
  const host = createHumanPlayer('甲', '🐯', 0, 'h0');
  const room = createInitialRoom('123456', host);
  for (let i = 1; i < humans; i++) room.players.push(createHumanPlayer(`人${i}`, '🦊', i, `h${i}`));
  for (const p of room.players) p.ready = true;
  for (let i = 0; i < bots; i++) applyCommand(room, host.id, { type: 'add_bot' });
  return room;
}

/** 像服务器那样一步一步推进：真人立刻弃牌，之后全部交给机器人。 */
function playOut(room: RoomState, limit = 400): number {
  let steps = 0;
  while (room.phase === 'playing') {
    const cur = currentPlayer(room);
    assert.ok(cur, '进行中的牌局必须有一个行动玩家');
    const cmd: GameCommand = cur.isBot ? botDecision(room, cur) : { type: 'fold' };
    try {
      applyCommand(room, cur.id, cmd);
    } catch {
      applyCommand(room, cur.id, { type: 'fold' });
    }
    if (++steps > limit) return -1;
  }
  return steps;
}

for (const bots of [2, 3, 5]) {
  test(`1 真人 + ${bots} 机器人：真人弃牌后牌局仍然一定会结束`, () => {
    let worst = 0;
    for (let trial = 0; trial < 300; trial++) {
      const room = table(1, bots);
      applyCommand(room, room.hostId, { type: 'start' });
      const steps = playOut(room);
      assert.notEqual(steps, -1, `第 ${trial} 次试验没有收敛 —— 牌桌卡死了`);
      assert.equal(room.phase, 'round_end');
      worst = Math.max(worst, steps);
    }
    assert.ok(worst < 400, `最坏用了 ${worst} 步`);
  });
}

test('纯机器人牌桌连打 50 局也不会卡住', () => {
  const room = table(1, 5);
  room.players[0].online = false; // 真人掉线，全场只剩机器人
  for (let hand = 0; hand < 50; hand++) {
    applyCommand(room, room.hostId, { type: 'start' });
    assert.notEqual(playOut(room), -1, `第 ${hand + 1} 局卡住了`);
    applyCommand(room, room.hostId, { type: 'new_round' });
  }
  assert.equal(room.handNo, 50);
});

test('机器人不会把自己打到 0 分还留在场上', () => {
  for (let trial = 0; trial < 120; trial++) {
    const room = table(1, 3);
    applyCommand(room, room.hostId, { type: 'start' });
    playOut(room);
    for (const p of room.players) {
      if (p.status === 'active') assert.ok(p.chips > 0, `${p.name} 卡在 0 分还在场上`);
    }
  }
});
