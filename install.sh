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
#
# Run it with no options and it asks you each question. To answer up front (for
# a script, or for Claude Code, which cannot type into prompts), pass flags:
# see ./install.sh --help.

set -euo pipefail

LABEL="com.wodumedia.playlist-sync"
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

# Plain-English fixes for a missing prerequisite (for beginners).
node_help() {
  cat >&2 <<'EOF'
How to fix it:
  Install Node 22 or newer from https://nodejs.org (download the macOS installer, open it, click through),
  then open a new Terminal window and run ./install.sh again.
  If you use Homebrew you can run this instead: brew install node
EOF
}
die_node() { printf '\nERROR: %s\n' "$*" >&2; node_help; exit 1; }

# ---------------------------------------------------------------------------
# Options: answer the questions up front (non-interactive mode)
# ---------------------------------------------------------------------------

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

With no options, install.sh asks you each question. To answer up front instead
(for a script, or for Claude Code), use these options:

  --folders "<path>"         A music folder. Repeat the option, or separate paths with ":".
  --music yes|no             Write playlists to Apple Music.
  --traktor yes|no           Write playlists to Traktor.
  --traktor-collection PATH  Where Traktor's collection.nml is (found automatically if left out).
  --rekordbox xml|db|off     How to write rekordbox (see the README).
  --mirrors all|none|LIST    Copy each app's own playlists into the other apps,
                             as "From …" folders. LIST names the apps that get
                             them: music,traktor,rekordbox (comma list).
                             Only asked when two or more apps are on.
                             --yes alone means all.
  --interval MINUTES         Check for changes every N minutes, 1 to 1440.
  --keep-config              Use the settings file you already have and ask nothing.
  --accept-db-risk           Needed with --rekordbox db: you have read the README warning.
  --agent yes|no             Install the background job (default yes). "no" stops after the dry run.
  --yes                      Answer yes to "Install the background job now?" and
                             to the "From …" folders question (unless --mirrors
                             is given), and skip the Apple Music "press Return"
                             pause.
  --help                     Show this text.

When every answer comes from options (or --keep-config), nothing is read from the
keyboard, so install.sh can run without a Terminal. If some answers are missing and
there is no keyboard, it stops and lists exactly which options to add.

If a settings file already exists and you give answers, your answers replace it.

Example:
  ./install.sh --folders ~/Music/DJ --music yes --traktor no --rekordbox xml --mirrors all --interval 30 --yes
EOF
}

FLAG_FOLDERS_RAW=""
FLAG_FOLDERS=""
FLAG_MUSIC=""
FLAG_TRAKTOR=""
FLAG_TRAKTOR_COLLECTION=""
FLAG_REKORDBOX=""
FLAG_INTERVAL=""
FLAG_MIRRORS=""
FLAG_KEEP="no"
FLAG_ACCEPT_DB_RISK="no"
FLAG_AGENT="yes"
FLAG_YES="no"

# parse_yn "--option" "value"  -> $YN_VALUE is "yes" or "no"
parse_yn() {
  local lower
  lower="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"
  case "$lower" in
    y|yes) YN_VALUE="yes" ;;
    n|no)  YN_VALUE="no" ;;
    *)     die "$1 must be yes or no (you gave \"$2\"). See ./install.sh --help" ;;
  esac
}

