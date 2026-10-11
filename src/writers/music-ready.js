// The Apple Music writer's library wait. A plain script, not a module: music-playlists.js (JXA) and music-ready.test.ts
// both load this file's text and evaluate it with
//   new Function(`${text}\nreturn { musicLibraryReady, musicFileTracks };`)()
// so the tested code is exactly the code Music runs. No imports, no exports, ES2015 only.

/** Waits until Music's library answers (first launch in a new account shows a welcome screen and has no library yet). wait(s) sleeps s seconds. Returns library playlist 1. */
function musicLibraryReady(Music, wait, maxSeconds) {
  let last = 'no library yet';
  for (let waited = 0; ; waited++) {
    try {
      if (Music.libraryPlaylists.length > 0) {
        const lib = Music.libraryPlaylists[0];
        lib.persistentID();
        return lib;
      }
      last = 'no library yet';
    } catch (e) {
      last = String(e);
    }
    if (waited >= maxSeconds) break;
    wait(1);
  }
  throw new Error(`Music's library did not answer after ${maxSeconds} s (${last}). Open Music once as this user, finish its welcome screen (Continue / Agree, skip the Apple Music sign-in) until the library window shows, quit Music, then run this again.`);
}

/** Paths and persistent ids of every file track; an empty library gives two empty lists without asking Music for them. */
function musicFileTracks(lib) {
  const fileTracks = lib.fileTracks;
  if (fileTracks.length === 0) return { locations: [], ids: [] };
  return { locations: fileTracks.location(), ids: fileTracks.persistentID() };
}
