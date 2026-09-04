/**
 * 决策留痕（§4.11）的端到端测试。
 *
 * 跑「五个机器人 + 一个真人」的真牌局，落进内存 SQLite，然后逐条验：
 * 三张表都有行、真人亮牌前库里没有他的牌力、篡改对手暗牌不改变他的特征、
 * 五块复盘都出得来，以及最要紧的那一条 —— **写库炸了牌局照样打完**（§4.11.3）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyCommand, callCost, createHumanPlayer, createInitialRoom, currentPlayer, EMOTES,
  type Card, type GameCommand, type PlayerState, type RoomState,
} from '../shared/game.ts';
import { buildSituation } from '../shared/zjh/bot/situation.ts';
import { personaFor } from '../shared/zjh/bot/personas/index.ts';
import { newMind } from '../shared/mind/emotion.ts';
import { HANDS, ev, scene } from './zjh-helpers.ts';
import { botAction } from '../shared/zjh/bot/index.ts';
import { traceHuman } from '../shared/zjh/bot/trace.ts';
import { Hub, type Conn } from '../server/rooms.ts';
import { Store } from '../server/store.ts';
import { TraceRecorder } from '../server/trace.ts';
import { review } from '../scripts/zjh-review.ts';

/* ------------------------------------------------------------ 牌桌搭建 */

interface Table {
  state: RoomState;
  host: PlayerState;
}

function table(bots = 5): Table {
  const host = createHumanPlayer('真人甲', '🐯', 0, 'hash');
  const state = createInitialRoom('TRACE1', host);
  for (let i = 0; i < bots; i++) applyCommand(state, host.id, { type: 'add_bot' });
  return { state, host };
}

/** 开下一局。`new_round` 只是把牌桌收回大厅，真正发牌的是 `start`，两步都要走。 */
function deal({ state, host }: Table) {
  if (state.phase === 'round_end') applyCommand(state, host.id, { type: 'new_round' });
  if (state.phase === 'lobby') applyCommand(state, host.id, { type: 'start' });
}

/** 真人的固定打法：先看牌，之后一路跟。行为固定，测的才是留痕不是运气。 */
function humanMove(me: PlayerState): GameCommand {
  return me.looked ? { type: 'call' } : { type: 'look' };
}

/**
 * 真人走一步，按 `server/rooms.ts` 里**一模一样的顺序**留痕：
 * 生效前取样、生效后提交。返回引擎是否收下了这个指令 ——
 * 被拒掉（跟不起、不该他动）时一行都不该落库，这本身就是被测的契约。
 */
function humanStep(state: RoomState, rec: TraceRecorder, me: PlayerState, cmd: GameCommand): boolean {
  const commit = rec.human(state, me, cmd, 1234);
  try {
    applyCommand(state, me.id, cmd);
  } catch {
    return false;
  }
  commit();
  return true;
}

function botStep(state: RoomState, rec: TraceRecorder, bot: PlayerState) {
  const act = botAction(state, bot);
  applyCommand(state, bot.id, act.cmd);
  rec.bot(state, act.record, act.cmd);
}

/**
 * 一局一局地打，**直到真人真的动过一次为止**。
 *
 * 这一层不是多余的：发牌是随机的，真人完全可能在轮到自己之前就被人比掉、
 * 或者这一局早就打完了 —— 那样跑出来的库里一行真人动作都没有，
 * 断言就会看运气。全量 `npm test` 里种子和单跑不一样，正好会踩中。
 *
 * `pauseAfterHuman`：真人一动就停在原地（牌还没亮），用来验那一刻库里有什么。
 */
function playUntilHumanActs(
  t: Table, rec: TraceRecorder, { pauseAfterHuman = false } = {},
): boolean {
  for (let hand = 0; hand < 30; hand++) {
    deal(t);
    if (t.state.phase !== 'playing') break;
    let acted = false;
    for (let i = 0; i < 500 && t.state.phase === 'playing'; i++) {
      const cur = currentPlayer(t.state);
      if (!cur) break;
      if (cur.isBot) {
        botStep(t.state, rec, cur);
        continue;
      }
      // 跟不起就弃：真人这一侧要的是「他确实动了一次」，动的是什么无所谓
      if (!humanStep(t.state, rec, cur, humanMove(cur))) {
        humanStep(t.state, rec, cur, { type: 'fold' });
      }
      acted = true;
      if (pauseAfterHuman) return true;
    }
    settle(t, rec);
    if (acted) return true;
  }
  return false;
}

