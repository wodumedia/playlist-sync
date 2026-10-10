/** Backups before a write: `<staging>/backups/<app>-<YYYY-MM-DDTHH-mm-ss>/`, a `done` marker last, the newest 10
 * finished backups kept per app. */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { backupStamp, backupsToRemove } from './plan.ts';

export const KEEP_BACKUPS = 10;

/** Copies each existing file (or folder, such as Music's library package) into a new backup folder and returns it. */
export function backup(stagingDir: string, app: string, paths: string[], now = new Date()): string {
  const root = join(stagingDir, 'backups');
  let dir = join(root, `${app}-${backupStamp(now)}`);
  // Two backups of one app in the same second (a by-hand run right after a tick): never mix them.
  for (let k = 2; existsSync(dir); k++) dir = join(root, `${app}-${backupStamp(now)}-${k}`);
  mkdirSync(dir, { recursive: true });
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const dest = join(dir, basename(p));
    if (statSync(p).isDirectory()) cpSync(p, dest, { recursive: true, preserveTimestamps: true });
    else cpSync(p, dest, { preserveTimestamps: true });
  }
  writeFileSync(join(dir, 'done'), '');
  const finished = readdirSync(root).filter((n) => existsSync(join(root, n, 'done')));
  for (const old of backupsToRemove(finished, app, KEEP_BACKUPS)) rmSync(join(root, old), { recursive: true });
  return dir;
}
