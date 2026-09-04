/**
 * 三件真人报上来的桌面流程问题的回归测试。
 *
 *  1. 跟注 / 比牌 / 接梭哈时钱不够 —— 应该以全部剩余筹码打出去（「全押跟」），结算走边池；
 *  2. 一局无论怎么结束，每个人都要在结算面板上看到**自己**那手牌，别人的不多露；
 *  3. 房主掉线要立刻把房主交给在线真人，房间不能卡在等房主。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCommand, callCost, createHumanPlayer, createInitialRoom, currentPlayer,
  migrateRoom, sanitizeRoom, startRound, transferHost,
  type Card, type GameCommand, type RoomState,
} from '../shared/game.ts';
import { legalActions } from '../shared/client.ts';
import { Hub, type Conn } from '../server/rooms.ts';
import { Store } from '../server/store.ts';

const c = (rank: number, suit: Card['suit']): Card => ({ rank, suit });

/** 三个在线真人、都已准备的房间。座位 0/1/2，id 固定成 h0/h1/h2 便于断言。 */
function room3(names = ['甲', '乙', '丙']): RoomState {
  const host = createHumanPlayer(names[0], '🐯', 0, 'h0');
  const s = createInitialRoom('123456', host);
  for (let i = 1; i < names.length; i++) {
    s.players.push(createHumanPlayer(names[i], '🦊', i, `h${i}`));
  }
  for (const p of s.players) {
    p.ready = true;
    p.online = true;
  }
  return s;
}

/** 全场筹码 + 底池。任何一个动作前后、以及结算之后，这个数都不该变。 */
function total(s: RoomState): number {
  return s.players.reduce((n, p) => n + p.chips, 0) + s.pot;
}

/* ================================================ 问题 1：钱不够时的跟注 / 比牌 / 梭哈 */

test('问题1｜钱不够跟注时以全部筹码「全押跟」，不是只剩弃牌', () => {
  const s = room3();
  startRound(s, s.hostId);
  const me = currentPlayer(s)!;
  s.betUnit = 100_000; // 台面单价十万
  me.chips = 30_000; // 兜里只有三万
  assert.ok(callCost(s, me) > me.chips, '这个局面就是要名义价钱超过身家');

  const before = total(s);
  const potBefore = s.pot;
  applyCommand(s, me.id, { type: 'call' });

  assert.equal(me.chips, 0, '钱不够就该把剩下的全推出去');
  assert.equal(me.allIn, true, '推光之后要标记 allIn');
  assert.equal(s.pot, potBefore + 30_000, '短付的那一口也要进池子');
  assert.equal(total(s), before, '筹码守恒');
  assert.equal(s.phase, 'playing', '一个人全押不该立刻收场，别人还能继续打');
});

test('问题1｜全押的人被自动跳过，不占行动权也不算弃牌', () => {
  const s = room3();
  startRound(s, s.hostId);
  const me = currentPlayer(s)!;
  s.betUnit = 100_000;
  me.chips = 10_000;
  applyCommand(s, me.id, { type: 'call' });

  assert.equal(me.status, 'active', '全押的人还在局里等结算');
  const seats = new Set<number>();
  for (let i = 0; i < 6 && s.phase === 'playing'; i++) {
    const cur = currentPlayer(s)!;
    assert.notEqual(cur.id, me.id, '筹码为 0 的人不该再被要求出资');
    seats.add(cur.seat);
    cur.chips = 10_000_000; // 别让他们也被打空，这条只测跳过
    applyCommand(s, cur.id, { type: 'call' });
  }
  assert.ok(seats.size >= 2, '其余两家应当继续轮转');
});

