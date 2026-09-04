import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AnyRoomState } from '../shared/games.ts';
import { CHIP_GRANT_VERSION, DEFAULT_SETTINGS, type BotMemory } from '../shared/game.ts';
import type { Drives, Emotions } from '../shared/mind/emotion.ts';
import type { TraceAction, TraceFeatures, TraceOpponent } from '../shared/zjh/bot/trace.ts';

/** 一个跨房间、跨会话的玩家账户 */
export interface Account {
  id: string;
  tokenHash: string;
  name: string;
  avatar: string;
  chips: number;
  /** 累计发放（初始额度 + 每次补分）。净战绩 = chips - granted */
  granted: number;
  hands: number;
  wins: number;
  /** 升级的局数与胜局。和炸金花的 hands/wins 分开记，两种游戏的"一局"不是一回事 */
  sjHands: number;
  sjWins: number;
  /** 全服筹码基线的一次性迁移版本。 */
  chipGrantVersion: number;
}

/* ------------------------------------------------ 决策留痕（设计文档 §4.11） */

/** `zjh_decisions` 的一行：机器人的一次决策（含非回合动作）。 */
export interface DecisionRow {
  at: number;
  room: string;
  handNo: number;
  roundNo: number;
  memoryKey: string;
  persona: string;
  /** 这一桌的发牌档（`standard` / `party`）。旧行是 NULL，按 standard 读。 */
  dealMode: string;
  offTurn: boolean;
  features: TraceFeatures;
  opponents: TraceOpponent[];
  plan?: string;
  planCommit?: number;
  emotions: Emotions;
  drives: Drives;
  tilt: number;
  ease: number;
  arousal: number;
  fatigue: number;
  willpower: number;
  impulseKey: string;
  confidence: number;
  feltStrength: number;
  feltThreat: number;
  p2: number;
  engaged: boolean;
  deliberateKey?: string;
  deliberateScore?: number;
  difficulty?: number;
  overridden: boolean;
  /**
   * 是否偏离了本局的线路。**三态**：没开系统 2 又没有对照的时候是 `undefined`，
   * 落库写 NULL —— 「不知道」不许默认算成「没偏离」（见 `mind/dual.ts` 的同名字段）。
   */
  deviated?: boolean;
  gap: number;
  need: number;
  fired: string[];
  action: TraceAction;
  thinkMs: number;
}

/** `zjh_human_actions` 的一行。**亮牌前不含任何牌面信息**（§4.11.2）。 */
export interface HumanActionRow {
  at: number;
  room: string;
  handNo: number;
  roundNo: number;
  accountId?: string;
  memoryKey: string;
  /** 这一桌的发牌档，口径同 `DecisionRow` —— 亮牌后回填的 `strength` 得按这一档读 */
  dealMode: string;
  features: TraceFeatures;
  opponents: TraceOpponent[];
  action: TraceAction;
  /** 从上一次状态变化到这一步动作的毫秒数 —— 真人的「用时信号」 */
  elapsedMs: number;
  looked: boolean;
}

/** `zjh_hand_outcomes` 的一行：一局的结算。 */
export interface HandOutcomeRow {
  at: number;
  room: string;
  handNo: number;
  winnerId: string;
  winnerKey: string;
  winnerName: string;
  pot: number;
  reason: string;
  /** 这一桌的发牌档，口径同 `DecisionRow` */
  dealMode: string;
  players: {
    id: string; key: string; name: string; isBot: boolean;
    /** 本局投入 */
    bet: number;
    /** 净收益 */
    net: number;
    delta: number;
    revealed: boolean;
    /** 亮过牌才有 */
    strength?: number;
  }[];
  /** 结算触发的情绪 / 驱力增量，按人（§4.11.1） */
  emotionDelta: Record<string, { e: Partial<Emotions>; d: Partial<Drives> }>;
}

