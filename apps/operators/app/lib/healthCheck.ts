/** Pure mappings used by the onboarding `HealthCheck` card, lifted
 *  out of `StatusChecks.tsx` so the state→pill translation and the
 *  "what's actually wrong?" detail string can be exercised by tests
 *  without rendering the relayer's `/health` flow. */

/** Five-state model the StatusChecks page uses across every card
 *  (wallet, chain, RPC, registration, bond, health). Kept here as
 *  a string union — broad enough to cover the lifecycle of any
 *  async probe. */
export type CheckStatus = "ok" | "warn" | "fail" | "pending" | "skip";

/** Full state-machine of the HealthCheck card. Lives here so the
 *  page-local state and the `healthCheckStatus` mapper share a
 *  single source of truth: adding a sixth kind on either side now
 *  surfaces as a TS error in the switch below, instead of silently
 *  drifting. The payload fields (`uptime`, `checks`, `reason`)
 *  travel with the union so the page consumes them with the same
 *  discriminator. */
export type HealthCheckState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; uptime: number; checks: Record<string, string> }
  | { kind: "degraded"; checks: Record<string, string> }
  | { kind: "fail"; reason: string };

export type HealthCheckKind = HealthCheckState["kind"];

/** Translate the HealthCheck's internal state-machine into the
 *  shared pill status. `degraded` maps to `warn` (one or more sub-
 *  checks failed, but the service responded), `fail` to `fail`
 *  (request didn't complete), `loading` to `pending`, and `idle`
 *  to `skip` (user hasn't pressed Ping yet).
 *
 *  The `never`-typed `default` branch is the TS-level guarantee
 *  that every `HealthCheckKind` is handled — if a new kind is added
 *  upstream without a case here, this file stops compiling. */
export function healthCheckStatus(kind: HealthCheckKind): CheckStatus {
  switch (kind) {
    case "ok":
      return "ok";
    case "degraded":
      return "warn";
    case "fail":
      return "fail";
    case "loading":
      return "pending";
    case "idle":
      return "skip";
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

/** Summarize the failed entries of a `checks` map returned by the
 *  relayer's `/health` endpoint. Used in the degraded-state copy so
 *  the operator sees which sub-check is failing instead of a generic
 *  "degraded" banner. Empty / all-`ok` input → "no detail" (we
 *  reached the endpoint but it didn't tell us what's wrong).
 *  Pure / deterministic; entries preserve insertion order. */
export function summarizeFailedChecks(checks: Record<string, string>): string {
  const failed = Object.entries(checks)
    .filter(([, v]) => v !== "ok")
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
  return failed || "no detail";
}
