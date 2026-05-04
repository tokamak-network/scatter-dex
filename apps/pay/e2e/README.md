# Pay e2e — Playwright smoke harness

End-to-end smoke tests for the Pay app, scoped to **wallet-less**
scenarios today (landing, dashboard mount, wizard entry). Walks the
static-export pages with a real Chromium browser through Playwright
so a regression that only manifests after hydration (a `useWallet`
throw at module load, a missing `<Suspense>` boundary, etc.) gets
caught in CI rather than at user time.

## What this harness covers today

- **Static-page smoke** — `/`, `/dashboard`, `/payouts/new` mount
  without a wallet (`landing.spec.ts`, `wizard.spec.ts`). Catches
  hydration / `useWallet`-throw-at-module-load regressions.
- **Wallet bridge — read-only** — `wallet-bridge.spec.ts` exercises
  a hand-rolled EIP-1193 stub (`_helpers/test-wallet.ts`) that
  injects `window.ethereum` before React mounts. The stub answers
  `eth_accounts` / `eth_chainId` locally and forwards every other
  method to a configured RPC URL (anvil by default).
- **Wallet bridge — signing** — when `installTestWallet` is given
  a `privateKey`, the bridge enables `personal_sign`,
  `eth_signTypedData_v4`, and `eth_sendTransaction` by forwarding
  to a node-side `ethers.Wallet` via Playwright's
  `page.exposeFunction`. The browser stub stays free of any
  signing crypto bundle. `wallet-bridge.spec.ts` recovers the
  signer for both `personal_sign` and `eth_signTypedData_v4` to
  prove the round-trip works.

## What this harness does NOT cover (yet)

- **Settle / claim / transfer-out scenarios** — the bridge can
  sign now, but exercising the full Pay flows still needs a
  running anvil + zk-relayer + the relayer's `/api/info`
  reachable (`bash scripts/dev.sh --apps pay --mock`). Tracked
  as a follow-up: write the first end-to-end spec that boots
  the stack and walks a single-recipient payout.
- **WETH end-to-end** — see the manual checklist at
  `docs/operations/qa-pay-weth-transferout.md`. The Playwright
  conversion is gated on the dev.sh-driven follow-up above.
- **Multi-tier proving** — same gating; once the dev.sh-driven
  spec lands, vary the recipient count to exercise tier 64 / 128.

## Permanently unsupported

- **`eth_signTransaction` / raw `eth_sign`** — even with
  `privateKey`, these throw on purpose. Pay doesn't use them;
  any test that hits them is exercising a regression worth
  failing loudly over.

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
├── playwright.config.ts          # browser projects + webServer
└── e2e/
    ├── README.md                 # this file
    ├── _helpers/
    │   └── test-wallet.ts        # injected EIP-1193 bridge for
    │                             # wallet-driven specs
    ├── landing.spec.ts           # `/`, `/dashboard` smoke
    ├── wallet-bridge.spec.ts     # auto-connect via the test wallet
    └── wizard.spec.ts            # `/payouts/new` entry-screen smoke
```

`fullyParallel: true` parallelises both **across** spec files AND
**within** a single file — every test runs in its own worker /
browser context, so a test that needs ordering with another test
must opt in explicitly via `test.describe.serial(...)`. Today no
spec shares state (each test navigates fresh, no workspace folder
or vault is reused), so the default is correct as-is.

## Adding tests

- **Wallet-less**: lean on the existing static pages — landing,
  payslip print route (with seeded query params), claim page (the
  link generator can produce a deterministic stealth address).
- **Wallet-needed (read-only)**: import `installTestWallet` from
  `_helpers/test-wallet.ts` and call it before `page.goto(...)`.
  Pay's `useWallet` boots into the connected state on
  `eth_accounts`; chain id is mocked locally; everything else
  forwards to the RPC URL you pass (defaults to `127.0.0.1:8545`,
  i.e. `dev.sh --mock`'s anvil).
- **Wallet-needed (signing)**: pass `privateKey` (matching
  `account`) to `installTestWallet`; the bridge wires
  `personal_sign` / `eth_signTypedData_v4` / `eth_sendTransaction`
  through a node-side `ethers.Wallet`. `eth_sendTransaction`
  populates + broadcasts via the configured `rpcUrl`, so any test
  that hits it must be running against a live anvil (or another
  RPC happy to accept the broadcast).

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
