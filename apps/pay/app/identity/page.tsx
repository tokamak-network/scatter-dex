"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ethers } from "ethers";
import { shortAddr, useWallet } from "@zkscatter/sdk/react";
import {
  useIdentityStatus,
  useIdentityGateAdmin,
} from "../_lib/identity";
import { getNetworkConfig } from "../_lib/network";
import { getSharedProvider } from "../_lib/sharedProvider";
import { ZK_X509_URL } from "../_lib/features";

/** Minimal ABI fragments to read the human-readable registry name.
 *  zk-X509's IdentityRegistry stores its name on the parent
 *  RegistryFactory (under `registryInfo[<registry>].name`), so we
 *  hop registry → factory → registryInfo to surface a friendly
 *  label here. Legacy registries deployed without a factory return
 *  `address(0)` from `factory()` and fall back to address-only. */
const REGISTRY_FACTORY_LINK_ABI = [
  "function factory() view returns (address)",
];
const REGISTRY_FACTORY_INFO_ABI = [
  "function registryInfo(address) view returns (address creator, string name, uint32 maxWallets, uint8 minDisclosureMask, uint256 maxProofAge, uint256 createdAt, uint256 vKeyVersion)",
];

/** Build a per-registry deep-link to the external zk-X509 site,
 *  landing on the `register` tab so the user goes straight to the
 *  registration form instead of the read-only overview. Returns
 *  null when `NEXT_PUBLIC_PAY_ZK_X509_URL` is empty — we'd rather
 *  omit the link than dangle a broken target. */
function zkX509RegistryUrl(address: string): string | null {
  if (!ZK_X509_URL) return null;
  try {
    const url = new URL(
      `${ZK_X509_URL.replace(/\/$/, "")}/registry/${encodeURIComponent(address)}`,
    );
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.searchParams.set("tab", "register");
    return url.toString();
  } catch {
    return null;
  }
}

/** Resolve `{addressLower → registryName}` for the trusted-authorities
 *  list. Names come from each registry's factory metadata; legacy
 *  registries (no factory) get `null` and the UI falls back to
 *  showing the address only. Returns a stable map keyed by the
 *  lowercased address, suitable for direct lookup during render. */
