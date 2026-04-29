"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ethers } from "ethers";
import { useWallet, shortAddr } from "@zkscatter/sdk/react";
import { decodeClaimPackage, type ClaimPackage } from "@zkscatter/sdk/notes";
import {
  callClaimWithProof,
  type ClaimCallInputs,
} from "@zkscatter/sdk/contracts";
import {
  PRIVATE_SETTLEMENT_ABI,
} from "@zkscatter/sdk";
import type { ClaimProofInput } from "@zkscatter/sdk/zk";
import { getNetworkConfig } from "../_lib/network";
import { claimProver } from "../_lib/claimProver";

/** Pre-Next 16 the route was `/claim/[link]#secret`; Pay now ships
 *  as a static export, so the link id moves to a `?id=` query param
 *  while the secret keeps living in the URL hash (it must never reach
 *  the server, even on a hosted prerender). `useSearchParams` needs a
 *  `<Suspense>` boundary for static export to skip the CSR bailout. */
export default function Claim() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-md py-10 text-center text-sm text-[var(--color-text-muted)]">
          Loading claim…
        </div>
      }
    >
      <ClaimInner />
    </Suspense>
  );
}

interface ParsedClaim {
  pkg: ClaimPackage;
  amountRaw: bigint;
  releaseTimeUnix: number;
  recipientLower: string;
}

