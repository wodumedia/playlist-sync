/**
 * The two files the steps hand each other: the library index (rekordbox content ids by path, optional, written by
 * `index`) and the playlists file (one playlist folder, read by every writer).
 */
import { z } from 'zod';

/** One audio file rekordbox knows (a `djmdContent` row). */
export const LibraryTrackSchema = z.object({
  /** rekordbox djmdContent.ID (digits, kept as a string). */
  id: z.string().min(1),
  /** Absolute POSIX path, symlinks resolved, NFC. */
  path: z.string().min(1),
  /** macOS volume name, for Traktor's LOCATION VOLUME. */
  volume: z.string().default(''),
  artist: z.string().default(''),
  title: z.string().default(''),
  /** False = the file is not on disk. */
  exists: z.boolean().default(true),
});
export type LibraryTrack = z.infer<typeof LibraryTrackSchema>;

/** `<staging>/index.json`. */
export const LibraryIndexSchema = z.object({
  version: z.literal(1),
  source: z.literal('rekordbox'),
  generated_at: z.string(),
  db_modified_at: z.string().nullable().default(null),
  tracks: z.array(LibraryTrackSchema),
});
export type LibraryIndex = z.infer<typeof LibraryIndexSchema>;

export const PlaylistTrackSchema = z.object({
  index: z.number().int(),
  n: z.number().int(),
  /** rekordbox content id, '' when the index does not know the file (rekordbox then finds or adds it by path). */
  content_id: z.string(),
  path: z.string(),
  volume: z.string(),
  artist: z.string(),
  title: z.string(),
});
export type PlaylistTrack = z.infer<typeof PlaylistTrackSchema>;

export const PlaylistDefinitionSchema = z.object({
  slug: z.string(),
  name: z.string(),
  tracks: z.array(PlaylistTrackSchema),
});
export type PlaylistDefinition = z.infer<typeof PlaylistDefinitionSchema>;

/** `<staging>/folders-<slug>.json`: one playlist folder, as every writer reads it. */
export const PlaylistsFileSchema = z.object({
  version: z.literal(1),
  generated_at: z.string(),
  index_generated_at: z.string().nullable(),
  /** The playlist folder in the apps; nothing outside it is ever written. */
  folder: z.string(),
  /** `any`: the Music writer appends new files at the end instead of keeping the file's order. Absent = ordered. */
  music_order: z.literal('any').optional(),
  /** rekordbox-write.py adds a file rekordbox does not have to its collection. */
  rekordbox_add_files: z.literal(true).optional(),
  playlists: z.array(PlaylistDefinitionSchema),
});
export type PlaylistsFile = z.infer<typeof PlaylistsFileSchema>;

export const totalTracks = (file: PlaylistsFile): number =>
  file.playlists.reduce((n, p) => n + p.tracks.length, 0);
