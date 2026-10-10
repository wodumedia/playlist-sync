/**
 * The tick's pure parts: flag parsing, the folders hash and decision, the state file, the lock, log lines and backup
 * rotation. Only the lock helpers touch the disk.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export type LiveApp = 'rekordbox' | 'music' | 'traktor';
export const LIVE_APPS: LiveApp[] = ['rekordbox', 'music', 'traktor'];

export interface AppCounts {
  playlists: number;
  tracks: number;
  missing: number;
  /** rekordbox content rows added to the collection by this apply; absent = 0. */
  added?: number;
}

/** `YYYY-MM-DDTHH-mm-ss` in local time: sorts by time, safe in a folder name. */
export function backupStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** Given the backups folder's listing, the `<app>-<stamp>` folders (and `<app>-<stamp>-<k>`, a second backup in the
 * same second) to delete so only the newest `keep` remain. */
export function backupsToRemove(names: string[], app: string, keep: number): string[] {
  const re = new RegExp(`^${app}-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}(-\\d+)?$`);
  const mine = names.filter((n) => re.test(n)).sort();
  return mine.slice(0, Math.max(0, mine.length - keep));
}

// ---- state ----

/** `<staging>/state.json`: what the tick last applied. */
export interface AutoState {
  last_run: string | null;
  last_result: string | null;
  /** Per app key (`rekordbox:xml`, `rekordbox:db`, `music`, `traktor`): the `foldersHash` at that app's last
   * successful apply. An app is written again only when its own hash moved. */
  last_folders_hash: Record<string, string>;
  /** "passed" once the Music copy-on-add check found Music adding by reference; null = check before the next Music
   * write. */
  music_copy_check: 'passed' | null;
  /** When the check last found Music copying (ISO): the tick re-checks only once this is 24 h old. */
  music_copy_check_refused_at: string | null;
}

export const MUSIC_RECHECK_MS = 24 * 60 * 60 * 1000;

/** Whether the tick may run the Music check now: never refused, or refused 24 h ago or more (a bad date = due). */
export function musicCheckDue(refusedAt: string | null, nowMs = Date.now()): boolean {
  if (!refusedAt) return true;
  const t = Date.parse(refusedAt);
  return !Number.isFinite(t) || nowMs - t >= MUSIC_RECHECK_MS;
}

export const freshAutoState = (): AutoState => ({
  last_run: null,
  last_result: null,
  last_folders_hash: {},
  music_copy_check: null,
  music_copy_check_refused_at: null,
});

/** The state file's contents (already JSON-parsed, or undefined when missing/corrupt) → a valid state; a field of the
 * wrong type becomes empty (the old single-string `last_folders_hash` too), so a damaged or old file means "apply
 * again", never a crash. */
export function parseAutoState(raw: unknown): AutoState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return freshAutoState();
  const r = raw as Record<string, unknown>;
  const s = (k: 'last_run' | 'last_result' | 'music_copy_check_refused_at'): string | null =>
    typeof r[k] === 'string' && r[k] ? (r[k] as string) : null;
  const hashes: Record<string, string> = {};
  const h = r.last_folders_hash;
  if (h && typeof h === 'object' && !Array.isArray(h))
    for (const [k, v] of Object.entries(h)) if (typeof v === 'string' && v) hashes[k] = v;
  return {
    last_run: s('last_run'),
    last_result: s('last_result'),
    last_folders_hash: hashes,
    music_copy_check: r.music_copy_check === 'passed' ? 'passed' : null,
    music_copy_check_refused_at: s('music_copy_check_refused_at'),
  };
}

// ---- lock ----

/** A lock folder older than this is left over from a crashed tick and is taken over. */
export const AUTO_LOCK_STALE_MS = 2 * 60 * 60 * 1000;

export function lockIsStale(lockMtimeMs: number, nowMs: number): boolean {
  return nowMs - lockMtimeMs > AUTO_LOCK_STALE_MS;
}

