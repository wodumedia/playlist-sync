// Apple Music writer for one playlist folder.
//
//   osascript -l JavaScript src/writers/music-playlists.js <playlists.json> [--apply] [--probe] [--no-probe]
//
// A folder playlist named by the file holds one user playlist per definition. A track is found by its file location;
// a file not in the library is imported by reference (Music.add; "Copy files to Music Media folder when adding to
// library" must be off). Playlists in the folder that the file no longer lists are deleted. Nothing outside the
// folder is touched.
//
// Dry run (default) first probes whether Music copies files on add: it imports ONE file that is not in the library
// yet into a temporary playlist "playlist-sync probe". When the imported track's location is not the source path,
// the probe playlist is deleted and the script exits 2 with the reason (the library row is deleted by the caller
// with a separate osascript; the copied file is reported, never deleted). Otherwise the probe playlist is deleted (the
// imported track stays, it is in the library now) and the plan counts are printed. --no-probe skips it. An --apply
// runs the same check first, before anything is written, when given --probe (the caller passes it until the check has
// passed once). The output's `probe` is "passed" (imported by reference), "none" (no file to import, no check) or null.
//
// Incremental: each playlist's rows are read once as persistent IDs and turned into file paths through the library
// map (NFC), diffed against the wanted files by music-diff.js (loaded by text, see there), and only the rows whose
// file is not wanted are removed (from the last one back) and only the missing files added. Removing a row takes it
// out of the playlist only, never out of the library or off the disk. A file with `"music_order": "any"` only appends
// new files at the end; otherwise the rows that already match the start of the list are kept and the rest rewritten.
// When even the first row is wrong, or Music refuses a delete, the playlist is rebuilt. `rows` counts the rows added
// and removed.
//
//   osascript -l JavaScript src/writers/music-playlists.js --self-test    # loads music-diff.js and music-ready.js, never touches Music
//
// Prints ONE JSON object on stdout.

ObjC.import('Foundation');
ObjC.import('stdlib');

function readText(path) {
  const s = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null);
  if (!s || s.isNil()) throw new Error(`cannot read ${path}`);
  return ObjC.unwrap(s);
}

function fileExists(path) {
  return $.NSFileManager.defaultManager.fileExistsAtPath(path);
}

function out(obj) {
  // console.log goes to stderr in osascript; stdout gets the run() return value.
  return JSON.stringify(obj);
}

/** For the early exit: write straight to stdout, since $.exit() skips run()'s return value. */
function writeStdout(text) {
  const data = $.NSString.alloc.initWithUTF8String(`${text}\n`).dataUsingEncoding($.NSUTF8StringEncoding);
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(data);
}

/** Music reports paths in decomposed Unicode (NFD) where the playlists file has NFC: compare normalised. */
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

let STEP = 'start';

/** This script's folder, from the osascript command line (relative to the current directory when relative). */
function scriptDir() {
  const args = ObjC.deepUnwrap($.NSProcessInfo.processInfo.arguments) || [];
  const self = args.find((a) => /(^|\/)music-playlists\.js$/.test(a));
  if (!self) throw new Error('cannot find music-playlists.js on the osascript command line');
  const abs = self.startsWith('/')
    ? self
    : `${ObjC.unwrap($.NSFileManager.defaultManager.currentDirectoryPath)}/${self}`;
  return abs.replace(/\/[^/]*$/, '');
}

/** musicPlaylistDiff from music-diff.js (the same text the vitest suite runs). */
function loadDiff() {
  // A local file of this repo, evaluated as a function body (JXA has no import).
  return new Function(`${readText(`${scriptDir()}/music-diff.js`)}\nreturn musicPlaylistDiff;`)();
}

/** musicLibraryReady and musicFileTracks from music-ready.js (the same text the vitest suite runs). */
function loadReady() {
  // Same loader as loadDiff: plain text beside this script, evaluated as a function body.
  return new Function(`${readText(`${scriptDir()}/music-ready.js`)}\nreturn { musicLibraryReady, musicFileTracks };`)();
}

// biome-ignore lint/correctness/noUnusedVariables: osascript calls run(argv)
function run(argv) {
  try {
    return main(argv);
  } catch (e) {
    throw new Error(`at step "${STEP}": ${e}`);
  }
}

