"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ethers } from "ethers";
import { useEdDSAKey, useWallet } from "@zkscatter/sdk/react";
import { claimSeedFromKey, deepRecoverReleaseTime, toBytes32Hex } from "@zkscatter/sdk/zk";
import { encodeClaimPackage, type ClaimPackage } from "@zkscatter/sdk/notes";
import { saveClaimsBackup, type ClaimsBackup } from "@zkscatter/sdk/storage";
import { getNetworkConfig } from "../../_lib/network";
import { extractSettledClaimsRoot } from "../../_lib/realSettle";
import { makeIsRootSettled, rebuildClaimPackages } from "../../_lib/repairClaims";
import { WorkspaceBar } from "../../_components/WorkspaceBar";

const TIER_CAP = 16; // only active tier today

type Phase =
  | { kind: "idle" }
  | { kind: "running"; scanned: number; total: number }
  | { kind: "error"; message: string }
  | {
      kind: "found";
      releaseTime: number;
      links: { recipient: string; url: string }[];
      backupSaved: boolean;
    };

/** Last-resort recovery for a payout whose claim links were lost: the
 *  seed is re-derived from the wallet, the operator supplies recipients +
 *  amounts + order, and the one fuzzy field (releaseTime) is brute-forced
 *  against the on-chain claimsRoot. No backup file required. */
