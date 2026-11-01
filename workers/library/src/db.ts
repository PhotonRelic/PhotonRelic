/**
 * The subset of D1's interface the stores use. D1Database satisfies it
 * structurally; test/sqlite.ts implements it over node:sqlite so the stores
 * are tested against real SQL.
 */
export interface DbStatement {
  bind(...values: unknown[]): DbStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number; last_row_id: number } }>;
}

export interface Db {
  prepare(sql: string): DbStatement;
  batch(statements: DbStatement[]): Promise<unknown>;
}

/** Run statements in chunks: D1 batches are limited in size. */
export async function batchAll(db: Db, statements: DbStatement[], chunk = 100): Promise<void> {
  for (let i = 0; i < statements.length; i += chunk) {
    await db.batch(statements.slice(i, i + chunk));
  }
}

export const nowIso = (): string => new Date().toISOString();