/** 把当前这一局打完（真人已经动过，剩下的交给机器人和固定打法）。 */
function finishHand(t: Table, rec: TraceRecorder) {
  for (let i = 0; i < 500 && t.state.phase === 'playing'; i++) {
    const cur = currentPlayer(t.state);
    if (!cur) break;
    if (cur.isBot) botStep(t.state, rec, cur);
    else if (!humanStep(t.state, rec, cur, humanMove(cur))) humanStep(t.state, rec, cur, { type: 'fold' });
  }
  settle(t, rec);
}

/** 一局结束了就留一条结算痕；没结束（比如上面 500 步没打完）就什么也不做。 */
function settle(t: Table, rec: TraceRecorder) {
  if (t.state.phase === 'round_end') rec.hand(t.state);
}

function rows(store: Store, sql: string): Record<string, unknown>[] {
  return store.raw.prepare(sql).all() as unknown as Record<string, unknown>[];
}

const humanOf = (state: RoomState) => state.players.find((p) => !p.isBot)!;

/* ------------------------------------------------------------------ */

test('一局牌打完，三张留痕表都落到位', () => {
  const store = new Store(':memory:');
  const rec = new TraceRecorder(store, { sync: true });
  const t = table();
  assert.ok(playUntilHumanActs(t, rec), '30 局之内真人总该动过一次');
  finishHand(t, rec);
  rec.flush();

  const decisions = rows(store, 'SELECT * FROM zjh_decisions');
  const humans = rows(store, 'SELECT * FROM zjh_human_actions');
  const outcomes = rows(store, 'SELECT * FROM zjh_hand_outcomes');

  assert.equal(t.state.phase, 'round_end', '这一局应该正常打完');
  assert.ok(decisions.length > 0, '机器人决策该有行');
  assert.ok(humans.length > 0, '真人动作该有行');
  assert.ok(outcomes.length >= 1, '结算该有行');

  // 每一行都得能追回「谁、哪一局、第几轮、做了什么、想了多久」
  for (const d of decisions) {
    assert.ok(String(d.memory_key).startsWith('bot:'), '决策表里只该有机器人');
    assert.equal(d.room, 'TRACE1');
    assert.ok(typeof d.round_no === 'number' && (d.round_no as number) >= 1);
    assert.ok(String(d.persona).length > 0, '要记得下人物卡名');
    assert.ok(typeof d.think_ms === 'number' && (d.think_ms as number) > 0);
    assert.ok(['fold', 'call', 'raise', 'compare', 'all_in', 'look'].includes(String(d.action)));
    // 系统 1 的冲动、置信、感到的牌力/威胁，一个都不能少（§4.11.1）
    for (const col of ['impulse_key', 'confidence', 'felt_strength', 'felt_threat', 'p2', 'engaged', 'gap', 'need']) {
      assert.notEqual(d[col], null, `${col} 不该是空的`);
    }
    // 比例字段就得是比例（2026-09-04 P2.1）：`cost_fraction` 曾经写进过 400000 —— 见下一条
    assert.ok(typeof d.cost_fraction === 'number'
      && (d.cost_fraction as number) >= 0 && (d.cost_fraction as number) <= 1,
      `cost_fraction 必须落在 [0,1]，实际 ${d.cost_fraction}`);
    assert.ok(Array.isArray(JSON.parse(String(d.fired))), 'fired 是规律编号数组');
    assert.ok(typeof JSON.parse(String(d.emotions)) === 'object', 'emotions 是 E_t 向量');
  }
  for (const h of humans) {
    assert.ok(!String(h.memory_key).startsWith('bot:'), '真人表里不该有机器人');
    assert.ok(typeof h.elapsed_ms === 'number', '真人要记真实用时');
  }

  const outcome = outcomes[outcomes.length - 1]!;
  const players = JSON.parse(String(outcome.players)) as { key: string; bet: number; net: number; isBot: boolean }[];
  assert.equal(players.length, t.state.players.length, '每个人的投入/收益都要有');
  assert.ok(players.some((p) => !p.isBot), '真人也在结算行里');
  assert.ok(players.some((p) => p.bet > 0), '总得有人掏了钱');
  assert.ok(typeof JSON.parse(String(outcome.emotion_delta)) === 'object');
});

