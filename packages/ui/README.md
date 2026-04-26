# @zkscatter/ui

Shared design tokens and primitive React components for zkScatter
frontends.

Each app picks **one** theme by importing the matching token CSS
file. Components consume CSS variables, so a theme swap is one
import line.

## Status

**Phase 0 (current)**: theme tokens only. Themes ship as plain CSS
files (Tailwind v4-compatible `@theme inline { … }` blocks) for:

- `pro.css` — semi-pro / OTC traders (light, blue accent `#0ea5e9`)
- `pay.css` — small companies & DAOs (light, blue accent `#2563eb`)
- `drop.css` — token launch teams (light, purple accent `#7c3aed`)

All three share a common neutral surface palette to reinforce the
master brand. See `docs/product/BRAND_DIRECTION.md` for the rules.

## Usage

```css
/* apps/pro/app/globals.css */
@import "@zkscatter/ui/tokens/pro.css";
@import "tailwindcss";
```

Tailwind utilities then resolve against the imported variables
(`text-[var(--color-primary)]`, `bg-[var(--color-surface)]`, etc.).

## Roadmap

| Phase | Adds | Notes |
| --- | --- | --- |
| 0 (this PR) | token CSS files | done |
| 1 | `Button`, `Input`, `Modal` | replace inline styles in apps |
| 2 | `Stepper`, `EmptyState`, `StatCard` | extracted from app dupes |
| 3 | `ConnectWalletButton` | depends on `@zkscatter/sdk/react` wallet hook |

## Design rules

1. **CSS variables only.** Components never hardcode colors. Theme
   files own the palette.
2. **Layout, not opinion.** Components handle structure (focus
   trap, keyboard, ARIA), not page-level layout. Apps compose.
3. **Brandless by default.** A primitive must look reasonable under
   any of the three themes without per-theme overrides.