function parseHashToClaim(hash: string | null): ParsedClaim | null {
  if (!hash) return null;
  const trimmed = hash.replace(/^#/, "");
  if (!trimmed) return null;
  const pkg = decodeClaimPackage(trimmed);
  return {
    pkg,
    amountRaw: BigInt(pkg.amount),
    releaseTimeUnix: Number(BigInt(pkg.releaseTime)),
    recipientLower: pkg.recipient.toLowerCase(),
  };
}

type Phase =
  | { kind: "idle" }
  | { kind: "validating" }
  | { kind: "proving" }
  | { kind: "submitting" }
  | { kind: "done"; txHash: string }
  | { kind: "error"; message: string };

function ClaimInner() {
  const searchParams = useSearchParams();
  const link = searchParams?.get("id") ?? "";
  const { account, signer, readProvider, connect, connectError } = useWallet();
  const [parsed, setParsed] = useState<ParsedClaim | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      setParsed(parseHashToClaim(window.location.hash));
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const cfg = useMemo(() => getNetworkConfig(), []);
  const isAvailable = parsed
    ? Math.floor(Date.now() / 1000) >= parsed.releaseTimeUnix
    : undefined;
  const wrongChain = parsed && parsed.pkg.chainId !== cfg.chainId;
  const wrongRecipient =
    !!parsed && !!account && account.toLowerCase() !== parsed.recipientLower;

  async function doClaim() {
    if (!parsed || !signer) return;
    try {
      setPhase({ kind: "validating" });
      // Overlap the chain read with the prover boot — claimsGroups()
      // is one eth_call (~hundreds of ms), prover.ready() does the
      // worker spawn + ~3 MB asset prefetch. Independent work, so
      // Promise.all here saves real wall-clock on first claim.
      const settlement = new ethers.Contract(
        parsed.pkg.settlementAddress,
        PRIVATE_SETTLEMENT_ABI,
        readProvider,
      );
      const [group] = await Promise.all([
        settlement.claimsGroups(parsed.pkg.claimsRoot) as Promise<{
          token: string;
          totalLocked: bigint;
          totalClaimed: bigint;
          tier: bigint;
        }>,
        claimProver.ready(),
      ]);
      if (group.token === ethers.ZeroAddress) {
        throw new Error(
          "On-chain claims group is missing — the settle tx may not have confirmed yet.",
        );
      }
      if (group.token.toLowerCase() !== parsed.pkg.token.toLowerCase()) {
        throw new Error(
          "Claim package token disagrees with the on-chain claims group — refusing to submit.",
        );
      }

      setPhase({ kind: "proving" });
      const proofInput: ClaimProofInput = {
        secret: BigInt(parsed.pkg.secret),
        recipient: BigInt(parsed.pkg.recipient),
        token: BigInt(parsed.pkg.token),
        amount: parsed.amountRaw,
        releaseTime: BigInt(parsed.pkg.releaseTime),
        leafIndex: parsed.pkg.leafIndex,
        // The package carried a pre-built proof — use the fast path
        // so we don't re-hash 16 leaves on the recipient's device.
        merkleProof: {
          root: BigInt(parsed.pkg.claimsRoot),
          pathElements: parsed.pkg.pathElements.map((e) => BigInt(e)),
          pathIndices: parsed.pkg.pathIndices,
        },
        // `generateClaimProof` ignores `allClaimLeaves` when
        // `merkleProof` is provided. Pass an empty array to satisfy
        // the type without paying for tree construction.
        allClaimLeaves: [],
      };
      const result = await claimProver.prove({
        circuitId: "claim",
        input: proofInput as unknown as Record<string, unknown>,
      });
      const meta = result.meta;
      if (!meta || typeof meta.claimsRoot !== "bigint" || typeof meta.nullifier !== "bigint") {
        throw new Error("claim.worker returned no meta — extracted scalars are missing");
      }

      setPhase({ kind: "submitting" });
      const inputs: ClaimCallInputs = {
        recipient: parsed.pkg.recipient,
        token: parsed.pkg.token,
        amount: parsed.amountRaw,
        releaseTime: BigInt(parsed.pkg.releaseTime),
      };
      const tx = await callClaimWithProof(
        signer,
        parsed.pkg.settlementAddress,
        {
          proof: result.proof,
          publicSignals: result.publicSignals,
          claimsRoot: meta.claimsRoot,
          nullifier: meta.nullifier,
        },
        inputs,
      );
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) {
        throw new Error(`claimWithProof tx failed: ${tx.hash}`);
      }
      setPhase({ kind: "done", txHash: tx.hash });
    } catch (err) {
      console.error("[Pay] claim failed", err);
      setPhase({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (parseError) {
    return (
      <div className="mx-auto max-w-md py-10 text-center text-sm text-[var(--color-warning)]">
        Could not read this claim link: {parseError}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md py-10">
      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 shadow-sm">
        {parsed?.pkg.senderLabel && (
          <div className="mb-5 flex items-center justify-center gap-2 text-xs">
            <span className="text-[var(--color-text-subtle)]">From</span>
            <span className="font-medium">{parsed.pkg.senderLabel}</span>
          </div>
        )}

        <div className="mb-2 text-center text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
          {parsed?.pkg.runLabel ?? "Private payout"}
        </div>
        <div className="text-center text-3xl font-semibold">
          {parsed
            ? ethers.formatUnits(parsed.amountRaw, parsed.pkg.tokenDecimals)
            : "—"}{" "}
          <span className="text-base font-normal text-[var(--color-text-muted)]">
            {parsed?.pkg.tokenSymbol ?? ""}
          </span>
        </div>
        <div className="mt-1 text-center text-sm text-[var(--color-text-muted)]">
          You only see your amount.
        </div>

        <div className="mx-auto mt-5 inline-block w-full rounded-md bg-[var(--color-primary-soft)] p-2 text-center text-xs text-[var(--color-primary)]">
          🔒 Funds can only go to {parsed ? shortAddr(parsed.pkg.recipient) : "you"}.
          <span className="mt-0.5 block text-[10px] text-[var(--color-text-muted)]">
            Claim anytime — no expiry.
          </span>
        </div>

        <div className="mt-4 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs">
          {parsed === null ? (
            <span className="text-[var(--color-warning)]">
              Open the original message you received and click the link from
              there — this page needs the secret encoded in the URL.
            </span>
          ) : isAvailable === undefined ? (
            <span className="text-[var(--color-text-muted)]">Checking availability…</span>
          ) : isAvailable ? (
            <span className="text-[var(--color-success)]">
              ✓ Available to claim now (
              {new Date(parsed.releaseTimeUnix * 1000).toISOString().slice(0, 10)})
            </span>
          ) : (
            <span className="text-[var(--color-warning)]">
              ⏳ Available from{" "}
              {new Date(parsed.releaseTimeUnix * 1000).toISOString().slice(0, 10)}
            </span>
          )}
        </div>

        <div className="mt-5 space-y-3">
          {!account ? (
            <>
              <button
                onClick={() => void connect()}
                className="w-full rounded-lg bg-[var(--color-primary)] py-3 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
              >
                Connect wallet to claim
              </button>
              {connectError && (
                <div className="text-center text-xs text-[var(--color-error,#dc2626)]">
                  {connectError === "no-wallet"
                    ? "Install MetaMask to continue."
                    : connectError}
                </div>
              )}
            </>
          ) : phase.kind === "done" ? (
            <div className="rounded-md border border-[var(--color-success)] bg-[var(--color-success-soft)] p-3 text-center text-xs text-[var(--color-success)]">
              <div className="mb-1 font-semibold">✓ Claimed</div>
              <div className="font-mono">{shortAddr(phase.txHash)}</div>
            </div>
          ) : (
            <>
              <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-center text-xs text-[var(--color-text-muted)]">
                Connected: <span className="font-mono">{shortAddr(account)}</span>
              </div>
              {wrongChain && (
                <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-2 text-center text-xs text-[var(--color-warning)]">
                  Wrong chain — switch to chain id {parsed!.pkg.chainId} to
                  claim.
                </div>
              )}
              {wrongRecipient && (
                <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-2 text-center text-xs text-[var(--color-warning)]">
                  This claim is bound to {shortAddr(parsed!.pkg.recipient)} —
                  switch wallets to claim.
                </div>
              )}
              <button
                onClick={() => void doClaim()}
                disabled={
                  !parsed ||
                  !isAvailable ||
                  wrongChain ||
                  wrongRecipient ||
                  phase.kind === "validating" ||
                  phase.kind === "proving" ||
                  phase.kind === "submitting"
                }
                className="w-full rounded-lg bg-[var(--color-primary)] py-3 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
              >
                {phase.kind === "validating" && "Verifying on-chain claim group…"}
                {phase.kind === "proving" && "Generating ZK claim proof…"}
                {phase.kind === "submitting" && "Submitting…"}
                {phase.kind === "idle" && "Claim"}
                {phase.kind === "error" && "Try again"}
              </button>
              {phase.kind === "error" && (
                <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-2 text-xs text-[var(--color-warning)]">
                  <strong className="mb-0.5 block">Claim failed</strong>
                  {phase.message}
                </div>
              )}
            </>
          )}
        </div>

        <div className="mt-6 flex items-center justify-between border-t border-[var(--color-border)] pt-3 text-xs">
          <span className="text-[var(--color-text-muted)]">
            No gas relayer yet — claim is paid by your wallet.
          </span>
          <span className="font-mono text-[10px] text-[var(--color-text-subtle)]">{link}</span>
        </div>
      </div>
    </div>
  );
}
