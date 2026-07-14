#!/bin/bash

# Make the FFmpeg sidecars in a Tauri macOS bundle self-contained.
#
# The Homebrew FFmpeg build used by this project is dynamically linked. This
# script copies the complete non-system dependency closure into
# Contents/Frameworks, rewrites Mach-O load commands, signs the resulting app,
# and performs both static and runtime verification.

set -euo pipefail
IFS=$'\n\t'

PROGRAM_NAME="$(basename "$0")"

usage() {
  cat <<EOF
Usage:
  $PROGRAM_NAME [options] /path/to/media-cropper.app

Options:
  --output PATH        Copy the input app to PATH and process the copy.
                       PATH must not already exist. Without this option the
                       input app is modified in place.
  --identity ID        codesign identity. Defaults to
                       MACOS_CODESIGN_IDENTITY, then APPLE_SIGNING_IDENTITY,
                       then '-' (ad-hoc signing).
  --entitlements PATH  Entitlements for the final app signature. Defaults to
                       MACOS_CODESIGN_ENTITLEMENTS when set.
  -h, --help           Show this help.

Examples:
  $PROGRAM_NAME --output ./media-cropper-portable.app ./media-cropper.app

  APPLE_SIGNING_IDENTITY='Developer ID Application: Example Corp (TEAMID)' \\
    $PROGRAM_NAME ./media-cropper.app
EOF
}

log() {
  printf '[macos-bundle-dylibs] %s\n' "$*"
}

die() {
  printf '[macos-bundle-dylibs] ERROR: %s\n' "$*" >&2
  exit 1
}

require_tool() {
  [ -x "$1" ] || die "required tool not found: $1"
}

INPUT_APP=""
OUTPUT_APP=""
SIGN_IDENTITY="${MACOS_CODESIGN_IDENTITY:-${APPLE_SIGNING_IDENTITY:-}}"
ENTITLEMENTS="${MACOS_CODESIGN_ENTITLEMENTS:-}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --output)
      [ "$#" -ge 2 ] || die "--output requires a path"
      OUTPUT_APP="$2"
      shift 2
      ;;
    --identity)
      [ "$#" -ge 2 ] || die "--identity requires a value"
      SIGN_IDENTITY="$2"
      shift 2
      ;;
    --entitlements)
      [ "$#" -ge 2 ] || die "--entitlements requires a path"
      ENTITLEMENTS="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      die "unknown option: $1"
      ;;
    *)
      [ -z "$INPUT_APP" ] || die "only one input app may be specified"
      INPUT_APP="$1"
      shift
      ;;
  esac
done

[ -n "$INPUT_APP" ] || {
  usage >&2
  exit 2
}

[ -n "$SIGN_IDENTITY" ] || SIGN_IDENTITY="-"

for tool in \
  /bin/chmod \
  /bin/cp \
  /bin/mkdir \
  /usr/bin/codesign \
  /usr/bin/ditto \
  /usr/bin/file \
  /usr/bin/find \
  /usr/bin/install_name_tool \
  /usr/bin/otool \
  /usr/bin/plutil \
  /usr/libexec/PlistBuddy; do
  require_tool "$tool"
done

[ -d "$INPUT_APP/Contents" ] || die "not a macOS app bundle: $INPUT_APP"
[ -f "$INPUT_APP/Contents/Info.plist" ] || die "Info.plist is missing from: $INPUT_APP"
/usr/bin/plutil -lint "$INPUT_APP/Contents/Info.plist" >/dev/null ||
  die "invalid Info.plist: $INPUT_APP/Contents/Info.plist"

if [ -n "$ENTITLEMENTS" ]; then
  [ -f "$ENTITLEMENTS" ] || die "entitlements file not found: $ENTITLEMENTS"
  ENTITLEMENTS="$(cd -P "$(dirname "$ENTITLEMENTS")" && printf '%s/%s' "$PWD" "$(basename "$ENTITLEMENTS")")"
fi

if [ -n "$OUTPUT_APP" ]; then
  [ ! -e "$OUTPUT_APP" ] || die "output already exists: $OUTPUT_APP"
  log "copying app to: $OUTPUT_APP"
  /usr/bin/ditto "$INPUT_APP" "$OUTPUT_APP"
  APP="$OUTPUT_APP"
else
  APP="$INPUT_APP"
fi

APP="$(cd -P "$(dirname "$APP")" && printf '%s/%s' "$PWD" "$(basename "$APP")")"
MACOS_DIR="$APP/Contents/MacOS"
FRAMEWORKS_DIR="$APP/Contents/Frameworks"
MAIN_EXECUTABLE_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")"
MAIN_EXECUTABLE="$MACOS_DIR/$MAIN_EXECUTABLE_NAME"

