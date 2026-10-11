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
  decideMirrors,
  freshAutoState,
  mirrorsAppliedText,
  mirrorsEnabled,
  mirrorsSource,
  mirrorsStatusText,
  parseMirrorsArgs,
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
      mirror_apps: [],
      last_mirrors_hash: {},
      mirrors_noted_hash: {},
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
      mirror_apps: [],
      last_mirrors_hash: {},
      mirrors_noted_hash: {},
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
          folder: 'Crates',
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
      'Crates 128 playlists/7,262 tracks (rekordbox 6,105 linked, 1,157 missing, 3 added to the collection; music 7,262; traktor failed: boom)',
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

describe('playlist mirrors', () => {
  it('parseMirrorsArgs: dry run by default, app flags, collection path, --no-probe', () => {
    expect(parseMirrorsArgs([])).toEqual({ apply: false, apps: null, traktorCollection: null, noProbe: false });
    expect(parseMirrorsArgs(['--apply', '--music', '--rekordbox', '--no-probe'])).toEqual({
      apply: true,
      apps: ['rekordbox', 'music'],
      traktorCollection: null,
      noProbe: true,
    });
    expect(parseMirrorsArgs(['--traktor-collection', '/x.nml']).traktorCollection).toBe('/x.nml');
    expect(() => parseMirrorsArgs(['--apply', '--dry-run'])).toThrow(/pick one/);
    expect(() => parseMirrorsArgs(['--traktor-collection'])).toThrow(/needs a value/);
    expect(() => parseMirrorsArgs(['--bogus'])).toThrow(/unknown option/);
  });

  it('state: mirror fields default to empty and are read tolerantly', () => {
    expect(parseAutoState({}).mirror_apps).toEqual([]);
    expect(parseAutoState({ mirror_apps: 'x', last_mirrors_hash: [1] }).mirror_apps).toEqual([]);
    const s = parseAutoState({
      mirror_apps: ['music', 'bogus', 'rekordbox'],
      last_mirrors_hash: { music: 'h', rekordbox: 5 },
      mirrors_noted_hash: { traktor: 'n' },
    });
    expect(s.mirror_apps).toEqual(['rekordbox', 'music']);
    expect(s.last_mirrors_hash).toEqual({ music: 'h' });
    expect(s.mirrors_noted_hash).toEqual({ traktor: 'n' });
  });

  it('decideMirrors: not enabled notes once per change; enabled applies when that app is closed, waits when open', () => {
    const st = (over = {}) => ({ ...freshAutoState(), ...over });
    expect(decideMirrors(st(), 'music', 'h1', [])).toEqual({ action: 'not-enabled', note: true });
    expect(decideMirrors(st({ mirrors_noted_hash: { music: 'h1' } }), 'music', 'h1', [])).toEqual({
      action: 'not-enabled',
      note: false,
    });
    expect(decideMirrors(st({ mirrors_noted_hash: { music: 'h1' } }), 'music', 'h2', [])).toEqual({
      action: 'not-enabled',
      note: true,
    });
    const on = st({ mirror_apps: ['music'], last_mirrors_hash: { music: 'h1' } });
    expect(decideMirrors(on, 'music', 'h1', ['Music'])).toEqual({ action: 'unchanged' });
    expect(decideMirrors(on, 'music', 'h2', ['Music'])).toEqual({ action: 'waiting', waitingOn: ['Music'] });
    expect(decideMirrors(on, 'music', 'h2', [])).toEqual({ action: 'apply' });
    // Only the app itself blocks: another app being open is not passed in, so it applies.
    expect(decideMirrors(st({ mirror_apps: ['traktor'] }), 'traktor', 'h', [])).toEqual({ action: 'apply' });
  });

  it('mirrorsEnabled: on from the config or from a mirrors --apply (state), off when neither', () => {
    const cfg = (m: object) => ({ mirrors: m });
    const st = (apps: ('rekordbox' | 'music' | 'traktor')[]) => ({ mirror_apps: apps });
    expect(mirrorsEnabled(cfg({ music: true }), st([]), 'music')).toBe(true);
    expect(mirrorsSource(cfg({ music: true }), st([]), 'music')).toBe('config');
    expect(mirrorsEnabled(cfg({}), st(['traktor']), 'traktor')).toBe(true);
    expect(mirrorsSource(cfg({}), st(['traktor']), 'traktor')).toBe('mirrors --apply');
    // Both: the config is named. false in the config does not undo a mirrors --apply (state.json mirror_apps does).
    expect(mirrorsSource(cfg({ traktor: true }), st(['traktor']), 'traktor')).toBe('config');
    expect(mirrorsEnabled(cfg({ traktor: false }), st(['traktor']), 'traktor')).toBe(true);
    expect(mirrorsEnabled(cfg({}), st([]), 'rekordbox')).toBe(false);
    expect(mirrorsEnabled(cfg({ rekordbox: false, music: true }), st(['music']), 'rekordbox')).toBe(false);
    expect(mirrorsSource(cfg({}), st([]), 'rekordbox')).toBe(null);
  });

  it('decideMirrors: an app on in the config and never written applies when closed, waits when open', () => {
    const st = (over = {}) => ({ ...freshAutoState(), ...over });
    const config = { mirrors: { music: true, rekordbox: true } };
    expect(decideMirrors(st(), 'music', 'h1', [], config)).toEqual({ action: 'apply' });
    expect(decideMirrors(st(), 'music', 'h1', ['Music'], config)).toEqual({ action: 'waiting', waitingOn: ['Music'] });
    // rekordbox in xml mode: blockingApps gives nothing, so it applies (into rekordbox.xml) on the next tick.
    expect(decideMirrors(st(), 'rekordbox', 'h1', [], config)).toEqual({ action: 'apply' });
    // Written once: unchanged until the hash moves.
    expect(decideMirrors(st({ last_mirrors_hash: { music: 'h1' } }), 'music', 'h1', ['Music'], config)).toEqual({
      action: 'unchanged',
    });
    // Not in the config (nor in state): the not-enabled hint, as before.
    expect(decideMirrors(st(), 'traktor', 'h1', [], config)).toEqual({ action: 'not-enabled', note: true });
    expect(decideMirrors(st(), 'music', 'h1', [], { mirrors: { music: false } })).toEqual({
      action: 'not-enabled',
      note: true,
    });
  });

  it('mirrorsStatusText: the apps on and where from, or off', () => {
    const all = ['rekordbox', 'music', 'traktor'] as const;
    expect(mirrorsStatusText({ mirrors: { music: true, traktor: true } }, { mirror_apps: [] }, [...all])).toBe(
      'on: music, traktor (config)',
    );
    expect(mirrorsStatusText({ mirrors: {} }, { mirror_apps: ['music'] }, [...all])).toBe('on: music (mirrors --apply)');
    expect(mirrorsStatusText({ mirrors: { music: true } }, { mirror_apps: ['rekordbox'] }, [...all])).toBe(
      'on: music (config); rekordbox (mirrors --apply)',
    );
    // Only the enabled apps count.
    expect(mirrorsStatusText({ mirrors: { traktor: true } }, { mirror_apps: [] }, ['music'])).toMatch(/^off \(/);
    expect(mirrorsStatusText({ mirrors: {} }, { mirror_apps: [] }, [...all])).toBe(
      'off (set "mirrors" in the config, or run mirrors --apply --<app>)',
    );
  });

  it('mirrorsAppliedText: counts per folder and the writer result', () => {
    expect(
      mirrorsAppliedText('music', [
        {
          folder: 'From rekordbox',
          playlists: 154,
          tracks: 9001,
          result: { action: 'applied', counts: { playlists: 154, tracks: 8990, missing: 0 } },
        },
      ]),
    ).toBe('From rekordbox 154 playlists/9,001 tracks (music 8,990)');
    expect(
      mirrorsAppliedText('traktor', [
        { folder: 'From Music', playlists: 2, tracks: 5, result: { action: 'failed: x', counts: null } },
      ]),
    ).toBe('From Music 2 playlists/5 tracks (traktor failed: x)');
    expect(
      mirrorsAppliedText('rekordbox', [
        {
          folder: 'From Traktor',
          playlists: 1,
          tracks: 2,
          result: { action: 'applied', counts: { playlists: 1, tracks: 2, missing: 0, added: 1 } },
        },
      ]),
    ).toBe('From Traktor 1 playlists/2 tracks (rekordbox 2 linked, 0 missing, 1 added to the collection)');
    expect(mirrorsAppliedText('music', [{ folder: 'From Traktor', playlists: 1, tracks: 2, result: null }])).toBe(
      'From Traktor 1 playlists/2 tracks',
    );
    expect(mirrorsAppliedText('music', [])).toBe('music nothing to copy');
  });
});
