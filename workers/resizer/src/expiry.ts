/**
 * Rights expiry, read from the library's database when the resizer has it
 * bound. A key whose `expires_at` has passed is gone: 410, before any
 * transform. Without the binding nothing here runs and every key serves.
 */

import type { Db } from './db.js';

/** The UTC calendar date `expires_at` is compared against. */
export const todayIso = (): string => new Date().toISOString().slice(0, 10);

/**
 * True when the library's row for the key has an expiry date before today.
 * A database error is logged and treated as not expired: a public image host
 * must not go dark because its metadata store hiccupped.
 */
export async function isExpired(db: Db, key: string, today = todayIso()): Promise<boolean> {
  try {
    const row = await db
      .prepare('SELECT 1 AS gone FROM assets WHERE key = ?1 AND expires_at < ?2')
      .bind(key, today)
      .first<{ gone: number }>();
    return row !== null;
  } catch (e) {
    console.error('expiry check failed', key, e instanceof Error ? e.message : e);
    return false;
  }
}
