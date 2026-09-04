/**
 * 决策留痕复盘（设计文档 §4.11.2）。
 *
 *   node scripts/zjh-review.ts [--db <路径>] [--since <天数|ISO 日期>] [--room <房号>] [--hand <局号>]
 *
 * 输出 Markdown 到 stdout，五块：
 *
 *   (a) §6.4 人味统计 —— 机器人和真人分开算，同一套口径
 *   (b) 同一粗特征下两边动作分布的差异排行 —— 差异最大的格子就是「不像人」的候选
 *   (c) 每个机器人的情绪轨迹与触发规律频次
 *   (d) 真人在人物原型上的归类与置信度
 *   (e) 可疑瞬间清单
 *
 * `--hand <局号>` 会额外打出那一局的逐步全轨迹（机器人和真人交错按时间排）。
 *
 * 这个脚本**只读**：它不写库、不改任何行，跑一百遍和跑一遍是一样的。
 */

import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { archetypeOf, credibility, toTableRead, type BotMemory } from '../shared/zjh/bot/profile.ts';
import { categoryBands, type DealMode } from '../shared/game.ts';

/* ------------------------------------------------------------------ 类型 */

export interface ReviewOptions {
  /** 只看这个时刻之后的行（毫秒时间戳） */
  since?: number;
  room?: string;
  /** 给这一局额外打一份逐步全轨迹 */
  hand?: number;
}

interface DecisionRecord {
  at: number;
  room: string;
  hand_no: number;
  round_no: number;
  memory_key: string;
  persona: string;
  /** 发牌档。2026-09-04 之前的老行是 NULL，按 standard 读。 */
  deal_mode: string | null;
  off_turn: number;
  self_tier: number | null;
  threat_tier: number;
  stake_tier: number;
  familiarity: number;
  standing: number;
  strength: number | null;
  story: number;
  unit_tier: number;
  pot_maturity: number;
  active_count: number;
  position: number;
  blind: number;
  cost_fraction: number;
  pot: number;
  counterpart_key: string | null;
  opponents: string;
  emotions: string;
  drives: string;
  tilt: number;
  ease: number;
  arousal: number;
  fatigue: number;
  willpower: number;
  impulse_key: string;
  confidence: number;
  felt_strength: number;
  felt_threat: number;
  p2: number;
  engaged: number;
  deliberate_key: string | null;
  deliberate_score: number | null;
  difficulty: number | null;
  overridden: number;
  /** 三态：NULL = 那一步没开系统 2 也没有对照，偏没偏离**不知道** */
  deviated: number | null;
  gap: number;
  need: number;
  fired: string;
  plan: string | null;
  plan_commit: number | null;
  action: string;
  action_unit: number | null;
  target_id: string | null;
  think_ms: number;
}

interface HumanRecord {
  at: number;
  room: string;
  hand_no: number;
  round_no: number;
  account_id: string | null;
  memory_key: string;
  deal_mode: string | null;
  threat_tier: number;
  stake_tier: number;
  familiarity: number;
  standing: number;
  strength: number | null;
  story: number;
  unit_tier: number;
  pot_maturity: number;
  active_count: number;
  position: number;
  blind: number;
  cost_fraction: number;
  pot: number;
  counterpart_key: string | null;
  opponents: string;
  action: string;
  action_unit: number | null;
  target_id: string | null;
  elapsed_ms: number;
  looked: number;
}

interface OutcomeRecord {
  at: number;
  room: string;
  hand_no: number;
  winner_key: string;
  winner_name: string;
  pot: number;
  reason: string;
  deal_mode: string | null;
  players: string;
  emotion_delta: string;
}

interface OutcomePlayer {
  id: string;
  key: string;
  name: string;
  isBot: boolean;
  bet: number;
  net: number;
  delta: number;
  revealed: boolean;
  strength?: number;
}

/** 两边都能算的一套口径。真人算不出来的项（主观牌力）不在里面。 */
interface HumanFeel {
  actions: number;
  hands: number;
  /** 入池：一局里除了看牌之外还做过事 */
  vpip: number;
  raise: number;
  call: number;
  fold: number;
  compare: number;
  allIn: number;
  look: number;
  blindActs: number;
  blindFold: number;
  blindCompare: number;
  pressure: number;
  pressureFold: number;
  earlyCompare: number;
  bigStrengthEarlyCompare: number;
  thirdRoundBlind: number;
  handsSeen: number;
  timeSum: number;
  timeN: number;
}

/* ------------------------------------------------------------------ 工具 */