function main(argv) {
  const file = argv[0];
  const apply = argv.indexOf('--apply') >= 0;
  const noProbe = argv.indexOf('--no-probe') >= 0;
  const probeOnApply = argv.indexOf('--probe') >= 0;
  STEP = 'diff';
  const musicPlaylistDiff = loadDiff();
  const { musicLibraryReady, musicFileTracks } = loadReady();
  if (argv.indexOf('--self-test') >= 0) {
    // Never reaches Music: proves the diff and the library wait load, and the diff runs, inside osascript.
    const d = musicPlaylistDiff(['/a/Café.mp3', '/b.mp3', null], ['/a/Café.mp3', '/c.mp3'], false);
    const ready = typeof musicLibraryReady === 'function' && typeof musicFileTracks === 'function';
    return out({ ok: d.remove.join() === '1,2' && d.add.join() === '1' && ready, ready, diff: d });
  }
  if (!file) throw new Error('usage: osascript -l JavaScript music-playlists.js <playlists.json> [--apply]');
  const spec = JSON.parse(readText(file));
  const folderName = spec.folder;

  const Music = Application('Music');
  if (!Music.running()) Music.launch();
  // A first launch in a new account shows a welcome screen and has no library yet: wait for it (up to 30 s).
  STEP = 'library wait';
  const lib = musicLibraryReady(Music, delay, 30);

  const failed = [];

  STEP = 'library map';
  // location path -> track (file tracks of the library), built once; and back, for the playlists' rows.
  const byPath = {};
  const pathById = {};
  const { locations, ids } = musicFileTracks(lib);
  for (let i = 0; i < ids.length; i++) {
    const p = posix(locations[i]);
    if (p) {
      byPath[p] = ids[i];
      pathById[ids[i]] = p;
    }
  }
  const trackById = (pid) => lib.fileTracks.whose({ persistentID: pid })[0];

  // ---- the copy-on-add probe (dry run only) ----
  STEP = 'probe';
  let probeResult = null;
  if (apply ? probeOnApply : !noProbe) {
    probeResult = 'none';
    // The first file (in playlist order) that is on disk and not in the library yet: only an import shows a copy.
    let source = null;
    for (const p of spec.playlists) {
      const t = p.tracks.find((x) => !byPath[norm(x.path)] && fileExists(x.path));
      if (t) {
        source = norm(t.path);
        break;
      }
    }
    if (source) {
      const probe = Music.make({ new: 'userPlaylist', withProperties: { name: 'playlist-sync probe' } });
      let imported = null;
      try {
        imported = Music.add([Path(source)], { to: probe });
      } catch (e) {
        failed.push({ path: source, error: String(e) });
      }
      // Right after Music.add the location can still be null while Music copies or scans the file: poll ≤ 10 s.
      let loc = null;
      for (let i = 0; imported && !loc && i < 40; i++) {
        try {
          loc = posix(imported.location());
        } catch (_e) {
          loc = null;
        }
        if (!loc) delay(0.25);
      }
      if (imported && !loc) {
        // No location after 10 s: Music handed back a row it already had (a dead row for this file, location null,
        // left by an interrupted probe) rather than importing. Not evidence of copying; say so and stop.
        Music.delete(probe);
        writeStdout(
          out({
            ok: false,
            kind: 'no_location',
            reason: `probe import gave no location for ${source}: a dead row for this file is probably in the Music library — remove it in Music (Songs, sort by Name) and run again`,
            source,
            imported_location: null,
            leftover_database_id: imported.databaseID(),
          }),
        );
        $.exit(2);
      }
      if (imported && loc !== source) {
        // The library row cannot be removed from this process (Music.delete() on a library track is a silent no-op in
        // JXA), so its database ID is reported and the caller deletes it with a separate `osascript -e`. The copy is
        // reported, never deleted: a path that differs only in normalisation once looked like a copy.
        const databaseId = imported.databaseID();
        Music.delete(probe);
        writeStdout(
          out({
            ok: false,
            kind: 'copies',
            reason:
              'Music copies files on add — turn off Music → Settings → Files → "Copy files to Music Media folder when adding to library"',
            source,
            imported_location: loc,
            leftover_database_id: databaseId,
          }),
        );
        $.exit(2);
      }
      // `imported` is the row inside the probe playlist: read its id BEFORE the playlist goes ("Can't get object").
      const importedId = imported ? imported.persistentID() : null;
      Music.delete(probe);
      if (importedId) byPath[source] = importedId;
      probeResult = imported ? 'passed' : null;
    }
  }

  // ---- folder ----
  STEP = 'folder';
  // Music's dictionary has no `folderPlaylists` element: find the folder among playlists by name and class.
  const folders = Music.playlists
    .whose({ name: folderName })()
    .filter((p) => {
      try {
        return p.class() === 'folderPlaylist';
      } catch (_e) {
        return false;
      }
    });
  let folder = folders.length ? folders[0] : null;
  const folderExists = !!folder;
  if (!folder && apply) folder = Music.make({ new: 'folderPlaylist', withProperties: { name: folderName } });

  STEP = 'children';
  // children of our folder by name
  const children = {};
  if (folder) {
    const fid = folder.persistentID();
    for (const pl of Music.userPlaylists()) {
      let parentId = null;
      try {
        parentId = pl.parent.persistentID();
      } catch (_e) {
        parentId = null;
      }
      if (parentId === fid && !children[pl.name()]) children[pl.name()] = pl;
    }
  }

  const counts = { create: 0, update: 0, unchanged: 0, remove: 0, recreate: 0 };
  const trackCounts = { found: 0, toImport: 0, missingOnDisk: 0 };
  const rows = { added: 0, removed: 0 };
  const ordered = spec.music_order !== 'any';
  const wanted = {};

  STEP = 'playlists';
  for (const p of spec.playlists) {
    wanted[p.name] = true;
    const desired = []; // persistent IDs or {import: path}
    const wantPaths = []; // the file of each `desired` entry (NFC), for the diff
    for (const t of p.tracks) {
      if (byPath[norm(t.path)]) {
        trackCounts.found++;
        desired.push(byPath[norm(t.path)]);
        wantPaths.push(norm(t.path));
      } else if (fileExists(t.path)) {
        trackCounts.toImport++;
        desired.push({ import: t.path });
        wantPaths.push(norm(t.path));
      } else {
        trackCounts.missingOnDisk++;
      }
    }
    const pl = children[p.name] || null;
    let diff = null;
    if (pl) {
      // A row's persistent ID is its library track's: the library map gives its file (null: no file, never wanted).
      const have = pl.tracks.persistentID().map((id) => pathById[id] || null);
      diff = musicPlaylistDiff(have, wantPaths, ordered);
      if (diff.unchanged) counts.unchanged++;
      else counts.update++;
      if (!diff.unchanged && !apply) {
        rows.removed += diff.rebuild ? have.length : diff.remove.length;
        rows.added += diff.rebuild ? desired.length : diff.add.length;
      }
    } else {
      counts.create++;
      if (!apply) rows.added += desired.length;
    }
    if (apply && !diff?.unchanged) writeTracks(pl, p, desired, diff);
  }

  /** Creates the playlist, or brings it to `desired` by `diff` (music-diff.js): removes the unwanted rows and appends
   * the missing files; a `rebuild` diff empties it first. Returns the playlist. */
  function writeTracks(pl, p, desired, diff) {
    const make = () => {
      try {
        return Music.make({ new: 'userPlaylist', at: folder, withProperties: { name: p.name } });
      } catch (_e) {
        const made = Music.make({ new: 'userPlaylist', withProperties: { name: p.name } });
        Music.move(made, { to: folder });
        return made;
      }
    };
    let toAdd = desired.map((_d, j) => j);
    if (!pl) pl = make();
    else {
      const before = pl.tracks.length;
      // Rows go one at a time from the last one back: `Music.delete(pl.tracks)` removes only every other track (Music
      // renumbers the rows while deleting). A row deleted from a user playlist leaves the library and the file alone.
      const remove = diff.rebuild ? Array.from({ length: before }, (_x, i) => i) : diff.remove;
      for (let r = remove.length - 1; r >= 0; r--) {
        try {
          Music.delete(pl.tracks[remove[r]]);
        } catch (_e) {
          // counted below
        }
      }
      if (!diff.rebuild) toAdd = diff.add;
      // Some rows Music refuses to remove by any form: when the row count is not what the deletes should have left,
      // replace the playlist (a new persistent ID) and add every file.
      if (pl.tracks.length !== before - remove.length) {
        counts.recreate++;
        Music.delete(pl);
        pl = make();
        toAdd = desired.map((_d, j) => j);
      } else rows.removed += remove.length;
    }
    for (const j of toAdd) {
      const d = desired[j];
      try {
        if (typeof d === 'string') Music.duplicate(trackById(d), { to: pl });
        else {
          const added = Music.add([Path(d.import)], { to: pl });
          if (added) byPath[norm(d.import)] = added.persistentID();
        }
        rows.added++;
      } catch (e) {
        failed.push({ playlist: p.name, track: typeof d === 'string' ? d : d.import, error: String(e) });
      }
    }
    return pl;
  }

  STEP = 'remove';
  for (const name of Object.keys(children)) {
    if (wanted[name]) continue;
    counts.remove++;
    if (apply) {
      try {
        Music.delete(children[name]);
      } catch (e) {
        failed.push({ playlist: name, error: String(e) });
      }
    }
  }

  return out({
    ok: true,
    dry_run: !apply,
    folder: { exists: folderExists },
    playlists: counts,
    tracks: trackCounts,
    rows,
    failed,
    probe: probeResult,
  });
}
