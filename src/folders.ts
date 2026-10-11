/**
 * Folders as playlists: every top-level subfolder of a root folder becomes one playlist named exactly like the
 * subfolder, holding its audio files (nested subfolders flattened in, natural-sorted by the path relative to the
 * subfolder), inside one playlist folder named like the root, in each app.
 *
 * 0-byte files are left out (no app plays them, and Apple Music refuses to add them, so their playlist would never
 * match and be rebuilt on every apply). `buildFolderPlaylists` is pure; `walkFolder` and `buildFolders` do the I/O.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  type LibraryIndex,
  type LibraryTrack,
  type PlaylistDefinition,
  type PlaylistsFile,
  PlaylistsFileSchema,
  type PlaylistTrack,
} from './library.ts';

/** Audio the apps play, by extension (case-insensitive). */
export const FOLDER_AUDIO_RE = /\.(mp3|m4a|aif|aiff|wav|flac)$/i;

export interface FolderEntry {
  /** Absolute path as walked (under `dir`), NFC. Decides the playlist and the order. */
  path: string;
  isDir: boolean;
  /** The file with symlinks resolved, NFC (what the apps and the index know); defaults to `path`. */
  realPath?: string;
  /** Bytes; a 0-byte file is skipped. */
  size?: number;
}

export interface FolderPlaylistsInput {
  dir: string;
  /** The playlist folder in the apps (e.g. `DJ`). */
  folderName: string;
  entries: FolderEntry[];
  index: LibraryIndex | null;
  /** The boot volume's name, for a file outside /Volumes (Traktor's LOCATION VOLUME). */
  bootVolume: string;
  now: string;
}

export interface FolderPlaylistsCounts {
  folders: number;
  skippedEmpty: number;
  /** 0-byte audio files left out. */
  emptyFiles: number;
  tracks: number;
  inIndex: number;
  notInIndex: number;
}

const nfc = (s: string) => s.normalize('NFC');
const trimSlash = (s: string) => s.replace(/\/+$/, '');

/** A filesystem-safe slug: ASCII letters/digits and `-`, never empty. */
export function folderSlug(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'x';
}

/** Artist and title from a file name: "Artist - Title.mp3" splits on the first " - ", else the base name is the title. */
export function artistTitleFromName(path: string): { artist: string; title: string } {
  const base = (path.split('/').pop() ?? path).replace(/\.[^.]+$/, '');
  const i = base.indexOf(' - ');
  if (i > 0) return { artist: base.slice(0, i).trim(), title: base.slice(i + 3).trim() };
  return { artist: '', title: base };
}

