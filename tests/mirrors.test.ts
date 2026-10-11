import { describe, expect, it } from 'vitest';
import { type Collection, type CollectionOrigin, hubCollections } from '../src/collections.ts';
import { LibraryIndexSchema, type LibraryIndex, PlaylistsFileSchema } from '../src/library.ts';
import { buildMirrorFiles, isMirrored, mirrorPlaylistName } from '../src/mirrors.ts';
import { foldersHash } from '../src/plan.ts';

const NOW = '2026-10-09T10:00:00.000Z';
const T = (path: string | null, artist = '', title = '', volume = '') => ({
  path,
  volume,
  content_id: null,
  title,
  artist,
});

function col(origin: CollectionOrigin, id: string, name: string, over: Partial<Collection> = {}): Collection {
  return {
    origin_id: id,
    name,
    group: [],
    kind: 'playlist',
    tracks: [T(`/m/${id}.mp3`, 'A', name)],
    id: `${origin}:${id}`,
    origin,
    ...over,
  };
}

const collections: Collection[] = [
  col('rekordbox', 'tag:1', 'House', { group: ['Genre'], kind: 'tag' }),
  col('rekordbox', '1', 'Warmup', {
    tracks: [
      T('/m/a.mp3', 'A', 'Alpha'),
      T(null, 'Stream', 'Nope'),
      T('/m/a.mp3', 'A', 'Alpha'),
      T('/Volumes/Ext/Café.mp3'.normalize('NFD'), 'Kay', 'Cafe'),
    ],
  }),
  col('rekordbox', '3', 'Smart one', { kind: 'smart', tracks: [] }),
  col('rekordbox', '4', 'Empty', { tracks: [] }),
  col('rekordbox', '5', 'Only streams', { tracks: [T(null, 'x', 'y')] }),
  col('rekordbox', '6', 'Warmup!', { tracks: [T('/m/6.mp3')] }),
  col('music', 'M1', 'Road trip', { group: ['A', 'B'] }),
  col('traktor', 'Set', 'Set'),
];

const index: LibraryIndex = LibraryIndexSchema.parse({
  version: 1,
  source: 'rekordbox',
  generated_at: '2026-10-09T09:00:00.000Z',
  tracks: [{ id: '77', path: '/m/a.mp3', volume: 'Macintosh HD', artist: 'Indexed', title: 'Idx Alpha' }],
});

const build = (target: CollectionOrigin, idx: LibraryIndex | null = index) =>
  buildMirrorFiles({ collections, target, index: idx, bootVolume: 'Macintosh HD', now: NOW });

