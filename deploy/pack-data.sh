#!/usr/bin/env bash
# Copies only the runtime reference-data files (never the build caches) from
# this checkout's `modules/*/data` into `<target>/{terrain,equipment,exercise}`
# — the layout `IPB_DATA_ROOT` expects. Rsync-friendly: re-running it after
# the source changes only pushes the delta, so it doubles as the "sync to
# the NAS" command.
#
#   deploy/pack-data.sh /path/to/nas/ipb-data
#   deploy/pack-data.sh user@nas:/srv/ipb-data      # rsync remote target
#
# Excluded (build caches, rebuildable from tools/*, not needed at runtime):
#   modules/terrain/data/{planetiler,dmr4g,glo30}, modules/terrain/data/vector.old.pmtiles
#   modules/exercise/data/cache
#   modules/equipment/data/odin-cache
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <target-dir-or-rsync-destination>" >&2
  exit 1
fi

target="$1"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v rsync >/dev/null 2>&1; then
  echo "rsync is required." >&2
  exit 1
fi

# A local target gets its subdirectories created up front so `du -sh` below
# always has something to report, even on a first, empty run.
if [[ "$target" != *:* ]]; then
  mkdir -p "$target/terrain" "$target/equipment" "$target/exercise"
fi

echo "Packing terrain data ->  $target/terrain"
rsync -avh --info=progress2 \
  --exclude 'planetiler/' \
  --exclude 'dmr4g/' \
  --exclude 'glo30/' \
  --exclude 'vector.old.pmtiles' \
  "$root/modules/terrain/data/" "$target/terrain/"

echo "Packing equipment data -> $target/equipment"
rsync -avh --info=progress2 \
  --exclude 'odin-cache/' \
  "$root/modules/equipment/data/" "$target/equipment/"

echo "Packing exercise data -> $target/exercise"
rsync -avh --info=progress2 \
  --exclude 'cache/' \
  "$root/modules/exercise/data/" "$target/exercise/"

if [[ "$target" != *:* ]]; then
  echo
  echo "Packed sizes:"
  du -sh "$target/terrain" "$target/equipment" "$target/exercise"
fi
