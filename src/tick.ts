/**
 * `auto` (the launchd tick), `folders` and `mirrors` (the same by hand). Every tick walks and hashes the root folders
 * (content only, one hash per app); the apps whose hash moved are written once every one of them is closed (backups
 * first), and each app's hash is recorded when it applied, so a failing app never makes the others rewrite. An open
 * app means "waiting": nothing is written, the next tick tries again. Music is checked for copy-on-add before its
 * first write.
 *
 * Then the playlist mirrors: every enabled app's own playlists are read (`collect-run.ts`) and each app with mirrors on
 * (`mirrors.<app>: true` in the config, or a `mirrors --apply --<app>`) gets the other apps' playlists in `From …`
 * folders, hashed per app and written as soon as that app alone is closed.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
import { type Collection, hubCollections } from './collections.ts';
import { inboundCounts, skipFolderSet } from './collect.ts';
import { type CollectRun, collectOrigins, folderPlaylistNames, saveCollections } from './collect-run.ts';
import type { Config } from './config.ts';
import { type BuiltFolder, bootVolumeName, buildFolders } from './folders.ts';
import { type LibraryIndex, LibraryIndexSchema, type PlaylistsFile } from './library.ts';
import { buildMirrorFiles, type MirrorOutput } from './mirrors.ts';
import {
  type AppResult,
  type AutoState,
  appHashes,
  appOfKey,
  decideFolders,
  decideMirrors,
  type FoldersAppliedDir,
  foldersAppliedText,
  foldersHash,
  type LiveApp,
  logLine,
  type MirrorsAppliedItem,
  mirrorsAppliedText,
  mirrorsEnabled,
  musicCheckDue,
  parseAutoArgs,
  parseAutoState,
  parseFoldersArgs,
  parseMirrorsArgs,
  recordHashes,
  releaseLock,
  takeLock,
  waitingText,
} from './plan.ts';
import { folderFilePath, mirrorFilePath, stagingPaths } from './paths.ts';
import { blockingApps, openApps } from './running.ts';

export { folderFilePath, mirrorFilePath, stagingPaths } from './paths.ts';

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

// ---- playlist mirrors ----

/** Every origin read this run, as the hub (in memory), and the index the mirror tracks are looked up in. */
export interface MirrorSource {
  run: CollectRun;
  collections: Collection[];
  index: LibraryIndex | null;
}

/** Reads the apps' own playlists (see collect-run.ts). The index is this run's rekordbox dump, else index.json. */
export function readMirrorSource(config: Config): MirrorSource {
  const run = collectOrigins(config);
  return {
    run,
    collections: hubCollections(run.file, skipFolderSet(folderPlaylistNames(config))),
    index: run.index ?? loadLocalIndex(config),
  };
}

/** The `From …` files for one app. */
export function mirrorsFor(config: Config, source: MirrorSource, app: LiveApp): MirrorOutput[] {
  return buildMirrorFiles({
    collections: source.collections,
    target: app,
    index: source.index,
    bootVolume: bootVolumeName(),
    now: new Date().toISOString(),
    exists: existsSync,
  });
}

/** One app's mirrors hash: the files' content and the app's key (so a rekordbox mode change writes it again). */
export function mirrorsHash(config: Config, app: LiveApp, built: MirrorOutput[]): string {
  return foldersHash(
    built.map((m) => m.file),
    appKeys(config, [app]),
  );
}

/** The rekordbox mirror files that go into rekordbox.xml beside the folders (xml mode, rekordbox enabled for mirrors). */
function xmlMirrorFiles(config: Config, state: AutoState, source: MirrorSource | null): PlaylistsFile[] {
  if (config.rekordbox !== 'xml' || !source || !mirrorsEnabled(config, state, 'rekordbox')) return [];
  return mirrorsFor(config, source, 'rekordbox').map((m) => m.file);
}

