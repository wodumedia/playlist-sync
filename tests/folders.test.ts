import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  artistTitleFromName,
  buildFolderPlaylists,
  buildFolders,
  type FolderEntry,
  folderSlug,
  volumeOf,
  walkFolder,
} from '../src/folders.ts';
import { type LibraryIndex, LibraryIndexSchema, PlaylistsFileSchema } from '../src/library.ts';

const D = '/Users/someone/Music/Download MP3s';
const dir = (rel: string): FolderEntry => ({ path: `${D}/${rel}`, isDir: true });
const file = (rel: string, realPath?: string): FolderEntry => ({
  path: `${D}/${rel}`,
  isDir: false,
  ...(realPath ? { realPath } : {}),
});

const index: LibraryIndex = LibraryIndexSchema.parse({
  version: 1,
  source: 'rekordbox',
  generated_at: '2026-10-07T22:27:41.199Z',
  tracks: [
    // NFD in the index (rekordbox stores some paths decomposed): still found.
    {
      id: '101',
      path: `${D}/Good tunage/Café - Song.mp3`.normalize('NFD'),
      volume: 'Macintosh HD',
      artist: 'Indexed Artist',
      title: 'Indexed Title',
    },
    { id: '102', path: '/Volumes/Ext/real/linked.mp3', volume: 'Ext', artist: 'L', title: 'Linked' },
  ],
});

function build(entries: FolderEntry[], idx: LibraryIndex | null = index) {
  return buildFolderPlaylists({
    dir: D,
    folderName: 'Download MP3s',
    entries,
    index: idx,
    bootVolume: 'Macintosh HD',
    now: '2026-10-08T12:00:00.000Z',
  });
}

describe('buildFolderPlaylists', () => {
  it('one playlist per top-level folder, natural order, nested folders flattened by relative path', () => {
    const { file: f, counts } = build([
      dir('Good tunage'),
      dir('2023 - 11 November'),
      dir('2023 - 2 February'),
      dir('+ Bandcamp'),
      dir('+ Bandcamp/Release 10'),
      dir('+ Bandcamp/Release 9'),
      file('+ Bandcamp/Release 10/01 a.mp3'),
      file('+ Bandcamp/Release 9/02 b.flac'),
      file('+ Bandcamp/Release 9/01 c.FLAC'),
      file('+ Bandcamp/top.wav'),
      file('2023 - 11 November/track 10.mp3'),
      file('2023 - 11 November/track 2.mp3'),
      file('2023 - 2 February/x.m4a'),
      file('Good tunage/Café - Song.mp3'),
    ]);
    expect(f.playlists.map((p) => p.name)).toEqual([
      '+ Bandcamp',
      '2023 - 2 February',
      '2023 - 11 November',
      'Good tunage',
    ]);
    expect(f.playlists[0]!.tracks.map((t) => t.path.slice(D.length + '/+ Bandcamp/'.length))).toEqual([
      'Release 9/01 c.FLAC',
      'Release 9/02 b.flac',
      'Release 10/01 a.mp3',
      'top.wav',
    ]);
    expect(f.playlists[2]!.tracks.map((t) => t.title)).toEqual(['track 2', 'track 10']);
    expect(f.playlists[0]!.tracks.map((t) => [t.index, t.n])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
    ]);
    expect(counts).toEqual({
      folders: 4,
      skippedEmpty: 0,
      emptyFiles: 0,
      tracks: 8,
      inIndex: 1,
      notInIndex: 7,
    });
    expect(f.folder).toBe('Download MP3s');
  });

  it('skips empty folders, hidden files and folders, non-audio files and files directly in the directory', () => {
    const { file: f, counts } = build([
      dir('Empty'),
      dir('Only art'),
      file('Only art/cover.jpg'),
      file('Only art/.hidden.mp3'),
      dir('.Trash'),
      file('.Trash/x.mp3'),
      dir('Real'),
      dir('Real/.cache'),
      file('Real/.cache/y.mp3'),
      file('Real/song.MP3'),
      file('Real/notes.txt'),
      file('Real/beat.aiff'),
      file('Real/beat.aif'),
      file('loose.mp3'),
    ]);
    expect(f.playlists.map((p) => p.name)).toEqual(['Real']);
    expect(f.playlists[0]!.tracks.map((t) => t.title)).toEqual(['beat', 'beat', 'song']);
    expect(counts.skippedEmpty).toBe(2);
    expect(counts.tracks).toBe(3);
  });

  it('leaves 0-byte files out (a folder of only 0-byte files is an empty folder)', () => {
    const { file: f, counts } = build([
      dir('+ Loose'),
      { ...file('+ Loose/a.mp3'), size: 0 },
      { ...file('+ Loose/b.mp3'), size: 1234 },
      file('+ Loose/c.mp3'),
      dir('Dead'),
      { ...file('Dead/x.mp3'), size: 0 },
    ]);
    expect(f.playlists.map((p) => [p.name, p.tracks.map((t) => t.path.split('/').pop())])).toEqual([
      ['+ Loose', ['b.mp3', 'c.mp3']],
    ]);
    expect(counts.emptyFiles).toBe(2);
    expect(counts.skippedEmpty).toBe(1);
  });

  it('takes the content ID, artist, title and volume from the index row; else from the file name', () => {
    const { file: f } = build([
      file('Good tunage/Café - Song.mp3'),
      file('Good tunage/Some Artist - A - B.mp3'),
      file('Good tunage/untitled.wav'),
      file('Good tunage/link.mp3', '/Volumes/Ext/real/linked.mp3'),
      file('Good tunage/other.mp3', '/Volumes/Other Disk/x/other.mp3'),
    ]);
    const t = f.playlists[0]!.tracks;
    const by = (title: string) => t.find((x) => x.title === title)!;
    expect(by('Indexed Title')).toMatchObject({
      content_id: '101',
      artist: 'Indexed Artist',
      volume: 'Macintosh HD',
    });
    expect(by('Indexed Title').path).toBe(`${D}/Good tunage/Café - Song.mp3`.normalize('NFC'));
    expect(by('A - B')).toMatchObject({ content_id: '', artist: 'Some Artist', volume: 'Macintosh HD' });
    expect(by('untitled')).toMatchObject({ content_id: '', artist: '' });
    // A symlink: the resolved path is what the apps and the index know.
    expect(by('Linked')).toMatchObject({
      content_id: '102',
      path: '/Volumes/Ext/real/linked.mp3',
      volume: 'Ext',
    });
    expect(by('other')).toMatchObject({ content_id: '', volume: 'Other Disk' });
  });

  it('works without an index: every content ID empty', () => {
    const { file: f, counts } = build([file('Good tunage/Café - Song.mp3')], null);
    expect(f.playlists[0]!.tracks[0]).toMatchObject({ content_id: '', artist: 'Café', title: 'Song' });
    expect(f.index_generated_at).toBeNull();
    expect(counts).toMatchObject({ inIndex: 0, notInIndex: 1 });
  });

  it('slugs are folder-<slug>, de-duplicated with a numeric suffix', () => {
    const { file: f } = build([
      file('+ Loose/a.mp3'),
      file('Loose/a.mp3'),
      file('LOOSE!/a.mp3'),
      file('★/a.mp3'),
    ]);
    expect(f.playlists.map((p) => p.slug).sort()).toEqual([
      'folder-loose',
      'folder-loose-2',
      'folder-loose-3',
      'folder-x',
    ]);
  });

  it('writes a file the playlists schema accepts, marked append-only for Music and add-files for rekordbox', () => {
    const { file: f } = build([file('Good tunage/Café - Song.mp3')]);
    const parsed = PlaylistsFileSchema.parse(JSON.parse(JSON.stringify(f)));
    expect(parsed).toEqual(f);
    expect(f.music_order).toBe('any');
    expect(f.rekordbox_add_files).toBe(true);
    expect(f.index_generated_at).toBe('2026-10-07T22:27:41.199Z');
    expect(f.playlists[0]).toMatchObject({ slug: 'folder-good-tunage', name: 'Good tunage' });
  });
});

