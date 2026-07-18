#!/usr/bin/env python3
import os
import shutil
import sqlite3
import tarfile
from datetime import UTC, datetime
from pathlib import Path


UPLOAD_DIR = Path(os.getenv("MMSERVER_UPLOAD_DIR", "/home/des/Desktop/mymservertest"))
DB_PATH = Path(os.getenv("MMSERVER_DB_PATH", str(UPLOAD_DIR / "mymserver.sqlite3")))
BACKUP_DIR = Path(os.getenv("MMSERVER_BACKUP_DIR", str(UPLOAD_DIR.parent / "mymservertest_backups")))
KEEP_BACKUPS = int(os.getenv("MMSERVER_KEEP_BACKUPS", "48"))


def backup_sqlite(target: Path) -> None:
    source = sqlite3.connect(DB_PATH)
    try:
        destination = sqlite3.connect(target)
        try:
            source.backup(destination)
        finally:
            destination.close()
    finally:
        source.close()


def archive_uploads(target: Path) -> None:
    uploads = UPLOAD_DIR / "rentas_tijuana_applications"
    with tarfile.open(target, "w:gz") as archive:
        if uploads.exists():
            archive.add(uploads, arcname="rentas_tijuana_applications")


def prune_old_backups() -> None:
    entries = sorted(
        BACKUP_DIR.glob("rentas_tijuana_*"),
        key=lambda item: item.stat().st_mtime,
        reverse=True,
    )
    for item in entries[KEEP_BACKUPS * 2:]:
        if item.is_file():
            item.unlink()


def main() -> None:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    db_backup = BACKUP_DIR / f"rentas_tijuana_db_{stamp}.sqlite3"
    files_backup = BACKUP_DIR / f"rentas_tijuana_files_{stamp}.tar.gz"
    backup_sqlite(db_backup)
    archive_uploads(files_backup)
    prune_old_backups()
    print(db_backup)
    print(files_backup)


if __name__ == "__main__":
    main()
