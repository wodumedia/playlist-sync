/**
 * Reading each app's own playlists into collections. Pure: `collect-run.ts` does the reading and hands the raw data
 * in; the result is the `<stagingDir>/collections.json` shape.
 *
 * - rekordbox (`rekordbox-dump.py` of a copy of master.db, and the index built from it): every playlist (attribute 0)
 *   and smart list (attribute 4 / smart flag: kind `smart`, no tracks) with `group` = its folder chain (attribute 1
 *   rows), in rekordbox's own order (folder tree, Seq); every My Tag as kind `tag`, `origin_id` `tag:<id>`, `group` =
 *   [its group's name] ("Genre", …). A song is resolved through the index's content-id map to the kept track (its
 *   path, even when the file is missing); a song that is not in the index (a video, a sampler sound) is carried with
 *   `path: null`. Deleted rows are skipped. rekordbox's History lists live in their own table and are never read.
 * - Apple Music (`readers/music-read.js`): every playlist, `origin_id` = persistent ID, `group` = folder chain, `path`
 *   = the file location (null for a catalogue item); smart lists by name only. When Music was not read this run (it
 *   was closed, or the read timed out) the last read is carried, so opening or closing Music changes nothing.
 * - Traktor: `readers/traktor-playlists.ts`.
 * Anything whose outermost folder is in the skip set is left out: the three `From …` folders and the folder-playlist
 * folders (the basenames of `config.folders`).
 */
import { createHash } from 'node:crypto';
import {
  type CollectionsInboundFile,
  CollectionsInboundFileSchema,
  type CollectionTrack,
  type InboundCollection,
  MIRROR_FOLDERS,
} from './collections.ts';
import type { RawContent } from './index.ts';
import type { LibraryIndex } from './library.ts';
import { parseTraktorPlaylists } from './readers/traktor-playlists.ts';

export interface RawSong {
  content_id: string;
  track_no: number | null;
}

/** A `djmdPlaylist` row: attribute 0 = list, 1 = folder, 4 = smart list. */
export interface RawPlaylist {
  id: string;
  seq: number | null;
  name: string;
  attribute: number;
  parent_id: string;
  smart: boolean;
  deleted: boolean;
  songs: RawSong[];
}

/** A `djmdMyTag` row: attribute 1 = a group ("Genre"), 0 = a tag. */
export interface RawMyTag {
  id: string;
  seq: number | null;
  name: string;
  attribute: number;
  parent_id: string;
  deleted: boolean;
  songs: RawSong[];
}

/** What `rekordbox-dump.py` prints. */
export interface RawDump {
  content: RawContent[];
  playlists?: RawPlaylist[];
  my_tags?: RawMyTag[];
}

/** What `readers/music-read.js` prints when it read Music. */
export interface MusicReadOutput {
  read_at: string;
  playlists: {
    persistent_id: string;
    name: string;
    parent_path: string[];
    special_kind: string;
    smart: boolean;
    tracks: { persistent_id: string; location: string | null; title: string; artist: string }[];
  }[];
}

export interface CollectInput {
  now: string;
  /** Folder names never read (besides the `From …` folders): the basenames of `config.folders`. */
  skipFolders: string[];
  /** Boot volume name, for the `volume` of Music tracks outside /Volumes. */
  bootVolume?: string;
  rekordbox?: { raw: RawDump; index: LibraryIndex; contentIdMap: Map<string, string> };
  music?: MusicReadOutput;
  /** The last read's Music origin, used as it is when `music` was not read this run. */
  previousMusic?: CollectionsInboundFile['origins']['music'] | null;
  traktor?: { nml: string; bootVolume: string };
}

/** The folders never read: the three `From …` folders plus `extra`. */
export function skipFolderSet(extra: string[]): Set<string> {
  return new Set([...Object.values(MIRROR_FOLDERS), ...extra]);
}

const UNTITLED = '(untitled)';

const skipped = (group: string[], skip: Set<string>) => group.length > 0 && skip.has(group[0]!);

