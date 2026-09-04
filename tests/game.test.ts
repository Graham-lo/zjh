import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOT_NAMES, CATEGORY_BANDS, ZJH_DEAL_PROFILES, ZJH_HAND_DISTRIBUTION_PER_MILLE, categoryBands,
  allInBase, allInCost, applyCommand, botDecision, canAllInNow, canAutoStart, canCompareNow, claimHostIfVacant, compareCost,
  compareHands, createHumanPlayer, createInitialRoom, currentPlayer, dealCategoryForRoll, dealWeightedHands, evaluateHand,
  handPercentile, memoryKey, migrateRoom, sanitizeRoom, startRound, tableRead, timeoutCurrentPlayer, transferHost,
  type Card, type DealMode, type RoomState, type TableRead,
} from '../shared/game.ts';
import { COMMON_PERSONA, PERSONAS, personaFor } from '../shared/zjh/bot/personas/index.ts';
import { engine } from '../shared/games.ts';

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

test('标准档发牌：四类大牌占 26%，散牌与对子按真实比例做底', () => {
  const counts = new Map<number, number>();
  for (let roll = 0; roll < 1000; roll++) {
    const category = dealCategoryForRoll(roll);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries(counts), { 1: 600, 2: 140, 3: 100, 4: 120, 5: 18, 6: 22 });
  // 真实牌型频率是 744:169:33:50:2.2:2.4。大牌仍被放大（26% ≫ 8.8%），
  // 但散牌:对子保持真实的 744:169 —— 低端的牌感不该被娱乐化改掉。
  assert.ok(Math.abs(600 / 740 - 744 / 913) < 0.01, '散牌:对子应贴着真实的 744:169');
});

test('牌力带就是发牌分布的累计，两张表不许各写各的', () => {
  const perMille = ZJH_HAND_DISTRIBUTION_PER_MILLE;
  const order = [perMille.highCard, perMille.pair, perMille.straight, perMille.flush,
    perMille.straightFlush, perMille.trips];
  assert.equal(order.reduce((a, b) => a + b, 0), 1000, '千分比要正好加满 1000');
  let cum = 0;
  for (let i = 0; i < order.length; i++) {
    const [lo, hi] = CATEGORY_BANDS[i + 1];
    assert.equal(lo, cum / 1000, `牌型 ${i + 1} 的带下沿应等于前面牌型的累计概率`);
    cum += order[i];
    assert.ok(Math.abs(hi - cum / 1000) < 1e-12, `牌型 ${i + 1} 的带上沿应等于到它为止的累计概率`);
  }
  assert.equal(CATEGORY_BANDS[6][1], 1);
  assert.deepEqual(CATEGORY_BANDS, {
    1: [0, 0.6], 2: [0.6, 0.74], 3: [0.74, 0.84], 4: [0.84, 0.96], 5: [0.96, 0.978], 6: [0.978, 1],
  });
});

test('娱乐增强档发牌：四类大牌占 54%，散牌降到 35%', () => {
  const counts = new Map<number, number>();
  for (let roll = 0; roll < 1000; roll++) {
    const category = dealCategoryForRoll(roll, 'party');
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries(counts), { 1: 350, 2: 110, 3: 200, 4: 240, 5: 45, 6: 55 });
  // 顺子以上 = 200 + 240 + 45 + 55 = 540‰。这一档要的是碰撞，不是牌理：
  // 真实牌局里四类大牌只有 8.8%，标准档 26%，这里 54%。
  assert.equal(200 + 240 + 45 + 55, 540, '娱乐增强档的大牌占比就是 54%');
  // 标准档一个字都不许被它带跑
  assert.deepEqual(ZJH_DEAL_PROFILES.standard, ZJH_HAND_DISTRIBUTION_PER_MILLE);
  assert.deepEqual(
    Object.fromEntries([...new Array(1000).keys()].reduce((m, roll) => {
      const cat = dealCategoryForRoll(roll);
      return m.set(cat, (m.get(cat) ?? 0) + 1);
    }, new Map<number, number>())),
    { 1: 600, 2: 140, 3: 100, 4: 120, 5: 18, 6: 22 },
  );
});

test('两档的牌力带各自等于自己那份分布的累计，谁也不许借用谁的表', () => {
  for (const mode of ['standard', 'party'] as DealMode[]) {
    const d = ZJH_DEAL_PROFILES[mode];
    const order = [d.highCard, d.pair, d.straight, d.flush, d.straightFlush, d.trips];
    assert.equal(order.reduce((a, b) => a + b, 0), 1000, `${mode} 的千分比要加满 1000`);
    const bands = categoryBands(mode);
    let cum = 0;
    for (let i = 0; i < order.length; i++) {
      const [lo, hi] = bands[i + 1];
      assert.equal(lo, cum / 1000, `${mode} 牌型 ${i + 1} 的带下沿`);
      cum += order[i];
      assert.ok(Math.abs(hi - cum / 1000) < 1e-12, `${mode} 牌型 ${i + 1} 的带上沿`);
    }
    assert.equal(bands[6][1], 1, `${mode} 最强的一手必须钉在 1`);
  }
  assert.deepEqual(categoryBands('party'), {
    1: [0, 0.35], 2: [0.35, 0.46], 3: [0.46, 0.66], 4: [0.66, 0.9], 5: [0.9, 0.945], 6: [0.945, 1],
  });
  assert.deepEqual(categoryBands('standard'), CATEGORY_BANDS, 'CATEGORY_BANDS 就是标准档那一份');
  // 同一手金花，在两档里排的名次不是一回事 —— 所以分位必须跟着房间的档位走
  const flush: Card[] = [c(9, 'S'), c(5, 'S'), c(2, 'S')];
  assert.ok(handPercentile(flush, 'standard') > handPercentile(flush, 'party'),
    '娱乐增强档里金花更常见，同一手金花排得更靠后');
});

test('老快照没有 dealMode 时补成标准档', () => {
  const room = makeRoom(2);
  delete (room.settings as Partial<typeof room.settings>).dealMode;
  migrateRoom(room);
  assert.equal(room.settings.dealMode, 'standard');
  // 脏值同样退回标准档：发牌不能因为一个坏字段就崩
  (room.settings as { dealMode: string }).dealMode = 'wild';
  migrateRoom(room);
  assert.equal(room.settings.dealMode, 'standard');
});

test('标准档发牌：六人连续发牌始终合法且整桌没有重复牌', () => {
  let state = 0x12345678;
  const pick = (max: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % max;
  };
  for (let round = 0; round < 100; round++) {
    const hands = dealWeightedHands(6, pick);
    assert.ok(hands.every((hand) => evaluateHand(hand).category >= 1));
    const cards = hands.flat().map((card) => `${card.suit}${card.rank}`);
    assert.equal(new Set(cards).size, 18, `第 ${round + 1} 轮出现重复牌`);
  }
});

test('标准档发牌：散牌和对子是桌面底色，掷到就必须发得出来', () => {
  const pickerFor = (roll: number) => (max: number) => max === 1000 ? roll : 0;
  for (const [roll, category] of [[500, 1], [900, 2]] as const) {
    const hands = dealWeightedHands(2, pickerFor(roll));
    assert.ok(hands.every((hand) => evaluateHand(hand).category === category));
  }
});

