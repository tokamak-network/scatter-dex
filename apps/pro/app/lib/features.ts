/** Build-time feature flags for the Pro app. Sourced from
 *  `NEXT_PUBLIC_*` envs at compile time so the values inline into
 *  the client bundle and unused branches tree-shake away.
 *
 *  Each access has to be a *literal* `process.env.NEXT_PUBLIC_*`
 *  key — see the comment in `network.ts` for why dynamic lookup
 *  doesn't survive the Next bundler. */

/** Deep-link to the external zk-X509 registration / inspection
 *  app. Surfaced on the IdentityMenu and next to the admin
 *  "Add registry" form so operators can paste the resulting
 *  contract address straight in. Default matches zk-X509's
 *  `next dev` default port. */
export const ZK_X509_URL =
  process.env.NEXT_PUBLIC_ZK_X509_URL ?? "http://localhost:3000";
