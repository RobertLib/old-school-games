#!/usr/bin/env bash
# Whole-bucket snapshots, outside the app's ephemeral filesystem. rclone
# credentials belong in its private config, never in these arguments.
set -euo pipefail

: "${MEDIA_BACKUP_SOURCE:?Set MEDIA_BACKUP_SOURCE to a configured rclone remote/bucket or local directory}"
: "${MEDIA_BACKUP_DESTINATION:?Set MEDIA_BACKUP_DESTINATION to an independent backup remote/path or local directory}"

if [[ $# -gt 1 || ( $# -eq 1 && "$1" != "--dry-run" ) ]]; then
  printf 'Usage: bash scripts/backup-media.sh [--dry-run]\n' >&2
  exit 2
fi

# Resolve local directories without creating the destination. Existing parents
# use their physical path, so relative paths and symlinks cannot hide overlap.
# Missing children are appended after resolving their parent. pwd -P and
# readlink work with both macOS's Bash 3.2 and the Linux workflow runner.
local_directory() {
  local target="$1" links="${2:-0}" parent leaf resolved link
  while [[ "$target" == */ && "$target" != / ]]; do target="${target%/}"; done

  if [[ -d "$target" ]]; then
    (cd -P -- "$target" && pwd -P)
    return
  fi

  if [[ -L "$target" ]]; then
    if (( links >= 40 )); then
      printf 'Cannot resolve a backup path with a symlink loop.\n' >&2
      return 2
    fi
    link=$(readlink "$target") || return 2
    if [[ "$link" != /* ]]; then
      parent="${target%/*}"
      [[ "$parent" != "$target" ]] || parent=.
      [[ -n "$parent" ]] || parent=/
      link="$parent/$link"
    fi
    local_directory "$link" "$((links + 1))"
    return
  fi

  parent="${target%/*}"
  leaf="${target##*/}"
  [[ "$parent" != "$target" ]] || parent=.
  [[ -n "$parent" ]] || parent=/
  resolved=$(local_directory "$parent" "$links") || return 2
  case "$leaf" in
    .) printf '%s\n' "$resolved" ;;
    ..) resolved="${resolved%/*}"; printf '%s\n' "${resolved:-/}" ;;
    *) printf '%s/%s\n' "${resolved%/}" "$leaf" ;;
  esac
}

# Compare paths within a configured remote, including its root ("media:").
# Dot segments and repeated separators must not disguise a child path.
remote_directory() {
  local remaining="$1" component resolved=""
  while [[ -n "$remaining" ]]; do
    component="${remaining%%/*}"
    if [[ "$remaining" == */* ]]; then remaining="${remaining#*/}"; else remaining=""; fi
    case "$component" in
      ''|.) ;;
      ..) resolved="${resolved%/*}" ;;
      *) resolved="$resolved/$component" ;;
    esac
  done
  printf '%s\n' "$resolved"
}

directory_key() {
  local target="$1" resolved
  if [[ "$target" == :* ]]; then
    printf 'Use a configured rclone remote, with credentials in its private config.\n' >&2
    return 2
  elif [[ "$target" =~ ^[^/:]+: ]]; then
    resolved=$(remote_directory "${target#*:}") || return 2
    printf 'remote:%s%s\n' "${target%%:*}" "$resolved"
  else
    resolved=$(local_directory "$target") || return 2
    printf 'local:%s\n' "${resolved%/}"
  fi
}

source_path="${MEDIA_BACKUP_SOURCE%/}"
backup_base="${MEDIA_BACKUP_DESTINATION%/}"
if [[ -z "$source_path" || -z "$backup_base" ]]; then
  printf 'The backup destination must be separate from the source.\n' >&2
  exit 2
fi
source_key=$(directory_key "$source_path") || exit 2
backup_key=$(directory_key "$backup_base") || exit 2
if [[ "$source_key" == "$backup_key" || "$backup_key" == "$source_key/"* ]]; then
  printf 'The backup destination must be separate from the source.\n' >&2
  exit 2
fi
# Use the paths we checked: rclone's lexical path cleaning must not interpret
# a symlink followed by ".." differently from the physical resolution above.
if [[ "$source_key" == local:* ]]; then
  source_path="${source_key#local:}"
  source_path="${source_path:-/}"
fi
if [[ "$backup_key" == local:* ]]; then
  backup_base="${backup_key#local:}"
  backup_base="${backup_base:-/}"
fi

command -v rclone >/dev/null || { printf 'Install rclone before backing up media.\n' >&2; exit 2; }
scratch=$(mktemp -d "${TMPDIR:-/tmp}/osg-media-backup.XXXXXXXX")
trap 'rm -rf "$scratch"' EXIT
snapshot="$(date -u '+%Y-%m-%dT%H%M%SZ')-${scratch##*.}"
target="$backup_base/$snapshot"

if [[ "${1:-}" == "--dry-run" ]]; then
  rclone copy "$source_path" "$target/objects" --immutable --metadata --dry-run
  exit 0
fi

# A new directory for each run preserves files deleted or overwritten in
# production. A copy failure leaves no completion marker; it can be retried
# without modifying any previous snapshot.
rclone copy "$source_path" "$target/objects" --immutable --metadata
# Read both copies, even if a provider has no usable object checksum.
# A bucket changing during the copy can fail this check; retry that snapshot.
rclone check "$source_path" "$target/objects" --download
rclone lsjson "$target/objects" --recursive --files-only --hash > "$scratch/manifest.json"
rclone copyto "$scratch/manifest.json" "$target/manifest.json" --immutable
printf '{"version":1,"snapshot":"%s","verifiedBy":"rclone check --download"}\n' "$snapshot" > "$scratch/complete.json"
rclone copyto "$scratch/complete.json" "$target/complete.json" --immutable
printf 'Verified media backup: %s\n' "$target"
