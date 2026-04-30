"use client";

import { LAUNCH_TOKENS } from "@zkscatter/sdk";
import type { useEdDSAKey } from "@zkscatter/sdk/react";
import { getNetworkConfig } from "../../_lib/network";

export interface DryRunDepositArgs {
  tokenSymbol: string;
  amountRaw: bigint;
  account: string | null;
  eddsa: ReturnType<typeof useEdDSAKey>;
}

/** Pre-flight log of the deposit args the wizard will hand to the
 *  real deposit path once Phase B lands. Keeps the wallet round-trip
 *  + EdDSA derivation on the same path the live flow will use, so
 *  any breakage shows up in dev before the on-chain call exists. */
export async function dryRunDeposit({
  tokenSymbol,
  amountRaw,
  account,
  eddsa,
}: DryRunDepositArgs) {
  const tokenInfo = LAUNCH_TOKENS[tokenSymbol];
  if (!account || !tokenInfo) return;
  const cfg = getNetworkConfig();
  let publicKey: readonly [bigint, bigint] | null = null;
  try {
    const kp = await eddsa.derive();
    publicKey = kp.publicKey;
  } catch (err) {
    console.warn("[Pay dry-run] EdDSA key not derived — deposit input will be incomplete", err);
  }
  console.info("[Pay dry-run] deposit", {
    chainId: cfg.chainId,
    pool: cfg.contracts.commitmentPool,
    settlement: cfg.contracts.privateSettlement,
    token: tokenInfo.address,
    amount: amountRaw.toString(),
    account,
    publicKey: publicKey ? [publicKey[0].toString(), publicKey[1].toString()] : null,
  });
}
