import { describe, expect, it } from 'vitest';
import type { PlaylistsFile, PlaylistTrack } from '../src/library.ts';
import { buildRekordboxXml, rekordboxLocation, rekordboxXmlTrackId } from '../src/writers/rekordbox-xml.ts';

const t = (path: string, extra: Partial<PlaylistTrack> = {}): PlaylistTrack => ({
  index: 0,
  n: 1,
  content_id: '',
  path,
  volume: 'Macintosh HD',
  artist: 'A',
  title: 'T',
  ...extra,
});

const FILE: PlaylistsFile = {
  version: 1,
  generated_at: '2026-01-01T00:00:00Z',
  index_generated_at: null,
  folder: 'DJ',
  music_order: 'any',
  rekordbox_add_files: true,
  playlists: [
    {
      slug: 'folder-house',
      name: 'House & "Garage" <2024>',
      tracks: [
        t('/Users/x/Music/DJ/House/Café del Mar.mp3', { artist: 'Tom & Jerry', title: "It's <on>" }),
        t('/Users/x/Music/DJ/House/b#1 100%.mp3', { content_id: '4242' }),
      ],
    },
    { slug: 'folder-techno', name: 'Techno', tracks: [t('/Users/x/Music/DJ/House/Café del Mar.mp3')] },
  ],
};

describe('buildRekordboxXml', () => {
  const xml = buildRekordboxXml([FILE]);

  it('one folder: ROOT > folder > one playlist node per playlist, each track once in COLLECTION', () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<DJ_PLAYLISTS Version="1.0.0">')).toBe(true);
    expect(xml).toContain('<COLLECTION Entries="2">');
    expect(xml).toContain('<NODE Type="0" Name="ROOT" Count="1">\n<NODE Type="0" Name="DJ" Count="2">');
    expect(xml).toContain('<NODE Name="Techno" Type="1" KeyType="0" Entries="1">');
    const nodes = [...xml.matchAll(/<NODE Name="([^"]*)" Type="1"[^>]*Entries="(\d+)">/g)].map((m) => [m[1], m[2]]);
    expect(nodes).toEqual([
      ['House &amp; &quot;Garage&quot; &lt;2024&gt;', '2'],
      ['Techno', '1'],
    ]);
    expect(xml.trimEnd().endsWith('</PLAYLISTS>\n</DJ_PLAYLISTS>')).toBe(true);
  });

  it('file:// URLs, percent-encoded per segment', () => {
    expect(rekordboxLocation('/Users/x/a b/c#1 100%.mp3')).toBe('file://localhost/Users/x/a%20b/c%231%20100%25.mp3');
    expect(xml).toContain('Location="file://localhost/Users/x/Music/DJ/House/Caf%C3%A9%20del%20Mar.mp3"');
  });

  it('escapes special characters in names, artists and titles', () => {
    expect(xml).toContain('Artist="Tom &amp; Jerry"');
    expect(xml).toContain('Name="It&apos;s &lt;on&gt;"');
    expect(xml).not.toMatch(/="[^"]*[<>][^"]*"/);
  });

  it('TrackID: the rekordbox id when known, else a stable 9-prefixed number shared by every reference', () => {
    expect(xml).toContain('<TRACK TrackID="4242"');
    const id = rekordboxXmlTrackId({ content_id: '', path: FILE.playlists[0]!.tracks[0]!.path });
    expect(id).toMatch(/^9\d{9}$/);
    expect(xml.match(new RegExp(`<TRACK Key="${id}"/>`, 'g'))).toHaveLength(2);
    expect(buildRekordboxXml([FILE])).toBe(xml);
  });

  it('several roots sit side by side under ROOT', () => {
    const two = buildRekordboxXml([FILE, { ...FILE, folder: 'Extras' }]);
    expect(two).toContain('Name="ROOT" Count="2"');
    expect(two).toContain('<NODE Type="0" Name="Extras" Count="2">');
    expect(two).toContain('<COLLECTION Entries="2">');
  });
});
