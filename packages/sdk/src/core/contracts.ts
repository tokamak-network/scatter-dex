import { ethers } from "ethers";

export const RELAYER_REGISTRY_ABI = [
  "function register(string url, string name, uint256 fee, uint256 bondAmount) external payable",
  "function requestExit() external",
  "function executeExit() external",
  "function updateInfo(string url, string name, uint256 fee) external",
  "function addBond(uint256 bondAmount) external payable",
  "function isActiveRelayer(address relayer) external view returns (bool)",
  "function getActiveRelayers() external view returns (address[])",
  "function getRelayerCount() external view returns (uint256)",
  "function relayers(address) external view returns (string url, string name, uint256 fee, uint256 bond, uint256 registeredAt, uint256 exitRequestedAt, bool active)",
  "function treasury() external view returns (address)",
  "function minBond() external view returns (uint256)",
  "function identityRegistry() external view returns (address)",
  "function bondToken() external view returns (address)",
  // Custom-error fragments — needed for ethers v6 to decode reverts
  // by name. Without them, registry reverts arrive as raw selector
  // hex and `explainRegisterError`'s name match silently misses.
  "error AlreadyRegistered()",
  "error NotRegistered()",
  "error InsufficientBond()",
  "error ExitNotRequested()",
  "error CooldownNotPassed()",
  "error AlreadyExiting()",
  "error ZeroAddress()",
  "error RelayerNotActive()",
  "error BondTransferFailed()",
  "error FeeTooHigh()",
  "error NotVerified()",
  "error WrongPaymentMode()",
] as const;

export const IDENTITY_GATE_ABI = [
  "function isVerified(address user) external view returns (bool)",
  "function verifiedUntil(address user) external view returns (uint64)",
  // Owner-only management — exposed read-side here for admin UIs;
  // mutating calls require the connected wallet to match `owner()`.
  "function owner() external view returns (address)",
  "function getRegistryCount() external view returns (uint256)",
  "function getRegistries() external view returns (address[])",
  "function addRegistry(address registry) external",
  "function removeRegistry(address registry) external",
  "event RegistryAdded(address indexed registry)",
  "event RegistryRemoved(address indexed registry)",
] as const;

export const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
  "function symbol() external view returns (string)",
  "function decimals() external view returns (uint8)",
  // Standard transfer entrypoints used by the stealth-transfer flow
  // (`relay7702.buildErc20TransferCalls` encodes calldata via this
  // ABI) and the inbox modal's direct EOA send path. Without them
  // both ethers.encodeFunctionData and Contract.transfer error with
  // `unknown function "transfer"`.
  "function transfer(address to, uint256 amount) external returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) external returns (bool)",
] as const;

export const MOCK_TOKEN_ABI = [
  ...ERC20_ABI,
  "function mint(address to, uint256 amount) external",
] as const;

/** Inner-tuple shape of `SettleVerifyLib.AuthorizeProof`. Exported so
 *  ethers callers, the relayer's runtime tuple builder, and any
 *  ad-hoc test ABI strings can share one source of truth — the field
 *  list otherwise drifts on the next struct change (PR #528 added
 *  `tier`; the previous version was dropped in three places before
 *  this PR caught it). Keep in lock-step with
 *  `contracts/src/zk/SettleVerifyLib.sol#AuthorizeProof`. */
export const AUTHORIZE_PROOF_TUPLE =
  "(uint256[2] proofA, uint256[2][2] proofB, uint256[2] proofC, " +
  "bytes32 pubKeyBind, uint256 commitmentRoot, " +
  "bytes32 nullifier, bytes32 nonceNullifier, bytes32 newCommitment, " +
  "address sellToken, address buyToken, " +
  "uint128 sellAmount, uint128 buyAmount, " +
  "uint16 maxFee, uint64 expiry, " +
  "bytes32 claimsRoot, uint128 totalLocked, " +
  "address relayer, bytes32 orderHash, " +
  "uint8 tier)";

