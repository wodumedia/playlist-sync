// The Music copy-on-add check in the apply path, with the osascript writer mocked: never reaches Music.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[][] = [];
let reply: () => string;
vi.mock('../src/timeout.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/timeout.ts')>()),
  execWithTimeout: (_cmd: string, args: string[]) => {
    calls.push(args);
    return reply();
  },
}));
vi.mock('../src/running.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/running.ts')>()),
  running: () => false,
  traktorRunning: () => false,
}));

const { MUSIC_REFUSED, newContext, runApps } = await import('../src/apply.ts');
const { parseConfig } = await import('../src/config.ts');
const { appApplied, noteMusicCheck } = await import('../src/tick.ts');
const { freshAutoState, musicCheckDue, MUSIC_RECHECK_MS } = await import('../src/plan.ts');

const home = mkdtempSync(join(tmpdir(), 'playlist-sync-music-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const config = parseConfig({ folders: ['/x/Downloads'], apps: { music: true }, stagingDir: join(home, 's') }, 'c.json', home);
const file = { folder: 'Downloads', playlists: [{ slug: 'a', name: 'A', tracks: [] }] } as never;

const ok = (probe: string | null) =>
  JSON.stringify({
    ok: true,
    folder: { exists: true },
    playlists: { create: 0, update: 0, unchanged: 1, remove: 0 },
    tracks: { found: 0, toImport: 0, missingOnDisk: 0 },
    failed: [],
    probe,
  });

beforeEach(() => {
  calls.length = 0;
  process.exitCode = 0;
});

describe('Music copy-on-add check on apply', () => {
  it('not passed yet: the apply runs the check; "passed" is carried on the context, later files skip it', () => {
    reply = () => ok('passed');
    const ctx = newContext(config, true, false, null);
    const [r] = runApps(ctx, file, '/tmp/f.json', ['music']);
    expect(calls[0]).toContain('--probe');
    expect(calls[0]).toContain('--apply');
    expect(r?.action).toBe('applied');
    expect(ctx.musicCheck).toBe('passed');
    runApps(ctx, file, '/tmp/f.json', ['music']);
    expect(calls[1]).not.toContain('--probe');
  });

  it('already passed (state.json): no check', () => {
    reply = () => ok(null);
    runApps(newContext(config, true, false, 'passed'), file, '/tmp/f.json', ['music']);
    expect(calls[0]).not.toContain('--probe');
  });

  it('Music copies: refused, failed for the run (exit 1, no hash), not retried for the next file', () => {
    reply = () => {
      throw Object.assign(new Error('exit 2'), {
        status: 2,
        stdout: JSON.stringify({ ok: false, kind: 'copies', reason: 'Music copies files on add', imported_location: null }),
      });
    };
    const ctx = newContext(config, true, false, null);
    const [r] = runApps(ctx, file, '/tmp/f.json', ['music']);
    expect(r?.action).toBe(MUSIC_REFUSED);
    expect(`music ${r?.action}`).toBe(
      'music refused: "Copy files to Music Media folder" is on — turn it off in Music > Settings > Files, then the next tick writes (re-checks once a day; run: node src/cli.ts folders --music)',
    );
    expect(ctx.musicRefused).toBe(true);
    expect(ctx.musicCheck).toBeNull();
    expect(ctx.musicRefusedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(process.exitCode).toBe(1);
    expect(appApplied([r!], 'music')).toBe(false);
    const [again] = runApps(ctx, file, '/tmp/f.json', ['music']);
    expect(again?.action).toBe(MUSIC_REFUSED);
    expect(calls).toHaveLength(1);
    process.exitCode = 0;
  });

  it('back-off: the tick re-checks only 24 h after a refusal; a pass clears it', () => {
    const now = Date.parse('2026-10-10T12:00:00Z');
    expect(musicCheckDue(null, now)).toBe(true);
    expect(musicCheckDue('2026-10-10T00:00:00Z', now)).toBe(false);
    expect(musicCheckDue(new Date(now - MUSIC_RECHECK_MS).toISOString(), now)).toBe(true);
    expect(musicCheckDue('garbage', now)).toBe(true);
    const state = freshAutoState();
    noteMusicCheck(state, { musicCheck: null, musicRefusedAt: '2026-10-10T00:00:00.000Z' });
    expect(state.music_copy_check_refused_at).toBe('2026-10-10T00:00:00.000Z');
    expect(state.music_copy_check).toBeNull();
    noteMusicCheck(state, { musicCheck: 'passed', musicRefusedAt: null });
    expect(state).toMatchObject({ music_copy_check: 'passed', music_copy_check_refused_at: null });
  });

  it('back-off held (musicRefused preset): Music is not run, no backup, no osascript', () => {
    reply = () => ok('passed');
    const ctx = newContext(config, true, false, null);
    ctx.musicRefused = true;
    const [r] = runApps(ctx, file, '/tmp/f.json', ['music']);
    expect(r?.action).toBe(MUSIC_REFUSED);
    expect(calls).toHaveLength(0);
    expect(ctx.musicRefusedAt).toBeNull();
    process.exitCode = 0;
  });

  it('appApplied: per app, the XML result counts as applied', () => {
    const rs = [
      { app: 'rekordbox' as const, action: 'xml written' },
      { app: 'traktor' as const, action: 'applied' },
      { app: 'music' as const, action: 'failed: x' },
    ];
    expect(appApplied(rs, 'rekordbox')).toBe(true);
    expect(appApplied(rs, 'traktor')).toBe(true);
    expect(appApplied(rs, 'music')).toBe(false);
  });
});