const ACTIONS = ['fold', 'call', 'raise', 'compare', 'all_in', 'look'] as const;
type ActionName = (typeof ACTIONS)[number];

function pct(n: number, d: number): string {
  if (!d) return '—';
  return `${((n / d) * 100).toFixed(1)}%`;
}

function num(n: number | null | undefined, digits = 2): string {
  return n === null || n === undefined ? '—' : n.toFixed(digits);
}

/** 情绪/驱力向量打成一行人看得懂的字，别把原始 JSON 甩在报告里。 */
function vec(json: string): string {
  const o = parseJson<Record<string, number>>(json, {});
  const parts = Object.entries(o)
    .filter(([, v]) => Math.abs(v) >= 0.005)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(([k, v]) => `${k} ${v.toFixed(2)}`);
  return parts.length ? parts.join('，') : '全接近 0';
}

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/** 「顶着压力」的判定：跟一口要掏身家的 8% 以上，或者桌上的故事已经讲得很凶。 */
function underPressure(costFraction: number, story: number): boolean {
  return costFraction >= 0.08 || story >= 0.6;
}

function emptyFeel(): HumanFeel {
  return {
    actions: 0, hands: 0, vpip: 0, raise: 0, call: 0, fold: 0, compare: 0, allIn: 0, look: 0,
    blindActs: 0, blindFold: 0, blindCompare: 0, pressure: 0, pressureFold: 0,
    earlyCompare: 0, bigStrengthEarlyCompare: 0, thirdRoundBlind: 0, handsSeen: 0,
    timeSum: 0, timeN: 0,
  };
}

/** 把一行（机器人的或真人的）折进人味统计。两边走的是同一段代码，口径才真的一样。 */
function foldInto(
  feel: HumanFeel,
  a: {
    action: string; blind: number; roundNo: number; costFraction: number; story: number;
    strength: number | null; timeMs: number;
    /** 这一行是在哪个发牌档上产生的 —— 「大牌」的档线随档位走，不能写死一个分位。 */
    dealMode: DealMode;
  },
) {
  feel.actions++;
  const act = a.action as ActionName;
  if (act === 'raise') feel.raise++;
  else if (act === 'call') feel.call++;
  else if (act === 'fold') feel.fold++;
  else if (act === 'compare') feel.compare++;
  else if (act === 'all_in') feel.allIn++;
  else if (act === 'look') feel.look++;
  if (a.blind) {
    feel.blindActs++;
    if (act === 'fold') feel.blindFold++;
    if (act === 'compare') feel.blindCompare++;
  }
  if (underPressure(a.costFraction, a.story)) {
    feel.pressure++;
    if (act === 'fold') feel.pressureFold++;
  }
  if (act === 'compare' && a.roundNo <= 2) {
    feel.earlyCompare++;
    // 「大牌」= 顺金以上，档线从 `categoryBands(a.dealMode)` 取（§6.4 与 bots.test.ts 同口径）。
    if ((a.strength ?? 0) >= categoryBands(a.dealMode)[5][0]) feel.bigStrengthEarlyCompare++;
  }
  if (a.timeMs > 0) {
    feel.timeSum += a.timeMs;
    feel.timeN++;
  }
}

/* --------------------------------------------------------------- 读库 */

function where(opts: ReviewOptions, extra?: string): { sql: string; args: (string | number)[] } {
  const parts: string[] = [];
  const args: (string | number)[] = [];
  if (opts.since !== undefined) {
    parts.push('at >= ?');
    args.push(opts.since);
  }
  if (opts.room) {
    parts.push('room = ?');
    args.push(opts.room);
  }
  if (extra) parts.push(extra);
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', args };
}

function load(db: DatabaseSync, opts: ReviewOptions) {
  const w = where(opts);
  const decisions = db.prepare(`SELECT * FROM zjh_decisions ${w.sql} ORDER BY at`)
    .all(...w.args) as unknown as DecisionRecord[];
  const humans = db.prepare(`SELECT * FROM zjh_human_actions ${w.sql} ORDER BY at`)
    .all(...w.args) as unknown as HumanRecord[];
  const outcomes = db.prepare(`SELECT * FROM zjh_hand_outcomes ${w.sql} ORDER BY at`)
    .all(...w.args) as unknown as OutcomeRecord[];
  return { decisions, humans, outcomes };
}

/* ------------------------------------------------------- (a) 人味统计 */

