"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { isConfiguredAddress } from "@zkscatter/sdk";
import { LiveFreshness, useWallet } from "@zkscatter/sdk/react";
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
import { CA_REGISTRATION_URL, DEMO_NETWORK, SHARED_ORDERBOOK_URL } from "../lib/network";
import { safeOperatorUrl } from "../lib/operatorDisplay";
import { useOperatorIdentityRefresh } from "../lib/identity";
import { normalizeName, validateEmail, validateRelayerUrl } from "../lib/registerValidation";
import { useEndpointProbe, type EndpointProbeResult } from "../lib/useEndpointProbe";
import { useIssuanceApproval, type UseIssuanceApprovalResult } from "../lib/useIssuanceApproval";
import { Stepper, type StepStatus } from "./_Stepper";

const VERIFY_URL = safeOperatorUrl(CA_REGISTRATION_URL);

/** Mirrors `kyc_submissions.status` on the shared-orderbook, plus two
 *  client-only sentinels: `loading` (status fetch in flight) and
 *  `none` (no submission for this wallet, or the backend is offline). */
type KycStatus =
  | "loading"
  | "none"
  | "pending"
  | "verified"
  | "approved"
  | "rejected";

/** A wallet has cleared the KYC gate once a submission exists and
 *  hasn't been rejected — pending/verified/approved all unblock the
 *  next wizard step (the admin's review + on-chain approval gate the
 *  LATER cert/verify steps, not this one). */
function isKycSubmitted(s: KycStatus): boolean {
  return s === "pending" || s === "verified" || s === "approved";
}

/** The submission states the backend may report. `loading` is a
 *  client-only sentinel and is intentionally excluded. */
const SERVER_KYC_STATUSES: readonly KycStatus[] = [
  "none",
  "pending",
  "verified",
  "approved",
  "rejected",
];

/** Coerce an untrusted server `status` field to a known value. An
 *  unexpected string (or missing field) must not leak into the gating
 *  logic, so anything off-list collapses to `none`. */
function coerceKycStatus(v: unknown): KycStatus {
  return typeof v === "string" && (SERVER_KYC_STATUSES as string[]).includes(v)
    ? (v as KycStatus)
    : "none";
}

/** Which of the 9 onboarding-guide steps each wizard milestone
 *  completes, for the ordered progress rendering in FlowContextPanel.
 *  KYC clears guide step 1; verification (isVerified) implies the admin
 *  approved issuance and the cert was issued, so 3–6 light up together;
 *  a successful register closes out 7–9. */
const FLOW_STEP_GROUPS = {
  kyc: [1],
  verified: [3, 4, 5, 6],
  registered: [7, 8, 9],
} as const;

/** Client-side upload ceilings — a pre-check that mirrors the
 *  shared-orderbook's KYC_MAX_FILE_BYTES so an oversized file is
 *  rejected before the (slow, doomed) upload rather than after. */
