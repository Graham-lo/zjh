import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Store } from '../server/store.ts';

test('旧账户启动时一次性补到 50 万，高余额不回退，重复启动不重复发放', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zjh-store-'));
  const path = join(dir, 'zjh.db');

  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        avatar TEXT NOT NULL,
        chips INTEGER NOT NULL,
        granted INTEGER NOT NULL,
        hands INTEGER NOT NULL DEFAULT 0,
        wins INTEGER NOT NULL DEFAULT 0,
        sj_hands INTEGER NOT NULL DEFAULT 0,
        sj_wins INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO accounts VALUES
        ('low', 'token', '低余额', '🐯', 12345, 50000, 3, 1, 0, 0, 1),
        ('high', 'token', '高余额', '🐲', 800000, 500000, 8, 5, 0, 0, 1);
    `);
    legacy.close();

    const first = new Store(path);
    assert.deepEqual(
      { chips: first.getAccount('low')?.chips, granted: first.getAccount('low')?.granted, version: first.getAccount('low')?.chipGrantVersion },
      { chips: 500_000, granted: 537_655, version: 1 },
    );
    assert.deepEqual(
      { chips: first.getAccount('high')?.chips, granted: first.getAccount('high')?.granted, version: first.getAccount('high')?.chipGrantVersion },
      { chips: 800_000, granted: 500_000, version: 1 },
    );
    first.close();

    const second = new Store(path);
    assert.deepEqual(
      { chips: second.getAccount('low')?.chips, granted: second.getAccount('low')?.granted, version: second.getAccount('low')?.chipGrantVersion },
      { chips: 500_000, granted: 537_655, version: 1 },
    );
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
