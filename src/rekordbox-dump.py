#!/usr/bin/env python3
"""Dumps rekordbox's content rows, playlists and My Tags from a COPY of master.db as JSON on stdout.

    .venv/bin/python src/rekordbox-dump.py --db <copy of master.db>

Output: {"content": [{id, path, title, artist, deleted}],
         "playlists": [{id, seq, name, attribute, parent_id, smart, deleted, songs: [{content_id, track_no}]}],
         "my_tags": [{id, seq, name, attribute, parent_id, deleted, songs: [{content_id, track_no}]}]}
A playlist's attribute is 0 for a list, 1 for a folder and 4 for a smart list (a smart list has no songs); a My Tag's
is 1 for a group and 0 for a tag. parent_id is "root" at the top.

src/index.ts and src/collect-run.ts make the copy and read this. Never point it at the live file while rekordbox runs.
"""

import argparse
import json
import logging
import sys

from pyrekordbox import Rekordbox6Database


def text(value):
    return value.strip() if isinstance(value, str) else ""


def grouped(rows, key):
    """Songs by their playlist (or tag) id, deleted rows left out, in track order."""
    out = {}
    for s in rows:
        if s.rb_local_deleted:
            continue
        out.setdefault(str(getattr(s, key)), []).append(s)
    for songs in out.values():
        songs.sort(key=lambda s: (s.TrackNo or 0))
    return out


def songs_of(by_parent, pid):
    return [{"content_id": str(s.ContentID), "track_no": s.TrackNo} for s in by_parent.get(pid, [])]


def parent_of(row):
    return str(row.ParentID) if row.ParentID is not None else "root"


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", required=True, help="path to a copy of master.db")
    args = parser.parse_args()

    # pyrekordbox logs a warning when masterPlaylists6.xml is not beside the copy: harmless for reading.
    logging.getLogger("pyrekordbox").setLevel(logging.ERROR)
    db = Rekordbox6Database(path=args.db)

    content = []
    for c in db.get_content():
        content.append(
            {
                "id": str(c.ID),
                "path": text(c.FolderPath),
                "title": text(c.Title),
                "artist": text(c.ArtistName),
                "deleted": bool(c.rb_local_deleted),
            }
        )

    playlist_songs = grouped(db.get_playlist_songs(), "PlaylistID")
    playlists = []
    for p in db.get_playlist():
        pid = str(p.ID)
        smart = p.SmartList is not None or p.Attribute == 4
        playlists.append(
            {
                "id": pid,
                "seq": p.Seq,
                "name": text(p.Name),
                "attribute": p.Attribute,
                "parent_id": parent_of(p),
                "smart": bool(smart),
                "deleted": bool(p.rb_local_deleted),
                "songs": [] if smart else songs_of(playlist_songs, pid),
            }
        )

    tag_songs = grouped(db.get_my_tag_songs(), "MyTagID")
    my_tags = []
    for t in db.get_my_tag():
        tid = str(t.ID)
        my_tags.append(
            {
                "id": tid,
                "seq": t.Seq,
                "name": text(t.Name),
                "attribute": t.Attribute,
                "parent_id": parent_of(t),
                "deleted": bool(t.rb_local_deleted),
                "songs": songs_of(tag_songs, tid),
            }
        )
    db.close()
    json.dump({"content": content, "playlists": playlists, "my_tags": my_tags}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