const MAX_KYC_VIDEO_BYTES = 100 * 1024 * 1024; // 100 MB
const MAX_KYC_DOC_BYTES = 15 * 1024 * 1024; // 15 MB
const MAX_EMAIL_LEN = 254; // RFC 5321 forward-path limit

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

  // ── Step 1 (KYC) state ──────────────────────────────────────────
  // The KYC form (email + wallet + ID video + ID document) posts to
  // the shared-orderbook; the admin reviews it there. `kycStatus`
  // reflects the wallet's submission so progress survives a reload.
  const [kycStatus, setKycStatus] = useState<KycStatus>("loading");
  const [kycEmail, setKycEmail] = useState("");
  const [kycVideo, setKycVideo] = useState<File | null>(null);
  const [kycIdDoc, setKycIdDoc] = useState<File | null>(null);
  const [kycPhase, setKycPhase] = useState<"idle" | "submitting" | "error">("idle");
  const [kycError, setKycError] = useState("");

  // Re-read the wallet's KYC submission whenever the account changes so
  // a returning operator lands on the right step. With no backend
  // configured, or on a failed fetch (route not deployed yet / offline),
  // we degrade to "none" so the form stays usable.
  useEffect(() => {
    if (!account || !SHARED_ORDERBOOK_URL) { setKycStatus("none"); return; }
    let cancelled = false;
    setKycStatus("loading");
    (async () => {
      try {
        const res = await fetch(
          `${SHARED_ORDERBOOK_URL}/api/kyc/status?wallet=${encodeURIComponent(account)}`,
        );
        if (!res.ok) throw new Error(`status ${res.status}`);
        const json = (await res.json()) as { status?: unknown };
        if (!cancelled) setKycStatus(coerceKycStatus(json.status));
      } catch (err) {
        if (!cancelled) {
          console.warn("[register] KYC status fetch failed; treating as not-submitted", err);
          setKycStatus("none");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [account]);

  const onKycSubmit = useCallback(async () => {
    if (!account || !SHARED_ORDERBOOK_URL || !kycEmail || !kycVideo || !kycIdDoc) return;
    setKycError("");
    setKycPhase("submitting");
    try {
      const fd = new FormData();
      fd.append("wallet", account);
      fd.append("email", kycEmail.trim());
      fd.append("video", kycVideo);
      fd.append("idDoc", kycIdDoc);
      const res = await fetch(`${SHARED_ORDERBOOK_URL}/api/kyc/submit`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) throw new Error(`Submit failed (${res.status})`);
      const json = (await res.json()) as { status?: unknown };
      const next = coerceKycStatus(json.status);
      setKycStatus(next === "none" ? "pending" : next);
      setKycPhase("idle");
    } catch (err) {
      setKycError(err instanceof Error ? err.message : "Submit failed");
      setKycPhase("error");
    }
  }, [account, kycEmail, kycVideo, kycIdDoc]);

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

  // Per-step completion gates the next step. The wizard renders FOUR
  // steps — 1=KYC, 2=Verify, 3=Endpoint, 4=Bond — but the
  // verify/endpoint/bond booleans keep their original names
  // (step1Done=Verify, step2Done=Endpoint, step3Done=Bond);
  // `kycDone` is the new step-1 gate in front of them.
  const step1Done = !!status && status.isVerified; // Verify (wizard step 2)
  // A wallet that's already verified has plainly passed KYC, so don't
  // force a legacy verified/registered operator back to step 1
  // (Copilot review on #889).
  const kycDone = isKycSubmitted(kycStatus) || step1Done;
  const step2Done =
    step1Done && !urlInvalid && !nameInvalid && !probeBlocks; // Endpoint (step 3)
  const step3Done = phase === "success"; // Bond (step 4)
  const currentStep: 1 | 2 | 3 | 4 =
    !kycDone ? 1 : !step1Done ? 2 : !step2Done ? 3 : 4;

  // Which of the 9 onboarding-guide steps are complete, for the
  // ordered progress rendering in FlowContextPanel (groups defined in
  // FLOW_STEP_GROUPS).
  const doneFlowSteps = useMemo(() => {
    const s = new Set<number>();
    if (kycDone) for (const n of FLOW_STEP_GROUPS.kyc) s.add(n);
    if (step1Done) for (const n of FLOW_STEP_GROUPS.verified) s.add(n);
    if (step3Done) for (const n of FLOW_STEP_GROUPS.registered) s.add(n);
    return s;
  }, [kycDone, step1Done, step3Done]);

  const stepperSteps = useMemo(
    () => [
      {
        id: 1 as const,
        title: "Identity",
        status: stepStatus(kycDone, currentStep === 1),
        caption: kycCaption(kycStatus, account),
      },
      {
        id: 2 as const,
        title: "Verify",
        status: stepStatus(step1Done, currentStep === 2),
        caption: step1Caption(status, account, wrongChain),
      },
      {
        id: 3 as const,
        title: "Endpoint",
        status: stepStatus(step2Done, currentStep === 3),
        caption: step2Caption(probe, urlValidation, nameTooShort, nameConflict),
      },
      {
        id: 4 as const,
        title: "Bond & submit",
        status: stepStatus(step3Done, currentStep === 4),
        caption: step3Caption(phase, status, txHash),
      },
    ],
    [
      kycDone, kycStatus, step1Done, step2Done, step3Done, currentStep,
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
          This page covers <strong>your</strong> steps in the relayer onboarding flow
          (1, 4, 6, 8 below). The admin handles steps 2 + 3, the zk-X509 portal
          handles step 5, and the leaderboard verifies step 9.{" "}
          <Link
            href="/docs?d=registering-a-relayer"
            className="underline decoration-dotted underline-offset-2 hover:text-[var(--color-text)]"
          >
            Full walkthrough →
          </Link>
        </p>
      </header>

      <FlowContextPanel currentWizardStep={currentStep} doneSteps={doneFlowSteps} />

      {!deployed && <NotDeployedBanner />}
      {!account && <ConnectPrompt onConnect={connect} connectError={connectError} />}
      {!!account && wrongChain && <WrongChainBanner />}

      <Stepper steps={stepperSteps} current={currentStep} />

      <Step0Kyc
        account={account}
        kycStatus={kycStatus}
        email={kycEmail}
        setEmail={setKycEmail}
        video={kycVideo}
        setVideo={setKycVideo}
        idDoc={kycIdDoc}
        setIdDoc={setKycIdDoc}
        phase={kycPhase}
        error={kycError}
        onSubmit={onKycSubmit}
        defaultOpen={currentStep === 1}
      />

      <Step1Verify
        status={status}
        account={account}
        wrongChain={wrongChain}
        gated={!kycDone}
        onRefresh={() => { refreshIdentity(); refreshStatus(); }}
        defaultOpen={currentStep === 2}
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
        defaultOpen={currentStep === 3}
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
        defaultOpen={currentStep === 4}
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
 *  Next's hydration warning. ISO-date in UTC dodges that entirely
 *  while still being human-readable.
 *
 *  Guards against the "never expires" sentinel: some registries
 *  encode an indefinite attestation as `verifiedUntil = uint256.max`,
 *  which casts to `Number.POSITIVE_INFINITY` and makes
 *  `new Date(...).toISOString()` throw RangeError. We treat any
 *  non-finite or out-of-Date-range value as "indefinitely". */
function formatVerifiedUntil(unixSec: number): string {
  if (!Number.isFinite(unixSec) || unixSec <= 0) return "indefinitely";
  const ms = unixSec * 1000;
  // JS Date.prototype.toISOString throws RangeError outside
  // ±8.64e15 ms (year ±271821).
  if (!Number.isFinite(ms) || ms > 8.64e15 || ms < -8.64e15) {
    return "indefinitely";
  }
  return new Date(ms).toISOString().slice(0, 10);
}

function kycCaption(kycStatus: KycStatus, account: string | null): string | undefined {
  if (!account) return "Connect wallet first";
  if (kycStatus === "loading") return "Checking submission…";
  if (kycStatus === "approved") return "Approved";
  if (kycStatus === "verified") return "Verified — awaiting approval";
  if (kycStatus === "pending") return "Submitted — under review";
  if (kycStatus === "rejected") return "Rejected — resubmit";
  return "Not submitted yet";
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

// ─── Step 1 — KYC submission ──────────────────────────────────────

function Step0Kyc({
  account,
  kycStatus,
  email,
  setEmail,
  video,
  setVideo,
  idDoc,
  setIdDoc,
  phase,
  error,
  onSubmit,
  defaultOpen,
}: {
  account: string | null;
  kycStatus: KycStatus;
  email: string;
  setEmail: (v: string) => void;
  video: File | null;
  setVideo: (f: File | null) => void;
  idDoc: File | null;
  setIdDoc: (f: File | null) => void;
  phase: "idle" | "submitting" | "error";
  error: string;
  onSubmit: () => void;
  defaultOpen: boolean;
}) {
  const submitted = isKycSubmitted(kycStatus);
  const configured = SHARED_ORDERBOOK_URL !== "";
  const emailValid = useMemo(() => validateEmail(email), [email]);
  const canSubmit =
    configured && !!account && emailValid && !!video && !!idDoc && phase !== "submitting";
  return (
    <StepSection
      step={1}
      title="Submit KYC + wallet"
      hint="Identity-verification documents for the admin's offline review. Required before the Relayer-CA will issue your certificate."
      done={submitted}
      defaultOpen={defaultOpen}
    >
      {submitted ? (
        <KycSubmittedBanner kycStatus={kycStatus} />
      ) : (
        <div className="space-y-4">
          {kycStatus === "rejected" && (
            <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-surface)] px-4 py-3 text-sm">
              <div className="font-medium text-[var(--color-danger)]">
                Previous submission rejected
              </div>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                The reviewer rejected your earlier documents. Re-submit below with
                corrected documents.
              </p>
            </div>
          )}
          <Field label="Wallet address" hint="The address this relayer will register and post bond from.">
            <input
              type="text"
              value={account ?? ""}
              readOnly
              placeholder="Connect a wallet to continue"
              className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface-muted)] px-3 py-2 font-mono text-xs text-[var(--color-text-muted)]"
            />
          </Field>
          <Field label="Contact email" hint="The admin emails your certificate-issuance link here once approved.">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              maxLength={MAX_EMAIL_LEN}
              placeholder="you@company.com"
              className="w-full rounded-lg border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm"
            />
          </Field>
          <Field
            label="Identity video"
            hint="A short clip of you holding a paper that shows your resident-registration number and address."
          >
            <FileInput accept="video/*" file={video} onPick={setVideo} cta="Choose video" maxBytes={MAX_KYC_VIDEO_BYTES} />
          </Field>
          <Field
            label="ID document"
            hint="A copy of your national ID card or business-registration certificate (image or PDF)."
          >
            <FileInput accept="image/*,application/pdf" file={idDoc} onPick={setIdDoc} cta="Choose document" maxBytes={MAX_KYC_DOC_BYTES} />
          </Field>
          <p className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[11px] text-[var(--color-text-muted)]">
            These documents contain sensitive personal data. They are sent over the
            network only to the central review service and are never written
            on-chain.
          </p>
          {!configured && (
            <p className="text-xs text-[var(--color-warning)]">
              KYC service is not configured for this deployment
              (NEXT_PUBLIC_SHARED_ORDERBOOK_URL). Submission is disabled.
            </p>
          )}
          {phase === "error" && error && (
            <p className="text-xs text-[var(--color-danger)]">{error}</p>
          )}
          <button
            type="button"
            onClick={onSubmit}
            disabled={!canSubmit}
            className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
          >
            {phase === "submitting" ? "Submitting…" : "Submit for review"}
          </button>
        </div>
      )}
    </StepSection>
  );
}

function KycSubmittedBanner({ kycStatus }: { kycStatus: KycStatus }) {
  const copy: Record<string, { title: string; body: string; tone: string }> = {
    pending: {
      title: "Submitted — under review",
      body: "The admin is reviewing your documents — this usually takes 1–2 business days. You'll get an email with your certificate-issuance link once your wallet is approved.",
      tone: "var(--color-primary)",
    },
    verified: {
      title: "Documents verified",
      body: "Your documents passed review. Awaiting final issuance approval — watch your email for the certificate link.",
      tone: "var(--color-primary)",
    },
    approved: {
      title: "Approved for issuance",
      body: "Your wallet is approved. Check your email for the certificate-issuance link, then continue to Verify below.",
      tone: "var(--color-success)",
    },
  };
  const c = copy[kycStatus] ?? copy.pending;
  return (
    <div
      className="rounded-md border bg-[var(--color-surface)] px-4 py-3 text-sm"
      style={{ borderColor: c.tone }}
    >
      <div className="font-medium">{c.title}</div>
      <p className="mt-1 text-xs text-[var(--color-text-muted)]">{c.body}</p>
    </div>
  );
}

/** Minimal file picker matching the wizard's input styling — a hidden
 *  native <input type=file> behind a styled label so the control reads
 *  consistently with the text inputs above. Enforces `maxBytes`
 *  client-side and shows an inline error for oversized picks. */
function FileInput({
  accept,
  file,
  onPick,
  cta,
  maxBytes,
}: {
  accept: string;
  file: File | null;
  onPick: (f: File | null) => void;
  cta: string;
  maxBytes: number;
}) {
  const [tooLarge, setTooLarge] = useState(false);
  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0] ?? null;
    // Clear the input value so re-picking the SAME file (after a
    // size rejection or a clear) still fires onChange.
    e.target.value = "";
    if (picked && picked.size > maxBytes) {
      setTooLarge(true);
      onPick(null);
      return;
    }
    setTooLarge(false);
    onPick(picked);
  };
  return (
    <div>
      <label className="flex cursor-pointer items-center gap-3">
        <span className="rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm font-medium hover:bg-[var(--color-primary-soft)]">
          {cta}
        </span>
        <span className="truncate text-xs text-[var(--color-text-muted)]">
          {file ? `${file.name} (${Math.round(file.size / 1024)} KB)` : "No file selected"}
        </span>
        <input type="file" accept={accept} onChange={onChange} className="hidden" />
      </label>
      {tooLarge && (
        <p className="mt-1 text-xs text-[var(--color-danger)]">
          File too large (max {Math.round(maxBytes / (1024 * 1024))} MB).
        </p>
      )}
    </div>
  );
}

// ─── Step 2 — Verify ──────────────────────────────────────────────

function Step1Verify({
  status,
  account,
  wrongChain,
  gated,
  onRefresh,
  defaultOpen,
}: {
  status: RegistrationStatus | null;
  account: string | null;
  wrongChain: boolean;
  gated: boolean;
  onRefresh: () => void;
  defaultOpen: boolean;
}) {
  const verified = !!status?.isVerified;
  // Read the admin-recorded issuance approval for the connected
  // wallet. When set, replaces the generic "Get verified" warning
  // card with a tailored "You're approved — go get your cert"
  // banner that surfaces the metadata (CN / O / C / validity) the
  // admin recorded for this wallet.
  const approval = useIssuanceApproval();
  return (
    <StepSection
      step={2}
      title="Verify your operator identity"
      hint="Get an attestation from the zk-X509 Relayer-CA. Without it, register() reverts."
      done={verified}
      gated={gated}
      gatedReason="Submit your KYC documents in Step 1 first."
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
        <>
          <ApprovalAwareCTA approval={approval} onRefresh={onRefresh} />
          {/* The hook polls the IssuanceApprovalRegistry every 10s
              while waiting on the admin's decision (see
              `useIssuanceApproval`); surface the freshness so the
              operator can see the page is alive. `idle` status (no
              registry configured / no wallet) hides the pill via
              the null `lastRefreshedAt`. */}
          {approval.status !== "idle" && (
            <div className="mt-2 pl-1">
              <LiveFreshness
                lastRefreshedAt={approval.lastRefreshedAt}
                loading={approval.status === "checking"}
                onRefresh={approval.refetch}
                label="approval"
              />
            </div>
          )}
        </>
      )}
    </StepSection>
  );
}

