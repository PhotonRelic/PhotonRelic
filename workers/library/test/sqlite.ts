/**
 * The Db interface over node:sqlite, with the migrations applied, so the
 * stores and handlers are tested against real SQL. Node 22.13+ ships
 * node:sqlite without a flag.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { Db, DbStatement } from '../src/db.js';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

class Statement implements DbStatement {
  private params: SQLInputValue[] = [];
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
  ) {}
  bind(...values: unknown[]): DbStatement {
    const s = new Statement(this.db, this.sql);
    s.params = values.map((v) => (v === undefined ? null : (v as SQLInputValue)));
    return s;
  }
  async first<T>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params);
    return (row as T | undefined) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.params) as T[] };
  }
  async run(): Promise<{ meta: { changes: number; last_row_id: number } }> {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  runSync(): void {
    this.db.prepare(this.sql).run(...this.params);
  }
}

export class SqliteDb implements Db {
  readonly raw: DatabaseSync;
  constructor() {
    this.raw = new DatabaseSync(':memory:');
    for (const f of readdirSync(MIGRATIONS).sort()) {
      if (f.endsWith('.sql')) this.raw.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
    }
  }
  prepare(sql: string): DbStatement {
    return new Statement(this.raw, sql);
  }
  async batch(statements: DbStatement[]): Promise<unknown> {
    this.raw.exec('BEGIN');
    try {
      for (const s of statements) (s as Statement).runSync();
      this.raw.exec('COMMIT');
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    }
    return [];
  }
}
