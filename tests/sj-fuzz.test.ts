/**
 * 模糊测试：四个机器人随机对局（DESIGN 5.1）。
 *
 * 随机源是可复现的种子，任何断言失败都会把种子和局号打出来，
 * 拿着它就能在本地一比一重放那一局 —— 否则"偶尔挂一次"的问题永远查不出来。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applySjCommand, sanitizeSjRoom, startNextHand, timeoutKou, timeoutTurn,
  type SjEngineOpts, type SjRoomState,
} from '../shared/sj/engine.ts';
import { sumPoints } from '../shared/sj/cards.ts';
import type { SjKind } from '../shared/games.ts';
import { makeSjRoom, mulberry32, runDeclaring } from './sj-helpers.ts';

/** 打完一局并核对所有不变量。`where` 用来在失败信息里定位是哪个种子的第几局 */
function playHandChecked(room: SjRoomState, opts: SjEngineOpts, where: string) {
  const handNo = room.handNo;
  runDeclaring(room, opts);
  // 先取出来再断言：assert.equal 会把 room.phase 的类型收窄成 'kou'，后面的 while 就没法比了
  const afterDeclare: string = room.phase;
  assert.equal(afterDeclare, 'kou', `${where}：亮主窗口结束后应该进扣底`);
  assert.ok(room.trump.suit, `${where}：这时候主一定定下来了`);
  timeoutKou(room, opts);
  assert.equal(room.bottom.length, 8, `${where}：底牌恒为 8 张`);

  let checkedTricks = 0;
  let guard = 0;
  while (room.phase === 'playing') {
    assert.ok(guard++ < 200, `${where}：出牌没有收敛`);
    timeoutTurn(room, opts);
    const t = room.lastTrick;
    if (t && t.trickNo > checkedTricks) {
      checkedTricks = t.trickNo;
      assert.equal(t.plays.length, 4, `${where} 第 ${t.trickNo} 圈：四家都要出牌`);
      const lens = t.plays.map((p) => p.cardIds.length);
      assert.ok(lens.every((n) => n === lens[0]), `${where} 第 ${t.trickNo} 圈：四家出牌张数必须一致`);
    }
  }

  // 一局四家各出满 25 张；圈数是变量，但不会超过 25（见 DESIGN 1.4 的修正）
  assert.ok(checkedTricks >= 1 && checkedTricks <= 25, `${where}：圈数 ${checkedTricks} 不在 1–25 之间`);
  for (const p of room.players) assert.equal(p.hand.length, 0, `${where}：${p.name} 手牌没打完`);

  const r = room.result!;
  assert.ok(r, `${where}：应该有结算`);
  assert.equal(r.handNo, handNo, `${where}：结算记的是这一局`);

  // 分数守恒：两队从圈里赢到的分 + 底牌分 = 200（罚分与抠底单独核）
  assert.equal(
    r.trickPoints[0] + r.trickPoints[1] + r.bottomPoints, 200,
    `${where}：分数不守恒 ${JSON.stringify(r)}`,
  );
  assert.equal(r.bottomPoints, sumPoints(r.bottom), `${where}：底牌分对不上`);
  const defTeam = 1 - (r.dealerSeat % 2);
  assert.equal(
    r.defenderPoints, r.trickPoints[defTeam] + r.penaltyPoints + (r.dig?.total ?? 0),
    `${where}：闲家得分 = 圈上得分 + 罚分 + 抠底`,
  );
  // 抠底只在闲家赢下最后一圈时发生
  const lastWinnerIsDefender = room.lastTrick!.winnerSeat % 2 === defTeam;
  assert.equal(!!r.dig, lastWinnerIsDefender, `${where}：抠底的触发条件不对`);
  if (r.dig) {
    assert.ok(r.dig.multiplier >= 2 && r.dig.multiplier <= 64, `${where}：抠底倍数越界`);
    assert.equal(r.dig.total, r.dig.base * r.dig.multiplier, `${where}：抠底算错`);
  }
  return checkedTricks;
}

/** 打一整场比赛，返回打了多少局 */
function playMatch(kind: SjKind, seed: number, limit: number): { hands: number; tricks: number[] } {
  const room = makeSjRoom(kind);
  const opts: SjEngineOpts = { rng: mulberry32(seed), now: 1_700_000_000_000 };
  applySjCommand(room, room.hostId, { type: 'start' }, opts);
  const tricks: number[] = [];
  while (room.phase !== 'match_end') {
    assert.ok(room.handNo <= limit, `seed=${seed}：一场比赛打了 ${room.handNo} 局还没结束`);
    tricks.push(playHandChecked(room, opts, `seed=${seed} 第 ${room.handNo} 局`));
    if (room.phase === 'hand_end') startNextHand(room, opts);
  }
  assert.ok(room.matchWinner === 0 || room.matchWinner === 1, `seed=${seed}：通关了却没有赢家`);
  return { hands: tricks.length, tricks };
}

