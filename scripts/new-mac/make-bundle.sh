#!/bin/bash
# Run on the Mac that HAS the data (the Air). Makes ~/roofline-transfer/ (NOT on the Desktop: the Desktop may sync to iCloud) with what git does not carry:
#   roofline-data.tar.gz  the benchmark houses, the window model and saved test data (raw lidar tiles and old
#                         verification runs are left out: they can be downloaded or re-run again)
#   claude-memory.tar.gz  Claude's notes about this project, so Claude on the new Mac knows the history
#   env.keys              the API keys (secret: AirDrop it straight to the new Mac, never email or commit it)
# AirDrop the whole folder to the new Mac, then run scripts/new-mac/setup.sh there.
set -euo pipefail
OUT="$HOME/roofline-transfer"
WORK="$HOME/RooflineWork"
mkdir -p "$OUT"

echo "== data bundle (about 1 GB before compression)"
tar -C "$WORK" -czf "$OUT/roofline-data.tar.gz" \
  --exclude 'roof-bench/lidar/tiles' \
  --exclude 'roof-bench/verify-l' \
  --exclude 'roof-bench/verify' \
  --exclude 'roof-bench/verify-outline' \
  --exclude '*.laz.part' \
  roof-bench models saved-testdata

echo "== Claude memory"
MEM="$HOME/.claude/projects/$(echo "$HOME" | tr '/' '-')/memory"
if [ -d "$MEM" ]; then tar -C "$MEM" -czf "$OUT/claude-memory.tar.gz" .; else echo "  (no memory folder at $MEM)"; fi

echo "== keys"
install -m 600 "$HOME/roofline-demo/.env.keys" "$OUT/env.keys"

ls -lh "$OUT"
echo
echo "AirDrop the folder $OUT to the new Mac (it lands in ~/Downloads/roofline-transfer)."
echo "Delete the folder afterwards on both Macs (rm -rf ~/roofline-transfer ~/Downloads/roofline-transfer): it holds the keys."
