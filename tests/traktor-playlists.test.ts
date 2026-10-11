import { describe, expect, it } from 'vitest';
import { InboundCollectionSchema } from '../src/collections.ts';
import { parseTraktorPlaylists, traktorKeyToPath } from '../src/readers/traktor-playlists.ts';
import { traktorLocation } from '../src/writers/traktor-nml.ts';

const NML = `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<NML VERSION="19"><HEAD COMPANY="www.native-instruments.com" PROGRAM="Traktor"></HEAD>
<COLLECTION ENTRIES="2"><ENTRY TITLE="Strobe &amp; More" ARTIST="Someone"><LOCATION DIR="/:Users/:me/:Music/:" FILE="strobe.mp3" VOLUME="Macintosh HD" VOLUMEID="Macintosh HD"></LOCATION>
<ALBUM TITLE="For Lack"></ALBUM>
<INFO BITRATE="320000" PLAYTIME="634" PLAYTIME_FLOAT="633.9"></INFO>
</ENTRY>
<ENTRY TITLE="Ext" ARTIST="X"><LOCATION DIR="/:DJ/:" FILE="ext.wav" VOLUME="Flex" VOLUMEID="Flex"></LOCATION>
</ENTRY>
</COLLECTION>
<PLAYLISTS><NODE TYPE="FOLDER" NAME="$ROOT"><SUBNODES COUNT="5">
<NODE TYPE="PLAYLIST" NAME="Warmup"><PLAYLIST ENTRIES="3" TYPE="LIST" UUID="a"><ENTRY><PRIMARYKEY TYPE="TRACK" KEY="Macintosh HD/:Users/:me/:Music/:strobe.mp3"></PRIMARYKEY>
</ENTRY>
<ENTRY><PRIMARYKEY TYPE="TRACK" KEY="Flex/:DJ/:ext.wav"></PRIMARYKEY>
</ENTRY>
<ENTRY><PRIMARYKEY TYPE="TRACK" KEY="Macintosh HD/:Users/:me/:Music/:Caf&#233; Tune.mp3"></PRIMARYKEY>
</ENTRY>
</PLAYLIST>
</NODE>
<NODE TYPE="PLAYLIST" NAME="_RECORDINGS"><PLAYLIST ENTRIES="0" TYPE="LIST" UUID="b"></PLAYLIST>
</NODE>
<NODE TYPE="FOLDER" NAME="Gigs"><SUBNODES COUNT="2"><NODE TYPE="FOLDER" NAME="2024"><SUBNODES COUNT="1"><NODE TYPE="PLAYLIST" NAME="Miami"><PLAYLIST ENTRIES="1" TYPE="LIST" UUID="c"><ENTRY><PRIMARYKEY TYPE="TRACK" KEY="Macintosh HD/:Users/:me/:Music/:strobe.mp3"></PRIMARYKEY>
</ENTRY>
</PLAYLIST>
</NODE>
</SUBNODES>
</NODE>
<NODE TYPE="SMARTLIST" NAME="Fresh"><SMARTLIST UUID="d"><SEARCH_EXPRESSION VERSION="1" QUERY="$IMPORTDATE &gt; 30"></SEARCH_EXPRESSION>
</SMARTLIST>
</NODE>
</SUBNODES>
</NODE>
<NODE TYPE="PLAYLIST" NAME="Empty"><PLAYLIST ENTRIES="0" TYPE="LIST" UUID="e"></PLAYLIST>
</NODE>
</SUBNODES>
</NODE>
</PLAYLISTS>
</NML>
`;

describe('traktorKeyToPath', () => {
  it("inverts the writer's traktorLocation for the boot volume and for a mounted volume", () => {
    for (const [path, volume] of [
      ['/Users/me/Music/a b.mp3', 'Macintosh HD'],
      ['/Volumes/Flex/DJ/x.wav', 'Flex'],
    ] as const) {
      expect(traktorKeyToPath(traktorLocation(path, volume).KEY, 'Macintosh HD')).toEqual({ path, volume });
    }
  });

  it('normalises to NFC', () => {
    const nfd = 'Macintosh HD/:Users/:Café.mp3'.normalize('NFD');
    expect(traktorKeyToPath(nfd, 'Macintosh HD').path).toBe('/Users/Café.mp3'.normalize('NFC'));
  });
});

describe('parseTraktorPlaylists', () => {
  const { playlists, entries } = parseTraktorPlaylists(NML, { bootVolume: 'Macintosh HD' });

  it("lists playlists and smart lists with their folder chain, skipping Traktor's own `_` lists", () => {
    expect(entries).toBe(2);
    expect(playlists.map((p) => [p.origin_id, p.group, p.kind, p.tracks.length])).toEqual([
      ['Warmup', [], 'playlist', 3],
      ['Gigs / 2024 / Miami', ['Gigs', '2024'], 'playlist', 1],
      ['Gigs / Fresh', ['Gigs'], 'smart', 0],
      ['Empty', [], 'playlist', 0],
    ]);
    for (const p of playlists) expect(InboundCollectionSchema.parse(p)).toEqual(p);
  });

  it('takes title and artist from the COLLECTION entry, else the file name', () => {
    expect(playlists[0]!.tracks).toEqual([
      { path: '/Users/me/Music/strobe.mp3', volume: 'Macintosh HD', content_id: null, title: 'Strobe & More', artist: 'Someone' },
      { path: '/Volumes/Flex/DJ/ext.wav', volume: 'Flex', content_id: null, title: 'Ext', artist: 'X' },
      { path: '/Users/me/Music/Café Tune.mp3', volume: 'Macintosh HD', content_id: null, title: 'Café Tune', artist: '' },
    ]);
  });

  it('returns nothing for a file without PLAYLISTS', () => {
    expect(parseTraktorPlaylists('<NML></NML>', { bootVolume: 'Macintosh HD' })).toEqual({ playlists: [], entries: 0 });
  });
});
