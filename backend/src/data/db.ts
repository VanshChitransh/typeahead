// Primary data store: the durable source of truth for query counts.
//
// Uses Node's built-in `node:sqlite` so the project runs with zero native
// compilation and no external database server. In production this layer would be
// Postgres/MySQL/DynamoDB; the access pattern is identical (bulk seed, batched
// upserts, one full read at startup to build the in-memory index).
//
// Schema: queries(query PK, count, last_searched, recent_score).

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import metrics from '../middleware/metricsMiddleware.js';
import { normalize } from '../util.js';
import type { QueryEntry } from '../types.js';

interface DbRow {
  query: string;
  count: number;
  lastSearched: number;
  recentScore: number;
}

export class Db {
  private db: DatabaseSync;
  private upsertInitial: StatementSync;
  private applyOne: StatementSync;
  private getOne: StatementSync;
  private countAll: StatementSync;
  private selectAll: StatementSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS queries (
        query         TEXT PRIMARY KEY,
        count         INTEGER NOT NULL DEFAULT 0,
        last_searched INTEGER NOT NULL DEFAULT 0,
        recent_score  REAL    NOT NULL DEFAULT 0
      );
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_query ON queries(query);');

    this.upsertInitial = this.db.prepare(`
      INSERT INTO queries (query, count, last_searched, recent_score)
      VALUES (?, ?, 0, 0)
      ON CONFLICT(query) DO UPDATE SET count = excluded.count;
    `);
    this.applyOne = this.db.prepare(`
      INSERT INTO queries (query, count, last_searched, recent_score)
      VALUES (@query, @count, @lastSearched, @recentScore)
      ON CONFLICT(query) DO UPDATE SET
        count = @count, last_searched = @lastSearched, recent_score = @recentScore;
    `);
    this.getOne = this.db.prepare('SELECT * FROM queries WHERE query = ?;');
    this.countAll = this.db.prepare('SELECT COUNT(*) AS n FROM queries;');
    this.selectAll = this.db.prepare(
      'SELECT query, count, last_searched AS lastSearched, recent_score AS recentScore FROM queries;',
    );
  }

  // One-time seed from data/queries.json (array of { query, count }). Skipped if
  // the store already has rows, so the DB file persists across restarts.
  seedFromJsonIfEmpty(jsonPath: string): number {
    if (this.count() > 0) return 0;
    if (!fs.existsSync(jsonPath)) return 0;
    const rows = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as Array<{
      query: string;
      count: number;
    }>;
    this.db.exec('BEGIN;');
    try {
      let n = 0;
      for (const r of rows) {
        const q = normalize(r.query);
        if (!q || !Number.isFinite(r.count)) continue;
        this.upsertInitial.run(q, Math.trunc(r.count));
        n++;
      }
      this.db.exec('COMMIT;');
      metrics.inc('dbWrites', n);
      return n;
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  // Persist a batch of aggregated updates. Each item carries the final
  // count/recency already computed by the write pipeline (the Trie is the live
  // authority; the DB is the durable mirror).
  applyBatch(items: QueryEntry[]): number {
    if (items.length === 0) return 0;
    this.db.exec('BEGIN;');
    try {
      for (const it of items) {
        this.applyOne.run(
          it as unknown as Record<string, string | number | bigint | null>,
        );
      }
      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
    metrics.inc('dbWrites', items.length);
    return items.length;
  }

  get(query: string): DbRow | undefined {
    metrics.inc('dbReads', 1);
    return this.getOne.get(query) as DbRow | undefined;
  }

  // Full table read, used once at startup to populate the Trie + leaderboard.
  *iterateAll(): IterableIterator<DbRow> {
    const rows = this.selectAll.all() as unknown as DbRow[];
    metrics.inc('dbReads', rows.length);
    for (const r of rows) yield r;
  }

  count(): number {
    return (this.countAll.get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}

export default Db;
