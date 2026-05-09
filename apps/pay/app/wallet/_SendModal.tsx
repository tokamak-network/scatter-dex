"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ethers } from "ethers";
import { Modal } from "@zkscatter/ui";
import { ERC20_ABI, formatTokenLabel } from "@zkscatter/sdk";
import { useWallet } from "@zkscatter/sdk/react";
import { RelayerClient } from "@zkscatter/sdk/relayer";
import { useRelayers } from "../_lib/relayers";
import { getNetworkConfig, getStealthTransferAccountAddress } from "../_lib/network";
import {
  buildErc20TransferCalls,
  postEoaRelayTransfer,
  sign7702BatchWithSigner,
} from "../_lib/relay7702";
import type { BalanceRow } from "./_types";

const ZERO = "0x0000000000000000000000000000000000000000";

type SendPhase =
  | "idle"
  | "signing"
  | "submitting"
  | "confirming"
  | "done"
  | "error";
type Mode = "normal" | "gasless";

/** Deadline (seconds from now) bound into every gasless signature.
 *  Long enough for the operator to read the wallet prompt; short
 *  enough that a leaked sig can't sit on a still-fresh nonce
 *  indefinitely. Mirrors the redeposit / inbox flows. */
const GASLESS_DEADLINE_SEC = 600;

/** Conservative gas reserve subtracted from `Max` for a native ETH
 *  Normal-mode send. A plain ETH transfer is 21,000 gas; at
 *  100 gwei that's 0.0021 ETH, so 0.005 ETH leaves comfortable
 *  headroom for L1 + a chunky priority-fee spike without rejecting
 *  the operator's first attempt. ERC-20 / Gasless skip this
 *  reserve — gas there is paid in ETH (not the row token) or by
 *  the relayer. */
const NATIVE_MAX_GAS_RESERVE_WEI = 5_000_000_000_000_000n; // 0.005 ETH

interface GaslessCandidate {
  url: string;
  name: string;
  feeStr: string | null;
  feeCollector: string | null;
  infoError: string | null;
}