test('标准档发牌：同牌型内部是均匀的，小豹子小顺金照样发得出来', () => {
  // 只放大牌型频率，不在牌型内部再偏向大牌 —— 否则每个人的金花都是 A 高，
  // 同桌撞上同一牌型时大小永远贴在一起，比牌在开牌前就没有悬念了。
  let state = 0x2468ace0;
  const pick = (max: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % max;
  };
  const tops = new Map<number, Set<number>>();
  for (let i = 0; i < 4000; i++) {
    for (const hand of dealWeightedHands(4, pick)) {
      const value = evaluateHand(hand);
      const seen = tops.get(value.category) ?? new Set<number>();
      seen.add(value.tiebreak[0]);
      tops.set(value.category, seen);
    }
  }
  // 豹子从 2 到 A 都要出现过，顺金也要能低到 5 高（即 345 同花）以下
  assert.ok(tops.get(6)!.has(2) && tops.get(6)!.has(14), '豹子应该覆盖到 222 和 AAA');
  assert.ok(Math.min(...tops.get(5)!) <= 5, '顺金不该永远是大牌');
  assert.ok(Math.min(...tops.get(4)!) <= 8, '金花不该永远是 A/K 高');
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
  assert.equal(room.pot, room.settings.ante * 2);
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
  assert.equal(before - actor.chips, room.settings.betOptions[0] * 2);
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
  assert.equal(price, room.settings.betOptions[0] * 2);
  assert.equal(room.phase, 'round_end');
  assert.equal(room.result?.winnerId, target.id);
});

test('牌型和大小完全一样时，主动发起比牌的人输', () => {
  // 现实牌桌的规矩：叫比牌的人要承担平局的代价，否则谁都可以零风险地试探。
  const room = makeRoom(2);
  startRound(room, room.hostId);
  const actor = currentPlayer(room)!;
  const target = room.players.find((p) => p.id !== actor.id)!;
  actor.hand = [c(12, 'S'), c(9, 'S'), c(4, 'S')];
  target.hand = [c(12, 'H'), c(9, 'H'), c(4, 'H')]; // 同为 Q 高金花，逐张相等
  assert.equal(compareHands(actor.hand, target.hand), 0);
  applyCommand(room, actor.id, { type: 'compare', targetId: target.id });
  assert.equal(room.result?.winnerId, target.id, '平局应判发起方负');
  assert.equal(actor.status, 'folded');
});

test('封顶开牌时同样是后手胜，跟比牌口径一致', () => {
  const room = makeRoom(2);
  startRound(room, room.hostId);
  room.roundNo = room.settings.allInFromRound;
  const actor = currentPlayer(room)!;
  const target = room.players.find((p) => p.id !== actor.id)!;
  actor.hand = [c(12, 'S'), c(9, 'S'), c(4, 'S')];
  target.hand = [c(12, 'H'), c(9, 'H'), c(4, 'H')];
  applyCommand(room, actor.id, { type: 'all_in' });
  applyCommand(room, target.id, { type: 'call' });
  assert.equal(room.result?.winnerId, target.id, '梭哈发起方在完全同牌时也应判负');
});

/*
 * 2026-09-05：这条以前叫「短码梭哈时金额就是他自己的身家」。梭哈改成全押、
 * 并且**永远不比跟注便宜**之后，跟不起的人根本没有梭哈 —— 他要打的那一口
 * 是「全押跟」。原来断言的现象（他掏 50、别人按 50 入池、三家开牌）本来就是
 * 边池 + 全押跟的行为，所以这条改成用 call 走同一条路，断言一个不少。
 */
test('跟不起的短码只能全押跟：引擎拒绝他梭哈，但那一口钱照样打得出去', () => {
  const room = makeRoom(3);
  startRound(room, room.hostId);
  const actor = currentPlayer(room)!;
  const others = room.players.filter((p) => p.id !== actor.id);
  actor.hand = [c(9, 'S'), c(7, 'H'), c(4, 'D')];
  others[0].hand = [c(14, 'S'), c(14, 'H'), c(14, 'D')];
  others[1].hand = [c(13, 'S'), c(13, 'H'), c(12, 'D')];
  actor.chips = 50; // 跟注要 1000，跟不起
  for (const o of others) o.chips = 1_000; // 另外两家跟完也正好推光，方便直接走到开牌
  const pot = room.pot;

  assert.throws(
    () => applyCommand(room, actor.id, { type: 'all_in' }),
    /筹码不够跟注，只能全押跟、全押比牌或弃牌/,
    '梭哈不该比跟注便宜，所以短码没有梭哈',
  );

  applyCommand(room, actor.id, { type: 'call' });
  assert.equal(actor.chips, 0, '全押跟：夹到全部筹码');
  assert.equal(actor.allIn, true);
  assert.equal(room.allIn, undefined, '全押跟不进表态，牌局照常往下走');

  // 剩下两家继续打，等到只剩一个人还出得起钱，引擎直接开牌 —— 三家都在，按分层结算
  while (room.phase === 'playing') {
    const p = currentPlayer(room)!;
    applyCommand(room, p.id, { type: 'call' });
  }
  assert.equal(room.phase, 'round_end');
  assert.equal(room.result?.winnerId, others[0].id, '豹子拿主池');
  assert.equal(room.result?.potWon, pot, '主池 = 三家都够得着的那一层（各 1000 底注）');
  assert.equal(room.result?.revealed.length, 3, '三家都摊牌，短码没有因为钱少被踢出去');
  // 超出短码那一层的钱进边池，短码分不到；这正是「全押跟」该有的样子
  assert.equal(others[1].chips, 1_050, '边池归还在局、且掏了那一层的人');
  assert.equal(
    room.players.reduce((n, p) => n + p.chips, 0),
    pot + 50 + 1_000 * 2,
    '筹码守恒：底池加各家实付，一分不多一分不少',
  );
});

/*
 * 2026-09-05：以前叫「梭哈金额由场上最短的一家决定」。那正是被废掉的房规 ——
 * 场上有个 1500 的短码，家底 49.9 万的人梭哈也只押 1500，比跟注还便宜。
 * 现在梭哈就是**自己的全部身家**，短码接不动就全押接、走边池。
 */