/** `/Volumes/<name>/…` → name, else the boot volume. */
export function volumeOf(path: string, bootVolume: string): string {
  const m = /^\/Volumes\/([^/]+)\//.exec(path);
  return m ? m[1]! : bootVolume;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Natural order, then a plain comparison so names that differ only in case stay in a fixed order. */
export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** Index rows by NFC path; a row whose file is on disk wins over one that is not. */
export function indexByPath(index: LibraryIndex | null): Map<string, LibraryTrack> {
  const byPath = new Map<string, LibraryTrack>();
  for (const t of index?.tracks ?? []) {
    const key = nfc(t.path);
    const had = byPath.get(key);
    if (!had || (!had.exists && t.exists)) byPath.set(key, t);
  }
  return byPath;
}

/** One playlist track for the file at `path` (NFC): the index row's id, volume, artist and title when the index knows
 * the file, else the volume from the path and artist/title from `fallback` (what another app calls the track) when it
 * has either, else from the file name. */
export function trackFromPath(
  path: string,
  i: number,
  byPath: Map<string, LibraryTrack>,
  bootVolume: string,
  fallback?: { artist: string; title: string },
): { track: PlaylistTrack; row: LibraryTrack | undefined } {
  const row = byPath.get(path);
  const named = fallback && (fallback.artist || fallback.title) ? fallback : artistTitleFromName(path);
  return {
    row,
    track: {
      index: i,
      n: i + 1,
      content_id: row?.id ?? '',
      path,
      volume: row?.volume || volumeOf(path, bootVolume),
      artist: row ? row.artist : named.artist,
      title: row?.title || named.title,
    },
  };
}

export function buildFolderPlaylists(input: FolderPlaylistsInput): {
  file: PlaylistsFile;
  counts: FolderPlaylistsCounts;
} {
  const dir = trimSlash(nfc(input.dir));
  const prefix = `${dir}/`;

  const byPath = indexByPath(input.index);

  const hidden = (rel: string) => rel.split('/').some((seg) => seg.startsWith('.'));
  const topFolders = new Set<string>();
  let emptyFiles = 0;
  const files = new Map<string, { rel: string; real: string }[]>();
  for (const e of input.entries) {
    const path = nfc(e.path);
    if (!path.startsWith(prefix)) continue;
    const rel = path.slice(prefix.length);
    if (!rel || hidden(rel)) continue;
    const slash = rel.indexOf('/');
    if (e.isDir) {
      if (slash < 0) topFolders.add(rel);
      continue;
    }
    if (slash < 0 || !FOLDER_AUDIO_RE.test(rel)) continue; // a file directly in `dir`, or not audio
    const top = rel.slice(0, slash);
    topFolders.add(top);
    if (e.size === 0) {
      emptyFiles++;
      continue;
    }
    const list = files.get(top) ?? [];
    list.push({ rel: rel.slice(slash + 1), real: nfc(e.realPath ?? e.path) });
    files.set(top, list);
  }

  const counts: FolderPlaylistsCounts = {
    folders: 0,
    skippedEmpty: 0,
    emptyFiles,
    tracks: 0,
    inIndex: 0,
    notInIndex: 0,
  };
  const usedSlugs = new Set<string>();
  const playlists: PlaylistDefinition[] = [];
  for (const name of [...topFolders].sort(naturalCompare)) {
    const list = files.get(name);
    if (!list?.length) {
      counts.skippedEmpty++;
      continue;
    }
    list.sort((a, b) => naturalCompare(a.rel, b.rel));
    const base = `folder-${folderSlug(name)}`;
    let slug = base;
    for (let k = 2; usedSlugs.has(slug); k++) slug = `${base}-${k}`;
    usedSlugs.add(slug);

    const tracks: PlaylistTrack[] = list.map((f, i) => {
      const { track, row } = trackFromPath(f.real, i, byPath, input.bootVolume);
      if (row) counts.inIndex++;
      else counts.notInIndex++;
      return track;
    });
    counts.folders++;
    counts.tracks += tracks.length;
    playlists.push({ slug, name, tracks });
  }

  const file = PlaylistsFileSchema.parse({
    version: 1,
    generated_at: input.now,
    index_generated_at: input.index?.generated_at ?? null,
    folder: input.folderName,
    // Order does not matter in a folder playlist: the Music writer appends new files instead of rewriting.
    music_order: 'any',
    // Files rekordbox does not have are added to its collection.
    rekordbox_add_files: true,
    playlists,
  });
  return { file, counts };
}

/** Every entry under `dir` (hidden names are not entered), files realpath-resolved; all paths NFC. */
export function walkFolder(dir: string): FolderEntry[] {
  const out: FolderEntry[] = [];
  const visit = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const path = join(d, e.name);
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        try {
          const st = statSync(path);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue; // a dangling link
        }
      }
      if (isDir) {
        out.push({ path: path.normalize('NFC'), isDir: true });
        visit(path);
      } else if (isFile) {
        let real = path;
        let size: number | undefined;
        try {
          real = realpathSync.native(path);
          size = statSync(real).size;
        } catch {
          // keep the walked path
        }
        out.push({ path: path.normalize('NFC'), isDir: false, realPath: real.normalize('NFC'), size });
      }
    }
  };
  visit(dir);
  return out;
}

let bootVolumeCache: string | null = null;

/** The boot volume's name (`diskutil info /`), "Macintosh HD" when diskutil gives none. */
export function bootVolumeName(): string {
  if (bootVolumeCache) return bootVolumeCache;
  let name = 'Macintosh HD';
  try {
    const out = execFileSync('diskutil', ['info', '/'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    name = /^\s*Volume Name:\s*(.+)$/m.exec(out)?.[1]?.trim() || name;
  } catch {
    // keep the default
  }
  bootVolumeCache = name;
  return name;
}

export interface BuiltFolder {
  dir: string;
  folderName: string;
  file: PlaylistsFile;
  counts: FolderPlaylistsCounts;
}

/** Walks each root folder and builds its playlists file (in memory). A root that is not there is reported through
 * `missing` and left out. */
export function buildFolders(
  dirs: string[],
  index: LibraryIndex | null,
  missing: (dir: string) => void,
  now = new Date().toISOString(),
): BuiltFolder[] {
  const bootVolume = bootVolumeName();
  const out: BuiltFolder[] = [];
  for (const raw of dirs) {
    const dir = resolve(raw);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      missing(dir);
      continue;
    }
    const folderName = basename(dir);
    const { file, counts } = buildFolderPlaylists({
      dir,
      folderName,
      entries: walkFolder(dir),
      index,
      bootVolume,
      now,
    });
    out.push({ dir, folderName, counts, file });
  }
  return out;
}
