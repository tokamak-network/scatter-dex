"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { useEndpointProbe, type EndpointProbeResult } from "../lib/useEndpointProbe";
import { Stepper, type StepStatus } from "./_Stepper";

const VERIFY_URL = safeOperatorUrl(CA_REGISTRATION_URL);

type Phase =
  | "idle"
  | "checking"
  | "ready"
  | "approving"
  | "submitting"
  | "success"
  | "error";

/** /register is a 3-step wizard:
 *
 *  1. Verify — operator's address must be `isVerified` against the
 *     Relayer-CA before `register()` will be accepted on-chain.
 *  2. Endpoint — URL + display name + per-trade fee. The URL is
 *     live-probed (`/api/info` + `/api/relayer/stats`) so a typo /
 *     offline node is caught before paying gas.
 *  3. Bond — minimum-bond input + on-chain `register(...)`.
 *
 *  Each step is gated by the previous step's completion. Already-
 *  completed steps stay editable (clicking the section header
 *  reveals the inputs again) so the operator can fix a typo without
 *  restarting the flow.
 *
 *  The previous flat form is split into three sections rendered by
 *  this file; the on-chain plumbing (refreshStatus, onSubmit,
 *  loadActiveRelayers) is unchanged. */
export default function RegisterPage() {
  const { account, signer, chainId, readProvider, connect, connectError } = useWallet();
  const refreshIdentity = useOperatorIdentityRefresh();

  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [feeBps, setFeeBps] = useState("30");
  const [bondEth, setBondEth] = useState("0.1");
  // When the endpoint probe surfaces a warning the operator wants to
  // override (e.g. they're registering ahead of the relayer process
  // coming online), they can advance with a checkbox. Reset whenever
  // the URL changes so the override doesn't silently apply to a new
  // endpoint's warnings the operator hasn't reviewed yet (Copilot
  // review #846).
  const [endpointOverride, setEndpointOverride] = useState(false);

  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState<RegistrationStatus | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [txHash, setTxHash] = useState("");

  const [takenNames, setTakenNames] = useState<Map<string, string>>(new Map());

  const wrongChain = chainId !== null && chainId !== DEMO_NETWORK.chainId;
  const deployed = isConfiguredAddress(DEMO_NETWORK.contracts.relayerRegistry);

  const refreshStatus = useCallback(async () => {
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
        if (!cancelled) {
          console.warn("[register] loadActiveRelayers failed; skipping name uniqueness pre-check", err);
          setTakenNames(new Map());
        }
      }
    })();
    return () => { cancelled = true; };
  }, [deployed, readProvider]);

  // Derived form state — wrapped in useMemo where the result is an
  // object so downstream useMemo deps (the stepperSteps builder) can
  // depend on a stable reference instead of re-firing every render.
  const nameDerived = useMemo(() => {
    const normalized = normalizeName(name);
    const tooShort = normalized.length === 0;
    const conflictAddr = normalized ? takenNames.get(normalized) : undefined;
    const conflict = !!conflictAddr && conflictAddr !== account?.toLowerCase();
    return { normalized, tooShort, conflictAddr, conflict, invalid: tooShort || conflict };
  }, [name, takenNames, account]);
  const { tooShort: nameTooShort, conflictAddr, conflict: nameConflict, invalid: nameInvalid } = nameDerived;

  const urlValidation = useMemo(() => validateRelayerUrl(url), [url]);
  const urlInvalid = urlValidation.invalid || urlValidation.empty;

  // Clear the warning-override whenever the URL changes — the user is
  // looking at a different relayer's probe now, the previous decision
  // shouldn't pre-confirm an unreviewed warning.
  useEffect(() => {
    setEndpointOverride(false);
  }, [url]);

  const probe = useEndpointProbe(url, { expectedChainId: DEMO_NETWORK.chainId });
  // Probe "good enough to advance": ok always counts; warn counts
  // only if the operator explicitly chose to override (e.g. wants
  // to register ahead of the relayer process coming online).
  const probeBlocks =
    probe.status === "probing" ||
    probe.status === "error" ||
    (probe.status === "warn" && !endpointOverride) ||
    probe.status === "idle";

  // Per-step completion gates the next step. `step1Done`/`step2Done`
  // double as the Stepper's status inputs.
  const step1Done = !!status && status.isVerified;
  const step2Done =
    step1Done && !urlInvalid && !nameInvalid && !probeBlocks;
  const step3Done = phase === "success";
  const currentStep: 1 | 2 | 3 = !step1Done ? 1 : !step2Done ? 2 : 3;

  const stepperSteps = useMemo(
    () => [
      {
        id: 1 as const,
        title: "Verify",
        status: stepStatus(step1Done, currentStep === 1),
        caption: step1Caption(status, account, wrongChain),
      },
      {
        id: 2 as const,
        title: "Endpoint",
        status: stepStatus(step2Done, currentStep === 2),
        caption: step2Caption(probe, urlValidation, nameTooShort, nameConflict),
      },
      {
        id: 3 as const,
        title: "Bond & submit",
        status: stepStatus(step3Done, currentStep === 3),
        caption: step3Caption(phase, status, txHash),
      },
    ],
    [
      step1Done, step2Done, step3Done, currentStep,
      status, account, wrongChain,
      probe, urlValidation, nameTooShort, nameConflict, phase, txHash,
    ],
  );

  const onSubmit = async () => {
    if (!signer || !status) return;
    setErrorMsg("");
    try {
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
      setStatus((prev) => (prev ? { ...prev, alreadyRegistered: true } : prev));
      setPhase("success");
    } catch (err) {
      setErrorMsg(explainRegistryError(err, status?.minBond ?? 0n));
      setPhase("error");
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <Link href="/" className="text-xs text-[var(--color-text-muted)] hover:underline">
          ← Back
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Register a relayer</h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          Three quick steps: verify your identity, publish your endpoint, post a bond.
        </p>
      </header>

      {!deployed && <NotDeployedBanner />}
      {!account && <ConnectPrompt onConnect={connect} connectError={connectError} />}
      {!!account && wrongChain && <WrongChainBanner />}

      <Stepper steps={stepperSteps} current={currentStep} />

      <Step1Verify
        status={status}
        account={account}
        wrongChain={wrongChain}
        onRefresh={() => { refreshIdentity(); refreshStatus(); }}
        defaultOpen={currentStep === 1 || !step1Done}
      />

      <Step2Endpoint
        gated={!step1Done}
        url={url}
        setUrl={setUrl}
        urlValidation={urlValidation}
        name={name}
        setName={setName}
        nameInvalid={nameInvalid}
        nameConflict={nameConflict}
        conflictAddr={conflictAddr}
        feeBps={feeBps}
        setFeeBps={setFeeBps}
        probe={probe}
        endpointOverride={endpointOverride}
        setEndpointOverride={setEndpointOverride}
        defaultOpen={currentStep === 2}
      />

      <Step3Bond
        gated={!step2Done}
        status={status}
        bondEth={bondEth}
        setBondEth={setBondEth}
        phase={phase}
        errorMsg={errorMsg}
        txHash={txHash}
        wrongChain={wrongChain}
        onSubmit={onSubmit}
        defaultOpen={currentStep === 3}
      />
    </div>
  );
}

