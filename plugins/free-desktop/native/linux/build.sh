#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
case "$(uname -m)" in aarch64|arm64) target=arm64;; x86_64) target=x64;; *) echo 'Unsupported Linux architecture' >&2; exit 1;; esac
pkg-config --exists 'gtk+-3.0 >= 3.22' 'webkit2gtk-4.1 >= 2.40' json-glib-1.0 x11
pkgs='gtk+-3.0 webkit2gtk-4.1 json-glib-1.0 x11'; define=''
if pkg-config --exists 'gtk-layer-shell-0 >= 0.7.0'; then pkgs="$pkgs gtk-layer-shell-0"; define=-DDESK_LAYER_SHELL; fi
out="$root/helper-cache/linux-$target"
mkdir -p "$out"
${CC:-cc} -std=c11 -O2 $define $(pkg-config --cflags $pkgs) "$root/native/linux/main.c" -o "$out/desktop-host" $(pkg-config --libs $pkgs)
