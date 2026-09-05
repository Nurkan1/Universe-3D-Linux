#!/usr/bin/env bash
# Copies the runtime JS dependencies out of node_modules into the renderer so
# the Tauri webview can import them with a relative importmap (no bundler).
#
#   - three          -> src/renderer/vendor/three
#   - @tauri-apps/api -> src/renderer/vendor/tauri
#
# Run this after `npm install`; `tauri dev` / `tauri build` invoke it via the
# beforeDevCommand / beforeBuildCommand hooks in tauri.conf.json.
set -euo pipefail
cd "$(dirname "$0")/.."

vendor() {
  local src="$1" dest="$2" name="$3"
  if [ ! -d "$src" ]; then
    echo "$name not found in node_modules — run 'npm install' first." >&2
    exit 1
  fi
  rm -rf "$dest"
  mkdir -p "$dest"
}

# --- three.js -------------------------------------------------------------
THREE_SRC="node_modules/three"
THREE_DEST="src/renderer/vendor/three"
vendor "$THREE_SRC" "$THREE_DEST" "three"
cp -r "$THREE_SRC/build" "$THREE_DEST/build"
cp -r "$THREE_SRC/examples/jsm" "$THREE_DEST/jsm"
echo "Vendored three.js into $THREE_DEST"

# --- @tauri-apps/api ------------------------------------------------------
# Only the ES module entrypoints the renderer actually imports, plus the
# internal tslib helper they depend on.
TAURI_SRC="node_modules/@tauri-apps/api"
TAURI_DEST="src/renderer/vendor/tauri"
vendor "$TAURI_SRC" "$TAURI_DEST" "@tauri-apps/api"
cp "$TAURI_SRC"/core.js "$TAURI_SRC"/event.js "$TAURI_SRC"/window.js \
   "$TAURI_SRC"/webview.js "$TAURI_SRC"/webviewWindow.js "$TAURI_SRC"/dpi.js \
   "$TAURI_SRC"/path.js "$TAURI_SRC"/image.js "$TAURI_DEST/"
mkdir -p "$TAURI_DEST/external/tslib"
cp "$TAURI_SRC/external/tslib/tslib.es6.js" "$TAURI_DEST/external/tslib/"
echo "Vendored @tauri-apps/api into $TAURI_DEST"
