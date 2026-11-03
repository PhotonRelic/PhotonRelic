// The browser module's pure half: key proposals, the retrying queue, the
// manifest pairing, the EXIF reader and the replace checks.
import { describe, expect, it } from 'vitest';
import {
  captureHeader,
  exifDateToIso,
  extensionOf,
  findManifest,
  joinCamera,
  matchDescribe,
  matchManifest,
  proposeKeys,
  readAttribution,
  readCapture,
  replaceProblem,
  runQueue,
  slugifyName,
  stripRoot,
  webpHasExif,
} from '../public/static/pr-upload.js';

const file = (name: string, relativePath: string, size = 1000) => ({ name, relativePath, size });

describe('the uploader proposes keys from a dropped folder', () => {
  it('lowercases names, keeps subfolders as subject paths, refuses camera formats', () => {
    const out = proposeKeys(
      [
        file('IMG_0001.JPG', 'spring-shoot/IMG_0001.JPG'),
        file('Side View.jpeg', 'spring-shoot/details/Side View.jpeg'),
        file('room.png', 'spring-shoot/Room Shots/room.png'),
        file('.DS_Store', 'spring-shoot/.DS_Store'),
        file('notes.txt', 'spring-shoot/notes.txt'),
        file('hero.tif', 'spring-shoot/hero.tif', 500),
        file('huge.jpg', 'spring-shoot/huge.jpg', 30 * 1024 * 1024),
      ],
      'Products/Chairs',
    );
    // Size is the precheck's call, so huge.jpg is proposed like any other; the tif never is.
    expect(out.map((o) => [o.key, o.problem])).toEqual([
      ['media/products/chairs/img-0001.jpg', null],
      ['media/products/chairs/details/side-view.jpg', null],
      ['media/products/chairs/room-shots/room.png', null],
      [null, 'not an image'],
      [null, 'not a web format: convert it with tools/prep-images.py'],
      ['media/products/chairs/huge.jpg', null],
    ]);
    expect(proposeKeys([file('a.jpg', 'x/a.jpg')], 'chairs', { keepFolders: false })[0]?.key).toBe(
      'media/chairs/a.jpg',
    );
    expect(proposeKeys([file('a.jpg', 'a.jpg')], 'chairs', { prefix: 'assets/' })[0]?.key).toBe(
      'assets/chairs/a.jpg',
    );
    expect(proposeKeys([file('a.jpg', 'a.jpg')], '')[0]?.problem).toBe('no subject');
    expect(slugifyName('Oak 44x64 — Front.JPEG')).toBe('oak-44x64-front.jpg');
    expect(stripRoot('shoot/details/a.jpg')).toBe('details/a.jpg');
  });

  it('runs the queue four at a time and retries a failing item three times before giving up', async () => {
    const attempts = new Map<string, number>();
    let inFlight = 0;
    let peak = 0;
    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'flaky', 'broken'];
    const states: string[] = [];
    const results = await runQueue(
      items,
      async (item: string, attempt: number) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        attempts.set(item, attempt);
        await new Promise((r) => setTimeout(r, 2));
        inFlight -= 1;
        if (item === 'flaky' && attempt < 2) throw new Error('once');
        if (item === 'broken') throw new Error('always');
        return item.toUpperCase();
      },
      {
        concurrency: 4,
        retries: 3,
        onState: (item: string, state: string) => states.push(`${item}:${state}`),
      },
    );
    expect(peak).toBeLessThanOrEqual(4);
    expect(results.get('a')).toEqual({ ok: true, value: 'A' });
    expect(results.get('flaky')).toEqual({ ok: true, value: 'FLAKY' });
    expect(attempts.get('flaky')).toBe(2);
    expect(attempts.get('broken')).toBe(3);
    expect(results.get('broken')?.ok).toBe(false);
    expect(states.filter((s) => s === 'broken:failed')).toHaveLength(1);
  });

  it('lets a replacement through only with the key’s own extension and under the cap', () => {
    expect(extensionOf('Photo.JPEG')).toBe('jpg');
    expect(extensionOf('media/x/a.jpg')).toBe('jpg');
    expect(extensionOf('noext')).toBe('');
    const key = 'media/products/chair.jpg';
    expect(replaceProblem({ name: 'Reshoot.jpeg', size: 10 }, key, 100)).toBeNull();
    expect(replaceProblem({ name: 'chair.png', size: 10 }, key, 100)).toMatch(
      /a \.jpg file is needed, not \.png/,
    );
    expect(replaceProblem({ name: 'chair.jpg', size: 101 }, key, 100)).toMatch(/over/);
  });

  it('fails an item at once when the error says a retry cannot help', async () => {
    let attempts = 0;
    const results = await runQueue(
      ['conflict'],
      async () => {
        attempts += 1;
        throw Object.assign(new Error('a different file is already at this key'), {
          noRetry: true,
        });
      },
      { retries: 3 },
    );
    expect(attempts).toBe(1);
    expect(results.get('conflict')?.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fixtures: a TIFF (what EXIF is) built here, byte by byte, so the test holds
// no binary file and no real photo's data. The artist, the serial numbers and
// a GPS IFD are in it so the test can show they are never read.
// ---------------------------------------------------------------------------

type Entry = { tag: number; type: 2 | 4; value: string | number };
const POINTER_TAGS = [0x8769, 0x8825]; // Exif IFD, GPS IFD

/** IFD0 first; each further IFD is pointed to from IFD0 by POINTER_TAGS in order. */
function tiff(ifds: Entry[][], le = false): Uint8Array {
  const all = ifds.map((entries, i) =>
    i === 0
      ? [
          ...entries,
          ...ifds
            .slice(1)
            .map((_, j): Entry => ({ tag: POINTER_TAGS[j] ?? 0, type: 4, value: -1 - j })),
        ]
      : entries,
  );
  const offsets: number[] = [];
  let at = 8;
  for (const e of all) {
    offsets.push(at);
    at += 2 + 12 * e.length + 4;
  }
  const blobBase = at;
  const blob: number[] = [];
  const laid = all.map((entries) =>
    entries.map((e) => {
      if (e.type === 2) {
        const str = String(e.value);
        const count = str.length + 1; // NUL-terminated
        if (count <= 4) return { tag: e.tag, type: 2, count, inline: str, offset: 0 };
        const offset = blobBase + blob.length;
        for (const ch of str) blob.push(ch.charCodeAt(0));
        blob.push(0);
        return { tag: e.tag, type: 2, count, inline: null, offset };
      }
      const v = Number(e.value);
      return {
        tag: e.tag,
        type: 4,
        count: 1,
        inline: null,
        offset: v < 0 ? (offsets[-v] ?? 0) : v,
      };
    }),
  );
  const bytes = new Uint8Array(blobBase + blob.length);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, le ? 0x4949 : 0x4d4d);
  view.setUint16(2, 0x2a, le);
  view.setUint32(4, 8, le);
  laid.forEach((entries, i) => {
    let o = offsets[i] ?? 0;
    view.setUint16(o, entries.length, le);
    o += 2;
    for (const e of entries) {
      view.setUint16(o, e.tag, le);
      view.setUint16(o + 2, e.type, le);
      view.setUint32(o + 4, e.count, le);
      if (e.inline !== null)
        for (let k = 0; k < e.inline.length; k++) bytes[o + 8 + k] = e.inline.charCodeAt(k);
      else view.setUint32(o + 8, e.offset, le);
      o += 12;
    }
    view.setUint32(o, 0, le);
  });
  bytes.set(blob, blobBase);
  return bytes;
}

const ascii = (tag: number, value: string): Entry => ({ tag, type: 2, value });
const SHOT: Entry[][] = [
  [
    ascii(0x010f, 'Canon'),
    ascii(0x0110, 'Canon EOS R5'),
    ascii(0x0132, '2026:05:05 09:00:00'),
    ascii(0x013b, 'A. Person'),
  ],
  [
    ascii(0x9003, '2026:05:04 13:22:10'),
    ascii(0xa434, 'RF24-70mm F2.8 L IS USM'),
    ascii(0xa431, 'SERIAL-0001'),
    ascii(0xa435, 'LENS-SERIAL-0002'),
  ],
  [ascii(0x0001, 'N'), ascii(0x0003, 'E')],
];

const cat = (...parts: (Uint8Array | number[])[]) => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const be16 = (n: number) => [n >> 8, n & 0xff];
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const le32 = (n: number) => be32(n).reverse();
const text = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** SOI, a JFIF APP0, an XMP APP1 when asked (an editor's, ahead of the Exif one), the Exif APP1, a scan marker and EOI. */
const jpeg = (exif: Uint8Array | null, xmpFirst = false) => {
  const xmp = text('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>');
  return cat(
    [0xff, 0xd8],
    [0xff, 0xe0, ...be16(16), ...text('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0],
    xmpFirst ? cat([0xff, 0xe1, ...be16(xmp.length + 2)], xmp) : [],
    exif ? cat([0xff, 0xe1, ...be16(exif.length + 8)], text('Exif\0\0'), exif) : [],
    [0xff, 0xda, 0, 2, 0, 0, 0xff, 0xd9],
  );
};
const pngChunk = (type: string, data: Uint8Array | number[]) =>
  cat(be32(data.length), text(type), data, [0, 0, 0, 0]);
const png = (exif: Uint8Array | null) =>
  cat(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    pngChunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]),
    exif ? pngChunk('eXIf', exif) : [],
    pngChunk('IDAT', [0]),
    pngChunk('IEND', []),
  );
const riffChunk = (type: string, data: Uint8Array | number[]) =>
  cat(text(type), le32(data.length), data, data.length & 1 ? [0] : []);
const webp = (exif: Uint8Array | null) => {
  const body = cat(
    riffChunk('VP8X', [exif ? 0x08 : 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    riffChunk('VP8 ', [1, 2, 3]), // odd length: the reader must honor the pad byte
    exif ? riffChunk('EXIF', exif) : [],
  );
  return cat(text('RIFF'), le32(body.length + 4), text('WEBP'), body);
};

describe('the uploader reads capture data without a library', () => {
  const expected = {
    capturedAt: '2026-05-04T13:22:10',
    camera: 'Canon EOS R5',
    lens: 'RF24-70mm F2.8 L IS USM',
  };

  it('takes the date, camera and lens from a JPEG and nothing else', () => {
    const out = readCapture(jpeg(tiff(SHOT)));
    expect(out).toEqual(expected);
    // The artist, both serial numbers and the GPS IFD were in the file and are not in the result.
    const flat = JSON.stringify(out);
    for (const secret of ['A. Person', 'SERIAL', 'N', 'E'])
      expect(flat).not.toContain(`"${secret}"`);
  });

  it('reads little-endian TIFF, falls back to DateTime, and drops an unset clock', () => {
    expect(readCapture(jpeg(tiff(SHOT, true)))).toEqual(expected);
    expect(readCapture(jpeg(tiff(SHOT), true))).toEqual(expected); // XMP APP1 first: stepped over
    expect(readCapture(jpeg(null, true))).toEqual({});
    const noOriginal = tiff([SHOT[0] ?? [], [ascii(0xa434, 'EF50mm f/1.8')]]);
    expect(readCapture(jpeg(noOriginal))).toEqual({
      capturedAt: '2026-05-05T09:00:00',
      camera: 'Canon EOS R5',
      lens: 'EF50mm f/1.8',
    });
    const unset = tiff([
      [ascii(0x010f, 'SONY'), ascii(0x0110, 'ILCE-7M4'), ascii(0x0132, '0000:00:00 00:00:00')],
    ]);
    expect(readCapture(jpeg(unset))).toEqual({ camera: 'SONY ILCE-7M4' });
    expect(exifDateToIso('2026:05:04 13:22:10')).toBe('2026-05-04T13:22:10');
    expect(exifDateToIso('yesterday')).toBeNull();
    expect(joinCamera('NIKON CORPORATION', 'NIKON Z 6')).toBe('NIKON Z 6');
    expect(joinCamera('Apple', 'iPhone 15 Pro')).toBe('Apple iPhone 15 Pro');
    expect(joinCamera(null, 'X100V')).toBe('X100V');
  });

  it('reads a PNG eXIf chunk and a WebP EXIF chunk with the same parser', () => {
    expect(readCapture(png(tiff(SHOT)))).toEqual(expected);
    expect(readCapture(webp(tiff(SHOT)))).toEqual(expected);
    // The JPEG prefix inside a chunk, as some writers put it, is stepped over.
    expect(readCapture(png(cat(text('Exif\0\0'), tiff(SHOT))))).toEqual(expected);
    expect(webpHasExif(webp(tiff(SHOT)))).toBe(true);
    expect(webpHasExif(webp(null))).toBe(false);
    expect(webpHasExif(jpeg(null))).toBe(false);
  });

  it('gives nothing, and never throws, for a file with no EXIF or no sense', () => {
    expect(readCapture(jpeg(null))).toEqual({});
    expect(readCapture(png(null))).toEqual({});
    expect(readCapture(webp(null))).toEqual({});
    expect(readCapture(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toEqual({});
    expect(readCapture(new Uint8Array(0))).toEqual({});
    const whole = jpeg(tiff(SHOT));
    for (const cut of [3, 10, 25, 40, 80, whole.length - 20]) {
      expect(() => readCapture(whole.slice(0, cut))).not.toThrow();
    }
    // A pointer past the end of the buffer is ignored, not followed.
    const wild = tiff([[{ tag: 0x8769, type: 4, value: 0x7fffffff }]]);
    expect(readCapture(jpeg(wild))).toEqual({});
  });

  it('pairs dropped files with the manifest beside them and leaves the manifest out', () => {
    const entries = [
      { relativePath: 'spring-web/photonrelic-manifest.json' },
      { relativePath: 'spring-web/a.jpg' },
      { relativePath: 'spring-web/details/b.jpg' },
      { relativePath: 'spring-web/c.jpg' },
      { relativePath: 'elsewhere/a.jpg' },
    ];
    const manifestEntry = findManifest(entries);
    expect(manifestEntry?.relativePath).toBe('spring-web/photonrelic-manifest.json');
    const manifest = {
      version: 1,
      files: {
        'a.jpg': {
          capturedAt: '2026-05-04T13:22:10',
          camera: 'Canon EOS R5',
          originalWidth: 6000,
          originalHeight: 4000,
          gps: 'nope',
        },
        'details/b.jpg': { lens: 'RF 50mm' },
        'c.jpg': {},
      },
    };
    const matched = matchManifest(entries, manifestEntry?.relativePath ?? '', manifest);
    expect([...matched.keys()]).toEqual(['spring-web/a.jpg', 'spring-web/details/b.jpg']);
    expect(matched.get('spring-web/a.jpg')).toEqual({
      capturedAt: '2026-05-04T13:22:10',
      camera: 'Canon EOS R5',
      originalWidth: 6000,
      originalHeight: 4000,
    });
    const at = 'spring-web/photonrelic-manifest.json';
    expect(matchManifest(entries, at, { version: 2, files: {} }).size).toBe(0);
    expect(matchManifest(entries, at, null).size).toBe(0);
    expect(findManifest([{ relativePath: 'x/a.jpg' }])).toBeNull();
  });

  it('pairs the describe entries the same way, and reads Artist and Copyright from EXIF', () => {
    const entries = [
      { relativePath: 'spring-web/photonrelic-manifest.json' },
      { relativePath: 'spring-web/a.jpg' },
      { relativePath: 'spring-web/b.jpg' },
    ];
    const manifest = {
      version: 1,
      files: {
        'a.jpg': {
          capturedAt: '2026-05-04T13:22:10',
          describe: { title: 'A', keywords: ['x', 'y'], masterName: 'A.ai', gps: 'nope' },
        },
        'b.jpg': { describe: {} },
      },
    };
    const matched = matchDescribe(entries, 'spring-web/photonrelic-manifest.json', manifest);
    expect([...matched.keys()]).toEqual(['spring-web/a.jpg']);
    expect(matched.get('spring-web/a.jpg')).toEqual({
      title: 'A',
      keywords: ['x', 'y'],
      masterName: 'A.ai',
    });
    expect(matchDescribe(entries, 'spring-web/photonrelic-manifest.json', null).size).toBe(0);
    // The attribution reader looks at IFD0's Artist and Copyright and nothing else.
    const withCopyright = tiff([
      [...(SHOT[0] ?? []), ascii(0x8298, '© 2026 A. Person')],
      SHOT[1] ?? [],
      SHOT[2] ?? [],
    ]);
    expect(readAttribution(jpeg(withCopyright))).toEqual({
      creator: 'A. Person',
      copyright: '© 2026 A. Person',
    });
    expect(readAttribution(jpeg(tiff([[ascii(0x010f, 'Canon')]])))).toEqual({});
    expect(readAttribution(jpeg(null))).toEqual({});
    expect(JSON.stringify(readAttribution(png(withCopyright)))).not.toContain('SERIAL');
  });

  it('sends the entry as percent-encoded JSON', () => {
    const entry = { capturedAt: '2026-05-04T13:22:10', camera: 'Canon EOS R5', lens: 'RF 24–70mm' };
    const header = captureHeader(entry);
    expect(header).toMatch(/^[\x21-\x7e]+$/);
    expect(JSON.parse(decodeURIComponent(header))).toEqual(entry);
  });
});
