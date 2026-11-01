/**
 * The slice of D1 the metadata API reads with. D1Database satisfies it
 * structurally; test/sqlite.ts implements it over node:sqlite with the
 * library's migrations applied, so the queries are tested against real SQL.
 * No run or batch: the resizer never writes.
 */
export interface DbStatement {
  bind(...values: unknown[]): DbStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

export interface Db {
  prepare(sql: string): DbStatement;
}
