"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { isConfiguredAddress } from "@zkscatter/sdk";
import { useWallet } from "@zkscatter/sdk/react";
import {
  explainRegisterError,
  loadRegistrationStatus,
  registerRelayer,
  type RegistrationStatus,
} from "@zkscatter/sdk/relayer";
import { DEMO_NETWORK } from "../lib/network";

type Phase =
  | "idle"
  | "checking"
  | "ready"
  | "submitting"
  | "success"
  | "error";

export default function RegisterPage() {
  const { account, signer, chainId, readProvider, connect, connectError } = useWallet();

  const [url, setUrl] = useState("https://relayer.example.com");
  const [feeBps, setFeeBps] = useState("30");
  const [bondEth, setBondEth] = useState("0.1");

  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState<RegistrationStatus | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [txHash, setTxHash] = useState("");

  const wrongChain = chainId !== null && chainId !== DEMO_NETWORK.chainId;
  const deployed = isConfiguredAddress(DEMO_NETWORK.contracts.relayerRegistry);

  const refreshStatus = useCallback(async () => {
    if (!account || !deployed || wrongChain) return;
    setPhase("checking");
    try {
      const next = await loadRegistrationStatus(
        DEMO_NETWORK.contracts.relayerRegistry,
        account,
        readProvider,
      );
      setStatus(next);
      setPhase("ready");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to read registry");
      setPhase("error");
    }
  }, [account, deployed, wrongChain, readProvider]);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const onSubmit = async () => {
    if (!signer || !status) return;
    setErrorMsg("");
    setPhase("submitting");
    try {
      const tx = await registerRelayer(
        DEMO_NETWORK.contracts.relayerRegistry,
        { url, feeBps: Number(feeBps), bondEth },
        signer,
      );
      const receipt = await tx.wait();
      setTxHash(receipt?.hash ?? tx.hash);
      setPhase("success");
      refreshStatus();
    } catch (err) {
      setErrorMsg(explainRegisterError(err, status?.minBond ?? 0n));
      setPhase("error");
    }
  };

  const feePct = (Number(feeBps) / 100).toFixed(2);

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <header>
        <Link href="/" className="text-xs text-[var(--color-text-muted)] hover:underline">
          ← Back
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Register a relayer</h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          Post a bond, publish your endpoint, and start accepting orders. You can
          edit fee and metadata any time after registration.
        </p>
      </header>

      {!deployed && <NotDeployedBanner />}

      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <h2 className="mb-4 font-semibold">Pre-flight</h2>
        <ul className="space-y-2 text-sm">
          <CheckItem
            label="Wallet connected"
            ok={!!account}
            hint={account ? account : connectError ?? "Connect via the header to continue"}
          />
          <CheckItem
            label={`Connected to ${DEMO_NETWORK.name ?? "the configured network"}`}
            ok={!!account && !wrongChain}
            hint={wrongChain ? `Switch your wallet to ${DEMO_NETWORK.name}` : undefined}
          />
          <CheckItem
            label="Operator address verified in IdentityRegistry"
            ok={!!status?.isVerified}
            hint={status?.isVerified
              ? `Verified until ${new Date(status.verifiedUntil * 1000).toLocaleDateString()}`
              : "Required for slashing accountability"}
          />
        </ul>
      </section>

      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <h2 className="mb-4 font-semibold">Registration</h2>

        <div className="space-y-5">
          <Field label="Endpoint URL" hint="HTTPS only. Must respond at /api/info.">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://relayer.example.com"
              className="w-full rounded-lg border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm font-mono"
            />
          </Field>

          <Field label="Per-trade fee" hint={`Basis points. ${feeBps} bps = ${feePct}% per settled order. Max 500 bps.`}>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="0"
                max="500"
                value={feeBps}
                onChange={(e) => setFeeBps(e.target.value)}
                className="w-32 rounded-lg border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm"
              />
              <span className="text-sm text-[var(--color-text-muted)]">bps</span>
            </div>
          </Field>

          <Field
            label="Bond"
            hint={status && status.minBond > 0n
              ? `Minimum ${status.minBondEth} ETH. Refundable on exit.`
              : "Refundable on exit after the cool-down period."}
          >
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="0"
                step="0.01"
                value={bondEth}
                onChange={(e) => setBondEth(e.target.value)}
                className="w-32 rounded-lg border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm"
              />
              <span className="text-sm text-[var(--color-text-muted)]">ETH</span>
            </div>
          </Field>
        </div>

        {phase === "error" && errorMsg && (
          <div className="mt-5 rounded-lg border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-xs text-[var(--color-danger)]">
            {errorMsg}
          </div>
        )}

        {phase === "success" && (
          <div className="mt-5 rounded-lg border border-[var(--color-success)] bg-[var(--color-success-soft)] px-3 py-2 text-xs">
            <div className="font-medium text-[var(--color-success)]">Registered.</div>
            {txHash && (
              <a
                href={`${DEMO_NETWORK.explorerBase}/tx/${txHash}`}
                target="_blank"
                rel="noreferrer"
                className="mt-1 block break-all font-mono text-[var(--color-text-muted)] hover:underline"
              >
                {txHash}
              </a>
            )}
          </div>
        )}

        <SubmitButton
          phase={phase}
          deployed={deployed}
          account={account}
          wrongChain={wrongChain}
          alreadyRegistered={!!status?.alreadyRegistered}
          notVerified={!!status && !status.isVerified}
          onConnect={connect}
          onSubmit={onSubmit}
        />
      </section>
    </div>
  );
}

