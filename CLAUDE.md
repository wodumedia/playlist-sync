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

## Setting up for a user

When a user asks you to set up playlist-sync, do it in this order. The users are mostly DJs who are new to Terminal: use plain language and explain what each step does.

1. Check the prerequisites: `git --version`, `node -v` (must be 22.18 or newer) and, only if the user wants rekordbox `db` mode, `python3 --version`.
2. If something is missing, show the user the matching commands from the README section "Before you start" (`xcode-select --install` for git and Python 3, the Node installer from https://nodejs.org or `brew install node`) and run them only after the user says yes. `xcode-select --install` opens a window the user must click Install in and takes 5 to 10 minutes. After installing Node, re-check `node -v` in a new shell.
3. Ask, in plain language: which music folder(s) hold their music (each folder inside becomes a playlist); whether to write to Apple Music; whether to write to Traktor; which rekordbox mode (`xml`: writes a file they import in rekordbox, nothing touches their library, the safe choice; `db`: writes rekordbox's own database directly while rekordbox is closed, so playlists just appear, but it is unofficial and could damage their library; `off`: leave rekordbox alone); and how often to check (minutes, default 30).
4. For `db`, first show the user the warning from the README ("rekordbox: choose how it writes") and get an explicit yes. Only then pass `--accept-db-risk`. Never pass it on your own.
5. Run the installer without a Terminal, with the answers as flags and `--yes`. Run `./install.sh --help` for the full list. For example:

   ```bash
   ./install.sh --folders "$HOME/Music/DJ" --music yes --traktor no --rekordbox xml --interval 30 --yes
   ```

   Flags: `--folders <path>` (repeat, or separate paths with `:`), `--music yes|no`, `--traktor yes|no`, `--traktor-collection <path>`, `--rekordbox xml|db|off`, `--interval <minutes>`, `--keep-config` (use the existing settings and ask nothing), `--accept-db-risk`, `--agent yes|no`, `--yes`. If an answer is missing the script stops and names the flag.
6. Show the user the dry run the installer prints. Explain what it would add.
7. Tell the user the two Apple Music clicks (the last two bullets under Rules), if Apple Music is on.
8. Never run `folders --apply` yourself unless the user asks and rekordbox, Music and Traktor are closed.

## Useful commands

```bash
node src/cli.ts auto --dry-run       # what the next tick would do
node src/cli.ts folders --apply      # write now (after the dry run, apps closed)
node src/cli.ts status
node src/cli.ts config-check
```

Log: `<stagingDir>/playlist-sync.log`. Run the agent now: `launchctl kickstart gui/$(id -u)/com.wodumedia.playlist-sync` (never `-k`: it kills a run mid-write).
