"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { useWallet } from "../../lib/wallet";
import { getSettlementAddress } from "../../lib/config";
import { SETTLEMENT_ABI, ERC20_ABI } from "../../lib/contracts";
import { getTokenList, type TokenInfo } from "../../lib/tokens";

export interface TokenBalance {
  token: TokenInfo;
  escrow: bigint;
  wallet: bigint;
}

export type TxStatus = "idle" | "authorizing" | "depositing" | "withdrawing" | "success" | "error";

// ─── EIP-5792 wallet_sendCalls helpers ────────────────────────

interface Call {
  to: string;
  data?: string;
  value?: string; // hex
}

/**
 * Try to send batched calls via EIP-5792 wallet_sendCalls.
 * Returns the bundle ID if supported, or null if the wallet doesn't support it.
 */
async function trySendCalls(
  provider: ethers.BrowserProvider,
  from: string,
  chainId: number,
  calls: Call[]
): Promise<string | null> {
  try {
    const result = await provider.send("wallet_sendCalls", [{
      version: "2.0.0",
      from,
      chainId: "0x" + chainId.toString(16),
      atomicRequired: true,
      calls,
    }]);
    return result; // bundle ID
  } catch {
    return null; // wallet doesn't support EIP-5792 or chain doesn't support 7702
  }
}

/**
 * Poll wallet_getCallsStatus until the bundle is confirmed or failed.
 */
async function waitForCalls(
  provider: ethers.BrowserProvider,
  bundleId: string,
  timeoutMs = 120_000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const status = await provider.send("wallet_getCallsStatus", [bundleId]);
      // status codes: https://eips.ethereum.org/EIPS/eip-5792
      if (status.status === 200 || status.status === "CONFIRMED") return;
      if (status.status === 500 || status.status === "FAILED") {
        throw new Error("Batch transaction failed");
      }
    } catch (e) {
      // If getCallsStatus not supported, just wait and hope
      if ((e as Error).message?.includes("Batch transaction failed")) throw e;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Batch transaction timed out");
}

// ─── Encode helpers ───────────────────────────────────────────

const wethIface = new ethers.Interface(["function deposit() external payable"]);
const erc20Iface = new ethers.Interface(ERC20_ABI);
const settlementIface = new ethers.Interface(SETTLEMENT_ABI);

function toHexValue(amount: bigint): string {
  return "0x" + amount.toString(16);
}

// ─── Hook ─────────────────────────────────────────────────────

