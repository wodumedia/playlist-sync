/**
 * Runs the writers for one playlists file: rekordbox (master.db through pyrekordbox), Apple Music (JXA) and Traktor
 * (collection.nml), plus the rekordbox XML for every root at once. Dry run unless `apply`; an apply backs each app's
 * library up first (once per run) and refuses while that app is open.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { backup } from './backup.ts';
import { type Config, REPO } from './config.ts';
import { type PlaylistsFile, totalTracks } from './library.ts';
import { type AppResult, type FilesSkipped, LIVE_APPS, type LiveApp, rekordboxAddedNotes } from './plan.ts';
import { running, traktorRunning } from './running.ts';
import { copySqliteFamily, sqliteFamily } from './sqlite-files.ts';
import { ChildTimeout, execWithTimeout, MUSIC_WRITE_TIMEOUT_MS, OSASCRIPT_SHORT_TIMEOUT_MS } from './timeout.ts';
import { buildRekordboxXml } from './writers/rekordbox-xml.ts';
import { spliceTraktorCollection } from './writers/traktor-nml.ts';

const WRITE_SCRIPT = join(REPO, 'src', 'writers', 'rekordbox-write.py');
const MUSIC_SCRIPT = join(REPO, 'src', 'writers', 'music-playlists.js');

export interface RunContext {
  config: Config;
  apply: boolean;
  noProbe: boolean;
  /** Apps backed up in this run: one backup per app per run, before its first write. */
  backedUp: Set<LiveApp>;
  /** The Music copy-on-add check: from state.json at the start; set to "passed" when a check in this run passed (the
   * caller records it). Until it is "passed", an apply checks before its first Music import. */
  musicCheck: 'passed' | null;
  /** The check found Music copying (or the tick's once-a-day back-off holds): Music is not written this run. */
  musicRefused: boolean;
  /** Set when a check in this run found Music copying (the caller records it as `music_copy_check_refused_at`). */
  musicRefusedAt: string | null;
}

export function newContext(
  config: Config,
  apply: boolean,
  noProbe = false,
  musicCheck: 'passed' | null = null,
): RunContext {
  return { config, apply, noProbe, backedUp: new Set(), musicCheck, musicRefused: false, musicRefusedAt: null };
}

/** The action (and so the log text, "music refused: …") when the check finds Music copying files on add. */
export const MUSIC_REFUSED =
  'refused: "Copy files to Music Media folder" is on — turn it off in Music > Settings > Files, then the next tick writes (re-checks once a day; run: node src/cli.ts folders --music)';

export function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Atomic: a temp file beside it, then rename. */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

export function enabledApps(config: Config): LiveApp[] {
  return LIVE_APPS.filter((a) =>
    a === 'rekordbox' ? config.rekordbox !== 'off' : a === 'music' ? config.music : config.traktor.enabled,
  );
}

/**
 * The apps a run writes: the enabled ones (or the picked ones, which must be enabled), less an app whose library file
 * is missing (no master.db in `db` mode, no collection.nml), which is reported in `skipped`.
 */
export function activeApps(config: Config, picked: LiveApp[] | null): { apps: LiveApp[]; skipped: string[] } {
  const enabled = enabledApps(config);
  for (const a of picked ?? [])
    if (!enabled.includes(a)) throw new Error(`${a} is not enabled in ${config.path}`);
  const apps: LiveApp[] = [];
  const skipped: string[] = [];
  for (const a of picked ?? enabled) {
    if (a === 'rekordbox' && config.rekordbox === 'db' && !existsSync(config.rekordboxDb))
      skipped.push(`rekordbox: no database at ${config.rekordboxDb} (skipped)`);
    else if (a === 'traktor' && !existsSync(config.traktor.collection))
      skipped.push(`traktor: no collection at ${config.traktor.collection} (skipped)`);
    else apps.push(a);
  }
  return { apps, skipped };
}

/** The hash key of each app being written (`rekordbox:xml` / `rekordbox:db`, `music`, `traktor`). */
export function appKeys(config: Config, apps: LiveApp[]): string[] {
  return apps.map((a) => (a === 'rekordbox' ? `rekordbox:${config.rekordbox}` : a));
}

