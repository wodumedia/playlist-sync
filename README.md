# Drop it in a folder. It's in every app. 
## Apple Music <-> Rekordbox <-> Traktor

You buy a track and save it to a folder, like you always have. You don't import anything or drag it into playlists by hand.

## How it works

* Your folders are your playlists. Pick any music folder — one or several, anywhere on your Mac. Every folder inside it becomes a playlist with the same name in rekordbox, Apple Music and Traktor. Make a new folder and you get a new playlist.
* It runs every 30 minutes and when you log in. It checks your folders for anything new, and when there is something, it updates all your apps at once.
* It waits until you're finished. It never changes an app's library while you're using that app. If rekordbox, Music or Traktor is open, it waits and checks again in 30 minutes. Once they're closed, every app gets the update in one pass, so they always match.
* It's safe. It backs up each app's library before writing, only adds or rebuilds playlists, and never deletes a song file.
* Playlists move between apps too. A playlist you make in rekordbox shows up in Music and Traktor under From rekordbox. Each app gets that copy as soon as it alone is closed, without waiting for the others. *(Coming in the next release — v1 syncs folders → apps.)*

Your part: save music to the folders, and quit rekordbox, Music and Traktor when you're done. The sync does the rest.

The folders can be anywhere on the Mac (a synced cloud folder, iCloud Drive, an external drive). You choose them at install and can change them any time in `~/.config/playlist-sync/config.json`.

## Install

macOS only. You need Node 22.18 or newer ([nodejs.org](https://nodejs.org) or `brew install node`). Python 3 is needed only for rekordbox `db` mode.

```bash
git clone https://github.com/wodumedia/playlist-sync.git && cd playlist-sync && ./install.sh
```

`install.sh` asks for:

* your root folders
* Apple Music: yes or no
* Traktor: yes or no, and the path to `collection.nml`
* the rekordbox mode (see below)
* how often to check, in minutes

If `~/.config/playlist-sync/config.json` already exists it first asks whether to keep it (then it asks nothing else). It writes the config, shows you a dry run and the Apple Music steps, and only then asks to install the launchd agent `com.wodumedia.playlist-sync`, which runs at once, every N minutes and at login. To remove it: `./uninstall.sh` (it removes only the agent's plist; settings, logs and backups stay).

The config looks like this:

```json
{
  "folders": ["~/Music/DJ"],
  "apps": {
    "rekordbox": "off",
    "music": true,
    "traktor": { "enabled": false, "collection": "/Users/Shared/Native Instruments/Traktor Pro 3/collection.nml" }
  },
  "stagingDir": "~/Library/Application Support/playlist-sync",
  "intervalMinutes": 30
}
```

## rekordbox: choose how it writes

* `xml`: writes `<stagingDir>/rekordbox.xml` (one file, every root folder as its own playlist folder), even while rekordbox is open. In rekordbox, import it (Preferences > Advanced > Database > rekordbox xml) and drag the playlists in. Nothing touches your library.
* `db`: writes rekordbox's own database (`~/Library/Pioneer/rekordbox/master.db`) directly, while rekordbox is closed. Playlists just appear.
* `off`: rekordbox is left alone.

**Warning: `db` mode is unofficial. The database format is undocumented, Cloud Library Sync is untested, and a bug could damage your library. A backup of the database is kept before every write (10 kept), but keep your own backup too. Use it at your own risk.**

## What counts as a playlist

* Each subfolder of a root folder is one playlist, named after the subfolder.
* Audio files only: mp3, m4a, aif, aiff, wav, flac.
* Nested subfolders are flattened into the top folder's playlist.
* Natural order: `Release 9` comes before `Release 10`.
* Hidden files, non-audio files, 0-byte files and empty folders are skipped.
* A file sitting directly in the root folder (not in a subfolder) is ignored.
* Playlists are rebuilt from the folders. Remove a track from a folder and it leaves the playlist. The file itself is never deleted.
* In each app the playlists sit inside a playlist folder named like the root folder.
* That playlist folder is the tool's own: a playlist in it with no subfolder behind it is removed (delete a subfolder and its playlist goes). Playlists outside it are never touched.

## Apple Music

Before the first run:

1. In Music, open Settings > Files and turn **off** "Copy files to Music Media folder when adding to library". Tracks are added by reference to the files where they are. The sync checks this by itself before its first Music write: it adds ONE song that is not in the library yet and looks where Music put it. If Music copied it, nothing is written to Music, the log says `music refused: "Copy files to Music Media folder" is on — turn it off in Music > Settings > Files, then the next tick writes`, and the check runs again on the next tick (the other apps are still written). The test song stays in the library; a copy Music made is reported in the log, never deleted. After a refusal the automatic sync re-checks once a day; `node src/cli.ts folders --music` re-checks at once. Once the check has passed it is not run again. A `folders` dry run with Music on runs the same check (`--no-probe` skips it).
2. On the first real write, macOS asks to let "node" control "Music". Allow it. You can change it later in System Settings > Privacy & Security > Automation > node > Music.

After a Music write, the sync quits Music itself.

## Traktor

Writes `collection.nml`. It adds missing entries and replaces only its own playlist folder; your cues and other playlists are untouched. A backup is made first.

## Backups and safety

* It writes only while every app it writes is closed (rekordbox only in `db` mode; `xml` mode writes its file any time). Otherwise nothing is written, the log says `folders waiting: Music running` and it tries again on the next tick. A by-hand `folders --apply` refuses instead, before writing anything.
* Each app is tracked on its own: an app is written when its folders changed since its own last good write. An app that fails (or a Music `refused`) is tried again on the next tick without rewriting the others. Enabling an app, or changing the rekordbox mode, writes it on the next tick even when the folders did not change.
* Before each write, a backup goes to `<stagingDir>/backups/<app>-<timestamp>/`. The last 10 per app are kept.
  * rekordbox: `master.db`, its wal/shm files and `masterPlaylists6.xml`
  * Traktor: `collection.nml`
  * Music: the `Music Library.musiclibrary` package
* To restore, close the app and copy the backup back by hand.
* It never deletes a song file.

## By hand

Run these from the `playlist-sync` folder.

```bash
node src/cli.ts auto --dry-run      # what the next tick would do
node src/cli.ts folders             # the same by hand, dry run (add --rekordbox, --music or --traktor to pick apps)
node src/cli.ts folders --apply     # write now (every app it writes must be closed)
node src/cli.ts status              # settings, open apps, whether the agent is loaded, last run, last log lines
node src/cli.ts config-check
node src/cli.ts index               # optional, db mode's Python needed: rekordbox's own ids into <stagingDir>/index.json
```

The log is `<stagingDir>/playlist-sync.log` (the agent's own output: `<stagingDir>/launchd.log`). The automatic sync never runs `index`; without it tracks are matched by path. To run the agent now:

```bash
launchctl kickstart gui/$(id -u)/com.wodumedia.playlist-sync
```

## Set up with Claude Code

Paste this into Claude Code:

```
Set up https://github.com/wodumedia/playlist-sync for my library: read README.md and CLAUDE.md, ask me which folders and apps I use, run install.sh, then show me the dry run.
```

## Credits

Built for [DJ Peter Worth](https://www.djpeterworth.com) @ [Wodu](https://wodu.com). Free, MIT licence. Not affiliated with Pioneer DJ/AlphaTheta, Apple, or Native Instruments.
