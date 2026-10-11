/**
 * Child processes with a time limit. Music can sit on a modal alert, and an `osascript` waiting on it would hang the
 * tick forever (and the next ticks would find the lock taken). Every osascript call goes through `execWithTimeout`:
 * on the limit the child is killed and a `ChildTimeout` thrown, which the caller turns into a failed writer.
 */
import { type ExecFileSyncOptionsWithStringEncoding, execFileSync } from 'node:child_process';

/** The Music writer (src/writers/music-playlists.js) for one playlists file: generous, an import can be slow. */
export const MUSIC_WRITE_TIMEOUT_MS = 60 * 60_000;
/** The Music reader (src/readers/music-read.js): a whole library's playlists. A timeout skips the Music read for
 * that run (the last read is carried). */
export const MUSIC_READ_TIMEOUT_MS = 120_000;
/** A one-line AppleScript (quit Music, delete the probe row). */
export const OSASCRIPT_SHORT_TIMEOUT_MS = 60_000;

/** 120000 → "120s", 3600000 → "60 min". */
export function formatTimeout(ms: number): string {
  return ms >= 600_000 && ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)}s`;
}

export class ChildTimeout extends Error {
  // Plain fields, not parameter properties: node runs this file with type stripping only.
  readonly label: string;
  readonly timeoutMs: number;
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${formatTimeout(timeoutMs)}`);
    this.name = 'ChildTimeout';
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

/** True for the error execFileSync throws when its `timeout` killed the child. */
export function isTimeoutError(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'ETIMEDOUT';
}

type Exec = (cmd: string, args: string[], opts: ExecFileSyncOptionsWithStringEncoding) => string;

/**
 * execFileSync (utf8) that kills the child after `timeoutMs` (SIGKILL unless `killSignal` says otherwise) and throws
 * `ChildTimeout(label)`. Any other failure is rethrown unchanged (its status/stdout/stderr intact).
 */
export function execWithTimeout(
  cmd: string,
  args: string[],
  opts: {
    label: string;
    timeoutMs: number;
    maxBuffer?: number;
    killSignal?: NodeJS.Signals;
    stdio?: ExecFileSyncOptionsWithStringEncoding['stdio'];
  },
  exec: Exec = execFileSync as Exec,
): string {
  try {
    const out = exec(cmd, args, {
      encoding: 'utf8',
      timeout: opts.timeoutMs,
      killSignal: opts.killSignal ?? 'SIGKILL',
      ...(opts.maxBuffer ? { maxBuffer: opts.maxBuffer } : {}),
      ...(opts.stdio ? { stdio: opts.stdio } : {}),
    });
    return typeof out === 'string' ? out : '';
  } catch (err) {
    if (isTimeoutError(err)) throw new ChildTimeout(opts.label, opts.timeoutMs);
    throw err;
  }
}