function feelOf(decisions: DecisionRecord[], humans: HumanRecord[]) {
  const bot = emptyFeel();
  const human = emptyFeel();
  for (const d of decisions) {
    foldInto(bot, {
      action: d.action, blind: d.blind, roundNo: d.round_no, costFraction: d.cost_fraction,
      story: d.story, strength: d.strength, timeMs: d.think_ms, dealMode: modeOf(d) as DealMode,
    });
  }
  for (const h of humans) {
    foldInto(human, {
      action: h.action, blind: h.blind, roundNo: h.round_no, costFraction: h.cost_fraction,
      story: h.story, strength: h.strength, timeMs: h.elapsed_ms, dealMode: modeOf(h) as DealMode,
    });
  }
  // 「闷到第 3 轮」按人按局算一次，不是按动作算
  countHands(bot, decisions.map((d) => ({
    key: `${d.room}#${d.hand_no}#${d.memory_key}`, roundNo: d.round_no, blind: d.blind, action: d.action,
  })));
  countHands(human, humans.map((h) => ({
    key: `${h.room}#${h.hand_no}#${h.memory_key}`, roundNo: h.round_no, blind: h.blind, action: h.action,
  })));
  return { bot, human };
}

function countHands(feel: HumanFeel, rows: { key: string; roundNo: number; blind: number; action: string }[]) {
  const seen = new Map<string, { blind3: boolean; played: boolean }>();
  for (const r of rows) {
    let e = seen.get(r.key);
    if (!e) seen.set(r.key, (e = { blind3: false, played: false }));
    if (r.blind && r.roundNo >= 3) e.blind3 = true;
    if (r.action !== 'look' && r.action !== 'fold') e.played = true;
  }
  feel.hands = seen.size;
  feel.handsSeen = seen.size;
  for (const e of seen.values()) {
    if (e.blind3) feel.thirdRoundBlind++;
    if (e.played) feel.vpip++;
  }
}

function sectionFeel(bot: HumanFeel, human: HumanFeel, outcomes: OutcomeRecord[]): string {
  const rows: [string, (f: HumanFeel) => string, string][] = [
    ['入池率 VPIP', (f) => pct(f.vpip, f.hands), ''],
    ['加注率（加注 / 全部动作）', (f) => pct(f.raise, f.actions), ''],
    ['遇压弃牌率', (f) => pct(f.pressureFold, f.pressure), ''],
    ['闷牌率（闷着做的动作占比）', (f) => pct(f.blindActs, f.actions), ''],
    ['闷到第 3 轮的人·局占比', (f) => pct(f.thirdRoundBlind, f.hands), '§6.4 目标 15–35%'],
    ['闷比占比牌总数', (f) => pct(f.blindCompare, f.compare), '§6.4 目标 5–15%'],
    ['闷弃占全部弃牌', (f) => pct(f.blindFold, f.fold), '§6.4 目标 < 12%'],
    ['大牌早比（顺金以上且第 1–2 轮就比）', (f) => pct(f.bigStrengthEarlyCompare, f.compare), '§6.4 目标 < 5%；真人侧要亮过牌才有牌力'],
    ['梭哈率', (f) => pct(f.allIn, f.actions), ''],
    ['平均用时', (f) => (f.timeN ? `${Math.round(f.timeSum / f.timeN)}ms` : '—'), '机器人是 thinkMs，真人是真实反应时间'],
    ['样本：动作数 / 人·局数', (f) => `${f.actions} / ${f.hands}`, ''],
  ];
  const lines = [
    '## (a) 人味统计（§6.4）',
    '',
    '| 指标 | 机器人 | 真人 | 备注 |',
    '| --- | ---: | ---: | --- |',
    ...rows.map(([name, f, note]) => `| ${name} | ${f(bot)} | ${f(human)} | ${note} |`),
  ];

  // 收官人数：结算表里亮过牌 / 还在场的人数
  if (outcomes.length) {
    let finishers = 0;
    for (const o of outcomes) {
      const players = parseJson<OutcomePlayer[]>(o.players, []);
      finishers += players.filter((p) => p.revealed || p.net > 0).length;
    }
    lines.push('', `收官人数（每局亮牌/赢钱的人数均值）：**${(finishers / outcomes.length).toFixed(2)}**（§6.4 目标 ≥ 1.8，样本 ${outcomes.length} 局）`);
  }
  lines.push(
    '',
    '> 留痕表里看不到的 §6.4 项：每局表情次数与连续同表情率（表情不走决策留痕），',
    '> 六台机器人的四维两两距离需要多局自对弈的独立跑批 —— 这两项仍由 `tests/` 里的形状测试把关。',
  );
  return lines.join('\n');
}

