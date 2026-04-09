#!/bin/sh
# Entrypoint for zk-relayer Docker container.
# Sources contract addresses from /shared/addresses.env (mock mode)
# or uses environment variables directly (testnet mode).

# Wait for addresses.env if COMMITMENT_POOL_ADDRESS is not set (mock mode)
if [ -z "$COMMITMENT_POOL_ADDRESS" ]; then
  echo "Waiting for contract deployment (addresses.env)..."
  i=0
  while [ ! -f /shared/addresses.env ] && [ "$i" -lt 30 ]; do
    sleep 1
    i=$((i + 1))
  done
fi

# Source addresses if available (overrides env vars with deployed values)
if [ -f /shared/addresses.env ]; then
  set -a
  . /shared/addresses.env
  set +a
  echo "Loaded addresses from /shared/addresses.env"
fi

# Validate required env vars
for var in COMMITMENT_POOL_ADDRESS PRIVATE_SETTLEMENT_ADDRESS; do
  eval val=\$$var
  if [ -z "$val" ]; then
    echo "ERROR: $var is not set. Provide via .env or deploy contracts first."
    exit 1
  fi
done

exec npx tsx src/index.ts
