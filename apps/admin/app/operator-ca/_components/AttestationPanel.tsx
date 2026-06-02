"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Contract, type Signer } from "ethers";
import { isConfiguredAddress } from "@zkscatter/sdk";
import { useWallet } from "@zkscatter/sdk/react";
import { DEMO_NETWORK } from "../../lib/network";
import { explainError } from "../../lib/format";
import { isValidEvmAddress } from "../../lib/x509";

// Minimal write ABI matching MockIdentityRegistry (the in-repo test
// registry the local + Sepolia dev deployments use). The production
// zk-X509 registry exposes a richer attestation surface (proof-based
// `register()`, not an admin boolean); that wiring lives in the zk-X509
// project. Targeting the boolean form here keeps the admin console
// testable end-to-end against the mock without pulling in the external
// project's ABI — against a real zk-X509 registry the write reverts and
// surfaces in the error banner, which is the signal to verify operators
// via the zk-X509 desktop app / dashboard instead.
const REGISTRY_ABI = [
  "function setVerified(address user, bool status) external",
];

type Phase =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; txHash: string }
  | { kind: "error"; msg: string };

/** `registryAddress` is read on-chain from `RelayerRegistry.identityRegistry()`
 *  by the parent page (see useRelayerIdentityRegistry) — null/zero means the
 *  relayer CA isn't wired yet. `loading` is that read in flight. */
