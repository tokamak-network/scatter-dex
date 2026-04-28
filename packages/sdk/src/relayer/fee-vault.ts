import { ethers } from "ethers";
import { isConfiguredAddress } from "../core/addresses";
import { FEE_VAULT_ABI, FEE_VAULT_IFACE } from "../core/contracts";
import type { TokenInfo } from "../core/tokens";
import { callExceptionErrorName } from "./errors";

export interface FeeVaultBalance {
  token: TokenInfo;
  /** Operator's claimable balance in the token's smallest unit. */
  balance: bigint;
}

/** Read every passed token's claimable balance for `operator` in
 *  one shot. Caller decides which tokens to query — typically the
 *  network's `tokens` whitelist — so this stays a pure batched
 *  read with no contract-side enumeration assumed. Tokens whose
 *  address is the zero sentinel (unconfigured slot in a partially
 *  deployed network config) are skipped. */
export async function loadFeeVaultBalances(
  feeVaultAddress: string,
  operator: string,
  tokens: TokenInfo[],
  provider: ethers.Provider,
): Promise<FeeVaultBalance[]> {
  const vault = new ethers.Contract(feeVaultAddress, FEE_VAULT_ABI, provider);
  const queryable = tokens.filter((t) => isConfiguredAddress(t.address));
  return Promise.all(
    queryable.map(async (token): Promise<FeeVaultBalance> => {
      const balance = (await vault.balances(operator, token.address)) as bigint;
      return { token, balance };
    }),
  );
}

/** Submit `claim(token)` to pull the operator's accrued balance
 *  for a single token. Reverts with `NothingToClaim` when the
 *  balance is zero — gate the button on a non-zero balance read
 *  so the wallet prompt never lands on a guaranteed-fail tx. */
export async function claimRelayerFees(
  feeVaultAddress: string,
  tokenAddress: string,
  signer: ethers.Signer,
): Promise<ethers.TransactionResponse> {
  const vault = new ethers.Contract(feeVaultAddress, FEE_VAULT_IFACE, signer);
  return vault.claim(tokenAddress) as Promise<ethers.TransactionResponse>;
}

const FEE_VAULT_ERROR_COPY: Record<string, string> = {
  NothingToClaim: "Nothing to claim — this token has no accrued balance.",
  ZeroAddress: "Invalid token address.",
  InsufficientTokenBalance: "Vault is short on tokens. Try again later or contact the operator team.",
  NotAuthorized: "This wallet is not authorized for that action.",
};

const FEE_VAULT_ERROR_CODES = Object.keys(FEE_VAULT_ERROR_COPY);

/** Best-effort unwrap of an ethers v6 contract-call exception.
 *  v6 surfaces the human-readable summary on `shortMessage`, the
 *  decoded revert reason on `reason`, and the underlying provider
 *  error on `info.error.message`. Fall through these in priority
 *  order before landing on the raw `Error.message` so substring
 *  matching gets the most descriptive string available. */
function unwrapV6Message(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as Error & {
    shortMessage?: string;
    reason?: string;
    info?: { error?: { message?: string } };
  };
  return e.shortMessage ?? e.reason ?? e.info?.error?.message ?? err.message;
}

/** Map FeeVault custom-error reverts to user-facing copy. Falls
 *  back to the unwrapped v6 message so unexpected errors still
 *  surface a useful string instead of `[object Object]`. */
export function explainFeeVaultError(err: unknown): string {
  const named = callExceptionErrorName(err);
  if (named && FEE_VAULT_ERROR_COPY[named]) return FEE_VAULT_ERROR_COPY[named];

  const raw = unwrapV6Message(err);
  for (const code of FEE_VAULT_ERROR_CODES) {
    if (raw.includes(code)) return FEE_VAULT_ERROR_COPY[code];
  }
  return raw;
}
