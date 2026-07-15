#!/usr/bin/env sh
set -eu

if [ -z "${MONGODB_URI:-}" ]; then
  echo "MONGODB_URI is required." >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-backups/mongodump}"
STAMP="$(date +%Y%m%d-%H%M%S)"
TARGET="$BACKUP_DIR/$STAMP"

mkdir -p "$TARGET"
mongodump --uri="$MONGODB_URI" --out="$TARGET"
tar -czf "$TARGET.tar.gz" -C "$BACKUP_DIR" "$STAMP"
rm -rf "$TARGET"

echo "$TARGET.tar.gz"
