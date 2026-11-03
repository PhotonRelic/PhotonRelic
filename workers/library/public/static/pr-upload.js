// PhotonRelic's uploader. Pure functions first, so they can be unit-tested in
// Node; the DOM glue at the bottom runs on the Upload page and, for Replace,
// on a file page. No framework: the pages are server-rendered and this adds
// the drop zone, hashing, precheck and the four-at-a-time streamed PUTs, and
// the one-file replace that shares the hasher. Nothing is resized here: a
// file over the cap is refused and prepared on your machine with
// tools/prep-images.py. What the prep tool noted (capture date, camera,
// lens, and what the file said about itself) travels with the upload: from
// its manifest, or read from an unprepped file's EXIF.

export const UPLOAD_EXT = /\.(jpe?g|png|webp|avif|gif)$/i;
/** Formats a shoot exports that the store never takes as they are. */
const CAMERA_EXT = /\.(tiff?|heic|heif|psd|dng|cr2|cr3|nef|arw|raf|orf)$/i;

/** Lowercase, hyphens, one dot before the extension; jpeg becomes jpg. */
export function slugifyName(name) {
	const dot = name.lastIndexOf('.');
	const stem = (dot > 0 ? name.slice(0, dot) : name)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	const ext = dot > 0 ? name.slice(dot + 1).toLowerCase().replace('jpeg', 'jpg') : '';
	return ext ? `${stem}.${ext}` : stem;
}

export const slugifySegment = (s) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');

/**
 * Propose a key for each dropped file. `relativePath` is the path inside the
 * dropped folder ("details/IMG_0001.JPG"); with keepFolders its folders become
 * subject segments under the subject; keys start with `prefix`. Size is not
 * judged here: the precheck answers too-big against the server's cap.
 */
export function proposeKeys(files, subject, { keepFolders = true, prefix = 'media/' } = {}) {
	const base = subject
		.split('/')
		.map(slugifySegment)
		.filter(Boolean)
		.join('/');
	const out = [];
	for (const f of files) {
		const parts = (f.relativePath || f.name).split('/').filter(Boolean);
		const name = parts.pop() ?? f.name;
		if (name.startsWith('.')) continue; // .DS_Store and friends
		const folders = keepFolders ? parts.slice(f.relativePath && parts.length ? 1 : 0).map(slugifySegment).filter(Boolean) : [];
		const dir = [base, ...folders].filter(Boolean).join('/');
		const slug = slugifyName(name);
		if (!dir) {
			out.push({ file: f, key: null, problem: 'no subject' });
			continue;
		}
		if (!UPLOAD_EXT.test(slug)) {
			out.push({
				file: f,
				key: null,
				problem: CAMERA_EXT.test(slug) ? 'not a web format: convert it with tools/prep-images.py' : 'not an image',
			});
			continue;
		}
		out.push({ file: f, key: `${prefix}${dir}/${slug}`, problem: null });
	}
	return out;
}

/** The first dropped folder's own name is not a subject segment; strip it from relative paths. */
export function stripRoot(relativePath) {
	const parts = relativePath.split('/').filter(Boolean);
	return parts.length > 1 ? parts.slice(1).join('/') : parts.join('/');
}

/** Run `work(item)` over items, `concurrency` at a time, retrying each up to `retries` times
 * (an error with `noRetry` set fails at once: a retry could not change the answer). */
export async function runQueue(items, work, { concurrency = 4, retries = 3, onState = () => {} } = {}) {
	const queue = [...items];
	const results = new Map();
	async function one() {
		for (;;) {
			const item = queue.shift();
			if (item === undefined) return;
			let attempt = 0;
			for (;;) {
				attempt += 1;
				try {
					onState(item, 'uploading', attempt);
					const r = await work(item, attempt);
					results.set(item, { ok: true, value: r });
					onState(item, 'done', attempt);
					break;
				} catch (e) {
					if (attempt >= retries || e?.noRetry) {
						results.set(item, { ok: false, error: e });
						onState(item, 'failed', attempt, e);
						break;
					}
					await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
				}
			}
		}
	}
	await Promise.all(Array.from({ length: Math.max(1, concurrency) }, one));
	return results;
}

export function chunk(list, size) {
	const out = [];
	for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
	return out;
}

export const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

/** The extension a key or file name ends in, lowercase, jpeg folded to jpg; '' without one. */
export function extensionOf(name) {
	const m = /\.([a-z0-9]+)$/i.exec(name);
	return m ? m[1].toLowerCase().replace(/^jpeg$/, 'jpg') : '';
}

/**
 * Why a file cannot replace the object at `key`, before anything is hashed:
 * the key keeps its extension (pages link to it by name and type), and the
 * cap is the resizer's. Null when it may go on to the precheck.
 */