// ─── Stepper captions ─────────────────────────────────────────────

function stepStatus(done: boolean, isCurrent: boolean): StepStatus {
  if (done) return "done";
  if (isCurrent) return "active";
  return "blocked";
}

/** Stable `YYYY-MM-DD` formatter used in the wizard's caption /
 *  pre-flight check ("Verified until …"). `toLocaleDateString()`
 *  is timezone-sensitive and produces a different string on the
 *  server (build machine TZ) vs the client (user TZ), tripping
 *  Next's hydration warning. ISO-date in UTC dodges that
 *  entirely while still being human-readable. */
function formatVerifiedUntil(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}

function step1Caption(
  status: RegistrationStatus | null,
  account: string | null,
  wrongChain: boolean,
): string | undefined {
  if (!account) return "Connect wallet first";
  if (wrongChain) return `Switch to ${DEMO_NETWORK.name}`;
  if (!status) return "Reading on-chain status…";
  if (status.isVerified) {
    return `Verified until ${formatVerifiedUntil(status.verifiedUntil)}`;
  }
  return "Not verified yet";
}

function step2Caption(
  probe: EndpointProbeResult,
  urlValidation: { empty: boolean; invalid: boolean },
  nameTooShort: boolean,
  nameConflict: boolean,
): string | undefined {
  if (urlValidation.empty) return "Endpoint URL required";
  if (urlValidation.invalid) return "URL is not valid";
  if (nameTooShort) return "Display name required";
  if (nameConflict) return "Display name taken";
  if (probe.status === "probing") return "Probing endpoint…";
  if (probe.status === "error") return "Endpoint unreachable";
  if (probe.status === "warn") return probe.info?.name ?? "Endpoint warning";
  if (probe.status === "ok") return probe.info?.name ?? "Endpoint live";
  return undefined;
}

