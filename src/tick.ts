/**
 * `auto` (the launchd tick) and `folders` (the same by hand). Every tick walks and hashes the root folders (content
 * only, one hash per app); the apps whose hash moved are written once every one of them is closed (backups first),
 * and each app's hash is recorded when it applied, so a failing app never makes the others rewrite. An open app means
 * "waiting": nothing is written, the next tick tries again. Music is checked for copy-on-add before its first write.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  activeApps,
  appKeys,
  enabledApps,
  MUSIC_REFUSED,
  newContext,
  type RunContext,
  printResults,
  quitMusic,
  readJson,
  runApps,
  writeJson,
  writeRekordboxXml,
} from './apply.ts';
import type { Config } from './config.ts';
import type { LiveApp } from './plan.ts';
import { type BuiltFolder, buildFolders, folderSlug } from './folders.ts';
import { type LibraryIndex, LibraryIndexSchema } from './library.ts';
import {
  type AppResult,
  type AutoState,
  appHashes,
  appOfKey,
  decideFolders,
  type FoldersAppliedDir,
  foldersAppliedText,
  logLine,
  musicCheckDue,
  parseAutoArgs,
  parseAutoState,
  parseFoldersArgs,
  recordHashes,
  releaseLock,
  takeLock,
  waitingText,
} from './plan.ts';
import { blockingApps, openApps } from './running.ts';

export const stagingPaths = (c: Config) => ({
  state: join(c.stagingDir, 'state.json'),
  lock: join(c.stagingDir, 'auto.lock'),
  log: join(c.stagingDir, 'playlist-sync.log'),
  index: join(c.stagingDir, 'index.json'),
});

export const folderFilePath = (c: Config, folderName: string) =>
  join(c.stagingDir, `folders-${folderSlug(folderName)}.json`);

export function readState(c: Config): AutoState {
  return parseAutoState(readJson(stagingPaths(c).state));
}

function writeState(c: Config, state: AutoState): void {
  writeJson(stagingPaths(c).state, state);
}

/** Records this run's Music check in the state: a pass clears the refusal, a refusal stamps its time. */
export function noteMusicCheck(state: AutoState, ctx: Pick<RunContext, 'musicCheck' | 'musicRefusedAt'>): void {
  if (ctx.musicCheck === 'passed') {
    state.music_copy_check = 'passed';
    state.music_copy_check_refused_at = null;
  } else if (ctx.musicRefusedAt) state.music_copy_check_refused_at = ctx.musicRefusedAt;
}

/** True when every result of `app` applied (the rekordbox XML's "xml written" counts); no result = nothing to do. */
export function appApplied(results: Pick<AppResult, 'app' | 'action'>[], app: LiveApp): boolean {
  return results.filter((r) => r.app === app).every((r) => r.action === 'applied' || r.action === 'xml written');
}

