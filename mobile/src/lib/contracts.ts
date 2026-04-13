import { ethers } from "ethers";

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
  "function minBond() external view returns (uint256)",
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

export const PRIVATE_SETTLEMENT_ABI = [
  "function nullifiers(bytes32) view returns (bool)",
  "function claimNullifiers(bytes32) view returns (bool)",
  "function cancelPrivate((uint256[2] proofA, uint256[2][2] proofB, uint256[2] proofC, uint256 commitmentRoot, bytes32 oldNullifier, bytes32 oldNonceNullifier, bytes32 newCommitment) p) external",
  "function claimWithProof(uint256[2] proofA, uint256[2][2] proofB, uint256[2] proofC, bytes32 claimsRoot, bytes32 claimNullifier, uint256 amount, address token, address recipient, uint256 releaseTime) external",
  "function claimWithProofBatch((uint256[2] proofA, uint256[2][2] proofB, uint256[2] proofC, bytes32 claimsRoot, bytes32 claimNullifier, uint256 amount, address token, address recipient, uint256 releaseTime)[] claims) external",
  "function dexPlatformFeeBps() view returns (uint256)",
  "function whitelistedDexRouters(address) view returns (bool)",
  "event PrivateClaim(bytes32 indexed claimsRoot, bytes32 indexed nullifier, address indexed recipient, address token, uint256 amount)",
  "event PrivateCancel(bytes32 indexed escrowNullifier, bytes32 indexed nonceNullifier, bytes32 newCommitment, address indexed relayer)",
  "event PrivateSettledAuth(bytes32 indexed makerNullifier, bytes32 indexed takerNullifier, bytes32 claimsRootMaker, bytes32 claimsRootTaker, address indexed makerRelayer, address takerRelayer, address submitter, uint96 feeTokenMaker, uint96 feeTokenTaker)",
  "event SettledWithDex(bytes32 indexed nullifier, bytes32 indexed claimsRoot, address sellToken, address buyToken, uint128 sellAmount, uint256 amountOut, uint128 totalLocked, address indexed submitter)",
  "event ScatterDirectAuthSettled(bytes32 indexed nullifier, bytes32 indexed nonceNullifier, bytes32 claimsRoot, address indexed relayer, uint96 fee)",
];

export const PRIVATE_SETTLEMENT_IFACE = new ethers.Interface(PRIVATE_SETTLEMENT_ABI);

export const COMMITMENT_POOL_ABI = [
  "function deposit(uint256[2] proofA, uint256[2][2] proofB, uint256[2] proofC, uint256 commitment, address token, uint256 amount) external",
  "function getLastRoot() view returns (uint256)",
  "function nextIndex() view returns (uint32)",
  "function sanctionsList() view returns (address)",
  "event CommitmentInserted(uint256 indexed commitment, uint32 leafIndex, uint256 timestamp)",
];

export const SANCTIONS_LIST_ABI = [
  "function isSanctioned(address addr) view returns (bool)",
];

// Pre-parsed — avoids re-parsing on each cancel/deposit call
export const COMMITMENT_POOL_IFACE = new ethers.Interface(COMMITMENT_POOL_ABI);

export const FEE_VAULT_ABI = [
  "function balances(address relayer, address token) view returns (uint256)",
  "function claim(address token) external",
  "function platformFeeBps() view returns (uint256)",
  "function treasury() view returns (address)",
  "function totalTracked(address token) view returns (uint256)",
];

// Pre-parsed interfaces — avoids re-parsing ABI on every render cycle
export const RELAYER_REGISTRY_IFACE = new ethers.Interface(RELAYER_REGISTRY_ABI);
export const ERC20_IFACE = new ethers.Interface(ERC20_ABI);
