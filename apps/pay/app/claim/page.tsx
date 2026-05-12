"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ethers } from "ethers";
import { useMetaAddress, useWallet, shortAddr } from "@zkscatter/sdk/react";
import { decodeClaimPackage, type ClaimPackage } from "@zkscatter/sdk/notes";
import { PRIVATE_SETTLEMENT_ABI } from "@zkscatter/sdk";
import { computeClaimNullifier, toBytes32Hex } from "@zkscatter/sdk/zk";
import { RelayerClient } from "@zkscatter/sdk/relayer";
import {
  addClaimInboxEntry,
  addStealthInboxEntry,
  loadStealthInbox,
  markClaimInboxEntryClaimed,
  markStealthInboxEntryClaimed,
} from "@zkscatter/sdk/storage";
import { getNetworkConfig } from "../_lib/network";
import { formatLocalStampSec } from "../_lib/format";
import { submitClaim } from "../_lib/claimSubmit";
import { useIdentityStatus } from "../_lib/identity";
import { useFolderStorage } from "../_lib/folderStorage";
import { deriveStealthForPackage } from "../_lib/stealthDerive";

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
  const [preSaveState, setPreSaveState] = useState<
    "idle" | "saving" | "saved" | "duplicate"
  >("idle");
  // null = unknown / not yet probed, true = up, false = down. Drives
  // the gasless button's disabled state so the recipient doesn't
  // burn a proof generation just to hit a connection refused.
  const [relayerUp, setRelayerUp] = useState<boolean | null>(null);
  useEffect(() => {
    const url = parsed?.pkg.relayerUrl;
    if (!url) {
      setRelayerUp(null);
      return;
    }
    const ctrl = new AbortController();
    new RelayerClient(url)
      .getInfo(ctrl.signal)
      .then(() => setRelayerUp(true))
      .catch(() => setRelayerUp(false));
    return () => ctrl.abort();
  }, [parsed?.pkg.relayerUrl]);

  const stealthDerivation = useMemo(
    () => (parsed ? deriveStealthForPackage(parsed.pkg, metaKeys) : null),
    [parsed, metaKeys],
  );
  const isStealth = !!parsed?.pkg.ephemeralPubKey;
  const stealthVerified = stealthDerivation?.matches === true;
  // EOA claims require the connecting wallet (= recipient) to be
  // zk-X509 verified. Stealth claims are exempt: the stealth EOA
  // is one-time and never registers a cert; the stealth scheme's
  // own derivation proof is what binds the claim.
  const { state: claimerIdentity } = useIdentityStatus();
  const recipientUnverified =
    !isStealth &&
    !!account &&
    (claimerIdentity.kind === "unverified" ||
      claimerIdentity.kind === "expired" ||
      claimerIdentity.kind === "error");

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
  // null = not yet probed, true = nullifier already on-chain (claimed
  // earlier), false = unspent. Probed once `parsed` + `readProvider`
  // are ready so a recipient who's already claimed (e.g. clicked the
  // link a second time) sees "Already claimed" instead of being
  // invited to burn another proof generation that the relayer would
  // reject anyway.
  const [alreadyClaimed, setAlreadyClaimed] = useState<boolean | null>(null);
  useEffect(() => {
    if (!parsed || !readProvider) {
      setAlreadyClaimed(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const nullifier = await computeClaimNullifier(
          BigInt(parsed.pkg.secret),
          BigInt(parsed.pkg.leafIndex),
        );
        const settlement = new ethers.Contract(
          parsed.pkg.settlementAddress,
          PRIVATE_SETTLEMENT_ABI,
          readProvider,
        );
        const spent = (await settlement.claimNullifiers(
          toBytes32Hex(nullifier),
        )) as boolean;
        if (!cancelled) setAlreadyClaimed(spent);
      } catch {
        if (!cancelled) setAlreadyClaimed(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [parsed, readProvider]);
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
  async function saveToInbox() {
    if (!parsed || !folder.ready || preSaveState !== "idle") return;
    setPreSaveState("saving");
    try {
      const rawInput =
        typeof window !== "undefined" ? window.location.href : "";
      const isNew = isStealth
        ? !!(await addStealthInboxEntry({
            source: "link",
            rawInput,
            pkg: parsed.pkg,
            ephemeralPubKey: parsed.pkg.ephemeralPubKey,
          }))
        : (await addClaimInboxEntry({ rawInput, pkg: parsed.pkg })).isNew;
      setPreSaveState(isNew ? "saved" : "duplicate");
    } catch (err) {
      console.warn("[Pay] pre-claim save failed", err);
      setPreSaveState("idle");
    }
  }

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
      if (folder.ready) {
        try {
          const rawInput =
            typeof window !== "undefined" ? window.location.href : "";
          // Stealth and non-stealth claims land in different inboxes so
          // the stealth inbox keeps its tighter shape (ephemeralPubKey,
          // privkey hand-off path, etc.) — the EOA inbox is for plain
          // wallet-bound claims that don't carry those extras.
          if (isStealth) {
            const inserted = await addStealthInboxEntry({
              source: "link",
              rawInput,
              pkg: parsed.pkg,
              ephemeralPubKey: parsed.pkg.ephemeralPubKey,
            });
            // A pre-claim Save (or any prior paste of the same link)
            // returns null from the insert path; look the existing
            // entry up by (claimsRoot, leafIndex) so it still flips
            // from available → claimed.
            const id =
              inserted?.id ??
              (await loadStealthInbox()).find(
                (e) =>
                  e.pkg.claimsRoot === parsed.pkg.claimsRoot &&
                  e.pkg.leafIndex === parsed.pkg.leafIndex,
              )?.id;
            if (id) {
              await markStealthInboxEntryClaimed(id, txHash);
              setSavedInboxId(id);
            }
          } else {
            const { entry } = await addClaimInboxEntry({
              rawInput,
              pkg: parsed.pkg,
            });
            await markClaimInboxEntryClaimed(entry.id, txHash);
            setSavedInboxId(entry.id);
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
          🔒 Funds can only go to{" "}
          {parsed ? (
            <span className="break-all font-mono">{parsed.pkg.recipient}</span>
          ) : (
            "you"
          )}.
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
          ) : alreadyClaimed === true && phase.kind !== "done" ? (
            <span className="text-[var(--color-text-muted)]">
              ✓ Already claimed — this link's slot was spent earlier.
            </span>
          ) : isAvailable === undefined ? (
            <span className="text-[var(--color-text-muted)]">Checking availability…</span>
          ) : isAvailable ? (
            <span className="text-[var(--color-success)]">
              ✓ Available to claim now (
              {formatLocalStampSec(parsed.releaseTimeUnix)})
            </span>
          ) : (
            <span className="text-[var(--color-warning)]">
              ⏳ Available from {formatLocalStampSec(parsed.releaseTimeUnix)}
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
                    href={isStealth ? "/stealth/inbox" : "/inbox"}
                    className="font-medium underline-offset-2 hover:underline"
                  >
                    {isStealth ? "Stealth inbox" : "Claims inbox"}
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
                  {recipientUnverified && (
                    <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-2 text-center text-xs text-[var(--color-warning)]">
                      Your wallet isn&apos;t zk-X509 verified yet. Recipients
                      must verify before claiming.{" "}
                      <a
                        href="/identity"
                        className="font-medium underline underline-offset-2"
                      >
                        Verify with phone →
                      </a>
                    </div>
                  )}
                  <button
                    onClick={() => void doClaim()}
                    disabled={
                      !parsed ||
                      !isAvailable ||
                      (needWallet && wrongWalletChain) ||
                      (needWallet && wrongRecipient) ||
                      recipientUnverified ||
                      busy ||
                      (gasless && relayerUp === false) ||
                      alreadyClaimed === true
                    }
                    title={
                      alreadyClaimed === true
                        ? "This claim slot was already spent on-chain."
                        : gasless && relayerUp === false
                        ? "Operator's relayer is unreachable — use the wallet button below to claim directly."
                        : undefined
                    }
                    className="w-full rounded-lg bg-[var(--color-primary)] py-3 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
                  >
                    {phase.kind === "validating" && "Verifying on-chain claim group…"}
                    {phase.kind === "proving" && "Generating ZK claim proof…"}
                    {phase.kind === "submitting" &&
                      (gasless ? "Dispatching via relayer…" : "Submitting…")}
                    {phase.kind === "idle" &&
                      (alreadyClaimed === true
                        ? "Already claimed"
                        : gasless
                          ? relayerUp === false
                            ? "Relayer offline"
                            : "Claim — gasless"
                          : "Claim")}
                    {phase.kind === "error" && "Try again"}
                  </button>
                  {phase.kind === "error" && (
                    <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-2 text-xs text-[var(--color-warning)]">
                      <strong className="mb-0.5 block">Claim failed</strong>
                      {phase.message}
                    </div>
                  )}
                  {gasless && (phase.kind === "idle" || phase.kind === "error") && (
                    <button
                      onClick={() => {
                        setForceSelfPay(true);
                        setPhase({ kind: "idle" });
                      }}
                      title="Bypass the operator's relayer and submit the claim tx from your own wallet (you pay the gas)."
                      className="w-full rounded-md border border-[var(--color-border-strong)] py-2 text-xs hover:bg-[var(--color-primary-soft)]"
                    >
                      Submit with my wallet instead (you pay gas)
                    </button>
                  )}
                  {folder.ready && (phase.kind === "idle" || phase.kind === "error") && (
                    <button
                      onClick={() => void saveToInbox()}
                      disabled={preSaveState === "saving"}
                      title={
                        isStealth
                          ? "Save this link to your stealth inbox so you can re-open it later without re-pasting."
                          : "Save this link to your claims inbox so you can re-open it later without re-pasting."
                      }
                      className="w-full rounded-md border border-[var(--color-border-strong)] py-2 text-xs hover:bg-[var(--color-primary-soft)] disabled:opacity-50"
                    >
                      {preSaveState === "saving"
                        ? "Saving…"
                        : preSaveState === "saved"
                          ? `✓ Saved to ${isStealth ? "Stealth inbox" : "Claims inbox"}`
                          : preSaveState === "duplicate"
                            ? "Already in your inbox"
                            : `Save to ${isStealth ? "Stealth inbox" : "Claims inbox"}`}
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