/** The per-origin table a dry run (and `mirrors`) shows, with the reasons an origin was not read. */
function printOrigins(run: CollectRun): void {
  const counts = inboundCounts(run.file);
  const rows = [['origin', 'playlists', 'my tags', 'smart', 'tracks', 'no file']];
  for (const origin of ['rekordbox', 'music', 'traktor'] as const) {
    const c = counts[origin];
    if (c)
      rows.push([origin, String(c.playlists), String(c.tags), String(c.smart), String(c.tracks), String(c.noPath)]);
  }
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  if (rows.length > 1) for (const r of rows) console.log(r.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd());
  else console.log('no app was read');
  for (const n of run.notes) console.log(`  ${n}`);
}

/** The table a dry run (and `mirrors`) shows for one `From …` folder of one app. */
function printMirror(app: LiveApp, m: MirrorOutput): void {
  const c = m.counts;
  console.log(`== ${app}: ${m.folderName}`);
  console.log(
    `${c.playlists} playlists, ${c.tracks} tracks (${c.inIndex} in the rekordbox index, ${c.notInIndex} not); ` +
      `left out: ${c.notOnDisk} tracks not on disk, ${c.noPath} with no file, ` +
      `${c.emptyPlaylists} playlists with no file on disk`,
  );
  console.log('tracks  playlist');
  for (const p of m.file.playlists) console.log(`${String(p.tracks.length).padStart(6)}  ${p.name}`);
}

/**
 * The tick's mirrors step: per active app, hashed every tick; written only for an app with mirrors on (config or
 * `state.mirror_apps`, see `mirrorsEnabled`), when that app alone is closed (rekordbox in `xml` mode never waits).
 * Returns whether some app's mirrors changed.
 */
