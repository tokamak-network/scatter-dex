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
  "function relayerList(uint256) external view returns (address)",
  "function relayers(address) external view returns (string url, string name, uint256 fee, uint256 bond, uint256 registeredAt, uint256 exitRequestedAt, bool active)",
  "function treasury() external view returns (address)",
  "function minBond() external view returns (uint256)",
  "function identityRegistry() external view returns (address)",
  "function bondToken() external view returns (address)",
  // Owner-only management — exposed read-side here for admin UIs;
  // mutating calls require the connected wallet to match `owner()`.
  "function owner() external view returns (address)",
  "function pendingOwner() external view returns (address)",
  "function setTreasury(address _treasury) external",
  "function setMinBond(uint256 _minBond) external",
  "function setIdentityRegistry(address _identityRegistry) external",
  "function transferOwnership(address newOwner) external",
  "function acceptOwnership() external",
  "event IdentityRegistryUpdated(address oldRegistry, address newRegistry)",
  "event TreasuryUpdated(address oldTreasury, address newTreasury)",
  "event MinBondUpdated(uint256 oldMinBond, uint256 newMinBond)",
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
  // Settlement-side token whitelist (settle/claim eligibility). The UI
  // intersects this with CommitmentPool's list so only tokens usable
  // for the full deposit→settle→claim flow surface in pickers.
  "function getWhitelistedTokens() external view returns (address[])",
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
  "event PrivateClaim(bytes32 indexed claimsRoot, bytes32 indexed nullifier, address indexed recipient, address token, uint256 amount)",
  "event PrivateCancel(bytes32 indexed escrowNullifier, bytes32 indexed nonceNullifier, bytes32 newCommitment, address indexed relayer)",
  "event PrivateSettledAuth(bytes32 indexed makerNullifier, bytes32 indexed takerNullifier, bytes32 claimsRootMaker, bytes32 claimsRootTaker, address indexed makerRelayer, address takerRelayer, address submitter, uint96 feeTokenMaker, uint96 feeTokenTaker)",
  "event SettledWithDex(bytes32 indexed nullifier, bytes32 indexed claimsRoot, address sellToken, address buyToken, uint128 sellAmount, uint256 amountOut, uint128 totalLocked, address indexed submitter)",
] as const;

export const COMMITMENT_POOL_ABI = [
  "function deposit(uint256[2] proofA, uint256[2][2] proofB, uint256[2] proofC, uint256 commitment, address token, uint256 amount) external",
  "function withdraw(uint256[2] proofA, uint256[2][2] proofB, uint256[2] proofC, uint256 root, uint256 nullifierHash, uint256 newCommitment, address token, uint256 amount, address recipient, address relayer) external",
  "function isKnownRoot(uint256 root) view returns (bool)",
  // Enumerable token whitelist — owner adds tokens post-deploy via
  // `setTokenWhitelist`; this getter lets the UI build its token list
  // from chain state instead of a hand-maintained `NEXT_PUBLIC_TOKENS`
  // env. Returns every currently-whitelisted ERC-20 address.
  "function getWhitelistedTokens() external view returns (address[])",
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
  "function pendingFeeBps() view returns (uint256)",
  "function pendingFeeEffectiveTime() view returns (uint256)",
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

// IssuanceApprovalRegistry — UX gate that lets operators see the
// "Get your cert" CTA on `/register` with the right CN/O/C metadata
// already filled. NOT a security boundary (the actual gate is the
// zk-X509 IdentityRegistry — see docs/operations/registering-a-relayer.md).
// Both the admin console (`/admin/issuance`) and the operator-side
// `useIssuanceApproval` hook decode the same `approvals(address)`
// struct shape, so the fragment lives here once.
export const ISSUANCE_APPROVAL_REGISTRY_ABI = [
  "function approve(address operator, string commonName, string organization, string country, uint32 validityDays, uint64 expiresAt) external",
  "function revoke(address operator, string reason) external",
  // `approvals` returns the `Approval` struct as a SINGLE tuple, not
  // a flat list of fields. Solidity's `returns (Approval memory)` ABI-
  // encodes the result as one tuple; a flat `returns (string, string,
  // …)` here would make ethers v6 expect 10 separate top-level values
  // and decoding would throw `data out-of-bounds` at runtime. Keep
  // the `tuple(...)` wrapper.
  "function approvals(address operator) external view returns (tuple(string commonName, string organization, string country, uint32 validityDays, address approvedBy, uint64 approvedAt, uint64 expiresAt, bool revoked, string revokeReason, uint64 revokedAt))",
  "function isApproved(address operator) external view returns (bool)",
  "function owner() external view returns (address)",
  "function pendingOwner() external view returns (address)",
  "function transferOwnership(address newOwner) external",
  "function acceptOwnership() external",
  "event ApprovalRecorded(address indexed operator, string commonName, string organization, string country, uint32 validityDays, address indexed approvedBy, uint64 approvedAt, uint64 expiresAt)",
  "event ApprovalRevoked(address indexed operator, address indexed revokedBy, uint64 revokedAt, string reason)",
  // Emitted alongside `ApprovalRecorded` only when `approve()` is
  // overwriting an existing row. Carries the prior state so audit
  // consumers don't have to walk every preceding event to find what
  // was just replaced. `ApprovalRecorded` still follows for the
  // canonical "current state" record.
  "event ApprovalReplaced(address indexed operator, address indexed approvedBy, uint64 priorApprovedAt, bool priorRevoked, string priorRevokeReason)",
  // Custom-error fragments — keep in sync with contracts/src/IssuanceApprovalRegistry.sol.
  // Needed so ethers v6 decodes reverts by name; without them the
  // admin console shows raw selector hex on a failed approve/revoke.
  "error ZeroOperator()",
  "error EmptyCommonName()",
  "error EmptyOrganization()",
  "error CountryMustBeISO3166Alpha2()",
  "error ValidityOutOfRange()",
  "error ExpiresAtMustBeFutureOrZero()",
  "error NoApprovalToRevoke()",
  "error AlreadyRevoked()",
  "error RenounceOwnershipDisabled()",
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