test('梭哈金额就是发起人的全部身家，接不动的人全押接', () => {
  const room = makeRoom(3);
  startRound(room, room.hostId);
  room.roundNo = room.settings.allInFromRound;
  const actor = currentPlayer(room)!;
  const others = room.players.filter((p) => p.id !== actor.id);
  // 场上有个短码：他压不低梭哈价，只能把自己的那一层全押进来
  const short = others[0];
  short.chips = 1500;
  // 固定牌面：makeRoom/startRound 随机发牌，短码若摊牌赢下自己那层边池就会拿回筹码，
  // 让下面 `short.chips === 0` 这条断言变成看牌运（约 7/12 概率翻红）；这里把发起人锁死成
  // 豹子 A（三张 A、三种花色），其余两家发明显更小且互不相同的散牌，发起人必赢，
  // 断言才对任何一次随机发牌都成立。
  actor.hand = [c(14, 'S'), c(14, 'H'), c(14, 'D')];
  short.hand = [c(9, 'S'), c(7, 'H'), c(2, 'D')];
  others[1].hand = [c(8, 'C'), c(6, 'D'), c(3, 'H')];
  assert.equal(allInCost(room, actor), actor.chips, '梭哈价 = 发起人的全部筹码');

  const potBefore = room.pot;
  const shove = actor.chips;
  const stacksBefore = new Map(room.players.map((p) => [p.id, p.chips]));
  const betsBefore = new Map(room.players.map((p) => [p.id, p.bet]));

  applyCommand(room, actor.id, { type: 'all_in' });
  assert.equal(room.allIn!.amount, shove, '押上去的就是发起人的全部身家');
  for (const id of room.allIn!.pending.slice()) applyCommand(room, id, { type: 'call' });

  assert.equal(room.phase, 'round_end');
  // 各家实付不再是同一个数：厚家掏全额，短码夹到自己那点身家（`pay` 已夹）
  for (const p of room.players) {
    const paid = p.bet - betsBefore.get(p.id)!;
    assert.equal(paid, Math.min(stacksBefore.get(p.id)!, shove), `${p.name} 的实付不对`);
    assert.ok(p.chips >= 0, '不该有人被打成负数');
  }
  assert.equal(short.bet - betsBefore.get(short.id)!, 1500, '短码只押得起 1500，压不低梭哈价');
  assert.equal(short.chips, 0, '短码全押接');
  // 钱按边池分层退回去，总量守恒
  const before = [...stacksBefore.values()].reduce((n, v) => n + v, 0) + potBefore;
  assert.equal(room.players.reduce((n, p) => n + p.chips, 0), before, '筹码守恒');
});

/*
 * 2026-09-05：以前叫「跟不起的时候任何轮次都能梭哈脱身」。「被动梭哈」这条口子
 * 已经封了 —— 它正是「梭哈比跟注便宜」的入口。跟不起的人的脱身方式是全押跟，
 * 这条改成断言那条新出路，顺带钉死引擎会拒掉他的梭哈。
 */
test('跟不起的人没有梭哈：脱身方式是全押跟，不是把全桌拖进表态', () => {
  const room = makeRoom(3);
  startRound(room, room.hostId);
  assert.equal(room.roundNo, 1, '第一轮');
  const actor = currentPlayer(room)!;
  actor.chips = 50; // 跟注要 1000，跟不起
  assert.throws(
    () => applyCommand(room, actor.id, { type: 'all_in' }),
    /筹码不够跟注，只能全押跟、全押比牌或弃牌/,
  );
  applyCommand(room, actor.id, { type: 'call' });
  assert.equal(actor.chips, 0, '全押跟');
  assert.equal(room.allIn, undefined, '没有表态这回事');
  assert.equal(room.phase, 'playing', '他推光了，剩下的人继续打');
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
  room.settings.startingChips = 50_000;
  room.settings.ante = 100;
  room.settings.betOptions = [100, 1_000, 3_000, 5_000];
  room.betUnit = 100;
  room.players[0].chips = 12_345;
  room.players[0].granted = 50_000;
  delete (room as Partial<typeof room>).chipGrantVersion;
  delete (room as Partial<typeof room>).economyVersion;
  delete (room.settings as Partial<typeof room.settings>).allInFromRound;
  delete (room.settings as Partial<typeof room.settings>).maxRounds;
  migrateRoom(room);
  assert.equal(room.settings.allInFromRound, 3);
  assert.equal(room.settings.maxRounds, 0, '封顶轮数是玩法规则，旧房间恢复后统一到当前默认（不封顶）');
  assert.equal(room.settings.startingChips, 500_000, '旧房间恢复后也使用新的 50 万重置额度');
  assert.equal(room.settings.ante, 1_000, '旧房间下一局也使用新的底注');
  assert.deepEqual(room.settings.betOptions, [1_000, 20_000, 50_000, 100_000], '旧房间同步新的加注档位');
  assert.equal(room.betUnit, 1_000, '大厅里的旧房间立即显示新底注');
  assert.equal(room.players[0].chips, 500_000, '旧房间中的低余额玩家立即补到 50 万');
  assert.equal(room.players[0].granted, 537_655, '补发额同步计入 granted，净战绩不变');
  const migrated = [room.players[0].chips, room.players[0].granted];
  migrateRoom(room);
  assert.deepEqual([room.players[0].chips, room.players[0].granted], migrated, '迁移只能执行一次');
  assert.equal(typeof room.settings.allInFromRound, 'number');
});

test('旧快照的 reads 会一次性并进按账户索引的长期档案', () => {
  const room = makeRoom(2);
  room.players[0].accountId = 'acc-1';
  const legacy: TableRead = {
    hands: 12, played: 6, aggressive: 4, passive: 2,
    pressureFaced: 5, foldsToPressure: 1, showdowns: 3, showdownStrength: 1.8, bluffsCaught: 1,
  };
  (room as Partial<RoomState>).reads = { [room.players[0].id]: legacy };
  migrateRoom(room);
  assert.equal(room.reads, undefined, '迁移之后房间快照里不该再留着 reads 这个字段');
  assert.equal(memoryKey(room.players[0]), 'acc:acc-1', '有账户的真人按账户索引，不是按房内座位 id');
  // 旧快照里没有梭哈表态那两栏（§4.6 之后才有），聚合出来必须是 0，其余一栏不差。
  const expected: TableRead = { ...legacy, allInFaced: 0, allInTaken: 0 };
  assert.deepEqual(tableRead(room, room.players[0].id), expected, '并进长期档案之后聚合口径必须和旧数据完全一致');

  // 迁移必须是幂等的：同一份旧快照被恢复两次，不能把旧笔记再叠加一遍。
  migrateRoom(room);
  assert.deepEqual(tableRead(room, room.players[0].id), expected, '迁移只能生效一次，不能重复叠加');
});

test('旧快照里 handActions 是字符串数组，会被规范成事件对象', () => {
  const room = makeRoom(2);
  // betUnit 只有在「进行中」才不会被 migrateRoom 同步成新底注（大厅/结算阶段
  // 会直接显示新底注），所以这条迁移要在 playing 阶段验证才测得到真实单价。
  startRound(room, room.hostId);
  room.betUnit = 20_000;
  room.roundNo = 2;
  (room.players[0] as unknown as { handActions: string[] }).handActions = ['call', 'raise'];
  migrateRoom(room);
  assert.deepEqual(
    room.players[0].handActions,
    [
      { kind: 'call', looked: false, unit: 20_000, roundNo: 2, at: 0 },
      { kind: 'raise', looked: false, unit: 20_000, roundNo: 2, at: 0 },
    ],
    '老字符串动作按闷牌、当时的单价补成事件对象，不能直接崩掉或丢弃',
  );
});

test('进行中的旧牌局同步新档位，但不在半路强改当前单价', () => {
  const room = makeRoom(2);
  startRound(room, room.hostId);
  room.settings.ante = 100;
  room.settings.betOptions = [100, 1_000, 3_000, 5_000];
  room.betUnit = 5_000;
  delete (room as Partial<typeof room>).economyVersion;
  migrateRoom(room);
  assert.deepEqual(room.settings.betOptions, [1_000, 20_000, 50_000, 100_000]);
  assert.equal(room.betUnit, 5_000, '本局当前单价保持不动，下一局才从新底注开始');
});

