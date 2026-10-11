import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildInboundCollections,
  inboundCounts,
  inboundHash,
  type MusicReadOutput,
  type RawDump,
  type RawMyTag,
  type RawPlaylist,
  skipFolderSet,
} from '../src/collect.ts';
import { buildIndexWithMap, type RawContent } from '../src/index.ts';
import { LibraryIndexSchema, type LibraryIndex } from '../src/library.ts';

const NOW = '2026-10-07T18:00:00.000Z';

const content = (id: string, path: string, extra: Partial<RawContent> = {}): RawContent => ({
  id,
  path,
  title: `Raw ${id}`,
  artist: `RawArtist ${id}`,
  deleted: false,
  ...extra,
});

const pl = (id: string, name: string, extra: Partial<RawPlaylist> = {}): RawPlaylist => ({
  id,
  seq: 1,
  name,
  attribute: 0,
  parent_id: 'root',
  smart: false,
  deleted: false,
  songs: [],
  ...extra,
});

const tag = (id: string, name: string, extra: Partial<RawMyTag> = {}): RawMyTag => ({
  id,
  seq: 1,
  name,
  attribute: 0,
  parent_id: 'root',
  deleted: false,
  songs: [],
  ...extra,
});

const index: LibraryIndex = LibraryIndexSchema.parse({
  version: 1,
  source: 'rekordbox',
  generated_at: NOW,
  tracks: [
    { id: '11', path: '/Users/me/Music/a.mp3', volume: 'Macintosh HD', artist: 'A', title: 'Alpha', exists: false },
  ],
});

const raw: RawDump = {
  content: [content('10', '/old/a.mp3'), content('11', '/Users/me/Music/a.mp3'), content('20', '/x/clip.m4v')],
  playlists: [
    pl('1', 'From Music', { attribute: 1, seq: 9 }),
    pl('2', 'A copy', { parent_id: '1' }),
    pl('3', 'Gigs', { attribute: 1, seq: 2 }),
    pl('4', 'Miami', {
      parent_id: '3',
      seq: 1,
      songs: [
        { content_id: '20', track_no: 2 },
        { content_id: '10', track_no: 1 },
      ],
    }),
    pl('5', 'Fresh', { seq: 1, attribute: 4, smart: true, songs: [{ content_id: '11', track_no: 1 }] }),
    pl('6', 'Gone', { deleted: true }),
    pl('7', 'Warmup', { seq: 3 }),
  ],
  my_tags: [
    tag('100', 'Genre', { attribute: 1, seq: 1 }),
    tag('101', 'House', { parent_id: '100', seq: 2, songs: [{ content_id: '11', track_no: null }] }),
    tag('102', 'Techno', { parent_id: '100', seq: 1 }),
  ],
};
const contentIdMap = new Map([
  ['10', '11'],
  ['11', '11'],
]);

const music: MusicReadOutput = {
  read_at: NOW,
  playlists: [
    {
      persistent_id: 'AAA',
      name: 'Copied',
      parent_path: ['From Traktor'],
      special_kind: 'none',
      smart: false,
      tracks: [],
    },
    {
      persistent_id: 'BBB',
      name: 'Road trip',
      parent_path: ['Car'],
      special_kind: 'none',
      smart: false,
      tracks: [
        { persistent_id: 'T1', location: '/Volumes/Flex/Café.mp3', title: 'Cafe', artist: 'X' },
        { persistent_id: 'T2', location: null, title: 'Stream', artist: 'Y' },
      ],
    },
    {
      persistent_id: 'CCC',
      name: 'Recently',
      parent_path: [],
      special_kind: 'none',
      smart: true,
      tracks: [{ persistent_id: 'T3', location: null, title: '', artist: '' }],
    },
    {
      persistent_id: 'DDD',
      name: 'Mirror',
      parent_path: ['From rekordbox'],
      special_kind: 'none',
      smart: false,
      tracks: [],
    },
  ],
};

