import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activeApps, appKeys, enabledApps } from '../src/apply.ts';
import { ConfigError, configPath, DEFAULT_TRAKTOR, expandHome, loadConfig, parseConfig } from '../src/config.ts';
import { blockingApps } from '../src/running.ts';

const HOME = '/Users/someone';
const example = {
  folders: ['~/Music/DJ', '~/Music/Extras'],
  apps: {
    rekordbox: 'off',
    music: true,
    traktor: { enabled: false, collection: DEFAULT_TRAKTOR },
  },
  stagingDir: '~/Library/Application Support/playlist-sync',
  intervalMinutes: 30,
};

describe('config', () => {
  it('a valid config: ~ expanded everywhere, fixed library paths', () => {
    const c = parseConfig(example, '/c.json', HOME);
    expect(c.folders).toEqual([`${HOME}/Music/DJ`, `${HOME}/Music/Extras`]);
    expect(c.stagingDir).toBe(`${HOME}/Library/Application Support/playlist-sync`);
    expect(c.rekordbox).toBe('off');
    expect(c.music).toBe(true);
    expect(c.traktor).toEqual({ enabled: false, collection: DEFAULT_TRAKTOR });
    expect(c.rekordboxDb).toBe(`${HOME}/Library/Pioneer/rekordbox/master.db`);
    expect(c.musicLibrary).toBe(`${HOME}/Music/Music/Music Library.musiclibrary`);
    expect(c.venvPython.endsWith('/.venv/bin/python')).toBe(true);
  });

  it('defaults for everything but the folders', () => {
    const c = parseConfig({ folders: ['/x'], apps: {} }, '/c.json', HOME);
    expect(c).toMatchObject({ rekordbox: 'off', music: false, intervalMinutes: 30, traktor: { enabled: false } });
  });

  it('an invalid rekordbox mode is a readable error naming the field', () => {
    const bad = { ...example, apps: { ...example.apps, rekordbox: 'yes' } };
    expect(() => parseConfig(bad, '/c.json', HOME)).toThrow(ConfigError);
    expect(() => parseConfig(bad, '/c.json', HOME)).toThrow(/apps\.rekordbox/);
  });

  it('other errors: no folders, a bad interval, two roots with the same name', () => {
    expect(() => parseConfig({ ...example, folders: [] }, '/c.json', HOME)).toThrow(/folders: list at least one folder/);
    expect(() => parseConfig({ ...example, intervalMinutes: 0 }, '/c.json', HOME)).toThrow(/intervalMinutes/);
    expect(() => parseConfig({ ...example, folders: ['/a/Mix', '/b/Mix'] }, '/c.json', HOME)).toThrow(
      /both be the playlist folder "Mix"/,
    );
  });

  it('expandHome only touches a leading ~', () => {
    expect(expandHome('~', HOME)).toBe(HOME);
    expect(expandHome('~/a', HOME)).toBe(`${HOME}/a`);
    expect(expandHome('/a/~/b', HOME)).toBe('/a/~/b');
    expect(expandHome('~other/a', HOME)).toBe('~other/a');
  });

  it('configPath: $PLAYLIST_SYNC_CONFIG, else $XDG_CONFIG_HOME, else ~/.config', () => {
    expect(configPath({ PLAYLIST_SYNC_CONFIG: '~/c.json' }, HOME)).toBe(`${HOME}/c.json`);
    expect(configPath({ XDG_CONFIG_HOME: '/xdg' }, HOME)).toBe('/xdg/playlist-sync/config.json');
    expect(configPath({}, HOME)).toBe(`${HOME}/.config/playlist-sync/config.json`);
  });

  it('loadConfig: a missing file and broken JSON are readable errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'playlist-sync-config-'));
    try {
      expect(() => loadConfig(join(dir, 'none.json'))).toThrow(/no config at/);
      writeFileSync(join(dir, 'bad.json'), '{ nope');
      expect(() => loadConfig(join(dir, 'bad.json'))).toThrow(/not valid JSON/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('apps', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'playlist-sync-home-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const cfg = (apps: object) => parseConfig({ folders: ['/x'], apps }, '/c.json', home);

  it('only enabled apps are written; a missing library file skips the app with a reason', () => {
    const c = cfg({ rekordbox: 'db', music: true, traktor: { enabled: true, collection: join(home, 'c.nml') } });
    expect(enabledApps(c)).toEqual(['rekordbox', 'music', 'traktor']);
    const { apps, skipped } = activeApps(c, null);
    expect(apps).toEqual(['music']);
    expect(skipped).toEqual([
      `rekordbox: no database at ${home}/Library/Pioneer/rekordbox/master.db (skipped)`,
      `traktor: no collection at ${home}/c.nml (skipped)`,
    ]);
    mkdirSync(join(home, 'Library/Pioneer/rekordbox'), { recursive: true });
    writeFileSync(join(home, 'Library/Pioneer/rekordbox/master.db'), 'x');
    writeFileSync(join(home, 'c.nml'), 'x');
    expect(activeApps(c, null).apps).toEqual(['rekordbox', 'music', 'traktor']);
    expect(appKeys(c, ['rekordbox', 'music'])).toEqual(['rekordbox:db', 'music']);
  });

  it('xml mode needs no master.db; picking a disabled app is an error', () => {
    const c = cfg({ rekordbox: 'xml', music: false });
    expect(activeApps(c, null)).toEqual({ apps: ['rekordbox'], skipped: [] });
    expect(() => activeApps(c, ['music'])).toThrow(/music is not enabled/);
  });

  it('only the apps being written block, and rekordbox only in db mode', () => {
    const open = { rekordbox: true, music: true, traktor: true };
    expect(blockingApps(['music'], 'off', open)).toEqual(['Music']);
    expect(blockingApps(['rekordbox', 'traktor'], 'xml', open)).toEqual(['Traktor']);
    expect(blockingApps(['rekordbox', 'music', 'traktor'], 'db', open)).toEqual(['rekordbox', 'Traktor', 'Music']);
    expect(blockingApps(['rekordbox', 'music'], 'db', { rekordbox: false, music: false, traktor: true })).toEqual([]);
  });
});