test('真人的牌面绝不进库：亮牌前连牌力都不记，亮牌后才回填', () => {
  const store = new Store(':memory:');
  const rec = new TraceRecorder(store, { sync: true });
  const t = table();
  assert.ok(playUntilHumanActs(t, rec, { pauseAfterHuman: true }), '真人该动过一次了');
  rec.flush();

  const human = humanOf(t.state);
  // 只看正在打的这一局：找他的过程里可能已经打完过几局，那几局早就结算回填了
  const hand = t.state.handNo;
  const mid = rows(store, `SELECT * FROM zjh_human_actions WHERE hand_no = ${hand}`);
  assert.ok(mid.length > 0, '真人动作应该已经落库了');
  for (const h of mid) assert.equal(h.strength, null, '亮牌前不许记真人的牌力');

  // 整张表里根本没有牌面这一类列 —— 不是「没填」，是压根没地方填
  const cols = (store.raw.prepare('PRAGMA table_info(zjh_human_actions)').all() as unknown as { name: string }[])
    .map((c) => c.name);
  for (const forbidden of ['hand', 'cards', 'rank', 'suit', 'self_tier']) {
    assert.ok(!cols.includes(forbidden), `真人表不该有 ${forbidden} 列`);
  }

  // 真人这一行的牌面信息不该以任何形式藏在 opponents 里
  const handStr = human.hand.map((c) => `${c.rank}${c.suit}`).join('');
  for (const h of mid) assert.ok(!String(h.opponents).includes(handStr));

  // 打完这一局，亮过牌的人才被回填
  finishHand(t, rec);
  rec.flush();
  const after = rows(store, `SELECT * FROM zjh_human_actions WHERE hand_no = ${hand}`);
  const settled = JSON.parse(String(
    rows(store, `SELECT * FROM zjh_hand_outcomes WHERE hand_no = ${hand}`)[0]!.players,
  )) as { key: string; isBot: boolean; revealed: boolean }[];
  const me = settled.find((p) => !p.isBot)!;
  if (me.revealed) assert.ok(after.every((h) => h.strength !== null), '亮过牌之后应该全部回填');
  else assert.ok(after.every((h) => h.strength === null), '没亮牌就不该回填');
});

