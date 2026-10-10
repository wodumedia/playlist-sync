/**
 * rekordbox XML (`<staging>/rekordbox.xml`): the folder playlists as a file the user imports in rekordbox
 * (Preferences > Advanced > Database > rekordbox xml, then the "rekordbox xml" tree in the browser). Pure string
 * building, deterministic (same input, same bytes). master.db is never touched in this mode.
 */
import type { PlaylistsFile, PlaylistTrack } from '../library.ts';
import { escapeXmlAttr as esc, fnv1a } from './xml.ts';

/** rekordbox's Location: `file://localhost` + the path, each segment percent-encoded, `/` kept. */
export function rekordboxLocation(path: string): string {
  return `file://localhost${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** A track's TrackID: its rekordbox id when the index knows it, else a stable number from its path, `9` + 9 digits,
 * so it never collides with rekordbox's own ids in the file. */
export function rekordboxXmlTrackId(t: Pick<PlaylistTrack, 'content_id' | 'path'>): string {
  if (t.content_id) return t.content_id;
  return `9${String(fnv1a(t.path, 0x811c9dc5) % 1_000_000_000).padStart(9, '0')}`;
}

/** One XML holding every root's playlist folder under ROOT, each track once in COLLECTION. */
export function buildRekordboxXml(files: PlaylistsFile[]): string {
  const seen = new Set<string>();
  const tracks: string[] = [];
  for (const file of files)
    for (const p of file.playlists)
      for (const t of p.tracks) {
        const id = rekordboxXmlTrackId(t);
        if (seen.has(id)) continue;
        seen.add(id);
        tracks.push(
          `<TRACK TrackID="${esc(id)}" Name="${esc(t.title)}" Artist="${esc(t.artist)}" Location="${esc(rekordboxLocation(t.path))}"/>`,
        );
      }
  const folders = files.map((file) => {
    const nodes = file.playlists.map((p) =>
      [
        `<NODE Name="${esc(p.name)}" Type="1" KeyType="0" Entries="${p.tracks.length}">`,
        ...p.tracks.map((t) => `<TRACK Key="${esc(rekordboxXmlTrackId(t))}"/>`),
        '</NODE>',
      ].join('\n'),
    );
    return [`<NODE Type="0" Name="${esc(file.folder)}" Count="${file.playlists.length}">`, ...nodes, '</NODE>'].join(
      '\n',
    );
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<DJ_PLAYLISTS Version="1.0.0">',
    '<PRODUCT Name="playlist-sync" Version="1.0.0" Company=""/>',
    `<COLLECTION Entries="${tracks.length}">`,
    ...tracks,
    '</COLLECTION>',
    '<PLAYLISTS>',
    `<NODE Type="0" Name="ROOT" Count="${files.length}">`,
    ...folders,
    '</NODE>',
    '</PLAYLISTS>',
    '</DJ_PLAYLISTS>',
    '',
  ].join('\n');
}