test('问题1｜钱不够比牌时以全部筹码发起比牌', () => {
  const s = room3();
  startRound(s, s.hostId);
  s.turnCount = 10; // 解锁比牌
  const me = currentPlayer(s)!;
  const target = s.players.find((p) => p.id !== me.id && p.status === 'active')!;
  s.betUnit = 100_000;
  me.chips = 25_000;

  const before = total(s);
  const betBefore = me.bet;
  applyCommand(s, me.id, { type: 'compare', targetId: target.id });
  // 断言看的是「这一口掏了多少」而不是「事后还剩多少」：三个人的桌子上，
  // 发起人推光之后就只剩一家还能出资，规则 4 会当场开牌，赢家立刻把池子收回去，
  // 于是 me.chips 到底是不是 0 取决于发的牌 —— 那是随机的，断言不能压在上面。
  assert.equal(me.bet - betBefore, 25_000, '比牌费不够也要能比，掏光为止');
  assert.equal(total(s), before, '筹码守恒');
  assert.ok(me.status === 'folded' || target.status === 'folded', '比牌必须分出一个出局的人');
});

test('问题1｜钱不够接梭哈时以全部筹码接下', () => {
  const s = room3();
  startRound(s, s.hostId);
  s.roundNo = 5; // 解锁主动梭哈
  const initiator = currentPlayer(s)!;
  applyCommand(s, initiator.id, { type: 'all_in' });
  assert.ok(s.allIn, '应该进入表态阶段');

  const responder = currentPlayer(s)!;
  assert.notEqual(responder.id, initiator.id);
  const price = s.allIn!.base * (responder.looked ? 2 : 1);
  responder.chips = Math.max(1, Math.floor(price / 3));
  const stake = responder.chips;
  const before = total(s);

  applyCommand(s, responder.id, { type: 'call' });
  assert.equal(responder.chips, 0, '接不起也要能接，掏光为止');
  assert.equal(responder.allIn, true);
  assert.equal(responder.bet >= stake, true);
  assert.equal(total(s), before, '筹码守恒');
});

test('问题1｜未弃牌的人里只剩至多一人还能出资时直接摊牌', () => {
  const s = room3();
  startRound(s, s.hostId);
  const [a, b, d] = s.players;
  // 甲、乙都已经全押，丙还剩一点 —— 丙跟完这一口就没人能再出资了
  s.betUnit = 1_000;
  a.chips = 0;
  a.allIn = true;
  b.chips = 0;
  b.allIn = true;
  d.chips = 5_000; // 丙跟完还剩 4000，但已经没有对手能出资了
  s.turnSeat = d.seat;

  const before = total(s);
  applyCommand(s, d.id, { type: 'call' });
  assert.notEqual(d.allIn, true, '丙没被打空，是「没人能陪他打」才收场');
  assert.equal(s.phase, 'round_end', '没人还能出资就该直接开牌，不要等任何人');
  assert.equal(total(s), before, '筹码守恒');
});

test('问题1｜结算走边池：短筹码的人只能赢到自己出资覆盖的那一层', () => {
  const s = room3();
  startRound(s, s.hostId);
  const [a, b, d] = s.players;
  // 手动摆一个三层的局面：甲牌最大但只押了 100，乙牌次之押到 700，丙牌最小押 500
  a.hand = [c(14, 'S'), c(14, 'H'), c(14, 'D')];
  b.hand = [c(13, 'S'), c(13, 'H'), c(13, 'D')];
  d.hand = [c(9, 'S'), c(7, 'H'), c(2, 'D')];
  a.bet = 100; a.chips = 0; a.allIn = true;
  b.bet = 500; b.chips = 200;
  d.bet = 500; d.chips = 0; d.allIn = true;
  s.pot = 1_100;
  s.betUnit = 200;
  s.turnSeat = b.seat;
  const before = total(s);

  applyCommand(s, b.id, { type: 'call' }); // 乙再掏 200 → 全场没人能出资 → 摊牌

  assert.equal(s.phase, 'round_end');
  assert.equal(total(s), before, '边池结算后筹码仍要守恒');
  // 主池 0–100：三家各 100 → 300，甲牌最大拿走
  assert.equal(a.chips, 300, '甲牌最大，但只押了 100，只能赢下主池那一层');
  // 边池 100–500（乙丙各 400 = 800）+ 500–700（乙独有 200）= 1000，都归乙
  assert.equal(b.chips, 1_000, '甲够不着的两层由牌次大的乙拿走');
  assert.equal(d.chips, 0);
  assert.equal(s.result!.winnerId, a.id, '牌面赢家仍是甲');
  const deltas = Object.fromEntries(s.result!.deltas.map((x) => [x.id, x.delta]));
  assert.equal(deltas[a.id], 200);
  assert.equal(deltas[b.id], 300);
  assert.equal(deltas[d.id], -500);
});

