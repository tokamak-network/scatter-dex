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

/** Deep-link to the external zk-X509 registration / inspection
 *  app. Surfaced on the user-facing /identity page and next to
 *  the admin "Add registry" form so operators can paste the
 *  resulting contract address straight in. Empty string = no
 *  link is rendered. Default `http://localhost:3000` matches
 *  zk-X509's `next dev` default. */
export const ZK_X509_URL =
  process.env.NEXT_PUBLIC_PAY_ZK_X509_URL ?? "http://localhost:3000";
