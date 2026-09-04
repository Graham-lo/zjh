/** node scripts/zjh-generate-model.ts [hands-per-persona=2000]
 * Offline, deterministic self-play; hidden cards are used only as simulator labels.
 * Runtime readers receive public counters and this frozen artifact, never simulator labels.
 */
import { writeFileSync } from 'node:fs';
import { modelSourceHash } from './zjh-model-source.ts';
import { applyCommand, botAction, createHumanPlayer, createInitialRoom, currentPlayer,
  handPercentile, startRound, type DealMode } from '../shared/game.ts';
import { PERSONAS } from '../shared/zjh/bot/personas/index.ts';
import { buckets, bucketOf, warmUpRange } from '../shared/zjh/bot/range.ts';
import { emptyPublicStats, observePublic, publicVector, likelihoodCell, learnedModel,
  classifyPublic, type LearnedModel, type LearnedProfile } from '../shared/zjh/bot/learned.ts';
import { withSeededRandom } from '../tests/zjh-arena.ts';
import { botOpponentViews, candidatesOf } from '../shared/zjh/bot/situation.ts';
import { unitTier } from '../shared/zjh/bot/events.ts';

const hands = Number(process.argv[2] ?? 2000);
if (!Number.isInteger(hands) || hands < 500 || hands % 100 !== 0) {
  throw new Error('at least 500 hands per persona, in complete 100-hand blocks');
}
const names = [...Object.keys(PERSONAS), '常人'];
const seed = 20260905;
const sourceHash = modelSourceHash();
// Bootstrap always reads the analytic common prior. An existing artifact cannot change its own generator.
learnedModel.profiles = {};
const model: LearnedModel = { version: 1, seed, handsPerPersona: hands, sourceHash, profiles: {} };
const holdout: { name: string; stats: ReturnType<typeof emptyPublicStats> }[] = [];
warmUpRange();
for (const name of names) {
  const vectors: number[][] = [];
  const p: LearnedProfile = { mean: [], variance: [], samples: 0, tables: {} };
  for (const mode of ['standard', 'party'] as DealMode[]) {
    withSeededRandom(seed + names.indexOf(name) * 100003 + (mode === 'party' ? 4000001 : 0), () => {
      for (let block = 0; block < Math.ceil(hands / 100); block++) {
        const host = createHumanPlayer(name, '🙂', 0, 'p0'); host.isBot = true;
        const room = createInitialRoom('MODEL1', host); room.settings.dealMode = mode;
        for (let seat = 1; seat < 6; seat++) {
          const other = createHumanPlayer(names[(names.indexOf(name) + seat + block) % names.length], '🙂', seat, `p${seat}`);
          other.isBot = true; room.players.push(other);
        }
        const stats = emptyPublicStats();
        const train = block % 5 !== 4;
        for (let h = 0; h < Math.min(100, hands - block * 100); h++) {
          for (const player of room.players) { player.chips = room.settings.startingChips; player.ready = true; }
          startRound(room, room.hostId);
          let steps = 0;
          while (room.phase === 'playing') {
            if (++steps > 600) throw new Error('simulation exceeded step budget');
            const me = currentPlayer(room)!;
            const act = botAction(room, me);
            if (me.id === host.id && ['call', 'raise', 'compare', 'all_in', 'fold'].includes(act.cmd.type)) {
              const e = { kind: act.cmd.type as 'call', looked: me.looked,
                unit: act.cmd.type === 'raise' ? act.cmd.unit : room.betUnit,
                roundNo: room.roundNo, at: 0, msSpent: act.thinkMs };
              observePublic(stats, e);
              if (train && me.looked) {
                const idx = bucketOf(handPercentile(me.hand, mode), mode);
                const candidates = candidatesOf(room, me, botOpponentViews(room, me));
                const legal = new Set(candidates.map(c => c.cmd.type));
                const record = (key: string, chosen: boolean) => {
                  const cell = p.tables[key] ??= { opportunities: buckets(mode).map(() => 0), counts: buckets(mode).map(() => 0) };
                  cell.opportunities[idx]++;
                  if (chosen) cell.counts[idx]++;
                };
                for (const kind of ['call', 'raise', 'compare', 'all_in', 'fold'] as const) {
                  if (!legal.has(kind)) continue;
                  const key = likelihoodCell(mode, { ...e, kind });
                  record(key, kind === e.kind);
                  const tiers = new Set(candidates.filter(c => c.cmd.type === kind)
                    .map(c => unitTier(c.unit ?? room.betUnit, room.settings)));
                  for (const tier of tiers) record(likelihoodCell(mode, { ...e, kind }, tier),
                    kind === e.kind && tier === unitTier(e.unit, room.settings));
                }
              }
            }
            applyCommand(room, me.id, act.cmd, act.thinkMs);
          }
          applyCommand(room, room.hostId, { type: 'new_round' });
        }
        if (train) { vectors.push(publicVector(stats)); p.samples += stats.actions; }
        else holdout.push({ name, stats });
      }
    });
  }
  p.mean = vectors[0].map((_, i) => vectors.reduce((a, v) => a + v[i], 0) / vectors.length);
  p.variance = p.mean.map((m, i) => vectors.reduce((a, v) => a + (v[i] - m) ** 2, 0) / Math.max(1, vectors.length - 1));
  model.profiles[name] = p;
  console.log(`${name}: ${p.samples} training actions, ${vectors.length} training blocks`);
}
const named = holdout.filter(h => h.name !== '常人');
const confusion: Record<string, Record<string, number>> = {};
let correct = 0;
for (const h of named) {
  const guessed = classifyPublic(h.stats, model)?.name ?? 'unknown';
  (confusion[h.name] ??= {})[guessed] = (confusion[h.name]?.[guessed] ?? 0) + 1;
  correct += +(guessed === h.name);
}
const report = { sourceHash, seed, handsPerPersona: hands, modes: ['standard', 'party'],
  split: 'every fifth 100-hand block held out; independent rooms; no hidden features in classifier',
  correct, total: named.length, accuracy: correct / named.length, confusion,
  features: ['blind/action', 'raise/action', 'compare/action', 'shove/action', 'fold/action',
    'call/action', 'looked-round1/action', 'log1p(mean-ms)'],
  pairwise: names.filter(n => n !== '常人').flatMap((a, i, xs) => xs.slice(i + 1).map(b => {
    const pa = model.profiles[a], pb = model.profiles[b];
    const sigma = pa.mean.map((m, k) => Math.abs(m - pb.mean[k])
      / Math.sqrt(Math.max(0.0001, (pa.variance[k] + pb.variance[k]) / 2)));
    return { a, b, sigma, separatedFeatures: sigma.filter(s => s > 1).length };
  })) };
writeFileSync('shared/zjh/bot/learned-model.json', JSON.stringify(model) + '\n');
writeFileSync('docs/zjh/persona-model-validation.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