test('模糊对局 300 局：不抛错、张数与分数都守恒', () => {
  let hands = 0;
  let seed = 1;
  let totalTricks = 0;
  const kinds: SjKind[] = ['sj_510k', 'sj_2a'];
  while (hands < 300) {
    const kind = kinds[seed % kinds.length];
    const room = makeSjRoom(kind);
    const opts: SjEngineOpts = { rng: mulberry32(seed * 7919), now: 1_700_000_000_000 };
    applySjCommand(room, room.hostId, { type: 'start' }, opts);
    // 一个房间里连打若干局，顺便验证跨局的状态重置
    for (let i = 0; i < 6 && hands < 300; i++) {
      totalTricks += playHandChecked(room, opts, `seed=${seed} 第 ${room.handNo} 局`);
      hands += 1;
      if (room.phase === 'match_end') {
        applySjCommand(room, room.hostId, { type: 'new_match' }, opts);
        applySjCommand(room, room.hostId, { type: 'start' }, opts);
      } else {
        startNextHand(room, opts);
      }
    }
    seed += 1;
  }
  assert.equal(hands, 300);
  assert.ok(totalTricks / hands > 5, `平均圈数 ${totalTricks / hands} 太低，机器人可能一直在甩大牌`);
});

test('每场比赛都在 200 局内结束', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const a = playMatch('sj_510k', seed, 200);
    assert.ok(a.hands > 0 && a.hands <= 200, `五十K seed=${seed} 打了 ${a.hands} 局`);
    const b = playMatch('sj_2a', seed, 200);
    assert.ok(b.hands > 0 && b.hands <= 200, `打通关 seed=${seed} 打了 ${b.hands} 局`);
  }
});

test('模糊对局里 sanitize 一次都没泄露过别人的手牌', () => {
  const room = makeSjRoom('sj_2a');
  const opts: SjEngineOpts = { rng: mulberry32(4242), now: 1_700_000_000_000 };
  applySjCommand(room, room.hostId, { type: 'start' }, opts);
  runDeclaring(room, opts);
  timeoutKou(room, opts);
  let checks = 0;
  while (room.phase === 'playing') {
    timeoutTurn(room, opts);
    if (room.phase !== 'playing') break; // 局末底牌本来就该公开，那是另一条断言的事
    for (const viewer of room.players) {
      const view = sanitizeSjRoom(room, viewer.id);
      for (const other of room.players) {
        if (other.id === viewer.id) continue;
        const seen = view.players.find((p) => p.id === other.id)!;
        assert.deepEqual(seen.hand, [], '别人的手牌必须是空的');
        assert.equal(seen.handCount, other.hand.length);
      }
      assert.deepEqual(view.bottom, [], '打牌阶段谁都看不到底牌');
      checks += 1;
    }
  }
  assert.ok(checks > 50, '至少要抽查过几十次');
});

test('同一个种子重放出完全一样的一局', () => {
  const run = () => {
    const room = makeSjRoom('sj_510k');
    const opts: SjEngineOpts = { rng: mulberry32(999), now: 1_700_000_000_000 };
    applySjCommand(room, room.hostId, { type: 'start' }, opts);
    runDeclaring(room, opts);
    timeoutKou(room, opts);
    while (room.phase === 'playing') timeoutTurn(room, opts);
    return { played: room.playedIds, result: room.result };
  };
  const a = run();
  const b = run();
  assert.deepEqual(a.played, b.played);
  assert.deepEqual(a.result, b.result);
});

test('新一局会把上一局的状态清干净', () => {
  const room = makeSjRoom('sj_510k');
  const opts: SjEngineOpts = { rng: mulberry32(77), now: 1_700_000_000_000 };
  applySjCommand(room, room.hostId, { type: 'start' }, opts);
  playHandChecked(room, opts, 'reset');
  startNextHand(room, opts);
  assert.equal(room.defenderPoints, 0);
  assert.deepEqual(room.handTrickPoints, [0, 0]);
  assert.equal(room.penaltyPoints, 0);
  assert.deepEqual(room.capturedPointCards, []);
  assert.deepEqual(room.playedIds, []);
  assert.deepEqual(room.trick, []);
  assert.equal(room.lastTrick, null);
  assert.equal(room.result, undefined);
  assert.equal(room.bottomRevealed, false);
  assert.equal(room.flipped, null);
  assert.deepEqual(room.passed, []);
  for (const p of room.players) {
    assert.equal(p.hand.length, 25);
    assert.deepEqual(p.declaredIds, []);
  }
  const all = [...room.players.flatMap((p) => p.hand), ...room.bottom];
  assert.equal(new Set(all.map((c) => c.id)).size, 108, '新一局还是完整的 108 张');
});
