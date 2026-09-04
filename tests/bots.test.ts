import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMON_PERSONA } from '../shared/zjh/bot/personas/common.ts';
import {
  applyCommand, botAction, botDecision, createHumanPlayer, createInitialRoom, currentPlayer, evaluateHand,
  type GameCommand, type RoomState,
} from '../shared/game.ts';
import { withSeededRandom } from './zjh-arena.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

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

/**
 * 六台机器人自己打，收集每一步的决策，用来检验"像不像人在打牌"。
 *
 * **必须播种。** 这三条形状指标量的是分布，而发牌用的是 `crypto.getRandomValues`：
 * 200 局的样本上「大牌早比」在 2.41%–5.47% 之间抖（8 次实测，合计 94/2380 = 3.95%），
 * 门槛是 5%，于是每三四次就红一次 —— 红的不是打法，是样本量。
 * 播种 + 加大样本让它变成一个确定的数（seed 20260903、1000 局：见各条测试的注释）。
 */
function autoTable(hands: number, seed: number) {
  return withSeededRandom(seed, () => autoTableRaw(hands));
}

function autoTableRaw(hands: number) {
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
      // 口径与 §6.4 / `scripts/zjh-review.ts` 一致：**闷着的人没有牌力**
      // （留痕里 `strength` 为 null），他那一步既不进分子也不进分母。
      // 闷着开牌不是「拿大牌沉不住气」，是闷比 —— 那是另一条 §6.4 指标。
      const monster = looked && cur.hand.length ? evaluateHand(cur.hand).category >= 5 : false;
      if (monster && !seenMonster.has(cur.id)) { seenMonster.add(cur.id); shape.monsters++; }
      const cmd = botDecision(room, cur);
      shape.actions++;
      if (cmd.type === 'fold') { shape.folds++; if (!looked) shape.blindFolds++; }
      // 人多的时候，比牌刚一解锁就拿豹子开牌是最不像人的一步。
      if (cmd.type === 'compare' && monster && round <= 2 && field >= 3) shape.earlyMonsterCompares++;
      applyCommand(room, cur.id, cmd);
    }
    shape.survivorsSum += field;
    shape.handsPlayed++;
  }
  return shape;
}

/**
 * 三条形状指标共用同一批对局（1000 局、seed 20260903）：它们量的是同一桌牌的
 * 不同侧面，分开跑既慢又没有额外信息。
 */
const SHAPE = autoTable(1000, 20260903);
console.log(`[形状] 局数 ${SHAPE.handsPlayed} 闷弃占弃牌 `
  + `${((SHAPE.blindFolds / SHAPE.folds) * 100).toFixed(2)}% (${SHAPE.blindFolds}/${SHAPE.folds})`
  + `  平均收官人数 ${(SHAPE.survivorsSum / SHAPE.handsPlayed).toFixed(3)}`
  + `  大牌早比(已看牌) ${((SHAPE.earlyMonsterCompares / SHAPE.monsters) * 100).toFixed(2)}% `
  + `(${SHAPE.earlyMonsterCompares}/${SHAPE.monsters})`);

test('闷牌的机器人不会因为先验算错而集体弃牌', () => {
  const shape = SHAPE;
  const blindShare = shape.blindFolds / Math.max(1, shape.folds);
  // 旧模型把闷牌当成"我确定拿了一手中间牌"，再做 0.5^5 = 3% 的指数，
  // 低于任何底池赔率 —— 于是三成弃牌都是闷着就走，牌局根本打不起来。
  assert.ok(blindShare < 0.12, `闷着就弃占了弃牌的 ${(blindShare * 100).toFixed(1)}%`);
});

test('一桌机器人不会互相弃到只剩一个人，牌是要打到摊牌的', () => {
  const shape = SHAPE;
  const survivors = shape.survivorsSum / shape.handsPlayed;
  assert.ok(survivors >= 1.8, `平均收官人数只有 ${survivors.toFixed(2)}，等于没人真的比过牌`);
});