export function replaceProblem(file, key, maxBytes) {
	const want = extensionOf(key);
	const got = extensionOf(file.name);
	if (got !== want) return `a .${want} file is needed, not .${got || '(none)'}: keys keep their extension`;
	if (file.size > maxBytes) return `over ${fmtBytes(maxBytes)}, the resizer's cap: resize it with tools/prep-images.py`;
	return null;
}

// ---------------------------------------------------------------------------
// Masters: the original beside a web copy, put straight into R2 by signed URL
// ---------------------------------------------------------------------------

/** The formats a master may have; the page carries the server's list in data-master-formats. */
export const MASTER_EXT = /\.(ai|eps|pdf|psd|psb|tiff?|svg|indd|dng|cr2|cr3|nef|arw|raf|orf|rw2|heic|heif)$/i;

/** The stem a master is matched on: the path without its extension, lowercased. */
const stemOf = (path) => {
	const dot = path.lastIndexOf('.');
	return (dot > 0 ? path.slice(0, dot) : path).toLowerCase();
};

/**
 * Pair each dropped master with the web-format file of the same name in the
 * same folder: a Map from the master's relativePath to the web file's. A
 * master with no web copy beside it is not in the map.
 */
export function pairMasters(entries, formats = MASTER_EXT) {
	const web = new Map();
	for (const e of entries) {
		const path = e.relativePath || '';
		if (UPLOAD_EXT.test(path)) web.set(stemOf(path), path);
	}
	const out = new Map();
	for (const e of entries) {
		const path = e.relativePath || '';
		if (UPLOAD_EXT.test(path) || !formats.test(path)) continue;
		const pair = web.get(stemOf(path));
		if (pair) out.set(path, pair);
	}
	return out;
}

/** The parts of a file at a part size: [start, end) byte ranges, 1-based part numbers. */
export function partRanges(size, partBytes) {
	const out = [];
	for (let start = 0, n = 1; start < size || n === 1; start += partBytes, n++) out.push({ partNumber: n, start, end: Math.min(size, start + partBytes) });
	return out;
}

/**
 * Uploads a master for the web copy at `key`: asks the library for the plan
 * (one signed PUT, or a multipart upload with a signed URL per part), puts
 * the bytes straight into R2, then asks the library to complete and link it.
 * `onState(text)` reports progress. Throws on any refusal, with `noRetry`
 * when a retry could not change the answer.
 */
export async function uploadMaster(key, file, { replace = false, onState = () => {} } = {}) {
	const post = async (path, body) => {
		const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
		const json = await res.json().catch(() => ({}));
		if (!res.ok || !json.ok) throw Object.assign(new Error(json.error || `HTTP ${res.status}`), { noRetry: res.status !== 500 });
		return json;
	};
	onState('asking for a signed upload');
	const plan = await post('/library/file/master/start', { key, name: file.name, size: file.size, replace });
	const putDirect = async (url, blob) => {
		const res = await fetch(url, { method: 'PUT', body: blob, headers: { 'content-type': 'application/octet-stream' } });
		if (!res.ok) throw new Error(`the bucket answered ${res.status}`);
		return (res.headers.get('etag') || '').replace(/^"|"$/g, '');
	};
	if (plan.mode === 'single') {
		onState(`uploading ${fmtBytes(file.size)}`);
		await putDirect(plan.url, file);
		onState('completing');
		return post('/library/file/master/complete', { key, name: file.name, size: file.size });
	}
	const parts = [];
	try {
		for (const p of plan.parts) {
			const start = (p.partNumber - 1) * plan.partBytes;
			const end = Math.min(file.size, start + plan.partBytes);
			onState(`part ${p.partNumber} of ${plan.parts.length} (${fmtBytes(end - start)})`);
			const etag = await putDirect(p.url, file.slice(start, end));
			if (!etag) throw new Error('the bucket returned no ETag for a part (is CORS exposing ETag?)');
			parts.push({ partNumber: p.partNumber, etag });
		}
	} catch (e) {
		await post('/library/file/master/abort', { masterKey: plan.masterKey, uploadId: plan.uploadId }).catch(() => {});
		throw e;
	}
	onState('completing');
	return post('/library/file/master/complete', { key, name: file.name, size: file.size, uploadId: plan.uploadId, parts });
}

// ---------------------------------------------------------------------------
// Capture: the date, camera and lens the prep tool strips before upload
// ---------------------------------------------------------------------------

/** Written by tools/prep-images.py into the output folder; never uploaded. */
export const MANIFEST_NAME = 'photonrelic-manifest.json';
const CAPTURE_KEYS = ['capturedAt', 'camera', 'lens', 'originalWidth', 'originalHeight'];
/** The describe entry: what the file said about itself, and the master found beside it. */
const DESCRIBE_KEYS = ['title', 'description', 'keywords', 'creator', 'credit', 'copyright', 'origin', 'sourceUrl', 'usageTerms', 'license', 'masterName'];

/** The dropped entry that is the manifest, if the folder has one at any level. */
export function findManifest(entries) {
	return entries.find((e) => (e.relativePath || '').split('/').pop() === MANIFEST_NAME) ?? null;
}