test('篡改对手暗牌不改变真人的特征（信息边界）', () => {
  const store = new Store(':memory:');
  const rec = new TraceRecorder(store, { sync: true });
  const t = table();
  deal(t);
  const human = humanOf(t.state);

  // 换牌用的两副「别的牌」：一副顶天（同花顺），一副垫底（散牌）
  const top: Card[] = [
    { rank: 14, suit: 'S' }, { rank: 13, suit: 'S' }, { rank: 12, suit: 'S' },
  ];
  const bottom: Card[] = [
    { rank: 2, suit: 'S' }, { rank: 5, suit: 'H' }, { rank: 9, suit: 'C' },
  ];
  const tamper = (state: RoomState, alsoSelf: Card[] | null) => {
    const entitled = new Set(state.seen?.[human.id] ?? []);
    const copy = structuredClone(state);
    copy.players.forEach((p, i) => {
      if (p.id === human.id) {
        if (alsoSelf) p.hand = alsoSelf;
        return;
      }
      // 每个对手换成互不相同的牌，避免「碰巧都一样」把差异抹平
      if (!entitled.has(p.id)) p.hand = [top[i % 3]!, bottom[i % 3]!, top[(i + 1) % 3]!];
    });
    return copy;
  };
  const shot = (state: RoomState) => {
    const me = state.players.find((p) => p.id === human.id)!;
    const { features, opponents } = traceHuman(state, me);
    return JSON.stringify({ features, opponents });
  };

  // 他闷着的时候，连他自己的牌都不该影响特征 —— 他自己都还没看
  assert.equal(human.looked, false, '开局他应该还没看牌');
  const blindBase = shot(t.state);
  assert.equal(shot(tamper(t.state, top)), blindBase, '闷着时篡改任何人的牌都不该改变特征');
  assert.equal(shot(tamper(t.state, bottom)), blindBase, '换成最烂的牌也一样');

  // 看过牌之后，自己的牌当然会影响特征，但别人的暗牌仍然不该
  humanStep(t.state, rec, human, { type: 'look' });
  const lookedBase = shot(t.state);
  assert.equal(shot(tamper(t.state, null)), lookedBase, '看过牌后篡改对手暗牌不该改变特征');

  // 连他**有权看到**的那张牌换掉都不该改变特征 —— 今天 `range.ts` 压根不读 `p.hand`，
  // 走的全是下注行为。这一条锁的就是这个性质：哪天有人让它去读牌了，这里会先红。
  const seenCopy = structuredClone(t.state);
  const opp = seenCopy.players.find((p) => p.id !== human.id)!;
  seenCopy.seen = { ...(seenCopy.seen ?? {}), [human.id]: [opp.id] };
  opp.hand = top;
  const seenBase = shot(seenCopy);
  const seenTampered = structuredClone(seenCopy);
  seenTampered.players.find((p) => p.id === opp.id)!.hand = bottom;
  assert.equal(shot(seenTampered), seenBase, '亮给他看过的牌也不进特征');

  // 反证上面几条不是恒等式：真正该看的东西（池子、注档）一动，特征必须跟着动
  const richer = structuredClone(t.state);
  richer.pot += 500;
  richer.betUnit *= 4;
  assert.notEqual(shot(richer), lookedBase, '池子和注档变了，特征必须跟着变');

  // 打到有人比过牌（他因此有权看到某人）之后，边界依然守得住
  finishHand(t, rec);
  rec.flush();
  for (const h of rows(store, 'SELECT * FROM zjh_human_actions')) {
    for (const p of t.state.players) {
      if (p.id === human.id) continue;
      assert.ok(!String(h.opponents).includes(p.hand.map((c) => `${c.rank}${c.suit}`).join('')));
    }
  }
});

test('写库炸了，牌局照样打完', () => {
  const store = new Store(':memory:');
  const boom = () => {
    throw new Error('磁盘满了');
  };
  // sync 模式 = 把最危险的形态摆出来：SQL 就在牌桌的调用栈里炸
  Object.assign(store, {
    insertDecisions: boom, insertHumanActions: boom,
    insertHandOutcome: boom, backfillHumanStrength: boom,
  });
  const rec = new TraceRecorder(store, { sync: true });
  const t = table();

  assert.doesNotThrow(() => {
    playUntilHumanActs(t, rec);
    finishHand(t, rec);
  });
  assert.equal(t.state.phase, 'round_end', '留痕写挂了，这一局还是要打完');
  assert.ok(t.state.result, '结算照出');
  assert.ok(t.state.result!.winnerId, '赢家照算');
  assert.doesNotThrow(() => rec.flush());
});

test('取样炸了也一样：牌局不受任何影响', () => {
  const store = new Store(':memory:');
  const rec = new TraceRecorder(store, { sync: true });
  const t = table();
  deal(t);
  // 传一份坏掉的 record，逼 bot() 在展开的时候炸
  const broken = { decision: null } as never;
  assert.doesNotThrow(() => rec.bot(t.state, broken, { type: 'call' }));
  assert.doesNotThrow(() => finishHand(t, rec));
  assert.equal(t.state.phase, 'round_end');
});