/** mkdir is atomic: whoever creates the folder holds the lock. A folder older than 2 h is a crashed tick's. */
export function takeLock(lock: string, nowMs = Date.now()): boolean {
  mkdirSync(dirname(lock), { recursive: true });
  try {
    mkdirSync(lock);
    return true;
  } catch {
    try {
      if (!lockIsStale(statSync(lock).mtimeMs, nowMs)) return false;
      rmSync(lock, { recursive: true, force: true });
      mkdirSync(lock);
      return true;
    } catch {
      return false;
    }
  }
}

export function releaseLock(lock: string): void {
  rmSync(lock, { recursive: true, force: true });
}

// ---- log ----

/** One line of the tick log: "<ISO time> <event>", newlines folded so a line stays a line. */
export function logLine(now: Date, event: string): string {
  return `${now.toISOString()} ${event.replace(/\s*\n\s*/g, ' | ')}`;
}

export function waitingText(apps: string[]): string {
  return `${apps.join(', ')} running`;
}

// ---- args ----

/** `auto [--dry-run]`. */
export function parseAutoArgs(args: string[]): { dryRun: boolean } {
  let dryRun = false;
  for (const a of args) {
    if (a === '--dry-run') dryRun = true;
    else throw new Error(`unknown option ${a}`);
  }
  return { dryRun };
}

export interface FoldersArgs {
  apply: boolean;
  /** Picked with --rekordbox/--music/--traktor; null = every enabled app. */
  apps: LiveApp[] | null;
  noProbe: boolean;
}

/** `folders [--dry-run|--apply] [--rekordbox] [--music] [--traktor] [--no-probe]`. */
export function parseFoldersArgs(args: string[]): FoldersArgs {
  let apply = false;
  let dryRun = false;
  const picked = new Set<LiveApp>();
  let noProbe = false;
  for (const a of args) {
    if (a === '--apply') apply = true;
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--rekordbox' || a === '--traktor' || a === '--music') picked.add(a.slice(2) as LiveApp);
    else if (a === '--no-probe') noProbe = true;
    else throw new Error(`unknown option ${a}`);
  }
  if (apply && dryRun) throw new Error('--apply and --dry-run both given: pick one');
  const apps = picked.size ? LIVE_APPS.filter((x) => picked.has(x)) : null;
  return { apply, apps, noProbe };
}

// ---- folders ----

/** The parts of a built playlists file the hash covers. */
export interface FoldersHashInput {
  folder: string;
  playlists: { name: string; tracks: { path: string; content_id: string }[] }[];
  rekordbox_add_files?: boolean;
}

/** The tick's change test: content only (folder names, playlist names in order, each track's path and rekordbox
 * content id in order), never a timestamp, so unchanged folders give the same hash and a new subfolder, a new file in
 * one, or a file rekordbox newly knows changes it. `apps` (the apps being written, e.g. `rekordbox:db`) is hashed when
 * given, so enabling an app writes it on the next tick even when the folders did not change. */
export function foldersHash(files: FoldersHashInput[], apps?: string[]): string {
  const content: unknown[] = files.map((f) => [
    f.folder,
    f.playlists.map((p) => [p.name, p.tracks.map((t) => [t.path, t.content_id])]),
    ...(f.rekordbox_add_files ? ['rekordbox_add_files'] : []),
  ]);
  if (apps) content.push({ apps: [...apps].sort() });
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

/** One hash per app key: `foldersHash(files, [key])`. */
export function appHashes(files: FoldersHashInput[], keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.map((k) => [k, foldersHash(files, [k])]));
}

/** The app of an app key (`rekordbox:db` → `rekordbox`). */
export function appOfKey(key: string): LiveApp {
  return (key.startsWith('rekordbox') ? 'rekordbox' : key) as LiveApp;
}

export interface FoldersDecision {
  /** Some app's hash moved. */
  changed: boolean;
  apply: boolean;
  /** The app keys whose hash moved: the apps this tick writes. */
  keys: string[];
  /** Apps that block the apply; empty unless the folders changed. */
  waitingOn: string[];
}

