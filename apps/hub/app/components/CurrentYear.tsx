"use client";

import { useEffect, useState } from "react";

// `new Date().getFullYear()` in a server component is evaluated at
// build time and never refreshes, so the footer copyright would
// silently drift on Jan 1 until the next deploy. Render the build-time
// year as a fallback (matches SSR markup → no hydration warning) and
// swap to the live value on mount.
const BUILD_YEAR = new Date().getFullYear();

export function CurrentYear() {
  const [year, setYear] = useState(BUILD_YEAR);
  useEffect(() => {
    const live = new Date().getFullYear();
    if (live !== year) setYear(live);
  }, [year]);
  return <>{year}</>;
}
