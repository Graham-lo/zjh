import { DatabaseSync } from 'node:sqlite';
import type { AnyRoomState } from '../shared/games.ts';

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
}

/**
 * SQLite 只做快照落盘：进程重启后牌局还在。
 * 它不在热路径上 —— 每次操作改的是内存里的对象，写盘是防抖的副作用。
 */
export class Store {
  private db: DatabaseSync;
  private upsert;
  private del;

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
        updated_at INTEGER NOT NULL
      );
    `);
    // 加列是幂等的：老库里没有就补上，已经有了 SQLite 会报错，吞掉即可（DESIGN 2.1）
    for (const col of ['sj_hands', 'sj_wins']) {
      try {
        this.db.exec(`ALTER TABLE accounts ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
      } catch {
        /* 这一列已经存在 */
      }
    }
    this.upsert = this.db.prepare(
      'INSERT INTO rooms(code, state, updated_at) VALUES(?, ?, ?) ON CONFLICT(code) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at',
    );
    this.del = this.db.prepare('DELETE FROM rooms WHERE code = ?');
  }

  save(state: AnyRoomState) {
    this.upsert.run(state.code, JSON.stringify(state), Date.now());
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
        'INSERT INTO accounts(id, token_hash, name, avatar, chips, granted, hands, wins, sj_hands, sj_wins, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(a.id, a.tokenHash, a.name, a.avatar, a.chips, a.granted, a.hands, a.wins, a.sjHands, a.sjWins, Date.now());
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
    };
  }

  /** 把这一手之后的积分和战绩写回账户 */
  saveAccount(a: Account) {
    this.db
      .prepare(
        'UPDATE accounts SET name = ?, avatar = ?, chips = ?, granted = ?, hands = ?, wins = ?, sj_hands = ?, sj_wins = ?, updated_at = ? WHERE id = ?',
      )
      .run(a.name, a.avatar, a.chips, a.granted, a.hands, a.wins, a.sjHands, a.sjWins, Date.now(), a.id);
  }

  close() {
    this.db.close();
  }
}
