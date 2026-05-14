/** Build-time feature flags for the Pay app. Sourced from
 *  `NEXT_PUBLIC_*` envs at compile time so the values inline into
 *  the client bundle and unused branches tree-shake away.
 *
 *  Each access has to be a *literal* `process.env.NEXT_PUBLIC_*`
 *  key — see the comment in `network.ts` for why dynamic lookup
 *  doesn't survive the Next bundler. */

/** Deep-link to the external zk-X509 registration / inspection
 *  app. Surfaced on the user-facing /identity page and next to
 *  the admin "Add registry" form so operators can paste the
 *  resulting contract address straight in. Empty string (the
 *  default when `NEXT_PUBLIC_PAY_ZK_X509_URL` is unset) means no
 *  link is rendered — set the env in local dev / deploys that run
 *  a zk-X509 instance so prod never dangles a `localhost` target. */
export const ZK_X509_URL =
  process.env.NEXT_PUBLIC_PAY_ZK_X509_URL ?? "";
