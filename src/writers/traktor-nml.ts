/**
 * Splices a playlist folder into a real Traktor `collection.nml`. Pure text surgery, no I/O: everything outside the
 * spots it touches stays byte-identical:
 *   1. `<COLLECTION ENTRIES="N">`: a `traktorCollectionEntry` is appended before `</COLLECTION>` for every playlist
 *      track whose KEY (VOLUME + DIR + FILE) is not there yet, N bumped;
 *   2. our folder (`<NODE TYPE="FOLDER" NAME="<file.folder>">`, a direct child of `$ROOT`) is replaced whole, or
 *      appended to `$ROOT`'s `<SUBNODES COUNT="M">` with M bumped when absent.
 * Existing entries (cues, beatgrids, analysis) and every other playlist are never rewritten.
 */
import type { PlaylistsFile, PlaylistTrack } from '../library.ts';
import { escapeXmlAttr as esc, fnv1a } from './xml.ts';

export interface TraktorLocation {
  VOLUME: string;
  DIR: string;
  FILE: string;
  /** Traktor's primary key: VOLUME + DIR + FILE. */
  KEY: string;
}

/**
 * Traktor's LOCATION form. DIR is the folder relative to the volume root, every segment prefixed "/:" and a trailing
 * "/:". For `/Volumes/<name>/rest` the root is `/Volumes/<name>`; any other path is relative to `/`.
 */
export function traktorLocation(path: string, volume: string): TraktorLocation {
  let rel = path;
  const m = /^\/Volumes\/[^/]+(\/.*)$/.exec(path);
  if (m) rel = m[1]!;
  const segments = rel.split('/').filter((s) => s !== '');
  const file = segments.pop() ?? '';
  const DIR = segments.length ? `${segments.map((s) => `/:${s}`).join('')}/:` : '/:';
  return { VOLUME: volume, DIR, FILE: file, KEY: `${volume}${DIR}${file}` };
}

/** Deterministic 32 lowercase hex characters from a seed (four FNV-1a passes). */
export function playlistUuid(seed: string): string {
  const seeds = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b];
  let out = '';
  let prev = 0;
  for (const s of seeds) {
    prev = fnv1a(`${seed}\u0000${prev}`, s);
    out += prev.toString(16).padStart(8, '0');
  }
  return out;
}

/** One `<ENTRY>` for the NML `<COLLECTION>`. */
export function traktorCollectionEntry(track: PlaylistTrack): string {
  const loc = traktorLocation(track.path, track.volume);
  return (
    `<ENTRY TITLE="${esc(track.title)}" ARTIST="${esc(track.artist)}">` +
    `<LOCATION DIR="${esc(loc.DIR)}" FILE="${esc(loc.FILE)}" VOLUME="${esc(loc.VOLUME)}" VOLUMEID="${esc(loc.VOLUME)}"></LOCATION>` +
    `</ENTRY>`
  );
}

/** The folder node alone, for splicing into a real collection.nml. */
export function traktorPlaylistsFolderNode(file: PlaylistsFile): string {
  const nodes = file.playlists.map((p) => {
    const entries = p.tracks
      .map(
        (t) =>
          `<ENTRY><PRIMARYKEY TYPE="TRACK" KEY="${esc(traktorLocation(t.path, t.volume).KEY)}"></PRIMARYKEY></ENTRY>`,
      )
      .join('\n');
    return (
      `<NODE TYPE="PLAYLIST" NAME="${esc(p.name)}">\n` +
      `<PLAYLIST ENTRIES="${p.tracks.length}" TYPE="LIST" UUID="${playlistUuid(p.slug)}">\n${entries}${entries ? '\n' : ''}</PLAYLIST>\n` +
      `</NODE>`
    );
  });
  return (
    `<NODE TYPE="FOLDER" NAME="${esc(file.folder)}">\n<SUBNODES COUNT="${file.playlists.length}">\n` +
    `${nodes.join('\n')}${nodes.length ? '\n' : ''}</SUBNODES>\n</NODE>`
  );
}

export interface TraktorSplice {
  nml: string;
  addedEntries: number;
  existingEntries: number;
  replacedFolder: boolean;
  playlists: number;
  tracks: number;
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED[body.toLowerCase()] ?? match;
  });
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
    out[m[1]!] = decode(m[2] ?? m[3] ?? '');
  return out;
}

/** Replaces the first `NAME="<number>"` inside `tag`. */
function bumpAttr(tag: string, name: string, by: number): string {
  const re = new RegExp(`(\\b${name}=")(\\d+)(")`);
  if (!re.test(tag)) throw new Error(`collection.nml: <${tag.slice(1, 20)}…> has no ${name}="…"`);
  return tag.replace(re, (_, a: string, n: string, b: string) => `${a}${Number(n) + by}${b}`);
}

