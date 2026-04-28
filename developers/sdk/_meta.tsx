/* SDK Reference tab sidebar.
 * Two reference surfaces side-by-side: the hand-written narrative
 * SDK pages and the auto-generated outputs (TypeDoc → `api/`,
 * OpenAPI → `rest/`). Both stay collapsible so this tab doesn't
 * become long either. */
const meta = {
  // ── SDK overview & narrative ──────────────────────
  "-- sdk": { type: "separator", title: "SDK" },
  overview: "Overview",
  core: "core",
  contracts: "contracts",
  zk: "zk",
  relayer: "relayer",
  orderbook: "orderbook",
  notes: "notes",
  react: "react",

  // ── Auto-generated references ─────────────────────
  "-- ref": { type: "separator", title: "Reference" },
  api: "TypeScript API",
  rest: "REST API",
};

export default meta;
