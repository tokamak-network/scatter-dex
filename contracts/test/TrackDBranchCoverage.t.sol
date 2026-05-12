// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {RelayerRegistry} from "../src/RelayerRegistry.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";
import {CommitmentPool} from "../src/zk/CommitmentPool.sol";
import {IncrementalMerkleTree} from "../src/zk/IncrementalMerkleTree.sol";
import {MockVerifier} from "./mocks/MockVerifier.sol";
import {MockDepositVerifier} from "./mocks/MockDepositVerifier.sol";
import {ProxyDeployer} from "./utils/ProxyDeployer.sol";

contract TdToken is ERC20 {
    constructor() ERC20("Td", "TD") {}
    function mint(address to, uint256 amt) external { _mint(to, amt); }
}

contract TdAlwaysVerified is IIdentityRegistry {
    function paused() external pure override returns (bool) { return false; }
    function isVerified(address) external pure override returns (bool) { return true; }
    function verifiedUntil(address) external pure override returns (uint64) { return type(uint64).max; }
}

/// @dev Transparent-style proxy shim — for triggering initialize reverts.
contract InitRevertProxy {
    constructor(address impl, bytes memory data) payable {
        (bool ok, bytes memory ret) = impl.delegatecall(data);
        if (!ok) { assembly { revert(add(ret, 32), mload(ret)) } }
    }
}

