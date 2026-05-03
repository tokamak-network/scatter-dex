"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ethers } from "ethers";
import { useMetaAddress, useWallet, shortAddr } from "@zkscatter/sdk/react";
import { decodeClaimPackage, type ClaimPackage } from "@zkscatter/sdk/notes";
import { stealthWallet } from "@zkscatter/sdk/zk";
import {
  addStealthInboxEntry,
  markStealthInboxEntryClaimed,
} from "@zkscatter/sdk/storage";
import { getNetworkConfig } from "../_lib/network";
import { submitClaim } from "../_lib/claimSubmit";
import { useFolderStorage } from "../_lib/folderStorage";

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
  const { account, chainId: walletChainId, signer, readProvider, connect, connectError } = useWallet();
  const folder = useFolderStorage();
  const { keys: metaKeys } = useMetaAddress();
  const [parsed, setParsed] = useState<ParsedClaim | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  /** Sticky once the user opts out of the gasless path — either
   *  because they hit "Submit with my wallet instead" after a
   *  relayer error, or chose self-pay up front. Lets us fall through
   *  to the wallet path even when `pkg.relayerUrl` is set. */
  const [forceSelfPay, setForceSelfPay] = useState(false);
  /** Set when the post-claim "save to inbox" step succeeds — drives a
   *  small confirmation footer so the user knows where to find this
   *  claim later. Stays null on the non-stealth / no-folder paths. */
  const [savedInboxId, setSavedInboxId] = useState<string | null>(null);

  // Stealth wallet derivation: when the package carries an
  // ephemeralPubKey AND the user has minted a meta-address on this
  // device, ECDH the two against the stored viewing key to rebuild
  // the spending key for the one-time stealth address. Falls back to
  // null when either input is missing or the derivation throws (bad
  // ephPub format), letting the page still render for receivers who
  // are loading the link on a device without their keys.
  const stealthDerivation = useMemo(() => {
    if (!parsed?.pkg.ephemeralPubKey || !metaKeys) return null;
    try {
      const w = stealthWallet(
        metaKeys.spendingKey,
        metaKeys.viewingKey,
        parsed.pkg.ephemeralPubKey,
      );
      return {
        address: w.address.toLowerCase(),
        privateKey: w.privateKey,
        matches: w.address.toLowerCase() === parsed.recipientLower,
      };
    } catch {
      return null;
    }
  }, [parsed, metaKeys]);
  const isStealth = !!parsed?.pkg.ephemeralPubKey;
  const stealthVerified = stealthDerivation?.matches === true;

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      setParsed(parseHashToClaim(window.location.hash));
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const cfg = useMemo(() => getNetworkConfig(), []);
  // Resolve to a safe `<base>/tx/<hash>` URL or null. The base comes
  // from a public env var, so a misconfigured `javascript:...` /
  // `data:...` would render an unsafe link if rendered raw — guard
  // by parsing through the URL constructor and accepting only http
  // and https.
  const explorerTxUrl = useMemo(() => {
    const base = cfg.explorerBase;
    if (!base) return null;
    try {
      const u = new URL(base);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      const trimmed = base.replace(/\/$/, "");
      return (txHash: string) => `${trimmed}/tx/${txHash}`;
    } catch {
      return null;
    }
  }, [cfg.explorerBase]);
  const isAvailable = parsed
    ? Math.floor(Date.now() / 1000) >= parsed.releaseTimeUnix
    : undefined;
  // Two distinct mismatches surface to the recipient:
  //   1. App was built for a different chain than the package — no
  //      submit path can work; abort.
  //   2. Connected wallet is on a different chain than the package
  //      — only blocks the self-pay path; gasless still works.
  const wrongAppChain = parsed && parsed.pkg.chainId !== cfg.chainId;
  const wrongWalletChain =
    !!parsed && walletChainId !== null && walletChainId !== parsed.pkg.chainId;
  // Stealth claims bind to the one-time stealth address, not the
  // user's connected EOA — comparing those would always fire even
  // when the receiver has correctly derived the matching key. Skip
  // the check whenever the local stealth derivation matches the
  // package recipient.
  const wrongRecipient =
    !!parsed &&
    !!account &&
    !stealthVerified &&
    account.toLowerCase() !== parsed.recipientLower;
  // Stealth recipients have no native gas at the one-time address,
  // so the relayer is the only path that actually works. When a
  // verified stealth claim has a relayer URL, ignore the user's
  // sticky `forceSelfPay` toggle (relayer-error fallback) — it's not
  // recoverable through self-pay.
  const gasless =
    !!parsed?.pkg.relayerUrl && (!forceSelfPay || stealthVerified);

  // Phase 2b: prefer the operator's relayer to dispatch the claim
  // (no gas for the recipient). When the package has no relayerUrl,
  // or the relayer rejects, fall back to the recipient's wallet.
  // Both paths share everything up to packing the call: chain probe,
  // proof generation, meta validation. Only the final submit differs.
  async function doClaim() {
    if (!parsed) return;
    // For verified stealth claims, swap the connected wallet's
    // signer for an in-memory wallet bound to the derived stealth
    // private key. The connected EOA can't sign for a stealth
    // address, so the self-pay fallback would otherwise fail with a
    // recipient mismatch even when the proof is valid.
    const claimSigner = stealthVerified && stealthDerivation && readProvider
      ? new ethers.Wallet(stealthDerivation.privateKey, readProvider)
      : (signer ?? undefined);
    if (!gasless && !claimSigner) return;
    try {
      const { txHash } = await submitClaim({
        pkg: parsed.pkg,
        readProvider,
        signer: claimSigner,
        forceSelfPay: forceSelfPay && !stealthVerified,
        onPhase: (kind) => setPhase({ kind }),
      });
      setPhase({ kind: "done", txHash });
      // Mirror the claim into the receiver's local stealth inbox so
      // they can see it again next session — best-effort: the claim
      // already succeeded on-chain, so a save failure shouldn't be
      // surfaced as a claim error.
      if (isStealth && folder.ready) {
        try {
          const inserted = await addStealthInboxEntry({
            source: "link",
            rawInput:
              typeof window !== "undefined" ? window.location.href : "",
            pkg: parsed.pkg,
            ephemeralPubKey: parsed.pkg.ephemeralPubKey,
          });
          const id = inserted?.id;
          if (id) {
            await markStealthInboxEntryClaimed(id, txHash);
            setSavedInboxId(id);
          }
        } catch (saveErr) {
          console.warn("[Pay] save-to-inbox after claim failed", saveErr);
        }
      }
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

        {isStealth && (
          <div className="mt-3 rounded-md border border-dashed border-[var(--color-border-strong)] p-2 text-center text-[11px]">
            {stealthVerified ? (
              <span className="text-[var(--color-success)]">
                ✓ Verified stealth claim — derived from your meta-address.
                Funds land at the one-time stealth address; the matching
                private key stays in your folder.
              </span>
            ) : metaKeys ? (
              <span className="text-[var(--color-warning)]">
                ⚠ This is a stealth claim, but your meta-address derives a
                different stealth address than the one in this link. Either
                the link belongs to someone else, or your keys don&apos;t
                match the sender&apos;s records.
              </span>
            ) : (
              <span className="text-[var(--color-text-muted)]">
                This is a stealth claim. Open Pay on the device that holds
                your meta-address (
                <a
                  href="/stealth/wallet"
                  className="text-[var(--color-primary)] hover:underline"
                >
                  /stealth/wallet
                </a>
                ) so the page can derive your stealth key.
              </span>
            )}
          </div>
        )}

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
          {phase.kind === "done" ? (
            <div className="rounded-md border border-[var(--color-success)] bg-[var(--color-success-soft)] p-3 text-center text-xs text-[var(--color-success)]">
              <div className="mb-1 font-semibold">✓ Claimed</div>
              {explorerTxUrl ? (
                <a
                  href={explorerTxUrl(phase.txHash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono underline-offset-2 hover:underline"
                >
                  {shortAddr(phase.txHash)} ↗
                </a>
              ) : (
                <div className="font-mono">{shortAddr(phase.txHash)}</div>
              )}
              <div className="mt-2 text-[10px] text-[var(--color-text-muted)]">
                {/* `parsed` is guaranteed here — the claim flow can't
                    reach `done` without it, since doClaim() bails on
                    `!parsed`. */}
                Tokens are on-chain at {shortAddr(parsed!.pkg.recipient)}. Refresh
                your wallet if the balance hasn&apos;t updated yet.
              </div>
              {savedInboxId && (
                <div className="mt-2 text-[10px]">
                  Saved to your{" "}
                  <a
                    href="/stealth/inbox"
                    className="font-medium underline-offset-2 hover:underline"
                  >
                    Stealth inbox
                  </a>
                  .
                </div>
              )}
            </div>
          ) : (() => {
              // App-chain mismatch is terminal — neither path can
              // work because the SDK / contract addresses are wired
              // for a different deployment. Surface this BEFORE the
              // wallet-connect prompt so the recipient doesn't go
              // through MetaMask only to be told to switch apps.
              if (parsed && wrongAppChain) {
                return (
                  <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-3 text-center text-xs text-[var(--color-warning)]">
                    <strong className="mb-0.5 block">Wrong Pay deployment</strong>
                    This Pay build targets chain {cfg.chainId}, but the link
                    is for chain {parsed.pkg.chainId}. Open it on the right
                    deployment to claim.
                  </div>
                );
              }
              // Wallet is required only for the self-pay fallback —
              // gasless dispatches through the operator's relayer
              // and binds the recipient on-chain via the proof, so
              // the recipient never needs to sign anything.
              const needWallet = !gasless;
              const busy =
                phase.kind === "validating" ||
                phase.kind === "proving" ||
                phase.kind === "submitting";
              if (needWallet && !account) {
                return (
                  <>
                    <button
                      onClick={() => void connect()}
                      className="w-full rounded-lg bg-[var(--color-primary)] py-3 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
                    >
                      Connect wallet to claim
                    </button>
                    {connectError && (
                      <div className="text-center text-xs text-[var(--color-danger)]">
                        {connectError === "no-wallet"
                          ? "Install MetaMask to continue."
                          : connectError}
                      </div>
                    )}
                  </>
                );
              }
              // wrongAppChain is already handled by the early bail
              // above; only the wallet-chain mismatch remains a
              // possible blocker here, and only on the self-pay path.
              return (
                <>
                  {needWallet && account && (
                    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-center text-xs text-[var(--color-text-muted)]">
                      Connected: <span className="font-mono">{shortAddr(account)}</span>
                    </div>
                  )}
                  {needWallet && wrongWalletChain && (
                    <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-2 text-center text-xs text-[var(--color-warning)]">
                      Switch your wallet to chain {parsed!.pkg.chainId} — submitting on the wrong network would target the wrong contract at the same address.
                    </div>
                  )}
                  {needWallet && wrongRecipient && (
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
                      (needWallet && wrongWalletChain) ||
                      (needWallet && wrongRecipient) ||
                      busy
                    }
                    className="w-full rounded-lg bg-[var(--color-primary)] py-3 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
                  >
                    {phase.kind === "validating" && "Verifying on-chain claim group…"}
                    {phase.kind === "proving" && "Generating ZK claim proof…"}
                    {phase.kind === "submitting" &&
                      (gasless ? "Dispatching via relayer…" : "Submitting…")}
                    {phase.kind === "idle" && (gasless ? "Claim — gasless" : "Claim")}
                    {phase.kind === "error" && "Try again"}
                  </button>
                  {phase.kind === "error" && (
                    <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-2 text-xs text-[var(--color-warning)]">
                      <strong className="mb-0.5 block">Claim failed</strong>
                      {phase.message}
                    </div>
                  )}
                  {gasless && phase.kind === "error" && (
                    <button
                      onClick={() => {
                        setForceSelfPay(true);
                        setPhase({ kind: "idle" });
                      }}
                      className="w-full rounded-md border border-[var(--color-border-strong)] py-2 text-xs hover:bg-[var(--color-primary-soft)]"
                    >
                      Submit with my wallet instead (you pay gas)
                    </button>
                  )}
                </>
              );
            })()}
        </div>

        <div className="mt-6 flex items-center justify-between border-t border-[var(--color-border)] pt-3 text-xs">
          <span className="text-[var(--color-text-muted)]">
            {gasless
              ? "Gasless — the operator's relayer pays the gas."
              : "Self-pay — gas comes from your wallet."}
          </span>
          <span className="font-mono text-[10px] text-[var(--color-text-subtle)]">{link}</span>
        </div>
      </div>
    </div>
  );
}
