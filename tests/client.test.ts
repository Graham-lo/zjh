import test from 'node:test';
import assert from 'node:assert/strict';
import { legalActions, parseTarget, tableView } from '../shared/client.ts';
import {
  applyCommand, createHumanPlayer, createInitialRoom, currentPlayer, sanitizeRoom, startRound,
  type RoomState,
} from '../shared/game.ts';

function table(humans = 3): RoomState {
  const host = createHumanPlayer('甲', '🐯', 0, 'h0');
  const room = createInitialRoom('123456', host);
  for (let i = 1; i < humans; i++) room.players.push(createHumanPlayer(`人${i}`, '🦊', i, `h${i}`));
  for (const p of room.players) p.ready = true;
  return room;
}

/* --------------------------------------------------------- 入口解析 */

test('邀请链接、裸域名、带端口都能解析成同一个连接目标', () => {
  const a = parseTarget('https://example.com:8443/?room=123456');
  assert.equal(a.ws, 'wss://example.com:8443/ws');
  assert.equal(a.origin, 'https://example.com:8443');
  assert.equal(a.code, '123456');

  // 朋友最常见的粘贴方式：只给域名端口
  const b = parseTarget('example.com:8443');
  assert.equal(b.ws, 'wss://example.com:8443/ws');
  assert.equal(b.code, '');

  // 本地开发是明文
  const c = parseTarget('http://localhost:8787/?room=999999');
  assert.equal(c.ws, 'ws://localhost:8787/ws');
  assert.equal(c.code, '999999');
});

/* --------------------------------------------------------- 合法动作 */

test('合法动作与代价和服务端算的一致', () => {
  const room = table(3);
  startRound(room, room.hostId);
  const actor = currentPlayer(room)!;
  const view = sanitizeRoom(room, actor.id);
  const acts = legalActions(view);

  const call = acts.find((a) => a.action === 'call');
  assert.equal(call?.cost, 100, '没看牌时跟注就是一个底注');
  // 第一轮且人人有钱，梭哈不该开放
  assert.equal(acts.some((a) => a.action === 'all_in'), false);
  // 看牌和弃牌任何时候都在
  assert.ok(acts.some((a) => a.action === 'look'));
  assert.ok(acts.some((a) => a.action === 'fold'));

  applyCommand(room, actor.id, { type: 'look' });
  const after = legalActions(sanitizeRoom(room, actor.id));
  assert.equal(after.find((a) => a.action === 'call')?.cost, 200, '看牌后翻倍');
  assert.equal(after.some((a) => a.action === 'look'), false, '看过就不该再给看牌');
});

test('有人梭哈时只剩接受和弃牌两个选择', () => {
  const room = table(3);
  startRound(room, room.hostId);
  room.roundNo = room.settings.allInFromRound;
  const actor = currentPlayer(room)!;
  applyCommand(room, actor.id, { type: 'all_in' });

  const responder = currentPlayer(room)!;
  const acts = legalActions(sanitizeRoom(room, responder.id));
  const kinds = new Set(acts.map((a) => a.action));
  assert.ok(kinds.has('accept'));
  assert.ok(kinds.has('fold'));
  assert.equal(kinds.has('raise'), false);
  assert.equal(kinds.has('compare'), false);
  assert.equal(kinds.has('call'), false);
});

/* ------------------------------------------------------ 机器可读视图 */

test('给命令行和 MCP 的视图不含任何别人的暗牌', () => {
  const room = table(3);
  startRound(room, room.hostId);
  for (const p of room.players) p.looked = true; // 所有人都看过自己的牌
  const me = room.players[0];
  const view = tableView(sanitizeRoom(room, me.id));

  assert.equal(view.me?.cards?.length, 3, '自己的牌看得到');
  assert.ok(view.me?.handType, '牌型也算好了');
  const others = view.players.filter((p) => p.name !== me.name);
  assert.equal(others.length, 2);
  for (const p of others) assert.equal(p.cards, null, `${p.name} 的牌不该出现在视图里`);
  assert.equal(JSON.stringify(view).includes('tokenHash'), false);
});

test('走到摊牌（梭哈被接受）之后，视图里才会出现别人的牌', () => {
  const room = table(3);
  startRound(room, room.hostId);
  room.roundNo = room.settings.allInFromRound;
  const actor = currentPlayer(room)!;
  applyCommand(room, actor.id, { type: 'all_in' });
  for (const id of room.allIn!.pending.slice()) applyCommand(room, id, { type: 'call' });
  assert.equal(room.phase, 'round_end');

  const view = tableView(sanitizeRoom(room, actor.id));
  assert.equal(view.players.filter((p) => p.cards).length, 3, '三家都接了梭哈，三家都亮牌');
});

test('比牌只让当事双方互相看到，旁观者看不到', () => {
  const room = table(3);
  startRound(room, room.hostId);
  const a = currentPlayer(room)!;
  const b = room.players.find((p) => p.status === 'active' && p.id !== a.id)!;
  const bystander = room.players.find((p) => p.id !== a.id && p.id !== b.id)!;
  room.turnCount = room.compareUnlockAt; // 解锁比牌

  applyCommand(room, a.id, { type: 'compare', targetId: b.id });

  // 当事双方：互相看得到对方的牌
  const seenByA = tableView(sanitizeRoom(room, a.id)).players.filter((p) => p.cards).map((p) => p.name);
  const seenByB = tableView(sanitizeRoom(room, b.id)).players.filter((p) => p.cards).map((p) => p.name);
  assert.ok(seenByA.includes(b.name), 'A 应该看得到 B 的牌');
  assert.ok(seenByB.includes(a.name), 'B 应该看得到 A 的牌');

  // 旁观者：一张都看不到
  const seenByC = tableView(sanitizeRoom(room, bystander.id)).players.filter((p) => p.cards).map((p) => p.name);
  assert.deepEqual(seenByC, [], '没参与比牌的人什么都不该看到');
});

test('比牌的可见性只在本局有效，下一局清空', () => {
  const room = table(2);
  startRound(room, room.hostId);
  const a = currentPlayer(room)!;
  const b = room.players.find((p) => p.id !== a.id)!;
  applyCommand(room, a.id, { type: 'compare', targetId: b.id });
  assert.ok(sanitizeRoom(room, a.id).players.find((p) => p.id === b.id)!.hand.length === 3);

  applyCommand(room, room.hostId, { type: 'new_round' });
  for (const p of room.players) p.ready = true;
  startRound(room, room.hostId);
  const still = sanitizeRoom(room, a.id).players.filter((p) => p.id !== a.id && p.hand.length === 3);
  assert.deepEqual(still, [], '上一局比过牌，这一局不该还看得到');
});

test('下发的房间视图里不含 seen 记账', () => {
  const room = table(3);
  startRound(room, room.hostId);
  const a = currentPlayer(room)!;
  const b = room.players.find((p) => p.status === 'active' && p.id !== a.id)!;
  room.turnCount = room.compareUnlockAt;
  applyCommand(room, a.id, { type: 'compare', targetId: b.id });
  assert.equal('seen' in sanitizeRoom(room, a.id), false);
});

test('视图带上了牌桌记录，命令行才有氛围', () => {
  const room = table(2);
  startRound(room, room.hostId);
  const view = tableView(sanitizeRoom(room, room.hostId));
  assert.ok(view.log.length > 0);
  assert.equal(view.round, `1/${room.settings.maxRounds}`);
});
