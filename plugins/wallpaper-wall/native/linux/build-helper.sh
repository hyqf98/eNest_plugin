#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel
out="../../helper-cache/linux-x64"
mkdir -p "$out"
cp "build/wallpaper-host" "$out/wallpaper-host"
chmod +x "$out/wallpaper-host"
printf '{"version":"0.0.1","protocolVersion":1,"target":"linux-x64"}\n' > "$out/helper.json"
echo "Built $out/wallpaper-host"
