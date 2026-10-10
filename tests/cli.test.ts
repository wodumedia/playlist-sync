import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO = join(import.meta.dirname, '..');
const CLI = join(REPO, 'src', 'cli.ts');
let dir: string;
let staging: string;
let config: string;

const run = (args: string[], env: Record<string, string> = {}) =>
  execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PLAYLIST_SYNC_CONFIG: config, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'playlist-sync-cli-'));
  staging = join(dir, 'staging');
  config = join(dir, 'config.json');
  writeFileSync(
    config,
    JSON.stringify({
      folders: [join(REPO, 'tests', 'fixtures', 'Downloads'), join(dir, 'missing')],
      apps: { rekordbox: 'xml', music: false, traktor: { enabled: false } },
      stagingDir: staging,
    }),
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('cli', () => {
  it('auto --dry-run lists the fixture playlists and writes nothing', () => {
    const out = run(['auto', '--dry-run']);
    expect(out).toContain('2 playlists, 5 tracks (1 empty folders skipped, 1 0-byte files left out');
    expect(out).toMatch(/\s+4 {2}Albums\n\s+1 {2}House\n/);
    expect(out).toContain('dry run: folders: no directory at');
    expect(out).toContain('dry run: would apply folders to rekordbox: Downloads 2 playlists/5 tracks');
    expect(existsSync(staging) ? readdirSync(staging) : []).toEqual([]);
  });

  it('config-check passes on config.example.json and fails readably on a bad file', () => {
    expect(run(['config-check'], { PLAYLIST_SYNC_CONFIG: join(REPO, 'config.example.json') })).toContain('config ok');
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ folders: ['/x'], apps: { rekordbox: 'maybe' } }));
    let err = '';
    try {
      run(['config-check'], { PLAYLIST_SYNC_CONFIG: bad });
    } catch (e) {
      err = String((e as { stderr?: string }).stderr);
    }
    expect(err).toContain('apps.rekordbox');
  });

  it('unknown command: usage and exit 1', () => {
    expect(() => run(['bogus'])).toThrow();
  });
});
