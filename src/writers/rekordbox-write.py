#!/usr/bin/env python3
"""Writes one playlist folder into rekordbox's master.db.

    .venv/bin/python src/writers/rekordbox-write.py --db <master.db> --playlists <folders-x.json> [--apply]

Only the root playlist folder named by the file and the playlists inside it are touched: the folder is created when
missing, one playlist per definition, songs replaced when their ordered content IDs differ, playlists in the folder
that the file no longer lists are deleted, and the playlists are ordered as the file lists them. Cues, My Tags and
every other playlist are never written. Without --apply nothing is created, changed or committed: the counts are
what --apply would do. rekordbox must be closed (pyrekordbox's commit() refuses while it runs; it also bumps the
USNs and keeps masterPlaylists6.xml in step). Prints ONE JSON object on stdout.

A track rekordbox does not have yet (when the file says `rekordbox_add_files: true`) is added to the collection with
`add_content` and its NFC path (rekordbox's own FolderPaths are NFC), when the file is on disk, not 0 bytes and of a
type rekordbox takes (mp3, m4a incl. ALAC, flac, wav, aif/aiff); rekordbox analyses it when it next opens. Existing
rows are matched by NFC-normalised FolderPath on both sides, so a file is never added twice and a second --apply adds
nothing. `contents_added_by_playlist` names where rows are (or would be) added; `files_skipped` counts the rest by
reason with a few examples.
"""

import argparse
import json
import logging
import os
import sys
import unicodedata

from pyrekordbox import Rekordbox6Database
from pyrekordbox.db6 import tables

FOLDER_ATTRIBUTE = 1

# File types pyrekordbox's add_content takes (its FileType enum); ALAC sits in .m4a.
ADDABLE_EXTENSIONS = {".mp3", ".m4a", ".flac", ".wav", ".aif", ".aiff"}
SKIP_EXAMPLES = 5


def nfc(s):
    return unicodedata.normalize("NFC", s)


def content_paths(db):
    """{NFC FolderPath: content ID} for every content row (the first row wins for a path held twice)."""
    out = {}
    for cid, path in db.query(tables.DjmdContent.ID, tables.DjmdContent.FolderPath).all():
        if path:
            out.setdefault(nfc(path), str(cid))
    return out


def resolve(db, track, by_path):
    """The DjmdContent row for a playlist track: by id, else by NFC path. None when rekordbox has neither."""
    content = None
    cid = str(track.get("content_id") or "").strip()
    if cid:
        content = db.get_content(ID=cid)
    if content is None and track.get("path"):
        hit = by_path.get(nfc(track["path"]))
        if hit is not None:
            content = db.get_content(ID=hit)
    return content


def skip_reason(path):
    """Why a file cannot be added to the collection, or None when it can."""
    if os.path.splitext(path)[1].lower() not in ADDABLE_EXTENSIONS:
        return "unsupported"
    if not os.path.isfile(path):
        return "not_on_disk"
    if os.path.getsize(path) == 0:
        return "empty"
    return None


def plan_order(current, wanted):
    """Seq moves that turn `current` (names in Seq order) into `wanted` (names in file order): (moves, final order).
    Each move puts wanted[i] at position i, the way move_playlist(seq=i+1) does."""
    sim = [n for n in current if n in set(wanted)]
    sim += [n for n in wanted if n not in sim]
    moves = []
    for i, name in enumerate(wanted):
        if sim[i] != name:
            sim.remove(name)
            sim.insert(i, name)
            moves.append((name, i + 1))
    return moves, sim


