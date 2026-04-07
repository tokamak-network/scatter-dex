import { ethers } from "ethers";

export const SETTLEMENT_ABI = [
  "function deposit(address token, uint256 amount) external",
  "function withdraw(address token, uint256 amount) external",
  "function cancelOrder(uint256 nonce) external",
  "function claimRelease(bytes32 secret) external",
  "function claimReleaseAsEth(bytes32 secret) external",
  "function claimReleaseFor(bytes32 secret, address recipient, uint256 relayerTip, uint256 deadline, bytes recipientSig) external",
  "function claimReleaseForAsEth(bytes32 secret, address recipient, uint256 relayerTip, uint256 deadline, bytes recipientSig) external",
  "function weth() external view returns (address)",
  "function refundUnclaimed(bytes32 claimHash) external",
  "function deposits(address user, address token) external view returns (uint256)",
  "function schedules(bytes32 claimHash) external view returns (address token, uint48 releaseTime, bool claimed, address depositor, uint96 amount)",
  "function nonces(address user, uint256 nonce) external view returns (uint8)",
  "function gaslessNonces(address recipient) external view returns (uint256)",
  "event Deposited(address indexed user, address indexed token, uint256 amount)",
  "event Withdrawn(address indexed user, address indexed token, uint256 amount)",
  "event Settled(address indexed maker, address indexed taker, bytes32[] claimHashes)",
  "event Claimed(bytes32 indexed claimHash, address indexed recipient, address indexed token, uint256 amount)",
  "event ClaimedFor(bytes32 indexed claimHash, address indexed recipient, address indexed token, address relayer, uint256 recipientAmount, uint256 relayerTip)",
  "event Refunded(bytes32 indexed claimHash, address indexed depositor, uint256 amount)",
  "error NotVerified()",
  "error ZeroAmount()",
  "error InsufficientBalance()",
  "error InvalidSignature()",
  "error NonceConsumed()",
  "error OrderExpired()",
  "error TokenMismatch()",
  "error FeeExceedsMax()",
  "error InvalidClaimCount()",
  "error ZeroClaimAmount()",
  "error ClaimsSumMismatch()",
  "error InsufficientEscrow()",
  "error ScheduleNotFound()",
  "error AlreadyClaimed()",
  "error NotYetReleasable()",
  "error ClaimWindowNotExpired()",
  "error NotDepositor()",
  "error ContractPaused()",
  "error DuplicateClaimHash()",
  "error TokenNotWhitelisted()",
  "error ReleaseDelayTooShort()",
  "error TipExceedsAmount()",
  "error SignatureExpired()",
  "error NotWETH()",
  "error ETHTransferFailed()",
];

export const RELAYER_REGISTRY_ABI = [
  "function register(string url, uint256 fee) external payable",
  "function requestExit() external",
  "function executeExit() external",
  "function updateInfo(string url, uint256 fee) external",
  "function addBond() external payable",
  "function isActiveRelayer(address relayer) external view returns (bool)",
  "function getActiveRelayers() external view returns (address[])",
  "function getRelayerCount() external view returns (uint256)",
  "function relayers(address) external view returns (string url, uint256 fee, uint256 bond, uint256 registeredAt, uint256 exitRequestedAt, bool active)",
  "function treasury() external view returns (address)",
  "function MIN_BOND() external view returns (uint256)",
];

export const IDENTITY_GATE_ABI = [
  "function isVerified(address user) external view returns (bool)",
  "function verifiedUntil(address user) external view returns (uint64)",
];

export const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
  "function symbol() external view returns (string)",
  "function decimals() external view returns (uint8)",
];

export const VAULTSKILLS_ABI = [
  "function approveAndDeposit(address settlement, address token, uint256 amount) external",
  "function approveAndDepositMultiple(address settlement, tuple(address token, uint256 amount)[] tokens) external",
  "function withdrawMultiple(address settlement, tuple(address token, uint256 amount)[] tokens) external",
];

// Human-readable error messages for contract custom errors
const ERROR_MESSAGES: Record<string, string> = {
  NotVerified: "Your address is not verified. Please complete identity verification first.",
  ScheduleNotFound: "No claim found for this secret and address combination.",
  AlreadyClaimed: "This claim has already been collected.",
  NotYetReleasable: "This claim is still locked. Please wait until the release time.",
  ContractPaused: "The contract is currently paused.",
  TokenNotWhitelisted: "This token is not whitelisted.",
  InsufficientBalance: "Insufficient balance.",
  InsufficientEscrow: "Insufficient escrow balance.",
  NotWETH: "This claim is not WETH — cannot receive as ETH.",
  ETHTransferFailed: "ETH transfer failed.",
  TipExceedsAmount: "Relayer tip exceeds claim amount.",
  SignatureExpired: "Signature has expired.",
  InvalidSignature: "Invalid signature.",
};

export function decodeContractError(err: unknown): string {
  if (!(err instanceof Error)) return "Unknown error";
  const msg = err.message;
  // Try to extract custom error data from ethers CALL_EXCEPTION
  const dataMatch = msg.match(/data="(0x[a-f0-9]+)"/i);
  if (dataMatch) {
    try {
      const parsed = SETTLEMENT_IFACE.parseError(dataMatch[1]);
      if (parsed) {
        return ERROR_MESSAGES[parsed.name] || parsed.name;
      }
    } catch { /* fall through */ }
  }
  // Fallback: return original message
  return msg;
}

export const PRIVATE_SETTLEMENT_ABI = [
  "function nullifiers(bytes32) view returns (bool)",
  "function claimNullifiers(bytes32) view returns (bool)",
  "event PrivateClaim(bytes32 indexed claimsRoot, bytes32 indexed nullifier, address indexed recipient, address token, uint256 amount)",
];

// Pre-parsed interfaces — avoids re-parsing ABI on every render cycle
export const SETTLEMENT_IFACE = new ethers.Interface(SETTLEMENT_ABI);
export const RELAYER_REGISTRY_IFACE = new ethers.Interface(RELAYER_REGISTRY_ABI);
export const ERC20_IFACE = new ethers.Interface(ERC20_ABI);
export const VAULTSKILLS_IFACE = new ethers.Interface(VAULTSKILLS_ABI);
