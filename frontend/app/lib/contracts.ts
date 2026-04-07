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

export const PRIVATE_SETTLEMENT_ABI = [
  "function nullifiers(bytes32) view returns (bool)",
  "function claimNullifiers(bytes32) view returns (bool)",
  "event PrivateClaim(bytes32 indexed claimsRoot, bytes32 indexed nullifier, address indexed recipient, address token, uint256 amount)",
];

// Pre-parsed interfaces — avoids re-parsing ABI on every render cycle
export const RELAYER_REGISTRY_IFACE = new ethers.Interface(RELAYER_REGISTRY_ABI);
export const ERC20_IFACE = new ethers.Interface(ERC20_ABI);