/*
 * 2026-09-05：以前叫「场上有人跟不起时，梭哈提前开放」。为了给一个人的出路
 * 把**全桌**的梭哈提前放开，是拿房规换便利；他现在有全押跟，不需要这条。
 * 解锁只看轮次。
 */
test('解锁只看轮次：场上有人跟不起也不会提前放开梭哈', () => {
  const room = makeRoom(3);
  startRound(room, room.hostId);
  assert.equal(room.roundNo, 1);
  assert.equal(canAllInNow(room), false, '第一轮且人人有钱时不该开放');

  room.players.find((p) => p.status === 'active')!.chips = 50;
  assert.equal(canAllInNow(room), false, '有人跟不起也不解锁');

  room.roundNo = room.settings.allInFromRound;
  assert.equal(canAllInNow(room), true, '到轮次才解锁');
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
    allInCost(room, currentPlayer(room)!),
    room.settings.startingChips - room.settings.ante,
    '弃了牌的人不该再压低梭哈金额',
  );
});

/* ------------------------------------------- 梭哈的闷牌半价 / 看牌双倍 */

/** 把房间推到「可以主动梭哈」的状态，并返回行动人和其他人 */
function shoveReady(humans = 3) {
  const room = makeRoom(humans);
  startRound(room, room.hostId);
  room.roundNo = room.settings.allInFromRound;
  const actor = currentPlayer(room)!;
  return { room, actor, others: room.players.filter((p) => p.id !== actor.id) };
}

/**
 * 按表态顺序走完一轮，返回每个人实际掏了多少。lookFirst 里的人先看牌再接。
 * 看的是 bet 而不是 chips：最后一个接的人会在同一次调用里开牌收锅，
 * 用 chips 差算等于把奖池也算进投入。
 */
function settleShove(room: RoomState, opts: { fold?: string[]; lookFirst?: string[] } = {}) {
  const paid = new Map<string, number>();
  let guard = 0;
  while (room.allIn) {
    assert.ok(guard++ < 10, '表态过程必须收敛');
    const p = currentPlayer(room)!;
    if (opts.fold?.includes(p.id)) {
      applyCommand(room, p.id, { type: 'fold' });
      continue;
    }
    if (opts.lookFirst?.includes(p.id) && !p.looked) applyCommand(room, p.id, { type: 'look' });
    const before = p.bet;
    applyCommand(room, p.id, { type: 'call' });
    paid.set(p.id, p.bet - before);
  }
  return paid;
}

/*
 * 2026-09-05：以前叫「发起人闷牌实付正好是看牌实付的一半」——「实付」由被封顶的
 * 单价 × 自己的倍率算出来。梭哈改成全押之后，发起人**闷牌看牌都推光**，实付一样；
 * 倍率影响的是他定出来的**闷牌单价 base**（别人接的价）：看牌的人一份算两份，
 * 所以他的 base 只有身家的一半。这条改成断言 base 这一半。
 */
test('梭哈发起人：闷牌看牌都是全押，看牌的人定出来的闷牌单价是一半', () => {
  // 同一个局面各跑一遍，唯一的差别是发起人有没有看牌。
  const dark = shoveReady();
  dark.others[0].chips = 3000; // 场上有个短码：他压不低任何东西了
  const darkStack = dark.actor.chips;
  const darkBefore = dark.actor.bet;
  applyCommand(dark.room, dark.actor.id, { type: 'all_in' });
  const darkPaid = dark.actor.bet - darkBefore;

  const lit = shoveReady();
  lit.others[0].chips = 3000;
  applyCommand(lit.room, lit.actor.id, { type: 'look' });
  const litStack = lit.actor.chips;
  const litBefore = lit.actor.bet;
  applyCommand(lit.room, lit.actor.id, { type: 'all_in' });
  const litPaid = lit.actor.bet - litBefore;

  assert.equal(darkPaid, darkStack, '闷牌发起：推光');
  assert.equal(litPaid, litStack, '看牌发起：一样推光');
  assert.equal(darkPaid, litPaid, '押的都是全部身家，和看没看牌无关');
  assert.equal(dark.room.allIn!.base, darkStack, '闷牌发起：一份就是全部身家');
  assert.equal(lit.room.allIn!.base, Math.ceil(litStack / 2), '看牌发起：一份是身家的一半');
  assert.equal(lit.room.allIn!.base * 2, darkPaid, '看牌的闷牌单价正好是闷牌的一半');
  assert.equal(dark.room.allIn!.amount, darkPaid, 'amount 记的是发起人押上的全部身家');
  assert.equal(lit.room.allIn!.amount, litPaid);
});

test('接受梭哈：闷牌接的人实付正好是看牌接的人的一半', () => {
  const { room, actor, others } = shoveReady(4);
  // 发起人闷牌推光，所以闷牌单价就是他的全部身家；给别人配足够的钱把这一份接下来
  const stack = actor.chips;
  for (const o of others) o.chips = stack * 3;
  const short = others[0];
  applyCommand(room, actor.id, { type: 'all_in' });
  assert.equal(room.allIn!.base, stack, '闷牌发起：一份就是发起人的全部身家');

  const responders = room.allIn!.pending.filter((id) => id !== short.id);
  const [darkId, litId] = responders;
  const paid = settleShove(room, { fold: [short.id], lookFirst: [litId] });

  assert.equal(paid.get(darkId), stack, '闷牌接受只付一份');
  assert.equal(paid.get(litId), stack * 2, '看牌接受要付两份');
  assert.equal(paid.get(darkId)! * 2, paid.get(litId), '闷牌接受是看牌接受的一半');
});

/*
 * 2026-09-05：以前叫「闷牌单价保证人人掏得起」。**这条保证已经取消了** ——
 * 梭哈就是发起人推光自己，别人掏不掏得起是别人的事：掏不动就全押接，边池分层，
 * 谁也不会被扣成负数。这条改成断言新口径：单价只由发起人自己的身家和倍率决定。
 */
test('梭哈单价只看发起人：闷牌 = 全部身家，看牌 = 身家的一半（ceil）', () => {
  const { room, actor, others } = shoveReady();
  others[0].chips = 1000;
  applyCommand(room, others[0].id, { type: 'look' }); // 场上有个看牌的短码
  others[1].chips = 900;

  assert.equal(allInBase(room, actor), actor.chips, '闷牌发起：一份就是他的全部身家');
  assert.equal(allInCost(room, actor), actor.chips, '梭哈价 = 全部筹码');
  assert.equal(allInBase(room, others[0]), 500, '看牌的人：ceil(1000 / 2)');
  assert.equal(allInCost(room, others[0]), 1000, '他梭哈一样是推光');
  // 别人的身家一概不参与 —— 老规则会被 900 / 500 这两个短码压死
  assert.ok(allInBase(room, actor) > 900, '短码压不低梭哈价');

  applyCommand(room, actor.id, { type: 'all_in' });
  settleShove(room);
  assert.equal(room.phase, 'round_end');
  for (const p of room.players) assert.ok(p.chips >= 0, '接不动的人全押接，不该有人被打成负数');
});