test('非 sync 模式下结算不在调用栈上写库：hand() 返回时库里还没有，flush() 之后才有', () => {
  const store = new Store(':memory:');
  const rec = new TraceRecorder(store); // 生产形态：攒 200ms 一批
  const t = table();
  playUntilHumanActs(t, rec);
  finishHand(t, rec);

  // hand() 已经调过了（finishHand 里），但 SQL 还挂在队列上
  assert.equal(rows(store, 'SELECT * FROM zjh_hand_outcomes').length, 0, '结算不该在 broadcast 的调用栈上写库');
  assert.equal(rows(store, 'SELECT * FROM zjh_decisions').length, 0, '决策同理');
  assert.equal(rows(store, 'SELECT * FROM zjh_human_actions').length, 0, '真人动作同理');

  rec.flush();
  const settledRows = rows(store, `SELECT * FROM zjh_hand_outcomes WHERE hand_no = ${t.state.handNo}`);
  assert.equal(settledRows.length, 1, 'flush 之后才落地');
  assert.ok(rows(store, 'SELECT * FROM zjh_decisions').length > 0);
  const humans = rows(store, 'SELECT * FROM zjh_human_actions');
  assert.ok(humans.length > 0);

  // 顺序也要对：回填改的正是同一批刚写进去的真人行，写反了就找不到行
  const settled = JSON.parse(String(settledRows[0]!.players)) as
    { isBot: boolean; revealed: boolean }[];
  const me = settled.find((p) => !p.isBot)!;
  if (me.revealed) {
    const mine = humans.filter((h) => h.hand_no === t.state.handNo && !String(h.memory_key).startsWith('bot:'));
    assert.ok(mine.length > 0 && mine.every((h) => h.strength !== null), '同一批里回填也要生效');
  }
  rec.stop();
});

test('结算防重：同一局写两次只留一行', () => {
  const store = new Store(':memory:');
  const rec = new TraceRecorder(store, { sync: true });
  const t = table();
  playUntilHumanActs(t, rec);
  finishHand(t, rec);
  rec.hand(t.state);
  rec.hand(t.state);
  rec.flush();
  assert.equal(
    rows(store, `SELECT * FROM zjh_hand_outcomes WHERE hand_no = ${t.state.handNo}`).length, 1,
  );
});

test('复盘五块输出都出得来，--hand 打得出单局全轨迹', () => {
  const store = new Store(':memory:');
  const rec = new TraceRecorder(store, { sync: true });
  const t = table();
  playUntilHumanActs(t, rec);
  finishHand(t, rec);
  rec.flush();

  const md = review(store.raw, {});
  for (const heading of [
    '## (a) 人味统计',
    '## (b) 同一粗特征下的动作分布差异',
    '## (c) 机器人的情绪轨迹与规律触发频次',
    '## (d) 真人的人物原型归类',
    '## (e) 可疑瞬间',
  ]) {
    assert.ok(md.includes(heading), `缺少 ${heading}`);
  }
  assert.ok(md.includes('入池率 VPIP'), '(a) 该有人味指标');
  assert.ok(/机器人决策 \d+ 步/.test(md), '抬头该报样本量');

  const one = review(store.raw, { hand: t.state.handNo });
  assert.ok(one.includes(`## 局 ${t.state.handNo} 全轨迹`), '--hand 该打出全轨迹');
  assert.ok(one.includes('系统 1：'), '全轨迹里要有系统 1 的冲动');
  assert.ok(one.includes('系统 2：'), '全轨迹里要有系统 2 是否介入');
  assert.ok(one.includes('**结算**'), '全轨迹末尾要有结算');

  // 过滤条件不该把不相干的房间/时间带进来
  assert.ok(review(store.raw, { room: '不存在' }).includes('没有机器人决策留痕'));
  assert.ok(review(store.raw, { since: Date.now() + 60_000 }).includes('没有机器人决策留痕'));
});