function result(app: LiveApp, apply: boolean): AppResult {
  return { app, action: apply ? 'applied' : 'dry run', counts: null, backup: null, notes: [] };
}

function applyRekordboxDb(ctx: RunContext, file: PlaylistsFile, filePath: string): AppResult {
  const { config, apply } = ctx;
  const r = result('rekordbox', apply);
  const db = config.rekordboxDb;
  if (!existsSync(db)) return { ...r, action: `skipped: no rekordbox database at ${db}` };
  if (!existsSync(config.venvPython))
    throw new Error(`no Python venv at ${config.venvPython}: run install.sh (it installs pyrekordbox)`);
  if (running('rekordbox')) {
    if (apply) throw new Error('rekordbox is open — close it and run again');
    r.notes.push('rekordbox is open: close it before --apply');
  }
  // A dry run reads a fresh copy, never the live file.
  let target = db;
  const playlistsXml = join(dirname(db), 'masterPlaylists6.xml');
  if (apply) {
    // master.db with its -wal/-shm: a restore puts all three back together.
    if (!ctx.backedUp.has('rekordbox')) {
      r.backup = backup(config.stagingDir, 'rekordbox', [...sqliteFamily(db), playlistsXml]);
      ctx.backedUp.add('rekordbox');
    }
  } else {
    const snap = join(config.stagingDir, 'rekordbox-dryrun');
    mkdirSync(snap, { recursive: true });
    copySqliteFamily(db, snap, 'master.db');
    if (existsSync(playlistsXml)) copyFileSync(playlistsXml, join(snap, 'masterPlaylists6.xml'));
    target = join(snap, 'master.db');
  }
  const args = [WRITE_SCRIPT, '--db', target, '--playlists', filePath];
  if (apply) args.push('--apply');
  const out = JSON.parse(
    execFileSync(config.venvPython, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
  ) as {
    folder: { created: boolean };
    playlists: { created: number; updated: number; unchanged: number; removed: number };
    tracks: { linked: number; missing: number };
    contents_added?: number;
    contents_added_by_playlist?: Record<string, number>;
    files_skipped?: FilesSkipped;
    order?: { first: string | null; moves: number };
  };
  const pl = out.playlists;
  r.counts = {
    playlists: file.playlists.length,
    tracks: out.tracks.linked,
    missing: out.tracks.missing,
    ...(out.contents_added ? { added: out.contents_added } : {}),
  };
  r.notes.push(
    `folder ${out.folder.created ? (apply ? 'created' : 'would be created') : 'exists'}; playlists ` +
      `${pl.created} new, ${pl.updated} changed, ${pl.unchanged} unchanged, ${pl.removed} removed; ` +
      `${out.contents_added ?? 0} files ${apply ? 'added to' : 'to add to'} the collection; order: ` +
      `${out.order?.first ?? '–'} first, ${out.order?.moves ?? 0} ${apply ? 'moved' : 'to move'}`,
  );
  r.notes.push(...rekordboxAddedNotes(out.contents_added_by_playlist ?? {}, out.files_skipped ?? null, apply));
  return r;
}

function applyTraktor(ctx: RunContext, file: PlaylistsFile): AppResult {
  const { config, apply } = ctx;
  const r = result('traktor', apply);
  const path = config.traktor.collection;
  if (!existsSync(path)) return { ...r, action: `skipped: no Traktor collection at ${path}` };
  if (traktorRunning()) {
    if (apply) throw new Error('Traktor is open — close it and run again');
    r.notes.push('Traktor is open: close it before --apply');
  }
  const before = readFileSync(path, 'utf8');
  const s = spliceTraktorCollection(before, file);
  r.counts = { playlists: s.playlists, tracks: s.tracks, missing: 0 };
  r.notes.push(
    `${s.existingEntries} entries, ${s.addedEntries} ${apply ? 'added' : 'to add'}; folder ` +
      `${s.replacedFolder ? 'replaced' : 'appended'}`,
  );
  if (!apply) return r;
  if (!ctx.backedUp.has('traktor')) {
    r.backup = backup(config.stagingDir, 'traktor', [path]);
    ctx.backedUp.add('traktor');
  }
  const tmp = join(dirname(path), `.${basename(path)}.playlist-sync-${process.pid}`);
  writeFileSync(tmp, s.nml);
  renameSync(tmp, path);
  return r;
}

function applyMusic(ctx: RunContext, filePath: string): AppResult {
  const { config, apply } = ctx;
  const r = result('music', apply);
  if (ctx.musicRefused) return { ...r, action: MUSIC_REFUSED };
  if (apply && !ctx.backedUp.has('music')) {
    // The library package is copied only while Music is closed (a copy of an open library may be torn). The tick's
    // gate guarantees it; a by-hand run is refused here. Later files of the same run find Music open (the writer
    // launched it) and go ahead.
    if (running('Music')) throw new Error('Music is open — quit it and run again (its library is backed up first)');
    if (existsSync(config.musicLibrary)) r.backup = backup(config.stagingDir, 'music', [config.musicLibrary]);
    else r.notes.push(`no Music library at ${config.musicLibrary}: no backup`);
    ctx.backedUp.add('music');
  }
  const args = ['-l', 'JavaScript', MUSIC_SCRIPT, filePath];
  if (apply) args.push('--apply');
  // The copy-on-add check: on an apply until it has passed once (before the writer's first import, while nothing is
  // written yet); on a dry run unless --no-probe.
  if (apply && ctx.musicCheck !== 'passed') args.push('--probe');
  if (!apply && ctx.noProbe) args.push('--no-probe');
  let stdout: string;
  try {
    // A Music stuck on a modal alert must not hang the tick; SIGTERM lets osascript end its Apple event.
    stdout = execWithTimeout('osascript', args, {
      label: 'Apple Music writer',
      timeoutMs: MUSIC_WRITE_TIMEOUT_MS,
      killSignal: 'SIGTERM',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    if (err instanceof ChildTimeout) throw err;
    const e = err as { status?: number; stdout?: string; stderr?: string };
    if (e.status === 2) {
      const probe = JSON.parse(e.stdout ?? '{}') as {
        kind?: string;
        reason?: string;
        leftover_database_id?: number;
        imported_location?: string | null;
      };
      // The probe's imported row cannot be deleted from inside the JXA process; a plain `osascript -e` from here can,
      // once Music has finished the import (a delete during it is a silent no-op): wait, delete, check, retry once.
      if (Number.isInteger(probe.leftover_database_id)) {
        const id = probe.leftover_database_id;
        const del = `tell application "Music" to delete (first file track of library playlist 1 whose database ID is ${id})`;
        const cnt = `tell application "Music" to count of (every file track of library playlist 1 whose database ID is ${id})`;
        let left = '?';
        for (let attempt = 0; attempt < 2; attempt++) {
          execFileSync('sleep', [attempt === 0 ? '3' : '5']);
          try {
            const short = { label: 'Music probe cleanup', timeoutMs: OSASCRIPT_SHORT_TIMEOUT_MS };
            execWithTimeout('osascript', ['-e', del], short);
            left = execWithTimeout('osascript', ['-e', cnt], short).trim();
          } catch {
            left = '?';
          }
          if (left === '0') break;
        }
        if (left !== '0')
          r.notes.push(`probe row (database ID ${id}) is still in the Music library: delete it in Music`);
      }
      // Never delete the file Music points at: it is reported and the user removes a copy themselves.
      if (probe.imported_location && existsSync(probe.imported_location))
        r.notes.push(`probe import is at ${probe.imported_location} (left in place)`);
      if (probe.kind === 'copies') {
        ctx.musicRefused = true;
        ctx.musicRefusedAt = new Date().toISOString();
        return { ...r, action: MUSIC_REFUSED };
      }
      return { ...r, action: `skipped: ${probe.reason ?? String(e.stdout)}` };
    }
    throw new Error(`Apple Music script failed: ${e.stderr ?? err}`);
  }
  const out = JSON.parse(stdout) as {
    folder: { exists: boolean };
    playlists: { create: number; update: number; unchanged: number; remove: number; recreate?: number };
    tracks: { found: number; toImport: number; missingOnDisk: number };
    rows?: { added: number; removed: number };
    failed: unknown[];
    /** "passed": the check imported a file by reference; "none": every file is in the library already (no check). */
    probe?: 'passed' | 'none' | null;
  };
  if (out.probe === 'passed') ctx.musicCheck = 'passed';
  const pl = out.playlists;
  const t = out.tracks;
  r.counts = { playlists: pl.create + pl.update + pl.unchanged, tracks: t.found + t.toImport, missing: t.missingOnDisk };
  r.notes.push(
    `folder ${out.folder.exists ? 'exists' : apply ? 'created' : 'would be created'}; playlists ${pl.create} new, ` +
      `${pl.update} changed${pl.recreate ? ` (${pl.recreate} replaced: Music kept old rows)` : ''}, ${pl.unchanged} unchanged, ` +
      `${pl.remove} removed; ` +
      (out.rows
        ? `rows ${out.rows.added} ${apply ? 'added' : 'to add'}, ${out.rows.removed} ${apply ? 'removed' : 'to remove'}; `
        : '') +
      `${t.toImport} files ${apply ? 'imported' : 'to import'}` +
      (out.failed.length ? `; ${out.failed.length} FAILED: ${JSON.stringify(out.failed.slice(0, 5))}` : ''),
  );
  return r;
}

/** `<staging>/rekordbox.xml` from every root's playlists (xml mode). A dry run only counts. */
export function writeRekordboxXml(ctx: RunContext, files: PlaylistsFile[]): AppResult {
  const r = result('rekordbox', ctx.apply);
  const path = join(ctx.config.stagingDir, 'rekordbox.xml');
  const playlists = files.reduce((k, f) => k + f.playlists.length, 0);
  const tracks = files.reduce((k, f) => k + totalTracks(f), 0);
  r.counts = { playlists, tracks, missing: 0 };
  if (ctx.apply) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}`;
    writeFileSync(tmp, buildRekordboxXml(files));
    renameSync(tmp, path);
  }
  r.notes.push(
    `${ctx.apply ? 'wrote' : 'would write'} ${path}: ${files.length} folders, ${playlists} playlists, ${tracks} tracks ` +
      '(import it in rekordbox: Preferences > Advanced > Database > rekordbox xml)',
  );
  return r;
}

export function printResults(results: AppResult[]): void {
  const rows = [['app', 'action', 'playlists', 'tracks', 'missing', 'backup']];
  for (const r of results)
    rows.push([
      r.app,
      r.action,
      String(r.counts?.playlists ?? '–'),
      String(r.counts?.tracks ?? '–'),
      String(r.counts?.missing ?? '–'),
      r.backup ?? '–',
    ]);
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)));
  for (const row of rows)
    console.log(
      row
        .map((c, i) => c.padEnd(widths[i]!))
        .join('  ')
        .trimEnd(),
    );
  for (const r of results) for (const n of r.notes) console.log(`  ${r.app}: ${n}`);
}

/** Runs each per-file writer in turn (rekordbox only in `db` mode: the XML is written once for all roots); a failed
 * app is a `failed: …` result, sets exit code 1 and the other apps still run. */
export function runApps(ctx: RunContext, file: PlaylistsFile, filePath: string, apps: LiveApp[]): AppResult[] {
  console.log(`playlists file       ${filePath}: ${file.playlists.length} playlists, ${totalTracks(file)} tracks`);
  const results: AppResult[] = [];
  for (const app of apps) {
    if (app === 'rekordbox' && ctx.config.rekordbox !== 'db') continue;
    try {
      if (app === 'rekordbox') results.push(applyRekordboxDb(ctx, file, filePath));
      else if (app === 'traktor') results.push(applyTraktor(ctx, file));
      else results.push(applyMusic(ctx, filePath));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${app}: ${msg}`);
      results.push({ app, action: `failed: ${msg}`, counts: null, backup: null, notes: [] });
    }
    const action = results.at(-1)?.action ?? '';
    if (action.startsWith('failed') || action.startsWith('refused')) process.exitCode = 1;
  }
  if (results.length) printResults(results);
  return results;
}

/** Quits Music after a tick wrote to it, else every later change would wait on "Music running". */
export function quitMusic(): void {
  try {
    if (running('Music'))
      execWithTimeout('osascript', ['-e', 'tell application "Music" to quit'], {
        label: 'Music quit',
        timeoutMs: OSASCRIPT_SHORT_TIMEOUT_MS,
        stdio: 'ignore',
      });
  } catch {
    // Not fatal: the next change waits on "Music running" until Music is quit.
  }
}
