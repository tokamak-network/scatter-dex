"use client";

import { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { Modal } from "@zkscatter/ui";
import { ERC20_ABI, formatTokenLabel } from "@zkscatter/sdk";
import { useWallet } from "@zkscatter/sdk/react";
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

/** Slim view of a registry-resolved relayer that the modal renders.
 *  Mirrors what the inbox transfer flow uses — pin to URL + name +
 *  the published gasless-fee policy entry for the row's token, so
 *  the dropdown can show \"Relayer-A · 0.10 USDC fee\" without us
 *  re-walking the full RelayerInfo each render. */
interface GaslessCandidate {
  url: string;
  name: string;
  /** Fee payable to this relayer in *this row's* token, decimal
   *  string. \`null\` when the relayer hasn't published a policy
   *  for the symbol — the option is disabled in the picker. */
  feeStr: string | null;
  /** On-chain address the fee transfer call goes to. Fetched
   *  lazily from \`/api/info\` since the registry only carries
   *  URL + name + on-chain stats. */
  feeCollector: string | null;
  /** Last error seen on \`/api/info\`, if any. Drives the warning
   *  copy under the picker so the operator sees why a candidate
   *  is greyed out. */
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
  /** Map relayer URL → resolved candidate. Populated lazily as the
   *  modal probes \`/api/info\` on each candidate the first time gasless
   *  mode is selected. Keyed by URL so a re-mount reuses the same
   *  cache and the picker doesn't flash empty. */
  const [candidatesByUrl, setCandidatesByUrl] = useState<Record<string, GaslessCandidate>>({});
  const [selectedRelayerUrl, setSelectedRelayerUrl] = useState<string | null>(null);

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

  // Build the candidate URL list once. Registry online relayers
  // first; standalone env URL appended when it isn't already in the
  // registry — same precedence the inbox transfer modal applies.
  const candidateUrls = useMemo<string[]>(() => {
    const norm = (u: string | null | undefined) => (u ? u.replace(/\/+$/, "") : null);
    const urls: string[] = [];
    for (const r of onlineRegistryRelayers) {
      const n = norm(r.url);
      if (n && !urls.includes(n)) urls.push(n);
    }
    const sa = norm(standaloneUrl);
    if (sa && !urls.includes(sa)) urls.push(sa);
    return urls;
  }, [onlineRegistryRelayers, standaloneUrl]);

  // Probe `/api/info` for each candidate URL the first time gasless
  // becomes selectable. Cached by URL so toggling mode back and
  // forth doesn't re-fetch. Each candidate's fee collector address +
  // per-token fee is resolved from the response; greyed-out picker
  // rows get a clear "no fee published" reason.
  useEffect(() => {
    if (!gaslessEligible || mode !== "gasless") return;
    let cancelled = false;
    for (const url of candidateUrls) {
      if (candidatesByUrl[url]) continue; // already probed
      void (async () => {
        const registryName =
          onlineRegistryRelayers.find((r) => r.url.replace(/\/+$/, "") === url)?.api?.name ??
          url;
        try {
          const res = await fetch(`${url}/api/info`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const json = (await res.json()) as {
            address?: string;
            gasless_fees?: Record<string, string>;
            name?: string;
          };
          if (cancelled) return;
          setCandidatesByUrl((prev) => ({
            ...prev,
            [url]: {
              url,
              name: json.name ?? registryName,
              feeStr: json.gasless_fees?.[row.token.symbol] ?? null,
              feeCollector: json.address ?? null,
              infoError: null,
            },
          }));
        } catch (e) {
          if (cancelled) return;
          setCandidatesByUrl((prev) => ({
            ...prev,
            [url]: {
              url,
              name: registryName,
              feeStr: null,
              feeCollector: null,
              infoError: e instanceof Error ? e.message : String(e),
            },
          }));
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [
    gaslessEligible,
    mode,
    candidateUrls,
    candidatesByUrl,
    onlineRegistryRelayers,
    row.token.symbol,
  ]);

  // Pick a default selected relayer once the first candidate's
  // policy lands. Prefer ones that actually published a fee for the
  // row's token; fall back to the first probed otherwise so the
  // picker isn't blank.
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
                    const baseLabel = c?.name ?? url;
                    const feeLabel = c
                      ? c.feeStr
                        ? `${c.feeStr} ${formatTokenLabel(row.token.symbol)} fee`
                        : c.infoError
                          ? "unreachable"
                          : "no fee published"
                      : "loading…";
                    return (
                      <option key={url} value={url} disabled={!c?.feeStr || !c.feeCollector}>
                        {baseLabel} · {feeLabel}
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
                {phase === "signing"
                  ? "Signing…"
                  : phase === "submitting"
                    ? "Submitting…"
                    : phase === "confirming"
                      ? "Confirming…"
                      : mode === "gasless"
                        ? "Send (gasless)"
                        : "Send"}
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
