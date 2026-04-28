/* Document tab sidebar.
 * Mirrors the Tokamak-AI-Layer information architecture: deep
 * Get-started tier → Architecture (concepts) → Build (guides) →
 * Protocol (contract refs) → Operate. SDK / REST refs live under
 * the sibling `sdk/` folder and are reached via the navbar tab. */
const meta = {
  // ── Get started ─────────────────────────────────────
  "-- get-started": { type: "separator", title: "Get started" },
  introduction: "Introduction",
  installation: "Installation",
  quickstart: "Quickstart",
  faq: "FAQ",

  // ── Architecture ────────────────────────────────────
  "-- architecture": { type: "separator", title: "Architecture" },
  concepts: "Architecture",

  // ── Build ───────────────────────────────────────────
  "-- build": { type: "separator", title: "Build" },
  guides: "Build",

  // ── Protocol reference ──────────────────────────────
  "-- protocol": { type: "separator", title: "Protocol reference" },
  protocol: "Contracts",

  // ── Operate ─────────────────────────────────────────
  "-- operate": { type: "separator", title: "Operate" },
  operate: "Operator",

  // ── Reference papers ────────────────────────────────
  "-- papers": { type: "separator", title: "Papers" },
  whitepaper: "Whitepaper",
};

export default meta;
