// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";
import {IKycApproval} from "./interfaces/IKycApproval.sol";

/// @notice On-chain registry for ScatterDEX relayers.
/// @dev Relayers may optionally stake a bond to register (minBond configurable by owner, default 0).
///      Bond is returned after a cooldown on exit.
///
///      The global `bondToken` is the token NEW registrations bond in
///      (`address(0)` → native `msg.value` mode; non-zero ERC20 → `transferFrom`
///      after `approve`, `msg.value` MUST be 0). The owner may change it anytime
///      via `setBondToken`. Each relayer SNAPSHOTS the global token at register
///      time into `Relayer.bondToken`; their top-up (`addBond`) and withdrawal
///      (`executeExit`) always use that recorded token, never the live global.
///      This lets the owner switch the bond token without stranding or rugging
///      existing bonds — a relayer always gets back exactly what they staked.
///
///      NOTE (L-3): No bond slashing mechanism — malicious relayers lose only gas on
///      failed settle() attempts. Consider adding slashing for repeated violations.
///      NOTE (L-4): getActiveRelayers() iterates the full relayerList. For very large
///      registries, off-chain indexing via events is recommended instead.
contract RelayerRegistry is Initializable, Ownable2StepUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;

    struct Relayer {
        string url;
        // Operator-set display name — distinguishes co-running relayers
        // (e.g. "Relayer-A" / "Relayer-B" in the dev stack) without
        // forcing UIs to round-trip an off-chain `/api/info` probe just
        // to render a label.
        string name;
        uint256 fee; // basis points
        uint256 bond; // staked amount
        uint256 registeredAt;
        uint256 exitRequestedAt; // 0 = active, >0 = exiting
        bool active;
        // Token this relayer's `bond` is denominated in — snapshotted from the
        // global `bondToken` at register time. `address(0)` = native. Top-up
        // and withdrawal always use THIS, never the (possibly-changed) global,
        // so a `setBondToken` switch never strands an existing bond.
        // Appended at the end of the struct → upgrade-safe (the struct is only
        // a `mapping` value; new field reads 0 for pre-upgrade entries).
        address bondToken;
    }

    uint256 public minBond; // optional — 0 means no bond required
    /// @notice Default exit cooldown for fresh deploys / the upgrade reinitializer.
    uint256 public constant DEFAULT_EXIT_COOLDOWN = 7 days;
    /// @notice Hard cap on the owner-settable exit cooldown, so a bond can never
    ///         be trapped indefinitely by an absurd value.
    uint256 public constant MAX_EXIT_COOLDOWN = 30 days;
    uint256 public constant MAX_FEE = 500; // 5% max relayer fee

    /// @dev Was `immutable` in the non-upgradeable predecessor; moved to a regular
    ///      state var because the implementation's constructor never runs through
    ///      the proxy. Value is locked in at `initialize()` and never reassigned.
    IIdentityRegistry public identityRegistry;
    /// @notice Global bond token NEW registrations stake in. `address(0)` = native
    ///         (msg.value) mode. Owner-settable via `setBondToken`; each relayer
    ///         records the value in force at their register time, so changing this
    ///         only affects future registrations.
    IERC20 public bondToken;
    address public treasury;

    mapping(address => Relayer) public relayers;
    mapping(address => bool) private inList; // tracks if address was ever added to relayerList
    address[] public relayerList;

    /// @notice Optional admin KYC-approval gate (the repurposed `IssuanceApprovalRegistry`).
    ///         `address(0)` disables it; see `setKycApprovalRegistry` for the gate semantics.
    /// @dev Appended after `relayerList` (consuming one `__gap` slot) to keep the
    ///      upgrade-safe storage layout intact.
    IKycApproval public kycApprovalRegistry;

    /// @notice Owner-settable cooldown (seconds) between `requestExit` and
    ///         `executeExit`. Was the `EXIT_COOLDOWN` constant; moved to storage
    ///         so the admin can tune it (capped at `MAX_EXIT_COOLDOWN`). Set to
    ///         `DEFAULT_EXIT_COOLDOWN` at `initialize` (fresh deploys) and by the
    ///         upgrade reinitializer (existing proxies). Appended after
    ///         `kycApprovalRegistry`, consuming one `__gap` slot.
    uint256 public exitCooldown;

    /// @dev Reserved storage for future upgrades. Decrement when new state added.
    uint256[48] private __gap;

    // ─── Events ──────────────────────────────────────────────────
    event RelayerRegistered(address indexed relayer, string url, string name, uint256 fee, uint256 bond);
    event RelayerUpdated(address indexed relayer, string url, string name, uint256 fee);
    event ExitRequested(address indexed relayer, uint256 exitAfter);
    event RelayerExited(address indexed relayer, uint256 bondReturned);
    event BondAdded(address indexed relayer, uint256 amount);
    event TreasuryUpdated(address oldTreasury, address newTreasury);
    event MinBondUpdated(uint256 oldMinBond, uint256 newMinBond);
    event BondTokenUpdated(address indexed oldToken, address indexed newToken);
    event ExitCooldownUpdated(uint256 oldCooldown, uint256 newCooldown);
    event IdentityRegistryUpdated(address oldRegistry, address newRegistry);
    event KycApprovalRegistryUpdated(address oldRegistry, address newRegistry);
    /// @param exitAfter Timestamp after which the relayer can `executeExit` to
    ///        recover their bond (the cooldown deadline).
    event RelayerForceRemoved(address indexed relayer, string reason, uint256 exitAfter);

    // ─── Errors ──────────────────────────────────────────────────
    error AlreadyRegistered();
    error NotRegistered();
    error InsufficientBond();
    error ExitNotRequested();
    error CooldownNotPassed();
    error AlreadyExiting();
    error ZeroAddress();
    error RelayerNotActive();
    error BondTransferFailed();
    error FeeTooHigh();
    error NotVerified();
    error NotKycApproved();
    error RenounceOwnershipDisabled();
    /// @dev ERC20 mode received native value, or native mode received non-zero `bondAmount`.
    error WrongPaymentMode();
    /// @dev `setBondToken` was given a non-native address with no contract code.
    error NotAContract();
    /// @dev `setExitCooldown` was given a value above `MAX_EXIT_COOLDOWN`.
    error CooldownTooLong();

    /// @dev Disable renounceOwnership to prevent accidental lockout of admin functions.
    function renounceOwnership() public pure override(OwnableUpgradeable) {
        revert RenounceOwnershipDisabled();
    }

    /// @dev Override to reject zero-address transfers, preserving the original contract's behavior.
    function transferOwnership(address newOwner) public override(Ownable2StepUpgradeable) {
        if (newOwner == address(0)) revert ZeroAddress();
        super.transferOwnership(newOwner);
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @param _bondToken ERC20 token address for bonds, or `address(0)` for native (msg.value) mode.
    function initialize(address initialOwner, address _treasury, address _identityRegistry, address _bondToken)
        external
        initializer
    {
        if (initialOwner == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        if (_identityRegistry == address(0)) revert ZeroAddress();
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __ReentrancyGuard_init();
        treasury = _treasury;
        identityRegistry = IIdentityRegistry(_identityRegistry);
        bondToken = IERC20(_bondToken); // address(0) → native mode
        exitCooldown = DEFAULT_EXIT_COOLDOWN;
    }

    /// @notice One-shot upgrade hook for the bond-token + exit-cooldown upgrade,
    ///         called via `ProxyAdmin.upgradeAndCall` when an EXISTING proxy moves
    ///         to this implementation.
    /// @dev Two storage fields are new on this version and read `0` on a
    ///      pre-upgrade proxy; both must be initialized atomically with the
    ///      upgrade so there is no window of wrong behaviour:
    ///        - `exitCooldown == 0` would let relayers skip the exit cooldown
    ///          entirely → set it to `DEFAULT_EXIT_COOLDOWN`.
    ///        - per-relayer `bondToken == 0` reads as native ETH, but every
    ///          pre-upgrade bond was in the single deploy-time global token →
    ///          backfill each existing relayer's recorded token to the current
    ///          global `bondToken` so `executeExit`/`addBond` use the right asset.
    ///      `reinitializer(2)` makes this callable exactly once. The backfill
    ///      loop is bounded by `relayerList.length` (0 on Sepolia today); a
    ///      registry large enough to risk the block gas limit would need a
    ///      batched migration instead.
    function reinitializeV2() external reinitializer(2) {
        if (exitCooldown == 0) {
            exitCooldown = DEFAULT_EXIT_COOLDOWN;
        }
        address g = address(bondToken);
        uint256 n = relayerList.length;
        for (uint256 i; i < n; ++i) {
            Relayer storage r = relayers[relayerList[i]];
            if (r.bond != 0 && r.bondToken == address(0)) {
                r.bondToken = g;
            }
        }
    }

    // ─── Registration ────────────────────────────────────────────

    /// @param bondAmount In ERC20 mode, the amount to pull via `transferFrom` (caller must `approve` first).
    ///                   In native mode, MUST be 0 — bond is taken from `msg.value`.
    function register(string calldata url, string calldata name, uint256 fee, uint256 bondAmount)
        external
        payable
        nonReentrant
    {
        if (relayers[msg.sender].active) revert AlreadyRegistered();
        if (fee > MAX_FEE) revert FeeTooHigh();
        if (!identityRegistry.isVerified(msg.sender)) revert NotVerified();
        // AND gate (feature-flagged): when wired, also require a current admin KYC approval.
        // `address(0)` skips the check — see `setKycApprovalRegistry`. Cache the SLOAD.
        IKycApproval _kyc = kycApprovalRegistry;
        if (address(_kyc) != address(0) && !_kyc.isApproved(msg.sender)) {
            revert NotKycApproved();
        }

        // Snapshot the global token now — the relayer's bond (and its later
        // top-up / withdrawal) is denominated in whatever token is current at
        // register time, immune to a later `setBondToken`.
        IERC20 _bondToken = bondToken;
        uint256 bond = _pullBond(_bondToken, bondAmount);
        if (bond < minBond) revert InsufficientBond();

        relayers[msg.sender] = Relayer({
            url: url,
            name: name,
            fee: fee,
            bond: bond,
            registeredAt: block.timestamp,
            exitRequestedAt: 0,
            active: true,
            bondToken: address(_bondToken)
        });

        // Only add to list if first-time registration (prevent duplicates on re-register)
        if (!inList[msg.sender]) {
            relayerList.push(msg.sender);
            inList[msg.sender] = true;
        }

        emit RelayerRegistered(msg.sender, url, name, fee, bond);
    }

    /// @param bondAmount In ERC20 mode, the amount to pull. In native mode, MUST be 0.
    /// @dev `nonReentrant` is required because `_pullBond` performs an external
    ///      `safeTransferFrom` in ERC20 mode; without the guard a malicious bond
    ///      token could re-enter `executeExit` (or another state mutator) mid-pull.
    function addBond(uint256 bondAmount) external payable nonReentrant {
        Relayer storage r = relayers[msg.sender];
        if (!r.active) revert NotRegistered();

        // Top up in the relayer's RECORDED token, never the live global — so a
        // top-up after a `setBondToken` switch can't mix two tokens into one bond.
        uint256 bond = _pullBond(IERC20(r.bondToken), bondAmount);
        if (bond == 0) revert InsufficientBond();
        r.bond += bond;

        emit BondAdded(msg.sender, bond);
    }

    function updateInfo(string calldata url, string calldata name, uint256 fee) external {
        Relayer storage r = relayers[msg.sender];
        if (!r.active) revert NotRegistered();
        if (r.exitRequestedAt > 0) revert AlreadyExiting();
        if (fee > MAX_FEE) revert FeeTooHigh();

        r.url = url;
        r.name = name;
        r.fee = fee;

        emit RelayerUpdated(msg.sender, url, name, fee);
    }

    // ─── Exit ────────────────────────────────────────────────────

    function requestExit() external {
        Relayer storage r = relayers[msg.sender];
        if (!r.active) revert NotRegistered();
        if (r.exitRequestedAt > 0) revert AlreadyExiting();

        r.exitRequestedAt = block.timestamp;

        emit ExitRequested(msg.sender, block.timestamp + exitCooldown);
    }

    function executeExit() external nonReentrant {
        Relayer storage r = relayers[msg.sender];
        if (!r.active) revert NotRegistered();
        if (r.exitRequestedAt == 0) revert ExitNotRequested();
        if (block.timestamp < r.exitRequestedAt + exitCooldown) revert CooldownNotPassed();

        uint256 bondToReturn = r.bond;
        address tok = r.bondToken; // capture the recorded token before mutation
        r.active = false;
        r.bond = 0;

        _pushBond(IERC20(tok), msg.sender, bondToReturn);

        emit RelayerExited(msg.sender, bondToReturn);
    }

    // ─── Bond plumbing ───────────────────────────────────────────

    /// @dev Pull bond from caller. In native mode, returns `msg.value` (and `bondAmount`
    ///      MUST be 0 — supplying both is an API misuse). In ERC20 mode, transfers
    ///      `bondAmount` from caller via `safeTransferFrom` and returns the same value
    ///      (`msg.value` MUST be 0).
    ///
    ///      INVARIANT — no fee-on-transfer / rebasing bond tokens. The ERC20 path
    ///      records the *requested* `bondAmount` as the relayer's bond rather than
    ///      measuring the balance delta, so the recorded bond must equal what the
    ///      contract actually received. A fee-on-transfer or rebasing `bondToken`
    ///      would break this (recorded > received), letting a relayer withdraw more
    ///      on exit than was deposited. The bond token is therefore expected to be a
    ///      standard ERC20 (e.g. TON). (Unlike `CommitmentPool.deposit`, which
    ///      defends against fee-on-transfer via a balance-delta check, the bond path
    ///      relies on this invariant.)
    /// @param token The token to pull in — `address(0)` for native. Callers pass the
    ///        global token on register, or the relayer's recorded token on top-up.
    function _pullBond(IERC20 token, uint256 bondAmount) internal returns (uint256) {
        if (address(token) == address(0)) {
            // Native mode
            if (bondAmount != 0) revert WrongPaymentMode();
            return msg.value;
        }
        // ERC20 mode
        if (msg.value != 0) revert WrongPaymentMode();
        if (bondAmount != 0) {
            token.safeTransferFrom(msg.sender, address(this), bondAmount);
        }
        return bondAmount;
    }

    /// @dev Push bond back to recipient in their recorded token. Skips no-op
    ///      transfers so a 0-bond exit is gas-efficient.
    /// @param token The relayer's recorded bond token — `address(0)` for native.
    function _pushBond(IERC20 token, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (address(token) == address(0)) {
            // `to` is always the original bond owner (`msg.sender` in executeExit), not arbitrary.
            // slither-disable-next-line arbitrary-send-eth
            (bool sent,) = to.call{value: amount}("");
            if (!sent) revert BondTransferFailed();
        } else {
            token.safeTransfer(to, amount);
        }
    }

    // ─── Views ───────────────────────────────────────────────────

    function getFee(address relayer) external view returns (uint256) {
        return relayers[relayer].fee;
    }

    function isActiveRelayer(address relayer) external view returns (bool) {
        Relayer storage r = relayers[relayer];
        return r.active && r.exitRequestedAt == 0;
    }

    /// @notice Single-call getter for settlement validation — avoids 3 separate external calls.
    function getSettlementInfo(address relayer) external view returns (bool isActive, uint256 fee, address treasury_) {
        Relayer storage r = relayers[relayer];
        return (r.active && r.exitRequestedAt == 0, r.fee, treasury);
    }

    function getRelayerCount() external view returns (uint256) {
        return relayerList.length;
    }

    function getActiveRelayers() external view returns (address[] memory) {
        uint256 len = relayerList.length;
        uint256 count;
        for (uint256 i; i < len;) {
            Relayer storage r = relayers[relayerList[i]];
            if (r.active && r.exitRequestedAt == 0) {
                unchecked {
                    ++count;
                }
            }
            unchecked {
                ++i;
            }
        }

        address[] memory active = new address[](count);
        uint256 idx;
        for (uint256 i; i < len;) {
            address rAddr = relayerList[i];
            Relayer storage r = relayers[rAddr];
            if (r.active && r.exitRequestedAt == 0) {
                active[idx] = rAddr;
                unchecked {
                    ++idx;
                }
            }
            unchecked {
                ++i;
            }
        }
        return active;
    }

    // ─── Admin ───────────────────────────────────────────────────

    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, _treasury);
        treasury = _treasury;
    }

    /// @notice Set minimum bond required for relayer registration.
    /// @dev Set to 0 to make bond optional (align with patent: "optionally stake").
    function setMinBond(uint256 _minBond) external onlyOwner {
        _setMinBond(_minBond);
    }

    /// @notice Set the bond TOKEN and minimum AMOUNT together, in one transaction.
    /// @param _bondToken An ERC20 token address, or `address(0)` for native mode.
    /// @param _minBond Minimum bond in the new token's units.
    /// @dev Owner-only. Use this when changing the token so the amount is always
    ///      re-denominated atomically with it — avoiding a window where `minBond`
    ///      is stuck in the previous token's decimals. Same effect as calling
    ///      `setBondToken` then `setMinBond`, but in a single tx.
    function setBond(address _bondToken, uint256 _minBond) external onlyOwner {
        _setBondToken(_bondToken);
        _setMinBond(_minBond);
    }

    function _setMinBond(uint256 _minBond) internal {
        emit MinBondUpdated(minBond, _minBond);
        minBond = _minBond;
    }

    /// @notice Set the cooldown (seconds) a relayer waits between `requestExit`
    ///         and `executeExit`.
    /// @dev Owner-only, capped at `MAX_EXIT_COOLDOWN` so a bond can't be trapped
    ///      forever. Computed live at `executeExit`, so a change also moves the
    ///      deadline for relayers already mid-exit (a shorter cooldown lets them
    ///      out sooner; a longer one — bounded by the cap — holds them a bit
    ///      more). `0` is allowed (immediate exit).
    function setExitCooldown(uint256 _exitCooldown) external onlyOwner {
        if (_exitCooldown > MAX_EXIT_COOLDOWN) revert CooldownTooLong();
        emit ExitCooldownUpdated(exitCooldown, _exitCooldown);
        exitCooldown = _exitCooldown;
    }

    /// @notice Set the global bond token NEW registrations stake in.
    /// @param _bondToken An ERC20 token address, or `address(0)` for native
    ///        (msg.value) mode.
    /// @dev Owner-only. Safe to change at any time: every relayer's bond is
    ///      denominated in the token recorded at THEIR register time
    ///      (`Relayer.bondToken`), so a switch only affects future registrations
    ///      and never strands an existing bond. `address(0)` is allowed (the
    ///      native feature-flag value); a non-native address must carry code
    ///      (guards against a fat-fingered EOA that would brick `transferFrom`).
    ///      The minimum-bond amount (`minBond`) is denominated in the new token's
    ///      units; use `setBond` to change the token and amount atomically, or
    ///      follow with `setMinBond` to match the chosen token's decimals.
    function setBondToken(address _bondToken) external onlyOwner {
        _setBondToken(_bondToken);
    }

    function _setBondToken(address _bondToken) internal {
        if (_bondToken != address(0) && _bondToken.code.length == 0) revert NotAContract();
        emit BondTokenUpdated(address(bondToken), _bondToken);
        bondToken = IERC20(_bondToken);
    }

    /// @notice Admin-forced removal of a relayer (e.g. revoked KYC approval,
    ///         compromised key, or misbehaviour).
    /// @dev Forces the relayer into the same exit pipeline as a self
    ///      `requestExit`: it is hidden from the active set immediately and the
    ///      cooldown starts, but the bond is deliberately NOT touched here.
    ///        - Keeping `active == true` lets the relayer recover the full bond
    ///          via the normal `executeExit` after cooldown — flipping it to
    ///          false would strand the bond (`executeExit` requires `active`).
    ///          This does not slash; slashing, if added, is separate.
    ///        - Not pushing the bond here means a malicious relayer can't block
    ///          their own removal with a reverting receiver; the
    ///          relayer-initiated `executeExit` owns the transfer.
    ///      The removal can't be undone or dodged: while exiting, every
    ///      active-set view excludes the relayer and
    ///      `updateInfo`/`register`/`requestExit` revert. Idempotent on the
    ///      timestamp — a re-invocation preserves the original cooldown.
    function adminRemoveRelayer(address relayer, string calldata reason) external onlyOwner {
        Relayer storage r = relayers[relayer];
        if (!r.active) revert NotRegistered();
        if (r.exitRequestedAt == 0) {
            r.exitRequestedAt = block.timestamp;
        }
        emit RelayerForceRemoved(relayer, reason, r.exitRequestedAt + exitCooldown);
    }

    /// @notice Swap the IdentityRegistry the registry checks for relayer verification.
    /// @dev Existing relayers stay registered — `register()` is the only entry point that
    ///      consults `identityRegistry`, so the swap takes effect for new registrations only.
    ///      Already-active relayers keep their seats regardless of whether they would still
    ///      verify under the new CA; downgrades are a governance decision outside this hook.
    function setIdentityRegistry(address _identityRegistry) external onlyOwner {
        if (_identityRegistry == address(0)) revert ZeroAddress();
        emit IdentityRegistryUpdated(address(identityRegistry), _identityRegistry);
        identityRegistry = IIdentityRegistry(_identityRegistry);
    }

    /// @notice Set (or clear) the admin KYC-approval registry that gates registration.
    /// @param _kycApprovalRegistry The `IssuanceApprovalRegistry` address, or `address(0)`
    ///        to disable the KYC AND gate (registration falls back to zk-X509 only).
    /// @dev Owner-only. Unlike `setIdentityRegistry`, `address(0)` is intentionally allowed —
    ///      it is the feature-flag "off" value. Takes effect for new `register()` calls only;
    ///      already-seated relayers are never re-checked, so enabling the gate never evicts
    ///      existing relayers (mirrors the `setIdentityRegistry` migration semantics).
    function setKycApprovalRegistry(address _kycApprovalRegistry) external onlyOwner {
        emit KycApprovalRegistryUpdated(address(kycApprovalRegistry), _kycApprovalRegistry);
        kycApprovalRegistry = IKycApproval(_kycApprovalRegistry);
    }
}
