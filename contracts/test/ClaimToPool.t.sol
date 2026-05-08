// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {CommitmentPool} from "../src/zk/CommitmentPool.sol";
import {PrivateSettlement} from "../src/zk/PrivateSettlement.sol";
import {SettleVerifyLib} from "../src/zk/SettleVerifyLib.sol";
import {MockVerifier} from "./mocks/MockVerifier.sol";
import {MockDepositVerifier} from "./mocks/MockDepositVerifier.sol";
import {MockClaimVerifier} from "./mocks/MockClaimVerifier.sol";
import {MockAuthorizeVerifier} from "./mocks/MockAuthorizeVerifier.sol";
import {MockWETH} from "./mocks/MockWETH.sol";

contract CTPToken is ERC20 {
    constructor() ERC20("USDC", "USDC") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @title ClaimToPoolTest
/// @notice Exercises `PrivateSettlement.claimToPool` (Rev 2 design).
///         Setup runs `settleAuth` once to register a maker-side claims
///         group at root `CLAIMS_R` with `recipient = stealthRecipient`
///         (a freshly-generated EOA whose privkey we hold for signing
///         EIP-712 auth messages).
contract ClaimToPoolTest is Test {
    CommitmentPool public pool;
    PrivateSettlement public settlement;
    MockVerifier public withdrawVerifier;
    MockDepositVerifier public depositVerifier;
    MockClaimVerifier public claimVerifier;
    MockAuthorizeVerifier public authVerifier;
    MockWETH public weth;
    CTPToken public usdc;

    address makerRelayer = address(0xBEEF1);
    address takerRelayer = address(0xBEEF2);

    // Stealth recipient — must be derivable from a known privkey so we
    // can sign EIP-712 ClaimToPoolAuth messages in tests.
    uint256 stealthPriv = uint256(keccak256("stealth.privkey.test"));
    address stealthRecipient;

    uint[2] proofA = [uint(0), uint(0)];
    uint[2][2] proofB = [[uint(0), uint(0)], [uint(0), uint(0)]];
    uint[2] proofC = [uint(0), uint(0)];

    bytes32 constant M_NULL       = bytes32(uint256(0xa1));
    bytes32 constant M_NONCE_NULL = bytes32(uint256(0xa2));
    bytes32 constant M_NEW_COMMIT = bytes32(uint256(0xa3));
    bytes32 constant CLAIMS_R     = bytes32(uint256(0xa4));
    bytes32 constant M_ORDER_HASH = bytes32(uint256(0xa5));
    bytes32 constant T_NULL       = bytes32(uint256(0xb1));
    bytes32 constant T_NONCE_NULL = bytes32(uint256(0xb2));
    bytes32 constant T_NEW_COMMIT = bytes32(uint256(0xb3));
    bytes32 constant T_CLAIMS_R   = bytes32(uint256(0xb4));
    bytes32 constant T_ORDER_HASH = bytes32(uint256(0xb5));

    bytes32 constant CLAIM_NULLIFIER = bytes32(uint256(0xCA11));
    uint256 constant CLAIM_AMOUNT = 20_000e18;

    bytes32 constant CLAIM_TO_POOL_AUTH_TYPEHASH =
        keccak256("ClaimToPoolAuth(bytes32 claimNullifier,uint256 amount,address token,bytes32 slicesHash)");

    function setUp() public {
        stealthRecipient = vm.addr(stealthPriv);

        withdrawVerifier = new MockVerifier();
        depositVerifier = new MockDepositVerifier();
        claimVerifier = new MockClaimVerifier();
        authVerifier = new MockAuthorizeVerifier();

        pool = new CommitmentPool(address(withdrawVerifier), address(depositVerifier), 20, 30);
        weth = new MockWETH();
        settlement = new PrivateSettlement(
            address(pool),
            address(claimVerifier),
            address(weth)
        );
        usdc = new CTPToken();

        pool.setTokenWhitelist(address(weth), true);
        pool.setTokenWhitelist(address(usdc), true);
        settlement.setTokenWhitelist(address(weth), true);
        settlement.setTokenWhitelist(address(usdc), true);
        pool.setAuthorizedSettlement(address(settlement));
        settlement.setAuthorizeVerifier(16, address(authVerifier));

        // Pin the claim verifier mock to the stealth recipient so a
        // proof targeting any other address fails — mirrors the real
        // Groth16 verifier's cryptographic binding of public signal
        // #4 (recipient) to the leaf preimage.
        claimVerifier.setEnforceRecipient(true, stealthRecipient);

        // Fund pool, run settleAuth to register the claims group with
        // recipient = stealthRecipient.
        vm.deal(address(this), 1100 ether);
        weth.deposit{value: 1100 ether}();
        weth.transfer(address(pool), 1000 ether);
        usdc.mint(address(pool), 1_000_000e18);

        PrivateSettlement.SettleAuthParams memory p = _defaultParams();
        vm.prank(makerRelayer);
        settlement.settleAuth(p);

        assertGe(usdc.balanceOf(address(settlement)), CLAIM_AMOUNT);
    }

    // ────────────────────────────────────────────────────────────
    //  Helpers
    // ────────────────────────────────────────────────────────────

    function _defaultParams() internal view returns (PrivateSettlement.SettleAuthParams memory) {
        SettleVerifyLib.AuthorizeProof memory maker = SettleVerifyLib.AuthorizeProof({
            proofA: proofA, proofB: proofB, proofC: proofC,
            pubKeyBind: bytes32(uint256(0xC1)),
            commitmentRoot: pool.getLastRoot(),
            nullifier: M_NULL,
            nonceNullifier: M_NONCE_NULL,
            newCommitment: M_NEW_COMMIT,
            sellToken: address(weth), buyToken: address(usdc),
            sellAmount: 10 ether, buyAmount: 20_000e18,
            maxFee: 100,
            expiry: uint64(block.timestamp + 1 hours),
            claimsRoot: CLAIMS_R,
            totalLocked: uint128(20_000e18),
            relayer: makerRelayer,
            orderHash: M_ORDER_HASH,
            tier: 16
        });
        SettleVerifyLib.AuthorizeProof memory taker = SettleVerifyLib.AuthorizeProof({
            proofA: proofA, proofB: proofB, proofC: proofC,
            pubKeyBind: bytes32(uint256(0xC2)),
            commitmentRoot: pool.getLastRoot(),
            nullifier: T_NULL,
            nonceNullifier: T_NONCE_NULL,
            newCommitment: T_NEW_COMMIT,
            sellToken: address(usdc), buyToken: address(weth),
            sellAmount: 20_000e18, buyAmount: 10 ether,
            maxFee: 100,
            expiry: uint64(block.timestamp + 1 hours),
            claimsRoot: T_CLAIMS_R,
            totalLocked: uint128(10 ether),
            relayer: takerRelayer,
            orderHash: T_ORDER_HASH,
            tier: 16
        });
        return PrivateSettlement.SettleAuthParams({
            maker: maker, taker: taker, feeTokenMaker: 0, feeTokenTaker: 0
        });
    }

    function _slice(uint256 commitment, uint256 amount)
        internal view returns (PrivateSettlement.ClaimToPoolSlice memory)
    {
        return PrivateSettlement.ClaimToPoolSlice({
            proofA: proofA, proofB: proofB, proofC: proofC,
            commitment: commitment, amount: amount
        });
    }

    function _equalSlices(uint256 n) internal view returns (PrivateSettlement.ClaimToPoolSlice[] memory s) {
        s = new PrivateSettlement.ClaimToPoolSlice[](n);
        uint256 base = CLAIM_AMOUNT / n;
        uint256 rem = CLAIM_AMOUNT - base * n;
        for (uint256 i = 0; i < n; i++) {
            s[i] = _slice(100 + i, i == 0 ? base + rem : base);
        }
    }

    function _params(address token) internal view returns (PrivateSettlement.ClaimToPoolParams memory) {
        return PrivateSettlement.ClaimToPoolParams({
            claimProofA: proofA, claimProofB: proofB, claimProofC: proofC,
            claimsRoot: CLAIMS_R,
            claimNullifier: CLAIM_NULLIFIER,
            amount: CLAIM_AMOUNT,
            token: token,
            stealthRecipient: stealthRecipient,
            releaseTime: uint64(block.timestamp)
        });
    }

    function _params() internal view returns (PrivateSettlement.ClaimToPoolParams memory) {
        return _params(address(usdc));
    }

    /// @dev Mirror the contract's EIP-712 digest computation +
    ///      sign with `signerPriv`. The frontend does the same in JS.
    function _signAuth(
        uint256 signerPriv,
        bytes32 claimNullifier,
        uint256 amount,
        address token,
        PrivateSettlement.ClaimToPoolSlice[] memory slices
    ) internal view returns (bytes memory) {
        bytes32 slicesHash = keccak256(abi.encode(slices));
        bytes32 structHash = keccak256(abi.encode(
            CLAIM_TO_POOL_AUTH_TYPEHASH,
            claimNullifier,
            amount,
            token,
            slicesHash
        ));
        bytes32 domainSeparator = _domainSeparator(address(settlement), block.chainid);
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPriv, digest);
        return abi.encodePacked(r, s, v);
    }

    function _domainSeparator(address verifyingContract, uint256 chainId)
        internal pure returns (bytes32)
    {
        return keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes("PrivateSettlement")),
            keccak256(bytes("1")),
            chainId,
            verifyingContract
        ));
    }

    // ────────────────────────────────────────────────────────────
    //  Happy paths
    // ────────────────────────────────────────────────────────────

    function test_claimToPool_singleSlice() public {
        PrivateSettlement.ClaimToPoolSlice[] memory slices = new PrivateSettlement.ClaimToPoolSlice[](1);
        slices[0] = _slice(42, CLAIM_AMOUNT);
        bytes memory sig = _signAuth(stealthPriv, CLAIM_NULLIFIER, CLAIM_AMOUNT, address(usdc), slices);

        uint256 settlementBefore = usdc.balanceOf(address(settlement));
        uint256 poolBefore = usdc.balanceOf(address(pool));

        vm.expectEmit(true, true, true, true, address(settlement));
        emit PrivateSettlement.PrivateClaimToPool(
            CLAIMS_R, CLAIM_NULLIFIER, stealthRecipient, address(usdc), CLAIM_AMOUNT, 1
        );
        settlement.claimToPool(_params(), slices, sig);

        assertEq(usdc.balanceOf(address(settlement)), settlementBefore - CLAIM_AMOUNT);
        assertEq(usdc.balanceOf(address(pool)), poolBefore + CLAIM_AMOUNT);
        assertTrue(settlement.claimNullifiers(CLAIM_NULLIFIER));
        (, uint128 totalClaimed,,) = settlement.claimsGroups(CLAIMS_R);
        assertEq(totalClaimed, CLAIM_AMOUNT);
    }

    function test_claimToPool_fourSlices_split() public {
        PrivateSettlement.ClaimToPoolSlice[] memory slices = _equalSlices(4);
        bytes memory sig = _signAuth(stealthPriv, CLAIM_NULLIFIER, CLAIM_AMOUNT, address(usdc), slices);
        uint256 settlementBefore = usdc.balanceOf(address(settlement));
        uint256 poolBefore = usdc.balanceOf(address(pool));

        settlement.claimToPool(_params(), slices, sig);

        uint256 sum;
        for (uint256 i = 0; i < slices.length; i++) sum += slices[i].amount;
        assertEq(sum, CLAIM_AMOUNT);
        assertEq(usdc.balanceOf(address(settlement)), settlementBefore - CLAIM_AMOUNT);
        assertEq(usdc.balanceOf(address(pool)), poolBefore + CLAIM_AMOUNT);
        assertTrue(settlement.claimNullifiers(CLAIM_NULLIFIER));
    }

    // ────────────────────────────────────────────────────────────
    //  Slice payload validation (revert before nullifier mutation)
    // ────────────────────────────────────────────────────────────

    function test_claimToPool_emptySlices_reverts() public {
        PrivateSettlement.ClaimToPoolSlice[] memory empty = new PrivateSettlement.ClaimToPoolSlice[](0);
        bytes memory sig = _signAuth(stealthPriv, CLAIM_NULLIFIER, CLAIM_AMOUNT, address(usdc), empty);

        vm.expectRevert(PrivateSettlement.EmptyBatch.selector);
        settlement.claimToPool(_params(), empty, sig);
        assertFalse(settlement.claimNullifiers(CLAIM_NULLIFIER));
    }

    function test_claimToPool_tooManySlices_reverts() public {
        PrivateSettlement.ClaimToPoolSlice[] memory s = new PrivateSettlement.ClaimToPoolSlice[](9);
        for (uint256 i = 0; i < 9; i++) s[i] = _slice(100 + i, CLAIM_AMOUNT / 9);
        bytes memory sig = _signAuth(stealthPriv, CLAIM_NULLIFIER, CLAIM_AMOUNT, address(usdc), s);

        vm.expectRevert(PrivateSettlement.TooManySlices.selector);
        settlement.claimToPool(_params(), s, sig);
        assertFalse(settlement.claimNullifiers(CLAIM_NULLIFIER));
    }

    function test_claimToPool_sumMismatch_reverts() public {
        PrivateSettlement.ClaimToPoolSlice[] memory s = new PrivateSettlement.ClaimToPoolSlice[](2);
        s[0] = _slice(1, CLAIM_AMOUNT / 2);
        s[1] = _slice(2, CLAIM_AMOUNT / 2 - 1);
        bytes memory sig = _signAuth(stealthPriv, CLAIM_NULLIFIER, CLAIM_AMOUNT, address(usdc), s);

        vm.expectRevert(PrivateSettlement.SumMismatch.selector);
        settlement.claimToPool(_params(), s, sig);
        assertFalse(settlement.claimNullifiers(CLAIM_NULLIFIER));
    }

    function test_claimToPool_zeroCommitment_reverts() public {
        PrivateSettlement.ClaimToPoolSlice[] memory s = new PrivateSettlement.ClaimToPoolSlice[](1);
        s[0] = _slice(0, CLAIM_AMOUNT);
        bytes memory sig = _signAuth(stealthPriv, CLAIM_NULLIFIER, CLAIM_AMOUNT, address(usdc), s);

        vm.expectRevert(PrivateSettlement.InvalidSlice.selector);
        settlement.claimToPool(_params(), s, sig);
        assertFalse(settlement.claimNullifiers(CLAIM_NULLIFIER));
    }

    function test_claimToPool_zeroAmount_reverts() public {
        PrivateSettlement.ClaimToPoolSlice[] memory s = new PrivateSettlement.ClaimToPoolSlice[](2);
        s[0] = _slice(1, CLAIM_AMOUNT);
        s[1] = _slice(2, 0);
        bytes memory sig = _signAuth(stealthPriv, CLAIM_NULLIFIER, CLAIM_AMOUNT, address(usdc), s);

        vm.expectRevert(PrivateSettlement.InvalidSlice.selector);
        settlement.claimToPool(_params(), s, sig);
        assertFalse(settlement.claimNullifiers(CLAIM_NULLIFIER));
    }

    /// @notice s.amount > total bound — keeps the uint256 sum
    ///         accumulator overflow-safe for combined wraparound
    ///         attacks. Without this guard, two huge slices could
    ///         "sum" to a small total via wraparound.
    function test_claimToPool_sliceExceedsTotal_reverts() public {
        PrivateSettlement.ClaimToPoolSlice[] memory s = new PrivateSettlement.ClaimToPoolSlice[](2);
        s[0] = _slice(1, CLAIM_AMOUNT + 1);
        s[1] = _slice(2, type(uint256).max - CLAIM_AMOUNT);
        bytes memory sig = _signAuth(stealthPriv, CLAIM_NULLIFIER, CLAIM_AMOUNT, address(usdc), s);

        vm.expectRevert(PrivateSettlement.InvalidSlice.selector);
        settlement.claimToPool(_params(), s, sig);
        assertFalse(settlement.claimNullifiers(CLAIM_NULLIFIER));
    }

    // ────────────────────────────────────────────────────────────
    //  Claim group / state guards
    // ────────────────────────────────────────────────────────────

    function test_claimToPool_tokenMismatch_reverts() public {
        PrivateSettlement.ClaimToPoolSlice[] memory s = new PrivateSettlement.ClaimToPoolSlice[](1);
        s[0] = _slice(1, CLAIM_AMOUNT);
        bytes memory sig = _signAuth(stealthPriv, CLAIM_NULLIFIER, CLAIM_AMOUNT, address(weth), s);

        PrivateSettlement.ClaimToPoolParams memory p = _params(address(weth));
        vm.expectRevert(PrivateSettlement.TokenMismatch.selector);
        settlement.claimToPool(p, s, sig);
    }

    function test_claimToPool_paused_reverts() public {
        settlement.setPaused(true);
        PrivateSettlement.ClaimToPoolSlice[] memory s = _equalSlices(2);
        bytes memory sig = _signAuth(stealthPriv, CLAIM_NULLIFIER, CLAIM_AMOUNT, address(usdc), s);

        vm.expectRevert(PrivateSettlement.ContractPaused.selector);
        settlement.claimToPool(_params(), s, sig);
    }

    function test_claimToPool_unknownClaimsRoot_reverts() public {
        PrivateSettlement.ClaimToPoolSlice[] memory s = new PrivateSettlement.ClaimToPoolSlice[](1);
        s[0] = _slice(1, CLAIM_AMOUNT);
        bytes memory sig = _signAuth(stealthPriv, CLAIM_NULLIFIER, CLAIM_AMOUNT, address(usdc), s);

        PrivateSettlement.ClaimToPoolParams memory p = _params();
        p.claimsRoot = bytes32(uint256(0xDEADBEEF));

        vm.expectRevert(PrivateSettlement.ClaimsGroupNotFound.selector);
        settlement.claimToPool(p, s, sig);
    }

    function test_claimToPool_zeroStealthRecipient_reverts() public {
        PrivateSettlement.ClaimToPoolSlice[] memory s = _equalSlices(2);
        bytes memory sig = _signAuth(stealthPriv, CLAIM_NULLIFIER, CLAIM_AMOUNT, address(usdc), s);
        PrivateSettlement.ClaimToPoolParams memory p = _params();
        p.stealthRecipient = address(0);

        vm.expectRevert(PrivateSettlement.ZeroAddress.selector);
        settlement.claimToPool(p, s, sig);
    }

    // ────────────────────────────────────────────────────────────
    //  EIP-712 signature
    // ────────────────────────────────────────────────────────────

    /// @notice Wrong signer rejects. Without this guard a relayer
    ///         could substitute slices and sign with their own key.
    function test_claimToPool_sigFromWrongKey_reverts() public {
        uint256 attackerPriv = uint256(keccak256("attacker"));
        PrivateSettlement.ClaimToPoolSlice[] memory s = _equalSlices(2);
        bytes memory sig = _signAuth(attackerPriv, CLAIM_NULLIFIER, CLAIM_AMOUNT, address(usdc), s);

        vm.expectRevert(PrivateSettlement.InvalidStealthSignature.selector);
        settlement.claimToPool(_params(), s, sig);
    }

    /// @notice Slice substitution after signing rejects. Sign over
    ///         payload P1, submit with payload P2 → sig recovers to
    ///         a different address (since slicesHash differs).
    function test_claimToPool_slicesTamperedAfterSig_reverts() public {
        PrivateSettlement.ClaimToPoolSlice[] memory original = _equalSlices(2);
        bytes memory sig = _signAuth(stealthPriv, CLAIM_NULLIFIER, CLAIM_AMOUNT, address(usdc), original);

        // Submit different slices with the original signature
        PrivateSettlement.ClaimToPoolSlice[] memory tampered = new PrivateSettlement.ClaimToPoolSlice[](2);
        tampered[0] = _slice(999, CLAIM_AMOUNT / 2);
        tampered[1] = _slice(1000, CLAIM_AMOUNT / 2);

        vm.expectRevert(PrivateSettlement.InvalidStealthSignature.selector);
        settlement.claimToPool(_params(), tampered, sig);
    }

    /// @notice Cross-chain replay protection. A sig produced for a
    ///         different chainId must fail recovery against the
    ///         current chain's domain separator.
    function test_claimToPool_chainIdMismatch_reverts() public {
        PrivateSettlement.ClaimToPoolSlice[] memory s = _equalSlices(2);
        // Sign with a digest based on a fake chainId
        bytes32 slicesHash = keccak256(abi.encode(s));
        bytes32 structHash = keccak256(abi.encode(
            CLAIM_TO_POOL_AUTH_TYPEHASH,
            CLAIM_NULLIFIER, CLAIM_AMOUNT, address(usdc), slicesHash
        ));
        bytes32 fakeDomain = _domainSeparator(address(settlement), block.chainid + 1);
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", fakeDomain, structHash));
        (uint8 v, bytes32 r, bytes32 ss) = vm.sign(stealthPriv, digest);
        bytes memory sig = abi.encodePacked(r, ss, v);

        vm.expectRevert(PrivateSettlement.InvalidStealthSignature.selector);
        settlement.claimToPool(_params(), s, sig);
    }

    /// @notice Cross-deployment replay protection. A sig produced for
    ///         a different verifyingContract address must fail.
    function test_claimToPool_verifyingContractMismatch_reverts() public {
        PrivateSettlement.ClaimToPoolSlice[] memory s = _equalSlices(2);
        bytes32 slicesHash = keccak256(abi.encode(s));
        bytes32 structHash = keccak256(abi.encode(
            CLAIM_TO_POOL_AUTH_TYPEHASH,
            CLAIM_NULLIFIER, CLAIM_AMOUNT, address(usdc), slicesHash
        ));
        bytes32 fakeDomain = _domainSeparator(address(0xBADBAD), block.chainid);
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", fakeDomain, structHash));
        (uint8 v, bytes32 r, bytes32 ss) = vm.sign(stealthPriv, digest);
        bytes memory sig = abi.encodePacked(r, ss, v);

        vm.expectRevert(PrivateSettlement.InvalidStealthSignature.selector);
        settlement.claimToPool(_params(), s, sig);
    }

    /// @notice Malformed signature (wrong length) rejects via tryRecover.
    function test_claimToPool_malformedSig_reverts() public {
        PrivateSettlement.ClaimToPoolSlice[] memory s = _equalSlices(2);
        bytes memory sig = hex"deadbeef"; // 4 bytes, not 65

        vm.expectRevert(PrivateSettlement.InvalidStealthSignature.selector);
        settlement.claimToPool(_params(), s, sig);
    }

    // ────────────────────────────────────────────────────────────
    //  ZK proofs
    // ────────────────────────────────────────────────────────────

    /// @notice Wrong recipient bound in the claim proof rejects.
    ///         Mirrors the leaf-binding constraint of the real
    ///         circuit (recipient is hashed into the leaf preimage).
    function test_claimToPool_recipientMismatch_reverts() public {
        // Stealth privkey signs valid auth, but proof was generated
        // for a different recipient. Mock pin enforces this.
        claimVerifier.setEnforceRecipient(true, address(0xDEADBEEF));
        PrivateSettlement.ClaimToPoolSlice[] memory s = _equalSlices(2);
        bytes memory sig = _signAuth(stealthPriv, CLAIM_NULLIFIER, CLAIM_AMOUNT, address(usdc), s);

        vm.expectRevert(PrivateSettlement.InvalidProof.selector);
        settlement.claimToPool(_params(), s, sig);
    }

    function test_claimToPool_invalidClaimProof_reverts() public {
        claimVerifier.setShouldPass(false);
        PrivateSettlement.ClaimToPoolSlice[] memory s = _equalSlices(2);
        bytes memory sig = _signAuth(stealthPriv, CLAIM_NULLIFIER, CLAIM_AMOUNT, address(usdc), s);

        vm.expectRevert(PrivateSettlement.InvalidProof.selector);
        settlement.claimToPool(_params(), s, sig);
    }

    /// @notice Per-slice deposit proof failure aborts the whole tx.
    ///         The load-bearing safety against the "inflated commitment
    ///         amount" pool drain attack: without per-slice proof
    ///         verification, a caller could submit a commitment hashed
    ///         with a large amount while declaring a small slice and
    ///         later withdraw the inflated amount.
    function test_claimToPool_invalidDepositProof_reverts() public {
        depositVerifier.setShouldPass(false);
        PrivateSettlement.ClaimToPoolSlice[] memory s = _equalSlices(2);
        bytes memory sig = _signAuth(stealthPriv, CLAIM_NULLIFIER, CLAIM_AMOUNT, address(usdc), s);

        vm.expectRevert(CommitmentPool.InvalidProof.selector);
        settlement.claimToPool(_params(), s, sig);
        assertFalse(settlement.claimNullifiers(CLAIM_NULLIFIER));
    }

    // ────────────────────────────────────────────────────────────
    //  Cross-flow nullifier replay
    // ────────────────────────────────────────────────────────────

    function test_claimToPool_thenClaimWithProof_sameNullifier_reverts() public {
        PrivateSettlement.ClaimToPoolSlice[] memory s = _equalSlices(2);
        bytes memory sig = _signAuth(stealthPriv, CLAIM_NULLIFIER, CLAIM_AMOUNT, address(usdc), s);
        settlement.claimToPool(_params(), s, sig);

        vm.expectRevert(PrivateSettlement.NullifierAlreadySpent.selector);
        settlement.claimWithProof(
            proofA, proofB, proofC,
            CLAIMS_R, CLAIM_NULLIFIER, CLAIM_AMOUNT, address(usdc),
            stealthRecipient, uint64(block.timestamp)
        );
    }

    function test_claimWithProof_thenClaimToPool_sameNullifier_reverts() public {
        settlement.claimWithProof(
            proofA, proofB, proofC,
            CLAIMS_R, CLAIM_NULLIFIER, CLAIM_AMOUNT, address(usdc),
            stealthRecipient, uint64(block.timestamp)
        );

        PrivateSettlement.ClaimToPoolSlice[] memory s = _equalSlices(2);
        bytes memory sig = _signAuth(stealthPriv, CLAIM_NULLIFIER, CLAIM_AMOUNT, address(usdc), s);

        vm.expectRevert(PrivateSettlement.NullifierAlreadySpent.selector);
        settlement.claimToPool(_params(), s, sig);
    }

    function test_claimToPool_replay_sameCall_reverts() public {
        PrivateSettlement.ClaimToPoolSlice[] memory s = _equalSlices(2);
        bytes memory sig = _signAuth(stealthPriv, CLAIM_NULLIFIER, CLAIM_AMOUNT, address(usdc), s);
        settlement.claimToPool(_params(), s, sig);

        PrivateSettlement.ClaimToPoolSlice[] memory s2 = _equalSlices(2);
        bytes memory sig2 = _signAuth(stealthPriv, CLAIM_NULLIFIER, CLAIM_AMOUNT, address(usdc), s2);
        vm.expectRevert(PrivateSettlement.NullifierAlreadySpent.selector);
        settlement.claimToPool(_params(), s2, sig2);
    }
}