export function AttestationPanel({
  registryAddress,
  loading,
}: {
  registryAddress: string | null;
  loading?: boolean;
}) {
  const { account, signer, connect, readProvider } = useWallet();
  const [address, setAddress] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  // null = still probing; true = real zk-X509 registry (responds to
  // effectiveProgramVKey()); false = mock (the call reverts). A real
  // registry has no admin setVerified — the boolean form below would just
  // revert — so we hide it and point the admin at the desktop/dashboard.
  const [isRealRegistry, setIsRealRegistry] = useState<boolean | null>(null);

  const registryConfigured = isConfiguredAddress(registryAddress ?? "");
  const addressValid = isValidEvmAddress(address.trim());

  useEffect(() => {
    if (!registryConfigured || !registryAddress || !readProvider) {
      setIsRealRegistry(null);
      return;
    }
    let cancelled = false;
    const c = new Contract(
      registryAddress,
      ["function effectiveProgramVKey() view returns (bytes32)"],
      readProvider,
    );
    (c.effectiveProgramVKey() as Promise<string>)
      .then(() => { if (!cancelled) setIsRealRegistry(true); })
      .catch((err: unknown) => {
        if (cancelled) return;
        // A mock registry has no effectiveProgramVKey → the call reverts
        // (CALL_EXCEPTION/BAD_DATA). Only that means "mock". A transient RPC
        // error (network/timeout) is inconclusive — stay in the probing state
        // rather than mislabel a real registry as mock.
        const code = (err as { code?: string } | null)?.code;
        setIsRealRegistry(code === "CALL_EXCEPTION" || code === "BAD_DATA" ? false : null);
      });
    return () => { cancelled = true; };
  }, [registryConfigured, registryAddress, readProvider]);

  const submit = useCallback(async () => {
    if (!signer || !registryConfigured || !registryAddress || !addressValid) return;
    setPhase({ kind: "submitting" });
    try {
      const tx = await writeAttestation(signer, registryAddress, address.trim(), true);
      const receipt = await tx.wait();
      setPhase({ kind: "success", txHash: receipt?.hash ?? tx.hash });
    } catch (err) {
      setPhase({ kind: "error", msg: explainError(err) });
    }
  }, [signer, registryConfigured, registryAddress, addressValid, address]);

  // Read-only lookup of an operator's on-chain verification status on a REAL
  // zk-X509 registry (gate 1). The admin can't attest here, but they CAN
  // confirm the operator actually proved their cert (isVerified == true)
  // before approving KYC (gate 2). If not verified, surface the deep-link to
  // that registry's register tab so the operator can go prove.
  const [verifyCheck, setVerifyCheck] = useState<
    | { kind: "idle" }
    | { kind: "checking" }
    | { kind: "result"; addr: string; verified: boolean }
    | { kind: "error"; msg: string }
  >({ kind: "idle" });

  const zkX509Base = (
    process.env.NEXT_PUBLIC_ZK_X509_URL || "http://localhost:3000"
  ).replace(/\/+$/, "");
  const registerUrl = registryAddress
    ? `${zkX509Base}/registry/${registryAddress}?tab=register`
    : null;

  const checkSeq = useRef(0);
  const checkVerified = useCallback(async () => {
    if (!readProvider || !registryAddress || !addressValid) return;
    const addr = address.trim();
    const seq = ++checkSeq.current;
    setVerifyCheck({ kind: "checking" });
    try {
      const c = new Contract(
        registryAddress,
        ["function isVerified(address) view returns (bool)"],
        readProvider,
      );
      const verified = (await c.isVerified(addr)) as boolean;
      // Ignore a stale response if a newer check started meanwhile.
      if (seq === checkSeq.current) setVerifyCheck({ kind: "result", addr, verified });
    } catch (err) {
      if (seq === checkSeq.current) setVerifyCheck({ kind: "error", msg: explainError(err) });
    }
  }, [readProvider, registryAddress, addressValid, address]);

  if (loading) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-sm text-[var(--color-text-muted)]">
        <p>Reading the relayer CA registry on-chain…</p>
      </div>
    );
  }

  if (!registryConfigured || !registryAddress) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-sm text-[var(--color-text-muted)]">
        <p>
          On-chain attestation disabled —{" "}
          <code className="font-mono">RelayerRegistry.identityRegistry()</code> isn't set.
          Wire the relayer CA on the <strong>Identity (relayer)</strong> tab to enable
          direct <code className="font-mono">setVerified()</code> writes from the connected
          admin wallet.
        </p>
      </div>
    );
  }

  if (isRealRegistry === true) {
    const r = verifyCheck;
    return (
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <div className="mb-3 text-xs text-[var(--color-text-muted)]">
          <code className="font-mono">{registryAddress.slice(0, 10)}…</code> is a real{" "}
          <strong>zk-X509</strong> registry — no admin{" "}
          <code className="font-mono">setVerified()</code>. Operators flip{" "}
          <code className="font-mono">isVerified</code> themselves by proving their accredited
          certificate (delegated proving). Check an operator&apos;s on-chain verification
          status here, then use the <strong>Compliance cross-check</strong> below before
          approving.
        </div>

        <label className="block text-sm">
          <span className="mb-1 block text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
            Operator wallet to check
          </span>
          <input
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-sm"
            placeholder="0x…"
            value={address}
            onChange={(e) => { setAddress(e.target.value); setVerifyCheck({ kind: "idle" }); }}
          />
        </label>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={!addressValid || r.kind === "checking"}
            onClick={() => void checkVerified()}
            className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {r.kind === "checking" ? "Checking…" : "Check on-chain verification"}
          </button>
          {address && !addressValid && (
            <span className="text-xs text-[var(--color-danger)]">
              Must be a 0x-prefixed 20-byte address
            </span>
          )}
        </div>

        {r.kind === "result" && r.verified && (
          <div className="mt-4 rounded-md border border-[var(--color-success)] bg-[var(--color-success-soft)] px-3 py-2 text-sm text-[var(--color-success)]">
            ✓ <code className="font-mono">{r.addr.slice(0, 10)}…</code> is verified on-chain
            (zk-X509 proof accepted). Gate 1 satisfied — proceed to the compliance cross-check.
          </div>
        )}
        {r.kind === "result" && !r.verified && (
          <div className="mt-4 rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-3 py-2 text-sm">
            <div className="font-medium">
              ✗ <code className="font-mono">{r.addr.slice(0, 10)}…</code> is not verified on-chain yet
            </div>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              The operator hasn&apos;t proved their certificate to this registry. Send them to the
              zk-X509 register page{registerUrl ? "" : " (set NEXT_PUBLIC_ZK_X509_URL to enable the link)"}:
            </p>
            {registerUrl && (
              <a
                href={registerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-block rounded-md border border-[var(--color-border-strong)] bg-white px-2.5 py-1 text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-primary-soft)]"
              >
                Open zk-X509 register page ↗
              </a>
            )}
          </div>
        )}
        {r.kind === "error" && <ErrorBanner msg={r.msg} />}
      </div>
    );
  }

  // Still probing real-vs-mock (or an inconclusive/transient RPC error):
  // don't flash the mock setVerified form before we know which it is.
  if (isRealRegistry === null) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-sm text-[var(--color-text-muted)]">
        <p>Detecting registry type on-chain…</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="mb-3 text-xs text-[var(--color-text-muted)]">
        Calls{" "}
        <code className="font-mono">
          IdentityRegistry({registryAddress.slice(0, 10)}…).setVerified(operator, true)
        </code>{" "}
        on <strong>{DEMO_NETWORK.name}</strong>. The connected wallet must hold the
        registry's admin key. (A real zk-X509 registry has no admin
        <code className="font-mono">setVerified</code> — verify operators via the zk-X509
        desktop app / dashboard instead; this boolean form is for the mock registry.)
      </div>

      <label className="block text-sm">
        <span className="mb-1 block text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
          Operator wallet to attest
        </span>
        <input
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-sm"
          placeholder="0x…"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
      </label>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {!account ? (
          <button
            type="button"
            onClick={() => void connect()}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-sm font-medium hover:bg-[var(--color-bg)]"
          >
            Connect admin wallet
          </button>
        ) : (
          <button
            type="button"
            disabled={!addressValid || phase.kind === "submitting"}
            onClick={() => void submit()}
            className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {phase.kind === "submitting" ? "Submitting…" : "Submit attestation"}
          </button>
        )}
        {address && !addressValid && (
          <span className="text-xs text-[var(--color-danger)]">
            Must be a 0x-prefixed 20-byte address
          </span>
        )}
      </div>

      {phase.kind === "success" && <SuccessBanner txHash={phase.txHash} />}
      {phase.kind === "error" && <ErrorBanner msg={phase.msg} />}
    </div>
  );
}