function SubmitButton(props: {
  phase: Phase;
  deployed: boolean;
  account: string | null;
  wrongChain: boolean;
  alreadyRegistered: boolean;
  notVerified: boolean;
  onConnect: () => Promise<void>;
  onSubmit: () => Promise<void>;
}) {
  const { phase, deployed, account, wrongChain, alreadyRegistered, notVerified, onConnect, onSubmit } = props;

  if (!deployed) {
    return (
      <button
        disabled
        className="mt-6 w-full cursor-not-allowed rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface-muted)] px-4 py-3 text-sm font-medium text-[var(--color-text-subtle)]"
      >
        Awaiting on-chain deployment
      </button>
    );
  }

  if (!account) {
    return (
      <button
        onClick={onConnect}
        className="mt-6 w-full rounded-lg border border-[var(--color-primary)] bg-[var(--color-primary)] px-4 py-3 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
      >
        Connect wallet
      </button>
    );
  }

  const disabled =
    wrongChain ||
    alreadyRegistered ||
    notVerified ||
    phase === "submitting" ||
    phase === "checking";

  const label =
    phase === "submitting" ? "Submitting…" :
    alreadyRegistered ? "Already registered" :
    notVerified ? "Identity verification required" :
    wrongChain ? "Switch network in your wallet" :
    "Register on-chain";

  return (
    <button
      onClick={onSubmit}
      disabled={disabled}
      className="mt-6 w-full rounded-lg bg-[var(--color-primary)] px-4 py-3 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
    >
      {label}
    </button>
  );
}

function NotDeployedBanner() {
  return (
    <div className="rounded-xl border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-4 py-3 text-sm">
      <div className="font-medium">RelayerRegistry not yet deployed on {DEMO_NETWORK.name}.</div>
      <div className="mt-1 text-xs text-[var(--color-text-muted)]">
        The form below is wired through the SDK and will submit a real
        transaction as soon as a registry address is configured for this
        network. Until then, on-chain reads and writes are disabled.
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-[var(--color-text-muted)]">{hint}</p>}
    </div>
  );
}

function CheckItem({ label, ok, hint }: { label: string; ok: boolean; hint?: string }) {
  return (
    <li className="flex items-start gap-3">
      <span
        className={
          ok
            ? "mt-0.5 inline-block h-4 w-4 rounded-full bg-[var(--color-success)]"
            : "mt-0.5 inline-block h-4 w-4 rounded-full border border-[var(--color-border-strong)]"
        }
      />
      <div>
        <div className="text-sm">{label}</div>
        {hint && <div className="text-xs text-[var(--color-text-muted)]">{hint}</div>}
      </div>
    </li>
  );
}
