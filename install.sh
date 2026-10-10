#!/bin/bash
#
# playlist-sync installer (macOS)
#
# "Drop it in a folder. It's in every app."
#
# This script asks you a few questions, writes your settings file, and installs a
# small background job (a launchd agent) that keeps your playlists in sync.
# It is safe to run again: every answer can be changed by running it once more.
#
# It never deletes a song file, and it never touches your music libraries itself.

set -euo pipefail

LABEL="com.wodumedia.playlist-sync"
DEFAULT_FOLDER_1="~/Music/Download MP3s"
DEFAULT_FOLDER_2="~/Music/Download Albums"
DEFAULT_TRAKTOR="/Users/Shared/Native Instruments/Traktor Pro 3/collection.nml"
DEFAULT_STAGING="~/Library/Application Support/playlist-sync"
DEFAULT_INTERVAL="30"

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

say()  { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
step() { printf '\n== %s ==\n' "$*"; }

# "~/Music" -> "/Users/you/Music"
expand_tilde() {
  case "$1" in
    "~")   printf '%s' "$HOME" ;;
    "~/"*) printf '%s/%s' "$HOME" "${1#"~/"}" ;;
    *)     printf '%s' "$1" ;;
  esac
}

# Tidy up a path typed or dragged into Terminal: remove surrounding quotes,
# backslashes before spaces, and trailing slashes.
clean_path() {
  printf '%s' "$1" \
    | sed -e "s/^'\(.*\)'\$/\1/" -e 's/^"\(.*\)"$/\1/' -e 's/\\\(.\)/\1/g' -e 's|\(.\)/*$|\1|'
}

# Make a value safe to use as the replacement part of a sed command that uses | as its delimiter.
sed_escape() {
  printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
}

# A path as plist XML text (& < > escaped), then made safe for the sed replacement.
plist_value() {
  sed_escape "$(printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')"
}

# ask "Question" "default"  -> answer in $ANSWER (empty input gives the default)
ask() {
  local prompt="$1" default="${2-}" reply=""
  if [ -n "$default" ]; then
    printf '%s [%s]: ' "$prompt" "$default"
  else
    printf '%s: ' "$prompt"
  fi
  if ! IFS= read -r reply; then
    echo
    die "No answer received. Please run install.sh from a Terminal window."
  fi
  reply="$(printf '%s' "$reply" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  if [ -z "$reply" ]; then
    reply="$default"
  fi
  ANSWER="$reply"
}

# ask_yn "Question" "yes|no"  -> $YN is "yes" or "no"
ask_yn() {
  local prompt="$1" default="$2" lower=""
  while true; do
    ask "$prompt (yes/no)" "$default"
    lower="$(printf '%s' "$ANSWER" | tr '[:upper:]' '[:lower:]')"
    case "$lower" in
      y|yes) YN="yes"; return 0 ;;
      n|no)  YN="no";  return 0 ;;
      *)     say "Please answer yes or no." ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# Step 0: are we in a sensible place?
# ---------------------------------------------------------------------------

[ "$(uname -s)" = "Darwin" ] || die "playlist-sync only runs on macOS."
[ "$(id -u)" -ne 0 ] || die "Please run this as your normal user, not with sudo."
[ -t 0 ] || die "install.sh asks questions, so it must be run from a Terminal window."

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$HOME/.config/playlist-sync"
CONFIG_FILE="$CONFIG_DIR/config.json"
PLIST_TEMPLATE="$REPO_DIR/templates/$LABEL.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
LAUNCH_TARGET="gui/$(id -u)/$LABEL"

# The background job does not see your shell settings, so keep the config in the
# standard place for both.
export XDG_CONFIG_HOME="$HOME/.config"
unset PLAYLIST_SYNC_CONFIG

[ -f "$REPO_DIR/src/cli.ts" ] || die "Cannot find src/cli.ts in $REPO_DIR. Is the download complete?"
[ -f "$REPO_DIR/package.json" ] || die "Cannot find package.json in $REPO_DIR. Is the download complete?"
[ -f "$PLIST_TEMPLATE" ] || die "Cannot find $PLIST_TEMPLATE. Is the download complete?"

