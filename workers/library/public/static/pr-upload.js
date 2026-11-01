// PhotonRelic's uploader. Pure functions first, so they can be unit-tested in
// Node; the DOM glue at the bottom runs only on the Upload page. No framework:
// the page is server-rendered and this adds the drop zone, hashing, precheck
// and the four-at-a-time streamed PUTs. Nothing is resized here: a file over
// the cap is refused and prepared on your machine with tools/prep-images.py.

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

	/** @type {Array<{file: File, relativePath: string, key: string|null, problem: string|null, state: string, message: string, sha256?: string, row?: HTMLTableRowElement}>} */
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
			if (r.state === 'ok' || r.state === 'uploading') bytes += r.file.size;
		}
		summary.hidden = false;
		summary.innerHTML = Object.entries(by)
			.map(([k, v]) => `<span class="st st-${k}">${k}: ${v}</span>`)
			.join('') + (bytes ? `<span>to upload: ${fmtBytes(bytes)}</span>` : '');
		const ready = rows.filter((r) => r.state === 'ok').length;
		countEl.textContent = String(ready);
		startBtn.disabled = ready === 0;
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
			if (r.key) {
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
		const proposals = proposeKeys(
			entries.map((e) => ({ name: e.file.name, size: e.file.size, relativePath: e.relativePath, file: e.file })),
			subject,
			{ keepFolders: keepFolders.checked, prefix },
		);
		const fresh = proposals
			.filter((p) => !rows.some((r) => r.relativePath === p.file.relativePath && r.file.size === p.file.size))
			.map((p) => ({ file: p.file.file, relativePath: p.file.relativePath, key: p.key, problem: p.problem, state: p.problem ? 'skipped' : 'waiting', message: p.problem || '' }));
		rows = [...rows, ...fresh];
		render();
		await check(fresh);
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
		await put(r.key, r.file, { sha256: r.sha256, headers: dimHeaders });
	}

	async function start(onlyFailed = false) {
		const todo = rows.filter((r) => (onlyFailed ? r.state === 'failed' && r.key : r.state === 'ok'));
		startBtn.disabled = true;
		await runQueue(todo, uploadOne, {
			concurrency: 4,
			retries: 3,
			onState: (r, state, attempt, err) => setState(r, state, state === 'failed' ? String(err?.message ?? err) : attempt > 1 ? `attempt ${attempt}` : ''),
		});
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

if (typeof document !== 'undefined') init();
