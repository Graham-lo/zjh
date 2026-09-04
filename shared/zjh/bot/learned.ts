/** Offline self-play model. Runtime features contain public actions only. */
import artifact from './learned-model.json' with { type: 'json' };
import { unitTier, type HandEvent } from './events.ts';
import type { DealMode, GameSettings } from '../../game.ts';

export interface PublicStats {
  actions: number; blind: number; raises: number; compares: number; shoves: number;
  folds: number; calls: number; ms: number; timed: number; earlyLooks: number;
}
export const emptyPublicStats = (): PublicStats => ({ actions: 0, blind: 0, raises: 0,
  compares: 0, shoves: 0, folds: 0, calls: 0, ms: 0, timed: 0, earlyLooks: 0 });
export function addPublicStats(a: PublicStats, b: PublicStats): PublicStats {
  return Object.fromEntries(Object.keys(a).map(k => [k, a[k as keyof PublicStats] + b[k as keyof PublicStats]])) as unknown as PublicStats;
}
export function observePublic(s: PublicStats, e: HandEvent): void {
  s.actions++; s.blind += +!e.looked;
  s.raises += +(e.kind === 'raise'); s.compares += +(e.kind === 'compare');
  s.shoves += +(e.kind === 'all_in'); s.folds += +(e.kind === 'fold'); s.calls += +(e.kind === 'call');
  s.earlyLooks += +(e.looked && e.roundNo === 1);
  if (e.msSpent !== undefined) { s.ms += e.msSpent; s.timed++; }
}
export function publicVector(s: PublicStats): number[] {
  const n = Math.max(1, s.actions);
  return [s.blind / n, s.raises / n, s.compares / n, s.shoves / n, s.folds / n,
    s.calls / n, s.earlyLooks / n, Math.log1p(s.ms / Math.max(1, s.timed))];
}
export interface LearnedProfile { mean: number[]; variance: number[]; samples: number;
  tables: Record<string, { opportunities: number[]; counts: number[] }> }
export interface LearnedModel { version: number; seed: number; handsPerPersona: number;
  sourceHash: string; profiles: Record<string, LearnedProfile> }
export const learnedModel = artifact as LearnedModel;
export function classifyPublic(s: PublicStats | undefined, model: LearnedModel = learnedModel):
  { name: string; confidence: number } | undefined {
  if (!s || s.actions < 80) return undefined;
  const v = publicVector(s);
  const ranked = Object.entries(model.profiles).map(([name, p]) => ({ name,
    distance: v.reduce((sum, x, i) => sum + (x - p.mean[i]) ** 2 / Math.max(0.0001, p.variance[i]), 0) / v.length,
  })).sort((a, b) => a.distance - b.distance);
  if (ranked.length < 2) return undefined;
  // A relative winner is not necessarily a match (especially for human pacing).
  // Keep behavior outside the simulated envelope unknown instead of forcing a persona.
  if (ranked[0].distance > 9) return undefined;
  const confidence = Math.max(0, Math.min(1, 1 - ranked[0].distance / Math.max(0.01, ranked[1].distance)));
  return { name: ranked[0].name, confidence };
}
export const likelihoodCell = (mode: DealMode, e: Pick<HandEvent, 'kind' | 'roundNo'>, tier?: number) =>
  `${mode}:${e.kind}:${e.roundNo <= 2 ? 'early' : 'late'}${tier === undefined ? '' : `:tier${tier}`}`;
/** P(action|bucket), smoothed by observed action frequency; never infer strength from blind actions. */
export function learnedLikelihood(name: string | undefined, mode: DealMode, e: HandEvent,
  settings?: Pick<GameSettings, 'betOptions'>): number[] | undefined {
  if (!name || !e.looked) return undefined;
  const tables = learnedModel.profiles[name]?.tables;
  const priced = settings ? tables?.[likelihoodCell(mode, e, unitTier(e.unit, settings))] : undefined;
  const enough = (c: typeof priced) => c && c.opportunities.reduce((a, b) => a + b, 0) >= 200
    && c.counts.reduce((a, b) => a + b, 0) >= 20;
  const cell = enough(priced) ? priced : tables?.[likelihoodCell(mode, e)];
  if (!cell) return undefined;
  const total = cell.opportunities.reduce((a, b) => a + b, 0);
  const count = cell.counts.reduce((a, b) => a + b, 0);
  if (total < 200 || count < 20) return undefined;
  const base = count / total;
  return cell.counts.map((n, i) => (n + base * 20) / (cell.opportunities[i] + 20) / base);
}