say "playlist-sync installer"
say "Folder: $REPO_DIR"

# ---------------------------------------------------------------------------
# Step 1: Node and npm
# ---------------------------------------------------------------------------

step "Checking Node.js"

if ! command -v node >/dev/null 2>&1; then
  die "Node.js is not installed. Install version 22.18 or newer from https://nodejs.org (or run: brew install node), then run install.sh again."
fi
if ! command -v npm >/dev/null 2>&1; then
  die "npm was not found. It normally comes with Node.js: install Node 22.18 or newer from https://nodejs.org (or run: brew install node), then run install.sh again."
fi

NODE_VERSION="$(node -v)"
NODE_NUMBERS="${NODE_VERSION#v}"
NODE_MAJOR="${NODE_NUMBERS%%.*}"
NODE_REST="${NODE_NUMBERS#*.}"
NODE_MINOR="${NODE_REST%%.*}"
case "$NODE_MAJOR$NODE_MINOR" in
  *[!0-9]*|"") die "Could not understand the Node version \"$NODE_VERSION\"." ;;
esac
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 18 ]; }; then
  die "Node $NODE_VERSION is too old. playlist-sync needs 22.18 or newer. Get it from https://nodejs.org (or run: brew install node), then run install.sh again."
fi
NODE_BIN="$(command -v node)"
say "Node $NODE_VERSION found at $NODE_BIN"

step "Installing the code's dependencies (npm install)"
if ! (cd "$REPO_DIR" && npm install --no-audit --no-fund); then
  die "npm install failed. Check your internet connection and try again."
fi

# ---------------------------------------------------------------------------
# Step 2: keep the settings you have, or answer the questions
# ---------------------------------------------------------------------------

# Read one value out of the existing config file (a small JavaScript expression about "c").
config_value() {
  node -e 'const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(eval(process.argv[2]));' "$CONFIG_FILE" "$1"
}

ask_questions() {
  step "Your music folders"
  say "Every folder directly inside a music folder becomes a playlist."
  say "Enter one music folder per line. Press Return on an empty line when you are done."
  say "(Press Return straight away to use: $DEFAULT_FOLDER_1 and $DEFAULT_FOLDER_2)"

  FOLDERS=""
  FOLDER_COUNT=0
  while true; do
    ask "Folder" ""
    entry="$ANSWER"
    if [ -z "$entry" ]; then
      if [ "$FOLDER_COUNT" -gt 0 ]; then
        break
      fi
      # Nothing typed yet: offer the defaults, but only if both exist.
      defaults_ok="yes"
      for candidate in "$DEFAULT_FOLDER_1" "$DEFAULT_FOLDER_2"; do
        if [ ! -d "$(expand_tilde "$candidate")" ]; then
          warn "The folder $candidate does not exist."
          defaults_ok="no"
        fi
      done
      if [ "$defaults_ok" = "yes" ]; then
        FOLDERS="$DEFAULT_FOLDER_1"$'\n'"$DEFAULT_FOLDER_2"
        FOLDER_COUNT=2
        break
      fi
      say "Please type the folder(s) you want to use, one per line."
      continue
    fi
    entry="$(clean_path "$entry")"
    if [ ! -d "$(expand_tilde "$entry")" ]; then
      warn "\"$entry\" is not a folder that exists. Please try again."
      continue
    fi
    FOLDERS="${FOLDERS}${FOLDERS:+$'\n'}$entry"
    FOLDER_COUNT=$((FOLDER_COUNT + 1))
  done
  say "Music folders:"
  printf '  %s\n' "$FOLDERS"

  step "Apple Music"
  ask_yn "Write playlists to Apple Music?" "yes"
  MUSIC_ENABLED="$YN"

  step "Traktor"
  ask_yn "Write playlists to Traktor?" "no"
  TRAKTOR_ENABLED="$YN"
  TRAKTOR_COLLECTION="$DEFAULT_TRAKTOR"
  if [ "$TRAKTOR_ENABLED" = "yes" ]; then
    if [ ! -f "$TRAKTOR_COLLECTION" ]; then
      # Look for another Traktor version (Pro 4 and so on); the last one found is the newest.
      found=""
      for candidate in "/Users/Shared/Native Instruments/Traktor Pro "*/collection.nml; do
        if [ -f "$candidate" ]; then
          found="$candidate"
        fi
      done
      if [ -n "$found" ]; then
        TRAKTOR_COLLECTION="$found"
      fi
    fi
    while true; do
      ask "Path to Traktor's collection.nml (type 'none' to leave Traktor off)" "$TRAKTOR_COLLECTION"
      entry="$(clean_path "$ANSWER")"
      if [ "$(printf '%s' "$entry" | tr '[:upper:]' '[:lower:]')" = "none" ]; then
        TRAKTOR_ENABLED="no"
        TRAKTOR_COLLECTION="$DEFAULT_TRAKTOR"
        break
      fi
      if [ -f "$(expand_tilde "$entry")" ]; then
        TRAKTOR_COLLECTION="$entry"
        break
      fi
      warn "I cannot find a file at \"$entry\". Open Traktor once so it creates its collection, then try again."
    done
  fi

  step "rekordbox"
  REKORDBOX_MODE=""
  while [ -z "$REKORDBOX_MODE" ]; do
    cat <<'EOF'
rekordbox can be written two ways.
  1) xml  — playlist-sync writes a rekordbox.xml file; you import it in rekordbox
            (Preferences > Advanced > Database > rekordbox xml), then drag playlists in. Safe: nothing touches your library.
  2) db   — playlist-sync writes rekordbox's own database directly while rekordbox is closed, so playlists just appear.
            WARNING: this is unofficial. rekordbox's database is not documented, Cloud Library Sync has not been tested
            with it, and a bug could damage your library. A backup of the database is kept before every write
            (10 kept), but keep your own backup too. At your own risk.
  3) off  — do not write rekordbox.
