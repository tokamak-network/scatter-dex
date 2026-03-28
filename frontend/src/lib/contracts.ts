export const SETTLEMENT_ABI = [
  "function deposit(address token, uint256 amount) external",
  "function withdraw(address token, uint256 amount) external",
  "function cancelOrder(uint256 nonce) external",
  "function claimRelease(bytes32 secret) external",
  "function claimReleaseFor(bytes32 secret, address recipient, uint256 relayerTip, uint256 deadline, bytes recipientSig) external",
  "function refundUnclaimed(bytes32 claimHash) external",
  "function deposits(address user, address token) external view returns (uint256)",
  "function schedules(bytes32 claimHash) external view returns (address token, uint48 releaseTime, bool claimed, address depositor, uint96 amount)",
  "function nonces(address user, uint256 nonce) external view returns (bool)",
  "event Deposited(address indexed user, address indexed token, uint256 amount)",
  "event Withdrawn(address indexed user, address indexed token, uint256 amount)",
  "event Settled(address indexed maker, address indexed taker, bytes32[] claimHashes)",
  "event Claimed(bytes32 indexed claimHash, address indexed recipient, address indexed token, uint256 amount)",
  "event ClaimedFor(bytes32 indexed claimHash, address indexed recipient, address indexed relayer, address token, uint256 recipientAmount, uint256 relayerTip)",
  "event Refunded(bytes32 indexed claimHash, address indexed depositor, uint256 amount)",
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