/** Picks the right call-to-action card based on the admin's
 *  IssuanceApprovalRegistry state for the connected wallet.
 *
 *  - `approved` → green card with the metadata the admin recorded
 *    (CN / O / C / validity), "Open Relayer-CA portal" primary
 *    button. Communicates that the heavy lift (KYC) is done.
 *  - `revoked` → red card surfacing the reason; Refresh button
 *    re-polls in case the admin reverses the revocation.
 *  - `expired` → amber card pointing back at the admin; Refresh
 *    in case the admin re-approves with a fresh expiry.
 *  - `not-approved` / `checking` / `idle` / `error` → the generic
 *    warning card we shipped pre-IssuanceApprovalRegistry, so
 *    deployments without the contract (or with the env unset) keep
 *    the prior UX.
 *
 *  Every branch carries the same Refresh control — without it the
 *  operator is stuck after an admin re-approves or extends an
 *  expired approval, since `useIssuanceApproval`'s effect only
 *  re-runs on account / provider change. */
function ApprovalAwareCTA({
  approval,
  onRefresh,
}: {
  approval: UseIssuanceApprovalResult;
  onRefresh: () => void;
}) {
  // Wire the wizard's onRefresh AND the approval hook's refetch into
  // one click — operators expect a single "Refresh" to update both
  // the on-chain identity probe and the admin approval state.
  const handleRefresh = () => {
    onRefresh();
    approval.refetch();
  };
  if (approval.status === "approved" && approval.approval) {
    return (
      <div className="mt-4 rounded-lg border border-[var(--color-success)] bg-[var(--color-success-soft)] px-3 py-3 text-xs">
        <div className="font-medium text-[var(--color-success)]">
          ✓ You&apos;re approved — get your certificate
        </div>
        <div className="mt-1 text-[var(--color-text-muted)]">
          Admin has registered your wallet for issuance:
        </div>
        <dl className="mt-1.5 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
          <dt className="text-[var(--color-text-subtle)]">CN</dt>
          <dd className="font-mono">{approval.approval.commonName}</dd>
          <dt className="text-[var(--color-text-subtle)]">O</dt>
          <dd>{approval.approval.organization}</dd>
          <dt className="text-[var(--color-text-subtle)]">C</dt>
          <dd>{approval.approval.country}</dd>
          <dt className="text-[var(--color-text-subtle)]">Validity</dt>
          <dd>{approval.approval.validityDays} days</dd>
        </dl>
        <div className="mt-2 text-[var(--color-text-muted)]">
          Open the Relayer-CA portal — generate your keypair locally
          (your private key never leaves the browser), receive the
          signed cert, then click Refresh below.
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {VERIFY_URL ? (
            <a
              href={VERIFY_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block rounded-md bg-[var(--color-success)] px-2.5 py-1 text-xs font-medium text-white hover:opacity-90"
            >
              Open Relayer-CA portal ↗
            </a>
          ) : (
            <span
              className="inline-block cursor-not-allowed rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-muted)] px-2.5 py-1 text-xs text-[var(--color-text-subtle)]"
              title="Set NEXT_PUBLIC_CA_REGISTRATION_URL to enable this link"
            >
              Portal URL not configured
            </span>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            className="inline-block rounded-md border border-[var(--color-border-strong)] bg-white px-2.5 py-1 text-xs font-medium hover:bg-[var(--color-bg)]"
          >
            Refresh verification status
          </button>
        </div>
      </div>
    );
  }

  if (approval.status === "revoked") {
    return (
      <div className="mt-4 rounded-lg border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-3 text-xs">
        <div className="font-medium text-[var(--color-danger)]">
          Issuance approval was revoked
        </div>
        <div className="mt-1 text-[var(--color-text-muted)]">
          Reason: {approval.revokeReason}
        </div>
        <div className="mt-1 text-[var(--color-text-muted)]">
          Contact the Relayer-CA admin offline before retrying. Once they
          re-approve, click Refresh to re-check.
        </div>
        <div className="mt-2">
          <button
            type="button"
            onClick={handleRefresh}
            className="inline-block rounded-md border border-[var(--color-border-strong)] bg-white px-2.5 py-1 text-xs font-medium hover:bg-[var(--color-bg)]"
          >
            Refresh approval status
          </button>
        </div>
      </div>
    );
  }

  if (approval.status === "expired") {
    return (
      <div className="mt-4 rounded-lg border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-3 py-3 text-xs">
        <div className="font-medium">Approval window expired</div>
        <div className="mt-1 text-[var(--color-text-muted)]">
          Admin approved this wallet, but the issuance window passed
          before you completed the cert exchange. Ask the admin to
          re-approve, then Refresh below.
        </div>
        <div className="mt-2">
          <button
            type="button"
            onClick={handleRefresh}
            className="inline-block rounded-md border border-[var(--color-border-strong)] bg-white px-2.5 py-1 text-xs font-medium hover:bg-[var(--color-bg)]"
          >
            Refresh approval status
          </button>
        </div>
      </div>
    );
  }

  // `checking` gets a dedicated neutral card with a spinner so the
  // first paint doesn't flash the warning-card copy and re-paint
  // into approved/revoked/etc. as soon as the RPC settles (Gemini
  // review #847).
  if (approval.status === "checking") {
    return (
      <div className="mt-4 flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-3 text-xs text-[var(--color-text-muted)]">
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-primary)] border-t-transparent" />
        <span>Checking admin approval status…</span>
      </div>
    );
  }

  // Fallback: generic "go get verified" card. Covers
  // `not-approved` (admin hasn't seen this wallet), `idle` (registry
  // env unset), and `error` (RPC probe failed).
  return (
    <div className="mt-4 rounded-lg border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-3 py-3 text-xs">
      <div className="font-medium">Get your operator address verified</div>
      <div className="mt-1 text-[var(--color-text-muted)]">
        {approval.status === "not-approved"
          ? "Submit your ID + this wallet address to the Relayer-CA admin offline. Once they approve, you'll see issuance instructions here automatically."
          : "Open the Relayer-CA verifier (zk-X509), complete the proof round-trip, then click Refresh below."}
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
          onClick={handleRefresh}
          className="inline-block rounded-md border border-[var(--color-border-strong)] bg-white px-2.5 py-1 text-xs font-medium hover:bg-[var(--color-bg)]"
        >
          Refresh verification status
        </button>
      </div>
    </div>
  );
}

// ─── Step 3 — Endpoint ────────────────────────────────────────────

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
      step={3}
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
          the Docs dropdown to find them. Three links, deliberate
          visual hierarchy:
            - "Full registration walkthrough" is the primary CTA
              (brand-color filled button) — the entry-point doc
              that contextualises every other step.
            - "How to run a relayer locally" + "Production deployment"
              are reference links (strong border, white background)
              for operators who already know the flow and just need
              the env reference. */}
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
            href="/docs?d=registering-a-relayer"
            className="rounded border border-[var(--color-primary)] bg-[var(--color-primary-soft)] px-2 py-1 text-[11px] font-medium text-[var(--color-primary)] hover:opacity-90"
          >
            Full registration walkthrough →
          </Link>
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