/** Write the apps whose own hash moved, once every one of them that blocks (`blocking(keys)`: those open) is closed. */
export function decideFolders(
  state: Pick<AutoState, 'last_folders_hash'>,
  hashes: Record<string, string>,
  blocking: (keys: string[]) => string[],
): FoldersDecision {
  const keys = Object.keys(hashes).filter((k) => state.last_folders_hash[k] !== hashes[k]);
  const changed = keys.length > 0;
  const waitingOn = changed ? [...blocking(keys)] : [];
  return { changed, apply: changed && waitingOn.length === 0, keys, waitingOn };
}

/** The recorded hashes after a run: entries of apps no longer enabled dropped (so re-enabling one writes it), the
 * applied keys set to their new hash. */
export function recordHashes(
  recorded: Record<string, string>,
  hashes: Record<string, string>,
  applied: string[],
  enabledKeys: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of enabledKeys) if (recorded[k]) out[k] = recorded[k];
  for (const k of applied) if (hashes[k]) out[k] = hashes[k];
  return out;
}

export interface AppResult {
  app: LiveApp;
  /** `applied`, `dry run`, `skipped: …` or `failed: …`. */
  action: string;
  counts: AppCounts | null;
  backup: string | null;
  notes: string[];
}

export interface FoldersAppliedDir {
  folder: string;
  playlists: number;
  tracks: number;
  results: Pick<AppResult, 'app' | 'action' | 'counts'>[];
}

const n = (x: number) => x.toLocaleString('en-US');

/** The log text after a folders apply: "Download MP3s 128 playlists/7,262 tracks (rekordbox 6,105 linked, 1,157
 * missing; music 7,262), Download Albums …". A failed or skipped app shows its action instead of counts. */
export function foldersAppliedText(dirs: FoldersAppliedDir[]): string {
  return dirs
    .map((d) => {
      const apps = d.results.map((r) => {
        if (r.action !== 'applied' || !r.counts) return `${r.app} ${r.action}`;
        if (r.app === 'rekordbox')
          return (
            `rekordbox ${n(r.counts.tracks)} linked, ${n(r.counts.missing)} missing` +
            (r.counts.added ? `, ${n(r.counts.added)} added to the collection` : '')
          );
        return `${r.app} ${n(r.counts.tracks)}`;
      });
      return `${d.folder} ${n(d.playlists)} playlists/${n(d.tracks)} tracks${apps.length ? ` (${apps.join('; ')})` : ''}`;
    })
    .join(', ');
}

export interface FilesSkipped {
  unsupported: number;
  not_on_disk: number;
  empty: number;
  examples: { reason: string; path: string }[];
}

/** Where rekordbox-write.py adds rows to the collection, and what it could not add. */
export function rekordboxAddedNotes(
  byPlaylist: Record<string, number>,
  skipped: FilesSkipped | null,
  apply: boolean,
): string[] {
  const notes: string[] = [];
  const rows = Object.entries(byPlaylist).filter(([, k]) => k > 0);
  if (rows.length) {
    rows.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const total = rows.reduce((t, [, k]) => t + k, 0);
    notes.push(
      `${n(total)} files ${apply ? 'added to' : 'to add to'} the collection: ` +
        rows.map(([name, k]) => `${name} ${n(k)}`).join(', '),
    );
  }
  if (skipped) {
    const parts = (
      [
        ['unsupported', 'unsupported type'],
        ['not_on_disk', 'not on disk'],
        ['empty', '0 bytes'],
      ] as const
    )
      .filter(([k]) => skipped[k] > 0)
      .map(([k, label]) => `${n(skipped[k])} ${label}`);
    if (parts.length) {
      const ex = skipped.examples.map((e) => e.path.split('/').slice(-2).join('/'));
      notes.push(`not added: ${parts.join(', ')}${ex.length ? ` (e.g. ${ex.join('; ')})` : ''}`);
    }
  }
  return notes;
}
