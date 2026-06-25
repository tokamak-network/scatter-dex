"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isConfiguredAddress } from "@zkscatter/sdk";
import { LiveFreshness, useWallet } from "@zkscatter/sdk/react";
import {
  approveBondToken,
  explainRegistryError,
  hasEnoughBondBalance,
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
import { useGateRegistry } from "../lib/useGateRegistry";
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

/** Which of the 6 onboarding-guide steps each wizard milestone
 *  completes, for the ordered progress rendering in FlowContextPanel.
 *  Each milestone lights up a minimal group — one step for the early
 *  milestones so the panel never shows a wall of green that hides where you
 *  actually are:
 *    1 KYC submit · 2 zk-X509 proof · 3 admin KYC approval ·
 *    4 endpoint · 5 bond · 6 leaderboard.
 *  The final `registered` milestone lights the wrap-up group 4–6 together,
 *  since the wizard's bond+submit completes endpoint/bond and the operator
 *  then appears on the leaderboard as one unit. */
const FLOW_STEP_GROUPS = {
  kyc: [1],
  verified: [2],
  approved: [3],
  registered: [4, 5, 6],
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
  // Lifted to the page so the wizard can surface the "waiting on the
  // admin" state (onboarding steps 2-3) and the "approved — go get your
  // cert" state, not just inside the Verify card. Step1Verify reuses it.
  const approval = useIssuanceApproval();

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
    if (!signer) { setKycError("Connect a wallet to sign the submission"); setKycPhase("error"); return; }
    setKycError("");
    setKycPhase("submitting");
    try {
      // Prove wallet ownership: sign `zkScatter-kyc:<wallet-lowercased>:<signedAt>`
      // and send the proof in headers so the backend rejects an unauthorized
      // submission before streaming the uploads to disk (shared-orderbook A-6).
      const walletLc = account.toLowerCase();
      const signedAt = Math.floor(Date.now() / 1000);
      const signature = await signer.signMessage(`zkScatter-kyc:${walletLc}:${signedAt}`);

      const fd = new FormData();
      fd.append("wallet", account);
      fd.append("email", kycEmail.trim());
      fd.append("video", kycVideo);
      fd.append("idDoc", kycIdDoc);
      const res = await fetch(`${SHARED_ORDERBOOK_URL}/api/kyc/submit`, {
        method: "POST",
        headers: {
          "x-kyc-wallet": walletLc,
          "x-kyc-signedat": String(signedAt),
          "x-kyc-signature": signature,
        },
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
  }, [account, signer, kycEmail, kycVideo, kycIdDoc]);

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

  // Prefill the bond input with the admin-configured minimum the first
  // time we read it, so the operator sees what's actually required
  // (e.g. 1000 TON) instead of the placeholder default. One-shot, and
  // never clobbers a value the operator has typed.
  const bondPrefilled = useRef(false);
  // Set once the operator edits the bond field, so a status read that
  // resolves *after* they typed (slow RPC) doesn't overwrite their input.
  const bondTouched = useRef(false);
  const onBondInput = useCallback((v: string) => {
    bondTouched.current = true;
    setBondEth(v);
  }, []);
  // A wallet-account switch loads a fresh status (different registry /
  // minimum), so re-arm the one-shot prefill and clear the touched flag
  // — otherwise the new account's minimum would never prefill.
  useEffect(() => {
    bondPrefilled.current = false;
    bondTouched.current = false;
  }, [account]);
  useEffect(() => {
    if (bondPrefilled.current || !status) return;
    // Flag on first status load so this never re-runs; only override the
    // placeholder when the registry requires a bond AND the operator
    // hasn't already typed a value.
    bondPrefilled.current = true;
    if (status.minBond > 0n && !bondTouched.current) setBondEth(status.minBondEth);
  }, [status]);

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
  const step1Done = !!status && status.isVerified; // zk-X509 proof (wizard step 2)
  // KYC submission is required independently of zk-X509 — the admin needs
  // the documents to review before approving (2-gate design).
  const kycDone = isKycSubmitted(kycStatus);
  // 2nd gate (new flow): AFTER zk-X509 verification the admin compares the
  // proven certificate subject against the KYC documents and approves
  // on-chain (IssuanceApprovalRegistry, reused as the KYC-approval registry).
  const kycApproved = approval.status === "approved";
  const step3Done = phase === "success"; // Bond (step 4)
  // Verified but not yet approved → the ball is in the admin's court.
  // Hold at the Verify milestone and surface the wait instead of
  // presenting Endpoint as the operator's next action.
  // Only "waiting on the admin" when genuinely pending review — not during the
  // transient `checking` load, and not for revoked/expired/error (those carry
  // their own messaging), which a bare `!kycApproved` would wrongly include.
  const awaitingAdmin =
    kycDone && step1Done && approval.status === "not-approved" && !step3Done;
  const step2Done =
    step1Done && kycApproved && !urlInvalid && !nameInvalid && !probeBlocks; // Endpoint (step 4)
  // 5-step flow: 1 Submit KYC · 2 Prove zk-X509 · 3 Admin approval ·
  // 4 Endpoint · 5 Bond & submit. Admin approval is its own step (the
  // operator waits on it) between proving and registering.
  const currentStep: 1 | 2 | 3 | 4 | 5 =
    !kycDone ? 1 : !step1Done ? 2 : !kycApproved ? 3 : !step2Done ? 4 : 5;

  // Which of the 9 onboarding-guide steps are complete, for the
  // ordered progress rendering in FlowContextPanel (groups defined in
  // FLOW_STEP_GROUPS).
  const doneFlowSteps = useMemo(() => {
    const s = new Set<number>();
    if (kycDone) for (const n of FLOW_STEP_GROUPS.kyc) s.add(n);
    if (step1Done) for (const n of FLOW_STEP_GROUPS.verified) s.add(n);
    if (kycApproved) for (const n of FLOW_STEP_GROUPS.approved) s.add(n);
    if (step3Done) for (const n of FLOW_STEP_GROUPS.registered) s.add(n);
    return s;
  }, [kycDone, step1Done, kycApproved, step3Done]);

  const stepperSteps = useMemo(
    () => [
      {
        id: 1 as const,
        title: "Submit KYC",
        status: stepStatus(kycDone, currentStep === 1),
        caption: kycCaption(kycStatus, account),
      },
      {
        id: 2 as const,
        title: "Prove zk-X509",
        status: stepStatus(step1Done, currentStep === 2),
        caption: step1Caption(status, account, wrongChain),
      },
      {
        id: 3 as const,
        title: "Admin approval",
        status: stepStatus(kycApproved, currentStep === 3),
        caption: adminApprovalCaption(approval.status),
      },
      {
        id: 4 as const,
        title: "Endpoint",
        status: stepStatus(step2Done, currentStep === 4),
        caption: step2Caption(probe, urlValidation, nameTooShort, nameConflict),
      },
      {
        id: 5 as const,
        title: "Bond & submit",
        status: stepStatus(step3Done, currentStep === 5),
        caption: step3Caption(phase, status, txHash),
      },
    ],
    [
      kycDone, kycStatus, step1Done, kycApproved, approval.status, step2Done, step3Done, currentStep,
      status, account, wrongChain,
      probe, urlValidation, nameTooShort, nameConflict, phase, txHash,
    ],
  );

  const onSubmit = async () => {
    if (!signer || !status) return;
    setErrorMsg("");
    // Guard before any wallet prompt: an under-funded operator would
    // otherwise pay gas on an approve only to have register revert.
    if (!hasEnoughBondBalance(status, bondEth)) {
      setErrorMsg(
        `Insufficient ${status.bondTokenSymbol} balance to cover the ${bondEth} ${status.bondTokenSymbol} bond.`,
      );
      setPhase("error");
      return;
    }
    try {
      if (needsBondApproval(status, bondEth)) {
        setPhase("approving");
        const approveTx = await approveBondToken(
          status.bondToken,
          DEMO_NETWORK.contracts.relayerRegistry,
          bondEth,
          signer,
          status.bondTokenDecimals,
        );
        await approveTx.wait();
      }
      setPhase("submitting");
      const tx = await registerRelayer(
        DEMO_NETWORK.contracts.relayerRegistry,
        { url, name, feeBps: Number(feeBps), bondEth, bondToken: status.bondToken, bondDecimals: status.bondTokenDecimals },
        signer,
      );
      const receipt = await tx.wait();
      setTxHash(receipt?.hash ?? tx.hash);
      setStatus((prev) => (prev ? { ...prev, alreadyRegistered: true } : prev));
      setPhase("success");
    } catch (err) {
      setErrorMsg(
        explainRegistryError(err, status?.minBond ?? 0n, {
          symbol: status?.bondTokenSymbol,
          decimals: status?.bondTokenDecimals,
        }),
      );
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

      <FlowContextPanel
        currentWizardStep={currentStep}
        doneSteps={doneFlowSteps}
        adminInProgress={awaitingAdmin}
      />

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
        gated={!kycDone && !step1Done}
        approval={approval}
        onRefresh={() => { refreshIdentity(); refreshStatus(); }}
        defaultOpen={currentStep === 2}
      />

      {/* Step 3 — admin approval. The operator can't act (the admin does), but
          render it as a full StepSection like the others for visual consistency:
          gated until zk-X509 is proved, then pending → done as the admin acts. */}
      <Step3AdminApproval
        gated={!step1Done}
        kycApproved={kycApproved}
        approvalStatus={approval.status}
        onRefresh={() => { approval.refetch(); refreshIdentity(); refreshStatus(); }}
        defaultOpen={currentStep === 3}
      />

      <Step2Endpoint
        gated={!step1Done || !kycApproved}
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
        defaultOpen={currentStep === 4}
      />

      <Step3Bond
        gated={!step2Done}
        status={status}
        bondEth={bondEth}
        setBondEth={onBondInput}
        phase={phase}
        errorMsg={errorMsg}
        txHash={txHash}
        wrongChain={wrongChain}
        onSubmit={onSubmit}
        defaultOpen={currentStep === 5}
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
  if (kycStatus === "approved") return "Submitted";
  if (kycStatus === "verified") return "Submitted";
  if (kycStatus === "pending") return "Submitted — next: prove zk-X509";
  if (kycStatus === "rejected") return "Rejected — resubmit";
  return "Not submitted yet";
}

/** Step 3 (admin approval) caption — the operator waits on the admin here. */
function adminApprovalCaption(status: UseIssuanceApprovalResult["status"]): string | undefined {
  switch (status) {
    case "approved": return "Approved by admin";
    case "not-approved": return "Waiting on the admin's approval";
    case "checking": return "Checking…";
    case "revoked": return "Approval revoked";
    case "expired": return "Approval expired";
    default: return undefined;
  }
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
  if (status && status.minBond > 0n) return `Min bond ${status.minBondEth} ${status.bondTokenSymbol}`;
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
      hint="Identity-verification documents for the admin's review. The admin later compares these against your zk-X509 certificate proof (Step 2) before approving."
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
          <Field label="Contact email" hint="Where the admin reaches you about your application.">
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
      title: "KYC submitted — now prove your certificate",
      body: "Your documents are on file. Next, do Step 2 below: prove your accredited certificate via zk-X509. The admin reviews your documents against that proof — there's nothing to wait for here until Step 2 is in.",
      tone: "var(--color-primary)",
    },
    verified: {
      title: "Documents checked",
      body: "The admin has checked your KYC documents. Make sure your zk-X509 proof is submitted in Step 2 — final on-chain approval and registration follow.",
      tone: "var(--color-primary)",
    },
    approved: {
      title: "KYC approved",
      body: "The admin approved your KYC. Once your zk-X509 proof is verified, registration (endpoint + bond) unlocks below.",
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
  approval,
  onRefresh,
  defaultOpen,
}: {
  status: RegistrationStatus | null;
  account: string | null;
  wrongChain: boolean;
  gated: boolean;
  approval: UseIssuanceApprovalResult;
  onRefresh: () => void;
  defaultOpen: boolean;
}) {
  const verified = !!status?.isVerified;
  // Deep-link straight to THIS registry's register tab (the gate's
  // active zk-X509 registry) rather than the bare dashboard root, so
  // the operator lands exactly where they submit their accredited-cert
  // proof. Falls back to the base URL until the address resolves.
  const registryAddr = useGateRegistry();
  const proveUrl =
    VERIFY_URL && registryAddr
      ? `${VERIFY_URL.replace(/\/+$/, "")}/registry/${registryAddr}?tab=register`
      : VERIFY_URL;
  return (
    <StepSection
      step={2}
      title="Prove your accredited certificate (zk-X509)"
      hint="Submit a zk-X509 proof that you hold a certificate from a registered accredited CA. This flips isVerified on-chain; without it register() reverts."
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
        {proveUrl && (
          <a
            href={proveUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded border border-[var(--color-border-strong)] bg-white px-2 py-1 font-medium text-[var(--color-text)] hover:bg-[var(--color-primary-soft)]"
          >
            Open zk-X509 to prove your certificate ↗
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
              : "Binds this wallet to your verified identity so the protocol can slash a misbehaving relayer"
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

/** A SHORT admin-approval warning shown during the verify step, only for the
 *  two states the operator must act on: a `revoked` or `expired` approval.
 *  Every other state (`approved` / `not-approved` / `checking` / `idle` /
 *  `error`) renders nothing — the persistent "Open zk-X509 to prove your
 *  certificate" link above is the single call-to-action for getting verified.
 *
 *  (The old `approved → generate your keypair / Open Relayer-CA portal`
 *  issuance branch is gone: scatter-dex no longer issues certs, and admin
 *  approval comes AFTER the zk-X509 proof, not before it.) */
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
  if (approval.status === "revoked") {
    return (
      <div className="mt-4 rounded-lg border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-3 text-xs">
        <div className="font-medium text-[var(--color-danger)]">
          Admin approval was revoked
        </div>
        <div className="mt-1 text-[var(--color-text-muted)]">
          Reason: {approval.revokeReason}
        </div>
        <div className="mt-1 text-[var(--color-text-muted)]">
          Contact the admin offline; once they re-approve, Refresh to re-check.
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
        <div className="font-medium">Admin approval expired</div>
        <div className="mt-1 text-[var(--color-text-muted)]">
          Ask the admin to re-approve this wallet, then Refresh below.
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

  if (approval.status === "error") {
    // Surface a failed status check rather than silently returning null —
    // otherwise an RPC/config error is indistinguishable from "not approved".
    return (
      <div className="mt-4 rounded-lg border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-3 text-xs text-[var(--color-danger)]">
        <div className="font-medium">Couldn&apos;t check admin approval status</div>
        {approval.message && (
          <div className="mt-1 text-[var(--color-text-muted)]">{approval.message}</div>
        )}
        <div className="mt-2">
          <button
            type="button"
            onClick={handleRefresh}
            className="inline-block rounded-md border border-[var(--color-border-strong)] bg-white px-2.5 py-1 text-xs font-medium hover:bg-[var(--color-bg)]"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Not verified yet (and not revoked/expired): the persistent
  // "Open zk-X509 to prove your certificate" link above is the single
  // call-to-action — don't duplicate a CTA card here.
  return null;
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
      step={4}
      title="Endpoint, name & fee"
      hint="Publish where Pay/Pro should reach you. We probe the URL live so a typo is caught before gas."
      done={!gated && !urlValidation.invalid && !urlValidation.empty && !nameInvalid && (probe.status === "ok" || (probe.status === "warn" && endpointOverride))}
      gated={gated}
      gatedReason="Prove your certificate (Verify) and get the admin's on-chain approval to unlock."
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
            - "How to run a relayer" is the focused relayer-only guide
              (process + orderbook + register), and "Production
              deployment" is the hardened production reference. */}
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
            target="_blank"
            rel="noopener noreferrer"
            className="rounded border border-[var(--color-primary)] bg-[var(--color-primary-soft)] px-2 py-1 text-[11px] font-medium text-[var(--color-primary)] hover:opacity-90"
          >
            Full registration walkthrough →
          </Link>
          <Link
            href="/docs?d=running-a-relayer"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded border border-[var(--color-border-strong)] bg-white px-2 py-1 text-[11px] font-medium text-[var(--color-text)] hover:bg-[var(--color-primary-soft)]"
          >
            How to run a relayer →
          </Link>
          <Link
            href="/docs?d=deployment"
            target="_blank"
            rel="noopener noreferrer"
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
  // Symbol/decimals come from the registry's configured bond token —
  // "ETH" only when it's actually native, else the ERC20 symbol (TON on
  // Sepolia). Never hardcode "ETH".
  const bondSymbol = status?.bondTokenSymbol ?? "ETH";
  // Warn before the wallet prompt when the operator can't cover the bond.
  const lowBalance = !!status && !alreadyRegistered && !hasEnoughBondBalance(status, bondEth);
  const disabled =
    gated || wrongChain || alreadyRegistered || busy || lowBalance;
  const label =
    phase === "approving" ? "Approving bond token…" :
    phase === "submitting" ? "Submitting…" :
    alreadyRegistered ? "Already registered" :
    wrongChain ? "Switch network in your wallet" :
    lowBalance ? `Insufficient ${bondSymbol} balance` :
    "Register on-chain";
  return (
    <StepSection
      step={5}
      title="Bond & submit"
      hint={status && status.minBond > 0n
        ? `Stake at least ${status.minBondEth} ${bondSymbol}. Refundable on exit.`
        : "Refundable on exit after the cool-down period."}
      done={phase === "success"}
      gated={gated}
      gatedReason="Complete Endpoint to unlock."
      defaultOpen={defaultOpen}
    >
      <Field
        label="Bond"
        hint={status && status.minBond > 0n
          ? `Minimum ${status.minBondEth} ${bondSymbol}. Refundable on exit.`
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
          <span className="text-sm text-[var(--color-text-muted)]">{bondSymbol}</span>
        </div>
      </Field>

      {lowBalance && (
        <div className="mt-5 rounded-lg border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-3 py-2 text-xs">
          Your wallet holds {status!.bondBalanceFormatted} {bondSymbol} — not enough
          for a {bondEth} {bondSymbol} bond. Top up before registering.
        </div>
      )}

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
  step: 1 | 2 | 3 | 4 | 5;
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
  /** Maps to the wizard step (1–5) when the operator action here is what one
   *  of the cards below covers. Undefined for steps the operator does outside
   *  this page (or admin steps, surfaced via adminInProgress instead). */
  wizardStep?: 1 | 2 | 3 | 4 | 5;
}> = [
  { n: 1, who: "operator", title: "Submit your KYC documents + wallet", where: "Step 1 below", wizardStep: 1 },
  { n: 2, who: "operator", title: "Prove your accredited certificate via zk-X509", where: "Step 2 below", wizardStep: 2 },
  { n: 3, who: "admin", title: "Admin checks your KYC against the certificate, then approves", where: "Step 3 below — please wait" },
  { n: 4, who: "operator", title: "Register your relayer endpoint + fee", where: "Step 4 below", wizardStep: 4 },
  { n: 5, who: "operator", title: "Post bond to activate", where: "Step 5 below", wizardStep: 5 },
  { n: 6, who: "external", title: "Appear on the leaderboard", where: "/leaderboard (auto)" },
];

/** Step 3 — admin approval (gate 2). The operator can't act here (the admin
 *  reviews + approves on-chain), but it renders as a full StepSection like the
 *  other steps for consistency: gated until zk-X509 is proved, "done" once the
 *  admin approves, with a waiting state (and a Check-now refresh) in between. */
function Step3AdminApproval({
  gated,
  kycApproved,
  approvalStatus,
  onRefresh,
  defaultOpen,
}: {
  gated: boolean;
  kycApproved: boolean;
  approvalStatus: UseIssuanceApprovalResult["status"];
  onRefresh: () => void;
  defaultOpen: boolean;
}) {
  return (
    <StepSection
      step={3}
      title="Admin approval"
      hint="The admin compares your proved certificate against your KYC documents, then approves your wallet on-chain. You wait here — no action needed."
      done={kycApproved}
      gated={gated}
      gatedReason="Prove your certificate (Step 2) first."
      defaultOpen={defaultOpen}
    >
      {kycApproved ? (
        <div className="rounded-lg border border-[var(--color-success)] bg-[var(--color-success-soft)] px-3 py-3 text-sm">
          <div className="font-medium text-[var(--color-success)]">✓ Approved by the admin</div>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            The admin checked your certificate against your KYC documents and approved your
            wallet on-chain. Registration (endpoint + bond) is unlocked below.
          </p>
        </div>
      ) : approvalStatus === "revoked" || approvalStatus === "expired" ? (
        <div className="rounded-lg border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-3 text-sm">
          <div className="font-medium text-[var(--color-danger)]">
            {approvalStatus === "expired" ? "Approval expired" : "Approval revoked"}
          </div>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            {approvalStatus === "expired"
              ? "Your approval window closed. Ask the admin for a re-approval."
              : "The admin revoked your approval. Contact the admin offline before retrying."}{" "}
            <button type="button" onClick={onRefresh} className="font-medium text-[var(--color-primary)] underline">Check now</button>
          </p>
        </div>
      ) : approvalStatus === "checking" ? (
        <div role="status" className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] px-3 py-3 text-sm text-[var(--color-text-muted)]">
          <span aria-hidden className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
          Checking approval status…
        </div>
      ) : (
        <div className="rounded-lg border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-3 py-3 text-sm">
          <div className="font-medium">Waiting on the admin&apos;s approval</div>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            Your zk-X509 proof is in. The admin now compares the certificate against your KYC
            documents and approves your wallet on-chain. Registration unlocks once approved.{" "}
            <button type="button" onClick={onRefresh} className="font-medium text-[var(--color-primary)] underline">Check now</button>
          </p>
        </div>
      )}
    </StepSection>
  );
}

function FlowContextPanel({
  currentWizardStep,
  doneSteps,
  adminInProgress,
}: {
  currentWizardStep: 1 | 2 | 3 | 4 | 5;
  doneSteps: Set<number>;
  adminInProgress?: boolean;
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
        Where this page fits — the full 6-step flow
      </summary>
      <ol className="mt-3 space-y-1.5 text-xs">
        {FLOW_STEPS.map((s) => {
          const done = doneSteps.has(s.n);
          // While the admin reviews (steps 2-3), highlight THEIR rows as
          // the in-progress ones instead of the operator's next card.
          const isHere = !done && (adminInProgress
            ? s.who === "admin"
            : s.wizardStep === currentWizardStep);
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
        Step 3 (admin approval) happens on the admin&apos;s instance of this app
        (<code>/operator-ca</code>) — not here; you wait for it. Step 2 (the
        zk-X509 proof) is done in the zk-X509 portal / desktop app. Step 6
        (leaderboard) is automatic.
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