EOF
    ask "Your choice (1, 2 or 3)" "1"
    choice="$(printf '%s' "$ANSWER" | tr '[:upper:]' '[:lower:]')"
    case "$choice" in
      1|xml) REKORDBOX_MODE="xml" ;;
      3|off) REKORDBOX_MODE="off" ;;
      2|db)
        ask_yn "Do you understand the risk and want rekordbox written directly?" "no"
        if [ "$YN" = "yes" ]; then
          REKORDBOX_MODE="db"
        fi
        ;;
      *) say "Please answer 1, 2 or 3." ;;
    esac
  done

  step "How often"
  INTERVAL=""
  while [ -z "$INTERVAL" ]; do
    ask "Check for changes every how many minutes?" "$DEFAULT_INTERVAL"
    case "$ANSWER" in
      ""|*[!0-9]*) say "Please type a whole number, like 30." ;;
      *)
        if [ "$ANSWER" -ge 1 ] && [ "$ANSWER" -le 1440 ]; then
          INTERVAL="$ANSWER"
        else
          say "Please type a number from 1 to 1440 (once a day)."
        fi
        ;;
    esac
  done
  STAGING="$DEFAULT_STAGING"
}

write_config() {
  mkdir -p "$CONFIG_DIR"
  CONFIG_TMP="$CONFIG_FILE.tmp.$$"
  PS_FOLDERS="$FOLDERS" \
  PS_MUSIC="$MUSIC_ENABLED" \
  PS_TRAKTOR="$TRAKTOR_ENABLED" \
  PS_TRAKTOR_PATH="$TRAKTOR_COLLECTION" \
  PS_REKORDBOX="$REKORDBOX_MODE" \
  PS_STAGING="$STAGING" \
  PS_INTERVAL="$INTERVAL" \
  node -e '
    const e = process.env;
    const cfg = {
      folders: e.PS_FOLDERS.split("\n").filter(Boolean),
      apps: {
        rekordbox: e.PS_REKORDBOX,
        music: e.PS_MUSIC === "yes",
        traktor: { enabled: e.PS_TRAKTOR === "yes", collection: e.PS_TRAKTOR_PATH }
      },
      stagingDir: e.PS_STAGING,
      intervalMinutes: Number(e.PS_INTERVAL)
    };
    console.log(JSON.stringify(cfg, null, 2));
  ' > "$CONFIG_TMP"
  mv "$CONFIG_TMP" "$CONFIG_FILE"
  say "Saved $CONFIG_FILE"
}