/**
 * Pair each dropped file with its manifest entry. The manifest sits in the
 * output folder's root, so a file's name in it is its path relative to the
 * manifest's own folder ("details/side-view.jpg"). Only the capture keys are
 * taken, and only when the version is one this uploader knows: the server
 * checks the values. Returns a Map from relativePath to the entry.
 */
export function matchManifest(entries, manifestPath, manifest) {
	const out = new Map();
	if (!manifest || manifest.version !== 1 || typeof manifest.files !== 'object' || manifest.files === null) return out;
	const dir = manifestPath.slice(0, manifestPath.lastIndexOf('/') + 1);
	for (const e of entries) {
		const path = e.relativePath || '';
		if (!path.startsWith(dir)) continue;
		const row = manifest.files[path.slice(dir.length)];
		if (typeof row !== 'object' || row === null) continue;
		const entry = {};
		for (const k of CAPTURE_KEYS) if (row[k] !== undefined && row[k] !== null) entry[k] = row[k];
		if (Object.keys(entry).length) out.set(path, entry);
	}
	return out;
}

/**
 * Pair each dropped file with its manifest entry's `describe` object, the same
 * way: only the describe keys, only from a version this uploader knows.
 */
export function matchDescribe(entries, manifestPath, manifest) {
	const out = new Map();
	if (!manifest || manifest.version !== 1 || typeof manifest.files !== 'object' || manifest.files === null) return out;
	const dir = manifestPath.slice(0, manifestPath.lastIndexOf('/') + 1);
	for (const e of entries) {
		const path = e.relativePath || '';
		if (!path.startsWith(dir)) continue;
		const row = manifest.files[path.slice(dir.length)];
		const d = row && typeof row === 'object' ? row.describe : undefined;
		if (typeof d !== 'object' || d === null) continue;
		const entry = {};
		for (const k of DESCRIBE_KEYS) if (d[k] !== undefined && d[k] !== null) entry[k] = d[k];
		if (Object.keys(entry).length) out.set(path, entry);
	}
	return out;
}

/** The X-Capture and X-Describe headers: JSON, percent-encoded so a camera name is ASCII-safe in a header. */
export const captureHeader = (entry) => encodeURIComponent(JSON.stringify(entry));

// A small reader of its own rather than a vendored library: the page needs six
// tags from IFD0 and the Exif IFD, nothing a full parser offers, and a reader
// that never visits the GPS IFD or the serial-number tags cannot leak them by
// accident. Every offset is bounds-checked; anything odd returns what was read
// so far, never throws.
const TAG_MAKE = 0x010f;
const TAG_MODEL = 0x0110;
const TAG_DATETIME = 0x0132;
const TAG_ARTIST = 0x013b;
const TAG_COPYRIGHT = 0x8298;
const TAG_EXIF_IFD = 0x8769;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_LENS_MODEL = 0xa434;
const ASCII = 2;
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
const latin1 = new TextDecoder('latin1');

/** "2026:05:04 13:22:10" as the camera writes it, to ISO 8601 without a guessed timezone. */
export function exifDateToIso(s) {
	const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s.trim());
	if (!m || m[1] === '0000') return null; // some cameras write all zeros when the clock is unset
	return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
}

/** Make and model as one name; a model that already starts with the make's first word
 * ("Canon" / "Canon EOS R5", "NIKON CORPORATION" / "NIKON Z 6") is not said twice. */
export function joinCamera(make, model) {
	const m = (make || '').trim();
	const d = (model || '').trim();
	if (!m || !d) return d || m;
	const first = m.split(/\s+/)[0].toLowerCase();
	return d.toLowerCase().startsWith(first) ? d : `${m} ${d}`;
}

/** The wanted ASCII tags of a TIFF structure (what EXIF is) at `base` inside the view, by tag. */
function tiffFields(view, base, end, ifd0Tags, exifTags) {
	const wanted = {};
	if (base + 8 > end) return wanted;
	const le = view.getUint16(base) === 0x4949; // 'II' little-endian, 'MM' big-endian
	if (view.getUint16(base) !== (le ? 0x4949 : 0x4d4d) || view.getUint16(base + 2, le) !== 0x2a) return wanted;
	const u16 = (o) => view.getUint16(o, le);
	const u32 = (o) => view.getUint32(o, le);
	const text = (at, count) => {
		if (at + count > end) return null;
		const s = latin1.decode(new Uint8Array(view.buffer, view.byteOffset + at, count));
		const clean = s.replace(/\0+$/, '').trim(); // the NUL terminator is counted
		return clean || null;
	};
	function ifd(offset, tags) {
		const at = base + offset;
		if (at < base || at + 2 > end) return;
		const n = u16(at);
		for (let i = 0; i < n; i++) {
			const e = at + 2 + i * 12;
			if (e + 12 > end) return;
			const tag = u16(e);
			const type = u16(e + 2);
			const count = u32(e + 4);
			const size = (TYPE_SIZE[type] || 0) * count;
			const valueAt = size <= 4 ? e + 8 : base + u32(e + 8); // small values sit inline
			if (tag === TAG_EXIF_IFD && (type === 4 || type === 3) && count === 1) wanted.exifIfd = type === 4 ? u32(e + 8) : u16(e + 8);
			else if (tags.includes(tag) && type === ASCII && count > 0 && count <= 256) wanted[tag] = text(valueAt, count);
		}
	}
	ifd(u32(base + 4), ifd0Tags);
	if (exifTags.length && wanted.exifIfd !== undefined) ifd(wanted.exifIfd, exifTags);
	return wanted;
}

