#!/usr/bin/env bash
# Copies the Three.js build + jsm addons out of node_modules into the renderer
# so the Tauri webview can import them with a relative importmap.
# Run this after `npm install` and before `npm run build`.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="node_modules/three"
DEST="src/renderer/vendor/three"

if [ ! -d "$SRC" ]; then
  echo "three not found in node_modules — run 'npm install' first." >&2
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$SRC/build" "$DEST/build"
cp -r "$SRC/examples/jsm" "$DEST/jsm"
echo "Vendored Three.js into $DEST"