while [ $# -gt 0 ]; do
  OPT="$1"
  shift
  INLINE=""
  HAS_INLINE="no"
  case "$OPT" in
    --*=*) INLINE="${OPT#*=}"; OPT="${OPT%%=*}"; HAS_INLINE="yes" ;;
  esac
  case "$OPT" in
    --help|-h) usage; exit 0 ;;
    --keep-config)    FLAG_KEEP="yes"; continue ;;
    --accept-db-risk) FLAG_ACCEPT_DB_RISK="yes"; continue ;;
    --yes)            FLAG_YES="yes"; continue ;;
    --folders|--music|--traktor|--traktor-collection|--rekordbox|--mirrors|--interval|--agent)
      if [ "$HAS_INLINE" = "yes" ]; then
        VALUE="$INLINE"
      elif [ $# -gt 0 ]; then
        VALUE="$1"
        shift
      else
        die "$OPT needs a value. See ./install.sh --help"
      fi
      ;;
    *) die "Unknown option \"$OPT\". See ./install.sh --help" ;;
  esac
  case "$OPT" in
    --folders)
      [ -n "$VALUE" ] || die "--folders needs a folder path."
      FLAG_FOLDERS_RAW="${FLAG_FOLDERS_RAW}${FLAG_FOLDERS_RAW:+$'\n'}$VALUE"
      ;;
    --music)  parse_yn "$OPT" "$VALUE"; FLAG_MUSIC="$YN_VALUE" ;;
    --traktor) parse_yn "$OPT" "$VALUE"; FLAG_TRAKTOR="$YN_VALUE" ;;
    --agent)  parse_yn "$OPT" "$VALUE"; FLAG_AGENT="$YN_VALUE" ;;
    --traktor-collection)
      [ -n "$VALUE" ] || die "--traktor-collection needs a file path."
      FLAG_TRAKTOR_COLLECTION="$VALUE"
      ;;
    --rekordbox)
      REK_LOWER="$(printf '%s' "$VALUE" | tr '[:upper:]' '[:lower:]')"
      case "$REK_LOWER" in
        xml|db|off) FLAG_REKORDBOX="$REK_LOWER" ;;
        *) die "--rekordbox must be xml, db or off (you gave \"$VALUE\"). See ./install.sh --help" ;;
      esac
      ;;
    --mirrors)
      MIR_LOWER="$(printf '%s' "$VALUE" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
      case "$MIR_LOWER" in
        all|none) FLAG_MIRRORS="$MIR_LOWER" ;;
        *)
          FLAG_MIRRORS=""
          for part in $(printf '%s' "$MIR_LOWER" | tr ',' ' '); do
            case "$part" in
              music|traktor|rekordbox) FLAG_MIRRORS="${FLAG_MIRRORS}${FLAG_MIRRORS:+,}$part" ;;
              *) die "--mirrors takes all, none, or a comma list of music, traktor, rekordbox (you gave \"$VALUE\"). See ./install.sh --help" ;;
            esac
          done
          [ -n "$FLAG_MIRRORS" ] || die "--mirrors needs all, none, or a comma list of music, traktor, rekordbox. See ./install.sh --help"
          ;;
      esac
      ;;
    --interval)
      case "$VALUE" in
        ""|*[!0-9]*) die "--interval must be a whole number of minutes from 1 to 1440 (you gave \"$VALUE\")." ;;
      esac
      if [ "$VALUE" -lt 1 ] || [ "$VALUE" -gt 1440 ]; then
        die "--interval must be a number from 1 to 1440 (you gave \"$VALUE\")."
      fi
      FLAG_INTERVAL="$((10#$VALUE))"
      ;;
  esac
done

# The db-mode warning is never accepted silently.
if [ "$FLAG_REKORDBOX" = "db" ] && [ "$FLAG_ACCEPT_DB_RISK" != "yes" ]; then
  die "rekordbox \"db\" mode is unofficial. rekordbox's database is not documented, Cloud Library Sync has not been tested with it, and a bug could damage your library. A backup of the database is kept before every write (10 kept), but keep your own backup too. Use it at your own risk.
If you understand this and want db mode, run install.sh again with --accept-db-risk. Otherwise use --rekordbox xml (safe) or --rekordbox off."
fi

# Every folder given must exist (the same check the questions make).
if [ -n "$FLAG_FOLDERS_RAW" ]; then
  while IFS= read -r part; do
    [ -n "$part" ] || continue
    part="$(clean_path "$part")"
    [ -n "$part" ] || continue
    if [ ! -d "$(expand_tilde "$part")" ]; then
      die "\"$part\" is not a folder that exists. Check the path you gave to --folders."
    fi
    FLAG_FOLDERS="${FLAG_FOLDERS}${FLAG_FOLDERS:+$'\n'}$part"
  done <<< "$(printf '%s\n' "$FLAG_FOLDERS_RAW" | tr ':' '\n')"
  [ -n "$FLAG_FOLDERS" ] || die "--folders needs a folder path."
fi

HAVE_ANSWER_FLAGS="no"
if [ -n "$FLAG_FOLDERS$FLAG_MUSIC$FLAG_TRAKTOR$FLAG_TRAKTOR_COLLECTION$FLAG_REKORDBOX$FLAG_MIRRORS$FLAG_INTERVAL" ]; then
  HAVE_ANSWER_FLAGS="yes"
fi
if [ "$FLAG_KEEP" = "yes" ] && [ "$HAVE_ANSWER_FLAGS" = "yes" ]; then
  die "--keep-config uses the settings you already have, so it cannot be combined with --folders, --music, --traktor, --rekordbox, --mirrors or --interval. Use one or the other."