describe('buildInboundCollections', () => {
  const file = buildInboundCollections({
    now: NOW,
    skipFolders: [],
    bootVolume: 'Macintosh HD',
    rekordbox: { raw, index, contentIdMap },
    music,
  });

  it('reads rekordbox playlists in tree order with folder groups, skipping the From folders and deleted rows', () => {
    const rb = file.origins.rekordbox!.collections;
    expect(rb.map((c) => [c.origin_id, c.name, c.group, c.kind])).toEqual([
      ['5', 'Fresh', [], 'smart'],
      ['4', 'Miami', ['Gigs'], 'playlist'],
      ['7', 'Warmup', [], 'playlist'],
      ['tag:102', 'Techno', ['Genre'], 'tag'],
      ['tag:101', 'House', ['Genre'], 'tag'],
    ]);
    expect(rb[0]!.tracks).toEqual([]);
  });

  it('resolves songs to the kept index track, and keeps unindexed songs with no path', () => {
    const miami = file.origins.rekordbox!.collections.find((c) => c.name === 'Miami')!;
    expect(miami.tracks).toEqual([
      { path: '/Users/me/Music/a.mp3', volume: 'Macintosh HD', content_id: '11', title: 'Alpha', artist: 'A' },
      { path: null, volume: '', content_id: '20', title: 'Raw 20', artist: 'RawArtist 20' },
    ]);
  });

  it('reads Music playlists outside the skipped folders, smart ones by name only', () => {
    const m = file.origins.music!.collections;
    expect(m.map((c) => [c.origin_id, c.group, c.kind, c.tracks.length])).toEqual([
      ['BBB', ['Car'], 'playlist', 2],
      ['CCC', [], 'smart', 0],
    ]);
    expect(m[0]!.tracks.map((t) => [t.path, t.volume])).toEqual([
      ['/Volumes/Flex/Café.mp3', 'Flex'],
      [null, ''],
    ]);
    expect(file.origins.traktor).toBeUndefined();
  });

  it('counts per origin', () => {
    expect(inboundCounts(file)).toEqual({
      rekordbox: { playlists: 2, tags: 2, smart: 1, tracks: 3, noPath: 1 },
      music: { playlists: 1, tags: 0, smart: 1, tracks: 2, noPath: 1 },
    });
  });

  it('reads Traktor and drops the From folders', () => {
    const nml = `<NML><COLLECTION ENTRIES="0"></COLLECTION><PLAYLISTS><NODE TYPE="FOLDER" NAME="$ROOT"><SUBNODES>
<NODE TYPE="PLAYLIST" NAME="Set"><PLAYLIST><ENTRY><PRIMARYKEY TYPE="TRACK" KEY="Macintosh HD/:a.mp3"></PRIMARYKEY></ENTRY></PLAYLIST></NODE>
<NODE TYPE="FOLDER" NAME="From Music"><SUBNODES><NODE TYPE="PLAYLIST" NAME="Road trip"><PLAYLIST></PLAYLIST></NODE></SUBNODES></NODE>
</SUBNODES></NODE></PLAYLISTS></NML>`;
    const t = buildInboundCollections({ now: NOW, skipFolders: [], traktor: { nml, bootVolume: 'Macintosh HD' } });
    expect(t.origins.traktor!.collections.map((c) => [c.origin_id, c.tracks[0]?.path])).toEqual([['Set', '/a.mp3']]);
    expect(t.origins.rekordbox).toBeUndefined();
  });
});

describe('the folder-playlist folders are skipped', () => {
  it('a Music playlist under a configured folder is not read when that folder is skipped', () => {
    const withFolder: MusicReadOutput = {
      ...music,
      playlists: [
        ...music.playlists,
        {
          persistent_id: 'EEE',
          name: 'Good tunes',
          parent_path: ['Downloads'],
          special_kind: 'none',
          smart: false,
          tracks: [],
        },
      ],
    };
    const ids = (skip: string[]) =>
      buildInboundCollections({ now: NOW, skipFolders: skip, bootVolume: 'Macintosh HD', music: withFolder })
        .origins.music!.collections.map((c) => c.origin_id);
    expect(ids([])).toContain('EEE');
    expect(ids(['Downloads', 'Albums'])).not.toContain('EEE');
  });
});

describe('skipFolderSet', () => {
  it('always has the three From folders', () => {
    expect([...skipFolderSet(['Extra'])].sort()).toEqual(['Extra', 'From Music', 'From Traktor', 'From rekordbox'].sort());
  });
});

