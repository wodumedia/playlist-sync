#!/usr/bin/env python3
"""Dumps rekordbox's content rows (id, path, artist, title) from a COPY of master.db as JSON on stdout.

    .venv/bin/python src/rekordbox-dump.py --db <copy of master.db>

src/index.ts makes the copy and turns this into <staging>/index.json. Never point it at the live file while rekordbox
runs.
"""

import argparse
import json
import logging
import sys

from pyrekordbox import Rekordbox6Database


def text(value):
    return value.strip() if isinstance(value, str) else ""


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
    db.close()
    json.dump({"content": content}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
