# playlist-sync: rules for Claude Code in this repo

playlist-sync is a free macOS tool that turns a DJ's music folders into playlists in rekordbox, Apple Music and Traktor. See `README.md` for what it does and how to install it.

## Rules

- Read `config.example.json` and `src/config.ts` for the config schema. The user's config lives at `~/.config/playlist-sync/config.json`.
- Always run `node src/cli.ts auto --dry-run` and show the user the output before any `--apply`.
- Never run a write while rekordbox, Music or Traktor is open. Ask the user to quit the app first.
- Before its first Music write the sync checks by itself whether Music copies files on add (it adds ONE song to the library). `music refused: "Copy files to Music Media folder" is on …` in the log means that setting is on: have the user turn it off, then run `node src/cli.ts folders --music` to re-check at once (the tick re-checks only once a day after a refusal). A `folders` dry run with Music on runs the same check; pass `--no-probe` to skip it.
- Never delete song files, backups, or the user's libraries.
- Never change the rekordbox mode to `db` without showing the user the warning from the README ("rekordbox: choose how it writes") and getting a yes.
- Two things are the user's own clicks. Tell them exactly where:
  - Apple Music: Music > Settings > Files > turn OFF "Copy files to Music Media folder when adding to library".
  - First real write: allow "node" to control "Music" when macOS asks (System Settings > Privacy & Security > Automation > node > Music).
- Restore from `<stagingDir>/backups/<app>-<timestamp>/` by hand, with the app closed. Do it only if the user asks.
- Tests: `npm test`.
- Keep edits to `src/` small and covered by a test.

## Useful commands

```bash
node src/cli.ts auto --dry-run       # what the next tick would do
node src/cli.ts folders --apply      # write now (after the dry run, apps closed)
node src/cli.ts status
node src/cli.ts config-check
```

Log: `<stagingDir>/playlist-sync.log`. Run the agent now: `launchctl kickstart gui/$(id -u)/com.wodumedia.playlist-sync` (never `-k`: it kills a run mid-write).