describe('inboundHash', () => {
  it('ignores read_at and generated_at, and sees a real change', () => {
    const a = buildInboundCollections({ now: NOW, skipFolders: [], music });
    const b = buildInboundCollections({
      now: '2026-10-08T00:00:00.000Z',
      skipFolders: [],
      music: { ...music, read_at: '2026-10-08T00:00:00.000Z' },
    });
    expect(inboundHash(a)).toBe(inboundHash(b));
    const c = buildInboundCollections({ now: NOW, skipFolders: [], music: { ...music, playlists: music.playlists.slice(0, 2) } });
    expect(inboundHash(c)).not.toBe(inboundHash(a));
  });
});

describe('a Music that was not read', () => {
  const read = buildInboundCollections({ now: NOW, skipFolders: [], bootVolume: 'Macintosh HD', music });
  const previous = read.origins.music!;

  it('carries the last read when Music is closed or the read timed out', () => {
    const closed = buildInboundCollections({
      now: '2026-10-08T09:00:00.000Z',
      skipFolders: [],
      bootVolume: 'Macintosh HD',
      previousMusic: previous,
    });
    expect(closed.origins.music).toEqual(previous);
  });

  it('hashes the same whether Music was read or not: opening or closing Music is no change', () => {
    const closed = buildInboundCollections({
      now: '2026-10-08T09:00:00.000Z',
      skipFolders: [],
      bootVolume: 'Macintosh HD',
      previousMusic: previous,
    });
    expect(inboundHash(closed)).toBe(inboundHash(read));
  });

  it('a fresh read wins over the carried one, and a real change still changes the hash', () => {
    const changed = buildInboundCollections({
      now: NOW,
      skipFolders: [],
      bootVolume: 'Macintosh HD',
      music: { ...music, playlists: music.playlists.slice(0, 2) },
      previousMusic: previous,
    });
    expect(changed.origins.music).not.toEqual(previous);
    expect(inboundHash(changed)).not.toBe(inboundHash(read));
  });

  it('the carried read goes through the skip folders', () => {
    const closed = buildInboundCollections({
      now: NOW,
      skipFolders: ['Car'],
      bootVolume: 'Macintosh HD',
      previousMusic: previous,
    });
    expect(closed.origins.music!.collections.some((c) => c.group[0] === 'Car')).toBe(false);
    expect(closed.origins.music!.collections.length).toBeLessThan(previous.collections.length);
  });

  it('no earlier read: no Music origin', () => {
    const none = buildInboundCollections({ now: NOW, skipFolders: [], previousMusic: null });
    expect(none.origins.music).toBeUndefined();
  });
});

describe('a rekordbox-dump.py output (fixture) → collections', () => {
  const dump = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'rekordbox-dump.json'), 'utf8')) as RawDump;
  const onDisk = new Set(['/Users/dj/Music/House/one.mp3', '/Users/dj/Music/House/two.mp3']);
  const { index, contentIdMap } = buildIndexWithMap(dump.content, {
    bootVolume: 'Macintosh HD',
    realpath: (p) => (onDisk.has(p) ? p : null),
    now: NOW,
    dbModifiedAt: null,
  });
  const file = buildInboundCollections({
    now: NOW,
    skipFolders: ['Downloads'],
    bootVolume: 'Macintosh HD',
    rekordbox: { raw: dump, index, contentIdMap },
  });
  const rb = file.origins.rekordbox!.collections;

  it('reads nested playlists with their folder chain and My Tags under their group', () => {
    expect(rb.map((c) => [c.origin_id, c.name, c.group, c.kind])).toEqual([
      ['2', 'Peak', ['Sets', 'Club'], 'playlist'],
      ['4', 'Auto', [], 'smart'],
      ['tag:21', 'Deep', ['Genre'], 'tag'],
      ['tag:31', 'Opener', ['Situation'], 'tag'],
    ]);
  });

  it('a duplicate content row resolves to the kept file; a missing file keeps its path; a video has none', () => {
    expect(rb[0]!.tracks.map((t) => [t.content_id, t.path])).toEqual([
      ['101', '/Users/dj/Music/House/one.mp3'],
      ['101', '/Users/dj/Music/House/one.mp3'],
      ['103', '/Users/dj/Music/gone.mp3'],
      ['104', null],
    ]);
    expect(rb[2]!.tracks.map((t) => t.title)).toEqual(['Two']);
  });
});