const DECISION_COLS = [
  'at', 'room', 'hand_no', 'round_no', 'memory_key', 'persona', 'deal_mode', 'off_turn',
  'self_tier', 'threat_tier', 'stake_tier', 'familiarity', 'standing', 'strength',
  'story', 'unit_tier', 'pot_maturity', 'active_count', 'position', 'blind', 'cost_fraction', 'pot',
  'counterpart_key', 'opponents',
  'emotions', 'drives', 'tilt', 'ease', 'arousal', 'fatigue', 'willpower',
  'impulse_key', 'confidence', 'felt_strength', 'felt_threat',
  'p2', 'engaged', 'deliberate_key', 'deliberate_score', 'difficulty',
  'overridden', 'deviated', 'gap', 'need', 'fired',
  'plan', 'plan_commit', 'action', 'action_unit', 'target_id', 'think_ms',
] as const;

const HUMAN_COLS = [
  'at', 'room', 'hand_no', 'round_no', 'account_id', 'memory_key', 'deal_mode',
  'threat_tier', 'stake_tier', 'familiarity', 'standing', 'strength',
  'story', 'unit_tier', 'pot_maturity', 'active_count', 'position', 'blind', 'cost_fraction', 'pot',
  'counterpart_key', 'opponents',
  'action', 'action_unit', 'target_id', 'elapsed_ms', 'looked',
] as const;

/** SQLite 只认数字/字符串/null，布尔和 undefined 都要先落地。 */
type Bind = string | number | null;
const bit = (v: boolean) => (v ? 1 : 0);
/** 三态布尔：`undefined` 落 NULL，别把「不知道」写成 0。 */
const nb = (v: boolean | undefined) => (v === undefined ? null : v ? 1 : 0);
const nn = (v: number | undefined) => (v === undefined ? null : v);
const ns = (v: string | undefined) => (v === undefined ? null : v);

function placeholders(n: number): string {
  return new Array(n).fill('?').join(',');
}

/**
 * SQLite 只做快照落盘：进程重启后牌局还在。
 * 它不在热路径上 —— 每次操作改的是内存里的对象，写盘是防抖的副作用。
 */
export class Store {
  private db: DatabaseSync;

