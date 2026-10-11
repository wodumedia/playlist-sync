/** Where the sync keeps its own files, all inside `stagingDir`. */
import { join } from 'node:path';
import type { Config } from './config.ts';
import { folderSlug } from './folders.ts';
import type { LiveApp } from './plan.ts';

export const stagingPaths = (c: Config) => ({
  state: join(c.stagingDir, 'state.json'),
  lock: join(c.stagingDir, 'auto.lock'),
  log: join(c.stagingDir, 'playlist-sync.log'),
  index: join(c.stagingDir, 'index.json'),
  /** The last read of each app's own playlists (the Music read is carried from it while Music is closed). */
  collections: join(c.stagingDir, 'collections.json'),
});

export const folderFilePath = (c: Config, folderName: string) =>
  join(c.stagingDir, `folders-${folderSlug(folderName)}.json`);

/** The playlists file of one `From …` folder for one app. */
export const mirrorFilePath = (c: Config, app: LiveApp, folderName: string) =>
  join(c.stagingDir, `mirrors-${app}-${folderSlug(folderName)}.json`);
