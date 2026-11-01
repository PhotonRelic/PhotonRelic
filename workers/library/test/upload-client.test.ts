import { describe, expect, it } from 'vitest';
// The browser module's pure half: key proposals and the retrying queue.
import { proposeKeys, runQueue, slugifyName, stripRoot } from '../public/static/pr-upload.js';

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
