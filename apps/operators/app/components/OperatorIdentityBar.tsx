import Link from "next/link";
import {
  MOCK_OPERATOR,
  operatorInitials,
  safeOperatorUrl,
  shortenAddress,
  type OperatorStatus,
} from "../lib/mockOperator";

/** Top-of-page identity banner for operator-scoped views
 *  (`/dashboard`, `/profile`, `/treasury`, `/orders`). Makes it
 *  unambiguous which relayer the page's data belongs to —
 *  particularly important since the same UI is multi-tenant: every
 *  visitor sees a per-operator scope once their wallet is wired up
 *  (mock identity in v1).
 *
 *  Excluded from `/`, `/register`, `/leaderboard` — those are
 *  network-wide / pre-registration views. */
export function OperatorIdentityBar() {
  // Derived from `op` inside the body so they stay correct once the
  // identity becomes dynamic via a `useOperator()` hook in v1.1.
  const op = MOCK_OPERATOR;
  const initials = operatorInitials(op.name);
  const shortAddress = shortenAddress(op.address);
  const safeUrl = safeOperatorUrl(op.url);
  return (
    <div className="mb-6 flex items-center justify-between gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <span className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-primary-soft)] font-mono text-xs font-semibold text-[var(--color-primary)]">
          {initials}
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold">{op.name}</span>
            <StatusDot status={op.status} />
          </div>
          <div className="truncate text-xs text-[var(--color-text-muted)]">
            <span className="font-mono" title={op.address}>{shortAddress}</span>
            {safeUrl ? (
              <>
                {" · "}
                <a
                  href={safeUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-[var(--color-text)] hover:underline"
                >
                  {safeUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                </a>
              </>
            ) : op.url ? (
              <>
                {" · "}
                <span
                  className="text-[var(--color-warning)]"
                  title="Endpoint URL has an unsupported scheme; not rendered as a link."
                >
                  endpoint url invalid
                </span>
              </>
            ) : null}
          </div>
        </div>
      </div>
      <Link
        href="/profile"
        prefetch={false}
        className="flex-shrink-0 text-xs font-medium text-[var(--color-primary)] hover:underline"
      >
        Edit profile →
      </Link>
    </div>
  );
}

function StatusDot({ status }: { status: OperatorStatus }) {
  const config = {
    active:   { dot: "bg-[var(--color-success)]", text: "Active" },
    cooldown: { dot: "bg-[var(--color-warning)]", text: "In cool-down" },
    offline:  { dot: "bg-[var(--color-text-subtle)]", text: "Offline" },
  }[status];
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text-muted)]">
      <span className={`h-1.5 w-1.5 rounded-full ${config.dot}`} />
      {config.text}
    </span>
  );
}
