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

# Read PIDs into an array so we can SIGTERM all at once, then poll —
# avoids the "spawn a sleep-2 + kill -9 per PID" pattern, which both
# blocks for a fixed 2s and risks SIGKILLing a recycled PID if the OS
# reused the slot during the grace window.
mapfile -t PIDS < "$PID_FILE"
PIDS=("${PIDS[@]/#/}")  # drop empty lines after trim
ALIVE=()
for pid in "${PIDS[@]}"; do
  [ -z "$pid" ] && continue
  ALIVE+=("$pid")
done

if [ ${#ALIVE[@]} -eq 0 ]; then
  rm -f "$PID_FILE"
  echo "Nothing to stop."
  exit 0
fi

echo "  SIGTERM: ${ALIVE[*]}"
kill "${ALIVE[@]}" 2>/dev/null || true

# Poll up to 2s in 100ms ticks. Exit early once everything's gone so
# CI cleanup isn't artificially padded.
for _ in $(seq 1 20); do
  STILL=()
  for pid in "${ALIVE[@]}"; do
    kill -0 "$pid" 2>/dev/null && STILL+=("$pid")
  done
  ALIVE=("${STILL[@]}")
  [ ${#ALIVE[@]} -eq 0 ] && break
  sleep 0.1
done

if [ ${#ALIVE[@]} -gt 0 ]; then
  echo "  SIGKILL survivors: ${ALIVE[*]}"
  kill -9 "${ALIVE[@]}" 2>/dev/null || true
fi

rm -f "$PID_FILE"
echo "Done."