# Asked FIRST, so a kept config never throws away answers typed for nothing.
KEEP_CONFIG="no"
if [ -f "$CONFIG_FILE" ]; then
  step "Your settings"
  say "A settings file already exists at $CONFIG_FILE:"
  echo "-----"
  cat "$CONFIG_FILE"
  echo "-----"
  ask_yn "A config exists, keep it?" "yes"
  KEEP_CONFIG="$YN"
fi

if [ "$KEEP_CONFIG" = "yes" ]; then
  say "Keeping your settings file (no questions). To change it, run install.sh again and answer no."
  REKORDBOX_MODE="$(config_value 'c.apps && c.apps.rekordbox || "off"')"
  STAGING="$(config_value 'c.stagingDir || "'"$DEFAULT_STAGING"'"')"
  INTERVAL="$(config_value 'c.intervalMinutes || '"$DEFAULT_INTERVAL")"
  MUSIC_ENABLED="$(config_value 'c.apps && c.apps.music === true ? "yes" : "no"')"
  case "$INTERVAL" in
    ""|*[!0-9]*) die "intervalMinutes in $CONFIG_FILE is not a whole number." ;;
  esac
else
  ask_questions
  step "Saving your settings"
  write_config
fi

# ---------------------------------------------------------------------------
# Step 3: Python, only for rekordbox "db" mode
# ---------------------------------------------------------------------------

if [ "$REKORDBOX_MODE" = "db" ]; then
  step "Setting up Python for rekordbox database mode"
  if ! command -v python3 >/dev/null 2>&1; then
    die "python3 was not found. Install it (run: xcode-select --install, or brew install python), then run install.sh again."
  fi
  if [ ! -f "$REPO_DIR/requirements.txt" ]; then
    die "Cannot find requirements.txt in $REPO_DIR. Is the download complete?"
  fi
  if [ ! -x "$REPO_DIR/.venv/bin/python" ]; then
    if ! python3 -m venv "$REPO_DIR/.venv"; then
      die "Could not create the Python environment in $REPO_DIR/.venv."
    fi
  fi
  if ! "$REPO_DIR/.venv/bin/pip" install --disable-pip-version-check -r "$REPO_DIR/requirements.txt"; then
    die "Could not install the Python packages from requirements.txt. Check your internet connection and run install.sh again."
  fi
  say "Python environment ready."
fi

step "Checking your settings"
if ! (cd "$REPO_DIR" && node src/cli.ts config-check); then
  die "The settings file has a problem (see the message above). Fix it, or delete $CONFIG_FILE and run install.sh again."
fi

STAGING_ABS="$(expand_tilde "$STAGING")"
INTERVAL_SECONDS=$((INTERVAL * 60))

# ---------------------------------------------------------------------------
# Step 4: the dry run, BEFORE the background job can write anything
# ---------------------------------------------------------------------------

step "This is what the first run will do (a dry run: nothing is written)"
if ! (cd "$REPO_DIR" && node src/cli.ts auto --dry-run); then
  warn "The dry run reported a problem (see above)."
fi

# ---------------------------------------------------------------------------
# Step 5: Apple Music manual steps, also before the first real write
# ---------------------------------------------------------------------------

if [ "$MUSIC_ENABLED" = "yes" ]; then
  step "Two things to do for Apple Music"
  cat <<EOF
1) In the Music app: Music > Settings > Files, and turn OFF
   "Copy files to Music Media folder when adding to library".
   (Otherwise Music would make a second copy of every song.)
   Before its first Music write, the sync checks this by adding ONE song as a test. If Music
   copied it, Music is not written and the log says "music refused: ... is on"; turn the
   setting off and the next run writes.

