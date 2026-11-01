/** The audit log: every write, with the Access identity that made it. */
import type { Db } from './db.js';

export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  action: string;
  detail: Record<string, unknown> | null;
  ok: boolean;
}

interface Row {
  id: number;
  at: string;
  actor: string;
  action: string;
  detail: string | null;
  ok: number;
}

const fromRow = (r: Row): AuditEntry => {
  let detail: Record<string, unknown> | null = null;
  try {
    detail = r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : null;
  } catch {
    // a malformed row shows no detail rather than failing the page
  }
  return { id: r.id, at: r.at, actor: r.actor, action: r.action, detail, ok: r.ok === 1 };
};

export async function logAction(
  db: Db,
  entry: { actor: string; action: string; detail?: Record<string, unknown>; ok?: boolean },
): Promise<void> {
  await db
    .prepare('INSERT INTO audit_log (actor, action, detail, ok) VALUES (?1, ?2, ?3, ?4)')
    .bind(
      entry.actor,
      entry.action,
      entry.detail ? JSON.stringify(entry.detail) : null,
      entry.ok === false ? 0 : 1,
    )
    .run();
}

/** Newest first; `before` is an id for the next page. */
export async function recentActions(db: Db, limit = 100, before?: number): Promise<AuditEntry[]> {
  const { results } = before
    ? await db
        .prepare('SELECT * FROM audit_log WHERE id < ?2 ORDER BY id DESC LIMIT ?1')
        .bind(limit, before)
        .all<Row>()
    : await db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?1').bind(limit).all<Row>();
  return results.map(fromRow);
}