fi

# ---------------------------------------------------------------------------
# Step 0: are we in a sensible place?
# ---------------------------------------------------------------------------

[ "$(uname -s)" = "Darwin" ] || die "playlist-sync only runs on macOS."
[ "$(id -u)" -ne 0 ] || die "Please run this as your normal user, not with sudo."

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$HOME/.config/playlist-sync"
CONFIG_FILE="$CONFIG_DIR/config.json"
PLIST_TEMPLATE="$REPO_DIR/templates/$LABEL.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
LAUNCH_TARGET="gui/$(id -u)/$LABEL"

# Without a keyboard (stdin is not a Terminal) every answer must come from the options.
# Say exactly which ones are missing instead of failing halfway.
if [ ! -t 0 ]; then
  MISSING=""
  add_missing() { MISSING="${MISSING}${MISSING:+, }$1"; }
  if [ "$FLAG_KEEP" = "yes" ]; then
    [ -f "$CONFIG_FILE" ] || die "--keep-config was given but there is no settings file at $CONFIG_FILE yet. Give your answers with --folders, --music, --traktor, --rekordbox and --interval instead."
  elif [ -f "$CONFIG_FILE" ] && [ "$HAVE_ANSWER_FLAGS" = "no" ]; then
    add_missing "--keep-config (use the settings file you already have; or give new answers with the options below)"
  else
    [ -n "$FLAG_FOLDERS" ] || add_missing '--folders "<path>"'
    [ -n "$FLAG_MUSIC" ] || add_missing "--music yes|no"
    [ -n "$FLAG_TRAKTOR" ] || add_missing "--traktor yes|no"
    [ -n "$FLAG_REKORDBOX" ] || add_missing "--rekordbox xml|db|off"
    [ -n "$FLAG_INTERVAL" ] || add_missing "--interval <minutes>"
    # The "From …" folders question is asked only when two or more apps are on (--yes answers it with all).
    if [ -z "$FLAG_MIRRORS" ] && [ "$FLAG_YES" != "yes" ]; then
      APPS_ON=0
      if [ "$FLAG_MUSIC" = "yes" ]; then APPS_ON=$((APPS_ON + 1)); fi
      if [ "$FLAG_TRAKTOR" = "yes" ]; then APPS_ON=$((APPS_ON + 1)); fi
      if [ "$FLAG_REKORDBOX" = "xml" ] || [ "$FLAG_REKORDBOX" = "db" ]; then APPS_ON=$((APPS_ON + 1)); fi
      if [ -z "$FLAG_MUSIC" ] || [ -z "$FLAG_TRAKTOR" ] || [ -z "$FLAG_REKORDBOX" ] || [ "$APPS_ON" -ge 2 ]; then
        add_missing "--mirrors all|none|music,traktor,rekordbox (which apps get \"From …\" folders; --yes means all)"
      fi
    fi
  fi
  if [ "$FLAG_AGENT" = "yes" ] && [ "$FLAG_YES" != "yes" ]; then
    add_missing "--yes (install the background job; or --agent no to stop after the dry run)"
  fi
  if [ -n "$MISSING" ]; then
    die "install.sh was not run from a Terminal window, so it cannot ask questions. Add these options and run it again: $MISSING
Run ./install.sh --help to see what each one means."
  fi
fi

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

step "Checking git"

if ! git --version >/dev/null 2>&1; then
  die "git is not installed. Run: xcode-select --install (Apple's Command Line Tools include git). Click Install in the window that opens and wait 5 to 10 minutes. Then open a new Terminal window and run ./install.sh again."
fi
say "$(git --version)"

step "Checking Node.js"

if ! command -v node >/dev/null 2>&1; then
  die_node "Node.js is not installed. playlist-sync needs Node 22.18 or newer."
fi
if ! command -v npm >/dev/null 2>&1; then
  die_node "npm was not found. It comes with Node.js, so Node is missing or not installed properly. playlist-sync needs Node 22.18 or newer."
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
  die_node "Node $NODE_VERSION is too old. playlist-sync needs Node 22.18 or newer."
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

q_folders() {
  step "Your music folders"
  say "Every folder directly inside a music folder becomes a playlist."
  say "Enter one music folder per line. Press Return on an empty line when you are done."

  FOLDERS=""
  FOLDER_COUNT=0
  while true; do
    ask "Folder" ""
    entry="$ANSWER"
    if [ -z "$entry" ]; then
      if [ "$FOLDER_COUNT" -gt 0 ]; then
        break
      fi
      say "Please type at least one folder, one per line."
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

}