test('问题1｜筹码守恒属性测试：随机筹码分布随机打 500 局', () => {
  // 固定种子，出问题能原样复现
  let seed = 20260904;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];

  for (let hand = 0; hand < 500; hand++) {
    const n = 2 + Math.floor(rnd() * 4); // 2–5 人
    const s = room3(['甲', '乙', '丙', '丁', '戊'].slice(0, n));
    for (const p of s.players) p.chips = 200 + Math.floor(rnd() * 400_000);
    startRound(s, s.hostId);
    const before = total(s);

    for (let step = 0; step < 400 && s.phase === 'playing'; step++) {
      const cur = currentPlayer(s);
      if (!cur) break;
      const tries: GameCommand[] = [];
      if (!cur.looked && rnd() < 0.35) tries.push({ type: 'look' });
      const others = s.players.filter((p) => p.status === 'active' && p.id !== cur.id);
      const roll = rnd();
      if (roll < 0.5) tries.push({ type: 'call' });
      else if (roll < 0.65) tries.push({ type: 'raise', unit: pick(s.settings.betOptions) });
      else if (roll < 0.78 && others.length) tries.push({ type: 'compare', targetId: pick(others).id });
      else if (roll < 0.9) tries.push({ type: 'all_in' });
      else tries.push({ type: 'fold' });
      tries.push({ type: 'call' }, { type: 'fold' }); // 兜底，保证每一步都有进展

      for (const cmd of tries) {
        const snap = total(s);
        try {
          applyCommand(s, cur.id, cmd);
        } catch {
          continue; // 引擎按规则拒了（比如轮数没到不能梭哈），换下一个
        }
        assert.equal(total(s), snap, `第 ${hand} 局第 ${step} 步 ${cmd.type} 之后筹码不守恒`);
        if (cmd.type !== 'look') break;
      }
    }
    assert.equal(total(s), before, `第 ${hand} 局结算后筹码不守恒`);
    assert.ok(s.players.every((p) => p.chips >= 0), `第 ${hand} 局有人被扣成负数`);
  }
});

test('问题1｜钱不够时按钮不该只剩弃牌：legalActions 仍给出全押跟 / 全押比牌', () => {
  const s = room3();
  startRound(s, s.hostId);
  s.turnCount = 10;
  const me = currentPlayer(s)!;
  s.betUnit = 100_000;
  me.chips = 30_000;

  const acts = legalActions(sanitizeRoom(s, me.id));
  const kinds = new Set(acts.map((a) => a.action));
  assert.ok(kinds.has('call'), '钱不够也要能跟（全押跟）');
  assert.ok(kinds.has('compare'), '钱不够也要能比牌（全押比）');
  /*
   * 2026-09-05：梭哈改成全押、并且**永远不比跟注便宜**之后，跟不起的人没有梭哈 ——
   * 他的三条出路是全押跟、全押比牌、弃牌，价钱都夹到全部筹码（问题 1 的本意一点没丢）。
   * 老断言 `kinds.has('all_in')` 正是那条「短码用 1 万把全桌拖进表态」的房规。
   */
  assert.ok(!kinds.has('all_in'), '跟不起的人没有梭哈');
  const call = acts.find((a) => a.action === 'call')!;
  assert.equal(call.cost, 30_000, '显示的金额要夹到全部筹码');
  assert.equal(call.allIn, true, '要能让 UI 显示成「全押 X」');
});