function autoMirrors(
  config: Config,
  state: AutoState,
  source: MirrorSource,
  opts: { dryRun: boolean; say: (e: string) => void; folderFiles: PlaylistsFile[]; backedUp: Set<LiveApp> },
): boolean {
  const { dryRun, say } = opts;
  const { apps: active } = activeApps(config, null);
  const open = openApps();
  let changed = false;
  let wroteMusic = false;
  const unchanged: LiveApp[] = [];
  let ctx: RunContext | null = null;
  const context = (): RunContext => {
    if (ctx) return ctx;
    ctx = newContext(config, true, false, state.music_copy_check);
    // One backup per app per run: an app the folders step backed up is not backed up again.
    for (const a of opts.backedUp) ctx.backedUp.add(a);
    if (state.music_copy_check !== 'passed' && !musicCheckDue(state.music_copy_check_refused_at)) ctx.musicRefused = true;
    return ctx;
  };
  for (const app of active) {
    const built = mirrorsFor(config, source, app);
    const hash = mirrorsHash(config, app, built);
    const plan = decideMirrors(state, app, hash, blockingApps([app], config.rekordbox, open), config);
    if (plan.action === 'unchanged') {
      if (mirrorsEnabled(config, state, app)) unchanged.push(app);
      continue;
    }
    if (plan.action === 'not-enabled') {
      if (plan.note) {
        say(`mirrors not enabled for ${app}: run mirrors --apply --${app}`);
        if (!dryRun) state.mirrors_noted_hash[app] = hash;
      }
      continue;
    }
    changed = true;
    if (plan.action === 'waiting') {
      say(`mirrors waiting: ${waitingText(plan.waitingOn)} (next tick tries again)`);
      continue;
    }
    const items: MirrorsAppliedItem[] = built.map((b) => ({
      folder: b.folderName,
      playlists: b.counts.playlists,
      tracks: b.counts.tracks,
      result: null,
    }));
    if (dryRun) {
      say(`would apply mirrors to ${app}: ${mirrorsAppliedText(app, items)}`);
      continue;
    }
    const before = process.exitCode;
    process.exitCode = 0;
    let allApplied = true;
    try {
      if (!built.length) {
        // Nothing to copy: no writer call (an empty file would empty the app's existing `From …` folders).
      } else if (app === 'rekordbox' && config.rekordbox === 'xml') {
        const r = writeRekordboxXml(context(), [...opts.folderFiles, ...built.map((b) => b.file)]);
        printResults([r]);
        for (const item of items) item.result = { action: 'xml written', counts: null };
      } else {
        for (const [i, b] of built.entries()) {
          const filePath = mirrorFilePath(config, app, b.folderName);
          writeJson(filePath, b.file);
          const results = runApps(context(), b.file, filePath, [app]);
          if (app === 'music') wroteMusic = true;
          if (!results.length || results.some((r) => r.action !== 'applied')) allApplied = false;
          items[i]!.result = results[0] ?? null;
        }
      }
    } catch (err) {
      process.exitCode = 1;
      say(`mirrors apply failed (${app}): ${err instanceof Error ? err.message : String(err)}`);
    }
    const ok = process.exitCode === 0 && allApplied;
    process.exitCode = ok ? before : 1;
    say(`${ok ? 'mirrors applied' : 'mirrors apply FAILED'}: ${app} ${mirrorsAppliedText(app, items)}`);
    if (ok) state.last_mirrors_hash[app] = hash;
  }
  if (unchanged.length) say(`mirrors unchanged (${unchanged.join(', ')})`);
  // The JXA writer opens Music; quit it again, else every later change would wait on "Music running".
  if (wroteMusic) quitMusic();
  if (ctx) {
    noteMusicCheck(state, ctx);
    if ((ctx as RunContext).musicRefusedAt) say(`music ${MUSIC_REFUSED}`);
  }
  return changed;
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
  let mirrorsChanged = false;
  try {
    const state = readState(config);
    // The apps' own playlists are read first, so a rekordbox.xml the folders step writes carries the `From …` folders
    // too. With fewer than two apps there is nothing to copy between them.
    let source: MirrorSource | null = null;
    if (activeApps(config, null).apps.length > 1) {
      try {
        source = readMirrorSource(config);
        for (const e of source.run.events) say(`mirrors: ${e}`);
        if (!dryRun) saveCollections(config, source.run.file);
      } catch (err) {
        fail(`mirrors read failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    let folderFiles: PlaylistsFile[] = [];
    const backedUp = new Set<LiveApp>();
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
      folderFiles = built.filter((b) => b.file.playlists.length).map((b) => b.file);
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
              const r = writeRekordboxXml(ctx, [
                ...withPlaylists.map((b) => b.file),
                ...xmlMirrorFiles(config, state, source),
              ]);
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
          for (const a of ctx.backedUp) backedUp.add(a);
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

    if (source) {
      try {
        mirrorsChanged = autoMirrors(config, state, source, { dryRun, say, folderFiles, backedUp });
      } catch (err) {
        fail(`mirrors failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (!foldersChanged && !mirrorsChanged && process.exitCode !== 1) say('no change');

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
      // rekordbox.xml is one file: it keeps the `From …` folders when rekordbox is enabled for mirrors.
      const state = readState(config);
      let mirrorFiles: PlaylistsFile[] = [];
      if (mirrorsEnabled(config, state, 'rekordbox')) {
        console.log("reading the other apps' playlists for the From folders in rekordbox.xml");
        mirrorFiles = xmlMirrorFiles(config, state, readMirrorSource(config));
      }
      const r = writeRekordboxXml(ctx, [...withPlaylists.map((b) => b.file), ...mirrorFiles]);
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

/**
 * `mirrors`: the `From …` folders by hand. Dry run unless --apply. A dry run never runs the Music copy-on-add check
 * (it imports a song; `--no-probe` changes nothing there); an --apply runs it before its first Music write until the
 * state says it passed, as `folders --apply` does. A successful --apply enables the app in the tick
 * (`state.mirror_apps`) and records its hash.
 */
export async function mirrorsCommand(baseConfig: Config, args: string[]): Promise<void> {
  const opts = parseMirrorsArgs(args);
  const config: Config = opts.traktorCollection
    ? { ...baseConfig, traktor: { ...baseConfig.traktor, collection: resolve(opts.traktorCollection) } }
    : baseConfig;
  const paths = stagingPaths(config);
  const { apps, skipped } = activeApps(config, opts.apps);
  if (opts.apply && !takeLock(paths.lock))
    throw new Error(`a tick is running (${paths.lock}): run again when it has finished`);
  try {
    // Each app being written must be closed (rekordbox only in `db` mode), before ANY write.
    if (opts.apply) {
      const blocking = blockingApps(apps, config.rekordbox, openApps());
      if (blocking.length)
        throw new Error(`${waitingText(blocking)}: quit ${blocking.join(' and ')} and run again (nothing written)`);
    }
    console.log(opts.apply ? 'APPLY: writing to the apps (backups first)' : 'dry run: nothing is written (add --apply)');
    for (const s of skipped) console.log(s);
    if (!apps.length) {
      console.log(`no app to write (enable one in ${config.path})`);
      return;
    }
    const source = readMirrorSource(config);
    saveCollections(config, source.run.file);
    console.log(`read                 ${paths.collections}`);
    printOrigins(source.run);
    console.log(
      source.index
        ? `library index        ${source.index.tracks.length} rekordbox files (${source.index.generated_at})`
        : 'library index        none: every track by path only',
    );
    const state = readState(config);
    // A dry run never probes (it would import a song); an apply checks before its first Music write until it passed.
    const ctx = newContext(config, opts.apply, opts.noProbe || !opts.apply, state.music_copy_check);
    // rekordbox.xml is one file: in xml mode the folder playlists go in beside the `From …` folders.
    const folderFiles =
      apps.includes('rekordbox') && config.rekordbox === 'xml'
        ? buildFolders(config.folders, loadLocalIndex(config), () => {})
            .filter((b) => b.file.playlists.length)
            .map((b) => b.file)
        : [];
    const enabled: LiveApp[] = [];
    const hashes: Partial<Record<LiveApp, string>> = {};
    for (const app of apps) {
      const built = mirrorsFor(config, source, app);
      hashes[app] = mirrorsHash(config, app, built);
      console.log('');
      if (!built.length) {
        console.log(`== ${app}: nothing to copy (no writer runs: an existing From folder in ${app} is left as it is)`);
        if (opts.apply) enabled.push(app);
        continue;
      }
      const before = process.exitCode;
      process.exitCode = 0;
      let appOk = true;
      if (app === 'rekordbox' && config.rekordbox === 'xml') {
        for (const b of built) printMirror(app, b);
        console.log('');
        const r = writeRekordboxXml(ctx, [...folderFiles, ...built.map((b) => b.file)]);
        printResults([r]);
      } else {
        for (const b of built) {
          printMirror(app, b);
          const filePath = mirrorFilePath(config, app, b.folderName);
          writeJson(filePath, b.file);
          console.log('');
          const results = runApps(ctx, b.file, filePath, [app]);
          if (!results.length || results.some((r) => r.action !== (opts.apply ? 'applied' : 'dry run'))) appOk = false;
        }
      }
      if (opts.apply && app === 'music') quitMusic();
      if (opts.apply && appOk && process.exitCode !== 1) enabled.push(app);
      if (process.exitCode !== 1) process.exitCode = before;
    }
    if (ctx.musicRefused) console.log(`music ${MUSIC_REFUSED}`);
    if (enabled.length || ctx.musicCheck === 'passed' || ctx.musicRefusedAt) {
      const st = readState(config);
      noteMusicCheck(st, ctx);
      for (const app of enabled) {
        if (!st.mirror_apps.includes(app)) st.mirror_apps.push(app);
        st.last_mirrors_hash[app] = hashes[app]!;
      }
      writeState(config, st);
      if (enabled.length)
        console.log(`mirrors enabled in the tick for ${enabled.join(', ')} (recorded in ${paths.state})`);
    }
    if (opts.apply)
      appendFileSync(
        paths.log,
        `${logLine(new Date(), `mirrors ${enabled.length ? `enabled by hand: ${enabled.join(', ')}` : 'apply by hand: nothing enabled'}`)}\n`,
      );
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