/// @title TrackDBranchCoverage
/// @notice Final branch-coverage pass for FeeVault / RelayerRegistry /
///         IncrementalMerkleTree. Targets the residual unhit
///         compound-condition false branches that previous suites
///         couldn't reach.
contract TrackDBranchCoverage is Test {
    address owner = address(this);
    address alice = address(0xA11CE);
    address treasury = address(0xCAFE);

    // ─── FeeVault.initialize compound-guard branches ────────────

    function test_feeVault_initialize_zeroOwner_reverts() public {
        FeeVault impl = new FeeVault();
        bytes memory data = abi.encodeWithSelector(FeeVault.initialize.selector, address(0), treasury, 500);
        vm.expectRevert(FeeVault.ZeroAddress.selector);
        new InitRevertProxy(address(impl), data);
    }

    function test_feeVault_initialize_zeroTreasury_reverts() public {
        FeeVault impl = new FeeVault();
        bytes memory data = abi.encodeWithSelector(FeeVault.initialize.selector, owner, address(0), 500);
        vm.expectRevert(FeeVault.ZeroAddress.selector);
        new InitRevertProxy(address(impl), data);
    }

    function test_feeVault_initialize_feeTooHigh_reverts() public {
        FeeVault impl = new FeeVault();
        // MAX_PLATFORM_FEE = 5000 (50%); 5001 trips FeeTooHigh.
        bytes memory data = abi.encodeWithSelector(FeeVault.initialize.selector, owner, treasury, 5001);
        vm.expectRevert(FeeVault.FeeTooHigh.selector);
        new InitRevertProxy(address(impl), data);
    }

    // ─── FeeVault.deposit / claim / admin compound-guard branches ─

    function test_feeVault_deposit_notAuthorized_reverts() public {
        FeeVault v = ProxyDeployer.deployFeeVault(owner, owner, treasury, 500);
        TdToken t = new TdToken();
        vm.expectRevert(FeeVault.NotAuthorized.selector);
        v.deposit(alice, address(t), 100); // owner is NOT authorized depositor by default
    }

    function test_feeVault_deposit_zeroRelayer_reverts() public {
        FeeVault v = ProxyDeployer.deployFeeVault(owner, owner, treasury, 500);
        TdToken t = new TdToken();
        v.setAuthorizedDepositor(owner, true);
        vm.expectRevert(FeeVault.ZeroAddress.selector);
        v.deposit(address(0), address(t), 100);
    }

    function test_feeVault_deposit_zeroToken_reverts() public {
        FeeVault v = ProxyDeployer.deployFeeVault(owner, owner, treasury, 500);
        v.setAuthorizedDepositor(owner, true);
        vm.expectRevert(FeeVault.ZeroAddress.selector);
        v.deposit(alice, address(0), 100);
    }

    function test_feeVault_claim_zeroToken_reverts() public {
        FeeVault v = ProxyDeployer.deployFeeVault(owner, owner, treasury, 500);
        vm.expectRevert(FeeVault.ZeroAddress.selector);
        v.claim(address(0));
    }

    function test_feeVault_claim_nothingToClaim_reverts() public {
        FeeVault v = ProxyDeployer.deployFeeVault(owner, owner, treasury, 500);
        TdToken t = new TdToken();
        vm.expectRevert(FeeVault.NothingToClaim.selector);
        v.claim(address(t));
    }

    function test_feeVault_setAuthorizedDepositor_zero_reverts() public {
        FeeVault v = ProxyDeployer.deployFeeVault(owner, owner, treasury, 500);
        vm.expectRevert(FeeVault.ZeroAddress.selector);
        v.setAuthorizedDepositor(address(0), true);
    }

    function test_feeVault_setTreasury_zero_reverts() public {
        FeeVault v = ProxyDeployer.deployFeeVault(owner, owner, treasury, 500);
        vm.expectRevert(FeeVault.ZeroAddress.selector);
        v.setTreasury(address(0));
    }

    // ─── RelayerRegistry.initialize zero-input branches ─────────

    function test_relayerRegistry_initialize_zeroOwner_reverts() public {
        RelayerRegistry impl = new RelayerRegistry();
        TdAlwaysVerified reg = new TdAlwaysVerified();
        bytes memory data =
            abi.encodeWithSelector(RelayerRegistry.initialize.selector, address(0), treasury, address(reg), address(0));
        vm.expectRevert(RelayerRegistry.ZeroAddress.selector);
        new InitRevertProxy(address(impl), data);
    }

    function test_relayerRegistry_initialize_zeroIdentityRegistry_reverts() public {
        RelayerRegistry impl = new RelayerRegistry();
        bytes memory data =
            abi.encodeWithSelector(RelayerRegistry.initialize.selector, owner, treasury, address(0), address(0));
        vm.expectRevert(RelayerRegistry.ZeroAddress.selector);
        new InitRevertProxy(address(impl), data);
    }

    // ─── RelayerRegistry state-guard branches ───────────────────

    function test_relayerRegistry_addBond_notRegistered_reverts() public {
        RelayerRegistry r = _deployReg();
        vm.expectRevert(RelayerRegistry.NotRegistered.selector);
        r.addBond(0);
    }

    function test_relayerRegistry_updateInfo_notRegistered_reverts() public {
        RelayerRegistry r = _deployReg();
        vm.expectRevert(RelayerRegistry.NotRegistered.selector);
        r.updateInfo("https://example", "name", 100);
    }

    function test_relayerRegistry_requestExit_notRegistered_reverts() public {
        RelayerRegistry r = _deployReg();
        vm.expectRevert(RelayerRegistry.NotRegistered.selector);
        r.requestExit();
    }

    function test_relayerRegistry_executeExit_notRegistered_reverts() public {
        RelayerRegistry r = _deployReg();
        vm.expectRevert(RelayerRegistry.NotRegistered.selector);
        r.executeExit();
    }

    function test_relayerRegistry_setTreasury_zero_reverts() public {
        RelayerRegistry r = _deployReg();
        vm.expectRevert(RelayerRegistry.ZeroAddress.selector);
        r.setTreasury(address(0));
    }

    function _deployReg() internal returns (RelayerRegistry) {
        TdAlwaysVerified reg = new TdAlwaysVerified();
        return ProxyDeployer.deployRelayerRegistry(owner, owner, treasury, address(reg), address(0));
    }

    // ─── IncrementalMerkleTree init-guard branches (via CommitmentPool) ──

    function test_imt_zeroLevels_reverts() public {
        // CommitmentPool.initialize forwards _treeLevels/_rootHistorySize into
        // __IncrementalMerkleTree_init — zero levels trips InvalidLevels.
        CommitmentPool impl = new CommitmentPool();
        MockVerifier withdraw_ = new MockVerifier();
        MockDepositVerifier deposit_ = new MockDepositVerifier();
        bytes memory data = abi.encodeWithSelector(
            CommitmentPool.initialize.selector,
            owner, address(withdraw_), address(deposit_), uint32(0), uint32(10)
        );
        vm.expectRevert(IncrementalMerkleTree.InvalidLevels.selector);
        new InitRevertProxy(address(impl), data);
    }

    function test_imt_zeroRootHistorySize_reverts() public {
        CommitmentPool impl = new CommitmentPool();
        MockVerifier withdraw_ = new MockVerifier();
        MockDepositVerifier deposit_ = new MockDepositVerifier();
        bytes memory data = abi.encodeWithSelector(
            CommitmentPool.initialize.selector,
            owner, address(withdraw_), address(deposit_), uint32(20), uint32(0)
        );
        vm.expectRevert(IncrementalMerkleTree.InvalidRootHistorySize.selector);
        new InitRevertProxy(address(impl), data);
    }

    function test_imt_levelsAbove20_reverts() public {
        CommitmentPool impl = new CommitmentPool();
        MockVerifier withdraw_ = new MockVerifier();
        MockDepositVerifier deposit_ = new MockDepositVerifier();
        bytes memory data = abi.encodeWithSelector(
            CommitmentPool.initialize.selector,
            owner, address(withdraw_), address(deposit_), uint32(21), uint32(10)
        );
        vm.expectRevert(IncrementalMerkleTree.InvalidLevels.selector);
        new InitRevertProxy(address(impl), data);
    }

    function test_imt_isKnownRoot_zero_returnsFalse() public {
        CommitmentPool pool = ProxyDeployer.deployCommitmentPool(
            owner, owner, address(new MockVerifier()), address(new MockDepositVerifier()), 20, 10
        );
        assertFalse(pool.isKnownRoot(0));
    }
}