describe('folder helpers', () => {
  it('folderSlug', () => {
    expect(folderSlug('2023 - 11 November 2023 - Beatport')).toBe('2023-11-november-2023-beatport');
    expect(folderSlug('Café Del Mar')).toBe('cafe-del-mar');
    expect(folderSlug('+++')).toBe('x');
  });
  it('artistTitleFromName', () => {
    expect(artistTitleFromName('/a/b/X - Y - Z.mp3')).toEqual({ artist: 'X', title: 'Y - Z' });
    expect(artistTitleFromName('/a/b/plain.name.mp3')).toEqual({ artist: '', title: 'plain.name' });
  });
  it('volumeOf', () => {
    expect(volumeOf('/Volumes/DJ/x.mp3', 'Macintosh HD')).toBe('DJ');
    expect(volumeOf('/Users/p/x.mp3', 'Macintosh HD')).toBe('Macintosh HD');
  });
});

describe('the fixture folders (walked from disk)', () => {
  const root = join(import.meta.dirname, 'fixtures', 'Downloads');

  it('two playlists: the 0-byte-only folder is skipped, hidden and non-audio files and a file in the root ignored', () => {
    const missing: string[] = [];
    const [b, ...more] = buildFolders([root], null, (d) => missing.push(d));
    expect(missing).toEqual([]);
    expect(more).toEqual([]);
    expect(b!.folderName).toBe('Downloads');
    expect(b!.file.playlists.map((p) => p.name)).toEqual(['Albums', 'House']);
    expect(b!.counts).toMatchObject({ folders: 2, skippedEmpty: 1, emptyFiles: 1, tracks: 5 });
    // nested folders flattened in, natural order of the path inside the folder
    expect(b!.file.playlists[0]!.tracks.map((t) => t.path.slice(root.length + '/Albums/'.length))).toEqual([
      'Artist B - Album/01 First.mp3',
      'Artist B - Album/2 Second.mp3',
      'Artist B - Album/10 Tenth.mp3',
      'Artist B - Album/CD 2/01 Second.flac',
    ]);
    expect(b!.file.playlists[1]!.tracks.map((t) => [t.artist, t.title])).toEqual([['Artist A', 'Track One']]);
  });

  it('walkFolder does not enter hidden names and records sizes', () => {
    const entries = walkFolder(root);
    expect(entries.some((e) => e.path.includes('/.'))).toBe(false);
    expect(entries.find((e) => e.path.endsWith('zero.mp3'))?.size).toBe(0);
  });

  it('a root that is not there is reported, not an error', () => {
    const missing: string[] = [];
    expect(buildFolders([join(root, 'nope')], null, (d) => missing.push(d))).toEqual([]);
    expect(missing).toEqual([join(root, 'nope')]);
  });
});
