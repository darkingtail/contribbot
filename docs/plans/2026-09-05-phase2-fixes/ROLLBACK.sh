#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:?usage: ROLLBACK.sh <target-copy>}"
BACKUP="${TARGET}.baseline"

if [[ ! -f "$BACKUP" ]]; then
  echo "Missing rollback baseline: $BACKUP" >&2
  exit 1
fi

cp "$BACKUP" "$TARGET"
echo "Restored $TARGET from $BACKUP"
