/**
 * Reads each enabled app's own playlists (the I/O side of `collect.ts`):
 * - rekordbox (mode `xml` or `db`, master.db present): a fresh copy of master.db dumped by `rekordbox-dump.py`
 *   (needs the Python venv); safe while rekordbox runs.
 * - Apple Music (enabled): `readers/music-read.js --no-launch`, only while Music is already running (Music can only be
 *   read then; it is never launched). Not read → the last read in `<staging>/collections.json` is carried. A read that
 *   fails or times out (MUSIC_READ_TIMEOUT_MS) is skipped with an event, and the run carries on.
 * - Traktor (enabled, collection.nml present): the file itself, read only.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readJson, writeJson } from './apply.ts';
import { type CollectionsInboundFile, CollectionsInboundFileSchema } from './collections.ts';
import { buildInboundCollections, type CollectInput, inboundHash, type MusicReadOutput } from './collect.ts';
import { type Config, REPO } from './config.ts';
import { bootVolumeName } from './folders.ts';
import { buildIndexWithMap, dumpRekordbox, realpathOrNull } from './index.ts';
import type { LibraryIndex } from './library.ts';
import { stagingPaths } from './paths.ts';
import { running } from './running.ts';
import { ChildTimeout, execWithTimeout, formatTimeout, MUSIC_READ_TIMEOUT_MS } from './timeout.ts';

const MUSIC_READ_SCRIPT = join(REPO, 'src', 'readers', 'music-read.js');

export interface CollectRun {
  file: CollectionsInboundFile;
  hash: string;
  /** rekordbox's index from this run's dump (content ids, artists, titles), or null when rekordbox was not read. */
  index: LibraryIndex | null;
  /** Why an origin was not read (for the dry-run table). */
  notes: string[];
  /** Lines for the tick log: a read that failed or timed out. */
  events: string[];
}

/** The folder names never read as origins besides the `From …` folders: the folder-playlist folders. */
export const folderPlaylistNames = (config: Config): string[] => config.folders.map((f) => basename(f));

/** Apple Music's own playlists, read only while Music is running (never launched), killed after the time limit. */
export function readMusic(): { music: MusicReadOutput } | { skipped: string } {
  let stdout: string;
  try {
    stdout = execWithTimeout('osascript', ['-l', 'JavaScript', MUSIC_READ_SCRIPT, '--no-launch'], {
      label: 'Music read',
      timeoutMs: MUSIC_READ_TIMEOUT_MS,
      killSignal: 'SIGTERM',
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (err) {
    if (err instanceof ChildTimeout) return { skipped: `timed out after ${formatTimeout(err.timeoutMs)}` };
    const e = err as { stderr?: string; message?: string };
    return { skipped: `failed: ${(e.stderr || e.message || String(err)).trim().split('\n')[0]}` };
  }
  const out = JSON.parse(stdout) as MusicReadOutput | { skipped: string };
  return 'skipped' in out ? { skipped: out.skipped } : { music: out };
}

/** The last read (`<staging>/collections.json`), or null when there is none or it does not parse. */
export function readCollections(config: Config): CollectionsInboundFile | null {
  const r = CollectionsInboundFileSchema.safeParse(readJson(stagingPaths(config).collections));
  return r.success ? r.data : null;
}

export function saveCollections(config: Config, file: CollectionsInboundFile): void {
  writeJson(stagingPaths(config).collections, file);
}

/** Reads every enabled app it can into one collections file (see the header). */
export function collectOrigins(config: Config): CollectRun {
  const notes: string[] = [];
  const events: string[] = [];
  const boot = bootVolumeName();
  const input: CollectInput = {
    now: new Date().toISOString(),
    skipFolders: folderPlaylistNames(config),
    bootVolume: boot,
  };
  let index: LibraryIndex | null = null;

  if (config.rekordbox === 'off') notes.push('rekordbox: off, not read');
  else if (!existsSync(config.rekordboxDb)) notes.push(`rekordbox: no database at ${config.rekordboxDb}, not read`);
  else if (!existsSync(config.venvPython))
    notes.push(`rekordbox: no Python venv at ${config.venvPython}, not read (run install.sh to set it up)`);
  else {
    try {
      const { raw, dbModifiedAt } = dumpRekordbox(config);
      const built = buildIndexWithMap(raw.content, {
        bootVolume: boot,
        realpath: realpathOrNull,
        now: input.now,
        dbModifiedAt,
      });
      index = built.index;
      input.rekordbox = { raw, index: built.index, contentIdMap: built.contentIdMap };
    } catch (err) {
      const msg = `rekordbox read failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
      notes.push(msg);
      events.push(msg);
    }
  }

  if (!config.music) notes.push('music: off, not read');
  else {
    let skipped: string;
    if (!running('Music')) skipped = 'not running, not read';
    else {
      const read = readMusic();
      if ('music' in read) {
        input.music = read.music;
        skipped = '';
      } else {
        skipped = `read ${read.skipped}`;
        if (read.skipped !== 'Music not running') events.push(`Music read ${read.skipped} (the last read is kept)`);
      }
    }
    if (skipped) {
      input.previousMusic = readCollections(config)?.origins.music ?? null;
      notes.push(`music: ${skipped}; ${input.previousMusic ? 'the last read is kept' : 'no earlier read to keep'}`);
    }
  }

  if (!config.traktor.enabled) notes.push('traktor: off, not read');
  else if (!existsSync(config.traktor.collection))
    notes.push(`traktor: no collection at ${config.traktor.collection}, not read`);
  else input.traktor = { nml: readFileSync(config.traktor.collection, 'utf8'), bootVolume: boot };

  const file = buildInboundCollections(input);
  return { file, hash: inboundHash(file), index, notes, events };
}