// ─── Step 4 — Bond & submit ───────────────────────────────────────

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
      step={4}
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
  step: 1 | 2 | 3 | 4;
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

/** All-9-steps overview panel rendered above the wizard. Maps the
 *  operator's three actionable steps (4, 6, 8 — Verify / Confirm /
 *  Bond) to the three wizard cards below, and explicitly tags the
 *  six steps that happen ELSEWHERE (admin offline review,
 *  IssuanceApprovalRegistry approve, zk-X509 cert+proof, relayer
 *  process spin-up, leaderboard verification) so a first-timer
 *  doesn't think the wizard is the entire flow.
 *
 *  Current wizard step highlights the matching operator-side flow
 *  row in primary color; admin / external rows stay muted. */
const FLOW_STEPS: Array<{
  n: number;
  who: "operator" | "admin" | "external";
  title: string;
  where: string;
  /** Maps to the wizard step (1/2/3/4) when the operator action here
   *  is what one of the cards below covers. Undefined for steps
   *  the operator does outside this page (or admin steps). */
  wizardStep?: 1 | 2 | 3 | 4;
}> = [
  { n: 1, who: "operator", title: "Submit KYC + wallet to the admin", where: "Step 1 below", wizardStep: 1 },
  { n: 2, who: "admin", title: "Anchor company Root CA on zk-X509", where: "one-time admin setup" },
  { n: 3, who: "admin", title: "Approve your wallet for issuance", where: "/admin/issuance (admin's app)" },
  { n: 4, who: "operator", title: "Open the Relayer-CA portal", where: "Step 2 below", wizardStep: 2 },
  { n: 5, who: "external", title: "Issue cert + submit ZK proof", where: "zk-X509 portal (separate tab)" },
  { n: 6, who: "operator", title: "Confirm verification went green", where: "Step 2 below — Refresh button", wizardStep: 2 },
  { n: 7, who: "operator", title: "Spin up your relayer process", where: "your server (zk-relayer service)" },
  { n: 8, who: "operator", title: "Register endpoint + post bond", where: "Steps 3 & 4 below", wizardStep: 3 },
  { n: 9, who: "external", title: "Appear on the leaderboard", where: "/leaderboard (auto)" },
];

