/**
 * Playlists moving between apps: the shapes every step agrees on. Each app's own playlists are read into
 * **collections** with ONE origin app (rekordbox, Apple Music or Traktor); the other apps get them as copies inside a
 * `From <origin>` playlist folder. Track identity across apps is the file path (NFC, symlinks resolved).
 *
 * `<stagingDir>/collections.json` keeps the last read per origin (`CollectionsInboundFile`), so a Music read can be
 * carried while Music is closed (Music can only be read while it runs). The "hub" is built in memory on every run
 * from that file (`hubCollections`). Pure schemas and rules, no I/O.
 */
import { z } from 'zod';

export const COLLECTION_ORIGINS = ['rekordbox', 'music', 'traktor'] as const;
export const CollectionOriginSchema = z.enum(COLLECTION_ORIGINS);
export type CollectionOrigin = z.infer<typeof CollectionOriginSchema>;

/** `playlist` = an ordinary list; `tag` = a rekordbox My Tag (copied as a playlist elsewhere); `smart` = a rule-based
 * list, read by name only (its rules live in the origin app) and never copied. */
export const CollectionKindSchema = z.enum(['playlist', 'tag', 'smart']);
export type CollectionKind = z.infer<typeof CollectionKindSchema>;

/** The playlist folder each origin's copies go into, in every other app. Never read as an origin. */
export const MIRROR_FOLDERS = {
  rekordbox: 'From rekordbox',
  music: 'From Music',
  traktor: 'From Traktor',
} as const satisfies Record<CollectionOrigin, string>;

/** One track as its origin app lists it. `path` is the absolute POSIX path (NFC), or null when the origin has no
 * file for it (an Apple Music catalogue item, a rekordbox row that is not an audio file). `content_id` is rekordbox's
 * own id when the origin is rekordbox. */
export const CollectionTrackSchema = z.object({
  path: z.string().nullable().default(null),
  /** macOS volume name (Traktor's LOCATION VOLUME) when the origin knows it. */
  volume: z.string().default(''),
  content_id: z.string().nullable().default(null),
  title: z.string().default(''),
  artist: z.string().default(''),
});
export type CollectionTrack = z.infer<typeof CollectionTrackSchema>;

/** A collection as read from ONE origin. */
export const InboundCollectionSchema = z.object({
  /** The origin's own id: rekordbox's playlist id (`tag:<id>` for a My Tag), Music's persistent ID, Traktor's node
   * path joined with ` / `. */
  origin_id: z.string().min(1),
  name: z.string().min(1),
  /** Folder chain within the origin, outermost first (a My Tag's group, Music or Traktor folders). Empty at the root. */
  group: z.array(z.string()).default([]),
  kind: CollectionKindSchema.default('playlist'),
  tracks: z.array(CollectionTrackSchema).default([]),
});
export type InboundCollection = z.infer<typeof InboundCollectionSchema>;

export const InboundOriginSchema = z.object({
  read_at: z.string(),
  collections: z.array(InboundCollectionSchema).default([]),
});
export type InboundOrigin = z.infer<typeof InboundOriginSchema>;

/** `<stagingDir>/collections.json`: what each origin held when it was last read. An absent origin was not read. */
export const CollectionsInboundFileSchema = z.object({
  version: z.literal(1),
  generated_at: z.string(),
  origins: z
    .object({
      rekordbox: InboundOriginSchema.optional(),
      music: InboundOriginSchema.optional(),
      traktor: InboundOriginSchema.optional(),
    })
    .default({}),
});
export type CollectionsInboundFile = z.infer<typeof CollectionsInboundFileSchema>;

/** A collection in the hub: the inbound fields plus its origin and a stable id. */
export interface Collection extends InboundCollection {
  /** `<origin>:<origin_id>`. */
  id: string;
  origin: CollectionOrigin;
}

const ORIGIN_ORDER: Record<CollectionOrigin, number> = { rekordbox: 0, music: 1, traktor: 2 };

function compareCollections(a: Collection, b: Collection): number {
  const byOrigin = ORIGIN_ORDER[a.origin] - ORIGIN_ORDER[b.origin];
  if (byOrigin) return byOrigin;
  const ga = a.group.join('\u0000').toLowerCase();
  const gb = b.group.join('\u0000').toLowerCase();
  if (ga !== gb) return ga < gb ? -1 : 1;
  const na = a.name.toLowerCase();
  const nb = b.name.toLowerCase();
  if (na !== nb) return na < nb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The hub, in memory: every origin's collections with their ids, a collection whose outermost folder is in
 * `skipFolders` dropped (matched trimmed, case-insensitively), a repeated id kept once (the first copy), sorted by
 * origin, folder chain and name.
 */
export function hubCollections(inbound: CollectionsInboundFile | null, skipFolders: Iterable<string>): Collection[] {
  const skip = new Set([...skipFolders].map((f) => f.trim().toLowerCase()).filter(Boolean));
  const out: Collection[] = [];
  for (const origin of COLLECTION_ORIGINS) {
    const read = inbound?.origins[origin];
    if (!read) continue;
    const seen = new Set<string>();
    for (const c of read.collections) {
      if (skip.has((c.group[0] ?? '').trim().toLowerCase())) continue;
      const id = `${origin}:${c.origin_id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ ...c, id, origin });
    }
  }
  return out.sort(compareCollections);
}