/** The capture fields from a TIFF structure at `base`. */
function readTiff(view, base, end) {
	const out = {};
	const wanted = tiffFields(view, base, end, [TAG_MAKE, TAG_MODEL, TAG_DATETIME], [TAG_DATETIME_ORIGINAL, TAG_LENS_MODEL]);
	const when = wanted[TAG_DATETIME_ORIGINAL] || wanted[TAG_DATETIME];
	const iso = when ? exifDateToIso(when) : null;
	if (iso) out.capturedAt = iso;
	const make = wanted[TAG_MAKE];
	const model = wanted[TAG_MODEL];
	if (make || model) out.camera = joinCamera(make, model);
	if (wanted[TAG_LENS_MODEL]) out.lens = wanted[TAG_LENS_MODEL];
	return out;
}

/** The attribution fields from a TIFF structure at `base`: Artist and Copyright, from IFD0 only. */
function readTiffAttribution(view, base, end) {
	const out = {};
	const wanted = tiffFields(view, base, end, [TAG_ARTIST, TAG_COPYRIGHT], []);
	if (wanted[TAG_ARTIST]) out.creator = wanted[TAG_ARTIST];
	if (wanted[TAG_COPYRIGHT]) out.copyright = wanted[TAG_COPYRIGHT];
	return out;
}

/**
 * The capture fields from the start of a file: JPEG (the APP1 Exif segment,
 * before the first scan), PNG (an eXIf chunk, before IDAT) or WebP (the EXIF
 * chunk of a VP8X file). The bytes need only reach the metadata; a container
 * that is not one of these, or has none, gives {}.
 */
export function readCapture(bytes) {
	return fromExif(bytes, readTiff);
}

/** The attribution a file carries in its EXIF (Artist, Copyright), for a file the manifest did not cover. */
export function readAttribution(bytes) {
	return fromExif(bytes, readTiffAttribution);
}

/** Finds the EXIF (TIFF) structure in a JPEG, PNG or WebP and hands it to `read`. */
function fromExif(bytes, read) {
	const view = bytes instanceof ArrayBuffer ? new DataView(bytes) : new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const end = view.byteLength;
	const tiffAt = (at, len) => {
		// Some writers put the JPEG prefix "Exif\0\0" in a PNG or WebP chunk too.
		if (len >= 6 && view.getUint32(at) === 0x45786966 && view.getUint16(at + 4) === 0) return read(view, at + 6, Math.min(end, at + len));
		return read(view, at, Math.min(end, at + len));
	};
	try {
		if (end >= 4 && view.getUint16(0) === 0xffd8) {
			let i = 2;
			while (i + 4 <= end) {
				if (view.getUint8(i) !== 0xff) return {};
				const marker = view.getUint8(i + 1);
				if (marker === 0xff) {
					i += 1;
					continue;
				}
				if (marker === 0xda || marker === 0xd9) return {}; // the scan: no Exif segment came before it
				const length = view.getUint16(i + 2);
				// APP1 also carries XMP; only the segment that starts "Exif\0\0" is the one wanted.
				if (marker === 0xe1 && length > 8 && i + 10 <= end && view.getUint32(i + 4) === 0x45786966 && view.getUint16(i + 8) === 0)
					return tiffAt(i + 4, length - 2);
				i += 2 + length;
			}
			return {};
		}
		if (end >= 8 && view.getUint32(0) === 0x89504e47) {
			let i = 8;
			while (i + 8 <= end) {
				const length = view.getUint32(i);
				const type = view.getUint32(i + 4);
				if (type === 0x65584966) return tiffAt(i + 8, length); // 'eXIf'
				if (type === 0x49444154 || type === 0x49454e44) return {}; // 'IDAT' or 'IEND': no metadata chunk before the pixels
				i += 12 + length;
			}
			return {};
		}
		if (end >= 12 && view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250) {
			let i = 12;
			while (i + 8 <= end) {
				const type = view.getUint32(i);
				const length = view.getUint32(i + 4, true);
				if (type === 0x45584946) return tiffAt(i + 8, length); // 'EXIF'
				i += 8 + length + (length & 1);
			}
			return {};
		}
	} catch {
		// an offset past the end of what was read: nothing usable
	}
	return {};
}