[ -d "$MACOS_DIR" ] || die "Contents/MacOS is missing from: $APP"
[ -f "$MAIN_EXECUTABLE" ] || die "CFBundleExecutable is missing: $MAIN_EXECUTABLE"
/bin/mkdir -p "$FRAMEWORKS_DIR"

WORK_DIR="$(/usr/bin/mktemp -d -t media-cropper-dylibs.XXXXXX)"
MAPPINGS_FILE="$WORK_DIR/mappings.tsv"
QUEUED_FILE="$WORK_DIR/queued.txt"
SMOKE_LOG="$WORK_DIR/dyld-smoke.log"
: >"$MAPPINGS_FILE"
: >"$QUEUED_FILE"

cleanup() {
  /bin/rm -rf "$WORK_DIR"
}
trap cleanup EXIT INT TERM

is_macho() {
  /usr/bin/file -b "$1" | /usr/bin/grep -q 'Mach-O'
}

is_system_path() {
  case "$1" in
    /System/Library/*|/usr/lib/*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

# Resolve symlinks without depending on `realpath`, which is absent from older
# macOS releases supported by Tauri.
canonical_existing_path() {
  local path="$1"
  local directory
  local link_target

  [ -e "$path" ] || return 1
  while [ -L "$path" ]; do
    directory="$(cd -P "$(dirname "$path")" && pwd)"
    link_target="$(/usr/bin/readlink "$path")"
    case "$link_target" in
      /*) path="$link_target" ;;
      *) path="$directory/$link_target" ;;
    esac
  done
  directory="$(cd -P "$(dirname "$path")" && pwd)"
  printf '%s/%s\n' "$directory" "$(basename "$path")"
}

list_dependencies() {
  /usr/bin/otool -L "$1" |
    /usr/bin/sed -n '2,$s/^[[:space:]]*\(.*\) (compatibility version.*$/\1/p'
}

dylib_id() {
  /usr/bin/otool -D "$1" 2>/dev/null | /usr/bin/sed -n '2p'
}

list_rpaths() {
  /usr/bin/otool -l "$1" | /usr/bin/awk '
    $1 == "cmd" && $2 == "LC_RPATH" { expecting_path = 1; next }
    expecting_path && $1 == "path" { print $2; expecting_path = 0 }
  '
}

expand_anchor_path() {
  local value="$1"
  local owner="$2"
  local loader_dir
  loader_dir="$(dirname "$owner")"

  case "$value" in
    @loader_path)
      printf '%s\n' "$loader_dir"
      ;;
    @loader_path/*)
      printf '%s/%s\n' "$loader_dir" "${value#@loader_path/}"
      ;;
    @executable_path)
      printf '%s\n' "$MACOS_DIR"
      ;;
    @executable_path/*)
      printf '%s/%s\n' "$MACOS_DIR" "${value#@executable_path/}"
      ;;
    /*)
      printf '%s\n' "$value"
      ;;
    *)
      return 1
      ;;
  esac
}

resolve_dependency() {
  local dependency="$1"
  local owner="$2"
  local candidate
  local rpath
  local expanded_rpath
  local suffix

  case "$dependency" in
    /*|@loader_path|@loader_path/*|@executable_path|@executable_path/*)
      candidate="$(expand_anchor_path "$dependency" "$owner")" || return 1
      [ -e "$candidate" ] || return 1
      canonical_existing_path "$candidate"
      return
      ;;
    @rpath/*)
      suffix="${dependency#@rpath/}"
      while IFS= read -r rpath; do
        [ -n "$rpath" ] || continue
        expanded_rpath="$(expand_anchor_path "$rpath" "$owner")" || continue
        candidate="$expanded_rpath/$suffix"
        if [ -e "$candidate" ]; then
          canonical_existing_path "$candidate"
          return
        fi
      done < <(list_rpaths "$owner")

      # This also makes a second run over an already-processed app idempotent.
      candidate="$FRAMEWORKS_DIR/$(basename "$dependency")"
      if [ -e "$candidate" ]; then
        canonical_existing_path "$candidate"
        return
      fi
      return 1
      ;;
    *)
      return 1
      ;;
  esac
}

mapped_source_for_basename() {
  local requested="$1"
  /usr/bin/awk -F '\t' -v requested="$requested" '
    $1 == requested { print $2; exit }
  ' "$MAPPINGS_FILE"
}

enqueue_dylib() {
  local path="$1"
  if ! /usr/bin/grep -Fqx "$path" "$QUEUED_FILE"; then
    printf '%s\n' "$path" >>"$QUEUED_FILE"
    DYLIB_QUEUE+=("$path")
  fi
}

ensure_embedded() {
  local source="$1"
  local source_real
  local basename_only
  local destination
  local mapped_source
  local destination_real

  source_real="$(canonical_existing_path "$source")" ||
    die "dependency does not exist: $source"
  basename_only="$(basename "$source_real")"
  destination="$FRAMEWORKS_DIR/$basename_only"
  mapped_source="$(mapped_source_for_basename "$basename_only")"

  if [ -n "$mapped_source" ]; then
    [ "$mapped_source" = "$source_real" ] ||
      die "dylib basename collision for $basename_only: $mapped_source and $source_real"
    enqueue_dylib "$destination"
    EMBEDDED_DESTINATION="$destination"
    return
  fi

  if [ -e "$destination" ]; then
    destination_real="$(canonical_existing_path "$destination")"
    [ "$destination_real" = "$source_real" ] ||
      die "Contents/Frameworks already contains a different $basename_only"
  else
    is_macho "$source_real" || die "dependency is not Mach-O: $source_real"
    /bin/cp -pL "$source_real" "$destination"
    /bin/chmod u+w "$destination"
    log "embedded $basename_only"
  fi

  printf '%s\t%s\n' "$basename_only" "$source_real" >>"$MAPPINGS_FILE"
  enqueue_dylib "$destination"
  EMBEDDED_DESTINATION="$destination"
}

remove_nonportable_rpaths() {
  local owner="$1"
  local rpath

  while IFS= read -r rpath; do
    [ -n "$rpath" ] || continue
    case "$rpath" in
      /*)
        if ! is_system_path "$rpath"; then
          /usr/bin/install_name_tool -delete_rpath "$rpath" "$owner"
          log "removed non-portable rpath from $(basename "$owner"): $rpath"
        fi
        ;;
    esac
  done < <(list_rpaths "$owner" | /usr/bin/sort -u)
}

process_binary() {
  local owner="$1"
  local reference_prefix="$2"
  local normalize_id="$3"
  local dependency
  local current_id
  local source
  local destination
  local new_reference

  /bin/chmod u+w "$owner"
  /usr/bin/codesign --remove-signature "$owner" >/dev/null 2>&1 || true

  if [ "$normalize_id" = "yes" ]; then
    current_id="$(dylib_id "$owner")"
    if [ -n "$current_id" ] && [ "$current_id" != "@loader_path/$(basename "$owner")" ]; then
      /usr/bin/install_name_tool -id "@loader_path/$(basename "$owner")" "$owner"
    fi
  fi
  current_id="$(dylib_id "$owner")"

  while IFS= read -r dependency; do
    [ -n "$dependency" ] || continue
    [ "$dependency" != "$current_id" ] || continue
    is_system_path "$dependency" && continue

    source="$(resolve_dependency "$dependency" "$owner")" ||
      die "cannot resolve dependency '$dependency' required by $owner"
    is_system_path "$source" && continue

    ensure_embedded "$source"
    destination="$EMBEDDED_DESTINATION"
    new_reference="$reference_prefix/$(basename "$destination")"
    if [ "$dependency" != "$new_reference" ]; then
      /usr/bin/install_name_tool -change "$dependency" "$new_reference" "$owner"
    fi
  done < <(list_dependencies "$owner")

  remove_nonportable_rpaths "$owner"
}

SIDECARS=()
for candidate in \
  "$MACOS_DIR"/ffmpeg \
  "$MACOS_DIR"/ffmpeg-* \
  "$MACOS_DIR"/ffprobe \
  "$MACOS_DIR"/ffprobe-*; do
  [ -f "$candidate" ] || continue
  is_macho "$candidate" || continue
  duplicate="no"
  for existing in "${SIDECARS[@]:-}"; do
    if [ "$existing" = "$candidate" ]; then
      duplicate="yes"
      break
    fi
  done
  [ "$duplicate" = "yes" ] || SIDECARS+=("$candidate")
done

[ "${#SIDECARS[@]}" -ge 2 ] ||
  die "expected ffmpeg and ffprobe Mach-O sidecars in $MACOS_DIR"

log "processing ${#SIDECARS[@]} FFmpeg sidecars"
DYLIB_QUEUE=()
for sidecar in "${SIDECARS[@]}"; do
  process_binary "$sidecar" "@executable_path/../Frameworks" "no"
done

queue_index=0
while [ "$queue_index" -lt "${#DYLIB_QUEUE[@]}" ]; do
  dylib="${DYLIB_QUEUE[$queue_index]}"
  process_binary "$dylib" "@loader_path" "yes"
  queue_index=$((queue_index + 1))
done

verify_macho() {
  local binary="$1"
  local dependency
  local resolved

  if /usr/bin/otool -l "$binary" | /usr/bin/grep -Fq '/opt/homebrew'; then
    die "Homebrew path remains in Mach-O load commands: $binary"
  fi

  while IFS= read -r dependency; do
    [ -n "$dependency" ] || continue
    [ "$dependency" != "$(dylib_id "$binary")" ] || continue
    is_system_path "$dependency" && continue

    case "$dependency" in
      @loader_path/*|@executable_path/*|@rpath/*)
        resolved="$(resolve_dependency "$dependency" "$binary")" ||
          die "rewritten dependency does not resolve: $binary -> $dependency"
        [ -e "$resolved" ] || die "rewritten dependency target is missing: $resolved"
        ;;
      /*)
        die "non-system absolute dependency remains: $binary -> $dependency"
        ;;
      *)
        die "unsupported dependency remains: $binary -> $dependency"
        ;;
    esac
  done < <(list_dependencies "$binary")
}

log "verifying rewritten Mach-O dependency graph"
for sidecar in "${SIDECARS[@]}"; do
  verify_macho "$sidecar"
done
for dylib in "${DYLIB_QUEUE[@]}"; do
  verify_macho "$dylib"
done

# Keep the final claim app-wide: another build step must not be able to leave a
# Homebrew LC_LOAD_DYLIB or LC_RPATH in a different Mach-O inside the bundle.
while IFS= read -r -d '' binary; do
  is_macho "$binary" || continue
  if /usr/bin/otool -l "$binary" | /usr/bin/grep -Fq '/opt/homebrew'; then
    die "Homebrew path remains in app bundle Mach-O load commands: $binary"
  fi
done < <(/usr/bin/find "$APP/Contents" -type f -print0)

SIGN_ARGS=(--force --sign "$SIGN_IDENTITY")
if [ "$SIGN_IDENTITY" != "-" ]; then
  SIGN_ARGS+=(--timestamp --options runtime)
fi

sign_macho() {
  /usr/bin/codesign "${SIGN_ARGS[@]}" "$1"
}

log "signing embedded code with identity: $SIGN_IDENTITY"
while IFS= read -r -d '' binary; do
  is_macho "$binary" || continue
  sign_macho "$binary"
done < <(/usr/bin/find "$FRAMEWORKS_DIR" -type f -print0)

while IFS= read -r -d '' binary; do
  is_macho "$binary" || continue
  [ "$binary" != "$MAIN_EXECUTABLE" ] || continue
  sign_macho "$binary"
done < <(/usr/bin/find "$MACOS_DIR" -type f -print0)

APP_SIGN_ARGS=("${SIGN_ARGS[@]}")
if [ -n "$ENTITLEMENTS" ]; then
  APP_SIGN_ARGS+=(--entitlements "$ENTITLEMENTS")
fi
/usr/bin/codesign "${APP_SIGN_ARGS[@]}" "$APP"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$APP"

log "running FFmpeg sidecars with a clean environment"
: >"$SMOKE_LOG"
for sidecar in "${SIDECARS[@]}"; do
  /usr/bin/env -i \
    HOME="${HOME:-/tmp}" \
    PATH="/usr/bin:/bin" \
    DYLD_PRINT_LIBRARIES=1 \
    "$sidecar" -version >/dev/null 2>>"$SMOKE_LOG" ||
    die "runtime smoke test failed: $sidecar"
done

if /usr/bin/grep -Fq '/opt/homebrew' "$SMOKE_LOG"; then
  die "runtime smoke test loaded a library from /opt/homebrew"
fi

DYLIB_COUNT="$(/usr/bin/find "$FRAMEWORKS_DIR" -type f | /usr/bin/wc -l | /usr/bin/tr -d ' ')"
FRAMEWORKS_SIZE="$(/usr/bin/du -sh "$FRAMEWORKS_DIR" | /usr/bin/awk '{print $1}')"
log "success: $APP"
log "embedded dylibs: $DYLIB_COUNT ($FRAMEWORKS_SIZE)"
log "verified: no /opt/homebrew load commands or runtime loads"
log "verified: strict recursive code signature"
