import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootVolumeName } from '../src/folders.ts';
import { traktorLocation } from '../src/writers/traktor-nml.ts';

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

  it('auto --dry-run: an app with mirrors on in the config shows its From folders; off, the hint', () => {
    // A Traktor collection with one playlist of a fixture file; HOME is the temp dir, so rekordbox is never read.
    const track = join(REPO, 'tests', 'fixtures', 'Downloads', 'House', 'Artist A - Track One.mp3');
    const loc = traktorLocation(track, bootVolumeName());
    const nml = join(dir, 'collection.nml');
    writeFileSync(
      nml,
      `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<NML VERSION="19"><HEAD COMPANY="www.native-instruments.com" PROGRAM="Traktor"></HEAD>
<COLLECTION ENTRIES="1"><ENTRY TITLE="Track One" ARTIST="Artist A"><LOCATION DIR="${loc.DIR}" FILE="${loc.FILE}" VOLUME="${loc.VOLUME}" VOLUMEID="${loc.VOLUME}"></LOCATION>
</ENTRY>
</COLLECTION>
<PLAYLISTS><NODE TYPE="FOLDER" NAME="$ROOT"><SUBNODES COUNT="1">
<NODE TYPE="PLAYLIST" NAME="Warmup"><PLAYLIST ENTRIES="1" TYPE="LIST" UUID="a"><ENTRY><PRIMARYKEY TYPE="TRACK" KEY="${loc.KEY}"></PRIMARYKEY>
</ENTRY>
</PLAYLIST>
</NODE>
</SUBNODES>
</NODE>
</PLAYLISTS>
</NML>
`,
    );
    const base = {
      folders: [join(REPO, 'tests', 'fixtures', 'Downloads')],
      apps: { rekordbox: 'xml', music: false, traktor: { enabled: true, collection: nml } },
      stagingDir: join(dir, 'staging-mirrors'),
    };
    const on = join(dir, 'mirrors-on.json');
    writeFileSync(on, JSON.stringify({ ...base, mirrors: { rekordbox: true, traktor: true } }));
    const outOn = run(['auto', '--dry-run'], { PLAYLIST_SYNC_CONFIG: on, HOME: dir });
    expect(outOn).toContain('dry run: would apply mirrors to rekordbox: From Traktor 1 playlists/1 tracks');
    expect(outOn).not.toContain('mirrors not enabled for rekordbox');
    const off = join(dir, 'mirrors-off.json');
    writeFileSync(off, JSON.stringify(base));
    const outOff = run(['auto', '--dry-run'], { PLAYLIST_SYNC_CONFIG: off, HOME: dir });
    expect(outOff).toContain('dry run: mirrors not enabled for rekordbox: run mirrors --apply --rekordbox');
    expect(outOff).not.toContain('would apply mirrors');
    expect(existsSync(join(dir, 'staging-mirrors'))).toBe(false);
  });

  it('config-check accepts a config with and without "mirrors"', () => {
    const withMirrors = join(dir, 'with-mirrors.json');
    writeFileSync(withMirrors, JSON.stringify({ folders: ['/x'], apps: {}, mirrors: { music: true } }));
    expect(run(['config-check'], { PLAYLIST_SYNC_CONFIG: withMirrors })).toContain('config ok');
    const without = join(dir, 'without-mirrors.json');
    writeFileSync(without, JSON.stringify({ folders: ['/x'], apps: {} }));
    expect(run(['config-check'], { PLAYLIST_SYNC_CONFIG: without })).toContain('config ok');
  });

  it('unknown command: usage and exit 1', () => {
    expect(() => run(['bogus'])).toThrow();
  });
});