export const PRIVATE_SETTLEMENT_ABI = [
  "function nullifiers(bytes32) view returns (bool)",
  "function claimNullifiers(bytes32) view returns (bool)",
  "function claimsGroups(bytes32) view returns (uint128 totalLocked, uint128 totalClaimed, address token, uint8 tier)",
  // Verifier-registry getters — read by ops/admin scripts that need
  // to inspect or audit which tiers are wired without parsing
  // contract events. JS clients today only consume tier 16
  // implicitly, but the registry shape is what this PR is wiring
  // up so the tooling already has the keys it needs.
  "function authorizeVerifierByTier(uint8) view returns (address)",
  "function claimVerifierByTier(uint8) view returns (address)",
  "function dexPlatformFeeBps() view returns (uint256)",
  "function cancelPrivate((uint256[2] proofA, uint256[2][2] proofB, uint256[2] proofC, uint256 commitmentRoot, bytes32 oldNullifier, bytes32 oldNonceNullifier, bytes32 newCommitment) p) external",
  `function settleWithDex((${AUTHORIZE_PROOF_TUPLE} proof, address dexRouter, bytes dexCalldata, uint256 deadline) p) external`,
  `function settleAuth((${AUTHORIZE_PROOF_TUPLE} maker, ${AUTHORIZE_PROOF_TUPLE} taker, uint96 feeTokenMaker, uint96 feeTokenTaker) p) external`,
  // Pay-style same-token self-pay: one authorize proof, no
  // counterparty matching. Contract enforces sellToken == buyToken
  // and that msg.sender owns / is a registered relayer for the proof.
  `function scatterDirectAuth((${AUTHORIZE_PROOF_TUPLE} proof, uint96 fee) p) external`,
  "event ScatterDirectAuthSettled(bytes32 indexed nullifier, bytes32 indexed nonceNullifier, bytes32 claimsRoot, address indexed relayer, uint96 fee)",
  "function claimWithProof(uint256[2] proofA, uint256[2][2] proofB, uint256[2] proofC, bytes32 claimsRoot, bytes32 claimNullifier, uint256 amount, address token, address recipient, uint256 releaseTime) external",
  "function claimWithProofBatch((uint256[2] proofA, uint256[2][2] proofB, uint256[2] proofC, bytes32 claimsRoot, bytes32 claimNullifier, uint256 amount, address token, address recipient, uint256 releaseTime)[] claims) external",
  // claimToPool — atomic stealth claim → split pool deposits with
  // an EIP-712 ClaimToPoolAuth signature from the stealth privkey.
  "function claimToPool((uint256[2] claimProofA, uint256[2][2] claimProofB, uint256[2] claimProofC, bytes32 claimsRoot, bytes32 claimNullifier, uint256 amount, address token, address stealthRecipient, uint256 releaseTime) p, (uint256[2] proofA, uint256[2][2] proofB, uint256[2] proofC, uint256 commitment, uint256 amount)[] slices, bytes stealthSignature) external",
  "event PrivateClaim(bytes32 indexed claimsRoot, bytes32 indexed nullifier, address indexed recipient, address token, uint256 amount)",
  "event PrivateClaimToPool(bytes32 indexed claimsRoot, bytes32 indexed nullifier, address indexed stealthRecipient, address token, uint256 amount, uint256 sliceCount)",
  "event PrivateCancel(bytes32 indexed escrowNullifier, bytes32 indexed nonceNullifier, bytes32 newCommitment, address indexed relayer)",
  "event PrivateSettledAuth(bytes32 indexed makerNullifier, bytes32 indexed takerNullifier, bytes32 claimsRootMaker, bytes32 claimsRootTaker, address indexed makerRelayer, address takerRelayer, address submitter, uint96 feeTokenMaker, uint96 feeTokenTaker)",
  "event SettledWithDex(bytes32 indexed nullifier, bytes32 indexed claimsRoot, address sellToken, address buyToken, uint128 sellAmount, uint256 amountOut, uint128 totalLocked, address indexed submitter)",
] as const;

export const COMMITMENT_POOL_ABI = [
  "function deposit(uint256[2] proofA, uint256[2][2] proofB, uint256[2] proofC, uint256 commitment, address token, uint256 amount) external",
  "function withdraw(uint256[2] proofA, uint256[2][2] proofB, uint256[2] proofC, uint256 root, uint256 nullifierHash, uint256 newCommitment, address token, uint256 amount, address recipient, address relayer) external",
  "function isKnownRoot(uint256 root) view returns (bool)",
  // CommitmentPool exposes the nullifier map directly via the
  // generated public-mapping getter; there's no `isSpent(uint256)`
  // function. Callers test "already withdrawn" via this getter.
  "function nullifiers(uint256) view returns (bool)",
  "function getLastRoot() view returns (uint256)",
  "function nextIndex() view returns (uint32)",
  "event CommitmentInserted(uint256 indexed commitment, uint32 leafIndex, uint256 timestamp)",
  "event Withdrawal(address indexed recipient, uint256 nullifierHash, uint256 newCommitment, uint256 amount)",
] as const;

export const FEE_VAULT_ABI = [
  "function balances(address relayer, address token) view returns (uint256)",
  "function claim(address token) external",
  "function platformFeeBps() view returns (uint256)",
  "function treasury() view returns (address)",
  "function totalTracked(address token) view returns (uint256)",
  "function platformRevenue(address token) view returns (uint256)",
  "event FeeDeposited(address indexed relayer, address indexed token, uint256 amount)",
  "event FeeClaimed(address indexed relayer, address indexed token, uint256 amount, uint256 platformFee)",
  "event PlatformFeeFromDex(address indexed token, uint256 amount)",
  "event PlatformSurplusFromDex(address indexed token, uint256 amount)",
  "event PlatformFeeFromRelayerClaim(address indexed token, uint256 amount, address indexed relayer)",
  "event PlatformRevenueWithdrawn(address indexed token, uint256 amount, address indexed to)",
  // Error fragments — required for ethers v6 to decode `revert.name` /
  // `errorName` on contract-call exceptions, which `explainFeeVaultError`
  // uses to map reverts to friendly copy.
  "error ZeroAddress()",
  "error FeeTooHigh()",
  "error NotAuthorized()",
  "error NothingToClaim()",
  "error InsufficientTokenBalance()",
  "error NoFeeChangePending()",
  "error FeeChangeNotReady()",
] as const;

// Pre-parsed Interface objects — repeated `new ethers.Interface(...)`
// is cheap individually but adds up in tight render loops, so we
// share these singletons across every contract call site in the SDK.
export const RELAYER_REGISTRY_IFACE = new ethers.Interface(RELAYER_REGISTRY_ABI);
export const IDENTITY_GATE_IFACE = new ethers.Interface(IDENTITY_GATE_ABI);
export const ERC20_IFACE = new ethers.Interface(ERC20_ABI);
export const PRIVATE_SETTLEMENT_IFACE = new ethers.Interface(PRIVATE_SETTLEMENT_ABI);
export const COMMITMENT_POOL_IFACE = new ethers.Interface(COMMITMENT_POOL_ABI);
export const FEE_VAULT_IFACE = new ethers.Interface(FEE_VAULT_ABI);
