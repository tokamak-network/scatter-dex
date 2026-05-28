"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// `/protocol` itself has no content — the sub-nav decides what to
// show. The admin app is built with `output: "export"` so we can't
// use server-side `redirect()`; do a client-side replace instead and
// render a tiny placeholder for the static HTML / no-JS case.
export default function ProtocolIndex() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/protocol/relayer-registry");
  }, [router]);
  return (
    <p className="p-6 text-sm text-[var(--color-text-muted)]">
      Loading Relayer Registry…
    </p>
  );
}