  /**
   * 只给**只读分析**用（`scripts/zjh-review.ts`）：复盘要在留痕表上跑一堆
   * 临时聚合，一句 GROUP BY 一个方法地往 Store 上加没有意义。
   * 牌局路径上不要用它 —— 那边的每一次写都该走上面那些带事务的方法。
   */
  get raw(): DatabaseSync {
    return this.db;
  }
  private upsert;
  private del;
  private memoryUpsert!: ReturnType<DatabaseSync['prepare']>;
  private memoryGet!: ReturnType<DatabaseSync['prepare']>;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        code TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rooms_updated ON rooms(updated_at);
    `);
    // 账户：让人换个房间、隔天再来还是同一个自己，积分也接着上次
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        avatar TEXT NOT NULL,
        chips INTEGER NOT NULL,
        granted INTEGER NOT NULL,
        hands INTEGER NOT NULL DEFAULT 0,
        wins INTEGER NOT NULL DEFAULT 0,
        chip_grant_version INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `);
    // 加列是幂等的：老库里没有就补上，已经有了 SQLite 会报错，吞掉即可（DESIGN 2.1）
    for (const col of ['sj_hands', 'sj_wins', 'chip_grant_version']) {
      try {
        this.db.exec(`ALTER TABLE accounts ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
      } catch {
        /* 这一列已经存在 */
      }
    }
    // 旧账户一次性跟上当前筹码基线。chips/granted 同额增加，净战绩不变；
    // 版本号保证以后重启不会重复发放，高于基线的账户也不会被扣减。
    const migrated = this.db
      .prepare(`
        UPDATE accounts
        SET granted = granted + CASE WHEN chips < ? THEN ? - chips ELSE 0 END,
            chips = CASE WHEN chips < ? THEN ? ELSE chips END,
            chip_grant_version = ?,
            updated_at = ?
        WHERE chip_grant_version < ?
      `)
      .run(
        DEFAULT_SETTINGS.startingChips,
        DEFAULT_SETTINGS.startingChips,
        DEFAULT_SETTINGS.startingChips,
        DEFAULT_SETTINGS.startingChips,
        CHIP_GRANT_VERSION,
        Date.now(),
        CHIP_GRANT_VERSION,
      );
    if (migrated.changes) console.log(`[store] 已升级 ${migrated.changes} 个旧账户的筹码基线`);
    // 炸金花的长期打法档案。它比房间活得久 —— 真人换个房间、隔天再来，
    // 「这个人一晚上只打三把」这件事还在。所以不跟房间快照一起存。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS zjh_memory (
        key TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.memoryUpsert = this.db.prepare(
      'INSERT INTO zjh_memory(key, data, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
    );
    this.memoryGet = this.db.prepare('SELECT data FROM zjh_memory WHERE key = ?');
    this.createTraceTables();
    this.upsert = this.db.prepare(
      'INSERT INTO rooms(code, state, updated_at) VALUES(?, ?, ?) ON CONFLICT(code) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at',
    );
    this.del = this.db.prepare('DELETE FROM rooms WHERE code = ?');
  }

  save(state: AnyRoomState) {
    // memory 有自己的表，不跟房间快照一起存：它按人索引、生命周期比房间长，
    // 塞进快照只会让每个房间各存一份互相覆盖的旧数据。
    const { memory: _memory, ...rest } = state as AnyRoomState & { memory?: unknown };
    this.upsert.run(state.code, JSON.stringify(rest), Date.now());
  }

  /* ------------------------------------------------- 决策留痕（§4.11） */

  /**
   * 三张留痕表，和 `zjh_memory` 同一个库（§4.11.1）。
   *
   * 粗特征全部**摊平成列**而不是塞进一个 JSON：`zjh-review.ts` 要按
   * 「同一个粗特征下机器人和真人分别怎么打」分桶排名，那是一句 GROUP BY 的事，
   * 存成 JSON 就得把整张表读进内存再自己分组。
   *
   * 只有真正的可变长结构（情绪向量、规律列表、对手快照）才用 JSON 列。
   */
  private createTraceTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS zjh_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        room TEXT NOT NULL,
        hand_no INTEGER NOT NULL,
        round_no INTEGER NOT NULL,
        memory_key TEXT NOT NULL,
        persona TEXT NOT NULL,
        deal_mode TEXT,
        off_turn INTEGER NOT NULL,
        self_tier REAL, threat_tier REAL, stake_tier REAL, familiarity REAL, standing REAL,
        strength REAL,
        story REAL, unit_tier INTEGER, pot_maturity REAL, active_count INTEGER, position REAL,
        blind INTEGER, cost_fraction REAL, pot INTEGER,
        counterpart_key TEXT,
        opponents TEXT NOT NULL,
        emotions TEXT NOT NULL, drives TEXT NOT NULL,
        tilt REAL, ease REAL, arousal REAL, fatigue REAL, willpower REAL,
        impulse_key TEXT NOT NULL, confidence REAL, felt_strength REAL, felt_threat REAL,
        p2 REAL, engaged INTEGER, deliberate_key TEXT, deliberate_score REAL, difficulty REAL,
        overridden INTEGER, deviated INTEGER, gap REAL, need REAL,
        fired TEXT NOT NULL,
        plan TEXT, plan_commit REAL,
        action TEXT NOT NULL, action_unit INTEGER, target_id TEXT, think_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_decisions_at ON zjh_decisions(at);
      CREATE INDEX IF NOT EXISTS idx_decisions_hand ON zjh_decisions(room, hand_no);
      CREATE INDEX IF NOT EXISTS idx_decisions_who ON zjh_decisions(memory_key);

      CREATE TABLE IF NOT EXISTS zjh_human_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        room TEXT NOT NULL,
        hand_no INTEGER NOT NULL,
        round_no INTEGER NOT NULL,
        account_id TEXT,
        memory_key TEXT NOT NULL,
        deal_mode TEXT,
        threat_tier REAL, stake_tier REAL, familiarity REAL, standing REAL,
        strength REAL,
        story REAL, unit_tier INTEGER, pot_maturity REAL, active_count INTEGER, position REAL,
        blind INTEGER, cost_fraction REAL, pot INTEGER,
        counterpart_key TEXT,
        opponents TEXT NOT NULL,
        action TEXT NOT NULL, action_unit INTEGER, target_id TEXT,
        elapsed_ms INTEGER, looked INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_human_at ON zjh_human_actions(at);
      CREATE INDEX IF NOT EXISTS idx_human_hand ON zjh_human_actions(room, hand_no);
      CREATE INDEX IF NOT EXISTS idx_human_who ON zjh_human_actions(memory_key);

      CREATE TABLE IF NOT EXISTS zjh_hand_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        room TEXT NOT NULL,
        hand_no INTEGER NOT NULL,
        winner_id TEXT NOT NULL,
        winner_key TEXT NOT NULL,
        winner_name TEXT NOT NULL,
        pot INTEGER NOT NULL,
        reason TEXT NOT NULL,
        deal_mode TEXT,
        players TEXT NOT NULL,
        emotion_delta TEXT NOT NULL,
        UNIQUE(room, hand_no)
      );
      CREATE INDEX IF NOT EXISTS idx_outcomes_at ON zjh_hand_outcomes(at);
    `);
    // 发牌档（2026-09-04「娱乐增强」档）。老库里这三张表没有这一列，补上即可；
    // 已经有了 SQLite 会报错，吞掉 —— 与 accounts 那几列同一套幂等加列做法。
    // 旧行留 NULL，读的时候一律当 standard（那时候只有这一档）。
    for (const table of ['zjh_decisions', 'zjh_human_actions', 'zjh_hand_outcomes']) {
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN deal_mode TEXT`);
      } catch {
        /* 这一列已经存在 */
      }
    }
  }

  /** 一批机器人决策。整批一个事务 —— 一局六个人几十步，逐条提交是纯浪费。 */
  insertDecisions(rows: DecisionRow[]) {
    if (!rows.length) return;
    const sql = `INSERT INTO zjh_decisions(${DECISION_COLS.join(',')}) VALUES(${placeholders(DECISION_COLS.length)})`;
    const stmt = this.db.prepare(sql);
    this.batch(() => {
      for (const r of rows) {
        const f = r.features;
        const d = r.action;
        const args: Bind[] = [
          r.at, r.room, r.handNo, r.roundNo, r.memoryKey, r.persona, r.dealMode, bit(r.offTurn),
          nn(f.selfTier), f.threatTier, f.stakeTier, f.familiarity, f.standing, nn(f.strength),
          f.story, f.unitTier, f.potMaturity, f.activeCount, f.position, bit(f.blind), f.costFraction, f.pot,
          ns(f.counterpartKey), JSON.stringify(r.opponents),
          JSON.stringify(r.emotions), JSON.stringify(r.drives),
          r.tilt, r.ease, r.arousal, r.fatigue, r.willpower,
          r.impulseKey, r.confidence, r.feltStrength, r.feltThreat,
          r.p2, bit(r.engaged), ns(r.deliberateKey), nn(r.deliberateScore), nn(r.difficulty),
          bit(r.overridden), nb(r.deviated), r.gap, r.need, JSON.stringify(r.fired),
          ns(r.plan), nn(r.planCommit), d.type, nn(d.unit), ns(d.targetId), r.thinkMs,
        ];
        stmt.run(...args);
      }
    });
  }

  insertHumanActions(rows: HumanActionRow[]) {
    if (!rows.length) return;
    const sql = `INSERT INTO zjh_human_actions(${HUMAN_COLS.join(',')}) VALUES(${placeholders(HUMAN_COLS.length)})`;
    const stmt = this.db.prepare(sql);
    this.batch(() => {
      for (const r of rows) {
        const f = r.features;
        const d = r.action;
        const args: Bind[] = [
          r.at, r.room, r.handNo, r.roundNo, ns(r.accountId), r.memoryKey, r.dealMode,
          f.threatTier, f.stakeTier, f.familiarity, f.standing, nn(f.strength),
          f.story, f.unitTier, f.potMaturity, f.activeCount, f.position, bit(f.blind), f.costFraction, f.pot,
          ns(f.counterpartKey), JSON.stringify(r.opponents),
          d.type, nn(d.unit), ns(d.targetId), r.elapsedMs, bit(r.looked),
        ];
        stmt.run(...args);
      }
    });
  }

  /** 一局的结算。同一局重复写只留第一条（round_end 会广播很多次）。 */
  insertHandOutcome(row: HandOutcomeRow) {
    this.db
      .prepare(`
        INSERT INTO zjh_hand_outcomes(at, room, hand_no, winner_id, winner_key, winner_name, pot, reason, deal_mode, players, emotion_delta)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(room, hand_no) DO NOTHING
      `)
      .run(
        row.at, row.room, row.handNo, row.winnerId, row.winnerKey, row.winnerName,
        row.pot, row.reason, row.dealMode, JSON.stringify(row.players), JSON.stringify(row.emotionDelta),
      );
  }

  /**
   * 亮牌之后回填真人这一局的牌力（§4.11.2 的「亮牌前不记牌面」）。
   *
   * 牌在一局里是不变的，所以这一局那个人的每一行都能补上同一个值；
   * 补的是**已经公开**的信息，牌局进行中库里查不到它，留痕就当不成偷看通道。
   */
  backfillHumanStrength(room: string, handNo: number, strengthByKey: Record<string, number>) {
    const entries = Object.entries(strengthByKey);
    if (!entries.length) return;
    const stmt = this.db.prepare(
      'UPDATE zjh_human_actions SET strength = ? WHERE room = ? AND hand_no = ? AND memory_key = ?',
    );
    this.batch(() => {
      for (const [key, strength] of entries) stmt.run(strength, room, handNo, key);
    });
  }

  private batch(run: () => void) {
    this.db.exec('BEGIN');
    try {
      run();
      this.db.exec('COMMIT');
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* 事务已经自己回滚了 */
      }
      throw e;
    }
  }

  /**
   * 保留 30 天：超期的**按 handNo 归档成 JSONL** 之后再删（§4.11.2「隐私与体积」）。
   *
   * 一局的三张表写在同一个文件的连续几行里，`{"t":"decision"|"human"|"outcome"}` 区分，
   * 这样以后想回看某一局，`grep '"handNo":123'` 就够了，不需要再起一个库。
   * 归档写失败就**不删** —— 宁可留着占地方，也不能把唯一一份数据删掉。
   */
  archiveTrace(dir: string, maxAgeMs: number): { archived: number; deleted: number; file: string | null } {
    const cutoff = Date.now() - maxAgeMs;
    const decisions = this.db.prepare('SELECT * FROM zjh_decisions WHERE at < ? ORDER BY hand_no, at, id').all(cutoff);
    const humans = this.db.prepare('SELECT * FROM zjh_human_actions WHERE at < ? ORDER BY hand_no, at, id').all(cutoff);
    const outcomes = this.db.prepare('SELECT * FROM zjh_hand_outcomes WHERE at < ? ORDER BY hand_no, at, id').all(cutoff);
    const total = decisions.length + humans.length + outcomes.length;
    if (!total) return { archived: 0, deleted: 0, file: null };

    mkdirSync(dir, { recursive: true });
    const stamp = new Date(cutoff).toISOString().slice(0, 10);
    const file = join(dir, `zjh-trace-${stamp}.jsonl`);
    const lines: string[] = [];
    const push = (t: string, rows: unknown[]) => {
      for (const r of rows) lines.push(JSON.stringify({ t, ...(r as Record<string, unknown>) }));
    };
    push('decision', decisions);
    push('human', humans);
    push('outcome', outcomes);
    // 按 handNo 排在一起：同一局的三张表的行在文件里是挨着的
    lines.sort((a, b) => {
      const ha = (JSON.parse(a) as { hand_no: number }).hand_no;
      const hb = (JSON.parse(b) as { hand_no: number }).hand_no;
      return ha - hb;
    });
    appendFileSync(file, `${lines.join('\n')}\n`);

    let deleted = 0;
    this.batch(() => {
      deleted += Number(this.db.prepare('DELETE FROM zjh_decisions WHERE at < ?').run(cutoff).changes ?? 0);
      deleted += Number(this.db.prepare('DELETE FROM zjh_human_actions WHERE at < ?').run(cutoff).changes ?? 0);
      deleted += Number(this.db.prepare('DELETE FROM zjh_hand_outcomes WHERE at < ?').run(cutoff).changes ?? 0);
    });
    return { archived: total, deleted, file };
  }

  /* ------------------------------------------------- 炸金花长期打法档案 */

  loadMemory(key: string): BotMemory | null {
    const row = this.memoryGet.get(key) as { data: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.data) as BotMemory;
    } catch {
      return null;
    }
  }

  saveMemory(mem: BotMemory) {
    this.memoryUpsert.run(mem.key, JSON.stringify(mem), Date.now());
  }

  remove(code: string) {
    this.del.run(code);
  }

  loadAll(maxAgeMs: number): AnyRoomState[] {
    const cutoff = Date.now() - maxAgeMs;
    const rows = this.db.prepare('SELECT state FROM rooms WHERE updated_at >= ?').all(cutoff) as { state: string }[];
    const out: AnyRoomState[] = [];
    for (const row of rows) {
      try {
        out.push(JSON.parse(row.state) as AnyRoomState);
      } catch {
        // 损坏的快照直接丢弃，不值得让整个进程起不来
      }
    }
    return out;
  }

  purge(maxAgeMs: number): number {
    const res = this.db.prepare('DELETE FROM rooms WHERE updated_at < ?').run(Date.now() - maxAgeMs);
    return Number(res.changes ?? 0);
  }

  /* ------------------------------------------------------------ 账户 */

  createAccount(a: Account) {
    this.db
      .prepare(
        'INSERT INTO accounts(id, token_hash, name, avatar, chips, granted, hands, wins, sj_hands, sj_wins, chip_grant_version, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(a.id, a.tokenHash, a.name, a.avatar, a.chips, a.granted, a.hands, a.wins, a.sjHands, a.sjWins, a.chipGrantVersion, Date.now());
  }

  getAccount(id: string): Account | null {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as
      | Record<string, string | number>
      | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      tokenHash: String(row.token_hash),
      name: String(row.name),
      avatar: String(row.avatar),
      chips: Number(row.chips),
      granted: Number(row.granted),
      hands: Number(row.hands),
      wins: Number(row.wins),
      sjHands: Number(row.sj_hands ?? 0),
      sjWins: Number(row.sj_wins ?? 0),
      chipGrantVersion: Number(row.chip_grant_version ?? 0),
    };
  }

  /** 把这一手之后的积分和战绩写回账户 */
  saveAccount(a: Account) {
    this.db
      .prepare(
        'UPDATE accounts SET name = ?, avatar = ?, chips = ?, granted = ?, hands = ?, wins = ?, sj_hands = ?, sj_wins = ?, chip_grant_version = ?, updated_at = ? WHERE id = ?',
      )
      .run(a.name, a.avatar, a.chips, a.granted, a.hands, a.wins, a.sjHands, a.sjWins, a.chipGrantVersion, Date.now(), a.id);
  }

  close() {
    this.db.close();
  }
}
