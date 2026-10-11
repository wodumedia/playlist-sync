import { describe, expect, it } from 'vitest';
import type { PlaylistsFile, PlaylistTrack } from '../src/library.ts';
import { spliceTraktorCollection, traktorLocation } from '../src/writers/traktor-nml.ts';

const ENTRY_A =
  '<ENTRY MODIFIED_DATE="2023/5/24" TITLE="Alpha" ARTIST="A"><LOCATION DIR="/:Music/:" FILE="a.mp3" VOLUME="Macintosh HD" VOLUMEID="Macintosh HD"></LOCATION>\n<INFO KEY="1m"></INFO>\n<CUE_V2 NAME="n.n." START="1.0"></CUE_V2>\n</ENTRY>';
const ENTRY_B =
  '<ENTRY TITLE="Beta &amp; Co" ARTIST="B"><LOCATION DIR="/:Music/:" FILE="b &amp; c.mp3" VOLUME="Macintosh HD" VOLUMEID="Macintosh HD"></LOCATION>\n</ENTRY>';
const ENTRY_C =
  '<ENTRY TITLE="Gamma" ARTIST="C"><LOCATION DIR="/:Other/:" FILE="c.mp3" VOLUME="Macintosh HD" VOLUMEID="Macintosh HD"></LOCATION>\n</ENTRY>';

const NML = [
  '<?xml version="1.0" encoding="UTF-8" standalone="no" ?>',
  '<NML VERSION="19"><HEAD COMPANY="www.native-instruments.com" PROGRAM="Traktor"></HEAD>',
  `<COLLECTION ENTRIES="3">${ENTRY_A}`,
  ENTRY_B,
  ENTRY_C,
  '</COLLECTION>',
  '<SETS ENTRIES="0"></SETS>',
  '<PLAYLISTS><NODE TYPE="FOLDER" NAME="$ROOT"><SUBNODES COUNT="1"><NODE TYPE="PLAYLIST" NAME="Old crate"><PLAYLIST ENTRIES="1" TYPE="LIST" UUID="abc"><ENTRY><PRIMARYKEY TYPE="TRACK" KEY="Macintosh HD/:Music/:a.mp3"></PRIMARYKEY></ENTRY></PLAYLIST></NODE></SUBNODES></NODE></PLAYLISTS>',
  '<INDEXING></INDEXING>',
  '</NML>',
  '',
].join('\n');

function track(path: string, extra: Partial<PlaylistTrack> = {}): PlaylistTrack {
  return { index: 0, n: 1, content_id: '1', path, volume: 'Macintosh HD', artist: 'X', title: 'Y', ...extra };
}

const FILE: PlaylistsFile = {
  version: 1,
  generated_at: '2026-10-07T00:00:00Z',
  index_generated_at: null,
  folder: 'DJ',
  playlists: [
    {
      slug: 'one',
      name: '2020 · One',
      tracks: [
        track('/Music/a.mp3'),
        track('/Music/new.mp3', { title: 'New "quoted" & <odd>' }),
        track('/Music/b & c.mp3'),
      ],
    },
    {
      slug: 'two',
      name: '2021 · Two & "Three"',
      tracks: [track('/Music/new.mp3'), track('/Volumes/Ext/Sets/d.mp3', { volume: 'Ext' })],
    },
  ],
};

