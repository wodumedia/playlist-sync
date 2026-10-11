import { describe, expect, it } from 'vitest';
import { buildIndex, buildIndexWithMap } from '../src/index.ts';

describe('buildIndex', () => {
  it('drops deleted and non-audio rows, resolves paths, one row per path (on disk wins)', () => {
    const idx = buildIndex(
      [
        { id: '1', path: '/Users/x/a.mp3', title: 'A', artist: 'X', deleted: false },
        { id: '2', path: '/Users/x/gone.mp3', title: 'G', artist: '', deleted: false },
        { id: '3', path: '/Users/x/a.mp3', title: 'A again', artist: 'X', deleted: false },
        { id: '4', path: '/Users/x/old.mp3', title: '', artist: '', deleted: true },
        { id: '5', path: '/Users/x/video.mp4', title: '', artist: '', deleted: false },
        { id: '6', path: '/Volumes/DJ/Café.flac', title: 'C', artist: '', deleted: false },
      ],
      {
        bootVolume: 'Macintosh HD',
        realpath: (p) => (p.includes('gone') ? null : p),
        now: '2026-01-01T00:00:00Z',
        dbModifiedAt: null,
      },
    );
    expect(idx.tracks.map((t) => [t.id, t.path, t.volume, t.exists])).toEqual([
      ['1', '/Users/x/a.mp3', 'Macintosh HD', true],
      ['2', '/Users/x/gone.mp3', 'Macintosh HD', false],
      ['6', '/Volumes/DJ/Café.flac', 'DJ', true],
    ]);
  });

  it('maps every indexed content id to the kept row (a duplicate of the same file too); others are not mapped', () => {
    const { index, contentIdMap } = buildIndexWithMap(
      [
        { id: '1', path: '/Users/x/a.mp3', title: 'A', artist: 'X', deleted: false },
        { id: '3', path: '/Users/x/a.mp3', title: 'A again', artist: 'X', deleted: false },
        { id: '4', path: '/Users/x/old.mp3', title: '', artist: '', deleted: true },
        { id: '5', path: '/Users/x/video.mp4', title: '', artist: '', deleted: false },
        { id: '7', path: '/Users/x/link.mp3', title: 'L', artist: '', deleted: false },
      ],
      {
        bootVolume: 'Macintosh HD',
        realpath: (p) => (p.endsWith('link.mp3') ? '/Users/x/a.mp3' : p),
        now: '2026-01-01T00:00:00Z',
        dbModifiedAt: null,
      },
    );
    expect(index.tracks.map((t) => t.id)).toEqual(['1']);
    expect([...contentIdMap]).toEqual([
      ['1', '1'],
      ['3', '1'],
      ['7', '1'],
    ]);
  });
});
