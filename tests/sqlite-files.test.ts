import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copySqliteFamily, dbChangedAt, sqliteFamily } from '../src/sqlite-files.ts';

let dir: string;
let src: string;
let dest: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sqlite-files-'));
  src = join(dir, 'rekordbox');
  dest = join(dir, 'snapshot');
  mkdirSync(src);
  mkdirSync(dest);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const at = (path: string, iso: string) => utimesSync(path, new Date(iso), new Date(iso));

describe('sqliteFamily', () => {
  it('is the db, its -wal and its -shm', () => {
    expect(sqliteFamily('/x/master.db')).toEqual(['/x/master.db', '/x/master.db-wal', '/x/master.db-shm']);
  });
});

describe('copySqliteFamily', () => {
  it('copies master.db with its -wal and -shm under the destination name', () => {
    const db = join(src, 'master.db');
    writeFileSync(db, 'db');
    writeFileSync(`${db}-wal`, 'wal');
    writeFileSync(`${db}-shm`, 'shm');
    const written = copySqliteFamily(db, dest, 'master.db');
    expect(written.sort()).toEqual(sqliteFamily(join(dest, 'master.db')).sort());
    expect(readFileSync(join(dest, 'master.db'), 'utf8')).toBe('db');
    expect(readFileSync(join(dest, 'master.db-wal'), 'utf8')).toBe('wal');
    expect(readFileSync(join(dest, 'master.db-shm'), 'utf8')).toBe('shm');
  });

  it('removes a stale -wal/-shm in the destination when the source has none', () => {
    const db = join(src, 'master.db');
    writeFileSync(db, 'db2');
    writeFileSync(join(dest, 'master.db-wal'), 'old wal');
    writeFileSync(join(dest, 'master.db-shm'), 'old shm');
    expect(copySqliteFamily(db, dest)).toEqual([join(dest, 'master.db')]);
    expect(existsSync(join(dest, 'master.db-wal'))).toBe(false);
    expect(existsSync(join(dest, 'master.db-shm'))).toBe(false);
    expect(readFileSync(join(dest, 'master.db'), 'utf8')).toBe('db2');
  });
});

describe('dbChangedAt', () => {
  it('null when there is no database', () => {
    expect(dbChangedAt(join(src, 'master.db'))).toBeNull();
  });

  it("master.db's mtime when there is no WAL", () => {
    const db = join(src, 'master.db');
    writeFileSync(db, 'db');
    at(db, '2026-10-08T10:00:00.000Z');
    expect(dbChangedAt(db)).toBe('2026-10-08T10:00:00.000Z');
  });

  it('the WAL mtime when only the WAL moved (rekordboxAgent writes there first)', () => {
    const db = join(src, 'master.db');
    writeFileSync(db, 'db');
    writeFileSync(`${db}-wal`, 'wal');
    at(db, '2026-10-08T10:00:00.000Z');
    at(`${db}-wal`, '2026-10-08T11:30:00.000Z');
    expect(dbChangedAt(db)).toBe('2026-10-08T11:30:00.000Z');
    // A newer master.db (after a checkpoint) wins over an older WAL.
    at(db, '2026-10-08T12:00:00.000Z');
    expect(dbChangedAt(db)).toBe('2026-10-08T12:00:00.000Z');
  });
});
