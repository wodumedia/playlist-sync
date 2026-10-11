/**
 * `index`: rekordbox's content ids by path, from a fresh copy of master.db, into `<staging>/index.json`. Optional:
 * without it every track goes by path (content_id '') and rekordbox finds or adds it by path. With it, the Traktor and
 * XML writers use rekordbox's own ids, artists and titles.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeJson } from './apply.ts';
import { type Config, REPO } from './config.ts';
import { bootVolumeName, FOLDER_AUDIO_RE, volumeOf } from './folders.ts';
import { type LibraryIndex, LibraryIndexSchema, type LibraryTrack } from './library.ts';
import { running } from './running.ts';
import { copySqliteFamily, dbChangedAt } from './sqlite-files.ts';
import type { RawDump } from './collect.ts';
import { stagingPaths } from './paths.ts';

const DUMP_SCRIPT = join(REPO, 'src', 'rekordbox-dump.py');

export interface RawContent {
  id: string;
  path: string;
  title: string;
  artist: string;
  deleted: boolean;
}

/** Content rows → index tracks: deleted rows and non-audio left out, paths realpath-resolved and NFC, one row per
 * path (a row whose file is on disk wins). */
export function buildIndex(
  content: RawContent[],
  opts: { bootVolume: string; realpath: (p: string) => string | null; now: string; dbModifiedAt: string | null },
): LibraryIndex {
  return buildIndexWithMap(content, opts).index;
}

/** `buildIndex`, plus `contentIdMap`: every content id that made it into the index (the kept row, or a dropped
 * duplicate of the same file) → the kept row's id. A playlist song is resolved through it; an id not in the map is
 * not in the index (deleted, or not an audio file). */
export function buildIndexWithMap(
  content: RawContent[],
  opts: { bootVolume: string; realpath: (p: string) => string | null; now: string; dbModifiedAt: string | null },
): { index: LibraryIndex; contentIdMap: Map<string, string> } {
  const byPath = new Map<string, LibraryTrack>();
  const pathOfId = new Map<string, string>();
  for (const c of content) {
    if (c.deleted || !c.path || !FOLDER_AUDIO_RE.test(c.path)) continue;
    const real = opts.realpath(c.path);
    const path = (real ?? c.path).normalize('NFC');
    const t: LibraryTrack = {
      id: c.id,
      path,
      volume: volumeOf(path, opts.bootVolume),
      artist: c.artist,
      title: c.title,
      exists: real !== null,
    };
    pathOfId.set(c.id, path);
    const had = byPath.get(path);
    if (!had || (!had.exists && t.exists)) byPath.set(path, t);
  }
  const contentIdMap = new Map<string, string>();
  for (const [id, path] of pathOfId) contentIdMap.set(id, byPath.get(path)!.id);
  const index = LibraryIndexSchema.parse({
    version: 1,
    source: 'rekordbox',
    generated_at: opts.now,
    db_modified_at: opts.dbModifiedAt,
    tracks: [...byPath.values()],
  });
  return { index, contentIdMap };
}

export const realpathOrNull = (p: string): string | null => {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
};

/** Copies master.db (with its -wal/-shm and masterPlaylists6.xml) into `<staging>/rekordbox-dryrun` and dumps the
 * copy: content rows, playlists and My Tags. Reading a copy is safe while rekordbox runs. */
export function dumpRekordbox(config: Config): { raw: RawDump; dbModifiedAt: string | null } {
  const db = config.rekordboxDb;
  if (!existsSync(db)) throw new Error(`no rekordbox database at ${db}`);
  if (!existsSync(config.venvPython))
    throw new Error(`no Python venv at ${config.venvPython}: run install.sh (it installs pyrekordbox)`);
  const dbModifiedAt = dbChangedAt(db);
  const snap = join(config.stagingDir, 'rekordbox-dryrun');
  mkdirSync(snap, { recursive: true });
  copySqliteFamily(db, snap, 'master.db');
  const xml = join(dirname(db), 'masterPlaylists6.xml');
  if (existsSync(xml)) copyFileSync(xml, join(snap, 'masterPlaylists6.xml'));
  const raw = JSON.parse(
    execFileSync(config.venvPython, [DUMP_SCRIPT, '--db', join(snap, 'master.db')], {
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
    }),
  ) as RawDump;
  return { raw, dbModifiedAt };
}

export function indexCommand(config: Config): void {
  if (running('rekordbox')) console.warn('rekordbox is running: the copy is read as it stands on disk (fine for an index).');
  const { raw, dbModifiedAt } = dumpRekordbox(config);
  const index = buildIndex(raw.content, {
    bootVolume: bootVolumeName(),
    realpath: realpathOrNull,
    now: new Date().toISOString(),
    dbModifiedAt,
  });
  const out = stagingPaths(config).index;
  writeJson(out, index);
  const missing = index.tracks.filter((t) => !t.exists).length;
  console.log(`rekordbox rows       ${raw.content.length}`);
  console.log(`index tracks         ${index.tracks.length} (${missing} not on disk)`);
  console.log(`written              ${out}`);
}
