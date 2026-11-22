#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

swift build -c release
arch="$(uname -m)"
case "$arch" in
  arm64) target="darwin-arm64" ;;
  x86_64) target="darwin-x64" ;;
  *) echo "unsupported macOS arch: $arch" >&2; exit 1 ;;
esac

out="../../helper-cache/$target"
mkdir -p "$out"
cp ".build/release/WallpaperHost" "$out/wallpaper-host"
chmod +x "$out/wallpaper-host"
codesign --force --sign - "$out/wallpaper-host" >/dev/null 2>&1 || true
printf '{"version":"0.0.1","protocolVersion":1,"target":"%s"}\n' "$target" > "$out/helper.json"
echo "Built $out/wallpaper-host (ad-hoc signed; notarization is required for distribution)"
