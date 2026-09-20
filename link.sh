#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
BINARY="$DIR/kindle-sync"
TARGET="/usr/local/bin/kindle-sync"

if [ ! -f "$BINARY" ]; then
  echo "Binary not found. Building first..."
  (cd "$DIR" && bun build --compile src/cli.ts --outfile kindle-sync)
fi

ln -sf "$BINARY" "$TARGET"
echo "Linked $BINARY -> $TARGET"