test('人多的时候，拿到豹子/顺金（且已看牌）不会在比牌一解锁就开牌', () => {
  const shape = SHAPE;
  const rate = shape.earlyMonsterCompares / Math.max(1, shape.monsters);
  // 比牌是把强牌立刻变现，只赢到眼下这点底池还公开了自己的牌力。
  // 人会先养池；机器人也必须先养池。
  assert.ok(rate < 0.05, `${(rate * 100).toFixed(1)}% 的大牌（已看牌）在前两轮就多人局比牌`);
});

/* ------------------------------------------------------------- 决策耗时 */

/**
 * `botAction`（含信息边界克隆 + `decideBot` 全部分支）单次决策的耗时基准。
 *
 * 用真实对局跑出样本，而不是单挑一个固定局面：闷牌、看牌、比牌解锁、
 * 全场梭哈接注……每种分支的耗时都不一样，只测一种局面会挑到最快的那条路。
 * 断言取**中位数** < 5ms；p95 一并打印出来存档，不做硬性断言 ——
 * 个别最坏样本受 GC/JIT 热身影响，不该让一条测试偶发抖动。
 */
test('决策耗时：单次 botAction 中位数 < 5ms', () => {
  const samples: number[] = [];
  for (let h = 0; h < 60; h++) {
    const room = table(1, 5);
    room.players[0].isBot = true;
    applyCommand(room, room.hostId, { type: 'start' });
    let guard = 0;
    while (room.phase === 'playing' && guard++ < 400) {
      const cur = currentPlayer(room);
      if (!cur) break;
      const t0 = performance.now();
      const { cmd } = botAction(room, cur);
      samples.push(performance.now() - t0);
      applyCommand(room, cur.id, cmd);
    }
  }
  samples.sort((a, b) => a - b);
  assert.ok(samples.length > 500, `样本太少：${samples.length} 步，测不出稳定的中位数`);
  const median = samples[Math.floor(samples.length / 2)];
  const p95 = samples[Math.floor(samples.length * 0.95)];
  console.log(`[决策耗时] 样本=${samples.length} 中位数=${median.toFixed(3)}ms p95=${p95.toFixed(3)}ms`);
  assert.ok(median < 5, `单步决策中位数耗时 ${median.toFixed(3)}ms，超过 5ms 预算`);
});

/* ------------------------------------------------------------------ 文档与代码的常数对账 */

/**
 * 设计文档 §4.5.2 / §4.7.7 的两张表就是**代码里的数**本身。
 *
 * 这两条测试双向卡死：表里写的每一个数必须等于代码里的那个数，
 * 代码里的每一个带名字的常数、人物卡上的每一个数也必须在表里出现。
 * 于是「调参不改文档」和「文档写了代码没有」两种漂移都当场变红 ——
 * 这正是 P2 验收退回的第 6 条要的东西。
 */
const DOC = readFileSync(join(HERE, '..', 'docs', 'zjh', 'BOT-BRAIN-DESIGN-2026-09-03.md'), 'utf8');

function section(title: string): string {
  const from = DOC.indexOf(`#### ${title}`);
  assert.ok(from >= 0, `设计文档里找不到 ${title}`);
  const next = DOC.indexOf('\n#', from + 5);
  return DOC.slice(from, next < 0 ? DOC.length : next);
}

