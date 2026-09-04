import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyPublicStats, observePublic, publicVector, classifyPublic, learnedModel,
  learnedLikelihood } from '../shared/zjh/bot/learned.ts';
import { archetypeOf, emptyMemory, memoryKey, normalizeSocialKeys, socialValue,
  toTableRead, credibility, mergeMemory } from '../shared/zjh/bot/profile.ts';
import { newMind } from '../shared/mind/emotion.ts';
import { COMMON_TRAITS } from '../shared/mind/traits.ts';
import { applyCommand, botAction, createHumanPlayer, createInitialRoom, currentPlayer,
  startRound } from '../shared/game.ts';
import { withSeededRandom } from './zjh-arena.ts';
import { ev } from './zjh-helpers.ts';
import validation from '../docs/zjh/persona-model-validation.json' with { type: 'json' };
import { modelSourceHash } from '../scripts/zjh-model-source.ts';

test('P3 分类器只接受公开计数，样本不足保持未知', () => {
  const stats = emptyPublicStats();
  observePublic(stats, { ...ev('raise', false, 1000), msSpent: 500 });
  assert.equal(classifyPublic(stats), undefined);
  assert.deepEqual(publicVector(stats).slice(0, 7), [1, 1, 0, 0, 0, 0, 0]);
  assert.equal(archetypeOf({ ...toTableRead(undefined), hands: 100, publicStats: stats }, 'fine').learned, undefined);
});
test('P3 留出局的八人格识别率达到 80%，两档都采样', () => {
  assert.equal(validation.sourceHash, learnedModel.sourceHash);
  assert.equal(learnedModel.sourceHash, modelSourceHash(), '源码已变化，必须重新生成并验收模型');
  assert.ok(validation.total >= 16);
  assert.ok(validation.accuracy >= 0.8, `held-out accuracy ${validation.accuracy}`);
  assert.deepEqual(validation.modes, ['standard', 'party']);
  assert.equal(Object.keys(learnedModel.profiles).length, 9);
  assert.equal(validation.pairwise.length, 28);
  assert.ok(validation.pairwise.every(p => p.separatedFeatures >= 2), '任意两人至少两项公开指标相差一个合并标准差');
});

test('P3 远离模拟分布的行为保持未知，不强行归类真人', () => {
  const stats = emptyPublicStats();
  for (let i = 0; i < 100; i++) observePublic(stats, { ...ev('fold', false, 1000), msSpent: 60_000 });
  assert.equal(classifyPublic(stats), undefined);
});
test('P3 生成似然不从闷牌动作推断暗牌，稀疏格不凭空制造信号', () => {
  for (const name of Object.keys(learnedModel.profiles)) {
    assert.equal(learnedLikelihood(name, 'standard', ev('raise', false, 1000)), undefined);
    for (const cell of Object.values(learnedModel.profiles[name].tables)) {
      assert.equal(cell.counts.length, 40);
      assert.ok(cell.counts.every((n, i) => n >= 0 && n <= cell.opportunities[i]));
    }
  }
});
test('P3 社交记忆迁移为稳定身份，跨房间、改昵称不丢失真人记忆', () => {
  const old = createHumanPlayer('朋友', '🙂', 1, 'old-seat'); old.accountId = 'account-1';
  const mind = newMind(COMMON_TRAITS);
  mind.revenge[old.id] = 0.7; mind.pressedBy[old.id] = 3;
  mind.bluffedBy[old.id] = 1; mind.impression[old.id] = { peak: -0.5, last: -0.3 };
  normalizeSocialKeys(mind, [old]);
  assert.equal(mind.revenge[old.id], undefined);
  const next = { ...old, id: 'new-seat', name: '新昵称' };
  assert.equal(socialValue(mind.revenge, [next], next.id), 0.7);
  assert.equal(mind.pressedBy[memoryKey(next)], 3);
  assert.equal(mind.impression[memoryKey(next)].last, -0.3);
});
test('R17 最近三局改变读人，关闭该特征恢复累计统计；旧快照可读', () => {
  const base = { ...toTableRead(undefined), hands: 12, showdowns: 8, showdownStrength: 5.6,
    pressureFaced: 16, foldsToPressure: 8 };
  const recent = Array.from({ length: 3 }, () => ({ ...toTableRead(undefined), hands: 1,
    showdowns: 2, showdownStrength: 0.4, pressureFaced: 4, foldsToPressure: 0, bluffsCaught: 1 }));
  assert.ok(credibility({ ...base, recent }) < credibility(base));
  assert.equal(credibility({ ...base, recent }, 0), credibility(base, 0));
  assert.equal(toTableRead(emptyMemory('old')).recent, undefined);
});

test('P3 实际结算记录公开动作和三局窗口，JSON 往返后继续累计', () => {
  withSeededRandom(202609051, () => {
    const host = createHumanPlayer('甲', '🙂', 0, 'p0'); host.isBot = true;
    let room = createInitialRoom('MEM001', host);
    for (let i = 1; i < 4; i++) {
      const p = createHumanPlayer(`常人${i}`, '🙂', i, `p${i}`); p.isBot = true;
      room.players.push(p);
    }
    for (let hand = 0; hand < 5; hand++) {
      for (const p of room.players) { p.chips = room.settings.startingChips; p.ready = true; }
      startRound(room, room.hostId);
      let steps = 0;
      while (room.phase === 'playing') {
        assert.ok(++steps < 600);
        const p = currentPlayer(room)!;
        const a = botAction(room, p);
        applyCommand(room, p.id, a.cmd, a.thinkMs);
      }
      for (const p of room.players) {
        const m = room.memory![memoryKey(p)];
        assert.equal(m.hands, hand + 1);
        assert.equal(m.recent?.length, Math.min(3, hand + 1));
        assert.ok(m.recent!.every(r => r.read.hands === 1));
        assert.equal(m.handStart, undefined);
        if (m.publicStats) {
          const s = m.publicStats;
          assert.equal(s.actions, s.calls + s.raises + s.folds + s.shoves + s.compares);
          assert.equal(s.timed, s.actions);
        }
      }
      applyCommand(room, room.hostId, { type: 'new_round' });
      room = JSON.parse(JSON.stringify(room));
    }
  });
});

test('P3 补水合并公开计数，最近窗口按时间保留三局', () => {
  const stored = emptyMemory('person'); const pending = emptyMemory('person');
  stored.publicStats = emptyPublicStats(); pending.publicStats = emptyPublicStats();
  observePublic(stored.publicStats, ev('raise', true, 1000));
  observePublic(pending.publicStats, ev('call', false, 1000));
  stored.recent = [1, 2, 3].map(at => ({ at, read: { ...toTableRead(undefined), hands: 1 } }));
  pending.recent = [{ at: 4, read: { ...toTableRead(undefined), hands: 1 } }];
  const merged = mergeMemory(stored, pending);
  assert.equal(merged.publicStats!.actions, 2);
  assert.equal(merged.publicStats!.raises, 1);
  assert.equal(merged.publicStats!.calls, 1);
  assert.deepEqual(merged.recent!.map(r => r.at), [2, 3, 4]);
});