/** A WebP whose VP8X header says there is an EXIF chunk; it sits after the pixels, so the whole file is needed. */
export function webpHasExif(bytes) {
	const b = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
	if (b.length < 21 || b[0] !== 0x52 || b[8] !== 0x57 || b[12] !== 0x56 || b[13] !== 0x50 || b[14] !== 0x38 || b[15] !== 0x58) return false;
	return (b[20] & 0x08) !== 0;
}

// ---------------------------------------------------------------------------
// Browser glue
// ---------------------------------------------------------------------------

const WORKER_SRC = `
self.onmessage = async (e) => {
  const buf = await e.data.file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  self.postMessage({ id: e.data.id, hex });
};`;

function makeHasher() {
	const worker = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' })));
	let seq = 0;
	const pending = new Map();
	worker.onmessage = (e) => {
		const p = pending.get(e.data.id);
		if (p) {
			pending.delete(e.data.id);
			p(e.data.hex);
		}
	};
	return (file) =>
		new Promise((resolve) => {
			const id = ++seq;
			pending.set(id, resolve);
			worker.postMessage({ id, file });
		});
}

async function dimensions(file) {
	try {
		const bmp = await createImageBitmap(file);
		const d = { width: bmp.width, height: bmp.height };
		bmp.close();
		return d;
	} catch {
		return { width: null, height: null };
	}
}

// Enough of a file for its metadata: a JPEG's APP1 segment is at most 64 KB
// and sits before the scan, and a PNG's eXIf chunk comes before IDAT. A WebP
// keeps EXIF after the pixels, so only a WebP that says it has some is read whole.
const HEAD_BYTES = 1 << 20;
const EXIF_EXT = /\.(jpe?g|png|webp)$/i;

/** The capture and attribution fields from a file's own EXIF, for a file the manifest did not cover. */
async function exifFrom(file, key) {
	if (!EXIF_EXT.test(key)) return { capture: {}, describe: {} };
	try {
		const head = await file.slice(0, HEAD_BYTES).arrayBuffer();
		const bytes = webpHasExif(head) && file.size > HEAD_BYTES ? await file.arrayBuffer() : head;
		return { capture: readCapture(bytes), describe: readAttribution(bytes) };
	} catch {
		return { capture: {}, describe: {} };
	}
}

/** The prep tool's manifest, parsed, or null when the drop has none or it is not readable. */
async function readManifest(entry) {
	if (!entry) return null;
	try {
		return JSON.parse(await entry.file.text());
	} catch {
		return null;
	}
}

async function filesFromDataTransfer(dt) {
	const out = [];
	const items = [...(dt.items || [])];
	async function walkHandle(handle, path) {
		if (handle.kind === 'file') {
			const f = await handle.getFile();
			out.push({ file: f, relativePath: `${path}${f.name}` });
		} else {
			for await (const child of handle.values()) await walkHandle(child, `${path}${handle.name}/`);
		}
	}
	function walkEntry(entry, path) {
		return new Promise((resolve) => {
			if (entry.isFile) {
				entry.file((f) => {
					out.push({ file: f, relativePath: `${path}${f.name}` });
					resolve();
				});
			} else if (entry.isDirectory) {
				const reader = entry.createReader();
				const all = [];
				const read = () =>
					reader.readEntries(async (batch) => {
						if (batch.length === 0) {
							for (const e of all) await walkEntry(e, `${path}${entry.name}/`);
							resolve();
						} else {
							all.push(...batch);
							read();
						}
					});
				read();
			} else resolve();
		});
	}
	for (const item of items) {
		if (item.kind !== 'file') continue;
		if (item.getAsFileSystemHandle) {
			const h = await item.getAsFileSystemHandle();
			if (h) {
				await walkHandle(h, '');
				continue;
			}
		}
		const entry = item.webkitGetAsEntry?.();
		if (entry) await walkEntry(entry, '');
		else {
			const f = item.getAsFile();
			if (f) out.push({ file: f, relativePath: f.name });
		}
	}
	return out;
}

