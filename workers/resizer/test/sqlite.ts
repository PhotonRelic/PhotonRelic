/**
 * The resizer's Db interface over node:sqlite, with the library's migrations
 * applied, so the metadata API is tested against the real schema. A copy of
 * the library's helper, reduced to the read-only slice the resizer uses.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { Db, DbStatement } from '../src/db.js';

const MIGRATIONS = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'library',
  'migrations',
);

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
}
