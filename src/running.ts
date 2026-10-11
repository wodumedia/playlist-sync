/** Which of the apps are open (pgrep). Names as the log shows them: "rekordbox", "Music", "Traktor". */
import { execFileSync } from 'node:child_process';
import type { RekordboxMode } from './config.ts';
import type { LiveApp } from './plan.ts';

/** pgrep arguments: rekordbox and Music in THIS account only (`-U <uid>`), so a copy open in another logged-in account
 * (fast user switching) does not block this one's write. */
export function pgrepArgs(app: string, uid: number | null): string[] {
  return uid === null ? ['-x', app] : ['-x', '-U', String(uid), app];
}

export function running(app: string): boolean {
  try {
    execFileSync('pgrep', pgrepArgs(app, process.getuid?.() ?? null), { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Traktor's process is "Traktor" (Pro 3) and may carry the version (Pro 4): match the app bundle name loosely. */
export function traktorRunning(): boolean {
  try {
    const out = execFileSync('pgrep', ['-fl', 'Traktor'], { encoding: 'utf8' });
    return /\/Traktor[^/]*\.app\//.test(out) || /\sTraktor( Pro \d+)?$/m.test(out);
  } catch {
    return false;
  }
}

export interface OpenApps {
  rekordbox: boolean;
  music: boolean;
  traktor: boolean;
}

export function openApps(): OpenApps {
  return { rekordbox: running('rekordbox'), music: running('Music'), traktor: traktorRunning() };
}

/** Display names of the open apps that block a write: only the apps being written, and rekordbox only in `db` mode
 * (the XML file can be written while rekordbox runs). Music blocks too: the JXA writer drives it. */
export function blockingApps(apps: LiveApp[], rekordboxMode: RekordboxMode, open: OpenApps): string[] {
  const out: string[] = [];
  if (apps.includes('rekordbox') && rekordboxMode === 'db' && open.rekordbox) out.push('rekordbox');
  if (apps.includes('traktor') && open.traktor) out.push('Traktor');
  if (apps.includes('music') && open.music) out.push('Music');
  return out;
}
