// PhotonRelic's markup panel. The builder first: a plain-JS copy of
// packages/media-params' pictureMarkup and imgMarkup, so the file page can
// rebuild the markup as the choices change without a round trip (the unit
// test holds the two to the same output). The DOM glue at the bottom runs
// only on a file page that has the panel. The menu is not checked here: the
// panel only offers widths and aspects that are on it.

/** The resizer's URL for a key, resized when `w` is given. Same as media-params' mediaUrl. */
export function mediaUrl(origin, key, { w, ar, f } = {}) {
	const path = key.split('/').map(encodeURIComponent).join('/');
	const base = `${origin.replace(/\/$/, '')}/${path}`;
	if (w === undefined) return base;
	const q = new URLSearchParams({ w: String(w) });
	if (ar) q.set('ar', ar);
	q.set('f', f ?? 'auto');
	return `${base}?${q}`;
}

export const escapeAttr = (s) =>
	String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const attrs = (pairs) =>
	pairs
		.filter(([, v]) => v !== undefined)
		.map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
		.join('');

const MIME = { avif: 'image/avif', webp: 'image/webp', jpeg: 'image/jpeg' };

/** A srcset: one candidate per width, ascending, with its width descriptor. */
export function srcset(origin, key, widths, { ar, f } = {}) {
	return widths.map((w) => `${mediaUrl(origin, key, { w, ar: ar || undefined, f })} ${w}w`).join(', ');
}

/**
 * The `<picture>` (kind 'picture') or plain `<img>` (kind 'img') for a key.
 * A cover crop is exactly the largest width by the ratio; a scale-down is
 * the source scaled to the largest width, never enlarged, and claims no size
 * without the source's.
 */
export function embedMarkup(origin, key, { kind, widths, ar, sizes, alt, width, height }) {
	const ws = [...new Set(widths)].sort((p, q) => p - q);
	if (ws.length === 0) throw new Error('Tick at least one width.');
	const largest = ws[ws.length - 1];
	const size = {};
	if (ar) {
		const [a, b] = ar.split(':').map(Number);
		size.width = largest;
		size.height = Math.round((largest * b) / a);
	} else if (width && height) {
		size.width = Math.min(largest, width);
		size.height = Math.round((height * size.width) / width);
	}
	const img = (f) =>
		`<img${attrs([
			['src', mediaUrl(origin, key, { w: largest, ar: ar || undefined, f })],
			['srcset', srcset(origin, key, ws, { ar, f })],
			['sizes', sizes || '100vw'],
			['alt', alt],
			['width', size.width],
			['height', size.height],
			['loading', 'lazy'],
			['decoding', 'async'],
		])}>`;
	if (kind === 'img') return img('auto');
	const source = (f) =>
		`  <source${attrs([
			['type', MIME[f]],
			['srcset', srcset(origin, key, ws, { ar, f })],
			['sizes', sizes || '100vw'],
		])}>`;
	return ['<picture>', source('avif'), source('webp'), `  ${img('jpeg')}`, '</picture>'].join('\n');
}

// ---- DOM glue: the file page's panel ----
function init() {
	const panel = document.getElementById('pr-markup');
	if (!panel) return;
	const out = panel.querySelector('textarea[name=markup]');
	const d = panel.dataset;
	const rebuild = () => {
		const widths = [...panel.querySelectorAll('input[name=w]:checked')].map((i) => Number(i.value));
		const kind = panel.querySelector('input[name=kind]:checked')?.value ?? 'picture';
		const ar = panel.querySelector('select[name=ar]').value;
		const sizes = panel.querySelector('input[name=sizes]').value.trim();
		try {
			out.value = embedMarkup(d.origin, d.key, {
				kind,
				widths,
				ar,
				sizes,
				alt: d.alt ?? '',
				width: Number(d.width) || undefined,
				height: Number(d.height) || undefined,
			});
		} catch (e) {
			out.value = String(e?.message ?? e);
		}
	};
	panel.addEventListener('change', rebuild);
	panel.addEventListener('input', rebuild);
}

if (typeof document !== 'undefined') init();
