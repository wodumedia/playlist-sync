/**
 * Reads Traktor's own playlists from collection.nml as collections. Pure text parsing, no I/O.
 *
 * Walks `<PLAYLISTS>` → `$ROOT` → the NODE tree. FOLDER nodes give the `group` (outermost first, `$ROOT` left out); a
 * PLAYLIST node is a collection whose `origin_id` is its node path joined with ` / ` (Traktor has no stable playlist
 * id: UUIDs change when a list is re-created); a SMARTLIST node is a `smart` collection with no tracks. Each
 * `<PRIMARYKEY TYPE="TRACK" KEY="…">` becomes a track: the KEY is the LOCATION's VOLUME + DIR + FILE turned back into
 * a path (VOLUME equal to the boot volume → `/`, any other → `/Volumes/<VOLUME>/`; `/:` → `/`), with the TITLE and
 * ARTIST of the matching `<COLLECTION>` ENTRY when there is one, else the file name as the title.
 *
 * Skipped: Traktor's own lists at the top level whose names start with `_` (`_LOOPS`, `_RECORDINGS`, made by the loop
 * and mix recorders).
 */
import type { CollectionTrack, InboundCollection } from '../collections.ts';

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

/** Traktor's own top-level lists (loop recorder, mix recorder): never collections. */
const TRAKTOR_OWN_RE = /^_/;

/** A PRIMARYKEY KEY (VOLUME + DIR + FILE) → `{ path, volume }`: the inverse of the writer's `traktorLocation`. */
export function traktorKeyToPath(key: string, bootVolume: string): { path: string; volume: string } {
  const i = key.indexOf('/:');
  if (i < 0) return { path: '', volume: key };
  const volume = key.slice(0, i);
  const rel = key.slice(i).replaceAll('/:', '/');
  const prefix = volume === bootVolume || volume === '' ? '' : `/Volumes/${volume}`;
  return { path: `${prefix}${rel}`.normalize('NFC'), volume };
}

interface EntryTags {
  title: string;
  artist: string;
}

/** COLLECTION ENTRYs by KEY (from their LOCATION), with their title and artist. */
function collectionTags(nml: string): { byKey: Map<string, EntryTags>; entries: number } {
  const byKey = new Map<string, EntryTags>();
  const open = /<COLLECTION\b[^>]*>/.exec(nml);
  if (!open) return { byKey, entries: 0 };
  const start = open.index + open[0].length;
  const endAt = nml.indexOf('</COLLECTION>', start);
  const body = nml.slice(start, endAt < 0 ? undefined : endAt);
  let entries = 0;
  for (const m of body.matchAll(/<ENTRY\b([^>]*)>([\s\S]*?)<\/ENTRY>/g)) {
    entries++;
    const e = attrs(m[1]!);
    const locTag = /<LOCATION\b([^>]*)>/.exec(m[2]!);
    if (!locTag) continue;
    const loc = attrs(locTag[1]!);
    byKey.set(`${loc.VOLUME ?? ''}${loc.DIR ?? ''}${loc.FILE ?? ''}`, {
      title: (e.TITLE ?? '').trim(),
      artist: (e.ARTIST ?? '').trim(),
    });
  }
  return { byKey, entries };
}

function fileTitle(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Every playlist and smart list of a Traktor collection.nml (see the header for the rules). `entries` = the
 * COLLECTION's ENTRY count. */
export function parseTraktorPlaylists(
  nml: string,
  opts: { bootVolume: string },
): { playlists: InboundCollection[]; entries: number } {
  const { byKey, entries } = collectionTags(nml);
  const playlists: InboundCollection[] = [];
  const startAt = nml.indexOf('<PLAYLISTS>');
  if (startAt < 0) return { playlists, entries };
  const endAt = nml.indexOf('</PLAYLISTS>', startAt);
  const section = nml.slice(startAt, endAt < 0 ? undefined : endAt);

  interface Frame {
    type: string;
    name: string;
    collection: InboundCollection | null;
  }
  const stack: Frame[] = [];
  for (const m of section.matchAll(/<(\/?)(NODE|PRIMARYKEY)\b([^>]*?)(\/?)>/g)) {
    const closing = m[1] === '/';
    const tag = m[2]!;
    if (tag === 'NODE' && closing) {
      stack.pop();
      continue;
    }
    const a = attrs(m[3]!);
    if (tag === 'PRIMARYKEY') {
      const owner = stack.at(-1)?.collection;
      if (owner?.kind !== 'playlist' || a.TYPE !== 'TRACK' || !a.KEY) continue;
      const { path, volume } = traktorKeyToPath(a.KEY, opts.bootVolume);
      const tags = byKey.get(a.KEY);
      const track: CollectionTrack = {
        path: path || null,
        volume,
        content_id: null,
        title: tags?.title || fileTitle(path),
        artist: tags?.artist ?? '',
      };
      owner.tracks.push(track);
      continue;
    }
    const type = a.TYPE ?? '';
    const name = (a.NAME ?? '').trim();
    const frame: Frame = { type, name, collection: null };
    // The path below $ROOT: folders, then this node.
    const chain = stack.filter((f, i) => !(i === 0 && f.name === '$ROOT')).map((f) => f.name);
    const atTop = chain.length === 0;
    if ((type === 'PLAYLIST' || type === 'SMARTLIST') && name && !(atTop && TRAKTOR_OWN_RE.test(name))) {
      frame.collection = {
        origin_id: [...chain, name].join(' / '),
        name,
        group: chain,
        kind: type === 'SMARTLIST' ? 'smart' : 'playlist',
        tracks: [],
      };
      playlists.push(frame.collection);
    }
    if (m[4] !== '/') stack.push(frame);
  }
  return { playlists, entries };
}
