"use client";

import { useEffect } from "react";

// Recover from stale-chunk errors instead of looping forever.
//
// A content-hashed JS chunk URL stops resolving whenever the build that
// emitted it is replaced: an open tab after a Turbopack dev-server
// restart (every `run-scatter-web.sh` relaunch mints a fresh build id),
// or a user sitting on an old tab after a production deploy. Next's
// client then throws `ChunkLoadError` and falls back to a full reload —
// but if the tab keeps reaching for the old assets it reloads on every
// attempt, an infinite `GET /<route>` loop. In dev that loop also floods
// the console-forwarding dev server until it OOMs.
//
// This reloads AT MOST ONCE per `RELOAD_WINDOW_MS`, gated by a
// sessionStorage timestamp: a genuine hash mismatch self-heals on the
// first reload (the fresh HTML references the new chunk URLs), while a
// still-broken build stops after one try instead of hot-looping. The
// window is per-tab (sessionStorage), so other tabs recover independently
// and the guard re-arms automatically once the window elapses.

const RELOAD_KEY = "zk:chunk-reload-at";
const RELOAD_WINDOW_MS = 10_000;

/** True for the chunk-load failures Next/Turbopack/webpack surface — by
 *  error name, or by the message text when the name was lost crossing an
 *  `unhandledrejection` boundary. */
export function isChunkLoadError(reason: unknown): boolean {
  if (!reason || typeof reason !== "object") {
    return typeof reason === "string" && /ChunkLoadError|Loading chunk \d|Failed to load chunk/i.test(reason);
  }
  const err = reason as { name?: unknown; message?: unknown };
  if (err.name === "ChunkLoadError") return true;
  return (
    typeof err.message === "string" &&
    /ChunkLoadError|Loading chunk \d|Failed to load chunk/i.test(err.message)
  );
}

/** Mount once near the root of a Next App Router layout (inside `<body>`).
 *  Renders nothing; installs window error listeners that turn a
 *  stale-chunk reload loop into a single recovering reload. */
export function ChunkReloadGuard() {
  useEffect(() => {
    const recover = (reason: unknown) => {
      if (!isChunkLoadError(reason)) return;
      let last = 0;
      try {
        last = Number(window.sessionStorage.getItem(RELOAD_KEY)) || 0;
      } catch {
        // sessionStorage can throw (privacy mode / disabled). Without it
        // we can't loop-guard, so don't auto-reload — a manual refresh is
        // safer than risking a loop.
        return;
      }
      const now = Date.now();
      if (now - last < RELOAD_WINDOW_MS) {
        // Already reloaded once for this — the new build is still broken,
        // or the asset is genuinely gone. Stop; let the user hard-refresh.
        console.error(
          "[ChunkReloadGuard] chunk still failing after a reload — not looping. Hard-refresh (Cmd+Shift+R) or restart the dev server.",
        );
        return;
      }
      try {
        window.sessionStorage.setItem(RELOAD_KEY, String(now));
      } catch {
        return;
      }
      window.location.reload();
    };

    const onError = (ev: ErrorEvent) => recover(ev.error ?? ev.message);
    const onRejection = (ev: PromiseRejectionEvent) => recover(ev.reason);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}