function init() {
	const root = document.getElementById('pr-upload');
	if (!root || root.dataset.readonly === '1') return;
	const maxBytes = Number(root.dataset.maxBytes);
	const prefix = root.dataset.uploadPrefix || 'media/';
	const mastersOn = root.dataset.masters === '1';
	const subjectInput = document.getElementById('pr-upload-subject');
	const keepFolders = document.getElementById('pr-upload-keep-folders');
	const zone = document.getElementById('pr-dropzone');
	const table = document.getElementById('pr-upload-table');
	const tbody = table.querySelector('tbody');
	const summary = document.getElementById('pr-upload-summary');
	const actions = document.getElementById('pr-upload-actions');
	const startBtn = document.getElementById('pr-upload-start');
	const retryBtn = document.getElementById('pr-upload-retry');
	const fileLink = document.getElementById('pr-upload-file-link');
	const countEl = document.getElementById('pr-upload-count');
	const hash = makeHasher();

	/** @type {Array<{file: File, relativePath: string, key: string|null, problem: string|null, state: string, message: string, sha256?: string, capture?: object|null, describe?: object|null, masterOf?: string, row?: HTMLTableRowElement}>} */
	let rows = [];

	const setState = (r, state, message = '') => {
		r.state = state;
		r.message = message;
		if (!r.row) return;
		const cell = r.row.querySelector('.st');
		cell.className = `st st-${state}`;
		cell.textContent = state + (message ? ` · ${message}` : '');
		refreshSummary();
	};

	function refreshSummary() {
		const by = {};
		let bytes = 0;
		for (const r of rows) {
			by[r.state] = (by[r.state] || 0) + 1;
			if (r.state === 'ok' || r.state === 'uploading' || r.state === 'master') bytes += r.file.size;
		}
		summary.hidden = false;
		summary.innerHTML = Object.entries(by)
			.map(([k, v]) => `<span class="st st-${k}">${k}: ${v}</span>`)
			.join('') + (bytes ? `<span>to upload: ${fmtBytes(bytes)}</span>` : '');
		const ready = rows.filter((r) => r.state === 'ok').length;
		countEl.textContent = String(ready);
		startBtn.disabled = ready === 0 && !rows.some((r) => r.state === 'master' && rows.some((w) => w.relativePath === r.masterOf && w.state === 'same-file'));
		retryBtn.hidden = !rows.some((r) => r.state === 'failed');
		const done = rows.filter((r) => r.state === 'done');
		if (done.length) {
			const first = done[0].key;
			fileLink.hidden = false;
			fileLink.href = `/library?prefix=${encodeURIComponent(first.slice(0, first.lastIndexOf('/') + 1))}`;
		}
	}

	function render() {
		tbody.innerHTML = '';
		for (const r of rows) {
			const tr = document.createElement('tr');
			// Built with textContent: a dropped file's name is not markup.
			const cell = (cls, text) => {
				const td = document.createElement('td');
				if (cls) td.className = cls;
				if (text !== undefined) td.textContent = text;
				tr.appendChild(td);
				return td;
			};
			const small = document.createElement('small');
			small.textContent = r.relativePath;
			cell('').appendChild(small);
			const keyCell = cell('key');
			cell('num', fmtBytes(r.file.size));
			cell('st');
			if (r.masterOf) {
				const note = document.createElement('small');
				note.className = 'muted';
				note.textContent = `master of ${r.masterOf}`;
				keyCell.appendChild(note);
			} else if (r.key) {
				const input = document.createElement('input');
				input.type = 'text';
				input.value = r.key;
				input.addEventListener('change', () => {
					r.key = input.value.trim();
					setState(r, 'waiting', 'renamed, check again');
					void check([r]);
				});
				keyCell.appendChild(input);
			} else {
				const note = document.createElement('small');
				note.className = 'muted';
				note.textContent = r.problem;
				keyCell.appendChild(note);
			}
			r.row = tr;
			tbody.appendChild(tr);
			setState(r, r.state, r.message);
		}
		table.hidden = rows.length === 0;
		actions.hidden = rows.length === 0;
	}

	async function check(list) {
		const candidates = list.filter((r) => r.key && !r.problem);
		for (const r of candidates) {
			if (r.file.size > maxBytes) {
				setState(r, 'too-big', `over ${fmtBytes(maxBytes)}, the resizer's cap: resize it with tools/prep-images.py`);
				continue;
			}
			setState(r, 'hashing');
			r.sha256 = await hash(r.file);
			setState(r, 'checking');
		}
		const toCheck = candidates.filter((r) => r.state === 'checking');
		for (const batch of chunk(toCheck, 200)) {
			const entries = batch.map((r) => ({ key: r.key, sha256: r.sha256, size: r.file.size }));
			let answers;
			try {
				const res = await fetch('/library/precheck', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ entries }),
				});
				const body = await res.json();
				if (!body.ok) throw new Error(body.error || `precheck ${res.status}`);
				answers = body.answers;
			} catch (e) {
				for (const r of batch) setState(r, 'failed', `precheck: ${e.message}`);
				continue;
			}
			for (let i = 0; i < batch.length; i++) {
				const a = answers[i];
				const r = batch[i];
				if (!a) setState(r, 'failed', 'no answer');
				else if (a.status === 'ok') setState(r, 'ok');
				else setState(r, a.status, a.message);
			}
		}
	}

	async function addFiles(entries) {
		const subject = subjectInput.value.trim();
		if (!subject) {
			subjectInput.focus();
			subjectInput.setCustomValidity('Give the shoot a subject first.');
			subjectInput.reportValidity();
			return;
		}
		subjectInput.setCustomValidity('');
		// A master beside a web copy with the same name goes into the bucket after it, when
		// masters are configured; otherwise it is left behind with a note.
		const pairs = pairMasters(entries);
		const masters = entries.filter((e) => pairs.has(e.relativePath));
		entries = entries.filter((e) => !pairs.has(e.relativePath));
		// A prepped folder carries what its files said about themselves; the manifest itself never goes up.
		const manifestEntry = findManifest(entries);
		const manifest = manifestEntry ? await readManifest(manifestEntry) : null;
		const captures = manifestEntry ? matchManifest(entries, manifestEntry.relativePath, manifest) : new Map();
		const describes = manifestEntry ? matchDescribe(entries, manifestEntry.relativePath, manifest) : new Map();
		const proposals = proposeKeys(
			entries
				.filter((e) => e !== manifestEntry)
				.map((e) => ({ name: e.file.name, size: e.file.size, relativePath: e.relativePath, file: e.file })),
			subject,
			{ keepFolders: keepFolders.checked, prefix },
		);
		const fresh = proposals
			.filter((p) => !rows.some((r) => r.relativePath === p.file.relativePath && r.file.size === p.file.size))
			.map((p) => ({ file: p.file.file, relativePath: p.file.relativePath, key: p.key, problem: p.problem, state: p.problem ? 'skipped' : 'waiting', message: p.problem || '', capture: captures.get(p.file.relativePath) ?? null, describe: describes.get(p.file.relativePath) ?? null }));
		const masterRows = masters
			.filter((m) => !rows.some((r) => r.relativePath === m.relativePath && r.file.size === m.file.size))
			.map((m) => ({
				file: m.file,
				relativePath: m.relativePath,
				key: null,
				problem: mastersOn ? null : 'masters are not configured: left behind',
				masterOf: pairs.get(m.relativePath),
				state: mastersOn ? 'master' : 'skipped',
				message: mastersOn ? 'goes up after its web copy' : 'masters are not configured',
			}));
		rows = [...rows, ...fresh, ...masterRows];
		render();
		await check(fresh);
	}

	/** Masters go up one at a time after the web copies, each to the key its web copy got. */
	async function startMasters() {
		const todo = rows.filter((r) => r.masterOf && r.state === 'master');
		for (const r of todo) {
			const pair = rows.find((w) => w.relativePath === r.masterOf);
			if (!pair?.key || !(pair.state === 'done' || pair.state === 'same-file')) {
				setState(r, 'failed', 'its web copy did not go up');
				continue;
			}
			try {
				await uploadMaster(pair.key, r.file, { onState: (text) => setState(r, 'uploading', text) });
				setState(r, 'done', `master of ${pair.key}`);
			} catch (e) {
				setState(r, 'failed', String(e?.message ?? e));
			}
		}
	}

	async function uploadOne(r) {
		const put = async (key, blob, extra) => {
			const res = await fetch(`/library/upload/${key.split('/').map(encodeURIComponent).join('/')}`, {
				method: 'PUT',
				headers: { 'content-type': blob.type || 'application/octet-stream', 'x-sha256': extra.sha256, ...extra.headers },
				body: blob,
			});
			const body = await res.json().catch(() => ({}));
			if (res.status === 409) {
				// A different file is at this key. The same file again is answered 200 by the
				// server (it completes a record a cut-off first attempt lost), so this is final.
				throw Object.assign(new Error(body.error || 'a different file is already at this key'), { noRetry: true });
			}
			if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
			return body;
		};
		const dims = await dimensions(r.file);
		const dimHeaders = dims.width ? { 'x-width': String(dims.width), 'x-height': String(dims.height) } : {};
		// The manifest's entries when the shoot was prepped; the file's own EXIF when it was not.
		const own = r.capture && r.describe ? null : await exifFrom(r.file, r.key);
		const capture = r.capture ?? own.capture;
		const describe = r.describe ?? own.describe;
		const captureHeaders = Object.keys(capture).length ? { 'x-capture': captureHeader(capture) } : {};
		const describeHeaders = Object.keys(describe).length ? { 'x-describe': captureHeader(describe) } : {};
		await put(r.key, r.file, { sha256: r.sha256, headers: { ...dimHeaders, ...captureHeaders, ...describeHeaders } });
	}

	async function start(onlyFailed = false) {
		const todo = rows.filter((r) => (onlyFailed ? r.state === 'failed' && r.key : r.state === 'ok'));
		startBtn.disabled = true;
		await runQueue(todo, uploadOne, {
			concurrency: 4,
			retries: 3,
			onState: (r, state, attempt, err) => setState(r, state, state === 'failed' ? String(err?.message ?? err) : attempt > 1 ? `attempt ${attempt}` : ''),
		});
		await startMasters();
		refreshSummary();
	}

	zone.addEventListener('dragover', (e) => {
		e.preventDefault();
		zone.classList.add('is-over');
	});
	zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
	zone.addEventListener('drop', async (e) => {
		e.preventDefault();
		zone.classList.remove('is-over');
		await addFiles(await filesFromDataTransfer(e.dataTransfer));
	});
	document.getElementById('pr-files').addEventListener('change', (e) => {
		void addFiles([...e.target.files].map((f) => ({ file: f, relativePath: f.name })));
		e.target.value = '';
	});
	document.getElementById('pr-folder').addEventListener('change', (e) => {
		void addFiles([...e.target.files].map((f) => ({ file: f, relativePath: f.webkitRelativePath || f.name })));
		e.target.value = '';
	});
	startBtn.addEventListener('click', () => void start(false));
	retryBtn.addEventListener('click', () => void start(true));
}

