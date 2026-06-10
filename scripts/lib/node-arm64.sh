#!/usr/bin/env bash
# Shared helpers for the Next.js frontend launcher scripts (run-*-web.sh).
# Source this, then call `setup_node_run` before invoking npm/next.
#
# setup_node_run — populates the NODE_RUN array used to invoke npm. On Apple
#   Silicon it pins Node to native arm64 so Next.js/Turbopack loads the arm64
#   @next/swc binary instead of the x64 one, which panics under Rosetta with
#   "CPU doesn't support the bmi2 instructions" (qfilter's BMI2 check).
#
#   Why: Next loads the @next/swc native binary matching the *Node process*
#   arch. If the terminal is "Open using Rosetta" (or an x64 Node is active),
#   Node runs x86_64 and Next loads the x64 SWC → panic. A plain
#   `arch -arm64 ./script` does NOT help: the #!/usr/bin/env shebang chain
#   (env → bash → node) consumes the arch preference before Node is reached.
#   The fix is to make Node *itself* the immediate child of `arch -arm64`, so
#   the root Node is native arm64 and the next-server child inherits arm64.
#   Intel Macs / Linux are unaffected and fall through to plain `npm`.
#
#   Scope: frontend (Next.js) launchers only. Do NOT use in dev.sh/dev-fork.sh
#   relayer/orderbook launchers — those may depend on x86_64 native deps.
#   See the project_rosetta_swc_bmi2 memory for the full diagnosis.
setup_node_run() {
  NODE_RUN=(npm)                 # default: plain `npm <args>` (Intel/Linux)
  [ "$(uname -s)" = "Darwin" ] || return 0
  [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ] || return 0

  # Locate a Node binary carrying an arm64 slice (universal or arm64-only);
  # `arch -arm64` then guarantees it runs native arm64. Prefer PATH (keeps the
  # developer's chosen version), then the usual Homebrew/system locations —
  # these may be shadowed on PATH by an x64-only nvm Node, so check explicitly.
  local arm64_node="" dir cand npm_cli _oifs="$IFS"
  IFS=:
  for dir in $PATH; do
    cand="$dir/node"; [ -x "$cand" ] || continue
    if file "$cand" 2>/dev/null | grep -q arm64; then arm64_node="$cand"; break; fi
  done
  IFS="$_oifs"
  if [ -z "$arm64_node" ]; then
    for cand in /opt/homebrew/bin/node /usr/local/bin/node; do
      [ -x "$cand" ] || continue
      if file "$cand" 2>/dev/null | grep -q arm64; then arm64_node="$cand"; break; fi
    done
  fi
  if [ -z "$arm64_node" ]; then
    echo "ERROR: Apple Silicon Mac but no arm64-capable Node found." >&2
    echo "       Install one and retry, e.g.:  nvm install 22 && nvm use 22" >&2
    exit 1
  fi

  # npm-cli.js lives at <node-prefix>/lib/node_modules/npm/bin/npm-cli.js for
  # every standard install (system, Homebrew, nvm). Running it via the arm64
  # Node keeps full `npm` semantics while forcing native arm64.
  npm_cli="$(cd "$(dirname "$arm64_node")/.." 2>/dev/null && pwd)/lib/node_modules/npm/bin/npm-cli.js"
  if [ -f "$npm_cli" ]; then
    NODE_RUN=(arch -arm64 "$arm64_node" "$npm_cli")
  else
    # Fallback: still force arm64, but let `npm` resolve on PATH.
    NODE_RUN=(arch -arm64 "$arm64_node" "$(command -v npm)")
  fi
  echo "Apple Silicon: running Node natively as arm64 ($arm64_node)." >&2
}

# install_if_needed <project-dir> — npm-install a standalone app on first run so
# "clone → run" works without a manual `npm install`. Skips when next is already
# present. Uses NODE_RUN (call setup_node_run first) so native deps install for
# the correct arch. No `next build` needed — `next dev` compiles on the fly.
install_if_needed() {
  local dir="$1"
  [ -x "$dir/node_modules/.bin/next" ] && return 0
  echo "Installing dependencies in $(basename "$dir") (first run; one-off)…"
  if [ -f "$dir/package-lock.json" ]; then
    ( cd "$dir" && "${NODE_RUN[@]}" ci )
  else
    ( cd "$dir" && "${NODE_RUN[@]}" install )
  fi
}
