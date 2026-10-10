import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface Diff {
  unchanged: boolean;
  rebuild: boolean;
  remove: number[];
  add: number[];
}
type DiffFn = (have: (string | null)[], want: string[], ordered: boolean) => Diff;

// Loaded exactly as music-playlists.js loads it inside osascript.
const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'writers', 'music-diff.js'), 'utf8');
const diff = new Function(`${text}\nreturn musicPlaylistDiff;`)() as DiffFn;

/** The rows a writer ends up with: `have` minus `remove`, then `want[add]` appended (or all of `want` on rebuild). */
function result(have: (string | null)[], want: string[], d: Diff): (string | null)[] {
  if (d.rebuild) return [...want];
  const gone = new Set(d.remove);
  return [...have.filter((_h, i) => !gone.has(i)), ...d.add.map((j) => want[j]!)];
}

const NFD = '/Music/Café del Mar.mp3';
const NFC = '/Music/Café del Mar.mp3';

describe('musicPlaylistDiff', () => {
  for (const ordered of [true, false]) {
    describe(ordered ? 'ordered' : 'unordered', () => {
      it('unchanged: no ops', () => {
        const d = diff(['/a', '/b', '/c'], ['/a', '/b', '/c'], ordered);
        expect(d).toEqual({ unchanged: true, rebuild: false, remove: [], add: [] });
      });

      it('empty playlist and nothing wanted: unchanged', () => {
        expect(diff([], [], ordered).unchanged).toBe(true);
      });

      it('adds only: appends the new files', () => {
        const d = diff(['/a', '/b'], ['/a', '/b', '/c', '/d'], ordered);
        expect(d).toEqual({ unchanged: false, rebuild: false, remove: [], add: [2, 3] });
      });

      it('removes only: just the unwanted rows', () => {
        const have = ['/a', '/x', '/b', '/y', '/c'];
        const d = diff(have, ['/a', '/b', '/c'], ordered);
        expect(d).toEqual({ unchanged: false, rebuild: false, remove: [1, 3], add: [] });
        expect(result(have, ['/a', '/b', '/c'], d)).toEqual(['/a', '/b', '/c']);
      });

      it('NFD in Music vs NFC wanted (and the reverse) is the same file: no op', () => {
        expect(diff([NFD, '/b'], [NFC, '/b'], ordered).unchanged).toBe(true);
        expect(diff([NFC, '/b'], [NFD, '/b'], ordered).unchanged).toBe(true);
      });

      it('a row with no file (null) is always removed', () => {
        const d = diff(['/a', null, '/b'], ['/a', '/b'], ordered);
        expect(d.remove).toEqual([1]);
        expect(d.add).toEqual([]);
      });

      it('duplicate rows beyond the wanted copies are removed, the first ones kept', () => {
        const d = diff(['/a', '/a', '/b', '/a'], ['/a', '/b'], ordered);
        expect(d.remove).toEqual([1, 3]);
        expect(d.add).toEqual([]);
      });

      it('a file wanted twice with one row gets one more', () => {
        const have = ['/a', '/b'];
        const want = ['/a', '/b', '/a'];
        const d = diff(have, want, ordered);
        expect(d.remove).toEqual([]);
        expect(d.add).toEqual([2]);
        expect(result(have, want, d)).toEqual(want);
      });

      it('never removes a wanted row: a 4,000-row playlist with one new file is one add', () => {
        const have = Array.from({ length: 4000 }, (_x, i) => `/loose/${i}.mp3`);
        const want = [...have, '/loose/new.mp3'];
        const d = diff(have, want, ordered);
        expect(d).toEqual({ unchanged: false, rebuild: false, remove: [], add: [4000] });
      });
    });
  }

  it('ordered, order-only change at the top: full rebuild flag', () => {
    const d = diff(['/b', '/a', '/c'], ['/a', '/b', '/c'], true);
    expect(d.rebuild).toBe(true);
    expect(d.unchanged).toBe(false);
  });

  it('ordered, order change further down: keeps the matching start, rewrites the rest', () => {
    const have = ['/mix', '/view-all', '/a', '/c', '/b'];
    const want = ['/mix', '/view-all', '/a', '/b', '/c'];
    const d = diff(have, want, true);
    expect(d.rebuild).toBe(false);
    expect(d.remove).toEqual([3, 4]);
    expect(d.add).toEqual([3, 4]);
    expect(result(have, want, d)).toEqual(want);
  });

  it('ordered, a file inserted in the middle: rows after it are rewritten in order', () => {
    const have = ['/mix', '/a', '/b', '/c'];
    const want = ['/mix', '/a', '/new', '/b', '/c'];
    const d = diff(have, want, true);
    expect(result(have, want, d)).toEqual(want);
    expect(d.remove).toEqual([2, 3]);
  });

  it('ordered, an unwanted row in front of the right order: only that row goes', () => {
    const have = ['/old', '/mix', '/a'];
    const want = ['/mix', '/a'];
    const d = diff(have, want, true);
    expect(d).toEqual({ unchanged: false, rebuild: false, remove: [0], add: [] });
  });

  it('unordered, an order-only change is no change', () => {
    expect(diff(['/b', '/a', '/c'], ['/a', '/b', '/c'], false).unchanged).toBe(true);
  });

  it('unordered, new file sorting in the middle is appended, nothing removed', () => {
    const d = diff(['/a', '/c'], ['/a', '/b', '/c'], false);
    expect(d).toEqual({ unchanged: false, rebuild: false, remove: [], add: [1] });
  });

  it('ordered, randomised: the writer always ends with exactly `want`', () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let k = 0; k < 300; k++) {
      const have = Array.from({ length: rnd(8) }, () => (rnd(10) === 0 ? null : `/${rnd(6)}`));
      const want = Array.from({ length: rnd(8) }, () => `/${rnd(6)}`);
      const d = diff(have, want, true);
      expect(result(have, want, d)).toEqual(want);
      const u = diff(have, want, false);
      expect([...result(have, want, u)].sort()).toEqual([...want].sort());
    }
  });
});