export function useEscrow() {
  const { account, chainId, signer, readProvider, provider } = useWallet();
  const [balances, setBalances] = useState<TokenBalance[]>([]);
  const [loading, setLoading] = useState(false);
  const [txStatus, setTxStatus] = useState<TxStatus>("idle");
  const [txError, setTxError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [txAction, setTxAction] = useState<"deposit" | "withdraw" | null>(null);

  const tokens = useMemo(() => getTokenList(), []);

  // ─── Fetch balances ─────────────────────────────────────────

  const fetchBalances = useCallback(async () => {
    if (!account || !readProvider) return;
    setLoading(true);
    try {
      let settlementAddr: string;
      try {
        settlementAddr = getSettlementAddress();
      } catch {
        setLoading(false);
        return;
      }
      const settlement = new ethers.Contract(settlementAddr, SETTLEMENT_ABI, readProvider);

      const results: TokenBalance[] = (await Promise.all(
        tokens.map(async (token): Promise<TokenBalance | null> => {
          try {
            let escrow = BigInt(0);
            try {
              escrow = await settlement.deposits(account, token.address);
            } catch {
              // deposits() may revert for unwhitelisted tokens
            }
            let wallet: bigint;
            if (token.isNative) {
              wallet = await readProvider.getBalance(account);
            } else {
              const erc20 = new ethers.Contract(token.address, ERC20_ABI, readProvider);
              wallet = await erc20.balanceOf(account);
            }
            return { token, escrow, wallet };
          } catch (e) {
            console.error(`Failed to fetch ${token.symbol}:`, e);
            return null;
          }
        })
      )).filter((b): b is TokenBalance => b !== null);

      setBalances(results);
    } catch (e) {
      console.error("Failed to fetch balances:", e);
    } finally {
      setLoading(false);
    }
  }, [account, readProvider, tokens]);

  useEffect(() => {
    fetchBalances();
  }, [fetchBalances]);

  // ─── Deposit ────────────────────────────────────────────────

  const deposit = useCallback(
    async (token: TokenInfo, amount: bigint) => {
      if (!signer || !readProvider || !account || !provider) {
        throw new Error("Wallet not connected");
      }
      setTxError(null);
      setTxHash(null);
      setTxAction("deposit");

      const settlementAddr = getSettlementAddress();

      try {
        if (token.isNative) {
          // ETH: try batch (wrap + approve + deposit) via wallet_sendCalls
          if (chainId) {
            setTxStatus("depositing");
            const calls: Call[] = [
              { to: token.address, data: wethIface.encodeFunctionData("deposit"), value: toHexValue(amount) },
              { to: token.address, data: erc20Iface.encodeFunctionData("approve", [settlementAddr, ethers.MaxUint256]) },
              { to: settlementAddr, data: settlementIface.encodeFunctionData("deposit", [token.address, amount]) },
            ];
            const bundleId = await trySendCalls(provider, account, chainId, calls);
            if (bundleId) {
              await waitForCalls(provider, bundleId);
              setTxStatus("success");
              await fetchBalances();
              return;
            }
          }

          // Fallback: 3 separate TXs
          setTxStatus("authorizing");
          const wethContract = new ethers.Contract(token.address, ["function deposit() external payable"], signer);
          const wrapTx = await wethContract.deposit({ value: amount });
          await wrapTx.wait();
          await depositTraditional({ ...token, isNative: false }, amount, settlementAddr);
          return;
        }

        // ERC20: try batch (approve + deposit) via wallet_sendCalls
        if (chainId) {
          setTxStatus("depositing");
          const calls: Call[] = [
            { to: token.address, data: erc20Iface.encodeFunctionData("approve", [settlementAddr, ethers.MaxUint256]) },
            { to: settlementAddr, data: settlementIface.encodeFunctionData("deposit", [token.address, amount]) },
          ];
          const bundleId = await trySendCalls(provider, account, chainId, calls);
          if (bundleId) {
            await waitForCalls(provider, bundleId);
            setTxStatus("success");
            await fetchBalances();
            return;
          }
        }

        // Fallback: traditional approve + deposit
        await depositTraditional(token, amount, settlementAddr);
      } catch (e: unknown) {
        setTxStatus("error");
        setTxError(e instanceof Error ? e.message : "Transaction failed");
        throw e;
      }
    },
    [signer, readProvider, account, chainId, provider, fetchBalances]
  );

  // ─── Traditional deposit (fallback) ─────────────────────────

  const depositTraditional = useCallback(
    async (token: TokenInfo, amount: bigint, settlementAddr: string) => {
      if (!signer) throw new Error("Wallet not connected");

      setTxStatus("authorizing");
      const erc20 = new ethers.Contract(token.address, ERC20_ABI, signer);
      const allowance: bigint = await erc20.allowance(await signer.getAddress(), settlementAddr);
      if (allowance < amount) {
        const approveTx = await erc20.approve(settlementAddr, ethers.MaxUint256);
        await approveTx.wait();
      }

      setTxStatus("depositing");
      const settlement = new ethers.Contract(settlementAddr, SETTLEMENT_ABI, signer);
      const tx = await settlement.deposit(token.address, amount);
      await tx.wait();
      setTxHash(tx.hash);

      setTxStatus("success");
      await fetchBalances();
    },
    [signer, fetchBalances]
  );

  // ─── Withdraw ───────────────────────────────────────────────

  const withdraw = useCallback(
    async (token: TokenInfo, amount: bigint) => {
      if (!signer) throw new Error("Wallet not connected");
      setTxError(null);

      try {
        setTxStatus("withdrawing");
        setTxHash(null);
        setTxAction("withdraw");
        const settlementAddr = getSettlementAddress();
        const settlement = new ethers.Contract(settlementAddr, SETTLEMENT_ABI, signer);
        const tx = await settlement.withdraw(token.address, amount);
        await tx.wait();
        setTxHash(tx.hash);

        setTxStatus("success");
        await fetchBalances();
      } catch (e: unknown) {
        setTxStatus("error");
        setTxError(e instanceof Error ? e.message : "Transaction failed");
        throw e;
      }
    },
    [signer, fetchBalances]
  );

  const resetTx = useCallback(() => {
    setTxStatus("idle");
    setTxError(null);
    setTxHash(null);
    setTxAction(null);
  }, []);

  return { balances, loading, tokens, deposit, withdraw, txStatus, txError, txHash, txAction, resetTx, refetch: fetchBalances };
}
