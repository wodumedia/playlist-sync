#!/usr/bin/env node
/**
 * playlist-sync: every top-level subfolder of each configured root folder becomes one playlist in rekordbox, Apple
 * Music and Traktor, inside a playlist folder named like the root.
 */
import { execFileSync } from 'node:child_process';
import { ConfigError, type Config, configPath, configWarnings, loadConfig } from './config.ts';
import { activeApps, enabledApps } from './apply.ts';
import { indexCommand } from './index.ts';
import { mirrorsStatusText } from './plan.ts';
import { openApps } from './running.ts';
import { auto, foldersCommand, lastLogLines, mirrorsCommand, readState, stagingPaths } from './tick.ts';

const LABEL = 'com.wodumedia.playlist-sync';

function usage(code: number): never {
  const out = code ? console.error : console.log;
  out(
    [
      'usage: node src/cli.ts <command>',
      '  auto [--dry-run]       one tick: write the folder playlists to the enabled apps when the folders changed and',
      '                         those apps are closed (else wait for the next tick). --dry-run prints, writes nothing.',
      '  folders [--apply] [--rekordbox] [--music] [--traktor] [--no-probe]',
      '                         the same by hand; dry run unless --apply; app flags pick among the enabled apps.',
      '  mirrors [--apply] [--rekordbox] [--music] [--traktor] [--traktor-collection <path>] [--no-probe]',
      '                         the other apps\' playlists as From rekordbox / From Music / From Traktor folders; dry',
      '                         run unless --apply. --apply --<app> writes them now and enables them in the tick',
      '                         (so does "mirrors": { "<app>": true } in the config).',
      '  status                 config, open apps, last tick state and the last 10 log lines',
      '  config-check           validate the config file',
      '  index                  dump rekordbox content ids to <staging>/index.json (optional)',
      `config: ${configPath()} (or $PLAYLIST_SYNC_CONFIG)`,
    ].join('\n'),
  );
  process.exit(code);
}

function describeConfig(c: Config): string[] {
  return [
    `config               ${c.path}`,
    `folders              ${c.folders.join(', ')}`,
    `rekordbox            ${c.rekordbox}${c.rekordbox === 'db' ? ` (${c.rekordboxDb})` : ''}`,
    `music                ${c.music ? 'on' : 'off'}`,
    `traktor              ${c.traktor.enabled ? `on (${c.traktor.collection})` : 'off'}`,
    `staging              ${c.stagingDir}`,
    `interval             every ${c.intervalMinutes} min`,
  ];
}

function agentLoaded(): boolean {
  try {
    execFileSync('launchctl', ['list', LABEL], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function status(c: Config): void {
  for (const l of describeConfig(c)) console.log(l);
  const open = openApps();
  const enabled = enabledApps(c);
  const { apps, skipped } = activeApps(c, null);
  console.log(`apps written         ${apps.join(', ') || 'none'}${enabled.length !== apps.length ? ` (${skipped.join('; ')})` : ''}`);
  console.log(
    `running              rekordbox ${open.rekordbox ? 'yes' : 'no'}, Music ${open.music ? 'yes' : 'no'}, Traktor ${open.traktor ? 'yes' : 'no'}`,
  );
  console.log(`launchd agent        ${agentLoaded() ? 'loaded' : 'not loaded'} (${LABEL})`);
  const state = readState(c);
  console.log(`mirrors              ${mirrorsStatusText(c, state, enabled)}`);
  console.log(`last tick            ${state.last_run ?? 'never'}`);
  if (state.last_result) console.log(`last result          ${state.last_result}`);
  const lines = lastLogLines(c, 10);
  console.log(`log                  ${stagingPaths(c).log}${lines.length ? '' : ' (empty)'}`);
  for (const l of lines) console.log(`  ${l}`);
}

function configCheck(c: Config): void {
  for (const l of describeConfig(c)) console.log(l);
  for (const w of configWarnings(c)) console.log(`warning: ${w}`);
  console.log('config ok');
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (!command || command === 'help' || command === '--help' || command === '-h') usage(0);
  const known = ['auto', 'folders', 'mirrors', 'status', 'config-check', 'index'];
  if (!known.includes(command)) usage(1);
  const config = loadConfig();
  if (command === 'auto') await auto(config, rest);
  else if (command === 'folders') await foldersCommand(config, rest);
  else if (command === 'mirrors') await mirrorsCommand(config, rest);
  else if (command === 'status') status(config);
  else if (command === 'config-check') configCheck(config);
  else if (command === 'index') indexCommand(config);
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : err instanceof Error ? err.message : err);
  process.exit(1);
}