q_music() {
  step "Apple Music"
  ask_yn "Write playlists to Apple Music?" "yes"
  MUSIC_ENABLED="$YN"
}

q_traktor() {
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

}

q_rekordbox() {
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

}

# The apps that are on, in the order the "From …" questions ask about them: $MIRROR_TARGETS, $MIRROR_COUNT.
mirror_targets() {
  MIRROR_TARGETS=""
  if [ "$MUSIC_ENABLED" = "yes" ]; then MIRROR_TARGETS="$MIRROR_TARGETS music"; fi
  if [ "$TRAKTOR_ENABLED" = "yes" ]; then MIRROR_TARGETS="$MIRROR_TARGETS traktor"; fi
  if [ "$REKORDBOX_MODE" = "xml" ] || [ "$REKORDBOX_MODE" = "db" ]; then MIRROR_TARGETS="$MIRROR_TARGETS rekordbox"; fi
  MIRROR_TARGETS="${MIRROR_TARGETS# }"
  MIRROR_COUNT=0
  for _ in $MIRROR_TARGETS; do MIRROR_COUNT=$((MIRROR_COUNT + 1)); done
}

app_label() {
  case "$1" in
    music) printf 'Apple Music' ;;
    traktor) printf 'Traktor' ;;
    rekordbox) printf 'rekordbox' ;;
  esac
}

from_label() {
  case "$1" in
    music) printf '"From Music"' ;;
    traktor) printf '"From Traktor"' ;;
    rekordbox) printf '"From rekordbox"' ;;
  esac
}

# The answers as "music=yes,traktor=no" ($MIRRORS_SET, written to config.json) and the names of the apps that get
# "From …" folders ($MIRRORS_ON_NAMES, for the last screen). Empty when fewer than two apps are on.
mirrors_add() {
  MIRRORS_SET="${MIRRORS_SET}${MIRRORS_SET:+,}$1=$2"
  if [ "$2" = "yes" ]; then
    MIRRORS_ON_NAMES="${MIRRORS_ON_NAMES}${MIRRORS_ON_NAMES:+, }$(app_label "$1")"
  fi
}

q_mirrors() {
  step "Playlists between the apps"
  say "Your own playlists can be copied between the apps, each app's in its own"
  say '"From …" folder. The dry run at the end shows what each app would get.'
  for app in $MIRROR_TARGETS; do
    others=""
    for other in rekordbox music traktor; do
      if [ "$other" != "$app" ]; then
        case " $MIRROR_TARGETS " in
          *" $other "*) others="${others}${others:+ / }$(from_label "$other")" ;;
        esac
      fi
    done
    say ""
    say "$(app_label "$app") can get the other apps' playlists ($others)."
    if [ "$app" = "rekordbox" ] && [ "$REKORDBOX_MODE" = "xml" ]; then
      say "They go into rekordbox.xml with the folder playlists."
    fi
    ask_yn "Copy them into $(app_label "$app")?" "yes"
    mirrors_add "$app" "$YN"
  done
}

# --mirrors all|none|<list>, or --yes alone (= all).
apply_mirrors_flags() {
  local choice="$1" app
  step "Playlists between the apps"
  for app in $MIRROR_TARGETS; do
    case "$choice" in
      all) mirrors_add "$app" "yes" ;;
      none) mirrors_add "$app" "no" ;;
      *)
        case ",$choice," in
          *",$app,"*) mirrors_add "$app" "yes" ;;
          *) mirrors_add "$app" "no" ;;
        esac
        ;;
    esac
  done
  case "$choice" in
    all|none) ;;
    *)
      for app in $(printf '%s' "$choice" | tr ',' ' '); do
        case " $MIRROR_TARGETS " in
          *" $app "*) ;;
          *) say "(--mirrors $app left out: $(app_label "$app") is not on.)" ;;
        esac
      done
      ;;
  esac
  if [ -n "$MIRRORS_ON_NAMES" ]; then
    say "The other apps' playlists go into: $MIRRORS_ON_NAMES (as \"From …\" folders)."
  else
    say "The other apps' playlists are not copied into any app."
  fi
}

q_interval() {
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
}