function rekordboxCollections(input: NonNullable<CollectInput['rekordbox']>, skip: Set<string>): InboundCollection[] {
  const { raw, index, contentIdMap } = input;
  const trackById = new Map(index.tracks.map((t) => [t.id, t]));
  const contentById = new Map(raw.content.map((c) => [c.id, c]));

  const resolveSong = (contentId: string): CollectionTrack => {
    const kept = contentIdMap.get(contentId);
    const t = kept ? trackById.get(kept) : undefined;
    if (t) return { path: t.path, volume: t.volume, content_id: t.id, title: t.title, artist: t.artist };
    const c = contentById.get(contentId);
    return { path: null, volume: '', content_id: contentId, title: c?.title ?? '', artist: c?.artist ?? '' };
  };
  const songs = (list: RawSong[]) =>
    [...list].sort((a, b) => (a.track_no ?? 0) - (b.track_no ?? 0)).map((s) => resolveSong(s.content_id));

  const out: InboundCollection[] = [];

  // Playlists: walk the folder tree from `root` in Seq order; rows whose parent is gone come last at the top level.
  const rows = (raw.playlists ?? []).filter((p) => !p.deleted);
  const children = new Map<string, RawPlaylist[]>();
  for (const p of rows) {
    const list = children.get(p.parent_id) ?? [];
    list.push(p);
    children.set(p.parent_id, list);
  }
  for (const list of children.values()) list.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const seen = new Set<string>();
  const visit = (parent: string, chain: string[]) => {
    for (const p of children.get(parent) ?? []) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      const name = p.name || UNTITLED;
      if (p.attribute === 1) {
        visit(p.id, [...chain, name]);
        continue;
      }
      if (skipped(chain, skip)) continue;
      const smart = p.smart || p.attribute === 4;
      out.push({
        origin_id: p.id,
        name,
        group: chain,
        kind: smart ? 'smart' : 'playlist',
        tracks: smart ? [] : songs(p.songs),
      });
    }
  };
  visit('root', []);
  const ids = new Set(rows.map((p) => p.id));
  for (const p of rows) if (!seen.has(p.id) && !ids.has(p.parent_id)) visit(p.parent_id, []);

  // My Tags: groups (attribute 1) in Seq order, each group's tags in Seq order.
  const tags = (raw.my_tags ?? []).filter((t) => !t.deleted);
  const groups = tags.filter((t) => t.attribute === 1).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const groupName = new Map(groups.map((g) => [g.id, g.name || UNTITLED]));
  const order = new Map(groups.map((g, i) => [g.id, i]));
  const leaves = tags
    .filter((t) => t.attribute !== 1)
    .sort(
      (a, b) => (order.get(a.parent_id) ?? -1) - (order.get(b.parent_id) ?? -1) || (a.seq ?? 0) - (b.seq ?? 0),
    );
  for (const t of leaves) {
    const g = groupName.get(t.parent_id);
    const group = g ? [g] : [];
    if (skipped(group, skip)) continue;
    out.push({ origin_id: `tag:${t.id}`, name: t.name || UNTITLED, group, kind: 'tag', tracks: songs(t.songs) });
  }
  return out;
}

function musicCollections(music: MusicReadOutput, skip: Set<string>, bootVolume: string): InboundCollection[] {
  return music.playlists
    .filter((p) => !skipped(p.parent_path, skip) && p.persistent_id)
    .map((p) => ({
      origin_id: p.persistent_id,
      name: p.name || UNTITLED,
      group: p.parent_path,
      kind: p.smart ? ('smart' as const) : ('playlist' as const),
      tracks: p.smart
        ? []
        : p.tracks.map((t) => {
            const path = t.location ? t.location.normalize('NFC') : null;
            const volume = path ? (/^\/Volumes\/([^/]+)\//.exec(path)?.[1] ?? bootVolume) : '';
            return { path, volume, content_id: null, title: t.title, artist: t.artist };
          }),
    }));
}

export function buildInboundCollections(input: CollectInput): CollectionsInboundFile {
  const skip = skipFolderSet(input.skipFolders);
  const origins: CollectionsInboundFile['origins'] = {};
  if (input.rekordbox)
    origins.rekordbox = { read_at: input.now, collections: rekordboxCollections(input.rekordbox, skip) };
  if (input.music)
    origins.music = {
      read_at: input.music.read_at || input.now,
      collections: musicCollections(input.music, skip, input.bootVolume ?? ''),
    };
  // The carried read goes through the same skip (the folders in the config may have changed since).
  else if (input.previousMusic)
    origins.music = {
      ...input.previousMusic,
      collections: input.previousMusic.collections.filter((c) => !skipped(c.group, skip)),
    };
  if (input.traktor) {
    const { playlists } = parseTraktorPlaylists(input.traktor.nml, { bootVolume: input.traktor.bootVolume });
    origins.traktor = { read_at: input.now, collections: playlists.filter((p) => !skipped(p.group, skip)) };
  }
  return CollectionsInboundFileSchema.parse({ version: 1, generated_at: input.now, origins });
}

/** sha256 of the file without its `read_at` / `generated_at` stamps: an unchanged library hashes the same every run.
 * Content only: whether Music was open or closed leaves no trace (a Music that was not read carries its last read). */
export function inboundHash(file: CollectionsInboundFile): string {
  const json = JSON.stringify(file, (key, value) => (key === 'read_at' || key === 'generated_at' ? undefined : value));
  return createHash('sha256').update(json).digest('hex');
}

export interface OriginCounts {
  playlists: number;
  tags: number;
  smart: number;
  tracks: number;
  noPath: number;
}

/** Per-origin counts for the dry-run table. */
export function inboundCounts(
  file: CollectionsInboundFile,
): Partial<Record<'rekordbox' | 'music' | 'traktor', OriginCounts>> {
  const out: Partial<Record<'rekordbox' | 'music' | 'traktor', OriginCounts>> = {};
  for (const origin of ['rekordbox', 'music', 'traktor'] as const) {
    const o = file.origins[origin];
    if (!o) continue;
    const c: OriginCounts = { playlists: 0, tags: 0, smart: 0, tracks: 0, noPath: 0 };
    for (const col of o.collections) {
      if (col.kind === 'tag') c.tags++;
      else if (col.kind === 'smart') c.smart++;
      else c.playlists++;
      c.tracks += col.tracks.length;
      c.noPath += col.tracks.filter((t) => t.path === null).length;
    }
    out[origin] = c;
  }
  return out;
}