test('表态时先看牌再接受的人要付两倍；翻倍翻过身家就推光筹码', () => {
  // 甲：家底厚（发起人身家的三倍），看牌把自己的价翻一倍，照付
  const rich = shoveReady();
  const richStack = rich.actor.chips;
  for (const o of rich.others) o.chips = richStack * 3;
  applyCommand(rich.room, rich.actor.id, { type: 'all_in' });
  const richId = rich.room.allIn!.pending.find((id) => id !== rich.others[0].id)!;
  const richPaid = settleShove(rich.room, { fold: [rich.others[0].id], lookFirst: [richId] });
  assert.equal(richPaid.get(richId), richStack * 2, '表态阶段看牌，价当场翻倍');

  // 乙：他闷着刚好接得下（身家 = 一份），看牌后要两份 —— 推光筹码，而不是报错
  const broke = shoveReady();
  const brokeStack = broke.actor.chips;
  const shortId = broke.others[0].id;
  broke.others[0].chips = brokeStack;
  applyCommand(broke.room, broke.actor.id, { type: 'all_in' });
  assert.equal(broke.room.allIn!.base, brokeStack);
  const brokePaid = settleShove(broke.room, { lookFirst: [shortId] });
  assert.equal(brokePaid.get(shortId), brokeStack, '夹到全部筹码，一分不多');
  // 这里不能断言 chips === 0：最后一个接的人会在同一次 applyCommand 里开牌收锅，
  // 他要是赢了，奖池当场就发回到 chips 上（牌是随机发的，断言 0 会时过时不过）。
  // 「推光了」的证据是上面那行：实付正好等于他的全部身家，而不是翻倍后的 6000。
  for (const p of broke.room.players) assert.ok(p.chips >= 0, '谁都不该被扣成负数');
});