test('超期留痕先归档成 JSONL 再删，没超期的一行不动', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'zjh-trace-'));
  try {
    const store = new Store(':memory:');
    const rec = new TraceRecorder(store, { sync: true });
    const t = table();
    playUntilHumanActs(t, rec);
    finishHand(t, rec);
    rec.flush();

    const before = rows(store, 'SELECT * FROM zjh_decisions').length;
    assert.ok(before > 0);

    // 保留 30 天：刚写的这一局一行都不该动
    let res = store.archiveTrace(dir, 30 * 24 * 60 * 60 * 1000);
    assert.equal(res.archived, 0);
    assert.equal(rows(store, 'SELECT * FROM zjh_decisions').length, before);

    // 把保留期缩到 0，全部超期
    res = store.archiveTrace(dir, -1);
    assert.ok(res.archived >= before, '决策、真人动作、结算都要归档');
    assert.ok(res.file, '要落一个 JSONL 文件');
    assert.equal(rows(store, 'SELECT * FROM zjh_decisions').length, 0, '归档完才删');
    assert.equal(rows(store, 'SELECT * FROM zjh_hand_outcomes').length, 0);

    const lines = readFileSync(res.file!, 'utf8').trim().split('\n');
    assert.equal(lines.length, res.archived);
    const kinds = new Set(lines.map((l) => (JSON.parse(l) as { t: string }).t));
    assert.ok(kinds.has('decision') && kinds.has('human') && kinds.has('outcome'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('真人用时从「上一次牌局变化」算起：表情和 presence 广播都不该重置', async () => {
  const store = new Store(':memory:');
  const rec = new TraceRecorder(store, { sync: true });
  const hub = new Hub(store, rec);

  const conn = (): Conn => ({
    ws: { readyState: 1, OPEN: 1, send() {} } as unknown as Conn['ws'],
    ip: '127.0.0.1', code: null, playerId: null,
  });
  const a = conn();
  const b = conn();
  await hub.create(a, 'zjh', '真人甲', '🐯');
  const code = a.code!;
  await hub.join(b, code, '真人乙', '🐻');
  hub.command(a, { type: 'ready', ready: true });
  hub.command(b, { type: 'ready', ready: true });
  hub.command(a, { type: 'start' }); // 这是最后一次真正的牌局变化

  const wait = (ms: number) => new Promise((r) => { setTimeout(r, ms); });
  await wait(40);
  // 乙发个表情：这是一条正经指令、会广播，但牌桌一张牌都没动
  hub.command(b, { type: 'emote', id: EMOTES[0]! });
  await wait(40);
  // 乙掉线：同样只广播，不动牌桌
  hub.detach(b);
  await wait(40);
  hub.command(a, { type: 'look' });
  rec.flush();

  const row = rows(store, 'SELECT * FROM zjh_human_actions ORDER BY at DESC')[0]!;
  assert.equal(row.action, 'look');
  // 三段等待都算进去才对（约 120ms）；表情冲掉时钟会变成约 80ms，presence 冲掉是约 40ms
  assert.ok(
    (row.elapsed_ms as number) >= 100,
    `用时该从开局算起（约 120ms），实际 ${row.elapsed_ms}ms —— 有人把时钟冲掉了`,
  );

  hub.detach(a);
  rec.stop();
});

test('筹码被打短的时候 cost_fraction 仍是 0..1 的比例', () => {
  /*
   * `callCost` 给的是**名义**价钱（台面单价 × 还欠的份数），它不管你兜里够不够 ——
   * 引擎那边这一口会自动缩成 allIn，而 `costFraction` 拿名义价钱去除身家，
   * 于是短筹码那几步写进库的是 3、17、甚至 400000。留痕里量到过 47 行 > 1。
   *
   * 这个数不只是脏在库里：它直接进 `look` 的 `costWeight` 那一项和 `atRisk`，
   * 把「这一口疼不疼」顶到饱和之外。所以在 `buildSituation` 的源头收口。
   */
  const { room, bot } = scene({
    // 单价十万，我兜里只剩两万 —— 名义上要掏身家的五倍
    me: { name: '我', hand: HANDS.midFlush, looked: true, bet: 1_000, chips: 20_000 },
    others: [{
      name: 'A', looked: true, bet: 100_000, chips: 900_000,
      events: [ev('raise', true, 100_000, 2)],
    }],
    pot: 200_000, betUnit: 100_000, roundNo: 3, turnCount: 8, position: 'early', compareUnlockAt: 2,
  });
  const persona = personaFor(bot);
  const sit = buildSituation(room, bot, persona, newMind(persona.traits));
  assert.ok(callCost(room, bot) > bot.chips, '这个局面就是要名义价钱超过身家，不然测不到东西');
  assert.ok(sit.costFraction >= 0 && sit.costFraction <= 1,
    `costFraction = ${sit.costFraction}，比例字段不该超过 1`);
  assert.equal(sit.costFraction, 1, '整副身家都要推进去，就是 1');
});
