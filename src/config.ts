/**
 * The config file: `$PLAYLIST_SYNC_CONFIG`, else `$XDG_CONFIG_HOME/playlist-sync/config.json`, else
 * `~/.config/playlist-sync/config.json`. Paths may start with `~`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const DEFAULT_TRAKTOR = '/Users/Shared/Native Instruments/Traktor Pro 3/collection.nml';
export const DEFAULT_STAGING = '~/Library/Application Support/playlist-sync';

/** The repo this file lives in (the venv and the writers sit in it). */
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const ConfigSchema = z.object({
  folders: z.array(z.string().min(1, 'a folder path is empty')).min(1, 'list at least one folder'),
  apps: z.object({
    rekordbox: z.enum(['off', 'xml', 'db']).default('off'),
    music: z.boolean().default(false),
    traktor: z
      .object({
        enabled: z.boolean().default(false),
        collection: z.string().min(1).default(DEFAULT_TRAKTOR),
      })
      .default({ enabled: false, collection: DEFAULT_TRAKTOR }),
  }),
  stagingDir: z.string().min(1).default(DEFAULT_STAGING),
  intervalMinutes: z.number().int().min(1).max(1440).default(30),
});
export type RawConfig = z.infer<typeof ConfigSchema>;

export type RekordboxMode = 'off' | 'xml' | 'db';

/** The config with every path expanded and the fixed locations of the apps' libraries. */
export interface Config {
  path: string;
  folders: string[];
  rekordbox: RekordboxMode;
  music: boolean;
  traktor: { enabled: boolean; collection: string };
  stagingDir: string;
  intervalMinutes: number;
  rekordboxDb: string;
  musicLibrary: string;
  venvPython: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function expandHome(p: string, home = homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return p;
}

export function configPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (env.PLAYLIST_SYNC_CONFIG) return resolve(expandHome(env.PLAYLIST_SYNC_CONFIG, home));
  const base = env.XDG_CONFIG_HOME ? expandHome(env.XDG_CONFIG_HOME, home) : join(home, '.config');
  return join(base, 'playlist-sync', 'config.json');
}

/** Validates already-parsed JSON; throws ConfigError with one line per problem. */
export function parseConfig(raw: unknown, path: string, home = homedir()): Config {
  const r = ConfigSchema.safeParse(raw);
  if (!r.success) {
    const lines = r.error.issues.map((i) => {
      const where = i.path.length ? i.path.join('.') : '(top level)';
      return `  ${where}: ${i.message}`;
    });
    throw new ConfigError(`${path} is not valid:\n${lines.join('\n')}`);
  }
  const c = r.data;
  const folders = c.folders.map((f) => resolve(expandHome(f, home)));
  const names = new Map<string, string>();
  for (const f of folders) {
    const name = basename(f);
    const had = names.get(name);
    if (had)
      throw new ConfigError(
        `${path} is not valid:\n  folders: "${had}" and "${f}" would both be the playlist folder "${name}"`,
      );
    names.set(name, f);
  }
  return {
    path,
    folders,
    rekordbox: c.apps.rekordbox,
    music: c.apps.music,
    traktor: { enabled: c.apps.traktor.enabled, collection: resolve(expandHome(c.apps.traktor.collection, home)) },
    stagingDir: resolve(expandHome(c.stagingDir, home)),
    intervalMinutes: c.intervalMinutes,
    rekordboxDb: join(home, 'Library', 'Pioneer', 'rekordbox', 'master.db'),
    musicLibrary: join(home, 'Music', 'Music', 'Music Library.musiclibrary'),
    venvPython: join(REPO, '.venv', 'bin', 'python'),
  };
}

export function loadConfig(path = configPath()): Config {
  if (!existsSync(path))
    throw new ConfigError(
      `no config at ${path}: copy config.example.json there (or run install.sh), or set PLAYLIST_SYNC_CONFIG`,
    );
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigError(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseConfig(raw, path);
}

/** Things that are not errors but will make an app or a folder do nothing. */
export function configWarnings(c: Config): string[] {
  const out: string[] = [];
  for (const f of c.folders) if (!existsSync(f)) out.push(`folder ${f} does not exist (skipped until it does)`);
  if (c.rekordbox === 'db') {
    if (!existsSync(c.rekordboxDb)) out.push(`rekordbox: no database at ${c.rekordboxDb} (skipped)`);
    if (!existsSync(c.venvPython)) out.push(`rekordbox: no Python venv at ${c.venvPython}: run install.sh`);
  }
  if (c.traktor.enabled && !existsSync(c.traktor.collection))
    out.push(`traktor: no collection at ${c.traktor.collection} (skipped until Traktor has made one)`);
  if (c.rekordbox === 'off' && !c.music && !c.traktor.enabled) out.push('no app is enabled: nothing is written');
  return out;
}
