#!/bin/bash
# Tear down the env brought up by scripts/start-e2e-env.sh.
# Reads PIDs from .e2e-pids and SIGTERMs them. Idempotent.

set -e
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$ROOT_DIR/.e2e-pids"

if [ ! -f "$PID_FILE" ]; then
  echo "No .e2e-pids found — nothing to stop."
  exit 0
fi

while read -r pid; do
  [ -z "$pid" ] && continue
  kill "$pid" 2>/dev/null || true
  # tsx/vitest occasionally ignore SIGTERM; SIGKILL after a grace window
  # so CI cleanup doesn't leave orphan processes holding ports.
  ( sleep 2; kill -9 "$pid" 2>/dev/null || true ) &
  echo "  killed PID $pid"
done < "$PID_FILE"
wait 2>/dev/null || true

rm -f "$PID_FILE"
echo "Done."
