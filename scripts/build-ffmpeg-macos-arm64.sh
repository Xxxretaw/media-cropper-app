#!/usr/bin/env bash

set -euo pipefail

FFMPEG_VERSION="8.1.2"
FFMPEG_SHA256="464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c"
DEPLOYMENT_TARGET="11.0"
TARGET_TRIPLE="aarch64-apple-darwin"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SCRIPT_PATH="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"

BUILD_ROOT="${1:-${FFMPEG_BUILD_ROOT:-/tmp/media-cropper-ffmpeg-${FFMPEG_VERSION}-lgpl-arm64}}"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "This script must run on an Apple Silicon Mac." >&2
  exit 1
fi

mkdir -p "$BUILD_ROOT"
BUILD_ROOT="$(cd "$BUILD_ROOT" && pwd -P)"

case "$BUILD_ROOT" in
  /|/tmp|"$HOME")
    echo "Refusing unsafe build root: $BUILD_ROOT" >&2
    exit 1
    ;;
esac

for tool in curl make shasum tar xcrun; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Required tool not found: $tool" >&2
    exit 1
  fi
done

ARCHIVE="$BUILD_ROOT/ffmpeg-${FFMPEG_VERSION}.tar.xz"
SOURCE_DIR="$BUILD_ROOT/source"
OBJECT_DIR="$BUILD_ROOT/objects"
INSTALL_DIR="$BUILD_ROOT/install"
PACKAGE_DIR="$BUILD_ROOT/package"
TEST_DIR="$BUILD_ROOT/verification"
SOURCE_URL="https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"

if [[ ! -f "$ARCHIVE" ]]; then
  curl --fail --location --retry 3 --connect-timeout 20 \
    --output "$ARCHIVE" "$SOURCE_URL"
fi

ACTUAL_SHA256="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
if [[ "$ACTUAL_SHA256" != "$FFMPEG_SHA256" ]]; then
  echo "FFmpeg source checksum mismatch." >&2
  echo "Expected: $FFMPEG_SHA256" >&2
  echo "Actual:   $ACTUAL_SHA256" >&2
  exit 1
fi

rm -rf "$SOURCE_DIR" "$OBJECT_DIR" "$INSTALL_DIR" "$PACKAGE_DIR" "$TEST_DIR"
mkdir -p \
  "$SOURCE_DIR" \
  "$OBJECT_DIR" \
  "$INSTALL_DIR" \
  "$PACKAGE_DIR/licenses" \
  "$PACKAGE_DIR/source" \
  "$TEST_DIR"
tar -xJf "$ARCHIVE" -C "$SOURCE_DIR" --strip-components=1

export MACOSX_DEPLOYMENT_TARGET="$DEPLOYMENT_TARGET"

cd "$OBJECT_DIR"
"$SOURCE_DIR/configure" \
  --prefix="$INSTALL_DIR" \
  --arch=arm64 \
  --target-os=darwin \
  --cc='xcrun clang' \
  --disable-debug \
  --disable-doc \
  --disable-ffplay \
  --disable-autodetect \
  --disable-shared \
  --enable-static \
  --enable-ffmpeg \
  --enable-ffprobe \
  --enable-pthreads \
  --enable-videotoolbox \
  --enable-audiotoolbox \
  --enable-avfoundation \
  --enable-securetransport \
  --enable-iconv \
  --enable-zlib \
  --enable-bzlib \
  --extra-cflags="-arch arm64 -mmacosx-version-min=${DEPLOYMENT_TARGET}" \
  --extra-ldflags="-arch arm64 -mmacosx-version-min=${DEPLOYMENT_TARGET}" \
  --extra-libs=-liconv

JOBS="$(sysctl -n hw.logicalcpu 2>/dev/null || echo 4)"
make -j"$JOBS"
make install

FFMPEG="$INSTALL_DIR/bin/ffmpeg"
FFPROBE="$INSTALL_DIR/bin/ffprobe"

install -m 0755 "$FFMPEG" "$PACKAGE_DIR/ffmpeg-${TARGET_TRIPLE}"
install -m 0755 "$FFPROBE" "$PACKAGE_DIR/ffprobe-${TARGET_TRIPLE}"
install -m 0644 "$SOURCE_DIR/LICENSE.md" "$PACKAGE_DIR/licenses/FFmpeg-LICENSE.md"
install -m 0644 "$SOURCE_DIR/COPYING.LGPLv2.1" "$PACKAGE_DIR/licenses/COPYING.LGPLv2.1"
install -m 0644 "$SOURCE_DIR/COPYING.LGPLv3" "$PACKAGE_DIR/licenses/COPYING.LGPLv3"
install -m 0644 "$ARCHIVE" "$PACKAGE_DIR/source/ffmpeg-${FFMPEG_VERSION}.tar.xz"
install -m 0755 "$SCRIPT_PATH" "$PACKAGE_DIR/build-ffmpeg-macos-arm64.sh"
if [[ -f "$SCRIPT_DIR/../THIRD_PARTY_NOTICES.md" ]]; then
  install -m 0644 "$SCRIPT_DIR/../THIRD_PARTY_NOTICES.md" "$PACKAGE_DIR/THIRD_PARTY_NOTICES.md"
fi

FFMPEG="$PACKAGE_DIR/ffmpeg-${TARGET_TRIPLE}"
FFPROBE="$PACKAGE_DIR/ffprobe-${TARGET_TRIPLE}"

require_listing_entry() {
  local listing="$1"
  local name="$2"
  if ! grep -Eq "[[:space:]]${name}[[:space:]]" <<<"$listing"; then
    echo "Required FFmpeg component missing: $name" >&2
    exit 1
  fi
}