async function writeAttestation(
  signer: Signer,
  registryAddress: string,
  addr: string,
  status: boolean,
) {
  const registry = new Contract(registryAddress, REGISTRY_ABI, signer);
  return (await registry.setVerified(addr, status)) as {
    hash: string;
    wait(): Promise<{ hash?: string } | null>;
  };
}

function SuccessBanner({ txHash }: { txHash: string }) {
  const explorer = DEMO_NETWORK.explorerBase;
  const url = explorer ? buildTxUrl(explorer, txHash) : null;
  return (
    <div className="mt-4 rounded-md border border-[var(--color-success)] bg-[var(--color-success-soft)] px-3 py-2 text-sm text-[var(--color-success)]">
      Attestation confirmed.{" "}
      {url ? (
        <a href={url} target="_blank" rel="noopener noreferrer" className="underline">
          {txHash.slice(0, 10)}… ↗
        </a>
      ) : (
        <code className="font-mono">{txHash.slice(0, 10)}…</code>
      )}
    </div>
  );
}

function ErrorBanner({ msg }: { msg: string }) {
  return (
    <div className="mt-4 rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]">
      {msg}
    </div>
  );
}

function buildTxUrl(explorerBase: string, hash: string): string | null {
  try {
    const u = new URL(`/tx/${encodeURIComponent(hash)}`, explorerBase);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.toString();
  } catch {
    return null;
  }
}
