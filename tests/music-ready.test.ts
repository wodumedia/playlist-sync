import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type Lib = { persistentID: () => string; fileTracks?: unknown };
type ReadyFn = (Music: unknown, wait: (s: number) => void, maxSeconds: number) => Lib;
type TracksFn = (lib: unknown) => { locations: string[]; ids: string[] };

// Loaded exactly as music-playlists.js loads it inside osascript.
const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'writers', 'music-ready.js'), 'utf8');
const { musicLibraryReady, musicFileTracks } = new Function(`${text}\nreturn { musicLibraryReady, musicFileTracks };`)() as {
  musicLibraryReady: ReadyFn;
  musicFileTracks: TracksFn;
};

const lib1: Lib = { persistentID: () => 'LIB1' };

describe('musicLibraryReady', () => {
  it('returns library playlist 1 at once without waiting', () => {
    let waits = 0;
    const Music = { libraryPlaylists: Object.assign([lib1], {}) };
    const got = musicLibraryReady(Music, () => waits++, 30);
    expect(got).toBe(lib1);
    expect(waits).toBe(0);
  });

  it('waits while the library list is empty, then returns it', () => {
    let polls = 0;
    let waits = 0;
    const Music = {
      get libraryPlaylists() {
        return polls++ < 3 ? [] : [lib1];
      },
    };
    const got = musicLibraryReady(Music, () => waits++, 30);
    expect(got).toBe(lib1);
    expect(waits).toBe(3);
  });

  it('retries when persistentID() throws -2700 until it works', () => {
    let calls = 0;
    let waits = 0;
    const lib: Lib = {
      persistentID: () => {
        if (calls++ < 2) throw new Error("Can't get object. (-2700)");
        return 'LIB1';
      },
    };
    const got = musicLibraryReady({ libraryPlaylists: [lib] }, () => waits++, 30);
    expect(got).toBe(lib);
    expect(waits).toBe(2);
  });

  it('throws after maxSeconds waits with the welcome-screen advice and the last error', () => {
    let waits = 0;
    const lib: Lib = {
      persistentID: () => {
        throw new Error("Can't get object. (-2700)");
      },
    };
    let message = '';
    try {
      musicLibraryReady({ libraryPlaylists: [lib] }, () => waits++, 5);
    } catch (e) {
      message = String((e as Error).message);
    }
    expect(waits).toBe(5);
    expect(message).toContain('welcome screen');
    expect(message).toContain('after 5 s');
    expect(message).toContain("Can't get object. (-2700)");
  });

  it('says "no library yet" when the list never fills', () => {
    expect(() => musicLibraryReady({ libraryPlaylists: [] }, () => {}, 2)).toThrow(/no library yet.*welcome screen/);
  });
});

describe('musicFileTracks', () => {
  it('gives empty lists without asking Music when the library has no file tracks', () => {
    let asked = 0;
    const lib = {
      fileTracks: Object.assign([], {
        location: () => asked++,
        persistentID: () => asked++,
      }),
    };
    expect(musicFileTracks(lib)).toEqual({ locations: [], ids: [] });
    expect(asked).toBe(0);
  });

  it('returns both arrays for two tracks', () => {
    const lib = {
      fileTracks: Object.assign(['a', 'b'], {
        location: () => ['/a.mp3', '/b.mp3'],
        persistentID: () => ['A', 'B'],
      }),
    };
    expect(musicFileTracks(lib)).toEqual({ locations: ['/a.mp3', '/b.mp3'], ids: ['A', 'B'] });
  });
});