test('问题1｜快照兼容：旧快照没有 allIn 字段也能恢复', () => {
  const s = room3();
  startRound(s, s.hostId);
  const raw = JSON.parse(JSON.stringify(s)) as RoomState;
  for (const p of raw.players) {
    delete (p as { allIn?: boolean }).allIn;
    delete (p as { bet?: number }).bet;
  }
  raw.players[0].chips = 0;
  delete (raw as { hostId?: string }).hostId;

  const fixed = migrateRoom(raw);
  assert.equal(typeof fixed.hostId, 'string');
  for (const p of fixed.players) {
    assert.equal(typeof p.bet, 'number', '累计出资缺失时要补 0');
    assert.equal(typeof p.allIn, 'boolean', 'allIn 缺失时要有默认值');
  }
  assert.equal(fixed.players[0].allIn, true, '老快照里在局又没钱的人就是全押状态');
  assert.equal(fixed.players[1].allIn, false);
});

/* ==================================================== 问题 2：局终把牌亮给自己 */

test('问题2｜别人全弃收场时，闷着的人也能在结算面板看到自己的牌', () => {
  const s = room3();
  startRound(s, s.hostId);
  const [a, b, d] = s.players;
  applyCommand(s, b.id, { type: 'fold' });
  applyCommand(s, d.id, { type: 'fold' });
  assert.equal(s.phase, 'round_end');
  assert.equal(a.looked, false, '赢家自始至终闷着 —— 这就是要复现的场景');

  for (const p of [a, b, d]) {
    const view = sanitizeRoom(s, p.id);
    const me = view.players.find((x) => x.id === p.id)!;
    assert.equal(me.hand.length, 3, `${p.name} 局终该看得到自己拿了什么`);
    assert.deepEqual(view.result!.hands[p.id], p.hand, `${p.name} 的结算面板要带上自己的牌`);
    assert.ok(view.result!.revealed.includes(p.id), '自己那张要在结算面板上翻开');
  }
});

test('问题2｜局终发给 A 的载荷里没有 B 未亮的牌', () => {
  const s = room3();
  startRound(s, s.hostId);
  const [a, b, d] = s.players;
  applyCommand(s, b.id, { type: 'fold' });
  applyCommand(s, d.id, { type: 'fold' });

  const view = sanitizeRoom(s, a.id);
  const payload = JSON.stringify(view);
  for (const other of [b, d]) {
    const row = view.players.find((x) => x.id === other.id)!;
    assert.equal(row.hand.length, 0, `${other.name} 主动弃牌，牌不该给 A 看`);
    assert.equal(view.result!.hands[other.id], undefined);
    assert.ok(!view.result!.revealed.includes(other.id));
    assert.ok(
      !payload.includes(JSON.stringify(other.hand)),
      `${other.name} 的暗牌整串出现在了 A 的载荷里`,
    );
  }
});

test('问题2｜摊牌局里自己的牌也翻开，但信息边界不变', () => {
  const s = room3();
  startRound(s, s.hostId);
  s.roundNo = 5;
  const initiator = currentPlayer(s)!;
  applyCommand(s, initiator.id, { type: 'all_in' });
  while (s.allIn) {
    const cur = currentPlayer(s)!;
    applyCommand(s, cur.id, { type: 'call' });
  }
  assert.equal(s.phase, 'round_end');
  for (const p of s.players) {
    const view = sanitizeRoom(s, p.id);
    assert.deepEqual(view.result!.hands[p.id], p.hand);
  }
});

/* ==================================================== 问题 3：房主离线立刻移交 */

/** 记录下发消息的假连接 —— 重连要用的 token 只在 welcome 里给一次 */
function conn(): Conn & { token?: string } {
  const c: Conn & { token?: string } = {
    ws: {
      readyState: 1, OPEN: 1,
      send(raw: string) {
        const msg = JSON.parse(raw) as { t: string; token?: string };
        if (msg.t === 'welcome' && msg.token) c.token = msg.token;
      },
    } as unknown as Conn['ws'],
    ip: '127.0.0.1', code: null, playerId: null,
  };
  return c;
}
const stateOf = (hub: Hub, code: string): RoomState =>
  (hub as unknown as { room(c: string): { state: RoomState } }).room(code).state;

