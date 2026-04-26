# Brand Direction

The visual and verbal direction shared across all zkScatter
frontends (Pro / Pay / Drop / Mobile).

## North star

> **A bright, trustworthy, regulator-friendly product. Closer to a
> modern fintech (Mercury, Linear, Wise) than a dark-mode crypto
> dashboard.**

We are deliberately *not* the dark, neon, "cypherpunk" aesthetic
that most privacy-coin / mixer products lean into. That aesthetic
codes "fringe / risky / sanctioned" to the audience we want
(semi-pro traders, finance ops, token teams) and to the regulators
they answer to.

## Theme: light by default

- **All frontends ship light theme as the default and primary mode.**
- Dark mode is acceptable as a user-toggled option, **never the
  landing-page default**.
- Mobile already ships light — keep it that way.
- `apps/pay/` and `apps/drop/` scaffolds are light from day one.
- `frontend/` (Pro) currently ships dark only — convert to light
  during the reposition (see `PRO_REPOSITION.md`).

## Color principles

### Per-app accent (lets each frontend feel distinct without
breaking the master brand)

| App | Primary | Why |
| --- | --- | --- |
| Pro | Blue `#2563eb` (or current cyan-tinged blue) | Trading tools convention; calm, not aggressive |
| Pay | Blue `#2563eb` | Fintech / B2B convention (Mercury, Stripe) |
| Drop | Purple `#7c3aed` | Festive / event feel without going neon |

### Surfaces (shared across all apps)

- Background: `#f7f8fb` (off-white, not pure white — easier on
  long-session eyes)
- Surface (cards): `#ffffff`
- Border: `#e5e7eb`
- Text: `#111827` (primary), `#6b7280` (muted), `#9ca3af` (subtle)

These tokens are codified in each app's `app/globals.css` and will
move to `packages/ui/tokens/*` when the shared package is extracted.

## Typography

- **Inter** for UI everywhere.
- Optional: Manrope for marketing display (only on landing page heroes).
- No futuristic / mono display fonts as the primary face.
- Mono (`ui-monospace`) only for addresses, hashes, amounts.

## Imagery & iconography

- **Lucide** icons (already in use). Outline weight, not filled.
- Avoid:
  - Hooded-figure / anonymity imagery
  - Neon glow effects
  - Lock icons everywhere (over-signals "we're hiding things")
- Prefer:
  - Clean geometric shapes (circles, dots, abstract gradients)
  - Architectural / financial-journal photography on marketing pages
  - Illustration style: light, minimal, two-tone (e.g. blob shapes
    in primary + neutral)

## Verbal tone

We speak in **plain language about ordinary needs**, not crypto
jargon about exotic capabilities.

| Avoid | Prefer |
| --- | --- |
| "Trustless mixer" | "Private receive" |
| "Anonymous" | "Not exposed on public dashboards" |
| "Untraceable" | "Doesn't leak balance information" |
| "Tornado-style" | (never) |
| "Cypherpunk" | (never) |
| "Compliant" | (sparingly — show, don't tell) |
| "KYC'd" | "Verified once, privately" |

The product is privacy-respecting *and* lawful. Both halves matter;
overclaiming the first half scares both customers and regulators.

## Trust signals (always visible)

Every frontend should show, in the footer or a header badge:

- **zk-X509 verified** badge when the user has completed identity
  verification (header)
- "Powered by zkScatter" with link to a one-page explainer of the
  Dual-CA model (footer)
- Network / chain indicator (footer)
- "Tokamak Network · KISA-registered relayers" (footer)

These are deliberately small and persistent — they reassure without
shouting.

## Compliance-bright positioning (the message)

When describing the product to outsiders, use this 3-beat structure:

1. **What it does**: "Private trading and payments on Ethereum L2."
2. **What makes it different**: "Without leaking your balance to
   the public, and without front-running."
3. **Why it's safe to use**: "Built on Dual-CA: users verify
   identity privately once, relayers are publicly registered. No
   anonymous mixing. Audit trail preserved."

The third beat is non-negotiable. It's what separates zkScatter
from the privacy products that get sanctioned.

## Per-app landing page hero (suggested copy)

**Pro**
> Big trades. No front-running. No balance exposure. Fully legal.
> *Private limit orders for serious traders.*

**Pay**
> Pay your team in one transaction. They can't see each other's
> amounts.
> *Private payroll and vendor payouts for crypto-native companies.*

**Drop**
> Get your token to real humans, not bot farms.
> *Sybil-resistant private airdrops with gasless claim.*

All three bake compliance and trust into the *implication* of the
copy, not the foreground. Foreground is the customer outcome.

## Design references to pull from

- **Mercury** (banking) — light, friendly, B2B-trustworthy
- **Linear** (project mgmt) — restrained UI density, great empty
  states
- **Wise** (cross-border payments) — explains complex compliance
  cleanly to consumers
- **Trust Wallet** (mobile) — light theme done well in crypto

Not references:
- Tornado Cash (any era)
- Aztec / Privacy Pools dashboards (too "lab" looking)
- Most DEX dashboards (too dense, dark, neon)