def current_ids(playlist):
    songs = sorted(playlist.Songs, key=lambda s: s.TrackNo or 0)
    return [str(s.ContentID) for s in songs]


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", required=True)
    parser.add_argument("--playlists", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    apply = args.apply

    logging.getLogger("pyrekordbox").setLevel(logging.ERROR)
    with open(args.playlists, encoding="utf-8") as fh:
        spec = json.load(fh)
    folder_name = spec["folder"]

    db = Rekordbox6Database(path=args.db)
    result = {
        "folder": {"created": False},
        "playlists": {"created": 0, "updated": 0, "unchanged": 0, "removed": 0},
        "tracks": {"linked": 0, "missing": 0},
        "contents_added": 0,
        "contents_added_by_playlist": {},
        "files_skipped": {"unsupported": 0, "not_on_disk": 0, "empty": 0, "examples": []},
        "order": {"first": None, "moves": 0},
        "missing": [],
        "dry_run": not apply,
        "xml": db.playlist_xml is not None,
    }

    folders = [
        p for p in db.get_playlist(Name=folder_name, Attribute=FOLDER_ATTRIBUTE).all() if str(p.ParentID) == "root"
    ]
    folder = folders[0] if folders else None
    if folder is None:
        result["folder"]["created"] = True
        if apply:
            folder = db.create_playlist_folder(folder_name)

    existing = {}
    if folder is not None:
        for child in db.get_playlist(ParentID=folder.ID).all():
            existing.setdefault(child.Name, child)

    add_files = bool(spec.get("rekordbox_add_files"))
    by_path = content_paths(db)
    wanted_names = set()
    to_add = set()
    for p in spec["playlists"]:
        name = p["name"]
        wanted_names.add(name)
        desired = []
        for t in p["tracks"]:
            content = resolve(db, t, by_path)
            if content is None and add_files and t.get("path"):
                path = nfc(t["path"])
                reason = skip_reason(path)
                if reason:
                    skipped = result["files_skipped"]
                    skipped[reason] += 1
                    if len(skipped["examples"]) < SKIP_EXAMPLES:
                        skipped["examples"].append({"reason": reason, "path": path})
                elif path in to_add:
                    # Already added (or to be added) for an earlier track: one row per file.
                    result["tracks"]["linked"] += 1
                    desired.append(db.get_content(ID=by_path[path]) if apply else None)
                    continue
                else:
                    to_add.add(path)
                    result["contents_added"] += 1
                    per = result["contents_added_by_playlist"]
                    per[name] = per.get(name, 0) + 1
                    result["tracks"]["linked"] += 1
                    if apply:
                        content = db.add_content(path, Title=t.get("title") or None)
                        by_path[path] = str(content.ID)
                        desired.append(content)
                    else:
                        desired.append(None)
                    continue
            if content is None:
                result["tracks"]["missing"] += 1
                result["missing"].append({"playlist": name, "content_id": t.get("content_id"), "path": t.get("path")})
            else:
                result["tracks"]["linked"] += 1
                desired.append(content)
        desired_ids = [str(c.ID) if c is not None else "new" for c in desired]

        playlist = existing.get(name)
        if playlist is None:
            result["playlists"]["created"] += 1
            if apply:
                playlist = db.create_playlist(name, parent=folder)
                for i, content in enumerate(desired):
                    db.add_to_playlist(playlist, content, track_no=i + 1)
        elif current_ids(playlist) == desired_ids:
            result["playlists"]["unchanged"] += 1
        else:
            result["playlists"]["updated"] += 1
            if apply:
                for song in sorted(playlist.Songs, key=lambda s: s.TrackNo or 0, reverse=True):
                    db.remove_from_playlist(playlist, song)
                for i, content in enumerate(desired):
                    db.add_to_playlist(playlist, content, track_no=i + 1)

    for name, child in existing.items():
        if name not in wanted_names:
            result["playlists"]["removed"] += 1
            if apply:
                db.delete_playlist(child)

    # The playlists in the folder as the file lists them. Other rows in the folder keep their places after ours.
    order = [p["name"] for p in spec["playlists"]]
    result["order"]["first"] = order[0] if order else None
    if folder is not None:
        db.flush()
        children = sorted(db.get_playlist(ParentID=folder.ID).all(), key=lambda c: c.Seq or 0)
        current = [c.Name for c in children]
    else:
        current = []
    moves, _final = plan_order(current, order)
    result["order"]["moves"] = len(moves)
    if apply and folder is not None:
        for name, seq in moves:
            pl = db.get_playlist(ParentID=folder.ID, Name=name).first()
            if pl is not None and pl.Seq != seq:
                db.move_playlist(pl, seq=seq)

    if apply:
        db.commit()
    else:
        db.rollback()
    db.close()
    json.dump(result, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