function FlowContextPanel({
  currentWizardStep,
  doneSteps,
}: {
  currentWizardStep: 1 | 2 | 3 | 4;
  doneSteps: Set<number>;
}) {
  return (
    <details
      // Collapsed by default so the panel doesn't push the wizard
      // off the first viewport; returning operators usually don't
      // need the context refresher. First-timers can open it once
      // to see the whole arc.
      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm"
    >
      <summary className="cursor-pointer select-none text-xs font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
        Where this page fits — the full 9-step flow
      </summary>
      <ol className="mt-3 space-y-1.5 text-xs">
        {FLOW_STEPS.map((s) => {
          const done = doneSteps.has(s.n);
          const isHere = !done && s.wizardStep === currentWizardStep;
          const palette = done
            ? "border-[var(--color-success)] bg-[var(--color-success-soft)] text-[var(--color-text)]"
            : isHere
              ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)] text-[var(--color-text)]"
              : s.who === "operator"
                ? "border-[var(--color-border)] bg-[var(--color-bg)]"
                : "border-dashed border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-muted)]";
          const tag =
            s.who === "operator"
              ? "you"
              : s.who === "admin"
                ? "admin"
                : "external";
          return (
            <li
              key={s.n}
              className={`flex items-center gap-3 rounded-md border px-3 py-1.5 ${palette}`}
            >
              <span
                className={`w-5 font-mono text-[10px] ${
                  done ? "text-[var(--color-success)]" : "text-[var(--color-text-subtle)]"
                }`}
              >
                {done ? "✓" : `${s.n}.`}
              </span>
              <span className="flex-1">
                <span className="font-medium">{s.title}</span>
                <span className="ml-2 text-[10px] text-[var(--color-text-subtle)]">
                  · {s.where}
                </span>
              </span>
              <span
                className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
                  s.who === "operator"
                    ? "bg-[var(--color-primary)] text-white"
                    : s.who === "admin"
                      ? "bg-[var(--color-warning)] text-white"
                      : "bg-[var(--color-text-subtle)] text-white"
                }`}
              >
                {tag}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="mt-3 text-[10px] text-[var(--color-text-muted)]">
        Steps 2 + 3 are admin-only and happen on the admin&apos;s instance of
        this app (<code>/admin/issuance</code>) — not here. Step 5 happens in
        the zk-X509 portal; steps 7 + 9 happen outside the app entirely.
      </p>
    </details>
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
