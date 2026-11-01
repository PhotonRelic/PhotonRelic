/** The audit log page. */
import type { AuditEntry } from '../audit.js';
import { when } from './layout.js';

export function AuditPage({ entries, next }: { entries: AuditEntry[]; next: number | null }) {
  return (
    <>
      <div class="page-head">
        <h2>Audit</h2>
      </div>
      <p>
        <small class="muted">
          Every write the library made, with the Cloudflare Access identity that made it. Times are
          UTC.
        </small>
      </p>
      {entries.length === 0 ? (
        <p>Nothing has been written yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>Action</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr>
                <td class="num">{when(e.at)}</td>
                <td>
                  <small>{e.actor}</small>
                </td>
                <td>
                  <code>{e.action}</code>
                  {e.ok ? null : (
                    <>
                      {' '}
                      <mark class="chip chip-retired">failed</mark>
                    </>
                  )}
                </td>
                <td>
                  <small class="muted">
                    <code class="path">{e.detail ? JSON.stringify(e.detail) : ''}</code>
                  </small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {next ? (
        <p>
          <a href={`/audit?before=${next}`} role="button" class="outline">
            Older
          </a>
        </p>
      ) : null}
    </>
  );
}
