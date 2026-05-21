"use client";

import { useCallback, useState } from "react";
import { Contract, type Signer } from "ethers";
import { isConfiguredAddress } from "@zkscatter/sdk";
import { useWallet } from "@zkscatter/sdk/react";
import { IDENTITY_REGISTRY_ADDRESS, DEMO_NETWORK } from "../../lib/network";
import { explainError } from "../../lib/format";
import { isValidEvmAddress } from "../../lib/x509";

// Minimal write ABI matching MockIdentityRegistry (the in-repo test
// registry the local + Sepolia dev deployments use). The production
// zk-X509 registry exposes a richer attestation surface; that wiring
// lives in the zk-X509 project. Targeting the boolean form here keeps
// the admin console testable end-to-end against the mock without
// pulling in the external project's ABI.
const REGISTRY_ABI = [
  "function setVerified(address user, bool status) external",
];

type Phase =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; txHash: string }
  | { kind: "error"; msg: string };

export function AttestationPanel() {
  const { account, signer, connect } = useWallet();
  const [address, setAddress] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const registryConfigured = isConfiguredAddress(IDENTITY_REGISTRY_ADDRESS);
  const addressValid = isValidEvmAddress(address.trim());

  const submit = useCallback(async () => {
    if (!signer || !registryConfigured || !addressValid) return;
    setPhase({ kind: "submitting" });
    try {
      const tx = await writeAttestation(signer, address.trim(), true);
      const receipt = await tx.wait();
      setPhase({ kind: "success", txHash: receipt?.hash ?? tx.hash });
    } catch (err) {
      setPhase({ kind: "error", msg: explainError(err) });
    }
  }, [signer, registryConfigured, addressValid, address]);

  if (!registryConfigured) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-sm text-[var(--color-text-muted)]">
        <p>
          On-chain attestation disabled. Set{" "}
          <code className="font-mono">NEXT_PUBLIC_IDENTITY_REGISTRY_ADDRESS</code> in this
          app's environment to enable direct{" "}
          <code className="font-mono">setVerified()</code> writes from the connected admin
          wallet.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="mb-3 text-xs text-[var(--color-text-muted)]">
        Calls{" "}
        <code className="font-mono">
          IdentityRegistry({IDENTITY_REGISTRY_ADDRESS.slice(0, 10)}…).setVerified(operator, true)
        </code>{" "}
        on <strong>{DEMO_NETWORK.name}</strong>. The connected wallet must hold the
        registry's admin key.
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

async function writeAttestation(signer: Signer, addr: string, status: boolean) {
  const registry = new Contract(IDENTITY_REGISTRY_ADDRESS, REGISTRY_ABI, signer);
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
