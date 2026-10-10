#!/bin/bash
#
# playlist-sync uninstaller (macOS)
#
# Stops the background job and removes its launchd file. That is all.
# Your music, your playlists, your music libraries, your settings and your
# backups are left exactly where they are.

set -euo pipefail

LABEL="com.wodumedia.playlist-sync"
LAUNCH_TARGET="gui/$(id -u)/$LABEL"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$HOME/.config/playlist-sync/config.json"

# The staging folder (where a running sync holds its lock): from the settings file, else the default.
STAGING_DIR="$HOME/Library/Application Support/playlist-sync"
if command -v node >/dev/null 2>&1 && [ -f "$CONFIG_FILE" ]; then
  s="$(node -e 'const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const p = c.stagingDir || ""; console.log(p.replace(/^~(?=\/|$)/, require("os").homedir()));' "$CONFIG_FILE" 2>/dev/null || true)"
  if [ -n "$s" ]; then STAGING_DIR="$s"; fi
fi

printf '\n== Stopping the background job ==\n'
# Never stop a run in the middle of a write: wait until its lock is gone (a lock older than 2 hours is a crashed run's).
LOCK_DIR="$STAGING_DIR/auto.lock"
lock_held() {
  [ -d "$LOCK_DIR" ] && [ -z "$(find "$LOCK_DIR" -maxdepth 0 -mmin +120 2>/dev/null)" ]
}
waited=0
while lock_held && [ "$waited" -lt 600 ]; do
  if [ "$waited" -eq 0 ]; then echo "A sync run is in progress; waiting for it to finish..."; fi
  sleep 5
  waited=$((waited + 5))
done
if lock_held; then
  echo "A sync run still holds $LOCK_DIR after 10 minutes. Nothing was changed; run uninstall.sh again later." >&2
  exit 1
fi
if launchctl print "$LAUNCH_TARGET" >/dev/null 2>&1; then
  if launchctl bootout "$LAUNCH_TARGET" >/dev/null 2>&1; then
    echo "Stopped."
  else
    echo "Could not stop it cleanly; it will not start again after you log out and in."
  fi
else
  echo "It was not running. Nothing to stop."
fi

printf '\n== Removing the job file ==\n'
if [ -f "$PLIST_DEST" ]; then
  rm -f "$PLIST_DEST"
  echo "Removed $PLIST_DEST"
else
  echo "No job file at $PLIST_DEST. Nothing to remove."
fi

printf '\n== Left in place ==\n'
cat <<EOF
playlist-sync will no longer run. These were NOT touched:

  Your music folders and song files
  Your playlists already created in rekordbox, Apple Music and Traktor
  Your settings:                 $CONFIG_FILE
  Logs and library backups:      $STAGING_DIR
  This program's folder:         $REPO_DIR

The backups of your libraries are in that staging folder. Keep them for a while.

To remove the rest by hand, once you are sure you no longer need it:

  Settings:     rm -r ~/.config/playlist-sync
  Logs/backups: rm -r "$STAGING_DIR"
  Program:      drag the folder "$REPO_DIR" to the Trash

To use playlist-sync again later, run install.sh in the program folder.
EOF