export function SendModal({
  row,
  onClose,
}: {
  row: BalanceRow;
  onClose: () => void;
}) {
  const { signer, account, provider } = useWallet();
  const cfg = getNetworkConfig();
  const delegateAddress = useMemo(() => getStealthTransferAccountAddress(), []);
  const { relayers } = useRelayers();
  const onlineRegistryRelayers = useMemo(
    () => relayers.filter((r) => r.online),
    [relayers],
  );
  // Standalone fallback — when the on-chain registry is empty /
  // offline the operator can still gasless-send through the env's
  // default relayer URL. Mirrors the inbox transfer flow's three-tier
  // selection precedence (registry → settle-time → standalone env).
  const standaloneUrl = cfg.relayer?.url ?? null;
  const gaslessEligible =
    !row.token.isNative &&
    !!delegateAddress &&
    (onlineRegistryRelayers.length > 0 || !!standaloneUrl);

  const [mode, setMode] = useState<Mode>("normal");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [phase, setPhase] = useState<SendPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [candidatesByUrl, setCandidatesByUrl] = useState<Record<string, GaslessCandidate>>({});
  const [selectedRelayerUrl, setSelectedRelayerUrl] = useState<string | null>(null);
  // Probe-dedupe set kept in a ref so the candidate-fetch effect
  // doesn't list `candidatesByUrl` in its deps (which would re-run
  // the effect on every probe completion).
  const probedRef = useRef<Set<string>>(new Set());

  // Lower-cased registry address by URL — used to refuse a relayer
  // whose `/api/info` publishes a fee-collector address that doesn't
  // match the on-chain registry record. Without this check a hostile
  // relayer could harvest fees by publishing an attacker-controlled
  // address.
  const registryAddrByUrl = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const r of onlineRegistryRelayers) {
      const u = r.url.replace(/\/+$/, "");
      if (r.address) out[u] = r.address.toLowerCase();
    }
    return out;
  }, [onlineRegistryRelayers]);

  const registryNameByUrl = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const r of onlineRegistryRelayers) {
      const u = r.url.replace(/\/+$/, "");
      if (r.api?.name) out[u] = r.api.name;
    }
    return out;
  }, [onlineRegistryRelayers]);

  // Compute the "send max" amount for the current mode + token.
  // - Native ETH in Normal mode reserves a gas buffer so the wallet
  //   can pay the broadcast fee; without this, Max → tx fails with
  //   "insufficient funds" on the first attempt.
  // - ERC-20 / Gasless: full balance (gas is in ETH or paid by
  //   relayer respectively).
  function computeMaxRaw(): bigint {
    if (row.token.isNative && mode === "normal") {
      return row.raw > NATIVE_MAX_GAS_RESERVE_WEI
        ? row.raw - NATIVE_MAX_GAS_RESERVE_WEI
        : 0n;
    }
    return row.raw;
  }

  // Pre-populate amount with the row's full balance (or max-minus-
  // reserve for native ETH) once on mount.
  useEffect(() => {
    const initial = computeMaxRaw();
    if (initial > 0n) {
      setAmount(ethers.formatUnits(initial, row.token.decimals));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Registry online first, then standalone env URL as fallback.
  const candidateUrls = useMemo<string[]>(() => {
    const trim = (u: string | null | undefined) => (u ? u.replace(/\/+$/, "") : null);
    const urls: string[] = [];
    for (const r of onlineRegistryRelayers) {
      const n = trim(r.url);
      if (n && !urls.includes(n)) urls.push(n);
    }
    const sa = trim(standaloneUrl);
    if (sa && !urls.includes(sa)) urls.push(sa);
    return urls;
  }, [onlineRegistryRelayers, standaloneUrl]);

  // Lazy-probe `/api/info` for each candidate via SDK's `RelayerClient`
  // (handles trim + 5 s default timeout + abort signal). Defense-in-
  // depth: when the candidate is registry-resolved, refuse it if the
  // self-published fee-collector doesn't match the on-chain `address`
  // — a compromised relayer could otherwise harvest the fee. Probe
  // dedupe lives in a ref so this effect doesn't list candidatesByUrl
  // in deps (which would re-fire on each completion).
  useEffect(() => {
    if (!gaslessEligible || mode !== "gasless") return;
    const ac = new AbortController();
    for (const url of candidateUrls) {
      if (probedRef.current.has(url)) continue;
      probedRef.current.add(url);
      const registryName = registryNameByUrl[url] ?? url;
      const registryAddr = registryAddrByUrl[url] ?? null;
      const apply = (next: GaslessCandidate) =>
        setCandidatesByUrl((prev) => ({ ...prev, [url]: next }));
      void (async () => {
        try {
          const info = await new RelayerClient(url).getInfo(ac.signal);
          if (ac.signal.aborted) return;
          // Refuse a registry-resolved candidate whose published
          // address mismatches the on-chain registry's record —
          // standalone-env candidates aren't pinned to a registry
          // entry so we trust the operator's own config there.
          const apiAddrLc = info.address?.toLowerCase() ?? null;
          if (registryAddr && apiAddrLc && apiAddrLc !== registryAddr) {
            apply({
              url,
              // Trust the registry-recorded name over self-reported
              // when there's a mismatch — a hostile relayer can't
              // hijack the operator's mental model of which entry
              // they picked.
              name: registryName,
              feeStr: null,
              feeCollector: null,
              infoError: "fee-collector mismatch with on-chain registry",
            });
            return;
          }
          // Validate the fee at candidate-build time — if the
          // relayer publishes a malformed decimal string, surface
          // "invalid fee" as the picker reason and refuse the
          // option, instead of letting it stay selectable while
          // \`feeOk\` silently flips to false at parse time.
          const rawFee = info.gasless_fees?.[row.token.symbol] ?? null;
          let validatedFeeStr: string | null = rawFee;
          let parseError: string | null = null;
          if (rawFee !== null) {
            try {
              ethers.parseUnits(rawFee, row.token.decimals);
            } catch {
              validatedFeeStr = null;
              parseError = "invalid fee published";
            }
          }
          apply({
            url,
            // Prefer the registry-recorded name when registry-resolved
            // so a hostile relayer can't social-engineer via display.
            name: registryAddr ? registryName : info.name ?? registryName,
            feeStr: validatedFeeStr,
            feeCollector: info.address ?? null,
            infoError: parseError,
          });
        } catch (e) {
          if (ac.signal.aborted) return;
          apply({
            url,
            name: registryName,
            feeStr: null,
            feeCollector: null,
            infoError: e instanceof Error ? e.message : String(e),
          });
        }
      })();
    }
    return () => {
      ac.abort();
    };
  }, [
    gaslessEligible,
    mode,
    candidateUrls,
    registryAddrByUrl,
    registryNameByUrl,
    row.token.symbol,
  ]);

  // Auto-pick a default once a candidate resolves. Prefer ones with
  // a published fee + collector; fall back to first probed otherwise
  // so the picker isn't empty.
  useEffect(() => {
    if (mode !== "gasless") return;
    if (selectedRelayerUrl && candidatesByUrl[selectedRelayerUrl]) return;
    const eligible = candidateUrls.find(
      (u) => candidatesByUrl[u]?.feeStr && candidatesByUrl[u]?.feeCollector,
    );
    const fallback = candidateUrls.find((u) => candidatesByUrl[u]);
    const next = eligible ?? fallback ?? null;
    if (next && next !== selectedRelayerUrl) setSelectedRelayerUrl(next);
  }, [mode, candidateUrls, candidatesByUrl, selectedRelayerUrl]);

  const selectedCandidate = selectedRelayerUrl
    ? candidatesByUrl[selectedRelayerUrl] ?? null
    : null;

  const recipientValid =
    ethers.isAddress(recipient) && recipient !== ethers.ZeroAddress;
  let amountRaw = 0n;
  let amountValid = false;
  try {
    amountRaw = ethers.parseUnits(amount.trim() || "0", row.token.decimals);
    amountValid = amountRaw > 0n && amountRaw <= row.raw;
  } catch {
    amountValid = false;
  }

  // Gasless fee from the *selected* relayer's policy. Empty when
  // no candidate has resolved yet or the chosen one hasn't
  // published a fee for the row's token. The recipient transfer is
  // \`amountRaw - feeRaw\`; the gross input stays as-is so the
  // operator sees what they intended.
  const feeStr = selectedCandidate?.feeStr ?? null;
  const feeCollector = selectedCandidate?.feeCollector ?? null;
  let feeRaw = 0n;
  let feeOk = true;
  if (mode === "gasless") {
    if (!feeStr || !feeCollector) {
      feeOk = false;
    } else {
      try {
        feeRaw = ethers.parseUnits(feeStr, row.token.decimals);
      } catch {
        feeOk = false;
      }
    }
  }
  const recipientNetRaw = mode === "gasless" ? amountRaw - feeRaw : amountRaw;
  const gaslessAmountValid =
    mode !== "gasless" || (feeOk && recipientNetRaw > 0n && amountRaw <= row.raw);

  const running =
    phase === "signing" || phase === "submitting" || phase === "confirming";
  const canRun =
    !running &&
    phase !== "done" &&
    !!signer &&
    recipientValid &&
    amountValid &&
    gaslessAmountValid &&
    (mode === "normal" ||
      (gaslessEligible && !!selectedCandidate && feeOk));

  async function runNormal() {
    if (!signer) throw new Error("Connect a wallet first.");
    setPhase("submitting");
    let tx: ethers.ContractTransactionResponse | ethers.TransactionResponse;
    if (row.token.isNative) {
      tx = await signer.sendTransaction({
        to: ethers.getAddress(recipient),
        value: amountRaw,
      });
    } else {
      if (!row.address || row.address === ZERO) {
        throw new Error("Token address not configured.");
      }
      const erc20 = new ethers.Contract(row.address, ERC20_ABI, signer);
      tx = (await erc20.transfer(
        ethers.getAddress(recipient),
        amountRaw,
      )) as ethers.ContractTransactionResponse;
    }
    setTxHash(tx.hash);
    setPhase("confirming");
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error(`Transfer tx failed: ${tx.hash}`);
    }
    setPhase("done");
  }

  async function runGasless() {
    if (!signer || !provider || !account) throw new Error("Connect a wallet first.");
    if (!selectedCandidate?.url || !delegateAddress) {
      throw new Error("Gasless transfer not configured (no relayer URL or delegate).");
    }
    if (!selectedCandidate.feeCollector) {
      throw new Error("Selected relayer's /api/info didn't publish a fee-collector address.");
    }
    if (!row.address || row.address === ZERO) {
      throw new Error("Token address not configured.");
    }

    setPhase("signing");

    const calls = buildErc20TransferCalls({
      token: row.address,
      recipient: ethers.getAddress(recipient),
      amount: recipientNetRaw,
      feeRecipient: ethers.getAddress(selectedCandidate.feeCollector),
      fee: feeRaw,
    });

    const network = await provider.getNetwork();
    const chainId = network.chainId;
    const ethNonce = BigInt(await provider.getTransactionCount(account));
    // Read the EIP-7702 delegate's per-EOA nonce. If the EOA hasn't
    // delegated yet, the storage slot reads 0.
    const accountIface = new ethers.Interface(["function nonce() view returns (uint256)"]);
    let batchNonce = 0n;
    try {
      const data = accountIface.encodeFunctionData("nonce");
      const result = await provider.call({ to: account, data });
      const decoded = accountIface.decodeFunctionResult("nonce", result);
      batchNonce = BigInt(decoded[0]);
    } catch {
      // Pre-delegation read may revert on some RPCs; treat as 0.
      batchNonce = 0n;
    }
    const deadline = BigInt(Math.floor(Date.now() / 1000) + GASLESS_DEADLINE_SEC);

    const signed = await sign7702BatchWithSigner({
      signer,
      delegateAddress,
      batchNonce,
      ethNonce,
      chainId,
      calls,
      deadline,
    });

    setPhase("submitting");
    const hash = await postEoaRelayTransfer(selectedCandidate.url, {
      fromEoa: account,
      calls,
      deadline: deadline.toString(),
      signature: signed.signature,
      authorization: signed.authorization,
    });
    setTxHash(hash);

    setPhase("confirming");
    const receipt = await provider.waitForTransaction(hash, 1, 120_000);
    if (!receipt || receipt.status !== 1) {
      throw new Error(`Gasless transfer tx failed or timed out: ${hash}`);
    }
    setPhase("done");
  }

  async function run() {
    if (!signer || !account) {
      setError("Connect a wallet first.");
      return;
    }
    setError(null);
    setTxHash(null);
    try {
      if (mode === "gasless") {
        await runGasless();
      } else {
        await runNormal();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transfer failed");
      setPhase("error");
    }
  }

  const explorerBase = cfg.explorerBase;

  return (
    <Modal
      open
      onClose={running ? () => {} : onClose}
      title={`Send ${formatTokenLabel(row.token.symbol)}`}
    >
      <div className="space-y-4 text-sm">
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
            Available
          </div>
          <div className="mt-1 text-lg font-semibold">
            {ethers.formatUnits(row.raw, row.token.decimals)}{" "}
            <span className="text-sm font-normal text-[var(--color-text-muted)]">
              {formatTokenLabel(row.token.symbol)}
            </span>
          </div>
          <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">
            From <span className="font-mono">{account}</span>.{" "}
            {mode === "gasless"
              ? "Relayer pays gas; fee deducted from the transfer."
              : "Wallet pays gas."}
          </div>
        </div>

        {phase !== "done" && (
          <>
            {/* Mode picker — gasless hidden when not eligible
                (native ETH, no delegate, or no relayer URL). */}
            {gaslessEligible && (
              <div className="flex gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => setMode("normal")}
                  disabled={running}
                  className={`flex-1 rounded-md border px-3 py-2 text-left ${
                    mode === "normal"
                      ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)] text-[var(--color-primary)]"
                      : "border-[var(--color-border-strong)]"
                  }`}
                >
                  <div className="font-medium">Normal</div>
                  <div className="text-[10px] text-[var(--color-text-muted)]">
                    Wallet pays gas in ETH.
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setMode("gasless")}
                  disabled={running}
                  className={`flex-1 rounded-md border px-3 py-2 text-left ${
                    mode === "gasless"
                      ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)] text-[var(--color-primary)]"
                      : "border-[var(--color-border-strong)]"
                  }`}
                >
                  <div className="font-medium">Gasless</div>
                  <div className="text-[10px] text-[var(--color-text-muted)]">
                    Relayer pays ETH; fee in {formatTokenLabel(row.token.symbol)}.
                  </div>
                </button>
              </div>
            )}

            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
                Recipient
              </span>
              <input
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                disabled={running}
                placeholder="0x…"
                className="w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-2 font-mono text-xs"
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
                Amount
              </span>
              <div className="flex items-center gap-2">
                <input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  disabled={running}
                  inputMode="decimal"
                  placeholder="0.0"
                  className="flex-1 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-2 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={() => {
                    const maxRaw = computeMaxRaw();
                    setAmount(ethers.formatUnits(maxRaw, row.token.decimals));
                  }}
                  disabled={running || row.raw === 0n}
                  title={
                    row.token.isNative && mode === "normal"
                      ? `Reserves ~${ethers.formatUnits(NATIVE_MAX_GAS_RESERVE_WEI, 18)} ETH for gas`
                      : undefined
                  }
                  className="rounded border border-[var(--color-border-strong)] px-2 py-1 text-[10px] hover:bg-[var(--color-primary-soft)] disabled:opacity-40"
                >
                  Max
                </button>
              </div>
              {amount && !amountValid && (
                <div className="mt-1 text-[10px] text-[var(--color-warning)]">
                  Amount must be &gt; 0 and ≤ available balance.
                </div>
              )}
            </label>

            {/* Gasless: relayer picker — shown only when there's an
                actual choice OR the single candidate's policy needs
                surfacing. Each option labels its fee for the row's
                token; rows without a policy go disabled. */}
            {mode === "gasless" && candidateUrls.length > 0 && (
              <label className="block">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
                  Relayer
                </span>
                <select
                  value={selectedRelayerUrl ?? ""}
                  onChange={(e) => setSelectedRelayerUrl(e.target.value || null)}
                  disabled={running}
                  className="w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-2 text-xs"
                >
                  {candidateUrls.map((url) => {
                    const c = candidatesByUrl[url];
                    return (
                      <option key={url} value={url} disabled={!c?.feeStr || !c.feeCollector}>
                        {(c?.name ?? url) + " · " + relayerOptionFeeLabel(c, row.token.symbol)}
                      </option>
                    );
                  })}
                </select>
                {selectedCandidate?.infoError && (
                  <div className="mt-1 text-[10px] text-[var(--color-warning)]">
                    Couldn&apos;t reach this relayer ({selectedCandidate.infoError}). Pick another or switch to Normal mode.
                  </div>
                )}
                {selectedCandidate && !selectedCandidate.feeStr && !selectedCandidate.infoError && (
                  <div className="mt-1 text-[10px] text-[var(--color-warning)]">
                    This relayer hasn&apos;t published a gasless fee for{" "}
                    {formatTokenLabel(row.token.symbol)}.
                  </div>
                )}
              </label>
            )}

            {/* Gasless: explicit fee + recipient-net breakdown. Far
                more legible than the previous inline muted footer —
                operators consistently asked "wait, am I paying a
                fee?" because the policy was buried under the amount
                input. */}
            {mode === "gasless" && feeOk && (
              <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
                  Breakdown
                </div>
                <dl className="mt-2 space-y-1 font-mono">
                  <Row k="You send (gross)" v={`${amount || "0"} ${formatTokenLabel(row.token.symbol)}`} />
                  <Row
                    k={`Relayer fee (${selectedCandidate?.name ?? ""})`}
                    v={`− ${feeStr} ${formatTokenLabel(row.token.symbol)}`}
                    accent
                  />
                  <Row
                    k="Recipient receives"
                    v={
                      recipientNetRaw > 0n
                        ? `${ethers.formatUnits(recipientNetRaw, row.token.decimals)} ${formatTokenLabel(row.token.symbol)}`
                        : "—"
                    }
                    bold
                  />
                </dl>
                <p className="mt-2 text-[10px] text-[var(--color-text-muted)]">
                  Relayer pays gas in ETH and recovers the fee from your transfer in the same token.
                  Your wallet pays no ETH. Signature is valid for {GASLESS_DEADLINE_SEC / 60} min after signing.
                </p>
                {recipientNetRaw <= 0n && amountValid && (
                  <p className="mt-1 text-[10px] text-[var(--color-warning)]">
                    Amount must exceed the relayer fee.
                  </p>
                )}
              </div>
            )}
          </>
        )}

        {running && (
          <div className="rounded-md border border-[var(--color-primary)] bg-[var(--color-primary-soft)] p-3 text-xs text-[var(--color-primary)]">
            <div className="flex items-center gap-2">
              <span
                className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-primary)] border-t-transparent"
                aria-hidden
              />
              <span className="font-medium">
                {phase === "signing"
                  ? "Signing in your wallet (authorization + batch)…"
                  : phase === "submitting"
                    ? mode === "gasless"
                      ? "Posting signed batch to the relayer…"
                      : "Sign in your wallet to broadcast…"
                    : "Waiting for on-chain confirmation…"}
              </span>
            </div>
          </div>
        )}

        {phase === "done" && txHash && (
          <div className="rounded-md border border-[var(--color-success)] bg-[var(--color-success-soft)] p-3 text-xs text-[var(--color-success)]">
            ✓ Transfer landed. Tx{" "}
            {explorerBase ? (
              <a
                href={`${explorerBase.replace(/\/$/, "")}/tx/${txHash}`}
                target="_blank"
                rel="noreferrer noopener"
                className="font-mono underline decoration-dotted"
              >
                {txHash.slice(0, 10)}…{txHash.slice(-6)}
              </a>
            ) : (
              <span className="font-mono">
                {txHash.slice(0, 10)}…{txHash.slice(-6)}
              </span>
            )}
            .
          </div>
        )}

        {error && (
          <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-3 text-xs text-[var(--color-warning)]">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          {phase !== "done" && (
            <>
              <button
                type="button"
                onClick={onClose}
                disabled={running}
                className="rounded-md border border-[var(--color-border-strong)] px-3 py-1.5 text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={run}
                disabled={!canRun}
                className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-40"
              >
                {sendButtonLabel(phase, mode)}
              </button>
            </>
          )}
          {phase === "done" && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

const PHASE_LABEL: Record<SendPhase, string> = {
  idle: "",
  signing: "Signing…",
  submitting: "Submitting…",
  confirming: "Confirming…",
  done: "",
  error: "",
};

function sendButtonLabel(phase: SendPhase, mode: Mode): string {
  if (PHASE_LABEL[phase]) return PHASE_LABEL[phase];
  return mode === "gasless" ? "Send (gasless)" : "Send";
}

function relayerOptionFeeLabel(c: GaslessCandidate | undefined, symbol: string): string {
  if (!c) return "loading…";
  if (c.feeStr) return `${c.feeStr} ${formatTokenLabel(symbol)} fee`;
  if (c.infoError) {
    // Surface a known short reason verbatim; collapse network errors
    // ("HTTP 500", "Failed to fetch") to a generic "unreachable" so
    // the dropdown stays scannable.
    const known = ["invalid", "fee-collector"];
    if (known.some((p) => c.infoError!.startsWith(p))) return c.infoError;
    return "unreachable";
  }
  return "no fee published";
}

function Row({
  k,
  v,
  accent,
  bold,
}: {
  k: string;
  v: string;
  accent?: boolean;
  bold?: boolean;
}) {
  return (
    <div className="flex justify-between">
      <dt
        className={`text-[var(--color-text-muted)] ${
          accent ? "text-[var(--color-warning)]" : ""
        }`}
      >
        {k}
      </dt>
      <dd
        className={`${bold ? "font-semibold" : ""} ${
          accent ? "text-[var(--color-warning)]" : ""
        }`}
      >
        {v}
      </dd>
    </div>
  );
}
