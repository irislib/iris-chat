#!/usr/bin/env bash
# Rebuild the bundled codec with pinned upstream sources and a pinned toolchain.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
cache=${IRIS_OPUS_BUILD_DIR:-${TMPDIR:-/tmp}/iris-opus-build}
mkdir -p "$cache"
fetch() {
  local url=$1 file=$2 sha=$3
  if [ ! -f "$file" ]; then curl -fsSL "$url" -o "$file"; fi
  printf '%s  %s\n' "$sha" "$file" | shasum -a 256 -c -
}
fetch https://github.com/emscripten-core/emsdk/archive/refs/tags/4.0.15.tar.gz "$cache/emsdk.tar.gz" 35be7626493e3bd22860ee2177147f9bca3b6ff871edeab27c5b061a9ed9d23d
fetch https://downloads.xiph.org/releases/opus/opus-1.6.1.tar.gz "$cache/opus-1.6.1.tar.gz" 6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1
[ -d "$cache/emsdk-4.0.15" ] || tar -xzf "$cache/emsdk.tar.gz" -C "$cache"
[ -d "$cache/opus-1.6.1" ] || tar -xzf "$cache/opus-1.6.1.tar.gz" -C "$cache"
"$cache/emsdk-4.0.15/emsdk" install 4.0.15
"$cache/emsdk-4.0.15/emsdk" activate 4.0.15
source "$cache/emsdk-4.0.15/emsdk_env.sh"
emcmake cmake -S "$cache/opus-1.6.1" -B "$cache/build" -DCMAKE_BUILD_TYPE=Release "-DCMAKE_C_FLAGS=-ffile-prefix-map=$cache/opus-1.6.1=opus-1.6.1" -DOPUS_BUILD_PROGRAMS=OFF -DOPUS_BUILD_TESTING=OFF -DOPUS_INSTALL_PKG_CONFIG_MODULE=OFF -DOPUS_INSTALL_CMAKE_CONFIG_MODULE=OFF -DOPUS_DRED=OFF -DOPUS_OSCE=OFF -DOPUS_X86_MAY_HAVE_SSE=OFF -DOPUS_X86_MAY_HAVE_SSE2=OFF -DOPUS_X86_MAY_HAVE_SSE4_1=OFF -DOPUS_X86_MAY_HAVE_AVX2=OFF
cmake --build "$cache/build" --parallel 4
emcc "$repo/scripts/opus/call_opus.c" "$cache/build/libopus.a" -I "$cache/opus-1.6.1/include" -O3 "-ffile-prefix-map=$repo=." -s MODULARIZE=1 -s EXPORT_ES6=1 -s ENVIRONMENT=web,worker -s FILESYSTEM=0 -s ALLOW_MEMORY_GROWTH=1 -s EXPORTED_RUNTIME_METHODS='["HEAPF32","HEAPU8"]' -s EXPORTED_FUNCTIONS='["_call_init","_call_pcm","_call_packet","_call_encode","_call_decode","_call_destroy"]' -o "$repo/src/lib/opus/opus.js"
chmod 644 "$repo/src/lib/opus/opus.wasm"
cp "$cache/opus-1.6.1/COPYING" "$repo/src/lib/opus/LICENSE"