/** `<staging>/index.json` (the last `index` run), or null when there is none or it does not parse. */
export function loadLocalIndex(c: Config): LibraryIndex | null {
  const path = stagingPaths(c).index;
  if (!existsSync(path)) return null;
  try {
    return LibraryIndexSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

/** The table a dry run (and `folders`) shows for one root. */
function printFolder(b: BuiltFolder): void {
  const { counts, file } = b;
  console.log(`== ${b.folderName}  (${b.dir})`);
  console.log(
    `${counts.folders} playlists, ${counts.tracks} tracks (${counts.skippedEmpty} empty folders skipped, ` +
      `${counts.emptyFiles} 0-byte files left out; ${counts.inIndex} in the rekordbox index, ${counts.notInIndex} not)`,
  );
  if (file.playlists.length) console.log('tracks  playlist');
  for (const p of file.playlists) console.log(`${String(p.tracks.length).padStart(6)}  ${p.name}`);
}

export async function auto(config: Config, args: string[]): Promise<void> {
  const { dryRun } = parseAutoArgs(args);
  const paths = stagingPaths(config);
  const events: string[] = [];
  const say = (event: string) => {
    const line = logLine(new Date(), dryRun ? `dry run: ${event}` : event);
    console.log(line);
    events.push(line);
  };
  const fail = (event: string) => {
    say(event);
    process.exitCode = 1;
  };

  if (!dryRun && !takeLock(paths.lock)) {
    console.log(logLine(new Date(), `another tick holds ${paths.lock}: nothing done`));
    return;
  }
  if (dryRun && existsSync(paths.lock)) say(`note: ${paths.lock} exists (a tick is running, or a stale lock)`);
  let foldersChanged = false;
  try {
    const state = readState(config);
    try {
      const built = buildFolders(config.folders, loadLocalIndex(config), (dir) =>
        say(`folders: no directory at ${dir} (skipped)`),
      );
      if (dryRun) for (const b of built) printFolder(b);
      const { apps: active, skipped } = activeApps(config, null);
      const hashes = appHashes(
        built.map((b) => b.file),
        appKeys(config, active),
      );
      // Only the apps whose own hash moved are written (and so only they have to be closed).
      const fd = decideFolders(state, hashes, (keys) =>
        blockingApps(keys.map(appOfKey), config.rekordbox, openApps()),
      );
      const apps = fd.keys.map(appOfKey);
      foldersChanged = fd.changed;
      const planned = (): FoldersAppliedDir[] =>
        built.map((b) => ({ folder: b.folderName, playlists: b.counts.folders, tracks: b.counts.tracks, results: [] }));
      if (!active.length) {
        foldersChanged = false;
        for (const s of skipped) say(s);
        say(`folders: no app to write (enable one in ${config.path})`);
      } else if (!fd.changed) say('folders unchanged');
      else if (!fd.apply) say(`folders waiting: ${waitingText(fd.waitingOn)} (next tick tries again)`);
      else {
        for (const s of skipped) say(s);
        const withPlaylists = built.filter((b) => b.file.playlists.length);
        if (dryRun) {
          say(`would apply folders to ${apps.join(', ')}: ${foldersAppliedText(planned())}`);
          // The rekordbox dry run (on a fresh copy of master.db) says how many files the apply adds.
          if (apps.includes('rekordbox') && config.rekordbox === 'db') {
            const ctx = newContext(config, false);
            for (const b of withPlaylists) {
              const filePath = folderFilePath(config, b.folderName);
              writeJson(filePath, b.file);
              const [r] = runApps(ctx, b.file, filePath, ['rekordbox']);
              say(
                r?.action.startsWith('failed')
                  ? `folders dry run: ${b.folderName}: rekordbox ${r.action}`
                  : `folders dry run: ${b.folderName}: rekordbox would add ${r?.counts?.added ?? 0} files to the collection`,
              );
            }
          }
        } else {
          const before = process.exitCode;
          process.exitCode = 0;
          const ctx = newContext(config, true, false, state.music_copy_check);
          // After a refusal the tick re-runs the check once a day only (a by-hand `folders` always re-checks).
          if (state.music_copy_check !== 'passed' && !musicCheckDue(state.music_copy_check_refused_at))
            ctx.musicRefused = true;
          const done: FoldersAppliedDir[] = [];
          let allApplied = true;
          let crashed = false;
          try {
            for (const b of built) {
              if (!b.file.playlists.length) {
                say(`folders: ${b.folderName} has no playlists (not written)`);
                continue;
              }
              const filePath = folderFilePath(config, b.folderName);
              writeJson(filePath, b.file);
              const results = runApps(ctx, b.file, filePath, apps);
              if (results.some((r) => r.action !== 'applied')) allApplied = false;
              done.push({ folder: b.folderName, playlists: b.counts.folders, tracks: b.counts.tracks, results });
            }
            if (apps.includes('rekordbox') && config.rekordbox === 'xml' && withPlaylists.length) {
              const r = writeRekordboxXml(
                ctx,
                withPlaylists.map((b) => b.file),
              );
              printResults([r]);
              for (const d of done) d.results.push({ app: 'rekordbox', action: 'xml written', counts: null });
            }
          } catch (err) {
            process.exitCode = 1;
            crashed = true;
            say(`folders apply failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          // The JXA writer opens Music; quit it again, else every later change would wait on "Music running".
          if (apps.includes('music')) quitMusic();
          noteMusicCheck(state, ctx);
          if (ctx.musicRefused) say(`music ${MUSIC_REFUSED}`);
          const ok = process.exitCode === 0 && allApplied;
          process.exitCode = ok ? before : 1;
          say(`${ok ? 'folders applied' : 'folders apply FAILED'}: ${foldersAppliedText(done)}`);
          // Each app's hash only when it applied everywhere: a failed app is written again next tick, the others not.
          const applied = crashed ? [] : fd.keys.filter((k) => appApplied(done.flatMap((d) => d.results), appOfKey(k)));
          state.last_folders_hash = recordHashes(state.last_folders_hash, hashes, applied, appKeys(config, enabledApps(config)));
        }
      }
    } catch (err) {
      fail(`folders failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!foldersChanged && process.exitCode !== 1) say('no change');

    if (!dryRun) {
      // A disabled app's hash goes, so enabling it again writes it on the next tick.
      state.last_folders_hash = recordHashes(state.last_folders_hash, {}, [], appKeys(config, enabledApps(config)));
      state.last_run = new Date().toISOString();
      state.last_result = events.map((e) => e.slice(e.indexOf(' ') + 1)).join(' | ');
      writeState(config, state);
      appendFileSync(paths.log, `${events.join('\n')}\n`);
    }
  } finally {
    if (!dryRun) releaseLock(paths.lock);
  }
}

export async function foldersCommand(config: Config, args: string[]): Promise<void> {
  const opts = parseFoldersArgs(args);
  const paths = stagingPaths(config);
  const { apps, skipped } = activeApps(config, opts.apps);
  // An apply holds the tick's lock and records the hash of each app that applied everywhere, so the next tick sees
  // `folders unchanged` for it.
  if (opts.apply && !takeLock(paths.lock))
    throw new Error(`a tick is running (${paths.lock}): run again when it has finished`);
  try {
    // The tick's gate, before ANY write: an open app being written refuses the whole run, so the apps never end up
    // half written (rekordbox only in `db` mode; Music too, its library is backed up while it is closed).
    if (opts.apply) {
      const blocking = blockingApps(apps, config.rekordbox, openApps());
      if (blocking.length)
        throw new Error(`${waitingText(blocking)}: quit ${blocking.join(' and ')} and run again (nothing written)`);
    }
    console.log(opts.apply ? 'APPLY: writing to the apps (backups first)' : 'dry run: nothing is written (add --apply)');
    if (!opts.apply && apps.includes('music') && !opts.noProbe)
      console.log('Music probe: adds ONE song not yet in the library (by reference) to test copy-on-add (--no-probe skips)');
    const index = loadLocalIndex(config);
    if (index) console.log(`library index        ${paths.index} (${index.tracks.length} files, ${index.generated_at})`);
    else console.log(`library index        none at ${paths.index}: every track by path only`);
    for (const s of skipped) console.log(s);
    if (!apps.length) console.log(`no app to write (enable one in ${config.path})`);

    let complete = apps.length > 0;
    const built = buildFolders(config.folders, index, (dir) => {
      console.error(`no directory at ${dir}`);
      process.exitCode = 1;
      complete = false;
    });
    const ctx = newContext(config, opts.apply, opts.noProbe, readState(config).music_copy_check);
    const results: AppResult[] = [];
    for (const b of built) {
      const filePath = folderFilePath(config, b.folderName);
      writeJson(filePath, b.file);
      console.log('');
      printFolder(b);
      if (!b.file.playlists.length) {
        console.log('no playlists: nothing to write (the writers would empty the folder)');
        continue;
      }
      results.push(...runApps(ctx, b.file, filePath, apps));
    }
    const withPlaylists = built.filter((b) => b.file.playlists.length);
    if (apps.includes('rekordbox') && config.rekordbox === 'xml' && withPlaylists.length) {
      console.log('');
      const r = writeRekordboxXml(
        ctx,
        withPlaylists.map((b) => b.file),
      );
      printResults([r]);
      results.push(r);
    }
    if (ctx.musicRefused) console.log(`music ${MUSIC_REFUSED}`);
    const keys = appKeys(config, apps);
    const applied = opts.apply && complete ? keys.filter((k) => appApplied(results, appOfKey(k))) : [];
    if (applied.length || ctx.musicCheck === 'passed' || ctx.musicRefusedAt) {
      const state = readState(config);
      noteMusicCheck(state, ctx);
      const hashes = appHashes(
        built.map((b) => b.file),
        applied,
      );
      state.last_folders_hash = recordHashes(state.last_folders_hash, hashes, applied, appKeys(config, enabledApps(config)));
      writeState(config, state);
      if (applied.length)
        console.log(`recorded the folders hash of ${applied.join(', ')} in ${paths.state} (the tick sees "folders unchanged")`);
    }
  } finally {
    if (opts.apply) releaseLock(paths.lock);
  }
}

/** The last `n` lines of the tick log. */
export function lastLogLines(c: Config, n = 10): string[] {
  const path = stagingPaths(c).log;
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trimEnd().split('\n').slice(-n);
}