test('问题3｜房主掉线立刻转给在线真人，并写一条房间日志', async () => {
  const hub = new Hub(new Store(':memory:'));
  const a = conn();
  const b = conn();
  await hub.create(a, 'zjh', '甲', '🐯');
  const code = a.code!;
  await hub.join(b, code, '乙', '🐻');
  const s = stateOf(hub, code);
  assert.equal(s.hostId, a.playerId);

  hub.detach(a);
  assert.equal(s.hostId, b.playerId, '房主掉线要立刻移交，不能等宽限期');
  assert.ok(s.log.some((l) => l.text === '房主已转给 乙'), `缺少移交日志：${s.log.map((l) => l.text).join(' | ')}`);
  hub.detach(b);
});

test('问题3｜连续两个断线，房主转到第三人', async () => {
  const hub = new Hub(new Store(':memory:'));
  const a = conn(); const b = conn(); const d = conn();
  await hub.create(a, 'zjh', '甲', '🐯');
  const code = a.code!;
  await hub.join(b, code, '乙', '🐻');
  await hub.join(d, code, '丙', '🦊');
  const s = stateOf(hub, code);

  hub.detach(a);
  assert.equal(s.hostId, b.playerId, '先转给入座最早的在线真人');
  hub.detach(b);
  assert.equal(s.hostId, d.playerId, '他再掉线就接着往下转');
  hub.detach(d);
  assert.equal(s.hostId, '', '一个在线真人都没有时房主空出来，不留给离线的人');
});

test('问题3｜全部离线再回来一个，回来的人成为房主；原房主重连不夺回', async () => {
  const hub = new Hub(new Store(':memory:'));
  const a = conn(); const b = conn();
  await hub.create(a, 'zjh', '甲', '🐯');
  const code = a.code!;
  await hub.join(b, code, '乙', '🐻');
  const tokenA = a.token!;
  const tokenB = b.token!;
  const s = stateOf(hub, code);
  const idA = a.playerId!;
  const idB = b.playerId!;

  hub.detach(a);
  hub.detach(b);
  assert.equal(s.hostId, '');

  await hub.resume(conn(), code, idB, tokenB);
  assert.equal(s.hostId, idB, '回来的人即成为房主');

  await hub.resume(conn(), code, idA, tokenA);
  assert.equal(s.hostId, idB, '原房主重连不自动夺回房主');
});

test('问题3｜轮到断线的人时不卡：turnSeconds 超时自动接管', async () => {
  const hub = new Hub(new Store(':memory:'));
  const a = conn(); const b = conn(); const d = conn();
  await hub.create(a, 'zjh', '甲', '🐯');
  const code = a.code!;
  await hub.join(b, code, '乙', '🐻');
  await hub.join(d, code, '丙', '🦊');
  hub.command(a, { type: 'ready', ready: true });
  hub.command(b, { type: 'ready', ready: true });
  hub.command(d, { type: 'ready', ready: true });
  hub.command(a, { type: 'start' });

  const s = stateOf(hub, code);
  const cur = currentPlayer(s)!;
  const before = cur.seat;
  const link = [a, b, d].find((x) => x.playerId === cur.id)!;
  s.turnDeadline = Date.now() + 20; // 把这一步的时限压到马上到期
  hub.detach(link); // 掉线 → 重排定时器

  await new Promise((r) => { setTimeout(r, 900); });
  assert.notEqual(s.turnSeat, before, '轮到断线的人时必须由超时接管，不能卡住');
  assert.equal(s.players.find((p) => p.id === cur.id)!.status, 'folded');
  for (const x of [a, b, d]) hub.detach(x);
});