function useRegistryNames(addresses: readonly string[]): Record<string, string | null> {
  const [names, setNames] = useState<Record<string, string | null>>({});
  const cfg = getNetworkConfig();
  // Memoise on the canonical comma-joined list so a re-render with
  // the same addresses in a different array reference doesn't refire.
  const key = addresses.map((a) => a.toLowerCase()).join(",");
  useEffect(() => {
    if (!addresses.length) {
      setNames({});
      return;
    }
    let cancelled = false;
    const provider = getSharedProvider(cfg.rpcUrl);
    void (async () => {
      const entries = await Promise.all(
        addresses.map(async (addr) => {
          try {
            const reg = new ethers.Contract(addr, REGISTRY_FACTORY_LINK_ABI, provider);
            const factoryAddr = (await reg.factory()) as string;
            if (!factoryAddr || factoryAddr === ethers.ZeroAddress) {
              return [addr.toLowerCase(), null] as const;
            }
            const factory = new ethers.Contract(factoryAddr, REGISTRY_FACTORY_INFO_ABI, provider);
            const info = await factory.registryInfo(addr);
            const name = (info?.name ?? info?.[1] ?? "") as string;
            return [addr.toLowerCase(), name.trim() || null] as const;
          } catch {
            return [addr.toLowerCase(), null] as const;
          }
        }),
      );
      if (cancelled) return;
      setNames(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, cfg.rpcUrl]);
  return names;
}

/** Placeholder identity hub. Scatter Pay reads zk-X509
 *  verification status from the on-chain `IdentityGate`, but the
 *  actual certificate-proof workflow lives in the separate
 *  `zk-X509` project (SP1 zkVM, X.509 cert handling). This page
 *  surfaces the user's current status and points them at the
 *  external registration flow rather than trying to host the
 *  proof generation inside Pay. */
export default function IdentityPage() {
  const { state, refresh } = useIdentityStatus();
  const { account } = useWallet();
  const cfg = getNetworkConfig();
  const { snapshot, loading: adminLoading } = useIdentityGateAdmin();
  const registryNames = useRegistryNames(snapshot?.registries ?? []);
  const needsRegistration =
    state.kind === "unverified" ||
    state.kind === "expired" ||
    state.kind === "expiring" ||
    state.kind === "error";

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Identity</h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          Scatter Pay requires zk-X509 verification for both senders and
          recipients. Verification ties your wallet to a real-world
          identity proof (NPKI, government eID, corporate CA, etc.)
          without revealing personal data on-chain.
        </p>
      </div>

      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <h2 className="text-base font-medium">Your status</h2>
        <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-[var(--color-text-muted)]">Connected wallet</dt>
          <dd className="font-mono text-xs">{account ?? "—"}</dd>
        </dl>
        <div className="mt-3 text-sm">
          <StatusLine state={state} />
        </div>
        {needsRegistration && (
          <p className="mt-2 text-xs text-[var(--color-text-muted)]">
            {state.kind === "expiring" || state.kind === "expired"
              ? "Renew your registration on one of the trusted registries listed below."
              : state.kind === "error"
                ? "Open one of the trusted registries below to check your registration directly on zk-X509."
                : "Pick a trusted registry below and complete registration on its zk-X509 site."}
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={refresh}
            className="rounded-md border border-[var(--color-border-strong)] px-3 py-1 text-xs hover:bg-[var(--color-primary-soft)]"
          >
            Refresh status
          </button>
        </div>
      </section>

      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <h2 className="text-base font-medium">Trusted authorities</h2>
        <p className="mt-2 text-sm text-[var(--color-text-muted)]">
          This deployment recognises the following{" "}
          <code className="font-mono">IdentityRegistry</code> contracts.
          Verifying through any of them satisfies the gate.
        </p>
        <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-[var(--color-text-muted)]">IdentityGate</dt>
          <dd className="font-mono text-xs">
            {cfg.contracts.identityGate || "—"}
          </dd>
        </dl>
        {adminLoading && !snapshot ? (
          <p className="mt-3 text-xs text-[var(--color-text-muted)]">
            Loading registries…
          </p>
        ) : !snapshot ? (
          <p className="mt-3 text-xs text-[var(--color-text-muted)]">
            Connect a wallet to load the registry list.
          </p>
        ) : snapshot.registries.length === 0 ? (
          <p className="mt-3 text-xs text-[var(--color-text-muted)]">
            No registries configured.
          </p>
        ) : (
          <ul className="mt-3 space-y-1.5 text-sm">
            {snapshot.registries.map((addr) => {
              const zkUrl = zkX509RegistryUrl(addr);
              const name = registryNames[addr.toLowerCase()];
              return (
                <li
                  key={addr}
                  className="flex flex-col gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-[var(--color-text)]">
                      {name ?? <span className="text-[var(--color-text-muted)]">Unnamed registry</span>}
                    </div>
                    <div
                      className="truncate font-mono text-[10px] text-[var(--color-text-subtle)]"
                      title={addr}
                    >
                      {shortAddr(addr)} · {addr}
                    </div>
                  </div>
                  {zkUrl && (
                    <a
                      href={zkUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={
                        state.kind === "verified"
                          ? "View your registration on zk-X509 (new tab)"
                          : "Register an identity with this CA on zk-X509 (new tab)"
                      }
                      className="whitespace-nowrap text-[10px] text-[var(--color-primary)] underline-offset-2 hover:underline"
                    >
                      {state.kind === "verified"
                        ? "View on zk-X509 ↗"
                        : "Register with zk-X509 ↗"}
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <h2 className="text-base font-medium">How to register or renew</h2>
        <p className="mt-2 text-sm text-[var(--color-text-muted)]">
          Pay reads verification status on-chain but doesn't run the
          certificate proof itself — that lives on each trusted
          registry's zk-X509 site. Pick a registry from the list above
          and follow its registration flow.
        </p>
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-[var(--color-text-muted)]">
          <li>Click <em>Register with zk-X509 ↗</em> next to a registry above.</li>
          <li>On its site, select your certificate (NPKI / corporate CA / etc.) and complete the proof.</li>
          <li>Submit the on-chain registration tx (one-time, gas-paid by you).</li>
          <li>Return here — your status updates within ~30 seconds, or click Refresh status above.</li>
        </ol>
        <p className="mt-3 text-xs text-[var(--color-text-subtle)]">
          Don't see a registry that matches your certificate? Ask the
          service operator which CA they recognise for this deployment.
        </p>
      </section>

      <div className="flex justify-between text-xs">
        <Link
          href="/"
          className="text-[var(--color-primary)] hover:underline"
        >
          ← Back to home
        </Link>
        <Link
          href="/dashboard"
          className="text-[var(--color-primary)] hover:underline"
        >
          Go to dashboard →
        </Link>
      </div>
    </div>
  );
}

function StatusLine({ state }: { state: ReturnType<typeof useIdentityStatus>["state"] }) {
  switch (state.kind) {
    case "verified":
      return (
        <span className="text-[var(--color-success)]">
          ✓ Verified ·{" "}
          {state.indefinite
            ? "no expiry on file"
            : `expires ${new Date(state.expiresAt * 1000).toLocaleString()}`}
        </span>
      );
    case "expiring":
      return (
        <span className="text-[var(--color-warning)]">
          ⌛ Verified, but renew soon · expires{" "}
          {new Date(state.expiresAt * 1000).toLocaleString()}
        </span>
      );
    case "expired":
      return (
        <span className="text-[var(--color-danger)]">
          ⛔ Expired at {new Date(state.expiresAt * 1000).toLocaleString()}
        </span>
      );
    case "unverified":
      return (
        <span className="text-[var(--color-danger)]">
          ⚠ Not verified — pick a registry below and complete registration on
          its zk-X509 site.
        </span>
      );
    case "loading":
      return (
        <span className="text-[var(--color-text-muted)]">
          ⏳ Checking registry…
        </span>
      );
    case "disconnected":
      return (
        <span className="text-[var(--color-text-muted)]">
          Connect your wallet to see your status.
        </span>
      );
    case "error":
      return (
        <span className="text-[var(--color-danger)]">
          ✕ Lookup failed: {state.message}
        </span>
      );
  }
}
