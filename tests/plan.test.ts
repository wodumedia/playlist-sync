import { existsSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUTO_LOCK_STALE_MS,
  backupStamp,
  appHashes,
  appOfKey,
  backupsToRemove,
  decideFolders,
  foldersAppliedText,
  foldersHash,
  logLine,
  parseAutoArgs,
  parseAutoState,
  parseFoldersArgs,
  recordHashes,
  releaseLock,
  takeLock,
} from '../src/plan.ts';

const files = [
  {
    folder: 'DJ',
    playlists: [
      { name: 'A', tracks: [{ path: '/a/1.mp3', content_id: '' }] },
      { name: 'B', tracks: [{ path: '/b/1.mp3', content_id: '7' }] },
    ],
    rekordbox_add_files: true,
  },
];

describe('foldersHash', () => {
  it('stable for the same content, whatever else the file carries', () => {
    const withExtras = files.map((f) => ({ ...f, generated_at: 'x', playlists: f.playlists.map((p) => ({ ...p, slug: 's' })) }));
    expect(foldersHash(files)).toBe(foldersHash(withExtras));
    expect(foldersHash(files)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('moves on a new file, a renamed playlist, a new content id or another order', () => {
    const h = foldersHash(files);
    const f0 = files[0]!;
    expect(foldersHash([{ ...f0, playlists: [...f0.playlists, { name: 'C', tracks: [] }] }])).not.toBe(h);
    expect(foldersHash([{ ...f0, playlists: [{ ...f0.playlists[0]!, name: 'A2' }, f0.playlists[1]!] }])).not.toBe(h);
    expect(
      foldersHash([{ ...f0, playlists: [{ name: 'A', tracks: [{ path: '/a/1.mp3', content_id: '9' }] }, f0.playlists[1]!] }]),
    ).not.toBe(h);
    expect(foldersHash([{ ...f0, playlists: [...f0.playlists].reverse() }])).not.toBe(h);
  });
  it('the apps being written are part of it when given, in any order', () => {
    expect(foldersHash(files, ['music', 'rekordbox:xml'])).toBe(foldersHash(files, ['rekordbox:xml', 'music']));
    expect(foldersHash(files, ['music'])).not.toBe(foldersHash(files, ['music', 'traktor']));
    expect(foldersHash(files, ['music'])).not.toBe(foldersHash(files));
  });
});

describe('decideFolders (per app)', () => {
  const blocking = (open: string[]) => (keys: string[]) =>
    open.filter((o) => keys.some((k) => k.toLowerCase().startsWith(o.toLowerCase())));
  it('unchanged: nothing to do, never waiting', () => {
    expect(decideFolders({ last_folders_hash: { music: 'h' } }, { music: 'h' }, blocking(['Music']))).toEqual({
      changed: false,
      apply: false,
      keys: [],
      waitingOn: [],
    });
  });
  it('changed and the apps closed: apply every changed app', () => {
    expect(decideFolders({ last_folders_hash: {} }, { music: 'h', traktor: 't' }, blocking([]))).toEqual({
      changed: true,
      apply: true,
      keys: ['music', 'traktor'],
      waitingOn: [],
    });
  });
  it('changed with an app open: wait for it', () => {
    expect(
      decideFolders({ last_folders_hash: { music: 'old' } }, { music: 'h', traktor: 't' }, blocking(['Music', 'Traktor'])),
    ).toEqual({ changed: true, apply: false, keys: ['music', 'traktor'], waitingOn: ['Music', 'Traktor'] });
  });
  it('only the app whose own hash moved is written, and only it has to be closed', () => {
    const d = decideFolders(
      { last_folders_hash: { music: 'old', traktor: 't', 'rekordbox:db': 'r' } },
      { music: 'h', traktor: 't', 'rekordbox:db': 'r' },
      blocking(['Traktor']),
    );
    expect(d).toEqual({ changed: true, apply: true, keys: ['music'], waitingOn: [] });
  });
  it('a rekordbox mode switch is a new key, so it writes', () => {
    expect(decideFolders({ last_folders_hash: { 'rekordbox:xml': 'h' } }, { 'rekordbox:db': 'h2' }, blocking([])).keys).toEqual([
      'rekordbox:db',
    ]);
  });
  it('appHashes: one hash per key, each different', () => {
    const h = appHashes(files, ['music', 'traktor']);
    expect(h.music).toBe(foldersHash(files, ['music']));
    expect(h.music).not.toBe(h.traktor);
    expect(appOfKey('rekordbox:xml')).toBe('rekordbox');
    expect(appOfKey('music')).toBe('music');
  });
  it('recordHashes: applied keys set, a failed app keeps its old hash, a disabled app is dropped', () => {
    expect(
      recordHashes(
        { music: 'm0', traktor: 't0', 'rekordbox:xml': 'x0' },
        { music: 'm1', traktor: 't1' },
        ['traktor'],
        ['music', 'traktor'],
      ),
    ).toEqual({ music: 'm0', traktor: 't1' });
  });
});

describe('state', () => {
  it('a missing, corrupt or wrong-typed state file is a fresh state', () => {
    const fresh = {
      last_run: null,
      last_result: null,
      last_folders_hash: {},
      music_copy_check: null,
      music_copy_check_refused_at: null,
    };
    expect(parseAutoState(undefined)).toEqual(fresh);
    expect(parseAutoState('garbage')).toEqual(fresh);
    expect(parseAutoState([1, 2])).toEqual(fresh);
    expect(parseAutoState({ last_folders_hash: 42, last_run: '', music_copy_check: 'maybe' })).toEqual(fresh);
    expect(parseAutoState({ last_folders_hash: { music: 'h', traktor: 3 }, last_run: 't', other: 1 })).toEqual({
      last_run: 't',
      last_result: null,
      last_folders_hash: { music: 'h' },
      music_copy_check: null,
      music_copy_check_refused_at: null,
    });
  });
  it('the old single-string hash reads as no hashes (every app writes once)', () => {
    expect(parseAutoState({ last_folders_hash: 'h' }).last_folders_hash).toEqual({});
  });
  it('music_copy_check: "passed" kept, a missing key is null', () => {
    expect(parseAutoState({ music_copy_check: 'passed' }).music_copy_check).toBe('passed');
    expect(parseAutoState({ last_run: 't' }).music_copy_check).toBeNull();
  });
});

describe('backups', () => {
  it('backupStamp sorts by time and is safe in a folder name', () => {
    expect(backupStamp(new Date(2026, 0, 2, 3, 4, 5))).toBe('2026-01-02T03-04-05');
  });
  it('backupsToRemove keeps the newest per app and ignores others', () => {
    const names = [
      'music-2026-01-03T00-00-00',
      'music-2026-01-01T00-00-00',
      'music-2026-01-02T00-00-00',
      'traktor-2026-01-01T00-00-00',
      'music-notes',
    ];
    expect(backupsToRemove(names, 'music', 2)).toEqual(['music-2026-01-01T00-00-00']);
    expect(backupsToRemove(names, 'music', 10)).toEqual([]);
    expect(backupsToRemove(names, 'traktor', 0)).toEqual(['traktor-2026-01-01T00-00-00']);
    // A second backup in the same second (`-2`) is rotated too, in time order.
    const same = ['music-2026-01-01T00-00-00-2', 'music-2026-01-01T00-00-00', 'music-2026-01-02T00-00-00'];
    expect(backupsToRemove(same, 'music', 1)).toEqual(['music-2026-01-01T00-00-00', 'music-2026-01-01T00-00-00-2']);
  });
});

describe('lock', () => {
  it('mkdir lock: held once, released, a stale one taken over', () => {
    const dir = mkdtempSync(join(tmpdir(), 'playlist-sync-lock-'));
    try {
      const lock = join(dir, 'auto.lock');
      expect(takeLock(lock)).toBe(true);
      expect(takeLock(lock)).toBe(false);
      const old = new Date(Date.now() - AUTO_LOCK_STALE_MS - 60_000);
      utimesSync(lock, old, old);
      expect(takeLock(lock)).toBe(true);
      releaseLock(lock);
      expect(existsSync(lock)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('log', () => {
  it('logLine: ISO time, one line', () => {
    expect(logLine(new Date('2026-01-01T00:00:00Z'), 'a\n  b')).toBe('2026-01-01T00:00:00.000Z a | b');
  });
  it('foldersAppliedText', () => {
    expect(
      foldersAppliedText([
        {
          folder: 'DJ',
          playlists: 128,
          tracks: 7262,
          results: [
            { app: 'rekordbox', action: 'applied', counts: { playlists: 128, tracks: 6105, missing: 1157, added: 3 } },
            { app: 'music', action: 'applied', counts: { playlists: 128, tracks: 7262, missing: 0 } },
            { app: 'traktor', action: 'failed: boom', counts: null },
          ],
        },
      ]),
    ).toBe(
      'DJ 128 playlists/7,262 tracks (rekordbox 6,105 linked, 1,157 missing, 3 added to the collection; music 7,262; traktor failed: boom)',
    );
  });
});

describe('args', () => {
  it('auto', () => {
    expect(parseAutoArgs([])).toEqual({ dryRun: false });
    expect(parseAutoArgs(['--dry-run'])).toEqual({ dryRun: true });
    expect(() => parseAutoArgs(['--apply'])).toThrow(/unknown option/);
  });
  it('folders', () => {
    expect(parseFoldersArgs([])).toEqual({ apply: false, apps: null, noProbe: false });
    expect(parseFoldersArgs(['--traktor', '--apply', '--rekordbox', '--no-probe'])).toEqual({
      apply: true,
      apps: ['rekordbox', 'traktor'],
      noProbe: true,
    });
    expect(() => parseFoldersArgs(['--apply', '--dry-run'])).toThrow(/pick one/);
    expect(() => parseFoldersArgs(['--dir'])).toThrow(/unknown option/);
  });
});