2) The first time playlist-sync writes to Music, macOS may ask whether "node"
   can control "Music". Click Allow. If you missed it, open
   System Settings > Privacy & Security > Automation > node > Music
   and switch it on. Then run:

   launchctl kickstart gui/$(id -u)/$LABEL
EOF
  ask "Press Return once step 1 is done" "done"
fi

# ---------------------------------------------------------------------------
# Step 6: install and start the background job
# ---------------------------------------------------------------------------

step "The background job"
say "Once installed it runs straight away, then every $INTERVAL minutes and at login, and writes"
say "what the dry run above showed to the apps (only while they are closed; backups first)."
ask_yn "Install the background job now?" "yes"
if [ "$YN" != "yes" ]; then
  say "Not installed. Run install.sh again when you are ready."
  exit 0
fi

mkdir -p "$STAGING_ABS"
mkdir -p "$HOME/Library/LaunchAgents"

# Never stop a run in the middle of a write: wait until its lock is gone (a lock older than 2 hours is a crashed run's).
LOCK_DIR="$STAGING_ABS/auto.lock"
lock_held() {
  [ -d "$LOCK_DIR" ] && [ -z "$(find "$LOCK_DIR" -maxdepth 0 -mmin +120 2>/dev/null)" ]
}
waited=0
while lock_held && [ "$waited" -lt 600 ]; do
  [ "$waited" -eq 0 ] && say "A sync run is in progress; waiting for it to finish..."
  sleep 5
  waited=$((waited + 5))
done
if lock_held; then
  die "A sync run still holds $LOCK_DIR after 10 minutes. Run install.sh again later."
fi

# Stop an older copy first, if one is loaded, and wait until it is really gone.
if launchctl print "$LAUNCH_TARGET" >/dev/null 2>&1; then
  say "Stopping the previous background job..."
  launchctl bootout "$LAUNCH_TARGET" >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if ! launchctl print "$LAUNCH_TARGET" >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done
fi

PLIST_TMP="$PLIST_DEST.tmp.$$"
sed \
  -e "s|__HOME__|$(plist_value "$HOME")|g" \
  -e "s|__NODE__|$(plist_value "$NODE_BIN")|g" \
  -e "s|__REPO__|$(plist_value "$REPO_DIR")|g" \
  -e "s|__INTERVAL_SECONDS__|$INTERVAL_SECONDS|g" \
  -e "s|__STAGING__|$(plist_value "$STAGING_ABS")|g" \
  "$PLIST_TEMPLATE" > "$PLIST_TMP"

if grep -q '__[A-Z_]*__' "$PLIST_TMP"; then
  rm -f "$PLIST_TMP"
  die "The job template still has unfilled placeholders. Is the download complete?"
fi
if ! plutil -lint "$PLIST_TMP" >/dev/null 2>&1; then
  rm -f "$PLIST_TMP"
  die "The generated job file is not valid. Is the download complete?"
fi
mv "$PLIST_TMP" "$PLIST_DEST"
say "Wrote $PLIST_DEST"

# RunAtLoad starts the first run as soon as the job is loaded (no kickstart -k: that would kill a run mid-write).
if ! launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST" 2>/dev/null; then
  sleep 2
  if ! launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"; then
    die "Could not start the background job. Try logging out and in again, then run install.sh once more."
  fi
fi
say "Background job installed. It runs now, then every $INTERVAL minutes and when you log in."

# ---------------------------------------------------------------------------
# Step 7: wrap up
# ---------------------------------------------------------------------------

step "All done"
cat <<EOF
Log (what each run did):    $STAGING_ABS/playlist-sync.log
Background job log:         $STAGING_ABS/launchd.log
Your settings:              $CONFIG_FILE

What the next run would do: cd "$REPO_DIR" && node src/cli.ts auto --dry-run
See how things stand:       cd "$REPO_DIR" && node src/cli.ts status
Run the background job now: launchctl kickstart gui/$(id -u)/$LABEL
Change your answers:        run "$REPO_DIR/install.sh" again
Uninstall:                  "$REPO_DIR/uninstall.sh"
EOF