test('问题3｜transferHost 只会交给在线真人', () => {
  const s = room3();
  s.players[1].online = false;
  transferHost(s, s.players[0].id);
  assert.equal(s.hostId, s.players[2].id, '离线的乙要跳过，交给在线的丙');

  s.players[0].online = false;
  s.players[2].online = false;
  transferHost(s, s.players[2].id);
  assert.equal(s.hostId, '', '没有在线真人时房主空出来，不落到离线的人头上');
});

/* ======================= 问题 4：梭哈 = 全押（主流玩法，2026-09-05） */

/**
 * 摆一桌打到第 3 轮（默认可梭哈）的局面，按 chips 数组给每个人配身家，
 * 行动权交给第一家。底注已经收过：每人 bet = 1000、池子 = 1000 × 人数。
 */
function shoveTable(chips: number[], betUnit?: number): RoomState {
  const s = room3(['甲', '乙', '丙', '丁'].slice(0, chips.length));
  startRound(s, s.hostId);
  s.roundNo = 3; // 默认 allInFromRound = 3
  s.players.forEach((p, i) => { p.chips = chips[i]; });
  if (betUnit !== undefined) s.betUnit = betUnit;
  s.turnSeat = s.players[0].seat;
  return s;
}

/** 「单价升至」这条日志出现了几次 —— 主流规则下应该永远是 0 条 */
function rebaseLogs(s: RoomState): string[] {
  return s.log.filter((l) => l.text.includes('单价升至')).map((l) => l.text);
}

/** 某人此刻能点的「接梭哈」要花多少（走客户端那份实现，和 UI 同口径） */
function acceptCost(s: RoomState, id: string): number | undefined {
  return legalActions(sanitizeRoom(s, id)).find((a) => a.action === 'accept')?.cost;
}

/**
 * 轮到某人时他的动作清单（`legalActions` 只在自己回合给出下注类动作，
 * 所以断言「他有没有梭哈」之前得先把行动权交给他）。
 */
function actsOnTurn(s: RoomState, id: string) {
  s.turnSeat = s.players.find((p) => p.id === id)!.seat;
  return legalActions(sanitizeRoom(s, id));
}

/** 轮到某人时，他的动作清单里有没有 all_in（客户端口径） */
function hasShoveButton(s: RoomState, id: string): boolean {
  return actsOnTurn(s, id).some((a) => a.action === 'all_in');
}

test('问题4a｜梭哈就是把自己全部筹码推出去，闷牌发起时 base = 全部身家', () => {
  const s = shoveTable([600_000, 1_000_000, 1_000_000]);
  const [a] = s.players;
  const before = total(s);

  applyCommand(s, a.id, { type: 'all_in' });

  assert.equal(a.chips, 0, '梭哈 = 全押，一分不留');
  assert.equal(a.allIn, true);
  assert.equal(s.allIn!.amount, 600_000, '押上的就是他的全部身家，不看别人有多少');
  assert.equal(s.allIn!.base, 600_000, '闷牌发起：一份就是全部身家');
  assert.equal(total(s), before, '筹码守恒');
});

test('问题4a｜看牌发起：base = ceil(chips / 2)，他自己真的推光', () => {
  const s = shoveTable([600_001, 1_000_000, 1_000_000]);
  const [a] = s.players;
  applyCommand(s, a.id, { type: 'look' });
  applyCommand(s, a.id, { type: 'all_in' });

  assert.equal(a.chips, 0, '看牌的人一样是全押');
  assert.equal(s.allIn!.amount, 600_001);
  // ceil 而不是 floor：身家是奇数时向下取整会少算一块，发起人就推不光
  assert.equal(s.allIn!.base, 300_001, 'ceil(600001 / 2)');
  assert.equal(s.allIn!.base * 2 >= 600_001, true, 'base × 自己的倍率必须盖得住全部身家');
});

