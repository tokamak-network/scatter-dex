import type { Metadata } from "next";
import { APPS, USER_APPS, OPERATOR_APPS } from "../lib/apps";
import { AppCard } from "../components/AppCard";
import { Recommender } from "./Recommender";

export const metadata: Metadata = {
  title: "Apps · zkScatter",
  description:
    "Pro, Pay, Mobile, and Relayer — persona apps on one shared ZK core.",
};

export default function AppsPage() {
  return (
    <>
      <section className="mx-auto max-w-6xl px-6 pt-20 pb-10">
        <h1 className="text-4xl font-semibold tracking-tight md:text-5xl">Apps</h1>
        <p className="mt-3 max-w-2xl text-[var(--color-text-muted)]">
          Three surfaces, one ZK core. Each app is shaped for a single persona —
          same contracts, same circuits, different copy and pricing.
        </p>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-16">
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {USER_APPS.map((app) => (
            <AppCard key={app.id} app={app} />
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-16">
        <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-subtle)]">
          For operators
        </div>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight md:text-3xl">
          Run the network
        </h2>
        <p className="mt-2 max-w-2xl text-[var(--color-text-muted)]">
          Every zkScatter user app runs on a permissionless relayer
          network. Anyone can register a node, match orders, and earn fees.
        </p>
        <div className="mt-6 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
          {OPERATOR_APPS.map((app) => (
            <AppCard key={app.id} app={app} />
          ))}
        </div>
      </section>

      <section className="border-t border-[var(--color-border)] bg-[var(--color-surface-muted)]">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">Compare</h2>
          <div className="mt-6 overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-text-muted)]">
                  <Th>Capability</Th>
                  <Th>Pro</Th>
                  <Th>Pay</Th>
                  <Th>Mobile</Th>
                </tr>
              </thead>
              <tbody>
                <Row cells={["Best for", "Traders", "Treasury", "Everyone"]} />
                <Row cells={["Order types", "Limit", "Bulk payout", "Market"]} />
                <Row cells={["Identity gate", "Opt-in", "Required", "Opt-in"]} />
                <Row cells={["Gasless", "Yes", "Yes", "Yes"]} />
                <Row cells={["Platform", "Web", "Web", "iOS · Android"]} />
                <Row cells={["Pricing", "Maker fee", "Per-tx", "Free"]} last />
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="border-t border-[var(--color-border)]">
        <div className="mx-auto max-w-3xl px-6 py-16">
          <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">
            Not sure which app?
          </h2>
          <p className="mt-2 text-[var(--color-text-muted)]">
            Three quick questions, one recommendation.
          </p>
          <Recommender className="mt-8" />
        </div>
      </section>

      <section
        id="mobile"
        className="border-t border-[var(--color-border)] bg-[var(--color-surface-muted)]"
      >
        <div className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">
            One core. Every app.
          </h2>
          <p className="mt-2 max-w-2xl text-[var(--color-text-muted)]">
            All apps share contracts, circuits, the relayer network, and{" "}
            <code className="font-mono text-sm">@zkscatter/sdk</code>. Fix one
            bug, ship to all four.
          </p>
          <SharedCoreDiagram />
        </div>
      </section>
    </>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider">
      {children}
    </th>
  );
}

function Row({ cells, last = false }: { cells: string[]; last?: boolean }) {
  return (
    <tr className={last ? "" : "border-b border-[var(--color-border)]"}>
      {cells.map((c, i) => (
        <td
          key={i}
          className={`px-4 py-3 ${i === 0 ? "font-medium text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}
        >
          {c}
        </td>
      ))}
    </tr>
  );
}

function SharedCoreDiagram() {
  return (
    <div className="mt-8 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8">
      <div className="grid grid-cols-2 gap-3 text-center text-sm font-medium md:grid-cols-4">
        {APPS.map((a) => (
          <div
            key={a.id}
            className="rounded-md border-l-4 bg-[var(--color-surface-muted)] py-3"
            style={{ borderLeftColor: a.accent }}
          >
            {a.name}
          </div>
        ))}
      </div>
      <div className="my-4 flex justify-center">
        <div className="font-mono text-xs text-[var(--color-text-subtle)]">
          ↓ ↓ ↓ ↓
        </div>
      </div>
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] py-4 text-center font-mono text-sm text-[var(--color-text)]">
        @zkscatter/sdk · contracts · ZK circuits · relayer network
      </div>
    </div>
  );
}
