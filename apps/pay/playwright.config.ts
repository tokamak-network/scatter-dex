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
  // `fullyParallel: true` parallelises both across spec files AND
  // across tests within a single file — every test gets its own
  // worker / browser context, so any test that needs ordering must
  // opt in via `test.describe.serial(...)`. Today no spec shares
  // state (each test navigates fresh), so this is the right default.
  fullyParallel: true,
  // CI gets one retry to absorb flakes from `next dev`'s first-paint
  // jitter; locally we surface failures immediately.
  retries: process.env.CI ? 1 : 0,
  // Single worker on CI to keep memory predictable when `next dev`
  // is hosted alongside the test runner; locally the OS scheduler
  // handles the parallelism fine.
  workers: process.env.CI ? 1 : undefined,
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
