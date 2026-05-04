# Pay e2e — Playwright smoke harness

End-to-end smoke tests for the Pay app, scoped to **wallet-less**
scenarios today (landing, dashboard mount, wizard entry). Walks the
static-export pages with a real Chromium browser through Playwright
so a regression that only manifests after hydration (a `useWallet`
throw at module load, a missing `<Suspense>` boundary, etc.) gets
caught in CI rather than at user time.

## What this harness does NOT cover (yet)

- **Wallet-driven flows** — connect, deposit, settle, claim,
  transfer-out. These need a test-wallet bridge (Synpress or a
  custom `injected` mock) plus a running anvil + zk-relayer; tracked
  as a follow-up.
- **WETH end-to-end** — see the manual checklist at
  `docs/operations/qa-pay-weth-transferout.md`. That doc is the
  source of truth for the WETH stealth → claim → native-ETH
  transfer-out path until the wallet bridge lands here.
- **Multi-tier proving** — exercising tier 64 / tier 128 needs the
  same wallet bridge plus a 17 / 65-recipient run; same follow-up.

## Setup

From `apps/pay/`:

```bash
# 1. Install Playwright + the browsers it drives.
npm install
npm run e2e:install   # `playwright install chromium` — one-time.
```

## Running

```bash
# Headless (CI mode + standard local).
npm run e2e

# Interactive UI mode — useful for picking selectors and stepping
# through assertions.
npm run e2e:ui
```

The `webServer` config in `playwright.config.ts` boots `npm run dev`
on port 4001 if nothing is already listening; if you've got Pay
running in another terminal, the runner reuses it (`reuseExistingServer:
!process.env.CI`).

## Layout

```
apps/pay/
├── playwright.config.ts      # browser projects + webServer
└── e2e/
    ├── README.md             # this file
    ├── landing.spec.ts       # `/`, `/dashboard` smoke
    └── wizard.spec.ts        # `/payouts/new` entry-screen smoke
```

Per-spec parallelism is enabled (`fullyParallel: true`); each spec
file gets its own browser context so they don't share workspace
state.

## Adding tests

- **Wallet-less**: lean on the existing static pages — landing,
  payslip print route (with seeded query params), claim page (the
  link generator can produce a deterministic stealth address).
- **Wallet-needed**: hold off until the bridge lands. When you write
  the bridge, the natural seam is `useWallet`'s underlying
  `WalletContext` — replace the injected provider with a deterministic
  `ethers.Wallet` for the test session.

## CI

Not yet wired into the GitHub Actions matrix. When wired, the most
useful job:

- `apps/pay/playwright.config.ts` already detects `process.env.CI`
  for the `retries` / `workers` / `reporter` switches.
- The webServer's 120s timeout covers cold caches; first run on a
  fresh VM has to sync ~24 MB of zk assets via the `predev` hook.
- Upload `apps/pay/playwright-report/` as a job artefact when the
  run fails — the HTML report makes Playwright's screenshot +
  trace + DOM snapshot navigable without re-running the suite.