test('问题4b｜别人按自己的倍率接：闷牌一份、看牌两份，超身家就全押接', () => {
  const s = shoveTable([500_000, 1_000_000, 1_000_000]);
  const [a, b, d] = s.players;
  applyCommand(s, d.id, { type: 'look' }); // 丙看过牌，一份要掏两倍
  const before = total(s);

  applyCommand(s, a.id, { type: 'all_in' });
  assert.equal(s.allIn!.base, 500_000);
  assert.equal(acceptCost(s, b.id), 500_000, '闷牌的乙掏一份');

  applyCommand(s, b.id, { type: 'call' });
  assert.equal(b.chips, 500_000);
  assert.equal(acceptCost(s, d.id), 1_000_000, '看牌的丙掏两份');
  // 看 bet 不看 chips：最后一个接的人会在同一次调用里开牌，赢了的话奖池当场发回 chips
  const dBefore = d.bet;
  applyCommand(s, d.id, { type: 'call' });
  assert.equal(d.bet - dBefore, 1_000_000, '丙掏两份正好推光他的 100 万');
  assert.equal(s.phase, 'round_end');
  assert.equal(total(s), before, '筹码守恒');
  assert.deepEqual(rebaseLogs(s), [], '主流规则下永远没有「单价升至」这回事');
});

test('问题4b｜接不起就全押接，多押的那一层按边池退回', () => {
  const s = shoveTable([1_000_000, 300_000, 1_000_000]);
  const [a, b, d] = s.players;
  // 定死摊牌结果，边池那几层才好断言：甲最大、丙次之、乙最小
  a.hand = [c(14, 'S'), c(14, 'H'), c(14, 'D')];
  d.hand = [c(13, 'S'), c(13, 'H'), c(13, 'D')];
  b.hand = [c(9, 'S'), c(7, 'H'), c(2, 'D')];
  const before = total(s);

  applyCommand(s, a.id, { type: 'all_in' });
  assert.equal(s.allIn!.base, 1_000_000, '甲的全部身家，不被乙的 30 万压低');
  assert.equal(acceptCost(s, b.id), 300_000, '乙掏不动 100 万，按钮上写的是他的全部筹码');

  applyCommand(s, b.id, { type: 'call' });
  assert.equal(b.chips, 0, '全押接下');
  assert.equal(b.allIn, true);
  applyCommand(s, d.id, { type: 'call' });

  assert.equal(s.phase, 'round_end');
  assert.equal(total(s), before, '筹码守恒');
  const deltas = Object.fromEntries(s.result!.deltas.map((x) => [x.id, x.delta]));
  // 主池：三家各按乙那一层的 300_000 + 三份底注；边池：甲丙各多押的 700_000
  assert.equal(deltas[a.id], 1_302_000, '甲赢下主池和边池');
  assert.equal(deltas[b.id], -301_000);
  assert.equal(deltas[d.id], -1_001_000);
});

test('问题4c｜台面 10 万：短码没有梭哈，只有全押跟 / 全押比牌 / 弃牌', () => {
  // 用户复现的那一桌：台面 10 万，甲 100 万 / 乙 1 万 / 丙 6 万
  const s = shoveTable([1_000_000, 10_000, 60_000], 100_000);
  s.turnCount = 10; // 比牌已经解锁，短码的三条出路才凑得齐
  const [a, b, d] = s.players;

  // 乙、丙都跟不起 10 万，按老规则他们能用 1 万把全桌拖进表态 —— 现在不行了
  for (const short of [b, d]) {
    // 轮到他也一样没有：`hasShoveButton` 会先把行动权交给他
    assert.equal(hasShoveButton(s, short.id), false, `${short.name} 的按钮里不该有梭哈`);
    assert.throws(
      () => applyCommand(s, short.id, { type: 'all_in' }),
      /筹码不够跟注，只能全押跟、全押比牌或弃牌/,
      `${short.name} 调引擎也要被拒`,
    );
  }
  // 出路一条不少：三个动作都在，价钱都夹到自己的全部筹码
  const dActs = actsOnTurn(s, d.id);
  assert.equal(dActs.find((x) => x.action === 'call')?.cost, 60_000, '全押跟 6 万');
  assert.equal(dActs.find((x) => x.action === 'compare')?.cost, 60_000, '全押比牌 6 万');
  assert.ok(dActs.some((x) => x.action === 'fold'));

  // 甲有梭哈，而且是 100 万 —— 不再是被乙的 1 万压成「梭哈比跟注还便宜」
  assert.equal(hasShoveButton(s, a.id), true);
  const shove = actsOnTurn(s, a.id).find((x) => x.action === 'all_in')!;
  assert.equal(shove.cost, 1_000_000, '甲梭哈 = 他的全部身家');
  assert.equal(shove.label, '梭哈（全押 1,000,000，其他人可以接或弃）');
  assert.ok(shove.cost > callCost(s, a), '梭哈永远不比跟注便宜');

  applyCommand(s, a.id, { type: 'all_in' });
  assert.equal(s.allIn!.amount, 1_000_000);
  assert.equal(a.chips, 0);
});