export function spliceTraktorCollection(nml: string, file: PlaylistsFile): TraktorSplice {
  // ---- collection ----
  const collOpen = /<COLLECTION\b[^>]*>/.exec(nml);
  if (!collOpen) throw new Error('collection.nml has no <COLLECTION> element: not a Traktor collection');
  const collStart = collOpen.index;
  const collBodyStart = collStart + collOpen[0].length;
  const collEnd = nml.indexOf('</COLLECTION>', collBodyStart);
  if (collEnd < 0) throw new Error('collection.nml: <COLLECTION> is not closed');

  const existing = new Set<string>();
  for (const m of nml.slice(collBodyStart, collEnd).matchAll(/<LOCATION\b([^>]*)>/g)) {
    const a = attrs(m[1]!);
    existing.add(`${a.VOLUME ?? ''}${a.DIR ?? ''}${a.FILE ?? ''}`);
  }
  const existingEntries = existing.size;

  const added: string[] = [];
  let tracks = 0;
  for (const p of file.playlists) {
    for (const t of p.tracks) {
      tracks++;
      const key = traktorLocation(t.path, t.volume).KEY;
      if (existing.has(key)) continue;
      existing.add(key);
      added.push(traktorCollectionEntry(t));
    }
  }

  // ---- playlists ----
  const playlistsAt = nml.indexOf('<PLAYLISTS>', collEnd);
  if (playlistsAt < 0)
    throw new Error('collection.nml has no <PLAYLISTS> section: open it in Traktor once first');
  const rootRe = /<NODE\b[^>]*>/g;
  rootRe.lastIndex = playlistsAt;
  let root: RegExpExecArray | null = null;
  for (let m = rootRe.exec(nml); m; m = rootRe.exec(nml)) {
    if (attrs(m[0]).NAME === '$ROOT') {
      root = m;
      break;
    }
  }
  if (!root) throw new Error('collection.nml: no $ROOT playlist folder under <PLAYLISTS>');
  const subRe = /<SUBNODES\b[^>]*>/y;
  subRe.lastIndex = root.index + root[0].length;
  // Traktor writes `<SUBNODES …>` straight after the $ROOT node tag; tolerate whitespace between.
  const ws = /^\s*/.exec(nml.slice(subRe.lastIndex))![0].length;
  subRe.lastIndex += ws;
  const sub = subRe.exec(nml);
  if (!sub) throw new Error('collection.nml: $ROOT has no <SUBNODES>');
  const subStart = sub.index;
  const subBodyStart = subStart + sub[0].length;

  // Balanced scan of $ROOT's children: depth counts NODE elements; </SUBNODES> at depth 0 closes $ROOT's list.
  const tokenRe = /<\/NODE>|<NODE\b[^>]*>|<\/SUBNODES>/g;
  tokenRe.lastIndex = subBodyStart;
  let depth = 0;
  let folderStart = -1;
  let folderEnd = -1;
  let subEnd = -1;
  let candidate = -1;
  for (let m = tokenRe.exec(nml); m; m = tokenRe.exec(nml)) {
    const tok = m[0];
    if (tok === '</SUBNODES>') {
      if (depth === 0) {
        subEnd = m.index;
        break;
      }
    } else if (tok === '</NODE>') {
      depth--;
      if (depth === 0) {
        if (candidate >= 0 && folderStart < 0) {
          folderStart = candidate;
          folderEnd = m.index + tok.length;
        }
        candidate = -1;
      }
      if (depth < 0) throw new Error('collection.nml: unbalanced <NODE> elements under $ROOT');
    } else {
      const selfClosing = tok.endsWith('/>');
      if (depth === 0) {
        const a = attrs(tok);
        candidate = a.TYPE === 'FOLDER' && a.NAME === file.folder && !selfClosing ? m.index : -1;
      }
      if (!selfClosing) depth++;
    }
  }
  if (subEnd < 0) throw new Error('collection.nml: $ROOT <SUBNODES> is not closed');

  const folderNode = traktorPlaylistsFolderNode(file);
  const replacedFolder = folderStart >= 0;

  // ---- assemble (back to front keeps earlier offsets valid) ----
  let out = nml;
  if (replacedFolder) {
    out = out.slice(0, folderStart) + folderNode + out.slice(folderEnd);
  } else {
    out = out.slice(0, subEnd) + folderNode + out.slice(subEnd);
    out = out.slice(0, subStart) + bumpAttr(sub[0], 'COUNT', 1) + out.slice(subBodyStart);
  }
  if (added.length) {
    out = `${out.slice(0, collEnd)}${added.join('\n')}\n${out.slice(collEnd)}`;
    out = out.slice(0, collStart) + bumpAttr(collOpen[0], 'ENTRIES', added.length) + out.slice(collBodyStart);
  }

  return {
    nml: out,
    addedEntries: added.length,
    existingEntries,
    replacedFolder,
    playlists: file.playlists.length,
    tracks,
  };
}
