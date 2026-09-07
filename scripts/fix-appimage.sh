#!/usr/bin/env bash
# Repack an AppImage without the libraries that must come from the host.
#
# Tauri's bundler pulls in every shared library the binary links against,
# including ones that are tightly coupled to the running system. The result
# fails to start on any distribution newer than the build machine:
#
#   Could not create surfaceless EGL display: EGL_BAD_ALLOC. Aborting...
#
# The cause is bundled libwayland-client being loaded against the host's much
# newer Mesa; glib, GStreamer and systemd have the same problem in a different
# form. See https://github.com/tauri-apps/tauri/issues/15665.
#
# Removing them makes the AppImage resolve those libraries from the host, which
# is what a portable bundle should do for anything tied to the graphics stack
# or to systemd. Everything genuinely app-specific -- WebKitGTK included --
# stays bundled.
#
# Usage: scripts/fix-appimage.sh <path-to.AppImage>
set -euo pipefail

APPIMAGE="${1:?usage: fix-appimage.sh <path-to.AppImage>}"
APPIMAGE="$(realpath "$APPIMAGE")"
[ -f "$APPIMAGE" ] || { echo "not found: $APPIMAGE" >&2; exit 1; }

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "Repacking $(basename "$APPIMAGE")"
cd "$WORKDIR"
chmod +x "$APPIMAGE"
"$APPIMAGE" --appimage-extract >/dev/null

LIBDIR="squashfs-root/usr/lib"
before=$(find "$LIBDIR" -maxdepth 1 -name '*.so*' | wc -l)

# Graphics/display stack: must match the host's Mesa and compositor.
rm -f "$LIBDIR"/libwayland-*.so*
# glib: the host's gio modules are built against the host's glib.
rm -f "$LIBDIR"/libglib-2.0.so* "$LIBDIR"/libgio-2.0.so* \
      "$LIBDIR"/libgobject-2.0.so* "$LIBDIR"/libgmodule-2.0.so*
# GStreamer: bundling it half-way breaks WebKit's media setup.
rm -f "$LIBDIR"/libgst*.so*
# systemd and friends: libmount from the host needs the host's libsystemd.
rm -f "$LIBDIR"/libsystemd.so* "$LIBDIR"/libudev.so* "$LIBDIR"/libcap.so* \
      "$LIBDIR"/liblzma.so* "$LIBDIR"/libgcrypt.so* "$LIBDIR"/libgpg-error.so*
# Low-level libraries the above pull in, which must stay consistent with them.
rm -f "$LIBDIR"/libmount.so* "$LIBDIR"/libblkid.so* "$LIBDIR"/libselinux.so* \
      "$LIBDIR"/libpcre2-8.so* "$LIBDIR"/libzstd.so* "$LIBDIR"/libelf.so* \
      "$LIBDIR"/libffi.so*

after=$(find "$LIBDIR" -maxdepth 1 -name '*.so*' | wc -l)
echo "Removed $((before - after)) host-provided libraries ($before -> $after)"

# Setting GST_PLUGIN_SYSTEM_PATH to a directory that does not exist disables
# GStreamer's own plugin search; drop it when the bundled directory is absent.
if [ ! -d "squashfs-root/usr/lib/gstreamer-1.0" ]; then
  sed -i '/^export GST_PLUGIN_SYSTEM_PATH/d' squashfs-root/apprun-hooks/*.sh 2>/dev/null || true
fi

# Repack. appimagetool is fetched on demand and cached next to the tool.
TOOL_CACHE="${APPIMAGETOOL:-$HOME/.cache/appimagetool}"
if [ ! -x "$TOOL_CACHE" ]; then
  mkdir -p "$(dirname "$TOOL_CACHE")"
  echo "Fetching appimagetool"
  curl -fsSL -o "$TOOL_CACHE" \
    "https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage"
  chmod +x "$TOOL_CACHE"
fi

# --appimage-extract-and-run avoids needing FUSE in a container or on CI.
ARCH=x86_64 "$TOOL_CACHE" --appimage-extract-and-run \
  squashfs-root "$APPIMAGE.new" >/dev/null 2>&1
mv "$APPIMAGE.new" "$APPIMAGE"
chmod +x "$APPIMAGE"
echo "Repacked $(basename "$APPIMAGE")"
