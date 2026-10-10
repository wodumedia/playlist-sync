// The Apple Music writer's playlist diff. A plain script, not a module: src/writers/music-playlists.js (JXA) and
// tests/music-diff.test.ts both load this file's text and evaluate it with
//   new Function(`${text}\nreturn musicPlaylistDiff;`)()
// so the tested code is exactly the code Music runs. No imports, no exports, ES2015 only.

/**
 * What to change in one Music playlist so its rows become `want`.
 *
 *   have     the playlist's rows in Music's order: each row's file path, or null for a row with no file (a catalogue
 *            item, a dead row) — a null row is never wanted
 *   want     the wanted files, in order
 *   ordered  true when the order matters; false for the folder playlists, where a new file is simply appended
 *
 * Both sides are compared in NFC: macOS apps hand back NFD or NFC paths inconsistently, and a path that differs only
 * in normalisation is the same file.
 *
 * A row is kept when its file is wanted (as many rows per file as `want` has copies, first rows first); every other row
 * is removed. Unordered: the wanted files with no kept row are added at the end. Ordered: rows are only ever appended,
 * so the kept rows are trimmed to the longest run that already matches the start of `want`, everything after it is
 * removed and the rest of `want` appended. When that run is empty (the first row moved) nothing is worth keeping and
 * `rebuild` is set: the writer empties the playlist and adds every file.
 *
 * Returns { unchanged, rebuild, remove, add }: `remove` = row indexes into `have`, ascending (the writer deletes them
 * from the last one back, since Music renumbers the rows after each delete); `add` = indexes into `want`, in the order
 * to append them.
 */
// biome-ignore lint/correctness/noUnusedVariables: loaded by text into music-playlists.js and the tests
function musicPlaylistDiff(have, want, ordered) {
  const nfc = (p) => (typeof p === 'string' && p ? p.normalize('NFC') : null);
  const haveKeys = have.map(nfc);
  const wantKeys = want.map(nfc);

  // How many rows of each file are wanted; a row beyond that count is removed.
  const left = new Map();
  for (const k of wantKeys) if (k !== null) left.set(k, (left.get(k) || 0) + 1);
  const kept = []; // indexes into `have`
  const remove = [];
  for (let i = 0; i < haveKeys.length; i++) {
    const k = haveKeys[i];
    const n = k === null ? 0 : left.get(k) || 0;
    if (n > 0) {
      left.set(k, n - 1);
      kept.push(i);
    } else remove.push(i);
  }

  const add = [];
  if (!ordered) {
    // A wanted file is added once for every copy the kept rows do not cover.
    const covered = new Map();
    for (const i of kept) covered.set(haveKeys[i], (covered.get(haveKeys[i]) || 0) + 1);
    for (let j = 0; j < wantKeys.length; j++) {
      const k = wantKeys[j];
      if (k === null) continue;
      const n = covered.get(k) || 0;
      if (n > 0) covered.set(k, n - 1);
      else add.push(j);
    }
    return { unchanged: remove.length === 0 && add.length === 0, rebuild: false, remove, add };
  }

  let run = 0;
  while (run < kept.length && run < wantKeys.length && haveKeys[kept[run]] === wantKeys[run]) run++;
  for (let r = run; r < kept.length; r++) remove.push(kept[r]);
  remove.sort((a, b) => a - b);
  for (let j = run; j < wantKeys.length; j++) if (wantKeys[j] !== null) add.push(j);
  const unchanged = remove.length === 0 && add.length === 0;
  return { unchanged, rebuild: !unchanged && run === 0 && haveKeys.length > 0, remove, add };
}
