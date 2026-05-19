"use client";

import { usePathname } from "next/navigation";
import { useFolder } from "../lib/folder";

/** Pages where a folder pick is *not* a prerequisite — the marketing
 *  / overview surfaces. Showing the warning banner here is noise:
 *  the user hasn't tried to do anything that needs a folder yet,
 *  and the CTA buttons inside the page already route through the
 *  workbench (which renders its own banner when a folder really is
 *  missing). */
const NO_BANNER_PATHS = new Set(["/"]);

/** Non-blocking guide banner: when no notes folder is selected,
 *  render a single horizontal strip below the app header with a
 *  Pick-folder CTA. Hidden once `folder.ready` so the strip
 *  disappears without a layout shift after the user picks.
 *
 *  Sits between `AppShellHeader` and `<main>{children}</main>` so
 *  every page renders normally underneath; writes that require a
 *  folder still throw at the adapter (folder is mandatory — no
 *  IDB fallback), and the modals catch that. The banner exists
 *  to make the "you need a folder" affordance visible *before*
 *  the user tries to write. */
export function FolderPickerBanner() {
  const folder = useFolder();
  const pathname = usePathname();

  // Suppress on marketing / landing surfaces — see NO_BANNER_PATHS.
  // The check runs before the folder-state gates so the banner
  // never even mounts on those routes, avoiding a transient
  // paint while restoreFolder resolves.
  if (pathname && NO_BANNER_PATHS.has(pathname)) return null;

  // SSR / probe stages render nothing — flashing a banner for
  // one frame before restoreFolder resolves would look broken.
  if (folder.available === null) return null;
  if (folder.restoring) return null;
  if (folder.ready) return null;

  if (!folder.available) {
    return (
      <div className="border-b border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-6 py-2 text-center text-xs text-[var(--color-warning)]">
        Pro stores vault notes, orders and address book in a folder you
        pick. Your browser doesn't support the File System Access API —
        open this page in a Chromium-based browser (Chrome / Edge / Brave
        / Opera / Arc&nbsp;…) to continue.
      </div>
    );
  }

  return (
    <div className="border-b border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-6 py-2">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 text-xs">
        <div>
          <span className="font-semibold text-[var(--color-warning)]">
            Pick a workspace folder
          </span>
          <span className="ml-2 text-[var(--color-text-muted)]">
            Pro saves your deposit notes, orders and address book into a
            folder on disk. Picking it once is enough — your browser
            remembers it for future sessions.
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {folder.recent.length > 0 &&
            folder.recent.slice(0, 3).map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => void folder.switchTo(r.id)}
                className="rounded-md border border-[var(--color-border-strong)] bg-white px-2 py-1 text-[11px] font-medium hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
              >
                {r.name}
              </button>
            ))}
          <button
            type="button"
            onClick={() => void folder.select()}
            className="rounded-md bg-[var(--color-primary)] px-3 py-1 text-[11px] font-semibold text-white hover:opacity-90"
          >
            Pick folder…
          </button>
        </div>
      </div>
    </div>
  );
}
