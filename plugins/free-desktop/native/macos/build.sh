#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
machine=${ENEST_DESKTOP_ARCH:-$(uname -m)}
case "$machine" in arm64) target=arm64; arch=arm64;; x64|x86_64) target=x64; arch=x86_64;; *) echo 'Unsupported macOS architecture' >&2; exit 1;; esac
out="$root/helper-cache/darwin-$target"
mkdir -p "$out"
xcrun clang -arch "$arch" -mmacosx-version-min=12.0 -fobjc-arc -O2 -framework Cocoa -framework WebKit -framework CoreGraphics "$root/native/macos/main.m" -o "$out/desktop-host"
/usr/bin/codesign --force --sign - "$out/desktop-host"
