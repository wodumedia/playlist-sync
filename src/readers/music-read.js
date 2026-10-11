// Apple Music reader: READ-ONLY. Lists every user playlist with its tracks.
//
//   osascript -l JavaScript src/readers/music-read.js --no-launch
//   osascript -l JavaScript src/readers/music-read.js --self-test    # prints {"ok":true}, never talks to Music
//
// Prints ONE JSON object: { read_at, playlists: [{ persistent_id, name, parent_path, special_kind, smart,
// tracks: [{ persistent_id, location, title, artist }] }] }.
// Only playlists whose specialKind is "none" (no Library/Music/Purchased/Genius lists) and that are not folders;
// folders give `parent_path` (outermost first). `location` is the file's POSIX path in NFC, or null for a catalogue
// (streamed) item. With --no-launch and Music closed it prints { skipped: "Music not running" } and exits 0; the sync
// always passes --no-launch, so it never launches Music. Nothing in Music is changed.

function norm(path) {
  return typeof path === 'string' ? path.normalize('NFC') : path;
}

function posix(loc) {
  if (!loc) return null;
  try {
    return norm(loc.toString());
  } catch (_e) {
    return null;
  }
}

function out(obj) {
  // console.log goes to stderr in osascript; stdout gets the run() return value.
  return JSON.stringify(obj);
}

/** A bulk property read (`pl.tracks.name()`), or per-element reads with null for the ones that fail. */
function bulk(spec, prop, n) {
  try {
    const v = spec[prop]();
    if (Array.isArray(v) && v.length === n) return v;
  } catch (_e) {
    // fall through: e.g. `location` on a playlist that mixes file and catalogue tracks
  }
  const values = [];
  for (let i = 0; i < n; i++) {
    try {
      values.push(spec[i][prop]());
    } catch (_e) {
      values.push(null);
    }
  }
  return values;
}

const text = (v) => (typeof v === 'string' ? v.trim() : '');

// biome-ignore lint/correctness/noUnusedVariables: osascript calls run(argv)
function run(argv) {
  if (argv.indexOf('--self-test') >= 0) return out({ ok: true });
  const noLaunch = argv.indexOf('--no-launch') >= 0;
  const Music = Application('Music');
  let launched = false;
  if (!Music.running()) {
    if (noLaunch) return out({ skipped: 'Music not running' });
    Music.launch();
    launched = true;
    delay(3);
  }
  try {
    return out({ read_at: new Date().toISOString(), playlists: readAll(Music) });
  } finally {
    if (launched) {
      try {
        Music.quit();
      } catch (_e) {
        // not fatal: Music stays open
      }
    }
  }
}

function readAll(Music) {
  const ups = Music.userPlaylists;
  const names = ups.name();
  const n = names.length;
  const kinds = bulk(ups, 'specialKind', n);
  const smarts = bulk(ups, 'smart', n);
  const ids = bulk(ups, 'persistentID', n);

  /** Folder chain of one playlist, outermost first. */
  function parentPath(pl) {
    const chain = [];
    let p = pl;
    for (let depth = 0; depth < 20; depth++) {
      try {
        p = p.parent;
        const name = p.name();
        if (!name) break;
        chain.unshift(name);
      } catch (_e) {
        break;
      }
    }
    return chain;
  }

  const playlists = [];
  for (let i = 0; i < n; i++) {
    if (kinds[i] !== 'none') continue;
    const pl = ups[i];
    let cls = '';
    try {
      cls = pl.class();
    } catch (_e) {
      cls = '';
    }
    if (cls === 'folderPlaylist') continue;
    const smart = !!smarts[i];
    const tracks = pl.tracks;
    let count = 0;
    // A smart list is read by name only: its tracks are never copied.
    if (!smart) {
      try {
        count = tracks.length;
      } catch (_e) {
        count = 0;
      }
    }
    const tIds = count ? bulk(tracks, 'persistentID', count) : [];
    const locs = count ? bulk(tracks, 'location', count) : [];
    const titles = count ? bulk(tracks, 'name', count) : [];
    const artists = count ? bulk(tracks, 'artist', count) : [];
    const rows = [];
    for (let t = 0; t < count; t++) {
      rows.push({
        persistent_id: tIds[t] || '',
        location: posix(locs[t]),
        title: text(titles[t]),
        artist: text(artists[t]),
      });
    }
    playlists.push({
      persistent_id: ids[i],
      name: text(names[i]),
      parent_path: parentPath(pl),
      special_kind: kinds[i],
      smart,
      tracks: rows,
    });
  }
  return playlists;
}
