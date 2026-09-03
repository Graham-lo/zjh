import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCommand, botDecision, createHumanPlayer, createInitialRoom, currentPlayer, evaluateHand,
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

/* ------------------------------------------------------- 打法质量的回归测试 */

/** 六台机器人自己打，收集每一步的决策，用来检验"像不像人在打牌"。 */
function autoTable(hands: number) {
  const shape = {
    actions: 0, folds: 0, blindFolds: 0,
    monsters: 0, earlyMonsterCompares: 0,
    survivorsSum: 0, handsPlayed: 0,
  };
  for (let h = 0; h < hands; h++) {
    const room = table(1, 5);
    room.players[0].isBot = true; // 让真人的座位也交给机器人，凑满一桌
    applyCommand(room, room.hostId, { type: 'start' });
    const seenMonster = new Set<string>();
    let field = 0;
    let guard = 0;
    while (room.phase === 'playing' && guard++ < 400) {
      const cur = currentPlayer(room);
      if (!cur) break;
      field = room.players.filter((p) => p.status === 'active').length;
      const looked = cur.looked;
      const round = room.roundNo;
      const monster = cur.hand.length ? evaluateHand(cur.hand).category >= 5 : false;
      if (monster && !seenMonster.has(cur.id)) { seenMonster.add(cur.id); shape.monsters++; }
      const cmd = botDecision(room, cur);
      shape.actions++;
      if (cmd.type === 'fold') { shape.folds++; if (!looked) shape.blindFolds++; }
      // 人多的时候，比牌刚一解锁就拿豹子开牌是最不像人的一步。
      if (cmd.type === 'compare' && monster && round <= 2 && field >= 3) shape.earlyMonsterCompares++;
      try { applyCommand(room, cur.id, cmd); } catch { applyCommand(room, cur.id, { type: 'fold' }); }
    }
    shape.survivorsSum += field;
    shape.handsPlayed++;
  }
  return shape;
}

test('闷牌的机器人不会因为先验算错而集体弃牌', () => {
  const shape = autoTable(200);
  const blindShare = shape.blindFolds / Math.max(1, shape.folds);
  // 旧模型把闷牌当成"我确定拿了一手中间牌"，再做 0.5^5 = 3% 的指数，
  // 低于任何底池赔率 —— 于是三成弃牌都是闷着就走，牌局根本打不起来。
  assert.ok(blindShare < 0.12, `闷着就弃占了弃牌的 ${(blindShare * 100).toFixed(1)}%`);
});

test('一桌机器人不会互相弃到只剩一个人，牌是要打到摊牌的', () => {
  const shape = autoTable(200);
  const survivors = shape.survivorsSum / shape.handsPlayed;
  assert.ok(survivors >= 1.8, `平均收官人数只有 ${survivors.toFixed(2)}，等于没人真的比过牌`);
});

test('人多的时候，拿到豹子/顺金不会在比牌一解锁就开牌', () => {
  const shape = autoTable(200);
  const rate = shape.earlyMonsterCompares / Math.max(1, shape.monsters);
  // 比牌是把强牌立刻变现，只赢到眼下这点底池还公开了自己的牌力。
  // 人会先养池；机器人也必须先养池。
  assert.ok(rate < 0.05, `${(rate * 100).toFixed(1)}% 的大牌在前两轮就多人局比牌`);
});
