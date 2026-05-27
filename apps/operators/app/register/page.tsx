"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { isConfiguredAddress } from "@zkscatter/sdk";
import { useWallet } from "@zkscatter/sdk/react";
import {
  approveBondToken,
  explainRegistryError,
  loadActiveRelayers,
  loadRegistrationStatus,
  MAX_RELAYER_FEE_BPS,
  needsBondApproval,
  registerRelayer,
  type RegistrationStatus,
} from "@zkscatter/sdk/relayer";
import { CA_REGISTRATION_URL, DEMO_NETWORK } from "../lib/network";
import { safeOperatorUrl } from "../lib/operatorDisplay";
import { useOperatorIdentityRefresh } from "../lib/identity";
import { normalizeName, validateRelayerUrl } from "../lib/registerValidation";

const VERIFY_URL = safeOperatorUrl(CA_REGISTRATION_URL);

type Phase =
  | "idle"
  | "checking"
  | "ready"
  | "approving"
  | "submitting"
  | "success"
  | "error";

export default function RegisterPage() {
  const { account, signer, chainId, readProvider, connect, connectError } = useWallet();
  const refreshIdentity = useOperatorIdentityRefresh();

  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [feeBps, setFeeBps] = useState("30");
  const [bondEth, setBondEth] = useState("0.1");

  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState<RegistrationStatus | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [txHash, setTxHash] = useState("");

  // Existing relayer names + their owner addresses. Used to gate the
  // submit on a unique, non-empty name without depending on a chain-
  // level guard (the contract doesn't enforce uniqueness yet).
  // Keyed by the normalized form — `Relayer-A` and "  relayer  a  "
  // collide. Owner address is kept so a re-registration by the same
  // account doesn't false-positive on its own previous name.
  const [takenNames, setTakenNames] = useState<Map<string, string>>(new Map());

  const wrongChain = chainId !== null && chainId !== DEMO_NETWORK.chainId;
  const deployed = isConfiguredAddress(DEMO_NETWORK.contracts.relayerRegistry);

  const refreshStatus = useCallback(async () => {
    // Reads use `readProvider` (RPC for DEMO_NETWORK), which works
    // regardless of the wallet's connected chain — only the submit
    // step needs to gate on `wrongChain`. The pre-flight section
    // should reflect real on-chain identity/registration state
    // even while the user is on the wrong network.
    if (!account || !deployed) return;
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
  }, [account, deployed, readProvider]);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  // Pull the live active-relayer list once per page mount so we can
  // flag duplicate names *before* the user pays gas for a transaction
  // that won't revert but would create a confusing dupe in every
  // consumer (RelayerPicker, leaderboard, /api/info). This is best-
  // effort only — a race between two concurrent registers can still
  // produce a dupe; a true fix needs a contract-level uniqueness
  // guard (tracked separately). `account` is intentionally NOT a
  // dep: the active-relayer set doesn't depend on which wallet is
  // connected; the self-match filter at the conflict-check site
  // already lives outside this effect.
  useEffect(() => {
    if (!deployed || !readProvider) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await loadActiveRelayers(
          DEMO_NETWORK.contracts.relayerRegistry,
          readProvider,
        );
        if (cancelled) return;
        const m = new Map<string, string>();
        for (const r of list) {
          const k = normalizeName(r.name ?? "");
          if (k) m.set(k, r.address.toLowerCase());
        }
        setTakenNames(m);
      } catch (err) {
        // Soft-fail — the on-chain register call still runs; we just
        // can't pre-flight the uniqueness check. Log so the failure
        // is visible in the browser console (helps debug RPC issues
        // an operator might hit during a demo).
        if (!cancelled) {
          console.warn("[register] loadActiveRelayers failed; skipping name uniqueness pre-check", err);
          setTakenNames(new Map());
        }
      }
    })();
    return () => { cancelled = true; };
  }, [deployed, readProvider]);

  // Surface name validity to the submit gate + inline UI hint. An
  // existing match owned by the connected account is *not* a
  // conflict — they're re-registering with the same name.
  const nameNormalized = normalizeName(name);
  const nameTooShort = nameNormalized.length === 0;
  const conflictAddr = nameNormalized ? takenNames.get(nameNormalized) : undefined;
  const nameConflict =
    !!conflictAddr && conflictAddr !== account?.toLowerCase();
  const nameInvalid = nameTooShort || nameConflict;

  // URL pre-flight: gate submit on a parseable http(s):// URL. Empty
  // input is reported separately so the field doesn't render in the
  // error state before the user has typed anything.
  const urlValidation = validateRelayerUrl(url);
  const urlInvalid = urlValidation.invalid || urlValidation.empty;

  const onSubmit = async () => {
    if (!signer || !status) return;
    setErrorMsg("");
    try {
      // ERC20 bond mode: approve the registry first if the existing
      // allowance is insufficient. Native mode skips this entirely.
      if (needsBondApproval(status, bondEth)) {
        setPhase("approving");
        const approveTx = await approveBondToken(
          status.bondToken,
          DEMO_NETWORK.contracts.relayerRegistry,
          bondEth,
          signer,
        );
        await approveTx.wait();
      }
      setPhase("submitting");
      const tx = await registerRelayer(
        DEMO_NETWORK.contracts.relayerRegistry,
        { url, name, feeBps: Number(feeBps), bondEth, bondToken: status.bondToken },
        signer,
      );
      const receipt = await tx.wait();
      setTxHash(receipt?.hash ?? tx.hash);
      // Mirror the just-confirmed registration into local status
      // so subsequent renders treat the operator as already-active
      // without overwriting the success phase via refreshStatus().
      setStatus((prev) => (prev ? { ...prev, alreadyRegistered: true } : prev));
      setPhase("success");
    } catch (err) {
      setErrorMsg(explainRegistryError(err, status?.minBond ?? 0n));
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
        {/* Hand the unverified operator a concrete next action.
            Without this they have to dig through docs to find that the
            chain-level guard is zk-X509 and that there's a verifier
            UI behind the env-configured CA_REGISTRATION_URL. After a
            verification round-trip Refresh re-runs the on-chain probe
            so the row above flips to green without a full reload. */}
        {!!status && !status.isVerified && account && !wrongChain && (
          <div className="mt-4 rounded-lg border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-3 py-3 text-xs">
            <div className="font-medium">
              Get your operator address verified before registering
            </div>
            <div className="mt-1 text-[var(--color-text-muted)]">
              The on-chain <code>register()</code> call reverts unless your
              address is recognised by the Relayer-CA IdentityRegistry. The
              CA exposes a zk-X509 verifier UI — verify there, then click
              Refresh to re-probe.
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {VERIFY_URL ? (
                <a
                  href={VERIFY_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block rounded-md border border-[var(--color-warning)] bg-white px-2.5 py-1 text-xs font-medium text-[var(--color-warning)] hover:bg-[var(--color-warning-soft)]"
                >
                  Open Relayer-CA verifier ↗
                </a>
              ) : (
                <span
                  className="inline-block cursor-not-allowed rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-muted)] px-2.5 py-1 text-xs text-[var(--color-text-subtle)]"
                  title="Set NEXT_PUBLIC_CA_REGISTRATION_URL (or NEXT_PUBLIC_ZK_X509_URL) to enable this link"
                >
                  Verifier URL not configured
                </span>
              )}
              <button
                type="button"
                onClick={() => { refreshIdentity(); refreshStatus(); }}
                className="inline-block rounded-md border border-[var(--color-border-strong)] bg-white px-2.5 py-1 text-xs font-medium hover:bg-[var(--color-bg)]"
              >
                Refresh verification status
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <h2 className="mb-4 font-semibold">Registration</h2>

        <div className="space-y-5">
          <Field
            label="Endpoint URL"
            hint={
              urlValidation.invalid
                ? "Enter a valid http(s):// URL (e.g. https://relayer.example.com)."
                : "http(s)://. Must respond at /api/info."
            }
          >
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://relayer.example.com"
              aria-invalid={urlValidation.invalid ? "true" : undefined}
              className={`w-full rounded-lg border bg-white px-3 py-2 text-sm font-mono ${
                urlValidation.invalid
                  ? "border-[var(--color-danger)] focus:outline-[var(--color-danger)]"
                  : "border-[var(--color-border-strong)]"
              }`}
            />
          </Field>

          <Field
            label="Display name"
            hint={
              nameConflict
                ? `Name already taken by relayer ${conflictAddr?.slice(0, 6)}…${conflictAddr?.slice(-4)}. Pick a different one.`
                : "Shown to Pay/Pro users alongside your endpoint. Required and must be unique across active relayers."
            }
          >
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Relayer"
              maxLength={64}
              aria-invalid={nameInvalid && name.length > 0 ? "true" : undefined}
              className={`w-full rounded-lg border bg-white px-3 py-2 text-sm ${
                nameConflict
                  ? "border-[var(--color-danger)] focus:outline-[var(--color-danger)]"
                  : "border-[var(--color-border-strong)]"
              }`}
            />
          </Field>

          <Field label="Per-trade fee" hint={`Basis points. ${feeBps} bps = ${feePct}% per settled order. Max ${MAX_RELAYER_FEE_BPS} bps.`}>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={MAX_RELAYER_FEE_BPS}
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
                min={status?.minBondEth ?? "0"}
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
                rel="noopener noreferrer"
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
          nameInvalid={nameInvalid}
          nameConflict={nameConflict}
          nameTooShort={nameTooShort}
          urlInvalid={urlInvalid}
          urlEmpty={urlValidation.empty}
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
  nameInvalid: boolean;
  nameConflict: boolean;
  nameTooShort: boolean;
  urlInvalid: boolean;
  urlEmpty: boolean;
  onConnect: () => Promise<void>;
  onSubmit: () => Promise<void>;
}) {
  const {
    phase, deployed, account, wrongChain, alreadyRegistered, notVerified,
    nameInvalid, nameConflict, nameTooShort, urlInvalid, urlEmpty,
    onConnect, onSubmit,
  } = props;

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
    nameInvalid ||
    urlInvalid ||
    phase === "approving" ||
    phase === "submitting" ||
    phase === "checking";

  // Surface the first blocking reason. Order mirrors the contract's
  // own rejection priority (alreadyRegistered / notVerified would
  // revert) plus the local-only gates (name / url) that we'd rather
  // catch before paying gas.
  const label =
    phase === "approving" ? "Approving bond token…" :
    phase === "submitting" ? "Submitting…" :
    alreadyRegistered ? "Already registered" :
    notVerified ? "Identity verification required" :
    wrongChain ? "Switch network in your wallet" :
    urlEmpty ? "Endpoint URL required" :
    urlInvalid ? "Enter a valid http(s):// endpoint URL" :
    nameTooShort ? "Display name required" :
    nameConflict ? "Pick a unique display name" :
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
