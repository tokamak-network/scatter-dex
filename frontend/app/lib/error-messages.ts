/**
 * User-friendly error message mapper.
 *
 * Translates raw Solidity reverts, ethers errors, and ZK proof failures
 * into messages that non-technical users can understand and act on.
 */

// Solidity custom error → user message
const CONTRACT_ERRORS: Record<string, string> = {
  // CommitmentPool
  ZeroAmount: "Amount must be greater than zero.",
  ZeroCommitment: "Invalid deposit commitment.",
  TokenNotWhitelisted: "This token is not supported. Use a whitelisted token.",
  UnknownRoot: "Transaction expired. The Merkle tree has been updated — please retry.",
  NullifierAlreadySpent: "This note has already been used. It cannot be spent again.",
  InvalidProof: "ZK proof verification failed. Please regenerate the proof and try again.",
  ContractPaused: "The contract is currently paused for maintenance. Try again later.",
  InsufficientPoolBalance: "Not enough funds in the pool to complete this operation.",
  FieldElementOutOfRange: "One of the values is too large. Check your input amounts.",
  FeeOnTransferTokenUnsupported: "Fee-on-transfer tokens are not supported.",
  AddressSanctioned: "This address is restricted and cannot interact with the protocol.",
  FeeExceedsMax: "The fee exceeds the maximum allowed.",

  // PrivateSettlement
  ClaimsGroupNotFound: "Claim not found. It may have expired or been processed.",
  ExceedsTotalLocked: "Claim amount exceeds the locked total.",
  NotYetReleasable: "This claim is not yet available. Please wait for the release time.",
  TokenMismatch: "Token mismatch between order sides.",
  AmountOverflow: "Amount is too large to process.",
  ZeroSellAmount: "Sell amount must be greater than zero.",
  TokenSidesMismatch: "Sell and buy tokens cannot be the same.",
  PriceMismatch: "Price doesn't match between maker and taker orders.",
  ClaimsCapExceeded: "Too many claims in this order. Maximum is 16.",
  OrderExpired: "This order has expired. Create a new order.",
  DexRouterNotWhitelisted: "DEX router is not approved for use.",
  DexCallReverted: "DEX swap failed. The liquidity pool may have insufficient funds.",
  DexOutputInsufficient: "DEX output is less than expected. Try increasing slippage tolerance.",
  DexPlatformFeeTooHigh: "Platform fee is too high.",
  DeadlineExpired: "Transaction deadline has passed. Please retry.",
  NotActiveRelayer: "The relayer is not active. Try a different relayer.",

  // RelayerRegistry
  AlreadyRegistered: "This relayer is already registered.",
  NotRegistered: "Relayer is not registered.",
  InsufficientBond: "Relayer bond amount is insufficient.",
  AlreadyExiting: "Relayer is already in the exit process.",

  // FeeVault
  NothingToClaim: "No fees available to claim.",
};

// ethers.js / MetaMask error patterns
const WALLET_PATTERNS: Array<[RegExp, string]> = [
  [/user rejected|user denied|ACTION_REJECTED/i, "Transaction was cancelled."],
  [/insufficient funds/i, "Insufficient funds to cover the transaction and gas fees."],
  [/nonce.*too (low|high)/i, "Transaction nonce conflict. Please reset your wallet or wait for pending transactions."],
  [/UNPREDICTABLE_GAS_LIMIT/i, "Transaction would fail. Check your input values and try again."],
  [/execution reverted/i, "Transaction reverted by the contract. Check your inputs."],
  [/network.*changed|chain.*mismatch/i, "Wrong network. Please switch to the correct chain."],
  [/replacement.*underpriced/i, "Gas price too low. Increase gas and retry."],
  [/timeout|ETIMEDOUT|ECONNREFUSED/i, "Network connection failed. Check your internet and RPC endpoint."],
  [/could not detect network/i, "Cannot connect to the blockchain. Check your RPC URL."],
  [/missing revert data/i, "Transaction would fail. The contract rejected this operation."],
];

// ZK / proof errors
const ZK_PATTERNS: Array<[RegExp, string]> = [
  [/wasm.*not.*found|wasm.*failed/i, "ZK proof engine failed to load. Refresh the page and try again."],
  [/witness.*failed|constraint.*not.*satisfied/i, "ZK proof generation failed. Your input values may be invalid."],
  [/zkey.*not.*found/i, "ZK proving key not found. Ensure circuit files are available."],
  [/Note missing pub[Kk]ey/i, "This is a v1 note incompatible with v2 circuits. You need to re-deposit."],
];

/**
 * Convert a raw error into a user-friendly message.
 * Returns the friendly message, or the original message if no match is found.
 */
export function friendlyError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);

  // 1. Check Solidity custom errors (e.g., "InvalidProof()" or "reverted with custom error 'InvalidProof'")
  for (const [name, message] of Object.entries(CONTRACT_ERRORS)) {
    if (raw.includes(name)) return message;
  }

  // 2. Check wallet/network patterns
  for (const [pattern, message] of WALLET_PATTERNS) {
    if (pattern.test(raw)) return message;
  }

  // 3. Check ZK patterns
  for (const [pattern, message] of ZK_PATTERNS) {
    if (pattern.test(raw)) return message;
  }

  // 4. Truncate long raw messages
  if (raw.length > 200) return raw.slice(0, 200) + "...";

  return raw;
}
