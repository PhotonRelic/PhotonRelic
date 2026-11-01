/**
 * The media library pages: the bucket-first browser with selection and the
 * bulk bar, one file, the upload page (with the rclone procedure beside the
 * drop zone), the bulk filing preview, the duplicates view and the unfiled
 * queue.
 */
import type {
  Asset,
  DuplicateGroup,
  SearchFacets,
  SearchFilters,
  SearchState,
} from '../library.js';
import { altFromPattern, SEARCH_STATES } from '../library.js';
import {
  basenameOf,
  type MediaLayout,
  type MediaObject,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_LABEL,
} from '../media.js';
import { kb, when } from './layout.js';

/** How a page builds an image URL for a key; the handler binds it to the deps. */
export type Preview = (key: string, width?: number) => string;

export type LibraryTab = 'library' | 'search' | 'upload' | 'unfiled' | 'duplicates';

export function Tabs({ active }: { active: LibraryTab }) {
  const items: [LibraryTab, string, string][] = [
    ['library', '/library', 'Library'],
    ['search', '/library/search', 'Search'],
    ['upload', '/library/upload', 'Upload'],
    ['unfiled', '/library/unfiled', 'Unfiled'],
    ['duplicates', '/library/duplicates', 'Duplicates'],
  ];
  return (
    <nav class="tabs" aria-label="Library">
      <ul>
        {items.map(([k, href, label]) => (
          <li>
            <a href={href} class={k === active ? 'active' : undefined}>
              {label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function PageHead({ title, children }: { title: string; children?: unknown }) {
  return (
    <div class="page-head">
      <h2>{title}</h2>
      {children ? <div class="inline-form">{children}</div> : null}
    </div>
  );
}

function RescanButton() {
  return (
    <form method="post" action="/library/rescan" class="inline-form">
      <button
        type="submit"
        class="outline"
        title="Walk the bucket and refresh the library; files nothing"
      >
        Rescan
      </button>
    </form>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  return (
    <button
      type="button"
      class="outline slim"
      data-copy={value}
      x-on:click="navigator.clipboard.writeText($el.dataset.copy); $el.textContent = 'Copied'"
    >
      {label}
    </button>
  );
}

export function sourceLabel(asset: Asset | undefined): string {
  return asset?.source === 'upload' ? 'uploaded here' : 'found in the bucket';
}

export interface LibraryStats {
  unfiled: number;
  duplicateKeys: number;
}

export function StatsRow({ stats }: { stats: LibraryStats }) {
  const card = (n: number, label: string, href: string) => (
    <a href={href} class={`stat-card${n ? ' stat-attention' : ''}`}>
      <span class="stat-value">{n}</span>
      <span class="stat-label">{label}</span>
    </a>
  );
  return (
    <div class="stat-grid">
      {card(stats.unfiled, 'Unfiled files', '/library/unfiled')}
      {card(stats.duplicateKeys, 'Keys in duplicate groups', '/library/duplicates')}
    </div>
  );
}

export interface Tile {
  object: MediaObject;
  asset: Asset | undefined;
}

export function filingLabel(asset: Asset | undefined): 'filed' | 'unfiled' | 'retired' {
  if (asset?.retired) return 'retired';
  return asset?.subject ? 'filed' : 'unfiled';
}

const fileHref = (key: string) => `/library/file?key=${encodeURIComponent(key)}`;

/** The thumbnail grid every library listing uses, inside the selection form. */
export function TileGrid({ tiles, preview }: { tiles: Tile[]; preview: Preview }) {
  return (
    <div class="tile-grid">
      {tiles.map(({ object: o, asset }) => {
        const filing = filingLabel(asset);
        const hay =
          `${o.key} ${asset?.tags.join(' ') ?? ''} ${asset?.alt_default ?? ''}`.toLowerCase();
        return (
          <article
            class={`tile tile-${filing}`}
            x-show={`${JSON.stringify(hay)}.includes(q.toLowerCase())`}
          >
            <label class="tile-select">
              <input type="checkbox" name="keys" value={o.key} />
              <span class="muted">select</span>
            </label>
            <a href={fileHref(o.key)}>
              <img class="thumb" src={preview(o.key, 320)} alt="" loading="lazy" />
            </a>
            <p>
              <a href={fileHref(o.key)}>
                <code class="path">{basenameOf(o.key)}</code>
              </a>
            </p>
            <p class="tile-chips">
              <mark class={`chip chip-${filing}`}>{filing}</mark>{' '}
              <small class="muted">{sourceLabel(asset)}</small>
            </p>
            {asset?.tags.length ? (
              <p>
                <small class="muted">{asset.tags.join(', ')}</small>
              </p>
            ) : null}
            <p>
              <CopyButton value={o.key} label="Copy path" />{' '}
              <small class="muted">{kb(o.size)}</small>
            </p>
          </article>
        );
      })}
    </div>
  );
}

/** Filing over a selection. Inside the selection form. */
export function BulkBar({ back }: { back: string }) {
  return (
    <details class="bulk-bar">
      <summary>With the selected files…</summary>
      <input type="hidden" name="back" value={back} />
      <div class="bulk-grid">
        <label>
          Subject
          <input type="text" name="subject" placeholder="products/chairs (blank leaves it)" />
        </label>
        <label>
          Add tags
          <input type="text" name="add_tags" placeholder="hero, detail" />
        </label>
        <label>
          Remove tags
          <input type="text" name="remove_tags" placeholder="draft" />
        </label>
        <label>
          Credit
          <input type="text" name="credit" placeholder="Photographer (blank leaves it)" />
        </label>
        <label>
          Default alt text pattern
          <input
            type="text"
            name="alt_pattern"
            placeholder={'{subject}, {name}'}
            title="{name} is the file name's words, {subject} the subject folder's"
          />
        </label>
      </div>
      <p class="bulk-actions">
        <button type="submit" class="secondary slim">
          Preview filing
        </button>
      </p>
    </details>
  );
}

function SelectionForm({
  back,
  tiles,
  preview,
  filter = true,
}: {
  back: string;
  tiles: Tile[];
  preview: Preview;
  /** The in-page filter box; off where the page is itself a search. */
  filter?: boolean;
}) {
  return (
    <form method="post" action="/library/bulk" x-data="{ q: '' }" class="selection-form">
      {filter ? (
        <input type="search" placeholder="Filter by path, tag or alt text…" x-model="q" />
      ) : null}
      <BulkBar back={back} />
      <TileGrid tiles={tiles} preview={preview} />
    </form>
  );
}

/** The results page for a search; page 1 and the defaults are left out of the URL. */
export function searchHref(f: SearchFilters, page = 1): string {
  const params = new URLSearchParams();
  if (f.q) params.set('q', f.q);
  if (f.subject !== null) params.set('subject', f.subject);
  if (f.tag !== null) params.set('tag', f.tag);
  if (f.state !== 'all') params.set('state', f.state);
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  return qs ? `/library/search?${qs}` : '/library/search';
}

/** One row of filter values as links: the chosen one links to its own removal. */
function FacetRow({
  label,
  items,
  current,
  hrefFor,
}: {
  label: string;
  items: { value: string; n?: number }[];
  current: string | null;
  hrefFor: (value: string | null) => string;
}) {
  if (items.length === 0) return null;
  return (
    <p class="facet-row">
      <span class="facet-label">{label}</span>
      {items.map(({ value, n }) => {
        const chosen = value === current;
        return (
          <a
            href={hrefFor(chosen ? null : value)}
            class={`facet${chosen ? ' active' : ''}`}
            title={chosen ? `Stop filtering by ${value}` : `Only ${value}`}
          >
            {value}
            {n === undefined ? null : <span class="n">{n}</span>}
            {chosen ? <span class="facet-x">×</span> : null}
          </a>
        );
      })}
    </p>
  );
}

export function SearchPage({
  filters,
  page,
  pageSize,
  total,
  tiles,
  facets,
  preview,
}: {
  filters: SearchFilters;
  page: number;
  pageSize: number;
  total: number;
  tiles: Tile[];
  facets: SearchFacets;
  preview: Preview;
}) {
  const self = searchHref(filters, page);
  const narrowed =
    filters.q !== '' || filters.subject !== null || filters.tag !== null || filters.state !== 'all';
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  const states: { value: SearchState }[] = SEARCH_STATES.map((value) => ({ value }));
  return (
    <>
      <Tabs active="search" />
      <PageHead title="Search">
        <RescanButton />
      </PageHead>
      <p>
        <small class="muted">
          Searches what the library knows about each file: its path, subject, tags, default alt text
          and credit. Only files the library has seen are found, so a file put in the bucket some
          other way appears here after a Rescan has noted it. Select tiles to file the results in
          bulk, as in the Library.
        </small>
      </p>
      <form method="get" action="/library/search" class="filter-bar search-bar">
        <input
          type="search"
          name="q"
          value={filters.q}
          placeholder="Words from the path, tags, alt text or credit…"
          aria-label="Search the library"
          autofocus
        />
        {filters.subject !== null ? (
          <input type="hidden" name="subject" value={filters.subject} />
        ) : null}
        {filters.tag !== null ? <input type="hidden" name="tag" value={filters.tag} /> : null}
        {filters.state !== 'all' ? (
          <input type="hidden" name="state" value={filters.state} />
        ) : null}
        <button type="submit" class="secondary slim">
          Search
        </button>
        {narrowed ? (
          <a href="/library/search" role="button" class="outline slim">
            Clear
          </a>
        ) : null}
      </form>
      <FacetRow
        label="State"
        items={states}
        current={filters.state}
        hrefFor={(v) => searchHref({ ...filters, state: (v as SearchState | null) ?? 'all' })}
      />
      <FacetRow
        label="Subject"
        items={facets.subjects}
        current={filters.subject}
        hrefFor={(v) => searchHref({ ...filters, subject: v })}
      />
      <FacetRow
        label="Tags"
        items={facets.tags}
        current={filters.tag}
        hrefFor={(v) => searchHref({ ...filters, tag: v })}
      />
      <p class="search-count">
        <span class="n">{total}</span> {total === 1 ? 'file' : 'files'}{' '}
        {!narrowed ? 'known to the library' : total === 1 ? 'matches' : 'match'}
        {total > pageSize ? (
          <>
            , showing <span class="n">{first}</span>–<span class="n">{last}</span>
          </>
        ) : null}
      </p>
      {tiles.length ? (
        <SelectionForm back={self} tiles={tiles} preview={preview} filter={false} />
      ) : (
        <p>
          <small class="muted">
            {narrowed
              ? 'Nothing matches. Try fewer words, clear a filter, or Rescan if the file was added to the bucket outside the library.'
              : 'The library has not seen any files yet. Upload a shoot or Rescan the bucket.'}
          </small>
        </p>
      )}
      {pages > 1 ? (
        <p class="pager">
          {page > 1 ? (
            <a href={searchHref(filters, page - 1)} role="button" class="outline slim">
              Previous
            </a>
          ) : null}
          <span class="muted">
            page <span class="n">{page}</span> of <span class="n">{pages}</span>
          </span>
          {page < pages ? (
            <a href={searchHref(filters, page + 1)} role="button" class="outline slim">
              Next
            </a>
          ) : null}
        </p>
      ) : null}
    </>
  );
}

export function BrowsePage({
  prefix,
  prefixes,
  tiles,
  cursor,
  stats,
  preview,
  error,
}: {
  prefix: string;
  prefixes: string[];
  tiles: Tile[];
  cursor: string | null;
  stats: LibraryStats;
  preview: Preview;
  error: string | null;
}) {
  const crumbs: { label: string; href: string }[] = [{ label: 'bucket', href: '/library' }];
  let acc = '';
  for (const part of prefix.split('/').filter(Boolean)) {
    acc += `${part}/`;
    crumbs.push({ label: part, href: `/library?prefix=${encodeURIComponent(acc)}` });
  }
  const self = `/library?prefix=${encodeURIComponent(prefix)}`;
  return (
    <>
      <Tabs active="library" />
      <PageHead title="Library">
        <RescanButton />
      </PageHead>
      <p>
        <small class="muted">
          Every image in the bucket, listed from the bucket itself, however it got there. A file is{' '}
          <mark class="chip chip-unfiled">unfiled</mark> until it has a subject; select files and
          open the bar below to file them. <a href="/library/upload">Upload</a> a shoot, or see what{' '}
          <a href="/library/unfiled">still needs filing</a>.
        </small>
      </p>
      <StatsRow stats={stats} />
      <p class="crumbs">
        {crumbs.map((c, i) => (
          <>
            {i > 0 ? ' / ' : ''}
            <a href={c.href}>{c.label}</a>
          </>
        ))}
      </p>
      {error ? <article class="flash flash-error">{error}</article> : null}
      {prefixes.length ? (
        <ul class="folder-list">
          {prefixes.map((p) => (
            <li>
              <a href={`/library?prefix=${encodeURIComponent(p)}`}>{p.slice(prefix.length)}</a>
            </li>
          ))}
        </ul>
      ) : null}
      {tiles.length ? (
        <SelectionForm back={self} tiles={tiles} preview={preview} />
      ) : prefix && prefixes.length === 0 && !error ? (
        <p>
          <small class="muted">
            Nothing under <code>{prefix}</code> yet.
          </small>
        </p>
      ) : null}
      {cursor ? (
        <p>
          <a
            href={`/library?prefix=${encodeURIComponent(prefix)}&cursor=${encodeURIComponent(cursor)}`}
            role="button"
            class="outline"
          >
            More
          </a>
        </p>
      ) : null}
    </>
  );
}

export function UnfiledPage({
  tiles,
  preview,
  total,
}: {
  tiles: Tile[];
  preview: Preview;
  total: number;
}) {
  return (
    <>
      <Tabs active="unfiled" />
      <PageHead title="Unfiled">
        <RescanButton />
      </PageHead>
      <p>
        <small class="muted">
          Files the library has seen (a Rescan or an upload) that have no subject yet: dashboard
          drops, <code>rclone</code> syncs, other tools writing to the bucket. Select them and give
          them a subject, tags and a credit in one step. {total} waiting.
        </small>
      </p>
      {tiles.length === 0 ? (
        <p>Nothing is waiting to be filed.</p>
      ) : (
        <SelectionForm back="/library/unfiled" tiles={tiles} preview={preview} />
      )}
    </>
  );
}

export function FilePage({
  objectKey: key,
  head,
  asset,
  preview,
  publicUrl,
  hasStore,
}: {
  objectKey: string;
  head: { size: number; contentType: string; etag: string | null } | null;
  asset: Asset | null;
  preview: Preview;
  publicUrl: string | null;
  hasStore: boolean;
}) {
  const filing = filingLabel(asset ?? undefined);
  return (
    <>
      <Tabs active="library" />
      <div class="page-head">
        <h2>
          <code class="path">{key}</code>
        </h2>
        <div class="inline-form">
          <CopyButton value={key} label="Copy path" />{' '}
          {publicUrl ? <CopyButton value={publicUrl} label="Copy URL" /> : null}
        </div>
      </div>
      {!head ? (
        <article class="flash flash-error">
          This key is not in the bucket. The library's row for it is stale: Rescan forgets it.
        </article>
      ) : null}
      <div class="detail-grid">
        <article>
          {head ? (
            <img class="thumb" src={preview(key, 1024)} alt={asset?.alt_default ?? ''} />
          ) : (
            <p class="muted">No preview.</p>
          )}
          <table>
            <tbody>
              <tr>
                <td>Filing</td>
                <td>
                  <mark class={`chip chip-${filing}`}>{filing}</mark>{' '}
                  {asset?.retired && asset.retired_note ? (
                    <small class="muted">{asset.retired_note}</small>
                  ) : null}
                </td>
              </tr>
              <tr>
                <td>Source</td>
                <td>{sourceLabel(asset ?? undefined)}</td>
              </tr>
              <tr>
                <td>Size</td>
                <td class="num">
                  {head ? kb(head.size) : '—'}
                  {asset?.width && asset.height ? ` · ${asset.width} × ${asset.height}` : ''}
                </td>
              </tr>
              <tr>
                <td>Type</td>
                <td>{head?.contentType ?? asset?.content_type ?? '—'}</td>
              </tr>
              <tr>
                <td>Etag</td>
                <td>
                  <code>{head?.etag ?? asset?.etag ?? '—'}</code>
                </td>
              </tr>
              <tr>
                <td>SHA-256</td>
                <td>
                  <code>{asset?.sha256 ? `${asset.sha256.slice(0, 16)}…` : 'not known'}</code>
                </td>
              </tr>
              <tr>
                <td>First seen</td>
                <td>
                  {asset ? when(asset.first_seen) : '—'}
                  {asset?.uploaded_by ? ` by ${asset.uploaded_by}` : ''}
                </td>
              </tr>
              {publicUrl ? (
                <tr>
                  <td>URL</td>
                  <td>
                    <small>
                      <code class="path">{publicUrl}</code>
                    </small>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </article>
        <article>
          <h4>Metadata</h4>
          <form method="post" action="/library/file/save">
            <input type="hidden" name="key" value={key} />
            <label>
              Subject
              <input
                type="text"
                name="subject"
                value={asset?.subject ?? ''}
                placeholder="products/chairs"
              />
            </label>
            <label>
              Tags <small class="muted">(comma separated)</small>
              <input type="text" name="tags" value={asset?.tags.join(', ') ?? ''} />
            </label>
            <label>
              Default alt text
              <input type="text" name="alt_default" value={asset?.alt_default ?? ''} />
            </label>
            <label>
              Credit
              <input type="text" name="credit" value={asset?.credit ?? ''} />
            </label>
            <button type="submit">Save</button>
          </form>
          <form method="post" action="/library/file/retire" class="retire-form">
            <input type="hidden" name="key" value={key} />
            {asset?.retired ? (
              <>
                <input type="hidden" name="retired" value="0" />
                <button type="submit" class="outline">
                  Un-retire
                </button>
              </>
            ) : (
              <>
                <input type="hidden" name="retired" value="1" />
                <input type="text" name="note" placeholder="Why (duplicate of…, reshot…)" />
                <button type="submit" class="contrast">
                  Retire
                </button>
              </>
            )}
            <p>
              <small class="muted">
                Retiring hides the file from new work and marks it; the object stays in the bucket
                and keeps serving wherever it is already used.
              </small>
            </p>
          </form>
          {!hasStore || !head ? null : (
            <details class="delete-file">
              <summary>Delete from the bucket…</summary>
              <form method="post" action="/library/file/delete">
                <input type="hidden" name="key" value={key} />
                <p>
                  This removes <code>{key}</code> ({kb(head.size)}) from the bucket for good. There
                  is no undo; keep your originals somewhere else. Anything that links to it breaks,
                  though the edge may keep serving resized copies for up to a day.
                </p>
                <label>
                  <input type="checkbox" name="confirm" value="delete" required /> Yes, delete this
                  file
                </label>
                <button type="submit" class="contrast">
                  Delete for good
                </button>
              </form>
            </details>
          )}
        </article>
      </div>
    </>
  );
}

export function UploadPage({
  subjects,
  subject,
  layout,
  hasStore,
}: {
  /** Existing subject folders, for the datalist. */
  subjects: string[];
  subject: string;
  layout: MediaLayout;
  hasStore: boolean;
}) {
  return (
    <>
      <Tabs active="upload" />
      <PageHead title="Upload" />
      {!hasStore ? (
        <article class="flash flash-warning">
          No media bucket is bound to this Worker; uploads are off.
        </article>
      ) : null}
      <p>
        <small class="muted">
          Drop a shoot: a folder, or files. Each file is hashed in your browser and checked before a
          byte moves, so a duplicate is refused rather than stored twice; files go up four at a
          time, straight into the bucket under{' '}
          <code>{layout.uploadPrefix}&lt;subject&gt;/&lt;name&gt;</code>. Closing the tab loses
          nothing already stored: drop the same folder again and only what is missing goes up. Up to{' '}
          {UPLOAD_MAX_LABEL} a file, the resizer's input cap: a larger file is refused, so run the
          shoot through <code>tools/prep-images.py</code> first (it resizes to a chosen size or the
          largest that fits, strips metadata and fixes the names). The bucket holds web copies; keep
          your originals elsewhere.
        </small>
      </p>
      <div
        id="pr-upload"
        data-subject={subject}
        data-readonly={hasStore ? '0' : '1'}
        data-max-bytes={String(UPLOAD_MAX_BYTES)}
        data-upload-prefix={layout.uploadPrefix}
      >
        <div class="filter-bar">
          <label>
            Subject
            <input
              type="text"
              id="pr-upload-subject"
              list="pr-subjects"
              value={subject}
              placeholder="products/chairs"
              disabled={!hasStore}
            />
            <datalist id="pr-subjects">
              {subjects.map((s) => (
                <option value={s} />
              ))}
            </datalist>
          </label>
          <label>
            <input type="checkbox" id="pr-upload-keep-folders" checked disabled={!hasStore} /> Keep
            subfolders as subject paths
          </label>
          <RcloneHelp layout={layout} />
        </div>
        {!hasStore ? null : (
          <>
            <div id="pr-dropzone" class="dropzone" tabindex={0}>
              <p>
                <strong>Drop a folder or files here</strong>, or{' '}
                <label class="file-link">
                  choose files
                  <input type="file" id="pr-files" multiple accept="image/*" hidden />
                </label>{' '}
                /{' '}
                <label class="file-link">
                  choose a folder
                  <input type="file" id="pr-folder" webkitdirectory multiple hidden />
                </label>
              </p>
              <p>
                <small class="muted">
                  Names become lowercase with hyphens (jpg, png, webp, avif or gif only). A name
                  already in the bucket with different bytes is refused: rename it in the list,
                  nothing is ever overwritten.
                </small>
              </p>
            </div>
            <div id="pr-upload-summary" class="upload-summary" hidden />
            <p id="pr-upload-actions" class="bulk-actions" hidden>
              <button type="button" id="pr-upload-start" class="slim">
                Upload{' '}
                <span class="n" id="pr-upload-count">
                  0
                </span>{' '}
                files
              </button>
              <button type="button" id="pr-upload-retry" class="outline slim" hidden>
                Retry all failed
              </button>
              <a id="pr-upload-file-link" href="/library" class="outline slim" role="button" hidden>
                File the uploaded files
              </a>
            </p>
            <table id="pr-upload-table" class="upload-table" hidden>
              <thead>
                <tr>
                  <th>File</th>
                  <th>Key</th>
                  <th class="num">Size</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody />
            </table>
          </>
        )}
      </div>
    </>
  );
}

/** Syncing a directory too large for a browser sitting straight into the bucket with rclone. */
export function RcloneHelp({ layout }: { layout: MediaLayout }) {
  return (
    <details class="help-tip">
      <summary title="How to sync a directory straight into the bucket">
        Too big for the browser?
      </summary>
      <div class="help-body">
        <p>
          Tens of gigabytes go in with <code>rclone</code> from a laptop, straight into the bucket.
          Create an R2 API token with Object Read &amp; Write on this bucket only, then set the
          remote up once with the interactive walk-through, which asks for the two keys without
          echoing them or writing them to your shell history:
        </p>
        <pre>
          <code>{`rclone config
  n                      new remote
  r2                     name
  s3                     storage: Amazon S3 Compliant Storage Providers
  Cloudflare             provider: Cloudflare R2 storage
  false                  env_auth: enter the keys at the prompts
  <access key id>        pasted at the prompt
  <secret access key>    pasted at the prompt
  auto                   region
  https://<account-id>.r2.cloudflarestorage.com   endpoint
  n                      edit advanced config? no (if it asks for an ACL, choose private)
  y                      keep this remote, then q`}</code>
        </pre>
        <p>Then sync a directory to its subject, reading the list before dropping the dry run:</p>
        <pre>
          <code>{`rclone copy ./shoot-web r2:<bucket>/${layout.uploadPrefix}products/chairs \\
  --exclude ".DS_Store" --progress --dry-run      # read the list, then drop --dry-run`}</code>
        </pre>
        <p>
          <small class="muted">
            Never pass the keys on the command line: shells record every command in their history.
            Names must already be lowercase with hyphens (<code>tools/prep-images.py</code> does
            that). Afterwards press Rescan in the Library: the files appear as unfiled under their
            folder, and the bulk bar gives them their subject, tags and credit in one step.
          </small>
        </p>
      </div>
    </details>
  );
}

export interface BulkPreview {
  keys: string[];
  subject: string | undefined;
  addTags: string[];
  removeTags: string[];
  credit: string | undefined;
  altPattern: string | undefined;
  back: string;
}

export function BulkPreviewPage({
  preview,
  layout,
}: {
  preview: BulkPreview;
  layout: MediaLayout;
}) {
  const sample = preview.keys.slice(0, 5);
  const hidden = (name: string, value: string | undefined) =>
    value === undefined ? null : <input type="hidden" name={name} value={value} />;
  return (
    <>
      <Tabs active="library" />
      <PageHead title={`File ${preview.keys.length} file${preview.keys.length === 1 ? '' : 's'}`} />
      <table>
        <tbody>
          <tr>
            <td>Subject</td>
            <td>
              {preview.subject === undefined ? (
                <small class="muted">unchanged</small>
              ) : preview.subject === '' ? (
                <small class="muted">cleared</small>
              ) : (
                <code>{preview.subject}</code>
              )}
            </td>
          </tr>
          <tr>
            <td>Tags</td>
            <td>
              {preview.addTags.length ? `add ${preview.addTags.join(', ')}` : ''}
              {preview.addTags.length && preview.removeTags.length ? '; ' : ''}
              {preview.removeTags.length ? `remove ${preview.removeTags.join(', ')}` : ''}
              {!preview.addTags.length && !preview.removeTags.length ? (
                <small class="muted">unchanged</small>
              ) : null}
            </td>
          </tr>
          <tr>
            <td>Credit</td>
            <td>
              {preview.credit === undefined ? (
                <small class="muted">unchanged</small>
              ) : preview.credit === '' ? (
                <small class="muted">cleared</small>
              ) : (
                preview.credit
              )}
            </td>
          </tr>
        </tbody>
      </table>
      <h3>Default alt text, first {sample.length}</h3>
      <table>
        <thead>
          <tr>
            <th>Key</th>
            <th>Alt text</th>
          </tr>
        </thead>
        <tbody>
          {sample.map((k) => (
            <tr>
              <td>
                <code class="path">{k}</code>
              </td>
              <td>
                {preview.altPattern ? (
                  altFromPattern(layout, preview.altPattern, k)
                ) : (
                  <small class="muted">unchanged</small>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form method="post" action="/library/bulk/apply">
        {preview.keys.map((k) => (
          <input type="hidden" name="keys" value={k} />
        ))}
        {hidden('subject', preview.subject)}
        {hidden('add_tags', preview.addTags.join(','))}
        {hidden('remove_tags', preview.removeTags.join(','))}
        {hidden('credit', preview.credit)}
        {hidden('alt_pattern', preview.altPattern)}
        <input type="hidden" name="back" value={preview.back} />
        <div class="page-head">
          <button type="submit">Apply to {preview.keys.length}</button>
          <a href={preview.back} role="button" class="outline">
            Cancel
          </a>
        </div>
      </form>
    </>
  );
}

export function DuplicatesPage({
  groups,
  preview,
}: {
  groups: DuplicateGroup[];
  preview: Preview;
}) {
  return (
    <>
      <Tabs active="duplicates" />
      <PageHead title="Duplicates">
        <RescanButton />
      </PageHead>
      <p>
        <small class="muted">
          Keys that hold the same bytes: the same image through two doors. Keep one and retire the
          rest; the retired objects stay in the bucket and keep serving, so nothing that links to
          them breaks. Delete them from their file pages once nothing uses them.
        </small>
      </p>
      {groups.length === 0 ? (
        <p>No duplicates among the files the library knows. Rescan to check the bucket again.</p>
      ) : (
        groups.map((g) => (
          <form method="post" action="/library/duplicates/resolve" class="dup-group">
            <input type="hidden" name="hash" value={g.hash} />
            <div class="tile-grid">
              {g.assets.map((a, i) => (
                <article>
                  <img class="thumb" src={preview(a.key, 320)} alt="" loading="lazy" />
                  <p>
                    <a href={fileHref(a.key)}>
                      <code class="path">{a.key}</code>
                    </a>
                  </p>
                  <p>
                    <small class="muted">
                      {sourceLabel(a)} · first seen {when(a.first_seen)}
                    </small>
                  </p>
                  <label>
                    <input type="radio" name="keep" value={a.key} checked={i === 0} /> keep this one
                  </label>
                </article>
              ))}
            </div>
            <p class="bulk-actions">
              <button type="submit" class="secondary slim">
                Keep the chosen one, retire the rest
              </button>
            </p>
          </form>
        ))
      )}
    </>
  );
}