for program in "$FFMPEG" "$FFPROBE"; do
  if ! file "$program" | grep -q "Mach-O 64-bit executable arm64"; then
    echo "Built program is not an arm64 Mach-O executable: $program" >&2
    exit 1
  fi

  if ! xcrun vtool -show-build "$program" | grep -Eq "minos[[:space:]]+${DEPLOYMENT_TARGET}"; then
    echo "Incorrect minimum macOS version in $program" >&2
    exit 1
  fi

  if otool -L "$program" | grep -Eq '/opt/homebrew|/usr/local/(opt|Cellar)'; then
    echo "Homebrew runtime dependency found in $program" >&2
    otool -L "$program" >&2
    exit 1
  fi
done

if ! "$FFMPEG" -hide_banner -L | grep -q "GNU Lesser General Public"; then
  echo "The resulting FFmpeg binary is not LGPL." >&2
  exit 1
fi

CONFIGURATION="$($FFMPEG -version 2>&1 | grep '^configuration:')"
if grep -Eq -- '--enable-(gpl|nonfree|version3)' <<<"$CONFIGURATION"; then
  echo "GPL, nonfree, or LGPLv3-only configuration was enabled unexpectedly." >&2
  exit 1
fi

FILTERS="$($FFMPEG -hide_banner -filters 2>/dev/null)"
for component in bbox crop format metadata scale; do
  require_listing_entry "$FILTERS" "$component"
done
if grep -Eq '[[:space:]]cropdetect[[:space:]]' <<<"$FILTERS"; then
  echo "cropdetect is GPL in FFmpeg ${FFMPEG_VERSION} and must not be present in this LGPL build." >&2
  exit 1
fi

ENCODERS="$($FFMPEG -hide_banner -encoders 2>/dev/null)"
for component in aac h264_videotoolbox hevc_videotoolbox mpeg4; do
  require_listing_entry "$ENCODERS" "$component"
done

DECODERS="$($FFMPEG -hide_banner -decoders 2>/dev/null)"
for component in aac h264 hevc mpeg4; do
  require_listing_entry "$DECODERS" "$component"
done

FORMATS="$($FFMPEG -hide_banner -formats 2>/dev/null)"
for component in matroska mov mp4; do
  require_listing_entry "$FORMATS" "$component"
done

"$FFMPEG" -y -hide_banner -loglevel warning \
  -f lavfi -i 'testsrc2=size=640x360:rate=30' \
  -f lavfi -i 'sine=frequency=1000:sample_rate=48000' \
  -t 1 \
  -c:v h264_videotoolbox -allow_sw 1 -b:v 2M -pix_fmt yuv420p \
  -c:a aac -b:a 128k -movflags +faststart \
  "$TEST_DIR/h264-aac.mp4"

"$FFMPEG" -y -hide_banner -loglevel warning \
  -f lavfi -i 'testsrc2=size=320x240:rate=24' \
  -f lavfi -i 'sine=frequency=440:sample_rate=44100' \
  -t 1 -c:v mpeg4 -q:v 5 -c:a aac -b:a 96k \
  "$TEST_DIR/mpeg4-aac.mp4"

"$FFMPEG" -y -hide_banner -loglevel warning \
  -f lavfi -i 'testsrc2=size=640x360:rate=30' \
  -t 1 -an \
  -c:v hevc_videotoolbox -allow_sw 1 -b:v 2M -pix_fmt yuv420p -tag:v hvc1 \
  "$TEST_DIR/hevc.mov"

"$FFMPEG" -y -hide_banner -loglevel error \
  -i "$TEST_DIR/h264-aac.mp4" -map 0 -c copy "$TEST_DIR/h264-aac.mov"
"$FFMPEG" -y -hide_banner -loglevel error \
  -i "$TEST_DIR/h264-aac.mp4" -map 0 -c copy "$TEST_DIR/h264-aac.mkv"

for media in \
  "$TEST_DIR/h264-aac.mp4" \
  "$TEST_DIR/h264-aac.mov" \
  "$TEST_DIR/h264-aac.mkv" \
  "$TEST_DIR/mpeg4-aac.mp4" \
  "$TEST_DIR/hevc.mov"; do
  "$FFPROBE" -v error -show_entries stream=codec_name,codec_type \
    -show_entries format=format_name,duration -of json "$media" >/dev/null
  "$FFMPEG" -v error -i "$media" -f null -
done

BBOX_OUTPUT="$($FFMPEG -hide_banner -loglevel error \
  -f lavfi \
  -i 'testsrc2=size=240x160:rate=1,format=yuv420p10le,pad=320:240:40:40:black' \
  -frames:v 1 \
  -vf 'format=yuv420p,bbox=min_val=24,metadata=mode=print:file=-' \
  -f null - 2>/dev/null)"

for expected in \
  'lavfi.bbox.x1=40' \
  'lavfi.bbox.y1=40' \
  'lavfi.bbox.w=240' \
  'lavfi.bbox.h=160'; do
  if ! grep -q "$expected" <<<"$BBOX_OUTPUT"; then
    echo "LGPL bbox verification failed: $expected" >&2
    exit 1
  fi
done

"$FFMPEG" -hide_banner -loglevel error \
  -f lavfi -i 'testsrc2=size=320x240:rate=1' \
  -frames:v 1 \
  -vf 'crop=240:160:40:40,scale=120:80,metadata=mode=add:key=verification:value=ok' \
  -f null -

echo
echo "FFmpeg ${FFMPEG_VERSION} LGPL arm64 build passed all checks."
echo "Package: $PACKAGE_DIR"
echo "Source:  $ARCHIVE"
echo "SHA-256: $FFMPEG_SHA256"
echo
file "$FFMPEG" "$FFPROBE"
otool -L "$FFMPEG"
xcrun vtool -show-build "$FFMPEG"
shasum -a 256 "$FFMPEG" "$FFPROBE"
