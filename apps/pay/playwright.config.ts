import { defineConfig, devices } from "@playwright/test";

/**
 * Pay e2e harness — Playwright-driven smoke tests against `next dev`.
 *
 * Scope today: wallet-less smoke (landing, dashboard mount, wizard
 * static screens). Wallet-driven scenarios (settle, claim, transfer
 * out) are gated on a separate test-wallet bridge and tracked as a
 * follow-up; for the manual end-to-end WETH path see
 * `docs/operations/qa-pay-weth-transferout.md`.
 *
 * Pay is a static-export Next app, so `next dev` is the test target —
 * `next start` after `next build` is also valid but slower to spin up
 * for the iteration loop.
 */
export default defineConfig({
  testDir: "./e2e",
  // `fullyParallel: false` — paired with `workers: 1` below, the
  // entire suite runs serially. This is the constraint live specs'
  // anvil snapshot/revert pattern needs (see
  // `_helpers/anvil-snapshot.ts`): anvil's snapshot stack is global,
  // so two parallel workers would clobber each other's snapshots.
  // Wallet-less + bridge specs would technically be safe to
  // parallelize, but a multi-project split is more ceremony than
  // the ~5s walltime saved is worth at this scale.
  fullyParallel: false,
  // CI gets one retry to absorb flakes from `next dev`'s first-paint
  // jitter; locally we surface failures immediately.
  retries: process.env.CI ? 1 : 0,
  // Single worker pairs with `fullyParallel: false` above —
  // serializes the whole run for the live specs' anvil
  // snapshot/revert isolation. See that flag for the rationale.
  workers: 1,
  // CI keeps the GitHub annotations reporter for inline failure
  // surfacing AND emits the HTML report so the README's "upload
  // playwright-report/" guidance produces a real artefact. Locally
  // the list reporter is enough.
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : "list",
  timeout: 30_000,

  use: {
    baseURL: "http://localhost:4001",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  // Boot the dev server unless one is already running. `npm run dev`
  // shells through `predev` (sync-zk-assets), which is what a fresh
  // clone needs the first time.
  webServer: {
    command: "npm run dev",
    url: "http://localhost:4001",
    reuseExistingServer: !process.env.CI,
    // The first dev start has to compile + sync 24 MB of zk assets;
    // 2 minutes covers cold-cache CI machines.
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