/** The file page's Replace: one file, hashed and prechecked, then one PUT over the key. */
function initReplace() {
	const root = document.getElementById('pr-replace');
	if (!root) return;
	const key = root.dataset.key;
	const maxBytes = Number(root.dataset.maxBytes);
	const input = document.getElementById('pr-replace-file');
	const state = document.getElementById('pr-replace-state');
	const button = document.getElementById('pr-replace-start');
	const hash = makeHasher();
	/** @type {{file: File, sha256: string} | null} */
	let ready = null;

	const show = (cls, text) => {
		state.hidden = false;
		state.className = `upload-summary st st-${cls}`;
		state.textContent = text;
	};

	input.addEventListener('change', async () => {
		const file = input.files[0];
		ready = null;
		button.disabled = true;
		if (!file) return;
		const problem = replaceProblem(file, key, maxBytes);
		if (problem) {
			show('bad-name', `${file.name}: ${problem}`);
			return;
		}
		show('hashing', `${file.name} · hashing`);
		const sha256 = await hash(file);
		show('checking', `${file.name} · checking`);
		try {
			const res = await fetch('/library/file/replace/precheck', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ key, sha256, size: file.size }),
			});
			const body = await res.json();
			if (!body.ok) throw new Error(body.error || `precheck ${res.status}`);
			if (body.answer.status !== 'ok') {
				show(body.answer.status, `${file.name} · ${body.answer.message}`);
				return;
			}
		} catch (e) {
			show('failed', `precheck: ${e.message}`);
			return;
		}
		ready = { file, sha256 };
		show('ok', `${file.name} (${fmtBytes(file.size)}) will replace ${key}`);
		button.disabled = false;
	});

	button.addEventListener('click', async () => {
		if (!ready) return;
		button.disabled = true;
		input.disabled = true;
		show('uploading', `replacing ${key}…`);
		try {
			const dims = await dimensions(ready.file);
			const res = await fetch(`/library/file/replace?key=${encodeURIComponent(key)}`, {
				method: 'PUT',
				headers: {
					'content-type': ready.file.type || 'application/octet-stream',
					'x-sha256': ready.sha256,
					...(dims.width ? { 'x-width': String(dims.width), 'x-height': String(dims.height) } : {}),
				},
				body: ready.file,
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
			// The answer carried a flash cookie; the file page shows it with the new etag and size.
			location.assign(`/library/file?key=${encodeURIComponent(key)}`);
		} catch (e) {
			show('failed', String(e?.message ?? e));
			input.disabled = false;
		}
	});
}

/** The file page's master upload: one file, straight into R2, then linked. */
function initMaster() {
	const root = document.getElementById('pr-master');
	const input = document.getElementById('pr-master-file');
	if (!root || !input) return;
	const key = root.dataset.key;
	const formats = new RegExp(`\\.(${(root.dataset.formats || '').split(',').filter(Boolean).join('|')})$`, 'i');
	const maxBytes = Number(root.dataset.maxBytes);
	const hasMaster = root.dataset.hasMaster === '1';
	const state = document.getElementById('pr-master-state');
	const button = document.getElementById('pr-master-start');
	const replaceBox = document.getElementById('pr-master-replace');
	let file = null;

	const show = (cls, text) => {
		state.hidden = false;
		state.className = `upload-summary st st-${cls}`;
		state.textContent = text;
	};

	input.addEventListener('change', () => {
		file = input.files[0] || null;
		button.disabled = true;
		if (!file) return;
		if (!formats.test(file.name)) {
			show('bad-name', `${file.name}: not a master format`);
			file = null;
			return;
		}
		if (file.size > maxBytes) {
			show('too-big', `${file.name}: over ${fmtBytes(maxBytes)}`);
			file = null;
			return;
		}
		show('ok', `${file.name} (${fmtBytes(file.size)}) will be the master of ${key}${hasMaster ? ' (tick Replace to put it over the one on file)' : ''}`);
		button.disabled = false;
	});

	button.addEventListener('click', async () => {
		if (!file) return;
		button.disabled = true;
		input.disabled = true;
		try {
			await uploadMaster(key, file, { replace: Boolean(replaceBox?.checked), onState: (text) => show('uploading', `${file.name} · ${text}`) });
			location.assign(`/library/file?key=${encodeURIComponent(key)}`);
		} catch (e) {
			show('failed', String(e?.message ?? e));
			input.disabled = false;
			button.disabled = false;
		}
	});
}

if (typeof document !== 'undefined') {
	init();
	initReplace();
	initMaster();
}
