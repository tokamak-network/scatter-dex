// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {FeeVault} from "../../src/FeeVault.sol";

/// @dev Minimal mintable ERC20 used as the fee token in invariant runs.
contract InvariantToken is ERC20 {
    constructor() ERC20("Invariant Token", "INV") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @notice Actor-based handler for FeeVault invariant tests.
/// @dev    Routes fuzzed actions through a small set of relayers/depositors so the
///         invariant runner can stress fee accounting under arbitrary call orderings.
contract FeeVaultHandler is CommonBase, StdCheats, StdUtils {
    FeeVault public immutable vault;
    InvariantToken public immutable token;
    address public immutable owner;
    address public immutable treasury;

    address[] public relayers;
    address[] public depositors;

    /// @dev Mirror of FeeVault.balances used to cross-check the sum invariant
    ///      without iterating private mapping storage from the test.
    mapping(address => uint256) public ghostBalance;
    uint256 public ghostTotalBalances;
    uint256 public ghostPlatformRevenue;
    uint256 public ghostTreasuryReceived;

    constructor(FeeVault _vault, InvariantToken _token, address _owner, address _treasury) {
        vault = _vault;
        token = _token;
        owner = _owner;
        treasury = _treasury;

        for (uint160 i = 1; i <= 5; ++i) {
            relayers.push(address(uint160(0xA000 + i)));
        }
        for (uint160 i = 1; i <= 3; ++i) {
            address d = address(uint160(0xD000 + i));
            depositors.push(d);
            vm.prank(_owner);
            _vault.setAuthorizedDepositor(d, true);
        }
    }

    // ─── Action: deposit fee for a relayer ──────────────────────
    function deposit(uint256 relayerSeed, uint256 depositorSeed, uint256 amount) external {
        amount = bound(amount, 0, 1e24);
        address relayer = relayers[relayerSeed % relayers.length];
        address depositor = depositors[depositorSeed % depositors.length];

        // Pre-fund the vault so _assertBalanceBacked passes.
        token.mint(address(vault), amount);

        vm.prank(depositor);
        vault.deposit(relayer, address(token), amount);

        ghostBalance[relayer] += amount;
        ghostTotalBalances += amount;
    }

    // ─── Action: accrue platform revenue (DEX fee path) ─────────
    function accrueDexFee(uint256 depositorSeed, uint256 amount) external {
        amount = bound(amount, 0, 1e24);
        address depositor = depositors[depositorSeed % depositors.length];
        token.mint(address(vault), amount);

        vm.prank(depositor);
        vault.accrueDexFee(address(token), amount);

        ghostPlatformRevenue += amount;
    }

    // ─── Action: claim relayer fee ──────────────────────────────
    function claim(uint256 relayerSeed) external {
        address relayer = relayers[relayerSeed % relayers.length];
        uint256 balance = ghostBalance[relayer];
        if (balance == 0) return;

        uint256 platformFee = (balance * vault.platformFeeBps()) / 10000;

        vm.prank(relayer);
        vault.claim(address(token));

        ghostBalance[relayer] = 0;
        ghostTotalBalances -= balance;
        ghostTreasuryReceived += platformFee;
    }

    // ─── Action: treasury withdraws platform revenue ────────────
    function withdrawPlatformRevenue() external {
        if (ghostPlatformRevenue == 0) return;
        uint256 amt = ghostPlatformRevenue;
        vm.prank(treasury);
        vault.withdrawPlatformRevenue(address(token));
        ghostPlatformRevenue -= amt;
        ghostTreasuryReceived += amt;
    }

    // ─── Action: schedule + apply fee change ────────────────────
    function scheduleFeeChange(uint256 bps) external {
        bps = bound(bps, 0, vault.MAX_PLATFORM_FEE());
        vm.prank(owner);
        vault.scheduleFeeChange(bps);
    }

    function applyFeeChange() external {
        uint256 eff = vault.pendingFeeEffectiveTime();
        if (eff == 0) return;
        if (block.timestamp < eff) vm.warp(eff);
        vm.prank(owner);
        vault.applyFeeChange();
    }

    function relayerAt(uint256 i) external view returns (address) { return relayers[i % relayers.length]; }
    function relayerCount() external view returns (uint256) { return relayers.length; }
}