describe('buildMirrorFiles', () => {
  it('an app never gets its own origin: rekordbox gets From Music and From Traktor; music gets From rekordbox and From Traktor', () => {
    expect(build('rekordbox').map((m) => [m.origin, m.folderName])).toEqual([
      ['music', 'From Music'],
      ['traktor', 'From Traktor'],
    ]);
    expect(build('music').map((m) => [m.origin, m.folderName])).toEqual([
      ['rekordbox', 'From rekordbox'],
      ['traktor', 'From Traktor'],
    ]);
    expect(build('traktor').map((m) => m.origin)).toEqual(['rekordbox', 'music']);
  });

  it('names playlists Group / Name, roots first, slugs deduped, smart / empty / no-file skipped', () => {
    const [rb] = build('music');
    expect(rb!.file.playlists.map((p) => [p.name, p.slug])).toEqual([
      ['Warmup', 'mirror-warmup'],
      ['Warmup!', 'mirror-warmup-2'],
      ['Genre / House', 'mirror-genre-house'],
    ]);
    expect(build('rekordbox')[0]!.file.playlists[0]!.name).toBe('A / B / Road trip');
    expect(mirrorPlaylistName({ group: [], name: 'X' })).toBe('X');
    expect(isMirrored(collections[2]!)).toBe(false);
    expect(isMirrored(collections[4]!)).toBe(false);
  });

  it('looks tracks up in the index (NFC), keeps duplicates, leaves out no-file rows, a valid writer file', () => {
    const [rb] = build('music');
    const warm = rb!.file.playlists[0]!;
    expect(warm.tracks.map((t) => [t.index, t.n, t.content_id, t.path, t.volume, t.artist, t.title])).toEqual([
      [0, 1, '77', '/m/a.mp3', 'Macintosh HD', 'Indexed', 'Idx Alpha'],
      [1, 2, '77', '/m/a.mp3', 'Macintosh HD', 'Indexed', 'Idx Alpha'],
      [2, 3, '', '/Volumes/Ext/Café.mp3'.normalize('NFC'), 'Ext', 'Kay', 'Cafe'],
    ]);
    expect(rb!.counts).toEqual({
      playlists: 3,
      tracks: 5,
      inIndex: 2,
      notInIndex: 3,
      noPath: 1,
      notOnDisk: 0,
      emptyPlaylists: 0,
    });
    expect(rb!.file.rekordbox_add_files).toBe(true);
    expect('music_order' in rb!.file).toBe(false);
    expect(rb!.file.folder).toBe('From rekordbox');
    expect(rb!.file.index_generated_at).toBe(index.generated_at);
    expect(PlaylistsFileSchema.parse(rb!.file)).toEqual(rb!.file);
  });

  it('works without an index and gives a stable hash', () => {
    const a = build('music', null);
    expect(a[0]!.counts.inIndex).toBe(0);
    expect(foldersHash(a.map((m) => m.file))).toBe(foldersHash(build('music', null).map((m) => m.file)));
    expect(foldersHash(a.map((m) => m.file))).not.toBe(foldersHash(build('traktor', null).map((m) => m.file)));
  });

  it('an origin with nothing to copy gives no file', () => {
    const only = collections.filter((c) => c.origin === 'traktor');
    expect(buildMirrorFiles({ collections: only, target: 'traktor', index, bootVolume: 'X', now: NOW })).toEqual([]);
  });

  it('leaves out files not on disk and playlists left empty', () => {
    const gone = [
      col('traktor', 'old', 'Old', { tracks: [T('/gone/1.mp3'), T('/gone/2.mp3')] }),
      col('traktor', 'mixed', 'Mixed', { tracks: [T('/gone/3.mp3'), T('/m/here.mp3', 'H', 'Here')] }),
    ];
    const exists = (p: string) => !p.startsWith('/gone/');
    const [m] = buildMirrorFiles({ collections: gone, target: 'music', index: null, bootVolume: 'X', now: NOW, exists });
    expect(m!.file.playlists.map((p) => p.name)).toEqual(['Mixed']);
    expect(m!.file.playlists[0]!.tracks.map((t) => [t.path, t.artist, t.title])).toEqual([['/m/here.mp3', 'H', 'Here']]);
    expect(m!.counts).toMatchObject({ playlists: 1, tracks: 1, notOnDisk: 3, emptyPlaylists: 1 });
    expect(
      buildMirrorFiles({ collections: [gone[0]!], target: 'music', index: null, bootVolume: 'X', now: NOW, exists }),
    ).toEqual([]);
  });

  it('a track with no artist or title from its origin takes them from the file name', () => {
    const c = [col('traktor', 'x', 'X', { tracks: [T('/m/Kay - Cafe.mp3')] })];
    const [m] = buildMirrorFiles({ collections: c, target: 'music', index: null, bootVolume: 'X', now: NOW });
    expect(m!.file.playlists[0]!.tracks.map((t) => [t.artist, t.title])).toEqual([['Kay', 'Cafe']]);
  });
});

describe('hubCollections', () => {
  const inbound = {
    version: 1 as const,
    generated_at: NOW,
    origins: {
      rekordbox: {
        read_at: NOW,
        collections: [
          { origin_id: '2', name: 'b list', group: [], kind: 'playlist' as const, tracks: [] },
          { origin_id: '1', name: 'A list', group: ['Z'], kind: 'playlist' as const, tracks: [] },
          { origin_id: '3', name: 'Copy', group: [' from music '], kind: 'playlist' as const, tracks: [] },
        ],
      },
      traktor: {
        read_at: NOW,
        collections: [
          { origin_id: 'x', name: 'One', group: [], kind: 'playlist' as const, tracks: [] },
          { origin_id: 'x', name: 'Two', group: [], kind: 'playlist' as const, tracks: [] },
        ],
      },
    },
  };

  it('ids per origin, skip folders matched trimmed and case-insensitively, sorted by origin, folder and name', () => {
    const hub = hubCollections(inbound, ['From Music']);
    expect(hub.map((c) => [c.id, c.origin, c.name])).toEqual([
      ['rekordbox:2', 'rekordbox', 'b list'],
      ['rekordbox:1', 'rekordbox', 'A list'],
      ['traktor:x', 'traktor', 'One'],
    ]);
  });

  it('a repeated origin id is kept once (the first copy); nothing read gives nothing', () => {
    expect(hubCollections(inbound, []).filter((c) => c.origin === 'traktor').map((c) => c.name)).toEqual(['One']);
    expect(hubCollections(null, [])).toEqual([]);
  });
});
