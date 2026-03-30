// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Mock ERC20 token for local testing
contract MockToken is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @notice Deploy mock WETH/USDC tokens and mint to anvil test accounts.
/// @dev Called by deploy-docker.sh for integration mode. Mock mode uses DeployLocal.s.sol instead.
contract DeployTestTokens is Script {
    function run() external {
        vm.startBroadcast();

        MockToken weth = new MockToken("Wrapped ETH", "WETH");
        MockToken usdc = new MockToken("USD Coin", "USDC");

        // Mint to anvil default accounts
        address alice = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266; // anvil #0
        address bob = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;   // anvil #1

        weth.mint(alice, 1000 ether);
        usdc.mint(alice, 1_000_000e18); // Mock uses 18 decimals (real USDC uses 6)
        weth.mint(bob, 1000 ether);
        usdc.mint(bob, 1_000_000e18);

        vm.stopBroadcast();

        console.log("WETH:", address(weth));
        console.log("USDC:", address(usdc));
    }
}