describe('spliceTraktorCollection', () => {
  it('first run: adds missing entries once, appends the folder, bumps the counts', () => {
    const r = spliceTraktorCollection(NML, FILE);
    expect(r).toMatchObject({
      addedEntries: 2,
      existingEntries: 3,
      replacedFolder: false,
      playlists: 2,
      tracks: 5,
    });
    expect(r.nml).toContain('<COLLECTION ENTRIES="5">');
    expect(r.nml).toContain('<SUBNODES COUNT="2"><NODE TYPE="PLAYLIST" NAME="Old crate">');
    expect(r.nml.match(/FILE="new.mp3"/g)).toHaveLength(1);
    expect(r.nml).toContain('TITLE="New &quot;quoted&quot; &amp; &lt;odd&gt;"');
    expect(r.nml).toContain('NAME="2021 · Two &amp; &quot;Three&quot;"');
    expect(r.nml).toContain('KEY="Ext/:Sets/:d.mp3"');
    // the existing entry with cues is untouched and b & c.mp3 matched through the entity
    expect(r.nml).toContain(ENTRY_A);
    expect(r.nml).toContain(ENTRY_B);
  });

  it('is byte-identical outside the spliced spots', () => {
    const r = spliceTraktorCollection(NML, FILE);
    const folderAt = r.nml.indexOf('<NODE TYPE="FOLDER" NAME="DJ">');
    const folderEnd = r.nml.indexOf('</SUBNODES></NODE></PLAYLISTS>');
    const addedAt = r.nml.indexOf('<ENTRY TITLE="New');
    const addedEnd = r.nml.indexOf('</COLLECTION>');
    const stripped = (r.nml.slice(0, addedAt) + r.nml.slice(addedEnd, folderAt) + r.nml.slice(folderEnd))
      .replace('ENTRIES="5"', 'ENTRIES="3"')
      .replace('SUBNODES COUNT="2"', 'SUBNODES COUNT="1"');
    expect(stripped).toBe(NML);
  });

  it('second run: replaces the folder, adds no entries, counts stable', () => {
    const first = spliceTraktorCollection(NML, FILE);
    const second = spliceTraktorCollection(first.nml, FILE);
    expect(second).toMatchObject({ addedEntries: 0, existingEntries: 5, replacedFolder: true });
    expect(second.nml).toBe(first.nml);

    const smaller = { ...FILE, playlists: FILE.playlists.slice(0, 1) };
    const third = spliceTraktorCollection(first.nml, smaller);
    expect(third.replacedFolder).toBe(true);
    expect(third.nml).toContain('<SUBNODES COUNT="2"><NODE TYPE="PLAYLIST" NAME="Old crate">');
    expect(third.nml).not.toContain('2021 · Two');
    expect(third.nml.match(/NAME="DJ"/g)).toHaveLength(1);
    expect(third.nml).toContain('<COLLECTION ENTRIES="5">');
  });

  it('ignores a same-named folder nested deeper than $ROOT', () => {
    const nested = NML.replace(
      '<NODE TYPE="PLAYLIST" NAME="Old crate">',
      '<NODE TYPE="FOLDER" NAME="Sub"><SUBNODES COUNT="1"><NODE TYPE="FOLDER" NAME="DJ"><SUBNODES COUNT="0"></SUBNODES></NODE></SUBNODES></NODE><NODE TYPE="PLAYLIST" NAME="Old crate">',
    );
    const r = spliceTraktorCollection(nested, FILE);
    expect(r.replacedFolder).toBe(false);
    expect(r.nml.match(/NAME="DJ"/g)).toHaveLength(2);
  });

  it('throws clearly without <PLAYLISTS>', () => {
    const bad = NML.replace(/<PLAYLISTS>.*<\/PLAYLISTS>\n/, '');
    expect(() => spliceTraktorCollection(bad, FILE)).toThrow(/no <PLAYLISTS> section/);
    expect(() => spliceTraktorCollection('<NML></NML>', FILE)).toThrow(/no <COLLECTION>/);
  });
});

describe('traktorLocation', () => {
  it('relative to the volume root for /Volumes, else to /', () => {
    expect(traktorLocation('/Volumes/DJ/Sets/a.mp3', 'DJ')).toEqual({
      VOLUME: 'DJ',
      DIR: '/:Sets/:',
      FILE: 'a.mp3',
      KEY: 'DJ/:Sets/:a.mp3',
    });
    expect(traktorLocation('/Users/x/Music/b.mp3', 'Macintosh HD').DIR).toBe('/:Users/:x/:Music/:');
  });
});
