"use client";

/** Legacy `/inbox` route. The page split into Wallet + Inbox under
 *  `/stealth/*` (matching the apps/pay structure); this stub keeps
 *  any external bookmarks / hard-coded links resolving by sending
 *  them to the new inbox. */

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function LegacyInboxRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/stealth/inbox");
  }, [router]);
  return (
    <p className="text-sm text-[var(--color-text-muted)]">
      Redirecting to <code className="font-mono">/stealth/inbox</code>…
    </p>
  );
}