# Answers that came from options (see --help) are used as they are; the rest are asked.
apply_traktor_flags() {
  TRAKTOR_ENABLED="$FLAG_TRAKTOR"
  TRAKTOR_COLLECTION="$DEFAULT_TRAKTOR"
  if [ "$TRAKTOR_ENABLED" = "yes" ]; then
    if [ -n "$FLAG_TRAKTOR_COLLECTION" ]; then
      TRAKTOR_COLLECTION="$(clean_path "$FLAG_TRAKTOR_COLLECTION")"
      if [ ! -f "$(expand_tilde "$TRAKTOR_COLLECTION")" ]; then
        die "I cannot find a file at \"$TRAKTOR_COLLECTION\" (--traktor-collection). Open Traktor once so it creates its collection, or check the path."
      fi
    else
      if [ ! -f "$TRAKTOR_COLLECTION" ]; then
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
      if [ ! -f "$TRAKTOR_COLLECTION" ]; then
        die "I cannot find Traktor's collection.nml (looked for $TRAKTOR_COLLECTION). Open Traktor once so it creates its collection, then give its path with --traktor-collection, or use --traktor no."
      fi
    fi
  fi
}

ask_questions() {
  if [ -n "$FLAG_FOLDERS" ]; then
    FOLDERS="$FLAG_FOLDERS"
    step "Your music folders"
    say "Music folders:"
    printf '  %s\n' "$FOLDERS"
  else
    q_folders
  fi
  if [ -n "$FLAG_MUSIC" ]; then
    MUSIC_ENABLED="$FLAG_MUSIC"
  else
    q_music
  fi
  if [ -n "$FLAG_TRAKTOR" ]; then
    apply_traktor_flags
  else
    q_traktor
  fi
  if [ -n "$FLAG_REKORDBOX" ]; then
    REKORDBOX_MODE="$FLAG_REKORDBOX"
  else
    q_rekordbox
  fi
  MIRRORS_SET=""
  MIRRORS_ON_NAMES=""
  mirror_targets
  if [ "$MIRROR_COUNT" -lt 2 ]; then
    # A lone app has nothing to copy from: nothing is asked or set.
    if [ -n "$FLAG_MIRRORS" ] && [ "$FLAG_MIRRORS" != "none" ]; then
      say "(--mirrors left out: fewer than two apps are on, so there is nothing to copy between them.)"
    fi
  elif [ -n "$FLAG_MIRRORS" ]; then
    apply_mirrors_flags "$FLAG_MIRRORS"
  elif [ "$FLAG_YES" = "yes" ]; then
    apply_mirrors_flags "all"
  else
    q_mirrors
  fi
  if [ -n "$FLAG_INTERVAL" ]; then
    INTERVAL="$FLAG_INTERVAL"
  else
    q_interval
  fi
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
  PS_MIRRORS="$MIRRORS_SET" \
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
      mirrors: Object.fromEntries(
        e.PS_MIRRORS.split(",").filter(Boolean).map((p) => [p.split("=")[0], p.split("=")[1] === "yes"])
      ),
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
if [ -f "$CONFIG_FILE" ] && { [ "$FLAG_KEEP" = "yes" ] || [ "$HAVE_ANSWER_FLAGS" = "no" ]; }; then
  step "Your settings"
  say "A settings file already exists at $CONFIG_FILE:"
  echo "-----"
  cat "$CONFIG_FILE"
  echo "-----"
  if [ "$FLAG_KEEP" = "yes" ]; then
    YN="yes"
  else
    ask_yn "A config exists, keep it?" "yes"
  fi
  KEEP_CONFIG="$YN"
elif [ -f "$CONFIG_FILE" ]; then
  say "A settings file already exists at $CONFIG_FILE; the answers you gave on the command line replace it."
fi

if [ "$KEEP_CONFIG" = "yes" ]; then
  if [ "$FLAG_KEEP" = "yes" ]; then
    say "Keeping your settings file (--keep-config, no questions)."
  else
    say "Keeping your settings file (no questions). To change it, run install.sh again and answer no."
  fi
  REKORDBOX_MODE="$(config_value 'c.apps && c.apps.rekordbox || "off"')"
  STAGING="$(config_value 'c.stagingDir || "'"$DEFAULT_STAGING"'"')"
  INTERVAL="$(config_value 'c.intervalMinutes || '"$DEFAULT_INTERVAL")"
  MUSIC_ENABLED="$(config_value 'c.apps && c.apps.music === true ? "yes" : "no"')"
  # The kept "mirrors" setting, as names for the last screen (only apps that are on count).
  MIRRORS_ON_NAMES="$(config_value '(() => { const m = c.mirrors || {}, a = c.apps || {}, on = [];
    if (m.music === true && a.music === true) on.push("Apple Music");
    if (m.traktor === true && a.traktor && a.traktor.enabled === true) on.push("Traktor");
    if (m.rekordbox === true && (a.rekordbox === "xml" || a.rekordbox === "db")) on.push("rekordbox");
    const enabled = (a.music === true ? 1 : 0) + (a.traktor && a.traktor.enabled === true ? 1 : 0) + (a.rekordbox === "xml" || a.rekordbox === "db" ? 1 : 0);
    return enabled >= 2 && on.length >= 1 ? on.join(", ") : ""; })()')"
  case "$INTERVAL" in
    ""|*[!0-9]*) die "intervalMinutes in $CONFIG_FILE is not a whole number." ;;
  esac
