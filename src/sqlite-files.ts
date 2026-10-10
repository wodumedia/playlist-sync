/**
 * rekordbox's master.db with its write-ahead log. rekordboxAgent keeps the database open in WAL mode, so recent
 * writes sit in `master.db-wal` (and its index `master.db-shm`) until a checkpoint: a copy of master.db alone misses
 * them. Copies and backups take all three under the same base name.
 */
import { copyFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

export const SQLITE_SIDE_FILES = ['-wal', '-shm'] as const;

/** master.db, master.db-wal, master.db-shm (whether or not they exist). */
export function sqliteFamily(db: string): string[] {
  return [db, ...SQLITE_SIDE_FILES.map((s) => `${db}${s}`)];
}

/** The newer mtime of `db` and `db`-wal as ISO, or null when `db` is not there. */
export function dbChangedAt(db: string): string | null {
  if (!existsSync(db)) return null;
  let ms = statSync(db).mtimeMs;
  const wal = `${db}-wal`;
  if (existsSync(wal)) ms = Math.max(ms, statSync(wal).mtimeMs);
  return new Date(ms).toISOString();
}

const stamp = (path: string): string => {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'none';
  }
};

/**
 * Copies `db` and its -wal / -shm (when present) into `destDir` as `destName` (+ `-wal`, `-shm`); a side file the
 * source does not have is removed from `destDir`, so a stale WAL from an earlier copy is never replayed onto a newer
 * database. The WAL is copied before the database (the database file only changes at a checkpoint, which writes what
 * the WAL holds); when the database or the WAL changed during the copy, it is copied again (up to `attempts` times).
 * Returns the destination paths written.
 */
export function copySqliteFamily(
  db: string,
  destDir: string,
  destName = basename(db),
  attempts = 3,
): string[] {
  let written: string[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const before = sqliteFamily(db).slice(0, 2).map(stamp).join('|');
    written = [];
    for (const suffix of [...SQLITE_SIDE_FILES, ''] as const) {
      const src = `${db}${suffix}`;
      const dest = join(destDir, `${destName}${suffix}`);
      if (existsSync(src)) {
        copyFileSync(src, dest);
        written.push(dest);
      } else if (suffix) rmSync(dest, { force: true });
    }
    if (sqliteFamily(db).slice(0, 2).map(stamp).join('|') === before) break;
  }
  return written;
}
