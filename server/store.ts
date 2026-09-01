import { DatabaseSync } from 'node:sqlite';
import type { RoomState } from '../shared/game.ts';

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
    this.upsert = this.db.prepare(
      'INSERT INTO rooms(code, state, updated_at) VALUES(?, ?, ?) ON CONFLICT(code) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at',
    );
    this.del = this.db.prepare('DELETE FROM rooms WHERE code = ?');
  }

  save(state: RoomState) {
    this.upsert.run(state.code, JSON.stringify(state), Date.now());
  }

  remove(code: string) {
    this.del.run(code);
  }

  loadAll(maxAgeMs: number): RoomState[] {
    const cutoff = Date.now() - maxAgeMs;
    const rows = this.db.prepare('SELECT state FROM rooms WHERE updated_at >= ?').all(cutoff) as { state: string }[];
    const out: RoomState[] = [];
    for (const row of rows) {
      try {
        out.push(JSON.parse(row.state) as RoomState);
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

  close() {
    this.db.close();
  }
}