/* ------------------------------------------- (b) 同一粗特征下的分布差异 */

/**
 * 粗特征的格子。selfTier 只有机器人有（真人是暗牌），所以格子只用两边都有的维度：
 * 轮次、闷/看、威胁档、下注压力档、人数。
 */
function bucketOf(a: { roundNo: number; blind: number; threatTier: number; costFraction: number; activeCount: number }): string {
  const round = a.roundNo <= 1 ? 'R1' : a.roundNo <= 3 ? 'R2-3' : 'R4+';
  const blind = a.blind ? '闷' : '看';
  const threat = a.threatTier < 0.33 ? '威胁低' : a.threatTier < 0.66 ? '威胁中' : '威胁高';
  const cost = a.costFraction < 0.03 ? '便宜' : a.costFraction < 0.1 ? '中等' : '很贵';
  const seats = a.activeCount <= 2 ? '单挑' : a.activeCount <= 3 ? '3 人' : '多人';
  return `${round} / ${blind} / ${threat} / ${cost} / ${seats}`;
}

function distribution(counts: Map<string, number>): Map<ActionName, number> {
  const total = [...counts.values()].reduce((a, b) => a + b, 0) || 1;
  const out = new Map<ActionName, number>();
  for (const a of ACTIONS) out.set(a, (counts.get(a) ?? 0) / total);
  return out;
}

/** 总变差距离：两个分布逐项差的绝对值之和的一半，0 = 一模一样，1 = 完全不重叠。 */
function totalVariation(x: Map<ActionName, number>, y: Map<ActionName, number>): number {
  let s = 0;
  for (const a of ACTIONS) s += Math.abs((x.get(a) ?? 0) - (y.get(a) ?? 0));
  return s / 2;
}

function sectionDivergence(decisions: DecisionRecord[], humans: HumanRecord[]): string {
  const bot = new Map<string, Map<string, number>>();
  const man = new Map<string, Map<string, number>>();
  const bump = (m: Map<string, Map<string, number>>, bucket: string, action: string) => {
    let c = m.get(bucket);
    if (!c) m.set(bucket, (c = new Map()));
    c.set(action, (c.get(action) ?? 0) + 1);
  };
  for (const d of decisions) {
    bump(bot, bucketOf({
      roundNo: d.round_no, blind: d.blind, threatTier: d.threat_tier,
      costFraction: d.cost_fraction, activeCount: d.active_count,
    }), d.action);
  }
  for (const h of humans) {
    bump(man, bucketOf({
      roundNo: h.round_no, blind: h.blind, threatTier: h.threat_tier,
      costFraction: h.cost_fraction, activeCount: h.active_count,
    }), h.action);
  }

  const rows: { bucket: string; d: number; nb: number; nh: number; bd: Map<ActionName, number>; hd: Map<ActionName, number> }[] = [];
  for (const [bucket, bc] of bot) {
    const hc = man.get(bucket);
    if (!hc) continue;
    const nb = [...bc.values()].reduce((a, b) => a + b, 0);
    const nh = [...hc.values()].reduce((a, b) => a + b, 0);
    const bd = distribution(bc);
    const hd = distribution(hc);
    rows.push({ bucket, d: totalVariation(bd, hd), nb, nh, bd, hd });
  }
  rows.sort((a, b) => b.d - a.d);

  const lines = [
    '## (b) 同一粗特征下的动作分布差异（差异越大 = 越「不像人」）',
    '',
  ];
  if (!rows.length) {
    lines.push('机器人和真人还没有落在同一个粗特征格子里的样本 —— 至少要有一个真人和机器人同桌打过。');
    return lines.join('\n');
  }
  lines.push(
    '| 粗特征格子 | 差异(TV) | 机器人 n | 真人 n | 机器人分布 | 真人分布 |',
    '| --- | ---: | ---: | ---: | --- | --- |',
  );
  const show = (m: Map<ActionName, number>) => ACTIONS
    .filter((a) => (m.get(a) ?? 0) > 0.005)
    .map((a) => `${a} ${(100 * (m.get(a) ?? 0)).toFixed(0)}%`)
    .join('，') || '—';
  for (const r of rows.slice(0, 20)) {
    const weak = r.nb < 10 || r.nh < 10 ? ' ⚠样本少' : '';
    lines.push(`| ${r.bucket}${weak} | ${r.d.toFixed(3)} | ${r.nb} | ${r.nh} | ${show(r.bd)} | ${show(r.hd)} |`);
  }
  lines.push('', '> ⚠样本少的格子（任一侧 < 10）先别当结论看，差异多半是抽样噪声。');
  return lines.join('\n');
}