/** 取一张 markdown 表的「第一格 = 反引号里的名字」那些行，返回 名字 → 第二格原文。 */
function tableRows(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^\|\s*`([^`]+)`\s*\|([^|]*)\|/.exec(line);
    if (m) out.set(m[1], m[2].trim());
  }
  return out;
}

test('设计文档 §4.5.2 的常数表和代码里的常数逐个对得上', () => {
  const doc = tableRows(section('4.5.2'));
  const dir = join(HERE, '..', 'shared', 'zjh', 'bot');
  const code = new Map<string, number>();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.ts')) continue;
    const src = readFileSync(join(dir, f), 'utf8');
    for (const m of src.matchAll(/^(?:export )?const ([A-Z][A-Z_0-9]+) = (-?[\d.]+);$/gm)) {
      code.set(m[1], Number(m[2]));
    }
  }
  assert.ok(code.size >= 20, `代码里应该有二十来个常数，实际 ${code.size}`);

  const wrong: string[] = [];
  for (const [name, value] of code) {
    if (!doc.has(name)) { wrong.push(`${name} = ${value} 在代码里，文档 §4.5.2 没写`); continue; }
    const docValue = Number(doc.get(name));
    if (docValue !== value) wrong.push(`${name}：代码 ${value}，文档 ${doc.get(name)}`);
  }
  for (const name of doc.keys()) {
    if (!code.has(name)) wrong.push(`${name} 写在文档 §4.5.2 里，代码里没有`);
  }
  assert.deepEqual(wrong, [], `文档 §4.5.2 与代码漂移：\n  ${wrong.join('\n  ')}`);
});

test('设计文档 §4.7.7 的常人卡数值表和 COMMON_PERSONA 逐个对得上', () => {
  const doc = tableRows(section('4.7.7'));
  const wrong: string[] = [];

  /** 把「weight 0.10 / commit 0.30」「monster 1.06 / strong 1.00」这种格子拆成键值对。 */
  const pairs = (cell: string): Record<string, number> | undefined => {
    const out: Record<string, number> = {};
    let any = false;
    for (const part of cell.split('/')) {
      const m = /^\s*([A-Za-z]+)\s+(-?[\d.]+)\s*$/.exec(part);
      if (!m) return undefined;
      out[m[1]] = Number(m[2]);
      any = true;
    }
    return any ? out : undefined;
  };

  const at = (path: string): unknown =>
    path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], COMMON_PERSONA);

  for (const [path, cell] of doc) {
    const actual = at(path);
    if (actual === undefined) { wrong.push(`${path} 写在文档 §4.7.7 里，人物卡上没有`); continue; }
    const scalar = /^(-?[\d.]+)(?: ms)?$/.exec(cell);
    if (scalar) {
      if (actual !== Number(scalar[1])) wrong.push(`${path}：代码 ${String(actual)}，文档 ${cell}`);
      continue;
    }
    if (cell === 'true' || cell === 'false') {
      if (actual !== (cell === 'true')) wrong.push(`${path}：代码 ${String(actual)}，文档 ${cell}`);
      continue;
    }
    const quoted = /^`'(.+)'`$/.exec(cell);
    if (quoted) {
      if (actual !== quoted[1]) wrong.push(`${path}：代码 ${String(actual)}，文档 ${cell}`);
      continue;
    }
    const kv = pairs(cell);
    if (!kv) { wrong.push(`${path}：文档那一格「${cell}」看不懂`); continue; }
    for (const [k, v] of Object.entries(kv)) {
      const got = (actual as Record<string, number>)[k];
      if (got !== v) wrong.push(`${path}.${k}：代码 ${String(got)}，文档 ${v}`);
    }
  }

  // 反向：人物卡上每一个数都要在表里。`traits` 在 §4.9.6，不在这张表。
  const walk = (node: unknown, path: string) => {
    if (typeof node === 'number' || typeof node === 'boolean' || typeof node === 'string') {
      const own = doc.has(path);
      const parent = doc.has(path.split('.').slice(0, -1).join('.'));
      if (!own && !parent) wrong.push(`${path} = ${String(node)} 在人物卡上，文档 §4.7.7 没写`);
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) walk(v, path ? `${path}.${k}` : k);
  };
  for (const [k, v] of Object.entries(COMMON_PERSONA)) {
    if (k === 'traits' || k === 'leaks' || k === 'name') continue;
    if (k === 'emotes') { walk(COMMON_PERSONA.emotes.rate, 'emotes.rate'); walk(COMMON_PERSONA.emotes.cap, 'emotes.cap'); continue; }
    walk(v, k);
  }

  assert.deepEqual(wrong, [], `文档 §4.7.7 与人物卡漂移：\n  ${wrong.join('\n  ')}`);
});