else
  ask_questions
  step "Saving your settings"
  write_config
fi

# ---------------------------------------------------------------------------
# Step 3: Python, for rekordbox. "db" mode writes the database with it; both
# modes read rekordbox's own playlists with it (for the "From rekordbox" folders).
# ---------------------------------------------------------------------------

PY_ERR=""
setup_python() {
  if ! command -v python3 >/dev/null 2>&1; then
    PY_ERR="python3 was not found, and rekordbox needs it. Run: xcode-select --install (Apple's Command Line Tools include Python 3), or: brew install python. Then open a new Terminal window and run ./install.sh again."
    return 1
  fi
  if [ ! -f "$REPO_DIR/requirements.txt" ]; then
    PY_ERR="Cannot find requirements.txt in $REPO_DIR. Is the download complete?"
    return 1
  fi
  if [ ! -x "$REPO_DIR/.venv/bin/python" ]; then
    if ! python3 -m venv "$REPO_DIR/.venv"; then
      PY_ERR="Could not create the Python environment in $REPO_DIR/.venv."
      return 1
    fi
  fi
  if ! "$REPO_DIR/.venv/bin/pip" install --disable-pip-version-check -r "$REPO_DIR/requirements.txt"; then
    PY_ERR="Could not install the Python packages from requirements.txt. Check your internet connection and run install.sh again."
    return 1
  fi
  return 0
}

if [ "$REKORDBOX_MODE" = "db" ]; then
  step "Setting up Python for rekordbox database mode"
  setup_python || die "$PY_ERR"
  say "Python environment ready."
elif [ "$REKORDBOX_MODE" = "xml" ]; then
  step "Setting up Python to read your rekordbox playlists"
  if setup_python; then
    say "Python environment ready."
  else
    say "Skipped: $PY_ERR"
    say "Everything else works; only your rekordbox playlists are not copied to the other apps until Python is set up."
  fi
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

if [ "$FLAG_AGENT" = "no" ]; then
  step "The background job"
  say "Not installed (--agent no). Your settings are saved and the dry run is above."
  if [ "$MUSIC_ENABLED" = "yes" ]; then
    say "Apple Music needs two clicks of yours before the first real write: see \"Apple Music\" in the README."
  fi
  say "Run install.sh again without --agent no (or with --keep-config --yes) when you are ready."
  exit 0
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
  if [ "$FLAG_YES" = "yes" ]; then
    say "(--yes: carrying on without waiting. Do step 1 before the first real write.)"
  else
    ask "Press Return once step 1 is done" "done"
  fi
fi

# ---------------------------------------------------------------------------
# Step 6: install and start the background job
# ---------------------------------------------------------------------------

step "The background job"
say "Once installed it runs straight away, then every $INTERVAL minutes and at login, and writes"
say "what the dry run above showed to the apps (only while they are closed; backups first)."
if [ "$FLAG_YES" = "yes" ]; then
  YN="yes"
  say "Installing the background job (--yes)."
else
  ask_yn "Install the background job now?" "yes"
fi
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
if [ -n "$MIRRORS_ON_NAMES" ]; then
  cat <<EOF

The other apps' playlists go into: $MIRRORS_ON_NAMES
  (as "From …" folders, the first time each app is closed after the job runs).
To turn one off, set it to false under "mirrors" in
  $CONFIG_FILE
(if you ever ran mirrors --apply for it, also remove it from "mirror_apps" in
  $STAGING_ABS/state.json).
EOF
fi
