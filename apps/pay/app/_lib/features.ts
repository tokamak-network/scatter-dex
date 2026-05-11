/** Build-time feature flags for the Pay app. Sourced from
 *  `NEXT_PUBLIC_*` envs at compile time so the values inline into
 *  the client bundle and unused branches tree-shake away.
 *
 *  Each access has to be a *literal* `process.env.NEXT_PUBLIC_*`
 *  key — see the comment in `network.ts` for why dynamic lookup
 *  doesn't survive the Next bundler. */

/** Stealth meta-address support (Stealth menu, address-book
 *  meta-address field/column, stealth pill). Off by default; only
 *  enabled when the deploy sets
 *  `NEXT_PUBLIC_PAY_STEALTH_ENABLED=true`. */
export const STEALTH_ENABLED =
  process.env.NEXT_PUBLIC_PAY_STEALTH_ENABLED === "true";