/* ------------------------------------------- (c) 情绪轨迹与规律触发频次 */

function sectionEmotion(decisions: DecisionRecord[], outcomes: OutcomeRecord[]): string {
  const byBot = new Map<string, DecisionRecord[]>();
  for (const d of decisions) {
    let arr = byBot.get(d.memory_key);
    if (!arr) byBot.set(d.memory_key, (arr = []));
    arr.push(d);
  }
  const lines = ['## (c) 机器人的情绪轨迹与规律触发频次', ''];
  if (!byBot.size) {
    lines.push('这一段时间里没有机器人决策留痕。');
    return lines.join('\n');
  }

  const settleDelta = new Map<string, { n: number; sum: Record<string, number> }>();
  for (const o of outcomes) {
    const deltas = parseJson<Record<string, { e: Record<string, number>; d: Record<string, number> }>>(o.emotion_delta, {});
    for (const [key, v] of Object.entries(deltas)) {
      let acc = settleDelta.get(key);
      if (!acc) settleDelta.set(key, (acc = { n: 0, sum: {} }));
      acc.n++;
      for (const [k, x] of Object.entries(v.e ?? {})) acc.sum[k] = (acc.sum[k] ?? 0) + x;
    }
  }

  for (const [key, rows] of [...byBot.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const persona = rows[rows.length - 1]?.persona ?? '?';
    const avg = (f: (d: DecisionRecord) => number) => rows.reduce((s, d) => s + f(d), 0) / rows.length;
    const engaged = rows.filter((d) => d.engaged).length;
    const overridden = rows.filter((d) => d.overridden).length;
    const known = rows.filter((d) => d.deviated !== null).length;
    lines.push(
      `### ${key}（人物卡：${persona}，${rows.length} 步）`,
      '',
      `- 均值：tilt ${num(avg((d) => d.tilt))}｜ease ${num(avg((d) => d.ease))}｜arousal ${num(avg((d) => d.arousal))}｜fatigue ${num(avg((d) => d.fatigue))}｜willpower ${num(avg((d) => d.willpower))}`,
      `- 系统 2：介入 ${pct(engaged, rows.length)}（均值 p2 ${num(avg((d) => d.p2))}），介入后推翻直觉 ${pct(overridden, engaged)}；`
      // 偏离率只在「知道偏没偏离」的那些步上算：NULL 的那些既不是偏离也不是没偏离
      + `偏离线路 ${pct(rows.filter((d) => d.deviated).length, known)}（另有 ${rows.length - known} 步无从判断）`,
      `- 非回合动作占比 ${pct(rows.filter((d) => d.off_turn).length, rows.length)}｜均值 thinkMs ${Math.round(avg((d) => d.think_ms))}`,
    );

    // 情绪轨迹：按局取该局最后一步，画一条能看的线
    const perHand = new Map<number, DecisionRecord>();
    for (const d of rows) perHand.set(d.hand_no, d);
    const hands = [...perHand.keys()].sort((a, b) => a - b);
    if (hands.length > 1) {
      const track = hands.slice(-12).map((h) => {
        const d = perHand.get(h)!;
        return `局${h}: tilt ${d.tilt.toFixed(2)} / ease ${d.ease.toFixed(2)} / 意志 ${d.willpower.toFixed(2)}`;
      });
      lines.push(`- 轨迹（最近 ${track.length} 局）：`, ...track.map((t) => `  - ${t}`));
    }

    const fired = new Map<string, number>();
    for (const d of rows) for (const r of parseJson<string[]>(d.fired, [])) fired.set(r, (fired.get(r) ?? 0) + 1);
    const top = [...fired.entries()].sort((a, b) => b[1] - a[1]);
    lines.push(top.length
      ? `- 触发规律：${top.map(([r, n]) => `${r}×${n}（${pct(n, rows.length)}）`).join('，')}`
      : '- 触发规律：这段时间一条都没触发');

    const sd = settleDelta.get(key);
    if (sd?.n) {
      const parts = Object.entries(sd.sum)
        .filter(([, v]) => Math.abs(v) > 1e-6)
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
        .map(([k, v]) => `${k} ${(v / sd.n >= 0 ? '+' : '')}${(v / sd.n).toFixed(3)}`);
      lines.push(`- 结算触发的情绪增量（${sd.n} 局均值）：${parts.length ? parts.join('，') : '全为 0（结算侧评价尚未接入）'}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/* ------------------------------------------------ (d) 真人的原型归类 */

function sectionArchetype(db: DatabaseSync, humans: HumanRecord[]): string {
  const keys = [...new Set(humans.map((h) => h.memory_key))];
  const lines = ['## (d) 真人的人物原型归类', ''];
  if (!keys.length) {
    lines.push('这一段时间里没有真人动作留痕。');
    return lines.join('\n');
  }
  lines.push(
    '| 玩家 | 原型 | slope | 可信度 | 长期局数 | 置信度 | 本段动作数 |',
    '| --- | --- | ---: | ---: | ---: | --- | ---: |',
  );
  const stmt = db.prepare('SELECT data FROM zjh_memory WHERE key = ?');
  for (const key of keys) {
    const row = stmt.get(key) as { data: string } | undefined;
    const mem = row ? parseJson<BotMemory | null>(row.data, null) : null;
    const read = toTableRead(mem ?? undefined);
    const arch = archetypeOf(read);
    const cred = credibility(read);
    const n = humans.filter((h) => h.memory_key === key).length;
    // 置信度只看样本量：`archetypeOf` 自己在 hands < 3 时就退回常人了，
    // 这里把「为什么是常人」摊开说，免得把「不知道」读成「他就是个普通人」。
    const conf = read.hands < 3 ? '低（样本不足，按常人处理）'
      : read.hands < 20 ? '中（长期档案还浅）'
        : '高';
    lines.push(`| ${key} | ${arch.name} | ${arch.slope.toFixed(2)} | ${cred.toFixed(2)} | ${read.hands} | ${conf} | ${n} |`);
  }
  lines.push('', '> 归类走的是 `shared/zjh/bot/profile.ts` 的 `archetypeOf` —— 机器人读人用的是同一把尺子，这里只是把它打出来。');
  return lines.join('\n');
}

/* ------------------------------------------------- (e) 可疑瞬间清单 */

function sectionSuspicious(decisions: DecisionRecord[]): string {
  const big = new Set(['all_in', 'compare']);
  const items: string[] = [];

  for (const d of decisions) {
    const where = `\`${d.room}\` 局 ${d.hand_no} 轮 ${d.round_no} · ${d.memory_key}`;
    if ((big.has(d.action) || (d.action === 'raise' && d.cost_fraction >= 0.12)) && !d.engaged) {
      items.push(`- **系统 2 没介入却做了大动作**：${where} → \`${d.action}\`（p2 ${num(d.p2)}，掏 ${pct(d.cost_fraction, 1)} 身家，冲动 ${d.impulse_key}/信心 ${num(d.confidence)}）`);
    }
    if (d.tilt >= 0.7) {
      items.push(`- **上头时的动作**（tilt ${num(d.tilt)}）：${where} → \`${d.action}\``);
    }
    const emo = parseJson<Record<string, number>>(d.emotions, {});
    if ((emo.fear ?? 0) >= 0.75) {
      items.push(`- **恐惧极端时的动作**（fear ${num(emo.fear)}）：${where} → \`${d.action}\``);
    }
  }

  // 同一粗特征下连续 ≥3 次同一动作
  const runs = new Map<string, { action: string; n: number; first: DecisionRecord; last: DecisionRecord }>();
  const flush: string[] = [];
  for (const d of decisions) {
    const k = `${d.memory_key}|${bucketOf({
      roundNo: d.round_no, blind: d.blind, threatTier: d.threat_tier,
      costFraction: d.cost_fraction, activeCount: d.active_count,
    })}`;
    const cur = runs.get(k);
    if (cur && cur.action === d.action) {
      cur.n++;
      cur.last = d;
    } else {
      if (cur && cur.n >= 3) {
        flush.push(`- **同一局面连续 ${cur.n} 次同一动作**：${cur.first.memory_key} 在「${k.split('|')[1]}」下连做 ${cur.n} 次 \`${cur.action}\`（局 ${cur.first.hand_no}→${cur.last.hand_no}）`);
      }
      runs.set(k, { action: d.action, n: 1, first: d, last: d });
    }
  }
  for (const [k, cur] of runs) {
    if (cur.n >= 3) {
      flush.push(`- **同一局面连续 ${cur.n} 次同一动作**：${cur.first.memory_key} 在「${k.split('|')[1]}」下连做 ${cur.n} 次 \`${cur.action}\`（局 ${cur.first.hand_no}→${cur.last.hand_no}）`);
    }
  }

  const all = [...items, ...flush];
  const lines = ['## (e) 可疑瞬间', ''];
  if (!all.length) {
    lines.push('这一段时间里没有命中任何一条可疑规则。');
    return lines.join('\n');
  }
  lines.push(`共 ${all.length} 条${all.length > 60 ? '（只列前 60 条）' : ''}：`, '', ...all.slice(0, 60));
  return lines.join('\n');
}

/* ------------------------------------------------------- 单局全轨迹 */

function sectionHand(decisions: DecisionRecord[], humans: HumanRecord[], outcomes: OutcomeRecord[], handNo: number): string {
  const steps: { at: number; text: string }[] = [];
  for (const d of decisions.filter((x) => x.hand_no === handNo)) {
    const fired = parseJson<string[]>(d.fired, []);
    steps.push({
      at: d.at,
      text: [
        `- **轮 ${d.round_no}｜${d.memory_key}（${d.persona}）${d.off_turn ? ' · 非回合' : ''}** → \`${d.action}${d.action_unit ? ` ${d.action_unit}` : ''}${d.target_id ? ` → ${d.target_id}` : ''}\`（${d.think_ms}ms）`,
        `  - 局面：自评 ${num(d.self_tier)}／真实 ${num(d.strength)}｜威胁 ${num(d.threat_tier)}｜筹码压力 ${num(d.stake_tier)}｜熟悉 ${num(d.familiarity)}｜站位 ${num(d.standing)}｜${d.blind ? '闷着' : '看过牌'}｜池 ${d.pot}｜活 ${d.active_count} 人`,
        `  - 情绪：tilt ${num(d.tilt)}｜ease ${num(d.ease)}｜arousal ${num(d.arousal)}｜fatigue ${num(d.fatigue)}｜意志 ${num(d.willpower)}`,
        `  - E_t：${vec(d.emotions)}｜驱力：${vec(d.drives)}`,
        `  - 系统 1：${d.impulse_key}（信心 ${num(d.confidence)}，感到牌力 ${num(d.felt_strength)}，感到威胁 ${num(d.felt_threat)}）`,
        `  - 系统 2：p2 ${num(d.p2)}，${d.engaged ? `介入 → ${d.deliberate_key}（分 ${num(d.deliberate_score)}，难度 ${num(d.difficulty)}）；${d.overridden ? '**推翻了直觉**' : '没推翻'}，gap ${num(d.gap)} vs need ${num(d.need)}` : '没介入'}`,
        `  - 线路：${d.plan ?? '—'}（承诺 ${num(d.plan_commit)}）${d.deviated ? '，**偏离**' : ''}｜规律：${fired.length ? fired.join('、') : '无'}`,
      ].join('\n'),
    });
  }
  for (const h of humans.filter((x) => x.hand_no === handNo)) {
    steps.push({
      at: h.at,
      text: [
        `- **轮 ${h.round_no}｜${h.memory_key}（真人）** → \`${h.action}${h.action_unit ? ` ${h.action_unit}` : ''}${h.target_id ? ` → ${h.target_id}` : ''}\`（真实用时 ${h.elapsed_ms}ms）`,
        `  - 局面：威胁 ${num(h.threat_tier)}｜筹码压力 ${num(h.stake_tier)}｜熟悉 ${num(h.familiarity)}｜站位 ${num(h.standing)}｜${h.blind ? '闷着' : '看过牌'}｜池 ${h.pot}｜活 ${h.active_count} 人｜牌力 ${num(h.strength)}${h.strength === null ? '（未亮牌，不记）' : '（亮牌后回填）'}`,
      ].join('\n'),
    });
  }
  steps.sort((a, b) => a.at - b.at);

  const lines = [`## 局 ${handNo} 全轨迹`, ''];
  if (!steps.length) {
    lines.push('这一局没有留痕。');
    return lines.join('\n');
  }
  lines.push(...steps.map((s) => s.text));
  const o = outcomes.find((x) => x.hand_no === handNo);
  if (o) {
    const players = parseJson<OutcomePlayer[]>(o.players, []);
    lines.push(
      '',
      `**结算**：${o.winner_name} 赢 ${o.pot}（${o.reason}）`,
      '',
      '| 玩家 | 机器人 | 投入 | 收益 | 净变化 | 亮牌 | 牌力 |',
      '| --- | :-: | ---: | ---: | ---: | :-: | ---: |',
      ...players.map((p) => `| ${p.name}（${p.key}） | ${p.isBot ? '是' : '否'} | ${p.bet} | ${p.net} | ${p.delta} | ${p.revealed ? '是' : '否'} | ${num(p.strength)} |`),
    );
  }
  return lines.join('\n');
}

/* ----------------------------------------------------------- 入口 */

/**
 * 一份留痕落在哪个发牌档上。老行（2026-09-04 加列之前）是 NULL —— 那时候只有一档，
 * 一律读成 `standard`。
 */
const modeOf = (r: { deal_mode: string | null }): string => r.deal_mode ?? 'standard';

const MODE_LABEL: Record<string, string> = { standard: '标准', party: '娱乐增强' };
const modeName = (m: string): string => `${MODE_LABEL[m] ?? m}（${m}）`;

/**
 * 一档的正文。
 *
 * **必须分档统计**：牌力分位是按各档的分布累计算出来的，同一手金花在标准档是 0.9、
 * 在娱乐增强档只有 0.78；「大牌早比」「牌力档 × 动作」这些口径把两档混在一起算
 * 就是拿两把不同的尺子量同一批人。
 */
function body(
  db: DatabaseSync,
  decisions: DecisionRecord[],
  humans: HumanRecord[],
  outcomes: OutcomeRecord[],
): string[] {
  const { bot, human } = feelOf(decisions, humans);
  const parts = [
    sectionFeel(bot, human, outcomes),
    '',
    sectionDivergence(decisions, humans),
    '',
    sectionEmotion(decisions, outcomes),
    '',
    sectionArchetype(db, humans),
    '',
    sectionSuspicious(decisions),
  ];
  return parts;
}

export function review(db: DatabaseSync, opts: ReviewOptions = {}): string {
  const { decisions, humans, outcomes } = load(db, opts);
  const scope = [
    opts.since !== undefined ? `自 ${new Date(opts.since).toISOString()}` : '全部时间',
    opts.room ? `房间 ${opts.room}` : '全部房间',
  ].join(' · ');

  const modes = [...new Set([
    ...decisions.map(modeOf), ...humans.map(modeOf), ...outcomes.map(modeOf),
  ])].sort();
  if (!modes.length) modes.push('standard');

  const parts = [
    '# 炸金花决策留痕复盘',
    '',
    `范围：${scope}｜机器人决策 ${decisions.length} 步｜真人动作 ${humans.length} 步｜结算 ${outcomes.length} 局`,
    `发牌档：${modes.map(modeName).join('、')}`,
    '',
  ];

  for (const m of modes) {
    const d = decisions.filter((r) => modeOf(r) === m);
    const h = humans.filter((r) => modeOf(r) === m);
    const o = outcomes.filter((r) => modeOf(r) === m);
    if (modes.length > 1) {
      parts.push(
        `# 发牌档：${modeName(m)}`,
        '',
        `机器人决策 ${d.length} 步｜真人动作 ${h.length} 步｜结算 ${o.length} 局`,
        '',
      );
    }
    parts.push(...body(db, d, h, o));
    if (opts.hand !== undefined) parts.push('', sectionHand(d, h, o, opts.hand));
    parts.push('');
  }
  return `${parts.join('\n').replace(/\n+$/, '')}\n`;
}

/** `--since` 收两种写法：天数（`--since 7`）或 ISO 日期（`--since 2026-09-01`）。 */
export function parseSince(v: string): number | undefined {
  const days = Number(v);
  if (Number.isFinite(days) && days > 0 && days < 10000) return Date.now() - days * 24 * 60 * 60 * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

function parseArgs(argv: string[]) {
  const opts: ReviewOptions = {};
  let db: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--db') db = next();
    else if (a === '--since') opts.since = parseSince(next() ?? '');
    else if (a === '--room') opts.room = next();
    else if (a === '--hand') opts.hand = Number(next());
    else if (a === '-h' || a === '--help') return null;
  }
  return { opts, db };
}

const USAGE = `用法：node scripts/zjh-review.ts [选项]

  --db <路径>      数据库位置（默认 $ZJH_DB，再默认仓库根目录的 zjh.db）
  --since <天数|日期>  只看这个时间之后的留痕，如 --since 7 或 --since 2026-09-01
  --room <房号>    只看某个房间
  --hand <局号>    额外打印这一局的逐步全轨迹
`;

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    process.stdout.write(USAGE);
    return;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const path = parsed.db ?? process.env.ZJH_DB ?? join(here, '..', 'zjh.db');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    process.stdout.write(review(db, parsed.opts));
  } finally {
    db.close();
  }
}

// 被 import 进测试时不要自己跑起来
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
