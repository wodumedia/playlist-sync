/**
 * Playlist mirrors: the other apps' own playlists, written into each app as one `From <origin>` playlist folder
 * (`From rekordbox`, `From Music`, `From Traktor`). The result is an ordinary `PlaylistsFile`, so the writers run on it
 * unchanged (each owns only that folder and removes the playlists in it that are no longer listed). Pure: the caller
 * reads the apps and the index.
 *
 * Copied: playlists and My Tags that are not smart lists and have at least one track whose file is on disk. A nested
 * playlist is named `Group / Sub / Name` (flat: one playlist per source list). Tracks with no file, or whose file is
 * not on disk, are left out (counted); a playlist left with no tracks is not written; an origin with nothing to copy
 * gives no file at all (an empty file would empty that app's existing `From …` folder).
 */
import { type Collection, COLLECTION_ORIGINS, type CollectionOrigin, MIRROR_FOLDERS } from './collections.ts';
import { folderSlug, indexByPath, trackFromPath } from './folders.ts';
import {
  type LibraryIndex,
  type PlaylistDefinition,
  type PlaylistsFile,
  PlaylistsFileSchema,
  type PlaylistTrack,
} from './library.ts';

export interface MirrorsInput {
  /** Every origin's collections (`hubCollections`). */
  collections: Collection[];
  /** The app the files are for: its own origin is never copied into it. */
  target: CollectionOrigin;
  index: LibraryIndex | null;
  bootVolume: string;
  now: string;
  /** Whether a file is on disk (the caller passes `existsSync`); default: always. */
  exists?: (path: string) => boolean;
}

export interface MirrorCounts {
  playlists: number;
  tracks: number;
  inIndex: number;
  notInIndex: number;
  /** Tracks the origin has no file for (a streamed item, a non-audio row): left out. */
  noPath: number;
  /** Tracks whose file is not on disk: left out. */
  notOnDisk: number;
  /** Playlists left out because none of their files is on disk. */
  emptyPlaylists: number;
}

export interface MirrorOutput {
  folderName: string;
  origin: CollectionOrigin;
  file: PlaylistsFile;
  counts: MirrorCounts;
}

const nfc = (s: string) => s.normalize('NFC');

/** `name` at the root, else `Group / Sub / Name`. */
export function mirrorPlaylistName(c: Pick<Collection, 'group' | 'name'>): string {
  return c.group.length ? [...c.group, c.name].join(' / ') : c.name;
}

/** A collection that is copied: not a smart list, at least one track with a file. */
export function isMirrored(c: Pick<Collection, 'kind' | 'tracks'>): boolean {
  return c.kind !== 'smart' && c.tracks.some((t) => t.path !== null);
}

export function buildMirrorFiles(input: MirrorsInput): MirrorOutput[] {
  const byPath = indexByPath(input.index);
  const exists = input.exists ?? (() => true);
  const out: MirrorOutput[] = [];
  for (const origin of COLLECTION_ORIGINS) {
    if (origin === input.target) continue;
    const mine = input.collections.filter((c) => c.origin === origin && isMirrored(c));
    if (!mine.length) continue;
    // Root playlists first, then the grouped ones; the given order inside each (stable).
    const ordered = [...mine.filter((c) => !c.group.length), ...mine.filter((c) => c.group.length)];
    const counts: MirrorCounts = {
      playlists: 0,
      tracks: 0,
      inIndex: 0,
      notInIndex: 0,
      noPath: 0,
      notOnDisk: 0,
      emptyPlaylists: 0,
    };
    const usedSlugs = new Set<string>();
    const playlists: PlaylistDefinition[] = [];
    for (const c of ordered) {
      const name = mirrorPlaylistName(c);
      const tracks: PlaylistTrack[] = [];
      for (const t of c.tracks) {
        if (t.path === null) {
          counts.noPath++;
          continue;
        }
        const path = nfc(t.path);
        if (!exists(path)) {
          counts.notOnDisk++;
          continue;
        }
        const { track, row } = trackFromPath(path, tracks.length, byPath, input.bootVolume, {
          artist: t.artist,
          title: t.title,
        });
        // The index row's volume wins, then the origin's own (Traktor rows carry it), then the path rule.
        if (!row?.volume && t.volume) track.volume = t.volume;
        if (row) counts.inIndex++;
        else counts.notInIndex++;
        tracks.push(track);
      }
      if (!tracks.length) {
        counts.emptyPlaylists++;
        continue;
      }
      const base = `mirror-${folderSlug(name)}`;
      let slug = base;
      for (let k = 2; usedSlugs.has(slug); k++) slug = `${base}-${k}`;
      usedSlugs.add(slug);
      counts.playlists++;
      counts.tracks += tracks.length;
      playlists.push({ slug, name, tracks });
    }
    if (!playlists.length) continue;
    const folderName = MIRROR_FOLDERS[origin];
    const file = PlaylistsFileSchema.parse({
      version: 1,
      generated_at: input.now,
      index_generated_at: input.index?.generated_at ?? null,
      folder: folderName,
      // Files rekordbox does not have yet are added to its collection.
      rekordbox_add_files: true,
      playlists,
    });
    out.push({ folderName, origin, file, counts });
  }
  return out;
}