test('问题4d｜表态期间有人弃牌，单价不变，也不写「单价升至」', () => {
  const s = shoveTable([1_000_000, 50_000, 1_000_000]);
  const [a, b, d] = s.players;
  const before = total(s);

  applyCommand(s, a.id, { type: 'all_in' });
  assert.equal(s.allIn!.base, 1_000_000, '发起价只看甲自己');
  applyCommand(s, b.id, { type: 'fold' });

  assert.equal(s.allIn!.base, 1_000_000, '少了一个人也改不了甲押了多少');
  assert.equal(s.allIn!.amount, 1_000_000, '播报数字同样不动');
  assert.equal(a.chips, 0, '发起人没有差价可补 —— 他一开始就推光了');
  assert.deepEqual(rebaseLogs(s), [], '重算那条日志已经不存在');
  assert.equal(acceptCost(s, d.id), 1_000_000, '丙的接受价从头到尾是同一个数');

  applyCommand(s, d.id, { type: 'call' });
  assert.equal(s.phase, 'round_end');
  assert.equal(total(s), before, '筹码守恒');
});

test('问题4e｜第 3 轮前谁也不能梭哈，哪怕场上有人短码', () => {
  const s = shoveTable([1_000_000, 10_000, 60_000], 100_000);
  const [a, b] = s.players;
  s.roundNo = 1;

  assert.equal(hasShoveButton(s, a.id), false, '轮次没到，家底最厚的甲也没有梭哈');
  assert.throws(() => applyCommand(s, a.id, { type: 'all_in' }), /轮起才能主动梭哈/);
  // 乙跟不起：老规则会因为「有人跟不起」把全桌的梭哈提前解锁，现在不会
  assert.ok(b.chips <= callCost(s, b), '乙确实跟不起');
  assert.equal(hasShoveButton(s, b.id), false);

  s.roundNo = 3;
  assert.equal(hasShoveButton(s, a.id), true, '到轮次就解锁');
});

test('问题4f｜含 paid 字段的旧快照恢复后能把表态走完', () => {
  const s = shoveTable([1_000_000, 50_000, 1_000_000]);
  const [a, b, d] = s.players;
  applyCommand(s, a.id, { type: 'all_in' });

  // 老版本的快照里多一个 `paid` 账本（「弃牌后重算单价」那一版），现在没人读它。
  const snapshot = JSON.parse(JSON.stringify(s)) as RoomState;
  (snapshot.allIn as unknown as { paid: Record<string, number> }).paid = { [a.id]: 50_000 };
  const fixed = migrateRoom(snapshot);
  assert.equal(fixed.allIn!.base, 1_000_000, 'base 原样保留，不被 paid 影响');

  const before = total(fixed);
  applyCommand(fixed, b.id, { type: 'fold' });
  assert.equal(fixed.allIn!.base, 1_000_000, '恢复出来的房间同样不重算');
  applyCommand(fixed, d.id, { type: 'call' });
  assert.equal(fixed.phase, 'round_end');
  assert.equal(total(fixed), before, '筹码守恒');
});