export default function RecoverPage() {
  const cfg = useMemo(() => getNetworkConfig(), []);
  const { readProvider } = useWallet();
  const eddsa = useEdDSAKey();

  const [rootOrTx, setRootOrTx] = useState("");
  const [tokenSymbol, setTokenSymbol] = useState(cfg.tokens[0]?.symbol ?? "");
  const [recipientsText, setRecipientsText] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const token = cfg.tokens.find((t) => t.symbol === tokenSymbol);

  async function recover() {
    try {
      setPhase({ kind: "running", scanned: 0, total: 0 });
      if (!readProvider) throw new Error("Connect your wallet first.");
      if (!token) throw new Error("Pick the payout token.");
      const settlementAddress = cfg.contracts.privateSettlement;

      // 1. Resolve the on-chain claimsRoot. A tx hash and a claimsRoot are
      //    both 32-byte hex, so disambiguate by lookup: if the input is a
      //    real tx, read the root from its ScatterDirectAuthSettled event;
      //    otherwise treat it as the claimsRoot directly.
      const input = rootOrTx.trim();
      if (!ethers.isHexString(input, 32)) {
        throw new Error("Paste a 0x 32-byte settle tx hash or claimsRoot.");
      }
      const receipt = await readProvider.getTransactionReceipt(input).catch(() => null);
      let claimsRoot: string;
      if (receipt) {
        const root = extractSettledClaimsRoot(receipt, settlementAddress);
        if (!root) throw new Error("That tx didn't register a claims group for this settlement.");
        claimsRoot = toBytes32Hex(root);
      } else {
        claimsRoot = input.toLowerCase();
      }

      // 2. Confirm the root is actually settled on-chain.
      const settled = await makeIsRootSettled(readProvider, settlementAddress)(claimsRoot);
      if (!settled) throw new Error("No claims group for that root on-chain.");

      // 3. Parse recipients ("address,amount" per line, in original order).
      const recipients = recipientsText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line, i) => {
          const [addr, amt] = line.split(",").map((s) => s.trim());
          if (!addr || !ethers.isAddress(addr)) throw new Error(`Row ${i + 1}: bad address "${addr}".`);
          if (!amt) throw new Error(`Row ${i + 1}: missing amount.`);
          return { recipient: ethers.getAddress(addr), amount: ethers.parseUnits(amt, token.decimals) };
        });
      if (recipients.length === 0) throw new Error("Add at least one recipient.");

      const startSec = Math.floor(new Date(startDate).getTime() / 1000);
      const endSec = Math.floor(new Date(endDate).getTime() / 1000);
      if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) {
        throw new Error("Set the claim-from search window (start and end).");
      }

      // 4. Re-derive the seed from the wallet and brute-force releaseTime.
      const kp = await eddsa.derive();
      const seed = claimSeedFromKey(kp.privateKey);
      const res = await deepRecoverReleaseTime({
        seed,
        recipients,
        token: token.address,
        tierCap: TIER_CAP,
        targetClaimsRoot: claimsRoot,
        startSec,
        endSec,
        onProgress: (scanned, total) => setPhase({ kind: "running", scanned, total }),
      });
      if (!res) {
        throw new Error("No match in that window. Widen the claim-from range and retry.");
      }

      // 5. Rebuild + persist a backup, and surface claim links.
      const backup: ClaimsBackup = {
        version: 1,
        createdAt: Math.floor(Date.now() / 1000),
        chainId: cfg.chainId,
        settlementAddress,
        claimsRoot,
        tierCap: TIER_CAP,
        token: token.address,
        tokenSymbol: token.symbol,
        tokenDecimals: token.decimals,
        payoutSeed: seed.toString(),
        claims: res.claims.map((c) => ({
          recipient: c.recipient,
          amount: c.amount.toString(),
          releaseTime: c.releaseTime.toString(),
          secret: c.secret.toString(),
        })),
      };
      const packages: ClaimPackage[] = await rebuildClaimPackages(backup);
      // Persisting a backup is best-effort — surfacing the links is the
      // priority. Track success so the UI can warn if it didn't save (no
      // folder open / write denied) and the operator must copy the links now.
      let backupSaved = true;
      try {
        await saveClaimsBackup(backup);
      } catch {
        backupSaved = false;
      }
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      const links = packages.map((p) => ({
        recipient: p.recipient,
        url: `${origin}/claim#${encodeClaimPackage(p)}`,
      }));
      setPhase({ kind: "found", releaseTime: Number(res.releaseTime), links, backupSaved });
    } catch (e) {
      setPhase({ kind: "error", message: e instanceof Error ? e.message : "Recovery failed." });
    }
  }

  const running = phase.kind === "running";

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <WorkspaceBar />
      <div>
        <h1 className="text-xl font-semibold">Deep recover claim links</h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          Lost a run&apos;s claim links and have no backup? Re-derive them from your wallet.
          Supply the recipients + amounts (in the original order) and a claim-from time window;
          this matches them against the on-chain settlement.
        </p>
      </div>

      <label className="block text-sm">
        <span className="text-[var(--color-text-muted)]">Settle tx hash (0x…) or claimsRoot</span>
        <input
          value={rootOrTx}
          onChange={(e) => setRootOrTx(e.target.value)}
          placeholder="0x…"
          className="mt-1 w-full rounded-md border border-[var(--color-border)] px-3 py-2 font-mono text-xs"
        />
      </label>

      <label className="block text-sm">
        <span className="text-[var(--color-text-muted)]">Token</span>
        <select
          value={tokenSymbol}
          onChange={(e) => setTokenSymbol(e.target.value)}
          className="mt-1 w-full rounded-md border border-[var(--color-border)] px-3 py-2"
        >
          {cfg.tokens.map((t) => (
            <option key={t.symbol} value={t.symbol}>
              {t.symbol}
            </option>
          ))}
        </select>
      </label>

      <label className="block text-sm">
        <span className="text-[var(--color-text-muted)]">
          Recipients — one per line, <code>address,amount</code>, in the original order
        </span>
        <textarea
          value={recipientsText}
          onChange={(e) => setRecipientsText(e.target.value)}
          rows={5}
          placeholder={"0xabc…,100\n0xdef…,200"}
          className="mt-1 w-full rounded-md border border-[var(--color-border)] px-3 py-2 font-mono text-xs"
        />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="block text-sm">
          <span className="text-[var(--color-text-muted)]">Claim-from window start</span>
          <input
            type="datetime-local"
            step={1}
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="mt-1 w-full rounded-md border border-[var(--color-border)] px-3 py-2 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="text-[var(--color-text-muted)]">end</span>
          <input
            type="datetime-local"
            step={1}
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="mt-1 w-full rounded-md border border-[var(--color-border)] px-3 py-2 text-sm"
          />
        </label>
      </div>

      <button
        onClick={recover}
        disabled={running}
        className="rounded-md border border-[var(--color-border-strong)] px-4 py-2 text-sm font-medium hover:bg-[var(--color-primary-soft)] disabled:opacity-50"
      >
        {running ? "Searching…" : "Recover claim links"}
      </button>

      {phase.kind === "running" && phase.total > 0 && (
        <div className="text-xs text-[var(--color-text-muted)]">
          Scanned {phase.scanned.toLocaleString()} / {phase.total.toLocaleString()} candidates…
        </div>
      )}
      {phase.kind === "error" && (
        <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-3 text-xs text-[var(--color-warning)]">
          {phase.message}
        </div>
      )}
      {phase.kind === "found" && (
        <div className="space-y-2 rounded-md border border-[var(--color-success)] bg-[var(--color-success-soft)] p-3 text-xs">
          <div className="font-semibold text-[var(--color-success)]">
            Recovered {phase.links.length} claim link(s) — claim-from{" "}
            {new Date(phase.releaseTime * 1000).toISOString()}
          </div>
          {phase.links.map((l) => (
            <div key={l.recipient} className="break-all font-mono">
              <span className="text-[var(--color-text-muted)]">{l.recipient}</span>
              <br />
              {l.url}
            </div>
          ))}
          {phase.backupSaved ? (
            <p className="text-[var(--color-text-muted)]">A backup was saved to your workspace folder.</p>
          ) : (
            <p className="text-[var(--color-warning)]">
              ⚠ Couldn&apos;t save a backup (no workspace folder open or write denied) — copy these
              links now.
            </p>
          )}
        </div>
      )}

      <div className="pt-2 text-xs">
        <Link href="/dashboard" className="text-[var(--color-primary)] hover:underline">
          ← Back to dashboard
        </Link>
      </div>
    </div>
  );
}