function step3Caption(
  phase: Phase,
  status: RegistrationStatus | null,
  txHash: string,
): string | undefined {
  if (phase === "success") {
    return txHash ? "Registered" : "Registered (mock)";
  }
  if (phase === "approving") return "Approving bond token…";
  if (phase === "submitting") return "Submitting tx…";
  if (status && status.alreadyRegistered) return "Already registered";
  if (status && status.minBond > 0n) return `Min bond ${status.minBondEth} ETH`;
  return undefined;
}

// ─── Step 1 — Verify ──────────────────────────────────────────────

function Step1Verify({
  status,
  account,
  wrongChain,
  onRefresh,
  defaultOpen,
}: {
  status: RegistrationStatus | null;
  account: string | null;
  wrongChain: boolean;
  onRefresh: () => void;
  defaultOpen: boolean;
}) {
  const verified = !!status?.isVerified;
  return (
    <StepSection
      step={1}
      title="Verify your operator identity"
      hint="Get an attestation from the zk-X509 Relayer-CA. Without it, register() reverts."
      done={verified}
      defaultOpen={defaultOpen}
    >
      {/* Persistent verifier link — surfaced even when the operator is
          already verified, so they can re-verify if the attestation
          is close to expiry. Distinct from the warning-card CTA
          below which only shows when isVerified=false. */}
      <div className="mb-4 flex flex-wrap items-center gap-3 text-xs text-[var(--color-text-muted)]">
        {VERIFY_URL && (
          <a
            href={VERIFY_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded border border-[var(--color-border-strong)] bg-white px-2 py-1 font-medium text-[var(--color-text)] hover:bg-[var(--color-primary-soft)]"
          >
            Open zk-X509 verifier ↗
          </a>
        )}
        <Link
          href="/operator-ca"
          className="underline decoration-dotted underline-offset-2 hover:text-[var(--color-text)]"
        >
          How verification works →
        </Link>
      </div>
      <ul className="space-y-2 text-sm">
        <CheckItem
          label="Wallet connected"
          ok={!!account}
          hint={account ?? "Connect via the header to continue"}
        />
        <CheckItem
          label={`Connected to ${DEMO_NETWORK.name ?? "the configured network"}`}
          ok={!!account && !wrongChain}
          hint={wrongChain ? `Switch your wallet to ${DEMO_NETWORK.name}` : undefined}
        />
        <CheckItem
          label="Operator address verified in IdentityRegistry"
          ok={verified}
          hint={
            verified
              ? `Verified until ${formatVerifiedUntil(status!.verifiedUntil)}`
              : "Required for slashing accountability"
          }
        />
      </ul>
      {!!status && !status.isVerified && account && !wrongChain && (
        <div className="mt-4 rounded-lg border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-3 py-3 text-xs">
          <div className="font-medium">Get your operator address verified</div>
          <div className="mt-1 text-[var(--color-text-muted)]">
            Open the Relayer-CA verifier (zk-X509), complete the proof
            round-trip, then click Refresh below.
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
              onClick={onRefresh}
              className="inline-block rounded-md border border-[var(--color-border-strong)] bg-white px-2.5 py-1 text-xs font-medium hover:bg-[var(--color-bg)]"
            >
              Refresh verification status
            </button>
          </div>
        </div>
      )}
    </StepSection>
  );
}

// ─── Step 2 — Endpoint ────────────────────────────────────────────

function Step2Endpoint({
  gated,
  url,
  setUrl,
  urlValidation,
  name,
  setName,
  nameInvalid,
  nameConflict,
  conflictAddr,
  feeBps,
  setFeeBps,
  probe,
  endpointOverride,
  setEndpointOverride,
  defaultOpen,
}: {
  gated: boolean;
  url: string;
  setUrl: (v: string) => void;
  urlValidation: { empty: boolean; invalid: boolean };
  name: string;
  setName: (v: string) => void;
  nameInvalid: boolean;
  nameConflict: boolean;
  conflictAddr: string | undefined;
  feeBps: string;
  setFeeBps: (v: string) => void;
  probe: EndpointProbeResult;
  endpointOverride: boolean;
  setEndpointOverride: (v: boolean) => void;
  defaultOpen: boolean;
}) {
  const feePct = (Number(feeBps) / 100).toFixed(2);
  return (
    <StepSection
      step={2}
      title="Endpoint, name & fee"
      hint="Publish where Pay/Pro should reach you. We probe the URL live so a typo is caught before gas."
      done={!gated && !urlValidation.invalid && !urlValidation.empty && !nameInvalid && (probe.status === "ok" || (probe.status === "warn" && endpointOverride))}
      gated={gated}
      gatedReason="Complete Verify to unlock."
      defaultOpen={defaultOpen}
    >
      {/* First-timer guidance — the URL field assumes the operator
          has a relayer process running somewhere reachable. Surface
          the setup docs explicitly so they don't have to dig through
          the Docs dropdown to find them. Two links: local for the
          tutorial / dev path, deployment for the production path. */}
      <div className="mb-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
        <div className="font-medium text-[var(--color-text)]">
          Don&apos;t have a relayer running yet?
        </div>
        <div className="mt-1">
          Spin one up first — the URL below has to actually respond at{" "}
          <code>/api/info</code>.
        </div>
        <div className="mt-2 flex flex-wrap gap-3">
          <Link
            href="/docs?d=local-setup"
            className="rounded border border-[var(--color-border-strong)] bg-white px-2 py-1 text-[11px] font-medium text-[var(--color-text)] hover:bg-[var(--color-primary-soft)]"
          >
            How to run a relayer locally →
          </Link>
          <Link
            href="/docs?d=deployment"
            className="rounded border border-[var(--color-border-strong)] bg-white px-2 py-1 text-[11px] font-medium text-[var(--color-text)] hover:bg-[var(--color-primary-soft)]"
          >
            Production deployment →
          </Link>
        </div>
      </div>
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
            disabled={gated}
            className={`w-full rounded-lg border bg-white px-3 py-2 text-sm font-mono ${
              urlValidation.invalid
                ? "border-[var(--color-danger)] focus:outline-[var(--color-danger)]"
                : "border-[var(--color-border-strong)]"
            } disabled:bg-[var(--color-surface-muted)]`}
          />
        </Field>

        <ProbePanel probe={probe} override={endpointOverride} setOverride={setEndpointOverride} />

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
            disabled={gated}
            className={`w-full rounded-lg border bg-white px-3 py-2 text-sm ${
              nameConflict
                ? "border-[var(--color-danger)] focus:outline-[var(--color-danger)]"
                : "border-[var(--color-border-strong)]"
            } disabled:bg-[var(--color-surface-muted)]`}
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
              disabled={gated}
              className="w-32 rounded-lg border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm disabled:bg-[var(--color-surface-muted)]"
            />
            <span className="text-sm text-[var(--color-text-muted)]">bps</span>
          </div>
        </Field>
      </div>
    </StepSection>
  );
}

function ProbePanel({
  probe,
  override,
  setOverride,
}: {
  probe: EndpointProbeResult;
  override: boolean;
  setOverride: (v: boolean) => void;
}) {
  if (probe.status === "idle") return null;
  const palette = probePalette(probe.status);
  return (
    <div className={`rounded-lg border px-3 py-2 text-xs ${palette}`}>
      <div className="flex items-center gap-2">
        {probe.status === "probing" && (
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
        )}
        <span className="font-medium">
          {probe.status === "probing" && "Probing endpoint…"}
          {probe.status === "ok" && "Endpoint reachable"}
          {probe.status === "warn" && "Endpoint partial"}
          {probe.status === "error" && "Endpoint unreachable"}
        </span>
        {probe.info?.latencyMs !== undefined && (
          <span className="text-[var(--color-text-muted)]">
            · {probe.info.latencyMs} ms
          </span>
        )}
      </div>
      <ul className="mt-1 space-y-0.5 text-[11px] text-[var(--color-text-muted)]">
        {probe.info?.name && <li>Name: <span className="font-mono">{probe.info.name}</span></li>}
        {probe.info?.chainId !== undefined && (
          <li>chainId: <span className="font-mono">{probe.info.chainId}</span></li>
        )}
        {probe.info?.version && <li>Version: <span className="font-mono">{probe.info.version}</span></li>}
        <li>/api/relayer/stats: {probe.statsOk ? "ok" : "missing"}</li>
      </ul>
      {probe.message && <div className="mt-2">{probe.message}</div>}
      {probe.status === "warn" && (
        <label className="mt-2 flex items-center gap-2 text-[11px]">
          <input
            type="checkbox"
            checked={override}
            onChange={(e) => setOverride(e.target.checked)}
          />
          Override and continue anyway
        </label>
      )}
    </div>
  );
}

function probePalette(status: EndpointProbeResult["status"]): string {
  if (status === "ok") {
    return "border-[var(--color-success)] bg-[var(--color-success-soft)] text-[var(--color-success)]";
  }
  if (status === "warn") {
    return "border-[var(--color-warning)] bg-[var(--color-warning-soft)] text-[var(--color-warning)]";
  }
  if (status === "error") {
    return "border-[var(--color-danger)] bg-[var(--color-danger-soft)] text-[var(--color-danger)]";
  }
  return "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-muted)]";
}

// ─── Step 3 — Bond & submit ───────────────────────────────────────

function Step3Bond({
  gated,
  status,
  bondEth,
  setBondEth,
  phase,
  errorMsg,
  txHash,
  wrongChain,
  onSubmit,
  defaultOpen,
}: {
  gated: boolean;
  status: RegistrationStatus | null;
  bondEth: string;
  setBondEth: (v: string) => void;
  phase: Phase;
  errorMsg: string;
  txHash: string;
  wrongChain: boolean;
  onSubmit: () => Promise<void>;
  defaultOpen: boolean;
}) {
  const busy = phase === "approving" || phase === "submitting" || phase === "checking";
  const alreadyRegistered = !!status?.alreadyRegistered;
  const disabled =
    gated || wrongChain || alreadyRegistered || busy;
  const label =
    phase === "approving" ? "Approving bond token…" :
    phase === "submitting" ? "Submitting…" :
    alreadyRegistered ? "Already registered" :
    wrongChain ? "Switch network in your wallet" :
    "Register on-chain";
  return (
    <StepSection
      step={3}
      title="Bond & submit"
      hint={status && status.minBond > 0n
        ? `Stake at least ${status.minBondEth} ETH. Refundable on exit.`
        : "Refundable on exit after the cool-down period."}
      done={phase === "success"}
      gated={gated}
      gatedReason="Complete Endpoint to unlock."
      defaultOpen={defaultOpen}
    >
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
            disabled={gated}
            className="w-32 rounded-lg border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm disabled:bg-[var(--color-surface-muted)]"
          />
          <span className="text-sm text-[var(--color-text-muted)]">ETH</span>
        </div>
      </Field>

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

      <button
        onClick={onSubmit}
        disabled={disabled}
        className="mt-6 w-full rounded-lg bg-[var(--color-primary)] px-4 py-3 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {label}
      </button>
    </StepSection>
  );
}

// ─── Reusable bits ────────────────────────────────────────────────

function StepSection({
  step,
  title,
  hint,
  done,
  gated,
  gatedReason,
  defaultOpen,
  children,
}: {
  step: 1 | 2 | 3;
  title: string;
  hint?: string;
  done: boolean;
  gated?: boolean;
  gatedReason?: string;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  // `defaultOpen` controls *initial* render; the user can click the
  // header to toggle later (e.g. to revisit a completed step's
  // inputs). Tracking that as local state keeps the open/closed flip
  // a pure UI concern — model state lives in the parent.
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => { setOpen(defaultOpen); }, [defaultOpen]);
  return (
    <section
      className={`rounded-xl border bg-[var(--color-surface)] ${
        gated
          ? "border-[var(--color-border)] opacity-60"
          : done
            ? "border-[var(--color-success)]"
            : "border-[var(--color-primary)]"
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-6 py-4 text-left"
        aria-expanded={open}
      >
        <div>
          <div className="text-sm font-semibold">
            <span className="mr-2 text-[var(--color-text-subtle)]">Step {step}</span>
            {title}
          </div>
          {hint && <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">{hint}</div>}
          {gated && gatedReason && (
            <div className="mt-1 text-xs text-[var(--color-text-subtle)]">{gatedReason}</div>
          )}
        </div>
        <span
          aria-hidden
          className="text-xs text-[var(--color-text-subtle)]"
        >
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && <div className="border-t border-[var(--color-border)] px-6 py-5">{children}</div>}
    </section>
  );
}

function ConnectPrompt({
  onConnect,
  connectError,
}: {
  onConnect: () => Promise<void>;
  connectError: string | null;
}) {
  return (
    <div className="rounded-xl border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-4 py-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-medium">Connect a wallet to start</div>
          {connectError && (
            <div className="mt-1 text-xs text-[var(--color-text-muted)]">{connectError}</div>
          )}
        </div>
        <button
          type="button"
          onClick={() => void onConnect()}
          className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--color-primary-hover)]"
        >
          Connect wallet
        </button>
      </div>
    </div>
  );
}

function WrongChainBanner() {
  return (
    <div className="rounded-xl border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-4 py-3 text-sm">
      <div className="font-medium">Wrong network</div>
      <div className="mt-1 text-xs text-[var(--color-text-muted)]">
        Switch your wallet to {DEMO_NETWORK.name}. Reads above use the app&apos;s
        RPC and will work either way; the submit step at the end needs the
        wallet on the right chain.
      </div>
    </div>
  );
}

function NotDeployedBanner() {
  return (
    <div className="rounded-xl border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-4 py-3 text-sm">
      <div className="font-medium">RelayerRegistry not yet deployed on {DEMO_NETWORK.name}.</div>
      <div className="mt-1 text-xs text-[var(--color-text-muted)]">
        The form is wired through the SDK and will submit a real transaction as
        soon as a registry address is configured for this network. Until then,
        on-chain reads and writes are disabled.
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