test('梭哈的底池等于各家实付之和', () => {
  const { room, actor, others } = shoveReady(4);
  const stack = actor.chips;
  for (const o of others) o.chips = stack * 3; // 别人都接得下这一份
  const short = others[0];
  const potBefore = room.pot;
  const betsBefore = new Map(room.players.map((p) => [p.id, p.bet]));
  applyCommand(room, actor.id, { type: 'all_in' });
  const actorPaid = actor.bet - betsBefore.get(actor.id)!;
  assert.equal(room.pot, potBefore + actorPaid, '先只有发起人掏钱');
  assert.equal(actorPaid, stack, '梭哈 = 发起人推光自己');

  const litId = room.allIn!.pending.find((id) => id !== short.id)!;
  const paid = settleShove(room, { fold: [short.id], lookFirst: [litId] });
  assert.equal(paid.get(litId), stack * 2, '看牌接的人两份，单价是发起时定死的那个');

  /*
   * 2026-09-05：这里原来解释的是「有人弃牌就重算单价、已付的人补差价」。
   * 那套房规已经废掉 —— 单价从发起到收场是同一个数，有人弃牌也不动。
   * 「各家实付」照旧按最终的 bet 去加（有人是全押接，付的不是名义价），
   * 守恒这条不受影响：发出去的钱永远等于收进来的钱。
   */
  const total = room.players.reduce((n, p) => n + p.bet - betsBefore.get(p.id)!, 0);
  // 有了边池，potWon 只是**牌面赢家**分到的那几层；守恒要看发出去的总额。
  const paidOut = room.result!.deltas.reduce((n, d) => n + d.delta + d.bet, 0);
  assert.equal(paidOut, potBefore + total, '底池就是各家实付之和，一分不差');
  assert.equal(short.bet - betsBefore.get(short.id)!, 0, '弃牌的短码一分没为这次梭哈掏');
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

test('房间设了封顶轮数时，打满一定会强制开牌结束本局', () => {
  const room = makeRoom(3);
  room.settings.maxRounds = 8;
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

test('不封顶时靠加注压力收敛：一直平跟也一定会打完，而且不是被数轮数掀掉的', () => {
  const room = makeRoom(3);
  assert.equal(room.settings.maxRounds, 0, '默认就该是不封顶');
  room.settings.escalateFrom = 0; // 连自动升档也关掉 —— 最坏情况
  startRound(room, room.hostId);
  let steps = 0;
  while (room.phase === 'playing') {
    const cur = currentPlayer(room)!;
    // 跟不起的时候只剩梭哈，这正是"钱把胜负逼出来"的那一步
    try {
      applyCommand(room, cur.id, { type: 'call' });
    } catch {
      applyCommand(room, cur.id, { type: 'all_in' });
    }
    assert.ok(++steps < 400, '不封顶也必须收敛 —— 底注要一直加压到有人掏不起');
  }
  assert.equal(room.phase, 'round_end');
  assert.ok(room.roundNo > 8, `本局只打了 ${room.roundNo} 轮，说明还有别的地方在提前掀桌子`);
  assert.ok(!room.result!.reason.includes('封顶'), `不该出现封顶收场：${room.result!.reason}`);
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
  assert.equal(h1.winner.net, room.settings.ante, '赢家净赚对手那份底注');
  assert.equal(h1.loser.net, -room.settings.ante);

  // 第二局庄位轮转，谁赢由座位决定；无论谁赢，累计都是在第一局基础上叠加
  const netsBefore = new Map(room.players.map((p) => [p.id, p.net]));
  const h2 = playHand();
  assert.equal(h2.winner.net, netsBefore.get(h2.winner.id)! + room.settings.ante, '赢家在原有累计上再加');
  assert.equal(h2.loser.net, netsBefore.get(h2.loser.id)! - room.settings.ante, '输家在原有累计上再减');
});

test('补分要记进 granted，否则净战绩会被冲掉', () => {
  const room = makeRoom(2);
  const p = room.players[0];
  p.chips = 1000;
  const before = p.granted;
  applyCommand(room, p.id, { type: 'top_up' });
  assert.equal(p.chips, 500_000, '手动补充统一重置到 50 万');
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

test('比牌直接收锅时，比牌双方的牌摊给全场', () => {
  const room = makeRoom(3);
  startRound(room, room.hostId);
  room.turnCount = room.compareUnlockAt; // 解锁比牌
  const actor = currentPlayer(room)!;
  const rest = room.players.filter((p) => p.id !== actor.id);
  applyCommand(room, rest[1].id, { type: 'fold' }); // 先弃到只剩两家
  actor.hand = [c(13, 'S'), c(13, 'H'), c(13, 'D')];
  rest[0].hand = [c(14, 'S'), c(14, 'H'), c(14, 'D')];

  applyCommand(room, actor.id, { type: 'compare', targetId: rest[0].id });
  assert.equal(room.phase, 'round_end');
  assert.equal(room.result?.winnerId, rest[0].id);
  assert.deepEqual(
    [...(room.result?.revealed ?? [])].sort(),
    [actor.id, rest[0].id].sort(),
    '比过牌的两家都要亮，全场才知道谁大',
  );
  // 没参与的那家弃了牌，不该被连坐亮出来
  assert.equal(room.result?.hands[rest[1].id], undefined);
  const seenByFolder = sanitizeRoom(room, rest[1].id);
  // 摊开的两家 + 他自己那一手。局终把牌亮给本人是有意为之（见 tests/table-flow.test.ts 问题 2），
  // 别人的信息边界没变：他仍然只看得到比过牌的那两家。
  assert.equal(seenByFolder.players.filter((p) => p.hand.length === 3).length, 3, '旁观者看得到摊开的两家，外加自己那一手');
  assert.equal(seenByFolder.players.find((p) => p.id === rest[1].id)!.hand.length, 3, '自己的牌局终要还给自己');
});

test('中途被比牌比下去的人，牌局继续也要在结算时亮牌', () => {
  const room = makeRoom(4);
  room.settings.escalateFrom = 0; // 别让自动升档把人打空，本局要走到封顶开牌
  startRound(room, room.hostId);
  room.turnCount = room.compareUnlockAt; // 解锁比牌

  const b = currentPlayer(room)!; // 发起比牌的人
  const rest = room.players.filter((p) => p.id !== b.id && p.status === 'active');
  const a = rest[0]; // 闷牌被比下去的人
  const c1 = rest[1]; // 中途主动弃牌的人
  b.hand = [c(14, 'S'), c(14, 'H'), c(14, 'D')];
  a.hand = [c(9, 'S'), c(7, 'H'), c(4, 'D')];
  assert.equal(a.looked, false, 'A 全程闷牌');

  applyCommand(room, b.id, { type: 'compare', targetId: a.id });
  assert.equal(a.status, 'folded');
  assert.equal(room.phase, 'playing', '还剩三家，牌局必须继续');

  // 被比下去的当场就能看到自己那手牌，不用等结算
  const midView = sanitizeRoom(room, a.id);
  assert.equal(midView.players.find((p) => p.id === a.id)!.hand.length, 3, 'A 当场就该看得到自己的牌');
  assert.equal(
    sanitizeRoom(room, c1.id).players.filter((p) => p.hand.length === 3).length,
    0,
    '没参与比牌的人中途不该提前看到任何人的牌',
  );

  applyCommand(room, c1.id, { type: 'fold' }); // 主动弃牌的那一家
  // 剩下的人一路跟到有人掏不起为止，本局由别的路径结束
  let steps = 0;
  while (room.phase === 'playing') {
    const cur = currentPlayer(room)!;
    try {
      applyCommand(room, cur.id, { type: 'call' });
    } catch {
      applyCommand(room, cur.id, { type: 'all_in' });
    }
    assert.ok(++steps < 400, '一直跟注也必须收敛');
  }

  const revealed = room.result!.revealed;
  assert.ok(revealed.includes(a.id), '被比下去的人必须亮牌 —— 他是被牌面淘汰的');
  assert.ok(revealed.includes(b.id), '比牌的赢家也要亮，否则全场不知道 A 是被什么牌比掉的');
  assert.equal(room.result!.hands[a.id]?.length, 3);
  assert.equal(room.result!.hands[b.id]?.length, 3);
  assert.equal(room.result!.hands[c1.id], undefined, '主动弃牌的人不该被亮牌');
  assert.ok(!revealed.includes(c1.id));

  // 从 A 自己的视角看结算：他能看到自己的牌
  const view = sanitizeRoom(room, a.id);
  assert.deepEqual(view.players.find((p) => p.id === a.id)!.hand, a.hand, 'A 结算时要看得到自己的牌');
  assert.equal(view.result!.hands[c1.id], undefined, '弃牌的人在谁的视角里都不亮');
});

test('下一局开始时会清掉上一局的摊牌标记', () => {
  const room = makeRoom(2);
  startRound(room, room.hostId);
  const actor = currentPlayer(room)!;
  const other = room.players.find((p) => p.id !== actor.id)!;
  applyCommand(room, actor.id, { type: 'compare', targetId: other.id });
  assert.ok(room.players.some((p) => p.bared), '比过牌就该有人被标记');

  applyCommand(room, room.hostId, { type: 'new_round' });
  assert.ok(room.players.every((p) => !p.bared), '回到大厅时标记要清干净');
  for (const p of room.players) p.ready = true;
  startRound(room, room.hostId);
  assert.ok(room.players.every((p) => !p.bared), '新的一局不该继承上一局的摊牌标记');
  assert.equal(sanitizeRoom(room, room.hostId).players[0].hand.length, 0, '没看牌就不该看到自己的牌');
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
  // 局终只有「自己那一手」会回到自己手里，别人的一张都不多给
  assert.equal(view.players.filter((p) => p.hand.length === 3).length, 1);
  assert.equal(view.players.find((p) => p.id === first.id)!.hand.length, 3);
  const other = sanitizeRoom(room, second.id);
  assert.equal(other.players.find((p) => p.id === first.id)!.hand.length, 0, '别人的暗牌仍然看不到');
});

/* ----------------------------------------------------------- 机器人 */

test('机器人有稳定且不同的性格，不会每一步随机换人格', () => {
  // 名字就是身份（§4.7.1）：同名同人，跨房间跨天不变。
  const 赌徒 = personaFor({ id: 'same', name: '阿凯' });
  const 岩石 = personaFor({ id: 'other', name: '老陈' });
  // §4.7.3 那张表上的两个人，性子该反着来。
  assert.ok(赌徒.lines.偷池, '松凶的赌徒有「偷池」这条线');
  assert.equal(岩石.lines.偷池, undefined, '「只用真牌说话」的岩石根本不走偷池');
  assert.ok(赌徒.emotion.tiltGain > 岩石.emotion.tiltGain, '赌徒该比岩石上头得重');
  assert.equal(personaFor({ id: 'yet-another', name: '阿凯' }), 赌徒, '同名必须是同一张卡');
});

test('八个名字全部落在名册上，没有人走常人卡', () => {
  // 过渡期的 7 维性格表（botPersonality / tuneTraits）已在集成第 2 步删除：
  // 现在只有「名册上的那个人」和「常人」两种，桌上不该再出现半个人。
  assert.equal(BOT_NAMES.length, 8, '名册就是 §4.7.3 的八个人');
  assert.equal(new Set(BOT_NAMES).size, 8);
  for (const name of BOT_NAMES) {
    assert.ok(PERSONAS[name], `${name} 不在 §4.7.3 名册上`);
    assert.notEqual(personaFor({ id: 'x', name }), COMMON_PERSONA, `${name} 落回了常人卡`);
  }
  // 反向也要一一对应：有卡却上不了桌的人等于没写。
  assert.deepEqual([...BOT_NAMES].sort(), Object.keys(PERSONAS).sort());
  // 座位只有六个，抽到谁都必须是名册上的人。
  const room = makeRoom(1, 5);
  for (const b of room.players.filter((p) => p.isBot)) assert.ok(BOT_NAMES.includes(b.name));
});

test('一桌会抽到多个不重复的机器人，且风格各不相同', () => {
  const room = makeRoom(1, 5);
  const bots = room.players.filter((p) => p.isBot);
  assert.equal(bots.length, 5);
  assert.equal(new Set(bots.map((p) => p.name)).size, 5);
  // 人格必须真的不一样，但**不能**出现在牌桌上：打法要靠观察摸出来
  assert.equal(new Set(bots.map((p) => personaFor(p))).size, 5);
  assert.ok(bots.every((p) => !('botStyle' in p)), '不该把风格标签下发给客户端');
});

test('机器人防偷看：对手暗牌与闷牌时自己的牌都不会影响决策', () => {
  const room = makeRoom(1, 3);
  startRound(room, room.hostId);
  const bot = room.players.find((p) => p.isBot)!;
  room.turnSeat = bot.seat;
  room.compareUnlockAt = 999;
  bot.looked = true;
  bot.hand = [c(13, 'S'), c(13, 'H'), c(13, 'D')];
  const expected = botDecision(room, bot);

  const changed = structuredClone(room);
  const changedBot = changed.players.find((p) => p.id === bot.id)!;
  const hiddenHands = [
    [c(14, 'S'), c(14, 'H'), c(14, 'D')],
    [c(2, 'S'), c(4, 'H'), c(7, 'D')],
    [c(10, 'C'), c(11, 'C'), c(12, 'C')],
  ];
  let i = 0;
  for (const p of changed.players) {
    if (p.id !== bot.id) p.hand = hiddenHands[i++ % hiddenHands.length];
  }
  assert.deepEqual(botDecision(changed, changedBot), expected);

  const blind = structuredClone(room);
  const blindBot = blind.players.find((p) => p.id === bot.id)!;
  blindBot.looked = false;
  const blindExpected = botDecision(blind, blindBot);
  blindBot.hand = [c(2, 'S'), c(3, 'H'), c(5, 'D')];
  assert.deepEqual(botDecision(blind, blindBot), blindExpected, '没有看牌时连自己的实际牌面也不能参与决策');
});

test('机器人会按牌力和有效筹码使用 10 万高档价值加注', () => {
  const room = makeRoom(1, 3);
  startRound(room, room.hostId);
  const bot = room.players.find((p) => p.isBot)!;
  bot.name = '阿凯';
  bot.looked = true;
  bot.hand = [c(14, 'S'), c(14, 'H'), c(14, 'D')];
  room.turnSeat = bot.seat;
  room.compareUnlockAt = 999;
  room.pot = 50_000;
  room.betUnit = 1_000;

  let found = false;
  for (let seq = 0; seq < 80; seq++) {
    room.actionSeq = seq;
    const cmd = botDecision(room, bot);
    if (cmd.type !== 'raise') continue;
    assert.equal(cmd.unit, 100_000);
    found = true;
    break;
  }
  assert.equal(found, true, '顶级牌在合适局面应该能选择最高价值档，而不是永远只加下一档');
});

test('机器人拿弱牌面对高注和多人压力会止损弃牌', () => {
  const room = makeRoom(1, 3);
  startRound(room, room.hostId);
  const bot = room.players.find((p) => p.isBot)!;
  bot.looked = true;
  bot.hand = [c(2, 'S'), c(4, 'H'), c(7, 'D')];
  room.turnSeat = bot.seat;
  room.betUnit = 100_000;
  room.pot = 220_000;
  for (const p of room.players) {
    if (p.id !== bot.id) {
      p.looked = true;
      p.bet = 100_000;
      p.lastAction = '加到 100000';
    }
  }
  assert.deepEqual(botDecision(room, bot), { type: 'fold' });
});

test('狡诈型会临场变招：低压力后位能诈唬，同一弱牌遇高压立即收手', () => {
  const room = makeRoom(1, 2);
  startRound(room, room.hostId);
  const bot = room.players.find((p) => p.isBot)!;
  bot.name = '老王';
  bot.looked = true;
  bot.hand = [c(2, 'S'), c(4, 'H'), c(7, 'D')];
  room.turnSeat = bot.seat;
  // 后位 = 从 firstActorSeat 顺时针数，他排在最后（M5 修好之后位置只看座次，不看 turnCount）
  room.firstActorSeat = (bot.seat + 1) % room.settings.maxPlayers;
  room.turnCount = 2;
  room.compareUnlockAt = 999;
  /**
   * 诈唬得有个**偷得到的池子**。这个场景原本是「底注 3 千、单价 1 千」——
   * 但这一局的档位表是 [1千, 2万, 5万, 10万]，在 1 千档上「加一档」就是 2 万，
   * 看过牌的人要掏 4 万去偷一个 3 千的池子：保本成功率 93%，谁来了都不该诈唬。
   * 旧模型会在那里诈唬，只是因为它的偷池阈值是一条与价钱无关的常数（`steal >= 0.22`）。
   *
   * 真正的诈唬点在**升档之后、池子养起来、人少**的时候：三轮过后单价 2 万、池子 12 万，
   * 加一档（5 万，成本 10 万）去偷 12 万，保本线落到四成上下，这时候才轮到
   * 「他会不会被我吓走」说话。这也是 §4.4「偷池成功率随人数下降但升档后显著上升」
   * 那句话的另一面（S11）。
   */
  room.roundNo = 3;
  room.betUnit = 20_000;
  room.pot = 120_000;
  /**
   * 「压力」在脑子里读的是**事件流**（`handActions`），不是 `lastAction` 那行给人看的字。
   * 这个场景以前只写了 `lastAction`，于是两半其实是同一个局面：对手在机器人眼里
   * 从头到尾都「什么也没做过」（`storyHeat` 的空数组分支 0.08），高压那一半根本没高压。
   * 真实牌局里这两个数组永远是满的，所以这里把故事补上 —— 断言一个字没改。
   */
  const story = (kinds: ('call' | 'raise')[], unit: number) =>
    kinds.map((kind) => ({ kind, looked: true, unit, roundNo: 3, at: 0 }));
  // 低压力 = 桌上只剩一个人，而且他只是平跟着（`storyHeat` 里没有加注）
  const rest = room.players.filter((p) => p.id !== bot.id);
  rest[0].status = 'folded';
  rest[1].looked = true;
  rest[1].bet = 43_000;
  rest[1].lastAction = '跟注';
  rest[1].handActions = story(['call'], 20_000);
  bot.bet = 43_000;

  let bluffSeq = -1;
  for (let seq = 0; seq < 240; seq++) {
    room.actionSeq = seq;
    const cmd = botDecision(room, bot);
    if (cmd.type === 'raise') {
      bluffSeq = seq;
      break;
    }
  }
  assert.ok(bluffSeq >= 0, '低压力好位置应该混入少量诈唬，而不是弱牌永远同一个动作');

  room.actionSeq = bluffSeq;
  room.betUnit = 50_000;
  room.pot = 150_000;
  for (const p of room.players) {
    if (p.id !== bot.id) {
      p.status = 'active';
      p.looked = true;
      p.bet = 50_000;
      p.lastAction = '加到 50000';
      p.handActions = story(['call', 'raise'], 50_000);
    }
  }
  /**
   * 收手这一半按**分布**断言（§6.3 的口径：固定局面采样 200 次）。
   *
   * 以前这里是一次采样、一次 `deepEqual('fold')` —— 可决策是从软性评分表里
   * **采**出来的，一次采样断言一个 97%–98% 的事件，剩下的 2%–3% 就是这条测试
   * 每几十次跑必红一回的原因（2026-09-04 实测：200 个 `actionSeq` × 15 张桌，
   * 弃牌率 96.5%–99.0%，合计 98.2%；不同桌之间的差别来自 `bot.id`，
   * 它每建一次房都是新的随机串，所以「哪一次红」跟代码没关系）。
   * 断言的是同一件事，只是问的是「他还会不会机械地接着吹」而不是「这一次他吹没吹」。
   */
  let folds = 0;
  const highSeqs = 200;
  for (let seq = 0; seq < highSeqs; seq++) {
    room.actionSeq = seq;
    if (botDecision(room, bot).type === 'fold') folds++;
  }
  const foldShare = folds / highSeqs;
  assert.ok(
    foldShare >= 0.90,
    `桌况转为高压后只有 ${(foldShare * 100).toFixed(1)}% 收手，剩下的还在机械诈唬`,
  );
});

test('狡诈型顶级牌有时慢打设陷阱、有时直接价值加注', () => {
  const room = makeRoom(1, 2);
  startRound(room, room.hostId);
  const bot = room.players.find((p) => p.isBot)!;
  bot.name = '老王';
  bot.looked = true;
  bot.hand = [c(14, 'S'), c(14, 'H'), c(14, 'D')];
  room.turnSeat = bot.seat;
  room.turnCount = 0; // 前位更适合藏强度
  room.compareUnlockAt = 999;
  room.pot = 60_000;
  room.betUnit = 20_000;
  for (const p of room.players) {
    if (p.id !== bot.id) {
      p.looked = true;
      p.bet = 20_000;
      p.lastAction = '加到 20000';
    }
  }

  const actions = new Set<string>();
  for (let seq = 0; seq < 320; seq++) {
    room.actionSeq = seq;
    actions.add(botDecision(room, bot).type);
  }
  assert.ok(actions.has('call'), '强牌应该有慢打设陷阱的线路');
  assert.ok(actions.has('raise'), '强牌也应该有直接做大底池的线路');
});

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

/* ------------------------------------------------- 真人进房顶替电脑 */

test('房间坐满但坐的是电脑时，真人进来顶掉一台电脑而不是被挡在门外', () => {
  const room = makeRoom(1, 5);
  assert.equal(room.players.length, 6, '前提：六个座位已经坐满');
  assert.equal(room.players.filter((p) => p.isBot).length, 5);

  const adapter = engine('zjh');
  const id = adapter.join(room, {
    name: '朋友', avatar: '🐼', tokenHash: 't-friend', accountId: 'acc-friend',
    chips: 500_000, granted: 0, wins: 0, agent: false,
  });

  assert.equal(room.players.length, 6, '顶替不是加座，人数不变');
  assert.equal(room.players.filter((p) => p.isBot).length, 4, '走掉一台电脑');
  const joined = room.players.find((p) => p.id === id);
  assert.ok(joined && !joined.isBot, '新来的真人确实坐下了');
  assert.ok(joined.seat >= 0 && joined.seat < room.settings.maxPlayers, '坐在合法座位上');
  assert.equal(new Set(room.players.map((p) => p.seat)).size, 6, '没有两个人坐同一个座位');
});

test('六个座位全是真人时才说房间已满', () => {
  const room = makeRoom(6, 0);
  assert.equal(room.players.length, 6);
  const adapter = engine('zjh');
  assert.throws(
    () => adapter.join(room, {
      name: '第七个', avatar: '🐼', tokenHash: 't7', accountId: 'acc7',
      chips: 500_000, granted: 0, wins: 0, agent: false,
    }),
    /房间已满/,
  );
});

test('牌局进行中也能顶替：优先赶已经不在这手牌里的电脑', () => {
  const room = makeRoom(1, 5);
  startRound(room, room.hostId);
  // 让一台电脑先弃牌出局，它才是该被赶走的那个
  const acting = currentPlayer(room);
  const spare = room.players.find((p) => p.isBot && p.id !== acting?.id)!;
  spare.status = 'folded';

  const adapter = engine('zjh');
  adapter.join(room, {
    name: '朋友', avatar: '🐼', tokenHash: 't-friend', accountId: 'acc-friend',
    chips: 500_000, granted: 0, wins: 0, agent: false,
  });

  assert.ok(!room.players.some((p) => p.id === spare.id), '被赶走的是那台已经弃牌的电脑');
  assert.equal(room.players.length, 6);
  // 还在打的这手牌没被搞坏
  if (room.phase === 'playing') {
    assert.ok(currentPlayer(room), '轮到谁行动仍然指向桌上的人');
  }
});

test('同一个账户重复进房不会白白赶走一台电脑', () => {
  const room = makeRoom(1, 5);
  const adapter = engine('zjh');
  const seed = {
    name: '朋友', avatar: '🐼', tokenHash: 't-friend', accountId: 'acc-friend',
    chips: 500_000, granted: 0, wins: 0, agent: false,
  };
  adapter.join(room, seed);
  const botsAfterFirst = room.players.filter((p) => p.isBot).length;
  assert.throws(() => adapter.join(room, seed), /已经在这个房间/);
  assert.equal(room.players.filter((p) => p.isBot).length, botsAfterFirst, '没有再赶走第二台');
});

test('改名换头像不挑时候：牌局进行中照样能改', () => {
  // 名字和头像是「我想让别人怎么称呼我」，不是牌桌状态。随手起的默认昵称打了两把
  // 想换掉，不该被迫等一整局打完（产品决定：不做阶段限制）。
  const room = makeRoom(1, 2);
  startRound(room, room.hostId);
  assert.equal(room.phase, 'playing');

  applyCommand(room, room.hostId, { type: 'rename', name: '牌局中改的名', avatar: '🐯' });
  const host = room.players.find((p) => p.id === room.hostId)!;
  assert.equal(host.name, '牌局中改的名');
  assert.equal(host.avatar, '🐯');

  // 同桌重名仍然拦着 —— 那是真会让人看错谁在跟谁比牌的
  const other = room.players.find((p) => p.id !== room.hostId)!;
  other.name = '同桌那个人';
  assert.throws(
    () => applyCommand(room, room.hostId, { type: 'rename', name: '同桌那个人', avatar: '🐯' }),
    /已经有人用了/,
  );
});

test('发牌档：只有房主能改、取值要合法、改了本局不动下一局才生效', () => {
  const room = makeRoom(3);
  assert.equal(room.settings.dealMode, 'standard', '默认是标准档');

  assert.throws(() => applyCommand(room, room.players[1].id, { type: 'settings', dealMode: 'party' }),
    /房主/, '不是房主不能改发牌档');
  assert.equal(room.settings.dealMode, 'standard');

  assert.throws(
    () => applyCommand(room, room.hostId, { type: 'settings', dealMode: 'PARTY' as DealMode }),
    /standard 或 party/, '取值非法要被拒');
  assert.equal(room.settings.dealMode, 'standard');

  applyCommand(room, room.hostId, { type: 'settings', dealMode: 'party' });
  assert.equal(room.settings.dealMode, 'party');
  assert.ok(room.log.some((l) => l.text.includes('已切换到娱乐增强发牌，下一局生效')), '房间日志要留一条');

  // 牌局进行中不许改 —— 这正是「下一局生效」的实现：这一局的牌早就发完了
  applyCommand(room, room.hostId, { type: 'start' });
  assert.equal(room.phase, 'playing');
  assert.throws(() => applyCommand(room, room.hostId, { type: 'settings', dealMode: 'standard' }),
    /牌局进行中/, '牌局进行中不能改房规');
  assert.equal(room.settings.dealMode, 'party', '本局用的还是发牌时那一档');
});
